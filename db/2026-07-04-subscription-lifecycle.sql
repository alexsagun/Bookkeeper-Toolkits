-- ─────────────────────────────────────────────────────────────────────────────
-- Subscription lifecycle — plan durations, expiry, and renewal
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: approval used to flip profiles.is_paid forever. This upgrade gives every
-- plan an access duration (enrollment_plans.access_days) and every subscription a
-- real term (subscriptions.ends_at). The TRUE access check is no longer the
-- is_paid boolean — public.is_enrolled() (which every content read-policy already
-- calls) now checks for an ACTIVE, NON-EXPIRED subscription. When a term ends the
-- student is locked out server-side (RLS) and client-side (expired-membership
-- screen) until an admin approves a renewal. profiles.is_paid remains as a
-- "has paid at least once" CACHE only.
--
-- LIFECYCLE RULES (change here, not in the client):
--   • Approval term:  ends_at = greatest(now(), current active ends_at) + access_days
--     — renewing early EXTENDS from the current expiry; renewing after expiry
--     starts from the approval moment. Implemented in approve_subscription().
--   • Grace period:   OFF by default (v_grace_days = 0 in approve_subscription()).
--     The grace_ends_at column + all checks already honor it — set the constant
--     to e.g. 3 to adopt a grace window later, or hand-set grace_ends_at on a
--     single row as a per-student extension valve.
--   • Grandfathering: subscriptions with ends_at IS NULL never expire (legacy
--     rows created before this migration). A paid profile with NO subscription
--     rows at all also stays enrolled (paid before the subscriptions era).
--     Nobody is locked out by running this file. Their NEXT renewal converts
--     them to a dated term.
--
-- ORDER: run db/2026-07-04-enrollment.sql BEFORE this file (it creates the
-- enrollment_plans / subscriptions tables this file extends). Running this file
-- first stops with a clear exception — nothing partial is applied.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (add-column-if-not-exists, guarded seeds, create-or-replace) — safe
-- to run more than once. See ENROLLMENT_SETUP.md for the full walkthrough.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Hard ordering guard — everything below extends the enrollment schema.
do $$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql before this file (public.subscriptions does not exist yet).';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) enrollment_plans — access duration + support window + entitlement chips,
--    plus a FIRST-RUN-ONLY duration seed.
--    access_days NULL = a plan that never expires (lifetime). support_days is
--    informational (shown to the student/admin; not RLS-enforced).
--    entitlement_summary is a short jsonb array of chips (e.g. ["60-day access"])
--    for compact UI — features stays the long marketing bullet list.
--
--    ⚠ IDEMPOTENCY: NULL is a MEANINGFUL value here (lifetime), so we can't use
--    "where access_days is null" as the not-yet-seeded sentinel — that would let
--    a re-run silently re-impose 60/180 days on a plan an admin deliberately made
--    lifetime. Instead we seed ONLY on the first run (detected by the access_days
--    column being absent before this file adds it). After that, in-app admin edits
--    (including setting a plan to lifetime) always survive re-runs.
-- ───────────────────────────────────────────────────────────────────
do $$
declare
  v_fresh boolean;
begin
  v_fresh := not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'enrollment_plans' and column_name = 'access_days'
  );

  alter table public.enrollment_plans add column if not exists access_days  int;
  alter table public.enrollment_plans add column if not exists support_days int;
  alter table public.enrollment_plans add column if not exists entitlement_summary jsonb not null default '[]'::jsonb;

  if v_fresh then
    update public.enrollment_plans set access_days = 60                    where key = 'core_self_paced';
    update public.enrollment_plans set access_days = 60, support_days = 30 where key = 'sampler';
    update public.enrollment_plans set access_days = 60                    where key = 'silver_self_paced';
    update public.enrollment_plans set access_days = 180                   where key = 'gold_live';
    update public.enrollment_plans set access_days = 180                   where key = 'vip';

    update public.enrollment_plans set entitlement_summary = '["60-day QBO Mastery access","Weekly Discord chat"]'::jsonb                  where key = 'core_self_paced';
    update public.enrollment_plans set entitlement_summary = '["60-day course access","30-day group chat support","1 live Zoom session"]'::jsonb where key = 'sampler';
    update public.enrollment_plans set entitlement_summary = '["60-day QBO Mastery access","60-day Resume & Interview access"]'::jsonb      where key = 'silver_self_paced';
    update public.enrollment_plans set entitlement_summary = '["180-day full access","12 live group trainings","Weekly consult until hired"]'::jsonb where key = 'gold_live';
    update public.enrollment_plans set entitlement_summary = '["180-day full access","1-on-1 coaching","Weekly consult until hired"]'::jsonb where key = 'vip';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 2) subscriptions — the lifecycle columns. ends_at NULL = legacy non-expiring
--    (see grandfathering note in the header). renewed_from_subscription_id links
--    a renewal to the term it superseded, preserving full history.
-- ───────────────────────────────────────────────────────────────────
alter table public.subscriptions add column if not exists ends_at        timestamptz;
alter table public.subscriptions add column if not exists grace_ends_at  timestamptz;
alter table public.subscriptions add column if not exists renewed_from_subscription_id uuid references public.subscriptions(id) on delete set null;
alter table public.subscriptions add column if not exists updated_at     timestamptz not null default now();

-- Latest-subscription lookup (client gate + dashboard panel) and expiry sweeps.
create index if not exists subscriptions_user_created on public.subscriptions (user_id, created_at desc);
create index if not exists subscriptions_status_ends  on public.subscriptions (status, ends_at);

-- ───────────────────────────────────────────────────────────────────
-- 3) Date-aware is_enrolled() — THE access check. Every content read-policy
--    (courses/modules/lessons/feature_guides, enrollment.sql section 7) already
--    calls this function, so rewriting it enforces expiry server-side with zero
--    policy changes. The date comparison is the authority: an overdue row still
--    marked status='active' is denied all the same (status flips are cosmetic —
--    see expire_overdue_subscriptions() below).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.is_enrolled()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select p.is_admin
        -- an active subscription whose term (or grace window) is still running;
        -- ends_at IS NULL = legacy non-expiring
        or exists (
             select 1 from public.subscriptions s
             where s.user_id = p.id
               and s.status = 'active'
               and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now()))
        -- grandfather: paid before the subscriptions era (no sub rows at all)
        or (p.is_paid and not exists (
             select 1 from public.subscriptions s2 where s2.user_id = p.id))
    from public.profiles p where p.id = auth.uid()), false)
$$;

-- ───────────────────────────────────────────────────────────────────
-- 4) approve_subscription() — the ONLY way a term is granted/renewed. Called by
--    the admin Enrollments tab on Approve. Runs supersede + insert in ONE
--    transaction, so the subscriptions_one_active unique index can never be
--    violated mid-flight. SECURITY DEFINER with an internal admin guard —
--    a student calling it gets an exception, never a subscription.
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
  v_grace_days constant int := 0;   -- ← the grace knob. 0 = access ends exactly at ends_at.
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
-- 5) expire_overdue_subscriptions() — cosmetic status sweep. The date check in
--    is_enrolled() is what actually denies access; this just flips overdue
--    'active' rows to 'expired' so admin filters and the student panel read
--    truthfully. Called best-effort when the admin opens the Enrollments tab.
--    Does NOT touch profiles.is_paid (that stays a "has paid at least once"
--    cache; flipping it would break the grandfather fallback).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.expire_overdue_subscriptions()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  if not public.is_admin() then
    raise exception 'expire_overdue_subscriptions: admin only';
  end if;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where status = 'active'
     and ends_at is not null
     and coalesce(grace_ends_at, ends_at) < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_overdue_subscriptions() from public;
grant execute on function public.expire_overdue_subscriptions() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 6) Grandfathering — deliberately NO backfill. Existing subscription rows keep
--    ends_at = NULL (never expire) and paid profiles without rows pass via the
--    is_enrolled() fallback, so running this file locks nobody out. If you later
--    want to put legacy members on the clock, run something like the snippet
--    below (30-day floor from today so nobody is instantly locked out):
--
--    -- update public.subscriptions s
--    --    set ends_at = greatest(s.started_at + make_interval(days => pl.access_days),
--    --                           now() + interval '30 days'),
--    --        updated_at = now()
--    --   from public.enrollment_plans pl
--    --  where pl.key = s.plan_key
--    --    and s.status = 'active' and s.ends_at is null and pl.access_days is not null;
-- ───────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────
-- 7) Realtime on subscriptions (optional but recommended): the dashboard
--    membership panel and the renewal pending screen advance the instant an
--    admin approves. RLS still applies — students only receive their own rows.
--    Without this, the app falls back to a poll / on-focus refetch.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'subscriptions'
  ) then
    alter publication supabase_realtime add table public.subscriptions;
  end if;
end $$;

-- 8) Refresh PostgREST's schema cache so the new columns/functions are usable immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • Approving an enrollment now grants a DATED term: ends_at = approval time +
--     the plan's access_days (60 for Core/Sampler/Silver, 180 for Gold/VIP).
--   • Renewals extend from the current expiry (renewing early never loses days).
--   • When a term ends the student is locked server-side (is_enrolled() = false)
--     and sees the Membership Expired screen with a Renew button; renewal goes
--     through the same pricing + receipt-upload + admin-review flow.
--   • Existing members keep access: legacy rows have ends_at = NULL (no expiry)
--     until their next renewal. See section 6 to put them on the clock instead.
--   • The student Dashboard now shows a membership panel (plan, status, days
--     remaining, renew button) with warnings at 14 / 7 / 3 days left.
--   • Grace period is OFF; edit v_grace_days in approve_subscription() to add one.
-- ─────────────────────────────────────────────────────────────────────────────
