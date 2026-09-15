-- ═════════════════════════════════════════════════════════════════════════════
-- #61 — Communications: announcements, student emails, payment reminders,
--       automated notifications and a delivery tracker (Super Admin only)
-- 2026-09-16
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- The legacy Apps Script "Communications" module sent mass email from the owner's
-- mailbox with the recipient list, subject and body all supplied by the browser, to
-- endpoints that checked nothing — an open relay. Its automations de-duplicated by
-- scanning the last 600 log rows, its "weekly" rule fired daily, and its reminder
-- counts were keyed on a SUBJECT PREFIX, so editing the subject reset them.
--
-- WHAT IT ADDS
--
--   * `communications.send` — the 21st staff permission, Super Admin only.
--   * `comm_campaigns` (one row per message), `comm_deliveries` (one row per
--     recipient, with a UNIQUE `dedupe_key`), `comm_automation_rules`, and the
--     singleton `comm_settings` (the daily send cap and the last automation run).
--   * The audience is resolved HERE, never supplied by the browser: all current
--     members, a batch, packages, an approval date range, one enrollment request,
--     selected receivables, or a pasted list of at most 50 addresses. Addresses come
--     from the member's PROFILE, never from the free-text email a student typed into a
--     request form. Membership audiences (all, batch, packages, approval range) never
--     include staff; a pasted address or a single enrollment request is sent as named.
--   * Sending is done by api/admin/communications.js and api/cron/communications.js
--     through three SERVICE-ONLY functions (claim, record, enqueue automations).
--   * `finance_receivables_worklist` gains reminder counts keyed on the enrollment
--     request (not a subject line), plus the package/batch filters deferred from #59.
--
-- ★ NO PAYMENT DETAILS ARE STORED. A payment reminder's {{payment_instructions}} is
--   filled from payment_settings by the server at the moment of sending; a delivery
--   row carries the student's name, plan and balance, never an account number.
--   Reading a payment reminder at all also needs finance.manage.
--
-- ★ A RULE IS BORN PAUSED, AND EDITING OR PAUSING ONE STOPS WHAT IT QUEUED. A BEFORE
--   INSERT trigger forces the first half, so even an SQL-editor insert cannot create a
--   live rule. Turning one on is a separate, deliberate call.
--
-- ★ EVERYTHING IS RE-CHECKED AT THE MOMENT OF SENDING. A cancelled campaign and an
--   inactive rule send nothing; an expiry notice goes out only if the member still holds
--   the same term ending on the same day; a payment reminder recomputes the balance and
--   is dropped when it has been paid. A queued row is a plan, not a promise.
--
-- ★ AUTOMATIONS DE-DUPLICATE ON A KEY, NOT A SCAN. `rule:<rule>:<term>:ends:<date>` for
--   the expiry triggers (so an extended term earns a fresh notice at its new date) and
--   `rule:<rule>:<first term>:week:<n>` for program weeks, counted from the FIRST term of
--   a renewal chain so a renewal does not restart the program at week 1. A run that was
--   missed or capped is caught up on the next one (up to seven days back).
--
-- ★ A FAILED SEND BACKS OFF (1 then 5 minutes) instead of being retried in the same
--   second, and only the attempt that claimed a row may record it. An AMBIGUOUS outcome
--   (a timeout, a claim nobody recorded, a provider 409) keeps its idempotency key, and
--   once it is 20 hours old — the provider's key lasts 24 — it is never sent again.
--
-- SAFETY / ORDERING
--   * Tables are created -> RLS enabled -> grants revoked in adjacent statements.
--   * Every table has exactly ONE policy, a SELECT gated on communications.send (and, for
--     payment-reminder rows, finance.manage); all writes go through SECURITY DEFINER RPCs
--     whose first statement is the communications.send check.
--   * Service-only functions are revoked from public, anon and authenticated.
--
-- LOCKSTEP
--   this file <-> bootstrap fold §48 <-> STAFF_PERMISSIONS / ROLE_PERMISSIONS /
--   ADMIN_TAB_PERMISSION <-> APP_ERROR_CODES + APP_ERROR_COPY <-> src/lib/commTemplates.js
--   <-> api/_lib/commSend.js <-> test/communicationsSql.test.mjs <->
--   test/staffRolesSql.test.mjs (CURRENT_SEED_MIGRATION) <->
--   test/communityStaffSql.test.mjs (CURRENT_CATALOG_MIGRATION) <-> scripts/audit-db.mjs.
-- ═════════════════════════════════════════════════════════════════════════════


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-15-enrollment-management.sql') then
    raise exception '#61: run db/2026-09-15-enrollment-management.sql (#60) first — it owns the error catalog this file restates.';
  end if;
  if to_regprocedure('public.has_staff_permission(text)') is null
     or to_regprocedure('public.is_super_admin()') is null then
    raise exception '#61: the #45 permission helpers are missing.';
  end if;
  if to_regprocedure('public.finance_request_collected(uuid)') is null then
    raise exception '#61: run db/2026-09-09-financial-management.sql (#58) first.';
  end if;
  -- 0 is accepted as well as 1: a re-run after a failure between this file's DROP and
  -- CREATE of the worklist must not be refused by its own preflight.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'finance_receivables_worklist') not in (0, 1) then
    raise exception '#61: expected at most one finance_receivables_worklist.';
  end if;
  if to_regclass('public.batch_entitlements') is null or to_regclass('public.staff_memberships') is null then
    raise exception '#61: batch_entitlements (#35) and staff_memberships (#45) are required.';
  end if;
  if (select count(*) from public.staff_permissions) not in (20, 21) then
    raise exception '#61: expected 20 staff permissions before this file (21 on a re-run).';
  end if;
end
$pre$;


-- == 1) Staff capability ======================================================
-- ★ All three blocks are restated IN FULL (test/staffRolesSql.test.mjs diffs the LAST
--   VALUES block against the whole JS matrix). `communications.send` goes to
--   super_admin ONLY, and it is LAST, matching STAFF_PERMISSIONS order.

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
  ('communications.send',      'Communications', 'Send student communications', 'Send announcements, student emails and payment reminders, run email automations, and read the delivery tracker.')
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

create table if not exists public.comm_settings (
  id                      boolean primary key default true check (id),
  -- Resend's free plan allows 100 emails a day; raise it in Communications → Settings
  -- once the plan covers more. Counted as "sent today + still waiting to send".
  daily_send_cap          integer not null default 100 check (daily_send_cap between 1 and 50000),
  last_automation_run     jsonb,
  last_automation_run_at  timestamptz,
  updated_by              uuid,
  updated_at              timestamptz not null default now()
);
alter table public.comm_settings enable row level security;
revoke all on table public.comm_settings from public, anon, authenticated;
insert into public.comm_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.comm_automation_rules (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  constraint comm_rules_name_present check (nullif(btrim(name), '') is not null and char_length(name) <= 120),
  trigger_kind     text not null check (trigger_kind in ('expiry_exact', 'expiry_within', 'program_week')),
  days             integer,
  scope            text not null default 'all' check (scope in ('all', 'batch', 'plans')),
  scope_batch_id   uuid references public.batches(id),
  scope_plan_keys  text[] not null default '{}',
  subject          text not null check (char_length(subject) between 1 and 200),
  body             text not null check (char_length(body) between 1 and 20000),
  status           text not null default 'paused' check (status in ('paused', 'active')),
  -- Actor columns carry no FK on purpose: the record of who built a rule outlives the account.
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  activated_by     uuid,
  activated_at     timestamptz,
  last_run_on      date,
  last_run_at      timestamptz,
  -- The last day whose matches were ALL queued (nothing held back by the cap). The next run
  -- catches up from here, so a missed or capped day is not silently lost.
  last_complete_on date,
  constraint comm_rules_days_shape check (
    (trigger_kind in ('expiry_exact', 'expiry_within') and days between 0 and 365)
    or (trigger_kind = 'program_week' and days is null)),
  constraint comm_rules_scope_shape check (
    (scope = 'all' and scope_batch_id is null and cardinality(scope_plan_keys) = 0)
    or (scope = 'batch' and scope_batch_id is not null and cardinality(scope_plan_keys) = 0)
    or (scope = 'plans' and scope_batch_id is null and cardinality(scope_plan_keys) between 1 and 20))
);
alter table public.comm_automation_rules enable row level security;
revoke all on table public.comm_automation_rules from public, anon, authenticated;
create index if not exists comm_rules_scope_batch_idx
  on public.comm_automation_rules (scope_batch_id) where scope_batch_id is not null;

create table if not exists public.comm_campaigns (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('announcement', 'payment_reminder', 'student_email', 'meeting_invite')),
  template_key      text check (template_key is null or template_key ~ '^[a-z0-9_]{1,40}$'),
  subject           text not null check (char_length(subject) between 1 and 200),
  body              text not null check (char_length(body) between 1 and 20000),
  audience          jsonb not null,
  recipient_count   integer not null default 0 check (recipient_count >= 0),
  -- A key the composer mints once, so a double click or a retried request returns the
  -- campaign it already created instead of emailing everyone twice.
  client_key        text check (client_key is null or client_key ~ '^[A-Za-z0-9-]{8,64}$'),
  created_by        uuid,
  created_by_email  text,
  created_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  cancelled_by      uuid
);
alter table public.comm_campaigns enable row level security;
revoke all on table public.comm_campaigns from public, anon, authenticated;
create index if not exists comm_campaigns_created_idx on public.comm_campaigns (created_at desc);
create unique index if not exists comm_campaigns_client_key_idx
  on public.comm_campaigns (client_key) where client_key is not null;

create table if not exists public.comm_deliveries (
  id                     uuid primary key default gen_random_uuid(),
  kind                   text not null check (kind in ('announcement', 'payment_reminder', 'student_email', 'meeting_invite', 'automation')),
  campaign_id            uuid references public.comm_campaigns(id) on delete cascade,
  rule_id                uuid references public.comm_automation_rules(id) on delete set null,
  -- A snapshot, so the tracker can still name a rule after it is deleted.
  rule_name              text,
  user_id                uuid references auth.users(id) on delete set null,
  enrollment_request_id  uuid references public.enrollment_requests(id) on delete set null,
  subscription_id        uuid,
  email                  text not null,
  constraint comm_deliveries_email_shape check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and char_length(email) <= 320),
  recipient_name         text,
  -- Tag values only (name, plan, batch, days, expiry, week, amount_due). Never payment details.
  vars                   jsonb not null default '{}'::jsonb,
  status                 text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts               integer not null default 0 check (attempts between 0 and 10),
  -- A transient failure is retried after a backoff, never in the same second.
  next_attempt_at        timestamptz,
  -- Bumped only by a deliberate "Retry failed", so that retry is a NEW message to the
  -- provider (a fresh idempotency key) rather than a replay of the failed request.
  retry_generation       integer not null default 0 check (retry_generation between 0 and 100),
  -- When this retry generation's idempotency key FIRST went to the email provider with an outcome
  -- nobody saw: a timeout, a provider fault, a 409, or a claim that was never recorded. The key
  -- lasts 24 hours from that first request, so the row is never sent under it once this is 20
  -- hours old. It is sticky: a later attempt that never reached the provider (a rate limit,
  -- missing payment details) neither moves nor clears it, so a later error code can never hide
  -- that an earlier attempt may have been delivered. Only a new generation starts it again.
  ambiguous_since        timestamptz,
  -- When the sender was cleared to hand THIS claim to the email provider (comm_begin_send). A stale
  -- claim that never got that far reached nobody, so releasing it refunds the attempt and marks
  -- nothing unclear; only a claim that was cleared may have been delivered.
  send_started_at        timestamptz,
  -- The version (updated_at) of the automation rule this claim's text and audience were judged under.
  -- A rule saved or switched since then no longer clears the row, and a row it stops is recorded as
  -- 'rule_edited', so the next run queues the member again under the rule as it now reads.
  claimed_rule_version   timestamptz,
  provider_id            text,
  error_code             text,
  subject_sent           text,
  dedupe_key             text not null,
  run_on                 date,
  created_at             timestamptz not null default now(),
  claimed_at             timestamptz,
  sent_at                timestamptz,
  updated_at             timestamptz not null default now(),
  constraint comm_deliveries_dedupe_key_unique unique (dedupe_key),
  -- An automation delivery has no campaign; every other kind belongs to one.
  constraint comm_deliveries_source_shape check ((kind = 'automation') = (campaign_id is null))
);
alter table public.comm_deliveries enable row level security;
revoke all on table public.comm_deliveries from public, anon, authenticated;
create index if not exists comm_deliveries_pending_idx
  on public.comm_deliveries (created_at, id) where status in ('queued', 'sending');
create index if not exists comm_deliveries_campaign_idx on public.comm_deliveries (campaign_id) where campaign_id is not null;
create index if not exists comm_deliveries_rule_idx on public.comm_deliveries (rule_id) where rule_id is not null;
create index if not exists comm_deliveries_user_idx on public.comm_deliveries (user_id) where user_id is not null;
create index if not exists comm_deliveries_request_idx
  on public.comm_deliveries (enrollment_request_id, sent_at desc) where enrollment_request_id is not null;
create index if not exists comm_deliveries_sent_idx on public.comm_deliveries (sent_at desc) where status = 'sent';
create index if not exists comm_deliveries_created_idx on public.comm_deliveries (created_at desc);

-- The single SELECT policy per table.
do $pol$
declare
  t text;
  v_using text;
begin
  foreach t in array array['comm_settings', 'comm_automation_rules', 'comm_campaigns', 'comm_deliveries'] loop
    v_using := '(select public.has_staff_permission(''communications.send''))';
    -- ★ A payment reminder names what a student owes, so READING one needs finance.manage
    --   too — the same rule the writers enforce. Latent while only super_admin holds
    --   communications.send; load-bearing the day another role is given it.
    if t in ('comm_campaigns', 'comm_deliveries') then
      v_using := v_using || ' and (kind <> ''payment_reminder'' or (select public.has_staff_permission(''finance.manage'')))';
    end if;
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_read', t, v_using);
  end loop;
end
$pol$;

-- A rule is born paused, whoever inserts it.
create or replace function public.comm_rules_born_paused()
returns trigger language plpgsql set search_path = public, pg_temp as $fn$
begin
  new.status := 'paused';
  new.activated_at := null;
  new.activated_by := null;
  return new;
end;
$fn$;
revoke all on function public.comm_rules_born_paused() from public, anon, authenticated;
drop trigger if exists comm_rules_born_paused on public.comm_automation_rules;
create trigger comm_rules_born_paused
  before insert on public.comm_automation_rules
  for each row execute function public.comm_rules_born_paused();


-- == 3) Internal helpers (never granted) ======================================

-- "Used today" = sent since Manila midnight + everything still waiting to send.
create or replace function public.comm_used_today()
returns integer language sql stable security definer set search_path = public, pg_temp as $fn$
  select count(*)::integer from public.comm_deliveries d
   where d.status in ('queued', 'sending')
      or (d.status = 'sent'
          and d.sent_at >= (((now() at time zone 'Asia/Manila')::date)::timestamp at time zone 'Asia/Manila'))
$fn$;
revoke all on function public.comm_used_today() from public, anon, authenticated;

-- The first term of an UNBROKEN run on the same plan: a renewal or an extension inserts a new
-- subscription with started_at = now(), so counting program weeks from the current term would
-- restart a member at week 1. ★ The walk STOPS at a plan change or a lapse: approve_subscription
-- links every approval to the member's previous row whatever its age or plan, so an unbounded
-- walk would count a VIP who returns in September from their January Sampler term. The parent
-- must be the same plan and must still have been running (grace included, a day's slack) when
-- the child started. Depth-bounded because nothing constrains the chain to be acyclic.
create or replace function public.comm_program_root(p_subscription uuid)
returns table (root_id uuid, root_started_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $fn$
  with recursive chain(id, user_id, plan_key, started_at, parent, depth) as (
    select s.id, s.user_id, s.plan_key, s.started_at, s.renewed_from_subscription_id, 0
      from public.subscriptions s where s.id = p_subscription
    union all
    select p.id, p.user_id, p.plan_key, p.started_at, p.renewed_from_subscription_id, c.depth + 1
      from chain c join public.subscriptions p on p.id = c.parent
     where c.depth < 50 and p.user_id = c.user_id
       and p.plan_key = c.plan_key
       and (p.ends_at is null or coalesce(p.grace_ends_at, p.ends_at) >= c.started_at - interval '1 day')
  )
  select c.id, c.started_at from chain c order by c.depth desc limit 1
$fn$;
revoke all on function public.comm_program_root(uuid) from public, anon, authenticated;

-- Current members: an active term that has not ended (grace included), a usable profile
-- email, not banned, and not staff. ★ Staff are excluded the #50/#52 way (invited +
-- active): a promoted student keeps their subscription row, and an announcement to "all
-- members" must not reach the team.
create or replace function public.comm_current_members()
returns table (user_id uuid, email text, full_name text, plan_key text, plan_name text,
               subscription_id uuid, started_at timestamptz, ends_at timestamptz,
               batch_id uuid, batch_code text, program_id uuid, program_started_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $fn$
  with cur as (
    select distinct on (s.user_id)
           s.user_id, lower(btrim(p.email)) as email, nullif(btrim(p.full_name), '') as full_name, s.plan_key,
           coalesce(ep.name, s.plan_key) as plan_name, s.id as sid, s.started_at, s.ends_at, s.batch_id, b.code
      from public.subscriptions s
      join public.profiles p on p.id = s.user_id
      left join public.enrollment_plans ep on ep.key = s.plan_key
      left join public.batches b on b.id = s.batch_id
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       and nullif(btrim(p.email), '') is not null
       -- The delivery table's own address CHECK, applied here: one malformed profile address must
       -- not abort a whole automation run, or a claim that refreshes addresses from this list.
       and lower(btrim(p.email)) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and char_length(btrim(p.email)) <= 320
       and p.approval_status <> 'rejected'
       and not exists (select 1 from public.staff_memberships sm
                        where sm.user_id = s.user_id and sm.status in ('invited', 'active'))
     order by s.user_id, s.created_at desc
  )
  select c.user_id, c.email, c.full_name, c.plan_key, c.plan_name, c.sid, c.started_at, c.ends_at,
         c.batch_id, c.code, coalesce(r.root_id, c.sid), coalesce(r.root_started_at, c.started_at)
    from cur c
    left join lateral public.comm_program_root(c.sid) r on true
$fn$;
revoke all on function public.comm_current_members() from public, anon, authenticated;

-- The tag values for one recipient, in the business timezone.
create or replace function public.comm_member_vars(
  p_name text, p_plan text, p_batch text, p_started timestamptz, p_ends timestamptz, p_on date
) returns jsonb language sql stable set search_path = public, pg_temp as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'name',   p_name,
    'plan',   p_plan,
    'batch',  p_batch,
    'days',   case when p_ends is null then null
                   else (p_ends at time zone 'Asia/Manila')::date - p_on end,
    'expiry', case when p_ends is null then null
                   else to_char(p_ends at time zone 'Asia/Manila', 'FMMon FMDD, YYYY') end,
    'week',   case when p_started is null then null
                   else greatest(((p_on - (p_started at time zone 'Asia/Manila')::date) / 7) + 1, 1) end))
$fn$;
revoke all on function public.comm_member_vars(text, text, text, timestamptz, timestamptz, date) from public, anon, authenticated;

-- Every audience mode, unfiltered. comm_resolve_audience below is the only caller.
create or replace function public.comm_audience_rows(p_kind text, p_audience jsonb)
returns table (user_id uuid, email text, full_name text, plan_key text, plan_name text, batch_code text,
               subscription_id uuid, enrollment_request_id uuid, vars jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
declare
  v_mode   text;
  v_today  date := (now() at time zone 'Asia/Manila')::date;
  v_active boolean := true;
  v_from   date;
  v_to     date;
  v_batch  uuid;
  v_code   text;
  v_plans  text[];
  v_emails text[];
  v_ids    uuid[];
  c_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_audience) is distinct from 'object' then
    perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose who the message goes to.', 422, null);
  end if;
  v_mode := coalesce(p_audience->>'mode', '');
  if not ((p_kind in ('announcement', 'meeting_invite') and v_mode in ('all', 'batch', 'plans', 'approved_between', 'manual'))
       or (p_kind = 'student_email' and v_mode in ('request', 'manual'))
       or (p_kind = 'payment_reminder' and v_mode = 'receivables')) then
    perform public.app_error('COMM_AUDIENCE_INVALID', 'That audience cannot receive this kind of message.', 422,
      jsonb_build_object('kind', p_kind, 'mode', v_mode));
  end if;
  if p_audience ? 'active_only' then
    if jsonb_typeof(p_audience->'active_only') <> 'boolean' then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'active_only must be true or false.', 422, null);
    end if;
    v_active := (p_audience->>'active_only')::boolean;
  end if;

  if v_mode = 'all' then
    return query
      select m.user_id, m.email, m.full_name, m.plan_key, m.plan_name, m.batch_code, m.subscription_id, null::uuid,
             public.comm_member_vars(m.full_name, m.plan_name, m.batch_code, m.program_started_at, m.ends_at, v_today)
        from public.comm_current_members() m;
    return;
  end if;

  if v_mode = 'batch' then
    if coalesce(p_audience->>'batch_id', '') !~* c_uuid then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose a batch.', 422, null);
    end if;
    v_batch := (p_audience->>'batch_id')::uuid;
    select b.code into v_code from public.batches b where b.id = v_batch;
    if v_code is null then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'That batch does not exist.', 422, null);
    end if;
    -- A seat in the batch (the #35 ledger) or the subscription cache for pre-#35 grants.
    -- ★ The seat must match the member's LIVE plan segment, as user_entitled_batches requires:
    --   a VIP who moved to a cheaper plan keeps 'active' seats until they lapse, and every
    --   community and course check already treats them as gone. The subscription cache counts
    --   only for members with no ledger rows at all (the same bridge rule). A sold seat in a
    --   FUTURE batch still counts — that member belongs to the cohort being written to.
    return query
      select m.user_id, m.email, m.full_name, m.plan_key, m.plan_name, v_code, m.subscription_id, null::uuid,
             public.comm_member_vars(m.full_name, m.plan_name, v_code, m.program_started_at, m.ends_at, v_today)
        from public.comm_current_members() m
       where (m.batch_id = v_batch
              and not exists (select 1 from public.batch_entitlements e0 where e0.user_id = m.user_id))
          or exists (select 1 from public.batch_entitlements e
                      where e.user_id = m.user_id and e.batch_id = v_batch and e.status = 'active'
                        and (e.valid_until is null or e.valid_until > now())
                        and e.segment = coalesce((select ep.community_segment from public.enrollment_plans ep
                                                   where ep.key = m.plan_key), 'general'));
    return;
  end if;

  if v_mode = 'plans' then
    if jsonb_typeof(p_audience->'plan_keys') is distinct from 'array' then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose at least one package.', 422, null);
    end if;
    select array_agg(distinct x) into v_plans
      from jsonb_array_elements_text(p_audience->'plan_keys') x where btrim(x) <> '';
    if v_plans is null or cardinality(v_plans) > 20
       or exists (select 1 from unnest(v_plans) k
                   where not exists (select 1 from public.enrollment_plans ep where ep.key = k)) then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose at least one package that exists.', 422, null);
    end if;
    return query
      select m.user_id, m.email, m.full_name, m.plan_key, m.plan_name, m.batch_code, m.subscription_id, null::uuid,
             public.comm_member_vars(m.full_name, m.plan_name, m.batch_code, m.program_started_at, m.ends_at, v_today)
        from public.comm_current_members() m
       where m.plan_key = any(v_plans);
    return;
  end if;

  if v_mode = 'approved_between' then
    -- ★ YYYY-MM-DD only. A bare ::date cast also accepts 'infinity' (which then breaks the
    --   range arithmetic with an unhandled error) and 'today' (resolved in UTC, not Manila).
    if coalesce(p_audience->>'from', '') ~ '^\d{4}-\d{2}-\d{2}$' and coalesce(p_audience->>'to', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_from := (p_audience->>'from')::date;
        v_to   := (p_audience->>'to')::date;
      exception when others then
        v_from := null;
      end;
    end if;
    if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose an approval date range of up to a year.', 422, null);
    end if;
    -- One row per MEMBER (their latest approval in the range), addressed to their profile.
    return query
      with req as (
        select distinct on (r.user_id)
               r.id as rid, r.user_id as uid, r.plan_key as pk, r.plan_name as pn, r.batch_id as bid
          from public.enrollment_requests r
         where r.status = 'approved' and r.user_id is not null
           and (coalesce(r.reviewed_at, r.created_at) at time zone 'Asia/Manila')::date between v_from and v_to
         order by r.user_id, coalesce(r.reviewed_at, r.created_at) desc
      )
      select q.uid, lower(btrim(pr.email)), coalesce(m.full_name, nullif(btrim(pr.full_name), '')),
             coalesce(m.plan_key, q.pk), coalesce(m.plan_name, q.pn), coalesce(m.batch_code, b.code),
             m.subscription_id, q.rid,
             public.comm_member_vars(coalesce(m.full_name, nullif(btrim(pr.full_name), '')), coalesce(m.plan_name, q.pn),
                                     coalesce(m.batch_code, b.code), m.program_started_at, m.ends_at, v_today)
        from req q
        join public.profiles pr on pr.id = q.uid
        left join public.comm_current_members() m on m.user_id = q.uid
        left join public.batches b on b.id = q.bid
       where nullif(btrim(pr.email), '') is not null
         and pr.approval_status <> 'rejected'
         and (not v_active or m.user_id is not null)
         and not exists (select 1 from public.staff_memberships sm
                          where sm.user_id = q.uid and sm.status in ('invited', 'active'));
    return;
  end if;

  if v_mode = 'manual' then
    if jsonb_typeof(p_audience->'emails') is distinct from 'array' then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Add at least one email address.', 422, null);
    end if;
    select array_agg(distinct lower(btrim(x))) into v_emails
      from jsonb_array_elements_text(p_audience->'emails') x where btrim(x) <> '';
    if v_emails is null then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Add at least one email address.', 422, null);
    end if;
    if cardinality(v_emails) > 50 then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'A pasted list can hold at most 50 addresses.', 422,
        jsonb_build_object('count', cardinality(v_emails)));
    end if;
    if exists (select 1 from unnest(v_emails) e where e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(e) > 320) then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'One of the addresses is not a valid email.', 422, null);
    end if;
    -- With active_only=false a pasted address is sent as named — the Super Admin typed it.
    return query
      select coalesce(m.user_id, pr.id), e.em, coalesce(m.full_name, nullif(btrim(pr.full_name), '')),
             m.plan_key, m.plan_name, m.batch_code, m.subscription_id, null::uuid,
             public.comm_member_vars(coalesce(m.full_name, nullif(btrim(pr.full_name), '')), m.plan_name,
                                     m.batch_code, m.program_started_at, m.ends_at, v_today)
        from unnest(v_emails) as e(em)
        left join lateral (select p.id, p.full_name from public.profiles p
                            where lower(btrim(p.email)) = e.em limit 1) pr on true
        left join public.comm_current_members() m on m.email = e.em
       where (not v_active or m.user_id is not null);
    return;
  end if;

  if v_mode = 'request' then
    if coalesce(p_audience->>'request_id', '') !~* c_uuid then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose the enrollment request to email.', 422, null);
    end if;
    -- ★ The PROFILE's address, never enrollment_requests.email: a student types that field.
    return query
      select r.user_id, lower(btrim(pr.email)), coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(r.full_name), '')),
             r.plan_key, r.plan_name, b.code, null::uuid, r.id,
             public.comm_member_vars(coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(r.full_name), '')),
                                     r.plan_name, b.code, null, null, v_today)
        from public.enrollment_requests r
        join public.profiles pr on pr.id = r.user_id
        left join public.batches b on b.id = r.batch_id
       where r.id = (p_audience->>'request_id')::uuid
         and nullif(btrim(pr.email), '') is not null;
    return;
  end if;

  if v_mode = 'receivables' then
    -- ★ A reminder reads what a student still owes, which is finance data.
    if not public.has_staff_permission('finance.manage') then
      perform public.app_error('FORBIDDEN', 'Payment reminders also require the finance.manage permission.', 403, null);
    end if;
    if jsonb_typeof(p_audience->'request_ids') is distinct from 'array'
       or jsonb_array_length(p_audience->'request_ids') = 0
       or jsonb_array_length(p_audience->'request_ids') > 200
       or exists (select 1 from jsonb_array_elements_text(p_audience->'request_ids') x where x !~* c_uuid) then
      perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose between 1 and 200 receivables.', 422, null);
    end if;
    select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p_audience->'request_ids') x;
    return query
      with q as (
        select r.id as rid, r.user_id as uid, lower(btrim(pr.email)) as em,
               coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(r.full_name), '')) as fn,
               r.plan_key as pk, r.plan_name as pn, r.batch_id as bid,
               greatest(coalesce(r.amount_expected, 0) - public.finance_request_collected(r.id), 0) as due
          from public.enrollment_requests r
          join public.profiles pr on pr.id = r.user_id
         where r.id = any(v_ids) and r.status = 'approved' and nullif(btrim(pr.email), '') is not null
      )
      select q.uid, q.em, q.fn, q.pk, q.pn, b.code, null::uuid, q.rid,
             public.comm_member_vars(q.fn, q.pn, b.code, null, null, v_today)
               || jsonb_build_object('amount_due', '₱' || to_char(q.due, 'FM999,999,990.00'))
        from q
        left join public.batches b on b.id = q.bid
       where q.due > 0;
    return;
  end if;

  perform public.app_error('COMM_AUDIENCE_INVALID', 'Choose who the message goes to.', 422, null);
end;
$fn$;
revoke all on function public.comm_audience_rows(text, jsonb) from public, anon, authenticated;

-- One row per address — except payment reminders, which get one row per BALANCE: a student
-- who owes on two requests receives two reminders, each stating its own amount, and each
-- request's reminder count stays true.
create or replace function public.comm_resolve_audience(p_kind text, p_audience jsonb)
returns table (user_id uuid, email text, full_name text, plan_key text, plan_name text, batch_code text,
               subscription_id uuid, enrollment_request_id uuid, vars jsonb)
language sql stable security definer set search_path = public, pg_temp as $fn$
  select distinct on (a.email, case when p_kind = 'payment_reminder' then a.enrollment_request_id end)
         a.user_id, a.email, a.full_name, a.plan_key, a.plan_name, a.batch_code,
         a.subscription_id, a.enrollment_request_id, a.vars
    from public.comm_audience_rows(p_kind, p_audience) a
   where a.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and char_length(a.email) <= 320
   order by a.email, case when p_kind = 'payment_reminder' then a.enrollment_request_id end, a.user_id nulls last
$fn$;
revoke all on function public.comm_resolve_audience(text, jsonb) from public, anon, authenticated;

create or replace function public.comm_validate_rule(
  p_trigger text, p_days integer, p_scope text, p_batch uuid, p_plans text[]
) returns void language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if p_trigger is null or p_trigger not in ('expiry_exact', 'expiry_within', 'program_week') then
    perform public.app_error('COMM_RULE_INVALID', 'Choose when the email is sent.', 422, null);
  end if;
  if p_trigger in ('expiry_exact', 'expiry_within') and (p_days is null or p_days < 0 or p_days > 365) then
    perform public.app_error('COMM_RULE_INVALID', 'Days before expiry must be between 0 and 365.', 422, null);
  end if;
  if p_scope is null or p_scope not in ('all', 'batch', 'plans') then
    perform public.app_error('COMM_RULE_INVALID', 'Choose who the automation applies to.', 422, null);
  end if;
  if p_scope = 'batch' and (p_batch is null or not exists (select 1 from public.batches b where b.id = p_batch)) then
    perform public.app_error('COMM_RULE_INVALID', 'Choose a batch that exists.', 422, null);
  end if;
  if p_scope = 'plans' and (coalesce(cardinality(p_plans), 0) = 0 or cardinality(p_plans) > 20
       or exists (select 1 from unnest(p_plans) k
                   where not exists (select 1 from public.enrollment_plans ep where ep.key = k))) then
    perform public.app_error('COMM_RULE_INVALID', 'Choose at least one package that exists.', 422, null);
  end if;
end;
$fn$;
revoke all on function public.comm_validate_rule(text, integer, text, uuid, text[]) from public, anon, authenticated;

-- Who a rule matches on one day, looking back `p_window` days (1 = today only).
-- ★ All three triggers skip a term with no end date: "N days before expiry" has no
--   meaning for it, and a grandfathered no-expiry member was never told a week count.
-- ★ program_week fires on 7-day anniversaries of the FIRST term of a renewal chain — the
--   legacy "weekly" rule fired every day. The window lets a run catch an anniversary (or an
--   exact expiry day) that a missed or capped earlier run did not queue; the dedupe key
--   keeps a caught-up email from ever going out twice.
create or replace function public.comm_rule_matches(
  p_trigger text, p_days integer, p_scope text, p_batch uuid, p_plans text[], p_on date, p_window integer default 1
) returns table (user_id uuid, email text, full_name text, plan_key text, plan_name text, batch_code text,
                 subscription_id uuid, dedupe_suffix text, vars jsonb)
language sql stable security definer set search_path = public, pg_temp as $fn$
  with scoped as (
    select m.*,
           (m.ends_at at time zone 'Asia/Manila')::date as ends_on,
           (m.program_started_at at time zone 'Asia/Manila')::date as program_on,
           case when p_scope = 'batch' then (select b.code from public.batches b where b.id = p_batch)
                else m.batch_code end as code,
           greatest(1, least(coalesce(p_window, 1), 7)) as w
      from public.comm_current_members() m
     where m.ends_at is not null
       and (p_scope = 'all'
            or (p_scope = 'plans' and m.plan_key = any(p_plans))
            or (p_scope = 'batch' and ((m.batch_id = p_batch
                    and not exists (select 1 from public.batch_entitlements e0 where e0.user_id = m.user_id))
                  or exists (select 1 from public.batch_entitlements e
                              where e.user_id = m.user_id and e.batch_id = p_batch and e.status = 'active'
                                and (e.valid_until is null or e.valid_until > now())
                                and e.segment = coalesce((select ep.community_segment from public.enrollment_plans ep
                                                           where ep.key = m.plan_key), 'general')))))
  )
  select s.user_id, s.email, s.full_name, s.plan_key, s.plan_name, s.code, s.subscription_id,
         case when p_trigger = 'program_week'
              then s.program_id::text || ':week:' || (((p_on - s.program_on) / 7) + 1)::text
              else s.subscription_id::text || ':ends:' || to_char(s.ends_on, 'YYYYMMDD') end,
         public.comm_member_vars(s.full_name, s.plan_name, s.code, s.program_started_at, s.ends_at, p_on)
    from scoped s
   where case p_trigger
           when 'expiry_exact'  then (s.ends_on - p_on) between greatest(p_days - s.w + 1, 0) and p_days
           when 'expiry_within' then (s.ends_on - p_on) between 0 and p_days
           when 'program_week'  then (p_on - s.program_on) >= 7 and ((p_on - s.program_on) % 7) < s.w
                                     and s.ends_on >= p_on
           else false
         end
$fn$;
revoke all on function public.comm_rule_matches(text, integer, text, uuid, text[], date, integer) from public, anon, authenticated;


-- == 4) Client RPCs (communications.send, checked first) ======================

create or replace function public.comm_overview()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_cap integer; v_run jsonb; v_run_at timestamptz; v_used integer;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  select s.daily_send_cap, s.last_automation_run, s.last_automation_run_at
    into v_cap, v_run, v_run_at from public.comm_settings s where s.id;
  v_used := public.comm_used_today();
  return jsonb_build_object(
    'daily_cap',   coalesce(v_cap, 100),
    'used_today',  v_used,
    'remaining',   greatest(coalesce(v_cap, 100) - v_used, 0),
    'waiting',     (select count(*) from public.comm_deliveries d where d.status in ('queued', 'sending')),
    'sent_7d',     (select count(*) from public.comm_deliveries d where d.status = 'sent' and d.sent_at > now() - interval '7 days'),
    'failed_7d',   (select count(*) from public.comm_deliveries d where d.status = 'failed' and d.updated_at > now() - interval '7 days'),
    'rules',       (select count(*) from public.comm_automation_rules),
    'active_rules',(select count(*) from public.comm_automation_rules r where r.status = 'active'),
    'last_automation_run', v_run,
    'last_automation_run_at', v_run_at,
    'can_remind_payments', public.has_staff_permission('finance.manage'));
end;
$fn$;
revoke all on function public.comm_overview() from public, anon, authenticated;
grant execute on function public.comm_overview() to authenticated;

create or replace function public.comm_preview_audience(p_kind text, p_audience jsonb, p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_count integer; v_sample jsonb; v_cap integer; v_used integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if p_kind is null or p_kind not in ('announcement', 'payment_reminder', 'student_email', 'meeting_invite') then
    perform public.app_error('COMM_AUDIENCE_INVALID', 'Unknown kind of message.', 422, null);
  end if;
  if p_kind = 'payment_reminder' and not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN', 'Payment reminders also require the finance.manage permission.', 403, null);
  end if;
  if p_kind = 'meeting_invite' and not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meeting invitations require the meetings.manage permission.', 403, null);
  end if;

  select count(*)::integer,
         coalesce(jsonb_agg(s.item order by s.rn) filter (where s.rn <= v_limit), '[]'::jsonb)
    into v_count, v_sample
    from (select row_number() over (order by a.full_name nulls last, a.email) as rn,
                 jsonb_build_object('email', a.email, 'name', a.full_name, 'plan', a.plan_name,
                                    'batch', a.batch_code, 'vars', a.vars,
                                    'enrollment_request_id', a.enrollment_request_id) as item
            from public.comm_resolve_audience(p_kind, p_audience) a) s;

  select c.daily_send_cap into v_cap from public.comm_settings c where c.id;
  v_used := public.comm_used_today();
  return jsonb_build_object('count', v_count, 'sample', v_sample,
    'daily_cap', coalesce(v_cap, 100), 'used_today', v_used,
    'remaining', greatest(coalesce(v_cap, 100) - v_used, 0));
end;
$fn$;
revoke all on function public.comm_preview_audience(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.comm_preview_audience(text, jsonb, integer) to authenticated;

create or replace function public.comm_create_campaign(
  p_kind text, p_template_key text, p_subject text, p_body text, p_audience jsonb, p_client_key text default null
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_actor   uuid := auth.uid();
  v_email   text;
  v_id      uuid;
  v_count   integer;
  v_cap     integer;
  v_used    integer;
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body    text := coalesce(p_body, '');
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if p_kind is null or p_kind not in ('announcement', 'payment_reminder', 'student_email', 'meeting_invite') then
    perform public.app_error('COMM_AUDIENCE_INVALID', 'Unknown kind of message.', 422, null);
  end if;
  if p_kind = 'payment_reminder' and not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN', 'Payment reminders also require the finance.manage permission.', 403, null);
  end if;
  -- #62 seeds meetings.manage. Until it runs nobody holds the key, so invitations are refused.
  if p_kind = 'meeting_invite' and not public.has_staff_permission('meetings.manage') then
    perform public.app_error('FORBIDDEN', 'Meeting invitations require the meetings.manage permission.', 403, null);
  end if;
  if v_subject = '' or char_length(v_subject) > 200 or btrim(v_body) = '' or char_length(v_body) > 20000
     or (p_template_key is not null and p_template_key !~ '^[a-z0-9_]{1,40}$')
     or (p_client_key is not null and p_client_key !~ '^[A-Za-z0-9-]{8,64}$') then
    perform public.app_error('COMM_MESSAGE_INVALID', 'A message needs a subject of up to 200 characters and a body of up to 20,000.', 422, null);
  end if;
  -- ★ Payment details never ride in a subject: it shows in inbox lists and lock screens, and
  --   the sender only fills the tag in the body.
  if v_subject ~ '\{\{\s*payment_instructions\s*\}\}' then
    perform public.app_error('COMM_MESSAGE_INVALID', 'Payment details can only go in the message body, not the subject.', 422, null);
  end if;

  -- ★ Every enqueue waits on the settings row, so two sends cannot both fit under the cap —
  --   and a duplicate submit waits here too, then finds the campaign the first one made.
  select s.daily_send_cap into v_cap from public.comm_settings s where s.id for update;
  if p_client_key is not null then
    select c.id, c.recipient_count into v_id, v_count from public.comm_campaigns c where c.client_key = p_client_key;
    if v_id is not null then
      return jsonb_build_object('campaign_id', v_id, 'queued', v_count, 'duplicate', true,
        'remaining_today', greatest(coalesce(v_cap, 100) - public.comm_used_today(), 0));
    end if;
  end if;
  v_used := public.comm_used_today();
  select p.email into v_email from public.profiles p where p.id = v_actor;

  insert into public.comm_campaigns (kind, template_key, subject, body, audience, client_key, created_by, created_by_email)
  values (p_kind, p_template_key, v_subject, v_body, p_audience, p_client_key, v_actor, v_email)
  returning id into v_id;

  insert into public.comm_deliveries
    (kind, campaign_id, user_id, enrollment_request_id, subscription_id, email, recipient_name, vars, dedupe_key)
  select p_kind, v_id, a.user_id, a.enrollment_request_id, a.subscription_id, a.email, a.full_name, a.vars,
         'campaign:' || v_id::text || ':' || a.email || coalesce(':' || a.enrollment_request_id::text, '')
    from public.comm_resolve_audience(p_kind, p_audience) a
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;

  -- A raise here rolls back the campaign and every delivery above: nothing is half-queued.
  if v_count = 0 then
    perform public.app_error('COMM_AUDIENCE_EMPTY', 'No one matches this audience.', 422, null);
  end if;
  if v_used + v_count > coalesce(v_cap, 100) then
    perform public.app_error('COMM_DAILY_CAP', 'Sending this would pass today''s email limit.', 429,
      jsonb_build_object('daily_cap', coalesce(v_cap, 100), 'used_today', v_used, 'requested', v_count));
  end if;

  update public.comm_campaigns set recipient_count = v_count where id = v_id;
  return jsonb_build_object('campaign_id', v_id, 'queued', v_count, 'duplicate', false,
    'remaining_today', greatest(coalesce(v_cap, 100) - v_used - v_count, 0));
end;
$fn$;
revoke all on function public.comm_create_campaign(text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.comm_create_campaign(text, text, text, text, jsonb, text) to authenticated;

create or replace function public.comm_cancel_campaign(p_campaign_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_kind text; v_cancelled timestamptz; v_count integer; v_sending integer;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  select c.kind, c.cancelled_at into v_kind, v_cancelled
    from public.comm_campaigns c where c.id = p_campaign_id for update;
  if v_kind is null then
    perform public.app_error('COMM_NOT_FOUND', 'The campaign does not exist.', 404, null);
  end if;
  if v_kind = 'payment_reminder' and not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN', 'Payment reminders also require the finance.manage permission.', 403, null);
  end if;
  update public.comm_deliveries
     set status = 'skipped', error_code = 'cancelled', next_attempt_at = null, updated_at = now()
   where campaign_id = p_campaign_id and status = 'queued';
  get diagnostics v_count = row_count;
  if v_cancelled is null then
    update public.comm_campaigns set cancelled_at = now(), cancelled_by = auth.uid() where id = p_campaign_id;
  end if;
  -- A claimed row not yet cleared to send is stopped at its clearance (comm_begin_send). One already
  -- cleared may be with the email provider, so it is counted and the screen says it may still arrive.
  -- ★ No race: a clearance holds this campaign row in SHARE mode while it decides, and the lock taken
  --   on the campaign above waited for any clearance in progress, so this later count sees its stamp —
  --   and a clearance that starts after that lock waits for this transaction and then refuses.
  select count(*) into v_sending from public.comm_deliveries
   where campaign_id = p_campaign_id and status = 'sending' and send_started_at is not null;
  return jsonb_build_object('ok', true, 'skipped', v_count, 'in_flight', v_sending,
    'already_cancelled', v_cancelled is not null);
end;
$fn$;
revoke all on function public.comm_cancel_campaign(uuid) from public, anon, authenticated;
grant execute on function public.comm_cancel_campaign(uuid) to authenticated;

create or replace function public.comm_retry_failed(p_campaign_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_kind text; v_cancelled timestamptz; v_cap integer; v_used integer; v_count integer;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  select c.kind, c.cancelled_at into v_kind, v_cancelled
    from public.comm_campaigns c where c.id = p_campaign_id for update;
  if v_kind is null then
    perform public.app_error('COMM_NOT_FOUND', 'The campaign does not exist.', 404, null);
  end if;
  if v_cancelled is not null then
    perform public.app_error('COMM_CAMPAIGN_CLOSED', 'The campaign was cancelled.', 409, null);
  end if;
  if v_kind = 'payment_reminder' and not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN', 'Payment reminders also require the finance.manage permission.', 403, null);
  end if;

  select s.daily_send_cap into v_cap from public.comm_settings s where s.id for update;
  v_used := public.comm_used_today();
  -- ★ Never an 'unknown_outcome' or 'possibly_sent' row: those may well have been delivered.
  --   The decision reads ambiguous_since, NOT the last error code: a timeout followed by two rate
  --   limits ends as 'resend_429', and judging by that code alone re-sent, under a brand-new key,
  --   a message the provider may already have delivered. A row that was EVER unclear in this
  --   generation keeps its generation — so the provider's idempotency key still de-duplicates
  --   it — and is not re-sent at all once that first unclear attempt is 20 hours old. Only a row
  --   whose every attempt was refused outright (a bad address, missing payment details, a rate
  --   limit) goes out as a NEW provider request.
  update public.comm_deliveries d
     set status = 'queued', attempts = 0, error_code = null, claimed_at = null, next_attempt_at = null,
         retry_generation = case when d.ambiguous_since is not null then d.retry_generation
                                 else least(d.retry_generation + 1, 100) end,
         updated_at = now()
   where d.campaign_id = p_campaign_id and d.status = 'failed'
     and coalesce(d.error_code, '') not in ('unknown_outcome', 'possibly_sent')
     and (d.ambiguous_since is null or d.ambiguous_since >= now() - interval '20 hours');
  get diagnostics v_count = row_count;
  if v_count > 0 and v_used + v_count > coalesce(v_cap, 100) then
    perform public.app_error('COMM_DAILY_CAP', 'Sending this would pass today''s email limit.', 429,
      jsonb_build_object('daily_cap', coalesce(v_cap, 100), 'used_today', v_used, 'requested', v_count));
  end if;
  return jsonb_build_object('ok', true, 'requeued', v_count);
end;
$fn$;
revoke all on function public.comm_retry_failed(uuid) from public, anon, authenticated;
grant execute on function public.comm_retry_failed(uuid) to authenticated;

create or replace function public.comm_campaigns_list(
  p_kind text default null, p_limit integer default 25, p_offset integer default 0
) returns table (id uuid, kind text, template_key text, subject text, audience jsonb, recipient_count integer,
                 created_by_email text, created_at timestamptz, cancelled_at timestamptz,
                 waiting bigint, sent bigint, failed bigint, skipped bigint, last_sent_at timestamptz,
                 total_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 100000));
  v_fin boolean;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  v_fin := public.has_staff_permission('finance.manage');
  return query
    select c.id, c.kind, c.template_key, c.subject, c.audience, c.recipient_count, c.created_by_email,
           c.created_at, c.cancelled_at,
           coalesce(d.waiting, 0), coalesce(d.sent, 0), coalesce(d.failed, 0), coalesce(d.skipped, 0),
           d.last_sent_at, count(*) over ()
      from public.comm_campaigns c
      left join lateral (
        select count(*) filter (where x.status in ('queued', 'sending')) as waiting,
               count(*) filter (where x.status = 'sent') as sent,
               count(*) filter (where x.status = 'failed') as failed,
               count(*) filter (where x.status = 'skipped') as skipped,
               max(x.sent_at) as last_sent_at
          from public.comm_deliveries x where x.campaign_id = c.id) d on true
     where (p_kind is null or c.kind = p_kind)
       and (c.kind <> 'payment_reminder' or v_fin)
     order by c.created_at desc
     limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.comm_campaigns_list(text, integer, integer) from public, anon, authenticated;
grant execute on function public.comm_campaigns_list(text, integer, integer) to authenticated;

create or replace function public.comm_delivery_log(
  p_kind text default null, p_status text default null, p_campaign_id uuid default null,
  p_rule_id uuid default null, p_search text default null, p_limit integer default 50, p_offset integer default 0
) returns table (id uuid, kind text, campaign_id uuid, campaign_subject text, rule_id uuid, rule_name text,
                 email text, recipient_name text, status text, error_code text, subject_sent text,
                 attempts integer, created_at timestamptz, sent_at timestamptz,
                 enrollment_request_id uuid, may_have_sent boolean, total_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 100000));
  v_like text;
  v_fin boolean;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  v_fin := public.has_staff_permission('finance.manage');
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_like := '%' || replace(replace(replace(left(btrim(p_search), 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
    select d.id, d.kind, d.campaign_id, c.subject, d.rule_id, d.rule_name, d.email, d.recipient_name,
           d.status, d.error_code, d.subject_sent, d.attempts, d.created_at, d.sent_at,
           d.enrollment_request_id,
           -- Not sent, but an earlier attempt went to the provider and got no clear answer.
           (d.status <> 'sent' and d.ambiguous_since is not null),
           count(*) over ()
      from public.comm_deliveries d
      left join public.comm_campaigns c on c.id = d.campaign_id
     where (p_kind is null or d.kind = p_kind)
       and (d.kind <> 'payment_reminder' or v_fin)
       and (p_status is null or d.status = p_status or (p_status = 'waiting' and d.status in ('queued', 'sending')))
       and (p_campaign_id is null or d.campaign_id = p_campaign_id)
       and (p_rule_id is null or d.rule_id = p_rule_id)
       and (v_like is null or d.email ilike v_like or d.recipient_name ilike v_like)
     order by d.created_at desc, d.id
     limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.comm_delivery_log(text, text, uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.comm_delivery_log(text, text, uuid, uuid, text, integer, integer) to authenticated;

create or replace function public.comm_delivery_summary(p_group text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_fin boolean;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  v_fin := public.has_staff_permission('finance.manage');
  if p_group = 'kind' then
    return coalesce((
      select jsonb_agg(jsonb_build_object('kind', k.kind, 'sent', k.sent, 'failed', k.failed,
                                          'skipped', k.skipped, 'waiting', k.waiting, 'last_sent_at', k.last_sent_at)
                       order by k.kind)
        from (select d.kind,
                     count(*) filter (where d.status = 'sent') as sent,
                     count(*) filter (where d.status = 'failed') as failed,
                     count(*) filter (where d.status = 'skipped') as skipped,
                     count(*) filter (where d.status in ('queued', 'sending')) as waiting,
                     max(d.sent_at) as last_sent_at
                from public.comm_deliveries d
               where d.kind <> 'payment_reminder' or v_fin
               group by d.kind) k), '[]'::jsonb);
  elsif p_group = 'rule' then
    return coalesce((
      select jsonb_agg(x.item order by x.sort_name)
        from (
          select lower(r.name) as sort_name,
                 jsonb_build_object('rule_id', r.id, 'name', r.name, 'trigger_kind', r.trigger_kind, 'days', r.days,
                   'status', r.status, 'deleted', false,
                   'sent', count(d.id) filter (where d.status = 'sent'),
                   'failed', count(d.id) filter (where d.status = 'failed'),
                   'skipped', count(d.id) filter (where d.status = 'skipped'),
                   'waiting', count(d.id) filter (where d.status in ('queued', 'sending')),
                   'last_sent_at', max(d.sent_at), 'last_run_at', r.last_run_at) as item
            from public.comm_automation_rules r
            left join public.comm_deliveries d on d.rule_id = r.id
           group by r.id
          union all
          select lower(coalesce(d.rule_name, '')),
                 jsonb_build_object('rule_id', null, 'name', coalesce(d.rule_name, 'Deleted rule'), 'deleted', true,
                   'sent', count(*) filter (where d.status = 'sent'),
                   'failed', count(*) filter (where d.status = 'failed'),
                   'skipped', count(*) filter (where d.status = 'skipped'),
                   'waiting', count(*) filter (where d.status in ('queued', 'sending')),
                   'last_sent_at', max(d.sent_at))
            from public.comm_deliveries d
           where d.kind = 'automation' and d.rule_id is null
           group by d.rule_name) x), '[]'::jsonb);
  elsif p_group = 'student' then
    return coalesce((
      select jsonb_agg(s.item order by s.last_at desc nulls last)
        from (
          select max(coalesce(d.sent_at, d.created_at)) as last_at,
                 jsonb_build_object('email', d.email, 'name', max(d.recipient_name),
                   'sent', count(*) filter (where d.status = 'sent'),
                   'failed', count(*) filter (where d.status = 'failed'),
                   'reminders', count(*) filter (where d.status = 'sent' and d.kind = 'payment_reminder'),
                   'automations', count(*) filter (where d.status = 'sent' and d.kind = 'automation'),
                   'last_sent_at', max(d.sent_at)) as item
            from public.comm_deliveries d
           where d.created_at > now() - interval '400 days'
             and (d.kind <> 'payment_reminder' or v_fin)
           group by d.email
           order by 1 desc nulls last
           limit 500) s), '[]'::jsonb);
  end if;
  perform public.app_error('COMM_AUDIENCE_INVALID', 'Unknown summary.', 422, null);
  return null;
end;
$fn$;
revoke all on function public.comm_delivery_summary(text) from public, anon, authenticated;
grant execute on function public.comm_delivery_summary(text) to authenticated;

create or replace function public.comm_rules_list()
returns table (id uuid, name text, trigger_kind text, days integer, scope text, scope_batch_id uuid,
               batch_code text, scope_plan_keys text[], subject text, body text, status text,
               created_at timestamptz, updated_at timestamptz, activated_at timestamptz,
               last_run_on date, last_run_at timestamptz, sent bigint, failed bigint, last_sent_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  return query
    select r.id, r.name, r.trigger_kind, r.days, r.scope, r.scope_batch_id, b.code, r.scope_plan_keys,
           r.subject, r.body, r.status, r.created_at, r.updated_at, r.activated_at, r.last_run_on, r.last_run_at,
           count(d.id) filter (where d.status = 'sent'), count(d.id) filter (where d.status = 'failed'),
           max(d.sent_at)
      from public.comm_automation_rules r
      left join public.batches b on b.id = r.scope_batch_id
      left join public.comm_deliveries d on d.rule_id = r.id
     group by r.id, b.code
     order by r.created_at;
end;
$fn$;
revoke all on function public.comm_rules_list() from public, anon, authenticated;
grant execute on function public.comm_rules_list() to authenticated;

create or replace function public.comm_save_rule(
  p_id uuid, p_name text, p_trigger text, p_days integer, p_scope text,
  p_scope_batch_id uuid, p_scope_plan_keys text[], p_subject text, p_body text
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_days    integer := case when p_trigger = 'program_week' then null else p_days end;
  v_batch   uuid := case when p_scope = 'batch' then p_scope_batch_id end;
  v_plans   text[];
  v_name    text := btrim(coalesce(p_name, ''));
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body    text := coalesce(p_body, '');
  v_id      uuid;
  v_status  text;
  v_dropped integer := 0;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if v_name = '' or char_length(v_name) > 120 then
    perform public.app_error('COMM_RULE_INVALID', 'Give the automation a name of up to 120 characters.', 422, null);
  end if;
  if v_subject = '' or char_length(v_subject) > 200 or btrim(v_body) = '' or char_length(v_body) > 20000 then
    perform public.app_error('COMM_MESSAGE_INVALID', 'A message needs a subject of up to 200 characters and a body of up to 20,000.', 422, null);
  end if;
  if v_subject ~ '\{\{\s*payment_instructions\s*\}\}' then
    perform public.app_error('COMM_MESSAGE_INVALID', 'Payment details can only go in the message body, not the subject.', 422, null);
  end if;
  v_plans := case when p_scope = 'plans'
                  then coalesce((select array_agg(distinct btrim(k) order by btrim(k))
                                   from unnest(p_scope_plan_keys) k where btrim(k) <> ''), '{}')
                  else '{}' end;
  perform public.comm_validate_rule(p_trigger, v_days, p_scope, v_batch, v_plans);

  if p_id is null then
    insert into public.comm_automation_rules
      (name, trigger_kind, days, scope, scope_batch_id, scope_plan_keys, subject, body, created_by)
    values (v_name, p_trigger, v_days, p_scope, v_batch, v_plans, v_subject, v_body, auth.uid())
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'created', true, 'status', 'paused', 'was_active', false, 'dropped', 0);
  end if;

  select r.status into v_status from public.comm_automation_rules r where r.id = p_id for update;
  if v_status is null then
    perform public.app_error('COMM_NOT_FOUND', 'The automation rule does not exist.', 404, null);
  end if;
  -- ★ An edited rule is paused, and what it already queued is dropped: those rows were
  --   matched under the OLD timing and audience, and the sender reads the rule's CURRENT text.
  update public.comm_deliveries set status = 'skipped', error_code = 'rule_edited', next_attempt_at = null, updated_at = now()
   where rule_id = p_id and status = 'queued';
  get diagnostics v_dropped = row_count;
  update public.comm_automation_rules
     set name = v_name, trigger_kind = p_trigger, days = v_days, scope = p_scope, scope_batch_id = v_batch,
         scope_plan_keys = v_plans, subject = v_subject, body = v_body,
         status = 'paused', activated_at = null, activated_by = null, last_complete_on = null, updated_at = now()
   where id = p_id;
  -- A row already cleared to send may still go out with the text it was claimed with; one not yet cleared
  -- is refused at its clearance. The clearance holds this rule row in SHARE mode, so the lock taken above
  -- waited for any clearance in progress and this count sees its stamp.
  return jsonb_build_object('id', p_id, 'created', false, 'status', 'paused', 'was_active', v_status = 'active',
    'dropped', v_dropped,
    'in_flight', (select count(*) from public.comm_deliveries
                   where rule_id = p_id and status = 'sending' and send_started_at is not null));
end;
$fn$;
revoke all on function public.comm_save_rule(uuid, text, text, integer, text, uuid, text[], text, text) from public, anon, authenticated;
grant execute on function public.comm_save_rule(uuid, text, text, integer, text, uuid, text[], text, text) to authenticated;

create or replace function public.comm_set_rule_status(p_id uuid, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_found uuid; v_dropped integer := 0; v_sending integer := 0;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if p_status is null or p_status not in ('active', 'paused') then
    perform public.app_error('COMM_RULE_INVALID', 'An automation is either active or paused.', 422, null);
  end if;
  -- ★ Turning a rule ON starts its catch-up window at the day it was turned on: a rule paused
  --   for a week must not wake up and email a week of anniversaries at once.
  update public.comm_automation_rules
     set activated_at = case when p_status = 'active' then now() else activated_at end,
         activated_by = case when p_status = 'active' then auth.uid() else activated_by end,
         last_complete_on = case when p_status = 'active' and status <> 'active' then null else last_complete_on end,
         status = p_status,
         updated_at = now()
   where id = p_id
  returning id into v_found;
  if v_found is null then
    perform public.app_error('COMM_NOT_FOUND', 'The automation rule does not exist.', 404, null);
  end if;
  if p_status = 'paused' then
    update public.comm_deliveries set status = 'skipped', error_code = 'rule_paused', next_attempt_at = null, updated_at = now()
     where rule_id = p_id and status = 'queued';
    get diagnostics v_dropped = row_count;
    -- A row a sender claimed but has not yet cleared to send is stopped at its clearance and recorded
    -- as 'rule_paused', so turning the rule on again queues it. One already cleared may still arrive.
    -- ★ No race: a clearance holds the rule row in SHARE mode while it decides, so the rule update above
    --   waited for any clearance in progress and this later count sees its stamp.
    select count(*) into v_sending from public.comm_deliveries
     where rule_id = p_id and status = 'sending' and send_started_at is not null;
  end if;
  return jsonb_build_object('id', p_id, 'status', p_status, 'dropped', v_dropped, 'in_flight', v_sending);
end;
$fn$;
revoke all on function public.comm_set_rule_status(uuid, text) from public, anon, authenticated;
grant execute on function public.comm_set_rule_status(uuid, text) to authenticated;

create or replace function public.comm_delete_rule(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_found uuid; v_skipped integer; v_sending integer;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  -- ★ THE RULE FIRST. A pause, an edit, the enqueue and a clearance all take the rule row before any
  --   delivery row of it. Dropping the queued rows first and deleting the rule second was the opposite
  --   order — and the delete's ON DELETE SET NULL cascade locks every delivery of the rule — so it
  --   deadlocked against each of them.
  select r.id into v_found from public.comm_automation_rules r where r.id = p_id for update;
  if v_found is null then
    perform public.app_error('COMM_NOT_FOUND', 'The automation rule does not exist.', 404, null);
  end if;
  update public.comm_deliveries
     set status = 'skipped', error_code = 'rule_deleted', next_attempt_at = null, updated_at = now()
   where rule_id = p_id and status = 'queued';
  get diagnostics v_skipped = row_count;
  -- One already cleared to send may still arrive. Counted BEFORE the delete, whose cascade clears
  -- rule_id; the lock above waited for any clearance in progress, so this count sees its stamp. A row
  -- claimed but not yet cleared is refused at its clearance, because its rule is gone.
  select count(*) into v_sending from public.comm_deliveries
   where rule_id = p_id and status = 'sending' and send_started_at is not null;
  delete from public.comm_automation_rules where id = p_id;
  return jsonb_build_object('ok', true, 'skipped', v_skipped, 'in_flight', v_sending);
end;
$fn$;
revoke all on function public.comm_delete_rule(uuid) from public, anon, authenticated;
grant execute on function public.comm_delete_rule(uuid) to authenticated;

create or replace function public.comm_rule_preview(
  p_trigger text, p_days integer, p_scope text, p_scope_batch_id uuid, p_scope_plan_keys text[],
  p_rule_id uuid default null, p_on date default null, p_limit integer default 25
) returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_today date := (now() at time zone 'Asia/Manila')::date;
  v_on    date := coalesce(p_on, (now() at time zone 'Asia/Manila')::date);
  v_days  integer := case when p_trigger = 'program_week' then null else p_days end;
  v_batch uuid := case when p_scope = 'batch' then p_scope_batch_id end;
  v_plans text[];
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_out   jsonb;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if v_on < v_today - 1 or v_on > v_today + 366 then
    perform public.app_error('COMM_RULE_INVALID', 'Preview a day between yesterday and a year from now.', 422, null);
  end if;
  v_plans := case when p_scope = 'plans'
                  then coalesce((select array_agg(distinct btrim(k)) from unnest(p_scope_plan_keys) k where btrim(k) <> ''), '{}')
                  else '{}' end;
  perform public.comm_validate_rule(p_trigger, v_days, p_scope, v_batch, v_plans);

  select jsonb_build_object(
           'on', v_on,
           'count', count(*),
           'already_sent', count(*) filter (where s.already),
           'will_send', count(*) filter (where not s.already),
           'sample', coalesce(jsonb_agg(jsonb_build_object('email', s.email, 'name', s.full_name, 'plan', s.plan_name,
                                        'batch', s.batch_code, 'vars', s.vars, 'already_sent', s.already)
                                        order by s.email) filter (where s.rn <= v_limit), '[]'::jsonb))
    into v_out
    from (select m.*, row_number() over (order by m.email) as rn,
                 -- The enqueue's own test, so the preview never promises an email the run will
                 -- not queue: ANY row holding the key blocks the member — sent, waiting, failed
                 -- (including one that may have been delivered) or skipped — except a row a pause,
                 -- an edit or an inactive rule dropped, which is queued again, unless an earlier try
                 -- of it may already have been delivered 20 or more hours ago (the claim would only
                 -- write that off).
                 (p_rule_id is not null and exists (
                    select 1 from public.comm_deliveries d
                     where d.dedupe_key = 'rule:' || p_rule_id::text || ':' || m.dedupe_suffix
                       and not (d.status = 'skipped'
                                and d.error_code in ('rule_edited', 'rule_paused', 'rule_inactive')
                                and (d.ambiguous_since is null or d.ambiguous_since >= now() - interval '20 hours')))) as already
            from public.comm_rule_matches(p_trigger, v_days, p_scope, v_batch, v_plans, v_on, 1) m) s;
  return v_out;
end;
$fn$;
revoke all on function public.comm_rule_preview(text, integer, text, uuid, text[], uuid, date, integer) from public, anon, authenticated;
grant execute on function public.comm_rule_preview(text, integer, text, uuid, text[], uuid, date, integer) to authenticated;

-- "Last email sent" on an Enrollments card.
create or replace function public.comm_request_email_status(p_request_ids uuid[])
returns table (enrollment_request_id uuid, sent_count bigint, last_sent_at timestamptz,
               last_subject text, last_kind text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
declare
  v_fin boolean;
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if coalesce(cardinality(p_request_ids), 0) > 200 then
    perform public.app_error('COMM_AUDIENCE_INVALID', 'Ask about at most 200 requests at once.', 422, null);
  end if;
  v_fin := public.has_staff_permission('finance.manage');
  return query
    select d.enrollment_request_id, count(*),
           max(d.sent_at),
           (array_agg(d.subject_sent order by d.sent_at desc))[1],
           (array_agg(d.kind order by d.sent_at desc))[1]
      from public.comm_deliveries d
     where d.enrollment_request_id = any(p_request_ids) and d.status = 'sent'
       and (d.kind <> 'payment_reminder' or v_fin)
     group by d.enrollment_request_id;
end;
$fn$;
revoke all on function public.comm_request_email_status(uuid[]) from public, anon, authenticated;
grant execute on function public.comm_request_email_status(uuid[]) to authenticated;

create or replace function public.comm_set_daily_cap(p_cap integer)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('communications.send') then
    perform public.app_error('FORBIDDEN', 'Communications requires the communications.send permission.', 403, null);
  end if;
  if p_cap is null or p_cap < 1 or p_cap > 50000 then
    perform public.app_error('COMM_CAP_INVALID', 'The daily limit must be between 1 and 50,000.', 422, null);
  end if;
  update public.comm_settings set daily_send_cap = p_cap, updated_by = auth.uid(), updated_at = now() where id;
  return jsonb_build_object('ok', true, 'daily_cap', p_cap);
end;
$fn$;
revoke all on function public.comm_set_daily_cap(integer) from public, anon, authenticated;
grant execute on function public.comm_set_daily_cap(integer) to authenticated;


-- == 5) Service-only functions (the api/ handlers, after their own gate) ======
-- ★ Revoked from every client role. The service role reaches them through Supabase's
--   default function privileges; the explicit grant below says so on the record.

create or replace function public.comm_claim_deliveries(p_limit integer default 10, p_campaign_id uuid default null)
returns table (id uuid, kind text, email text, recipient_name text, vars jsonb, subject text, body text,
               campaign_id uuid, rule_id uuid, attempts integer, retry_generation integer)
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
begin
  -- 1) Release claims nobody finished — ten minutes old: the sender died, timed out or was killed.
  --    a) A claim that was never CLEARED to send (no send_started_at) reached nobody. It goes back to
  --       the queue with its attempt refunded and nothing marked unclear: a slow database or a killed
  --       function must not turn an unsent email into 'outcome unknown'.
  update public.comm_deliveries d
     set status = 'queued', attempts = greatest(d.attempts - 1, 0), claimed_at = null,
         next_attempt_at = null, updated_at = now()
   where d.status = 'sending' and d.send_started_at is null and d.claimed_at < now() - interval '10 minutes';
  --    b) A claim that WAS cleared may have reached the provider, which may have accepted it, so the
  --       outcome is unclear ('released', and the clearance time becomes ambiguous_since unless an
  --       earlier attempt already set it). The resend carries the same idempotency key, which the
  --       provider de-duplicates for 24 hours. A row whose first unclear attempt is 20 hours old may
  --       outlive that key, and a claim on its third attempt has no retries left; both are marked
  --       'unknown_outcome', which is never sent again.
  update public.comm_deliveries d
     set status = case when coalesce(d.ambiguous_since, d.send_started_at) < now() - interval '20 hours' or d.attempts >= 3
                       then 'failed' else 'queued' end,
         error_code = case when coalesce(d.ambiguous_since, d.send_started_at) < now() - interval '20 hours' or d.attempts >= 3
                           then 'unknown_outcome' else 'released' end,
         ambiguous_since = coalesce(d.ambiguous_since, d.send_started_at),
         next_attempt_at = null,
         updated_at = now()
   where d.status = 'sending' and d.send_started_at is not null and d.claimed_at < now() - interval '10 minutes';

  -- 1b) A QUEUED row whose first unclear attempt is 20 hours old is not sent again either,
  --     WHATEVER its latest error code says: waiting in the queue does not renew the key, and a
  --     later rate limit does not make the earlier attempt any less likely to have arrived.
  update public.comm_deliveries d
     set status = 'failed', error_code = 'unknown_outcome', next_attempt_at = null, updated_at = now()
   where d.status = 'queued' and d.ambiguous_since < now() - interval '20 hours';

  -- 2) Nothing waiting goes out once its campaign is cancelled or its rule is not active.
  update public.comm_deliveries d
     set status = 'skipped', error_code = case when d.kind = 'automation' then 'rule_inactive' else 'cancelled' end,
         next_attempt_at = null, updated_at = now()
   where d.status = 'queued'
     and ((d.kind = 'automation'
           and not exists (select 1 from public.comm_automation_rules r where r.id = d.rule_id and r.status = 'active'))
       or (d.kind <> 'automation'
           and exists (select 1 from public.comm_campaigns c where c.id = d.campaign_id and c.cancelled_at is not null)));

  -- 3) An automation goes out only if its rule would STILL queue it today: the rule is run
  --    again (with the week's catch-up window) and the row's dedupe key must be among the
  --    matches. That one test covers a member who renewed (a new term, or a new end date),
  --    left, became staff, was banned, moved out of the rule's batch or packages, or ran past
  --    the rule's timing. A row that still matches has its tag values refreshed to today's,
  --    so "{{days}} days left" is true on the day it is sent.
  --    Only rows this claim could hand over are judged: a campaign-scoped claim never picks an
  --    automation row, and a row waiting out a backoff is judged when it is due — so a campaign
  --    send does not re-run every rule for every batch it claims.
  if p_campaign_id is null then
    with pending_rules as (
      select distinct d.rule_id from public.comm_deliveries d
       where d.status = 'queued' and d.kind = 'automation' and d.rule_id is not null
         and (d.next_attempt_at is null or d.next_attempt_at <= now())
    ), still as materialized (
      select 'rule:' || r.id::text || ':' || m.dedupe_suffix as k, m.vars, m.email, m.full_name
        from pending_rules p
        join public.comm_automation_rules r on r.id = p.rule_id and r.status = 'active'
        cross join lateral public.comm_rule_matches(r.trigger_kind, r.days, r.scope, r.scope_batch_id,
                                                    r.scope_plan_keys, (now() at time zone 'Asia/Manila')::date, 7) m
    ), judged as (
      select d.id as jid, s.vars as fresh, s.email as fresh_email, s.full_name as fresh_name,
             -- Claimed before, under a rule that has been saved or switched since: a row the rule no
             -- longer produces was dropped by the EDIT, not by the member, and must not hold the key.
             (d.claimed_rule_version is not null
              and d.claimed_rule_version is distinct from (select r.updated_at from public.comm_automation_rules r
                                                           where r.id = d.rule_id)) as edited
        from public.comm_deliveries d
        left join still s on s.k = d.dedupe_key
       where d.status = 'queued' and d.kind = 'automation'
         and (d.next_attempt_at is null or d.next_attempt_at <= now())
    )
    update public.comm_deliveries d
       set status = case when j.fresh is null then 'skipped' else d.status end,
           error_code = case when j.fresh is null then (case when j.edited then 'rule_edited' else 'no_longer_eligible' end)
                             else d.error_code end,
           next_attempt_at = case when j.fresh is null then null else d.next_attempt_at end,
           vars = coalesce(j.fresh, d.vars),
           -- The address and the name come from the profile as it is today, like the tag values.
           email = coalesce(j.fresh_email, d.email),
           recipient_name = case when j.fresh is null then d.recipient_name else j.fresh_name end,
           updated_at = now()
      from judged j
     -- ★ The status test is repeated HERE, on the row being updated. Inside `judged` it is read from
     --   this statement's snapshot, and READ COMMITTED re-checks only the target row's own
     --   conditions after waiting on a row lock — without it, a claim that waited on another claim
     --   could mark the row that claim is sending as 'skipped'.
     where d.id = j.jid and d.status = 'queued'
       and (j.fresh is null or j.fresh is distinct from d.vars
            or j.fresh_email is distinct from d.email or j.fresh_name is distinct from d.recipient_name);
  end if;

  -- 4) A payment reminder for a balance that has since been paid does not go out.
  update public.comm_deliveries d
     set status = 'skipped', error_code = 'nothing_due', next_attempt_at = null, updated_at = now()
   where d.status = 'queued' and d.kind = 'payment_reminder'
     and not exists (select 1 from public.enrollment_requests r
                      where r.id = d.enrollment_request_id and r.status = 'approved'
                        and coalesce(r.amount_expected, 0) - public.finance_request_collected(r.id) > 0);

  -- 5) Claim. The pick repeats the campaign/rule conditions, so a cancel or a pause that
  --    commits after step 2 still stops the rows it has not yet reached, and a row waiting
  --    out its retry backoff is left alone.
  return query
    with picked as (
      select d.id as pid
        from public.comm_deliveries d
       where d.status = 'queued' and d.attempts < 3
         and (d.next_attempt_at is null or d.next_attempt_at <= now())
         and (p_campaign_id is null or d.campaign_id = p_campaign_id)
         and (d.kind <> 'automation'
              or exists (select 1 from public.comm_automation_rules r where r.id = d.rule_id and r.status = 'active'))
         and (d.campaign_id is null
              or not exists (select 1 from public.comm_campaigns c where c.id = d.campaign_id and c.cancelled_at is not null))
       order by d.created_at, d.id
       limit greatest(1, least(coalesce(p_limit, 10), 50))
       for update skip locked
    ), claimed as (
      update public.comm_deliveries d
         set status = 'sending', claimed_at = now(), send_started_at = null, attempts = d.attempts + 1,
             -- The rule version this row's text and audience come from — read in the same statement
             -- (and snapshot) as the subject and body returned below. comm_begin_send compares it.
             claimed_rule_version = (select r.updated_at from public.comm_automation_rules r where r.id = d.rule_id),
             next_attempt_at = null, updated_at = now()
        from picked
       where d.id = picked.pid
      returning d.id, d.kind, d.email, d.recipient_name, d.vars, d.campaign_id, d.rule_id, d.attempts,
                d.retry_generation, d.enrollment_request_id
    )
    -- A payment reminder states the balance as it is NOW, not as it was when queued.
    select c.id, c.kind, c.email, c.recipient_name,
           case when c.kind = 'payment_reminder' and rq.id is not null
                then c.vars || jsonb_build_object('amount_due', '₱' || to_char(
                       greatest(coalesce(rq.amount_expected, 0) - public.finance_request_collected(rq.id), 0),
                       'FM999,999,990.00'))
                else c.vars end,
           coalesce(cp.subject, r.subject), coalesce(cp.body, r.body), c.campaign_id, c.rule_id, c.attempts,
           c.retry_generation
      from claimed c
      left join public.comm_campaigns cp on cp.id = c.campaign_id
      left join public.comm_automation_rules r on r.id = c.rule_id
      left join public.enrollment_requests rq on rq.id = c.enrollment_request_id;
end;
$fn$;
revoke all on function public.comm_claim_deliveries(integer, uuid) from public, anon, authenticated;
grant execute on function public.comm_claim_deliveries(integer, uuid) to service_role;

-- ★ THE LAST WORD BEFORE A PROVIDER REQUEST. The sender calls this as its last database call before
--   each send, and again before repeating an unclear answer, and sends only on true. It holds the row's
--   rule or campaign row in SHARE mode, then locks the row while it is still this claim's ('sending', same
--   attempt), then — in a later statement, with a snapshot taken after any wait — confirms the campaign is
--   not cancelled and the rule is still active
--   AT THE VERSION THE CLAIM RECORDED (claimed_rule_version), so a pause, an edit, and an edit followed
--   by turning the rule back on all refuse; and it stamps send_started_at (the first clearance only).
--   That stamp is what tells a stale claim apart: without it, nothing reached the provider.
--   On false nothing is sent; the sender hands the row back and comm_record_delivery records why.
create or replace function public.comm_begin_send(p_id uuid, p_attempt integer)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_ok boolean; v_rule uuid; v_campaign uuid;
begin
  -- ★ PARENT FIRST, THEN THE ROW, THEN THE CHECK. Pause, edit, delete, cancel and the enqueue all lock
  --   the rule or campaign row before any delivery row of it (a rule delete does so through its ON DELETE
  --   SET NULL cascade, which locks every delivery of the rule), so this takes them in that same order.
  --   Taking the delivery row first deadlocked against a delete.
  --   The ids are read without a lock: a delivery gets them when it is inserted and they only ever change
  --   to NULL, when the rule or campaign is deleted — and a NULL finds no parent row and fails the check.
  --   The SHARE lock is held until this clearance commits. A pause, an edit or a cancel UPDATES that row,
  --   so whichever gets there first is seen by the other: a clearance that waited sees the change and
  --   refuses, and a change that waited counts this clearance as in flight. A SHARE lock never blocks
  --   another clearance — only a writer of that rule or campaign.
  select d.rule_id, d.campaign_id into v_rule, v_campaign from public.comm_deliveries d where d.id = p_id;
  if not found then
    return false;
  end if;
  perform 1 from public.comm_automation_rules r where r.id = v_rule for share;
  perform 1 from public.comm_campaigns c where c.id = v_campaign for share;
  perform 1 from public.comm_deliveries d
   where d.id = p_id and d.status = 'sending' and d.attempts = p_attempt
   for update;
  if not found then
    return false;
  end if;
  update public.comm_deliveries d
     set send_started_at = coalesce(d.send_started_at, now()), updated_at = now()
   where d.id = p_id
     and case when d.kind = 'automation'
              then exists (select 1 from public.comm_automation_rules r
                            where r.id = d.rule_id and r.status = 'active'
                              and r.updated_at is not distinct from d.claimed_rule_version)
              else not exists (select 1 from public.comm_campaigns c
                                where c.id = d.campaign_id and c.cancelled_at is not null)
         end
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$fn$;
revoke all on function public.comm_begin_send(uuid, integer) from public, anon, authenticated;
grant execute on function public.comm_begin_send(uuid, integer) to service_role;

-- p_error_code 'deferred' is the sender handing a claimed row BACK because its time budget
-- ran out before it could send: the row is re-queued and the attempt it was charged is
-- returned, so running out of time never counts as a failure.
create or replace function public.comm_record_delivery(
  p_id uuid, p_attempt integer, p_ok boolean, p_retry boolean, p_provider_id text, p_error_code text, p_subject text
) returns text language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_status    text;
  v_stop_code text;
  v_stop      boolean;
  v_ok        boolean := coalesce(p_ok, false);
  v_deferred  boolean := not coalesce(p_ok, false) and coalesce(p_error_code, '') = 'deferred';
  v_retry     boolean := not coalesce(p_ok, false) and coalesce(p_retry, false);
  -- Answers that do not say whether the provider accepted the message. A rate limit, a local
  -- failure (missing payment details, an unreadable settings row) and a definitive 4xx never did.
  v_ambiguous boolean := not coalesce(p_ok, false)
                         and coalesce(p_error_code, '') ~ '^(resend_timeout|resend_failed|send_error|resend_5[0-9][0-9]|possibly_sent)$';
begin
  -- A retry or a hand-back is only worth queuing if the message may still go out at all. When it
  -- may not, the reason is recorded the way the rest of the system records it: an automation row
  -- stopped by a pause is 'rule_paused', and one whose rule was saved since the claim is 'rule_edited'
  -- — so the next run queues the member again if the rule, as it now reads, still produces the notice,
  -- exactly like the rows a pause or an edit dropped while they were still waiting — and a row of a
  -- cancelled campaign is 'stopped'.
  select case
           when d.kind = 'automation' then
             case coalesce((select case when r.status = 'active' and r.updated_at is distinct from d.claimed_rule_version
                                        then 'edited' else r.status end
                              from public.comm_automation_rules r where r.id = d.rule_id), 'deleted')
               when 'active' then null
               when 'paused' then 'rule_paused'
               when 'edited' then 'rule_edited'
               when 'deleted' then 'rule_deleted'
               else 'rule_inactive' end
           when exists (select 1 from public.comm_campaigns c where c.id = d.campaign_id and c.cancelled_at is not null)
             then 'stopped'
         end
    into v_stop_code
    from public.comm_deliveries d where d.id = p_id;
  v_stop := v_stop_code is not null;

  update public.comm_deliveries d
     set status = case when v_ok then 'sent'
                       when (v_deferred or v_retry) and v_stop then 'skipped'
                       when v_deferred then 'queued'
                       when v_retry and d.attempts < 3 then 'queued'
                       else 'failed' end,
         attempts = case when v_deferred then greatest(d.attempts - 1, 0) else d.attempts end,
         -- Backoff: 1 minute after the first failure, 5 after the second; the third is final.
         next_attempt_at = case when not v_stop and not v_deferred and v_retry and d.attempts < 3
                                then now() + case when d.attempts <= 1 then interval '1 minute' else interval '5 minutes' end
                                else null end,
         -- Sticky: the FIRST unclear attempt of this generation. No other outcome moves or clears it.
         ambiguous_since = case when v_ambiguous then coalesce(d.ambiguous_since, d.send_started_at, d.claimed_at, now())
                                else d.ambiguous_since end,
         sent_at = case when v_ok then now() else d.sent_at end,
         provider_id = case when v_ok then left(p_provider_id, 200) else d.provider_id end,
         error_code = case when v_ok then null
                           when (v_deferred or v_retry) and v_stop then v_stop_code
                           when v_deferred then d.error_code
                           else left(coalesce(p_error_code, 'unknown'), 80) end,
         subject_sent = case when v_ok then left(p_subject, 200) else d.subject_sent end,
         updated_at = now()
   -- ★ Only the claim that sent it may record it. A slow result from a released claim must
   --   not overwrite the outcome of the attempt that replaced it.
   where d.id = p_id and d.status = 'sending' and d.attempts = p_attempt
  returning d.status into v_status;
  return v_status;
end;
$fn$;
revoke all on function public.comm_record_delivery(uuid, integer, boolean, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.comm_record_delivery(uuid, integer, boolean, boolean, text, text, text) to service_role;

create or replace function public.comm_enqueue_automations(p_on date default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_on      date := coalesce(p_on, (now() at time zone 'Asia/Manila')::date);
  v_cap     integer;
  v_used    integer;
  v_rule_id uuid;
  v_rule    record;
  v_match   record;
  v_key     text;
  v_window  integer;
  v_rules   jsonb := '[]'::jsonb;
  v_matched integer; v_queued integer; v_capped integer;
  v_total_q integer := 0; v_total_c integer := 0;
begin
  select s.daily_send_cap into v_cap from public.comm_settings s where s.id for update;
  v_used := public.comm_used_today();

  for v_rule_id in select r.id from public.comm_automation_rules r where r.status = 'active' order by r.created_at loop
    -- ★ Re-read the rule under a row lock. An edit or a pause that commits after this loop
    --   began waits here — or, if it got there first, this run passes the rule over — so a
    --   run never queues matches from a definition the Super Admin has already replaced.
    --   ★ FOR UPDATE, not FOR SHARE, although a clearance of this rule then waits for the run: the run
    --   writes this row below (last_run_on) after the re-queue has locked delivery rows of the rule, so a
    --   SHARE lock would be upgraded after row locks, the opposite of the rule-then-row order every other
    --   writer keeps. A clearance that waits past its time limit ends its send run; the row goes next run.
    select * into v_rule from public.comm_automation_rules r
     where r.id = v_rule_id and r.status = 'active' for update;
    continue when not found;
    v_matched := 0; v_queued := 0; v_capped := 0;
    -- Look back to the last day that was fully queued — or, for a rule that has never
    -- completed a run, to the day it was turned on — at most a week, so a missed or capped
    -- day is caught up rather than lost.
    v_window := least(greatest(v_on - coalesce(v_rule.last_complete_on,
                                               (v_rule.activated_at at time zone 'Asia/Manila')::date - 1,
                                               v_on - 1), 1), 7);
    for v_match in
      select m.*, (w.dedupe_suffix is not null) as in_window
        from public.comm_rule_matches(v_rule.trigger_kind, v_rule.days, v_rule.scope,
                                      v_rule.scope_batch_id, v_rule.scope_plan_keys, v_on, 7) m
        left join public.comm_rule_matches(v_rule.trigger_kind, v_rule.days, v_rule.scope,
                                           v_rule.scope_batch_id, v_rule.scope_plan_keys, v_on, v_window) w
          on w.dedupe_suffix = m.dedupe_suffix
    loop
      v_key := 'rule:' || v_rule.id::text || ':' || v_match.dedupe_suffix;
      -- ★ Outside today's catch-up window the only member taken is one this rule had ALREADY queued and
      --   a pause or an edit then dropped. The claim would have sent that row anywhere inside the same
      --   week-long window, so turning a rule back on after midnight must not strand it — and nobody
      --   new is reached back past the window.
      continue when not v_match.in_window and not exists (
        select 1 from public.comm_deliveries d
         where d.dedupe_key = v_key and d.status = 'skipped'
           and d.error_code in ('rule_edited', 'rule_paused', 'rule_inactive')
           and (d.ambiguous_since is null or d.ambiguous_since >= now() - interval '20 hours'));
      v_matched := v_matched + 1;
      -- ★ A row a pause, an edit or an inactive rule DROPPED was never sent, so it does not block the
      --   member: it is queued again below — unless an earlier try of it may already have been
      --   delivered 20 or more hours ago, which the claim would only write off. Anything else with the
      --   key blocks.
      continue when exists (select 1 from public.comm_deliveries d
                             where d.dedupe_key = v_key
                               and not (d.status = 'skipped'
                                        and d.error_code in ('rule_edited', 'rule_paused', 'rule_inactive')
                                        and (d.ambiguous_since is null or d.ambiguous_since >= now() - interval '20 hours')));
      if v_used >= coalesce(v_cap, 100) then
        v_capped := v_capped + 1;
        continue;
      end if;
      insert into public.comm_deliveries
        (kind, rule_id, rule_name, user_id, subscription_id, email, recipient_name, vars, dedupe_key, run_on)
      values ('automation', v_rule.id, v_rule.name, v_match.user_id, v_match.subscription_id, v_match.email,
              v_match.full_name, v_match.vars, v_key, v_on)
      -- A dropped row starts over with its full three attempts. It keeps its retry generation and
      -- ambiguous_since: if an earlier attempt may have been delivered, the same key still
      -- de-duplicates it, and it is never sent once that attempt is 20 hours old.
      on conflict (dedupe_key) do update
         set status = 'queued', error_code = null, next_attempt_at = null, attempts = 0, claimed_at = null,
             rule_name = excluded.rule_name, user_id = excluded.user_id, subscription_id = excluded.subscription_id,
             email = excluded.email, recipient_name = excluded.recipient_name, vars = excluded.vars,
             run_on = excluded.run_on, created_at = now(), updated_at = now()
       where comm_deliveries.status = 'skipped'
         and comm_deliveries.error_code in ('rule_edited', 'rule_paused', 'rule_inactive')
         and (comm_deliveries.ambiguous_since is null
              or comm_deliveries.ambiguous_since >= now() - interval '20 hours');
      if found then
        v_queued := v_queued + 1;
        v_used := v_used + 1;
      end if;
    end loop;
    update public.comm_automation_rules
       set last_run_on = v_on, last_run_at = now(),
           last_complete_on = case when v_capped = 0 then v_on else last_complete_on end
     where id = v_rule.id;
    v_rules := v_rules || jsonb_build_object('rule_id', v_rule.id, 'name', v_rule.name,
      'matched', v_matched, 'queued', v_queued, 'capped', v_capped, 'window_days', v_window);
    v_total_q := v_total_q + v_queued;
    v_total_c := v_total_c + v_capped;
  end loop;

  update public.comm_settings
     set last_automation_run = jsonb_build_object('on', v_on, 'queued', v_total_q, 'capped', v_total_c, 'rules', v_rules),
         last_automation_run_at = now()
   where id;
  return jsonb_build_object('on', v_on, 'queued', v_total_q, 'capped', v_total_c, 'rules', v_rules);
end;
$fn$;
revoke all on function public.comm_enqueue_automations(date) from public, anon, authenticated;
grant execute on function public.comm_enqueue_automations(date) to service_role;


-- == 6) Receivables worklist: reminder counts + package/batch filters ==========
-- ★ DROP FIRST: `create or replace` cannot change an argument list, and scripts/audit-db.mjs
--   asserts exactly one overload. The body is #58's, with the batch resolution #59 uses
--   for its sales report, and reminder counts keyed on the REQUEST — the legacy counter
--   keyed on the subject line reset whenever anyone reworded the email.
drop function if exists public.finance_receivables_worklist(numeric, text, integer, integer);
create or replace function public.finance_receivables_worklist(
  p_min_outstanding numeric default 0.01,
  p_bucket          text default null,
  p_limit           integer default 50,
  p_offset          integer default 0,
  p_plan_keys       text[] default null,
  p_batch_ids       uuid[] default null
) returns table (
  source text, enrollment_id uuid, student_user_id uuid, student_email text,
  full_name text, plan_key text, plan_name text, approved_on date,
  contract_amount numeric, collected numeric, outstanding numeric,
  last_payment_on date, days_since_approval integer, days_since_last_payment integer,
  aging_bucket text, batch_id uuid, batch_code text, reminder_count integer, last_reminder_at timestamptz,
  total_count bigint, total_outstanding numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_tz text; v_today date; v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_bucket is not null and p_bucket not in ('current','1-30','31-60','61-90','90+') then
    raise exception 'finance_receivables_worklist: unknown bucket %', p_bucket using errcode = '22023';
  end if;

  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today  := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;
  v_limit  := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));

  return query
  with base as (
    select 'toolkit'::text as src, r.id as eid, r.user_id, r.email, r.full_name,
           r.plan_key, r.plan_name,
           (coalesce(r.reviewed_at, r.created_at) at time zone coalesce(v_tz,'Asia/Manila'))::date as approved,
           r.amount_expected as contract,
           public.finance_request_collected(r.id) as collected,
           (select max(pe.occurred_on) from public.finance_payment_events pe
             where pe.enrollment_request_id = r.id and pe.direction = 'in'
               and not exists (select 1 from public.finance_journal_entries rv
                                where rv.reverses_entry_id = pe.journal_entry_id)) as last_pay,
           coalesce(r.batch_id, (select s.batch_id from public.subscriptions s
                                  where s.request_id = r.id and s.batch_id is not null
                                  order by s.created_at desc limit 1)) as bid
      from public.enrollment_requests r
     where r.status = 'approved'
       and (p_plan_keys is null or cardinality(p_plan_keys) = 0 or r.plan_key = any(p_plan_keys))
  ), calc as (
    select b.*, greatest(b.contract - b.collected, 0) as outstanding,
           (v_today - b.approved) as d_appr,
           (v_today - coalesce(b.last_pay, b.approved)) as d_pay
      from base b
     where (p_batch_ids is null or cardinality(p_batch_ids) = 0 or b.bid = any(p_batch_ids))
  ), bucketed as (
    select c.*,
           case when c.d_pay <= 0 then 'current'
                when c.d_pay <= 30 then '1-30'
                when c.d_pay <= 60 then '31-60'
                when c.d_pay <= 90 then '61-90'
                else '90+' end as bucket
      from calc c
     where c.outstanding >= coalesce(p_min_outstanding, 0.01)
  ), filtered as (
    select * from bucketed where p_bucket is null or bucket = p_bucket
  )
  select f.src, f.eid, f.user_id, f.email, f.full_name, f.plan_key, f.plan_name,
         f.approved, f.contract::numeric(14,2), f.collected::numeric(14,2),
         f.outstanding::numeric(14,2), f.last_pay, f.d_appr::integer, f.d_pay::integer,
         f.bucket, f.bid, bt.code,
         (select count(*) from public.comm_deliveries d
           where d.enrollment_request_id = f.eid and d.kind = 'payment_reminder' and d.status = 'sent')::integer,
         (select max(d.sent_at) from public.comm_deliveries d
           where d.enrollment_request_id = f.eid and d.kind = 'payment_reminder' and d.status = 'sent'),
         count(*) over ()::bigint,
         sum(f.outstanding) over ()::numeric(14,2)
    from filtered f
    left join public.batches bt on bt.id = f.bid
   order by f.outstanding desc, f.approved
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_receivables_worklist(numeric, text, integer, integer, text[], uuid[]) from public, anon, authenticated;
grant execute on function public.finance_receivables_worklist(numeric, text, integer, integer, text[], uuid[]) to authenticated;


-- == 7) app_error_catalog() — restated IN FULL ================================
-- ★ One VALUES list, so a delta is not expressible. Generated from #60's catalog plus
--   #61's codes, so no earlier code can be dropped in transcription.
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
    ('COMM_CAP_INVALID',             422, 'The daily limit must be between 1 and 50,000.')
  ) as t(code, http, summary);
$cat$;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-16-communications.sql', null,
  'communications (#61): communications.send (21st permission, super_admin only); comm_settings (daily cap), '
  'comm_automation_rules (born paused by trigger; editing or pausing drops what it queued), comm_campaigns '
  '(client idempotency key) and comm_deliveries (one row per recipient, unique dedupe_key, retry backoff and '
  'retry generation), each with one SELECT policy (payment-reminder rows also need finance.manage) and no client '
  'write path. The audience is resolved server-side from PROFILE addresses (members, batch, packages, approval '
  'range, one request, receivables, or <=50 pasted addresses; membership audiences exclude staff). Service-only '
  'claim/record/enqueue functions re-check every row at send time (cancelled, inactive rule, no longer eligible, '
  'nothing due), record only the claiming attempt, and hand back unsent rows without spending an attempt; program '
  'weeks count from the first term of a renewal chain; missed or capped days are caught up. Payment reminders '
  'never store payment details. finance_receivables_worklist re-signed with package/batch filters and reminder '
  'counts keyed on the request.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The permission exists and only Super Admin holds it:
--      select count(*) from public.staff_permissions;                                   -> 21
--      select role_key from public.staff_role_permissions
--       where permission_key = 'communications.send';                                   -> super_admin
--
-- 2) Four comm tables, each with RLS and exactly one SELECT policy:
--      select tablename, count(*), min(cmd) from pg_policies
--       where tablename like 'comm\_%' group by 1;                                        -> 1, SELECT each
--
-- 3) One worklist overload:
--      select count(*) from pg_proc where proname = 'finance_receivables_worklist';     -> 1
--
-- 4) Owner steps: set CRON_SECRET in Vercel, at least 16 characters (the daily automation run fails closed
--    without it), confirm RESEND_API_KEY / RESEND_FROM, and set the daily cap in
--    Communications → Settings to match the Resend plan.
--
-- 5) npm run db:audit -> clean, including the #61 checks.
