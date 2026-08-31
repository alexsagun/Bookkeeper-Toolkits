// test/studentProgress.test.mjs — the client half of Progress & Rankings (#52).
//
// This suite is deliberately short. src/lib/studentProgress.js owns only the track
// table, the scope list and the scope filter; every score, rank and label is computed
// in SQL and rendered as received. There is nothing else here to unit-test, and the
// version of this file that tested nine more exports was testing code no caller ever
// reached — see the header of the module for why those were deleted.
//
// The SQL-parity assertions (weights and scope keys against both SQL files) live in
// test/studentProgressSql.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STUDENT_PROGRESS_TRACKS,
  LEADERBOARD_SCOPES,
  progressScopeOptions,
} from '../src/lib/studentProgress.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = () => readFileSync(join(ROOT, 'src/BookkeeperPro.jsx'), 'utf8');

test('the four tracks carry the product weights and sum to 100', () => {
  assert.deepEqual(
    STUDENT_PROGRESS_TRACKS.map((track) => [track.key, track.weight]),
    [['foundation', 20], ['qbo', 40], ['profile', 20], ['interview', 20]],
  );
  const total = STUDENT_PROGRESS_TRACKS.reduce((sum, track) => sum + track.weight, 0);
  assert.equal(total, 100, 'the unrenormalised weights must total 100');
});

test('every track and scope is frozen so a render cannot mutate the catalog', () => {
  assert.ok(Object.isFrozen(STUDENT_PROGRESS_TRACKS));
  assert.ok(STUDENT_PROGRESS_TRACKS.every((track) => Object.isFrozen(track)));
  assert.ok(Object.isFrozen(LEADERBOARD_SCOPES));
});

test('My Batch is offered only to a VIP who currently holds a seat', () => {
  const keys = (options) => options.map((option) => option.key);

  assert.ok(keys(progressScopeOptions({ planKey: 'vip', hasCurrentBatch: true })).includes('my_batch'));
  assert.ok(!keys(progressScopeOptions({ planKey: 'vip', hasCurrentBatch: false })).includes('my_batch'),
    'a VIP between cohorts has no batch board to open');
  assert.ok(!keys(progressScopeOptions({ planKey: 'silver_self_paced', hasCurrentBatch: true })).includes('my_batch'),
    'a non-VIP never gets My Batch, whatever batch state is passed');
  assert.ok(!keys(progressScopeOptions()).includes('my_batch'),
    'no arguments must not widen the option list');
});

test('a learner is offered their own segment board and never the other one', () => {
  // #53 made this a server rule: the VIP board is the set of VIP members and General is
  // its complement, so either one discloses the plan the row shape omits. The UI must
  // not render a tab whose only outcome is a refusal.
  const keys = (options) => options.map((option) => option.key);

  assert.deepEqual(keys(progressScopeOptions({ planKey: 'sampler' })),
    ['my_plan', 'general', 'all'], 'a non-VIP gets General, never the VIP board');
  assert.deepEqual(keys(progressScopeOptions({ planKey: 'silver_self_paced' })),
    ['my_plan', 'general', 'all']);
  assert.deepEqual(keys(progressScopeOptions({ planKey: 'vip', hasCurrentBatch: true })),
    ['my_plan', 'vip', 'my_batch', 'all'], 'a VIP gets the VIP board, never General');
  assert.deepEqual(keys(progressScopeOptions({ planKey: 'vip', hasCurrentBatch: false })),
    ['my_plan', 'vip', 'all']);

  // An unknown or missing plan must fail toward the LESS revealing side.
  assert.ok(!keys(progressScopeOptions({ planKey: null })).includes('vip'));
  assert.ok(!keys(progressScopeOptions({ planKey: 'not_a_plan' })).includes('vip'));
});

// ---------------------------------------------------------------------------
// Source scans. Two client-side rules cannot be expressed as unit tests because
// the thing being forbidden is a call site, not a return value.
// ---------------------------------------------------------------------------

test('no leaderboard row is relabelled client-side', () => {
  // SQL builds the anonymous label with hashtextextended(), which dependency-free JS
  // cannot reproduce — so a client-side label would disagree with the server for the
  // same learner. The server owns it; every row renders learner_label verbatim.
  const source = app();
  assert.match(source, /row\.learner_label/,
    'the leaderboard must render the server-supplied label');
  assert.ok(!/publicLearnerLabel/.test(source),
    'no client-side label derivation may return to BookkeeperPro.jsx');
});

test('a null weekly gain renders as unmeasured, never as zero', () => {
  // The server returns NULL when a learner has no 7-14 day baseline. Formatting that
  // through `|| 0` prints "0.0 pts", which claims a measured week of no progress —
  // the exact fabrication the SQL fix removed. Catch the idiom in the source.
  const source = app();
  assert.ok(!/weekly_gain\s*\|\|\s*0/.test(source),
    'weekly_gain must not be coalesced to 0 — an unmeasured week renders as an em dash');
  // Both render sites must decide on null BEFORE formatting. Pinned positively rather
  // than by forbidding .toFixed(), because formatting inside a guarded else branch is
  // exactly what correct code looks like.
  assert.match(source, /row\.weekly_gain !== null/,
    'the leaderboard row must distinguish an unmeasured week from a zero-point week');
  assert.match(source, /summary\.weekly_gain === null/,
    'the private summary card must distinguish an unmeasured week from a zero-point week');
});

test('the setup card is not triggered by a function name', () => {
  // The bug this pins never lived in src/lib/appErrors.js — isMigrationMissing() is a
  // one-line code check. It lived HERE: the progress tab widened it with a name regex,
  // so "permission denied for function my_student_progress" (a missing GRANT, or a
  // staff account with no enrolment) rendered as "migration #52 is not applied" and
  // sent an admin to re-run SQL that had already run. The classifier's own suite
  // cannot catch that; only a source scan can.
  const source = app();
  // Precisely: no regex literal naming our own functions may be matched against error
  // text. Deliberately not a blanket ban on `isMigrationMissing(...) ||` — other
  // features legitimately combine it with a second structured signal (see the staff
  // setup check); what was wrong here was pattern-matching the message.
  assert.ok(!/\/[^/\n]*student_(progress|leaderboard)[^/\n]*\/\s*\.test\(/.test(source),
    'the setup card must not be driven by matching our own function names in error text: '
    + '"permission denied for function my_student_progress" is a missing GRANT, not a '
    + 'missing migration, and telling an admin to re-run applied SQL wastes their evening');
  assert.match(source, /isMigrationMissing\(error\)\) \{ setSetupMissing\(true\)/,
    'the setup card is driven by the shared classifier');
});

test('lesson and milestone completion go through the validated RPCs', () => {
  // #52 revoked insert/update/delete on these tables from `authenticated`; a direct
  // .from(...).upsert() now fails silently at the RLS boundary rather than recording
  // a completion. The RPCs are the only write path.
  const source = app();
  for (const table of ['lesson_progress', 'course_completions', 'feature_video_completions']) {
    const direct = new RegExp(`from\\(['"]${table}['"]\\)\\s*\\.\\s*(insert|update|upsert|delete)`);
    assert.ok(!direct.test(source),
      `${table} is no longer client-writable — use the server-validated RPC instead`);
  }
  assert.match(source, /rpc\(['"]complete_course_lesson['"]/);
  assert.match(source, /rpc\(['"]set_foundation_milestone['"]/);
  assert.match(source, /rpc\(['"]complete_progress_feature_guide['"]/);
});
