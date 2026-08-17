// test-db/entitlements.dbtest.mjs — cohort entitlement + batch isolation (#35).
//
// Every authorization assertion goes through a REAL signed-in user's PostgREST
// client. Nothing is asserted through the service role or the Management API:
// those run as `postgres` and bypass RLS, so they would pass regardless of what
// the policies say. Setup uses them; proof never does.
//
// ★ #39 (three-plan catalog): VIP is the ONLY cohort segment. Gold and Core no
// longer exist as plans, so the premium persona here is VIP and the non-cohort
// persona is Silver. Two #35-era tests that existed purely to keep Gold and VIP
// apart could not survive that — see the note above
// 'grant_batch_run refuses any segment but VIP'.
//
// Run: npm run test:db   (needs .env.test pointing at a shadow project)

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonClient,
  expectAppError,
  expectDenied,
  makeBatch,
  makePersona,
  resetShadow,
  runSql,
  seedMember,
  spaceIdFor,
  sqlScalar,
} from './_harness.mjs';

// Cohort start dates. "started" cohorts are in the past because a seat only
// GRANTS access once its cohort has begun (activates_at <= now()); a future
// cohort is owned but not yet open. Getting this wrong in a fixture reads as a
// broken policy, so the dates are explicit everywhere.
const STARTED = '2026-01-01';
const FUTURE = '2099-01-01';

// `vip` is the cohort member (180 days = six cohorts); `member` is on the
// surviving self-paced plan, which buys no cohort at all.
let admin, vip, member;

before(async () => {
  admin = await makePersona('admin', { isAdmin: true, fullName: 'Alex Admin' });
  vip = await makePersona('vip-aug', { fullName: 'Vera Vip' });
  member = await makePersona('silver-member', { fullName: 'Silvia Silver' });
});

// Full isolation per test. Creating a batch FIFO-binds every outstanding queued
// seat in the database, so leftovers from one test would silently change the
// seat counts in the next.
beforeEach(async () => { await resetShadow(); });

after(async () => { await resetShadow(); });

// ── The core product rule: a 180-day plan buys six cohorts ───────────────────

test('a VIP approval materialises SIX cohort seats (D1) — allocated where cohorts exist, queued where they do not', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await makeBatch('2026-09', { startsOn: STARTED });
  await makeBatch('2026-10', { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });

  const rows = await runSql(`
    select status, count(*)::int n from public.batch_entitlements
     where user_id = '${vip.id}'::uuid group by status order by status`);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));

  assert.equal((byStatus.active || 0) + (byStatus.queued || 0), 6, 'six seats in total');
  assert.equal(byStatus.active, 3, 'the three cohorts that exist are allocated');
  assert.equal(byStatus.queued, 3, 'the rest are owed, not invented');
});

test('a queued seat binds to the next cohort that actually opens — never a computed month', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 60, startBatchCode: '2026-08', seats: 2 });

  assert.equal(
    await sqlScalar(`select count(*)::int from public.batch_entitlements
                      where user_id = '${vip.id}'::uuid and status = 'queued'`),
    1, 'one seat is owed');

  // Alex skips September, October and November entirely and opens December.
  // Calendar arithmetic would have promised 2026-09 and stranded the seat.
  await makeBatch('2026-12', { startsOn: STARTED });

  const dec = await sqlScalar(`
    select count(*)::int from public.batch_entitlements e
      join public.batches b on b.id = e.batch_id
     where e.user_id = '${vip.id}'::uuid and b.code = '2026-12' and e.status = 'active'`);
  assert.equal(dec, 1, 'the owed seat claimed the cohort that exists');
});

test('a member with several owed seats gets AT MOST ONE seat in a new cohort', async () => {
  // Regression: the FIFO binder's guard was evaluated against the cursor's
  // snapshot, so all of one member's queued seats were bound to the same new
  // cohort, violating one-seat-per-cohort.
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });
  await makeBatch('2026-09', { startsOn: STARTED });

  const inSep = await sqlScalar(`
    select count(*)::int from public.batch_entitlements e
      join public.batches b on b.id = e.batch_id
     where e.user_id = '${vip.id}'::uuid and b.code = '2026-09'`);
  assert.equal(inSep, 1, 'exactly one seat per member per cohort');
});

test('a member reads their own ledger and no one else s', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });
  await seedMember(member, { planKey: 'silver_self_paced', days: 60 });

  const { data: mine, error } = await vip.db
    .from('batch_entitlements').select('id,user_id,segment');
  assert.equal(error, null);
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((r) => r.user_id === vip.id), 'only own rows');

  const { data: theirs } = await member.db
    .from('batch_entitlements').select('id').eq('user_id', vip.id);
  assert.deepEqual(theirs, [], 'a foreign ledger row is invisible');
});

// ── Batch isolation — the segregation requirement ────────────────────────────

test('VIP is the only cohort segment there is — grant_batch_run refuses any other', async () => {
  // ★ This test REPLACES two #35-era tests that #39 made unexpressible:
  //     · 'a Gold member reaches their own cohort spaces and NEVER a VIP space'
  //     · 'the ledger refuses to mix Gold and VIP seats in one outstanding run'
  //   Both asserted the boundary BETWEEN two premium segments. #39 deleted the
  //   Gold segment outright — there is no second segment to be isolated from or
  //   mixed with, so re-homing them would leave two tests that pass because the
  //   scenario cannot be built, which is worse than not having them.
  //
  //   What survives is the invariant that made them true: a seat can only ever
  //   be VIP. That is now enforced twice, and both layers are asserted here —
  //   the allocator's own guard (a precise, branchable INVALID_PLAN) and the
  //   batch_entitlements_segment_check CHECK behind it, which holds even for a
  //   writer that never goes through the allocator.
  await makeBatch('2026-08', { startsOn: STARTED });
  const batchId = await sqlScalar(`select id::text from public.batches where code = '2026-08'`);
  await seedMember(member, { planKey: 'silver_self_paced', days: 60 });

  // A real, open batch id, so the refusal is provably about the SEGMENT and not
  // about a batch the function could not find.
  const err = await runSqlExpectError(`
    select public.grant_batch_run('${member.id}'::uuid, 'gold',
      '${batchId}'::uuid, 1, 'approval', null, 'silver_self_paced', null, null, null, null, true)`);
  assert.match(err, /INVALID_PLAN/, `expected INVALID_PLAN, got: ${err}`);
  assert.equal(
    await sqlScalar(`select count(*)::int from public.batch_entitlements
                      where user_id = '${member.id}'::uuid`),
    0, 'and nothing was written');

  // The CHECK is the layer that does not depend on anyone calling the allocator.
  const direct = await runSqlExpectError(`
    insert into public.batch_entitlements
      (user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason)
    values ('${member.id}'::uuid, null, 'gold', 0, gen_random_uuid(), 1, 'queued', 'approval')`);
  assert.match(direct, /batch_entitlements_segment_check|violates check constraint/i,
    `expected the segment CHECK to refuse a direct insert, got: ${direct}`);
});

test('an October-only student cannot see August or September cohorts', async () => {
  for (const code of ['2026-08', '2026-09', '2026-10']) await makeBatch(code, { startsOn: STARTED });

  const octOnly = await makePersona('vip-oct-only', { fullName: 'Otto October' });
  await seedMember(octOnly, { planKey: 'vip', days: 30, startBatchCode: '2026-10', seats: 1 });

  const { data: spaces } = await octOnly.db.rpc('my_community_spaces');
  const codes = spaces.filter((s) => s.kind !== 'general').map((s) => s.batch_code);
  assert.deepEqual(codes, ['2026-10'], 'exactly the cohort they bought');

  for (const code of ['2026-08', '2026-09']) {
    const sid = await spaceIdFor('vip', code);
    const { data } = await octOnly.db.from('community_spaces').select('id').eq('id', sid);
    assert.deepEqual(data, [], `${code} must be invisible`);
  }
});

test('an August+September student sees both, and nothing beyond their run', async () => {
  for (const code of ['2026-08', '2026-09', '2026-10']) await makeBatch(code, { startsOn: STARTED });

  const two = await makePersona('vip-two-cohorts', { fullName: 'Tina Two' });
  await seedMember(two, { planKey: 'vip', days: 60, startBatchCode: '2026-08', seats: 2 });

  const { data: spaces } = await two.db.rpc('my_community_spaces');
  const codes = spaces.filter((s) => s.kind !== 'general').map((s) => s.batch_code).sort();
  assert.deepEqual(codes, ['2026-08', '2026-09'], 'both cohorts, and only those');
});

test('guessing a space uuid cannot reach another cohort s posts', async () => {
  for (const code of ['2026-08', '2026-10']) await makeBatch(code, { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 30, startBatchCode: '2026-08', seats: 1 });
  const octOnly = await makePersona('vip-oct-only');
  await seedMember(octOnly, { planKey: 'vip', days: 30, startBatchCode: '2026-10', seats: 1 });

  const augVip = await spaceIdFor('vip', '2026-08');
  // tag_slug is FK-bound to community_tags; 'questions' is one of the ten seeded.
  await runSql(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${admin.id}'::uuid, '${augVip}'::uuid, 'August only', 'cohort material', 'questions', 'active')`);

  const { data: leaked } = await octOnly.db
    .from('community_posts').select('id,title').eq('space_id', augVip);
  assert.deepEqual(leaked, [], 'the uuid is not a key');

  const { data: visible } = await vip.db
    .from('community_posts').select('id,title').eq('space_id', augVip);
  assert.equal(visible.length, 1, 'the entitled member does see it');
});

test('a cohort that has not started yet is OWNED but not yet open', async () => {
  await makeBatch('2099-01', { startsOn: FUTURE });
  const early = await makePersona('vip-early', { fullName: 'Ed Early' });
  await seedMember(early, { planKey: 'vip', days: 30, startBatchCode: '2099-01', seats: 1 });

  const seatCount = await sqlScalar(`
    select count(*)::int from public.batch_entitlements
     where user_id = '${early.id}'::uuid and status = 'active'`);
  assert.equal(seatCount, 1, 'the seat is allocated and paid for');

  const { data: spaces } = await early.db.rpc('my_community_spaces');
  assert.ok(!spaces.some((s) => s.kind === 'vip'),
    'but the space stays closed until the cohort starts');
});

// ── Live plan reconciliation ─────────────────────────────────────────────────

test('a DOWNGRADE cuts premium access immediately, with no revocation needed', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const dg = await makePersona('vip-downgrade', { fullName: 'Dana Downgrade' });
  await seedMember(dg, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });

  const before = await dg.db.rpc('my_community_spaces');
  assert.ok(before.data.some((s) => s.kind === 'vip'), 'starts with cohort access');

  // Refund / downgrade / plan correction, onto the surviving non-cohort plan.
  // The stamped ledger rows still say 'vip' and are still active — nothing
  // about them changes.
  await runSql(`update public.subscriptions set plan_key = 'silver_self_paced'
                 where user_id = '${dg.id}'::uuid`);

  assert.ok(await sqlScalar(`
    select count(*)::int from public.batch_entitlements
     where user_id = '${dg.id}'::uuid and segment = 'vip' and status = 'active'`) > 0,
    'the ledger is deliberately untouched');

  const after = await dg.db.rpc('my_community_spaces');
  assert.ok(!after.data.some((s) => s.kind === 'vip'),
    'yet access is gone, because the LIVE plan segment no longer matches');
});

test('an EXPIRED member loses cohort access and every community read', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const ex = await makePersona('vip-expired', { fullName: 'Ex Vip' });
  await seedMember(ex, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });
  await runSql(`
    update public.subscriptions
       set ends_at = now() - interval '10 days', grace_ends_at = now() - interval '7 days'
     where user_id = '${ex.id}'::uuid`);

  const { data: spaces } = await ex.db.rpc('my_community_spaces');
  assert.deepEqual(spaces, [], 'past grace: no spaces at all, not even General');

  const augVip = await spaceIdFor('vip', '2026-08');
  const { data: posts } = await ex.db.from('community_posts').select('id').eq('space_id', augVip);
  assert.deepEqual(posts, [], 'and no cohort content');
});

test('a member IN GRACE keeps access — the 3-day cushion still works', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const g = await makePersona('vip-grace', { fullName: 'Grace Period' });
  await seedMember(g, { planKey: 'vip', days: 180, startBatchCode: '2026-08', inGrace: true });
  const { data: spaces } = await g.db.rpc('my_community_spaces');
  assert.ok(spaces.some((s) => s.kind === 'vip'), 'grace preserves cohort access');
});

// ── Anonymous access and privilege escalation ────────────────────────────────

test('an anonymous visitor reads nothing and can call nothing', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });

  const anon = anonClient();
  for (const table of ['batch_entitlements', 'community_posts', 'community_spaces',
    'batches', 'courses', 'subscriptions', 'profiles']) {
    const { data, error } = await anon.from(table).select('*').limit(5);
    assert.ok(error || (data || []).length === 0, `anon must not read ${table}`);
  }
  const { error: rpcErr } = await anon.rpc('my_community_spaces');
  assert.ok(rpcErr, 'anon cannot call my_community_spaces');
});

test('a member cannot write the ledger, forge a seat, or call the allocator', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });
  await seedMember(member, { planKey: 'silver_self_paced', days: 60 });
  const batchId = await sqlScalar(`select id::text from public.batches where code = '2026-08'`);

  // The explicit REVOKE is what stops these — Supabase's default grants would
  // otherwise leave table DML in place regardless of the missing policy.
  //
  // The forger is the SELF-PACED member: since #39 there is no second segment to
  // escalate between, so the sharp version of this attack is a plan that buys no
  // cohort at all minting itself one.
  await expectDenied(
    member.db.from('batch_entitlements').insert({
      user_id: member.id, segment: 'vip', batch_index: 0,
      run_id: '00000000-0000-0000-0000-000000000001',
      run_length: 1, status: 'active', grant_reason: 'approval',
    }),
    'self-granting a VIP seat');

  // Not `segment` any more (a VIP member rewriting 'vip' to 'vip' would prove
  // nothing): with one segment, the escalation left is buying yourself time.
  await expectDenied(
    vip.db.from('batch_entitlements')
      .update({ valid_until: '2099-01-01T00:00:00Z' }).eq('user_id', vip.id),
    'extending own seats');

  await expectDenied(
    vip.db.from('batch_entitlements').delete().eq('user_id', vip.id),
    'deleting own ledger history');

  const { error } = await vip.db.rpc('grant_batch_run', {
    p_user_id: vip.id, p_segment: 'vip', p_start_batch_id: batchId,
    p_count: 6, p_grant_reason: 'approval',
  });
  assert.ok(error, 'the allocator is not callable from a browser');
});

test('a member cannot run the admin RPCs', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(member, { planKey: 'silver_self_paced', days: 60 });
  const batchId = await sqlScalar(`select id::text from public.batches where code = '2026-08'`);

  await expectAppError(member.db.rpc('admin_reconcile_queued_entitlements', {}),
    'FORBIDDEN', 'reconcile as member');
  await expectAppError(member.db.rpc('admin_revoke_batch_run', { p_user_id: member.id }),
    'FORBIDDEN', 'revoke as member');
  await expectAppError(member.db.rpc('admin_grant_batch_run', { p_user_id: member.id, p_batch_id: batchId }),
    'FORBIDDEN', 'self-granting a cohort seat');
  await expectAppError(member.db.rpc('admin_assign_batch', { p_user_ids: [member.id], p_batch_id: batchId }),
    'FORBIDDEN', 'assigning oneself a batch');
});

// ── Capacity (D8) and the error contract ─────────────────────────────────────

test('capacity refuses over-subscription with a branchable BATCH_FULL', async () => {
  await makeBatch('2027-01', { vipCap: 1, startsOn: STARTED });
  const first = await makePersona('cap-first');
  await seedMember(first, { planKey: 'vip', days: 30, startBatchCode: '2027-01', seats: 1 });

  const second = await makePersona('cap-second');
  await seedMember(second, { planKey: 'vip', days: 30 });

  const err = await runSqlExpectError(`
    select public.grant_batch_run('${second.id}'::uuid, 'vip',
      (select id from public.batches where code = '2027-01'),
      1, 'approval', null, 'vip', null, null, null, null, true)`);

  assert.match(err, /BATCH_FULL/, `expected BATCH_FULL, got: ${err}`);
  assert.match(err, /"capacity": 1/, 'the context names the capacity for the UI');

  const holders = await sqlScalar(`
    select count(*)::int from public.batch_seat_holders(
      (select id from public.batches where code = '2027-01'), 'vip')`);
  assert.equal(holders, 1, 'the cap held — exactly one seat occupied');
});

test('D8: a seat is consumed in EVERY cohort of the run, not only the first', async () => {
  await makeBatch('2027-03', { vipCap: 5, startsOn: STARTED });
  await makeBatch('2027-04', { vipCap: 5, startsOn: STARTED });

  const m = await makePersona('d8-member');
  await seedMember(m, { planKey: 'vip', days: 90, startBatchCode: '2027-03', seats: 2 });

  for (const code of ['2027-03', '2027-04']) {
    const n = await sqlScalar(`
      select count(*)::int from public.batch_seat_holders(
        (select id from public.batches where code = '${code}'), 'vip')`);
    assert.equal(n, 1, `${code} must count the seat as occupied`);
  }
});

test('opening a new cohort FILLS it from the queue, capacity notwithstanding', async () => {
  // Documented, deliberate, and surprising: queued seats were already sold, so
  // the FIFO binder never refuses them. Admin -> Batches surfaces the committed
  // demand so a capacity can be chosen from evidence rather than guessed.
  await makeBatch('2027-06', { startsOn: STARTED });
  const a = await makePersona('queue-a');
  const b = await makePersona('queue-b');
  await seedMember(a, { planKey: 'vip', days: 60, startBatchCode: '2027-06', seats: 2 });
  await seedMember(b, { planKey: 'vip', days: 60, startBatchCode: '2027-06', seats: 2 });

  assert.equal(await sqlScalar(
    `select count(*)::int from public.batch_entitlements where status = 'queued'`), 2);

  await makeBatch('2027-07', { vipCap: 1, startsOn: STARTED });

  const holders = await sqlScalar(`
    select count(*)::int from public.batch_seat_holders(
      (select id from public.batches where code = '2027-07'), 'vip')`);
  assert.equal(holders, 2, 'both owed seats were honoured despite vip_capacity = 1');
});

test('an archived cohort is refused; a closed one only blocks NEW seats', async () => {
  await makeBatch('2027-09', { status: 'archived', startsOn: STARTED });
  const m = await makePersona('archived-target');
  await seedMember(m, { planKey: 'vip', days: 30 });

  const err = await runSqlExpectError(`
    select public.grant_batch_run('${m.id}'::uuid, 'vip',
      (select id from public.batches where code = '2027-09'),
      1, 'approval', null, 'vip', null, null, null, null, true)`);
  assert.match(err, /BATCH_CLOSED|archived/, `expected an archived refusal, got: ${err}`);
});

// ── History preservation ─────────────────────────────────────────────────────

test('revoking marks rows and records WHY — it never deletes history', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const r = await makePersona('revoke-target');
  await seedMember(r, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });

  const before = await sqlScalar(
    `select count(*)::int from public.batch_entitlements where user_id = '${r.id}'::uuid`);
  await runSql(`select public.revoke_batch_run('${r.id}'::uuid, null, 'refund', null, 'revoked')`);

  assert.equal(
    await sqlScalar(`select count(*)::int from public.batch_entitlements where user_id = '${r.id}'::uuid`),
    before, 'every row is still there');
  assert.equal(
    await sqlScalar(`select count(*)::int from public.batch_entitlements
                      where user_id = '${r.id}'::uuid and status = 'revoked' and revoke_reason = 'refund'`),
    before, 'and each one records why it ended');

  const { data: spaces } = await r.db.rpc('my_community_spaces');
  assert.ok(!spaces.some((s) => s.kind === 'vip'), 'access is gone');
});

test('a reassignment SUPERSEDES rather than overwrites, so the old cohort is still on record', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await makeBatch('2026-09', { startsOn: STARTED });
  const m = await makePersona('reassign-target');
  await seedMember(m, { planKey: 'vip', days: 30, startBatchCode: '2026-08', seats: 1 });

  await runSql(`
    do $$ begin perform set_config('request.jwt.claims',
      json_build_object('sub', '${admin.id}', 'role', 'authenticated')::text, true);
    end $$;`);
  // admin_assign_batch is admin-guarded, so drive it as the admin persona.
  const { error } = await admin.db.rpc('admin_assign_batch', {
    p_user_ids: [m.id],
    p_batch_id: await sqlScalar(`select id::text from public.batches where code = '2026-09'`),
  });
  assert.equal(error, null, `assign failed: ${error && error.message}`);

  const superseded = await sqlScalar(`
    select count(*)::int from public.batch_entitlements e
      join public.batches b on b.id = e.batch_id
     where e.user_id = '${m.id}'::uuid and b.code = '2026-08' and e.status = 'superseded'`);
  assert.equal(superseded, 1, 'the August seat is retained, marked superseded');

  const active = await sqlScalar(`
    select count(*)::int from public.batch_entitlements e
      join public.batches b on b.id = e.batch_id
     where e.user_id = '${m.id}'::uuid and b.code = '2026-09' and e.status = 'active'`);
  assert.equal(active, 1, 'and the new cohort is granted');
});

test('the legacy bridge serves ONLY members who have no ledger rows', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });

  // A pre-#35 grant: subscriptions.batch_id set, nothing in the ledger.
  const legacy = await makePersona('legacy-vip');
  await runSql(`
    do $$ begin
      insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, batch_id)
      values ('${legacy.id}'::uuid, 'vip', 'active', now(),
              now() + interval '90 days', now() + interval '93 days',
              (select id from public.batches where code = '2026-08'));
      update public.profiles set is_paid = true, plan = 'vip' where id = '${legacy.id}'::uuid;
    end $$;`);

  const { data: viaBridge } = await legacy.db.rpc('my_community_spaces');
  assert.ok(viaBridge.some((s) => s.kind === 'vip'), 'a pre-#35 member keeps working');

  // A ledger member stays revoked even if the stale cache lingers — which is
  // what stops a revocation being undone by subscriptions.batch_id.
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });
  await runSql(`select public.revoke_batch_run('${vip.id}'::uuid, null, 'test', null, 'revoked')`);
  await runSql(`update public.subscriptions
                   set batch_id = (select id from public.batches where code = '2026-08')
                 where user_id = '${vip.id}'::uuid`);

  const { data: afterRevoke } = await vip.db.rpc('my_community_spaces');
  assert.ok(!afterRevoke.some((s) => s.kind === 'vip'),
    'the bridge does not resurrect a revoked ledger member');
});

/** Run SQL expecting a raise; return the message text (or '' if it succeeded). */
async function runSqlExpectError(sql) {
  try {
    await runSql(sql, { retries: 0 });
    return '';
  } catch (e) {
    return e.sqlDetail || e.message;
  }
}
