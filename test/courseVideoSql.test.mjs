// ─────────────────────────────────────────────────────────────────────────────
// The course-video constants and the SQL that binds them must agree.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXISTS
//   src/lib/courseVideo.js promises the admin a 2 GB MP4 upload. The bucket that
//   has to accept it is configured by a SQL literal in #44 — restated across two
//   files, because the bootstrap fold is what a FRESH install gets and it is
//   folded by hand. Nothing else pins the pair: db:shadow:verify never compares
//   bucket rows, and db:audit needs credentials.
//
// WHAT BREAKS IF THEY DRIFT
//   Lower the SQL number, or leave the browser's cap above it, and the uploader
//   accepts a file, spends ten minutes transferring it over a resumable upload,
//   and takes a 413 near the end. The UI has already promised the size, so the
//   admin has no reason to suspect the file — they retry, and lose the ten
//   minutes again. Narrow allowed_mime_types below what the picker offers and
//   the same thing happens instantly instead of slowly.
//
//   The storage path is the same class of bug in the other direction: the client
//   builds `lessons/<course-uuid>/<upload-uuid>-<name>` and the #44 trigger
//   re-checks that shape with its own regex. If the two disagree, a file that
//   uploaded perfectly is refused at save time, after the bytes are already in
//   the bucket — where it becomes an orphan nothing references.
//
//   And the three app_error codes: a code raised by SQL that APP_ERROR_CODES
//   does not know falls back to the raw envelope, so the admin reads
//   "Hint: LESSON_VIDEO_UPLOAD_ONLY — (code PT409)" instead of a sentence.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LESSON_VIDEO_MAX_BYTES,
  LESSON_VIDEO_MIME,
  LESSON_VIDEO_BUCKET,
  buildLessonVideoPath,
  isLessonVideoPath,
} from '../src/lib/courseVideo.js';
import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Both files must carry it. The dated file is what an existing install runs;
// the bootstrap fold is what a fresh install runs, and it is the one a re-fold
// can silently truncate (see test/bootstrapFolds.test.mjs).
const SQL_FILES = [
  'db/2026-08-24-course-video-upload-only.sql',
  'db/000_full_database_bootstrap.sql',
];

const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

/** Executable SQL only — the header prose quotes SQL, and must not be matched as SQL. */
const statementsOf = (sql) => sql
  .split('\n')
  .filter(l => !l.trimStart().startsWith('--'))
  .join('\n');

/**
 * The `insert into storage.buckets … values (…)` row for one bucket — the LAST
 * one in the file.
 *
 * ★ The bootstrap configures course-videos TWICE: §14b creates it (50 MB, five
 *   video mimes, from #15) and §31 corrects it via `on conflict (id) do update`.
 *   Last writer wins at runtime, so the last occurrence is the one that decides
 *   what the bucket actually accepts — asserting on the first would pin the
 *   value #44 exists to replace.
 */
function bucketValues(sql, bucketId) {
  const re = new RegExp(
    String.raw`insert into storage\.buckets[\s\S]{0,400}?values\s*\(\s*'${bucketId}'([\s\S]*?)\)\s*\n\s*on conflict`,
    'gi',
  );
  let last = null;
  for (const m of statementsOf(sql).matchAll(re)) last = m[1];
  return last;
}

// ── The size cap ────────────────────────────────────────────────────────────

test('every SQL file caps the video bucket at exactly the number the browser promises', () => {
  for (const file of SQL_FILES) {
    const values = bucketValues(read(file), 'course-videos');
    assert.ok(values, `${file} must configure the ${LESSON_VIDEO_BUCKET} bucket`);
    assert.ok(
      values.includes(String(LESSON_VIDEO_MAX_BYTES)),
      `${file} must set file_size_limit to ${LESSON_VIDEO_MAX_BYTES} — the exact byte count `
      + 'LESSON_VIDEO_MAX_BYTES promises the admin before the transfer starts',
    );
  }
});

test('the bucket re-asserts its limits, which #15 never did', () => {
  // #15 wrote `on conflict (id) do update set public = false` and nothing else,
  // so file_size_limit and allowed_mime_types were write-once from creation and
  // no file in this repo could correct a drifted bucket.
  const sql = statementsOf(read(SQL_FILES[0]));
  const m = /on conflict \(id\) do update([\s\S]*?);/i.exec(sql);
  assert.ok(m, 'the bucket insert must carry an on-conflict update');
  assert.match(m[1], /file_size_limit\s*=\s*excluded\.file_size_limit/i,
    'a re-run must correct a drifted size limit, not skip it');
  assert.match(m[1], /allowed_mime_types\s*=\s*excluded\.allowed_mime_types/i,
    'a re-run must correct a drifted mime list, not skip it');
  assert.match(m[1], /public\s*=\s*false/i,
    'the paid-video bucket must never be flipped public by a re-run');
});

// ── The format ──────────────────────────────────────────────────────────────

test('the bucket accepts exactly the one MIME type the file picker offers', () => {
  for (const file of SQL_FILES) {
    const values = bucketValues(read(file), 'course-videos');
    const arr = /array\[([^\]]*)\]/i.exec(values || '');
    assert.ok(arr, `${file} must set allowed_mime_types as an array literal`);
    const mimes = arr[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepEqual(mimes, [LESSON_VIDEO_MIME],
      `${file} must allow exactly ['${LESSON_VIDEO_MIME}'] — anything the picker offers and the `
      + 'bucket refuses fails after the file is chosen, and anything the bucket allows and the '
      + 'picker refuses is a format we never promised would play');
  }
});

// ── The storage path ────────────────────────────────────────────────────────

test('a path the client builds is a path the #44 trigger accepts', () => {
  const sql = read(SQL_FILES[0]);
  const m = /'(\^lessons\/[^']+)'/.exec(sql);
  assert.ok(m, 'the lesson video guard must pin the storage path shape with a regex literal');

  // Postgres POSIX and JS agree on this subset, so the same source can be tested here.
  const sqlRe = new RegExp(m[1]);
  const good = buildLessonVideoPath(
    '3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30',
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    'Module 1 — Intro.mp4',
  );
  assert.ok(isLessonVideoPath(good), 'the client must accept the path it just built');
  assert.ok(sqlRe.test(good),
    `the trigger regex ${m[1]} must accept ${good} — otherwise a completed upload is refused at `
    + 'save time and the file is orphaned in the bucket');
});

test('the trigger regex refuses the shapes the old path parser waved through', () => {
  const sql = read(SQL_FILES[0]);
  const sqlRe = new RegExp(/'(\^lessons\/[^']+)'/.exec(sql)[1]);
  for (const bad of [
    'lessons/',
    'lessons/3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30',
    'lessons/not-a-uuid/a.mp4',
    'covers/3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30/a.mp4',
    'anything/3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30/a.mp4',
  ]) {
    assert.equal(sqlRe.test(bad), false,
      `${bad} must not pass the trigger — course_object_allowed() authorised all of these`);
    assert.equal(isLessonVideoPath(bad), false, `${bad} must not pass the client either`);
  }
});

// ── The error codes ─────────────────────────────────────────────────────────

const NEW_CODES = ['LESSON_VIDEO_UPLOAD_ONLY', 'LESSON_VIDEO_PATH_INVALID', 'COURSE_PUBLISH_BLOCKED'];

test('every #44 code the SQL raises has client copy waiting for it', () => {
  for (const code of NEW_CODES) {
    assert.ok(APP_ERROR_CODES.includes(code),
      `${code} is raised by #44 but is not in APP_ERROR_CODES — the admin would read the raw `
      + '"Hint: CODE — (code PT409)" envelope instead of a sentence');
    assert.ok(APP_ERROR_COPY[code] && APP_ERROR_COPY[code].length > 20,
      `${code} needs copy that says what to do next`);
  }
});

test('every #44 code is registered in the SQL catalog, in both files', () => {
  for (const file of SQL_FILES) {
    const sql = read(file);
    for (const code of NEW_CODES) {
      assert.ok(sql.includes(`'${code}'`),
        `${file} must list ${code} in app_error_catalog() — the catalog is replaced wholesale on `
        + 'every migration that touches it, so an omitted code is a deleted code');
    }
  }
});

test('the guards raise through app_error, not through a bare exception', () => {
  const sql = read(SQL_FILES[0]);
  for (const fn of ['course_lessons_video_guard', 'courses_publish_guard']) {
    const body = new RegExp(
      String.raw`create or replace function public\.${fn}\(\)[\s\S]*?\$fn\$;`,
    ).exec(sql);
    assert.ok(body, `${fn} must be defined in #44`);
    assert.match(body[0], /perform public\.app_error\(/,
      `${fn} must refuse through app_error() so the client can branch on error.hint`);
    assert.match(body[0], /security definer/,
      `${fn} must be SECURITY DEFINER — app_error is revoked from authenticated, so an `
      + 'invoker-rights trigger would fail with "permission denied for function" instead of refusing');
  }
});

// ── The publish guard must stay delta-scoped ────────────────────────────────

test('the publish guard fires only on the false-to-true transition', () => {
  for (const file of SQL_FILES) {
    const sql = read(file);
    const m = /create trigger courses_publish_guard([\s\S]*?);/i.exec(sql);
    assert.ok(m, `${file} must create the courses_publish_guard trigger`);
    assert.match(m[1], /when\s*\(\s*new\.published\s+and\s+not\s+old\.published\s*\)/i,
      `${file}: without this WHEN clause the guard would refuse EVERY unrelated update to a `
      + 'published course — reorder (N updates in one Promise.all), cover upload, tier toggle, '
      + 'AI-trainer toggle and metadata save all write to courses without touching published');
    assert.ok(!/before insert or update on public\.courses/i.test(m[1]),
      `${file}: the guard must be UPDATE-only — WHEN cannot reference OLD on INSERT`);
  }
});

// ── The fail-open parser must stay gone ─────────────────────────────────────

test('the fail-open path parser is dropped, after the policy stops naming it', () => {
  const sql = read(SQL_FILES[0]);
  const dropAt = sql.indexOf('drop function if exists public.course_object_allowed(text)');
  const alterAt = sql.indexOf('alter policy course_videos_read on storage.objects');
  assert.ok(dropAt > 0, '#44 must retire course_object_allowed()');
  assert.ok(alterAt > 0, '#44 must re-point the policy');
  assert.ok(alterAt < dropAt,
    'the ALTER POLICY must come FIRST — while the policy still names the function, the DROP '
    + 'errors out (deliberately, no CASCADE) and stops the file');
  assert.ok(!/cascade/i.test(sql.slice(dropAt, dropAt + 120)),
    'never CASCADE: an errored DROP is the signal that a policy still depends on it');
});

test('the read policy is altered, never dropped and recreated', () => {
  const sql = read(SQL_FILES[0]);
  assert.ok(!/drop policy if exists course_videos_read/i.test(sql),
    'apply-db-files sends one statement per HTTP round trip, so a DROP+CREATE is a real window '
    + 'in which the private video bucket has NO read policy at all');
  assert.match(sql, /alter policy course_videos_read on storage\.objects/i);
});

test('the read policy finally requires approval, and asks by reference', () => {
  const sql = read(SQL_FILES[0]);
  const m = /alter policy course_videos_read on storage\.objects([\s\S]*?);\n/i.exec(sql);
  assert.ok(m, '#44 must alter course_videos_read');
  assert.match(m[1], /is_approved/,
    'course_videos_read was the only one of the four content-read policies without it');
  assert.match(m[1], /course_video_object_readable/,
    'authorization must come from the reference, not from parsing the object name');
  assert.ok(!/course_object_allowed/.test(m[1]),
    'the path parser must not survive in the policy it was written for');
});
