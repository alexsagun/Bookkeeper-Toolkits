// ─────────────────────────────────────────────────────────────────────────────
// UI safety ratchets, from the 2026-08-31 full-stack audit.
//
// These are source/artifact scans in the house idiom (test/studentProgress.test.mjs
// reads BookkeeperPro.jsx as text). They exist because each one names a defect that
// actually shipped, or a rule the repo already wrote down and then broke anyway.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = () => readFileSync(join(REPO, 'src/BookkeeperPro.jsx'), 'utf8');
const css = () => readFileSync(join(REPO, 'src/index.css'), 'utf8');

// ── 1. The built bundle, not just the source ────────────────────────────────
//
// test/studentProgress.test.mjs already pins that the SOURCE routes completion
// through the RPCs. That check would have passed throughout the incident this
// ratchet is named after: on 2026-08-31 migration #52 had been applied to the live
// database — revoking insert/update/delete on these three tables from
// `authenticated` — while the DEPLOYED bundle still called
// `from("lesson_progress").upsert(...)` and contained zero references to
// `complete_course_lesson`. lesson_progress held 0 rows. The source was fine; the
// artifact was a migration behind. So scan the artifact too.
test('the built bundle never writes the completion tables directly', () => {
  const dist = join(REPO, 'dist', 'assets');
  if (!existsSync(dist)) return; // nothing built in this checkout — nothing to police
  const bundles = readdirSync(dist).filter((f) => f.endsWith('.js'));
  assert.ok(bundles.length > 0, 'dist/assets exists but contains no JS');

  let sawRpc = false;
  for (const file of bundles) {
    const code = readFileSync(join(dist, file), 'utf8');
    for (const table of ['lesson_progress', 'course_completions', 'feature_video_completions']) {
      // minified output keeps the string literal and the method name
      const direct = new RegExp(`from\\(["']${table}["']\\)\\s*\\.\\s*(insert|update|upsert|delete)`);
      assert.ok(!direct.test(code),
        `${file}: the built bundle writes ${table} directly. #52 revoked that grant from `
        + '`authenticated`, so this build records no progress at all once deployed. Rebuild from a '
        + 'tree that routes completion through complete_course_lesson().');
    }
    if (/complete_course_lesson/.test(code)) sawRpc = true;
  }
  assert.ok(sawRpc,
    'no built bundle references complete_course_lesson() — this dist/ predates #52 and would '
    + 'silently stop recording lesson completions if deployed against the current database');
});

// ── 2. Fixed overlays inside a tab ──────────────────────────────────────────
//
// CLAUDE.md: "Any fixed overlay rendered inside a tab MUST go through OverlayPortal."
// The reason is measurable: .fade-in (src/index.css) animates transform with
// `forwards`, so the active TabPanel keeps a non-none transform permanently and
// becomes the containing block for every position:fixed descendant. A
// `fixed inset-0` click-catcher rendered inside a tab is therefore laid out against
// the PANEL, not the viewport. Measured on CourseCatalog's ⋮ menu before this was
// fixed: catcher rect x=288 w=738 h=666 in a 1036x550 viewport — it missed the whole
// sidebar, so clicking the nav did not dismiss the menu.
//
// This is a counted ratchet, not a ban: the app shell legitimately has fixed
// overlays OUTSIDE any tab (the mobile sidebar scrim).
test('no click-outside catcher is rendered as a bare fixed overlay inside a tab', () => {
  const source = app();
  const catchers = source.match(/className="fixed inset-0 z-40[^"]*"/g) || [];
  // The one permitted match is the mobile sidebar scrim, rendered by the root shell
  // (a direct child of the app layout, never inside a TabPanel) and visually filled.
  const shellScrim = catchers.filter((c) => /bg-black\/40/.test(c));
  const bare = catchers.filter((c) => !/bg-black\/40/.test(c));
  assert.equal(bare.length, 0,
    'a bare `fixed inset-0` catcher is back. Inside a tab it anchors to the .fade-in '
    + 'panel instead of the viewport and will not cover the sidebar. Use the document-level '
    + 'pointerdown idiom (see CourseCatalog) or render it through OverlayPortal. Found: '
    + bare.join(' | '));
  assert.equal(shellScrim.length, 1, 'expected exactly one app-shell scrim');
});

test('the CourseCatalog action menu dismisses via the document-level pointerdown idiom', () => {
  const source = app();
  assert.match(source, /document\.addEventListener\('pointerdown', onDown\)/,
    'the ⋮ menu needs a document-level outside-click listener');
  assert.match(source, /\[data-course-menu\]/,
    'the outside-click test keys off [data-course-menu]');
});

// ── 3. White text on the brand blue ─────────────────────────────────────────
//
// --c-primary (#0A84FF) is deliberately identical in both themes. White text on it
// measures 3.65:1 — below the WCAG AA 4.5:1 floor for text under 18.66px bold, which
// is every button in this app. Lighthouse flagged it on the Progress "Continue
// learning" CTA; it applied to 9 filled controls. --primary-solid (#0070E0) is 4.78:1.
const relLum = (hex) => {
  const p = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
};
const contrastWithWhite = (hex) => 1.05 / (relLum(hex) + 0.05);

test('--primary-solid exists and clears WCAG AA against white text', () => {
  const m = /--primary-solid:\s*(#[0-9A-Fa-f]{6})/.exec(css());
  assert.ok(m, '--primary-solid is missing from src/index.css');
  const ratio = contrastWithWhite(m[1]);
  assert.ok(ratio >= 4.5,
    `--primary-solid (${m[1]}) is ${ratio.toFixed(2)}:1 against white — WCAG AA needs 4.5:1`);
});

test('--c-primary is still the accent colour and still fails behind white text', () => {
  // Guards the reason --primary-solid exists. If someone "simplifies" by pointing
  // --primary-solid back at --c-primary, this fails loudly.
  const m = /--c-primary:\s*(#[0-9A-Fa-f]{6})/.exec(css());
  assert.ok(m, '--c-primary is missing');
  assert.ok(contrastWithWhite(m[1]) < 4.5,
    '--c-primary now passes AA against white; if that is deliberate, delete --primary-solid '
    + 'and this test together rather than leaving two blues that mean the same thing');
});

test('no filled control pairs white text with the accent blue', () => {
  const source = app();
  const bad = [
    /background: C\.primary, color: 'white'/,
    /background: C\.primary, color: '#fff'/,
    /text-white"[^>]*style=\{\{ background: C\.primary \}\}/,
  ];
  for (const re of bad) {
    assert.ok(!re.test(source),
      'a filled control uses C.primary behind white text (3.65:1). Use C.primarySolid.');
  }
  assert.match(source, /primarySolid: 'var\(--primary-solid\)'/,
    'C.primarySolid must be exposed on the design-token object');
});

// ── 4. The welcome modal ────────────────────────────────────────────────────
//
// It portals correctly but shipped without any dialog semantics: measured 1 focusable
// inside and 28 still reachable behind the scrim, role/aria-modal null, and
// document.activeElement left on <body>. It is the first screen a new user sees.
test('WelcomeOverlay carries the house dialog contract', () => {
  const source = app();
  const start = source.indexOf('function WelcomeOverlay');
  assert.ok(start > 0, 'WelcomeOverlay not found');
  const body = source.slice(start, start + 6000);
  assert.match(body, /role="dialog"/, 'WelcomeOverlay needs role="dialog"');
  assert.match(body, /aria-modal="true"/, 'WelcomeOverlay needs aria-modal="true"');
  assert.match(body, /aria-labelledby="welcome-overlay-title"/, 'WelcomeOverlay needs an accessible name');
  assert.match(body, /panelRef\.current\?\.focus\(\)/, 'focus must move into the dialog');
  assert.match(body, /e\.key === 'Escape'/, 'Escape must close it');
  assert.match(body, /e\.key !== 'Tab'/, 'it needs the house Tab focus-trap');
});

// ── 5. Lesson video embeds ──────────────────────────────────────────────────
test('YouTube lesson embeds use the no-cookie host', () => {
  const source = app();
  assert.match(source, /youtube-nocookie\.com\/embed\//,
    'parseVideoUrl should build a youtube-nocookie embed URL');
  assert.ok(!/https:\/\/www\.youtube\.com\/embed\//.test(source),
    'a plain youtube.com embed is back — a paid lesson page then contacts '
    + 'googleads.g.doubleclick.net and the youtubei logging endpoints');
});
