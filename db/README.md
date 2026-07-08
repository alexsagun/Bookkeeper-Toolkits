# Database migrations — run order & index

All SQL for the app lives here. There are **two ways** to stand up the database — pick one, don't mix them.

- **Fresh Supabase project?** Run the single **[`000_full_database_bootstrap.sql`](000_full_database_bootstrap.sql)**.
- **Existing project** that already has some of the dated files applied? Run only the **dated** `*.sql`
  files you're missing, **in the numbered order in the table below** (chronological by date, but where files
  share a date they're sequenced by dependency — not strictly alphabetical). Each is idempotent, so
  already-applied ones are no-ops.

Every file is safe to re-run (`create … if not exists`, `create or replace`, `drop … if exists`, `on
conflict`). None of them drop tables/columns or delete data. All SQL is pasted into **Supabase → SQL
Editor → Run**. The Supabase Dashboard steps that are *not* SQL (creating storage buckets by hand, Google
OAuth, email templates, the two `VITE_SUPABASE_*` env vars) live in the setup docs linked below.

---

## Fresh install (new project) — recommended path

1. Create the Supabase project and set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
   (see [../AUTH_SETUP.md](../AUTH_SETUP.md)).
2. Run **[`000_full_database_bootstrap.sql`](000_full_database_bootstrap.sql)** once. It creates the entire
   final schema (all tables, functions, RLS, indexes, both storage buckets, realtime publication) in the
   fully-gated state (approval + enrollment both ON).
3. **Storage buckets:** the bootstrap creates them via SQL. If your SQL role couldn't (you'll see a
   `NOTICE`), create them in **Dashboard → Storage**: `course-media` (**Public = ON**) and
   `enrollment-receipts` (**Public = OFF**, 5 MB, allow `png/jpeg/webp/pdf`). The object policies are already applied.
4. **Promote the first admin** (admins bypass the approval + enrollment gates, so this is how you get in).
   Sign in once so a `profiles` row exists, then:
   ```sql
   update public.profiles set is_admin = true where email = 'you@example.com';
   ```
   Sign out and back in.
5. **Auth config** (Confirm email, Site/Redirect URLs, Google provider) — Dashboard steps in
   [../AUTH_SETUP.md](../AUTH_SETUP.md).

> **Don't run the bootstrap on an existing database.** Its `create table if not exists` skips tables you
> already have and will **not** apply incremental column adds — that's the dated files' job (below).

---

## Existing install — apply the dated files in order

Run them in the **numbered order in the table below** — that is the dependency order. It's chronological by
date, but where files share a date the table's number (not the alphabetical filename) is authoritative — e.g.
`2026-06-29-user-approval` must run **before** `2026-06-29-approval-status-index` (which indexes a column
user-approval adds). Anything already applied no-ops. Hard ordering dependencies are called out in the table.

| # | File | Creates / changes | Depends on |
|---|------|-------------------|------------|
| — | [`000_full_database_bootstrap.sql`](000_full_database_bootstrap.sql) | **Fresh-install only.** Whole schema, final gated state. | empty DB |
| 1 | [`2026-06-15-auth-profiles-base.sql`](2026-06-15-auth-profiles-base.sql) | `profiles` (base) + RLS `own_profile_select` + `handle_new_user()` + `on_auth_user_created` trigger | `auth.users` |
| 2 | [`2026-06-16-course-platform-base.sql`](2026-06-16-course-platform-base.sql) | `profiles.is_admin` + `is_admin()`; `courses`/`course_modules`/`course_lessons`/`lesson_progress`/`course_completions` + indexes + 8 RLS policies + `qbo-mastery` seed | #1 |
| 3 | [`2026-06-16-course-platform-storage.sql`](2026-06-16-course-platform-storage.sql) | public `course-media` bucket + 4 `course_media_*` storage policies | #2 (`is_admin()`) |
| 4 | [`2026-06-17-course-date-source-id.sql`](2026-06-17-course-date-source-id.sql) | adds `courses.course_date`/`month`/`source_course_id`/`updated_at` (delta for pre-existing installs; no-op if #2 already added them) | `courses` |
| 5 | [`2026-06-18-sidebar-settings.sql`](2026-06-18-sidebar-settings.sql) | `sidebar_settings` + RLS | `is_admin()` |
| 6 | [`2026-06-22-feature-guides.sql`](2026-06-22-feature-guides.sql) | `feature_guides` + RLS (`feature_guides_read` = `true` at this stage) | `is_admin()` |
| 7 | [`2026-06-22-feature-video-completions.sql`](2026-06-22-feature-video-completions.sql) | `feature_video_completions` + own-row RLS | `auth.users` |
| 8 | [`2026-06-24-navigation-performance-indexes.sql`](2026-06-24-navigation-performance-indexes.sql) | course/nav performance indexes (guarded per table) | #7 |
| 9 | [`2026-06-29-user-approval.sql`](2026-06-29-user-approval.sql) | `profiles.approval_status` + audit cols + `is_approved()`; admin RLS; **tightens** `courses_read`/`modules_read`/`lessons_read`/`feature_guides_read` to require `is_approved()` | #2, #6 — **run feature-guides (#6) BEFORE this** |
| 10 | [`2026-06-29-profiles-realtime.sql`](2026-06-29-profiles-realtime.sql) | adds `profiles` to `supabase_realtime` | `profiles` |
| 11 | [`2026-06-29-approval-status-index.sql`](2026-06-29-approval-status-index.sql) | `profiles(approval_status)` index (badge query) | #9 (`approval_status`) |
| 12 | [`2026-07-04-enrollment.sql`](2026-07-04-enrollment.sql) | `enrollment_plans`/`enrollment_requests`/`subscriptions`/`payment_settings` + seeds; private `enrollment-receipts` bucket + policies; simple `is_enrolled()`; **tightens** the 4 read policies to also require `is_enrolled()` (§7 skips w/ NOTICE if #9 not run); realtime on `enrollment_requests` | #9 — **run user-approval (#9) BEFORE this** |
| 13 | [`2026-07-04-subscription-lifecycle.sql`](2026-07-04-subscription-lifecycle.sql) | plan `access_days`/`support_days`/`entitlement_summary`; subscription `ends_at`/`grace_ends_at`/lineage; **date-aware `is_enrolled()`**; `approve_subscription()` + `expire_overdue_subscriptions()` + grants; realtime on `subscriptions` | #12 — **stops with an exception if #12 not run** |
| 14 | [`2026-07-08-receipt-integrity.sql`](2026-07-08-receipt-integrity.sql) | receipt delete → **admin-only** (students can't destroy payment evidence after submitting) | #12 (`enrollment-receipts` bucket) |
| 15 | [`2026-07-08-course-videos-private.sql`](2026-07-08-course-videos-private.sql) | **private `course-videos` bucket** + policies for PAID lesson videos (public bucket can't protect a subset; covers/guides stay public) | #12 (`is_enrolled()`) |

**Migration order in one line:** `#1 → #2 → #3 → #4 → #5 → #6 → #7 → #8 → #9 → #10 → #11 → #12 → #13 → #14 → #15`
(feature-guides before user-approval; user-approval before enrollment; enrollment before subscription-lifecycle; the two 2026-07-08 files need enrollment/`is_enrolled()`).

---

## How the bootstrap relates to the dated files

`000_full_database_bootstrap.sql` is the **collapsed final state** of files #1–#15. Where an object is
redefined across the dated chain, the bootstrap keeps only the **final** version, defined once:

- **`is_enrolled()`** — the date-aware version from #13 (an active, non-expired subscription), not the
  simple `is_admin or is_paid` version from #12.
- **`courses_read` / `modules_read` / `lessons_read`** — `is_admin() OR (published AND is_approved() AND
  is_enrolled())` (the #12 §7 shape), never the intermediate base/`is_approved()`-only shapes.
- **`feature_guides_read`** — `is_approved() AND is_enrolled()`.
- **`enrollment_receipts` delete** — admin-only (the #14 shape), not the original owner-or-admin delete.
- **`course-videos`** — the #15 private bucket + `course_videos_*` policies for paid lesson videos.

So the intermediate policy versions in `2026-06-16-course-platform-base.sql`, `2026-06-29-user-approval.sql`,
and `2026-07-04-enrollment.sql` are **superseded, not re-run** on a fresh install — that's expected.

The bootstrap also **omits the one-time grandfather backfills** (the `update profiles set approval_status =
'approved'` / `set is_paid = true` guarded blocks in #9 and #12). Those exist to protect *existing* accounts
when the gates are first switched on; a fresh DB has no rows to protect, and the clean-slate defaults
(`approval_status='pending'`, `is_paid=false`) are correct. The dated files keep those backfills for existing installs.

---

## Setup docs (the non-SQL Dashboard steps + walkthroughs)

- [../AUTH_SETUP.md](../AUTH_SETUP.md) — env vars, Confirm email, Site/Redirect URLs, Google OAuth, email templates.
- [../COURSE_SETUP.md](../COURSE_SETUP.md) — course platform walkthrough + storage bucket creation.
- [../ADMIN_APPROVAL_SETUP.md](../ADMIN_APPROVAL_SETUP.md) — admin-approval gate + Access Requests panel.
- [../ENROLLMENT_SETUP.md](../ENROLLMENT_SETUP.md) — manual enrollment/payment + subscription lifecycle.

## Feature flags (schema is fully gated by default)

Both default **ON** — rebuild after changing either (`VITE_*` vars inline at build time). RLS remains the
real boundary regardless.

- `VITE_REQUIRE_ADMIN_APPROVAL=false` — disables the admin-approval gate.
- `VITE_REQUIRE_ENROLLMENT=false` — disables the enrollment paywall.
