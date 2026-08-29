// ─────────────────────────────────────────────────────────────────────────────
// test/inviteMachine.test.mjs — the staff-invitation state machine (#50).
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXISTS
//
// The invitation flow told a real Operations Admin that their brand-new invitation
// had expired, and it did so on the FIRST click of a working link. Nothing caught
// it, because the only thing deciding which screen to show was a component-local
// `useState` boolean, and there is no jsdom or React Testing Library in this repo —
// so the step logic was, quite literally, untestable.
//
// This suite pins the DECISION. It cannot prove the JSX renders the right card for
// each state (nothing here can), so `INVITE_STATES` and the switch in
// StaffInvitationSetup still have to be kept in step by hand. What it does prove is
// that every state is reachable, that no combination of inputs produces the wrong
// one, and above all that the three sequences which broke in production — double
// exchange, unmount mid-flow, and refresh after redemption — now land on the screen
// the invitee should see.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVITE_STATES,
  INVITE_TERMINAL_STATES,
  INVITE_LANDING_TAB,
  EMPTY_INVITATION_STATE,
  normalizeInvitationState,
  resolveInviteState,
  invitationNeedsPassword,
  classifyExchangeError,
  exchangeErrorIsRetryable,
  resolveDeclineTarget,
  declineWouldShowAPrice,
} from '../src/lib/inviteMachine.js';

// ── Fixtures, named after the rows they stand for ────────────────────────────

/** A brand-new invitee: confirmed mailbox (generateLink confirms it), no password. */
const newInvitee = (over = {}) => ({
  exists: true,
  status: 'invited',
  roleKey: 'operations_admin',
  roleLabel: 'Operations Admin',
  displayTitle: null,
  invitedAt: '2026-08-30T09:00:00Z',
  emailConfirmed: true,
  hasPassword: false,
  ...over,
});

/** An existing account that was promoted: it already has credentials. */
const promotedInvitee = (over = {}) => newInvitee({ hasPassword: true, ...over });

const at = (over = {}) => ({
  hasToken: false,
  tokenSpent: false,
  phase: 'idle',
  sessionUserId: null,
  inviteState: null,
  activated: false,
  deferred: false,
  errorCode: null,
  ...over,
});

const stateOf = (over) => resolveInviteState(at(over)).state;

// ── The happy path, one step at a time ───────────────────────────────────────

test('a signed-out holder of a fresh token is asked to confirm', () => {
  assert.equal(stateOf({ hasToken: true }), INVITE_STATES.CONFIRM);
});

test('while verifyOtp is outstanding the screen says so, and says only that', () => {
  assert.equal(stateOf({ hasToken: true, phase: 'exchanging' }), INVITE_STATES.EXCHANGING);
});

test('after a successful exchange a brand-new invitee is asked for a password', () => {
  assert.equal(
    stateOf({ hasToken: true, tokenSpent: true, sessionUserId: 'u1', inviteState: newInvitee() }),
    INVITE_STATES.CREDENTIALS,
  );
});

test('a promoted account with a password already set skips the password fields', () => {
  assert.equal(
    stateOf({ sessionUserId: 'u1', inviteState: promotedInvitee() }),
    INVITE_STATES.PROFILE_ONLY,
  );
});

test('while accept_staff_invitation is outstanding the screen says activating', () => {
  assert.equal(
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee(), phase: 'activating' }),
    INVITE_STATES.ACTIVATING,
  );
});

test('activation lands on the branded success state, not on a queue', () => {
  assert.equal(
    stateOf({
      sessionUserId: 'u1',
      activated: true,
      inviteState: newInvitee({ status: 'active', hasPassword: true }),
    }),
    INVITE_STATES.SUCCESS,
  );
  assert.equal(INVITE_LANDING_TAB, 'dashboard');
});

// ── The three sequences that actually broke ──────────────────────────────────

test('THE BUG: a second exchange of a spent token does not report expired', () => {
  // The token is spent and GoTrue refused the duplicate. The durable fact — this
  // session's own membership is still 'invited' — is what decides the screen.
  const s = resolveInviteState(at({
    hasToken: true,
    tokenSpent: true,
    errorCode: 'expired',
    sessionUserId: 'u1',
    inviteState: newInvitee(),
  }));
  assert.equal(s.state, INVITE_STATES.CREDENTIALS, 'a duplicate exchange must recover, not dead-end');
  assert.notEqual(s.state, INVITE_STATES.EXPIRED);
});

test('THE BUG: an unmount mid-flow rebuilds the same state from durable facts alone', () => {
  // Everything component-local is back to its initial value — this is exactly what
  // the gate's !profileReady SPLASH arm did to the screen after verifyOtp landed.
  const afterRemount = resolveInviteState(at({
    hasToken: false, // the fragment was stripped at module load
    tokenSpent: false, // a fresh instance never saw the exchange
    phase: 'idle',
    sessionUserId: 'u1', // but the session survived
    inviteState: newInvitee(),
  }));
  assert.equal(afterRemount.state, INVITE_STATES.CREDENTIALS);
});

test('THE BUG: refreshing after redemption still requires a password', () => {
  // #49 derived `needsPassword` from `exchanged`, which a reload reset to false —
  // making the password OPTIONAL for the one person who does not have one.
  const reloaded = newInvitee();
  assert.equal(invitationNeedsPassword(reloaded), true);
  assert.equal(stateOf({ sessionUserId: 'u1', inviteState: reloaded }), INVITE_STATES.CREDENTIALS);
});

test('a double click cannot produce two different screens', () => {
  // Whatever the second click does, the first has already moved `phase`, and an
  // outstanding request outranks every fact fetched before it started.
  const first = at({ hasToken: true, phase: 'exchanging' });
  assert.equal(resolveInviteState(first).state, INVITE_STATES.EXCHANGING);
  assert.equal(
    resolveInviteState({ ...first, errorCode: 'expired' }).state,
    INVITE_STATES.EXCHANGING,
    'a late error from a previous attempt must not overwrite an in-flight one',
  );
});

// ── Refusals, each distinguishable from the others ───────────────────────────

test('a genuinely dead link with no session reports expired', () => {
  assert.equal(
    stateOf({ hasToken: true, tokenSpent: true, errorCode: 'expired' }),
    INVITE_STATES.EXPIRED,
  );
});

test('a spent token on a session with no invitation reports expired, not credentials', () => {
  assert.equal(
    stateOf({
      hasToken: true,
      tokenSpent: true,
      sessionUserId: 'stranger',
      inviteState: EMPTY_INVITATION_STATE,
    }),
    INVITE_STATES.EXPIRED,
  );
});

test('suspended and revoked are refused, and are not offered acceptance', () => {
  for (const status of ['suspended', 'revoked']) {
    const s = resolveInviteState(at({ sessionUserId: 'u1', inviteState: newInvitee({ status }) }));
    assert.equal(s.state, INVITE_STATES.ENDED, `${status} must be terminal`);
    assert.equal(s.reason, `membership_${status}`);
  }
});

test('an already-active member re-clicking their link is told they are set up', () => {
  assert.equal(
    stateOf({
      hasToken: true,
      sessionUserId: 'u1',
      inviteState: newInvitee({ status: 'active', hasPassword: true }),
    }),
    INVITE_STATES.ALREADY_ACTIVE,
  );
});

test('an unknown membership status is refused rather than guessed', () => {
  const s = resolveInviteState(at({
    sessionUserId: 'u1',
    inviteState: newInvitee({ status: 'pending_something' }),
  }));
  assert.equal(s.state, INVITE_STATES.ENDED);
  assert.equal(s.reason, 'membership_unknown_status');
});

test('an unconfirmed mailbox is named, because the server will refuse acceptance', () => {
  assert.equal(
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee({ emailConfirmed: false }) }),
    INVITE_STATES.EMAIL_UNVERIFIED,
  );
});

test('a signed-in stranger with no token and no membership is not shown an invitation', () => {
  assert.equal(
    stateOf({ sessionUserId: 'stranger', inviteState: EMPTY_INVITATION_STATE }),
    INVITE_STATES.NO_INVITATION,
  );
});

test('a signed-in stranger holding an unspent token is offered the confirmation', () => {
  // Redeeming is exactly how a visitor becomes the invitee: verifyOtp replaces the
  // session. Refusing here would strand anyone who was already logged in.
  const s = resolveInviteState(at({
    hasToken: true,
    sessionUserId: 'stranger',
    inviteState: EMPTY_INVITATION_STATE,
  }));
  assert.equal(s.state, INVITE_STATES.CONFIRM);
  assert.equal(s.reason, 'token_for_another_account');
});

test('no session and no token is signed out, never an invitation screen', () => {
  assert.equal(stateOf({}), INVITE_STATES.SIGNED_OUT);
});

test('facts that will not load get their own recoverable error, not a wrong verdict', () => {
  assert.equal(
    stateOf({ sessionUserId: 'u1', inviteState: null, errorCode: 'network' }),
    INVITE_STATES.ERROR,
  );
  assert.equal(
    stateOf({ sessionUserId: 'u1', inviteState: null }),
    INVITE_STATES.LOADING,
    'no error yet is loading, not error',
  );
});

test('deferring shows the finish-later card and never a terminal refusal', () => {
  assert.equal(
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee(), deferred: true }),
    INVITE_STATES.DEFERRED,
  );
});

test('deferring cannot hide a completed activation', () => {
  assert.equal(
    stateOf({
      sessionUserId: 'u1',
      deferred: true,
      activated: true,
      inviteState: newInvitee({ status: 'active', hasPassword: true }),
    }),
    INVITE_STATES.SUCCESS,
  );
});

// ── Counted sweep: every declared state must be reachable ────────────────────

test('every declared state is reachable from some input', () => {
  const reached = new Set([
    stateOf({ sessionUserId: 'u1' }),
    stateOf({ hasToken: true }),
    stateOf({ hasToken: true, phase: 'exchanging' }),
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee() }),
    stateOf({ sessionUserId: 'u1', inviteState: promotedInvitee() }),
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee(), phase: 'activating' }),
    stateOf({ sessionUserId: 'u1', activated: true, inviteState: newInvitee({ status: 'active' }) }),
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee({ status: 'active' }) }),
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee({ status: 'revoked' }) }),
    stateOf({ sessionUserId: 'u1', inviteState: EMPTY_INVITATION_STATE }),
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee({ emailConfirmed: false }) }),
    stateOf({ hasToken: true, tokenSpent: true }),
    stateOf({ sessionUserId: 'u1', errorCode: 'network' }),
    stateOf({}),
    stateOf({ sessionUserId: 'u1', inviteState: newInvitee(), deferred: true }),
  ]);
  const declared = Object.values(INVITE_STATES);
  assert.equal(declared.length, 15, 'the machine declares 15 states');
  for (const s of declared) {
    assert.ok(reached.has(s), `${s} must be reachable — an unreachable state is a screen nobody can see`);
  }
});

test('resolveInviteState never throws and never invents a state', () => {
  const declared = new Set(Object.values(INVITE_STATES));
  const junk = [
    undefined, null, {}, { phase: 'nonsense' }, { sessionUserId: 123 },
    { inviteState: 'not an object' }, { inviteState: { exists: 'yes' } },
    { hasToken: 'true', tokenSpent: 1 },
  ];
  for (const input of junk) {
    const out = resolveInviteState(input);
    assert.ok(out && typeof out.state === 'string', `bad input produced no state: ${JSON.stringify(input)}`);
    assert.ok(declared.has(out.state), `undeclared state ${out.state}`);
    assert.equal(typeof out.reason, 'string');
  }
});

test('the terminal list only names states that offer no further action', () => {
  for (const s of INVITE_TERMINAL_STATES) {
    assert.ok(Object.values(INVITE_STATES).includes(s), `${s} is not a declared state`);
  }
  assert.ok(!INVITE_TERMINAL_STATES.includes(INVITE_STATES.CREDENTIALS));
  assert.ok(!INVITE_TERMINAL_STATES.includes(INVITE_STATES.DEFERRED));
});

// ── invitationNeedsPassword: the durable replacement for `exchanged` ─────────

test('a password is required exactly when the server says there is none', () => {
  assert.equal(invitationNeedsPassword(newInvitee()), true);
  assert.equal(invitationNeedsPassword(promotedInvitee()), false);
  assert.equal(invitationNeedsPassword(newInvitee({ status: 'active' })), false);
  assert.equal(invitationNeedsPassword(EMPTY_INVITATION_STATE), false);
  assert.equal(invitationNeedsPassword(null), false);
  assert.equal(invitationNeedsPassword(undefined), false);
});

// ── normalizeInvitationState: fail closed on every path ──────────────────────

test('the RPC row maps onto the durable shape', () => {
  const { state, missing, failed } = normalizeInvitationState({
    data: {
      exists: true,
      status: 'invited',
      role_key: 'trainer',
      role_label: 'Trainer',
      display_title: 'Lead Trainer',
      invited_at: '2026-08-30T09:00:00Z',
      email_confirmed: true,
      has_password: false,
    },
    error: null,
  });
  assert.equal(failed, false);
  assert.equal(missing, false);
  assert.deepEqual(state, {
    exists: true,
    status: 'invited',
    roleKey: 'trainer',
    roleLabel: 'Trainer',
    displayTitle: 'Lead Trainer',
    invitedAt: '2026-08-30T09:00:00Z',
    emailConfirmed: true,
    hasPassword: false,
  });
});

test('a single-row array is unwrapped, as PostgREST may return one', () => {
  const { state } = normalizeInvitationState({
    data: [{ exists: true, status: 'invited', has_password: true }],
  });
  assert.equal(state.exists, true);
  assert.equal(state.hasPassword, true);
});

test('an unknown has_password is FALSE, so the invitee is asked rather than skipped', () => {
  const { state } = normalizeInvitationState({ data: { exists: true, status: 'invited' } });
  assert.equal(state.hasPassword, false, 'the safe failure is one extra field, not a credential-less account');
  assert.equal(state.emailConfirmed, false);
});

test('a truthy-but-not-true has_password is not accepted', () => {
  const { state } = normalizeInvitationState({
    data: { exists: true, status: 'invited', has_password: 'yes' },
  });
  assert.equal(state.hasPassword, false);
});

test('every error path fails closed to the empty state', () => {
  for (const error of [
    { code: 'PGRST202', message: 'Could not find the function' },
    { code: '42883', message: 'function does not exist' },
    { code: '500', message: 'boom' },
    { message: 'schema cache is stale' },
  ]) {
    const out = normalizeInvitationState({ data: null, error });
    assert.equal(out.failed, true, `${error.code || error.message} must be reported as failed`);
    assert.deepEqual(out.state, EMPTY_INVITATION_STATE);
  }
});

test('a missing function is distinguished from a failed one, so setup guidance is possible', () => {
  assert.equal(normalizeInvitationState({ error: { code: 'PGRST202' } }).missing, true);
  assert.equal(normalizeInvitationState({ error: { code: '500', message: 'boom' } }).missing, false);
});

test('exists:false discards everything else on the row', () => {
  const { state } = normalizeInvitationState({
    data: { exists: false, status: 'active', has_password: true },
  });
  assert.deepEqual(state, EMPTY_INVITATION_STATE);
});

test('the empty state is frozen, so no caller can widen it in place', () => {
  assert.ok(Object.isFrozen(EMPTY_INVITATION_STATE));
});

// ── classifyExchangeError: the regex that told people the wrong thing ────────

test('a rate limit is not reported as an expired invitation', () => {
  assert.equal(classifyExchangeError({ status: 429, message: 'Email rate limit exceeded' }), 'rate_limited');
  assert.equal(classifyExchangeError({ code: 'over_email_send_rate_limit' }), 'rate_limited');
});

test('a dropped connection is not reported as an expired invitation', () => {
  assert.equal(classifyExchangeError({ name: 'TypeError', message: 'Failed to fetch' }), 'network');
  assert.equal(classifyExchangeError({ message: 'NetworkError when attempting to fetch resource' }), 'network');
});

test('GoTrue structured codes are read before any message text', () => {
  assert.equal(classifyExchangeError({ code: 'otp_expired', message: 'anything at all' }), 'expired');
  assert.equal(classifyExchangeError({ code: 'validation_failed', message: 'expired' }), 'invalid');
});

test('a real expiry is still recognised from the message when there is no code', () => {
  assert.equal(classifyExchangeError({ status: 403, message: 'Token has expired or is invalid' }), 'expired');
  assert.equal(classifyExchangeError({ status: 404, message: 'not found' }), 'expired');
});

test('a server fault is its own kind, because retrying is worth offering', () => {
  assert.equal(classifyExchangeError({ status: 503, message: 'upstream' }), 'server');
});

test('nothing recognisable is unknown, not expired', () => {
  assert.equal(classifyExchangeError({ message: 'something odd happened' }), 'unknown');
  assert.equal(classifyExchangeError(null), 'unknown');
  assert.equal(classifyExchangeError(undefined), 'unknown');
});

test('only the kinds a retry can fix are retryable', () => {
  assert.equal(exchangeErrorIsRetryable('rate_limited'), true);
  assert.equal(exchangeErrorIsRetryable('network'), true);
  assert.equal(exchangeErrorIsRetryable('server'), true);
  assert.equal(exchangeErrorIsRetryable('expired'), false);
  assert.equal(exchangeErrorIsRetryable('invalid'), false);
  assert.equal(exchangeErrorIsRetryable('unknown'), false);
});

// ── resolveDeclineTarget: "Not now" must never be a shop window ──────────────

test('a staff-only invitee who declines is never sent to a cold pricing page', () => {
  for (const enrollState of ['paywall', 'paywall_notice']) {
    assert.equal(
      resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState }),
      'defer',
      enrollState,
    );
  }
});

test('a LAPSED member who declines reaches their own renewal screen, not a defer card', () => {
  // MembershipExpiredScreen shows prices, but only to someone who already bought,
  // and it is the only surface carrying Renew / Extend / Upgrade. Deferring them
  // replaced the renewal flow with a card claiming nothing was needed from them,
  // and the gate re-pinned it every render — so a lapsed member offered a job
  // could reach Renew only by accepting the job.
  assert.equal(
    resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState: 'expired' }),
    'student_app',
  );
  assert.equal(declineWouldShowAPrice('expired'), false);
});

test('an existing paying student who declines returns to the product they bought', () => {
  assert.equal(
    resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState: 'pass' }),
    'student_app',
  );
});

test('someone already active goes to the app, because there is nothing to defer', () => {
  assert.equal(
    resolveDeclineTarget({ hasSession: true, membershipStatus: 'active', enrollState: 'paywall' }),
    'student_app',
  );
});

test('a signed-out decline goes back to sign-in', () => {
  assert.equal(resolveDeclineTarget({ hasSession: false, membershipStatus: 'invited' }), 'auth');
  assert.equal(resolveDeclineTarget({}), 'auth');
});

test('with no invitation at all the ordinary gate applies, unchanged', () => {
  assert.equal(
    resolveDeclineTarget({ hasSession: true, membershipStatus: null, enrollState: 'paywall' }),
    'student_app',
  );
});

test('the decline matrix is covered in full', () => {
  const statuses = [null, 'invited', 'active', 'suspended', 'revoked'];
  const enrollStates = ['pass', 'paywall', 'expired', 'pending'];
  let cells = 0;
  const allowed = new Set(['auth', 'student_app', 'defer']);
  for (const membershipStatus of statuses) {
    for (const enrollState of enrollStates) {
      for (const hasSession of [true, false]) {
        const t = resolveDeclineTarget({ hasSession, membershipStatus, enrollState });
        assert.ok(allowed.has(t), `unknown decline target ${t}`);
        if (!hasSession) assert.equal(t, 'auth', 'no session can only mean sign-in');
        cells += 1;
      }
    }
  }
  assert.equal(cells, 40, 'the matrix must cover 5 statuses x 4 enrollment states x 2 session states');
});

test('a deferred invitee who signs out is not shown a Resume button that can only dead-end', () => {
  // Deferring is offered to a signed-in invitee. After a sign-out the token is
  // spent and there is no session to resume, so the honest screens are the
  // signed-out/expired ones — never "Resume setup".
  assert.equal(
    stateOf({ deferred: true, hasToken: true, tokenSpent: true }),
    INVITE_STATES.EXPIRED,
  );
  assert.equal(stateOf({ deferred: true }), INVITE_STATES.SIGNED_OUT);
  assert.equal(
    stateOf({ deferred: true, hasToken: true }),
    INVITE_STATES.CONFIRM,
    'an unspent token still offers the confirmation',
  );
});

// ── Declining must not strand a student who has already paid (#50 review) ────
// resolveDeclineTarget originally treated only 'pass' as "has somewhere of their
// own to go", so a member whose receipt was under review — whose screen shows no
// price at all — was deferred onto a card telling them nothing was needed from
// them, and the gate then kept them there after their payment was approved.

test('a student whose payment is under review is dismissed, not deferred', () => {
  for (const enrollState of ['pending', 'renew_pending', 'finalizing']) {
    assert.equal(
      resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState }),
      'student_app',
      `${enrollState}: EnrollmentPendingScreen shows no price, so there is nothing to defer from`,
    );
  }
});

test('only a cold pricing page defers', () => {
  for (const enrollState of ['paywall', 'paywall_notice']) {
    assert.equal(
      resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState }),
      'defer',
      `${enrollState} is a shop window for someone who was told there is nothing to buy`,
    );
    assert.equal(declineWouldShowAPrice(enrollState), true);
  }
  // Each of these is a screen the person has their own reason to be on.
  for (const enrollState of ['pass', 'pending', 'renew_pending', 'finalizing', 'expired']) {
    assert.equal(declineWouldShowAPrice(enrollState), false, enrollState);
  }
});

test('an unresolved enrollment state defers rather than risking a price', () => {
  // enrollGateState() with a null profile returns 'paywall', so a fully paid
  // member who declines before their gate data lands would otherwise be read as
  // unpaid. Not knowing is treated as "might show a price".
  assert.equal(declineWouldShowAPrice('pass', false), true);
  assert.equal(
    resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState: 'pass', enrollReady: false }),
    'defer',
  );
  assert.equal(
    resolveDeclineTarget({ hasSession: true, membershipStatus: 'invited', enrollState: 'pass', enrollReady: true }),
    'student_app',
  );
});
