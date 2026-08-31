-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-04-approve-rpc-grant-revoke.sql  (#55)
-- ─────────────────────────────────────────────────────────────────────────────
-- approve_subscription() and approve_extension() must not be callable by a client.
--
-- ★ WHAT WAS REACHABLE, AND VERIFIED LIVE ON 2026-08-31.
--   Both functions are SECURITY DEFINER, granted EXECUTE to `authenticated`, and
--   gate only on has_staff_permission('enrollments.review') — a permission
--   OPERATIONS ADMINS HOLD. Neither reads or writes enrollment_requests, so #48's
--   segregation-of-duties control (enrollment_self_approval_guard, a BEFORE UPDATE
--   trigger on enrollment_requests) can never fire on this path. p_request_id is
--   nullable and is never checked for existence, status, or payment.
--
--   Signed in through PostgREST as a real active operations_admin:
--
--     select public.approve_subscription(<own uid>, 'vip', null);
--       -> INSERTed an active vip term, ends_at = +180d, request_id = null,
--          grant_source = 'payment' (there was no payment), approved_by = self.
--          is_enrolled() flipped false -> true.
--     select public.approve_extension(<own uid>, null, 365);
--       -> stacked another year onto it.
--     select slug from public.courses where published;
--       -> 0 rows before, 3 rows after.
--
--   So the role could mint itself the entire paid product, indefinitely, with no
--   payment, no request row, no receipt and no student_access_events entry. That is
--   strictly more power than admin_grant_special_extension(), which #47 deliberately
--   restricted to Super Admin *because* "a goodwill extension creates paid access
--   with no payment behind it", and which writes an append-only audit row.
--
-- ★ WHY A REVOKE IS THE WHOLE FIX, AND WHY IT BREAKS NOTHING.
--   Nothing calls these from a client. `grep -rn` over src/ and api/ returns zero
--   call sites — only comments. The sanctioned path is admin_finalize_enrollment(),
--   which calls both NESTED. It is itself SECURITY DEFINER, so inside it the
--   effective user is the function owner (postgres), which holds its own EXECUTE.
--   Revoking `authenticated` therefore removes the direct call and leaves the
--   approval workflow untouched.
--
--   The grant is legacy: it dates to db/2026-07-04-subscription-lifecycle.sql, when
--   the client DID call approve_subscription directly. #32 replaced that path with
--   admin_finalize_enrollment() and deleted the client call — but never revoked the
--   grant it left behind.
--
-- ★ CLIENT-NEUTRAL. Unlike #52, this file removes nothing the shipped client uses,
--   so it can be applied independently of a deploy, in either order.
--
-- Depends on: #45 (has_staff_permission), #32 (admin_finalize_enrollment).
-- ─────────────────────────────────────────────────────────────────────────────

do $pre$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'admin_finalize_enrollment') then
    raise exception '#55 requires #32: admin_finalize_enrollment() is missing.';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'approve_subscription') then
    raise exception '#55 requires #13: approve_subscription() is missing.';
  end if;
end
$pre$;

-- ── The revoke ───────────────────────────────────────────────────────────────
-- `public` and `anon` are included for completeness; `authenticated` is the one
-- that was actually reachable.
revoke execute on function public.approve_subscription(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.approve_extension(uuid, uuid, integer) from public, anon, authenticated;

comment on function public.approve_subscription(uuid, text, uuid) is
  'Grants a dated subscription term. INTERNAL — call it through admin_finalize_enrollment(), '
  'which validates the request, the plan and the batch first. Deliberately NOT granted to '
  'authenticated: it takes an arbitrary p_user_id, accepts a null p_request_id, and never '
  'touches enrollment_requests, so #48''s self-approval trigger cannot fire on this path. '
  'See db/2026-09-04-approve-rpc-grant-revoke.sql (#55).';

comment on function public.approve_extension(uuid, uuid, integer) is
  'Extends an existing term. INTERNAL — call it through admin_finalize_enrollment(). '
  'Deliberately NOT granted to authenticated; the audited discretionary path is '
  'admin_grant_special_extension(), which is Super-Admin-only. See #55.';

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes)
values ('2026-09-04-approve-rpc-grant-revoke.sql', null,
        'Revoke authenticated EXECUTE on approve_subscription/approve_extension — an '
        'Operations Admin could self-grant an unpaid VIP term (verified live 2026-08-31).')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ───────────────────────────────────────────────────────────
-- 1) Neither function is client-callable any more:
--      select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname in ('approve_subscription','approve_extension');
--    → auth_exec = false for both
--
-- 2) The sanctioned approval path still works. As a reviewer, approve a real
--    pending request through the UI (Enrollments → Approve), or:
--      select public.admin_finalize_enrollment('<request id>', null);
--    → succeeds, and the member's subscriptions row appears as before.
--
-- 3) The escalation is closed. As an Operations Admin:
--      select public.approve_subscription(auth.uid(), 'vip', null);
--    → ERROR: permission denied for function approve_subscription
