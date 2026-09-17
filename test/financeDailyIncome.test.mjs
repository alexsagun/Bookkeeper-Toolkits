// test/financeDailyIncome.test.mjs — the pure client half of the Daily Income report (#64).
// The server computes every figure; this module only decides which columns exist, how a month
// is stepped, which days are empty, and what "today" means in the business timezone. Each of
// those was a bug somewhere else first: browser-local dates (todayISODate), a hard-coded plan
// list (the Apps Script's five packages), and a zero check that hid offsetting entries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shiftMonth, isZeroActivityDay, dailyIncomeColumns, businessToday, correctionDate,
} from '../src/lib/financeDailyIncome.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(REPO, 'src/lib/financeDailyIncome.js'), 'utf8');

const PLANS = [
  { key: 'sampler', name: 'Sampler Session', position: 1 },
  { key: 'silver_self_paced', name: 'QBO + Resume Combo', position: 2 },
  { key: 'vip', name: 'Personalized Coaching Program', position: 3 },
];
const zeroDay = (over = {}) => ({
  day: '2026-09-01', isodow: 2, plans: {}, legacy_other: null,
  gross_collections: 0, enrollment_reversals: 0, refunds: 0, other_income: 0, adjustments: 0,
  net_cash_income: 0, collections: 0, distinct_enrollments: 0, reversal_entries: 0, ...over,
});

test('the module stays small and dependency-free', () => {
  const exported = [...SRC.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ['businessToday', 'correctionDate', 'dailyIncomeColumns', 'isZeroActivityDay', 'shiftMonth']);
  assert.ok(!/^import /m.test(SRC), 'no imports — the finance screen, CSV and print all read it');
  assert.ok(!/'(gold|core|gold_live|core_self_paced|essentials)'/i.test(SRC),
    'no plan key is named here; the columns come from the server');
});

test('shiftMonth steps across year boundaries and clamps to the report bounds', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.equal(shiftMonth('2024-02', 12), '2025-02');
  assert.equal(shiftMonth('2026-09', 1, { max: '2026-09' }), '2026-09', 'never past the latest month');
  assert.equal(shiftMonth('2020-01', -1, { min: '2020-01' }), '2020-01', 'never before the earliest month');
  assert.equal(shiftMonth('2026-9', 1), null, 'a malformed month is refused, not guessed');
  assert.equal(shiftMonth('2026-13', 1), null);
  assert.equal(shiftMonth(null, 1), null);
});

test('a day with offsetting entries is NOT a zero-activity day', () => {
  assert.equal(isZeroActivityDay(zeroDay()), true);
  assert.equal(isZeroActivityDay(zeroDay({ other_income: 100, adjustments: -100 })), false,
    'net zero is not no activity — hiding it would hide a correction');
  assert.equal(isZeroActivityDay(zeroDay({ reversal_entries: 1 })), false);
  assert.equal(isZeroActivityDay(zeroDay({ collections: 1 })), false);
  assert.equal(isZeroActivityDay(zeroDay({ plans: { vip: { gross: 0, reversals: 0, net: 0, collections: 0 } } })), true);
  assert.equal(isZeroActivityDay(null), true);
});

test('columns follow the server plan list, in its order, and Legacy/Other only when present', () => {
  const cols = dailyIncomeColumns({ plans: PLANS, has_legacy: false, days: [zeroDay()], totals: zeroDay() });
  const labels = cols.map((c) => c.label);
  assert.equal(labels[0], 'Date');
  assert.deepEqual(labels.filter((l) => /Session|Combo|Program/.test(l) && !/collections/.test(l)),
    ['Sampler Session', 'QBO + Resume Combo', 'Personalized Coaching Program']);
  assert.ok(!labels.some((l) => /legacy/i.test(l)), 'no legacy column without legacy money');
  assert.ok(!labels.includes('Adjustments'), 'no adjustments column while every adjustment is zero');
  assert.ok(labels.includes('Net cash income'));
  assert.ok(labels.includes('Collections') && labels.includes('Distinct enrollments'));
  assert.ok(!labels.some((l) => /students/i.test(l)), 'a payment event is not a student');

  const withLegacy = dailyIncomeColumns({
    plans: PLANS, has_legacy: true,
    days: [zeroDay({ adjustments: 200, legacy_other: { gross: 2000, reversals: 0, net: 2000, collections: 1 } })],
    totals: zeroDay({ adjustments: 200 }),
  }).map((c) => c.label);
  assert.ok(withLegacy.includes('Legacy / other packages'));
  assert.ok(withLegacy.includes('Adjustments'));
});

test('every column label is unique, even when two plans share a name', () => {
  const twins = [{ key: 'sampler', name: 'Starter' }, { key: 'sampler_v2', name: 'Starter' }, ...PLANS.slice(2)];
  const labels = dailyIncomeColumns({ plans: twins, has_legacy: true, days: [], totals: zeroDay({ adjustments: 1 }) })
    .map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length, 'the CSV keys rows by label — a duplicate overwrites a column');
  assert.ok(labels.includes('Starter (sampler)') && labels.includes('Starter (sampler_v2)'));
});

test('a column reads the raw server figure, so CSV keeps centavos', () => {
  const day = zeroDay({ plans: { vip: { gross: 20750.5, reversals: -0.5, net: 20750, collections: 1 } }, net_cash_income: 20750.5 });
  const cols = dailyIncomeColumns({ plans: PLANS, has_legacy: false, days: [day], totals: day });
  const vip = cols.find((c) => c.label === 'Personalized Coaching Program');
  assert.equal(vip.kind, 'money');
  assert.equal(vip.get(day), 20750);
  assert.equal(cols.find((c) => c.label === 'Personalized Coaching Program collections').get(day), 1);
  assert.equal(cols.find((c) => c.label === 'Net cash income').get(day), 20750.5);
  assert.equal(cols.find((c) => c.label === 'Sampler Session').get(day), 0, 'a plan with no money that day reads 0');
  assert.equal(cols[0].get(day), '2026-09-01');
});

test('businessToday is the date in the BUSINESS timezone, not the browser', () => {
  // 16:30 UTC on Aug 31 is already Sep 1 in Manila and still Aug 31 in New York.
  const at = new Date('2026-08-31T16:30:00Z');
  assert.equal(businessToday('Asia/Manila', at), '2026-09-01');
  assert.equal(businessToday('America/New_York', at), '2026-08-31');
  assert.equal(businessToday('Not/AZone', at), '2026-09-01', 'an unknown zone falls back to Asia/Manila');
  assert.equal(businessToday(null, at), '2026-09-01');
});

test('a correction is dated today, but never before the entry it corrects', () => {
  assert.equal(correctionDate('2026-09-03', '2026-09-17'), '2026-09-17');
  assert.equal(correctionDate('2026-09-18', '2026-09-17'), '2026-09-18',
    'an entry dated tomorrow cannot be reversed yesterday');
  assert.equal(correctionDate(null, '2026-09-17'), '2026-09-17');
});
