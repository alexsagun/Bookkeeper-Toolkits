// ─────────────────────────────────────────────────────────────────────────────
// legacyMigration.js — PURE rules for the legacy Thinkific migration (#67).
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the Migration Workspace (src/BookkeeperPro.jsx, for the preview), the
// staging endpoint (api/admin/student-imports.js, the AUTHORITY), and node --test
// (test/legacyMigration.test.mjs). No side effects, no DOM/Node/Supabase.
//
// ★ NOTHING IS GUESSED. The date format is declared by the admin, never sniffed.
//   A plan comes from an explicit label→plan mapping, never from a price, a course
//   title or a date. A batch comes from an explicit label→code mapping that must
//   ALSO agree with the month the label names and with the row's start date. A
//   row that fails any of that is BLOCKED with a reason, never repaired.
//
// ★ SQL IS THE AUTHORITY FOR TERMS AND KEYS. legacy_import_stage() recomputes the
//   record key and legacy_import_activate_row() recomputes the Manila term from
//   the stored DATES. The functions here mirror them so the preview shows what the
//   database will do; test/legacyMigrationSql.test.mjs pins the two against each
//   other.
//
// ★ A BATCH IS A VIP-ONLY FACT (#68). Silver and Essentials are not cohort
//   products: their rows skip every batch rule, store no batch, and are made Ready
//   per PLAN (eligiblePlanKeys) instead of per cohort. Every layer asks the mapped
//   plan's community_segment first — isVipPlan() here, the same test in
//   legacy_import_stage(), and legacy_import_activate_row() already did.
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeEmail, parseExternalId } from './studentImport.js';

export const LEGACY_SOURCE = 'thinkific';
export const BUSINESS_TIMEZONE = 'Asia/Manila';
// Asia/Manila is a fixed +08:00 (no daylight saving since 1978) — the same fact
// src/lib/meetingSchedule.js relies on. SQL uses `at time zone 'Asia/Manila'`.
export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
export const GRACE_DAYS = 3;                  // approve_subscription()'s v_grace_days
export const MAX_LEGACY_AMOUNT = 1_000_000;   // the #63 enrollment amount ceiling
export const MAX_STAGE_ROWS = 5000;
export const MAX_ACTIVATION_RUN = 200;        // student_import_activation_runs CHECK
export const MAX_ACTIVATION_ATTEMPTS = 5;
// A claimed row whose worker vanished may be re-claimed after this long. It MUST
// exceed the endpoint's maxDuration (vercel.json), or a slow but live request could
// have its row stolen mid-activation. test/legacyMigrationSql.test.mjs pins both.
export const STALE_CLAIM_MINUTES = 10;
export const ACTIVATION_FUNCTION_MAX_SECONDS = 60;

// ── Vocabularies (mirrored by CHECK constraints in the #67 migration) ────────
export const VALIDATION_STATUSES = ['valid', 'blocked', 'duplicate'];
export const ACTIVATION_STATES = ['inactive', 'ready', 'activating', 'activated', 'failed', 'blocked', 'reverted'];
export const INVITE_STATES = ['not_sent', 'sending', 'sent', 'uncertain', 'failed', 'notified'];
export const DATE_FORMATS = ['M/D/YYYY', 'D/M/YYYY', 'YYYY-MM-DD'];

// The canonical fields a roster can supply. `aliases` are the header spellings the
// auto-mapper recognises; the admin can always override a mapping.
//
// ★ NO BARE `id` ALIAS FOR THE THINKIFIC ID (#68). An Orders export's order number, or
//   a hand-built roster's 1..N row counter, is also called "ID". Auto-mapping it made
//   the identity `ext:<that number>`, so the same purchase keyed differently in two
//   rosters (duplicate detection missed it) and a row counter that equalled another
//   student's stored id blocked the row for good with external_id_conflict.
//
// ★ THE BATCH IS NOT A REQUIRED COLUMN (#68). A Silver or Essentials export has no
//   cohort, and demanding one stopped the wizard at step 2. A VIP row with no batch
//   is still blocked — per row, with batch_missing — so nothing VIP gets through
//   without its cohort.
export const LEGACY_FIELDS = [
  { key: 'external_user_id', label: 'Thinkific user id', required: false, aliases: ['thinkific_user_id', 'user_id'] },
  { key: 'first_name', label: 'First name', required: false, aliases: ['first_name', 'firstname', 'first name'] },
  { key: 'last_name', label: 'Last name', required: false, aliases: ['last_name', 'lastname', 'last name'] },
  { key: 'email', label: 'Email', required: true, aliases: ['email', 'email_address', 'e-mail'] },
  { key: 'plan_label', label: 'Plan', required: true, aliases: ['plan_key', 'plan', 'package'] },
  { key: 'start_date', label: 'Membership start', required: true, aliases: ['membership_started_at', 'start_date', 'started_at'] },
  { key: 'end_date', label: 'Membership end', required: true, aliases: ['membership_ends_at', 'end_date', 'ends_at', 'expiry'] },
  { key: 'payment_status', label: 'Payment status', required: true, aliases: ['payment_status', 'payment'] },
  { key: 'amount_paid', label: 'Amount paid', required: false, aliases: ['amount_paid', 'amount'] },
  { key: 'currency', label: 'Currency', required: false, aliases: ['currency'] },
  { key: 'batch_label', label: 'Batch', required: false, aliases: ['batch_code', 'batch', 'cohort'] },
  // Optional. Shown to the Super Admin and used for an advisory "shared phone" warning only —
  // an account is never linked by phone, because Auth identity is the email.
  { key: 'phone', label: 'Phone', required: false,
    aliases: ['phone', 'phone_number', 'mobile', 'mobile_number', 'contact_number', 'contact_no', 'contact'] },
];

// Why a row is blocked. Codes are stored on the row (errors jsonb) and in SQL;
// the labels are what the workspace shows.
export const LEGACY_ERROR_LABELS = {
  email_missing: 'Email is missing.',
  email_invalid: 'Email is not a valid address.',
  duplicate_in_file: 'This email appears more than once in the file.',
  // #68: the repeated email maps to DIFFERENT plans — an upgrade, not a bundle export.
  // Every copy stays blocked; nothing decides which purchase to grant.
  multiple_plans_in_file: 'This email appears more than once in the file, under different plans. Keep one row per student and stage the file again.',
  duplicate_staged: 'This membership is already staged in another job.',
  plan_missing: 'Plan is missing.',
  plan_unmapped: 'This plan label has no confirmed mapping.',
  plan_unknown: 'The mapped plan is not in the current catalog.',
  batch_missing: 'Batch is missing.',
  batch_unmapped: 'This batch label has no confirmed mapping.',
  batch_unknown: 'The mapped batch does not exist in the registry.',
  batch_archived: 'The batch is archived.',
  batch_label_mismatch: 'The batch label names a different month than the batch it maps to.',
  batch_date_mismatch: 'The membership start date is not in or next to the batch month.',
  start_date_invalid: 'Membership start is not a real date in the declared format.',
  end_date_invalid: 'Membership end is not a real date in the declared format.',
  date_order: 'Membership end is before its start.',
  term_ended: 'This membership and its grace period have already ended.',
  payment_status_missing: 'Payment status is missing.',
  payment_not_paid: 'The payment status is not Paid.',
  amount_invalid: 'Amount paid is not a number between 0 and 1,000,000.',
  currency_invalid: 'Currency is not a three-letter code.',
  // Activation-time refusals (legacy_import_activate_row), shown on blocked rows.
  profile_rejected: 'The matching account is blocked. Review it before activating.',
  staff_account: 'The matching account is staff. Staff are not migrated as students.',
  membership_conflict: 'The matching account already holds a current or scheduled membership.',
  identity_mismatch: 'The account found does not match this email.',
  plan_inactive: 'The plan is no longer active in the catalog.',
  external_id_conflict: 'This Thinkific id is already linked to a different account.',
  // #68. Staging and activation (legacy_import_stage / legacy_import_activate_row): a paid
  // member from before dated terms, with unlimited access and no subscription row. An
  // import would narrow that access, and a Revert would then remove it for good.
  grandfathered_member: 'The matching account is a paid member from before dated memberships, with unlimited access. Handle this student by hand; an import would replace that access.',
  // #68. Set at claim time as a failed row's last_error, so it can be retried later.
  // ★ It names only exits that exist: there is no per-row discard (only a whole job's), and
  //   the #68 review found the old "Activate or discard that row" sent the owner looking for
  //   one. Changing the higher row's terms (legacy_import_set_terms) is audited and real.
  higher_plan_pending: 'The same person has a higher package waiting in another roster. Activate that row first, or change its terms.',
  // #68. Defensive: a valid row must always carry a record key, or nothing stops it being
  // granted twice (the unique index and both duplicate checks skip NULL keys).
  record_key_missing: 'This row has no purchase key, so it could be granted twice. It was blocked instead.',
};

export const LEGACY_WARNING_LABELS = {
  phone_shared: 'Another student, or an earlier enrollment, uses this phone under a different email. Check it is not the same person.',
  external_id_missing: 'No Thinkific id: the account is matched by email.',
  existing_account: 'An account with this email already exists; it will be linked, not duplicated.',
  amount_differs_from_price: 'The amount paid differs from today\'s price. It is kept as history only.',
  // #68
  batch_ignored_for_plan: 'This plan has no cohort, so the batch in the file is kept as history only.',
  term_length_unusual: 'The membership length is very different from what this plan sells today. Check the dates and the plan.',
  other_legacy_row: 'This student is also in another roster under a different plan. Check which purchase to activate.',
};

// ── Header mapping ───────────────────────────────────────────────────────────
const normHeader = (h) => String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, '_');

/** { fieldKey: headerName } for every field whose alias appears among the headers. */
export function autoMapLegacyHeaders(headers) {
  const byNorm = new Map((headers || []).map((h) => [normHeader(h), h]));
  const out = {};
  for (const f of LEGACY_FIELDS) {
    for (const a of f.aliases) {
      const hit = byNorm.get(normHeader(a));
      if (hit != null) { out[f.key] = hit; break; }
    }
  }
  return out;
}

/** Required fields the mapping does not cover. */
export function missingRequiredFields(mapping) {
  return LEGACY_FIELDS.filter((f) => f.required && !(mapping && mapping[f.key])).map((f) => f.key);
}

// ── Dates ────────────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Parse a date in a DECLARED format. Returns { valid, iso: 'YYYY-MM-DD' } or
 * { valid:false }. A four-digit year is required: "9/1/26" is refused rather than
 * guessed, which is exactly how the misplaced-column roster fails loudly.
 * Components are range-checked, so 2/31/2026 is refused instead of rolling over.
 */
export function parseDateByFormat(raw, format) {
  const bad = { valid: false, iso: null };
  if (raw == null || !DATE_FORMATS.includes(format)) return bad;
  const s = String(raw).trim();
  let y; let m; let d;
  let hit;
  if (format === 'YYYY-MM-DD') {
    hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!hit) return bad;
    [y, m, d] = [+hit[1], +hit[2], +hit[3]];
  } else {
    hit = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!hit) return bad;
    if (format === 'M/D/YYYY') [m, d, y] = [+hit[1], +hit[2], +hit[3]];
    else [d, m, y] = [+hit[1], +hit[2], +hit[3]];
  }
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return bad;
  return { valid: true, iso: `${y}-${pad2(m)}-${pad2(d)}` };
}

const isoParts = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
};

/** Calendar days in [start, end], both ends counted: Oct 12 → Oct 12 is 1 day. */
export function termDays(startIso, endIso) {
  const s = isoParts(startIso);
  const e = isoParts(endIso);
  return Math.round((Date.UTC(e.y, e.m - 1, e.d) - Date.UTC(s.y, s.m - 1, s.d)) / 86_400_000) + 1;
}

/**
 * term_length_unusual fires when |term days − the plan's access_days| exceeds this.
 * A month either way absorbs how rosters round a term (Oct 12 → Apr 12 is 183 days on a
 * 180-day plan); a swapped D/M date or a VIP end left on a 60-day plan is far outside it.
 */
export const TERM_LENGTH_TOLERANCE_DAYS = 31;

/** 00:00 in Manila on a calendar date, as epoch ms. */
export function manilaStartMs(isoDate) {
  const { y, m, d } = isoParts(isoDate);
  return Date.UTC(y, m - 1, d) - MANILA_OFFSET_MS;
}

/** The LAST millisecond of a calendar date in Manila, as epoch ms. */
export function manilaEndMs(isoDate) {
  const { y, m, d } = isoParts(isoDate);
  return Date.UTC(y, m - 1, d + 1) - MANILA_OFFSET_MS - 1;
}

/**
 * The term SQL writes: started_at = start 00:00 Manila, ends_at = end 23:59:59.999
 * Manila, grace = ends_at + 3 days. Mirrors legacy_import_activate_row().
 */
export function manilaTerm(startIso, endIso) {
  const startMs = manilaStartMs(startIso);
  const endMs = manilaEndMs(endIso);
  const graceMs = endMs + GRACE_DAYS * 24 * 60 * 60 * 1000;
  return {
    startedAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    graceEndsAt: new Date(graceMs).toISOString(),
    startMs, endMs, graceMs,
  };
}

/** 'scheduled' before the start, 'active' during, 'ended' once grace has passed. */
export function termStatusAt(startIso, endIso, nowMs) {
  const t = manilaTerm(startIso, endIso);
  if (t.graceMs <= nowMs) return 'ended';
  return t.startMs > nowMs ? 'scheduled' : 'active';
}

/** "October 12, 2026" for an ISO calendar date — no Date/locale, so identical everywhere. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
export function formatCalendarDate(isoDate) {
  const { y, m, d } = isoParts(isoDate);
  if (!y || !m || !d) return '';
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// ── Payment ──────────────────────────────────────────────────────────────────
/** Only an explicit "paid" (any case) is paid. Everything else blocks. */
export function normalizePaymentStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { status: null, paid: false };
  return { status: s, paid: s === 'paid' };
}

/** Digits with optional thousands commas and up to two decimals. */
export function parseLegacyAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { present: false, valid: true, amount: null };
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return { present: true, valid: false, amount: null };
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > MAX_LEGACY_AMOUNT) return { present: true, valid: false, amount: null };
  return { present: true, valid: true, amount: Math.round(n * 100) / 100 };
}

export function normalizeCurrency(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s) return { present: false, valid: true, currency: null };
  return /^[A-Z]{3}$/.test(s) ? { present: true, valid: true, currency: s } : { present: true, valid: false, currency: null };
}

// ── Plans ────────────────────────────────────────────────────────────────────
export const normalizeLabel = (raw) => String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').toLowerCase();

/** The spellings of one plan that a roster label may use, all normalized (#68). */
function planLabelCandidates(p) {
  const out = new Set();
  const add = (s) => { const n = normalizeLabel(s); if (n) out.add(n); };
  add(p?.key);
  for (const text of [p?.name, p?.tagline]) {
    const n = normalizeLabel(text);
    if (!n) continue;
    add(n);
    // "Silver · Self-Paced" is written "Silver" in a roster; "VIP Package" is "VIP".
    add(n.split('·')[0]);
    add(n.replace(/\s+package$/, ''));
  }
  return out;
}

/**
 * A SUGGESTION for an unmapped plan label: an EXACT normalized match on the plan's
 * key, its name (the package title), its tagline (the product line), or the first
 * part of either — before a `·`, or without a trailing " package". Nothing looser:
 * no substring, no fuzzy match, and a price is never a plan.
 *
 * ★ #68: before this, "Essentials" and "Silver" matched nothing, and the picker listed
 *   product names only, so an Essentials roster was one plausible click away from the
 *   full-access Silver plan. A label two plans both claim suggests NOTHING rather than
 *   the first of them. The admin still confirms every mapping; this only pre-fills it.
 */
export function suggestPlanForLabel(label, plans) {
  const n = normalizeLabel(label);
  if (!n) return null;
  const keys = new Set();
  for (const p of plans || []) if (p?.key && planLabelCandidates(p).has(n)) keys.add(p.key);
  return keys.size === 1 ? [...keys][0] : null;
}

/** Does this plan take a cohort? `community_segment` is the one fact every layer asks. */
export const isVipPlan = (plan) => plan?.community_segment === 'vip';

/**
 * The batch component of a non-VIP plan's record key (#68). A batch code is forced to
 * `YYYY-MM` by a CHECK constraint, so 'none' can never collide with one. It keeps "one
 * legacy grant per person per plan" for Silver and Essentials, whose rows used to get a
 * NULL key — and a NULL key escapes the unique index and both duplicate checks.
 */
export const NON_VIP_BATCH_TOKEN = 'none';

/**
 * Which plan wins when one person is in two rosters: the higher rank. An EXPLICIT order,
 * never a price or a catalog position — the cheapest plan is also the most scoped, so
 * price says nothing about scope. legacy_import_plan_rank() in SQL is the authority;
 * test/legacyMigration.test.mjs pins this mirror.
 */
const PLAN_RANK = Object.freeze({ vip: 3, silver_self_paced: 2, sampler: 1 });
export function planRank(key) {
  return Object.prototype.hasOwnProperty.call(PLAN_RANK, key) ? PLAN_RANK[key] : 0;
}

// ── Batches ──────────────────────────────────────────────────────────────────
const CODE_RE = /^(\d{4})-(\d{2})$/;
const monthIndex = (code) => {
  const m = CODE_RE.exec(String(code || ''));
  return m ? (+m[1]) * 12 + (+m[2] - 1) : null;
};

/** "October 2026" / "Oct 2026" / "2026-10" → '2026-10', or null. */
export function labelMonthCode(label) {
  const s = normalizeLabel(label);
  if (CODE_RE.test(s)) return s;
  const m = /^([a-z]+)\.?\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const idx = MONTHS.findIndex((name) => {
    const n = name.toLowerCase();
    return m[1] === n || (m[1].length >= 3 && n.startsWith(m[1]));
  });
  return idx < 0 ? null : `${m[2]}-${pad2(idx + 1)}`;
}

/**
 * A SUGGESTION for an unmapped batch label: the registry batch whose name matches
 * exactly (case-insensitive) or whose code the label IS — and only when the month
 * the label names equals that batch's code. A renamed batch ("August 2026" edited
 * to name September's cohort) therefore produces no suggestion instead of a wrong one.
 */
export function suggestBatchForLabel(label, batches) {
  const n = normalizeLabel(label);
  if (!n) return null;
  const named = labelMonthCode(label);
  const hit = (batches || []).find((b) => normalizeLabel(b.name) === n || b.code === n);
  if (!hit || !named || hit.code !== named) return null;
  return hit.code;
}

/** Is the row's start month the batch month or next to it? */
export function startDateFitsBatch(startIso, batchCode) {
  const b = monthIndex(batchCode);
  if (b == null || !startIso) return false;
  const { y, m } = isoParts(startIso);
  return Math.abs((y * 12 + (m - 1)) - b) <= 1;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How many cohort seats a VIP legacy term buys (#68): the whole months in
 * [start, end], at least 1 and at most the plan's own batch count.
 *
 *   months = (ey-sy)*12 + (em-sm) - (ed' < sd ? 1 : 0), on start and end' = end + 1 day
 *   seats  = max(1, min(planBatchCount, months))
 *
 * So Oct 12 → Apr 12 is 6 seats, and a student who paid for one month gets 1 — never
 * the plan's full six, which was what #67 granted every VIP row whatever it had bought.
 * SQL's legacy_import_seat_count() is the authority; it computes the same months with
 * `extract(year from age(p_end + 1, p_start))*12 + extract(month from age(...))`.
 *
 * `planBatchCount` is plan_eligible_batch_count() for the plan — 6 for VIP. A non-VIP
 * plan takes no cohort: pass 0 (or nothing) and the answer is 0, as it is in SQL.
 * Unreadable dates also give 0, never a guessed number of seats.
 *
 * ★ NO TERM, NO COUNT — AND THAT INCLUDES AN END BEFORE ITS START. SQL returns NULL for a
 *   missing date and for `p_end < p_start`, BEFORE its greatest(1, …) runs; this mirror
 *   answers 0 for both (its one spelling of "no seats"). It used to fall through to
 *   max(1, …) and report 1 seat for swapped dates — and the test pinned that 1 with a
 *   message that described the SQL wrongly. An end equal to the start is a real one-day
 *   term and still buys its one seat, on both sides.
 */
export function legacySeatCount(startIso, endIso, planBatchCount) {
  const cap = Math.trunc(Number(planBatchCount));
  if (!Number.isFinite(cap) || cap < 1) return 0;
  if (!ISO_DATE_RE.test(String(startIso || '')) || !ISO_DATE_RE.test(String(endIso || ''))) return 0;
  // Zero-padded ISO dates order as strings; the regex above guarantees the padding.
  if (String(endIso) < String(startIso)) return 0;
  const s = isoParts(startIso);
  const e = isoParts(endIso);
  // end + 1 day, through Date.UTC so a month or year boundary rolls over correctly.
  const next = new Date(Date.UTC(e.y, e.m - 1, e.d + 1));
  const ey = next.getUTCFullYear(); const em = next.getUTCMonth() + 1; const ed = next.getUTCDate();
  const months = (ey - s.y) * 12 + (em - s.m) - (ed < s.d ? 1 : 0);
  return Math.max(1, Math.min(cap, months));
}

// ── Identity and idempotency ─────────────────────────────────────────────────
/**
 * The string whose SHA-256 is the row's legacy_record_key. One legacy purchase =
 * one identity + plan + cohort. SQL builds the SAME string in legacy_import_stage()
 * and hashes it with sha256(); the database value is the authority.
 *
 * For a non-VIP plan the caller passes NON_VIP_BATCH_TOKEN as `batchCode` (#68), so
 * the key reads `thinkific|email:x|silver_self_paced|none`, exactly as SQL builds it.
 */
export function legacyRecordKeyInput({ externalId, email, planKey, batchCode }) {
  const identity = externalId ? `ext:${externalId}` : `email:${email}`;
  return `${LEGACY_SOURCE}|${identity}|${planKey}|${batchCode}`;
}

// ── Normalization ────────────────────────────────────────────────────────────
const cell = (raw, mapping, key) => {
  const h = mapping && mapping[key];
  if (!h) return '';
  const v = raw ? raw[h] : '';
  return v == null ? '' : String(v).trim();
};

/**
 * Turn parsed CSV rows into staged rows. Nothing here reads the network: plans,
 * batches, the confirmed mappings and "now" are all passed in.
 *
 * @param rows            [{ header: value }]
 * @param opts.mapping    { fieldKey: header }
 * @param opts.dateFormat one of DATE_FORMATS — REQUIRED, never inferred
 * @param opts.planMapping  { normalizedLabel: planKey }   (admin-confirmed)
 * @param opts.batchMapping { normalizedLabel: batchCode } (admin-confirmed)
 * @param opts.plans      [{ key, name, tagline, active, price_php, access_days, community_segment }]
 *                        — ★ community_segment is what decides whether a row takes a batch;
 *                        a plan read without it is treated as non-VIP here, and SQL (which
 *                        reads the live catalog) then blocks any VIP row that lost its batch.
 * @param opts.batches    [{ id, code, name, status }]
 * @param opts.eligibleBatchCodes  cohorts chosen for activation (VIP rows)
 * @param opts.eligiblePlanKeys    non-VIP plans chosen for activation (#68)
 * @param opts.nowMs      epoch ms
 */
export function normalizeLegacyRows(rows, opts) {
  const {
    mapping = {}, dateFormat, planMapping = {}, batchMapping = {},
    plans = [], batches = [], eligibleBatchCodes = [], eligiblePlanKeys = [], nowMs,
  } = opts || {};
  if (!DATE_FORMATS.includes(dateFormat)) throw new Error('normalizeLegacyRows: a declared date format is required');
  if (typeof nowMs !== 'number') throw new Error('normalizeLegacyRows: nowMs is required');

  const planByKey = new Map(plans.map((p) => [p.key, p]));
  const batchByCode = new Map(batches.map((b) => [b.code, b]));
  const eligible = new Set(eligibleBatchCodes);
  const eligiblePlans = new Set(eligiblePlanKeys);

  const out = (rows || []).map((raw, i) => {
    const errors = [];
    const warnings = [];

    const externalId = parseExternalId(cell(raw, mapping, 'external_user_id'));
    if (!externalId) warnings.push('external_id_missing');

    const emailRaw = cell(raw, mapping, 'email');
    const email = normalizeEmail(emailRaw);
    if (!emailRaw) errors.push('email_missing');
    else if (!email) errors.push('email_invalid');

    const planLabel = cell(raw, mapping, 'plan_label');
    let planKey = null;
    if (!planLabel) errors.push('plan_missing');
    else {
      planKey = planMapping[normalizeLabel(planLabel)] || null;
      if (!planKey) errors.push('plan_unmapped');
      else if (!planByKey.has(planKey) || planByKey.get(planKey).active === false) { errors.push('plan_unknown'); planKey = null; }
    }

    const start = parseDateByFormat(cell(raw, mapping, 'start_date'), dateFormat);
    const end = parseDateByFormat(cell(raw, mapping, 'end_date'), dateFormat);
    if (!start.valid) errors.push('start_date_invalid');
    if (!end.valid) errors.push('end_date_invalid');
    const plan = planKey ? planByKey.get(planKey) : null;
    const vip = isVipPlan(plan);
    if (start.valid && end.valid) {
      if (end.iso < start.iso) errors.push('date_order');
      else {
        if (termStatusAt(start.iso, end.iso, nowMs) === 'ended') errors.push('term_ended');
        // #68: a warning, never a block — a legacy term may legitimately differ from what
        // the plan sells today. It catches a swapped D/M format on a plan with no batch
        // month to check it against, and a 180-day VIP end left on a 60-day plan.
        const accessDays = Number(plan?.access_days);
        if (Number.isFinite(accessDays) && accessDays > 0
          && Math.abs(termDays(start.iso, end.iso) - accessDays) > TERM_LENGTH_TOLERANCE_DAYS) {
          warnings.push('term_length_unusual');
        }
      }
    }

    // ★ THE BATCH RULES ARE VIP-ONLY (#68). A Silver or Essentials row runs none of them
    //   and stores no batch; a label in the file is kept as history, with a warning. A
    //   row whose plan is unmapped or unknown skips them too — it is already blocked by
    //   plan_*, and legacy_import_stage() (which reads the plan's segment) does the same.
    const batchLabel = cell(raw, mapping, 'batch_label');
    let batchCode = null;
    if (!vip) {
      if (batchLabel && planKey) warnings.push('batch_ignored_for_plan');
    } else if (!batchLabel) errors.push('batch_missing');
    else {
      batchCode = batchMapping[normalizeLabel(batchLabel)] || null;
      const batch = batchCode ? batchByCode.get(batchCode) : null;
      if (!batchCode) errors.push('batch_unmapped');
      else if (!batch) { errors.push('batch_unknown'); batchCode = null; }
      else {
        if (batch.status === 'archived') errors.push('batch_archived');
        const named = labelMonthCode(batchLabel);
        if (named && named !== batch.code) errors.push('batch_label_mismatch');
        if (start.valid && !startDateFitsBatch(start.iso, batch.code)) errors.push('batch_date_mismatch');
      }
    }

    const pay = normalizePaymentStatus(cell(raw, mapping, 'payment_status'));
    if (!pay.status) errors.push('payment_status_missing');
    else if (!pay.paid) errors.push('payment_not_paid');

    const amount = parseLegacyAmount(cell(raw, mapping, 'amount_paid'));
    if (!amount.valid) errors.push('amount_invalid');
    const currency = normalizeCurrency(cell(raw, mapping, 'currency'));
    if (!currency.valid) errors.push('currency_invalid');
    if (amount.valid && amount.amount != null && planKey) {
      const price = Number(planByKey.get(planKey)?.price_php);
      if (Number.isFinite(price) && price !== amount.amount) warnings.push('amount_differs_from_price');
    }

    return {
      source_row_number: i + 1,
      external_user_id: externalId || null,
      email_normalized: email || null,
      email_display: emailRaw || null,
      first_name: cell(raw, mapping, 'first_name') || null,
      last_name: cell(raw, mapping, 'last_name') || null,
      plan_key: planKey,
      legacy_plan_label: planLabel || null,
      batch_code: batchCode,
      legacy_batch_label: batchLabel || null,
      start_date: start.valid ? start.iso : null,
      end_date: end.valid ? end.iso : null,
      payment_status: pay.status,
      amount_paid: amount.valid ? amount.amount : null,
      currency: currency.valid ? currency.currency : null,
      phone: normalizePhone(cell(raw, mapping, 'phone')),
      identity_basis: externalId ? 'external_id' : 'email',
      // ★ Non-VIP rows key on NON_VIP_BATCH_TOKEN, never on a NULL batch (#68).
      record_key_input: email && planKey && (vip ? batchCode : true)
        ? legacyRecordKeyInput({ externalId, email, planKey, batchCode: vip ? batchCode : NON_VIP_BATCH_TOKEN })
        : null,
      errors,
      warnings,
    };
  });

  // Cross-row: the same person twice in one file is never two memberships.
  const byEmail = new Map();
  for (const r of out) {
    if (!r.email_normalized) continue;
    if (!byEmail.has(r.email_normalized)) byEmail.set(r.email_normalized, []);
    byEmail.get(r.email_normalized).push(r);
  }
  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    // #68: under DIFFERENT mapped plans the copies are an upgrade, not a bundle export
    // listing one purchase twice. Still blocked either way — nothing picks a winner —
    // but the reason says which case it is, so the owner knows what to fix in the file.
    const plansSeen = new Set(group.map((r) => r.plan_key).filter(Boolean));
    for (const r of group) {
      r.errors.push('duplicate_in_file');
      if (plansSeen.size > 1) r.errors.push('multiple_plans_in_file');
    }
  }

  // A phone shared by two DIFFERENT emails is a hint, never an identity (see LEGACY_FIELDS).
  const emailsByPhone = new Map();
  for (const r of out) {
    if (!r.phone) continue;
    if (!emailsByPhone.has(r.phone)) emailsByPhone.set(r.phone, new Set());
    emailsByPhone.get(r.phone).add(r.email_normalized || '');
  }
  for (const r of out) {
    if (r.phone && emailsByPhone.get(r.phone).size > 1) r.warnings.push('phone_shared');
  }

  for (const r of out) {
    // Unreachable today (a valid row has an email, a known plan and, for VIP, a batch),
    // and kept that way on purpose: SQL adds the same error, because a keyless row escapes
    // every guard against granting one purchase twice.
    if (r.errors.length === 0 && !r.record_key_input) r.errors.push('record_key_missing');
    const dup = r.errors.includes('duplicate_in_file');
    r.validation_status = r.errors.length === 0 ? 'valid' : (dup ? 'duplicate' : 'blocked');
    // ★ READY IS CHOSEN PER COHORT FOR VIP AND PER PLAN FOR EVERYTHING ELSE (#68). A
    //   non-VIP row has no batch, so the cohort test alone left every one of them
    //   inactive for good. legacy_import_stage() applies the same two tests.
    const vip = isVipPlan(planByKey.get(r.plan_key));
    const chosen = vip ? eligible.has(r.batch_code) : eligiblePlans.has(r.plan_key);
    r.activation_state = r.validation_status !== 'valid' ? 'blocked' : (chosen ? 'ready' : 'inactive');
  }
  return out;
}

/** Distinct non-empty values of one mapped column, for the mapping tables. */
export function distinctLabels(rows, mapping, fieldKey) {
  const seen = new Map();
  for (const raw of rows || []) {
    const v = cell(raw, mapping, fieldKey);
    if (!v) continue;
    const n = normalizeLabel(v);
    if (!seen.has(n)) seen.set(n, { label: v, normalized: n, count: 0 });
    seen.get(n).count += 1;
  }
  return [...seen.values()];
}

/**
 * The cohorts pre-selected for activation: ONLY the newest cohort in the file.
 * An older cohort is activated by a deliberate Super Admin choice, never by default.
 */
export function defaultEligibleCodes(stagedRows) {
  const codes = [...new Set((stagedRows || [])
    .filter((r) => r.validation_status === 'valid' && r.batch_code)
    .map((r) => r.batch_code))].sort();
  return codes.length ? [codes[codes.length - 1]] : [];
}

/**
 * The non-VIP plans pre-selected for activation (#68): every one that has a valid row,
 * in catalog order. Unlike a cohort, a self-paced purchase has no "newest" to prefer —
 * a still-running paid term is owed — and activation still needs the typed
 * confirmation (owner decision, 2026-09-28).
 */
export function defaultEligiblePlanKeys(stagedRows, plans) {
  const withValid = new Set((stagedRows || [])
    .filter((r) => r.validation_status === 'valid' && r.plan_key)
    .map((r) => r.plan_key));
  return (plans || [])
    .filter((p) => p?.key && withValid.has(p.key) && !isVipPlan(p))
    .map((p) => p.key);
}

/**
 * Per-plan counts (#68), in catalog order, for the wizard's plan tables: which
 * package each row became, and whether it is ready. A row with no mapped plan is
 * blocked by plan_* and is left out — it has no package to show, and a table built
 * for ticking plans must not offer a tick for "no plan".
 */
export function planSummary(stagedRows, plans) {
  const by = new Map();
  for (const r of stagedRows || []) {
    if (!r.plan_key) continue;
    if (!by.has(r.plan_key)) by.set(r.plan_key, { total: 0, ready: 0, inactive: 0, blocked: 0 });
    const g = by.get(r.plan_key);
    g.total += 1;
    if (r.activation_state === 'ready') g.ready += 1;
    else if (r.activation_state === 'inactive') g.inactive += 1;
    else g.blocked += 1;
  }
  const catalog = (plans || []).filter((p) => p?.key);
  const known = new Set(catalog.map((p) => p.key));
  const order = [...catalog.map((p) => p.key).filter((k) => by.has(k)),
    ...[...by.keys()].filter((k) => !known.has(k)).sort()];
  return order.map((key) => {
    const p = catalog.find((x) => x.key === key) || null;
    return {
      plan_key: key,
      name: p?.name || null,
      tagline: p?.tagline || null,
      segment: p?.community_segment || null,
      ...by.get(key),
    };
  });
}

/**
 * Per-cohort counts, sorted by code; blocked rows with no batch land under null.
 * Pass `plans` (#68) to count VIP rows only: a Silver or Essentials row has no batch
 * by design and belongs in planSummary(), not in a "No batch" line of this table.
 */
export function cohortSummary(stagedRows, plans) {
  const planByKey = plans ? new Map(plans.filter((p) => p?.key).map((p) => [p.key, p])) : null;
  const by = new Map();
  for (const r of stagedRows || []) {
    if (planByKey && r.plan_key && planByKey.has(r.plan_key) && !isVipPlan(planByKey.get(r.plan_key))) continue;
    const k = r.batch_code || null;
    if (!by.has(k)) by.set(k, { batch_code: k, label: r.legacy_batch_label || null, total: 0, ready: 0, inactive: 0, blocked: 0 });
    const g = by.get(k);
    g.total += 1;
    if (r.activation_state === 'ready') g.ready += 1;
    else if (r.activation_state === 'inactive') g.inactive += 1;
    else g.blocked += 1;
  }
  // Null LAST. The old `localeCompare` on a '~' stand-in meant to do this, but a locale
  // collation sorts punctuation before digits, so "No batch" always came first.
  return [...by.values()].sort((a, b) => {
    if (a.batch_code === b.batch_code) return 0;
    if (a.batch_code == null) return 1;
    if (b.batch_code == null) return -1;
    return a.batch_code < b.batch_code ? -1 : 1;
  });
}

// ── Phone ────────────────────────────────────────────────────────────────────
/** Digits only, 7–15 of them (E.164's range), or null. The SQL CHECK matches. */
export function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  return /^[0-9]{7,15}$/.test(digits) ? digits : null;
}

// ── Activation terms ─────────────────────────────────────────────────────────
/** Today's calendar date in Manila, as YYYY-MM-DD. */
export function manilaTodayISO(nowMs) {
  return new Date(nowMs + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * ★ OPEN ACCESS ON THE ACTIVATION DAY (owner decision, 2026-09-26). A roster start still
 * ahead is brought forward to today, so an activated student reaches the dashboard at
 * once; a start already past is kept, so the record says when the membership began. The
 * END is never moved by this — it stays the date the student paid for.
 */
export function defaultActivationStart(rosterStartIso, todayIso) {
  if (!rosterStartIso) return todayIso || null;
  if (!todayIso) return rosterStartIso;
  return rosterStartIso > todayIso ? todayIso : rosterStartIso;
}

/**
 * The terms an activation will grant: what the Super Admin assigned, else what the roster
 * said. legacy_import_activate_row() computes the same four coalesces.
 */
export function effectiveTerms(row) {
  const r = row || {};
  return {
    plan_key: r.activation_plan_key ?? r.proposed_plan_key ?? r.plan_key ?? null,
    batch_id: r.activation_batch_id ?? r.proposed_batch_id ?? null,
    start_date: r.activation_start_date ?? r.legacy_start_date ?? r.start_date ?? null,
    end_date: r.activation_end_date ?? r.legacy_end_date ?? r.end_date ?? null,
  };
}

// ── Activation ───────────────────────────────────────────────────────────────
export const activationPhrase = (n) => `ACTIVATE ${n}`;
export const phraseMatches = (typed, n) => String(typed == null ? '' : typed).trim() === activationPhrase(n);

/**
 * The legal activation_state moves. SQL enforces them; the workspace reads this
 * table to decide which buttons to offer. `revert` needs an unclaimed account.
 */
export const ACTIVATION_TRANSITIONS = {
  promote: { from: ['inactive'], to: 'ready' },
  demote: { from: ['ready'], to: 'inactive' },
  claim: { from: ['ready', 'failed'], to: 'activating' },
  activate: { from: ['activating'], to: 'activated' },
  block: { from: ['activating'], to: 'blocked' },
  fail: { from: ['activating'], to: 'failed' },
  revert: { from: ['activated'], to: 'reverted' },
};

export function canTransition(state, event) {
  const t = ACTIVATION_TRANSITIONS[event];
  return !!t && t.from.includes(state);
}

/**
 * One label per row for the workspace, in the terms the owner uses:
 * Inactive · Pending activation · Blocked · Activating · Activated ·
 * Invitation failed · Onboarded · Failed · Reverted.
 */
export function rowDisplayState(row) {
  const s = row?.activation_state;
  if (s === 'activated') {
    if (row.claimed) return 'Onboarded';
    if (row.invite_state === 'failed' || row.invite_state === 'uncertain') return 'Invitation failed';
    return 'Activated';
  }
  return {
    inactive: 'Inactive', ready: 'Pending activation', activating: 'Activating',
    failed: 'Failed', blocked: 'Blocked', reverted: 'Reverted',
  }[s] || 'Staged';
}

/**
 * The counts the confirmation dialog must show before anything is written.
 * `rows` are the SELECTED rows as the server returned them.
 */
export function activationPreflight(rows) {
  const sel = rows || [];
  const ready = sel.filter((r) => r.activation_state === 'ready');
  const excluded = sel.length - ready.length;
  const existing = ready.filter((r) => r.matched_existing).length;
  // A CONFIRMED existing account keeps its password and gets a notification. An
  // existing account that never confirmed its email gets the same claim link a new
  // one does — it has no working sign-in to notify.
  const confirmed = ready.filter((r) => r.matched_existing && r.existing_confirmed).length;
  const cohorts = [...new Set(ready.map((r) => r.batch_code).filter(Boolean))].sort();
  const plans = [...new Set(ready.map((r) => r.plan_key).filter(Boolean))].sort();
  const starts = [...new Set(ready.map((r) => r.start_date).filter(Boolean))].sort();
  const ends = [...new Set(ready.map((r) => r.end_date).filter(Boolean))].sort();
  return {
    selected: sel.length,
    toActivate: ready.length,
    excluded,
    newAccounts: ready.length - existing,
    existingAccounts: existing,
    claimEmails: ready.length - confirmed,
    notifications: confirmed,
    cohorts, plans, starts, ends,
    phrase: activationPhrase(ready.length),
  };
}
