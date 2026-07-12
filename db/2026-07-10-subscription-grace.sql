-- ─────────────────────────────────────────────────────────────────────────────
-- Subscription grace period — turn ON a 3-day grace window after a term ends
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the subscription-lifecycle migration (#13) shipped with the grace knob OFF
-- (v_grace_days = 0), so a term ended EXACTLY at ends_at with no cushion. Product now
-- wants a 3-day grace period: after a paid term expires the member keeps access for 3
-- more days (with an urgent "renew now" warning), then the app locks them on the
-- Membership Expired screen. Everything that reads access already honors grace_ends_at
-- via `coalesce(grace_ends_at, ends_at)`:
--   • public.is_enrolled()               (subscription-lifecycle #13) — RLS access gate
--   • public.current_plan_key()          (plan-course-access #17)     — per-plan course scope
--   • public.expire_overdue_subscriptions() (#13)                     — cosmetic status sweep
--   • client subAccess()/enrollGateState() (src/BookkeeperPro.jsx)    — nav gate + panels
-- …so this migration only needs to (a) flip the knob in approve_subscription() so NEW
-- approvals/renewals stamp grace_ends_at = ends_at + 3 days, and (b) backfill the
-- currently-running terms so existing members get the grace window too.
--
-- ORDER: run db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file (it creates
-- approve_subscription + the subscriptions.grace_ends_at / ends_at columns this extends).
-- The guard below stops with a clear message if #13 hasn't run.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create-or-replace function + a null-guarded, non-shrinking backfill) —
-- safe to run more than once. See ENROLLMENT_SETUP.md → "Membership lifecycle & renewal".
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard — everything below extends the subscription-lifecycle schema.
do $$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql (#12) first — public.subscriptions is missing.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'grace_ends_at'
  ) then
    raise exception 'subscriptions.grace_ends_at is missing — run db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) approve_subscription() — IDENTICAL to the #13 definition except v_grace_days := 3.
--    This is the ONLY way a term is granted/renewed (admin Enrollments → Approve). Runs
--    supersede + insert in ONE transaction; SECURITY DEFINER with an internal admin guard.
--    From now on every granted term carries grace_ends_at = ends_at + 3 days (lifetime
--    plans, access_days = NULL, still get no grace — v_ends is NULL).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.approve_subscription(
  p_user_id    uuid,
  p_plan_key   text,
  p_request_id uuid
)
returns public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_grace_days constant int := 3;   -- ← grace knob. 3 = access continues 3 days past ends_at.
  v_days   int;
  v_prev   public.subscriptions%rowtype;
  v_base   timestamptz;
  v_ends   timestamptz;
  v_grace  timestamptz;
  v_new    public.subscriptions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'approve_subscription: admin only';
  end if;

  select access_days into v_days from public.enrollment_plans where key = p_plan_key;

  -- Latest prior subscription (any status), locked so two concurrent approvals
  -- of the same student serialize instead of racing the unique index.
  select * into v_prev
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1
    for update;

  -- Idempotency: if this exact request already granted the current active term,
  -- return it unchanged. Makes a double-click / retry a no-op (no double-extend);
  -- a genuine renewal is a NEW request row, so it still stacks correctly.
  if v_prev.id is not null and v_prev.status = 'active' and v_prev.request_id = p_request_id then
    return v_prev;
  end if;

  -- Renewal stacking: extend from the current expiry while a dated term is still
  -- running; otherwise (expired, no prior sub, or legacy NULL-ends row) start
  -- from now. A legacy non-expiring member who renews converts to a dated term.
  if v_prev.id is not null and v_prev.status = 'active'
     and v_prev.ends_at is not null and v_prev.ends_at > now() then
    v_base := v_prev.ends_at;
  else
    v_base := now();
  end if;

  v_ends  := case when v_days is null then null else v_base + make_interval(days => v_days) end;
  v_grace := case when v_ends is null or v_grace_days = 0 then null
                  else v_ends + make_interval(days => v_grace_days) end;

  -- Supersede whatever is currently active (frees the one-active unique index).
  update public.subscriptions
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'active';

  insert into public.subscriptions
    (user_id, plan_key, status, started_at, ends_at, grace_ends_at,
     approved_by, request_id, renewed_from_subscription_id)
  values
    (p_user_id, p_plan_key, 'active', now(), v_ends, v_grace,
     auth.uid(), p_request_id, v_prev.id)
  returning * into v_new;

  return v_new;
end;
$$;

revoke all on function public.approve_subscription(uuid, text, uuid) from public;
grant execute on function public.approve_subscription(uuid, text, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 2) Backfill grace for CURRENTLY-RUNNING terms so existing members get the window too.
--    Guards:
--      • status = 'active'          — only live terms
--      • ends_at is not null        — never touch legacy no-expiry (lifetime) rows
--      • ends_at > now()            — only STILL-RUNNING terms. Never resurrect a term
--                                     that already lapsed (a member the sweep hasn't
--                                     flipped yet stays consistent with one it has).
--      • grace_ends_at is null      — idempotent: a re-run skips rows already set, and
--                                     never overrides a hand-set per-student grace.
--    This only ever MOVES the access boundary LATER, so it can never lock anyone out.
-- ───────────────────────────────────────────────────────────────────
update public.subscriptions
   set grace_ends_at = ends_at + interval '3 days',
       updated_at = now()
 where status = 'active'
   and ends_at is not null
   and ends_at > now()
   and grace_ends_at is null;

-- 3) Refresh PostgREST's schema cache so the updated function is used immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • Approving/renewing now stamps grace_ends_at = ends_at + 3 days.
--   • Existing active, still-running terms are backfilled with the same 3-day grace.
--   • During grace the member keeps full access and sees an urgent "Grace period: renew
--     now to avoid losing access" warning (Dashboard membership panel); after grace the
--     app locks them on the Membership Expired screen until an admin approves a renewal.
--   • To change the window later, edit v_grace_days in approve_subscription() and re-run
--     (and adjust the backfill interval if you want to move existing rows too).
-- ─────────────────────────────────────────────────────────────────────────────
