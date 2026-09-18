// ─────────────────────────────────────────────────────────────────────────────
// Toolkits Siri — the voice assistant's identity, eligibility and speech rules.
//
// PURE. No React, no `node:*`, no `Date`, no `toLocaleString`, no `fetch`. Every
// function here is a decision or a formatter over facts a caller has already
// gathered, which is what lets the SAME rule run in three places that cannot
// share anything else:
//
//   - the browser (src/BookkeeperPro.jsx — the render gate and the client tools),
//   - the server (api/elevenlabs/signed-url.js — the real authorization boundary),
//   - the build (scripts/generate-voice-agent-knowledge.mjs — the knowledge doc's
//     "who may open what" section),
//
// and to be pinned by node:test, which has no infrastructure for `api/` handlers
// or JSX in this repo. The precedent is api/_lib/staffAuth.js ↔ src/lib/staffRoles.js:
// the I/O shell fetches, this decides.
//
// ★ THE DATABASE IS THE BOUNDARY, NOT THIS FILE. `voiceSessionVerdict` is the one
//   function here that gates anything real, and even it only decides whether to
//   MINT a session — every course byte the assistant can reach is re-authorized
//   fail-closed by api/elevenlabs/trainer.js against trainer_visible_courses(),
//   and every screen it can navigate to is re-checked by RLS. Everything else in
//   this module hides or explains a control, which is a courtesy, not a gate.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ADMIN_TAB_PERMISSION,
  ROLE_PERMISSIONS,
  staffBypassesPaywall,
  staffCan,
  staffRole,
} from './staffRoles.js';

/**
 * THE canonical product name. One constant, because it is written into the UI,
 * the generated knowledge document, the ElevenLabs system prompt, the
 * provisioner's sentinel check and five test files — five places that must agree
 * and have no other way to.
 *
 * Not affiliated with, endorsed by, or connected to Apple Inc. The assistant must
 * never use Apple branding or imply otherwise.
 */
export const VOICE_ASSISTANT_NAME = 'Toolkits Siri — AI Voice Guide & Course Trainer';

/**
 * The short form: the panel header, the FAB label, and the sentinel
 * scripts/provision-voice-agent.mjs greps for in the system prompt before it will
 * publish one. It MUST be a substring of VOICE_ASSISTANT_NAME — a test pins that,
 * so the sentinel can never drift away from the name it is meant to guard.
 */
export const VOICE_ASSISTANT_SHORT_NAME = 'Toolkits Siri';

/**
 * The four values `user_role` may take.
 *
 * ★ THIS IS CONVERSATIONAL CONTEXT, NEVER AN AUTHORIZATION CLAIM. It rides an
 *   ElevenLabs dynamic variable, i.e. it is shaped by the browser and read by an
 *   LLM. It exists so the agent can say "you're an Operations Admin, so Financial
 *   Management isn't yours" instead of guessing. Nothing may be granted on it.
 */
export const VOICE_ROLES = Object.freeze(['member', 'super_admin', 'operations_admin', 'trainer']);

/**
 * What the user is told BEFORE the microphone opens.
 *
 * Three separate promises, in an array, so test/uiSafety.test.mjs can pin each
 * one individually — the ENROLLMENT_PROCESSING_NOTE precedent, which exists
 * because a reworded block silently dropped one of four promises and nothing
 * noticed. A single paragraph cannot be checked that way.
 */
export const VOICE_PRIVACY_NOTICE = Object.freeze([
  'Your microphone stays on while the session is running.',
  'What you say and type is processed by ElevenLabs, an external AI provider.',
  'Please don’t say passwords, card numbers, or a client’s financial details.',
]);

/** A verdict `decision` from voiceSessionVerdict. */
export const VOICE_SESSION = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  UNAVAILABLE: 'unavailable',
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of VOICE_ROLES this viewer is. Never null, never throws.
 *
 * Order mirrors adminTabVisible() in staffRoles.js, deliberately:
 *   degraded  → the legacy profiles.is_admin cache, which since #45 means exactly
 *               "has an active super_admin membership";
 *   !ready    → 'member', because absent permission data means no, not yes;
 *   then the role key itself.
 *
 * An unknown role key from a future migration resolves to 'member' rather than
 * being echoed to the LLM verbatim — the agent's prompt only knows these four.
 */
export function voiceRole({ staff, staffReady = false, staffDegraded = false, profileIsAdmin = false } = {}) {
  if (staffDegraded) return profileIsAdmin ? 'super_admin' : 'member';
  if (!staffReady) return profileIsAdmin ? 'super_admin' : 'member';
  if (staffBypassesPaywall(staff) && VOICE_ROLES.includes(staff.roleKey)) return staff.roleKey;
  return profileIsAdmin ? 'super_admin' : 'member';
}

/** Human label for a voice role. 'member' has no staff_roles row, so it is named here. */
export function voiceRoleLabel(role) {
  if (role === 'member' || !role) return 'Member';
  return staffRole(role)?.label || 'Member';
}

/**
 * A speakable first name, or a neutral word. NEVER an email address.
 *
 * ★ `email` IS ACCEPTED AND DELIBERATELY IGNORED. The bug this replaces was
 *   `full_name || user?.email || 'there'` in the startSession dynamic variables:
 *   any account with a blank full_name had its address spoken into an external
 *   LLM's context on every call. Taking the parameter and dropping it is what
 *   makes `voiceDisplayName({ email }) === 'there'` a meaningful test rather than
 *   a test of a signature nobody passes.
 *
 * Also drops honorifics, so "Dr. Maria Jose Cruz" introduces herself as "Maria",
 * and refuses a full_name that is itself an address (people do paste them there).
 */
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'sir', 'madam', 'engr', 'atty', 'rev']);

export function voiceDisplayName({ fullName } = {}) {
  const raw = typeof fullName === 'string' ? fullName.trim() : '';
  if (!raw || raw.includes('@')) return 'there';

  const tokens = raw.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const cleaned = token.replace(/[^\p{L}\p{N}'’-]/gu, '');
    if (!cleaned) continue;
    if (HONORIFICS.has(cleaned.toLowerCase())) continue;
    const name = cleaned.slice(0, 40);
    // Belt and braces: the '@' strip above already makes this unreachable, but a
    // name is the one field that reaches a third party, so the guard is explicit.
    return name.includes('@') ? 'there' : name;
  }
  return 'there';
}

// ─────────────────────────────────────────────────────────────────────────────
// What a role may open
// ─────────────────────────────────────────────────────────────────────────────

/** ADMIN_TAB_PERMISSION's key order, frozen so the doc and the UI list screens alike. */
const ADMIN_TAB_ORDER = Object.freeze(Object.keys(ADMIN_TAB_PERMISSION));

/**
 * The admin tab ids a role may open, in a stable order. DERIVED — there is no
 * second table to keep in step with ROLE_PERMISSIONS.
 *
 * Accepts either a role key (the generic, per-role answer the knowledge document
 * needs) or a live staff context (the answer THIS caller's server-issued
 * permission list gives, which is the one get_user_membership_summary must use —
 * normalizeStaffContext honours a staff_role_permissions row an operator added in
 * SQL, and this file's matrix is only its fallback).
 *
 * ★ A Super Admin gets every key, matching adminTabVisible()'s isSuperAdmin arm
 *   rather than filtering on the permission. That arm exists because a permission
 *   a not-yet-applied migration will create is absent even for the one role that
 *   will hold it — which is how Financial Management hid itself from the Super
 *   Admin it was built for on 2026-09-14.
 */
export function adminScreensForRole(roleOrContext) {
  if (roleOrContext && typeof roleOrContext === 'object') {
    const ctx = roleOrContext;
    if (!staffBypassesPaywall(ctx)) return [];
    if (ctx.isSuperAdmin) return [...ADMIN_TAB_ORDER];
    return ADMIN_TAB_ORDER.filter((tab) => staffCan(ctx, ADMIN_TAB_PERMISSION[tab]));
  }
  const key = typeof roleOrContext === 'string' ? roleOrContext : null;
  if (!key || key === 'member') return [];
  if (key === 'super_admin') return [...ADMIN_TAB_ORDER];
  const held = ROLE_PERMISSIONS[key];
  if (!Array.isArray(held)) return [];
  return ADMIN_TAB_ORDER.filter((tab) => held.includes(ADMIN_TAB_PERMISSION[tab]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility — the RENDER gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this viewer see the microphone button at all?
 *
 * A RENDER decision only — api/elevenlabs/signed-url.js re-asks the database and
 * is the real boundary (voiceSessionVerdict below). Showing a button that would
 * be refused is a UX bug; hiding one that would be allowed is the bug this ships
 * to fix.
 *
 * ★ THE STAFF ARM MUST COME FIRST AND MUST NOT CONSULT enrollState.
 *   useEnrollmentGate sets `active = false` when staffBypassesPaywall(staff) is
 *   true, so `enrollState` is computed from a null profile.is_paid and resolves
 *   to 'paywall' for EVERY Operations Admin and Trainer. The previous gate was
 *   `profile?.is_admin || !REQUIRE_ENROLLMENT || enroll.state === 'pass'`, and
 *   that is precisely why active staff never saw the assistant.
 *
 * ★ A rejected account is refused ahead of everything, including staff. A ban
 *   cannot be worked around, and accept_staff_invitation() refuses a rejected
 *   profile server-side for the same reason (STAFF_ACCOUNT_REJECTED).
 *
 * Returns `{ allow, code, role }`; `code` names the reason either way so a future
 * caller can explain itself without re-deriving the decision.
 */
export function voiceEligibility({
  hasSession = false,
  requireEnrollment = true,
  enrollConfigured = true,
  enrollReady = false,
  enrollState = null,
  profileIsAdmin = false,
  approvalStatus = null,
  staff = null,
  staffReady = false,
  staffDegraded = false,
} = {}) {
  const role = voiceRole({ staff, staffReady, staffDegraded, profileIsAdmin });
  const deny = (code) => ({ allow: false, code, role });
  const allow = (code) => ({ allow: true, code, role });

  if (!hasSession) return deny('signed_out');
  if (approvalStatus === 'rejected') return deny('account_rejected');

  // Staff, first and on their own terms.
  if (staffDegraded) {
    if (profileIsAdmin) return allow('staff_legacy_cache');
  } else if (staffReady && staffBypassesPaywall(staff)) {
    return allow('staff');
  }

  // profiles.is_admin means "active super_admin" since #45, and it lands before
  // my_staff_context() does. Honouring it here is the same courtesy
  // adminTabVisible() extends, not a second authority.
  if (profileIsAdmin) return allow('super_admin_cache');

  if (!requireEnrollment) return allow('enrollment_disabled');
  // Pre-migration database: the entitlement memo fails open here too, and the
  // server still re-checks. Refusing would hide the assistant on a fresh install.
  if (!enrollConfigured) return allow('enrollment_not_configured');

  if (!enrollReady) return deny('membership_loading');
  if (enrollState === 'pass') return allow('member');
  return deny('no_active_membership');
}

// ─────────────────────────────────────────────────────────────────────────────
// The server boundary
// ─────────────────────────────────────────────────────────────────────────────

const INDETERMINATE = 'indeterminate';

/**
 * May api/elevenlabs/signed-url.js mint a paid ElevenLabs session for this caller?
 *
 * `enrolled` is is_enrolled()'s answer: `true` / `false` / `null` when the check
 * could not be run. `staff` is a staffContextFromRpc() result —
 * `{ context, degraded, missing }` — for my_staff_context() asked with the
 * CALLER's own JWT (it is auth.uid()-scoped, so it cannot be asked about anyone
 * else, and it is already granted to `authenticated`).
 *
 * ★ THIS ENDPOINT NOW FAILS CLOSED, REVERSING ITS ORIGINAL DESIGN. It used to
 *   treat an indeterminate is_enrolled() as a pass ("the valid JWT is the gate"),
 *   matching api/anthropic/v1/messages.js. That was defensible when the worst
 *   case was some spent tokens, but it means any signed-in account — including a
 *   lapsed member — can open a metered voice session whenever Supabase is slow.
 *   The trade is stated plainly: a Supabase outage now takes the widget down
 *   rather than opening it to everyone. The caller mitigates with one retry and a
 *   short timeout, and answers 503 + Retry-After rather than a generic error, so
 *   the user and the logs are told the same story.
 *
 * ★ `missing` IS A DEFINITE NEGATIVE, NOT INDETERMINATE. A pre-#45 database has
 *   no staff model at all, and is_enrolled() already returns true for admins
 *   there — so treating "the function does not exist" as indeterminate would 503
 *   an entire class of legitimately-denied callers forever. This mirrors
 *   staffAuthVerdict()'s "only a MISSING function earns a second look": same
 *   distinction, opposite direction, same reason.
 *
 * ★ THERE IS NO POSITIVE CACHE, and there must never be one. A cached grant is
 *   stale authority, and reading my_staff_context() live on every request is
 *   exactly what makes a suspension take effect on the next request instead of
 *   the next token refresh.
 *
 * Staff pass without a subscription BY DESIGN — that is staffBypassesPaywall(),
 * already wired into useEnrollmentGate. Do NOT broaden is_enrolled() in SQL to
 * cover them: it guards paid-student resources far beyond this endpoint.
 */
export function voiceSessionVerdict({ enrolled = null, staff = null } = {}) {
  const enrolledAnswer = enrolled === true ? 'yes' : enrolled === false ? 'no' : INDETERMINATE;

  let staffAnswer = INDETERMINATE;
  let staffContext = null;
  if (staff && typeof staff === 'object') {
    if (staff.missing) staffAnswer = 'not_staff';
    else if (staff.degraded) staffAnswer = INDETERMINATE;
    else if (staffBypassesPaywall(staff.context)) {
      staffAnswer = 'staff';
      staffContext = staff.context;
    } else staffAnswer = 'not_staff';
  }

  const indeterminate = Object.freeze([
    ...(enrolledAnswer === INDETERMINATE ? ['is_enrolled'] : []),
    ...(staffAnswer === INDETERMINATE ? ['my_staff_context'] : []),
  ]);

  if (staffAnswer === 'staff') {
    return {
      decision: VOICE_SESSION.ALLOW,
      status: 200,
      grant: 'staff',
      role: voiceRole({ staff: staffContext, staffReady: true }),
      indeterminate,
      code: null,
      retryAfterSecs: null,
    };
  }

  if (enrolledAnswer === 'yes') {
    return {
      decision: VOICE_SESSION.ALLOW,
      status: 200,
      grant: 'member',
      role: 'member',
      indeterminate,
      code: null,
      retryAfterSecs: null,
    };
  }

  if (enrolledAnswer === 'no' && staffAnswer === 'not_staff') {
    return {
      decision: VOICE_SESSION.DENY,
      status: 403,
      grant: null,
      role: 'member',
      indeterminate,
      code: 'VOICE_FORBIDDEN',
      retryAfterSecs: null,
    };
  }

  return {
    decision: VOICE_SESSION.UNAVAILABLE,
    status: 503,
    grant: null,
    role: 'member',
    indeterminate,
    code: 'VOICE_CHECK_UNAVAILABLE',
    retryAfterSecs: 15,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the assistant may do and say
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide a navigation BEFORE performing it.
 *
 * ★ THE TWO REFUSALS ARE NOT THE SAME REFUSAL, and the difference is a product
 *   decision, not an oversight:
 *
 *   - A STAFF SCREEN the account may not open is refused outright, and the
 *     refusal precedes the route change. `adminAllowed` must come from
 *     adminTabVisible() (the root already memoizes it as `adminTabAllowed`), not
 *     from profiles.is_admin — testing is_admin makes every admin screen Super
 *     Admin-only by voice, which is wrong for an Operations Admin who owns the
 *     Enrollments queue.
 *
 *   - A PLAN-LOCKED tool still navigates, on purpose. RestrictedTab's upgrade
 *     offer is the chokepoint the whole component exists to serve, and CLAUDE.md
 *     records this: "navigates even into a plan-restricted tab — RestrictedTab's
 *     upsell is the chokepoint — and tells the agent so". Refusing here would
 *     leave a Sampler who asked for Bank Feed AI with a "no" and no way to buy it.
 */
export function voiceNavigationVerdict({
  tabId = null,
  label = '',
  isAdminScreen = false,
  adminAllowed = false,
  planAllowsTab = true,
  planLabel = '',
  planScope = '',
} = {}) {
  if (!tabId) return { allow: false, lockNote: null, message: 'I could not work out which page you meant.' };

  const name = label || tabId;

  if (isAdminScreen && !adminAllowed) {
    return {
      allow: false,
      lockNote: null,
      message: `"${name}" is a staff screen, and this account does not have access to it.`,
    };
  }

  if (!planAllowsTab) {
    const plan = planLabel || 'their current plan';
    const scope = planScope ? ` — ${planScope}` : '';
    return {
      allow: true,
      lockNote: `Navigated to ${name}, but the member's plan (${plan}${scope}) does not include it, so an upgrade prompt is showing. You may offer to open the upgrade panel.`,
      message: null,
    };
  }

  return { allow: true, lockNote: null, message: null };
}

/**
 * The spoken answer to "what's my plan / what can I do here".
 *
 * ★ IT TAKES NO NAME AND NO EMAIL, BY CONSTRUCTION. The handler this replaces
 *   returned `Role: admin (${p.full_name || p.email || 'admin'})`, which put a
 *   real address into an external LLM's context for any admin without a
 *   full_name. There is no field here to leak — the fix is the absence of the
 *   parameter, not a filter on it.
 *
 * Every date, currency and day-count arrives PRE-FORMATTED, because this module
 * may not touch `Date` or `toLocaleString`: the monolith owns subAccess(),
 * membershipStatus(), fmtVoiceDate() and phpFmt() and passes their output in.
 *
 * Staff who ALSO hold a paid term get both halves, mirroring staffEntitlement()'s
 * union — bypassing the paywall is not the same fact as having bought the toolkit.
 */
export function voiceMembershipSummary({
  role = 'member',
  adminScreenLabels = [],
  hasBillingPanels = true,
  hasPlan = false,
  planLabel = '',
  planScope = '',
  statusLabel = '',
  legacy = false,
  inGrace = false,
  valid = false,
  expired = false,
  endDate = '',
  daysLeft = null,
  graceDaysLeft = null,
  planPrice = '',
  planAccessDays = null,
  pendingKind = null,
} = {}) {
  const parts = [];
  const isStaff = role !== 'member';

  if (isStaff) {
    const screens = Array.isArray(adminScreenLabels) ? adminScreenLabels.filter(Boolean) : [];
    parts.push(`Role: ${voiceRoleLabel(role)} (staff).`);
    parts.push(screens.length
      ? `Staff screens they can open: ${screens.join(', ')}.`
      : 'They hold no admin queues — their work is the course library and the community.');
    if (!hasBillingPanels) {
      parts.push('This is a staff account, so it has no subscription and no billing panels — never offer upgrade, extend or renew.');
    }
    if (!hasPlan) return parts.join(' ');
    parts.push('They also hold a paid membership:');
  } else {
    parts.push('Role: Member.');
  }

  parts.push(`Plan: ${planLabel || 'none yet'}${planScope ? ` — ${planScope}` : ''}.`);
  if (statusLabel) parts.push(`Status: ${statusLabel}.`);

  if (legacy && valid) {
    parts.push('Access has no expiry date (legacy membership).');
  } else if (inGrace) {
    parts.push(`The paid term has ended but access continues in a grace window until ${endDate}${graceDaysLeft != null ? ` (${graceDaysLeft} day(s) left)` : ''} — renewing now avoids losing access.`);
  } else if (valid && endDate) {
    parts.push(`Access ends ${endDate}${daysLeft != null ? ` (${daysLeft} day(s) left)` : ''}.`);
  } else if (expired) {
    parts.push('The membership term has expired — renewing restores access.');
  }

  if (planPrice && planAccessDays != null) {
    parts.push(`Plan price: ${planPrice} for ${planAccessDays} days of access.`);
  }

  if (pendingKind === 'overdue') {
    parts.push('Their last payment request missed the review window and should be resubmitted from the payment screen.');
  } else if (pendingKind === 'review') {
    parts.push('A payment request is currently pending admin review.');
  }

  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript
// ─────────────────────────────────────────────────────────────────────────────

/** How far back a server echo will look for the local copy it is replacing. */
const ECHO_WINDOW = 12;

/**
 * The comparison key for "is this the echo of what we just typed".
 *
 * Case, inner whitespace and EDGE punctuation are ignored, because the service
 * normalizes a typed turn on its way back ("open bank feed" returns as "Open bank
 * feed."). Inner punctuation is kept: collapsing that too would start matching
 * messages that are genuinely different, and the cost of a missed match is one
 * duplicated row while the cost of a false match is a lost message.
 */
const echoKey = (text) => String(text || '')
  .trim()
  .replace(/\s+/g, ' ')
  .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
  .toLowerCase();

/**
 * Append one transcript entry, collapsing the echo of a message we typed.
 *
 * ★ THE DUPLICATE IS REAL AND THE SDK DOES NOT CAUSE IT. `sendUserMessage(text)`
 *   only puts `{type:"user_message"}` on the socket; the ElevenLabs server then
 *   sends back a `user_transcription_event`, which BaseConversation turns into
 *   `onMessage({ source:'user' })`. The live agent's client_events include
 *   `user_transcript`, so every typed message arrives twice: once from our own
 *   optimistic append and once from the server.
 *
 * ★ IT IS NOT MERELY COSMETIC. transcriptLenRef anchors the course citation chips
 *   (show_lesson_sources records `atIndex`), so an extra row silently shifts a
 *   citation onto the wrong message.
 *
 * The dedupe key is FIFO over PENDING local entries, never "the most recent
 * match": a learner who answers "yes" twice must see two rows, and the first echo
 * belongs to the first "yes". An entry that already carries this `eventId` is
 * dropped outright, which makes the whole function idempotent under a replayed
 * event. The server's text wins on a match — it is the canonical transcript.
 */
export function appendVoiceTranscript(list, entry) {
  const current = Array.isArray(list) ? list : [];
  const text = entry && typeof entry.text === 'string' ? entry.text : '';
  if (!text) return current;

  const role = entry.role === 'user' ? 'user' : 'agent';
  const eventId = entry.eventId != null ? String(entry.eventId) : null;

  // A local optimistic append: no event id yet, and marked so the echo can find it.
  if (!eventId) return [...current, { role, text, eventId: null, pending: true }];

  if (current.some((m) => m.eventId && m.eventId === eventId)) return current;

  if (role === 'user') {
    const key = echoKey(text);
    const from = Math.max(0, current.length - ECHO_WINDOW);
    for (let i = from; i < current.length; i += 1) {
      const m = current[i];
      if (m.pending && m.role === 'user' && echoKey(m.text) === key) {
        const next = current.slice();
        next[i] = { role, text, eventId, pending: false };
        return next;
      }
    }
  }

  return [...current, { role, text, eventId, pending: false }];
}
