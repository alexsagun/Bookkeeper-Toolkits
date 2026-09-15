-- ═════════════════════════════════════════════════════════════════════════════
-- #60 — Enrollment management: holds, amount correction, an audit timeline, and
--       an approval that can only happen with its membership grant
-- 2026-09-15
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- The legacy Apps Script "Enrollment Management" screen let an operator put a request
-- on hold, fix a mistyped amount and see who did what. The Toolkit's Enrollments tab
-- had none of it, so a request waiting on a package or a follow-up call looked
-- identical to a forgotten one, and a mistyped amount could only be fixed in SQL — or
-- approved as typed, which since #58 posts that wrong amount to the ledger.
--
-- WHAT IT ADDS
--
--   * `enrollment_request_holds` — a STAFF-ONLY side table (reason, follow-up date).
--     ★ Not columns on enrollment_requests: students can SELECT their own request
--       rows (enroll_req_own_select), and a hold reason is an internal note.
--     ★ `expires_at` is NOT touched. "Overdue" stays derived: pending, past
--       expires_at, and not on hold.
--   * `enrollment_request_events` — append-only audit of holds and corrections.
--   * `admin_set_enrollment_hold` / `admin_clear_enrollment_hold`,
--     `admin_correct_enrollment_amount` (pending requests only, so the approval hook
--     posts the corrected figure), `admin_enrollment_queue_counts`, and
--     `admin_staff_display_names` (names of STAFF only — never a student's).
--   * `enrollment_approval_requires_grant` — see below.
--   * A trigger that releases a hold when its request is decided.
--
-- ★ AN APPROVAL WITHOUT ITS GRANT IS NOW REFUSED. #48 lets an enrollments.review
--   holder UPDATE `status` on another student's request (the column grant exists for the
--   reject path). Nothing stopped that same UPDATE from setting status = 'approved'
--   directly, skipping admin_finalize_enrollment: the request read "approved", no
--   membership was granted, and — since #58 — the approval hook booked the payment as
--   collected. Not a privilege escalation (the reviewer could approve through the RPC),
--   but a corruption of both access and the books. admin_finalize_enrollment grants the
--   term BEFORE it marks the request approved, and both grant paths stamp
--   subscriptions.request_id; the one exception is approve_extension's early return for
--   a grandfathered member whose term never expires. So the guard asks exactly that, and
--   admin_finalize_enrollment is NOT retyped (the #33/#34 lesson). Super Admin keeps the
--   break-glass path.
--
-- SAFETY / ORDERING
--   * Tables are created -> RLS enabled -> grants revoked in adjacent statements.
--   * Every table has exactly ONE policy, a SELECT gated on enrollments.review; all
--     writes go through SECURITY DEFINER RPCs whose first statement is that check.
--   * No staff permission changes: Operations Admins keep this screen.
--
-- LOCKSTEP
--   this file <-> bootstrap fold §47 <-> APP_ERROR_CODES + APP_ERROR_COPY <->
--   test/enrollmentManagementSql.test.mjs <-> test/communityStaffSql.test.mjs
--   (CURRENT_CATALOG_MIGRATION) <-> scripts/audit-db.mjs (#60 block).
-- ═════════════════════════════════════════════════════════════════════════════


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-14-finance-parity.sql') then
    raise exception '#60: run db/2026-09-14-finance-parity.sql (#59) first — it owns the error catalog this file restates.';
  end if;
  if to_regprocedure('public.has_staff_permission(text)') is null
     or to_regprocedure('public.is_super_admin()') is null then
    raise exception '#60: the #45 permission helpers are missing.';
  end if;
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'enrollment_requests' and t.tgname = 'enrollment_self_approval_guard'
                    and not t.tgisinternal) then
    raise exception '#60: run db/2026-08-28-authorization-hardening.sql (#48) first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'request_id') then
    raise exception '#60: subscriptions.request_id is required — the approval guard reads it.';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_finalize_enrollment') <> 1 then
    raise exception '#60: expected exactly one admin_finalize_enrollment.';
  end if;
end
$pre$;


-- == 1) Tables ================================================================

create table if not exists public.enrollment_request_holds (
  request_id     uuid primary key references public.enrollment_requests(id) on delete cascade,
  reason         text not null,
  constraint enrollment_request_holds_reason_present check (nullif(btrim(reason), '') is not null),
  follow_up_on   date,
  held_at        timestamptz not null default now(),
  held_by        uuid references auth.users(id) on delete set null,
  held_by_email  text,
  updated_at     timestamptz not null default now()
);
alter table public.enrollment_request_holds enable row level security;
revoke all on table public.enrollment_request_holds from public, anon, authenticated;
create index if not exists enrollment_request_holds_follow_up_idx
  on public.enrollment_request_holds (follow_up_on) where follow_up_on is not null;

create table if not exists public.enrollment_request_events (
  id             bigint generated always as identity primary key,
  -- ★ NO FK, deliberately (the finance_audit_events reasoning): a request can be deleted
  --   with its account, and the record of what was done to it must outlive it.
  request_id     uuid not null,
  actor_user_id  uuid references auth.users(id) on delete set null,
  actor_email    text,
  action         text not null check (action in ('hold_set','hold_updated','hold_cleared','amount_corrected')),
  detail         jsonb not null default '{}'::jsonb,
  reason         text,
  created_at     timestamptz not null default now()
);
alter table public.enrollment_request_events enable row level security;
revoke all on table public.enrollment_request_events from public, anon, authenticated;
create index if not exists enrollment_request_events_request_idx
  on public.enrollment_request_events (request_id, created_at desc);

-- The single SELECT policy per table.
do $pol$
declare
  t text;
begin
  foreach t in array array['enrollment_request_holds', 'enrollment_request_events'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using ((select public.has_staff_permission(''enrollments.review'')))', t || '_read', t);
  end loop;
end
$pol$;

-- Append-only, with the referential SET NULL exemption every audit table here needs.
create or replace function public.enrollment_request_events_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'UPDATE'
     and new.actor_user_id is null and old.actor_user_id is not null
     and (new.id, new.request_id, new.actor_email, new.action, new.detail, new.reason, new.created_at)
         is not distinct from
         (old.id, old.request_id, old.actor_email, old.action, old.detail, old.reason, old.created_at) then
    return new;
  end if;
  perform public.app_error('FORBIDDEN', 'The enrollment timeline is append-only.', 409, null);
  return null;
end;
$fn$;
revoke all on function public.enrollment_request_events_guard() from public, anon, authenticated;
drop trigger if exists enrollment_request_events_guard_trg on public.enrollment_request_events;
create trigger enrollment_request_events_guard_trg
  before update or delete on public.enrollment_request_events
  for each row execute function public.enrollment_request_events_guard();


-- == 2) An approval can only happen with its grant ===========================
create or replace function public.enrollment_approval_requires_grant()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not public.is_super_admin()
     and not exists (select 1 from public.subscriptions s where s.request_id = new.id)
     -- approve_extension returns a grandfathered no-expiry term unchanged, so no row
     -- carries this request's id. That member is still granted; let it through.
     and not exists (select 1 from public.subscriptions s
                      where s.user_id = new.user_id and s.status = 'active' and s.ends_at is null) then
    perform public.app_error('ENROLLMENT_APPROVE_VIA_RPC',
      'Approve this request from the Enrollments screen — that grants the membership in the same step.', 409,
      jsonb_build_object('request_id', new.id));
  end if;
  return new;
end;
$fn$;
revoke all on function public.enrollment_approval_requires_grant() from public, anon, authenticated;
drop trigger if exists enrollment_approval_requires_grant on public.enrollment_requests;
create trigger enrollment_approval_requires_grant
  before update on public.enrollment_requests
  for each row
  when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.enrollment_approval_requires_grant();


-- == 3) A decided request releases its hold ==================================
-- Approved, rejected or expired — by a reviewer, or by the student's own self-expire —
-- a hold on a request that is no longer pending is a stale note. It is removed, and
-- the timeline says why.
create or replace function public.enrollment_hold_release_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_reason text; v_actor uuid := auth.uid();
begin
  delete from public.enrollment_request_holds where request_id = new.id returning reason into v_reason;
  if v_reason is not null then
    insert into public.enrollment_request_events (request_id, actor_user_id, actor_email, action, detail)
    values (new.id, v_actor, (select email from public.profiles where id = v_actor), 'hold_cleared',
            jsonb_build_object('previous_reason', v_reason, 'cause', 'decided', 'status', new.status));
  end if;
  return null;
end;
$fn$;
revoke all on function public.enrollment_hold_release_trg() from public, anon, authenticated;
drop trigger if exists enrollment_hold_release_trg on public.enrollment_requests;
create trigger enrollment_hold_release_trg
  after update on public.enrollment_requests
  for each row
  when (old.status = 'pending_review' and new.status is distinct from 'pending_review')
  execute function public.enrollment_hold_release_trg();


-- == 4) RPCs ==================================================================

create or replace function public.admin_set_enrollment_hold(
  p_request_id uuid, p_reason text, p_follow_up_on date default null
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_status text; v_actor uuid := auth.uid(); v_email text; v_existed boolean; v_today date;
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'Reviewing enrollments requires the enrollments.review permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    perform public.app_error('ENROLLMENT_HOLD_INVALID', 'Say why the request is on hold.', 422, null);
  end if;
  v_today := (now() at time zone 'Asia/Manila')::date;
  if p_follow_up_on is not null and p_follow_up_on < v_today then
    perform public.app_error('ENROLLMENT_HOLD_INVALID', 'A follow-up date cannot be in the past.', 422, null);
  end if;

  select status into v_status from public.enrollment_requests where id = p_request_id for update;
  if v_status is null then
    perform public.app_error('REQUEST_NOT_FOUND', 'The enrollment request does not exist.', 404, null);
  end if;
  if v_status <> 'pending_review' then
    perform public.app_error('ENROLLMENT_NOT_PENDING', 'Only a request still awaiting review can be put on hold.', 409,
      jsonb_build_object('status', v_status));
  end if;

  select email into v_email from public.profiles where id = v_actor;
  v_existed := exists (select 1 from public.enrollment_request_holds where request_id = p_request_id);
  insert into public.enrollment_request_holds (request_id, reason, follow_up_on, held_by, held_by_email)
  values (p_request_id, btrim(p_reason), p_follow_up_on, v_actor, v_email)
  on conflict (request_id) do update
    set reason = excluded.reason, follow_up_on = excluded.follow_up_on, updated_at = now();

  insert into public.enrollment_request_events (request_id, actor_user_id, actor_email, action, detail, reason)
  values (p_request_id, v_actor, v_email, case when v_existed then 'hold_updated' else 'hold_set' end,
          jsonb_build_object('follow_up_on', p_follow_up_on), btrim(p_reason));
  return jsonb_build_object('ok', true, 'updated', v_existed);
end;
$fn$;
revoke all on function public.admin_set_enrollment_hold(uuid, text, date) from public, anon, authenticated;
grant execute on function public.admin_set_enrollment_hold(uuid, text, date) to authenticated;

create or replace function public.admin_clear_enrollment_hold(p_request_id uuid, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_reason text; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'Reviewing enrollments requires the enrollments.review permission.', 403, null);
  end if;
  delete from public.enrollment_request_holds where request_id = p_request_id returning reason into v_reason;
  if v_reason is null then
    perform public.app_error('ENROLLMENT_HOLD_INVALID', 'That request is not on hold.', 404, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.enrollment_request_events (request_id, actor_user_id, actor_email, action, detail, reason)
  values (p_request_id, v_actor, v_email, 'hold_cleared',
          jsonb_build_object('previous_reason', v_reason, 'cause', 'manual'),
          nullif(btrim(coalesce(p_note, '')), ''));
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.admin_clear_enrollment_hold(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_clear_enrollment_hold(uuid, text) to authenticated;

-- ★ PENDING ONLY. Correcting a request that is already approved would not move its
--   posted collection — the ledger is corrected by a reversal, not by editing the
--   request. Before approval, the approval hook posts the corrected figure.
create or replace function public.admin_correct_enrollment_amount(
  p_request_id uuid, p_amount_paid numeric, p_note text
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_req record; v_new numeric(14,2); v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'Reviewing enrollments requires the enrollments.review permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    perform public.app_error('ENROLLMENT_AMOUNT_INVALID', 'Say why the amount is being corrected.', 422, null);
  end if;
  if p_amount_paid is null or p_amount_paid < 0 or p_amount_paid > 1000000 then
    perform public.app_error('ENROLLMENT_AMOUNT_INVALID', 'The amount must be between ₱0 and ₱1,000,000.', 422, null);
  end if;
  v_new := round(p_amount_paid, 2);

  select id, user_id, status, amount_paid into v_req
    from public.enrollment_requests where id = p_request_id for update;
  if v_req.id is null then
    perform public.app_error('REQUEST_NOT_FOUND', 'The enrollment request does not exist.', 404, null);
  end if;
  if v_req.status <> 'pending_review' then
    perform public.app_error('ENROLLMENT_NOT_PENDING',
      'Only a request still awaiting review can be corrected. A posted payment is corrected in Financial Management.', 409,
      jsonb_build_object('status', v_req.status));
  end if;
  -- The #48 segregation rule, applied to the amount the approval will post.
  if v_req.user_id = v_actor and not public.is_super_admin() then
    perform public.app_error('FORBIDDEN', 'You cannot correct your own enrollment request.', 403, null);
  end if;
  if v_req.amount_paid is not distinct from v_new then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  update public.enrollment_requests set amount_paid = v_new, updated_at = now() where id = p_request_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.enrollment_request_events (request_id, actor_user_id, actor_email, action, detail, reason)
  values (p_request_id, v_actor, v_email, 'amount_corrected',
          jsonb_build_object('before', v_req.amount_paid, 'after', v_new), btrim(p_note));
  return jsonb_build_object('ok', true, 'changed', true, 'amount_paid', v_new);
end;
$fn$;
revoke all on function public.admin_correct_enrollment_amount(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.admin_correct_enrollment_amount(uuid, numeric, text) to authenticated;

create or replace function public.admin_enrollment_queue_counts()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_today date;
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'Reviewing enrollments requires the enrollments.review permission.', 403, null);
  end if;
  v_today := (now() at time zone 'Asia/Manila')::date;
  return jsonb_build_object(
    'pending', (select count(*) from public.enrollment_requests where status = 'pending_review'),
    'on_hold', (select count(*) from public.enrollment_request_holds h
                  join public.enrollment_requests r on r.id = h.request_id and r.status = 'pending_review'),
    'follow_up_due', (select count(*) from public.enrollment_request_holds h
                        join public.enrollment_requests r on r.id = h.request_id and r.status = 'pending_review'
                       where h.follow_up_on is not null and h.follow_up_on <= v_today),
    -- ★ DERIVED, never stored: pending, past expires_at, and NOT on hold.
    'overdue', (select count(*) from public.enrollment_requests r
                 where r.status = 'pending_review' and r.expires_at < now()
                   and not exists (select 1 from public.enrollment_request_holds h where h.request_id = r.id))
  );
end;
$fn$;
revoke all on function public.admin_enrollment_queue_counts() from public, anon, authenticated;
grant execute on function public.admin_enrollment_queue_counts() to authenticated;

-- ★ STAFF NAMES ONLY. Given any list of ids, it returns a name only for accounts that hold
--   (or held) a staff membership — so it can never be used to look up a student.
create or replace function public.admin_staff_display_names(p_user_ids uuid[])
returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('enrollments.review') then
    perform public.app_error('FORBIDDEN', 'Reviewing enrollments requires the enrollments.review permission.', 403, null);
  end if;
  if p_user_ids is null or cardinality(p_user_ids) > 200 then
    perform public.app_error('FORBIDDEN', 'Pass at most 200 staff ids.', 422, null);
  end if;
  return query
  select m.user_id, coalesce(nullif(btrim(p.full_name), ''), 'Staff member')
    from public.staff_memberships m
    left join public.profiles p on p.id = m.user_id
   where m.user_id = any(p_user_ids);
end;
$fn$;
revoke all on function public.admin_staff_display_names(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_staff_display_names(uuid[]) to authenticated;

-- == 5) app_error_catalog() — restated IN FULL ================================
-- ★ One VALUES list, so a delta is not expressible. Generated from #59's catalog plus
--   #60's four codes, so no earlier code can be dropped in transcription.
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
    ('ENROLLMENT_APPROVE_VIA_RPC',   409, 'A request can only be approved together with its membership grant.')
  ) as t(code, http, summary);
$cat$;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-15-enrollment-management.sql', null,
  'enrollment management (#60): staff-only enrollment_request_holds (reason, follow-up date; never a column '
  'a student can read, never a change to expires_at) and an append-only enrollment_request_events timeline; '
  'admin_set/clear_enrollment_hold, admin_correct_enrollment_amount (pending requests only, not your own, '
  'always audited, so the approval hook posts the corrected figure), admin_enrollment_queue_counts (overdue '
  'derived: pending, past expires_at, not held) and admin_staff_display_names (staff names only). A trigger '
  'refuses a status -> approved transition with no membership term for the request (the direct-UPDATE path '
  'that skipped admin_finalize_enrollment and, since #58, still booked the payment); Super Admin keeps '
  'break-glass. A decided request releases its hold. No permission changes.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) Both tables have RLS and exactly one SELECT policy:
--      select tablename, count(*), min(cmd) from pg_policies
--       where tablename in ('enrollment_request_holds','enrollment_request_events') group by 1;   -> 1, SELECT
--
-- 2) The approval guard is present and scoped to the transition:
--      select tgname, tgqual is not null from pg_trigger
--       where tgname = 'enrollment_approval_requires_grant';                                    -> t
--
-- 3) npm run db:audit -> clean, including the #60 checks.
