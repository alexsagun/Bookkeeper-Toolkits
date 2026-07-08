-- ─────────────────────────────────────────────────────────────────────────────
-- Enrollment notify status — make the admin "new submission" email auditable.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: when a student submits payment proof, api/notify-enrollment.js fires a
-- best-effort admin alert email. Until now its outcome was only a console.warn in
-- the STUDENT's browser — so a silently unconfigured / rejected email was invisible
-- on the admin side (the in-app sound alert fires regardless, masking the gap). This
-- records the send outcome ON the request row so the Enrollments admin tab can show
-- "Admin emailed" vs "Email not sent — <reason>" per submission.
--
-- The notify-enrollment function runs as the CALLER (the student's JWT on a
-- 'submitted' action). Student RLS on enrollment_requests has NO general UPDATE path
-- (only self-expiring an overdue row — see 2026-07-04-enrollment.sql), so the function
-- cannot PATCH a notify column directly. Rather than widen RLS (spoofable) or add a
-- SUPABASE_SERVICE_ROLE_KEY (another must-propagate secret — the exact class of thing
-- that broke email), we mirror approve_subscription(): a SECURITY DEFINER RPC with an
-- internal owner-or-admin guard. A student can only stamp their OWN row, and the value
-- is advisory audit metadata (no access/money field), so owner-write is acceptable.
--
-- Depends on: db/2026-07-04-enrollment.sql (enrollment_requests) + is_admin().
-- HOW TO RUN: Supabase dashboard → SQL Editor → Run. IDEMPOTENT (add column if not
-- exists / create or replace). Run AFTER the enrollment migration (order after
-- subscription-lifecycle is fine — no dependency on it). (Also folded into
-- db/000_full_database_bootstrap.sql for fresh installs.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Audit columns on the request row (nullable — legacy rows stay null = "unknown").
alter table public.enrollment_requests
  add column if not exists notify_status text,      -- sent | email_not_configured | email_from_not_configured | admin_email_invalid | provider_error
  add column if not exists notified_at   timestamptz,
  add column if not exists notify_detail text;       -- short, non-secret provider detail slice

-- 2) The only write path for the above — SECURITY DEFINER + internal owner/admin guard
--    (same pattern as approve_subscription). A row the caller neither owns nor admins
--    simply matches 0 rows → harmless no-op (no info leak). Lengths bounded so a direct
--    caller can't stuff unbounded text; the UI escapes on render regardless.
create or replace function public.record_enrollment_notification(
  p_request_id uuid,
  p_status     text,
  p_detail     text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.enrollment_requests
     set notify_status = left(coalesce(p_status, ''), 40),
         notified_at   = now(),
         notify_detail = nullif(left(coalesce(p_detail, ''), 300), '')
   where id = p_request_id
     and (user_id = auth.uid() or public.is_admin());
end;
$$;

revoke all on function public.record_enrollment_notification(uuid, text, text) from public;
grant execute on function public.record_enrollment_notification(uuid, text, text) to authenticated;

-- 3) Refresh PostgREST's schema cache so the new columns + RPC are reachable immediately.
notify pgrst, 'reload schema';
