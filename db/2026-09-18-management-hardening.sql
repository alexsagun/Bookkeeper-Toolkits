-- ═════════════════════════════════════════════════════════════════════════════
-- #63 — Management-system hardening: the three server-side findings of the final
--       whole-feature security review of #58–#62
-- 2026-09-18
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- A five-lens adversarial review of the applied system confirmed three defects that live in
-- SQL. None is reachable by a student; each needs a staff member or a legacy row, and each
-- ends in the books or the grants saying something untrue.
--
-- 1. #60's approval-requires-grant guard exempts a member who holds ANY legacy no-expiry
--    subscription, on every request kind and for ever. The exemption exists for one case only:
--    approve_extension returns a grandfathered term unchanged, so no subscription carries that
--    request's id. As written, an Operations Admin could PATCH such a member's request straight
--    to 'approved' through PostgREST (they hold the #48 column grant), granting nothing — while
--    #58's hook still posts the collection. Now the exemption is tied to request_kind.
--
-- 2. The reconciliation ignored bank-import commit status. #59 made "committed" load-bearing for
--    Add and Match and for the account tiles, but the reconciliation read every row, so a STAGED
--    file — one still under review, and not yet through the exact-duplicate pass — was counted as
--    real: close was refused over rows the feed says do not exist, and clearing them stranded the
--    import permanently. Every reconciliation site now joins the committed imports, matching
--    refuses an uncommitted line outright, and the commit pass can no longer flip an already
--    reconciled row to 'duplicate'. Because "committed" is now the only way into a reconciliation,
--    commit and discard lock the import row (two tabs could both pass the status check), commit
--    refuses to drop unreviewed lines into a CLOSED reconciliation, and the likely-duplicate pass
--    no longer points at a line of another file that is still staged and may be discarded.
--
-- 3. enrollment_requests.amount_paid is typed by the STUDENT and had no ceiling. A pasted phone
--    number posts as pesos into an append-only ledger; a larger value overflows the line's own
--    numeric(14,2) and aborts the approval with a bare 22003 — and the same overflow aborts the
--    whole backfill. It is now bounded at the ceiling admin_correct_enrollment_amount already
--    used (added NOT VALID then validated, so no legacy row can switch the bound off), the hook
--    names its own refusal, the comped-approval test and the backfill filter read the amount
--    ROUNDED to centavos — which is what the ledger lines hold — and the backfill skips an
--    out-of-range legacy row instead of dying on it.
--
-- HOW
--
-- Every function here is the CURRENT body — #59's where #59 restated it, #58's otherwise — with
-- the edit applied to it. Nothing is retyped: db/2026-09-18-management-hardening.sql is assembled
-- by a script from those sources, because a hand-copied body is how #33 dropped #32's
-- housekeeping and #59's feed refusals would vanish the same way. Each source body was checked
-- against production (md5 of prosrc) before it was copied.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-17-meetings-tasks.sql') then
    raise exception '#63: run db/2026-09-17-meetings-tasks.sql (#62) first — it owns the error catalog this file restates.';
  end if;
  if to_regprocedure('public.finance_reconciliation_detail(uuid)') is null
     or to_regprocedure('public.enrollment_approval_requires_grant()') is null then
    raise exception '#63: #58/#59/#60 must be applied first.';
  end if;
  if (select count(*) from public.staff_permissions) <> 22 then
    raise exception '#63: expected 22 staff permissions (this file changes none).';
  end if;
end
$pre$;


-- == 1) An approval still requires its grant, except on the extension path =====

create or replace function public.enrollment_approval_requires_grant()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not public.is_super_admin()
     and not exists (select 1 from public.subscriptions s where s.request_id = new.id)
     -- approve_extension returns a grandfathered no-expiry term unchanged, so no row
     -- carries this request's id. That member is still granted; let it through.
     and not (new.request_kind = 'extension'
              and exists (select 1 from public.subscriptions s
                           where s.user_id = new.user_id and s.status = 'active' and s.ends_at is null)) then
    perform public.app_error('ENROLLMENT_APPROVE_VIA_RPC',
      'Approve this request from the Enrollments screen — that grants the membership in the same step.', 409,
      jsonb_build_object('request_id', new.id));
  end if;
  return new;
end;
$fn$;
revoke all on function public.enrollment_approval_requires_grant() from public, anon, authenticated;

-- == 2) A reconciliation counts only committed statement lines ================

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
  -- ★ LOCK THE LINE FIRST. Without it a feed Add committing between this function's checks
  --   and its insert would leave one line cleared twice — by the feed and by this item.
  perform 1 from public.finance_bank_transactions where id = p_bank_transaction_id for update;
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
  -- ★ A STAGED FILE IS NOT A STATEMENT. The feed already refuses to Add or Match a line whose import
  --   is not committed; reconciliation must refuse it too, or a file still under review is cleared
  --   here, its rows are counted, and the import can then never be discarded.
  if not exists (select 1 from public.finance_bank_transactions t
                   join public.finance_bank_imports bi on bi.id = t.import_id
                  where t.id = p_bank_transaction_id and bi.status = 'committed') then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Commit the import before reconciling its transactions.', 409, null);
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
                join public.finance_bank_transactions bt
                  on bt.matched_entry_id = jl.entry_id and bt.account_id = jl.account_id
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

  -- Still every `matched` transaction once, whether a reconciliation item or the feed cleared
  -- it, and still exactly what close tests — but COMMITTED IMPORTS ONLY (#63). A staged file is
  -- one still under review, not yet through the exact-duplicate pass, and counting it cleared
  -- here while the feed says it does not exist is how close came to be refused over rows nobody
  -- could reach.
  select coalesce(sum(t.amount), 0) into v_cleared
    from public.finance_bank_transactions t
      join public.finance_bank_imports bi on bi.id = t.import_id and bi.status = 'committed'
   where t.account_id = v_rec.account_id and t.status = 'matched'
     and t.posted_on between v_rec.period_start and v_rec.period_end;

  return jsonb_build_object(
    'reconciliation', to_jsonb(v_rec),
    'account', jsonb_build_object('id', v_acct.id, 'code', v_acct.code, 'name', v_acct.name,
                                  'cash_flow_class', v_acct.cash_flow_class),
    'cleared', v_cleared,
    -- ★ A CARD STATEMENT SHOWS WHAT IS OWED, which rises with charges — but a charge is stored
    --   NEGATIVE (the account's convention). So for a card the statement's movement is
    --   negated before cleared is subtracted; without it every card reconciliation was off by
    --   twice its charges and could never close. finance_close_reconciliation tests the same.
    'balance_convention', case when v_acct.cash_flow_class = 'card' then 'owed' else 'held' end,
    'difference', case when v_rec.statement_opening is null or v_rec.statement_closing is null then null
                       else (case when v_acct.cash_flow_class = 'card' then -1 else 1 end)
                            * (v_rec.statement_closing - v_rec.statement_opening) - v_cleared end,
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
          join public.finance_bank_imports bi on bi.id = t.import_id and bi.status = 'committed'
        left join public.finance_journal_entries e on e.id = t.matched_entry_id
       where t.account_id = v_rec.account_id and t.status = 'matched' and t.matched_entry_id is not null
         and t.posted_on between v_rec.period_start and v_rec.period_end), '[]'::jsonb),
    'open_transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'posted_on', t.posted_on, 'description', t.description_raw,
               'amount', t.amount, 'duplicate_kind', t.duplicate_kind)
               order by t.posted_on, t.created_at)
        from public.finance_bank_transactions t
          join public.finance_bank_imports bi on bi.id = t.import_id and bi.status = 'committed'
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
                              where bt.matched_entry_id = e.id and bt.account_id = v_rec.account_id)
           order by e.entry_date, e.entry_no
           limit 500
        ) c), '[]'::jsonb)
  );
end;
$fn$;
revoke all on function public.finance_reconciliation_detail(uuid) from public, anon, authenticated;
grant execute on function public.finance_reconciliation_detail(uuid) to authenticated;

create or replace function public.finance_close_reconciliation(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_rec public.finance_reconciliations%rowtype;
  v_cleared numeric(14,2); v_diff numeric(14,2); v_open int; v_sign int;
  v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_rec from public.finance_reconciliations where id = p_id for update;
  if not found or v_rec.status <> 'open' then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
      'That reconciliation is not open.', 409, null);
  end if;

  select count(*) into v_open
    from public.finance_bank_transactions t
      join public.finance_bank_imports bi on bi.id = t.import_id and bi.status = 'committed'
   where t.account_id = v_rec.account_id
     and t.posted_on between v_rec.period_start and v_rec.period_end
     and t.status = 'unmatched';
  if v_open > 0 then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'There are still unreviewed transactions in this period. Match or exclude each one, then '
      'close.', 409, jsonb_build_object('unmatched', v_open));
  end if;

  -- ★ A MISSING STATEMENT BALANCE IS NOT ZERO (#58).
  if v_rec.statement_opening is null or v_rec.statement_closing is null then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'This reconciliation has no statement opening or closing balance, so there is nothing to '
      'reconcile against. Enter both figures from the statement.', 409, null);
  end if;

  select coalesce(sum(t.amount), 0) into v_cleared
    from public.finance_bank_transactions t
      join public.finance_bank_imports bi on bi.id = t.import_id and bi.status = 'committed'
   where t.account_id = v_rec.account_id
     and t.posted_on between v_rec.period_start and v_rec.period_end
     and t.status = 'matched';
  -- A card statement's balances are amounts OWED; see finance_reconciliation_detail.
  select case when cash_flow_class = 'card' then -1 else 1 end into v_sign
    from public.finance_accounts where id = v_rec.account_id;
  v_diff := coalesce(v_sign, 1) * (v_rec.statement_closing - v_rec.statement_opening) - v_cleared;

  if v_diff <> 0 then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'This does not reconcile yet — the difference is not zero.', 409,
      jsonb_build_object('difference', v_diff, 'cleared', v_cleared));
  end if;

  select email into v_email from public.profiles where id = v_actor;
  update public.finance_reconciliations
     set status = 'closed', difference = 0, closed_at = now(),
         closed_by = v_actor, closed_by_email = v_email
   where id = p_id;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'reconciliation_close', 'reconciliation', p_id, v_cleared, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'cleared', v_cleared);
end;
$fn$;
revoke all on function public.finance_close_reconciliation(uuid) from public, anon, authenticated;
grant execute on function public.finance_close_reconciliation(uuid) to authenticated;

create or replace function public.finance_reconciliations_list(
  p_account_id uuid default null, p_limit integer default 50, p_offset integer default 0
) returns table (
  id uuid, account_id uuid, account_code text, account_name text, period_start date, period_end date,
  statement_opening numeric, statement_closing numeric, difference numeric, status text,
  closed_at timestamptz, closed_by_email text, reopened_at timestamptz, reopen_reason text,
  created_at timestamptz, matched_count bigint, unmatched_count bigint, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  return query
  select r.id, r.account_id, a.code, a.name, r.period_start, r.period_end,
         r.statement_opening, r.statement_closing, r.difference, r.status,
         r.closed_at, r.closed_by_email, r.reopened_at, r.reopen_reason, r.created_at,
         (select count(*) from public.finance_reconciliation_items x where x.reconciliation_id = r.id),
         -- The same population finance_close_reconciliation refuses to close over.
         (select count(*) from public.finance_bank_transactions t
             join public.finance_bank_imports bi on bi.id = t.import_id and bi.status = 'committed'
           where t.account_id = r.account_id and t.status = 'unmatched'
             and t.posted_on between r.period_start and r.period_end),
         count(*) over ()::bigint
    from public.finance_reconciliations r
    join public.finance_accounts a on a.id = r.account_id
   where p_account_id is null or r.account_id = p_account_id
   order by r.period_end desc, r.created_at desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_reconciliations_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_reconciliations_list(uuid, integer, integer) to authenticated;

create or replace function public.finance_commit_bank_import(p_import_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_imp public.finance_bank_imports%rowtype;
  v_window int; v_exact int := 0; v_likely int := 0; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  -- ★ LOCK THE IMPORT (#63). Two tabs pressing Commit both saw 'parsed'; the second then re-ran the
  --   duplicate passes over rows the first had already set aside, and overwrote duplicate_row_count
  --   with 0. Discard takes the same lock, so commit and discard of one file are serialized.
  select * into v_imp from public.finance_bank_imports where id = p_import_id for update;
  if not found or v_imp.status <> 'parsed' then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'That import is not open for review.', 409, null);
  end if;
  select coalesce(bank_duplicate_day_window, 3) into v_window from public.finance_settings where id;

  with dup as (
    select t.id, prior.id as of_id
      from public.finance_bank_transactions t
      join public.finance_bank_transactions prior
        on prior.fingerprint = t.fingerprint and prior.import_id <> t.import_id
      join public.finance_bank_imports pi on pi.id = prior.import_id and pi.status = 'committed'
     where t.import_id = p_import_id and t.status = 'unmatched'
  )
  update public.finance_bank_transactions t
     set status = 'duplicate', duplicate_kind = 'exact', duplicate_of_id = dup.of_id
    from dup where t.id = dup.id;
  get diagnostics v_exact = row_count;

  with near as (
    select distinct t.id, other.id as of_id
      from public.finance_bank_transactions t
      join public.finance_bank_transactions other
        on other.account_id = t.account_id and other.id <> t.id
       and abs(other.amount) = abs(t.amount)
       and abs(other.posted_on - t.posted_on) <= v_window
       and other.fingerprint <> t.fingerprint
      -- ★ #63: another FILE's line counts only once that file is committed. A staged file can be
      --   discarded, which deletes its rows and nulls duplicate_of_id, leaving this line flagged
      --   "possible duplicate" of nothing, for good. Lines of this same file still compare.
      join public.finance_bank_imports oi on oi.id = other.import_id
                                         and (oi.status = 'committed' or other.import_id = t.import_id)
     where t.import_id = p_import_id and t.status = 'unmatched'
  )
  update public.finance_bank_transactions t
     set duplicate_kind = 'likely', duplicate_of_id = near.of_id
    from near where t.id = near.id;
  get diagnostics v_likely = row_count;

  -- ★ A STATEMENT MAY NOT LAND IN A CLOSED PERIOD (#63). Reconciliation now counts only committed
  --   lines, so a period can close while its statement is still staged; committing afterwards would
  --   drop unreviewed lines into a closed reconciliation, where Add, Match and Exclude all refuse
  --   them. A line set aside as a duplicate here is not a line anyone has to review.
  if exists (select 1
               from public.finance_bank_transactions t
               join public.finance_reconciliations r
                 on r.account_id = t.account_id and r.status = 'closed'
                and t.posted_on between r.period_start and r.period_end
              where t.import_id = p_import_id and t.status = 'unmatched') then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
      'Part of this statement falls inside a closed reconciliation. Reopen that reconciliation, then '
      'commit the import.', 409, jsonb_build_object('import_id', p_import_id));
  end if;

  update public.finance_bank_imports
     set status = 'committed', committed_at = now(),
         duplicate_row_count = v_exact,
         imported_row_count = (select count(*) from public.finance_bank_transactions
                                where import_id = p_import_id and status <> 'duplicate')
   where id = p_import_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'bank_import_commit', 'bank_import', p_import_id,
          jsonb_build_object('exact_duplicates', v_exact, 'likely_flagged', v_likely));
  return jsonb_build_object('exact_duplicates', v_exact, 'likely_flagged', v_likely);
end;
$fn$;
revoke all on function public.finance_commit_bank_import(uuid) from public, anon, authenticated;
grant execute on function public.finance_commit_bank_import(uuid) to authenticated;

create or replace function public.finance_discard_bank_import(p_import_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text; v_status text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  -- ★ LOCK THE IMPORT (#63), the lock finance_commit_bank_import takes. Without it a discard that
  --   read 'parsed' could delete every row of a file another session was committing — including a
  --   line a feed Add had just posted against — and then overwrite 'committed' with 'discarded'.
  select status into v_status from public.finance_bank_imports where id = p_import_id for update;
  -- A committed run's rows may already be matched to journal entries; discarding it
  -- would cascade them away and silently unpick real reconciliation work.
  if v_status is distinct from 'parsed' then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Only an un-committed import can be discarded.', 409, null);
  end if;
  -- ★ Since #63 reconciliation refuses a line of an uncommitted import, so this is reachable only
  --   for a line matched before #63 — kept, because finance_reconciliation_items.bank_transaction_id
  --   is ON DELETE RESTRICT and without it the delete below raises a bare 23503 foreign-key error.
  if exists (
    select 1 from public.finance_reconciliation_items i
     join public.finance_bank_transactions t on t.id = i.bank_transaction_id
    where t.import_id = p_import_id
  ) then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Some transactions from this import are already matched to a reconciliation. Unmatch them '
      'before discarding the import.', 409, null);
  end if;
  delete from public.finance_bank_transactions where import_id = p_import_id;
  update public.finance_bank_imports set status = 'discarded' where id = p_import_id;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail, reason)
  values (v_actor, v_email, 'bank_import_discard', 'bank_import', p_import_id, '{}'::jsonb, p_reason);
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_discard_bank_import(uuid, text) from public, anon, authenticated;
grant execute on function public.finance_discard_bank_import(uuid, text) to authenticated;

-- == 3) A collection may only post an amount the books can hold ===============

-- ★ The same ceiling admin_correct_enrollment_amount enforces (#60).
-- ★ ADDED NOT VALID, THEN VALIDATED — never skipped. #30's idiom skipped the whole constraint when
--   a legacy row failed it, and said so only in a NOTICE, which the Management API discards: the
--   bound would have vanished for every FUTURE write while the log row claimed it existed. NOT VALID
--   binds every insert and update from this moment; the validation alone is tolerant. A legacy row
--   over the bound leaves it convalidated = false (db:audit reports that), and until that row is
--   corrected an update to it is refused too — the price of never accepting a new one.
do $amt$
begin
  if not exists (select 1 from pg_constraint where conname = 'enrollment_requests_amounts_bounded') then
    alter table public.enrollment_requests
      add constraint enrollment_requests_amounts_bounded
      check (amount_paid <= 1000000 and amount_expected <= 1000000) not valid;
  end if;
  if exists (select 1 from pg_constraint where conname = 'enrollment_requests_amounts_bounded' and not convalidated) then
    begin
      alter table public.enrollment_requests validate constraint enrollment_requests_amounts_bounded;
    exception when check_violation then
      raise notice '#63: enrollment_requests holds an out-of-range amount — the bound binds new writes but is NOT validated. Correct those rows and re-run this file.';
    end;
  end if;
end
$amt$;

create or replace function public.finance_enrollment_collection_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_cfg     public.finance_settings%rowtype;
  v_income  uuid;
  v_cash    uuid;
  v_entry   uuid;
  v_event   uuid;
  v_key     text;
  v_date    date;
  v_email   text;
  v_actor   uuid := auth.uid();
  v_mapped  uuid;
begin
  -- ★ A COMPED APPROVAL IS NOT REVENUE. A zero entry would also violate
  --   sum(debit) > 0. The enrollment still appears in the receivables worklist
  --   as contract value with zero collection, which is the truthful picture.
  -- ★ #63: the ROUNDED amount, because that is what the lines hold. ₱0.004 passed "> 0", rounded to
  --   two 0.00 lines and aborted the approval on finance_line_one_side with an unnamed 23514.
  if round(coalesce(new.amount_paid, 0), 2) <= 0 then
    return null;
  end if;
  -- ★ THE STUDENT TYPES THIS FIGURE. A pasted phone number (09171234567) fits numeric(14,2), so
  --   without a ceiling it posts as pesos into an append-only ledger; past 1e12 it overflows the
  --   line's own type and aborts the approval with a bare 22003. Name the refusal, at the same
  --   ceiling admin_correct_enrollment_amount already enforces, and let the reviewer correct it.
  if new.amount_paid > 1000000 then
    perform public.app_error('FINANCE_COLLECTION_AMOUNT_INVALID',
      'This enrollment records an amount outside the range a collection may post. Use "Correct amount" '
      'on the request before approving it.', 422, jsonb_build_object('request_id', new.id));
  end if;

  select * into v_cfg from public.finance_settings where id;
  v_cash := v_cfg.default_cash_account_id;

  -- The plan's own income account (§4b) when one is mapped AND usable, else the default.
  -- ★ AN UNUSABLE MAPPING FALLS BACK; IT DOES NOT REFUSE. Refusing here would stop
  --   every Operations Admin approving that plan. finance_save_account refuses to
  --   deactivate a mapped account, so this arm is reachable only by hand-edited SQL,
  --   and the audit row below records which account was actually used.
  select a.id into v_mapped
    from public.enrollment_plans p
    join public.finance_accounts a on a.id = p.finance_income_account_id
                                  and a.active and a.account_type = 'income'
   where p.key = new.plan_key;
  v_income := coalesce(v_mapped, v_cfg.default_income_account_id);

  if v_income is null or v_cash is null
     or not exists (select 1 from public.finance_accounts where id = v_income and active)
     or not exists (select 1 from public.finance_accounts where id = v_cash and active) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'Finance is not configured: the default income or cash account is missing or inactive. '
      'Set them in Financial Management before approving payments.', 409, null);
  end if;

  -- ★ NO amount, timestamp, actor or plan in the key. An amount would let a
  --   retry after an edit mint a second revenue row; a timestamp would make
  --   every retry unique; an actor would let two admins each mint one; a plan
  --   would break on an upgrade.
  v_key  := 'enrollment:' || new.id::text || ':collection';
  v_date := (coalesce(new.reviewed_at, now()) at time zone coalesce(v_cfg.reporting_timezone,'Asia/Manila'))::date;

  -- ★ CHECK BEFORE CREATING ANYTHING. The obvious shape — insert the entry, then
  --   ON CONFLICT DO NOTHING on the event, then delete the orphan entry — CANNOT
  --   WORK HERE: finance_line_guard is a BEFORE DELETE trigger that always raises
  --   FINANCE_ENTRY_IMMUTABLE, so the "safe cleanup" would abort a legitimate
  --   approval. The unique index on idempotency_key remains the backstop for a
  --   genuine race; in practice admin_finalize_enrollment holds a row lock on
  --   this request, so a second concurrent approval sees status='approved' and
  --   refuses before ever reaching this trigger.
  if exists (select 1 from public.finance_payment_events where idempotency_key = v_key) then
    return null;
  end if;

  select email into v_email from public.profiles where id = v_actor;

  insert into public.finance_journal_entries
    (entry_date, entry_kind, memo, source, created_by, created_by_email)
  values (v_date, 'collection',
          coalesce(new.plan_name, new.plan_key) || ' — ' || coalesce(new.email, new.full_name, 'student'),
          'approval', v_actor, v_email)
  returning id into v_entry;

  insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit) values
    (v_entry, 1, v_cash,   round(new.amount_paid, 2), 0),
    (v_entry, 2, v_income, 0,                            round(new.amount_paid, 2));

  insert into public.finance_payment_events
    (event_kind, direction, occurred_on, amount, journal_entry_id, idempotency_key,
     enrollment_request_id, student_user_id, student_email, plan_key, plan_name,
     method, reference, source, created_by, created_by_email)
  values ('enrollment_collection', 'in', v_date, round(new.amount_paid, 2), v_entry, v_key,
          new.id, new.user_id, new.email, new.plan_key, new.plan_name,
          'unknown', new.payment_reference, 'approval', v_actor, v_email)
  on conflict (idempotency_key) do nothing
  returning id into v_event;

  if v_event is null then
    -- Only reachable if another transaction inserted the same key between the
    -- check above and here. Raising aborts the whole approval, which is the
    -- honest outcome: the collection is already recorded, so this approval must
    -- not also claim it. It cannot be "cleaned up" — see the note above.
    perform public.app_error('FINANCE_COLLECTION_RACE',
      'This collection was recorded by another request a moment ago. Refresh and check the '
      'enrollment before approving again — no duplicate was created.', 409,
      jsonb_build_object('request_id', new.id));
  end if;

  -- ★ NO EXCEPTION HANDLER ANYWHERE IN THIS BODY. If the audit write fails, the
  --   approval fails. The legacy logger wrapped every audit write in an empty
  --   catch, so the trail silently stopped being complete.
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'entry_post', 'journal_entry', v_entry, round(new.amount_paid, 2),
          jsonb_build_object('source','approval','request_id',new.id,'plan_key',new.plan_key,
                             'income_account_id', v_income, 'plan_mapped', v_mapped is not null));

  return null;
end;
$fn$;

create or replace function public.finance_backfill_enrollment_collections(
  p_dry_run boolean default true, p_limit integer default 5000
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_cfg public.finance_settings%rowtype;
  v_income uuid; v_cash uuid; v_actor uuid := auth.uid(); v_email text;
  v_candidate int := 0; v_posted int := 0; v_skipped int := 0;
  r record; v_entry uuid; v_event uuid; v_key text; v_date date; v_row_income uuid;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;

  select * into v_cfg from public.finance_settings where id;
  v_income := v_cfg.default_income_account_id;
  v_cash   := v_cfg.default_cash_account_id;
  if v_income is null or v_cash is null then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'Set the default income and cash accounts before running the backfill.', 409, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;

  for r in
    select er.* from public.enrollment_requests er
     where er.status = 'approved' and round(coalesce(er.amount_paid, 0), 2) > 0
       -- Out-of-range legacy rows are LEFT for a reviewer: one of them must not abort the run.
       and er.amount_paid <= 1000000
       and not exists (select 1 from public.finance_payment_events pe
                        where pe.idempotency_key = 'enrollment:' || er.id::text || ':collection')
     order by er.reviewed_at nulls last
     limit greatest(1, least(coalesce(p_limit, 5000), 20000))
  loop
    v_candidate := v_candidate + 1;
    if p_dry_run then continue; end if;

    v_key  := 'enrollment:' || r.id::text || ':collection';
    v_date := (coalesce(r.reviewed_at, r.created_at) at time zone coalesce(v_cfg.reporting_timezone,'Asia/Manila'))::date;

    -- The same account the hook would have chosen: the plan's mapped income account
    -- when it is an ACTIVE income account, else the default. A backfilled collection
    -- must land exactly where a live approval of the same request would have.
    select a.id into v_row_income
      from public.enrollment_plans p
      join public.finance_accounts a on a.id = p.finance_income_account_id
                                    and a.active and a.account_type = 'income'
     where p.key = r.plan_key;
    v_row_income := coalesce(v_row_income, v_income);

    insert into public.finance_journal_entries
      (entry_date, entry_kind, memo, source, created_by, created_by_email)
    values (v_date, 'collection',
            coalesce(r.plan_name, r.plan_key) || ' — backfill', 'backfill', v_actor, v_email)
    returning id into v_entry;

    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit) values
      (v_entry, 1, v_cash,       round(r.amount_paid, 2), 0),
      (v_entry, 2, v_row_income, 0,                          round(r.amount_paid, 2));

    insert into public.finance_payment_events
      (event_kind, direction, occurred_on, amount, journal_entry_id, idempotency_key,
       enrollment_request_id, student_user_id, student_email, plan_key, plan_name,
       method, reference, source, created_by, created_by_email)
    values ('enrollment_collection', 'in', v_date, round(r.amount_paid, 2), v_entry, v_key,
            r.id, r.user_id, r.email, r.plan_key, r.plan_name, 'unknown',
            r.payment_reference, 'backfill', v_actor, v_email)
    on conflict (idempotency_key) do nothing
    returning id into v_event;

    if v_event is null then
      -- The loop already filtered these out, so this means a concurrent writer.
      -- The orphan entry cannot be deleted (finance_line_guard always raises), so
      -- aborting the run is the only honest option — nothing partial is left
      -- behind, because the whole statement rolls back.
      perform public.app_error('FINANCE_COLLECTION_RACE',
        'A collection for this enrollment was recorded while the backfill was running. '
        'Nothing was written; run it again.', 409, jsonb_build_object('request_id', r.id));
    else
      v_posted := v_posted + 1;
    end if;
  end loop;

  -- ★ The counts go into an AUDIT ROW, not a raise notice: the Management API
  --   discards notices entirely, so the block proves its own postcondition.
  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, detail)
  values (v_actor, v_email, 'backfill_run', 'enrollment_collections',
          jsonb_build_object('dry_run', p_dry_run, 'candidates', v_candidate,
                             'posted', v_posted, 'skipped', v_skipped));

  return jsonb_build_object('dry_run', p_dry_run, 'candidates', v_candidate,
                            'posted', v_posted, 'skipped', v_skipped);
end;
$fn$;
revoke all on function public.finance_backfill_enrollment_collections(boolean, integer) from public, anon, authenticated;
grant execute on function public.finance_backfill_enrollment_collections(boolean, integer) to authenticated;

-- == 4) app_error_catalog() — restated IN FULL ================================
-- #62's catalog plus FINANCE_COLLECTION_AMOUNT_INVALID (112 codes).

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
    ('FINANCE_ENTRY_HAS_ADJUSTMENTS',409, 'The entry has a reclassification that still stands; reverse that first.'),
    ('FINANCE_BANK_ENROLLMENT_INCOME',409, 'A deposit cannot be added to an account approvals post to; match it to the approval instead.'),
    -- ── Enrollment management (#60) ──
    ('ENROLLMENT_NOT_PENDING',       409, 'Only a request still awaiting review can be held or corrected.'),
    ('ENROLLMENT_HOLD_INVALID',      422, 'A hold needs a reason and a follow-up date that is not in the past, or the request is not on hold.'),
    ('ENROLLMENT_AMOUNT_INVALID',    422, 'An amount correction needs a reason and an amount between 0 and 1,000,000.'),
    ('ENROLLMENT_APPROVE_VIA_RPC',   409, 'A request can only be approved together with its membership grant.'),
    -- ── Communications (#61) ──
    ('COMM_AUDIENCE_INVALID',        422, 'The audience is not valid for this kind of message.'),
    ('COMM_AUDIENCE_EMPTY',          422, 'No one matches this audience.'),
    ('COMM_MESSAGE_INVALID',         422, 'A message needs a subject of up to 200 characters and a body of up to 20,000.'),
    ('COMM_DAILY_CAP',               429, 'Sending this would pass today''s email limit.'),
    ('COMM_RULE_INVALID',            422, 'The automation rule is incomplete or inconsistent.'),
    ('COMM_NOT_FOUND',               404, 'The campaign or automation rule does not exist.'),
    ('COMM_CAMPAIGN_CLOSED',         409, 'The campaign was cancelled.'),
    ('COMM_CAP_INVALID',             422, 'The daily limit must be between 1 and 50,000.'),
    ('MEETING_INVALID',              422, 'The meeting, invitation or template details are incomplete or inconsistent.'),
    ('MEETING_NOT_FOUND',            404, 'The meeting or meeting template does not exist.'),
    ('TASK_INVALID',                 422, 'A task needs a title of up to 300 characters and a day, week or month.'),
    ('TASK_NOT_FOUND',               404, 'The task does not exist.'),
    ('ZOOM_NOT_CONNECTED',           503, 'Zoom is not connected: the server Zoom credentials are missing or were refused.'),
    ('ZOOM_REQUEST_FAILED',          502, 'Zoom did not complete the request.'),
    ('MEETING_LOG_FAILED',           502, 'The meeting was created in Zoom but could not be recorded here, so no invitations were sent.'),
    ('FINANCE_COLLECTION_AMOUNT_INVALID',422, 'The enrollment records an amount outside the range a collection may post.')
  ) as t(code, http, summary);
$cat$;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-18-management-hardening.sql', null,
  'management hardening (#63): the three SQL findings of the final #58-#62 security review. #60''s '
  'approval-requires-grant exemption is tied to request_kind = ''extension'' instead of to any member '
  'holding a legacy no-expiry term. Every reconciliation site (match, detail, close, list) counts only '
  'transactions whose import is committed, matching refuses an uncommitted line, and the commit pass no '
  'longer flips an already-reconciled row to duplicate; commit and discard lock the import row, commit '
  'refuses lines inside a closed reconciliation, and likely duplicates point only at committed files or '
  'the same file. enrollment_requests amounts are bounded at 1,000,000 (NOT VALID, then validated), the '
  'approval hook names FINANCE_COLLECTION_AMOUNT_INVALID instead of overflowing numeric(14,2), the '
  'comped test and backfill filter read the rounded amount, and the backfill skips an out-of-range legacy '
  'row. No permission changes (22 permissions / 35 grants). Restates app_error_catalog() (112 codes).')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) Nothing moved in the permission matrix:
--      select count(*) from public.staff_permissions;                             -> 22
--      select count(*) from public.staff_role_permissions;                        -> 35
-- 2) The catalog:  select count(*) from public.app_error_catalog();               -> 112
-- 3) The bound exists AND is validated (false means a legacy row is over it — see the notice):
--      select convalidated from pg_constraint where conname = 'enrollment_requests_amounts_bounded'; -> true
-- 4) The reconciliation reads only committed imports:
--      select count(*) from pg_proc where proname in ('finance_reconciliation_detail',
--        'finance_close_reconciliation', 'finance_reconciliations_list', 'finance_match_reconciliation_item')
--        and prosrc like '%finance_bank_imports bi%';                             -> 4
-- 5) Nothing to backfill or correct by hand unless the notice fired in step 3.
