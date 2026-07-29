// ─────────────────────────────────────────────────────────────────────────────
// lmsSchedule.js — PURE, dependency-free cohort scheduling logic (#37/#38).
// ─────────────────────────────────────────────────────────────────────────────
// The JS mirror of public.my_locked_lesson_ids() and the batch_sessions /
// assignment_submissions state rules. Used by CourseProgram (lock chips and
// "unlocks {date}"), CohortHub, and the assignment form.
// NO imports, NO side effects.
//
// ★ DRIP NEVER HIDES A LESSON ROW.
//   CourseProgram computes totalLessons from the lessons it can read. If drip
//   removed rows, a student would see a shorter course, complete it early, and
//   be issued a PDF certificate for a course they had not finished — which is
//   not recoverable once downloaded. So a locked lesson stays visible, with its
//   CONTENT withheld (video_url / storage_path / text_content are nulled by the
//   server) and the media object refused at Storage. This file decides what the
//   lock chip says; it decides nothing about access.
//
// ★ A MISSING ANCHOR FAILS CLOSED.
//   An offset needs a cohort start date. If starts_on is null the release date
//   is unknowable, so the lesson stays LOCKED rather than silently unlocking
//   everything — which is what the only live batch (starts_on = null) would
//   have done.
// ─────────────────────────────────────────────────────────────────────────────

const toTime = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When does this lesson unlock for this cohort?
 *
 * @param {{releaseAt?: string|Date|null, offsetDays?: number|null, startsOn?: string|Date|null}} rule
 * @returns {{at: number|null, undrippable: boolean, unknown: boolean}}
 *   at          — epoch ms of the unlock, when computable
 *   undrippable — no rule at all: the lesson is simply available
 *   unknown     — a rule exists but its anchor is missing → treat as LOCKED
 */
export function effectiveRelease(rule = {}) {
  const { releaseAt = null, offsetDays = null, startsOn = null } = rule || {};

  const absolute = toTime(releaseAt);
  if (absolute !== null) return { at: absolute, undrippable: false, unknown: false };

  const hasOffset = offsetDays !== null && offsetDays !== undefined && Number.isFinite(Number(offsetDays));
  if (!hasOffset) {
    // Neither an absolute date nor an offset: this lesson is not dripped.
    return { at: null, undrippable: true, unknown: false };
  }

  const anchor = toTime(startsOn);
  if (anchor === null) {
    // An offset with no cohort start date. Fail closed.
    return { at: null, undrippable: false, unknown: true };
  }
  return { at: anchor + Number(offsetDays) * DAY_MS, undrippable: false, unknown: false };
}

/** Convenience: the unlock timestamp as an ISO string, or null when unknowable. */
export function effectiveReleaseAt(rule) {
  const r = effectiveRelease(rule);
  return r.at === null ? null : new Date(r.at).toISOString();
}

/**
 * Is the lesson released?
 * Undrippable → yes. Unknown anchor → NO (fail closed). Otherwise compare.
 */
export function isReleased(rule, now = Date.now()) {
  const r = effectiveRelease(rule);
  if (r.undrippable) return true;
  if (r.unknown) return false;
  const at = now instanceof Date ? now.getTime() : Number(now);
  return r.at <= at;
}

/** What the lock chip should say. */
export function releaseLabel(rule, now = Date.now()) {
  const r = effectiveRelease(rule);
  if (r.undrippable) return null;
  if (r.unknown) return 'Unlocks when your cohort starts';
  if (isReleased(rule, now)) return null;
  const d = new Date(r.at);
  return `Unlocks ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * The soonest future unlock across a set of rules — for a "next up" line.
 * @returns {number|null} epoch ms, or null when nothing is pending
 */
export function nextReleaseAfter(rules, now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  let best = null;
  for (const rule of rules || []) {
    const r = effectiveRelease(rule);
    if (r.undrippable || r.unknown || r.at === null) continue;
    if (r.at > at && (best === null || r.at < best)) best = r.at;
  }
  return best;
}

/**
 * Live-session state.
 * @returns {'cancelled'|'live'|'ended'|'upcoming'|'unknown'}
 */
export function sessionState(session, now = Date.now()) {
  if (!session || typeof session !== 'object') return 'unknown';
  if (session.status === 'cancelled') return 'cancelled';

  const at = now instanceof Date ? now.getTime() : Number(now);
  const start = toTime(session.starts_at);
  if (start === null) return 'unknown';

  // A session with no explicit end is treated as one hour long, so the "join"
  // affordance disappears on its own rather than lingering all day.
  const end = toTime(session.ends_at) ?? start + 60 * 60 * 1000;

  if (at < start) return 'upcoming';
  if (at <= end) return 'live';
  return 'ended';
}

/** Should the join link be offered? Only just before and during the call. */
export function canJoinSession(session, now = Date.now(), leadMinutes = 15) {
  const state = sessionState(session, now);
  if (state === 'live') return true;
  if (state !== 'upcoming') return false;
  const at = now instanceof Date ? now.getTime() : Number(now);
  const start = toTime(session.starts_at);
  return start !== null && start - at <= leadMinutes * 60 * 1000;
}

/**
 * May the student still edit this submission?
 *
 * Mirrors #38's freeze: drafts and returned work are editable, submitted and
 * graded work is not. Past the due date nothing is editable — including a
 * draft, so "I saved a draft before the deadline" cannot become an edit after it.
 */
export function submissionEditable(submission, assignment, now = Date.now()) {
  const status = (submission && submission.status) || 'draft';
  if (status === 'submitted' || status === 'graded') return false;

  const at = now instanceof Date ? now.getTime() : Number(now);
  if (assignment && assignment.published === false) return false;

  const due = toTime(assignment && assignment.due_at);
  if (due !== null && at > due) return false;

  return status === 'draft' || status === 'returned';
}

/** Why the submission form is disabled, for honest UI copy. */
export function submissionLockReason(submission, assignment, now = Date.now()) {
  if (submissionEditable(submission, assignment, now)) return null;
  const status = (submission && submission.status) || 'draft';
  if (status === 'graded') return 'This work has been graded.';
  if (status === 'submitted') return 'This work is handed in and waiting to be reviewed.';
  if (assignment && assignment.published === false) return 'This assignment is not open yet.';
  const due = toTime(assignment && assignment.due_at);
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (due !== null && at > due) return 'The due date has passed.';
  return 'This submission cannot be edited.';
}
