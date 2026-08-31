// src/lib/studentProgress.js — the shared vocabulary of the Progress & Rankings domain (#52).
//
// ★ THE SERVER IS THE AUTHORITY, AND THIS MODULE DELIBERATELY DOES NOT MIRROR IT.
//   Every score, rank, label and default a user sees is computed in SQL by
//   student_progress_current(), student_leaderboard() and my_student_progress(),
//   because those are the only places that can see the whole population and enforce
//   RLS. The client renders what the server returns: `learner_label`, `rank`,
//   `default_scope`, the track scores. It re-derives none of them.
//
//   What this module owns is exactly what the UI needs BEFORE a round trip: the track
//   names and weights it labels the bars with, the scope list it builds the tabs from,
//   and which scopes a given plan may pick. Nothing else.
//
// ★ WHY THIS FILE IS SO SMALL, AND MUST STAY SO. It shipped with twelve exports, of
//   which three were ever imported. The other nine were second implementations of
//   server-owned rules — a client dense-rank, a client hidden-row filter, a client
//   overall-score calculator — each with a passing unit test and no caller. Two had
//   already drifted from the SQL they claimed to mirror: the anonymous label used
//   FNV-1a where the server uses hashtextextended(), so the same learner got two
//   different "Learner NNNN" numbers; and weeklyProgressGain() coalesced a missing
//   baseline to zero, which is precisely the fabricated 0.00 that the "no baseline is
//   NULL" rule exists to prevent. Tested, green, wrong, and one import away from
//   production. This is the staffBypassesPaywall() failure mode CLAUDE.md documents.
//   If you need a rule the server already enforces, read it off the response.
//
//   test/studentProgressSql.test.mjs pins the two constants below against BOTH the
//   dated migration and the bootstrap fold, so a weight or scope changed here without
//   the SQL following fails offline rather than in production.

export const STUDENT_PROGRESS_TRACKS = Object.freeze([
  Object.freeze({ key: 'foundation', label: 'Accounting Foundations', weight: 20 }),
  Object.freeze({ key: 'qbo', label: 'QuickBooks Mastery', weight: 40 }),
  Object.freeze({ key: 'profile', label: 'Profile Optimization', weight: 20 }),
  Object.freeze({ key: 'interview', label: 'Interview Readiness', weight: 20 }),
]);

export const LEADERBOARD_SCOPES = Object.freeze([
  Object.freeze({ key: 'my_plan', label: 'My Plan' }),
  Object.freeze({ key: 'general', label: 'General' }),
  Object.freeze({ key: 'vip', label: 'VIP Overall' }),
  Object.freeze({ key: 'my_batch', label: 'My Batch' }),
  Object.freeze({ key: 'all', label: 'All Learners' }),
]);

/**
 * The scopes a learner may choose between.
 *
 * A learner sees the board for their own segment and never the other's: the VIP board
 * IS the list of VIP members and General is its complement, so offering both would
 * disclose the plan that the public row shape deliberately omits. My Batch needs a
 * live cohort seat on top of that. #53 enforces all three server-side.
 *
 * This is a presentation filter, NOT a permission — student_leaderboard() re-checks
 * every scope against the caller's own entitlements and is the actual boundary. What
 * it buys is that the UI never renders a tab whose only possible outcome is an error.
 *
 * Staff are not covered here: they have no plan, so the caller keeps its own fallback
 * list for them (the server admits staff to every scope).
 */
export function progressScopeOptions({ planKey, hasCurrentBatch = false } = {}) {
  const isVip = planKey === 'vip';
  return LEADERBOARD_SCOPES.filter((scope) => {
    if (scope.key === 'my_batch') return isVip && hasCurrentBatch;
    if (scope.key === 'vip') return isVip;
    if (scope.key === 'general') return !isVip;
    return true;   // my_plan and all are always available
  });
}
