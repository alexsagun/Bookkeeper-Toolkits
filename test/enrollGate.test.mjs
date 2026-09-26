// test/enrollGate.test.mjs — the membership math behind the student gate (#67 extraction).
//
// subAccess() and enrollGateState() moved out of src/BookkeeperPro.jsx so the new
// `scheduled` state — a paid migrated membership whose start is still ahead — could be
// pinned here rather than trusted to a comment. Before #67, a paid student holding such a
// term resolved to 'expired' and was shown the Renew prices for what they had bought.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { enrollGateState, subAccess } from '../src/lib/enrollGate.js';

const NOW = Date.UTC(2026, 8, 25, 4, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const scheduledSub = {
  status: 'scheduled', plan_key: 'vip',
  started_at: '2026-10-11T16:00:00.000Z', ends_at: '2027-04-12T15:59:59.999Z',
  grace_ends_at: '2027-04-15T15:59:59.999Z',
};

test('a scheduled term is neither valid nor expired', () => {
  const a = subAccess(scheduledSub, NOW);
  assert.equal(a.has, true);
  assert.equal(a.valid, false, 'it grants nothing until it starts — the database agrees');
  assert.equal(a.expired, false, 'and it is not lapsed, so no Renew screen');
  assert.equal(a.scheduled, true);
  assert.equal(a.startsAt.toISOString(), '2026-10-11T16:00:00.000Z');
});

test('a paid student with a scheduled term resolves to scheduled, never expired', () => {
  assert.equal(enrollGateState({ profile: { is_paid: true }, latestReq: null, sub: scheduledSub }, NOW), 'scheduled');
});

test('scheduled wins even on a profile whose paid cache is stale', () => {
  assert.equal(enrollGateState({ profile: { is_paid: false }, latestReq: null, sub: scheduledSub }, NOW), 'scheduled');
  assert.equal(enrollGateState({ profile: null, latestReq: null, sub: scheduledSub }, NOW), 'scheduled');
});

test('the existing states are unchanged', () => {
  const live = { status: 'active', started_at: iso(NOW - 10 * DAY), ends_at: iso(NOW + 30 * DAY), grace_ends_at: iso(NOW + 33 * DAY) };
  const lapsed = { status: 'active', started_at: iso(NOW - 90 * DAY), ends_at: iso(NOW - 10 * DAY), grace_ends_at: iso(NOW - 7 * DAY) };
  const grace = { status: 'active', started_at: iso(NOW - 60 * DAY), ends_at: iso(NOW - DAY), grace_ends_at: iso(NOW + 2 * DAY) };
  assert.equal(enrollGateState({ profile: { is_paid: true }, sub: live }, NOW), 'pass');
  assert.equal(enrollGateState({ profile: { is_paid: true }, sub: grace }, NOW), 'pass');
  assert.equal(subAccess(grace, NOW).inGrace, true);
  assert.equal(enrollGateState({ profile: { is_paid: true }, sub: lapsed }, NOW), 'expired');
  assert.equal(enrollGateState({ profile: { is_paid: true }, sub: null }, NOW), 'pass', 'grandfathered paid, no rows');
  assert.equal(enrollGateState({ profile: { is_paid: false }, sub: null }, NOW), 'paywall');
  assert.equal(enrollGateState({ profile: { is_paid: false }, latestReq: { status: 'pending_review' }, sub: null }, NOW), 'pending');
  assert.equal(subAccess(lapsed, NOW).expired, true);
  assert.equal(subAccess(live, NOW).scheduled, false);
});

test('a cancelled scheduled term (a reverted activation) is simply not a live membership', () => {
  const cancelled = { ...scheduledSub, status: 'cancelled' };
  assert.equal(subAccess(cancelled, NOW).valid, false);
  assert.equal(subAccess(cancelled, NOW).scheduled, false);
});

test('the monolith imports these instead of keeping its own copies', () => {
  const src = readFileSync(new URL('../src/BookkeeperPro.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("import { enrollGateState, subAccess } from './lib/enrollGate';"));
  assert.ok(!/\nfunction subAccess\(/.test(src), 'a second subAccess would drift from the tested one');
  assert.ok(!/\nfunction enrollGateState\(/.test(src));
});
