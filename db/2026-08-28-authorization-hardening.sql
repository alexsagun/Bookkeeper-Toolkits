-- ─────────────────────────────────────────────────────────────────────────────
-- #48 — Authorization hardening: corrections to #45/#46/#47 after a full review.
-- ─────────────────────────────────────────────────────────────────────────────
-- Every item below was REPRODUCED against the live schema inside a rolled-back
-- transaction (impersonating a real user via `set local role authenticated` +
-- `request.jwt.claims`), not inferred from reading the SQL. Where a test passed
-- for the wrong reason that is called out, because one of them did.
--
-- ★ 1. THE BIG ONE — an Operations Admin could rewrite and DELETE any
--      subscription directly, which made #47 decorative.
--      #45 §15 moved `subscriptions_admin_all` from is_admin() to
--      has_staff_permission('enrollments.review'), but that policy is FOR ALL and
--      `authenticated` still holds Supabase's default table grants, so RLS was the
--      only gate. Reproduced: as an Ops Admin, one PATCH set plan_key='vip' and
--      ends_at='2099-01-01' on a live row, and one DELETE removed it.
--
--      That is exactly the act #47's header says must stay with Super Admin —
--      "a discretionary extension creates paid access with no payment behind it".
--      admin_grant_special_extension() enforces a reason, a 1-365 clamp,
--      forward-only, and an append-only ledger row. The direct table write
--      enforced none of them and left no record at all.
--
--      The fix is to stop using FOR ALL for a read-mostly screen. AdminEnrollments
--      never writes `subscriptions` — every grant goes through a SECURITY DEFINER
--      RPC — and on `enrollment_requests` it only ever UPDATEs (reject reason,
--      admin notes). So: SELECT for reviewers, UPDATE where the screen needs it,
--      and INSERT/DELETE reserved for Super Admin. Forging a request row and then
--      approving it is no longer available to the lower-trust tier.
--
-- ★ 2. #46 scoped ONE of the three AI-trainer tables.
--      course_ai_sources_admin_all got `and can_manage_course(course_id)`;
--      course_ai_chunks_admin_read and course_ai_index_jobs_admin_all did not,
--      leaving a Trainer able to read every course's indexed text and manipulate
--      every course's index queue. Both tables carry course_id, so the same
--      conjunct applies.
--      ★★ The first test of this PASSED and was WRONG: both tables are empty
--         today, so "0 rows visible" proved nothing. Reading pg_policies directly
--         is what found it. Latent, not live — but live the moment anyone indexes.
--
-- ★ 3. A Trainer could not create a course at all — the feature #46 exists for.
--      CourseCatalog.createCourse() issues `insert … select()`, which PostgREST
--      compiles to INSERT … RETURNING; the RETURNING row is checked against the
--      SELECT policy, and at that instant the AFTER-INSERT owner assignment is not
--      yet usable, so courses_read denied it and the whole insert rolled back.
--      Fixed with a creator branch — gated on STILL holding courses.create, because
--      created_by is permanent provenance and on its own would keep granting read
--      to someone whose staff access was revoked. (The first draft of this fix did
--      exactly that; the test caught it.)
--
-- ★ 4. #46 broke feature-guide video uploads for EVERYONE, including Super Admins.
--      Those live at `feature-guides/<key>/<file>` in course-media, which
--      course_object_course_id() correctly returns NULL for — so the narrowed write
--      policies denied it. Fails closed, so not a vulnerability, but the Mock
--      Interview guide became un-editable.
--
-- ★ 5. Per-row cost: #46 put can_manage_course() — a SECURITY DEFINER doing up to
--      two permission lookups — AHEAD of the member branch in three read policies,
--      so every ordinary student paid it once per row. #44's own comment reasoned
--      about exactly this ordering. Each staff branch now sits behind an
--      InitPlan-able capability test, so a non-staff caller short-circuits once per
--      statement and never makes the per-row call.
--
-- Depends on: #45, #46, #47.
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight ============================================================
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regprocedure('public.can_manage_course(uuid)') is null then
    raise exception 'Run db/2026-08-26-course-staff-assignments.sql (#46) first.';
  end if;
  if to_regprocedure('public.admin_grant_special_extension(uuid,text,integer,timestamptz,text,text)') is null then
    raise exception 'Run db/2026-08-27-special-extension.sql (#47) first.';
  end if;
end
$pre$;


-- == 1) An Operations Admin reviews money; they do not rewrite it =============
-- ★ FOR ALL was the mistake. Split by verb so the capability grants exactly the
--   screen's needs and nothing else.
--
-- ★ DROP+CREATE is safe here in a way it would not be for a read policy: while
--   the write policy is absent RLS refuses the write (fail-closed), and SELECT is
--   carried by the separate policies created alongside. The reverse — dropping a
--   READ policy — would blank the screen for everyone, which is why #46 used
--   ALTER for reads.

drop policy if exists subscriptions_admin_all on public.subscriptions;

drop policy if exists subscriptions_staff_read on public.subscriptions;
create policy subscriptions_staff_read on public.subscriptions
  for select to authenticated
  using ((select public.has_staff_permission('enrollments.review')));

-- Super Admin keeps a direct write path (break-glass / data repair). Everything
-- routine already goes through approve_subscription / approve_extension /
-- admin_finalize_enrollment / admin_grant_special_extension, all SECURITY DEFINER.
drop policy if exists subscriptions_super_write on public.subscriptions;
create policy subscriptions_super_write on public.subscriptions
  for all to authenticated
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

drop policy if exists enroll_req_admin_all on public.enrollment_requests;

drop policy if exists enroll_req_staff_read on public.enrollment_requests;
create policy enroll_req_staff_read on public.enrollment_requests
  for select to authenticated
  using ((select public.has_staff_permission('enrollments.review')));

-- The reviewer screen writes exactly two things: the reject decision and
-- admin_notes. UPDATE covers both. It deliberately does NOT cover INSERT, so a
-- reviewer cannot forge a request and then approve their own forgery.
drop policy if exists enroll_req_staff_update on public.enrollment_requests;
create policy enroll_req_staff_update on public.enrollment_requests
  for update to authenticated
  using ((select public.has_staff_permission('enrollments.review')))
  with check ((select public.has_staff_permission('enrollments.review')));

drop policy if exists enroll_req_super_write on public.enrollment_requests;
create policy enroll_req_super_write on public.enrollment_requests
  for all to authenticated
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));


-- == 2) The AI-trainer tables are course-scoped, all three of them ============
alter policy course_ai_chunks_admin_read on public.course_ai_chunks
  using ((select public.is_admin())
         or ((select public.has_staff_permission('course_trainer.manage'))
             and public.can_manage_course(course_id)));

alter policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs
  using ((select public.is_admin())
         or ((select public.has_staff_permission('course_trainer.manage'))
             and public.can_manage_course(course_id)))
  with check ((select public.is_admin())
              or ((select public.has_staff_permission('course_trainer.manage'))
                  and public.can_manage_course(course_id)));


-- == 3) Course reads: a creator can read what they created, and a student =====
--       never pays for a staff-only check
--
-- ★ ORDER IS THE POINT. is_admin() is one InitPlan. The MEMBER branch comes next
--   and is entirely InitPlans plus column tests. The STAFF branch comes last and
--   is itself guarded by an InitPlan-able capability test, so a plain student
--   evaluates it once per statement, gets false, and never reaches the per-row
--   can_manage_course() call.
--
-- ★ The creator branch pairs created_by with STILL holding courses.create.
--   created_by is permanent provenance; alone it would outlive employment.

alter policy courses_read on public.courses
  using (
    (select public.is_admin())
    or (published = true
        and (select public.is_approved())
        and (select public.is_enrolled())
        and ((not (select public.plan_is_sampler()))
             or (slug like 'qbo-%' and access_tier = 'essentials')))
    or ((select public.has_staff_permission('courses.create')
          or public.has_staff_permission('courses.manage_assigned')
          or public.has_staff_permission('courses.manage_all'))
        and (created_by = (select auth.uid()) or public.can_manage_course(id)))
  );

alter policy modules_read on public.course_modules
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (
          select 1 from public.courses c
           where c.id = course_modules.course_id
             and c.published = true
             and ((not (select public.plan_is_sampler()))
                  or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))))
    or ((select public.has_staff_permission('courses.manage_assigned')
          or public.has_staff_permission('courses.manage_all'))
        and public.can_manage_course(course_modules.course_id))
  );

alter policy lessons_read on public.course_lessons
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (
          select 1 from public.courses c
           where c.id = course_lessons.course_id
             and c.published = true
             and ((not (select public.plan_is_sampler()))
                  or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))))
    or ((select public.has_staff_permission('courses.manage_assigned')
          or public.has_staff_permission('courses.manage_all'))
        and public.can_manage_course(course_lessons.course_id))
  );


-- == 4) Storage: same reordering, plus feature guides work again =============
-- ★ Reads stay REFERENCE-based (course_video_object_readable) for members. That
--   is #44's rule and #48 does not touch it — only the ORDER of the staff branch
--   and the guard in front of it change.
alter policy course_videos_read on storage.objects
  using (
    bucket_id = 'course-videos'
    and ((select public.is_admin())
         or ((select public.is_approved())
             and (select public.is_enrolled())
             and public.course_video_object_readable(name, (select public.plan_is_sampler())))
         or ((select public.has_staff_permission('courses.manage_assigned')
               or public.has_staff_permission('courses.manage_all'))
             and public.can_manage_course(public.course_object_course_id(name))))
  );

-- Feature-guide media is not course media. It lives in the same PUBLIC bucket at
-- `feature-guides/<key>/<file>`, which the course path parser correctly refuses —
-- so #46 locked everyone out of replacing a guide video. Restore it as its own
-- branch rather than by loosening the parser, which must keep failing closed.
alter policy course_media_read on storage.objects
  using (bucket_id = 'course-media'
         and ((select public.is_admin())
              or ((select public.has_staff_permission('courses.manage_assigned')
                    or public.has_staff_permission('courses.manage_all'))
                  and public.can_manage_course(public.course_object_course_id(name)))));

alter policy course_media_admin_write on storage.objects
  with check (bucket_id = 'course-media'
              and (public.can_manage_course(public.course_object_course_id(name))
                   or ((storage.foldername(name))[1] = 'feature-guides'
                       and (select public.has_staff_permission('courses.manage_all')))));

alter policy course_media_admin_update on storage.objects
  using (bucket_id = 'course-media'
         and (public.can_manage_course(public.course_object_course_id(name))
              or ((storage.foldername(name))[1] = 'feature-guides'
                  and (select public.has_staff_permission('courses.manage_all')))));

alter policy course_media_admin_delete on storage.objects
  using (bucket_id = 'course-media'
         and (public.can_manage_course(public.course_object_course_id(name))
              or ((storage.foldername(name))[1] = 'feature-guides'
                  and (select public.has_staff_permission('courses.manage_all')))));



-- == 5) A reviewer may not approve their OWN enrollment request ==============
-- Surfaced while testing #48: enroll_req_own_insert lets ANY signed-in user file
-- a request for themselves - that is the ordinary signup path. Combined with
-- enrollments.review it becomes a self-grant: an Operations Admin files a request
-- for a VIP plan, approves it themselves, and holds paid access with no payment
-- and no second pair of eyes. Segregation of duties is the whole reason the role
-- exists below Super Admin.
--
-- Super Admin is exempt: they already hold students.extend_access and can grant
-- access outright, so barring them would add ceremony without adding a boundary.
create or replace function public.enrollment_self_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.status = 'approved' and old.status is distinct from new.status
     and new.user_id = auth.uid()
     and not public.is_super_admin() then
    perform public.app_error('FORBIDDEN',
      'You cannot approve your own enrollment request — ask a Super Admin to review it.', 403,
      jsonb_build_object('request_id', new.id));
  end if;
  return new;
end;
$fn$;

revoke all on function public.enrollment_self_approval_guard() from public, anon, authenticated;

drop trigger if exists enrollment_self_approval_guard on public.enrollment_requests;
create trigger enrollment_self_approval_guard
  before update on public.enrollment_requests
  for each row execute function public.enrollment_self_approval_guard();

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-28-authorization-hardening.sql', null,
  'authorization hardening (#48): corrections to #45/#46/#47, each reproduced against the live '
  'schema in a rolled-back transaction. (1) SECURITY: subscriptions_admin_all and '
  'enroll_req_admin_all were FOR ALL gated on enrollments.review, and authenticated keeps '
  'Supabase''s default table grants, so an Operations Admin could PATCH any subscription to '
  'plan_key=vip / ends_at=2099 and DELETE rows outright — making #47''s Super-Admin-only '
  'discretionary-extension split decorative, with no reason, no clamp and no ledger row. Split '
  'by verb: SELECT for reviewers, UPDATE on requests only (the reject reason and admin_notes are '
  'all the screen writes), INSERT/DELETE reserved for Super Admin so a reviewer cannot forge a '
  'request and approve their own forgery. (2) SECURITY: #46 scoped course_ai_sources with '
  'can_manage_course but left course_ai_chunks and course_ai_index_jobs on the bare capability, '
  'so a Trainer could read every course''s indexed text and manipulate every index job; both '
  'carry course_id and are now scoped. Latent only because those tables are empty today — which '
  'is also why the first test of it passed for the wrong reason. (3) BUG: a Trainer could not '
  'create a course at all — createCourse() emits INSERT ... RETURNING and the returned row failed '
  'courses_read because the AFTER-INSERT owner assignment is not usable yet; a creator branch '
  'fixes it, gated on STILL holding courses.create so provenance cannot outlive employment. '
  '(4) BUG: #46 locked everyone, Super Admins included, out of replacing feature-guide videos, '
  'which live at feature-guides/<key>/<file> and correctly parse to NULL; restored as its own '
  'branch rather than by loosening the parser. (5) PERF: the per-row can_manage_course() call sat '
  'AHEAD of the member branch in five read policies, so every student paid a SECURITY DEFINER '
  'call per row; each staff branch now sits behind an InitPlan-able capability test.')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--   -- 1) An Ops Admin can no longer write money:
--   select policyname, cmd from pg_policies
--    where schemaname='public' and tablename in ('subscriptions','enrollment_requests')
--    order by tablename, policyname;
--     -- expect *_staff_read (SELECT), enroll_req_staff_update (UPDATE),
--     -- *_super_write (ALL), plus the student own-row policies
--
--   -- 2) All three AI-trainer tables are course-scoped:
--   select policyname, qual ilike '%can_manage_course%' as scoped from pg_policies
--    where schemaname='public' and tablename like 'course_ai%';
--
--   -- 3) The staff branch is behind an InitPlan guard in every read policy:
--   select policyname from pg_policies
--    where schemaname in ('public','storage')
--      and qual ilike '%can_manage_course%'
--      and qual not ilike '%has_staff_permission%';
--     -- expect ZERO rows: a bare per-row call with no capability guard in front
--
--   -- 4) Feature guides are editable again (as a Super Admin):
--   select public.course_object_course_id('feature-guides/mockinterview/x.mp4') is null as still_null;
--     -- expect true — the parser is unchanged; the policy gained a separate branch
-- ─────────────────────────────────────────────────────────────────────────────
