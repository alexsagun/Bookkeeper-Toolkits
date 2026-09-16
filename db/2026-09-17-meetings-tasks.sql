-- ═════════════════════════════════════════════════════════════════════════════
-- #62 — Meetings & Tasks: Zoom meetings, invitations, a meetings calendar and a
--       shared staff to-do board (Super Admin only)
-- 2026-09-17
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- The legacy Apps Script "Meetings" module created Zoom meetings from an endpoint that
-- checked nothing, emailed the join link to whatever recipients the browser named (copying
-- a CC list), sent a recurring series' end date as midnight UTC — 08:00 in Manila, so an
-- evening session on the last day was silently dropped — and kept its to-do board in ONE
-- browser's localStorage, so every admin saw a different board and clearing site data
-- deleted it.
--
-- WHAT
--
-- - `meetings.manage`, the 22nd staff permission, held by super_admin ONLY.
-- - meeting_templates (seeded from the five legacy templates, remapped to today's plans),
--   meetings (the app's log of the meetings it created in Zoom — the JOIN link only, never
--   the host start link), staff_tasks (the shared board), and comm_campaigns.meeting_id.
-- - Every table: RLS, exactly one SELECT policy gated on meetings.manage, and no client
--   write path. All mutation goes through the SECURITY DEFINER functions below, each of
--   which checks its permission as its FIRST statement.
-- - ★ An invitation is a #61 `meeting_invite` campaign built HERE from the stored meeting,
--   so the join link and the time in the email are the ones Zoom returned, never text the
--   browser supplied. It goes through #61's server-resolved audience, daily cap, queue,
--   clearance and idempotency, with replies to support and no CC. A request key is
--   REQUIRED, so a retried invitation returns the campaign the first request made.
-- - ★ Cancelling a meeting stops its invitations exactly as cancelling a campaign does, and
--   in the same lock order: the campaign rows first, then their delivery rows.
--
-- NOT HERE
--
-- Zoom itself. api/admin/meetings.js holds the Zoom Server-to-Server credentials, calls
-- Zoom FIRST and then records the meeting with the CALLER's JWT. Zoom and Postgres cannot
-- share a transaction: a meeting in Zoom with no log row still shows in the calendar (the
-- Zoom list is merged in), whereas a log row for a meeting Zoom never created would be a lie.
--
-- Needs #61. Restates the staff seed and app_error_catalog() IN FULL.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-16-communications.sql') then
    raise exception '#62: run db/2026-09-16-communications.sql (#61) first — it owns the invitation queue and the error catalog this file restates.';
  end if;
  if to_regprocedure('public.comm_create_campaign(text,text,text,text,jsonb,text)') is null
     or to_regprocedure('public.has_staff_permission(text)') is null then
    raise exception '#62: comm_create_campaign (#61) and has_staff_permission (#45) are required.';
  end if;
  if (select count(*) from public.staff_permissions) not in (21, 22) then
    raise exception '#62: expected 21 staff permissions before this file (22 on a re-run).';
  end if;
end
$pre$;


-- == 1) Staff capability ======================================================
-- ★ All three blocks are restated IN FULL (test/staffRolesSql.test.mjs diffs the LAST
--   VALUES block against the whole JS matrix). `meetings.manage` goes to super_admin ONLY,
--   and it is LAST, matching STAFF_PERMISSIONS order.

insert into public.staff_roles (key, label, rank, is_protected, description) values
  ('super_admin',      'Super Admin',      100, true,  'Complete product authority, including staff management and the audit trail.'),
  ('operations_admin', 'Operations Admin',  50, false, 'Reviews access requests and payment proofs, grants courses, runs batches and imports, and configures and moderates the community.'),
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
  ('super_admin', 'finance.manage'),
  ('super_admin', 'communications.send'),
  ('super_admin', 'meetings.manage'),
  ('operations_admin', 'access_requests.review'),
  ('operations_admin', 'enrollments.review'),
  ('operations_admin', 'students.assign_courses'),
  ('operations_admin', 'students.import'),
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


-- == 2) Tables ================================================================

create table if not exists public.meeting_templates (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique check (key ~ '^[a-z0-9_]{1,40}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  description     text check (description is null or char_length(description) <= 300),
  topic           text not null check (char_length(btrim(topic)) between 1 and 200),
  duration_min    integer not null check (duration_min between 15 and 480),
  start_time      text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 0 = Sunday … 6 = Saturday (src/lib/meetingSchedule.js). Empty = a one-time meeting.
  weekly_days     integer[] not null default '{}',
  session_count   integer,
  -- The invitation audience the template suggests. The server resolves it again at send time.
  audience        jsonb not null default '{"mode":"all"}'::jsonb,
  active          boolean not null default true,
  position        integer not null default 0,
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  -- ★ Written so a NULL cannot pass: a CHECK accepts NULL, and `session_count between 1 and 50`
  --   is NULL when session_count is.
  constraint meeting_templates_recurrence_shape check (
    (cardinality(weekly_days) = 0 and session_count is null)
    or (cardinality(weekly_days) between 1 and 7 and weekly_days <@ array[0,1,2,3,4,5,6]
        and session_count is not null and session_count between 1 and 50)),
  constraint meeting_templates_audience_shape check (
    jsonb_typeof(audience) = 'object' and coalesce(audience->>'mode', '') in ('all', 'batch', 'plans'))
);
alter table public.meeting_templates enable row level security;
revoke all on table public.meeting_templates from public, anon, authenticated;

-- The five legacy templates, remapped to today's catalog: "Core & Silver" consultations go to
-- QBO + Resume Combo (Core was retired by #39) and "VIP & Gold" coaching to VIP alone (Gold was
-- retired by #39). Weekdays are the legacy Zoom weekly_days minus one.
insert into public.meeting_templates
  (key, name, description, topic, duration_min, start_time, weekly_days, session_count, audience, position) values
  ('qbo_live', 'QuickBooks US Bookkeeping Mastery', 'Recurring · 12 sessions · Mon/Wed/Fri 9:00–11:00 AM · all members',
   'QuickBooks US Bookkeeping Mastery — Live Session', 120, '09:00', '{1,3,5}', 12, '{"mode":"all"}', 1),
  ('weekly_consult', 'Weekly Consultation', 'Recurring · Thursdays 9:00–10:00 AM · QBO + Resume Combo members',
   'Weekly Consultation — QBO + Resume Combo Members', 60, '09:00', '{4}', 12, '{"mode":"plans","plan_keys":["silver_self_paced"]}', 2),
  ('orientation', 'New Batch Orientation & Onboarding', 'One-time · 90 minutes · all members · welcome and platform walkthrough',
   'New Batch Orientation & Onboarding', 90, '10:00', '{}', null, '{"mode":"all"}', 3),
  ('office_hours', 'Weekly Q&A / Office Hours', 'Recurring · Tuesdays 4:00–5:00 PM · open help session',
   'Weekly Q&A / Office Hours', 60, '16:00', '{2}', 12, '{"mode":"all"}', 4),
  ('vip_coaching', 'VIP Group Coaching Call', 'Recurring · Fridays 2:00–3:00 PM · VIP members',
   'VIP Members — Group Coaching Call', 60, '14:00', '{5}', 12, '{"mode":"plans","plan_keys":["vip"]}', 5)
on conflict (key) do nothing;

create table if not exists public.meetings (
  id                uuid primary key default gen_random_uuid(),
  zoom_meeting_id   text not null check (zoom_meeting_id ~ '^[0-9]{6,20}$'),
  topic             text not null check (char_length(btrim(topic)) between 1 and 200),
  -- The FIRST session. A weekly series starts on the first selected weekday on or after the
  -- chosen date, which is what Zoom does.
  starts_at         timestamptz not null,
  duration_min      integer not null check (duration_min between 15 and 480),
  weekly_days       integer[] not null default '{}',
  session_count     integer,
  ends_on           date,
  -- The planned session starts, as previewed (1–50, Zoom's own ceiling). Zoom stays the
  -- authority for changes made in Zoom itself; the calendar merges both.
  sessions          timestamptz[] not null,
  -- ★ The JOIN link only. Zoom's start_url makes whoever holds it the host, so it is never
  --   read from Zoom's response into this table, a log line or an email.
  join_url          text check (join_url is null or (join_url ~ '^https://' and char_length(join_url) <= 500)),
  template_key      text check (template_key is null or template_key ~ '^[a-z0-9_]{1,40}$'),
  -- ★ Only the shape a LATER invitation can reuse is kept. meeting_record normalises before it
  --   inserts, so a pasted address list (mode 'manual') is never stored here, never returned by
  --   meetings_list, and never readable under meetings.manage alone: recipients stay behind #61's
  --   communications.send, which is the only permission that may see who was emailed.
  audience          jsonb check (audience is null or (jsonb_typeof(audience) = 'object'
                      and coalesce(audience->>'mode', '') in ('all', 'batch', 'plans'))),
  status            text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_by        uuid,
  created_by_email  text,
  created_at        timestamptz not null default now(),
  cancelled_by      uuid,
  cancelled_at      timestamptz,
  constraint meetings_zoom_id_unique unique (zoom_meeting_id),
  constraint meetings_sessions_bounded check (cardinality(sessions) between 1 and 50),
  -- A one-time meeting has neither a count nor an end date; a weekly series has exactly one.
  constraint meetings_recurrence_shape check (
    (cardinality(weekly_days) = 0 and session_count is null and ends_on is null)
    or (cardinality(weekly_days) between 1 and 7 and weekly_days <@ array[0,1,2,3,4,5,6]
        and ((session_count is not null and session_count between 1 and 50 and ends_on is null)
             or (session_count is null and ends_on is not null)))),
  constraint meetings_cancel_shape check ((status = 'cancelled') = (cancelled_at is not null))
);
alter table public.meetings enable row level security;
revoke all on table public.meetings from public, anon, authenticated;
create index if not exists meetings_starts_idx on public.meetings (starts_at);

-- A meeting can be invited more than once (a second audience, a reminder), so the link lives
-- on the campaign. Meetings are cancelled, never deleted; the SET NULL is for completeness.
alter table public.comm_campaigns add column if not exists meeting_id uuid references public.meetings(id) on delete set null;
create index if not exists comm_campaigns_meeting_idx on public.comm_campaigns (meeting_id) where meeting_id is not null;

create table if not exists public.staff_tasks (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(btrim(title)) between 1 and 300),
  scope             text not null default 'day' check (scope in ('day', 'week', 'month')),
  due_on            date,
  done              boolean not null default false,
  done_at           timestamptz,
  done_by           uuid,
  created_by        uuid,
  created_by_email  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint staff_tasks_done_shape check (done = (done_at is not null))
);
alter table public.staff_tasks enable row level security;
revoke all on table public.staff_tasks from public, anon, authenticated;
create index if not exists staff_tasks_open_idx on public.staff_tasks (scope, due_on) where not done;

-- ★ One SELECT policy per table, and nothing else: the finance rule. There is no insert,
--   update or delete policy, and no write grant, so the functions below are the only writers.
do $pol$
declare
  t text;
begin
  foreach t in array array['meeting_templates', 'meetings', 'staff_tasks'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using ((select public.has_staff_permission(''meetings.manage'')))', t || '_read', t);
  end loop;
end
$pol$;


-- == 3) Meetings ==============================================================

-- Written by api/admin/meetings.js with the CALLER's JWT, after Zoom has created the
-- meeting, so the row records who did it. Idempotent on the Zoom id: a retried request
-- returns the row the first one made instead of a duplicate.
create or replace function public.meeting_record(
  p_zoom_meeting_id text, p_topic text, p_starts_at timestamptz, p_duration integer,
  p_weekly_days integer[], p_session_count integer, p_ends_on date, p_sessions timestamptz[],
  p_join_url text, p_template_key text, p_audience jsonb
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_id    uuid;
  v_actor uuid := auth.uid();
  v_email text;
  v_days  integer[] := coalesce((select array_agg(distinct d order by d) from unnest(p_weekly_days) d), '{}');
  -- ★ 'approved_between' and 'manual' carry no reusable shape, and 'manual' carries the recipients
  --   themselves. The invitation has already gone out from the caller's own audience, so nothing is
  --   kept here — NULL, never a fabricated 'all', which would suggest an audience nobody chose.
  v_audience jsonb := case
    when p_audience is null then null
    when p_audience->>'mode' = 'all'   then '{"mode":"all"}'::jsonb
    when p_audience->>'mode' = 'batch' then jsonb_strip_nulls(jsonb_build_object('mode', 'batch', 'batch_id', p_audience->'batch_id'))
    when p_audience->>'mode' = 'plans' then jsonb_strip_nulls(jsonb_build_object('mode', 'plans', 'plan_keys', p_audience->'plan_keys'))
    else null
  end;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  if coalesce(p_zoom_meeting_id, '') !~ '^[0-9]{6,20}$'
     or char_length(btrim(coalesce(p_topic, ''))) not between 1 and 200
     or p_starts_at is null or p_duration is null or p_duration not between 15 and 480
     or coalesce(cardinality(p_sessions), 0) not between 1 and 50
     or exists (select 1 from unnest(p_sessions) s where s is null)
     or (p_join_url is not null and (p_join_url !~ '^https://' or char_length(p_join_url) > 500))
     or (p_template_key is not null and p_template_key !~ '^[a-z0-9_]{1,40}$')
     or (p_audience is not null and jsonb_typeof(p_audience) <> 'object')
     or not (v_days <@ array[0,1,2,3,4,5,6])
     or (cardinality(v_days) = 0 and (p_session_count is not null or p_ends_on is not null))
     or (cardinality(v_days) > 0
         and not ((p_session_count is not null and p_session_count between 1 and 50 and p_ends_on is null)
                  or (p_session_count is null and p_ends_on is not null))) then
    perform public.app_error('MEETING_INVALID', 'The meeting details are incomplete or inconsistent.', 422, null);
  end if;

  select m.id into v_id from public.meetings m where m.zoom_meeting_id = p_zoom_meeting_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'created', false);
  end if;
  select p.email into v_email from public.profiles p where p.id = v_actor;
  insert into public.meetings (zoom_meeting_id, topic, starts_at, duration_min, weekly_days, session_count,
                               ends_on, sessions, join_url, template_key, audience, created_by, created_by_email)
  values (p_zoom_meeting_id, btrim(p_topic), p_starts_at, p_duration, v_days, p_session_count,
          p_ends_on, p_sessions, p_join_url, p_template_key, v_audience, v_actor, v_email)
  on conflict (zoom_meeting_id) do nothing
  returning id into v_id;
  if v_id is null then
    -- A concurrent retry of the same request inserted it first.
    select m.id into v_id from public.meetings m where m.zoom_meeting_id = p_zoom_meeting_id;
    return jsonb_build_object('id', v_id, 'created', false);
  end if;
  return jsonb_build_object('id', v_id, 'created', true);
end;
$fn$;
revoke all on function public.meeting_record(text, text, timestamptz, integer, integer[], integer, date, timestamptz[], text, text, jsonb) from public, anon, authenticated;
grant execute on function public.meeting_record(text, text, timestamptz, integer, integer[], integer, date, timestamptz[], text, text, jsonb) to authenticated;

-- The invitation is built HERE, from the stored meeting, so the join link and the time in
-- the email are the ones Zoom returned — never text the browser supplied.
create or replace function public.meeting_send_invites(p_meeting_id uuid, p_audience jsonb, p_client_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_m        public.meetings%rowtype;
  v_topic    text;
  v_next     timestamptz;
  v_when     text;
  v_repeats  text := '';
  v_subject  text;
  v_body     text;
  v_out      jsonb;
  v_campaign uuid;
  v_kind     text;
  v_linked   uuid;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Inviting students also requires the communications.send permission.', 403, null);
  end if;
  -- ★ Required, not optional: without it a retried invitation would email everyone twice. It is
  --   minted per invitation by the client — never derived from the meeting id, or a deliberate
  --   second invitation to a new audience would return the first one.
  if p_client_key is null or p_client_key !~ '^[A-Za-z0-9-]{8,64}$' then
    perform public.app_error('MEETING_INVALID', 'An invitation needs a request key of 8 to 64 letters, digits or hyphens.', 422, null);
  end if;
  select * into v_m from public.meetings m where m.id = p_meeting_id for update;
  if v_m.id is null then
    perform public.app_error('MEETING_NOT_FOUND', 'The meeting does not exist.', 404, null);
  end if;
  if v_m.status = 'cancelled' then
    perform public.app_error('MEETING_INVALID', 'A cancelled meeting cannot be sent invitations.', 422, null);
  end if;
  if not exists (select 1 from unnest(v_m.sessions) s where s > now()) then
    perform public.app_error('MEETING_INVALID', 'Every session of this meeting has already started.', 422, null);
  end if;

  -- ★ Braces are stripped from what Zoom returned: the sender fills {{tags}} in a subject and a
  --   body, and a meeting topic must never be able to pull a student's details — or the payment
  --   instructions — into an invitation.
  v_topic := btrim(regexp_replace(v_m.topic, '[{}]', '', 'g'));
  -- ★ The NEXT session, never the first. starts_at IS the first session, and inviting a series that is
  --   already under way is an ordinary act — the gate above asks only that some session is still to
  --   come — so naming starts_at would tell a new member the programme began weeks ago. That gate
  --   guarantees a row here; the coalesce only stops a later change to it producing an empty date.
  select min(s) into v_next from unnest(v_m.sessions) s where s > now();
  v_when := to_char(coalesce(v_next, v_m.starts_at) at time zone 'Asia/Manila', 'FMDay, FMMonth FMDD, YYYY') || ' at '
         || to_char(coalesce(v_next, v_m.starts_at) at time zone 'Asia/Manila', 'FMHH12:MI AM') || ' (Manila time)';
  if cardinality(v_m.weekly_days) > 0 then
    v_repeats := E'\nRepeats: every '
      || (select string_agg(to_char(date '2023-01-01' + d, 'FMDay'), ', ' order by d) from unnest(v_m.weekly_days) d)
      || coalesce(' · ' || v_m.session_count || ' sessions', '')
      || coalesce(' · until ' || to_char(v_m.ends_on, 'FMMonth FMDD, YYYY'), '');
  end if;
  v_subject := left('Zoom invitation: ' || v_topic, 200);
  v_body := 'Hi {{first_name}},' || E'\n\n' || 'You are invited to a live Zoom session.' || E'\n\n'
         || 'Topic: ' || v_topic
         || E'\n' || case when v_next is distinct from v_m.starts_at then 'Next session: ' else 'When: ' end || v_when
         || v_repeats
         || E'\nDuration: ' || v_m.duration_min || ' minutes'
         || coalesce(E'\n\nJoin here: ' || regexp_replace(v_m.join_url, '[{}]', '', 'g'), '')
         || E'\n\nSee you there!';

  v_out := public.comm_create_campaign('meeting_invite', 'meeting_invite', v_subject, v_body, p_audience, p_client_key);
  v_campaign := (v_out->>'campaign_id')::uuid;
  -- ★ A replayed request key returns the campaign the first request made. It must be THIS
  --   meeting's invitation; a key that belongs to another message is refused, never relinked.
  select c.kind, c.meeting_id into v_kind, v_linked from public.comm_campaigns c where c.id = v_campaign;
  if v_kind is distinct from 'meeting_invite' or (v_linked is not null and v_linked <> v_m.id) then
    perform public.app_error('MEETING_INVALID', 'That request key belongs to another message.', 422, null);
  end if;
  -- Only an unlinked (just created) campaign is written, so a replay takes no lock on a campaign
  -- row that a sender's clearance or a retry may be holding.
  update public.comm_campaigns set meeting_id = v_m.id where id = v_campaign and meeting_id is null;
  return v_out || jsonb_build_object('meeting_id', v_m.id);
end;
$fn$;
revoke all on function public.meeting_send_invites(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.meeting_send_invites(uuid, jsonb, text) to authenticated;

-- api/admin/meetings.js deletes the meeting in Zoom first, then calls this with the caller's JWT.
create or replace function public.meeting_cancel(p_meeting_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_status  text;
  v_skipped integer := 0;
  v_sending integer := 0;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  select m.status into v_status from public.meetings m where m.id = p_meeting_id for update;
  if v_status is null then
    perform public.app_error('MEETING_NOT_FOUND', 'The meeting does not exist.', 404, null);
  end if;
  if v_status = 'scheduled' then
    update public.meetings set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid() where id = p_meeting_id;
  end if;
  -- ★ Its invitations stop too, as comm_cancel_campaign stops a campaign, and in the SAME lock
  --   order: every campaign row first (in id order), then their delivery rows — the order the
  --   #61 clearance, pause, edit, delete and cancel all keep. A clearance holds its campaign row
  --   in SHARE mode, so one in progress is either refused or counted below, never neither.
  perform 1 from public.comm_campaigns c where c.meeting_id = p_meeting_id order by c.id for update;
  update public.comm_deliveries d
     set status = 'skipped', error_code = 'cancelled', next_attempt_at = null, updated_at = now()
   where d.campaign_id in (select c.id from public.comm_campaigns c where c.meeting_id = p_meeting_id)
     and d.status = 'queued';
  get diagnostics v_skipped = row_count;
  update public.comm_campaigns set cancelled_at = now(), cancelled_by = auth.uid()
   where meeting_id = p_meeting_id and cancelled_at is null;
  select count(*) into v_sending from public.comm_deliveries d
   where d.campaign_id in (select c.id from public.comm_campaigns c where c.meeting_id = p_meeting_id)
     and d.status = 'sending' and d.send_started_at is not null;
  return jsonb_build_object('ok', true, 'already_cancelled', v_status = 'cancelled',
    'skipped', v_skipped, 'in_flight', v_sending);
end;
$fn$;
revoke all on function public.meeting_cancel(uuid) from public, anon, authenticated;
grant execute on function public.meeting_cancel(uuid) to authenticated;

-- The calendar log. Invitation counts add up EVERY invitation campaign of the meeting.
create or replace function public.meetings_list(p_from date, p_to date)
returns table (id uuid, zoom_meeting_id text, topic text, starts_at timestamptz, duration_min integer,
               weekly_days integer[], session_count integer, ends_on date, sessions timestamptz[],
               join_url text, template_key text, audience jsonb, status text, created_by_email text,
               created_at timestamptz, cancelled_at timestamptz,
               invitations bigint, invited bigint, sent bigint, failed bigint, waiting bigint,
               last_invited_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
declare
  v_from timestamptz;
  v_to   timestamptz;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform public.app_error('MEETING_INVALID', 'Choose a date range of up to 400 days.', 422, null);
  end if;
  v_from := p_from::timestamp at time zone 'Asia/Manila';
  v_to   := (p_to + 1)::timestamp at time zone 'Asia/Manila';
  return query
    select m.id, m.zoom_meeting_id, m.topic, m.starts_at, m.duration_min, m.weekly_days, m.session_count,
           m.ends_on, m.sessions, m.join_url, m.template_key, m.audience, m.status, m.created_by_email,
           m.created_at, m.cancelled_at,
           coalesce(c.invitations, 0), coalesce(d.invited, 0), coalesce(d.sent, 0), coalesce(d.failed, 0),
           coalesce(d.waiting, 0), c.last_invited_at
      from public.meetings m
      left join lateral (
        select count(*) as invitations, max(cc.created_at) as last_invited_at
          from public.comm_campaigns cc where cc.meeting_id = m.id) c on true
      left join lateral (
        select count(*) as invited,
               count(*) filter (where x.status = 'sent') as sent,
               count(*) filter (where x.status = 'failed') as failed,
               count(*) filter (where x.status in ('queued', 'sending')) as waiting
          from public.comm_campaigns cc
          join public.comm_deliveries x on x.campaign_id = cc.id
         where cc.meeting_id = m.id) d on true
     where (m.starts_at >= v_from and m.starts_at < v_to)
        or exists (select 1 from unnest(m.sessions) s where s >= v_from and s < v_to)
     order by m.starts_at;
end;
$fn$;
revoke all on function public.meetings_list(date, date) from public, anon, authenticated;
grant execute on function public.meetings_list(date, date) to authenticated;

create or replace function public.meeting_templates_list(p_include_inactive boolean default false)
returns setof public.meeting_templates
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  return query select * from public.meeting_templates t
   where coalesce(p_include_inactive, false) or t.active
   order by t.position, t.name;
end;
$fn$;
revoke all on function public.meeting_templates_list(boolean) from public, anon, authenticated;
grant execute on function public.meeting_templates_list(boolean) to authenticated;

create or replace function public.meeting_template_save(
  p_id uuid, p_name text, p_description text, p_topic text, p_duration integer, p_start_time text,
  p_weekly_days integer[], p_session_count integer, p_audience jsonb
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_id       uuid;
  v_days     integer[] := coalesce((select array_agg(distinct d order by d) from unnest(p_weekly_days) d), '{}');
  v_audience jsonb := coalesce(p_audience, '{"mode":"all"}'::jsonb);
  v_key      text;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120
     or char_length(btrim(coalesce(p_topic, ''))) not between 1 and 200
     or coalesce(char_length(p_description), 0) > 300
     or p_duration is null or p_duration not between 15 and 480
     or coalesce(p_start_time, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or not (v_days <@ array[0,1,2,3,4,5,6])
     or (cardinality(v_days) = 0 and p_session_count is not null)
     or (cardinality(v_days) > 0 and (p_session_count is null or p_session_count not between 1 and 50))
     or jsonb_typeof(v_audience) <> 'object'
     or coalesce(v_audience->>'mode', '') not in ('all', 'batch', 'plans') then
    perform public.app_error('MEETING_INVALID', 'The template needs a name, a topic, a 15–480 minute duration, a start time, 1–50 sessions for a weekly series, and an audience of all members, a batch or packages.', 422, null);
  end if;
  if p_id is null then
    v_key := left(trim(both '_' from regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '_', 'g')), 30)
          || '_' || substr(md5(gen_random_uuid()::text), 1, 6);
    insert into public.meeting_templates (key, name, description, topic, duration_min, start_time, weekly_days,
                                          session_count, audience, position, updated_by)
    values (v_key, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), btrim(p_topic), p_duration, p_start_time,
            v_days, p_session_count, v_audience,
            coalesce((select max(t.position) + 1 from public.meeting_templates t), 1), auth.uid())
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'created', true);
  end if;
  update public.meeting_templates
     set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), topic = btrim(p_topic),
         duration_min = p_duration, start_time = p_start_time, weekly_days = v_days, session_count = p_session_count,
         audience = v_audience, updated_by = auth.uid(), updated_at = now()
   where id = p_id
  returning id into v_id;
  if v_id is null then
    perform public.app_error('MEETING_NOT_FOUND', 'That template no longer exists.', 404, null);
  end if;
  return jsonb_build_object('id', v_id, 'created', false);
end;
$fn$;
revoke all on function public.meeting_template_save(uuid, text, text, text, integer, text, integer[], integer, jsonb) from public, anon, authenticated;
grant execute on function public.meeting_template_save(uuid, text, text, text, integer, text, integer[], integer, jsonb) to authenticated;

create or replace function public.meeting_template_set_active(p_id uuid, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_id uuid;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meetings requires the meetings.manage permission.', 403, null);
  end if;
  update public.meeting_templates set active = coalesce(p_active, false), updated_by = auth.uid(), updated_at = now()
   where id = p_id
  returning id into v_id;
  if v_id is null then
    perform public.app_error('MEETING_NOT_FOUND', 'That template no longer exists.', 404, null);
  end if;
  return jsonb_build_object('id', v_id, 'active', coalesce(p_active, false));
end;
$fn$;
revoke all on function public.meeting_template_set_active(uuid, boolean) from public, anon, authenticated;
grant execute on function public.meeting_template_set_active(uuid, boolean) to authenticated;


-- == 4) The shared to-do board ================================================
-- ★ It lived in ONE browser's localStorage in the legacy app, so each admin saw a different
--   board and clearing site data deleted it. Here it is one shared table.

create or replace function public.staff_tasks_list(p_done_days integer default 30)
returns setof public.staff_tasks
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'The to-do board requires the meetings.manage permission.', 403, null);
  end if;
  return query select * from public.staff_tasks t
   where not t.done
      or t.done_at > now() - make_interval(days => greatest(0, least(coalesce(p_done_days, 30), 365)))
   order by t.done, t.due_on nulls last, t.created_at;
end;
$fn$;
revoke all on function public.staff_tasks_list(integer) from public, anon, authenticated;
grant execute on function public.staff_tasks_list(integer) to authenticated;

create or replace function public.staff_task_save(p_id uuid, p_title text, p_scope text, p_due_on date)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_id    uuid;
  v_actor uuid := auth.uid();
  v_email text;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'The to-do board requires the meetings.manage permission.', 403, null);
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 300 or coalesce(p_scope, '') not in ('day', 'week', 'month') then
    perform public.app_error('TASK_INVALID', 'A task needs a title of up to 300 characters and a day, week or month.', 422, null);
  end if;
  if p_id is null then
    select p.email into v_email from public.profiles p where p.id = v_actor;
    insert into public.staff_tasks (title, scope, due_on, created_by, created_by_email)
    values (btrim(p_title), p_scope, p_due_on, v_actor, v_email)
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'created', true);
  end if;
  update public.staff_tasks set title = btrim(p_title), scope = p_scope, due_on = p_due_on, updated_at = now()
   where id = p_id
  returning id into v_id;
  if v_id is null then
    perform public.app_error('TASK_NOT_FOUND', 'That task no longer exists.', 404, null);
  end if;
  return jsonb_build_object('id', v_id, 'created', false);
end;
$fn$;
revoke all on function public.staff_task_save(uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.staff_task_save(uuid, text, text, date) to authenticated;

create or replace function public.staff_task_set_done(p_id uuid, p_done boolean)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_id uuid;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'The to-do board requires the meetings.manage permission.', 403, null);
  end if;
  update public.staff_tasks
     set done = coalesce(p_done, false),
         done_at = case when coalesce(p_done, false) then coalesce(done_at, now()) end,
         done_by = case when coalesce(p_done, false) then coalesce(done_by, auth.uid()) end,
         updated_at = now()
   where id = p_id
  returning id into v_id;
  if v_id is null then
    perform public.app_error('TASK_NOT_FOUND', 'That task no longer exists.', 404, null);
  end if;
  return jsonb_build_object('id', v_id, 'done', coalesce(p_done, false));
end;
$fn$;
revoke all on function public.staff_task_set_done(uuid, boolean) from public, anon, authenticated;
grant execute on function public.staff_task_set_done(uuid, boolean) to authenticated;

create or replace function public.staff_task_delete(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_id uuid;
begin
  if not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'The to-do board requires the meetings.manage permission.', 403, null);
  end if;
  delete from public.staff_tasks where id = p_id
  returning id into v_id;
  if v_id is null then
    perform public.app_error('TASK_NOT_FOUND', 'That task no longer exists.', 404, null);
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.staff_task_delete(uuid) from public, anon, authenticated;
grant execute on function public.staff_task_delete(uuid) to authenticated;


-- == 5) app_error_catalog() — restated IN FULL ================================
-- #61's catalog, plus MEETING_INVALID, MEETING_NOT_FOUND, TASK_INVALID, TASK_NOT_FOUND,
-- ZOOM_NOT_CONNECTED, ZOOM_REQUEST_FAILED and MEETING_LOG_FAILED (111 codes). The last three
-- are raised by api/admin/meetings.js, not here; they are catalogued so the client's copy
-- table and code list stay the one vocabulary.
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
    ('MEETING_LOG_FAILED',           502, 'The meeting was created in Zoom but could not be recorded here, so no invitations were sent.')
  ) as t(code, http, summary);
$cat$;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-17-meetings-tasks.sql', null,
  'meetings & tasks (#62): meetings.manage (22nd permission, super_admin only); meeting_templates (the five legacy '
  'templates remapped to today''s plans), meetings (the log of the Zoom meetings the app created: the join link only, '
  'never the host start link) and staff_tasks (the shared to-do board), each with one SELECT policy and no client '
  'write path; comm_campaigns.meeting_id. Invitations are #61 meeting_invite campaigns built from the stored meeting '
  'with a REQUIRED request key; cancelling a meeting stops its invitations in the #61 lock order (campaign rows, then '
  'delivery rows). Restates the staff seed and app_error_catalog() (111 codes).')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The permission exists and only Super Admin holds it:
--      select count(*) from public.staff_permissions;                                   -> 22
--      select count(*) from public.staff_role_permissions;                              -> 35
--      select role_key from public.staff_role_permissions
--       where permission_key = 'meetings.manage';                                       -> super_admin
-- 2) Three tables, RLS on, exactly one SELECT policy each:
--      select tablename, count(*) from pg_policies
--       where schemaname = 'public' and tablename in ('meeting_templates', 'meetings', 'staff_tasks')
--       group by tablename;                                                             -> 1 each, cmd SELECT
-- 3) The five templates are seeded:  select count(*) from public.meeting_templates;     -> 5
-- 4) The catalog:                    select count(*) from public.app_error_catalog();   -> 111
-- 5) Owner steps: set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in Vercel (a Zoom
--    Server-to-Server OAuth app with meeting read and write scopes). Until then the Meetings tab
--    says Zoom is not connected, and the to-do board and templates still work.
