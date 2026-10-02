// ─────────────────────────────────────────────────────────────────────────────
// test-db/onboardingVideo.dbtest.mjs — the Getting Started video, per persona (#69).
// ─────────────────────────────────────────────────────────────────────────────
// Every authorization claim is asserted through a REAL signed-in user's PostgREST or
// Storage client — a Super Admin, an Operations Admin, a Trainer, a student in every
// standing the rules distinguish, and an anonymous visitor. The Management API (`postgres`)
// builds fixtures, moves clocks and reads the catalog; it bypasses RLS, so it never proves
// what somebody may see. The one place it is the SUBJECT is the version guard, which has to
// hold for the table owner too.
//
// ★ WHAT ONLY A LIVE DATABASE CAN SHOW. test/gettingStartedSql.test.mjs pins the SOURCE of
//   #69: that a conjunct is present, that a grant names a function. It cannot show that
//     • a storage policy really refuses an upload into a published version's folder, or
//       that a missing helper grant has not broken every OTHER bucket (a policy qual runs as
//       the caller, so one missing EXECUTE fails every storage.objects statement);
//     • deleting an Auth user who once published a video is not blocked by the very guards
//       that keep the history permanent;
//     • a replacement published in the same instant as a completion tells the student about
//       the NEW video rather than "nothing is live" (READ COMMITTED re-checks the row the
//       completion was waiting on, and finds it retired);
//     • one student's completion or problem report leaves every other student's row alone.
//
// ★ STAFF COME FROM REAL MEMBERSHIPS. seedStaff(), never makePersona({ isAdmin }): that
//   option writes the profiles.is_admin cache and no membership, so has_staff_permission()
//   answers false for every key — and every gate in #69 asks has_staff_permission().
//
// ★ ONE STAGED FIXTURE, RESET CHEAPLY. A Management API call costs two to three seconds on
//   this link, and resetShadow() is about twenty of them. So before() resets the project
//   ONCE and seeds the people; each test then clears only the three onboarding tables and
//   the bucket (resetOnboardingVideos(), one statement) and stages the versions it needs
//   through the Super Admin's own session. Tests share the people, never the videos.
//
// ★ NOTHING IS LEFT LIVE. A published version gates every later student persona — in this
//   directory and in the rendered e2e suites, which never call resetShadow(). after() clears
//   the video tables FIRST and on its own, then resets the rest.
//
// ★ src/lib/gettingStarted.js IS IMPORTED ON PURPOSE. The object names here are built by
//   the function the uploader calls, the elapsed guard is checked against the constants the
//   player reads, and the admin health verdict is computed by the client's own interpreter
//   from the overview this database returns. A drift between the two halves fails here.
//
// Run: node --test --test-concurrency=1 test-db/onboardingVideo.dbtest.mjs
//      (needs .env.test pointing at a shadow project; never two shadow suites at once)
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  anonClient,
  asUser,
  expectAppError,
  expectDenied,
  lit,
  makeBatch,
  makePersona,
  resetFinance,
  resetOnboardingVideos,
  resetShadow,
  runSql,
  seedMember,
  seedStaff,
  serviceClient,
  sqlScalar,
} from './_harness.mjs';
import {
  ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS,
  ONBOARDING_MIN_ELAPSED_FRACTION,
  ONBOARDING_PROBLEM_CODES,
  ONBOARDING_UNKNOWN_DURATION_SECONDS,
  ONBOARDING_VIDEO_BUCKET,
  buildOnboardingVideoPath,
  onboardingHealth,
} from '../src/lib/gettingStarted.js';
import { LESSON_VIDEO_MAX_BYTES, LESSON_VIDEO_UPLOAD_MIMES } from '../src/lib/courseVideo.js';

const BUCKET = ONBOARDING_VIDEO_BUCKET;

// The bucket checks the DECLARED content type against its allow-list, never the bytes, and
// nothing in #69 decodes a file — so a few bytes are a complete stand-in for a video here.
const TINY = Buffer.from('gs-dbtest: a few bytes standing in for an mp4');

/** versions/<video id>/<a fresh upload id>.mp4 — built by the function the uploader calls. */
const newPath = (videoId) => buildOnboardingVideoPath(videoId, randomUUID());

/** What complete_onboarding_video() must wait, from the constants the client reads. */
const minElapsed = (durationSeconds) => Math.max(
  (durationSeconds ?? ONBOARDING_UNKNOWN_DURATION_SECONDS) * ONBOARDING_MIN_ELAPSED_FRACTION,
  ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS,
);

let sa; let ops; let trainer; let staffMember;
let student; let student2; let expired; let grace; let pending; let stranger; let migrated;
let newbie; let mid; let grandfathered; let applicant; let applicantVip;
let throwawayId = null;

// ── Small helpers ────────────────────────────────────────────────────────────

/** Call an RPC as a persona and return its data. A refusal fails the test, naming the code. */
async function call(persona, fn, args = {}) {
  const { data, error } = await persona.db.rpc(fn, args);
  assert.equal(error, null,
    `${persona.label} → ${fn}: ${error?.hint || error?.code || ''} ${error?.message || ''}`);
  return data;
}

/** The jsonb context app_error() carries in `details` ({ code, context }). */
function contextOf(error) {
  try { return JSON.parse(error?.details || '{}').context || {}; } catch { return {}; }
}

const ms = (iso) => Date.parse(iso);
const store = (persona) => persona.db.storage.from(BUCKET);
const upload = (persona, path, opts = {}) =>
  store(persona).upload(path, TINY, { contentType: 'video/mp4', ...opts });

/** Can this persona mint a signed URL for that object? */
async function canSign(persona, path, bucket = BUCKET) {
  const r = await persona.db.storage.from(bucket).createSignedUrl(path, 60);
  return !r.error && !!r.data?.signedUrl;
}

/**
 * Assert a Storage WRITE was refused — and for the right reason.
 *
 * ★ "permission denied for function …" is NOT a refusal by this bucket's policy. It is what
 *   every storage.objects statement returns, in every bucket, when a policy helper is not
 *   executable by `authenticated`; a test that accepted it would pass on a project whose
 *   whole Storage surface is down.
 */
function assertStorageRefused(result, what, { byPolicy = true } = {}) {
  assert.ok(result.error, `${what}: the write must be refused, but it succeeded`);
  const message = String(result.error.message || '');
  assert.doesNotMatch(message, /permission denied for function/i,
    `${what}: refused for the WRONG reason — a policy helper is not executable by authenticated`);
  if (byPolicy) {
    assert.match(message, /row-level security/i, `${what}: expected the policy to refuse, got "${message}"`);
  }
}

/** remove() reports a refusal as an EMPTY result with no error, so that is what is asserted. */
async function assertNotRemovable(persona, path, what) {
  const r = await store(persona).remove([path]);
  if (r.error) {
    assert.doesNotMatch(String(r.error.message), /permission denied for function/i, what);
  } else {
    assert.deepEqual(r.data, [], `${what}: nothing may be deleted`);
  }
  assert.equal(await canSign(sa, path), true, `${what}: the object must still be there`);
}

/** Remove one storage.objects ROW as postgres — "the file was deleted in the Storage dashboard". */
async function deleteObjectRow(bucket, name) {
  // ★ A plain DELETE raises 42501 from Supabase's storage.protect_delete() trigger. Its one
  //   sanctioned escape is `storage.allow_delete_query`, which must be set with is_local = true,
  //   which needs a transaction — and the Management API commits each request on its own. The
  //   DO block is that transaction, scoped to exactly this delete (see resetShadow()).
  await runSql(`do $storage$
    begin
      perform set_config('storage.allow_delete_query', 'true', true);
      delete from storage.objects where bucket_id = ${lit(bucket)} and name = ${lit(name)};
    end
  $storage$`);
}

// ── Staging versions through the Super Admin's own session ───────────────────

const attachArgs = (videoId, path, over = {}) => ({
  p_video_id: videoId,
  p_storage_path: path,
  p_byte_size: TINY.length,
  p_mime_type: 'video/mp4',
  p_duration_seconds: 100,
  p_original_filename: 'welcome.mp4',
  ...over,
});

async function createDraft(title, { description = null, transcript = null } = {}) {
  const out = await call(sa, 'admin_onboarding_video_create_draft',
    { p_title: title, p_description: description, p_transcript: transcript });
  return out.video_id;
}

/** A draft with a REAL object: created, uploaded and attached by the Super Admin's session. */
async function draftWithMedia(title, { duration = 100 } = {}) {
  const id = await createDraft(title);
  const path = newPath(id);
  const up = await upload(sa, path);
  assert.equal(up.error, null, `the Super Admin's upload into a draft's folder: ${up.error?.message}`);
  await call(sa, 'admin_onboarding_video_attach_media', attachArgs(id, path, { p_duration_seconds: duration }));
  return { id, path };
}

/** Publish a fresh version, replacing whatever is live. */
async function publishLive(title, opts) {
  const v = await draftWithMedia(title, opts);
  const out = await call(sa, 'admin_onboarding_video_publish', { p_video_id: v.id, p_replace_live: true });
  assert.equal(out.changed, true, 'a fresh draft must publish');
  return { ...v, published: out };
}

const overview = () => call(sa, 'admin_onboarding_video_overview');
const versionIn = (o, id) => (o.versions || []).find((v) => v.id === id);

/** Every version row, by id, as the Super Admin's own table read (the one SELECT policy). */
async function videoRows() {
  const { data, error } = await sa.db.from('onboarding_videos').select('*');
  assert.equal(error, null, error?.message);
  return Object.fromEntries((data || []).map((r) => [r.id, r]));
}

/** A learner's own progress row for one version, read through THEIR client (RLS: own rows). */
async function ownRow(persona, videoId) {
  const { data, error } = await persona.db.from('student_onboarding_progress')
    .select('*').eq('video_id', videoId).eq('user_id', persona.id);
  assert.equal(error, null, error?.message);
  return (data || [])[0] || null;
}

/** Move a learner's first open back in time: the only way past the elapsed guard without sleeping. */
async function backdateStart(personas, videoId, seconds) {
  const ids = (Array.isArray(personas) ? personas : [personas]).map((p) => `'${p.id}'::uuid`).join(', ');
  await runSql(`update public.student_onboarding_progress
                   set first_started_at = now() - interval '${Number(seconds)} seconds'
                 where video_id = '${videoId}'::uuid and user_id in (${ids})`);
}

/**
 * Put a learner exactly `secondsIn` seconds past their first open of a version, with any
 * completion cleared: a known clock for the elapsed guard.
 */
async function setClock(persona, videoId, secondsIn) {
  await runSql(`update public.student_onboarding_progress
                   set first_started_at = now() - interval '${Number(secondsIn)} seconds', completed_at = null
                 where user_id = '${persona.id}'::uuid and video_id = '${videoId}'::uuid`);
}

/**
 * Ask to finish at a moment the elapsed guard must still REFUSE, and judge the answer by what
 * the clock allows rather than by what this link usually does.
 *
 * ★ WHY NOT JUST "BACKDATE 25 SECONDS, THEN EXPECT A REFUSAL". That reads the clock twice —
 *   in the fixture's UPDATE and again in the completion — and assumes the gap is small. On
 *   2026-09-30 one response stalled for about 160 seconds on this link: the completion reached
 *   the database 185 s "into" a 100-second video, was correctly RECORDED, and the first version
 *   of this test reported a guard failure that did not exist.
 *
 * So each attempt is timed on this side. From just before the clock is set to just after the
 * answer is back, `waited` seconds pass, so the server judged the request somewhere between
 * `secondsIn` and `secondsIn + waited` seconds after the first open:
 *   • REFUSED  → seconds_remaining must lie between ceil(wait − secondsIn − waited) and
 *     ceil(wait − secondsIn). Both bounds are exact, whatever the link did.
 *   • RECORDED → legitimate only if secondsIn + waited ≥ wait: the link out-waited the guard.
 *     That attempt proves nothing either way, so the clock is set again, three times at most.
 *     RECORDED with time to spare is the defect this exists to catch, and it fails at once.
 *
 * `arm`, when given, is how the FIRST attempt gets to `secondsIn` (opening the video, for 0).
 * A retry always sets the clock directly: a second open never moves first_started_at.
 */
async function assertTooSoon(persona, videoId, { secondsIn, wait, what, arm = null }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const t0 = Date.now();
    if (attempt === 1 && arm) await arm();
    else await setClock(persona, videoId, secondsIn);
    const r = await persona.db.rpc('complete_onboarding_video');
    const waited = (Date.now() - t0) / 1000;
    if (r.error) {
      assert.equal(r.error.hint, 'ONBOARDING_VIDEO_NOT_FINISHED', `${what}: ${r.error.code} ${r.error.message}`);
      const ctx = contextOf(r.error);
      assert.equal(ctx.started, true, `${what}: the row exists, so this is "too soon", not "never opened"`);
      assert.equal(ctx.current_video_id, videoId, what);
      const remaining = Number(ctx.seconds_remaining);
      const most = Math.ceil(wait - secondsIn);
      const least = Math.max(1, Math.ceil(wait - secondsIn - waited));
      assert.ok(remaining >= least && remaining <= most,
        `${what}: between ${least} and ${most} s must remain (the answer took ${waited.toFixed(1)} s), got ${remaining}`);
      return { remaining, waited };
    }
    assert.ok(secondsIn + waited >= wait,
      `${what}: a completion was RECORDED no more than ${(secondsIn + waited).toFixed(1)} s after the first open, `
      + `before the ${wait} s the guard must wait`);
  }
  return assert.fail(`${what}: three attempts in a row took longer than the guard's own wait, so the refusal was never observed`);
}

/**
 * Run each statement in its OWN subtransaction, as postgres, in one request.
 * → { label: { accepted: true } | { accepted: false, code, state, message } }
 *
 * ★ An ACCEPTED statement is rolled back too (the function raises after it and catches its own
 *   raise), so one step the guard wrongly lets through cannot change what the next step is
 *   tested against — and the whole matrix leaves the fixture exactly as it found it.
 */
async function sqlAttempts(steps) {
  const calls = Object.entries(steps)
    .map(([label, sql]) => `${lit(label)}, pg_temp.gs_attempt(${lit(sql)})`).join(',\n      ');
  const rows = await runSql(`
    create or replace function pg_temp.gs_attempt(p_sql text) returns jsonb
    language plpgsql as $t$
    declare
      v_hint text; v_state text; v_msg text;
    begin
      execute p_sql;
      raise exception 'GS_ATTEMPT_ACCEPTED';
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_state = returned_sqlstate, v_msg = message_text;
      if v_msg = 'GS_ATTEMPT_ACCEPTED' then
        return jsonb_build_object('accepted', true);
      end if;
      return jsonb_build_object('accepted', false, 'code', nullif(v_hint, ''), 'state', v_state, 'message', v_msg);
    end
    $t$;
    select jsonb_build_object(
      ${calls}
    ) as out;`, { label: 'attempts', retries: 0 });
  return rows[0].out;
}

const claimsOf = (persona) => lit(JSON.stringify({ sub: persona.id, role: 'authenticated' }));

// ── The people ───────────────────────────────────────────────────────────────

before(async () => {
  sa = await makePersona('gs-super', { fullName: 'GS Super' });
  ops = await makePersona('gs-ops', { fullName: 'GS Ops' });
  trainer = await makePersona('gs-trainer', { fullName: 'GS Trainer' });
  staffMember = await makePersona('gs-staffsub', { fullName: 'GS Staff With A Plan' });
  student = await makePersona('gs-student', { fullName: 'GS Student' });
  student2 = await makePersona('gs-student2', { fullName: 'GS Second Student' });
  expired = await makePersona('gs-expired', { fullName: 'GS Expired' });
  grace = await makePersona('gs-grace', { fullName: 'GS In Grace' });
  pending = await makePersona('gs-pending', { fullName: 'GS Pending' });
  stranger = await makePersona('gs-stranger', { fullName: 'GS No Membership' });
  migrated = await makePersona('gs-migrated', { fullName: 'GS Migrated' });
  newbie = await makePersona('gs-newbie', { fullName: 'GS New Member' });
  mid = await makePersona('gs-mid', { fullName: 'GS Joined Between Versions' });
  grandfathered = await makePersona('gs-grandfathered', { fullName: 'GS Grandfathered' });
  applicant = await makePersona('gs-applicant', { fullName: 'GS Applicant' });
  applicantVip = await makePersona('gs-applicant-vip', { fullName: 'GS Applicant Vip' });

  // One known slate: no memberships, no courses, no batches, nobody paid — and no video.
  await resetShadow();

  await seedStaff(sa, 'super_admin');
  await seedStaff(ops, 'operations_admin');
  await seedStaff(trainer, 'trainer');
  await seedStaff(staffMember, 'trainer');     // gets a subscription in the "who is asked" test

  // ★ EVERY MEMBER HERE JOINED BEFORE ANY VIDEO EXISTED. Nothing is published in before(), so
  //   each of these first subscription rows predates every test's first publish: they are
  //   eligible to watch and replay, and never REQUIRED to. The members a video is required of
  //   are seeded inside the test that publishes it.
  await seedMember(student, { planKey: 'silver_self_paced' });
  await seedMember(student2, { planKey: 'sampler' });
  await seedMember(expired, { planKey: 'silver_self_paced', expired: true });
  await seedMember(grace, { planKey: 'silver_self_paced', inGrace: true });
  await seedMember(pending, { planKey: 'silver_self_paced' });
  // A paid term on an account nobody approved, and a legacy member activated by the #67
  // migration three days ago (an import grant: no payment and no request behind it).
  await runSql(`
    update public.profiles set approval_status = 'pending' where id = '${pending.id}'::uuid;
    insert into public.subscriptions
      (user_id, plan_key, status, started_at, ends_at, grace_ends_at, grant_source, created_at)
    values ('${migrated.id}'::uuid, 'silver_self_paced', 'active', now() - interval '3 days',
            now() + interval '57 days', now() + interval '60 days', 'import', now() - interval '3 days');
    update public.profiles
       set is_paid = true, plan = 'silver_self_paced', account_origin = 'import', onboarding_status = 'completed'
     where id = '${migrated.id}'::uuid;`);
});

after(async () => {
  // ★ THE VIDEO RESET COMES FIRST, AND ALONE. It is one statement; resetShadow() is twenty
  //   round trips, any of which can drop. Whatever happens after this line, no version is
  //   live and no object is left for the suites that run next — the rendered e2e suites
  //   above all, which never call resetShadow() and would find every student on the gate.
  await resetOnboardingVideos();
  if (throwawayId) {
    try { await serviceClient().auth.admin.deleteUser(throwawayId); } catch { /* already gone */ }
  }
  if (migrated) {
    await runSql(`update public.profiles set account_origin = 'signup', onboarding_status = 'none'
                   where id = '${migrated.id}'::uuid`);
  }
  await resetShadow();
  // The approvals in the decision-facts test posted collections through #58's hook;
  // resetShadow()'s truncate of enrollment_requests cascades to the payment events and leaves
  // their journal entries behind (see resetFinance()).
  await resetFinance();
});

// ── What #69 installed ───────────────────────────────────────────────────────

test('the bucket is private with the lesson-video limits, and only a Super Admin holds onboarding.manage', async () => {
  const b = (await runSql(`select public, file_size_limit, allowed_mime_types
                             from storage.buckets where id = ${lit(BUCKET)}`))[0];
  assert.ok(b, 'the onboarding-videos bucket must exist');
  assert.equal(b.public, false, 'a public bucket serves every object to anyone holding its URL');
  assert.equal(Number(b.file_size_limit), LESSON_VIDEO_MAX_BYTES,
    'the uploader promises LESSON_VIDEO_MAX_BYTES; a lower bucket limit would 413 after the transfer');
  assert.deepEqual(b.allowed_mime_types, [...LESSON_VIDEO_UPLOAD_MIMES]);

  const permissions = async (p) => (await call(p, 'my_staff_context')).permissions || [];
  assert.ok((await permissions(sa)).includes('onboarding.manage'), 'a Super Admin manages the video');
  for (const p of [ops, trainer]) {
    assert.ok(!(await permissions(p)).includes('onboarding.manage'),
      `${p.label}: publishing the first screen every new student sees is a Super Admin decision`);
  }

  const catalog = await call(student, 'app_error_catalog');
  const codes = catalog.map((r) => r.code).filter((c) => c.startsWith('ONBOARDING_VIDEO_')).sort();
  assert.deepEqual(codes, [
    'ONBOARDING_VIDEO_MEDIA_INVALID', 'ONBOARDING_VIDEO_NOT_ELIGIBLE', 'ONBOARDING_VIDEO_NOT_FINISHED',
    'ONBOARDING_VIDEO_NOT_FOUND', 'ONBOARDING_VIDEO_REPLACE_CONFIRM', 'ONBOARDING_VIDEO_STATE_INVALID',
    'ONBOARDING_VIDEO_TEXT_INVALID', 'ONBOARDING_VIDEO_UNAVAILABLE',
  ], 'the eight codes the client branches on must be in the live catalog');
});

// ── Case 1: the Super Admin lifecycle ────────────────────────────────────────

test('the Super Admin lifecycle: draft, real upload, publish, replace, unpublish, publish again, delete', async (t) => {
  await resetOnboardingVideos();
  let v1; let v2; let p1a; let p1b; let p2;
  const details = (over = {}) => ({
    p_video_id: v1, p_title: 'Welcome to Toolkits', p_description: 'A short tour',
    p_transcript: 'Hello and welcome.', ...over,
  });

  await t.test('a draft comes first, takes text edits, and cannot be published without a file', async () => {
    const created = await call(sa, 'admin_onboarding_video_create_draft',
      { p_title: '  Welcome V1  ', p_description: 'A short tour', p_transcript: 'Hello and welcome.' });
    assert.equal(created.status, 'draft');
    v1 = created.video_id;

    const edited = await call(sa, 'admin_onboarding_video_update_details', details());
    assert.equal(edited.changed, true);
    const same = await call(sa, 'admin_onboarding_video_update_details', details());
    assert.equal(same.changed, false, 'a call that changes nothing says so');

    await expectAppError(sa.db.rpc('admin_onboarding_video_update_details', details({ p_title: '   ' })),
      'ONBOARDING_VIDEO_TEXT_INVALID', 'an empty title');
    await expectAppError(sa.db.rpc('admin_onboarding_video_update_details', details({ p_description: 'x'.repeat(601) })),
      'ONBOARDING_VIDEO_TEXT_INVALID', 'a 601-character description');

    // ★ NO DEFAULTS: the editor sends all three fields and an empty one clears it, so a call
    //   that omits one must not resolve at all — never be read as "clear the rest" (#41).
    const omitted = await sa.db.rpc('admin_onboarding_video_update_details',
      { p_video_id: v1, p_title: 'Only a title' });
    assert.equal(omitted.error?.code, 'PGRST202',
      `an update that omits description and transcript must not resolve, got ${omitted.error?.code}: ${omitted.error?.message}`);

    await expectAppError(sa.db.rpc('admin_onboarding_video_publish', { p_video_id: v1, p_replace_live: false }),
      'ONBOARDING_VIDEO_MEDIA_INVALID', 'publishing a draft that has no file');

    const row = (await videoRows())[v1];
    assert.equal(row.title, 'Welcome to Toolkits');
    assert.equal(row.description, 'A short tour', 'a refused or unresolved edit must not have cleared it');
    assert.equal(row.status, 'draft');
    assert.equal(row.created_by, sa.id);
    assert.equal(row.storage_path, null);
  });

  await t.test('it takes a REAL upload into its own folder, and attach binds exactly that file', async () => {
    p1a = newPath(v1);
    const up = await upload(sa, p1a);
    assert.equal(up.error, null, `a Super Admin uploads into a draft's own folder: ${up.error?.message}`);

    await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(v1, p1a, { p_byte_size: TINY.length + 1 })),
      'ONBOARDING_VIDEO_MEDIA_INVALID', 'a size that is not the size Storage recorded');
    await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(v1, newPath(v1))),
      'ONBOARDING_VIDEO_MEDIA_INVALID', 'a path nothing was uploaded to');
    await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(v1, p1a, { p_mime_type: 'video/webm' })),
      'ONBOARDING_VIDEO_MEDIA_INVALID', 'a type the bucket does not allow');
    await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(v1, p1a, { p_duration_seconds: 14401 })),
      'ONBOARDING_VIDEO_MEDIA_INVALID', 'a length over four hours');
    await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(randomUUID(), p1a)),
      'ONBOARDING_VIDEO_NOT_FOUND', 'a version that does not exist');

    const first = await call(sa, 'admin_onboarding_video_attach_media', attachArgs(v1, p1a, { p_duration_seconds: 272.456 }));
    assert.equal(first.storage_path, p1a);
    assert.equal(first.previous_storage_path, null);

    // A second upload replaces the first: the path it replaced comes back, for the client to remove.
    p1b = newPath(v1);
    assert.equal((await upload(sa, p1b)).error, null);
    const second = await call(sa, 'admin_onboarding_video_attach_media', attachArgs(v1, p1b, { p_duration_seconds: 272.456 }));
    assert.equal(second.previous_storage_path, p1a);

    // No row cites it any more and it was never live, so the Super Admin may remove it.
    const rm = await store(sa).remove([p1a]);
    assert.equal(rm.error, null, rm.error?.message);
    assert.equal((rm.data || []).length, 1, 'a replaced draft upload is removable');
    assert.equal(await canSign(sa, p1a), false, 'and it is gone');

    const row = (await videoRows())[v1];
    assert.equal(row.storage_path, p1b);
    assert.equal(Number(row.duration_seconds), 272.46, 'the length is kept to two decimals');
    assert.equal(Number(row.byte_size), TINY.length);
    assert.equal(row.mime_type, 'video/mp4');
    assert.equal(row.original_filename, 'welcome.mp4');
    assert.ok(row.media_attached_at, 'attaching stamps when');
  });

  await t.test('the first publish sets the cutoff, and publishing it again changes nothing', async () => {
    const out = await call(sa, 'admin_onboarding_video_publish', { p_video_id: v1, p_replace_live: false });
    assert.equal(out.changed, true);
    assert.equal(out.first_publish, true);
    assert.equal(out.replaced_video_id, null);

    const again = await call(sa, 'admin_onboarding_video_publish', { p_video_id: v1, p_replace_live: false });
    assert.equal(again.changed, false, 'a double click must not publish twice');

    const o = await overview();
    assert.equal(o.live_video_id, v1);
    const live = versionIn(o, v1);
    assert.equal(live.status, 'published');
    assert.equal(live.media_present, true);
    assert.equal(ms(o.required_since), ms(live.published_at), 'the cutoff is the first publish');
    assert.equal(ms(out.required_since), ms(live.published_at));
    assert.equal(onboardingHealth(o).code, 'ok');

    const row = (await videoRows())[v1];
    assert.equal(row.published_by, sa.id);
    assert.equal(ms(row.last_published_at), ms(row.published_at));
  });

  await t.test('replacing the live version has to be asked for explicitly', async () => {
    const v = await draftWithMedia('Welcome V2', { duration: 60 });
    v2 = v.id; p2 = v.path;

    const refused = await expectAppError(
      sa.db.rpc('admin_onboarding_video_publish', { p_video_id: v2, p_replace_live: false }),
      'ONBOARDING_VIDEO_REPLACE_CONFIRM', 'a second version while one is live');
    assert.deepEqual(contextOf(refused), { live_id: v1, live_title: 'Welcome to Toolkits' },
      'the refusal names the live version, so the dialog can say what is being replaced');
    await expectAppError(sa.db.rpc('admin_onboarding_video_publish', { p_video_id: v2 }),
      'ONBOARDING_VIDEO_REPLACE_CONFIRM', 'p_replace_live defaults to false');
    assert.equal((await overview()).live_video_id, v1, 'a refused publish changes nothing');

    const out = await call(sa, 'admin_onboarding_video_publish', { p_video_id: v2, p_replace_live: true });
    assert.equal(out.replaced_video_id, v1);
    assert.equal(out.first_publish, false);

    const rows = await videoRows();
    assert.equal(rows[v1].status, 'retired');
    assert.equal(rows[v1].retired_by, sa.id);
    assert.ok(rows[v1].retired_at);
    assert.equal(rows[v2].status, 'published');
    assert.equal(rows[v2].published_by, sa.id);
    assert.equal(ms(out.required_since), ms(rows[v1].published_at), 'the cutoff stays the FIRST publish of any version');
  });

  await t.test('the live file can be neither removed nor overwritten, even by the Super Admin', async () => {
    await assertNotRemovable(sa, p2, 'the Super Admin removing the live object');
    assertStorageRefused(await upload(sa, p2, { upsert: true }), 'overwriting the live object in place');
    assertStorageRefused(await store(sa).update(p2, TINY, { contentType: 'video/mp4' }), 'updating the live object');
    assertStorageRefused(await upload(sa, newPath(v2)), "a new upload into the published version's folder");
    await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(v2, p2)),
      'ONBOARDING_VIDEO_STATE_INVALID', 'a new file on a published version');
    await expectAppError(sa.db.rpc('admin_onboarding_video_delete', { p_video_id: v2 }),
      'ONBOARDING_VIDEO_STATE_INVALID', 'deleting the live version without unpublishing it');
  });

  await t.test('unpublish, publish again, then delete: the row stays and its file becomes removable', async () => {
    const un = await call(sa, 'admin_onboarding_video_unpublish', { p_video_id: v2 });
    assert.equal(un.changed, true);
    const un2 = await call(sa, 'admin_onboarding_video_unpublish', { p_video_id: v2 });
    assert.equal(un2.changed, false, 'already retired: a no-op');
    assert.equal((await overview()).live_video_id, null);

    // "Publish again": nothing is live, so no confirmation is asked, and the FIRST publish
    // time is kept — the gate cutoff reads its minimum.
    const before1 = (await videoRows())[v1];
    const again = await call(sa, 'admin_onboarding_video_publish', { p_video_id: v1, p_replace_live: false });
    assert.equal(again.changed, true);
    assert.equal(again.first_publish, false);
    const after1 = (await videoRows())[v1];
    assert.equal(after1.status, 'published');
    assert.equal(after1.published_at, before1.published_at, 'published_at is set once');
    assert.ok(ms(after1.last_published_at) > ms(before1.last_published_at), 'last_published_at moves');

    await call(sa, 'admin_onboarding_video_unpublish', { p_video_id: v1 });

    const del = await call(sa, 'admin_onboarding_video_delete', { p_video_id: v1 });
    assert.equal(del.changed, true);
    assert.equal(del.storage_path, p1b, 'the path comes back so the client can remove the bytes');
    const del2 = await call(sa, 'admin_onboarding_video_delete', { p_video_id: v1 });
    assert.equal(del2.changed, false);

    await expectAppError(sa.db.rpc('admin_onboarding_video_publish', { p_video_id: v1, p_replace_live: true }),
      'ONBOARDING_VIDEO_STATE_INVALID', 'publishing a deleted version');
    await expectAppError(sa.db.rpc('admin_onboarding_video_update_details', details()),
      'ONBOARDING_VIDEO_STATE_INVALID', 'editing a deleted version');

    const rm = await store(sa).remove([p1b]);
    assert.equal((rm.data || []).length, 1, "a deleted version's file is removable");

    const delV2 = await call(sa, 'admin_onboarding_video_delete', { p_video_id: v2 });
    assert.equal(delV2.changed, true, 'a retired version can be deleted');

    const rows = await videoRows();
    assert.deepEqual([rows[v1].status, rows[v2].status], ['deleted', 'deleted'], 'a version is never removed: deleted is a status');
    assert.equal(rows[v1].deleted_by, sa.id);
    assert.ok(rows[v1].deleted_at);
  });

  await t.test('the trail holds one row per state change and none for a no-op or a refusal', async () => {
    const { data, error } = await sa.db.from('onboarding_video_events')
      .select('id, video_id, action, actor_id, detail').order('id');
    assert.equal(error, null, error?.message);
    const name = (e) => `${e.action}:${e.video_id === v1 ? 'v1' : e.video_id === v2 ? 'v2' : '?'}`;
    assert.deepEqual(data.map(name), [
      'create_draft:v1', 'update_details:v1', 'attach_media:v1', 'attach_media:v1', 'publish:v1',
      'create_draft:v2', 'attach_media:v2', 'publish:v2', 'unpublish:v2',
      'publish:v1', 'unpublish:v1', 'delete:v1', 'delete:v2',
    ]);
    assert.ok(data.every((e) => e.actor_id === sa.id), 'every change names who made it');
    assert.deepEqual(data[1].detail, { fields: ['title'] });
    assert.equal(data[4].detail.first_publish, true);
    assert.equal(data[7].detail.replaced_video_id, v1);
    assert.equal(data[9].detail.from_status, 'retired');

    const o = await overview();
    assert.equal(o.live_video_id, null);
    assert.equal(onboardingHealth(o).code, 'none_live');
    assert.equal(ms(o.required_since), ms(versionIn(o, v1).published_at),
      'a deleted version still sets the cutoff: it is the first publish of ANY version');
    assert.equal(versionIn(o, v1).media_present, false, 'its file was removed');
    assert.equal(versionIn(o, v2).media_present, true, "a deleted version's file stays until someone removes it");
  });
});

// ── DBSEC-1: a Replace retires the version its dialog named, or nothing ──────

test('a Replace retires only the version its dialog named; a stale confirmation is refused and changes nothing (DBSEC-1)', async (t) => {
  await resetOnboardingVideos();
  // ★ WHAT THE DIALOG PROMISED. The Replace confirmation names ONE live version, by title, and
  //   sends that version's id as p_expected_live_id. While it sits open, a second window or a
  //   second Super Admin can publish another version over it, or unpublish it. The call must then
  //   be refused with the facts as they are NOW, so the dialog can ask again — never retire a
  //   version nobody confirmed, and never publish over somebody's deliberate unpublish.
  const publish = (videoId, replace, expectedLiveId) => sa.db.rpc('admin_onboarding_video_publish',
    { p_video_id: videoId, p_replace_live: replace, p_expected_live_id: expectedLiveId });
  async function published(videoId, replace, expectedLiveId, what) {
    const { data, error } = await publish(videoId, replace, expectedLiveId);
    assert.equal(error, null, `${what}: ${error?.hint || error?.code || ''} ${error?.message || ''}`);
    return data;
  }
  async function trail() {
    const { data, error } = await sa.db.from('onboarding_video_events')
      .select('id, video_id, action, detail').order('id');
    assert.equal(error, null, error?.message);
    return data;
  }
  /** Refused, naming the facts as they are now — and every version and the whole trail untouched. */
  async function assertRefused(attempt, context, what) {
    const rows0 = await videoRows();
    const trail0 = await trail();
    const refused = await expectAppError(attempt(), 'ONBOARDING_VIDEO_REPLACE_CONFIRM', what);
    assert.deepEqual(contextOf(refused), context, `${what}: the refusal must carry the facts as they are now`);
    assert.deepEqual(await videoRows(), rows0, `${what}: no version may change`);
    assert.deepEqual(await trail(), trail0, `${what}: and no trail row may be written`);
  }
  let l1; let d1; let d2; let d3; let d4;

  await t.test('there is ONE publish function: three arguments, the last two optional', async () => {
    // ★ A NEW PARAMETER ADDS AN OVERLOAD UNLESS THE OLD FORM IS DROPPED FIRST. With two of them,
    //   every call that leaves p_expected_live_id out — each plain publish, each two-argument SQL
    //   call in this file — is ambiguous: PostgREST refuses it (PGRST203), SQL says "is not unique".
    const rows = await runSql(`select pg_get_function_arguments(p.oid) as args
                                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname = 'public' and p.proname = 'admin_onboarding_video_publish'`);
    assert.deepEqual(rows.map((r) => r.args),
      ['p_video_id uuid, p_replace_live boolean DEFAULT false, p_expected_live_id uuid DEFAULT NULL::uuid']);
    assert.equal(await sqlScalar(`select to_regprocedure('public.admin_onboarding_video_publish(uuid,boolean)') is null`),
      true, 'the two-argument form must be gone');
  });

  await t.test('naming the version that IS live replaces exactly that one', async () => {
    l1 = await publishLive('Live one');                      // nothing was live: the two-argument call publishes, as before
    d1 = await draftWithMedia('Replacement one');
    const out = await published(d1.id, true, l1.id, 'a replace naming the live version');
    assert.deepEqual([out.changed, out.replaced_video_id, out.first_publish], [true, l1.id, false]);
    const rows = await videoRows();
    assert.deepEqual([rows[l1.id].status, rows[d1.id].status], ['retired', 'published']);
  });

  await t.test('naming a version that is no longer live is refused, names the one that is, and changes nothing', async () => {
    // The stale dialog: opened while "Live one" was live, confirmed after another window had
    // published "Replacement one" over it.
    d2 = await draftWithMedia('Replacement two');
    await assertRefused(() => publish(d2.id, true, l1.id),
      { live_id: d1.id, live_title: 'Replacement one', expected_live_id: l1.id },
      'a replace confirmed for a version another window has since replaced');
    const nobody = randomUUID();
    await assertRefused(() => publish(d2.id, true, nobody),
      { live_id: d1.id, live_title: 'Replacement one', expected_live_id: nobody },
      'a replace naming a version that never existed');
  });

  await t.test('asked again with the version the refusal named, the replace goes through', async () => {
    const out = await published(d2.id, true, d1.id, 'the dialog asking again, naming what is live now');
    assert.deepEqual([out.changed, out.replaced_video_id], [true, d1.id]);
  });

  await t.test('a NULL expected id keeps the original contract: whatever is live is retired', async () => {
    // (Leaving the argument out is the same call: publishLive, and every other replace in this
    // file, sends two arguments.)
    d3 = await draftWithMedia('Replacement three');
    const out = await published(d3.id, true, null, 'a replace with an explicit null expected id');
    assert.deepEqual([out.changed, out.replaced_video_id], [true, d2.id]);
  });

  await t.test('with nothing live, a replace that names a version is refused and publishes nothing', async () => {
    // Somebody unpublished the version the dialog named.
    await call(sa, 'admin_onboarding_video_unpublish', { p_video_id: d3.id });
    d4 = await draftWithMedia('After an unpublish');
    await assertRefused(() => publish(d4.id, true, d3.id),
      { live_id: null, live_title: null, expected_live_id: d3.id },
      'a replace confirmed for a version somebody has since unpublished');
    assert.equal((await overview()).live_video_id, null, 'nothing is live, and nothing was published');
  });

  await t.test('a plain publish ignores the expected id, both ways', async () => {
    // Nothing live: it publishes, whatever id it carries.
    const out = await published(d4.id, false, d3.id, 'a plain publish carrying a stale expected id, with nothing live');
    assert.deepEqual([out.changed, out.replaced_video_id], [true, null]);
    // Something live: naming it does not turn a plain publish into a replace. The refusal is the
    // one a plain publish has always had, with nothing added to it.
    const d5 = await draftWithMedia('Plain over live');
    await assertRefused(() => publish(d5.id, false, d4.id),
      { live_id: d4.id, live_title: 'After an unpublish' },
      'a plain publish over the live version, naming it');
  });

  await t.test('the trail holds one row per confirmed change, and nothing from the four refusals', async () => {
    const tag = { [l1.id]: 'l1', [d1.id]: 'd1', [d2.id]: 'd2', [d3.id]: 'd3', [d4.id]: 'd4' };
    const changes = (await trail())
      .filter((e) => e.action === 'publish' || e.action === 'unpublish')
      .map((e) => [`${e.action}:${tag[e.video_id] || '?'}`,
        tag[e.detail?.replaced_video_id] ?? e.detail?.replaced_video_id ?? null]);
    assert.deepEqual(changes, [
      ['publish:l1', null], ['publish:d1', 'l1'], ['publish:d2', 'd1'], ['publish:d3', 'd2'],
      ['unpublish:d3', null], ['publish:d4', null],
    ]);
  });
});

// ── DBSEC-4: attaching the same file again writes nothing ────────────────────

test('attaching the same file with the same facts writes nothing; any one changed fact writes one event (DBSEC-4)', async () => {
  await resetOnboardingVideos();
  // ★ A CALL THAT CHANGES NOTHING WRITES NOTHING (#56's ledger rule; section 7 of #69). The trail
  //   answers "when did this draft's file change", so a Save retried after its answer was lost
  //   must neither add an 'attach_media' row nor move media_attached_at.
  const draft = await draftWithMedia('Attached again');       // 100 s, welcome.mp4, video/mp4, TINY
  const { id } = draft;
  async function trail() {
    const { data, error } = await sa.db.from('onboarding_video_events')
      .select('id, action, detail').eq('video_id', id).order('id');
    assert.equal(error, null, error?.message);
    return data;
  }
  const row0 = (await videoRows())[id];
  const trail0 = await trail();
  assert.deepEqual(trail0.map((e) => e.action), ['create_draft', 'attach_media']);

  // The same file and the same facts: exactly what a retried Save sends.
  const same = await call(sa, 'admin_onboarding_video_attach_media', attachArgs(id, draft.path));
  assert.deepEqual(same, { ok: true, video_id: id, storage_path: draft.path, previous_storage_path: null, changed: false },
    'the same file with the same facts is a no-op, and says so');
  // The same facts in another spelling. What is compared is what the write would STORE: a size
  // left to storage's own record, a padded upper-case type, a length past two decimals, a padded name.
  const spelled = await call(sa, 'admin_onboarding_video_attach_media', attachArgs(id, draft.path, {
    p_byte_size: null, p_mime_type: '  VIDEO/MP4 ', p_duration_seconds: 100.004, p_original_filename: '  welcome.mp4  ',
  }));
  assert.equal(spelled.changed, false, 'the same facts, spelled differently, are still the same facts');
  assert.deepEqual((await videoRows())[id], row0, 'media_attached_at and every other column exactly as they were');
  assert.deepEqual(await trail(), trail0, 'and no trail row was written');

  // ★ ANY ONE FACT CHANGED IS A CHANGE: one write and one event, every time. Each step changes
  //   exactly one of the five things the write stores, against what the row holds NOW.
  const BIGGER = Buffer.concat([TINY, Buffer.from(' and a few bytes more')]);
  let path = draft.path;
  let facts = {};
  const steps = [
    ['the file itself (a second upload)', async () => {
      const next = newPath(id);
      const up = await upload(sa, next);
      assert.equal(up.error, null, up.error?.message);
      return { nextPath: next };
    }],
    ['the original file name', async () => ({ over: { p_original_filename: 'welcome-final.mp4' } })],
    ['the type', async () => ({ over: { p_mime_type: 'video/quicktime' } })],
    ['the length', async () => ({ over: { p_duration_seconds: 101.5 } })],
    ['the size (the same name, uploaded again with other bytes)', async () => {
      const up = await store(sa).update(path, BIGGER, { contentType: 'video/mp4' });
      assert.equal(up.error, null, `a draft's own file can be overwritten: ${up.error?.message}`);
      return { over: { p_byte_size: BIGGER.length } };
    }],
  ];
  for (const [what, change] of steps) {
    const { nextPath = path, over = {} } = await change();
    const before1 = (await videoRows())[id];
    const trailBefore = await trail();
    const out = await call(sa, 'admin_onboarding_video_attach_media', attachArgs(id, nextPath, { ...facts, ...over }));
    assert.equal(out.changed, true, `${what}: a real change says so`);
    assert.equal(out.previous_storage_path, nextPath === path ? null : path,
      `${what}: only a different file hands back a path to remove`);
    const after1 = (await videoRows())[id];
    assert.notEqual(after1.media_attached_at, before1.media_attached_at, `${what}: attaching stamps when`);
    const trailAfter = await trail();
    assert.equal(trailAfter.length, trailBefore.length + 1, `${what}: exactly one event`);
    const added = trailAfter[trailAfter.length - 1];
    assert.equal(added.action, 'attach_media', what);
    assert.deepEqual([added.detail.storage_path, added.detail.previous_storage_path], [nextPath, path], what);
    path = nextPath;
    facts = { ...facts, ...over };
  }
  const final = (await videoRows())[id];
  assert.deepEqual(
    [final.storage_path, final.original_filename, final.mime_type, Number(final.duration_seconds), Number(final.byte_size)],
    [path, 'welcome-final.mp4', 'video/quicktime', 101.5, BIGGER.length], 'every change landed');

  // And "the same" means the row as it is NOW, not as it was first attached.
  const again = await call(sa, 'admin_onboarding_video_attach_media', attachArgs(id, path, facts));
  assert.equal(again.changed, false, 'the latest facts sent again are a no-op');
  assert.deepEqual((await videoRows())[id], final);

  // ★ THE NO-OP ANSWERS ONLY AFTER EVERY CHECK. Remove the file from storage and send the same
  //   facts again: that must be refused as missing, never reported unchanged — or a draft would
  //   keep citing a file that is gone while its Save said there was nothing to do.
  const rm = await store(sa).remove([path]);
  assert.equal((rm.data || []).length, 1, "a draft's own file is removable");
  const trailBeforeMissing = await trail();
  await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(id, path, facts)),
    'ONBOARDING_VIDEO_MEDIA_INVALID', 'the same facts for a file that is no longer in storage');
  assert.deepEqual((await videoRows())[id], final, 'the refusal changed nothing');
  assert.deepEqual(await trail(), trailBeforeMissing, 'and wrote nothing');
});

// ── Storage writes: authorized by the draft folder they name ─────────────────

test('an upload goes only into the folder of an existing DRAFT, under exactly the name shape the client builds', async () => {
  await resetOnboardingVideos();
  const retired = await publishLive('Retired');
  const live = await publishLive('Live');                    // replaces → `retired` is now retired
  const deleted = await draftWithMedia('Deleted');
  await call(sa, 'admin_onboarding_video_delete', { p_video_id: deleted.id });
  const draft = await draftWithMedia('Draft');
  const other = await draftWithMedia('Another draft');

  // Into a draft's own folder: a second upload, and a QuickTime one (stored under .mp4).
  assert.equal((await upload(sa, newPath(draft.id))).error, null, 'a draft takes more than one upload');
  assert.equal((await upload(sa, newPath(draft.id), { contentType: 'video/quicktime' })).error, null,
    'a .mov is accepted: the bucket allows video/quicktime');
  const webm = await upload(sa, newPath(draft.id), { contentType: 'video/webm' });
  assert.ok(webm.error, 'a type outside the bucket allow-list is refused');
  assert.match(String(webm.error.message), /mime type/i, `refused by the bucket, got "${webm.error.message}"`);

  // A folder that is not a DRAFT's.
  for (const [what, id] of [['a published', live.id], ['a retired', retired.id], ['a deleted', deleted.id]]) {
    assertStorageRefused(await upload(sa, newPath(id)), `an upload into ${what} version's folder`);
  }
  assertStorageRefused(await upload(sa, newPath(randomUUID())), 'an upload into a folder no version has');

  // The name shape: versions/<video uuid>/<upload uuid>.mp4 and nothing else. The parser
  // returns NULL for anything else, and NULL matches no draft.
  for (const [what, name] of [
    ['an uppercase extension', `versions/${draft.id}/${randomUUID()}.MP4`],
    ['another extension', `versions/${draft.id}/${randomUUID()}.mov`],
    ['a filename instead of an upload id', `versions/${draft.id}/welcome.mp4`],
    ['an extra segment', `versions/${draft.id}/extra/${randomUUID()}.mp4`],
    ['an uppercase video id', `versions/${draft.id.toUpperCase()}/${randomUUID()}.mp4`],
    ['an uppercase root', `VERSIONS/${draft.id}/${randomUUID()}.mp4`],
    ['another root', `lessons/${draft.id}/${randomUUID()}.mp4`],
    ['no folder at all', `${randomUUID()}.mp4`],
  ]) {
    assertStorageRefused(await upload(sa, name), `an upload named with ${what}`, { byPolicy: false });
  }

  // One draft cannot cite another draft's file: the upload policy admits any draft's folder,
  // attach_media is what binds the file to THIS one (and a CHECK makes the opposite unrepresentable).
  await expectAppError(sa.db.rpc('admin_onboarding_video_attach_media', attachArgs(draft.id, other.path)),
    'ONBOARDING_VIDEO_MEDIA_INVALID', "attaching another draft's upload");
  // Only the live version can be taken down; a draft was never up.
  await expectAppError(sa.db.rpc('admin_onboarding_video_unpublish', { p_video_id: draft.id }),
    'ONBOARDING_VIDEO_STATE_INVALID', 'unpublishing a draft');

  // A draft whose file was removed cannot be published; nor can a retired one be published again.
  const rm = await store(sa).remove([other.path]);
  assert.equal((rm.data || []).length, 1, "a draft's own attached upload is removable: it is not live");
  await expectAppError(sa.db.rpc('admin_onboarding_video_publish', { p_video_id: other.id, p_replace_live: true }),
    'ONBOARDING_VIDEO_MEDIA_INVALID', 'publishing a draft whose file is gone');
  const rm2 = await store(sa).remove([retired.path]);
  assert.equal((rm2.data || []).length, 1, "a retired version's file is removable");
  await expectAppError(sa.db.rpc('admin_onboarding_video_publish', { p_video_id: retired.id, p_replace_live: true }),
    'ONBOARDING_VIDEO_MEDIA_INVALID', 'publishing a retired version again after its file was removed');

  assert.equal((await overview()).live_video_id, live.id, 'none of it disturbed the live version');
  assert.equal(await canSign(sa, live.path), true);
});

// ── Case 2: nobody else has a write path ─────────────────────────────────────

test('an Operations Admin, a Trainer, a student and a visitor are refused every admin RPC, table write and storage write', async () => {
  await resetOnboardingVideos();
  const live = await publishLive('Live');
  const draft = await draftWithMedia('Draft');
  await call(student, 'start_onboarding_video');              // a real progress row to forge against
  const rowBefore = await ownRow(student, live.id);
  const before1 = await overview();

  const adminCalls = [
    ['admin_onboarding_video_overview', {}],
    ['admin_onboarding_video_create_draft', { p_title: 'Forged', p_description: null, p_transcript: null }],
    ['admin_onboarding_video_update_details', { p_video_id: draft.id, p_title: 'Forged', p_description: '', p_transcript: '' }],
    ['admin_onboarding_video_attach_media', attachArgs(draft.id, draft.path)],
    ['admin_onboarding_video_publish', { p_video_id: draft.id, p_replace_live: true }],
    ['admin_onboarding_video_unpublish', { p_video_id: live.id }],
    ['admin_onboarding_video_delete', { p_video_id: draft.id }],
  ];
  for (const p of [ops, trainer, student]) {
    await Promise.all(adminCalls.map(([fn, args]) =>
      expectAppError(p.db.rpc(fn, args), 'FORBIDDEN', `${p.label} → ${fn}`)));
  }
  const anon = { db: anonClient(), label: 'anon', id: randomUUID() };
  await Promise.all(adminCalls.map(([fn, args]) => expectDenied(anon.db.rpc(fn, args), `anon → ${fn}`)));
  for (const [fn, args] of [['my_onboarding_video', {}], ['start_onboarding_video', {}],
    ['complete_onboarding_video', {}], ['report_onboarding_video_problem', { p_code: 'decode' }]]) {
    await expectDenied(anon.db.rpc(fn, args), `anon → ${fn}`);
  }

  // ★ ZERO CLIENT WRITE PATHS — the Super Admin included. The three tables carry one SELECT
  //   policy each and no DML grant, so a write is "permission denied for table", never a
  //   silent zero rows that a later policy could turn into a success.
  const stamp = new Date().toISOString();
  const tableWrites = (p) => [
    ['insert a version', p.db.from('onboarding_videos').insert({ title: 'Forged' }).select('id')],
    ['publish a version by UPDATE', p.db.from('onboarding_videos').update({ status: 'published' }).eq('id', draft.id).select('id')],
    ['delete a version', p.db.from('onboarding_videos').delete().eq('id', draft.id).select('id')],
    ['insert a finished progress row', p.db.from('student_onboarding_progress')
      .insert({ user_id: p.id, video_id: live.id, completed_at: stamp }).select('user_id')],
    ['finish by UPDATE', p.db.from('student_onboarding_progress')
      .update({ completed_at: stamp }).eq('video_id', live.id).select('user_id')],
    ['delete progress', p.db.from('student_onboarding_progress').delete().eq('video_id', live.id).select('user_id')],
    ['insert an event', p.db.from('onboarding_video_events').insert({ video_id: draft.id, action: 'publish' }).select('id')],
    ['rewrite an event', p.db.from('onboarding_video_events').update({ detail: { forged: true } }).eq('video_id', draft.id).select('id')],
    ['delete an event', p.db.from('onboarding_video_events').delete().eq('video_id', draft.id).select('id')],
  ];
  for (const p of [sa, ops, trainer, student, anon]) {
    await Promise.all(tableWrites(p).map(async ([what, attempt]) => {
      const { error } = await attempt;
      assert.ok(error, `${p.label}: "${what}" must be refused outright, not answered with zero rows`);
      assert.match(`${error.code} ${error.message}`, /42501|permission denied/i, `${p.label}: ${what} → ${error.message}`);
    }));
  }

  // Storage: no upload into the draft's folder, no overwrite, no delete.
  for (const p of [ops, trainer, student, anon]) {
    assertStorageRefused(await upload(p, newPath(draft.id)), `${p.label} uploading into a draft's folder`);
    assertStorageRefused(await upload(p, draft.path, { upsert: true }), `${p.label} overwriting a draft's file`);
    await assertNotRemovable(p, draft.path, `${p.label} removing a draft's file`);
    await assertNotRemovable(p, live.path, `${p.label} removing the live file`);
  }

  // What they can READ of the tables: a student their own progress, everyone else nothing.
  for (const p of [ops, trainer, student]) {
    const videos = await p.db.from('onboarding_videos').select('id');
    assert.deepEqual(videos.data, [],
      `${p.label} must read no version rows (a student learns of the live one through my_onboarding_video())`);
    const events = await p.db.from('onboarding_video_events').select('id');
    assert.deepEqual(events.data, [], `${p.label} must read no trail`);
  }
  assert.ok((await anon.db.from('onboarding_videos').select('id')).error, 'a visitor has no table grant at all');
  assert.deepEqual((await ops.db.from('student_onboarding_progress').select('user_id')).data, [],
    "an Operations Admin reads nobody's progress here");

  // And none of it changed anything.
  const after1 = await overview();
  assert.deepEqual(after1.versions.map((v) => [v.id, v.status, v.title]),
    before1.versions.map((v) => [v.id, v.status, v.title]));
  assert.equal(after1.live_video_id, live.id);
  assert.deepEqual(await ownRow(student, live.id), rowBefore, "the student's row is exactly as it was");
  const events = await sa.db.from('onboarding_video_events').select('action').order('id');
  assert.deepEqual(events.data.map((e) => e.action),
    ['create_draft', 'attach_media', 'publish', 'create_draft', 'attach_media'], 'no refused call left a trail row');
});

// ── Case 3: who may read what ────────────────────────────────────────────────

test('the live object is readable by an approved, enrolled member — the grace included — and by nobody else', async () => {
  await resetOnboardingVideos();
  const retired = await publishLive('Retired');
  const live = await publishLive('Live');
  const deleted = await draftWithMedia('Deleted');
  await call(sa, 'admin_onboarding_video_delete', { p_video_id: deleted.id });
  const draft = await draftWithMedia('Draft');
  const stray = newPath(draft.id);                            // uploaded, cited by no row
  assert.equal((await upload(sa, stray)).error, null);

  const members = [['an active member', student], ['a second plan', student2],
    ['a member in the 3-day grace', grace], ['a migrated member', migrated]];
  const outsiders = [['an expired member', expired], ['an unapproved account with a paid term', pending],
    ['a signed-in stranger with no membership', stranger], ['an Operations Admin', ops], ['a Trainer', trainer]];

  for (const [who, p] of members) {
    assert.equal(await canSign(p, live.path), true, `${who} must reach the live video`);
    const started = await call(p, 'start_onboarding_video');
    assert.deepEqual(started, { video_id: live.id, storage_path: live.path, duration_seconds: 100 },
      `${who}: start_onboarding_video() is the one function that discloses the object name`);
  }
  for (const [who, p] of outsiders) {
    assert.equal(await canSign(p, live.path), false, `${who} must NOT reach the live video`);
    await expectAppError(p.db.rpc('start_onboarding_video'), 'ONBOARDING_VIDEO_NOT_ELIGIBLE', who);
    const mine = await call(p, 'my_onboarding_video');
    assert.equal(mine.eligible, false, who);
    assert.equal(mine.required, false, who);
    assert.equal(mine.video, null, `${who} is told nothing about the video`);
  }
  const anon = anonClient();
  const signed = await anon.storage.from(BUCKET).createSignedUrl(live.path, 60);
  assert.ok(signed.error, 'anonymous signing must be refused');
  const listed = await anon.storage.from(BUCKET).list(`versions/${live.id}`, { limit: 10 });
  assert.ok(listed.error || (listed.data || []).length === 0, 'anonymous listing must reveal nothing');

  // ★ BY REFERENCE, NEVER BY PATH: everything the published row does not cite is unreadable to
  //   a student — including a real object sitting in a real version's folder.
  const notLive = [['a draft', draft.path], ['an upload no row cites', stray],
    ['a retired version', retired.path], ['a deleted version', deleted.path],
    ['a made-up path', newPath(randomUUID())], ['another name in the live folder', newPath(live.id)]];
  for (const [what, path] of notLive) {
    for (const [who, p] of [['an active member', student], ['a member in grace', grace]]) {
      assert.equal(await canSign(p, path), false, `${who} must not read ${what}`);
    }
  }
  const drafts = await store(student).list(`versions/${draft.id}`, { limit: 10 });
  assert.deepEqual(drafts.data || [], [], "a student cannot even list a draft's folder");
  const root = await store(student).list('versions', { limit: 100 });
  const folders = (root.data || []).map((x) => x.name);
  for (const v of [draft, retired, deleted]) {
    assert.ok(!folders.includes(v.id), 'a listing must not reveal that another version exists');
  }

  // ★ THE THREE POLICY HELPERS ARE EXECUTABLE BY EVERY SIGNED-IN USER — a policy qual runs as
  //   the caller, so without that grant every storage statement in every bucket would fail. A
  //   DIRECT call must therefore tell nobody more than the policies would: the two write-side
  //   helpers answer only to a holder of onboarding.manage, and the read helper says yes to
  //   exactly what the caller could sign anyway.
  const ask = (p, fn, name) => call(p, fn, { p_name: name });
  assert.strictEqual(await ask(student, 'onboarding_video_upload_allowed', newPath(draft.id)), false,
    'a student asking "may a file go into this folder?" must not learn that the draft exists');
  assert.strictEqual(await ask(student, 'onboarding_video_object_is_live', live.path), false,
    'the delete-policy helper answers only to a holder of onboarding.manage');
  assert.strictEqual(await ask(sa, 'onboarding_video_upload_allowed', newPath(draft.id)), true,
    'the control: the same question, asked by the Super Admin');
  assert.strictEqual(await ask(sa, 'onboarding_video_object_is_live', live.path), true);
  assert.strictEqual(await ask(student, 'onboarding_video_object_readable', live.path), true);
  assert.strictEqual(await ask(student, 'onboarding_video_object_readable', draft.path), false,
    'a draft is not readable, asked directly or through a signed URL');
  for (const [who, p] of [['an expired member', expired], ['an Operations Admin', ops]]) {
    assert.strictEqual(await ask(p, 'onboarding_video_object_readable', live.path), false,
      `${who} is told "no" about the live object, exactly as the read policy answers`);
  }

  // The Super Admin reads every object (that is what Preview signs), and the signed URL a
  // member mints really serves the bytes.
  for (const [what, path] of notLive.slice(0, 4)) {
    assert.equal(await canSign(sa, path), true, `the Super Admin previews ${what}`);
  }
  const url = await store(student).createSignedUrl(live.path, 600);
  const res = await fetch(url.data.signedUrl);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), TINY.toString(), 'the signed URL serves the uploaded bytes');

  // Staff are never recorded: the Super Admin can open and "finish" it, and no row appears.
  const opened = await call(sa, 'start_onboarding_video');
  assert.equal(opened.storage_path, live.path);
  assert.deepEqual(await call(sa, 'complete_onboarding_video'), { ok: true, recorded: false });
  const recorded = await sa.db.from('student_onboarding_progress').select('user_id').eq('video_id', live.id);
  assert.deepEqual(recorded.data.map((r) => r.user_id).sort(), members.map(([, p]) => p.id).sort(),
    'exactly the four learners who opened it have a row — no staff, no outsider');
});

// ── Case 4: the other buckets are untouched ──────────────────────────────────

test('other buckets behave as before #69: a student still signs a lesson image, and still uploads and removes a receipt', async () => {
  // ★ WHY THIS CAN BREAK AT ALL. Postgres ORs every permissive policy on storage.objects, and
  //   checks EXECUTE on each function a qual names when the statement starts — whichever
  //   bucket it is about. One #69 helper without its grant to `authenticated`, and every
  //   read, upload and delete in every bucket fails with "permission denied for function".
  const COURSE = 'e1111111-1111-4111-8111-111111111111';
  const LESSON = 'e2222222-2222-4222-8222-222222222222';
  const ASSET = 'e3333333-3333-4333-8333-333333333333';
  const IMAGE = `lessons/${COURSE}/${LESSON}/${ASSET.replace(/-/g, '')}.png`;
  // One request, as the Super Admin: #48's publish guard refuses a published course when
  // auth.uid() is null, and the #65 trigger derives the image's reference from the saved text.
  await asUser(sa.id, `
    declare v_module uuid := gen_random_uuid();
    begin
      insert into public.courses (id, slug, title, published, access_tier)
      values (${lit(COURSE)}, 'qbo-gs-collateral', 'QBO (collateral check)', true, 'essentials')
      on conflict (id) do nothing;
      insert into public.course_modules (id, course_id, title, position) values (v_module, ${lit(COURSE)}, 'M', 0);
      insert into public.course_lessons (id, module_id, course_id, title, type, position, content_format)
      values (${lit(LESSON)}, v_module, ${lit(COURSE)}, 'L', 'text', 0, 'markdown')
      on conflict (id) do nothing;
      insert into public.course_lesson_assets (id, course_id, storage_path, mime_type, byte_size)
      values (${lit(ASSET)}, ${lit(COURSE)}, ${lit(IMAGE)}, 'image/png', 1024)
      on conflict (id) do nothing;
      update public.course_lessons set text_content = ${lit(`![A screenshot](lesson-asset://${ASSET})`)}
       where id = ${lit(LESSON)};
      insert into storage.objects (bucket_id, name, metadata)
      values ('course-lesson-assets', ${lit(IMAGE)}, '{"mimetype":"image/png","size":1024}'::jsonb)
      on conflict do nothing;
    end;`);

  // SELECT: the #65 reference-based read still answers, both ways.
  const ok = await student.db.storage.from('course-lesson-assets').createSignedUrl(IMAGE, 60);
  assert.equal(ok.error, null, `a member must still sign an image their lesson shows: ${ok.error?.message}`);
  assert.ok(ok.data?.signedUrl);
  const miss = await student.db.storage.from('course-lesson-assets')
    .createSignedUrl(`lessons/${COURSE}/${LESSON}/${randomUUID().replace(/-/g, '')}.png`, 60);
  assert.ok(miss.error, 'an object nothing cites stays unreadable');
  assert.doesNotMatch(String(miss.error.message), /permission denied for function/i,
    'a refusal here must be the ordinary one, not a broken policy helper');
  assert.match(String(miss.error.message), /not found/i, `got "${miss.error.message}"`);

  // INSERT and DELETE: a student's own receipt, in a third bucket.
  const receipt = `${student.id}/gs-collateral-${randomUUID()}.png`;
  const up = await student.db.storage.from('enrollment-receipts')
    .upload(receipt, Buffer.from('not a real png'), { contentType: 'image/png' });
  assert.equal(up.error, null, `a student must still upload a receipt: ${up.error?.message}`);
  const rm = await student.db.storage.from('enrollment-receipts').remove([receipt]);
  assert.equal(rm.error, null, rm.error?.message);
  assert.equal((rm.data || []).length, 1, 'and still remove their own unreferenced upload');
});

// ── Case 5: a completion is for the CURRENT video ────────────────────────────

test('a completion needs the CURRENT video to have been opened: no row, or a row for the version it replaced, is refused', async () => {
  await resetOnboardingVideos();
  const v1 = await publishLive('V1');

  const never = await expectAppError(student.db.rpc('complete_onboarding_video'),
    'ONBOARDING_VIDEO_NOT_FINISHED', 'a completion for a video never opened');
  assert.deepEqual(contextOf(never), { current_video_id: v1.id, started: false });
  assert.equal(await ownRow(student, v1.id), null, 'a refused completion must not create a row');

  await call(student, 'start_onboarding_video');
  await backdateStart(student, v1.id, 3600);                 // V1 is "watched": only the version can refuse now

  const v2 = await publishLive('V2');                        // the Super Admin replaces it before the click
  const replaced = await expectAppError(student.db.rpc('complete_onboarding_video'),
    'ONBOARDING_VIDEO_NOT_FINISHED', 'a completion after the version was replaced');
  assert.deepEqual(contextOf(replaced), { current_video_id: v2.id, started: false },
    'current_video_id tells the screen which video to load');
  assert.equal((await ownRow(student, v1.id)).completed_at, null, "the replaced version's row is not finished by it");
  assert.equal(await ownRow(student, v2.id), null);

  // The screen reloads the current one, and that one can be finished.
  const reopened = await call(student, 'start_onboarding_video');
  assert.equal(reopened.video_id, v2.id);
  await backdateStart(student, v2.id, 3600);
  const done = await call(student, 'complete_onboarding_video');
  assert.equal(done.video_id, v2.id);
  assert.equal(done.first_completion, true);
  assert.equal((await ownRow(student, v1.id)).completed_at, null, 'finishing V2 does not finish V1');

  // Nothing live: neither opening nor finishing has a video to act on.
  await call(sa, 'admin_onboarding_video_unpublish', { p_video_id: v2.id });
  await expectAppError(student.db.rpc('start_onboarding_video'), 'ONBOARDING_VIDEO_UNAVAILABLE', 'opening when nothing is live');
  await expectAppError(student.db.rpc('complete_onboarding_video'), 'ONBOARDING_VIDEO_UNAVAILABLE', 'finishing when nothing is live');
  const mine = await call(student, 'my_onboarding_video');
  assert.equal(mine.video, null);
  assert.equal(mine.completed, true, 'what was finished stays finished');
});

// ── Case 6: the elapsed guard ────────────────────────────────────────────────

test('the elapsed guard refuses a completion that comes too soon, then records it once', async (t) => {
  const open = (p) => () => call(p, 'start_onboarding_video');
  const note = (st, label, r) => st.diagnostic(`${label}: refused with ${r.remaining} s left (the answer took ${r.waited.toFixed(1)} s)`);

  await t.test('a 100-second video waits 40 seconds, then records — and never re-stamps', async (st) => {
    await resetOnboardingVideos();
    const live = await publishLive('A hundred seconds', { duration: 100 });
    const wait = minElapsed(100);
    assert.equal(wait, 40, 'the client constants say 40% of the length');

    note(st, 'opened, then finished at once', await assertTooSoon(student, live.id,
      { secondsIn: 0, wait, what: 'a 100-second video, finished the moment it was opened', arm: open(student) }));
    // 25 s in: past the 5 s floor AND past the 24 s an unknown length would ask — so only
    // "40% of THIS video's length" still refuses it.
    note(st, '25 s in', await assertTooSoon(student, live.id,
      { secondsIn: 25, wait, what: '25 seconds into a 100-second video' }));
    assert.equal((await ownRow(student, live.id)).completed_at, null, 'a refusal records nothing');

    // Past the wait by any amount of link latency: it must record.
    await setClock(student, live.id, wait + 5);
    const done = await call(student, 'complete_onboarding_video');
    assert.deepEqual([done.ok, done.recorded, done.video_id, done.first_completion], [true, true, live.id, true]);
    assert.ok(done.completed_at);

    const again = await call(student, 'complete_onboarding_video');
    assert.equal(again.first_completion, false);
    assert.equal(ms(again.completed_at), ms(done.completed_at), 'a second completion keeps the first time');

    // A replay: the first open is kept for good, the last one moves, the completion does not.
    const row1 = await ownRow(student, live.id);
    await call(student, 'start_onboarding_video');
    const row2 = await ownRow(student, live.id);
    assert.equal(row2.first_started_at, row1.first_started_at, 'first_started_at is never rewritten by a replay');
    assert.ok(ms(row2.last_started_at) > ms(row1.last_started_at));
    assert.equal(row2.completed_at, row1.completed_at);
    const replay = await call(student, 'complete_onboarding_video');
    assert.equal(ms(replay.completed_at), ms(done.completed_at), 'a replay never re-stamps the completion');

    const mine = await call(student, 'my_onboarding_video');
    assert.deepEqual([mine.completed, mine.completed_current, mine.required], [true, true, false]);
    assert.equal(ms(mine.completed_at), ms(done.completed_at));
  });

  await t.test('an UNKNOWN length still waits: 40% of a 60-second stand-in, never zero', async (st) => {
    await resetOnboardingVideos();
    const live = await publishLive('Length not verified', { duration: null });
    const wait = minElapsed(null);
    assert.equal(wait, 24);
    const o = await overview();
    assert.equal(versionIn(o, live.id).duration_seconds, null);
    assert.equal(onboardingHealth(o).code, 'unverified', 'and the Super Admin is told the length was never read');

    note(st, 'opened, then finished at once', await assertTooSoon(student, live.id, {
      secondsIn: 0,
      wait,
      what: 'a video of unknown length, finished the moment it was opened',
      arm: async () => assert.equal((await call(student, 'start_onboarding_video')).duration_seconds, null),
    }));
    // 12 s in: past the 5 s floor, short of the stand-in's 24 s. A guard that read a NULL
    // length as "no wait beyond the floor" would let this through.
    note(st, '12 s in', await assertTooSoon(student, live.id,
      { secondsIn: 12, wait, what: '12 seconds into a video of unknown length' }));

    await setClock(student, live.id, wait + 5);
    const done = await call(student, 'complete_onboarding_video');
    assert.equal(done.first_completion, true);
  });

  await t.test('a one-second video still waits for the 5-second floor', async (st) => {
    await resetOnboardingVideos();
    const live = await publishLive('One second', { duration: 1 });
    const wait = minElapsed(1);
    assert.equal(wait, ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS, '40% of one second is under the floor');

    note(st, 'opened, then finished at once', await assertTooSoon(student, live.id,
      { secondsIn: 0, wait, what: 'a one-second video, finished the moment it was opened', arm: open(student) }));

    // One second past the floor is enough: the wait is the floor, not the 24-second stand-in.
    await setClock(student, live.id, wait + 1);
    const done = await call(student, 'complete_onboarding_video');
    assert.deepEqual([done.recorded, done.first_completion], [true, true]);
  });
});

// ── CT-1: one student's writes touch one student's row ───────────────────────

test("one student's problem report and completion leave a second student's row untouched", async () => {
  await resetOnboardingVideos();
  const live = await publishLive('Two students');

  await call(student2, 'start_onboarding_video');
  await call(student, 'start_onboarding_video');
  // BOTH are past the guard, so nothing but `user_id = the caller` keeps the second row out
  // of the first student's UPDATE.
  await backdateStart([student, student2], live.id, 3600);
  const other0 = await ownRow(student2, live.id);
  assert.ok(other0, 'the second student has a row of their own');

  const reported = await call(student, 'report_onboarding_video_problem', { p_code: 'decode' });
  assert.deepEqual(reported, { ok: true, recorded: true, code: 'decode' });
  const done = await call(student, 'complete_onboarding_video');
  assert.equal(done.first_completion, true);

  const mine = await ownRow(student, live.id);
  assert.equal(ms(mine.completed_at), ms(done.completed_at));
  assert.equal(mine.last_problem_code, 'decode');

  const other1 = await ownRow(student2, live.id);
  assert.deepEqual(other1, other0, "the second student's row must be byte-identical: not finished, not reported, not even touched");
  assert.deepEqual([other1.completed_at, other1.last_problem_at, other1.last_problem_code], [null, null, null]);
  const theirs = await call(student2, 'my_onboarding_video');
  assert.deepEqual([theirs.completed, theirs.completed_current], [false, false]);

  // A student reads their OWN progress only…
  const visible = await student.db.from('student_onboarding_progress').select('user_id');
  assert.deepEqual([...new Set(visible.data.map((r) => r.user_id))], [student.id]);
  // …and no student RPC takes an argument through which to name somebody else, a video or a
  // path: such a call does not resolve to a function at all.
  for (const [fn, args] of [
    ['complete_onboarding_video', { p_user_id: student2.id }],
    ['complete_onboarding_video', { p_video_id: live.id }],
    ['start_onboarding_video', { p_video_id: live.id }],
    ['start_onboarding_video', { p_storage_path: live.path }],
    ['my_onboarding_video', { p_user: student2.id }],
    ['report_onboarding_video_problem', { p_code: 'decode', p_user_id: student2.id }],
  ]) {
    const r = await student.db.rpc(fn, args);
    assert.equal(r.error?.code, 'PGRST202',
      `${fn}(${Object.keys(args).join(', ')}) must not resolve, got ${r.error?.code}: ${r.error?.message}`);
  }
  // ★ THE ONE FUNCTION THAT DOES TAKE A USER ID IS NOT A CLIENT'S TO CALL.
  //   user_onboarding_video_state() answers about ANY user — that is how the decision email
  //   learns whether Getting Started comes next for somebody else — so it is revoked from every
  //   client role. It RESOLVES (PostgREST knows it) and is then refused by the database: a
  //   student cannot ask it about a classmate, and not even the Super Admin's session reaches
  //   it directly. The same goes for the path parser beside it.
  for (const [who, client] of [['a student', student.db], ['the Super Admin', sa.db], ['a visitor', anonClient()]]) {
    for (const [fn, args] of [
      ['user_onboarding_video_state', { p_user: student2.id }],
      ['onboarding_video_path_version_id', { p_name: live.path }],
    ]) {
      const r = await client.rpc(fn, args);
      assert.ok(r.error, `${who} must not be able to call ${fn}(), but it answered ${JSON.stringify(r.data)}`);
      assert.equal(r.error.code, '42501', `${who} → ${fn}: ${r.error.code} ${r.error.message}`);
      assert.match(String(r.error.message), /permission denied for function/i);
    }
  }
  assert.deepEqual(await ownRow(student2, live.id), other0, 'still untouched');

  // The other way round: the second student's own completion does not re-stamp the first's.
  const done2 = await call(student2, 'complete_onboarding_video');
  assert.equal(done2.first_completion, true);
  assert.equal((await ownRow(student, live.id)).completed_at, mine.completed_at);

  const o = await overview();
  assert.equal(versionIn(o, live.id).completions, 2);
  assert.equal(versionIn(o, live.id).problems_7d, 1);
});

// ── SEM-1: a replacement published in the same instant as a completion ───────

test('a replacement published in the same instant as a completion: the student is told the NEW video, never "nothing is live"', async (t) => {
  await resetOnboardingVideos();

  // ★ REQUEST A — ONE transaction that publishes the next version over the live one as the
  //   Super Admin (role and JWT claims, as PostgREST would set them) and then HOLDS its row
  //   locks open. It commits the moment it SEES another backend blocked on a lock while running
  //   complete_onboarding_video (or after 25 s), and reports whether it saw one. A fixed
  //   pg_sleep would leave the overlap to the link's latency; this makes the overlap the thing
  //   the test waits for — and proves, from inside the publishing transaction, that the
  //   completion really queued behind the uncommitted publish rather than arriving a moment
  //   later. The role is reset before the hold: reading another session's query in
  //   pg_stat_activity needs pg_read_all_stats, which `authenticated` does not have.
  // ★ REQUEST B — the student, through their own client, sent only once A is seen holding.
  async function stageRace(current, title) {
    await call(student, 'start_onboarding_video');            // opens `current`…
    await backdateStart(student, current.id, 3600);           // …and has watched it: only the race can refuse
    const next = await draftWithMedia(title);

    const mark = `gs_sem1_${randomUUID().replace(/-/g, '')}`;
    const requestA = runSql(`
      begin;
      -- ${mark}
      select set_config('request.jwt.claims', ${claimsOf(sa)}, true);
      set local role authenticated;
      select public.admin_onboarding_video_publish(${lit(next.id)}::uuid, true);
      reset role;
      do $hold$
      declare
        v_seen boolean := false;
      begin
        for i in 1..250 loop
          perform pg_stat_clear_snapshot();
          select exists (select 1 from pg_stat_activity a
                          where a.pid <> pg_backend_pid()
                            and a.wait_event_type = 'Lock'
                            and a.query ilike '%complete_onboarding_video%') into v_seen;
          exit when v_seen;
          perform pg_sleep(0.1);
        end loop;
        perform set_config('gs.${mark}', v_seen::text, false);
      end
      $hold$;
      commit;
      select current_setting('gs.${mark}', true) as saw_waiter;`, { label: 'SEM-1 request A', retries: 0 })
      .then((rows) => ({ rows }), (error) => ({ error }));

    let b = null;
    let a;
    try {
      let holding = false;
      for (let i = 0; i < 8 && !holding; i += 1) {
        const seen = await runSql(`select wait_event from pg_stat_activity
                                    where pid <> pg_backend_pid() and query like '%${mark}%'`);
        holding = seen.some((r) => r.wait_event === 'PgSleep');
      }
      if (holding) b = await student.db.rpc('complete_onboarding_video');
    } finally {
      a = await requestA;                                     // never leave A's transaction behind
    }
    assert.equal(a.error, undefined, `request A failed: ${a.error?.sqlDetail || a.error?.message}`);
    return { previous: current, next, b, raced: a.rows?.[0]?.saw_waiter === 'true' };
  }

  // A stalled link can make the completion miss the publish (it then arrives after the commit,
  // and is simply told about the new version). That staging proves nothing about the race, so
  // the next version is staged over the one just published — three times at most.
  let live = await publishLive('Race V1');
  let race = null;
  for (let attempt = 1; attempt <= 3 && !race; attempt += 1) {
    const staged = await stageRace(live, `Race V${attempt + 1}`);
    if (staged.raced) {
      race = staged;
    } else {
      t.diagnostic(`staging ${attempt}: the completion did not overlap the publish; staging the race again`);
      live = staged.next;
    }
  }
  assert.ok(race, 'three stagings in a row failed to overlap the completion with the publish, so the race was never observed');

  const { b, previous, next } = race;
  assert.ok(b && b.error, 'the completion must be refused: the version the student watched is no longer the live one');
  assert.equal(b.error.hint, 'ONBOARDING_VIDEO_NOT_FINISHED',
    `the student must be told about the NEW video, got ${b.error.hint}: ${b.error.message}`);
  assert.deepEqual(contextOf(b.error), { current_video_id: next.id, started: false });

  const rows = await videoRows();
  assert.deepEqual([rows[previous.id].status, rows[next.id].status], ['retired', 'published']);
  assert.equal((await ownRow(student, previous.id)).completed_at, null, 'nothing was recorded against the retired version');
  assert.equal(await ownRow(student, next.id), null, 'nor against a version the student never opened');
  assert.equal((await call(student, 'start_onboarding_video')).video_id, next.id, 'the screen reloads, and gets the new video');
});

// ── Case 7: the version guard holds for the table owner too ──────────────────

test('the version state machine refuses every illegal step, as postgres; the steps the RPCs take are stamped', async () => {
  await resetOnboardingVideos();
  // Five versions in ONE request, each through the real admin RPCs under the Super Admin's
  // identity. The objects are fixture rows (no bytes): the guard never looks at storage.
  const key = `gs.stage_${randomUUID().replace(/-/g, '')}`;
  const staged = await runSql(`
    do $stage$
    declare
      v_ids uuid[] := '{}';
      v uuid;
      p text;
    begin
      perform set_config('request.jwt.claims', ${claimsOf(sa)}, true);
      for i in 1..5 loop
        v := (public.admin_onboarding_video_create_draft('Stage ' || i, null, null)->>'video_id')::uuid;
        if i <= 4 then
          p := 'versions/' || v || '/' || gen_random_uuid() || '.mp4';
          insert into storage.objects (bucket_id, name, metadata)
          values ('onboarding-videos', p, '{"mimetype":"video/mp4","size":1024}'::jsonb);
          perform public.admin_onboarding_video_attach_media(v, p, 1024, 'video/mp4', 30, 'stage.mp4');
        end if;
        v_ids := v_ids || v;
      end loop;
      perform public.admin_onboarding_video_publish(v_ids[1], false);
      perform public.admin_onboarding_video_publish(v_ids[2], true);     -- retires the first
      perform public.admin_onboarding_video_delete(v_ids[3]);
      perform set_config(${lit(key)}, json_build_object(
        'retired', v_ids[1], 'live', v_ids[2], 'deleted', v_ids[3], 'draft', v_ids[4], 'bare', v_ids[5])::text, false);
    end
    $stage$;
    select current_setting(${lit(key)}, true)::json as ids;`, { label: 'stage versions', retries: 0 });
  const id = staged[0].ids;

  const before1 = await videoRows();
  assert.deepEqual([before1[id.retired].status, before1[id.live].status, before1[id.deleted].status,
    before1[id.draft].status, before1[id.bare].status], ['retired', 'published', 'deleted', 'draft', 'draft']);
  // The stamps the RPCs are allowed to write, each by the transition that owns it.
  for (const v of Object.values(before1)) assert.equal(v.created_by, sa.id);
  assert.equal(before1[id.live].published_by, sa.id);
  assert.ok(before1[id.live].published_at && before1[id.live].last_published_at);
  assert.equal(before1[id.retired].retired_by, sa.id);
  assert.ok(before1[id.retired].retired_at);
  assert.equal(before1[id.deleted].deleted_by, sa.id);
  assert.ok(before1[id.deleted].deleted_at);
  assert.equal(before1[id.draft].published_at, null);

  const set = (what, which) => `update public.onboarding_videos set ${what} where id = '${id[which]}'`;
  const illegal = {
    'deleted → draft': set(`status = 'draft'`, 'deleted'),
    'deleted → published': set(`status = 'published'`, 'deleted'),
    'a text edit on a deleted version': set(`title = 'Rewritten'`, 'deleted'),
    'draft → retired': set(`status = 'retired'`, 'draft'),
    'published → draft': set(`status = 'draft'`, 'live'),
    'published → deleted': set(`status = 'deleted', deleted_at = now()`, 'live'),
    'retired → draft': set(`status = 'draft'`, 'retired'),
    'a published_at rewrite on the live version': set(`published_at = now() - interval '1 year'`, 'live'),
    'a published_at rewrite on a retired version': set(`published_at = now() - interval '1 year'`, 'retired'),
    'a published_at set on a draft': set(`published_at = now()`, 'draft'),
    'a last_published_at rewrite': set(`last_published_at = now() - interval '1 year'`, 'live'),
    'a retired_at rewrite': set(`retired_at = now() - interval '1 year'`, 'retired'),
    'a deleted_at rewrite': set(`deleted_at = now() - interval '1 year'`, 'deleted'),
    'a media change on the published version': set(`duration_seconds = 1`, 'live'),
    'a file swap on the published version': set(`storage_path = null, media_attached_at = null`, 'live'),
    'a media change on a retired version': set(`byte_size = 1`, 'retired'),
    'created_by set to another account': set(`created_by = '${ops.id}'`, 'draft'),
    'published_by set to another account': set(`published_by = '${ops.id}'`, 'live'),
    'retired_by set to another account': set(`retired_by = '${ops.id}'`, 'retired'),
    'deleted_by set to another account': set(`deleted_by = '${ops.id}'`, 'deleted'),
    'an id rewrite': set(`id = gen_random_uuid()`, 'bare'),
    'a created_at rewrite': set(`created_at = now() - interval '1 day'`, 'draft'),
  };
  const out = await sqlAttempts({
    ...illegal,
    'DELETE a version': `delete from public.onboarding_videos where id = '${id.bare}'`,
    'DELETE an event': `delete from public.onboarding_video_events where video_id = '${id.draft}'`,
    'UPDATE an event': `update public.onboarding_video_events set detail = '{"forged":true}'::jsonb where video_id = '${id.draft}'`,
    'an event actor set to another account': `update public.onboarding_video_events set actor_id = '${ops.id}' where video_id = '${id.draft}'`,
    // Not the guard but the constraints beside it:
    'a second live version': set(`status = 'published', published_at = now(), last_published_at = now()`, 'draft'),
    'a live version with no file': set(`status = 'published', published_at = now(), last_published_at = now()`, 'bare'),
    "a file in another version's folder": set(`storage_path = 'versions/${id.live}/${randomUUID()}.mp4', media_attached_at = now()`, 'bare'),
    // Controls — what the guard must still ALLOW (each rolled back like the rest):
    'CONTROL a draft text edit': set(`title = 'Renamed'`, 'draft'),
    'CONTROL a published text edit': set(`description = 'Edited while live'`, 'live'),
    'CONTROL created_by to NULL': set(`created_by = null`, 'draft'),
    'CONTROL published_by to NULL': set(`published_by = null`, 'live'),
    'CONTROL deleted_by to NULL on a deleted version': set(`deleted_by = null`, 'deleted'),
    'CONTROL an event actor to NULL': `update public.onboarding_video_events set actor_id = null where video_id = '${id.draft}'`,
  });

  for (const label of Object.keys(illegal)) {
    assert.equal(out[label].accepted, false, `${label}: the guard accepted it`);
    assert.equal(out[label].code, 'ONBOARDING_VIDEO_STATE_INVALID', `${label}: ${out[label].state} ${out[label].message}`);
  }
  for (const label of ['DELETE a version', 'DELETE an event', 'UPDATE an event', 'an event actor set to another account']) {
    assert.equal(out[label].accepted, false, `${label}: history must be permanent`);
    assert.equal(out[label].code, 'FORBIDDEN', `${label}: ${out[label].state} ${out[label].message}`);
  }
  assert.deepEqual([out['a second live version'].accepted, out['a second live version'].state], [false, '23505'],
    `two live versions: ${out['a second live version'].message}`);
  assert.match(out['a second live version'].message, /onboarding_videos_one_live/);
  assert.deepEqual([out['a live version with no file'].accepted, out['a live version with no file'].state], [false, '23514']);
  assert.match(out['a live version with no file'].message, /onboarding_videos_live_has_media/);
  assert.deepEqual([out["a file in another version's folder"].accepted, out["a file in another version's folder"].state], [false, '23514']);
  assert.match(out["a file in another version's folder"].message, /onboarding_videos_path_in_own_folder/);
  for (const label of Object.keys(out).filter((l) => l.startsWith('CONTROL'))) {
    assert.equal(out[label].accepted, true, `${label}: the guard must allow it (${out[label].code} ${out[label].message})`);
  }

  assert.deepEqual(await videoRows(), before1, 'and the whole matrix left every row exactly as it was');
});

// ── Case 8: an actor can be deleted; the history stays ───────────────────────

test('deleting the Auth account of someone who published a video succeeds, and only empties the actor columns', async () => {
  await resetOnboardingVideos();
  const svc = serviceClient();
  const email = `gs-throwaway-${randomUUID().slice(0, 8)}@shadow.test`;
  const created = await svc.auth.admin.createUser({ email, password: `Gs-${randomUUID()}`, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  throwawayId = created.data.user.id;
  await seedStaff({ id: throwawayId }, 'super_admin');

  // Every action a Super Admin can take, under the throwaway's identity: they end up in all
  // four actor columns of one version, and as the actor of five trail rows.
  await asUser(throwawayId, `
    declare v uuid; p text;
    begin
      v := (public.admin_onboarding_video_create_draft('Made by a departing admin', null, null)->>'video_id')::uuid;
      p := 'versions/' || v || '/' || gen_random_uuid() || '.mp4';
      insert into storage.objects (bucket_id, name, metadata)
      values ('onboarding-videos', p, '{"mimetype":"video/mp4","size":1024}'::jsonb);
      perform public.admin_onboarding_video_attach_media(v, p, 1024, 'video/mp4', 30, 'x.mp4');
      perform public.admin_onboarding_video_publish(v, true);
      perform public.admin_onboarding_video_unpublish(v);
      perform public.admin_onboarding_video_delete(v);
    end;`);

  const actors = 'id, status, created_by, published_by, retired_by, deleted_by, published_at, retired_at, deleted_at';
  const before1 = (await sa.db.from('onboarding_videos').select(actors)).data;
  assert.equal(before1.length, 1);
  assert.deepEqual([before1[0].status, before1[0].created_by, before1[0].published_by, before1[0].retired_by, before1[0].deleted_by],
    ['deleted', throwawayId, throwawayId, throwawayId, throwawayId]);
  const trail0 = (await sa.db.from('onboarding_video_events').select('id, action, actor_id, video_id').order('id')).data;
  assert.deepEqual(trail0.map((e) => e.action), ['create_draft', 'attach_media', 'publish', 'unpublish', 'delete']);
  assert.ok(trail0.every((e) => e.actor_id === throwawayId));

  // ★ THE FK's ON DELETE SET NULL IS AN UPDATE, and it fires both guards — on a DELETED version
  //   (where nothing else may change) and on an append-only table. A guard that refused it
  //   would make this account impossible to delete.
  const gone = await svc.auth.admin.deleteUser(throwawayId);
  assert.equal(gone.error, null, `the account must be deletable: ${gone.error?.message}`);
  assert.equal(Number(await sqlScalar(`select count(*) from auth.users where id = '${throwawayId}'::uuid`)), 0);
  throwawayId = null;

  const after1 = (await sa.db.from('onboarding_videos').select(actors)).data;
  assert.equal(after1.length, 1, 'the version outlives the account that made it');
  assert.deepEqual([after1[0].created_by, after1[0].published_by, after1[0].retired_by, after1[0].deleted_by],
    [null, null, null, null]);
  assert.deepEqual([after1[0].id, after1[0].status, after1[0].published_at, after1[0].retired_at, after1[0].deleted_at],
    [before1[0].id, 'deleted', before1[0].published_at, before1[0].retired_at, before1[0].deleted_at],
    'nothing but the actor columns changed');
  const trail1 = (await sa.db.from('onboarding_video_events').select('id, action, actor_id, video_id').order('id')).data;
  assert.deepEqual(trail1.map((e) => [e.id, e.action, e.video_id]), trail0.map((e) => [e.id, e.action, e.video_id]),
    'the trail keeps every row');
  assert.ok(trail1.every((e) => e.actor_id === null));
});

// ── Case 9: problem reports ──────────────────────────────────────────────────

test('a problem report never creates a row, is recorded at most once a minute, and is coerced to a known code', async () => {
  await resetOnboardingVideos();
  const live = await publishLive('Reports');

  // Not opened yet: there is no row to update, and a report must not make one.
  const none = await call(student, 'report_onboarding_video_problem', { p_code: 'decode' });
  assert.deepEqual(none, { ok: true, recorded: false, code: 'decode' });
  assert.equal(await ownRow(student, live.id), null, 'a report must never create a progress row');
  assert.deepEqual((await sa.db.from('student_onboarding_progress').select('user_id')).data, []);

  // Four learners, the four specific codes the player reports (whatever their case or padding).
  const learners = [student, student2, grace, migrated];
  const specific = ONBOARDING_PROBLEM_CODES.filter((c) => c !== 'other');
  assert.equal(specific.length, learners.length, 'one learner per specific code');
  for (const [i, p] of learners.entries()) {
    await call(p, 'start_onboarding_video');
    const r = await call(p, 'report_onboarding_video_problem', { p_code: `  ${specific[i].toUpperCase()} ` });
    assert.deepEqual(r, { ok: true, recorded: true, code: specific[i] }, `${p.label} reporting ${specific[i]}`);
    assert.equal((await ownRow(p, live.id)).last_problem_code, specific[i], 'the row CHECK accepts every code the client sends');
  }

  // Inside the minute nothing moves — not the time, not the code, not updated_at. Judged on the
  // DATABASE's clock, not this link's: a report that WAS recorded is a defect only when less
  // than a minute separates it from the one before. (A stalled link can out-wait the limit;
  // that attempt proves nothing, and the next one follows it at once.)
  let first = null;
  for (let attempt = 1; attempt <= 3 && !first; attempt += 1) {
    const before1 = await ownRow(student, live.id);
    const again = await call(student, 'report_onboarding_video_problem', { p_code: 'playback' });
    const after1 = await ownRow(student, live.id);
    if (again.recorded) {
      const gap = ms(after1.last_problem_at) - ms(before1.last_problem_at);
      assert.ok(gap >= 60_000,
        `a second report was recorded ${gap} ms after the one before it: the once-a-minute limit is missing`);
    } else {
      assert.deepEqual(again, { ok: true, recorded: false, code: 'playback' });
      assert.deepEqual(after1, before1, 'a second report inside a minute leaves the row exactly as it was');
      first = after1;
    }
  }
  assert.ok(first, 'three reports in a row each arrived over a minute after the last, so the limit was never observed');

  // A minute later, and a code the client never sends.
  await runSql(`update public.student_onboarding_progress set last_problem_at = now() - interval '61 seconds'
                 where user_id = '${student.id}'::uuid and video_id = '${live.id}'::uuid`);
  const junk = await call(student, 'report_onboarding_video_problem', { p_code: '<script>alert(1)</script>' });
  assert.deepEqual(junk, { ok: true, recorded: true, code: 'other' });
  const third = await ownRow(student, live.id);
  assert.equal(third.last_problem_code, 'other');
  assert.ok(ms(third.last_problem_at) > ms(first.last_problem_at), 'and this one moved the time');
  assert.equal(third.completed_at, null, 'a report finishes nothing');

  // Not learners: staff, and anyone not approved and enrolled. Silent, and nothing recorded.
  for (const p of [sa, ops, staffMember, expired, pending, stranger]) {
    assert.deepEqual(await call(p, 'report_onboarding_video_problem', { p_code: 'decode' }), { ok: false }, p.label);
  }
  const rows = (await sa.db.from('student_onboarding_progress').select('user_id, completed_at')).data;
  assert.deepEqual(rows.map((r) => r.user_id).sort(), learners.map((p) => p.id).sort(), 'only the four learners have rows');
  assert.ok(rows.every((r) => r.completed_at === null));

  const o = await overview();
  assert.equal(versionIn(o, live.id).problems_7d, 4);
  assert.equal(onboardingHealth(o).code, 'playback_problems', 'and the Super Admin is told students hit problems');
});

// ── Case 10: who is asked to watch ───────────────────────────────────────────

test('who is asked to watch: new members once, and nobody else', async (t) => {
  await resetOnboardingVideos();
  const my = (p) => call(p, 'my_onboarding_video');
  let v1; let v2; let base;

  await t.test('with nothing live, nobody is asked', async () => {
    base = (await overview()).counts;
    assert.deepEqual(base, { active_members: 4, pending_students: 0, completed_students: 0 },
      'members: the two active students, the one in grace and the migrated one — not the expired, the unapproved or staff');
    for (const p of [student, sa]) {
      const m = await my(p);
      assert.equal(m.required, false, p.label);
      assert.equal(m.video, null);
      assert.equal(m.media_available, false);
    }
    assert.equal((await overview()).required_since, null, 'no cutoff before the first publish');
  });

  await t.test('after the first publish: a member who joined AFTER it is asked; everyone who was already here is not', async () => {
    v1 = await publishLive('Welcome V1');
    // Joined after the publish: two new members, a Trainer who also bought a plan, and a
    // grandfathered member — paid before dated terms, so no subscription row at all.
    await seedMember(newbie, { planKey: 'silver_self_paced' });
    await seedMember(mid, { planKey: 'sampler' });
    await seedMember(staffMember, { planKey: 'silver_self_paced' });
    await runSql(`update public.profiles set is_paid = true where id = '${grandfathered.id}'::uuid`);

    const asked = await my(newbie);
    assert.deepEqual(Object.keys(asked).sort(), ['can_manage', 'completed', 'completed_at', 'completed_current',
      'configured', 'eligible', 'media_available', 'required', 'video']);
    assert.deepEqual([asked.configured, asked.eligible, asked.required, asked.completed, asked.completed_at,
      asked.completed_current, asked.media_available, asked.can_manage], [true, true, true, false, null, false, true, false]);
    assert.deepEqual(Object.keys(asked.video).sort(), ['description', 'duration_seconds', 'id', 'published_at', 'title', 'transcript'],
      'metadata only: never an object name');
    assert.equal(asked.video.id, v1.id);
    assert.doesNotMatch(JSON.stringify(asked), /versions\//, 'my_onboarding_video() never returns a path');
    assert.equal((await my(mid)).required, true, 'the second new member');

    for (const [why, p] of [
      ['a member whose first subscription predates the first publish', student],
      ['a member in grace who was already here', grace],
      ['a migrated student activated before the first publish (edge a)', migrated],
    ]) {
      const m = await my(p);
      assert.deepEqual([m.eligible, m.required], [true, false], why);
      assert.equal(m.video.id, v1.id, `${why}: they may still watch it`);
    }

    const staff = await my(staffMember);
    assert.deepEqual([staff.eligible, staff.required], [true, false], 'staff are never learners, even with a plan bought after the publish');
    assert.deepEqual(await call(staffMember, 'start_onboarding_video').then((r) => r.video_id), v1.id, 'they may watch');
    assert.deepEqual(await call(staffMember, 'complete_onboarding_video'), { ok: true, recorded: false }, 'and nothing is recorded');

    // ★ "STAFF" MEANS AN INVITED OR AN ACTIVE MEMBERSHIP, AND NOTHING ELSE (#50, #52). An
    //   invitation not yet accepted already exempts its holder. A suspended membership confers
    //   nothing, and its holder may be a real student — so with a plan bought after the publish
    //   they are asked like any other new member.
    await seedStaff(staffMember, 'trainer', 'invited');
    const invited = await my(staffMember);
    assert.deepEqual([invited.eligible, invited.required], [true, false], 'an invited Trainer is already staff: not asked');
    await seedStaff(staffMember, 'trainer', 'suspended');
    const suspended = await my(staffMember);
    assert.deepEqual([suspended.eligible, suspended.required], [true, true],
      'a suspended membership is not staff: this member bought a plan after the publish, so they are asked');
    await seedStaff(staffMember, 'trainer');                  // active again, for the counts below and the tests after
    assert.strictEqual((await my(staffMember)).required, false);

    const admin = await my(sa);
    assert.deepEqual([admin.can_manage, admin.required], [true, false]);

    const gf = await my(grandfathered);
    assert.equal(gf.eligible, true, 'a grandfathered member is enrolled');
    assert.strictEqual(gf.required, false, 'with no subscription row `required` is the boolean false, never null (edge b)');

    const o = await overview();
    assert.deepEqual(o.counts, { active_members: base.active_members + 3, pending_students: 2, completed_students: 0 },
      'pending: the two new members — not the grandfathered one, not the Trainer');
    assert.equal(ms(o.required_since), ms(versionIn(o, v1.id).published_at));
  });

  await t.test('finishing ANY version ends it: a replacement does not ask again', async () => {
    await call(newbie, 'start_onboarding_video');
    await backdateStart(newbie, v1.id, 3600);
    const done = await call(newbie, 'complete_onboarding_video');
    assert.equal(done.first_completion, true);
    assert.deepEqual((await overview()).counts, { active_members: base.active_members + 3, pending_students: 1, completed_students: 1 });

    v2 = await publishLive('Welcome V2');                     // replaces V1
    const m = await my(newbie);
    assert.deepEqual([m.required, m.completed, m.completed_current], [false, true, false],
      'finished V1, so V2 is not required — though it is not the version they finished');
    assert.equal(ms(m.completed_at), ms(done.completed_at), 'the first completion is what is reported');
    assert.equal(m.video.id, v2.id);
  });

  await t.test('the cutoff is the FIRST publish of any version, even one since retired or deleted (edge c)', async () => {
    // `mid` joined after V1's publish and BEFORE V2's. Were the cutoff the live version's own
    // publish, they would count as an existing member and never be asked.
    const o1 = await overview();
    assert.equal(versionIn(o1, v1.id).status, 'retired');
    assert.equal(ms(o1.required_since), ms(versionIn(o1, v1.id).published_at), 'a retired first publish still sets the cutoff');
    assert.ok(ms(versionIn(o1, v2.id).published_at) > ms(o1.required_since));
    assert.equal((await my(mid)).required, true, 'joined between the two publishes: asked');
    assert.equal((await my(student)).required, false, 'and an existing member still is not');

    await call(sa, 'admin_onboarding_video_delete', { p_video_id: v1.id });
    const o2 = await overview();
    assert.equal(versionIn(o2, v1.id).status, 'deleted');
    assert.equal(ms(o2.required_since), ms(o1.required_since), 'deleting the first version does not move the cutoff');
    assert.equal((await my(mid)).required, true);
  });

  await t.test("a grandfathered member's first subscription row, created after the publish, asks them once (edge b)", async () => {
    await seedMember(grandfathered, { planKey: 'vip' });     // an upgrade: their first row ever
    const gf = await my(grandfathered);
    assert.strictEqual(gf.required, true);
    assert.deepEqual((await overview()).counts, { active_members: base.active_members + 3, pending_students: 2, completed_students: 1 },
      'pending: the member who joined between versions, and now the grandfathered one');
  });

  await t.test('the live file deleted from storage: nobody is asked, and the Super Admin is told', async () => {
    assert.equal(await canSign(mid, v2.path), true);
    await deleteObjectRow(BUCKET, v2.path);

    const m = await my(mid);
    assert.deepEqual([m.required, m.media_available, m.eligible], [false, false, true],
      'a version whose file is gone gates nobody');
    assert.strictEqual((await my(grandfathered)).required, false);
    await expectAppError(mid.db.rpc('start_onboarding_video'), 'ONBOARDING_VIDEO_UNAVAILABLE', 'opening a video whose file is gone');
    assert.equal(await canSign(mid, v2.path), false);

    const o = await overview();
    assert.equal(o.live_video_id, v2.id, 'the row is still published');
    assert.strictEqual(versionIn(o, v2.id).media_present, false);
    const health = onboardingHealth(o);
    assert.deepEqual([health.code, health.level], ['file_missing', 'danger']);
  });
});

// ── Case 11: what the decision email may state ───────────────────────────────

test('the decision email facts: refused to a Trainer, the student and a visitor; the plan, term and cohort for a reviewer', async (t) => {
  await resetOnboardingVideos();
  await publishLive('Welcome');                               // so "Getting Started comes next" is a real question
  const batchId = await makeBatch('2036-03', { name: 'March 2036', status: 'open' });
  const plans = Object.fromEntries((await runSql(`
    select key, name, tagline, entitlement_summary, community_segment, access_days
      from public.enrollment_plans where key in ('vip', 'sampler', 'silver_self_paced')`)).map((p) => [p.key, p]));
  const DAY = 86_400_000;
  const facts = (p, requestId) => call(p, 'enrollment_decision_email_facts', { p_request_id: requestId });
  const approve = (requestId, batch = null) =>
    call(ops, 'admin_finalize_enrollment', { p_request_id: requestId, p_batch_id: batch });
  /** A pending request, as the paywall files one. `days` makes it an extension of that many days. */
  const request = (p, planKey, price, { batch = null, days = null } = {}) => sqlScalar(`
    with r as (
      insert into public.enrollment_requests
        (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status, batch_id,
         request_kind, extension_days, expires_at)
      values ('${p.id}'::uuid, ${lit(planKey)}, ${lit(plans[planKey].name)}, ${lit(p.label)}, ${lit(p.email)},
              ${price}, ${price}, 'pending_review', ${batch ? `'${batch}'::uuid` : 'null'},
              ${lit(days ? 'extension' : 'new')}, ${days ?? 'null'}, now() + interval '3 days')
      returning id)
    select id::text from r`);
  /** The reviewer's own PATCH, as the Enrollments screen sends it (#48's column grant). */
  const reject = async (requestId) => {
    const r = await ops.db.from('enrollment_requests')
      .update({ status: 'rejected', rejection_reason: 'The receipt is unreadable', updated_at: new Date().toISOString() })
      .eq('id', requestId).eq('status', 'pending_review').select('id');
    assert.equal(r.error, null, r.error?.message);
    assert.equal((r.data || []).length, 1, 'the rejection must have been recorded');
  };
  let vipReq;

  await t.test('a VIP approval: the catalog plan, the granted term, the cohort — and Getting Started comes next', async () => {
    vipReq = await request(applicantVip, 'vip', 16999, { batch: batchId });
    const waiting = await facts(ops, vipReq);
    assert.deepEqual([waiting.request.status, waiting.request.kind, waiting.term], ['pending_review', 'new', null],
      'a pending request granted nothing, so it states no term');
    assert.equal(waiting.getting_started_required, false, 'and its student is not a member yet');

    assert.equal((await approve(vipReq, batchId)).ok, true);
    const vip = await facts(ops, vipReq);
    assert.deepEqual(Object.keys(vip).sort(), ['batch', 'getting_started_required', 'plan', 'request', 'term']);
    assert.deepEqual(vip.request, { id: vipReq, status: 'approved', kind: 'new', extension_days: null });
    assert.deepEqual(vip.plan, plans.vip, 'the plan is the catalog row, never text from the request');
    assert.equal(vip.plan.community_segment, 'vip');
    assert.equal(vip.term.status, 'active');
    assert.equal(ms(vip.term.ends_at) - ms(vip.term.started_at), plans.vip.access_days * DAY, 'the term is the plan length');
    assert.equal(ms(vip.term.grace_ends_at) - ms(vip.term.ends_at), 3 * DAY, 'plus the 3-day grace');
    assert.deepEqual(vip.batch, { name: 'March 2036', code: '2036-03', starts_on: '2036-03-01' });
    assert.strictEqual(vip.getting_started_required, true,
      'approved after the first publish, finished nothing: the email may say Getting Started comes next');
  });

  await t.test('a rejection states no term and no cohort; the resubmitted request states the term it was granted', async () => {
    const rejectedReq = await request(applicant, 'sampler', 1499, { batch: batchId });   // names a batch it has no use for
    await reject(rejectedReq);
    const rejected = await facts(ops, rejectedReq);
    assert.deepEqual([rejected.request.status, rejected.term, rejected.batch, rejected.getting_started_required],
      ['rejected', null, null, false], 'a rejection granted nothing; a cohort is a VIP-only fact');
    assert.equal(rejected.plan.key, 'sampler');

    const samplerReq = await request(applicant, 'sampler', 1499);
    await approve(samplerReq);
    const sampler = await facts(ops, samplerReq);
    assert.deepEqual(sampler.plan, plans.sampler);
    assert.equal(sampler.batch, null);
    assert.equal(ms(sampler.term.ends_at) - ms(sampler.term.started_at), plans.sampler.access_days * DAY);
    assert.strictEqual(sampler.getting_started_required, true);
    assert.equal((await call(applicant, 'my_onboarding_video')).required, true, 'the same answer the student gets at the gate');

    // Once the student has finished it, the email no longer says it comes next.
    const opened = await call(applicant, 'start_onboarding_video');
    await backdateStart(applicant, opened.video_id, 3600);
    await call(applicant, 'complete_onboarding_video');
    assert.strictEqual((await facts(ops, samplerReq)).getting_started_required, false);
  });

  await t.test('a REJECTED extension states no term — not even the live one the member still holds', async () => {
    // student2 holds a live, dated term. The fallback to "the live term" exists for ONE case (an
    // APPROVED extension of a term with no end date). A rejected request granted nothing, and an
    // email that printed the member's current expiry under it would read as a grant.
    const req = await request(student2, 'sampler', 1499, { days: 60 });
    await reject(req);
    const f = await facts(ops, req);
    assert.deepEqual(f.request, { id: req, status: 'rejected', kind: 'extension', extension_days: 60 });
    assert.equal(f.term, null, 'a rejected extension must state no term');
    assert.equal(f.plan.key, 'sampler');
    assert.equal(f.batch, null);
  });

  await t.test('an APPROVED extension states the extended term, and an existing member is still not asked to watch', async () => {
    const before1 = (await runSql(`select id::text, ends_at from public.subscriptions
                                   where user_id = '${student2.id}'::uuid and status = 'active'`))[0];
    // ★ THE REQUEST NAMES A PLAN THE MEMBER IS NOT ON (they hold Essentials). An extension is
    //   granted on the member's CURRENT plan, so until something is granted the plan is the one
    //   the request names, and afterwards it is the granted term's — never the other way round.
    const req = await request(student2, 'silver_self_paced', 2999, { days: 60 });
    const waiting = await facts(ops, req);
    assert.deepEqual([waiting.request.status, waiting.request.kind, waiting.term], ['pending_review', 'extension', null],
      'a PENDING extension granted nothing yet: it states no term, though the member holds a live one');
    assert.equal(waiting.plan.key, 'silver_self_paced', 'nothing granted: the plan is the one the request names');
    assert.equal((await approve(req)).ok, true);

    const f = await facts(ops, req);
    assert.deepEqual(f.request, { id: req, status: 'approved', kind: 'extension', extension_days: 60 });
    assert.deepEqual(f.plan, plans.sampler,
      "the plan is the GRANTED term's: an extension stays on the member's current plan, whatever the request named");
    assert.equal(f.term.status, 'active');
    assert.equal(ms(f.term.ends_at) - ms(before1.ends_at), 60 * DAY, 'sixty days, stacked on the expiry they already had');

    // ★ THE RULE READS THE MEMBER'S FIRST SUBSCRIPTION ROW, NOT THEIR CURRENT ONE. An extension
    //   (like a renewal or an upgrade) supersedes the old row and inserts a new one — created
    //   just now, after the first publish. A rule that read the current row would send every
    //   renewing member back to the welcome video.
    const rowsNow = await runSql(`select id::text, status from public.subscriptions
                                  where user_id = '${student2.id}'::uuid order by created_at`);
    assert.equal(rowsNow.length, 2, 'the extension added a second row');
    assert.deepEqual([rowsNow[0].id, rowsNow[0].status, rowsNow[1].status], [before1.id, 'expired', 'active']);
    assert.strictEqual(f.getting_started_required, false, 'an existing member who extends is not a new student');
    const mine = await call(student2, 'my_onboarding_video');
    assert.deepEqual([mine.eligible, mine.required, mine.completed], [true, false, false]);
  });

  await t.test('an approved extension of a term with NO end date states the live term, which has no date to print', async () => {
    // A legacy member: a term with no end date, from long before any video. approve_extension()
    // returns such a term unchanged (it could only shorten it), so no row carries the request.
    const legacy = await makePersona('gs-legacy', { fullName: 'GS Legacy' });
    await runSql(`
      delete from public.subscriptions where user_id = '${legacy.id}'::uuid;
      insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, created_at)
      values ('${legacy.id}'::uuid, 'silver_self_paced', 'active', now() - interval '400 days', null, null,
              now() - interval '400 days');
      update public.profiles set is_paid = true, plan = 'silver_self_paced' where id = '${legacy.id}'::uuid;`);
    const req = await request(legacy, 'silver_self_paced', 2999, { days: 60 });
    assert.equal((await approve(req)).ok, true);

    const f = await facts(ops, req);
    assert.deepEqual(f.request, { id: req, status: 'approved', kind: 'extension', extension_days: 60 });
    assert.deepEqual([f.term.status, f.term.ends_at, f.term.grace_ends_at], ['active', null, null]);
    assert.deepEqual(f.plan, plans.silver_self_paced);
    assert.strictEqual(f.getting_started_required, false);
    assert.equal(Number(await sqlScalar(`select count(*) from public.subscriptions where user_id = '${legacy.id}'::uuid`)), 1,
      'the no-end-date term was left exactly as it was');
  });

  await t.test('only a reviewer may ask', async () => {
    assert.equal((await facts(sa, vipReq)).request.id, vipReq, 'a Super Admin reviews too');
    await expectAppError(trainer.db.rpc('enrollment_decision_email_facts', { p_request_id: vipReq }), 'FORBIDDEN', 'a Trainer');
    await expectAppError(applicantVip.db.rpc('enrollment_decision_email_facts', { p_request_id: vipReq }),
      'FORBIDDEN', 'the student the request belongs to');
    await expectAppError(student.db.rpc('enrollment_decision_email_facts', { p_request_id: vipReq }), 'FORBIDDEN', 'another student');
    await expectDenied(anonClient().rpc('enrollment_decision_email_facts', { p_request_id: vipReq }), 'a visitor');
    await expectAppError(ops.db.rpc('enrollment_decision_email_facts', { p_request_id: randomUUID() }),
      'REQUEST_NOT_FOUND', 'a request that does not exist');
  });
});
