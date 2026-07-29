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

> **Apply-log (#31):** the live project tracks applied files in **`public.schema_migrations`**. After
> running any dated file, insert its row in the same SQL-editor session (pattern at the tail of
> [`2026-07-26-schema-migrations-log.sql`](2026-07-26-schema-migrations-log.sql)); to audit for drift,
> diff the table against `ls db/*.sql`. This exists because two applied-looking migrations (#20/#21)
> turned out never to have run in prod — see the #31 row below.

### "Is my database up to date?" — run `npm run db:audit`

**Three different things get counted, and none of them match. Only one is authoritative.**

| Where | What it is |
|---|---|
| Supabase Dashboard → **SQL Editor** | Saved editor **tabs** — paste history. Ad-hoc queries, retries, duplicates, occasionally a tab whose name doesn't match its contents. Migrations applied via the Management API leave **no tab at all**. |
| **`db/*.sql`** here | The dated migrations **+** `000_full_database_bootstrap.sql`, which is fresh-install-only and is deliberately never applied to an existing database (so it is never logged). |
| **`public.schema_migrations`** | The apply log. **Authoritative.** |

So the tab count will always be higher or lower than the file count, and neither tells you whether the
database is current. Instead:

```bash
npm run db:audit          # read-only; add --json for CI
```

It diffs `db/*.sql` against the live apply log **and** verifies the objects each migration promises
actually exist — because a log row only *claims* a file ran. That second half is what would have caught
the #20/#21 incident. Full explanation and a per-tab inventory:
[`../docs/db/sql-editor-snippets.md`](../docs/db/sql-editor-snippets.md).

---

## Fresh install (new project) — recommended path

1. Create the Supabase project and set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
   (see [../AUTH_SETUP.md](../AUTH_SETUP.md)).
2. Run **[`000_full_database_bootstrap.sql`](000_full_database_bootstrap.sql)** once. It creates the entire
   final schema (all tables, functions, RLS, indexes, all five storage buckets, realtime publication) in
   the fully-gated state (approval + enrollment both ON), **through #37** — including the cohort-entitlement
   ledger and the D2 announcement-only General space. Nothing else needs running afterwards; verify with
   `npm run db:audit`.
3. **Storage buckets:** the bootstrap creates them via SQL. If your SQL role couldn't (you'll see a
   `NOTICE`), create them in **Dashboard → Storage**: `course-media` (**Public = ON**),
   `enrollment-receipts` (**Public = OFF**, 5 MB, allow `png/jpeg/webp/pdf`), `course-videos`
   (**Public = OFF**, 50 MB, video mimes), `avatars` (**Public = ON**, 5 MB, image mimes), and
   `community-media` (**Public = OFF**, 50 MB, image + video mimes). The object policies are already applied.
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
| 16 | [`2026-07-08-enrollment-notify-status.sql`](2026-07-08-enrollment-notify-status.sql) | `enrollment_requests.notify_status`/`notified_at`/`notify_detail` + `record_enrollment_notification()` RPC (SECURITY DEFINER, owner-or-admin) — makes the admin-alert email outcome auditable in the Enrollments tab | #12 (`enrollment_requests`, `is_admin()`) |
| 17 | [`2026-07-09-plan-course-access.sql`](2026-07-09-plan-course-access.sql) | **Plan-scoped course access** — `current_plan_key()` / `plan_is_qbo_only()` / `course_object_allowed()` helpers; **tightens** `courses_read`/`modules_read`/`lessons_read` + the private `course_videos_read` (no-arg helpers wrapped `(select …)` → one InitPlan/query) so a `core_self_paced` member reads only `qbo-*` courses (higher-tier `resume-*`/`interview-*` denied). Server half of the per-plan entitlement model (client half = `PLAN_ENTITLEMENTS` in `src/BookkeeperPro.jsx`) | #13 (`subscriptions.ends_at`, `is_enrolled()`), #15 (`course-videos`) — **needs #13 for `ends_at`; guard aborts with a clear message if #13 not run** |
| 18 | [`2026-07-10-subscription-grace.sql`](2026-07-10-subscription-grace.sql) | **3-day grace period** — flips `approve_subscription()`'s grace knob `v_grace_days` 0→3 (new/renewed terms stamp `grace_ends_at = ends_at + 3 days`) + backfills currently-running dated terms. `is_enrolled()`/`current_plan_key()`/`expire_overdue_subscriptions()` already honor grace via `coalesce(grace_ends_at, ends_at)` — unchanged | #13 (`subscriptions.grace_ends_at`, `approve_subscription()`) — **guard aborts if #13 not run** |
| 19 | [`2026-07-11-sampler-essentials-access.sql`](2026-07-11-sampler-essentials-access.sql) | **Sampler course scope** — adds `courses.access_tier` (`'standard'`/`'essentials'`) + `plan_is_sampler()`; rewrites `course_object_allowed()`; **tightens** `courses_read`/`modules_read`/`lessons_read` + `course_videos_read` so a `sampler` member reads only `qbo-*` courses with `access_tier='essentials'` (QBO **Essentials** only, not Mastery). Client half = `PLAN_ENTITLEMENTS.sampler` + `courses.access_tier` in `COURSE_ROW_SELECT` | #17 (`current_plan_key()`), #15 (`course-videos`) — **guard aborts if #17 not run** |
| 20 | [`2026-07-11-account-membership-requests.sql`](2026-07-11-account-membership-requests.sql) | **Self-serve Extend Access + Upgrade Plan** — adds `enrollment_requests.request_kind` (`new`/`renewal`/`upgrade`/`extension`) + `extension_days`; `approve_extension(user, request_id, days)` RPC (SECURITY DEFINER, admin-guard; adds custom days on the SAME plan, stacked from the current expiry / from now if expired, 3-day grace). Upgrade reuses `approve_subscription()`. No new RLS (existing student-insert / admin-all policies cover the columns). Client half = the sidebar account menu + `ExtendAccessModal` / paywall `mode="upgrade"` in `src/BookkeeperPro.jsx` | #13 (`approve_subscription`), #18 (grace-3), #16 (`enrollment_requests`) — **guard aborts if `enrollment_requests`/`subscriptions`/`approve_subscription` missing** |
| 21 | [`2026-07-11-hardening.sql`](2026-07-11-hardening.sql) | **Extension-length cap** — replaces `approve_extension()` with a strict superset that rejects `p_days` outside **60–365** (the request's `extension_days` is student-declared; #20 only enforced the minimum) + a guarded range CHECK constraint on `enrollment_requests.extension_days`. No signature/semantics change otherwise | #20 (`approve_extension`) — **guard aborts if #20 not run** |
| 22 | [`2026-07-20-sampler-support-60-days.sql`](2026-07-20-sampler-support-60-days.sql) | **Sampler support 30 → 60 days** — data-only UPDATE on the live `enrollment_plans` sampler row: `support_days` 30→60 + the "30-day group chat support" bullet in `features`/`entitlement_summary` → "60-day". Needed on existing installs because the plan seeds are first-run-only; fresh installs get 60 from the bootstrap/seed sources directly | #13 (`support_days` column) — **guard aborts if #13 not run** |
| 23 | [`2026-07-20-community.sql`](2026-07-20-community.sql) | **Community feed** — `community_tags` (9 seeded categories; `admin_only` = Announcements) + `community_posts`/`community_comments` (denormalized `author_name`, status `active`/`hidden`/`deleted`) + `community_reactions` (unique per post/user/type) + indexes + RLS (read/insert/update gated by `is_approved()` + `is_enrolled()` — every active paid plan; Announcements posting enforced admin-only in-policy; members soft-delete only, admins moderate via `_admin_all`) + realtime on posts/comments. Client half = `CommunityHub` (route `/community`) in `src/BookkeeperPro.jsx` | #9 (`is_approved()`), #12+#13 (`is_enrolled()`) — **guard aborts if helpers missing** |
| 24 | [`2026-07-21-community-forum.sql`](2026-07-21-community-forum.sql) | **Community forum upgrade** — category taxonomy (adds `course-questions`; `questions` → "General Questions"); `community_posts.pinned`/`comments_locked`/`comment_count`/`last_activity_at`/`author_avatar_url` (+ backfills, guarded server-side by `community_posts_guard()` + `community_comment_rollup()`); `community_stamp_author()` superset (stamps avatar too); `community_notifications` (reply/mention fan-out written ONLY by SECURITY DEFINER triggers — no insert policy) + `community_announcement_reads` + `community_attachments` (image/video/link) + `community_post_tags` (free-form slugs); comment reactions (`community_reactions.comment_id` + XOR check + partial unique index); `set_my_avatar()` RPC (the one sanctioned user-facing `profiles` write) + `search_community_members()` mention directory (name + avatar, never email); **avatars** bucket (public, 5 MB images) + **community-media** bucket (private, 50 MB image/video) + policies; realtime on `community_notifications`. Client half = the forum `CommunityHub` + `MemberAvatar` + notification bell in `src/BookkeeperPro.jsx` | #23 — **guard aborts if #23 not run** |
| 25 | [`2026-07-22-community-hardening.sql`](2026-07-22-community-hardening.sql) | **Forum perf + privacy hardening** (post-deploy review) — `community_category_counts()` RPC (server-side GROUP BY for the sidebar counts, replacing the client's up-to-5000-row `tag_slug` pull) + `pg_trgm` extension & `profiles_full_name_trgm` GIN index (mention-search `ILIKE '%q%'` becomes index-assisted); adds the parent-active EXISTS guard to `community_reactions_read` (hiding a post now also hides who reacted — matches the sibling read policies); adds the `is_approved()`+`is_enrolled()` gate to the three own-delete policies (`community_reactions`/`community_attachments`/`community_post_tags`) so expired members can't delete their own rows. Client half = `community_category_counts()` call + memoized `CommunityTopicRow` + bounded `loadMeta`/realtime in `src/BookkeeperPro.jsx` | #24 — **guard aborts if #24 not run** |
| 26 | [`2026-07-23-student-imports.sql`](2026-07-23-student-imports.sql) | **Admin Student Import (Thinkific migration)** — `student_import_jobs`/`student_import_rows` (staged upload + per-row proposal + resumable `cursor`), `student_external_accounts` (durable `unique(source, external_user_id)` link — the idempotency anchor), `student_import_events` (immutable admin audit — no update/delete policy). Adds `subscriptions.grant_source`/`source_import_row_id` (+ a **partial** `unique(source_import_row_id)` index = one grant per import row) so imported terms are marked + idempotent **without touching** `approve_subscription()`/`approve_extension()`. Adds `profiles.account_origin`/`onboarding_status`/`invited_at`/`onboarding_completed_at` (the forced set-password gate) + the narrow `complete_import_onboarding()` SECURITY DEFINER RPC. All new tables RLS admin-only (jobs/rows/events) with a self-read on `student_external_accounts`. Server half = `api/admin/student-imports.js` (service-role, admin-verified) + `src/lib/studentImport.js`; client half = the `StudentImports` wizard in `src/BookkeeperPro.jsx` | #13 (`subscriptions.ends_at`, `is_enrolled()`), #12 (`enrollment_plans`) — **guard aborts if subscription-lifecycle not run** |

| 27 | [`2026-07-24-course-ai-trainer.sql`](2026-07-24-course-ai-trainer.sql) | **AI Course Trainer** — `vector` extension (pgvector, extensions schema) + `courses.ai_trainer_enabled` (per-course opt-in); `course_ai_sources` (admin-reviewed teaching text: lesson_text / transcript / trainer_notes, status/version/hash) → `course_ai_chunks` (bounded chunks + nullable `vector(384)` embedding + generated tsvector FTS fallback; **no learner RLS path at all**) → `course_ai_index_jobs` (bounded async re-index queue); `ai_training_checkpoints` (per-user resume rows, own-read, service-written — deliberately separate from `lesson_progress`) + `ai_training_usage` (durable per-user daily counters); SERVICE-ROLE-ONLY parameterized entitlement/retrieval fns (`user_is_enrolled`/`user_plan_key`/`user_is_approved`/`trainer_visible_courses`/`trainer_courses_for_plan`/`trainer_match_chunks(_fts)`/`trainer_lesson_chunks`/`trainer_preview_chunks`/`trainer_bump_usage` — mirror `courses_read` EXACTLY; revoked from anon/authenticated) + the pure-SQL `course_ai_mark_lesson_stale()` trigger. (The brief's `ai_training_sessions` concept is realized as usage counters + checkpoints.) Server half = `api/elevenlabs/trainer.js` (webhook tools, fail-closed) + `api/admin/course-trainer.js` (sync/transcribe/preview); client half = the voice trainer tools + `CourseAiTrainerPanel` in `src/BookkeeperPro.jsx` | #13 (`subscriptions.ends_at`), #17 (`current_plan_key()`), #19 (`courses.access_tier`) — **guard aborts if any is missing** |

| 28 | [`2026-07-26-community-write-gate.sql`](2026-07-26-community-write-gate.sql) | **Community write-gate fix** — adds the `is_approved()`+`is_enrolled()` gate (matching the #25 own-delete fix) to the two own-**update** policies `community_posts_own_update` + `community_comments_own_update`, so an expired member with a still-valid JWT can no longer edit or soft-delete (`status='deleted'`) their own posts/comments via REST. Additive; policy-only (no row/schema change). Client half: none (RLS-only). | #23 — **guard aborts if community base tables missing** |
| 29 | [`2026-07-26-rls-initplan-and-indexes.sql`](2026-07-26-rls-initplan-and-indexes.sql) | **RLS initplan wraps + index pass** (2026-07-26 backend audit) — rewrites the 42 policies that still called `auth.uid()`/`is_admin()`/`is_approved()`/`is_enrolled()`/`plan_is_*()` bare, wrapping every zero-arg call `(select …)` so it evaluates once per statement instead of once per row (each ALTER POLICY is guarded — missing policies skip with a NOTICE); adds the `enrollment_requests(user_id, created_at desc)` hot-path index (the enrollment gate's own-latest-request read) + 21 FK covering indexes (cascade-delete paths: course/community/import/subscriptions children); drops 5 duplicate/PK-redundant indexes. No semantic change to any policy. | #20/#21 for full coverage (earlier installs: the guards skip what's missing) |
| 30 | [`2026-07-26-backend-hardening.sql`](2026-07-26-backend-hardening.sql) | **Integrity + grant + storage hardening** (same audit) — `subscriptions.plan_key` FK → `enrollment_plans(key)` (a typo'd key could grant a permanent full-access term); CHECK constraints (`courses.access_tier` enum, `enrollment_plans.access_days > 0` + NOT NULL, non-negative money columns); `student_import_events.job_id` FK CASCADE → **SET NULL** (audit rows survive a job purge); revokes the default `anon` EXECUTE from all member/admin RPCs and ALL API execute from trigger-only functions (gate helpers keep anon — they run inside RLS evaluation); scopes the `avatars` (own-folder-or-admin) + `course-media` (admin) storage **read** policies so anonymous visitors can't enumerate objects/UIDs (public-URL serving unaffected); 50 MB + image/video MIME limits on `course-media`. | #29 (wrapped-policy baseline), #26 (`student_import_events`) — guards skip what's missing |
| 31 | [`2026-07-26-schema-migrations-log.sql`](2026-07-26-schema-migrations-log.sql) | **Migration apply-log** — `public.schema_migrations` (filename PK, sha256, applied_at, notes; RLS admin-read, no API write path) + a backfill of every file confirmed applied as of 2026-07-26. **Rule going forward: every time you run a dated file against an environment, insert its row in the same session** (new files should end with their own guarded insert — pattern at the tail of the file). This exists because #20/#21 sat unapplied for two weeks with zero visibility (the Extend Access over-grant). | none (independent) |
| 32 | [`2026-07-28-community-spaces-batches.sql`](2026-07-28-community-spaces-batches.sql) | **Community spaces + batches (automatic student segregation)** — `batches` (cohort registry `2026-08` → "August 2026"; open/closed/archived + optional gold/vip capacities; creating one auto-creates its Gold + VIP spaces via `batches_create_spaces()`), `community_spaces` (one `general` + one `gold`/`vip` per batch; capability flags `member_posting`/`member_comments`/`member_reactions` read INSIDE the insert policies — General ships replies-off), `batch_events` (immutable admin audit), `enrollment_plans.community_segment` (`gold_live`→gold, `vip`→vip), `batch_id` on `subscriptions`/`enrollment_requests` (+ `student_import_rows.proposed_batch_id`), `space_id` denormalized onto posts/comments/notifications (trigger-stamped + frozen; backfilled to General). Access is DERIVED per query by `user_community_space_ids(p_user)`/`my_community_space_ids()` (no membership table — expiry/grace/downgrade apply instantly); every community policy + `community-media` storage policy rewritten space-aware; notify triggers drop cross-space mention uuids; `search_community_members(p_query, p_space_id)` + `community_category_counts(p_space_id)` replace the old signatures (default params keep old clients resolving). **`admin_finalize_enrollment(request, batch)`** = the ONE transactional approval (validates request+plan+batch+capacity, wraps `approve_subscription`/`approve_extension`, stamps batch, patches profile + request atomically — replaces the client 3-step approve AND its local-grant fallback); `admin_assign_batch()` (idempotent bulk needs-batch assignment + audit) + `admin_batch_overview()`. Seeds the General space + the open `2026-08` batch. Client half = the CommunityHub space switcher (`?space=`), paywall/approve-modal batch pickers, the Admin → Batches tab, and the import `batch_code` column — **these ship in the app bundle, so the SQL alone does not deliver the feature; deploy the matching build.** Capacity is checked ONLY on the two admin RPC paths (approval + `admin_assign_batch`) — imports and direct SQL grants do not consume seats. | #12 + #13 + #20 + #23/#24 + #30 — **guard aborts if any is missing**; run after #29/#31 |
| 33 | [`2026-07-29-community-batch-hardening.sql`](2026-07-29-community-batch-hardening.sql) | **Community batch hardening (follow-up to #32)** — `admin_finalize_enrollment()` now decides "new assignment" by whether the member currently **occupies a counted seat** (status + the `is_enrolled()` date math) rather than whether the batch id is changing: an EXPIRED member renewing into their old batch previously skipped both the open-batch check and the capacity count while being excluded from that same count, so a capped batch could be oversold and a closed batch silently accepted returning members. Also: `community_attachments_own_insert` binds `storage_path` to the uploader (and, for `<space_id>/<uid>/…` paths, to the post's space) so an attachment row can't be pointed at another space's object to unlock reads on it; `search_community_members()` rebuilt set-based (it called the SECURITY DEFINER `user_community_space_ids()` once per candidate row, and an empty query matches every profile); `community_notifications` UPDATE narrowed to `grant update (read_at)` (a member could null their own `space_id`, which the SELECT policy treats as visible); the three own-DELETE policies brought into the space model; `batches.code` CHECK tightened to a real month (`2026-13` used to pass); safer uuid cast in `community_media_own_insert`; FK index on `student_import_rows.proposed_batch_id`. Additive + idempotent. | #32 + #31 — **guard aborts if either is missing** |

| 34 | [`2026-07-29-batch-hardening-followup.sql`](2026-07-29-batch-hardening-followup.sql) | **Corrects #33's `admin_finalize_enrollment` rewrite.** #33 reconstructed the function's tail instead of copying #32's, silently dropping `updated_at = now()` (on `subscriptions`, `profiles` and `enrollment_requests`), the `rejected_at`/`rejected_by` clearing, `rejection_reason = null` on the request, and turning `approved_at`/`approved_by` into first-approval semantics — so a user rejected in Access Requests and later approved through Enrollments kept contradictory state. This restores #32's body **verbatim** and re-applies only the intended `v_holds_seat` seat-occupancy change. Also gates `community_media_delete` (approved + enrolled + space access) to match `community_attachments_own_delete`, which #33's own-DELETE sweep had missed — previously an expired member could delete the storage object but not its attachment row, leaving dangling rows and broken media. Additive + idempotent. | #33 + #31 |
| 35 | [`2026-07-30-batch-entitlements.sql`](2026-07-30-batch-entitlements.sql) | **The cohort-entitlement ledger — L1, THE authoritative entitlement source.** Replaces the single mutable `subscriptions.batch_id` with append-only `batch_entitlements`: one row = one seat in one cohort, stamped with WHY (`grant_reason` + source subscription/request/import row), WHERE in the purchased run (`batch_index`/`run_id`), and HOW LONG (`valid_until`). A 180-day Gold plan now grants **six** monthly cohorts (`plan_batch_count` = `coalesce(eligible_batch_count, ceil(access_days/30))`), and reassignment **supersedes** rather than overwrites, so history survives. Runs are allocated from the batches **registry** in `code` order — never by calendar arithmetic, which would infer a batch from a date and promise cohorts that may never run; a shortfall is recorded as a `queued` seat and bound FIFO when the next batch opens. Both the access and occupancy predicates require the stamped `segment` to equal the member's **LIVE plan segment**, so a downgrade/refund cuts premium access instantly (#32 had this property for free; stamping loses it). `grant_batch_run()` is the ONLY function that locks `batches`, always in ascending `code` order — `admin_finalize_enrollment` no longer takes its own lock, removing a lock-order inversion two concurrent approvals could deadlock on. `admin_assign_batch` and the import path route through the same allocator (one writer, one reader). Adds `app_error()`/`app_error_catalog()` — stable codes carried in SQLSTATE `PT###` + `hint` (**branch on `hint`, never on HTTP status**). `authenticated` gets SELECT on own rows and nothing else: the DML revoke is explicit, because Supabase's default grants survive a missing policy. Additive + idempotent; `subscriptions.batch_id` keeps working as a read bridge for members with no ledger rows. | #34 + #31 + #27 — **guard aborts if any is missing**, and asserts #27's `user_is_enrolled/approved/plan_key` bodies are unchanged rather than redefining them |
| 36 | [`2026-07-31-community-plan-capabilities.sql`](2026-07-31-community-plan-capabilities.sql) | **Per-PLAN community capabilities + General as an announcement space (D2).** Until now a member's rights came only from the three `community_spaces` flags, which are per-space — so inside the shared General space every plan necessarily had identical rights, and the product rule was inexpressible. Adds seven **fail-closed** booleans to `enrollment_plans` (`can_post_in_general`, `can_comment_in_general`, `can_react_in_general`, `can_post_in_private`, `can_comment_in_private`, `can_react_in_private`, `can_upload_attachments`) and fuses plan × space in ONE resolver, `user_community_capabilities()`, which every write policy consumes as an **uncorrelated** subquery (InitPlan once per statement). **D2:** no member — not Core, Sampler, Silver, **nor Gold or VIP** — may post or comment in General; reactions stay on for everyone; admins still post. Applied as data **plus a CHECK constraint**, because production had drifted here: #32 seeded `member_comments = false` and a "temporary softening" UPDATE set it back to true and was never reverted. Own-UPDATE is **split into withdraw vs keep-published** so historical General posts stay author-withdrawable instead of stranded. ★ Also fixes a latent bug: Postgres refuses an UPDATE whose resulting row would be invisible to the writer, and `community_posts_read` admitted only `status='active'` — so the member soft-delete documented in #24/#28 **could never have worked**. The posts and comments read policies gain an author-owns-`deleted` branch. `my_community_spaces()` rebuilt (DROP+CREATE — **re-grant required**) to return the effective `can_*` per space so the UI and the database cannot disagree; `search_community_members()` now requires a space, requires create rights in it, refuses General, and needs ≥2 characters. Additive; no row is deleted. | #35 + #31 |

| 37 | [`2026-08-01-entitlement-hardening.sql`](2026-08-01-entitlement-hardening.sql) | **Code-review corrections to #35/#36.** ① Restores the three conjuncts #36 dropped from `community_attachments_own_insert` — `uploader_id = auth.uid()` (the column is NOT NULL and client-supplied, with no stamping trigger, so it was forgeable, and the own-DELETE policy keys on it), the `storage_path is null` branch (the table CHECK makes a LINK attachment's path NULL, so `foldername(NULL)[1] = uid` → NULL → **link attachments were impossible to create**), and the `[1] = p.space_id` binding on two-level paths. #36's `can_attach` gate is kept. ② Restores #33's uuid-shaped space check (and its regex guard, which turns a would-be 22P02 500 into a clean 403) on `community_media_own_insert`. ③ `revoke_batch_run` clears `subscriptions.batch_id` **only on a real revoke** — a segment-changing upgrade supersedes then re-grants, and clearing the cache in that window left every upgrade at `missing_cache` in the drift view forever, blocking the #39 gate. Safe because the bridge is disabled by ANY ledger row. ④ The FIFO binder is **forward-only within a run**, so a batch created for a PAST month (plausible during historical imports) can no longer absorb queued seats out of order and already-active. ⑤ `admin_grant_batch_run` raises `ALREADY_ENTITLED` instead of minting a duplicate run — the one-seat-per-cohort unique index only covers BOUND seats, so a repeat call fell through to the shortfall path. Also makes `my_community_spaces()`'s General `member_count` set-based (it was one SECDEF `user_is_enrolled()` call per profile, on every community load). Additive + idempotent. | #36 + #31 |


**Migration order in one line:** `#1 → #2 → #3 → #4 → #5 → #6 → #7 → #8 → #9 → #10 → #11 → #12 → #13 → #14 → #15 → #16 → #17 → #18 → #19 → #20 → #21 → #22 → #23 → #24 → #25 → #26 → #27 → #28 → #29 → #30 → #31 → #32 → #33 → #34`
(feature-guides before user-approval; user-approval before enrollment; enrollment before subscription-lifecycle; the three 2026-07-08 files need enrollment/`is_enrolled()`; plan-course-access (#17) + subscription-grace (#18) both need subscription-lifecycle; sampler-essentials (#19) needs plan-course-access; account-membership-requests (#20) needs enrollment + `approve_subscription`; hardening (#21) replaces #20's `approve_extension`; sampler-support-60 (#22) + community (#23) both need subscription-lifecycle's columns/helpers; community-forum (#24) extends #23's tables; community-hardening (#25) extends #24's tables/policies; student-imports (#26) needs subscription-lifecycle; course-ai-trainer (#27) needs #13 + #17 + #19; community-write-gate (#28) gates the two community own-update policies, needs #23; rls-initplan-and-indexes (#29) re-asserts policies from the whole chain; backend-hardening (#30) builds on #29's wrapped baseline; schema-migrations-log (#31) is independent — run it everywhere and keep it current; community-spaces-batches (#32) needs #12 + #13 + #20 + #23/#24 + #30 and re-asserts the community policies space-aware, so run it after #29/#31; community-batch-hardening (#33) patches #32's approval RPC + policies, so it must run after #32 — and it guards on #31 because its own apply-log insert would otherwise abort the whole file; batch-hardening-followup (#34) corrects #33's copy of `admin_finalize_enrollment`, so **always run #34 immediately after #33** — #33 alone leaves the approval RPC missing its `updated_at`/`rejected_*` housekeeping).

---

## How the bootstrap relates to the dated files

`000_full_database_bootstrap.sql` is the **collapsed final state** of files #1–#37 (#33, #34, #35, #36
and #37 are folded verbatim as §20–§24 — a fresh install must NOT re-run them). Where an object is
redefined across the dated chain, the bootstrap keeps only the **final** version, defined once —
except the 2026-07-26 backend pass (#29/#30/#31), which is **folded verbatim as §18 at the tail**, and
community-spaces-batches (#32), folded **verbatim as §19 after it** (deliberately LAST — §15b/§18
create/re-touch the pre-#32 community policy shapes, and §19's space-aware DROP+CREATE must win on a
fresh install; the files are idempotent and self-guarded, so appending them reproduces the live end
state exactly; when one of those files changes, re-fold it):

- **`is_enrolled()`** — the date-aware version from #13 (an active, non-expired subscription), not the
  simple `is_admin or is_paid` version from #12.
- **`approve_subscription()`** — the #18 form with the grace knob `v_grace_days = 3` (every granted term
  gets `grace_ends_at = ends_at + 3 days`), not the #13 grace-off (`= 0`) version.
- **`courses_read` / `modules_read` / `lessons_read`** — the #19 shape: `(select is_admin()) OR
  (published AND (select is_approved()) AND (select is_enrolled()) AND (not (select plan_is_qbo_only())
  OR slug like 'qbo-%') AND (not (select plan_is_sampler()) OR (slug like 'qbo-%' AND access_tier =
  'essentials')))` (`(select …)`-wrapped for once-per-query InitPlans), never the intermediate
  base/`is_approved()`-only/pre-plan-scope shapes.
- **`feature_guides_read`** — `is_approved() AND is_enrolled()`.
- **`enrollment_receipts` delete** — admin-only (the #14 shape), not the original owner-or-admin delete.
- **`course-videos`** — the #15 private bucket + `course_videos_*` policies, with `course_videos_read`
  in its #19 plan-scoped form (`(select is_admin()) OR ((select is_enrolled()) AND ((not (select
  plan_is_qbo_only()) AND not (select plan_is_sampler())) OR course_object_allowed(name)))`).
- **`courses.access_tier`** — `'standard'` default (premium; incl. the `qbo-mastery` seed) vs
  `'essentials'` (Sampler-accessible), from #19.
- **`current_plan_key()` / `plan_is_qbo_only()` / `plan_is_sampler()` / `course_object_allowed()`** — the
  #17 + #19 plan-scope helpers (server half of per-plan entitlements; core_self_paced → qbo-* courses,
  sampler → qbo-* Essentials-tier only). The older `course_plan_allowed(text)` is dropped at the end of
  the bootstrap/#17 (superseded).
- **`enrollment_requests.request_kind` / `extension_days` + `approve_extension()`** — net-new in #20
  (self-serve Extend Access / Upgrade Plan); folded into the `enrollment_requests` table and the
  lifecycle-functions section. `approve_extension()` is kept in its **#21 form** (60–365 day cap on
  `p_days`), and `extension_days` carries the #21 range CHECK inline in the table definition — never
  the #20 uncapped version.
- **Sampler `enrollment_plans` seed** — 60-day support (the #22 values: `support_days = 60` + "60-day
  group chat support" in `features`/`entitlement_summary`) directly in the seed, so the #22 data fix
  never applies to a fresh install (its guarded UPDATEs match nothing).
- **Community forum (§15b)** — the eight `community_*` tables in their **#24 + #25 final shape** (forum
  columns, notifications, announcement reads, attachments, free-form post tags, comment-capable
  reactions), the 10-category seed (`course-questions` included, `questions` seeded as "General
  Questions"), the guard/rollup/notify triggers, the `set_my_avatar()` / `search_community_members()` /
  `community_category_counts()` RPCs, the `profiles_full_name_trgm` GIN index (`pg_trgm`), the #25
  parent-active guard on `community_reactions_read`, the enrollment gate on the three own-delete
  policies (#25) and the two own-update policies (#28), the `avatars` (§5) + `community-media` (§14b) buckets, and the realtime adds for
  `community_posts`/`community_comments`/`community_notifications` — never the #23 feed-only shape.
- **Student import (#26)** — the four `student_*` tables (jobs/rows/external_accounts/events) in their
  final RLS shape, `subscriptions.grant_source`/`source_import_row_id` + the partial
  `subscriptions_one_import_grant` unique index folded into the subscriptions section, the four
  `profiles` onboarding columns folded into the profiles section, and the `complete_import_onboarding()`
  RPC. The import path grants terms via admin-verified service-role INSERTs (see
  `api/admin/student-imports.js`), not a SECURITY DEFINER RPC.
- **AI course trainer (#27)** — the `vector` extension in §0, `courses.ai_trainer_enabled` folded into
  the §4 courses table, and the whole trainer schema (sources/chunks/jobs/checkpoints/usage, the
  service-role-only parameterized entitlement + retrieval functions, the stale trigger) as §16b. The
  parameterized functions mirror the §14 `courses_read` policy — when a future migration changes the
  plan-scope rules, BOTH must change together.

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
- [../COMMUNITY_SETUP.md](../COMMUNITY_SETUP.md) — in-app community forum (posts/comments/reactions/categories, attachments, mentions, notifications, avatars) + the #32 spaces & batches model (General vs private Gold/VIP batch communities).
- [../STUDENT_IMPORT_SETUP.md](../STUDENT_IMPORT_SETUP.md) — admin Thinkific → Toolkit student migration (service-role env, redirect URL, dry-run, pilot, resume/retry, rollout).
- [../COURSE_AI_TRAINER_SETUP.md](../COURSE_AI_TRAINER_SETUP.md) — AI voice course trainer (trainer token env, the `trainer-embed` Edge Function, ElevenLabs webhook-tool provisioning, per-course enable + sync + transcripts).

## Feature flags (schema is fully gated by default)

Both default **ON** — rebuild after changing either (`VITE_*` vars inline at build time). RLS remains the
real boundary regardless.

- `VITE_REQUIRE_ADMIN_APPROVAL=false` — disables the admin-approval gate.
- `VITE_REQUIRE_ENROLLMENT=false` — disables the enrollment paywall.
