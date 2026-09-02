// courseVideo.js — PURE, dependency-free rules for course lesson video (#44).
//
// The client half of the upload-only lesson contract. Its SQL half is
// db/2026-08-24-course-video-upload-only.sql: course_lessons_video_guard(),
// courses_publish_guard(), course_publish_blockers() and
// course_video_object_readable(). Where a rule exists on both sides it is
// written once here and mirrored there — keep them in lockstep.
//
// WHY THIS MODULE EXISTS
//   Before #44 a lesson's primary content could be a pasted YouTube/Vimeo/MP4
//   URL. parseVideoUrl() classified ANY unrecognised string as 'mp4' and
//   saveLesson() stored it verbatim into video_url, which renderVideo() bound
//   straight into <video src>. There was no scheme check anywhere on that path,
//   and — the real cost — a YouTube id in a lesson row is a permanent, public,
//   un-revokable pointer to material the member paid for. Uploads now go to the
//   PRIVATE course-videos bucket and are served only through short-lived signed
//   URLs gated by RLS.
//
// THREE INVARIANTS THIS FILE OWES THE REST OF THE APP
//   ★ "Storage accepted the bytes" is NOT "ready". READY_TO_SAVE is reachable
//     only out of VERIFYING_PRIVATE_OBJECT, which is where the app proves the
//     object can be signed AND decoded from that signed URL.
//   ★ No string returned from here may contain a signed URL, token or
//     signature. These are rendered in admin UI and written to console logs; a
//     leaked signed URL is a copy-pasteable grant of the paid file until it
//     expires. Messages are built from the reason code alone, never from the
//     underlying error text.
//   ★ lessonVideoPayload() carries a grandfathered legacy link BYTE FOR BYTE.
//     The #44 trigger permits an UPDATE on a link-backed row only while
//     video_provider AND video_url are unchanged, so normalising the URL here
//     would make "rename a legacy lesson" fail with a permission error.
//
// A NULL video_provider IS NOT A LINK. addLesson() inserts a bare
// type:'video' row with a null provider and no path; that is the EMPTY state
// and it must stay legal, or the Add-lesson button breaks outright.

// ── Constants: a contract with Supabase Storage and with the migration ──────

/** Paid lesson video lives here, and only here. course-media is public. */
// Declared here, not beside formatBytes(), because STORAGE_LIMIT_MESSAGE formats the
// cap at MODULE-EVAL time. formatBytes is hoisted, but a const it reads is not — so
// leaving this below would put BYTE_UNITS in the temporal dead zone and throw on import.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export const LESSON_VIDEO_BUCKET = 'course-videos';

/**
 * MP4 / H.264 + AAC is the authoring standard. Supabase Storage stores bytes
 * and never transcodes, so whatever is uploaded must decode as-is in the
 * student's browser — and MP4/H.264 is the only combination that does so
 * everywhere, including older iOS Safari.
 */
export const LESSON_VIDEO_MIME = 'video/mp4';
export const LESSON_VIDEO_EXTENSION = '.mp4';
export const LESSON_VIDEO_ACCEPT = 'video/mp4,.mp4';

/**
 * 2 GiB. Must equal course-videos.file_size_limit in the migration, and the
 * project-wide Storage limit must be at least this or uploads 413 mid-transfer.
 */
export const LESSON_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Supabase's resumable endpoint requires EXACTLY 6 MiB chunks. This is not a
 * tuning knob: any other value fails every upload, not merely large ones.
 */
export const LESSON_VIDEO_CHUNK_BYTES = 6 * 1024 * 1024;

/** Bounded, backing off. An unbounded ladder hides a real outage. */
export const LESSON_VIDEO_RETRY_DELAYS = Object.freeze([0, 3000, 5000, 10000, 20000]);

/** One re-sign per playback failure. More than one is a loop, not a recovery. */
export const LESSON_VIDEO_MAX_RESIGN = 1;

/** Re-mint a signed URL this long before it expires rather than after it fails. */
export const LESSON_VIDEO_RESIGN_MARGIN_MS = 5 * 60 * 1000;

/** How long a lesson-video signed URL lasts. */
export const LESSON_VIDEO_SIGN_TTL_SECONDS = 3600;

/** Exactly the values course_lessons_video_guard() refuses on INSERT. */
export const LEGACY_VIDEO_PROVIDERS = Object.freeze(['youtube', 'vimeo', 'mp4']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** lessons/<course-uuid>/<file>. Segment 1 is checked — the old parser never did. */
export const LESSON_VIDEO_PATH_RE =
  /^lessons\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/i;

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const MEDIA_EXTENSIONS = /\.(mp4|m4v|mov|qt|webm|mkv|avi|ogg|ogv|wmv|flv|mpg|mpeg|3gp)$/i;
const MAX_BASE_NAME = 80;

// ── Filenames and storage keys ─────────────────────────────────────────────

/**
 * Reduce an arbitrary filename to something a storage key can hold, always
 * ending in exactly one `.mp4`. Directory components, traversal sequences and
 * leading dots are removed rather than escaped.
 */
export function sanitizeVideoFileName(name) {
  let base = String(name == null ? '' : name).trim();
  base = base.split(/[\\/]/).pop() || '';                 // drop any directory component
  let prev;
  do { prev = base; base = base.replace(MEDIA_EXTENSIONS, ''); } while (base !== prev);
  base = base.replace(/\.mp4/gi, '_mp4');                 // keep the final .mp4 unique
  base = base.replace(/[^\w.\-]+/g, '_');
  base = base.replace(/^[.\s_]+/, '');                    // never a dotfile
  base = base.slice(0, MAX_BASE_NAME).replace(/[.\s_]+$/, m => (m.includes('_') ? '_' : ''));
  if (!base) base = 'lesson';
  return `${base}${LESSON_VIDEO_EXTENSION}`;
}

/** `lessons/<courseId>/<uploadId>-<safe name>`. Both ids must be real uuids. */
export function buildLessonVideoPath(courseId, uploadId, fileName) {
  if (!UUID_RE.test(String(courseId || ''))) {
    throw new Error('A lesson video path needs a valid course id.');
  }
  if (!UUID_RE.test(String(uploadId || ''))) {
    throw new Error('A lesson video path needs a valid upload id.');
  }
  return `lessons/${courseId}/${uploadId}-${sanitizeVideoFileName(fileName)}`;
}

/** True only for a fully-formed lesson video key. Everything else fails closed. */
export function isLessonVideoPath(path) {
  return typeof path === 'string' && LESSON_VIDEO_PATH_RE.test(path);
}

/** The course id a lesson video key names, or null if the key is not one. */
export function lessonVideoPathCourseId(path) {
  if (!isLessonVideoPath(path)) return null;
  return path.split('/')[1];
}

// ── Local validation, before a single byte is sent ─────────────────────────

const VALIDATION_MESSAGES = Object.freeze({
  missing: 'Choose a video file to upload.',
  empty: 'That file is empty. Re-export it and try again.',
  'unsupported-type': 'Lesson videos must be MP4 (H.264 video, AAC audio). '
    + 'Convert the file with HandBrake or CloudConvert, then upload the MP4.',
  'unsupported-extension': 'Lesson videos must be an .mp4 file. '
    + 'Convert it with HandBrake or CloudConvert, then upload the MP4.',
  'too-large': '',      // built below — it needs the cap
});

function validationMessage(reason, extra) {
  if (reason === 'too-large') {
    return `That video is ${extra} — the limit is ${formatBytes(LESSON_VIDEO_MAX_BYTES)}. `
      + 'Re-export it at a lower bitrate, or split the lesson in two.';
  }
  return VALIDATION_MESSAGES[reason] || 'That file cannot be used as a lesson video.';
}

/**
 * Duck-typed on `{ name, size, type }` so the same rules run against a browser
 * File and against a plain object under `node --test`.
 * Returns `{ ok, reason, message }`; `reason` is a stable code, never prose.
 */
export function validateVideoFile(file) {
  if (!file || typeof file !== 'object') {
    return { ok: false, reason: 'missing', message: validationMessage('missing') };
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'empty', message: validationMessage('empty') };
  }
  // Browsers report file.type inconsistently (Windows often sends '' for .mp4),
  // so an empty type is judged on the extension alone rather than refused.
  const type = String(file.type || '').toLowerCase().split(';')[0].trim();
  if (type && type !== LESSON_VIDEO_MIME) {
    return { ok: false, reason: 'unsupported-type', message: validationMessage('unsupported-type') };
  }
  if (!/\.mp4$/i.test(String(file.name || ''))) {
    return { ok: false, reason: 'unsupported-extension', message: validationMessage('unsupported-extension') };
  }
  if (size > LESSON_VIDEO_MAX_BYTES) {
    return { ok: false, reason: 'too-large', message: validationMessage('too-large', formatBytes(size)) };
  }
  return { ok: true, reason: null, message: '' };
}

// ── The upload state machine ───────────────────────────────────────────────

export const UPLOAD_STATES = Object.freeze({
  EMPTY: 'EMPTY',
  FILE_SELECTED: 'FILE_SELECTED',
  LOCAL_VALIDATING: 'LOCAL_VALIDATING',
  UNSUPPORTED_FILE: 'UNSUPPORTED_FILE',
  UPLOADING: 'UPLOADING',
  PAUSED: 'PAUSED',
  INTERRUPTED: 'INTERRUPTED',
  CANCELLED: 'CANCELLED',
  VERIFYING_PRIVATE_OBJECT: 'VERIFYING_PRIVATE_OBJECT',
  STORAGE_OR_SIGNING_ERROR: 'STORAGE_OR_SIGNING_ERROR',
  READY_TO_SAVE: 'READY_TO_SAVE',
  SAVING_LESSON: 'SAVING_LESSON',
  DATABASE_ERROR: 'DATABASE_ERROR',
  SAVED_AND_PLAYABLE: 'SAVED_AND_PLAYABLE',
  PLAYBACK_ERROR: 'PLAYBACK_ERROR',
});

export const UPLOAD_EVENTS = Object.freeze({
  SELECT_FILE: 'SELECT_FILE',
  VALIDATE_START: 'VALIDATE_START',
  VALIDATE_OK: 'VALIDATE_OK',
  VALIDATE_FAIL: 'VALIDATE_FAIL',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  INTERRUPT: 'INTERRUPT',
  RETRY: 'RETRY',
  CANCEL: 'CANCEL',
  UPLOAD_DONE: 'UPLOAD_DONE',
  VERIFY_OK: 'VERIFY_OK',
  VERIFY_FAIL: 'VERIFY_FAIL',
  SAVE_START: 'SAVE_START',
  SAVE_OK: 'SAVE_OK',
  SAVE_FAIL: 'SAVE_FAIL',
  PLAYBACK_FAIL: 'PLAYBACK_FAIL',
  RESIGN_OK: 'RESIGN_OK',
  REPLACE: 'REPLACE',
  RESET: 'RESET',
});

const S = UPLOAD_STATES;
const E = UPLOAD_EVENTS;

/**
 * ★ READY_TO_SAVE has exactly ONE inbound edge, from VERIFYING_PRIVATE_OBJECT.
 *   Any second route would let a file that Storage accepted but that cannot be
 *   signed or decoded be saved as a lesson's content.
 */
export const UPLOAD_TRANSITIONS = Object.freeze({
  [S.EMPTY]: Object.freeze({ [E.SELECT_FILE]: S.FILE_SELECTED }),
  [S.FILE_SELECTED]: Object.freeze({ [E.VALIDATE_START]: S.LOCAL_VALIDATING }),
  [S.LOCAL_VALIDATING]: Object.freeze({
    [E.VALIDATE_OK]: S.UPLOADING,
    [E.VALIDATE_FAIL]: S.UNSUPPORTED_FILE,
  }),
  [S.UNSUPPORTED_FILE]: Object.freeze({ [E.SELECT_FILE]: S.FILE_SELECTED, [E.RESET]: S.EMPTY }),
  [S.UPLOADING]: Object.freeze({
    [E.PAUSE]: S.PAUSED,
    [E.INTERRUPT]: S.INTERRUPTED,
    [E.CANCEL]: S.CANCELLED,
    [E.UPLOAD_DONE]: S.VERIFYING_PRIVATE_OBJECT,
  }),
  [S.PAUSED]: Object.freeze({ [E.RESUME]: S.UPLOADING, [E.CANCEL]: S.CANCELLED }),
  [S.INTERRUPTED]: Object.freeze({
    [E.RESUME]: S.UPLOADING,
    [E.RETRY]: S.UPLOADING,
    [E.CANCEL]: S.CANCELLED,
  }),
  [S.CANCELLED]: Object.freeze({ [E.SELECT_FILE]: S.FILE_SELECTED, [E.RESET]: S.EMPTY }),
  [S.VERIFYING_PRIVATE_OBJECT]: Object.freeze({
    [E.VERIFY_OK]: S.READY_TO_SAVE,
    [E.VERIFY_FAIL]: S.STORAGE_OR_SIGNING_ERROR,
  }),
  [S.STORAGE_OR_SIGNING_ERROR]: Object.freeze({
    [E.RETRY]: S.VERIFYING_PRIVATE_OBJECT,
    [E.SELECT_FILE]: S.FILE_SELECTED,
    [E.RESET]: S.EMPTY,
  }),
  [S.READY_TO_SAVE]: Object.freeze({
    [E.SAVE_START]: S.SAVING_LESSON,
    [E.REPLACE]: S.FILE_SELECTED,
    [E.RESET]: S.EMPTY,
  }),
  [S.SAVING_LESSON]: Object.freeze({
    [E.SAVE_OK]: S.SAVED_AND_PLAYABLE,
    [E.SAVE_FAIL]: S.DATABASE_ERROR,
  }),
  // SAVE_START, not SELECT_FILE: the uploaded object is RETAINED across a failed
  // row update so a retry never re-sends gigabytes.
  [S.DATABASE_ERROR]: Object.freeze({ [E.SAVE_START]: S.SAVING_LESSON, [E.RESET]: S.EMPTY }),
  [S.SAVED_AND_PLAYABLE]: Object.freeze({
    [E.PLAYBACK_FAIL]: S.PLAYBACK_ERROR,
    [E.REPLACE]: S.FILE_SELECTED,
    [E.RESET]: S.EMPTY,
  }),
  [S.PLAYBACK_ERROR]: Object.freeze({
    [E.RESIGN_OK]: S.SAVED_AND_PLAYABLE,
    [E.REPLACE]: S.FILE_SELECTED,
    [E.RESET]: S.EMPTY,
  }),
});

/** The next state, or null when the event does not apply — never a guess. */
export function nextUploadState(state, event) {
  const byEvent = UPLOAD_TRANSITIONS[state];
  if (!byEvent) return null;
  return Object.prototype.hasOwnProperty.call(byEvent, event) ? byEvent[event] : null;
}

const IN_FLIGHT = new Set([S.LOCAL_VALIDATING, S.UPLOADING, S.VERIFYING_PRIVATE_OBJECT]);
const UNFINISHED = new Set([
  S.FILE_SELECTED, S.LOCAL_VALIDATING, S.UPLOADING, S.PAUSED, S.INTERRUPTED,
  S.VERIFYING_PRIVATE_OBJECT, S.STORAGE_OR_SIGNING_ERROR,
]);
const CLOSE_CONFIRM = new Set([S.UPLOADING, S.PAUSED, S.INTERRUPTED]);

/** Work is actually happening right now (spinner, cannot be walked away from cleanly). */
export function isUploadInFlight(state) { return IN_FLIGHT.has(state); }

/** A video is half-authored: saving now would point the row at nothing. */
export function hasUnfinishedUpload(state) { return UNFINISHED.has(state); }

/** Save must stay disabled. */
export function blocksLessonSave(state) {
  return UNFINISHED.has(state) || state === S.SAVING_LESSON;
}

/** Closing would discard transferred bytes — ask before doing it. */
export function needsCloseConfirmation(state) { return CLOSE_CONFIRM.has(state); }

// ── What a stored lesson actually has ──────────────────────────────────────

/**
 * `text | upload | legacy-link | empty | invalid`, judged on what the row
 * HOLDS rather than on what video_provider claims. A zoom_replay_url is
 * deliberately ignored: it renders below the player slot, so a replay-only
 * lesson still shows a student an empty video.
 */
export function classifyLessonVideo(lesson) {
  const l = lesson || {};
  if (l.type !== 'video') return 'text';
  const provider = l.video_provider || null;
  if (provider === 'upload') {
    return isLessonVideoPath(l.storage_path) ? 'upload' : 'invalid';
  }
  if (LEGACY_VIDEO_PROVIDERS.includes(provider)) {
    return String(l.video_url || '').trim() ? 'legacy-link' : 'invalid';
  }
  if (provider === null) return 'empty';
  return 'invalid';
}

/** True when this lesson still owes an uploaded file. */
export function lessonNeedsUpload(lesson) {
  const kind = classifyLessonVideo(lesson);
  return kind !== 'text' && kind !== 'upload';
}

// ── Publish readiness — the client mirror of course_publish_blockers() ─────

const BLOCKER_MESSAGES = Object.freeze({
  external_link: 'Still plays from an external video link. Upload the video file to publish.',
  upload_missing_file: 'Is marked as an upload but has no file. Upload the video again to repair it.',
});

/**
 * Lessons that block publication.
 *
 * ★ THIS IS A MIRROR, and the two halves must agree exactly. The authority is
 *   courses_publish_guard() / course_publish_blockers() in
 *   db/2026-08-24-course-video-upload-only.sql, and the `reason` strings here are
 *   the ones that function returns, so the two can be diffed by eye.
 *
 * ★ A video lesson with NO video at all — no provider, no url, no path — does NOT
 *   block, and neither does one carrying only notes. Two reasons. addLesson()
 *   inserts exactly that shape the moment an admin clicks "Add lesson", so
 *   blocking it would refuse to publish any course with an in-progress lesson;
 *   and saveLesson() has always permitted a video-typed lesson whose only content
 *   is text_content, so blocking that would strand every course containing one
 *   with no way forward. A client preflight that refuses what the server accepts
 *   is worse than no preflight: there is no server error to explain it.
 *
 * ★ Names a lesson; never quotes its content. These strings surface in error copy,
 *   and lesson bodies are paid material.
 */
export function coursePublishBlockers(lessons) {
  const out = [];
  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    if (!lesson || lesson.type !== 'video') continue;
    const provider = lesson.video_provider || '';
    const linkBacked = provider !== 'upload' && !!String(lesson.video_url || '').trim();
    const uploadWithoutFile = provider === 'upload' && !lesson.storage_path;
    if (!linkBacked && !uploadWithoutFile) continue;
    const reason = linkBacked ? 'external_link' : 'upload_missing_file';
    out.push({
      id: lesson.id ?? null,
      title: String(lesson.title || '').trim() || 'Untitled lesson',
      reason,
      message: BLOCKER_MESSAGES[reason],
    });
  }
  return out;
}

// ── The save payload ───────────────────────────────────────────────────────

const EMPTY_VIDEO_PAYLOAD = Object.freeze({ video_url: null, video_provider: null, storage_path: null });

/**
 * The three video columns for a lesson UPDATE.
 *
 * ★ A link can only ever be CARRIED OVER from `prev`, never authored — and it
 *   is carried over BYTE FOR BYTE. course_lessons_video_guard() permits an
 *   UPDATE on a link-backed row only while video_provider AND video_url are
 *   both unchanged, so trimming or normalising the URL here would turn
 *   "rename a legacy lesson" into a permission error with no visible cause.
 *   Anything else — a new link, a different link — resolves to nulls, which is
 *   what the guard would enforce anyway.
 */
export function lessonVideoPayload(draft, prev) {
  const d = draft || {};
  if (d.type !== 'video') return { ...EMPTY_VIDEO_PAYLOAD };

  // ★ ANY non-empty storage_path on the draft is written through unchanged. It is
  //   deliberately NOT filtered through isLessonVideoPath() first: a row whose path
  //   does not match the current shape — an old upload, a hand-repaired row — would
  //   then resolve to all-nulls on a TITLE-ONLY edit, and saveLesson's cleanup
  //   (`oldPath !== payload.storage_path` → removeMediaIfUnreferenced) would delete
  //   the video file. Renaming a lesson must never destroy its video.
  //   A malformed NEW path is refused by course_lessons_video_guard, which checks
  //   the shape only when the path actually CHANGES — exactly the right place for it.
  if (d.storage_path) {
    return { video_url: null, video_provider: 'upload', storage_path: d.storage_path };
  }

  const p = prev || {};
  const carriedProvider = LEGACY_VIDEO_PROVIDERS.includes(p.video_provider) ? p.video_provider : null;
  const carriedUrl = carriedProvider && String(p.video_url || '').trim() ? p.video_url : null;
  if (carriedProvider && carriedUrl
      && d.video_provider === carriedProvider
      && (d.video_url ?? null) === carriedUrl) {
    return { video_url: carriedUrl, video_provider: carriedProvider, storage_path: null };
  }
  return { ...EMPTY_VIDEO_PAYLOAD };
}

// ── Playback recovery ──────────────────────────────────────────────────────

/**
 * Should the player mint a fresh signed URL?
 *
 * Called two ways: with a MediaError `code` after a failure, or with
 * `{ signedAt, ttlMs, now }` to refresh pre-emptively. A DECODE failure is
 * never retried — re-signing cannot fix a codec, and conflating the two is
 * exactly what made every lesson-video failure look identical before #44.
 */
export function shouldResignPlayback(input) {
  const {
    code = null,
    attempt = 0,
    signedAt = null,
    ttlMs = null,
    now = Date.now(),
  } = input || {};

  if (code === MEDIA_ERR_DECODE) return { resign: false, reason: 'decode' };
  if (code === MEDIA_ERR_ABORTED) return { resign: false, reason: 'aborted' };
  if (attempt >= LESSON_VIDEO_MAX_RESIGN) return { resign: false, reason: 'already-retried' };
  if (code === MEDIA_ERR_SRC_NOT_SUPPORTED) return { resign: true, reason: 'source-unavailable' };
  if (code === MEDIA_ERR_NETWORK) return { resign: true, reason: 'network' };

  if (signedAt != null && ttlMs != null) {
    const age = Number(now) - Number(signedAt);
    return age >= Number(ttlMs) - LESSON_VIDEO_RESIGN_MARGIN_MS
      ? { resign: true, reason: 'expiring' }
      : { resign: false, reason: 'fresh' };
  }
  return { resign: false, reason: 'none' };
}

// ── Upload errors ──────────────────────────────────────────────────────────

/**
 * ★ THERE IS NO 'too-large' UPLOAD REASON, AND THERE MUST NEVER BE ONE AGAIN.
 *   validateVideoFile() refuses anything over LESSON_VIDEO_MAX_BYTES before a single
 *   byte leaves the browser, so a 413 DURING a transfer cannot be the admin’s file —
 *   it is definitionally a Storage ceiling below the one this app was told to promise.
 *   Telling someone their 117 MB video "is larger than the 2 GB limit" sent them off to
 *   re-export a file that was never the problem, while the actual fault — a project-wide
 *   Storage limit left at its 50 MiB default — went unmentioned. That is the dishonesty
 *   this reason code exists to end.
 *
 * ★ AND THE MESSAGE MUST NOT NAME THE REAL CEILING. Supabase answers 413 with
 *   EntityTooLarge / "The object exceeded the maximum allowed size" — it carries no
 *   number, so a client can never learn the project-wide limit from the response. Any
 *   figure quoted here beyond this app’s OWN cap would be invented.
 */
const STORAGE_LIMIT_MESSAGE =
  'Storage refused this file as too large — but the app checked it against the '
  + `${formatBytes(LESSON_VIDEO_MAX_BYTES)} lesson limit before sending a single byte, so the `
  + 'file itself is not the problem. Supabase caps every upload at the SMALLER of the bucket '
  + 'limit and the project-wide Storage limit, and the project-wide one is set below it. '
  + 'Raise it (npm run storage:config -- --apply, or Supabase → Storage → Settings). '
  + 'Resuming before then fails at exactly the same point.';

/**
 * Upload failure copy, keyed by reason. Exported so a test can prove this map and
 * UPLOAD_ERROR_RETRYABLE below stay in lockstep — a new reason code must not be able
 * to ship with copy but no retryability, or vice versa.
 */
export const UPLOAD_ERROR_MESSAGES = Object.freeze({
  'storage-limit': STORAGE_LIMIT_MESSAGE,
  unauthorized: 'Storage rejected the credentials for this upload. The bearer token is now '
    + 'refreshed on every request, so this almost always means the session itself ended — '
    + 'sign in again, then choose Resume; nothing already transferred is lost.',
  forbidden: 'This account is not allowed to upload course videos. Admin access is required.',
  'bucket-missing': 'The course-videos storage bucket is missing. Create it as a PRIVATE bucket '
    + 'and run db/2026-08-24-course-video-upload-only.sql, then retry.',
  offline: 'The connection dropped. Reconnect and choose Resume — nothing already transferred is lost.',
  aborted: 'Upload cancelled.',
  unknown: 'The upload could not be completed. Choose Resume to pick up where it stopped, or '
    + 'cancel and re-select the file.',
});

/**
 * May the UI offer Resume?
 *
 * ★ FAIL OPEN. `unknown` is TRUE on purpose: refusing Resume on a failure we could not
 *   classify would strand a transfer that is genuinely resumable, and every byte already
 *   accepted by the server would be re-sent from zero on the next attempt. A failure is
 *   permanent only when we can NAME why.
 * ★ The three FALSE entries are the three answers no amount of retrying changes: the
 *   project-wide ceiling (413), this account’s role (403), and a bucket that does not
 *   exist (404). Each needs a human to change something outside the browser, and the old
 *   UI offered a Resume button for all three — re-running the identical doomed transfer.
 * ★ `aborted` never reaches the UI (runTransfer returns before setting a message), but it
 *   is listed so this map stays exhaustive against UPLOAD_ERROR_MESSAGES.
 */
export const UPLOAD_ERROR_RETRYABLE = Object.freeze({
  'storage-limit': false,
  unauthorized: true,
  forbidden: false,
  'bucket-missing': false,
  offline: true,
  aborted: true,
  unknown: true,
});

function statusOf(err) {
  if (!err || typeof err !== 'object') return null;
  // ★ CANDIDATES, NOT A ?? CHAIN. `fromTus ?? err.status` treated a getStatus() of 0 —
  //   the XHR "no response yet" value — as a real answer, because 0 is not nullish, and
  //   then the `> 0` guard threw it away. Every fallback behind it was unreachable. Each
  //   candidate is now judged on its own and skipped unless it is a real HTTP status.
  const candidates = [
    typeof err.originalResponse?.getStatus === 'function' ? err.originalResponse.getStatus() : null,
    err.status,
    err.statusCode,
    err.originalResponse?.status,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  return null;
}

/**
 * Map an upload failure to `{ reason, status, retryable, message }`.
 *
 * ★ The message is built from the reason code ALONE. The underlying error text
 *   routinely contains the full resumable URL — and, after a redirect, a signed
 *   token — so interpolating it here would render a working grant of the paid
 *   file into the admin UI and into console logs.
 */
export function describeUploadError(err) {
  const name = String(err?.name || '');
  const status = statusOf(err);

  // ★ SHAPE, NOT NAME. tus wraps every transport failure in its own DetailedError, which
  //   extends Error WITHOUT setting `name` — so `name === "TypeError"` could never fire for
  //   a tus failure and every dropped connection was reported as `unknown`. A DetailedError
  //   always carries originalRequest, and carries originalResponse ONLY when a response
  //   actually arrived (upload.js calls _emitHttpError(req, null, …) on transport failure).
  //   "A request went out and nothing came back" is precisely the offline shape.
  const noResponse = !!err?.originalRequest && !err?.originalResponse;

  let reason;
  if (name === 'AbortError' || err?.aborted === true) reason = 'aborted';
  else if (status === 413) reason = 'storage-limit';
  else if (status === 401) reason = 'unauthorized';
  else if (status === 403) reason = 'forbidden';
  else if (status === 404) reason = 'bucket-missing';
  else if (status === null && (noResponse || name === 'TypeError' || err?.offline === true)) reason = 'offline';
  else reason = 'unknown';

  return {
    reason,
    status,
    retryable: UPLOAD_ERROR_RETRYABLE[reason] ?? true,
    message: UPLOAD_ERROR_MESSAGES[reason] || UPLOAD_ERROR_MESSAGES.unknown,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────


/** Binary steps, familiar labels — what an admin reads off their file manager. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * `mm:ss`, or `h:mm:ss` once there are hours. An unknown duration renders as ''.
 *
 * ★ The type check is deliberate and comes BEFORE any coercion: `Number(null)`
 *   is 0, so coercing first would render "not loaded yet" as a confident 0:00.
 *   A browser reports `video.duration` as a number or NaN — nothing else is a
 *   duration.
 */
export function formatMediaDuration(seconds) {
  if (typeof seconds !== 'number') return '';
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
