-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-30-getting-started-video.sql   (#69)
-- Getting Started: the video a newly approved student watches once before their first
-- dashboard. Versioned, managed by a Super Admin, served only from private storage.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DOES
--   1. A new permission, onboarding.manage, held by super_admin ALONE (23 permissions /
--      35 grants). Publishing or replacing the video changes the first screen every newly
--      approved student sees, and its file is served to every paying member.
--   2. Three tables. onboarding_videos holds every VERSION (draft → published → retired, or
--      deleted), at most one published at a time. student_onboarding_progress holds one row
--      per student per version: when they first opened it, when they finished it, and the
--      last playback problem they hit. onboarding_video_events is the append-only trail of
--      every Super Admin change. None of the three has a client write path.
--   3. A PRIVATE bucket, onboarding-videos, with the lesson-video limits (2 GiB, video/mp4 and
--      video/quicktime): reads authorized by reference, writes by path.
--   4. Four student RPCs (my_/start_/complete_/report_onboarding_video*) and seven Super
--      Admin RPCs (admin_onboarding_video_*), each pinned to auth.uid().
--   5. enrollment_decision_email_facts(): what the decision email may state — the plan, the
--      term, the cohort, and whether Getting Started comes next — read by the reviewer's own
--      session instead of taken from the request body.
--   6. Eight ONBOARDING_VIDEO_* error codes (141 in the catalog).
--
-- ★ WHO IS ASKED TO WATCH. user_onboarding_video_state() is the ONE place that decides, and
--   `required` is always a boolean (coalesced to false, never null). A student is asked when a
--   video is live, its file is really in storage, they are approved and enrolled, they are not
--   staff (an invited or active membership, or is_admin: staff are never learners, #52), they
--   have finished NO version, and their FIRST subscription row was created on or after the
--   FIRST publish of any version. Three edges follow, on purpose:
--     (a) a migrated student activated before the first publish is an existing member and is
--         not asked;
--     (b) a grandfathered member (paid before dated terms, so no subscription row) is not
--         asked, until an upgrade creates their first row after the first publish; then once;
--     (c) the cutoff is the first publish of ANY version, even one later retired or deleted,
--         so a Super Admin checks a draft with Preview, never with a trial publish.
--
-- ★ THE GATE GRANTS NOTHING. It is presentation, and membership RLS still protects every paid
--   read, so the client fails OPEN (an error, a timeout or a pre-#69 database renders the
--   app). Every function here fails CLOSED.
--
-- ★ READS ARE AUTHORIZED BY REFERENCE; WRITES BY PATH — #65's inversion, on purpose. A student
--   may read exactly one object: the one the published row cites, and only while approved and
--   enrolled. A write names an object that does not exist yet, so it is authorized by the path
--   it names: versions/<draft id>/<upload id>.mp4, into the folder of a draft that exists. The
--   parser returns NULL for anything else, and NULL authorizes nothing. The live object can be
--   neither overwritten nor deleted.
--
-- ★ A COMPLETION IS EARNED ONCE AND NEVER RE-STAMPED. complete_onboarding_video() refuses until
--   greatest(coalesce(duration, 60) × 0.4, 5) seconds after the student first opened the video
--   (a 2× viewer passes; an unknown duration still waits), then writes
--   coalesce(completed_at, now()). The client's "90% actually played" rule is presentation;
--   this is what refuses a forged completion.
--
-- ★ HISTORY IS PERMANENT. A version is never removed: 'deleted' is a status, the BEFORE DELETE
--   guard refuses a row delete, and the events trail is append-only (with the FK SET NULL
--   exemption every audit table here needs).
--
-- ★ FUNCTION ACLs COME IN THREE CLASSES, listed separately in section 10: the client RPCs and
--   the three storage-policy helpers are granted to authenticated (a policy qual runs AS THE
--   CALLER, so without the grant every storage.objects statement fails with "permission denied
--   for function", in every bucket); the path parser, the state function and the two guards
--   are revoked from every client role.
--
-- ★ EVERY RESTATED BODY IS COPIED, NOT RETYPED. The staff seed was lifted from #67 §1 and
--   app_error_catalog() from #68 by a script, which compared each source with production first:
--   the seed's 3 roles, 22 permissions and 34 grants by fingerprint, and the catalog body by the
--   md5 of its prosrc (bf3a27bd31fd9e2163cc1324c083fde0). test/gettingStartedSql.test.mjs
--   line-diffs both against their sources.
--
-- LOCKSTEP: this file ↔ bootstrap §56 ↔ src/lib/gettingStarted.js (the path shape, the bucket,
-- the elapsed constants, the problem codes) ↔ src/lib/staffRoles.js ↔ src/lib/appErrors.js
-- (8 codes) ↔ test/gettingStartedSql.test.mjs + test-db/onboardingVideo.dbtest.mjs ↔ the #69
-- block in scripts/audit-db.mjs.
--
-- Needs #68. Transaction-free (scripts/apply-db-files.mjs sends one statement per call).
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-28-legacy-migration-round2.sql') then
    raise exception '#69: run db/2026-09-28-legacy-migration-round2.sql (#68) first.';
  end if;
  -- 141 = a re-run of this file.
  if (select count(*) from public.app_error_catalog()) not in (133, 141) then
    raise exception '#69: expected the #68 error catalog (133 codes), or 141 on a re-run.';
  end if;
  -- 23 = a re-run of this file.
  if (select count(*) from public.staff_permissions) not in (22, 23) then
    raise exception '#69: expected the 22 staff permissions of #67, or 23 on a re-run.';
  end if;
  if to_regprocedure('public.has_staff_permission(text)') is null
     or to_regprocedure('public.user_is_approved(uuid)') is null
     or to_regprocedure('public.user_is_enrolled(uuid)') is null
     or to_regprocedure('public.app_error(text,text,integer,jsonb)') is null then
    raise exception '#69: has_staff_permission (#45), user_is_approved and user_is_enrolled (#27) and app_error (#35) are required.';
  end if;
  if to_regclass('public.staff_memberships') is null or to_regclass('public.subscriptions') is null then
    raise exception '#69: staff_memberships (#45) and subscriptions are required.';
  end if;
end
$pre$;


-- == 1) Staff capability ======================================================
-- ★ LIFTED FROM #67 §1 BY A SCRIPT, NOT RETYPED: all three statements, each with its
--   on-conflict clause. test/staffRolesSql.test.mjs diffs the LAST VALUES block against the JS
--   matrix; test/gettingStartedSql.test.mjs line-diffs this section against #67's and allows
--   exactly the two new tuples and the two commas they need.
-- ★ onboarding.manage is appended LAST to both VALUES lists, and granted to super_admin ONLY:
--   publishing or replacing this video changes the first screen every newly approved student
--   sees, and the live file is served to every paying member. 23 permissions / 35 grants.

insert into public.staff_roles (key, label, rank, is_protected, description) values
  ('super_admin',      'Super Admin',      100, true,  'Complete product authority, including staff management and the audit trail.'),
  ('operations_admin', 'Operations Admin',  50, false, 'Reviews access requests and payment proofs, grants courses, runs batches, and configures and moderates the community.'),
  ('trainer',          'Trainer',           20, false, 'Creates courses and edits the ones assigned to them, and configures and moderates the community. No access to payments or students.')
on conflict (key) do update
  set label = excluded.label,
      rank = excluded.rank,
      is_protected = excluded.is_protected,
      description = excluded.description;

insert into public.staff_permissions (key, category, label, description) values
  ('staff.manage',             'Staff',     'Invite and manage staff',         'Invite staff, assign and change roles, suspend and revoke access.'),
  ('staff.audit.read',         'Staff',     'View the staff audit trail',      'Read the full history of role assignments, suspensions and revocations.'),
  ('access_requests.review',   'Students',  'Review account access requests',  'Approve or reject new account signups.'),
  ('enrollments.review',       'Students',  'Review payment proofs',           'Approve or reject enrollment, renewal, upgrade and extension requests.'),
  ('students.assign_courses',  'Students',  'Choose granted courses',          'Select which plan-eligible course programs an approval grants.'),
  ('students.extend_access',   'Students',  'Grant special extensions',        'Extend a membership expiry outside the paid request flow. Always audited.'),
  ('students.legacy_migrate',  'Students',  'Migrate legacy students',         'Stage legacy rosters, activate already-paid memberships and send their invitations. Creates paid access with no payment in this system, so it is Super Admin only.'),
  ('batches.manage',           'Students',  'Manage cohort batches',           'Create, edit, close and archive batches, and assign members to them.'),
  ('student_progress.read',    'Students',  'View student progress reports',   'Read private operational progress reports, cohort averages, inactivity signals and CSV exports.'),
  ('courses.create',           'Courses',   'Create courses',                  'Create a new draft course and duplicate an existing one.'),
  ('courses.manage_assigned',  'Courses',   'Edit assigned courses',           'Edit the modules, lessons and videos of courses assigned to you.'),
  ('courses.manage_all',       'Courses',   'Edit every course',               'Edit any course, whether or not it is assigned to you.'),
  ('courses.publish',          'Courses',   'Publish and unpublish courses',   'Make a course visible to students, or withdraw it.'),
  ('courses.delete',           'Courses',   'Delete courses',                  'Permanently delete a course and its unreferenced media.'),
  ('course_trainer.manage',    'Courses',   'Manage AI trainer indexing',      'Enable, sync, transcribe and preview the AI course trainer.'),
  ('community.manage',         'Community', 'Configure the community',         'Create and edit channels, categories and audience rules.'),
  ('community.moderate',       'Community', 'Moderate the community',          'Pin, lock, hide and hard-delete posts and replies.'),
  ('sidebar.customize',        'Settings',  'Customize navigation labels',     'Rename stages, groups and tabs for every user in the app.'),
  ('payment_settings.manage',  'Settings',  'Edit payment settings',           'Change the manual-payment instructions and the notification address.'),
  ('finance.manage',           'Finance',   'Manage business finances',        'Open the Financial Management dashboard: the ledger, receivables, bank imports, reconciliation, the cash-basis P&L and the finance audit trail.'),
  ('communications.send',      'Communications', 'Send student communications', 'Send announcements, student emails and payment reminders, run email automations, and read the delivery tracker.'),
  ('meetings.manage',          'Meetings',  'Manage meetings and staff tasks', 'Schedule and cancel Zoom meetings, keep meeting templates, invite students, and use the shared staff to-do board.'),
  ('onboarding.manage',        'Onboarding', 'Manage the Getting Started video', 'Upload, preview, publish, replace and remove the video newly approved students watch before their dashboard.')
on conflict (key) do update
  set category = excluded.category,
      label = excluded.label,
      description = excluded.description;

insert into public.staff_role_permissions (role_key, permission_key) values
  ('super_admin', 'staff.manage'),
  ('super_admin', 'staff.audit.read'),
  ('super_admin', 'access_requests.review'),
  ('super_admin', 'enrollments.review'),
  ('super_admin', 'students.assign_courses'),
  ('super_admin', 'students.extend_access'),
  ('super_admin', 'students.legacy_migrate'),
  ('super_admin', 'batches.manage'),
  ('super_admin', 'student_progress.read'),
  ('super_admin', 'courses.create'),
  ('super_admin', 'courses.manage_assigned'),
  ('super_admin', 'courses.manage_all'),
  ('super_admin', 'courses.publish'),
  ('super_admin', 'courses.delete'),
  ('super_admin', 'course_trainer.manage'),
  ('super_admin', 'community.manage'),
  ('super_admin', 'community.moderate'),
  ('super_admin', 'sidebar.customize'),
  ('super_admin', 'payment_settings.manage'),
  ('super_admin', 'finance.manage'),
  ('super_admin', 'communications.send'),
  ('super_admin', 'meetings.manage'),
  ('operations_admin', 'access_requests.review'),
  ('operations_admin', 'enrollments.review'),
  ('operations_admin', 'students.assign_courses'),
  ('operations_admin', 'batches.manage'),
  ('operations_admin', 'student_progress.read'),
  ('operations_admin', 'community.manage'),
  ('operations_admin', 'community.moderate'),
  ('trainer', 'courses.create'),
  ('trainer', 'courses.manage_assigned'),
  ('trainer', 'course_trainer.manage'),
  ('trainer', 'community.manage'),
  ('trainer', 'community.moderate'),
  ('super_admin', 'onboarding.manage')
on conflict do nothing;


-- == 2) Tables ================================================================

-- Every version of the Getting Started video. At most one is published.
create table if not exists public.onboarding_videos (
  id                uuid primary key default gen_random_uuid(),
  status            text not null default 'draft'
                    check (status in ('draft', 'published', 'retired', 'deleted')),
  title             text not null check (char_length(btrim(title)) between 1 and 120),
  description       text check (description is null or char_length(description) <= 600),
  transcript        text check (transcript is null or char_length(transcript) <= 20000),
  -- ★ OPAQUE BY DESIGN: versions/<video uuid>/<upload uuid>.mp4 and nothing else. A signed URL
  --   necessarily contains the object name, so the name carries no filename (that is the
  --   admin-only original_filename). ONBOARDING_VIDEO_PATH_RE in src/lib/gettingStarted.js and
  --   onboarding_video_path_version_id() below are the same pattern: lowercase and
  --   case-sensitive (~, never ~*).
  storage_path      text unique
                    check (storage_path is null or storage_path ~ '^versions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$'),
  original_filename text check (original_filename is null or char_length(original_filename) <= 255),
  mime_type         text check (mime_type is null or mime_type in ('video/mp4', 'video/quicktime')),
  byte_size         bigint check (byte_size is null or byte_size between 1 and 2147483648),
  duration_seconds  numeric(8,2) check (duration_seconds is null or (duration_seconds > 0 and duration_seconds <= 14400)),
  media_attached_at timestamptz,
  published_at      timestamptz,          -- FIRST publish only; the gate cutoff reads min() of it
  last_published_at timestamptz,
  published_by      uuid references auth.users(id) on delete set null,
  retired_at        timestamptz,
  retired_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  deleted_by        uuid references auth.users(id) on delete set null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint onboarding_videos_live_has_media
    check (status <> 'published' or (storage_path is not null and media_attached_at is not null)),
  -- ★ A VERSION'S FILE LIVES IN ITS OWN FOLDER. attach_media checks it; this makes the opposite
  --   unrepresentable, so the folder an upload was authorized by and the row that cites the file
  --   can never disagree (#65's path-to-row binding).
  constraint onboarding_videos_path_in_own_folder
    check (storage_path is null or split_part(storage_path, '/', 2) = id::text)
);

-- ★ AT MOST ONE LIVE VERSION, by index rather than by trust. A publish retires the old live row
--   BEFORE it publishes the new one, and two racing publishes cannot both win.
create unique index if not exists onboarding_videos_one_live
  on public.onboarding_videos ((true)) where status = 'published';

comment on table public.onboarding_videos is
  '#69: every version of the Getting Started video. At most one is published (the partial '
  'unique index). No client write path: every write is an admin_onboarding_video_* function, '
  'and onboarding_videos_guard enforces the version state machine for every writer.';
comment on column public.onboarding_videos.published_at is
  'The FIRST time this version was published; set once. min() over every version is the gate '
  'cutoff: a student whose first subscription row predates it is never asked to watch.';

-- One row per student per version. Written only by start_/complete_/report_onboarding_video*.
create table if not exists public.student_onboarding_progress (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  -- ★ RESTRICT: a version that has progress is never removed (and no version ever is).
  video_id          uuid not null references public.onboarding_videos(id) on delete restrict,
  first_started_at  timestamptz not null default now(),   -- the elapsed guard counts from here
  last_started_at   timestamptz not null default now(),
  completed_at      timestamptz,                          -- the FIRST completion; never re-stamped
  last_problem_at   timestamptz,
  last_problem_code text
                    check (last_problem_code is null
                           or last_problem_code in ('sign', 'decode', 'playback', 'missing', 'other')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (user_id, video_id)
);

-- The overview's per-version counts. A student's own rows are served by the primary key.
create index if not exists student_onboarding_progress_video_idx
  on public.student_onboarding_progress (video_id, completed_at);

comment on table public.student_onboarding_progress is
  '#69: one row per student per Getting Started version. first_started_at is kept for good (the '
  'elapsed guard counts from it) and completed_at is the FIRST completion, never re-stamped. '
  'Staff are never recorded (#52). No client write path.';

-- Every change a Super Admin makes, append-only.
create table if not exists public.onboarding_video_events (
  id          bigint generated always as identity primary key,
  video_id    uuid references public.onboarding_videos(id) on delete set null,
  action      text not null
              check (action in ('create_draft', 'update_details', 'attach_media',
                                'publish', 'unpublish', 'delete')),
  actor_id    uuid references auth.users(id) on delete set null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists onboarding_video_events_video_idx
  on public.onboarding_video_events (video_id, created_at desc);

comment on table public.onboarding_video_events is
  '#69: the append-only trail of every Getting Started video change: one row per state change, '
  'none for a no-op. Written only by the admin_onboarding_video_* functions.';

-- ★ THE VERSION STATE MACHINE, ENFORCED WHERE EVERY WRITER PASSES. The RPCs below follow it;
--   this makes it true of a direct write by the table owner as well.
--     • id and created_at never change; created_by only becomes NULL.
--     • draft → published | deleted; published → retired; retired → published | deleted; and
--       text edits within any status. A deleted row stays deleted.
--     • The media columns change only while the row is, and stays, a draft. published_at is
--       set once, by the first publish (the gate cutoff reads its minimum).
--     • published_by and last_published_at move only on a transition INTO published,
--       retired_at and retired_by only on published → retired, deleted_at and deleted_by only
--       on a transition into deleted.
--     • ★ ANY actor column may ALWAYS become NULL, even on a deleted row: that is the FK's
--       ON DELETE SET NULL, and refusing it would make it impossible to delete an Auth user
--       who ever touched a video (#67's audit-table exemption).
--     • ★ A ROW DELETE IS REFUSED. Progress rows point at a version, and removing a version
--       could move the cutoff. TRUNCATE is the only reset (row triggers do not fire on it),
--       and it is for tests only.
create or replace function public.onboarding_videos_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    perform public.app_error('FORBIDDEN',
      'A Getting Started video is never removed. Delete it on the Getting Started Video screen, which keeps its history.',
      409, jsonb_build_object('video_id', old.id));
    return null;
  end if;

  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'A video''s id, creation time and creator cannot be rewritten.', 409,
      jsonb_build_object('video_id', old.id));
  end if;

  if old.status = 'deleted' then
    if new.status is distinct from 'deleted'
       or (new.title, new.description, new.transcript, new.storage_path, new.original_filename,
           new.mime_type, new.byte_size, new.duration_seconds, new.media_attached_at,
           new.published_at, new.last_published_at, new.retired_at, new.deleted_at)
          is distinct from
          (old.title, old.description, old.transcript, old.storage_path, old.original_filename,
           old.mime_type, old.byte_size, old.duration_seconds, old.media_attached_at,
           old.published_at, old.last_published_at, old.retired_at, old.deleted_at)
       or (new.published_by is distinct from old.published_by and new.published_by is not null)
       or (new.retired_by is distinct from old.retired_by and new.retired_by is not null)
       or (new.deleted_by is distinct from old.deleted_by and new.deleted_by is not null) then
      perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
        'A deleted Getting Started video stays deleted and cannot be changed.', 409,
        jsonb_build_object('video_id', old.id, 'status', old.status));
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.status is distinct from old.status
     and not ((old.status = 'draft'     and new.status in ('published', 'deleted'))
           or (old.status = 'published' and new.status = 'retired')
           or (old.status = 'retired'   and new.status in ('published', 'deleted'))) then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      format('A %s video cannot become %s.', old.status, new.status), 409,
      jsonb_build_object('video_id', old.id, 'from', old.status, 'to', new.status));
  end if;

  if (new.storage_path, new.original_filename, new.mime_type, new.byte_size,
      new.duration_seconds, new.media_attached_at)
     is distinct from
     (old.storage_path, old.original_filename, old.mime_type, old.byte_size,
      old.duration_seconds, old.media_attached_at)
     and not (old.status = 'draft' and new.status = 'draft') then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'Only a draft can take a new file. Upload the new video as a new draft.', 409,
      jsonb_build_object('video_id', old.id, 'status', old.status));
  end if;

  if new.published_at is distinct from old.published_at
     and (old.published_at is not null
          or not (new.status = 'published' and old.status <> 'published')) then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'A version''s first publish time is set once, by its first publish.', 409,
      jsonb_build_object('video_id', old.id));
  end if;

  if (new.last_published_at is distinct from old.last_published_at
      or (new.published_by is distinct from old.published_by and new.published_by is not null))
     and not (new.status = 'published' and old.status <> 'published') then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'Only a publish records who published a version, and when.', 409,
      jsonb_build_object('video_id', old.id));
  end if;

  if (new.retired_at is distinct from old.retired_at
      or (new.retired_by is distinct from old.retired_by and new.retired_by is not null))
     and not (old.status = 'published' and new.status = 'retired') then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'Only retiring the live version records who retired it, and when.', 409,
      jsonb_build_object('video_id', old.id));
  end if;

  if (new.deleted_at is distinct from old.deleted_at
      or (new.deleted_by is distinct from old.deleted_by and new.deleted_by is not null))
     and new.status is distinct from 'deleted' then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'Only deleting a version records who deleted it, and when.', 409,
      jsonb_build_object('video_id', old.id));
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists onboarding_videos_guard on public.onboarding_videos;
create trigger onboarding_videos_guard
  before update or delete on public.onboarding_videos
  for each row execute function public.onboarding_videos_guard();

-- The audit trail is append-only, with the referential SET NULL exemption every audit table
-- here needs (video_id and actor_id are ON DELETE SET NULL; refusing that UPDATE would make it
-- impossible to delete an Auth user who ever acted). #67's student_import_events_guard idiom.
create or replace function public.onboarding_video_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE'
     and (new.id, new.action, new.detail, new.created_at)
         is not distinct from (old.id, old.action, old.detail, old.created_at)
     and (new.video_id is not distinct from old.video_id or new.video_id is null)
     and (new.actor_id is not distinct from old.actor_id or new.actor_id is null) then
    return new;
  end if;
  perform public.app_error('FORBIDDEN', 'The Getting Started video history is append-only.', 409, null);
  return null;
end;
$fn$;

drop trigger if exists onboarding_video_events_guard on public.onboarding_video_events;
create trigger onboarding_video_events_guard
  before update or delete on public.onboarding_video_events
  for each row execute function public.onboarding_video_events_guard();


-- == 3) RLS: read-only, and only for whoever it belongs to ====================
-- ★ ZERO CLIENT WRITE PATHS — the finance rule. Each table keeps exactly ONE policy, a SELECT;
--   every write is a SECURITY DEFINER function below. A student reads their own progress; the
--   versions and the trail are the Super Admin's. A student learns about the live video only
--   through my_onboarding_video(), which never returns a draft or a path.
-- ★ NEVER `force row level security` here: the guards and the RPCs run as the table owner.
alter table public.onboarding_videos enable row level security;
alter table public.student_onboarding_progress enable row level security;
alter table public.onboarding_video_events enable row level security;

revoke all on table public.onboarding_videos from public, anon, authenticated;
revoke all on table public.student_onboarding_progress from public, anon, authenticated;
revoke all on table public.onboarding_video_events from public, anon, authenticated;
grant select on table public.onboarding_videos to authenticated;
grant select on table public.student_onboarding_progress to authenticated;
grant select on table public.onboarding_video_events to authenticated;

drop policy if exists onboarding_videos_manage_read on public.onboarding_videos;
create policy onboarding_videos_manage_read on public.onboarding_videos
  for select to authenticated
  using ((select public.has_staff_permission('onboarding.manage')));

drop policy if exists student_onboarding_progress_read on public.student_onboarding_progress;
create policy student_onboarding_progress_read on public.student_onboarding_progress
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select public.has_staff_permission('onboarding.manage')));

drop policy if exists onboarding_video_events_manage_read on public.onboarding_video_events;
create policy onboarding_video_events_manage_read on public.onboarding_video_events
  for select to authenticated
  using ((select public.has_staff_permission('onboarding.manage')));


-- == 4) Helpers ===============================================================

-- The video id inside an object name, or NULL. Used ONLY to authorize WRITES: a NULL matches
-- no draft, so a malformed path denies. Reads never parse a path (see the read helper).
create or replace function public.onboarding_video_path_version_id(p_name text)
returns uuid
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $fn$
  select case
    when p_name ~ '^versions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$'
      then split_part(p_name, '/', 2)::uuid
    else null
  end;
$fn$;

-- ★ THE ONE OBJECT A STUDENT MAY READ: the file the PUBLISHED row cites, while the caller is
--   approved and enrolled (the 3-day grace included, as everywhere). By reference, never by
--   path: a draft, a retired version and a made-up name are all unreadable to a student.
create or replace function public.onboarding_video_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select (select auth.uid()) is not null
     and exists (select 1 from public.onboarding_videos v
                  where v.status = 'published' and v.storage_path = p_name)
     and public.user_is_approved((select auth.uid()))
     and public.user_is_enrolled((select auth.uid()));
$fn$;

-- A write into the folder of a DRAFT that exists, by a Super Admin. The permission is checked
-- here as well as in the policy, so granting this helper to authenticated is no oracle.
create or replace function public.onboarding_video_upload_allowed(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.has_staff_permission('onboarding.manage')
     and exists (select 1 from public.onboarding_videos v
                  where v.status = 'draft'
                    and v.id = public.onboarding_video_path_version_id(p_name));
$fn$;

-- Is this the live object? The delete policy refuses it. Answers only to a Super Admin.
create or replace function public.onboarding_video_object_is_live(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.has_staff_permission('onboarding.manage')
     and exists (select 1 from public.onboarding_videos v
                  where v.status = 'published' and v.storage_path = p_name);
$fn$;

comment on function public.onboarding_video_object_readable(text) is
  '#69: reference-based read authorization for the private onboarding-videos bucket: only the '
  'object the published version cites, and only for an approved, enrolled caller. Granted to '
  'authenticated because a storage policy calls it as the caller.';
comment on function public.onboarding_video_upload_allowed(text) is
  '#69: path-parsed WRITE authorization: versions/<draft id>/<upload id>.mp4 into an existing '
  'draft''s folder, by a holder of onboarding.manage. A malformed path parses to NULL and denies.';

-- ★ WHO IS ASKED TO WATCH, decided in ONE place (see the file header for the three edges).
--   INTERNAL: it answers about ANY user, so no client role may call it; my_onboarding_video()
--   asks it about the caller, and enrollment_decision_email_facts() about the request's student.
create or replace function public.user_onboarding_video_state(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_video    public.onboarding_videos%rowtype;
  v_since    timestamptz;
  v_first    timestamptz;
  v_staff    boolean;
  v_eligible boolean;
  v_media    boolean;
  v_done     timestamptz;
  v_done_cur timestamptz;
begin
  select * into v_video from public.onboarding_videos where status = 'published';
  -- The FIRST publish of ANY version: retired and deleted versions count (edge c).
  select min(published_at) into v_since
    from public.onboarding_videos
   where published_at is not null;
  -- The FIRST subscription row, whatever its status (edges a and b).
  select min(s.created_at) into v_first
    from public.subscriptions s
   where s.user_id = p_user;
  -- Staff are never learners (#52): an invited or active membership, or is_admin.
  v_staff := coalesce((select p.is_admin from public.profiles p where p.id = p_user), false)
    or exists (select 1 from public.staff_memberships m
                where m.user_id = p_user and m.status in ('invited', 'active'));
  v_eligible := coalesce(public.user_is_approved(p_user) and public.user_is_enrolled(p_user), false);
  -- ★ THE FILE MUST REALLY BE THERE. A live row whose object was removed in the Storage
  --   dashboard gates nobody; the Super Admin's screen reports the file as missing instead.
  v_media := v_video.id is not null and exists (
    select 1 from storage.objects o
     where o.bucket_id = 'onboarding-videos' and o.name = v_video.storage_path);
  select min(g.completed_at) into v_done
    from public.student_onboarding_progress g
   where g.user_id = p_user and g.completed_at is not null;
  if v_video.id is not null then
    select g.completed_at into v_done_cur
      from public.student_onboarding_progress g
     where g.user_id = p_user and g.video_id = v_video.id;
  end if;

  return jsonb_build_object(
    'video_id',          v_video.id,
    'eligible',          v_eligible,
    'staff',             v_staff,
    'media_available',   coalesce(v_media, false),
    'completed',         v_done is not null,
    -- The live version's completion when there is one, else the first completion of any.
    'completed_at',      coalesce(v_done_cur, v_done),
    'completed_current', v_done_cur is not null,
    'required_since',    v_since,
    'required',          coalesce(v_video.id is not null and v_media and v_eligible and not v_staff
                                  and v_done is null and v_since is not null and v_first is not null
                                  and v_first >= v_since, false));
end;
$fn$;

-- ★ REVOKED HERE AS WELL AS IN SECTION 10. It answers about ANY user, and a new function starts
--   with Supabase's default EXECUTE for anon and authenticated. Applied as one transaction the
--   section-10 revoke would do; under scripts/apply-db-files.mjs, which sends one statement per
--   call, this is what closes the window between the CREATE and section 10. Every other function
--   in the file gates itself or is harmless to call.
revoke all on function public.user_onboarding_video_state(uuid) from public, anon, authenticated;


-- == 5) The private bucket and its policies ===================================
do $blk$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('onboarding-videos', 'onboarding-videos', false, 2147483648,
          array['video/mp4', 'video/quicktime'])
  on conflict (id) do update
    set public             = false,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception
  when insufficient_privilege then
    raise notice '#69: could not create onboarding-videos from SQL. In Dashboard -> Storage -> New bucket, create "onboarding-videos" with Public = OFF, a file size limit of 2147483648 bytes (2 GiB; the Dashboard''s "2 GB" is 2,000,000,000 and is too low), and allowed MIME types video/mp4, video/quicktime.';
end
$blk$;

-- ★ A Super Admin reads everything in the bucket (drafts, for Preview); anyone else reads the
--   ONE live object, by reference.
drop policy if exists onboarding_videos_object_read on storage.objects;
create policy onboarding_videos_object_read on storage.objects
  for select to authenticated
  using (bucket_id = 'onboarding-videos'
         and ((select public.has_staff_permission('onboarding.manage'))
              or public.onboarding_video_object_readable(name)));

-- ★ Uploads go only into the folder of an existing DRAFT, so the live file can never be
--   overwritten in place.
drop policy if exists onboarding_videos_object_insert on storage.objects;
create policy onboarding_videos_object_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'onboarding-videos'
              and (select public.has_staff_permission('onboarding.manage'))
              and public.onboarding_video_upload_allowed(name));

drop policy if exists onboarding_videos_object_update on storage.objects;
create policy onboarding_videos_object_update on storage.objects
  for update to authenticated
  using (bucket_id = 'onboarding-videos'
         and (select public.has_staff_permission('onboarding.manage'))
         and public.onboarding_video_upload_allowed(name));

-- ★ ANY object but the live one: a replaced draft upload, a retired or deleted version's file.
drop policy if exists onboarding_videos_object_delete on storage.objects;
create policy onboarding_videos_object_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'onboarding-videos'
         and (select public.has_staff_permission('onboarding.manage'))
         and not public.onboarding_video_object_is_live(name));


-- == 6) Student RPCs ==========================================================
-- ★ NO ARGUMENT NAMES A USER, A PATH OR A VIDEO: the subject is auth.uid() and the video is the
--   live one. The only student parameter anywhere is report_onboarding_video_problem.p_code.

-- The caller's own answer, for the gate and for the replay page.
create or replace function public.my_onboarding_video()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_state  jsonb;
  v_manage boolean;
  v_video  public.onboarding_videos%rowtype;
begin
  if v_uid is null then
    perform public.app_error('FORBIDDEN', 'Sign in to see the Getting Started video.', 403, null);
  end if;
  v_state  := public.user_onboarding_video_state(v_uid);
  v_manage := public.has_staff_permission('onboarding.manage');
  if (v_state->>'video_id') is not null
     and ((v_state->>'eligible')::boolean or v_manage) then
    select * into v_video from public.onboarding_videos where id = (v_state->>'video_id')::uuid;
  end if;

  return jsonb_build_object(
    'configured',        true,
    'eligible',          (v_state->>'eligible')::boolean,
    'required',          coalesce((v_state->>'required')::boolean, false),
    'completed',         (v_state->>'completed')::boolean,
    'completed_at',      v_state->'completed_at',
    'completed_current', (v_state->>'completed_current')::boolean,
    'media_available',   (v_state->>'media_available')::boolean,
    'can_manage',        v_manage,
    -- ★ Metadata only, to an eligible viewer or a manager: never an object name, never a draft.
    'video', case when v_video.id is null then null else jsonb_build_object(
               'id',               v_video.id,
               'title',            v_video.title,
               'description',      v_video.description,
               'transcript',       v_video.transcript,
               'duration_seconds', v_video.duration_seconds,
               'published_at',     v_video.published_at) end);
end;
$fn$;

-- Opens the live video. ★ THE ONE STUDENT RPC THAT NAMES AN OBJECT, and only to an eligible
--   caller (or to a holder of onboarding.manage, for Preview). It is not the only place a path
--   can be seen: a Super Admin sees every version's path in admin_onboarding_video_overview(), in
--   the events trail and through the table's own SELECT policy. A student's first open is kept
--   for good; staff are never recorded.
create or replace function public.start_onboarding_video()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_state  jsonb;
  v_manage boolean;
  v_video  public.onboarding_videos%rowtype;
begin
  if v_uid is null then
    perform public.app_error('FORBIDDEN', 'Sign in to watch the Getting Started video.', 403, null);
  end if;
  v_state  := public.user_onboarding_video_state(v_uid);
  v_manage := public.has_staff_permission('onboarding.manage');
  if not coalesce((v_state->>'eligible')::boolean, false) and not v_manage then
    perform public.app_error('ONBOARDING_VIDEO_NOT_ELIGIBLE',
      'The Getting Started video is for approved members with an active membership.', 403, null);
  end if;

  select * into v_video from public.onboarding_videos where status = 'published';
  if v_video.id is null
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'onboarding-videos' and o.name = v_video.storage_path) then
    perform public.app_error('ONBOARDING_VIDEO_UNAVAILABLE',
      'No Getting Started video is available to play right now.', 409, null);
  end if;

  if coalesce((v_state->>'eligible')::boolean, false)
     and not coalesce((v_state->>'staff')::boolean, false) then
    insert into public.student_onboarding_progress (user_id, video_id, first_started_at, last_started_at)
    values (v_uid, v_video.id, now(), now())
    on conflict (user_id, video_id) do update
      set last_started_at = now(),
          updated_at = now();
  end if;

  return jsonb_build_object(
    'video_id',         v_video.id,
    'storage_path',     v_video.storage_path,
    'duration_seconds', v_video.duration_seconds);
end;
$fn$;

-- Records the caller's completion of the LIVE version, once.
create or replace function public.complete_onboarding_video()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_state    jsonb;
  v_video    public.onboarding_videos%rowtype;
  v_row      public.student_onboarding_progress%rowtype;
  v_min_secs numeric;
  v_ready_at timestamptz;
  v_first    boolean;
  v_done_at  timestamptz;
begin
  if v_uid is null then
    perform public.app_error('FORBIDDEN', 'Sign in to finish the Getting Started video.', 403, null);
  end if;
  v_state := public.user_onboarding_video_state(v_uid);
  if not coalesce((v_state->>'eligible')::boolean, false) then
    perform public.app_error('ONBOARDING_VIDEO_NOT_ELIGIBLE',
      'The Getting Started video is for approved members with an active membership.', 403, null);
  end if;
  -- ★ Staff are never learners (#52): a staff replay records nothing, and says so.
  if coalesce((v_state->>'staff')::boolean, false) then
    return jsonb_build_object('ok', true, 'recorded', false);
  end if;

  -- ★ THE LIVE ROW IS LOCKED FOR SHARE, so a replacement published in the same instant waits
  --   for this completion, which then belongs to the version the student actually watched.
  select * into v_video from public.onboarding_videos where status = 'published' for share;
  -- ★ …AND LOOKED FOR TWICE BEFORE "NOTHING IS LIVE". When a publish holds the live row first,
  --   this read waits for it, then re-checks the row on its newest version (READ COMMITTED): the
  --   old version is retired by then, and the new one was still a draft in this statement's
  --   snapshot, so the read comes back EMPTY while a video IS live. A second statement takes a
  --   fresh snapshot (the function is VOLATILE) and finds the new version, locked like the first;
  --   the progress row below then answers NOT_FINISHED with its id, as it would a moment later.
  if v_video.id is null then
    select * into v_video from public.onboarding_videos where status = 'published' for share;
  end if;
  if v_video.id is null then
    perform public.app_error('ONBOARDING_VIDEO_UNAVAILABLE',
      'No Getting Started video is live right now.', 409, null);
  end if;

  select * into v_row
    from public.student_onboarding_progress g
   where g.user_id = v_uid and g.video_id = v_video.id
     for update;
  if not found then
    -- ★ Also the answer when a NEW version replaced the one the student was watching: their
    --   row is for the old one. current_video_id tells the screen which video to load.
    perform public.app_error('ONBOARDING_VIDEO_NOT_FINISHED',
      'Open the current Getting Started video before finishing it.', 409,
      jsonb_build_object('current_video_id', v_video.id, 'started', false));
  end if;

  -- ★ THE ELAPSED GUARD, mirrored by ONBOARDING_MIN_ELAPSED_FRACTION,
  --   ONBOARDING_UNKNOWN_DURATION_SECONDS and ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS.
  v_min_secs := greatest(coalesce(v_video.duration_seconds, 60) * 0.4, 5);
  v_ready_at := v_row.first_started_at + make_interval(secs => v_min_secs::double precision);
  if now() < v_ready_at then
    perform public.app_error('ONBOARDING_VIDEO_NOT_FINISHED',
      'The Getting Started video has not played long enough to finish yet.', 409,
      jsonb_build_object('current_video_id', v_video.id, 'started', true,
                         'seconds_remaining', ceil(extract(epoch from (v_ready_at - now())))));
  end if;

  v_first := v_row.completed_at is null;
  -- ★ NEVER RE-STAMPED: a replay keeps the first completion (#52's recency-forgery rule).
  update public.student_onboarding_progress
     set completed_at = coalesce(completed_at, now()),
         updated_at = now()
   where user_id = v_uid and video_id = v_video.id
  returning completed_at into v_done_at;

  return jsonb_build_object(
    'ok',               true,
    'recorded',         true,
    'video_id',         v_video.id,
    'completed_at',     v_done_at,
    'first_completion', v_first);
end;
$fn$;

-- A playback failure the student's player hit. UPDATE-only and at most once a minute, so a
-- failing player in a loop cannot grow or churn the table; silent for anyone not a learner.
create or replace function public.report_onboarding_video_problem(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_state jsonb;
  v_code  text := lower(btrim(coalesce(p_code, '')));
  v_n     integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false);
  end if;
  v_state := public.user_onboarding_video_state(v_uid);
  if not coalesce((v_state->>'eligible')::boolean, false)
     or coalesce((v_state->>'staff')::boolean, false)
     or (v_state->>'video_id') is null then
    return jsonb_build_object('ok', false);
  end if;
  -- ★ Exactly ONBOARDING_PROBLEM_CODES in src/lib/gettingStarted.js; anything else is 'other'.
  if v_code not in ('sign', 'decode', 'playback', 'missing', 'other') then
    v_code := 'other';
  end if;
  update public.student_onboarding_progress
     set last_problem_at = now(),
         last_problem_code = v_code,
         updated_at = now()
   where user_id = v_uid
     and video_id = (v_state->>'video_id')::uuid
     and (last_problem_at is null or last_problem_at <= now() - interval '1 minute');
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'recorded', v_n > 0, 'code', v_code);
end;
$fn$;


-- == 7) Super Admin RPCs ======================================================
-- ★ EACH OPENS WITH THE onboarding.manage CHECK, and each state change writes ONE event row. A
--   call that changes nothing writes none (#56's rule: the trail answers "when did this become
--   live", and a double click must not muddy it).

-- Facts only, for onboardingHealth() and publishImpact() to interpret. Counted set-based.
create or replace function public.admin_onboarding_video_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_since    timestamptz;
  v_live     uuid;
  v_versions jsonb;
  v_counts   jsonb;
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;

  select min(v.published_at) into v_since
    from public.onboarding_videos v
   where v.published_at is not null;
  select v.id into v_live
    from public.onboarding_videos v
   where v.status = 'published';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                v.id,
           'status',            v.status,
           'title',             v.title,
           'description',       v.description,
           'transcript',        v.transcript,
           'storage_path',      v.storage_path,
           'original_filename', v.original_filename,
           'mime_type',         v.mime_type,
           'byte_size',         v.byte_size,
           'duration_seconds',  v.duration_seconds,
           'media_attached_at', v.media_attached_at,
           'media_present',     o.id is not null,
           'published_at',      v.published_at,
           'last_published_at', v.last_published_at,
           'published_by_name', coalesce(nullif(btrim(pp.full_name), ''), pp.email),
           'retired_at',        v.retired_at,
           'retired_by_name',   coalesce(nullif(btrim(pr.full_name), ''), pr.email),
           'deleted_at',        v.deleted_at,
           'deleted_by_name',   coalesce(nullif(btrim(pd.full_name), ''), pd.email),
           'created_at',        v.created_at,
           'created_by_name',   coalesce(nullif(btrim(pc.full_name), ''), pc.email),
           'updated_at',        v.updated_at,
           'completions',       coalesce(st.completions, 0),
           'problems_7d',       coalesce(st.problems_7d, 0))
         order by (v.status = 'published') desc, v.created_at desc), '[]'::jsonb)
    into v_versions
    from public.onboarding_videos v
    left join (select g.video_id,
                      (count(*) filter (where g.completed_at is not null))::int as completions,
                      (count(*) filter (where g.last_problem_at >= now() - interval '7 days'))::int as problems_7d
                 from public.student_onboarding_progress g
                group by g.video_id) st on st.video_id = v.id
    left join storage.objects o on o.bucket_id = 'onboarding-videos' and o.name = v.storage_path
    left join public.profiles pc on pc.id = v.created_by
    left join public.profiles pp on pp.id = v.published_by
    left join public.profiles pr on pr.id = v.retired_by
    left join public.profiles pd on pd.id = v.deleted_by;

  -- ★ THE SAME RULE AS user_onboarding_video_state(), SET-BASED: approved and enrolled (a live
  --   term, the grace included, or a grandfathered paid profile with no subscription row), not
  --   staff. pending_students is who a live video would ask: joined on or after the cutoff and
  --   finished no version.
  with subs as (
    select s.user_id,
           min(s.created_at) as first_at,
           bool_or(s.status = 'active'
                   and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())) as live
      from public.subscriptions s
     group by s.user_id
  ), staff as (
    select m.user_id from public.staff_memberships m where m.status in ('invited', 'active')
  ), finished as (
    select distinct g.user_id from public.student_onboarding_progress g where g.completed_at is not null
  ), members as (
    select p.id, sb.first_at
      from public.profiles p
      left join subs sb on sb.user_id = p.id
     where p.approval_status = 'approved'
       and not p.is_admin
       and not exists (select 1 from staff st where st.user_id = p.id)
       and (coalesce(sb.live, false) or (p.is_paid and sb.user_id is null))
  )
  select jsonb_build_object(
           'active_members',     (select count(*) from members),
           'pending_students',   (select count(*) from members mb
                                   where v_since is not null
                                     and mb.first_at is not null
                                     and mb.first_at >= v_since
                                     and not exists (select 1 from finished f where f.user_id = mb.id)),
           'completed_students', (select count(*) from finished f
                                    join public.profiles p on p.id = f.user_id
                                   where not p.is_admin
                                     and not exists (select 1 from staff st where st.user_id = f.user_id)))
    into v_counts;

  return jsonb_build_object(
    'live_video_id',  v_live,
    'required_since', v_since,
    'counts',         v_counts,
    'versions',       v_versions);
end;
$fn$;

-- ★ A DRAFT COMES FIRST, BEFORE ANY UPLOAD: the storage INSERT policy and the object name both
--   need the draft's id.
create or replace function public.admin_onboarding_video_create_draft(
  p_title       text,
  p_description text default null,
  p_transcript  text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_title text := btrim(coalesce(p_title, ''));
  v_desc  text := nullif(btrim(coalesce(p_description, '')), '');
  v_tx    text := nullif(btrim(coalesce(p_transcript, '')), '');
  v_id    uuid;
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;
  if char_length(v_title) not between 1 and 120
     or char_length(coalesce(v_desc, '')) > 600
     or char_length(coalesce(v_tx, '')) > 20000 then
    perform public.app_error('ONBOARDING_VIDEO_TEXT_INVALID',
      'The title needs 1 to 120 characters, the description at most 600 and the transcript at most 20,000.',
      422, null);
  end if;

  insert into public.onboarding_videos (title, description, transcript, created_by)
  values (v_title, v_desc, v_tx, v_uid)
  returning id into v_id;

  insert into public.onboarding_video_events (video_id, action, actor_id, detail)
  values (v_id, 'create_draft', v_uid, jsonb_build_object('title', v_title));

  return jsonb_build_object('ok', true, 'video_id', v_id, 'status', 'draft');
end;
$fn$;

-- ★ NO DEFAULTS, ON PURPOSE: the editor sends all three fields, and an empty one clears it. A
--   caller that omits one is refused by PostgREST (no such function), never read as "clear".
create or replace function public.admin_onboarding_video_update_details(
  p_video_id    uuid,
  p_title       text,
  p_description text,
  p_transcript  text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_row     public.onboarding_videos%rowtype;
  v_title   text := btrim(coalesce(p_title, ''));
  v_desc    text := nullif(btrim(coalesce(p_description, '')), '');
  v_tx      text := nullif(btrim(coalesce(p_transcript, '')), '');
  v_changed text[];
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;

  select * into v_row from public.onboarding_videos v where v.id = p_video_id for update;
  if not found then
    perform public.app_error('ONBOARDING_VIDEO_NOT_FOUND', 'That Getting Started video does not exist.', 404,
      jsonb_build_object('video_id', p_video_id));
  end if;
  if v_row.status = 'deleted' then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID', 'A deleted version cannot be edited.', 409,
      jsonb_build_object('video_id', p_video_id, 'status', v_row.status));
  end if;
  if char_length(v_title) not between 1 and 120
     or char_length(coalesce(v_desc, '')) > 600
     or char_length(coalesce(v_tx, '')) > 20000 then
    perform public.app_error('ONBOARDING_VIDEO_TEXT_INVALID',
      'The title needs 1 to 120 characters, the description at most 600 and the transcript at most 20,000.',
      422, jsonb_build_object('video_id', p_video_id));
  end if;

  v_changed := array_remove(array[
    case when v_title is distinct from v_row.title then 'title' end,
    case when v_desc is distinct from v_row.description then 'description' end,
    case when v_tx is distinct from v_row.transcript then 'transcript' end]::text[], null::text);
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', false);
  end if;

  update public.onboarding_videos
     set title = v_title, description = v_desc, transcript = v_tx
   where id = p_video_id;

  insert into public.onboarding_video_events (video_id, action, actor_id, detail)
  values (p_video_id, 'update_details', v_uid, jsonb_build_object('fields', to_jsonb(v_changed)));

  return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', true);
end;
$fn$;

-- Binds an uploaded, verified file to a DRAFT. Returns the path it replaced, for the caller to
-- remove (no row cites it any more, and it was never live: only a draft takes a file).
create or replace function public.admin_onboarding_video_attach_media(
  p_video_id          uuid,
  p_storage_path      text,
  p_byte_size         bigint,
  p_mime_type         text,
  p_duration_seconds  numeric,
  p_original_filename text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_row      public.onboarding_videos%rowtype;
  v_meta     jsonb;
  v_obj_size bigint;
  v_size     bigint;
  v_mime     text;
  v_duration numeric;
  v_name     text;
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;

  select * into v_row from public.onboarding_videos v where v.id = p_video_id for update;
  if not found then
    perform public.app_error('ONBOARDING_VIDEO_NOT_FOUND', 'That Getting Started video does not exist.', 404,
      jsonb_build_object('video_id', p_video_id));
  end if;
  if v_row.status <> 'draft' then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'Only a draft can take a new file. Upload the new video as a new draft.', 409,
      jsonb_build_object('video_id', p_video_id, 'status', v_row.status));
  end if;

  -- ★ THE FILE MUST BE IN THIS DRAFT'S OWN FOLDER. The write policy admits an upload into the
  --   folder of ANY draft; this is what stops one draft citing another's file.
  if public.onboarding_video_path_version_id(p_storage_path) is distinct from p_video_id then
    perform public.app_error('ONBOARDING_VIDEO_MEDIA_INVALID',
      'That file is not one of this draft''s uploads.', 422,
      jsonb_build_object('video_id', p_video_id));
  end if;

  select o.metadata into v_meta
    from storage.objects o
   where o.bucket_id = 'onboarding-videos' and o.name = p_storage_path;
  if not found then
    perform public.app_error('ONBOARDING_VIDEO_MEDIA_INVALID',
      'That upload is not in storage. Upload the video again.', 422,
      jsonb_build_object('video_id', p_video_id));
  end if;

  -- The size storage recorded, when it recorded one, must be the size the uploader sent.
  if coalesce(v_meta->>'size', '') ~ '^[0-9]+$' then
    v_obj_size := (v_meta->>'size')::bigint;
  end if;
  v_size := coalesce(p_byte_size, v_obj_size);
  v_mime := coalesce(nullif(lower(btrim(coalesce(p_mime_type, ''))), ''), lower(v_meta->>'mimetype'));
  v_duration := round(p_duration_seconds, 2);
  v_name := left(nullif(btrim(coalesce(p_original_filename, '')), ''), 255);

  if v_size is null or v_size < 1 or v_size > 2147483648
     or (p_byte_size is not null and v_obj_size is not null and p_byte_size <> v_obj_size)
     or (v_mime is not null and v_mime not in ('video/mp4', 'video/quicktime'))
     or (v_duration is not null and (v_duration <= 0 or v_duration > 14400)) then
    perform public.app_error('ONBOARDING_VIDEO_MEDIA_INVALID',
      'The upload''s size, type or length is not valid for a Getting Started video.', 422,
      jsonb_build_object('video_id', p_video_id, 'byte_size', v_size, 'object_size', v_obj_size,
                         'mime_type', v_mime, 'duration_seconds', v_duration));
  end if;

  -- ★ A CALL THAT CHANGES NOTHING WRITES NOTHING, as section 7 promises of every writer. The file
  --   this draft already cites, attached again with the same facts — a Save retried after its
  --   answer was lost, or a direct call — keeps media_attached_at and adds no event. It answers
  --   only AFTER every check above, so a file that has since vanished from storage is refused, not
  --   reported unchanged.
  if (v_row.storage_path, v_row.original_filename, v_row.mime_type, v_row.byte_size, v_row.duration_seconds)
     is not distinct from (p_storage_path, v_name, v_mime, v_size, v_duration) then
    return jsonb_build_object('ok', true, 'video_id', p_video_id, 'storage_path', p_storage_path,
                              'previous_storage_path', null, 'changed', false);
  end if;

  update public.onboarding_videos
     set storage_path      = p_storage_path,
         original_filename = v_name,
         mime_type         = v_mime,
         byte_size         = v_size,
         duration_seconds  = v_duration,
         media_attached_at = now()
   where id = p_video_id;

  insert into public.onboarding_video_events (video_id, action, actor_id, detail)
  values (p_video_id, 'attach_media', v_uid, jsonb_build_object(
    'storage_path', p_storage_path, 'previous_storage_path', v_row.storage_path,
    'byte_size', v_size, 'mime_type', v_mime, 'duration_seconds', v_duration));

  return jsonb_build_object(
    'ok',                    true,
    'video_id',              p_video_id,
    'storage_path',          p_storage_path,
    'previous_storage_path', case when v_row.storage_path is distinct from p_storage_path
                                  then v_row.storage_path end,
    'changed',               true);
end;
$fn$;

-- Makes a draft or retired version the live one.
-- ★ RE-SIGNED, SO THE TWO-ARGUMENT FORM IS DROPPED FIRST. p_expected_live_id (below) is a third
--   parameter, and CREATE OR REPLACE with a new parameter does not replace publish(uuid, boolean):
--   it adds an OVERLOAD beside it, and then PostgREST refuses every call as ambiguous (PGRST203)
--   and a two-argument SQL call is "not unique". No CASCADE: nothing may depend on it, and if
--   something ever did, this file should stop rather than strip it silently. On a re-run there
--   is nothing to drop.
drop function if exists public.admin_onboarding_video_publish(uuid, boolean);
create or replace function public.admin_onboarding_video_publish(
  p_video_id     uuid,
  p_replace_live boolean default false,
  p_expected_live_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_row   public.onboarding_videos%rowtype;
  v_live  public.onboarding_videos%rowtype;
  v_since timestamptz;
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;

  -- ★ LOCK THE TARGET AND THE LIVE ROW IN ID ORDER, so two publishes cannot deadlock. The
  --   one-live index is the backstop: a race can fail a publish, never make two live.
  perform 1
     from public.onboarding_videos v
    where v.id = p_video_id or v.status = 'published'
    order by v.id
      for update;

  select * into v_row from public.onboarding_videos v where v.id = p_video_id;
  if not found then
    perform public.app_error('ONBOARDING_VIDEO_NOT_FOUND', 'That Getting Started video does not exist.', 404,
      jsonb_build_object('video_id', p_video_id));
  end if;
  if v_row.status = 'published' then
    return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', false);
  end if;
  if v_row.status = 'deleted' then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID',
      'A deleted version cannot be published. Upload it again as a new draft.', 409,
      jsonb_build_object('video_id', p_video_id, 'status', v_row.status));
  end if;
  if v_row.storage_path is null or v_row.media_attached_at is null
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'onboarding-videos' and o.name = v_row.storage_path) then
    perform public.app_error('ONBOARDING_VIDEO_MEDIA_INVALID',
      'This version has no file in storage. Upload one before publishing it.', 422,
      jsonb_build_object('video_id', p_video_id));
  end if;

  select * into v_live
    from public.onboarding_videos v
   where v.status = 'published' and v.id <> p_video_id
     for update;
  -- ★ A REPLACE RETIRES THE VERSION ITS DIALOG NAMED, OR NOTHING. The Replace dialog promises to
  --   retire ONE version, by title, and p_expected_live_id carries that version's id. If anything
  --   else is live now — another version published from a second window or by another Super
  --   Admin — or nothing is, because someone unpublished it, the replace is refused with the facts
  --   as they are NOW (live_id and live_title null when nothing is live), and the dialog asks
  --   again. `is distinct from`, not `<>`: with nothing live, v_live.id is null. NULL keeps the
  --   original contract (retire whatever is live), so a caller that names no version behaves
  --   exactly as before.
  if coalesce(p_replace_live, false) and p_expected_live_id is not null
     and v_live.id is distinct from p_expected_live_id then
    perform public.app_error('ONBOARDING_VIDEO_REPLACE_CONFIRM',
      'The live Getting Started video changed after this replacement was confirmed. Check which version is live, then confirm again.', 409,
      jsonb_build_object('live_id', v_live.id, 'live_title', v_live.title,
                         'expected_live_id', p_expected_live_id));
  end if;
  if v_live.id is not null then
    -- ★ REPLACING THE LIVE VIDEO IS ASKED FOR EXPLICITLY, and only the confirmation dialog
    --   passes p_replace_live: whoever has not finished will see the new video instead.
    if not coalesce(p_replace_live, false) then
      perform public.app_error('ONBOARDING_VIDEO_REPLACE_CONFIRM',
        'Another Getting Started video is live. Confirm that this one replaces it.', 409,
        jsonb_build_object('live_id', v_live.id, 'live_title', v_live.title));
    end if;
    -- ★ RETIRE FIRST, THEN PUBLISH: the one-live index checks each row as it is written.
    update public.onboarding_videos
       set status = 'retired', retired_at = now(), retired_by = v_uid
     where id = v_live.id;
  end if;

  select min(v.published_at) into v_since
    from public.onboarding_videos v
   where v.published_at is not null;

  update public.onboarding_videos
     set status = 'published',
         published_at = coalesce(published_at, now()),
         last_published_at = now(),
         published_by = v_uid
   where id = p_video_id;

  insert into public.onboarding_video_events (video_id, action, actor_id, detail)
  values (p_video_id, 'publish', v_uid, jsonb_build_object(
    'replaced_video_id', v_live.id, 'from_status', v_row.status, 'first_publish', v_since is null));

  return jsonb_build_object(
    'ok',                true,
    'video_id',          p_video_id,
    'changed',           true,
    'replaced_video_id', v_live.id,
    'first_publish',     v_since is null,
    'required_since',    coalesce(v_since, now()));
end;
$fn$;

-- Takes the live version down. Nobody is asked to watch while nothing is live.
create or replace function public.admin_onboarding_video_unpublish(p_video_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row public.onboarding_videos%rowtype;
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;

  select * into v_row from public.onboarding_videos v where v.id = p_video_id for update;
  if not found then
    perform public.app_error('ONBOARDING_VIDEO_NOT_FOUND', 'That Getting Started video does not exist.', 404,
      jsonb_build_object('video_id', p_video_id));
  end if;
  if v_row.status = 'retired' then
    return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', false);
  end if;
  if v_row.status <> 'published' then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID', 'Only the live version can be unpublished.', 409,
      jsonb_build_object('video_id', p_video_id, 'status', v_row.status));
  end if;

  update public.onboarding_videos
     set status = 'retired', retired_at = now(), retired_by = v_uid
   where id = p_video_id;

  insert into public.onboarding_video_events (video_id, action, actor_id, detail)
  values (p_video_id, 'unpublish', v_uid, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', true);
end;
$fn$;

-- Marks a draft or retired version deleted. The row stays (history is permanent); the file's
-- path is returned for the caller to remove, which the delete policy allows now it is not live.
create or replace function public.admin_onboarding_video_delete(p_video_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row public.onboarding_videos%rowtype;
begin
  if not public.has_staff_permission('onboarding.manage') then
    perform public.app_error('FORBIDDEN', 'Only a Super Admin can manage the Getting Started video.', 403, null);
  end if;

  select * into v_row from public.onboarding_videos v where v.id = p_video_id for update;
  if not found then
    perform public.app_error('ONBOARDING_VIDEO_NOT_FOUND', 'That Getting Started video does not exist.', 404,
      jsonb_build_object('video_id', p_video_id));
  end if;
  if v_row.status = 'published' then
    perform public.app_error('ONBOARDING_VIDEO_STATE_INVALID', 'Unpublish the live version before deleting it.', 409,
      jsonb_build_object('video_id', p_video_id, 'status', v_row.status));
  end if;
  if v_row.status = 'deleted' then
    return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', false,
                              'storage_path', v_row.storage_path);
  end if;

  update public.onboarding_videos
     set status = 'deleted', deleted_at = now(), deleted_by = v_uid
   where id = p_video_id;

  insert into public.onboarding_video_events (video_id, action, actor_id, detail)
  values (p_video_id, 'delete', v_uid, jsonb_build_object(
    'from_status', v_row.status, 'storage_path', v_row.storage_path));

  return jsonb_build_object('ok', true, 'video_id', p_video_id, 'changed', true,
                            'storage_path', v_row.storage_path);
end;
$fn$;


-- == 8) The decision email's facts ============================================
-- ★ THE PAGE DESCRIBES, THE SERVER RESOLVES (#61). api/notify-enrollment.js used to take the
--   package from the request body; it now asks this, with the reviewer's own JWT, for the facts
--   the decision email states. There is no per-approval course selection, so the "programs" are
--   the plan's scope; the cohort is a VIP-only fact (#68), read from the plan's segment.
create or replace function public.enrollment_decision_email_facts(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_req   public.enrollment_requests%rowtype;
  v_plan  public.enrollment_plans%rowtype;
  v_sub   public.subscriptions%rowtype;
  v_batch public.batches%rowtype;
  v_gs    jsonb;
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'Reviewing enrollments requires the enrollments.review permission.', 403, null);
  end if;

  select * into v_req from public.enrollment_requests r where r.id = p_request_id;
  if not found then
    perform public.app_error('REQUEST_NOT_FOUND', 'The enrollment request does not exist.', 404,
      jsonb_build_object('request_id', p_request_id));
  end if;

  -- The term this decision granted: the subscription carrying the request…
  select * into v_sub
    from public.subscriptions s
   where s.request_id = v_req.id
   order by s.created_at desc
   limit 1;
  -- …or, for an APPROVED extension of a term with no end date, the live term: approve_extension()
  --   returns such a term unchanged, so no row carries the request. A rejected or pending
  --   request granted nothing, and states no term.
  if v_sub.id is null and v_req.request_kind = 'extension' and v_req.status = 'approved' then
    select * into v_sub
      from public.subscriptions s
     where s.user_id = v_req.user_id and s.status = 'active'
     order by s.created_at desc
     limit 1;
  end if;

  -- ★ THE PLAN IS THE GRANTED TERM'S. admin_finalize_enrollment() grants an extension on the
  --   member's CURRENT plan (their latest term's), which need not be the plan the request names;
  --   the request's plan speaks only when nothing was granted.
  select * into v_plan from public.enrollment_plans p where p.key = coalesce(v_sub.plan_key, v_req.plan_key);

  if v_plan.community_segment = 'vip' then
    select * into v_batch from public.batches b where b.id = coalesce(v_sub.batch_id, v_req.batch_id);
  end if;

  v_gs := public.user_onboarding_video_state(v_req.user_id);

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id',             v_req.id,
      'status',         v_req.status,
      'kind',           v_req.request_kind,
      'extension_days', v_req.extension_days),
    'plan', case when v_plan.key is null then null else jsonb_build_object(
      'key',                 v_plan.key,
      'name',                v_plan.name,
      'tagline',             v_plan.tagline,
      'entitlement_summary', v_plan.entitlement_summary,
      'community_segment',   v_plan.community_segment,
      'access_days',         v_plan.access_days) end,
    'term', case when v_sub.id is null then null else jsonb_build_object(
      'status',        v_sub.status,
      'started_at',    v_sub.started_at,
      'ends_at',       v_sub.ends_at,
      'grace_ends_at', v_sub.grace_ends_at) end,
    'batch', case when v_batch.id is null then null else jsonb_build_object(
      'name',      v_batch.name,
      'code',      v_batch.code,
      'starts_on', v_batch.starts_on) end,
    'getting_started_required', coalesce((v_gs->>'required')::boolean, false));
end;
$fn$;


-- == 9) Error catalog =========================================================
--
-- ★ COPIED FROM #68, NOT RETYPED. The 133 inherited rows are byte-identical (the source body
--   was md5-checked against production prosrc first); LEGACY_BATCH_GAP gains the comma the new
--   rows need, and the eight ONBOARDING_VIDEO_* rows are the only addition (141 total).
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
    ('COURSE_ASSIGNMENT_INVALID',    422, 'Unknown assignment role, or the target account cannot edit courses at all.'),
    ('SUBSCRIPTION_NOT_FOUND',       404, 'That member has no subscription to act on.'),
    ('EXTENSION_NOT_ALLOWED',        409, 'This membership never expires, so an extension could only shorten it.'),
    ('EXTENSION_INVALID',            422, 'The requested extension is out of range, backwards, or missing its reason.'),
    ('STAFF_NO_INVITATION',          404, 'There is no staff membership on this account to accept.'),
    ('STAFF_INVITATION_NOT_PENDING', 409, 'The membership is suspended, revoked or already active; an old link cannot restore it.'),
    ('STAFF_EMAIL_NOT_VERIFIED',     403, 'The Auth identity has not confirmed the mailbox the invitation was sent to.'),
    ('STAFF_ACCOUNT_REJECTED',       403, 'The account is blocked from the platform, so a staff invitation cannot be accepted on it.'),
    ('ACCESS_REQUEST_SELF_REVIEW',   403, 'A reviewer cannot decide on their own access request.'),
    ('ACCESS_REQUEST_STAFF_TARGET',  409, 'The target holds an invited or active staff membership; withdraw staff access through Team & Roles instead.'),
    ('MODERATION_TARGET_NOT_FOUND',  404, 'The post or reply does not exist, or is not in a channel the moderator can reach.'),
    ('MODERATION_ACTION_INVALID',    422, 'Unknown moderation action.'),
    ('MODERATION_STATE_INVALID',     409, 'The target''s current state does not allow that action (e.g. restoring an author-withdrawn post).'),
    -- ── Financial management (#58) ──
    ('FINANCE_ENTRY_UNBALANCED',     409, 'A journal entry must have at least two lines and equal debits and credits.'),
    ('FINANCE_ENTRY_IMMUTABLE',      409, 'A posted entry, line, payment event or audit row cannot be edited or deleted.'),
    ('FINANCE_ENTRY_ALREADY_REVERSED',409,'That entry has already been reversed; one reversal per entry, ever.'),
    ('FINANCE_ENTRY_NOT_FOUND',      404, 'That journal entry does not exist.'),
    ('FINANCE_ENTRY_FUTURE_DATED',   422, 'An entry cannot be dated in the future; a recurring cost is a template, not a posting.'),
    ('FINANCE_ENTRY_KIND_INVALID',   422, 'Unknown entry kind for this action.'),
    ('FINANCE_PERIOD_LOCKED',        409, 'That accounting period is closed; post the correction in an open period.'),
    ('FINANCE_PERIOD_NOT_ELAPSED',   409, 'Only a period that has fully ended in the business timezone can be closed.'),
    ('FINANCE_PERIOD_INVALID',       422, 'Not a real YYYY-MM period, or the period is not locked.'),
    ('FINANCE_PERIOD_REASON_REQUIRED',422,'Reopening a closed accounting period needs a reason.'),
    ('FINANCE_REVERSAL_REASON_REQUIRED',422,'A reversal needs a reason.'),
    ('FINANCE_ACCOUNTS_NOT_CONFIGURED',409,'The default income or cash account is missing or inactive.'),
    ('FINANCE_ACCOUNT_NOT_FOUND',    404, 'That finance account does not exist.'),
    ('FINANCE_SYSTEM_ACCOUNT',       409, 'A system account cannot be deactivated or retyped.'),
    ('FINANCE_EVENT_AMOUNT_MISMATCH',409, 'The payment event amount does not equal its journal entry.'),
    ('FINANCE_AUDIT_IMMUTABLE',      409, 'The finance audit trail is append-only.'),
    ('FINANCE_IDEMPOTENCY_REQUIRED', 422, 'This action needs an idempotency key so a retry cannot post twice.'),
    ('FINANCE_TIMEZONE_INVALID',     422, 'Not a timezone Postgres recognises (see pg_timezone_names).'),
    ('FINANCE_BANK_TXN_IMMUTABLE',   409, 'The parsed facts of a bank transaction cannot be edited; exclude it with a reason.'),
    ('FINANCE_BANK_IMPORT_DUPLICATE',409, 'That statement file has already been imported into this account.'),
    ('FINANCE_RECONCILIATION_CLOSED',409, 'A closed reconciliation is frozen; reopen it with a reason first.'),
    ('FINANCE_RECONCILIATION_UNBALANCED',409,'A reconciliation whose difference is not zero cannot be closed.'),
    ('FINANCE_COLLECTION_RACE',      409, 'Another transaction recorded this collection first; nothing was duplicated.'),
    ('FINANCE_BANK_IMPORT_STATE',    409, 'That import is not in a state this action allows.'),
    ('FINANCE_BANK_TXN_NOT_FOUND',   404, 'That bank transaction does not exist.'),
    ('FINANCE_BANK_EXCLUDE_REASON_REQUIRED',422,'Excluding a bank transaction needs a reason.'),
    ('FINANCE_ACCOUNT_IN_USE',       409, 'The account is a settings default or a plan''s income account, so it cannot be deactivated.'),
    ('FINANCE_RECURRING_INVALID',    422, 'A recurring template is missing a field, uses an inactive account, or has a schedule that does not match its cadence.'),
    -- ── Finance parity (#59) ──
    ('FINANCE_RECLASSIFY_INVALID',   422, 'Only income to income, expense to expense, or expense to owner''s draw, on an unreversed entry, with a reason.'),
    ('FINANCE_PRESET_INVALID',       422, 'An expense preset needs a unique name and an active expense or owner''s draw account.'),
    ('FINANCE_BANK_TXN_LINKED',      409, 'The statement line, or the entry, is already added, matched, excluded or reconciled.'),
    ('FINANCE_BANK_TXN_NOT_LINKED',  409, 'The statement line is not added or matched in the bank feed, so there is nothing to undo.'),
    ('FINANCE_BANK_MATCH_MISMATCH',  422, 'The entry does not move the statement''s account by the same signed amount.'),
    ('FINANCE_BANK_CATEGORY_INVALID',422, 'A statement line must be added to an active account other than its own.'),
    ('FINANCE_ENTRY_HAS_ADJUSTMENTS',409, 'The entry has a reclassification that still stands; reverse that first.'),
    ('FINANCE_BANK_ENROLLMENT_INCOME',409, 'A deposit cannot be added to an account approvals post to; match it to the approval instead.'),
    -- ── Enrollment management (#60) ──
    ('ENROLLMENT_NOT_PENDING',       409, 'Only a request still awaiting review can be held or corrected.'),
    ('ENROLLMENT_HOLD_INVALID',      422, 'A hold needs a reason and a follow-up date that is not in the past, or the request is not on hold.'),
    ('ENROLLMENT_AMOUNT_INVALID',    422, 'An amount correction needs a reason and an amount between 0 and 1,000,000.'),
    ('ENROLLMENT_APPROVE_VIA_RPC',   409, 'A request can only be approved together with its membership grant.'),
    -- ── Communications (#61) ──
    ('COMM_AUDIENCE_INVALID',        422, 'The audience is not valid for this kind of message.'),
    ('COMM_AUDIENCE_EMPTY',          422, 'No one matches this audience.'),
    ('COMM_MESSAGE_INVALID',         422, 'A message needs a subject of up to 200 characters and a body of up to 20,000.'),
    ('COMM_DAILY_CAP',               429, 'Sending this would pass today''s email limit.'),
    ('COMM_RULE_INVALID',            422, 'The automation rule is incomplete or inconsistent.'),
    ('COMM_NOT_FOUND',               404, 'The campaign or automation rule does not exist.'),
    ('COMM_CAMPAIGN_CLOSED',         409, 'The campaign was cancelled.'),
    ('COMM_CAP_INVALID',             422, 'The daily limit must be between 1 and 50,000.'),
    ('MEETING_INVALID',              422, 'The meeting, invitation or template details are incomplete or inconsistent.'),
    ('MEETING_NOT_FOUND',            404, 'The meeting or meeting template does not exist.'),
    ('TASK_INVALID',                 422, 'A task needs a title of up to 300 characters and a day, week or month.'),
    ('TASK_NOT_FOUND',               404, 'The task does not exist.'),
    ('ZOOM_NOT_CONNECTED',           503, 'Zoom is not connected: the server Zoom credentials are missing or were refused.'),
    ('ZOOM_REQUEST_FAILED',          502, 'Zoom did not complete the request.'),
    ('MEETING_LOG_FAILED',           502, 'The meeting was created in Zoom but could not be recorded here, so no invitations were sent.'),
    ('FINANCE_COLLECTION_AMOUNT_INVALID',422, 'The enrollment records an amount outside the range a collection may post.'),
    ('LESSON_ASSET_FORBIDDEN',       403, 'You cannot manage images for that course.'),
    ('LESSON_ASSET_NOT_FOUND',       404, 'The lesson image does not exist.'),
    ('LESSON_ASSET_IN_USE',          409, 'The image is still used by a lesson, so it was not deleted.'),
    ('LESSON_ASSET_LIMIT',           422, 'A lesson may show at most 10 images.'),
    ('LESSON_ASSET_ALT_REQUIRED',    422, 'Every lesson image needs a short description for screen readers.'),
    ('LESSON_ASSET_BAD_PATH',        422, 'The image object path is not the shape a lesson asset uses.'),
    ('LESSON_ASSET_UNKNOWN_REF',     422, 'The lesson cites an image that does not exist, or that belongs to an unrelated course.'),
    -- ── Legacy student migration (#67) ──
    ('MEMBERSHIP_SCHEDULED_CONFLICT',409, 'The member has a migrated membership that has not started yet; no other term can be added beside it.'),
    ('ACCESS_REQUEST_IMPORT_TARGET', 409, 'The account is a migrated student still being set up; it is managed in Student Imports.'),
    ('LEGACY_JOB_NOT_FOUND',         404, 'The migration job does not exist.'),
    ('LEGACY_JOB_BUSY',              409, 'The migration job was discarded, or an activation is still running on it.'),
    ('LEGACY_JOB_SETTINGS_DIFFER',   409, 'The same roster is already staged with a different date format, mapping or eligible cohorts.'),
    ('LEGACY_TERMS_INVALID',         422, 'The membership terms chosen for activation are incomplete, inconsistent or already ended.'),
    ('LEGACY_STAGE_INVALID',         422, 'The roster, the request or its reason is incomplete or malformed.'),
    ('LEGACY_ROW_NOT_READY',         409, 'The row is not in a state that allows this action.'),
    ('LEGACY_CONFIRMATION_MISMATCH', 422, 'The typed confirmation does not match the number of rows being activated.'),
    ('LEGACY_RUN_NOT_FOUND',         404, 'The activation run does not exist.'),
    ('LEGACY_RUN_BUSY',              409, 'Another window is working this activation, or the rows are in an unfinished one.'),
    ('LEGACY_IDENTITY_MISMATCH',     409, 'The account found does not match the row''s email or Thinkific id.'),
    ('LEGACY_REVERT_REFUSED',        409, 'The activation cannot be reverted here; the student has started using it.'),
    -- ── Legacy migration, round 2 (#68) ──
    ('LEGACY_BATCH_GAP',             409, 'A month inside a cohort run has no batch while a later batch exists, so the run would skip it for good.'),
    -- ── Getting Started onboarding video (#69) ──
    ('ONBOARDING_VIDEO_NOT_FOUND',   404, 'The Getting Started video version does not exist.'),
    ('ONBOARDING_VIDEO_UNAVAILABLE', 409, 'No Getting Started video is live, or its file is missing from storage.'),
    ('ONBOARDING_VIDEO_NOT_ELIGIBLE',403, 'The Getting Started video is for approved members with an active membership.'),
    ('ONBOARDING_VIDEO_NOT_FINISHED',409, 'The current Getting Started video has not been opened, or has not played long enough, to record a completion.'),
    ('ONBOARDING_VIDEO_STATE_INVALID',409, 'The version''s current state does not allow that change.'),
    ('ONBOARDING_VIDEO_MEDIA_INVALID',422, 'The file is not one of this draft''s uploads, is missing from storage, or its size, type or length is invalid.'),
    ('ONBOARDING_VIDEO_REPLACE_CONFIRM',409, 'Another version is live; publishing this one replaces it, so it needs confirmation.'),
    ('ONBOARDING_VIDEO_TEXT_INVALID',422, 'The title needs 1 to 120 characters, the description at most 600 and the transcript at most 20,000.')
  ) as t(code, http, summary);
$cat$;


-- == 10) Grants and close-out =================================================
-- ★ THREE CLASSES, LISTED SEPARATELY, because they fail in opposite directions. A new function
--   starts with Supabase's default EXECUTE for anon and authenticated, so every revoke here is
--   load-bearing.

-- (a) Client RPCs. Each derives its subject from auth.uid() and gates itself: the student RPCs
--     on approval and enrolment, the admin RPCs on onboarding.manage, the decision facts on
--     enrollments.review.
revoke all on function public.my_onboarding_video() from public, anon;
grant execute on function public.my_onboarding_video() to authenticated;
revoke all on function public.start_onboarding_video() from public, anon;
grant execute on function public.start_onboarding_video() to authenticated;
revoke all on function public.complete_onboarding_video() from public, anon;
grant execute on function public.complete_onboarding_video() to authenticated;
revoke all on function public.report_onboarding_video_problem(text) from public, anon;
grant execute on function public.report_onboarding_video_problem(text) to authenticated;
revoke all on function public.admin_onboarding_video_overview() from public, anon;
grant execute on function public.admin_onboarding_video_overview() to authenticated;
revoke all on function public.admin_onboarding_video_create_draft(text, text, text) from public, anon;
grant execute on function public.admin_onboarding_video_create_draft(text, text, text) to authenticated;
revoke all on function public.admin_onboarding_video_update_details(uuid, text, text, text) from public, anon;
grant execute on function public.admin_onboarding_video_update_details(uuid, text, text, text) to authenticated;
revoke all on function public.admin_onboarding_video_attach_media(uuid, text, bigint, text, numeric, text) from public, anon;
grant execute on function public.admin_onboarding_video_attach_media(uuid, text, bigint, text, numeric, text) to authenticated;
revoke all on function public.admin_onboarding_video_publish(uuid, boolean, uuid) from public, anon;
grant execute on function public.admin_onboarding_video_publish(uuid, boolean, uuid) to authenticated;
revoke all on function public.admin_onboarding_video_unpublish(uuid) from public, anon;
grant execute on function public.admin_onboarding_video_unpublish(uuid) to authenticated;
revoke all on function public.admin_onboarding_video_delete(uuid) from public, anon;
grant execute on function public.admin_onboarding_video_delete(uuid) to authenticated;
revoke all on function public.enrollment_decision_email_facts(uuid) from public, anon;
grant execute on function public.enrollment_decision_email_facts(uuid) to authenticated;

-- (b) Storage-policy helpers. A policy qual runs AS THE CALLER, so these MUST be executable by
--     authenticated: without the grant every storage.objects statement fails with "permission
--     denied for function", in every bucket, not just this one. The two write-side helpers
--     check onboarding.manage themselves, so the grant is no oracle.
revoke all on function public.onboarding_video_object_readable(text) from public, anon;
grant execute on function public.onboarding_video_object_readable(text) to authenticated;
revoke all on function public.onboarding_video_upload_allowed(text) from public, anon;
grant execute on function public.onboarding_video_upload_allowed(text) to authenticated;
revoke all on function public.onboarding_video_object_is_live(text) from public, anon;
grant execute on function public.onboarding_video_object_is_live(text) to authenticated;

-- (c) Internal. Called only from SECURITY DEFINER bodies (which run as the owner) or as a
--     trigger, so no client role may execute them. user_onboarding_video_state() answers about
--     ANY user.
revoke all on function public.onboarding_video_path_version_id(text) from public, anon, authenticated;
revoke all on function public.user_onboarding_video_state(uuid) from public, anon, authenticated;
revoke all on function public.onboarding_videos_guard() from public, anon, authenticated;
revoke all on function public.onboarding_video_events_guard() from public, anon, authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-30-getting-started-video.sql', null,
  'getting started onboarding video (#69): versioned private onboarding video, per-student per-version completion, onboarding.manage (23 permissions / 35 grants), decision email facts, 141 error codes')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The permission and the catalog:
--      select count(*) from public.staff_permissions;                        -> 23
--      select count(*) from public.staff_role_permissions;                   -> 35
--      select role_key from public.staff_role_permissions
--       where permission_key = 'onboarding.manage';                          -> super_admin (only)
--      select count(*) from public.app_error_catalog();                      -> 141
--
-- 2) The bucket is private, with the lesson-video limits:
--      select public, file_size_limit, allowed_mime_types
--        from storage.buckets where id = 'onboarding-videos';
--        -> f | 2147483648 | {video/mp4,video/quicktime}
--    A bucket limit is a ceiling, not a grant: Supabase enforces min(bucket, project-wide), and
--    the project-wide limit is in no SQL. `npm run storage:config` reports both.
--
-- 3) One SELECT policy per table, four storage policies:
--      select tablename, cmd from pg_policies
--       where schemaname = 'public'
--         and tablename in ('onboarding_videos', 'student_onboarding_progress', 'onboarding_video_events');
--        -> three rows, all SELECT
--      select policyname, cmd from pg_policies
--       where schemaname = 'storage' and policyname like 'onboarding_videos_object_%';
--        -> read SELECT, insert INSERT, update UPDATE, delete DELETE
--
-- 4) The three ACL classes:
--      select has_function_privilege('authenticated', 'public.onboarding_video_object_readable(text)', 'execute');  -> t
--      select has_function_privilege('authenticated', 'public.user_onboarding_video_state(uuid)', 'execute');      -> f
--      select has_function_privilege('anon', 'public.my_onboarding_video()', 'execute');                           -> f
--    …and publish has ONE signature, the three-argument one (an overload makes every call ambiguous):
--      select p.oid::regprocedure from pg_proc p
--       where p.proname = 'admin_onboarding_video_publish';    -> admin_onboarding_video_publish(uuid,boolean,uuid), one row
--
-- 5) Nothing is live, so nobody is asked to watch until a Super Admin publishes a version:
--      select count(*) from public.onboarding_videos where status = 'published';   -> 0
--
-- RECOVERY — to stop asking students at once: Getting Started Video → Unpublish
-- (admin_onboarding_video_unpublish). Nobody is gated while nothing is live, and nothing a
-- student has already finished is lost.
