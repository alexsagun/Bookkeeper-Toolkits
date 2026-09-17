// src/lib/financeDailyIncome.js — the pure client half of Financial Management → Daily Income (#64).
//
// The SERVER computes every figure (finance_daily_income_report). This module only decides the
// shape around them, so the table, the CSV and the print view read ONE column list and cannot
// disagree:
//
//   • The package columns are the server's `plans` array, in its order. Nothing here names a
//     plan key — the Apps Script this replaces hard-coded five packages, two of them retired.
//   • A day is empty only when EVERY bucket and count is zero. Net zero is not "no activity":
//     a correction that cancels a collection must stay visible.
//   • "Today" is the business timezone's date. todayISODate() is the browser's, which is a
//     different day for eight hours of every day in Manila when viewed from the US.
//
// Dependency-free on purpose (test/financeDailyIncome.test.mjs pins the export list).

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Step a 'YYYY-MM' month by `delta`, clamped to optional { min, max } bounds. Malformed → null. */
export function shiftMonth(month, delta, { min = null, max = null } = {}) {
  const m = MONTH_RE.exec(String(month ?? ''));
  if (!m) return null;
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(Number(delta) || 0);
  let out = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
  if (min && MONTH_RE.test(min) && out < min) out = min;
  if (max && MONTH_RE.test(max) && out > max) out = max;
  return out;
}

const DAY_AMOUNTS = ['gross_collections', 'enrollment_reversals', 'refunds', 'other_income', 'adjustments', 'net_cash_income'];
const DAY_COUNTS = ['collections', 'distinct_enrollments', 'reversal_entries'];

/** True when nothing at all was posted to income that day. */
export function isZeroActivityDay(day) {
  if (!day) return true;
  if (DAY_AMOUNTS.some((k) => Number(day[k] || 0) !== 0)) return false;
  if (DAY_COUNTS.some((k) => Number(day[k] || 0) !== 0)) return false;
  const buckets = [...Object.values(day.plans || {}), day.legacy_other].filter(Boolean);
  return !buckets.some((b) => Number(b.gross || 0) !== 0 || Number(b.reversals || 0) !== 0
    || Number(b.collections || 0) !== 0);
}

const num = (v) => Number(v || 0);

/**
 * The column list for the day table, the CSV and the print view.
 * Each column is { key, label, kind: 'date'|'money'|'count', get(row) } where `row` is a day
 * object or the `totals` object (they share a shape). `get` returns the RAW server figure, so a
 * CSV keeps centavos; the screen formats money itself.
 */
export function dailyIncomeColumns(report) {
  const plans = Array.isArray(report?.plans) ? report.plans : [];
  const days = Array.isArray(report?.days) ? report.days : [];
  const cols = [{ key: 'day', label: 'Date', kind: 'date', get: (r) => r?.day ?? '' }];
  // ★ Labels must be UNIQUE: the CSV keys each row by label, so two plans sharing a name would
  //   silently overwrite one column with the other's figures.
  const nameCount = new Map();
  for (const p of plans) { const n = p.name || p.key; nameCount.set(n, (nameCount.get(n) || 0) + 1); }
  const planLabel = (p) => { const n = p.name || p.key; return nameCount.get(n) > 1 ? `${n} (${p.key})` : n; };

  for (const p of plans) {
    cols.push({ key: `plan:${p.key}`, label: planLabel(p), kind: 'money', plan: p.key,
      get: (r) => num(r?.plans?.[p.key]?.net) });
    cols.push({ key: `plan:${p.key}:collections`, label: `${planLabel(p)} collections`, kind: 'count', plan: p.key,
      get: (r) => num(r?.plans?.[p.key]?.collections) });
  }
  if (report?.has_legacy) {
    cols.push({ key: 'legacy', label: 'Legacy / other packages', kind: 'money', get: (r) => num(r?.legacy_other?.net) });
    cols.push({ key: 'legacy:collections', label: 'Legacy / other packages collections', kind: 'count',
      get: (r) => num(r?.legacy_other?.collections) });
  }
  cols.push(
    { key: 'gross_collections', label: 'Gross collections', kind: 'money', get: (r) => num(r?.gross_collections) },
    { key: 'enrollment_reversals', label: 'Enrollment reversals', kind: 'money', get: (r) => num(r?.enrollment_reversals) },
    { key: 'refunds', label: 'Refunds', kind: 'money', get: (r) => num(r?.refunds) },
    { key: 'other_income', label: 'Other income', kind: 'money', get: (r) => num(r?.other_income) },
  );
  if (num(report?.totals?.adjustments) !== 0 || days.some((d) => num(d?.adjustments) !== 0)) {
    cols.push({ key: 'adjustments', label: 'Adjustments', kind: 'money', get: (r) => num(r?.adjustments) });
  }
  cols.push(
    { key: 'net_cash_income', label: 'Net cash income', kind: 'money', get: (r) => num(r?.net_cash_income) },
    { key: 'collections', label: 'Collections', kind: 'count', get: (r) => num(r?.collections) },
    { key: 'distinct_enrollments', label: 'Distinct enrollments', kind: 'count', get: (r) => num(r?.distinct_enrollments) },
  );
  return cols;
}

/** 'YYYY-MM-DD' in the business timezone. An unknown zone falls back to Asia/Manila. */
export function businessToday(timeZone, now = new Date()) {
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  try {
    return fmt(timeZone || 'Asia/Manila');
  } catch {
    return fmt('Asia/Manila');
  }
}

/** The date a correction is posted on: today, but never before the entry it corrects. */
export function correctionDate(entryDate, today) {
  const e = typeof entryDate === 'string' ? entryDate.slice(0, 10) : '';
  return e && e > today ? e : today;
}
