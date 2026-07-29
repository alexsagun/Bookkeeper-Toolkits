// test/batchEntitlements.test.mjs — cohort-seat arithmetic and classification (#35).
//
// The truth tables here are the JS half of a lockstep pair with
// public.plan_batch_count() and the L1 seat predicate. They exist so that a
// change on one side without the other fails loudly instead of quietly granting
// the wrong number of months of Alex's live teaching.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAYS_PER_COHORT,
  MAX_EXTENSION_COHORTS,
  MAX_OUTSTANDING_SEATS,
  describeSeat,
  groupRunsByRunId,
  planBatchCount,
  runLengthForExtension,
  seatIsLive,
  seatStatusOf,
  summariseSeats,
} from '../src/lib/batchEntitlements.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('planBatchCount: the five live plans (D1 — derived from access_days)', () => {
  // The decision that matters: gold_live and vip are 180-day plans, so each
  // approval grants SIX monthly cohort seats.
  assert.equal(planBatchCount(180, null), 6, 'gold_live / vip');
  assert.equal(planBatchCount(60, null), 2, 'core_self_paced / sampler / silver_self_paced');
});

test('planBatchCount: the override wins and is clamped', () => {
  // Pinning Gold back to 2 is a one-row UPDATE, no migration.
  assert.equal(planBatchCount(180, 2), 2);
  assert.equal(planBatchCount(60, 1), 1);
  assert.equal(planBatchCount(180, 999), MAX_OUTSTANDING_SEATS, 'a typo cannot mint 999 seats');
  assert.equal(planBatchCount(180, 0), null, 'a zero override is invalid, not "no cohorts"');
  assert.equal(planBatchCount(180, -3), null);
});

test('planBatchCount: a lifetime plan returns null so the caller fails closed', () => {
  // access_days null == no expiry. "Unlimited cohorts forever" must never be
  // inferred — grant_batch_run raises INVALID_PLAN and the backfill skips it.
  assert.equal(planBatchCount(null, null), null);
  assert.equal(planBatchCount(undefined, undefined), null);
  // …but an explicit override still resolves a lifetime plan.
  assert.equal(planBatchCount(null, 3), 3);
});

test('planBatchCount: rounds up and floors at 1', () => {
  assert.equal(planBatchCount(1, null), 1);
  assert.equal(planBatchCount(29, null), 1);
  assert.equal(planBatchCount(30, null), 1);
  assert.equal(planBatchCount(31, null), 2, 'ceil, not round');
  assert.equal(planBatchCount(90, null), 3);
  assert.equal(planBatchCount(365, null), 13);
  assert.equal(planBatchCount(0, null), null, 'zero days is not a plan');
  assert.equal(planBatchCount(-30, null), null);
  assert.equal(planBatchCount('180', null), 6, 'numeric strings from PostgREST');
});

test('runLengthForExtension is keyed on what was BOUGHT, not on the plan (D9)', () => {
  // The critical review finding: deriving this from the plan's access_days would
  // give a 60-day top-up on Gold six cohorts instead of two.
  assert.equal(runLengthForExtension(60), 2);
  assert.equal(runLengthForExtension(90), 3);
  assert.equal(runLengthForExtension(180), 6);
  assert.equal(runLengthForExtension(365), MAX_EXTENSION_COHORTS, 'clamped to 12');
});

test('runLengthForExtension returns 0 for nothing to extend by', () => {
  assert.equal(runLengthForExtension(null), 0);
  assert.equal(runLengthForExtension(undefined), 0);
  assert.equal(runLengthForExtension(0), 0);
  assert.equal(runLengthForExtension(-60), 0);
  assert.equal(runLengthForExtension('not a number'), 0);
});

test('DAYS_PER_COHORT is the single source of the 30-day rule', () => {
  assert.equal(DAYS_PER_COHORT, 30);
  assert.equal(planBatchCount(DAYS_PER_COHORT * 4, null), 4);
});

// ── seatStatusOf — the L1 predicate mirror ───────────────────────────────────

const seat = (over = {}) => ({
  status: 'active',
  batch_id: 'b-aug',
  segment: 'gold',
  batch_index: 0,
  run_id: 'run-1',
  run_length: 6,
  grant_reason: 'approval',
  granted_at: iso(NOW - 30 * DAY),
  valid_until: iso(NOW + 30 * DAY),
  activates_at: iso(NOW - 1 * DAY),
  ...over,
});

test('seatStatusOf: an allocated, started, unexpired seat is active', () => {
  assert.equal(seatStatusOf(seat(), NOW), 'active');
  assert.ok(seatIsLive(seat(), NOW));
});

test('seatStatusOf: a seat with no cohort yet is queued', () => {
  assert.equal(seatStatusOf(seat({ status: 'queued', batch_id: null, activates_at: null }), NOW), 'queued');
  // Defensive: a row claiming 'active' with no batch is still not usable.
  assert.equal(seatStatusOf(seat({ batch_id: null }), NOW), 'queued');
});

test('seatStatusOf: a future cohort is scheduled, not active', () => {
  assert.equal(seatStatusOf(seat({ activates_at: iso(NOW + 10 * DAY) }), NOW), 'scheduled');
  assert.ok(!seatIsLive(seat({ activates_at: iso(NOW + 10 * DAY) }), NOW));
});

test('seatStatusOf: expiry beats everything except revocation', () => {
  assert.equal(seatStatusOf(seat({ valid_until: iso(NOW - 1 * HOUR) }), NOW), 'expired');
  // Expired AND not yet started → still expired (the term is over).
  assert.equal(
    seatStatusOf(seat({ valid_until: iso(NOW - 1 * HOUR), activates_at: iso(NOW + 10 * DAY) }), NOW),
    'expired',
  );
  // Revoked outranks expiry, so the admin reason is what shows.
  assert.equal(seatStatusOf(seat({ status: 'revoked', valid_until: iso(NOW - 1 * HOUR) }), NOW), 'revoked');
});

test('seatStatusOf: boundaries are exclusive on expiry, inclusive on activation', () => {
  // Mirrors SQL: valid_until > now()  and  activates_at <= now()
  assert.equal(seatStatusOf(seat({ valid_until: iso(NOW) }), NOW), 'expired');
  assert.equal(seatStatusOf(seat({ valid_until: iso(NOW + 1) }), NOW), 'active');
  assert.equal(seatStatusOf(seat({ activates_at: iso(NOW) }), NOW), 'active');
  assert.equal(seatStatusOf(seat({ activates_at: iso(NOW + 1) }), NOW), 'scheduled');
});

test('seatStatusOf: null valid_until / activates_at mean "no bound", not "expired"', () => {
  assert.equal(seatStatusOf(seat({ valid_until: null, activates_at: null }), NOW), 'active');
});

test('seatStatusOf: superseded and malformed rows are reported honestly', () => {
  assert.equal(seatStatusOf(seat({ status: 'superseded' }), NOW), 'superseded');
  assert.equal(seatStatusOf(null, NOW), 'unknown');
  assert.equal(seatStatusOf({}, NOW), 'queued', 'no batch_id → queued, never active');
  assert.equal(seatStatusOf(seat({ valid_until: 'garbage' }), NOW), 'active', 'unparseable date is not a bound');
});

test('seatStatusOf deliberately cannot see a plan downgrade', () => {
  // A stamped gold seat still LOOKS active to the client after a downgrade; the
  // live-segment conjunct in SQL is what refuses it. This test documents that
  // the client helper is not an authorization boundary.
  const stampedGoldAfterDowngrade = seat({ segment: 'gold' });
  assert.equal(seatStatusOf(stampedGoldAfterDowngrade, NOW), 'active');
});

// ── grouping / summarising ───────────────────────────────────────────────────

test('groupRunsByRunId: newest run first, seats in run order', () => {
  const rows = [
    seat({ run_id: 'r-old', batch_index: 1, granted_at: iso(NOW - 90 * DAY), batch_id: 'b2' }),
    seat({ run_id: 'r-new', batch_index: 2, granted_at: iso(NOW - 5 * DAY), batch_id: 'b5' }),
    seat({ run_id: 'r-old', batch_index: 0, granted_at: iso(NOW - 90 * DAY), batch_id: 'b1' }),
    seat({ run_id: 'r-new', batch_index: 0, granted_at: iso(NOW - 5 * DAY), batch_id: 'b3' }),
    seat({ run_id: 'r-new', batch_index: 1, granted_at: iso(NOW - 5 * DAY), batch_id: 'b4' }),
  ];
  const runs = groupRunsByRunId(rows);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].run_id, 'r-new');
  assert.deepEqual(runs[0].seats.map((s) => s.batch_index), [0, 1, 2]);
  assert.deepEqual(runs[1].seats.map((s) => s.batch_index), [0, 1]);
});

test('groupRunsByRunId: same-timestamp runs order stably by run_id', () => {
  const t = iso(NOW - DAY);
  const rows = [
    seat({ run_id: 'bbb', granted_at: t }),
    seat({ run_id: 'aaa', granted_at: t }),
  ];
  assert.deepEqual(groupRunsByRunId(rows).map((r) => r.run_id), ['aaa', 'bbb']);
  // Re-running on the reversed input yields the same order.
  assert.deepEqual(groupRunsByRunId([...rows].reverse()).map((r) => r.run_id), ['aaa', 'bbb']);
});

test('groupRunsByRunId ignores rows with no run_id and never throws on junk', () => {
  assert.deepEqual(groupRunsByRunId(null), []);
  assert.deepEqual(groupRunsByRunId([null, {}, { run_id: null }]), []);
});

test('summariseSeats counts a real six-cohort Gold run mid-term', () => {
  // Aug started, Sep-Oct allocated but future, Nov-Jan still queued.
  const rows = [
    seat({ batch_index: 0, batch_id: 'aug', activates_at: iso(NOW - 14 * DAY) }),
    seat({ batch_index: 1, batch_id: 'sep', activates_at: iso(NOW + 16 * DAY) }),
    seat({ batch_index: 2, batch_id: 'oct', activates_at: iso(NOW + 47 * DAY) }),
    seat({ batch_index: 3, batch_id: null, status: 'queued', activates_at: null }),
    seat({ batch_index: 4, batch_id: null, status: 'queued', activates_at: null }),
    seat({ batch_index: 5, batch_id: null, status: 'queued', activates_at: null }),
  ];
  const s = summariseSeats(rows, NOW);
  assert.equal(s.active, 1);
  assert.equal(s.scheduled, 2);
  assert.equal(s.queued, 3);
  assert.equal(s.total, 6);
  assert.deepEqual(s.batchIds, ['aug']);
});

test('summariseSeats excludes revoked and expired seats from the total', () => {
  const rows = [
    seat({ batch_index: 0 }),
    seat({ batch_index: 1, status: 'revoked' }),
    seat({ batch_index: 2, valid_until: iso(NOW - DAY) }),
    seat({ batch_index: 3, status: 'superseded' }),
  ];
  const s = summariseSeats(rows, NOW);
  assert.equal(s.total, 1);
  assert.equal(s.active, 1);
});

test('describeSeat says WHY access exists, for every status', () => {
  const batches = { 'b-aug': { code: '2026-08', name: 'August 2026' } };
  assert.match(describeSeat(seat(), batches, NOW), /Approved — August 2026/);
  assert.match(
    describeSeat(seat({ status: 'queued', batch_id: null, grant_reason: 'extension' }), batches, NOW),
    /Extension — seat reserved/,
  );
  assert.match(describeSeat(seat({ activates_at: iso(NOW + DAY) }), batches, NOW), /starts soon/);
  assert.match(describeSeat(seat({ valid_until: iso(NOW - DAY) }), batches, NOW), /access ended/);
  assert.match(
    describeSeat(seat({ status: 'revoked', revoke_reason: 'refund' }), batches, NOW),
    /access withdrawn: refund/,
  );
  assert.match(describeSeat(seat({ status: 'superseded' }), batches, NOW), /replaced by a later plan/);
  // An unknown batch id must not render "undefined".
  assert.ok(!/undefined/.test(describeSeat(seat({ batch_id: 'missing' }), batches, NOW)));
});

test('MAX_OUTSTANDING_SEATS bounds every derivation path', () => {
  assert.equal(MAX_OUTSTANDING_SEATS, 24);
  assert.ok(planBatchCount(100000, null) <= MAX_OUTSTANDING_SEATS);
  assert.ok(planBatchCount(60, 100000) <= MAX_OUTSTANDING_SEATS);
  assert.ok(runLengthForExtension(100000) <= MAX_EXTENSION_COHORTS);
});
