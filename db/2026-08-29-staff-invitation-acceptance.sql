-- ─────────────────────────────────────────────────────────────────────────────
-- #49 — Staff invitation acceptance: the invited → active transition.
-- ─────────────────────────────────────────────────────────────────────────────
-- #45 shipped an invitation that nothing could ever accept. `staff_memberships`
-- has always allowed status='invited', api/admin/staff.js has always written it,
-- and the Team & Roles directory has always rendered it — but no function, no
-- trigger and no policy anywhere moved a row OUT of it. Verified in production:
-- one operations_admin sitting at status='invited', activated_at null, whose
-- auth.users row shows email_confirmed_at, last_sign_in_at AND a password hash.
-- They accepted, signed in, and were shown the student pricing page, because
-- profiles.is_admin is false for every non-super role by design and the root gate
-- had no other reason to let them through.
--
-- ★ 1. my_staff_context() HANDED OUT PERMISSIONS FOR AN UNACCEPTED INVITATION.
--      Called as that same user it returned is_staff:true, role_label:'Operations
--      Admin' and all five operations permissions. It is NOT exploitable today —
--      has_staff_permission() correctly returns false (verified as that user), and
--      normalizeStaffContext() collapses any non-active status to the empty
--      context — but this is the one RPC both the browser and api/_lib/staffAuth.js
--      treat as authoritative, and it was describing an authority its own database
--      would refuse. Defence in depth means the source agrees with the gate.
--      Now: permissions/role_key/assigned_course_ids are emitted ONLY for
--      status='active'.
--
-- ★ 2. The membership is still REPORTED, in a separate object that structurally
--      cannot authorize. `membership` carries status/role/label/dates and NO
--      permission list, so the client can render "you were invited as a Trainer"
--      without any code path existing by which that could become authority. The
--      alternative — relaxing normalizeStaffContext() — would have put an invited
--      row one boolean away from a live one.
--
-- ★ 3. accept_staff_invitation() TAKES NO ARGUMENTS. Not a user id, not a role.
--      auth.uid() is the subject and the pre-assigned role is the role, so the
--      RPC has no surface on which to name someone else or promote yourself.
--      It locks the row FOR UPDATE, so a double-click serializes instead of
--      writing twice, and requires auth.users.email_confirmed_at — an
--      unconfirmed identity has not proven it owns the mailbox the invitation
--      was sent to.
--
-- ★ 4. NO is_admin TRIGGER WORK. staff_sync_is_admin already fires AFTER INSERT
--      OR UPDATE OR DELETE and recomputes "has an ACTIVE super_admin membership",
--      so invited→active flips the cache for a Super Admin and leaves it false
--      for Operations Admin and Trainer, with nothing added here. Re-deriving it
--      in this file would have created a second writer for a column #45 spent a
--      whole section reducing to one.
--
-- ★ 5. Audit vocabulary is EXTENDED, not repurposed. 'accept' and 'invite_resent'
--      join the action CHECK and 'staff_invite' joins the source CHECK, so an
--      acceptance is distinguishable from an admin assignment in the ledger. The
--      delivery OUTCOME is membership state (invite_status), not an audit action,
--      matching student_import_rows.invite_status — an audit row records a
--      decision someone made, and "Resend accepted the API call" is not one.
--
-- Depends on: #45 (staff tables + staff_sync_is_admin), #31 (schema_migrations).
-- Independent of #47/#48 — it touches no subscription or policy they define — but
-- my_staff_context() is REPLACED here, so it must run AFTER #46, which added
-- assigned_course_ids to it.
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight ============================================================
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.staff_memberships') is null then
    raise exception 'Run db/2026-08-25-staff-authorization.sql (#45) first.';
  end if;
  -- #46 added assigned_course_ids to my_staff_context(); this file replaces that
  -- function wholesale, so running before #46 would silently REMOVE the field and
  -- break every Trainer's course list.
  if to_regprocedure('public.can_manage_course(uuid)') is null then
    raise exception 'Run db/2026-08-26-course-staff-assignments.sql (#46) first — this file replaces my_staff_context().';
  end if;
end
$pre$;


-- == 1) Audit vocabulary =====================================================
-- Drop-then-add rather than a conditional, so a re-run always lands on exactly
-- this list instead of depending on what was there before.

alter table public.staff_role_events drop constraint if exists staff_role_events_action_check;
alter table public.staff_role_events add constraint staff_role_events_action_check
  check (action = any (array[
    'bootstrap', 'invite', 'assign', 'role_change',
    'suspend', 'reactivate', 'revoke',
    'accept',          -- #49: the invitee accepted, by their own hand
    'invite_resent'    -- #49: a Super Admin minted a fresh link
  ]));

alter table public.staff_role_events drop constraint if exists staff_role_events_source_check;
alter table public.staff_role_events add constraint staff_role_events_source_check
  check (source = any (array[
    'admin_ui', 'bootstrap_script', 'migration', 'sql',
    'staff_invite'     -- #49: written by the invitation flow, actor = the invitee
  ]));


-- == 2) Invitation delivery state ============================================
-- Where the email got to, so Team & Roles can stop claiming "Invitation sent"
-- for a send the provider refused. Mirrors student_import_rows.invite_status.
--
-- ★ invite_error_code holds a SAFE CODE ONLY ('resend_422', 'no_link', …) — never
--   a provider message, never an address, and above all never a link. The
--   one-time token is minted, sent and discarded in the same function call; it is
--   not written here or anywhere else.

alter table public.staff_memberships
  add column if not exists invite_sent_at    timestamptz,
  add column if not exists invite_status     text,
  add column if not exists invite_error_code text;

alter table public.staff_memberships drop constraint if exists staff_memberships_invite_status_check;
alter table public.staff_memberships add constraint staff_memberships_invite_status_check
  check (invite_status is null or invite_status = any (array['pending', 'sent', 'failed', 'resent']));

comment on column public.staff_memberships.invite_status is
  '#49: delivery state of the invitation email — pending|sent|failed|resent. NOT authority: '
  'only status=''active'' confers permissions. A failed send must leave the row recoverable at '
  'status=''invited'' so Resend invitation can retry it.';

comment on column public.staff_memberships.invite_error_code is
  '#49: a safe short code for why a send failed (resend_4xx, no_link, email_not_configured). '
  'Never a provider message, an address, or a link — the one-time token is discarded at send.';


-- == 3) my_staff_context() — authority only when active ======================
-- ★ The shape change: role_key / role_label / display_title / permissions /
--   assigned_course_ids are now NULL or empty unless the membership is active.
--   `status` and the new `membership` object still describe the row, so the
--   client can offer acceptance without ever holding a permission it may not use.
--
--   normalizeStaffContext() already refuses anything that is not active, so this
--   narrows what crosses the wire without changing a single client decision.

create or replace function public.my_staff_context()
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select jsonb_build_object(
       -- Authority half. Every field here is gated on active.
       'is_staff',        (m.status = 'active'),
       'role_key',        case when m.status = 'active' then m.role_key      end,
       'role_label',      case when m.status = 'active' then r.label         end,
       'status',          m.status,
       'display_title',   case when m.status = 'active' then m.display_title end,
       'is_super_admin',  (m.status = 'active' and m.role_key = 'super_admin'),
       'permissions',     case when m.status = 'active' then coalesce(
                            (select jsonb_agg(rp.permission_key order by rp.permission_key)
                               from public.staff_role_permissions rp
                              where rp.role_key = m.role_key),
                            '[]'::jsonb)
                          else '[]'::jsonb end,
       -- #46: the courses this person holds a LIVE assignment on. Only meaningful
       -- for a manage_assigned holder; a manage_all holder edits everything and
       -- the client's canManageCourseClient() short-circuits on that permission
       -- before it ever looks at this list.
       'assigned_course_ids', case when m.status = 'active' then coalesce(
                                (select jsonb_agg(distinct a.course_id)
                                   from public.course_staff_assignments a
                                  where a.staff_user_id = m.user_id
                                    and a.revoked_at is null),
                                '[]'::jsonb)
                              else '[]'::jsonb end,
       -- Descriptive half (#49). NO permission list, by construction: this object
       -- exists so an invited member can be shown their pending role, and it must
       -- be impossible to mistake for authority.
       'membership',      jsonb_build_object(
                            'exists',        true,
                            'status',        m.status,
                            'role_key',      m.role_key,
                            'role_label',    r.label,
                            'display_title', m.display_title,
                            'invited_at',    m.invited_at,
                            'activated_at',  m.activated_at
                          )
     )
     from public.staff_memberships m
     join public.staff_roles r on r.key = m.role_key
    where m.user_id = (select auth.uid())),
    jsonb_build_object(
      'is_staff', false,
      'membership', jsonb_build_object('exists', false)
    )
  )
$fn$;

comment on function public.my_staff_context() is
  '#49: the ONE call the client and api/_lib/staffAuth.js make to learn who the caller is, read '
  'LIVE on every request rather than decoded from a JWT claim — which is what makes a suspension '
  'take effect on the next request. Authority fields are emitted ONLY for status=''active''; the '
  'separate `membership` object describes a pending or ended membership and carries no permission '
  'list, so an invited row cannot be one boolean away from a live one.';

revoke all on function public.my_staff_context() from public, anon;
grant execute on function public.my_staff_context() to authenticated;


-- == 4) accept_staff_invitation() ============================================
-- The invitee's own hand, and nothing else's. No arguments at all.

create or replace function public.accept_staff_invitation()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_m         public.staff_memberships%rowtype;
  v_email     text;
  v_confirmed timestamptz;
begin
  if v_uid is null then
    perform public.app_error('FORBIDDEN', 'Sign in to accept a staff invitation.', 401);
  end if;

  -- FOR UPDATE: a double-click, a retried request and a duplicated tab all
  -- serialize here. The loser re-reads the row and takes the idempotent branch
  -- below instead of writing a second time or a second audit event.
  select * into v_m
    from public.staff_memberships
   where user_id = v_uid
   for update;

  if not found then
    perform public.app_error('STAFF_NO_INVITATION',
      'There is no staff invitation on this account.', 404);
  end if;

  -- Idempotent replay. Accepting twice is a normal thing for a human to do; it is
  -- not an error, and it must not write a second 'accept' row.
  if v_m.status = 'active' then
    return jsonb_build_object(
      'status', 'active', 'role_key', v_m.role_key, 'already_active', true);
  end if;

  -- Suspended and revoked are refused HERE rather than being silently reactivated.
  -- An old invitation link is not a way back in; that needs a deliberate admin act.
  if v_m.status <> 'invited' then
    perform public.app_error('STAFF_INVITATION_NOT_PENDING',
      'This staff access is ' || v_m.status || '. An administrator has to restore it.', 409,
      jsonb_build_object('status', v_m.status));
  end if;

  select u.email, u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = v_uid;

  -- The invitation was sent to a mailbox. Activating before that mailbox is proven
  -- would let an unconfirmed account claim a role it was never sent.
  if v_confirmed is null then
    perform public.app_error('STAFF_EMAIL_NOT_VERIFIED',
      'Confirm your email address before accepting the invitation.', 403);
  end if;

  update public.staff_memberships
     set status       = 'active',
         activated_at = now(),
         updated_at   = now()
   where user_id = v_uid;
  -- staff_sync_is_admin fires on this UPDATE and recomputes profiles.is_admin from
  -- "active super_admin". Nothing to do here: a Super Admin gains the cache flag, an
  -- Operations Admin or Trainer correctly keeps is_admin = false.

  insert into public.staff_role_events
    (actor_user_id, actor_email, target_user_id, target_email,
     action, from_role_key, to_role_key, from_status, to_status, reason, source, metadata)
  values
    (v_uid, v_email, v_uid, v_email,
     'accept', v_m.role_key, v_m.role_key, 'invited', 'active',
     'Invitation accepted by the invitee.', 'staff_invite', '{}'::jsonb);

  return jsonb_build_object(
    'status', 'active', 'role_key', v_m.role_key, 'already_active', false);
end
$fn$;

comment on function public.accept_staff_invitation() is
  '#49: the ONLY path from staff_memberships.status invited → active. Takes NO arguments — the '
  'subject is auth.uid() and the role is the one already on the row — so there is no surface on '
  'which to name another user or choose a role. Locks the row FOR UPDATE (duplicate clicks '
  'serialize), requires auth.users.email_confirmed_at, refuses suspended/revoked rather than '
  'reactivating them, is idempotent when already active, and writes an append-only accept event. '
  'Never reads user metadata: raw_user_meta_data.invited_as is display-only and user-editable.';

revoke all on function public.accept_staff_invitation() from public, anon;
grant execute on function public.accept_staff_invitation() to authenticated;


-- == 5) admin_record_staff_invite() ==========================================
-- staff_memberships has no client write policy and must keep none, so the send
-- outcome is stamped through a guarded function rather than by widening the table.

create or replace function public.admin_record_staff_invite(
  p_user_id    uuid,
  p_status     text,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.has_staff_permission('staff.manage') then
    perform public.app_error('FORBIDDEN', 'Managing staff needs the staff.manage permission.', 403);
  end if;
  if p_status is null or p_status not in ('pending', 'sent', 'failed', 'resent') then
    perform public.app_error('STAFF_ROLE_INVALID',
      'Invitation status must be pending, sent, failed or resent.', 422);
  end if;

  update public.staff_memberships
     set invite_status     = p_status,
         -- Only a real send moves the clock; a failure leaves the previous
         -- successful send time alone so the directory can still show it.
         invite_sent_at    = case when p_status in ('sent', 'resent') then now() else invite_sent_at end,
         -- Truncated and shape-checked: this column is rendered in an admin UI and
         -- must never become a channel for provider prose.
         invite_error_code = case
                               when p_status = 'failed'
                                 then left(regexp_replace(coalesce(p_error_code, 'unknown'), '[^a-zA-Z0-9_]', '_', 'g'), 40)
                               else null
                             end,
         updated_at        = now()
   where user_id = p_user_id;
end
$fn$;

comment on function public.admin_record_staff_invite(uuid, text, text) is
  '#49: stamps the invitation email delivery outcome. staff_memberships has no client write '
  'policy and keeps none — this guarded function is the writer. The error code is regexp-scrubbed '
  'and truncated because it is rendered in Team & Roles; it must never carry provider prose, an '
  'address, or a link.';

revoke all on function public.admin_record_staff_invite(uuid, text, text) from public, anon;
grant execute on function public.admin_record_staff_invite(uuid, text, text) to authenticated;


-- == 5b) set_my_display_name() ===============================================
-- An invitee finishing setup needs to be able to give their own name. profiles
-- has NO user-update RLS policy and must keep none, so this mirrors #24's
-- set_my_avatar() exactly: a SECURITY DEFINER function pinned to auth.uid() that
-- touches ONE column.
--
-- ★ It is a SEPARATE function rather than a p_full_name argument on
--   accept_staff_invitation(), so that function can keep taking no arguments at
--   all. "No arguments" is the property that makes it obviously incapable of
--   naming another user or choosing a role, and it is worth more than saving a
--   round-trip.
--
-- ★ It deliberately does NOT touch email. The account IS the email; letting a
--   user rewrite it here would let someone edit their way into another person's
--   pending invitation.

create or replace function public.set_my_display_name(p_full_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_name text := nullif(btrim(coalesce(p_full_name, '')), '');
begin
  if v_uid is null then
    perform public.app_error('FORBIDDEN', 'Sign in first.', 401);
  end if;
  if v_name is null or length(v_name) > 120 then
    perform public.app_error('STAFF_ROLE_INVALID',
      'A name is required and must be 120 characters or fewer.', 422);
  end if;

  update public.profiles
     set full_name  = v_name,
         updated_at = now()
   where id = v_uid;

  -- Keep the community denormalized copy in step, the same way set_my_avatar()
  -- does — otherwise a new staff member posts under their old name forever.
  -- ★ author_id, NOT user_id. Those tables denormalize the author, and the first
  --   draft of this function said user_id: it parsed, it passed every static test,
  --   and it failed at runtime with 42703 the first time anyone ran it. Only
  --   executing it against the real schema found that.
  update public.community_posts    set author_name = v_name where author_id = v_uid;
  update public.community_comments set author_name = v_name where author_id = v_uid;

  -- ★ Deliberately NO is_approved()/is_enrolled() guard, unlike set_my_avatar().
  --   That guard is right for an avatar, which is public content. This function
  --   exists so an invited staff member can give their name while accepting — and
  --   an invitee is by definition not yet enrolled, so copying the guard would
  --   make it fail for the only person who needs it. Writing your own display name
  --   grants nothing.
end
$fn$;

comment on function public.set_my_display_name(text) is
  '#49: the second sanctioned user-facing profiles write, after set_my_avatar(). Pinned to '
  'auth.uid(), touches full_name only (never email, never is_admin, never plan), and refreshes '
  'the denormalized community author_name. profiles still has no user-update RLS policy.';

revoke all on function public.set_my_display_name(text) from public, anon;
grant execute on function public.set_my_display_name(text) to authenticated;


-- == 6) admin_staff_directory() — surface the delivery state =================
-- ★ DROP + CREATE, not CREATE OR REPLACE: the return TABLE gains columns, and
--   Postgres refuses to change a function's result type in place (42P13). #39 hit
--   exactly this on admin_batch_overview(). The grant must be restated after a
--   DROP, or every caller gets "permission denied for function".

drop function if exists public.admin_staff_directory();

create function public.admin_staff_directory()
returns table (
  user_id uuid, email text, full_name text, avatar_url text,
  role_key text, role_label text, rank integer, status text, display_title text,
  invited_by uuid, invited_by_email text, invited_at timestamptz,
  activated_at timestamptz, suspended_at timestamptz, revoked_at timestamptz,
  suspension_reason text, updated_at timestamptz,
  invite_sent_at timestamptz, invite_status text, invite_error_code text
)
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  select m.user_id, p.email, p.full_name, p.avatar_url,
         m.role_key, r.label, r.rank, m.status, m.display_title,
         m.invited_by, ip.email, m.invited_at,
         m.activated_at, m.suspended_at, m.revoked_at, m.suspension_reason, m.updated_at,
         m.invite_sent_at, m.invite_status, m.invite_error_code
    from public.staff_memberships m
    join public.staff_roles r on r.key = m.role_key
    left join public.profiles p on p.id = m.user_id
    left join public.profiles ip on ip.id = m.invited_by
   where public.has_staff_permission('staff.manage')
   order by r.rank desc, p.full_name nulls last, p.email
$fn$;

revoke all on function public.admin_staff_directory() from public, anon;
grant execute on function public.admin_staff_directory() to authenticated;


-- == 7) Error catalog ========================================================
-- ★ Replaced WHOLESALE, so every pre-existing code has to be re-listed. Dropping
--   one here is invisible until some older feature raises it and the client shows
--   a fallback string — test/staffRolesSql.test.mjs pins the whole list against
--   APP_ERROR_CODES for exactly that reason.

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
    ('STAFF_EMAIL_NOT_VERIFIED',     403, 'The Auth identity has not confirmed the mailbox the invitation was sent to.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-29-staff-invitation-acceptance.sql', null,
  'staff invitation acceptance (#49): #45 shipped an invitation nothing could accept — '
  'staff_memberships allowed status=''invited'', the API wrote it and the directory rendered it, '
  'but no function, trigger or policy ever moved a row out of it. Verified in production: one '
  'operations_admin at invited/activated_at-null whose auth.users row had email_confirmed_at, '
  'last_sign_in_at and a password — they had accepted, signed in, and were shown the student '
  'pricing page. Adds accept_staff_invitation(), which takes NO ARGUMENTS (subject is auth.uid(), '
  'role is the one already on the row, so there is no surface to name another user or pick a '
  'role), locks FOR UPDATE so duplicate clicks serialize, requires auth.users.email_confirmed_at, '
  'refuses suspended/revoked rather than letting an old link restore access, is idempotent when '
  'already active, and writes an append-only accept event. SECURITY: my_staff_context() was '
  'returning is_staff:true and the full permission array for that unaccepted membership — not '
  'exploitable (has_staff_permission() correctly said false and normalizeStaffContext() collapses '
  'non-active to empty) but the one RPC the browser AND api/_lib/staffAuth.js treat as '
  'authoritative was describing an authority the database would refuse; authority fields are now '
  'emitted only for status=''active'', with a separate `membership` object that carries no '
  'permission list so a pending invitation can be rendered without ever being one boolean away '
  'from a live one. Extends the audit CHECKs with accept/invite_resent and source staff_invite, '
  'adds invite_sent_at/invite_status/invite_error_code (a safe code only — the one-time token is '
  'minted, sent and discarded, never stored) written through the guarded '
  'admin_record_staff_invite() so staff_memberships keeps no client write policy, and rebuilds '
  'admin_staff_directory() (DROP+CREATE with a restated GRANT — a return-type change cannot be '
  'done in place). No is_admin trigger work: staff_sync_is_admin already recomputes on UPDATE, so '
  'invited→active flips the cache for a Super Admin and leaves Operations Admin and Trainer false.')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--   -- 1) The acceptance RPC exists, takes nothing, and is not reachable by anon:
--   select p.proname || '(' || pg_get_function_arguments(p.oid) || ')' as sig,
--          has_function_privilege('authenticated', p.oid, 'execute') as authed,
--          has_function_privilege('anon',          p.oid, 'execute') as anon
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'accept_staff_invitation';
--     -- expect accept_staff_invitation()  |  true  |  false
--
--   -- 2) An unaccepted invitation no longer reports permissions. As that user:
--   --    select set_config('request.jwt.claims',
--   --      json_build_object('sub','<their uuid>','role','authenticated')::text, true);
--   --    select public.my_staff_context();
--     -- expect permissions: [], is_staff: false, and membership.status: 'invited'
--
--   -- 3) The membership tables are still not client-writable:
--   select has_table_privilege('authenticated','public.staff_memberships','update') as can_update;
--     -- expect false
--
--   -- 4) The audit vocabulary took:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.staff_memberships'::regclass and conname like '%invite_status%';
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.staff_role_events'::regclass and contype = 'c';
-- ─────────────────────────────────────────────────────────────────────────────
