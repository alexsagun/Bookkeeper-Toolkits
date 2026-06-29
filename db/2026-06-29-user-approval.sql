-- ─────────────────────────────────────────────────────────────────────────────
-- Temporary admin-approval gate — new signups start "pending" until an admin approves
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: while the app is invite-only (pre public launch) we don't want anyone with the
-- link to self-serve into the dashboard. This adds an approval workflow on the EXISTING
-- `profiles` table (created in AUTH_SETUP.md): every NEW signup (email OR Google) lands
-- in `approval_status = 'pending'` and is held on a "pending approval" screen until an
-- admin flips them to 'approved' (or 'rejected'). It is intentionally easy to remove later
-- (drop the columns + policies, set the client flag REQUIRE_ADMIN_APPROVAL=false).
--
-- HOW THE DEFAULT FLOWS TO NEW USERS WITH NO TRIGGER CHANGE: the signup trigger
-- public.handle_new_user() (AUTH_SETUP.md) inserts (id, email, full_name, avatar_url)
-- and does NOT mention approval_status — so the column DEFAULT 'pending' applies to every
-- new row automatically. No trigger edit needed.
--
-- ⚠️ LOCKOUT SAFETY (read this): `ALTER TABLE ... ADD COLUMN approval_status DEFAULT 'pending'`
-- back-fills EVERY existing row to 'pending'. Doing nothing else would lock out you and all
-- current users. So the FIRST-TIME add immediately approves all pre-existing accounts (they
-- predate the gate and are trusted), and admins are ALWAYS forced to 'approved'. The backfill
-- is guarded by an "is the column new?" check so re-running the migration never re-approves a
-- genuinely-pending new user.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (guarded adds + drop/create policy), safe to run more than once.
--
-- Depends on public.is_admin() from COURSE_SETUP.md Step 1. If the course platform works,
-- it's already in place. (It is re-created below defensively so this file is self-contained.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Admin helper (re-created defensively; identical to COURSE_SETUP.md Step 1).
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) approval_status column + ONE-TIME backfill of existing accounts.
--    The guard (column-does-not-exist) makes the backfill run exactly once:
--      • first run  → add column (back-fills all rows to 'pending'), then approve them all
--      • later runs → column exists → skip, so new 'pending' users are never re-approved
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'approval_status'
  ) then
    alter table public.profiles
      add column approval_status text not null default 'pending';
    -- Every row that exists at this instant pre-dates the gate → trusted → approve them.
    update public.profiles set approval_status = 'approved';
  end if;
end $$;

-- Value constraint (added separately so it's safe even if the column already existed).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_approval_status_check') then
    alter table public.profiles
      add constraint profiles_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

-- Audit / workflow columns (all idempotent). FK uses ON DELETE SET NULL so an approval
-- record survives the deletion of the admin who made it.
alter table public.profiles add column if not exists approved_at      timestamptz;
alter table public.profiles add column if not exists approved_by      uuid references auth.users(id) on delete set null;
alter table public.profiles add column if not exists rejected_at      timestamptz;
alter table public.profiles add column if not exists rejected_by      uuid references auth.users(id) on delete set null;
alter table public.profiles add column if not exists rejection_reason text;
alter table public.profiles add column if not exists updated_at       timestamptz not null default now();

-- ───────────────────────────────────────────────────────────────────
-- 2) Admins are ALWAYS approved — safe to run on every migration pass.
--    (Belt-and-suspenders so an admin can never be stranded on the pending screen.)
-- ───────────────────────────────────────────────────────────────────
update public.profiles
  set approval_status = 'approved'
  where is_admin = true and approval_status is distinct from 'approved';

-- ───────────────────────────────────────────────────────────────────
-- 3) "Is the current user approved?" helper. Admins always pass.
--    security definer + pinned search_path → no RLS recursion (same shape as is_admin()).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select approval_status = 'approved' or is_admin from public.profiles where id = auth.uid()),
    false
  )
$$;

-- ───────────────────────────────────────────────────────────────────
-- 4) profiles RLS — let admins see/manage everyone; users still can NOT self-approve.
--    The baseline own_profile_select (AUTH_SETUP.md) stays: a user reads their OWN row
--    (so the client can read its own approval_status). We ADD admin-wide read + admin
--    update. There is deliberately NO user-update policy, so a non-admin cannot change
--    their own approval_status (or is_paid / is_admin) — RLS, not just the UI, enforces it.
-- ───────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Keep the user's own-row read (re-created so this file is self-contained / safe to run first).
drop policy if exists own_profile_select on public.profiles;
create policy own_profile_select on public.profiles
  for select using (auth.uid() = id);

-- Admins can read EVERY profile (powers the Access Requests panel).
drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select on public.profiles
  for select to authenticated using (public.is_admin());

-- Admins can UPDATE any profile (approve / reject). Non-admins have no update policy at all.
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 5) Defense-in-depth: gate Supabase-backed CONTENT reads behind approval, not just the UI.
--    (~58 tools store data in localStorage and are already covered by the client gate; the
--    only server-read content is courses/modules/lessons + feature guides.) Admins and
--    approved users pass via is_approved(); pending/rejected users are blocked at the DB too.
--    All existing users were back-filled to 'approved' in step 1, so NOBODY loses access.
--    To revert later: re-run the original read policies from COURSE_SETUP.md (drop is_approved()).
-- ───────────────────────────────────────────────────────────────────
drop policy if exists courses_read on public.courses;
create policy courses_read on public.courses for select to authenticated
  using (public.is_admin() or (published = true and public.is_approved()));

drop policy if exists modules_read on public.course_modules;
create policy modules_read on public.course_modules for select to authenticated
  using (public.is_admin() or (public.is_approved() and exists (
    select 1 from public.courses c where c.id = course_id and c.published = true)));

drop policy if exists lessons_read on public.course_lessons;
create policy lessons_read on public.course_lessons for select to authenticated
  using (public.is_admin() or (public.is_approved() and exists (
    select 1 from public.courses c where c.id = course_id and c.published = true)));

drop policy if exists feature_guides_read on public.feature_guides;
create policy feature_guides_read on public.feature_guides for select to authenticated
  using (public.is_approved());

-- 6) Refresh PostgREST's schema cache so the new columns are queryable immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • New signups (email + Google) land on the "Access Pending Approval" screen.
--   • Approve/reject in-app: sign in as an admin → sidebar → "Access Requests".
--   • Make the first admin (if you haven't): see COURSE_SETUP.md Step 4 —
--       update public.profiles set is_admin = true where email = 'you@example.com';
--     then sign out/in. Admins are auto-approved by step 2 above.
--   • Email notifications are OPTIONAL — set RESEND_API_KEY + RESEND_FROM in Vercel to
--     enable them (see ADMIN_APPROVAL_SETUP.md). Approve/reject works without email.
--   • Turn the whole feature OFF later: set VITE_REQUIRE_ADMIN_APPROVAL=false (rebuild),
--     and optionally revert the policies in step 5 to the COURSE_SETUP.md originals.
-- ─────────────────────────────────────────────────────────────────────────────
