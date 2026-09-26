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

const PLANS = [
  { key: 'sampler', name: 'Sampler Session', price_php: 1499, active: true },
  { key: 'silver_self_paced', name: 'QBO + Resume Combo', price_php: 2999, active: true },
  { key: 'vip', name: 'Personalized Coaching Program', price_php: 16999, active: true },
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
  assert.ok(LEGACY_FIELDS.filter((f) => f.required).length >= 6);
  for (const code of ['email_missing', 'plan_unmapped', 'batch_label_mismatch', 'payment_not_paid',
    'term_ended', 'duplicate_in_file', 'duplicate_staged', 'profile_rejected', 'staff_account',
    'membership_conflict', 'identity_mismatch']) {
    assert.ok(LEGACY_ERROR_LABELS[code], `${code} needs a label`);
  }
  assert.ok(LEGACY_WARNING_LABELS.external_id_missing);
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
  assert.ok(rows.every((r) => r.errors.includes('start_date_invalid') && r.errors.includes('plan_unmapped')
    && r.errors.includes('batch_unmapped')));
});

test('the same email twice in one file is a duplicate on both rows', () => {
  const src = syntheticRoster().slice(0, 3);
  src[2] = { ...src[2], email: src[0].email.toUpperCase() };
  const rows = normalizeLegacyRows(src, baseOpts());
  assert.equal(rows[0].validation_status, 'duplicate');
  assert.equal(rows[2].validation_status, 'duplicate');
  assert.equal(rows[1].validation_status, 'valid');
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
