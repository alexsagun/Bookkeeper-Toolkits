-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-31-access-request-staff-target.sql  (#51)
-- ─────────────────────────────────────────────────────────────────────────────
-- The student access-request DECIDER must refuse the same accounts its QUEUE hides.
--
-- #50 excluded invited and active staff from admin_access_request_queue() and
-- admin_access_request_pending_count(), and added a self-review guard to
-- admin_review_access_request(). It did not narrow WHO that decider may be pointed
-- at, so the read side and the write side of one workflow ended up disagreeing:
-- the list says staff are not students awaiting a decision, while the decider will
-- happily reject one.
--
-- ★ WHY THAT IS WORTH ITS OWN MIGRATION, AND WHY #50 MADE IT SHARPER.
--   admin_review_access_request() is granted to `authenticated` and gated only on
--   access_requests.review — a permission OPERATIONS ADMINS HOLD. The queue hiding
--   staff rows is a UI fact, not a boundary: a direct PostgREST call takes any
--   uuid. So one Operations Admin could set approval_status='rejected' on a peer
--   Trainer, another Operations Admin, or a Super Admin's not-yet-accepted
--   invitee. The result is a banned-but-authorized half-state:
--
--     * resolveGateScreen()'s ban arm pins the target on RejectedScreen, and it
--       deliberately does not consult staff status;
--     * public.is_approved() turns false, so every is_approved()-gated content and
--       community read dies for them;
--     * my_staff_context() still reports their live permissions to API callers;
--     * #50's own staff_sync_is_admin() repair CANNOT undo it, because that half is
--       scoped strictly to approval_status = 'pending' (deliberately — a staff
--       grant must not launder a ban);
--     * and since #50, accept_staff_invitation() refuses a rejected profile
--       outright (STAFF_ACCOUNT_REJECTED), so a junior role could also veto a
--       Super Admin hire by rejecting the invitee before they accept.
--
--   Nothing surfaces any of it, because the queue hides staff rows.
--
-- ★ THE RULE, AND WHY IT HAS NO SUPER-ADMIN EXEMPTION.
--   This is not a segregation-of-duties question like #50's self-review guard (a
--   Super Admin is exempt there because they pass is_approved() structurally, so
--   the exemption grants nothing they did not already have). This is a question of
--   using the WRONG TOOL: the student approval path is not how staff access is
--   withdrawn. `admin_set_staff_status(user, 'revoked'|'suspended', reason)` is,
--   and it writes an audit row. Once a membership is suspended or revoked the
--   account becomes reviewable here again, exactly as #50's queue already allows —
--   so nobody loses a capability, they are pointed at the function that records
--   what they did.
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
  -- This file replaces #50's body; running it first would drop that file's
  -- self-review guard and its ACCESS_REQUEST_SELF_REVIEW code.
  if not exists (
    select 1 from public.app_error_catalog() where code = 'ACCESS_REQUEST_SELF_REVIEW'
  ) then
    raise exception 'Run db/2026-08-30-staff-activation-consistency.sql (#50) first — this file extends its guard.';
  end if;
end
$pre$;


-- == 1) admin_review_access_request(): staff are not reviewable as students ===
-- #50's body verbatim, plus the staff-target refusal.

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
  '#45/#50/#51: replaces the AccessRequests screen''s direct UPDATE on profiles, which relied on '
  'profiles_admin_update — the policy #45 drops. Gated on access_requests.review, so an '
  'Operations Admin can work the queue without holding any other admin power. #50 added the '
  'self-review refusal (Super Admin exempt, mirroring #48''s enrollment_self_approval_guard). '
  '#51 refuses a target holding an invited or active staff membership — the same predicate the '
  'queue and the badge count use — because the decider must not accept what the list hides: an '
  'Operations Admin could otherwise reject a peer Trainer or an unaccepted invitee by direct '
  'PostgREST call, producing a banned-but-authorized account that staff_sync_is_admin() cannot '
  'repair (its approval half is scoped to ''pending'' so a ban is never laundered). Withdrawing '
  'staff access is admin_set_staff_status(), which writes an audit row. It writes '
  'approval_status and the four decision columns and NOTHING else — the student-approval path is '
  'structurally incapable of granting staff privileges, and must stay that way.';

revoke all on function public.admin_review_access_request(uuid, text, text) from public, anon;
grant execute on function public.admin_review_access_request(uuid, text, text) to authenticated;


-- == 2) Error catalog ========================================================
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
    ('ACCESS_REQUEST_SELF_REVIEW',   403, 'A reviewer cannot decide on their own access request.'),
    ('ACCESS_REQUEST_STAFF_TARGET',  409, 'The target holds an invited or active staff membership; withdraw staff access through Team & Roles instead.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-31-access-request-staff-target.sql', null,
  'access-request staff target (#51): the student access-request DECIDER now refuses exactly the '
  'accounts its QUEUE hides. #50 excluded invited+active staff from admin_access_request_queue() '
  'and admin_access_request_pending_count() and added a self-review guard, but did not narrow who '
  'admin_review_access_request() may be pointed at — and that function is granted to '
  '`authenticated` and gated only on access_requests.review, a permission Operations Admins hold. '
  'The queue hiding staff rows is a UI fact, not a boundary: a direct PostgREST call takes any '
  'uuid, so one Ops Admin could set approval_status=''rejected'' on a peer Trainer, another Ops '
  'Admin, or a Super Admin''s unaccepted invitee. That produces a banned-but-authorized '
  'half-state: the gate''s ban arm pins them on RejectedScreen (it deliberately does not consult '
  'staff status), is_approved() turns false so every gated content and community read dies, '
  'my_staff_context() still reports their live permissions, and #50''s staff_sync_is_admin() '
  'repair cannot undo it because its approval half is scoped strictly to ''pending'' so a ban is '
  'never laundered. Since #50 it could also veto a hire outright, because '
  'accept_staff_invitation() refuses a rejected profile (STAFF_ACCOUNT_REJECTED). No Super Admin '
  'exemption here, unlike the self-review guard: this is not segregation of duties but the wrong '
  'tool — withdrawing staff access is admin_set_staff_status(), which writes an audit row, and a '
  'suspended or revoked account becomes reviewable here again, so nobody loses a capability. '
  'Adds ACCESS_REQUEST_STAFF_TARGET (409).')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- 1) The decider refuses a staff target (run as a reviewer, expect 409/
--    ACCESS_REQUEST_STAFF_TARGET):
--      select public.admin_review_access_request(
--        (select user_id from public.staff_memberships where status='active' limit 1),
--        'rejected', 'should be refused');
--
-- 2) The new code is in the catalog:
--      select code from public.app_error_catalog() where code = 'ACCESS_REQUEST_STAFF_TARGET';
--    → 1 row
--
-- 3) Nothing else about the decider changed — a real student is still reviewable:
--      select count(*) from public.admin_access_request_queue('pending', 1000);
--    → unchanged from before this file
