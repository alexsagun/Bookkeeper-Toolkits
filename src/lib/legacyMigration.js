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
export const LEGACY_FIELDS = [
  { key: 'external_user_id', label: 'Thinkific user id', required: false, aliases: ['thinkific_user_id', 'user_id', 'id'] },
  { key: 'first_name', label: 'First name', required: false, aliases: ['first_name', 'firstname', 'first name'] },
  { key: 'last_name', label: 'Last name', required: false, aliases: ['last_name', 'lastname', 'last name'] },
  { key: 'email', label: 'Email', required: true, aliases: ['email', 'email_address', 'e-mail'] },
  { key: 'plan_label', label: 'Plan', required: true, aliases: ['plan_key', 'plan', 'package'] },
  { key: 'start_date', label: 'Membership start', required: true, aliases: ['membership_started_at', 'start_date', 'started_at'] },
  { key: 'end_date', label: 'Membership end', required: true, aliases: ['membership_ends_at', 'end_date', 'ends_at', 'expiry'] },
  { key: 'payment_status', label: 'Payment status', required: true, aliases: ['payment_status', 'payment'] },
  { key: 'amount_paid', label: 'Amount paid', required: false, aliases: ['amount_paid', 'amount'] },
  { key: 'currency', label: 'Currency', required: false, aliases: ['currency'] },
  { key: 'batch_label', label: 'Batch', required: true, aliases: ['batch_code', 'batch', 'cohort'] },
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
};

export const LEGACY_WARNING_LABELS = {
  phone_shared: 'Another student, or an earlier enrollment, uses this phone under a different email. Check it is not the same person.',
  external_id_missing: 'No Thinkific id: the account is matched by email.',
  existing_account: 'An account with this email already exists; it will be linked, not duplicated.',
  amount_differs_from_price: 'The amount paid differs from today\'s price. It is kept as history only.',
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

/**
 * A SUGGESTION for an unmapped plan label: an exact match on a plan key or plan
 * name, nothing looser. The admin still has to confirm it — `VIP` suggests `vip`,
 * but it is the confirmed mapping, not this function, that stages the row.
 */
export function suggestPlanForLabel(label, plans) {
  const n = normalizeLabel(label);
  if (!n) return null;
  const hit = (plans || []).find((p) => normalizeLabel(p.key) === n || normalizeLabel(p.name) === n);
  return hit ? hit.key : null;
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

// ── Identity and idempotency ─────────────────────────────────────────────────
/**
 * The string whose SHA-256 is the row's legacy_record_key. One legacy purchase =
 * one identity + plan + cohort. SQL builds the SAME string in legacy_import_stage()
 * and hashes it with sha256(); the database value is the authority.
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
 * @param opts.plans      [{ key, name, active, price_php }]
 * @param opts.batches    [{ id, code, name, status }]
 * @param opts.eligibleBatchCodes  cohorts chosen for activation
 * @param opts.nowMs      epoch ms
 */
export function normalizeLegacyRows(rows, opts) {
  const {
    mapping = {}, dateFormat, planMapping = {}, batchMapping = {},
    plans = [], batches = [], eligibleBatchCodes = [], nowMs,
  } = opts || {};
  if (!DATE_FORMATS.includes(dateFormat)) throw new Error('normalizeLegacyRows: a declared date format is required');
  if (typeof nowMs !== 'number') throw new Error('normalizeLegacyRows: nowMs is required');

  const planByKey = new Map(plans.map((p) => [p.key, p]));
  const batchByCode = new Map(batches.map((b) => [b.code, b]));
  const eligible = new Set(eligibleBatchCodes);

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
    if (start.valid && end.valid) {
      if (end.iso < start.iso) errors.push('date_order');
      else if (termStatusAt(start.iso, end.iso, nowMs) === 'ended') errors.push('term_ended');
    }

    const batchLabel = cell(raw, mapping, 'batch_label');
    let batchCode = null;
    if (!batchLabel) errors.push('batch_missing');
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
      record_key_input: email && planKey && batchCode
        ? legacyRecordKeyInput({ externalId, email, planKey, batchCode }) : null,
      errors,
      warnings,
    };
  });

  // Cross-row: the same person twice in one file is never two memberships.
  const byEmail = new Map();
  for (const r of out) {
    if (!r.email_normalized) continue;
    byEmail.set(r.email_normalized, (byEmail.get(r.email_normalized) || 0) + 1);
  }
  for (const r of out) {
    if (r.email_normalized && byEmail.get(r.email_normalized) > 1) r.errors.push('duplicate_in_file');
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
    const dup = r.errors.includes('duplicate_in_file');
    r.validation_status = r.errors.length === 0 ? 'valid' : (dup ? 'duplicate' : 'blocked');
    r.activation_state = r.validation_status !== 'valid' ? 'blocked'
      : (eligible.has(r.batch_code) ? 'ready' : 'inactive');
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

/** Per-cohort counts, sorted by code; blocked rows with no batch land under null. */
export function cohortSummary(stagedRows) {
  const by = new Map();
  for (const r of stagedRows || []) {
    const k = r.batch_code || null;
    if (!by.has(k)) by.set(k, { batch_code: k, label: r.legacy_batch_label || null, total: 0, ready: 0, inactive: 0, blocked: 0 });
    const g = by.get(k);
    g.total += 1;
    if (r.activation_state === 'ready') g.ready += 1;
    else if (r.activation_state === 'inactive') g.inactive += 1;
    else g.blocked += 1;
  }
  return [...by.values()].sort((a, b) => String(a.batch_code || '~').localeCompare(String(b.batch_code || '~')));
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
