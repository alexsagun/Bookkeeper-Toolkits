// test-db/entitlements.dbtest.mjs — cohort entitlement + batch isolation (#35).
//
// Every authorization assertion goes through a REAL signed-in user's PostgREST
// client. Nothing is asserted through the service role or the Management API:
// those run as `postgres` and bypass RLS, so they would pass regardless of what
// the policies say. Setup uses them; proof never does.
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

let admin, gold, vip, core;

before(async () => {
  admin = await makePersona('admin', { isAdmin: true, fullName: 'Alex Admin' });
  gold = await makePersona('gold-aug', { fullName: 'Gina Gold' });
  vip = await makePersona('vip-aug', { fullName: 'Vera Vip' });
  core = await makePersona('core-member', { fullName: 'Cora Core' });
});

// Full isolation per test. Creating a batch FIFO-binds every outstanding queued
// seat in the database, so leftovers from one test would silently change the
// seat counts in the next.
beforeEach(async () => { await resetShadow(); });

after(async () => { await resetShadow(); });

// ── The core product rule: a 180-day plan buys six cohorts ───────────────────

test('a Gold approval materialises SIX cohort seats (D1) — allocated where cohorts exist, queued where they do not', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await makeBatch('2026-09', { startsOn: STARTED });
  await makeBatch('2026-10', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });

  const rows = await runSql(`
    select status, count(*)::int n from public.batch_entitlements
     where user_id = '${gold.id}'::uuid group by status order by status`);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));

  assert.equal((byStatus.active || 0) + (byStatus.queued || 0), 6, 'six seats in total');
  assert.equal(byStatus.active, 3, 'the three cohorts that exist are allocated');
  assert.equal(byStatus.queued, 3, 'the rest are owed, not invented');
});

test('a queued seat binds to the next cohort that actually opens — never a computed month', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 60, startBatchCode: '2026-08', seats: 2 });

  assert.equal(
    await sqlScalar(`select count(*)::int from public.batch_entitlements
                      where user_id = '${gold.id}'::uuid and status = 'queued'`),
    1, 'one seat is owed');

  // Alex skips September, October and November entirely and opens December.
  // Calendar arithmetic would have promised 2026-09 and stranded the seat.
  await makeBatch('2026-12', { startsOn: STARTED });

  const dec = await sqlScalar(`
    select count(*)::int from public.batch_entitlements e
      join public.batches b on b.id = e.batch_id
     where e.user_id = '${gold.id}'::uuid and b.code = '2026-12' and e.status = 'active'`);
  assert.equal(dec, 1, 'the owed seat claimed the cohort that exists');
});

test('a member with several owed seats gets AT MOST ONE seat in a new cohort', async () => {
  // Regression: the FIFO binder's guard was evaluated against the cursor's
  // snapshot, so all of one member's queued seats were bound to the same new
  // cohort, violating one-seat-per-cohort.
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });
  await makeBatch('2026-09', { startsOn: STARTED });

  const inSep = await sqlScalar(`
    select count(*)::int from public.batch_entitlements e
      join public.batches b on b.id = e.batch_id
     where e.user_id = '${gold.id}'::uuid and b.code = '2026-09'`);
  assert.equal(inSep, 1, 'exactly one seat per member per cohort');
});

test('a member reads their own ledger and no one else s', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });
  await seedMember(core, { planKey: 'core_self_paced', days: 60 });

  const { data: mine, error } = await gold.db
    .from('batch_entitlements').select('id,user_id,segment');
  assert.equal(error, null);
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((r) => r.user_id === gold.id), 'only own rows');

  const { data: theirs } = await core.db
    .from('batch_entitlements').select('id').eq('user_id', gold.id);
  assert.deepEqual(theirs, [], 'a foreign ledger row is invisible');
});

// ── Batch isolation — the segregation requirement ────────────────────────────

test('a Gold member reaches their own cohort spaces and NEVER a VIP space', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08' });

  const { data: spaces, error } = await gold.db.rpc('my_community_spaces');
  assert.equal(error, null);
  const kinds = new Set(spaces.map((s) => s.kind));
  assert.ok(kinds.has('general'), 'General comes with every plan');
  assert.ok(kinds.has('gold'), 'their own Gold cohort is included');
  assert.ok(!kinds.has('vip'), 'a VIP space must never appear for a Gold member');

  // Gold and VIP share a batch, so a batch-id-only check would have leaked here.
  const vipSpace = await spaceIdFor('vip', '2026-08');
  const { data: direct } = await gold.db.from('community_spaces').select('id').eq('id', vipSpace);
  assert.deepEqual(direct, [], 'and naming the uuid directly is refused');
});

test('an October-only student cannot see August or September cohorts', async () => {
  for (const code of ['2026-08', '2026-09', '2026-10']) await makeBatch(code, { startsOn: STARTED });

  const octOnly = await makePersona('gold-oct-only', { fullName: 'Otto October' });
  await seedMember(octOnly, { planKey: 'gold_live', days: 30, startBatchCode: '2026-10', seats: 1 });

  const { data: spaces } = await octOnly.db.rpc('my_community_spaces');
  const codes = spaces.filter((s) => s.kind !== 'general').map((s) => s.batch_code);
  assert.deepEqual(codes, ['2026-10'], 'exactly the cohort they bought');

  for (const code of ['2026-08', '2026-09']) {
    const sid = await spaceIdFor('gold', code);
    const { data } = await octOnly.db.from('community_spaces').select('id').eq('id', sid);
    assert.deepEqual(data, [], `${code} must be invisible`);
  }
});

test('an August+September student sees both, and nothing beyond their run', async () => {
  for (const code of ['2026-08', '2026-09', '2026-10']) await makeBatch(code, { startsOn: STARTED });

  const two = await makePersona('gold-two-cohorts', { fullName: 'Tina Two' });
  await seedMember(two, { planKey: 'gold_live', days: 60, startBatchCode: '2026-08', seats: 2 });

  const { data: spaces } = await two.db.rpc('my_community_spaces');
  const codes = spaces.filter((s) => s.kind !== 'general').map((s) => s.batch_code).sort();
  assert.deepEqual(codes, ['2026-08', '2026-09'], 'both cohorts, and only those');
});

test('guessing a space uuid cannot reach another cohort s posts', async () => {
  for (const code of ['2026-08', '2026-10']) await makeBatch(code, { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 30, startBatchCode: '2026-08', seats: 1 });
  const octOnly = await makePersona('gold-oct-only');
  await seedMember(octOnly, { planKey: 'gold_live', days: 30, startBatchCode: '2026-10', seats: 1 });

  const augGold = await spaceIdFor('gold', '2026-08');
  // tag_slug is FK-bound to community_tags; 'questions' is one of the ten seeded.
  await runSql(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${admin.id}'::uuid, '${augGold}'::uuid, 'August only', 'cohort material', 'questions', 'active')`);

  const { data: leaked } = await octOnly.db
    .from('community_posts').select('id,title').eq('space_id', augGold);
  assert.deepEqual(leaked, [], 'the uuid is not a key');

  const { data: visible } = await gold.db
    .from('community_posts').select('id,title').eq('space_id', augGold);
  assert.equal(visible.length, 1, 'the entitled member does see it');
});

test('a cohort that has not started yet is OWNED but not yet open', async () => {
  await makeBatch('2099-01', { startsOn: FUTURE });
  const early = await makePersona('gold-early', { fullName: 'Ed Early' });
  await seedMember(early, { planKey: 'gold_live', days: 30, startBatchCode: '2099-01', seats: 1 });

  const seatCount = await sqlScalar(`
    select count(*)::int from public.batch_entitlements
     where user_id = '${early.id}'::uuid and status = 'active'`);
  assert.equal(seatCount, 1, 'the seat is allocated and paid for');

  const { data: spaces } = await early.db.rpc('my_community_spaces');
  assert.ok(!spaces.some((s) => s.kind === 'gold'),
    'but the space stays closed until the cohort starts');
});

// ── Live plan reconciliation ─────────────────────────────────────────────────

test('a DOWNGRADE cuts premium access immediately, with no revocation needed', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const dg = await makePersona('gold-downgrade', { fullName: 'Dana Downgrade' });
  await seedMember(dg, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });

  const before = await dg.db.rpc('my_community_spaces');
  assert.ok(before.data.some((s) => s.kind === 'gold'), 'starts with Gold access');

  // Refund / downgrade / plan correction. The stamped ledger rows still say
  // 'gold' and are still active — nothing about them changes.
  await runSql(`update public.subscriptions set plan_key = 'core_self_paced'
                 where user_id = '${dg.id}'::uuid`);

  assert.ok(await sqlScalar(`
    select count(*)::int from public.batch_entitlements
     where user_id = '${dg.id}'::uuid and segment = 'gold' and status = 'active'`) > 0,
    'the ledger is deliberately untouched');

  const after = await dg.db.rpc('my_community_spaces');
  assert.ok(!after.data.some((s) => s.kind === 'gold'),
    'yet access is gone, because the LIVE plan segment no longer matches');
});

test('an EXPIRED member loses cohort access and every community read', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const ex = await makePersona('gold-expired', { fullName: 'Ex Gold' });
  await seedMember(ex, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });
  await runSql(`
    update public.subscriptions
       set ends_at = now() - interval '10 days', grace_ends_at = now() - interval '7 days'
     where user_id = '${ex.id}'::uuid`);

  const { data: spaces } = await ex.db.rpc('my_community_spaces');
  assert.deepEqual(spaces, [], 'past grace: no spaces at all, not even General');

  const augGold = await spaceIdFor('gold', '2026-08');
  const { data: posts } = await ex.db.from('community_posts').select('id').eq('space_id', augGold);
  assert.deepEqual(posts, [], 'and no cohort content');
});

test('a member IN GRACE keeps access — the 3-day cushion still works', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const g = await makePersona('gold-grace', { fullName: 'Grace Period' });
  await seedMember(g, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08', inGrace: true });
  const { data: spaces } = await g.db.rpc('my_community_spaces');
  assert.ok(spaces.some((s) => s.kind === 'gold'), 'grace preserves cohort access');
});

// ── Anonymous access and privilege escalation ────────────────────────────────

test('an anonymous visitor reads nothing and can call nothing', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });

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
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });
  const batchId = await sqlScalar(`select id::text from public.batches where code = '2026-08'`);

  // The explicit REVOKE is what stops these — Supabase's default grants would
  // otherwise leave table DML in place regardless of the missing policy.
  await expectDenied(
    gold.db.from('batch_entitlements').insert({
      user_id: gold.id, segment: 'vip', batch_index: 0,
      run_id: '00000000-0000-0000-0000-000000000001',
      run_length: 1, status: 'active', grant_reason: 'approval',
    }),
    'self-granting a VIP seat');

  await expectDenied(
    gold.db.from('batch_entitlements').update({ segment: 'vip' }).eq('user_id', gold.id),
    'rewriting own seats to VIP');

  await expectDenied(
    gold.db.from('batch_entitlements').delete().eq('user_id', gold.id),
    'deleting own ledger history');

  const { error } = await gold.db.rpc('grant_batch_run', {
    p_user_id: gold.id, p_segment: 'vip', p_start_batch_id: batchId,
    p_count: 6, p_grant_reason: 'approval',
  });
  assert.ok(error, 'the allocator is not callable from a browser');
});

test('a member cannot run the admin RPCs', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(core, { planKey: 'core_self_paced', days: 60 });
  const batchId = await sqlScalar(`select id::text from public.batches where code = '2026-08'`);

  await expectAppError(core.db.rpc('admin_reconcile_queued_entitlements', {}),
    'FORBIDDEN', 'reconcile as member');
  await expectAppError(core.db.rpc('admin_revoke_batch_run', { p_user_id: core.id }),
    'FORBIDDEN', 'revoke as member');
  await expectAppError(core.db.rpc('admin_grant_batch_run', { p_user_id: core.id, p_batch_id: batchId }),
    'FORBIDDEN', 'self-granting a cohort seat');
  await expectAppError(core.db.rpc('admin_assign_batch', { p_user_ids: [core.id], p_batch_id: batchId }),
    'FORBIDDEN', 'assigning oneself a batch');
});

// ── Capacity (D8) and the error contract ─────────────────────────────────────

test('capacity refuses over-subscription with a branchable BATCH_FULL', async () => {
  await makeBatch('2027-01', { goldCap: 1, startsOn: STARTED });
  const first = await makePersona('cap-first');
  await seedMember(first, { planKey: 'gold_live', days: 30, startBatchCode: '2027-01', seats: 1 });

  const second = await makePersona('cap-second');
  await seedMember(second, { planKey: 'gold_live', days: 30 });

  const err = await runSqlExpectError(`
    select public.grant_batch_run('${second.id}'::uuid, 'gold',
      (select id from public.batches where code = '2027-01'),
      1, 'approval', null, 'gold_live', null, null, null, null, true)`);

  assert.match(err, /BATCH_FULL/, `expected BATCH_FULL, got: ${err}`);
  assert.match(err, /"capacity": 1/, 'the context names the capacity for the UI');

  const holders = await sqlScalar(`
    select count(*)::int from public.batch_seat_holders(
      (select id from public.batches where code = '2027-01'), 'gold')`);
  assert.equal(holders, 1, 'the cap held — exactly one seat occupied');
});

test('D8: a seat is consumed in EVERY cohort of the run, not only the first', async () => {
  await makeBatch('2027-03', { goldCap: 5, startsOn: STARTED });
  await makeBatch('2027-04', { goldCap: 5, startsOn: STARTED });

  const m = await makePersona('d8-member');
  await seedMember(m, { planKey: 'gold_live', days: 90, startBatchCode: '2027-03', seats: 2 });

  for (const code of ['2027-03', '2027-04']) {
    const n = await sqlScalar(`
      select count(*)::int from public.batch_seat_holders(
        (select id from public.batches where code = '${code}'), 'gold')`);
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
  await seedMember(a, { planKey: 'gold_live', days: 60, startBatchCode: '2027-06', seats: 2 });
  await seedMember(b, { planKey: 'gold_live', days: 60, startBatchCode: '2027-06', seats: 2 });

  assert.equal(await sqlScalar(
    `select count(*)::int from public.batch_entitlements where status = 'queued'`), 2);

  await makeBatch('2027-07', { goldCap: 1, startsOn: STARTED });

  const holders = await sqlScalar(`
    select count(*)::int from public.batch_seat_holders(
      (select id from public.batches where code = '2027-07'), 'gold')`);
  assert.equal(holders, 2, 'both owed seats were honoured despite gold_capacity = 1');
});

test('an archived cohort is refused; a closed one only blocks NEW seats', async () => {
  await makeBatch('2027-09', { status: 'archived', startsOn: STARTED });
  const m = await makePersona('archived-target');
  await seedMember(m, { planKey: 'gold_live', days: 30 });

  const err = await runSqlExpectError(`
    select public.grant_batch_run('${m.id}'::uuid, 'gold',
      (select id from public.batches where code = '2027-09'),
      1, 'approval', null, 'gold_live', null, null, null, null, true)`);
  assert.match(err, /BATCH_CLOSED|archived/, `expected an archived refusal, got: ${err}`);
});

test('the ledger refuses to mix Gold and VIP seats in one outstanding run', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });

  const err = await runSqlExpectError(`
    select public.grant_batch_run('${gold.id}'::uuid, 'vip',
      (select id from public.batches where code = '2026-08'),
      1, 'upgrade', null, 'vip', null, null, null, null, true)`);
  assert.match(err, /SEGMENT_MISMATCH/, `expected SEGMENT_MISMATCH, got: ${err}`);
});

// ── History preservation ─────────────────────────────────────────────────────

test('revoking marks rows and records WHY — it never deletes history', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  const r = await makePersona('revoke-target');
  await seedMember(r, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });

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
  assert.ok(!spaces.some((s) => s.kind === 'gold'), 'access is gone');
});

test('a reassignment SUPERSEDES rather than overwrites, so the old cohort is still on record', async () => {
  await makeBatch('2026-08', { startsOn: STARTED });
  await makeBatch('2026-09', { startsOn: STARTED });
  const m = await makePersona('reassign-target');
  await seedMember(m, { planKey: 'gold_live', days: 30, startBatchCode: '2026-08', seats: 1 });

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
  const legacy = await makePersona('legacy-gold');
  await runSql(`
    do $$ begin
      insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, batch_id)
      values ('${legacy.id}'::uuid, 'gold_live', 'active', now(),
              now() + interval '90 days', now() + interval '93 days',
              (select id from public.batches where code = '2026-08'));
      update public.profiles set is_paid = true, plan = 'gold_live' where id = '${legacy.id}'::uuid;
    end $$;`);

  const { data: viaBridge } = await legacy.db.rpc('my_community_spaces');
  assert.ok(viaBridge.some((s) => s.kind === 'gold'), 'a pre-#35 member keeps working');

  // A ledger member stays revoked even if the stale cache lingers — which is
  // what stops a revocation being undone by subscriptions.batch_id.
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08' });
  await runSql(`select public.revoke_batch_run('${gold.id}'::uuid, null, 'test', null, 'revoked')`);
  await runSql(`update public.subscriptions
                   set batch_id = (select id from public.batches where code = '2026-08')
                 where user_id = '${gold.id}'::uuid`);

  const { data: afterRevoke } = await gold.db.rpc('my_community_spaces');
  assert.ok(!afterRevoke.some((s) => s.kind === 'gold'),
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
