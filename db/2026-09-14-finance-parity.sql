-- ═════════════════════════════════════════════════════════════════════════════
-- #59 — Finance parity: the reports, ledger tools and bank feed the Apps Script
--       finance app had and #58 did not
-- 2026-09-14
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- #58 replaced the legacy finance app's LEDGER. It did not replace its day-to-day
-- surface: the pipeline strip and Sales by Package & Batch on the dashboard, the dated
-- sales report, payees and expense quick-picks, reclassifying a miscategorised cost,
-- a P&L you can group by quarter or week and drill into, and a bank feed where each
-- statement line is added, matched or undone. Without those the owner keeps the old
-- app open beside the new one, which is the outcome this build exists to end.
--
-- WHAT IT ADDS
--
--   * `finance_journal_entries.payee` and `.adjusts_entry_id`, both frozen after insert.
--   * `finance_expense_presets` — a 13th finance table: named quick-picks for Record
--     Expense (payee + account, never an amount). Seeded by CATEGORY only. The legacy
--     presets carried payee names that may identify individuals, and there is no
--     legacy-data import (owner decision, 2026-09-12).
--   * Five expense accounts: Insurance, Contractor payments, Travel, Meals and
--     entertainment, Vehicle expense.
--   * Readers: pipeline summary, sales by plan and batch, the sales report, bank account
--     tiles, bank match candidates, P&L account detail, expense presets.
--   * Writers: reclassify an entry, save/delete a preset, and the bank feed's
--     categorize ("Add"), match and undo.
--   * Restated: the entry guard, the internal entry writer (now with a payee), the
--     manual-entry RPC, the ledger list, the P&L, and every reconciliation function
--     whose invariants the bank feed would otherwise break.
--
-- ★ THE BANK FEED MUST NOT DOUBLE-COUNT A DEPOSIT. An approval already posted the
--   student's payment. A statement deposit for the same money is MATCHED to that entry
--   (finance_match_bank_transaction), never added as new income. The UI offers Match
--   before Add, and a unique index lets one entry be linked to one statement line only.
--
-- ★ A FEED-LINKED LINE AND A RECONCILIATION ITEM ARE TWO WAYS OF CLEARING THE SAME
--   TRANSACTION, AND ONLY ONE MAY EVER APPLY. #58's reconciliation counts every
--   status = 'matched' transaction as cleared. A transaction the feed linked is
--   `matched` with no reconciliation item, so every reconciliation writer is restated
--   here to refuse feed-linked rows, and the detail reader lists them as "cleared in
--   the feed" so the screen explains the number close will test.
--
-- SAFETY / ORDERING (sent as ONE transaction by the apply script; each statement is
-- still ordered so a partial run under-grants rather than over-grants)
--
--   * Columns and the new table come first; functions that name them after.
--   * `create or replace` cannot change an argument list or a return type. Every
--     function whose signature changes is DROPPED first and re-granted after.
--   * plpgsql resolves calls at EXECUTION time, so dropping finance_post_entry(6 args)
--     does not break finance_post_recurring's 6-argument call: that call resolves to the
--     new 8-argument function through its defaults. Proved by calling it, not by reading.
--   * No staff permission changes: #59 does NOT restate the permission seed, so
--     test/staffRolesSql.test.mjs keeps reading #58 as the current seed.
--
-- LOCKSTEP
--   this file <-> bootstrap fold §46 <-> src/lib/bankStatement.js <-> APP_ERROR_CODES +
--   APP_ERROR_COPY <-> test/financeParitySql.test.mjs <-> test/financeSql.test.mjs
--   (FINANCE_TABLES, the #58 slice bound) <-> test/communityStaffSql.test.mjs
--   (CURRENT_CATALOG_MIGRATION) <-> test-db/financeRls.dbtest.mjs <-> scripts/audit-db.mjs.
--
-- ═════════════════════════════════════════════════════════════════════════════


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations
                  where filename = '2026-09-09-financial-management.sql') then
    raise exception '#59: run db/2026-09-09-financial-management.sql (#58) first.';
  end if;
  if to_regclass('public.finance_journal_entries') is null
     or to_regclass('public.finance_bank_transactions') is null
     or to_regprocedure('public.finance_request_collected(uuid)') is null then
    raise exception '#59: #58 is logged but its tables or helpers are missing.';
  end if;
  if to_regclass('public.batches') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'subscriptions'
                       and column_name in ('request_id','batch_id')
                     group by table_name having count(*) = 2) then
    raise exception '#59: batches and subscriptions.request_id/batch_id are required (#32).';
  end if;
  -- #59 restates no permission; it must be running against #58's matrix.
  if (select count(*) from public.staff_permissions) <> 20
     or not exists (select 1 from public.staff_permissions where key = 'finance.manage') then
    raise exception '#59: expected the 20-permission matrix #58 seeds.';
  end if;
end
$pre$;


-- == 1) Schema ================================================================

-- 1a) Payee and the adjustment link on journal entries. Both are frozen after insert
--     by the restated finance_entry_guard (§2).
alter table public.finance_journal_entries add column if not exists payee text;
alter table public.finance_journal_entries
  add column if not exists adjusts_entry_id uuid references public.finance_journal_entries(id) on delete restrict;
create index if not exists finance_entries_payee_idx
  on public.finance_journal_entries (lower(payee)) where payee is not null;
create index if not exists finance_entries_adjusts_idx
  on public.finance_journal_entries (adjusts_entry_id) where adjusts_entry_id is not null;

-- 1b) The bank feed's link. `matched_via` says HOW a transaction was cleared in the
--     feed: 'add' (this feed posted the entry, so Undo reverses it) or 'match' (the entry
--     already existed — usually an approval — so Undo only unlinks it).
alter table public.finance_bank_transactions
  add column if not exists matched_via text check (matched_via in ('add','match'));
-- ★ THE ATTEMPT COUNTER IS PART OF THE IDEMPOTENCY KEY. Keyed on the transaction alone,
--   Add -> Undo -> Add would find the first (now reversed) entry by its key and silently
--   re-link it, so the second Add would post nothing while reporting success.
alter table public.finance_bank_transactions
  add column if not exists categorize_attempts integer not null default 0;
alter table public.finance_bank_transactions drop constraint if exists finance_bank_txn_attempts_nonneg;
alter table public.finance_bank_transactions
  add constraint finance_bank_txn_attempts_nonneg check (categorize_attempts >= 0);
alter table public.finance_bank_transactions drop constraint if exists finance_bank_txn_link_shape;
alter table public.finance_bank_transactions
  add constraint finance_bank_txn_link_shape check ((matched_entry_id is null) = (matched_via is null));

-- ★ ONE ENTRY, ONE STATEMENT LINE. Without this two deposits of ₱2,999 could both be
--   matched to the same approval, and cash would reconcile against money received once.
create unique index if not exists finance_bank_txn_entry_once
  on public.finance_bank_transactions (matched_entry_id) where matched_entry_id is not null;
-- duplicate_of_id is a self-FK with ON DELETE SET NULL. Discarding an import deletes its
-- rows, and each delete looks up rows pointing at it — a sequential scan per row without
-- this index, which makes discarding a large statement quadratic.
create index if not exists finance_bank_txn_dup_of_idx
  on public.finance_bank_transactions (duplicate_of_id) where duplicate_of_id is not null;

-- 1c) The audit vocabulary, widened. The CHECK is found by definition rather than by
--     name, so this is correct whatever #58's constraint was called.
do $act$
declare v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.finance_audit_events'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%entry_post%'
  loop
    execute format('alter table public.finance_audit_events drop constraint %I', v_name);
  end loop;
end
$act$;
alter table public.finance_audit_events add constraint finance_audit_events_action_check check (action in (
  'entry_post','entry_reverse','account_create','account_update','settings_update',
  'period_lock','period_unlock','bank_import_stage','bank_import_commit',
  'bank_import_discard','bank_txn_status','reconciliation_open',
  'reconciliation_match','reconciliation_close','reconciliation_reopen',
  'recurring_post','recurring_save','reconciliation_unmatch','reconciliation_update',
  'plan_income_map','backfill_run',
  'entry_reclassify','bank_categorize','bank_match','bank_undo','preset_save','preset_delete'));

-- 1d) Expense presets — the 13th finance table.
create table if not exists public.finance_expense_presets (
  id               uuid primary key default gen_random_uuid(),
  label            text not null,
  constraint finance_expense_presets_label_present check (nullif(btrim(label), '') is not null),
  constraint finance_expense_presets_label_unique unique (label),
  payee            text,
  account_id       uuid not null references public.finance_accounts(id) on delete restrict,
  memo             text,
  -- ★ NO AMOUNT, deliberately. A preset that carries an amount is a recurring posting in
  --   disguise, and the legacy app's pre-posted future expenses are exactly that defect.
  sort_order       integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null,
  created_by_email text,
  updated_at       timestamptz not null default now()
);
alter table public.finance_expense_presets enable row level security;
revoke all on table public.finance_expense_presets from public, anon, authenticated;
create index if not exists finance_expense_presets_account_idx on public.finance_expense_presets (account_id);

-- The same single SELECT policy, built by the same audited loop shape as #58 §14.
do $pol$
declare
  t text;
begin
  foreach t in array array['finance_expense_presets'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using ((select public.has_staff_permission(''finance.manage'')))', t || '_read', t);
  end loop;
end
$pol$;

-- 1e) Chart additions. Sorted before 5900 Miscellaneous.
insert into public.finance_accounts (code, name, account_type, subtype, reporting_class, cash_flow_class, is_system, sort_order, description) values
  ('5090','Insurance',               'expense','operating_expense','business','none',false,585, 'Business insurance premiums.'),
  ('5100','Contractor payments',     'expense','operating_expense','business','none',false,586, 'Payments to independent contractors and freelancers.'),
  ('5110','Travel',                  'expense','operating_expense','business','none',false,587, 'Business travel: fares, lodging.'),
  ('5120','Meals and entertainment', 'expense','operating_expense','business','none',false,588, 'Business meals and client entertainment.'),
  ('5130','Vehicle expense',         'expense','operating_expense','business','none',false,589, 'Fuel, parking, tolls and upkeep for business use.')
on conflict (code) do nothing;

-- 1f) Category-only presets. ★ Resolved by code AND type: a same-code account of another
--     type (created by hand before this ran) is never bound to an expense preset.
insert into public.finance_expense_presets (label, account_id, sort_order)
select v.label, a.id, v.sort_order
  from (values
    ('Software subscription',    '5020',  10),
    ('Internet and mobile load', '5030',  20),
    ('Advertising',              '5000',  30),
    ('Contractor payment',       '5100',  40),
    ('Salaries and wages',       '5010',  50),
    ('Rent',                     '5050',  60),
    ('Utilities',                '5060',  70),
    ('Professional fees',        '5070',  80),
    ('Bank and payment fees',    '5080',  90),
    ('Insurance',                '5090', 100),
    ('Office supplies',          '5040', 110)
  ) as v(label, code, sort_order)
  join public.finance_accounts a on a.code = v.code and a.account_type = 'expense'
on conflict (label) do nothing;


-- == 2) The entry guard and the entry writers, restated =======================

-- Restated verbatim from #58 with `payee` and `adjusts_entry_id` added to the frozen list.
create or replace function public.finance_entry_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_period text;
  v_tz text;
  v_today date;
begin
  select coalesce(reporting_timezone, 'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz, 'Asia/Manila'))::date;

  if tg_op = 'DELETE' then
    perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
      'A posted journal entry cannot be deleted. Reverse it instead.', 409,
      jsonb_build_object('entry_id', old.id));
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.entry_date is distinct from old.entry_date
       or new.entry_kind is distinct from old.entry_kind
       or new.reverses_entry_id is distinct from old.reverses_entry_id
       or new.source is distinct from old.source
       or new.idempotency_key is distinct from old.idempotency_key
       or new.created_at is distinct from old.created_at
       or new.payee is distinct from old.payee
       or new.adjusts_entry_id is distinct from old.adjusts_entry_id
       -- ★ A referential ON DELETE SET NULL is a REAL UPDATE that fires this trigger.
       --   Permit the nulling of created_by, and nothing else.
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
        'A posted journal entry cannot be edited. Reverse it and post a correction.', 409,
        jsonb_build_object('entry_id', old.id));
    end if;
    return new;   -- only `memo`, and a referential nulling of created_by
  end if;

  -- INSERT
  if new.entry_date > v_today + 1 then
    perform public.app_error('FINANCE_ENTRY_FUTURE_DATED',
      'An entry cannot be dated in the future. A recurring cost is a template, not a posting.', 422,
      jsonb_build_object('entry_date', new.entry_date, 'today', v_today));
  end if;

  v_period := public.finance_resolve_period(new.entry_date);
  if exists (select 1 from public.finance_period_locks where period_key = v_period and locked) then
    perform public.app_error('FINANCE_PERIOD_LOCKED',
      'That accounting period is closed. Post the correction in an open period instead.', 409,
      jsonb_build_object('period', v_period));
  end if;
  return new;
end;
$fn$;
revoke all on function public.finance_entry_guard() from public, anon, authenticated;

-- ★ DROP, THEN CREATE: the argument list grows. Internal — revoked, never granted.
drop function if exists public.finance_post_entry(date, text, text, text, jsonb, text);
create or replace function public.finance_post_entry(
  p_entry_date date, p_entry_kind text, p_memo text, p_source text,
  p_lines jsonb, p_idempotency_key text default null,
  p_payee text default null, p_adjusts_entry_id uuid default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_entry uuid; v_actor uuid := auth.uid(); v_email text; v_line jsonb; v_n int := 0;
  v_existing uuid;
begin
  if p_idempotency_key is not null then
    select id into v_existing from public.finance_journal_entries where idempotency_key = p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    perform public.app_error('FINANCE_ENTRY_UNBALANCED',
      'An entry needs at least two lines.', 422, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;

  insert into public.finance_journal_entries
    (entry_date, entry_kind, memo, source, idempotency_key, payee, adjusts_entry_id,
     created_by, created_by_email)
  values (p_entry_date, p_entry_kind, p_memo, p_source, p_idempotency_key,
          nullif(btrim(coalesce(p_payee, '')), ''), p_adjusts_entry_id, v_actor, v_email)
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit, memo)
    values (v_entry, v_n,
            (v_line->>'account_id')::uuid,
            round(coalesce((v_line->>'debit')::numeric, 0), 2),
            round(coalesce((v_line->>'credit')::numeric, 0), 2),
            v_line->>'memo');
  end loop;

  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'entry_post', 'journal_entry', v_entry,
          (select sum(debit) from public.finance_journal_lines where entry_id = v_entry),
          jsonb_build_object('source', p_source, 'kind', p_entry_kind));

  return v_entry;
end;
$fn$;
revoke all on function public.finance_post_entry(date, text, text, text, jsonb, text, text, uuid) from public, anon, authenticated;

drop function if exists public.finance_post_manual_entry(date, text, text, jsonb, text);
create or replace function public.finance_post_manual_entry(
  p_entry_date date, p_entry_kind text, p_memo text, p_lines jsonb, p_idempotency_key text,
  p_payee text default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then
    perform public.app_error('FINANCE_IDEMPOTENCY_REQUIRED',
      'This action needs an idempotency key so a retry cannot post twice.', 422, null);
  end if;
  if p_entry_kind = 'reversal' then
    perform public.app_error('FINANCE_ENTRY_KIND_INVALID',
      'Use the reverse action to create a reversal.', 422, null);
  end if;
  return public.finance_post_entry(p_entry_date, p_entry_kind, p_memo, 'manual', p_lines,
                                   'manual:' || p_idempotency_key, p_payee, null);
end;
$fn$;
revoke all on function public.finance_post_manual_entry(date, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.finance_post_manual_entry(date, text, text, jsonb, text, text) to authenticated;


-- == 3) Readers ===============================================================
-- Every one: STABLE SECURITY DEFINER, search_path pinned with pg_temp last, the
-- permission check as the first statement, revoked then granted. Approval dates are
-- coalesce(reviewed_at, created_at) in the business timezone and collected money comes
-- from finance_request_collected() — the two #58 rules, so these figures agree with the
-- dashboard, sales by plan and the receivables worklist by construction.

-- 3a) The pipeline strip, and the two "recent" lists beside it.
create or replace function public.finance_pipeline_summary(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_tz text; v_today date; v_from date; v_to date;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_today := (now() at time zone v_tz)::date;
  v_from := coalesce(p_from, date_trunc('month', v_today)::date);
  v_to   := coalesce(p_to, v_today);

  return jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', v_tz),
    -- ★ Staff are not students. Invited and active staff are excluded exactly as the
    --   Access Requests queue excludes them (#50); suspended/revoked may be real students.
    'signups_awaiting_access', (
      select count(*) from public.profiles p
       where p.approval_status = 'pending'
         and not exists (select 1 from public.staff_memberships m
                          where m.user_id = p.id and m.status in ('invited','active'))),
    'payment_proofs_pending', (select count(*) from public.enrollment_requests where status = 'pending_review'),
    'approved_in_range', (
      select count(*) from public.enrollment_requests r
       where r.status = 'approved'
         and (coalesce(r.reviewed_at, r.created_at) at time zone v_tz)::date between v_from and v_to),
    'rejected_in_range', (
      select count(*) from public.enrollment_requests r
       where r.status = 'rejected'
         and (coalesce(r.reviewed_at, r.created_at) at time zone v_tz)::date between v_from and v_to),
    'recent_collections', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.occurred_on desc, q.created_at desc)
        from (select pe.occurred_on, pe.amount, pe.plan_name, pe.student_email, pe.source, pe.created_at,
                     exists (select 1 from public.finance_journal_entries rv
                              where rv.reverses_entry_id = pe.journal_entry_id) as reversed
                from public.finance_payment_events pe
               where pe.event_kind = 'enrollment_collection'
               order by pe.occurred_on desc, pe.created_at desc
               limit 8) q), '[]'::jsonb),
    'recent_approvals', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.approved_at desc)
        from (select r.id as request_id, r.full_name, r.email, r.plan_name, r.amount_paid,
                     coalesce(r.reviewed_at, r.created_at) as approved_at
                from public.enrollment_requests r
               where r.status = 'approved'
               order by coalesce(r.reviewed_at, r.created_at) desc
               limit 8) q), '[]'::jsonb)
  );
end;
$fn$;
revoke all on function public.finance_pipeline_summary(date, date) from public, anon, authenticated;
grant execute on function public.finance_pipeline_summary(date, date) to authenticated;

-- 3b) Sales by plan, broken down by batch. Nested JSON: one plan, its batches.
-- ★ A request's batch is the one ON THE REQUEST, else the one its granted term was
--   stamped with. Never a guess from the calendar: a request with neither is
--   "No batch", which is the truthful answer for Sampler and Silver.
create or replace function public.finance_sales_by_plan_batch(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_tz text; v_today date; v_from date; v_to date; v_out jsonb;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_today := (now() at time zone v_tz)::date;
  v_from := coalesce(p_from, date_trunc('month', v_today)::date);
  v_to   := coalesce(p_to, v_today);

  with base as (
    select r.id, r.plan_key, r.plan_name, r.amount_expected as contract,
           public.finance_request_collected(r.id) as collected,
           coalesce(r.batch_id, (select s.batch_id from public.subscriptions s
                                  where s.request_id = r.id and s.batch_id is not null
                                  order by s.created_at desc limit 1)) as batch_id
      from public.enrollment_requests r
     where r.status = 'approved'
       and (coalesce(r.reviewed_at, r.created_at) at time zone v_tz)::date between v_from and v_to
  ), total as (
    select count(*)::int as n, coalesce(sum(contract),0)::numeric(14,2) as contract,
           coalesce(sum(collected),0)::numeric(14,2) as collected
      from base
  ), by_batch as (
    select b.plan_key, b.plan_name, b.batch_id, bt.code as batch_code, bt.name as batch_name,
           count(*)::int as n, sum(b.contract)::numeric(14,2) as contract, sum(b.collected)::numeric(14,2) as collected
      from base b left join public.batches bt on bt.id = b.batch_id
     group by b.plan_key, b.plan_name, b.batch_id, bt.code, bt.name
  ), by_plan as (
    select plan_key, plan_name, sum(n)::int as n, sum(contract)::numeric(14,2) as contract,
           sum(collected)::numeric(14,2) as collected
      from by_batch group by plan_key, plan_name
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', v_tz),
    'total', (select jsonb_build_object('enrollments', t.n, 'contract', t.contract, 'collected', t.collected,
                     'avg_collected', case when t.n = 0 then null else round(t.collected / t.n, 2) end) from total t),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'plan_key', p.plan_key, 'plan_name', p.plan_name, 'enrollments', p.n,
               'contract', p.contract, 'collected', p.collected,
               -- NULL, never 0%, when nothing was collected in the whole range.
               'pct_of_collected', case when (select collected from total) = 0 then null
                                        else round(100 * p.collected / (select collected from total), 2) end,
               'avg_collected', case when p.n = 0 then null else round(p.collected / p.n, 2) end,
               'batches', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'batch_id', bb.batch_id, 'batch_code', bb.batch_code, 'batch_name', bb.batch_name,
                          'enrollments', bb.n, 'contract', bb.contract, 'collected', bb.collected,
                          'pct_of_collected', case when (select collected from total) = 0 then null
                                                   else round(100 * bb.collected / (select collected from total), 2) end,
                          'avg_collected', case when bb.n = 0 then null else round(bb.collected / bb.n, 2) end)
                          order by bb.batch_code nulls last)
                   from by_batch bb
                  where bb.plan_key is not distinct from p.plan_key
                    and bb.plan_name is not distinct from p.plan_name), '[]'::jsonb))
               order by p.collected desc, p.plan_name)
        from by_plan p), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$fn$;
revoke all on function public.finance_sales_by_plan_batch(date, date) from public, anon, authenticated;
grant execute on function public.finance_sales_by_plan_batch(date, date) to authenticated;

-- 3c) The sales report: filtered detail rows, totals and a daily trend in one call, so
--     the three can never be computed over different populations.
create or replace function public.finance_sales_report(
  p_from date default null, p_to date default null,
  p_plan_keys text[] default null, p_batch_ids uuid[] default null,
  p_payment_status text default null,
  p_limit integer default 200, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_tz text; v_today date; v_from date; v_to date; v_limit int; v_offset int; v_out jsonb;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_payment_status is not null and p_payment_status not in ('paid','partial','outstanding') then
    raise exception 'finance_sales_report: unknown payment status %', p_payment_status using errcode = '22023';
  end if;
  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_today := (now() at time zone v_tz)::date;
  v_from := coalesce(p_from, date_trunc('month', v_today)::date);
  v_to   := coalesce(p_to, v_today);
  v_limit  := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));

  with base as (
    select r.id as request_id, r.full_name, r.email, r.plan_key, r.plan_name, r.request_kind,
           (coalesce(r.reviewed_at, r.created_at) at time zone v_tz)::date as approved_on,
           r.amount_expected::numeric(14,2) as contract,
           public.finance_request_collected(r.id) as collected,
           coalesce(r.batch_id, (select s.batch_id from public.subscriptions s
                                  where s.request_id = r.id and s.batch_id is not null
                                  order by s.created_at desc limit 1)) as batch_id
      from public.enrollment_requests r
     where r.status = 'approved'
       and (coalesce(r.reviewed_at, r.created_at) at time zone v_tz)::date between v_from and v_to
       and (p_plan_keys is null or cardinality(p_plan_keys) = 0 or r.plan_key = any(p_plan_keys))
  ), calc as (
    select b.*, bt.code as batch_code,
           greatest(b.contract - b.collected, 0)::numeric(14,2) as outstanding,
           case when greatest(b.contract - b.collected, 0) = 0 then 'paid'
                when b.collected > 0 then 'partial'
                else 'outstanding' end as payment_status
      from base b left join public.batches bt on bt.id = b.batch_id
     where (p_batch_ids is null or cardinality(p_batch_ids) = 0 or b.batch_id = any(p_batch_ids))
  ), filtered as (
    select * from calc where p_payment_status is null or payment_status = p_payment_status
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', v_tz),
    'total_count', (select count(*) from filtered),
    'totals', (select jsonb_build_object(
                 'enrollments', count(*), 'contract', coalesce(sum(contract),0),
                 'collected', coalesce(sum(collected),0), 'outstanding', coalesce(sum(outstanding),0))
                 from filtered),
    'daily', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.day)
        from (select approved_on as day, count(*) as enrollments,
                     sum(contract)::numeric(14,2) as contract, sum(collected)::numeric(14,2) as collected
                from filtered group by approved_on) d), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.approved_on desc, p.full_name)
        from (select * from filtered order by approved_on desc, full_name
               limit v_limit offset v_offset) p), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$fn$;
revoke all on function public.finance_sales_report(date, date, text[], uuid[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_sales_report(date, date, text[], uuid[], text, integer, integer) to authenticated;

-- 3d) The ledger, with payee, amount bounds and filter totals.
-- ★ DROP FIRST: the argument list and the return type both change.
drop function if exists public.finance_ledger_list(date, date, uuid, text, text, integer, integer);
create or replace function public.finance_ledger_list(
  p_from date, p_to date,
  p_account_id uuid default null,
  p_entry_kind text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0,
  p_min numeric default null,
  p_max numeric default null
) returns table (
  entry_id uuid, entry_no bigint, entry_date date, entry_kind text, memo text, payee text,
  source text, is_reversal boolean, reversed_by_entry_id uuid, adjusts_entry_id uuid,
  total_amount numeric, income_amount numeric, expense_amount numeric,
  lines jsonb, created_at timestamptz, created_by_email text,
  total_count bigint, filter_income numeric, filter_expense numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_limit int; v_offset int; v_pattern text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_entry_kind is not null and p_entry_kind not in (
      'collection','expense','owner_draw','owner_contribution','transfer',
      'refund','opening_balance','adjustment','reversal') then
    raise exception 'finance_ledger_list: unknown entry kind %', p_entry_kind using errcode = '22023';
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 100), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  -- ★ ESCAPED, as in #58: `%` and `_` are ILIKE wildcards, `!` is the escape character.
  v_pattern := case when p_search is null or length(btrim(p_search)) < 2 then null
                    else '%' || replace(replace(replace(btrim(p_search), '!', '!!'), '%', '!%'), '_', '!_') || '%' end;

  return query
  with matched as (
    select e.*,
           coalesce((select sum(l.debit) from public.finance_journal_lines l where l.entry_id = e.id), 0)::numeric(14,2) as tot,
           coalesce((select sum(l.credit - l.debit) from public.finance_journal_lines l
                      join public.finance_accounts a on a.id = l.account_id
                     where l.entry_id = e.id and a.account_type = 'income'), 0)::numeric(14,2) as inc,
           coalesce((select sum(l.debit - l.credit) from public.finance_journal_lines l
                      join public.finance_accounts a on a.id = l.account_id
                     where l.entry_id = e.id and a.account_type = 'expense'), 0)::numeric(14,2) as exp
      from public.finance_journal_entries e
     where e.entry_date between p_from and p_to
       and (p_entry_kind is null or e.entry_kind = p_entry_kind)
       and (v_pattern is null
            or e.memo ilike v_pattern escape '!'
            or e.payee ilike v_pattern escape '!')
       and (p_account_id is null or exists (
             select 1 from public.finance_journal_lines l
              where l.entry_id = e.id and l.account_id = p_account_id))
  ), bounded as (
    select * from matched m
     where (p_min is null or m.tot >= p_min)
       and (p_max is null or m.tot <= p_max)
  )
  select m.id, m.entry_no, m.entry_date, m.entry_kind, m.memo, m.payee, m.source,
         (m.entry_kind = 'reversal'),
         (select rv.id from public.finance_journal_entries rv where rv.reverses_entry_id = m.id),
         m.adjusts_entry_id,
         m.tot, m.inc, m.exp,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'line_no', l.line_no, 'account_id', l.account_id,
                     'account_code', a.code, 'account_name', a.name,
                     'account_type', a.account_type, 'subtype', a.subtype,
                     'debit', l.debit, 'credit', l.credit, 'memo', l.memo)
                     order by l.line_no)
                    from public.finance_journal_lines l
                    join public.finance_accounts a on a.id = l.account_id
                   where l.entry_id = m.id), '[]'::jsonb),
         m.created_at, m.created_by_email,
         count(*) over ()::bigint,
         -- Totals over the WHOLE filter, not the page: window functions run before LIMIT.
         sum(m.inc) over ()::numeric(14,2),
         sum(m.exp) over ()::numeric(14,2)
    from bounded m
   order by m.entry_date desc, m.entry_no desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_ledger_list(date, date, uuid, text, text, integer, integer, numeric, numeric) from public, anon, authenticated;
grant execute on function public.finance_ledger_list(date, date, uuid, text, text, integer, integer, numeric, numeric) to authenticated;

-- 3e) The P&L: quarter and week grouping, account/payee/amount filters, and an owner's
--     draw MEMO below the net line.
-- ★ THE MEMO IS NOT A SECTION OF PROFIT. Its rows carry section 'memo_owner_draw' and are
--   excluded from period_total by name, so a draw can be SHOWN beside the P&L without
--   ever being subtracted from it. Every other equity, asset and liability account still
--   maps to nothing at all.
drop function if exists public.finance_cash_basis_pl(date, date, text);
create or replace function public.finance_cash_basis_pl(
  p_from date, p_to date, p_group text default 'month',
  p_account_ids uuid[] default null, p_payee text default null,
  p_min numeric default null, p_max numeric default null
) returns table (
  period_key text, section text, account_id uuid, account_code text,
  account_name text, amount numeric, section_total numeric, period_total numeric, entry_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_pattern text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_group not in ('month','quarter','week','total') then
    raise exception 'finance_cash_basis_pl: unknown grouping %', p_group using errcode = '22023';
  end if;
  v_pattern := case when p_payee is null or length(btrim(p_payee)) < 2 then null
                    else '%' || replace(replace(replace(btrim(p_payee), '!', '!!'), '%', '!%'), '_', '!_') || '%' end;

  return query
  with entries as (
    select e.id, e.entry_date, e.period_key as month_key,
           (select sum(x.debit) from public.finance_journal_lines x where x.entry_id = e.id) as tot
      from public.finance_journal_entries e
     where e.entry_date between p_from and p_to
       and (v_pattern is null or e.payee ilike v_pattern escape '!')
  ), lines as (
    select case p_group
             when 'total'   then 'TOTAL'
             when 'quarter' then extract(year from en.entry_date)::int::text || '-Q' || extract(quarter from en.entry_date)::int::text
             -- ISO week, keyed by its Monday, so a week spanning two months is one period.
             when 'week'    then (en.entry_date - (extract(isodow from en.entry_date)::int - 1))::text
             else en.month_key
           end as pk,
           case
             when a.subtype = 'owner_draw' then 'memo_owner_draw'
             when a.subtype = 'cost_of_sales' then 'cost_of_sales'
             when a.subtype = 'other_income'  then 'other_income'
             when a.subtype = 'other_expense' then 'other_expense'
             when a.account_type = 'income'   then 'income'
             when a.account_type = 'expense'  then 'operating_expense'
           end as sect,
           a.id as aid, a.code as acode, a.name as aname, en.id as eid,
           case when a.account_type = 'income' then l.credit - l.debit
                else l.debit - l.credit end as amt
      from public.finance_journal_lines l
      join entries en on en.id = l.entry_id
      join public.finance_accounts a on a.id = l.account_id
     where (a.account_type in ('income','expense') or a.subtype = 'owner_draw')
       and (p_account_ids is null or cardinality(p_account_ids) = 0 or a.id = any(p_account_ids))
       and (p_min is null or en.tot >= p_min)
       and (p_max is null or en.tot <= p_max)
  ), agg as (
    select pk, sect, aid, acode, aname, sum(amt)::numeric(14,2) as amt, count(distinct eid) as n
      from lines group by pk, sect, aid, acode, aname
  )
  select g.pk, g.sect, g.aid, g.acode, g.aname, g.amt,
         sum(g.amt) over (partition by g.pk, g.sect)::numeric(14,2),
         sum(case when g.sect in ('income','other_income') then g.amt
                  when g.sect in ('cost_of_sales','operating_expense','other_expense') then -g.amt
                  else 0 end)
           over (partition by g.pk)::numeric(14,2),
         g.n
    from agg g
   order by g.pk, g.sect, g.acode;
end;
$fn$;
revoke all on function public.finance_cash_basis_pl(date, date, text, uuid[], text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.finance_cash_basis_pl(date, date, text, uuid[], text, numeric, numeric) to authenticated;

comment on function public.finance_cash_basis_pl(date, date, text, uuid[], text, numeric, numeric) is
  'Cash basis. A MANAGEMENT report, not a statutory financial statement. There is no accrual '
  'mode and no A/R account in the chart; an accrual P&L is a different product decision, and '
  'it is a migration. memo_owner_draw rows are shown below net profit and are never part of it.';

-- 3f) Drill-down: one account over a range, by payee and by entry.
create or replace function public.finance_pl_account_detail(
  p_account_id uuid, p_from date, p_to date
) returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_acct public.finance_accounts%rowtype;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_acct from public.finance_accounts where id = p_account_id;
  if not found then
    perform public.app_error('FINANCE_ACCOUNT_NOT_FOUND', 'That finance account does not exist.', 404, null);
  end if;

  return (
    with rows_all as (
      select e.id as entry_id, e.entry_no, e.entry_date, e.entry_kind, e.memo, e.payee,
             sum(case when v_acct.account_type = 'income' then l.credit - l.debit
                      else l.debit - l.credit end)::numeric(14,2) as amount
        from public.finance_journal_lines l
        join public.finance_journal_entries e on e.id = l.entry_id
       where l.account_id = p_account_id and e.entry_date between p_from and p_to
       group by e.id, e.entry_no, e.entry_date, e.entry_kind, e.memo, e.payee
    )
    select jsonb_build_object(
      'account', jsonb_build_object('id', v_acct.id, 'code', v_acct.code, 'name', v_acct.name,
                                    'account_type', v_acct.account_type, 'subtype', v_acct.subtype),
      'range', jsonb_build_object('from', p_from, 'to', p_to),
      'total', coalesce((select sum(amount) from rows_all), 0),
      'entry_count', (select count(*) from rows_all),
      'by_payee', coalesce((
        select jsonb_agg(to_jsonb(p) order by p.amount desc)
          from (select coalesce(payee, '') as payee, sum(amount)::numeric(14,2) as amount, count(*) as entries
                  from rows_all group by coalesce(payee, '')) p), '[]'::jsonb),
      'entries', coalesce((
        select jsonb_agg(to_jsonb(q) order by q.entry_date desc, q.entry_no desc)
          from (select * from rows_all order by entry_date desc, entry_no desc limit 500) q), '[]'::jsonb)
    ));
end;
$fn$;
revoke all on function public.finance_pl_account_detail(uuid, date, date) from public, anon, authenticated;
grant execute on function public.finance_pl_account_detail(uuid, date, date) to authenticated;

-- 3g) Expense presets for the quick-pick and the Setup list.
create or replace function public.finance_expense_presets_list(p_include_inactive boolean default false)
returns table (
  id uuid, label text, payee text, account_id uuid, account_code text, account_name text,
  account_active boolean, memo text, sort_order integer, active boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  return query
  select p.id, p.label, p.payee, p.account_id, a.code, a.name, a.active, p.memo, p.sort_order, p.active
    from public.finance_expense_presets p
    join public.finance_accounts a on a.id = p.account_id
   where p_include_inactive or (p.active and a.active)
   order by p.sort_order, p.label;
end;
$fn$;
revoke all on function public.finance_expense_presets_list(boolean) from public, anon, authenticated;
grant execute on function public.finance_expense_presets_list(boolean) to authenticated;

-- 3h) One tile per cash or card account: the ledger balance, what is waiting in the feed,
--     and the last statement. ★ `balance` follows the dashboard's cash_position rule — a
--     card is NEGATIVE (money owed reduces cash) — so the UI shows a card as "owed" by
--     negating it, never by summing it as money held.
create or replace function public.finance_bank_account_tiles()
returns table (
  account_id uuid, code text, name text, cash_flow_class text, balance numeric,
  to_review bigint, possible_duplicates bigint, last_import_at timestamptz, last_statement_closing numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  return query
  select a.id, a.code, a.name, a.cash_flow_class,
         (case when a.cash_flow_class = 'card' then -1 else 1 end
          * coalesce((select case when a.normal_balance = 'debit' then sum(l.debit) - sum(l.credit)
                                  else sum(l.credit) - sum(l.debit) end
                        from public.finance_journal_lines l where l.account_id = a.id), 0))::numeric(14,2),
         -- Only COMMITTED imports are in the feed; a staged file is still being reviewed.
         (select count(*) from public.finance_bank_transactions t
           join public.finance_bank_imports i on i.id = t.import_id and i.status = 'committed'
          where t.account_id = a.id and t.status = 'unmatched'),
         (select count(*) from public.finance_bank_transactions t
           join public.finance_bank_imports i on i.id = t.import_id and i.status = 'committed'
          where t.account_id = a.id and t.status = 'unmatched' and t.duplicate_kind = 'likely'),
         (select max(i.created_at) from public.finance_bank_imports i
           where i.account_id = a.id and i.status <> 'discarded'),
         (select i.closing_balance from public.finance_bank_imports i
           where i.account_id = a.id and i.status = 'committed'
           order by i.committed_at desc nulls last, i.created_at desc limit 1)
    from public.finance_accounts a
   where a.active and a.cash_flow_class in ('cash','card')
   order by a.cash_flow_class, a.sort_order, a.code;
end;
$fn$;
revoke all on function public.finance_bank_account_tiles() from public, anon, authenticated;
grant execute on function public.finance_bank_account_tiles() to authenticated;

-- 3i) Entries a statement line could be matched to: same account, same SIGNED amount,
--     near in date, not reversed, and not already claimed by the feed or a reconciliation.
-- ★ The window is wide on purpose. A student pays days BEFORE their proof is approved,
--   so the deposit precedes the approval's collection entry.
create or replace function public.finance_bank_match_candidates(p_txn_id uuid, p_days integer default 14)
returns table (
  entry_id uuid, entry_no bigint, entry_date date, entry_kind text, memo text, payee text,
  source text, amount numeric, day_gap integer
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_t public.finance_bank_transactions%rowtype; v_days int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_t from public.finance_bank_transactions where id = p_txn_id;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That bank transaction does not exist.', 404, null);
  end if;
  v_days := greatest(0, least(coalesce(p_days, 14), 60));

  return query
  select e.id, e.entry_no, e.entry_date, e.entry_kind, e.memo, e.payee, e.source, x.signed,
         abs(e.entry_date - v_t.posted_on)::integer
    from public.finance_journal_entries e
    join lateral (
      select sum(l.debit - l.credit)::numeric(14,2) as signed
        from public.finance_journal_lines l
       where l.entry_id = e.id and l.account_id = v_t.account_id
    ) x on x.signed is not null
   where e.entry_date between v_t.posted_on - v_days and v_t.posted_on + v_days
     and x.signed = v_t.amount
     and e.entry_kind <> 'reversal'
     and not exists (select 1 from public.finance_journal_entries rv where rv.reverses_entry_id = e.id)
     and not exists (select 1 from public.finance_bank_transactions bt where bt.matched_entry_id = e.id)
     and not exists (select 1 from public.finance_reconciliation_items ri
                      join public.finance_journal_lines jl on jl.id = ri.journal_line_id
                     where jl.entry_id = e.id)
   order by abs(e.entry_date - v_t.posted_on), e.entry_no desc
   limit 20;
end;
$fn$;
revoke all on function public.finance_bank_match_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.finance_bank_match_candidates(uuid, integer) to authenticated;


-- == 4) Writers ===============================================================
-- Same shape as #58: permission check first, audit row last, no exception handler.

-- 4a) Reclassify. History is never edited: an adjustment moves the amount from one
--     account to another and links back to the entry it corrects.
-- ★ ALLOWED PAIRS ONLY: income -> income, expense -> expense, and expense -> owner's
--   draw (the commonest legacy correction: personal spending booked as a business cost).
--   Income -> expense, or anything into a cash account, would change what KIND of money
--   an entry was, which is a reversal and a new entry, not a reclassification.
create or replace function public.finance_reclassify_entry(
  p_entry_id uuid, p_from_account_id uuid, p_to_account_id uuid, p_reason text, p_idempotency_key text
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_orig public.finance_journal_entries%rowtype;
  v_from public.finance_accounts%rowtype;
  v_to public.finance_accounts%rowtype;
  v_net numeric(14,2); v_amt numeric(14,2); v_date date; v_tz text; v_today date;
  v_key text; v_existing uuid; v_entry uuid; v_lines jsonb; v_kind text;
  v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then
    perform public.app_error('FINANCE_IDEMPOTENCY_REQUIRED',
      'This action needs an idempotency key so a retry cannot post twice.', 422, null);
  end if;
  v_key := 'reclassify:' || p_idempotency_key;
  -- A retry of the SAME click returns what it already did, and writes no second audit row.
  select id into v_existing from public.finance_journal_entries where idempotency_key = v_key;
  if v_existing is not null then
    return jsonb_build_object('entry_id', v_existing, 'repeated', true);
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_RECLASSIFY_INVALID',
      'A reclassification needs a reason.', 422, null);
  end if;

  select * into v_orig from public.finance_journal_entries where id = p_entry_id;
  if not found then
    perform public.app_error('FINANCE_ENTRY_NOT_FOUND', 'That journal entry does not exist.', 404, null);
  end if;
  if v_orig.entry_kind = 'reversal'
     or exists (select 1 from public.finance_journal_entries where reverses_entry_id = p_entry_id) then
    perform public.app_error('FINANCE_RECLASSIFY_INVALID',
      'A reversed entry, or a reversal, cannot be reclassified.', 409, null);
  end if;

  select * into v_from from public.finance_accounts where id = p_from_account_id;
  select * into v_to   from public.finance_accounts where id = p_to_account_id;
  if v_from.id is null or v_to.id is null then
    perform public.app_error('FINANCE_ACCOUNT_NOT_FOUND', 'That finance account does not exist.', 404, null);
  end if;
  if v_from.id = v_to.id or not v_to.active
     or not ((v_from.account_type = v_to.account_type and v_from.account_type in ('income','expense'))
             or (v_from.account_type = 'expense' and v_to.subtype = 'owner_draw')) then
    perform public.app_error('FINANCE_RECLASSIFY_INVALID',
      'Only income to income, expense to expense, or expense to owner''s draw can be reclassified, '
      'into an active account.', 422, null);
  end if;

  -- ★ NET OF EARLIER RECLASSIFICATIONS. Measured on the entry's own lines, reclassifying
  --   the same cost twice moved it twice: the source account went negative while two
  --   accounts each claimed the money. What an account still carries FROM this entry is
  --   the entry's lines plus every live (unreversed) adjustment of it.
  select coalesce(sum(l.debit - l.credit), 0) into v_net
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
   where l.account_id = p_from_account_id
     and (e.id = p_entry_id
          or (e.adjusts_entry_id = p_entry_id
              and not exists (select 1 from public.finance_journal_entries rv
                               where rv.reverses_entry_id = e.id)));
  if v_net = 0 then
    perform public.app_error('FINANCE_RECLASSIFY_INVALID',
      'That account no longer carries an amount from this entry.', 422, null);
  end if;
  v_amt := abs(v_net);

  -- The same landing rule as a reversal: the original date, unless its month is closed.
  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;
  v_date := v_orig.entry_date;
  if exists (select 1 from public.finance_period_locks
              where period_key = public.finance_resolve_period(v_date) and locked) then
    v_date := v_today;
    while exists (select 1 from public.finance_period_locks
                   where period_key = public.finance_resolve_period(v_date) and locked) loop
      v_date := (date_trunc('month', v_date) + interval '1 month')::date;
    end loop;
  end if;

  -- Move the amount off the side it sits on.
  v_lines := case when v_net > 0
    then jsonb_build_array(jsonb_build_object('account_id', v_to.id,   'debit', v_amt, 'credit', 0),
                           jsonb_build_object('account_id', v_from.id, 'debit', 0,     'credit', v_amt))
    else jsonb_build_array(jsonb_build_object('account_id', v_from.id, 'debit', v_amt, 'credit', 0),
                           jsonb_build_object('account_id', v_to.id,   'debit', 0,     'credit', v_amt)) end;
  v_kind := case when v_to.subtype = 'owner_draw' then 'owner_draw' else 'adjustment' end;

  v_entry := public.finance_post_entry(
    v_date, v_kind, 'Reclassification of entry #' || v_orig.entry_no || ': ' || btrim(p_reason),
    'manual', v_lines, v_key, v_orig.payee, p_entry_id);

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail, reason)
  values (v_actor, v_email, 'entry_reclassify', 'journal_entry', v_entry, v_amt,
          jsonb_build_object('adjusts', p_entry_id, 'from_account_id', v_from.id, 'to_account_id', v_to.id,
                             'landed_in', public.finance_resolve_period(v_date)),
          btrim(p_reason));
  return jsonb_build_object('entry_id', v_entry, 'entry_date', v_date,
                            'period', public.finance_resolve_period(v_date));
end;
$fn$;
revoke all on function public.finance_reclassify_entry(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finance_reclassify_entry(uuid, uuid, uuid, text, text) to authenticated;

-- 4a') #58's reversal, restated: it carries the payee onto the reversal, and it refuses an
--      entry that still has a live reclassification.
-- ★ Reversing the original alone would leave the adjustment standing — money moved out of
--   an account the reversal has just emptied, so that account would go negative. Reverse
--   the reclassification first; then the original.
create or replace function public.finance_reverse_entry(
  p_entry_id uuid, p_reason text, p_reversal_date date default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_orig public.finance_journal_entries%rowtype;
  v_date date; v_period text; v_tz text; v_today date;
  v_entry uuid; v_actor uuid := auth.uid(); v_email text; v_line record; v_n int := 0;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_REVERSAL_REASON_REQUIRED',
      'A reversal needs a reason — it is the only record of why the correction was made.', 422, null);
  end if;

  select * into v_orig from public.finance_journal_entries where id = p_entry_id;
  if not found then
    perform public.app_error('FINANCE_ENTRY_NOT_FOUND', 'That journal entry does not exist.', 404, null);
  end if;
  if exists (select 1 from public.finance_journal_entries where reverses_entry_id = p_entry_id) then
    perform public.app_error('FINANCE_ENTRY_ALREADY_REVERSED',
      'That entry has already been reversed.', 409, jsonb_build_object('entry_id', p_entry_id));
  end if;
  if exists (select 1 from public.finance_journal_entries a
              where a.adjusts_entry_id = p_entry_id
                and not exists (select 1 from public.finance_journal_entries rv
                                 where rv.reverses_entry_id = a.id)) then
    perform public.app_error('FINANCE_ENTRY_HAS_ADJUSTMENTS',
      'That entry has a reclassification that still stands. Reverse the reclassification first.', 409,
      jsonb_build_object('entry_id', p_entry_id));
  end if;
  -- ★ An entry a statement line is linked to is undone in the bank feed, not here. Reversed
  --   from the ledger, the line would stay cleared against an entry that no longer stands,
  --   and cash would reconcile against money the books say was never received.
  if exists (select 1 from public.finance_bank_transactions where matched_entry_id = p_entry_id) then
    perform public.app_error('FINANCE_BANK_TXN_LINKED',
      'That entry is linked to a bank statement line. Undo it in the bank feed instead.', 409,
      jsonb_build_object('entry_id', p_entry_id));
  end if;

  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;

  -- ★ NEVER silently back-date, NEVER silently refuse — say which month it lands in.
  if p_reversal_date is not null then
    v_date := p_reversal_date;
    v_period := public.finance_resolve_period(v_date);
    if exists (select 1 from public.finance_period_locks where period_key = v_period and locked) then
      perform public.app_error('FINANCE_PERIOD_LOCKED',
        'That accounting period is closed, so the correction cannot be dated into it.', 409,
        jsonb_build_object('period', v_period));
    end if;
  else
    v_date := v_orig.entry_date;
    v_period := public.finance_resolve_period(v_date);
    if exists (select 1 from public.finance_period_locks where period_key = v_period and locked) then
      v_date := greatest(v_today, date_trunc('month', v_today)::date);
      while exists (select 1 from public.finance_period_locks
                     where period_key = public.finance_resolve_period(v_date) and locked) loop
        v_date := (date_trunc('month', v_date) + interval '1 month')::date;
      end loop;
    end if;
  end if;

  select email into v_email from public.profiles where id = v_actor;

  insert into public.finance_journal_entries
    (entry_date, entry_kind, memo, source, reverses_entry_id, reversal_reason,
     idempotency_key, payee, created_by, created_by_email)
  values (v_date, 'reversal', 'Reversal of entry #' || v_orig.entry_no, 'reversal',
          p_entry_id, p_reason, 'reversal:' || p_entry_id::text, v_orig.payee, v_actor, v_email)
  returning id into v_entry;

  -- Debit and credit SWAPPED, never negated — negation would violate debit >= 0.
  for v_line in select * from public.finance_journal_lines where entry_id = p_entry_id order by line_no loop
    v_n := v_n + 1;
    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit, memo)
    values (v_entry, v_n, v_line.account_id, v_line.credit, v_line.debit, v_line.memo);
  end loop;

  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail, reason)
  values (v_actor, v_email, 'entry_reverse', 'journal_entry', v_entry,
          (select sum(debit) from public.finance_journal_lines where entry_id = v_entry),
          jsonb_build_object('reverses', p_entry_id, 'landed_in', public.finance_resolve_period(v_date)),
          p_reason);

  return jsonb_build_object('entry_id', v_entry, 'entry_date', v_date,
                            'period', public.finance_resolve_period(v_date));
end;
$fn$;
revoke all on function public.finance_reverse_entry(uuid, text, date) from public, anon, authenticated;
grant execute on function public.finance_reverse_entry(uuid, text, date) to authenticated;

-- 4b) Expense presets. Configuration, not ledger: a preset can be deleted outright, and
--     the audit row keeps its label.
create or replace function public.finance_save_expense_preset(
  p_id uuid, p_label text, p_payee text, p_account_id uuid, p_memo text,
  p_sort_order integer default 0, p_active boolean default true
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_label,'')),'') is null
     or not exists (select 1 from public.finance_accounts
                     where id = p_account_id and active
                       and (account_type = 'expense' or subtype = 'owner_draw')) then
    perform public.app_error('FINANCE_PRESET_INVALID',
      'A preset needs a name and an active expense or owner''s draw account.', 422, null);
  end if;
  if exists (select 1 from public.finance_expense_presets
              where lower(label) = lower(btrim(p_label)) and id is distinct from p_id) then
    perform public.app_error('FINANCE_PRESET_INVALID', 'Another preset already uses that name.', 409, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;
  if p_id is null then
    insert into public.finance_expense_presets
      (label, payee, account_id, memo, sort_order, active, created_by, created_by_email)
    values (btrim(p_label), nullif(btrim(coalesce(p_payee,'')),''), p_account_id,
            nullif(btrim(coalesce(p_memo,'')),''), coalesce(p_sort_order, 0), coalesce(p_active, true),
            v_actor, v_email)
    returning id into v_id;
  else
    update public.finance_expense_presets
       set label = btrim(p_label), payee = nullif(btrim(coalesce(p_payee,'')),''),
           account_id = p_account_id, memo = nullif(btrim(coalesce(p_memo,'')),''),
           sort_order = coalesce(p_sort_order, 0), active = coalesce(p_active, true), updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then
      perform public.app_error('FINANCE_PRESET_INVALID', 'That preset no longer exists.', 404, null);
    end if;
  end if;

  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'preset_save', 'expense_preset', v_id,
          jsonb_build_object('label', btrim(p_label), 'account_id', p_account_id));
  return v_id;
end;
$fn$;
revoke all on function public.finance_save_expense_preset(uuid, text, text, uuid, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.finance_save_expense_preset(uuid, text, text, uuid, text, integer, boolean) to authenticated;

create or replace function public.finance_delete_expense_preset(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_label text; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  delete from public.finance_expense_presets where id = p_id returning label into v_label;
  if v_label is null then
    perform public.app_error('FINANCE_PRESET_INVALID', 'That preset no longer exists.', 404, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'preset_delete', 'expense_preset', p_id, jsonb_build_object('label', v_label));
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_delete_expense_preset(uuid) from public, anon, authenticated;
grant execute on function public.finance_delete_expense_preset(uuid) to authenticated;

-- 4c) The bank feed: Add. Posts one balanced entry for a statement line and links it.
-- ★ ONE FORMULA FOR CASH AND CARD, because the statement sign is the account's (see
--   src/lib/bankStatement.js): a positive amount debits the statement's account, a
--   negative one credits it. A deposit is Dr bank / Cr category; a card charge is
--   Dr category / Cr card; a card payment is Dr card / Cr the paying bank (a transfer).
-- ★ COMMITTED IMPORTS ONLY. A staged file can still be discarded, and discarding deletes
--   its rows — which would strand the entry this posted.
create or replace function public.finance_categorize_bank_transaction(
  p_txn_id uuid, p_account_id uuid, p_payee text default null, p_memo text default null
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_t public.finance_bank_transactions%rowtype;
  v_cat public.finance_accounts%rowtype;
  v_amt numeric(14,2); v_lines jsonb; v_kind text; v_attempt int; v_entry uuid;
  v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  -- FOR UPDATE: two tabs pressing Add on the same line must not both post.
  select * into v_t from public.finance_bank_transactions where id = p_txn_id for update;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That bank transaction does not exist.', 404, null);
  end if;
  if not exists (select 1 from public.finance_bank_imports where id = v_t.import_id and status = 'committed') then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Commit the import before adding its transactions to the books.', 409, null);
  end if;
  if v_t.status <> 'unmatched' or v_t.matched_entry_id is not null
     or exists (select 1 from public.finance_reconciliation_items where bank_transaction_id = p_txn_id) then
    perform public.app_error('FINANCE_BANK_TXN_LINKED',
      'That transaction is already added, matched, excluded or reconciled.', 409,
      jsonb_build_object('txn_id', p_txn_id, 'status', v_t.status));
  end if;

  select * into v_cat from public.finance_accounts where id = p_account_id;
  if v_cat.id is null or not v_cat.active or v_cat.id = v_t.account_id then
    perform public.app_error('FINANCE_BANK_CATEGORY_INVALID',
      'Choose an active account other than the statement''s own account.', 422, null);
  end if;

  v_amt := abs(v_t.amount);
  v_lines := case when v_t.amount > 0
    then jsonb_build_array(jsonb_build_object('account_id', v_t.account_id, 'debit', v_amt, 'credit', 0),
                           jsonb_build_object('account_id', v_cat.id,       'debit', 0,     'credit', v_amt))
    else jsonb_build_array(jsonb_build_object('account_id', v_cat.id,       'debit', v_amt, 'credit', 0),
                           jsonb_build_object('account_id', v_t.account_id, 'debit', 0,     'credit', v_amt)) end;
  v_kind := case
    when v_cat.cash_flow_class in ('cash','card')                   then 'transfer'
    when v_cat.subtype = 'owner_draw'                               then 'owner_draw'
    when v_cat.subtype = 'owner_contribution'                       then 'owner_contribution'
    when v_cat.account_type = 'income' and v_t.amount > 0           then 'collection'
    when v_cat.account_type = 'income'                              then 'refund'
    when v_cat.account_type = 'expense'                             then 'expense'
    else 'adjustment' end;

  v_attempt := v_t.categorize_attempts + 1;
  v_entry := public.finance_post_entry(
    v_t.posted_on, v_kind, coalesce(nullif(btrim(coalesce(p_memo,'')),''), v_t.description_raw),
    'bank_import', v_lines, 'bank:' || p_txn_id::text || ':' || v_attempt::text, p_payee, null);

  update public.finance_bank_transactions
     set status = 'matched', matched_entry_id = v_entry, matched_via = 'add',
         categorize_attempts = v_attempt
   where id = p_txn_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'bank_categorize', 'bank_transaction', p_txn_id, v_amt,
          jsonb_build_object('entry_id', v_entry, 'account_id', v_cat.id, 'kind', v_kind));
  return jsonb_build_object('entry_id', v_entry, 'entry_kind', v_kind);
end;
$fn$;
revoke all on function public.finance_categorize_bank_transaction(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finance_categorize_bank_transaction(uuid, uuid, text, text) to authenticated;

-- 4d) The bank feed: Match. Links a statement line to an entry that already exists —
--     usually the collection an approval posted. Nothing is posted.
create or replace function public.finance_match_bank_transaction(p_txn_id uuid, p_entry_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_t public.finance_bank_transactions%rowtype; v_kind text; v_signed numeric(14,2);
  v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_t from public.finance_bank_transactions where id = p_txn_id for update;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That bank transaction does not exist.', 404, null);
  end if;
  if not exists (select 1 from public.finance_bank_imports where id = v_t.import_id and status = 'committed') then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Commit the import before matching its transactions.', 409, null);
  end if;
  if v_t.status <> 'unmatched' or v_t.matched_entry_id is not null
     or exists (select 1 from public.finance_reconciliation_items where bank_transaction_id = p_txn_id) then
    perform public.app_error('FINANCE_BANK_TXN_LINKED',
      'That transaction is already added, matched, excluded or reconciled.', 409, null);
  end if;

  select entry_kind into v_kind from public.finance_journal_entries where id = p_entry_id;
  if v_kind is null then
    perform public.app_error('FINANCE_ENTRY_NOT_FOUND', 'That journal entry does not exist.', 404, null);
  end if;
  if v_kind = 'reversal'
     or exists (select 1 from public.finance_journal_entries where reverses_entry_id = p_entry_id) then
    perform public.app_error('FINANCE_BANK_MATCH_MISMATCH',
      'A reversed entry, or a reversal, cannot be matched to a statement line.', 409, null);
  end if;
  -- ★ One entry, one statement line — checked here for a sentence, enforced by the
  --   unique index for a race.
  if exists (select 1 from public.finance_bank_transactions where matched_entry_id = p_entry_id)
     or exists (select 1 from public.finance_reconciliation_items ri
                 join public.finance_journal_lines jl on jl.id = ri.journal_line_id
                where jl.entry_id = p_entry_id) then
    perform public.app_error('FINANCE_BANK_TXN_LINKED',
      'That entry is already matched to another statement line or reconciled.', 409, null);
  end if;

  select sum(debit - credit) into v_signed
    from public.finance_journal_lines where entry_id = p_entry_id and account_id = v_t.account_id;
  if v_signed is distinct from v_t.amount then
    perform public.app_error('FINANCE_BANK_MATCH_MISMATCH',
      'That entry does not move this account by the same amount as the statement line.', 422,
      jsonb_build_object('statement', v_t.amount, 'entry', v_signed));
  end if;

  update public.finance_bank_transactions
     set status = 'matched', matched_entry_id = p_entry_id, matched_via = 'match'
   where id = p_txn_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'bank_match', 'bank_transaction', p_txn_id, abs(v_t.amount),
          jsonb_build_object('entry_id', p_entry_id));
  return jsonb_build_object('entry_id', p_entry_id);
end;
$fn$;
revoke all on function public.finance_match_bank_transaction(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finance_match_bank_transaction(uuid, uuid) to authenticated;

-- 4e) The bank feed: Undo. A line the feed ADDED is reversed and unlinked; a line it
--     MATCHED is only unlinked, because that entry (an approval, say) is still true.
-- ★ A CLOSED RECONCILIATION FREEZES IT. Feed-linked lines have no reconciliation item, so
--   the check is by account and date, not by item.
create or replace function public.finance_undo_bank_transaction(p_txn_id uuid, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_t public.finance_bank_transactions%rowtype; v_rev jsonb;
  v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_t from public.finance_bank_transactions where id = p_txn_id for update;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That bank transaction does not exist.', 404, null);
  end if;
  if v_t.matched_entry_id is null then
    perform public.app_error('FINANCE_BANK_TXN_NOT_LINKED',
      'That transaction was not added or matched in the feed, so there is nothing to undo.', 409, null);
  end if;
  if exists (select 1 from public.finance_reconciliations r
              where r.account_id = v_t.account_id and r.status = 'closed'
                and v_t.posted_on between r.period_start and r.period_end) then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
      'A closed reconciliation covers this transaction. Reopen it with a reason first.', 409, null);
  end if;

  -- Unlink FIRST: finance_reverse_entry refuses any entry a statement line still points at.
  -- This is one transaction, so if the reversal then refuses (no reason, a live
  -- reclassification) the unlink rolls back with it.
  update public.finance_bank_transactions
     set status = 'unmatched', matched_entry_id = null, matched_via = null
   where id = p_txn_id;

  if v_t.matched_via = 'add' then
    v_rev := public.finance_reverse_entry(v_t.matched_entry_id, p_reason, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail, reason)
  values (v_actor, v_email, 'bank_undo', 'bank_transaction', p_txn_id, abs(v_t.amount),
          jsonb_build_object('entry_id', v_t.matched_entry_id, 'via', v_t.matched_via,
                             'reversal', v_rev),
          nullif(btrim(coalesce(p_reason,'')),''));
  return jsonb_build_object('reversed', v_t.matched_via = 'add',
                            'reversal_period', v_rev->>'period');
end;
$fn$;
revoke all on function public.finance_undo_bank_transaction(uuid, text) from public, anon, authenticated;
grant execute on function public.finance_undo_bank_transaction(uuid, text) to authenticated;


-- == 5) #58's bank and reconciliation functions, restated for the feed ========
-- Each keeps its #58 signature and body, plus the one refusal the feed makes necessary.

-- 5a) Status changes refuse a feed-linked line: excluding it would leave a live entry
--     whose statement line no longer counts, and restoring it to `unmatched` would let
--     it be added a second time.
create or replace function public.finance_bank_txn_set_status(
  p_id uuid, p_status text, p_reason text default null
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_status not in ('unmatched','excluded','duplicate') then
    raise exception 'finance_bank_txn_set_status: unknown status %', p_status using errcode = '22023';
  end if;
  if p_status = 'excluded' and nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_BANK_EXCLUDE_REASON_REQUIRED',
      'Say why this transaction is excluded — otherwise it is indistinguishable from one that '
      'simply went missing.', 422, null);
  end if;
  if exists (select 1 from public.finance_bank_transactions where id = p_id and matched_entry_id is not null) then
    perform public.app_error('FINANCE_BANK_TXN_LINKED',
      'That transaction is added or matched in the bank feed. Undo it there first.', 409,
      jsonb_build_object('txn_id', p_id));
  end if;
  if exists (select 1 from public.finance_reconciliation_items where bank_transaction_id = p_id) then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'That transaction is matched in a reconciliation. Unmatch it there first.', 409,
      jsonb_build_object('txn_id', p_id));
  end if;
  update public.finance_bank_transactions
     set status = p_status, excluded_reason = case when p_status = 'excluded' then p_reason else null end
   where id = p_id;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That transaction does not exist.', 404, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail, reason)
  values (v_actor, v_email, 'bank_txn_status', 'bank_transaction', p_id,
          jsonb_build_object('status', p_status), p_reason);
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_bank_txn_set_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finance_bank_txn_set_status(uuid, text, text) to authenticated;

-- 5b) A reconciliation item may clear only an UNMATCHED line with no feed link, and may
--     name only a ledger line on the reconciliation's own account that the feed has not
--     already claimed. ★ Without this a line the feed cleared could be cleared again here:
--     close would still count the transaction once, but its entry would be claimed twice.
create or replace function public.finance_match_reconciliation_item(
  p_reconciliation_id uuid, p_bank_transaction_id uuid,
  p_journal_line_id uuid default null, p_matched_amount numeric default null
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_amount numeric(14,2); v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select coalesce(p_matched_amount, t.amount) into v_amount
    from public.finance_bank_transactions t
    join public.finance_reconciliations r on r.id = p_reconciliation_id
   where t.id = p_bank_transaction_id
     and t.account_id = r.account_id
     and t.posted_on between r.period_start and r.period_end;
  if v_amount is null then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND',
      'That transaction does not exist, or does not belong to this reconciliation''s account and '
      'period.', 404, null);
  end if;
  if exists (select 1 from public.finance_bank_transactions t
              where t.id = p_bank_transaction_id
                and (t.status <> 'unmatched' or t.matched_entry_id is not null)) then
    perform public.app_error('FINANCE_BANK_TXN_LINKED',
      'That transaction is already cleared in the bank feed, or excluded.', 409, null);
  end if;
  if p_journal_line_id is not null then
    if not exists (select 1 from public.finance_journal_lines jl
                    join public.finance_reconciliations r on r.id = p_reconciliation_id
                   where jl.id = p_journal_line_id and jl.account_id = r.account_id) then
      perform public.app_error('FINANCE_BANK_MATCH_MISMATCH',
        'That ledger line is not on this reconciliation''s account.', 422, null);
    end if;
    if exists (select 1 from public.finance_journal_lines jl
                join public.finance_bank_transactions bt on bt.matched_entry_id = jl.entry_id
               where jl.id = p_journal_line_id) then
      perform public.app_error('FINANCE_BANK_TXN_LINKED',
        'That ledger line''s entry is already matched to a statement line in the bank feed.', 409, null);
    end if;
  end if;

  insert into public.finance_reconciliation_items
    (reconciliation_id, bank_transaction_id, journal_line_id, matched_amount)
  values (p_reconciliation_id, p_bank_transaction_id, p_journal_line_id, v_amount)
  returning id into v_id;

  update public.finance_bank_transactions set status = 'matched' where id = p_bank_transaction_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'reconciliation_match', 'reconciliation', p_reconciliation_id, v_amount,
          jsonb_build_object('bank_transaction_id', p_bank_transaction_id));
  return v_id;
end;
$fn$;
revoke all on function public.finance_match_reconciliation_item(uuid, uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.finance_match_reconciliation_item(uuid, uuid, uuid, numeric) to authenticated;

-- 5c) Unmatching an item resets the line only when the feed does not also hold it.
create or replace function public.finance_unmatch_reconciliation_item(p_item_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_item public.finance_reconciliation_items%rowtype; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_item from public.finance_reconciliation_items where id = p_item_id;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That match no longer exists.', 404, null);
  end if;

  delete from public.finance_reconciliation_items where id = p_item_id;
  update public.finance_bank_transactions
     set status = 'unmatched'
   where id = v_item.bank_transaction_id and status = 'matched' and matched_entry_id is null
     and not exists (select 1 from public.finance_reconciliation_items
                      where bank_transaction_id = v_item.bank_transaction_id);

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'reconciliation_unmatch', 'reconciliation', v_item.reconciliation_id,
          v_item.matched_amount, jsonb_build_object('bank_transaction_id', v_item.bank_transaction_id));
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_unmatch_reconciliation_item(uuid) from public, anon, authenticated;
grant execute on function public.finance_unmatch_reconciliation_item(uuid) to authenticated;

-- 5d) The reconciliation screen: #58's reader, plus the lines cleared in the feed, and
--     candidate ledger lines that exclude entries the feed already claimed.
create or replace function public.finance_reconciliation_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_rec public.finance_reconciliations%rowtype;
  v_acct public.finance_accounts%rowtype;
  v_cleared numeric(14,2);
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_rec from public.finance_reconciliations where id = p_id;
  if not found then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED', 'That reconciliation does not exist.', 404, null);
  end if;
  select * into v_acct from public.finance_accounts where id = v_rec.account_id;

  -- Unchanged from #58, and still what close tests: every `matched` transaction, once —
  -- whether a reconciliation item or the feed cleared it.
  select coalesce(sum(t.amount), 0) into v_cleared
    from public.finance_bank_transactions t
   where t.account_id = v_rec.account_id and t.status = 'matched'
     and t.posted_on between v_rec.period_start and v_rec.period_end;

  return jsonb_build_object(
    'reconciliation', to_jsonb(v_rec),
    'account', jsonb_build_object('id', v_acct.id, 'code', v_acct.code, 'name', v_acct.name,
                                  'cash_flow_class', v_acct.cash_flow_class),
    'cleared', v_cleared,
    'difference', case when v_rec.statement_opening is null or v_rec.statement_closing is null then null
                       else v_rec.statement_closing - v_rec.statement_opening - v_cleared end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'bank_transaction_id', i.bank_transaction_id,
               'journal_line_id', i.journal_line_id, 'matched_amount', i.matched_amount,
               'posted_on', t.posted_on, 'description', t.description_raw, 'amount', t.amount,
               'entry_no', e.entry_no, 'entry_date', e.entry_date, 'entry_memo', e.memo)
               order by t.posted_on, i.created_at)
        from public.finance_reconciliation_items i
        join public.finance_bank_transactions t on t.id = i.bank_transaction_id
        left join public.finance_journal_lines jl on jl.id = i.journal_line_id
        left join public.finance_journal_entries e on e.id = jl.entry_id
       where i.reconciliation_id = p_id), '[]'::jsonb),
    'feed_cleared', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'posted_on', t.posted_on, 'description', t.description_raw,
               'amount', t.amount, 'matched_via', t.matched_via, 'entry_id', t.matched_entry_id,
               'entry_no', e.entry_no, 'entry_memo', e.memo)
               order by t.posted_on, t.created_at)
        from public.finance_bank_transactions t
        left join public.finance_journal_entries e on e.id = t.matched_entry_id
       where t.account_id = v_rec.account_id and t.status = 'matched' and t.matched_entry_id is not null
         and t.posted_on between v_rec.period_start and v_rec.period_end), '[]'::jsonb),
    'open_transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'posted_on', t.posted_on, 'description', t.description_raw,
               'amount', t.amount, 'duplicate_kind', t.duplicate_kind)
               order by t.posted_on, t.created_at)
        from public.finance_bank_transactions t
       where t.account_id = v_rec.account_id and t.status = 'unmatched'
         and t.posted_on between v_rec.period_start and v_rec.period_end), '[]'::jsonb),
    'candidate_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', c.line_id, 'entry_id', c.entry_id, 'entry_no', c.entry_no,
               'entry_date', c.entry_date, 'memo', c.memo, 'amount', c.amount)
               order by c.entry_date, c.entry_no)
        from (
          select jl.id as line_id, e.id as entry_id, e.entry_no, e.entry_date,
                 coalesce(jl.memo, e.memo) as memo, (jl.debit - jl.credit) as amount
            from public.finance_journal_lines jl
            join public.finance_journal_entries e on e.id = jl.entry_id
           where jl.account_id = v_rec.account_id
             and e.entry_date between v_rec.period_start - 7 and v_rec.period_end + 7
             and not exists (select 1 from public.finance_reconciliation_items x
                              where x.journal_line_id = jl.id)
             and not exists (select 1 from public.finance_bank_transactions bt
                              where bt.matched_entry_id = e.id)
           order by e.entry_date, e.entry_no
           limit 500
        ) c), '[]'::jsonb)
  );
end;
$fn$;
revoke all on function public.finance_reconciliation_detail(uuid) from public, anon, authenticated;
grant execute on function public.finance_reconciliation_detail(uuid) to authenticated;

-- 5e) Statement lines, with how the feed holds each one. ★ DROP FIRST: the return type grows.
drop function if exists public.finance_bank_transactions_list(uuid, uuid, text, date, date, integer, integer);
create or replace function public.finance_bank_transactions_list(
  p_import_id uuid default null, p_account_id uuid default null, p_status text default null,
  p_from date default null, p_to date default null,
  p_limit integer default 200, p_offset integer default 0
) returns table (
  id uuid, import_id uuid, account_id uuid, posted_on date, description_raw text, amount numeric,
  balance_after numeric, status text, duplicate_kind text, duplicate_of_id uuid,
  excluded_reason text, matched_entry_id uuid, reconciliation_item_id uuid,
  reconciliation_id uuid, total_count bigint,
  matched_via text, matched_entry_no bigint, matched_entry_memo text, import_status text
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_status is not null and p_status not in ('unmatched','matched','excluded','duplicate') then
    raise exception 'finance_bank_transactions_list: unknown status %', p_status using errcode = '22023';
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  return query
  select t.id, t.import_id, t.account_id, t.posted_on, t.description_raw, t.amount, t.balance_after,
         t.status, t.duplicate_kind, t.duplicate_of_id, t.excluded_reason, t.matched_entry_id,
         ri.item_id, ri.recon_id,
         count(*) over ()::bigint,
         t.matched_via, me.entry_no, me.memo, imp.status
    from public.finance_bank_transactions t
    join public.finance_bank_imports imp on imp.id = t.import_id
    left join public.finance_journal_entries me on me.id = t.matched_entry_id
    left join lateral (
      select x.id as item_id, x.reconciliation_id as recon_id
        from public.finance_reconciliation_items x
       where x.bank_transaction_id = t.id
       order by x.created_at desc
       limit 1
    ) ri on true
   where (p_import_id is null or t.import_id = p_import_id)
     and (p_account_id is null or t.account_id = p_account_id)
     and (p_status is null or t.status = p_status)
     and (p_from is null or t.posted_on >= p_from)
     and (p_to is null or t.posted_on <= p_to)
   order by t.posted_on desc, t.created_at desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_bank_transactions_list(uuid, uuid, text, date, date, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_bank_transactions_list(uuid, uuid, text, date, date, integer, integer) to authenticated;


-- == 6) app_error_catalog() — restated IN FULL ================================
-- ★ One VALUES list, so a delta is not expressible. Carries every #58 code plus #59's six.
create or replace function public.app_error_catalog()
returns table (code text, http int, summary text)
language sql
immutable
parallel safe
set search_path = public
as $cat$
  select * from (values
    ('BATCH_REQUIRED',               422, 'A VIP action needs an explicit batch; none was supplied.'),
    ('BATCH_NOT_FOUND',              404, 'The batch id or month code does not exist.'),
    ('BATCH_CLOSED',                 409, 'The batch is closed to new assignments, or archived.'),
    ('BATCH_FULL',                   409, 'A cohort in the run has no seats left.'),
    ('NO_SPACE_FOR_SEGMENT',         409, 'The batch has no active community space for that plan segment.'),
    ('INVALID_BATCH_CODE',           422, 'Not a real YYYY-MM month.'),
    ('ENTITLEMENT_EXPIRED',          403, 'The membership term (or its grace) has ended.'),
    ('INVALID_PLAN',                 422, 'Unknown, inactive, or non-premium plan for this action.'),
    ('ALREADY_ENTITLED',             409, 'The member already holds an outstanding seat in that cohort.'),
    ('RUN_LIMIT_EXCEEDED',           409, 'Outstanding seats would exceed the per-member ceiling.'),
    ('SEGMENT_MISMATCH',             409, 'The grant would mix cohort segments in one outstanding run.'),
    ('INVALID_MEMBERSHIP_TRANSITION',409, 'The current membership state does not allow this transition.'),
    ('IMMUTABLE_ENTITLEMENT',        409, 'An attempt to rewrite a frozen ledger column.'),
    ('FORBIDDEN',                    403, 'Admin-only operation called by a non-admin.'),
    ('REQUEST_NOT_FOUND',            404, 'The enrollment request does not exist.'),
    ('COURSE_ACCESS_DENIED',         403, 'Course hidden by plan scope, publication, or cohort entitlement.'),
    ('LESSON_NOT_RELEASED',          403, 'The cohort drip has not unlocked this lesson yet.'),
    ('COMMUNITY_ACCESS_DENIED',      403, 'The community write was refused.'),
    ('COMMENT_PERMISSION_DENIED',    403, 'Replies are off in this channel.'),
    ('ASSIGNMENT_CLOSED',            409, 'Past the due date, or the assignment is unpublished.'),
    ('SUBMISSION_LOCKED',            409, 'The submission is handed in or graded; edits refused.'),
    ('COURSE_HAS_SUBMISSIONS',       409, 'The course has graded assignment work and cannot be deleted.'),
    ('BATCH_PAST',                   409, 'The batch period has elapsed in its own timezone; it is read-only.'),
    ('BATCH_CODE_TAKEN',             409, 'Another batch already uses that month code.'),
    ('BATCH_CODE_REORDER',           409, 'The new code would move the batch past a sibling and reorder members'' runs.'),
    ('BATCH_PERIOD_PAST',            422, 'The requested period has already ended; a batch cannot be edited into the past.'),
    ('BATCH_PERIOD_INVALID',         422, 'The end date falls before the start date, or a date is missing.'),
    ('BATCH_TIMEZONE_INVALID',       422, 'Not a timezone Postgres recognises (see pg_timezone_names).'),
    ('BATCH_CAPACITY_BELOW_OCCUPANCY',409,'The new capacity is below the seats already sold in that segment.'),
    ('CHANNEL_NOT_FOUND',            404, 'The channel does not exist, or is not available to you.'),
    ('CHANNEL_SLUG_TAKEN',           409, 'Another channel in this space already uses that address.'),
    ('CHANNEL_AUDIENCE_EMPTY',       422, 'The audience needs at least one plan or batch, or nobody could see it.'),
    ('CHANNEL_ARCHIVED',             409, 'The channel is archived and accepts no new content.'),
    ('CATEGORY_NOT_FOUND',           404, 'The channel category does not exist.'),
    ('CATEGORY_NOT_EMPTY',           409, 'The category still holds active channels.'),
    ('LESSON_VIDEO_UPLOAD_ONLY',     409, 'A lesson video must be an uploaded file in the private bucket; external links are no longer accepted.'),
    ('LESSON_VIDEO_PATH_INVALID',    422, 'An uploaded lesson video must live at lessons/<course-uuid>/<file>.'),
    ('COURSE_PUBLISH_BLOCKED',       409, 'The course still has video lessons with no uploaded file.'),
    ('STAFF_LAST_SUPER_ADMIN',       409, 'That change would leave no active Super Admin. Promote a replacement first.'),
    ('STAFF_NOT_FOUND',              404, 'That account is not staff, or has no profile.'),
    ('STAFF_ROLE_INVALID',           422, 'Unknown staff role or status, or a required reason was missing.'),
    ('COURSE_NOT_ASSIGNED',          403, 'You can edit courses, but not this one — nobody has assigned it to you.'),
    ('COURSE_PUBLISH_FORBIDDEN',     403, 'Publishing or withdrawing a course needs its own permission.'),
    ('COURSE_ASSIGNMENT_INVALID',    422, 'Unknown assignment role, or the target account cannot edit courses at all.'),
    ('SUBSCRIPTION_NOT_FOUND',       404, 'That member has no subscription to act on.'),
    ('EXTENSION_NOT_ALLOWED',        409, 'This membership never expires, so an extension could only shorten it.'),
    ('EXTENSION_INVALID',            422, 'The requested extension is out of range, backwards, or missing its reason.'),
    ('STAFF_NO_INVITATION',          404, 'There is no staff membership on this account to accept.'),
    ('STAFF_INVITATION_NOT_PENDING', 409, 'The membership is suspended, revoked or already active; an old link cannot restore it.'),
    ('STAFF_EMAIL_NOT_VERIFIED',     403, 'The Auth identity has not confirmed the mailbox the invitation was sent to.'),
    ('STAFF_ACCOUNT_REJECTED',       403, 'The account is blocked from the platform, so a staff invitation cannot be accepted on it.'),
    ('ACCESS_REQUEST_SELF_REVIEW',   403, 'A reviewer cannot decide on their own access request.'),
    ('ACCESS_REQUEST_STAFF_TARGET',  409, 'The target holds an invited or active staff membership; withdraw staff access through Team & Roles instead.'),
    ('MODERATION_TARGET_NOT_FOUND',  404, 'The post or reply does not exist, or is not in a channel the moderator can reach.'),
    ('MODERATION_ACTION_INVALID',    422, 'Unknown moderation action.'),
    ('MODERATION_STATE_INVALID',     409, 'The target''s current state does not allow that action (e.g. restoring an author-withdrawn post).'),
    -- ── Financial management (#58) ──
    ('FINANCE_ENTRY_UNBALANCED',     409, 'A journal entry must have at least two lines and equal debits and credits.'),
    ('FINANCE_ENTRY_IMMUTABLE',      409, 'A posted entry, line, payment event or audit row cannot be edited or deleted.'),
    ('FINANCE_ENTRY_ALREADY_REVERSED',409,'That entry has already been reversed; one reversal per entry, ever.'),
    ('FINANCE_ENTRY_NOT_FOUND',      404, 'That journal entry does not exist.'),
    ('FINANCE_ENTRY_FUTURE_DATED',   422, 'An entry cannot be dated in the future; a recurring cost is a template, not a posting.'),
    ('FINANCE_ENTRY_KIND_INVALID',   422, 'Unknown entry kind for this action.'),
    ('FINANCE_PERIOD_LOCKED',        409, 'That accounting period is closed; post the correction in an open period.'),
    ('FINANCE_PERIOD_NOT_ELAPSED',   409, 'Only a period that has fully ended in the business timezone can be closed.'),
    ('FINANCE_PERIOD_INVALID',       422, 'Not a real YYYY-MM period, or the period is not locked.'),
    ('FINANCE_PERIOD_REASON_REQUIRED',422,'Reopening a closed accounting period needs a reason.'),
    ('FINANCE_REVERSAL_REASON_REQUIRED',422,'A reversal needs a reason.'),
    ('FINANCE_ACCOUNTS_NOT_CONFIGURED',409,'The default income or cash account is missing or inactive.'),
    ('FINANCE_ACCOUNT_NOT_FOUND',    404, 'That finance account does not exist.'),
    ('FINANCE_SYSTEM_ACCOUNT',       409, 'A system account cannot be deactivated or retyped.'),
    ('FINANCE_EVENT_AMOUNT_MISMATCH',409, 'The payment event amount does not equal its journal entry.'),
    ('FINANCE_AUDIT_IMMUTABLE',      409, 'The finance audit trail is append-only.'),
    ('FINANCE_IDEMPOTENCY_REQUIRED', 422, 'This action needs an idempotency key so a retry cannot post twice.'),
    ('FINANCE_TIMEZONE_INVALID',     422, 'Not a timezone Postgres recognises (see pg_timezone_names).'),
    ('FINANCE_BANK_TXN_IMMUTABLE',   409, 'The parsed facts of a bank transaction cannot be edited; exclude it with a reason.'),
    ('FINANCE_BANK_IMPORT_DUPLICATE',409, 'That statement file has already been imported into this account.'),
    ('FINANCE_RECONCILIATION_CLOSED',409, 'A closed reconciliation is frozen; reopen it with a reason first.'),
    ('FINANCE_RECONCILIATION_UNBALANCED',409,'A reconciliation whose difference is not zero cannot be closed.'),
    ('FINANCE_COLLECTION_RACE',      409, 'Another transaction recorded this collection first; nothing was duplicated.'),
    ('FINANCE_BANK_IMPORT_STATE',    409, 'That import is not in a state this action allows.'),
    ('FINANCE_BANK_TXN_NOT_FOUND',   404, 'That bank transaction does not exist.'),
    ('FINANCE_BANK_EXCLUDE_REASON_REQUIRED',422,'Excluding a bank transaction needs a reason.'),
    ('FINANCE_ACCOUNT_IN_USE',       409, 'The account is a settings default or a plan''s income account, so it cannot be deactivated.'),
    ('FINANCE_RECURRING_INVALID',    422, 'A recurring template is missing a field, uses an inactive account, or has a schedule that does not match its cadence.'),
    -- ── Finance parity (#59) ──
    ('FINANCE_RECLASSIFY_INVALID',   422, 'Only income to income, expense to expense, or expense to owner''s draw, on an unreversed entry, with a reason.'),
    ('FINANCE_PRESET_INVALID',       422, 'An expense preset needs a unique name and an active expense or owner''s draw account.'),
    ('FINANCE_BANK_TXN_LINKED',      409, 'The statement line, or the entry, is already added, matched, excluded or reconciled.'),
    ('FINANCE_BANK_TXN_NOT_LINKED',  409, 'The statement line is not added or matched in the bank feed, so there is nothing to undo.'),
    ('FINANCE_BANK_MATCH_MISMATCH',  422, 'The entry does not move the statement''s account by the same signed amount.'),
    ('FINANCE_BANK_CATEGORY_INVALID',422, 'A statement line must be added to an active account other than its own.'),
    ('FINANCE_ENTRY_HAS_ADJUSTMENTS',409, 'The entry has a reclassification that still stands; reverse that first.')
  ) as t(code, http, summary);
$cat$;


-- The new table and every new or re-signed RPC are invisible to PostgREST until the
-- cache reloads.
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-14-finance-parity.sql', null,
  'finance parity (#59): the legacy finance app''s day-to-day surface on top of #58. Adds '
  'finance_journal_entries.payee + adjusts_entry_id (frozen by the restated entry guard), a 13th '
  'finance table finance_expense_presets (category-only seed, no amounts, no legacy payees), five '
  'expense accounts, and readers for the pipeline strip, sales by plan and batch, the sales report, '
  'bank account tiles, bank match candidates and P&L drill-down. The ledger list and the P&L are '
  're-signed (payee, amount bounds, quarter/week, an owner''s draw memo excluded from net). Writers: '
  'reclassify, expense presets, and the bank feed''s add / match / undo, keyed per attempt so '
  'undo-then-add posts anew. A unique index lets one entry clear one statement line, and every '
  'reconciliation writer is restated to refuse feed-linked lines, so no transaction or entry can be '
  'cleared twice. No permission changes. SHIP WITH THE CLIENT: the component calls the re-signed RPCs.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) 13 finance tables, each with exactly one SELECT policy:
--      select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and c.relkind = 'r' and c.relname ~ '^finance_';   -> 13
--
-- 2) Exactly one overload of each re-signed function:
--      select proname, count(*) from pg_proc
--       where proname in ('finance_post_entry','finance_post_manual_entry','finance_ledger_list',
--                         'finance_cash_basis_pl','finance_bank_transactions_list')
--       group by proname;                                                              -> 1 each
--
-- 3) The feed link is unique and shaped:
--      select indexname from pg_indexes where indexname = 'finance_bank_txn_entry_once';
--      select conname from pg_constraint where conname = 'finance_bank_txn_link_shape';
--
-- 4) The recurring writer still resolves its 6-argument call to the new entry writer — prove
--    it by posting a due template from Income & Expenses, not by reading the catalog.
--
-- 5) npm run db:audit -> clean, including the #59 checks.
