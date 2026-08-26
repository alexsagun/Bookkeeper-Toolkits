-- ─────────────────────────────────────────────────────────────────────────────
-- #44 — Course lesson video becomes UPLOAD-ONLY, and the private bucket stops
--       deriving authorization from the object's PATH.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS
--   A lesson's primary content could be a pasted YouTube/Vimeo/direct-MP4 URL.
--   parseVideoUrl() (src/BookkeeperPro.jsx) classified ANY unrecognised string
--   as 'mp4', saveLesson() stored it verbatim, and renderVideo() bound it into
--   <video src> — with no scheme check anywhere on that path. More to the point,
--   a YouTube id in course_lessons.video_url is a permanent, public,
--   un-revokable pointer to material a member paid for. Lesson video now lives
--   only in the PRIVATE course-videos bucket, served through short-lived signed
--   URLs gated by RLS.
--
-- WHAT THIS FIXES, in the order the sections appear.
--
--   1) SECURITY — course_object_allowed() authorised by parsing the object name.
--      It read split_part(name,'/',2)::uuid and returned TRUE on an unparseable
--      path, TRUE on an unknown course id, and TRUE for every non-sampler plan
--      before it looked at anything. It never checked that segment 1 was
--      literally 'lessons', and it never checked courses.published — so any
--      enrolled member on a full-access plan could read an object belonging to
--      an UNPUBLISHED course, or an orphan no lesson references at all.
--      course_video_object_readable() replaces it and asks the only question
--      that is actually true: does a PUBLISHED lesson this caller's plan may
--      read reference this exact storage_path?
--
--   2) CORRECTNESS — the path parser was also WRONG for duplicated courses.
--      CourseCatalog.duplicateCourse copies storage_path by reference
--      (copy-on-write; no bytes are copied), so a duplicate's video physically
--      lives in the SOURCE course's folder. A Sampler enrolled in an Essentials
--      duplicate was denied their own video because the path named the standard
--      -tier original. Reference-based lookup gets this right in both directions.
--
--   3) SECURITY — course_videos_read was the ONLY one of the four content-read
--      policies with no is_approved() conjunct. Added.
--
--   4) ENFORCEMENT — course_lessons_video_guard() refuses to let a lesson
--      BECOME link-backed. Removing the React input alone left a direct
--      PostgREST call able to write a YouTube URL straight into video_url.
--
--   5) ENFORCEMENT — courses_publish_guard() refuses to publish a course whose
--      video lessons are not upload-backed. togglePublished() flipped
--      courses.published with zero validation.
--
--   6) OPS — the course-videos bucket's file_size_limit and allowed_mime_types
--      are finally RE-ASSERTED. #15's `on conflict (id) do update set public =
--      false` touched only `public`, so no file in this repo could correct a
--      drifted bucket. Raised to 2 GiB and narrowed to video/mp4, in lockstep
--      with src/lib/courseVideo.js.
--
-- ★ NOTHING HERE WIDENS ACCESS. Every change to a read path is a tightening:
--   three fail-open branches become fail-closed, and one missing gate is added.
--   Section 8 REMOVES a function; it adds none that anyone could call to see
--   more than before.
--
-- ★ THIS FILE SUPERSEDES db/2026-08-17-three-plan-catalog.sql:221-290 for the
--   private video bucket. That file is history and is deliberately left alone.
--   Note the consequence for `npm run db:shadow:apply --all`: its filter picks
--   up every dated file from db/2026-07-30 onward, so #39's dated copy runs
--   AFTER this file's bootstrap fold and re-creates course_object_allowed() and
--   reverts course_videos_read to its fail-open form — before this file's dated
--   copy runs and puts both right again. The end state is correct, but there IS
--   a window in the middle. That is acceptable on a shadow project and must
--   never be how production is applied: in production, run dated files in
--   #-order, once each.
--
-- Depends on: #2 (course platform), #9 (is_approved), #12/#13 (is_enrolled),
--   #15 (the course-videos bucket), #19 (plan_is_sampler, courses.access_tier),
--   #31 (schema_migrations), #35 (app_error), #39 (the current policy shape).
-- HOW TO RUN: Supabase → SQL Editor → Run. IDEMPOTENT. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight ============================================================
-- Guard on schema_migrations first: without it the tail insert aborts the file.
--
-- ★ course_object_allowed() is deliberately NOT required — section 8 drops it,
--   so requiring it would make this file fail its own second run.
--
-- ★ The course_videos_read check RAISES rather than RAISE NOTICE. #29's
--   ALTER POLICY blocks use a `when undefined_object then raise notice` handler,
--   which is right for a performance rewrite and wrong here: quietly skipping
--   section 2 would leave the private video bucket on the fail-open predicate
--   while every other section reported success.
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.course_lessons') is null or to_regclass('public.courses') is null then
    raise exception 'Run db/2026-06-16-course-platform-base.sql (#2) first.';
  end if;
  if to_regprocedure('public.app_error(text,text,int,jsonb)') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) first.';
  end if;
  if to_regprocedure('public.plan_is_sampler()') is null then
    raise exception 'Run db/2026-07-11-sampler-essentials-access.sql (#19) first.';
  end if;
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_approved()') is null
     or to_regprocedure('public.is_enrolled()') is null then
    raise exception 'Run #9 (user-approval) + #12/#13 (enrollment + lifecycle) first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'courses'
                    and column_name = 'access_tier') then
    raise exception 'Run db/2026-07-11-sampler-essentials-access.sql (#19) first.';
  end if;
  if not exists (select 1 from storage.buckets where id = 'course-videos') then
    raise exception 'Run db/2026-07-08-course-videos-private.sql (#15) first — this file rewrites that bucket''s read policy.';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'storage' and policyname = 'course_videos_read') then
    raise exception 'course_videos_read is missing from storage.objects — run #15/#19/#39 first. Refusing to continue: section 2 would silently leave the private video bucket ungated.';
  end if;
end
$pre$;


-- == 1) Reference-based read authorization ===================================
-- Replaces course_object_allowed()'s path parsing with the question that is
-- actually true: is this object referenced by a PUBLISHED lesson the caller's
-- plan may read? A malformed path, an orphan, and an object under a draft
-- course now all resolve to FALSE structurally — an EXISTS over zero rows —
-- rather than through a defensive branch someone can delete.
--
-- MIRRORS courses_read (db/2026-08-17-three-plan-catalog.sql:249-258). Drift
-- here is a security bug. The policy keeps is_admin/is_approved/is_enrolled;
-- this function owns `published` and the sampler tier rule.
--
-- SECURITY DEFINER is load-bearing, not stylistic: a sampler cannot SELECT the
-- Mastery course row at all, so an invoker-rights version would find no row and
-- fail OPEN — which is precisely how the function it replaces went wrong.
--
-- `language sql` because there is nothing to catch any more (the uuid cast that
-- forced course_object_allowed into plpgsql is gone). Note it will NOT be
-- inlined — SQL inlining requires prosecdef = false — so the gain is purely the
-- per-call plpgsql executor setup, which matters if this is ever evaluated per
-- row over a listing.
--
-- ★ p_is_sampler is a PERFORMANCE HINT the policy supplies so plan_is_sampler()
--   is evaluated once per statement as an InitPlan instead of once per row. It
--   defaults to NULL and coalesces to the real value, so a one-argument call is
--   still correct. It is NOT an authorization input: the policy always passes
--   the true value, so what a direct caller passes changes only what THAT
--   caller is told, never what the policy computes.
--
-- ★ set search_path = public, pg_temp — naming pg_temp LAST is deliberate.
--   When pg_temp is not named it is searched FIRST for relation names, so a
--   user who can create a temp table could shadow an unqualified reference
--   inside a SECURITY DEFINER body. Every reference below is schema-qualified
--   as well, so this is belt and braces; keep both.
create or replace function public.course_video_object_readable(
  p_name       text,
  p_is_sampler boolean default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.course_lessons l
      join public.courses c on c.id = l.course_id
     where l.storage_path = p_name
       and c.published = true
       and ((not coalesce(p_is_sampler, public.plan_is_sampler()))
            or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
  )
$fn$;

comment on function public.course_video_object_readable(text, boolean) is
  '#44: authorizes a course-videos object by REFERENCE, not by parsing its path. '
  'True only when a published lesson the caller''s plan may read cites this exact '
  'course_lessons.storage_path. Replaces course_object_allowed(), which failed OPEN '
  'on an unparseable path, on an unknown course, and for every non-sampler plan, and '
  'which mis-authorized duplicated courses because duplication reuses the SOURCE '
  'course''s folder. MIRRORS courses_read — drift here is a security bug.';

revoke all on function public.course_video_object_readable(text, boolean) from public, anon;
-- Required, not optional: an RLS qual is evaluated AS THE QUERYING ROLE, so
-- without this grant every non-admin read fails with "permission denied for
-- function" rather than with a clean authorization denial.
grant execute on function public.course_video_object_readable(text, boolean) to authenticated;


-- == 2) The private-bucket read policy =======================================
-- ALTER, not DROP+CREATE, for #39's reason: scripts/apply-db-files.mjs sends one
-- statement per HTTP round trip, so a DROP+CREATE is a real window during which
-- the private video bucket has NO read policy.
--
-- ★ is_approved() is ADDED here. course_videos_read was the only one of the four
--   content-read policies without it. The tightening should be a no-op in
--   practice — an unapproved member cannot read courses/modules/lessons, so they
--   have no way to learn a storage_path — and the AFTER RUNNING block below has
--   a query to confirm that before you rely on it.
--
-- ★ course_video_object_readable(name, ...) is deliberately NOT wrapped in
--   (select ...). It takes a per-row argument, so a subselect would stay
--   CORRELATED and become a per-row SubPlan — strictly worse, and it would
--   destroy the OR short-circuit that lets an admin pay one is_admin() call for
--   a whole listing. Same note as db/000_full_database_bootstrap.sql:2413.
--   The zero-argument helpers around it ARE wrapped, so each is one InitPlan.
alter policy course_videos_read on storage.objects
  using (
    bucket_id = 'course-videos'
    and ((select public.is_admin())
         or ((select public.is_approved())
             and (select public.is_enrolled())
             and public.course_video_object_readable(name, (select public.plan_is_sampler()))))
  );

comment on policy course_videos_read on storage.objects is
  '#44: reference-based. An object is readable only while a published lesson the '
  'caller may read cites its exact path. Orphans, malformed paths and draft-course '
  'objects fail closed. Admins short-circuit before the per-object lookup.';


-- == 3) The index that makes the lookup cheap ================================
-- `storage_path = $1` implies `storage_path is not null` (the operator is
-- strict), so the planner can prove the partial predicate is satisfied and will
-- use this index. Contrast #43's lesson: community_posts_channel_feed_idx
-- carried `where status='active'`, which the query did NOT imply, so the index
-- was unusable and every feed page seq-scanned.
create index if not exists course_lessons_storage_path_idx
  on public.course_lessons (storage_path)
  where storage_path is not null;

comment on index public.course_lessons_storage_path_idx is
  '#44: course_video_object_readable() and removeMediaIfUnreferenced() both look a '
  'storage object up by its exact path. Partial because most lessons have none.';


-- == 4) A lesson may not BECOME link-backed ==================================
-- SECURITY DEFINER is mandatory, not stylistic: public.app_error is
-- `revoke all ... from public, anon, authenticated` and is SECURITY INVOKER, so
-- a definer-less trigger would fail with "permission denied for function
-- app_error" on every refusal it tried to raise.
create or replace function public.course_lessons_video_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_new_link  boolean;
  v_old_link  boolean;
  v_override  boolean;
  v_published boolean;
begin
  -- Break-glass, #38's shape. Gated on OWNERSHIP of course_lessons, not on
  -- rolsuper: Supabase's `postgres` is not a superuser, so a superuser gate
  -- would be unreachable on the one database that needs it. PostgREST connects
  -- as `authenticator`, which is not a member of the owner, so the API can never
  -- reach this — it only makes a deliberate hand-fix explicit.
  --   begin;
  --     set local app.lesson_video_override = 'on';
  --     update public.course_lessons set ... where id = ...;
  --   commit;
  v_override := coalesce(current_setting('app.lesson_video_override', true), '') = 'on'
    and pg_has_role(session_user,
                    (select c.relowner from pg_class c
                       join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'course_lessons'),
                    'member');
  if v_override then
    return new;
  end if;

  -- ★ "Link-backed" is derived from video_url, NEVER from video_provider.
  --   CourseProgram.saveLesson re-derives the provider from the URL on every
  --   save via parseVideoUrl(), whose YouTube pattern requires exactly 11 word
  --   characters — so a legacy row it can no longer parse (youtube.com/live/...,
  --   music.youtube.com, an extra path segment) silently flips 'youtube' to
  --   'mp4' on a TITLE-ONLY edit. A provider-equality rule would refuse that
  --   edit forever, from a guard that only ever meant to stop NEW links, and the
  --   admin would have no way to fix it from the UI.
  v_new_link := new.type = 'video'
    and coalesce(new.video_provider, '') <> 'upload'
    and nullif(btrim(coalesce(new.video_url, '')), '') is not null;

  v_old_link := tg_op = 'UPDATE'
    and old.type = 'video'
    and coalesce(old.video_provider, '') <> 'upload'
    and nullif(btrim(coalesce(old.video_url, '')), '') is not null;

  -- MONOTONIC on video_url: refuse the transition INTO link-backed, and refuse
  -- RE-POINTING an existing one at a different URL. Everything else a legacy row
  -- needs stays legal — editing its title, letting video_provider drift (which
  -- saveLesson used to do on every write), clearing the link, replacing it with an
  -- upload, being reordered.
  --
  -- ★ The comparison is on video_url and NEVER on video_provider. saveLesson
  --   re-derived the provider from the URL on every single save via parseVideoUrl(),
  --   whose YouTube pattern requires exactly 11 word characters — so a stored
  --   'youtube' row whose URL it no longer recognises (youtube.com/live/…, an extra
  --   path segment) silently became 'mp4' on a TITLE-ONLY edit. Comparing providers
  --   would have refused that edit forever, from a guard that only ever meant to
  --   stop NEW links, and the admin would have had no way to fix it from the UI.
  if v_new_link and (not v_old_link or new.video_url is distinct from old.video_url) then
    if tg_op = 'UPDATE' then
      perform public.app_error('LESSON_VIDEO_UPLOAD_ONLY',
        'lesson videos must be uploaded to the private course-videos bucket — YouTube, Vimeo and direct-link lessons are no longer accepted',
        409, jsonb_build_object('lesson_id', new.id, 'course_id', new.course_id));
    else
      -- ★ On INSERT this bites only a PUBLISHED course. It must not bite a draft,
      --   because CourseCatalog.duplicateCourse bulk-inserts lessons copying
      --   video_provider/video_url verbatim into a published:false copy — and its
      --   catch block DELETES the half-built course. An unconditional INSERT
      --   prohibition would therefore turn "duplicate a pre-#44 course" into
      --   silent destruction of the admin's new course, its modules and every
      --   lesson already copied. A link sitting in a draft harms nobody; section
      --   5 is what stops it reaching a student.
      select c.published into v_published from public.courses c where c.id = new.course_id;
      if coalesce(v_published, false) then
        perform public.app_error('LESSON_VIDEO_UPLOAD_ONLY',
          'a published course cannot take a link-backed video lesson — upload the video file instead',
          409, jsonb_build_object('lesson_id', new.id, 'course_id', new.course_id));
      end if;
    end if;
  end if;

  -- An upload-backed row must name a real lessons/<uuid>/<file> object.
  -- ★ Checked ONLY when storage_path actually changes: CourseProgram.moveLesson
  --   updates position alone, and in a BEFORE UPDATE trigger NEW still carries
  --   the old path — so an unconditional check would make a legacy or
  --   hand-repaired non-conforming row permanently unreorderable.
  -- ★ The uuid is deliberately NOT pinned to new.course_id. Duplication is
  --   copy-on-write and legitimately reuses the SOURCE course's folder, which is
  --   the entire reason removeMediaIfUnreferenced() exists.
  if new.video_provider = 'upload'
     and (tg_op = 'INSERT' or new.storage_path is distinct from old.storage_path) then
    if coalesce(new.storage_path, '') !~ '^lessons/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.+' then
      perform public.app_error('LESSON_VIDEO_PATH_INVALID',
        'an uploaded lesson video must live at lessons/<course-uuid>/<file> in the course-videos bucket',
        422, jsonb_build_object('lesson_id', new.id));
    end if;
  end if;

  return new;
end;
$fn$;

comment on function public.course_lessons_video_guard() is
  '#44: a lesson may not BECOME link-backed. Monotonic on video_url — never on '
  'video_provider, which saveLesson re-derives from the URL on every write. On INSERT '
  'it fires only for a published course, so duplicating a pre-#44 course cannot trip '
  'the client rollback that deletes the half-built copy.';

drop trigger if exists course_lessons_video_guard on public.course_lessons;
create trigger course_lessons_video_guard
  before insert or update on public.course_lessons
  for each row execute function public.course_lessons_video_guard();


-- == 5) A course may not be PUBLISHED with unplayable video lessons ==========
-- The preflight the UI calls before offering to publish. Admin-gated inside the
-- body so a SECURITY DEFINER function cannot become a content oracle.
--
-- "video lesson" is NOT `type='video'` alone. saveLesson explicitly permits a
-- video-typed lesson whose only content is text_content, written with all three
-- video columns null; treating those as blockers would permanently un-publish
-- every course containing one.
create or replace function public.course_publish_blockers(p_course_id uuid)
returns table (lesson_id uuid, module_id uuid, title text, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select l.id, l.module_id, l.title,
         case when l.video_provider = 'upload' then 'upload_missing_file'
              else 'external_link' end
    from public.course_lessons l
   where public.is_admin()
     and l.course_id = p_course_id
     and l.type = 'video'
     and (
       (coalesce(l.video_provider, '') <> 'upload'
        and nullif(btrim(coalesce(l.video_url, '')), '') is not null)
       or (l.video_provider = 'upload' and l.storage_path is null)
     )
   order by l.position, l.id
$fn$;

comment on function public.course_publish_blockers(uuid) is
  '#44: the lessons stopping a course from being published — a link-backed video, or '
  'an upload row with no file. Admin-gated inside the body. The UI preflight; '
  'courses_publish_guard is the boundary.';

revoke all on function public.course_publish_blockers(uuid) from public, anon;
grant execute on function public.course_publish_blockers(uuid) to authenticated;

create or replace function public.courses_publish_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n int;
begin
  -- No state test here on purpose: the trigger's WHEN clause has already
  -- narrowed this to the false -> true transition. Testing state instead
  -- (new.published = true) would refuse EVERY unrelated update on an
  -- already-published course — reorderCourse (which fires N updates in a
  -- Promise.all and would leave positions inconsistent on a partial failure),
  -- uploadCover, setCourseTier, saveCourseMeta and the AI-trainer toggle all
  -- write to a published row without touching `published`.
  select count(*) into v_n
    from public.course_lessons l
   where l.course_id = new.id
     and l.type = 'video'
     and (
       (coalesce(l.video_provider, '') <> 'upload'
        and nullif(btrim(coalesce(l.video_url, '')), '') is not null)
       or (l.video_provider = 'upload' and l.storage_path is null)
     );
  if v_n > 0 then
    perform public.app_error('COURSE_PUBLISH_BLOCKED',
      format('%s lesson(s) still play from an external link or have no uploaded file — upload their videos before publishing', v_n),
      409, jsonb_build_object('course_id', new.id, 'blockers', v_n));
  end if;
  return new;
end;
$fn$;

comment on function public.courses_publish_guard() is
  '#44: refuses to publish a course with a link-backed or file-less video lesson. '
  'SECURITY DEFINER so it counts lessons RLS would hide from it in a draft course.';

drop trigger if exists courses_publish_guard on public.courses;
create trigger courses_publish_guard
  before update on public.courses
  for each row
  when (new.published and not old.published)
  execute function public.courses_publish_guard();


-- == 6) The error codes, re-listed in full ===================================
-- app_error_catalog() is replaced wholesale every time, so every existing code
-- must be repeated. Keep in lockstep with APP_ERROR_CODES and APP_ERROR_COPY in
-- src/lib/appErrors.js. Copied from #40 plus the three #44 codes.
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
    ('COURSE_PUBLISH_BLOCKED',       409, 'The course still has video lessons with no uploaded file.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


-- == 7) Re-assert the bucket =================================================
-- ★ #15 wrote `on conflict (id) do update set public = false` and nothing else,
--   so file_size_limit and allowed_mime_types have been write-once since the
--   bucket was created and NO file in this repo could correct a drift. Every
--   other bucket in the project (enrollment-receipts, community-media, avatars)
--   re-asserts both. This one now does too.
--
-- ★ allowed_mime_types is consulted ONLY on upload (storage-api's
--   validateMimeType, on the upload paths). GET /object, GET /object/sign,
--   createSignedUrl, copy and move never consult it, so narrowing to video/mp4
--   does NOT make an existing .mov or .webm object unreadable — it only refuses
--   NEW non-MP4 uploads. That is exactly the intent, and it lands in the same
--   change as the client's own mp4-only accept list (src/lib/courseVideo.js).
--
-- ★ file_size_limit is a CEILING, not a grant: storage-api enforces
--   min(bucket limit, project-wide upload limit). Raising it here does nothing
--   until the project limit is raised in Dashboard → Storage → Settings. See
--   AFTER RUNNING.
do $blk$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('course-videos', 'course-videos', false, 2147483648, array['video/mp4'])
  on conflict (id) do update
    set public             = false,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception
  when insufficient_privilege then
    raise notice 'Could not update course-videos from SQL. In Dashboard → Storage → course-videos → Settings, set Public = OFF, the file size limit to 2 GB, and allowed MIME types to video/mp4.';
end
$blk$;


-- == 8) Retire the fail-open path parser =====================================
-- ★ AFTER section 2, and with NO CASCADE, on purpose. ALTER POLICY records a
--   pg_depend entry on the function its USING clause names, so while
--   course_videos_read still referenced course_object_allowed this DROP would
--   ERROR and stop the file — rather than silently stripping a read policy.
--   Same safety property #39 relies on when it drops plan_is_qbo_only().
drop function if exists public.course_object_allowed(text);


-- == 9) Refresh PostgREST ====================================================
-- course_publish_blockers() is a new RPC the client calls by name.
notify pgrst, 'reload schema';


insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-24-course-video-upload-only.sql', null,
  'course video upload-only (#44): replaces course_object_allowed() — which parsed '
  'the object path and failed OPEN on an unparseable path, an unknown course and '
  'every non-sampler plan, ignored courses.published, and mis-authorized duplicated '
  'courses that share a storage_path — with reference-based '
  'course_video_object_readable(); adds the missing is_approved() conjunct to '
  'course_videos_read; indexes course_lessons.storage_path; adds '
  'course_lessons_video_guard (a lesson may not BECOME link-backed, monotonic on '
  'video_url and published-gated on INSERT so duplication cannot trip the client '
  'rollback) and courses_publish_guard (delta-scoped by a WHEN clause so unrelated '
  'updates to a published course still work) plus the course_publish_blockers() '
  'preflight; re-asserts the course-videos bucket at 2 GiB / video/mp4, which #15 '
  'never re-applied; three new app_error codes.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--   -- 1) The policy is reference-based and finally checks approval.
--   select qual from pg_policies
--    where schemaname='storage' and policyname='course_videos_read';
--     -- expect course_video_object_readable + is_approved + is_enrolled
--
--   -- 2) The fail-open parser is gone.
--   select to_regprocedure('public.course_object_allowed(text)') is null as dropped;
--
--   -- 3) The publish guard is DELTA-scoped, not state-scoped.
--   select pg_get_triggerdef(oid) from pg_trigger
--    where tgrelid='public.courses'::regclass and tgname='courses_publish_guard';
--     -- expect a WHEN clause naming old.published
--
--   -- 4) Adding is_approved() to the storage policy should be a no-op. Confirm:
--   select count(*) from public.profiles p
--    where public.user_is_enrolled(p.id) and not public.user_is_approved(p.id);
--     -- expect 0. A non-zero count means some enrolled members are unapproved;
--     -- they could not read a lesson row anyway, but check before relying on it.
--
--   -- 5) LEGACY INVENTORY — read-only. Run all five BEFORE changing any data.
--   --    (a) External-link lessons: what can no longer be published.
--   select c.slug, c.published, l.title, l.video_provider, l.video_url
--     from public.course_lessons l join public.courses c on c.id = l.course_id
--    where l.type='video' and coalesce(l.video_provider,'') <> 'upload'
--      and nullif(btrim(coalesce(l.video_url,'')),'') is not null
--    order by c.published desc, c.slug;
--
--   --    (b) Upload lessons whose object is MISSING from the private bucket.
--   select c.slug, c.published, l.title, l.storage_path,
--          (o.id is not null) as object_present, o.metadata->>'mimetype' as mimetype
--     from public.course_lessons l join public.courses c on c.id = l.course_id
--     left join storage.objects o on o.bucket_id='course-videos' and o.name=l.storage_path
--    where l.video_provider='upload' order by object_present, c.slug;
--
--   --    (c) Lessons still served from the PUBLIC course-media bucket. These are
--   --        the ones SignedLessonVideo silently fell back to a public URL for,
--   --        i.e. world-readable today. Move them before shipping the client.
--   select c.slug, c.published, l.title, l.storage_path,
--          (media.id is not null) as in_course_media
--     from public.course_lessons l join public.courses c on c.id = l.course_id
--     left join storage.objects media on media.bucket_id='course-media' and media.name=l.storage_path
--     left join storage.objects vid   on vid.bucket_id='course-videos' and vid.name=l.storage_path
--    where l.storage_path is not null and vid.id is null
--    order by in_course_media desc, c.published desc;
--
--   --    (d) Paths shared by more than one course — the duplicate fan-out the
--   --        new policy exists to authorize correctly.
--   select l.storage_path, count(*) as refs,
--          array_agg(distinct c.slug order by c.slug) as courses,
--          array_agg(distinct c.access_tier) as tiers
--     from public.course_lessons l join public.courses c on c.id = l.course_id
--    where l.storage_path is not null
--    group by l.storage_path having count(*) > 1 order by refs desc;
--
--   --    (e) Orphan objects — readable by any enrolled member before #44,
--   --        unreadable by non-admins after it.
--   select o.name, o.created_at, (o.metadata->>'size')::bigint as bytes
--     from storage.objects o
--    where o.bucket_id='course-videos'
--      and not exists (select 1 from public.course_lessons l where l.storage_path=o.name)
--    order by o.created_at;
--
--   -- 6) MANUAL, and the 2 GiB limit does nothing without it:
--   --    Dashboard → Storage → Settings → raise the project-wide upload limit to
--   --    at least 2 GB (needs a paid plan; the free tier caps at 50 MB).
-- ─────────────────────────────────────────────────────────────────────────────
