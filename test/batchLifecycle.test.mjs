// test/batchLifecycle.test.mjs — batch period, edit-lock and rename rules (#38).
//
// The JS half of a lockstep pair with public.batch_is_past(), the batches_guard()
// trigger and admin_update_batch()'s validation chain. These tests exist so that
// changing one side without the other fails loudly instead of quietly locking a
// live batch a day early, or letting a code rename reorder a member's paid run.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BATCH_TIMEZONES,
  DEFAULT_BATCH_TIMEZONE,
  batchPeriodState,
  canEditBatch,
  closureLabel,
  dueForAutoClose,
  editLockReason,
  formatBatchDate,
  hasUpcomingOpenBatch,
  isKnownTimezone,
  isPastBatch,
  localDateIn,
  monthBounds,
  normalizeTimezone,
  periodProgress,
  validateBatchEdit,
} from '../src/lib/batchLifecycle.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');

// A December batch, dated by the whole month, in the product's default zone.
const DECEMBER = {
  id: 'b-dec', code: '2026-12', name: 'December 2026', status: 'open',
  starts_on: '2026-12-01', ends_on: '2026-12-31', timezone: 'Asia/Manila',
  vip_capacity: 5, total_capacity: null,
  vip_active: 1, total_active: 1,
};

// ── "Past" is a local-calendar question, not an instant ──────────────────────

test('a batch is editable through its final LOCAL day and locked the next one', () => {
  // 23:00 on 31 Dec in Manila. The UTC clock already reads 31 Dec 15:00, but the
  // batch still has an hour of its own last day left.
  const lastDayLocal = Date.parse('2026-12-31T15:00:00Z');
  assert.equal(isPastBatch(DECEMBER, lastDayLocal), false, 'still its final local day');
  assert.equal(canEditBatch(DECEMBER, lastDayLocal), true);
  assert.equal(editLockReason(DECEMBER, lastDayLocal), null);

  // 00:30 on 1 Jan in Manila — 90 minutes later, and now genuinely over.
  const nextDayLocal = Date.parse('2026-12-31T16:30:00Z');
  assert.equal(isPastBatch(DECEMBER, nextDayLocal), true, 'local date has rolled over');
  assert.equal(canEditBatch(DECEMBER, nextDayLocal), false);
  assert.equal(editLockReason(DECEMBER, nextDayLocal), 'Past batch — editing is locked.');
});

test('the SAME instant is past in Manila and not past in Los Angeles', () => {
  // The reason the rule reads the batch's own timezone rather than the server's:
  // a single UTC comparison is wrong by up to 16 hours for one of these.
  const at = Date.parse('2027-01-01T04:00:00Z');
  const manila = { ...DECEMBER, timezone: 'Asia/Manila' };       // 12:00, 1 Jan
  const la = { ...DECEMBER, timezone: 'America/Los_Angeles' };   // 20:00, 31 Dec

  assert.equal(isPastBatch(manila, at), true);
  assert.equal(isPastBatch(la, at), false, 'still 31 Dec on the US west coast');
});

test('a batch with no end date is never past — legacy rows stay editable', () => {
  const undated = { ...DECEMBER, starts_on: null, ends_on: null };
  assert.equal(isPastBatch(undated, Date.parse('2099-01-01T00:00:00Z')), false);
  assert.equal(canEditBatch(undated, NOW), true);
  assert.equal(batchPeriodState(undated, NOW), 'undated');
});

test('localDateIn: the JS half of (now() at time zone tz)::date', () => {
  assert.equal(localDateIn('Asia/Manila', Date.parse('2026-12-31T16:30:00Z')), '2027-01-01');
  assert.equal(localDateIn('UTC', Date.parse('2026-12-31T16:30:00Z')), '2026-12-31');
  assert.equal(localDateIn('America/New_York', Date.parse('2026-01-01T04:30:00Z')), '2025-12-31');
  assert.equal(localDateIn('Asia/Manila', Number.NaN), null);
});

test('an unrecognised timezone degrades the SAME way the SQL does', () => {
  // public.batch_is_past() resolves an unknown zone through pg_timezone_names and
  // falls back to the column default — it does NOT pass it to `at time zone`,
  // which raises 22023. This half must land on the same date for the same bad
  // input, or the lock would disagree with the sweep exactly where the data is
  // already wrong. Falling back to UTC here would be off by a day at this instant.
  const at = Date.parse('2026-12-31T16:30:00Z');
  assert.equal(localDateIn('Mars/Olympus', at), localDateIn(DEFAULT_BATCH_TIMEZONE, at));
  assert.equal(localDateIn('Mars/Olympus', at), '2027-01-01');

  // …and a batch carrying that garbage is therefore judged past on the same day a
  // correctly-configured Manila batch is, rather than crashing the list.
  const bad = { ...DECEMBER, timezone: 'Mars/Olympus' };
  assert.equal(isPastBatch(bad, at), true);
  assert.equal(isPastBatch(bad, Date.parse('2026-12-31T15:00:00Z')), false);
});

test('normalizeTimezone falls back to the column default; isKnownTimezone matches Intl', () => {
  assert.equal(normalizeTimezone(''), DEFAULT_BATCH_TIMEZONE);
  assert.equal(normalizeTimezone(null), 'Asia/Manila');
  assert.equal(normalizeTimezone('  UTC '), 'UTC');
  assert.equal(isKnownTimezone('Asia/Manila'), true);
  assert.equal(isKnownTimezone('Mars/Olympus'), false);
  assert.equal(isKnownTimezone(''), false);
  BATCH_TIMEZONES.forEach((tz) => {
    assert.equal(isKnownTimezone(tz), true, `${tz} must be a real zone`);
  });
});

// ── The month a code names ───────────────────────────────────────────────────

test('monthBounds covers 30/31-day months and a leap February', () => {
  assert.deepEqual(monthBounds('2026-01'), { startsOn: '2026-01-01', endsOn: '2026-01-31' });
  assert.deepEqual(monthBounds('2026-04'), { startsOn: '2026-04-01', endsOn: '2026-04-30' });
  assert.deepEqual(monthBounds('2026-12'), { startsOn: '2026-12-01', endsOn: '2026-12-31' });
  assert.deepEqual(monthBounds('2026-02'), { startsOn: '2026-02-01', endsOn: '2026-02-28' });
  assert.deepEqual(monthBounds('2028-02'), { startsOn: '2028-02-01', endsOn: '2028-02-29' },
    'leap year — the case hand-rolled 28/30/31 arithmetic gets wrong');
});

test('monthBounds refuses an impossible month, like the batches_code_check CHECK', () => {
  assert.equal(monthBounds('2026-13'), null);
  assert.equal(monthBounds('2026-00'), null);
  assert.equal(monthBounds('202-06'), null);
  assert.equal(monthBounds(''), null);
});

test('batchPeriodState places the batch on its own calendar', () => {
  assert.equal(batchPeriodState(DECEMBER, NOW), 'upcoming');
  assert.equal(batchPeriodState(DECEMBER, Date.parse('2026-12-15T00:00:00Z')), 'running');
  assert.equal(batchPeriodState(DECEMBER, Date.parse('2027-02-01T00:00:00Z')), 'past');
});

test('periodProgress clamps to the window and marks a finished batch complete', () => {
  assert.equal(periodProgress(DECEMBER, NOW).pct, 0, 'before the start, pinned to 0');
  assert.equal(periodProgress(DECEMBER, Date.parse('2027-02-01T00:00:00Z')).pct, 1);
  const mid = periodProgress(DECEMBER, Date.parse('2026-12-16T05:00:00Z'));
  assert.ok(mid.pct > 0.45 && mid.pct < 0.55, `mid-month should be near half, got ${mid.pct}`);
  assert.equal(periodProgress({ ...DECEMBER, ends_on: null }, NOW), null, 'nothing to draw');
});

// ── What the card says ───────────────────────────────────────────────────────

test('closureLabel always answers "what happens next, and when"', () => {
  // Assert the DATE VALUE, never the rendered format: formatBatchDate deliberately
  // follows the reader's locale, so a literal like 'Dec 31, 2026' would fail on any
  // machine whose ICU default is en-GB or de-DE — a red suite for a reason that has
  // nothing to do with the feature. The real hazard here is an off-by-one from UTC
  // parsing, and comparing against formatBatchDate still catches that.
  const dec31 = formatBatchDate('2026-12-31');
  assert.equal(closureLabel(DECEMBER, NOW), `Closes automatically after ${dec31} · Asia/Manila`);

  assert.equal(closureLabel({ ...DECEMBER, ends_on: null }, NOW),
    'No end date set — add one so this batch closes on its own.');

  assert.match(closureLabel({ ...DECEMBER, status: 'archived' }, NOW), /^Archived · ran until /);

  // Open but overdue: the sweep has not run yet, and the card says so rather than
  // claiming a future closure date that has already gone by.
  assert.equal(closureLabel(DECEMBER, Date.parse('2027-01-05T00:00:00Z')),
    `Period ended ${dec31} — closing on the next sweep.`);
});

test('closureLabel reads closed_at in the BATCH’s timezone, not UTC', () => {
  // The sweep runs hourly in UTC. Closing a Los_Angeles batch at 02:00Z stamps
  // 1 Jan, but locally it is still 31 Dec — and printing the UTC day would name a
  // date on which the batch was not yet closed. West of UTC this is the norm, not
  // an edge case.
  const at = '2027-01-01T02:00:00Z';
  const la = { ...DECEMBER, timezone: 'America/Los_Angeles', status: 'closed', close_reason: 'auto', closed_at: at };
  const mnl = { ...DECEMBER, timezone: 'Asia/Manila', status: 'closed', close_reason: 'auto', closed_at: at };

  assert.equal(closureLabel(la, NOW), `Closed automatically on ${formatBatchDate('2026-12-31')}`);
  assert.equal(closureLabel(mnl, NOW), `Closed automatically on ${formatBatchDate('2027-01-01')}`);

  assert.equal(
    closureLabel({ ...mnl, close_reason: 'manual', closed_at: '2026-12-20T02:00:00Z' }, NOW),
    `Closed on ${formatBatchDate('2026-12-20')}`);
});

test('formatBatchDate is Gregorian regardless of the host calendar', () => {
  // A host defaulting to th-TH-u-ca-buddhist would otherwise render 2569 on a card
  // whose every comparison was computed against 2026.
  assert.match(formatBatchDate('2026-12-31'), /2026/);
  assert.equal(formatBatchDate(''), '');
  assert.equal(formatBatchDate(null), '');
});

// ── Which batches a sweep touches ────────────────────────────────────────────

test('dueForAutoClose picks only OPEN batches whose local period has ended', () => {
  const at = Date.parse('2027-01-05T00:00:00Z');
  const rows = [
    { code: '2026-12', status: 'open', ends_on: '2026-12-31', timezone: 'Asia/Manila' },
    { code: '2026-11', status: 'closed', ends_on: '2026-11-30', timezone: 'Asia/Manila' },
    { code: '2026-10', status: 'archived', ends_on: '2026-10-31', timezone: 'Asia/Manila' },
    { code: '2027-01', status: 'open', ends_on: '2027-01-31', timezone: 'Asia/Manila' },
    { code: '2026-09', status: 'open', ends_on: null, timezone: 'Asia/Manila' },
  ];
  assert.deepEqual(dueForAutoClose(rows, at).map((b) => b.code), ['2026-12'],
    'closed and archived rows are already done; a running batch and an undated one are not due');
  assert.deepEqual(dueForAutoClose(dueForAutoClose(rows, at), at).map((b) => b.code), ['2026-12'],
    'the predicate is stable — re-running it selects the same set, never a wider one');
});

test('hasUpcomingOpenBatch is false once every open batch has run out', () => {
  const at = Date.parse('2027-01-05T00:00:00Z');
  assert.equal(hasUpcomingOpenBatch([
    { status: 'open', ends_on: '2026-12-31', timezone: 'Asia/Manila' },
  ], at), false, 'checkout would lose its batch picker — the screen must say so');

  assert.equal(hasUpcomingOpenBatch([
    { status: 'open', ends_on: '2026-12-31', timezone: 'Asia/Manila' },
    { status: 'open', ends_on: '2027-02-28', timezone: 'Asia/Manila' },
  ], at), true);
});

// ── The edit rules ───────────────────────────────────────────────────────────

const SIBLINGS = [
  { id: 'b-oct', code: '2026-10' },
  { id: 'b-jan', code: '2027-01' },
];

const draftFrom = (over = {}) => ({
  code: '2026-12', name: 'December 2026',
  starts_on: '2026-12-01', ends_on: '2026-12-31', timezone: 'Asia/Manila',
  vip_capacity: 5, total_capacity: '',
  ...over,
});

const check = (over, opts = {}) =>
  validateBatchEdit(draftFrom(over), { current: DECEMBER, siblings: SIBLINGS, now: NOW, ...opts });

test('a current/future batch edit passes', () => {
  const r = check({ name: 'December 2026 — Cohort B', vip_capacity: 12 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, {});
});

test('the past lock outranks every field check', () => {
  const r = check({ name: '' }, { now: Date.parse('2027-03-01T00:00:00Z') });
  assert.equal(r.ok, false);
  assert.equal(r.errors._form, 'Past batch — editing is locked.');
  assert.equal(r.errors.name, undefined,
    'a locked batch has no fixable field errors — reporting one would imply a fix exists');
});

test('a code rename may not move the batch past a sibling (it reorders paid runs)', () => {
  // Registry order: 2026-10 · [2026-12] · 2027-01
  assert.equal(check({ code: '2026-11' }).ok, true, 'still between 2026-10 and 2027-01');

  const down = check({ code: '2026-09' });
  assert.equal(down.ok, false);
  assert.match(down.errors.code, /would move this batch past 2026-10/);

  const up = check({ code: '2027-02' });
  assert.equal(up.ok, false);
  assert.match(up.errors.code, /would move this batch past 2027-01/);
});

test('the batch excludes ITSELF from the duplicate check', () => {
  // AdminBatches passes the whole admin_batch_overview() list as `siblings`, so the
  // batch being edited is in it. If identity matching breaks, saving without
  // touching the code reports "another batch already uses 2026-12" — which is the
  // batch itself, and nothing an admin could ever fix.
  const withSelf = validateBatchEdit(draftFrom(), {
    current: DECEMBER,
    siblings: [...SIBLINGS, { id: DECEMBER.id, code: DECEMBER.code }],
    now: NOW,
  });
  assert.equal(withSelf.ok, true, JSON.stringify(withSelf.errors));
});

test('a duplicate code is refused before the unique index has to be', () => {
  const r = check({ code: '2026-10' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.code, 'Another batch already uses 2026-10.');
});

test('an impossible month is refused with the same shape the CHECK enforces', () => {
  assert.match(check({ code: '2026-13' }).errors.code, /year and a real month/);
  assert.match(check({ code: 'august' }).errors.code, /year and a real month/);
});

test('a batch cannot be edited into an already-past period', () => {
  const r = check({ starts_on: '2026-01-01', ends_on: '2026-01-31' });
  assert.equal(r.ok, false);
  assert.match(r.errors.ends_on, /already ended in Asia\/Manila/);
});

test('the end date cannot precede the start date, and both are required', () => {
  assert.match(check({ starts_on: '2026-12-31', ends_on: '2026-12-01' }).errors.ends_on,
    /cannot fall before the start date/);
  assert.match(check({ ends_on: '' }).errors.ends_on, /closes on its own/);
  assert.match(check({ starts_on: '' }).errors.starts_on, /Set a start date/);
});

test('an unknown timezone is refused', () => {
  const r = check({ timezone: 'Mars/Olympus' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.timezone, 'Mars/Olympus is not a known timezone.');
});

test('capacity may not drop below the seats already sold', () => {
  // DECEMBER has one VIP member enrolled.
  const r = check({ vip_capacity: 0 });
  assert.equal(r.ok, false);
  assert.match(r.errors.vip_capacity, /whole number of 1 or more/);

  const under = validateBatchEdit(
    draftFrom({ vip_capacity: 1 }),
    { current: { ...DECEMBER, vip_active: 3 }, siblings: SIBLINGS, now: NOW },
  );
  assert.equal(under.ok, false);
  assert.match(under.errors.vip_capacity, /3 members are already enrolled/);

  assert.equal(check({ vip_capacity: '', total_capacity: '' }).ok, true,
    'blank means unlimited, which is never below occupancy');
});

test('a missing name is refused', () => {
  assert.match(check({ name: '   ' }).errors.name, /display name/);
});
