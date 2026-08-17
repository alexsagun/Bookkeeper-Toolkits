// test-db/batchLifecycle.dbtest.mjs — editable batches, the past-lock, and the
// month-end sweep (#38).
//
// Two claims need a real database, and neither can be proven in the pure suite:
//   1. The UI is NOT the boundary. A past batch must be refused for an admin who
//      bypasses the modal entirely — over PostgREST with their own JWT.
//   2. Renaming a code must not disturb anything keyed on the batch's identity:
//      its uuid, its community space (INCLUDING its slug, which is what ?space=
//      deep links carry), the ledger, or a member's actual access.
//
// ★ #39 (three-plan catalog): VIP is the only cohort segment, so a batch has ONE
//   space (vip-<code>) and admin_update_batch() is 8-arg — p_gold_capacity and
//   batches.gold_capacity are gone.
//
// Every authorization assertion goes through a signed-in persona's client.
// runSql() is the postgres superuser — it bypasses RLS, so it is used for setup
// and catalog inspection, and to prove a TRIGGER fires independently of policy.
//
// Run: npm run test:db   (needs .env.test pointing at a shadow project)

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
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

// Month codes relative to the real clock, so this suite does not rot the way a
// hard-coded '2026-08' does. PRIOR is genuinely past; CURRENT is running today.
//
// ★ EVERY FIXTURE IS UTC (see `batch()` below), and ym() reads the UTC clock, so
// the two always agree. With the Asia/Manila default they would not: between
// 16:00Z and midnight on the last day of a month, Manila is already in the next
// one, so CURRENT would name a month batch_is_past() considers over — and this
// suite would fail for eight hours every month for a reason unrelated to the code
// under test. Timezone behaviour itself is asserted explicitly, with fixed dates.
const ym = (offset) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** Last day of the month a 'YYYY-MM' code names — never a hard-coded 28. */
const lastDay = (code) => {
  const [y, m] = code.split('-').map(Number);
  return `${code}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

const PRIOR = ym(-2);
const CURRENT = ym(0);
const NEXT = ym(1);
const LATER = ym(2);
const STARTED = '2020-01-01';   // a start date safely in the past, for seats that grant access

let admin, vip, member;

/** Every batch in this suite is UTC — see the ym() note above. */
const batch = (code, opts = {}) => makeBatch(code, { timezone: 'UTC', ...opts });

const editAs = (persona, id, over = {}) => {
  const code = over.code ?? CURRENT;
  return persona.db.rpc('admin_update_batch', {
    p_batch_id: id,
    p_code: code,
    p_name: over.name ?? `Renamed ${code}`,
    // Default to the batch's WHOLE month. A hard-coded '-28' silently becomes a
    // past period on the 29th of any month, turning an unrelated test red.
    p_starts_on: over.starts_on ?? `${code}-01`,
    p_ends_on: over.ends_on ?? lastDay(code),
    p_timezone: over.timezone ?? 'UTC',
    p_vip_capacity: over.vip_capacity ?? null,
    p_total_capacity: over.total_capacity ?? null,
  });
};

/** Edit and assert it worked — an unchecked RPC failure reads as a later assert. */
const editOk = async (id, over = {}) => {
  const { data, error } = await editAs(admin, id, over);
  assert.equal(error, null, error && `${error.hint || ''} ${error.message}`);
  return data;
};

before(async () => {
  admin = await makePersona('bl-admin', { isAdmin: true, fullName: 'Alex Admin' });
  vip = await makePersona('bl-vip', { fullName: 'Vera Vip' });
  member = await makePersona('bl-member', { fullName: 'Mia Member' });
});

beforeEach(async () => { await resetShadow(); });
after(async () => { await resetShadow(); });

// ── Every batch is born with a usable period ─────────────────────────────────

test('a batch inserted with no dates gets its period filled from the code', async () => {
  // Deliberately NOT the UTC-pinned wrapper: this asserts the column DEFAULT and
  // the guard's INSERT fill, which is what an SQL-editor insert would get.
  await makeBatch(NEXT);
  const row = await runSql(
    `select starts_on::text, ends_on::text, timezone from public.batches where code = '${NEXT}'`);
  assert.equal(row[0].starts_on, `${NEXT}-01`, 'starts on the first of the month');
  assert.equal(row[0].ends_on, lastDay(NEXT), 'ends on the real last day of that month');
  assert.equal(row[0].timezone, 'Asia/Manila', 'the column default applies before the trigger');
});

test('an impossible timezone is refused at insert', async () => {
  await assert.rejects(
    () => runSql(`insert into public.batches (code, name, timezone)
                  values ('${NEXT}', 'Bad zone', 'Mars/Olympus')`),
    /Mars\/Olympus|BATCH_TIMEZONE_INVALID|PT422/i,
  );
});

// ── The past-lock is the database's, not the modal's ─────────────────────────

test('a past batch is read-only through the RPC', async () => {
  const id = await batch(PRIOR);
  await expectAppError(
    admin.db.rpc('admin_update_batch', {
      p_batch_id: id, p_code: PRIOR, p_name: 'Corrected name',
      p_starts_on: `${PRIOR}-01`, p_ends_on: lastDay(PRIOR), p_timezone: 'Asia/Manila',
      p_vip_capacity: null, p_total_capacity: null,
    }),
    'BATCH_PAST', 'editing a past batch');
});

test('a past batch is read-only for a DIRECT admin write too — the UI is not the gate', async () => {
  const id = await batch(PRIOR);
  // Straight over PostgREST with the admin's own JWT, no modal in sight.
  await expectAppError(
    admin.db.from('batches').update({ name: 'Corrected name' }).eq('id', id).select(),
    'BATCH_PAST', 'direct PATCH of a past batch');

  // And as the superuser, so this is provably the TRIGGER and not a policy.
  await assert.rejects(
    () => runSql(`update public.batches set name = 'Corrected' where id = '${id}'::uuid`),
    /BATCH_PAST|read-only/i, 'the trigger refuses even a superuser statement');
});

test('a past batch can still be archived — lifecycle actions survive the lock', async () => {
  const id = await batch(PRIOR);
  const { error } = await admin.db.from('batches').update({ status: 'archived' }).eq('id', id).select();
  assert.equal(error, null, 'status is not a locked field');
  assert.equal(await sqlScalar(`select status from public.batches where id = '${id}'::uuid`), 'archived');
});

test('a past batch cannot be REOPENED — that would just fight the sweep', async () => {
  // Without this rule the admin and the scheduler loop: reopening succeeds (status
  // is not a frozen field), the hourly sweep re-closes it, and the batch cannot be
  // extended out of the past either. A dead end with no error to explain it.
  const id = await batch(PRIOR);
  await admin.db.from('batches').update({ status: 'closed' }).eq('id', id).select();
  await expectAppError(
    admin.db.from('batches').update({ status: 'open' }).eq('id', id).select(),
    'BATCH_PAST', 'reopening a past batch');

  // Un-archiving one must therefore land on `closed`, the only truthful state.
  await admin.db.from('batches').update({ status: 'archived' }).eq('id', id).select();
  const { error } = await admin.db.from('batches').update({ status: 'closed' }).eq('id', id).select();
  assert.equal(error, null, 'un-archive-to-closed is allowed');
  assert.equal(await sqlScalar(`select status from public.batches where id = '${id}'::uuid`), 'closed');
});

test('a CURRENT batch can still be closed and reopened freely', async () => {
  const id = await batch(CURRENT);
  await admin.db.from('batches').update({ status: 'closed' }).eq('id', id).select();
  const { error } = await admin.db.from('batches').update({ status: 'open' }).eq('id', id).select();
  assert.equal(error, null, 'the lock is the calendar, not the status');
  assert.equal(await sqlScalar(`select status from public.batches where id = '${id}'::uuid`), 'open');
});

test('the break-glass override is reachable by the SQL-editor role and corrects a past name', async () => {
  const id = await batch(PRIOR);
  await runSql(`
    do $bg$
    begin
      perform set_config('app.batch_admin_override', 'on', true);
      update public.batches set name = 'September (corrected)' where id = '${id}'::uuid;
    end
    $bg$;`);
  assert.equal(
    await sqlScalar(`select name from public.batches where id = '${id}'::uuid`),
    'September (corrected)');
});

test('batch_is_past survives a timezone Postgres does not recognise', async () => {
  // `now() at time zone 'Mars/Olympus'` RAISES 22023 — it does not return null. If
  // batch_is_past passed the column through, one bad row would 500 the whole admin
  // screen (it is evaluated per row by admin_batch_overview) and abort the sweep
  // for EVERY batch, hourly, forever. It must degrade, not throw.
  const past = await sqlScalar(`select public.batch_is_past('2020-01-01'::date, 'Mars/Olympus')`);
  assert.equal(past, true, 'an old batch is still judged past');
  const future = await sqlScalar(`select public.batch_is_past('2099-01-01'::date, 'Mars/Olympus')`);
  assert.equal(future, false);
  assert.equal(await sqlScalar(`select public.batch_is_past(null::date, 'Mars/Olympus')`), false,
    'undated is never past, whatever the zone says');
});

// ── The code is not writable over REST ───────────────────────────────────────

test('an admin cannot PATCH batches.code — the column privilege is revoked', async () => {
  const id = await batch(CURRENT);
  await expectDenied(
    admin.db.from('batches').update({ code: NEXT }).eq('id', id).select(),
    'direct PATCH of batches.code');
  assert.equal(await sqlScalar(`select code from public.batches where id = '${id}'::uuid`), CURRENT,
    'the code is untouched');
});

test('a non-admin cannot call admin_update_batch', async () => {
  const id = await batch(CURRENT);
  await expectAppError(editAs(member, id), 'FORBIDDEN', 'member calling the editor');
});

// ── Rank preservation ────────────────────────────────────────────────────────

test('a rename that keeps the batch in the same position is allowed', async () => {
  await batch(PRIOR);
  const id = await batch(NEXT);
  await batch(LATER);
  const { data, error } = await editAs(admin, id, {
    code: NEXT, name: 'Renamed next', starts_on: `${NEXT}-01`, ends_on: lastDay(NEXT),
  });
  assert.equal(error, null, error && error.message);
  assert.equal(data.ok, true);
  assert.equal(data.name, 'Renamed next');
});

test('a rename that would cross a sibling is refused — it reorders paid runs', async () => {
  await batch(CURRENT);
  const id = await batch(NEXT);
  await batch(LATER);
  const err = await expectAppError(
    editAs(admin, id, { code: ym(6), starts_on: `${NEXT}-01`, ends_on: lastDay(NEXT) }),
    'BATCH_CODE_REORDER', 'moving a batch above its successor');
  assert.match(String(err.message), new RegExp(LATER), 'names the batch it would cross');
});

test('the TRIGGER refuses a rank-changing code even for the owner — not just the RPC', async () => {
  // The column revoke stops `authenticated`, but service_role keeps table-level
  // UPDATE and the SQL editor runs as the owner. Without the guard's own rank
  // check, this statement would succeed silently — no error, no audit row — and
  // reorder a member's purchased run months later.
  await batch(CURRENT);
  await batch(NEXT);
  await batch(LATER);
  await assert.rejects(
    () => runSql(`update public.batches set code = '${ym(9)}' where code = '${NEXT}'`),
    /BATCH_CODE_REORDER|reorder/i,
    'a superuser statement is refused too');
  assert.equal(await sqlScalar(`select count(*)::int from public.batches where code = '${NEXT}'`), 1,
    'the code is untouched');

  await assert.rejects(
    () => runSql(`update public.batches set code = 'not-a-month' where code = '${LATER}'`),
    /INVALID_BATCH_CODE|real YYYY-MM month/i,
    'shape is checked in the trigger too');
});

test('a duplicate code is refused', async () => {
  await batch(NEXT);
  const id = await batch(LATER);
  await expectAppError(
    editAs(admin, id, { code: NEXT, starts_on: `${LATER}-01`, ends_on: lastDay(LATER) }),
    'BATCH_CODE_TAKEN', 'reusing a sibling code');
});

test('a batch cannot be edited into an already-past period', async () => {
  const id = await batch(CURRENT);
  await expectAppError(
    editAs(admin, id, { starts_on: `${PRIOR}-01`, ends_on: lastDay(PRIOR) }),
    'BATCH_PERIOD_PAST', 'moving a live batch into the past');
});

test('capacity may not drop below the seats already sold', async () => {
  const id = await batch(CURRENT, { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: CURRENT, seats: 1 });
  await expectAppError(
    editAs(admin, id, { starts_on: `${CURRENT}-01`, ends_on: lastDay(CURRENT), vip_capacity: 0 }),
    'BATCH_CAPACITY_BELOW_OCCUPANCY', 'shrinking below occupancy');
});

// ── A rename must disturb nothing keyed on identity ──────────────────────────

test('a code rename preserves the uuid, the VIP space AND its slug, the ledger, and access', async () => {
  const id = await batch(NEXT, { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: NEXT, seats: 1 });

  const vipSpaceBefore = await spaceIdFor('vip', NEXT);
  const seatsBefore = await runSql(
    `select id::text, status, batch_id::text from public.batch_entitlements
      where user_id = '${vip.id}'::uuid order by batch_index`);
  const accessBefore = await runSql(
    `select batch_id::text from public.user_entitled_batches('${vip.id}'::uuid) order by batch_id`);

  // A code the batch can move to without crossing anything: it is the only batch.
  const renamed = ym(4);
  const { data, error } = await editAs(admin, id, {
    code: renamed, name: `Renamed ${renamed}`,
    starts_on: `${NEXT}-01`, ends_on: lastDay(NEXT),
  });
  assert.equal(error, null, error && error.message);
  assert.equal(data.code_changed, true);

  assert.equal(await sqlScalar(`select code from public.batches where id = '${id}'::uuid`), renamed);
  assert.equal(await sqlScalar(`select count(*)::int from public.batches where id = '${id}'::uuid`), 1,
    'the uuid is the same row');

  // ★ The slug is a permalink. ?space=vip-<oldcode> bookmarks must keep working,
  // and pickInitialSpace() falls back SILENTLY on an unknown slug — so a renamed
  // slug would send members to the wrong space with nothing to notice.
  const spaceRows = await runSql(
    `select kind, slug, name, id::text from public.community_spaces
      where batch_id = '${id}'::uuid order by kind`);
  assert.deepEqual(spaceRows.map(s => s.slug), [`vip-${NEXT}`],
    '#39: one space per batch, and its slug is frozen at creation');
  assert.equal(spaceRows[0].id, vipSpaceBefore, 'same vip space row');
  // …but the NAME, which is what a member reads, follows the batch. Plain
  // hyphen, not an em dash — that is what batches_create_spaces() and
  // admin_update_batch() both write ('VIP - ' || name).
  assert.equal(spaceRows[0].name, `VIP - Renamed ${renamed}`);
  assert.equal(data.spaces_renamed, 1);

  const seatsAfter = await runSql(
    `select id::text, status, batch_id::text from public.batch_entitlements
      where user_id = '${vip.id}'::uuid order by batch_index`);
  assert.deepEqual(seatsAfter, seatsBefore, 'not one ledger row moved');

  const accessAfter = await runSql(
    `select batch_id::text from public.user_entitled_batches('${vip.id}'::uuid) order by batch_id`);
  assert.deepEqual(accessAfter, accessBefore, 'the member reads exactly the same batches');

  const { data: spaces } = await vip.db.rpc('my_community_spaces');
  assert.ok((spaces || []).some(s => s.slug === `vip-${NEXT}`),
    'the member still resolves their private space by its original slug');
});

test('an edit is audited with before and after', async () => {
  const id = await batch(CURRENT);
  await editOk(id, { name: 'Audited name', vip_capacity: 7 });
  const ev = await runSql(
    `select action, detail from public.batch_events
      where batch_id = '${id}'::uuid and action = 'edit' order by created_at desc limit 1`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.before.name, `Batch ${CURRENT}`);
  assert.equal(ev[0].detail.after.name, 'Audited name');
  assert.equal(ev[0].detail.after.vip_capacity, 7);
});

test('correcting a start date moves only seats that have NOT started', async () => {
  // The batch runs in the future, so its seat is sold but not yet active.
  const id = await batch(NEXT, { startsOn: `${NEXT}-01` });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: NEXT, seats: 1 });

  const before = await sqlScalar(
    `select count(*)::int from public.batch_entitlements
      where batch_id = '${id}'::uuid and activates_at > now()`);
  assert.equal(before, 1, 'the seat has not activated yet');

  const { data } = await editAs(admin, id, {
    code: NEXT, name: `Batch ${NEXT}`, starts_on: `${NEXT}-15`, ends_on: lastDay(NEXT),
  });
  assert.equal(data.activations_shifted, 1);
  assert.equal(
    await sqlScalar(`select activates_at::date::text from public.batch_entitlements
                      where batch_id = '${id}'::uuid limit 1`),
    `${NEXT}-15`, 'the not-yet-started seat follows the corrected date');
});

// ── The month-end sweep ──────────────────────────────────────────────────────

test('close_due_batches closes only OPEN batches whose period has ended', async () => {
  await batch(PRIOR);                                  // open + due
  await batch(CURRENT);                                // open + running
  await batch(ym(-3), { status: 'archived' });         // already archived
  const res = await runSql('select public.close_due_batches() as r');
  const out = res[0].r;

  assert.equal(out.closed, 1, 'exactly the due one');
  assert.deepEqual(out.batches.map(b => b.code), [PRIOR]);
  assert.equal(await sqlScalar(`select status from public.batches where code = '${PRIOR}'`), 'closed');
  assert.equal(await sqlScalar(`select close_reason from public.batches where code = '${PRIOR}'`), 'auto');
  assert.equal(await sqlScalar(`select status from public.batches where code = '${CURRENT}'`), 'open',
    'a running batch is left alone');
  assert.equal(await sqlScalar(`select status from public.batches where code = '${ym(-3)}'`), 'archived',
    'the sweep NEVER archives, and never un-archives');
});

test('the sweep is idempotent — a repeat run closes nothing and writes no new events', async () => {
  await batch(PRIOR);
  const first = (await runSql('select public.close_due_batches() as r'))[0].r;
  assert.equal(first.closed, 1);
  const eventsAfterFirst = await sqlScalar(
    `select count(*)::int from public.batch_events where action = 'auto_close'`);

  const second = (await runSql('select public.close_due_batches() as r'))[0].r;
  assert.equal(second.closed, 0, 'nothing left to do');
  assert.deepEqual(second.batches, []);
  assert.equal(
    await sqlScalar(`select count(*)::int from public.batch_events where action = 'auto_close'`),
    eventsAfterFirst, 'no duplicate audit row');
});

test('automatic closure does not revoke an existing member’s access or seats', async () => {
  await batch(PRIOR, { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: PRIOR, seats: 1 });

  const accessBefore = await runSql(
    `select batch_id::text, segment from public.user_entitled_batches('${vip.id}'::uuid) order by batch_id`);
  const spacesBefore = await vip.db.rpc('my_community_spaces');

  await runSql('select public.close_due_batches()');

  const accessAfter = await runSql(
    `select batch_id::text, segment from public.user_entitled_batches('${vip.id}'::uuid) order by batch_id`);
  assert.deepEqual(accessAfter, accessBefore, 'entitlements are untouched by closure');

  const spacesAfter = await vip.db.rpc('my_community_spaces');
  assert.deepEqual(
    (spacesAfter.data || []).map(s => s.slug).sort(),
    (spacesBefore.data || []).map(s => s.slug).sort(),
    'the private community stays reachable after the batch closes');
});

test('a closed batch refuses NEW assignments but not an existing member’s renewal', async () => {
  await batch(PRIOR, { startsOn: STARTED });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: PRIOR, seats: 1 });
  await runSql('select public.close_due_batches()');
  const id = await sqlScalar(`select id::text from public.batches where code = '${PRIOR}'`);

  // A member who does NOT hold a seat there cannot be assigned into it.
  await seedMember(member, { planKey: 'vip', days: 180 });
  await expectAppError(
    admin.db.rpc('admin_assign_batch', { p_user_ids: [member.id], p_batch_id: id }),
    'BATCH_CLOSED', 'assigning into a closed batch');

  // The existing seat-holder's renewal still lands — grant_batch_run's carve-out.
  const renew = await runSql(`
    select public.grant_batch_run(
      '${vip.id}'::uuid, 'vip', '${id}'::uuid, 1, 'renewal',
      null, 'vip', null, null, now() + interval '180 days', null, true) as r`);
  assert.equal(renew[0].r.ok, true, 'an existing member renews into their own closed batch');
});

// ── Who may run the sweep ────────────────────────────────────────────────────

test('close_due_batches is unreachable from a client JWT; the admin wrapper is the way in', async () => {
  await batch(PRIOR);
  const { error } = await admin.db.rpc('close_due_batches');
  assert.ok(error, 'even an admin JWT cannot call the raw sweep');
  // Assert the SHAPE, not merely that something failed: a bare assert.ok(error)
  // would also pass if the function had never been created or had been renamed,
  // i.e. it would not be testing the revoke it is named for.
  assert.match(
    `${error.code || ''} ${error.message || ''}`,
    /42501|permission denied|not allowed/i,
    `expected a privilege refusal, got ${error.code}: ${error.message}`);

  const { data, error: wrapErr } = await admin.db.rpc('admin_close_due_batches');
  assert.equal(wrapErr, null, wrapErr && wrapErr.message);
  assert.equal(data.closed, 1);

  await expectAppError(member.db.rpc('admin_close_due_batches'), 'FORBIDDEN',
    'a member running closures');
});
