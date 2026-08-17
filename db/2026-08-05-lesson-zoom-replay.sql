-- ═══════════════════════════════════════════════════════════════════════════
-- #37b — course_lessons.zoom_replay_url  (RECONSTRUCTED 2026-08-17)
--
-- ⚠️ THIS FILE IS A RECORDING, NOT A NEW CHANGE.
--   The original ran against production on 2026-08-05 01:03 UTC and wrote its
--   own public.schema_migrations row — and was then never committed. It is not
--   in git on any branch; there are no commits at all between 2026-08-01 and
--   2026-08-10. `npm run db:audit` surfaced it on 2026-08-17 as a log row with
--   no file: the exact mirror of the #20/#21 incident that motivated #31. There,
--   a file claimed to have run and had not. Here, something ran and left no file.
--
--   Consequence while the gap was open: db/000_full_database_bootstrap.sql could
--   not reproduce production, so a fresh install — and `npm run db:shadow:verify`
--   — would have differed by this column. This file closes that gap.
--
-- WHAT IT RECREATES
--   Exactly what production already holds, verified column-by-column against the
--   live catalog before this was written:
--     course_lessons.zoom_replay_url   text, nullable, no default,
--                                      no CHECK, no index, plus its COMMENT.
--   Every statement is therefore a no-op against production. It matters for a
--   FRESH install and for the shadow project, where the column would otherwise
--   never appear.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does not restore the feature. The client half described in the original's
--   log notes — src/lib/lessonReplay.js (https-only URL validation and host
--   classification), the COURSE_LESSON_SELECT addition, the lesson-editor field
--   and the LessonReplayLink renderer — was lost with the original and is NOT
--   reconstructed here. The column is dormant: 0 of 143 lessons carry a value,
--   and nothing in src/ reads or writes it. Recording the schema and rebuilding
--   the feature are separate decisions; this is only the first.
--
-- WHY NO CHECK AND NO INDEX (preserved from the original's reasoning, which
-- survives in the live column comment)
--   The column is never queried BY VALUE — it is selected with the lesson row and
--   rendered, so an index would be dead weight on a hot write path. URL safety is
--   enforced in the renderer rather than the database because the rule ("absolute
--   https, Zoom hosts linked and never embedded") is about how the value is
--   DISPLAYED, which SQL cannot express. lessons_read / lessons_admin_write are
--   row-scoped and the grants are table-level, so the column is covered the
--   moment it exists — no policy change is needed or wanted.
--
-- NUMBERING — read this before renumbering anything
--   The original called itself "#38". So does db/2026-08-16-batch-lifecycle.sql,
--   written eleven days later by someone who could not see the first file because
--   it was not in the repo. Batch-lifecycle keeps #38: that label is already
--   baked into production's schema_migrations notes, into the check labels in
--   scripts/audit-db.mjs, and into ~15 references in CLAUDE.md. This file takes
--   #37b instead, which is also chronologically honest — it landed after #37
--   (2026-08-01) and before #38 (2026-08-16).
--
-- ORDER
--   Needs only #2 (course_lessons). Additive, idempotent, non-destructive.
--   Safe to run before or after #38 — they touch unrelated tables.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Guard.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.course_lessons') is null then
    raise exception '#37b requires #2 — run db/2026-06-16-course-platform-base.sql first.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) The column. Nullable, no default: a lesson without a replay link is the
--    normal case, and NULL is what "there isn't one" means.
-- ───────────────────────────────────────────────────────────────────
alter table public.course_lessons
  add column if not exists zoom_replay_url text;

-- ───────────────────────────────────────────────────────────────────
-- 2) The comment, restored verbatim from the live column except for the file
--    reference, which pointed at "(#38)" — a number this file no longer uses.
-- ───────────────────────────────────────────────────────────────────
comment on column public.course_lessons.zoom_replay_url is
  'Optional supplementary "Zoom Live Replay" link, rendered BELOW the lesson content and ABOVE the '
  'completion controls. Never replaces video_url/video_provider/storage_path and never affects '
  'lesson_progress/course_completions/certificates. Validated and classified client-side by '
  'src/lib/lessonReplay.js (absolute https only; Zoom hosts are linked, never embedded, because Zoom '
  'recording pages set X-Frame-Options). Deliberately has no CHECK constraint and no index — see the '
  'header of db/2026-08-05-lesson-zoom-replay.sql (#37b). NOTE: as of 2026-08-17 the client half of '
  'this feature is not present in the repo; the column is dormant.';

-- ───────────────────────────────────────────────────────────────────
-- 3) Refresh PostgREST so a fresh install exposes the column immediately.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   -- ① the column exists and is dormant
--   select count(*) as lessons, count(zoom_replay_url) as with_link
--     from public.course_lessons;
--
--   -- ② no orphan log rows remain
--   npm run db:audit          -- "log rows with no file" must read: none
-- ═══════════════════════════════════════════════════════════════════

-- ★ ON CONFLICT DO NOTHING, unlike every other file in this directory.
-- Production ALREADY has this row — the original wrote it on 2026-08-05. A plain
-- insert would abort with 23505 on the one database this file exists to describe,
-- and filename is the primary key. The clause is what makes this reconstruction
-- runnable everywhere: a no-op on prod, a real log row on a fresh install.
insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-05-lesson-zoom-replay.sql', null,
  'adds course_lessons.zoom_replay_url (nullable text, no default, no CHECK, no index) — the optional '
  '"Zoom Live Replay" supplementary link. RECONSTRUCTED 2026-08-17 from the live schema after '
  'npm run db:audit found this apply-log row with no corresponding file: the original ran on '
  '2026-08-05 and was never committed to git. Schema only — the client half (src/lib/lessonReplay.js, '
  'COURSE_LESSON_SELECT, LessonReplayLink) was lost with it and is NOT restored, so the column is '
  'dormant. Renumbered #38 -> #37b because 2026-08-16-batch-lifecycle.sql independently claimed #38.')
on conflict (filename) do nothing;
