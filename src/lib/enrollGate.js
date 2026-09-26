// ─────────────────────────────────────────────────────────────────────────────
// enrollGate.js — the membership math behind the student gate. PURE (#67).
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from src/BookkeeperPro.jsx by #67 so the new `scheduled` state could be
// pinned by node --test (test/enrollGate.test.mjs) instead of trusted to a comment.
// The bodies are the monolith's, unchanged except where #67 marks them.
//
// ★ A `scheduled` TERM IS NEITHER VALID NOR EXPIRED. It is a paid membership whose
//   start is in the future (a migrated legacy student). The database grants it nothing
//   until it becomes `active`; the client must not treat it as lapsed either — before
//   this, a paid student with a scheduled term resolved to 'expired' and was shown the
//   Renew prices for a membership they had already bought.
// ─────────────────────────────────────────────────────────────────────────────

// Subscription access math (client mirror of the date check in public.is_enrolled()).
// ends_at === undefined (column missing — lifecycle migration not run) and
// ends_at === null (legacy pre-lifecycle row) both mean "no expiry" — so a deploy
// ahead of db/2026-07-04-subscription-lifecycle.sql can never lock a member out.
export function subAccess(sub, nowMs = Date.now()) {
  if (!sub) {
    return { has: false, valid: false, legacy: false, ends: null, graceEnds: null, daysLeft: null,
      graceDaysLeft: null, inGrace: false, expired: false, scheduled: false, startsAt: null };
  }
  // #67: a paid term that has not started. Not valid, and NOT expired.
  if (sub.status === 'scheduled') {
    return { has: true, valid: false, legacy: false,
      ends: sub.ends_at ? new Date(sub.ends_at) : null,
      graceEnds: sub.grace_ends_at ? new Date(sub.grace_ends_at) : null,
      daysLeft: null, graceDaysLeft: null, inGrace: false, expired: false,
      scheduled: true, startsAt: sub.started_at ? new Date(sub.started_at) : null };
  }
  const legacy = sub.ends_at === undefined || sub.ends_at === null;
  const ends = legacy ? null : new Date(sub.ends_at);
  const graceEnds = !legacy && sub.grace_ends_at ? new Date(sub.grace_ends_at) : null;
  const now = nowMs;
  const active = sub.status === 'active';
  const inGrace = active && !legacy && ends <= now && !!graceEnds && graceEnds > now;
  const valid = active && (legacy || ends > now || inGrace);
  // Days remaining until the access boundary. Inside a grace window the term has
  // already passed, so measure to the grace end (never show a negative "N days left").
  const daysLeft = legacy ? null
    : Math.max(0, Math.ceil(((inGrace ? graceEnds.getTime() : ends.getTime()) - now) / 86400000));
  // Days left in the grace window specifically (null unless currently in grace) — lets
  // the UI show "grace: N days" distinctly from the pre-expiry days-remaining count.
  const graceDaysLeft = inGrace ? Math.max(0, Math.ceil((graceEnds.getTime() - now) / 86400000)) : null;
  return { has: true, valid, legacy, ends, graceEnds, daysLeft, graceDaysLeft, inGrace, expired: !valid,
    scheduled: false, startsAt: sub.started_at ? new Date(sub.started_at) : null };
}

// The gate decision, as one named state (root gate switches on it):
//   scheduled      → a paid membership that starts later (#67) → no price, a start date
//   pass           → app shell (valid subscription, or grandfathered paid user)
//   renew_pending  → paid member, term ended, renewal submitted → review screen
//   finalizing     → request approved, profile/subscription flip in flight
//   expired        → paid member, term ended, no live renewal → expired screen
//   pending        → unpaid, first payment under review
//   paywall_notice → unpaid, prior request rejected/expired → paywall w/ notice
//   paywall        → unpaid, no request yet
export function enrollGateState({ profile, latestReq: r, sub }, nowMs = Date.now()) {
  const acc = subAccess(sub, nowMs);
  // ★ #67: FIRST, and ahead of is_paid. A scheduled term is already paid for; whatever
  //   else the profile says, this person is never shown a price.
  if (acc.scheduled) return 'scheduled';
  const overdue = r?.status === 'pending_review' && r?.expires_at && new Date(r.expires_at) < new Date(nowMs);
  const pendingReq = r?.status === 'pending_review' && !overdue;
  if (profile?.is_paid) {
    if (acc.valid || !acc.has) return 'pass';   // active term, or paid before the subscriptions era
    // Paid but the term ended — only a request NEWER than the ended term counts as a renewal.
    const reqIsRenewal = r && sub?.started_at && new Date(r.created_at) > new Date(sub.started_at);
    if (pendingReq && reqIsRenewal) return 'renew_pending';
    if (r?.status === 'approved' && reqIsRenewal) return 'finalizing';
    return 'expired';
  }
  if (pendingReq) return 'pending';
  if (r?.status === 'approved') return 'finalizing';
  if (r) return 'paywall_notice';
  return 'paywall';
}
