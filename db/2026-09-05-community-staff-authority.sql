-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-05-community-staff-authority.sql  (#56)
-- ─────────────────────────────────────────────────────────────────────────────
-- Community configuration and moderation move from "active Super Admin" to the two
-- staff permissions that were always meant to carry them, and moderation stops being
-- a client-chosen column patch.
--
-- ★ WHY THIS FILE EXISTS, AND WHY THE GRANT ALONE WOULD HAVE BEEN A BUG.
--   #45 turned profiles.is_admin into a trigger-maintained CACHE meaning exactly "has
--   an ACTIVE super_admin staff membership", and deliberately left every community RPC
--   and policy on public.is_admin(). It said so, at
--   db/2026-08-25-staff-authorization.sql:1279:
--
--     "Only super_admin holds community.manage, payment_settings.manage and
--      sidebar.customize, so is_admin() and has_staff_permission(...) are equivalent
--      for them today."
--
--   That equivalence is the precondition this file removes. The moment operations_admin
--   and trainer hold community.manage / community.moderate, every is_admin() check in
--   the community surface becomes a refusal of exactly the people who were just granted
--   the capability. Granting the permissions WITHOUT this file would ship two roles that
--   look able in the UI and 403 at the first server call.
--
-- ★ THE SINGLE-PREDICATE RULE, AND THE ONE PLACE THIS FILE BREAKS IT ON PURPOSE.
--   #45 (:1262-1268) mandates has_staff_permission('x') rather than
--   `is_admin() or has_staff_permission('x')`, because super_admin holds every
--   permission and the single form is therefore a strict generalisation. This file
--   follows that everywhere EXCEPT community_posts_guard()'s created_at bypass, which
--   stays SUPER-ADMIN-ONLY via is_super_admin(). Backdating a post is timestamp forgery:
--   created_at feeds last_activity_at, which orders the feed. Widening moderation must
--   not widen forgery, so there the two predicates are NOT equivalent and the difference
--   is the whole point. See section 4.
--
-- ★ HOW THE NINE CONFIG RPCs ARE RE-GATED, AND WHY NOT BY RETYPING THEM.
--   admin_save_community_channel() has NO current body anywhere in this repo: #41 is its
--   last `create or replace`, and #43 then TEXT-PATCHES that body at runtime with a
--   `do $touch$` block (whose own probe string this change corrects in place — it searched
--   for a spelling it never wrote, so #43 could not be re-applied). Restating it by hand
--   means hand-applying #43's replace() to ~250
--   lines of SECURITY DEFINER plpgsql — the exact failure mode that dropped
--   admin_finalize_enrollment's tail in #33 and cost #34 to repair. So section 5 reads
--   each LIVE definition with pg_get_functiondef(), asserts the legacy guard appears
--   EXACTLY ONCE, replaces that one string, and executes the result.
--
--   It is one DO block, i.e. ONE statement. scripts/apply-db-files.mjs sends one
--   statement per HTTP round trip with no transaction, so nine separate CREATEs could
--   fail at the fifth and leave four functions re-gated and five not. A mixed
--   authorization state with no rollback is not an acceptable failure mode here.
--
--   `create or replace` preserves ownership, privileges and COMMENT (the pg_proc OID is
--   unchanged) — only DROP+CREATE loses them, which is why #43 had to re-grant at :339.
--   The grants are re-issued anyway so the file states its own contract.
--
-- ★ MODERATION BECOMES A BOUNDED SERVER ACTION.
--   The client used to PATCH community_posts / community_comments directly; that worked
--   only because community_*_admin_all is a blanket `is_admin()` FOR ALL policy — i.e.
--   the CLIENT chose the columns. community_moderate_post() / _comment() take an id and
--   a strict action enum, so they cannot express author_id, body, title, channel_id,
--   created_at or a counter, and every state change writes one append-only
--   community_moderation_events row.
--
-- ★ THE BLANKET CLIENT WRITE PATH DOES NOT MOVE (section 8a).
--   The five `community_*_admin_all` policies are FOR ALL, and none of these tables carries
--   a table-level DML revoke — so RLS is the only boundary and a FOR ALL policy is a raw
--   PostgREST write path over EVERY row. Re-gating them onto community.moderate beside
--   everything else would have handed two more roles the ability to rewrite another
--   member's body, set author_id, or DELETE a post with no ledger row and no captured
--   storage paths — defeating the entire point of the bounded RPCs. They stay on
--   `is_super_admin()` (the same set `is_admin()` already meant). Section 8d then gives the
--   new roles their OWN-row writes, which is all they were missing.
--
-- ★ WHAT THIS FILE DOES NOT WIDEN.
--   community_spaces_admin_all stays on batches.manage (#45): a space is created and
--   destroyed by the BATCH lifecycle, and admin_finalize_enrollment refuses with
--   NO_SPACE_FOR_SEGMENT when a batch has none — so a community configurator with write
--   access there could break enrolment approval for a whole cohort two screens away.
--   is_enrolled() and is_approved() are untouched. community_stamp_author() is untouched
--   (its lone is_admin() guards the same created_at bypass, so it already satisfies the
--   forgery rule with a zero-line diff). The eligibility reads in
--   search_community_members() and the two notify triggers are untouched: they ask "is
--   this candidate's account in good standing", not "does it have authority", and #50
--   already flips an active staff profile to 'approved'.
--
-- ★ ONE CONSEQUENCE WORTH NAMING. search_community_members() is untouched, but its candidate
--   filter tests my_community_channel_capabilities(), which section 3 makes true in every
--   channel for Community staff. The mention directory therefore reaches every cohort for
--   them. That is inherent in "moderate the private rooms", and it returns names and avatars
--   only — never email — but it IS a widening, and it should read as deliberate rather than
--   be found later.
--
-- Depends on: #45 (has_staff_permission / user_has_staff_permission / is_super_admin),
--             #52 (the current 19-permission seed), #35, #36, #40, #41, #43, #31.
-- ─────────────────────────────────────────────────────────────────────────────

do $pre$
declare v_sig text; v_pol text;
begin
  -- #45: the whole permission model.
  if to_regprocedure('public.has_staff_permission(text)') is null
     or to_regprocedure('public.user_has_staff_permission(uuid,text)') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regclass('public.staff_role_permissions') is null then
    raise exception '#56 requires #45 - run db/2026-08-25-staff-authorization.sql first.';
  end if;

  -- The two permission rows every new guard resolves at call time.
  if (select count(*) from public.staff_permissions
       where key in ('community.manage','community.moderate')) <> 2 then
    raise exception '#56 requires the community.manage / community.moderate permission rows (#45/#52).';
  end if;

  -- #36/#40/#41/#43: the nine re-gate targets, by exact signature.
  foreach v_sig in array array[
    'public.admin_community_config()',
    'public.admin_save_community_settings(text,text,text,uuid)',
    'public.admin_save_channel_category(uuid,uuid,text,text)',
    'public.admin_move_channel_category(uuid,integer)',
    'public.admin_save_community_channel(uuid,uuid,uuid,text,text,text,text,text,text[],uuid[],boolean,boolean,boolean,boolean)',
    'public.admin_move_community_channel(uuid,integer)',
    'public.admin_set_community_channel_status(uuid,text)',
    'public.admin_channel_privacy_preview(uuid,text,text[],uuid[])',
    'public.admin_community_media_orphans(integer)'
  ] loop
    if to_regprocedure(v_sig) is null then
      raise exception '#56 requires % - run #36, #40, #41 and #43 first.', v_sig;
    end if;
  end loop;

  -- #41 AND #43 must both have landed on the channel writer, or section 5 would re-gate
  -- a body still missing #43's p_kind conjunct and freeze that fix out of the schema.
  if not exists (select 1 from pg_proc where proname = 'admin_save_community_channel'
                   and prosrc like '%v_touched := p_id is null%'
                   and prosrc like '%p_kind           is not null%') then
    raise exception '#56 requires #41 AND #43 applied to admin_save_community_channel().';
  end if;

  -- An overload would make section 5's self-verify count lie.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_save_channel_category') <> 1 then
    raise exception '#56: admin_save_channel_category is overloaded; resolve it first.';
  end if;

  -- #35/#36/#40: the visibility chain and the post guard.
  if to_regprocedure('public.user_community_space_ids(uuid)') is null
     or to_regprocedure('public.user_community_capabilities(uuid)') is null
     or to_regprocedure('public.user_community_channel_ids(uuid)') is null
     or to_regprocedure('public.user_community_channel_capabilities(uuid)') is null
     or to_regprocedure('public.community_posts_guard()') is null then
    raise exception '#56 requires #35, #36 and #40.';
  end if;

  -- `alter policy` has no IF EXISTS: a missing policy aborts mid-file, and there is no
  -- transaction to roll back the sections already applied.
  foreach v_pol in array array[
    'community_posts_read','community_posts_admin_all',
    'community_comments_read','community_comments_admin_all',
    'community_reactions_read','community_reactions_own_delete','community_reactions_admin_all',
    'community_attachments_read','community_attachments_own_delete','community_attachments_admin_all',
    'community_tags_read','community_tags_admin_all',
    'community_post_tags_read','community_post_tags_own_delete','community_post_tags_admin_all',
    'community_notifications_own_select','community_notifications_own_update',
    'community_announcement_reads_own_select','community_announcement_reads_own_insert',
    'community_spaces_read','community_channels_read','community_channel_categories_read',
    'community_settings_read','community_channel_plans_admin_select',
    'community_channel_batches_admin_select','community_channel_events_admin_select',
    -- section 8d
    'community_posts_own_insert','community_posts_own_update',
    'community_comments_own_insert','community_comments_own_update',
    'community_reactions_own_insert','community_attachments_own_insert',
    'community_post_tags_own_insert'
  ] loop
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and policyname = v_pol) then
      raise exception '#56 requires the policy %; run #23, #24, #32, #40 and #43 first.', v_pol;
    end if;
  end loop;
  foreach v_pol in array array['community_media_read','community_media_delete',
                               'community_media_own_insert'] loop
    if not exists (select 1 from pg_policies
                    where schemaname = 'storage' and policyname = v_pol) then
      raise exception '#56 requires the storage policy %; run #40 and #43 first.', v_pol;
    end if;
  end loop;

  -- Both tail statements must be reachable. sidebar_settings is checked here rather than
  -- discovered at the very end: a failure there would leave the migration FULLY APPLIED but
  -- UNLOGGED, which is exactly the state #31 exists to prevent.
  if to_regclass('public.sidebar_settings') is null then
    raise exception '#56 requires #6 - run db/2026-06-18-sidebar-settings.sql first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#56 requires #31 - run db/2026-07-26-schema-migrations-log.sql first.';
  end if;
end
$pre$;

-- == 1) The role matrix: 28 grants -> 32 ======================================
-- All three blocks are RESTATED IN FULL, not delta'd. test/staffRolesSql.test.mjs's
-- lastValuesBlock() takes the LAST `insert into public.<table> (...) values ... on
-- conflict` block in the current seed migration and compares it against the whole JS
-- matrix, so a four-row insert would report 28 missing pairs. #52 restates for the
-- same reason.
--
-- ★ Community authority carries nothing else with it. A Trainer who moderates the forum
--   still cannot review payments, run batches, read progress reports, publish or delete
--   a course, manage staff, or rename the sidebar. The two role DESCRIPTIONS change
--   because they are shown in Team & Roles and in the invitation email, and a Trainer
--   invited today is being told what the role actually does.
-- ★ The seeds run FIRST on purpose. There is no transaction, so a mid-file abort has to fail
--   in a safe direction: with the grants in place but the RPCs not yet re-gated, the new
--   roles are simply REFUSED — under-granted, loudly, exactly as they are today. That is the
--   same direction #45's whole design argument runs in.

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
  ('operations_admin', 'community.manage'),
  ('operations_admin', 'community.moderate'),
  ('trainer', 'courses.create'),
  ('trainer', 'courses.manage_assigned'),
  ('trainer', 'course_trainer.manage'),
  ('trainer', 'community.manage'),
  ('trainer', 'community.moderate')
on conflict do nothing;

-- == 2) is_community_staff() — one concept, one definition ====================
-- The #45 two-form split, and it is load-bearing:
--
--   user_is_community_staff(uuid) answers about ANY user, so it is REVOKED from every
--   client role. It is the form the user_community_*(p_user) functions must call.
--   ★ Calling the caller-pinned is_community_staff() inside one of those would answer
--     about the CALLER instead of the subject — a moderator would hand themselves
--     everyone's rooms while a student's channel set was computed from the moderator's
--     authority. It fails OPEN. That is the single most dangerous mistake available in
--     this file, and test/communityStaffSql.test.mjs pins against it.
--
--   is_community_staff() is pinned to auth.uid() and GRANTED to authenticated. The grant
--   is not optional: an RLS qual is evaluated AS THE QUERYING ROLE, so without it every
--   gated read fails with "permission denied for function" instead of denying cleanly.
--
-- One function rather than two has_staff_permission() calls, for three reasons: a policy
-- builds one InitPlan per distinct SubLink and will not dedupe two different arguments;
-- the per-user form is called PER ROW on three paths (search_community_members, both
-- notify triggers, admin_channel_privacy_preview), where one `permission_key in (...)`
-- probe on the composite key is a single index range instead of two; and "Community
-- staff" is one concept, so a third community.* permission later changes one function
-- instead of every `or` in every policy.

create or replace function public.user_is_community_staff(p_user uuid)
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
       and rp.permission_key in ('community.manage', 'community.moderate')
  )
$fn$;

comment on function public.user_is_community_staff(uuid) is
  '#56: holds community.manage OR community.moderate on an ACTIVE membership. Internal '
  'only - revoked from every client role, because it answers about an arbitrary user.';

revoke all on function public.user_is_community_staff(uuid) from public, anon, authenticated;

create or replace function public.is_community_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.user_is_community_staff((select auth.uid()))
$fn$;

comment on function public.is_community_staff() is
  '#56: the caller-pinned form. Wrap it as (select public.is_community_staff()) in a '
  'policy so Postgres evaluates it once per statement as an InitPlan, not once per row.';

revoke all on function public.is_community_staff() from public, anon;
grant execute on function public.is_community_staff() to authenticated;

-- == 3) The visibility chain: four functions, one line each =================
-- Each body is the LIVE text, copied from the migration that last defined it, with a
-- single CTE column widened. The chain is replaced in dependency order (L1 -> L2 ->
-- L1.5 -> L2-per-channel) so no intermediate state is wider than the final one.
--
-- ★ These take an ARBITRARY uuid, so they call user_is_community_staff(p_user) - the
--   internal per-user form. See section 2 for why the caller-pinned form here would
--   fail open.
create or replace function public.user_community_space_ids(p_user uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.is_admin,
           (p.approval_status = 'approved' or p.is_admin) as approved,
           p.is_paid
      from public.profiles p
     where p.id = p_user
  ),
  cur as (
    select s.plan_key, s.batch_id
      from public.subscriptions s
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  gate as (
    -- #56: AUTHORITY. Community staff reach every space, exactly as an active Super
    --      Admin always has. `approved` below is deliberately NOT touched - it asks
    --      whether the account is in good standing, not whether it has authority,
    --      and #50 already flips an active staff profile to 'approved'.
    select (coalesce((select is_admin from me), false)
            or public.user_is_community_staff(p_user)) as is_admin,
           (coalesce((select approved from me), false)
            and (exists (select 1 from cur)
                 or (coalesce((select is_paid from me), false)
                     and not exists (select 1 from public.subscriptions s2
                                      where s2.user_id = p_user)))) as is_member
  ),
  scope as (select batch_id, segment from public.user_entitled_batches(p_user))
  select sp.id
    from public.community_spaces sp, gate g
   where g.is_admin
      or (g.is_member and sp.active
          and (sp.kind = 'general'
               or exists (select 1 from scope s
                           where s.segment = sp.kind and s.batch_id = sp.batch_id)));
$$;

revoke all on function public.user_community_space_ids(uuid) from public, anon, authenticated;

create or replace function public.user_community_capabilities(p_user uuid)
returns table (
  space_id uuid, kind text,
  can_post boolean, can_comment boolean, can_react boolean, can_attach boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  with me as (
    select coalesce(p.is_admin, false) as is_admin,
           (p.approval_status = 'approved' or p.is_admin) as approved
      from public.profiles p where p.id = p_user
  ),
  caps as (
    select bool_or(coalesce(ep.can_post_in_general, false))    as post_general,
           bool_or(coalesce(ep.can_comment_in_general, false)) as comment_general,
           bool_or(coalesce(ep.can_react_in_general, true))    as react_general,
           bool_or(coalesce(ep.can_post_in_private, false))    as post_private,
           bool_or(coalesce(ep.can_comment_in_private, false)) as comment_private,
           bool_or(coalesce(ep.can_react_in_private, true))    as react_private,
           bool_or(coalesce(ep.can_upload_attachments, false)) as attach
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
  ),
  eff as (
    -- #56: AUTHORITY. Confirmed product decision - Community staff inherit the full
    --      write bypass a Super Admin has always had, so they can post in
    --      #announcements and answer in a locked room. `approved` is untouched.
    select (coalesce((select is_admin from me), false)
            or public.user_is_community_staff(p_user))  as is_admin,
           -- A member with no resolvable plan row (legacy grandfather, unknown
           -- key) gets the fail-closed defaults: read and react, write nothing.
           coalesce((select post_general    from caps), false) as post_general,
           coalesce((select comment_general from caps), false) as comment_general,
           coalesce((select react_general   from caps), true)  as react_general,
           coalesce((select post_private    from caps), false) as post_private,
           coalesce((select comment_private from caps), false) as comment_private,
           coalesce((select react_private   from caps), true)  as react_private,
           coalesce((select attach          from caps), false) as attach,
           coalesce((select approved from me), false) as approved
  )
  select sp.id,
         sp.kind,
         e.is_admin or (e.approved and sp.member_posting
                        and case when sp.kind = 'general' then e.post_general else e.post_private end),
         e.is_admin or (e.approved and sp.member_comments
                        and case when sp.kind = 'general' then e.comment_general else e.comment_private end),
         e.is_admin or (e.approved and sp.member_reactions
                        and case when sp.kind = 'general' then e.react_general else e.react_private end),
         -- Attaching requires BOTH the attachment right and the right to create
         -- the thing the attachment hangs off — otherwise a plan that cannot
         -- post could still fill the private bucket.
         e.is_admin or (e.approved and e.attach and sp.member_posting
                        and case when sp.kind = 'general' then e.post_general else e.post_private end)
    from public.community_spaces sp, eff e
   -- L1 is the single membership seam. Never re-derive it here.
   where sp.id in (select public.user_community_space_ids(p_user));
$fn$;

revoke all on function public.user_community_capabilities(uuid) from public, anon, authenticated;

create or replace function public.user_community_channel_ids(p_user uuid)
returns setof uuid
language sql stable security definer set search_path = public
as $chids$
  -- #56: AUTHORITY, and the ONLY path to an audience_mode='admins_only' room (whose
  --      CASE arm below is literally `then false`) or an archived channel.
  -- ★ KEEP THE `from public.profiles` CLAUSE. `me` returns ZERO rows for a profile
  --   that does not exist, and the cross join below then yields no channels. Rewriting
  --   this as a bare scalar select would make `me` always return one row and turn a
  --   fail-CLOSED join into a fail-OPEN one for an orphaned auth user.
  with me as (
    select (coalesce(p.is_admin, false)
            or public.user_is_community_staff(p_user)) as is_admin
      from public.profiles p where p.id = p_user
  ),
  spaces as (
    -- L1 is the single membership seam. Never re-derive it here.
    select public.user_community_space_ids(p_user) as space_id
  ),
  live as (
    select s.plan_key
      from public.subscriptions s
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  seats as (
    -- The authoritative ledger. Batch STATUS is deliberately not consulted:
    -- closing or archiving a cohort must not revoke a seat already paid for.
    select batch_id from public.user_entitled_batches(p_user)
  )
  select ch.id
    from public.community_channels ch, me m
   where m.is_admin
      or (ch.status = 'active'
          and ch.space_id in (select space_id from spaces)
          and case ch.audience_mode
                when 'space'       then true
                when 'admins_only' then false
                when 'plans' then exists (
                  select 1 from public.community_channel_plans cp
                   where cp.channel_id = ch.id
                     and cp.plan_key = (select plan_key from live))
                when 'batches' then exists (
                  select 1 from public.community_channel_batches cb
                   where cb.channel_id = ch.id
                     and cb.batch_id in (select batch_id from seats))
                when 'plans_and_batches' then
                  exists (select 1 from public.community_channel_plans cp
                           where cp.channel_id = ch.id
                             and cp.plan_key = (select plan_key from live))
                  and exists (select 1 from public.community_channel_batches cb
                               where cb.channel_id = ch.id
                                 and cb.batch_id in (select batch_id from seats))
                else false
              end);
$chids$;

comment on function public.user_community_channel_ids(uuid) is
  'L1.5. Channels NARROW the space set - the space_id test is a conjunct, so this '
  'can never return a channel in a space the member cannot reach. An audience mode '
  'that needs a mapping fails CLOSED on an empty mapping. #56: COMMUNITY STAFF (not '
  'merely Super Admins) see every channel including archived ones, which is what the '
  'editor needs.';

revoke all on function public.user_community_channel_ids(uuid) from public, anon, authenticated;

create or replace function public.user_community_channel_capabilities(p_user uuid)
returns table (
  channel_id uuid,
  space_id   uuid,
  space_kind text,
  can_read    boolean,
  can_post    boolean,
  can_comment boolean,
  can_react   boolean,
  can_attach  boolean
)
language sql stable security definer set search_path = public
as $chcaps$
  -- #56: AUTHORITY. Same widening as L1.5 above; the four write bits follow.
  with me as (
    select (coalesce(p.is_admin, false)
            or public.user_is_community_staff(p_user)) as is_admin
      from public.profiles p where p.id = p_user
  ),
  -- The SPACE ceiling: plan capability x space flag x L1 membership x approved.
  spacecaps as (select * from public.user_community_capabilities(p_user)),
  visible   as (select public.user_community_channel_ids(p_user) as id)
  select ch.id,
         ch.space_id,
         sp.kind,
         true,   -- the row's existence IS can_read
         m.is_admin or (sc.can_post    and ch.member_posting     and ch.status = 'active'),
         m.is_admin or (sc.can_comment and ch.member_comments    and ch.status = 'active'),
         m.is_admin or (sc.can_react   and ch.member_reactions   and ch.status = 'active'),
         -- Attaching still requires the right to create the thing it hangs off,
         -- otherwise a plan that cannot post could fill the private bucket.
         m.is_admin or (sc.can_attach  and ch.member_attachments
                        and ch.member_posting and ch.status = 'active')
    from public.community_channels ch
    join public.community_spaces sp on sp.id = ch.space_id
    join spacecaps sc on sc.space_id = ch.space_id
    cross join me m
   where ch.id in (select id from visible);
$chcaps$;

revoke all on function public.user_community_channel_capabilities(uuid) from public, anon, authenticated;


-- == 4) community_posts_guard(): three moderation gates, one forgery carve-out ==
-- Restated verbatim from db/2026-08-18-community-channels.sql:355 (its last
-- `create or replace`; unlike the channel writer it was never text-patched, so the
-- repo does hold its live body) with exactly four lines changed. This is the trigger
-- that decides whether a write may set pinned / comments_locked at all, so it has to
-- move with the RPCs in section 7 or they would be refused by the schema they run on.
create or replace function public.community_posts_guard()
returns trigger
language plpgsql security definer set search_path = public
as $guard$
declare
  v_space uuid;
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members: a client-forged future date would
    -- launder into last_activity_at below and self-pin the post above the whole
    -- activity-sorted feed.
    -- #56: STILL SUPER-ADMIN-ONLY, and this is the one place this file departs from
    --      #45's single-predicate rule ON PURPOSE. Backdating is forgery, not
    --      moderation: a forged created_at launders into last_activity_at below and
    --      self-pins the post above the whole activity-sorted feed. Community staff
    --      gained pin/lock/hide/delete; they did not gain a time machine.
    --      is_super_admin() rather than is_admin(): the same set by construction, but
    --      read from staff_memberships instead of the profiles cache, and it reads as
    --      the deliberate carve-out it is beside three has_staff_permission() tests.
    if not public.is_super_admin() then
      new.created_at := now();
    end if;

    -- Resolve the channel FIRST. space_id is then DERIVED from it, so a forged
    -- {channel_id: <private>, space_id: <general>} pair cannot mix a cohort room
    -- into General - the row is simply judged by its real channel.
    if new.channel_id is null then
      -- Pre-#40 client: land in the default room of whatever space it named,
      -- falling back to the community-wide default. The seeded default is an
      -- interactive text channel, so these inserts land somewhere writable
      -- rather than bouncing off #announcements.
      select ch.id into new.channel_id
        from public.community_channels ch
       where ch.is_default
         and ch.status = 'active'
         and ch.space_id = coalesce(
               new.space_id,
               (select id from public.community_spaces where kind = 'general'))
       limit 1;
      -- ★ Only cross into the community-wide default when the client named NO
      --   space at all. If it named one and that space has no active default
      --   room (an admin archived it), failing is the ONLY safe answer:
      --   space_id is DERIVED from the channel below, so falling through would
      --   silently re-home a cohort-private post into General and publish it to
      --   every plan - 'channels NARROW, never WIDEN' broken by the guard itself.
      if new.channel_id is null and new.space_id is null then
        select default_channel_id into new.channel_id
          from public.community_settings where id;
      end if;
    end if;

    select ch.space_id into v_space
      from public.community_channels ch where ch.id = new.channel_id;
    if v_space is null then
      -- Deliberately the same code an UNAUTHORIZED channel returns: a distinct
      -- 404 here would confirm which channel ids exist.
      perform public.app_error('COMMUNITY_ACCESS_DENIED',
        'That channel is not available.', 403, null);
    end if;
    new.space_id := v_space;

    new.comment_count    := 0;
    new.last_activity_at := coalesce(new.created_at, now());
    if not public.has_staff_permission('community.moderate') then
      new.pinned := false;
    end if;
    -- Admin-only tags and announcement channels both open locked.
    if exists (select 1 from public.community_tags t
                where t.slug = new.tag_slug and t.admin_only)
       or exists (select 1 from public.community_channels ch
                   where ch.id = new.channel_id and ch.kind = 'announcement') then
      new.comments_locked := true;
    elsif not public.has_staff_permission('community.moderate') then
      new.comments_locked := false;
    end if;
  else
    if pg_trigger_depth() <= 1 and auth.uid() is not null then
      -- #56: without this arm the moderation RPCs would silently do nothing - the
      --      trigger would restore old.pinned / old.comments_locked and the RPC would
      --      still return success. SECURITY DEFINER swaps current_user, NOT the
      --      request GUCs auth.uid() reads, so has_staff_permission() inside this
      --      trigger still resolves to the CALLER when the RPC writes.
      if not public.has_staff_permission('community.moderate') then
        new.pinned          := old.pinned;
        new.comments_locked := old.comments_locked;
      end if;
      new.created_at       := old.created_at;  -- immutable; feeds the unread cutoff
      new.comment_count    := old.comment_count;
      new.last_activity_at := old.last_activity_at;
      new.space_id         := old.space_id;    -- immutable after creation
      new.channel_id       := old.channel_id;  -- immutable after creation
    elsif new.channel_id is distinct from old.channel_id then
      -- No-JWT SQL-editor / service-role move: keep space_id in step with the
      -- new channel so a moved thread cannot stay visible to the old space.
      select ch.space_id into new.space_id
        from public.community_channels ch where ch.id = new.channel_id;
    end if;
  end if;
  return new;
end;
$guard$;


revoke all on function public.community_posts_guard() from public, anon, authenticated;

-- == 5) The nine config RPCs: one idempotent, self-verifying re-gate ==========
-- Every one of the eight `if not public.is_admin() then / perform public.app_error(...)`
-- guards is BYTE-IDENTICAL across #40, #41 and #43 (verified with cat -A), so one literal
-- covers them all. admin_community_media_orphans is `language sql` and carries the guard
-- as an inline WHERE conjunct instead, so it gets a second literal.
--
-- ★ PROBE FOR THE EXACT STRING YOU WRITE. #43's own do $touch$ probes
--   'or p_kind is not null' while writing 'or p_kind           is not null', so its
--   early-return can never fire and a second apply of that file raises. Do not repeat it.
--
-- ★ ANY FUTURE MIGRATION that re-creates one of these nine from the #40/#41/#43 text and
--   is folded AFTER this one silently reverts the guard. scripts/audit-db.mjs's #56 lines
--   are the tripwire.

do $regate$
declare
  v_old constant text :=
    '  if not public.is_admin() then'                                          || chr(10) ||
    '    perform public.app_error(''FORBIDDEN'', ''Admins only.'', 403, null);' || chr(10) ||
    '  end if;';
  v_new constant text :=
    '  if not public.has_staff_permission(''community.manage'') then'          || chr(10) ||
    '    perform public.app_error(''FORBIDDEN'', ''Admins only.'', 403, null);' || chr(10) ||
    '  end if;';
  v_orph_old constant text := 'where public.is_admin()';
  v_orph_new constant text := 'where public.has_staff_permission(''community.manage'')';
  v_sig  text;
  v_oid  regprocedure;
  v_src  text;
  v_hits int;
begin
  foreach v_sig in array array[
    'public.admin_community_config()',
    'public.admin_save_community_settings(text,text,text,uuid)',
    'public.admin_save_channel_category(uuid,uuid,text,text)',
    'public.admin_move_channel_category(uuid,integer)',
    'public.admin_save_community_channel(uuid,uuid,uuid,text,text,text,text,text,text[],uuid[],boolean,boolean,boolean,boolean)',
    'public.admin_move_community_channel(uuid,integer)',
    'public.admin_set_community_channel_status(uuid,text)',
    'public.admin_channel_privacy_preview(uuid,text,text[],uuid[])'
  ] loop
    v_oid := to_regprocedure(v_sig);
    if v_oid is null then
      raise exception '#56: % is missing. Run #40, #41 and #43 first.', v_sig;
    end if;
    v_src  := pg_get_functiondef(v_oid);
    v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);

    if v_hits = 0 then
      if position('has_staff_permission(''community.manage'')' in v_src) > 0 then
        continue;                                  -- already re-gated; #56 re-applied
      end if;
      raise exception '#56: % carries neither the legacy is_admin() guard nor the '
                      'community.manage guard. Its body has drifted - re-gate it by '
                      'hand and re-run.', v_sig;
    elsif v_hits <> 1 then
      raise exception '#56: % contains % copies of the legacy guard; expected exactly one.',
                      v_sig, v_hits;
    end if;

    execute replace(v_src, v_old, v_new);
  end loop;

  -- admin_community_media_orphans is `language sql`: its guard is an inline WHERE
  -- conjunct, not an if/raise. Same mechanism, one different literal.
  v_oid := to_regprocedure('public.admin_community_media_orphans(integer)');
  if v_oid is null then
    raise exception '#56: admin_community_media_orphans(integer) is missing - run #36 first.';
  end if;
  v_src  := pg_get_functiondef(v_oid);
  v_hits := (length(v_src) - length(replace(v_src, v_orph_old, ''))) / length(v_orph_old);
  if v_hits = 1 then
    execute replace(v_src, v_orph_old, v_orph_new);
  elsif v_hits = 0 and position('has_staff_permission(''community.manage'')' in v_src) > 0 then
    null;                                          -- already re-gated; #56 re-applied
  else
    -- Same three-way shape as the loop. The earlier two-way form could fall through
    -- silently when a drifted body carried BOTH the legacy guard twice and the new one.
    raise exception '#56: admin_community_media_orphans has drifted (% legacy guard hits).', v_hits;
  end if;

  -- ── SELF-VERIFY. `raise notice` is unreliable through the Management API, so the
  --    block proves its own postcondition instead of announcing it.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('admin_community_config','admin_save_community_settings',
                           'admin_save_channel_category','admin_move_channel_category',
                           'admin_save_community_channel','admin_move_community_channel',
                           'admin_set_community_channel_status','admin_channel_privacy_preview',
                           'admin_community_media_orphans')
         and p.prosrc like '%has_staff_permission(''community.manage'')%') <> 9 then
    raise exception '#56: the re-gate did not reach all nine community RPCs.';
  end if;

  -- ── admin_channel_privacy_preview needs a SECOND, semantic patch, and it is a
  --    CONSEQUENCE of section 3, not a nicety. Now that community staff reach every
  --    channel, both audience CTEs would count every staff member as a member of every
  --    room, so the "N members will lose access" confirmation an admin reads before a
  --    privacy change would be wrong by the size of the staff roster.
  --    A correlated NOT EXISTS against two tiny tables becomes a hashed ANTI-JOIN; a
  --    per-row user_is_community_staff(p.id) call would be opaque to the planner, in a
  --    function that already pays two SECDEF calls per profile.
  v_src  := pg_get_functiondef(to_regprocedure('public.admin_channel_privacy_preview(uuid,text,text[],uuid[])'));
  v_hits := (length(v_src) - length(replace(v_src, 'not coalesce(p.is_admin, false)', '')))
            / length('not coalesce(p.is_admin, false)');
  -- ★ PROBE FIRST. The replacement below BEGINS with its own search string, so v_hits stays
  --   2 forever and a hits-only test would append the exclusion again on every re-apply —
  --   semantically harmless (a predicate ANDed with itself) but the body would grow without
  --   bound, and it would be the very bug this file calls out in #43's do $touch$.
  if position('srp.permission_key in (''community.manage'',''community.moderate'')' in v_src) > 0 then
    null;                                          -- already patched
  elsif v_hits = 2 then
    execute replace(v_src, 'not coalesce(p.is_admin, false)',
      'not coalesce(p.is_admin, false)' || chr(10) ||
      '             and not exists (select 1 from public.staff_memberships sm' || chr(10) ||
      '                               join public.staff_role_permissions srp on srp.role_key = sm.role_key' || chr(10) ||
      '                              where sm.user_id = p.id and sm.status = ''active''' || chr(10) ||
      '                                and srp.permission_key in (''community.manage'',''community.moderate''))');
  else
    raise exception '#56: admin_channel_privacy_preview has % staff-exclusion sites; expected 2.', v_hits;
  end if;
end
$regate$;

-- `create or replace` preserves privileges, so these are strictly informational - but a
-- reviewer should be able to read the grant contract without knowing that rule.
revoke all on function public.admin_community_config() from public, anon;
grant execute on function public.admin_community_config() to authenticated;
revoke all on function public.admin_save_community_settings(text, text, text, uuid) from public, anon;
grant execute on function public.admin_save_community_settings(text, text, text, uuid) to authenticated;
revoke all on function public.admin_save_channel_category(uuid, uuid, text, text) from public, anon;
grant execute on function public.admin_save_channel_category(uuid, uuid, text, text) to authenticated;
revoke all on function public.admin_move_channel_category(uuid, int) from public, anon;
grant execute on function public.admin_move_channel_category(uuid, int) to authenticated;
revoke all on function public.admin_save_community_channel(
  uuid, uuid, uuid, text, text, text, text, text, text[], uuid[],
  boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_save_community_channel(
  uuid, uuid, uuid, text, text, text, text, text, text[], uuid[],
  boolean, boolean, boolean, boolean) to authenticated;
revoke all on function public.admin_move_community_channel(uuid, int) from public, anon;
grant execute on function public.admin_move_community_channel(uuid, int) to authenticated;
revoke all on function public.admin_set_community_channel_status(uuid, text) from public, anon;
grant execute on function public.admin_set_community_channel_status(uuid, text) to authenticated;
revoke all on function public.admin_channel_privacy_preview(uuid, text, text[], uuid[]) from public, anon;
grant execute on function public.admin_channel_privacy_preview(uuid, text, text[], uuid[]) to authenticated;
revoke all on function public.admin_community_media_orphans(int) from public, anon;
grant execute on function public.admin_community_media_orphans(int) to authenticated;

-- == 6) community_moderation_events: the append-only moderation ledger ========
-- Community CONFIGURATION has been audited since #40 (community_channel_events).
-- Moderation was not audited at all: hiding, pinning, locking and hard-deleting other
-- people's posts left no record of who did it. Widening that authority to two more roles
-- without a ledger would have made "who removed this?" unanswerable.

create table if not exists public.community_moderation_events (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles(id)           on delete set null,
  target_kind text not null check (target_kind in ('post','comment')),
  target_id   uuid not null,
  post_id     uuid,
  channel_id  uuid references public.community_channels(id) on delete set null,
  space_id    uuid references public.community_spaces(id)   on delete set null,
  author_id   uuid references public.profiles(id)           on delete set null,
  action      text not null check (action in
                ('pin','unpin','lock','unlock','hide','restore','delete')),
  reason      text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.community_moderation_events is
  '#56: append-only. IDs, action codes and storage paths only - never post bodies, '
  'titles, emails or names, matching community_channel_events.';

comment on column public.community_moderation_events.target_id is
  '#56: DELIBERATELY carries no foreign key. The `delete` action HARD-DELETES the row '
  'this column names, and no FK action is correct for that: ON DELETE CASCADE would '
  'erase the audit trail of the deletion - the single most important row in this table; '
  'ON DELETE SET NULL would leave an event that no longer says what it acted on; ON '
  'DELETE RESTRICT would make the delete action impossible. It is a historical '
  'identifier, not a live reference. post_id is the same case.';

alter table public.community_moderation_events enable row level security;

-- The community_channel_events / community_notifications pattern: NO insert, update or
-- delete policy exists, because the only writer is a SECURITY DEFINER function running
-- as the owner. A client cannot forge, edit or erase a row.
revoke insert, update, delete, truncate on public.community_moderation_events
  from authenticated, anon, public;
grant select on public.community_moderation_events to authenticated;

-- Community staff only - NOT the affected author. Telling a member "moderator X hid your
-- post at T for reason R" is a separate product decision with a real harassment surface,
-- and `reason` is written for staff. An author-visible notice would be a curated surface
-- built on top of this, never a widened RLS policy.
drop policy if exists community_moderation_events_staff_select
  on public.community_moderation_events;
create policy community_moderation_events_staff_select
  on public.community_moderation_events
  for select to authenticated
  using ((select public.is_community_staff()));

create index if not exists community_moderation_events_target_idx
  on public.community_moderation_events (target_kind, target_id, created_at desc);
create index if not exists community_moderation_events_actor_idx
  on public.community_moderation_events (actor_id, created_at desc);
create index if not exists community_moderation_events_channel_idx
  on public.community_moderation_events (channel_id, created_at desc);
create index if not exists community_moderation_events_created_idx
  on public.community_moderation_events (created_at desc);
create index if not exists community_moderation_events_author_idx
  on public.community_moderation_events (author_id) where author_id is not null;
create index if not exists community_moderation_events_space_idx
  on public.community_moderation_events (space_id) where space_id is not null;

-- == 7) The two bounded moderation RPCs ======================================
-- What makes these SAFE is not that they are SECURITY DEFINER - it is that their
-- ARGUMENTS cannot express anything but a target and an action. There is no patch object,
-- so there is no column a moderator can reach that this file did not choose for them.
--
-- Immutability of author_id / body / title / channel_id / created_at / counters is
-- enforced THREE times over: (1) the signatures cannot express them; (2) each UPDATE
-- names exactly one column; (3) community_posts_guard()'s UPDATE branch freezes them for
-- any write where auth.uid() is not null and pg_trigger_depth() <= 1, which includes
-- these. Layer 3 is the one that survives a careless future edit to layers 1 and 2.

create or replace function public.community_moderate_post(
  p_post_id uuid,
  p_action  text,
  p_reason  text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $mod$
declare
  v_actor   uuid := (select auth.uid());
  v_action  text := lower(btrim(coalesce(p_action, '')));
  v_row     public.community_posts%rowtype;
  v_paths   text[] := '{}';
  v_event   uuid;
  v_already boolean := false;
  v_status  text;
  v_pinned  boolean;
  v_locked  boolean;
begin
  if not public.has_staff_permission('community.moderate') then
    perform public.app_error('FORBIDDEN', 'Moderating the community needs the community.moderate permission.', 403, null);
  end if;

  -- Validate the ACTION before touching the target, so an unknown action can never
  -- reveal whether a post id exists.
  if v_action not in ('pin','unpin','lock','unlock','hide','restore','delete') then
    perform public.app_error('MODERATION_ACTION_INVALID',
      'Unknown moderation action.', 422, null);
  end if;

  -- The row lock is what makes two moderators clicking at once serialise instead of
  -- racing each other into two audit rows for one state change.
  select * into v_row from public.community_posts where id = p_post_id for update;

  -- ONE code for "does not exist" and for "not in a room you can reach" - the #40 rule
  -- that an invisible channel must report identically to a nonexistent one. The
  -- user_*(uuid) form is used rather than my_*() to make the caller-pinning explicit
  -- inside a SECURITY DEFINER body.
  if v_row.id is null
     or v_row.channel_id is null
     or v_row.channel_id not in (select public.user_community_channel_ids(v_actor)) then
    perform public.app_error('MODERATION_TARGET_NOT_FOUND',
      'That post is not available in a channel you moderate.', 404, null);
  end if;

  -- A moderator may not resurrect an author's own withdrawal: status='deleted' is the
  -- member's soft-delete, and republishing retracted content is not moderation.
  -- ★ HIDE IS REFUSED TOO, and that is not symmetry for its own sake. 'hidden' is distinct
  --   from 'deleted', so hide would succeed on a withdrawn row and leave status='hidden' —
  --   at which point restore's guard passes and the post is republished in two calls. It
  --   also strands the author: community_posts_own_update is
  --   `using (author_id = auth.uid() and status <> 'hidden')`, so once hidden they can no
  --   longer re-withdraw it themselves. delete stays allowed; that is real cleanup.
  if v_action in ('hide', 'restore') and v_row.status = 'deleted' then
    perform public.app_error('MODERATION_STATE_INVALID',
      'The author withdrew this post, so a moderator cannot hide or restore it.', 409, null);
  end if;

  if v_action = 'delete' then
    -- Capture the paths BEFORE the cascade removes the attachment rows. They go into the
    -- audit row AND the response: the client cannot read them afterwards, and reading
    -- them beforehand would race a concurrent upload.
    select coalesce(array_agg(a.storage_path) filter (where a.storage_path is not null), '{}')
      into v_paths
      from public.community_attachments a
     where a.post_id = p_post_id;

    insert into public.community_moderation_events
      (actor_id, target_kind, target_id, post_id, channel_id, space_id, author_id,
       action, reason, detail)
    values (v_actor, 'post', p_post_id, p_post_id, v_row.channel_id, v_row.space_id,
            v_row.author_id, 'delete', nullif(btrim(coalesce(p_reason, '')), ''),
            jsonb_build_object('storage_paths', to_jsonb(v_paths),
                               'status_before', v_row.status))
    returning id into v_event;

    delete from public.community_posts where id = p_post_id;

    return jsonb_build_object(
      'ok', true, 'kind', 'post', 'id', p_post_id, 'channel_id', v_row.channel_id,
      'action', 'delete', 'already', false, 'status', 'deleted',
      'pinned', v_row.pinned, 'comments_locked', v_row.comments_locked,
      'storage_paths', to_jsonb(v_paths), 'event_id', v_event);
  end if;

  -- ONE column per action. Never a multi-column set, never coalesce(p_x, col).
  v_status := v_row.status;
  v_pinned := v_row.pinned;
  v_locked := v_row.comments_locked;

  if v_action in ('pin','unpin') then
    v_pinned := (v_action = 'pin');
    if v_pinned is not distinct from v_row.pinned then v_already := true;
    else update public.community_posts set pinned = v_pinned where id = p_post_id;
    end if;
  elsif v_action in ('lock','unlock') then
    v_locked := (v_action = 'lock');
    if v_locked is not distinct from v_row.comments_locked then v_already := true;
    else update public.community_posts set comments_locked = v_locked where id = p_post_id;
    end if;
  else
    v_status := case when v_action = 'hide' then 'hidden' else 'active' end;
    if v_status is not distinct from v_row.status then v_already := true;
    else update public.community_posts set status = v_status where id = p_post_id;
    end if;
  end if;

  -- A no-op writes NO audit row. The ledger answers "when did this become pinned"; a row
  -- per button press would corrupt that answer every time someone double-clicks.
  if not v_already then
    insert into public.community_moderation_events
      (actor_id, target_kind, target_id, post_id, channel_id, space_id, author_id,
       action, reason, detail)
    values (v_actor, 'post', p_post_id, p_post_id, v_row.channel_id, v_row.space_id,
            v_row.author_id, v_action, nullif(btrim(coalesce(p_reason, '')), ''),
            jsonb_build_object(
              'status_before', v_row.status, 'status_after', v_status,
              'pinned_before', v_row.pinned, 'pinned_after', v_pinned,
              'locked_before', v_row.comments_locked, 'locked_after', v_locked))
    returning id into v_event;
  end if;

  return jsonb_build_object(
    'ok', true, 'kind', 'post', 'id', p_post_id, 'channel_id', v_row.channel_id,
    'action', v_action, 'already', v_already, 'status', v_status,
    'pinned', v_pinned, 'comments_locked', v_locked,
    'storage_paths', '[]'::jsonb, 'event_id', v_event);
end;
$mod$;

comment on function public.community_moderate_post(uuid, text, text) is
  '#56: the ONLY sanctioned path for pin/unpin, lock/unlock, hide/restore and hard '
  'delete of a post. Takes an id and a strict action enum, so it cannot express '
  'author_id, body, title, channel_id, created_at or a counter. Writes exactly one '
  'community_moderation_events row per state change, and none for a no-op.';

revoke all on function public.community_moderate_post(uuid, text, text) from public, anon;
grant execute on function public.community_moderate_post(uuid, text, text) to authenticated;

create or replace function public.community_moderate_comment(
  p_comment_id uuid,
  p_action     text,
  p_reason     text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $mod$
declare
  v_actor   uuid := (select auth.uid());
  v_action  text := lower(btrim(coalesce(p_action, '')));
  v_row     public.community_comments%rowtype;
  v_space   uuid;
  v_event   uuid;
  v_already boolean := false;
  v_status  text;
begin
  if not public.has_staff_permission('community.moderate') then
    perform public.app_error('FORBIDDEN', 'Moderating the community needs the community.moderate permission.', 403, null);
  end if;

  if v_action not in ('hide','restore','delete') then
    perform public.app_error('MODERATION_ACTION_INVALID',
      'Unknown moderation action.', 422, null);
  end if;

  select * into v_row from public.community_comments where id = p_comment_id for update;

  if v_row.id is null
     or v_row.channel_id is null
     or v_row.channel_id not in (select public.user_community_channel_ids(v_actor)) then
    perform public.app_error('MODERATION_TARGET_NOT_FOUND',
      'That reply is not available in a channel you moderate.', 404, null);
  end if;

  -- See community_moderate_post: hide is refused as well, or hide-then-restore republishes
  -- an author's withdrawal in two calls and strands them behind status <> 'hidden'.
  if v_action in ('hide', 'restore') and v_row.status = 'deleted' then
    perform public.app_error('MODERATION_STATE_INVALID',
      'The author withdrew this reply, so a moderator cannot hide or restore it.', 409, null);
  end if;

  select p.space_id into v_space from public.community_posts p where p.id = v_row.post_id;

  if v_action = 'delete' then
    insert into public.community_moderation_events
      (actor_id, target_kind, target_id, post_id, channel_id, space_id, author_id,
       action, reason, detail)
    values (v_actor, 'comment', p_comment_id, v_row.post_id, v_row.channel_id, v_space,
            v_row.author_id, 'delete', nullif(btrim(coalesce(p_reason, '')), ''),
            jsonb_build_object('status_before', v_row.status))
    returning id into v_event;

    delete from public.community_comments where id = p_comment_id;
  else
    v_status := case when v_action = 'hide' then 'hidden' else 'active' end;
    if v_status is not distinct from v_row.status then
      v_already := true;
    else
      update public.community_comments set status = v_status where id = p_comment_id;
      insert into public.community_moderation_events
        (actor_id, target_kind, target_id, post_id, channel_id, space_id, author_id,
         action, reason, detail)
      values (v_actor, 'comment', p_comment_id, v_row.post_id, v_row.channel_id, v_space,
              v_row.author_id, v_action, nullif(btrim(coalesce(p_reason, '')), ''),
              jsonb_build_object('status_before', v_row.status, 'status_after', v_status))
      returning id into v_event;
    end if;
  end if;

  -- storage_paths is ALWAYS empty here, and that is not an oversight:
  -- community_attachments.post_id means an attachment hangs off a POST, never a comment.
  return jsonb_build_object(
    'ok', true, 'kind', 'comment', 'id', p_comment_id, 'channel_id', v_row.channel_id,
    'action', v_action, 'already', v_already,
    'status', case when v_action = 'delete' then 'deleted' else v_status end,
    'pinned', null, 'comments_locked', null,
    'storage_paths', '[]'::jsonb, 'event_id', v_event);
end;
$mod$;

comment on function public.community_moderate_comment(uuid, text, text) is
  '#56: hide / restore / hard delete for a reply. storage_paths is always empty - '
  'community_attachments.post_id means attachments hang off posts, never comments.';

revoke all on function public.community_moderate_comment(uuid, text, text) from public, anon;
grant execute on function public.community_moderate_comment(uuid, text, text) to authenticated;

-- == 8) RLS: `alter policy`, never drop + create =============================
-- #45 (:2114-2127) established `alter policy` as the re-gate idiom, storage.objects
-- included. It is the right instrument even where the whole qual has to be reproduced:
--
--   * `create policy` retypes the ROLE LIST. Omitting `to authenticated` silently
--     defaults to PUBLIC, which includes anon - a drop+create of a read policy that
--     loses that clause is a data leak. `alter policy` cannot express it.
--   * `drop policy if exists <typo>` is a silent no-op and `create policy <typo>` then
--     adds a SECOND permissive policy beside the untouched original. `alter policy
--     <typo>` errors.
--   * It touches only the clauses named, so community_notifications_own_update keeps its
--     `with check` byte-for-byte with no chance to retype it.
--
-- Two traps: a FOR ALL policy altered with only `using` widens reads and leaves WRITES on
-- is_admin() (fail-closed, but it presents as a broken feature); and `using` on an INSERT
-- policy is a syntax error mid-file, with no transaction to roll back what already ran.

-- ── 8a) The blanket FOR ALL policies stay SUPER-ADMIN-ONLY ──────────────────
-- ★ THIS IS THE POINT OF THE WHOLE FILE, AND THE OBVIOUS EDIT IS THE WRONG ONE.
--   The reflex is to re-gate these onto community.moderate beside everything else. That
--   would defeat section 7 entirely. `community_posts` has NO table-level DML revoke —
--   `authenticated` keeps Supabase's default INSERT/UPDATE/DELETE grants, so RLS is the
--   only boundary — and a FOR ALL policy is a blanket CLIENT write path. A moderator could
--   then `PATCH /rest/v1/community_posts?id=eq.X` with any body at all:
--     * rewrite another member's `body` / `title` / `tag_slug`  (guard freezes neither)
--     * set `author_id` to someone else                          (impersonation)
--     * `DELETE` the row, cascading its attachments away with NO ledger row and NO captured
--       storage paths — after which section 9's join arm has nothing to join to and its
--       receipt arm has no receipt, so those private objects are unreachable forever.
--   Every one of those is a thing the moderation contract explicitly forbids, and the
--   bounded RPCs would become one optional route among two.
--
--   So the blanket reach stays exactly where it already was: with Super Admin.
--   `is_super_admin()` rather than `is_admin()` is the same set by construction (the column
--   IS "active super_admin"), read from staff_memberships instead of the profiles cache.
--   Operations Admins and Trainers reach other people's content ONLY through
--   community_moderate_post/_comment, which are SECURITY DEFINER, run as the owner, bypass
--   RLS entirely, and write the ledger. Section 8d then gives them their OWN-row writes.
alter policy community_posts_admin_all on public.community_posts
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

alter policy community_comments_admin_all on public.community_comments
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

alter policy community_reactions_admin_all on public.community_reactions
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

alter policy community_attachments_admin_all on public.community_attachments
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

alter policy community_post_tags_admin_all on public.community_post_tags
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- ── 8b) Configuration -> community.manage ───────────────────────────────────
-- The audience maps and the channel audit log are the configuration surface itself. These
-- three are SELECT-only, so they carry none of 8a's blanket-write hazard.
--
-- ★ community_tags_admin_all is NOT here, and that is the same decision as 8a. It is a SIXTH
--   FOR ALL policy on a table with no DML revoke, so gating it on community.manage would let
--   a Trainer PATCH community_tags and set admin_only = true on every row — which makes
--   community_posts_own_insert's tag conjunct false for every ordinary member, i.e. a
--   forum-wide posting outage, through a path with no RPC and no audit row. Nothing in the
--   app writes this table (the client only selects it), so gating it on community.manage
--   would grant an unused capability and a real denial-of-service in the same statement.
--   The ten seeded tags stay Super-Admin-only.
alter policy community_tags_admin_all on public.community_tags
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

alter policy community_channel_plans_admin_select on public.community_channel_plans
  using ((select public.has_staff_permission('community.manage')));

alter policy community_channel_batches_admin_select on public.community_channel_batches
  using ((select public.has_staff_permission('community.manage')));

alter policy community_channel_events_admin_select on public.community_channel_events
  using ((select public.has_staff_permission('community.manage')));

-- ── 8c) Read + standing arms -> is_community_staff() ────────────────────────
-- Each qual below is the CURRENT one with only its first disjunct swapped. Two different
-- rationales share the token: on the *_read policies it is "staff see hidden content and
-- every room"; on the own-row DELETE/notification/announcement policies it is an
-- ENROLMENT-STANDING bypass - is_enrolled() is false for a staff member with no
-- subscription, so without the swap they could not delete an attachment they uploaded or
-- mark their own notification read.
-- ★ is_enrolled() itself is NOT widened: it gates courses, lessons, feature guides and
--   the whole paywall.

alter policy community_posts_read on public.community_posts
  using (
    (select public.is_community_staff())
    or (status = 'active'
        and (select public.is_approved()) and (select public.is_enrolled())
        and channel_id in (select public.my_community_channel_ids()))
    or (author_id = (select auth.uid()) and status = 'deleted')
  );

alter policy community_comments_read on public.community_comments
  using (
    (select public.is_community_staff())
    or (status = 'active'
        and (select public.is_approved()) and (select public.is_enrolled())
        and channel_id in (select public.my_community_channel_ids())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'))
    or (author_id = (select auth.uid()) and status = 'deleted')
  );

alter policy community_reactions_read on public.community_reactions
  using (
    (select public.is_community_staff())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and ((post_id is not null and exists (
                select 1 from public.community_posts p
                 where p.id = post_id and p.status = 'active'
                   and p.channel_id in (select public.my_community_channel_ids())))
          or (comment_id is not null and exists (
                select 1 from public.community_comments c
                  join public.community_posts p on p.id = c.post_id
                 where c.id = comment_id and c.status = 'active' and p.status = 'active'
                   and p.channel_id in (select public.my_community_channel_ids())))))
  );

alter policy community_reactions_own_delete on public.community_reactions
  using (
    user_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())
             and (
               (post_id is not null and exists (
                  select 1 from public.community_posts p
                   where p.id = post_id
                     and p.channel_id in (select public.my_community_channel_ids())))
               or (comment_id is not null and exists (
                  select 1 from public.community_comments cm
                   where cm.id = comment_id
                     and cm.channel_id in (select public.my_community_channel_ids())))
             )))
  );

alter policy community_attachments_read on public.community_attachments
  using (
    (select public.is_community_staff())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'
                       and p.channel_id in (select public.my_community_channel_ids())))
  );

alter policy community_attachments_own_delete on public.community_attachments
  using (
    uploader_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

alter policy community_tags_read on public.community_tags
  using ((select public.is_community_staff())
      or ((select public.is_approved()) and (select public.is_enrolled())));

alter policy community_post_tags_read on public.community_post_tags
  using (
    (select public.is_community_staff())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'
                       and p.channel_id in (select public.my_community_channel_ids())))
  );

alter policy community_post_tags_own_delete on public.community_post_tags
  using (
    ((select public.is_community_staff())
     or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

alter policy community_notifications_own_select on public.community_notifications
  using (
    user_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and channel_id in (select public.my_community_channel_ids())
  );

-- `using` only: the `with check (user_id = (select auth.uid()))` is left exactly as it
-- was, with no opportunity to retype it.
alter policy community_notifications_own_update on public.community_notifications
  using (
    user_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and channel_id in (select public.my_community_channel_ids())
  );

alter policy community_announcement_reads_own_select on public.community_announcement_reads
  using (user_id = (select auth.uid())
     and ((select public.is_community_staff())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

-- An INSERT policy has NO `using` clause. Passing one here is a syntax error.
alter policy community_announcement_reads_own_insert on public.community_announcement_reads
  with check (
    user_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.status = 'active'
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

-- ★ community_spaces_admin_all is NOT touched. #45 moved it to batches.manage on purpose:
--   a space is created and destroyed by the BATCH lifecycle, and admin_finalize_enrollment
--   refuses with NO_SPACE_FOR_SEGMENT when a batch has none, so a community configurator
--   with write access there could break enrolment approval for a whole cohort. The
--   community side needs the READ, and that is what it gets.
alter policy community_spaces_read on public.community_spaces
  using ((select public.is_community_staff())
      or (active and id in (select public.my_community_space_ids())));

alter policy community_channels_read on public.community_channels
  using ((select public.is_community_staff())
      or id in (select public.my_community_channel_ids()));

alter policy community_channel_categories_read on public.community_channel_categories
  using (
    (select public.is_community_staff())
    -- Uncorrelated on purpose: one InitPlan per statement, not one per row.
    or id in (select ch.category_id from public.community_channels ch
               where ch.id in (select public.my_community_channel_ids()))
  );

alter policy community_settings_read on public.community_settings
  using ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())));

-- ── 8d) The staff OWN-ROW write path ────────────────────────────────────────
-- Section 8a deliberately leaves Ops Admins and Trainers with no cross-author write. They
-- still have to be able to write as THEMSELVES, and they cannot: every *_own_insert /
-- *_own_update policy requires `is_enrolled()`, which is FALSE for a staff account with no
-- subscription (`db/2026-07-04-subscription-lifecycle.sql`: is_paid OR a live term OR the
-- grandfather — a staff member is none of those). Without this section an Operations Admin
-- could moderate the forum and never post in it.
--
-- Each policy below is its current qual with the ENROLMENT-STANDING conjunct widened, and
-- nothing else. `author_id = auth.uid()` / `uploader_id = auth.uid()` are untouched, so this
-- grants no reach over anyone else's row. The channel-capability conjuncts are untouched
-- too — they already return true for staff everywhere, via
-- user_community_channel_capabilities() in section 3.
--
-- ★ The `admin_only` TAG conjunct is widened in the same two policies. Since #43 the thing
--   that makes a post an ANNOUNCEMENT is the CHANNEL's kind, and the tag is post taxonomy —
--   but the taxonomy is still gated, and without this a Community staff member is offered
--   the Announcements chip in the composer and refused at submit.

alter policy community_posts_own_insert on public.community_posts
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and channel_id in (select c.channel_id
                         from public.my_community_channel_capabilities() c
                        where c.can_post)
    and ((select public.is_community_staff())
         or not exists (select 1 from public.community_tags t
                         where t.slug = tag_slug and t.admin_only))
  );

alter policy community_posts_own_update on public.community_posts
  using (author_id = (select auth.uid()) and status <> 'hidden')
  with check (
    author_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and (
      -- withdraw: only needs to still be able to SEE the room
      (status = 'deleted' and channel_id in (select public.my_community_channel_ids()))
      or
      -- keep published: needs the write right
      (status = 'active'
       and channel_id in (select c.channel_id
                            from public.my_community_channel_capabilities() c
                           where c.can_post)
       and ((select public.is_community_staff())
            or not exists (select 1 from public.community_tags t
                            where t.slug = tag_slug and t.admin_only)))
    )
  );

-- ★ The comments_locked bypass is the one conjunct section 3 could NOT reach, because it is
--   a per-POST flag rather than a channel capability. Without it the confirmed product
--   decision is only half true: every #announcements post is born comments_locked = true by
--   community_posts_guard(), so a Trainer could publish an announcement and then be refused
--   when replying to their own, and a moderator who locks a heated thread could not leave a
--   note in it. It is deliberately narrower than it looks — the post must still be 'active'
--   and in a channel the caller can comment in.
alter policy community_comments_own_insert on public.community_comments
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (
      select 1 from public.community_posts p
       where p.id = post_id
         and p.status = 'active'
         and (not p.comments_locked or (select public.is_community_staff()))
         and p.channel_id in (select c.channel_id
                                from public.my_community_channel_capabilities() c
                               where c.can_comment))
  );

alter policy community_comments_own_update on public.community_comments
  using (author_id = (select auth.uid()) and status <> 'hidden')
  with check (
    author_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and ((status = 'deleted' and channel_id in (select public.my_community_channel_ids()))
         or (status = 'active'
             and channel_id in (select c.channel_id
                                  from public.my_community_channel_capabilities() c
                                 where c.can_comment)))
  );

alter policy community_reactions_own_insert on public.community_reactions
  with check (
    user_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and ((post_id is not null and exists (
            select 1 from public.community_posts p
             where p.id = post_id and p.status = 'active'
               and p.channel_id in (select c.channel_id
                                      from public.my_community_channel_capabilities() c
                                     where c.can_react)))
      or (comment_id is not null and exists (
            select 1 from public.community_comments c2
              join public.community_posts p on p.id = c2.post_id
             where c2.id = comment_id and c2.status = 'active' and p.status = 'active'
               and p.channel_id in (select c.channel_id
                                      from public.my_community_channel_capabilities() c
                                     where c.can_react))))
  );

alter policy community_attachments_own_insert on public.community_attachments
  with check (
    uploader_id = (select auth.uid())
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (
      select 1 from public.community_posts p
       where p.id = community_attachments.post_id
         and p.author_id = (select auth.uid())
         and p.channel_id in (select c.channel_id
                                from public.my_community_channel_capabilities() c
                               where c.can_attach)
         -- Storage paths stay SPACE-scoped (<space_id>/<uid>/...) so every
         -- pre-#40 object keeps resolving. #37's legacy <uid>/... branch stays.
         and (community_attachments.storage_path is null
              or (storage.foldername(community_attachments.storage_path))[1] = (select auth.uid())::text
              or ((storage.foldername(community_attachments.storage_path))[1] = p.space_id::text
                  and (storage.foldername(community_attachments.storage_path))[2] = (select auth.uid())::text)))
  );

alter policy community_post_tags_own_insert on public.community_post_tags
  with check (
    ((select public.is_community_staff())
     or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

-- == 9) Storage: the private community-media bucket ==========================
alter policy community_media_read on storage.objects
  using (
    bucket_id = 'community-media'
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())
             and exists (
               select 1 from public.community_attachments a
                 join public.community_posts p on p.id = a.post_id
                where a.storage_path = name
                  and p.status = 'active'
                  and p.channel_id in (select public.my_community_channel_ids()))))
  );

-- ★ DELETE IS FOUR ARMS, AND THE BOUNDING IS NOT WHAT IT LOOKS LIKE.
--   Today's `is_admin()` arm is a BLANKET reach over every object in the bucket. It stays,
--   unchanged in scope, as SUPER-ADMIN-ONLY - is_super_admin() rather than is_admin() so
--   it reads from staff_memberships instead of the profiles cache and cannot go stale.
--   The two new moderator arms are strictly narrower:
--
--   join arm - the attachment -> post -> channel join the uploader arm already uses, minus
--     `a.uploader_id = auth.uid()`. Note that after section 3 community staff reach EVERY
--     channel, so `p.channel_id in (...)` adds nothing for them. The real bound is
--     `a.storage_path = name` joined to a LIVE post: every object a moderator can name
--     belongs to an existing attachment of an existing post. An ORPHAN - a completed
--     upload whose attachment insert failed, possibly another member's in-flight compose -
--     is NOT reachable. A reader will assume the channel test is the guard; it is not.
--
--   receipt arm - the path appears in this actor's OWN audit row for a delete they just
--     performed, within 15 minutes. This is what lets the client sweep AFTER the RPC
--     instead of before it: the FK cascade removes the rows the join arm needs the instant
--     the post is gone, so a join-arm-only design forces sweep-first, which races a
--     concurrent upload and leaves a live post with dead image URLs if the RPC then fails.
--     `(detail -> 'storage_paths') ? name` is top-level array containment, served by
--     community_moderation_events_actor_idx.
--
--   #40 + #43's uploader and own-orphan arms are reproduced BYTE-FOR-BYTE.
--
-- ★ Do NOT add a moderator arm to community_attachments_own_delete. The sanctioned row
--   path is the RPC (SECDEF, runs as owner, cascades). A second unbounded client write
--   path would undo section 7. #34's pairing invariant is preserved: the row and its
--   object stay deletable-or-not together for the MEMBER, which is what it protects.
alter policy community_media_delete on storage.objects
  using (
    bucket_id = 'community-media'
    and ((select public.is_super_admin())
         or ((select public.has_staff_permission('community.moderate'))
             and exists (
               select 1 from public.community_attachments a
                 join public.community_posts p on p.id = a.post_id
                where a.storage_path = name
                  and p.channel_id in (select public.my_community_channel_ids())))
         or ((select public.has_staff_permission('community.moderate'))
             and exists (
               select 1 from public.community_moderation_events e
                where e.actor_id = (select auth.uid())
                  and e.action = 'delete'
                  and e.created_at > now() - interval '15 minutes'
                  and (e.detail -> 'storage_paths') ? name))
         -- ★ THE STANDING CONJUNCT IS WIDENED HERE TOO, AND LEAVING IT OUT WAS A BUG.
         --   This is the arm that carries #43's own-ORPHAN branch, and an orphan is
         --   reachable by NOTHING else: the moderator join arm above needs a live
         --   attachment row (an orphan has none, by definition) and the receipt arm needs a
         --   prior audited delete. Since is_enrolled() is false for a staff account with no
         --   subscription, an un-widened arm means an Operations Admin or Trainer whose
         --   attachment insert fails cannot clear the object they just uploaded — a
         --   permanently unreachable private file, which is precisely what #43 section 2
         --   exists to prevent. It also keeps the #34 pairing honest: section 8d widened the
         --   ROW policy (community_attachments_own_delete), so the OBJECT policy must widen
         --   with it or the two stop being deletable-or-not together.
         or (((select public.is_community_staff())
              or ((select public.is_approved()) and (select public.is_enrolled())))
             and (
               exists (
                 select 1 from public.community_attachments a
                   join public.community_posts p on p.id = a.post_id
                  where a.storage_path = name
                    and a.uploader_id = (select auth.uid())
                    and p.channel_id in (select public.my_community_channel_ids()))
               or (not exists (select 1 from public.community_attachments a2
                                where a2.storage_path = name)
                   and ((storage.foldername(name))[1] = ((select auth.uid()))::text
                        or (storage.foldername(name))[2] = ((select auth.uid()))::text))
             )))
  );

-- ★ The OBJECT upload, not just the attachment ROW. Section 8d widened
--   community_attachments_own_insert; without this one a staff member is offered the image
--   and video buttons (canAttach is true for them client-side) and the publish aborts on
--   the storage upload, which runs BEFORE the post insert. Half a fix is a broken feature.
alter policy community_media_own_insert on storage.objects
  with check (
    bucket_id = 'community-media'
    and ((select public.is_community_staff())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.my_community_channel_capabilities() c where c.can_attach)
    and ((storage.foldername(name))[1] = ((select auth.uid()))::text
         or ((storage.foldername(name))[2] = ((select auth.uid()))::text
             and (case
                    when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                      then ((storage.foldername(name))[1])::uuid
                    else null::uuid
                  end) in (select public.my_community_space_ids())))
  );

comment on policy community_media_delete on storage.objects is
  '#56: #43''s member rules byte-for-byte, plus a Super-Admin blanket arm (unchanged in '
  'scope, read from staff_memberships) and two BOUNDED moderator arms - an '
  'attachment-join arm that can only name a file belonging to a live post, and a receipt '
  'arm limited to the paths this actor''s own audited hard-delete just produced.';

-- == 10) app_error_catalog(): three new codes ================================
-- Restated IN FULL from db/2026-08-31-access-request-staff-target.sql (#51) with three
-- rows appended. The catalog is a single VALUES list, so a delta is not expressible.
-- Lockstep partners: APP_ERROR_CODES *and* APP_ERROR_COPY in src/lib/appErrors.js.
-- Clients branch on error.hint, never on the HTTP status.
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
    ('MODERATION_STATE_INVALID',     409, 'The target''s current state does not allow that action (e.g. restoring an author-withdrawn post).')
  ) as t(code, http, summary);
$cat$;

-- == 11) Retired sidebar labels ==============================================
-- The Niche Selector Quiz, Budgeting Tool and Forecasting Tool were removed from the app
-- in this change. sidebar_settings holds GLOBAL admin label overrides keyed by a stable
-- item_key, and item_key is the PRIMARY KEY - so this matches at most three rows, cannot
-- touch another customization, and is idempotent. Per-user order/collapse state needs no
-- migration: mergeStoredWithDefaults() filters stored tabs through the code defaults, so
-- a retired id drops out of a saved layout on its own (test/sidebarLayout.test.mjs).
delete from public.sidebar_settings
 where item_key in ('tab:niche', 'tab:budgeting', 'tab:forecasting');

-- The new table and both RPCs are invisible to PostgREST until the cache reloads.
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-05-community-staff-authority.sql', null,
  'community staff authority (#56): grant community.manage + community.moderate to '
  'operations_admin and trainer (28 -> 32), re-gate the nine community config RPCs and '
  '33 RLS policies off is_admin(), widen the visibility chain to community staff, add '
  'bounded community_moderate_post/_comment RPCs plus the append-only '
  'community_moderation_events ledger, and bound moderator deletes in community-media. '
  'SHIP WITH THE CLIENT: a pre-#56 bundle PATCHes community_posts directly, which now '
  '42501s for a non-super moderator.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) All nine RPCs re-gated, none left on the legacy guard:
--
--    select proname,
--           prosrc like '%has_staff_permission(''community.manage'')%' as gated,
--           prosrc like '%if not public.is_admin() then%'              as legacy
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and proname in ('admin_community_config','admin_save_community_settings',
--                       'admin_save_channel_category','admin_move_channel_category',
--                       'admin_save_community_channel','admin_move_community_channel',
--                       'admin_set_community_channel_status','admin_channel_privacy_preview',
--                       'admin_community_media_orphans');
--      -> gated = t and legacy = f for all nine rows.
--
-- 2) The channel writer kept #43's patch THROUGH the re-gate:
--
--    select prosrc like '%p_kind           is not null%' as kept
--      from pg_proc where proname = 'admin_save_community_channel';   -> t
--
-- 3) The forgery carve-out survived — is_super_admin() above created_at, and exactly
--    three community.moderate tests above pinned / comments_locked:
--
--    select prosrc from pg_proc where proname = 'community_posts_guard';
--
-- 4) The matrix is 32, and both community keys reach both roles:
--
--    select count(*) from public.staff_role_permissions;              -> 32
--    select role_key, permission_key from public.staff_role_permissions
--     where permission_key like 'community.%' order by 1, 2;          -> 6 rows
--
-- 5) Signed in through PostgREST as a REAL active operations_admin (not the SQL editor —
--    the Management API runs as postgres, where auth.uid() is null and every
--    auth.uid()-pinned helper answers "no"):
--
--    select public.is_community_staff();                              -> t
--    select count(*) from public.community_channels;                  -> every channel
--    select public.admin_community_config();                          -> succeeds (403 before)
--
-- 6) As the same account, moderation works AND the guard let it through:
--
--    select public.community_moderate_post('<post-id>', 'pin');       -> {"ok":true,...}
--    select pinned from public.community_posts where id = '<post-id>';-> t
--
-- 7) As a plain member, it does not:
--
--    select public.community_moderate_post('<post-id>', 'pin');       -> ERROR, hint FORBIDDEN
--    select public.community_moderate_post('<post-id>', 'destroy');   -> hint MODERATION_ACTION_INVALID
--
-- 8) Exactly one audit row per state change, and none for a no-op:
--
--    select action, actor_id, target_kind, target_id, created_at
--      from public.community_moderation_events order by created_at desc limit 5;
--
-- 9) The ledger is append-only from a client:
--
--    insert into public.community_moderation_events (target_kind, target_id, action)
--      values ('post', gen_random_uuid(), 'hide');                    -> permission denied
--
-- 10) npm run db:audit   -> clean, including the new #56 checks.
