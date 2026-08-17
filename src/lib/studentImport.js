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
export function parseStrictDate(raw) {
  const invalid = { valid: false, epochMs: null, iso: null, display: '', tz: 'UTC' };
  if (raw == null) return invalid;
  const s = String(raw).trim();
  if (!s) return invalid;

  let epochMs = null;

  // ISO 8601 with time + explicit Z/offset, e.g. 2026-07-20T01:52:00Z
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
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
    if (m) {
      const [, y, mo, d, h, mi, se] = m;
      epochMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    }
  }

  // Date-only "2026-07-20" → UTC midnight.
  if (epochMs == null) {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
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

// ── Membership term computation (the preserve/expired/fresh/lifetime decision) ──
// Pure. All time inputs are epoch-ms (or null). Returns:
//   { action, started_at, ends_at, grace_ends_at, status }
// where *_at are epoch-ms|null and action ∈
//   'grant' | 'skip_preserve_longer' | 'block_conflict' | 'block_missing_expiry' | 'noop_profile_only'
// RULES: preserve exact source expiry; grace = ends + 3d; status active only while
// valid. An existing ACTIVE term is NEVER silently shortened. Different-plan overlap
// defaults to manual review. "fresh" / "lifetime" are explicit, non-default modes.
export function computeImportTerm({
  planKey,
  accessDays = null,
  startedAt = null,
  endsAt = null,
  mode = 'preserve',
  existingActiveSub = null,   // { plan_key, ends_at(ms|null), grace_ends_at(ms|null) } | null
  conflictPolicy = 'keep_longer', // 'keep_longer' | 'overwrite'
  now,
}) {
  const nowMs = typeof now === 'number' ? now : null;
  if (nowMs == null) throw new Error('computeImportTerm: now (epoch ms) is required');

  if (mode === 'profile_only') {
    return { action: 'noop_profile_only', started_at: null, ends_at: null, grace_ends_at: null, status: null };
  }

  // 1) Build the candidate term from the mode.
  let started_at = null;
  let ends_at = null;
  let grace_ends_at = null;
  let status = 'active';

  if (mode === 'preserve') {
    if (endsAt == null) {
      return { action: 'block_missing_expiry', started_at: null, ends_at: null, grace_ends_at: null, status: null };
    }
    ends_at = endsAt;
    grace_ends_at = endsAt + GRACE_DAYS * DAY_MS;
    started_at = startedAt != null ? startedAt
      : (accessDays != null ? endsAt - accessDays * DAY_MS : nowMs);
    status = grace_ends_at > nowMs ? 'active' : 'expired';
  } else if (mode === 'expired_history') {
    ends_at = endsAt != null ? endsAt : nowMs;
    grace_ends_at = ends_at + GRACE_DAYS * DAY_MS;
    started_at = startedAt != null ? startedAt : null;
    status = 'expired';
  } else if (mode === 'fresh') {
    started_at = nowMs;
    ends_at = accessDays != null ? nowMs + accessDays * DAY_MS : null;
    grace_ends_at = ends_at != null ? ends_at + GRACE_DAYS * DAY_MS : null;
    status = 'active';
  } else if (mode === 'lifetime') {
    started_at = startedAt != null ? startedAt : nowMs;
    ends_at = null;          // never expires (grandfathered)
    grace_ends_at = null;
    status = 'active';
  } else {
    return { action: 'block_conflict', started_at: null, ends_at: null, grace_ends_at: null, status: null,
      reason: `Unknown term mode: ${mode}` };
  }

  // 2) Reconcile with an existing ACTIVE term (never shorten live access).
  if (existingActiveSub) {
    const existingEnd = existingActiveSub.ends_at == null
      ? Infinity
      : (existingActiveSub.grace_ends_at != null ? existingActiveSub.grace_ends_at : existingActiveSub.ends_at);
    const existingActive = existingEnd > nowMs;

    if (existingActive) {
      // A non-active candidate must never disturb a live term.
      if (status !== 'active') {
        return { action: 'skip_preserve_longer', started_at, ends_at, grace_ends_at, status };
      }
      if (existingActiveSub.plan_key !== planKey) {
        if (conflictPolicy !== 'overwrite') {
          return { action: 'block_conflict', started_at, ends_at, grace_ends_at, status,
            reason: 'A different active plan already exists — resolve manually.' };
        }
        // explicit overwrite → supersede + grant
      } else {
        const candidateEnd = ends_at == null ? Infinity : (grace_ends_at != null ? grace_ends_at : ends_at);
        if (candidateEnd <= existingEnd) {
          return { action: 'skip_preserve_longer', started_at, ends_at, grace_ends_at, status };
        }
        // candidate extends the same plan → supersede + grant
      }
    }
  }

  return { action: 'grant', started_at, ends_at, grace_ends_at, status };
}

// ── Onboarding step decision (retry-safe) ───────────────────────────────────────
// Decides whether a processed row is an import-created stub that still needs the
// account_origin/onboarding stamp + a set-password invite. MUST key off the DURABLE
// row flag (authUserCreated), not just whether generateLink ran THIS pass
// (createdThisPass): a retry after a mid-row failure resolves the user via link/email
// (so generateLink never runs this pass) but MUST still stamp + invite — otherwise the
// account exists with a granted subscription but no password and the forced set-password
// gate (keyed on account_origin==='import') never fires. An already-sent/resent invite is
// not re-sent.
export function decideOnboardingStep({ createdThisPass = false, authUserCreated = false, inviteStatus = null } = {}) {
  const isImportStub = createdThisPass === true || authUserCreated === true;
  const inviteAlreadySent = inviteStatus === 'sent' || inviteStatus === 'resent';
  return { isImportStub, shouldStamp: isImportStub, shouldInvite: isImportStub && !inviteAlreadySent };
}

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
