// test-db/courseVideos.dbtest.mjs — upload-only lesson video + reference-based
// storage authorization (#44).
//
// Every authorization assertion goes through a REAL signed-in user's PostgREST
// client. Nothing is asserted through the service role or the Management API:
// those run as `postgres` and bypass RLS, so they would pass regardless of what
// the policies say. Setup uses them; proof never does.
//
// ★ WHY THIS SUITE EXISTS AT ALL. Before it, the course platform had NO database
//   test of any kind, and the two things that could catch an RLS regression both
//   have blind spots here: `db:shadow:verify` snapshots `pg_policies` filtered to
//   `schemaname = 'public'`, so storage policies are never captured, and even for
//   public ones it compares only tablename/policyname/cmd — never the `qual`. So a
//   rewritten USING clause, or a silent reversion of one, is invisible to it.
//   `db:audit` can see a predicate but needs live credentials.
//
// ★ WHAT #44 CHANGED, and therefore what this file has to prove.
//   `course_object_allowed()` authorized a private video object by PARSING its
//   name — `split_part(name,'/',2)::uuid` — and returned TRUE on an unparseable
//   path, TRUE on an unknown course id, and TRUE for every non-sampler plan before
//   it looked at anything. It never checked that segment 1 was literally 'lessons'
//   and it never checked `courses.published`. It was also simply WRONG for
//   duplicated courses: duplication reuses `storage_path` by reference, so a
//   duplicate's video physically lives in the SOURCE course's folder, and a Sampler
//   entitled to an Essentials duplicate was denied their own video because the path
//   named the standard-tier original.
//
//   `course_video_object_readable()` replaces it with the only question that is
//   true: does a PUBLISHED lesson this caller's plan may read cite this exact
//   storage_path? Every fail-open branch becomes an `EXISTS` over zero rows.
//
// Run: npm run test:db   (needs .env.test pointing at a shadow project)

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonClient,
  expectAppError,
  expectDenied,
  lit,
  makePersona,
  resetShadow,
  runSql,
  seedMember,
  sqlScalar,
} from './_harness.mjs';

// Fixed ids so a path can be written by hand and still be the one the row cites.
const ESSENTIALS_ID = '11111111-1111-4111-8111-111111111111';
const MASTERY_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const DUPLICATE_ID = '44444444-4444-4444-8444-444444444444';

const path = (courseId, name) => `lessons/${courseId}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-${name}`;
const ESSENTIALS_VIDEO = path(ESSENTIALS_ID, 'essentials.mp4');
const MASTERY_VIDEO = path(MASTERY_ID, 'mastery.mp4');
const DRAFT_VIDEO = path(DRAFT_ID, 'draft.mp4');
const ORPHAN_VIDEO = path(ESSENTIALS_ID, 'nobody-references-this.mp4');

let admin; let sampler; let silver; let vip; let expired; let unapproved;

/**
 * Three published courses plus a draft, each with one uploaded video lesson.
 *
 * The DUPLICATE deliberately cites the ESSENTIALS course's path — that is exactly
 * what CourseCatalog.duplicateCourse does (copy-on-write, no bytes copied), and it
 * is the case the old path parser got wrong in both directions.
 */
async function seedCourses() {
  await runSql(`
    insert into public.courses (id, slug, title, published, access_tier) values
      (${lit(ESSENTIALS_ID)}, 'qbo-t-essentials', 'QBO Essentials (test)',  true,  'essentials'),
      (${lit(MASTERY_ID)},    'qbo-t-mastery',    'QBO Mastery (test)',     true,  'standard'),
      (${lit(DRAFT_ID)},      'qbo-t-draft',      'QBO Draft (test)',       false, 'essentials'),
      (${lit(DUPLICATE_ID)},  'qbo-t-duplicate',  'Copy of Essentials',     true,  'essentials')
  `);
  await runSql(`
    insert into public.course_modules (id, course_id, title, position) values
      ('aaaa1111-0000-4000-8000-000000000001', ${lit(ESSENTIALS_ID)}, 'M', 0),
      ('aaaa1111-0000-4000-8000-000000000002', ${lit(MASTERY_ID)},    'M', 0),
      ('aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)},      'M', 0),
      ('aaaa1111-0000-4000-8000-000000000004', ${lit(DUPLICATE_ID)},  'M', 0)
  `);
  await runSql(`
    insert into public.course_lessons
      (id, module_id, course_id, title, type, video_provider, storage_path, position) values
      ('bbbb1111-0000-4000-8000-000000000001', 'aaaa1111-0000-4000-8000-000000000001', ${lit(ESSENTIALS_ID)}, 'E1', 'video', 'upload', ${lit(ESSENTIALS_VIDEO)}, 0),
      ('bbbb1111-0000-4000-8000-000000000002', 'aaaa1111-0000-4000-8000-000000000002', ${lit(MASTERY_ID)},    'M1', 'video', 'upload', ${lit(MASTERY_VIDEO)},    0),
      ('bbbb1111-0000-4000-8000-000000000003', 'aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)},      'D1', 'video', 'upload', ${lit(DRAFT_VIDEO)},      0)
  `);
  // The duplicate's lesson SHARES the essentials course's object.
  await runSql(`
    insert into public.course_lessons
      (id, module_id, course_id, title, type, video_provider, storage_path, position) values
      ('bbbb1111-0000-4000-8000-000000000004', 'aaaa1111-0000-4000-8000-000000000004', ${lit(DUPLICATE_ID)}, 'C1', 'video', 'upload', ${lit(ESSENTIALS_VIDEO)}, 0)
  `);
  // Storage rows for the same paths, so createSignedUrl has something to authorize.
  for (const p of [ESSENTIALS_VIDEO, MASTERY_VIDEO, DRAFT_VIDEO, ORPHAN_VIDEO]) {
    await runSql(`
      insert into storage.objects (bucket_id, name, metadata)
      values ('course-videos', ${lit(p)}, '{"mimetype":"video/mp4","size":1024}'::jsonb)
      on conflict do nothing`);
  }
}

/** Ask the DB, as this persona, whether they may read that object. */
async function mayRead(persona, objectPath) {
  const { data, error } = await persona.db.rpc('course_video_object_readable', { p_name: objectPath });
  assert.equal(error, null, `course_video_object_readable errored for ${objectPath}: ${error?.message}`);
  return data === true;
}

before(async () => {
  admin = await makePersona('admin', { isAdmin: true, fullName: 'Admin' });
  sampler = await makePersona('sampler', { fullName: 'Sam Sampler' });
  silver = await makePersona('silver', { fullName: 'Sil Silver' });
  vip = await makePersona('vip', { fullName: 'Vi Vip' });
  expired = await makePersona('expired', { fullName: 'Ex Pired' });
  unapproved = await makePersona('unapproved', { fullName: 'Un Approved' });
});

beforeEach(async () => {
  await resetShadow();
  await seedCourses();
  await seedMember(sampler, { planKey: 'sampler' });
  await seedMember(silver, { planKey: 'silver_self_paced' });
  await seedMember(vip, { planKey: 'vip' });
  await seedMember(expired, { planKey: 'silver_self_paced', expired: true });
  await seedMember(unapproved, { planKey: 'silver_self_paced' });
  await runSql(`update public.profiles set approval_status = 'pending' where id = ${lit(unapproved.id)}`);
});

after(async () => { await resetShadow(); });

// ── The entitlement question the helper answers ──────────────────────────────

test('a full-access member may read a published course’s video', async () => {
  assert.equal(await mayRead(silver, MASTERY_VIDEO), true);
  assert.equal(await mayRead(vip, MASTERY_VIDEO), true);
});

test('a sampler may read an Essentials video and NOT a standard-tier one', async () => {
  assert.equal(await mayRead(sampler, ESSENTIALS_VIDEO), true,
    'the Sampler plan buys the Essentials course — its video must be readable');
  assert.equal(await mayRead(sampler, MASTERY_VIDEO), false,
    'Mastery is outside the Sampler scope; the object must not be readable either');
});

test('an object under a DRAFT course is readable by nobody — the old parser let it through', async () => {
  // course_object_allowed short-circuited `if not plan_is_sampler() then return true`, so
  // ANY full-access member who guessed an object name could read unpublished content.
  for (const p of [[silver, 'silver'], [vip, 'vip'], [sampler, 'sampler']]) {
    assert.equal(await mayRead(p[0], DRAFT_VIDEO), false, `${p[1]} must not read a draft course's video`);
  }
});

test('an unreferenced orphan is readable by nobody — the old parser returned true', async () => {
  // `if v_slug is null then return true`. An object nothing cites now fails closed
  // structurally: an EXISTS over zero rows, not a defensive branch someone can delete.
  for (const p of [[silver, 'silver'], [vip, 'vip'], [sampler, 'sampler']]) {
    assert.equal(await mayRead(p[0], ORPHAN_VIDEO), false, `${p[1]} must not read an orphan object`);
  }
});

test('a malformed path is readable by nobody — the old parser fell into its catch-all', async () => {
  // `exception when others then return true`, and segment 1 was never checked, so
  // `anything/<a-real-course-uuid>/x` parsed as though it named a course.
  for (const bad of [
    '',
    'lessons/',
    `lessons/${ESSENTIALS_ID}`,
    `covers/${ESSENTIALS_ID}/x.mp4`,
    `anything/${ESSENTIALS_ID}/x.mp4`,
    '../../etc/passwd',
    'lessons/not-a-uuid/x.mp4',
  ]) {
    assert.equal(await mayRead(silver, bad), false, `${JSON.stringify(bad)} must not authorize`);
  }
});

test('a shared object is authorized through EVERY course that cites it', async () => {
  // THE case the path parser got wrong. ESSENTIALS_VIDEO physically lives under the
  // essentials course's folder and is cited by BOTH that course and the duplicate.
  assert.equal(await mayRead(sampler, ESSENTIALS_VIDEO), true);
  // Now unpublish the original. The duplicate still cites the object and is still
  // published, so the sampler must keep access to bytes they are entitled to.
  await runSql(`update public.courses set published = false where id = ${lit(ESSENTIALS_ID)}`);
  assert.equal(await mayRead(sampler, ESSENTIALS_VIDEO), true,
    'entitlement follows the REFERENCE, not the folder the file happens to sit in');
  // Unpublish the duplicate too and nothing cites it from a published course any more.
  await runSql(`update public.courses set published = false where id = ${lit(DUPLICATE_ID)}`);
  assert.equal(await mayRead(sampler, ESSENTIALS_VIDEO), false);
});

test('a shared object stays out of scope for a plan neither course admits', async () => {
  // Both citing courses are Essentials, so a sampler is fine; re-tier one to standard
  // and the sampler must still be allowed, because the OTHER one still admits them.
  await runSql(`update public.courses set access_tier = 'standard' where id = ${lit(DUPLICATE_ID)}`);
  assert.equal(await mayRead(sampler, ESSENTIALS_VIDEO), true);
  await runSql(`update public.courses set access_tier = 'standard' where id = ${lit(ESSENTIALS_ID)}`);
  assert.equal(await mayRead(sampler, ESSENTIALS_VIDEO), false,
    'once no course the sampler may read cites it, the object is out of scope');
});

// ── The storage policy end to end ───────────────────────────────────────────

test('an authorized member can sign a lesson video, and an out-of-scope one cannot', async () => {
  const ok = await silver.db.storage.from('course-videos').createSignedUrl(MASTERY_VIDEO, 60);
  assert.equal(ok.error, null, `a full-access member must be able to sign: ${ok.error?.message}`);
  assert.ok(ok.data?.signedUrl, 'a signed URL must come back');

  const denied = await sampler.db.storage.from('course-videos').createSignedUrl(MASTERY_VIDEO, 60);
  assert.ok(denied.error, 'a sampler must NOT be able to sign a Mastery-tier video');
});

test('an EXPIRED member cannot sign any lesson video', async () => {
  const r = await expired.db.storage.from('course-videos').createSignedUrl(MASTERY_VIDEO, 60);
  assert.ok(r.error, 'a lapsed membership must lose the media, not just the UI');
});

test('an UNAPPROVED member cannot sign a lesson video — #44 added the missing gate', async () => {
  // course_videos_read was the only one of the four content-read policies without an
  // is_approved() conjunct, for its whole life from #15 through #39.
  const r = await unapproved.db.storage.from('course-videos').createSignedUrl(MASTERY_VIDEO, 60);
  assert.ok(r.error, 'an unapproved account must not reach paid media');
});

test('an anonymous visitor cannot sign, list or read anything in the bucket', async () => {
  // ★ anonClient() is a module singleton that must NEVER be signed in — a persona
  //   sign-in on it once produced a phantom "anonymous can read member rows" leak.
  const anon = anonClient();
  const signed = await anon.storage.from('course-videos').createSignedUrl(MASTERY_VIDEO, 60);
  assert.ok(signed.error, 'anonymous signing must be refused');
  const listed = await anon.storage.from('course-videos').list(`lessons/${MASTERY_ID}`, { limit: 10 });
  assert.ok(listed.error || (listed.data || []).length === 0, 'anonymous listing must reveal nothing');
});

test('an admin can sign a DRAFT course’s video, because that is how they preview it', async () => {
  const r = await admin.db.storage.from('course-videos').createSignedUrl(DRAFT_VIDEO, 60);
  assert.equal(r.error, null, `an admin must keep access while authoring: ${r.error?.message}`);
});

// ── The upload-only write guard ─────────────────────────────────────────────

const NEW_LESSON = (extra) => `
  insert into public.course_lessons (module_id, course_id, title, type, position${extra.cols})
  values ('aaaa1111-0000-4000-8000-000000000001', ${lit(ESSENTIALS_ID)}, 'New', 'video', 9${extra.vals})`;

test('a link-backed video lesson cannot be inserted into a PUBLISHED course', async () => {
  for (const provider of ['youtube', 'vimeo', 'mp4']) {
    const msg = await runSqlExpectError(NEW_LESSON({
      cols: ', video_provider, video_url',
      vals: `, ${lit(provider)}, 'https://youtu.be/AAAAAAAAAAA'`,
    }));
    assert.match(msg, /LESSON_VIDEO_UPLOAD_ONLY|upload/i,
      `${provider} must be refused on insert into a published course, got: ${msg || '(no error)'}`);
  }
});

test('a link-backed lesson CAN be inserted into a draft — duplication depends on it', async () => {
  // ★ CourseCatalog.duplicateCourse bulk-inserts copied lesson rows into a published:false
  //   copy, and its catch block DELETES the half-built course. An unconditional insert
  //   prohibition would therefore turn "duplicate a pre-#44 course" into silent destruction
  //   of the new course, its modules and every lesson already copied.
  const msg = await runSqlExpectError(`
    insert into public.course_lessons (module_id, course_id, title, type, position, video_provider, video_url)
    values ('aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)}, 'Legacy copy', 'video', 9, 'youtube', 'https://youtu.be/AAAAAAAAAAA')`);
  assert.equal(msg, '', `a draft must accept it, got: ${msg}`);
});

test('an existing link lesson can still be RENAMED, but not re-pointed', async () => {
  await runSql(`
    insert into public.course_lessons (id, module_id, course_id, title, type, position, video_provider, video_url)
    values ('bbbb1111-0000-4000-8000-00000000000a', 'aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)},
            'Legacy', 'video', 8, 'youtube', 'https://youtu.be/AAAAAAAAAAA')`);
  await runSql(`update public.courses set published = true where id = ${lit(DRAFT_ID)}`);

  // ★ Grandfathering is MONOTONIC ON video_url, never on video_provider. saveLesson used
  //   to re-derive the provider from the URL on every write, so a provider-equality rule
  //   would refuse title-only edits on any legacy row the current regex no longer parses —
  //   forever, with no way to fix it from the UI.
  const rename = await runSqlExpectError(
    `update public.course_lessons set title = 'Legacy renamed' where id = 'bbbb1111-0000-4000-8000-00000000000a'`);
  assert.equal(rename, '', `a legacy row must stay editable, got: ${rename}`);

  // The provider may DRIFT while the URL is unchanged — that is exactly what saveLesson
  // used to do to every legacy row on every save, via parseVideoUrl.
  const drift = await runSqlExpectError(
    `update public.course_lessons set video_provider = 'mp4' where id = 'bbbb1111-0000-4000-8000-00000000000a'`);
  assert.equal(drift, '', `provider drift on an unchanged URL must be tolerated, got: ${drift}`);

  // But the URL itself is frozen: a legacy lesson cannot be quietly re-pointed at a
  // different video, which would be authoring a new link by another name.
  const repoint = await runSqlExpectError(
    `update public.course_lessons set video_url = 'https://youtu.be/BBBBBBBBBBB' where id = 'bbbb1111-0000-4000-8000-00000000000a'`);
  assert.match(repoint, /LESSON_VIDEO_UPLOAD_ONLY|upload/i,
    `re-pointing a legacy link must be refused, got: ${repoint || '(no error)'}`);

  // Clearing it is always allowed — that is the way OUT of the legacy state.
  const clear = await runSqlExpectError(
    `update public.course_lessons set video_url = null, video_provider = null where id = 'bbbb1111-0000-4000-8000-00000000000a'`);
  assert.equal(clear, '', `clearing a legacy link must be allowed, got: ${clear}`);

  // Turning a NON-link lesson into a link one is what is refused.
  const become = await runSqlExpectError(
    `update public.course_lessons set video_provider = 'youtube', video_url = 'https://youtu.be/CCCCCCCCCCC', storage_path = null
       where id = 'bbbb1111-0000-4000-8000-000000000001'`);
  assert.match(become, /LESSON_VIDEO_UPLOAD_ONLY|upload/i,
    `an uploaded lesson must not be convertible back into a link, got: ${become || '(no error)'}`);
});

test('an uploaded lesson must name a real lessons/<uuid>/<file> object', async () => {
  const msg = await runSqlExpectError(NEW_LESSON({
    cols: ', video_provider, storage_path',
    vals: `, 'upload', 'covers/${ESSENTIALS_ID}/not-a-lesson.mp4'`,
  }));
  assert.match(msg, /LESSON_VIDEO_PATH_INVALID|lessons/i, `got: ${msg || '(no error)'}`);
});

test('reordering an uploaded lesson never re-checks its path', async () => {
  // moveLesson updates position alone, and in a BEFORE UPDATE trigger NEW still carries
  // the old storage_path — so an unconditional path check would make a legacy or
  // hand-repaired row permanently unreorderable.
  await runSql(`update public.course_lessons set storage_path = 'legacy/odd/path.mp4', video_provider = 'upload'
                 where id = 'bbbb1111-0000-4000-8000-000000000002'`);
  const msg = await runSqlExpectError(
    `update public.course_lessons set position = 3 where id = 'bbbb1111-0000-4000-8000-000000000002'`);
  assert.equal(msg, '', `a position-only update must pass, got: ${msg}`);
});

test('a duplicated course may share the source course’s folder', async () => {
  // The path's uuid is deliberately NOT pinned to new.course_id: copy-on-write duplication
  // is the whole reason removeMediaIfUnreferenced() exists.
  const msg = await runSqlExpectError(`
    insert into public.course_lessons (module_id, course_id, title, type, position, video_provider, storage_path)
    values ('aaaa1111-0000-4000-8000-000000000004', ${lit(DUPLICATE_ID)}, 'Shared', 'video', 9, 'upload', ${lit(ESSENTIALS_VIDEO)})`);
  assert.equal(msg, '', `a duplicate must be able to cite the source's object, got: ${msg}`);
});

// ── The publish guard ───────────────────────────────────────────────────────

test('a course with a link-backed lesson cannot be published', async () => {
  await runSql(`
    insert into public.course_lessons (module_id, course_id, title, type, position, video_provider, video_url)
    values ('aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)}, 'Legacy', 'video', 9, 'youtube', 'https://youtu.be/AAAAAAAAAAA')`);
  const msg = await runSqlExpectError(`update public.courses set published = true where id = ${lit(DRAFT_ID)}`);
  assert.match(msg, /COURSE_PUBLISH_BLOCKED|external link|uploaded file/i, `got: ${msg || '(no error)'}`);
});

test('a course whose video lessons are all uploaded publishes normally', async () => {
  const msg = await runSqlExpectError(`update public.courses set published = true where id = ${lit(DRAFT_ID)}`);
  assert.equal(msg, '', `a fully uploaded course must publish, got: ${msg}`);
});

test('an EMPTY course and a text-only course both publish', async () => {
  await runSql(`insert into public.courses (id, slug, title, published) values
    ('55555555-5555-4555-8555-555555555555', 'qbo-t-empty', 'Empty', false)`);
  const empty = await runSqlExpectError(
    `update public.courses set published = true where id = '55555555-5555-4555-8555-555555555555'`);
  assert.equal(empty, '', `an empty course must publish — "create, publish, then author" is the normal flow, got: ${empty}`);

  await runSql(`update public.course_lessons set type = 'text', text_content = 'notes',
    video_provider = null, storage_path = null where course_id = ${lit(DRAFT_ID)}`);
  const text = await runSqlExpectError(`update public.courses set published = true where id = ${lit(DRAFT_ID)}`);
  assert.equal(text, '', `a text-only course must publish, got: ${text}`);
});

test('unrelated writes to an ALREADY published course are untouched by the guard', async () => {
  // ★ The guard is delta-scoped by `when (new.published and not old.published)`. Scoping it
  //   on state instead would refuse every one of these — reorderCourse fires N of them in a
  //   single Promise.all, so a partial failure would leave positions inconsistent.
  await runSql(`
    insert into public.course_lessons (module_id, course_id, title, type, position, video_provider, video_url)
    values ('aaaa1111-0000-4000-8000-000000000002', ${lit(MASTERY_ID)}, 'Legacy', 'video', 9, 'youtube', 'https://youtu.be/AAAAAAAAAAA')`);
  for (const [what, sql] of [
    ['reorder', `update public.courses set position = 3 where id = ${lit(MASTERY_ID)}`],
    ['cover upload', `update public.courses set cover_path = 'covers/x/y.png' where id = ${lit(MASTERY_ID)}`],
    ['tier toggle', `update public.courses set access_tier = 'essentials' where id = ${lit(MASTERY_ID)}`],
    ['metadata save', `update public.courses set subtitle = 'edited' where id = ${lit(MASTERY_ID)}`],
    ['unpublish', `update public.courses set published = false where id = ${lit(MASTERY_ID)}`],
  ]) {
    const msg = await runSqlExpectError(sql);
    assert.equal(msg, '', `${what} on a published legacy course must still work, got: ${msg}`);
  }
});

test('course_publish_blockers names the offending lessons, and only for an admin', async () => {
  await runSql(`
    insert into public.course_lessons (module_id, course_id, title, type, position, video_provider, video_url)
    values ('aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)}, 'Needs upload', 'video', 9, 'youtube', 'https://youtu.be/AAAAAAAAAAA')`);

  const asAdmin = await admin.db.rpc('course_publish_blockers', { p_course_id: DRAFT_ID });
  assert.equal(asAdmin.error, null, `admin call must succeed: ${asAdmin.error?.message}`);
  assert.equal((asAdmin.data || []).length, 1);
  assert.equal(asAdmin.data[0].title, 'Needs upload');
  assert.equal(asAdmin.data[0].reason, 'external_link');

  const asMember = await silver.db.rpc('course_publish_blockers', { p_course_id: DRAFT_ID });
  assert.equal((asMember.data || []).length, 0,
    'a member must learn nothing about a draft course from this RPC');
});

// ── Zoom Live Replay is a separate, untouched surface ───────────────────────

test('a zoom replay link still writes and reads, and never satisfies the video requirement', async () => {
  const msg = await runSqlExpectError(`
    update public.course_lessons set zoom_replay_url = 'https://acme.zoom.us/rec/share/abc'
     where id = 'bbbb1111-0000-4000-8000-000000000001'`);
  assert.equal(msg, '', `#44 must not touch the replay column, got: ${msg}`);
  const stored = await sqlScalar(
    `select zoom_replay_url from public.course_lessons where id = 'bbbb1111-0000-4000-8000-000000000001'`);
  assert.equal(stored, 'https://acme.zoom.us/rec/share/abc');

  // A replay-only lesson must still block publication: the replay renders BELOW the player
  // slot, so it would leave students looking at an empty video.
  await runSql(`
    insert into public.course_lessons (module_id, course_id, title, type, position, video_provider, video_url, zoom_replay_url)
    values ('aaaa1111-0000-4000-8000-000000000003', ${lit(DRAFT_ID)}, 'Replay only', 'video', 9, 'youtube',
            'https://youtu.be/AAAAAAAAAAA', 'https://acme.zoom.us/rec/share/abc')`);
  const blocked = await runSqlExpectError(`update public.courses set published = true where id = ${lit(DRAFT_ID)}`);
  assert.match(blocked, /COURSE_PUBLISH_BLOCKED|external link|uploaded file/i);
});

/** Run SQL expecting a raise; return the message text (or '' if it succeeded). */
async function runSqlExpectError(sql) {
  try { await runSql(sql, { retries: 0 }); return ''; }
  catch (e) { return e.sqlDetail || e.message; }
}
