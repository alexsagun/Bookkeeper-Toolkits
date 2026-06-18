# Course Setup — QuickBooks Online Mastering Programme

One-time backend setup for the **QBO Mastering Programme** (the Thinkific-style video course in the
Training & Skills section). This adds course tables, per-user progress, a media bucket, and an
**admin authoring gate** to your existing Supabase project. It builds on the auth backend already
configured in [AUTH_SETUP.md](AUTH_SETUP.md) — do that first.

The app feature lives in `src/BookkeeperPro.jsx` (the `QBOMastery` component). It reuses the single
Supabase client in [src/lib/supabase.js](src/lib/supabase.js) and the existing `VITE_SUPABASE_*`
env vars — **no new environment variables are needed.**

---

## What you get

- **Students** (any signed-in user) see the published curriculum, watch video lessons, and their
  progress is saved server-side — so it survives reloads **and follows them across devices**.
- **You (the owner/admin)** get an in-app **"Edit course"** builder: create modules, add lessons,
  paste a YouTube/Vimeo/MP4 link **or upload a video file**, then publish.
- On 100% completion, students download a **branded PDF certificate**.

Authoring is gated by a new `profiles.is_admin` flag — only admins can write course content (enforced
by Row Level Security, not just the UI).

> **The QBO tab is now a multi-course catalog.** "QuickBooks Online Mastery" (`QBOMastery` →
> `CourseCatalog`) lists **every course whose `slug` starts with `qbo-`** (so the `qbo-mastery` row
> below shows up there). Admins click **"New course"** to add more — it auto-creates a unique `qbo-…`
> slug, so **no extra SQL is needed per course**. Each course supports a **cover image** (stored in
> `course-media` under `covers/{course_id}/…`, saved to the existing `courses.cover_path` column — no
> schema change). The Resume and Interview courses use other slug prefixes, so they stay on their own
> tabs and do **not** appear in this catalog.
>
> **Per-card ⋮ action menu (admin only).** Each course card has a 3-dot menu with **Edit course**,
> **Duplicate course**, **Set cover image**, **Move up/down**, and **Delete course**. Students never
> see it.
>
> **Duplicate course (monthly re-runs).** **⋮ → Duplicate course** clones a course's structure +
> lessons into a **new independent DRAFT** ("Copy of …"), reusing the original's video links/uploads
> and cover **by reference** (no files are copied — copy-on-write), and stamping `source_course_id`
> for lineage. Per-user data (progress, completions, certificates) is **not** copied. The duplicate's
> **Course Date / Cohort Date** defaults to **today** (it is not copied from the source), so a new
> monthly re-run never inherits last month's date. The copy opens straight in the builder so you can
> rename it, adjust the course date if needed, tweak lessons, and publish. Because videos are shared until you change them, **storage deletes are
> reference-aware**: replacing/deleting a lesson video or deleting a whole course only removes a file
> when **no other course still references it**, so deleting one monthly edition never breaks another.
>
> **Removing test/dummy content:** sign in as an admin and delete it **in-app** — the catalog's
> **Delete course** (⋮ menu) cascades the row deletion (modules, lessons, progress, completions) and
> purges the course's uploaded videos + cover from storage **unless a duplicated course still uses
> them**; deleting a single lesson behaves the same way. No manual SQL or Storage cleanup required.
>
> **Troubleshooting — Create/Duplicate fails with a red banner / `400` in the console.** If **New
> course** or **⋮ → Duplicate course** errors and DevTools shows `POST …/rest/v1/courses → 400`
> (expand the logged object: `code` is `PGRST204` or `42703`, "Could not find the **'course_date'**
> column …" — or `'source_course_id'`), the course-platform migration hasn't been applied to this
> project. **Easiest fix:** open [`db/2026-06-17-course-date-source-id.sql`](db/2026-06-17-course-date-source-id.sql)
> and run it whole in the Supabase **SQL Editor** — it adds `course_date` / `month` / `source_course_id`
> / `updated_at` (all `if not exists`, safe to re-run) and ends with `notify pgrst, 'reload schema';`.
> That same block is also inline below (Step 1's "idempotent migration" lines). Retry afterward; the
> in-app banner spells out the exact Postgres error and this fix.

---

## Setup order at a glance

Do these in order — the app keeps showing **"Finish backend setup"** until they're done:

1. **Run the main SQL** (Step 1) — creates the tables, RLS, admin helper, and the course row.
2. **Create the public `course-media` bucket** + its policies (Step 2).
3. *(Optional)* **Seed a starter module** so the course isn't blank (Step 3).
4. **Make yourself an admin** (Step 4), then **sign out and back in**.
5. Refresh the app → the course loads; admins see the **Edit course** builder.

> Make sure the `VITE_SUPABASE_URL` your app is built with points at the **same** Supabase project
> where you run this SQL — otherwise the tables will look "missing" (404 / schema-cache error).

---

## Step 1 — Run the SQL

Open **Supabase Dashboard → SQL Editor → New query**, paste **all** of the following, and run it.
It is idempotent (safe to re-run).

```sql
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
-- Note: `course_date` (date-only, YYYY-MM-DD) is the structured cohort date the creator picks; it defaults
-- to today on create/duplicate and renders as an auto-derived "Month Year" badge. The older `month` text
-- column is retained ONLY as a display fallback for legacy rows that have no course_date — no backfill is
-- run, so existing month labels keep showing until an admin opens the course and saves a date.

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
```

> **Multiple courses:** the schema is multi-course (every row is keyed by `course_id`) and the shared
> `course-media` bucket + RLS already cover any number of courses. The app ships a second course —
> **Resume Winning Strategy** (slug `resume-strategy`, under Job Application → Profile Optimization).
> You do **not** need to seed it with SQL: open that tab while signed in as an admin and click
> **"Create course"** — the app inserts the `courses` row for you (RLS permits admin inserts), then
> drops you into the builder to add modules and lessons. (The QBO seed above stays as the canonical
> example; new courses created via wrappers can be bootstrapped the same one-click way.)

---

## Step 2 — Create the media bucket

Uploaded videos and cover images are streamed straight from Supabase Storage, so the bucket must be
**public-read**.

1. **Supabase Dashboard → Storage → New bucket.**
2. Name: **`course-media`**. Toggle **Public bucket = ON**. Create.
3. Back in **SQL Editor**, run the storage policies (public read, admin-only write):

```sql
drop policy if exists course_media_read on storage.objects;
create policy course_media_read on storage.objects for select to public
  using (bucket_id = 'course-media');

drop policy if exists course_media_admin_write on storage.objects;
create policy course_media_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'course-media' and public.is_admin());

drop policy if exists course_media_admin_update on storage.objects;
create policy course_media_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'course-media' and public.is_admin());

drop policy if exists course_media_admin_delete on storage.objects;
create policy course_media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-media' and public.is_admin());
```

> **File size:** the standard Supabase tier caps uploads (commonly **50 MB** per file). For longer
> videos, either raise the limit in **Storage → Settings**, or just paste a **YouTube / Vimeo link**
> in the lesson editor instead of uploading — both work.

---

## Step 3 — (Optional) Seed a starter module

So the course isn't blank on first load, run this to add one module with three sample lessons (two
video, one text). It's guarded with `not exists`, so it's safe to run once and won't duplicate on
re-run. You can edit or delete everything later in the in-app builder.

```sql
with c as (
  select id from public.courses where slug = 'qbo-mastery'
),
ins_mod as (
  insert into public.course_modules (course_id, title, position)
  select c.id, 'Getting Started in QuickBooks Online', 0
  from c
  where not exists (
    select 1 from public.course_modules m
    where m.course_id = c.id and m.title = 'Getting Started in QuickBooks Online'
  )
  returning id, course_id
),
target as (
  -- the freshly-inserted module, or the existing one if it was already there
  select id, course_id from ins_mod
  union all
  select m.id, m.course_id
  from public.course_modules m
  join c on c.id = m.course_id
  where m.title = 'Getting Started in QuickBooks Online'
    and not exists (select 1 from ins_mod)
)
insert into public.course_lessons
  (module_id, course_id, title, type, video_provider, video_url, text_content, duration_label, position)
select t.id, t.course_id, v.title, v.type, v.video_provider, v.video_url, v.text_content, v.duration_label, v.position
from target t
cross join (values
  -- NOTE: the two video lessons use a PLACEHOLDER YouTube URL just to prove playback works.
  -- Swap them for your real lesson videos in the builder (or edit the URLs below before running).
  ('Welcome & What You''ll Learn', 'video', 'youtube',
     'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
     'A quick tour of the programme and how to get the most out of it.', '3:40', 0),
  ('Navigating the QBO Dashboard', 'video', 'youtube',
     'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
     'Where everything lives: the left nav, the gear menu, and the + New button.', '6:15', 1),
  ('Chart of Accounts Basics', 'text', null, null,
     E'The Chart of Accounts is the backbone of the books.\n\n• Five buckets: Assets, Liabilities, Equity, Income, Expenses\n• Keep it lean — add detail only when it earns its keep\n• Map every bank and credit-card account to the right COA entry',
     null, 2)
) as v(title, type, video_provider, video_url, text_content, duration_label, position)
where not exists (
  select 1 from public.course_lessons l where l.module_id = t.id
);
```

---

## Step 4 — Make yourself an admin

Sign in to the app once with your owner account so a `profiles` row exists, then run:

```sql
update public.profiles set is_admin = true where email = 'alex.capinding.sagun@gmail.com';
```

**Sign out and back in** (or refresh) so the app re-reads your profile. You'll now see an
**"Edit course"** toggle on the QBO Mastering Programme screen. Students never see it, and RLS blocks
their writes even if they tried to bypass the UI.

---

## Step 5 — Author the course

In the app, open **Training & Skills → QuickBooks Online Mastering**, click **Edit course**, then:

1. Add a **module** (e.g. "Getting Started in QBO").
2. Add **lessons** to it — give each a title, pick **Video** or **Text**, and for video either paste a
   link or upload a file. Optionally add notes and a duration label.
3. Reorder with the up/down arrows. Toggle the course **Published** when ready.

Students see published content immediately, complete lessons, and earn the certificate at 100%.

---

## Troubleshooting

- **"Finish backend setup" / `Could not find the table 'public.courses'` (404 / schema-cache)** —
  the tables don't exist in the project your app is talking to. Two causes:
  1. **You haven't run Step 1 yet** — run the main SQL.
  2. **Wrong project** — the app's `VITE_SUPABASE_URL` points at a *different* Supabase project than
     the one where you ran the SQL. Make them match (check `.env` locally and the Vercel env vars).
  - If you *just* created the tables and still see the schema-cache error, PostgREST's cache is stale.
    Run `notify pgrst, 'reload schema';` in the SQL Editor (or wait ~30s), then refresh.
- **"Course coming soon" as a student, but you published it** — confirm the `courses.published`
  column is `true` and the module/lesson `position` values are set (the seed/editor handle this).
- **Edit toggle missing** — your `profiles.is_admin` isn't `true`, or you didn't re-sign-in after
  setting it.
- **Uploaded video won't play** — confirm the `course-media` bucket is **public** and the storage
  read policy above exists; check the browser console for a CORS error.
- **Writes rejected while authoring** — you're not an admin for the requesting session (RLS). Re-check
  Step 4.

---

## Sidebar customization (admin-only navigation labels)

The sidebar **Customize** button (admin-only) lets an admin rename navigation labels — stage headers
("Training & Skills"), tab items ("QuickBooks Online Mastering"), and group sub-headers ("Profile
Optimization") — and have the change show for **every** user on every device. The renames are stored
in a `sidebar_settings` table (global, admin-write / authenticated-read), keyed by a **stable
`item_key`** (e.g. `tab:qbomastery`, `stage:training`, `group:jobsearch:profile-optimization`) so a
rename only changes the displayed text — routes, module ids, and course filtering are untouched.

**Run this once** (also a standalone copy at `db/2026-06-18-sidebar-settings.sql`). It reuses the
`public.is_admin()` helper from Step 1:

```sql
create table if not exists public.sidebar_settings (
  item_key     text primary key,
  custom_label text not null,
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

alter table public.sidebar_settings enable row level security;

drop policy if exists sidebar_settings_read on public.sidebar_settings;
create policy sidebar_settings_read on public.sidebar_settings
  for select to authenticated using (true);

drop policy if exists sidebar_settings_admin_write on public.sidebar_settings;
create policy sidebar_settings_admin_write on public.sidebar_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

notify pgrst, 'reload schema';
```

Then, as an admin: **Customize → click a label → type → Enter → Done**. Press **Cancel** to discard,
or **Reset to default** to clear all overrides (deletes the rows; labels revert to code defaults). If
the table is missing, the app falls back to the built-in labels and logs a console warning — it never
breaks the sidebar.
