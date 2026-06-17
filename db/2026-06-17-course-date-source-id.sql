-- ─────────────────────────────────────────────────────────────────────────────
-- Course platform migration — add the structured cohort date + duplication columns
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the app (CourseCatalog / CourseProgram) writes `course_date`, `source_course_id`,
-- and `updated_at` on every create / duplicate / edit. If your live database was set up
-- before these columns existed, PostgREST rejects those writes with:
--     PGRST204 — Could not find the 'course_date' column of 'courses' in the schema cache
-- (surfaced in the app as a red banner + a 400 in the browser console).
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- It is IDEMPOTENT — `add column if not exists` no-ops on columns you already have, so it
-- is safe to run more than once and safe on a brand-new database too.
--
-- courses.id is `uuid` (gen_random_uuid()), so source_course_id is `uuid` to match the FK.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) (optional) Audit what the courses table currently has, BEFORE changing anything:
--    Run just this SELECT first if you want to confirm the diagnosis.
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'courses'
-- order by ordinal_position;

-- 2) Add the columns the app expects (safe / idempotent):
alter table public.courses add column if not exists course_date date;
alter table public.courses add column if not exists month text;
alter table public.courses add column if not exists source_course_id uuid
  references public.courses(id) on delete set null;     -- uuid: matches courses.id
alter table public.courses add column if not exists updated_at timestamptz not null default now();

-- 3) Force PostgREST to pick up the new columns immediately (clears the PGRST204 cache error):
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- After running: retry "New course" and "Duplicate" in the app. If PGRST204 lingers
-- for ~30s, run `notify pgrst, 'reload schema';` again, or restart the API from
-- Supabase → Project Settings → API.
--
-- Course writes are admin-only (RLS: only profiles.is_admin may insert/update/delete
-- courses, modules, lessons). If a write now fails with a *permissions* error instead
-- (code 42501 / "row violates row-level security"), grant yourself admin:
--     update public.profiles set is_admin = true where id = '<your-auth-user-id>';
-- (find your id in Supabase → Authentication → Users).
-- ─────────────────────────────────────────────────────────────────────────────
