-- ─────────────────────────────────────────────────────────────────────────────
-- Hardening — cap self-serve extension length (60–365 days)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: an 'extension' enrollment_requests row carries a STUDENT-DECLARED extension_days
-- (months × 30 from the Extend Access modal). approve_extension() (#20) enforced only the
-- 60-day minimum — there was no upper bound, so a tampered insert (the RLS insert policy
-- doesn't validate the number) could present an absurd term for approval, and a rushed
-- admin click would grant it. This adds the missing ceiling in BOTH layers:
--   • approve_extension() now rejects p_days outside 60–365 (the RPC is the only path
--     that turns a request into real access — this is the enforcement that matters).
--   • a CHECK constraint on enrollment_requests.extension_days keeps garbage out of the
--     table itself, so the admin review UI never even sees an out-of-range ask.
-- The client (ExtendAccessModal) offers 2–12 months, so legitimate requests are unaffected.
--
-- ORDER: run AFTER db/2026-07-11-account-membership-requests.sql (#20) — this REPLACES
-- approve_extension with a strict superset (same signature + semantics, plus the cap).
-- The guard below stops with a clear message if #20 hasn't been run.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create-or-replace + guarded constraint add) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard.
do $$
begin
  if to_regproc('public.approve_extension') is null then
    raise exception 'public.approve_extension is missing — run db/2026-07-11-account-membership-requests.sql (#20) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) Range constraint on the stored request column (60–365 days, or null for
--    non-extension kinds). Guarded: skipped if it already exists; if a legacy row is
--    somehow out of range the ADD fails — surface it as a NOTICE instead of aborting,
--    the RPC cap below still protects approvals either way.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'enrollment_requests_extension_days_range'
  ) then
    begin
      alter table public.enrollment_requests
        add constraint enrollment_requests_extension_days_range
        check (extension_days is null or (extension_days between 60 and 365));
    exception when check_violation then
      raise notice 'enrollment_requests has out-of-range extension_days rows — constraint NOT added; clean them up and re-run. approve_extension() still enforces the 60-365 cap.';
    end;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 2) approve_extension() — identical to the #20 version except the p_days validation
--    now enforces BOTH bounds (was: minimum only).
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
  if p_days > 365 then
    raise exception 'approve_extension: maximum extension is 365 days (12 months)';
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

-- 3) Refresh PostgREST's schema cache.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • approve_extension() rejects any extension outside 60–365 days.
--   • enrollment_requests.extension_days is range-constrained at the table level too
--     (null stays valid for new/renewal/upgrade rows).
--   • No client change is REQUIRED (the modal already offers 2–12 months), but the client
--     mirrors the same clamp so the fallback path agrees — see ENROLLMENT_SETUP.md.
-- ─────────────────────────────────────────────────────────────────────────────
