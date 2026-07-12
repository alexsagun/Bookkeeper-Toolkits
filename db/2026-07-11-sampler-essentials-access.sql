-- ─────────────────────────────────────────────────────────────────────────────
-- SAMPLER PLAN — course-level access (QuickBooks Online Essentials only).
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: db/2026-07-09-plan-course-access.sql (#17) scopes course reads by SLUG PREFIX —
-- `core_self_paced` (QBO Mastery Only) may read only `qbo-%` courses. The `sampler` plan
-- (Sampler Session, ₱1,499 / 60 days) is even more restricted: it unlocks ONLY the
-- QuickBooks Online **Essentials** course — NOT the premium **Mastery** course — even
-- though BOTH live under the same `qbo-` catalog prefix. A prefix rule can't tell two
-- qbo courses apart, so this migration adds a per-course tier (`courses.access_tier`) and
-- scopes sampler to `access_tier = 'essentials'`.
--
-- MODEL (whitelist, mirrors #17): a `sampler` member reads a course only when it is BOTH
-- `qbo-%` AND `access_tier = 'essentials'`. EVERYONE else is unaffected — admins, core
-- (still `qbo-%`, both tiers), silver/gold/vip/grandfathered/expired — because the added
-- conjunct is true for them (they are not `plan_is_sampler()`). The two scoped plans are
-- mutually exclusive, so the sampler conjunct and the core conjunct compose cleanly.
-- CLIENT half: PLAN_ENTITLEMENTS.sampler (`courseTier:'essentials'`) + courses.access_tier
-- read in COURSE_ROW_SELECT. Keep the two in sync.
--
-- access_tier: `'standard'` (default — premium; the existing `qbo-mastery` seed and every
-- current course) vs `'essentials'` (Sampler-accessible). Admins set it in-app via the
-- course card ⋮ menu → "Sampler tier (Essentials)".
--
-- PERFORMANCE: no-arg helpers in the read policies are wrapped in `(select fn())` so
-- Postgres evaluates each ONCE per query (an InitPlan), and the plan checks short-circuit
-- so full-access members do ZERO per-row plan work. current_plan_key()'s lookup is an O(1)
-- probe on the subscriptions_one_active partial-unique index.
--
-- Depends on: public.current_plan_key() / plan_is_qbo_only() / course_object_allowed()
-- (plan-course-access #17), public.is_admin()/is_approved()/is_enrolled(), public.courses,
-- private course-videos bucket (#15). RUN #17 FIRST — the guard below aborts with a clear
-- message if current_plan_key() is missing.
-- HOW TO RUN: Supabase dashboard → SQL Editor → Run. IDEMPOTENT (add-column-if-not-exists /
-- create or replace / drop policy if exists). Only ADDS a conjunct to existing read
-- policies — it never loosens is_approved()/is_enrolled()/published. (Also folded into
-- db/000_full_database_bootstrap.sql for fresh installs.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Prerequisites — stop early with a CLEAR message on a partial schema.
do $$
begin
  if to_regclass('public.courses') is null then
    raise exception 'Run db/2026-06-16-course-platform-base.sql (#2) first — public.courses is missing.';
  end if;
  if to_regproc('public.current_plan_key') is null then
    raise exception 'Run db/2026-07-09-plan-course-access.sql (#17) BEFORE this file — public.current_plan_key() is missing.';
  end if;
end $$;

-- 1) Per-course plan tier. 'standard' = premium (default; existing courses incl. qbo-mastery);
--    'essentials' = unlocked for the Sampler plan. NOT NULL default keeps every read policy's
--    `access_tier = 'essentials'` test null-safe.
alter table public.courses add column if not exists access_tier text not null default 'standard';

-- 2) plan_is_sampler() — is the caller on the sampler plan? NON-NULL boolean (coalesce),
--    no args → InitPlan-friendly and safe inside `not (...)`. Same shape as plan_is_qbo_only().
create or replace function public.plan_is_sampler()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_plan_key() = 'sampler', false)
$$;

grant execute on function public.plan_is_sampler() to authenticated;

-- 3) course_object_allowed(object_name) — rewritten so it no longer short-circuits to TRUE
--    for sampler (it used to `return true` for any non-core plan). For private course-videos
--    objects (path lessons/<course_id>/<file>): admins + full-access plans → true; core →
--    slug like 'qbo-%'; sampler → slug like 'qbo-%' AND access_tier = 'essentials'. Unparseable
--    path / unknown course → don't block (legacy/unexpected paths keep is_enrolled()-only behavior).
create or replace function public.course_object_allowed(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_cid  uuid;
  v_slug text;
  v_tier text;
begin
  if public.is_admin() then return true; end if;
  if not public.plan_is_qbo_only() and not public.plan_is_sampler() then
    return true;                                              -- full-access plans: no restriction
  end if;
  begin
    v_cid := split_part(p_name, '/', 2)::uuid;                -- lessons/<course_id>/...
  exception when others then
    return true;                                              -- unparseable path → don't block
  end;
  select slug, access_tier into v_slug, v_tier from public.courses where id = v_cid;
  if v_slug is null then return true; end if;                 -- unknown course → don't block
  if public.plan_is_sampler() then
    return v_slug like 'qbo-%' and v_tier = 'essentials';
  end if;
  return v_slug like 'qbo-%';                                 -- plan_is_qbo_only (core)
end;
$$;

-- 4) Re-apply the course read policies with BOTH plan conjuncts. Reproduces #17's form and
--    ANDs the sampler tier rule. Skips (NOTICE) if prerequisites absent.
do $$
begin
  if to_regproc('public.is_approved') is null or to_regproc('public.is_enrolled') is null then
    raise notice 'Skipping plan-scoped course policies: run user-approval (#9) + enrollment (#12) + subscription-lifecycle (#13) + plan-course-access (#17) first, then re-run this file.';
    return;
  end if;

  execute 'drop policy if exists courses_read on public.courses';
  execute $pol$create policy courses_read on public.courses for select to authenticated
    using ((select public.is_admin())
      or (published = true and (select public.is_approved()) and (select public.is_enrolled())
          and (not (select public.plan_is_qbo_only()) or slug like 'qbo-%')
          and (not (select public.plan_is_sampler()) or (slug like 'qbo-%' and access_tier = 'essentials'))))$pol$;

  if to_regclass('public.course_modules') is not null then
    execute 'drop policy if exists modules_read on public.course_modules';
    execute $pol$create policy modules_read on public.course_modules for select to authenticated
      using ((select public.is_admin())
        or ((select public.is_approved()) and (select public.is_enrolled()) and exists (
          select 1 from public.courses c where c.id = course_id and c.published = true
            and (not (select public.plan_is_qbo_only()) or c.slug like 'qbo-%')
            and (not (select public.plan_is_sampler()) or (c.slug like 'qbo-%' and c.access_tier = 'essentials')))))$pol$;
  end if;

  if to_regclass('public.course_lessons') is not null then
    execute 'drop policy if exists lessons_read on public.course_lessons';
    execute $pol$create policy lessons_read on public.course_lessons for select to authenticated
      using ((select public.is_admin())
        or ((select public.is_approved()) and (select public.is_enrolled()) and exists (
          select 1 from public.courses c where c.id = course_id and c.published = true
            and (not (select public.plan_is_qbo_only()) or c.slug like 'qbo-%')
            and (not (select public.plan_is_sampler()) or (c.slug like 'qbo-%' and c.access_tier = 'essentials')))))$pol$;
  end if;
end $$;

-- 5) Private lesson videos — call course_object_allowed() for BOTH restricted plans
--    (full-access members short-circuit before the per-object lookup). Guarded on the bucket.
do $$
begin
  if exists (select 1 from storage.buckets where id = 'course-videos') then
    execute 'drop policy if exists course_videos_read on storage.objects';
    execute $pol$create policy course_videos_read on storage.objects for select to authenticated
      using (bucket_id = 'course-videos'
        and ((select public.is_admin())
             or ((select public.is_enrolled())
                 and ((not (select public.plan_is_qbo_only()) and not (select public.plan_is_sampler()))
                      or public.course_object_allowed(name)))))$pol$;
  else
    raise notice 'course-videos bucket not found — skipping its policy (run db/2026-07-08-course-videos-private.sql first if you use private videos).';
  end if;
end $$;

notify pgrst, 'reload schema';

-- NOT scoped here (documented residuals, same as #17): feature_guides (the
-- MockInterviewSimulator explainer video) stays readable by scoped members, and the
-- Anthropic proxy (api/anthropic) gates on admin OR is_enrolled() only — a sampler member
-- can spend AI tokens on a hand-crafted proxy call, but that reveals no stored higher-tier
-- content. Tighten either later if stricter enforcement is wanted.
