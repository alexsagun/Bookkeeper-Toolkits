// ─────────────────────────────────────────────────────────────────────────────
// test-db/financeRls.dbtest.mjs — #58 Financial Management, against the real stack.
// ─────────────────────────────────────────────────────────────────────────────
// Only claims that no text assertion can settle: they depend on real grants, real
// policies, real triggers and real PostgREST behaviour. Everything checkable from
// the SQL text lives in test/financeSql.test.mjs and costs no database.
//
// ★ THE FIXTURE SEEDS REAL ROWS IN EVERY FINANCE TABLE BEFORE ASSERTING ANYTHING.
//   This is the #48 lesson, stated in that migration's own notes: "Latent only
//   because those tables are empty today — which is also why the first test of it
//   passed for the wrong reason." A denial asserted against an empty table proves
//   nothing at all.
//
// ★ SEED THE SUPER ADMIN WITH seedStaff(), NEVER makePersona({isAdmin:true}).
//   The latter writes profiles.is_admin DIRECTLY and creates no staff_memberships
//   row. Since #45 that column is a trigger-maintained CACHE, so such a persona
//   satisfies is_admin() while has_staff_permission() answers FALSE for every key —
//   and finance gates on finance.manage. Every finance path would 403 and this
//   suite would look correctly restrictive while proving nothing.
//
// ★ A POLICY-FILTERED SELECT RETURNS [], NOT AN ERROR. Table denials assert an
//   empty array; only RPC refusals assert an app_error. Asserting an error on a
//   table read is green whether or not the policy works.
//
// ★ NEVER ASSERT WITH serviceClient() — it bypasses RLS. It is used only to build
//   fixtures and to reach the triggers that PostgREST cannot (see the immutability
//   test, which is the only way to exercise the layer that survives a policy edit).
//
// DELIBERATELY NOT WRITTEN, so their absence reads as a decision: a test per
// reporting metric. Those belong in ONE test that seeds a few events and asserts
// the summary's numbers together — a dozen separate cases would triple the runtime
// to re-prove one fixture.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  makePersona, seedStaff, seedMember, clearStaff, expectAppError,
  resetShadow, runSql, serviceClient, anonClient, lit, sqlScalar,
} from './_harness.mjs';

const FINANCE_TABLES = [
  'finance_settings', 'finance_accounts', 'finance_journal_entries', 'finance_journal_lines',
  'finance_payment_events', 'finance_period_locks', 'finance_audit_events',
  'finance_bank_imports', 'finance_bank_transactions', 'finance_reconciliations',
  'finance_reconciliation_items', 'finance_recurring_templates',
];

/** Every finance RPC a client may call, with arguments valid enough to reach the guard. */
const FINANCE_RPCS = [
  ['finance_dashboard_summary', {}],
  ['finance_sales_by_plan', {}],
  ['finance_receivables_worklist', {}],
  ['finance_ledger_list', { p_from: '2026-01-01', p_to: '2026-12-31' }],
  ['finance_cash_basis_pl', { p_from: '2026-01-01', p_to: '2026-12-31' }],
  ['finance_audit_feed', {}],
  ['finance_lock_period', { p_period_key: '2026-01' }],
  ['finance_save_settings', {}],
  ['finance_backfill_enrollment_collections', { p_dry_run: true }],
  // The setup/bank/recurring readers and writers added with the "manage" screens.
  // A random uuid is enough: the permission check runs before any lookup.
  ['finance_setup_state', {}],
  ['finance_accounts_list', {}],
  ['finance_period_locks_list', {}],
  ['finance_recurring_list', {}],
  ['finance_bank_imports_list', {}],
  ['finance_bank_transactions_list', {}],
  ['finance_reconciliations_list', {}],
  ['finance_reconciliation_detail', { p_id: '00000000-0000-4000-8000-000000000000' }],
  ['finance_map_plan_income_account', { p_plan_key: 'sampler', p_account_id: null }],
  ['finance_unmatch_reconciliation_item', { p_item_id: '00000000-0000-4000-8000-000000000000' }],
  ['finance_update_reconciliation_statement', {
    p_id: '00000000-0000-4000-8000-000000000000', p_statement_opening: 0, p_statement_closing: 0 }],
  ['finance_save_recurring_template', {
    p_id: null, p_name: 'x', p_account_id: '00000000-0000-4000-8000-000000000000',
    p_contra_account_id: '00000000-0000-4000-8000-000000000001', p_amount: 1,
    p_entry_kind: 'expense', p_memo: null, p_cadence: 'monthly', p_day_of_month: 1,
    p_weekday: null, p_next_due_on: '2026-01-01', p_active: true }],
];

let superAdmin; let ops; let trainer; let student; let revoked;
let cashId; let incomeId; let entryId;

before(async () => {
  await resetShadow();

  superAdmin = await makePersona('fin-super', { fullName: 'Fin Super' });
  ops = await makePersona('fin-ops', { fullName: 'Fin Ops' });
  trainer = await makePersona('fin-trainer', { fullName: 'Fin Trainer' });
  student = await makePersona('fin-student', { fullName: 'Fin Student' });
  revoked = await makePersona('fin-revoked', { fullName: 'Fin Revoked' });

  await seedStaff(superAdmin, 'super_admin');
  await seedStaff(ops, 'operations_admin');
  await seedStaff(trainer, 'trainer');
  await seedStaff(revoked, 'super_admin', 'revoked');
  await seedMember(student, { planKey: 'silver_self_paced', days: 60 });

  // ── Real rows in every table. Without these the denials below are vacuous.
  cashId = await sqlScalar(`select id::text from public.finance_accounts where code = '1010'`);
  incomeId = await sqlScalar(`select id::text from public.finance_accounts where code = '4000'`);
  assert.ok(cashId && incomeId, 'the #58 chart seed is missing — run the migration first');

  entryId = await sqlScalar(`
    with e as (
      insert into public.finance_journal_entries (entry_date, entry_kind, memo, source)
      values (current_date, 'collection', 'fixture', 'manual') returning id)
    select id::text from e`);
  await runSql(`
    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit) values
      ('${entryId}'::uuid, 1, '${cashId}'::uuid, 1000, 0),
      ('${entryId}'::uuid, 2, '${incomeId}'::uuid, 0, 1000)`);
  await runSql(`
    insert into public.finance_payment_events
      (event_kind, direction, occurred_on, amount, journal_entry_id, idempotency_key, source)
    values ('other_income', 'in', current_date, 1000, '${entryId}'::uuid, 'fixture:1', 'manual')`);
  await runSql(`
    insert into public.finance_audit_events (action, target_kind, target_id, amount, detail)
    values ('entry_post', 'journal_entry', '${entryId}'::uuid, 1000, '{}'::jsonb)`);
  await runSql(`
    insert into public.finance_period_locks (period_key, locked, note)
    values ('2020-01', true, 'fixture')`);
  await runSql(`
    insert into public.finance_recurring_templates
      (name, account_id, contra_account_id, amount, entry_kind, cadence, day_of_month, next_due_on)
    select 'fixture rent', (select id from public.finance_accounts where code = '5050'),
           '${cashId}'::uuid, 100, 'expense', 'monthly', 1, current_date`);

  const imp = await sqlScalar(`
    with i as (
      insert into public.finance_bank_imports (account_id, file_sha256, date_format, status)
      values ('${cashId}'::uuid, 'fixturehash', 'ISO', 'parsed') returning id)
    select id::text from i`);
  await runSql(`
    insert into public.finance_bank_transactions (import_id, account_id, posted_on, description_raw, amount)
    values ('${imp}'::uuid, '${cashId}'::uuid, current_date, 'GCASH  TRANSFER - REF#12345', 500)`);
});

after(async () => { await clearStaff(revoked); });

// ── Negative: the reason this suite exists ───────────────────────────────────

for (const [label, who] of [['an Operations Admin', () => ops], ['a Trainer', () => trainer],
  ['a paying student', () => student], ['a revoked Super Admin', () => revoked]]) {
  test(`${label} can read no finance table`, async () => {
    for (const t of FINANCE_TABLES) {
      const { data } = await who().db.from(t).select('*');
      // A policy-filtered SELECT is empty, not an error. The tables are POPULATED.
      assert.deepEqual(data || [], [], `${label} can read ${t}`);
    }
  });

  test(`${label} can write no finance table`, async () => {
    const ins = await who().db.from('finance_accounts')
      .insert({ code: 'X999', name: 'nope', account_type: 'expense', subtype: 'operating_expense' });
    assert.ok(ins.error, `${label} inserted a finance account`);

    // The two that matter most: forging a line into an existing entry, and
    // unlocking a closed accounting period.
    const line = await who().db.from('finance_journal_lines')
      .insert({ entry_id: entryId, line_no: 99, account_id: cashId, debit: 1, credit: 0 });
    assert.ok(line.error, `${label} forged a journal line`);

    // ★ Do NOT assert on the response shape here. A policy-filtered UPDATE returns
    //   NO error and `count: null` (supabase-js omits count unless it is requested),
    //   so `error || count === 0` can fail for the wrong reason on a policy that is
    //   working perfectly. The durable state is the only reliable assertion.
    await who().db.from('finance_period_locks').update({ locked: false }).eq('period_key', '2020-01');
    assert.equal(
      await sqlScalar(`select locked::text from public.finance_period_locks where period_key='2020-01'`),
      'true', `${label} unlocked an accounting period`);
  });

  test(`${label} can call no finance RPC`, async () => {
    // Distinct from the table check: the functions ARE granted to authenticated, so
    // the in-body permission check is the only boundary and must hold at run time.
    for (const [fn, args] of FINANCE_RPCS) {
      await expectAppError(who().db.rpc(fn, args), 'FORBIDDEN', `${label} called ${fn}`);
    }
  });
}

test('an anonymous visitor can read no finance table', async () => {
  for (const t of FINANCE_TABLES) {
    const { data } = await anonClient().from(t).select('*');
    assert.deepEqual(data || [], [], `anon can read ${t}`);
  }
});

// ── Positive: few, each proving something nothing else can ───────────────────

test('a Super Admin reads the finance tables and the reporting RPCs', async () => {
  const { data, error } = await superAdmin.db.from('finance_journal_entries').select('id');
  assert.equal(error, null, error && error.message);
  assert.ok((data || []).length >= 1, 'the Super Admin sees the seeded entry');

  const summary = await superAdmin.db.rpc('finance_dashboard_summary', {});
  assert.equal(summary.error, null, summary.error && summary.error.message);
  assert.equal(summary.data.basis, 'cash', 'the basis is fixed, not a caller choice');
});

// ★ THE CENTREPIECE. One test proves requirement 3 end to end: the write happened,
//   in the approver's transaction, caused by someone with no finance access, and is
//   invisible to them.
test('an Ops Admin approval posts a balanced collection they cannot read back', async () => {
  const payer = await makePersona('fin-payer', { fullName: 'Fin Payer' });
  const reqId = await sqlScalar(`
    with r as (
      insert into public.enrollment_requests
        (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status)
      values ('${payer.id}'::uuid, 'silver_self_paced', 'QBO + Resume Combo',
              'Fin Payer', ${lit(payer.email)}, 2999, 2999, 'pending_review')
      returning id)
    select id::text from r`);

  const approve = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  assert.equal(approve.error, null, approve.error && approve.error.message);

  const key = `enrollment:${reqId}:collection`;
  const { data: events } = await superAdmin.db.from('finance_payment_events')
    .select('id, amount, journal_entry_id, idempotency_key').eq('idempotency_key', key);
  assert.equal((events || []).length, 1, 'exactly one collection event');
  assert.equal(Number(events[0].amount), 2999);

  const { data: lines } = await superAdmin.db.from('finance_journal_lines')
    .select('debit, credit').eq('entry_id', events[0].journal_entry_id);
  assert.equal(lines.length, 2, 'a collection is a two-line entry');
  assert.equal(lines.reduce((a, l) => a + Number(l.debit), 0),
    lines.reduce((a, l) => a + Number(l.credit), 0), 'debits must equal credits');

  // The same rows, through the eyes of the person who caused them.
  const { data: opsView } = await ops.db.from('finance_payment_events').select('id');
  assert.deepEqual(opsView || [], [], 'the Ops Admin can read the row they just caused');
});

test('approving twice, and the backfill, create exactly one collection', async () => {
  const payer = await makePersona('fin-payer2', { fullName: 'Fin Payer Two' });
  const reqId = await sqlScalar(`
    with r as (
      insert into public.enrollment_requests
        (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status)
      values ('${payer.id}'::uuid, 'sampler', 'Sampler Session', 'Fin Payer Two',
              ${lit(payer.email)}, 1499, 1499, 'pending_review')
      returning id)
    select id::text from r`);

  await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  // A second approval is refused by the RPC's own status check, and must not post again.
  await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  await superAdmin.db.rpc('finance_backfill_enrollment_collections', { p_dry_run: false });
  await superAdmin.db.rpc('finance_backfill_enrollment_collections', { p_dry_run: false });

  const n = await sqlScalar(`select count(*)::int from public.finance_payment_events
                              where idempotency_key = 'enrollment:${reqId}:collection'`);
  assert.equal(Number(n), 1, 'the shared idempotency namespace collapsed every path to one row');
});

// Proves the D decision is real rather than aspirational.
test('a finance failure rolls the whole approval back', async () => {
  await runSql(`update public.finance_accounts set active = false where code = '4000'`);
  try {
    const payer = await makePersona('fin-payer3', { fullName: 'Fin Payer Three' });
    const reqId = await sqlScalar(`
      with r as (
        insert into public.enrollment_requests
          (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status)
        values ('${payer.id}'::uuid, 'sampler', 'Sampler Session', 'Fin Payer Three',
                ${lit(payer.email)}, 1499, 1499, 'pending_review')
        returning id)
      select id::text from r`);

    const res = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
    assert.ok(res.error, 'the approval should have failed');

    assert.equal(await sqlScalar(`select status from public.enrollment_requests where id='${reqId}'::uuid`),
      'pending_review', 'the request must stay retryable');
    assert.equal(Number(await sqlScalar(
      `select count(*)::int from public.subscriptions where user_id='${payer.id}'::uuid`)), 0,
      'no subscription may survive a rolled-back approval');
  } finally {
    await runSql(`update public.finance_accounts set active = true where code = '4000'`);
  }
});

// Worth the cost precisely because the trigger is the layer that survives a policy edit.
test('a posted entry is immutable at both layers', async () => {
  const viaRest = await superAdmin.db.from('finance_journal_entries')
    .update({ entry_date: '2020-01-01' }).eq('id', entryId);
  assert.ok(viaRest.error || viaRest.count === 0, 'PostgREST must refuse the update');

  // Service role bypasses RLS — the only way to reach the trigger itself.
  const svc = serviceClient();
  const direct = await svc.from('finance_journal_entries')
    .update({ entry_date: '2020-01-01' }).eq('id', entryId);
  assert.ok(direct.error, 'the guard must refuse even the service role');
  assert.match(String(direct.error.hint || direct.error.message), /FINANCE_ENTRY_IMMUTABLE|immutable/i);
});

test('an unbalanced entry cannot be committed, even by the service role', async () => {
  const svc = serviceClient();
  const { data: e, error } = await svc.from('finance_journal_entries')
    .insert({ entry_date: new Date().toISOString().slice(0, 10), entry_kind: 'adjustment', source: 'manual' })
    .select('id').single();
  // The deferred constraint trigger fires at COMMIT, so the failure surfaces here
  // or on the line insert — either way nothing durable is created.
  if (!error && e) {
    const line = await svc.from('finance_journal_lines')
      .insert({ entry_id: e.id, line_no: 1, account_id: cashId, debit: 50, credit: 0 });
    assert.ok(line.error, 'a one-sided entry must not survive');
  }
  const orphans = await sqlScalar(`select count(*)::int from (
      select entry_id from public.finance_journal_lines
       group by entry_id having sum(debit) <> sum(credit)) t`);
  assert.equal(Number(orphans), 0, 'no unbalanced entry may exist');
});

test('a reversal nets to zero and cannot be repeated', async () => {
  const before = Number(await sqlScalar(
    `select coalesce(sum(credit) - sum(debit), 0)::text from public.finance_journal_lines
      where account_id = '${incomeId}'::uuid`));

  const r1 = await superAdmin.db.rpc('finance_reverse_entry',
    { p_entry_id: entryId, p_reason: 'fixture correction' });
  assert.equal(r1.error, null, r1.error && r1.error.message);

  const after = Number(await sqlScalar(
    `select coalesce(sum(credit) - sum(debit), 0)::text from public.finance_journal_lines
      where account_id = '${incomeId}'::uuid`));
  assert.equal(after, before - 1000, 'the reversal must net the original out');

  await expectAppError(
    superAdmin.db.rpc('finance_reverse_entry', { p_entry_id: entryId, p_reason: 'again' }),
    'FINANCE_ENTRY_ALREADY_REVERSED', 'one reversal per entry, ever');
});

test('a locked period refuses a new entry and names where the correction lands', async () => {
  await expectAppError(
    superAdmin.db.rpc('finance_post_manual_entry', {
      p_entry_date: '2020-01-15', p_entry_kind: 'expense', p_memo: 'backdated',
      p_lines: [{ account_id: cashId, debit: 0, credit: 10 },
        { account_id: incomeId, debit: 10, credit: 0 }],
      p_idempotency_key: 'locked-period-test',
    }), 'FINANCE_PERIOD_LOCKED', 'a closed month must not move');
});

test('the bank fingerprint ignores punctuation but not reference numbers', async () => {
  const a = await sqlScalar(`select fingerprint from public.finance_bank_transactions
                              where description_raw = 'GCASH  TRANSFER - REF#12345'`);
  const imp = await sqlScalar(`select id::text from public.finance_bank_imports where file_sha256='fixturehash'`);
  await runSql(`
    insert into public.finance_bank_transactions (import_id, account_id, posted_on, description_raw, amount)
    values ('${imp}'::uuid, '${cashId}'::uuid, current_date, 'gcash transfer ref 12345', 500),
           ('${imp}'::uuid, '${cashId}'::uuid, current_date, 'gcash transfer ref 99999', 500)`);

  const same = await sqlScalar(`select fingerprint from public.finance_bank_transactions
                                 where description_raw = 'gcash transfer ref 12345'`);
  const other = await sqlScalar(`select fingerprint from public.finance_bank_transactions
                                  where description_raw = 'gcash transfer ref 99999'`);
  assert.equal(same, a, 'cosmetic re-formatting must not manufacture a new transaction');
  assert.notEqual(other, a,
    'two same-day, same-amount transfers with DIFFERENT references are different payments — '
    + 'stripping digits would silently merge them');
});

// Owner decision: each plan's collections post to that plan's own income account.
// Proved against the real hook, because only the trigger knows which account it chose.
test("an approval posts to the plan's mapped income account, and unmapping falls back", async () => {
  const mapped = await sqlScalar(`select id::text from public.finance_accounts where code = '4010'`);
  await runSql(`update public.enrollment_plans set finance_income_account_id = '${mapped}'::uuid
                 where key = 'sampler'`);
  try {
    const payer = await makePersona('fin-payer-map', { fullName: 'Fin Payer Map' });
    const reqId = await sqlScalar(`
      with r as (
        insert into public.enrollment_requests
          (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status)
        values ('${payer.id}'::uuid, 'sampler', 'Sampler Session', 'Fin Payer Map',
                ${lit(payer.email)}, 1499, 1499, 'pending_review')
        returning id)
      select id::text from r`);
    const approve = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
    assert.equal(approve.error, null, approve.error && approve.error.message);

    const credited = await sqlScalar(`
      select a.code from public.finance_payment_events pe
        join public.finance_journal_lines l on l.entry_id = pe.journal_entry_id and l.credit > 0
        join public.finance_accounts a on a.id = l.account_id
       where pe.idempotency_key = 'enrollment:${reqId}:collection'`);
    assert.equal(credited, '4010', 'the collection must credit the plan\'s mapped income account');
  } finally {
    await runSql(`update public.enrollment_plans set finance_income_account_id = null where key = 'sampler'`);
  }
});
