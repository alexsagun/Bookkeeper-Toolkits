// ─────────────────────────────────────────────────────────────────────────────
// studentImport.js — PURE, dependency-free migration logic.
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the browser import wizard (src/BookkeeperPro.jsx), the server endpoint
// (api/admin/student-imports.js), and the node:test suite (test/studentImport.test.mjs).
// NO imports, NO side effects, NO DOM/Node/Supabase — every function is a pure
// transform so the same matching/term/sanitization rules run identically in all
// three places and can be unit-tested without a database.
//
// NON-NEGOTIABLE DATA RULE (encoded here): never infer paid access, plan, payment,
// start, or expiry from a course title, account-created date, last-sign-in, or
// amount-spent. Plan comes from the admin's explicit combo mapping; term dates come
// from a trustworthy source (Orders/ledger/manual template), never from course
// history. suggestPlanForCombo() only SUGGESTS — it never auto-confirms.
// ─────────────────────────────────────────────────────────────────────────────

export const GRACE_DAYS = 3;                 // matches approve_subscription()'s v_grace_days
export const DAY_MS = 24 * 60 * 60 * 1000;

// The downloadable supplemental-import template (exact column order).
export const IMPORT_TEMPLATE_COLUMNS = [
  'thinkific_user_id',
  'first_name',
  'last_name',
  'email',
  'plan_key',
  'membership_started_at',
  'membership_ends_at',
  'payment_status',
  'amount_paid',
  'currency',
  'legacy_enrollments',
  'batch_code',
];

// ── Email ────────────────────────────────────────────────────────────────────
// Conservative single-@ check (mirrors the api/notify-* isEmail). We LOWERCASE +
// TRIM for matching but callers keep the original for display.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmail(raw) {
  return typeof raw === 'string' && EMAIL_RE.test(raw.trim());
}

export function normalizeEmail(raw) {
  if (raw == null) return '';
  const t = String(raw).trim().toLowerCase();
  return EMAIL_RE.test(t) ? t : '';
}

// ── External id ───────────────────────────────────────────────────────────────
// Always a STRING so a leading-zero id (e.g. "007") is never coerced to a number.
export function parseExternalId(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

// ── Strict date parsing ─────────────────────────────────────────────────────────
// Accepts ONLY unambiguous forms and always interprets them as UTC (the source
// exports are UTC). Rejects locale-ambiguous forms like MM/DD/YYYY. Returns a
// stable shape so callers can display the timezone explicitly.
//   { valid, epochMs, iso, display, tz }  (tz is always 'UTC')
// ★ Every branch checks its components BEFORE building a date. Date.UTC() rolls an
//   impossible date over silently — 2026-02-31 became March 3 and 2026-13-01 became
//   January 2027 — so a typo in a roster used to stage as a different, valid-looking
//   membership date. (#67)
function componentsValid(y, mo, d, h = 0, mi = 0, se = 0) {
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && se >= 0 && se <= 59;
}

export function parseStrictDate(raw) {
  const invalid = { valid: false, epochMs: null, iso: null, display: '', tz: 'UTC' };
  if (raw == null) return invalid;
  const s = String(raw).trim();
  if (!s) return invalid;

  let epochMs = null;

  // ISO 8601 with time + explicit Z/offset, e.g. 2026-07-20T01:52:00Z
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m && !componentsValid(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0))) return invalid;
  if (m) {
    const [, y, mo, d, h, mi, se, zone] = m;
    if (!zone || zone === 'Z') {
      epochMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
    } else {
      const parsed = Date.parse(s);
      epochMs = Number.isNaN(parsed) ? null : parsed;
    }
  }

  // Thinkific "2026-07-20 01:52:00 UTC"
  if (epochMs == null) {
    m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(s);
    if (m && !componentsValid(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])) return invalid;
    if (m) {
      const [, y, mo, d, h, mi, se] = m;
      epochMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    }
  }

  // Date-only "2026-07-20" → UTC midnight.
  if (epochMs == null) {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m && !componentsValid(+m[1], +m[2], +m[3])) return invalid;
    if (m) {
      const [, y, mo, d] = m;
      epochMs = Date.UTC(+y, +mo - 1, +d, 0, 0, 0);
    }
  }

  if (epochMs == null || Number.isNaN(epochMs)) return invalid;

  // Range sanity (guards against typos like year 0202 or 9999).
  const year = new Date(epochMs).getUTCFullYear();
  if (year < 2000 || year > 2100) return invalid;

  const iso = new Date(epochMs).toISOString();
  return { valid: true, epochMs, iso, display: `${iso.replace('.000Z', 'Z')} (UTC)`, tz: 'UTC' };
}

// ── CSV formula-injection-safe output ───────────────────────────────────────────
// A cell whose value starts with = + - @ (or tab/CR) can execute as a formula when
// the exported CSV is opened in Excel/Sheets. Prefix a single quote to neutralize.
export function sanitizeCsvCell(v) {
  // A real JS number cannot carry a formula, and prefixing a negative one made a refund or a
  // loss month export as TEXT that a spreadsheet will not sum. Strings keep the full guard.
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

// Quote a single CSV field (after formula-sanitizing), doubling embedded quotes.
export function csvField(v) {
  const s = sanitizeCsvCell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build a full CSV string from an array of row-objects + an ordered header list.
export function toCsv(rows, headers) {
  const head = headers.map(csvField).join(',');
  const body = rows.map((r) => headers.map((h) => csvField(r[h])).join(',')).join('\r\n');
  return body ? `${head}\r\n${body}` : head;
}

// ── Minimal robust CSV parser ───────────────────────────────────────────────────
// Handles a leading BOM, quoted fields with embedded commas/newlines, and doubled
// quotes. Returns { headers, rows } where each row is an object keyed by header.
// (The wizard uses lazy-loaded xlsx for .xlsx; this covers .csv + the test fixtures.)
export function parseCsv(text) {
  let src = String(text == null ? '' : text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // strip BOM

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n') {
      record.push(field); field = '';
      records.push(record); record = [];
    } else if (c === '\r') {
      // swallow — \r\n handled by the \n branch; a lone \r also ends the row
      if (src[i + 1] !== '\n') { record.push(field); field = ''; records.push(record); record = []; }
    } else field += c;
  }
  if (field.length || record.length) { record.push(field); records.push(record); }

  // Drop a trailing empty record (file ended with a newline).
  while (records.length && records[records.length - 1].length === 1 && records[records.length - 1][0] === '') {
    records.pop();
  }
  if (!records.length) return { headers: [], rows: [] };

  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((rec) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = rec[idx] != null ? rec[idx] : ''; });
    return obj;
  });
  return { headers, rows };
}

// ── Course-combination parsing + plan SUGGESTION (never auto-confirmed) ─────────
// The Thinkific "Enrollments - list" field is a comma-joined list of course titles.
// The list itself arrives already unquoted (one CSV cell), so a plain split is safe.
export function parseEnrollmentsList(str) {
  if (!str) return [];
  return String(str)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// A stable key for a set of courses (order-independent) → drives combo grouping.
export function comboKeyOf(courses) {
  return [...new Set(courses.map((c) => c.trim()).filter(Boolean))].sort().join(' | ');
}

// Coarse category of a course title — for the SUGGESTION heuristic only.
// Order matters: an "Onboarding QuickBooks Mentors" title is a mentor-onboarding
// artifact, NOT proof of a purchased QBO course, so onboarding/mentor and the
// resume/profile tracks are detected BEFORE the generic quickbooks/qbo match.
export function classifyCourse(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('onboarding') || t.includes('mentor')) return 'onboarding';
  if (t.includes('resume') || t.includes('interview')) return 'resume';
  if (t.includes('profile') || t.includes('linkedin')) return 'profile';
  if (t.includes('quickbooks') || /\bqbo\b/.test(t)) return 'qbo';
  return 'other';
}

// Suggest a plan for a combo. Returns { suggested: planKey|null, reason }.
// IMPORTANT: this is advisory only — the admin must confirm every mapping. Sampler
// and VIP can never be inferred from course history, so we never suggest them.
//
// QBO-ONLY HISTORY HAS NO SUGGESTION (#39). It used to map to `core_self_paced`
// (QBO Mastery Only), which no longer exists. The remaining plans all grant MORE
// than QBO-only did, so auto-mapping that history would silently upsell an imported
// student into a broader, more expensive plan — it goes to manual review instead.
export function suggestPlanForCombo(courses) {
  const cats = new Set(courses.map(classifyCourse));
  const hasQbo = cats.has('qbo');
  const hasResume = cats.has('resume') || cats.has('profile');
  if (hasQbo && hasResume) {
    return { suggested: 'silver_self_paced', reason: 'QBO + Resume history — SUGGESTION only; confirm the actual purchased package.' };
  }
  return { suggested: null, reason: 'Cannot be inferred from course history — map manually or send to review.' };
}

// ── Matching (NEVER by name) ────────────────────────────────────────────────────
// matches: { bySource: userId|null, byEmail: userId|null, byEmailAmbiguous: bool }
// Returns { match_result, target_user_id, intended_action, blocked, reason }.
export function resolveMatchDecision({ hasEmail, emailValid }, matches) {
  const bySource = matches?.bySource || null;
  const byEmail = matches?.byEmail || null;
  const byEmailAmbiguous = !!matches?.byEmailAmbiguous;

  // External id and email resolve to DIFFERENT existing users → cannot safely merge.
  if (bySource && byEmail && bySource !== byEmail) {
    return { match_result: 'conflict', target_user_id: null, intended_action: 'manual_review', blocked: true,
      reason: 'External id and email resolve to different existing users.' };
  }
  if (bySource) {
    return { match_result: 'existing_by_source', target_user_id: bySource, intended_action: 'merge_grant', blocked: false,
      reason: 'Matched an existing Thinkific source link.' };
  }
  if (byEmailAmbiguous) {
    return { match_result: 'ambiguous', target_user_id: null, intended_action: 'manual_review', blocked: true,
      reason: 'The same email matches more than one account.' };
  }
  if (byEmail) {
    return { match_result: 'existing_by_email', target_user_id: byEmail, intended_action: 'merge_grant', blocked: false,
      reason: 'Matched an existing account by email.' };
  }
  // No match → a NEW account. It can only be created if we have a valid email to invite.
  if (!hasEmail || !emailValid) {
    return { match_result: 'new', target_user_id: null, intended_action: 'manual_review', blocked: true,
      reason: hasEmail ? 'Email is invalid — cannot create an account.' : 'Email is missing — cannot create an account.' };
  }
  return { match_result: 'new', target_user_id: null, intended_action: 'create_invite', blocked: false,
    reason: 'No existing account — will invite a new one.' };
}

// ── Membership terms ─────────────────────────────────────────────────────────────
// computeImportTerm() and decideOnboardingStep() were the v1 grant path (fresh / lifetime /
// overwrite terms, and the stamp-then-invite decision of the old process action). #67
// removed both: a legacy term now comes only from the roster's own dates, computed in SQL
// (legacy_import_term) and mirrored by manilaTerm() in src/lib/legacyMigration.js, and the
// activation saga lives in api/admin/student-imports.js + legacy_import_activate_row().

// ── Per-row field validation (cross-row dup detection is the caller's job) ──────
// Returns { warnings: string[], errors: string[] } for a normalized staged row.
export function validateRowFields({ hasEmail, emailRaw, startedAt, endsAt, hasExternalId }) {
  const warnings = [];
  const errors = [];
  if (!hasExternalId) warnings.push('No external (Thinkific) id — the source link cannot be recorded.');
  if (!hasEmail) {
    errors.push('Email is missing — a new account cannot be created without it.');
  } else if (emailRaw != null && !isValidEmail(emailRaw)) {
    errors.push('Email is invalid.');
  }
  if (startedAt != null && endsAt != null && startedAt > endsAt) {
    errors.push('Start date is after the end date.');
  }
  return { warnings, errors };
}
