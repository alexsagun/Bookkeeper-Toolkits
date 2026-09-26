-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-25-legacy-student-migration.sql   (#67)
-- Legacy Thinkific migration: staged records, controlled activation, scheduled terms.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DOES
--   1. A new permission, students.legacy_migrate, held by super_admin ALONE, replaces
--      students.import (which Operations Admin held). Activating a legacy student creates
--      paid access with no payment behind it in this system — the same reason #47 gave
--      students.extend_access to Super Admin only. 22 permissions / 34 grants.
--   2. A subscription can be `scheduled`: a paid term whose start is in the future. Every
--      access predicate already requires status = 'active' (is_enrolled, user_is_enrolled,
--      user_entitled_batches, the community, trainer, progress and communications
--      functions), and the grandfather branch needs ZERO subscription rows — so a
--      scheduled term grants nothing anywhere, with no access function restated. A
--      15-minute pg_cron sweep flips it to active; the student's own screen can too.
--   3. The import tables lose every client write path. Staging, activation, invitations,
--      promotion and reverts go through SECURITY DEFINER functions: the service-only ones
--      are called by api/admin/student-imports.js after requireStaff(), the rest by a
--      Super Admin's own session. Each table keeps exactly one SELECT policy.
--   4. The activation of one row is ONE transaction: the real subscription (source dates,
--      Asia/Manila calendar days, 3-day grace), the batch_entitlements run from the live
--      registry, the profile approval and paid cache, and the audit event. No enrollment
--      request, no receipt, no finance posting: the payment happened before migration and
--      is recorded on the row as history only.
--   5. Access Requests stops listing, and stops accepting decisions on, an imported
--      account that is still pending — it is managed in Student Imports.
--   6. The four v1 jobs that never granted anything are discarded and their raw payloads
--      (student names and emails) purged.
--
-- ★ EVERY RESTATED BODY IS COPIED, NOT RETYPED. grant_batch_run (#39), the three
--   access-request functions (#50/#51), the staff seed (#62) and app_error_catalog (#65)
--   were lifted from their latest files by a script and edited at anchors; the md5 of
--   each source body was compared with live prosrc first. test/legacyMigrationSql.test.mjs
--   line-diffs every one of them against its source.
--
-- Needs #66. Transaction-free (scripts/apply-db-files.mjs sends one statement per call).
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-24-enrollment-decision-lock.sql') then
    raise exception '#67: run db/2026-09-24-enrollment-decision-lock.sql (#66) first.';
  end if;
  -- 132 = a re-run of this file; 130/131 = a shadow project holding an earlier rehearsal draft.
  if (select count(*) from public.app_error_catalog()) not in (119, 130, 131, 132) then
    raise exception '#67: expected the #65 error catalog (119 codes), or 132 on a re-run.';
  end if;
  if to_regprocedure('public.grant_batch_run(uuid,text,uuid,integer,text,uuid,text,uuid,uuid,timestamptz,uuid,boolean)') is null
     or to_regprocedure('public.revoke_batch_run(uuid,uuid,text,uuid,text)') is null
     or to_regprocedure('public.plan_eligible_batch_count(text)') is null
     or to_regprocedure('public.batch_seat_holders(uuid,text)') is null
     or to_regprocedure('public.user_has_staff_permission(uuid,text)') is null then
    raise exception '#67: grant_batch_run / revoke_batch_run / batch_seat_holders (#35-#39), plan_eligible_batch_count (#35) and user_has_staff_permission (#45) are required.';
  end if;
  if to_regclass('public.student_import_rows') is null or to_regclass('public.batch_entitlements') is null then
    raise exception '#67: the #26 import tables and the #35 ledger are required.';
  end if;
  if (select count(*) from public.staff_permissions) not in (22, 23) then
    raise exception '#67: expected 22 staff permissions before this file (23 if an older seed re-added students.import).';
  end if;
end
$pre$;


-- == 1) Staff capability ======================================================
-- ★ All three blocks are restated IN FULL from #62 (test/staffRolesSql.test.mjs diffs the
--   LAST VALUES block against the JS matrix). students.legacy_migrate takes the place and
--   the position of students.import, granted to super_admin ONLY. The old key and its two
--   grants are deleted in section 8, after section 4 has dropped the policies that read it.

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
  ('meetings.manage',          'Meetings',  'Manage meetings and staff tasks', 'Schedule and cancel Zoom meetings, keep meeting templates, invite students, and use the shared staff to-do board.')
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
  ('trainer', 'community.moderate')
on conflict do nothing;


-- == 2) Scheduled terms =======================================================
-- ★ The CHECK is swapped inside ONE statement. Sent as two, a drop that succeeds while
--   the re-add fails leaves subscriptions with no status CHECK at all.
do $chk$
begin
  alter table public.subscriptions drop constraint if exists subscriptions_status_check;
  alter table public.subscriptions add constraint subscriptions_status_check
    check (status in ('active', 'cancelled', 'expired', 'scheduled')) not valid;
end
$chk$;
alter table public.subscriptions validate constraint subscriptions_status_check;

-- A scheduled term is an IMPORT term with a real end. Nothing else may create one: a
-- payment approval starts now, so it has no reason to schedule.
alter table public.subscriptions drop constraint if exists subscriptions_scheduled_shape;
alter table public.subscriptions add constraint subscriptions_scheduled_shape
  check (status <> 'scheduled'
         or (grant_source = 'import' and source_import_row_id is not null and ends_at is not null)) not valid;
alter table public.subscriptions validate constraint subscriptions_scheduled_shape;

-- One current OR upcoming term per member. subscriptions_one_active still holds for
-- active alone; this adds the scheduled half so an approval cannot sit beside it.
create unique index if not exists subscriptions_one_live_or_scheduled
  on public.subscriptions (user_id) where status in ('active', 'scheduled');

-- The index is the backstop; this guard is what an admin reads. Without it, approving a
-- payment for a member with a scheduled migrated term (approve_subscription /
-- approve_extension via admin_finalize_enrollment) fails with a bare 23505.
create or replace function public.subscriptions_scheduled_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.status in ('active', 'scheduled')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and exists (
       select 1 from public.subscriptions s
        where s.user_id = new.user_id
          and s.id <> new.id
          and s.status in ('active', 'scheduled')
          and (s.status = 'scheduled' or new.status = 'scheduled')) then
    perform public.app_error('MEMBERSHIP_SCHEDULED_CONFLICT',
      'This member has a migrated membership that has not started yet, so another term cannot be added beside it. Review it in Student Imports first.',
      409, jsonb_build_object('user_id', new.user_id));
  end if;
  return new;
end;
$fn$;

revoke all on function public.subscriptions_scheduled_guard() from public, anon, authenticated;
drop trigger if exists subscriptions_scheduled_guard on public.subscriptions;
create trigger subscriptions_scheduled_guard
  before insert or update of status on public.subscriptions
  for each row execute function public.subscriptions_scheduled_guard();


-- == 3) Import schema =========================================================
alter table public.student_import_jobs
  add column if not exists pipeline text not null default 'v1',
  add column if not exists content_sha256 text,
  add column if not exists date_format text,
  add column if not exists plan_mapping jsonb not null default '{}'::jsonb,
  add column if not exists batch_mapping jsonb not null default '{}'::jsonb,
  add column if not exists eligible_batch_codes text[] not null default '{}'::text[],
  add column if not exists discarded_at timestamptz,
  add column if not exists discarded_by uuid references public.profiles(id) on delete set null,
  add column if not exists discard_reason text;

alter table public.student_import_jobs drop constraint if exists student_import_jobs_status_check;
alter table public.student_import_jobs add constraint student_import_jobs_status_check
  check (status in ('draft', 'validating', 'dry_run', 'ready', 'processing', 'paused', 'completed', 'failed',
                    'staged', 'discarded'));
alter table public.student_import_jobs drop constraint if exists student_import_jobs_pipeline_check;
alter table public.student_import_jobs add constraint student_import_jobs_pipeline_check
  check (pipeline in ('v1', 'legacy_v2'));
alter table public.student_import_jobs drop constraint if exists student_import_jobs_v2_shape;
alter table public.student_import_jobs add constraint student_import_jobs_v2_shape
  check (pipeline <> 'legacy_v2'
         or (content_sha256 ~ '^[0-9a-f]{64}$' and date_format in ('M/D/YYYY', 'D/M/YYYY', 'YYYY-MM-DD')));
alter table public.student_import_jobs drop constraint if exists student_import_jobs_discard_shape;
alter table public.student_import_jobs add constraint student_import_jobs_discard_shape
  check ((status = 'discarded') = (discarded_at is not null));

-- A second upload of the same content reopens the first job instead of staging twice.
create unique index if not exists student_import_jobs_content_uniq
  on public.student_import_jobs (content_sha256)
  where pipeline = 'legacy_v2' and discarded_at is null;

create table if not exists public.student_import_activation_runs (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.student_import_jobs(id) on delete cascade,
  created_by   uuid references public.profiles(id) on delete set null,
  client_key   text not null check (client_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  row_ids      uuid[] not null check (cardinality(row_ids) between 1 and 200),
  phrase       text not null,
  status       text not null default 'running'
               check (status in ('running', 'paused', 'completed', 'cancelled')),
  lease_owner  text,
  lease_until  timestamptz,
  counts       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (job_id, client_key)
);
create index if not exists student_import_activation_runs_job on public.student_import_activation_runs (job_id, created_at desc);

alter table public.student_import_rows
  add column if not exists validation_status text,
  add column if not exists activation_state text,
  add column if not exists invite_state text,
  add column if not exists legacy_record_key text,
  add column if not exists identity_basis text,
  add column if not exists matched_existing boolean not null default false,
  add column if not exists existing_confirmed boolean not null default false,
  add column if not exists legacy_start_date date,
  add column if not exists legacy_end_date date,
  add column if not exists legacy_plan_label text,
  add column if not exists legacy_batch_label text,
  add column if not exists legacy_payment_status text,
  add column if not exists legacy_amount_paid numeric(14,2),
  add column if not exists legacy_currency text,
  add column if not exists activation_run_id uuid references public.student_import_activation_runs(id) on delete set null,
  add column if not exists activation_claimed_at timestamptz,
  add column if not exists blocked_reason text,
  add column if not exists last_error text,
  add column if not exists subscription_id uuid references public.subscriptions(id) on delete set null,
  add column if not exists entitlement_run_id uuid,
  add column if not exists activated_at timestamptz,
  add column if not exists activated_by uuid references public.profiles(id) on delete set null,
  add column if not exists invite_generation int not null default 0,
  add column if not exists invite_sent_at timestamptz,
  add column if not exists invite_code text,
  -- A phone, when a roster has one: digits only, shown to the Super Admin and used for an
  -- advisory "shared phone" warning. It never links an account — Auth identity is the email.
  add column if not exists legacy_phone text,
  -- ★ THE TERMS THE SUPER ADMIN ASSIGNS AT ACTIVATION. Null means "the roster's value". The
  --   legacy_* columns stay the untouched record of what the roster said; the activation,
  --   the preflight, the rows page and set_eligibility all read coalesce(activation_*, roster)
  --   inline, and the SQL suite pins every site.
  add column if not exists activation_plan_key text references public.enrollment_plans(key) on delete set null,
  add column if not exists activation_batch_id uuid references public.batches(id) on delete set null,
  add column if not exists activation_start_date date,
  add column if not exists activation_end_date date,
  -- The two emails sent once the student has set a password (admin + student). Final once
  -- sent; at most five reservations, so neither inbox nor the audit trail can be made to
  -- grow without bound.
  add column if not exists onboarding_notice_state text,
  add column if not exists onboarding_notice_at timestamptz,
  add column if not exists onboarding_notice_attempts smallint not null default 0;

do $rowchk$
begin
  alter table public.student_import_rows drop constraint if exists student_import_rows_v2_vocab;
  alter table public.student_import_rows add constraint student_import_rows_v2_vocab check (
        (validation_status is null or validation_status in ('valid', 'blocked', 'duplicate'))
    and (activation_state is null or activation_state in
          ('inactive', 'ready', 'activating', 'activated', 'failed', 'blocked', 'reverted'))
    and (invite_state is null or invite_state in ('not_sent', 'sending', 'sent', 'uncertain', 'failed', 'notified'))
    and (identity_basis is null or identity_basis in ('external_id', 'email'))
    and ((validation_status is null) = (activation_state is null))
    and (validation_status is distinct from 'valid' or activation_state in
          ('inactive', 'ready', 'activating', 'activated', 'failed', 'blocked', 'reverted'))
    and (validation_status = 'valid' or validation_status is null or activation_state = 'blocked'));
  alter table public.student_import_rows drop constraint if exists student_import_rows_v2_values;
  alter table public.student_import_rows add constraint student_import_rows_v2_values check (
        (legacy_record_key is null or legacy_record_key ~ '^[0-9a-f]{64}$')
    and (legacy_amount_paid is null or legacy_amount_paid between 0 and 1000000)
    and (legacy_currency is null or legacy_currency ~ '^[A-Z]{3}$')
    and invite_generation between 0 and 50
    and (legacy_phone is null or legacy_phone ~ '^[0-9]{7,15}$')
    and (activation_start_date is null or activation_end_date is null or activation_end_date >= activation_start_date)
    and (onboarding_notice_state is null or onboarding_notice_state in ('sending', 'sent', 'failed'))
    and onboarding_notice_attempts between 0 and 5);
end
$rowchk$;

-- ★ ONE LEGACY PURCHASE IS ACTIVATED ONCE, ACROSS EVERY JOB. The key is identity + plan +
--   cohort (see legacy_import_record_key); a re-uploaded or corrected roster can stage the
--   same person again, but only one row can ever hold the activating/activated state.
create unique index if not exists student_import_rows_record_key_live
  on public.student_import_rows (legacy_record_key)
  where activation_state in ('activating', 'activated');
create index if not exists student_import_rows_record_key on public.student_import_rows (legacy_record_key);
create index if not exists student_import_rows_job_state on public.student_import_rows (job_id, activation_state);
create index if not exists student_import_rows_run on public.student_import_rows (activation_run_id);
create index if not exists student_import_rows_target on public.student_import_rows (target_user_id);


-- == 4) RLS and grants: read-only for students.legacy_migrate ==================
-- ★ ZERO CLIENT WRITE PATHS — the finance rule. Every table keeps exactly one SELECT
--   policy on the new permission (student_external_accounts also keeps the member's
--   read of their OWN lineage row); every write is a SECURITY DEFINER function.
drop policy if exists student_import_jobs_admin_all on public.student_import_jobs;
drop policy if exists student_import_rows_admin_all on public.student_import_rows;
drop policy if exists student_external_accounts_admin_all on public.student_external_accounts;
drop policy if exists student_import_events_admin_select on public.student_import_events;
drop policy if exists student_import_events_admin_insert on public.student_import_events;

alter table public.student_import_activation_runs enable row level security;

do $pol$
declare
  t text;
begin
  foreach t in array array['student_import_jobs', 'student_import_rows', 'student_import_events',
                           'student_import_activation_runs', 'student_external_accounts'] loop
    execute format('drop policy if exists %I on public.%I', t || '_migrate_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using ((select public.has_staff_permission(''students.legacy_migrate'')))', t || '_migrate_read', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from anon, authenticated', t);
    execute format('revoke select on table public.%I from anon', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end
$pol$;

-- The audit trail is append-only, with the referential SET NULL exemption every audit
-- table here needs (job_id, row_id and actor are all ON DELETE SET NULL; refusing that
-- UPDATE would make deleting an Auth user who ever acted impossible).
create or replace function public.student_import_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE'
     and (new.id, new.kind, new.status, new.detail, new.created_at)
         is not distinct from (old.id, old.kind, old.status, old.detail, old.created_at)
     and (new.job_id is not distinct from old.job_id or new.job_id is null)
     and (new.row_id is not distinct from old.row_id or new.row_id is null)
     and (new.actor  is not distinct from old.actor  or new.actor  is null) then
    return new;
  end if;
  perform public.app_error('FORBIDDEN', 'The student import audit trail is append-only.', 409, null);
  return null;
end;
$fn$;

revoke all on function public.student_import_events_guard() from public, anon, authenticated;
drop trigger if exists student_import_events_guard on public.student_import_events;
create trigger student_import_events_guard
  before update or delete on public.student_import_events
  for each row execute function public.student_import_events_guard();


-- == 5) The v1 jobs that never granted anything ================================
-- Four v1 jobs (two of them full dry-runs of the real roster) sat in production holding
-- student names and emails with no target account, no Auth user and no grant. They are
-- discarded and their raw payloads purged; the audit events stay.
do $v1$
declare
  j record;
begin
  for j in
    select sj.id from public.student_import_jobs sj
     where sj.pipeline = 'v1'
       and sj.status not in ('completed', 'discarded')
       and not exists (select 1 from public.student_import_rows r
                        where r.job_id = sj.id
                          and (r.target_user_id is not null or r.auth_user_created or r.subscription_granted))
  loop
    update public.student_import_rows
       set mapped = '{}'::jsonb, email_display = null, email_normalized = null,
           external_user_id = null, warnings = '[]'::jsonb, errors = '[]'::jsonb, updated_at = now()
     where job_id = j.id;
    update public.student_import_jobs
       set status = 'discarded', discarded_at = now(), discard_reason = 'v1 job that never granted anything (#67)',
           purged_at = now(), settings = '{}'::jsonb, updated_at = now()
     where id = j.id;
    insert into public.student_import_events (job_id, kind, status, detail)
    values (j.id, 'job_discarded', 'v1_cleanup', jsonb_build_object('migration', '#67'));
  end loop;
end
$v1$;


-- == 6) Internal helpers ======================================================

-- The actor check every function below starts with. Service-role callers pass the
-- verified caller as p_actor (auth.uid() is NULL under the service role); client-called
-- functions pass auth.uid(). Either way the answer comes from the live staff tables.
create or replace function public.legacy_import_require(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_actor is null or not public.user_has_staff_permission(p_actor, 'students.legacy_migrate') then
    perform public.app_error('FORBIDDEN',
      'The legacy student migration needs the students.legacy_migrate permission.', 403, null);
  end if;
end;
$fn$;

create or replace function public.legacy_import_log(
  p_job uuid, p_row uuid, p_actor uuid, p_kind text, p_status text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $fn$
  insert into public.student_import_events (job_id, row_id, actor, kind, status, detail)
  values (p_job, p_row, p_actor, p_kind, p_status, coalesce(p_detail, '{}'::jsonb));
$fn$;

-- A calendar date or NULL. '2026-02-31' is NULL, never March 3.
create or replace function public.legacy_import_safe_date(p text)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v date;
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  v := p::date;
  if to_char(v, 'YYYY-MM-DD') <> p then
    return null;
  end if;
  return v;
exception when others then
  return null;
end;
$fn$;

-- ★ The record key. legacyRecordKeyInput() in src/lib/legacyMigration.js builds the
--   SAME string; this hash is the authority.
create or replace function public.legacy_import_record_key(
  p_external text, p_email text, p_plan text, p_batch_code text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case
    when p_email is null or p_plan is null or p_batch_code is null then null
    else encode(sha256(convert_to(
      'thinkific|'
      || case when nullif(btrim(p_external), '') is not null then 'ext:' || btrim(p_external)
              else 'email:' || p_email end
      || '|' || p_plan || '|' || p_batch_code, 'UTF8')), 'hex')
  end
$fn$;

-- ★ The term. A start date is 00:00 in Manila; an end date is its LAST millisecond, so
--   "access until April 12" is April 12 on every screen; grace is the standard 3 days
--   (approve_subscription's v_grace_days). manilaTerm() in legacyMigration.js mirrors it.
create or replace function public.legacy_import_term(p_start date, p_end date)
returns table (started_at timestamptz, ends_at timestamptz, grace_ends_at timestamptz)
language sql
stable
set search_path = public, pg_temp
as $fn$
  select (p_start::timestamp at time zone 'Asia/Manila'),
         ((p_end + 1)::timestamp at time zone 'Asia/Manila') - interval '1 millisecond',
         ((p_end + 1)::timestamp at time zone 'Asia/Manila') - interval '1 millisecond' + interval '3 days'
$fn$;

-- The cohort codes a run starting at p_start_code would take, and the months with no
-- batch at all between them. ★ The queue binder is forward-only within a run, so a month
-- created LATER than a cohort the run already holds can never join it — the preflight
-- shows this gap before anyone activates.
create or replace function public.legacy_import_preview_allocation(p_start_code text, p_count int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_start   public.batches%rowtype;
  v_codes   text[];
  v_missing text[] := '{}'::text[];
begin
  select * into v_start from public.batches where code = p_start_code;
  if v_start.id is null then
    return jsonb_build_object('ok', false, 'reason', 'batch_unknown', 'start_code', p_start_code);
  end if;
  select coalesce(array_agg(c.code order by c.code), '{}'::text[]) into v_codes
    from (select b.code
            from public.batches b
           where b.code >= v_start.code
             and (b.status = 'open' or (v_start.status = 'closed' and b.status = 'closed'))
             and exists (select 1 from public.community_spaces sp
                          where sp.batch_id = b.id and sp.kind = 'vip' and sp.active)
           order by b.code
           limit greatest(coalesce(p_count, 0), 0)) c;
  if cardinality(v_codes) > 0 then
    select coalesce(array_agg(to_char(m, 'YYYY-MM') order by m), '{}'::text[]) into v_missing
      from generate_series(to_date(v_start.code || '-01', 'YYYY-MM-DD')::timestamp,
                           to_date(v_codes[cardinality(v_codes)] || '-01', 'YYYY-MM-DD')::timestamp,
                           interval '1 month') m
     where not exists (select 1 from public.batches b where b.code = to_char(m, 'YYYY-MM'));
  end if;
  return jsonb_build_object(
    'ok', true, 'start_code', v_start.code, 'start_status', v_start.status,
    'codes', to_jsonb(v_codes),
    'queued', greatest(coalesce(p_count, 0) - cardinality(v_codes), 0),
    'missing_months', to_jsonb(v_missing));
end;
$fn$;


-- == 6a) The closed-start run =================================================
-- ★ grant_batch_run() refuses a closed START batch for a new seat, and considers only open
--   cohorts after it. That is right for a new purchase and wrong for a legacy one: the
--   September roster was sold before its batch closed, and #38 closes every batch by cron
--   the moment its month ends. This is #39's grant_batch_run with EXACTLY two edits — the
--   non-open start refusal is removed (the ARCHIVED refusal stays), and closed cohorts are
--   candidates alongside open ones. It is reachable only from legacy_import_activate_row(),
--   which calls it only for a validated paid legacy row whose start batch is closed.

create or replace function public.legacy_import_grant_closed_start_run(
  p_user_id uuid, p_segment text, p_start_batch_id uuid, p_count integer,
  p_grant_reason text, p_source_subscription_id uuid default null,
  p_source_plan_key text default null, p_source_request_id uuid default null,
  p_source_import_row_id uuid default null, p_valid_until timestamptz default null,
  p_actor uuid default null, p_enforce_capacity boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id      uuid := gen_random_uuid();
  v_start       public.batches%rowtype;
  v_outstanding int;
  v_other_seg   text;
  v_cand        record;
  v_idx         int := 0;
  v_cap         int;
  v_used        int;
  v_allocated   jsonb := '[]'::jsonb;
  v_queued      int := 0;
  v_activates   timestamptz;
begin
  if p_segment is distinct from 'vip' then
    perform public.app_error('INVALID_PLAN',
      format('%s is not a cohort segment', coalesce(p_segment, 'null')), 422,
      jsonb_build_object('segment', p_segment));
  end if;
  if p_count is null or p_count < 1 then
    perform public.app_error('INVALID_PLAN',
      'this plan has no cohort run length - set enrollment_plans.eligible_batch_count', 422,
      jsonb_build_object('plan_key', p_source_plan_key));
  end if;
  if p_count > 24 then
    perform public.app_error('RUN_LIMIT_EXCEEDED', 'a run cannot exceed 24 cohorts', 409,
      jsonb_build_object('requested', p_count));
  end if;

  select * into v_start from public.batches where id = p_start_batch_id;
  if v_start.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'batch not found', 404,
      jsonb_build_object('batch_id', p_start_batch_id));
  end if;

  -- Mixing segments inside one member's outstanding run makes "which seat does
  -- this member occupy?" ambiguous for capacity. With one live segment this can
  -- now only fire on stamped history, which is exactly when it should.
  select e.segment into v_other_seg
    from public.batch_entitlements e
   where e.user_id = p_user_id
     and e.status in ('queued', 'active')
     and e.segment <> p_segment
   limit 1;
  if v_other_seg is not null then
    perform public.app_error('SEGMENT_MISMATCH',
      format('member already holds outstanding %s seats', v_other_seg), 409,
      jsonb_build_object('held_segment', v_other_seg, 'requested_segment', p_segment));
  end if;

  select count(*) into v_outstanding
    from public.batch_entitlements e
   where e.user_id = p_user_id and e.status in ('queued', 'active');
  if v_outstanding + p_count > 24 then
    perform public.app_error('RUN_LIMIT_EXCEEDED',
      'this member already holds the maximum number of upcoming cohort seats', 409,
      jsonb_build_object('outstanding', v_outstanding, 'requested', p_count));
  end if;

  -- The explicitly chosen starting cohort must itself be usable - a precise
  -- error here beats silently starting the run a month later.
  if v_start.status = 'archived' then
    perform public.app_error('BATCH_CLOSED', format('batch %s is archived', v_start.code), 409,
      jsonb_build_object('batch_code', v_start.code, 'status', v_start.status));
  end if;
  if not exists (select 1 from public.community_spaces sp
                  where sp.batch_id = v_start.id and sp.kind = p_segment and sp.active) then
    perform public.app_error('NO_SPACE_FOR_SEGMENT',
      format('batch %s has no active %s space', v_start.code, p_segment), 409,
      jsonb_build_object('batch_code', v_start.code, 'segment', p_segment));
  end if;
  -- #67 EDIT 1 of 2: the non-open start refusal is removed. A legacy purchase was made
  -- before its batch closed; the ARCHIVED refusal above still stands.

  -- Allocate from the REGISTRY, in code order, under one ordered lock.
  for v_cand in
    select b.id, b.code, b.status, b.starts_on, b.vip_capacity, b.total_capacity
      from public.batches b
     where b.code >= v_start.code
       and b.status in ('open', 'closed')   -- #67 EDIT 2 of 2: closed cohorts were sold too
       and exists (select 1 from public.community_spaces sp
                    where sp.batch_id = b.id and sp.kind = p_segment and sp.active)
       and not exists (select 1 from public.batch_entitlements e2
                        where e2.user_id = p_user_id and e2.batch_id = b.id
                          and e2.status in ('queued', 'active'))
     order by b.code
     limit p_count
     for update
  loop
    if p_enforce_capacity then
      v_cap := v_cand.vip_capacity;
      if v_cap is not null then
        select count(*) into v_used
          from public.batch_seat_holders(v_cand.id, p_segment) h
         where h <> p_user_id;
        if v_used >= v_cap then
          perform public.app_error('BATCH_FULL',
            format('batch %s is full for %s (%s of %s seats)', v_cand.code, p_segment, v_used, v_cap), 409,
            jsonb_build_object('batch_code', v_cand.code, 'segment', p_segment,
                               'used', v_used, 'capacity', v_cap, 'scope', 'segment'));
        end if;
      end if;

      -- total_capacity is retained: it is the cap across every cohort segment,
      -- which is one today but is the knob that stays correct if another is added.
      if v_cand.total_capacity is not null then
        select count(*) into v_used
          from public.batch_seat_holders(v_cand.id, 'vip') h
         where h <> p_user_id;
        if v_used >= v_cand.total_capacity then
          perform public.app_error('BATCH_FULL',
            format('batch %s is full (%s of %s total seats)', v_cand.code, v_used, v_cand.total_capacity), 409,
            jsonb_build_object('batch_code', v_cand.code, 'used', v_used,
                               'capacity', v_cand.total_capacity, 'scope', 'total'));
        end if;
      end if;
    end if;

    -- A cohort reveals itself when it starts. Falling back to the month encoded
    -- in `code` keeps this deterministic when starts_on has not been set.
    v_activates := coalesce(v_cand.starts_on::timestamptz,
                            to_date(v_cand.code || '-01', 'YYYY-MM-DD')::timestamptz);

    insert into public.batch_entitlements (
      user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason,
      source_subscription_id, source_plan_key, source_request_id, source_import_row_id,
      granted_by, valid_until, activates_at, allocated_at
    ) values (
      p_user_id, v_cand.id, p_segment, v_idx, v_run_id, p_count, 'active', p_grant_reason,
      p_source_subscription_id, p_source_plan_key, p_source_request_id, p_source_import_row_id,
      p_actor, p_valid_until, v_activates, now()
    );

    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (v_cand.id, p_user_id, p_actor, 'entitle_allocate',
            jsonb_build_object('run_id', v_run_id, 'segment', p_segment,
                               'batch_index', v_idx, 'reason', p_grant_reason));

    v_allocated := v_allocated || jsonb_build_object('batch_id', v_cand.id, 'code', v_cand.code,
                                                     'batch_index', v_idx);
    v_idx := v_idx + 1;
  end loop;

  -- Shortfall: cohorts that do not exist yet. The seat is still owed, so it is
  -- recorded and bound by the FIFO trigger when Alex creates the next batch.
  while v_idx < p_count loop
    insert into public.batch_entitlements (
      user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason,
      source_subscription_id, source_plan_key, source_request_id, source_import_row_id,
      granted_by, valid_until
    ) values (
      p_user_id, null, p_segment, v_idx, v_run_id, p_count, 'queued', p_grant_reason,
      p_source_subscription_id, p_source_plan_key, p_source_request_id, p_source_import_row_id,
      p_actor, p_valid_until
    );
    v_queued := v_queued + 1;
    v_idx := v_idx + 1;
  end loop;

  if v_queued > 0 then
    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (null, p_user_id, p_actor, 'entitle',
            jsonb_build_object('run_id', v_run_id, 'segment', p_segment,
                               'queued', v_queued, 'reason', p_grant_reason));
  end if;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run_id, 'segment', p_segment,
    'run_length', p_count, 'allocated', v_allocated, 'queued', v_queued
  );
end;
$$;


-- == 6b) Service-only functions (api/admin/student-imports.js) ================

-- Stage one roster atomically. The endpoint normalizes every cell with the shared
-- library first; this function re-validates each row against the live catalog and
-- registry, recomputes the record key, and decides validation and activation state.
create or replace function public.legacy_import_stage(p_actor uuid, p_job jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_hash      text := lower(coalesce(p_job->>'content_sha256', ''));
  v_file_hash text := lower(coalesce(p_job->>'file_sha256', ''));
  v_fmt       text := p_job->>'date_format';
  v_eligible  text[];
  v_existing  uuid;
  v_job       uuid;
  v_counts    jsonb;
  r           record;
  v_errs      jsonb;
  v_warn      jsonb;
  v_email     text;
  v_sd        date;
  v_ed        date;
  v_grace     timestamptz;
  v_batch     public.batches%rowtype;
  v_plan_ok   boolean;
  v_uid       uuid;
  v_confirmed boolean;
  v_key       text;
  v_valid     text;
  v_differs   jsonb;
begin
  perform public.legacy_import_require(p_actor);

  if v_hash !~ '^[0-9a-f]{64}$' then
    perform public.app_error('LEGACY_STAGE_INVALID', 'The roster fingerprint is missing or malformed.', 422, null);
  end if;
  if v_fmt is null or v_fmt not in ('M/D/YYYY', 'D/M/YYYY', 'YYYY-MM-DD') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Declare the date format before staging.', 422, null);
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'A roster must hold between 1 and 5,000 rows.', 422, null);
  end if;
  select coalesce(array_agg(distinct c order by c), '{}'::text[]) into v_eligible
    from jsonb_array_elements_text(coalesce(p_job->'eligible_batch_codes', '[]'::jsonb)) c;
  if exists (select 1 from unnest(v_eligible) c where c !~ '^\d{4}-\d{2}$') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'An eligible cohort is not a YYYY-MM code.', 422, null);
  end if;

  -- ★ ONE STAGING AT A TIME, ACROSS EVERY ROSTER. Keyed on the content alone, two
  --   DIFFERENT files holding the same student could stage concurrently, each unable to
  --   see the other's rows, and both come out `ready` for one purchase.
  perform pg_advisory_xact_lock(hashtextextended('legacy_import_stage', 0));
  select j.id into v_existing
    from public.student_import_jobs j
   where j.pipeline = 'legacy_v2' and j.content_sha256 = v_hash and j.discarded_at is null;
  if v_existing is not null then
    -- ★ THE SAME ROWS READ DIFFERENTLY ARE NOT THE SAME JOB. The fingerprint covers the
    --   cells, not how they were read, so re-staging to correct a date format would
    --   otherwise hand back the job staged with the WRONG one — and 11/10 read as 10/11
    --   still lands inside the batch window, so nothing downstream would notice.
    select coalesce(jsonb_agg(d.k order by d.k), '[]'::jsonb) into v_differs
      from public.student_import_jobs j,
           lateral (values
             ('date_format',          j.date_format is distinct from v_fmt),
             ('column_mapping',       j.mapping is distinct from coalesce(p_job->'mapping', '{}'::jsonb)),
             ('plan_mapping',         j.plan_mapping is distinct from coalesce(p_job->'plan_mapping', '{}'::jsonb)),
             ('batch_mapping',        j.batch_mapping is distinct from coalesce(p_job->'batch_mapping', '{}'::jsonb)),
             ('eligible_batch_codes', j.eligible_batch_codes is distinct from v_eligible)) as d(k, differs)
     where j.id = v_existing and d.differs;
    if jsonb_array_length(v_differs) > 0 then
      perform public.app_error('LEGACY_JOB_SETTINGS_DIFFER',
        'This roster is already staged with different settings. Discard that job first, then stage again.', 409,
        jsonb_build_object('job_id', v_existing, 'differs', v_differs));
    end if;
    return jsonb_build_object('ok', true, 'job_id', v_existing, 'reopened', true);
  end if;

  insert into public.student_import_jobs (
    source, filename, file_sha256, content_sha256, mapping, settings, status, total_rows,
    created_by, pipeline, date_format, plan_mapping, batch_mapping, eligible_batch_codes)
  values (
    'manual', left(p_job->>'filename', 200),
    case when v_file_hash ~ '^[0-9a-f]{64}$' then v_file_hash end, v_hash,
    coalesce(p_job->'mapping', '{}'::jsonb), '{}'::jsonb, 'staged', jsonb_array_length(p_rows),
    p_actor, 'legacy_v2', v_fmt,
    coalesce(p_job->'plan_mapping', '{}'::jsonb), coalesce(p_job->'batch_mapping', '{}'::jsonb), v_eligible)
  returning id into v_job;

  for r in
    select *
      from jsonb_to_recordset(p_rows) as x(
        source_row_number int, external_user_id text, email_normalized text, email_display text,
        first_name text, last_name text, plan_key text, legacy_plan_label text,
        batch_code text, legacy_batch_label text, start_date text, end_date text,
        payment_status text, amount_paid numeric, currency text, errors jsonb, warnings jsonb, phone text)
  loop
    v_errs := case when jsonb_typeof(r.errors) = 'array' then r.errors else '[]'::jsonb end;
    v_warn := case when jsonb_typeof(r.warnings) = 'array' then r.warnings else '[]'::jsonb end;
    v_email := lower(nullif(btrim(r.email_normalized), ''));
    v_sd := public.legacy_import_safe_date(r.start_date);
    v_ed := public.legacy_import_safe_date(r.end_date);
    v_batch := null;
    v_uid := null;
    v_confirmed := false;

    -- ★ SQL re-derives every refusal; the endpoint's list can only ADD reasons.
    if v_email is null then
      v_errs := v_errs || '["email_missing"]'::jsonb;
    elsif v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_errs := v_errs || '["email_invalid"]'::jsonb;
    end if;

    select exists (select 1 from public.enrollment_plans p where p.key = r.plan_key and p.active) into v_plan_ok;
    if not v_plan_ok then
      v_errs := v_errs || '["plan_unknown"]'::jsonb;
    end if;

    select * into v_batch from public.batches b where b.code = r.batch_code;
    if v_batch.id is null then
      v_errs := v_errs || '["batch_unknown"]'::jsonb;
    elsif v_batch.status = 'archived' then
      v_errs := v_errs || '["batch_archived"]'::jsonb;
    end if;

    if v_sd is null then v_errs := v_errs || '["start_date_invalid"]'::jsonb; end if;
    if v_ed is null then v_errs := v_errs || '["end_date_invalid"]'::jsonb; end if;
    if v_sd is not null and v_ed is not null then
      if v_ed < v_sd then
        v_errs := v_errs || '["date_order"]'::jsonb;
      else
        select t.grace_ends_at into v_grace from public.legacy_import_term(v_sd, v_ed) t;
        if v_grace <= now() then
          v_errs := v_errs || '["term_ended"]'::jsonb;
        end if;
      end if;
    end if;

    if nullif(btrim(r.payment_status), '') is null then
      v_errs := v_errs || '["payment_status_missing"]'::jsonb;
    elsif lower(btrim(r.payment_status)) <> 'paid' then
      v_errs := v_errs || '["payment_not_paid"]'::jsonb;
    end if;
    if r.amount_paid is not null and (r.amount_paid < 0 or r.amount_paid > 1000000) then
      v_errs := v_errs || '["amount_invalid"]'::jsonb;
    end if;
    if r.currency is not null and r.currency !~ '^[A-Z]{3}$' then
      v_errs := v_errs || '["currency_invalid"]'::jsonb;
    end if;

    -- An existing account is LINKED at activation, never duplicated. The same checks
    -- run again there; flagging them now keeps the preflight honest.
    if v_email is not null then
      select u.id, u.email_confirmed_at is not null into v_uid, v_confirmed
        from auth.users u where lower(u.email) = v_email order by u.created_at limit 1;
    end if;
    if v_uid is not null then
      v_warn := v_warn || '["existing_account"]'::jsonb;
      if exists (select 1 from public.profiles p where p.id = v_uid and p.approval_status = 'rejected') then
        v_errs := v_errs || '["profile_rejected"]'::jsonb;
      end if;
      if exists (select 1 from public.staff_memberships m where m.user_id = v_uid and m.status in ('invited', 'active')) then
        v_errs := v_errs || '["staff_account"]'::jsonb;
      end if;
      if exists (select 1 from public.subscriptions s
                  where s.user_id = v_uid
                    and (s.status = 'scheduled'
                         or (s.status = 'active' and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())))) then
        v_errs := v_errs || '["membership_conflict"]'::jsonb;
      end if;
    end if;

    select coalesce(jsonb_agg(distinct e), '[]'::jsonb) into v_errs from jsonb_array_elements_text(v_errs) e;
    select coalesce(jsonb_agg(distinct w), '[]'::jsonb) into v_warn from jsonb_array_elements_text(v_warn) w;

    v_key := public.legacy_import_record_key(r.external_user_id, v_email,
               case when v_plan_ok then r.plan_key end, v_batch.code);
    v_valid := case when jsonb_array_length(v_errs) = 0 then 'valid' else 'blocked' end;

    insert into public.student_import_rows (
      job_id, source_row_number, mapped, external_user_id, email_normalized, email_display,
      proposed_plan_key, proposed_batch_id, proposed_started_at, proposed_ends_at, proposed_term_mode,
      warnings, errors, validation_status, activation_state, invite_state, legacy_record_key,
      identity_basis, matched_existing, existing_confirmed, legacy_start_date, legacy_end_date,
      legacy_plan_label, legacy_batch_label, legacy_payment_status, legacy_amount_paid, legacy_currency,
      legacy_phone)
    values (
      v_job, r.source_row_number,
      jsonb_build_object('first_name', left(r.first_name, 120), 'last_name', left(r.last_name, 120)),
      nullif(btrim(r.external_user_id), ''), v_email, left(r.email_display, 320),
      case when v_plan_ok then r.plan_key end, v_batch.id,
      (select t.started_at from public.legacy_import_term(v_sd, v_ed) t where v_sd is not null and v_ed is not null),
      (select t.ends_at from public.legacy_import_term(v_sd, v_ed) t where v_sd is not null and v_ed is not null),
      'preserve', v_warn, v_errs, v_valid,
      case when v_valid <> 'valid' then 'blocked'
           when v_batch.code = any (v_eligible) then 'ready'
           else 'inactive' end,
      null, v_key,
      case when nullif(btrim(r.external_user_id), '') is not null then 'external_id' else 'email' end,
      v_uid is not null, coalesce(v_confirmed, false), v_sd, v_ed,
      left(r.legacy_plan_label, 120), left(r.legacy_batch_label, 120),
      lower(nullif(btrim(r.payment_status), '')),
      case when r.amount_paid between 0 and 1000000 then round(r.amount_paid, 2) end,
      case when r.currency ~ '^[A-Z]{3}$' then r.currency end,
      case when regexp_replace(coalesce(r.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,15}$'
           then regexp_replace(r.phone, '[^0-9]', '', 'g') end);
  end loop;

  -- ★ A PHONE IS A HINT, NEVER AN IDENTITY. Two rows, or a row and an earlier enrollment
  --   request, sharing a phone under DIFFERENT emails may be one person — the Super Admin is
  --   told, and nothing else happens. Linking an account by phone would hand a paid term to
  --   whoever owns the other email's login; Auth identity is the email and stays the email.
  update public.student_import_rows sr
     set warnings = sr.warnings || '["phone_shared"]'::jsonb
   where sr.job_id = v_job
     and sr.legacy_phone is not null
     and not (sr.warnings ? 'phone_shared')
     and (exists (select 1 from public.student_import_rows o
                   where o.job_id = v_job and o.id <> sr.id and o.legacy_phone = sr.legacy_phone
                     and o.email_normalized is distinct from sr.email_normalized)
          or exists (select 1 from public.enrollment_requests er
                      where regexp_replace(coalesce(er.phone, ''), '[^0-9]', '', 'g') = sr.legacy_phone
                        and lower(coalesce(er.email, '')) is distinct from sr.email_normalized));

  -- The same person twice in one roster is never two memberships.
  update public.student_import_rows sr
     set errors = case when sr.errors ? 'duplicate_in_file' then sr.errors
                       else sr.errors || '["duplicate_in_file"]'::jsonb end,
         validation_status = 'duplicate', activation_state = 'blocked'
   where sr.job_id = v_job
     and sr.email_normalized is not null
     and exists (select 1 from public.student_import_rows o
                  where o.job_id = v_job and o.id <> sr.id and o.email_normalized = sr.email_normalized);

  -- …nor is a purchase another job already holds. Remediation is to discard that job.
  update public.student_import_rows sr
     set errors = sr.errors || '["duplicate_staged"]'::jsonb,
         validation_status = 'duplicate', activation_state = 'blocked'
   where sr.job_id = v_job
     and sr.legacy_record_key is not null
     and exists (
       select 1 from public.student_import_rows o
         join public.student_import_jobs oj on oj.id = o.job_id
        where o.legacy_record_key = sr.legacy_record_key
          and o.job_id <> v_job
          and (o.activation_state in ('activating', 'activated')
               or (oj.discarded_at is null and o.activation_state is distinct from 'reverted')));

  select coalesce(jsonb_object_agg(s.activation_state, s.n), '{}'::jsonb) into v_counts
    from (select activation_state, count(*) as n from public.student_import_rows
           where job_id = v_job group by activation_state) s;
  update public.student_import_jobs set counts = v_counts, updated_at = now() where id = v_job;

  perform public.legacy_import_log(v_job, null, p_actor, 'job_staged', 'staged',
    jsonb_build_object('rows', jsonb_array_length(p_rows), 'states', v_counts,
                       'eligible_batch_codes', to_jsonb(v_eligible), 'date_format', v_fmt));

  return jsonb_build_object('ok', true, 'job_id', v_job, 'reopened', false, 'states', v_counts);
end;
$fn$;

-- The Auth identity for an email. Up to two rows, so the endpoint can refuse an
-- ambiguous match instead of picking one.
create or replace function public.legacy_import_find_auth_user(p_actor uuid, p_email text)
returns table (user_id uuid, confirmed boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.legacy_import_require(p_actor);
  return query
    select u.id, (u.email_confirmed_at is not null)
      from auth.users u
     where lower(u.email) = lower(btrim(p_email))
     order by u.created_at
     limit 2;
end;
$fn$;

-- The counts the confirmation dialog shows, read live. Nothing is written.
create or replace function public.legacy_import_preflight(p_actor uuid, p_job_id uuid, p_row_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_out jsonb;
begin
  perform public.legacy_import_require(p_actor);
  with sel as (
    -- ★ EFFECTIVE TERMS: what the Super Admin assigned, else what the roster said. The same
    --   four coalesces appear in legacy_import_activate_row; the SQL suite pins both.
    select sr.*,
           coalesce(sr.activation_plan_key, sr.proposed_plan_key)  as eff_plan_key,
           coalesce(sr.activation_batch_id, sr.proposed_batch_id)  as eff_batch_id,
           coalesce(sr.activation_start_date, sr.legacy_start_date) as eff_start,
           coalesce(sr.activation_end_date, sr.legacy_end_date)     as eff_end
      from public.student_import_rows sr
     where sr.job_id = p_job_id and sr.id = any (coalesce(p_row_ids, '{}'::uuid[]))
  ), acc as (
    select s.*, u.id as uid, (u.email_confirmed_at is not null) as confirmed
      from sel s
      left join lateral (select au.id, au.email_confirmed_at from auth.users au
                          where lower(au.email) = s.email_normalized order by au.created_at limit 1) u on true
  ), ready as (
    -- A FAILED row is activatable again: legacy_import_start_run() re-queues it.
    -- ★ EXACTLY what legacy_import_start_run() accepts, and no more: a row still held by a
    --   running or paused run would refuse the WHOLE run (LEGACY_RUN_BUSY), so it is left
    --   out here, and the dialog sends back row_ids rather than its own selection. A preview
    --   that promised "left out" while the start refused everything was a dead end.
    select a.* from acc a
     where a.activation_state in ('ready', 'failed')
       and not exists (select 1 from public.student_import_activation_runs ru
                        where ru.job_id = p_job_id and ru.status in ('running', 'paused')
                          and a.id = any (ru.row_ids))
  )
  select jsonb_build_object(
    'requested', cardinality(array(select distinct unnest(coalesce(p_row_ids, '{}'::uuid[])))),
    'found', (select count(*) from sel),
    'to_activate', (select count(*) from ready),
    'row_ids', (select coalesce(jsonb_agg(r.id order by r.source_row_number), '[]'::jsonb) from ready r),
    'retrying', (select count(*) from ready where activation_state = 'failed'),
    'excluded', cardinality(array(select distinct unnest(coalesce(p_row_ids, '{}'::uuid[])))) - (select count(*) from ready),
    'new_accounts', (select count(*) from ready where uid is null),
    'existing_accounts', (select count(*) from ready where uid is not null),
    'claim_emails', (select count(*) from ready where uid is null or not confirmed),
    'notifications', (select count(*) from ready where uid is not null and confirmed),
    'scheduled', (select count(*) from ready r, public.legacy_import_term(r.eff_start, r.eff_end) t
                   where t.started_at > now()),
    'plans', (select coalesce(jsonb_agg(distinct jsonb_build_object('key', p.key, 'name', p.name)), '[]'::jsonb)
                from ready r join public.enrollment_plans p on p.key = r.eff_plan_key),
    'starts', (select coalesce(jsonb_agg(distinct r.eff_start), '[]'::jsonb) from ready r),
    'ends', (select coalesce(jsonb_agg(distinct r.eff_end), '[]'::jsonb) from ready r),
    -- The terms step of the dialog: each distinct combination, with the roster's own values
    -- beside it so the Super Admin sees what they changed.
    'terms', (select coalesce(jsonb_agg(jsonb_build_object(
                'plan_key', t.eff_plan_key, 'plan_name', (select p.name from public.enrollment_plans p where p.key = t.eff_plan_key),
                'batch_id', t.eff_batch_id, 'batch_code', b.code, 'batch_name', b.name,
                'start_date', t.eff_start, 'end_date', t.eff_end, 'rows', t.n, 'assigned', t.assigned,
                'roster_start', t.roster_start, 'roster_end', t.roster_end, 'row_ids', to_jsonb(t.ids))
                order by b.code, t.eff_start, t.eff_plan_key), '[]'::jsonb)
                from (select r.eff_plan_key, r.eff_batch_id, r.eff_start, r.eff_end, count(*) as n, array_agg(r.id) as ids,
                             min(r.legacy_start_date) as roster_start, max(r.legacy_end_date) as roster_end,
                             bool_or(r.activation_plan_key is not null or r.activation_batch_id is not null
                                     or r.activation_start_date is not null or r.activation_end_date is not null) as assigned
                        from ready r group by 1, 2, 3, 4) t
                left join public.batches b on b.id = t.eff_batch_id),
    -- One entry per batch AND plan: a run's length is the plan's, so two plans in one
    -- batch are two allocations, never one sized by whichever key sorts first.
    'cohorts', (select coalesce(jsonb_agg(jsonb_build_object(
                  'code', b.code, 'name', b.name, 'status', b.status, 'rows', g.n,
                  'plan_key', g.plan_key, 'plan_name', (select p.name from public.enrollment_plans p where p.key = g.plan_key),
                  'capacity', b.vip_capacity,
                  'paid_holders', (select count(*) from public.batch_seat_holders(b.id, 'vip')),
                  'scheduled_legacy', (select count(*) from public.batch_entitlements e
                                         join public.subscriptions s on s.id = e.source_subscription_id
                                        where e.batch_id = b.id and e.status = 'active' and s.status = 'scheduled'),
                  'allocation', public.legacy_import_preview_allocation(b.code,
                                   public.plan_eligible_batch_count(g.plan_key))) order by b.code, g.plan_key), '[]'::jsonb)
                  from (select r.eff_batch_id, r.eff_plan_key as plan_key, count(*) as n
                          from ready r group by r.eff_batch_id, r.eff_plan_key) g
                  join public.batches b on b.id = g.eff_batch_id)
  ) into v_out;
  return v_out;
end;
$fn$;

-- Open a durable activation run over explicitly selected READY rows.
create or replace function public.legacy_import_start_run(
  p_actor uuid, p_job_id uuid, p_row_ids uuid[], p_phrase text, p_client_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job      public.student_import_jobs%rowtype;
  v_run      public.student_import_activation_runs%rowtype;
  v_ids      uuid[];
  v_bad      uuid[];
  v_row      record;
begin
  perform public.legacy_import_require(p_actor);
  if p_client_key is null or p_client_key !~ '^[A-Za-z0-9_-]{8,80}$' then
    perform public.app_error('LEGACY_STAGE_INVALID', 'The activation request key is missing or malformed.', 422, null);
  end if;

  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2' for update;
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404,
      jsonb_build_object('job_id', p_job_id));
  end if;
  if v_job.discarded_at is not null then
    perform public.app_error('LEGACY_JOB_BUSY', 'That migration job was discarded.', 409,
      jsonb_build_object('job_id', p_job_id));
  end if;

  -- A double click, a retry after a dropped connection: the same key is the same run.
  select * into v_run from public.student_import_activation_runs where job_id = p_job_id and client_key = p_client_key;
  if v_run.id is not null then
    return jsonb_build_object('ok', true, 'run_id', v_run.id, 'count', cardinality(v_run.row_ids), 'reused', true);
  end if;

  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids from unnest(coalesce(p_row_ids, '{}'::uuid[])) x;
  if cardinality(v_ids) not between 1 and 200 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Select between 1 and 200 rows to activate.', 422,
      jsonb_build_object('selected', cardinality(v_ids)));
  end if;

  -- ★ EVERY SELECTED ROW MUST BE READY (OR FAILED, TO RETRY), OR NOTHING STARTS. An
  --   inactive August row can never ride along because "select all" was pressed on
  --   another filter.
  select coalesce(array_agg(x), '{}'::uuid[]) into v_bad
    from unnest(v_ids) x
   where not exists (select 1 from public.student_import_rows sr
                      where sr.id = x and sr.job_id = p_job_id and sr.activation_state in ('ready', 'failed'));
  if cardinality(v_bad) > 0 then
    perform public.app_error('LEGACY_ROW_NOT_READY',
      format('%s of the selected rows are not ready to activate.', cardinality(v_bad)), 409,
      jsonb_build_object('not_ready', to_jsonb(v_bad[1:20]), 'count', cardinality(v_bad)));
  end if;

  if coalesce(btrim(p_phrase), '') <> 'ACTIVATE ' || cardinality(v_ids) then
    perform public.app_error('LEGACY_CONFIRMATION_MISMATCH',
      format('Type ACTIVATE %s to confirm.', cardinality(v_ids)), 422,
      jsonb_build_object('expected', 'ACTIVATE ' || cardinality(v_ids)));
  end if;

  if exists (select 1 from public.student_import_activation_runs ru
              where ru.job_id = p_job_id and ru.status in ('running', 'paused') and ru.row_ids && v_ids) then
    perform public.app_error('LEGACY_RUN_BUSY',
      'Some of these rows are already in an unfinished activation. Resume that one instead.', 409, null);
  end if;

  insert into public.student_import_activation_runs (job_id, created_by, client_key, row_ids, phrase)
  values (p_job_id, p_actor, p_client_key, v_ids, btrim(p_phrase))
  returning * into v_run;

  -- ★ A FAILED ROW RETRIED BY A NEW, TYPED CONFIRMATION STARTS AGAIN FROM ZERO ATTEMPTS.
  --   Retrying inside its own run is capped at five; without this a row that failed five
  --   times, or one whose run had finished, could never be activated at all.
  for v_row in
    update public.student_import_rows sr
       set activation_state = 'ready', attempts = 0, updated_at = now()
     where sr.id = any (v_ids) and sr.job_id = p_job_id and sr.activation_state = 'failed'
    returning sr.id, sr.last_error
  loop
    perform public.legacy_import_log(p_job_id, v_row.id, p_actor, 'row_requeued', 'ready',
      jsonb_build_object('run_id', v_run.id, 'previous_error', v_row.last_error));
  end loop;

  perform public.legacy_import_log(p_job_id, null, p_actor, 'run_started', 'running',
    jsonb_build_object('run_id', v_run.id, 'count', cardinality(v_ids)));

  return jsonb_build_object('ok', true, 'run_id', v_run.id, 'count', cardinality(v_ids), 'reused', false);
end;
$fn$;

-- Claim the next rows of a run for one request. A lease stops two requests working the
-- same run; SKIP LOCKED stops two workers taking the same row; a claim older than
-- STALE_CLAIM_MINUTES (10, longer than the endpoint's 60 s maxDuration) is reclaimable.
-- (An early draft of this file had no p_exclude; drop that overload if a rehearsal left it.)
drop function if exists public.legacy_import_claim_rows(uuid, uuid, text, integer, boolean);
create or replace function public.legacy_import_claim_rows(
  p_actor uuid, p_run_id uuid, p_lease text, p_limit int, p_retry_failed boolean default false,
  p_exclude uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run  public.student_import_activation_runs%rowtype;
  v_job  public.student_import_jobs%rowtype;
  v_rows jsonb;
  v_dup  record;
begin
  perform public.legacy_import_require(p_actor);
  if p_lease is null or p_lease !~ '^[A-Za-z0-9_-]{8,80}$' then
    perform public.app_error('LEGACY_STAGE_INVALID', 'The worker lease is missing or malformed.', 422, null);
  end if;

  select * into v_run from public.student_import_activation_runs where id = p_run_id for update;
  if v_run.id is null then
    perform public.app_error('LEGACY_RUN_NOT_FOUND', 'That activation run does not exist.', 404,
      jsonb_build_object('run_id', p_run_id));
  end if;
  select * into v_job from public.student_import_jobs where id = v_run.job_id;
  if v_run.status = 'cancelled' or v_job.discarded_at is not null then
    return '[]'::jsonb;
  end if;
  -- A finished run stays finished. Failed rows from it are retried by a NEW run
  -- (legacy_import_start_run re-queues them), which carries its own typed confirmation.
  if v_run.status = 'completed' then
    return '[]'::jsonb;
  end if;
  if v_run.lease_until is not null and v_run.lease_until > now() and v_run.lease_owner is distinct from p_lease then
    perform public.app_error('LEGACY_RUN_BUSY', 'Another window is already working this activation.', 409,
      jsonb_build_object('run_id', p_run_id));
  end if;

  update public.student_import_activation_runs
     set lease_owner = p_lease, lease_until = now() + interval '90 seconds',
         status = 'running', completed_at = null, updated_at = now()
   where id = p_run_id;

  -- One legacy purchase is activated once. A row whose record key is already live in
  -- another row is BLOCKED here, before the claim, rather than letting the unique index
  -- abort the whole claim with a bare 23505 on every retry.
  for v_dup in
    update public.student_import_rows sr
       set activation_state = 'blocked', blocked_reason = 'duplicate_staged', activation_claimed_at = null,
           updated_at = now()
     where sr.id = any (v_run.row_ids) and sr.job_id = v_run.job_id
       and sr.activation_state in ('ready', 'failed')
       and sr.legacy_record_key is not null
       and exists (select 1 from public.student_import_rows o
                    where o.legacy_record_key = sr.legacy_record_key and o.id <> sr.id
                      and o.activation_state in ('activating', 'activated'))
    returning sr.id
  loop
    perform public.legacy_import_log(v_run.job_id, v_dup.id, p_actor, 'activation_blocked', 'duplicate_staged',
      jsonb_build_object('run_id', p_run_id));
  end loop;

  with pick as (
    select sr.id
      from public.student_import_rows sr
     where sr.id = any (v_run.row_ids)
       and sr.job_id = v_run.job_id
       -- A row this request already tried is not re-claimed by it; the next request may.
       and not (sr.id = any (coalesce(p_exclude, '{}'::uuid[])))
       and (sr.activation_state = 'ready'
            or (p_retry_failed and sr.activation_state = 'failed' and sr.attempts < 5)
            or (sr.activation_state = 'activating' and sr.activation_claimed_at < now() - interval '10 minutes'))
     order by sr.source_row_number
     limit least(greatest(coalesce(p_limit, 1), 1), 10)
     for update skip locked
  ), upd as (
    update public.student_import_rows sr
       set activation_state = 'activating', activation_claimed_at = now(), attempts = sr.attempts + 1,
           activation_run_id = p_run_id, last_error = null, updated_at = now()
      from pick
     where sr.id = pick.id
    returning sr.id, sr.email_normalized, sr.target_user_id, sr.source_row_number,
              sr.mapped->>'first_name' as first_name, sr.mapped->>'last_name' as last_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_id', upd.id, 'email', upd.email_normalized, 'target_user_id', upd.target_user_id,
           'full_name', nullif(btrim(concat_ws(' ', upd.first_name, upd.last_name)), ''))
           order by upd.source_row_number), '[]'::jsonb)
    into v_rows from upd;

  return v_rows;
end;
$fn$;

-- Record the Auth user BEFORE anything else, so a retry after a timeout reuses it.
create or replace function public.legacy_import_bind_user(
  p_actor uuid, p_row_id uuid, p_run_id uuid, p_user_id uuid, p_created boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row       public.student_import_rows%rowtype;
  v_email     text;
  v_confirmed boolean;
  v_marked    boolean;
  v_created   boolean;
begin
  perform public.legacy_import_require(p_actor);
  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activating'
     or v_row.activation_run_id is distinct from p_run_id then
    perform public.app_error('LEGACY_ROW_NOT_READY', 'That row is not being activated by this run.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;

  select lower(u.email), u.email_confirmed_at is not null,
         (u.raw_app_meta_data->>'legacy_import_row_id') = p_row_id::text
    into v_email, v_confirmed, v_marked
    from auth.users u where u.id = p_user_id;
  if v_email is null or v_email is distinct from v_row.email_normalized
     or (v_row.target_user_id is not null and v_row.target_user_id <> p_user_id) then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH',
      'The account found does not match this row''s email.', 409, jsonb_build_object('row_id', p_row_id));
  end if;

  -- The endpoint stamps app_metadata.legacy_import_row_id on every account it creates, so
  -- a createUser that timed out yet succeeded is still recognised as OURS on the retry,
  -- not recorded as a stranger's never-confirmed signup.
  v_created := v_row.auth_user_created or coalesce(p_created, false) or coalesce(v_marked, false);
  update public.student_import_rows
     set target_user_id = p_user_id,
         auth_user_created = v_created,
         matched_existing = not v_created,
         -- A confirmed pre-existing account keeps its password and gets a notification.
         existing_confirmed = (not v_created) and v_confirmed,
         updated_at = now()
   where id = p_row_id;

  -- ★ ONLY AN ACCOUNT THIS IMPORT CREATED IS STAMPED HERE, before the grant, so it never
  --   shows up as an ordinary pending signup in Access Requests while it is being set up.
  --   A PRE-EXISTING account — a real student's own unconfirmed signup, an unaccepted staff
  --   invitee — is stamped only by a SUCCESSFUL activation, in the same transaction as the
  --   grant: stamping it here, ahead of legacy_import_activate_row's refusals, left a
  --   refused account hidden from Access Requests and undecidable there, with nothing in
  --   Student Imports able to release it.
  if v_created and not v_confirmed then
    update public.profiles p
       set account_origin = 'import',
           onboarding_status = case when p.onboarding_status = 'completed' then p.onboarding_status else 'invited' end,
           invited_at = coalesce(p.invited_at, now()),
           updated_at = now()
     where p.id = p_user_id
       and p.approval_status <> 'rejected';
  end if;

  perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'account_bound',
    case when v_created then 'created' else 'existing' end,
    jsonb_build_object('run_id', p_run_id, 'confirmed', v_confirmed));

  return jsonb_build_object('ok', true, 'created', v_created, 'confirmed', v_confirmed);
end;
$fn$;

-- ★ THE ACTIVATION. One transaction: subscription, cohort run, approval, paid cache,
--   lineage link, audit event, row state. A refusal is a committed `blocked` state with a
--   reason; an unexpected error rolls everything back and the endpoint marks the row failed.
create or replace function public.legacy_import_activate_row(p_actor uuid, p_row_id uuid, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row    public.student_import_rows%rowtype;
  v_job    public.student_import_jobs%rowtype;
  v_plan   public.enrollment_plans%rowtype;
  v_batch  public.batches%rowtype;
  v_prof   public.profiles%rowtype;
  v_email  text;
  v_start  timestamptz;
  v_end    timestamptz;
  v_grace  timestamptz;
  v_status text;
  v_sub_id uuid;
  v_grant  jsonb;
  v_run    uuid;
  v_block  text;
  v_sd     date;
  v_ed     date;
begin
  perform public.legacy_import_require(p_actor);

  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activating'
     or v_row.activation_run_id is distinct from p_run_id then
    perform public.app_error('LEGACY_ROW_NOT_READY', 'That row is not being activated by this run.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  select * into v_job from public.student_import_jobs where id = v_row.job_id;
  if v_job.discarded_at is not null then
    perform public.app_error('LEGACY_JOB_BUSY', 'That migration job was discarded.', 409, null);
  end if;
  if v_row.target_user_id is null then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH', 'No account is bound to this row yet.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_row.target_user_id;
  if v_email is null or v_email is distinct from v_row.email_normalized then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH',
      'The bound account does not match this row''s email.', 409, jsonb_build_object('row_id', p_row_id));
  end if;

  -- ★ EFFECTIVE TERMS: what the Super Admin assigned at activation, else what the roster
  --   said. The roster columns stay untouched as the record of the legacy purchase.
  v_sd := coalesce(v_row.activation_start_date, v_row.legacy_start_date);
  v_ed := coalesce(v_row.activation_end_date, v_row.legacy_end_date);
  select * into v_plan from public.enrollment_plans where key = coalesce(v_row.activation_plan_key, v_row.proposed_plan_key);
  select * into v_batch from public.batches where id = coalesce(v_row.activation_batch_id, v_row.proposed_batch_id);
  select * into v_prof from public.profiles where id = v_row.target_user_id for update;
  select t.started_at, t.ends_at, t.grace_ends_at into v_start, v_end, v_grace
    from public.legacy_import_term(v_sd, v_ed) t;

  v_block := case
    when v_row.validation_status is distinct from 'valid' then 'not_valid'
    when v_row.legacy_payment_status is distinct from 'paid' then 'payment_not_paid'
    when v_plan.key is null or not v_plan.active then 'plan_inactive'
    when v_sd is null or v_ed is null or v_ed < v_sd then 'date_order'
    when v_grace <= now() then 'term_ended'
    when v_prof.id is null then 'identity_mismatch'
    when v_prof.approval_status = 'rejected' then 'profile_rejected'
    when exists (select 1 from public.staff_memberships m
                  where m.user_id = v_prof.id and m.status in ('invited', 'active')) then 'staff_account'
    when v_plan.community_segment = 'vip' and v_batch.id is null then 'batch_unknown'
    -- Only a plan that takes a cohort seat cares: a non-VIP plan grants no batch at all.
    when v_plan.community_segment = 'vip' and v_batch.id is not null and v_batch.status = 'archived' then 'batch_archived'
    when exists (select 1 from public.subscriptions s
                  where s.user_id = v_prof.id
                    and (s.status = 'scheduled'
                         or (s.status = 'active' and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now()))))
      then 'membership_conflict'
    when v_row.external_user_id is not null
         and exists (select 1 from public.student_external_accounts a
                      where a.source = 'thinkific' and a.external_user_id = v_row.external_user_id
                        and a.user_id <> v_prof.id) then 'external_id_conflict'
  end;

  if v_block is not null then
    update public.student_import_rows
       set activation_state = 'blocked', blocked_reason = v_block, activation_claimed_at = null, updated_at = now()
     where id = p_row_id;
    perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'activation_blocked', v_block,
      jsonb_build_object('run_id', p_run_id));
    return jsonb_build_object('ok', false, 'outcome', 'blocked', 'reason', v_block);
  end if;

  -- An 'active' row whose grace ended but whose status was never swept is not a live
  -- membership; expire it (what expire_overdue_subscriptions() does) so it cannot trip
  -- subscriptions_one_active.
  update public.subscriptions s
     set status = 'expired', updated_at = now()
   where s.user_id = v_prof.id and s.status = 'active'
     and s.ends_at is not null and coalesce(s.grace_ends_at, s.ends_at) <= now();

  v_status := case when v_start > now() then 'scheduled' else 'active' end;
  insert into public.subscriptions (
    user_id, plan_key, status, started_at, ends_at, grace_ends_at, approved_by,
    grant_source, source_import_row_id, batch_id)
  values (
    v_prof.id, v_plan.key, v_status, v_start, v_end, v_grace, p_actor,
    'import', p_row_id, case when v_plan.community_segment = 'vip' then v_batch.id end)
  returning id into v_sub_id;

  -- ★ The cohort run comes from the LIVE registry, sized by the plan's own run length
  --   (never six-month arithmetic), capacity-exempt as every import is, and attributed
  --   to the Super Admin who activated it.
  if v_plan.community_segment = 'vip' then
    if v_batch.status = 'open' then
      v_grant := public.grant_batch_run(v_prof.id, 'vip', v_batch.id,
        public.plan_eligible_batch_count(v_plan.key), 'import', v_sub_id, v_plan.key, null,
        p_row_id, v_grace, p_actor, false);
    else
      v_grant := public.legacy_import_grant_closed_start_run(v_prof.id, 'vip', v_batch.id,
        public.plan_eligible_batch_count(v_plan.key), 'import', v_sub_id, v_plan.key, null,
        p_row_id, v_grace, p_actor, false);
    end if;
    v_run := nullif(v_grant->>'run_id', '')::uuid;
  end if;

  -- ★ is_paid is set for a SCHEDULED term too, deliberately. It grants nothing on the
  --   server (every access predicate reads subscriptions.status = 'active'); the client
  --   reads it only when its subscription query FAILS, and there `false` would show a
  --   paid student the price list — the #50 rule, never quote a price to an identity you
  --   could not read. With the read working, enrollGateState() checks 'scheduled' first.
  update public.profiles p
     set approval_status = case when p.approval_status = 'pending' then 'approved' else p.approval_status end,
         approved_at = case when p.approval_status = 'pending' then now() else p.approved_at end,
         approved_by = case when p.approval_status = 'pending' then p_actor else p.approved_by end,
         -- An account that has never signed in sets its password through the claim link.
         -- A pre-existing one is stamped HERE, only now that the grant has succeeded.
         account_origin = case when v_row.existing_confirmed then p.account_origin else 'import' end,
         onboarding_status = case when v_row.existing_confirmed or p.onboarding_status = 'completed'
                                  then p.onboarding_status else 'invited' end,
         invited_at = case when v_row.existing_confirmed then p.invited_at else coalesce(p.invited_at, now()) end,
         is_paid = true,
         plan = v_plan.key,
         full_name = coalesce(nullif(btrim(p.full_name), ''),
                              nullif(btrim(concat_ws(' ', v_row.mapped->>'first_name', v_row.mapped->>'last_name')), '')),
         updated_at = now()
   where p.id = v_prof.id;

  if v_row.external_user_id is not null then
    insert into public.student_external_accounts (user_id, source, external_user_id, import_job_id, import_row_id)
    values (v_prof.id, 'thinkific', v_row.external_user_id, v_row.job_id, p_row_id)
    on conflict (source, external_user_id) do nothing;
  end if;

  update public.student_import_rows
     set activation_state = 'activated', subscription_id = v_sub_id, entitlement_run_id = v_run,
         subscription_granted = true, activated_at = now(), activated_by = p_actor,
         activation_claimed_at = null, blocked_reason = null, last_error = null,
         invite_state = 'not_sent', updated_at = now()
   where id = p_row_id;

  perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'activated', v_status,
    jsonb_build_object('run_id', p_run_id, 'subscription_id', v_sub_id, 'entitlement_run_id', v_run,
                       'plan_key', v_plan.key, 'batch_code', v_batch.code,
                       'starts_on', v_sd, 'ends_on', v_ed,
                       'terms_assigned', (v_row.activation_plan_key is not null or v_row.activation_batch_id is not null
                                          or v_row.activation_start_date is not null or v_row.activation_end_date is not null),
                       'approved_now', v_prof.approval_status = 'pending',
                       'allocated', coalesce(v_grant->'allocated', '[]'::jsonb),
                       'queued', coalesce((v_grant->>'queued')::int, 0)));

  return jsonb_build_object('ok', true, 'outcome', 'activated', 'status', v_status,
    'subscription_id', v_sub_id, 'entitlement_run_id', v_run,
    'kind', case when v_row.existing_confirmed then 'notify' else 'claim' end);
end;
$fn$;

create or replace function public.legacy_import_mark_failed(
  p_actor uuid, p_row_id uuid, p_run_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job uuid;
  v_code text := left(regexp_replace(coalesce(p_code, 'unexpected'), '[^A-Za-z0-9_:.-]', '', 'g'), 80);
begin
  perform public.legacy_import_require(p_actor);
  update public.student_import_rows
     set activation_state = 'failed', last_error = v_code, activation_claimed_at = null, updated_at = now()
   where id = p_row_id and activation_state = 'activating' and activation_run_id = p_run_id
  returning job_id into v_job;
  if v_job is null then
    return false;
  end if;
  perform public.legacy_import_log(v_job, p_row_id, p_actor, 'activation_failed', v_code,
    jsonb_build_object('run_id', p_run_id));
  return true;
end;
$fn$;

-- Reserve the next invitation generation and hand the endpoint what the email needs.
-- ★ A fresh link can invalidate the previous one, so every mint is a NEW generation with
--   a new idempotency key; the same key is never reused with a different token.
create or replace function public.legacy_import_begin_invite(p_actor uuid, p_row_id uuid, p_resend boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row   public.student_import_rows%rowtype;
  v_prof  public.profiles%rowtype;
  v_sub   public.subscriptions%rowtype;
  v_email text;
  v_kind  text;
  v_gen   int;
begin
  perform public.legacy_import_require(p_actor);
  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activated' then
    perform public.app_error('LEGACY_ROW_NOT_READY', 'Only an activated row can be sent an invitation.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  if not coalesce(p_resend, false) and v_row.invite_state is distinct from 'not_sent' then
    return jsonb_build_object('ok', true, 'skip', true);
  end if;

  select * into v_prof from public.profiles where id = v_row.target_user_id;
  select u.email into v_email from auth.users u where u.id = v_row.target_user_id;
  if v_email is null then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH', 'The account for this row no longer exists.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;

  v_kind := case when v_row.existing_confirmed then 'notify' else 'claim' end;
  if v_kind = 'claim' and v_prof.onboarding_status = 'completed' then
    perform public.app_error('LEGACY_ROW_NOT_READY',
      'The student has already claimed this account; there is nothing to resend.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  if v_row.invite_generation >= 20 then
    perform public.app_error('LEGACY_ROW_NOT_READY', 'This invitation has been sent too many times.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;

  v_gen := v_row.invite_generation + 1;
  update public.student_import_rows
     set invite_generation = v_gen, invite_state = 'sending', invite_code = null, updated_at = now()
   where id = p_row_id;
  perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'invite_started', v_kind,
    jsonb_build_object('generation', v_gen, 'resend', coalesce(p_resend, false)));

  -- ★ THE MEMBERSHIP THIS ROW GRANTED, read from it — not from the import row. A resend after
  --   a Super Admin extended the term must quote the new expiry, and a non-VIP plan holds no
  --   batch even when the roster named one. The row's effective terms are only the fallback
  --   for a subscription that no longer exists.
  select * into v_sub from public.subscriptions where id = v_row.subscription_id;
  return jsonb_build_object(
    'ok', true, 'skip', false, 'generation', v_gen, 'kind', v_kind, 'email', v_email,
    'user_id', v_row.target_user_id, 'full_name', v_prof.full_name,
    'plan_key', coalesce(v_sub.plan_key, v_row.activation_plan_key, v_row.proposed_plan_key),
    'plan_name', (select p.name from public.enrollment_plans p
                   where p.key = coalesce(v_sub.plan_key, v_row.activation_plan_key, v_row.proposed_plan_key)),
    'batch_name', case when v_sub.id is not null
                       then (select b.name from public.batches b where b.id = v_sub.batch_id)
                       else (select b.name from public.batches b
                              where b.id = coalesce(v_row.activation_batch_id, v_row.proposed_batch_id)) end,
    -- An ISO timestamp from the subscription (the email reads it as a Manila date), else
    -- the row's calendar date.
    'start_date', case when v_sub.id is not null then to_jsonb(v_sub.started_at)
                       else to_jsonb(coalesce(v_row.activation_start_date, v_row.legacy_start_date)) end,
    'end_date', case when v_sub.id is not null then to_jsonb(v_sub.ends_at)
                     else to_jsonb(coalesce(v_row.activation_end_date, v_row.legacy_end_date)) end);
end;
$fn$;

create or replace function public.legacy_import_record_delivery(
  p_actor uuid, p_row_id uuid, p_generation int, p_state text, p_code text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job  uuid;
  v_code text := left(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9_:.-]', '', 'g'), 40);
begin
  perform public.legacy_import_require(p_actor);
  if p_state not in ('sent', 'uncertain', 'failed', 'notified') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Unknown delivery state.', 422, null);
  end if;
  -- Only the attempt that holds the current generation may record; a slow answer from a
  -- superseded send cannot overwrite the one that replaced it.
  update public.student_import_rows
     set invite_state = p_state, invite_code = nullif(v_code, ''),
         invite_sent_at = case when p_state in ('sent', 'notified') then now() else invite_sent_at end,
         updated_at = now()
   where id = p_row_id and invite_generation = p_generation and invite_state = 'sending'
  returning job_id into v_job;
  if v_job is null then
    return false;
  end if;
  perform public.legacy_import_log(v_job, p_row_id, p_actor, 'invite_' || p_state, nullif(v_code, ''),
    jsonb_build_object('generation', p_generation));
  return true;
end;
$fn$;

-- Activated rows of a run whose invitation has not gone out yet (a chunk that ran out
-- of time between the grant and the email).
create or replace function public.legacy_import_pending_invites(p_actor uuid, p_run_id uuid, p_limit int)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.legacy_import_require(p_actor);
  return coalesce((
    select array_agg(x.id)
      from (select sr.id
              from public.student_import_rows sr
              join public.student_import_activation_runs ru on ru.id = p_run_id
             where sr.id = any (ru.row_ids)
               and sr.activation_state = 'activated' and sr.invite_state = 'not_sent'
             order by sr.source_row_number
             limit least(greatest(coalesce(p_limit, 1), 1), 20)) x), '{}'::uuid[]);
end;
$fn$;

-- ★ A CLAIM NOBODY IS WORKING IS A FAILURE, NOT AN ACTIVATION IN PROGRESS. A row is
--   `activating` from its claim until legacy_import_activate_row() commits or the endpoint
--   marks it failed. The grant is ONE transaction, so a row still `activating` after
--   longer than any request can live (STALE_CLAIM_MINUTES = 10) was granted nothing, and
--   saying so is safe. Without this a killed function left a row that blocked Discard for
--   good, with Resume — i.e. activating it — the only way out. Internal: callers check.
create or replace function public.legacy_import_fail_stale_claims(p_actor uuid, p_job_id uuid, p_row_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row record;
  v_n   int := 0;
begin
  for v_row in
    update public.student_import_rows sr
       set activation_state = 'failed', last_error = 'stale_claim', activation_claimed_at = null, updated_at = now()
     where sr.job_id = p_job_id
       and (p_row_ids is null or sr.id = any (p_row_ids))
       and sr.activation_state = 'activating'
       and sr.activation_claimed_at < now() - interval '10 minutes'
    returning sr.id, sr.activation_run_id
  loop
    perform public.legacy_import_log(p_job_id, v_row.id, p_actor, 'activation_failed', 'stale_claim',
      jsonb_build_object('run_id', v_row.activation_run_id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$fn$;

-- End one request's work on a run: release its lease and recompute the run's state.
create or replace function public.legacy_import_release_run(
  p_actor uuid, p_run_id uuid, p_lease text, p_pause boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run       public.student_import_activation_runs%rowtype;
  v_counts    jsonb;
  v_remaining int;
  v_status    text;
begin
  perform public.legacy_import_require(p_actor);
  select * into v_run from public.student_import_activation_runs where id = p_run_id for update;
  if v_run.id is null then
    perform public.app_error('LEGACY_RUN_NOT_FOUND', 'That activation run does not exist.', 404,
      jsonb_build_object('run_id', p_run_id));
  end if;

  -- A send that reserved its generation and never recorded an answer (the request died
  -- between the two) may or may not have gone out. After longer than any request can live
  -- it is `uncertain` — shown as "Invitation failed", resent under a NEW generation — and
  -- it stops holding the run open for ever.
  update public.student_import_rows sr
     set invite_state = 'uncertain', invite_code = 'no_answer', updated_at = now()
   where sr.id = any (v_run.row_ids) and sr.invite_state = 'sending'
     and sr.updated_at < now() - interval '10 minutes';
  -- …and a claim that died the same way stops holding it open too.
  perform public.legacy_import_fail_stale_claims(p_actor, v_run.job_id, v_run.row_ids);

  select coalesce(jsonb_object_agg(s.k, s.n), '{}'::jsonb) into v_counts
    from (select case when sr.activation_state = 'activated' and sr.invite_state in ('failed', 'uncertain')
                      then 'invite_problem' else sr.activation_state end as k, count(*) as n
            from public.student_import_rows sr where sr.id = any (v_run.row_ids)
           group by 1) s;
  select count(*) into v_remaining
    from public.student_import_rows sr
   where sr.id = any (v_run.row_ids)
     and (sr.activation_state in ('ready', 'activating')
          or (sr.activation_state = 'activated' and sr.invite_state in ('not_sent', 'sending')));

  -- ★ NOTHING LEFT TO DO IS FINISHED, EVEN WHEN PAUSE WAS ASKED FOR. A run holds its rows
  --   against another run (LEGACY_RUN_BUSY) while it is running or paused, and a FAILED row
  --   is not "remaining" — the same run cannot retry it past the attempt cap. So a paused run
  --   whose only leftovers are failures would hold them for ever, and "Retry failed rows"
  --   (which starts a NEW run, with its own typed confirmation) could never reach them.
  v_status := case when v_run.status = 'cancelled' then 'cancelled'
                   when v_remaining = 0 then 'completed'
                   when coalesce(p_pause, false) then 'paused'
                   else 'running' end;

  update public.student_import_activation_runs
     set lease_owner = case when lease_owner is not distinct from p_lease then null else lease_owner end,
         lease_until = case when lease_owner is not distinct from p_lease then null else lease_until end,
         status = v_status,
         completed_at = case when v_status = 'completed' then coalesce(completed_at, now()) else null end,
         counts = v_counts,
         updated_at = now()
   where id = p_run_id;

  if v_status is distinct from v_run.status and v_status in ('paused', 'completed') then
    perform public.legacy_import_log(v_run.job_id, null, p_actor, 'run_' || v_status, v_status,
      jsonb_build_object('run_id', p_run_id, 'states', v_counts));
  end if;

  return jsonb_build_object('ok', true, 'run_id', p_run_id, 'status', v_status,
                            'remaining', v_remaining, 'states', v_counts);
end;
$fn$;


-- == 6c) Scheduled terms reach their start ====================================
-- ★ NO permission guard, on purpose: pg_cron has no JWT, and a guard is exactly why
--   expire_overdue_subscriptions() can never run under a scheduler (#38's reasoning).
--   Instead it is revoked from every client role and reached through the two wrappers
--   below. With p_user it touches ONLY that member's rows. p_actor is who asked (the
--   Super Admin's "Open due memberships now", or the member's own screen); the cron
--   passes nothing and its events carry no actor.
-- (An earlier draft took p_user alone; drop that overload so a one-argument call resolves.)
drop function if exists public.activate_due_scheduled_subscriptions(uuid);
create or replace function public.activate_due_scheduled_subscriptions(p_user uuid default null, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r           record;
  v_row       record;
  v_activated int := 0;
  v_expired   int := 0;
  v_conflicts int := 0;
begin
  for r in
    select s.id, s.user_id, s.ends_at, s.grace_ends_at, s.source_import_row_id
      from public.subscriptions s
     where s.status = 'scheduled' and s.started_at <= now()
       and (p_user is null or s.user_id = p_user)
     order by s.started_at, s.id
     for update skip locked
  loop
    select sr.id, sr.job_id into v_row from public.student_import_rows sr where sr.id = r.source_import_row_id;

    if coalesce(r.grace_ends_at, r.ends_at) <= now() then
      update public.subscriptions set status = 'expired', updated_at = now() where id = r.id;
      perform public.legacy_import_log(v_row.job_id, v_row.id, p_actor, 'membership_expired_unstarted', 'expired',
        jsonb_build_object('subscription_id', r.id));
      v_expired := v_expired + 1;
      continue;
    end if;

    update public.subscriptions o
       set status = 'expired', updated_at = now()
     where o.user_id = r.user_id and o.id <> r.id and o.status = 'active'
       and o.ends_at is not null and coalesce(o.grace_ends_at, o.ends_at) <= now();

    if exists (select 1 from public.subscriptions o
                where o.user_id = r.user_id and o.id <> r.id and o.status = 'active') then
      if not exists (select 1 from public.student_import_events e
                      where e.row_id = v_row.id and e.kind = 'membership_start_conflict') then
        perform public.legacy_import_log(v_row.job_id, v_row.id, p_actor, 'membership_start_conflict', 'blocked',
          jsonb_build_object('subscription_id', r.id));
      end if;
      v_conflicts := v_conflicts + 1;
      continue;
    end if;

    update public.subscriptions set status = 'active', updated_at = now() where id = r.id;
    perform public.legacy_import_log(v_row.job_id, v_row.id, p_actor, 'membership_started', 'active',
      jsonb_build_object('subscription_id', r.id));
    v_activated := v_activated + 1;
  end loop;

  return jsonb_build_object('ok', true, 'activated', v_activated, 'expired', v_expired, 'conflicts', v_conflicts);
end;
$fn$;

-- The student's own screen calls this on load and on focus, so a missed cron run can
-- never keep a paid member out on their first day. It can only do what the cron would.
create or replace function public.activate_my_due_membership()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', true, 'activated', 0, 'expired', 0, 'conflicts', 0);
  end if;
  return public.activate_due_scheduled_subscriptions(auth.uid(), auth.uid());
end;
$fn$;

create or replace function public.admin_activate_due_memberships()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.legacy_import_require(auth.uid());
  return public.activate_due_scheduled_subscriptions(null, auth.uid());
end;
$fn$;


-- == 6d) The Super Admin's own RPCs ===========================================

create or replace function public.legacy_import_jobs_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.legacy_import_require(auth.uid());
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (select j.id, j.filename, left(j.content_sha256, 12) as fingerprint, j.status, j.created_at,
                   j.updated_at, j.discarded_at, j.total_rows, j.eligible_batch_codes, j.date_format,
                   j.purged_at,
                   (select p.full_name from public.profiles p where p.id = j.created_by) as created_by_name,
                   (select coalesce(jsonb_object_agg(s.activation_state, s.n), '{}'::jsonb)
                      from (select r.activation_state, count(*) as n from public.student_import_rows r
                             where r.job_id = j.id group by r.activation_state) s) as states,
                   (select count(*) from public.student_import_rows r
                     where r.job_id = j.id and r.activation_state = 'activated'
                       and r.invite_state in ('failed', 'uncertain')) as invite_problems,
                   exists (select 1 from public.student_import_activation_runs ru
                            where ru.job_id = j.id and ru.status in ('running', 'paused')) as run_open
              from public.student_import_jobs j
             where j.pipeline = 'legacy_v2'
             order by j.created_at desc
             limit 100) x), '[]'::jsonb);
end;
$fn$;

create or replace function public.legacy_import_job_summary(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job public.student_import_jobs%rowtype;
begin
  perform public.legacy_import_require(auth.uid());
  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2';
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404,
      jsonb_build_object('job_id', p_job_id));
  end if;
  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'filename', v_job.filename, 'fingerprint', left(v_job.content_sha256, 12),
      'status', v_job.status, 'created_at', v_job.created_at, 'discarded_at', v_job.discarded_at,
      'discard_reason', v_job.discard_reason, 'purged_at', v_job.purged_at, 'total_rows', v_job.total_rows,
      'date_format', v_job.date_format, 'plan_mapping', v_job.plan_mapping, 'batch_mapping', v_job.batch_mapping,
      'eligible_batch_codes', to_jsonb(v_job.eligible_batch_codes),
      'created_by_name', (select p.full_name from public.profiles p where p.id = v_job.created_by)),
    'cohorts', (select coalesce(jsonb_agg(to_jsonb(c) order by c.batch_code nulls last), '[]'::jsonb)
                  from (select b.code as batch_code, b.name as batch_name, b.status as batch_status,
                               count(*) as total,
                               count(*) filter (where sr.activation_state = 'ready') as ready,
                               count(*) filter (where sr.activation_state = 'inactive') as inactive,
                               count(*) filter (where sr.activation_state = 'blocked') as blocked,
                               count(*) filter (where sr.activation_state in ('activating', 'failed')) as in_progress,
                               count(*) filter (where sr.activation_state = 'failed') as failed,
                               count(*) filter (where sr.activation_state = 'activated') as activated,
                               count(*) filter (where sr.activation_state = 'reverted') as reverted
                          from public.student_import_rows sr
                          left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)
                         where sr.job_id = p_job_id
                         group by b.code, b.name, b.status) c),
    'invites', (select jsonb_build_object(
                  'not_sent', count(*) filter (where sr.invite_state = 'not_sent'),
                  'sending', count(*) filter (where sr.invite_state = 'sending'),
                  'sent', count(*) filter (where sr.invite_state = 'sent'),
                  'notified', count(*) filter (where sr.invite_state = 'notified'),
                  'failed', count(*) filter (where sr.invite_state in ('failed', 'uncertain')),
                  'claimed', count(*) filter (where p.onboarding_status = 'completed' and not sr.existing_confirmed))
                  from public.student_import_rows sr
                  left join public.profiles p on p.id = sr.target_user_id
                 where sr.job_id = p_job_id and sr.activation_state = 'activated'),
    'runs', (select coalesce(jsonb_agg(to_jsonb(ru) order by ru.created_at desc), '[]'::jsonb)
               from (select r.id, r.status, cardinality(r.row_ids) as count, r.counts, r.created_at,
                            r.updated_at, r.completed_at, (r.lease_until > now()) as leased
                       from public.student_import_activation_runs r
                      where r.job_id = p_job_id
                      order by r.created_at desc limit 10) ru));
end;
$fn$;

create or replace function public.legacy_import_rows_page(
  p_job_id uuid, p_state text default null, p_batch_code text default null,
  p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_like  text;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
  v_out   jsonb;
begin
  perform public.legacy_import_require(auth.uid());
  if nullif(btrim(p_search), '') is not null then
    v_like := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with base as (
    select sr.*, b.code as batch_code, b.name as batch_name, p.onboarding_status, p.email as profile_email,
           p.onboarding_completed_at, s.status as subscription_status, j.created_at as imported_at, j.source as import_source,
           rb.code as roster_batch_code, rb.name as roster_batch_name
      from public.student_import_rows sr
      join public.student_import_jobs j on j.id = sr.job_id
      left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)
      left join public.batches rb on rb.id = sr.proposed_batch_id
      left join public.profiles p on p.id = sr.target_user_id
      left join public.subscriptions s on s.id = sr.subscription_id
     where sr.job_id = p_job_id
       and (p_batch_code is null or b.code = p_batch_code)
       and (p_state is null
            or sr.activation_state = p_state
            or (p_state = 'invite_problem' and sr.activation_state = 'activated'
                and sr.invite_state in ('failed', 'uncertain'))
            or (p_state = 'claimed' and sr.activation_state = 'activated'
                and p.onboarding_status = 'completed' and not sr.existing_confirmed))
       and (v_like is null
            or lower(coalesce(sr.email_normalized, p.email, '')) like v_like
            or lower(coalesce(sr.mapped->>'first_name', '') || ' ' || coalesce(sr.mapped->>'last_name', '')) like v_like)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'source_row_number', x.source_row_number,
        'email', coalesce(x.email_display, x.email_normalized, x.profile_email),
        'first_name', x.mapped->>'first_name', 'last_name', x.mapped->>'last_name',
        'external_user_id', x.external_user_id, 'identity_basis', x.identity_basis,
        'plan_key', coalesce(x.activation_plan_key, x.proposed_plan_key), 'legacy_plan_label', x.legacy_plan_label,
        'batch_code', x.batch_code, 'batch_name', x.batch_name, 'legacy_batch_label', x.legacy_batch_label,
        'start_date', coalesce(x.activation_start_date, x.legacy_start_date),
        'end_date', coalesce(x.activation_end_date, x.legacy_end_date),
        -- What the roster said, shown beside anything the Super Admin assigned.
        'roster_plan_key', x.proposed_plan_key, 'roster_batch_code', x.roster_batch_code,
        'roster_batch_name', x.roster_batch_name,
        'roster_start_date', x.legacy_start_date, 'roster_end_date', x.legacy_end_date,
        'terms_assigned', (x.activation_plan_key is not null or x.activation_batch_id is not null
                           or x.activation_start_date is not null or x.activation_end_date is not null),
        'phone', x.legacy_phone, 'import_source', x.import_source, 'imported_at', x.imported_at,
        'onboarding_completed_at', case when x.existing_confirmed then null else x.onboarding_completed_at end,
        'onboarding_notice_state', x.onboarding_notice_state,
        'payment_status', x.legacy_payment_status, 'amount_paid', x.legacy_amount_paid, 'currency', x.legacy_currency,
        'validation_status', x.validation_status, 'activation_state', x.activation_state,
        'invite_state', x.invite_state, 'invite_sent_at', x.invite_sent_at, 'invite_code', x.invite_code,
        'invite_generation', x.invite_generation,
        'errors', x.errors, 'warnings', x.warnings, 'blocked_reason', x.blocked_reason, 'last_error', x.last_error,
        'matched_existing', x.matched_existing, 'existing_confirmed', x.existing_confirmed,
        'attempts', x.attempts, 'activated_at', x.activated_at, 'subscription_status', x.subscription_status,
        'claimed', (x.activation_state = 'activated' and x.onboarding_status = 'completed' and not x.existing_confirmed))
        order by x.source_row_number)
      from (select * from base order by source_row_number limit v_limit offset v_off) x), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$fn$;

-- The READY rows matching a filter — what "select all in this filter" selects — or, with
-- p_state => 'failed', the FAILED rows that "Retry failed rows" activates again. Never an
-- inactive row, whatever the filter, and never more than one run's worth.
-- (An earlier draft had no p_state; drop that overload.)
drop function if exists public.legacy_import_ready_ids(uuid, text, text);
create or replace function public.legacy_import_ready_ids(
  p_job_id uuid, p_batch_code text default null, p_search text default null, p_state text default 'ready')
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_like text;
begin
  perform public.legacy_import_require(auth.uid());
  if coalesce(p_state, '') not in ('ready', 'failed') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Only ready or failed rows can be selected for activation.', 422, null);
  end if;
  if nullif(btrim(p_search), '') is not null then
    v_like := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return coalesce((
    select array_agg(x.id order by x.source_row_number)
      from (select sr.id, sr.source_row_number
              from public.student_import_rows sr
              left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)
             where sr.job_id = p_job_id
               and sr.activation_state = p_state
               and (p_batch_code is null or b.code = p_batch_code)
               and (v_like is null
                    or lower(coalesce(sr.email_normalized, '')) like v_like
                    or lower(coalesce(sr.mapped->>'first_name', '') || ' ' || coalesce(sr.mapped->>'last_name', '')) like v_like)
             order by sr.source_row_number
             limit 200) x), '{}'::uuid[]);
end;
$fn$;

create or replace function public.legacy_import_events(p_job_id uuid, p_row_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.legacy_import_require(auth.uid());
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'row_id', e.row_id, 'kind', e.kind, 'status', e.status, 'detail', e.detail,
             'created_at', e.created_at, 'actor_name', p.full_name)
           order by e.created_at desc)
      from (select * from public.student_import_events ev
             where ev.job_id = p_job_id and (p_row_id is null or ev.row_id = p_row_id)
             order by ev.created_at desc limit 200) e
      left join public.profiles p on p.id = e.actor), '[]'::jsonb);
end;
$fn$;

-- Promote inactive rows to ready, or demote ready rows to inactive. Always with a reason.
create or replace function public.legacy_import_set_eligibility(p_row_ids uuid[], p_eligible boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := left(btrim(coalesce(p_reason, '')), 300);
  v_changed int := 0;
  v_seen    int := 0;
  r         record;
begin
  perform public.legacy_import_require(v_actor);
  if cardinality(coalesce(p_row_ids, '{}'::uuid[])) not between 1 and 500 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Choose between 1 and 500 rows.', 422, null);
  end if;
  if char_length(v_reason) < 5 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Give a reason of at least five characters.', 422, null);
  end if;

  for r in
    select sr.id, sr.job_id, sr.activation_state,
           coalesce(sr.activation_start_date, sr.legacy_start_date) as eff_start,
           coalesce(sr.activation_end_date, sr.legacy_end_date) as eff_end,
           b.status as batch_status, j.discarded_at
      from public.student_import_rows sr
      join public.student_import_jobs j on j.id = sr.job_id and j.pipeline = 'legacy_v2'
      left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)
     where sr.id = any (p_row_ids)
     order by sr.id
     for update of sr
  loop
    v_seen := v_seen + 1;
    if r.discarded_at is not null then
      continue;
    end if;
    if p_eligible and r.activation_state = 'inactive'
       and coalesce(r.batch_status, 'archived') <> 'archived'
       and (select t.grace_ends_at from public.legacy_import_term(r.eff_start, r.eff_end) t) > now() then
      update public.student_import_rows set activation_state = 'ready', updated_at = now() where id = r.id;
      perform public.legacy_import_log(r.job_id, r.id, v_actor, 'row_promoted', 'ready',
        jsonb_build_object('reason', v_reason));
      v_changed := v_changed + 1;
    elsif not p_eligible and r.activation_state = 'ready' then
      update public.student_import_rows set activation_state = 'inactive', updated_at = now() where id = r.id;
      perform public.legacy_import_log(r.job_id, r.id, v_actor, 'row_demoted', 'inactive',
        jsonb_build_object('reason', v_reason));
      v_changed := v_changed + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'changed', v_changed,
                            'skipped', cardinality(p_row_ids) - v_changed, 'found', v_seen);
end;
$fn$;

-- Undo an activation the student has not used yet: a scheduled term, or an unclaimed new
-- account. Cancels the term, revokes the cohort run, clears the paid cache if nothing else
-- is live. The Auth user is never deleted. After a claim, change the membership from
-- Enrollments instead.
create or replace function public.legacy_import_revert(p_row_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
  v_row    public.student_import_rows%rowtype;
  v_sub    public.subscriptions%rowtype;
  v_prof   public.profiles%rowtype;
begin
  perform public.legacy_import_require(v_actor);
  if char_length(v_reason) < 5 then
    perform public.app_error('LEGACY_REVERT_REFUSED', 'Give a reason of at least five characters.', 422, null);
  end if;
  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activated' then
    perform public.app_error('LEGACY_REVERT_REFUSED', 'Only an activated row can be reverted.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  select * into v_sub from public.subscriptions where id = v_row.subscription_id for update;
  select * into v_prof from public.profiles where id = v_row.target_user_id for update;
  if v_sub.id is null
     or not (v_sub.status = 'scheduled'
             or (v_sub.status = 'active' and not v_row.existing_confirmed
                 and coalesce(v_prof.onboarding_status, '') <> 'completed')) then
    perform public.app_error('LEGACY_REVERT_REFUSED',
      'The student has already started using this membership. Change it from Enrollments instead.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;

  update public.subscriptions set status = 'cancelled', updated_at = now() where id = v_sub.id;
  if v_row.entitlement_run_id is not null then
    perform public.revoke_batch_run(v_row.target_user_id, v_row.entitlement_run_id, 'import_reverted', v_actor, 'revoked');
  end if;
  if not exists (select 1 from public.subscriptions s
                  where s.user_id = v_row.target_user_id and s.status in ('active', 'scheduled')) then
    -- plan is NOT NULL (default 'free'); the column's own default is the unpaid value.
    update public.profiles set is_paid = false, plan = default, updated_at = now() where id = v_row.target_user_id;
  end if;
  update public.student_import_rows set activation_state = 'reverted', updated_at = now() where id = p_row_id;
  perform public.legacy_import_log(v_row.job_id, p_row_id, v_actor, 'activation_reverted', 'reverted',
    jsonb_build_object('subscription_id', v_sub.id, 'entitlement_run_id', v_row.entitlement_run_id,
                       'reason', v_reason));
  return jsonb_build_object('ok', true, 'row_id', p_row_id);
end;
$fn$;

-- The remediation for a wrong or superseded roster: discard it, then stage the right one.
create or replace function public.legacy_import_discard_job(p_job_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
  v_job    public.student_import_jobs%rowtype;
begin
  perform public.legacy_import_require(v_actor);
  if char_length(v_reason) < 5 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Give a reason of at least five characters.', 422, null);
  end if;
  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2' for update;
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404, null);
  end if;
  if v_job.discarded_at is not null then
    return jsonb_build_object('ok', true, 'job_id', p_job_id, 'already', true);
  end if;
  -- A claim abandoned by a killed request no longer counts as "still running".
  perform public.legacy_import_fail_stale_claims(v_actor, p_job_id, null);
  if exists (select 1 from public.student_import_rows where job_id = p_job_id and activation_state = 'activating')
     or exists (select 1 from public.student_import_activation_runs
                 where job_id = p_job_id and lease_until > now()) then
    perform public.app_error('LEGACY_JOB_BUSY', 'An activation is still running on this job. Pause it first.', 409, null);
  end if;
  update public.student_import_jobs
     set status = 'discarded', discarded_at = now(), discarded_by = v_actor, discard_reason = v_reason, updated_at = now()
   where id = p_job_id;
  update public.student_import_activation_runs
     set status = 'cancelled', updated_at = now()
   where job_id = p_job_id and status in ('running', 'paused');
  perform public.legacy_import_log(p_job_id, null, v_actor, 'job_discarded', 'discarded',
    jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ok', true, 'job_id', p_job_id, 'already', false);
end;
$fn$;

-- ★ RETENTION. Raw names and addresses are removed from rows whose identity now lives in
--   an account (activated or reverted) and from every row of a discarded job. Provenance
--   stays: the record key, dates, plan, cohort, payment status and amount, the account
--   link and the audit trail.
create or replace function public.legacy_import_purge_raw(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_job   public.student_import_jobs%rowtype;
  v_n     int;
begin
  perform public.legacy_import_require(v_actor);
  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2' for update;
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404, null);
  end if;
  update public.student_import_rows sr
     set mapped = '{}'::jsonb, email_display = null, email_normalized = null, updated_at = now()
   where sr.job_id = p_job_id
     and (v_job.discarded_at is not null
          or (sr.activation_state in ('activated', 'reverted') and sr.target_user_id is not null))
     and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null);
  get diagnostics v_n = row_count;
  if not exists (select 1 from public.student_import_rows sr
                  where sr.job_id = p_job_id
                    and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null)) then
    update public.student_import_jobs set purged_at = coalesce(purged_at, now()), updated_at = now() where id = p_job_id;
  end if;
  perform public.legacy_import_log(p_job_id, null, v_actor, 'job_purged', 'purged', jsonb_build_object('rows', v_n));
  return jsonb_build_object('ok', true, 'purged_rows', v_n);
end;
$fn$;


-- Assign the membership terms a Super Admin chooses at activation: plan, batch, start, end.
-- Each null argument keeps the current value. The roster's own values (legacy_*/proposed_*)
-- are never overwritten; an override equal to the roster value is stored as null, so
-- "assigned" means the Super Admin actually changed something. All or nothing: one invalid
-- row refuses the whole call.
create or replace function public.legacy_import_set_terms(
  p_row_ids uuid[], p_plan_key text, p_batch_id uuid, p_start date, p_end date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := left(btrim(coalesce(p_reason, '')), 300);
  v_plan    public.enrollment_plans%rowtype;
  v_batch   public.batches%rowtype;
  v_changed int := 0;
  v_seen    int := 0;
  r         record;
  v_plan_k  text;
  v_batch_i uuid;
  v_sd      date;
  v_ed      date;
  v_grace   timestamptz;
  v_seg     text;
begin
  perform public.legacy_import_require(v_actor);
  if cardinality(coalesce(p_row_ids, '{}'::uuid[])) not between 1 and 500 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Choose between 1 and 500 rows.', 422, null);
  end if;
  if char_length(v_reason) < 5 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Give a reason of at least five characters.', 422, null);
  end if;
  if p_plan_key is null and p_batch_id is null and p_start is null and p_end is null then
    perform public.app_error('LEGACY_TERMS_INVALID', 'Choose at least one term to change.', 422, null);
  end if;
  if p_plan_key is not null then
    select * into v_plan from public.enrollment_plans where key = p_plan_key;
    if v_plan.key is null or not v_plan.active then
      perform public.app_error('LEGACY_TERMS_INVALID', 'That plan is not an active plan.', 422,
        jsonb_build_object('plan_key', p_plan_key));
    end if;
  end if;
  if p_batch_id is not null then
    select * into v_batch from public.batches where id = p_batch_id;
    if v_batch.id is null or v_batch.status = 'archived' then
      perform public.app_error('LEGACY_TERMS_INVALID', 'That batch does not exist or is archived.', 422,
        jsonb_build_object('batch_id', p_batch_id));
    end if;
  end if;

  for r in
    select sr.*
      from public.student_import_rows sr
      join public.student_import_jobs j on j.id = sr.job_id and j.pipeline = 'legacy_v2' and j.discarded_at is null
     where sr.id = any (p_row_ids)
     order by sr.id
     for update of sr
  loop
    v_seen := v_seen + 1;
    -- Only terms that have not been used yet can change; an activated membership is changed
    -- in Enrollments, where the change is itself a membership event.
    if r.activation_state not in ('ready', 'inactive', 'failed') then
      continue;
    end if;
    -- ★ A row inside an unfinished run was confirmed with the terms the preflight showed; a
    --   change now would grant what the typed confirmation never displayed.
    if exists (select 1 from public.student_import_activation_runs ru
                where ru.job_id = r.job_id and ru.status in ('running', 'paused') and r.id = any (ru.row_ids)) then
      perform public.app_error('LEGACY_RUN_BUSY',
        'Some of these rows are in an unfinished activation. Finish or stop it before changing their terms.', 409,
        jsonb_build_object('row_id', r.id));
    end if;
    v_plan_k  := coalesce(p_plan_key, r.activation_plan_key, r.proposed_plan_key);
    v_batch_i := coalesce(p_batch_id, r.activation_batch_id, r.proposed_batch_id);
    v_sd      := coalesce(p_start, r.activation_start_date, r.legacy_start_date);
    v_ed      := coalesce(p_end, r.activation_end_date, r.legacy_end_date);
    -- Nothing changes for this row: no write and no audit entry, so a retried dialog cannot
    -- record the same assignment twice.
    if v_plan_k is not distinct from coalesce(r.activation_plan_key, r.proposed_plan_key)
       and v_batch_i is not distinct from coalesce(r.activation_batch_id, r.proposed_batch_id)
       and v_sd is not distinct from coalesce(r.activation_start_date, r.legacy_start_date)
       and v_ed is not distinct from coalesce(r.activation_end_date, r.legacy_end_date) then
      continue;
    end if;
    if v_sd is null or v_ed is null or v_ed < v_sd then
      perform public.app_error('LEGACY_TERMS_INVALID', 'A membership must end on or after the day it starts.', 422,
        jsonb_build_object('row_id', r.id));
    end if;
    select t.grace_ends_at into v_grace from public.legacy_import_term(v_sd, v_ed) t;
    if v_grace <= now() then
      perform public.app_error('LEGACY_TERMS_INVALID', 'Those dates end a membership that has already finished.', 422,
        jsonb_build_object('row_id', r.id));
    end if;
    select p.community_segment into v_seg from public.enrollment_plans p where p.key = v_plan_k;
    if v_seg = 'vip' and v_batch_i is null then
      perform public.app_error('LEGACY_TERMS_INVALID', 'A VIP membership needs a batch.', 422,
        jsonb_build_object('row_id', r.id));
    end if;

    update public.student_import_rows sr
       set activation_plan_key   = case when v_plan_k is not distinct from sr.proposed_plan_key then null else v_plan_k end,
           activation_batch_id   = case when v_batch_i is not distinct from sr.proposed_batch_id then null else v_batch_i end,
           activation_start_date = case when v_sd is not distinct from sr.legacy_start_date then null else v_sd end,
           activation_end_date   = case when v_ed is not distinct from sr.legacy_end_date then null else v_ed end,
           updated_at = now()
     where sr.id = r.id;
    perform public.legacy_import_log(r.job_id, r.id, v_actor, 'terms_set', 'assigned',
      jsonb_build_object('reason', v_reason,
        'before', jsonb_build_object(
          'plan_key', coalesce(r.activation_plan_key, r.proposed_plan_key),
          'batch_id', coalesce(r.activation_batch_id, r.proposed_batch_id),
          'start', coalesce(r.activation_start_date, r.legacy_start_date),
          'end', coalesce(r.activation_end_date, r.legacy_end_date)),
        'after', jsonb_build_object('plan_key', v_plan_k, 'batch_id', v_batch_i, 'start', v_sd, 'end', v_ed)));
    v_changed := v_changed + 1;
  end loop;

  return jsonb_build_object('ok', true, 'changed', v_changed,
                            'skipped', cardinality(p_row_ids) - v_changed, 'found', v_seen);
end;
$fn$;


-- == 6f) The migrated student's own account setup ==============================
-- The first two are pinned to auth.uid(): a student reaches only their own row, and no
-- argument can name anyone else. The third is service-only (see its comment).

-- ★ #26's no-argument form is REPLACED, not overloaded: two forms would make the
--   no-argument call ambiguous. The name is taken once, while onboarding completes; after
--   that it is changed through support, like every other profile field (profiles has no
--   user UPDATE policy).
drop function if exists public.complete_import_onboarding();
create or replace function public.complete_import_onboarding(p_full_name text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_name text := nullif(left(btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g')), 120), '');
begin
  update public.profiles
     set onboarding_status = 'completed',
         onboarding_completed_at = coalesce(onboarding_completed_at, now()),
         full_name = coalesce(v_name, full_name),
         updated_at = now()
   where id = auth.uid()
     and account_origin = 'import'
     and onboarding_status <> 'completed';
end;
$fn$;

-- The onboarding summary: what this student now has. Their own row only.
create or replace function public.my_migration_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
           'full_name', p.full_name, 'email', coalesce(u.email, p.email),
           'plan_key', s.plan_key, 'plan_name', ep.name,
           'batch_code', b.code, 'batch_name', b.name,
           'status', s.status, 'started_at', s.started_at, 'ends_at', s.ends_at,
           'grace_ends_at', s.grace_ends_at)
    from public.profiles p
    join auth.users u on u.id = p.id
    left join lateral (select s1.* from public.subscriptions s1
                        where s1.user_id = p.id
                        order by (s1.status in ('active', 'scheduled')) desc, s1.started_at desc nulls last
                        limit 1) s on true
    left join public.enrollment_plans ep on ep.key = s.plan_key
    left join public.batches b on b.id = s.batch_id
   where p.id = auth.uid()
$fn$;

-- ★ THE TWO "YOU'RE IN" EMAILS ARE SENT ONCE, AND ONLY THE SERVER SAYS SO. SERVICE-ONLY:
--   api/notify-enrollment.js verifies the student's JWT and passes THAT uid. With no result
--   it reserves the send (state 'sending') and returns the facts the emails need, all read
--   here, never from the request; with 'sent'/'failed' it records the outcome. It used to be
--   granted to `authenticated` and pinned to auth.uid(), which let a student call the record
--   half directly — mark 'sent' so the admin was never told, or loop reserve→'failed' into
--   the append-only event log. 'sent' is final; a 'sending' left by a dead request may be
--   taken again after two minutes (the provider's idempotency key de-duplicates that
--   repeat); and there are at most five reservations per row.
drop function if exists public.legacy_import_onboarding_notice(text);
create or replace function public.legacy_import_onboarding_notice(p_user uuid, p_result text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid  uuid := p_user;
  v_row  public.student_import_rows%rowtype;
  v_prof public.profiles%rowtype;
  v_sub  public.subscriptions%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'skip', 'no_session');
  end if;
  select sr.* into v_row
    from public.student_import_rows sr
   where sr.target_user_id = v_uid and sr.activation_state = 'activated' and not sr.existing_confirmed
   order by sr.activated_at desc nulls last
   limit 1
   for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'skip', 'not_migrated');
  end if;

  if p_result is not null then
    if p_result not in ('sent', 'failed') then
      perform public.app_error('LEGACY_STAGE_INVALID', 'Unknown onboarding notice result.', 422, null);
    end if;
    update public.student_import_rows
       set onboarding_notice_state = p_result, onboarding_notice_at = now(), updated_at = now()
     where id = v_row.id and onboarding_notice_state = 'sending';
    if found then
      perform public.legacy_import_log(v_row.job_id, v_row.id, v_uid, 'onboarding_notice_' || p_result, p_result,
        '{}'::jsonb);
    end if;
    return jsonb_build_object('ok', true);
  end if;

  select * into v_prof from public.profiles where id = v_uid;
  if v_prof.onboarding_status is distinct from 'completed' then
    return jsonb_build_object('ok', false, 'skip', 'not_onboarded');
  end if;
  if v_row.onboarding_notice_state = 'sent' then
    return jsonb_build_object('ok', false, 'skip', 'sent');
  end if;
  if v_row.onboarding_notice_state = 'sending' and v_row.onboarding_notice_at > now() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'skip', 'in_progress');
  end if;
  if v_row.onboarding_notice_attempts >= 5 then
    return jsonb_build_object('ok', false, 'skip', 'exhausted');
  end if;

  update public.student_import_rows
     set onboarding_notice_state = 'sending', onboarding_notice_at = now(),
         onboarding_notice_attempts = onboarding_notice_attempts + 1, updated_at = now()
   where id = v_row.id;
  select * into v_sub from public.subscriptions where id = v_row.subscription_id;

  return jsonb_build_object(
    'ok', true, 'row_id', v_row.id,
    'full_name', v_prof.full_name,
    'email', (select u.email from auth.users u where u.id = v_uid),
    'plan_key', v_sub.plan_key,
    'plan_name', (select p.name from public.enrollment_plans p where p.key = v_sub.plan_key),
    'batch_name', (select b.name from public.batches b where b.id = v_sub.batch_id),
    'status', v_sub.status, 'started_at', v_sub.started_at, 'ends_at', v_sub.ends_at,
    'onboarded_at', v_prof.onboarding_completed_at);
end;
$fn$;


-- == 6e) Grants ===============================================================
-- Internal and service-only: the endpoint (service_role) and nothing else.
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.legacy_import_require(uuid)',
    'public.legacy_import_log(uuid,uuid,uuid,text,text,jsonb)',
    'public.legacy_import_safe_date(text)',
    'public.legacy_import_record_key(text,text,text,text)',
    'public.legacy_import_term(date,date)',
    'public.legacy_import_preview_allocation(text,integer)',
    'public.legacy_import_grant_closed_start_run(uuid,text,uuid,integer,text,uuid,text,uuid,uuid,timestamptz,uuid,boolean)',
    'public.legacy_import_stage(uuid,jsonb,jsonb)',
    'public.legacy_import_find_auth_user(uuid,text)',
    'public.legacy_import_preflight(uuid,uuid,uuid[])',
    'public.legacy_import_start_run(uuid,uuid,uuid[],text,text)',
    'public.legacy_import_claim_rows(uuid,uuid,text,integer,boolean,uuid[])',
    'public.legacy_import_bind_user(uuid,uuid,uuid,uuid,boolean)',
    'public.legacy_import_activate_row(uuid,uuid,uuid)',
    'public.legacy_import_mark_failed(uuid,uuid,uuid,text)',
    'public.legacy_import_begin_invite(uuid,uuid,boolean)',
    'public.legacy_import_record_delivery(uuid,uuid,integer,text,text)',
    'public.legacy_import_pending_invites(uuid,uuid,integer)',
    'public.legacy_import_release_run(uuid,uuid,text,boolean)',
    'public.legacy_import_fail_stale_claims(uuid,uuid,uuid[])',
    'public.activate_due_scheduled_subscriptions(uuid,uuid)',
    'public.legacy_import_onboarding_notice(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- A Super Admin's own session (each gated inside), and the student's self-heal.
  foreach f in array array[
    'public.legacy_import_jobs_list()',
    'public.legacy_import_job_summary(uuid)',
    'public.legacy_import_rows_page(uuid,text,text,text,integer,integer)',
    'public.legacy_import_ready_ids(uuid,text,text,text)',
    'public.legacy_import_events(uuid,uuid)',
    'public.legacy_import_set_eligibility(uuid[],boolean,text)',
    'public.legacy_import_revert(uuid,text)',
    'public.legacy_import_discard_job(uuid,text)',
    'public.legacy_import_purge_raw(uuid)',
    'public.legacy_import_set_terms(uuid[],text,uuid,date,date,text)',
    'public.admin_activate_due_memberships()',
    'public.activate_my_due_membership()',
    -- The migrated student's own account setup (each pinned to auth.uid()).
    'public.complete_import_onboarding(text)',
    'public.my_migration_summary()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$grants$;


-- == 7) Access Requests: an imported account is managed in Student Imports =====
-- ★ #50's queue and count and #51's decider, verbatim, plus ONE predicate each. The
--   window this closes: the endpoint creates the Auth user, the profile is born
--   'pending', and the activation then blocks or fails. Without this, that account sits in
--   Access Requests where anyone holding access_requests.review could reject it — a ban the
--   import could not see. The decider refuses exactly what the queue hides (#51's rule),
--   with no Super Admin exemption.

create or replace function public.admin_access_request_queue(
  p_status text default 'pending',
  p_limit  integer default 500
)
returns table (
  id uuid, email text, full_name text, avatar_url text,
  approval_status text, rejection_reason text,
  approved_at timestamptz, rejected_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.email, p.full_name, p.avatar_url,
         p.approval_status, p.rejection_reason,
         p.approved_at, p.rejected_at, p.created_at, p.updated_at
    from public.profiles p
   where public.has_staff_permission('access_requests.review')
     and (p_status is null or p.approval_status = p_status)
     and not exists (
       select 1 from public.staff_memberships m
        where m.user_id = p.id
          and m.status in ('invited', 'active')
     )
     -- #67: a pending import-origin account is managed in Student Imports.
     and not (p.account_origin = 'import' and p.approval_status = 'pending')
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 500), 1000))
$fn$;

create or replace function public.admin_access_request_pending_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(count(*), 0)::integer
    from public.profiles p
   where public.has_staff_permission('access_requests.review')
     and p.approval_status = 'pending'
     and not exists (
       select 1 from public.staff_memberships m
        where m.user_id = p.id
          and m.status in ('invited', 'active')
     )
     -- #67: a pending import-origin account is managed in Student Imports.
     and not (p.account_origin = 'import' and p.approval_status = 'pending')
$fn$;

create or replace function public.admin_review_access_request(
  p_user_id  uuid,
  p_decision text,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prev   text;
  v_staff  text;
begin
  if not public.has_staff_permission('access_requests.review') then
    perform public.app_error('FORBIDDEN',
      'admin_review_access_request: access_requests.review required', 403, null);
  end if;
  if p_decision not in ('approved', 'rejected', 'pending') then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      format('unknown decision %s', p_decision), 422, null);
  end if;

  -- #50: segregation of duties. Deciding on your own signup is not a review.
  if p_user_id = (select auth.uid()) and not public.is_super_admin() then
    perform public.app_error('ACCESS_REQUEST_SELF_REVIEW',
      'You cannot decide on your own access request — ask a Super Admin to review it.', 403,
      jsonb_build_object('user_id', p_user_id));
  end if;

  -- #51: the decider refuses exactly what the queue hides. suspended and revoked
  -- stay reviewable — a former staff member may be a real student.
  select m.status into v_staff
    from public.staff_memberships m
   where m.user_id = p_user_id
     and m.status in ('invited', 'active');
  if v_staff is not null then
    perform public.app_error('ACCESS_REQUEST_STAFF_TARGET',
      'That account is a staff member, not a student awaiting approval. To withdraw '
      'their access use Team & Roles (suspend or revoke the role) — that is the action '
      'that gets recorded.', 409,
      jsonb_build_object('user_id', p_user_id, 'staff_status', v_staff));
  end if;

  -- #67: the decider refuses exactly what the queue hides. A pending import-origin account
  -- is being set up by the migration; admitting or banning it here would happen behind the
  -- migration's back. No Super Admin exemption, as #51.
  if exists (select 1 from public.profiles pi
              where pi.id = p_user_id and pi.account_origin = 'import' and pi.approval_status = 'pending') then
    perform public.app_error('ACCESS_REQUEST_IMPORT_TARGET',
      'That account is a migrated student still being set up. Manage it from Student Imports.', 409,
      jsonb_build_object('user_id', p_user_id));
  end if;

  select approval_status into v_prev from public.profiles where id = p_user_id for update;
  if v_prev is null then
    perform public.app_error('STAFF_NOT_FOUND', 'no profile for that user id', 404,
      jsonb_build_object('user_id', p_user_id));
  end if;

  update public.profiles
     set approval_status = p_decision,
         approved_at  = case when p_decision = 'approved' then now() else null end,
         approved_by  = case when p_decision = 'approved' then auth.uid() else null end,
         rejected_at  = case when p_decision = 'rejected' then now() else null end,
         rejected_by  = case when p_decision = 'rejected' then auth.uid() else null end,
         rejection_reason = case when p_decision = 'rejected' then p_reason else null end,
         updated_at = now()
   where id = p_user_id;

  return jsonb_build_object('ok', true, 'user_id', p_user_id,
                            'approval_status', p_decision, 'previous', v_prev);
end;
$fn$;


-- == 8) Retire students.import ================================================
-- Section 4 dropped the five policies that read it. Deleting the key (not just its
-- grants) leaves no permission that looks real in Team & Roles and gates nothing.
delete from public.staff_role_permissions where permission_key = 'students.import';
delete from public.staff_permissions where key = 'students.import';


-- == 9) Error catalog =========================================================
--
-- ★ COPIED FROM #65, NOT RETYPED. The 119 inherited rows are byte-identical; the 13
--   migration rows are the only addition (132 total).
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
    ('LEGACY_REVERT_REFUSED',        409, 'The activation cannot be reverted here; the student has started using it.')
  ) as t(code, http, summary);
$cat$;


-- == 10) The scheduler ========================================================
-- Every 15 minutes: an October 12 start (00:00 Manila = 16:00 UTC the day before) opens
-- within a quarter hour, and the student's own screen closes even that gap.
do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('activate-due-scheduled-subscriptions')
    where exists (select 1 from cron.job j where j.jobname = 'activate-due-scheduled-subscriptions');

  perform cron.schedule('activate-due-scheduled-subscriptions', '*/15 * * * *',
                        $c$select public.activate_due_scheduled_subscriptions();$c$);

  raise notice '#67: pg_cron job "activate-due-scheduled-subscriptions" scheduled every 15 minutes.';
exception when others then
  raise notice '#67: could not schedule pg_cron (%). Enable Dashboard → Integrations → Cron, then run: '
               'select cron.schedule(''activate-due-scheduled-subscriptions'', ''*/15 * * * *'', '
               '''select public.activate_due_scheduled_subscriptions();'');', sqlerrm;
end $$;


-- == 11) Close-out ============================================================
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-25-legacy-student-migration.sql', null,
  'legacy student migration (#67): students.legacy_migrate (super_admin only) replaces '
  'students.import (22 permissions / 34 grants). subscriptions.status gains scheduled (NOT VALID '
  'then validated, import-only by shape CHECK, one active-or-scheduled row per member, a named '
  'MEMBERSHIP_SCHEDULED_CONFLICT guard) and a 15-minute pg_cron sweep plus a student self-heal '
  'flip it to active at its start; every access predicate already requires active, so a scheduled '
  'term grants nothing. The import tables lose every client write path (one SELECT policy each); '
  'staging, activation runs, claims, invitations, promotion, reverts and purges are SECURITY '
  'DEFINER functions, service-only or gated on the new permission. One activation is one '
  'transaction: the subscription from source dates in Asia/Manila with 3-day grace, the '
  'batch_entitlements run from the live registry (a closed start batch uses a two-edit copy of '
  'grant_batch_run), profile approval and paid cache, and an immutable audit event. No enrollment '
  'request and no finance posting. Access Requests excludes and refuses pending import-origin '
  'accounts. The four v1 jobs that never granted anything are discarded and purged. Restates '
  'app_error_catalog() (132 codes).')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The permission moved:
--      select count(*) from public.staff_permissions;                       -> 22
--      select count(*) from public.staff_role_permissions;                  -> 34
--      select role_key from public.staff_role_permissions
--       where permission_key = 'students.legacy_migrate';                   -> super_admin only
--      select count(*) from public.staff_permissions where key = 'students.import';  -> 0
--
-- 2) Scheduled terms are wired:
--      select convalidated from pg_constraint where conname = 'subscriptions_status_check';     -> t
--      select tgname from pg_trigger where tgname = 'subscriptions_scheduled_guard';           -> 1 row
--      select jobname, schedule from cron.job where jobname = 'activate-due-scheduled-subscriptions';
--
-- 3) No client can write an import table:
--      select has_table_privilege('authenticated', 'public.student_import_rows', 'insert');   -> f
--      select has_function_privilege('authenticated',
--        'public.legacy_import_activate_row(uuid,uuid,uuid)', 'execute');                     -> f
--
-- 4) The v1 jobs are gone from view:
--      select status, purged_at is not null from public.student_import_jobs where pipeline = 'v1';
--
-- 5) select count(*) from public.app_error_catalog();                     -> 132
--
-- RECOVERY — a row activated in error, before the student claims it: Student Imports →
-- the row → Revert (legacy_import_revert). After a claim, change the membership from
-- Enrollments. No Auth user is ever deleted by this feature.
