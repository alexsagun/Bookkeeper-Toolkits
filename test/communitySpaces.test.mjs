// Run with: node --test
// Pins the batch/segment truth table in src/lib/communitySpaces.js — the pure
// mirror of db/2026-07-28-community-spaces-batches.sql (#32). Uses ONLY
// synthetic fixtures. If a case here changes, the SQL (admin_finalize_enrollment
// batch precedence, batches_create_spaces naming, resolveBatchForImport rules)
// must change with it — drift is a security bug, not a style issue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_SEGMENT_FALLBACK,
  planSegment,
  isPremiumSegment,
  isValidBatchCode,
  normalizeBatchCode,
  spaceSlugFor,
  spaceNameFor,
  resolveBatchForImport,
  batchGapForProcess,
  approvalBatchPreselect,
  defaultSpaceOf,
  pickInitialSpace,
} from '../src/lib/communitySpaces.js';

// Synthetic live-plans map (shape of enrollment_plans rows post-#32).
const PLANS = {
  core_self_paced:   { key: 'core_self_paced',   community_segment: 'general' },
  sampler:           { key: 'sampler',           community_segment: 'general' },
  silver_self_paced: { key: 'silver_self_paced', community_segment: 'general' },
  gold_live:         { key: 'gold_live',         community_segment: 'gold' },
  vip:               { key: 'vip',               community_segment: 'vip' },
};

const BATCHES = {
  '2026-08': { id: 'b-aug', status: 'open' },
  '2026-09': { id: 'b-sep', status: 'closed' },
  '2026-10': { id: 'b-oct', status: 'archived' },
};

// ── planSegment ──────────────────────────────────────────────────────────────

test('planSegment maps the five live plan keys from the plans rows', () => {
  assert.equal(planSegment('core_self_paced', PLANS), 'general');
  assert.equal(planSegment('sampler', PLANS), 'general');
  assert.equal(planSegment('silver_self_paced', PLANS), 'general');
  assert.equal(planSegment('gold_live', PLANS), 'gold');
  assert.equal(planSegment('vip', PLANS), 'vip');
});

test('planSegment falls back to PLAN_SEGMENT_FALLBACK when no plans map is available', () => {
  assert.equal(planSegment('gold_live', null), 'gold');
  assert.equal(planSegment('vip', undefined), 'vip');
  assert.equal(planSegment('silver_self_paced', null), 'general');
});

test('planSegment fails closed to general for unknown, legacy, and null plans', () => {
  assert.equal(planSegment('some_retired_plan', PLANS), 'general');
  assert.equal(planSegment(null, PLANS), 'general');
  assert.equal(planSegment('', PLANS), 'general');
});

test('planSegment ignores a malformed community_segment value on the row', () => {
  const bad = { gold_live: { key: 'gold_live', community_segment: 'platinum' } };
  // Row value invalid → fallback map still resolves gold_live correctly.
  assert.equal(planSegment('gold_live', bad), 'gold');
});

test('isPremiumSegment is true only for gold and vip', () => {
  assert.equal(isPremiumSegment('gold'), true);
  assert.equal(isPremiumSegment('vip'), true);
  assert.equal(isPremiumSegment('general'), false);
  assert.equal(isPremiumSegment(null), false);
});

test('PLAN_SEGMENT_FALLBACK never marks a self-paced plan premium', () => {
  assert.deepEqual(Object.keys(PLAN_SEGMENT_FALLBACK).sort(), ['gold_live', 'vip']);
});

// ── Batch codes + space naming ───────────────────────────────────────────────

test('isValidBatchCode accepts YYYY-MM and rejects everything else', () => {
  assert.equal(isValidBatchCode('2026-08'), true);
  assert.equal(isValidBatchCode('  2026-08  '), true);
  assert.equal(isValidBatchCode('2026-8'), false);
  assert.equal(isValidBatchCode('26-08'), false);
  assert.equal(isValidBatchCode('August 2026'), false);
  assert.equal(isValidBatchCode(''), false);
  assert.equal(isValidBatchCode(null), false);
});

test('normalizeBatchCode trims and lowercases', () => {
  assert.equal(normalizeBatchCode('  2026-08 '), '2026-08');
  assert.equal(normalizeBatchCode(null), '');
});

test('spaceSlugFor / spaceNameFor mirror batches_create_spaces() naming', () => {
  assert.equal(spaceSlugFor('gold', '2026-08'), 'gold-2026-08');
  assert.equal(spaceSlugFor('vip', '2026-08'), 'vip-2026-08');
  assert.equal(spaceSlugFor('general', null), 'general');
  assert.equal(spaceNameFor('gold', 'August 2026'), 'Gold — August 2026');
  assert.equal(spaceNameFor('vip', 'August 2026'), 'VIP — August 2026');
  assert.equal(spaceNameFor('general', null), 'General');
});

// ── resolveBatchForImport ────────────────────────────────────────────────────

test('import: premium row with a confirmed open batch resolves the batch id', () => {
  const r = resolveBatchForImport({ segment: 'gold', batchCodeRaw: '2026-08', batchesByCode: BATCHES });
  assert.deepEqual(r, { batchId: 'b-aug', blocked: false, reason: null, warning: null });
});

test('import: premium row without a batch_code is BLOCKED, never guessed', () => {
  const r = resolveBatchForImport({ segment: 'vip', batchCodeRaw: '', batchesByCode: BATCHES });
  assert.equal(r.blocked, true);
  assert.equal(r.batchId, null);
  assert.match(r.reason, /Needs batch assignment/);
});

test('import: premium row with an unknown batch_code is BLOCKED', () => {
  const r = resolveBatchForImport({ segment: 'gold', batchCodeRaw: '2027-01', batchesByCode: BATCHES });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /Unknown batch_code/);
});

test('import: premium row with a malformed batch_code is BLOCKED', () => {
  const r = resolveBatchForImport({ segment: 'gold', batchCodeRaw: 'aug-2026', batchesByCode: BATCHES });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /Invalid batch_code/);
});

test('import: closed and archived batches reject new assignments', () => {
  const closed = resolveBatchForImport({ segment: 'gold', batchCodeRaw: '2026-09', batchesByCode: BATCHES });
  assert.equal(closed.blocked, true);
  assert.match(closed.reason, /closed/);
  const archived = resolveBatchForImport({ segment: 'vip', batchCodeRaw: '2026-10', batchesByCode: BATCHES });
  assert.equal(archived.blocked, true);
});

test('import: general-plan row ignores a batch_code with a warning', () => {
  const r = resolveBatchForImport({ segment: 'general', batchCodeRaw: '2026-08', batchesByCode: BATCHES });
  assert.equal(r.blocked, false);
  assert.equal(r.batchId, null);
  assert.match(r.warning, /ignored/);
});

test('import: general-plan row with no code has neither block nor warning', () => {
  const r = resolveBatchForImport({ segment: 'general', batchCodeRaw: null, batchesByCode: BATCHES });
  assert.deepEqual(r, { batchId: null, blocked: false, reason: null, warning: null });
});

test('batch codes: an impossible month is rejected (mirrors the #33 CHECK)', () => {
  assert.equal(isValidBatchCode('2026-08'), true);
  assert.equal(isValidBatchCode('2026-01'), true);
  assert.equal(isValidBatchCode('2026-12'), true);
  assert.equal(isValidBatchCode('2026-00'), false);
  assert.equal(isValidBatchCode('2026-13'), false);
  assert.equal(isValidBatchCode('2026-99'), false);
});

test('import: an impossible month blocks a premium row rather than resolving', () => {
  const r = resolveBatchForImport({ segment: 'gold', batchCodeRaw: '2026-13', batchesByCode: BATCHES });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /Invalid batch_code/);
});

test('import: leading/trailing whitespace around a code still resolves', () => {
  const r = resolveBatchForImport({ segment: 'gold', batchCodeRaw: '  2026-08  ', batchesByCode: BATCHES });
  assert.equal(r.blocked, false);
  assert.equal(r.batchId, 'b-aug');
});

test('import: a pre-#32 database (no batches at all) blocks every premium row', () => {
  for (const segment of ['gold', 'vip']) {
    const r = resolveBatchForImport({ segment, batchCodeRaw: '2026-08', batchesByCode: {} });
    assert.equal(r.blocked, true, `${segment} must block when no batches exist`);
    assert.equal(r.batchId, null);
  }
});

// Requirement: "Never infer a batch from approval date, signup date, course title, or
// payment amount." resolveBatchForImport takes ONLY a code, so the guarantee is
// structural — this pins it against a future signature that accepts row context.
test('import: a premium row rich in dates still blocks without an explicit code', () => {
  const r = resolveBatchForImport({
    segment: 'gold',
    batchCodeRaw: null,
    batchesByCode: BATCHES,
    // Everything an inference-happy implementation might reach for. All must be ignored.
    row: {
      source_created_at: '2026-08-03T00:00:00Z',
      last_sign_in_at: '2026-08-20T00:00:00Z',
      membership_started_at: '2026-08-01',
      legacy_enrollments: 'Gold Live Coaching — August 2026',
      amount_paid: '9999',
    },
  });
  assert.equal(r.blocked, true);
  assert.equal(r.batchId, null);
  assert.match(r.reason, /Needs batch assignment/);
});

// ── batchGapForProcess (process-time re-validation: the last line of defense) ─

test('process: non-premium rows never have a batch gap', () => {
  assert.equal(batchGapForProcess({ segment: 'general', proposedBatchId: null, batch: null }), null);
  // Even a stale batch reference on a general row is not a gap — it is simply unused.
  assert.equal(batchGapForProcess({ segment: 'general', proposedBatchId: 'b-sep', batch: null }), null);
});

test('process: premium row with no proposed batch is blocked', () => {
  const gap = batchGapForProcess({ segment: 'gold', proposedBatchId: null, batch: null });
  assert.match(gap, /Needs batch assignment/);
});

test('process: premium row whose batch was deleted since the dry run is blocked', () => {
  const gap = batchGapForProcess({ segment: 'vip', proposedBatchId: 'b-gone', batch: null });
  assert.match(gap, /no longer exists/);
});

test('process: premium row whose batch closed since the dry run is blocked', () => {
  for (const status of ['closed', 'archived']) {
    const gap = batchGapForProcess({
      segment: 'gold', proposedBatchId: 'b-sep', batch: { id: 'b-sep', code: '2026-09', status },
    });
    assert.match(gap, new RegExp(status), `a ${status} batch must re-block at process time`);
  }
});

test('process: premium row with a still-open batch passes', () => {
  const gap = batchGapForProcess({
    segment: 'gold', proposedBatchId: 'b-aug', batch: { id: 'b-aug', code: '2026-08', status: 'open' },
  });
  assert.equal(gap, null);
});

// ── approvalBatchPreselect (mirror of admin_finalize_enrollment precedence) ──

test('approve: general-segment requests never need a batch', () => {
  const r = approvalBatchPreselect({ requestKind: 'new', segment: 'general', requestBatchId: 'b-aug' });
  assert.deepEqual(r, { batchId: null, required: false, locked: false });
});

test('approve: new premium request preselects the checkout choice and requires one', () => {
  assert.deepEqual(
    approvalBatchPreselect({ requestKind: 'new', segment: 'gold', requestBatchId: 'b-aug' }),
    { batchId: 'b-aug', required: true, locked: false });
  assert.deepEqual(
    approvalBatchPreselect({ requestKind: 'new', segment: 'vip', requestBatchId: null }),
    { batchId: null, required: true, locked: false });
});

test('approve: renewal preserves the current batch by default', () => {
  const r = approvalBatchPreselect({
    requestKind: 'renewal', segment: 'gold', prevBatchId: 'b-aug', requestBatchId: 'b-sep',
  });
  assert.deepEqual(r, { batchId: 'b-aug', required: true, locked: false });
});

test('approve: extension inherits the current batch and LOCKS it', () => {
  const r = approvalBatchPreselect({
    requestKind: 'extension', segment: 'vip', prevBatchId: 'b-aug',
  });
  assert.deepEqual(r, { batchId: 'b-aug', required: true, locked: true });
});

test('approve: extension without a prior batch stays unlocked (needs-batch member)', () => {
  const r = approvalBatchPreselect({ requestKind: 'extension', segment: 'gold', prevBatchId: null });
  assert.deepEqual(r, { batchId: null, required: true, locked: false });
});

test('approve: gold↔vip upgrade keeps the batch only when the target space exists there', () => {
  const kept = approvalBatchPreselect({
    requestKind: 'upgrade', segment: 'vip', prevBatchId: 'b-aug', spaceExistsForPrevBatch: true,
  });
  assert.deepEqual(kept, { batchId: 'b-aug', required: true, locked: false });
  const explicit = approvalBatchPreselect({
    requestKind: 'upgrade', segment: 'vip', prevBatchId: 'b-aug',
    spaceExistsForPrevBatch: false, requestBatchId: 'b-sep',
  });
  assert.deepEqual(explicit, { batchId: 'b-sep', required: true, locked: false });
});

test('approve: upgrade with neither an inheritable batch nor a checkout choice requires explicit selection', () => {
  const r = approvalBatchPreselect({
    requestKind: 'upgrade', segment: 'gold', prevBatchId: null, requestBatchId: null,
  });
  assert.deepEqual(r, { batchId: null, required: true, locked: false });
});

// ── Client space selection ───────────────────────────────────────────────────

const SPACES = [
  { slug: 'general', kind: 'general', is_default: false },
  { slug: 'gold-2026-08', kind: 'gold', is_default: true },
];

test('defaultSpaceOf prefers the RPC is_default flag, then a premium space', () => {
  assert.equal(defaultSpaceOf(SPACES).slug, 'gold-2026-08');
  const noFlag = SPACES.map(s => ({ ...s, is_default: false }));
  assert.equal(defaultSpaceOf(noFlag).slug, 'gold-2026-08');
  assert.equal(defaultSpaceOf([{ slug: 'general', kind: 'general', is_default: false }]).slug, 'general');
  assert.equal(defaultSpaceOf([]), null);
});

test('pickInitialSpace precedence: url slug → stored slug → default', () => {
  assert.equal(pickInitialSpace({ urlSlug: 'general', storedSlug: null, spaces: SPACES }).slug, 'general');
  assert.equal(pickInitialSpace({ urlSlug: null, storedSlug: 'general', spaces: SPACES }).slug, 'general');
  assert.equal(pickInitialSpace({ urlSlug: null, storedSlug: null, spaces: SPACES }).slug, 'gold-2026-08');
});

test('pickInitialSpace ignores inaccessible slugs (deep link into a foreign space)', () => {
  assert.equal(pickInitialSpace({ urlSlug: 'vip-2026-09', storedSlug: 'gone', spaces: SPACES }).slug, 'gold-2026-08');
  assert.equal(pickInitialSpace({ urlSlug: 'x', storedSlug: 'y', spaces: [] }), null);
});
