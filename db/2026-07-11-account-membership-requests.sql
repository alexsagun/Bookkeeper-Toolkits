-- ─────────────────────────────────────────────────────────────────────────────
-- Account membership requests — self-serve Extend Access + Upgrade Plan
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the enrollment flow (#12) + subscription lifecycle (#13/#18) already handle a
-- member's FIRST payment and a RENEWAL (re-buy the same/any plan through the paywall's
-- renewal mode → admin Approve → approve_subscription() grants a dated term). This adds
-- two self-serve billing actions on top of that same machinery, driven from a new sidebar
-- account menu:
--   • EXTEND ACCESS — buy more time on the CURRENT plan without changing plan type
--     (minimum 2 months = 60 days), priced from the plan's own price_php/access_days.
--   • UPGRADE PLAN — move to a higher/different plan (full target-plan price → fresh term).
--
-- MODEL: both are just new *kinds* of an enrollment_requests row, so they reuse the
-- existing receipt-upload (enrollment-receipts bucket), RLS, realtime, admin Enrollments
-- review, one-pending-per-user unique index, and notify pipeline — NO parallel table.
--   • request_kind ∈ {new, renewal, upgrade, extension} distinguishes them (default 'new').
--   • extension_days carries the purchased days for an 'extension' row (months × 30, ≥ 60).
--   • UPGRADE approval reuses approve_subscription(p_plan_key = <new plan>) as-is — it
--     already grants the new plan's full term stacked from the current expiry.
--   • EXTENSION approval uses the NEW approve_extension() below — same-plan, custom days.
-- No new RLS is needed: enroll_req_own_insert (student inserts own pending_review row) and
-- enroll_req_admin_all already cover the two new columns; there is still NO student path to
-- status='approved' (admin-only), matching the rest of the flow.
--
-- ORDER: run AFTER db/2026-07-10-subscription-grace.sql (#18) — approve_extension mirrors
-- the grace-3 approve_subscription (supersede + insert, 3-day grace). The guard below stops
-- with a clear message if the enrollment/lifecycle schema is missing.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (add column if not exists + create-or-replace function) — safe to re-run.
-- See ENROLLMENT_SETUP.md → "Extend access & upgrade".
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard — everything below extends the enrollment + lifecycle schema.
do $$
begin
  if to_regclass('public.enrollment_requests') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql (#12) first — public.enrollment_requests is missing.';
  end if;
  if to_regclass('public.subscriptions') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql (#12) first — public.subscriptions is missing.';
  end if;
  -- Bare name only — to_regproc() cannot parse a (argtypes) signature (that's to_regprocedure's
  -- job) and would return NULL for a real function, aborting even a correctly-prepared DB.
  if to_regproc('public.approve_subscription') is null then
    raise exception 'public.approve_subscription is missing — run db/2026-07-04-subscription-lifecycle.sql (#13) and db/2026-07-10-subscription-grace.sql (#18) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) Request-kind + extension days on enrollment_requests.
--    request_kind labels why a request was raised (drives the admin badge and the
--    extension-vs-plan approval branch). Existing rows backfill to 'new' via the default;
--    that is fine — historical rows are already approved/closed and are never re-approved.
--    extension_days is set ONLY for request_kind='extension' (months × 30, ≥ 60).
-- ───────────────────────────────────────────────────────────────────
alter table public.enrollment_requests
  add column if not exists request_kind text not null default 'new';

do $$
begin
  -- Add the check constraint separately so a re-run doesn't error on an existing one.
  if not exists (
    select 1 from pg_constraint where conname = 'enrollment_requests_request_kind_check'
  ) then
    alter table public.enrollment_requests
      add constraint enrollment_requests_request_kind_check
      check (request_kind in ('new', 'renewal', 'upgrade', 'extension'));
  end if;
end $$;

alter table public.enrollment_requests
  add column if not exists extension_days int;

-- ───────────────────────────────────────────────────────────────────
-- 2) approve_extension() — grant EXTRA days on the member's CURRENT plan.
--    Mirrors approve_subscription (SECURITY DEFINER, internal admin guard, supersede the
--    active row + insert a new dated term in ONE transaction, 3-day grace) with three
--    differences: the plan never changes (reuses the latest sub's plan_key), the term
--    length is the REQUEST's extension_days (not a plan's access_days), and it starts from
--    the current expiry while a term is still running, else from now (approval time) for an
--    already-expired member — per the product spec.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.approve_extension(
  p_user_id    uuid,
  p_request_id uuid,
  p_days       int
)
returns public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_grace_days constant int := 3;   -- match approve_subscription's grace window.
  v_prev   public.subscriptions%rowtype;
  v_base   timestamptz;
  v_ends   timestamptz;
  v_grace  timestamptz;
  v_new    public.subscriptions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'approve_extension: admin only';
  end if;

  if p_days is null or p_days < 60 then
    raise exception 'approve_extension: minimum extension is 60 days (2 months)';
  end if;

  -- Latest prior subscription (any status), locked so concurrent approvals serialize.
  select * into v_prev
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1
    for update;

  -- Extension buys MORE time on an existing plan — there must be a plan to extend.
  if v_prev.id is null then
    raise exception 'approve_extension: no subscription to extend for this user';
  end if;

  -- Idempotency: if this exact request already granted the current active term, no-op.
  if v_prev.status = 'active' and v_prev.request_id = p_request_id then
    return v_prev;
  end if;

  -- A legacy no-expiry (lifetime) term already grants unlimited access — never convert it
  -- into a shorter dated term. Leave it untouched and return it (the admin still marks the
  -- request approved; the member keeps their unlimited access).
  if v_prev.status = 'active' and v_prev.ends_at is null then
    return v_prev;
  end if;

  -- Stack from the current expiry while a dated term is still running; else from now
  -- (an already-expired member's extension starts at approval time).
  if v_prev.status = 'active' and v_prev.ends_at is not null and v_prev.ends_at > now() then
    v_base := v_prev.ends_at;
  else
    v_base := now();
  end if;

  v_ends  := v_base + make_interval(days => p_days);
  v_grace := case when v_grace_days = 0 then null
                  else v_ends + make_interval(days => v_grace_days) end;

  -- Supersede whatever is currently active (frees the one-active unique index).
  update public.subscriptions
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'active';

  insert into public.subscriptions
    (user_id, plan_key, status, started_at, ends_at, grace_ends_at,
     approved_by, request_id, renewed_from_subscription_id)
  values
    (p_user_id, v_prev.plan_key, 'active', now(), v_ends, v_grace,
     auth.uid(), p_request_id, v_prev.id)
  returning * into v_new;

  return v_new;
end;
$$;

revoke all on function public.approve_extension(uuid, uuid, int) from public;
grant execute on function public.approve_extension(uuid, uuid, int) to authenticated;

-- 3) Refresh PostgREST's schema cache so the new columns + function are used immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • enrollment_requests gains request_kind ('new'|'renewal'|'upgrade'|'extension') and
--     extension_days. Existing rows are 'new'; new self-serve requests carry the right kind.
--   • Admin Enrollments → Approve routes 'extension' rows through approve_extension() (same
--     plan, extension_days added from the current expiry, or from approval time if expired)
--     and every other kind through approve_subscription() (plan's full term, stacked).
--   • Upgrade requests need no new server code — they are an approve_subscription() call
--     with a different plan_key (full fresh term).
--   • The one-pending-per-user unique index already blocks a second simultaneous request
--     of ANY kind, so a member can't stack confusing duplicate extend/upgrade/renew rows.
-- ─────────────────────────────────────────────────────────────────────────────
