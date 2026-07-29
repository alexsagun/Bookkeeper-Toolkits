// ─────────────────────────────────────────────────────────────────────────────
// batchEntitlements.js — PURE, dependency-free cohort-seat logic (#35).
// ─────────────────────────────────────────────────────────────────────────────
// The JS mirror of public.batch_entitlements and its helpers. Shared by the
// browser (EntitlementRunPanel, the paywall's "N monthly cohorts included"
// line, AdminBatches, the approve receipt), the import endpoint, and
// test/batchEntitlements.test.mjs. NO imports, NO side effects.
//
// LOCKSTEP: planBatchCount() mirrors public.plan_batch_count(), and
// seatStatusOf() mirrors the L1 predicate that every policy and RPC shares:
//
//     status = 'active' and batch_id is not null
//     and (valid_until  is null or valid_until  > now())
//     and (activates_at is null or activates_at <= now())
//     and segment = <the member's LIVE plan segment>
//
// Change one side and you must change the other — the truth table in
// test/batchEntitlements.test.mjs is what makes the drift visible.
//
// WHAT A SEAT IS (and is not): a row is one seat in one cohort of Alex's live
// teaching. It records WHY access exists (grant_reason, source_*), WHERE in the
// purchased run it sits (batch_index), and HOW LONG it lasts (valid_until).
// A seat is NEVER derived from a date, a price, or a course title — the batch
// comes from an explicit admin/checkout/import choice, and the *number* of
// seats comes from the plan (see planBatchCount).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on outstanding (queued + active) seats per member. Bounds the
 * runaway cases: repeated renewals on a long plan, or an override typo turning
 * one approval into hundreds of ledger rows and hundreds of seat-consuming
 * capacity checks. Mirrors the CHECK on batch_index and grant_batch_run's
 * RUN_LIMIT_EXCEEDED raise.
 */
export const MAX_OUTSTANDING_SEATS = 24;

/** Days of access that map to one monthly cohort (D1: ceil(access_days / 30)). */
export const DAYS_PER_COHORT = 30;

/** Extensions are clamped 60–365 days by approve_extension, so 2–12 cohorts. */
export const MIN_EXTENSION_COHORTS = 1;
export const MAX_EXTENSION_COHORTS = 12;

/**
 * How many monthly cohorts a plan grants (D1).
 *
 * Derived from access_days rather than configured, with a nullable override so
 * a plan can be pinned without a migration:
 *     coalesce(override, ceil(access_days / 30))
 *
 * Returns null when access_days is null (a lifetime/no-expiry premium plan) —
 * the caller MUST fail closed rather than invent a run length, because "grant
 * unlimited cohorts forever" is never the safe default. grant_batch_run raises
 * INVALID_PLAN in that case and #35's backfill skips the row with a notice.
 *
 * @param {number|null|undefined} accessDays
 * @param {number|null|undefined} override  enrollment_plans.eligible_batch_count
 * @returns {number|null}
 */
export function planBatchCount(accessDays, override) {
  if (override != null) {
    const o = Math.trunc(Number(override));
    if (!Number.isFinite(o) || o < 1) return null;
    return Math.min(MAX_OUTSTANDING_SEATS, o);
  }
  if (accessDays == null) return null;
  const d = Number(accessDays);
  if (!Number.isFinite(d) || d <= 0) return null;
  return Math.min(MAX_OUTSTANDING_SEATS, Math.max(1, Math.ceil(d / DAYS_PER_COHORT)));
}

/**
 * How many ADDITIONAL cohorts an extension buys (D9).
 *
 * Keyed on what was actually purchased (enrollment_requests.extension_days), not
 * on the plan's own run length — a 60-day top-up on a 180-day Gold plan must
 * grant 2 more cohorts, not another 6. Getting this wrong was a critical review
 * finding: it would have minted six cohort months and burned six seats for a
 * two-month purchase.
 *
 * @param {number|null|undefined} extensionDays
 * @returns {number} 0 when there is nothing valid to extend by
 */
export function runLengthForExtension(extensionDays) {
  if (extensionDays == null) return 0;
  const d = Number(extensionDays);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(
    MAX_EXTENSION_COHORTS,
    Math.max(MIN_EXTENSION_COHORTS, Math.ceil(d / DAYS_PER_COHORT)),
  );
}

const toTime = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * Classify one ledger row for display. Mirrors the L1 predicate.
 *
 * @returns {'revoked'|'superseded'|'queued'|'expired'|'scheduled'|'active'|'unknown'}
 *   revoked    — explicitly withdrawn by an admin
 *   superseded — replaced by a later run (e.g. a gold→vip upgrade)
 *   queued     — paid for, but the cohort does not exist yet (batch_id null)
 *   expired    — the membership term (or its grace) has passed
 *   scheduled  — allocated to a cohort that has not started yet
 *   active     — currently grants access
 *
 * NOTE: this cannot see the member's LIVE plan segment, so it never reports the
 * segment-mismatch case (a downgraded member whose stamped gold seats stop
 * resolving). That check lives in SQL, where the live plan is available — the
 * UI shows such rows as 'active' but the database refuses access. Deliberate:
 * a client-side helper must not be the thing that decides authorization.
 */
export function seatStatusOf(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return 'unknown';
  const at = now instanceof Date ? now.getTime() : Number(now);

  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'superseded') return 'superseded';

  const validUntil = toTime(row.valid_until);
  if (validUntil != null && validUntil <= at) return 'expired';

  if (row.status === 'queued' || !row.batch_id) return 'queued';

  const activatesAt = toTime(row.activates_at);
  if (activatesAt != null && activatesAt > at) return 'scheduled';

  return row.status === 'active' ? 'active' : 'unknown';
}

/** True when the seat currently grants access (the client-visible half of L1). */
export function seatIsLive(row, now = Date.now()) {
  return seatStatusOf(row, now) === 'active';
}

/**
 * Group ledger rows into purchased runs, newest run first, seats in run order.
 * One run == one purchase (approval / renewal / extension / upgrade), so this is
 * the shape EntitlementRunPanel and the approve receipt render.
 *
 * @returns {Array<{run_id: string, grant_reason: string, granted_at: string|null,
 *                  run_length: number, seats: object[]}>}
 */
export function groupRunsByRunId(rows) {
  const runs = new Map();
  for (const r of rows || []) {
    if (!r || !r.run_id) continue;
    if (!runs.has(r.run_id)) {
      runs.set(r.run_id, {
        run_id: r.run_id,
        grant_reason: r.grant_reason || 'approval',
        granted_at: r.granted_at || null,
        run_length: r.run_length || 0,
        seats: [],
      });
    }
    runs.get(r.run_id).seats.push(r);
  }
  const out = [...runs.values()];
  for (const run of out) {
    run.seats.sort((a, b) => (a.batch_index ?? 0) - (b.batch_index ?? 0));
  }
  // Newest purchase first; ties broken by run_id so the order is stable across
  // renders (two grants can share a timestamp in the same transaction).
  out.sort((a, b) => {
    const d = (toTime(b.granted_at) ?? 0) - (toTime(a.granted_at) ?? 0);
    return d !== 0 ? d : String(a.run_id).localeCompare(String(b.run_id));
  });
  return out;
}

const REASON_LABEL = {
  approval: 'Approved',
  renewal: 'Renewal',
  extension: 'Extension',
  upgrade: 'Upgrade',
  import: 'Imported',
  admin_manual: 'Assigned by admin',
  backfill: 'Migrated',
};

/**
 * A one-line human description of a seat, for the member panel and admin drill-down.
 * Answers "why do I have this, and when does it apply?" without a second query.
 */
export function describeSeat(row, batchesById, now = Date.now()) {
  const status = seatStatusOf(row, now);
  const batch = row && row.batch_id && batchesById ? batchesById[row.batch_id] : null;
  const label = batch ? (batch.name || batch.code) : null;
  const reason = REASON_LABEL[row && row.grant_reason] || 'Granted';

  switch (status) {
    case 'queued':
      return `${reason} — seat reserved, assigned when the next cohort opens`;
    case 'scheduled':
      return `${reason} — ${label || 'cohort'} starts soon`;
    case 'active':
      return `${reason} — ${label || 'cohort'}`;
    case 'expired':
      return `${reason} — ${label || 'cohort'} (access ended)`;
    case 'revoked':
      return `${label || 'Cohort'} — access withdrawn${row.revoke_reason ? `: ${row.revoke_reason}` : ''}`;
    case 'superseded':
      return `${label || 'Cohort'} — replaced by a later plan`;
    default:
      return label || 'Cohort seat';
  }
}

/**
 * Summarise a member's ledger for a compact panel.
 * @returns {{active: number, queued: number, scheduled: number, total: number,
 *            validUntil: string|null, batchIds: string[]}}
 */
export function summariseSeats(rows, now = Date.now()) {
  let active = 0;
  let queued = 0;
  let scheduled = 0;
  let validUntil = null;
  const batchIds = [];

  for (const r of rows || []) {
    const s = seatStatusOf(r, now);
    if (s === 'active') { active++; if (r.batch_id) batchIds.push(r.batch_id); }
    else if (s === 'queued') queued++;
    else if (s === 'scheduled') scheduled++;
    if (s === 'active' || s === 'scheduled' || s === 'queued') {
      const t = toTime(r.valid_until);
      if (t != null && (validUntil == null || t > toTime(validUntil))) validUntil = r.valid_until;
    }
  }
  return { active, queued, scheduled, total: active + queued + scheduled, validUntil, batchIds };
}
