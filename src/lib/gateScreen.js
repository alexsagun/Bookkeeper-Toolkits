// ─────────────────────────────────────────────────────────────────────────────
// gateScreen.js — PURE decision function for the root auth gate (#49).
// ─────────────────────────────────────────────────────────────────────────────
// The gate in BookkeeperPro.jsx was ~85 lines of interleaved early returns, and
// its ordering is load-bearing in ways that are not obvious from reading it: a
// rejected account must outrank the paywall (a ban cannot be paid around), the
// imported-onboarding screen must outrank the membership gate (a migrated account
// has to own its password before it can be told about a subscription), and the
// legacy approval gate must come LAST because the enrollment gate subsumes it.
//
// Every one of those rules was a comment. None of them was a test, because the
// decision lived inside a 33,000-line component with no rendering test
// infrastructure in this repo. So this module holds the decision and the
// component holds the JSX — the same split staffAuthVerdict() uses, for the same
// reason, and test/gateMatrix.test.mjs can now assert the whole table.
//
// ★ WHAT #49 CHANGED, AND WHY IT IS TWO SEPARATE THINGS:
//
//   1. Active staff no longer hit the student paywall. An Operations Admin or
//      Trainer carries is_admin = false BY DESIGN (that column means "active
//      Super Admin" since #45) and usually holds no subscription, so every branch
//      that reasoned from "unpaid non-admin" sent them to pricing. staffRoles.js
//      has shipped staffBypassesPaywall() since #45 and NOTHING IMPORTED IT.
//
//   2. A pending invitation gets its own screen. Before this, an invited member
//      was indistinguishable from a student, so the gate did the only thing it
//      could and asked them for ₱1,499.
//
// ★ THE staffReady WAIT IS DELIBERATELY NARROW. Blocking the whole gate until the
//   staff RPC lands would add its latency to every student's first paint. It is
//   only consulted where the answer could change the screen — immediately before
//   a pricing or approval decision — so a paying member never waits for it and an
//   invited Trainer never sees a flash of the paywall behind their invitation.
//
// ★ DEGRADED FALLS BACK TO is_admin, NOT TO "BYPASS". If the staff context could
//   not be read, treating that as "probably staff, let them through" would turn a
//   transient outage into free access to a paid product. Treating it as
//   profile.is_admin reproduces exactly the pre-#45 behaviour, which is the only
//   answer that is both safe and non-regressive. Same idiom as adminTabAllowed().
// ─────────────────────────────────────────────────────────────────────────────

import { staffBypassesPaywall, staffInvitationPending } from './staffRoles.js';

/**
 * Every screen the gate can choose. The component switches on these; nothing
 * else may invent a value, so an unhandled case is a missing switch arm rather
 * than a silently-rendered app shell.
 */
export const GATE_SCREENS = Object.freeze({
  SPLASH: 'splash',
  RECOVERY: 'recovery',
  AUTH: 'auth',
  IMPORT_ONBOARDING: 'import_onboarding',
  STAFF_INVITATION: 'staff_invitation',
  REJECTED: 'rejected',
  ENROLL_PENDING: 'enroll_pending',
  MEMBERSHIP_EXPIRED: 'membership_expired',
  RENEWAL_PAYWALL: 'renewal_paywall',
  PAYWALL: 'paywall',
  // The profile READ failed (not "there is no profile"). Every membership fact is
  // unknown, so no price may be quoted — see the PROFILE_UNAVAILABLE arm below.
  PROFILE_UNAVAILABLE: 'profile_unavailable',
  APPROVAL_PENDING: 'approval_pending',
  APP: 'app',
});

/** Screens that show a price. The staffReady wait exists for exactly this set. */
const PRICING_SCREENS = new Set([
  GATE_SCREENS.PAYWALL,
  GATE_SCREENS.RENEWAL_PAYWALL,
  GATE_SCREENS.MEMBERSHIP_EXPIRED,
]);

/**
 * Would the student gate put a PRICE in front of this viewer right now?
 *
 * The one question a deferral needs answered, and the reason it is asked on every
 * render rather than once at the moment of declining: enrollment state moves
 * underneath the person (an admin approves their payment), and a deferral that
 * outlives the price it was protecting them from becomes a trap.
 *
 * Unknown counts as "yes" — a card with a Resume button is a far cheaper mistake
 * than the pricing page this whole flow exists to keep staff away from.
 */
function staffOnlyWouldSeeAPrice({ requireEnrollment, enroll, renewNow }) {
  if (!requireEnrollment) return false;
  if (!enroll?.active) return false;
  if (!enroll.ready || !enroll.configured) return true;
  const decided = enrollmentScreen(enroll, renewNow);
  // ★ PAYWALL only — NOT the whole PRICING_SCREENS set. MEMBERSHIP_EXPIRED and
  //   RENEWAL_PAYWALL also show prices, but only to someone who already bought,
  //   and they are the only surfaces carrying Renew / Extend / Upgrade. Treating
  //   them as "a price to protect the invitee from" pinned a lapsed member away
  //   from the one screen that could restore their membership. The cold shop
  //   window a staff-only invitee must never be dropped on is the paywall.
  return Boolean(decided && decided.screen === GATE_SCREENS.PAYWALL);
}

/** Is this viewer allowed past the student membership gates? */
function passesAsStaff({ staff, staffDegraded, profile }) {
  // Availability may fail open; authority never does. A context we could not read
  // is answered by the legacy column, not by an assumption.
  if (staffDegraded) return Boolean(profile?.is_admin);
  return staffBypassesPaywall(staff) || Boolean(profile?.is_admin);
}

/**
 * Pick the screen for the current auth/membership/staff state.
 *
 * @returns {{ screen: string, reason: string }} — `reason` is a short stable slug
 *   for logs and tests. It is diagnostic only; never branch on it.
 */
export function resolveGateScreen(state) {
  const s = state || {};
  const {
    loading, recovery, user, profileReady, profile,
    staffReady = true, staffDegraded = false, staffMembership,
    staff, enroll, renewNow = false, inviteDismissed = false, hasInviteToken = false,
    inviteDeferred = false, profileFailed = false,
    requireApproval = true, requireEnrollment = true,
  } = s;

  if (loading) return { screen: GATE_SCREENS.SPLASH, reason: 'auth_loading' };
  if (recovery) return { screen: GATE_SCREENS.RECOVERY, reason: 'password_recovery' };
  if (hasInviteToken && !inviteDismissed && !user) {
    // No session yet, so no profile and therefore no ban to check — redeeming the
    // token is what creates the session the rest of this function reasons about.
    return { screen: GATE_SCREENS.STAFF_INVITATION, reason: 'staff_invitation_token' };
  }
  if (!user) return { screen: GATE_SCREENS.AUTH, reason: 'signed_out' };

  // ── The profile has not loaded yet ────────────────────────────────────────
  // ★ THIS ARM IS WHERE THE "expired invitation" BUG LIVED, and it is worth being
  //   precise about, because the line itself looks completely innocent.
  //
  //   profileReady is `!session?.user || profileFetchedFor === session.user.id`.
  //   verifyOtp() creates a session with a uid the profile effect has not fetched
  //   yet, so the SUCCESSFUL redemption of an invitation is itself what makes this
  //   false. Returning SPLASH here therefore unmounted StaffInvitationSetup at the
  //   exact moment it had just spent the one-time token, destroying the only record
  //   that it had been spent. When the profile landed, a FRESH instance offered the
  //   Accept button again, the second verifyOtp hit a consumed token, and the
  //   invitee was told their brand-new invitation had expired.
  //
  //   Keeping the screen mounted does NOT weaken the ban below it. The invitation
  //   component blocks every action until profileReady AND staffReady, the REJECTED
  //   arm fires the moment the profile arrives, and since #50
  //   accept_staff_invitation() refuses a rejected profile server-side as well — so
  //   the ban is enforced twice, once here and once in the database.
  if (!profileReady) {
    if (!inviteDismissed && hasInviteToken) {
      return { screen: GATE_SCREENS.STAFF_INVITATION, reason: 'staff_invitation_token' };
    }
    return { screen: GATE_SCREENS.SPLASH, reason: 'profile_loading' };
  }

  const isAdmin = Boolean(profile?.is_admin);

  // ── Imported-student onboarding (db #26) ──────────────────────────────────
  // ★ This sits ABOVE the staff invitation on purpose, and it is the one place
  //   this file departs from the ordering in the brief. Both screens set a
  //   password. If the staff screen ran first, an imported student who is also
  //   invited as staff would set a password, then be handed the import screen and
  //   asked to set another one — the import gate has no way to know a password
  //   was just chosen. Running import first cannot produce that, because the
  //   staff screen DOES detect an existing password and skips its own fields.
  //   The brief's binding requirement is that invitation and active-staff
  //   decisions come before student PRICING, and they still do.
  if (!isAdmin
    && profile?.account_origin === 'import'
    && profile?.onboarding_status !== 'completed') {
    return { screen: GATE_SCREENS.IMPORT_ONBOARDING, reason: 'import_onboarding' };
  }

  // ── Hard ban outranks everything below: a ban cannot be paid around ───────
  // ★ AND IT OUTRANKS THE INVITATION. This sat BELOW the invitation until review
  //   caught it: a rejected account with a pending invitation was shown the
  //   acceptance screen, accepted — committing a real membership write and an
  //   audit row — and only THEN hit RejectedScreen, because the ban branch
  //   deliberately does not consult staff status. That is a dead end reached
  //   through a write the UI cannot undo. If a banned person is genuinely being
  //   hired, lifting the ban is the deliberate act that comes first.
  if (requireApproval && !isAdmin && profile?.approval_status === 'rejected') {
    return { screen: GATE_SCREENS.REJECTED, reason: 'approval_rejected' };
  }

  // ── Pending staff invitation ──────────────────────────────────────────────
  // Before every membership gate, so an invitee is never shown a price for a job
  // they were offered. staffInvitationPending() reads the descriptive membership
  // object, which carries no permissions — reaching this screen grants nothing;
  // only accept_staff_invitation() does.
  // `inviteDismissed` is the "Not now" escape hatch, and it is session-only state
  // that resets on reload. It is not a bypass: declining an invitation grants
  // nothing, so whoever dismisses it simply meets whichever student gate applies.
  // Without it a paying student who is offered a job is PINNED here, unable to
  // reach the membership they already bought without first accepting the job.
  //
  // ★ BUT "whichever student gate applies" WAS THE PAYWALL, AND THAT WAS WRONG FOR
  //   THE COMMON CASE. #49 set one flag for everybody, so a staff-only invitee who
  //   clicked "Not now" — someone whose invitation email says in as many words that
  //   there is nothing to buy — landed on the ₱1,499 pricing cards. Declining a job
  //   offer is not the same event as shopping for a course.
  //
  //   `inviteDeferred` is the staff-only half of that decision, chosen by
  //   resolveDeclineTarget() in src/lib/inviteMachine.js: it keeps them on this
  //   screen's "finish later" card, which offers resuming setup or signing out and
  //   never a price. `inviteDismissed` is still set for someone who HAS a student
  //   membership to fall back to, and for them the behaviour is unchanged.
  // ★ THE TOKEN IS DECIDED HERE, BELOW THE BAN — not in a branch ahead of the
  //   switch. It used to be exactly that: `if (!loading && staffInvite)` ran before
  //   this function's verdict was consulted at all, so a rejected account that
  //   opened an invitation link rendered the acceptance screen anyway and could
  //   call accept_staff_invitation(), committing a membership write and an audit
  //   row. That defeated the whole reason the ban was moved above the invitation.
  //   Recovery was bypassed the same way. (CodeRabbit, PR #4.)
  if (!inviteDismissed && (hasInviteToken || staffInvitationPending(staffMembership))) {
    if (inviteDeferred) {
      // ★ A DEFERRAL ONLY HOLDS WHILE THERE IS A PRICE TO HOLD THEM BACK FROM.
      //   Deferring is not a decision about the invitation — it is a decision that
      //   the alternative was a pricing page. Pinning unconditionally meant a
      //   student who deferred, then paid and was approved, stayed on the
      //   "finish later" card: their membership had become usable and the screen
      //   kept saying nothing was needed from them. Re-checking each render makes
      //   the deferral self-correcting.
      if (staffOnlyWouldSeeAPrice({ requireEnrollment, enroll, renewNow })) {
        return { screen: GATE_SCREENS.STAFF_INVITATION, reason: 'staff_invitation_deferred' };
      }
    } else {
      return {
        screen: GATE_SCREENS.STAFF_INVITATION,
        reason: hasInviteToken ? 'staff_invitation_token' : 'staff_invitation_pending',
      };
    }
  }


  const staffPasses = passesAsStaff({ staff, staffDegraded, profile });

  // ── Enrollment / membership gate ──────────────────────────────────────────
  // requireEnrollment is honoured here as well as through enroll.active, so the
  // pure function is self-contained and the flag-off case is testable.
  if (requireEnrollment && enroll?.active && !staffPasses) {
    if (!enroll.ready) return { screen: GATE_SCREENS.SPLASH, reason: 'enroll_loading' };

    if (enroll.configured) {
      const decided = enrollmentScreen(enroll, renewNow);
      if (decided) {
        // The narrow staffReady wait. Only a price-bearing verdict can be wrong
        // because the staff answer has not arrived yet.
        if (!staffReady && PRICING_SCREENS.has(decided.screen)) {
          return { screen: GATE_SCREENS.SPLASH, reason: 'staff_context_loading' };
        }
        // ★ IDENTITY UNKNOWN — DO NOT QUOTE A PRICE.
        //   The profile READ failed, so `profile` is null and every fact this
        //   verdict rests on was read off a row we never saw: is_admin is falsy,
        //   is_paid is falsy, and enrollGateState() therefore falls all the way
        //   through to 'paywall'. That is indistinguishable from a brand-new unpaid
        //   signup, which is how the account that OWNS this product was shown its
        //   own pricing cards. Hold on a recoverable screen instead; AuthProvider
        //   retries the read on focus and on an interval, so the hold ends by
        //   itself. This grants nothing — authority still fails closed.
        //
        //   PAYWALL only, NOT the whole PRICING_SCREENS set — the same distinction
        //   staffOnlyWouldSeeAPrice() draws above. MEMBERSHIP_EXPIRED and
        //   RENEWAL_PAYWALL show a price only to someone who already bought, and
        //   they are the only surfaces carrying Renew / Extend / Upgrade; replacing
        //   them would strand a lapsed member away from the one screen that can
        //   restore their membership. (With profile === null they are unreachable
        //   anyway — enrollGateState needs profile.is_paid to return 'expired'.)
        //
        //   And it sits HERE, after enroll.ready / enroll.configured and after
        //   `decided`, not in front of them: checking it earlier would replace
        //   SPLASH and ENROLL_PENDING, which are already correct and already
        //   price-free. That is the #50 mistake this file has made once.
        if (profileFailed && decided.screen === GATE_SCREENS.PAYWALL) {
          return { screen: GATE_SCREENS.PROFILE_UNAVAILABLE, reason: 'profile_unavailable' };
        }
        return decided;
      }
    }
  }

  // ── Legacy admin-approval gate ────────────────────────────────────────────
  // Active staff skip it too: a Super Admin invited someone deliberately, and
  // making a second admin approve them in Access Requests is a dead end nobody
  // is watching for.
  if (requireApproval && !isAdmin && !staffPasses && profile?.approval_status === 'pending') {
    if (!staffReady) return { screen: GATE_SCREENS.SPLASH, reason: 'staff_context_loading' };
    return { screen: GATE_SCREENS.APPROVAL_PENDING, reason: 'approval_pending' };
  }

  return { screen: GATE_SCREENS.APP, reason: 'ok' };
}

/**
 * Map enrollGateState()'s verdict to a screen. Returns null for 'pass' and for
 * any state this gate does not hold on, so the caller falls through to the app.
 */
function enrollmentScreen(enroll, renewNow) {
  switch (enroll.state) {
    case 'pending':
    case 'renew_pending':
    case 'finalizing':
      return { screen: GATE_SCREENS.ENROLL_PENDING, reason: `enroll_${enroll.state}` };
    case 'expired':
      return renewNow
        ? { screen: GATE_SCREENS.RENEWAL_PAYWALL, reason: 'enroll_expired_renewing' }
        : { screen: GATE_SCREENS.MEMBERSHIP_EXPIRED, reason: 'enroll_expired' };
    case 'paywall':
    case 'paywall_notice':
      return { screen: GATE_SCREENS.PAYWALL, reason: `enroll_${enroll.state}` };
    case 'pass':
    default:
      return null;
  }
}
