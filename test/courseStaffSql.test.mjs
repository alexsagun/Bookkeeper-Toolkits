// test/courseStaffSql.test.mjs — Trainer course ownership, JS vs SQL (#46).
//
// #46 is the migration that makes the Trainer role real: six permission keys that
// #45 seeded and nothing consumed. The rules it encodes are split across three
// places that can drift silently — the dated migration, the bootstrap fold a fresh
// install runs, and canManageCourseClient() in src/lib/staffRoles.js, which decides
// what the course builder RENDERS.
//
// ★ THE ONE THIS SUITE EXISTS FOR. #46 authorizes storage WRITES by parsing the
//   course id out of the object path — the same technique #44 deleted for
//   authorizing READS, because that version failed OPEN on an unparseable name.
//   The inversion is the whole safety argument, and it lives in one regex. So this
//   suite lifts that regex out of the SQL and EXECUTES it in JS against real paths,
//   rather than asserting that some string is present. A regex that quietly starts
//   matching `lessons/../../etc` is not something a substring check would notice.
//
// Reads SQL as TEXT. No database, no credentials, runs anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import { canManageCourseClient, normalizeStaffContext } from '../src/lib/staffRoles.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-08-26-course-staff-assignments.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const SQL_FILES = [MIGRATION, BOOTSTRAP];

/** The stable codes #46 introduces. Clients branch on error.hint, never on status. */
const NEW_CODES = ['COURSE_NOT_ASSIGNED', 'COURSE_PUBLISH_FORBIDDEN', 'COURSE_ASSIGNMENT_INVALID'];

/** Executable SQL only — the header prose quotes SQL and must not be matched as SQL. */
const statementsOf = (sql) => sql
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

// ── The objects exist, in BOTH files ─────────────────────────────────────────

let objectComparisons = 0;

for (const file of SQL_FILES) {
  test(`${file}: the ownership model is present`, () => {
    const sql = statementsOf(read(file));
    for (const needle of [
      'create table if not exists public.course_staff_assignments',
      'create or replace function public.user_can_manage_course(p_user uuid, p_course_id uuid)',
      'create or replace function public.can_manage_course(p_course_id uuid)',
      'create or replace function public.course_object_course_id(p_name text)',
    ]) {
      assert.ok(sql.includes(needle),
        `${file} is missing "${needle}" — a fresh install and a migrated database would `
        + 'end up with different authorization');
    }
    objectComparisons += 1;
  });
}

test('both files were checked', () => {
  assert.equal(objectComparisons, SQL_FILES.length,
    'the bootstrap fold is exactly where a correction gets lost — it must be checked too');
});

// ── The write-side path parser, EXECUTED ─────────────────────────────────────

test('the storage path regex is pinned in the SQL and fails closed on every bad shape', () => {
  const sql = statementsOf(read(MIGRATION));
  const m = /p_name\s*~\s*'(\^\(lessons\|covers\)[^']+)'/.exec(sql);
  assert.ok(m, 'course_object_course_id() must pin the object path shape with a regex literal');

  // Postgres POSIX and JS agree on this subset, so the SAME source can be run here.
  const re = new RegExp(m[1]);

  const good = [
    'lessons/11111111-2222-3333-4444-555555555555/video.mp4',
    'covers/11111111-2222-3333-4444-555555555555/cover.png',
    'lessons/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/a.mp4',
  ];
  const bad = [
    'lessons/not-a-uuid/video.mp4',
    'lessons/11111111-2222-3333-4444-555555555555',      // no file part
    'lessons/11111111-2222-3333-4444-555555555555/',     // empty file part
    'lessons/',
    'covers/',
    '',
    '../etc/passwd',
    'avatars/11111111-2222-3333-4444-555555555555/a.png', // another bucket's shape
    'community/11111111-2222-3333-4444-555555555555/a.png',
    'x-lessons/11111111-2222-3333-4444-555555555555/a.mp4',
  ];

  for (const p of good) {
    assert.ok(re.test(p), `${p} is a legitimate course object path and must parse`);
  }
  for (const p of bad) {
    assert.ok(!re.test(p),
      `${p} must NOT parse — course_object_course_id() returns NULL for it, and `
      + 'user_can_manage_course(uid, NULL) is false, which is what denies the write');
  }
});

test('the regex is anchored, or a prefix attack matches', () => {
  const sql = statementsOf(read(MIGRATION));
  const m = /p_name\s*~\s*'(\^\(lessons\|covers\)[^']+)'/.exec(sql);
  assert.ok(m[1].startsWith('^'),
    'without a leading anchor, "anything/lessons/<uuid>/x" would authorize a write '
    + 'into a folder the caller does not own');
});

test('reads did NOT move to the path parser — that was the #44 bug', () => {
  const sql = statementsOf(read(MIGRATION));
  // course_videos_read may reference the parser for the manage branch, but it must
  // still carry the reference-based predicate as its member path.
  const readPolicy = /alter policy course_videos_read on storage\.objects([\s\S]*?);/.exec(sql);
  assert.ok(readPolicy, '#46 re-states course_videos_read, so it must be findable');
  assert.ok(readPolicy[1].includes('course_video_object_readable'),
    'the member read branch must stay reference-based — #44 deleted the path-parsing '
    + 'version because it returned true for orphans, malformed names and draft courses');
});

// ── Policy shape ─────────────────────────────────────────────────────────────

test('the blanket FOR ALL course policy is replaced by three verbs', () => {
  const sql = statementsOf(read(MIGRATION));
  assert.ok(sql.includes('drop policy if exists courses_admin_write on public.courses'),
    'courses_admin_write was FOR ALL — it must be dropped, not left alongside the new ones');
  for (const p of ['courses_staff_insert', 'courses_staff_update', 'courses_staff_delete']) {
    assert.ok(sql.includes(`create policy ${p} on public.courses`), `${p} must exist`);
  }
});

test('read policies are ALTERed, never dropped and recreated', () => {
  const sql = statementsOf(read(MIGRATION));
  for (const p of ['courses_read', 'modules_read', 'lessons_read', 'course_videos_read']) {
    assert.ok(sql.includes(`alter policy ${p} on`),
      `${p} must be ALTERed — one statement per HTTP round trip makes a drop/create pair `
      + 'a real window in which the catalogue is invisible to every student');
    assert.ok(!sql.includes(`drop policy if exists ${p} on`),
      `${p} must never be dropped; that window has no read policy at all`);
  }
});

test('deleting a course needs its own permission on top of managing it', () => {
  const sql = statementsOf(read(MIGRATION));
  const del = /create policy courses_staff_delete on public\.courses([\s\S]*?);/.exec(sql);
  assert.ok(del, 'courses_staff_delete must exist');
  assert.ok(del[1].includes("has_staff_permission('courses.delete')"),
    'a Trainer holds courses.manage_assigned but NOT courses.delete — deleting removes '
    + 'storage objects a duplicated course may still reference');
  assert.ok(del[1].includes('can_manage_course'),
    'holding courses.delete must not let someone delete a course they were never assigned');
});

// ── Publishing ───────────────────────────────────────────────────────────────

test('publishing is gated on courses.publish, in both directions', () => {
  const sql = statementsOf(read(MIGRATION));
  const fn = /create or replace function public\.courses_publish_guard\(\)([\s\S]*?)\$fn\$;/.exec(sql);
  assert.ok(fn, 'the publish guard must be replaced by this migration');
  assert.ok(fn[1].includes("has_staff_permission('courses.publish')"),
    'a Trainer authors; someone with courses.publish ships');

  const trg = /create trigger courses_publish_guard([\s\S]*?);/.exec(sql);
  assert.ok(trg[1].includes('is distinct from'),
    'the WHEN clause must cover BOTH directions — withdrawing a live course from every '
    + 'paying student is not a lesser act than publishing it');
  assert.ok(trg[1].includes('when ('),
    'it must stay DELTA-scoped: reorderCourse fires N updates on published rows in one '
    + 'Promise.all, and state-scoping would refuse every one of them');
});

test('the INSERT guard is a separate trigger, because WHEN cannot see OLD on insert', () => {
  const sql = statementsOf(read(MIGRATION));
  assert.ok(sql.includes('create trigger courses_publish_insert_guard'),
    'a course inserted with published = true must be gated too');
});

// ── Grants ───────────────────────────────────────────────────────────────────

test('the per-user helper is revoked from clients, the caller-pinned one is granted', () => {
  const sql = statementsOf(read(MIGRATION));
  assert.ok(sql.includes('revoke all on function public.user_can_manage_course(uuid, uuid) from public, anon, authenticated'),
    'the form that answers about ANY user must not be callable from a client');
  assert.ok(sql.includes('grant execute on function public.can_manage_course(uuid) to authenticated'),
    'an RLS qual is evaluated AS THE QUERYING ROLE — without this grant every course '
    + 'write fails with "permission denied for function" instead of a clean denial');
});

test('assignments are RPC-only: no client write policy, and the grants say so', () => {
  const sql = statementsOf(read(MIGRATION));
  assert.ok(sql.includes('revoke insert, update, delete, truncate on public.course_staff_assignments from authenticated, anon, public'),
    'Supabase default grants survive a missing policy, so RLS alone is not enough');
  assert.ok(!/create policy course_staff_assignments_\w*(insert|update|delete)/.test(sql),
    'every write must go through admin_assign_course_staff / admin_revoke_course_staff');
});

// ── Error codes ──────────────────────────────────────────────────────────────

test('every #46 code the SQL raises has client copy waiting for it', () => {
  for (const code of NEW_CODES) {
    assert.ok(APP_ERROR_CODES.includes(code),
      `${code} is raised by #46 but missing from APP_ERROR_CODES — appErrorCode() validates `
      + 'the hint against that set, so an unlisted code is discarded and the user sees a fallback');
    assert.ok(APP_ERROR_COPY[code] && APP_ERROR_COPY[code].length > 20,
      `${code} needs a sentence in APP_ERROR_COPY that names the next action`);
  }
});

test('every #46 code is registered in the SQL catalog, in both files', () => {
  for (const file of SQL_FILES) {
    const sql = statementsOf(read(file));
    for (const code of NEW_CODES) {
      assert.ok(sql.includes(`('${code}',`),
        `${file}: app_error_catalog() is replaced wholesale, so ${code} must be re-listed there`);
    }
  }
});

// ── The client mirror agrees with the SQL rule ───────────────────────────────

const ctx = (roleKey, permissions, courseIds = []) => normalizeStaffContext({
  role_key: roleKey, status: 'active', permissions, assigned_course_ids: courseIds,
});

const COURSE_A = '11111111-1111-1111-1111-111111111111';
const COURSE_B = '22222222-2222-2222-2222-222222222222';

test('canManageCourseClient mirrors user_can_manage_course, cell for cell', () => {
  const superAdmin = ctx('super_admin', ['courses.manage_all', 'courses.manage_assigned']);
  const assigned = ctx('trainer', ['courses.manage_assigned'], [COURSE_A]);
  const unassigned = ctx('trainer', ['courses.manage_assigned'], []);
  const ops = ctx('operations_admin', ['enrollments.review']);

  // manage_all short-circuits before assignment is consulted — same as the SQL CASE.
  assert.equal(canManageCourseClient(superAdmin, { id: COURSE_B }), true,
    'courses.manage_all edits every course, assigned or not');
  assert.equal(canManageCourseClient(assigned, { id: COURSE_A }), true,
    'a Trainer edits the course assigned to them');
  assert.equal(canManageCourseClient(assigned, { id: COURSE_B }), false,
    'a Trainer must NOT edit another Trainer\'s course');
  assert.equal(canManageCourseClient(unassigned, { id: COURSE_A }), false,
    'holding courses.manage_assigned with no assignment grants nothing');
  assert.equal(canManageCourseClient(ops, { id: COURSE_A }), false,
    'an Operations Admin holds no course permission at all');
});

test('a null course is never manageable — the fail-closed case the parser depends on', () => {
  const superAdmin = ctx('super_admin', ['courses.manage_all']);
  const assigned = ctx('trainer', ['courses.manage_assigned'], [COURSE_A]);
  // ★ The SQL is stricter than the client here, deliberately: user_can_manage_course
  //   returns false for a NULL course id even for manage_all, because that NULL comes
  //   from course_object_course_id() failing to parse a storage path. The client is
  //   never asked that question — it is asked about a course row — so it only has to
  //   agree that "no course" is not manageable.
  assert.equal(canManageCourseClient(assigned, null), false);
  assert.equal(canManageCourseClient(assigned, { id: null }), false);
  assert.equal(canManageCourseClient(superAdmin, { id: undefined }), true,
    'manage_all short-circuits in the client mirror; the SQL re-decides every write');
});

test('an empty or suspended context can never manage a course', () => {
  const suspended = normalizeStaffContext({
    role_key: 'trainer', status: 'suspended',
    permissions: ['courses.manage_all'], assigned_course_ids: [COURSE_A],
  });
  assert.equal(canManageCourseClient(suspended, { id: COURSE_A }), false,
    'only status = active confers authority — that is what makes a suspension immediate');
  assert.equal(canManageCourseClient(null, { id: COURSE_A }), false);
  assert.equal(canManageCourseClient(undefined, { id: COURSE_A }), false);
});

// ── Structural guarantees of the migration itself ────────────────────────────

test('the migration records itself in the apply log', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /insert into public\.schema_migrations \(filename, checksum, notes\) values/,
    'without an apply-log row, db:audit reports this file as never run');
  assert.ok(sql.includes(`'${MIGRATION.replace('db/', '')}'`),
    'the row must name this exact filename');
  assert.match(sql, /notify pgrst, 'reload schema';/,
    'PostgREST caches the schema; without the notify the new RPCs 404 until it restarts');
});

test('the migration is transaction-free, or the statement splitter breaks', () => {
  const sql = statementsOf(read(MIGRATION));
  for (const kw of [/^\s*begin\s*;/im, /^\s*commit\s*;/im, /^\s*rollback\s*;/im]) {
    assert.ok(!kw.test(sql),
      'scripts/apply-db-files.mjs sends one statement per HTTP round trip — an explicit '
      + 'transaction block cannot span them and breaks the splitter');
  }
});

test('nothing is dropped with CASCADE', () => {
  const sql = statementsOf(read(MIGRATION));
  assert.ok(!/drop\s+[\s\S]{0,80}cascade/i.test(sql),
    'a CASCADE would silently strip dependent policies instead of failing the file');
});

test('every new SECURITY DEFINER function pins its search_path', () => {
  const sql = statementsOf(read(MIGRATION));
  const defs = [...sql.matchAll(/create or replace function (public\.\w+)\(([\s\S]*?)\)\s*returns[\s\S]*?(?=create or replace|alter policy|drop policy|$)/g)];
  assert.ok(defs.length >= 5, 'this migration defines several functions');
  for (const d of defs) {
    const body = d[0];
    if (!/security definer/i.test(body)) continue;
    assert.match(body, /set search_path = public/,
      `${d[1]} is SECURITY DEFINER without a pinned search_path — a temp-table shadow `
      + 'could redirect an unqualified reference inside it');
  }
});
