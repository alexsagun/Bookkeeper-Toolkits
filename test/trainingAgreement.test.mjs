// test/trainingAgreement.test.mjs — the Training Agreement document model (#42).
//
// This is a document students SIGN, so the failure modes here are not cosmetic:
// a wrong price on a signed agreement is a wrong price you agreed to, and a
// missing section is a term nobody consented to.
//
// Two guards earn their place specifically because the Google Apps Script this
// replaces got them wrong:
//
//   1. Section 4 (Self-paced Training) was written as a dangling expression in
//      agreement.html:451 — `section(4,…) +` with the result discarded — so it
//      never rendered. Every Silver student signed a document missing the one
//      section describing Silver. The contiguity test below makes that class of
//      omission impossible to ship again.
//   2. Prices were hardcoded into the comparison table (₱15,999 / ₱1,999) while
//      the live catalog charged ₱16,999 / ₱2,999. The pricing tests assert the
//      model reads enrollment_plans instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGREEMENT_VERSION,
  AGREEMENT_TIERS,
  tierForPlanKey,
  accessLabel,
  agreementModel,
  agreementSnapshot,
} from '../src/lib/trainingAgreement.js';
import { ENROLLMENT_PLANS_FALLBACK } from '../src/lib/planCatalog.js';

// Shaped like public.enrollment_plans, with the live catalog's values.
const PLANS = Object.freeze([
  { key: 'sampler', name: 'Sampler Session', price_php: 1499, access_days: 60, support_days: 60 },
  { key: 'silver_self_paced', name: 'QBO + Resume Combo', price_php: 2999, access_days: 60 },
  { key: 'vip', name: 'Personalized Coaching Program', price_php: 16999, access_days: 180 },
]);

const model = (planKey = 'vip', opts = {}) => agreementModel(planKey, PLANS, opts);
const asText = m => JSON.stringify(m);

// ── Versioning ───────────────────────────────────────────────────────────────

test('the agreement carries a version so a signature maps to the text that was signed', () => {
  assert.equal(typeof AGREEMENT_VERSION, 'string');
  assert.ok(AGREEMENT_VERSION.length > 0);
  assert.equal(model().version, AGREEMENT_VERSION);
});

// ── Tier resolution ──────────────────────────────────────────────────────────

test('each live plan key maps to an agreement tier', () => {
  assert.equal(tierForPlanKey('sampler'), 'sampler');
  assert.equal(tierForPlanKey('silver_self_paced'), 'silver');
  assert.equal(tierForPlanKey('vip'), 'vip');
});

test('an unknown plan key resolves to no tier rather than guessing one', () => {
  for (const key of ['gold_live', 'core_self_paced', 'nonsense', '', null, undefined]) {
    assert.equal(tierForPlanKey(key), null, `${JSON.stringify(key)} must not silently become a tier`);
  }
});

test('a model for an unknown plan still renders but highlights nothing', () => {
  const m = agreementModel('gold_live', PLANS);
  assert.equal(m.tierKey, null, 'a retired plan must not be shown as the selected tier');
  assert.ok(m.sections.length > 0, 'the document still renders — it just has no column highlighted');
});

// ── Section integrity: the Section 4 guard ───────────────────────────────────

test('the full agreement renders sections 1 through 12 with no gaps', () => {
  const numbers = model().sections.map(s => s.n);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    'a missing number here is the Apps Script bug where Section 4 was computed and discarded');
});

test('Section 4 is the self-paced section and it has content', () => {
  const s4 = model().sections.find(s => s.n === 4);
  assert.ok(/self-paced/i.test(s4.title), 'Section 4 describes the self-paced track');
  assert.ok(s4.blocks && s4.blocks.length > 0, 'Section 4 must actually carry content, not just a heading');
});

test('every section has a title and at least one block', () => {
  for (const s of model().sections) {
    assert.ok(s.title, `section ${s.n} has no title`);
    assert.ok(Array.isArray(s.blocks) && s.blocks.length > 0, `section ${s.n} renders nothing`);
  }
});

// ── The stored legal record ──────────────────────────────────────────────────
// agreementSnapshot() is what lands in enrollment_requests.agreement_snapshot and
// is the record a dispute is settled from. It was the one function here with no
// coverage, which is the wrong function to leave uncovered.

test('the snapshot records who signed what, when, and as which tier', () => {
  const m = model('vip', { studentName: 'Juan dela Cruz', signedOn: 'August 20, 2026' });
  const snap = agreementSnapshot(m);
  assert.equal(snap.version, AGREEMENT_VERSION);
  assert.equal(snap.tier, 'vip');
  assert.equal(snap.plan_key, 'vip');
  assert.equal(snap.plan_name, 'Personalized Coaching Program');
  assert.equal(snap.student_name, 'Juan dela Cruz');
  assert.equal(snap.signed_on, 'August 20, 2026');
});

test('the snapshot stores the prices that were on screen, as numbers', () => {
  const snap = agreementSnapshot(model());
  assert.deepEqual(snap.prices, { sampler: 1499, silver: 2999, vip: 16999 });
  for (const v of Object.values(snap.prices)) {
    assert.equal(typeof v, 'number', 'a formatted string could not be compared or summed later');
  }
});

test('repricing a plan changes what the snapshot records', () => {
  const repriced = PLANS.map(p => (p.key === 'vip' ? { ...p, price_php: 19999 } : p));
  const snap = agreementSnapshot(agreementModel('vip', repriced));
  assert.equal(snap.prices.vip, 19999,
    'the amount shown at signing is exactly what a dispute turns on — it must not drift to the current price');
});

test('the snapshot carries the access term for every tier', () => {
  const snap = agreementSnapshot(model());
  assert.deepEqual(snap.access_labels, { sampler: '60 days', silver: '60 days', vip: '6 months' });
});

// ── Every sellable plan must map to a tier ───────────────────────────────────

// ★ Iterates the REAL catalog, not the fixture above. Reading the local PLANS
// const here would only re-assert the three keys this file already hardcodes, so
// adding a fourth plan to ENROLLMENT_PLANS_FALLBACK without touching
// TIER_BY_PLAN_KEY would leave the test green while a student on that plan signs
// a document with no tier highlighted and no price. test/planCatalog.test.mjs
// pins catalog↔entitlement parity the same way, for the same reason.
test('every plan in the live catalog resolves to an agreement tier', () => {
  assert.ok(ENROLLMENT_PLANS_FALLBACK.length >= 3, 'sanity: the catalog is non-trivial');
  for (const p of ENROLLMENT_PLANS_FALLBACK) {
    assert.ok(tierForPlanKey(p.key),
      `${p.key} is sellable but has no agreement tier — its buyer would sign a document naming neither their plan nor its price`);
  }
});

test('the catalog and the tier list are the same size', () => {
  assert.equal(ENROLLMENT_PLANS_FALLBACK.length, AGREEMENT_TIERS.length,
    'a tier with no plan prints an empty column; a plan with no tier cannot be signed for');
});

test('every agreement tier resolves a price from the catalog', () => {
  const m = agreementModel('vip', ENROLLMENT_PLANS_FALLBACK);
  for (const tier of AGREEMENT_TIERS) {
    const col = m.columns.find(c => c.key === tier);
    assert.ok(col, `tier ${tier} has no column`);
    assert.ok(col.pricePhp != null, `tier ${tier} resolved no plan row, so its column would print "—"`);
  }
});

// ── Pricing comes from the catalog, never from the document ──────────────────

test('column prices are read from the plan rows', () => {
  const cols = model().columns;
  assert.equal(cols.find(c => c.key === 'sampler').pricePhp, 1499);
  assert.equal(cols.find(c => c.key === 'silver').pricePhp, 2999);
  assert.equal(cols.find(c => c.key === 'vip').pricePhp, 16999);
});

test('repricing a plan reprices the agreement with no edit to this module', () => {
  const repriced = PLANS.map(p => (p.key === 'vip' ? { ...p, price_php: 19999 } : p));
  const m = agreementModel('vip', repriced);
  assert.equal(m.columns.find(c => c.key === 'vip').pricePhp, 19999,
    'the hardcoded table is exactly how the source came to print ₱15,999 on a ₱16,999 sale');
  assert.ok(asText(m).includes('19999') || asText(m).includes('19,999'));
});

test('the investment row reflects catalog prices for all three tiers', () => {
  const row = model().rows.find(r => !r.divider && /investment/i.test(r.feature));
  assert.ok(row, 'the comparison table states what each tier costs');
  assert.ok(String(row.sampler).includes('1,499'));
  assert.ok(String(row.silver).includes('2,999'));
  assert.ok(String(row.vip).includes('16,999'));
});

// ── Three columns, every cell filled ─────────────────────────────────────────

test('all three live plans get a column', () => {
  assert.deepEqual(model().columns.map(c => c.key), ['sampler', 'silver', 'vip']);
  assert.deepEqual([...AGREEMENT_TIERS], ['sampler', 'silver', 'vip']);
});

test('no comparison cell is left undefined', () => {
  for (const row of model().rows) {
    if (row.divider) continue;
    for (const tier of AGREEMENT_TIERS) {
      assert.notEqual(row[tier], undefined,
        `row "${row.feature}" has no value for ${tier} — it would render as an empty cell on a signed document`);
    }
  }
});

test('the selected tier is the one marked chosen', () => {
  assert.equal(model('sampler').columns.find(c => c.selected).key, 'sampler');
  assert.equal(model('silver_self_paced').columns.find(c => c.selected).key, 'silver');
});

// ── The decisions taken on 2026-08-20 ────────────────────────────────────────

test('all three tiers earn a Certificate of Completion', () => {
  const row = model().rows.find(r => !r.divider && /certificate/i.test(r.feature));
  assert.ok(row, 'the certificate row exists');
  for (const tier of AGREEMENT_TIERS) {
    assert.equal(row[tier], true, `${tier} earns a certificate — confirmed 2026-08-20`);
  }
});

test('VIP resume coaching is two separate inclusions, not one contradictory row', () => {
  const rows = model().rows.filter(r => !r.divider && /resume\s*&?\s*interview coaching/i.test(r.feature));
  assert.equal(rows.length, 2,
    'the source had "4 Live Group" and "1-on-1 (1 session)" competing as one row; they are two things');

  const group = rows.find(r => /group/i.test(r.feature));
  const oneOnOne = rows.find(r => /1-on-1|one-on-one/i.test(r.feature));
  assert.ok(group && oneOnOne, 'one group row and one 1-on-1 row');
  for (const row of rows) {
    assert.equal(row.vip, true, 'VIP receives both');
    assert.equal(row.silver, false);
    assert.equal(row.sampler, false);
  }
});

test('Sampler gets the Essentials course only, never Mastery', () => {
  const row = model().rows.find(r => !r.divider && /QBO Mastery Course/i.test(r.feature) && !/access/i.test(r.feature));
  assert.ok(row, 'the course-access row exists');
  assert.ok(/essentials/i.test(String(row.sampler)),
    "Sampler's courseTier is 'essentials' — saying plain ✓ here would promise Mastery");
  assert.notEqual(row.sampler, true, 'a bare check mark would overstate what Sampler buys');
});

test('Sampler gets no Resume & Interview course', () => {
  const row = model().rows.find(r => !r.divider && /Resume & Interview Course/i.test(r.feature));
  assert.equal(row.sampler, false, 'resumestrategy is not in the sampler tab allowlist');
  assert.equal(row.silver, true);
  assert.equal(row.vip, true);
});

test('Sampler has its own live-session row', () => {
  const row = model().rows.find(r => !r.divider && /1 Live Zoom Session/i.test(r.feature));
  assert.ok(row, 'the ₱1,499 buys one live coaching session — that is the whole product');
  assert.equal(row.sampler, true);
});

// ── Stale copy from the source must not survive the port ─────────────────────

test('the agreement says Community, never Discord', () => {
  assert.ok(!/discord/i.test(asText(model())),
    'Discord was replaced by the in-app Community — a signed document must not promise a dead channel');
});

test('the agreement never mentions Thinkific', () => {
  assert.ok(!/thinkific/i.test(asText(model())),
    'certification now depends on completion in this platform, not the retired Thinkific');
});

test('the extension line does not hardcode a price the app would not charge', () => {
  const text = asText(model());
  assert.ok(!/999\s*\/\s*month|₱999/.test(text),
    'extensionPrice() computes ₱2,999 for a 2-month Silver top-up; the source promised ₱999');
});

test('no retired plan names appear', () => {
  const text = asText(model());
  for (const dead of ['Gold', 'Core Self', 'core_self_paced', 'gold_live']) {
    assert.ok(!text.includes(dead), `"${dead}" was deleted by migration #39`);
  }
});

// ── Durations follow access_days ─────────────────────────────────────────────

test('accessLabel renders long terms as months and short ones as days', () => {
  assert.equal(accessLabel(180), '6 months');
  assert.equal(accessLabel(60), '60 days');
  assert.equal(accessLabel(90), '3 months');
  assert.equal(accessLabel(365), '365 days');
});

test('the duration row follows each plan access_days', () => {
  const row = model().rows.find(r => !r.divider && /QBO Mastery Course Access/i.test(r.feature));
  assert.equal(row.vip, '6 months', 'VIP access_days is 180');
  assert.equal(row.silver, '60 days');
  assert.equal(row.sampler, '60 days');
});

test('changing access_days changes the stated duration', () => {
  const longer = PLANS.map(p => (p.key === 'silver_self_paced' ? { ...p, access_days: 120 } : p));
  const row = agreementModel('silver_self_paced', longer)
    .rows.find(r => !r.divider && /QBO Mastery Course Access/i.test(r.feature));
  assert.equal(row.silver, '4 months');
});

// ── Student-facing content survives the port ─────────────────────────────────

test('all seven student pledges are present', () => {
  const m = model();
  assert.equal(m.pledges.length, 7, 'the source lists seven promises');
  assert.ok(m.pledges.some(p => /camera on/i.test(p)));
  assert.ok(m.pledges.some(p => /no guarantee of employment/i.test(p)));
});

test('the coach commitments are present', () => {
  assert.ok(model().coachCommitments.length >= 4);
});

test('course coverage lists all eight items including the US tax forms', () => {
  const m = model();
  assert.equal(m.coverage.length, 8);
  assert.ok(m.coverage.some(c => /1120S/.test(c)), 'the US Tax Forms 101 line is specific and must survive verbatim');
});

test('the student name and signing date are carried into the model', () => {
  const m = model('vip', { studentName: 'Juan dela Cruz', signedOn: 'August 20, 2026' });
  assert.equal(m.studentName, 'Juan dela Cruz');
  assert.equal(m.signedOn, 'August 20, 2026');
});

test('a missing student name does not break the document', () => {
  const m = model('vip', {});
  assert.equal(typeof m.studentName, 'string', 'an unfilled name renders as a blank line, not undefined');
});
