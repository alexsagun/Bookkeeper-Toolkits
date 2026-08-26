-- ─────────────────────────────────────────────────────────────────────────────
-- #46 — Trainer course ownership: course_staff_assignments + can_manage_course().
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
--   #45 installed the role model and, in its section 15, made the OPERATIONS
--   surface real. It left the TRAINER surface entirely decorative: six permission
--   keys — courses.create, courses.manage_assigned, courses.manage_all,
--   courses.publish, courses.delete, course_trainer.manage — were seeded into the
--   matrix and then consumed by NOTHING. Every course policy still read
--   is_admin(), which #45 narrowed to "active Super Admin", so a Trainer could not
--   create a course, edit a lesson, upload a video, or open the AI-trainer panel.
--
--   #45 also left a dangling reference in the other direction:
--   api/_lib/staffAuth.js:callerCanManageCourse() already calls
--   `rpc/can_manage_course`, and my_staff_context() already returns an
--   `assigned_course_ids` key hardcoded to '[]' with a comment saying "#46
--   replaces this function". Both are honoured here.
--
-- ★ THE ASYMMETRY THAT MATTERS: PATHS AUTHORIZE WRITES, NEVER READS.
--   #44 deleted course_object_allowed() because it authorized READS by parsing
--   the object path, and failed OPEN three ways — an unparseable name, an unknown
--   course, and every non-sampler plan all returned true. Reads are still
--   reference-based (course_video_object_readable asks whether a published lesson
--   the caller may read cites that exact storage_path) and this file does not
--   touch that.
--
--   WRITES are the opposite question. "Which course does this new object belong
--   to?" has only one honest answer — the folder the writer chose — and the
--   failure mode is inverted: course_object_course_id() returns NULL for anything
--   that is not exactly `lessons/<uuid>/…` or `covers/<uuid>/…`, and
--   user_can_manage_course(uid, NULL) is false. A malformed path therefore denies
--   the write instead of allowing it. That is why the same technique that was a
--   security bug for reads is the correct one here, and why it is written as a
--   strict regex with no fallback branch.
--
-- ★ DUPLICATION SHARES FILES BY REFERENCE, AND THAT IS PRESERVED.
--   CourseCatalog.duplicateCourse() copies storage_path by value, so a duplicate's
--   video physically lives in the SOURCE course's folder. A Trainer assigned only
--   to the duplicate therefore cannot DELETE that file — correct, it is not theirs
--   — while still being able to read it (reads are reference-based) and to upload
--   NEW files into their own course's folder. removeMediaIfUnreferenced() already
--   fails conservatively when it cannot confirm, so nothing breaks.
--
-- ORDERING INSIDE THIS FILE IS LOAD-BEARING:
--   table → helpers → my_staff_context() → write policies → read policies →
--   storage → publish guard → RPCs → catalog → indexes.
--   can_manage_course() must exist before any policy names it.
--
-- Depends on: #2 (courses), #19 (access_tier/plan_is_sampler), #27 (course_ai_*),
--   #31 (schema_migrations), #35 (app_error), #44 (the publish guard this extends),
--   #45 (the staff model). Run #45 and its client build FIRST.
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create … if not exists / create or replace / drop … if exists /
--   on conflict) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight ============================================================
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.staff_memberships') is null
     or to_regprocedure('public.has_staff_permission(text)') is null then
    raise exception 'Run db/2026-08-25-staff-authorization.sql (#45) first — this file gates on its permissions.';
  end if;
  if to_regclass('public.courses') is null then
    raise exception 'Run db/2026-06-16-course-platform-base.sql (#2) first.';
  end if;
  if to_regprocedure('public.app_error(text,text,int,jsonb)') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) first.';
  end if;
  if to_regprocedure('public.course_video_object_readable(text,boolean)') is null then
    raise exception 'Run db/2026-08-24-course-video-upload-only.sql (#44) first — this file extends its publish guard.';
  end if;
  -- Refuse to run against a database whose Trainer keys were never seeded: the
  -- policies below would then reference a capability nobody can ever hold.
  if not exists (select 1 from public.staff_permissions where key = 'courses.manage_assigned') then
    raise exception '#45 did not seed courses.manage_assigned — re-run it before this file.';
  end if;
end
$pre$;


-- == 1) Course ownership =====================================================
-- ★ ONE ROW PER (course, staff member) while active, mutated in place; history
--   lives in the revoked_at column and in staff_role_events-style provenance.
--   assignment_role is 'owner' or 'editor'. Today they confer the SAME rights —
--   the distinction exists so "who is responsible for this course?" has an answer
--   in the UI without inventing a second table later. Do NOT start reading
--   assignment_role for authorization without changing user_can_manage_course()
--   and saying so here.

alter table public.courses
  add column if not exists created_by uuid references auth.users(id) on delete set null;

comment on column public.courses.created_by is
  '#46: who created this course. Provenance only — authorization is '
  'course_staff_assignments, because a creator can be reassigned and an owner can '
  'be someone who did not create it.';

create table if not exists public.course_staff_assignments (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  staff_user_id   uuid not null references auth.users(id) on delete cascade,
  assignment_role text not null default 'editor'
                  check (assignment_role in ('owner', 'editor')),
  assigned_by     uuid references auth.users(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz not null default now()
);

comment on table public.course_staff_assignments is
  '#46: which staff member may edit which course. A row with revoked_at IS NULL is '
  'live; revoking sets the timestamp rather than deleting, so "who could edit this '
  'course in March?" stays answerable. No client write policy — every write goes '
  'through admin_assign_course_staff() / admin_revoke_course_staff().';

-- One LIVE assignment per person per course. Partial, so a revoked row never
-- blocks a re-assignment.
create unique index if not exists course_staff_assignments_live_idx
  on public.course_staff_assignments (course_id, staff_user_id)
  where revoked_at is null;

-- THE hot path: user_can_manage_course() asks "does this person hold a live
-- assignment on this course?" on every policy evaluation.
create index if not exists course_staff_assignments_user_idx
  on public.course_staff_assignments (staff_user_id)
  where revoked_at is null;

create index if not exists course_staff_assignments_course_idx
  on public.course_staff_assignments (course_id);

create index if not exists courses_created_by_idx
  on public.courses (created_by) where created_by is not null;


-- == 2) Authorization helpers ================================================
-- ★ Same two-form split as #45: the parameterised user_*(uuid, …) form answers
--   about ANY user and is revoked from every client role; the caller-pinned form
--   is granted to authenticated because an RLS qual is evaluated AS THE QUERYING
--   ROLE — without the grant, every gated write fails with "permission denied for
--   function" instead of a clean authorization denial.

create or replace function public.user_can_manage_course(p_user uuid, p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    -- A NULL course id is what course_object_course_id() returns for a path it
    -- does not recognise. Answering "false" here is what makes a malformed
    -- storage path deny the write rather than allow it.
    when p_user is null or p_course_id is null then false
    when public.user_has_staff_permission(p_user, 'courses.manage_all') then true
    when not public.user_has_staff_permission(p_user, 'courses.manage_assigned') then false
    else exists (
      select 1 from public.course_staff_assignments a
       where a.course_id = p_course_id
         and a.staff_user_id = p_user
         and a.revoked_at is null
    )
  end
$fn$;

comment on function public.user_can_manage_course(uuid, uuid) is
  '#46: INTERNAL. courses.manage_all bypasses assignment; courses.manage_assigned '
  'requires a live row in course_staff_assignments. A null course id is false, which '
  'is what makes the storage-path form fail closed.';

revoke all on function public.user_can_manage_course(uuid, uuid) from public, anon, authenticated;

create or replace function public.can_manage_course(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.user_can_manage_course((select auth.uid()), p_course_id)
$fn$;

comment on function public.can_manage_course(uuid) is
  '#46: may the CALLER edit this course? The one predicate every course write policy '
  'reads, and the same question api/_lib/staffAuth.js:callerCanManageCourse() asks over '
  'PostgREST — so the API and the database cannot drift. Takes a per-row argument, so it '
  'is deliberately NOT wrapped in (select …): a subselect would make it a correlated '
  'SubPlan and defeat the short-circuit in front of it (the #44 note on '
  'course_video_object_readable, for the same reason).';

revoke all on function public.can_manage_course(uuid) from public, anon;
grant execute on function public.can_manage_course(uuid) to authenticated;

-- The strict path parser. See the header: this authorizes WRITES only.
create or replace function public.course_object_course_id(p_name text)
returns uuid
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $fn$
  select case
    when p_name ~ '^(lessons|covers)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.+'
      then nullif(split_part(p_name, '/', 2), '')::uuid
    else null
  end
$fn$;

comment on function public.course_object_course_id(text) is
  '#46: the course a course-media/course-videos object belongs to, from its path. '
  'Returns NULL for anything that is not exactly lessons/<uuid>/<file> or '
  'covers/<uuid>/<file>, and every caller treats NULL as "deny". This is the WRITE '
  'side only — reads stay reference-based via course_video_object_readable(), because '
  'path-parsing a read is exactly what #44 removed for failing open.';

revoke all on function public.course_object_course_id(text) from public, anon;
grant execute on function public.course_object_course_id(text) to authenticated;


-- == 3) my_staff_context() fills assigned_course_ids =========================
-- #45 shipped this with '[]'::jsonb and a comment naming this file. The client
-- uses it for canManageCourseClient() — deciding what to RENDER. The policies
-- below re-decide every actual write.
create or replace function public.my_staff_context()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select jsonb_build_object(
       'is_staff',        true,
       'role_key',        m.role_key,
       'role_label',      r.label,
       'status',          m.status,
       'display_title',   m.display_title,
       'is_super_admin',  (m.role_key = 'super_admin'),
       'permissions',     coalesce(
                            (select jsonb_agg(rp.permission_key order by rp.permission_key)
                               from public.staff_role_permissions rp
                              where rp.role_key = m.role_key),
                            '[]'::jsonb),
       -- #46: the courses this person holds a LIVE assignment on. Only meaningful
       -- for a manage_assigned holder; a manage_all holder edits everything and
       -- the client's canManageCourseClient() short-circuits on that permission
       -- before it ever looks at this list.
       'assigned_course_ids', coalesce(
                                (select jsonb_agg(distinct a.course_id)
                                   from public.course_staff_assignments a
                                  where a.staff_user_id = m.user_id
                                    and a.revoked_at is null),
                                '[]'::jsonb)
     )
     from public.staff_memberships m
     join public.staff_roles r on r.key = m.role_key
    where m.user_id = (select auth.uid())),
    jsonb_build_object('is_staff', false)
  )
$fn$;

comment on function public.my_staff_context() is
  '#45/#46: the ONE call the client and the api/ handlers make to learn who they are. '
  'Membership + effective permissions + assigned course ids, read LIVE from the database '
  'on every request — never decoded from a JWT claim, which is why suspending a staff '
  'member takes effect immediately instead of at their next token refresh. '
  'normalizeStaffContext() in src/lib/staffRoles.js refuses authority for anything but '
  'status = ''active''; the SQL predicates do the same independently.';

revoke all on function public.my_staff_context() from public, anon;
grant execute on function public.my_staff_context() to authenticated;


-- == 4) Course write policies ================================================
-- ★ courses_admin_write was a single FOR ALL policy, so splitting it into three
--   verbs REQUIRES drop-then-create. Unlike a READ policy, the window between
--   those two statements fails CLOSED: RLS is enabled and a table with no
--   matching policy refuses the write. Nobody gains anything mid-flight.
--
-- ★ Creating a course is courses.create; editing one is can_manage_course();
--   deleting one is courses.delete AND can_manage_course(). Publishing is neither
--   — it is a trigger, in section 7, because `published` is a column on a row you
--   are otherwise allowed to update.

alter table public.course_staff_assignments enable row level security;

drop policy if exists course_staff_assignments_read on public.course_staff_assignments;
create policy course_staff_assignments_read on public.course_staff_assignments
  for select to authenticated
  using (
    staff_user_id = (select auth.uid())
    or (select public.has_staff_permission('courses.manage_all'))
    or (select public.has_staff_permission('staff.manage'))
  );

revoke insert, update, delete, truncate on public.course_staff_assignments from authenticated, anon, public;
grant select on public.course_staff_assignments to authenticated;

drop policy if exists courses_admin_write on public.courses;

drop policy if exists courses_staff_insert on public.courses;
create policy courses_staff_insert on public.courses
  for insert to authenticated
  with check ((select public.has_staff_permission('courses.create')));

drop policy if exists courses_staff_update on public.courses;
create policy courses_staff_update on public.courses
  for update to authenticated
  using (public.can_manage_course(id))
  with check (public.can_manage_course(id));

drop policy if exists courses_staff_delete on public.courses;
create policy courses_staff_delete on public.courses
  for delete to authenticated
  using ((select public.has_staff_permission('courses.delete')) and public.can_manage_course(id));

drop policy if exists modules_admin_write on public.course_modules;
drop policy if exists modules_staff_write on public.course_modules;
create policy modules_staff_write on public.course_modules
  for all to authenticated
  using (public.can_manage_course(course_id))
  with check (public.can_manage_course(course_id));

drop policy if exists lessons_admin_write on public.course_lessons;
drop policy if exists lessons_staff_write on public.course_lessons;
create policy lessons_staff_write on public.course_lessons
  for all to authenticated
  using (public.can_manage_course(course_id))
  with check (public.can_manage_course(course_id));


-- == 5) Course read policies: a Trainer can preview their own draft ==========
-- ★ ALTER, never DROP+CREATE. These are READ policies, and one statement per HTTP
--   round trip makes a drop/create pair a real window in which the course
--   catalogue is invisible to every student (#39's rule, restated by #44).
--
--   The new branch is a pure ADDITION to the existing predicate: nothing a
--   student could read before becomes unreadable.

alter policy courses_read on public.courses
  using (
    (select public.is_admin())
    or public.can_manage_course(id)
    or (published = true
        and (select public.is_approved())
        and (select public.is_enrolled())
        and ((not (select public.plan_is_sampler()))
             or (slug like 'qbo-%' and access_tier = 'essentials')))
  );

alter policy modules_read on public.course_modules
  using (
    (select public.is_admin())
    or public.can_manage_course(course_modules.course_id)
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (
          select 1 from public.courses c
           where c.id = course_modules.course_id
             and c.published = true
             and ((not (select public.plan_is_sampler()))
                  or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))))
  );

alter policy lessons_read on public.course_lessons
  using (
    (select public.is_admin())
    or public.can_manage_course(course_lessons.course_id)
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (
          select 1 from public.courses c
           where c.id = course_lessons.course_id
             and c.published = true
             and ((not (select public.plan_is_sampler()))
                  or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))))
  );


-- == 6) Storage ==============================================================
-- Writes are path-authorized (see the header). Reads keep #44's reference-based
-- predicate untouched, plus a manage branch so a Trainer can play back the video
-- they just uploaded into a course that is still a draft — the reference form
-- requires c.published, which a draft is not.

alter policy course_videos_admin_write on storage.objects
  with check (bucket_id = 'course-videos'
              and public.can_manage_course(public.course_object_course_id(name)));

alter policy course_videos_admin_update on storage.objects
  using (bucket_id = 'course-videos'
         and public.can_manage_course(public.course_object_course_id(name)));

alter policy course_videos_admin_delete on storage.objects
  using (bucket_id = 'course-videos'
         and public.can_manage_course(public.course_object_course_id(name)));

alter policy course_videos_read on storage.objects
  using (
    bucket_id = 'course-videos'
    and ((select public.is_admin())
         or public.can_manage_course(public.course_object_course_id(name))
         or ((select public.is_approved())
             and (select public.is_enrolled())
             and public.course_video_object_readable(name, (select public.plan_is_sampler()))))
  );

alter policy course_media_admin_write on storage.objects
  with check (bucket_id = 'course-media'
              and public.can_manage_course(public.course_object_course_id(name)));

alter policy course_media_admin_update on storage.objects
  using (bucket_id = 'course-media'
         and public.can_manage_course(public.course_object_course_id(name)));

alter policy course_media_admin_delete on storage.objects
  using (bucket_id = 'course-media'
         and public.can_manage_course(public.course_object_course_id(name)));

-- course-media is a PUBLIC bucket, so this policy governs the authenticated
-- object listing only — the CDN serves the bytes to anyone with the URL either
-- way. Widened so a Trainer's own cover upload is listable to them.
alter policy course_media_read on storage.objects
  using (bucket_id = 'course-media'
         and ((select public.is_admin())
              or public.can_manage_course(public.course_object_course_id(name))));


-- == 7) Publishing is its own capability =====================================
-- ★ Publishing exposes content to every paying student, so it is deliberately NOT
--   part of courses.manage_assigned. A Trainer authors; someone with
--   courses.publish ships. #44 already had a guard here for the "unplayable video"
--   case — this extends the SAME trigger rather than adding a second one, so there
--   is one place to read.
--
-- ★ The WHEN clause stays DELTA-scoped. #44's note is still load-bearing:
--   reorderCourse fires N updates on published rows in one Promise.all, and cover
--   upload, tier toggle, AI-trainer toggle and metadata save all write to courses
--   without touching `published`. Scoping on state instead of on the transition
--   would refuse every one of them. Widened from "turning on" to "changing", so
--   UNpublishing needs the capability too — withdrawing a live course from every
--   student is not a lesser act than publishing it.

create or replace function public.courses_publish_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n int;
begin
  if not public.has_staff_permission('courses.publish') then
    perform public.app_error('COURSE_PUBLISH_FORBIDDEN',
      case when new.published
        then 'Publishing a course needs the "Publish and unpublish courses" permission. Ask a Super Admin to publish it.'
        else 'Withdrawing a published course needs the "Publish and unpublish courses" permission.'
      end, 403, jsonb_build_object('course_id', new.id));
  end if;

  -- Only the false → true direction can be blocked by unplayable video: pulling a
  -- broken course DOWN must always remain possible.
  if new.published then
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
  end if;

  return new;
end;
$fn$;

revoke all on function public.courses_publish_guard() from public, anon, authenticated;

drop trigger if exists courses_publish_guard on public.courses;
create trigger courses_publish_guard
  before update on public.courses
  for each row
  when (new.published is distinct from old.published)
  execute function public.courses_publish_guard();

-- INSERT needs its own trigger: a WHEN clause on an INSERT trigger cannot
-- reference OLD, so the transition test above is not expressible there.
drop trigger if exists courses_publish_insert_guard on public.courses;
create trigger courses_publish_insert_guard
  before insert on public.courses
  for each row
  when (new.published)
  execute function public.courses_publish_guard();

-- The UI preflight. Widened from is_admin() so the person who will hit the guard
-- is the person who can see what is blocking them.
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
   where public.can_manage_course(p_course_id)
     and l.course_id = p_course_id
     and l.type = 'video'
     and ( (coalesce(l.video_provider,'') <> 'upload' and nullif(btrim(coalesce(l.video_url,'')),'') is not null)
        or (l.video_provider = 'upload' and l.storage_path is null) )
   order by l.position, l.id
$fn$;

revoke all on function public.course_publish_blockers(uuid) from public, anon;
grant execute on function public.course_publish_blockers(uuid) to authenticated;


-- == 8) A creator owns what they create ======================================
-- Without this a Trainer could create a course (courses.create) and then be
-- unable to edit it (no assignment) — a dead end that looks exactly like a bug.
create or replace function public.courses_stamp_creator()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- ★ auth.uid() OVERRIDES whatever the client sent, rather than only filling a
  --   NULL. created_by decides who gets the owner assignment in the AFTER trigger
  --   below, so a client that could choose it could hand ownership of a course it
  --   just created to somebody else — or, more usefully to an attacker, keep
  --   creating courses owned by a Trainer who then finds work they never did.
  --   When auth.uid() IS null there is no caller to attribute it to (a migration,
  --   a seed, the service role), so whatever was supplied stands.
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$fn$;

revoke all on function public.courses_stamp_creator() from public, anon, authenticated;

drop trigger if exists courses_stamp_creator on public.courses;
create trigger courses_stamp_creator
  before insert on public.courses
  for each row execute function public.courses_stamp_creator();

create or replace function public.courses_assign_creator()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- auth.uid() is null for a migration, a seed or the service role: there is no
  -- person to assign, and inventing one would put a NULL in a not-null column.
  if new.created_by is not null then
    insert into public.course_staff_assignments (course_id, staff_user_id, assignment_role, assigned_by)
    values (new.id, new.created_by, 'owner', new.created_by)
    on conflict do nothing;
  end if;
  return new;
end;
$fn$;

revoke all on function public.courses_assign_creator() from public, anon, authenticated;

drop trigger if exists courses_assign_creator on public.courses;
create trigger courses_assign_creator
  after insert on public.courses
  for each row execute function public.courses_assign_creator();


-- == 9) Assignment RPCs ======================================================
-- The tables carry no client write policy, so these are the only writers.

create or replace function public.admin_assign_course_staff(
  p_course_id uuid,
  p_user_id   uuid,
  p_role      text default 'editor'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  -- Handing out authority over a course is a manage_all act, not a
  -- manage_assigned one: otherwise a Trainer could assign their own colleagues.
  if not public.has_staff_permission('courses.manage_all') then
    perform public.app_error('FORBIDDEN',
      'admin_assign_course_staff: courses.manage_all required', 403, null);
  end if;
  if p_role not in ('owner', 'editor') then
    perform public.app_error('COURSE_ASSIGNMENT_INVALID',
      format('unknown assignment role %s', p_role), 422, null);
  end if;
  if not exists (select 1 from public.courses where id = p_course_id) then
    perform public.app_error('COURSE_ACCESS_DENIED', 'no such course', 404,
      jsonb_build_object('course_id', p_course_id));
  end if;
  -- Assigning a course to somebody who cannot edit courses at all would create a
  -- row that grants nothing and reads as though it does.
  if not public.user_has_staff_permission(p_user_id, 'courses.manage_assigned')
     and not public.user_has_staff_permission(p_user_id, 'courses.manage_all') then
    perform public.app_error('COURSE_ASSIGNMENT_INVALID',
      'that account holds no course-editing permission, so an assignment would grant nothing', 422,
      jsonb_build_object('user_id', p_user_id));
  end if;

  insert into public.course_staff_assignments
    (course_id, staff_user_id, assignment_role, assigned_by)
  values (p_course_id, p_user_id, p_role, auth.uid())
  on conflict (course_id, staff_user_id) where revoked_at is null
  do update set assignment_role = excluded.assignment_role
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id,
                            'course_id', p_course_id, 'user_id', p_user_id, 'role', p_role);
end;
$fn$;

revoke all on function public.admin_assign_course_staff(uuid, uuid, text) from public, anon;
grant execute on function public.admin_assign_course_staff(uuid, uuid, text) to authenticated;

create or replace function public.admin_revoke_course_staff(
  p_course_id uuid,
  p_user_id   uuid,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.has_staff_permission('courses.manage_all') then
    perform public.app_error('FORBIDDEN',
      'admin_revoke_course_staff: courses.manage_all required', 403, null);
  end if;

  update public.course_staff_assignments
     set revoked_at = now(), revoke_reason = p_reason
   where course_id = p_course_id
     and staff_user_id = p_user_id
     and revoked_at is null;

  return jsonb_build_object('ok', true, 'course_id', p_course_id, 'user_id', p_user_id);
end;
$fn$;

revoke all on function public.admin_revoke_course_staff(uuid, uuid, text) from public, anon;
grant execute on function public.admin_revoke_course_staff(uuid, uuid, text) to authenticated;

-- Who is assigned to this course? Readable by anyone who may manage it, so the
-- course builder can show it, plus staff.manage for the Team & Roles screen.
create or replace function public.course_staff_for(p_course_id uuid)
returns table (
  user_id uuid, email text, full_name text, avatar_url text,
  assignment_role text, assigned_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select a.staff_user_id, p.email, p.full_name, p.avatar_url, a.assignment_role, a.assigned_at
    from public.course_staff_assignments a
    left join public.profiles p on p.id = a.staff_user_id
   where a.revoked_at is null
     and a.course_id = p_course_id
     and (public.can_manage_course(p_course_id)
          or public.has_staff_permission('staff.manage'))
   order by a.assignment_role, p.full_name nulls last, p.email
$fn$;

revoke all on function public.course_staff_for(uuid) from public, anon;
grant execute on function public.course_staff_for(uuid) to authenticated;


-- == 10) AI course trainer ===================================================
-- course_trainer.manage plus the assignment: indexing a course is editing it.
alter policy course_ai_sources_admin_all on public.course_ai_sources
  using ((select public.has_staff_permission('course_trainer.manage'))
         and public.can_manage_course(course_id))
  with check ((select public.has_staff_permission('course_trainer.manage'))
              and public.can_manage_course(course_id));

alter policy course_ai_chunks_admin_read on public.course_ai_chunks
  using ((select public.has_staff_permission('course_trainer.manage')));

alter policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs
  using ((select public.has_staff_permission('course_trainer.manage')))
  with check ((select public.has_staff_permission('course_trainer.manage')));

-- Usage is billing-shaped data about STUDENTS, not course content, so it stays
-- with the roles that own students rather than the role that authors courses.
alter policy ai_training_usage_admin_read on public.ai_training_usage
  using ((select public.is_admin())
         or (select public.has_staff_permission('enrollments.review')));


-- == 11) Error codes, re-listed in full ======================================
-- app_error_catalog() is replaced wholesale every time, so every existing code
-- must be repeated. Keep in lockstep with APP_ERROR_CODES and APP_ERROR_COPY in
-- src/lib/appErrors.js. Copied from #45 plus the three #46 codes.
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
    ('COURSE_PUBLISH_BLOCKED',       409, 'The course still has video lessons with no uploaded file.'),
    ('STAFF_LAST_SUPER_ADMIN',       409, 'That change would leave no active Super Admin. Promote a replacement first.'),
    ('STAFF_NOT_FOUND',              404, 'That account is not staff, or has no profile.'),
    ('STAFF_ROLE_INVALID',           422, 'Unknown staff role or status, or a required reason was missing.'),
    ('COURSE_NOT_ASSIGNED',          403, 'You can edit courses, but not this one — nobody has assigned it to you.'),
    ('COURSE_PUBLISH_FORBIDDEN',     403, 'Publishing or withdrawing a course needs its own permission.'),
    ('COURSE_ASSIGNMENT_INVALID',    422, 'Unknown assignment role, or the target account cannot edit courses at all.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-26-course-staff-assignments.sql', null,
  'trainer course ownership (#46): course_staff_assignments + courses.created_by, '
  'user_can_manage_course()/can_manage_course() and the strict WRITE-side path parser '
  'course_object_course_id(); replaces my_staff_context() to fill assigned_course_ids (the '
  'placeholder #45 shipped). Splits courses_admin_write into insert/update/delete gated on '
  'courses.create / can_manage_course / courses.delete, moves modules+lessons writes onto '
  'can_manage_course, and adds an assigned-draft branch to the three read policies so a '
  'Trainer can preview their own unpublished course. Storage writes on course-videos and '
  'course-media are authorized by the course id parsed from the object path — which fails '
  'CLOSED on anything malformed, the inverse of the read-side parser #44 removed for failing '
  'open; reads stay reference-based. Publishing becomes its own capability: courses_publish_guard '
  'now checks courses.publish and fires on BOTH directions of the published transition (still '
  'delta-scoped by a WHEN clause, plus a separate INSERT trigger because a WHEN clause on INSERT '
  'cannot reference OLD). A creator is auto-assigned as owner, or courses.create would be a dead '
  'end. Adds admin_assign_course_staff/admin_revoke_course_staff/course_staff_for and three '
  'app_error codes; course_ai_* moves to course_trainer.manage + assignment.')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--   -- 1) The Trainer keys are finally load-bearing (expect > 0):
--   select count(*) from pg_policies
--    where schemaname in ('public','storage') and qual ilike '%can_manage_course%';
--
--   -- 2) The FOR ALL course policy is gone, replaced by three verbs:
--   select policyname, cmd from pg_policies
--    where schemaname='public' and tablename='courses' order by policyname;
--     -- expect courses_read, courses_staff_delete, courses_staff_insert, courses_staff_update
--
--   -- 3) The publish guard fires on BOTH directions now:
--   select pg_get_triggerdef(oid) from pg_trigger
--    where tgrelid='public.courses'::regclass and tgname='courses_publish_guard';
--     -- expect: WHEN ((new.published IS DISTINCT FROM old.published))
--
--   -- 4) The write-side path parser refuses anything malformed:
--   select public.course_object_course_id('lessons/not-a-uuid/x.mp4') is null as denies_bad_path,
--          public.course_object_course_id('lessons/00000000-0000-0000-0000-000000000000/x.mp4')
--            is not null as accepts_good_path;
--
--   -- 5) assigned_course_ids is no longer a placeholder (run as a Trainer):
--   select public.my_staff_context() -> 'assigned_course_ids';
--
--   -- 6) Nobody was orphaned: every course a Super Admin could edit, they still can.
--   select count(*) from public.courses c
--    where not exists (select 1 from public.course_staff_assignments a
--                       where a.course_id = c.id and a.revoked_at is null);
--     -- expect: all pre-#46 courses, which is fine — courses.manage_all bypasses assignment.
-- ─────────────────────────────────────────────────────────────────────────────
