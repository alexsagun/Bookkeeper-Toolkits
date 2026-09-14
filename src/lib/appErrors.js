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
 * The catalog. Kept in lockstep BY HAND with public.app_error_catalog() in
 * db/2026-07-30-batch-entitlements.sql. test/appErrors.test.mjs asserts every
 * code here has user-facing copy and matches the wire shape, but nothing yet
 * diffs this list against the function's rows — so a code added on one side
 * only is currently caught by review, not by a test. Adding that check is the
 * obvious next test when the DB suite next has a target.
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
  // ── Batch lifecycle (#38) ──
  'BATCH_PAST',
  'BATCH_CODE_TAKEN',
  'BATCH_CODE_REORDER',
  'BATCH_PERIOD_PAST',
  'BATCH_PERIOD_INVALID',
  'BATCH_TIMEZONE_INVALID',
  'BATCH_CAPACITY_BELOW_OCCUPANCY',
  // ── Community channels (#40) ──
  'CHANNEL_NOT_FOUND',
  'CHANNEL_SLUG_TAKEN',
  'CHANNEL_AUDIENCE_EMPTY',
  'CHANNEL_ARCHIVED',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_NOT_EMPTY',
  // ── Course video, upload-only (#44) ──
  'LESSON_VIDEO_UPLOAD_ONLY',
  'LESSON_VIDEO_PATH_INVALID',
  'COURSE_PUBLISH_BLOCKED',
  // ── Staff authorization (#45) ──
  'STAFF_LAST_SUPER_ADMIN',
  'STAFF_NOT_FOUND',
  'STAFF_ROLE_INVALID',
  // ── Trainer course ownership (#46) ──
  'COURSE_NOT_ASSIGNED',
  'COURSE_PUBLISH_FORBIDDEN',
  'COURSE_ASSIGNMENT_INVALID',
  // ── Discretionary access changes (#47) ──
  'SUBSCRIPTION_NOT_FOUND',
  'EXTENSION_NOT_ALLOWED',
  'EXTENSION_INVALID',
  // ── Staff invitation acceptance (#49) ──
  'STAFF_NO_INVITATION',
  'STAFF_INVITATION_NOT_PENDING',
  'STAFF_EMAIL_NOT_VERIFIED',
  // ── Staff activation consistency (#50) ──
  'STAFF_ACCOUNT_REJECTED',
  'ACCESS_REQUEST_SELF_REVIEW',
  // ── Access-request staff target (#51) ──
  'ACCESS_REQUEST_STAFF_TARGET',
  // ── #56 community moderation ──
  'MODERATION_TARGET_NOT_FOUND',
  'MODERATION_ACTION_INVALID',
  'MODERATION_STATE_INVALID',
  // ── Financial management (#58) ──
  'FINANCE_ENTRY_UNBALANCED',
  'FINANCE_ENTRY_IMMUTABLE',
  'FINANCE_ENTRY_ALREADY_REVERSED',
  'FINANCE_ENTRY_NOT_FOUND',
  'FINANCE_ENTRY_FUTURE_DATED',
  'FINANCE_ENTRY_KIND_INVALID',
  'FINANCE_PERIOD_LOCKED',
  'FINANCE_PERIOD_NOT_ELAPSED',
  'FINANCE_PERIOD_INVALID',
  'FINANCE_PERIOD_REASON_REQUIRED',
  'FINANCE_REVERSAL_REASON_REQUIRED',
  'FINANCE_ACCOUNTS_NOT_CONFIGURED',
  'FINANCE_ACCOUNT_NOT_FOUND',
  'FINANCE_SYSTEM_ACCOUNT',
  'FINANCE_EVENT_AMOUNT_MISMATCH',
  'FINANCE_AUDIT_IMMUTABLE',
  'FINANCE_IDEMPOTENCY_REQUIRED',
  'FINANCE_TIMEZONE_INVALID',
  'FINANCE_BANK_TXN_IMMUTABLE',
  'FINANCE_BANK_IMPORT_DUPLICATE',
  'FINANCE_RECONCILIATION_CLOSED',
  'FINANCE_RECONCILIATION_UNBALANCED',
  'FINANCE_COLLECTION_RACE',
  'FINANCE_BANK_IMPORT_STATE',
  'FINANCE_BANK_TXN_NOT_FOUND',
  'FINANCE_BANK_EXCLUDE_REASON_REQUIRED',
  'FINANCE_ACCOUNT_IN_USE',
  'FINANCE_RECURRING_INVALID',
  // Finance parity (#59)
  'FINANCE_RECLASSIFY_INVALID',
  'FINANCE_PRESET_INVALID',
  'FINANCE_BANK_TXN_LINKED',
  'FINANCE_BANK_TXN_NOT_LINKED',
  'FINANCE_BANK_MATCH_MISMATCH',
  'FINANCE_BANK_CATEGORY_INVALID',
  'FINANCE_ENTRY_HAS_ADJUSTMENTS',
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
    'This grant would mix cohort segments in one run. Revoke the current run first, then grant the new plan.',
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
  BATCH_PAST: 'This batch’s period has ended, so its details are locked. You can still archive it.',
  BATCH_CODE_TAKEN: 'Another batch already uses that month code.',
  BATCH_CODE_REORDER:
    'That code would move the batch past another one, which reorders members’ cohort runs. '
    + 'Pick a code that keeps the batch in the same position.',
  BATCH_PERIOD_PAST:
    'That period has already ended. A batch cannot be edited into the past.',
  BATCH_PERIOD_INVALID: 'Check the start and end dates — a batch needs both, and it must end after it starts.',
  BATCH_TIMEZONE_INVALID: 'That is not a timezone the server recognises. Pick one from the list.',
  BATCH_CAPACITY_BELOW_OCCUPANCY:
    'That capacity is below the seats already sold in this batch. Raise it, or move members first.',
  // A channel the caller cannot see reports exactly like one that does not
  // exist — saying "you lack access" would confirm a private room is there.
  CHANNEL_NOT_FOUND: 'That channel is not available.',
  CHANNEL_SLUG_TAKEN:
    'Another channel in this space already uses that address. Pick a different name.',
  CHANNEL_AUDIENCE_EMPTY:
    'Choose at least one plan or batch — as set up, nobody could see this channel.',
  CHANNEL_ARCHIVED: 'This channel is archived, so it is read-only.',
  CATEGORY_NOT_FOUND: 'That category is not available.',
  CATEGORY_NOT_EMPTY:
    'This category still holds active channels. Move or archive them first.',
  // Written for the admin who hits it in the lesson editor, so each one names
  // the single next action rather than restating the rule.
  LESSON_VIDEO_UPLOAD_ONLY:
    'Lesson videos must be uploaded, not linked. Upload the MP4 file — YouTube, Vimeo '
    + 'and direct video links are no longer accepted as a lesson’s main content.',
  LESSON_VIDEO_PATH_INVALID:
    'That video file is not stored where lesson videos live. Upload it again from the '
    + 'lesson editor.',
  COURSE_PUBLISH_BLOCKED:
    'Some video lessons still have no uploaded file. Open each one flagged below, upload '
    + 'its video, then publish.',
  // Staff authorization (#45). The first one is the only refusal in this product
  // that tells an administrator to do something ELSE first, so it names it.
  STAFF_LAST_SUPER_ADMIN:
    'This is the last active Super Admin. Promote another Super Admin first — otherwise '
    + 'nobody can manage staff, courses or settings.',
  STAFF_NOT_FOUND:
    'That account is not a staff member. Invite them from Team & Roles first.',
  STAFF_ROLE_INVALID:
    'That role, status or reason is not valid. Suspending or revoking access needs a reason.',
  // Trainer course ownership (#46). Each names the person who can unblock it,
  // because every one of these is a refusal the reader cannot lift themselves.
  COURSE_NOT_ASSIGNED:
    'You can edit courses, but this one isn’t assigned to you. Ask a Super Admin to add you '
    + 'to it from the course’s Trainers list.',
  COURSE_PUBLISH_FORBIDDEN:
    'Publishing and withdrawing courses is a separate permission from editing them. Your work '
    + 'is saved — ask a Super Admin to publish the course when it’s ready.',
  COURSE_ASSIGNMENT_INVALID:
    'That assignment can’t be made. The account needs a role that includes editing courses '
    + 'before a course can be assigned to it.',
  // Discretionary extensions (#47).
  SUBSCRIPTION_NOT_FOUND:
    'This member has no subscription yet, so there is no expiry to extend. Approve their '
    + 'enrollment first.',
  EXTENSION_NOT_ALLOWED:
    'This membership never expires, so an extension could only ever shorten it. No change '
    + 'was made.',
  EXTENSION_INVALID:
    'That extension can’t be applied. It must move the expiry forward, be between 1 and 365 '
    + 'days, and carry a reason.',
  // Staff invitation acceptance (#49). Each is read by the INVITEE, mid-signup, on
  // a screen with no navigation — so each one has to name the next move itself.
  STAFF_NO_INVITATION:
    'There’s no staff invitation on this account. If you were expecting one, ask the person '
    + 'who invited you to send it again — invitation links are tied to one email address.',
  STAFF_INVITATION_NOT_PENDING:
    'This staff access isn’t active any more, and an old invitation link can’t restore it. '
    + 'Ask a Super Admin to reinstate your role.',
  STAFF_EMAIL_NOT_VERIFIED:
    'Confirm your email address first — open the confirmation link we sent you, then accept '
    + 'the invitation again.',
  // Staff activation consistency (#50).
  STAFF_ACCOUNT_REJECTED:
    'This account has been blocked from the platform, so a staff invitation can’t be accepted '
    + 'on it. Ask a Super Admin to lift the block first, then open the invitation again.',
  ACCESS_REQUEST_SELF_REVIEW:
    'You can’t decide on your own access request. Ask a Super Admin to review it — and if you '
    + 'are staff, you don’t need this approval at all.',
  ACCESS_REQUEST_STAFF_TARGET:
    'That account is a staff member, not a student waiting for approval. To take their access '
    + 'away, suspend or revoke their role in Team & Roles — that’s the action that gets recorded.',
  MODERATION_TARGET_NOT_FOUND:
    'That post or reply isn’t available in a channel you moderate. Refresh the channel and try '
    + 'again — it may have been deleted, or moved somewhere you can’t reach.',
  MODERATION_ACTION_INVALID:
    'That moderation action isn’t recognised. Reload the page — the app and the server are out '
    + 'of step.',
  MODERATION_STATE_INVALID:
    'The author withdrew this themselves, so a moderator can’t restore it. Only they can post it '
    + 'again.',
  // Financial management (#58). Read by the one person who can act on them, so
  // each names the next move rather than restating the rule.
  FINANCE_ENTRY_UNBALANCED:
    'That entry doesn’t balance — every posting needs at least two lines, and the debits must equal '
    + 'the credits. Nothing was saved.',
  FINANCE_ENTRY_IMMUTABLE:
    'Posted entries can’t be edited or deleted — that’s what makes the ledger trustworthy. Reverse '
    + 'it instead and post a correction; both stay on the record.',
  FINANCE_ENTRY_ALREADY_REVERSED:
    'This entry has already been reversed. If the correction itself is wrong, reverse the reversal.',
  FINANCE_ENTRY_NOT_FOUND: 'That journal entry no longer exists — refresh the ledger.',
  FINANCE_ENTRY_FUTURE_DATED:
    'An entry can’t be dated in the future. If this is a cost that repeats, set it up as a recurring '
    + 'template — it will be offered to you when it falls due.',
  FINANCE_ENTRY_KIND_INVALID: 'That entry type isn’t valid for this action.',
  FINANCE_PERIOD_LOCKED:
    'That month is closed, so its figures can’t move. Post the correction in an open period — the '
    + 'ledger will tell you which one it lands in.',
  FINANCE_PERIOD_NOT_ELAPSED:
    'That month hasn’t finished yet. Only a completed month can be closed.',
  FINANCE_PERIOD_INVALID: 'Periods look like 2026-09, and that one isn’t currently locked.',
  FINANCE_PERIOD_REASON_REQUIRED:
    'Reopening a closed month needs a reason — it’s the only record of why the books were changed '
    + 'after they were closed.',
  FINANCE_REVERSAL_REASON_REQUIRED:
    'A reversal needs a reason. Six months from now it’s the only explanation of why this was undone.',
  FINANCE_ACCOUNTS_NOT_CONFIGURED:
    'Finance isn’t set up yet: the default income or cash account is missing or switched off. Set '
    + 'them in Financial Management → Settings before approving any more payments.',
  FINANCE_ACCOUNT_NOT_FOUND: 'That account no longer exists — refresh the chart of accounts.',
  FINANCE_SYSTEM_ACCOUNT:
    'That’s a built-in account the ledger depends on, so it can’t be switched off or retyped. You '
    + 'can rename it.',
  FINANCE_EVENT_AMOUNT_MISMATCH:
    'The payment amount doesn’t match its journal entry, so nothing was saved. This is a bug — '
    + 'please report it rather than retrying.',
  FINANCE_AUDIT_IMMUTABLE: 'The finance audit trail is append-only; entries in it can never be changed.',
  FINANCE_IDEMPOTENCY_REQUIRED:
    'Reload the page and try again — the app didn’t send the safety key that stops a retry posting '
    + 'the same amount twice.',
  FINANCE_TIMEZONE_INVALID: 'That isn’t a timezone the server recognises. Pick one from the list.',
  FINANCE_BANK_TXN_IMMUTABLE:
    'The date, amount and description come from the statement and can’t be edited. If the row '
    + 'shouldn’t count, exclude it and say why.',
  FINANCE_BANK_IMPORT_DUPLICATE:
    'That exact statement file has already been imported into this account. Importing it again '
    + 'would double every transaction in it.',
  FINANCE_RECONCILIATION_CLOSED:
    'That reconciliation is closed and its items are frozen. Reopen it with a reason first.',
  FINANCE_RECONCILIATION_UNBALANCED:
    'This doesn’t reconcile yet — the difference isn’t zero. Match or exclude the remaining '
    + 'transactions, then close it.',
  FINANCE_COLLECTION_RACE:
    'Another request recorded this payment a moment ago, so nothing was duplicated. Refresh and '
    + 'check the enrollment before approving again.',
  FINANCE_BANK_IMPORT_STATE:
    'That import isn’t at a stage where this is possible — it may already be committed or '
    + 'discarded. Refresh the imports list to see where it actually stands.',
  FINANCE_BANK_TXN_NOT_FOUND:
    'That transaction is no longer there — refresh the statement and try again.',
  FINANCE_BANK_EXCLUDE_REASON_REQUIRED:
    'Say why this transaction is excluded. Without a reason it’s indistinguishable from one that '
    + 'simply went missing, which is exactly what you’ll be trying to work out when the account '
    + 'fails to reconcile.',
  FINANCE_ACCOUNT_IN_USE:
    'That account is in use — it’s a default in Settings or the income account for a plan — so '
    + 'switching it off would stop payments being recorded. Point those at another account first.',
  FINANCE_RECURRING_INVALID:
    'That recurring template isn’t complete. It needs a name, two different active accounts, an '
    + 'amount above zero, and a schedule that matches its frequency.',
  FINANCE_RECLASSIFY_INVALID:
    'That can’t be reclassified. Income moves to another income account, and an expense to another '
    + 'expense or to owner’s draw — into an active account, on an entry that hasn’t been reversed, '
    + 'with a reason.',
  FINANCE_PRESET_INVALID:
    'That preset isn’t valid: it needs a name no other preset uses, and an active expense or '
    + 'owner’s draw account.',
  FINANCE_BANK_TXN_LINKED:
    'That statement line — or the entry you picked — is already added, matched, excluded or '
    + 'reconciled. Refresh the feed to see where it stands.',
  FINANCE_BANK_TXN_NOT_LINKED:
    'That statement line isn’t added or matched, so there’s nothing to undo.',
  FINANCE_BANK_MATCH_MISMATCH:
    'That entry doesn’t move this account by the same amount as the statement line, so they can’t '
    + 'be matched. Pick another entry, or add the line instead.',
  FINANCE_BANK_CATEGORY_INVALID:
    'Choose an active account other than the statement’s own account.',
  FINANCE_ENTRY_HAS_ADJUSTMENTS:
    'That entry was reclassified, and the reclassification still stands. Reverse the '
    + 'reclassification first, then this entry — otherwise money would be moved out of an account '
    + 'the reversal has just emptied.',
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
