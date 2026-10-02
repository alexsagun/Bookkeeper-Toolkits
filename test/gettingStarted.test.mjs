// test/gettingStarted.test.mjs — the pure client half of the Getting Started video (#69).
//
// ★ WHY THIS SUITE EXISTS. Three decisions in this flow are easy to get subtly wrong and
//   impossible to see in a render:
//     1. WHEN A STUDENT HAS WATCHED. A seek to the end is not watching, and a re-sign
//        destroys the <video> — and its `played` ranges — partway through a lesson.
//     2. WHAT THE GATE SHOWS WHILE IT IS STILL ASKING. A previous account's answer must
//        never render, and a student approved while sitting on the pending screen must
//        land on Getting Started, never on a flash of the dashboard (Review Focus 1).
//     3. WHAT THE SUPER ADMIN IS TOLD. The first publish fixes a permanent cutoff, and a
//        confirmation that says "all students" would be false every time it is shown.
//
// The SQL half mirrors the path pattern and the three elapsed constants; that parity is
// test/gettingStartedSql.test.mjs's job, not this file's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ONBOARDING_VIDEO_BUCKET, ONBOARDING_WATCH_MIN_FRACTION, ONBOARDING_NEAR_END_SECONDS,
  ONBOARDING_MIN_ELAPSED_FRACTION, ONBOARDING_UNKNOWN_DURATION_SECONDS,
  ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS, ONBOARDING_STATE_TIMEOUT_MS,
  ONBOARDING_LOAD_TIMEOUT_MS, ONBOARDING_COMPLETE_TIMEOUT_MS,
  ONBOARDING_PROBLEM_CODES, ONBOARDING_VIDEO_PATH_RE,
  buildOnboardingVideoPath, isOnboardingVideoPath, onboardingVideoPathVideoId,
  mergeRanges, playedFraction, watchVerdict, watchRecordFor, resumeAt, holdWatchVerdict,
  gettingStartedStatus, gettingStartedNeedsReask, gettingStartedGateInput, gettingStartedEnrollPass,
  gettingStartedEnrollPhase, gettingStartedFailedBeforePass,
  gettingStartedGiveUpCopy, gettingStartedStanding,
  onboardingProblemCode, onboardingHealth, publishImpact, formatVideoDuration,
} from '../src/lib/gettingStarted.js';
import { shouldResignPlayback } from '../src/lib/courseVideo.js';
import { enrollGateState } from '../src/lib/enrollGate.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = () => readFileSync(join(REPO, 'src/lib/gettingStarted.js'), 'utf8').replace(/\r\n/g, '\n');

const V = 'b3c1d2e4-5f60-4718-9a2b-3c4d5e6f7081';    // a video (version) id
const V2 = 'c0ffee00-1234-4abc-9def-0123456789ab';
const V3 = 'deadbeef-0000-4000-8000-00000000abcd';
const U = '0f1e2d3c-4b5a-4968-8776-655443322110';    // an upload id

// A TimeRanges stand-in: indexable, NOT iterable — exactly like video.played.
const timeRanges = (pairs) => ({ length: pairs.length, start: (i) => pairs[i][0], end: (i) => pairs[i][1] });

// ── 0. The module ────────────────────────────────────────────────────────────

test('the module is pure: no imports, no DOM, and exactly these exports', () => {
  const src = SRC();
  assert.ok(!/^\s*import\s/m.test(src), 'no imports — the gate, the player and the admin screen all read it');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(?:window|document)\.|\b(?:localStorage|sessionStorage)\b|\bfetch\(/,
    'no DOM, no storage, no network');
  const exported = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, [
    'ONBOARDING_VIDEO_BUCKET', 'ONBOARDING_WATCH_MIN_FRACTION', 'ONBOARDING_NEAR_END_SECONDS',
    'ONBOARDING_MIN_ELAPSED_FRACTION', 'ONBOARDING_UNKNOWN_DURATION_SECONDS',
    'ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS', 'ONBOARDING_STATE_TIMEOUT_MS',
    'ONBOARDING_LOAD_TIMEOUT_MS', 'ONBOARDING_COMPLETE_TIMEOUT_MS',
    'ONBOARDING_PROBLEM_CODES', 'ONBOARDING_VIDEO_PATH_RE',
    'buildOnboardingVideoPath', 'isOnboardingVideoPath', 'onboardingVideoPathVideoId',
    'mergeRanges', 'playedFraction', 'watchVerdict', 'watchRecordFor', 'resumeAt', 'holdWatchVerdict',
    'gettingStartedStatus', 'gettingStartedNeedsReask', 'gettingStartedGateInput', 'gettingStartedEnrollPass',
    'gettingStartedEnrollPhase', 'gettingStartedFailedBeforePass',
    'gettingStartedGiveUpCopy', 'gettingStartedStanding',
    'onboardingProblemCode', 'onboardingHealth', 'publishImpact', 'formatVideoDuration',
  ].sort());
});

test('the constants are the values the plan and the SQL agree on', () => {
  assert.equal(ONBOARDING_VIDEO_BUCKET, 'onboarding-videos');
  assert.equal(ONBOARDING_WATCH_MIN_FRACTION, 0.9);
  assert.equal(ONBOARDING_NEAR_END_SECONDS, 1.5);
  assert.equal(ONBOARDING_MIN_ELAPSED_FRACTION, 0.4);
  assert.equal(ONBOARDING_UNKNOWN_DURATION_SECONDS, 60);
  assert.equal(ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS, 5);
  assert.equal(ONBOARDING_STATE_TIMEOUT_MS, 7000);
  // GF-3 and S4: the two waits a student used to sit through with no way out.
  assert.equal(ONBOARDING_LOAD_TIMEOUT_MS, 15000);
  assert.equal(ONBOARDING_COMPLETE_TIMEOUT_MS, 15000);
  assert.ok(ONBOARDING_LOAD_TIMEOUT_MS > ONBOARDING_STATE_TIMEOUT_MS,
    'the player\'s bound covers a start, a signature AND the video\'s first bytes — never shorter than one question');
  assert.ok(Object.isFrozen(ONBOARDING_PROBLEM_CODES), 'the enum cannot be pushed to at runtime');
  assert.deepEqual([...ONBOARDING_PROBLEM_CODES], ['sign', 'decode', 'playback', 'missing', 'other']);
});

test('the elapsed guard tolerates 2x speed, and a NULL duration still has a wait', () => {
  // The server refuses completion until max(coalesce(duration, 60) * 0.4, 5) seconds after the
  // student first opened the video. Playing a D-second video through at 2x takes D/2 seconds.
  const minWait = (d) => Math.max((d ?? ONBOARDING_UNKNOWN_DURATION_SECONDS) * ONBOARDING_MIN_ELAPSED_FRACTION,
    ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS);
  for (const d of [10, 30, 90, 272, 1800, 14400]) {
    assert.ok(d / 2 >= minWait(d), `a ${d}s video played straight through at 2x is never refused`);
  }
  assert.equal(minWait(null), 24, 'an unverified video still waits 24 s, not zero');
  assert.equal(minWait(3), 5, 'the floor binds on any clip shorter than 12.5 s');
});

// ── 1. Paths ─────────────────────────────────────────────────────────────────

test('paths: build → parse round-trips, and the object name carries no filename', () => {
  for (const vid of [V, V2]) {
    const p = buildOnboardingVideoPath(vid, U);
    assert.equal(p, `versions/${vid}/${U}.mp4`);
    assert.equal(isOnboardingVideoPath(p), true);
    assert.equal(onboardingVideoPathVideoId(p), vid);
    assert.ok(ONBOARDING_VIDEO_PATH_RE.test(p));
  }
  assert.equal(ONBOARDING_VIDEO_PATH_RE.flags, '', 'case-sensitive, like the SQL CHECK’s `~`');
});

test('paths: every hostile shape is refused (→ null)', () => {
  const hostile = {
    traversal: [`versions/../${U}.mp4`, `versions/${V}/../${U}.mp4`, `../versions/${V}/${U}.mp4`,
      `versions/${V}/..%2F${U}.mp4`],
    uppercase: [`versions/${V.toUpperCase()}/${U}.mp4`, `versions/${V}/${U.toUpperCase()}.mp4`,
      `versions/${V}/${U}.MP4`, `Versions/${V}/${U}.mp4`],
    missingMp4: [`versions/${V}/${U}`, `versions/${V}/${U}.mov`, `versions/${V}/${U}.mp4.mov`,
      `versions/${V}/${U}mp4`, `versions/${V}/${U}xmp4`, `versions/${V}/${U}_mp4`],
    extraSegment: [`versions/${V}/${U}/${U}.mp4`, `versions/${V}/x/${U}.mp4`, `x/versions/${V}/${U}.mp4`,
      `/versions/${V}/${U}.mp4`, `versions//${V}/${U}.mp4`, `versions/${V}/${U}.mp4/`],
    nonUuid: [`versions/not-a-uuid/${U}.mp4`, `versions/${V}/welcome.mp4`, `versions/${V.slice(1)}/${U}.mp4`,
      `versions/${V}0/${U}.mp4`, `versions/${V.replace(/-/g, '')}/${U}.mp4`, `versions/${V}/${U}-welcome.mp4`],
    otherBuckets: [`lessons/${V}/${U}.mp4`, `covers/${V}/${U}.mp4`],
    whitespace: ['', ' ', `versions/${V}/${U}.mp4\n`, ` versions/${V}/${U}.mp4`],
  };
  for (const [kind, paths] of Object.entries(hostile)) {
    for (const p of paths) {
      assert.equal(onboardingVideoPathVideoId(p), null, `${kind}: ${JSON.stringify(p)}`);
      assert.equal(isOnboardingVideoPath(p), false, `${kind}: ${JSON.stringify(p)}`);
    }
  }
  // ★ RegExp#exec coerces its argument to a string, so an ARRAY holding a valid path would
  //   match without the typeof check.
  for (const notAString of [null, undefined, 42, {}, [], [`versions/${V}/${U}.mp4`]]) {
    assert.equal(onboardingVideoPathVideoId(notAString), null, JSON.stringify(notAString));
    assert.equal(isOnboardingVideoPath(notAString), false);
  }
});

test('paths: the builder refuses anything but two lowercase uuids, loudly', () => {
  // It throws rather than returning null, like buildLessonVideoPath: the uploader calls it
  // inside runTransfer's try/catch, where a throw becomes a visible upload error and a null
  // would travel on as the object name.
  const bad = [['not-a-uuid', U], [V, '../x'], [V.toUpperCase(), U], [V, U.toUpperCase()],
    [null, U], [V, undefined], [`${V}/..`, U], [V, `${U}.mp4`], [42, U]];
  for (const [vid, up] of bad) {
    assert.throws(() => buildOnboardingVideoPath(vid, up), /onboarding video path/, `${vid} / ${up}`);
  }
});

// ── 2. Watch math ────────────────────────────────────────────────────────────

test('playedFraction merges overlapping and unsorted ranges, clamps to [0, 1], and is 0 without a duration', () => {
  assert.equal(playedFraction([[30, 60], [0, 30]], 60), 1, 'unsorted and touching');
  assert.equal(playedFraction([[0, 40], [20, 50]], 100), 0.5, 'an overlap counts once');
  assert.equal(playedFraction([[0, 10], [0, 10], [5, 10]], 100), 0.1, 'a repeat counts once');
  assert.equal(playedFraction([[-10, 30]], 60), 0.5, 'nothing before zero');
  assert.equal(playedFraction([[0, 90]], 60), 1, 'nothing past the end');
  assert.equal(playedFraction([[50, 90]], 60), 10 / 60);
  for (const d of [0, -5, NaN, Infinity, -Infinity, undefined, null, '60']) {
    assert.equal(playedFraction([[0, 30]], d), 0, `duration ${String(d)}`);
  }
  assert.equal(playedFraction([], 60), 0);
  assert.equal(playedFraction(undefined, 60), 0);
  assert.equal(playedFraction([[5, 5], [10, 2], ['a', 'b'], null, [NaN, 3], [1, Infinity], [true, 9]], 60), 0,
    'malformed ranges count for nothing');
});

test('mergeRanges: the union survives an element reset (a re-sign destroys the <video>)', () => {
  // The first element played 0–36 s and was destroyed by a re-sign; the new element resumed at
  // 36 s and played to the end. Neither element alone holds 90 %.
  const merged = mergeRanges([[0, 36]], [[36, 60]]);
  assert.deepEqual(merged, [[0, 60]]);
  assert.equal(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: merged }).complete, true);
  assert.equal(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[36, 60]] }).complete, false,
    'the new element alone is only 40 %');
});

test('mergeRanges: sorted, merged, never negative, and the caller’s arrays are untouched', () => {
  const a = [[50, 60], [0, 10]];
  const b = [[5, 20], [55, 58], [-3, 1]];
  const snapshot = JSON.stringify([a, b]);
  assert.deepEqual(mergeRanges(a, b), [[0, 20], [50, 60]]);
  assert.equal(JSON.stringify([a, b]), snapshot);
  assert.deepEqual(mergeRanges(), []);
  assert.deepEqual(mergeRanges([[1, 2]]), [[1, 2]]);
  assert.deepEqual(mergeRanges(null, undefined), []);
  assert.deepEqual(mergeRanges([[0, 5]], [[5, 9]]), [[0, 9]], 'touching ranges join');
  assert.deepEqual(mergeRanges([[0, 5]], [[5.5, 9]]), [[0, 5], [5.5, 9]], 'a real gap stays a gap');
});

test('mergeRanges reads a TimeRanges (video.played) directly', () => {
  // The player merges `video.played` on every timeupdate; a TimeRanges is not iterable, so
  // spreading it would throw inside a media event handler.
  const played = timeRanges([[0, 12.5], [20, 30]]);
  assert.deepEqual(mergeRanges([[10, 22]], played), [[0, 30]]);
  assert.deepEqual(mergeRanges(played), [[0, 12.5], [20, 30]]);
});

test('mergeRanges stays bounded, and the cap drops the SHORTEST ranges, never a long one', () => {
  // A student who scrubbed 200 times, then watched the rest straight through. Keeping the
  // first 64 ranges by start time would discard the 1,800 s they actually sat through and
  // leave "Go to dashboard" locked however long they kept watching.
  const scrubs = Array.from({ length: 200 }, (_, i) => [i, i + 0.5]);
  const merged = mergeRanges(scrubs, [[200, 2000]]);
  assert.ok(merged.length <= 64, `bounded (${merged.length})`);
  for (let i = 1; i < merged.length; i += 1) assert.ok(merged[i - 1][1] < merged[i][0], 'sorted and disjoint');
  assert.ok(merged.some(([s, e]) => s === 200 && e === 2000), 'the long watched range is kept');
  assert.equal(watchVerdict({ ended: true, currentTime: 2000, duration: 2000, ranges: merged }).complete, true);
});

test('watchVerdict: the six plan cases', () => {
  assert.equal(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 5], [58, 60]], seeking: false }).complete, false); // seek-to-end
  assert.equal(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 60]] }).complete, true);                           // play-through
  assert.equal(watchVerdict({ ended: false, currentTime: 59.2, duration: 60, ranges: [[0, 59.2]], seeking: false }).reason, 'near_end');  // missing 'ended'
  assert.equal(watchVerdict({ ended: false, currentTime: 59.9, duration: 60, ranges: [[0, 50]], seeking: false }).complete, false);     // below 90 %
  assert.equal(watchVerdict({ ended: false, currentTime: 59.9, duration: 60, ranges: [[0, 59.9]], seeking: true }).complete, false);    // mid-seek
  assert.equal(watchVerdict({ ended: true, currentTime: 12, duration: Infinity, ranges: [[0, 12]] }).complete, true);                   // unknown duration
});

test('watchVerdict reports progress and names why it is not finished', () => {
  assert.deepEqual(watchVerdict({ ended: false, currentTime: 30, duration: 60, ranges: [[0, 30]], seeking: false }),
    { complete: false, playedPct: 50, reason: 'watch_more' });
  assert.deepEqual(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 5], [58, 60]] }),
    { complete: false, playedPct: 11, reason: 'skipped' }, '`ended` alone is not watching — and at the end it says why (S2)');
  assert.deepEqual(watchVerdict({ ended: false, currentTime: 40, duration: 60, ranges: [[0, 57]], seeking: false }),
    { complete: false, playedPct: 95, reason: 'playing' }, 'enough played, but not at the end yet');
  assert.deepEqual(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 54], [59, 60]] }),
    { complete: true, playedPct: 91, reason: 'ended' }, '90 % is the bar — the last tenth may be skipped');
  assert.equal(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 54]] }).complete, true,
    'exactly 90 % passes');
  assert.deepEqual(watchVerdict({ ended: false, currentTime: 12, duration: NaN, ranges: [[0, 12]] }),
    { complete: false, playedPct: null, reason: 'playing' }, 'before metadata, only `ended` can finish it');
  assert.equal(watchVerdict({ ended: false, currentTime: 60, duration: 60 }).reason, 'watch_more', 'no ranges yet');
  assert.equal(watchVerdict({ ended: false, currentTime: 60, duration: 60, ranges: timeRanges([[0, 60]]) }).reason,
    'near_end', 'a TimeRanges is accepted as the ranges');
  assert.equal(watchVerdict({ ended: false, currentTime: 58.5, duration: 60, ranges: [[0, 58.5]], seeking: false }).reason,
    'near_end', 'exactly ONBOARDING_NEAR_END_SECONDS from the end counts (60 − 58.5 is exact in binary)');
  assert.equal(watchVerdict().complete, false);
});

test('watchVerdict: at the END with parts skipped is "skipped" — never "keep going", which cannot be done there (S2)', () => {
  // The reviewer's probe: a 3 s clip played 0 → 0.9 s, scrubbed to 2.2 s, played to the end. The
  // verdict said 'watch_more', the gate said "keep going to unlock your dashboard" — at the end, where
  // the only way on is to play it again — and nothing on screen said so.
  assert.deepEqual(watchVerdict({ ended: true, currentTime: 3, duration: 3, ranges: [[0, 0.9], [2.2, 3]], seeking: false }),
    { complete: false, playedPct: 56, reason: 'skipped' });
  assert.deepEqual(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 30], [50, 60]] }),
    { complete: false, playedPct: 66, reason: 'skipped' });
  // The same share mid-video is still "keep going": there is more video ahead.
  assert.equal(watchVerdict({ ended: false, currentTime: 30, duration: 60, ranges: [[0, 30], [50, 60]], seeking: false }).reason, 'watch_more');
  // Only `ended` says it: paused a moment from the end, pressing play still plays on.
  assert.equal(watchVerdict({ ended: false, currentTime: 60, duration: 60 }).reason, 'watch_more');
  assert.equal(watchVerdict({ ended: 'true', currentTime: 60, duration: 60, ranges: [[0, 6]] }).reason, 'skipped',
    'a truthy ended is ended, as it always was for the verdict');
  // Watched enough, the end is still the end.
  assert.deepEqual(watchVerdict({ ended: true, currentTime: 60, duration: 60, ranges: [[0, 60]] }),
    { complete: true, playedPct: 100, reason: 'ended' });
  // An unknown duration cannot be measured: ended finishes it, exactly as before.
  assert.equal(watchVerdict({ ended: true, currentTime: 12, duration: Infinity, ranges: [] }).reason, 'ended');
});

// ── 2b. The watch record, and the verdict that is shown (Task 8 review) ────────
//
// T8-G1: the outer Retry REMOUNTS the player (so start_onboarding_video() runs again), and a
// closed Dashboard card unmounts it — and the ranges lived inside the player, so a student 85%
// into a 10-minute video who pressed Retry was sent back to 0:00 with nothing counted.
// T8-UI-2: watchVerdict() answers for the <video> as it is NOW, so a rewind after the end
// re-locked "Go to dashboard" under a full progress bar.

test('watchRecordFor: the same video keeps its record; any other video starts afresh', () => {
  const kept = { videoId: V, ranges: [[0, 33]], position: 33 };
  assert.equal(watchRecordFor(kept, V), kept, 'the SAME object — a remounted player carries on with it');
  const other = watchRecordFor(kept, V2);
  assert.notEqual(other, kept);
  assert.deepEqual(other, { videoId: V2, ranges: [], position: 0 }, 'a replaced video starts from nothing');
  assert.deepEqual(kept, { videoId: V, ranges: [[0, 33]], position: 33 }, '…and the old record is left alone');
  for (const none of [null, undefined, 'junk', 42, []]) {
    assert.deepEqual(watchRecordFor(none, V), { videoId: V, ranges: [], position: 0 }, `no record (${JSON.stringify(none)})`);
  }
  const unmatched = { videoId: null, ranges: [[0, 9]], position: 9 };
  assert.notEqual(watchRecordFor(unmatched, null), unmatched, 'an id that cannot be matched never carries a record over');
  assert.deepEqual(watchRecordFor(unmatched, undefined).ranges, []);
});

test('the watch record carries a Retry: what was watched before and after a remount unlocks the button', () => {
  // 85% of a 600 s video, then the player is remounted (a Retry) and the student plays on.
  let rec = watchRecordFor(null, V);
  rec.ranges = mergeRanges(rec.ranges, [[0, 510]]);
  rec.position = 510;
  rec = watchRecordFor(rec, V);                              // the remounted player picks it up
  assert.equal(resumeAt(rec, V, 600), 510, 'and puts the student back where they were');
  rec.ranges = mergeRanges(rec.ranges, timeRanges([[510, 600]]));
  assert.equal(watchVerdict({ ended: true, currentTime: 600, duration: 600, ranges: rec.ranges }).complete, true);
  // The defect: a record that started over at the Retry leaves them locked out at the end.
  assert.equal(watchVerdict({ ended: true, currentTime: 600, duration: 600, ranges: [[510, 600]] }).complete, false);
});

test('resumeAt: the record’s place — never another video’s, never junk, never the end', () => {
  const rec = { videoId: V, ranges: [[0, 40]], position: 40 };
  assert.equal(resumeAt(rec, V, 60), 40);
  assert.equal(resumeAt(rec, V, NaN), 40, 'before metadata the length is unknown: the place still stands');
  assert.equal(resumeAt(rec, V, Infinity), 40, 'some recordings report Infinity');
  assert.equal(resumeAt(rec, V, undefined), 40);
  assert.equal(resumeAt(rec, V2, 60), 0, 'another video opens at the start');
  assert.equal(resumeAt(null, V, 60), 0);
  assert.equal(resumeAt(undefined, V, 60), 0);
  for (const position of [0, -3, NaN, null, '', true, undefined, Infinity]) {
    assert.equal(resumeAt({ videoId: V, position }, V, 60), 0, `no place to resume (${String(position)})`);
  }
  assert.equal(resumeAt({ videoId: V, position: '12.5' }, V, 60), 12.5, 'a numeric string is a number');
  // At the end — or within ONBOARDING_NEAR_END_SECONDS of it — a finished video opens at the start.
  assert.equal(resumeAt({ videoId: V, position: 60 }, V, 60), 0);
  assert.equal(resumeAt({ videoId: V, position: 60 - ONBOARDING_NEAR_END_SECONDS }, V, 60), 0);
  assert.equal(resumeAt({ videoId: V, position: 58 }, V, 60), 58);
  assert.equal(resumeAt({ videoId: null, position: 30 }, null, 60), 0, 'an id that cannot be matched');
});

test('holdWatchVerdict: once watched, the SAME video stays watched', () => {
  const done = { complete: true, playedPct: 100, reason: 'ended', videoId: V };
  const rewound = { complete: false, playedPct: 100, reason: 'playing', videoId: V };
  assert.equal(holdWatchVerdict(done, rewound), done,
    'a rewind after the end — or the native replay control — re-locks nothing: the SAME object, so React re-renders nothing');
  assert.equal(holdWatchVerdict(done, { complete: false, playedPct: 0, reason: 'watch_more', videoId: V }), done);
  const later = { complete: true, playedPct: 100, reason: 'near_end', videoId: V };
  assert.equal(holdWatchVerdict(done, later), later, 'a newer COMPLETE verdict always replaces it');
  const other = { complete: false, playedPct: 0, reason: 'watch_more', videoId: V2 };
  assert.equal(holdWatchVerdict(done, other), other, 'another video (the Super Admin replaced it) is not held');
  assert.equal(holdWatchVerdict(done, null), null, 'the player starting over clears it');
  assert.equal(holdWatchVerdict(done, undefined), null);
  const watching = { complete: false, playedPct: 55, reason: 'watch_more', videoId: V };
  assert.equal(holdWatchVerdict(null, watching), watching);
  assert.equal(holdWatchVerdict(watching, done), done, 'the unlock itself');
  assert.equal(holdWatchVerdict(watching, { ...watching, playedPct: 60 }).playedPct, 60, 'an unfinished verdict is simply replaced');
  // Only a literal true holds, and only when the video can be matched.
  const noId = { complete: true, playedPct: 100, reason: 'ended', videoId: null };
  assert.equal(holdWatchVerdict(noId, { ...rewound, videoId: null }).complete, false);
  assert.equal(holdWatchVerdict({ ...done, complete: 'true' }, rewound), rewound);
  assert.equal(holdWatchVerdict({ ...done, complete: 1 }, rewound), rewound);
});

// ── 3. Gate plumbing ─────────────────────────────────────────────────────────

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const WAITING = Object.freeze({ eligible: false, required: false, completed: false }); // still on the pending screen
const NEEDS = Object.freeze({ eligible: true, required: true, completed: false });

test('gettingStartedStatus: no uid → unavailable', () => {
  assert.deepEqual(gettingStartedStatus({ uid: null, enrollPass: false, fetched: null }), { status: 'unavailable', data: null });
  assert.deepEqual(gettingStartedStatus({ uid: '', enrollPass: true, fetched: { uid: '', data: NEEDS } }),
    { status: 'unavailable', data: null });
  assert.deepEqual(gettingStartedStatus(), { status: 'unavailable', data: null });
});

test('gettingStartedStatus: an answer fetched for ANOTHER account never renders', () => {
  assert.deepEqual(gettingStartedStatus({ uid: U2, enrollPass: true, fetched: { uid: U1, data: NEEDS } }),
    { status: 'loading', data: null });
  assert.deepEqual(gettingStartedStatus({ uid: U2, enrollPass: true, fetched: { uid: U1, failed: true, data: null } }),
    { status: 'loading', data: null }, 'another account’s failure is not this account’s answer either');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: null }), { status: 'loading', data: null },
    'not asked yet');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: { uid: U1, data: null } }),
    { status: 'loading', data: null }, 'in flight');
});

test('gettingStartedStatus: a failed or timed-out answer is unavailable (the gate fails open)', () => {
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, failed: true, data: null } }),
    { status: 'unavailable', data: null });
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, timedOut: true, data: null } }),
    { status: 'unavailable', data: null });
  // A re-ask that FAILS while an eligible:false answer is cached must not hold the splash
  // on the stale answer: failure wins over cached data, so the gate still fails open.
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, data: WAITING, failed: true } }),
    { status: 'unavailable', data: null });
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, data: WAITING, timedOut: true } }),
    { status: 'unavailable', data: null });
});

// ── GF-1: a failure nobody decided on ───────────────────────────────────────────────
// The first question is sent the moment the uid exists — while the student may still be on the
// pending screen, or on a lapsed term's screen. A failure that LANDS on such a HOLD decides
// nothing: no gate was waiting on it. Reading it as 'unavailable' when the approval arrived, hours
// later, failed the gate open past the video for the rest of the session. `failedBeforePass` is
// gettingStartedFailedBeforePass(phase) of the phase the failure landed in: true on a hold — or,
// for one that landed while the profile or the reads were still out (null, undecided), once they
// land on a hold (section 3b'). A failure that landed on the PASS, or was settled on the pass, was
// the gate's answer (false), and fails open at once, as before.
const FAILED_EARLY = Object.freeze({ uid: U1, data: null, failed: true, timedOut: false, failedBeforePass: true, reaskedAfterPass: false });

test('gettingStartedStatus: a failure that landed on a HOLD is asked again when the pass arrives (GF-1)', () => {
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: FAILED_EARLY }), { status: 'unavailable', data: null },
    'on the pending screen nothing is decided: there is simply no answer');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: FAILED_EARLY }), { status: 'loading', data: null },
    'the approval lands: hold the splash for the one re-ask — never the dashboard on a failure nobody decided on');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { ...FAILED_EARLY, failed: false, timedOut: true } }),
    { status: 'loading', data: null }, 'a timeout that ran out on the pending screen too');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { ...FAILED_EARLY, reaskedAfterPass: true } }),
    { status: 'unavailable', data: null }, 'the re-ask\'s own failure fails OPEN — one re-ask, never a splash that never ends');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { ...FAILED_EARLY, failedBeforePass: false } }),
    { status: 'unavailable', data: null }, 'a failure that landed while the gate was waiting IS its answer: fail open at once');
  for (const v of ['true', 1, null, undefined]) {
    assert.equal(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { ...FAILED_EARLY, failedBeforePass: v } }).status,
      'unavailable', `failedBeforePass ${JSON.stringify(v)}: only the literal true holds`);
  }
  assert.deepEqual(gettingStartedStatus({ uid: U2, enrollPass: true, fetched: FAILED_EARLY }), { status: 'loading', data: null },
    'another account\'s failure is still never this account\'s answer');
});

test('gettingStartedStatus: a database without #69 says so, and is never asked again (GF-8)', () => {
  const missing = { ...FAILED_EARLY, missing: true };
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: missing }), { status: 'unavailable', data: null, missing: true },
    'no function to call: no re-ask can ever answer, so the pass does not hold the splash for one');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: missing }), { status: 'unavailable', data: null, missing: true });
  assert.deepEqual(gettingStartedGateInput(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: missing })),
    { status: 'unavailable', required: false }, 'and the gate fails open, as it always has');
  for (const v of ['true', 1, null, undefined, false]) {
    assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: { uid: U1, data: null, failed: true, missing: v } }),
      { status: 'unavailable', data: null }, `missing ${JSON.stringify(v)}: an ordinary failure carries no such word`);
  }
  assert.deepEqual(gettingStartedStatus({ uid: U2, enrollPass: true, fetched: missing }), { status: 'loading', data: null });
});

test('gettingStartedNeedsReask: the hook asks again EXACTLY when the status holds the splash on a cached answer (GF-1)', () => {
  // A 'loading' status over a settled answer with no re-ask behind it is a splash that never ends,
  // and a re-ask under a 'ready' or 'unavailable' status is a round trip nothing waits for. So the
  // two are one rule: for every settled answer for THIS account, they agree.
  const answers = [];
  for (const data of [null, WAITING, NEEDS, { required: false }]) {
    for (const failed of [false, true]) {
      for (const timedOut of [false, true]) {
        for (const failedBeforePass of [false, true]) {
          for (const reaskedAfterPass of [false, true]) {
            for (const missing of [false, true]) {
              const settled = data !== null || failed || timedOut;
              if (settled) answers.push({ uid: U1, data, failed, timedOut, failedBeforePass, reaskedAfterPass, missing });
            }
          }
        }
      }
    }
  }
  assert.ok(answers.length > 100);
  for (const fetched of answers) {
    for (const enrollPass of [false, true]) {
      const held = gettingStartedStatus({ uid: U1, enrollPass, fetched }).status === 'loading';
      assert.equal(gettingStartedNeedsReask({ uid: U1, enrollPass, fetched }), held, JSON.stringify({ enrollPass, fetched }));
    }
  }
  // Nothing to re-ask without an answer for this account.
  assert.equal(gettingStartedNeedsReask({ uid: U1, enrollPass: true, fetched: null }), false, 'not asked yet: the first question is still out');
  assert.equal(gettingStartedNeedsReask({ uid: U1, enrollPass: true, fetched: { uid: U1, data: null } }), false, 'in flight');
  assert.equal(gettingStartedNeedsReask({ uid: U1, enrollPass: true, fetched: { ...FAILED_EARLY, uid: U2 } }), false, 'another account');
  assert.equal(gettingStartedNeedsReask({ uid: null, enrollPass: true, fetched: FAILED_EARLY }), false, 'signed out');
  assert.equal(gettingStartedNeedsReask(), false);
});

test('gettingStartedStatus: only an explicit eligible:false holds for a re-ask', () => {
  // An answer with no `eligible` fact is not a reason to hold: nothing would ever re-ask it.
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, data: { required: false } } }),
    { status: 'ready', data: { required: false } });
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, data: { eligible: null, required: false } } }),
    { status: 'ready', data: { eligible: null, required: false } });
});

test('gettingStartedStatus: a cached eligible:false is re-asked once when enrollPass turns true', () => {
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, data: WAITING } }),
    { status: 'loading', data: WAITING }, 'no re-ask yet → hold on the splash');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: { uid: U1, data: WAITING, reaskedAfterPass: true } }),
    { status: 'ready', data: WAITING }, 'after the re-ask the answer stands');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: { uid: U1, data: WAITING } }),
    { status: 'ready', data: WAITING }, 'while the membership is not live, eligible:false is simply true');
});

test('gettingStartedStatus: a cached eligible:true needs no extra round trip when enrollPass flips', () => {
  for (const enrollPass of [false, true]) {
    assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass, fetched: { uid: U1, data: NEEDS } }),
      { status: 'ready', data: NEEDS }, `enrollPass ${enrollPass}`);
  }
});

test('Review Focus 1: an approval that lands on the pending screen goes splash → Getting Started, never the dashboard', () => {
  const input = (enrollPass, fetched) => gettingStartedGateInput(gettingStartedStatus({ uid: U1, enrollPass, fetched }));
  // 1. The student waits on the pending screen, and the first answer says "not eligible".
  assert.deepEqual(input(false, { uid: U1, data: WAITING }), { status: 'ready', required: false });
  // 2. The approval lands: enrollPass flips before the re-ask returns. Not ready + not required
  //    would render the dashboard for a frame; loading holds the splash instead.
  assert.deepEqual(input(true, { uid: U1, data: WAITING }), { status: 'loading', required: false });
  // 3. The re-ask says the video is required.
  assert.deepEqual(input(true, { uid: U1, data: NEEDS, reaskedAfterPass: true }), { status: 'ready', required: true });
});

test('gettingStartedGateInput: required only for ready + a literal true', () => {
  assert.deepEqual(gettingStartedGateInput({ status: 'ready', data: { required: true } }), { status: 'ready', required: true });
  assert.deepEqual(gettingStartedGateInput({ status: 'ready', data: { required: false } }), { status: 'ready', required: false });
  for (const required of ['true', 1, null, undefined, {}]) {
    assert.equal(gettingStartedGateInput({ status: 'ready', data: { required } }).required, false, `required: ${String(required)}`);
  }
  assert.deepEqual(gettingStartedGateInput({ status: 'ready', data: null }), { status: 'ready', required: false });
  assert.deepEqual(gettingStartedGateInput({ status: 'loading', data: { required: true } }), { status: 'loading', required: false });
  assert.deepEqual(gettingStartedGateInput({ status: 'unavailable', data: { required: true } }),
    { status: 'unavailable', required: false });
  assert.deepEqual(gettingStartedGateInput(null), { status: 'unavailable', required: false });
  assert.deepEqual(gettingStartedGateInput(undefined), { status: 'unavailable', required: false });
  assert.deepEqual(gettingStartedGateInput({ status: 'bogus', data: { required: true } }),
    { status: 'unavailable', required: false }, 'an unknown status fails open — never to a splash that never ends');
});

// ── 3b. What the root hook is handed (T12-D1) ────────────────────────────────
// enrollGateState() answers from the PROFILE alone while the two enrollment reads are still in
// flight, and for a paid profile with no term loaded yet that answer is 'pass' (the grandfather
// rule). Handed that, the hook spent its ONE re-ask on a lapsed member before the reads landed,
// stamped it reaskedAfterPass, and had nothing left to ask with when a renewal approved in the same
// session made the pass real — so the stale eligible:false read as 'ready' and the gate failed open
// past the video. The root now hands it a PHASE (gettingStartedEnrollPhase(), section 3b' below) whose 'pass'
// is exactly gettingStartedEnrollPass(): a pass THIS account's profile and reads have CONFIRMED.

test('gettingStartedEnrollPass: only a SETTLED pass — the profile and the reads have landed AND they say pass (T12-D1, K3R-GATE-DIRECT-SWITCH)', () => {
  assert.equal(gettingStartedEnrollPass({ profileReady: true, ready: true, pass: true }), true);
  assert.equal(gettingStartedEnrollPass({ profileReady: true, ready: false, pass: true }), false,
    'a pass the enrollment reads have not confirmed yet is no pass');
  assert.equal(gettingStartedEnrollPass({ profileReady: false, ready: true, pass: true }), false,
    'nor one read before the profile landed — on a DIRECT account switch the profile in hand is the PREVIOUS account\'s');
  assert.equal(gettingStartedEnrollPass({ ready: true, pass: true }), false, 'no profile fact at all is no settled pass');
  assert.equal(gettingStartedEnrollPass({ profileReady: true, ready: true, pass: false }), false);
  assert.equal(gettingStartedEnrollPass({ profileReady: true, ready: false, pass: false }), false);
  for (const [profileReady, ready, pass] of [[true, 'true', true], [true, 1, true], [true, true, 'pass'], [true, true, 1], [true, undefined, true],
    [true, true, undefined], [true, null, null], ['true', true, true], [1, true, true], [null, true, true], [undefined, true, true]]) {
    assert.equal(gettingStartedEnrollPass({ profileReady, ready, pass }), false,
      `profileReady ${JSON.stringify(profileReady)}, ready ${JSON.stringify(ready)}, pass ${JSON.stringify(pass)}: only the literal booleans count`);
  }
  assert.equal(gettingStartedEnrollPass(), false);
  assert.equal(gettingStartedEnrollPass(null), false);
});

test('T12-D1: a lapsed member’s provisional pass never spends the one re-ask a same-session renewal needs', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const paid = Object.freeze({ is_paid: true });
  const lapsed = Object.freeze({ status: 'active', started_at: '2026-06-01T00:00:00Z', ends_at: '2026-08-01T00:00:00Z', grace_ends_at: '2026-08-04T00:00:00Z' });
  const renewed = Object.freeze({ status: 'active', started_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-30T00:00:00Z', grace_ends_at: '2026-12-03T00:00:00Z' });
  const state = (sub) => enrollGateState({ profile: paid, latestReq: null, sub }, now);
  // The hazard, as it really is.
  assert.equal(state(null), 'pass', 'reads in flight: a paid profile with no term loaded IS "pass" (the grandfather rule)');
  assert.equal(state(lapsed), 'expired');
  assert.equal(state(renewed), 'pass');

  // The hook's re-ask rule, on what it is handed (gettingStartedStatus()'s documented contract).
  const reasks = (pass, fetched) => pass === true && fetched.data?.eligible === false && !fetched.reaskedAfterPass;
  const first = Object.freeze({ uid: U1, data: WAITING, reaskedAfterPass: false });   // a lapsed member is not eligible

  // 1. The reads are in flight. Handed the settled pass, there is nothing to re-ask…
  const inFlight = gettingStartedEnrollPass({ profileReady: true, ready: false, pass: state(null) === 'pass' });
  assert.equal(inFlight, false);
  assert.equal(reasks(inFlight, first), false, 'no re-ask on a pass nobody has confirmed');
  assert.equal(reasks(state(null) === 'pass', first), true, '…where the raw state spent it (the defect)');
  // 2. The reads land: the term ended. Still nothing to ask.
  assert.equal(gettingStartedEnrollPass({ profileReady: true, ready: true, pass: state(lapsed) === 'pass' }), false);
  // 3. A renewal is approved in the same session: a REAL pass, and the re-ask is still there.
  const live = gettingStartedEnrollPass({ profileReady: true, ready: true, pass: state(renewed) === 'pass' });
  assert.equal(live, true);
  assert.equal(reasks(live, first), true);
  assert.deepEqual(gettingStartedGateInput(gettingStartedStatus({ uid: U1, enrollPass: live, fetched: first })),
    { status: 'loading', required: false }, 'the cached eligible:false holds the splash until the re-ask lands');
  assert.deepEqual(gettingStartedGateInput(gettingStartedStatus({ uid: U1, enrollPass: live, fetched: { uid: U1, data: NEEDS, reaskedAfterPass: true } })),
    { status: 'ready', required: true }, '…and its answer decides: Getting Started, never the dashboard');
});

// ── 3b'. The enrollment PHASE, and what a failure means by where it lands (V-GF1-DOUBLE-BOUND) ──
// Handed a boolean pass, the hook could not tell "the enrollment reads are still out" from "the
// student is held". So a first answer that FAILED before the reads landed — at sign-in, where the
// question is sent the moment the uid exists — was read as one nobody had decided on, and re-asked
// when the reads landed on a pass: a second 7 s on the splash (14.4 s, measured in Chrome), where the
// plan promised one bound, counted from the uid. The root now hands the hook a PHASE.

test('gettingStartedEnrollPhase: pass only when SETTLED, hold only once the profile AND the reads have landed (V-GF1-DOUBLE-BOUND)', () => {
  assert.equal(gettingStartedEnrollPhase({ profileReady: true, ready: true, pass: true }), 'pass');
  assert.equal(gettingStartedEnrollPhase({ profileReady: true, ready: true, pass: false }), 'hold',
    'settled and not passing: a hold screen, where nothing waits on the Getting Started answer');
  assert.equal(gettingStartedEnrollPhase({ profileReady: true, ready: false, pass: false }), 'unknown', 'the enrollment reads are still out');
  assert.equal(gettingStartedEnrollPhase({ profileReady: true, ready: false, pass: true }), 'unknown',
    'a pass the reads have not confirmed is no pass (T12-D1) — and no hold either');
  assert.equal(gettingStartedEnrollPhase({ profileReady: false, ready: true, pass: false }), 'unknown',
    'useEnrollmentGate reports ready while it is INACTIVE, and it is inactive until the profile has loaded: not a hold');
  // ★ K3R-GATE-DIRECT-SWITCH: a pass needs the PROFILE too. On a direct account switch the profile in hand
  //   until the new one lands is the PREVIOUS account's, and the enrollment gate is inactive, so "ready": a
  //   pass read off it was handed over as the new account's, and its first question went out stamped
  //   reaskedAfterPass — the re-ask a same-session approval needs, spent before it existed.
  assert.equal(gettingStartedEnrollPhase({ profileReady: false, ready: true, pass: true }), 'unknown',
    'a pass read before THIS account\'s profile landed is no pass — and no hold either');
  // 'pass' is exactly the settled pass gettingStartedEnrollPass() means — the profile and the reads landed.
  for (const profileReady of [true, false, undefined, 'true', 1, null]) {
    for (const ready of [true, false, 'true', 1, undefined, null]) {
      for (const pass of [true, false, 'pass', 1, undefined, null]) {
        assert.equal(gettingStartedEnrollPhase({ profileReady, ready, pass }) === 'pass', gettingStartedEnrollPass({ profileReady, ready, pass }),
          JSON.stringify({ profileReady, ready, pass }));
        if (profileReady !== true) {
          assert.equal(gettingStartedEnrollPhase({ profileReady, ready, pass }), 'unknown',
            `${JSON.stringify({ profileReady, ready, pass })}: nothing is settled before the profile`);
        }
      }
    }
  }
  // Only the literal booleans make a hold.
  for (const [profileReady, ready] of [['true', true], [1, true], [undefined, true], [null, true], [true, 'true'], [true, 1], [true, undefined]]) {
    assert.equal(gettingStartedEnrollPhase({ profileReady, ready, pass: false }), 'unknown',
      `profileReady ${JSON.stringify(profileReady)}, ready ${JSON.stringify(ready)}`);
  }
  assert.equal(gettingStartedEnrollPhase(), 'unknown');
  assert.equal(gettingStartedEnrollPhase(null), 'unknown');
});

test('gettingStartedFailedBeforePass: a hold decided nothing, the pass decided, and loading has not decided YET (GF-1, V-GF1-DOUBLE-BOUND)', () => {
  assert.equal(gettingStartedFailedBeforePass('hold'), true, 'nobody waited on it: the pass asks again');
  assert.equal(gettingStartedFailedBeforePass('pass'), false, 'the gate waited on it: it fails open');
  for (const phase of ['unknown', undefined, null, '', 'HOLD', 'Pass', true, false, 1, {}]) {
    assert.equal(gettingStartedFailedBeforePass(phase), null, `${JSON.stringify(phase)}: not decided yet`);
  }
});

test('V-GF1-DOUBLE-BOUND: a failure that landed while the reads were out is decided by where they land — a pass fails open in one bound, a hold is asked again', () => {
  const landed = (phase) => Object.freeze({
    uid: U1, data: null, failed: true, timedOut: false, reaskedAfterPass: false, failedBeforePass: gettingStartedFailedBeforePass(phase),
  });
  // The hook's settling rule, as its docblock states it: an undecided failure takes the FIRST settled phase.
  const settle = (fetched, phase) => (fetched.failedBeforePass === null && gettingStartedFailedBeforePass(phase) !== null
    ? { ...fetched, failedBeforePass: gettingStartedFailedBeforePass(phase) } : fetched);
  // At sign-in the reads land on a PASS: the failure is the gate's answer.
  const early = landed('unknown');
  assert.equal(early.failedBeforePass, null);
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: early }), { status: 'unavailable', data: null },
    'the very render the reads land in fails open — before anything has settled the failure');
  assert.equal(gettingStartedNeedsReask({ uid: U1, enrollPass: true, fetched: early }), false, 'no re-ask: never a second 7 s');
  const decided = settle(early, 'pass');
  assert.equal(decided.failedBeforePass, false);
  assert.equal(settle(decided, 'hold').failedBeforePass, false, 'decided by the pass, it stays decided');
  // The reads land on a HOLD — the pending screen: nobody decided on it, so the approval asks again (GF-1).
  const held = settle(early, 'hold');
  assert.equal(held.failedBeforePass, true);
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: held }), { status: 'unavailable', data: null },
    'on the hold itself nothing is decided either way');
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: true, fetched: held }), { status: 'loading', data: null });
  assert.equal(gettingStartedNeedsReask({ uid: U1, enrollPass: true, fetched: held }), true);
  // While the reads are still out, nothing settles it, and it holds nothing.
  assert.equal(settle(early, 'unknown').failedBeforePass, null);
  assert.deepEqual(gettingStartedStatus({ uid: U1, enrollPass: false, fetched: early }), { status: 'unavailable', data: null });
  // A failure that landed ON a hold, or on the pass, is decided at once.
  assert.equal(landed('hold').failedBeforePass, true);
  assert.equal(landed('pass').failedBeforePass, false);
});

// ── 3c. What the student is told (S3, GF-5, S6) ──────────────────────────────────

test('gettingStartedGiveUpCopy: "on this device" only for a decode failure — the server\'s refusals and a slow load say what happened (S3, GF-5)', () => {
  // The panel said "isn't playing on this device right now" for every reason — a refused signature,
  // a failed start, the video unpublished mid-session — and sent students to try another device that
  // would fail the same way.
  assert.equal(gettingStartedGiveUpCopy('decode'), 'The video isn’t playing on this device right now.');
  for (const reason of ['sign', 'start', 'missing', 'already-retried', 'aborted', 'none', 'other', '', null, undefined, 42, {}, 'DECODE']) {
    assert.equal(gettingStartedGiveUpCopy(reason), 'The video isn’t playing right now.', JSON.stringify(reason));
  }
  assert.equal(gettingStartedGiveUpCopy('slow'), 'The video is taking too long to load.');
  assert.equal(gettingStartedGiveUpCopy('ONBOARDING_VIDEO_UNAVAILABLE'), 'The Getting Started video isn’t available right now.');
  assert.equal(gettingStartedGiveUpCopy('ONBOARDING_VIDEO_NOT_ELIGIBLE'), 'The Getting Started video isn’t available on your account right now.');
  for (const reason of ['sign', 'start', 'slow', 'ONBOARDING_VIDEO_UNAVAILABLE', 'ONBOARDING_VIDEO_NOT_ELIGIBLE', 'missing']) {
    assert.ok(!/device/.test(gettingStartedGiveUpCopy(reason)), `${reason} is not a fact about the student's device`);
  }
});

test('gettingStartedStanding: ONE derivation for the card\'s chip and the page\'s line (S6)', () => {
  // The card said "Not finished" beside "Replay" to a student the page told "You finished an earlier
  // version", and put a permanent "Not finished" on the Dashboard of every member who was never asked.
  assert.equal(gettingStartedStanding({ completed: true, completed_current: true }), 'completed');
  assert.equal(gettingStartedStanding({ completed: false, completed_current: true }), 'completed', 'the current version is what counts');
  assert.equal(gettingStartedStanding({ completed: true, completed_current: false, required: false }), 'earlier');
  assert.equal(gettingStartedStanding({ completed: false, completed_current: false, required: true }), 'owed',
    'asked to watch it and has not: the only standing that is a to-do');
  assert.equal(gettingStartedStanding({ completed: false, completed_current: false, required: false }), 'optional',
    'never asked (approved before the first publish): nothing is owed');
  for (const junk of [null, undefined, {}, { completed: 'true', completed_current: 1, required: 'true' }]) {
    assert.equal(gettingStartedStanding(junk), 'optional', `${JSON.stringify(junk)}: only the literal booleans count`);
  }
});

// ── 4. Problem codes ─────────────────────────────────────────────────────────

test('onboardingProblemCode maps every player failure to a stored code, and anything else to other', () => {
  assert.equal(onboardingProblemCode('sign'), 'sign');
  assert.equal(onboardingProblemCode('decode'), 'decode');
  assert.equal(onboardingProblemCode('missing'), 'missing');
  for (const r of ['already-retried', 'network', 'source-unavailable', 'aborted']) {
    assert.equal(onboardingProblemCode(r), 'playback', r);
  }
  for (const c of ONBOARDING_PROBLEM_CODES) assert.equal(onboardingProblemCode(c), c, 'a code maps to itself');
  // 'constructor' & co. are the trap in a plain-object lookup table: they are inherited keys.
  for (const r of ['none', 'nonsense', '', ' ', null, undefined, 42, {}, 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(onboardingProblemCode(r), 'other', String(r));
  }
});

test('onboardingProblemCode follows the reasons shouldResignPlayback actually returns', () => {
  // Every MediaError path that ENDS in the error state (resign:false) must land on a specific
  // code. This is the drift guard against a reason renamed in courseVideo.js.
  const code = (c, attempt) => {
    const d = shouldResignPlayback({ code: c, attempt });
    return d.resign ? null : onboardingProblemCode(d.reason);
  };
  assert.equal(code(3, 0), 'decode', 'MEDIA_ERR_DECODE — the one a Super Admin can act on');
  assert.equal(code(1, 0), 'playback', 'MEDIA_ERR_ABORTED');
  assert.equal(code(2, 1), 'playback', 'a network error after the one re-sign');
  assert.equal(code(4, 1), 'playback', 'a source error after the one re-sign');
  assert.equal(code(2, 0), null, 'the first network error re-signs instead of failing');
});

// ── 5. Super Admin copy ──────────────────────────────────────────────────────

const liveRow = (over = {}) => ({
  id: V, status: 'published', title: 'Welcome', media_present: true, problems_7d: 0, duration_seconds: 272, ...over,
});
const facts = (liveOver = {}) => ({
  live_video_id: V,
  versions: [liveRow(liveOver), { id: V2, status: 'draft', media_present: true, problems_7d: 0, duration_seconds: null }],
  required_since: '2026-09-30T02:15:00.123456+00:00',
  counts: { completed_students: 40, pending_students: 3, active_members: 250 },
});

test('onboardingHealth: facts in, one verdict out', () => {
  const cases = [
    [{ live_video_id: null, versions: [{ id: V2, status: 'draft', media_present: true }], required_since: null, counts: {} },
      'none_live', 'info'],
    [facts({ media_present: false }), 'file_missing', 'danger'],
    [facts({ problems_7d: 3 }), 'playback_problems', 'warn'],
    [facts({ duration_seconds: null }), 'unverified', 'warn'],
    [facts(), 'ok', 'ok'],
  ];
  for (const [overview, code, level] of cases) {
    const h = onboardingHealth(overview);
    assert.equal(h.code, code);
    assert.equal(h.level, level, code);
    assert.deepEqual(Object.keys(h).sort(), ['body', 'code', 'level', 'title']);
    assert.ok(h.title.trim() && h.body.trim(), `${code} has copy`);
    assert.doesNotMatch(`${h.title} ${h.body}`, /all students|every student|undefined|NaN/i);
  }
});

test('onboardingHealth: the worst fact wins', () => {
  assert.equal(onboardingHealth(facts({ media_present: false, problems_7d: 5, duration_seconds: null })).code, 'file_missing');
  assert.equal(onboardingHealth(facts({ problems_7d: 5, duration_seconds: null })).code, 'playback_problems');
});

test('onboardingHealth reads only the LIVE version', () => {
  const overview = facts();
  overview.versions.push({ id: V3, status: 'retired', media_present: false, problems_7d: 9, duration_seconds: null });
  assert.equal(onboardingHealth(overview).code, 'ok', 'a retired version’s missing file and old reports are history');
  // …wherever the live row sits in the list: the lookup is by id, never "the first row".
  const retiredFirst = facts();
  retiredFirst.versions.unshift({ id: V3, status: 'retired', media_present: false, problems_7d: 9, duration_seconds: null });
  assert.equal(onboardingHealth(retiredFirst).code, 'ok', 'a retired row listed BEFORE the live one is still ignored');
});

test('onboardingHealth: only an explicit media_present:false means the file is missing', () => {
  const overview = facts();
  delete overview.versions[0].media_present;
  assert.notEqual(onboardingHealth(overview).code, 'file_missing', 'a missing fact is not evidence of a missing file');
});

test('onboardingHealth: counts may arrive as strings', () => {
  const one = onboardingHealth(facts({ problems_7d: '1' }));
  assert.equal(one.code, 'playback_problems');
  assert.match(one.body, /\b1 student\b/);
  assert.doesNotMatch(one.body, /\b1 students\b/);
  assert.match(onboardingHealth(facts({ problems_7d: 12 })).body, /\b12 students\b/);
  assert.equal(onboardingHealth(facts({ duration_seconds: '272.00' })).code, 'ok', 'numeric(8,2) as a string');
});

test('onboardingHealth: an overview that did not load is "unknown", never "nothing is live"', () => {
  // A failed load (a transient RPC error, a pre-#69 database) is not a fact about the
  // video. Reading it as 'none_live' would raise the admin badge for the wrong reason.
  for (const nothing of [null, undefined, {}, { versions: [] }, 'x', 42]) {
    const h = onboardingHealth(nothing);
    assert.equal(h.code, 'unknown', JSON.stringify(nothing));
    assert.equal(h.level, 'warn');
    assert.match(h.title, /couldn’t check/i);
  }
  // …while a loaded overview that says so is the real 'none_live'.
  assert.equal(onboardingHealth({ live_video_id: null, versions: [], required_since: null, counts: {} }).code, 'none_live');
});

const T_NEW = { id: V2, title: 'Welcome to Toolkits' };
const T_OLD = { id: V, title: 'Old welcome' };
const COUNTS = { completed_students: 40, pending_students: 3, active_members: 1250 };

test('publishImpact: the first publish names the cutoff date and the current members', () => {
  // 17:30 UTC on 29 September is 01:30 on the 30th in Manila — the day the cutoff lands on.
  const r = publishImpact({ live: null, target: T_NEW, counts: COUNTS, requiredSince: null, now: Date.UTC(2026, 8, 29, 17, 30) });
  assert.match(r.title, /Welcome to Toolkits/);
  assert.match(r.body, /from September 30, 2026/);
  // "From now on", not "from {day} onward": the rule is the publish MOMENT, so a student
  // approved earlier that same Manila day is an existing member and is not asked.
  assert.match(r.body, /New students approved from now on \(from September 30, 2026\)/);
  assert.match(r.body, /1,250 current members/);
  assert.match(r.body, /permanent/i, 'the cutoff never moves');
  assert.match(r.body, /Preview/, 'so a trial publish is the wrong tool');
});

test('publishImpact: a replace names who is still waiting and who already finished', () => {
  const r = publishImpact({ live: T_OLD, target: T_NEW, counts: COUNTS, requiredSince: '2026-09-01T02:00:00+00:00' });
  assert.match(r.title, /^Replace/);
  assert.match(r.body, /Old welcome/);
  assert.match(r.body, /Welcome to Toolkits/);
  assert.match(r.body, /\b3 students who haven’t finished/);
  assert.match(r.body, /\b40 students who already finished/);
});

test('publishImpact: publishing again after an unpublish names the cutoff that still stands', () => {
  const r = publishImpact({ live: null, target: T_NEW, counts: COUNTS, requiredSince: '2026-09-01T02:00:00+00:00' });
  assert.match(r.body, /September 1, 2026/);
  assert.match(r.body, /next time they open the toolkit/);
  assert.match(r.body, /\b40 students who already finished/);
  assert.doesNotMatch(r.body, /permanent/i, 'the first publish fixed the cutoff, not this one');
});

test('publishImpact: publishing again says "since the first publish" — the cutoff is a moment, not a day (T9UI-13)', () => {
  // The SQL compares a student's first subscription with min(published_at), a timestamptz. "Joined
  // on or after September 1" told the Super Admin that a student approved at 08:00 that day would
  // be asked, when the 09:30 publish had already passed them by — the first-publish case was
  // corrected the same way (T1-D6).
  const r = publishImpact({ live: null, target: T_NEW, counts: COUNTS, requiredSince: '2026-09-01T02:00:00+00:00' });
  assert.match(r.body, /Students approved since the first publish \(September 1, 2026\) who haven’t finished a Getting Started video/);
  assert.match(r.body, /Members approved before the first publish aren’t asked, but can replay it from Getting Started\./);
  assert.doesNotMatch(r.body, /on or after|joined/i, 'a calendar day promises the whole day, and the cutoff is a moment');
  const undated = publishImpact({ live: null, target: T_NEW, counts: COUNTS, requiredSince: 'not a date' });
  assert.match(undated.body, /Students approved since the first publish who haven’t finished/, 'no date to name: the moment is still the rule');
  assert.doesNotMatch(undated.body, /\(\)|first publish date/);
});

test('publishImpact reads the cutoff as a MANILA calendar day', () => {
  const at = (requiredSince) => publishImpact({ live: null, target: T_NEW, counts: COUNTS, requiredSince }).body;
  assert.match(at('2026-09-29T16:00:00Z'), /September 30, 2026/, 'midnight in Manila is still the 29th in UTC');
  assert.match(at('2026-09-29T15:59:59.999999+00:00'), /September 29, 2026/);
  assert.match(at('2026-09-30'), /September 30, 2026/, 'a bare date is taken as given');
});

test('publishImpact: singular counts, nobody waiting, a missing title, and the video already live', () => {
  const one = publishImpact({ live: T_OLD, target: T_NEW, counts: { completed_students: 1, pending_students: 1, active_members: 1 },
    requiredSince: '2026-09-01' });
  assert.match(one.body, /\b1 student who hasn’t finished/);
  assert.match(one.body, /\b1 student who already finished/);
  const firstOne = publishImpact({ live: null, target: T_NEW, counts: { active_members: 1 }, requiredSince: null, now: Date.UTC(2026, 8, 30) });
  assert.match(firstOne.body, /\b1 current member\b/);
  const nobody = publishImpact({ live: T_OLD, target: T_NEW, counts: { completed_students: 0, pending_students: 0 }, requiredSince: '2026-09-01' });
  assert.match(nobody.body, /No student is waiting/);
  assert.match(publishImpact({ live: null, target: { id: V2, title: '  ' }, counts: COUNTS, requiredSince: null }).title, /this video/);
  assert.match(publishImpact({ live: T_OLD, target: { ...T_OLD }, counts: COUNTS, requiredSince: '2026-09-01' }).title, /already live/i);
});

test('publishImpact never says "all students", and never prints a missing number', () => {
  const variants = [
    { live: null, target: T_NEW, counts: COUNTS, requiredSince: null, now: Date.UTC(2026, 8, 30) },
    { live: T_OLD, target: T_NEW, counts: COUNTS, requiredSince: '2026-09-01' },
    { live: null, target: T_NEW, counts: COUNTS, requiredSince: '2026-09-01' },
    { live: null, target: {}, counts: null, requiredSince: null },
    { live: T_OLD, target: { id: V2 }, counts: {}, requiredSince: 'not a date' },
    { live: null, target: null, counts: { active_members: 'x' }, requiredSince: 'not a date' },
    { live: null, target: T_NEW, counts: COUNTS, requiredSince: null, now: NaN },
    { live: T_OLD, target: T_NEW, counts: { completed_students: 0, pending_students: 0, active_members: 0 }, requiredSince: '2026-09-01' },
  ];
  for (const v of variants) {
    const { title, body } = publishImpact(v);
    const text = `${title} ${body}`;
    assert.doesNotMatch(text, /all students|every student/i, JSON.stringify(v));
    assert.doesNotMatch(text, /undefined|NaN|null|\[object/, JSON.stringify(v));
    assert.doesNotMatch(text, /\b0 (students?|current members?)\b/, `a zero count is a sentence, not "0 students": ${JSON.stringify(v)}`);
    assert.ok(title.trim() && body.trim());
  }
  assert.doesNotThrow(() => publishImpact());
});

test('formatVideoDuration: m:ss under an hour, h:mm:ss over it, blank when unknown', () => {
  assert.equal(formatVideoDuration(272), '4:32');
  assert.equal(formatVideoDuration(3725), '1:02:05');
  assert.equal(formatVideoDuration(null), '');
  assert.equal(formatVideoDuration(59), '0:59');
  assert.equal(formatVideoDuration(60), '1:00');
  assert.equal(formatVideoDuration(3600), '1:00:00');
  assert.equal(formatVideoDuration(272.4), '4:32');
  assert.equal(formatVideoDuration('272.00'), '4:32', 'numeric(8,2) may arrive as a string');
  assert.equal(formatVideoDuration(0.3), '0:01', 'a real clip never reads 0:00');
  for (const v of [undefined, 0, -5, NaN, Infinity, '', 'abc', true, {}]) {
    assert.equal(formatVideoDuration(v), '', String(v));
  }
});
