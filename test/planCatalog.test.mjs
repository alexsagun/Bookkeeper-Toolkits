// test/planCatalog.test.mjs — the membership catalog and its entitlement rules (#39).
//
// This suite is the acceptance test for the three-plan consolidation: it pins WHICH
// plans exist, what they cost, and — the part that actually protects members — what a
// plan key the catalog does not recognise is allowed to open.
//
// Prices here are the in-code FALLBACK. The live admin-editable enrollment_plans table
// is the runtime authority, so a price change ships as BOTH a row update (migration)
// and an edit here; the two must agree or the paywall shows one number and charges
// another whenever the table fails to load.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENROLLMENT_PLANS_FALLBACK,
  PLAN_ENTITLEMENTS,
  PLAN_LABELS,
  FULL_ENTITLEMENT,
  extensionPrice,
  filterStagesForEntitlement,
  planEntitlement,
} from '../src/lib/planCatalog.js';

const RETIRED = ['core_self_paced', 'gold_live'];
const byKey = Object.fromEntries(ENROLLMENT_PLANS_FALLBACK.map((p) => [p.key, p]));

// ── The catalog ──────────────────────────────────────────────────────────────

test('the catalog is exactly three plans, in card order', () => {
  assert.equal(ENROLLMENT_PLANS_FALLBACK.length, 3);
  assert.deepEqual(ENROLLMENT_PLANS_FALLBACK.map((p) => p.key),
    ['sampler', 'silver_self_paced', 'vip']);
  assert.deepEqual(ENROLLMENT_PLANS_FALLBACK.map((p) => p.position), [1, 2, 3]);
});

test('prices are the agreed ₱ amounts', () => {
  assert.equal(byKey.sampler.price_php, 1499);
  assert.equal(byKey.silver_self_paced.price_php, 2999);
  assert.equal(byKey.vip.price_php, 16999);
});

test('the retired plans are gone from every catalog surface', () => {
  for (const key of RETIRED) {
    assert.equal(byKey[key], undefined, `${key} must not be sellable`);
    assert.equal(PLAN_ENTITLEMENTS[key], undefined, `${key} must not carry an entitlement`);
    assert.equal(PLAN_LABELS[key], undefined, `${key} must not have a display label`);
  }
});

test('non-price marketing fields survived the reprice untouched', () => {
  // A price change must not quietly become a benefits change.
  assert.equal(byKey.vip.compare_at_php, 35000);
  assert.equal(byKey.vip.badge, 'BEST SELLER');
  assert.equal(byKey.vip.limit_note, 'Limited to 10 slots per month');
  assert.equal(byKey.silver_self_paced.compare_at_php, null);
  assert.equal(byKey.silver_self_paced.badge, null, 'Gold’s BEST VALUE badge is not reassigned');
  assert.equal(byKey.sampler.limit_note, 'Limited offer');
  assert.equal(byKey.sampler.support_days, 60);
  for (const p of ENROLLMENT_PLANS_FALLBACK) {
    assert.ok(Array.isArray(p.features) && p.features.length > 0, `${p.key} lost its features`);
  }
});

test('VIP is the only plan carrying a community segment (the batch/private-space plan)', () => {
  assert.equal(byKey.vip.community_segment, 'vip');
  assert.equal(byKey.sampler.community_segment, undefined);
  assert.equal(byKey.silver_self_paced.community_segment, undefined);
});

test('access_days back the cohort arithmetic', () => {
  assert.equal(byKey.sampler.access_days, 60);
  assert.equal(byKey.silver_self_paced.access_days, 60);
  assert.equal(byKey.vip.access_days, 180);
});

// ── Catalog ↔ entitlement parity ─────────────────────────────────────────────

test('EVERY sellable plan has an explicit entitlement entry', () => {
  // The invariant that keeps the fail-closed default safe. VIP used to rely on the
  // old "unlisted means full access" branch; once that branch started failing
  // closed, an unlisted VIP would have been locked out of the toolkit it paid for.
  for (const p of ENROLLMENT_PLANS_FALLBACK) {
    assert.ok(PLAN_ENTITLEMENTS[p.key], `${p.key} is sellable but has no PLAN_ENTITLEMENTS entry`);
  }
});

test('no entitlement entry describes a plan that cannot be bought', () => {
  for (const key of Object.keys(PLAN_ENTITLEMENTS)) {
    assert.ok(byKey[key], `PLAN_ENTITLEMENTS has ${key}, which is not in the catalog`);
  }
});

// ── planEntitlement ──────────────────────────────────────────────────────────

test('sampler keeps its Essentials-only scope exactly', () => {
  const ent = planEntitlement('sampler');
  assert.equal(ent.full, false);
  assert.equal(ent.allowsTab('qbomastery'), true);
  assert.equal(ent.allowsTab('linkedinopt'), true);
  assert.equal(ent.allowsTab('coachalex'), true);
  assert.equal(ent.allowsTab('community'), true);
  assert.equal(ent.allowsTab('dashboard'), true);
  assert.equal(ent.allowsTab('proposal'), false);
  assert.equal(ent.allowsStage('delivery'), false);
  // Course tier: Essentials yes, Mastery no.
  assert.equal(ent.allowsCourse({ slug: 'qbo-essentials', access_tier: 'essentials' }), true);
  assert.equal(ent.allowsCourse({ slug: 'qbo-mastery', access_tier: 'standard' }), false);
  assert.equal(ent.allowsCourse({ slug: 'qbo-new' }), false, 'missing tier defaults to standard');
});

test('silver and VIP open the whole student toolkit', () => {
  for (const key of ['silver_self_paced', 'vip']) {
    const ent = planEntitlement(key);
    assert.equal(ent.full, true, `${key} must be a full-access plan`);
    assert.equal(ent.allowsTab('proposal'), true);
    assert.equal(ent.allowsStage('delivery'), true);
    assert.equal(ent.allowsCourse({ slug: 'resume-strategy', access_tier: 'standard' }), true);
  }
});

test('a deleted or unknown plan key FAILS CLOSED, not open', () => {
  // The behaviour this change exists to fix: an unrecognised key used to inherit
  // the full toolkit through the default branch.
  for (const key of [...RETIRED, 'typo_plan', 'platinum']) {
    const ent = planEntitlement(key);
    assert.equal(ent.full, false, `${key} must not resolve to full access`);
    assert.equal(ent.allowsTab('proposal'), false);
    assert.equal(ent.allowsTab('qbomastery'), false);
    assert.equal(ent.allowsStage('training'), false);
    // No catalog tab is reachable, so this should be unreachable — but it says no
    // explicitly rather than relying on that argument holding forever.
    assert.equal(ent.allowsCourse({ slug: 'qbo-essentials', access_tier: 'essentials' }), false);
    // Home stays reachable so the member lands on the membership panel, not a dead end.
    assert.equal(ent.allowsTab('dashboard'), true);
    assert.equal(ent.allowsStage('home'), true);
  }
});

test('an unknown plan reads as unavailable in the UI, not as a raw key', () => {
  const ent = planEntitlement('gold_live');
  assert.equal(ent.label, 'Plan no longer available');
  assert.equal(ent.scopeLabel, 'no toolkit access');
  // RestrictedTab renders "Your current plan — {label} — includes {scopeLabel}."
  assert.doesNotMatch(ent.label, /_/, 'a plan key must never reach the member');
});

test('no plan key at all still means full access (admins, flag off, grandfathered)', () => {
  for (const key of [null, undefined, '']) {
    const ent = planEntitlement(key);
    assert.equal(ent.full, true);
    assert.equal(ent.allowsTab('proposal'), true);
    assert.equal(ent.planKey, null);
  }
  assert.equal(FULL_ENTITLEMENT.full, true);
  assert.equal(FULL_ENTITLEMENT.allowsTab('anything'), true);
});

test("profiles.plan = 'free' is NOT an unknown plan — it means no plan on file", () => {
  // profiles.plan is NOT NULL DEFAULT 'free', so a grandfathered member (is_paid with no
  // subscription rows — the branch is_enrolled() keeps open on purpose) reaches the shell
  // with exactly this value. Failing closed here would lock out the people that branch
  // protects, silently. Same for the enrollment gate's fail-open timeout path.
  for (const key of ['free', 'FREE', ' free ', 'none', 'null', 'undefined']) {
    const ent = planEntitlement(key);
    assert.equal(ent.full, true, `${key} must resolve to full access`);
    assert.equal(ent.allowsTab('proposal'), true);
  }
});

// ── Sidebar filtering ────────────────────────────────────────────────────────

const STAGES = [
  { id: 'home', tabs: [{ id: 'dashboard' }, { id: 'community' }],
    groups: [{ key: 'g1', tabIds: ['dashboard', 'community'] }] },
  { id: 'training', tabs: [{ id: 'qbomastery' }, { id: 'ustax' }],
    groups: [{ key: 'g2', tabIds: ['qbomastery', 'ustax'] }] },
  { id: 'delivery', tabs: [{ id: 'proposal' }], groups: [{ key: 'g3', tabIds: ['proposal'] }] },
];

test('filterStagesForEntitlement drops what the plan cannot open', () => {
  const full = filterStagesForEntitlement(STAGES, planEntitlement('vip'));
  assert.equal(full, STAGES, 'a full plan gets the array back untouched');

  const sampler = filterStagesForEntitlement(STAGES, planEntitlement('sampler'));
  assert.deepEqual(sampler.map((s) => s.id), ['home', 'training']);
  assert.deepEqual(sampler[1].tabs.map((t) => t.id), ['qbomastery'], 'ustax is not in scope');
  assert.deepEqual(sampler[1].groups[0].tabIds, ['qbomastery'], 'empty groups never render');

  const unknown = filterStagesForEntitlement(STAGES, planEntitlement('gold_live'));
  assert.deepEqual(unknown.map((s) => s.id), ['home']);
  assert.deepEqual(unknown[0].tabs.map((t) => t.id), ['dashboard'],
    'a retired plan keeps Home only — community is a paid space');
});

// ── Extension pricing ────────────────────────────────────────────────────────

test('extension pricing pro-rates the CURRENT price over the plan duration', () => {
  // A 60-day plan's 2-month minimum top-up == its full price.
  assert.deepEqual(extensionPrice(byKey.silver_self_paced, 2), { days: 60, amount: 2999 });
  assert.deepEqual(extensionPrice(byKey.sampler, 2), { days: 60, amount: 1499 });
  // 180-day VIP: 60 days at ₱16,999/180.
  assert.deepEqual(extensionPrice(byKey.vip, 2), { days: 60, amount: 5666 });
  assert.deepEqual(extensionPrice(byKey.vip, 6), { days: 180, amount: 16999 });
});

test('extension pricing never sells less than the 2-month minimum', () => {
  assert.equal(extensionPrice(byKey.silver_self_paced, 1).days, 60);
  assert.equal(extensionPrice(byKey.silver_self_paced, 0).days, 60);
  assert.equal(extensionPrice(null, 2).amount, 0, 'no plan row → no price invented');
});
