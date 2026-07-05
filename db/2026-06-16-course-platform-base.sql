-- ─────────────────────────────────────────────────────────────────────────────
-- BASE (foundation) — admin flag/helper + course platform tables + RLS + seed
-- ─────────────────────────────────────────────────────────────────────────────
-- This file promotes the foundational SQL that previously lived ONLY as a paste
-- block in COURSE_SETUP.md (Step 1) into a real, dated migration, so the db/ chain
-- is gapless and self-contained. Its content is the COURSE_SETUP.md Step 1 block
-- verbatim (base shape). Later dated files add columns/policies on top:
--   • db/2026-06-17-course-date-source-id.sql — re-adds the same courses.* columns
--     idempotently for installs made before they existed (no-op here).
--   • db/2026-06-29-user-approval.sql — REPLACES courses_read/modules_read/lessons_read
--     to also require public.is_approved().
--   • db/2026-07-04-enrollment.sql §7 — tightens them again to also require is_enrolled().
--
-- Depends on: db/2026-06-15-auth-profiles-base.sql (public.profiles).
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (if not exists / drop … if exists) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────
-- 1. Admin flag on profiles + admin-check helper
-- ───────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- security definer + pinned search_path avoids RLS recursion when course
-- policies consult the profiles table.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

-- ───────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.courses (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null default 'qbo-mastery',
  title       text not null,
  subtitle    text,
  description text,
  cover_path  text,
  month       text,                                                  -- LEGACY free-text cohort label (e.g. "June 2026"); kept as a display fallback only
  course_date date,                                                  -- editable cohort/run date chosen by the creator (defaults to today; YYYY-MM-DD, timezone-safe). Card shows an auto-derived "Month Year" label.
  source_course_id uuid references public.courses(id) on delete set null, -- set when a course was duplicated from another (lineage)
  published   boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Idempotent migration — for projects created before these columns existed, add any that are missing.
-- (Also lives as a standalone, copy-pasteable file: db/2026-06-17-course-date-source-id.sql)
alter table public.courses add column if not exists month text;        -- legacy cohort label (display fallback only)
alter table public.courses add column if not exists course_date date;  -- structured editable cohort/run date (defaults to today)
alter table public.courses add column if not exists source_course_id uuid
  references public.courses(id) on delete set null;
alter table public.courses add column if not exists updated_at timestamptz not null default now(); -- written by edits/cover uploads
notify pgrst, 'reload schema';  -- make PostgREST pick up the new columns immediately (avoids the 400 below)

create table if not exists public.course_modules (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  title      text not null,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_modules_course on public.course_modules(course_id, position);

create table if not exists public.course_lessons (
  id             uuid primary key default gen_random_uuid(),
  module_id      uuid not null references public.course_modules(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  title          text not null,
  type           text not null default 'video' check (type in ('video','text')),
  video_url      text,
  video_provider text check (video_provider in ('youtube','vimeo','mp4','upload')),
  storage_path   text,
  text_content   text,
  duration_label text,
  position       integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_lessons_module on public.course_lessons(module_id, position);

-- One row per user per completed lesson.
create table if not exists public.lesson_progress (
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_id    uuid not null references public.course_lessons(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index if not exists idx_progress_user_course on public.lesson_progress(user_id, course_id);

-- Stamped once when a student first reaches 100% — gives the certificate a stable issue date.
create table if not exists public.course_completions (
  user_id      uuid not null references auth.users(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

-- ───────────────────────────────────────────────────────────────────
-- 3. Row Level Security
-- ───────────────────────────────────────────────────────────────────
alter table public.courses            enable row level security;
alter table public.course_modules     enable row level security;
alter table public.course_lessons     enable row level security;
alter table public.lesson_progress    enable row level security;
alter table public.course_completions enable row level security;

-- COURSES: signed-in users read published courses; admins read/write everything.
drop policy if exists courses_read on public.courses;
create policy courses_read on public.courses for select to authenticated
  using (published = true or public.is_admin());
drop policy if exists courses_admin_write on public.courses;
create policy courses_admin_write on public.courses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- MODULES: readable if parent course is published (or you're admin); admin-only write.
drop policy if exists modules_read on public.course_modules;
create policy modules_read on public.course_modules for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.courses c where c.id = course_id and c.published = true));
drop policy if exists modules_admin_write on public.course_modules;
create policy modules_admin_write on public.course_modules for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- LESSONS: same shape (uses denormalized course_id).
drop policy if exists lessons_read on public.course_lessons;
create policy lessons_read on public.course_lessons for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.courses c where c.id = course_id and c.published = true));
drop policy if exists lessons_admin_write on public.course_lessons;
create policy lessons_admin_write on public.course_lessons for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- PROGRESS + COMPLETIONS: each user sees/writes only their own rows.
drop policy if exists progress_own on public.lesson_progress;
create policy progress_own on public.lesson_progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists completions_own on public.course_completions;
create policy completions_own on public.course_completions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────────
-- 4. Seed the one course (the app loads it by slug 'qbo-mastery')
-- ───────────────────────────────────────────────────────────────────
insert into public.courses (title, slug, subtitle, published)
values ('QuickBooks Online Mastering Programme', 'qbo-mastery',
        'From setup to month-end — the complete QBO workflow for remote bookkeepers.', true)
on conflict (slug) do nothing;
