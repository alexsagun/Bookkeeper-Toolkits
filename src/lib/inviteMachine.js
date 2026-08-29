// ─────────────────────────────────────────────────────────────────────────────
// inviteMachine.js — the staff-invitation state machine. PURE (#50).
// ─────────────────────────────────────────────────────────────────────────────
// No imports, no DOM, no Supabase, so the same rules run in the browser and under
// `node --test`. There is no jsdom or RTL in this repo; extracting the DECISION is
// what makes the invitation flow testable at all.
//
// WHY THIS EXISTS — the "expired" bug, in full.
//
// #49 shipped `StaffInvitationSetup` with its step derived from ONE component-local
// boolean: `const step = invite && !exchanged ? 'confirm' : 'form'`. That is correct
// only while the component stays mounted, and it does not:
//
//   1. The invitee clicks Accept. supabase.auth.verifyOtp() consumes the one-time
//      token and a session with a NEW uid arrives.
//   2. AuthProvider's profileReady is `!session?.user || profileFetchedFor === uid`.
//      A new uid makes it FALSE.
//   3. resolveGateScreen()'s `if (!profileReady) return SPLASH` therefore fires, and
//      the gate swaps StaffInvitationSetup for AuthSplash. The component UNMOUNTS
//      and `exchanged` — the only record that the token had been spent — is gone.
//   4. The profile lands, the gate returns to STAFF_INVITATION, and a FRESH instance
//      renders with exchanged=false and `invite` still set. `step` is 'confirm'
//      again, so the Accept button is offered a second time.
//   5. The invitee clicks it. The token is already spent. GoTrue refuses, and the
//      screen says "This invitation link has expired or was already used."
//
// The same unmount explains the other reported symptom: reloading showed the
// password screen, because on reload the fragment has already been stripped, so
// `invite` is null and `step` falls through to 'form'. The token exchange really
// had succeeded — the UI had simply forgotten.
//
// ★ THE FIX IS NOT A BIGGER FLAG. It is that every input this machine reasons about
//   is either DURABLE (a server fact, re-fetchable after any unmount) or plainly
//   IN-FLIGHT (a promise is outstanding right now). Nothing in between. A full
//   unmount, a refresh, a crashed tab and a restored session all reconstruct the
//   same state from the same durable facts, because there is nothing else to lose.
//
// ★ AND THE RECOVERY RULE, STATED ONCE: while the signed-in user's OWN membership
//   is 'invited', this machine can never return EXPIRED. A dead token becomes
//   CREDENTIALS. That is safe precisely because `inviteState` comes from an
//   auth.uid()-scoped SECURITY DEFINER RPC — it describes the caller and nobody
//   else, so a spent token can never be re-attached to an unrelated account. A
//   stranger's session reports exists:false (NO_INVITATION) or 'active'
//   (ALREADY_ACTIVE); neither can borrow the invitation the link was minted for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every screen the invitation flow can be in. One state renders one screen — there
 * is no combination of flags that produces two, which is what "must never show
 * contradictory screens" means in practice.
 */
export const INVITE_STATES = Object.freeze({
  /** Durable facts have not arrived yet. */
  LOADING: 'loading',
  /** A token is in hand and has not been spent: the initial confirmation. */
  CONFIRM: 'confirm',
  /** verifyOtp() is outstanding. */
  EXCHANGING: 'exchanging',
  /** Signed in, invitation pending, and this account has NO password yet. */
  CREDENTIALS: 'credentials',
  /** Signed in, invitation pending, and a password already exists (a promotion). */
  PROFILE_ONLY: 'profile_only',
  /** accept_staff_invitation() is outstanding. */
  ACTIVATING: 'activating',
  /** Activated in this session — the branded welcome. */
  SUCCESS: 'success',
  /** Already active on arrival: re-clicking a link that was used days ago. */
  ALREADY_ACTIVE: 'already_active',
  /** suspended | revoked — an old link cannot restore either. */
  ENDED: 'ended',
  /** Signed in, no membership row at all. */
  NO_INVITATION: 'no_invitation',
  /** The mailbox has not been confirmed, so the server will refuse acceptance. */
  EMAIL_UNVERIFIED: 'email_unverified',
  /** Genuinely dead: the token is spent AND this session has no pending invitation. */
  EXPIRED: 'expired',
  /** The durable facts could not be loaded. Recoverable — offers a retry. */
  ERROR: 'error',
  /** No session and no usable token. */
  SIGNED_OUT: 'signed_out',
  /** "Not now" for a staff-only invitee: finish later, WITHOUT seeing a price. */
  DEFERRED: 'deferred',
});

/** States from which no further action is offered inside this flow. */
export const INVITE_TERMINAL_STATES = Object.freeze([
  INVITE_STATES.SUCCESS,
  INVITE_STATES.ALREADY_ACTIVE,
  INVITE_STATES.ENDED,
  INVITE_STATES.NO_INVITATION,
  INVITE_STATES.EXPIRED,
]);

/** The membership statuses staff_memberships.status may hold. */
const PENDING_STATUS = 'invited';
const ACTIVE_STATUS = 'active';
const ENDED_STATUSES = Object.freeze(['suspended', 'revoked']);

/**
 * Fail-closed shape for the durable server facts, used before the RPC answers and
 * whenever it fails. `exists:false` reads as "no invitation", never as "assume one".
 */
export const EMPTY_INVITATION_STATE = Object.freeze({
  exists: false,
  status: null,
  roleKey: null,
  roleLabel: null,
  displayTitle: null,
  invitedAt: null,
  emailConfirmed: false,
  hasPassword: false,
});

/**
 * Normalize the jsonb `staff_invitation_state()` returns into the durable shape.
 *
 * ★ `hasPassword` and `emailConfirmed` DEFAULT TO THE SAFE ANSWER, and the safe
 *   answer differs between them. An unknown `hasPassword` must be FALSE, because
 *   false means "ask for a password" — the failure mode is one extra field, not an
 *   account with no credentials. An unknown `emailConfirmed` must also be false,
 *   because the server refuses acceptance without it and saying otherwise would
 *   send the invitee into a request that cannot succeed.
 *
 * @param {{ data?: any, error?: any }|any} res  a supabase-js rpc() result, or the row
 * @returns {{ state: typeof EMPTY_INVITATION_STATE, missing: boolean, failed: boolean }}
 */
export function normalizeInvitationState(res) {
  const error = res && typeof res === 'object' && 'error' in res ? res.error : null;
  if (error) {
    const code = String(error.code || '');
    const message = String(error.message || '');
    const missing = code === 'PGRST202'
      || code === '42883'
      || /could not find the function|schema cache/i.test(message);
    return { state: EMPTY_INVITATION_STATE, missing, failed: true };
  }

  let row = res && typeof res === 'object' && 'data' in res ? res.data : res;
  if (Array.isArray(row)) row = row[0];
  if (!row || typeof row !== 'object') {
    return { state: EMPTY_INVITATION_STATE, missing: false, failed: false };
  }

  const exists = row.exists === true;
  if (!exists) return { state: EMPTY_INVITATION_STATE, missing: false, failed: false };

  const status = typeof row.status === 'string' ? row.status : null;
  return {
    state: Object.freeze({
      exists: true,
      status,
      roleKey: typeof row.role_key === 'string' ? row.role_key : null,
      roleLabel: typeof row.role_label === 'string' ? row.role_label : null,
      displayTitle: typeof row.display_title === 'string' ? row.display_title : null,
      invitedAt: typeof row.invited_at === 'string' ? row.invited_at : null,
      emailConfirmed: row.email_confirmed === true,
      hasPassword: row.has_password === true,
    }),
    missing: false,
    failed: false,
  };
}

/**
 * The transition table. Order is the specification — read it top to bottom.
 *
 * @param {object} input
 * @param {boolean} input.hasToken       a token was present in the URL fragment this session
 * @param {boolean} input.tokenSpent     that token has been redeemed OR refused; never offer it again
 * @param {'idle'|'exchanging'|'activating'} input.phase  a request is outstanding right now
 * @param {string|null} input.sessionUserId
 * @param {object|null} input.inviteState  durable server facts, or null while unknown
 * @param {boolean} input.activated      accept_staff_invitation() succeeded in THIS session
 * @param {boolean} input.deferred       the invitee chose "Not now" and may finish later
 * @param {string|null} input.errorCode
 * @returns {{ state: string, reason: string }}
 */
export function resolveInviteState(input) {
  const s = input || {};
  const {
    hasToken = false,
    tokenSpent = false,
    phase = 'idle',
    sessionUserId = null,
    inviteState = null,
    activated = false,
    deferred = false,
    errorCode = null,
  } = s;

  // ── In flight. A request that is outstanding outranks every conclusion drawn
  //    from facts fetched before it started. ──────────────────────────────────
  if (phase === 'activating') return { state: INVITE_STATES.ACTIVATING, reason: 'activating' };
  if (phase === 'exchanging') return { state: INVITE_STATES.EXCHANGING, reason: 'exchanging' };

  // ── No session. The token is the only thing that can create one. ────────────
  // Deliberately ABOVE the deferred check: deferring is only offered to a
  // signed-in invitee, and a "Resume setup" button shown after they signed out
  // could only dead-end — the token is spent and there is no session to resume.
  if (!sessionUserId) {
    if (hasToken && !tokenSpent) return { state: INVITE_STATES.CONFIRM, reason: 'token_unredeemed' };
    if (hasToken && tokenSpent) return { state: INVITE_STATES.EXPIRED, reason: 'token_spent_no_session' };
    return { state: INVITE_STATES.SIGNED_OUT, reason: 'no_session_no_token' };
  }

  // Deferring is a choice, and it survives until the invitee resumes — but it can
  // never hide a completed activation, which is why `activated` wins.
  if (deferred && !activated) return { state: INVITE_STATES.DEFERRED, reason: 'declined_for_now' };

  // ── Signed in. From here every verdict rests on a server fact. ──────────────
  if (!inviteState) {
    // The facts have not arrived. A failure to LOAD them is the one error worth its
    // own screen, because there is no other state to fall back to and a retry fixes
    // it. Every other error renders as a banner over an actionable state.
    if (errorCode) return { state: INVITE_STATES.ERROR, reason: 'invitation_state_unavailable' };
    return { state: INVITE_STATES.LOADING, reason: 'invitation_state_loading' };
  }

  if (activated && inviteState.status === ACTIVE_STATUS) {
    return { state: INVITE_STATES.SUCCESS, reason: 'activated' };
  }

  if (!inviteState.exists) {
    // An unspent token belonging to someone else: redeeming it is exactly how a
    // signed-in visitor becomes the invitee, so offer the confirmation.
    if (hasToken && !tokenSpent) return { state: INVITE_STATES.CONFIRM, reason: 'token_for_another_account' };
    if (tokenSpent) return { state: INVITE_STATES.EXPIRED, reason: 'token_spent_no_invitation' };
    return { state: INVITE_STATES.NO_INVITATION, reason: 'no_membership' };
  }

  if (inviteState.status === ACTIVE_STATUS) {
    return { state: INVITE_STATES.ALREADY_ACTIVE, reason: 'already_active' };
  }

  if (ENDED_STATUSES.includes(inviteState.status)) {
    return { state: INVITE_STATES.ENDED, reason: `membership_${inviteState.status}` };
  }

  if (inviteState.status === PENDING_STATUS) {
    // ★ THE RECOVERY RULE. Reached whether the token was spent, refused, or never
    //   needed — the session already IS the invitee, which is the only thing the
    //   token was ever going to prove. This is why a duplicate exchange no longer
    //   produces "expired": the second attempt is answered by a server fact, not by
    //   the error the second attempt returned.
    if (!inviteState.emailConfirmed) {
      return { state: INVITE_STATES.EMAIL_UNVERIFIED, reason: 'email_unconfirmed' };
    }
    if (!inviteState.hasPassword) {
      return { state: INVITE_STATES.CREDENTIALS, reason: 'password_required' };
    }
    return { state: INVITE_STATES.PROFILE_ONLY, reason: 'password_already_set' };
  }

  // A status the client does not recognise (a future value, a hand-edited row).
  // Refusing is the only safe reading of an unknown authorization state.
  return { state: INVITE_STATES.ENDED, reason: 'membership_unknown_status' };
}

/**
 * True when the flow still needs a password from this person. DURABLE — derived
 * from the server's `has_password`, never from "did we exchange a token during
 * this render", which is the value that reset on every refresh in #49.
 */
export function invitationNeedsPassword(inviteState) {
  return Boolean(inviteState && inviteState.exists
    && inviteState.status === PENDING_STATUS
    && inviteState.hasPassword === false);
}

/**
 * Classify a GoTrue verifyOtp() failure.
 *
 * Replaces `/expired|invalid|not found|token/i.test(e.message)`, which reported a
 * 429 rate-limit and a dropped connection as "your invitation has expired" — two
 * failures that a retry fixes, described to the reader as one that it cannot.
 *
 * Structured fields first: GoTrue has carried `code` since supabase-js 2.44 and a
 * message regex is the fallback, not the contract.
 *
 * @returns {'expired'|'rate_limited'|'network'|'server'|'invalid'|'unknown'}
 */
export function classifyExchangeError(err) {
  if (!err) return 'unknown';
  const code = String(err.code || '').toLowerCase();
  const status = Number(err.status || err.statusCode || 0);
  const message = String(err.message || '');

  if (status === 429 || code.includes('rate_limit')) return 'rate_limited';
  if (code === 'otp_expired') return 'expired';
  if (code === 'otp_disabled' || code === 'validation_failed') return 'invalid';
  if (status >= 500) return 'server';

  // A fetch that never reached a server has no status at all.
  if (!status && (err.name === 'TypeError' || /failed to fetch|network|load failed/i.test(message))) {
    return 'network';
  }

  if (/expired|already been used|already used/i.test(message)) return 'expired';
  if (/invalid.{0,20}token|token.{0,20}invalid|not found/i.test(message)) return 'expired';
  if (/invalid/i.test(message)) return 'invalid';
  return 'unknown';
}

/** True when retrying the same token could still work. */
export function exchangeErrorIsRetryable(kind) {
  return kind === 'rate_limited' || kind === 'network' || kind === 'server';
}

/**
 * The enrollment verdicts that would put a COLD PRICING PAGE in front of someone
 * who was told, in the invitation email, that there is nothing to buy. Deferring
 * exists to keep an invitee away from exactly these and from nothing else.
 *
 * ★ 'pending', 'renew_pending' and 'finalizing' are NOT here, and that distinction
 *   is the whole point: they describe someone who has ALREADY PAID and whose
 *   receipt is under review. Their screen (EnrollmentPendingScreen) shows no price,
 *   carries the turnaround promise, and flips to the app the moment an admin
 *   approves — so deferring them replaced a live, accurate status screen with a
 *   card saying "nothing else is needed from you", which for a person waiting on a
 *   payment review is simply false.
 *
 * ★ 'expired' IS NOT HERE EITHER, and that one is subtler. MembershipExpiredScreen
 *   does show prices — but only to someone who ALREADY BOUGHT, and it is the only
 *   surface carrying their Renew, Extend and Upgrade actions. Deferring them
 *   replaced the renewal flow with a card claiming nothing was needed from them,
 *   and the gate then re-pinned that card on every render, so a lapsed member
 *   offered a job could reach Renew only by accepting the job. A returning
 *   customer's own renewal screen is not the cold shop window this list is about.
 */
const PRICE_BEARING_ENROLL_STATES = Object.freeze(['paywall', 'paywall_notice']);

/** True when declining would drop this person onto a screen that asks for money. */
export function declineWouldShowAPrice(enrollState, enrollReady = true) {
  // Not knowing yet is treated as "might show a price". The cost of being wrong
  // that way is one extra card with a Resume button; the cost of being wrong the
  // other way is the pricing page this whole change exists to prevent.
  if (!enrollReady) return true;
  return PRICE_BEARING_ENROLL_STATES.includes(enrollState);
}

/**
 * Where "Not now" sends someone.
 *
 * ★ THIS EXISTS BECAUSE THE OLD ANSWER WAS ALWAYS "the paywall". dismissStaffInvite()
 *   set one flag, resolveGateScreen() skipped its invitation arm, staffBypassesPaywall()
 *   is false for an 'invited' membership, and the invitee — who was told in the email
 *   that there is nothing to buy — landed on the ₱1,499 pricing cards. Declining a job
 *   offer is not the same event as shopping for a course.
 *
 * @returns {'auth'|'student_app'|'defer'}
 *   auth        — no session; go back to sign-in
 *   student_app — they have somewhere of their own to land that is not a price:
 *                 the app, or their own pending/renewal status screen
 *   defer       — staff-only: keep them on the invitation screen's "finish later"
 *                 card. Never a price.
 */
export function resolveDeclineTarget({
  hasSession, membershipStatus, enrollState, enrollReady = true,
} = {}) {
  if (!hasSession) return 'auth';
  if (membershipStatus === ACTIVE_STATUS) return 'student_app';
  if (membershipStatus === PENDING_STATUS) {
    return declineWouldShowAPrice(enrollState, enrollReady) ? 'defer' : 'student_app';
  }
  return 'student_app';
}

/**
 * The tab an invitee lands on after activation.
 *
 * ★ DASHBOARD BY DEFAULT, NOT A QUEUE. #49 handed the new staff member straight to
 *   staffLandingTab(), so an Operations Admin's first sight of the product was a
 *   list of student payments to review — which reads as "something is waiting on
 *   you", moments after a screen that was trying to say "you are set up". The queue
 *   is still one click away, as a named secondary action, from a success card that
 *   says the account is already active.
 */
export const INVITE_LANDING_TAB = 'dashboard';
