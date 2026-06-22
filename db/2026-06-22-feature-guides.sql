-- ─────────────────────────────────────────────────────────────────────────────
-- Feature guides — admin-curated explainer video + external link, keyed by feature
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: some tools are now thin "guided" pages — a short admin-uploaded explainer
-- video plus a call-to-action button that opens an EXTERNAL website in a new tab.
-- The first is the Mock Interview Simulator (feature_key = 'mock_interview_simulator'),
-- which guides users to the external simulator at https://app.sesame.com/ instead of
-- running an internal simulator. This table stores that curated content server-side
-- so it reaches every signed-in user on every device: each row is one feature's
-- title / description / video (uploaded file path OR pasted YouTube·Vimeo·MP4 URL) /
-- external CTA URL. Every signed-in user READS; only admins WRITE — mirrors the
-- sidebar_settings / courses RLS pattern.
--
-- The table is generic (keyed by `feature_key`) so future guided pages reuse it with
-- no schema change — just a new feature_key + a new in-app guided component.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- It is IDEMPOTENT (create … if not exists + drop/create policy), so it is safe to
-- run more than once and safe on a brand-new database.
--
-- Depends on the public.is_admin() helper from COURSE_SETUP.md Step 1 (already in
-- place if the course platform works). If you haven't run that yet, run it first.
--
-- STORAGE: uploaded videos reuse the EXISTING public `course-media` bucket (Step 2) —
-- no new bucket needed. Its storage policies key only on bucket_id = 'course-media'
-- (no path restriction), so the `feature-guides/<feature_key>/…` prefix is already
-- covered for public-read + admin-write.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Table — one row per guided feature.
create table if not exists public.feature_guides (
  feature_key    text primary key,                                  -- e.g. 'mock_interview_simulator'
  title          text,                                              -- video card heading
  description    text,                                              -- short explanation under the title
  video_url      text,                                              -- pasted YouTube / Vimeo / MP4 link (when not an upload)
  video_path     text,                                              -- course-media storage path (when uploaded)
  video_provider text,                                              -- 'upload' | 'youtube' | 'vimeo' | 'mp4' | null
  external_url   text,                                              -- CTA target (e.g. https://app.sesame.com/); blank → app default
  is_active      boolean not null default true,
  updated_by     uuid references auth.users(id) on delete set null, -- which admin last wrote it (audit)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 2) Row Level Security — any signed-in user reads; only admins write.
alter table public.feature_guides enable row level security;

-- READ: every authenticated user sees the active guide (so all users get the same page).
drop policy if exists feature_guides_read on public.feature_guides;
create policy feature_guides_read on public.feature_guides
  for select to authenticated using (true);

-- WRITE: insert / update / delete restricted to admins (profiles.is_admin = true).
drop policy if exists feature_guides_admin_write on public.feature_guides;
create policy feature_guides_admin_write on public.feature_guides
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 3) Force PostgREST to pick up the new table immediately (clears the PGRST205 cache error):
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- After running: open the app as an admin → "Mock Interview Simulator" tab →
-- "Edit guide" → paste a YouTube/Vimeo link or upload an MP4 (≤ 50 MB) → add a
-- title/description → Save. Every user then sees the video + an "Open Mock Interview
-- Simulator" button that opens the external simulator in a new tab.
--
-- If no row exists yet (or the table is missing), the page degrades to a clean empty
-- state with the working CTA — it never breaks.
--
-- If a write fails with a *permissions* error (code 42501 / "row violates row-level
-- security"), you're not flagged admin — grant yourself:
--     update public.profiles set is_admin = true where id = '<your-auth-user-id>';
-- (find your id in Supabase → Authentication → Users), then sign out and back in.
-- ─────────────────────────────────────────────────────────────────────────────
