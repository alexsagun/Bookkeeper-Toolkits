-- ---------------------------------------------------------------------------
-- 2026-09-01-student-progress-rankings.sql  (#52)
-- ---------------------------------------------------------------------------
-- Production learning-progress analytics and privacy-safe leaderboards.
--
-- Current scores are calculated from canonical completion records. Daily rows
-- are historical snapshots only; they never delay a newly completed milestone.
-- Public RPCs expose no user id, email, full name, payment data, or hidden user.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ---------------------------------------------------------------------------


-- == 0) Preflight ============================================================
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.lesson_progress') is null
     or to_regclass('public.course_completions') is null then
    raise exception 'Run the course-platform migrations before #52.';
  end if;
  if to_regclass('public.batch_entitlements') is null
     or to_regprocedure('public.user_entitled_batches(uuid)') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) before #52.';
  end if;
  if to_regclass('public.staff_permissions') is null
     or to_regprocedure('public.has_staff_permission(text)') is null then
    raise exception 'Run db/2026-08-25-staff-authorization.sql (#45) before #52.';
  end if;
  if not exists (
    select 1 from public.schema_migrations
     where filename = '2026-08-31-access-request-staff-target.sql'
  ) then
    raise exception 'Run db/2026-08-31-access-request-staff-target.sql (#51) before #52.';
  end if;
end
$pre$;


-- == 1) Staff capability =====================================================
insert into public.staff_roles (key, label, rank, is_protected, description) values
  ('super_admin',      'Super Admin',      100, true,  'Complete product authority, including staff management and the audit trail.'),
  ('operations_admin', 'Operations Admin',  50, false, 'Reviews access requests and payment proofs, grants courses, and runs batches and imports.'),
  ('trainer',          'Trainer',           20, false, 'Creates courses and edits the ones assigned to them. No access to payments or students.')
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
  ('students.import',          'Students',  'Import students',                 'Run the Thinkific migration wizard and issue invitations.'),
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
  ('payment_settings.manage',  'Settings',  'Edit payment settings',           'Change the manual-payment instructions and the notification address.')
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
  ('super_admin', 'students.import'),
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
  ('operations_admin', 'access_requests.review'),
  ('operations_admin', 'enrollments.review'),
  ('operations_admin', 'students.assign_courses'),
  ('operations_admin', 'students.import'),
  ('operations_admin', 'batches.manage'),
  ('operations_admin', 'student_progress.read'),
  ('trainer', 'courses.create'),
  ('trainer', 'courses.manage_assigned'),
  ('trainer', 'course_trainer.manage')
on conflict do nothing;


-- == 2) Durable foundation milestones, privacy preference and snapshots ======
create table if not exists public.student_progress_milestones (
  key         text primary key,
  track_key   text not null check (track_key in ('foundation')),
  title       text not null,
  position    integer not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (track_key, position)
);

insert into public.student_progress_milestones (key, track_key, title, position) values
  ('accounting-101-module-01', 'foundation', 'The Accounting Equation & Double-Entry', 1),
  ('accounting-101-module-02', 'foundation', 'The 5 Account Types + Normal Balances', 2),
  ('accounting-101-module-03', 'foundation', 'The Bookkeeping Cycle', 3),
  ('accounting-101-module-04', 'foundation', 'Cash Basis vs Accrual Basis', 4),
  ('accounting-101-module-05', 'foundation', 'Reading a P&L and Balance Sheet', 5),
  ('accounting-101-module-06', 'foundation', 'Bank Reconciliation Fundamentals', 6),
  ('accounting-101-module-07', 'foundation', 'Common Beginner Mistakes', 7),
  ('accounting-101-module-08', 'foundation', 'Month-End Close Checklist', 8)
on conflict (key) do update
  set title = excluded.title,
      position = excluded.position,
      active = true,
      updated_at = now();

-- ★ UN-COMPLETING KEEPS THE ROW. `completed` is a flag, not row existence, and
--   `completed_at` is the FIRST completion and is never rewritten. Deleting on
--   un-complete and re-inserting on re-complete would let any client reset its own
--   recency at will: drive the score down, drive it back up, and land a brand new
--   completed_at. That forges "recent milestones", games the Most Improved window
--   and resets the staff report's 14-day inactivity signal -- the same forgery the
--   validated lesson-completion path in section 3 exists to prevent.
create table if not exists public.student_foundation_completions (
  user_id       uuid not null references auth.users(id) on delete cascade,
  milestone_key text not null references public.student_progress_milestones(key) on delete restrict,
  completed     boolean not null default true,
  completed_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, milestone_key)
);
alter table public.student_foundation_completions
  add column if not exists completed boolean not null default true;
create index if not exists student_foundation_completions_completed_idx
  on public.student_foundation_completions (user_id, completed_at desc) where completed;

create table if not exists public.student_ranking_preferences (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  public_visible  boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.student_progress_daily (
  user_id               uuid not null references auth.users(id) on delete cascade,
  snapshot_date         date not null,
  overall_score         numeric(5,2) not null check (overall_score between 0 and 100),
  track_scores          jsonb not null default '{}'::jsonb,
  track_counts          jsonb not null default '{}'::jsonb,
  completed_milestones  integer not null default 0 check (completed_milestones >= 0),
  total_milestones      integer not null default 0 check (total_milestones >= 0),
  last_milestone_at     timestamptz,
  plan_scope            text not null,
  batch_id              uuid,
  batch_code            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);
create index if not exists student_progress_daily_date_score_idx
  on public.student_progress_daily (snapshot_date desc, overall_score desc, completed_milestones desc);
create index if not exists student_progress_daily_user_date_idx
  on public.student_progress_daily (user_id, snapshot_date desc);
create index if not exists student_progress_daily_batch_date_idx
  on public.student_progress_daily (batch_id, snapshot_date desc) where batch_id is not null;

alter table public.student_progress_milestones enable row level security;
alter table public.student_foundation_completions enable row level security;
alter table public.student_ranking_preferences enable row level security;
alter table public.student_progress_daily enable row level security;

drop policy if exists student_progress_milestones_read on public.student_progress_milestones;
create policy student_progress_milestones_read on public.student_progress_milestones
  for select to authenticated
  using (active and (select public.is_approved()) and (select public.is_enrolled()));

drop policy if exists student_foundation_completions_own_read on public.student_foundation_completions;
create policy student_foundation_completions_own_read on public.student_foundation_completions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists student_ranking_preferences_own_read on public.student_ranking_preferences;
create policy student_ranking_preferences_own_read on public.student_ranking_preferences
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on table public.student_progress_milestones from public, anon, authenticated;
revoke all on table public.student_foundation_completions from public, anon, authenticated;
revoke all on table public.student_ranking_preferences from public, anon, authenticated;
revoke all on table public.student_progress_daily from public, anon, authenticated;
grant select on table public.student_progress_milestones to authenticated;
grant select on table public.student_foundation_completions to authenticated;
grant select on table public.student_ranking_preferences to authenticated;


-- == 3) Canonical lesson integrity and validated completion write ============
-- Existing test rows whose lesson exists can be repaired without guessing.
update public.lesson_progress lp
   set course_id = l.course_id
  from public.course_lessons l
 where l.id = lp.lesson_id
   and lp.course_id is distinct from l.course_id;

create unique index if not exists course_lessons_id_course_uidx
  on public.course_lessons (id, course_id);

do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.lesson_progress'::regclass
       and conname = 'lesson_progress_lesson_course_fkey'
  ) then
    alter table public.lesson_progress
      add constraint lesson_progress_lesson_course_fkey
      foreign key (lesson_id, course_id)
      references public.course_lessons(id, course_id)
      on delete cascade;
  end if;
end
$constraint$;

drop policy if exists progress_own on public.lesson_progress;
drop policy if exists progress_own_read on public.lesson_progress;
create policy progress_own_read on public.lesson_progress
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists completions_own on public.course_completions;
drop policy if exists completions_own_read on public.course_completions;
create policy completions_own_read on public.course_completions
  for select to authenticated using (user_id = (select auth.uid()));

revoke insert, update, delete on table public.lesson_progress from public, anon, authenticated;
revoke insert, update, delete on table public.course_completions from public, anon, authenticated;
grant select on table public.lesson_progress to authenticated;
grant select on table public.course_completions to authenticated;

create or replace function public.complete_course_lesson(p_lesson_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid              uuid := (select auth.uid());
  v_lesson           record;
  v_plan              text;
  v_total             integer;
  v_completed         integer;
  v_course_completed  timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to save lesson progress.';
  end if;
  if not public.user_is_approved(v_uid) or not public.user_is_enrolled(v_uid) then
    raise exception using errcode = '42501', message = 'An active approved enrollment is required.';
  end if;

  select l.id, l.course_id, c.slug, c.access_tier, c.published
    into v_lesson
    from public.course_lessons l
    join public.courses c on c.id = l.course_id
   where l.id = p_lesson_id;

  if v_lesson.id is null or not v_lesson.published then
    raise exception using errcode = '42501', message = 'That lesson is unavailable.';
  end if;

  select coalesce(public.user_plan_key(v_uid), nullif(p.plan, 'free'), 'legacy')
    into v_plan from public.profiles p where p.id = v_uid;

  if v_plan = 'sampler'
     and not (v_lesson.slug like 'qbo-%' and v_lesson.access_tier = 'essentials') then
    raise exception using errcode = '42501', message = 'That lesson is outside your plan.';
  end if;

  insert into public.lesson_progress (user_id, lesson_id, course_id, completed_at)
  values (v_uid, v_lesson.id, v_lesson.course_id, now())
  on conflict (user_id, lesson_id) do nothing;

  select count(*)::integer into v_total
    from public.course_lessons l where l.course_id = v_lesson.course_id;
  select count(*)::integer into v_completed
    from public.lesson_progress lp
    join public.course_lessons l
      on l.id = lp.lesson_id and l.course_id = lp.course_id
   where lp.user_id = v_uid and l.course_id = v_lesson.course_id;

  if v_total > 0 and v_completed = v_total then
    insert into public.course_completions (user_id, course_id, completed_at)
    values (v_uid, v_lesson.course_id, now())
    on conflict (user_id, course_id) do nothing;
  end if;

  select completed_at into v_course_completed
    from public.course_completions
   where user_id = v_uid and course_id = v_lesson.course_id;

  return jsonb_build_object(
    'ok', true,
    'lesson_id', v_lesson.id,
    'course_id', v_lesson.course_id,
    'completed_lessons', v_completed,
    'total_lessons', v_total,
    'course_completed_at', v_course_completed
  );
end
$fn$;

revoke all on function public.complete_course_lesson(uuid) from public, anon, authenticated;
grant execute on function public.complete_course_lesson(uuid) to authenticated;


-- == 4) Self-scoped preference and foundation writers =======================
create or replace function public.set_leaderboard_visibility(p_visible boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to change leaderboard visibility.';
  end if;
  insert into public.student_ranking_preferences (user_id, public_visible, updated_at)
  values (v_uid, coalesce(p_visible, false), now())
  on conflict (user_id) do update
    set public_visible = excluded.public_visible,
        updated_at = now();
  return coalesce(p_visible, false);
end
$fn$;

revoke all on function public.set_leaderboard_visibility(boolean) from public, anon, authenticated;
grant execute on function public.set_leaderboard_visibility(boolean) to authenticated;

create or replace function public.set_foundation_milestone(
  p_milestone_key text,
  p_completed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_plan text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to save course progress.';
  end if;
  if not public.user_is_approved(v_uid) or not public.user_is_enrolled(v_uid) then
    raise exception using errcode = '42501', message = 'An active approved enrollment is required.';
  end if;

  select coalesce(public.user_plan_key(v_uid), nullif(p.plan, 'free'), 'legacy')
    into v_plan from public.profiles p where p.id = v_uid;
  if v_plan = 'sampler' then
    raise exception using errcode = '42501', message = 'Accounting Foundations is outside your plan.';
  end if;
  if not exists (
    select 1 from public.student_progress_milestones m
     where m.key = p_milestone_key and m.track_key = 'foundation' and m.active
  ) then
    raise exception using errcode = '22023', message = 'Unknown Accounting Foundations milestone.';
  end if;

  -- ★ completed_at is the FIRST completion and is deliberately absent from both
  --   write paths below, so a re-complete cannot mint a fresh timestamp and an
  --   un-complete cannot destroy the original. Only `completed` moves.
  if coalesce(p_completed, false) then
    insert into public.student_foundation_completions
      (user_id, milestone_key, completed, completed_at, updated_at)
    values (v_uid, p_milestone_key, true, now(), now())
    on conflict (user_id, milestone_key) do update
      set completed  = true,
          updated_at = now();
  else
    update public.student_foundation_completions
       set completed  = false,
           updated_at = now()
     where user_id = v_uid and milestone_key = p_milestone_key;
  end if;

  return jsonb_build_object(
    'ok', true,
    'milestone_key', p_milestone_key,
    'completed', coalesce(p_completed, false)
  );
end
$fn$;

revoke all on function public.set_foundation_milestone(text, boolean) from public, anon, authenticated;
grant execute on function public.set_foundation_milestone(text, boolean) to authenticated;

-- The mock-interview guide contributes one milestone, so its completion can no
-- longer remain a freely writable client row. The server derives the current
-- video version and rejects inactive, unknown or plan-inaccessible guides.
drop policy if exists fvc_insert_own on public.feature_video_completions;
drop policy if exists fvc_update_own on public.feature_video_completions;
revoke insert, update, delete on table public.feature_video_completions from public, anon, authenticated;
grant select on table public.feature_video_completions to authenticated;

create or replace function public.complete_progress_feature_guide(p_feature_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_version text;
  v_plan    text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to save guide progress.';
  end if;
  if not public.user_is_approved(v_uid) or not public.user_is_enrolled(v_uid) then
    raise exception using errcode = '42501', message = 'An active approved enrollment is required.';
  end if;
  if p_feature_key is distinct from 'mock_interview_simulator' then
    raise exception using errcode = '22023', message = 'Unknown progress guide.';
  end if;

  select nullif(coalesce(g.video_path, g.video_url), '')
    into v_version
    from public.feature_guides g
   where g.feature_key = p_feature_key and g.is_active;
  if v_version is null then
    raise exception using errcode = '42501', message = 'That guide is unavailable.';
  end if;

  select coalesce(public.user_plan_key(v_uid), nullif(p.plan, 'free'), 'legacy')
    into v_plan from public.profiles p where p.id = v_uid;
  if v_plan = 'sampler' then
    raise exception using errcode = '42501', message = 'That guide is outside your plan.';
  end if;

  insert into public.feature_video_completions
    (user_id, feature_key, video_version, completed, completed_at, updated_at)
  values (v_uid, p_feature_key, v_version, true, now(), now())
  on conflict (user_id, feature_key) do update
    set video_version = excluded.video_version,
        completed = true,
        completed_at = now(),
        updated_at = now();

  return jsonb_build_object('ok', true, 'feature_key', p_feature_key, 'completed', true);
end
$fn$;

revoke all on function public.complete_progress_feature_guide(text) from public, anon, authenticated;
grant execute on function public.complete_progress_feature_guide(text) to authenticated;


-- == 5) Set-based current progress engine ===================================
create or replace function public.student_progress_current(p_user uuid default null)
returns table (
  user_id                 uuid,
  plan_key                text,
  batch_id                uuid,
  batch_code              text,
  enrollment_started_at   timestamptz,
  overall_score           numeric,
  foundation_score        numeric,
  qbo_score               numeric,
  profile_score           numeric,
  interview_score         numeric,
  foundation_completed    integer,
  foundation_total        integer,
  qbo_completed           integer,
  qbo_total               integer,
  profile_completed       integer,
  profile_total           integer,
  interview_completed     integer,
  interview_total         integer,
  completed_milestones    integer,
  total_milestones        integer,
  last_milestone_at       timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with members as (
    select p.id as user_id,
           coalesce(s.plan_key, nullif(p.plan, 'free'), 'legacy') as plan_key,
           coalesce(s.started_at, p.created_at) as enrollment_started_at
      from public.profiles p
      left join lateral (
        select s1.id, s1.plan_key, s1.started_at
          from public.subscriptions s1
         where s1.user_id = p.id
           and s1.status = 'active'
           and (s1.ends_at is null or coalesce(s1.grace_ends_at, s1.ends_at) > now())
         order by s1.created_at desc
         limit 1
      ) s on true
     where (p_user is null or p.id = p_user)
       and public.user_is_approved(p.id)
       and public.user_is_enrolled(p.id)
       -- ★ STAFF ARE NEVER LEARNERS, AND THIS IS THE ONLY PLACE THAT SAYS SO.
       --   Owner rule: "if you are a staff you are a staff, you can not be a staff
       --   and a student learning." Without this predicate a paying student who is
       --   later promoted keeps their subscriptions row -- no staff migration
       --   cancels one -- so s.id is still not null, and they would be scored,
       --   dense-ranked and displayed on the student-facing board, shifting every
       --   real learner down a rank and inflating total_count and the report's
       --   cohort average. user_is_enrolled() also returns true for is_admin
       --   alone, so a legacy admin carrying is_paid would enter through the
       --   second disjunct below.
       --   'invited' + 'active' only, matching #50's access-request queue:
       --   'suspended' and 'revoked' confer no authority and may be real students.
       --   This is the population for student_leaderboard, student_rank_in_scope
       --   AND student_progress_snapshot, so staff are excluded from history too.
       and not exists (
         select 1 from public.staff_memberships sm
          where sm.user_id = p.id
            and sm.status in ('invited', 'active')
       )
       and (
         s.id is not null
         or (p.is_paid and not exists (
           select 1 from public.subscriptions sx where sx.user_id = p.id
         ))
       )
  ),
  batch_context as (
    select m.user_id, chosen.batch_id, chosen.batch_code
      from members m
      left join lateral (
        select eb.batch_id, b.code as batch_code
          from public.user_entitled_batches(m.user_id) eb
          join public.batches b on b.id = eb.batch_id
         where m.plan_key = 'vip'
           and b.status <> 'archived'
           and (now() at time zone b.timezone)::date between b.starts_on and b.ends_on
         order by b.starts_on desc, b.code desc
         limit 1
      ) chosen on true
  ),
  eligible_lessons as (
    select m.user_id,
           l.id as lesson_id,
           l.course_id,
           case
             when c.slug like 'qbo-%' then 'qbo'
             when c.slug like 'resume-%' then 'profile'
             when c.slug like 'interview-%' then 'interview'
           end as track_key
      from members m
      join public.courses c
        on c.published
       and (c.slug like 'qbo-%' or c.slug like 'resume-%' or c.slug like 'interview-%')
       and (m.plan_key <> 'sampler'
            or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
      join public.course_lessons l on l.course_id = c.id
  ),
  course_tracks as (
    select e.user_id, e.track_key,
           count(*)::integer as total,
           count(lp.lesson_id)::integer as completed,
           max(lp.completed_at) as last_completed_at
      from eligible_lessons e
      left join public.lesson_progress lp
        on lp.user_id = e.user_id
       and lp.lesson_id = e.lesson_id
       and lp.course_id = e.course_id
     group by e.user_id, e.track_key
  ),
  foundation as (
    select m.user_id,
           count(cat.key)::integer as total,
           count(fc.milestone_key)::integer as completed,
           max(fc.completed_at) as last_completed_at
      from members m
      left join public.student_progress_milestones cat
        on cat.track_key = 'foundation' and cat.active and m.plan_key <> 'sampler'
      left join public.student_foundation_completions fc
        on fc.user_id = m.user_id and fc.milestone_key = cat.key and fc.completed
     group by m.user_id
  ),
  mock_guide as (
    select m.user_id,
           count(g.feature_key)::integer as total,
           (count(fvc.user_id) filter (
             where fvc.completed
               and fvc.video_version = coalesce(g.video_path, g.video_url)
           ))::integer as completed,
           max(fvc.completed_at) filter (
             where fvc.completed
               and fvc.video_version = coalesce(g.video_path, g.video_url)
           ) as last_completed_at
      from members m
      left join public.feature_guides g
        on g.feature_key = 'mock_interview_simulator'
       and g.is_active
       and nullif(coalesce(g.video_path, g.video_url), '') is not null
       and m.plan_key <> 'sampler'
      left join public.feature_video_completions fvc
        on fvc.user_id = m.user_id and fvc.feature_key = g.feature_key
     group by m.user_id
  ),
  raw as (
    select m.user_id, m.plan_key, bc.batch_id, bc.batch_code, m.enrollment_started_at,
           coalesce(f.completed, 0) as foundation_completed,
           coalesce(f.total, 0) as foundation_total,
           coalesce(q.completed, 0) as qbo_completed,
           coalesce(q.total, 0) as qbo_total,
           coalesce(pr.completed, 0) as profile_completed,
           coalesce(pr.total, 0) as profile_total,
           coalesce(iv.completed, 0) + coalesce(mg.completed, 0) as interview_completed,
           coalesce(iv.total, 0) + coalesce(mg.total, 0) as interview_total,
           greatest(f.last_completed_at, q.last_completed_at, pr.last_completed_at,
                    iv.last_completed_at, mg.last_completed_at) as last_milestone_at
      from members m
      join batch_context bc on bc.user_id = m.user_id
      left join foundation f on f.user_id = m.user_id
      left join course_tracks q on q.user_id = m.user_id and q.track_key = 'qbo'
      left join course_tracks pr on pr.user_id = m.user_id and pr.track_key = 'profile'
      left join course_tracks iv on iv.user_id = m.user_id and iv.track_key = 'interview'
      left join mock_guide mg on mg.user_id = m.user_id
  ),
  scored as (
    select r.*,
           case when r.foundation_total > 0 then round(100.0 * r.foundation_completed / r.foundation_total, 2) else 0 end as foundation_score,
           case when r.qbo_total > 0 then round(100.0 * r.qbo_completed / r.qbo_total, 2) else 0 end as qbo_score,
           case when r.profile_total > 0 then round(100.0 * r.profile_completed / r.profile_total, 2) else 0 end as profile_score,
           case when r.interview_total > 0 then round(100.0 * r.interview_completed / r.interview_total, 2) else 0 end as interview_score
      from raw r
  )
  select s.user_id, s.plan_key, s.batch_id, s.batch_code, s.enrollment_started_at,
         coalesce(round((
           case when s.foundation_total > 0 then s.foundation_score * 20 else 0 end
           + case when s.qbo_total > 0 then s.qbo_score * 40 else 0 end
           + case when s.profile_total > 0 then s.profile_score * 20 else 0 end
           + case when s.interview_total > 0 then s.interview_score * 20 else 0 end
         ) / nullif(
           (case when s.foundation_total > 0 then 20 else 0 end
            + case when s.qbo_total > 0 then 40 else 0 end
            + case when s.profile_total > 0 then 20 else 0 end
            + case when s.interview_total > 0 then 20 else 0 end), 0
         ), 2), 0)::numeric as overall_score,
         s.foundation_score::numeric, s.qbo_score::numeric,
         s.profile_score::numeric, s.interview_score::numeric,
         s.foundation_completed, s.foundation_total,
         s.qbo_completed, s.qbo_total,
         s.profile_completed, s.profile_total,
         s.interview_completed, s.interview_total,
         (s.foundation_completed + s.qbo_completed + s.profile_completed + s.interview_completed)::integer,
         (s.foundation_total + s.qbo_total + s.profile_total + s.interview_total)::integer,
         s.last_milestone_at
    from scored s;
$fn$;

comment on function public.student_progress_current(uuid) is
  '#52 INTERNAL: set-based live progress calculated from canonical lesson/course joins, '
  'durable Accounting 101 milestones and the current mock-guide version. Revoked from clients.';
revoke all on function public.student_progress_current(uuid) from public, anon, authenticated;


-- == 6) Exact private rank and personal dashboard ============================
create or replace function public.student_rank_in_scope(p_user uuid, p_scope text)
returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_target record;
  v_rank bigint;
begin
  if coalesce((select pref.public_visible from public.student_ranking_preferences pref
                where pref.user_id = p_user), true) = false then
    return null;
  end if;

  select * into v_target from public.student_progress_current(p_user);
  if v_target.user_id is null then return null; end if;
  if p_scope not in ('my_plan', 'general', 'vip', 'my_batch', 'all') then return null; end if;
  if p_scope = 'my_batch' and v_target.batch_id is null then return null; end if;

  select 1 + count(distinct (c.overall_score, c.completed_milestones))
    into v_rank
    from public.student_progress_current(null) c
    left join public.student_ranking_preferences pref on pref.user_id = c.user_id
   where coalesce(pref.public_visible, true)
     and case p_scope
       when 'my_plan' then c.plan_key = v_target.plan_key
       when 'general' then c.plan_key <> 'vip'
       when 'vip' then c.plan_key = 'vip'
       when 'my_batch' then c.batch_id = v_target.batch_id
       else true
     end
     and (c.overall_score > v_target.overall_score
       or (c.overall_score = v_target.overall_score
           and c.completed_milestones > v_target.completed_milestones));
  return v_rank;
end
$fn$;

revoke all on function public.student_rank_in_scope(uuid, text) from public, anon, authenticated;

create or replace function public.my_student_progress()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_progress       record;
  v_visible        boolean;
  v_default_scope  text;
  v_prior_score    numeric;
  v_recent         jsonb;
  v_trend          jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to view progress.';
  end if;
  select * into v_progress from public.student_progress_current(v_uid);
  if v_progress.user_id is null then
    raise exception using errcode = '42501', message = 'An active approved student enrollment is required.';
  end if;

  select coalesce(pref.public_visible, true) into v_visible
    from (select 1) seed
    left join public.student_ranking_preferences pref on pref.user_id = v_uid;
  v_default_scope := case
    when v_progress.plan_key = 'vip' and v_progress.batch_id is not null then 'my_batch'
    when v_progress.plan_key = 'vip' then 'vip'
    else 'my_plan'
  end;

  -- ★ NULL means "no baseline yet", NEVER zero. A learner with no snapshot from
  --   7+ days ago has not been measured over a week, and reporting that as a 0.0
  --   gain is a fabricated number: for the first seven days after this migration
  --   NOBODY has a qualifying snapshot, so every learner would read "0.0 pts".
  --   The floor keeps a stale snapshot from masquerading as a week: if the daily
  --   job has been down, the newest qualifying row could be months old and its
  --   delta is not a 7-day gain. Outside [7, 14] days we say so instead.
  select d.overall_score into v_prior_score
    from public.student_progress_daily d
   where d.user_id = v_uid
     and d.snapshot_date <= current_date - 7
     and d.snapshot_date >= current_date - 14
   order by d.snapshot_date desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'track', recent.track_key,
           'title', recent.title,
           'completed_at', recent.completed_at
         ) order by recent.completed_at desc), '[]'::jsonb)
    into v_recent
    from (
      select 'foundation'::text as track_key, m.title, fc.completed_at
        from public.student_foundation_completions fc
        join public.student_progress_milestones m on m.key = fc.milestone_key
       where fc.user_id = v_uid and fc.completed
      union all
      select case
               when c.slug like 'qbo-%' then 'qbo'
               when c.slug like 'resume-%' then 'profile'
               when c.slug like 'interview-%' then 'interview'
             end,
             l.title, lp.completed_at
        from public.lesson_progress lp
        join public.course_lessons l
          on l.id = lp.lesson_id and l.course_id = lp.course_id
        join public.courses c on c.id = l.course_id
       where lp.user_id = v_uid
         and (c.slug like 'qbo-%' or c.slug like 'resume-%' or c.slug like 'interview-%')
      union all
      select 'interview', coalesce(g.title, 'Mock Interview Guide'), fvc.completed_at
        from public.feature_video_completions fvc
        join public.feature_guides g on g.feature_key = fvc.feature_key
       where fvc.user_id = v_uid
         and fvc.feature_key = 'mock_interview_simulator'
         and fvc.completed
         and fvc.video_version = coalesce(g.video_path, g.video_url)
      order by completed_at desc
      limit 5
    ) recent;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', trend.snapshot_date,
           'score', trend.overall_score
         ) order by trend.snapshot_date), '[]'::jsonb)
    into v_trend
    from (
      select d.snapshot_date, d.overall_score
        from public.student_progress_daily d
       where d.user_id = v_uid
         and d.snapshot_date between current_date - 7 and current_date - 1
      union all
      select current_date, v_progress.overall_score
    ) trend;

  return jsonb_build_object(
    'overall_score', v_progress.overall_score,
    'completed_milestones', v_progress.completed_milestones,
    'total_milestones', v_progress.total_milestones,
    'last_milestone_at', v_progress.last_milestone_at,
    'weekly_gain', case when v_prior_score is null then null
                        else round(v_progress.overall_score - v_prior_score, 2) end,
    'plan_key', v_progress.plan_key,
    'batch_id', v_progress.batch_id,
    'batch_code', v_progress.batch_code,
    'default_scope', v_default_scope,
    'private_rank', case when v_visible then public.student_rank_in_scope(v_uid, v_default_scope) else null end,
    'public_visible', v_visible,
    -- ★ in_plan is a PLAN statement; total is a CONTENT statement. The client used
    --   to derive "not in your plan" from total = 0, so a full-access member was told
    --   a track they paid for was outside their plan whenever nothing was published in
    --   it yet. Only Accounting Foundations is genuinely plan-scoped (sampler cannot
    --   open that tab); the three course tracks are in every plan, and a sampler simply
    --   sees the Essentials subset of QuickBooks.
    'tracks', jsonb_build_object(
      'foundation', jsonb_build_object('score', v_progress.foundation_score, 'completed', v_progress.foundation_completed, 'total', v_progress.foundation_total, 'in_plan', v_progress.plan_key <> 'sampler'),
      'qbo', jsonb_build_object('score', v_progress.qbo_score, 'completed', v_progress.qbo_completed, 'total', v_progress.qbo_total, 'in_plan', true),
      'profile', jsonb_build_object('score', v_progress.profile_score, 'completed', v_progress.profile_completed, 'total', v_progress.profile_total, 'in_plan', v_progress.plan_key <> 'sampler'),
      'interview', jsonb_build_object('score', v_progress.interview_score, 'completed', v_progress.interview_completed, 'total', v_progress.interview_total, 'in_plan', v_progress.plan_key <> 'sampler')
    ),
    'recent_milestones', v_recent,
    'daily_trend', v_trend
  );
end
$fn$;

revoke all on function public.my_student_progress() from public, anon, authenticated;
grant execute on function public.my_student_progress() to authenticated;


-- == 7) Privacy-safe bounded leaderboard ====================================
create or replace function public.student_leaderboard(
  p_scope text default 'my_plan',
  p_batch_id uuid default null,
  p_window text default 'overall',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  rank                   bigint,
  learner_label          text,
  initials               text,
  overall_score          numeric,
  completed_milestones   integer,
  total_milestones       integer,
  weekly_gain            numeric,
  foundation_score       numeric,
  qbo_score              numeric,
  profile_score          numeric,
  interview_score        numeric,
  is_current_user        boolean,
  total_count            bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_scope     text := lower(coalesce(p_scope, 'my_plan'));
  v_window    text := lower(coalesce(p_window, 'overall'));
  v_limit     integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset    integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  v_caller    record;
  v_is_staff  boolean;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to view rankings.';
  end if;
  if v_scope not in ('my_plan', 'general', 'vip', 'my_batch', 'all') then
    raise exception using errcode = '22023', message = 'Unknown leaderboard scope.';
  end if;
  if v_window not in ('overall', 'week') then
    raise exception using errcode = '22023', message = 'Unknown leaderboard window.';
  end if;

  select * into v_caller from public.student_progress_current(v_uid);
  select exists (
    select 1 from public.staff_memberships m
     where m.user_id = v_uid and m.status = 'active'
  ) into v_is_staff;
  if v_caller.user_id is null and not v_is_staff then
    raise exception using errcode = '42501', message = 'An active student or staff account is required.';
  end if;
  if v_scope = 'my_plan' and v_caller.user_id is null then
    v_scope := 'all';
  end if;
  if v_scope = 'my_batch' then
    if v_caller.user_id is null or v_caller.plan_key <> 'vip' or v_caller.batch_id is null
       or (p_batch_id is not null and p_batch_id <> v_caller.batch_id) then
      raise exception using errcode = '42501', message = 'That batch leaderboard is unavailable.';
    end if;
  elsif p_batch_id is not null then
    raise exception using errcode = '22023', message = 'A batch id is valid only with my_batch.';
  end if;

  return query
  with candidates as (
    select c.*,
           -- ★ NULL means "no baseline yet", never zero. See my_student_progress().
           case when prior.overall_score is null then null
                else round(c.overall_score - prior.overall_score, 2) end as weekly_gain,
           p.full_name,
           md5(c.user_id::text) as stable_key
      from public.student_progress_current(null) c
      join public.profiles p on p.id = c.user_id
      left join public.student_ranking_preferences pref on pref.user_id = c.user_id
      left join lateral (
        select d.overall_score
          from public.student_progress_daily d
         where d.user_id = c.user_id
           and d.snapshot_date <= current_date - 7
           and d.snapshot_date >= current_date - 14
         order by d.snapshot_date desc limit 1
      ) prior on true
     where coalesce(pref.public_visible, true)
       -- ★ Most Improved ranks MEASURED movement. A learner with no baseline is
       --   excluded rather than entered at a fabricated 0.00, which would make the
       --   week board a mislabelled copy of the overall board for the first seven
       --   days after this migration, when nobody has a qualifying snapshot.
       and (v_window <> 'week' or prior.overall_score is not null)
       and case v_scope
         when 'my_plan' then c.plan_key = v_caller.plan_key
         when 'general' then c.plan_key <> 'vip'
         when 'vip' then c.plan_key = 'vip'
         when 'my_batch' then c.batch_id = v_caller.batch_id
         else true
       end
  ),
  identities as (
    select c.*,
           case
             when nullif(btrim(c.full_name), '') is null or c.full_name like '%@%'
               then 'Learner ' || lpad(abs(hashtextextended(c.user_id::text, 0) % 10000)::text, 4, '0')
             when array_length(regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'), 1) = 1
               then (regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'))[1]
             else (regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'))[1] || ' ' ||
                  upper(left((regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'))[
                    array_length(regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'), 1)
                  ], 1)) || '.'
           end as public_label
      from candidates c
  ),
  ranked as (
    select i.*,
           dense_rank() over (order by
             case when v_window = 'week' then i.weekly_gain else i.overall_score end desc,
             case when v_window = 'week' then i.overall_score else null end desc nulls last,
             i.completed_milestones desc
           ) as public_rank,
           count(*) over () as public_total
      from identities i
  )
  select r.public_rank,
         r.public_label,
         upper(left(r.public_label, 1) || coalesce(substring(r.public_label from ' ([[:alnum:]])[.]$'), '')),
         r.overall_score,
         r.completed_milestones,
         r.total_milestones,
         r.weekly_gain,
         r.foundation_score,
         r.qbo_score,
         r.profile_score,
         r.interview_score,
         r.user_id = v_uid,
         r.public_total
    from ranked r
   order by r.public_rank, r.stable_key
   limit v_limit offset v_offset;
end
$fn$;

revoke all on function public.student_leaderboard(text, uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.student_leaderboard(text, uuid, text, integer, integer)
  to authenticated;


-- == 8) Daily snapshots and bounded retention ===============================
create or replace function public.student_progress_snapshot(p_date date default (now() at time zone 'utc')::date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
begin
  insert into public.student_progress_daily (
    user_id, snapshot_date, overall_score, track_scores, track_counts,
    completed_milestones, total_milestones, last_milestone_at,
    plan_scope, batch_id, batch_code, updated_at
  )
  select c.user_id, p_date, c.overall_score,
         jsonb_build_object(
           'foundation', c.foundation_score,
           'qbo', c.qbo_score,
           'profile', c.profile_score,
           'interview', c.interview_score
         ),
         jsonb_build_object(
           'foundation', jsonb_build_object('completed', c.foundation_completed, 'total', c.foundation_total),
           'qbo', jsonb_build_object('completed', c.qbo_completed, 'total', c.qbo_total),
           'profile', jsonb_build_object('completed', c.profile_completed, 'total', c.profile_total),
           'interview', jsonb_build_object('completed', c.interview_completed, 'total', c.interview_total)
         ),
         c.completed_milestones, c.total_milestones, c.last_milestone_at,
         c.plan_key, c.batch_id, c.batch_code, now()
    from public.student_progress_current(null) c
  on conflict (user_id, snapshot_date) do update
    set overall_score = excluded.overall_score,
        track_scores = excluded.track_scores,
        track_counts = excluded.track_counts,
        completed_milestones = excluded.completed_milestones,
        total_milestones = excluded.total_milestones,
        last_milestone_at = excluded.last_milestone_at,
        plan_scope = excluded.plan_scope,
        batch_id = excluded.batch_id,
        batch_code = excluded.batch_code,
        updated_at = now();

  get diagnostics v_count = row_count;
  delete from public.student_progress_daily
   where snapshot_date < p_date - 400;
  return v_count;
end
$fn$;

comment on function public.student_progress_snapshot(date) is
  '#52 INTERNAL: idempotent UTC daily history writer with 400-day retention. Current UI scores never read it as authority.';
revoke all on function public.student_progress_snapshot(date) from public, anon, authenticated;

-- Safe initial snapshot: it reads existing progress and writes only #52's table.
select public.student_progress_snapshot((now() at time zone 'utc')::date);

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule('snapshot-student-progress')
    where exists (select 1 from cron.job j where j.jobname = 'snapshot-student-progress');
  perform cron.schedule(
    'snapshot-student-progress',
    '15 0 * * *',
    $c$select public.student_progress_snapshot((now() at time zone 'utc')::date);$c$
  );
  raise notice '#52: pg_cron job "snapshot-student-progress" scheduled at 00:15 UTC.';
exception when others then
  raise notice '#52: could not schedule pg_cron (%). Enable Dashboard -> Integrations -> Cron, then schedule student_progress_snapshot() at 00:15 UTC.', sqlerrm;
end $$;


-- == 9) Permission-gated staff report =======================================
drop function if exists public.admin_student_progress_report(text, uuid, text, numeric, numeric, integer, boolean, integer, integer);

create or replace function public.admin_student_progress_report(
  p_plan_key text default null,
  p_batch_id uuid default null,
  p_track text default null,
  p_completion_min numeric default null,
  p_completion_max numeric default null,
  p_inactive_days integer default null,
  p_include_inactive boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  user_id                 uuid,
  email                   text,
  full_name               text,
  plan_key                text,
  batch_id                uuid,
  batch_code              text,
  access_status           text,
  overall_score           numeric,
  track_scores            jsonb,
  track_counts            jsonb,
  completed_milestones    integer,
  total_milestones        integer,
  last_milestone_at       timestamptz,
  enrollment_started_at   timestamptz,
  public_visible          boolean,
  needs_attention         boolean,
  cohort_average          numeric,
  completion_distribution jsonb,
  needs_attention_count   bigint,
  total_count             bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 200));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 100000));
begin
  if not public.has_staff_permission('student_progress.read') then
    raise exception using errcode = '42501', message = 'student_progress.read permission required.';
  end if;
  if p_track is not null and p_track not in ('foundation', 'qbo', 'profile', 'interview') then
    raise exception using errcode = '22023', message = 'Unknown progress track.';
  end if;

  return query
  with current_rows as (
    select c.user_id, p.email, p.full_name, c.plan_key, c.batch_id, c.batch_code,
           'active'::text as access_status, c.overall_score,
           jsonb_build_object(
             'foundation', c.foundation_score, 'qbo', c.qbo_score,
             'profile', c.profile_score, 'interview', c.interview_score
           ) as track_scores,
           jsonb_build_object(
             'foundation', jsonb_build_object('completed', c.foundation_completed, 'total', c.foundation_total),
             'qbo', jsonb_build_object('completed', c.qbo_completed, 'total', c.qbo_total),
             'profile', jsonb_build_object('completed', c.profile_completed, 'total', c.profile_total),
             'interview', jsonb_build_object('completed', c.interview_completed, 'total', c.interview_total)
           ) as track_counts,
           c.completed_milestones, c.total_milestones, c.last_milestone_at,
           c.enrollment_started_at,
           coalesce(pref.public_visible, true) as public_visible
      from public.student_progress_current(null) c
      join public.profiles p on p.id = c.user_id
      left join public.student_ranking_preferences pref on pref.user_id = c.user_id
  ),
  historical_rows as (
    select distinct on (d.user_id)
           d.user_id, p.email, p.full_name, d.plan_scope as plan_key,
           d.batch_id, d.batch_code, 'inactive'::text as access_status,
           d.overall_score, d.track_scores, d.track_counts,
           d.completed_milestones, d.total_milestones, d.last_milestone_at,
           s.started_at as enrollment_started_at,
           coalesce(pref.public_visible, true) as public_visible
      from public.student_progress_daily d
      join public.profiles p on p.id = d.user_id
      left join lateral (
        select sx.started_at from public.subscriptions sx
         where sx.user_id = d.user_id order by sx.created_at desc limit 1
      ) s on true
      left join public.student_ranking_preferences pref on pref.user_id = d.user_id
     where p_include_inactive
       and not exists (select 1 from current_rows cr where cr.user_id = d.user_id)
     order by d.user_id, d.snapshot_date desc
  ),
  combined as (
    select * from current_rows
    union all
    select * from historical_rows
  ),
  filtered as (
    select c.*,
           (c.access_status = 'active'
            and c.overall_score < 100
            and coalesce(c.last_milestone_at, c.enrollment_started_at) <= now() - interval '14 days'
            and c.enrollment_started_at <= now() - interval '7 days') as needs_attention
      from combined c
     where (p_plan_key is null or c.plan_key = p_plan_key)
       and (p_batch_id is null or c.batch_id = p_batch_id)
       and (p_completion_min is null or c.overall_score >= p_completion_min)
       and (p_completion_max is null or c.overall_score <= p_completion_max)
       and (p_inactive_days is null
            or coalesce(c.last_milestone_at, c.enrollment_started_at) <= now() - make_interval(days => greatest(0, p_inactive_days)))
       and (p_track is null
            or coalesce((c.track_counts -> p_track ->> 'total')::integer, 0) > 0
               and coalesce((c.track_counts -> p_track ->> 'completed')::integer, 0)
                   < coalesce((c.track_counts -> p_track ->> 'total')::integer, 0))
  )
  select f.user_id, f.email, f.full_name, f.plan_key, f.batch_id, f.batch_code,
         f.access_status, f.overall_score, f.track_scores, f.track_counts,
         f.completed_milestones, f.total_milestones, f.last_milestone_at,
         f.enrollment_started_at, f.public_visible, f.needs_attention,
         round(avg(f.overall_score) over (), 2),
         jsonb_build_object(
           'starting', count(*) filter (where f.overall_score < 25) over (),
           'building', count(*) filter (where f.overall_score >= 25 and f.overall_score < 50) over (),
           'progressing', count(*) filter (where f.overall_score >= 50 and f.overall_score < 75) over (),
           'nearly_complete', count(*) filter (where f.overall_score >= 75 and f.overall_score < 100) over (),
           'complete', count(*) filter (where f.overall_score = 100) over ()
         ),
         count(*) filter (where f.needs_attention) over (),
         count(*) over ()
    from filtered f
   order by f.needs_attention desc, f.overall_score asc, f.full_name nulls last, f.user_id
   limit v_limit offset v_offset;
end
$fn$;

revoke all on function public.admin_student_progress_report(text, uuid, text, numeric, numeric, integer, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_student_progress_report(text, uuid, text, numeric, numeric, integer, boolean, integer, integer)
  to authenticated;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-01-student-progress-rankings.sql', null,
  'student progress and rankings (#52): durable Accounting 101 milestones; canonical validated lesson-completion RPC; privacy preference; live entitlement-normalized scoring; General, VIP, plan and caller-derived batch leaderboards; permission-gated staff report; UTC daily snapshots with 400-day retention; student_progress.read for Super Admin and Operations Admin.')
on conflict (filename) do nothing;
