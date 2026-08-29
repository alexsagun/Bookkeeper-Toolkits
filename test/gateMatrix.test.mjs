// test/gateMatrix.test.mjs — the root auth gate's precedence table (#49).
//
// WHY THIS EXISTS. The gate decides what every signed-in person sees, and until
// #49 its ordering lived as ~85 lines of interleaved early returns inside a
// 33,000-line component. Every rule was a comment: a ban outranks the paywall,
// imported onboarding outranks the membership gate, the legacy approval gate
// comes last. None was a test, because there is no jsdom or React Testing Library
// in this repo and there is no plan to add one.
//
// ★ SO THIS TESTS THE DECISION, NOT THE RENDER. resolveGateScreen() is a pure
//   function; BookkeeperPro.jsx switches on its answer. That split is the only
//   way the table below can be asserted at all, and it is worth being explicit
//   that a passing suite here does NOT prove the JSX renders the right component
//   for each id — only that the right id is chosen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GATE_SCREENS, resolveGateScreen } from '../src/lib/gateScreen.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const USER = { id: 'u1', email: 'a@b.com' };

const student = (over = {}) => ({
  loading: false, recovery: false, user: USER, profileReady: true,
  profile: { is_admin: false, approval_status: 'approved' },
  staffReady: true, staffDegraded: false,
  staffMembership: { exists: false, status: null, roleKey: null },
  staff: { isStaff: false, status: null, permissions: [] },
  enroll: { active: true, ready: true, configured: true, state: 'pass' },
  ...over,
});

const staffCtx = (roleKey, status = 'active') => ({
  isStaff: status === 'active', status, roleKey,
  isSuperAdmin: roleKey === 'super_admin',
  permissions: ['enrollments.review'],
});
const membership = (roleKey, status) => ({
  exists: true, status, roleKey, roleLabel: roleKey, displayTitle: null,
});

const screenOf = (state) => resolveGateScreen(state).screen;

// ── The ordering that must not drift ────────────────────────────────────────

test('loading outranks everything', () => {
  assert.equal(screenOf(student({ loading: true, recovery: true, user: null })), GATE_SCREENS.SPLASH);
});

test('a password-recovery session outranks the signed-out screen', () => {
  assert.equal(screenOf(student({ recovery: true })), GATE_SCREENS.RECOVERY);
});

test('no user means the auth screen, whatever else is true', () => {
  assert.equal(
    screenOf(student({ user: null, staffMembership: membership('trainer', 'invited') })),
    GATE_SCREENS.AUTH,
  );
});

test('the gate waits for the first profile fetch', () => {
  assert.equal(screenOf(student({ profileReady: false })), GATE_SCREENS.SPLASH);
});

test('a hard ban outranks the paywall — it cannot be paid around', () => {
  const s = student({
    profile: { is_admin: false, approval_status: 'rejected' },
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

test('imported onboarding outranks the membership gate', () => {
  const s = student({
    profile: { is_admin: false, account_origin: 'import', onboarding_status: 'pending' },
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.IMPORT_ONBOARDING);
});

test('imported onboarding also outranks a pending staff invitation', () => {
  // Both screens set a password. Import runs first because the staff screen can
  // detect an existing password and skip its own fields, while the import screen
  // cannot — running staff first would ask the same person twice.
  const s = student({
    profile: { is_admin: false, account_origin: 'import', onboarding_status: 'pending' },
    staffMembership: membership('trainer', 'invited'),
  });
  assert.equal(screenOf(s), GATE_SCREENS.IMPORT_ONBOARDING);
});

// ── Students are unaffected ─────────────────────────────────────────────────

test('an ordinary unpaid student still gets the paywall', () => {
  const s = student({ enroll: { active: true, ready: true, configured: true, state: 'paywall' } });
  assert.equal(screenOf(s), GATE_SCREENS.PAYWALL);
});

test('an ordinary paid student still gets the app', () => {
  assert.equal(screenOf(student()), GATE_SCREENS.APP);
});

test('the expired / renewal / pending states still resolve as before', () => {
  const at = (state, extra = {}) => screenOf(student({
    enroll: { active: true, ready: true, configured: true, state }, ...extra,
  }));
  assert.equal(at('pending'), GATE_SCREENS.ENROLL_PENDING);
  assert.equal(at('renew_pending'), GATE_SCREENS.ENROLL_PENDING);
  assert.equal(at('finalizing'), GATE_SCREENS.ENROLL_PENDING);
  assert.equal(at('expired'), GATE_SCREENS.MEMBERSHIP_EXPIRED);
  assert.equal(at('expired', { renewNow: true }), GATE_SCREENS.RENEWAL_PAYWALL);
  assert.equal(at('paywall_notice'), GATE_SCREENS.PAYWALL);
});

test('the legacy approval gate still holds a pending student', () => {
  const s = student({
    profile: { is_admin: false, approval_status: 'pending' },
    enroll: { active: false, ready: true, configured: false, state: 'pass' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APPROVAL_PENDING);
});

// ── The invitation ──────────────────────────────────────────────────────────

test('an invited Trainer gets the staff setup screen, NOT pricing', () => {
  const s = student({
    staffMembership: membership('trainer', 'invited'),
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION);
});

test('an invited Operations Admin gets it too', () => {
  const s = student({
    staffMembership: membership('operations_admin', 'invited'),
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION);
});

test('a pending invitation does NOT bypass the paywall on its own', () => {
  // Reaching the invitation screen grants nothing. If it is dismissed, the person
  // is still exactly the student they were a moment ago.
  //
  // ★ `inviteDismissed` now means specifically "fall through to the student gate",
  //   and since #50 the root only sets it for someone who HAS a student membership
  //   to fall back to. A staff-only invitee gets `inviteDeferred` instead — see the
  //   deferred-decline section at the end of this file. The rule asserted here is
  //   unchanged and still load-bearing: an invitation, declined or not, is not a
  //   subscription.
  const s = student({
    staffMembership: membership('trainer', 'invited'),
    inviteDismissed: true,
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.PAYWALL);
});

test('suspended and revoked never offer acceptance', () => {
  for (const status of ['suspended', 'revoked']) {
    const s = student({
      staffMembership: membership('trainer', status),
      enroll: { active: true, ready: true, configured: true, state: 'paywall' },
    });
    assert.equal(screenOf(s), GATE_SCREENS.PAYWALL,
      `${status}: an old invitation link is not a way back in`);
  }
});

// ── Active staff bypass ─────────────────────────────────────────────────────

test('an active Trainer with no subscription reaches the app, not the paywall', () => {
  const s = student({
    staff: staffCtx('trainer'),
    staffMembership: membership('trainer', 'active'),
    enroll: { active: false, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

test('an active Ops Admin is not held by the legacy approval gate either', () => {
  // A Super Admin invited them deliberately; making a second admin approve them
  // in Access Requests is a dead end nobody is watching.
  const s = student({
    profile: { is_admin: false, approval_status: 'pending' },
    staff: staffCtx('operations_admin'),
    staffMembership: membership('operations_admin', 'active'),
    enroll: { active: false, ready: true, configured: false, state: 'pass' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

test('a Super Admin passes everything', () => {
  const s = student({
    profile: { is_admin: true, approval_status: 'pending' },
    staff: staffCtx('super_admin'),
    enroll: { active: false, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

test('revoked staff with a valid subscription keep STUDENT access only', () => {
  const s = student({
    staff: staffCtx('trainer', 'revoked'),
    staffMembership: membership('trainer', 'revoked'),
    enroll: { active: true, ready: true, configured: true, state: 'pass' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP, 'their paid membership is untouched');
});

test('revoked staff WITHOUT student access follow the normal non-staff policy', () => {
  const s = student({
    staff: staffCtx('trainer', 'revoked'),
    staffMembership: membership('trainer', 'revoked'),
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.PAYWALL);
});

// ── No pricing flash ────────────────────────────────────────────────────────

test('a price is never shown while the staff context is still loading', () => {
  for (const state of ['paywall', 'paywall_notice', 'expired']) {
    const s = student({
      staffReady: false,
      enroll: { active: true, ready: true, configured: true, state },
    });
    assert.equal(screenOf(s), GATE_SCREENS.SPLASH,
      `${state}: an invited Trainer must not see a flash of the paywall behind their invitation`);
  }
});

test('but a paid student does NOT wait on the staff lookup', () => {
  // The wait is deliberately narrow: only a price-bearing verdict can be wrong
  // because the staff answer has not arrived. Blocking everyone would add the
  // RPC's latency to every student's first paint.
  assert.equal(screenOf(student({ staffReady: false })), GATE_SCREENS.APP);
});

test('nor does a pending-review student, whose screen cannot be wrong', () => {
  const s = student({
    staffReady: false,
    enroll: { active: true, ready: true, configured: true, state: 'pending' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.ENROLL_PENDING);
});

// ── Degraded ────────────────────────────────────────────────────────────────

test('a degraded staff context falls back to is_admin, never to "assume staff"', () => {
  // Treating "could not read" as "probably staff" would turn a transient outage
  // into free access to a paid product.
  const s = student({
    staffDegraded: true,
    staff: staffCtx('trainer'),          // stale/empty in reality; must not be trusted
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.PAYWALL);
});

test('a degraded context still lets a Super Admin through on the legacy column', () => {
  const s = student({
    staffDegraded: true,
    profile: { is_admin: true, approval_status: 'approved' },
    enroll: { active: false, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('an unconfigured or absent enrollment gate never holds anyone', () => {
  assert.equal(screenOf(student({ enroll: { active: true, ready: true, configured: false, state: 'paywall' } })),
    GATE_SCREENS.APP, 'a missing migration must fail open, as it always has');
  assert.equal(screenOf(student({ enroll: undefined })), GATE_SCREENS.APP);
});

test('the gate holds the splash while the enrollment rows are in flight', () => {
  assert.equal(screenOf(student({ enroll: { active: true, ready: false, configured: true, state: 'paywall' } })),
    GATE_SCREENS.SPLASH);
});

test('resolveGateScreen never throws on junk input', () => {
  for (const input of [undefined, null, {}, { user: USER }]) {
    assert.ok(resolveGateScreen(input).screen, `no screen for ${JSON.stringify(input)}`);
  }
});

test('every returned screen is a declared GATE_SCREENS value', () => {
  const declared = new Set(Object.values(GATE_SCREENS));
  const states = [
    student(), student({ loading: true }), student({ user: null }), student({ recovery: true }),
    student({ profileReady: false }), student({ staffMembership: membership('trainer', 'invited') }),
    student({ profile: { is_admin: false, approval_status: 'rejected' } }),
    student({ enroll: { active: true, ready: true, configured: true, state: 'expired' } }),
  ];
  for (const s of states) {
    assert.ok(declared.has(resolveGateScreen(s).screen), 'an undeclared screen id would hit the switch default and render the app');
  }
});

// ── Regressions fixed after review ──────────────────────────────────────────

test('a BAN outranks a pending invitation', () => {
  // This was the wrong way round. A rejected account with a pending invitation
  // was shown the acceptance screen, accepted — committing a membership write and
  // an audit row — and only THEN hit RejectedScreen, because the ban branch does
  // not consult staff status. A dead end reached through an irreversible write.
  const s = student({
    profile: { is_admin: false, approval_status: 'rejected' },
    staffMembership: membership('trainer', 'invited'),
  });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

test('dismissing lets a PAYING student reach the membership they bought', () => {
  // The escape hatch existed in the resolver but had no reachable control in the
  // UI, so a paying student who was offered a job was pinned on the invitation
  // screen with Sign out as the only way off.
  const paying = {
    staffMembership: membership('trainer', 'invited'),
    enroll: { active: true, ready: true, configured: true, state: 'pass' },
  };
  assert.equal(screenOf(student(paying)), GATE_SCREENS.STAFF_INVITATION);
  assert.equal(screenOf(student({ ...paying, inviteDismissed: true })), GATE_SCREENS.APP,
    'declining a job must not cost someone the membership they already paid for');
});

test('requireEnrollment:false is honoured by the resolver itself', () => {
  // It was destructured and never read — a silent false contract for any caller
  // that passed the flag without also neutering enroll.active.
  const s = student({
    requireEnrollment: false,
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

test('the ban still outranks the paywall, as it always did', () => {
  const s = student({
    profile: { is_admin: false, approval_status: 'rejected' },
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

// ── The invitation TOKEN obeys the same precedence ──────────────────────────
// The token used to be handled by a branch that ran BEFORE resolveGateScreen()'s
// verdict was consulted, checking only `!loading`. So every rule this module
// establishes — the ban outranking the invitation, recovery outranking everything
// — was bypassed the moment someone arrived from the email link. (CodeRabbit, PR #4.)

test('a token does NOT let a rejected account reach the acceptance screen', () => {
  // Accepting commits a membership write and an audit row the UI cannot undo.
  const s = student({
    profile: { is_admin: false, approval_status: 'rejected' },
    hasInviteToken: true,
  });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

test('a token does not pre-empt a password recovery in flight', () => {
  assert.equal(screenOf(student({ recovery: true, hasInviteToken: true })), GATE_SCREENS.RECOVERY);
});

test('a token does not pre-empt the initial auth load', () => {
  assert.equal(screenOf(student({ loading: true, hasInviteToken: true })), GATE_SCREENS.SPLASH);
});

test('a SIGNED-OUT holder of a token gets the acceptance screen, not the login form', () => {
  // No session means no profile, so no ban can apply — and redeeming the token is
  // what creates the session everything else reasons about.
  const s = student({ user: null, hasInviteToken: true });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION);
  assert.equal(resolveGateScreen(s).reason, 'staff_invitation_token');
});

test('a signed-out holder who dismisses the token falls back to the login form', () => {
  const s = student({ user: null, hasInviteToken: true, inviteDismissed: true });
  assert.equal(screenOf(s), GATE_SCREENS.AUTH);
});

test('a token still reaches the screen for an ordinary signed-in student', () => {
  const s = student({
    hasInviteToken: true,
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION);
});

test('imported onboarding still outranks a token', () => {
  const s = student({
    profile: { is_admin: false, account_origin: 'import', onboarding_status: 'pending' },
    hasInviteToken: true,
  });
  assert.equal(screenOf(s), GATE_SCREENS.IMPORT_ONBOARDING);
});

// ── The unmount that produced "your invitation has expired" (#50) ───────────
// profileReady is `!session?.user || profileFetchedFor === session.user.id`, so a
// SUCCESSFUL verifyOtp() — which creates a session with a uid the profile effect
// has not fetched yet — is itself what makes it false. Returning SPLASH there
// unmounted the invitation screen at the moment it had just spent the one-time
// token, and the fresh instance that replaced it offered the Accept button again.

test('an invitation in flight is NOT replaced by the splash while the profile loads', () => {
  const s = student({ profileReady: false, profile: null, hasInviteToken: true });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION);
  assert.equal(resolveGateScreen(s).reason, 'staff_invitation_token');
});

test('without a token the profile load still shows the splash, exactly as before', () => {
  assert.equal(
    screenOf(student({ profileReady: false, profile: null })),
    GATE_SCREENS.SPLASH,
  );
});

test('a dismissed token does not pin the screen through the profile load', () => {
  const s = student({ profileReady: false, profile: null, hasInviteToken: true, inviteDismissed: true });
  assert.equal(screenOf(s), GATE_SCREENS.SPLASH);
});

test('the ban still wins the moment the profile actually arrives', () => {
  // Holding the screen during the load is safe only because this stays true: the
  // component blocks every action until profileReady, and the instant the profile
  // lands the rejected account is refused.
  const rejected = { is_admin: false, approval_status: 'rejected' };
  assert.equal(
    screenOf(student({ profileReady: false, profile: null, hasInviteToken: true })),
    GATE_SCREENS.STAFF_INVITATION,
  );
  assert.equal(
    screenOf(student({ profileReady: true, profile: rejected, hasInviteToken: true })),
    GATE_SCREENS.REJECTED,
  );
});

test('a pending-membership invitation with no token still waits on the splash', () => {
  // Only a live token pins the screen. Without one there is nothing in flight to
  // protect, so the ordinary load path is unchanged.
  const s = student({
    profileReady: false,
    profile: null,
    staffMembership: membership('operations_admin', 'invited'),
  });
  assert.equal(screenOf(s), GATE_SCREENS.SPLASH);
});

// ── "Not now" must never be a shop window (#50) ────────────────────────────
// The old behaviour set one flag for everyone, so a staff-only invitee who
// declined landed on the ₱1,499 pricing cards — after an email that told them in
// as many words that there is nothing to buy.

test('a staff-only invitee who defers stays on the invitation screen, not pricing', () => {
  const s = student({
    staffMembership: membership('operations_admin', 'invited'),
    inviteDeferred: true,
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION);
  assert.equal(resolveGateScreen(s).reason, 'staff_invitation_deferred');
});

test('deferring never drops a staff-only invitee on the cold paywall', () => {
  // ★ 'expired' is deliberately NOT here. MembershipExpiredScreen shows prices,
  //   but only to someone who already bought, and it is the only surface with
  //   their Renew / Extend / Upgrade actions — see the lapsed-member case below.
  //   The screen a staff-only invitee must never be dropped on is the paywall.
  for (const state of ['paywall', 'paywall_notice']) {
    const s = student({
      staffMembership: membership('trainer', 'invited'),
      inviteDeferred: true,
      enroll: { active: true, ready: true, configured: true, state },
    });
    assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION,
      `enroll.state=${state} must not reach the paywall through a deferral`);
  }
});

test('a paying student who declines is dismissed, not deferred, and reaches the app', () => {
  // resolveDeclineTarget() sends this person to 'student_app', so the root sets
  // inviteDismissed — the pre-#50 flag — and the gate behaves exactly as it did.
  const s = student({
    staffMembership: membership('trainer', 'invited'),
    inviteDismissed: true,
    enroll: { active: true, ready: true, configured: true, state: 'pass' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

test('deferring does not survive acceptance: an active member is let through', () => {
  const s = student({
    staff: staffCtx('operations_admin'),
    staffMembership: membership('operations_admin', 'active'),
    inviteDeferred: true,
    enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.APP,
    'a stale deferral flag must not trap someone who has already activated');
});

test('deferring cannot be used to skip a ban', () => {
  const s = student({
    profile: { is_admin: false, approval_status: 'rejected' },
    staffMembership: membership('trainer', 'invited'),
    inviteDeferred: true,
  });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

// ── A deferral only holds while there is a price to hold them back from (#50) ──
// Deferring is not a decision about the invitation; it is a decision that the
// alternative was a pricing page. Pinning unconditionally meant a student who
// deferred, then paid and was approved, stayed on the "finish later" card while
// their membership had become perfectly usable.

test('a deferral stops pinning once the enrollment no longer shows a price', () => {
  const deferred = (state) => student({
    staffMembership: membership('trainer', 'invited'),
    inviteDeferred: true,
    enroll: { active: true, ready: true, configured: true, state },
  });
  assert.equal(screenOf(deferred('paywall')), GATE_SCREENS.STAFF_INVITATION,
    'while a price would show, the deferral holds');
  assert.equal(screenOf(deferred('pass')), GATE_SCREENS.APP,
    'once they have paid and been approved, the deferral must release');
  assert.equal(screenOf(deferred('pending')), GATE_SCREENS.ENROLL_PENDING,
    'a receipt under review has its own no-price screen, and it must win');
});

test('a deferral still holds while the enrollment answer is unknown', () => {
  const s = student({
    staffMembership: membership('trainer', 'invited'),
    inviteDeferred: true,
    enroll: { active: true, ready: false, configured: true, state: 'paywall' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.STAFF_INVITATION,
    'not knowing must never resolve to a pricing screen');
});

test('a deferral does not pin someone the enrollment gate never holds', () => {
  // Flag off, or a viewer the gate is inert for: there is no price, so no pin.
  assert.equal(
    screenOf(student({
      staffMembership: membership('trainer', 'invited'),
      inviteDeferred: true,
      requireEnrollment: false,
    })),
    GATE_SCREENS.APP,
  );
  assert.equal(
    screenOf(student({
      staffMembership: membership('trainer', 'invited'),
      inviteDeferred: true,
      enroll: { active: false, ready: true, configured: true, state: 'pass' },
    })),
    GATE_SCREENS.APP,
  );
});

test('a lapsed member who declines reaches the renewal screen, not a deferral', () => {
  // The decline router sends them to 'student_app', so the root sets
  // inviteDismissed — but even if a stale deferral flag survived, the gate must
  // not pin someone away from their own Renew/Extend/Upgrade actions.
  const s = student({
    staffMembership: membership('trainer', 'invited'),
    inviteDeferred: true,
    enroll: { active: true, ready: true, configured: true, state: 'expired' },
  });
  assert.equal(screenOf(s), GATE_SCREENS.MEMBERSHIP_EXPIRED);
});
