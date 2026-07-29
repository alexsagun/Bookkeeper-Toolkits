-- ─────────────────────────────────────────────────────────────────────────────
-- Backend performance — RLS initplan wraps + FK/hot-path indexes (#29)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY (from the 2026-07-26 full backend audit against the live project):
--   • 42 RLS policies called auth.uid()/auth.jwt()/is_admin()/is_approved()/
--     is_enrolled()/plan_is_*() BARE in USING/WITH CHECK. Postgres re-evaluates a
--     bare call PER CANDIDATE ROW; wrapped in a scalar subquery `(select fn())` it
--     becomes a one-per-statement InitPlan. Semantics are identical (all wrapped
--     helpers are zero-arg + STABLE); only the plan changes. (The community
--     #23/#24 policies were already authored wrapped — this brings the older
--     course/enrollment/import/storage-era policies up to the same idiom.
--     `course_object_allowed(name)` is deliberately NOT wrapped: it takes a
--     per-row argument, so a subselect stays correlated and wins nothing.)
--   • 29 foreign keys had no covering index — every cascade delete (course, post,
--     profile) seq-scans the child table, and the hottest authenticated query
--     (useEnrollmentGate's latest-request read: WHERE user_id ORDER BY created_at
--     DESC LIMIT 1) had no usable index at all.
--   • 5 indexes were exact duplicates / redundant with a PK or unique constraint.
--
-- Deliberately SKIPPED indexes (documented decision, revisit at real scale):
--   • auth.users audit columns (reviewed_by/approved_by/rejected_by/updated_by):
--     admin rows are essentially never deleted; write cost isn't worth it yet.
--   • enrollment_requests.plan_key → enrollment_plans: ~5-row parent, never
--     bulk-deleted.
--   • storage.s3_multipart_* / vector tables: Supabase-managed schema.
--
-- Plain CREATE INDEX (not CONCURRENTLY) is intentional: current tables are tiny
-- (< a few hundred rows) so the lock is milliseconds, and CONCURRENTLY cannot run
-- inside a transaction (the SQL editor / Management API wraps this file in one).
-- If you ever re-run this on a LARGE table, split the index section out and use
-- CREATE INDEX CONCURRENTLY statement-by-statement.
--
-- ORDER: run AFTER #20/#21 (it re-asserts policies from earlier migrations;
-- missing policies are skipped with a NOTICE, so partial installs are safe).
-- IDEMPOTENT — safe to re-run.
-- HOW TO RUN: paste into Supabase SQL Editor → Run (or apply via the CLI/API).
-- ─────────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────
-- 1) Wrap bare zero-arg auth/gate calls in scalar subqueries (InitPlan).
--    Generated from the live pg_policies definitions; each statement is guarded
--    so a DB missing a policy (older install) skips it with a NOTICE.
-- ───────────────────────────────────────────────────────────────────
do $wrap$
begin
  begin
    alter policy ai_training_checkpoints_own_read on public.ai_training_checkpoints
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy ai_training_checkpoints_own_read on public.ai_training_checkpoints not found - skipped';
  end;
  begin
    alter policy ai_training_usage_admin_read on public.ai_training_usage
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy ai_training_usage_admin_read on public.ai_training_usage not found - skipped';
  end;
  begin
    alter policy course_ai_chunks_admin_read on public.course_ai_chunks
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy course_ai_chunks_admin_read on public.course_ai_chunks not found - skipped';
  end;
  begin
    alter policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs not found - skipped';
  end;
  begin
    alter policy course_ai_sources_admin_all on public.course_ai_sources
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy course_ai_sources_admin_all on public.course_ai_sources not found - skipped';
  end;
  begin
    alter policy completions_own on public.course_completions
          using ((user_id = (select auth.uid())))
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy completions_own on public.course_completions not found - skipped';
  end;
  begin
    alter policy lessons_admin_write on public.course_lessons
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy lessons_admin_write on public.course_lessons not found - skipped';
  end;
  begin
    alter policy modules_admin_write on public.course_modules
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy modules_admin_write on public.course_modules not found - skipped';
  end;
  begin
    alter policy courses_admin_write on public.courses
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy courses_admin_write on public.courses not found - skipped';
  end;
  begin
    alter policy enrollment_plans_admin_write on public.enrollment_plans
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy enrollment_plans_admin_write on public.enrollment_plans not found - skipped';
  end;
  begin
    alter policy enroll_req_admin_all on public.enrollment_requests
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy enroll_req_admin_all on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy enroll_req_own_expire on public.enrollment_requests
          using (((user_id = (select auth.uid())) AND (status = 'pending_review'::text) AND (expires_at < now())))
          with check (((user_id = (select auth.uid())) AND (status = 'expired'::text)));
  exception when undefined_object then
    raise notice 'policy enroll_req_own_expire on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy enroll_req_own_insert on public.enrollment_requests
          with check (((user_id = (select auth.uid())) AND (status = 'pending_review'::text)));
  exception when undefined_object then
    raise notice 'policy enroll_req_own_insert on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy enroll_req_own_select on public.enrollment_requests
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy enroll_req_own_select on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy feature_guides_admin_write on public.feature_guides
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy feature_guides_admin_write on public.feature_guides not found - skipped';
  end;
  begin
    alter policy feature_guides_read on public.feature_guides
          using (((select is_approved()) AND (select is_enrolled())));
  exception when undefined_object then
    raise notice 'policy feature_guides_read on public.feature_guides not found - skipped';
  end;
  begin
    alter policy fvc_insert_own on public.feature_video_completions
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy fvc_insert_own on public.feature_video_completions not found - skipped';
  end;
  begin
    alter policy fvc_select_own on public.feature_video_completions
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy fvc_select_own on public.feature_video_completions not found - skipped';
  end;
  begin
    alter policy fvc_update_own on public.feature_video_completions
          using ((user_id = (select auth.uid())))
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy fvc_update_own on public.feature_video_completions not found - skipped';
  end;
  begin
    alter policy progress_own on public.lesson_progress
          using ((user_id = (select auth.uid())))
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy progress_own on public.lesson_progress not found - skipped';
  end;
  begin
    alter policy payment_settings_admin_write on public.payment_settings
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy payment_settings_admin_write on public.payment_settings not found - skipped';
  end;
  begin
    alter policy own_profile_select on public.profiles
          using (((select auth.uid()) = id));
  exception when undefined_object then
    raise notice 'policy own_profile_select on public.profiles not found - skipped';
  end;
  begin
    alter policy profiles_admin_select on public.profiles
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy profiles_admin_select on public.profiles not found - skipped';
  end;
  begin
    alter policy profiles_admin_update on public.profiles
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy profiles_admin_update on public.profiles not found - skipped';
  end;
  begin
    alter policy sidebar_settings_admin_write on public.sidebar_settings
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy sidebar_settings_admin_write on public.sidebar_settings not found - skipped';
  end;
  begin
    alter policy student_external_accounts_admin_all on public.student_external_accounts
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_external_accounts_admin_all on public.student_external_accounts not found - skipped';
  end;
  begin
    alter policy student_external_accounts_own_select on public.student_external_accounts
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy student_external_accounts_own_select on public.student_external_accounts not found - skipped';
  end;
  begin
    alter policy student_import_events_admin_insert on public.student_import_events
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_events_admin_insert on public.student_import_events not found - skipped';
  end;
  begin
    alter policy student_import_events_admin_select on public.student_import_events
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_events_admin_select on public.student_import_events not found - skipped';
  end;
  begin
    alter policy student_import_jobs_admin_all on public.student_import_jobs
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_jobs_admin_all on public.student_import_jobs not found - skipped';
  end;
  begin
    alter policy student_import_rows_admin_all on public.student_import_rows
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_rows_admin_all on public.student_import_rows not found - skipped';
  end;
  begin
    alter policy subscriptions_admin_all on public.subscriptions
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy subscriptions_admin_all on public.subscriptions not found - skipped';
  end;
  begin
    alter policy subscriptions_own_select on public.subscriptions
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy subscriptions_own_select on public.subscriptions not found - skipped';
  end;
  begin
    alter policy course_media_admin_delete on storage.objects
          using (((bucket_id = 'course-media'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_media_admin_delete on storage.objects not found - skipped';
  end;
  begin
    alter policy course_media_admin_update on storage.objects
          using (((bucket_id = 'course-media'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_media_admin_update on storage.objects not found - skipped';
  end;
  begin
    alter policy course_media_admin_write on storage.objects
          with check (((bucket_id = 'course-media'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_media_admin_write on storage.objects not found - skipped';
  end;
  begin
    alter policy course_videos_admin_delete on storage.objects
          using (((bucket_id = 'course-videos'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_videos_admin_delete on storage.objects not found - skipped';
  end;
  begin
    alter policy course_videos_admin_update on storage.objects
          using (((bucket_id = 'course-videos'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_videos_admin_update on storage.objects not found - skipped';
  end;
  begin
    alter policy course_videos_admin_write on storage.objects
          with check (((bucket_id = 'course-videos'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_videos_admin_write on storage.objects not found - skipped';
  end;
  begin
    alter policy enrollment_receipts_delete on storage.objects
          using (((bucket_id = 'enrollment-receipts'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy enrollment_receipts_delete on storage.objects not found - skipped';
  end;
  begin
    alter policy enrollment_receipts_insert_own on storage.objects
          with check (((bucket_id = 'enrollment-receipts'::text) AND ((storage.foldername(name))[1] = ((select auth.uid()))::text)));
  exception when undefined_object then
    raise notice 'policy enrollment_receipts_insert_own on storage.objects not found - skipped';
  end;
  begin
    alter policy enrollment_receipts_select on storage.objects
          using (((bucket_id = 'enrollment-receipts'::text) AND (((storage.foldername(name))[1] = ((select auth.uid()))::text) OR (select is_admin()))));
  exception when undefined_object then
    raise notice 'policy enrollment_receipts_select on storage.objects not found - skipped';
  end;
end $wrap$;

-- ───────────────────────────────────────────────────────────────────
-- 2) Drop exact-duplicate / PK-redundant indexes (each duplicated by the index
--    named in the trailing comment; none backs a constraint).
-- ───────────────────────────────────────────────────────────────────
drop index if exists public.idx_lessons_module;                 -- = course_lessons_module_position_idx (module_id, position)
drop index if exists public.idx_modules_course;                 -- = course_modules_course_position_idx (course_id, position)
drop index if exists public.idx_progress_user_course;           -- = lesson_progress_user_course_idx (user_id, course_id)
drop index if exists public.course_completions_user_course_idx; -- = course_completions_pkey (user_id, course_id)
drop index if exists public.courses_slug_idx;                   -- = courses_slug_key unique index (slug)

-- ───────────────────────────────────────────────────────────────────
-- 3) Hot-path index: the enrollment gate's own-latest-request read
--    (WHERE user_id = $uid ORDER BY created_at DESC LIMIT 1) — the single most
--    frequent authenticated query. Also serves the drawer's last-5 history read.
-- ───────────────────────────────────────────────────────────────────
create index if not exists enrollment_requests_user_created_idx
  on public.enrollment_requests (user_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────
-- 4) FK covering indexes — cascade-delete + join paths.
--    Course platform (course/lesson deletes cascade into these):
-- ───────────────────────────────────────────────────────────────────
create index if not exists lesson_progress_lesson_idx
  on public.lesson_progress (lesson_id);
create index if not exists course_completions_course_idx
  on public.course_completions (course_id);
create index if not exists courses_source_course_idx
  on public.courses (source_course_id) where source_course_id is not null;
create index if not exists ai_training_checkpoints_course_idx
  on public.ai_training_checkpoints (course_id);
create index if not exists ai_training_checkpoints_lesson_idx
  on public.ai_training_checkpoints (lesson_id);
create index if not exists course_ai_index_jobs_source_idx
  on public.course_ai_index_jobs (source_id);

--    Community (post hard-deletes cascade into these; author columns are hit
--    when a profile is deleted and by author-scoped reads):
create index if not exists community_notifications_post_idx
  on public.community_notifications (post_id);
create index if not exists community_notifications_comment_idx
  on public.community_notifications (comment_id) where comment_id is not null;
create index if not exists community_notifications_actor_idx
  on public.community_notifications (actor_id);
create index if not exists community_announcement_reads_post_idx
  on public.community_announcement_reads (post_id);
create index if not exists community_posts_author_idx
  on public.community_posts (author_id);
create index if not exists community_comments_author_idx
  on public.community_comments (author_id);
create index if not exists community_reactions_user_idx
  on public.community_reactions (user_id);
create index if not exists community_attachments_uploader_idx
  on public.community_attachments (uploader_id);

--    Subscriptions lineage + request linkage (renewal chains, approve lookups):
create index if not exists subscriptions_renewed_from_idx
  on public.subscriptions (renewed_from_subscription_id) where renewed_from_subscription_id is not null;
create index if not exists subscriptions_request_idx
  on public.subscriptions (request_id) where request_id is not null;

--    Student imports (job purges + audit lookups):
create index if not exists student_external_accounts_job_idx
  on public.student_external_accounts (import_job_id);
create index if not exists student_external_accounts_row_idx
  on public.student_external_accounts (import_row_id);
create index if not exists student_import_events_row_idx
  on public.student_import_events (row_id);
create index if not exists student_import_events_actor_idx
  on public.student_import_events (actor);
create index if not exists student_import_rows_target_user_idx
  on public.student_import_rows (target_user_id) where target_user_id is not null;

-- 5) Refresh PostgREST's schema cache.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • The performance advisor's auth_rls_initplan warnings drop to zero; every
--     policy evaluates auth/gate helpers once per statement.
--   • Cascade deletes (courses, posts, profiles) and the enrollment-gate read use
--     index scans instead of sequential scans as the tables grow.
--   • 5 duplicate/redundant indexes no longer tax every write.
-- ─────────────────────────────────────────────────────────────────────────────
