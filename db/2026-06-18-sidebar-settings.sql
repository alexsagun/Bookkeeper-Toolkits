-- ─────────────────────────────────────────────────────────────────────────────
-- Sidebar customization — global, admin-controlled navigation labels
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the in-app "Customize" sidebar feature (admin-only) lets an admin rename
-- navigation labels — stage headers ("Training & Skills"), tab items ("QuickBooks
-- Online Mastering"), and group sub-headers ("Profile Optimization"). Those renames
-- used to live only in the editing admin's browser localStorage, so they never
-- reached other users or other devices and looked like they "didn't persist".
-- This table stores the overrides server-side: every signed-in user READS them
-- (so the whole app shows the admin's labels), and only admins WRITE them.
--
-- The label is stored against a STABLE, label-independent `item_key` (e.g.
-- 'tab:qbomastery', 'stage:training', 'group:jobsearch:profile-optimization'), so
-- renaming a label never touches routing, module ids, or course filtering.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- It is IDEMPOTENT (create … if not exists + drop/create policy), so it is safe to
-- run more than once and safe on a brand-new database.
--
-- Depends on the public.is_admin() helper from COURSE_SETUP.md Step 1 (already in
-- place if the course platform works). If you haven't run that yet, run it first.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Table — one row per overridden navigation item.
create table if not exists public.sidebar_settings (
  item_key     text primary key,                                  -- stable key, never the visible label
  custom_label text not null,
  updated_by   uuid references auth.users(id) on delete set null, -- which admin last wrote it (audit)
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- 2) Row Level Security — any signed-in user reads; only admins write.
alter table public.sidebar_settings enable row level security;

-- READ: every authenticated user sees the global labels (so the nav is consistent app-wide).
drop policy if exists sidebar_settings_read on public.sidebar_settings;
create policy sidebar_settings_read on public.sidebar_settings
  for select to authenticated using (true);

-- WRITE: insert / update / delete restricted to admins (profiles.is_admin = true).
drop policy if exists sidebar_settings_admin_write on public.sidebar_settings;
create policy sidebar_settings_admin_write on public.sidebar_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 3) Force PostgREST to pick up the new table immediately (clears the PGRST205 cache error):
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- After running: open the app as an admin, click "Customize" in the sidebar, rename
-- a label, press Enter, then "Done". The change is upserted here and shows for every
-- user after refresh / logout-login / redeploy. "Reset to default" deletes the rows
-- (labels fall back to the code defaults).
--
-- If a write fails with a *permissions* error (code 42501 / "row violates row-level
-- security"), you're not flagged admin — grant yourself:
--     update public.profiles set is_admin = true where id = '<your-auth-user-id>';
-- (find your id in Supabase → Authentication → Users), then sign out and back in.
-- ─────────────────────────────────────────────────────────────────────────────
