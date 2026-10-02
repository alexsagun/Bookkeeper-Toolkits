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
  // #67: the migrated-student claim link (src/lib/importClaim.js) — redeem the one-time
  // token on a click, then IMPORT_ONBOARDING sets the password.
  IMPORT_CLAIM: 'import_claim',
  // #67: the one-time onboarding summary, straight after the password is set. Never a price.
  IMPORT_WELCOME: 'import_welcome',
  STAFF_INVITATION: 'staff_invitation',
  REJECTED: 'rejected',
  ENROLL_PENDING: 'enroll_pending',
  MEMBERSHIP_EXPIRED: 'membership_expired',
  // #67: a paid membership whose start date is still ahead. Never a price.
  MEMBERSHIP_SCHEDULED: 'membership_scheduled',
  RENEWAL_PAYWALL: 'renewal_paywall',
  PAYWALL: 'paywall',
  // The profile READ failed (not "there is no profile"). Every membership fact is
  // unknown, so no price may be quoted — see the PROFILE_UNAVAILABLE arm below.
  PROFILE_UNAVAILABLE: 'profile_unavailable',
  // #68: a migrated account that has set its password but holds no live or scheduled
  // term (its activation failed, was blocked, or is still to come). They paid in the
  // old system, so the cold paywall is the wrong answer. Never a price.
  IMPORT_MEMBERSHIP_PENDING: 'import_membership_pending',
  APPROVAL_PENDING: 'approval_pending',
  // #69: the Getting Started video a newly approved student watches once before their
  // first dashboard. Never a price. No staffReady wait: the server's `required` already
  // excludes staff (see the last arm of resolveGateScreen()).
  GETTING_STARTED: 'getting_started',
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
    hasClaimToken = false, claimDismissed = false, importWelcomePending = false,
    requireApproval = true, requireEnrollment = true,
    gettingStarted = null, gettingStartedDeferred = false, appShellShown = false,
  } = s;

  if (loading) return { screen: GATE_SCREENS.SPLASH, reason: 'auth_loading' };
  if (recovery) return { screen: GATE_SCREENS.RECOVERY, reason: 'password_recovery' };
  if (hasInviteToken && !inviteDismissed && !user) {
    // No session yet, so no profile and therefore no ban to check — redeeming the
    // token is what creates the session the rest of this function reasons about.
    return { screen: GATE_SCREENS.STAFF_INVITATION, reason: 'staff_invitation_token' };
  }
  // #67: a signed-out holder of a migration claim link gets the claim screen, not the
  // login form — they have no password yet. Redeeming creates the session.
  if (hasClaimToken && !claimDismissed && !user) {
    return { screen: GATE_SCREENS.IMPORT_CLAIM, reason: 'import_claim_token' };
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
    // #67: the same rule for a claim link — verifyOtp() creates the session that makes
    // profileReady false, and the claim screen must not be unmounted mid-redemption.
    if (!claimDismissed && hasClaimToken) {
      return { screen: GATE_SCREENS.IMPORT_CLAIM, reason: 'import_claim_token' };
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

  // ── A claim link opened while already signed in (#67) ─────────────────────
  // BELOW the ban (a banned account never reaches a redemption) and below imported
  // onboarding (someone mid-setup finishes it first). The screen offers "continue as
  // this account" or "sign out and use the link"; it redeems nothing by itself.
  if (hasClaimToken && !claimDismissed) {
    return { screen: GATE_SCREENS.IMPORT_CLAIM, reason: 'import_claim_signed_in' };
  }

  // ── The onboarding summary (#67) ──────────────────────────────────────────
  // Shown ONCE, right after a migrated student sets their password: their plan, batch
  // and dates, then "Go To Dashboard". `importWelcomePending` is session state the setup
  // screen sets; a reload skips the summary, which is harmless — it grants nothing and
  // the dashboard shows the same membership. Below the ban (a banned account never
  // sees it) and only once onboarding is really complete, so it cannot stand in for
  // setting a password. It shows no price.
  if (importWelcomePending && !isAdmin
    && profile?.account_origin === 'import'
    && profile?.onboarding_status === 'completed') {
    return { screen: GATE_SCREENS.IMPORT_WELCOME, reason: 'import_welcome' };
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
        // ★ D8 (#68): A SCHEDULED TERM IS NOT PROOF THE ACCOUNT IS SET UP. The scheduled
        //   verdict comes from the subscription alone, but whether a migrated student has
        //   created a password lives on the profile — the one row we failed to read — so
        //   the IMPORT_ONBOARDING arm above could not fire, and MEMBERSHIP_SCHEDULED told
        //   someone with no password to "come back then and sign in". Hold instead. The
        //   hold is price-free and self-clearing, exactly like the PAYWALL case.
        //   (#67 pinned the opposite on the reasoning that the scheduled screen shows no
        //   price. True, but it does make a claim the profile would have contradicted.)
        if (profileFailed && decided.screen === GATE_SCREENS.MEMBERSHIP_SCHEDULED) {
          return { screen: GATE_SCREENS.PROFILE_UNAVAILABLE, reason: 'profile_unavailable_scheduled' };
        }
        // ★ D1 (#68): A MIGRATED STUDENT IS NEVER SHOWN THE SHOP WINDOW. An account the
        //   import created can finish setting its password even when its activation then
        //   failed or was blocked (a password recovery confirms the mailbox), and with no
        //   term enrollGateState() bottoms out at 'paywall' — pricing cards for a course
        //   they already paid for, in a system they were told had nothing to buy. Hold them
        //   on a price-free "being set up" card instead. Only in PLACE of PAYWALL, after
        //   the ban and the staff bypass (both above), and only once onboarding is really
        //   complete — before that, IMPORT_ONBOARDING has already claimed them. (So the
        //   `completed` test below is a deliberate second line: no state reaches here
        //   without it, and a mutation that drops it survives the matrix by design.)
        if (decided.screen === GATE_SCREENS.PAYWALL
          && profile?.account_origin === 'import'
          && profile?.onboarding_status === 'completed') {
          return { screen: GATE_SCREENS.IMPORT_MEMBERSHIP_PENDING, reason: 'import_membership_pending' };
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

  // ── Getting Started (#69) ─────────────────────────────────────────────────
  // LAST, so every rule above has already passed. Presentation only: it grants nothing.
  // Only where a membership exists to onboard into (the paywall is enforced and set up).
  // (It sits even below the legacy approval gate the header calls LAST: that rule
  // orders the holds that decide access, and this arm decides none.)
  //
  // ★ "SET UP" IS enroll.migrated, NEVER enroll.configured (GF-2). useEnrollmentGate sets
  //   `configured` false on ANY error of the enrollment_requests read and true again on the next
  //   good one, and it reads again on every focus, visibilitychange and realtime event. The arm
  //   used to read it, so one 502 flipped GETTING_STARTED → APP → GETTING_STARTED: the gate
  //   unmounted mid-video, taking the <video>, the watch record and the place with it — and a
  //   required student let in at sign-in by an error was pulled OUT of a working session by the
  //   next focus. `migrated` is false only when a table is MISSING — by the error's CODE
  //   (isEnrollmentTableMissingErr), never its message, which a schema-cache reload or a permission
  //   error can share (V-MIGRATED-PREDICATE). The enrollment arm above keeps reading `configured`,
  //   its fail-open unchanged.
  // ★ ONCE A MEMBER'S APP IS RUNNING, THIS ARM NEVER TAKES IT OVER (GF-2). `appShellShown` is the
  //   root's latch — set when the app renders on a SETTLED pass for THIS account, ended by any hold
  //   screen and at sign-out. The enrollment arm's own fail-open app (a read error, for a student
  //   who is not a member yet) is never latched: latching it skipped the video for an enrollment
  //   approved later in that session (V-GF2-LATCH). A required answer that arrives while it stands (a
  //   replay page's "Try again", a refresh) is shown on the page and the card; the gate asks again
  //   at the next load, as a deferral does. Only the literal true latches, and only this arm: every
  //   rule above that decides access still applies.
  //
  // ★ 'loading' HOLDS THE SPLASH, NEVER THE APP. When an approval lands while the
  //   student sits on the pending screen, the cached answer says "not eligible" until
  //   one re-ask returns (gettingStartedStatus() in src/lib/gettingStarted.js), and the
  //   app rendered in that window would flash the dashboard the video must come before.
  // ★ EVERYTHING ELSE FAILS OPEN. An 'unavailable' answer (an RPC error, a pre-#69
  //   database, the 7 s timeout) renders the app, and `required` is trusted only on a
  //   'ready' answer: membership RLS still protects paid content, so failing open costs
  //   one orientation video, never access. The deferral ("Continue to dashboard for
  //   now", after the video would not play) is session-only and records nothing.
  // ★ NO staffReady WAIT: the server's `required` already excludes staff. The client's
  //   own exclusion is a second line for 'ready', and the only one for 'loading' —
  //   without it every staff member would sit on the splash until the fetch lands.
  //   (`!isAdmin` is implied by `!staffPasses`, since passesAsStaff() admits is_admin in
  //   both branches, so a mutation that drops it survives the matrix by design.)
  if (requireEnrollment && enroll?.migrated !== false
    && !isAdmin && !staffPasses && gettingStarted && !gettingStartedDeferred && appShellShown !== true) {
    if (gettingStarted.status === 'loading') {
      return { screen: GATE_SCREENS.SPLASH, reason: 'getting_started_loading' };
    }
    // The boolean true only: a 'ready' answer with any other `required` is malformed.
    if (gettingStarted.status === 'ready' && gettingStarted.required === true) {
      return { screen: GATE_SCREENS.GETTING_STARTED, reason: 'getting_started' };
    }
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
    case 'scheduled':
      // #67: paid, not started. Deliberately NOT in PRICING_SCREENS, so it never waits
      // on the staff context. It DOES become PROFILE_UNAVAILABLE when the profile read
      // failed (#68, D8) — see resolveGateScreen().
      return { screen: GATE_SCREENS.MEMBERSHIP_SCHEDULED, reason: 'enroll_scheduled' };
    case 'pass':
    default:
      return null;
  }
}
