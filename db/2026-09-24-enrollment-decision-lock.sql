-- ═════════════════════════════════════════════════════════════════════════════
-- #66 — A decided enrollment request stays decided
-- 2026-09-24
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- #48 granted `UPDATE (status, rejection_reason, reviewed_at, reviewed_by, admin_notes,
-- updated_at)` on enrollment_requests to `authenticated`, and enroll_req_staff_update lets
-- every enrollments.review holder — Operations Admins included — update ANY row, so that
-- the Reject button and the admin note could work. Nothing then limited which status a row
-- could move FROM. Both existing BEFORE UPDATE guards fire only on a move TO 'approved':
-- enrollment_self_approval_guard (#48) and enrollment_approval_requires_grant (#60/#63).
--
-- So a reviewer could, through PostgREST:
--
--   approve (admin_finalize_enrollment)
--     →  PATCH status back to 'pending_review'
--     →  approve again
--
-- and the second approval stacked a SECOND paid term onto the student — approve_subscription
-- extends from the current expiry — for one payment. The #60 guard let it through (a
-- subscription already carried the request id), and #58's idempotency key suppressed a second
-- finance collection, so the extra months left no trace in the books and no audit row. That is
-- more than admin_grant_special_extension() allows, which is Super-Admin-only and audited
-- precisely because it creates paid access with no payment behind it (#47, #55). The same
-- door let a stale card overwrite an approval with a rejection, leaving a member with access
-- they paid for under a request that reads "Rejected".
--
-- WHAT
--
--   • enrollment_decision_lock — a BEFORE UPDATE trigger whose WHEN clause matches only a
--     STATUS CHANGE out of a decided state (approved | rejected | expired). It refuses with
--     INVALID_MEMBERSHIP_TRANSITION (409), a code the catalog already has, so
--     app_error_catalog() is NOT restated and no client copy changes.
--   • Super Admin keeps break-glass (the #48 precedent), and so does the table owner in the
--     SQL editor via `set local app.enrollment_admin_override = 'on'` (the #38 idiom). Either
--     way the reopen is written to the append-only enrollment_request_events timeline as
--     'decision_reopened', so it is never silent.
--   ★ A reopen changes the REQUEST ROW ONLY. It does not revoke the member's subscription
--     term, their batch seats, profiles.is_paid or the finance collection — no trigger ties
--     those to the request's status. So re-approving a reopened request grants an ADDITIONAL
--     term, and rejecting one leaves the access it paid for in place. See the break-glass
--     runbook at the end of this file before using either path.
--
-- WHAT DOES NOT CHANGE, and why each is safe:
--   • admin_finalize_enrollment moves pending_review → approved, and already refuses every
--     other source status (#45 body: "only pending_review can be approved").
--   • A reviewer's reject / mark-expired moves pending_review → rejected | expired.
--   • A student's self-expire moves their own overdue pending_review → expired.
--   • Same-status writes — admin_notes, record_enrollment_notification's notify_* columns,
--     admin_correct_enrollment_amount (pending only) — never match the WHEN clause.
--   Every writer in src/, api/ and db/ was checked on 2026-09-24; none moves a decided row.
--
-- LOCKSTEP: this file ↔ bootstrap §53 ↔ test/enrollmentDecisionLockSql.test.mjs ↔
-- test-db/enrollmentDecisionLock.dbtest.mjs ↔ the #66 block in scripts/audit-db.mjs ↔ the
-- 'decision_reopened' label in AdminEnrollments' timeline ↔ doDecline's pending_review filter.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-20-course-lesson-assets.sql') then
    raise exception '#66: run db/2026-09-20-course-lesson-assets.sql (#65) first.';
  end if;
  if to_regprocedure('public.enrollment_self_approval_guard()') is null
     or to_regprocedure('public.enrollment_approval_requires_grant()') is null then
    raise exception '#66: #48 (enrollment_self_approval_guard) and #60 (enrollment_approval_requires_grant) must be applied first.';
  end if;
  if to_regclass('public.enrollment_request_events') is null then
    raise exception '#66: #60 (enrollment_request_events) must be applied first.';
  end if;
  if to_regprocedure('public.app_error(text, text, integer, jsonb)') is null
     or to_regprocedure('public.is_super_admin()') is null then
    raise exception '#66: #35 (app_error) and #45 (is_super_admin) must be applied first.';
  end if;
  if not exists (select 1 from public.app_error_catalog() where code = 'INVALID_MEMBERSHIP_TRANSITION') then
    raise exception '#66: INVALID_MEMBERSHIP_TRANSITION is missing from app_error_catalog().';
  end if;
end
$pre$;


-- == 1) The timeline can record a reopened decision ===========================
-- NOT VALID, then VALIDATE — never a silent skip. #30's idiom dropped a constraint when a
-- legacy row failed it and said so only in a NOTICE the Management API discards (#63). Every
-- existing row satisfies this superset, so the validate cannot fail.
alter table public.enrollment_request_events
  drop constraint if exists enrollment_request_events_action_check;
alter table public.enrollment_request_events
  add constraint enrollment_request_events_action_check
  check (action in ('hold_set', 'hold_updated', 'hold_cleared', 'amount_corrected', 'decision_reopened'))
  not valid;
alter table public.enrollment_request_events
  validate constraint enrollment_request_events_action_check;


-- == 2) The lock ==============================================================
-- ★ The WHEN clause is the whole scope: a status CHANGE out of a decided state. Without it
--   the trigger would run on every admin_notes save and every notify stamp.
-- ★ No `auth.uid() is null` exemption. A Management API session has no JWT, and treating
--   "no caller" as "trusted caller" is how an outage or a misconfigured job becomes a
--   privilege. The owner's path is the explicit, audited override below.
-- ★ The override is gated on OWNERSHIP of enrollment_requests, not rolsuper — Supabase's
--   `postgres` is not a superuser (#38). PostgREST connects as `authenticator`, which is not
--   a member of the owner, so no API caller can reach it.
create or replace function public.enrollment_decision_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor    uuid := auth.uid();
  v_override boolean;
begin
  v_override := coalesce(current_setting('app.enrollment_admin_override', true), '') = 'on'
                and pg_has_role(session_user,
                                (select c.relowner from pg_class c
                                   join pg_namespace n on n.oid = c.relnamespace
                                  where n.nspname = 'public' and c.relname = 'enrollment_requests'),
                                'member');

  if not (v_override or public.is_super_admin()) then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      format('This request was already %s, so it cannot be reopened or decided again. '
             'The student can submit a new request; ask a Super Admin if it was decided in error.', old.status),
      409, jsonb_build_object('request_id', old.id, 'status', old.status, 'attempted', new.status));
  end if;

  insert into public.enrollment_request_events (request_id, actor_user_id, actor_email, action, detail)
  values (old.id, v_actor,
          (select p.email from public.profiles p where p.id = v_actor),
          'decision_reopened',
          jsonb_build_object('from', old.status, 'to', new.status,
                             'via', case when v_override then 'owner_override' else 'super_admin' end));
  return new;
end;
$fn$;

revoke all on function public.enrollment_decision_lock() from public, anon, authenticated;

drop trigger if exists enrollment_decision_lock on public.enrollment_requests;
create trigger enrollment_decision_lock
  before update on public.enrollment_requests
  for each row
  when (old.status in ('approved', 'rejected', 'expired') and new.status is distinct from old.status)
  execute function public.enrollment_decision_lock();

comment on function public.enrollment_decision_lock() is
  '#66: a decided enrollment request (approved | rejected | expired) cannot change status '
  'except by a Super Admin or the table owner''s explicit app.enrollment_admin_override; '
  'every permitted reopen is logged to enrollment_request_events as decision_reopened.';


insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-24-enrollment-decision-lock.sql', null,
  'enrollment decision lock (#66): a BEFORE UPDATE trigger, scoped by WHEN to a status change '
  'out of approved | rejected | expired, refuses with INVALID_MEMBERSHIP_TRANSITION unless the '
  'caller is a Super Admin or the table owner sets app.enrollment_admin_override. Closes the '
  'reopen-and-approve-again path by which an enrollments.review holder (#48 column grant) could '
  'stack a second paid term on one payment with no finance entry and no audit row. Permitted '
  'reopens are logged as enrollment_request_events.action = decision_reopened (CHECK widened, '
  'NOT VALID then validated). No catalog restatement (119 codes), no permission changes '
  '(22 permissions / 35 grants), no client API change.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The lock is armed, scoped, and reachable only as a trigger:
--      select tgname, pg_get_triggerdef(t.oid) like '%WHEN%old.status%' as scoped
--        from pg_trigger t where tgrelid = 'public.enrollment_requests'::regclass
--         and tgname = 'enrollment_decision_lock';                               -> 1 row, t
--      select has_function_privilege('authenticated', 'public.enrollment_decision_lock()', 'execute');  -> f
--
-- 2) The timeline accepts the new action and the constraint is VALID:
--      select convalidated from pg_constraint where conname = 'enrollment_request_events_action_check';  -> t
--
-- 3) Nothing moved:
--      select count(*) from public.staff_permissions;       -> 22
--      select count(*) from public.staff_role_permissions;  -> 35
--      select count(*) from public.app_error_catalog();      -> 119
--
-- 4) In the app, as an Operations Admin: approving, rejecting and marking an overdue request
--    expired all still work; editing a decided request's admin note still saves.
--
-- BREAK-GLASS (SQL editor / table-owner session only) — reopen a request decided in error:
--   begin;
--     set local app.enrollment_admin_override = 'on';
--     update public.enrollment_requests set status = 'pending_review', updated_at = now()
--      where id = '<request id>';
--   commit;
--   The timeline records it as decision_reopened, via owner_override.
--
--   ★ THE REOPEN IS ONLY THE FIRST STEP. It moves the request row and nothing else:
--     • Re-APPROVING it runs approve_subscription / approve_extension again, which STACKS a
--       second term from the current expiry. If the first approval should not have
--       happened, supersede or shorten that term first — never approve twice to "fix" it.
--     • REJECTING or EXPIRING it leaves the member's current term, batch seats, is_paid and
--       the posted collection exactly as they were. Revoke or adjust the access separately,
--       and reverse the collection in Financial Management (a reversal, not a delete).
--   Decide what the member should end up with first; the request status is the last thing
--   to change, not the lever that changes it.
