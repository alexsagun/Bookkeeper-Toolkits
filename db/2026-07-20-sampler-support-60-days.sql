-- ─────────────────────────────────────────────────────────────────────────────
-- Sampler Session — group-chat support extended 30 → 60 days
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the Sampler Session plan now includes 60 days of group chat / community
-- support (matching its 60-day access_days — support runs for as long as the
-- membership itself). The enrollment_plans seeds are first-run-only
-- (ON CONFLICT DO NOTHING in #12 / the v_fresh guard in #13), so an EXISTING
-- install's live row still says 30 in three places even after the code ships:
--   • support_days = 30                       → "60-day access · 30-day support" card line
--   • features jsonb "30-day group chat support"        → pricing-card bullet
--   • entitlement_summary jsonb "30-day group chat support" → membership chips
-- This file updates the live row. Fresh installs are already correct — the
-- bootstrap + the #12/#13 seeds now say 60 at the source.
--
-- ORDER: run db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file
-- (it adds the support_days / entitlement_summary columns this updates). The
-- guard below stops with a clear message if #13 hasn't run.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (both UPDATEs are scoped to the stale values, so a second run
-- matches nothing) — safe to run more than once. Data-only change: no schema
-- edit, so no PostgREST schema reload is needed.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard — the columns below come from the subscription-lifecycle migration.
do $$
begin
  if to_regclass('public.enrollment_plans') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql (#12) first — public.enrollment_plans is missing.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'enrollment_plans' and column_name = 'support_days'
  ) then
    raise exception 'enrollment_plans.support_days is missing — run db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file.';
  end if;
end $$;

-- 1) support_days 30 → 60. Scoped to the stock value (30) so a deliberate
--    in-app admin override to some OTHER number is never clobbered.
update public.enrollment_plans
   set support_days = 60, updated_at = now()
 where key = 'sampler' and support_days = 30;

-- 2) "30-day group chat support" → "60-day group chat support" in BOTH jsonb
--    arrays (features drives the pricing-card bullets; entitlement_summary
--    drives the membership chips). Text-level replace inside the arrays; the
--    WHERE makes a re-run (or an already-corrected row) a no-op.
update public.enrollment_plans
   set features            = replace(features::text,            '30-day group chat support', '60-day group chat support')::jsonb,
       entitlement_summary = replace(entitlement_summary::text, '30-day group chat support', '60-day group chat support')::jsonb,
       updated_at = now()
 where key = 'sampler'
   and (features::text like '%30-day group chat support%'
     or entitlement_summary::text like '%30-day group chat support%');

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • The Sampler Session pricing card reads "60-day access · 60-day support"
--     and lists "60-day group chat support"; membership chips match.
--   • No member's dates change — support_days is display copy; access is still
--     governed by subscriptions.ends_at (+ grace) via is_enrolled().
--   • Verify with:  select key, support_days, features, entitlement_summary
--                   from public.enrollment_plans where key = 'sampler';
-- ─────────────────────────────────────────────────────────────────────────────
