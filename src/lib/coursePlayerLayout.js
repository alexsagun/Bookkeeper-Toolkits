// ─────────────────────────────────────────────────────────────────────────────
// src/lib/coursePlayerLayout.js — the learner lesson-page layout arithmetic (pure).
//
// ★ WHY THIS FILE EXISTS. The lesson page was a `lg:grid-cols-3` inside a
//   `max-w-7xl` canvas, so the video box measured 659px at 1440x900 and 744px at
//   1920x1080 — and the `maxHeight: 460` clamp on the <video> needed an 818px-wide
//   box before it could bind, which it never had. Removing that clamp alone changes
//   nothing; the TRACK SIZES were the whole story. They now live here, as numbers, so
//   the drag clamp, the @container threshold and grid template in src/index.css, and
//   a width restored from a returning learner's localStorage cannot drift apart —
//   which is exactly how a resizable pane ends up letting someone drag the video down
//   to 200px and then persisting it.
//
//   The DOM half stays in CSS on purpose: a container query re-lays out the page with
//   no render and no ResizeObserver, so nothing here is allowed to need a measurement.
//   The only measurement the app takes is the workspace's clientWidth at the instant a
//   drag STARTS, and it is fed to maxRailWidth() below.
//
// NO imports, NO side effects, NO DOM.
// Pinned by test/coursePlayerLayout.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

// ── Track sizes, in CSS pixels ───────────────────────────────────────────────
// ★ These MUST stay in lockstep with the --course-* custom properties on
//   .course-workspace in src/index.css. The CSS makes the same promise to a width
//   restored from storage on a narrower screen that this module makes to a drag.
// ★ These two were 280/640, which derived a 970px threshold — and 970 is just above the
//   912px workspace a 1280px screen has with the toolkit sidebar expanded (1920 at the
//   150% Windows scaling most people run). So one common setup docked cleanly with the
//   sidebar collapsed and flipped to an overlay COVERING THE VIDEO the moment the sidebar
//   was opened. Reported with screenshots of both states.
// ★ COURSE_STAGE_MIN is not advisory: whenever the CSS backstop binds, the rail is capped
//   so the stage lands EXACTLY here. At a 912px workspace it is therefore the literal video
//   width — 600px, beside a 262px rail. Changing it changes what that screen shows.
export const COURSE_RAIL_MIN = 240;
export const COURSE_RAIL_MAX = 420;
export const COURSE_RAIL_DEFAULT = 320;
export const COURSE_STAGE_MIN = 600;
export const COURSE_SPLITTER_WIDTH = 10;
export const COURSE_COLUMN_GAP = 20;

// Below this the panes stack (player first, curriculum under it). It is the narrowest
// workspace that still fits a MINIMUM rail beside a MINIMUM stage — derived, never a
// hand-typed breakpoint, so moving either minimum moves the threshold with it.
export const COURSE_TWO_PANE_MIN =
  COURSE_RAIL_MIN + COURSE_SPLITTER_WIDTH + COURSE_COLUMN_GAP * 2 + COURSE_STAGE_MIN;

// Keyboard steps on the splitter. Shift takes the coarse one.
export const COURSE_RAIL_STEP = 16;
export const COURSE_RAIL_STEP_COARSE = 64;

// The stage's viewport budget, mirrored by .course-stage's WIDTH cap. Kept here so the
// suite can assert the CSS and these constants have not diverged.
export const COURSE_STAGE_MAX_VH = 78;
export const COURSE_STAGE_MAX_PX = 900;

// ── Persistence ──────────────────────────────────────────────────────────────
// ★ NOT a per-course key. A learner sets their reading width once and it should hold
//   across every course they open — unlike course:<id>:activeLessonId, which is
//   meaningless outside its course. Per-user namespacing is window.storage's job.
// ★ DO NOT add this to LEGACY_KEYS in src/auth/AuthProvider.jsx. That list is a
//   one-shot pre-auth adoption pass, and CLAUDE.md forbids course keys in it.
export const COURSE_LAYOUT_STORAGE_KEY = 'course:learnerLayout:v1';
export const COURSE_LAYOUT_VERSION = 1;

export const DEFAULT_LEARNER_LAYOUT = Object.freeze({
  curriculumWidth: COURSE_RAIL_DEFAULT,
  curriculumCollapsed: false,
});

/**
 * The widest the curriculum rail may be in a workspace this wide, before the stage
 * would drop under COURSE_STAGE_MIN.
 *
 * Returns COURSE_RAIL_MIN rather than something smaller when there is no room: below
 * COURSE_TWO_PANE_MIN the CSS has already stacked the panes, so the rail width is not
 * read at all and the floor is the honest answer.
 *
 * @param {number} workspaceWidth  .course-workspace's clientWidth.
 * @returns {number} a rail ceiling in [COURSE_RAIL_MIN, COURSE_RAIL_MAX].
 */
export function maxRailWidth(workspaceWidth) {
  const w = Number(workspaceWidth);
  if (!Number.isFinite(w)) return COURSE_RAIL_MAX;
  const room = Math.floor(w - COURSE_STAGE_MIN - COURSE_SPLITTER_WIDTH - COURSE_COLUMN_GAP * 2);
  if (room < COURSE_RAIL_MIN) return COURSE_RAIL_MIN;
  return Math.min(COURSE_RAIL_MAX, room);
}

/**
 * Clamp a rail width to [MIN, min(MAX, maxAllowed)] and round it to a whole pixel.
 *
 * `maxAllowed` is maxRailWidth(workspace.clientWidth), measured once at drag start.
 * Omit it to clamp against the design maximum alone — which is what a value read from
 * storage gets, because at that point nothing has been laid out and there is nothing
 * to measure.
 *
 * ★ Two different failure answers, and the distinction is deliberate. A FINITE NUMBER
 *   out of range clamps to the nearest bound — 0 and -5 are values a corrupt write
 *   could produce, and the nearest legal rail is the honest reading of them. Anything
 *   that is NOT a number restores the DEFAULT, because there is no direction to clamp
 *   toward. The type check must come BEFORE the coercion: Number([]) and Number(null)
 *   are both 0, which is finite, so a bare Number() would silently turn structural
 *   garbage into the narrowest possible rail — a layout the learner never chose and
 *   cannot tell from one they did.
 *
 * @param {number} px
 * @param {number} [maxAllowed]
 * @returns {number}
 */
export function clampRailWidth(px, maxAllowed) {
  const upper = Number(maxAllowed);
  const ceiling = Math.max(
    COURSE_RAIL_MIN,
    Math.min(COURSE_RAIL_MAX, Number.isFinite(upper) ? upper : COURSE_RAIL_MAX),
  );
  // Numbers and non-blank numeric strings only. Objects, arrays, booleans and null
  // are structurally wrong, not merely out of range.
  const numeric = typeof px === 'number' || (typeof px === 'string' && px.trim() !== '');
  const n = numeric ? Math.round(Number(px)) : Number.NaN;
  if (!Number.isFinite(n)) return COURSE_RAIL_DEFAULT;
  if (n < COURSE_RAIL_MIN) return COURSE_RAIL_MIN;
  if (n > ceiling) return ceiling;
  return n;
}

/**
 * Does a workspace this wide get the two-pane layout? Mirrors the @container
 * threshold in src/index.css.
 */
export function supportsTwoPane(workspaceWidth) {
  const w = Number(workspaceWidth);
  return Number.isFinite(w) && w >= COURSE_TWO_PANE_MIN;
}

/**
 * Does this lesson get the black 16:9 media stage?
 *
 * ★ A TEXT lesson must NOT. renderVideo()'s text branch returns prose or a dashed
 *   "No content yet." card, and dropping either into a black video frame is how a
 *   reading lesson ends up looking broken. `!== 'text'` (rather than `=== 'video'`)
 *   is deliberate: it is exactly the test renderVideo already makes, so a row with a
 *   null or unknown type keeps landing on the video path and its empty state, as
 *   today. If the two ever disagree the empty state renders OUTSIDE the frame and the
 *   page jumps on every lesson change.
 */
export function lessonUsesMediaStage(lesson) {
  if (!lesson || typeof lesson !== 'object') return false;
  return lesson.type !== 'text';
}

/**
 * Read the persisted layout. Total: every bad input yields the shipped defaults.
 *
 * window.storage.get() resolves to { value: string | null } and never throws, so the
 * hostile inputs are null, '' and a string that is not the JSON we wrote — which is
 * reachable for real, because a build that shipped a different shape under this key
 * would still be sitting in a returning learner's localStorage.
 *
 * @param {string|null|undefined} raw
 * @returns {{ curriculumWidth: number, curriculumCollapsed: boolean }}
 */
export function parseLearnerLayout(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ...DEFAULT_LEARNER_LAYOUT };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return { ...DEFAULT_LEARNER_LAYOUT }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_LEARNER_LAYOUT };
  }
  return {
    // Clamped on the way IN as well as on the way out: a width saved on a 2560px
    // monitor is still only ever between 280 and 420, and a width saved by a future
    // build with different bounds is brought back inside this build's.
    // `??` not `||` — a stored 0 is a real (if invalid) value, and clampRailWidth
    // is what decides its fate, not the defaulting operator.
    curriculumWidth: clampRailWidth(parsed.curriculumWidth ?? DEFAULT_LEARNER_LAYOUT.curriculumWidth),
    // Strictly `=== true`: the string 'false', 0 and null all mean "not collapsed".
    curriculumCollapsed: parsed.curriculumCollapsed === true,
  };
}

/**
 * Serialize for window.storage.set(). Clamps, so a bad in-memory value cannot be
 * written to storage and read back as gospel on the next visit.
 */
export function serializeLearnerLayout(layout) {
  const src = layout && typeof layout === 'object' ? layout : {};
  return JSON.stringify({
    v: COURSE_LAYOUT_VERSION,
    curriculumWidth: clampRailWidth(src.curriculumWidth ?? DEFAULT_LEARNER_LAYOUT.curriculumWidth),
    curriculumCollapsed: src.curriculumCollapsed === true,
  });
}
