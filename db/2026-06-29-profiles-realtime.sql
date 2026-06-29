-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime on profiles — sign a pending user in the INSTANT an admin approves.
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to db/2026-06-29-user-approval.sql. Optional but recommended: it makes the
-- "Access Pending Approval" screen advance into the dashboard the moment an admin clicks
-- Approve (and flip to the Rejected screen on Reject), with no reload and no manual refresh.
--
-- Without this, the app still advances the user via a ~6s poll / on window focus — just not
-- literally instantly. Run it once in the Supabase SQL Editor. It is idempotent.
--
-- Security: Realtime still enforces Row Level Security. The client subscribes only to its OWN
-- profile row (filter id=eq.<uid>), and the own_profile_select policy means a user can only ever
-- receive changes to their own row — never anyone else's.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;
