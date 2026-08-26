-- ─────────────────────────────────────────────────────────────────────────────
-- #45 — Staff authorization: Super Admin / Operations Admin / Trainer.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS REPLACES
--   Authorization in this product is one boolean. profiles.is_admin drives
--   public.is_admin(), which appears 295 times in the bootstrap and across ~38
--   dated migrations, plus 145 frontend checks and four hand-rolled copies of the
--   same API gate. Every admin can therefore approve payments, author and delete
--   courses, manage batches, import students, moderate the community and edit
--   global settings. There is no way to hire a Trainer.
--
-- ★ THE DESIGN DECISION THAT MAKES THIS SAFE, AND THE ONE THING TO UNDERSTAND
--   BEFORE EDITING ANYTHING BELOW.
--
--   This file does NOT rewrite those 295 references. is_admin() is left exactly
--   as it was. What changes is the MEANING of the column it reads:
--
--       profiles.is_admin  ==  "has an ACTIVE super_admin staff membership"
--
--   and that column stops being an input. It becomes a cache, written only by the
--   trigger in section 7, with UPDATE revoked from every client role in section
--   10. Every legacy is_admin() check therefore keeps working and silently
--   narrows to Super-Admin-only, including the ~20 SECURITY DEFINER bodies that
--   read the p.is_admin COLUMN directly rather than calling the function
--   (user_community_capabilities, trainer_visible_courses, my_community_sidebar,
--   batch_entitlements_guard, search_community_members, …).
--
--   Operations Admins and Trainers carry is_admin = false and reach their
--   features ONLY through has_staff_permission(). So a legacy check we failed to
--   find UNDER-grants — a broken Ops feature, loud and reported — instead of
--   over-granting. That direction is the entire safety argument. Do not "fix" a
--   missed check by handing a non-super role is_admin = true.
--
-- ★ TWO PLACES REALLY DID NEED CHANGING, and both are fixed here.
--
--   Section 11 fixes batch_entitlements_guard(), which asserts "granted_by must
--   be an admin" by reading profiles.is_admin. An Operations Admin approving a
--   VIP enrollment has is_admin = false, so grant_batch_run(…, auth.uid(), true)
--   — called from admin_finalize_enrollment — would fail with FORBIDDEN.
--
--   Section 15 fixes the larger one, which the first draft of this file missed
--   entirely: admin_finalize_enrollment(), approve_subscription(),
--   approve_extension(), expire_overdue_subscriptions() and the eight admin_*
--   batch RPCs each opened with `if not public.is_admin()`. auth.uid() is
--   unchanged inside a SECURITY DEFINER chain, so an Operations Admin was refused
--   at the FIRST line and never reached section 11's fix at all. Section 15
--   re-gates all eleven onto has_staff_permission(), along with the fourteen RLS
--   policies and the one storage policy those same screens read.
--
-- ★ ONE THING IS DELIBERATELY NOT FIXED HERE, BECAUSE IT IS A CLIENT CHANGE.
--   Section 10 drops profiles_admin_update and revokes UPDATE on profiles, but a
--   pre-#45 Access Requests screen still issues a direct profiles.update().
--   PostgREST answers a policy-filtered UPDATE with ZERO ROWS AND NO ERROR, so
--   approving a signup would silently do nothing while reporting success.
--   Sections 10 and 15d add admin_review_access_request() and
--   admin_access_request_queue() to replace that write and its companion read.
--   ⇒ DEPLOY THE MATCHING CLIENT BUILD IN THE SAME RELEASE AS THIS MIGRATION.
--
-- ORDERING INSIDE THIS FILE IS LOAD-BEARING:
--   tables → seed → BACKFILL existing admins → ASSERT one survives → helpers →
--   RLS → the is_admin cache trigger → guards → RPCs → the profiles lockdown.
--   The backfill must precede the assert or the file fails on every real
--   database; the assert must precede the lockdown or a mistake is unrecoverable
--   from the client.
--
-- Depends on: #1 (profiles), #2 (is_admin), #9 (approval columns), #12/#13
--   (enrollment + subscriptions), #31 (schema_migrations), #35 (app_error).
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create … if not exists / create or replace / drop … if exists /
--   on conflict) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight ============================================================
-- schema_migrations first: without it the tail insert aborts the whole file.
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'Run db/2026-06-15-auth-profiles-base.sql (#1) first.';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Run db/2026-06-16-course-platform-base.sql (#2) first.';
  end if;
  if to_regprocedure('public.app_error(text,text,int,jsonb)') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles'
                    and column_name = 'approval_status') then
    raise exception 'Run db/2026-06-29-user-approval.sql (#9) first.';
  end if;
  if to_regclass('public.batch_entitlements') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) first — section 11 rewrites its guard.';
  end if;
end
$pre$;


-- == 1) Tables ===============================================================
-- Three lookup tables + one membership row per staff user + an append-only
-- event ledger.
--
-- ★ ONE membership row per user (unique on user_id), mutated in place. History
--   lives in staff_role_events, which is never updated or deleted. That keeps
--   the hot authorization lookup a single indexed row rather than a
--   "most recent row wins" scan inside every RLS evaluation.

create table if not exists public.staff_roles (
  key          text primary key,
  label        text not null,
  rank         integer not null,
  is_protected boolean not null default false,
  description  text,
  created_at   timestamptz not null default now()
);

comment on table public.staff_roles is
  '#45: fixed role templates. `rank` orders the UI and answers promotion-vs-demotion; '
  'it is NEVER an authorization input — staff_role_permissions is. `is_protected` marks '
  'the role the last-Super-Admin guard defends.';

create table if not exists public.staff_permissions (
  key         text primary key,
  category    text not null,
  label       text not null,
  description text,
  created_at  timestamptz not null default now()
);

comment on table public.staff_permissions is
  '#45: the capability vocabulary. Mirrored by STAFF_PERMISSIONS in '
  'src/lib/staffRoles.js and pinned by test/staffRolesSql.test.mjs.';

create table if not exists public.staff_role_permissions (
  role_key       text not null references public.staff_roles(key)       on delete cascade,
  permission_key text not null references public.staff_permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);

comment on table public.staff_role_permissions is
  '#45: THE matrix. has_staff_permission() reads this table, so an operator may grant '
  'a capability here in SQL and the client will honour it (normalizeStaffContext prefers '
  'the server''s permission list over its local copy).';

create table if not exists public.staff_memberships (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users(id) on delete cascade,
  role_key          text not null references public.staff_roles(key),
  status            text not null default 'invited'
                    check (status in ('invited', 'active', 'suspended', 'revoked')),
  display_title     text,
  invited_by        uuid references auth.users(id) on delete set null,
  invited_at        timestamptz,
  activated_at      timestamptz,
  suspended_at      timestamptz,
  revoked_at        timestamptz,
  suspension_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.staff_memberships is
  '#45: one row per staff user. ONLY status = ''active'' confers authority — '
  '''invited'' (has not accepted yet), ''suspended'' and ''revoked'' confer none, which is '
  'what makes a suspension take effect on the very next request rather than on the next '
  'JWT refresh. No client write policy: every write goes through an admin_* RPC so the '
  'staff_role_events row cannot be bypassed.';

create table if not exists public.staff_role_events (
  id             bigint generated always as identity primary key,
  actor_user_id  uuid references auth.users(id) on delete set null,
  actor_email    text,
  target_user_id uuid references auth.users(id) on delete set null,
  target_email   text,
  action         text not null
                 check (action in ('bootstrap', 'invite', 'assign', 'role_change',
                                   'suspend', 'reactivate', 'revoke')),
  from_role_key  text,
  to_role_key    text,
  from_status    text,
  to_status      text,
  reason         text,
  source         text not null default 'admin_ui'
                 check (source in ('admin_ui', 'bootstrap_script', 'migration', 'sql')),
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.staff_role_events is
  '#45: append-only audit ledger. The actor/target FKs are ON DELETE SET NULL and the '
  'emails are denormalized SNAPSHOTS, so deleting an Auth user can never destroy the '
  'record of what they were granted or who granted it. Never add an update or delete policy.';


-- == 2) Seed the roles, permissions and the matrix ===========================
-- ★ Mirrored EXACTLY by src/lib/staffRoles.js. test/staffRolesSql.test.mjs reads
--   both files as text and fails on any divergence, in this file AND in the
--   bootstrap fold. Change one, change all three.
--
-- ★ `on conflict do update` on the lookup rows so a re-run refreshes copy, but
--   the matrix is `do nothing` and there is deliberately NO delete-what-is-not-
--   seeded pass: an operator who grants a capability in SQL has made a decision,
--   and re-running a migration must not silently revoke it.

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
  ('staff.manage',             'Staff',     'Invite and manage staff',        'Invite staff, assign and change roles, suspend and revoke access.'),
  ('staff.audit.read',         'Staff',     'View the staff audit trail',     'Read the full history of role assignments, suspensions and revocations.'),
  ('access_requests.review',   'Students',  'Review account access requests', 'Approve or reject new account signups.'),
  ('enrollments.review',       'Students',  'Review payment proofs',          'Approve or reject enrollment, renewal, upgrade and extension requests.'),
  ('students.assign_courses',  'Students',  'Choose granted courses',         'Select which plan-eligible course programs an approval grants.'),
  ('students.extend_access',   'Students',  'Grant special extensions',       'Extend a membership expiry outside the paid request flow. Always audited.'),
  ('students.import',          'Students',  'Import students',                'Run the Thinkific migration wizard and issue invitations.'),
  ('batches.manage',           'Students',  'Manage cohort batches',          'Create, edit, close and archive batches, and assign members to them.'),
  ('courses.create',           'Courses',   'Create courses',                 'Create a new draft course and duplicate an existing one.'),
  ('courses.manage_assigned',  'Courses',   'Edit assigned courses',          'Edit the modules, lessons and videos of courses assigned to you.'),
  ('courses.manage_all',       'Courses',   'Edit every course',              'Edit any course, whether or not it is assigned to you.'),
  ('courses.publish',          'Courses',   'Publish and unpublish courses',  'Make a course visible to students, or withdraw it.'),
  ('courses.delete',           'Courses',   'Delete courses',                 'Permanently delete a course and its unreferenced media.'),
  ('course_trainer.manage',    'Courses',   'Manage AI trainer indexing',     'Enable, sync, transcribe and preview the AI course trainer.'),
  ('community.manage',         'Community', 'Configure the community',        'Create and edit channels, categories and audience rules.'),
  ('community.moderate',       'Community', 'Moderate the community',         'Pin, lock, hide and hard-delete posts and replies.'),
  ('sidebar.customize',        'Settings',  'Customize navigation labels',    'Rename stages, groups and tabs for every user in the app.'),
  ('payment_settings.manage',  'Settings',  'Edit payment settings',          'Change the manual-payment instructions and the notification address.')
on conflict (key) do update
  set category = excluded.category,
      label = excluded.label,
      description = excluded.description;

-- THE matrix: 18 + 5 + 3 = 26 grants.
--
-- ★ operations_admin deliberately does NOT hold students.extend_access. A
--   discretionary extension creates paid access with no payment behind it, so it
--   stays with the role that owns the money. Ops Admins extend access the normal
--   way, by approving an extension REQUEST, which carries a receipt.
-- ★ trainer deliberately does NOT hold courses.publish or courses.delete.
--   Publishing exposes content to every paying student and is what #44's
--   courses_publish_guard exists to gate; deleting removes storage objects that a
--   DUPLICATED course may still reference by path, since duplication reuses the
--   source course's files by reference rather than copying them.
insert into public.staff_role_permissions (role_key, permission_key) values
  ('super_admin', 'staff.manage'),
  ('super_admin', 'staff.audit.read'),
  ('super_admin', 'access_requests.review'),
  ('super_admin', 'enrollments.review'),
  ('super_admin', 'students.assign_courses'),
  ('super_admin', 'students.extend_access'),
  ('super_admin', 'students.import'),
  ('super_admin', 'batches.manage'),
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
  ('trainer', 'courses.create'),
  ('trainer', 'courses.manage_assigned'),
  ('trainer', 'course_trainer.manage')
on conflict do nothing;


-- == 3) Backfill: every existing admin becomes an active Super Admin =========
-- ★ THIS IS THE LOCKOUT GUARD, and it must run before section 4.
--   is_admin() still reads profiles.is_admin at this point, so nothing has
--   changed behaviourally yet. What this does is give every account that
--   currently HAS that flag a real membership, so that when section 7 makes the
--   column a derived cache, the same people keep the same access.
--
--   Deliberately `do nothing` on conflict: on a re-run, an account that has since
--   been demoted from the UI has is_admin = false and is not selected here, so a
--   demotion is never silently undone.
insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at)
select p.id, 'super_admin', 'active', now(), now()
  from public.profiles p
 where p.is_admin = true
on conflict (user_id) do nothing;

insert into public.staff_role_events
  (actor_user_id, target_user_id, target_email, action, to_role_key, to_status, reason, source)
select null, m.user_id, p.email, 'bootstrap', 'super_admin', 'active',
       'Migrated from profiles.is_admin by #45.', 'migration'
  from public.staff_memberships m
  join public.profiles p on p.id = m.user_id
 where m.role_key = 'super_admin'
   and not exists (
     select 1 from public.staff_role_events e
      where e.target_user_id = m.user_id and e.action = 'bootstrap'
   );


-- == 4) Refuse to continue with no active Super Admin ========================
-- Super Admin is the only role that can create another Super Admin. If this file
-- completed with zero of them, nobody could manage staff, courses or settings and
-- the only way back would be the break-glass script. Fail loudly instead.
--
-- ★ GUARDED ON `profiles` BEING NON-EMPTY, and that is not a softening — it is
--   what lets this file be folded into 000_full_database_bootstrap.sql verbatim.
--   A fresh install runs the bootstrap against a database with no auth users at
--   all, so section 3 has nothing to migrate and an unguarded assert would abort
--   the entire bootstrap. The check exists to protect an EXISTING installation
--   from losing its administrators; a database with no accounts has none to lose.
--   On a real database with users but no admin flag it still raises, which is the
--   case that matters.
do $assert$
begin
  if exists (select 1 from public.profiles)
     and not exists (
       select 1 from public.staff_memberships
        where role_key = 'super_admin' and status = 'active'
     ) then
    raise exception
      '#45 refuses to continue: no active super_admin exists. Set profiles.is_admin = true '
      'on the founder account (see db/README.md), then re-run this file. Running scripts/'
      'bootstrap-super-admin.mjs afterwards is the other supported path.';
  end if;
end
$assert$;


-- == 5) Authorization helpers ================================================
-- ★ TWO FORMS, and the split is the security boundary.
--
--   user_has_staff_permission(uuid, text) answers about ANY user. It is revoked
--   from every client role and is callable only by other SECURITY DEFINER bodies
--   running as the owner. This is the "internal user-specific helper" form.
--
--   has_staff_permission(text) / is_super_admin() / my_staff_context() answer
--   about the CALLER only, are pinned to auth.uid() internally, and are granted
--   to authenticated. Granting them is not optional: an RLS qual is evaluated AS
--   THE QUERYING ROLE, so without the grant every gated read fails with
--   "permission denied for function" instead of a clean authorization denial.
--
-- ★ set search_path = public, pg_temp — pg_temp LAST, deliberately. When pg_temp
--   is not named it is searched FIRST for relation names, so a user who can
--   create a temp table could shadow an unqualified reference inside a SECURITY
--   DEFINER body. Every reference below is schema-qualified as well. Keep both.

create or replace function public.user_has_staff_permission(p_user uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.staff_memberships m
      join public.staff_role_permissions rp on rp.role_key = m.role_key
     where m.user_id = p_user
       and m.status = 'active'
       and rp.permission_key = p_permission
  )
$fn$;

comment on function public.user_has_staff_permission(uuid, text) is
  '#45: INTERNAL. Answers about an arbitrary user, so it is revoked from anon and '
  'authenticated and callable only from other SECURITY DEFINER bodies. Client code uses '
  'has_staff_permission(text), which is pinned to auth.uid().';

revoke all on function public.user_has_staff_permission(uuid, text) from public, anon, authenticated;

create or replace function public.has_staff_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.user_has_staff_permission((select auth.uid()), p_permission)
$fn$;

comment on function public.has_staff_permission(text) is
  '#45: does the CALLER hold this capability? The one predicate every staff-gated RLS '
  'policy and admin RPC reads. Wrap it as (select public.has_staff_permission(''x'')) in a '
  'policy so Postgres evaluates it once per statement as an InitPlan, not once per row.';

revoke all on function public.has_staff_permission(text) from public, anon;
grant execute on function public.has_staff_permission(text) to authenticated;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.staff_memberships m
     where m.user_id = (select auth.uid())
       and m.status = 'active'
       and m.role_key = 'super_admin'
  )
$fn$;

comment on function public.is_super_admin() is
  '#45: the caller holds an ACTIVE super_admin membership. Equivalent to is_admin() by '
  'construction — section 7 keeps profiles.is_admin as exactly this predicate''s cache — '
  'but it reads the membership table directly, so it cannot drift.';

revoke all on function public.is_super_admin() from public, anon;
grant execute on function public.is_super_admin() to authenticated;

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
       -- #46 replaces this function to fill assigned_course_ids from
       -- course_staff_assignments. Until then a Trainer has no assignments,
       -- which is true rather than merely convenient.
       'assigned_course_ids', '[]'::jsonb
     )
     from public.staff_memberships m
     join public.staff_roles r on r.key = m.role_key
    where m.user_id = (select auth.uid())),
    jsonb_build_object('is_staff', false)
  )
$fn$;

comment on function public.my_staff_context() is
  '#45: the ONE call the client and the api/ handlers make to learn who they are. Returns '
  'the caller''s membership plus its effective permissions, read LIVE from the database — '
  'never decoded from a JWT claim, which is why suspending a staff member takes effect on '
  'their next request instead of on their next token refresh. Note it returns a non-active '
  'membership as-is: normalizeStaffContext() in src/lib/staffRoles.js is what refuses '
  'authority for anything but ''active'', and the SQL predicates do the same independently.';

revoke all on function public.my_staff_context() from public, anon;
grant execute on function public.my_staff_context() to authenticated;

create or replace function public.staff_role_permission_matrix()
returns table (role_key text, role_label text, rank integer, permission_key text,
               permission_label text, category text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.key, r.label, r.rank, p.key, p.label, p.category
    from public.staff_roles r
    join public.staff_role_permissions rp on rp.role_key = r.key
    join public.staff_permissions p on p.key = rp.permission_key
   order by r.rank desc, p.category, p.key
$fn$;

comment on function public.staff_role_permission_matrix() is
  '#45: the role-capability preview in Admin → Team & Roles. Not sensitive — it describes '
  'the product''s role design, not who holds what.';

revoke all on function public.staff_role_permission_matrix() from public, anon;
grant execute on function public.staff_role_permission_matrix() to authenticated;


-- == 6) RLS on the staff tables ==============================================
-- ★ The three lookup tables are readable by any signed-in user: they describe the
--   role model, not who holds it. staff_memberships and staff_role_events are not.
--
-- ★ staff_memberships_self_read uses a BARE user_id = auth.uid() with no function
--   call. Calling has_staff_permission() there would re-enter this table's own
--   policies and recurse. The manage-read branch is safe precisely because it
--   goes through a SECURITY DEFINER helper, which bypasses RLS.
--
-- ★ No write policy on any of these tables, plus the explicit revoke below.
--   Supabase's default grants survive a missing policy, so RLS alone is not
--   enough — without the revoke, PostgREST would happily accept an INSERT and the
--   staff_role_events row would never be written.

alter table public.staff_roles            enable row level security;
alter table public.staff_permissions      enable row level security;
alter table public.staff_role_permissions enable row level security;
alter table public.staff_memberships      enable row level security;
alter table public.staff_role_events      enable row level security;

drop policy if exists staff_roles_read on public.staff_roles;
create policy staff_roles_read on public.staff_roles
  for select to authenticated using (true);

drop policy if exists staff_permissions_read on public.staff_permissions;
create policy staff_permissions_read on public.staff_permissions
  for select to authenticated using (true);

drop policy if exists staff_role_permissions_read on public.staff_role_permissions;
create policy staff_role_permissions_read on public.staff_role_permissions
  for select to authenticated using (true);

drop policy if exists staff_memberships_self_read on public.staff_memberships;
create policy staff_memberships_self_read on public.staff_memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists staff_memberships_manage_read on public.staff_memberships;
create policy staff_memberships_manage_read on public.staff_memberships
  for select to authenticated
  using ((select public.has_staff_permission('staff.manage')));

drop policy if exists staff_role_events_audit_read on public.staff_role_events;
create policy staff_role_events_audit_read on public.staff_role_events
  for select to authenticated
  using ((select public.has_staff_permission('staff.audit.read')));

revoke insert, update, delete, truncate on public.staff_roles            from authenticated, anon, public;
revoke insert, update, delete, truncate on public.staff_permissions      from authenticated, anon, public;
revoke insert, update, delete, truncate on public.staff_role_permissions from authenticated, anon, public;
revoke insert, update, delete, truncate on public.staff_memberships      from authenticated, anon, public;
revoke insert, update, delete, truncate on public.staff_role_events      from authenticated, anon, public;

grant select on public.staff_roles            to authenticated;
grant select on public.staff_permissions      to authenticated;
grant select on public.staff_role_permissions to authenticated;
grant select on public.staff_memberships      to authenticated;
grant select on public.staff_role_events      to authenticated;


-- == 7) profiles.is_admin becomes a derived cache ============================
-- ★ THE HINGE OF THIS WHOLE MIGRATION. is_admin() is not modified; the column it
--   reads is now written only here, in the same transaction as the membership
--   change, so suspending a Super Admin revokes their access immediately rather
--   than at their next token refresh.
--
--   Every legacy is_admin() call site and every direct p.is_admin column read
--   therefore keeps working and now means "active Super Admin".

create or replace function public.staff_sync_is_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
begin
  update public.profiles p
     set is_admin = exists (
           select 1 from public.staff_memberships m
            where m.user_id = v_user
              and m.status = 'active'
              and m.role_key = 'super_admin'
         ),
         updated_at = now()
   where p.id = v_user;
  return coalesce(new, old);
end;
$fn$;

comment on function public.staff_sync_is_admin() is
  '#45: keeps profiles.is_admin equal to "has an ACTIVE super_admin membership". That column '
  'is a CACHE, not an input — 295 legacy is_admin() references and ~20 direct column reads '
  'depend on it meaning exactly this. UPDATE on profiles is revoked from every client role '
  'in section 10, so this trigger is the only writer.';

revoke all on function public.staff_sync_is_admin() from public, anon, authenticated;

drop trigger if exists staff_sync_is_admin on public.staff_memberships;
create trigger staff_sync_is_admin
  after insert or update or delete on public.staff_memberships
  for each row execute function public.staff_sync_is_admin();

-- One-time reconcile, so the column matches the table the moment the trigger
-- exists. A no-op on a correct first run (section 3 gave every is_admin account a
-- membership); on a re-run it clears the flag from anyone since demoted in the UI.
update public.profiles p
   set is_admin = exists (
         select 1 from public.staff_memberships m
          where m.user_id = p.id and m.status = 'active' and m.role_key = 'super_admin'
       ),
       updated_at = now()
 where p.is_admin is distinct from exists (
         select 1 from public.staff_memberships m
          where m.user_id = p.id and m.status = 'active' and m.role_key = 'super_admin'
       );


-- == 8) The last-Super-Admin guard, as a trigger =============================
-- ★ Enforced HERE and not only in the RPCs, so a direct SQL UPDATE or an
--   auth.users deletion is caught too. staff_memberships.user_id is ON DELETE
--   CASCADE from auth.users, so deleting the last Super Admin's Auth account
--   fires this as a DELETE and the account deletion itself fails — which is the
--   documented rule: promote a replacement first.
--
-- ★ SECURITY DEFINER is mandatory, not stylistic: public.app_error is SECURITY
--   INVOKER and revoked from public, anon AND authenticated, so a definer-less
--   trigger would fail with "permission denied for function app_error".

create or replace function public.staff_memberships_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_was_active_super boolean;
  v_still_active_super boolean;
begin
  v_was_active_super := (old.role_key = 'super_admin' and old.status = 'active');
  if not v_was_active_super then
    return coalesce(new, old);
  end if;

  v_still_active_super := (tg_op = 'UPDATE'
                           and new.role_key = 'super_admin'
                           and new.status = 'active');
  if v_still_active_super then
    return new;
  end if;

  -- Anyone ELSE still holding the fort?
  if not exists (
    select 1 from public.staff_memberships m
     where m.user_id <> old.user_id
       and m.role_key = 'super_admin'
       and m.status = 'active'
  ) then
    perform public.app_error('STAFF_LAST_SUPER_ADMIN',
      'This is the last active Super Admin. Promote another Super Admin first — otherwise '
      'nobody can manage staff, courses or settings.', 409,
      jsonb_build_object('user_id', old.user_id));
  end if;

  return coalesce(new, old);
end;
$fn$;

comment on function public.staff_memberships_guard() is
  '#45: there must always be at least one ACTIVE super_admin, because super_admin is the '
  'only role that can create another. Mirrored client-side by lastSuperAdminGuard() in '
  'src/lib/staffRoles.js for the confirm dialog; THIS is the boundary.';

revoke all on function public.staff_memberships_guard() from public, anon, authenticated;

drop trigger if exists staff_memberships_guard on public.staff_memberships;
create trigger staff_memberships_guard
  before update or delete on public.staff_memberships
  for each row execute function public.staff_memberships_guard();

drop trigger if exists staff_memberships_touch_updated_at on public.staff_memberships;
create trigger staff_memberships_touch_updated_at
  before update on public.staff_memberships
  for each row execute function public.touch_updated_at();


-- == 9) Staff-management RPCs ================================================
-- All gated on staff.manage; all write a staff_role_events row in the same
-- transaction as the membership change. The tables carry no client write policy,
-- so these are the only writers and the audit row cannot be bypassed.

create or replace function public.admin_upsert_staff_membership(
  p_user_id       uuid,
  p_role_key      text,
  p_display_title text default null,
  p_reason        text default null,
  p_status        text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.staff_memberships%rowtype;
  v_new public.staff_memberships%rowtype;
  v_action text;
begin
  if not public.has_staff_permission('staff.manage') then
    perform public.app_error('FORBIDDEN', 'admin_upsert_staff_membership: staff.manage required', 403, null);
  end if;
  if not exists (select 1 from public.staff_roles where key = p_role_key) then
    perform public.app_error('STAFF_ROLE_INVALID', format('unknown role %s', p_role_key), 422,
      jsonb_build_object('role_key', p_role_key));
  end if;
  if p_status not in ('invited', 'active', 'suspended', 'revoked') then
    perform public.app_error('STAFF_ROLE_INVALID', format('unknown status %s', p_status), 422, null);
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    perform public.app_error('STAFF_NOT_FOUND', 'no profile for that user id', 404,
      jsonb_build_object('user_id', p_user_id));
  end if;

  select * into v_old from public.staff_memberships where user_id = p_user_id for update;

  insert into public.staff_memberships
    (user_id, role_key, status, display_title, invited_by, invited_at, activated_at)
  values
    (p_user_id, p_role_key, p_status, p_display_title, auth.uid(), now(),
     case when p_status = 'active' then now() else null end)
  on conflict (user_id) do update
    set role_key = excluded.role_key,
        status = excluded.status,
        display_title = coalesce(excluded.display_title, public.staff_memberships.display_title),
        activated_at = case
                         when excluded.status = 'active' and public.staff_memberships.activated_at is null
                           then now()
                         else public.staff_memberships.activated_at
                       end,
        suspended_at = case when excluded.status = 'suspended' then now() else null end,
        revoked_at   = case when excluded.status = 'revoked'   then now() else null end,
        updated_at = now()
  returning * into v_new;

  v_action := case
                when v_old.user_id is null then 'assign'
                when v_old.role_key is distinct from v_new.role_key then 'role_change'
                else 'assign'
              end;

  insert into public.staff_role_events
    (actor_user_id, actor_email, target_user_id, target_email, action,
     from_role_key, to_role_key, from_status, to_status, reason, source)
  select auth.uid(),
         (select email from public.profiles where id = auth.uid()),
         p_user_id,
         (select email from public.profiles where id = p_user_id),
         v_action, v_old.role_key, v_new.role_key, v_old.status, v_new.status,
         p_reason, 'admin_ui';

  return jsonb_build_object('ok', true, 'user_id', p_user_id,
                            'role_key', v_new.role_key, 'status', v_new.status);
end;
$fn$;

revoke all on function public.admin_upsert_staff_membership(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_upsert_staff_membership(uuid, text, text, text, text) to authenticated;

create or replace function public.admin_set_staff_status(
  p_user_id uuid,
  p_status  text,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.staff_memberships%rowtype;
  v_action text;
begin
  if not public.has_staff_permission('staff.manage') then
    perform public.app_error('FORBIDDEN', 'admin_set_staff_status: staff.manage required', 403, null);
  end if;
  if p_status not in ('invited', 'active', 'suspended', 'revoked') then
    perform public.app_error('STAFF_ROLE_INVALID', format('unknown status %s', p_status), 422, null);
  end if;

  select * into v_old from public.staff_memberships where user_id = p_user_id for update;
  if v_old.user_id is null then
    perform public.app_error('STAFF_NOT_FOUND', 'that account is not staff', 404,
      jsonb_build_object('user_id', p_user_id));
  end if;

  -- A reason is required for anything that TAKES access away. The guard trigger
  -- independently refuses the last-Super-Admin case.
  if p_status in ('suspended', 'revoked') and coalesce(btrim(p_reason), '') = '' then
    perform public.app_error('STAFF_ROLE_INVALID',
      'a reason is required when suspending or revoking staff access', 422, null);
  end if;

  update public.staff_memberships
     set status = p_status,
         suspension_reason = case when p_status = 'suspended' then p_reason else null end,
         suspended_at = case when p_status = 'suspended' then now() else null end,
         revoked_at   = case when p_status = 'revoked'   then now() else null end,
         activated_at = case when p_status = 'active' and activated_at is null then now() else activated_at end,
         updated_at = now()
   where user_id = p_user_id;

  v_action := case p_status
                when 'suspended' then 'suspend'
                when 'revoked'   then 'revoke'
                when 'active'    then 'reactivate'
                else 'assign'
              end;

  insert into public.staff_role_events
    (actor_user_id, actor_email, target_user_id, target_email, action,
     from_role_key, to_role_key, from_status, to_status, reason, source)
  select auth.uid(),
         (select email from public.profiles where id = auth.uid()),
         p_user_id,
         (select email from public.profiles where id = p_user_id),
         v_action, v_old.role_key, v_old.role_key, v_old.status, p_status, p_reason, 'admin_ui';

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', p_status);
end;
$fn$;

revoke all on function public.admin_set_staff_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_staff_status(uuid, text, text) to authenticated;

create or replace function public.admin_staff_directory()
returns table (
  user_id uuid, email text, full_name text, avatar_url text,
  role_key text, role_label text, rank integer, status text, display_title text,
  invited_by uuid, invited_by_email text, invited_at timestamptz,
  activated_at timestamptz, suspended_at timestamptz, revoked_at timestamptz,
  suspension_reason text, updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.user_id, p.email, p.full_name, p.avatar_url,
         m.role_key, r.label, r.rank, m.status, m.display_title,
         m.invited_by, ip.email, m.invited_at,
         m.activated_at, m.suspended_at, m.revoked_at, m.suspension_reason, m.updated_at
    from public.staff_memberships m
    join public.staff_roles r on r.key = m.role_key
    left join public.profiles p on p.id = m.user_id
    left join public.profiles ip on ip.id = m.invited_by
   where public.has_staff_permission('staff.manage')
   order by r.rank desc, p.full_name nulls last, p.email
$fn$;

comment on function public.admin_staff_directory() is
  '#45: the Team & Roles list. The permission check is IN THE WHERE CLAUSE — a caller '
  'without staff.manage gets zero rows rather than an error, which is the same shape '
  'course_publish_blockers() uses. It reads profiles for other users, which ordinary RLS '
  'forbids, so SECURITY DEFINER is load-bearing here.';

revoke all on function public.admin_staff_directory() from public, anon;
grant execute on function public.admin_staff_directory() to authenticated;

create or replace function public.admin_staff_events(
  p_user_id uuid default null,
  p_limit   integer default 100
)
returns table (
  id bigint, actor_user_id uuid, actor_email text,
  target_user_id uuid, target_email text, action text,
  from_role_key text, to_role_key text, from_status text, to_status text,
  reason text, source text, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select e.id, e.actor_user_id, e.actor_email, e.target_user_id, e.target_email, e.action,
         e.from_role_key, e.to_role_key, e.from_status, e.to_status, e.reason, e.source, e.created_at
    from public.staff_role_events e
   where public.has_staff_permission('staff.audit.read')
     and (p_user_id is null or e.target_user_id = p_user_id)
   order by e.created_at desc, e.id desc
   limit greatest(1, least(coalesce(p_limit, 100), 500))
$fn$;

revoke all on function public.admin_staff_events(uuid, integer) from public, anon;
grant execute on function public.admin_staff_events(uuid, integer) to authenticated;


-- == 10) The profiles lockdown ===============================================
-- ★ profiles_admin_update was `for all to authenticated using (is_admin()) with
--   check (is_admin())` over the WHOLE ROW, so any admin could set is_admin = true
--   on any profile. With three staff tiers that is a privilege-escalation
--   primitive, and it is also the mechanism section 7 has just made a cache.
--
-- ★ The revoke is TABLE-level and that is not a stylistic choice: a column-level
--   REVOKE does not override a table-level grant. #38 hit exactly this with
--   batches.code and had to revoke the whole UPDATE privilege and re-grant per
--   column. Here nothing needs re-granting — after this file, `authenticated`
--   holds NO update privilege on profiles at all, and every legitimate write
--   goes through a SECURITY DEFINER RPC that runs as the owner:
--     set_my_avatar, complete_import_onboarding, admin_finalize_enrollment,
--     approve_subscription/approve_extension, staff_sync_is_admin,
--     and admin_review_access_request below.

drop policy if exists profiles_admin_update on public.profiles;

revoke update on public.profiles from authenticated, anon;

comment on table public.profiles is
  '#45: profiles is READ-ONLY over PostgREST. `authenticated` holds no UPDATE privilege; '
  'every write goes through a SECURITY DEFINER RPC. is_admin in particular is a CACHE of '
  '"has an active super_admin membership", written only by staff_sync_is_admin().';

-- The Access Requests screen used to UPDATE profiles directly. It cannot any
-- more, so its decision becomes a purpose-built transactional RPC.
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
  v_prev text;
begin
  if not public.has_staff_permission('access_requests.review') then
    perform public.app_error('FORBIDDEN',
      'admin_review_access_request: access_requests.review required', 403, null);
  end if;
  if p_decision not in ('approved', 'rejected', 'pending') then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      format('unknown decision %s', p_decision), 422, null);
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

comment on function public.admin_review_access_request(uuid, text, text) is
  '#45: replaces the AccessRequests screen''s direct UPDATE on profiles, which relied on '
  'profiles_admin_update — the policy this file drops. Gated on access_requests.review, so '
  'an Operations Admin can work the queue without holding any other admin power.';

revoke all on function public.admin_review_access_request(uuid, text, text) from public, anon;
grant execute on function public.admin_review_access_request(uuid, text, text) to authenticated;


-- == 11) batch_entitlements_guard: let an Operations Admin grant a seat ======
-- ★ THE ONE CONFIRMED BLOCKER. The INSERT branch asserts "granted_by must be an
--   admin" by reading profiles.is_admin. After this migration an Operations Admin
--   has is_admin = false, so admin_finalize_enrollment → grant_batch_run(…,
--   auth.uid(), true) would fail with FORBIDDEN on every VIP approval.
--
--   Everything else in this function is #35's body verbatim (as restated by #39).
--   Only the granted_by predicate changes.

create or replace function public.batch_entitlements_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seg_ok boolean;
begin
  if tg_op = 'INSERT' then
    -- A bound seat must have a real, active space for its segment. This is what
    -- makes "granted into a cohort with no space" impossible rather than merely
    -- unlikely.
    if new.batch_id is not null then
      select exists (
        select 1 from public.community_spaces sp
         where sp.batch_id = new.batch_id and sp.kind = new.segment and sp.active
      ) into v_seg_ok;
      if not v_seg_ok then
        perform public.app_error('NO_SPACE_FOR_SEGMENT',
          format('batch has no active %s space', new.segment), 409,
          jsonb_build_object('batch_id', new.batch_id, 'segment', new.segment));
      end if;
    end if;

    -- valid_until may never outlive the source term.
    if new.valid_until is not null and new.source_subscription_id is not null then
      if exists (
        select 1 from public.subscriptions s
         where s.id = new.source_subscription_id
           and s.ends_at is not null
           and new.valid_until > coalesce(s.grace_ends_at, s.ends_at) + interval '1 minute'
      ) then
        perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
          'entitlement would outlive its source subscription term', 409,
          jsonb_build_object('source_subscription_id', new.source_subscription_id));
      end if;
    end if;

    -- granted_by, when set, must be someone allowed to approve enrollments.
    -- ★ #45: was `profiles.is_admin`, which now means Super Admin ONLY. An
    --   Operations Admin holds enrollments.review and is_admin = false, so the
    --   old predicate refused every VIP approval they made.
    if new.granted_by is not null
       and not coalesce((select p.is_admin from public.profiles p where p.id = new.granted_by), false)
       and not public.user_has_staff_permission(new.granted_by, 'enrollments.review') then
      perform public.app_error('FORBIDDEN',
        'granted_by must be an admin or hold enrollments.review', 403, null);
    end if;

    if new.batch_index >= new.run_length then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'batch_index must be inside the run', 409,
        jsonb_build_object('batch_index', new.batch_index, 'run_length', new.run_length));
    end if;

    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────
  -- Frozen identity/provenance columns. Rewriting any of these would destroy
  -- the audit answer to "why did this member have access?".
  if new.user_id     is distinct from old.user_id
     or new.segment      is distinct from old.segment
     or new.batch_index  is distinct from old.batch_index
     or new.run_id       is distinct from old.run_id
     or new.run_length   is distinct from old.run_length
     or new.grant_reason is distinct from old.grant_reason
     or new.granted_at   is distinct from old.granted_at
     or new.created_at   is distinct from old.created_at then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batch entitlement identity columns are frozen', 409, null);
  end if;

  -- ★ Provenance FKs and granted_by may transition to NULL. That is Postgres
  -- executing ON DELETE SET NULL / ON UPDATE CASCADE, which arrives here as an
  -- UPDATE. Freezing them outright would make every referenced profile,
  -- request, subscription and plan key permanently undeletable — a reviewer
  -- found exactly this. Reject only non-null → a DIFFERENT non-null.
  if (old.source_subscription_id is not null and new.source_subscription_id is not null
      and new.source_subscription_id is distinct from old.source_subscription_id)
     or (old.source_plan_key is not null and new.source_plan_key is not null
         and new.source_plan_key is distinct from old.source_plan_key)
     or (old.source_request_id is not null and new.source_request_id is not null
         and new.source_request_id is distinct from old.source_request_id)
     or (old.source_import_row_id is not null and new.source_import_row_id is not null
         and new.source_import_row_id is distinct from old.source_import_row_id)
     or (old.granted_by is not null and new.granted_by is not null
         and new.granted_by is distinct from old.granted_by) then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batch entitlement provenance cannot be re-pointed', 409, null);
  end if;

  -- batch_id: NULL → a real id exactly once (allocation). Never re-pointed,
  -- never cleared. Moving a member between cohorts revokes and re-grants, so
  -- the old seat stays in the record.
  if old.batch_id is not null and new.batch_id is distinct from old.batch_id then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'an allocated seat cannot be moved - revoke it and grant a new one', 409,
      jsonb_build_object('batch_id', old.batch_id));
  end if;

  -- status: queued → active → {revoked|superseded}, both terminal.
  if old.status <> new.status then
    if old.status in ('revoked', 'superseded') then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        format('%s is a terminal entitlement status', old.status), 409, null);
    end if;
    if old.status = 'active' and new.status = 'queued' then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'an allocated seat cannot return to the queue', 409, null);
    end if;
  end if;

  -- valid_until is forward-only. Clearing it (→ NULL) would silently grant
  -- perpetual access; shortening it is a revoke, which has its own path.
  if old.valid_until is not null
     and (new.valid_until is null or new.valid_until < old.valid_until)
     and new.status not in ('revoked', 'superseded') then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'valid_until only moves forward - revoke the seat to end it early', 409, null);
  end if;

  return new;
end;
$$;

revoke all on function public.batch_entitlements_guard() from public, anon, authenticated;

drop trigger if exists batch_entitlements_guard_trg on public.batch_entitlements;
create trigger batch_entitlements_guard_trg
  before insert or update on public.batch_entitlements
  for each row execute function public.batch_entitlements_guard();


-- == 12) Gate-helper EXECUTE hygiene + four unpinned policies ================
-- ★ is_admin() / is_approved() / is_enrolled() are the ONLY SECURITY DEFINER
--   family in this repo with no REVOKE anywhere. Postgres grants EXECUTE to
--   PUBLIC on every new function, so anon can call all three over PostgREST.
--   They return false for anon (auth.uid() is null), so nothing leaks today —
--   but it contradicts #30's own "Function EXECUTE hygiene" pass, which stripped
--   anon from every other member/admin RPC. Closing it here.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke execute on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

revoke execute on function public.is_enrolled() from public, anon;
grant execute on function public.is_enrolled() to authenticated;

-- ★ Four policies were created with no TO clause, so they apply to PUBLIC, which
--   in Supabase includes anon. All four are auth.uid()-keyed and therefore leak
--   nothing, but a policy that names its role is a policy a reviewer can check.
do $pin$
begin
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename = 'profiles' and policyname = 'own_profile_select') then
    drop policy own_profile_select on public.profiles;
    create policy own_profile_select on public.profiles
      for select to authenticated using ((select auth.uid()) = id);
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename = 'subscriptions' and policyname = 'subscriptions_own_select') then
    drop policy subscriptions_own_select on public.subscriptions;
    create policy subscriptions_own_select on public.subscriptions
      for select to authenticated using (user_id = (select auth.uid()));
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename = 'enrollment_requests' and policyname = 'enroll_req_own_select') then
    drop policy enroll_req_own_select on public.enrollment_requests;
    create policy enroll_req_own_select on public.enrollment_requests
      for select to authenticated using (user_id = (select auth.uid()));
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename = 'enrollment_requests' and policyname = 'enroll_req_own_expire') then
    drop policy enroll_req_own_expire on public.enrollment_requests;
    create policy enroll_req_own_expire on public.enrollment_requests
      for update to authenticated
      using (user_id = (select auth.uid()) and status = 'pending_review' and expires_at < now())
      with check (user_id = (select auth.uid()) and status = 'expired');
  end if;
end
$pin$;


-- == 13) Error codes, re-listed in full ======================================
-- app_error_catalog() is replaced wholesale every time, so every existing code
-- must be repeated. Keep in lockstep with APP_ERROR_CODES and APP_ERROR_COPY in
-- src/lib/appErrors.js. Copied from #44 plus the three #45 codes.
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
    ('STAFF_ROLE_INVALID',           422, 'Unknown staff role or status, or a required reason was missing.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


-- == 14) Indexes =============================================================
-- user_id is already unique (the membership lookup). These cover the directory
-- sort and the audit reads.
create index if not exists staff_memberships_role_status_idx
  on public.staff_memberships (role_key, status);

comment on index public.staff_memberships_role_status_idx is
  '#45: the last-Super-Admin guard counts active super_admins on every membership '
  'UPDATE and DELETE; without this it scans the whole table each time.';

create index if not exists staff_role_events_target_idx
  on public.staff_role_events (target_user_id, created_at desc);

create index if not exists staff_role_events_created_idx
  on public.staff_role_events (created_at desc);




-- == 15) Re-gate the operations surface ======================================
-- ★ WITHOUT THIS SECTION THE OPERATIONS ADMIN ROLE IS DECORATIVE, and sections
--   1-14 are an elaborate way of granting nothing.
--
--   Sections 1-11 install the role model and hand Operations Admins
--   `enrollments.review`, `batches.manage`, `students.import` and
--   `students.assign_courses`. But every server-side path those names describe is
--   still gated on `public.is_admin()` — which section 7 has just narrowed to mean
--   *active Super Admin*. `admin_finalize_enrollment` refuses an Ops Admin at its
--   FIRST line, so they never reach the enrollment they are supposed to approve,
--   and never reach section 11's `batch_entitlements_guard` fix either.
--
--   The first draft of this migration missed that entirely. Its header called the
--   guard in section 11 "THE ONE CONFIRMED BLOCKER"; it was not, because nothing
--   could get that far. The lesson worth keeping: when you widen who may do
--   something, trace the WHOLE call path, not the first refusal you happen to
--   find. A guard you fix behind a guard you did not is dead code.
--
-- ★ WHY `has_staff_permission(...)` AND NOT `is_admin() or has_staff_permission(...)`.
--   super_admin holds every permission in the section-2 matrix, so
--   `has_staff_permission('enrollments.review')` is already true for a Super
--   Admin. The single-predicate form is therefore a strict generalisation — no
--   Super Admin loses anything — and it keeps exactly one authorization question
--   per guard instead of two that can drift apart.
--
-- ★ EVERY FUNCTION BELOW IS THE LIVE BODY WITH ONE LINE CHANGED, and it was
--   EXTRACTED MECHANICALLY, not retyped. Hand-restating a long SECURITY DEFINER
--   body is how #33 dropped three statements from `admin_finalize_enrollment`
--   (fixed by #34), and how this very migration's first draft dropped the
--   `valid_until is null` branch from `batch_entitlements_guard` — which would
--   have let a cohort seat be cleared to NULL and become permanent. #43 wrote the
--   lesson down: rebuild from the live definition rather than restating it.
--   test/staffRolesSql.test.mjs diffs each body against its previous definition
--   and fails on any line that is not the guard.
--
-- ★ NOT re-gated here, deliberately: the community admin RPCs
--   (`admin_save_community_channel`, `admin_community_config`, …) and the
--   `payment_settings` / `sidebar_settings` policies. Only super_admin holds
--   `community.manage`, `payment_settings.manage` and `sidebar.customize`, so
--   `is_admin()` and `has_staff_permission(...)` are equivalent for them today.
--   Leaving them alone keeps this section's blast radius to the roles that
--   actually gained a capability.


-- ── 15a/15b) The enrollment and cohort RPCs, live bodies, one line changed ──

create or replace function public.admin_finalize_enrollment(p_request_id uuid, p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req          public.enrollment_requests%rowtype;
  v_prev         public.subscriptions%rowtype;
  v_new          public.subscriptions%rowtype;
  v_plan         public.enrollment_plans%rowtype;
  v_kind         text;
  v_eff_plan     text;
  v_segment      text;
  v_prev_segment text;
  v_batch        uuid;
  v_batch_row    public.batches%rowtype;
  v_count        int;
  v_valid_until  timestamptz;
  v_run          jsonb := null;
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'admin_finalize_enrollment: admin only', 403, null);
  end if;

  select * into v_req from public.enrollment_requests
   where id = p_request_id for update;
  if v_req.id is null then
    perform public.app_error('REQUEST_NOT_FOUND', 'admin_finalize_enrollment: request not found', 404,
      jsonb_build_object('request_id', p_request_id));
  end if;

  -- Idempotency: re-approving an approved request is a no-op.
  if v_req.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_req.status <> 'pending_review' then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      format('admin_finalize_enrollment: request is %s - only pending_review can be approved', v_req.status),
      409, jsonb_build_object('status', v_req.status));
  end if;

  v_kind := coalesce(v_req.request_kind, 'new');

  select * into v_prev from public.subscriptions
   where user_id = v_req.user_id
   order by created_at desc limit 1;

  -- Effective plan: extensions stay on the member's CURRENT plan.
  v_eff_plan := case when v_kind = 'extension'
                     then coalesce(v_prev.plan_key, v_req.plan_key)
                     else v_req.plan_key end;

  select * into v_plan from public.enrollment_plans where key = v_eff_plan;
  if v_plan.key is null then
    perform public.app_error('INVALID_PLAN', format('admin_finalize_enrollment: unknown plan %s', v_eff_plan),
      422, jsonb_build_object('plan_key', v_eff_plan));
  end if;
  -- New sales require a sellable plan; extensions may continue a retired one.
  if v_kind <> 'extension' and not v_plan.active then
    perform public.app_error('INVALID_PLAN', format('admin_finalize_enrollment: plan %s is inactive', v_eff_plan),
      422, jsonb_build_object('plan_key', v_eff_plan));
  end if;

  v_segment := coalesce(v_plan.community_segment, 'general');
  if v_prev.plan_key is not null then
    select coalesce(ep.community_segment, 'general') into v_prev_segment
      from public.enrollment_plans ep where ep.key = v_prev.plan_key;
  end if;

  if v_segment is distinct from 'vip' then
    v_batch := null;
  else
    if v_kind in ('renewal', 'extension') then
      v_batch := coalesce(p_batch_id, v_prev.batch_id, v_req.batch_id);
      if v_kind = 'extension' and p_batch_id is not null
         and v_prev.batch_id is not null and p_batch_id <> v_prev.batch_id then
        perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
          'admin_finalize_enrollment: an extension keeps the current batch - use the batch manager to move members',
          409, jsonb_build_object('current_batch_id', v_prev.batch_id));
      end if;
      -- A renewal may arrive after every held seat lapsed; fall back to the
      -- member's most recent cohort so the run continues from the right place.
      if v_batch is null then
        select e.batch_id into v_batch
          from public.batch_entitlements e
         where e.user_id = v_req.user_id and e.batch_id is not null
         order by e.granted_at desc, e.batch_index desc
         limit 1;
      end if;
    elsif v_kind = 'upgrade' then
      v_batch := p_batch_id;
      if v_batch is null and v_prev.batch_id is not null
         and exists (select 1 from public.community_spaces sp
                      where sp.kind = v_segment and sp.batch_id = v_prev.batch_id and sp.active) then
        v_batch := v_prev.batch_id;
      end if;
      if v_batch is null then v_batch := v_req.batch_id; end if;
    else
      v_batch := coalesce(p_batch_id, v_req.batch_id);
    end if;

    if v_batch is null then
      perform public.app_error('BATCH_REQUIRED',
        format('admin_finalize_enrollment: %s needs a batch - pick an open batch in the approve dialog', v_eff_plan),
        422, jsonb_build_object('plan_key', v_eff_plan, 'segment', v_segment));
    end if;

    -- Read-only validation for a precise error. The LOCK belongs to
    -- grant_batch_run, which takes every batch lock in code order.
    select * into v_batch_row from public.batches where id = v_batch;
    if v_batch_row.id is null then
      perform public.app_error('BATCH_NOT_FOUND', 'admin_finalize_enrollment: batch not found', 404,
        jsonb_build_object('batch_id', v_batch));
    end if;
  end if;

  -- Grant the term through the EXISTING functions (stacking / supersede / grace /
  -- the 60-365 clamp / the legacy-lifetime guard all live there).
  if v_kind = 'extension' then
    if v_req.extension_days is null or v_req.extension_days <= 0 then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'admin_finalize_enrollment: extension request has no extension_days', 409, null);
    end if;
    v_new := public.approve_extension(v_req.user_id, v_req.id, v_req.extension_days);
  else
    v_new := public.approve_subscription(v_req.user_id, v_req.plan_key, v_req.id);
  end if;

  update public.subscriptions
     set batch_id = v_batch, updated_at = now()
   where id = v_new.id;

  -- ── Materialise the cohort run (L1) ───────────────────────────────
  if v_segment = 'vip' then
    v_valid_until := coalesce(v_new.grace_ends_at, v_new.ends_at);

    -- Every outstanding seat rides the new expiry. Forward-only, enforced by the
    -- guard trigger. Without this an extension would leave already-held seats
    -- expiring on the old date.
    update public.batch_entitlements e
       set valid_until = v_valid_until, updated_at = now()
     where e.user_id = v_req.user_id
       and e.status in ('queued', 'active')
       and v_valid_until is not null
       and (e.valid_until is null or e.valid_until < v_valid_until);

    -- A segment change must not leave seats from two segments coexisting.
    if v_prev_segment is not null and v_prev_segment <> v_segment then
      perform public.revoke_batch_run(v_req.user_id, null,
        format('upgrade %s -> %s', v_prev_segment, v_segment), auth.uid(), 'superseded');
    end if;

    v_count := case
                 when v_kind = 'extension'
                   then greatest(1, least(12, ceil(v_req.extension_days / 30.0)::int))   -- D9
                 else public.plan_batch_count(v_plan.access_days, v_plan.eligible_batch_count)
               end;

    if v_count is null then
      perform public.app_error('INVALID_PLAN',
        format('plan %s has no access_days and no eligible_batch_count - cannot size the cohort run', v_eff_plan),
        422, jsonb_build_object('plan_key', v_eff_plan));
    end if;

    v_run := public.grant_batch_run(
      v_req.user_id, v_segment, v_batch, v_count,
      case when v_kind = 'new' then 'approval' else v_kind end,
      v_new.id, v_eff_plan, v_req.id, null, v_valid_until, auth.uid(), true);
  end if;

  -- Profile cache (mirrors the old client step 2).
  update public.profiles
     set is_paid = true,
         plan = v_eff_plan,
         approval_status = 'approved',
         approved_at = now(),
         approved_by = auth.uid(),
         rejected_at = null,
         rejected_by = null,
         rejection_reason = null,
         updated_at = now()
   where id = v_req.user_id;

  -- Request row (mirrors the old client step 3) + the resolved batch.
  update public.enrollment_requests
     set status = 'approved',
         rejection_reason = null,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         batch_id = v_batch,
         updated_at = now()
   where id = v_req.id;

  return jsonb_build_object(
    'ok', true,
    'subscription_id', v_new.id,
    'ends_at', v_new.ends_at,
    'batch_id', v_batch,
    'batch_code', (select code from public.batches where id = v_batch),
    'run', v_run
  );
end;
$$;

create or replace function public.approve_subscription(
  p_user_id    uuid,
  p_plan_key   text,
  p_request_id uuid
)
returns public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_grace_days constant int := 3;   -- grace knob. 3 = access continues 3 days past ends_at.
  v_days   int;
  v_prev   public.subscriptions%rowtype;
  v_base   timestamptz;
  v_ends   timestamptz;
  v_grace  timestamptz;
  v_new    public.subscriptions%rowtype;
begin
  if not public.has_staff_permission('enrollments.review') then
    raise exception 'approve_subscription: admin only';
  end if;

  select access_days into v_days from public.enrollment_plans where key = p_plan_key;

  select * into v_prev
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1
    for update;

  -- Renewal stacking: extend from current expiry if still running, else from now.
  if v_prev.id is not null and v_prev.status = 'active'
     and v_prev.ends_at is not null and v_prev.ends_at > now() then
    v_base := v_prev.ends_at;
  else
    v_base := now();
  end if;

  v_ends  := case when v_days is null then null else v_base + make_interval(days => v_days) end;
  v_grace := case when v_ends is null or v_grace_days = 0 then null
                  else v_ends + make_interval(days => v_grace_days) end;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'active';

  insert into public.subscriptions
    (user_id, plan_key, status, started_at, ends_at, grace_ends_at,
     approved_by, request_id, renewed_from_subscription_id)
  values
    (p_user_id, p_plan_key, 'active', now(), v_ends, v_grace,
     auth.uid(), p_request_id, v_prev.id)
  returning * into v_new;

  return v_new;
end;
$$;

create or replace function public.approve_extension(
  p_user_id    uuid,
  p_request_id uuid,
  p_days       int
)
returns public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_grace_days constant int := 3;
  v_prev   public.subscriptions%rowtype;
  v_base   timestamptz;
  v_ends   timestamptz;
  v_grace  timestamptz;
  v_new    public.subscriptions%rowtype;
begin
  if not public.has_staff_permission('enrollments.review') then
    raise exception 'approve_extension: admin only';
  end if;
  if p_days is null or p_days < 60 then
    raise exception 'approve_extension: minimum extension is 60 days (2 months)';
  end if;
  if p_days > 365 then
    raise exception 'approve_extension: maximum extension is 365 days (12 months)';
  end if;

  select * into v_prev
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1
    for update;

  if v_prev.id is null then
    raise exception 'approve_extension: no subscription to extend for this user';
  end if;
  -- Idempotency + never shorten a legacy no-expiry term.
  if v_prev.status = 'active' and v_prev.request_id = p_request_id then return v_prev; end if;
  if v_prev.status = 'active' and v_prev.ends_at is null then return v_prev; end if;

  if v_prev.status = 'active' and v_prev.ends_at is not null and v_prev.ends_at > now() then
    v_base := v_prev.ends_at;
  else
    v_base := now();
  end if;

  v_ends  := v_base + make_interval(days => p_days);
  v_grace := case when v_grace_days = 0 then null else v_ends + make_interval(days => v_grace_days) end;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'active';

  insert into public.subscriptions
    (user_id, plan_key, status, started_at, ends_at, grace_ends_at,
     approved_by, request_id, renewed_from_subscription_id)
  values
    (p_user_id, v_prev.plan_key, 'active', now(), v_ends, v_grace,
     auth.uid(), p_request_id, v_prev.id)
  returning * into v_new;

  return v_new;
end;
$$;

create or replace function public.expire_overdue_subscriptions()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  if not public.has_staff_permission('enrollments.review') then
    raise exception 'expire_overdue_subscriptions: admin only';
  end if;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where status = 'active'
     and ends_at is not null
     and coalesce(grace_ends_at, ends_at) < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.admin_assign_batch(p_user_ids uuid[], p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid;
  v_sub       public.subscriptions%rowtype;
  v_segment   text;
  v_count     int;
  v_assigned  int := 0;
  v_skipped   jsonb := '[]'::jsonb;
  v_batch     public.batches%rowtype;
  v_held      boolean;
  v_hint      text;
begin
  if not public.has_staff_permission('batches.manage') then
    perform public.app_error('FORBIDDEN', 'admin_assign_batch: admin only', 403, null);
  end if;

  select * into v_batch from public.batches where id = p_batch_id;
  if v_batch.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'admin_assign_batch: batch not found', 404,
      jsonb_build_object('batch_id', p_batch_id));
  end if;
  if v_batch.status <> 'open' then
    perform public.app_error('BATCH_CLOSED',
      format('admin_assign_batch: batch %s is %s', v_batch.code, v_batch.status), 409,
      jsonb_build_object('batch_code', v_batch.code, 'status', v_batch.status));
  end if;

  foreach v_uid in array coalesce(p_user_ids, array[]::uuid[]) loop
    begin
      select * into v_sub from public.subscriptions s
       where s.user_id = v_uid and s.status = 'active'
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       order by s.created_at desc limit 1;

      if v_sub.id is null then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_active_subscription');
        continue;
      end if;

      select coalesce(ep.community_segment, 'general') into v_segment
        from public.enrollment_plans ep where ep.key = v_sub.plan_key;
      if v_segment is distinct from 'vip' then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'not_a_premium_plan');
        continue;
      end if;

      select exists (select 1 from public.batch_entitlements e
                      where e.user_id = v_uid and e.batch_id = p_batch_id
                        and e.status in ('queued', 'active')) into v_held;
      if v_held then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'already_assigned');
        continue;
      end if;

      if not exists (select 1 from public.community_spaces sp
                      where sp.batch_id = p_batch_id and sp.kind = v_segment and sp.active) then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_space_for_segment');
        continue;
      end if;

      v_count := public.plan_eligible_batch_count(v_sub.plan_key);
      if v_count is null then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_run_length');
        continue;
      end if;

      -- Move, do not destroy: supersede the outstanding run, then grant a new
      -- one from the chosen cohort. Both remain in the ledger.
      perform public.revoke_batch_run(v_uid, null,
        format('reassigned to %s', v_batch.code), auth.uid(), 'superseded');

      perform public.grant_batch_run(
        v_uid, v_segment, p_batch_id, v_count, 'admin_manual',
        v_sub.id, v_sub.plan_key, null, null,
        coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), true);

      update public.subscriptions set batch_id = p_batch_id, updated_at = now() where id = v_sub.id;

      insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
      values (p_batch_id, v_uid, auth.uid(),
              case when v_sub.batch_id is null then 'assign' else 'reassign' end,
              jsonb_build_object('subscription_id', v_sub.id, 'segment', v_segment,
                                 'from_batch_id', v_sub.batch_id, 'to_batch_id', p_batch_id));
      v_assigned := v_assigned + 1;

    exception
      -- Only OUR refusals become a per-user skip. A deadlock or serialization
      -- failure must surface, not masquerade as "this member was skipped" —
      -- that would silently under-assign a bulk operation.
      when sqlstate 'PT409' or sqlstate 'PT422' or sqlstate 'PT403' or sqlstate 'PT404' then
        get stacked diagnostics v_hint = pg_exception_hint;
        v_skipped := v_skipped || jsonb_build_object(
          'user_id', v_uid,
          'reason', lower(coalesce(nullif(v_hint, ''), 'run_conflict')));
    end;
  end loop;

  return jsonb_build_object('ok', true, 'assigned', v_assigned,
                            'skipped', v_skipped, 'batch_code', v_batch.code);
end;
$$;

create or replace function public.admin_update_batch(
  p_batch_id uuid, p_code text, p_name text,
  p_starts_on date, p_ends_on date, p_timezone text,
  p_vip_capacity int, p_total_capacity int)          -- ★ still NO DEFAULTS (#38's reasoning)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old      public.batches%rowtype;
  v_code     text;
  v_name     text;
  v_tz       text;
  v_clash    text;
  v_old_act  timestamptz;
  v_new_act  timestamptz;
  v_spaces   int := 0;
  v_shifted  int := 0;
  v_used     int;
begin
  if not public.has_staff_permission('batches.manage') then
    perform public.app_error('FORBIDDEN', 'admin_update_batch: admin only', 403, null);
  end if;

  select * into v_old from public.batches where id = p_batch_id for update;
  if v_old.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'admin_update_batch: batch not found', 404,
      jsonb_build_object('batch_id', p_batch_id));
  end if;

  if public.batch_is_past(v_old.ends_on, v_old.timezone) then
    perform public.app_error('BATCH_PAST',
      format('batch %s ended on %s (%s) and is read-only',
             v_old.code, v_old.ends_on, v_old.timezone), 409,
      jsonb_build_object('batch_code', v_old.code, 'ends_on', v_old.ends_on,
                         'timezone', v_old.timezone));
  end if;

  -- ── Name ──
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    perform public.app_error('BATCH_PERIOD_INVALID', 'a batch needs a display name', 422, null);
  end if;

  -- ── Code: shape, uniqueness, and RANK ──
  v_code := lower(btrim(coalesce(p_code, '')));
  if v_code !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    perform public.app_error('INVALID_BATCH_CODE',
      format('%s is not a real YYYY-MM month', coalesce(p_code, 'null')), 422,
      jsonb_build_object('code', p_code));
  end if;

  if v_code <> v_old.code then
    if exists (select 1 from public.batches b where b.code = v_code and b.id <> p_batch_id) then
      perform public.app_error('BATCH_CODE_TAKEN',
        format('another batch already uses %s', v_code), 409,
        jsonb_build_object('code', v_code));
    end if;

    -- ★ RANK PRESERVATION. grant_batch_run() allocates `order by b.code` from a
    -- start batch, and allocate_queued_entitlements() refuses any cohort not
    -- strictly above the highest code a run already holds. A code that crosses a
    -- sibling therefore reorders somebody's paid run — silently, and only
    -- visibly months later. Refuse it; a same-position correction is allowed.
    select b.code into v_clash
      from public.batches b
     where b.id <> p_batch_id
       and ((b.code < v_old.code) is distinct from (b.code < v_code))
     order by b.code
     limit 1;
    if v_clash is not null then
      perform public.app_error('BATCH_CODE_REORDER',
        format('%s would move this batch past %s and reorder members'' cohort runs',
               v_code, v_clash), 409,
        jsonb_build_object('code', v_code, 'from_code', v_old.code, 'crosses', v_clash));
    end if;
  end if;

  -- ── Timezone + period ──
  v_tz := coalesce(nullif(btrim(coalesce(p_timezone, '')), ''), 'Asia/Manila');
  if not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    perform public.app_error('BATCH_TIMEZONE_INVALID',
      format('%s is not a timezone Postgres recognises', v_tz), 422,
      jsonb_build_object('timezone', v_tz));
  end if;

  if p_starts_on is null or p_ends_on is null then
    perform public.app_error('BATCH_PERIOD_INVALID',
      'a batch needs both a start and an end date', 422, null);
  end if;
  if p_starts_on > p_ends_on then
    perform public.app_error('BATCH_PERIOD_INVALID',
      'the end date falls before the start date', 422,
      jsonb_build_object('starts_on', p_starts_on, 'ends_on', p_ends_on));
  end if;
  if public.batch_is_past(p_ends_on, v_tz) then
    perform public.app_error('BATCH_PERIOD_PAST',
      format('that period has already ended in %s', v_tz), 422,
      jsonb_build_object('ends_on', p_ends_on, 'timezone', v_tz));
  end if;

  -- ── Capacity may not fall below seats already sold ──
  -- batch_seat_holders() is the OCCUPANCY predicate (it ignores activates_at, so
  -- a seat in a future cohort still counts — it was paid for).
  select count(*) into v_used from public.batch_seat_holders(p_batch_id, 'vip');
  if p_vip_capacity is not null and p_vip_capacity < v_used then
    perform public.app_error('BATCH_CAPACITY_BELOW_OCCUPANCY',
      format('%s VIP seat(s) are already sold in %s', v_used, v_old.code), 409,
      jsonb_build_object('segment', 'vip', 'used', v_used, 'requested', p_vip_capacity));
  end if;

  if p_total_capacity is not null and p_total_capacity < v_used then
    perform public.app_error('BATCH_CAPACITY_BELOW_OCCUPANCY',
      format('%s seat(s) are already sold in %s', v_used, v_old.code), 409,
      jsonb_build_object('segment', 'total', 'used', v_used, 'requested', p_total_capacity));
  end if;

  -- ── Write ──
  update public.batches
     set code           = v_code,
         name           = v_name,
         starts_on      = p_starts_on,
         ends_on        = p_ends_on,
         timezone       = v_tz,
         vip_capacity   = p_vip_capacity,
         total_capacity = p_total_capacity,
         updated_at     = now()
   where id = p_batch_id;

  -- Dependent DISPLAY data, same transaction. The slug is NOT touched: it is a
  -- permalink (see its column comment). Only what a member reads follows.
  if v_name <> v_old.name then
    update public.community_spaces sp
       set name = 'VIP - ' || v_name,
           updated_at = now()
     where sp.batch_id = p_batch_id
       and sp.kind = 'vip';
    get diagnostics v_spaces = row_count;
  end if;

  -- A corrected start date moves seats that have NOT started yet. Already-active
  -- seats and revoked/superseded history are never rewritten — this can delay or
  -- advance a future cohort, never retract access somebody already has.
  v_old_act := coalesce(v_old.starts_on::timestamptz,
                        to_date(v_old.code || '-01', 'YYYY-MM-DD')::timestamptz);
  v_new_act := coalesce(p_starts_on::timestamptz,
                        to_date(v_code || '-01', 'YYYY-MM-DD')::timestamptz);
  if v_new_act is distinct from v_old_act then
    update public.batch_entitlements e
       set activates_at = v_new_act, updated_at = now()
     where e.batch_id = p_batch_id
       and e.status in ('queued', 'active')
       and e.activates_at is not null
       and e.activates_at > now();
    get diagnostics v_shifted = row_count;
  end if;

  insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
  values (p_batch_id, null, auth.uid(), 'edit',
          jsonb_build_object(
            'before', jsonb_build_object(
              'code', v_old.code, 'name', v_old.name,
              'starts_on', v_old.starts_on, 'ends_on', v_old.ends_on,
              'timezone', v_old.timezone,
              'vip_capacity', v_old.vip_capacity, 'total_capacity', v_old.total_capacity),
            'after', jsonb_build_object(
              'code', v_code, 'name', v_name,
              'starts_on', p_starts_on, 'ends_on', p_ends_on,
              'timezone', v_tz,
              'vip_capacity', p_vip_capacity, 'total_capacity', p_total_capacity),
            'spaces_renamed', v_spaces,
            'activations_shifted', v_shifted));

  return jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'code', v_code,
    'code_changed', v_code <> v_old.code,
    'name', v_name,
    'spaces_renamed', v_spaces,
    'activations_shifted', v_shifted);
end;
$$;

-- ★ THIS ONE IS THE #39 BODY, NOT A PRE-#39 ONE, AND THE DIFFERENCE ABORTS THE
--   WHOLE MIGRATION. An earlier draft of this section restated a version that
--   still returned gold_active / gold_capacity and grouped on
--   ep.community_segment = 'gold'. #39 deleted the gold segment AND dropped
--   batches.gold_capacity, so that body would have failed twice over — first with
--   42P13 "cannot change return type of existing function" (10 OUT columns where
--   the live one has 15), and then, if forced past that, on a column that no
--   longer exists. It is exactly the failure this section's own header warns
--   about: rebuild from the live definition, never restate from memory.
--   The ONLY change from the live body is the guard in the WHERE clause.
create or replace function public.admin_batch_overview()
returns table (
  batch_id uuid, code text, name text, status text,
  starts_on date, ends_on date, timezone text,
  closed_at timestamptz, close_reason text, is_past boolean,
  vip_capacity integer, total_capacity integer,
  vip_active bigint, total_active bigint, vip_queued bigint
)
language sql stable security definer set search_path = public
as $$
  select b.id, b.code, b.name, b.status,
         b.starts_on, b.ends_on, b.timezone,
         b.closed_at, b.close_reason,
         public.batch_is_past(b.ends_on, b.timezone) as is_past,
         b.vip_capacity, b.total_capacity,
         (select count(*) from public.batch_seat_holders(b.id, 'vip')) as vip_active,
         -- total_active is retained (equal to vip_active while VIP is the only
         -- cohort segment) so the Batches screen keeps one row shape whether or
         -- not another segment is ever added.
         (select count(*) from public.batch_seat_holders(b.id, 'vip')) as total_active,
         -- Committed demand: seats already sold that no cohort has absorbed yet.
         -- Alex needs this BEFORE setting a capacity, because queued seats are
         -- never retro-refused (they were paid for). Deliberately NOT correlated
         -- to b.id — a queued row has no batch_id, so this is a registry-wide
         -- total repeated on every row.
         (select count(*) from public.batch_entitlements e
           where e.status = 'queued' and e.segment = 'vip'
             and (e.valid_until is null or e.valid_until > now()))       as vip_queued
    from public.batches b
   where public.has_staff_permission('batches.manage')
   order by b.code desc;
$$;

create or replace function public.admin_grant_batch_run(
  p_user_id uuid, p_batch_id uuid, p_count integer default null, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub         public.subscriptions%rowtype;
  v_segment     text;
  v_count       int;
  v_outstanding int;
begin
  if not public.has_staff_permission('batches.manage') then
    perform public.app_error('FORBIDDEN', 'admin_grant_batch_run: admin only', 403, null);
  end if;

  select * into v_sub from public.subscriptions s
   where s.user_id = p_user_id and s.status = 'active'
     and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
   order by s.created_at desc limit 1;
  if v_sub.id is null then
    perform public.app_error('ENTITLEMENT_EXPIRED',
      'member has no active membership term to attach a cohort seat to', 403,
      jsonb_build_object('user_id', p_user_id));
  end if;

  select coalesce(ep.community_segment, 'general') into v_segment
    from public.enrollment_plans ep where ep.key = v_sub.plan_key;
  if v_segment is distinct from 'vip' then
    perform public.app_error('INVALID_PLAN',
      format('plan %s is not a cohort plan', v_sub.plan_key), 422,
      jsonb_build_object('plan_key', v_sub.plan_key, 'segment', v_segment));
  end if;

  v_count := coalesce(p_count, public.plan_eligible_batch_count(v_sub.plan_key), 1);

  -- ★ #37: idempotency. The one-seat-per-cohort unique index only protects
  -- BOUND seats, so a repeat call on a member who already holds every open
  -- cohort fell through to the shortfall path and minted a second full run of
  -- queued seats — sold, capacity-exempt, and auto-bound later by the binder.
  if not p_force then
    select count(*) into v_outstanding
      from public.batch_entitlements e
     where e.user_id = p_user_id and e.status in ('queued', 'active');
    if v_outstanding >= v_count then
      perform public.app_error('ALREADY_ENTITLED',
        format('member already holds %s outstanding cohort seat(s); pass p_force to stack another run',
               v_outstanding), 409,
        jsonb_build_object('outstanding', v_outstanding, 'requested', v_count));
    end if;
  end if;

  return public.grant_batch_run(
    p_user_id, v_segment, p_batch_id, v_count, 'admin_manual',
    v_sub.id, v_sub.plan_key, null, null,
    coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), not p_force);
end;
$$;

create or replace function public.admin_revoke_batch_run(
  p_user_id uuid,
  p_run_id  uuid default null,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if not public.has_staff_permission('batches.manage') then
    perform public.app_error('FORBIDDEN', 'admin_revoke_batch_run: admin only', 403, null);
  end if;
  v_n := public.revoke_batch_run(p_user_id, p_run_id, p_reason, auth.uid(), 'revoked');
  return jsonb_build_object('ok', true, 'revoked', v_n);
end;
$fn$;

create or replace function public.admin_reconcile_queued_entitlements(p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if not public.has_staff_permission('batches.manage') then
    perform public.app_error('FORBIDDEN', 'admin_reconcile_queued_entitlements: admin only', 403, null);
  end if;
  v_n := public.allocate_queued_entitlements(p_batch_id);
  return jsonb_build_object('ok', true, 'allocated', v_n);
end;
$fn$;

create or replace function public.admin_close_due_batches()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.has_staff_permission('batches.manage') then
    perform public.app_error('FORBIDDEN', 'admin_close_due_batches: admin only', 403, null);
  end if;
  return public.close_due_batches();
end;
$fn$;


-- ── 15c) The RLS policies those screens read ────────────────────────────────
-- ALTER, not DROP+CREATE, for #39's reason: scripts/apply-db-files.mjs sends one
-- statement per HTTP round trip, so a DROP+CREATE is a real window during which
-- the table has NO policy for that command.
--
-- ★ profiles_admin_select is the one that makes `access_requests.review` mean
--   anything. Before this, an Operations Admin could call
--   admin_review_access_request() on a p_user_id they had no way to DISCOVER:
--   the pending-signup query returns zero rows because that policy still says
--   is_admin(). A permission to decide, over a queue you cannot read, is not a
--   permission.
alter policy profiles_admin_select on public.profiles
  using ((select public.is_admin())
         or (select public.has_staff_permission('access_requests.review'))
         or (select public.has_staff_permission('enrollments.review')));

alter policy enroll_req_admin_all on public.enrollment_requests
  using ((select public.has_staff_permission('enrollments.review')))
  with check ((select public.has_staff_permission('enrollments.review')));

alter policy subscriptions_admin_all on public.subscriptions
  using ((select public.has_staff_permission('enrollments.review')))
  with check ((select public.has_staff_permission('enrollments.review')));

alter policy batches_admin_all on public.batches
  using ((select public.has_staff_permission('batches.manage')))
  with check ((select public.has_staff_permission('batches.manage')));

alter policy batch_events_admin_select on public.batch_events
  using ((select public.has_staff_permission('batches.manage')));

alter policy batch_events_admin_insert on public.batch_events
  with check ((select public.has_staff_permission('batches.manage')));

alter policy community_spaces_admin_all on public.community_spaces
  using ((select public.has_staff_permission('batches.manage')))
  with check ((select public.has_staff_permission('batches.manage')));

-- The Enrollments membership strip reads the cohort ledger.
alter policy batch_entitlements_read on public.batch_entitlements
  using (user_id = (select auth.uid())
         or (select public.has_staff_permission('enrollments.review')));

-- Student imports: the wizard reads these tables from the BROWSER (the service
-- role is only used by api/admin/student-imports.js for the writes), so an
-- Operations Admin needs read/write here or the screen is empty.
alter policy student_import_jobs_admin_all on public.student_import_jobs
  using ((select public.has_staff_permission('students.import')))
  with check ((select public.has_staff_permission('students.import')));

alter policy student_import_rows_admin_all on public.student_import_rows
  using ((select public.has_staff_permission('students.import')))
  with check ((select public.has_staff_permission('students.import')));

alter policy student_import_events_admin_select on public.student_import_events
  using ((select public.has_staff_permission('students.import')));

alter policy student_import_events_admin_insert on public.student_import_events
  with check ((select public.has_staff_permission('students.import')));

alter policy student_external_accounts_admin_all on public.student_external_accounts
  using ((select public.has_staff_permission('students.import')))
  with check ((select public.has_staff_permission('students.import')));

-- Receipt preview. An Ops Admin who may approve a payment must be able to LOOK
-- at the payment. Storage policies are invisible to db:shadow:verify, so this one
-- is pinned by an OBJECT_CHECKS entry in scripts/audit-db.mjs instead.
alter policy enrollment_receipts_select on storage.objects
  using (bucket_id = 'enrollment-receipts'
         and ((storage.foldername(name))[1] = (select auth.uid())::text
              or (select public.has_staff_permission('enrollments.review'))));


-- ── 15d) The access-request queue an Ops Admin can actually read ────────────
-- profiles_admin_select above widens the row filter, but the client's pending
-- query also selects columns and orders them; giving the screen a purpose-built
-- SECDEF reader keeps the permission check in ONE place and mirrors
-- admin_staff_directory(), which exists for exactly the same reason.
--
-- The permission test is in the WHERE clause, so a caller without it gets zero
-- rows rather than an error — the same shape as course_publish_blockers().
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
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 500), 1000))
$fn$;

comment on function public.admin_access_request_queue(text, integer) is
  '#45: the Access Requests queue, gated on access_requests.review. Exists because '
  'profiles_admin_select alone left an Operations Admin able to DECIDE on a signup '
  'they could not DISCOVER. Mirrors admin_staff_directory(): SECURITY DEFINER so it '
  'can read other people''s profiles, permission test in the WHERE clause so a '
  'caller without it gets zero rows rather than an error.';

revoke all on function public.admin_access_request_queue(text, integer) from public, anon;
grant execute on function public.admin_access_request_queue(text, integer) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-25-staff-authorization.sql', null,
  'staff authorization (#45): staff_roles / staff_permissions / staff_role_permissions / '
  'staff_memberships / staff_role_events, seeded with the 18-permission x 3-role matrix; '
  'backfills every profiles.is_admin account to an active super_admin membership and refuses '
  'to complete with none; turns profiles.is_admin into a trigger-maintained cache of "active '
  'super_admin" so all 295 legacy is_admin() references narrow to Super-Admin-only rather than '
  'breaking; drops profiles_admin_update and revokes UPDATE on profiles from authenticated '
  '(whole-row admin update was a privilege-escalation primitive); adds '
  'admin_review_access_request() to replace the AccessRequests direct UPDATE; adds the '
  'last-Super-Admin guard trigger; teaches batch_entitlements_guard() to accept an Operations '
  'Admin as granted_by (it read profiles.is_admin, which would have refused every VIP approval '
  'they made); revokes anon EXECUTE on is_admin/is_approved/is_enrolled and pins four '
  'no-TO-clause policies to authenticated. Section 15 then RE-GATES THE OPERATIONS SURFACE, '
  'without which the Operations Admin role is decorative: admin_finalize_enrollment, '
  'approve_subscription, approve_extension, expire_overdue_subscriptions and the eight admin_* '
  'batch RPCs move from is_admin() to has_staff_permission(), as do fourteen RLS policies and '
  'the enrollment_receipts_select storage policy, and admin_access_request_queue() is added so '
  'an Ops Admin can DISCOVER the signups they are allowed to decide on. Section 14 indexes the '
  'membership lookup and the audit ledger. ★ Requires the matching client build: this file '
  'revokes UPDATE on profiles, which a pre-#45 Access Requests screen still relies on.')
on conflict (filename) do nothing;
