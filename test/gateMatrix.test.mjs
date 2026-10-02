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

// ── An identity we could not READ is never quoted a price ───────────────────
//
// The profile fetch fails OPEN by design (profile = null, profileReady = true) so
// the gate can never hang. But with profile === null, is_admin is falsy, is_paid is
// falsy, and enrollGateState() bottoms out at 'paywall' — indistinguishable from a
// brand-new unpaid signup. That is how the account that OWNS this product was shown
// its own pricing cards, and how a paying student could be asked to buy what they
// already have. `profileFailed` is the fact that tells the two apart.
//
// It is a HOLD, not a grant: authority still fails closed everywhere else.
const unknownIdentity = (over = {}) => student({
  profile: null,
  profileFailed: true,
  ...over,
});

test('a profile READ failure is held, not priced', () => {
  assert.equal(
    screenOf(unknownIdentity({ enroll: { active: true, ready: true, configured: true, state: 'paywall' } })),
    GATE_SCREENS.PROFILE_UNAVAILABLE,
  );
  assert.equal(
    screenOf(unknownIdentity({ enroll: { active: true, ready: true, configured: true, state: 'paywall_notice' } })),
    GATE_SCREENS.PROFILE_UNAVAILABLE,
  );
});

test('a healthy profile is unaffected by the profileFailed arm', () => {
  // The ordinary unpaid signup must still reach the pricing cards.
  assert.equal(
    screenOf(student({ enroll: { active: true, ready: true, configured: true, state: 'paywall' } })),
    GATE_SCREENS.PAYWALL,
  );
  // And an explicit profileFailed: false changes nothing.
  assert.equal(
    screenOf(student({
      profileFailed: false,
      enroll: { active: true, ready: true, configured: true, state: 'paywall' },
    })),
    GATE_SCREENS.PAYWALL,
  );
});

// ★ THE #50 REGRESSION THIS ARM MUST NOT REPEAT. Checking profileFailed before
//   enroll.ready / enroll.configured / `decided` would replace three screens that
//   are already correct AND already price-free.
test('profileFailed does not pre-empt the screens that show no price', () => {
  assert.equal(
    screenOf(unknownIdentity({ enroll: { active: true, ready: false, configured: true, state: 'paywall' } })),
    GATE_SCREENS.SPLASH,
    'still loading the enrollment gate — that splash is correct',
  );
  assert.equal(
    screenOf(unknownIdentity({ enroll: { active: true, ready: true, configured: false, state: 'paywall' } })),
    GATE_SCREENS.APP,
    'an unconfigured enrollment gate falls through exactly as before',
  );
  assert.equal(
    screenOf(unknownIdentity({ enroll: { active: true, ready: true, configured: true, state: 'pending' } })),
    GATE_SCREENS.ENROLL_PENDING,
    'a submitted request is price-free and must survive',
  );
});

// MEMBERSHIP_EXPIRED and RENEWAL_PAYWALL show a price only to someone who already
// bought, and they carry the ONLY Renew / Extend / Upgrade actions. Replacing them
// would strand a lapsed member away from the screen that restores their membership.
test('the hold does not strand a lapsed member away from Renew', () => {
  assert.equal(
    screenOf(student({
      profileFailed: true,
      profile: { is_paid: true, is_admin: false, approval_status: 'approved' },
      enroll: { active: true, ready: true, configured: true, state: 'expired' },
    })),
    GATE_SCREENS.MEMBERSHIP_EXPIRED,
  );
});

test('a ban and a staff bypass both still outrank the unavailable hold', () => {
  assert.equal(
    screenOf(unknownIdentity({
      profile: { approval_status: 'rejected' },
      enroll: { active: true, ready: true, configured: true, state: 'paywall' },
    })),
    GATE_SCREENS.REJECTED,
    'a ban cannot be waited out any more than it can be paid around',
  );
  assert.equal(
    screenOf(unknownIdentity({
      staff: staffCtx('operations_admin'),
      enroll: { active: true, ready: true, configured: true, state: 'paywall' },
    })),
    GATE_SCREENS.APP,
    'active staff were never being priced, so nothing changes for them',
  );
});

// ── #67: the migrated-student claim link and the scheduled membership ────────

const scheduled = (over = {}) => student({
  profile: { is_admin: false, approval_status: 'approved', is_paid: true, account_origin: 'import', onboarding_status: 'completed' },
  enroll: { active: true, ready: true, configured: true, state: 'scheduled' },
  ...over,
});

test('a paid student whose membership starts later sees the start date, never a price', () => {
  assert.equal(screenOf(scheduled()), GATE_SCREENS.MEMBERSHIP_SCHEDULED);
});

test('the scheduled screen does not wait on the staff context — it quotes no price', () => {
  assert.equal(screenOf(scheduled({ staffReady: false })), GATE_SCREENS.MEMBERSHIP_SCHEDULED);
});

// ★ D8 (#68) REVERSES WHAT #67 PINNED HERE. #67 let the scheduled screen stand through a
//   failed profile read because it quotes no price. But it DOES tell the student "come
//   back then and sign in with the same email", and whether they have a password lives on
//   the profile we failed to read: a migrated student who had not yet set one closed the
//   tab believing they were done. profileFailed means profile === null in AuthProvider.
test('a failed profile read holds a scheduled student instead of saying "you are all set" (D8)', () => {
  const s = scheduled({ profileFailed: true, profile: null });
  assert.equal(screenOf(s), GATE_SCREENS.PROFILE_UNAVAILABLE);
  assert.equal(resolveGateScreen(s).reason, 'profile_unavailable_scheduled');
  assert.equal(screenOf(scheduled({ profileFailed: false })), GATE_SCREENS.MEMBERSHIP_SCHEDULED,
    'a profile that loaded changes nothing');
});

test('the scheduled hold keeps the same outranking rules as the paywall hold', () => {
  assert.equal(screenOf(scheduled({ profileFailed: true, profile: null,
    enroll: { active: true, ready: false, configured: true, state: 'scheduled' } })), GATE_SCREENS.SPLASH,
  'still loading the enrollment rows — that splash is correct');
  assert.equal(screenOf(scheduled({ profileFailed: true, profile: null,
    staff: { isStaff: true, status: 'active', roleKey: 'trainer', permissions: ['courses.create'] } })), GATE_SCREENS.APP,
  'active staff were never held on the scheduled screen');
  assert.equal(screenOf(scheduled({ profileFailed: true, profile: null, staffReady: false })),
    GATE_SCREENS.PROFILE_UNAVAILABLE, 'and it waits on nobody: it shows no price either');
});

test('imported onboarding (set a password) comes before the scheduled screen', () => {
  const s = scheduled({ profile: { is_admin: false, approval_status: 'approved', is_paid: true,
    account_origin: 'import', onboarding_status: 'invited' } });
  assert.equal(screenOf(s), GATE_SCREENS.IMPORT_ONBOARDING);
});

test('a ban outranks a scheduled membership', () => {
  const s = scheduled({ profile: { is_admin: false, approval_status: 'rejected', is_paid: true,
    account_origin: 'import', onboarding_status: 'completed' } });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

test('active staff with a scheduled term are not held on it', () => {
  const s = scheduled({ staff: { isStaff: true, status: 'active', roleKey: 'trainer', permissions: ['courses.create'] } });
  assert.equal(screenOf(s), GATE_SCREENS.APP);
});

test('a signed-out holder of a claim link gets the claim screen, not the login form', () => {
  assert.equal(screenOf(student({ user: null, hasClaimToken: true })), GATE_SCREENS.IMPORT_CLAIM);
  assert.equal(screenOf(student({ user: null, hasClaimToken: true, claimDismissed: true })), GATE_SCREENS.AUTH);
});

test('a claim in flight is NOT replaced by the splash while the profile loads', () => {
  assert.equal(screenOf(student({ profileReady: false, hasClaimToken: true })), GATE_SCREENS.IMPORT_CLAIM);
  assert.equal(screenOf(student({ profileReady: false })), GATE_SCREENS.SPLASH);
});

test('a claim link cannot carry a banned account past the ban', () => {
  const s = student({ hasClaimToken: true, profile: { is_admin: false, approval_status: 'rejected' } });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

test('a claim link does not pre-empt a password recovery or the initial load', () => {
  assert.equal(screenOf(student({ recovery: true, hasClaimToken: true })), GATE_SCREENS.RECOVERY);
  assert.equal(screenOf(student({ loading: true, hasClaimToken: true })), GATE_SCREENS.SPLASH);
});

test('someone already signed in who opens a claim link is asked, not silently switched', () => {
  assert.equal(screenOf(student({ hasClaimToken: true })), GATE_SCREENS.IMPORT_CLAIM);
  assert.equal(screenOf(student({ hasClaimToken: true, claimDismissed: true })), GATE_SCREENS.APP);
});

test('the scheduled and claim screens are declared ids', () => {
  const declared = new Set(Object.values(GATE_SCREENS));
  assert.ok(declared.has(screenOf(scheduled())));
  assert.ok(declared.has(screenOf(student({ user: null, hasClaimToken: true }))));
});

// ── #67: the onboarding summary, straight after the account is created ──────

const onboarded = (over = {}) => student({
  profile: { is_admin: false, approval_status: 'approved', is_paid: true, account_origin: 'import', onboarding_status: 'completed' },
  enroll: { active: true, ready: true, configured: true, state: 'pass' },
  importWelcomePending: true,
  ...over,
});

test('the summary shows once the account is created, before the dashboard', () => {
  assert.equal(screenOf(onboarded()), GATE_SCREENS.IMPORT_WELCOME);
  assert.equal(screenOf(onboarded({ importWelcomePending: false })), GATE_SCREENS.APP, 'Go To Dashboard moves on');
});

test('the summary never stands in for setting a password', () => {
  const s = onboarded({ profile: { is_admin: false, approval_status: 'approved', is_paid: true,
    account_origin: 'import', onboarding_status: 'invited' } });
  assert.equal(screenOf(s), GATE_SCREENS.IMPORT_ONBOARDING);
});

test('a ban outranks the summary', () => {
  const s = onboarded({ profile: { is_admin: false, approval_status: 'rejected', is_paid: true,
    account_origin: 'import', onboarding_status: 'completed' } });
  assert.equal(screenOf(s), GATE_SCREENS.REJECTED);
});

test('the summary is for migrated accounts only, and quotes no price while staff load', () => {
  const ordinary = onboarded({ profile: { is_admin: false, approval_status: 'approved', is_paid: true } });
  assert.notEqual(screenOf(ordinary), GATE_SCREENS.IMPORT_WELCOME);
  assert.equal(screenOf(onboarded({ staffReady: false })), GATE_SCREENS.IMPORT_WELCOME);
  assert.ok(new Set(Object.values(GATE_SCREENS)).has(GATE_SCREENS.IMPORT_WELCOME));
});

test('a student who opens access on the activation day reaches the dashboard, a later start the scheduled screen', () => {
  assert.equal(screenOf(onboarded({ importWelcomePending: false })), GATE_SCREENS.APP);
  assert.equal(screenOf(onboarded({ importWelcomePending: false,
    enroll: { active: true, ready: true, configured: true, state: 'scheduled' } })), GATE_SCREENS.MEMBERSHIP_SCHEDULED);
});

// ── #68 (D1): a migrated student with no term is held, never priced ─────────
// An account the import created can finish setting its password even when its
// activation failed or was blocked — a password recovery confirms the mailbox. With no
// term and is_paid false, enrollGateState() says 'paywall', and the student who already
// paid in Thinkific was shown ₱1,499 / ₱2,999 / ₱16,999 pricing cards.

const migratedNoTerm = (over = {}) => student({
  profile: { is_admin: false, approval_status: 'approved', is_paid: false,
    account_origin: 'import', onboarding_status: 'completed' },
  enroll: { active: true, ready: true, configured: true, state: 'paywall' },
  ...over,
});

test('an onboarded migrated account with no term gets the "being set up" hold, not the paywall', () => {
  const s = migratedNoTerm();
  assert.equal(screenOf(s), GATE_SCREENS.IMPORT_MEMBERSHIP_PENDING);
  assert.equal(resolveGateScreen(s).reason, 'import_membership_pending');
  assert.equal(screenOf(migratedNoTerm({ enroll: { active: true, ready: true, configured: true, state: 'paywall_notice' } })),
    GATE_SCREENS.IMPORT_MEMBERSHIP_PENDING, 'a rejected earlier request is still the paywall arm');
  assert.ok(new Set(Object.values(GATE_SCREENS)).has(GATE_SCREENS.IMPORT_MEMBERSHIP_PENDING));
  assert.equal(GATE_SCREENS.IMPORT_MEMBERSHIP_PENDING, 'import_membership_pending');
});

test('the hold replaces ONLY the paywall; every other membership screen is untouched', () => {
  const at = (state, profile = {}) => screenOf(migratedNoTerm({
    profile: { is_admin: false, approval_status: 'approved', account_origin: 'import', onboarding_status: 'completed', ...profile },
    enroll: { active: true, ready: true, configured: true, state },
  }));
  assert.equal(at('pass', { is_paid: true }), GATE_SCREENS.APP);
  assert.equal(at('scheduled', { is_paid: true }), GATE_SCREENS.MEMBERSHIP_SCHEDULED);
  assert.equal(at('pending'), GATE_SCREENS.ENROLL_PENDING);
  assert.equal(at('finalizing'), GATE_SCREENS.ENROLL_PENDING);
  assert.equal(at('expired', { is_paid: true }), GATE_SCREENS.MEMBERSHIP_EXPIRED,
    'a lapsed migrated member keeps Renew / Extend / Upgrade');
});

test('the hold is for onboarded MIGRATED accounts only', () => {
  // Not yet set up: the password screen claims them first.
  assert.equal(screenOf(migratedNoTerm({ profile: { is_admin: false, approval_status: 'approved',
    account_origin: 'import', onboarding_status: 'invited' } })), GATE_SCREENS.IMPORT_ONBOARDING);
  // An ordinary signup is shown the paywall, exactly as before.
  assert.equal(screenOf(migratedNoTerm({ profile: { is_admin: false, approval_status: 'approved' } })),
    GATE_SCREENS.PAYWALL);
  // An account whose import marks were cleared after a refused activation (E7) is an
  // ordinary signup again.
  assert.equal(screenOf(migratedNoTerm({ profile: { is_admin: false, approval_status: 'approved',
    account_origin: null, onboarding_status: null } })), GATE_SCREENS.PAYWALL);
});

test('a ban still wins over the hold, and active staff still bypass it', () => {
  assert.equal(screenOf(migratedNoTerm({ profile: { is_admin: false, approval_status: 'rejected',
    account_origin: 'import', onboarding_status: 'completed' } })), GATE_SCREENS.REJECTED);
  assert.equal(screenOf(migratedNoTerm({ staff: staffCtx('operations_admin'),
    staffMembership: membership('operations_admin', 'active') })), GATE_SCREENS.APP);
  assert.equal(screenOf(migratedNoTerm({ profile: { is_admin: true, approval_status: 'approved',
    account_origin: 'import', onboarding_status: 'completed' } })), GATE_SCREENS.APP, 'a Super Admin passes everything');
});

test('the hold never flashes ahead of the staff answer, and an unread profile is held as unknown', () => {
  assert.equal(screenOf(migratedNoTerm({ staffReady: false })), GATE_SCREENS.SPLASH,
    'the narrow staffReady wait still runs first, so a migrated staff member sees no card at all');
  assert.equal(screenOf(migratedNoTerm({ profileFailed: true, profile: null })), GATE_SCREENS.PROFILE_UNAVAILABLE);
});

test('the enrollment flag off, or an unconfigured gate, still holds nobody', () => {
  assert.equal(screenOf(migratedNoTerm({ requireEnrollment: false })), GATE_SCREENS.APP);
  assert.equal(screenOf(migratedNoTerm({ enroll: { active: true, ready: true, configured: false, state: 'paywall' } })),
    GATE_SCREENS.APP);
});

// ── #69: Getting Started, once, before the first dashboard ──────────────────
// A newly approved student watches the Super-Admin-managed welcome video once before
// their first dashboard. The SERVER decides `required` — who counts as newly approved,
// whether a video is live, whether they have finished it — and this table pins only
// where that answer sits. The arm is the LAST one, so every rule above has already
// passed, and it is presentation only: it grants nothing, and membership RLS still
// protects paid content, which is why anything but a ready answer fails OPEN.
//
// `gettingStarted` is gettingStartedGateInput()'s { status, required }: status is
// 'loading' | 'ready' | 'unavailable', and required is true only when ready.

const GS_REQUIRED = Object.freeze({ status: 'ready', required: true });
const GS_NOT_REQUIRED = Object.freeze({ status: 'ready', required: false });
const GS_LOADING = Object.freeze({ status: 'loading', required: false });
const GS_UNAVAILABLE = Object.freeze({ status: 'unavailable', required: false });

const enrollAt = (state) => ({ active: true, ready: true, configured: true, state });

// An approved, paying student whose server answer says the video is required.
const newlyApproved = (over = {}) => student({
  profile: { is_admin: false, approval_status: 'approved', is_paid: true },
  enroll: enrollAt('pass'),
  gettingStarted: GS_REQUIRED,
  ...over,
});

test('a newly approved student is shown Getting Started before the dashboard', () => {
  const s = newlyApproved();
  assert.equal(screenOf(s), GATE_SCREENS.GETTING_STARTED);
  assert.equal(resolveGateScreen(s).reason, 'getting_started');
});

test('the Getting Started screen is a declared id', () => {
  assert.equal(GATE_SCREENS.GETTING_STARTED, 'getting_started');
  assert.ok(new Set(Object.values(GATE_SCREENS)).has(screenOf(newlyApproved())),
    'an undeclared screen id would hit the switch default and render the app');
});

test('a student the server does not require it of goes straight to the app', () => {
  assert.equal(screenOf(newlyApproved({ gettingStarted: GS_NOT_REQUIRED })), GATE_SCREENS.APP);
});

test('while the answer is loading the gate holds the splash, never the dashboard', () => {
  const s = newlyApproved({ gettingStarted: GS_LOADING });
  assert.equal(screenOf(s), GATE_SCREENS.SPLASH);
  assert.equal(resolveGateScreen(s).reason, 'getting_started_loading');
});

test('an unavailable answer fails OPEN to the app', () => {
  // An RPC error, a pre-#69 database, or the 7 s timeout. Failing open costs one
  // orientation video; failing closed would strand every student behind a video that
  // cannot load (a pre-#69 database has no such RPC at all).
  assert.equal(screenOf(newlyApproved({ gettingStarted: GS_UNAVAILABLE })), GATE_SCREENS.APP);
  // Only a READY answer is trusted: `required` beside any other status is ignored.
  assert.equal(screenOf(newlyApproved({ gettingStarted: { status: 'unavailable', required: true } })),
    GATE_SCREENS.APP);
  assert.equal(screenOf(newlyApproved({ gettingStarted: { required: true } })), GATE_SCREENS.APP);
});

test('"Continue to dashboard for now" lets the student through for this session', () => {
  // Session-only state, set after the video would not play. It records nothing, so the
  // gate asks again at the next sign-in.
  assert.equal(screenOf(newlyApproved({ gettingStartedDeferred: true })), GATE_SCREENS.APP);
  assert.equal(screenOf(newlyApproved({ gettingStartedDeferred: true, gettingStarted: GS_LOADING })),
    GATE_SCREENS.APP, 'a deferral is not replaced by a splash when the answer reloads');
  assert.equal(screenOf(newlyApproved({ gettingStartedDeferred: false })), GATE_SCREENS.GETTING_STARTED);
});

test('no Getting Started input changes nothing', () => {
  assert.equal(screenOf(newlyApproved({ gettingStarted: null })), GATE_SCREENS.APP);
  assert.equal(screenOf(newlyApproved({ gettingStarted: undefined })), GATE_SCREENS.APP,
    'omitted, it defaults to null');
});

test('junk Getting Started input never holds anyone', () => {
  for (const gs of [{}, 'ready', true, 1, []]) {
    assert.equal(screenOf(newlyApproved({ gettingStarted: gs })), GATE_SCREENS.APP,
      `gettingStarted=${JSON.stringify(gs)}`);
  }
  // A 'ready' answer is trusted only when `required` is the boolean true. The SQL
  // coalesces it to a boolean, so anything else is malformed — and it fails open.
  for (const gs of [{ status: 'ready' }, { status: 'ready', required: null },
    { status: 'ready', required: 'true' }, { status: 'ready', required: 1 }]) {
    assert.equal(screenOf(newlyApproved({ gettingStarted: gs })), GATE_SCREENS.APP,
      `gettingStarted=${JSON.stringify(gs)}`);
  }
});

test('the legacy approval flag does not switch Getting Started off', () => {
  // VITE_REQUIRE_ADMIN_APPROVAL=false turns off the ACCESS-REQUEST gate only; the
  // video belongs to the enrollment paywall, which is still enforced here.
  assert.equal(screenOf(newlyApproved({ requireApproval: false })), GATE_SCREENS.GETTING_STARTED);
});

test('an absent enroll object does not suppress a required video', () => {
  // The membership gate treats a missing `enroll` as "nothing to hold" (see above). For
  // Getting Started that is not a reason to skip: the server only answers required:true
  // for an approved, enrolled member, so the answer itself carries the membership fact.
  assert.equal(screenOf(newlyApproved({ enroll: undefined })), GATE_SCREENS.GETTING_STARTED);
});

test('with the enrollment paywall off there is no membership to onboard into', () => {
  for (const gs of [GS_REQUIRED, GS_LOADING]) {
    assert.equal(screenOf(newlyApproved({ requireEnrollment: false, gettingStarted: gs })),
      GATE_SCREENS.APP, `status=${gs.status}`);
  }
});

test('nor behind an unmigrated enrollment gate', () => {
  // `migrated` is false only when the enrollment tables are MISSING — by the error's code
  // (isEnrollmentTableMissingErr, V-MIGRATED-PREDICATE) — never because one read failed (GF-2, below).
  for (const enroll of [{ migrated: false }, { configured: false, migrated: false },
    { active: true, ready: true, configured: false, migrated: false, state: 'pass' },
    { active: true, ready: true, configured: true, migrated: false, state: 'pass' }]) {
    for (const gs of [GS_REQUIRED, GS_LOADING]) {
      assert.equal(screenOf(newlyApproved({ enroll, gettingStarted: gs })), GATE_SCREENS.APP,
        `enroll=${JSON.stringify(enroll)}, status=${gs.status}`);
    }
  }
});

// ── GF-2: the arm must not follow a read that merely failed ─────────────────────
// useEnrollmentGate sets `configured` false on ANY error of the enrollment_requests read — a 500,
// a 502 or 504 postgrest-js does not retry, a thrown fetch — and true again on the next good read,
// and it reads again on every focus, every visibilitychange and every realtime event. The arm used
// to test `configured`, so one transient error flipped GETTING_STARTED → APP → GETTING_STARTED: the
// gate unmounted mid-video (its <video>, its watch record and its place gone), or a required student
// let in at sign-in by an error was pulled OUT of a working session by the next focus. The arm now
// reads `migrated`, which only a MISSING table can make false, and the enrollment arm keeps its own
// fail-open on `configured` exactly as before.

test('a transient enrollment read error does not switch Getting Started off (GF-2)', () => {
  const transient = { active: true, ready: true, configured: false, migrated: true, state: 'pass' };
  assert.equal(screenOf(newlyApproved({ enroll: transient })), GATE_SCREENS.GETTING_STARTED);
  assert.deepEqual(resolveGateScreen(newlyApproved({ enroll: transient, gettingStarted: GS_LOADING })),
    { screen: GATE_SCREENS.SPLASH, reason: 'getting_started_loading' });
  // The flap the review reproduced, read by read: configured true → false → true.
  const seen = [true, false, true].map((configured) => screenOf(newlyApproved({
    enroll: { active: true, ready: true, configured, migrated: true, state: 'pass' } })));
  assert.deepEqual(seen, [GATE_SCREENS.GETTING_STARTED, GATE_SCREENS.GETTING_STARTED, GATE_SCREENS.GETTING_STARTED],
    'one failed read must not unmount the gate in the middle of the video');
  // The arm never reads `configured` at all: with `migrated` unknown (absent), flipping it changes nothing.
  for (const configured of [true, false, undefined]) {
    assert.equal(screenOf(newlyApproved({ enroll: { active: true, ready: true, configured, state: 'pass' } })),
      GATE_SCREENS.GETTING_STARTED, `configured=${configured}`);
  }
  // …and the enrollment arm's own fail-open on `configured` is exactly as it was.
  const pendingButUnread = { active: true, ready: true, configured: false, migrated: true, state: 'pending' };
  assert.equal(screenOf(student({ enroll: pendingButUnread })), GATE_SCREENS.APP,
    'a read that failed still skips the enrollment hold (fail open), as before #69');
  assert.equal(screenOf(student({ enroll: { ...pendingButUnread, configured: true } })), GATE_SCREENS.ENROLL_PENDING);
});

// ── GF-2: once a member's app is running, Getting Started never takes the session over ──────────
// `appShellShown` is the root's latch: a MEMBER's app shell is running for THIS account in THIS session
// — set when the app renders on a SETTLED pass, ended by any hold screen and at sign-out (V-GF2-LATCH;
// the root's own lines are RUN through those sequences in uiSafety §28b). A required answer that
// arrives while it stands — a page's "Try again", a replay's refresh — is shown on the page and the
// card; the gate asks again at the next load, as a deferral does.

test('once a member\'s app is running for this account, Getting Started never takes the session over (GF-2)', () => {
  assert.equal(screenOf(newlyApproved({ appShellShown: true })), GATE_SCREENS.APP);
  assert.equal(screenOf(newlyApproved({ appShellShown: true, gettingStarted: GS_LOADING })), GATE_SCREENS.APP,
    'not even the splash: a running app is never replaced while an answer reloads');
  assert.equal(screenOf(newlyApproved({ appShellShown: false })), GATE_SCREENS.GETTING_STARTED);
  assert.equal(screenOf(newlyApproved()), GATE_SCREENS.GETTING_STARTED, 'omitted, it defaults to false');
  for (const junk of ['true', 1, {}]) {
    assert.equal(screenOf(newlyApproved({ appShellShown: junk })), GATE_SCREENS.GETTING_STARTED,
      `appShellShown ${JSON.stringify(junk)}: only the literal true latches`);
  }
  // It latches GETTING STARTED only — every rule that decides access still takes the app away.
  const cases = [
    ['a ban', student({ profile: { is_admin: false, approval_status: 'rejected' } }), GATE_SCREENS.REJECTED],
    ['a receipt under review', student({ enroll: enrollAt('pending') }), GATE_SCREENS.ENROLL_PENDING],
    ['a lapsed membership', student({ enroll: enrollAt('expired') }), GATE_SCREENS.MEMBERSHIP_EXPIRED],
    ['the paywall', student({ enroll: enrollAt('paywall') }), GATE_SCREENS.PAYWALL],
    ['the legacy approval gate', student({ profile: { is_admin: false, approval_status: 'pending' } }), GATE_SCREENS.APPROVAL_PENDING],
    ['an unread profile', unknownIdentity({ enroll: enrollAt('paywall') }), GATE_SCREENS.PROFILE_UNAVAILABLE],
    ['the enrollment rows in flight', student({ enroll: { active: true, ready: false, configured: true, state: 'pass' } }), GATE_SCREENS.SPLASH],
  ];
  for (const [label, base, expected] of cases) {
    const latched = { ...base, gettingStarted: GS_REQUIRED, appShellShown: true };
    assert.equal(screenOf(latched), expected, `${label}: still wins with the app latched`);
    assert.deepEqual(resolveGateScreen(latched), resolveGateScreen({ ...base, gettingStarted: GS_REQUIRED }), label);
  }
});

test('staff are never learners: active staff and a Super Admin are never held, not even by the splash', () => {
  // The server's `required` already excludes staff. The client's own exclusion is a
  // second line for 'ready' — and the ONLY line for 'loading', or every staff member
  // would sit on the splash until the fetch lands.
  for (const role of ['operations_admin', 'trainer']) {
    for (const gs of [GS_REQUIRED, GS_LOADING]) {
      const s = newlyApproved({
        staff: staffCtx(role),
        staffMembership: membership(role, 'active'),
        enroll: { active: false, ready: true, configured: true, state: 'pass' },
        gettingStarted: gs,
      });
      assert.equal(screenOf(s), GATE_SCREENS.APP, `${role}, status=${gs.status}`);
    }
  }
  for (const gs of [GS_REQUIRED, GS_LOADING]) {
    const admin = {
      profile: { is_admin: true, approval_status: 'approved' },
      enroll: { active: false, ready: true, configured: true, state: 'paywall' },
      gettingStarted: gs,
    };
    assert.equal(screenOf(newlyApproved({ ...admin, staff: staffCtx('super_admin') })), GATE_SCREENS.APP,
      `Super Admin, status=${gs.status}`);
    assert.equal(screenOf(newlyApproved({ ...admin, staffDegraded: true })), GATE_SCREENS.APP,
      `Super Admin on the legacy column alone, status=${gs.status}`);
  }
});

test('it does not wait on the staff lookup: the server already excludes staff', () => {
  assert.equal(screenOf(newlyApproved({ staffReady: false })), GATE_SCREENS.GETTING_STARTED);
});

// Every screen above the arm must still win over a REQUIRED video, and win UNCHANGED:
// the same screen and the same reason as with no Getting Started input at all.
const withRequiredVideo = (base) => ({ ...base, gettingStarted: GS_REQUIRED });

test('every earlier screen still wins over a required video, unchanged', () => {
  const importDone = { is_admin: false, approval_status: 'approved', is_paid: true,
    account_origin: 'import', onboarding_status: 'completed' };
  const cases = [
    ['a ban', student({ profile: { is_admin: false, approval_status: 'rejected' } }), GATE_SCREENS.REJECTED],
    ['imported onboarding', student({ profile: { ...importDone, onboarding_status: 'invited' } }),
      GATE_SCREENS.IMPORT_ONBOARDING],
    ['the import summary', onboarded(), GATE_SCREENS.IMPORT_WELCOME],
    ['a pending staff invitation', student({ staffMembership: membership('trainer', 'invited') }),
      GATE_SCREENS.STAFF_INVITATION],
    ['an invitation token', student({ hasInviteToken: true }), GATE_SCREENS.STAFF_INVITATION],
    ['a claim link opened while signed in', student({ hasClaimToken: true }), GATE_SCREENS.IMPORT_CLAIM],
    ['a receipt under review', student({ enroll: enrollAt('pending') }), GATE_SCREENS.ENROLL_PENDING],
    ['a renewal under review', student({ enroll: enrollAt('renew_pending') }), GATE_SCREENS.ENROLL_PENDING],
    ['an approval being finalized', student({ enroll: enrollAt('finalizing') }), GATE_SCREENS.ENROLL_PENDING],
    ['a lapsed membership', student({ enroll: enrollAt('expired') }), GATE_SCREENS.MEMBERSHIP_EXPIRED],
    ['renewing a lapsed membership', student({ enroll: enrollAt('expired'), renewNow: true }),
      GATE_SCREENS.RENEWAL_PAYWALL],
    ['a membership that starts later', scheduled(), GATE_SCREENS.MEMBERSHIP_SCHEDULED],
    ['the paywall', student({ enroll: enrollAt('paywall') }), GATE_SCREENS.PAYWALL],
    ['the paywall after a rejected request', student({ enroll: enrollAt('paywall_notice') }),
      GATE_SCREENS.PAYWALL],
    ['an unread profile', unknownIdentity({ enroll: enrollAt('paywall') }), GATE_SCREENS.PROFILE_UNAVAILABLE],
    ['a migrated account with no term', migratedNoTerm(), GATE_SCREENS.IMPORT_MEMBERSHIP_PENDING],
    // The enrollment gate is configured and passing here, so every one of the arm's own
    // conditions holds: this is the row that catches the arm moved above approval.
    ['the legacy approval gate', student({ profile: { is_admin: false, approval_status: 'pending' } }),
      GATE_SCREENS.APPROVAL_PENDING],
    ['the legacy approval gate, enrollment unmigrated', student({
      profile: { is_admin: false, approval_status: 'pending' },
      enroll: { active: false, ready: true, configured: false, state: 'pass' },
    }), GATE_SCREENS.APPROVAL_PENDING],
  ];
  for (const [label, base, expected] of cases) {
    assert.equal(screenOf(withRequiredVideo(base)), expected, `${label} must still win over Getting Started`);
    assert.deepEqual(resolveGateScreen(withRequiredVideo(base)), resolveGateScreen(base),
      `${label}: the verdict must be identical with and without a required video`);
  }
});

test('the splashes and sign-in screens above it are untouched too', () => {
  const cases = [
    ['the initial auth load', student({ loading: true }), 'auth_loading'],
    ['the profile load', student({ profileReady: false }), 'profile_loading'],
    ['the enrollment rows in flight',
      student({ enroll: { active: true, ready: false, configured: true, state: 'pass' } }), 'enroll_loading'],
    ['the narrow staff wait before a price', student({ staffReady: false, enroll: enrollAt('paywall') }),
      'staff_context_loading'],
    ['the staff wait before legacy approval',
      student({ staffReady: false, profile: { is_admin: false, approval_status: 'pending' } }),
      'staff_context_loading'],
  ];
  for (const [label, base, reason] of cases) {
    assert.deepEqual(resolveGateScreen(withRequiredVideo(base)), { screen: GATE_SCREENS.SPLASH, reason }, label);
  }
  assert.equal(screenOf(withRequiredVideo(student({ recovery: true }))), GATE_SCREENS.RECOVERY);
  assert.equal(screenOf(withRequiredVideo(student({ user: null }))), GATE_SCREENS.AUTH);
});

test('an approval that lands mid-wait: pending, then the splash, then Getting Started', () => {
  // While the receipt is under review the cached answer says "not eligible yet". When the
  // approval lands, gettingStartedStatus() reports 'loading' until its one re-ask returns,
  // so the frame in between is the splash — never a flash of the dashboard.
  assert.equal(screenOf(newlyApproved({ enroll: enrollAt('pending'), gettingStarted: GS_NOT_REQUIRED })),
    GATE_SCREENS.ENROLL_PENDING);
  assert.equal(screenOf(newlyApproved({ gettingStarted: GS_LOADING })), GATE_SCREENS.SPLASH);
  assert.equal(screenOf(newlyApproved()), GATE_SCREENS.GETTING_STARTED);
  assert.equal(screenOf(newlyApproved({ gettingStarted: GS_NOT_REQUIRED })), GATE_SCREENS.APP,
    'finishing the video opens the dashboard');
});

test('a migrated student sees the import summary first, then Getting Started', () => {
  assert.equal(screenOf(onboarded({ gettingStarted: GS_REQUIRED })), GATE_SCREENS.IMPORT_WELCOME);
  assert.equal(screenOf(onboarded({ importWelcomePending: false, gettingStarted: GS_REQUIRED })),
    GATE_SCREENS.GETTING_STARTED);
});
