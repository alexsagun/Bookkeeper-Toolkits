// test/legacyMigration.test.mjs — the pure rules behind the legacy Thinkific migration (#67).
//
// SYNTHETIC DATA ONLY. The real rosters are gitignored and must never appear in a
// fixture, a snapshot or a failure message. The generator below reproduces the
// authoritative file's SHAPE — 58 August, 65 September, 18 October, VIP, Paid,
// ₱15,999, blank Thinkific ids, M/D/YYYY dates, batch display names — with invented
// people at example.test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ACTIVATION_STATES, ACTIVATION_TRANSITIONS, DATE_FORMATS, GRACE_DAYS, INVITE_STATES,
  LEGACY_ERROR_LABELS, LEGACY_FIELDS, LEGACY_WARNING_LABELS, MAX_ACTIVATION_RUN,
  STALE_CLAIM_MINUTES, ACTIVATION_FUNCTION_MAX_SECONDS, VALIDATION_STATUSES,
  activationPhrase, activationPreflight, autoMapLegacyHeaders, canTransition, cohortSummary,
  defaultEligibleCodes, distinctLabels, formatCalendarDate, labelMonthCode, legacyRecordKeyInput,
  manilaTerm, missingRequiredFields, normalizeLegacyRows, normalizePaymentStatus,
  parseDateByFormat, parseLegacyAmount, phraseMatches, rowDisplayState, startDateFitsBatch,
  suggestBatchForLabel, suggestPlanForLabel, termStatusAt,
  defaultActivationStart, effectiveTerms, manilaTodayISO, normalizePhone,
  // #68
  NON_VIP_BATCH_TOKEN, TERM_LENGTH_TOLERANCE_DAYS, defaultEligiblePlanKeys, isVipPlan, legacySeatCount,
  planRank, planSummary, termDays,
} from '../src/lib/legacyMigration.js';
import { parseCsv, parseStrictDate } from '../src/lib/studentImport.js';

// ── Synthetic fixtures ───────────────────────────────────────────────────────

const HEADERS = ['thinkific_user_id', 'first_name', 'last_name', 'email', 'plan_key',
  'membership_started_at', 'membership_ends_at', 'payment_status', 'amount_paid', 'currency',
  'legacy_enrollments', 'batch_code'];

const COHORTS = [
  { label: 'September 2026', start: '9/2/2026', end: '3/2/2027', n: 65 },
  { label: 'October 2026', start: '10/12/2026', end: '4/12/2027', n: 18 },
  { label: 'August 2026', start: '8/3/2026', end: '2/3/2027', n: 58 },
];

function syntheticRoster() {
  const rows = [];
  let i = 0;
  for (const c of COHORTS) {
    for (let k = 0; k < c.n; k += 1) {
      i += 1;
      rows.push({
        thinkific_user_id: '', first_name: `Test${i}`, last_name: 'Student',
        email: `student${String(i).padStart(3, '0')}@example.test`, plan_key: 'VIP',
        membership_started_at: c.start, membership_ends_at: c.end, payment_status: 'Paid',
        amount_paid: '15999', currency: 'PHP', legacy_enrollments: '', batch_code: c.label,
      });
    }
  }
  return rows;
}

/** The misplaced-column layout: plan holds the month, batch holds "VIP", 2-digit years. */
function misplacedRoster() {
  return syntheticRoster().map((r) => ({
    ...r,
    plan_key: r.batch_code === 'October 2026' ? 'Oct-26' : 'Sep-26',
    legacy_enrollments: 'Sep-26',
    batch_code: 'VIP',
    membership_started_at: '9/1/26',
    membership_ends_at: '3/1/27',
  }));
}

// The catalog as #68 leaves it: the package title is the NAME, the product line the
// TAGLINE, and community_segment is what decides whether a row takes a batch.
const PLANS = [
  { key: 'sampler', name: 'Essentials', tagline: 'Sampler Session', price_php: 1499, active: true,
    access_days: 60, community_segment: 'general' },
  { key: 'silver_self_paced', name: 'Silver · Self-Paced', tagline: 'QBO + Resume Combo', price_php: 2999, active: true,
    access_days: 60, community_segment: 'general' },
  { key: 'vip', name: 'VIP Package', tagline: 'Personalized Coaching Program', price_php: 16999, active: true,
    access_days: 180, community_segment: 'vip' },
];
const BATCHES = [
  { id: 'b08', code: '2026-08', name: 'August 2026', status: 'closed' },
  { id: 'b09', code: '2026-09', name: 'September 2026', status: 'open' },
  { id: 'b10', code: '2026-10', name: 'October 2026', status: 'open' },
  { id: 'b12', code: '2026-12', name: 'December 2026', status: 'open' },
];
const NOW = Date.UTC(2026, 8, 25, 4, 0, 0);   // 2026-09-25 12:00 Manila

const baseOpts = (extra = {}) => ({
  mapping: autoMapLegacyHeaders(HEADERS),
  dateFormat: 'M/D/YYYY',
  planMapping: { vip: 'vip' },
  batchMapping: { 'august 2026': '2026-08', 'september 2026': '2026-09', 'october 2026': '2026-10' },
  plans: PLANS,
  batches: BATCHES,
  eligibleBatchCodes: ['2026-10'],
  nowMs: NOW,
  ...extra,
});

// ── Header mapping ───────────────────────────────────────────────────────────

test('the template headers map onto every canonical field', () => {
  const m = autoMapLegacyHeaders(HEADERS);
  assert.equal(m.external_user_id, 'thinkific_user_id');
  assert.equal(m.plan_label, 'plan_key');
  assert.equal(m.start_date, 'membership_started_at');
  assert.equal(m.end_date, 'membership_ends_at');
  assert.equal(m.batch_label, 'batch_code');
  assert.deepEqual(missingRequiredFields(m), []);
});

test('a roster without the dates reports the required fields it lacks', () => {
  const m = autoMapLegacyHeaders(['email', 'plan_key', 'batch_code', 'payment_status']);
  assert.deepEqual(missingRequiredFields(m).sort(), ['end_date', 'start_date']);
});

test('every required field is named, and the labels cover every code', () => {
  // #68: the batch is NOT required — a Silver or Essentials export has no cohort column.
  assert.deepEqual(LEGACY_FIELDS.filter((f) => f.required).map((f) => f.key).sort(),
    ['email', 'end_date', 'payment_status', 'plan_label', 'start_date']);
  for (const code of ['email_missing', 'plan_unmapped', 'batch_label_mismatch', 'payment_not_paid',
    'term_ended', 'duplicate_in_file', 'duplicate_staged', 'profile_rejected', 'staff_account',
    'membership_conflict', 'identity_mismatch',
    // #68
    'multiple_plans_in_file', 'grandfathered_member', 'higher_plan_pending', 'record_key_missing']) {
    assert.ok(LEGACY_ERROR_LABELS[code], `${code} needs a label`);
  }
  for (const code of ['external_id_missing', 'phone_shared', 'existing_account', 'amount_differs_from_price',
    'batch_ignored_for_plan', 'term_length_unusual', 'other_legacy_row']) {
    assert.ok(LEGACY_WARNING_LABELS[code], `${code} needs a label`);
  }
  // A code is an error OR a warning, never both — the workspace would not know which to show.
  for (const code of Object.keys(LEGACY_WARNING_LABELS)) {
    assert.equal(LEGACY_ERROR_LABELS[code], undefined, `${code} is labelled as both`);
  }
});

// #68 review, S1: a held lower-package row was told to "Activate or discard that row first" —
// but no per-row discard exists (only a whole job's), so the copy sent the owner looking for
// a button that is not there. It names the two exits that are real.
test('the higher-package hold names only exits that exist', () => {
  const t = LEGACY_ERROR_LABELS.higher_plan_pending;
  assert.equal(t, 'The same person has a higher package waiting in another roster. Activate that row first, or change its terms.');
  assert.doesNotMatch(t, /discard/i, 'there is no per-row discard');
  assert.doesNotMatch(t, /\bplan\b/i, 'the owner reads "package", as everywhere else in #68');
});

test('a roster with no batch column is not missing anything required (#68)', () => {
  const m = autoMapLegacyHeaders(['email', 'plan', 'start_date', 'end_date', 'payment_status']);
  assert.equal(m.batch_label, undefined);
  assert.deepEqual(missingRequiredFields(m), []);
  assert.equal(LEGACY_FIELDS.find((f) => f.key === 'batch_label').required, false);
});

test('a bare "ID" column is never auto-mapped as the Thinkific user id (#68)', () => {
  // An Orders export's order number and a hand-built roster's row counter are both "ID".
  const f = LEGACY_FIELDS.find((x) => x.key === 'external_user_id');
  assert.ok(!f.aliases.includes('id'));
  for (const h of ['id', 'ID', ' Id ']) {
    assert.equal(autoMapLegacyHeaders([h, 'email']).external_user_id, undefined, `${JSON.stringify(h)} must not map`);
  }
  assert.equal(autoMapLegacyHeaders(['user_id', 'email']).external_user_id, 'user_id');
  assert.equal(autoMapLegacyHeaders(['ID', 'thinkific_user_id']).external_user_id, 'thinkific_user_id');
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('M/D/YYYY is read as month first, and only when declared', () => {
  assert.deepEqual(parseDateByFormat('10/12/2026', 'M/D/YYYY'), { valid: true, iso: '2026-10-12' });
  assert.deepEqual(parseDateByFormat('10/12/2026', 'D/M/YYYY'), { valid: true, iso: '2026-12-10' });
  assert.equal(parseDateByFormat('10/12/2026', 'auto').valid, false, 'there is no guessing mode');
  assert.equal(parseDateByFormat('10/12/2026', undefined).valid, false);
});

test('an impossible date is refused, never rolled over', () => {
  assert.equal(parseDateByFormat('2/31/2026', 'M/D/YYYY').valid, false);
  assert.equal(parseDateByFormat('13/1/2026', 'M/D/YYYY').valid, false);
  assert.equal(parseDateByFormat('2/29/2027', 'M/D/YYYY').valid, false);
  assert.equal(parseDateByFormat('2/29/2028', 'M/D/YYYY').valid, true, 'a real leap day is fine');
  assert.equal(parseDateByFormat('2026-02-31', 'YYYY-MM-DD').valid, false);
});

test('a two-digit year is refused rather than guessed', () => {
  assert.equal(parseDateByFormat('9/1/26', 'M/D/YYYY').valid, false);
});

test('parseStrictDate no longer rolls an impossible ISO date into the next month', () => {
  assert.equal(parseStrictDate('2026-02-31').valid, false);
  assert.equal(parseStrictDate('2026-13-01').valid, false);
  assert.equal(parseStrictDate('2026-02-28').valid, true);
  assert.equal(parseStrictDate('2026-02-28 25:00:00 UTC').valid, false);
});

test('a term starts at 00:00 Manila and ends at the last millisecond of its end date', () => {
  const t = manilaTerm('2026-10-12', '2027-04-12');
  assert.equal(t.startedAt, '2026-10-11T16:00:00.000Z');
  assert.equal(t.endsAt, '2027-04-12T15:59:59.999Z');
  assert.equal(t.graceEndsAt, '2027-04-15T15:59:59.999Z');
  assert.equal(GRACE_DAYS, 3);
});

test('an October term is scheduled today, active on October 12, ended after grace', () => {
  assert.equal(termStatusAt('2026-10-12', '2027-04-12', NOW), 'scheduled');
  assert.equal(termStatusAt('2026-10-12', '2027-04-12', Date.UTC(2026, 9, 11, 16, 0, 0)), 'active');
  assert.equal(termStatusAt('2026-10-12', '2027-04-12', Date.UTC(2026, 9, 11, 15, 59, 59)), 'scheduled');
  assert.equal(termStatusAt('2026-10-12', '2027-04-12', Date.UTC(2027, 3, 15, 16, 0, 0)), 'ended');
  assert.equal(termStatusAt('2026-09-02', '2027-03-02', NOW), 'active');
});

test('calendar dates format without a locale', () => {
  assert.equal(formatCalendarDate('2026-10-12'), 'October 12, 2026');
  assert.equal(formatCalendarDate('2027-04-12'), 'April 12, 2027');
});

// ── Plans, payment, amounts ──────────────────────────────────────────────────

test('VIP is only SUGGESTED as vip; staging needs the confirmed mapping', () => {
  assert.equal(suggestPlanForLabel('VIP', PLANS), 'vip');
  assert.equal(suggestPlanForLabel('Sep-26', PLANS), null);
  assert.equal(suggestPlanForLabel('15999', PLANS), null, 'a price is never a plan');
  const rows = normalizeLegacyRows(syntheticRoster().slice(0, 3), baseOpts({ planMapping: {} }));
  assert.ok(rows.every((r) => r.errors.includes('plan_unmapped') && r.activation_state === 'blocked'));
});

// ★ #68: "Essentials" and "Silver" used to match nothing, and the picker listed product
//   names only, so an Essentials roster was one plausible click from full-access Silver.
test('package titles, product lines and their short forms all suggest the right plan', () => {
  const expect = {
    vip: ['VIP', 'VIP Package', 'vip package', 'Personalized Coaching Program', '  personalized   coaching program '],
    silver_self_paced: ['Silver', 'Silver · Self-Paced', 'SILVER · SELF-PACED', 'QBO + Resume Combo', 'silver_self_paced'],
    sampler: ['Essentials', 'Sampler Session', 'Sampler', 'sampler'],
  };
  for (const [key, labels] of Object.entries(expect)) {
    for (const label of labels) assert.equal(suggestPlanForLabel(label, PLANS), key, `${JSON.stringify(label)} → ${key}`);
  }
});

test('plan suggestions stay exact: no substring, no price, no guess', () => {
  for (const label of ['Self-Paced', 'Package', 'Coaching', 'QBO', 'Resume', 'Sampler Sessions', 'VIP 2026',
    'Silver Package', '1499', '₱16,999', '', '   ', null, undefined]) {
    assert.equal(suggestPlanForLabel(label, PLANS), null, `${JSON.stringify(label)} must suggest nothing`);
  }
  assert.equal(suggestPlanForLabel('VIP', []), null);
  assert.equal(suggestPlanForLabel('VIP', undefined), null);
});

test('a label two plans both claim suggests nothing rather than the first one', () => {
  const clash = [
    { key: 'a_plan', name: 'Starter · Monthly', tagline: 'One' },
    { key: 'b_plan', name: 'Starter Package', tagline: 'Two' },
  ];
  assert.equal(suggestPlanForLabel('Starter', clash), null, '"starter" is the short form of both');
  assert.equal(suggestPlanForLabel('Starter Package', clash), 'b_plan', 'the full title is still unique');
  assert.equal(suggestPlanForLabel('One', clash), 'a_plan');
});

test('isVipPlan reads the community segment and nothing else', () => {
  assert.equal(isVipPlan(PLANS[2]), true);
  assert.equal(isVipPlan(PLANS[0]), false);
  assert.equal(isVipPlan(PLANS[1]), false);
  assert.equal(isVipPlan({ key: 'vip' }), false, 'the key is not the segment');
  assert.equal(isVipPlan(null), false);
  assert.equal(isVipPlan(undefined), false);
});

test('plan rank is an explicit order, never a price', () => {
  assert.equal(planRank('vip'), 3);
  assert.equal(planRank('silver_self_paced'), 2);
  assert.equal(planRank('sampler'), 1);
  for (const k of ['gold_live', 'core_self_paced', '', null, undefined, 'toString', '__proto__', 'constructor']) {
    assert.equal(planRank(k), 0, `${String(k)} ranks nothing`);
  }
  assert.ok(planRank('vip') > planRank('silver_self_paced') && planRank('silver_self_paced') > planRank('sampler'));
});

test('only an explicit Paid is paid', () => {
  assert.deepEqual(normalizePaymentStatus('Paid'), { status: 'paid', paid: true });
  assert.deepEqual(normalizePaymentStatus('PAID'), { status: 'paid', paid: true });
  assert.equal(normalizePaymentStatus('Pending').paid, false);
  assert.equal(normalizePaymentStatus('').status, null);
});

test('the historical ₱15,999 is kept as paid history, and only warned about', () => {
  const [r] = normalizeLegacyRows(syntheticRoster().filter((x) => x.batch_code === 'October 2026').slice(0, 1), baseOpts());
  assert.equal(r.amount_paid, 15999);
  assert.equal(r.currency, 'PHP');
  assert.equal(r.validation_status, 'valid', 'a price change since the purchase never blocks it');
  assert.ok(r.warnings.includes('amount_differs_from_price'));
});

test('amounts outside 0–1,000,000 or with junk are refused', () => {
  assert.equal(parseLegacyAmount('15,999').amount, 15999);
  assert.equal(parseLegacyAmount('15999.50').amount, 15999.5);
  assert.equal(parseLegacyAmount('9171234567').valid, false);
  assert.equal(parseLegacyAmount('₱15999').valid, false);
  assert.equal(parseLegacyAmount('').valid, true);
});

// ── Batches ──────────────────────────────────────────────────────────────────

test('a batch label must name the same month as the registry batch it maps to', () => {
  assert.equal(labelMonthCode('October 2026'), '2026-10');
  assert.equal(labelMonthCode('Oct 2026'), '2026-10');
  assert.equal(labelMonthCode('2026-10'), '2026-10');
  assert.equal(labelMonthCode('VIP'), null);
  assert.equal(suggestBatchForLabel('October 2026', BATCHES), '2026-10');
  const renamed = BATCHES.map((b) => (b.code === '2026-09' ? { ...b, name: 'October 2026' } : b));
  assert.equal(suggestBatchForLabel('October 2026', renamed.filter((b) => b.code !== '2026-10')), null,
    'a renamed batch produces no suggestion rather than a wrong one');
});

test('a mapping to the wrong month blocks the row', () => {
  const rows = normalizeLegacyRows(syntheticRoster().filter((r) => r.batch_code === 'October 2026').slice(0, 2),
    baseOpts({ batchMapping: { 'october 2026': '2026-12' } }));
  assert.ok(rows.every((r) => r.errors.includes('batch_label_mismatch')));
  assert.ok(rows.every((r) => r.errors.includes('batch_date_mismatch')));
});

test('the start date must fall in or next to the batch month', () => {
  assert.equal(startDateFitsBatch('2026-10-12', '2026-10'), true);
  assert.equal(startDateFitsBatch('2026-09-30', '2026-10'), true);
  assert.equal(startDateFitsBatch('2026-08-03', '2026-10'), false);
});

// ── The authoritative roster, classified ─────────────────────────────────────

test('the 141-row roster stages as 18 ready and 123 inactive, with nothing blocked', () => {
  const rows = normalizeLegacyRows(syntheticRoster(), baseOpts());
  assert.equal(rows.length, 141);
  const ready = rows.filter((r) => r.activation_state === 'ready');
  const inactive = rows.filter((r) => r.activation_state === 'inactive');
  assert.equal(ready.length, 18);
  assert.equal(inactive.length, 123);
  assert.ok(ready.every((r) => r.batch_code === '2026-10' && r.start_date === '2026-10-12' && r.end_date === '2027-04-12'));
  assert.equal(inactive.filter((r) => r.batch_code === '2026-08').length, 58);
  assert.equal(inactive.filter((r) => r.batch_code === '2026-09').length, 65);
  assert.ok(rows.every((r) => r.plan_key === 'vip' && r.identity_basis === 'email'));
  assert.ok(rows.every((r) => r.warnings.includes('external_id_missing')));
});

test('the August and September dates are kept exactly, never moved to October', () => {
  const rows = normalizeLegacyRows(syntheticRoster(), baseOpts());
  const aug = rows.find((r) => r.batch_code === '2026-08');
  const sep = rows.find((r) => r.batch_code === '2026-09');
  assert.deepEqual([aug.start_date, aug.end_date], ['2026-08-03', '2027-02-03']);
  assert.deepEqual([sep.start_date, sep.end_date], ['2026-09-02', '2027-03-02']);
});

test('only the newest cohort is pre-selected for activation', () => {
  const rows = normalizeLegacyRows(syntheticRoster(), baseOpts({ eligibleBatchCodes: [] }));
  assert.ok(rows.every((r) => r.activation_state !== 'ready'), 'no cohort is ready unless chosen');
  assert.deepEqual(defaultEligibleCodes(rows), ['2026-10']);
});

test('cohort summary counts per batch', () => {
  const s = cohortSummary(normalizeLegacyRows(syntheticRoster(), baseOpts()));
  assert.deepEqual(s.map((g) => [g.batch_code, g.total, g.ready, g.inactive, g.blocked]), [
    ['2026-08', 58, 0, 58, 0], ['2026-09', 65, 0, 65, 0], ['2026-10', 18, 18, 0, 0],
  ]);
});

test('the misplaced-column roster blocks every row instead of guessing', () => {
  const rows = normalizeLegacyRows(misplacedRoster(), baseOpts({
    planMapping: { vip: 'vip' },
    batchMapping: { 'october 2026': '2026-10' },
  }));
  assert.equal(rows.length, 141);
  assert.ok(rows.every((r) => r.activation_state === 'blocked'), 'not one row may stage as ready or inactive');
  assert.ok(rows.every((r) => r.errors.includes('start_date_invalid') && r.errors.includes('plan_unmapped')));
  // #68: with no confirmed plan there is no segment to ask, so the batch rules are
  // skipped — the row is already blocked, and SQL (which asks the segment) agrees.
  assert.ok(rows.every((r) => !r.errors.some((e) => e.startsWith('batch_')) && r.batch_code === null));
  assert.ok(rows.every((r) => !r.warnings.includes('batch_ignored_for_plan')),
    'an unknown plan is not a non-VIP plan — nothing is said about its batch');
});

test('a VIP roster that maps its plan still gets every batch check', () => {
  const rows = normalizeLegacyRows(misplacedRoster().slice(0, 3), baseOpts({
    planMapping: { 'sep-26': 'vip', 'oct-26': 'vip' },
    batchMapping: {},
  }));
  assert.ok(rows.every((r) => r.errors.includes('batch_unmapped') && r.activation_state === 'blocked'));
});

test('the same email twice in one file is a duplicate on both rows', () => {
  const src = syntheticRoster().slice(0, 3);
  src[2] = { ...src[2], email: src[0].email.toUpperCase() };
  const rows = normalizeLegacyRows(src, baseOpts());
  assert.equal(rows[0].validation_status, 'duplicate');
  assert.equal(rows[2].validation_status, 'duplicate');
  assert.equal(rows[1].validation_status, 'valid');
  assert.ok(!rows[0].errors.includes('multiple_plans_in_file'), 'the same plan twice is a plain duplicate');
});

test('an ended term, a missing email and an unpaid row are blocked', () => {
  const src = syntheticRoster().slice(0, 3);
  src[0] = { ...src[0], membership_started_at: '1/1/2025', membership_ends_at: '6/1/2025' };
  src[1] = { ...src[1], email: '' };
  src[2] = { ...src[2], payment_status: 'Refunded' };
  const rows = normalizeLegacyRows(src, baseOpts());
  assert.ok(rows[0].errors.includes('term_ended'));
  assert.ok(rows[1].errors.includes('email_missing'));
  assert.ok(rows[2].errors.includes('payment_not_paid'));
  assert.ok(rows.every((r) => r.activation_state === 'blocked'));
});

test('a declared date format is mandatory', () => {
  assert.throws(() => normalizeLegacyRows(syntheticRoster(), baseOpts({ dateFormat: null })), /date format/);
  assert.deepEqual(DATE_FORMATS, ['M/D/YYYY', 'D/M/YYYY', 'YYYY-MM-DD']);
});

test('distinct labels feed the mapping tables', () => {
  const src = syntheticRoster();
  const plans = distinctLabels(src, autoMapLegacyHeaders(HEADERS), 'plan_label');
  assert.deepEqual(plans.map((p) => [p.label, p.count]), [['VIP', 141]]);
  const batches = distinctLabels(src, autoMapLegacyHeaders(HEADERS), 'batch_label');
  assert.deepEqual(batches.map((b) => b.label).sort(), ['August 2026', 'October 2026', 'September 2026']);
});

// ── Record keys ──────────────────────────────────────────────────────────────

test('the record key is identity + plan + cohort, and deterministic', () => {
  const a = legacyRecordKeyInput({ externalId: '', email: 'a@example.test', planKey: 'vip', batchCode: '2026-10' });
  assert.equal(a, 'thinkific|email:a@example.test|vip|2026-10');
  const b = legacyRecordKeyInput({ externalId: '007', email: 'a@example.test', planKey: 'vip', batchCode: '2026-10' });
  assert.equal(b, 'thinkific|ext:007|vip|2026-10', 'a real external id is the identity when present');
  const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  assert.equal(hash(a), hash(a));
  assert.match(hash(a), /^[0-9a-f]{64}$/);
  const [r1] = normalizeLegacyRows(syntheticRoster().slice(0, 1), baseOpts());
  const [r2] = normalizeLegacyRows(syntheticRoster().slice(0, 1), baseOpts());
  assert.equal(r1.record_key_input, r2.record_key_input);
});

// ── Activation ───────────────────────────────────────────────────────────────

test('the typed phrase must match the server count exactly', () => {
  assert.equal(activationPhrase(18), 'ACTIVATE 18');
  assert.equal(phraseMatches(' ACTIVATE 18 ', 18), true);
  assert.equal(phraseMatches('activate 18', 18), false);
  assert.equal(phraseMatches('ACTIVATE 17', 18), false);
});

test('the preflight counts only ready rows, and counts claims by confirmation', () => {
  const sel = [
    { activation_state: 'ready', batch_code: '2026-10', plan_key: 'vip', start_date: '2026-10-12', end_date: '2027-04-12' },
    { activation_state: 'ready', batch_code: '2026-10', plan_key: 'vip', matched_existing: true, existing_confirmed: true, start_date: '2026-10-12', end_date: '2027-04-12' },
    { activation_state: 'ready', batch_code: '2026-10', plan_key: 'vip', matched_existing: true, existing_confirmed: false, start_date: '2026-10-12', end_date: '2027-04-12' },
    { activation_state: 'inactive', batch_code: '2026-09', plan_key: 'vip' },
  ];
  const p = activationPreflight(sel);
  assert.equal(p.selected, 4);
  assert.equal(p.toActivate, 3);
  assert.equal(p.excluded, 1, 'an inactive row can never ride along');
  assert.equal(p.newAccounts, 1);
  assert.equal(p.existingAccounts, 2);
  assert.equal(p.notifications, 1);
  assert.equal(p.claimEmails, 2, 'an unconfirmed existing account still needs a claim link');
  assert.deepEqual(p.cohorts, ['2026-10']);
  assert.equal(p.phrase, 'ACTIVATE 3');
});

test('the state machine only moves along its edges', () => {
  assert.equal(canTransition('inactive', 'promote'), true);
  assert.equal(canTransition('inactive', 'claim'), false, 'an inactive row cannot be activated directly');
  assert.equal(canTransition('ready', 'claim'), true);
  assert.equal(canTransition('failed', 'claim'), true);
  assert.equal(canTransition('activated', 'claim'), false, 'a successful row is never repeated');
  assert.equal(canTransition('activated', 'revert'), true);
  assert.equal(canTransition('reverted', 'promote'), false);
  for (const t of Object.values(ACTIVATION_TRANSITIONS)) {
    assert.ok(ACTIVATION_STATES.includes(t.to));
    for (const f of t.from) assert.ok(ACTIVATION_STATES.includes(f));
  }
});

test('rows read in the owner\'s terms', () => {
  assert.equal(rowDisplayState({ activation_state: 'ready' }), 'Pending activation');
  assert.equal(rowDisplayState({ activation_state: 'inactive' }), 'Inactive');
  assert.equal(rowDisplayState({ activation_state: 'activated', invite_state: 'failed' }), 'Invitation failed');
  assert.equal(rowDisplayState({ activation_state: 'activated', invite_state: 'sent', claimed: true }), 'Onboarded');
  assert.equal(rowDisplayState({ activation_state: 'activated', invite_state: 'sent' }), 'Activated');
});

test('vocabularies and limits stay what the SQL expects', () => {
  assert.deepEqual(VALIDATION_STATUSES, ['valid', 'blocked', 'duplicate']);
  assert.ok(INVITE_STATES.includes('uncertain') && INVITE_STATES.includes('notified'));
  assert.equal(MAX_ACTIVATION_RUN, 200);
  assert.ok(STALE_CLAIM_MINUTES * 60 > ACTIVATION_FUNCTION_MAX_SECONDS,
    'a live request must never have its row re-claimed out from under it');
});

test('the synthetic roster round-trips through the CSV parser', () => {
  const src = syntheticRoster();
  const csv = [HEADERS.join(','), ...src.map((r) => HEADERS.map((h) => r[h]).join(','))].join('\n');
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.rows.length, 141);
  assert.equal(normalizeLegacyRows(parsed.rows, baseOpts()).filter((r) => r.activation_state === 'ready').length, 18);
});

test('a phone is normalized to digits and is a hint, never an identity', () => {
  assert.equal(normalizePhone('+63 917 123 4567'), '639171234567');
  assert.equal(normalizePhone('(0917) 123-4567'), '09171234567');
  assert.equal(normalizePhone('12345'), null, 'too short to be a phone');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('1'.repeat(16)), null, 'longer than E.164 allows');
  assert.ok(LEGACY_FIELDS.some((x) => x.key === 'phone' && !x.required), 'phone is optional');
  const mapping = { ...autoMapLegacyHeaders([...HEADERS, 'phone']) };
  assert.equal(mapping.phone, 'phone', 'a phone column is recognised');
  const rows = syntheticRoster().slice(0, 3).map((r, i) => ({ ...r, phone: i < 2 ? '0917 000 0001' : '0917 000 0002' }));
  const out = normalizeLegacyRows(rows, { ...baseOpts(), mapping });
  assert.ok(out[0].warnings.includes('phone_shared') && out[1].warnings.includes('phone_shared'));
  assert.ok(!out[2].warnings.includes('phone_shared'));
  assert.ok(out.every((r) => !r.errors.includes('phone_shared')), 'a shared phone never blocks a row');
  assert.ok(LEGACY_WARNING_LABELS.phone_shared);
});

// ★ OPEN ACCESS ON THE ACTIVATION DAY (owner decision, 2026-09-26): a start still ahead is
//   brought forward to today; a start already past is kept. The end never moves here.
test('the activation start defaults to today for a future start, and keeps a past one', () => {
  assert.equal(defaultActivationStart('2026-10-12', '2026-09-26'), '2026-09-26');
  assert.equal(defaultActivationStart('2026-09-02', '2026-09-26'), '2026-09-02');
  assert.equal(defaultActivationStart('2026-09-26', '2026-09-26'), '2026-09-26');
  // Manila is UTC+8: 17:00 UTC on the 25th is already the 26th there.
  assert.equal(manilaTodayISO(Date.UTC(2026, 8, 25, 17, 0)), '2026-09-26');
  assert.equal(manilaTodayISO(Date.UTC(2026, 8, 25, 15, 59)), '2026-09-25');
});

test('effective terms are what the Super Admin assigned, else what the roster said', () => {
  const roster = { proposed_plan_key: 'vip', proposed_batch_id: 'b1', legacy_start_date: '2026-10-12', legacy_end_date: '2027-04-12' };
  assert.deepEqual(effectiveTerms(roster), { plan_key: 'vip', batch_id: 'b1', start_date: '2026-10-12', end_date: '2027-04-12' });
  assert.deepEqual(effectiveTerms({ ...roster, activation_start_date: '2026-09-26' }),
    { plan_key: 'vip', batch_id: 'b1', start_date: '2026-09-26', end_date: '2027-04-12' },
    'only the assigned term changes; the paid end stays');
});

// ── #68: Silver, Essentials and mixed rosters ────────────────────────────────
// A batch is a VIP-only fact. Before #68 every layer demanded one, so a Silver or
// Essentials roster could not be staged at all, and a batch-less row would have had a
// NULL record key — which the unique index and both duplicate checks skip.

const SELF_PACED_HEADERS = ['first_name', 'last_name', 'email', 'plan', 'start_date', 'end_date',
  'payment_status', 'amount_paid'];

function selfPacedRoster({ label = 'Essentials', n = 4, start = '9/20/2026', end = '11/18/2026', prefix = 'ess' } = {}) {
  return Array.from({ length: n }, (_, k) => ({
    first_name: `Self${k + 1}`, last_name: 'Paced', email: `${prefix}${String(k + 1).padStart(3, '0')}@example.test`,
    plan: label, start_date: start, end_date: end, payment_status: 'Paid', amount_paid: '1499',
  }));
}

const selfPacedOpts = (extra = {}) => ({
  mapping: autoMapLegacyHeaders(SELF_PACED_HEADERS),
  dateFormat: 'M/D/YYYY',
  planMapping: { essentials: 'sampler', silver: 'silver_self_paced' },
  batchMapping: {},
  plans: PLANS,
  batches: BATCHES,
  eligibleBatchCodes: [],
  eligiblePlanKeys: ['sampler', 'silver_self_paced'],
  nowMs: NOW,
  ...extra,
});

test('an Essentials roster with NO batch column stages valid, with no batch and no batch error', () => {
  const mapping = autoMapLegacyHeaders(SELF_PACED_HEADERS);
  assert.deepEqual(missingRequiredFields(mapping), [], 'the wizard must not stop at "Still needed: Batch"');
  const rows = normalizeLegacyRows(selfPacedRoster(), selfPacedOpts());
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.deepEqual(r.errors, []);
    assert.equal(r.validation_status, 'valid');
    assert.equal(r.activation_state, 'ready', 'ready because its plan is ticked');
    assert.equal(r.plan_key, 'sampler');
    assert.equal(r.batch_code, null);
    assert.equal(r.legacy_batch_label, null);
    assert.ok(!r.warnings.includes('batch_ignored_for_plan'), 'no label in the file, so nothing was ignored');
  }
});

test('a non-VIP record key uses the "none" token, never a NULL batch', () => {
  assert.equal(NON_VIP_BATCH_TOKEN, 'none');
  assert.doesNotMatch(NON_VIP_BATCH_TOKEN, /^\d{4}-\d{2}$/, 'it can never collide with a batch code');
  const [ess] = normalizeLegacyRows(selfPacedRoster(), selfPacedOpts());
  assert.equal(ess.record_key_input, 'thinkific|email:ess001@example.test|sampler|none');
  const [silver] = normalizeLegacyRows(selfPacedRoster({ label: 'Silver', prefix: 'sil' }), selfPacedOpts());
  assert.equal(silver.record_key_input, 'thinkific|email:sil001@example.test|silver_self_paced|none');
  assert.equal(legacyRecordKeyInput({ externalId: '', email: 'a@example.test', planKey: 'sampler', batchCode: NON_VIP_BATCH_TOKEN }),
    'thinkific|email:a@example.test|sampler|none');
  // The VIP key is unchanged, so the rows already staged in production keep their keys.
  const [vip] = normalizeLegacyRows(syntheticRoster().slice(0, 1), baseOpts());
  assert.equal(vip.record_key_input, 'thinkific|email:student001@example.test|vip|2026-09');
});

test('no valid row, VIP or not, is ever left without a record key', () => {
  const mixed = [...normalizeLegacyRows(syntheticRoster(), baseOpts()),
    ...normalizeLegacyRows(selfPacedRoster({ n: 3 }), selfPacedOpts()),
    ...normalizeLegacyRows(selfPacedRoster({ label: 'Silver', prefix: 'sil', n: 3 }), selfPacedOpts())];
  for (const r of mixed.filter((x) => x.validation_status === 'valid')) {
    assert.ok(r.record_key_input, `row ${r.source_row_number} (${r.plan_key}) has no key`);
  }
});

test('a self-paced row is Ready only when its PLAN is ticked, never by a cohort', () => {
  const none = normalizeLegacyRows(selfPacedRoster(), selfPacedOpts({ eligiblePlanKeys: [] }));
  assert.ok(none.every((r) => r.validation_status === 'valid' && r.activation_state === 'inactive'));
  const otherPlan = normalizeLegacyRows(selfPacedRoster(), selfPacedOpts({ eligiblePlanKeys: ['silver_self_paced'] }));
  assert.ok(otherPlan.every((r) => r.activation_state === 'inactive'), 'ticking Silver does not ready Essentials');
  const byCohort = normalizeLegacyRows(selfPacedRoster(), selfPacedOpts({ eligiblePlanKeys: [], eligibleBatchCodes: ['2026-09', '2026-10'] }));
  assert.ok(byCohort.every((r) => r.activation_state === 'inactive'), 'a cohort tick means nothing to a self-paced row');
});

test('a batch label on a Silver row is kept as history, ignored, and warned about', () => {
  const headers = [...SELF_PACED_HEADERS, 'batch'];
  for (const label of ['October 2026', 'July 2026', 'VIP', 'Batch 7']) {
    const src = selfPacedRoster({ label: 'Silver', prefix: 'sil', n: 2 }).map((r) => ({ ...r, batch: label }));
    const rows = normalizeLegacyRows(src, selfPacedOpts({
      mapping: autoMapLegacyHeaders(headers),
      batchMapping: { 'october 2026': '2026-10' },
    }));
    for (const r of rows) {
      assert.deepEqual(r.errors, [], `${label}: a Silver row runs no batch rule`);
      assert.equal(r.batch_code, null, `${label}: and stores no batch`);
      assert.equal(r.legacy_batch_label, label, `${label}: the file's label stays as history`);
      assert.ok(r.warnings.includes('batch_ignored_for_plan'));
      assert.equal(r.activation_state, 'ready');
      assert.equal(r.record_key_input, `thinkific|email:${r.email_normalized}|silver_self_paced|none`,
        'a batch label never reaches a non-VIP key, so a corrected label cannot split one purchase in two');
    }
  }
});

test('a VIP row with no batch is still blocked, per row', () => {
  const noBatch = syntheticRoster().slice(0, 2).map(({ batch_code, ...rest }) => rest);
  const rows = normalizeLegacyRows(noBatch, baseOpts({ mapping: autoMapLegacyHeaders(HEADERS.filter((h) => h !== 'batch_code')) }));
  for (const r of rows) {
    assert.ok(r.errors.includes('batch_missing'));
    assert.equal(r.activation_state, 'blocked');
    assert.equal(r.record_key_input, null);
  }
  const blank = normalizeLegacyRows(syntheticRoster().slice(0, 1).map((r) => ({ ...r, batch_code: '' })), baseOpts());
  assert.ok(blank[0].errors.includes('batch_missing'));
});

function mixedRoster() {
  const vip = syntheticRoster().filter((r) => r.batch_code !== 'August 2026').slice(60);   // Sep tail + all Oct
  const silver = selfPacedRoster({ label: 'Silver', prefix: 'sil', n: 3 }).map((r) => ({
    thinkific_user_id: '', first_name: r.first_name, last_name: r.last_name, email: r.email, plan_key: r.plan,
    membership_started_at: r.start_date, membership_ends_at: r.end_date, payment_status: 'Paid',
    amount_paid: '2999', currency: 'PHP', legacy_enrollments: '', batch_code: '',
  }));
  return [...vip, ...silver];
}

test('a mixed roster: VIP is Ready by cohort, self-paced by plan, each by its own tick only', () => {
  const opts = baseOpts({ planMapping: { vip: 'vip', silver: 'silver_self_paced' } });
  const rows = normalizeLegacyRows(mixedRoster(), { ...opts, eligiblePlanKeys: ['silver_self_paced'] });
  const vip = rows.filter((r) => r.plan_key === 'vip');
  const silver = rows.filter((r) => r.plan_key === 'silver_self_paced');
  assert.equal(silver.length, 3);
  assert.ok(silver.every((r) => r.validation_status === 'valid' && r.activation_state === 'ready' && r.batch_code === null));
  assert.ok(vip.filter((r) => r.batch_code === '2026-10').every((r) => r.activation_state === 'ready'));
  assert.ok(vip.filter((r) => r.batch_code === '2026-09').every((r) => r.activation_state === 'inactive'));
  // A VIP plan key among the plan ticks readies no VIP row: VIP is chosen by cohort alone.
  const vipTick = normalizeLegacyRows(mixedRoster(), { ...opts, eligibleBatchCodes: [], eligiblePlanKeys: ['vip'] });
  assert.ok(vipTick.filter((r) => r.plan_key === 'vip').every((r) => r.activation_state === 'inactive'));
});

test('the same email under DIFFERENT plans is multiple_plans_in_file, and both copies stay blocked', () => {
  const src = mixedRoster();
  const silverAt = src.findIndex((r) => r.plan_key === 'Silver');
  src[silverAt] = { ...src[silverAt], email: src[0].email.toUpperCase() };   // an upgrade: VIP and Silver
  const rows = normalizeLegacyRows(src, baseOpts({ planMapping: { vip: 'vip', silver: 'silver_self_paced' },
    eligiblePlanKeys: ['silver_self_paced'] }));
  for (const r of [rows[0], rows[silverAt]]) {
    assert.ok(r.errors.includes('duplicate_in_file'), 'it keeps duplicate_in_file');
    assert.ok(r.errors.includes('multiple_plans_in_file'));
    assert.equal(r.validation_status, 'duplicate');
    assert.equal(r.activation_state, 'blocked', 'nothing decides which purchase to grant');
  }
  assert.ok(rows.filter((r, i) => i !== 0 && i !== silverAt).every((r) => !r.errors.includes('multiple_plans_in_file')));
});

test('one purchase listed twice under two labels of the SAME plan is a plain duplicate', () => {
  // A per-course export of the Silver bundle: one row for the QBO course, one for Resume.
  const src = selfPacedRoster({ label: 'QBO Course', prefix: 'sil', n: 1 });
  src.push({ ...src[0], plan: 'Resume Course' });
  const rows = normalizeLegacyRows(src, selfPacedOpts({
    planMapping: { 'qbo course': 'silver_self_paced', 'resume course': 'silver_self_paced' } }));
  for (const r of rows) {
    assert.ok(r.errors.includes('duplicate_in_file'));
    assert.ok(!r.errors.includes('multiple_plans_in_file'));
    assert.equal(r.activation_state, 'blocked');
  }
});

test('a term far from the plan\'s length is a warning, never a block', () => {
  assert.equal(TERM_LENGTH_TOLERANCE_DAYS, 31);
  assert.equal(termDays('2026-10-12', '2026-10-12'), 1, 'both ends count');
  assert.equal(termDays('2026-09-20', '2026-11-18'), 60);
  assert.equal(termDays('2026-10-12', '2027-04-12'), 183);
  assert.equal(termDays('2028-02-01', '2028-03-01'), 30, 'a leap February');
  // A 180-day VIP end left on the 60-day Essentials plan.
  const [long] = normalizeLegacyRows(selfPacedRoster({ n: 1, start: '9/20/2026', end: '3/18/2027' }), selfPacedOpts());
  assert.ok(long.warnings.includes('term_length_unusual'));
  assert.equal(long.validation_status, 'valid');
  assert.equal(long.activation_state, 'ready');
  // Exactly 31 days off is inside the tolerance; 32 is not. (60 + 31 = 91 days, 60 + 32 = 92.)
  const at = (end) => normalizeLegacyRows(selfPacedRoster({ n: 1, start: '9/20/2026', end }), selfPacedOpts())[0];
  assert.equal(termDays('2026-09-20', '2026-12-19'), 91);
  assert.ok(!at('12/19/2026').warnings.includes('term_length_unusual'));
  assert.ok(at('12/20/2026').warnings.includes('term_length_unusual'));
  assert.ok(at('9/30/2026').warnings.includes('term_length_unusual'), '11 days on a 60-day plan');
  // The real VIP roster is within a few days of 180 on every row.
  assert.ok(normalizeLegacyRows(syntheticRoster(), baseOpts()).every((r) => !r.warnings.includes('term_length_unusual')));
  // With no access_days to compare against, nothing is said.
  const noDays = PLANS.map(({ access_days, ...p }) => p);
  assert.ok(!normalizeLegacyRows(selfPacedRoster({ n: 1, end: '3/18/2027' }), selfPacedOpts({ plans: noDays }))[0]
    .warnings.includes('term_length_unusual'));
});

test('self-paced plans are pre-ticked in catalog order; VIP never is', () => {
  const opts = baseOpts({ planMapping: { vip: 'vip', silver: 'silver_self_paced', essentials: 'sampler' } });
  const src = [...mixedRoster(), ...selfPacedRoster({ n: 2 }).map((r) => ({
    thinkific_user_id: '', first_name: r.first_name, last_name: r.last_name, email: r.email, plan_key: r.plan,
    membership_started_at: r.start_date, membership_ends_at: r.end_date, payment_status: 'Paid',
    amount_paid: '1499', currency: 'PHP', legacy_enrollments: '', batch_code: '' }))];
  const probe = normalizeLegacyRows(src, opts);
  assert.deepEqual(defaultEligiblePlanKeys(probe, PLANS), ['sampler', 'silver_self_paced']);
  // Only plans with a VALID row are offered.
  const blocked = probe.map((r) => (r.plan_key === 'sampler' ? { ...r, validation_status: 'blocked' } : r));
  assert.deepEqual(defaultEligiblePlanKeys(blocked, PLANS), ['silver_self_paced']);
  assert.deepEqual(defaultEligiblePlanKeys(normalizeLegacyRows(syntheticRoster(), baseOpts()), PLANS), []);
  assert.deepEqual(defaultEligiblePlanKeys([], PLANS), []);
  assert.deepEqual(defaultEligiblePlanKeys(probe, []), [], 'without the catalog nothing can be shown to be self-paced');
});

test('plan summary counts rows per package, in catalog order', () => {
  const opts = baseOpts({ planMapping: { vip: 'vip', silver: 'silver_self_paced' } });
  const rows = normalizeLegacyRows(mixedRoster(), { ...opts, eligiblePlanKeys: [] });
  const s = planSummary(rows, PLANS);
  assert.deepEqual(s.map((g) => [g.plan_key, g.name, g.tagline, g.segment, g.total, g.ready, g.inactive, g.blocked]), [
    ['silver_self_paced', 'Silver · Self-Paced', 'QBO + Resume Combo', 'general', 3, 0, 3, 0],
    ['vip', 'VIP Package', 'Personalized Coaching Program', 'vip', 23, 18, 5, 0],
  ]);
  // A row with no plan has no package to show, and is not offered as a tick.
  const unmapped = normalizeLegacyRows(mixedRoster(), { ...opts, planMapping: { vip: 'vip' } });
  assert.ok(planSummary(unmapped, PLANS).every((g) => g.plan_key));
  assert.deepEqual(planSummary([], PLANS), []);
});

test('the cohort table counts VIP rows only when given the catalog', () => {
  const opts = baseOpts({ planMapping: { vip: 'vip', silver: 'silver_self_paced' } });
  const rows = normalizeLegacyRows(mixedRoster(), { ...opts, eligiblePlanKeys: ['silver_self_paced'] });
  assert.deepEqual(cohortSummary(rows, PLANS).map((g) => [g.batch_code, g.total, g.ready]),
    [['2026-09', 5, 0], ['2026-10', 18, 18]], 'Silver rows are not a "No batch" line of the cohort table');
  assert.deepEqual(cohortSummary(rows).map((g) => [g.batch_code, g.total]),
    [['2026-09', 5], ['2026-10', 18], [null, 3]], 'without the catalog it cannot tell, and says so under null');
});

test('cohort seats follow the months paid for, from 1 up to the plan\'s six', () => {
  // The contract's worked examples.
  assert.equal(legacySeatCount('2026-10-12', '2027-04-12', 6), 6);
  assert.equal(legacySeatCount('2026-10-12', '2026-11-11', 6), 1);
  assert.equal(legacySeatCount('2026-10-12', '2026-11-10', 6), 1, 'short of a month is still one seat');
  assert.equal(legacySeatCount('2026-10-12', '2027-10-11', 6), 6, 'twelve months, capped at the plan');
  // The live cohorts.
  assert.equal(legacySeatCount('2026-09-02', '2027-03-02', 6), 6);
  assert.equal(legacySeatCount('2026-08-03', '2027-02-03', 6), 6);
  // Month and year boundaries, computed like Postgres age(end + 1, start).
  assert.equal(legacySeatCount('2026-10-12', '2026-12-11', 6), 2);
  assert.equal(legacySeatCount('2026-12-15', '2027-06-14', 6), 6);
  assert.equal(legacySeatCount('2026-12-15', '2027-03-13', 6), 2, 'age(Mar 14, Dec 15) is 2 months 27 days');
  assert.equal(legacySeatCount('2026-12-31', '2026-12-31', 6), 1);
  assert.equal(legacySeatCount('2027-01-31', '2027-02-27', 6), 1, 'age(Feb 28, Jan 31) is 28 days: 0 months, floored to 1');
  assert.equal(legacySeatCount('2027-01-31', '2027-02-28', 6), 1, 'age(Mar 1, Jan 31) is 1 month 1 day');
  assert.equal(legacySeatCount('2027-01-31', '2027-03-30', 6), 2, 'age(Mar 31, Jan 31) is exactly 2 months');
  assert.equal(legacySeatCount('2027-01-31', '2027-03-31', 6), 2, 'age(Apr 1, Jan 31) is 2 months 1 day');
  assert.equal(legacySeatCount('2028-01-15', '2028-03-14', 6), 2, 'across a leap February');
  // A plan's own batch count is the ceiling, whatever it is.
  assert.equal(legacySeatCount('2026-10-12', '2027-10-11', 3), 3);
  assert.equal(legacySeatCount('2026-10-12', '2026-11-11', 1), 1);
});

test('a plan with no cohort gets no seats, and unreadable dates never guess some', () => {
  for (const count of [0, null, undefined, -1, 'six', NaN]) {
    assert.equal(legacySeatCount('2026-10-12', '2027-04-12', count), 0, `batch count ${String(count)}`);
  }
  for (const [s, e] of [[null, '2027-04-12'], ['2026-10-12', ''], ['10/12/2026', '2027-04-12'], ['2026-10-12', undefined]]) {
    assert.equal(legacySeatCount(s, e, 6), 0);
  }
});

// #68 review, L2. legacy_import_seat_count() returns NULL for `p_end < p_start` BEFORE its
// greatest(1, …) — "no term, no count" — and this mirror's spelling of that is 0, as it is
// for a missing date. It used to answer 1, pinned here by a message that misread the SQL.
test('an end before its start buys no seats, as in SQL; an end ON its start buys one', () => {
  assert.equal(legacySeatCount('2026-10-12', '2026-10-01', 6), 0, 'SQL: p_end < p_start → NULL, before greatest(1, …)');
  assert.equal(legacySeatCount('2026-10-12', '2026-10-11', 6), 0, 'one day short is still before the start');
  assert.equal(legacySeatCount('2027-01-01', '2026-12-31', 6), 0, 'across a year boundary');
  assert.equal(legacySeatCount('2027-04-12', '2026-10-12', 6), 0, 'a whole term swapped is not six seats');
  assert.equal(legacySeatCount('2026-10-12', '2026-10-12', 6), 1, 'a one-day term: age(Oct 13, Oct 12) is 0 months, floored to 1');
  // The guard reads the dates, not the cap: a non-VIP plan was 0 already and stays 0.
  assert.equal(legacySeatCount('2026-10-12', '2026-10-01', 0), 0);
});
