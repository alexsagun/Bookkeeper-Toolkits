// Pins src/lib/courseVideo.js — the ONE place that decides what a course lesson
// video may be, how it gets uploaded, and when it is safe to say "ready".
//
// Why this suite exists: before #44 a lesson's primary video could be a pasted
// YouTube/Vimeo/MP4 URL, stored verbatim with no scheme check and bound straight
// into <video src>. Paid course material therefore left the paywall as a
// permanent, shareable, un-revokable pointer. The rules that replace it now live
// in one pure module, so a rule loosened here is loosened visibly in one place —
// and this file is what makes that loosening fail loudly.
//
// Three properties are load-bearing and each has its own section below:
//   ★ The upload state machine never lets "Storage accepted bytes" mean "ready".
//     READY_TO_SAVE is only reachable through VERIFYING_PRIVATE_OBJECT.
//   ★ No message this module produces may ever contain a signed URL or a token.
//     These strings are rendered in the admin UI and written to logs.
//   ★ lessonVideoPayload() must preserve a grandfathered legacy link BYTE FOR
//     BYTE. The #44 trigger allows an UPDATE that keeps the same provider and
//     the same video_url; anything else on a legacy row is refused, so an admin
//     editing a legacy lesson's title would be blocked by a payload that
//     "helpfully" normalised the URL.
//
// Assertions target stable reason codes, never the message prose, so the copy
// can be reworded without touching this suite.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LESSON_VIDEO_BUCKET,
  LESSON_VIDEO_MIME,
  LESSON_VIDEO_EXTENSION,
  LESSON_VIDEO_ACCEPT,
  LESSON_VIDEO_MAX_BYTES,
  LESSON_VIDEO_CHUNK_BYTES,
  LESSON_VIDEO_RETRY_DELAYS,
  LESSON_VIDEO_MAX_RESIGN,
  LEGACY_VIDEO_PROVIDERS,
  UPLOAD_STATES,
  UPLOAD_EVENTS,
  UPLOAD_TRANSITIONS,
  sanitizeVideoFileName,
  buildLessonVideoPath,
  isLessonVideoPath,
  lessonVideoPathCourseId,
  validateVideoFile,
  nextUploadState,
  isUploadInFlight,
  hasUnfinishedUpload,
  blocksLessonSave,
  needsCloseConfirmation,
  classifyLessonVideo,
  lessonNeedsUpload,
  coursePublishBlockers,
  lessonVideoPayload,
  shouldResignPlayback,
  describeUploadError,
  UPLOAD_ERROR_MESSAGES,
  UPLOAD_ERROR_RETRYABLE,
  formatBytes,
  formatMediaDuration,
} from '../src/lib/courseVideo.js';

const COURSE = '3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30';
const UPLOAD = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PATH = `lessons/${COURSE}/${UPLOAD}-lesson.mp4`;

// ── The constants are a contract with Supabase and with the SQL ──────────────

test('the chunk size is exactly 6 MiB, which Supabase requires and we may not tune', () => {
  assert.equal(LESSON_VIDEO_CHUNK_BYTES, 6 * 1024 * 1024,
    'Supabase Storage rejects resumable uploads whose chunk size is not exactly 6 MiB — '
    + 'changing this breaks every upload, not just large ones');
});

test('the size cap is 2 GiB and matches what the migration writes to the bucket', () => {
  assert.equal(LESSON_VIDEO_MAX_BYTES, 2147483648,
    'the client cap and course-videos.file_size_limit in db/2026-08-24-course-video-upload-only.sql '
    + 'must be the same number, or the browser promises a size Storage will 413');
});

test('only MP4 is offered, because Storage stores bytes and never transcodes', () => {
  assert.equal(LESSON_VIDEO_MIME, 'video/mp4');
  assert.equal(LESSON_VIDEO_EXTENSION, '.mp4');
  assert.ok(LESSON_VIDEO_ACCEPT.includes('video/mp4'), 'the file picker must filter by MIME');
  assert.ok(LESSON_VIDEO_ACCEPT.includes('.mp4'), 'and by extension, for pickers that ignore MIME');
});

test('lesson videos live in the private bucket, never the public one', () => {
  assert.equal(LESSON_VIDEO_BUCKET, 'course-videos',
    'course-media is public — putting paid lesson video there bypasses RLS on read entirely');
});

test('the retry delays are bounded and start immediately', () => {
  assert.ok(Array.isArray(LESSON_VIDEO_RETRY_DELAYS));
  assert.equal(LESSON_VIDEO_RETRY_DELAYS[0], 0, 'the first retry should be instant');
  assert.ok(LESSON_VIDEO_RETRY_DELAYS.length <= 6, 'an unbounded retry ladder hides a real outage');
  for (let i = 1; i < LESSON_VIDEO_RETRY_DELAYS.length; i++) {
    assert.ok(LESSON_VIDEO_RETRY_DELAYS[i] > LESSON_VIDEO_RETRY_DELAYS[i - 1],
      'retry delays must back off, not oscillate');
  }
});

test('the three legacy providers are named, and upload is not one of them', () => {
  assert.deepEqual([...LEGACY_VIDEO_PROVIDERS].sort(), ['mp4', 'vimeo', 'youtube'],
    'these are exactly the values the #44 trigger refuses on INSERT');
  assert.ok(!LEGACY_VIDEO_PROVIDERS.includes('upload'));
  assert.ok(!LEGACY_VIDEO_PROVIDERS.includes(null),
    'a null provider is an EMPTY lesson, not a link — addLesson() inserts exactly that, '
    + 'so forbidding null would break the Add-lesson button');
});

// ── Filenames and paths ─────────────────────────────────────────────────────

test('a filename is reduced to characters a storage key can hold', () => {
  assert.equal(sanitizeVideoFileName('Module 1 — Intro (final).mp4'), 'Module_1_Intro_final_.mp4');
  assert.equal(sanitizeVideoFileName('bank feed.MP4'), 'bank_feed.mp4');
});

test('a path traversal attempt cannot survive sanitisation', () => {
  for (const raw of ['../../etc/passwd.mp4', '..\\..\\secret.mp4', '/absolute/path.mp4']) {
    const safe = sanitizeVideoFileName(raw);
    assert.ok(!safe.includes('/'), `${raw} must not keep a slash`);
    assert.ok(!safe.includes('\\'), `${raw} must not keep a backslash`);
    assert.ok(!safe.startsWith('.'), `${raw} must not produce a dotfile`);
  }
});

test('every sanitised name ends in exactly one .mp4', () => {
  for (const raw of ['clip', 'clip.mp4', 'clip.mp4.mp4', 'clip.mov', '', '   ', null, undefined]) {
    const safe = sanitizeVideoFileName(raw);
    assert.ok(safe.endsWith('.mp4'), `${JSON.stringify(raw)} → ${safe} must end in .mp4`);
    assert.equal(safe.split('.mp4').length, 2, `${JSON.stringify(raw)} → ${safe} must have ONE .mp4`);
  }
});

test('a pathological filename is length-capped rather than rejected', () => {
  const safe = sanitizeVideoFileName(`${'a'.repeat(500)}.mp4`);
  assert.ok(safe.length <= 100, `expected a capped name, got ${safe.length} chars`);
  assert.ok(safe.endsWith('.mp4'));
});

test('a lesson video path is lessons/<course-uuid>/<upload-uuid>-<name>', () => {
  assert.equal(buildLessonVideoPath(COURSE, UPLOAD, 'lesson.mp4'), PATH);
  assert.ok(isLessonVideoPath(PATH), 'the path this module builds must be one it accepts');
});

test('buildLessonVideoPath refuses anything that is not a uuid', () => {
  for (const bad of ['', null, 'not-a-uuid', '../..', `${COURSE}/x`]) {
    assert.throws(() => buildLessonVideoPath(bad, UPLOAD, 'a.mp4'), /course/i,
      `courseId ${JSON.stringify(bad)} must not reach a storage key`);
    assert.throws(() => buildLessonVideoPath(COURSE, bad, 'a.mp4'), /upload/i,
      `uploadId ${JSON.stringify(bad)} must not reach a storage key`);
  }
});

test('isLessonVideoPath rejects every shape the old path parser accepted', () => {
  // course_object_allowed() read split_part(name,'/',2) and never checked segment 1,
  // so all of these authorised as though they named a course.
  for (const bad of [
    '',
    'lessons/',
    `lessons/${COURSE}`,
    `lessons/${COURSE}/`,
    `lessons/${COURSE}/sub/dir.mp4`,
    `covers/${COURSE}/a.mp4`,
    `anything/${COURSE}/a.mp4`,
    `../lessons/${COURSE}/a.mp4`,
    `lessons/not-a-uuid/a.mp4`,
    null,
    undefined,
  ]) {
    assert.equal(isLessonVideoPath(bad), false, `${JSON.stringify(bad)} must not pass as a lesson path`);
  }
});

test('lessonVideoPathCourseId only answers for a path it fully recognises', () => {
  assert.equal(lessonVideoPathCourseId(PATH), COURSE);
  assert.equal(lessonVideoPathCourseId(`anything/${COURSE}/a.mp4`), null,
    'segment 1 must be literally "lessons" — the old parser never checked it');
  assert.equal(lessonVideoPathCourseId('lessons/'), null);
});

// ── File validation, before a single byte is sent ───────────────────────────

test('a valid MP4 passes', () => {
  const r = validateVideoFile({ name: 'a.mp4', size: 1024, type: 'video/mp4' });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('each rejection carries its own stable reason code', () => {
  const cases = [
    [null, 'missing'],
    [{ name: 'a.mp4', size: 0, type: 'video/mp4' }, 'empty'],
    [{ name: 'a.mov', size: 10, type: 'video/quicktime' }, 'unsupported-type'],
    [{ name: 'a.webm', size: 10, type: 'video/webm' }, 'unsupported-type'],
    [{ name: 'a.mp4', size: LESSON_VIDEO_MAX_BYTES + 1, type: 'video/mp4' }, 'too-large'],
  ];
  for (const [file, reason] of cases) {
    const r = validateVideoFile(file);
    assert.equal(r.ok, false, `${JSON.stringify(file)} must be refused`);
    assert.equal(r.reason, reason, `${JSON.stringify(file)} must report "${reason}"`);
    assert.ok(r.message && r.message.length > 0, `${reason} must tell the admin what to do`);
  }
});

test('a file whose MIME lies but whose extension is wrong is still refused', () => {
  const r = validateVideoFile({ name: 'movie.mov', size: 10, type: 'video/mp4' });
  assert.equal(r.ok, false, 'browsers report file.type inconsistently — the extension is a second gate');
  assert.equal(r.reason, 'unsupported-extension');
});

test('a file with an empty MIME type is judged on its extension alone', () => {
  // Windows sometimes reports '' for .mp4. Refusing it outright would block real work.
  assert.equal(validateVideoFile({ name: 'a.mp4', size: 10, type: '' }).ok, true);
  assert.equal(validateVideoFile({ name: 'a.mov', size: 10, type: '' }).reason, 'unsupported-extension');
});

test('the size boundary is inclusive at exactly the cap', () => {
  assert.equal(validateVideoFile({ name: 'a.mp4', size: LESSON_VIDEO_MAX_BYTES, type: 'video/mp4' }).ok,
    true, 'a file of exactly the cap must be allowed, or the number in the UI is a lie');
  assert.equal(validateVideoFile({ name: 'a.mp4', size: LESSON_VIDEO_MAX_BYTES + 1, type: 'video/mp4' }).reason,
    'too-large');
});

// ── The upload state machine ────────────────────────────────────────────────

test('the transition table covers exactly the states and edges the design names', () => {
  assert.equal(Object.keys(UPLOAD_STATES).length, 15,
    'a dropped state is a dead end in the uploader — count it explicitly');
  const edges = Object.values(UPLOAD_TRANSITIONS)
    .reduce((n, byEvent) => n + Object.keys(byEvent).length, 0);
  assert.equal(edges, 35,
    'a dropped edge strands the admin with no way forward — count it explicitly');
});

test('every state in the table is a declared state, and every event a declared event', () => {
  const states = new Set(Object.values(UPLOAD_STATES));
  const events = new Set(Object.values(UPLOAD_EVENTS));
  for (const [from, byEvent] of Object.entries(UPLOAD_TRANSITIONS)) {
    assert.ok(states.has(from), `${from} is a transition source but not a declared state`);
    for (const [event, to] of Object.entries(byEvent)) {
      assert.ok(events.has(event), `${event} is used from ${from} but is not a declared event`);
      assert.ok(states.has(to), `${from} + ${event} leads to ${to}, which is not a declared state`);
    }
  }
});

test('the happy path reaches SAVED_AND_PLAYABLE and passes through verification', () => {
  const seen = [];
  let s = UPLOAD_STATES.EMPTY;
  for (const e of [
    UPLOAD_EVENTS.SELECT_FILE, UPLOAD_EVENTS.VALIDATE_START, UPLOAD_EVENTS.VALIDATE_OK,
    UPLOAD_EVENTS.UPLOAD_DONE, UPLOAD_EVENTS.VERIFY_OK, UPLOAD_EVENTS.SAVE_START,
    UPLOAD_EVENTS.SAVE_OK,
  ]) {
    s = nextUploadState(s, e);
    assert.ok(s, `the happy path broke at ${e}`);
    seen.push(s);
  }
  assert.equal(s, UPLOAD_STATES.SAVED_AND_PLAYABLE);
  assert.ok(seen.includes(UPLOAD_STATES.VERIFYING_PRIVATE_OBJECT),
    'the happy path MUST pass through verification — "Storage accepted the bytes" is not "ready"');
});

test('READY_TO_SAVE is reachable only out of VERIFYING_PRIVATE_OBJECT', () => {
  const sources = Object.entries(UPLOAD_TRANSITIONS)
    .filter(([, byEvent]) => Object.values(byEvent).includes(UPLOAD_STATES.READY_TO_SAVE))
    .map(([from]) => from);
  assert.deepEqual(sources, [UPLOAD_STATES.VERIFYING_PRIVATE_OBJECT],
    'any other route to READY_TO_SAVE lets a file that cannot be signed or decoded be saved');
});

test('an unknown transition returns null instead of guessing', () => {
  assert.equal(nextUploadState(UPLOAD_STATES.EMPTY, UPLOAD_EVENTS.SAVE_OK), null,
    'a state machine that invents a destination hides the bug that caused the bad event');
  assert.equal(nextUploadState('NOT_A_STATE', UPLOAD_EVENTS.SELECT_FILE), null);
  assert.equal(nextUploadState(UPLOAD_STATES.EMPTY, 'NOT_AN_EVENT'), null);
});

test('an interrupted upload can be resumed or retried, and a paused one resumed', () => {
  assert.equal(nextUploadState(UPLOAD_STATES.UPLOADING, UPLOAD_EVENTS.INTERRUPT),
    UPLOAD_STATES.INTERRUPTED);
  assert.equal(nextUploadState(UPLOAD_STATES.INTERRUPTED, UPLOAD_EVENTS.RESUME),
    UPLOAD_STATES.UPLOADING);
  assert.equal(nextUploadState(UPLOAD_STATES.INTERRUPTED, UPLOAD_EVENTS.RETRY),
    UPLOAD_STATES.UPLOADING);
  assert.equal(nextUploadState(UPLOAD_STATES.UPLOADING, UPLOAD_EVENTS.PAUSE), UPLOAD_STATES.PAUSED);
  assert.equal(nextUploadState(UPLOAD_STATES.PAUSED, UPLOAD_EVENTS.RESUME), UPLOAD_STATES.UPLOADING);
});

test('a failed database save keeps the uploaded file so the admin can retry', () => {
  assert.equal(nextUploadState(UPLOAD_STATES.SAVING_LESSON, UPLOAD_EVENTS.SAVE_FAIL),
    UPLOAD_STATES.DATABASE_ERROR);
  assert.equal(nextUploadState(UPLOAD_STATES.DATABASE_ERROR, UPLOAD_EVENTS.SAVE_START),
    UPLOAD_STATES.SAVING_LESSON,
    'retrying the save must not require re-uploading gigabytes');
});

test('a playback failure can be recovered exactly once, by re-signing', () => {
  assert.equal(nextUploadState(UPLOAD_STATES.SAVED_AND_PLAYABLE, UPLOAD_EVENTS.PLAYBACK_FAIL),
    UPLOAD_STATES.PLAYBACK_ERROR);
  assert.equal(nextUploadState(UPLOAD_STATES.PLAYBACK_ERROR, UPLOAD_EVENTS.RESIGN_OK),
    UPLOAD_STATES.SAVED_AND_PLAYABLE);
  assert.equal(LESSON_VIDEO_MAX_RESIGN, 1, 'more than one re-sign is a loop, not a recovery');
});

test('Save is blocked while anything about the video is unfinished', () => {
  for (const s of [
    UPLOAD_STATES.FILE_SELECTED, UPLOAD_STATES.LOCAL_VALIDATING, UPLOAD_STATES.UPLOADING,
    UPLOAD_STATES.PAUSED, UPLOAD_STATES.INTERRUPTED, UPLOAD_STATES.VERIFYING_PRIVATE_OBJECT,
    UPLOAD_STATES.STORAGE_OR_SIGNING_ERROR, UPLOAD_STATES.SAVING_LESSON,
  ]) {
    assert.equal(blocksLessonSave(s), true, `${s} must not allow Save — the row would point at nothing`);
  }
  for (const s of [
    UPLOAD_STATES.EMPTY, UPLOAD_STATES.READY_TO_SAVE, UPLOAD_STATES.SAVED_AND_PLAYABLE,
    UPLOAD_STATES.CANCELLED, UPLOAD_STATES.UNSUPPORTED_FILE, UPLOAD_STATES.DATABASE_ERROR,
    UPLOAD_STATES.PLAYBACK_ERROR,
  ]) {
    assert.equal(blocksLessonSave(s), false, `${s} must allow Save — nothing is in flight`);
  }
});

test('only genuine in-flight work counts as in flight', () => {
  assert.equal(isUploadInFlight(UPLOAD_STATES.UPLOADING), true);
  assert.equal(isUploadInFlight(UPLOAD_STATES.VERIFYING_PRIVATE_OBJECT), true);
  assert.equal(isUploadInFlight(UPLOAD_STATES.PAUSED), false,
    'a paused upload is idle — holding the drawer open for it would trap the admin');
  assert.equal(hasUnfinishedUpload(UPLOAD_STATES.PAUSED), true,
    'but it is still unfinished, so Save stays disabled');
});

test('closing mid-upload asks first, and closing when idle does not', () => {
  for (const s of [UPLOAD_STATES.UPLOADING, UPLOAD_STATES.PAUSED, UPLOAD_STATES.INTERRUPTED]) {
    assert.equal(needsCloseConfirmation(s), true, `${s} must warn before discarding transferred bytes`);
  }
  for (const s of [UPLOAD_STATES.EMPTY, UPLOAD_STATES.READY_TO_SAVE, UPLOAD_STATES.SAVED_AND_PLAYABLE]) {
    assert.equal(needsCloseConfirmation(s), false, `${s} has nothing to lose — do not nag`);
  }
});

// ── Classifying what a stored lesson actually has ───────────────────────────

test('a lesson is classified by what it holds, not by what it claims', () => {
  const cases = [
    [{ type: 'text', text_content: 'notes' }, 'text'],
    [{ type: 'video', video_provider: 'upload', storage_path: PATH }, 'upload'],
    [{ type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/x' }, 'legacy-link'],
    [{ type: 'video', video_provider: 'vimeo', video_url: 'https://vimeo.com/1' }, 'legacy-link'],
    [{ type: 'video', video_provider: 'mp4', video_url: 'https://x/a.mp4' }, 'legacy-link'],
    [{ type: 'video', video_provider: null, storage_path: null }, 'empty'],
    [{ type: 'video', video_provider: 'upload', storage_path: null }, 'invalid'],
    [{ type: 'video', video_provider: 'youtube', video_url: null }, 'invalid'],
    [{ type: 'video', video_provider: 'upload', storage_path: 'covers/x/y.mp4' }, 'invalid'],
  ];
  for (const [lesson, want] of cases) {
    assert.equal(classifyLessonVideo(lesson), want,
      `${JSON.stringify(lesson)} should classify as ${want}`);
  }
});

test('a zoom replay link never makes a lesson look like it has a video', () => {
  const l = { type: 'video', video_provider: null, storage_path: null,
    zoom_replay_url: 'https://acme.zoom.us/rec/share/abc' };
  assert.equal(classifyLessonVideo(l), 'empty',
    'the replay renders BELOW the player slot — a replay-only lesson still shows students nothing');
  assert.equal(lessonNeedsUpload(l), true);
});

test('only a real upload satisfies the video requirement', () => {
  assert.equal(lessonNeedsUpload({ type: 'video', video_provider: 'upload', storage_path: PATH }), false);
  assert.equal(lessonNeedsUpload({ type: 'text', text_content: 'notes' }), false);
  assert.equal(lessonNeedsUpload({ type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/x' }), true);
});

// ── Publish readiness — the client mirror of course_publish_blockers() ──────

test('a fully uploaded course has nothing blocking publication', () => {
  const blockers = coursePublishBlockers([
    { id: '1', title: 'A', type: 'video', video_provider: 'upload', storage_path: PATH },
    { id: '2', title: 'B', type: 'text', text_content: 'notes' },
  ]);
  assert.deepEqual(blockers, []);
});

test('an empty course publishes — there is nothing broken to show a student', () => {
  assert.deepEqual(coursePublishBlockers([]), []);
  assert.deepEqual(coursePublishBlockers(null), []);
});

test('only a link-backed lesson or a fileless upload blocks publication', () => {
  const blockers = coursePublishBlockers([
    { id: 'a', title: 'Legacy', type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/x' },
    { id: 'd', title: 'Broken', type: 'video', video_provider: 'upload', storage_path: null },
    { id: 'e', title: 'Fine', type: 'video', video_provider: 'upload', storage_path: PATH },
  ]);
  assert.deepEqual(blockers.map(b => b.id), ['a', 'd']);
  // The reason strings are the ones course_publish_blockers() returns in SQL, so the
  // two halves of the mirror can be diffed by eye.
  assert.deepEqual(blockers.map(b => b.reason), ['external_link', 'upload_missing_file']);
  for (const b of blockers) {
    assert.ok(b.title, 'a blocker must name its lesson, or the admin cannot find it');
    assert.ok(b.message, 'a blocker must say how to fix it');
  }
});

test('a just-added empty lesson does NOT block publication', () => {
  // addLesson() inserts `type:'video'` with no provider, no url and no path the moment
  // an admin clicks "Add lesson". Blocking that shape would refuse to publish any course
  // with one lesson in progress — and courses_publish_guard does not block it either, so
  // the client would be refusing what the server accepts, with no server error to explain.
  assert.deepEqual(
    coursePublishBlockers([{ id: 'b', title: 'Empty', type: 'video', video_provider: null, storage_path: null }]),
    []);
});

test('a notes-only video lesson does NOT block publication', () => {
  // saveLesson has always permitted a video-typed lesson whose only content is
  // text_content. Blocking it would strand every course containing one.
  assert.deepEqual(
    coursePublishBlockers([{ id: 'c', title: 'Notes only', type: 'video', video_provider: null, text_content: 'just notes' }]),
    []);
});

test('a publish blocker never leaks the lesson content it is complaining about', () => {
  const secret = 'PAID-CONTENT-DO-NOT-LEAK';
  const blockers = coursePublishBlockers([
    { id: 'a', title: 'Lesson one', type: 'video', video_provider: null, text_content: secret },
  ]);
  const rendered = JSON.stringify(blockers);
  assert.ok(!rendered.includes(secret),
    'blocker messages surface in error copy — they may name a lesson, never quote it');
});

// ── The save payload, and the grandfathering rule the #44 trigger enforces ──

test('an upload writes the path and clears the link', () => {
  const p = lessonVideoPayload(
    { type: 'video', video_provider: 'upload', storage_path: PATH },
    { type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/x' },
  );
  assert.deepEqual(p, { video_url: null, video_provider: 'upload', storage_path: PATH });
});

test('a legacy link is preserved BYTE FOR BYTE while it is still the lesson content', () => {
  // The #44 trigger permits an UPDATE on a link-backed row only when video_provider AND
  // video_url are unchanged. Normalising, trimming or re-deriving the URL here would make
  // "rename a legacy lesson" fail with a permission error the admin cannot act on.
  const prev = { type: 'video', video_provider: 'youtube', video_url: '  https://youtu.be/AAAAAAAAAAA?t=90  ' };
  const p = lessonVideoPayload({ type: 'video', video_provider: 'youtube', video_url: prev.video_url }, prev);
  assert.equal(p.video_url, prev.video_url, 'not trimmed, not normalised, not re-parsed');
  assert.equal(p.video_provider, 'youtube');
  assert.equal(p.storage_path, null);
});

test('a title-only edit never drops an existing storage_path', () => {
  // ★ THE DATA-LOSS GUARD. saveLesson cleans up with
  //   `if (oldPath && oldPath !== payload.storage_path) removeMediaIfUnreferenced([oldPath])`,
  //   so any payload that resolves an existing path to null DELETES the video file.
  //   Filtering the draft path through isLessonVideoPath() first did exactly that to any
  //   row whose path does not match the current shape — an old upload, a hand-repaired
  //   row — the moment someone renamed the lesson.
  for (const stored of [PATH, 'lessons/legacy/odd path.mp4', 'course-videos/old/style.mp4']) {
    const prev = { type: 'video', video_provider: 'upload', storage_path: stored };
    const p = lessonVideoPayload({ ...prev, title: 'renamed' }, prev);
    assert.equal(p.storage_path, stored, `renaming must preserve ${stored} exactly`);
    assert.equal(p.video_provider, 'upload');
  }
});

test('removing the video is still possible, and is the only way the path goes null', () => {
  const prev = { type: 'video', video_provider: 'upload', storage_path: PATH };
  const p = lessonVideoPayload({ type: 'video', video_provider: null, storage_path: null }, prev);
  assert.deepEqual(p, { video_url: null, video_provider: null, storage_path: null });
});

test('a text lesson clears every video column', () => {
  const p = lessonVideoPayload(
    { type: 'text', text_content: 'notes' },
    { type: 'video', video_provider: 'upload', storage_path: PATH },
  );
  assert.deepEqual(p, { video_url: null, video_provider: null, storage_path: null });
});

test('an empty video lesson writes nulls, never a leftover provider', () => {
  const p = lessonVideoPayload({ type: 'video' }, null);
  assert.deepEqual(p, { video_url: null, video_provider: null, storage_path: null },
    'a dangling provider with no content is exactly the "invalid" row the inventory hunts for');
});

test('the payload can never construct a new link-backed lesson', () => {
  // Whatever the caller passes, a link may only ever be CARRIED OVER from prev.
  const p = lessonVideoPayload(
    { type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/BBBBBBBBBBB' },
    null,
  );
  assert.equal(p.video_provider, null, 'no prior link means no link — the trigger would refuse it anyway');
  assert.equal(p.video_url, null);
});

test('a link that differs from the stored one is dropped, not written', () => {
  const prev = { type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/AAAAAAAAAAA' };
  const p = lessonVideoPayload(
    { type: 'video', video_provider: 'youtube', video_url: 'https://youtu.be/CCCCCCCCCCC' },
    prev,
  );
  assert.equal(p.video_provider, null,
    're-pointing a legacy link is a new link — refused, so the payload must not attempt it');
});

// ── Playback recovery ───────────────────────────────────────────────────────

const MEDIA_ERR = { ABORTED: 1, NETWORK: 2, DECODE: 3, SRC_NOT_SUPPORTED: 4 };

test('an unplayable source is worth one re-sign, because that is what an expired URL looks like', () => {
  const r = shouldResignPlayback({ code: MEDIA_ERR.SRC_NOT_SUPPORTED, attempt: 0 });
  assert.equal(r.resign, true);
  assert.equal(r.reason, 'source-unavailable');
});

test('a decode failure is never retried — re-signing cannot fix a codec', () => {
  const r = shouldResignPlayback({ code: MEDIA_ERR.DECODE, attempt: 0 });
  assert.equal(r.resign, false);
  assert.equal(r.reason, 'decode',
    'this is the state that must tell an admin the file itself is wrong, not the permissions');
});

test('a deliberate abort is not an error to recover from', () => {
  assert.deepEqual(shouldResignPlayback({ code: MEDIA_ERR.ABORTED, attempt: 0 }),
    { resign: false, reason: 'aborted' });
});

test('a network error is retried once', () => {
  assert.equal(shouldResignPlayback({ code: MEDIA_ERR.NETWORK, attempt: 0 }).resign, true);
});

test('the second failure never re-signs, so there is no retry loop', () => {
  for (const code of Object.values(MEDIA_ERR)) {
    const r = shouldResignPlayback({ code, attempt: LESSON_VIDEO_MAX_RESIGN });
    assert.equal(r.resign, false, `code ${code} must stop after ${LESSON_VIDEO_MAX_RESIGN} re-sign`);
    if (code !== MEDIA_ERR.DECODE && code !== MEDIA_ERR.ABORTED) {
      assert.equal(r.reason, 'already-retried');
    }
  }
});

test('an expiring URL is re-signed before it is used, without waiting for a failure', () => {
  const now = 1_000_000;
  assert.equal(shouldResignPlayback({ signedAt: now - 3_500_000, ttlMs: 3_600_000, now }).resign, true,
    'inside the refresh margin the URL must be replaced pre-emptively');
  assert.equal(shouldResignPlayback({ signedAt: now - 10_000, ttlMs: 3_600_000, now }).resign, false,
    'a fresh URL must not be re-minted on every render');
});

// ── Error copy: actionable, and never a token ──────────────────────────────

// ★ THE TEST THAT USED TO LIVE HERE ASSERTED THE BUG.
//   It pinned reason === 'too-large' and a /\b2 GB\b/ message for any 413, which is
//   exactly what told an admin their 117 MB file exceeded 2 GB while the real fault was
//   a project-wide Storage limit left at its 50 MiB default. A test can hold a defect in
//   place as firmly as code does.

test('a 413 mid-transfer is a Storage misconfiguration, never the admin’s file', () => {
  const r = describeUploadError({ originalResponse: { getStatus: () => 413 } });
  assert.equal(r.reason, 'storage-limit');
  assert.equal(r.retryable, false,
    'resuming re-sends the identical request and takes the identical 413');
  assert.notEqual(r.reason, 'too-large',
    'the pre-flight owns that reason; a transfer-time 413 must never borrow it');
});

test('the local cap is checked before a byte moves, which is why a 413 cannot mean “your file is too big”', () => {
  // This test IS the argument. validateVideoFile refuses an oversize file up front, so
  // by the time any byte reaches Storage the size has already been agreed. A 413 after
  // that point can only mean the server’s ceiling is lower than the one we enforce.
  const tooBig = validateVideoFile({
    name: 'lesson.mp4', size: LESSON_VIDEO_MAX_BYTES + 1, type: 'video/mp4',
  });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, 'too-large');
  assert.match(tooBig.message, /\b2 GB\b/,
    'the pre-flight DOES know the real size, so it may quote the cap');

  const fromServer = describeUploadError({ originalResponse: { getStatus: () => 413 } });
  assert.notEqual(fromServer.reason, tooBig.reason,
    'the two paths must not collapse into one reason code again');
});

test('the 413 copy blames the project-wide setting and invents no ceiling of its own', () => {
  // The suite otherwise asserts reason codes rather than prose. This exception exists
  // because Supabase’s 413 body (EntityTooLarge) carries NO number, so any figure here
  // beyond our own cap would be fabricated — which is the original bug.
  //
  // ★ Honest about what it is: a FORWARD ratchet on the new prose, not a regression
  //   detector. The old message also matched /project-wide/i and contained "2 GB", so
  //   this would have passed against it. The reason-code and retryable assertions above
  //   are what actually catch a regression.
  const m = describeUploadError({ originalResponse: { getStatus: () => 413 } }).message;
  assert.match(m, /project-wide/i, 'the admin must be told which setting is actually wrong');
  assert.ok(m.includes(formatBytes(LESSON_VIDEO_MAX_BYTES)),
    'quoting our own cap is fine — we enforce it');
  assert.ok(!/\b50\s?MB\b/i.test(m),
    'the client cannot know the project limit, so it must not print one');
});

test('a permanent failure never offers a Resume that cannot work', () => {
  for (const status of [413, 403, 404]) {
    const r = describeUploadError({ originalResponse: { getStatus: () => status } });
    assert.equal(r.retryable, false, `${status} is permanent until a human changes something`);
  }
});

test('a transient failure still offers a way forward', () => {
  assert.equal(describeUploadError({ originalResponse: { getStatus: () => 401 } }).retryable, true,
    'signing in again on another tab makes Resume genuinely work');
  assert.equal(describeUploadError({ originalRequest: {}, originalResponse: null }).retryable, true);
});

test('an unclassified failure is treated as retryable, because refusing Resume would strand a live transfer', () => {
  assert.equal(describeUploadError(new Error('kaboom')).retryable, true);
});

test('every upload reason has both a message and a retryability, so a new code cannot ship half-defined', () => {
  assert.deepEqual(
    Object.keys(UPLOAD_ERROR_RETRYABLE).sort(),
    Object.keys(UPLOAD_ERROR_MESSAGES).sort(),
    'a reason with copy but no retryability silently falls back to “retryable”',
  );
  for (const [reason, msg] of Object.entries(UPLOAD_ERROR_MESSAGES)) {
    assert.ok(typeof msg === 'string' && msg.trim().length > 0, `${reason} has no copy`);
  }
});

test('a dropped connection is reported as a dropped connection, not as an unknown failure', () => {
  // tus wraps transport failures in DetailedError, which extends Error WITHOUT setting
  // `name`, so the old `name === 'TypeError'` branch could never fire and every drop was
  // reported as “could not be completed”. upload.js calls _emitHttpError(req, null, …) on
  // a transport failure, so “a request went out and nothing came back” is the real shape.
  const r = describeUploadError({ name: 'Error', originalRequest: {}, originalResponse: null });
  assert.equal(r.reason, 'offline');
  assert.equal(r.retryable, true);
});

test('a real 413 carries BOTH a request and a response, and the status still wins', () => {
  // Every other fixture supplies one signal or the other. A genuine tus HTTP error calls
  // _emitHttpError(req, res, …), so both are present — and `offline` must not steal it.
  const r = describeUploadError({
    originalRequest: {}, originalResponse: { getStatus: () => 413 },
  });
  assert.equal(r.reason, 'storage-limit');
  assert.equal(r.retryable, false);
});

test('a user cancel outranks every status, so Cancel never reads as a failure', () => {
  // `aborted` is checked before any status branch. If that ordering ever inverted, a
  // cancel racing a response would render an error banner for a deliberate action.
  assert.equal(describeUploadError({
    name: 'AbortError', originalResponse: { getStatus: () => 413 },
  }).reason, 'aborted');
  assert.equal(describeUploadError({ aborted: true, status: 403 }).reason, 'aborted');
});

test('a status of 0 does not blind the classifier to a status the error does carry', () => {
  // `fromTus ?? err.status` treated 0 as an answer (0 is not nullish) and the `> 0` guard
  // then discarded it, making every fallback behind it unreachable.
  const r = describeUploadError({ originalResponse: { getStatus: () => 0 }, status: 403 });
  assert.equal(r.reason, 'forbidden');
});

test('an authorization failure is distinguishable from a size failure', () => {
  assert.equal(describeUploadError({ originalResponse: { getStatus: () => 401 } }).reason, 'unauthorized');
  assert.equal(describeUploadError({ originalResponse: { getStatus: () => 403 } }).reason, 'forbidden');
});

test('a cancelled upload is reported as cancelled, not as a failure', () => {
  assert.equal(describeUploadError({ name: 'AbortError' }).reason, 'aborted');
});

test('an unrecognised failure still produces an actionable message', () => {
  const r = describeUploadError(new Error('kaboom'));
  assert.equal(r.reason, 'unknown');
  assert.ok(r.message.length > 0);
  assert.ok(!/^\s*$/.test(r.message));
});

test('no message this module produces can ever contain a signed URL or a token', () => {
  // These strings are rendered in the admin UI and written to console logs. A signed
  // URL in either is a copy-pasteable grant of the paid file for the rest of its TTL.
  const signed = 'https://ref.storage.supabase.co/storage/v1/object/sign/course-videos/'
    + `${PATH}?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRET.SIGNATURE`;
  const probes = [
    describeUploadError(new Error(`upload failed for ${signed}`)),
    describeUploadError({ message: signed, originalResponse: { getStatus: () => 500 } }),
    describeUploadError({ originalRequest: { getURL: () => signed } }),
    describeUploadError({ message: signed, originalResponse: { getStatus: () => 413 } }),
  ];
  for (const p of probes) {
    assert.ok(!p.message.includes('token='), `leaked a token query param: ${p.message}`);
    assert.ok(!p.message.includes('SIGNATURE'), `leaked a signature: ${p.message}`);
    assert.ok(!p.message.includes('eyJ'), `leaked a JWT: ${p.message}`);
    assert.ok(!/https?:\/\//.test(p.message), `leaked a URL: ${p.message}`);
  }
});

test('validation messages are equally free of anything secret', () => {
  const r = validateVideoFile({ name: 'https://x/?token=eyJabc.mp4', size: 1, type: 'video/mp4' });
  assert.ok(!r.message.includes('token='), 'a filename can carry a token too');
});

// ── Formatting ──────────────────────────────────────────────────────────────

test('sizes are formatted the way an admin reads them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(742 * 1024 * 1024), '742 MB');
  assert.equal(formatBytes(LESSON_VIDEO_MAX_BYTES), '2 GB');
});

test('durations use h:mm:ss only when there are hours', () => {
  assert.equal(formatMediaDuration(0), '0:00');
  assert.equal(formatMediaDuration(59), '0:59');
  assert.equal(formatMediaDuration(2538), '42:18');
  assert.equal(formatMediaDuration(3661), '1:01:01');
});

test('a duration the browser could not determine formats as nothing, not as NaN', () => {
  for (const bad of [NaN, Infinity, -1, null, undefined, 'x']) {
    assert.equal(formatMediaDuration(bad), '', `${JSON.stringify(bad)} must not render as a time`);
  }
});

// ── It never touches the network ────────────────────────────────────────────

test('a stubbed global fetch is never called — every rule here is offline and synchronous', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; return Promise.reject(new Error('no')); };
  try {
    validateVideoFile({ name: 'a.mp4', size: 10, type: 'video/mp4' });
    buildLessonVideoPath(COURSE, UPLOAD, 'a.mp4');
    isLessonVideoPath(PATH);
    classifyLessonVideo({ type: 'video', video_provider: 'upload', storage_path: PATH });
    coursePublishBlockers([{ id: '1', title: 'A', type: 'video' }]);
    lessonVideoPayload({ type: 'video' }, null);
    shouldResignPlayback({ code: 4, attempt: 0 });
    describeUploadError(new Error('x'));
    nextUploadState(UPLOAD_STATES.EMPTY, UPLOAD_EVENTS.SELECT_FILE);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0, 'this module must stay pure so the same rules run in the browser and in node --test');
});
