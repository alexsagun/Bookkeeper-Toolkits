-- ═════════════════════════════════════════════════════════════════════════════
-- #64 — Financial Management: the Daily Income report
-- 2026-09-19
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- The legacy Apps Script finance app had a daily income table; Financial Management (#58/#59)
-- did not. The legacy version is not a model to copy: it matched packages by SUBSTRING across
-- five names (two of them retired, one of them a tagline rather than a plan), counted rows by a
-- status column that its own spreadsheet formulas did not apply, turned any unreadable amount
-- into zero, knew nothing about reversals or refunds, and a companion job posted a "Daily Sales"
-- summary row every night on top of the individual collections — which, here, would count every
-- approval twice.
--
-- WHAT
--
-- One reader, finance_daily_income_report(p_month), Super Admin only (finance.manage). No table,
-- no policy, no permission and no error code. It reads the LEDGER and nothing else:
--
--   • Income is sum(credit - debit) over income-account lines, dated by entry_date — exactly what
--     finance_cash_basis_pl and the dashboard's verified_collections compute, so the month equals the
--     cash-basis P&L's income + other income BY THAT SHARED DEFINITION (test-db pins the equality).
--     Every call also carries an INDEPENDENT ledger total, which proves something narrower: each
--     income entry landed in exactly one bucket (reconciliation.difference must be 0).
--   • Each entry lands in exactly one bucket, decided by the ROOT of its reversal chain:
--       enrollment   — the root carries an enrollment_collection payment event. The package is
--                      that event's plan snapshot, never the student's plan today. The root itself
--                      is a gross collection; a reversal of it is a signed correction on the
--                      reversal's OWN date, so the original is never removed from its day.
--       refunds      — the root is a refund entry. The ledger has no refund→enrollment link, so a
--                      refund is not attributed to a package. Reversing the collection instead is
--                      NOT a refund: finance_request_collected ignores a reversed collection, so the
--                      full price would show as owed again in Receivables and in reminders.
--       other income — the root is a collection with no enrollment event (manual, bank feed,
--                      recurring income).
--       adjustments  — income lines on any other kind of entry (an opening balance, a transfer).
--     An income→income reclassification nets to zero across its own lines and drops out.
--   • Package columns are enrollment_plans in catalog order (active plans, plus an inactive plan
--     only in a month it has money). A snapshot key with no catalog row — a retired package — is
--     shown once, in a Legacy/Other bucket, and never becomes a column or a sellable plan.
--   • Contract value and receivables are not income and are not read.
--
-- LOCKSTEP: this file ↔ bootstrap §51 ↔ src/lib/financeDailyIncome.js (the client column spec) ↔
-- FinanceDailyIncomeReport in src/BookkeeperPro.jsx ↔ test/financeDailyIncomeSql.test.mjs ↔
-- test-db/financeDailyIncome.dbtest.mjs ↔ the #64 block in scripts/audit-db.mjs.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-18-management-hardening.sql') then
    raise exception '#64: run db/2026-09-18-management-hardening.sql (#63) first.';
  end if;
  if to_regprocedure('public.finance_cash_basis_pl(date, date, text, uuid[], text, numeric, numeric)') is null
     or to_regclass('public.finance_payment_events') is null then
    raise exception '#64: #58 and #59 must be applied first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'enrollment_plans' and column_name = 'position')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'enrollment_plans' and column_name = 'active') then
    raise exception '#64: enrollment_plans.position and enrollment_plans.active are required.';
  end if;
  if (select count(*) from public.staff_permissions) <> 22 then
    raise exception '#64: expected 22 staff permissions (this file changes none).';
  end if;
end
$pre$;


-- == 1) The report ============================================================
--
-- ★ THE PERMISSION CHECK COMES FIRST, BEFORE THE MONTH IS EVEN VALIDATED. An unauthorized caller
--   must get FORBIDDEN, never a bounds message that tells them how far the books go back.
-- ★ ONE `at time zone`, on now(). entry_date is already a business-timezone date, stamped when
--   the entry was posted, so grouping by it is correct and never shifts with the session.
-- ★ THE CALENDAR IS INTEGERS. generate_series over dates and an interval resolves to timestamptz
--   and follows the session TimeZone; v_from + g cannot.
-- ★ A RESOLVED ROOT IS OPTIONAL. The chain walk is bounded; an entry whose root it cannot reach
--   falls back to itself (and lands in adjustments) rather than silently vanishing from the total.

create or replace function public.finance_daily_income_report(p_month date default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_tz        text;
  v_currency  text;
  v_today     date;
  v_min       constant date := date '2020-01-01';
  v_max       date;
  v_first     date;
  v_last      date;
  v_month     date;
  v_from      date;
  v_to        date;
  v_report    jsonb;
  v_ledger    numeric(14,2);
  v_unlinked  bigint;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;

  select coalesce(fs.reporting_timezone, 'Asia/Manila'), coalesce(fs.currency, 'PHP')
    into v_tz, v_currency
    from public.finance_settings fs where fs.id;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_currency := coalesce(v_currency, 'PHP');
  v_today := (now() at time zone v_tz)::date;

  select min(e.entry_date), max(e.entry_date) into v_first, v_last
    from public.finance_journal_entries e;

  -- The latest month that can hold an entry: the entry guard accepts today + 1.
  v_max := greatest(
    make_date(extract(year from v_today + 1)::int, extract(month from v_today + 1)::int, 1),
    case when v_last is null then null
         else make_date(extract(year from v_last)::int, extract(month from v_last)::int, 1) end);

  v_month := make_date(extract(year from coalesce(p_month, v_today))::int,
                       extract(month from coalesce(p_month, v_today))::int, 1);
  if v_month < v_min or v_month > v_max then
    raise exception 'finance_daily_income_report: choose a month from % to %',
      to_char(v_min, 'YYYY-MM'), to_char(v_max, 'YYYY-MM') using errcode = '22023';
  end if;
  v_from := v_month;
  v_to := make_date(extract(year from v_month + 32)::int, extract(month from v_month + 32)::int, 1) - 1;

  with recursive
  inc as (
    select e.id, e.entry_date, e.reverses_entry_id,
           sum(l.credit - l.debit)::numeric(14,2) as amt
      from public.finance_journal_entries e
      join public.finance_journal_lines l on l.entry_id = e.id
      join public.finance_accounts a on a.id = l.account_id and a.account_type = 'income'
     where e.entry_date between v_from and v_to
     group by e.id, e.entry_date, e.reverses_entry_id
    having sum(l.credit - l.debit) <> 0
  ),
  chain as (
    select i.id as leaf, i.id as node, i.reverses_entry_id as parent, 0 as depth
      from inc i
    union all
    select c.leaf, p.id, p.reverses_entry_id, c.depth + 1
      from chain c
      join public.finance_journal_entries p on p.id = c.parent
     where c.depth < 32
  ),
  roots as (
    select c.leaf, c.node as root_id from chain c where c.parent is null
  ),
  cls as (
    select i.id, i.entry_date, i.amt, r.id as root_id, r.entry_kind as root_kind,
           pe.id as event_id, pe.enrollment_request_id, pe.plan_key, pe.plan_name
      from inc i
      left join roots x on x.leaf = i.id
      join public.finance_journal_entries r on r.id = coalesce(x.root_id, i.id)
      left join public.finance_payment_events pe
        on pe.journal_entry_id = r.id and pe.event_kind = 'enrollment_collection'
  ),
  tagged as (
    select c.id, c.entry_date, c.amt, c.event_id, c.enrollment_request_id, c.plan_key, c.plan_name,
           (c.root_id = c.id) as is_original,
           case when c.event_id is not null then 'enrollment'
                when c.root_kind = 'refund' then 'refund'
                when c.root_kind = 'collection' then 'other_income'
                else 'adjustment' end as bucket,
           case when c.event_id is not null
                 and exists (select 1 from public.enrollment_plans ep0 where ep0.key = c.plan_key)
                then c.plan_key end as plan_col
      from cls c
  ),
  plan_cols as (
    select ep.key, ep.name, ep.tagline, ep.position, ep.active
      from public.enrollment_plans ep
     where ep.active
        or exists (select 1 from tagged t where t.bucket = 'enrollment' and t.plan_col = ep.key)
  ),
  cal as (
    select v_from + g as day from generate_series(0, v_to - v_from) as g
  ),
  plan_day as (
    select t.entry_date as day, t.plan_col as key,
           coalesce(sum(t.amt) filter (where t.is_original), 0)::numeric(14,2) as gross,
           coalesce(sum(t.amt) filter (where not t.is_original), 0)::numeric(14,2) as reversals,
           count(*) filter (where t.is_original) as collections
      from tagged t
     where t.bucket = 'enrollment' and t.plan_col is not null
     group by t.entry_date, t.plan_col
  ),
  legacy_day as (
    select t.entry_date as day,
           coalesce(sum(t.amt) filter (where t.is_original), 0)::numeric(14,2) as gross,
           coalesce(sum(t.amt) filter (where not t.is_original), 0)::numeric(14,2) as reversals,
           count(*) filter (where t.is_original) as collections
      from tagged t
     where t.bucket = 'enrollment' and t.plan_col is null
     group by t.entry_date
  ),
  day_tot as (
    select t.entry_date as day,
           coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and t.is_original), 0)::numeric(14,2) as gross_collections,
           coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and not t.is_original), 0)::numeric(14,2) as enrollment_reversals,
           coalesce(sum(t.amt) filter (where t.bucket = 'refund'), 0)::numeric(14,2) as refunds,
           coalesce(sum(t.amt) filter (where t.bucket = 'other_income'), 0)::numeric(14,2) as other_income,
           coalesce(sum(t.amt) filter (where t.bucket = 'adjustment'), 0)::numeric(14,2) as adjustments,
           coalesce(sum(t.amt), 0)::numeric(14,2) as net_cash_income,
           count(*) filter (where t.bucket = 'enrollment' and t.is_original) as collections,
           count(distinct coalesce(t.enrollment_request_id, t.event_id))
             filter (where t.bucket = 'enrollment' and t.is_original) as distinct_enrollments,
           count(*) filter (where t.bucket = 'enrollment' and not t.is_original) as reversal_entries
      from tagged t
     group by t.entry_date
  ),
  has_legacy as (
    select exists (select 1 from tagged t where t.bucket = 'enrollment' and t.plan_col is null) as yes
  )
  select jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'),
    'from', v_from,
    'to', v_to,
    'today', v_today,
    'timezone', v_tz,
    'currency', v_currency,
    'basis', 'cash',
    'min_month', to_char(v_min, 'YYYY-MM'),
    'max_month', to_char(v_max, 'YYYY-MM'),
    'first_entry_month', case when v_first is null then null else to_char(v_first, 'YYYY-MM') end,
    'scope', 'Cash actually posted to income accounts, by the date each entry was posted in the '
             || 'business timezone. Package columns hold enrollment collections net of their own '
             || 'reversals, attributed to the plan recorded when the payment was approved. Income '
             || 'recorded by hand (including a later instalment), from the bank feed or from a recurring '
             || 'template is Other income. Refunds are not linked to an enrollment, so they show under '
             || 'Refunds and not under a package; record a refund as a refund. Reverse a collection only '
             || 'to void one that should never have been recorded: a reversed collection no longer counts '
             || 'as paid, so its full price shows as outstanding again in Receivables. Contract value and '
             || 'receivables are not income. Figures in a month that is not locked can still change.',
    'plans', coalesce((select jsonb_agg(jsonb_build_object('key', pc.key, 'name', pc.name,
                        'tagline', pc.tagline, 'position', pc.position, 'active', pc.active)
                        order by pc.position, pc.key) from plan_cols pc), '[]'::jsonb),
    'has_legacy', (select yes from has_legacy),
    'legacy_plans', coalesce((
        select jsonb_agg(jsonb_build_object('plan_key', lp.plan_key, 'plan_name', lp.plan_name,
                 'gross', lp.gross, 'reversals', lp.reversals, 'net', (lp.gross + lp.reversals)::numeric(14,2),
                 'collections', lp.collections) order by lp.plan_name nulls last, lp.plan_key nulls last)
          from (select t.plan_key, t.plan_name,
                       coalesce(sum(t.amt) filter (where t.is_original), 0)::numeric(14,2) as gross,
                       coalesce(sum(t.amt) filter (where not t.is_original), 0)::numeric(14,2) as reversals,
                       count(*) filter (where t.is_original) as collections
                  from tagged t
                 where t.bucket = 'enrollment' and t.plan_col is null
                 group by t.plan_key, t.plan_name) lp), '[]'::jsonb),
    'days', (
      select jsonb_agg(jsonb_build_object(
               'day', d.day,
               'isodow', extract(isodow from d.day)::int,
               'plans', coalesce((
                   select jsonb_object_agg(pc.key, jsonb_build_object(
                            'gross', coalesce(pd.gross, 0)::numeric(14,2),
                            'reversals', coalesce(pd.reversals, 0)::numeric(14,2),
                            'net', (coalesce(pd.gross, 0) + coalesce(pd.reversals, 0))::numeric(14,2),
                            'collections', coalesce(pd.collections, 0)))
                     from plan_cols pc
                     left join plan_day pd on pd.key = pc.key and pd.day = d.day), '{}'::jsonb),
               'legacy_other', case when (select yes from has_legacy) then jsonb_build_object(
                            'gross', coalesce(ld.gross, 0)::numeric(14,2),
                            'reversals', coalesce(ld.reversals, 0)::numeric(14,2),
                            'net', (coalesce(ld.gross, 0) + coalesce(ld.reversals, 0))::numeric(14,2),
                            'collections', coalesce(ld.collections, 0)) end,
               'gross_collections', coalesce(dt.gross_collections, 0)::numeric(14,2),
               'enrollment_reversals', coalesce(dt.enrollment_reversals, 0)::numeric(14,2),
               'refunds', coalesce(dt.refunds, 0)::numeric(14,2),
               'other_income', coalesce(dt.other_income, 0)::numeric(14,2),
               'adjustments', coalesce(dt.adjustments, 0)::numeric(14,2),
               'net_cash_income', coalesce(dt.net_cash_income, 0)::numeric(14,2),
               'collections', coalesce(dt.collections, 0),
               'distinct_enrollments', coalesce(dt.distinct_enrollments, 0),
               'reversal_entries', coalesce(dt.reversal_entries, 0))
             order by d.day)
        from cal d
        left join day_tot dt on dt.day = d.day
        left join legacy_day ld on ld.day = d.day),
    'totals', (
      select jsonb_build_object(
               'plans', coalesce((
                   select jsonb_object_agg(pc.key, jsonb_build_object(
                            'gross', coalesce(pt.gross, 0)::numeric(14,2),
                            'reversals', coalesce(pt.reversals, 0)::numeric(14,2),
                            'net', (coalesce(pt.gross, 0) + coalesce(pt.reversals, 0))::numeric(14,2),
                            'collections', coalesce(pt.collections, 0)))
                     from plan_cols pc
                     left join (select pd.key, sum(pd.gross) as gross, sum(pd.reversals) as reversals,
                                       sum(pd.collections) as collections
                                  from plan_day pd group by pd.key) pt on pt.key = pc.key), '{}'::jsonb),
               'legacy_other', case when (select yes from has_legacy) then jsonb_build_object(
                            'gross', coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and t.plan_col is null and t.is_original), 0)::numeric(14,2),
                            'reversals', coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and t.plan_col is null and not t.is_original), 0)::numeric(14,2),
                            'net', coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and t.plan_col is null), 0)::numeric(14,2),
                            'collections', count(*) filter (where t.bucket = 'enrollment' and t.plan_col is null and t.is_original)) end,
               'gross_collections', coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and t.is_original), 0)::numeric(14,2),
               'enrollment_reversals', coalesce(sum(t.amt) filter (where t.bucket = 'enrollment' and not t.is_original), 0)::numeric(14,2),
               'refunds', coalesce(sum(t.amt) filter (where t.bucket = 'refund'), 0)::numeric(14,2),
               'other_income', coalesce(sum(t.amt) filter (where t.bucket = 'other_income'), 0)::numeric(14,2),
               'adjustments', coalesce(sum(t.amt) filter (where t.bucket = 'adjustment'), 0)::numeric(14,2),
               'net_cash_income', coalesce(sum(t.amt), 0)::numeric(14,2),
               'collections', count(*) filter (where t.bucket = 'enrollment' and t.is_original),
               'distinct_enrollments', count(distinct coalesce(t.enrollment_request_id, t.event_id))
                                         filter (where t.bucket = 'enrollment' and t.is_original),
               'reversal_entries', count(*) filter (where t.bucket = 'enrollment' and not t.is_original),
               'best_day', (select jsonb_build_object('day', b.day, 'net_cash_income', b.net_cash_income)
                              from day_tot b where b.net_cash_income > 0
                             order by b.net_cash_income desc, b.day asc limit 1))
        from tagged t)
  ) into v_report;

  -- The check total, computed WITHOUT the classification above. A join that dropped or
  -- double-counted an entry shows up here as a difference instead of a quietly wrong month.
  -- It proves the buckets are COMPLETE against the ledger. It does not compare with
  -- finance_cash_basis_pl: that equality holds by the shared definition and is pinned in test-db.
  select coalesce(sum(l.credit - l.debit), 0)::numeric(14,2) into v_ledger
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
    join public.finance_accounts a on a.id = l.account_id
   where a.account_type = 'income' and e.entry_date between v_from and v_to;

  -- Approval and backfill write the entry and its event in one transaction, so this is 0 unless
  -- something outside those paths wrote a collection. Such an entry is counted as Other income.
  select count(*) into v_unlinked
    from public.finance_journal_entries e
   where e.entry_date between v_from and v_to
     and e.entry_kind = 'collection' and e.source in ('approval', 'backfill')
     and not exists (select 1 from public.finance_payment_events pe where pe.journal_entry_id = e.id);

  return v_report || jsonb_build_object('reconciliation', jsonb_build_object(
    'ledger_income_total', v_ledger,
    'classified_total', (v_report #>> '{totals,net_cash_income}')::numeric(14,2),
    'difference', (v_ledger - (v_report #>> '{totals,net_cash_income}')::numeric(14,2))::numeric(14,2),
    'reconciled', v_ledger = (v_report #>> '{totals,net_cash_income}')::numeric(14,2),
    'unlinked_collection_entries', v_unlinked));
end;
$fn$;
revoke all on function public.finance_daily_income_report(date) from public, anon, authenticated;
grant execute on function public.finance_daily_income_report(date) to authenticated;

comment on function public.finance_daily_income_report(date) is
  'Cash basis, by posting date in the business timezone. A MANAGEMENT report. Reads only the '
  'journal and the payment-event plan snapshot: never a catalog price, never a request amount. '
  'Its month total equals finance_cash_basis_pl income + other_income for the same dates.';


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-19-finance-daily-income.sql', null,
  'finance daily income (#64): finance_daily_income_report(p_month), a Super Admin (finance.manage) '
  'reader over the ledger. Income is sum(credit - debit) on income-account lines by entry_date (the '
  'cash-basis P&L definition), and every call carries an independent ledger total proving each income '
  'entry landed in exactly one bucket. Each entry is bucketed by the root of its reversal chain: enrollment collections (package = '
  'the payment event plan snapshot; a reversal is a signed correction on its own date), refunds '
  '(unattributed), other income (collections with no enrollment event) and adjustments. Package '
  'columns follow enrollment_plans; a snapshot key with no catalog row is shown once as Legacy/Other. '
  'No table, policy, permission or error code (22 permissions / 35 grants, 112 codes).')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) One reader, stable, security definer, callable by authenticated only:
--      select p.provolatile, p.prosecdef, p.proconfig,
--             has_function_privilege('authenticated', p.oid, 'execute') as auth,
--             has_function_privilege('anon', p.oid, 'execute') as anon
--        from pg_proc p where p.proname = 'finance_daily_income_report';   -> s | t | {search_path=...} | t | f
-- 2) Nothing moved:  select count(*) from public.staff_permissions;          -> 22
--                    select count(*) from public.staff_role_permissions;     -> 35
--                    select count(*) from public.app_error_catalog();        -> 112
-- 3) As a Super Admin in the app, Financial Management → Daily Income shows the current month with
--    "Reconciled" and a difference of ₱0.
