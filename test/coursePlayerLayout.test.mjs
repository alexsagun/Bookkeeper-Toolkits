// test/coursePlayerLayout.test.mjs — the lesson-page track arithmetic (pure).
//
// ★ WHY THIS SUITE EXISTS. These numbers are load-bearing in THREE places that cannot
//   see each other: the drag clamp in CourseProgram, the @container threshold and grid
//   template in src/index.css, and a value restored from a returning learner's
//   localStorage. A silent drift between them is a video the learner can drag down to
//   nothing, or a stored width that outlives a redesign of the bounds.
//
// Assertions target the exported constants and the observable clamping behaviour,
// never prose. Section 7 is the CSS-drift ratchet; section 8 checks the app wires it up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  COURSE_RAIL_MIN, COURSE_RAIL_MAX, COURSE_RAIL_DEFAULT, COURSE_STAGE_MIN,
  COURSE_SPLITTER_WIDTH, COURSE_COLUMN_GAP, COURSE_TWO_PANE_MIN,
  COURSE_RAIL_STEP, COURSE_RAIL_STEP_COARSE,
  COURSE_STAGE_MAX_VH, COURSE_STAGE_MAX_PX,
  COURSE_LAYOUT_STORAGE_KEY, COURSE_LAYOUT_VERSION, DEFAULT_LEARNER_LAYOUT,
  clampRailWidth, maxRailWidth, supportsTwoPane, lessonUsesMediaStage,
  parseLearnerLayout, serializeLearnerLayout,
} from '../src/lib/coursePlayerLayout.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// The repo is CRLF and has no .gitattributes, so every source scan below normalises
// first — an LF-anchored regex silently matches nothing here.
const css = () => readFileSync(join(REPO, 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');
const app = () => readFileSync(join(REPO, 'src/BookkeeperPro.jsx'), 'utf8').replace(/\r\n/g, '\n');

// The measured width chain, so the assertions below read as the real screens they are.
// viewport - sidebar(288 open / 76 rail) - 2*40 (TabPanel lg:p-10)
const workspace = (viewport, sidebar) => viewport - sidebar - 80;
const stageAt = (content, rail = COURSE_RAIL_DEFAULT) =>
  content - rail - COURSE_SPLITTER_WIDTH - COURSE_COLUMN_GAP * 2;

// ── 1. The bounds are coherent ───────────────────────────────────────────────

test('the rail bounds bracket the default and are whole pixels', () => {
  assert.ok(COURSE_RAIL_MIN < COURSE_RAIL_DEFAULT, 'the default must be above the floor');
  assert.ok(COURSE_RAIL_DEFAULT < COURSE_RAIL_MAX, 'the default must be below the ceiling');
  for (const [name, n] of Object.entries({
    COURSE_RAIL_MIN, COURSE_RAIL_MAX, COURSE_RAIL_DEFAULT, COURSE_STAGE_MIN,
    COURSE_SPLITTER_WIDTH, COURSE_COLUMN_GAP, COURSE_RAIL_STEP, COURSE_RAIL_STEP_COARSE,
  })) {
    assert.ok(Number.isInteger(n), `${name} must be a whole pixel, got ${n}`);
  }
});

test('COURSE_TWO_PANE_MIN is DERIVED, not a hand-typed breakpoint', () => {
  assert.equal(
    COURSE_TWO_PANE_MIN,
    COURSE_RAIL_MIN + COURSE_SPLITTER_WIDTH + COURSE_COLUMN_GAP * 2 + COURSE_STAGE_MIN,
    'the stacking threshold must be the narrowest workspace that fits both minimums, '
    + 'so that moving either minimum moves the threshold with it',
  );
});

test('the coarse keyboard step is larger than the fine one', () => {
  assert.ok(COURSE_RAIL_STEP_COARSE > COURSE_RAIL_STEP,
    'Shift+Arrow must move further than Arrow, or the modifier is a no-op');
});

// ── 2. clampRailWidth ────────────────────────────────────────────────────────

test('clampRailWidth pins to the design bounds', () => {
  assert.equal(clampRailWidth(100), COURSE_RAIL_MIN, 'a drag past the left edge stops at the floor');
  assert.equal(clampRailWidth(9999), COURSE_RAIL_MAX, 'a drag past the right edge stops at the ceiling');
  assert.equal(clampRailWidth(340), 340, 'a width inside the bounds passes through untouched');
});

test('clampRailWidth rounds a sub-pixel drag delta to a whole pixel', () => {
  assert.equal(clampRailWidth(320.6), 321, 'a fractional pointer delta must not reach the DOM');
  assert.equal(clampRailWidth(320.4), 320, 'and it rounds, rather than truncating');
});

test('a NON-NUMERIC width restores the DEFAULT, not the minimum', () => {
  // ★ Number([]) and Number(null) are both 0 — finite — so a bare Number() coercion
  //   would turn structural garbage into COURSE_RAIL_MIN, a layout the learner never
  //   chose and cannot distinguish from one they did.
  for (const bad of [undefined, null, NaN, 'wide', '', '   ', {}, [], true, Infinity, -Infinity]) {
    assert.equal(clampRailWidth(bad), COURSE_RAIL_DEFAULT,
      `clampRailWidth(${JSON.stringify(bad)}) must restore the shipped layout — there is no `
      + 'direction to clamp a non-number toward');
  }
});

test('an out-of-range but FINITE width clamps to the nearest bound', () => {
  // The other half of the rule above: these ARE numbers, so the nearest legal rail is
  // the honest reading of them.
  assert.equal(clampRailWidth(-5), COURSE_RAIL_MIN, 'a negative width clamps to the floor');
  assert.equal(clampRailWidth(0), COURSE_RAIL_MIN, 'zero clamps to the floor');
  assert.equal(clampRailWidth('9999'), COURSE_RAIL_MAX, 'a numeric string is still a number');
});

test('a measured maxAllowed lowers the ceiling but never below the floor', () => {
  assert.equal(clampRailWidth(COURSE_RAIL_MAX, 340), 340,
    'the measured room in this workspace wins over the design maximum');
  assert.equal(clampRailWidth(COURSE_RAIL_MAX, 100), COURSE_RAIL_MIN,
    'a workspace with no room still cannot clamp below the floor — the CSS has stacked by then');
  assert.equal(clampRailWidth(300, NaN), 300,
    'an unmeasurable workspace falls back to the design maximum, not to zero');
});

// ── 3. maxRailWidth — the promise the stage relies on ────────────────────────

test('the stage never drops below COURSE_STAGE_MIN at any two-pane workspace width', () => {
  for (let w = COURSE_TWO_PANE_MIN; w <= 2600; w += 7) {
    const rail = clampRailWidth(COURSE_RAIL_MAX, maxRailWidth(w));   // drag it as wide as it goes
    const stage = w - rail - COURSE_SPLITTER_WIDTH - COURSE_COLUMN_GAP * 2;
    assert.ok(stage >= COURSE_STAGE_MIN,
      `at a ${w}px workspace the widest rail (${rail}px) leaves only ${stage}px of stage`);
  }
});

test('maxRailWidth reaches the design maximum once there is room for it', () => {
  assert.equal(maxRailWidth(workspace(1920, 288)), COURSE_RAIL_MAX,
    '1920x1080 with the sidebar open has room for the widest rail');
  assert.ok(maxRailWidth(COURSE_TWO_PANE_MIN) === COURSE_RAIL_MIN,
    'at exactly the threshold only the minimum rail fits');
});

// ── 4. supportsTwoPane matches the measured chain ───────────────────────────

test('the real workspace widths land on the side of the threshold they should', () => {
  assert.equal(supportsTwoPane(workspace(1440, 288)), true, '1440x900, sidebar open, is two-pane');
  assert.equal(supportsTwoPane(workspace(1920, 288)), true, '1920x1080 is two-pane');
  // ★ This asserted `false` until the threshold moved, and the reason it changed is the
  //   whole point of that change. 1280 CSS px is what a 1920 monitor reports at the 150%
  //   Windows scaling most people run, so "1280 with the sidebar open" is an ordinary
  //   desktop, not a small screen. At 970 it fell just below the threshold and the panel
  //   flipped to an overlay COVERING THE VIDEO — while the very same screen docked
  //   cleanly once the sidebar was collapsed. Reported with screenshots of both states.
  assert.equal(supportsTwoPane(workspace(1280, 288)), true,
    '1280x800 with the sidebar open has 912px of workspace and must DOCK, not overlay — '
    + 'a panel that covers the video on a normal desktop is the defect this threshold fixes');
  assert.equal(supportsTwoPane(workspace(1280, 76)), true,
    'the same 1280px screen with the sidebar collapsed has 1124px and fits two panes — '
    + 'which is exactly why this is a container query and not a media query');
  assert.equal(supportsTwoPane(workspace(1024, 288)), false, '1024x768, sidebar open, stacks');
  assert.equal(supportsTwoPane(390 - 48), false, 'a phone stacks');
  assert.equal(supportsTwoPane(NaN), false, 'an unmeasurable workspace fails closed to stacked');
});

test('the stage at the measured widths clears the acceptance targets', () => {
  assert.ok(stageAt(workspace(1440, 288)) >= 700,
    `1440x900 must give at least a 700px stage, got ${stageAt(workspace(1440, 288))}`);
  assert.ok(stageAt(workspace(1920, 288)) > 1000,
    `1920x1080 must give more than a 1000px stage, got ${stageAt(workspace(1920, 288))}`);
});

// ── 5. lessonUsesMediaStage — the black-frame gate ──────────────────────────

test('a text lesson never gets the black media stage', () => {
  assert.equal(lessonUsesMediaStage({ type: 'text', text_content: 'hi' }), false);
  assert.equal(lessonUsesMediaStage({ type: 'text' }), false,
    'even an EMPTY text lesson — its "No content yet." card must not sit in a video frame');
});

test('a video lesson, and an unknown type, does get it', () => {
  for (const l of [{ type: 'video' }, { type: null }, {}]) {
    assert.equal(lessonUsesMediaStage(l), true,
      'renderVideo treats anything but "text" as the video path; this must agree, or the '
      + 'empty state renders outside the frame and the page jumps between lessons');
  }
});

test('no lesson at all gets no stage', () => {
  for (const l of [null, undefined, 'nope', 42]) {
    assert.equal(lessonUsesMediaStage(l), false, `${JSON.stringify(l)} is not a lesson`);
  }
});

// ── 6. Persistence round-trip ───────────────────────────────────────────────

test('parseLearnerLayout is total — every hostile input yields the defaults', () => {
  for (const bad of [null, undefined, '', '   ', 'not json', '[]', '"str"', '42', 'null', '{']) {
    assert.deepEqual(parseLearnerLayout(bad), { ...DEFAULT_LEARNER_LAYOUT },
      `parseLearnerLayout(${JSON.stringify(bad)}) must not throw and must not return a partial`);
  }
});

test('a stale width from a wider monitor is clamped on the way IN', () => {
  assert.equal(parseLearnerLayout('{"curriculumWidth":900}').curriculumWidth, COURSE_RAIL_MAX,
    'a width stored by a build with different bounds is brought inside this build\'s');
  assert.equal(parseLearnerLayout('{"curriculumWidth":10}').curriculumWidth, COURSE_RAIL_MIN);
  assert.equal(parseLearnerLayout('{"curriculumWidth":0}').curriculumWidth, COURSE_RAIL_MIN,
    'a stored 0 is a real value the clamp decides on, not something ?? should default away');
});

test('curriculumCollapsed is strictly boolean true', () => {
  for (const v of ['true', 1, {}, 'yes', null]) {
    assert.equal(parseLearnerLayout(`{"curriculumCollapsed":${JSON.stringify(v)}}`).curriculumCollapsed,
      false, `${JSON.stringify(v)} is not the boolean true and must not collapse the rail`);
  }
  assert.equal(parseLearnerLayout('{"curriculumCollapsed":true}').curriculumCollapsed, true);
});

test('serialize then parse is a fixed point for any clamped layout', () => {
  for (const w of [COURSE_RAIL_MIN, COURSE_RAIL_DEFAULT, 361, COURSE_RAIL_MAX]) {
    for (const collapsed of [true, false]) {
      const round = parseLearnerLayout(
        serializeLearnerLayout({ curriculumWidth: w, curriculumCollapsed: collapsed }));
      assert.deepEqual(round, { curriculumWidth: w, curriculumCollapsed: collapsed },
        `a ${w}px rail (collapsed=${collapsed}) must survive a storage round-trip unchanged`);
    }
  }
});

test('serializeLearnerLayout stamps a version and clamps a bad in-memory value', () => {
  const out = JSON.parse(serializeLearnerLayout({ curriculumWidth: -5 }));
  assert.equal(out.v, COURSE_LAYOUT_VERSION, 'the stored shape must carry its version');
  assert.equal(out.curriculumWidth, COURSE_RAIL_MIN,
    'a negative in-memory width is still a number, so it clamps to the floor rather than '
    + 'being written to storage and read back as gospel');
  assert.equal(JSON.parse(serializeLearnerLayout({ curriculumWidth: {} })).curriculumWidth,
    COURSE_RAIL_DEFAULT, 'structural garbage restores the default');
  assert.equal(JSON.parse(serializeLearnerLayout(null)).curriculumWidth, COURSE_RAIL_DEFAULT);
});

// ── 7. The CSS and the JS have not drifted ──────────────────────────────────
//
// ★ THIS IS THE POINT OF THE SUITE. The container query, the grid template's backstop
//   and the stage's viewport cap are all written in CSS by hand. Nothing else in the
//   repo notices when one stops agreeing with the constant the drag clamp uses, and
//   the symptom — a 200px video after a window resize — reproduces only in one narrow
//   band of workspace widths.

test('the @container threshold in index.css equals COURSE_TWO_PANE_MIN', () => {
  const m = /@container coursework \(min-width:\s*(\d+)px\)/.exec(css());
  assert.ok(m, 'the course workspace container query is missing from src/index.css');
  assert.equal(Number(m[1]), COURSE_TWO_PANE_MIN,
    'the CSS stacking threshold and the JS one must be the same number');
});

test('the .course-workspace custom properties equal the JS constants', () => {
  const sheet = css();
  const start = sheet.indexOf('.course-workspace {');
  assert.ok(start > 0, '.course-workspace is missing from src/index.css');
  const block = sheet.slice(start, sheet.indexOf('}', start));
  for (const [prop, want] of [
    ['--course-splitter-w', COURSE_SPLITTER_WIDTH],
    ['--course-col-gap', COURSE_COLUMN_GAP],
    ['--course-stage-min', COURSE_STAGE_MIN],
    ['--course-rail', COURSE_RAIL_DEFAULT],
  ]) {
    assert.match(block, new RegExp(`${prop}:\\s*${want}px`),
      `${prop} must be ${want}px to match the JS constant the drag clamp uses`);
  }
});

test('the grid template clamps to the same rail bounds the drag does', () => {
  assert.match(
    css(),
    new RegExp(`clamp\\(\\s*${COURSE_RAIL_MIN}px\\s*,\\s*var\\(--course-rail\\)\\s*,\\s*${COURSE_RAIL_MAX}px\\s*\\)`),
    'the CSS backstop must use the same bounds as clampRailWidth, or a stored width '
    + 'renders at one size while aria-valuenow reports another',
  );
});

test('the stage caps its WIDTH, never its height', () => {
  const sheet = css();
  const start = sheet.indexOf('.course-stage {');
  assert.ok(start > 0, '.course-stage is missing from src/index.css');
  // Comments stripped first: the block's own prose explains why max-height is wrong
  // here, and a naive scan would match that explanation and fail on the right answer.
  const block = sheet.slice(start, sheet.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(block, new RegExp(`min\\(\\s*${COURSE_STAGE_MAX_VH}vh\\s*,\\s*${COURSE_STAGE_MAX_PX}px\\s*\\)`),
    'the stage must carry the viewport budget these constants describe');
  assert.match(block, /aspect-ratio:\s*16\s*\/\s*9/, 'the frame is 16:9');
  assert.ok(!/max-height/.test(block),
    'a max-height on a 16:9 frame leaves it full-width and pillarboxes the video inside '
    + 'black bars it does not need — which is exactly what maxHeight: 460 would have done '
    + 'had the box ever grown wide enough to bind. Cap the width; let the ratio derive the height.');
});

// ── 8. The app wires it up ──────────────────────────────────────────────────

test('the layout preference key is the one this module owns', () => {
  assert.equal(COURSE_LAYOUT_STORAGE_KEY, 'course:learnerLayout:v1');
  // assert.ok, not assert.match: a failed match against a 2MB source dumps the whole
  // file into the test output and buries every other failure with it.
  assert.ok(/COURSE_LAYOUT_STORAGE_KEY/.test(app()),
    'the app must read the exported key, not retype the literal');
});

test('the layout key is NOT in LEGACY_KEYS', () => {
  const auth = readFileSync(join(REPO, 'src/auth/AuthProvider.jsx'), 'utf8');
  assert.ok(!auth.includes('course:learnerLayout'),
    'LEGACY_KEYS is a one-shot pre-auth adoption list and no global value for this key has '
    + 'ever existed; CLAUDE.md forbids course keys in it');
});

test('the persisted width is never written from a pointermove', () => {
  const src = app();
  const i = src.indexOf('function dragRail');
  assert.ok(i > 0, 'dragRail was not found — re-point this ratchet');
  const body = src.slice(i, src.indexOf('\n  }', i));
  assert.ok(!/setRailWidth|window\.storage/.test(body),
    'the pointermove path must only touch the CSS custom property through a ref. A setState '
    + 'here re-renders the whole CourseProgram — every lesson button, the progress card and '
    + 'the player subtree — once per pointer pixel.');
  assert.ok(/requestAnimationFrame/.test(body),
    'the custom-property write must be rAF-throttled');
});
