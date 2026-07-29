// ─────────────────────────────────────────────────────────────────────────────
// appErrors.js — PURE, dependency-free mapping of Supabase/PostgREST errors to
// STABLE application error codes (#35).
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the browser (admin approve/assign flows, the community composer,
// course deep-link guards, assignment submission), the server endpoints, and
// test/appErrors.test.mjs. NO imports, NO side effects.
//
// WHY THIS EXISTS
// Before #35 every RPC failure surfaced as a raw Postgres string:
// AdminEnrollments.doApprove mapped exactly one code (PGRST202) and passed
// everything else through as `e.message`, so an admin hitting a full batch read
// a sentence written for a developer, and the client could not branch on the
// reason (e.g. "reopen the batch picker" vs "this needs a migration").
//
// HOW A CODE CROSSES THE WIRE
// public.app_error(code, message, http, context) raises with:
//     errcode = 'PT###'   → PostgREST maps SQLSTATE PT### to HTTP ###
//     hint    = '<CODE>'  → the stable branch key
//     detail  = '{"code":"<CODE>","context":{…}}'
//     message = the human sentence
// supabase-js surfaces these as PostgrestError { code, message, details, hint }.
//
// ★ BRANCH ON `hint`, NEVER ON HTTP STATUS OR `error.code`. The PT### → HTTP
// mapping is a PostgREST convention, not a Postgres guarantee. If it ever
// changes, the status degrades but `hint` and `details` keep working — so code
// that reads `hint` survives and code that reads the status does not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The catalog. Kept in lockstep with public.app_error_catalog() in
 * db/2026-07-30-batch-entitlements.sql — test/appErrors.test.mjs asserts every
 * code here has user-facing copy, and the DB suite diffs this list against the
 * function's rows so the two cannot drift silently.
 */
export const APP_ERROR_CODES = [
  // ── Batch / entitlement RPCs ──
  'BATCH_REQUIRED',
  'BATCH_NOT_FOUND',
  'BATCH_CLOSED',
  'BATCH_FULL',
  'NO_SPACE_FOR_SEGMENT',
  'INVALID_BATCH_CODE',
  'ENTITLEMENT_EXPIRED',
  'INVALID_PLAN',
  'ALREADY_ENTITLED',
  'RUN_LIMIT_EXCEEDED',
  'SEGMENT_MISMATCH',
  'INVALID_MEMBERSHIP_TRANSITION',
  'IMMUTABLE_ENTITLEMENT',
  'FORBIDDEN',
  'REQUEST_NOT_FOUND',
  // ── Course / community diagnostics ──
  'COURSE_ACCESS_DENIED',
  'LESSON_NOT_RELEASED',
  'COMMUNITY_ACCESS_DENIED',
  'COMMENT_PERMISSION_DENIED',
  // ── Assignments (#38) ──
  'ASSIGNMENT_CLOSED',
  'SUBMISSION_LOCKED',
  'COURSE_HAS_SUBMISSIONS',
  // ── Client-synthesised (never raised by SQL) ──
  'MIGRATION_MISSING',
];

const CODE_SET = new Set(APP_ERROR_CODES);

// Shape a stable code must have. Guards against echoing an arbitrary attacker- or
// Postgres-supplied `hint` (e.g. the "Perhaps you meant…" hints PostgREST adds)
// into the UI as though it were one of ours.
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,39}$/;

/**
 * Free-text messages raised BEFORE #35 that we still want to branch on:
 * approve_subscription/approve_extension and the #32-era admin_finalize_enrollment
 * raise plain strings. Ordered — first match wins, so put the specific patterns
 * above the general ones.
 */
const LEGACY_PATTERNS = [
  [/is full for|batch .* is full/i, 'BATCH_FULL'],
  [/needs a batch|pick an open batch/i, 'BATCH_REQUIRED'],
  [/is archived|closed to new assignments/i, 'BATCH_CLOSED'],
  [/batch not found/i, 'BATCH_NOT_FOUND'],
  [/has no active (gold|vip|\w+) space/i, 'NO_SPACE_FOR_SEGMENT'],
  [/unknown plan|plan .* is inactive/i, 'INVALID_PLAN'],
  [/request not found/i, 'REQUEST_NOT_FOUND'],
  [/only pending_review can be approved|request is \w+ —/i, 'INVALID_MEMBERSHIP_TRANSITION'],
  [/an extension keeps the current batch/i, 'INVALID_MEMBERSHIP_TRANSITION'],
  [/extension request has no extension_days/i, 'INVALID_MEMBERSHIP_TRANSITION'],
  [/admin only|admin_\w+: admin only/i, 'FORBIDDEN'],
];

/** User-facing copy. Written for the person who hit the error, not for a log. */
const COPY = {
  BATCH_REQUIRED: 'Choose a batch (training month) before approving this request.',
  BATCH_NOT_FOUND: "That batch no longer exists — refresh the batch list and pick again.",
  BATCH_CLOSED: 'That batch is closed to new members. Open it, or pick another batch.',
  BATCH_FULL: 'That batch is full for this plan. Raise its capacity or pick another batch.',
  NO_SPACE_FOR_SEGMENT:
    'That batch has no community space for this plan yet. Re-create the batch or contact support.',
  INVALID_BATCH_CODE: 'Batch codes look like 2026-08 (year and a real month).',
  ENTITLEMENT_EXPIRED: 'This membership has ended, so the action was refused.',
  INVALID_PLAN: 'That plan is unknown or no longer on sale.',
  ALREADY_ENTITLED: 'This member already has a seat in that batch — nothing to do.',
  RUN_LIMIT_EXCEEDED:
    'This member already holds the maximum number of upcoming batch seats. Revoke some before granting more.',
  SEGMENT_MISMATCH:
    'This grant would mix Gold and VIP seats in one run. Revoke the current run first, then grant the new plan.',
  INVALID_MEMBERSHIP_TRANSITION: 'That change is not allowed from the current membership state.',
  IMMUTABLE_ENTITLEMENT:
    'Batch entitlement history cannot be rewritten. Revoke the seat and grant a new one instead.',
  FORBIDDEN: 'You do not have permission to do that.',
  REQUEST_NOT_FOUND: 'That enrollment request no longer exists — refresh the list.',
  COURSE_ACCESS_DENIED: "This course isn't part of your plan.",
  LESSON_NOT_RELEASED: "This lesson hasn't been released to your batch yet.",
  COMMUNITY_ACCESS_DENIED: "You don't have access to this community space.",
  COMMENT_PERMISSION_DENIED: 'Replies are turned off here.',
  ASSIGNMENT_CLOSED: 'This assignment is closed for submissions.',
  SUBMISSION_LOCKED: 'This submission has been handed in and can no longer be edited.',
  COURSE_HAS_SUBMISSIONS:
    'This course has graded assignment work and cannot be deleted. Unpublish it instead.',
  MIGRATION_MISSING:
    'This feature needs a database migration that has not been run yet. No changes were made.',
};

/**
 * Extract the stable code from a supabase-js error.
 * Resolution order is deliberate: the explicit contract first, the structured
 * fallback second, the well-known PostgREST code third, and legacy free text
 * last — so a correctly-raised error never depends on regex matching.
 *
 * @returns {string|null}
 */
export function appErrorCode(error) {
  if (!error) return null;

  // 1) The contract: hint carries the code. Validated for shape AND membership so
  //    a stray PostgREST hint ("Perhaps you meant the function public.foo") can
  //    never be treated as one of ours.
  const hint = typeof error.hint === 'string' ? error.hint.trim() : '';
  if (hint && CODE_SHAPE.test(hint) && CODE_SET.has(hint)) return hint;

  // 2) Structured detail — survives if a proxy strips `hint`.
  const details = typeof error.details === 'string' ? error.details : '';
  if (details) {
    try {
      const parsed = JSON.parse(details);
      const c = parsed && typeof parsed.code === 'string' ? parsed.code.trim() : '';
      if (c && CODE_SHAPE.test(c) && CODE_SET.has(c)) return c;
    } catch { /* not our JSON envelope — fall through */ }
  }

  // 3) The RPC is not in PostgREST's schema cache: the migration has not run.
  if (error.code === 'PGRST202') return 'MIGRATION_MISSING';
  const msg = typeof error.message === 'string' ? error.message : '';
  if (/could not find the function|schema cache/i.test(msg)) return 'MIGRATION_MISSING';

  // 4) Pre-#35 free-text raises.
  for (const [re, code] of LEGACY_PATTERNS) {
    if (re.test(msg)) return code;
  }
  return null;
}

/**
 * The structured context an RPC attached (batch_code, used, capacity, …).
 * Always an object, so callers can destructure without guarding.
 */
export function appErrorContext(error) {
  if (!error || typeof error.details !== 'string') return {};
  try {
    const parsed = JSON.parse(error.details);
    const ctx = parsed && parsed.context;
    return ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  } catch {
    return {};
  }
}

/** True when the failure means "run the migration", so callers can say so plainly. */
export function isMigrationMissing(error) {
  return appErrorCode(error) === 'MIGRATION_MISSING';
}

/**
 * The sentence to show a user.
 *
 * Order: our copy for a known code → the database's own message (already written
 * for a human by app_error) → the caller's fallback → a last-resort generic.
 * An unknown code still yields the DB message rather than a shrug, which is what
 * makes it safe to add a code in SQL before the client knows about it.
 */
export function appErrorMessage(error, fallback) {
  if (!error) return fallback || 'Something went wrong.';
  const code = appErrorCode(error);
  if (code && COPY[code]) return COPY[code];

  const msg = typeof error.message === 'string' ? error.message.trim() : '';
  // Strip the "function_name: " prefix Postgres raises carry — useful in logs,
  // noise in a dialog.
  const cleaned = msg.replace(/^[a-z_]+(?:\([^)]*\))?:\s*/i, '').trim();
  if (cleaned) return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  return fallback || 'Something went wrong.';
}

/** The copy table, exported so tests can assert every code has a message. */
export const APP_ERROR_COPY = COPY;
