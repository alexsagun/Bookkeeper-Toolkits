// ─────────────────────────────────────────────────────────────────────────────
// gettingStarted.js — the pure client half of the Getting Started video (#69).
// ─────────────────────────────────────────────────────────────────────────────
// A newly approved student watches one Super-Admin-managed video before their
// first dashboard, and can replay it later. This module owns every decision in
// that flow that needs no React, no Supabase and no DOM, so
// test/gettingStarted.test.mjs can pin it:
//
//   • storage — the private bucket, the object-name shape, its builder and parser;
//   • the watch rule — when "Go to dashboard" unlocks (mergeRanges, playedFraction,
//     watchVerdict, holdWatchVerdict), what a Retry keeps (watchRecordFor, resumeAt),
//     and how a player failure is reported (onboardingProblemCode);
//   • the gate plumbing — what the root hook reports while it is still asking
//     (gettingStartedStatus), when it asks again (gettingStartedNeedsReask), the enrollment
//     fact it is handed (gettingStartedEnrollPhase, built on gettingStartedEnrollPass), what a
//     failed answer means by the phase it lands in (gettingStartedFailedBeforePass) and what
//     the gate is handed (gettingStartedGateInput);
//   • what a student is told — why the video gave up (gettingStartedGiveUpCopy) and where
//     they stand with it (gettingStartedStanding);
//   • the Super Admin copy — one health verdict from the overview's facts
//     (onboardingHealth) and what a publish will do (publishImpact).
//
// ★ THE SQL HALF MIRRORS THIS FILE (db/2026-09-30-getting-started-video.sql).
//   ONBOARDING_VIDEO_PATH_RE is the onboarding_videos.storage_path CHECK and the
//   parser in onboarding_video_path_version_id(); ONBOARDING_VIDEO_BUCKET is the
//   bucket id every storage policy names. ONBOARDING_MIN_ELAPSED_FRACTION,
//   ONBOARDING_UNKNOWN_DURATION_SECONDS and ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS are
//   complete_onboarding_video()'s guard: no completion until
//   greatest(coalesce(duration_seconds, 60) * 0.4, 5) seconds after the student
//   first opened the video. test/gettingStartedSql.test.mjs pins that parity, so
//   change a value here and that suite names the SQL that must move with it.
//   ONBOARDING_PROBLEM_CODES is the enum report_onboarding_video_problem() coerces
//   to; anything else is stored as 'other'.
//
// ★ THE WATCH RULE IS PRESENTATION, NOT SECURITY. It decides when the button
//   unlocks. What refuses a forged completion is the server's elapsed guard: a
//   student can call complete_onboarding_video() without ever loading this module.
//
// ★ PLAYED RANGES OUTLIVE THE <video> — AND THE PLAYER. A re-sign or "Try again"
//   unmounts the element, and its `played` TimeRanges go with it; the outer Retry
//   remounts the player itself. So the caller keeps a watch record (watchRecordFor):
//   the UNION of every element's ranges (mergeRanges) and the place (resumeAt). The
//   unlock, once reached, holds for that video (holdWatchVerdict). Without it, a
//   student 60% in who hit one network blip would have to watch the whole video again.
//
// ★ THE GATE FAILS OPEN; THE DATABASE DOES NOT. A failed or timed-out answer is
//   'unavailable', which renders the app: the gate grants nothing, and membership
//   RLS still protects paid content. An answer fetched for a DIFFERENT account is
//   never rendered, and an approval that lands while the student sits on the
//   pending screen is asked about once more ('loading' meanwhile), so the student
//   sees Getting Started rather than a flash of the dashboard.
//
// NO imports, NO side effects, NO DOM. Pinned by test/gettingStarted.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

// Numbers, or numeric strings (Postgres numerics and counts can arrive as either).
// Never null, '' or true, which Number() would turn into 0 or 1 — for a played range
// that is unplayed time counted as played.
const num = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN);

// ── Storage ──────────────────────────────────────────────────────────────────

/** The PRIVATE bucket. A student can read only the live object, and only while enrolled. */
export const ONBOARDING_VIDEO_BUCKET = 'onboarding-videos';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

/**
 * versions/<video uuid>/<upload uuid>.mp4, and nothing else.
 *
 * ★ OPAQUE BY DESIGN: there is no filename segment (the original name is an admin-only
 *   column), because a Supabase signed URL necessarily contains the object name.
 * ★ LOWERCASE, AND NO FLAGS. The SQL CHECK matches with a case-sensitive `~`.
 *   LESSON_VIDEO_PATH_RE in courseVideo.js is /i; copying that flag here would make
 *   isOnboardingVideoPath() accept a path the database refuses.
 */
export const ONBOARDING_VIDEO_PATH_RE = new RegExp(`^versions/(${UUID})/${UUID}\\.mp4$`);

/**
 * `versions/<videoId>/<uploadId>.mp4`.
 *
 * ★ THROWS on anything but two lowercase uuids, like buildLessonVideoPath(). The uploader
 *   builds its path inside runTransfer's try/catch, where a throw is a visible upload
 *   error; a null would travel on as the object name and fail later, somewhere vaguer.
 */
export function buildOnboardingVideoPath(videoId, uploadId) {
  if (typeof videoId !== 'string' || !UUID_RE.test(videoId)) {
    throw new Error('An onboarding video path needs a valid video id.');
  }
  if (typeof uploadId !== 'string' || !UUID_RE.test(uploadId)) {
    throw new Error('An onboarding video path needs a valid upload id.');
  }
  return `versions/${videoId}/${uploadId}.mp4`;
}

/**
 * The video id a path names, or null for anything that is not exactly one.
 * ★ The typeof check is load-bearing: RegExp#exec coerces its argument to a string, so
 *   an ARRAY holding a valid path would otherwise match.
 */
export function onboardingVideoPathVideoId(path) {
  if (typeof path !== 'string') return null;
  const m = ONBOARDING_VIDEO_PATH_RE.exec(path);
  return m ? m[1] : null;
}

/** True only for a fully-formed onboarding video key. Everything else fails closed. */
export function isOnboardingVideoPath(path) {
  return onboardingVideoPathVideoId(path) !== null;
}

// ── The watch rule ───────────────────────────────────────────────────────────

/** "Go to dashboard" needs at least this share of the timeline ACTUALLY played… */
export const ONBOARDING_WATCH_MIN_FRACTION = 0.9;

/**
 * …and then `ended` — or, for a browser that never fires it, a stop within this many
 * seconds of the end while not seeking.
 */
export const ONBOARDING_NEAR_END_SECONDS = 1.5;

/**
 * The server's elapsed guard: complete_onboarding_video() refuses until
 * max(coalesce(duration, UNKNOWN) × FRACTION, FLOOR) seconds after the student first
 * opened the video. The fraction is under one half, so a student at 2× speed who plays
 * any video of 10 s or more straight through is never refused; the 60 s stand-in and the
 * 5 s floor stop an unverified (NULL) duration from meaning "no wait at all".
 */
export const ONBOARDING_MIN_ELAPSED_FRACTION = 0.4;
export const ONBOARDING_UNKNOWN_DURATION_SECONDS = 60;
export const ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS = 5;

/** At most this many disjoint ranges are kept. See mergeRanges(). */
const MAX_RANGES = 64;

// An array of [start, end] pairs, or a TimeRanges (`video.played`), which is indexable
// but NOT iterable: spreading one throws, and it would throw inside a media event handler.
function rangePairs(r) {
  if (Array.isArray(r)) return r;
  if (r && Number.isInteger(r.length) && r.length >= 0
      && typeof r.start === 'function' && typeof r.end === 'function') {
    const out = [];
    for (let i = 0; i < Math.min(r.length, 10_000); i += 1) out.push([r.start(i), r.end(i)]);
    return out;
  }
  return [];
}

/**
 * The union of two sets of played ranges: sorted, merged (touching ranges join), never
 * below zero, and at most MAX_RANGES long. Either argument may be an array of
 * [start, end] pairs or a TimeRanges; neither is modified.
 *
 * ★ THE CAP DROPS THE SHORTEST RANGES, NOT THE LATEST. Truncating the sorted list would
 *   discard everything after the 64th range — so a student who scrubbed around near the
 *   start and then watched the rest straight through would lose exactly the long stretch
 *   they sat through, and "Go to dashboard" would stay locked however long they kept
 *   watching. Dropping the shortest fragments loses the least watched time, and never
 *   counts time that was not played.
 */
export function mergeRanges(a = [], b = []) {
  const all = [...rangePairs(a), ...rangePairs(b)]
    .map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : null))
    .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([s, e]) => [Math.max(0, s), e])
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  if (out.length <= MAX_RANGES) return out;
  return out
    .map((r, i) => ({ r, i }))
    .sort((x, y) => (y.r[1] - y.r[0]) - (x.r[1] - x.r[0]) || x.i - y.i)
    .slice(0, MAX_RANGES)
    .map(({ r }) => r)
    .sort((x, y) => x[0] - y[0]);
}

/** The share of [0, duration] the ranges cover, in [0, 1]. 0 without a real duration. */
export function playedFraction(ranges, duration) {
  if (!(duration > 0) || !Number.isFinite(duration)) return 0;
  const total = mergeRanges(ranges)
    .reduce((t, [s, e]) => t + Math.max(0, Math.min(duration, e) - Math.max(0, s)), 0);
  return Math.min(1, total / duration);
}

/**
 * Has the student watched it? → { complete, playedPct, reason }.
 *   reason: 'watch_more' (under 90% played) · 'skipped' (under 90% played, and at the END) ·
 *           'ended' · 'near_end' · 'playing'
 *
 * ★ `ended` ALONE IS NOT WATCHING: dragging the scrubber to the end fires it. The played
 *   share is checked first, so a seek to the end stays locked.
 * ★ …AND AT THE END IT SAYS SO (S2). Under 90% with `ended` is 'skipped', never 'watch_more':
 *   "keep going" is impossible at the end — the video has stopped, and the way on is to play it
 *   again, which the gate's progress line now says. What was already watched still counts: the
 *   record is a union of everything played (mergeRanges).
 * ★ An unknown duration (NaN before metadata, Infinity for some recordings) cannot be
 *   measured against, so only `ended` finishes it; the server's elapsed guard still
 *   applies, with its 60 s stand-in.
 */
export function watchVerdict({ ended, currentTime, duration, ranges, seeking } = {}) {
  const known = Number.isFinite(duration) && duration > 0;
  if (!known) return { complete: !!ended, playedPct: null, reason: ended ? 'ended' : 'playing' };
  const frac = playedFraction(ranges, duration);
  const playedPct = Math.floor(frac * 100);
  if (frac < ONBOARDING_WATCH_MIN_FRACTION) return { complete: false, playedPct, reason: ended ? 'skipped' : 'watch_more' };
  if (ended) return { complete: true, playedPct, reason: 'ended' };
  if (!seeking && duration - currentTime <= ONBOARDING_NEAR_END_SECONDS) {
    return { complete: true, playedPct, reason: 'near_end' };
  }
  return { complete: false, playedPct, reason: 'playing' };
}

// ── The watch record ─────────────────────────────────────────────────────────

/**
 * What a player keeps about ONE video: { videoId, ranges, position } — a mergeRanges() union
 * of everything played, and the place (seconds) — across every <video> and every player mount
 * it outlives. → `record` itself when it is about `videoId`; otherwise a FRESH record.
 *
 * ★ IT OUTLIVES THE PLAYER. The caller keeps it in a ref, because the player is REMOUNTED by
 *   the outer Retry (a new key, so start_onboarding_video() runs again) and unmounted by a
 *   Dashboard card that is closed. Kept inside the player, a student 85% into a 10-minute video
 *   who pressed Retry was sent back to 0:00 with nothing counted.
 * ★ A DIFFERENT VIDEO STARTS OVER: what was watched of the old one says nothing about the video
 *   the Super Admin replaced it with. An id that cannot be matched (null) never carries over.
 */
export function watchRecordFor(record, videoId) {
  if (record && typeof record === 'object' && videoId != null && record.videoId === videoId) return record;
  return { videoId: videoId ?? null, ranges: [], position: 0 };
}

/**
 * Where a new <video> is put back → seconds, or 0 for "from the start": the record's place —
 * but 0 for another video, for no usable place, and at the end. A video watched to its end (or
 * to within ONBOARDING_NEAR_END_SECONDS of it) opens at the start, as a finished video does,
 * never on its last frame. An unknown duration (before metadata, or Infinity) cannot say where
 * the end is, so the place stands.
 */
export function resumeAt(record, videoId, duration) {
  if (!record || typeof record !== 'object' || videoId == null || record.videoId !== videoId) return 0;
  const at = num(record.position);
  if (!(Number.isFinite(at) && at > 0)) return 0;
  const d = num(duration);
  if (Number.isFinite(d) && d > 0 && at >= d - ONBOARDING_NEAR_END_SECONDS) return 0;
  return at;
}

/**
 * The verdict to SHOW, given the one shown and the player's newest → the newest — except that
 * a video once watched STAYS watched.
 *
 * ★ ONCE UNLOCKED, STAYS UNLOCKED, FOR THE SAME VIDEO. watchVerdict() answers for the <video>
 *   as it is NOW, so a student who rewinds after the end, or presses the native replay control,
 *   is no longer at the end: complete:false with 100% played. Taking that answer re-locked "Go
 *   to dashboard" under a full progress bar and sent the student back to the end. Watching it
 *   does not un-happen — and the server's elapsed guard, not this button, is what refuses a
 *   forged completion. Returns `shown` itself, so a state setter bails out of the re-render.
 * ★ A verdict about ANOTHER video (the Super Admin replaced it), or null (the player starting
 *   over), replaces it; so does anything when the shown verdict names no video, or is not a
 *   literal complete:true.
 */
export function holdWatchVerdict(shown, next) {
  if (shown && shown.complete === true && next && next.complete !== true
      && shown.videoId != null && shown.videoId === next.videoId) return shown;
  return next ?? null;
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * The root hook's patience, counted from the uid's arrival — the enrollment gate's 7 s.
 * Past it the answer is 'unavailable' and the gate fails OPEN.
 */
export const ONBOARDING_STATE_TIMEOUT_MS = 7000;

/**
 * How long a live player waits — from its mount to the video's first frame — before it gives up
 * into the give-up panel (Retry, support, "Continue to dashboard for now") (GF-3).
 * ★ start_onboarding_video() and the first signature were the only steps between a student and
 *   the dashboard that nothing bounded: postgrest-js never retries or times out a POST, and
 *   storage-js has no timeout at all, so a stalled one left the gate on "Loading video…" with only
 *   Sign out. Longer than the root's question: it covers a start, a signature AND the video's
 *   first bytes. An answer that lands after it still shows the video, and the panel goes.
 */
export const ONBOARDING_LOAD_TIMEOUT_MS = 15000;

/**
 * How long recordOnboardingCompletion() waits for complete_onboarding_video() before it answers
 * { ok: false, code: 'timeout' } — the inline error and Retry (S4). A completion that never
 * answered held "Go to dashboard" busy for good, and a reload forgot the watch record. Retrying
 * is safe: the server keeps the FIRST completed_at.
 */
export const ONBOARDING_COMPLETE_TIMEOUT_MS = 15000;

/**
 * What the root hook reports, derived DURING RENDER from its only state:
 *   fetched = { uid, data, failed, timedOut, reaskedAfterPass }
 * → { status: 'loading' | 'ready' | 'unavailable', data }.
 *
 * ★ Answers are keyed by uid. One fetched for another account is 'loading' with no data —
 *   never rendered — whatever it said, a failure included.
 * ★ THE APPROVAL EDGE. A student waiting on the pending screen is answered eligible:false,
 *   correctly. When the approval lands, enrollPass turns true before anyone has asked
 *   again, and 'ready' + not required would render the dashboard for a frame and then
 *   snatch it away. So a cached eligible:false under enrollPass is 'loading' until the one
 *   re-ask has returned. A cached eligible:true needs no re-ask, and costs no round trip.
 * ★ THE HOOK'S HALF OF THAT CONTRACT. `reaskedAfterPass` means "this answer was
 *   REQUESTED while enrollPass was already true" — the first request included, when it
 *   happened to be sent that late. The hook re-asks on the STATE
 *   `enrollPass && data?.eligible === false && !reaskedAfterPass`, not on an edge: the two
 *   first fetches race, so an edge can fire before the first answer exists and be lost,
 *   leaving 'loading' with nothing left to end it. Failure beats a cached answer, so a
 *   re-ask that fails or times out is 'unavailable' and the gate still fails open.
 * ★ A FAILURE NOBODY DECIDED ON IS ASKED AGAIN TOO (GF-1). `failedBeforePass` is what the failure
 *   meant by the enrollment phase it LANDED in (gettingStartedFailedBeforePass()): true on a HOLD
 *   — the pending screen, a lapsed term — where no gate was waiting on the answer, so it holds the
 *   splash for the one re-ask when the pass arrives, exactly as a cached eligible:false does; false
 *   on the PASS, where it is the gate's answer and fails open at once; and null while the profile or
 *   the enrollment reads were still out, until the hook settles it by the phase they land in. Only the literal
 *   true holds, so a sign-in whose reads land on a pass fails open there — 7 s from the uid, never
 *   7 s twice (V-GF1-DOUBLE-BOUND: a boolean pass read "still loading" as "held", and waited two).
 * ★ A DATABASE WITHOUT #69 SAYS SO (GF-8): `missing` (the function does not exist) is reported as
 *   { missing: true } on the 'unavailable' answer, so the tab can say Getting Started is not set
 *   up instead of offering a "try again" that can never succeed — and it is never re-asked.
 */
export function gettingStartedStatus({ uid, enrollPass, fetched } = {}) {
  if (!uid) return { status: 'unavailable', data: null };
  if (!fetched || fetched.uid !== uid) return { status: 'loading', data: null };
  if (fetched.failed || fetched.timedOut) {
    if (gettingStartedNeedsReask({ uid, enrollPass, fetched })) return { status: 'loading', data: null };
    return fetched.missing === true ? { status: 'unavailable', data: null, missing: true } : { status: 'unavailable', data: null };
  }
  if (!fetched.data) return { status: 'loading', data: null };
  if (gettingStartedNeedsReask({ uid, enrollPass, fetched })) return { status: 'loading', data: fetched.data };
  return { status: 'ready', data: fetched.data };
}

/**
 * Must the root hook ask once more? → true EXACTLY when gettingStartedStatus() holds the splash
 * on a settled answer for this account — the two are one rule, so a hold always has a re-ask
 * behind it (or a splash never ends) and a re-ask always has a hold in front of it (or a round
 * trip nobody waits for). The hook also keeps it to once per account.
 *   • a cached eligible:false REQUESTED before the pass (Review Focus 1);
 *   • a failure or timeout whose failedBeforePass is true — it landed on a HOLD, or landed while the
 *     profile or the reads were still out and they then landed on a hold
 *     (gettingStartedFailedBeforePass()) — unless the function is missing (GF-8), which no answer
 *     can ever change (GF-1).
 * Never for a failure that landed on the pass, or was settled on the pass (failedBeforePass false:
 * it was the gate's answer, and failed open), nor for an answer requested after the pass
 * (`reaskedAfterPass`): that is the re-ask itself.
 */
export function gettingStartedNeedsReask({ uid, enrollPass, fetched } = {}) {
  if (!uid || !fetched || fetched.uid !== uid || !enrollPass || fetched.reaskedAfterPass) return false;
  if (fetched.failed || fetched.timedOut) return fetched.failedBeforePass === true && fetched.missing !== true;
  return fetched.data?.eligible === false;
}

const GATE_STATUSES = Object.freeze(['loading', 'ready', 'unavailable']);

/**
 * The gate's input, { status, required }. `required` is true ONLY for a 'ready' answer
 * whose `required` is the boolean true — the SQL coalesces it to a boolean, so anything
 * else is a malformed answer, and it fails open. An unknown status is 'unavailable': the
 * gate holds its splash only for 'loading', and a status nothing resolves would hold it
 * for ever.
 */
export function gettingStartedGateInput(gs) {
  const status = GATE_STATUSES.includes(gs?.status) ? gs.status : 'unavailable';
  return { status, required: status === 'ready' && gs?.data?.required === true };
}

/**
 * The SETTLED pass → true only when the PROFILE (`profileReady`) and the enrollment reads
 * (`ready`) have both LANDED and they say 'pass'. Only the literal booleans count. It is
 * gettingStartedEnrollPhase()'s 'pass' — the phase the root hook is handed — and so the hook's
 * own enrollPass.
 *
 * ★ A PASS NOBODY HAS CONFIRMED SPENT THE RE-ASK (T12-D1). While the two enrollment reads are in
 *   flight, enrollGateState() answers from the profile alone — and for a paid profile with no term
 *   loaded yet, that answer is 'pass' (the grandfather rule). A LAPSED member's first answer is
 *   eligible:false, so that provisional pass sent the hook's one re-ask early and stamped it
 *   reaskedAfterPass; a renewal approved later in the same session then found nothing left to ask
 *   with, the stale eligible:false read as 'ready', and the gate failed open past the video.
 * ★ AND THE PROFILE HAS TO BE THIS ACCOUNT'S (K3R-GATE-DIRECT-SWITCH). `ready` alone is true before
 *   the profile lands — useEnrollmentGate is inactive until then, and reports ready — and on a
 *   DIRECT account switch (no signed-out render between) the profile still in hand is the PREVIOUS
 *   account's. Its pass, read before the new profile landed, was handed over as the new account's:
 *   the new account's first question went out stamped reaskedAfterPass, and an enrollment approved
 *   (or a lapsed term renewed) later in that session reached the dashboard without the video.
 *   Measured in Chrome: useEnrollmentGate reporting only the signed-in account's reads did not close
 *   that door by itself; requiring the profile here did.
 * ★ THE HOOK'S INPUT ONLY. The root's own enrollPass — what the entitlement memo reads — stays
 *   enroll.state === 'pass'. The gate already holds its splash until the profile and enroll.ready,
 *   so nothing it decides changes; only the one question the hook may ask again is kept for a real
 *   pass.
 */
export function gettingStartedEnrollPass(input) {
  return input?.profileReady === true && input?.ready === true && input?.pass === true;
}

/**
 * Where the enrollment gate stands, for the root hook → 'pass' | 'hold' | 'unknown'
 * (V-GF1-DOUBLE-BOUND).
 *   'pass'    a SETTLED pass — exactly gettingStartedEnrollPass(): the profile and the reads have
 *             landed, and they say pass.
 *   'hold'    SETTLED and not passing: the profile and both enrollment reads have landed, and the
 *             student is held — the pending screen, a lapsed term, a scheduled start, the paywall.
 *             No gate decision waits on the Getting Started answer there.
 *   'unknown' still loading: the profile, or the enrollment reads, have not landed. (`ready` alone
 *             cannot say it: useEnrollmentGate reports ready while it is inactive, and it is inactive
 *             until the profile has loaded — and on a direct account switch the profile in hand until
 *             then is the PREVIOUS account's, so not even a pass is settled without it.)
 * Only the literal booleans count, as in gettingStartedEnrollPass().
 *
 * ★ WHY THREE AND NOT TWO. A failed first answer that LANDED on a hold decided nothing — the pass,
 *   when it comes, asks again (GF-1). One that landed while the profile or the enrollment reads were
 *   still out is decided by where they land: on a hold, the same; on the pass, it WAS the gate's
 *   answer and fails open there.
 *   Handed a boolean, the hook could not tell "still loading" from "held": a sign-in whose enrollment
 *   reads were slower than a failed or timed-out first answer re-asked, and the splash waited a second
 *   7 s bound (14.4 s, measured in Chrome) where the plan promised one, counted from the uid.
 */
export function gettingStartedEnrollPhase(input) {
  if (gettingStartedEnrollPass(input)) return 'pass';
  return input?.profileReady === true && input?.ready === true ? 'hold' : 'unknown';
}

/**
 * What a FAILED answer means, by the enrollment phase it lands in → true | false | null — the
 * root hook's `failedBeforePass` (GF-1, V-GF1-DOUBLE-BOUND).
 *   'hold' → true: nobody decided on it — the pass, when it comes, asks once more.
 *   'pass' → false: it is the gate's answer, and fails open at once.
 *   anything else → null: not decided YET. The hook settles it by the first settled phase the profile
 *     and the reads land in (this function again), so only a hold ever turns it into a re-ask.
 */
export function gettingStartedFailedBeforePass(phase) {
  if (phase === 'hold') return true;
  if (phase === 'pass') return false;
  return null;
}

// ── What the student is told ─────────────────────────────────────────────────

/**
 * Why the video gave up, in one sentence, for the give-up panel → string. `reason` is what the
 * player handed onGiveUp(): a player problem, a refused start (its app error code), 'start', or
 * 'slow' (the load bound, ONBOARDING_LOAD_TIMEOUT_MS).
 * ★ "ON THIS DEVICE" ONLY FOR A DECODE FAILURE (S3, GF-5). It used to be said for every reason —
 *   a refused signature, a failed start, a video unpublished mid-session — and sent students to
 *   try another device that would fail the same way. The two server refusals say what happened;
 *   the screens also ask the root again for them, so the page shows the state the answer brings.
 */
export function gettingStartedGiveUpCopy(reason) {
  if (reason === 'decode') return 'The video isn’t playing on this device right now.';
  if (reason === 'slow') return 'The video is taking too long to load.';
  if (reason === 'ONBOARDING_VIDEO_UNAVAILABLE') return 'The Getting Started video isn’t available right now.';
  if (reason === 'ONBOARDING_VIDEO_NOT_ELIGIBLE') return 'The Getting Started video isn’t available on your account right now.';
  return 'The video isn’t playing right now.';
}

/**
 * Where the viewer stands with the video, from my_onboarding_video()'s facts →
 *   'completed' (the current version) · 'earlier' (finished a version since replaced) ·
 *   'owed' (asked to watch it, and has not) · 'optional' (never asked: approved before the
 *   first publish)
 * ★ ONE DERIVATION FOR THE CARD'S CHIP AND THE PAGE'S LINE (S6). The card read
 *   completed_current for its chip and `completed` for its button, so a student who finished an
 *   earlier version saw "Not finished" beside "Replay" while the page said they had finished it —
 *   and every member who was never asked carried a "Not finished" to-do on their Dashboard.
 *   Only the literal booleans count.
 */
export function gettingStartedStanding(data) {
  if (data?.completed_current === true) return 'completed';
  if (data?.completed === true) return 'earlier';
  if (data?.required === true) return 'owed';
  return 'optional';
}

// ── Playback problems ────────────────────────────────────────────────────────

/**
 * What report_onboarding_video_problem() stores as last_problem_code. The SQL coerces
 * anything else to 'other', and so does onboardingProblemCode(), so a reason renamed on
 * one side degrades to 'other' rather than raising.
 */
export const ONBOARDING_PROBLEM_CODES = Object.freeze(['sign', 'decode', 'playback', 'missing', 'other']);

// SignedLessonVideo's failure reasons (shouldResignPlayback()'s among them) → a stored code.
// ★ A Map, not an object literal: 'constructor' and '__proto__' are keys of every object.
const PROBLEM_CODE_BY_REASON = new Map([
  ['sign', 'sign'],                    // no signed URL — the first attempt, or the re-sign
  ['decode', 'decode'],                // this device cannot decode the file; re-signing cannot help
  ['already-retried', 'playback'],     // a network or source error the one re-sign did not fix
  ['network', 'playback'],
  ['source-unavailable', 'playback'],
  ['aborted', 'playback'],
  ['missing', 'missing'],              // no object path at all
]);

/** A player failure reason → one of ONBOARDING_PROBLEM_CODES ('other' when unknown). */
export function onboardingProblemCode(reason) {
  const r = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (ONBOARDING_PROBLEM_CODES.includes(r)) return r;
  return PROBLEM_CODE_BY_REASON.get(r) || 'other';
}

// ── Super Admin copy ─────────────────────────────────────────────────────────

// A non-negative whole count, or null when the fact is missing.
function countOf(v) {
  const n = num(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n, one, many) => `${grouped(n)} ${n === 1 ? one : many}`;
const sentences = (...parts) => parts.filter(Boolean).join(' ');
const verdict = (code, level, title, body) => ({ code, level, title, body });

/**
 * ONE verdict from the facts admin_onboarding_video_overview() returns:
 *   { live_video_id, versions: [{ id, status, media_present, problems_7d, duration_seconds, … }],
 *     required_since, counts: { completed_students, pending_students, active_members } }
 * → { code, level, title, body }, worst first:
 *   unknown (warn) · none_live (info) · file_missing (danger) · playback_problems (warn) ·
 *   unverified (warn) · ok (ok)
 *
 * The overview reports facts and only this interprets them, so the admin banner, the
 * admin row's attention badge and the Dashboard card cannot disagree. Only the LIVE
 * version is judged: a retired version's missing file or old reports are history.
 * ★ AN OVERVIEW THAT DID NOT LOAD IS 'unknown', NEVER 'none_live'. A transient RPC error
 *   or a pre-#69 database is not a fact about the video, and reading it as "nothing is
 *   live" would raise the admin badge for the wrong reason. Only an object that carries
 *   the `live_video_id` key (null included) is an answer.
 * ★ 'info' is not an AdminNotice kind, and AdminNotice renders an unknown kind as
 *   danger — the caller maps it.
 */
export function onboardingHealth(overview) {
  if (!overview || typeof overview !== 'object'
      || !Object.prototype.hasOwnProperty.call(overview, 'live_video_id')) {
    return verdict('unknown', 'warn', 'Couldn’t check the Getting Started video',
      'The video’s status could not be loaded, so nothing here is known to be wrong or right. Try again in a moment.');
  }
  const liveId = overview.live_video_id || null;
  if (!liveId) {
    return verdict('none_live', 'info', 'No Getting Started video is live',
      'Newly approved students go straight to their dashboard. Upload a video, check it with Preview, then publish it.');
  }
  const versions = Array.isArray(overview.versions) ? overview.versions : [];
  const live = versions.find((v) => v && v.id === liveId) || {};
  // Only an explicit false: a missing fact is not evidence of a missing file.
  if (live.media_present === false) {
    return verdict('file_missing', 'danger', 'The live video’s file is missing',
      'The published video is no longer in storage, so nobody is asked to watch it and replays won’t play. '
        + 'Upload a replacement and publish it in its place, or unpublish this one.');
  }
  const problems = countOf(live.problems_7d);
  if (problems > 0) {
    return verdict('playback_problems', 'warn', 'Playback problems in the last 7 days',
      `${plural(problems, 'student', 'students')} hit a playback problem with the live video in the last 7 days. `
        + 'Preview it on a phone and in another browser. If it won’t play there either, replace it with an '
        + 'H.264 MP4, the most widely supported format.');
  }
  const duration = num(live.duration_seconds);
  if (!(Number.isFinite(duration) && duration > 0)) {
    return verdict('unverified', 'warn', 'The live video’s length wasn’t verified',
      'The browser that uploaded it couldn’t read how long it is, which usually means that browser couldn’t '
        + 'play the file. Preview it on another device to confirm it plays.');
  }
  return verdict('ok', 'ok', 'The Getting Started video is live',
    'Newly approved students watch it once before their first dashboard, and members can replay it from Getting Started.');
}

// Asia/Manila is a fixed +08:00 (no daylight saving since 1978) — the same fact
// legacyMigration.js and meetingSchedule.js rely on. Restated, not imported: this module
// has no imports.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "September 30, 2026": the Manila calendar day of a timestamp, a Date or epoch ms, or a
// bare 'YYYY-MM-DD' taken as given. '' when it cannot be read.
function manilaCalendarDate(value) {
  let day = typeof value === 'string' && ISO_DAY_RE.test(value.trim()) ? value.trim() : null;
  if (!day) {
    const ms = value instanceof Date ? value.getTime()
      : typeof value === 'number' ? value
        : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) {
      try {
        day = new Date(ms + MANILA_OFFSET_MS).toISOString().slice(0, 10);
      } catch {
        day = null;                        // outside the range a Date can hold
      }
    }
  }
  const m = day ? ISO_DAY_RE.exec(day) : null;
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return '';
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

const titleOf = (v) => (typeof v?.title === 'string' ? v.title.trim() : '');
const quoted = (v) => {
  const t = titleOf(v);
  return t ? `“${t}”` : 'this video';
};

function finishedSentence(n) {
  if (n === 0) return '';
  return n === null
    ? 'Students who already finished a Getting Started video won’t be asked again.'
    : `The ${plural(n, 'student', 'students')} who already finished a Getting Started video won’t be asked again.`;
}

/**
 * What a publish will do, for its confirmation → { title, body }.
 *   live          — the version live now, or null
 *   target        — the version about to be published
 *   counts        — the overview's counts
 *   requiredSince — the overview's required_since AS IT IS: null until the first publish
 *   now           — the moment of this publish (defaults to now)
 *
 * Three cases, because the gate rule makes them mean different things:
 *   • FIRST PUBLISH (requiredSince is null) sets the cutoff to this moment, for good —
 *     even if the video is later unpublished, replaced or deleted. Current members are not
 *     asked; students approved from now on are.
 *   • REPLACE (something is live) keeps the cutoff: whoever has not finished sees the new
 *     video, and nobody who finished ANY version is asked again.
 *   • PUBLISH AGAIN (nothing live, the cutoff already set) asks everyone approved since the first
 *     publish who never finished — including students approved while nothing was live.
 *     ★ "Since the first publish", never "on or after {day}": the cutoff is the publish MOMENT,
 *       so a student approved earlier that same Manila day is not asked (T9UI-13 — the first
 *       publish's copy was corrected the same way).
 * ★ Never "all students": no case asks everyone, so no sentence may say one does.
 */
export function publishImpact({ live = null, target = null, counts = null, requiredSince = null, now = Date.now() } = {}) {
  const completed = countOf(counts?.completed_students);
  const pending = countOf(counts?.pending_students);
  const members = countOf(counts?.active_members);
  const name = quoted(target);

  if (live && target && live.id != null && live.id === target.id) {
    return { title: 'This video is already live', body: 'Publishing it again changes nothing for students.' };
  }

  if (live) {
    const liveName = titleOf(live);
    let waiting = 'Students who haven’t finished yet will see the new video instead.';
    if (pending === 0) waiting = 'No student is waiting to watch it right now.';
    else if (pending !== null) {
      waiting = `${plural(pending, 'student who hasn’t', 'students who haven’t')} finished yet will see the new video instead.`;
    }
    return {
      title: `Replace the live video with ${name}?`,
      body: sentences(
        `The live video${liveName ? `, “${liveName}”,` : ''} will be retired and ${name} will take its place.`,
        waiting,
        finishedSentence(completed),
        'A student partway through the old video will be asked to watch the new one instead.',
      ),
    };
  }

  const firstPublish = requiredSince == null || (typeof requiredSince === 'string' && !requiredSince.trim());
  if (firstPublish) {
    const day = manilaCalendarDate(now) || 'today';
    let current = 'Current members won’t be asked to watch it, but can replay it from Getting Started.';
    if (members === 0) current = '';
    else if (members !== null) {
      current = `Your ${plural(members, 'current member', 'current members')} won’t be asked to watch it, `
        + 'but can replay it from Getting Started.';
    }
    return {
      title: `Publish ${name}?`,
      body: sentences(
        // "From now on", not "from {day} onward": the cutoff is the publish MOMENT, so a
        // student approved earlier the same Manila day is an existing member.
        `New students approved from now on (from ${day}) will watch it once before their first dashboard.`,
        current,
        `This sets ${day} as the permanent cutoff, even if you later unpublish, replace or delete this video, `
          + 'so check drafts with Preview rather than publishing a test.',
      ),
    };
  }

  const day = manilaCalendarDate(requiredSince);
  const since = day ? `since the first publish (${day})` : 'since the first publish';
  return {
    title: `Publish ${name}?`,
    body: sentences(
      `Students approved ${since} who haven’t finished a Getting Started video will be asked to `
        + 'watch it the next time they open the toolkit.',
      finishedSentence(completed),
      'Members approved before the first publish aren’t asked, but can replay it from Getting Started.',
    ),
  };
}

/** 272 → '4:32', 3725 → '1:02:05'. '' when the duration is unknown; a real clip never reads 0:00. */
export function formatVideoDuration(seconds) {
  const n = num(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.max(1, Math.round(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
