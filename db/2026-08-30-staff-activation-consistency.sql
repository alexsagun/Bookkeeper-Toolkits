-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-30-staff-activation-consistency.sql  (#50)
-- ─────────────────────────────────────────────────────────────────────────────
-- An active staff member must not still be a pending STUDENT.
--
-- #49 gave the invitation an acceptance path, and that path was correct as far as
-- it went: accept_staff_invitation() writes status, activated_at, updated_at, and
-- staff_sync_is_admin recomputes profiles.is_admin. But a brand-new invitee's Auth
-- row is created by generateLink(), which fires on_auth_user_created →
-- handle_new_user(), which inserts (id, email, full_name, avatar_url) and lets the
-- column DEFAULT apply — approval_status = 'pending'.
--
-- Nothing ever cleared it. So every accepted Operations Admin and Trainer sat at
-- approval_status='pending' FOREVER, which meant:
--
--   * they appeared in the student Access Requests queue, indistinguishable from
--     a signup awaiting approval;
--   * they inflated the amber pending badge by one, permanently;
--   * and — because access_requests.review is a permission an Operations Admin
--     HOLDS — the first thing a newly hired Ops Admin saw in the queue they had
--     just been given was their own name, with an Approve button next to it.
--
-- The client hid the consequence: gateScreen.js's legacy approval arm carries a
-- `!staffPasses` conjunct, so an active staff member is never held on
-- PendingApprovalScreen. That is a RENDERING decision. The row stayed pending, and
-- every query that counts pending rows kept counting it.
--
-- WHAT THIS FILE DOES
--   1. staff_sync_is_admin() also approves a PENDING profile that has an active
--      membership. Same trigger, same transaction as the acceptance itself.
--   2. A backfill for the staff who are already active and still pending.
--   3. accept_staff_invitation() refuses a REJECTED profile — the ban, enforced in
--      the database as well as in the gate.
--   4. staff_invitation_state(), the durable fact the invitation screen needs and
--      could not previously ask for: does this account have a password yet?
--   5. The Access Requests queue and a new matching count RPC both exclude
--      invited and active staff.
--   6. admin_review_access_request() refuses self-review.
--
-- ★ WHAT THIS FILE DELIBERATELY DOES NOT DO
--   It never touches a 'rejected' profile. A staff grant must not be able to
--   launder a ban: if a banned account is genuinely being hired, lifting the ban
--   is the deliberate act that comes first. And it never un-approves anyone on
--   revoke — someone who has been approved has been approved, and quietly
--   reversing that would lock a real person out of a product they may have paid
--   for.
--
-- ★ AND IT DOES NOT SET is_admin FOR ANYBODY. profiles.is_admin still means, and
--   only means, "has an ACTIVE super_admin membership". Approving a profile is
--   about the STUDENT gate; it grants no staff authority whatsoever.
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
  if to_regprocedure('public.accept_staff_invitation()') is null then
    raise exception 'Run db/2026-08-29-staff-invitation-acceptance.sql (#49) first — this file replaces accept_staff_invitation().';
  end if;
  if to_regprocedure('public.admin_access_request_queue(text, integer)') is null then
    raise exception 'Run db/2026-08-25-staff-authorization.sql (#45) first — this file replaces admin_access_request_queue().';
  end if;
end
$pre$;


-- == 1) The profile-approval invariant, on the trigger that already exists ===
-- ★ WHY THIS TRIGGER AND NOT A NEW ONE. staff_sync_is_admin already fires AFTER
--   INSERT OR UPDATE OR DELETE on staff_memberships, which is precisely the set of
--   events that can change the answer to "does this account have an active staff
--   membership". Acceptance, promotion from an existing account, reactivation
--   after a suspension, and a direct admin_upsert_staff_membership all route
--   through it. A second trigger would duplicate that set, race this one for the
--   same row, and give a future reader two places to look.
--
--   `create or replace function` keeps the existing trigger binding, so nothing is
--   dropped and there is no window in which the sync is absent.
--
-- ★ THE UPDATE IS NARROWED TO approval_status = 'pending' ON PURPOSE. That single
--   predicate is what makes this safe in both directions: a 'rejected' row is left
--   exactly as it is (a ban is not laundered by a job offer), and an 'approved' row
--   is never rewritten, so revoking a role cannot silently un-approve a person.

create or replace function public.staff_sync_is_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user   uuid := coalesce(new.user_id, old.user_id);
  v_active boolean;
begin
  v_active := exists (
    select 1 from public.staff_memberships m
     where m.user_id = v_user
       and m.status = 'active'
       and m.role_key = 'super_admin'
  );

  update public.profiles p
     set is_admin = v_active,
         updated_at = now()
   where p.id = v_user;

  -- #50: an active staff member is not a student awaiting approval.
  -- Scoped to 'pending' so a ban survives and an approval is never reversed.
  update public.profiles p
     set approval_status = 'approved',
         approved_at = now(),
         approved_by = coalesce(p.approved_by, (
           select m.invited_by from public.staff_memberships m where m.user_id = v_user
         )),
         rejection_reason = null,
         updated_at = now()
   where p.id = v_user
     and p.approval_status = 'pending'
     and exists (
       select 1 from public.staff_memberships m
        where m.user_id = v_user and m.status = 'active'
     );

  return coalesce(new, old);
end;
$fn$;

comment on function public.staff_sync_is_admin() is
  '#45/#50: keeps profiles.is_admin equal to "has an ACTIVE super_admin membership", and since '
  '#50 also clears the student approval gate for anyone holding an ACTIVE membership of any '
  'role. is_admin is a CACHE, not an input — ~74 policies and ~20 direct column reads depend on '
  'it meaning exactly that, and this trigger is its only writer because UPDATE on profiles is '
  'revoked from every client role. The approval half is scoped to approval_status = ''pending'': '
  'a ''rejected'' profile is never touched (a staff grant must not launder a ban) and an '
  '''approved'' one is never rewritten (revoking a role must not un-approve a person).';

revoke all on function public.staff_sync_is_admin() from public, anon, authenticated;

-- Re-assert the binding. A no-op when it already exists, and it means this file
-- stands alone on a database where the trigger was somehow dropped.
drop trigger if exists staff_sync_is_admin on public.staff_memberships;
create trigger staff_sync_is_admin
  after insert or update or delete on public.staff_memberships
  for each row execute function public.staff_sync_is_admin();


-- == 2) Backfill the staff who are already active and still pending ==========
-- Idempotent by its own WHERE clause: the second run matches zero rows. Written as
-- a plain UPDATE rather than a trigger-firing touch so it cannot recurse.

update public.profiles p
   set approval_status = 'approved',
       approved_at = coalesce(p.approved_at, now()),
       approved_by = coalesce(p.approved_by, (
         select m.invited_by from public.staff_memberships m where m.user_id = p.id
       )),
       rejection_reason = null,
       updated_at = now()
 where p.approval_status = 'pending'
   and exists (
     select 1 from public.staff_memberships m
      where m.user_id = p.id and m.status = 'active'
   );


-- == 3) accept_staff_invitation() — the ban, enforced in the database ========
-- #49's body verbatim, with ONE addition: a rejected profile cannot accept.
--
-- ★ WHY IT IS WORTH ADDING HERE AS WELL AS IN THE GATE. resolveGateScreen() puts
--   the ban above the invitation, and #50 keeps the invitation screen mounted
--   through the profile load so a redeemed token is not thrown away. That second
--   change means the screen is now on-screen for a moment BEFORE the profile (and
--   therefore the ban) is known. The component blocks every action until
--   profileReady, but "the client will not call it" is a weaker statement than
--   "the database will not do it", and this is a write the UI cannot undo.

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
  v_approval  text;
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

  -- #50: a banned account cannot accept its way back in.
  select p.approval_status into v_approval from public.profiles p where p.id = v_uid;
  if v_approval = 'rejected' then
    perform public.app_error('STAFF_ACCOUNT_REJECTED',
      'This account has been blocked from the platform, so a staff invitation cannot be '
      'accepted on it. The block has to be lifted first.', 403);
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
  -- Since #50 the same trigger also clears a 'pending' approval_status, so this
  -- person stops being a student awaiting approval in the SAME transaction that
  -- makes them staff. There is no window in which they are both.

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
  '#49/#50: the ONLY path from staff_memberships.status invited → active. Takes NO arguments — '
  'the subject is auth.uid() and the role is the one already on the row — so there is no surface '
  'on which to name another user or choose a role. Locks the row FOR UPDATE (duplicate clicks '
  'serialize), requires auth.users.email_confirmed_at, refuses suspended/revoked rather than '
  'reactivating them, refuses a rejected profile (#50 — the ban, enforced in the database and '
  'not only in the gate), is idempotent when already active, and writes an append-only accept '
  'event. Never reads user metadata: raw_user_meta_data.invited_as is display-only and '
  'user-editable.';

revoke all on function public.accept_staff_invitation() from public, anon;
grant execute on function public.accept_staff_invitation() to authenticated;


-- == 4) staff_invitation_state() — the durable fact the screen was missing ===
-- ★ THE BUG THIS EXISTS FOR. #49 decided whether to require a password from
--   `const needsPassword = exchanged` — a component-local useState. Any unmount or
--   refresh reset it to false, and the password field became OPTIONAL for the one
--   person who does not have one. A brand-new invitee could reach 'active' having
--   never chosen a credential.
--
--   "Has this account got a password?" is a fact about auth.users that no client
--   can read, so the client had nothing durable to ask. Now it has.
--
-- ★ WHY NOT EXTEND my_staff_context(). That function is called on every session by
--   both the browser and api/_lib/staffAuth.js; adding an auth.users read to it
--   taxes every request in the product for a fact exactly one screen needs. Its
--   shape is also pinned by test/staffInviteSql.test.mjs, and the `membership`
--   object there is deliberately built to carry no authority. This is a separate,
--   narrower question with a separate, narrower answer.
--
-- Self-scoped to auth.uid(), like accept_staff_invitation(): it takes no arguments,
-- so it cannot be asked about anybody else.

create or replace function public.staff_invitation_state()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when (select auth.uid()) is null then jsonb_build_object('exists', false)
    else coalesce(
      (
        select jsonb_build_object(
          'exists',          true,
          'status',          m.status,
          'role_key',        m.role_key,
          'role_label',      r.label,
          'display_title',   m.display_title,
          'invited_at',      m.invited_at,
          'email_confirmed', (u.email_confirmed_at is not null),
          -- An OAuth-only identity has no password row; GoTrue stores either NULL
          -- or an empty string, so both have to read as "no password yet".
          'has_password',    (coalesce(u.encrypted_password, '') <> '')
        )
        from public.staff_memberships m
        join public.staff_roles r on r.key = m.role_key
        join auth.users u on u.id = m.user_id
       where m.user_id = (select auth.uid())
      ),
      jsonb_build_object('exists', false)
    )
  end
$fn$;

comment on function public.staff_invitation_state() is
  '#50: the DURABLE facts the staff invitation screen renders from — membership status, role, '
  'whether the mailbox is confirmed, and whether this account has a password yet. Exists because '
  '#49 derived "does this person need to set a password" from a component-local useState that '
  'every unmount and every page refresh reset to false, which made the password field optional '
  'for a brand-new invitee. Takes no arguments and reads auth.uid() only, so it describes the '
  'caller and nobody else. Carries NO permissions and NO authority of any kind — my_staff_context() '
  'remains the only source of those, and this function is safe to call before anything is known '
  'about the caller precisely because there is nothing in it to leak.';

revoke all on function public.staff_invitation_state() from public, anon;
grant execute on function public.staff_invitation_state() to authenticated;


-- == 5) Access Requests: staff are not students awaiting approval ============
-- #45's body verbatim, plus the staff exclusion.
--
-- ★ 'invited' AND 'active' ARE EXCLUDED; 'suspended' AND 'revoked' ARE NOT. A
--   former staff member may well be a genuine student whose signup still needs a
--   decision, and hiding them would be the same class of bug in the other
--   direction. The queue must not lose a real student.

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
   order by p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 500), 1000))
$fn$;

comment on function public.admin_access_request_queue(text, integer) is
  '#45/#50: the Access Requests queue, gated on access_requests.review. Exists because '
  'profiles_admin_select alone left an Operations Admin able to DECIDE on a signup they could '
  'not DISCOVER. SECURITY DEFINER so it can read other people''s profiles, permission test in the '
  'WHERE clause so a caller without it gets zero rows rather than an error. Since #50 it excludes '
  'anyone holding an invited or active staff membership: staff are not students awaiting payment '
  'approval, and before this an accepted Operations Admin found their OWN row in the queue they '
  'had just been given permission to work. suspended and revoked are deliberately NOT excluded — '
  'a former staff member may be a real student whose signup still needs a decision.';

revoke all on function public.admin_access_request_queue(text, integer) from public, anon;
grant execute on function public.admin_access_request_queue(text, integer) to authenticated;


-- == 6) The badge count, on the same predicate as the queue ==================
-- ★ THE BADGE AND THE LIST DISAGREED, AND NOT ONLY ABOUT STAFF. The sidebar count
--   was a direct `profiles` head-count filtered by the profiles_admin_select RLS
--   policy, while the list is an RPC gated on has_staff_permission(). Two
--   different authorization paths answering one question is a divergence waiting
--   to happen — profiles_admin_select also admits enrollments.review, which the
--   queue does not. One function now answers both.

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
$fn$;

comment on function public.admin_access_request_pending_count() is
  '#50: the pending count behind the Access Requests sidebar badge. Shares its predicate AND its '
  'permission gate with admin_access_request_queue(), replacing a direct profiles head-count that '
  'was filtered by profiles_admin_select instead — a different authorization path answering the '
  'same question, which is how the badge came to count staff the list would not show. Returns 0 '
  'rather than an error for a caller without the permission.';

revoke all on function public.admin_access_request_pending_count() from public, anon;
grant execute on function public.admin_access_request_pending_count() to authenticated;


-- == 7) No reviewing your own access request =================================
-- #45's body verbatim, plus the self-review refusal.
--
-- Mirrors #48's enrollment_self_approval_guard(), including its Super Admin
-- exemption: a Super Admin already passes is_approved() structurally through
-- is_admin, so the exemption changes nothing they could not already do, and it
-- keeps one lockout escape hatch open.
--
-- ★ THIS FUNCTION CANNOT MINT STAFF PRIVILEGES AND MUST NOT LEARN HOW. It writes
--   approval_status and the four decision columns, nothing else. is_admin is not
--   in its UPDATE list, UPDATE on profiles is revoked from every client role, and
--   staff_memberships has no client write policy at all — so the student-approval
--   path is structurally incapable of granting a role. Do not add columns here.

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

  -- #50: segregation of duties. Deciding on your own signup is not a review.
  if p_user_id = (select auth.uid()) and not public.is_super_admin() then
    perform public.app_error('ACCESS_REQUEST_SELF_REVIEW',
      'You cannot decide on your own access request — ask a Super Admin to review it.', 403,
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

comment on function public.admin_review_access_request(uuid, text, text) is
  '#45/#50: replaces the AccessRequests screen''s direct UPDATE on profiles, which relied on '
  'profiles_admin_update — the policy #45 drops. Gated on access_requests.review, so an '
  'Operations Admin can work the queue without holding any other admin power. Since #50 it '
  'refuses a self-review, mirroring #48''s enrollment_self_approval_guard() including its Super '
  'Admin exemption. It writes approval_status and the four decision columns and NOTHING else — '
  'the student-approval path is structurally incapable of granting staff privileges, and must '
  'stay that way.';

revoke all on function public.admin_review_access_request(uuid, text, text) from public, anon;
grant execute on function public.admin_review_access_request(uuid, text, text) to authenticated;


-- == 7b) admin_record_staff_invite() — write the resend to the LEDGER too =====
-- #49 added 'invite_resent' to the staff_role_events action CHECK for exactly
-- this purpose and then nothing ever wrote it: a resent invitation only stamped
-- staff_memberships.invite_status, so the append-only ledger had no record that
-- a second one-time credential was ever issued. #49's body verbatim, plus the
-- audit insert on 'resent'.

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
declare
  v_m public.staff_memberships%rowtype;
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
   where user_id = p_user_id
  returning * into v_m;

  -- #50: a resend issues a NEW one-time credential, and issuing a credential is
  -- an auditable act. The row carries the actor and the target — never the link.
  if p_status = 'resent' and v_m.user_id is not null then
    insert into public.staff_role_events
      (actor_user_id, actor_email, target_user_id, target_email,
       action, from_role_key, to_role_key, from_status, to_status, reason, source, metadata)
    values
      ((select auth.uid()),
       (select u.email from auth.users u where u.id = (select auth.uid())),
       v_m.user_id,
       (select u.email from auth.users u where u.id = v_m.user_id),
       'invite_resent', v_m.role_key, v_m.role_key, v_m.status, v_m.status,
       'Invitation email resent.', 'staff_invite', '{}'::jsonb);
  end if;
end
$fn$;

comment on function public.admin_record_staff_invite(uuid, text, text) is
  '#49/#50: stamps the invitation email delivery outcome. staff_memberships has no client write '
  'policy and keeps none — this guarded function is the writer. The error code is regexp-scrubbed '
  'and truncated because it is rendered in Team & Roles; it must never carry provider prose, an '
  'address, or a link. Since #50 a ''resent'' outcome also writes the invite_resent ledger row '
  'that #49 declared in the action CHECK and never produced — issuing a fresh one-time credential '
  'is an auditable act. The row records who resent to whom; the link itself is never stored.';

revoke all on function public.admin_record_staff_invite(uuid, text, text) from public, anon;
grant execute on function public.admin_record_staff_invite(uuid, text, text) to authenticated;


-- == 8) Error catalog ========================================================
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
    ('STAFF_EMAIL_NOT_VERIFIED',     403, 'The Auth identity has not confirmed the mailbox the invitation was sent to.'),
    ('STAFF_ACCOUNT_REJECTED',       403, 'The account is blocked from the platform, so a staff invitation cannot be accepted on it.'),
    ('ACCESS_REQUEST_SELF_REVIEW',   403, 'A reviewer cannot decide on their own access request.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-30-staff-activation-consistency.sql', null,
  'staff activation consistency (#50): an active staff member must not still be a pending '
  'STUDENT. A brand-new invitee''s Auth row is created by generateLink(), so handle_new_user() '
  'gives them approval_status=''pending'' by column DEFAULT, and nothing ever cleared it — every '
  'accepted Operations Admin and Trainer stayed pending forever, appeared in the student Access '
  'Requests queue, inflated the amber badge, and (because access_requests.review is a permission '
  'Ops Admins HOLD) found their own row in the queue they had just been given, with an Approve '
  'button next to it. The client only hid it: gateScreen.js''s approval arm carries a '
  '!staffPasses conjunct, so the row stayed pending while every count kept counting it. '
  'staff_sync_is_admin() — already firing on exactly the events that change "has an active '
  'membership" — now also approves a PENDING profile in the same transaction as the acceptance; '
  'scoped to ''pending'' so a ''rejected'' ban is never laundered by a job offer and an '
  '''approved'' row is never reversed by a revoke. Plus an idempotent backfill; a rejected-profile '
  'refusal inside accept_staff_invitation() (the ban enforced in the database, not only in the '
  'gate, now that the invitation screen stays mounted through the profile load); '
  'staff_invitation_state(), the durable "does this account have a password yet" the screen '
  'needed — #49 derived that from a component-local useState that every refresh reset to false, '
  'making the password OPTIONAL for the one person who does not have one; a staff exclusion on '
  'admin_access_request_queue() (invited+active only — suspended and revoked may be real '
  'students); admin_access_request_pending_count(), so the badge stops using a different '
  'authorization path from the list; a self-review refusal on admin_review_access_request(), '
  'mirroring #48''s enrollment_self_approval_guard() including its Super Admin exemption; and '
  'admin_record_staff_invite() now writes the invite_resent ledger row #49 declared in the action '
  'CHECK and never produced — issuing a fresh one-time credential is an auditable act. '
  'profiles.is_admin still means, and only means, "has an ACTIVE super_admin membership".')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- 1) No active staff member is still a pending student:
--      select count(*) from public.profiles p
--       where p.approval_status = 'pending'
--         and exists (select 1 from public.staff_memberships m
--                      where m.user_id = p.id and m.status = 'active');
--    → 0
--
-- 2) The new functions exist and are reachable by `authenticated`, not by `anon`:
--      select p.proname,
--             has_function_privilege('authenticated', p.oid, 'execute') as authed,
--             has_function_privilege('anon',          p.oid, 'execute') as anon
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and p.proname in ('staff_invitation_state', 'admin_access_request_pending_count');
--    → authed = true, anon = false for both
--
-- 3) The queue and the count agree, and neither shows staff:
--      select (select count(*) from public.admin_access_request_queue('pending', 1000))
--           = (select public.admin_access_request_pending_count()) as agree;
--    → true   (run as a caller holding access_requests.review)
--
-- 4) The two new codes are in the catalog:
--      select code from public.app_error_catalog()
--       where code in ('STAFF_ACCOUNT_REJECTED', 'ACCESS_REQUEST_SELF_REVIEW');
--    → 2 rows
