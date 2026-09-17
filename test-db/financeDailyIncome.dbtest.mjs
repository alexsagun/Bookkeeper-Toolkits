// ─────────────────────────────────────────────────────────────────────────────
// test-db/financeDailyIncome.dbtest.mjs — #64 Daily Income, against the real stack.
// ─────────────────────────────────────────────────────────────────────────────
// The text suite (test/financeDailyIncomeSql.test.mjs) pins the SHAPE of the function. Only a
// database can settle what it actually returns, so this suite builds one month of books through
// the SAME writers production uses — the backfill (which dates a collection exactly as the
// approval hook does), finance_reverse_entry, finance_post_manual_entry, finance_reclassify_entry
// and a real Operations Admin approval — and asserts the report's figures AGAINST the P&L and the
// dashboard, not against numbers restated here alone.
//
// ★ HAND-BUILT ROWS ARE LIMITED TO WHAT NO WRITER CAN PRODUCE TODAY, and each one says why:
//   a second instalment event on one request, a retired plan key, a null plan key, and a
//   collection with no event. The report must still classify them correctly, because the schema
//   allows them.
//
// ★ FIGURES ARE COMPARED IN CENTAVOS (integers). PostgREST returns numeric(14,2) as a JSON number,
//   and 0.1 + 0.2 is not 0.3.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  makePersona, seedStaff, seedMember, clearStaff, expectAppError, expectDenied,
  resetShadow, resetFinance, runSql, anonClient, lit, sqlScalar,
} from './_harness.mjs';

const cents = (v) => Math.round(Number(v || 0) * 100);
const FN = 'finance_daily_income_report';

let superAdmin; let ops; let trainer; let revoked; let student;
let payerA; let payerB; let payerC; let payerD; let payerE;
let cashId; let incomeId; let income2Id; let otherIncomeId; let contraId;
const req = {};

async function approvedRequest(persona, planKey, planName, expected, paid, reviewedAt) {
  return sqlScalar(`
    with r as (
      insert into public.enrollment_requests
        (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status, reviewed_at)
      values ('${persona.id}'::uuid, ${lit(planKey)}, ${lit(planName)}, ${lit(persona.label)},
              ${lit(persona.email)}, ${expected}, ${paid}, 'approved', ${lit(reviewedAt)}::timestamptz)
      returning id)
    select id::text from r`);
}

const entryOf = (reqId) => sqlScalar(`select journal_entry_id::text from public.finance_payment_events
                                        where idempotency_key = 'enrollment:${reqId}:collection'`);

/** An enrollment collection event no writer creates today — entry, lines, THEN the event. */
async function handBuiltCollection({ date, amount, planKey, planName, requestId = null, key, withEvent = true }) {
  await runSql(`
    do $fixture$
    declare v_e uuid;
    begin
      insert into public.finance_journal_entries (entry_date, entry_kind, memo, source)
      values (${lit(date)}::date, 'collection', 'fixture', 'backfill') returning id into v_e;
      insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_e, 1, '${cashId}'::uuid, ${amount}, 0), (v_e, 2, '${incomeId}'::uuid, 0, ${amount});
      ${withEvent ? `
      insert into public.finance_payment_events
        (event_kind, direction, occurred_on, amount, journal_entry_id, idempotency_key,
         enrollment_request_id, plan_key, plan_name, method, source)
      values ('enrollment_collection', 'in', ${lit(date)}::date, ${amount}, v_e, ${lit(key)},
              ${requestId ? `'${requestId}'::uuid` : 'null'}, ${lit(planKey)}, ${lit(planName)}, 'unknown', 'backfill');` : ''}
    end
    $fixture$;`);
}

async function manual(kind, date, lines, key) {
  const { data, error } = await superAdmin.db.rpc('finance_post_manual_entry', {
    p_entry_date: date, p_entry_kind: kind, p_memo: 'fixture', p_lines: lines, p_idempotency_key: key,
  });
  assert.equal(error, null, error && error.message);
  return data;
}

async function reverse(entryId, date = null) {
  const args = { p_entry_id: entryId, p_reason: 'fixture correction' };
  if (date) args.p_reversal_date = date;
  const { data, error } = await superAdmin.db.rpc('finance_reverse_entry', args);
  assert.equal(error, null, error && error.message);
  return data;
}

async function report(month) {
  const { data, error } = await superAdmin.db.rpc(FN, month === undefined ? {} : { p_month: month });
  assert.equal(error, null, error && error.message);
  return data;
}

const dayOf = (r, iso) => r.days.find((d) => d.day === iso);

before(async () => {
  await resetShadow();
  await resetFinance();

  superAdmin = await makePersona('dly-super', { fullName: 'Daily Super' });
  ops = await makePersona('dly-ops', { fullName: 'Daily Ops' });
  trainer = await makePersona('dly-trainer', { fullName: 'Daily Trainer' });
  revoked = await makePersona('dly-revoked', { fullName: 'Daily Revoked' });
  student = await makePersona('dly-student', { fullName: 'Daily Student' });
  payerA = await makePersona('dly-payer-a', { fullName: 'Daily Payer A' });
  payerB = await makePersona('dly-payer-b', { fullName: 'Daily Payer B' });
  payerC = await makePersona('dly-payer-c', { fullName: 'Daily Payer C' });
  payerD = await makePersona('dly-payer-d', { fullName: 'Daily Payer D' });
  payerE = await makePersona('dly-payer-e', { fullName: 'Daily Payer E' });
  await seedStaff(superAdmin, 'super_admin');
  await seedStaff(ops, 'operations_admin');
  await seedStaff(trainer, 'trainer');
  await seedStaff(revoked, 'super_admin', 'revoked');
  await seedMember(student, { planKey: 'vip', days: 180 });

  cashId = await sqlScalar(`select id::text from public.finance_accounts where code = '1010'`);
  incomeId = await sqlScalar(`select id::text from public.finance_accounts where code = '4000'`);
  income2Id = await sqlScalar(`select id::text from public.finance_accounts where code = '4010'`);
  otherIncomeId = await sqlScalar(`select id::text from public.finance_accounts where code = '4040'`);
  contraId = await sqlScalar(`select id::text from public.finance_accounts where code = '4900'`);
  assert.ok(cashId && incomeId && income2Id && otherIncomeId && contraId, 'the #58 chart seed is missing');

  // ── June 2026 (Manila). Approved requests are posted by the BACKFILL, which dates a collection
  //    with the same expression as the approval hook: coalesce(reviewed_at, …) in the business zone.
  req.vip = await approvedRequest(payerA, 'vip', 'Personalized Coaching Program', 16999, 16999, '2026-06-03T02:00:00Z');
  // A PARTIAL payment: the catalog says ₱1,499, the student paid ₱700. The report must say ₱700.
  req.samplerPartial = await approvedRequest(payerA, 'sampler', 'Sampler Session', 1499, 700, '2026-06-03T05:00:00Z');
  req.silver = await approvedRequest(payerB, 'silver_self_paced', 'QBO + Resume Combo', 2999, 2999, '2026-06-10T03:00:00Z');
  // May, for the locked-period correction.
  req.may = await approvedRequest(payerC, 'sampler', 'Sampler Session', 1499, 1499, '2026-05-20T03:00:00Z');
  // The timezone boundary: 23:59:59 and 00:00:00 in Manila.
  req.lastSecondAug = await approvedRequest(payerD, 'silver_self_paced', 'QBO + Resume Combo', 2999, 2999, '2026-08-31T15:59:59Z');
  req.firstSecondSep = await approvedRequest(payerD, 'sampler', 'Sampler Session', 1499, 1499, '2026-08-31T16:00:00Z');

  const bf = await superAdmin.db.rpc('finance_backfill_enrollment_collections', { p_dry_run: false });
  assert.equal(bf.error, null, bf.error && bf.error.message);

  // No writer creates these today; the schema allows them, so the report must handle them.
  await handBuiltCollection({ date: '2026-06-20', amount: 799, planKey: 'sampler', planName: 'Sampler Session',
    requestId: req.samplerPartial, key: `fixture:${req.samplerPartial}:instalment-2` });
  await handBuiltCollection({ date: '2026-06-20', amount: 2000, planKey: 'gold_live', planName: 'Gold Live Group Track',
    key: 'fixture:legacy-gold' });
  await handBuiltCollection({ date: '2026-06-21', amount: 500, planKey: null, planName: null, key: 'fixture:null-plan' });
  // A SECOND nameless-key snapshot, under a DIFFERENT name. Grouping the Legacy/Other detail
  // list by plan_key alone collapsed these two into one line labelled with whichever name
  // sorted highest, so a retired package could disappear from the breakdown entirely while the
  // money still tied. Two distinct KEYS (above) never exercised that.
  await handBuiltCollection({ date: '2026-06-21', amount: 300, planKey: null,
    planName: 'Core Self-Paced (legacy)', key: 'fixture:null-plan-named' });
  await handBuiltCollection({ date: '2026-04-10', amount: 100, key: 'fixture:unlinked', withEvent: false });

  // Same-month reversal, then a later-month reversal and its own reversal.
  await reverse(await entryOf(req.silver), '2026-06-12');
  const vipRev = await reverse(await entryOf(req.vip), '2026-07-02');
  await reverse(vipRev.entry_id, '2026-07-05');

  await manual('refund', '2026-06-15', [
    { account_id: contraId, debit: 500, credit: 0 }, { account_id: cashId, debit: 0, credit: 500 }], 'dly-refund');
  await manual('collection', '2026-06-16', [
    { account_id: cashId, debit: 1000, credit: 0 }, { account_id: otherIncomeId, debit: 0, credit: 1000 }], 'dly-other');
  await manual('opening_balance', '2026-06-17', [
    { account_id: cashId, debit: 200, credit: 0 }, { account_id: otherIncomeId, debit: 0, credit: 200 }], 'dly-opening');

  const rc = await superAdmin.db.rpc('finance_reclassify_entry', {
    p_entry_id: await entryOf(req.samplerPartial), p_from_account_id: incomeId, p_to_account_id: income2Id,
    p_reason: 'fixture reclass', p_idempotency_key: 'dly-reclass' });
  assert.equal(rc.error, null, rc.error && rc.error.message);
});

after(async () => {
  await clearStaff(revoked);
  await resetFinance();
});

// ── June: every bucket, every count, and the reconciliation ──────────────────
test('June: packages use the posted amounts and the plan snapshot, never the catalog price', async () => {
  const r = await report('2026-06-15');
  assert.equal(r.month, '2026-06');
  assert.equal(r.basis, 'cash');
  assert.equal(r.days.length, 30);
  assert.deepEqual(r.plans.map((p) => p.key), ['sampler', 'silver_self_paced', 'vip'],
    'exactly the three catalog plans, in catalog order — never Gold, Core or an Essentials column');

  const t = r.totals;
  assert.equal(cents(t.plans.vip.gross), 1699900);
  assert.equal(cents(t.plans.sampler.gross), 70000 + 79900, 'a partial payment and its instalment, not 2 × ₱1,499');
  assert.equal(t.plans.sampler.collections, 2);
  assert.equal(cents(t.plans.silver_self_paced.gross), 299900);
  assert.equal(cents(t.plans.silver_self_paced.reversals), -299900, 'the same-month reversal is a correction');
  assert.equal(cents(t.plans.silver_self_paced.net), 0);

  assert.equal(r.has_legacy, true);
  assert.equal(cents(t.legacy_other.gross), 280000, 'the retired key and both nameless-key rows are ONE Legacy/Other bucket');
  assert.ok(!r.plans.some((p) => p.key === 'gold_live'), 'a retired key never becomes a column');
  // The detail list is per NAME, not per key: two different snapshot names sharing a key (here,
  // two rows with a null plan_key) stay two lines. Ordered by name, nulls last.
  assert.deepEqual(r.legacy_plans.map((p) => [p.plan_key, p.plan_name, cents(p.gross)]), [
    [null, 'Core Self-Paced (legacy)', 30000],
    ['gold_live', 'Gold Live Group Track', 200000],
    [null, null, 50000],
  ], 'a retired package must not vanish from the breakdown by sharing a key with another');

  assert.equal(cents(t.gross_collections), 1699900 + 149900 + 299900 + 280000);
  assert.equal(cents(t.enrollment_reversals), -299900);
  assert.equal(cents(t.refunds), -50000, 'the refund is its own signed bucket, not attributed to a package');
  assert.equal(cents(t.other_income), 100000);
  assert.equal(cents(t.adjustments), 20000, 'an opening balance on an income account is an adjustment, not income from sales');
  assert.equal(cents(t.net_cash_income), 2199800);

  assert.equal(t.collections, 7, 'payment events');
  // distinct_enrollments is count(distinct coalesce(enrollment_request_id, event_id)), so the two
  // instalments on req.samplerPartial collapse to ONE — and each request-LESS collection counts as
  // its own, rather than every null request collapsing into a single phantom enrollment. Six here:
  // four real requests + the two hand-built request-less legacy rows.
  assert.equal(t.distinct_enrollments, 6, 'two payments on one request are one enrollment');
  assert.equal(t.reversal_entries, 1);

  const d03 = dayOf(r, '2026-06-03');
  assert.equal(d03.collections, 2);
  assert.equal(d03.distinct_enrollments, 2);
  assert.equal(cents(d03.net_cash_income), 1699900 + 70000, 'the reclassification of that day nets to zero');
  assert.equal(cents(dayOf(r, '2026-06-12').enrollment_reversals), -299900, 'a reversal lands on its own date');
  assert.equal(t.best_day.day, '2026-06-03');

  assert.equal(r.reconciliation.reconciled, true);
  assert.equal(cents(r.reconciliation.difference), 0);
  assert.equal(r.reconciliation.unlinked_collection_entries, 0);
});

test('June reconciles to the cash-basis P&L and the dashboard, by construction', async () => {
  const r = await report('2026-06-01');
  const pl = await superAdmin.db.rpc('finance_cash_basis_pl', { p_from: '2026-06-01', p_to: '2026-06-30', p_group: 'total' });
  assert.equal(pl.error, null, pl.error && pl.error.message);
  const plIncome = pl.data.filter((row) => ['income', 'other_income'].includes(row.section))
    .reduce((a, row) => a + cents(row.amount), 0);
  assert.equal(cents(r.totals.net_cash_income), plIncome);

  const dash = await superAdmin.db.rpc('finance_dashboard_summary', { p_from: '2026-06-01', p_to: '2026-06-30' });
  assert.equal(dash.error, null, dash.error && dash.error.message);
  assert.equal(cents(r.totals.net_cash_income), cents(dash.data.verified_collections));
});

test('a later-month reversal never removes the original from its own month', async () => {
  const june = await report('2026-06-01');
  assert.equal(cents(june.totals.plans.vip.gross), 1699900, 'June keeps the VIP collection');
  assert.equal(cents(june.totals.plans.vip.reversals), 0);

  const july = await report('2026-07-01');
  assert.equal(cents(dayOf(july, '2026-07-02').plans.vip.reversals), -1699900, 'the reversal is on its own date, in July');
  assert.equal(cents(dayOf(july, '2026-07-05').plans.vip.reversals), 1699900, 'reversing the reversal is attributed to VIP too');
  assert.equal(cents(july.totals.net_cash_income), 0);
  assert.equal(july.totals.reversal_entries, 2);
  assert.equal(july.totals.best_day.day, '2026-07-05');
});

test('the business timezone decides the day, not UTC', async () => {
  const aug = await report('2026-08-01');
  assert.equal(cents(dayOf(aug, '2026-08-31').plans.silver_self_paced.gross), 299900, '23:59:59 Manila is still August 31');
  const sep = await report('2026-09-01');
  assert.equal(cents(dayOf(sep, '2026-09-01').plans.sampler.gross), 149900, '00:00:00 Manila is September 1');
});

test('a correction to a LOCKED month lands in the open month, and the closed month does not move', async () => {
  const may = await report('2026-05-01');
  assert.equal(cents(may.totals.plans.sampler.gross), 149900);

  const lock = await superAdmin.db.rpc('finance_lock_period', { p_period_key: '2026-05', p_note: 'fixture' });
  assert.equal(lock.error, null, lock.error && lock.error.message);
  const out = await reverse(await entryOf(req.may));
  assert.notEqual(out.period, '2026-05', 'a locked month cannot take the correction');

  const mayAfter = await report('2026-05-01');
  assert.equal(cents(mayAfter.totals.net_cash_income), 149900, 'the closed month is unchanged');
  const landed = await report(out.entry_date);
  assert.equal(cents(dayOf(landed, out.entry_date).plans.sampler.reversals), -149900);
  assert.equal(landed.reconciliation.reconciled, true);
});

test('a collection with no payment event is Other income, and the diagnostic counts it', async () => {
  const apr = await report('2026-04-01');
  assert.equal(cents(apr.totals.other_income), 10000);
  assert.equal(cents(apr.totals.gross_collections), 0);
  assert.equal(apr.reconciliation.unlinked_collection_entries, 1);
  assert.equal(apr.reconciliation.reconciled, true);
});

test('an Operations Admin approval appears exactly once, however often it is repeated', async () => {
  const reqId = await sqlScalar(`
    with r as (
      insert into public.enrollment_requests
        (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status)
      values ('${payerE.id}'::uuid, 'silver_self_paced', 'QBO + Resume Combo', 'Daily Payer E',
              ${lit(payerE.email)}, 2999, 1500, 'pending_review')
      returning id)
    select id::text from r`);
  // Silver, not VIP: a VIP approval needs an open cohort batch, which is not what this test is about.
  const approve = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  assert.equal(approve.error, null, approve.error && approve.error.message);
  const again = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  assert.equal(again.data?.already, true, 'the second approval is an idempotent no-op');
  await superAdmin.db.rpc('finance_backfill_enrollment_collections', { p_dry_run: false });

  const date = await sqlScalar(`select occurred_on::text from public.finance_payment_events
                                 where idempotency_key = 'enrollment:${reqId}:collection'`);
  const r = await report(date);
  const day = dayOf(r, date);
  assert.equal(day.plans.silver_self_paced.collections, 1, 'one approval, one collection');
  assert.equal(cents(day.plans.silver_self_paced.gross), 150000, 'the amount paid, not the ₱2,999 catalog price');
  assert.equal(r.reconciliation.reconciled, true);
});

// ── Calendar and bounds ───────────────────────────────────────────────────────
test('every calendar day is present, including leap days and empty months', async () => {
  assert.equal((await report('2024-02-01')).days.length, 29);
  assert.equal((await report('2026-02-01')).days.length, 28);
  const empty = await report('2023-06-01');
  assert.equal(empty.days.length, 30);
  assert.ok(empty.days.every((d) => cents(d.net_cash_income) === 0 && d.collections === 0));
  assert.equal(empty.totals.best_day, null, 'no strongest day in a month with no income');
  assert.equal(empty.reconciliation.reconciled, true);
  assert.equal(empty.days[0].isodow, 4, '2023-06-01 was a Thursday');
});

test('no month defaults to the current business month; out-of-range months are refused', async () => {
  const now = await report();
  const manila = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
  assert.equal(now.month, manila);
  assert.equal(now.timezone, 'Asia/Manila');

  const early = await superAdmin.db.rpc(FN, { p_month: '2019-12-01' });
  assert.equal(early.error?.code, '22023');
  const [y, m] = now.max_month.split('-').map(Number);
  const beyond = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  const late = await superAdmin.db.rpc(FN, { p_month: beyond });
  assert.equal(late.error?.code, '22023');
});

test('the report carries no student identity', async () => {
  const r = await report('2026-06-01');
  const walk = (v, path) => {
    if (typeof v === 'string') {
      assert.ok(!/@/.test(v), `${path} looks like an email`);
      assert.ok(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v), `${path} is a uuid`);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        assert.ok(!/email|user_id|full_name|payee|memo|reference|request_id|entry_id/i.test(k), `${path}.${k} is an identity field`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(r, 'report');
});

// ── Who may read it ───────────────────────────────────────────────────────────
for (const [label, who] of [['an Operations Admin', () => ops], ['a Trainer', () => trainer],
  ['a revoked Super Admin', () => revoked], ['a paying VIP student', () => student]]) {
  test(`${label} is refused the report`, async () => {
    await expectAppError(who().db.rpc(FN, { p_month: '2026-06-01' }), 'FORBIDDEN', `${label} read the daily income`);
    // Even an out-of-range month must answer FORBIDDEN: bounds are never probed before the guard.
    await expectAppError(who().db.rpc(FN, { p_month: '2019-01-01' }), 'FORBIDDEN', `${label} probed the bounds`);
  });
}

test('an anonymous visitor cannot execute the report', async () => {
  await expectDenied(anonClient().rpc(FN, { p_month: '2026-06-01' }), 'anon daily income');
});
