# The Supabase SQL Editor list is not a migration manifest

## Three different counts, and why none of them match

| Where | Count | What it actually is |
|---|---|---|
| Supabase Dashboard → SQL Editor | **39** | Saved **editor tabs** — paste history. Includes ad-hoc queries, retries, duplicates, and misnamed tabs. |
| `db/*.sql` in this repo | **37** | 36 dated migrations **+** `000_full_database_bootstrap.sql` (fresh-install only; deliberately never applied to an existing database, and never logged) |
| `public.schema_migrations` | **36** | The **apply log** — the authoritative record |

> **Counting SQL Editor tabs cannot tell you whether the database is up to date.** Run
> **`npm run db:audit`** instead. It diffs the repo against the live apply log and then checks that the
> objects each migration promises actually exist.

### Why the SQL Editor list undercounts

**Eight migrations have no tab at all.** The list stops at `community-write-gate.SQL` (2026-07-26).
Everything from **#29 onward** — `rls-initplan-and-indexes`, `backend-hardening`,
`schema-migrations-log`, `community-spaces-batches`, `community-batch-hardening`,
`batch-hardening-followup`, `batch-entitlements`, `community-plan-capabilities` — was applied through
the **Management API**, which does not create editor tabs. Two earlier files (`#11`
approval-status-index, `#20` account-membership-requests) also have no clearly matching tab.

### Why it overcounts

Six tabs are ad-hoc queries, not migrations, and several are duplicate retries of one file.

---

## Full inventory (39 tabs)

Classification is by reading each tab's SQL and fingerprinting the identifiers it creates against
`db/*.sql`. "→ #n" is the migration it corresponds to.

| # | Date | Current tab name | What it contains | Maps to |
|---|---|---|---|---|
| 1 | 06-12 | `Create User Profiles with Supabase RLS` | `handle_new_user()` (22L) | → #1 (early draft) |
| 2 | 06-12 | `User Profiles Table with RLS` | `profiles` table (18L) | → #1 (early draft) |
| 3 | 06-12 | `Create Profile on New User Signup` | `handle_new_user()` (21L) | → #1 (early draft) |
| 4 | 06-12 | `User Profile Management` | `profiles.is_admin` + courses/modules/lessons (213L) | → #2 |
| 5 | 06-13 | `Course Media Storage Access Policies` | 4 `course_media_*` storage policies (44L) | → #3 |
| 6 | 06-13 | `Promote Profile to Admin` | `update profiles set is_admin` | **ad-hoc** |
| 7 | 06-13 | `Find Profile by Email` | `select id, email, is_admin` | **ad-hoc** |
| 8 | 06-13 | `Seed QBO Course Modules and Lessons` | content seed (103L) | **ad-hoc** (data seed) |
| 9 | 06-16 | **Untitled query** | `alter table courses add column month` (7L) | → #4 (partial) |
| 10 | 06-17 | **Untitled query** | `courses.course_date` + `source_course_id` (10L) | → #4 |
| 11 | 06-17 | **Untitled query** | same, 6-line retry | → #4 (duplicate) |
| 12 | 06-17 | **Untitled query** | `update profiles set is_admin = true where id = …` | **ad-hoc** |
| 13 | 06-17 | **Untitled query** | `select column_name … table_name='courses'` | **ad-hoc** |
| 14 | 06-18 | **Untitled query** | `sidebar_settings` + 2 policies (15L) | → #5 |
| 15 | 06-22 | **Untitled query** | `feature_video_completions` (22L) | → #7 (first attempt) |
| 16 | 06-22 | **Untitled query** | `feature_guides` + policies (32L) | → #6 |
| 17 | 06-22 | **Untitled query** | `feature_video_completions` (33L, fuller) | → #7 |
| 18 | 06-24 | **Untitled query** | 6 course/nav indexes in a guarded `do $$` (54L) | → #8 |
| 19 | 06-29 | `User-approval-SQL` | `is_admin()`, `is_approved()`, approval columns (96L) | → #9 |
| 20 | 06-29 | **Untitled query** | adds `profiles` to `supabase_realtime` (10L) | → #10 |
| 21 | 06-29 | `Admin Approval SQL` | `select … from auth.users` listing signups (7L) | **ad-hoc** |
| 22 | 07-04 | `Enrollment sql` | enrollment tables, receipts bucket, `is_enrolled()` (357L) | → #12 |
| 23 | 07-08 | `receipt-integrity.sql` | receipt delete → admin-only (9L) | → #14 |
| 24 | 07-08 | `course-videos-private.sql` | private `course-videos` bucket + policies (30L) | → #15 |
| 25 | 07-08 | `enrollment-notify-status.sql` | notify columns + RPC (37L) | → #16 |
| 26 | 07-09 | `subscription-lifecycle.sql` | dated terms, `approve_subscription()` (292L) | → #13 |
| 27 | 07-09 | `plan-course-access.sql` | `current_plan_key()`, `plan_is_qbo_only()` (182L) | → #17 |
| 28 | 07-10 | `subscription-grace-sql` | 3-day grace + backfill (154L) | → #18 |
| 29 | 07-10 | `sampler-access-course-sql` | `courses.access_tier`, `plan_is_sampler()` (159L) | → #19 |
| 30 | 07-12 | `sampler-essentials-access-sql` | **identical to #29** (159L) | → #19 (duplicate) |
| 31 | 07-12 | `accounts=membership-request-sql` | ⚠ **content is identical to #29/#30** (159L) | **name ≠ content** |
| 32 | 07-12 | `Hardening-sql` | `approve_extension` clamp + CHECK (151L) | → #21 |
| 33 | 07-21 | `sampler-support-60 days sql` | data fix: sampler `support_days` 30 → 60 (66L) | → #22 |
| 34 | 07-21 | `community.sql` | base `community_*` tables (334L) | → #23 |
| 35 | 07-22 | `Community-forum.sql` | forum upgrade (802L) | → #24 |
| 36 | 07-22 | `Community-hardening.sql` | (133L) | → #25 |
| 37 | 07-22 | `student-import.sql` | import tables + RPC (288L) | → #26 |
| 38 | 07-24 | `course-ai-trainer.sql` | trainer tables + mirrors (546L) | → #27 |
| 39 | 07-26 | `community-write-gate.SQL` | expired-member write gate (88L) | → #28 |

### ⚠ Tab 31 is worth a look

Tabs 29, 30 and 31 are all **159 lines and fingerprint identically** to
`2026-07-11-sampler-essentials-access.sql` (#19). But tab 31 is named
`accounts=membership-request-sql`, which suggests it was *meant* to hold
`2026-07-11-account-membership-requests.sql` (**#20**).

That is a plausible mechanism for a known incident: **#20 and #21 sat unapplied in production for two
weeks** while the deployed Extend Access UI depended on them (see the `#31` row in
[`../../db/README.md`](../../db/README.md), which is why the apply-log exists at all). If the tab named
for #20 actually contained #19's SQL, running it would have looked like applying #20 while doing
nothing of the sort.

Both #20 and #21 **are** applied now — `npm run db:audit` confirms it, and
`approve_extension(uuid,uuid,integer)` exists. Nothing is broken today; this is history, and a good
argument for never trusting a tab's name over the apply log.

---

## Rename checklist (Dashboard)

The Management API is **read-only** for snippets — `GET /v1/snippets` and `GET /v1/snippets/{id}` only,
no PATCH or PUT. So these are renamed by hand in **Dashboard → SQL Editor**, right-click the tab →
Rename. Nothing depends on the names; this is purely so the list is readable.

| Find the tab dated… | …with this first line | Rename it to |
|---|---|---|
| 2026-06-16 | `alter table public.courses add column if not exists month text;` | `#4a courses.month column` |
| 2026-06-17 (10 lines) | `alter table public.courses add column if not exists course_date date;` | `#4 course-date-source-id` |
| 2026-06-17 (6 lines) | `alter table public.courses add column if not exists course_date date;` | `#4 course-date-source-id (duplicate retry)` |
| 2026-06-17 (2 lines) | `update public.profiles set is_admin = true where id = …` | `ad-hoc: promote user to admin` |
| 2026-06-17 (2 lines) | `select column_name from information_schema.columns …` | `ad-hoc: inspect courses columns` |
| 2026-06-18 | `create table if not exists public.sidebar_settings (` | `#5 sidebar-settings` |
| 2026-06-22 (22 lines) | `create table if not exists public.feature_video_completions (` | `#7 feature-video-completions (first attempt)` |
| 2026-06-22 (32 lines) | `create table if not exists public.feature_guides (` | `#6 feature-guides` |
| 2026-06-22 (33 lines) | `create table if not exists public.feature_video_completions (` | `#7 feature-video-completions` |
| 2026-06-24 | `do $$` … creates `courses_slug_idx` etc. | `#8 navigation-performance-indexes` |
| 2026-06-29 (10 lines) | `do $$` … `alter publication supabase_realtime add table public.profiles` | `#10 profiles-realtime` |

Optional, for clarity: rename tab 31 to `#19 sampler-essentials (MISNAMED — was labelled account-membership)`.

## Do the tabs need cleaning up?

**No.** They are editor history, not database state — deleting one changes nothing. They are kept as a
record of what was run by hand and when. If you do want to prune, the six ad-hoc tabs (6, 7, 8, 12, 13,
21) and the duplicates (11, 30, 31) are the only genuinely redundant ones.

## The habit that replaces all of this

```bash
npm run db:audit
```

Read-only. Diffs `db/*.sql` against `public.schema_migrations` on the live project, then verifies the
objects really exist. That is the answer to "are all my migrations applied?" — not a tab count.
