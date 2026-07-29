// test/lmsSchedule.test.mjs — cohort drip, live sessions, submission locks (#37/#38).
//
// The drip cases encode a correction that cost a real defect: an offset with no
// cohort start date must fail CLOSED. The only batch in production has
// starts_on = null, so the naive reading ("no anchor, so no delay") would have
// unlocked every dripped lesson on day one.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canJoinSession,
  effectiveRelease,
  effectiveReleaseAt,
  isReleased,
  nextReleaseAfter,
  releaseLabel,
  sessionState,
  submissionEditable,
  submissionLockReason,
} from '../src/lib/lmsSchedule.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// ── Drip ─────────────────────────────────────────────────────────────────────

test('no rule at all means the lesson is simply available', () => {
  const r = effectiveRelease({});
  assert.equal(r.undrippable, true);
  assert.equal(r.unknown, false);
  assert.equal(isReleased({}, NOW), true);
  assert.equal(releaseLabel({}, NOW), null, 'and no lock chip is rendered');
});

test('an absolute release date wins over everything', () => {
  const rule = { releaseAt: iso(NOW - DAY), offsetDays: 90, startsOn: '2026-08-01' };
  assert.equal(isReleased(rule, NOW), true);
  assert.equal(effectiveReleaseAt(rule), iso(NOW - DAY));
});

test('an offset counts from the cohort start date', () => {
  const rule = { offsetDays: 14, startsOn: '2026-08-01' };
  const expected = Date.parse('2026-08-01T00:00:00Z') + 14 * DAY;
  assert.equal(effectiveRelease(rule).at, expected);
  assert.equal(isReleased(rule, expected - 1), false);
  assert.equal(isReleased(rule, expected), true, 'released exactly at the boundary');
});

test('★ an offset with NO cohort start date fails CLOSED', () => {
  // starts_on is null on the only live batch. Treating "no anchor" as "no delay"
  // would have unlocked the whole curriculum on the first day.
  const rule = { offsetDays: 14, startsOn: null };
  const r = effectiveRelease(rule);
  assert.equal(r.unknown, true);
  assert.equal(r.at, null);
  assert.equal(isReleased(rule, NOW), false, 'locked, not open');
  assert.equal(releaseLabel(rule, NOW), 'Unlocks when your cohort starts');
});

test('offset 0 releases at the cohort start, not immediately', () => {
  const rule = { offsetDays: 0, startsOn: '2026-09-01' };
  assert.equal(isReleased(rule, Date.parse('2026-08-31T23:59:59Z')), false);
  assert.equal(isReleased(rule, Date.parse('2026-09-01T00:00:00Z')), true);
});

test('a malformed date is treated as missing, not as epoch zero', () => {
  assert.equal(effectiveRelease({ releaseAt: 'not-a-date', offsetDays: 7, startsOn: '2026-08-01' }).at,
    Date.parse('2026-08-01T00:00:00Z') + 7 * DAY, 'falls through to the offset');
  assert.equal(isReleased({ offsetDays: 7, startsOn: 'garbage' }, NOW), false, 'and fails closed');
});

test('releaseLabel says when, and disappears once released', () => {
  const future = { releaseAt: iso(NOW + 3 * DAY) };
  assert.match(releaseLabel(future, NOW), /^Unlocks /);
  assert.equal(releaseLabel({ releaseAt: iso(NOW - DAY) }, NOW), null);
});

test('nextReleaseAfter finds the soonest pending unlock only', () => {
  const rules = [
    { releaseAt: iso(NOW - DAY) },        // already out
    { releaseAt: iso(NOW + 10 * DAY) },
    { releaseAt: iso(NOW + 2 * DAY) },    // the answer
    { offsetDays: 5, startsOn: null },    // unknowable — must not win
    {},                                   // undripped
  ];
  assert.equal(nextReleaseAfter(rules, NOW), NOW + 2 * DAY);
  assert.equal(nextReleaseAfter([], NOW), null);
  assert.equal(nextReleaseAfter([{ releaseAt: iso(NOW - DAY) }], NOW), null);
});

// ── Live sessions ────────────────────────────────────────────────────────────

test('sessionState covers the whole lifecycle', () => {
  const base = { starts_at: iso(NOW), ends_at: iso(NOW + 2 * 3600 * 1000), status: 'scheduled' };
  assert.equal(sessionState(base, NOW - 3600 * 1000), 'upcoming');
  assert.equal(sessionState(base, NOW), 'live');
  assert.equal(sessionState(base, NOW + 3600 * 1000), 'live');
  assert.equal(sessionState(base, NOW + 3 * 3600 * 1000), 'ended');
  assert.equal(sessionState({ ...base, status: 'cancelled' }, NOW), 'cancelled');
  assert.equal(sessionState(null, NOW), 'unknown');
  assert.equal(sessionState({ starts_at: null }, NOW), 'unknown');
});

test('a session with no end time is assumed to last an hour', () => {
  const s = { starts_at: iso(NOW), ends_at: null, status: 'scheduled' };
  assert.equal(sessionState(s, NOW + 30 * 60 * 1000), 'live');
  assert.equal(sessionState(s, NOW + 90 * 60 * 1000), 'ended',
    'so the join link stops being offered on its own');
});

test('the join link appears shortly before the call, not all week', () => {
  const s = { starts_at: iso(NOW + 60 * 60 * 1000), status: 'scheduled' };
  assert.equal(canJoinSession(s, NOW), false, 'an hour out: not yet');
  assert.equal(canJoinSession(s, NOW + 50 * 60 * 1000), true, 'ten minutes out: yes');
  assert.equal(canJoinSession({ ...s, status: 'cancelled' }, NOW + 55 * 60 * 1000), false);
  assert.equal(canJoinSession({ starts_at: iso(NOW - 5 * DAY), ends_at: iso(NOW - 5 * DAY + 3600000) }, NOW),
    false, 'and never after it ended');
});

// ── Assignment submissions ───────────────────────────────────────────────────

const assignment = (over = {}) => ({ published: true, due_at: iso(NOW + 7 * DAY), ...over });

test('drafts and returned work are editable; submitted and graded are frozen', () => {
  assert.equal(submissionEditable({ status: 'draft' }, assignment(), NOW), true);
  assert.equal(submissionEditable({ status: 'returned' }, assignment(), NOW), true);
  assert.equal(submissionEditable({ status: 'submitted' }, assignment(), NOW), false);
  assert.equal(submissionEditable({ status: 'graded' }, assignment(), NOW), false);
});

test('nothing is editable past the due date — including a saved draft', () => {
  const overdue = assignment({ due_at: iso(NOW - DAY) });
  assert.equal(submissionEditable({ status: 'draft' }, overdue, NOW), false);
  assert.equal(submissionEditable({ status: 'returned' }, overdue, NOW), false);
});

test('an unpublished assignment cannot be submitted to', () => {
  assert.equal(submissionEditable({ status: 'draft' }, assignment({ published: false }), NOW), false);
});

test('an assignment with no due date stays open', () => {
  assert.equal(submissionEditable({ status: 'draft' }, assignment({ due_at: null }), NOW), true);
});

test('a missing submission is treated as a new draft', () => {
  assert.equal(submissionEditable(null, assignment(), NOW), true);
  assert.equal(submissionEditable(undefined, assignment(), NOW), true);
});

test('submissionLockReason explains every frozen state', () => {
  assert.equal(submissionLockReason({ status: 'draft' }, assignment(), NOW), null);
  assert.match(submissionLockReason({ status: 'graded' }, assignment(), NOW), /graded/i);
  assert.match(submissionLockReason({ status: 'submitted' }, assignment(), NOW), /handed in/i);
  assert.match(submissionLockReason({ status: 'draft' }, assignment({ published: false }), NOW), /not open/i);
  assert.match(
    submissionLockReason({ status: 'draft' }, assignment({ due_at: iso(NOW - DAY) }), NOW),
    /due date/i);
});

test('no lock reason ever renders undefined', () => {
  const cases = [
    [{ status: 'graded' }, assignment()],
    [{ status: 'submitted' }, assignment()],
    [{ status: 'draft' }, assignment({ published: false })],
    [{ status: 'draft' }, assignment({ due_at: iso(NOW - DAY) })],
    [{ status: 'weird' }, assignment()],
  ];
  for (const [sub, a] of cases) {
    const reason = submissionLockReason(sub, a, NOW);
    if (reason !== null) assert.ok(!/undefined|\[object/.test(reason), reason);
  }
});
