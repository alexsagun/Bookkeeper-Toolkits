// ─────────────────────────────────────────────────────────────────────────────
// batchLifecycle.js — PURE, dependency-free batch period / edit-lock logic (#38).
// ─────────────────────────────────────────────────────────────────────────────
// The JS mirror of public.batch_is_past(), the batches_guard() trigger, and
// public.admin_update_batch()'s validation chain. Shared by AdminBatches (card
// state, the edit modal, the "run closures now" affordance) and the node:test
// suite (test/batchLifecycle.test.mjs). NO runtime imports beyond the sibling
// pure module that owns the batch-code shape, NO side effects.
//
// ★ "PAST" IS A LOCAL-CALENDAR QUESTION, NOT AN INSTANT.
//   A batch is past when TODAY, read in that batch's own timezone, is later than
//   ends_on. So a batch ending 2026-12-31 in Asia/Manila is still editable at
//   2026-12-31T15:00Z (23:00 local) and locked at 16:00Z (00:00 local, Jan 1).
//   Comparing timestamps instead would lock a batch up to 16 hours early for the
//   only admin who uses this screen.
//
// ★ A BATCH WITH NO END DATE IS NEVER PAST.
//   Legacy rows predate the period columns. Failing OPEN here is deliberate and
//   is the opposite of lmsSchedule.js's fail-closed anchor rule: there, a missing
//   anchor would have LEAKED paid lessons; here, a missing end date would freeze a
//   live batch an admin still needs to fix. Neither default is universal — each
//   follows from what goes wrong when the data is absent.
//
// ★ THIS FILE DECIDES WHAT THE UI OFFERS. IT DECIDES NOTHING ABOUT AUTHORITY.
//   The batches_guard trigger and the column-level revoke on batches.code are the
//   real boundary; every rule below also exists in SQL. Keep them in lockstep.
// ─────────────────────────────────────────────────────────────────────────────

import { BATCH_CODE_RE, normalizeBatchCode } from './communitySpaces.js';

// Mirrors the batches.timezone column default.
export const DEFAULT_BATCH_TIMEZONE = 'Asia/Manila';

// The zones offered in the edit modal. Not a validation allowlist — the server
// checks pg_timezone_names, and isKnownTimezone() below checks Intl — this is
// only the shortlist a picker shows so the common case is one click.
export const BATCH_TIMEZONES = [
  'Asia/Manila',
  'Asia/Singapore',
  'Asia/Kolkata',
  'UTC',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trim to a usable zone, falling back to the column default. */
export function normalizeTimezone(tz) {
  const t = tz == null ? '' : String(tz).trim();
  return t || DEFAULT_BATCH_TIMEZONE;
}

/** Does this runtime's Intl accept the zone? (The server's check is pg_timezone_names.) */
export function isKnownTimezone(tz) {
  const t = tz == null ? '' : String(tz).trim();
  if (!t) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date, as 'YYYY-MM-DD', at instant `at` in zone `timezone`.
 * The JS half of `(now() at time zone tz)::date`.
 *
 * An unknown zone falls back to the column default rather than throwing: a bad
 * timezone string is a data problem for the edit form to report, not a reason
 * for the whole batch list to fail to render.
 *
 * ★ The fallback is DEFAULT_BATCH_TIMEZONE, not UTC, because public.batch_is_past()
 * resolves an unrecognised zone the same way. These two must agree on every
 * input, including the bad ones — a mirror that diverges precisely where the data
 * is already wrong is worse than no mirror.
 *
 * @returns {string|null} null only when `at` is not a real instant.
 */
export function localDateIn(timezone, at = Date.now()) {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return null;

  const tz = normalizeTimezone(timezone);
  const build = (zone) => new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);

  let parts;
  try {
    parts = build(tz);
  } catch {
    // DEFAULT_BATCH_TIMEZONE is itself validated by a test, but guard anyway so a
    // broken ICU build degrades to UTC instead of throwing out of a render.
    try {
      parts = build(DEFAULT_BATCH_TIMEZONE);
    } catch {
      parts = build('UTC');
    }
  }

  const pick = (type) => {
    const hit = parts.find((p) => p.type === type);
    return hit ? hit.value : '';
  };
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  if (!year || !month || !day) return null;
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * The whole-month window a 'YYYY-MM' code names.
 * Mirrors the batches_guard INSERT fill and the SQL
 * `to_date(code || '-01') … + interval '1 month - 1 day'`.
 *
 * @returns {{startsOn: string, endsOn: string}|null} null on an invalid code.
 */
export function monthBounds(code) {
  const c = normalizeBatchCode(code);
  if (!BATCH_CODE_RE.test(c)) return null;
  const year = Number(c.slice(0, 4));
  const month = Number(c.slice(5, 7));
  // Day 0 of the FOLLOWING month is the last day of this one — the only leap-year
  // rule we need, and the one arithmetic on 28/30/31 always eventually gets wrong.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startsOn: `${c}-01`, endsOn: `${c}-${String(lastDay).padStart(2, '0')}` };
}

const dateOf = (v) => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
};

/**
 * Has this batch's period elapsed in its own timezone?
 * The JS mirror of public.batch_is_past(ends_on, timezone).
 */
export function isPastBatch(batch, now = Date.now()) {
  const endsOn = dateOf(batch && batch.ends_on);
  if (!endsOn) return false;                    // undated → never past
  const today = localDateIn(batch && batch.timezone, now);
  if (!today) return false;
  return today > endsOn;                        // string compare is safe on ISO dates
}

/**
 * Where the batch sits relative to its own calendar.
 * @returns {'undated'|'upcoming'|'running'|'past'}
 */
export function batchPeriodState(batch, now = Date.now()) {
  const startsOn = dateOf(batch && batch.starts_on);
  const endsOn = dateOf(batch && batch.ends_on);
  if (!startsOn && !endsOn) return 'undated';
  const today = localDateIn(batch && batch.timezone, now);
  if (!today) return 'undated';
  if (endsOn && today > endsOn) return 'past';
  if (startsOn && today < startsOn) return 'upcoming';
  return 'running';
}

/** May an admin still change this batch's fields? */
export function canEditBatch(batch, now = Date.now()) {
  return !isPastBatch(batch, now);
}

/** Why the edit controls are gone, or null when they are not. */
export function editLockReason(batch, now = Date.now()) {
  return isPastBatch(batch, now) ? 'Past batch — editing is locked.' : null;
}

// calendar: 'gregory' is pinned, locale is not. The reader's locale should decide
// the FORMAT ("Dec 31, 2026" vs "31 Dec 2026"), matching formatCourseDate and the
// rest of the app — but not the CALENDAR: a host defaulting to
// th-TH-u-ca-buddhist would render this batch's year as 2569 while every
// comparison in this file computed 2026.
const MONTH_DAY = { month: 'short', day: 'numeric', year: 'numeric', calendar: 'gregory' };

/** Render a 'YYYY-MM-DD' with no timezone drift (parse the parts, build a LOCAL date). */
export function formatBatchDate(iso) {
  const d = dateOf(iso);
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, MONTH_DAY);
}

/**
 * The one line under the card title that answers "what happens next, and when".
 * Every branch is actionable or final — none of them is decoration.
 */
export function closureLabel(batch, now = Date.now()) {
  if (!batch) return '';
  const tz = normalizeTimezone(batch.timezone);
  const endsOn = dateOf(batch.ends_on);

  if (batch.status === 'archived') {
    return endsOn ? `Archived · ran until ${formatBatchDate(endsOn)}` : 'Archived';
  }
  if (batch.status === 'closed') {
    // closed_at is an INSTANT; read it as a date in the batch's own timezone, not
    // in UTC. An hourly sweep closing a Los_Angeles batch at 02:00Z stamps 1 Jan
    // while it is still 31 Dec there, and slicing the ISO string would print a day
    // on which the batch was, locally, not yet closed.
    const closedOn = batch.closed_at ? localDateIn(tz, new Date(batch.closed_at)) : null;
    if (closedOn) {
      return batch.close_reason === 'auto'
        ? `Closed automatically on ${formatBatchDate(closedOn)}`
        : `Closed on ${formatBatchDate(closedOn)}`;
    }
    return 'Closed to new members';
  }
  if (!endsOn) {
    return 'No end date set — add one so this batch closes on its own.';
  }
  if (isPastBatch(batch, now)) {
    return `Period ended ${formatBatchDate(endsOn)} — closing on the next sweep.`;
  }
  return `Closes automatically after ${formatBatchDate(endsOn)} · ${tz}`;
}

/**
 * Progress through the batch's own window, for the card's period track.
 * @returns {{state: string, pct: number}|null} null when there is nothing to draw.
 */
export function periodProgress(batch, now = Date.now()) {
  const startsOn = dateOf(batch && batch.starts_on);
  const endsOn = dateOf(batch && batch.ends_on);
  if (!startsOn || !endsOn) return null;
  const state = batchPeriodState(batch, now);
  const today = localDateIn(batch && batch.timezone, now);
  if (!today) return null;

  const ms = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  const start = ms(startsOn);
  const end = ms(endsOn);
  const at = ms(today);
  if (!(end > start)) return { state, pct: state === 'past' ? 1 : 0 };
  const pct = (at - start) / (end - start);
  return { state, pct: Math.max(0, Math.min(1, pct)) };
}

/** The batches a closure sweep would act on. Mirrors close_due_batches()'s predicate. */
export function dueForAutoClose(batches, now = Date.now()) {
  if (!Array.isArray(batches)) return [];
  return batches.filter((b) => b && b.status === 'open' && isPastBatch(b, now));
}

/**
 * Is there an open batch covering the current or next month?
 * With automatic closure live, an empty answer silently removes the VIP checkout
 * picker and stalls queued-seat allocation, so the screen says so.
 */
export function hasUpcomingOpenBatch(batches, now = Date.now()) {
  // Fails QUIET (true = "nothing to warn about") on a non-array, so a failed load
  // cannot make the admin screen claim there is no open batch. The opposite
  // default would turn every transient fetch error into a false alarm.
  if (!Array.isArray(batches)) return true;
  return batches.some((b) => b && b.status === 'open' && !isPastBatch(b, now));
}

const capacityOf = (raw) => {
  if (raw === '' || raw == null) return { value: null, bad: false };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return { value: null, bad: true };
  return { value: n, bad: false };
};

/**
 * Every rule admin_update_batch() enforces, evaluated locally so the modal can
 * refuse before a round trip and name the offending field.
 *
 * @param draft    {code, name, starts_on, ends_on, timezone, vip_capacity, total_capacity}
 * @param current  the batch row being edited (needs code, ends_on, timezone, and
 *                 vip_active / total_active occupancy counts)
 * @param siblings every OTHER batch: [{ id, code }]
 * @returns {{ok: boolean, errors: Object.<string,string>}}
 */
export function validateBatchEdit(draft, { current, siblings = [], now = Date.now() } = {}) {
  const errors = {};
  const fail = () => ({ ok: false, errors });

  if (!current) {
    errors._form = 'That batch no longer exists — refresh the list.';
    return fail();
  }
  // The lock outranks every field check: a past batch has nothing editable, so
  // reporting field errors would imply a fix exists.
  if (isPastBatch(current, now)) {
    errors._form = 'Past batch — editing is locked.';
    return fail();
  }

  const name = (draft && draft.name ? String(draft.name) : '').trim();
  if (!name) errors.name = 'Give the batch a display name (e.g. August 2026).';

  const code = normalizeBatchCode(draft && draft.code);
  if (!BATCH_CODE_RE.test(code)) {
    errors.code = 'Batch codes look like 2026-08 (year and a real month).';
  } else {
    const others = (siblings || []).filter((b) => b && b.code && b.id !== current.id);
    if (others.some((b) => normalizeBatchCode(b.code) === code)) {
      errors.code = `Another batch already uses ${code}.`;
    } else if (code !== normalizeBatchCode(current.code)) {
      // Rank preservation. grant_batch_run() and allocate_queued_entitlements()
      // walk the registry in `code` order, so moving a batch past a sibling
      // reorders somebody's already-purchased run.
      const oldCode = normalizeBatchCode(current.code);
      const moved = others.find((b) => {
        const sib = normalizeBatchCode(b.code);
        return (sib < oldCode) !== (sib < code);
      });
      if (moved) {
        errors.code = `${code} would move this batch past ${normalizeBatchCode(moved.code)}, `
          + 'which reorders members’ cohort runs. Pick a code that keeps the same position.';
      }
    }
  }

  const tz = normalizeTimezone(draft && draft.timezone);
  if (!isKnownTimezone(tz)) errors.timezone = `${tz} is not a known timezone.`;

  const startsOn = dateOf(draft && draft.starts_on);
  const endsOn = dateOf(draft && draft.ends_on);
  if (!startsOn) errors.starts_on = 'Set a start date.';
  if (!endsOn) errors.ends_on = 'Set an end date so this batch closes on its own.';
  if (startsOn && endsOn && startsOn > endsOn) {
    errors.ends_on = 'The end date cannot fall before the start date.';
  } else if (endsOn && !errors.timezone) {
    const today = localDateIn(tz, now);
    if (today && today > endsOn) {
      errors.ends_on = `That period has already ended in ${tz}. `
        + 'A batch cannot be edited into the past.';
    }
  }

  [['vip_capacity', 'vip_active', 'VIP'],
   ['total_capacity', 'total_active', 'Total']].forEach(([field, activeKey, label]) => {
    const { value, bad } = capacityOf(draft ? draft[field] : null);
    if (bad) {
      errors[field] = `${label} seats must be a whole number of 1 or more, or blank for unlimited.`;
      return;
    }
    const occupied = Number(current[activeKey]) || 0;
    if (value !== null && value < occupied) {
      errors[field] = `${occupied} member${occupied === 1 ? ' is' : 's are'} already enrolled — `
        + `${label} seats cannot go below ${occupied}.`;
    }
  });

  return Object.keys(errors).length ? fail() : { ok: true, errors };
}
