-- ─────────────────────────────────────────────────────────────────────────────
-- Feature video completions — per-user "watched the guide video" gate
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: guided feature pages (see db/2026-06-22-feature-guides.sql) can require the
-- user to WATCH the admin's explainer video before the call-to-action unlocks. The
-- first is the Mock Interview Simulator: its "Open Mock Interview Simulator" button
-- (→ https://app.sesame.com/) starts disabled/grey and only turns blue/clickable once
-- the user finishes the guide video. This table remembers that completion PER USER so
-- it survives refresh and logout/login.
--
-- It is tracked against a `video_version` (the guide's current video path-or-url), so
-- when an admin REPLACES the video the version changes and the button re-locks until
-- the user watches the new video. One row per (user, feature): `unique (user_id,
-- feature_key)` is the upsert target.
--
-- Unlike feature_guides (global, admin-write), this is PRIVATE per user: each row is
-- row-locked to its owner — a user can only see / write their OWN completion.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- It is IDEMPOTENT (create … if not exists + drop/create policy), so it is safe to
-- run more than once and safe on a brand-new database.
--
-- If this table is missing, the app does NOT break: the gate still works for the
-- current session (the button unlocks when the video ends) — it just isn't persisted
-- across refreshes until you run this migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Table — one row per (user, feature).
create table if not exists public.feature_video_completions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  feature_key   text not null,                 -- e.g. 'mock_interview_simulator'
  video_version text,                           -- which video was completed (guide.video_path || video_url)
  completed     boolean not null default true,
  completed_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, feature_key)                 -- one row per user per feature → upsert(onConflict)
);

-- 2) Row Level Security — each user only ever sees / writes their OWN completion row.
alter table public.feature_video_completions enable row level security;

drop policy if exists fvc_select_own on public.feature_video_completions;
create policy fvc_select_own on public.feature_video_completions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists fvc_insert_own on public.feature_video_completions;
create policy fvc_insert_own on public.feature_video_completions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists fvc_update_own on public.feature_video_completions;
create policy fvc_update_own on public.feature_video_completions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3) Force PostgREST to pick up the new table immediately (clears the PGRST205 cache error):
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- After running: open the Mock Interview Simulator tab → the CTA is grey/disabled
-- ("Watch the video to unlock simulator") until you finish the guide video, then it
-- turns blue and opens the external simulator in a new tab. The unlock persists across
-- refresh / logout-login. Replacing the guide video re-locks it until re-watched.
-- ─────────────────────────────────────────────────────────────────────────────
