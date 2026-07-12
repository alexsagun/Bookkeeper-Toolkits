-- ─────────────────────────────────────────────────────────────────────────────
-- PLAN-SCOPED COURSE ACCESS — server enforcement of per-plan entitlements.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: is_enrolled() is a SINGLE global boolean (admin OR active non-expired sub OR
-- grandfathered paid). Every course/lesson read + the private course-videos bucket gate
-- on it, so a `core_self_paced` member (QBO Mastery Only, ₱999 / 60 days) — who IS
-- is_enrolled() — could read HIGHER-TIER course content (the Resume `resume-*` and
-- Interview `interview-*` Winning Strategy courses + their private lesson videos) by
-- direct Supabase query, even though the app UI hides those tabs. This migration scopes
-- course reads by plan so the restriction is real, not just cosmetic.
--
-- MODEL (whitelist, future-proof): a `core_self_paced` member may read ONLY `qbo-%`
-- courses — the sole Supabase courses in the Training & Skills stage (Accounting 101 is
-- static in-app content, not a course row). Any OTHER slug prefix (resume-, interview-,
-- or a future higher-tier catalog) is denied automatically. EVERYONE else — admins, all
-- other plans (sampler/silver_self_paced/gold_live/vip), grandfathered/legacy users, and
-- expired members (already blocked by is_enrolled()) — is UNAFFECTED (the added conjunct
-- is true for them). This is the SERVER half of the plan-access model; the CLIENT half is
-- PLAN_ENTITLEMENTS in src/BookkeeperPro.jsx (core = Training & Skills tabs only). Keep
-- the two in sync when entitlements change.
--
-- PERFORMANCE: every no-arg helper in the read policies is wrapped in `(select fn())` so
-- Postgres evaluates it ONCE per query (an InitPlan) instead of once per candidate row —
-- the documented Supabase RLS optimization. The plan check short-circuits, so full-access
-- members do ZERO per-row plan work. current_plan_key()'s lookup is an O(1) probe on the
-- existing subscriptions_one_active partial-unique index (≤1 active row per user).
--
-- Depends on: public.is_admin() (course-platform-base #2), public.is_approved()
-- (user-approval #9), public.is_enrolled() + public.subscriptions.ends_at (enrollment #12
-- + subscription-lifecycle #13), private course-videos bucket (#15). RUN #13 FIRST — the
-- ends_at guard below aborts with a clear message if it hasn't been applied.
-- HOW TO RUN: Supabase dashboard → SQL Editor → Run. IDEMPOTENT (create or replace /
-- drop policy if exists / drop function if exists). Only ADDS a conjunct to existing read
-- policies — it never loosens is_approved()/is_enrolled()/published. (Also folded into
-- db/000_full_database_bootstrap.sql for fresh installs.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Prerequisites — stop early with a CLEAR message on a partial schema. The column
--    check is what turns the raw `column s.ends_at does not exist` into an instruction.
do $$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql (#12) first — public.subscriptions is missing.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'ends_at'
  ) then
    raise exception 'subscriptions.ends_at is missing — run db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file.';
  end if;
  if to_regclass('public.courses') is null then
    raise exception 'Run db/2026-06-16-course-platform-base.sql (#2) first — public.courses is missing.';
  end if;
end $$;

-- 1) current_plan_key() — the plan_key of the caller's active, non-expired subscription
--    (SAME selection as is_enrolled()), else null. SECURITY DEFINER + pinned search_path
--    so it bypasses RLS (no recursion when read policies consult it). Filters on auth.uid()
--    so it can only ever see the caller's own plan.
create or replace function public.current_plan_key()
returns text
language sql stable security definer set search_path = public
as $$
  select s.plan_key
  from public.subscriptions s
  where s.user_id = auth.uid()
    and s.status = 'active'
    and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
  order by s.created_at desc
  limit 1
$$;

-- 2) plan_is_qbo_only() — is the caller on a plan that unlocks ONLY qbo-* courses?
--    NON-NULL boolean (coalesce), no args → InitPlan-friendly and safe inside `not (...)`.
--    core_self_paced → true; admins/every other plan/grandfathered(null) → false.
create or replace function public.plan_is_qbo_only()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_plan_key() = 'core_self_paced', false)
$$;

-- 3) course_object_allowed(object_name) — for private course-videos objects, whose path is
--    lessons/<course_id>/<file>. Only the restricted plan is scoped; everyone else short-
--    circuits to true. If the path doesn't parse or the course is unknown, DON'T block
--    (legacy/unexpected paths keep their is_enrolled()-only behavior).
create or replace function public.course_object_allowed(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_cid  uuid;
  v_slug text;
begin
  if public.is_admin() then return true; end if;
  if not public.plan_is_qbo_only() then return true; end if;   -- full-access plans: no restriction
  begin
    v_cid := split_part(p_name, '/', 2)::uuid;                 -- lessons/<course_id>/...
  exception when others then
    return true;                                                -- unparseable path → don't block
  end;
  select slug into v_slug from public.courses where id = v_cid;
  if v_slug is null then return true; end if;                   -- unknown course → don't block
  return v_slug like 'qbo-%';
end;
$$;

grant execute on function public.current_plan_key()          to authenticated;
grant execute on function public.plan_is_qbo_only()          to authenticated;
grant execute on function public.course_object_allowed(text) to authenticated;

-- 4) Re-apply the course read policies with the plan predicate ANDed in. Reproduces the
--    CURRENT final form (db/2026-07-04-enrollment.sql §7: is_admin() OR (published AND
--    is_approved() AND is_enrolled() ...)) but (a) wraps no-arg helpers in `(select …)`
--    (InitPlan — evaluated once) and (b) inlines the slug rule behind a short-circuit so
--    non-core members do zero per-row plan work. Skips (NOTICE) if prerequisites absent.
do $$
begin
  if to_regproc('public.is_approved') is null or to_regproc('public.is_enrolled') is null then
    raise notice 'Skipping plan-scoped course policies: run user-approval (#9) + enrollment (#12) + subscription-lifecycle (#13) first, then re-run this file.';
    return;
  end if;

  execute 'drop policy if exists courses_read on public.courses';
  execute $pol$create policy courses_read on public.courses for select to authenticated
    using ((select public.is_admin())
      or (published = true and (select public.is_approved()) and (select public.is_enrolled())
          and (not (select public.plan_is_qbo_only()) or slug like 'qbo-%')))$pol$;

  if to_regclass('public.course_modules') is not null then
    execute 'drop policy if exists modules_read on public.course_modules';
    execute $pol$create policy modules_read on public.course_modules for select to authenticated
      using ((select public.is_admin())
        or ((select public.is_approved()) and (select public.is_enrolled()) and exists (
          select 1 from public.courses c where c.id = course_id and c.published = true
            and (not (select public.plan_is_qbo_only()) or c.slug like 'qbo-%'))))$pol$;
  end if;

  if to_regclass('public.course_lessons') is not null then
    execute 'drop policy if exists lessons_read on public.course_lessons';
    execute $pol$create policy lessons_read on public.course_lessons for select to authenticated
      using ((select public.is_admin())
        or ((select public.is_approved()) and (select public.is_enrolled()) and exists (
          select 1 from public.courses c where c.id = course_id and c.published = true
            and (not (select public.plan_is_qbo_only()) or c.slug like 'qbo-%'))))$pol$;
  end if;
end $$;

-- 5) Private lesson videos — the crown jewel. Reproduces the #15 policy (admin OR
--    is_enrolled) and ANDs the plan gate: full-access members short-circuit (course_object_
--    allowed never runs); only core members pay the per-object course lookup. Guarded on
--    the bucket existing.
do $$
begin
  if exists (select 1 from storage.buckets where id = 'course-videos') then
    execute 'drop policy if exists course_videos_read on storage.objects';
    execute $pol$create policy course_videos_read on storage.objects for select to authenticated
      using (bucket_id = 'course-videos'
        and ((select public.is_admin())
             or ((select public.is_enrolled())
                 and (not (select public.plan_is_qbo_only()) or public.course_object_allowed(name)))))$pol$;
  else
    raise notice 'course-videos bucket not found — skipping its policy (run db/2026-07-08-course-videos-private.sql first if you use private videos).';
  end if;
end $$;

-- 6) Remove the superseded helper LAST — only after the policies above no longer reference
--    it (RLS policies hold a pg_depend on functions in their USING clause). NO CASCADE:
--    a CASCADE here would silently drop the read policies. On the DB that aborted at step 1
--    this is a harmless no-op (it was never created).
drop function if exists public.course_plan_allowed(text);

notify pgrst, 'reload schema';

-- NOT scoped here (documented residuals): feature_guides (the MockInterviewSimulator
-- explainer video — low value: an explainer + external sesame.com link, not core paid
-- content) stays readable by core members; the Anthropic proxy (api/anthropic) gates on
-- admin OR is_enrolled() and can't cheaply know which tool a request is for (a core member
-- needs it for allowed AI training tools like ProAdvisor Chat), so it isn't blanket-blocked
-- — a hand-crafted proxy call for a restricted tool spends tokens but reveals no stored
-- higher-tier content. Add per-plan scoping to either later if stricter enforcement is wanted.
