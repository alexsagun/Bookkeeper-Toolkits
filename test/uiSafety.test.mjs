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
import { rowDisplayState } from '../src/lib/legacyMigration.js';
import { agreementModel } from '../src/lib/trainingAgreement.js';
import { ENROLLMENT_PLANS_FALLBACK } from '../src/lib/planCatalog.js';
import {
  LESSON_VIDEO_BUCKET, LESSON_VIDEO_SIGN_TTL_SECONDS, buildLessonVideoPath, isLessonVideoPath,
  LESSON_VIDEO_MAX_BYTES, UPLOAD_ERROR_MESSAGES, UPLOAD_EVENTS, UPLOAD_STATES, blocksLessonSave, formatBytes, validateVideoFile,
  lessonVideoPayload, formatMediaDuration,
} from '../src/lib/courseVideo.js';
import {
  ONBOARDING_VIDEO_BUCKET, buildOnboardingVideoPath, gettingStartedEnrollPhase, gettingStartedFailedBeforePass,
  gettingStartedGateInput, gettingStartedStatus, gettingStartedNeedsReask, onboardingHealth, onboardingVideoPathVideoId,
} from '../src/lib/gettingStarted.js';
import { enrollGateState } from '../src/lib/enrollGate.js';
import { ADMIN_TAB_PERMISSION, EMPTY_STAFF_CONTEXT, staffBypassesPaywall } from '../src/lib/staffRoles.js';
import { GATE_SCREENS, resolveGateScreen } from '../src/lib/gateScreen.js';
import { APP_ERROR_COPY, appErrorCode, appErrorContext, appErrorMessage, isMigrationMissing } from '../src/lib/appErrors.js';
import { extractPureLiteral } from '../src/lib/voiceKnowledge.js';

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

// ── 6. The lesson-video upload bearer ───────────────────────────────────────
//
// Raising the project-wide Storage ceiling to 2 GiB made hour-long transfers possible
// for the first time, which made a 1-hour access token expiring MID-upload reachable.
// The fix attaches the bearer per request via tus's onBeforeRequest.
//
// ★ THIS IS UNREACHABLE FROM A UNIT TEST, WHICH IS WHY IT IS A SOURCE SCAN.
//   tus's browser stack calls XMLHttpRequest.setRequestHeader(), and per spec that
//   COMBINES repeated header names instead of replacing them. options.headers is applied
//   in createRequest() BEFORE sendRequest() awaits onBeforeRequest, so declaring
//   `authorization` in BOTH places sends `Bearer <stale>, Bearer <fresh>` and Storage
//   rejects every single request. Nothing in node --test can observe that, and putting
//   the header back into `headers` is the obvious-looking tidy-up.
test('the lesson-video upload attaches its bearer per request, and from exactly one place', () => {
  const source = app();
  const start = source.indexOf('new tus.Upload(');
  assert.ok(start > 0, 'the tus upload call was not found');
  const region = source.slice(start, start + 4000);

  assert.match(region, /onBeforeRequest:/,
    'the bearer must be refreshed per request, or a 2 GB upload dies when the JWT expires');
  assert.match(region, /req\.setHeader\('authorization'/,
    'onBeforeRequest must actually set the header it exists to refresh');

  // Brace-match the headers object so this reads the real block, not a nearby line.
  const h = region.indexOf('headers: {');
  assert.ok(h > 0, 'the tus options carry no headers block');
  let depth = 0;
  let end = h;
  for (let i = region.indexOf('{', h); i < region.length; i += 1) {
    if (region[i] === '{') depth += 1;
    else if (region[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(depth === 0 && end > h,
    'could not brace-match the headers block — the scan below would pass vacuously');
  const headers = region.slice(h, end + 1);

  // Match an object PROPERTY, not the bare word: the block deliberately explains why
  // authorization is absent, and a ratchet that trips on its own explanation is noise.
  // A comment line starts with //, so it can never satisfy the property pattern. The
  // optional quotes matter: 'authorization': and "authorization": are ordinary style for
  // a header object, and without them the ratchet would wave through the exact regression
  // it exists to catch.
  // Strip comments first: this block deliberately EXPLAINS why authorization is absent,
  // and with the [,{] alternation below a prose example could otherwise trip it.
  const headerCode = headers.replace(/\/\/.*$/gm, '');
  // `^` alone would miss the single-line form `headers: { authorization: … }` and a
  // trailing `, "authorization": …` — both of which reintroduce the duplicate header.
  assert.ok(!/(?:^|[,{])\s*['"]?authorization['"]?\s*:/im.test(headerCode),
    'authorization is declared in BOTH options.headers and onBeforeRequest. XHR combines '
    + 'repeated header names, so every request would go out as "Bearer <stale>, Bearer '
    + '<fresh>" and Storage would 401 all of them. Set it ONLY in onBeforeRequest.');
});

// ── 6b. The refresh falls back to the LAST GOOD bearer, not the first one ───
//
// The 5s race exists so a stalled auth endpoint cannot freeze the upload. But its
// fallback has to be the freshest bearer that actually WORKED, not the one captured
// before the transfer began. On a two-hour upload the original is certainly expired:
// the refresh at ~55min replaced it. Falling back to it sends a token we KNOW is dead,
// and tus does not retry the 400 category, so the upload ends there — on exactly the
// long transfers raising the ceiling made possible.
//
// Unreachable from a unit test (it needs a real tus request and a stalled endpoint),
// so the shape is pinned here.
test('the upload bearer falls back to the last known-good token', () => {
  const src = app();
  const start = src.indexOf('new tus.Upload(');
  assert.ok(start > 0, 'could not find the tus.Upload options object');
  const region = src.slice(start, start + 4000);
  const obr = region.indexOf('onBeforeRequest:');
  assert.ok(obr > 0, 'could not find the onBeforeRequest property');
  const block = region.slice(obr, obr + 900);

  assert.match(block, /lastGood/,
    'onBeforeRequest must fall back to the last known-good bearer');
  assert.ok(block.includes('Bearer ${lastGood}'),
    'the header must be set from lastGood, not from a per-call temporary');
  assert.ok(!block.includes('Bearer ${token}'),
    'falling back to the bearer captured at t=0 sends a token known to be expired on '
    + 'any transfer longer than its lifetime');
  assert.match(src, /let lastGood = token;/,
    'lastGood must live OUTSIDE the callback, or each request resets it and the '
    + 'fallback is per-call rather than cumulative');
});

// ── 7. Resume is not offered for failures that cannot be resumed ────────────
//
// runTransfer's catch emits INTERRUPT for every non-abort reason, and INTERRUPTED
// renders a Resume button whose handler re-enters runTransfer. For a 413 (the project
// ceiling), a 403 (role) or a 404 (missing bucket) that re-sends the identical request
// and takes the identical status — so the UI invited an admin to burn another 6 MiB
// confirming a verdict the message had already given them. describeUploadError now
// returns `retryable`; the button must consult it.
test('the uploader never offers Resume on a failure the pure module called permanent', () => {
  const source = app();
  // Anchor on the button itself: 'UPLOAD_STATES.PAUSED' also appears in showBar.
  const i = source.indexOf('onClick={resume}');
  assert.ok(i > 0, 'the Resume button was not found');
  const region = source.slice(Math.max(0, i - 900), i + 200);
  assert.match(region, /UPLOAD_STATES.INTERRUPTED/, 'wrong region — INTERRUPTED not in it');
  // Anchor on the actual expression, not the bare token: /retryable/ alone could not
  // distinguish `INTERRUPTED && retryable` from `INTERRUPTED && !retryable`, and would
  // also pass on an unrelated mention nearby.
  assert.match(region, /UPLOAD_STATES\.INTERRUPTED\s*&&\s*retryable/,
    'Resume must be gated on describeUploadError().retryable for INTERRUPTED');
  assert.match(region, /state === UPLOAD_STATES\.PAUSED/,
    'PAUSED must stay unconditional — pausing is not a failure');
});

// ── 12. Every admin screen fences its verdict behind staffDegraded/staffReady ──
//
// The house idiom is `staffDegraded ? !!profile?.is_admin : (staffReady && can(...))`.
// AccessRequests — the screen that approves and rejects accounts — instead carried a bare
// `can('access_requests.review') || !!profile?.is_admin`, whose second arm fired
// unconditionally rather than only when the staff context is degraded, and which never
// waited for staffReady. It therefore rendered off the legacy profiles.is_admin cache
// regardless of what my_staff_context() actually said.
//
// Also pins the other half of that bug: a component that READS staffDegraded must
// destructure it from useAuth(), or it throws ReferenceError at render — which the build
// cannot see and no unit test reaches, because this repo has no jsdom.
test('admin verdicts are fail-closed, and staffDegraded is always in scope', () => {
  const src = app();

  const bare = src.match(/const\s+\w+\s*=\s*can\('[a-z_.]+'\)\s*\|\|\s*!!?profile\?\.is_admin/g) || [];
  assert.equal(bare.length, 0,
    `a bare \`can(...) || is_admin\` admin verdict is back: ${bare.join(' / ')}. The second arm `
    + 'must be reachable only when staffDegraded, and the first must wait for staffReady.');

  // Split on top-level component declarations and check each one that mentions staffDegraded.
  const lines = src.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (/^(?:function|const)\s+[A-Z][A-Za-z0-9_]*/.test(l)) starts.push(i); });
  const missing = [];
  starts.forEach((start, n) => {
    const body = lines.slice(start, starts[n + 1] ?? lines.length).join('\n');
    if (!/\bstaffDegraded\b/.test(body)) return;
    if (!/const\s*\{[^}]*\bstaffDegraded\b[^}]*\}\s*=\s*useAuth\(\)/.test(body)) {
      missing.push((lines[start].match(/[A-Z][A-Za-z0-9_]*/) || ['?'])[0]);
    }
  });
  assert.deepEqual(missing, [],
    `these components read staffDegraded without destructuring it from useAuth(), which is a `
    + 'ReferenceError at render that the build cannot catch');
});

// ── 13. A verification TIMEOUT must never be reported as a bad file ────────────
//
// This is the third time this repo has blamed the admin's file for something the app
// did. 95bd53d fixed it for the 413 ("stop blaming the admin's file") and left a
// standing comment in courseVideo.js that there must never again be a 'too-large'
// upload reason. The identical mistake then survived one state later, in verification:
//
//   setErrMsg(e?.message === 'timeout' || e?.code === 3
//     ? 'The file uploaded, but the browser could not read it back as video.
//        Re-export it as MP4 (H.264 + AAC) and upload again.'
//     : '...')
//
// A timeout and a decode failure are not the same event and do not have the same
// remedy. Measured on this project's Storage, the cold read of a freshly uploaded
// 859 MB lesson took ~50 s against a 20 s budget — so the check timed out every time,
// and the admin was told to spend hours re-encoding a file whose encoding was not what
// stopped it, then re-upload gigabytes into the same wall, orphaning an object per pass.
//
// No unit test can reach this branch: it needs a real MediaError from a real <video>
// against a real signed URL. So the SHAPE is pinned here instead. Mutation-tested:
// putting `e?.message === 'timeout'` back into the re-encode branch fails this.
test('a verification timeout is never answered with re-encode advice', () => {
  const src = app();
  const i = src.indexOf('function describeVerifyFailure');
  assert.ok(i > 0, 'describeVerifyFailure was not found — verification error copy must stay centralised');
  const end = src.indexOf('\n  }', src.indexOf('return \'The file uploaded, but it could not be authorized', i));
  assert.ok(end > i, 'could not delimit describeVerifyFailure');
  const body = src.slice(i, end);

  // The timeout arm exists, and says the bytes are safe rather than accusing the file.
  const timeoutArm = /e\?\.message === 'timeout'\)?\s*\{([\s\S]*?)\n    \}/.exec(body);
  assert.ok(timeoutArm, 'no timeout branch found in describeVerifyFailure');
  assert.doesNotMatch(timeoutArm[1], /re-encode|re-export|H\.264|AAC/i,
    'the timeout branch must not tell the admin to re-encode: the file uploaded fine and '
    + 'the encoding is not what timed out');
  assert.match(timeoutArm[1], /saved|uploaded/i,
    'the timeout branch must reassure the admin the bytes are not lost');

  // Re-encode advice is allowed in exactly one place: a genuine format rejection, which
  // the browser reports as MEDIA_ERR_SRC_NOT_SUPPORTED (4). The old code tested code 3
  // and never 4, so it could not detect the one case it actually named.
  assert.match(body, /e\?\.code === 4/,
    'SRC_NOT_SUPPORTED (4) is the code a real format rejection produces and must be handled');
  assert.match(body, /e\?\.code === 3/, 'DECODE (3) must stay distinct from a format rejection');
  const reencodeArms = body.split('\n').filter((l) => /re-encode/i.test(l));
  assert.ok(reencodeArms.length >= 1, 'a genuine format rejection should still advise re-encoding');
});

// ── 14. "Check again" must reuse its signed URL ────────────────────────────────
//
// Supabase Storage sits behind a CDN keyed on the FULL url, and re-signing changes the
// query string. Measured on the 859 MB lesson: a cold tail range took 49.4 s, the SAME
// signed url again took 1.9 s (CDN HIT), and a NEWLY signed url took 52.1 s — a fresh
// MISS. Minting a URL per attempt is why pressing "Check again" could never succeed no
// matter how many times it was pressed, which is exactly what the bug report showed.
test('the verification retry reuses its signed URL instead of minting a cold one', () => {
  const src = app();
  assert.match(src, /signedRef\s*=\s*useRef\(null\)/,
    'the signed URL must be cached across attempts');
  const i = src.indexOf('async function signedUrlFor');
  assert.ok(i > 0, 'signedUrlFor was not found');
  const body = src.slice(i, i + 900);
  assert.match(body, /cached\.path === path/,
    'a cached URL may only be reused for the SAME object path');
  assert.match(body, /LESSON_VIDEO_RESIGN_MARGIN_MS/,
    'reuse must stop before the TTL expires, not at it');

  // And verification must go through it, not straight to signLessonVideo.
  const v = src.indexOf('async function verifyPrivateObject');
  assert.ok(v > 0, 'verifyPrivateObject was not found');
  const vb = src.slice(v, v + 1200);
  assert.match(vb, /signedUrlFor\(path\)/, 'verification must use the cached signer');
  assert.doesNotMatch(vb, /await signLessonVideo\(/,
    'calling signLessonVideo directly here re-mints per attempt and guarantees a cold CDN miss');
});

// ── 15. The entitlement can never be nullish ────────────────────────────────
//
// On 2026-09-03 production blanked to a white page for the account that owns it:
//
//   TypeError: Cannot read properties of null (reading 'allowsTab')
//
// staffEntitlement(ctx, base) returned its null `base` verbatim for a Super Admin,
// the root calls it as `staffEntitlement(staff, enrollPass ? … : null)`, and
// enrollPass is PERMANENTLY false for a Super Admin (no subscriptions row). The
// null became `entitlement` and was dereferenced in the COMPONENT BODY, ~800 lines
// above the gate that would have rendered a splash — with no ErrorBoundary
// anywhere, React emptied #root.
//
// The unit test in staffRoles.test.mjs pins the pure function. This pins the CALL
// SITE, because the dangerous part is not the null — it is what a future fixer
// reaches for as a "safe" default.
test('the root never lets a nullish entitlement reach the render', () => {
  const src = app();
  const call = src.indexOf('staffEntitlement(staff,');
  assert.ok(call > 0, 'the root no longer calls staffEntitlement — re-point this ratchet');

  // Strip `//` comments before asserting: this block DOCUMENTS the two forbidden
  // fallbacks by name, so a naive scan matches its own warning.
  // Split on /\r?\n/ and anchor-free: this repo's sources are CRLF, and `.` does
  // not match \r, so a `//.*$` strip silently does nothing on a CRLF line.
  const window = src.slice(call, call + 1800)
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*/, '')).join('\n');

  assert.ok(/if \(!resolved\)/.test(window),
    'the memo must test staffEntitlement()\'s result before returning it — a nullish '
    + 'entitlement is a blank white page, not a degraded render');

  // ★ THE ACTUAL TRAP. For a non-super staff member planKey is null, and
  //   planEntitlement(null) returns FULL via NO_PLAN_SENTINELS. So both of the
  //   obvious fallbacks silently hand a Trainer the whole paid toolkit.
  assert.ok(!/\|\|\s*FULL_ENTITLEMENT/.test(window),
    'the fallback must not be `|| FULL_ENTITLEMENT` — that grants a Trainer full access');
  assert.ok(!/resolved\s*\|\|\s*planEntitlement/.test(window),
    'the fallback must not be `|| planEntitlement(planKey)` — planEntitlement(null) IS full');
  assert.ok(/NO_ACCESS_ENTITLEMENT/.test(window),
    'the non-super fallback must fail CLOSED, via NO_ACCESS_ENTITLEMENT');
});

// ── 16. The app has an error boundary ───────────────────────────────────────
//
// Without one, ANY uncaught render error unmounts the whole tree and leaves #root
// empty — a blank page with no message and no way back, which is exactly how the
// crash above presented. The boundary must sit OUTSIDE AuthProvider so a crash in
// the provider itself is still caught.
test('the app is wrapped in an error boundary, outside AuthProvider', () => {
  const main = readFileSync(join(REPO, 'src/main.jsx'), 'utf8');
  assert.ok(/<AppErrorBoundary>/.test(main), 'main.jsx must mount the error boundary');

  const b = main.indexOf('<AppErrorBoundary>');
  const p = main.indexOf('<AuthProvider>');
  assert.ok(b > 0 && p > 0 && b < p,
    'the boundary must wrap AuthProvider, not sit inside it — a provider crash '
    + 'blanks the page just as thoroughly as a component one');

  const boundary = readFileSync(join(REPO, 'src/AppErrorBoundary.jsx'), 'utf8');
  assert.ok(/getDerivedStateFromError/.test(boundary),
    'a boundary without getDerivedStateFromError renders nothing on a crash');
  // ★ It must not import the 35k-line monolith: the safety net would then share
  //   every module-scope hazard of the thing it is catching.
  assert.ok(!/from '\.\/BookkeeperPro/.test(boundary),
    'the error boundary must not import BookkeeperPro.jsx');
});

// ── 17. "/" is the Dashboard ────────────────────────────────────────────────
//
// A `nav:lastTab` restore effect used to redirect the bare root URL to whatever tab
// the user last opened, and rewrite the address bar with replaceState while doing
// it. Its entitlement guard was inert (deps were [user?.id], so it closed over a
// FULL entitlement resolved before the plan had loaded), and its sibling writer
// persisted the tab on the FIRST commit — so a single deep-link visit permanently
// made "/" open that course. Both effects are gone; keep them gone.
test('the bare root URL is not silently redirected to a remembered tab', () => {
  const src = app();
  assert.ok(!/nav:lastTab['"]\s*\)/.test(src),
    'nothing may read or write nav:lastTab — "/" resolves to DEFAULT_APP_TAB');
  assert.ok(!/window\.storage\.get\(['"]nav:lastTab/.test(src));
  assert.ok(!/window\.storage\.set\(['"]nav:lastTab/.test(src));

  const legacy = readFileSync(join(REPO, 'src/auth/AuthProvider.jsx'), 'utf8');
  const keys = legacy.slice(legacy.indexOf('LEGACY_KEYS'), legacy.indexOf('LEGACY_MARKER'));
  assert.ok(!/^\s*'nav:lastTab'/m.test(keys),
    'a retired key must not stay in LEGACY_KEYS — migrating it would adopt dead data');
});

// ── 18. The lesson player is never re-parented ──────────────────────────────
//
// Theater mode and the resizable rail are CSS. If either ever becomes a second JSX
// branch, React unmounts the <video> and mounts a new one: the learner loses their
// place, and an uploaded lesson mints a fresh signed URL and re-buffers from zero.
// There is no jsdom in this repo, so nothing in node --test can observe that
// happening — the shape is pinned here instead.
test('closing the curriculum is CSS, not a second render branch', () => {
  const src = app();
  assert.ok(/course-workspace mt-6\$\{curriculumCollapsed \? ' is-rail-closed' : ''\}/.test(src),
    'open/closed must be ONE class on the workspace. A `curriculumCollapsed ? <A/> : <B/>` '
    + 'branch around the player remounts <video> on every toggle.');
  assert.ok(/\.course-workspace\.is-rail-closed \.course-rail/.test(css()),
    'the collapse must be a display rule on the RAIL, in src/index.css');
  // display, not visibility: a visibility-hidden rail is still laid out, and focus
  // inside a curriculum nobody can see is exactly the trap this avoids.
  const closed = css().slice(css().indexOf('.course-workspace.is-rail-closed'));
  assert.ok(/display:\s*none/.test(closed.slice(0, 260)),
    'the collapsed rail must be display:none so it leaves the tab order');
});

// The narrow layout must OVERLAY the player, never stack under it. Stacking is what
// appended ~2000px of lesson list to the page and produced the endless scrolling this
// panel replaced — and it is a one-line CSS regression to reintroduce.
test('a narrow workspace overlays the curriculum instead of stacking it', () => {
  const sheet = css();
  const base = sheet.slice(sheet.indexOf('.course-grid {'), sheet.indexOf('@container coursework'));
  assert.ok(/\.course-grid > \.course-rail\s*\{[^}]*grid-area:\s*1\s*\/\s*1/s.test(base),
    'outside the container query the rail must share the stage\'s grid cell — a second '
    + 'grid ROW is the stacked layout that made a 42-lesson course unscrollable');
  assert.ok(/\.course-grid > \.course-stage-col\s*\{[^}]*grid-area:\s*1\s*\/\s*1/s.test(base),
    'the stage must hold that same cell, at full width');
  assert.ok(/position:\s*sticky/.test(base.slice(base.indexOf('.course-grid > .course-rail'))),
    'the overlay panel must be sticky, or it scrolls away the moment the page moves');
});

// The header used to be `position: sticky; top: 0` with a transparent background inside
// the rail's own scroller, so the lesson list scrolled visibly THROUGH it — "COURSE
// CONTENT" and "Lesson 1.1…" painted over each other. CLAUDE.md already forbade the shape
// ("a drawer never needs `sticky top-0` … those only ever worked by accident inside a
// single scroller") and it shipped anyway, so pin it.
test('the rail header is a flex row, not a sticky box over its own scroller', () => {
  const sheet = css();
  const head = sheet.slice(sheet.indexOf('.course-rail-head {'));
  const block = head.slice(0, head.indexOf('}'));
  assert.ok(!/position:\s*sticky/.test(block),
    'the header must not be sticky — inside the rail\'s scroller the list passes under it, '
    + 'and it was the only sticky header in this sheet without an opaque backdrop');
  assert.ok(/flex:\s*0 0 auto/.test(block),
    'the header must be a non-shrinking flex row of the rail');
  const body = sheet.slice(sheet.indexOf('.course-rail-body {'));
  const bodyBlock = body.slice(0, body.indexOf('}'));
  assert.ok(/overflow-y:\s*auto/.test(bodyBlock) && /min-height:\s*0/.test(bodyBlock),
    '.course-rail-body must be the ONLY scroller, and needs min-height:0 or a flex item '
    + 'refuses to shrink below its content and overflows the rail instead of scrolling');
  // The rail itself must have stopped scrolling, or both would scroll and the header
  // would drift again.
  const railWide = sheet.slice(sheet.indexOf('.course-grid > .course-rail {'));
  assert.ok(/display:\s*flex/.test(railWide.slice(0, railWide.indexOf('}'))),
    'the rail must be the flex column that holds the header and the body');
});

test('the edge tab keeps a static accessible name', () => {
  const src = app();
  const i = src.indexOf('className="course-rail-tab"');
  assert.ok(i > 0, 'the edge tab was not found');
  const tag = src.slice(i - 400, i + 400);
  assert.ok(/aria-label="Show course content"/.test(tag),
    'the visible label is a hover reveal and must never BE the accessible name — a control '
    + 'whose name appears only on hover has no name for anyone not hovering');
  assert.ok(/aria-expanded=\{!curriculumCollapsed\}/.test(tag), 'the tab must report its state');
  // The reveal is width-based; `display: none` on the label would drop it from the
  // accessibility tree entirely on the browsers that honour that.
  assert.ok(/\.course-rail-tab-label\s*\{[^}]*max-width:\s*0/s.test(css()),
    'the label must collapse by width, not by display');
});

test('all three SignedLessonVideo states share one media stage frame', () => {
  const src = app();
  const i = src.indexOf('function SignedLessonVideo');
  assert.ok(i > 0, 'SignedLessonVideo was not found');
  // ★ THE WINDOW IS THE NEXT TOP-LEVEL FUNCTION, WHATEVER IT IS. Naming
  //   resumableUploadEndpoint made this a tripwire for anything dropped in between:
  //   LessonStage alone holds four `course-stage` wrappers, so landing it in that range
  //   would count 7 and fail with a message about a defect that had not happened.
  const body = src.slice(i, src.indexOf('\nfunction ', i + 1));
  assert.equal((body.match(/className="course-stage"/g) || []).length, 3,
    'error, signing and ready must each return the SAME .course-stage wrapper — otherwise '
    + 'a signing failure resizes the page under the learner, as it did before');
  // Comments stripped first, as §6 does: the code's own prose explains what the removed
  // clamp was, and a naive scan matches that explanation and fails on the right answer.
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/maxHeight: 460/.test(code),
    'the 460px clamp is gone: it needed an 818px-wide box to bind and never once fired');
});

test('a text lesson never gets the black video frame', () => {
  const src = app();
  const i = src.indexOf('function LessonStage({ lesson, adminView = false })');
  assert.ok(i > 0, 'LessonStage was not found');
  const textBranch = src.slice(i, src.indexOf("video_provider === 'upload'", i));
  assert.ok(!/course-stage/.test(textBranch),
    'the type === "text" branch must not render a media stage — its prose and its '
    + '"No content yet." card would sit in a black video box');
  // ★ THE GATE IS DERIVED IN THE SHARED CARD, so the student page and the editor's
  //   preview cannot answer it differently. It used to be computed in renderLearner,
  //   where a second caller would have needed its own copy.
  assert.match(lessonCard(), /const stageLesson = lessonUsesMediaStage\(lesson\);/,
    'the full-bleed gate belongs to LessonCard, once');
  assert.ok(!/lessonUsesMediaStage/.test(fnBody(src, 'function renderLearner() {')),
    'and renderLearner must not keep a second copy of it');
});

// Only a TWO-PANE WORKSPACE gets the wide canvas, and each member had to earn it with a
// measurement. Two kinds qualify, named separately so the reason survives the next
// addition — a bare count would let anything in as long as the list stayed short, and a
// stale "does not host a course catalog" message would then contradict the code.
const COURSE_CATALOG_TABS = ['qbomastery', 'resumestrategy', 'interview'];
const TWO_PANE_TABS = ['portfoliogenerator'];

test('only two-pane workspaces get the wide canvas, and only the max-width is conditional', () => {
  const src = app();
  const m = /const WIDE_CANVAS_TABS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'WIDE_CANVAS_TABS was not found');
  const ids = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const allowed = [...COURSE_CATALOG_TABS, ...TWO_PANE_TABS];
  assert.ok(ids.length > 0 && ids.length <= allowed.length,
    'this is an exception list, not a redesign — every other tool is a form or a document '
    + 'and reads worse wider');
  for (const id of ids) {
    assert.ok(allowed.includes(id),
      `${id} is neither a course catalog nor a two-pane authoring workspace`);
  }
  assert.ok(/p-4 sm:p-6 lg:p-10 \$\{WIDE_CANVAS_TABS/.test(src),
    "ONLY the max-width may be conditional — SectionHead's -mx-10/-mt-10/px-10 band is "
    + 'hard-coupled to the lg:p-10 padding and tears if it moves');
  // Tailwind's JIT scans source text, so a class built by concatenation is never emitted.
  assert.ok(/'max-w-\[1800px\]'/.test(src) && /'max-w-7xl'/.test(src),
    'both canvas widths must appear as complete literals for the JIT scanner');
});

// ── 19. The in-browser faststart remux ──────────────────────────────────────
//
// Uploading a lesson used to cost the admin an ffmpeg pass every single time: all nine
// lesson objects in production are named `*_faststart.mp4`. planFaststartRemux does that
// rearrangement in the browser instead — losslessly, in milliseconds. The properties
// below are the ones no unit test can reach, because they live in the component.
//
// The failure this section exists to prevent is specific and quiet: a 1.45 GiB paid
// lesson that uploads clean, verifies clean, and plays as noise for students. Every
// downstream check is structurally blind to it — the size cannot change, the ftyp sniff
// still passes, and `loadedmetadata` fires from the index alone without decoding a sample.

const uploaderBody = () => {
  const src = app();
  const i = src.indexOf('function LessonVideoUploader(');
  assert.ok(i > 0, 'LessonVideoUploader was not found');
  return src.slice(i, src.indexOf('\nfunction ', i + 10));
};

const fnBody = (src, signature) => {
  const i = src.indexOf(signature);
  assert.ok(i > 0, `${signature} was not found`);
  return src.slice(i, src.indexOf('\n  }', i));
};

test('the remux is attempted for a bad INDEX only, never for a bad codec', () => {
  const pick = fnBody(uploaderBody(), 'async function handlePick(');
  assert.match(pick, /content\.reason === 'not-faststart'/, 'only not-faststart is ours to repair');
  const call = pick.indexOf('planFaststartRemux');
  const guard = pick.indexOf("content.reason === 'not-faststart'");
  assert.ok(guard > 0 && guard < call,
    'remuxing an HEVC file yields a faststart HEVC file — still a black player for every '
    + 'student without a decoder, and the admin sent off to fix the wrong thing');
});

test('the decode probe runs against the REMUXED file, not the one that was picked', () => {
  const pick = fnBody(uploaderBody(), 'async function handlePick(');
  assert.match(pick, /createObjectURL\(upload\)/,
    'probing the picked file would validate bytes we are not going to send');
  assert.ok(!/createObjectURL\(file\)/.test(pick),
    'handlePick must never probe the original file once a remux may have replaced it');
});

test('a successful remux repoints fileRef and transfers the remuxed bytes', () => {
  const pick = fnBody(uploaderBody(), 'async function handlePick(');
  assert.match(pick, /fileRef\.current = upload;/,
    'fileRef is what resume() re-enters runTransfer with and what "Check again" sizes '
    + 'against — a stale one feeds storage the old layout from the new offset');
  assert.match(pick, /runTransfer\(upload\)/);
  assert.ok(!/runTransfer\(file\)/.test(pick), 'the picked file must never be the one uploaded');
});

test('buildFaststartFile is SYNCHRONOUS, so it cannot materialise the file', () => {
  const src = app();
  const i = src.indexOf('function buildFaststartFile(');
  assert.ok(i > 0, 'buildFaststartFile was not found');
  assert.ok(!/async\s+function buildFaststartFile/.test(src),
    'an async builder invites `await part.arrayBuffer()`, which turns a 1.45 GiB '
    + 'by-reference Blob into a heap allocation and kills the tab');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(!/\bawait\b/.test(body), 'no await: a sync function physically cannot read the bytes');
  assert.ok(!/arrayBuffer\(/.test(body), 'File.slice() must stay a lazy reference, never a read');
  assert.match(body, /file\.slice\(p\.start, p\.end\)/);
});

test('the remuxed File carries the SOURCE lastModified, or resume silently breaks', () => {
  const src = app();
  const body = src.slice(src.indexOf('function buildFaststartFile('));
  assert.match(body.slice(0, 1400), /lastModified: file\.lastModified/,
    'new File() defaults lastModified to Date.now(); the tus fingerprint depends on it, '
    + 'so letting it default means findPreviousUploads() never matches and "choose the '
    + 'same file again to pick up where it left off" re-sends the whole file from zero');
  const at = src.indexOf('fingerprint:');
  assert.match(src.slice(at, at + 200), /lastModified/, 'the fingerprint really does depend on it');
});

test('a file WE rearranged that will not decode gets the manual remedy, not re-encode advice', () => {
  const pick = fnBody(uploaderBody(), 'async function handlePick(');
  const i = pick.indexOf('if (remuxed) {');
  assert.ok(i > 0, 'the remuxed branch of the probe catch was not found');
  // Strip comments first: the comment ON this branch explains that re-encode advice is
  // wrong here, so a naive scan matches the explanation and fails on the right answer.
  // (§18 hit the identical trap.)
  const arm = pick.slice(i, i + 500).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/re-encode|re-export|libx264/i.test(arm),
    'the encoding was never the problem — this is OUR rearrangement failing, and the '
    + 'remedy is the lossless remux. Same rule §13 enforces one state later');
  assert.match(arm, /setErrMsg\(content\.message\)/);
});

test('the remux adds no state and no event to the machine', () => {
  const lib = readFileSync(join(REPO, 'src/lib/courseVideo.js'), 'utf8');
  // Read the two frozen maps themselves rather than scanning the file for a word — the
  // module now legitimately mentions the remux in prose, and the thing being pinned is
  // the machine's shape, not its vocabulary.
  for (const name of ['UPLOAD_STATES', 'UPLOAD_EVENTS']) {
    const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\)`).exec(lib);
    assert.ok(m, `${name} was not found`);
    assert.ok(!/REMUX|FASTSTART/i.test(m[1]),
      `${name} must not grow an entry for the remux — READY_TO_SAVE keeps exactly one `
      + 'inbound edge, from VERIFYING_PRIVATE_OBJECT, and the remux runs inside '
      + 'LOCAL_VALIDATING where the picker is already disabled and Save is already blocked');
  }
  assert.ok(!/UPLOAD_STATES\.[A-Z_]*(REMUX|FASTSTART)/i.test(app()));
});

test('★ a container finding NEVER stops the upload', () => {
  // THE REGRESSION THIS SECTION EXISTS FOR. The previous version rendered these exact
  // findings in an amber card with an "Upload anyway" button and waited. Every state
  // transition behind that button was correct and the button worked — and the admin it
  // was written for read it as a refusal and pressed NEITHER option, then reported that
  // the toolkit would not let them upload an H.265 video. A finding that interrupts is
  // a block in practice, whatever its severity field says.
  const pick = fnBody(uploaderBody(), 'async function handlePick(');
  const i = pick.indexOf('if (notes.length)');
  assert.ok(i > 0, 'handlePick must still collect notes');
  const arm = pick.slice(i, pick.indexOf('go(UPLOAD_EVENTS.VALIDATE_OK)', i));
  assert.ok(!/VALIDATE_FAIL/.test(arm),
    'a note must not route to VALIDATE_FAIL — that lands on UNSUPPORTED_FILE and waits');
  assert.ok(!/\breturn\b/.test(arm),
    'the notes branch must fall through to the upload, never return early');
  // And there is nothing left to click. Strip comments first: the comments explaining
  // WHY the button was removed necessarily name it, and a naive scan matches the
  // explanation and fails on the correct answer (§18 and §19 have both hit this).
  const code = app().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/uploadAnyway|Upload anyway/.test(code),
    'the accept/decline card is gone; a note is a footnote, not a question');
});

test('the notice is a status line, not an alert', () => {
  const body = uploaderBody();
  const i = body.indexOf('{notice && (');
  assert.ok(i > 0, 'the notice block was not found');
  const block = body.slice(i, i + 700);
  assert.match(block, /role="status"/, 'a note about a running upload is not an alert');
  assert.ok(!/role="alert"/.test(block) && !/AlertTriangle/.test(block),
    'amber + AlertTriangle is what made a non-blocking note read as a refusal');
  assert.ok(!/status-warn/.test(block), 'the warning tokens belong to things that are wrong');
});

test('a flagged codec is not re-blocked AFTER its upload finishes', () => {
  const body = fnBody(uploaderBody(), 'async function verifyPrivateObject(');
  assert.match(body, /codecRiskRef\.current && undecodable/,
    'this probe runs in the SAME browser that already said it cannot decode this codec. '
    + 'Saying so at pick time, uploading for twenty minutes and then refusing on the '
    + 'answer we had already predicted is worse than never having said anything');
  assert.match(body, /e\?\.message === 'timeout'/,
    'a timeout carries no MediaError code, so testing only 3 and 4 left a completed '
    + 'upload stuck at "Video not ready" — and partial HEVC support stalls rather than '
    + 'erroring, which is exactly a timeout');
  assert.match(body, /await confirmSignedObject\(url, expectedBytes\);/,
    'presence, authorization and byte-completeness are still proven for every file');
  assert.ok(body.indexOf('confirmSignedObject') < body.indexOf('codecRiskRef.current'),
    'the existence/size check must run BEFORE any leniency, never be skipped by it');
});

test('★ a refused pick can never save silently', () => {
  // UNSUPPORTED_FILE is deliberately absent from the UNFINISHED set, so Save stays
  // enabled beside the refusal — and used to succeed while changing nothing: drawer
  // closed, lesson unchanged, still un-publishable, no error anywhere.
  const src = app();
  const body = fnBody(src, 'async function saveLesson(');
  // Anchored on `if (` and the whole arm, so a `false &&` or an inverted test cannot
  // leave the condition text in place while disabling it.
  // refuseSave(), not setLessonErr(): the message alone is invisible when Save was pressed
  // from the student preview, so every refusal leaves preview mode on its way out.
  const guard = /if \(videoUploadState === UPLOAD_STATES\.UNSUPPORTED_FILE && !d\.storage_path\) \{\s*refuseSave\([\s\S]{0,400}?return;\s*\}/
    .exec(body);
  assert.ok(guard,
    'saving a lesson whose only picked file was refused must refuseSave() and RETURN, '
    + 'not no-op: the drawer used to close on an unchanged, still-un-publishable lesson '
    + 'with no error anywhere, which is indistinguishable from "the upload is broken"');
  const lib = readFileSync(join(REPO, 'src/lib/courseVideo.js'), 'utf8');
  const unfinished = lib.slice(lib.indexOf('const UNFINISHED'), lib.indexOf('const CLOSE_CONFIRM'));
  assert.ok(unfinished.length > 0 && !/UNSUPPORTED_FILE/.test(unfinished),
    'do NOT fix this by adding UNSUPPORTED_FILE to UNFINISHED — that set also drives '
    + 'hasUnfinishedUpload and would relabel Save "Video not ready" on a lesson whose '
    + 'existing video is perfectly fine');
  // And the guard must be escapable, or a bad pick makes the drawer unsaveable.
  assert.match(src, /Dismiss/, 'the refusal needs a way out that is not reloading the page');
});

test('the legacy-link banner stops demanding a replacement once one exists', () => {
  const src = app();
  assert.match(src, /classifyLessonVideo\(d\) === 'legacy-link' && !d\.storage_path/,
    'during the replacement upload this banner kept insisting the course could not be '
    + 'published until the video was replaced — directly above the uploader replacing it');
});

test('the oversize note is advisory and cannot block a save', () => {
  const body = uploaderBody();
  assert.match(body, /setWeightNote\(describeVideoWeight\(/);
  assert.ok(!/weightNote[\s\S]{0,200}VALIDATE_FAIL/.test(body),
    'a heavy file still uploads — this is a heads-up, not a gate');
});

test('an abandoned upload is swept when the drawer closes', () => {
  const src = app();
  const body = fnBody(src, 'const closeLessonEditor = ');
  assert.match(body, /pendingVideoPathRef\.current/,
    'closing the drawer unmounts the uploader, taking its ref with it — that is where '
    + '1.60 GiB of orphans came from');
  assert.match(body, /removeMediaIfUnreferenced\(\[orphan\]\)/,
    'and it must go through the reference-aware helper, since a duplicated course can '
    + 'legitimately share a path');
  assert.ok(!/useEffect\([^)]*\)[\s\S]{0,200}discardPending\(\)[\s\S]{0,80}\}, \[\]\)/.test(src),
    'NOT an unmount cleanup: that fires on a successful save too, where the pending path '
    + 'is the one just written to the row');
  assert.match(src, /onPendingPath=\{notePendingVideoPath\}/, 'the drawer must be told the path');
});

// ── 20. The admin nav scrolls with the rest of the sidebar ──────────────────
//
// Eight capability-filtered admin links and the Customize controls lived in the
// sidebar's NON-scrolling header. Every admin screen added (#58 Finance, #61
// Communications, #62 Meetings) made that header taller and the scrolling product
// nav below it shorter, until on a 1280×720 laptop the courses were a sliver. The
// header now holds only brand + identity; the admin links are a collapsible group
// INSIDE the scroll region, and Customize sits in a small non-scrolling footer.
const sidebarOf = (src) => {
  const start = src.indexOf('{/* SIDEBAR — static column');
  const end = src.indexOf('{/* MAIN */}');
  assert.ok(start > 0 && end > start, 'the sidebar <aside> could not be found');
  return src.slice(start, end);
};

test('the sidebar header holds no admin links and no Customize controls', () => {
  const aside = sidebarOf(app());
  const header = aside.slice(0, aside.indexOf('{/* Rail header'));
  assert.ok(header.length > 0, 'the rail header marker moved');
  assert.ok(!header.includes('adminNavItems.map('),
    'admin links in the fixed header squeeze the scrolling nav on every short screen');
  assert.ok(!header.includes('enterCustomize'), 'Customize belongs in the footer, not the fixed header');
  assert.match(header, /className=\{`flex-shrink-0 px-5/, 'the header must not be squeezed either');
});

test('the expanded nav is the scroller, and it starts with the Administration group', () => {
  const aside = sidebarOf(app());
  // BOTH <nav>s carry the same accessible name, and that is correct: only one is ever
  // rendered-and-visible at a time (the rail is `railCollapsed &&` plus `hidden lg:flex`; the
  // expanded one goes `lg:hidden` when collapsed), so neither breakpoint is handed an unnamed
  // navigation. It does mean the LABEL is no longer a unique anchor — pin the expanded nav by its
  // own class shape instead: a template literal starting `flex-1`, where the rail's is a plain
  // string starting "hidden lg:flex".
  assert.equal((aside.match(/<nav aria-label="Main navigation"/g) || []).length, 2,
    'both the expanded nav and the collapsed rail must be named for assistive tech');
  const EXPANDED = '<nav aria-label="Main navigation" className={`flex-1';
  assert.equal(aside.split(EXPANDED).length - 1, 1,
    'the expanded nav lost its label or its class shape — this anchor must stay unambiguous');
  const navAt = aside.indexOf(EXPANDED);
  const navTag = aside.slice(navAt, aside.indexOf('>', navAt));
  assert.match(navTag, /min-h-0/, 'a flex child without min-h-0 refuses to shrink and stops scrolling');
  assert.match(navTag, /overflow-y-auto/);
  const group = aside.indexOf('aria-controls="sidebar-admin-list"');
  const stages = aside.indexOf('visibleStages.map(', navAt);
  assert.ok(group > navAt && group < stages, 'the admin group must be inside the scroll region, before the stages');
  assert.match(aside, /aria-expanded=\{adminNavOpen\}/);
  // Attribute ORDER must not matter. Asserting that id and hidden were ADJACENT is exactly what
  // broke when the list gained its own accessible name, so slice the tag and test it by parts.
  const ulAt = aside.indexOf('<ul id="sidebar-admin-list"');
  assert.ok(ulAt > 0, 'the list stays rendered so aria-controls always points at a real element');
  const ulTag = aside.slice(ulAt, aside.indexOf('>', ulAt));
  assert.match(ulTag, /hidden=\{!adminNavOpen\}/, 'the group collapses via the hidden attribute');
  assert.match(ulTag, /aria-labelledby="sidebar-admin-toggle"/,
    'an unnamed list of admin links is announced as just "list"');
  // The collapse rests ENTIRELY on preflight's [hidden]{display:none}. ANY display utility here
  // out-cascades it and Administration becomes permanently open — the precise hazard
  // src/index.css already documents, after it shipped once one layer down.
  const ulClass = (ulTag.match(/className="([^"]*)"/) || ['', ''])[1];
  assert.ok(!/\b(flex|grid|block|inline|inline-flex|inline-block|table|contents)\b/.test(ulClass),
    'a display utility on the admin list would silently defeat hidden={!adminNavOpen}');
});

test('the collapsed rail is not second class for assistive tech', () => {
  const aside = sidebarOf(app());
  const railAt = aside.indexOf('<nav aria-label="Main navigation" className="hidden lg:flex');
  assert.ok(railAt > 0, 'the collapsed rail nav must be named too, not just the expanded one');
  // Active state in the rail used to be an inline gradient and nothing else — it LOOKED current
  // and announced nothing. Scope the search to the rail so the group's own copy cannot satisfy it.
  const rail = aside.slice(railAt, aside.indexOf('{visibleStages.map(', railAt));
  assert.ok(rail.includes('adminNavItems.map('), 'the rail slice no longer contains the admin rows');
  assert.match(rail, /aria-current=\{tab === item\.id \? 'page' : undefined\}/,
    'a rail admin row must announce that it is the current page, not merely look like it');
});

test('the collapsed Administration badge counts every admin queue', () => {
  const aside = sidebarOf(app());
  // The summary badge exists so a CLOSED group can still pull you in. Filtering it to
  // accessrequests+enrollments made a running or failed student import invisible the moment the
  // group was collapsed — the one job the badge has. Whichever admin queue is added next must
  // be counted without anyone remembering to extend a list.
  const at = aside.indexOf('const waiting = adminNavItems');
  assert.ok(at > 0, 'the Administration summary badge lost its count');
  const stmt = aside.slice(at, aside.indexOf(';', at));
  assert.match(stmt, /adminNavItems\.reduce\(/, 'the badge must reduce over the whole list');
  assert.ok(!stmt.includes('.filter('),
    'an id allow-list here silently drops whichever admin queue was added last');
});

test('admin links stay real links, from ONE list, in exactly two renderings', () => {
  const aside = sidebarOf(app());
  assert.equal((aside.match(/adminNavItems\.map\(/g) || []).length, 2,
    'one expanded group and one icon rail — a third copy is how the two drift apart');
  assert.equal((aside.match(/href=\{tabHref\(item\.id\)\}/g) || []).length, 2,
    'an admin row must stay an <a href> so Ctrl/middle-click opens a new tab');
  assert.match(aside, /aria-current=\{tab === item\.id \? 'page' : undefined\}/);
  assert.match(aside, /className=\{`relative nav-hover \$\{tab === item\.id \? 'nav-item-active'/,
    'nav-item-active draws its bar with an absolutely positioned ::before — without relative it lands on the aside edge');
});

test('Customize lives in a non-scrolling footer and is still capability-gated', () => {
  const aside = sidebarOf(app());
  const footerAt = aside.indexOf('{/* Sidebar footer');
  assert.ok(footerAt > aside.lastIndexOf('</nav>'), 'the footer must come after the scrolling nav');
  const footer = aside.slice(footerAt);
  assert.match(footer, /className=\{`flex-shrink-0/);
  assert.match(footer, /canCustomizeSidebar && !editMode/, 'Customize is shown only to those who may rename labels');
  assert.match(footer, /onClick=\{enterCustomize\}/);
  assert.match(footer, /role="alert"/, 'a failed save must be announced, not just coloured red');
});

test('the Administration group state persists per user and opens for an active admin tab', () => {
  const src = app();
  assert.match(src, /window\.storage\.get\('sidebar:adminExpanded'\)/);
  assert.match(src, /window\.storage\.set\('sidebar:adminExpanded', String\(adminNavOpen\)\)/);
  assert.match(src, /if \(storageReady && adminNavIds\.split\(','\)\.includes\(tab\)\) setAdminNavOpen\(true\)/,
    'an admin tab reached by deep link must not sit inside a collapsed group');
  const auth = readFileSync(join(REPO, 'src/auth/AuthProvider.jsx'), 'utf8');
  assert.match(auth, /'sidebar:adminExpanded'/, 'every persisted key belongs in LEGACY_KEYS');
});

// ── 21. Daily Income is wired to the ledger, not to a cache ─────────────────
test('the ledger-change event is declared once at module scope and never re-fired by invalidateReports', () => {
  const src = app();
  assert.match(src, /^const FINANCE_LEDGER_CHANGE_EVENT = 'bookkeeper:finance-ledger-change';$/m);
  const inv = src.slice(src.indexOf('const invalidateReports = useCallback('), src.indexOf('const bankChanged = useCallback('));
  assert.ok(inv.length > 0 && !/dispatchEvent/.test(inv),
    'invalidateReports is what the listener calls — dispatching from it would recurse');
  assert.match(src, /window\.addEventListener\(FINANCE_LEDGER_CHANGE_EVENT, onLedgerChange\)/);
  assert.match(src, /window\.removeEventListener\(FINANCE_LEDGER_CHANGE_EVENT, onLedgerChange\)/);
});

test('both approval paths announce the ledger change', () => {
  const src = app();
  const single = src.slice(src.indexOf('const doApprove = async (r, pickedBatchId = null) => {'), src.indexOf('const grantedEndsAt'));
  assert.match(single, /if \(out\.already\)[\s\S]*return;[\s\S]*dispatchEvent\(new Event\(FINANCE_LEDGER_CHANGE_EVENT\)\)/,
    'after the already-approved early return — an idempotent re-approval posted nothing');
  const bulk = src.slice(src.indexOf('const runBulk = async () => {'), src.indexOf('const exportCsv = () => {'));
  assert.match(bulk, /kind === 'approve' && results\.some\(\(x\) => x\.ok && x\.note === 'approved'\)/);
  assert.equal((bulk.match(/FINANCE_LEDGER_CHANGE_EVENT/g) || []).length, 1, 'once per bulk run, not once per row');
});

test('Daily Income loads itself, shows its own setup card, and a failure is never an empty month', () => {
  const src = app();
  const body = src.slice(src.indexOf('function FinanceDailyIncomeReport('), src.indexOf('// ── Profit & Loss'));
  assert.match(body, /supabase\.rpc\('finance_daily_income_report', \{ p_month: month \? `\$\{month\}-01` : null \}\)/);
  assert.ok(!/\bcall\(/.test(body), "the parent's call() would replace the whole finance screen for a missing #64");
  assert.match(body, /db\/2026-09-19-finance-daily-income\.sql/);
  assert.match(body, /catch \(e\) \{[\s\S]{0,80}setReport\(null\)/, 'a failed load must clear the previous month');
  assert.ok(!/'(sampler|silver_self_paced|vip|gold|core|gold_live|essentials)'/.test(body),
    'no plan key in the component — the columns are the server\'s plan list');
  assert.match(src, /\{ key: 'overview',\s+label: 'Overview' \},[\s\S]{0,140}\{ key: 'daily',\s+label: 'Daily Income' \}/);
});

test('a reversal is dated today in the business timezone unless the admin chooses the original date', () => {
  const src = app();
  const body = src.slice(src.indexOf('function FinanceReverseModal('), src.indexOf('\nfunction ', src.indexOf('function FinanceReverseModal(') + 10));
  assert.match(body, /const \[when, setWhen\] = useState\('today'\)/, 'the owner decision: corrections default to today');
  assert.match(body, /const today = serverToday \|\| businessToday\(timeZone\);/,
    "the server's business date first; the device clock is only a visible fallback");
  assert.match(body, /when === 'original' && landed !== original/,
    '"closed" is only true on the original-date path — a today-dated correction never moved');
  assert.match(body, /correctionDate\(entry\.entry_date, today\)/);
  assert.match(body, /p_reversal_date: when === 'today' \? onDate : null/);
  assert.ok(!/todayISODate\(/.test(body), "the browser's date is not the business date");
});

const dailyBody = (src) => src.slice(src.indexOf('function FinanceDailyIncomeReport('), src.indexOf('// ── Profit & Loss'));

test('one visible choice drives the table, the print view and the CSV', () => {
  const body = dailyBody(app());
  // `rows` is the zero-day filter applied; `days` is every calendar day. Exporting `days` while
  // printing `rows` let a hidden-zero-days view download a file that disagreed with both the
  // screen and the printout, row for row.
  assert.match(body, /const rows = showZero \? days : activeDays;/);
  assert.match(body, /financeDownloadCsv\(`daily-income-\$\{report\.month\}\.csv`, exportCols, \[\.\.\.rows, totalsRow\]\)/,
    'the CSV must honour the zero-activity toggle, like the table and the print view already do');
  assert.ok(!/exportCols, \[\.\.\.days,/.test(body),
    'exporting every calendar day contradicts the screen the admin is looking at');
});

test('the month picker keeps its rails when a load fails', () => {
  const body = dailyBody(app());
  // A failure clears `report` on purpose, so a failure can never read as a zero month. Deriving
  // the bounds from `report` therefore dropped min/max in the error state: prev/next stepped
  // outside 2020-01 … max_month, the next call answered 22023, and the same error card rendered
  // again with no way forward.
  assert.match(body, /const bounds = report \? \{[^}]*\} : lastBoundsRef\.current;/,
    'the error state must fall back to the last known bounds');
  assert.match(body, /lastBoundsRef\.current = \{ min: data\.min_month \|\| null, max: data\.max_month \|\| null \}/,
    'and the rails must be captured on a SUCCESSFUL load, not derived from the cleared report');
});

test('the finance loading card and the daily chart respect the reader', () => {
  const src = app();
  const loadAt = src.indexOf('function FinanceLoading(');
  assert.ok(loadAt > 0, 'FinanceLoading moved');
  assert.match(src.slice(loadAt, loadAt + 400), /animate-spin motion-reduce:animate-none/,
    'a spinner with no reduced-motion opt-out is the one animation a reader cannot turn off');
  const chart = src.slice(src.indexOf('function FinanceDailyNetBars('), src.indexOf('function FinanceDailyIncomeReport('));
  assert.ok(!/<figure aria-label=/.test(chart),
    'an aria-label on the <figure> overrides its <figcaption>, so the legend stops being part of the name');
  assert.match(chart, /<figcaption/, 'the chart is named by its caption');
  assert.match(chart, /<svg[^>]*role="img"/, 'and the svg carries the full spoken description');
});

// ── 22. Grouped sidebar tabs actually reorder ───────────────────────────────
//
// The owner reported that rearranging worked under Training and did nothing under Job
// Application or Client Management. It was not a rendering glitch: onTabDrop reordered
// stage.tabs and persisted it faithfully, but a stage with `groups` re-derives its list
// from groups[].tabIds, and mergeStoredWithDefaults re-stamped `groups` from the code
// defaults on every load. The drag was saved and then ignored, every time.
//
// src/lib/sidebarLayout.js now owns the rules and test/sidebarLayout.test.mjs proves
// them. What CANNOT be reached from there is whether the component still asks — so these
// scans pin the wiring: that the handlers go through the library rather than splicing
// arrays themselves, that reordering is not mouse-only, and that Cancel can cancel.

const sidebarRegion = () => {
  const src = app();
  const start = src.indexOf('const renderTab = (t) => {');
  assert.ok(start > 0, 'renderTab moved');
  const end = src.indexOf('Click any label to rename', start);
  assert.ok(end > start, 'the sidebar footer moved');
  return src.slice(start, end);
};

/** The stage HEADER, which renders above renderTab and so outside sidebarRegion(). */
const stageHeaderRegion = () => {
  const src = app();
  const start = src.indexOf('{/* Stage header */}');
  assert.ok(start > 0, 'the stage header moved');
  const end = src.indexOf('const renderTab = (t) => {', start);
  assert.ok(end > start, 'renderTab moved');
  return src.slice(start, end);
};

test('a drop is resolved by reorderVerdict, and the handler splices nothing itself', () => {
  const src = app();
  const drop = fnBody(src, 'const onTabDrop = (e, targetStageId, targetTabId) => {');
  assert.match(drop, /reorderVerdict\(/, 'the refusal rules live in ONE tested place');
  assert.ok(!/\.splice\(/.test(drop),
    'a handler that splices tabs itself is how a tab left its group and vanished from '
    + 'the sidebar with no error — g.tabIds.map(...).filter(Boolean) simply dropped it');
  assert.match(drop, /if \(!result\.ok\)/, 'a refused drop must not fall through into a write');
  assert.match(drop, /REORDER_REFUSALS\[result\.reason\]/,
    'a silent refusal is what made the original bug feel like "the sidebar ignores me"');
});

test('the up/down buttons exist, are labelled, and mark the edges without losing focus', () => {
  const region = sidebarRegion();
  assert.match(region, /moveTab\(stage\.id, t\.id, -1\)/, 'Move up must be wired');
  assert.match(region, /moveTab\(stage\.id, t\.id, 1\)/, 'Move down must be wired');
  assert.match(region, /const atTop = pos <= 0;/, 'the first tab cannot move up');
  assert.match(region, /const atEnd = pos === -1 \|\| pos >= siblings\.length - 1;/,
    'the last tab cannot move down');

  // ★ aria-disabled, NEVER disabled. A browser blurs a focused element the instant it
  //   becomes disabled, so pressing Up until a tab reached position 1 dropped a keyboard
  //   user onto <body> in the middle of reordering. Left focusable, the press falls
  //   through to moveTabByStep, which refuses with 'at-edge' and announces it.
  assert.match(region, /aria-disabled=\{atTop \|\| undefined\}/);
  assert.match(region, /aria-disabled=\{atEnd \|\| undefined\}/);
  const moveBlock = region.slice(region.indexOf('const atTop'), region.indexOf('Move ${tLabel} down') + 200);
  // The lookbehind matters: `\bdisabled=` matches INSIDE `aria-disabled=`, because the
  // hyphen is a word boundary — so a naive scan passes on the very attribute it forbids.
  assert.ok(!/(?<!aria-)disabled=\{/.test(moveBlock),
    'a real `disabled` on a move button takes focus away mid-reorder');

  // ★ 24x24 IS THE FLOOR (WCAG 2.2 SC 2.5.8) AND THIS IS A PHONE CONTROL: below `lg` the
  //   sidebar IS the off-canvas drawer, so a `p-0.5` around a 13px icon — about 17x17 —
  //   was the target on the one device that cannot drag at all.
  assert.match(moveBlock, /min-h-\[24px\] min-w-\[24px\]/,
    'the move buttons must meet the 24x24 minimum target size');

  assert.match(region, /aria-label=\{`Move \$\{tLabel\} up in \$\{within\}`\}/,
    'the accessible name must say WHICH tab and WHICH section, not just "move up"');
  assert.match(region, /aria-label=\{`Move \$\{tLabel\} down in \$\{within\}`\}/);
});

test('whole sections reorder too, by keyboard and touch, through the same arbiter', () => {
  const src = app();
  const header = stageHeaderRegion();
  // ★ onStageDrop WAS THE LAST HAND-ROLLED SPLICE IN THE SIDEBAR. No arbiter, no refusal,
  //   no announcement, and drag-only — the exact shape the tab path was rescued from.
  const drop = src.slice(src.indexOf('const onStageDrop'), src.indexOf('const onStageDrop') + 1400);
  assert.ok(!/\.splice\(/.test(drop), 'a stage drop must go through stageReorderVerdict, not a splice');
  assert.match(drop, /stageReorderVerdict\(prev, srcStageId, targetStageId\)/);
  assert.match(drop, /STAGE_REORDER_REFUSALS\[result\.reason\]/, 'a refused stage drop must say so');

  assert.match(header, /moveStage\(stage\.id, -1\)/, 'sections need a keyboard Move up');
  assert.match(header, /moveStage\(stage\.id, 1\)/, 'sections need a keyboard Move down');
  assert.match(header, /aria-label=\{`Move section \$\{sLabel\} up`\}/);
  assert.match(header, /aria-label=\{`Move section \$\{sLabel\} down`\}/);
  assert.match(header, /min-h-\[24px\] min-w-\[24px\]/, 'and they are touch targets too');
});

test('a cross-group drag is refused while it is still a drag', () => {
  const src = app();
  const over = src.slice(src.indexOf('const onTabDragOver'), src.indexOf('const onTabDragLeave') + 120);
  // Setting 'move' over every row showed a legal-looking cursor the whole way across a
  // group boundary, and explained itself only after the drop had already failed.
  assert.match(over, /dropEffect = allowed \? 'move' : 'none'/);
  assert.match(over, /groupKeyOfTab\(/, 'validity is decided by the same grouping the drop uses');
  assert.match(src, /onDragOver=\{editMode \? \(e\) => onTabDragOver\(e, stage\.id, t\.id\) : undefined\}/,
    'the row must tell the handler which target it is');
});

test('reordering is not mouse-only, and the buttons are not nested in the rename button', () => {
  const region = sidebarRegion();
  // HTML5 drag-and-drop cannot be operated from a keyboard and is unusable on touch, so
  // the grip is a convenience and these buttons are the real control.
  assert.match(region, /<button type="button" className=\{btn\}/,
    'the move controls must be real buttons, reachable by Tab');
  const renameAt = region.indexOf('title="Click to rename"');
  const moveAt = region.indexOf('Move ${tLabel} up');
  assert.ok(renameAt > 0 && moveAt > renameAt,
    'the move buttons must be SIBLINGS after the rename button — a button nested inside '
    + 'another button is invalid and the inner one stops being reachable');
});

test('every reorder, including a refused one, is announced', () => {
  const src = app();
  assert.match(src, /aria-live="polite" role="status" className="sr-only">\{reorderNote\}/,
    'a screen-reader user gets no visual confirmation that a row moved');
  const announce = fnBody(src, 'const announceMove = (stage, tabId, result) => {');
  assert.match(announce, /position \$\{result\.to \+ 1\} of \$\{result\.total\}/,
    'the announcement must say where the tab landed, not merely that something happened');
  assert.match(announce, /effLabel\(/,
    'it must speak the EFFECTIVE label — what the admin sees — not the code default');
});

test('ordering logic reads ids; only the announcement reads labels', () => {
  const src = app();
  const move = fnBody(src, 'const moveTab = (stageId, tabId, delta) => {');
  assert.ok(!/effLabel\(/.test(move),
    'visible labels are sidebar_settings overrides — ordering that compared them would '
    + 'rearrange itself the moment an admin renamed a tab');
});

test('the layout is NOT persisted while Customize is open, so Cancel can cancel', () => {
  const src = app();
  const at = src.indexOf("window.storage.set('sidebar:stages'");
  assert.ok(at > 0, 'the layout persist effect moved');
  const effect = src.slice(src.lastIndexOf('useEffect(', at), src.indexOf('}, [', at) + 40);
  assert.match(effect, /if \(editMode\) return;/,
    'this effect used to fire on every drag, which made Cancel a lie');
  assert.match(effect, /\}, \[stages, storageReady, editMode\]\)/,
    'editMode must be a dependency, or leaving edit mode never triggers the commit');
  assert.match(effect, /stagesToStorable\(stages\)/,
    'the write must go through stagesToStorable, which is what persists groups[].tabIds');
});

test('Cancel restores the snapshot taken when Customize opened', () => {
  const src = app();
  const enter = fnBody(src, 'const enterCustomize = () => {');
  assert.match(enter, /layoutSnapshotRef\.current = stages;/, 'nothing to restore otherwise');
  const cancel = fnBody(src, 'const cancelSidebarEdit = () => {');
  assert.match(cancel, /if \(layoutSnapshotRef\.current\) setStages\(layoutSnapshotRef\.current\);/,
    'Cancel must put the layout back, not just drop the label drafts');
});

test('the footer no longer claims everything saves for everyone', () => {
  const src = app();
  const at = src.indexOf('Click any label to rename');
  const footer = src.slice(at, at + 1600);
  assert.ok(!/Done saves for everyone/.test(footer),
    'labels are global, tab order is per-user and collapse state is per-device — one '
    + 'sentence covering all three told an admin they were curating for their students');
  assert.match(footer, /<strong[^>]*>Labels<\/strong> save for everyone/);
  assert.match(footer, /<strong[^>]*>Tab order<\/strong> and open\/closed sections/);

  // ★ TWO REACHES, NOT THREE — AND NO SYNC PROMISE. The copy said tab order "saves for
  //   you on this account" beside collapse state that "stays on this device", drawing a
  //   distinction the app does not implement: window.storage is localStorage namespaced
  //   per user (src/main.jsx), so BOTH are per-user and per-browser. Only labels are
  //   global. "on this account" sent an admin looking for a sync that was never built.
  assert.match(footer, /save for you in this browser/);
  // Strip the JSX comment first: it QUOTES the wording it exists to warn against, and a
  // bare scan of the region would fail on the explanation rather than on the copy. Same
  // shape as the jsCode() idiom in lessonContentSql.test.mjs.
  const shown = footer.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.ok(!/on this account/.test(shown),
    'tab order does not follow the account to another browser or device');
  const src2 = app();
  assert.ok(!/Tab order saved for you\.'/.test(src2),
    'the success toast must make the same promise the footer does');
});

// ── 23. The lesson instructions composer ────────────────────────────────────
//
// src/lib/lessonContent.js owns what a document MAY contain and test/lessonContent.test.mjs
// proves it. What lives only in the component is the lifecycle around it: when an upload
// is allowed to become part of a lesson, what happens to one that never does, and whether
// a save can proceed while bytes are still moving. Those are the parts that leak storage
// or save a lesson citing an image the database has never heard of.

const composer = () => {
  const src = app();
  const i = src.indexOf('function renderLessonComposer(');
  assert.ok(i > 0, 'renderLessonComposer was not found');
  return src.slice(i, src.indexOf('\n  function renderLessonEditor(', i));
};

/** The WYSIWYG canvas. Its own module, and deliberately not part of the monolith. */
const editor = () => readFileSync(join(REPO, 'src/editor/LessonDocumentEditor.jsx'), 'utf8');

/** The pure markdown↔document converter the canvas serializes through. */
const lessonDoc = () => readFileSync(join(REPO, 'src/lib/lessonDocument.js'), 'utf8');

/**
 * The ONE student lesson renderer, shared by the learner page and the editor's preview.
 *
 * The window runs to the next top-level function, so it can never be short — the old
 * learner-order test sliced a fixed 1400 characters and "Mark complete" sat past the end,
 * which made its last assertion pass on an indexOf of -1 rather than on the order it
 * claimed to check.
 */
const lessonCard = () => {
  const src = app();
  const i = src.indexOf('function LessonCard({');
  assert.ok(i > 0, 'LessonCard was not found');
  return src.slice(i, src.indexOf('\nfunction ', i + 1));
};

/**
 * The renderer that turns a lesson's stored markdown into elements a student reads.
 *
 * ★ SLICED ON THE COLUMN-ZERO BRACE, NOT WITH fnBody(). fnBody cuts at the first `\n  }`,
 *   and LessonRichText's `plain` early-return closes on one about sixty lines above the
 *   part worth checking — so that window would end before the link arm and every
 *   assertion below would pass against text it never saw.
 * ★ AND THE SEARCH IS `\n}`, NOT `\n}\n`. This working tree is CRLF, so a closing brace
 *   reads `\r\n}\r\n` and the trailing `\n` never follows the brace. `\nfunction ` (the
 *   lessonCard idiom above) survives that by accident — `\r\n` still contains `\n` — but
 *   anything asserting what comes AFTER the match does not.
 */
const richText = () => {
  const src = app();
  const i = src.indexOf('function LessonRichText({');
  assert.ok(i > 0, 'LessonRichText was not found');
  const end = src.indexOf('\n}', i);
  assert.ok(end > i, 'LessonRichText has no top-level close');
  return src.slice(i, end);
};

/**
 * Executable source only.
 *
 * ★ ASSERT AGAINST CODE, NEVER AGAINST "THIS STRING APPEARS NOWHERE IN THE FILE". That
 *   shape is defeated by the comment that EXPLAINS the invariant — a docblock reading
 *   "there is no Supabase import here and there must never be one" fails a naive scan for
 *   `supabase`, and the tempting fix is deleting the sentence that documents the rule.
 *   The same idiom as jsCode() in test/lessonContentSql.test.mjs.
 */
const jsCode = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('a description is demanded the moment an image lands, and blocks the save', () => {
  // ★ THE RULE SURVIVED THE REWRITE; ITS MECHANISM HAD TO CHANGE. It used to be "an image
  //   cannot be PLACED without a description" — which only worked because placement was a
  //   separate button press on a card below the box. The picture now appears at the caret
  //   the instant the upload finishes, which is the whole point, so "before placement" no
  //   longer exists as a moment. The same intent is kept by three things together.
  const ed = editor();
  // 1. The panel opens by itself on a new image — but does NOT steal the caret.
  assert.match(ed, /setPanel\('alt'\);\s*\n\s*setFocusPanel\(!busy\);/,
    'a description asked for later is a description never written — so it always OPENS');
  assert.match(ed, /announced\.current === assetId/,
    'and it fires once per image, not on every render');
  // ★ AN IMAGE BECOMES REAL WHEN ITS UPLOAD FINISHES — seconds after the creator moved on.
  //   Focusing unconditionally there yanked the caret mid-sentence and the rest of the
  //   sentence went into the alt field; with several images pasted at once, each
  //   completion stole it again. WCAG 3.2.2: focus must not move on something the user did
  //   not initiate. A panel the creator OPENS does take focus — that is togglePanel.
  assert.match(ed, /const busy = \(editor && !editor\.isDestroyed && editor\.isFocused\)/);
  assert.match(fnBody(ed, 'const togglePanel = (which) => {'), /setFocusPanel\(true\)/,
    'opening it deliberately is a different act from it opening itself');
  // 2. It is visible on the picture until it is filled in.
  assert.match(ed, /needsAlt \? ' needs-alt' : ''/);
  assert.match(ed, /Needs description/);
  assert.match(ed, /const needsAlt = !sanitizeAltText\(alt\)/,
    'whitespace is not a description — ask the module that owns the rule');
  // 3. The save still refuses, which is the part that cannot be skipped.
  const save = fnBody(app(), 'async function saveLesson() {');
  assert.match(save, /validateLessonContent\(d\.text_content, d\.content_format/,
    'IMAGE_ALT_REQUIRED is raised there, over the document as it will be stored');
});

test('a save is blocked while an image is still uploading', () => {
  const save = fnBody(app(), 'async function saveLesson() {');
  assert.match(save, /lessonImages\.some\(im => im\.status === 'uploading' \|\| im\.status === 'registering'\)/,
    "the token is already in the text but no asset row exists yet, so the trigger would "
    + 'refuse the whole save with an accurate error that reads like a bug');
  assert.match(save, /validateLessonContent\(d\.text_content, d\.content_format/,
    'every fault at once, not one round trip per fault');
});

test('an abandoned image upload is swept when the drawer closes', () => {
  const close = fnBody(app(), 'const closeLessonEditor = () => {');
  assert.match(close, /sweepLessonAssetOrphans\(\{[\s\S]*?sessionOnly: true/,
    'an image uploaded and never placed is an object no lesson cites — the same failure '
    + 'that left 1.60 GiB of orphaned video in production');
  // ★ AND IT IS MEASURED AGAINST THE SAVED ROW, NOT THE DRAFT BEING DISCARDED. Closing throws
  //   the draft away, so an image the creator PLACED in it is cited by nothing that survives —
  //   and the lesson was never saved, so no reference row exists either. Comparing against the
  //   draft skipped exactly the images this sweep exists to collect.
  assert.match(close, /citedText: originalEditingLesson\?\.text_content \|\| ''/,
    'the discard path must not treat the discarded draft as evidence that an image is in use');
  assert.match(close, /citedFormat: originalEditingLesson\?\.content_format/);
  assert.match(close, /setLessonImages\(\[\]\)/, 'and the session list must not leak into the next lesson');
});

test('the orphan sweep is session-exact, with an age-bounded crash-recovery pass', () => {
  const sweep = fnBody(app(), 'const sweepLessonAssetOrphans = async (');
  assert.match(sweep, /p_min_age: '1 day'/,
    'an unbounded broad sweep could delete an upload another admin is mid-way through '
    + 'in another tab');
  assert.match(sweep, /if \(sessionOnly\) return;/,
    'Cancel must sweep only what this session uploaded');
  assert.match(sweep, /cited\.has\(im\.assetId\)/,
    'what the SAVED text cites decides what survives, not what was uploaded');
});

test('deleting a lesson or a course cleans up the images they were the last to show', () => {
  const src = app();
  assert.match(fnBody(src, 'async function deleteLesson(l) {'), /sweepLessonAssetOrphans\(\)/);
  const del = src.slice(src.indexOf('async function deleteCourse('), src.indexOf('async function deleteCourse(') + 3000);
  assert.ok(del.indexOf('readCourseLessonAssets(c.id)') < del.indexOf("from('courses').delete()"),
    'the rows must be read BEFORE the course is deleted — afterwards they no longer name it');
  assert.ok(del.indexOf('purgeLessonAssets(lessonAssets)') > del.indexOf("from('courses').delete()"),
    'and purged after, so this course has stopped citing them');
});

test('pasting a remote image is refused, never hot-linked — and the words survive', () => {
  const ed = editor();
  const paste = fnBody(ed, 'const handlePaste = useCallback((event) => {');
  assert.ok(paste.includes('dt.files') && paste.includes('.filter('),
    'only real FILES are taken from the clipboard');
  assert.ok(paste.includes("getData('text/html')") && paste.includes('<img'),
    'and the HTML flavour is inspected — an image copied from a web page arrives as both');
  assert.ok(!/src\s*=\s*.?https?:/.test(paste), 'no remote URL may ever be adopted');

  // ★ FILES FIRST, AND CLAIM THE EVENT. One screenshot is on the clipboard as BOTH a file
  //   and an HTML fragment, so handling the file without returning true inserts it twice.
  const filesAt = paste.indexOf('if (files.length)');
  const htmlAt = paste.indexOf("getData('text/html')");
  assert.ok(filesAt > 0 && filesAt < htmlAt, 'the file branch must come first');
  assert.match(paste.slice(filesAt, htmlAt), /event\.preventDefault\(\); addFiles\(files\); return true;/,
    'claiming the event is what stops the same picture arriving twice');

  // ★ REFUSING THE PICTURE MUST NOT THROW AWAY THE WORDS — and the fix is now structural.
  //   The old handler called preventDefault() and had to re-insert the plain text by hand.
  //   The schema has no rule that turns an <img> into anything, so ProseMirror drops it and
  //   keeps the prose by itself; cancelling the paste would be what discards the paragraph.
  const htmlBranch = paste.slice(htmlAt);
  assert.ok(!/preventDefault/.test(htmlBranch),
    'the <img> branch must NOT cancel the paste, or the prose goes with the picture');
  assert.match(htmlBranch, /noticeRef\.current\?\.\(REMOTE_IMAGE_NOTICE\)/,
    'but it must still say what happened');
  assert.match(ed, /The text was pasted\. The picture in it was not/,
    'saying only "not added" about a paste that DID keep the text is the bug reported');
  // And the structural half: nothing in a pasted document may become an image node.
  const imgNode = ed.slice(ed.indexOf("name: 'lessonImage'"), ed.indexOf("name: 'uploadingImage'"));
  assert.match(imgNode, /parseHTML\(\) \{ return \[\]; \}/,
    'an image gets into a lesson by being uploaded, and only then');
});

test('images are resolved in ONE batched signing call per lesson, and refreshed', () => {
  const hook = fnBody(app(), 'function useLessonAssetUrls(lesson) {');
  assert.match(hook, /createSignedUrls\(paths, LESSON_ASSET_SIGN_TTL_SECONDS\)/,
    'ten images on a lesson page is two requests, not eleven');
  assert.ok(!/createSignedUrl\(/.test(hook.replace(/createSignedUrls\(/g, '')),
    'the singular form here would be one request per image');
  assert.match(hook, /LESSON_ASSET_RESIGN_MARGIN_MS/,
    'a student reading past the hour would otherwise watch every screenshot break');
});

test('an edit lands where the caret is, and the canvas is never re-seeded under it', () => {
  // ★ THE OLD HAZARD IS GONE BY CONSTRUCTION, AND A NEW ONE TOOK ITS PLACE. Offsets into a
  //   markdown string are no longer how anything is inserted — ProseMirror owns the
  //   selection — so "the caret was captured as 0 and the link went to the top" cannot
  //   happen. What CAN happen is worse and quieter: re-deriving the document from the prop
  //   on every render wipes the caret and the undo history while somebody is typing.
  const ed = editor();
  assert.match(ed, /const initialDoc = useMemo\(\s*\n\s*\(\) => markdownToDoc\(initialMarkdown, initialFormat\),/,
    'the document is derived from the prop ONCE');
  const memo = ed.slice(ed.indexOf('const initialDoc = useMemo('), ed.indexOf('const extensions = useMemo('));
  assert.match(memo, /\[\],\s*\n\s*\);/, 'with an EMPTY dep array — mount only');
  assert.match(ed, /useEditor\(\{[\s\S]*?\}, \[\]\);/,
    'and the editor instance itself is never rebuilt by a dep change');
  // ★ THE PARENT SUPPLIES IDENTITY, AND IT MUST BE THE LESSON ID ALONE. The key was
  //   `${d.id}:${fmt}` and `fmt` reads the DRAFT — but a new lesson is selected with
  //   COURSE_LESSON_SELECT_LEGACY, which carries no content_format, so it mounted as
  //   'plain' and the FIRST edit set content_format:'markdown'. The key changed, React
  //   remounted the editor mid-type, focus dropped to <body>, undo history went, and a
  //   screenshot pasted as the first action was lost with its upload orphaned — a pending
  //   placeholder serializes to nothing, so even an empty document tripped it.
  assert.match(composer(), /key=\{d\.id\}/, 'keyed on the lesson, and nothing that changes while editing');
  const c = composer();
  assert.ok(!/key=\{`\$\{d\.id\}:/.test(c), 'no draft-derived value may ever enter this key');
  assert.ok(!/COURSE_LESSON_SELECT_LEGACY.*content_format/.test(app()),
    'the frozen legacy select still has no content_format — which is why the above matters');
  // Ctrl/Cmd+K still has to reach the link bar, through a ref so it cannot go stale.
  assert.match(ed, /'Mod-k': \(\) => \{ handlersRef\.current\?\.openLink\?\.\(\); return true; \}/,
    'a keyboard shortcut that closes over render-scope state is a shortcut that stops working');
});

test('closing a composer control without editing hands focus back to the document', () => {
  // ★ SAME RULE, NEW SURFACE. Escape and Cancel each UNMOUNT the element holding focus, and
  //   a browser then moves focus to <body>: a keyboard user is dropped at the top of the
  //   page with the drawer still open (WCAG 2.4.3). The target used to be the textarea; it
  //   is the canvas now, and ProseMirror restores its own selection when refocused.
  const ed = editor();
  const close = fnBody(ed, 'const closeLink = useCallback((e) => {');
  assert.match(close, /e\.preventDefault\(\); e\.stopPropagation\(\);/,
    'see the Escape test below for why stopPropagation is not optional here');
  assert.match(close, /editor\?\.chain\(\)\.focus\(\)\.run\(\)/,
    'focus goes back to the document, not to <body>');
  // Both dismissals route through it rather than each hand-rolling the same two steps.
  assert.match(ed, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape' && linkBar\) closeLink\(e\); \}\}/);
  assert.match(ed, /onClick=\{closeLink\} aria-label="Cancel"/);
  // The image panel is the third such control, and it dismisses the same way.
  const panelClose = fnBody(ed, 'const closePanel = (e) => {');
  assert.match(panelClose, /e\.preventDefault\(\); e\.stopPropagation\(\);/,
    'an image panel inside the canvas must not let Escape reach the drawer either');
});

test('a database without the migration degrades to plain text with an actionable notice', () => {
  const c = composer();
  assert.match(c, /const preRich = lessonRowsArePreRichContent\(allLessons\)/);
  assert.match(c, /db\/2026-09-20-course-lesson-assets\.sql/,
    'the notice must name the file to run, not merely say a feature is unavailable');
  // ★ THE CANVAS IS NOT MOUNTED AT ALL THERE, which is a stronger guarantee than the old
  //   `onPaste={preRich ? undefined : …}`: there is no surface to paste an image into, so
  //   no upload can start against a database with nowhere to record it.
  assert.match(c, /const usesCanvas = !preRich && !needsFormatOptIn;/);
  assert.match(c, /\{usesCanvas \? \(/, 'the canvas renders only when both are false');
  const plainBranch = c.slice(c.indexOf('<textarea'));
  assert.ok(!/onPaste/.test(plainBranch), 'and the plain field takes no image paste at all');
});

test('the formatting opt-in guards SAVED prose, not what was just typed', () => {
  // ★ CAUGHT IN THE BROWSER. Reading the DRAFT here meant that writing the first sentence
  //   of a brand-new lesson made it non-empty, which replaced the whole toolbar with
  //   "Turn on formatting" — the creator typed one line and the Link button vanished.
  //   Nothing written in this session needs protecting from reinterpretation; only text
  //   already STORED as plain can be silently changed by turning formatting on.
  const src = app();
  const at = src.indexOf('const needsFormatOptIn =');
  assert.ok(at > 0, 'needsFormatOptIn moved');
  const line = src.slice(at, src.indexOf('\n', at));
  assert.match(line, /savedLessonText/, 'the question must be about the SAVED row');
  assert.ok(!/editingLesson\?\.text_content/.test(line),
    'reading the draft here is the bug this test exists to prevent');
  assert.match(src, /const savedLessonText = \(originalEditingLesson\?\.text_content \|\| ''\)\.trim\(\);/);
});

test('students read the instructions below the video and above the replay link', () => {
  // The owner asked for this placement in words: "It will be shown below the video
  // tutorial as instruction". #37b already fixed the replay card's slot ("below the lesson
  // body and above Mark complete"), so the instructions have to land between the title and
  // that card — which is also the reading order a lesson actually has.
  const src = app();
  // The window is the WHOLE card now (lessonCard() runs to the next top-level function),
  // so it cannot be accidentally short the way a fixed 1400-character slice was.
  const card = lessonCard();
  const iStage = card.indexOf('{stageLesson && <LessonStage');
  const iTitle = card.indexOf('{lesson.title}', iStage);
  const iBody = card.indexOf('<LessonRichText lesson={lesson}', iTitle);
  const iReplay = card.indexOf('<LessonReplayLink', iBody);
  const iDone = card.indexOf('Mark complete', iReplay);
  for (const [name, i] of [['stage', iStage], ['title', iTitle], ['body', iBody],
    ['replay', iReplay], ['done', iDone]]) {
    assert.ok(i > 0, `${name} not found — the lesson card was restructured`);
  }

  assert.ok(iTitle > iStage, 'the media stage comes first, then the title');
  assert.ok(iBody > iTitle, 'instructions come after the title');
  assert.ok(iReplay > iBody, 'and BEFORE the Zoom replay card');
  assert.ok(iDone > iReplay, 'which is itself before the completion controls');

  // ★ AND THIS IS NOW THE ONLY ORDER THAT EXISTS. #37b's placement contract lives in
  //   course_lessons.zoom_replay_url's COMMENT; before the extraction the editor's
  //   student preview could have shipped a second, silently different one.
  const renders = (src.match(/<LessonCard\b/g) || []).length;
  assert.ok(renders >= 1 && renders <= 2,
    `expected the student page and (once built) the editor preview — found ${renders} renders `
    + 'of LessonCard. A third is a third place the reading order could differ.');
});

test('both learner render sites go through the same safe renderer', () => {
  const src = app();
  const uses = (src.match(/<LessonRichText lesson=/g) || []).length;
  assert.ok(uses >= 2, 'a text lesson and a video lesson\'s notes must share one renderer');
  // ★ A RATCHET THAT CAN NO LONGER FAIL IS NOT A RATCHET. The assertion below used to
  //   name `activeLesson.text_content` only — and after the card was extracted that
  //   identifier stopped existing inside it, so the check quietly became unfailable
  //   while still reading like a guarantee. Police both spellings.
  for (const id of ['lesson', 'activeLesson']) {
    assert.ok(!new RegExp(`whitespace-pre-line leading-relaxed text-\\[15px\\]">\\{${id}\\.text_content\\}`).test(src),
      `the old raw render must be gone, not merely renamed (${id})`);
  }
  assert.ok(!/whitespace-pre-line leading-relaxed text-\[15px\]">\{lesson\.text_content\}/.test(src),
    'the old raw text-lesson render must be gone, not merely bypassed');
  assert.ok(!/whitespace-pre-line leading-relaxed text-\[15px\]">\{activeLesson\.text_content\}/.test(src),
    'and the old raw video-notes render too');
});

test('a lesson link is plain words — its destination is announced, not printed', () => {
  // ★ OWNER DECISION, 2026-09-24. A link used to render as `here (us06web.zoom.us) ↗`:
  //   the host in grey parentheses whenever the visible words did not already contain it,
  //   plus an arrow. The reasoning was sound — an opaque label pointed at a lookalike
  //   domain is a phishing shape, and a student on a phone cannot hover — but the PRICE
  //   was wrong. Writing a lesson needs course_lessons write access, i.e. staff, never a
  //   student or a community member; the clutter was paid by every honest link in every
  //   lesson. So the disclosure moved to channels that cost no pixels. It was NOT dropped,
  //   and the assertions below police both halves of that sentence.
  // ★ jsCode() IS LOAD-BEARING HERE. The comment in the source names the removed chip, so
  //   a raw scan would be defeated by the very text explaining the rule.
  const code = jsCode(richText());
  const a = code.indexOf("case 'link': {");
  const b = code.indexOf('default: return null;', a);
  assert.ok(a > 0 && b > a, 'the link arm of LessonRichText was not found');
  const link = code.slice(a, b);

  // 1. Nothing is painted after the words. Both ornaments are gone.
  assert.ok(!/shownHost/.test(link),
    'the grey "(host)" chip beside a lesson link was removed deliberately — do not '
    + 'reinstate it "for safety"; the host now rides the accessible name instead');
  assert.ok(!/<ExternalLink/.test(link),
    'and so did the arrow after it — the owner asked for a plain link, matching Thinkific');

  // 2. But it MOVED rather than vanished. A screen reader is told where an opaque link
  //    goes — which today it learns only because that grey span sat inside the <a>.
  assert.match(link, /'aria-label': ariaLabel/,
    'an opaque link must still name its destination to a screen reader');
  assert.match(link, /opens \$\{t\.host\} in a new tab/,
    'and it must name the HOST, not merely say the link opens somewhere else');
  assert.match(link, /title: `Opens \$\{t\.host\} in a new tab`/,
    'the hover tooltip stays too — that is the desktop half of the same fact');

  // 3. It is the SAME condition the chip used, so exactly the links that showed a host
  //    now speak one, and a label already reading "zoom.us" gains no new verbosity.
  assert.match(link, /tokenText\(t\.tokens\)/,
    'the opaque-label test must survive, or every link starts announcing a host');
  assert.match(link, /!words\.toLowerCase\(\)\.includes\(t\.host\.toLowerCase\(\)\)/,
    'a label that already states its host must not repeat it');

  // ★ THE VISIBLE WORDS COME FIRST. An aria-label REPLACES the link text as the
  //   accessible name, so one not leading with what is on screen breaks WCAG 2.5.3
  //   Label in Name — a speech-input user saying "click here" stops matching "here".
  assert.match(link, /`\$\{words\} — opens/,
    'the accessible name must begin with the words actually on screen');

  // ★ AND A LINK WITH NO VISIBLE WORDS STILL GETS ONE. `[](url)` and `[   ](url)` both
  //   parse to a real link, and the removed chip was incidentally the only thing naming
  //   them — so gating the label on `words` (the first attempt here) left an unlabelled
  //   link, a WCAG 4.1.2 failure the chip version did not have.
  assert.ok(!/t\.host && words\b/.test(link),
    'the label must NOT be gated on there being visible words — that leaves `[](url)` '
    + 'with no accessible name at all. The empty case takes a host-only label instead.');
  assert.match(link, /\? \(words \? `\$\{words\} — opens \$\{t\.host\} in a new tab`/,
    'words present: the visible words lead the accessible name');
  assert.match(link, /: `Opens \$\{t\.host\} in a new tab`\)/,
    'no words: the destination alone becomes the accessible name, so the link is named');
});

test('a cancelled upload cannot reappear, and its object is still collected', () => {
  // ★ THE OLD DEFECT IS UNREACHABLE NOW, BY REMOVING THE SECOND MECHANISM RATHER THAN
  //   FIXING IT. Cancelling used to mean flipping a card to 'cancelled', which three
  //   separate points in the upload then had to re-check — and the one in the catch block
  //   was missing, so a dismissed upload that then failed came back offering Retry.
  //   Cancelling is now deleting the placeholder node. The upload finishes, finds no
  //   placeholder, and stops; nothing can put it back on screen because the thing that
  //   would have drawn it is gone.
  const ed = editor();
  const settle = fnBody(ed, 'const settleUpload = useCallback((uploadKey, assetId) => {');
  assert.match(settle, /if \(!at\) \{ releasePreview\(uploadKey\); pendingFilesRef\.current\.delete\(uploadKey\); return false; \}/,
    'no placeholder means the creator took it out — respect that and clean up');
  const fail = fnBody(ed, 'const failUpload = useCallback((uploadKey, message) => {');
  assert.match(fail, /if \(!at\) \{ releasePreview\(uploadKey\); pendingFilesRef\.current\.delete\(uploadKey\); return; \}/,
    'and a FAILURE after a cancel must not resurrect it either — this is the old bug');
  // The object still exists in storage, so the sweep has to be the thing that collects it.
  const sweep = fnBody(app(), 'const sweepLessonAssetOrphans = async (');
  assert.match(sweep, /cited\.has\(im\.assetId\)/,
    'what the text cites decides what survives; a cancelled upload cites nothing');
});

test('removing an image never deletes its bytes on the click — the sweep decides', () => {
  // ★ AN IMMEDIATE DELETE IS UNDO-UNSAFE, AND THIS SCHEMA HAS UNDO. Remove used to call
  //   course_lesson_asset_delete straight away. For an image uploaded in this session no
  //   reference row exists yet, so LESSON_ASSET_IN_USE cannot fire and the row and the
  //   bytes went — then one Ctrl+Z brought the node back pointing at an asset that no
  //   longer existed. validateLessonContent cannot see that, so the save reached the
  //   trigger and died on LESSON_ASSET_UNKNOWN_REF, with the picture still on screen and
  //   no way out but finding and deleting that node by hand. The same click also killed a
  //   SECOND copy of the same image elsewhere in the lesson, which the format allows.
  const ed = editor();
  const code = jsCode(ed);
  assert.ok(!/course_lesson_asset_delete/.test(code),
    'the canvas must not reach the delete RPC at all');
  assert.ok(!/onDropped/.test(code), 'nor route a deletion request out through a prop');
  const bar = ed.slice(ed.indexOf('className="lesson-doc-figure-bar"'), ed.indexOf('{panel && !readOnly'));
  assert.match(bar, /onClick=\{\(\) => \{ deleteNode\(\); restoreFocus\(\); \}\}/,
    'Remove takes the node out of the document, and nothing else');
  // What survives is decided by what the SAVED text cites — the sweep's job, and it
  // already runs on both ways out of the drawer.
  const src = app();
  assert.match(fnBody(src, 'const closeLessonEditor = () => {'), /sweepLessonAssetOrphans\(\{/);
  assert.match(fnBody(src, 'async function saveLesson() {'), /await sweepLessonAssetOrphans\(\);/);
  assert.match(fnBody(src, 'const sweepLessonAssetOrphans = async ('), /cited\.has\(im\.assetId\)/,
    'and it is the SAVED text that decides, not a click');
});

test('a refused save lands on the image it is refusing', () => {
  const src = app();
  const at = src.indexOf('const contentVerdict = validateLessonContent(');
  assert.ok(at > 0, 'the save validation moved');
  const block = src.slice(at, at + 1600);
  // ★ A FOOTER ALERT ON ITS OWN LEAVES THE CREATOR HUNTING. IMAGE_ALT_REQUIRED carries the
  //   asset id precisely so it does not have to — and in a long document the offending
  //   picture is very likely scrolled out of sight.
  assert.match(block, /errors\.find\(e => e\.assetId\)/,
    'IMAGE_ALT_REQUIRED names the image it means — use it');
  assert.match(block, /lessonEditorRef\.current\?\.focusImage\(named\.assetId\)/,
    'select it in the canvas, which scrolls it in and opens its own controls');
  assert.match(block, /lessonBodyRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
    'and fall back for a fault in the prose, or a lesson still on the plain field');
  // The canvas half: selecting an image has to scroll it into view, or "focus" is a claim
  // about the DOM that the creator cannot see.
  const focusImage = editor().slice(editor().indexOf('focusImage: (assetId) => {'));
  assert.match(focusImage, /setNodeSelection\(pos\)/);
  assert.match(focusImage, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
  assert.match(focusImage, /return false;/, 'and it reports when there was nothing to select');
});

test('every toolbar control is inert while the lesson is being saved', () => {
  // ★ THE OLD SHAPE OF THIS RULE IS RETIRED WITH PREVIEW. Buttons used to edit
  //   text_content at a remembered caret, so pressing one in Preview changed the document
  //   with nothing on screen to show it had. The canvas IS the render, so there is no such
  //   state — but there is still a window where editing must not happen: mid-save, when
  //   the payload has been read and a write is in flight.
  const ed = editor();
  const bar = ed.slice(ed.indexOf('aria-label="Formatting"'), ed.indexOf('<div className="lesson-doc-canvas">'));
  const buttons = bar.match(/<ToolButton/g) || [];
  const guards = bar.match(/disabled=\{disabled( \|\| [^}]+)?\}/g) || [];
  assert.equal(guards.length, buttons.length,
    'every toolbar control must be gated, not just the ones that felt dangerous');
  assert.ok(buttons.length >= 7, `expected bold, two lists, link, image, undo, redo — found ${buttons.length}`);
  assert.match(composer(), /disabled=\{savingLesson\}/, 'and the parent is what says so');
  // The surface itself, not only its buttons.
  assert.match(ed, /if \(editor\) editor\.setEditable\(!disabled\)/,
    'a disabled toolbar over a typeable document is not disabled');
  // The Source view is the one place raw markdown is visible, and it is READ-ONLY.
  const c = composer();
  const details = c.slice(c.indexOf('<details'));
  assert.match(details, /<pre/, 'the source is rendered, never edited');
  assert.ok(!/<textarea|contentEditable/.test(details),
    'a source view that can be typed into is a markdown editor by another name');
});

test('a link can be edited and unlinked, not only created', () => {
  // ★ THE WHOLE CLASS OF "THE CAPTURED RANGE WENT STALE" IS GONE. The old bar remembered
  //   character offsets into a markdown string while the textarea stayed editable beneath
  //   it, so typing moved the token and Update/Unlink then spliced blind over whatever had
  //   taken its place. ProseMirror maps positions through every intervening step, so there
  //   is nothing to re-derive and nothing to go stale — which is why liveLinkRange and its
  //   LINK_MOVED message no longer exist.
  const src = app();
  assert.ok(!/liveLinkRange|LINK_MOVED/.test(src),
    'the offset-revalidation machinery must be gone, not merely bypassed');

  const ed = editor();
  const open = fnBody(ed, 'const openLink = useCallback(() => {');
  assert.match(open, /const existing = editor\.getAttributes\('link'\)/,
    'the caret being INSIDE a link is what opens it for editing');
  assert.match(open, /editing: !!existing\.href/);
  const confirm = fnBody(ed, 'const confirmLink = useCallback(() => {');
  assert.match(confirm, /if \(linkBar\.editing\) chain\.extendMarkRange\('link'\)/,
    'an edit must replace the WHOLE existing link, or re-linking nests one inside another');
  assert.match(confirm, /const verdict = safeLessonHref\(linkBar\.href\)/,
    'and the address is re-checked at the moment it is applied');

  const unlink = fnBody(ed, 'const removeLink = useCallback(() => {');
  assert.match(unlink, /extendMarkRange\('link'\)\.unsetMark\('link'\)/,
    'Unlink keeps the words and drops only the address');
  assert.match(ed, /\{linkBar\.editing && \(/, 'Unlink only shows when a link is being edited');
});

test('Escape inside the canvas dismisses what is open there, not the whole lesson editor', () => {
  // ★ preventDefault IS NOT ENOUGH. SidePanel listens for Escape on WINDOW, so the event
  //   reaches it from anything inside the drawer and closes it — which then asks "Discard
  //   unsaved lesson changes?". Dismissing a small inline control must never put a draft
  //   at risk, and the canvas now has three such controls.
  const ed = editor();
  assert.match(ed, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape' && linkBar\) closeLink\(e\); \}\}/,
    'the shell claims Escape only while something inside it is open');
  const close = fnBody(ed, 'const closeLink = useCallback((e) => {');
  assert.match(close, /e\.stopPropagation\(\)/,
    'the handler must stop the event before the drawer\'s window listener sees it');
  const panelClose = fnBody(ed, 'const closePanel = (e) => {');
  assert.match(panelClose, /e\.stopPropagation\(\)/, 'and the image panel does the same');

  const src = app();
  const panel = src.slice(src.indexOf('function SidePanel'), src.indexOf('function SidePanel') + 2600);
  assert.match(panel, /window\.addEventListener\('keydown', onKey\)/,
    'this is why: the drawer listens on window, above the React root');
  // ★ AND Escape WITH NOTHING OPEN MUST STILL REACH THE DRAWER. Claiming it unconditionally
  //   would make a contenteditable the one surface in the app you cannot Escape out of.
  assert.ok(!/onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape'\) \{ e\.stopPropagation/.test(ed),
    'an unconditional stopPropagation would trap the creator in the editor');
});

test('the canvas is reachable and escapable by keyboard', () => {
  const src = app();
  // ★ [contenteditable] IS IN THE FOCUS-TRAP SELECTOR BECAUSE THE CANVAS IS ONE. Without
  //   it the editing surface is invisible to the wrap: the browser still tabs INTO it, but
  //   first/last are computed as if it were not there, so Shift+Tab from the top lands past
  //   the document instead of at the end of the drawer.
  const panel = src.slice(src.indexOf('function SidePanel'), src.indexOf('function SidePanel') + 2400);
  assert.match(panel, /\[contenteditable="true"\]/,
    'the one focusable element in the drawer that is neither input nor button');
  // ★ AND TAB INSIDE IT MOVES FOCUS OUT, RATHER THAN INDENTING. ListItem binds Tab to
  //   sink/lift by default; nesting is unrepresentable here, so those would be a keyboard
  //   trap that does nothing at all (WCAG 2.1.2).
  const ed = editor();
  assert.match(ed, /addKeyboardShortcuts\(\) \{ return \{ Tab: \(\) => false, 'Shift-Tab': \(\) => false \}; \}/,
    'returning false leaves the event unhandled, so the browser moves focus');
  assert.match(ed, /content: 'paragraph',/,
    'and nesting is impossible by schema, so there is nothing for Tab to do');
  // Every control carries a name; an icon-only button with none is a button with no label.
  assert.match(ed, /aria-label=\{label\}/);
  const tools = ed.match(/<ToolButton\s+label="[^"]+"/g) || [];
  assert.ok(tools.length >= 7, `every toolbar control needs a label — found ${tools.length}`);
});

test('a caption is a second, optional field — never the alt text', () => {
  // ★ ALT IS ANNOUNCED; A CAPTION IS PRINTED. Using one as the other makes a screen reader
  //   read the same sentence twice, so they are two fields and only the first is required.
  const ed = editor();
  const panel = ed.slice(ed.indexOf('{panel && !readOnly && ('), ed.indexOf('function UploadingImageView'));
  assert.match(panel, /maxLength=\{LESSON_IMAGE_ALT_MAX\}/);
  assert.match(panel, /Caption \(optional\)/, 'the caption is optional and says so');
  assert.match(panel, /maxLength=\{LESSON_IMAGE_CAPTION_MAX\}/);
  assert.match(panel, /updateAttributes\(\{ caption: e\.target\.value \}\)/);
  assert.match(panel, /updateAttributes\(\{ alt: e\.target\.value \}\)/);
  // ★ And assistive tech is TOLD alt is required — the red asterisk carries aria-hidden, so
  //   without this the field announced as an ordinary optional input.
  assert.match(panel, /required aria-required="true"/);
  assert.match(panel, /aria-invalid=\{needsAlt \|\| undefined\}/);
  assert.ok(!/required/.test(panel.slice(panel.indexOf('Caption (optional)'))),
    'the caption must never be required');
  // Both reach the document as node attributes, and the caption is rendered under the image.
  assert.match(ed, /assetId: \{ default: '' \}, alt: \{ default: '' \}, caption: \{ default: '' \}/);
  assert.match(ed, /<figcaption className="lesson-doc-caption">\{caption\}<\/figcaption>/,
    'a caption nobody can see is a caption that was not written');
});

test('a selected image offers every action, and Replace keeps the words', () => {
  const ed = editor();
  const bar = ed.slice(ed.indexOf('className="lesson-doc-figure-bar"'), ed.indexOf('{panel && !readOnly'));
  for (const action of ['Add description|Description', 'Add caption|Caption', 'Replace', 'Remove']) {
    assert.ok(new RegExp(action).test(bar), `the action bar is missing ${action}`);
  }
  // ★ REPLACE SWAPS THE PICTURE AND KEEPS THE DESCRIPTION. Alt and caption describe what
  //   the image SHOWS, and a replacement is nearly always a fresh capture of the same
  //   thing — so updateAttributes carries only the id.
  const swap = fnBody(ed, 'const onPickReplacement = async (e) => {');
  assert.match(swap, /updateAttributes\(\{ assetId: res\.assetId \}\)/,
    'only the id changes; alt and caption survive');
  // ★ AND THE OLD ASSET IS NOT DELETED HERE EITHER — same reason as Remove. The swap only
  //   has to succeed BEFORE anything else happens, so a failed upload cannot leave the
  //   lesson citing a picture that is already gone.
  assert.match(swap, /if \(res && res\.ok && res\.assetId\) \{/,
    'the new id must exist before the node is repointed');
  assert.match(swap, /onNotice\?\.\(/, 'a failed replacement has to say so');
  assert.ok(!/onDropped|course_lesson_asset_delete/.test(jsCode(swap)),
    'replacing must not destroy bytes a duplicate elsewhere may still be showing');
  // The hidden input needs a name of its own; it is the thing a screen reader lands on.
  assert.match(ed, /aria-label="Choose a replacement image"/);
});

test('an image is never shown larger than it is, and a bad file is refused before it appears', () => {
  // ★ `width: 100%` UPSCALES. A small screenshot, an icon or a logo was blown up to the
  //   full canvas width and rendered blurry — found by watching a 2x2 test image fill an
  //   800px box, not by reading the rule.
  const block = css().slice(css().indexOf('.lesson-doc-image {'), css().indexOf('.lesson-doc-image.is-dim'));
  assert.match(block, /max-width: 100%/);
  assert.ok(!/^\s*width: 100%/m.test(block), 'width:100% forces a small picture to be upscaled');
  assert.match(block, /height: auto/, 'or the aspect ratio goes');
  // Refusing before a placeholder exists also means no object URL is minted for it.
  const add = fnBody(editor(), 'const addFiles = useCallback((files) => {');
  const validateAt = add.indexOf('validateLessonImageFile(file)');
  const urlAt = add.indexOf('URL.createObjectURL');
  assert.ok(validateAt > 0 && urlAt > 0 && validateAt < urlAt,
    'validate BEFORE minting an object URL nobody would revoke');
});

// ── 24. The instructions canvas cannot store what it cannot represent ───────
//
// src/lib/lessonDocument.js proves the CONVERSION is faithful, and
// test/lessonDocument.test.mjs covers it exhaustively. What only a source scan can prove
// is that the editor module never grew a second way in: another parseHTML rule, another
// scheme authority, an innerHTML escape hatch, or a Supabase client of its own.

test('the editor schema is exactly the allowlist, and nothing else is enabled', () => {
  const ed = editor();
  const code = jsCode(ed);
  // Nothing may be imported that is not in the allowlist — "do not enable every default
  // extension merely because it is available" is kept by not INSTALLING them.
  assert.ok(!/@tiptap\/starter-kit/.test(code),
    'StarterKit brings headings, italic, strike, code, code blocks, blockquote and rules');
  assert.ok(!/@tiptap\/extension-link/.test(code),
    'that package brings linkifyjs, whose idea of a URL is not safeLessonHref');
  for (const banned of ['Heading', 'Italic', 'Strike', 'Underline', 'CodeBlock', 'Blockquote',
    'HorizontalRule', 'Table', 'Youtube', 'TextStyle', 'Color', 'FontFamily']) {
    assert.ok(!new RegExp(`import .*\\b${banned}\\b`).test(code), `${banned} must not be imported`);
  }
  // The node list the schema is built from, in one place, matching the pure module's.
  assert.match(ed, /export const buildLessonExtensions = \(handlersRef, placeholder\) => \[/);
  const built = ed.slice(ed.indexOf('export const buildLessonExtensions'), ed.indexOf('// ─', ed.indexOf('export const buildLessonExtensions')));
  for (const node of ['Document', 'Paragraph', 'Text', 'HardBreak', 'Bold', 'BulletList',
    'OrderedList', 'FlatListItem', 'LessonLink', 'LessonImage', 'UploadingImage', 'BrokenToken']) {
    assert.ok(built.includes(node), `${node} must be in the extension list`);
  }
});

test('the canvas has no second door: no innerHTML, no Supabase, no other scheme authority', () => {
  const ed = editor();
  const code = jsCode(ed);
  assert.ok(!/dangerouslySetInnerHTML/.test(code),
    'the whole point is that unsafe markup is unrepresentable, not filtered');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
  // ★ NO SUPABASE, AND NOTHING FROM THE MONOLITH. The first would put storage credentials
  //   and RPC names in a module whose job is text; the second would pull the 37k-line
  //   BookkeeperPro into this lazy chunk and undo the code-splitting entirely.
  assert.ok(!/supabase/i.test(code), 'every Supabase call stays in the parent, behind props');
  assert.ok(!/course_lesson_asset_|storage\.from\(/.test(code),
    'no RPC name and no bucket reach this module — the parent owns both');
  assert.ok(!/from '\.\.\/BookkeeperPro/.test(code), 'one design-token import would cost ~440 KB gzip');
  // safeLessonHref is the ONLY thing that decides a scheme, on the way in as well as out.
  const linkMark = ed.slice(ed.indexOf('const LessonLink = Mark.create('), ed.indexOf('const LessonImage'));
  assert.match(linkMark, /const verdict = safeLessonHref\(el\.getAttribute\('href'\)\)/,
    'a pasted link is judged by the same function the serializer uses');
  assert.match(linkMark, /: false;/, 'and returning false REFUSES the mark, keeping the words');
  assert.match(linkMark, /rel: 'noopener noreferrer', target: '_blank'/,
    'an editor preview still opens a real browser tab');
});

test('an upload placeholder is transient, and its object URL is released', () => {
  const ed = editor();
  // ★ NEVER STORED. The asset row does not exist while bytes are moving, so a token for it
  //   would make the trigger refuse the whole save with an accurate error reading like a bug.
  assert.match(ed, /\/\*\* A transfer in progress\. Never serialized/);
  // ★ The placeholder is an ATOM with no content, so the serializer has nothing to emit for
  //   it even if every explicit exclusion were deleted — which means a removal mutation
  //   survives by design. Scan the serializer for the upload key instead, the idiom
  //   CLAUDE.md prescribes for exactly this case. (The line that used to sit here was
  //   `assert.ok(render === '' || true)` — unfailable, and reported by code review.)
  assert.match(lessonDoc(), /uploadKey/,
    'the serializer must still name uploadKey — that is what makes the exclusion checkable');
  assert.ok(!/uploadingImage/.test(jsCode(app())),
    'the placeholder is the editor module\'s business; the monolith must not learn about it');
  const lib = readFileSync(join(REPO, 'src/lib/lessonDocument.js'), 'utf8');
  assert.match(lib, /if \(n\.type === 'uploadingImage'\) continue;/,
    'the serializer must have no case for it at all');
  assert.match(lib, /case 'uploadingImage':/, 'and normalization drops it before that');
  // ★ OBJECT URLS ARE REVOKED. A held preview of a 10 MB screenshot is a leak nobody sees.
  assert.match(ed, /URL\.revokeObjectURL/);
  assert.match(ed, /objectUrlsRef\.current\.forEach\(\(u\) => \{ try \{ URL\.revokeObjectURL\(u\); \}/,
    'and again on unmount, for the ones no placeholder ever released');
  // ★ THE PLACEHOLDER IS FOUND BY KEY AT COMMIT TIME, not by a position captured when the
  //   transfer started — the creator keeps typing, and that position moves.
  const settle = fnBody(ed, 'const settleUpload = useCallback((uploadKey, assetId) => {');
  assert.match(settle, /findUpload\(uploadKey\)/);
  assert.ok(!/getPos\(\)/.test(settle), 'a remembered position is a position that has moved');
  // ★ AND IT MUST NOT DISPATCH INTO A DESTROYED VIEW. closeLessonEditor deliberately does
  //   NOT wait for an image upload, so a transfer regularly settles after ProseMirror has
  //   torn the view down. Dispatching there throws inside a catch that then throws again —
  //   an unhandled rejection with no cause a user could ever see.
  assert.match(fnBody(ed, 'const findUpload = useCallback((uploadKey) => {'),
    /if \(!editor \|\| editor\.isDestroyed\) return null;/,
    'a closed drawer is not a null editor — it is a destroyed one');
});

test('the canvas debounces, and the save reads the LIVE document anyway', () => {
  // ★ SERIALIZING IS ~6 ms ON A FULL-SIZE LESSON even with the block cache, and the parent
  //   then runs two JSON.stringify dirty checks and a synchronous localStorage write of the
  //   whole draft. Per keystroke that is visible lag — measured at 16 ms before the cache.
  const ed = editor();
  assert.match(ed, /onUpdate: \(\{ editor: ed \}\) => \{ scheduleEmit\(ed\); \}/);
  assert.match(ed, /onBlur: \(\{ editor: ed \}\) => \{ flushEmit\(ed\); \}/,
    'blur is a flush point — clicking Cancel or Save blurs the canvas first');
  assert.match(fnBody(ed, 'const scheduleEmit = useCallback((ed) => {'), /setTimeout\(/);
  // ★ AND THE PARENT MUST NEVER READ A STALE DOCUMENT. A save triggered any other way
  //   would otherwise race the debounce and store the text as of 180 ms ago.
  // ★ ONE DERIVATION, TWO CALLERS — the LessonCard rule, one level down in the DATA. The
  //   save and the student preview must agree about what the lesson SAYS; if the preview
  //   re-derived its own live copy, a creator could approve text the save would not store.
  const src = app();
  const live = fnBody(src, 'function liveLessonDraft() {');
  assert.match(live, /const liveMarkdown = lessonEditorRef\.current\?\.getMarkdown\?\.\(\);/,
    'the live draft reads the canvas directly rather than trusting the debounced copy');
  // ★ THE `!==` GUARD IS LOAD-BEARING, NOT AN OPTIMIZATION. On a pre-#65 database, and for
  //   legacy prose still on the plain field, there IS no canvas — the ref is null and
  //   getMarkdown is undefined. Without the typeof/!== pair, merely OPENING such a lesson
  //   would stamp content_format:'markdown' on it and escape its metacharacters on save.
  assert.match(live, /typeof liveMarkdown === 'string' && liveMarkdown !== editingLesson\.text_content/,
    'a lesson with no canvas must come back untouched');
  assert.match(live, /content_format: 'markdown'/);
  for (const caller of ["async function saveLesson() {", "function renderLessonPreviewBody() {"]) {
    assert.match(fnBody(src, caller), /liveLessonDraft\(\)/,
      `${caller} must go through liveLessonDraft(), not re-derive it`);
  }
  const save = fnBody(src, 'async function saveLesson() {');
  const liveAt = save.indexOf('liveLessonDraft()');
  const validateAt = save.indexOf('validateLessonContent(d.text_content');
  assert.ok(liveAt > 0 && liveAt < validateAt, 'and the save does so BEFORE anything is validated');
  assert.match(ed, /getMarkdown: \(\) => \(editor && !editor\.isDestroyed \? docToMarkdown\(editor\.getJSON\(\)\) : ''\)/);
});

// ─── §25 The student preview ────────────────────────────────────────────────

test('the editor schema and the converter vocabulary agree, in both directions', () => {
  // ★ THEY ARE TWO INDEPENDENT ALLOWLISTS, NOT ONE DERIVED FROM THE OTHER — the converter's
  //   docblock used to claim the schema was "built from" its constants, which nothing did.
  //   Code review caught it. The guarantee still holds (ProseMirror's schema is an allowlist
  //   and the converter ignores what it does not recognise), but only while the two agree,
  //   so the agreement is checked here rather than asserted in prose.
  const ed = jsCode(editor());
  const lib = lessonDoc();
  const listed = (name) => {
    const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]`).exec(lib);
    assert.ok(m, `${name} is missing from lessonDocument.js`);
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };
  const nodes = listed('LESSON_DOC_NODES');
  const marks = listed('LESSON_DOC_MARKS');

  // Every vocabulary name maps to exactly one extension in buildLessonExtensions.
  const EXT_FOR = {
    doc: 'Document', paragraph: 'Paragraph', text: 'Text', hardBreak: 'HardBreak',
    bulletList: 'BulletList', orderedList: 'OrderedList', listItem: 'FlatListItem',
    lessonImage: 'LessonImage', uploadingImage: 'UploadingImage', brokenToken: 'BrokenToken',
    bold: 'Bold', link: 'LessonLink',
  };
  const build = /export const buildLessonExtensions = \(handlersRef, placeholder\) => \[([\s\S]*?)\];/.exec(ed);
  assert.ok(build, 'buildLessonExtensions was not found');
  const declared = build[1];
  for (const name of [...nodes, ...marks]) {
    const ext = EXT_FOR[name];
    assert.ok(ext, `${name} is in the converter vocabulary with no extension mapped — add it here`);
    assert.match(declared, new RegExp(`\\b${ext}\\b`),
      `${name} is in the converter vocabulary but ${ext} is not in buildLessonExtensions`);
  }
  // …and the reverse: no schema-bearing extension the vocabulary does not know about. The
  // five behavioural ones carry no node or mark, so they are named as the exceptions.
  const BEHAVIOURAL = ['UndoRedo', 'Dropcursor', 'Gapcursor', 'Placeholder', 'createShortcuts'];
  const known = new Set([...Object.values(EXT_FOR), ...BEHAVIOURAL]);
  // Quoted strings out first — the placeholder copy ("Write the lesson instructions…") put
  // a capitalised word in the identifier scan and failed on correct code.
  const idents = declared.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
  for (const ident of idents.match(/\b[A-Z][A-Za-z]+\b|\bcreateShortcuts\b/g) || []) {
    assert.ok(known.has(ident),
      `${ident} is in the editor schema but nothing in LESSON_DOC_NODES/MARKS names it — a `
      + 'node the converter does not know about silently drops out of every save');
  }
  // The custom extensions really declare the names mapped above.
  for (const [nodeName, ext] of Object.entries(EXT_FOR)) {
    if (!['LessonLink', 'LessonImage', 'UploadingImage', 'BrokenToken'].includes(ext)) continue;
    assert.match(ed, new RegExp(`name: '${nodeName}'`),
      `${ext} must declare name: '${nodeName}'`);
  }
});

test('Undo and Redo never blur themselves out of the dialog', () => {
  // ★ aria-disabled, NEVER disabled — the sidebar Move up/Move down precedent, and here it
  //   happens inside an aria-modal dialog. A browser blurs a focused element the instant it
  //   becomes disabled, so pressing Redo until the stack empties dropped focus to <body>,
  //   where SidePanel's Tab trap cannot recover it (it only acts when the active element is
  //   first, last or the panel) — so Tab then walked the page behind the scrim.
  const ed = jsCode(editor());
  assert.match(ed, /label="Undo" disabled=\{disabled\} softDisabled=\{!editor\.can\(\)\.undo\(\)\}/);
  assert.match(ed, /label="Redo" disabled=\{disabled\} softDisabled=\{!editor\.can\(\)\.redo\(\)\}/);
  assert.ok(!/disabled=\{disabled \|\| !editor\.can\(\)/.test(ed),
    'a state that flips under the user\'s own finger must never be a real `disabled`');
  // The shell has to honour it: no listener attached, and the aria flag rather than the attr.
  assert.match(ed, /onClick=\{softDisabled \? undefined : onClick\}/);
  assert.match(ed, /aria-disabled=\{softDisabled \? true : undefined\}/);
  // …and it must still LOOK unavailable, or the button lies about being pressable.
  assert.match(readFileSync(join(REPO, 'src/index.css'), 'utf8'),
    /\.lesson-doc-tool\[aria-disabled="true"\] \{ opacity: 0\.4; cursor: not-allowed; \}/,
    'aria-disabled needs its own styling — :disabled no longer matches these two buttons');
});

test('a refused save is never silent, wherever Save was pressed', () => {
  // ★ CODE REVIEW CAUGHT THIS, AND IT WAS THE FEATURE'S OWN PRIMARY PATH. Save sits in the
  //   student preview's footer, but the lessonErr alert renders only in the EDITING footer
  //   and the replay error lives inside the body preview hides — so five reachable refusals
  //   produced no visible change at all. The likeliest is a missing image description, which
  //   the canvas lets you incur by placing a picture and moving on.
  const src = app();
  const save = fnBody(src, 'async function saveLesson() {');
  const upTo = save.slice(0, save.indexOf('setSavingLesson(true)'));
  // Exactly one setLessonErr survives in the refusal region: the clear at the top.
  assert.equal((upTo.match(/setLessonErr\(/g) || []).length, 1,
    'every refusal must go through refuseSave(), which leaves preview mode first');
  assert.ok((upTo.match(/refuseSave\(/g) || []).length >= 5,
    'all five content/upload refusals route through refuseSave()');
  const refuse = fnBody(src, 'function refuseSave(message) {');
  assert.match(refuse, /setLessonPreview\(false\)/,
    'refuseSave must leave preview — the error, the field it names and the canvas the caret '
    + 'lands in are all hidden while previewing');
  assert.match(refuse, /setLessonErr\(message\)/);
  // The replay branch has its own field-local alert, also inside the hidden body.
  assert.match(upTo, /setReplayErr\(replay\.message\);[\s\S]{0,220}setLessonPreview\(false\)/,
    'an invalid replay link must leave preview too — its role="alert" is inside the hidden body');
});

test('the drawer\'s own video is UNMOUNTED while previewing, not just hidden', () => {
  // Hiding is right for the canvas (undo history lives in the editor instance) and wrong for
  // a player: a hidden <video> is still a mounted SignedLessonVideo, so preview mode would
  // hold two signed URLs and two preload="metadata" players for one lesson — and display:none
  // does not pause media, so a video started in the drawer keeps talking under the preview.
  assert.match(app(), /\{!lessonPreview && d\.video_provider === 'upload' && d\.storage_path && \(/,
    'the admin max-w-md stage must be gated on !lessonPreview');
});

test('the student preview renders the SAME card the learner page does', () => {
  const src = app();
  // ★ MODULE SCOPE, pinned with a leading newline — `indexOf('function LessonCard({')` also
  //   matches an INDENTED nested declaration. Declared inside CourseProgram these become a
  //   new type every render, so React unmounts the subtree: SignedLessonVideo re-signs and
  //   <video> returns to 0:00, on every progress tick, rail resize and notice.
  for (const fn of ['LessonCard', 'LessonStage']) {
    assert.match(src, new RegExp(`\\nfunction ${fn}\\(`),
      `${fn} must be declared at module scope, never inside CourseProgram`);
  }
  // Two render sites, and only two: the student page and the preview. A third is a third
  // place the lesson layout could drift from what students actually get.
  assert.equal((src.match(/<LessonCard\b/g) || []).length, 2,
    'LessonCard must be rendered exactly twice — the learner page and the preview');
  const body = fnBody(src, 'function renderLessonPreviewBody() {');
  // adminView must be a LITERAL false. `adminView={isAdmin}` is the one mistake this prop
  // was renamed to prevent: in the preview the viewer IS an admin and the render must not be.
  assert.match(body, /adminView=\{false\}/,
    'the preview renders the STUDENT view — a literal false, never adminView={isAdmin}');
  assert.match(body, /done=\{false\}/);
  assert.match(body, /actions=\{INERT_LESSON_ACTIONS\}/);
});

test('the preview cannot reach progress, and is inert', () => {
  const src = app();
  const body = jsCode(fnBody(src, 'function renderLessonPreviewBody() {'));
  // ★ A DRAFT CARRIES A REAL LESSON ID. One stray "Mark complete" writes lesson_progress
  //   through complete_course_lesson and fans a progress event out to the dashboards.
  for (const forbidden of ['supabase', 'complete_course_lesson', 'STUDENT_PROGRESS_CHANGE_EVENT',
    'dispatchEvent', 'markComplete', 'onComplete:']) {
    assert.ok(!body.includes(forbidden),
      `the preview body must not name ${forbidden} — it is a preview, not a write path`);
  }
  // inert="" — NOT inert={true}, which React 18.3 warns about as a non-boolean attribute.
  assert.match(body, /<div inert=""/,
    'the preview subtree is inert: no clicks, and role="status"/role="alert" inside the media'
    + ' stage stay out of the a11y tree so it cannot announce into an editing session');
  // ★ jsCode(), not src: the comment directly above the attribute EXPLAINS this very hazard,
  //   so a raw scan matches its own explanation and fails on the correct answer — the exact
  //   failure shape CLAUDE.md warns about ("assert against extracted vocabularies, never
  //   'this string appears nowhere in the file'"). It bit here on the first run.
  assert.ok(!/inert=\{true\}/.test(jsCode(src)), 'inert={true} makes React 18.3 warn — use inert=""');

  // ★ THE STRONGEST GUARD IS A COUNT. markComplete appears exactly three times file-wide:
  //   CourseProgram's declaration, its ONE binding in the learner card, and the entirely
  //   unrelated markComplete() in the feature-guide player. A fourth is a second path in.
  assert.equal((jsCode(src).match(/markComplete\(/g) || []).length, 3,
    'a new markComplete( call site is a new way for a preview to record real progress');
  // INERT_LESSON_ACTIONS is nulls, not no-ops: a no-op is a live call site someone later
  // "fixes" by wiring the real handler in; a null onClick attaches no listener at all.
  assert.match(src, /const INERT_LESSON_ACTIONS = Object\.freeze\(\{ onPrev: null, onNext: null, onComplete: null \}\);/);
});

test('preview mode swaps the drawer BODY — it never stacks a second overlay', () => {
  // ★ MEASURED IN CHROME, NOT ASSUMED. SidePanel registers a WINDOW-level keydown handler
  //   that closes the drawer on Escape and wraps Tab into it. With a full-screen preview
  //   portalled ABOVE a still-mounted drawer: Escape dismissed the lesson editor outright
  //   (and popped its discard confirm), and one Tab landed on the drawer's hidden
  //   "Close lesson editor" button behind the preview. Swapping the body keeps SidePanel
  //   the only owner of those keys, and remapping onClose makes all three exits mean
  //   "back to editing".
  const src = app();
  const editor = fnBody(src, 'function renderLessonEditor() {');
  // ONE panel, two faces — never a second overlay.
  assert.equal((editor.match(/<SidePanel$/gm) || []).length, 1,
    'the editor and its preview must be the SAME drawer, or SidePanel stops being the only '
    + 'owner of Escape and the Tab wrap');
  assert.match(editor, /onClose=\{lessonPreview \? \(\) => setLessonPreview\(false\) : closeLessonEditor\}/,
    'while previewing, Escape/X/backdrop must all mean back-to-editing, never discard-the-lesson');
  assert.match(editor, /closeLabel=\{lessonPreview \? 'Back to editing' : 'Close lesson editor'\}/);
  // No second portal for the preview anywhere.
  assert.ok(!/z-\[7[5-9]\]/.test(src), 'a preview overlay above the z-[70] drawer is the shape that failed');

  // ★ HIDDEN, NOT UNMOUNTED — and this one was caught in the browser, not by reading.
  //   The first version returned a DIFFERENT SidePanel for preview mode, which unmounts the
  //   canvas: ProseMirror's undo history lives in the editor instance, so previewing and
  //   going back silently threw it away (Ctrl+Z did nothing) while a shipped comment claimed
  //   the history survived. Hiding also keeps an in-flight video upload alive.
  assert.match(editor, /<div hidden=\{lessonPreview\}>/,
    'the editor body must be hidden while previewing, never replaced — undo history and any '
    + 'in-flight upload live in components inside it');
  const hideAt = editor.indexOf('<div hidden={lessonPreview}>');
  const previewAt = editor.indexOf('{lessonPreview && renderLessonPreviewBody()}');
  assert.ok(hideAt > 0 && previewAt > hideAt,
    'the preview renders as a SIBLING of the hidden editor body, inside the same panel');
});

test('preview mode cannot outlive the drawer', () => {
  // ★ A REAL BUG ON THE PRIMARY HAPPY PATH. Save sits in the preview's own footer — "look,
  //   then save it" is the point — so the drawer routinely closes FROM preview mode. Nothing
  //   in closeLessonEditor or saveLesson's success path cleared the flag, so the next lesson
  //   opened as a read-only student view with the editor hidden and no hint why.
  const src = app();
  assert.match(src, /useEffect\(\(\) => \{ if \(!editingLesson\) setLessonPreview\(false\); \}, \[editingLesson\]\);/,
    'preview mode must reset when the drawer closes, keyed on the drawer\'s own lifetime');
  // Keyed on editingLesson, not on the exit call sites: there are five of those (three opens,
  // two closes) and a sixth added later would silently miss.
  const decl = src.indexOf('const [editingLesson, setEditingLesson]');
  const eff = src.indexOf('if (!editingLesson) setLessonPreview(false)');
  assert.ok(decl > 0 && eff > decl,
    'the effect reads editingLesson, so it must come after the declaration (TDZ)');
});

test('Preview is reachable even when the lesson cannot be saved', () => {
  const src = app();
  // It is a preview, not a save: mid-upload, a missing alt text or a refused pick are all
  // states the creator specifically wants to look at. Only Save is gated on them.
  const i = src.indexOf('Preview as student');
  assert.ok(i > 0, 'the entry point is missing');
  const btn = src.slice(src.lastIndexOf('<button', i), i);
  assert.ok(!/disabled=/.test(btn), 'the Preview button must not be disabled by the save gate');
  // flush() first, or the preview renders the canvas as of up to 180 ms ago.
  assert.match(btn, /lessonEditorRef\.current\?\.flush\?\.\(\)/,
    'flush the canvas before previewing, or it shows the debounced copy');
});

test('the preview width is capped, and capped NARROW', () => {
  const src = app();
  // ★ MEASURED on the live learner page at six viewports: the same lesson is 356px wide on
  //   a phone, 598px at 1280, 700px at 1440, 718px at 768 and 1180px at 1920. There is no
  //   single student width, so the preview can only choose WHICH WAY to be wrong — and the
  //   directions are not symmetric. Too wide lets a creator approve a line that wraps badly
  //   for the student; too narrow only shows wrapping the student will not hit. Uncapped in
  //   the drawer the preview measured 845px: 41% wider than a 1280 student.
  const m = /const LESSON_PREVIEW_MAX_W = (\d+);/.exec(src);
  assert.ok(m, 'LESSON_PREVIEW_MAX_W is missing');
  const cap = Number(m[1]);
  assert.ok(cap <= 598,
    `the cap must not exceed the narrowest measured desktop student width (598px at 1280); got ${cap}`);
  assert.match(fnBody(src, 'function renderLessonPreviewBody() {'),
    /maxWidth: LESSON_PREVIEW_MAX_W/,
    'and the preview must actually apply it');
});

test('the toolbar re-renders on a selection change, or it announces the wrong state', () => {
  // ★ @tiptap/react 3 DEFAULTS THIS OFF. Without it the component re-rendered only when
  //   the serialized TEXT changed, so moving the caret into a bold word left Bold looking
  //   inactive and announcing aria-pressed="false" — and pressing Bold on a collapsed
  //   caret (a stored mark, no text change) lit nothing at all, so the creator pressed it
  //   again and turned it back off. Debouncing onUpdate would have made it strictly worse.
  assert.match(editor(), /shouldRerenderOnTransaction: true,/);
});

test('the canvas is lazy, and stays out of every student bundle', () => {
  const src = app();
  assert.match(src, /const loadLessonEditorModule = \(\) => import\('\.\/editor\/LessonDocumentEditor\.jsx'\)/,
    'the tus-js-client / XLSX idiom');
  // Gated on a drawer being open, so reading a course never fetches it.
  const eff = src.slice(src.indexOf('if (!editingLesson || !isAdmin || editorMod'), src.indexOf('if (!editingLesson || !isAdmin || editorMod') + 600);
  assert.match(eff, /editorMod \|\| editorModErr\) return undefined;/,
    'and it is imported once, not on every reopen');
  assert.match(src, /setEditorModErr/, 'a failed import gets an actionable card, not an empty box');
  const vite = readFileSync(join(REPO, 'vite.config.js'), 'utf8');
  assert.ok(!/LessonDocumentEditor|tiptap|prosemirror/i.test(vite),
    'naming it in manualChunks would merge it back into a chunk students download');
  // The built artifact is the only proof that actually counts.
  const dist = join(REPO, 'dist/assets');
  if (existsSync(dist)) {
    const files = readdirSync(dist);
    const own = files.filter((f) => /^LessonDocumentEditor-.*\.js$/.test(f));
    assert.equal(own.length, 1, 'the editor must land in a chunk of its own');
    for (const f of files.filter((n) => /^index-.*\.js$/.test(n))) {
      const body = readFileSync(join(dist, f), 'utf8');
      assert.ok(!/prosemirror-model|ProseMirror\b/.test(body),
        `${f} carries ProseMirror — the lazy boundary leaked`);
    }
  }
});

// ─── §26 The Enrollments request card ───────────────────────────────────────
//
// On 2026-09-24 the card that decides whether a student gets paid access rendered its
// student-identity column at 0px on every common laptop with the sidebar open (measured on
// the shadow project: 0px at 1024, 1280, 1366 and 1440; 60px at 1920), so the phone number
// wrapped a few characters per line and the package and amount painted over it.
// The cause was one class list: `lg:grid-cols-[auto,minmax(0,1fr),auto,auto,auto]`. Grid
// gives `auto` tracks their max-content BEFORE it hands anything to an `fr` track, and the
// last `auto` held a wrapping row of up to eight buttons — so the buttons sized the grid and
// identity got what was left. `lg:` made it worse: it reads the VIEWPORT, and the sidebar
// takes 288px of it. The card never overflowed, so an overflow check reported success.
// These scans pin the shape; test-e2e/enrollmentLayout.e2etest.mjs measures the geometry.

const enrollCardRegion = () => {
  const src = app();
  const fn = src.indexOf('function AdminEnrollments(');
  const start = src.indexOf('{visible.map(r => {', fn);
  const end = src.indexOf('{/* Membership strip', start);
  assert.ok(fn > 0 && start > fn && end > start, 'the Enrollments request card could not be found');
  return src.slice(start, end);
};
const cssRules = (sheet, selector) => {
  const out = [];
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let m;
  while ((m = re.exec(sheet))) out.push(m[1]);
  return out;
};

test('the Enrollments card lays out by its OWN width, never the viewport', () => {
  const card = enrollCardRegion();
  assert.ok(!/\b(sm|md|lg|xl|2xl):grid-cols-/.test(card),
    'a viewport breakpoint cannot see the sidebar — the card must use its @container rules');
  assert.match(card, /className="glass-card p-4 enroll-card"/, 'the card is the query container');
  const sheet = css();
  assert.match(sheet, /\.enroll-card\s*\{[^}]*container:\s*enroll-card\s*\/\s*inline-size/,
    'the card must be a named inline-size container');
  assert.match(sheet, /@container enroll-card \(min-width: \d+px\)/, 'the wide layout is a container query');
  assert.ok(!/overflow-(x-)?hidden|overflow-hidden/.test(card),
    'clipping hides the collapse instead of fixing it');
});

test('no Enrollments card grid track can be sized by the action buttons', () => {
  const card = enrollCardRegion();
  const head = card.indexOf('className="enroll-card__head"');
  const actions = card.indexOf('className="enroll-card__actions"');
  assert.ok(head > 0 && actions > head, 'the actions row must follow the head grid');
  // The actions are a block row of their own. If they ever move back into the head grid,
  // the grid's max-content pass hands them width before identity gets any.
  for (const rule of cssRules(css(), '.enroll-card__head')) {
    assert.ok(!/actions/.test(rule), 'the actions must not be a grid area of the head');
    const cols = /grid-template-columns:\s*([^;]+);/.exec(rule)?.[1];
    if (!cols) continue;
    assert.ok((cols.match(/\bauto\b/g) || []).length <= 1,
      `at most ONE auto track (the status pill) — got "${cols}"`);
    assert.match(cols, /^minmax\(0, 1fr\)/, 'identity is the first track and the only flexible one');
  }
  assert.match(card, /data-enroll-region="who"/);
  assert.match(card, /data-enroll-region="plan"/);
  assert.match(card, /data-enroll-region="status"/);
  assert.match(card, /data-enroll-region="actions"/);
});

test('an Enrollments card never truncates who the student is or what they paid', () => {
  const card = enrollCardRegion();
  assert.match(card, /<AdminUserCell wrap\b/, 'identity wraps; an ellipsis can hide which student this is');
  assert.ok(!/maxWidth:\s*160/.test(card), 'the payment reference is evidence, not decoration');
  assert.ok(!/min-w-\[150px\]/.test(card), 'a hard minimum on the plan column is what overlapped identity');
  const cell = app().slice(app().indexOf('function AdminUserCell('), app().indexOf('function AdminUserCell(') + 1600);
  assert.match(cell, /wrap = false/, 'the wrap mode is opt-in, so Access Requests and Batches are unchanged');
});

test('the details toggle says what it does and whether it is open', () => {
  const src = app();
  const card = enrollCardRegion();
  assert.match(card, /aria-expanded=\{expanded\}/);
  assert.match(card, /aria-controls=\{`enroll-details-\$\{r\.id\}`\}/);
  assert.match(src, /id=\{`enroll-details-\$\{r\.id\}`\}/, 'aria-controls must name a real element');
  assert.match(card, /\{expanded \? 'Hide details' : 'Details'\}/, 'an icon-only chevron did not say what it opened');
});

test('the review-alert badge says who was emailed, and the student line says it was the student', () => {
  const src = app();
  assert.ok(!src.includes("label: 'Admin emailed'"), '"Admin emailed" read as "an admin emailed the student"');
  assert.match(src, /sent:\s*\{ label: 'Review alert sent'/);
  assert.match(src, /The enrollment review alert was sent to the configured administrator\./);
  assert.match(enrollCardRegion(), /Student emailed \{commWhen\(/,
    'the Communications line is a different email to a different person');
});

test('admin count badges are announced as sentences, not bare numbers', () => {
  const src = app();
  assert.match(src, /function adminBadgePhrase\(id, n\)/);
  assert.match(src, /enrollment \$\{n === 1 \? 'request' : 'requests'\} awaiting review/);
  // #69: the Getting Started Video row's badge is 0 or 1 — a state, not a queue — so its phrase names the state.
  assert.match(src, /if \(id === 'gettingstartedadmin'\) return 'the Getting Started video needs attention';/);
  const aside = sidebarOf(src);
  // aria-label on a plain <span> is ignored by screen readers (a generic role takes no name).
  assert.ok(!/<span[^>]*aria-label=\{`\$\{(item\.count|waiting)\}/.test(aside),
    'the count phrase must be real text (sr-only), not an aria-label on a span');
  assert.match(aside, /aria-label=\{item\.count \? `\$\{item\.label\}, \$\{adminBadgePhrase\(item\.id, item\.count\)\}` : item\.label\}/,
    'the collapsed rail link dropped the count from its accessible name');
});

test('a decision email names a request, never a recipient', () => {
  const src = app();
  // The single approve and decline ask notifyDecision directly; the two bulk paths ask through
  // decisionEmail, which waits out a 429 (EMAIL-1) — its second argument is only the NAME on the
  // request the dialog says it is waiting on (K3R-AE-1: never the address typed on it), and the
  // payload goes to notifyDecision untouched.
  const calls = [...src.match(/notifyDecision\(\{[^}]*\}\)/g) || [], ...src.match(/decisionEmail\(\{[^}]*\}, r\.full_name\)/g) || []];
  assert.ok(calls.length >= 4, 'the four decision paths were not found');
  for (const c of calls) {
    assert.match(c, /requestId: r\.id/, c);
    assert.ok(!/\bemail:/.test(c), `${c} — the server reads the recipient from the request row`);
  }
  assert.ok(!/decisionEmail\([^\n]*r\.email\)/.test(src), 'the dialog never waits under the address the student typed');
  const helper = jsCode(statementFrom(src.replace(/\r\n/g, '\n'), '  const decisionEmail = async (payload, name) => {', '\n  };'));
  assert.equal((helper.match(/notifyDecision\(payload\)/g) || []).length, 2, 'the payload is passed on as it came, first time and every retry');
  assert.ok(!/notifyDecision\([^)]*(?:email|name)/.test(helper), 'neither the name nor an address reaches the request');
});

test('a single reject or expire cannot overwrite an already-decided request', () => {
  const body = app().slice(app().indexOf('const doDecline = async'), app().indexOf('const doDecline = async') + 1200);
  assert.match(body, /\.eq\('status', 'pending_review'\)/, 'a stale card could re-decide an approved request');
});

test("the sidebar toggle hands focus to its counterpart, never to <body>", () => {
  // The toggle is two buttons, and pressing either removes it from view. Measured before the
  // fix (test-e2e/enrollmentLayout.e2etest.mjs): focus landed on BODY in both directions.
  const src = app();
  assert.match(src, /ref=\{railCollapseBtnRef\}\s+onClick=\{toggleRail\}/);
  assert.match(src, /ref=\{railExpandBtnRef\}\s+onClick=\{toggleRail\}/);
  assert.ok(src.includes('(railCollapsed ? railExpandBtnRef : railCollapseBtnRef).current?.focus()'),
    'focus must move to the OTHER toggle once the new state has rendered');
  assert.ok(src.includes('railToggleHadFocusRef.current = !!active && (active === railCollapseBtnRef.current || active === railExpandBtnRef.current)'),
    'only when the pressed toggle had focus — a mouse user elsewhere must not have focus moved');
});

test('the layouts the workspace sweep caught follow their own width, not the viewport', () => {
  // test-e2e/workspaceSweep.e2etest.mjs measured each of these broken at 1024 with the sidebar
  // open: a 39px StatCard text column, a 54px roadmap label box, a 44px invoice amount track.
  // That suite needs .env.test; this scan keeps the shape pinned everywhere else.
  const src = app();
  const sheet = css();
  for (const name of ['stat-strip', 'roadmap', 'inv-lines']) {
    assert.match(sheet, new RegExp(`container:\\s*${name}\\s*/\\s*inline-size`), `${name} must be a named inline-size container`);
    assert.match(sheet, new RegExp(`@container ${name} \\(min-width: \\d+px\\)`), `${name} must switch columns by container query`);
  }
  assert.ok(src.includes('<div className="stat-strip">'), 'the Progress staff-report stats must sit in the stat-strip container');
  assert.ok(!src.includes('<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">\n        <StatCard label="Filtered learners"'),
    'the viewport-breakpoint StatCard grid is back');
  assert.ok(src.includes('glass-card p-6 mb-10 roadmap-strip'), 'the career roadmap must be its own container');
  assert.ok(!/grid grid-cols-3 md:grid-cols-7/.test(src), 'the roadmap may not switch to seven columns on the viewport');
  assert.ok(!/col-span-1 text-right text-sm font-bold" style=\{\{ color: NAVY \}\}>\{formatCurrency/.test(src),
    'an invoice amount may not live in a fixed one-twelfth track');
  assert.equal((src.match(/className="inv-line__amount /g) || []).length, 2, 'both invoice line lists size the amount to its content');
});

test('the SectionHead band mirrors TabPanel padding at every breakpoint, so no tab scrolls sideways on a phone', () => {
  // It was a flat `-mx-10 -mt-10 px-10`, right only from lg up: below it the band overhung the
  // 16px phone padding by 24px each side and every tab scrolled sideways (measured at 320:
  // <main> held 334px in 310). test-e2e/workspaceSweep.e2etest.mjs checks this at 390.
  const src = app();
  assert.ok(src.includes('<div className="gh-section-head sticky top-0 z-30 -mx-4 -mt-4 px-4 sm:-mx-6 sm:-mt-6 sm:px-6 lg:-mx-10 lg:-mt-10 lg:px-10 '),
    'the band must mirror p-4 sm:p-6 lg:p-10 exactly');
  assert.ok(src.includes("p-4 sm:p-6 lg:p-10 ${WIDE_CANVAS_TABS"), 'the padding it mirrors must still be the TabPanel padding');
  // The Dashboard hero's glow is a PSEUDO-element, which no element scan can see, and its flat
  // `inset: -40px` hung 24px past a phone's 16px padding. Same rule, one layer down.
  const sheet = css();
  assert.match(sheet, /\.gh-halo::after \{[^}]*inset: -40px -16px;/, 'the halo reaches 16px sideways at phone width');
  assert.match(sheet, /@media \(min-width: 640px\)\s*\{ \.gh-halo::after \{ inset: -40px -24px; \} \}/);
  assert.match(sheet, /@media \(min-width: 1024px\) \{ \.gh-halo::after \{ inset: -40px; \} \}/);
});

test("the focus targets a decision returns to carry a name a screen reader can read", () => {
  // refocusAfterDecision() focuses the card (or the list). A role-less div is `generic`,
  // which ARIA forbids naming, so its aria-label was dropped on focus.
  const card = enrollCardRegion();
  assert.ok(card.includes('id={`enroll-card-${r.id}`} role="group" tabIndex={-1} aria-label='),
    'the card is a focus target and must be a named group');
  assert.ok(app().includes('id="enroll-list" role="group" tabIndex={-1} aria-label="Enrollment requests"'),
    'the list is the fallback focus target and must be a named group');
});

// ─── §27 The legacy migration workspace (#67) ───────────────────────────────
//
// The old wizard inserted jobs and rows from the BROWSER, processed "every ready row"
// with no selection, and offered no way back to a job after a refresh. Each of those is
// pinned here as a property of the source.

function migrationRegion() {
  const src = app();
  const start = src.indexOf('// COMPONENT: STUDENT IMPORTS — the legacy migration workspace (#67)');
  const end = src.indexOf('// COMPONENT: RESTRICTED TAB', start);
  assert.ok(start > 0 && end > start, 'the migration workspace region must exist');
  return src.slice(start, end);
}

test('§27 the browser never writes an import table', () => {
  const region = migrationRegion();
  assert.ok(!/from\(\s*'student_import[a-z_]*'\s*\)\s*\.\s*(insert|update|upsert|delete)/.test(region),
    'staging and every row change go through the endpoint or a SECURITY DEFINER RPC');
  assert.ok(!/from\(\s*'(subscriptions|profiles|batch_entitlements)'\s*\)\s*\.\s*(insert|update|upsert|delete)/.test(region));
  assert.ok(region.includes("migrationApi('stage'"), 'the roster is staged by the server');
  assert.ok(region.includes("migrationRpc('legacy_import_rows_page'"), 'rows are read page by page');
});

test('§27 the tab is gated on students.legacy_migrate, and so is the nav entry', () => {
  const region = migrationRegion();
  assert.ok(region.includes("can('students.legacy_migrate')"));
  assert.ok(!region.includes("can('students.import')"), 'students.import no longer exists');
  assert.ok(!app().includes("'students.import'"), 'no screen may still ask for the retired key');
});

test('§27 "select all" selects READY rows only, and activation sends only activatable ids', () => {
  const region = migrationRegion();
  assert.ok(region.includes("migrationRpc('legacy_import_ready_ids'"), 'the bulk selection asks the server for READY ids');
  assert.ok(/const readySelected = \[\.\.\.selected\.entries\(\)\]\.filter\(\(\[, s\]\) => s === 'ready'\)/.test(region));
  // An activation takes ready rows plus failed rows being retried — never inactive or blocked
  // ones, whatever the filter. legacy_import_start_run refuses the whole request otherwise.
  assert.ok(/const activatableSelected = \[\.\.\.selected\.entries\(\)\]\.filter\(\(\[, s\]\) => s === 'ready' \|\| s === 'failed'\)/.test(region));
  assert.ok(region.includes('onClick={() => setActivateIds(activatableSelected)}'), 'the Activate button hands over those ids only');
  assert.ok(region.includes("const selectable = ['ready', 'inactive', 'failed'].includes(r.activation_state) && !discarded;"),
    'only those three states have a checkbox');
});

// Failed rows from ANY run are retried through a new, typed confirmation, so neither an older
// run nor the per-run attempt cap can leave a row that no button in the workspace reaches.
test('§27 retrying failed rows goes through the confirmation, for every run of the job', () => {
  const region = migrationRegion();
  assert.ok(region.includes("migrationRpc('legacy_import_ready_ids', { p_job_id: jobId, p_state: 'failed' })"));
  assert.ok(region.includes('if ((ids || []).length) setActivateIds(ids);'), 'the retry opens the same confirmation dialog');
  assert.ok(!/runLoop\(summary\.runs\[0\]\.id/.test(region), 'never keyed on the newest run alone');
});

// runLoop lives for minutes. Reloading through a captured `reload` repainted the table with
// rows for the filter the run STARTED with, contradicting the filter shown above it.
test('§27 a long run always reloads with the filter showing now', () => {
  const region = migrationRegion();
  assert.ok(region.includes('const reloadRef = useRef(reload);') && region.includes('reloadRef.current = reload;'));
  assert.ok(!/\n\s+await reload\(\);/.test(region.slice(region.indexOf('const runLoop = async'), region.indexOf('const onStarted ='))),
    'runLoop must call reloadRef.current(), never the captured reload');
  // Only the newest answer paints: a filter change, a keystroke and a chunk all start a load.
  assert.ok(region.includes('const rowsSeq = useRef(0);') && region.includes('if (seq === rowsSeq.current) setRowsPage('));
});

// Leaving unmounts the workspace, and with it the only Pause control for a run the server
// keeps executing; reopening then met LEGACY_RUN_BUSY until the lease expired.
test('§27 you cannot navigate away from a running activation', () => {
  const region = migrationRegion();
  assert.ok(/onClick=\{onBack\} disabled=\{runState\.running\}/.test(region));
});

test('§27 activation requires the typed phrase the server will check', () => {
  const region = migrationRegion();
  assert.ok(region.includes('phraseMatches(typed, n)'));
  // ★ The run is started over the PREFLIGHT's ids, and the phrase count is theirs: sending the
  //   raw selection after a row stopped being ready refused the whole run once the terms had
  //   already been saved — a dead end the dialog itself had promised would not happen.
  assert.ok(region.includes("migrationApi('start-activation', { jobId, rowIds: activateIds, phrase: typed.trim(), clientKey: keyRef.current })"));
  assert.ok(region.includes('const activateIds = Array.isArray(p?.row_ids) ? p.row_ids : [];'));
  // #68 adds the batch-gap block to the same condition: confirm stays disabled while any
  // month in a VIP seat run has no batch under a later one.
  assert.ok(region.includes('&& Array.isArray(p.row_ids) && p.row_ids.length === n && gaps.length === 0;'),
    'confirm stays disabled unless the ids and the phrase agree, and no batch month is missing');
  assert.ok(!region.includes("migrationApi('start-activation', { jobId, rowIds,"), 'never the raw selection');
  assert.ok(region.includes('const keyRef = useRef(newClientKey());'), 'one key per dialog, so a double click reuses the same run');
});

test('§27 the confirmation says in words that no payment is recorded', () => {
  const region = migrationRegion();
  assert.ok(/already-paid legacy memberships\. No enrollment request, receipt or payment record is created/.test(region));
});

test('§27 a job survives a refresh: it is in the URL and an unfinished run offers Resume', () => {
  const region = migrationRegion();
  assert.ok(region.includes("u.searchParams.set('job', id)"));
  assert.ok(region.includes('useState(() => readImportJobParam())'));
  assert.ok(region.includes('Resume activation'));
});

test('§27 the date format has no default; the admin declares it', () => {
  const region = migrationRegion();
  assert.ok(region.includes("const [dateFormat, setDateFormat] = useState('');"));
  assert.ok(region.includes('DATE_FORMATS.includes(dateFormat)'), 'nothing previews or stages without it');
});

test('§27 the workspace is laid out by its container, not the viewport', () => {
  assert.ok(app().includes('<div className="import-workspace">'));
  const sheet = css();
  assert.match(sheet, /\.import-workspace \{ container: import-ws \/ inline-size; \}/);
  assert.match(sheet, /@container import-ws \(min-width: 900px\)/);
});

test('§27 the gate renders the claim and scheduled screens it can choose', () => {
  const src = app();
  assert.ok(src.includes('case GATE_SCREENS.IMPORT_CLAIM:'), 'an unhandled screen falls through to the app');
  assert.ok(src.includes('case GATE_SCREENS.MEMBERSHIP_SCHEDULED:'));
  assert.ok(src.includes('hasClaimToken: !!importClaim,'));
  assert.ok(src.includes('if (path === IMPORT_CLAIM_PATH) return false;'), 'the claim path is never rewritten away from its token');
  const scheduled = src.slice(src.indexOf('function MembershipScheduledScreen'), src.indexOf('function MembershipScheduledScreen') + 6000);
  assert.ok(!/EnrollmentPaywall|price_php|phpFmt|Renew/.test(scheduled), 'the scheduled screen shows no price and no renewal');
  assert.ok(scheduled.includes("supabase.rpc('activate_my_due_membership')"), 'it can open a due membership itself');
});

// ★ THE ACCOUNT PAGE THE OWNER DESCRIBED: name prefilled and editable, the email prefilled
//   and LOCKED (it is the sign-in identity), a password and a matching confirmation.
test('§27 the migrated account page locks the email and confirms the password', () => {
  const src = app();
  const at = src.indexOf('function AccountSetupScreen(');
  assert.ok(at > 0, 'the account setup screen exists');
  const screen = src.slice(at, src.indexOf('function ImportWelcomeScreen(', at));
  assert.ok(/id="setup-email"[^>]*readOnly aria-readonly="true"/.test(screen), 'the email is read-only, not merely styled');
  assert.ok(screen.includes('value={user?.email || \'\'}'), 'and it is the account\'s own address, not a typed one');
  assert.ok(screen.includes("useState(() => String(profile?.full_name || '').trim())"), 'the name is prefilled');
  assert.ok(screen.includes("if (password !== confirm) { setErr('The two passwords do not match.'); return; }"),
    'a mismatched confirmation is refused before anything is sent');
  assert.ok(screen.includes("supabase.rpc('complete_import_onboarding', { p_full_name: cleanName })"));
  assert.ok(screen.indexOf('await notifyImportOnboarded();') < screen.indexOf('onFinished?.();'),
    'the onboarding emails are asked for before the summary opens');
  assert.ok(src.includes('return <AccountSetupScreen onFinished={markImportWelcome} />;'));
  // A retry after a later step failed must not ask Supabase to "change" the password to the
  // one it already has (it refuses with same_password), and a failed profile read must not
  // leave the button spinning.
  assert.ok(screen.includes('if (passwordSetRef.current !== password) {'));
  assert.ok(screen.includes("if (error && error.code !== 'same_password') throw error;"));
  assert.ok(/const fresh = await refreshProfile\(\);\s+if \(!fresh\) \{[\s\S]{0,300}setBusy\(false\);/.test(screen));
});

// ★ A FAILED "YOU'RE IN" NOTICE IS RETRIED, and that promise is kept by the root: once per
//   session, for a migrated account whose setup is complete. The server stops at five.
test('§27 a failed onboarding notice is asked for again once per session', () => {
  const src = app();
  assert.ok(/const importNoticeDue = Boolean\(user\?\.id && profile && !profile\.is_admin && !importWelcome\s+&& profile\.account_origin === 'import' && profile\.onboarding_status === 'completed'\);/.test(src));
  assert.ok(/if \(!importNoticeDue \|\| importNoticeAskedRef\.current === user\?\.id\) return;\s+importNoticeAskedRef\.current = user\?\.id;\s+notifyImportOnboarded\(\);/.test(src),
    'once per signed-in account per session, never on every render');
});

test('§27 the onboarding summary shows the membership and leads to the dashboard, never a price', () => {
  const src = app();
  const at = src.indexOf('function ImportWelcomeScreen(');
  const screen = src.slice(at, at + 5000);
  assert.ok(screen.includes("supabase.rpc('my_migration_summary')"), 'facts come from the student\'s own row');
  // #68: the plan row is labelled "Package" — the owner's word, used on every surface.
  for (const label of ['Name', 'Email', 'Batch', 'Package', 'Subscription status', 'Subscription expiry']) {
    assert.ok(screen.includes(`['${label}',`), `${label} is shown`);
  }
  assert.ok(screen.includes('Go To Dashboard'));
  assert.ok(!/EnrollmentPaywall|price_php|phpFmt/.test(screen), 'no price on the summary');
  // "Already paid" is said only while a membership is live or scheduled: a reverted term
  // keeps the account, and "nothing to buy" beside "Cancelled" would be untrue.
  assert.ok(screen.includes("{(!s || s.status === 'active' || s.status === 'scheduled') ? ("));
  assert.ok(src.includes("case GATE_SCREENS.IMPORT_WELCOME:"), 'the gate renders it');
  assert.ok(/case GATE_SCREENS\.IMPORT_WELCOME:[\s\S]{0,500}setTab\('dashboard'\)/.test(src), 'Go To Dashboard lands on the Dashboard');
});

// ★ STEP 1 ASSIGNS, STEP 2 COMMITS: the terms are written (audited) and the preflight is
//   re-read BEFORE the typed phrase, so the confirmation shows what will be granted.
test('§27 activation assigns terms first and confirms second', () => {
  const region = migrationRegion();
  const modal = region.slice(region.indexOf('function MigrationActivateModal('), region.indexOf('// ── One row, in full'));
  assert.ok(modal.includes("const [step, setStep] = useState('terms');"), 'the dialog opens on the terms step');
  const setAt = modal.indexOf("await migrationRpc('legacy_import_set_terms'");
  const reloadAt = modal.indexOf('await loadPreflight();', setAt);
  const confirmAt = modal.indexOf("setStep('confirm');", reloadAt);
  assert.ok(setAt > 0 && reloadAt > setAt && confirmAt > reloadAt, 'assign → re-read → confirm, in that order');
  assert.ok(modal.includes("const canStart = step === 'confirm' && p && n > 0"), 'nothing starts from the terms step');
  assert.ok(modal.includes('openNow: e.openNow ?? (g.start_date > today)'), 'a future start is offered as "open today", pre-ticked');
  assert.ok(!/p_end: e\.openNow/.test(modal), 'opening access early never moves the paid end date');
});

test('§27 the sender can be proven before any student is emailed', () => {
  const region = migrationRegion();
  assert.ok(region.includes("setTest(await migrationApi('send-test', {}))"));
  assert.ok(region.includes('Send test email'));
  const api = readFileSync(join(REPO, 'api/admin/student-imports.js'), 'utf8');
  const at = api.indexOf("if (action === 'send-test') {");
  const block = api.slice(at, api.indexOf("if (action === 'resend') {", at));
  assert.ok(block.includes('admin.auth.admin.getUserById(actorId)'), 'the test goes to the caller\'s own address');
  assert.ok(!/body\?\.(to|email)/.test(block), 'never to an address the request names');
  assert.ok(!block.includes('generateLink'), 'the test mints no token');
});

// ─── §27 (#68) Round two: package titles, self-paced rosters, bulk activation you can trust ──
//
// Each test names a finding of the 2026-09-28 review of #67 (review_synthesis.md). Several
// helpers are pure functions at module scope in the monolith; they are lifted out and RUN
// here, so the assertions are about behaviour rather than spelling.

/** A top-level `function NAME(` of the monolith, up to its column-0 closing brace. */
function moduleFn(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} must exist at module scope`);
  const end = src.indexOf('\n}', start + 1);
  assert.ok(end > start, `function ${name} must close at column 0`);
  return src.slice(start + 1, end + 2);
}
/** A one-line top-level `const NAME = …;` of the monolith. */
function moduleConst(src, name) {
  const start = src.indexOf(`\nconst ${name} = `);
  assert.ok(start >= 0, `const ${name} must exist at module scope`);
  return src.slice(start + 1, src.indexOf('\n', start + 1));
}
const HELPER_NAMES = ['migrationPlanTitle', 'migrationPlanOption', 'migrationPlanIsVip', 'migrationSendFailText',
  'migrationResendRefusal', 'migrationSenderProven', 'migrationStopText', 'migrationBusyText',
  'migrationNoticeState', 'migrationInviteText', 'migrationSkippedText', 'migrationResendPatch'];
function migrationHelpers() {
  const src = app();
  const body = [moduleConst(src, 'migrationBareAddress'), moduleConst(src, 'migrationDomainOf'),
    moduleConst(src, 'MIGRATION_INVITE_UNRECOVERABLE'), moduleConst(src, 'MIGRATION_MAX_INVITE_GENERATION'),
    moduleConst(src, 'migrationInviteUnrecoverable'),
    ...HELPER_NAMES.map((n) => moduleFn(src, n))].join('\n')
    + `\nreturn { ${HELPER_NAMES.join(', ')}, migrationInviteUnrecoverable, MIGRATION_MAX_INVITE_GENERATION };`;
  // eslint-disable-next-line no-new-func
  return new Function('PLAN_LABELS', 'isVipPlan', 'fmtEnrollDate', body)(
    { vip: 'VIP Package', sampler: 'Essentials' },
    (p) => p?.community_segment === 'vip',
    (s) => `D(${s})`);
}
const CATALOG = [
  { key: 'vip', name: 'VIP Package', tagline: 'Personalized Coaching Program', community_segment: 'vip' },
  { key: 'silver_self_paced', name: 'Silver · Self-Paced', tagline: 'QBO + Resume Combo', community_segment: 'general' },
  { key: 'sampler', name: 'Essentials', tagline: 'Sampler Session', community_segment: 'general' },
];
/** From `function NAME(` to the next top-level function, for component-level scans. */
function componentSource(name) {
  return moduleFn(app(), name);
}

// The #67 tone table was keyed 'Ready to activate' and 'Claimed' — labels rowDisplayState()
// never returns — so a ready row and an onboarded row both rendered as neutral pills.
test('§27 #68 every state pill label rowDisplayState returns has a tone', () => {
  const src = app();
  const block = src.slice(src.indexOf('const MIGRATION_TONES = {'), src.indexOf('};', src.indexOf('const MIGRATION_TONES = {')));
  const tones = {};
  for (const m of block.matchAll(/(?:'([^']+)'|([A-Za-z]+)):\s*'(\w+)'/g)) tones[m[1] || m[2]] = m[3];
  const labels = new Set([
    ...['inactive', 'ready', 'activating', 'failed', 'blocked', 'reverted', 'unknown'].map((s) => rowDisplayState({ activation_state: s })),
    rowDisplayState({ activation_state: 'activated' }),
    rowDisplayState({ activation_state: 'activated', claimed: true }),
    rowDisplayState({ activation_state: 'activated', invite_state: 'failed' }),
  ]);
  for (const label of labels) assert.ok(label in tones, `no tone for the pill label "${label}"`);
  assert.equal(tones['Pending activation'], 'info');
  assert.equal(tones.Onboarded, 'ok');
  assert.equal(tones['Invitation failed'], 'warn');
  assert.equal(tones.Blocked, 'danger');
  assert.ok(!('Ready to activate' in tones) && !('Claimed' in tones), 'the dead #67 keys are gone');
});

// The owner's request: package titles, never product names or keys (F3/F4/F8).
test('§27 #68 a package is named by its title, never by its raw key', () => {
  const h = migrationHelpers();
  assert.equal(h.migrationPlanTitle('vip', CATALOG), 'VIP Package', 'the loaded catalog wins');
  assert.equal(h.migrationPlanTitle('vip', [], 'Server Name'), 'Server Name', 'then the server\'s own name');
  assert.equal(h.migrationPlanTitle('sampler', null), 'Essentials', 'then the in-code fallback');
  assert.equal(h.migrationPlanTitle('gold_live', []), 'A plan no longer sold', 'an unknown key is described, never printed');
  assert.equal(h.migrationPlanOption(CATALOG[1]), 'Silver · Self-Paced — QBO + Resume Combo', 'pickers read "package — product"');
  assert.equal(h.migrationPlanIsVip('vip', CATALOG), true);
  assert.equal(h.migrationPlanIsVip('sampler', CATALOG), false);

  const region = migrationRegion();
  assert.ok(!region.includes("?.name || key || '—'"), 'the #67 planName fell back to the raw key');
  assert.ok(!region.includes("→ ${row.plan_key || 'unmapped'}"), 'the row panel printed "VIP → vip"');
  assert.ok(region.includes('{plans.map((x) => <option key={x.key} value={x.key}>{migrationPlanOption(x)}</option>)}'),
    'the wizard mapping lists every plan as "package — product"');
  // F8: the Enrollments approve dialog, outside this region.
  const src = app();
  assert.ok(!src.includes('approveFor.plan_name || approveFor.plan_key'));
  assert.ok(!src.includes('({approveFor.plan_key})') && !src.includes('(plan: {approveFor.plan_key})'),
    'the approve dialog printed "plan: silver_self_paced"');
  assert.ok(src.includes("const planTitleOf = (key, snapshotName) => snapshotName || plansByKey[key]?.name || PLAN_LABELS[key] || 'this package';"));
});

test('§27 #68 every migration read of the plan catalog loads its segment, tagline and days', () => {
  const region = migrationRegion();
  const selects = [...region.matchAll(/from\('enrollment_plans'\)\.select\('([^']+)'\)/g)].map((m) => m[1].split(','));
  assert.ok(selects.length >= 4, 'the wizard, the terms dialog, the activation dialog and the workspace each read it');
  for (const cols of selects) {
    for (const c of ['key', 'name', 'tagline', 'community_segment', 'access_days']) {
      assert.ok(cols.includes(c), `a plan read is missing ${c}: ${cols.join(',')}`);
    }
  }
  const wizard = componentSource('MigrationStageWizard');
  assert.ok(/select\('[^']*price_php[^']*'\)/.test(wizard), 'the wizard shows today\'s price per package');
});

// P0-2: a Silver or Essentials roster could not be staged at all.
test('§27 #68 a self-paced roster stages Ready by its package tick, with or without a batch column', () => {
  const wizard = componentSource('MigrationStageWizard');
  assert.ok(wizard.includes('const planKeys = eligiblePlans ?? defaultEligiblePlanKeys(probe, plans);'),
    'the self-paced ticks start from every package in the file');
  assert.ok(wizard.includes('eligibleBatchCodes: codes, eligiblePlanKeys: planKeys'), 'the preview is computed with them');
  assert.ok(wizard.includes('eligiblePlanKeys: preview.planKeys,'), 'and the server is sent them');
  assert.ok(wizard.includes("planSummary(preview.rows, plans).filter((g) => g.plan_key && g.segment !== 'vip')"),
    'the self-paced table lists non-VIP packages only');
  assert.ok(wizard.includes('Self-paced packages') && wizard.includes('VIP cohorts'), 'two tables for two rules');
  assert.ok(wizard.includes('{mapsToVip && !mapping.batch_label && ('), 'a VIP mapping with no batch column is called out');
  assert.ok(wizard.includes('Worth checking (does not block)'), 'warnings are shown before staging, not only errors');
  assert.ok(app().includes("eligible_plan_keys: 'the self-paced packages chosen for activation',"),
    'a re-stage that differs only in the ticked packages says so');
});

// C8/F5: "Verify the alexsagun.com domain" was printed whatever the server sent from.
test('§27 #68 the sender copy names no domain of its own, and the chip is proven, not formatted', () => {
  const region = migrationRegion();
  assert.ok(!region.includes('alexsagun.com'), 'no domain is written into the migration workspace');
  const h = migrationHelpers();
  const t403 = h.migrationSendFailText('resend_403', 'Toolkits Support <support@toolkits.example.test>');
  assert.ok(t403.includes('toolkits.example.test'), 'a 403 names the domain the server actually used');
  assert.ok(!/alexsagun/.test(t403));
  const texts = ['resend_401', 'resend_403', 'resend_422', 'resend_429', 'resend_timeout'].map((c) => h.migrationSendFailText(c, 'a@b.test'));
  assert.equal(new Set(texts).size, texts.length, 'each provider refusal has its own words');
  assert.match(h.migrationSendFailText('resend_timeout', 'a@b.test'), /may still arrive/, 'a timeout may have been delivered');

  assert.equal(h.migrationSenderProven({ senderProven: true }, null), true, 'the server proved the domain');
  assert.equal(h.migrationSenderProven({ sender: 'S <s@x.test>' }, { ok: true, from: 's@x.test' }), true, 'a session test for this sender');
  assert.equal(h.migrationSenderProven({ sender: 's@x.test' }, { ok: true, from: 'other@y.test' }), false, 'a test of a different sender proves nothing');
  assert.equal(h.migrationSenderProven({ sender: 's@x.test' }, { ok: false, code: 'resend_403' }), false, 'a refused test');
  assert.equal(h.migrationSenderProven({ sender: 's@x.test' }, { busy: true }), false);
  assert.equal(h.migrationSenderProven({ sender: 's@x.test', support: true }, null), false, 'an address FORMAT is not proof');

  const readinessSrc = componentSource('MigrationReadiness');
  assert.ok(readinessSrc.includes("['Sender', proven && readiness.support !== false,"),
    'the chip is green only when the sender is proven, and never while an address is malformed');
  assert.ok(readinessSrc.includes("!readiness.sender ? 'missing' : readiness.support === false ? 'address malformed' : 'unverified — send a test'"),
    'the chip says which: no sender, a malformed address, or one not yet proven');
  assert.ok(!readinessSrc.includes('readiness.support]'), 'never from the #67 format check');
  assert.ok(readinessSrc.includes("test.clickTracking === 'on'"), 'click tracking on is called out');
  assert.ok(readinessSrc.includes('readiness.replyTo'), 'the Reply-To is shown beside the From');
  // One session answer, shared: both strips and the activation dialog.
  const tab = componentSource('StudentImports');
  assert.equal((tab.match(/onSenderTest=\{setSenderTest\}/g) || []).length, 2, 'the jobs list and the workspace share it');
  assert.ok(region.includes('senderTest={senderTest} onStarted={onStarted}'), 'the activation dialog reads it');
});

// Owner decision: no missing month under a later batch (the allocator only moves forward).
test('§27 #68 the confirmation blocks on a missing batch month and says what will be emailed', () => {
  const modal = componentSource('MigrationActivateModal');
  assert.ok(modal.includes('const gaps = Array.isArray(p?.batch_gaps) ? p.batch_gaps : [];'));
  assert.ok(modal.includes("href={tabHref('batches')}"), 'the block links to Admin → Batches');
  assert.ok(modal.includes("e.code === 'LEGACY_BATCH_GAP' && Array.isArray(e.context?.missing)"),
    'a gap that appears after the preflight is named, and the preflight re-read');
  assert.ok(modal.includes('Number(p.overlaps?.total) > 0') && modal.includes('Number(p.grandfathered) > 0'));
  assert.ok(modal.includes('dailyCap != null && emails > dailyCap'), 'a run above the daily email limit is warned about');
  assert.ok(modal.includes('readiness.sender') && modal.includes('readiness.replyTo'), 'From and Reply-To come from the server');
  assert.ok(!modal.includes('support@alexsagun.com'), 'never a hard-coded sender');
  assert.ok(/an\s+existing account gets a sign-in notice instead/.test(modal), 'existing accounts are not promised a claim link');
  assert.ok(modal.includes("{vip && seats > 0 && ("), 'cohort seats are shown for VIP groups only');
});

// P1-1 / B5 / B6: a refused sender kept granting, a stale lease blamed "another window",
// and a step that changed nothing either ended silently or spun into the rate limit.
test('§27 #68 the run loop stops for a reason, and says which', () => {
  const region = migrationRegion();
  const loop = region.slice(region.indexOf('const runLoop = async'), region.indexOf('const retryFailedRows ='));
  assert.ok(loop.includes('if (r?.stopped) { setRunNote({ kind: \'danger\', text: migrationStopText(r.stopped, r.code) }); break; }'));
  assert.ok(loop.includes('if (r?.busyUntil)'), 'a held lease is shown with its time');
  assert.ok(loop.includes('if (!r.results?.length || sig === prevSig) {'), 'a step that changed nothing stops the loop');
  assert.ok(!/if \(!r\.results\?\.length\) break;/.test(loop), 'and never silently');
  assert.ok(app().includes('e.busyUntil = json?.busyUntil || json?.context?.lease_until || null;'));
  const h = migrationHelpers();
  assert.match(h.migrationStopText('sender_refused', 'resend_403'), /^Resend refused the sender \(resend_403\)/);
  assert.match(h.migrationStopText('email_quota', 'resend_429'), /^Resend’s daily sending allowance is used up \(resend_429\)/);
  assert.match(h.migrationBusyText(new Date(Date.now() + 45_000).toISOString()), /about \d+s/);
  assert.ok(!/another window is already working/i.test(h.migrationBusyText('not a date')));
});

// P1-2: failed invitations could only be resent one click per row.
test('§27 #68 failed invitations resend in bulk, and "may already have arrived" is opt-in', () => {
  const modal = componentSource('MigrationResendFailedModal');
  assert.ok(modal.includes("migrationApi('resend-failed', { jobId, includeUncertain, exclude: tried })"),
    'each pass hands back the rows already tried, so no row is sent twice in one run of the dialog');
  assert.ok(modal.includes('const [includeUncertain, setIncludeUncertain] = useState(false);'), 'uncertain rows are never included by default');
  assert.ok(modal.includes('if (acc.stopped || !results.length || !deliveredNow || !Number(acc.remaining)) break;'),
    'a pass that delivered nothing ends the loop instead of spending invitation generations');
  assert.ok(migrationRegion().includes('Resend {inviteProblems} failed invitation'));
});

// B7: the panel closed during the reload, and a failure was RETURNED and shown in green.
test('§27 #68 a row\'s Resend keeps its panel open and fails in the error tone', () => {
  const panel = componentSource('MigrationRowPanel');
  assert.ok(panel.includes('const act = async (fn, { keepOpen = false } = {}) => {'));
  const resend = panel.slice(panel.indexOf("migrationApi('resend', { rowId: row.id })"), panel.indexOf('Resend email'));
  assert.ok(resend.includes('}, { keepOpen: true })'), 'Resend reloads under the open panel');
  assert.ok(resend.includes('throw new Error(migrationResendRefusal(e));'), 'a refused resend is thrown');
  assert.ok((resend.match(/throw failure\(/g) || []).length >= 2, 'uncertain and undelivered are thrown too');
  assert.ok(!resend.includes('return `The email was not delivered'), 'a failure is never returned as a success notice');
  assert.ok(!/return \{ notice: `?'?The (email|provider)/.test(resend), 'and never as a notice object');
  const region = migrationRegion();
  assert.ok(region.includes('if (!keepOpen) setOpenRow(null);'));
  assert.ok(region.includes('const fresh = rowsPage.rows.find((x) => x.id === cur.id);'),
    'the open panel shows the reloaded row');
  const h = migrationHelpers();
  assert.ok(!/Nothing was activated/.test(h.migrationResendRefusal({ code: 'LEGACY_ROW_NOT_READY', message: 'x' })),
    'a refused resend is not described as a refused activation');
});

// #68 review, U2: a resend moves a row out of "Invitation failed", so the reload no longer
// held it and `|| cur` kept the PRE-send object — "Not delivered" beside a green "on its way".
test('§27 #68 review: the open panel never keeps the pre-send row when a resend moves it out of view', () => {
  const ws = componentSource('MigrationJobWorkspace');
  const sync = ws.slice(ws.indexOf('const openRowRef = useRef(null);'), ws.indexOf('const mergeOpenRow = useCallback('));
  assert.ok(sync.length > 0, 'the open-row sync exists');
  assert.ok(!ws.includes('|| cur) : cur));'), 'the stale-object fallback is gone');
  assert.ok(sync.includes('readMigrationRow(jobId, cur).then((row) => {'), 'a row the reload no longer holds is read on its own');
  assert.ok(sync.includes('if (row && seq === openRowSeq.current)'), 'only the newest read may land');
  assert.ok(ws.includes('onChanged={async ({ keepOpen = false, patch = null } = {}) => { if (keepOpen) mergeOpenRow(patch); await reload(); if (!keepOpen) setOpenRow(null); }} />'),
    'the endpoint\'s answer is merged into the open row before the reload');
  // The single-row read picks its row out by id, never the first search match.
  const src = app();
  const readAt = src.indexOf('\nasync function readMigrationRow(');
  assert.ok(readAt > 0, 'readMigrationRow exists at module scope');
  const read = src.slice(readAt, src.indexOf('\n}', readAt + 1));
  assert.ok(read.includes("migrationRpc('legacy_import_rows_page', { p_job_id: jobId, p_search: q, p_limit: 200, p_offset: 0 })"));
  assert.ok(read.includes('.find((x) => x.id === row.id) || null'));
  // The panel hands both outcomes up: a success returns the patch, a failure carries it.
  const panel = componentSource('MigrationRowPanel');
  assert.ok(panel.includes('const patch = migrationResendPatch(row, r, new Date().toISOString());'));
  assert.ok(panel.includes("return { notice: 'A new email is on its way. The previous link no longer works.', patch };"));
  assert.ok(panel.includes('if (keepOpen && e?.patch) onChanged({ keepOpen, patch: e.patch });'), 'a failed resend changed the row too');
  assert.ok(panel.includes('if (keepOpen) setHistoryTick((t) => t + 1);'), 'the History reads again after a keep-open action');
  assert.ok(panel.includes("patch: { id: row.id, onboarding_notice_state: null, onboarding_notice_attempts: 0 },"),
    'a reset clears the notice in the panel at once');
  // Behaviour of the patch itself.
  const h = migrationHelpers();
  const now = '2026-10-01T01:02:03.000Z';
  const stale = { id: 'r1', invite_state: 'failed', invite_code: 'resend_403', invite_generation: 3 };
  assert.deepEqual(h.migrationResendPatch(stale, { state: 'sent', code: null }, now),
    { id: 'r1', invite_state: 'sent', invite_code: null, invite_sent_at: now });
  assert.deepEqual(h.migrationResendPatch(stale, { state: 'notified' }, now),
    { id: 'r1', invite_state: 'notified', invite_code: null, invite_sent_at: now });
  assert.deepEqual(h.migrationResendPatch(stale, { state: 'uncertain', code: 'resend_timeout' }, now),
    { id: 'r1', invite_state: 'uncertain', invite_code: 'resend_timeout' }, 'no sent time for an unconfirmed send');
  assert.equal(h.migrationResendPatch(stale, { state: 'skipped' }, now), null, 'nothing was attempted, nothing moves');
  assert.equal(h.migrationResendPatch(stale, null, now), null);
  assert.equal(h.migrationResendPatch({}, { state: 'sent' }, now), null, 'a row with no id is never patched');
  assert.ok(!('invite_generation' in (h.migrationResendPatch(stale, { state: 'sent' }, now) || {})),
    'the generation is read back, never guessed');
  // With the patch applied, the panel no longer reads "Not delivered".
  assert.match(h.migrationInviteText({ ...stale, ...h.migrationResendPatch(stale, { state: 'sent' }, now) }), /^Activation email sent/);
});

// #68 review, U1: the two keep-open buttons were `disabled={busy}`. A browser blurs a focused
// element the moment it becomes disabled, and SidePanel's trap cannot recover <body>.
test('§27 #68 review: keep-open actions stay focusable while busy, and focus never falls to <body>', () => {
  const panel = componentSource('MigrationRowPanel');
  for (const label of ['Resend email', 'Resend onboarding emails']) {
    const end = panel.indexOf(`/> ${label}`);
    const start = panel.lastIndexOf('<button type="button"', end);
    assert.ok(start > 0 && end > start, `the ${label} button exists`);
    const btn = panel.slice(start, end);
    assert.ok(btn.includes('aria-disabled={busy || undefined}'), `${label}: aria-disabled while busy`);
    assert.ok(!/\bdisabled=\{/.test(btn.replace(/aria-disabled=\{/g, '')), `${label}: never a native disabled`);
    assert.ok(btn.includes('if (busy) return;'), `${label}: the press is refused by an early return`);
  }
  assert.ok(panel.includes('if (busyRef.current) return;'), 'act is single-flight on a ref, not on state');
  assert.ok(panel.includes('<div ref={statusRef} tabIndex={-1} className="outline-none">'), 'the result line can take focus');
  assert.ok(panel.includes("if (!a || a === document.body) statusRef.current?.focus({ preventScroll: true });"),
    'a button that hid itself hands focus to the result, not to <body>');
  const modal = componentSource('MigrationResendFailedModal');
  assert.ok(modal.includes('<button type="button" onClick={run} aria-disabled={busy || !target || undefined}'),
    'the bulk Resend keeps its focus too');
  assert.ok(!modal.includes('onClick={run} disabled='));
  assert.ok(modal.includes('if (runningRef.current || !target) return;'));
});

// C6/D4: an exhausted notice promised retries; a dead reservation said "Sending" for ever.
test('§27 #68 the onboarding notice shows exhausted and stopped sends, and a Super Admin can reset it', () => {
  const h = migrationHelpers();
  const now = Date.parse('2026-10-01T00:00:00Z');
  const ex = h.migrationNoticeState({ onboarding_notice_state: 'failed', onboarding_notice_attempts: 5 }, now);
  assert.match(ex.text, /all five tries are used/); assert.equal(ex.resettable, true);
  assert.match(h.migrationNoticeState({ onboarding_notice_state: 'failed', onboarding_notice_attempts: 2 }, now).text, /2 of 5 tries used/);
  const stuck = h.migrationNoticeState({ onboarding_notice_state: 'sending', onboarding_notice_at: '2026-09-30T23:50:00Z' }, now);
  assert.match(stuck.text, /Stopped while sending/); assert.equal(stuck.resettable, true);
  const live = h.migrationNoticeState({ onboarding_notice_state: 'sending', onboarding_notice_at: '2026-09-30T23:59:30Z' }, now);
  assert.equal(live.text, 'Sending'); assert.equal(live.resettable, false, 'a send in flight is not reset under itself');
  assert.equal(h.migrationNoticeState({ onboarding_notice_state: 'sent' }, now).resettable, false);
  assert.equal(h.migrationNoticeState({}, now), null);
  const panel = componentSource('MigrationRowPanel');
  assert.ok(panel.includes("migrationApi('reset-onboarding-notice', { rowId: row.id })"));
  assert.ok(panel.includes("const canResetNotice = row.activation_state === 'activated' && row.claimed && !!notice68?.resettable;"));
  // A handed-back invitation reads as what it is.
  assert.match(h.migrationInviteText({ invite_state: 'not_sent', invite_code: 'resend_403' }), /handed back \(resend_403\).*Resume/);
});

test('§27 #68 eligibility notices say why rows were skipped', () => {
  const h = migrationHelpers();
  const t = h.migrationSkippedText({ skipped: 3, skipped_reasons: { wrong_state: 2, term_ended: 1, not_valid: 0, batch_archived: 0 } });
  assert.equal(t, '; 3 skipped (2 no longer in that state, 1 with a term that has ended)');
  assert.equal(h.migrationSkippedText({ skipped: 0, skipped_reasons: {} }), '');
  assert.ok(!migrationRegion().includes('or the term has ended)'), 'the #67 notice blamed an ended term for every skip');
});

// F7 and the self-paced promote path.
test('§27 #68 the workspace has a Package column, a package filter, and selects inactive rows by view', () => {
  const region = migrationRegion();
  assert.ok(region.includes('<th className="text-left py-2 pr-3 font-semibold">Package</th>'));
  assert.ok(region.includes('aria-label="Filter by package"'));
  assert.ok(region.includes("if (state !== 'ready') args.p_state = state;"), 'ready_ids is asked for inactive rows by name');
  assert.ok(region.includes('if (planKey) args.p_plan_key = planKey;'), 'and for one package only when the filter is set');
  assert.ok(region.includes('onClick={selectAllInactive}') && region.includes('Select all inactive in this view'));
});

// D1: a migrated account with its setup complete and no term was handed the PAYWALL.
test('§27 #68 a migrated student waiting on their membership is held on a card with no price', () => {
  const src = app();
  assert.ok(/case GATE_SCREENS\.IMPORT_MEMBERSHIP_PENDING:\s+return <ImportMembershipPendingScreen /.test(src),
    'an unhandled screen falls through to the app');
  const screen = componentSource('ImportMembershipPendingScreen');
  assert.ok(!/EnrollmentPaywall|price_php|phpFmt|Renew|setPanelParam/.test(screen), 'no price and no purchase path');
  assert.ok(screen.includes('<MigrationGateCard title="Your migrated membership is being set up"'));
  assert.ok(screen.includes('MIGRATION_SUPPORT_EMAIL') && screen.includes('onSignOut'), 'a support address and a way out');
  // The address a held student writes to is the Reply-To of every migration email.
  const server = readFileSync(join(REPO, 'api/_lib/legacyClaimEmail.js'), 'utf8');
  const serverAddr = /export const MIGRATION_SUPPORT_ADDRESS = '([^']+)'/.exec(server)?.[1];
  const clientAddr = /const MIGRATION_SUPPORT_EMAIL = '([^']+)'/.exec(src)?.[1];
  assert.ok(serverAddr && clientAddr, 'both addresses are declared');
  assert.equal(clientAddr, serverAddr, 'the held student and the emails name the same support mailbox');
});

test('§27 #68 student screens say "Package" and promise a batch community only to a batch', () => {
  const welcome = componentSource('ImportWelcomeScreen');
  assert.ok(welcome.includes("['Package', s?.plan_name || PLAN_LABELS[s?.plan_key] || '—'],"));
  assert.ok(!welcome.includes("'Membership plan'"));
  const scheduled = componentSource('MembershipScheduledScreen');
  assert.ok(scheduled.includes("['Package', planName],") && !scheduled.includes("['Program',"));
  assert.ok(scheduled.includes("{sub?.batch_id ? 'Your courses and your batch community' : 'Your courses and the member community'}"));
  // D5: the cron opens a 00:00-Manila start first, so "only if THIS call opened it" never refreshed.
  assert.ok(scheduled.includes('if (!error) await onRefresh?.();'));
  assert.ok(!scheduled.includes('data?.activated > 0'));
});

// D2: dates showed one day off for a viewer outside Manila.
test('§27 #68 membership dates are Manila calendar dates on every student surface', () => {
  const src = app();
  assert.ok(moduleConst(src, 'fmtTermDate').length > 0);
  assert.ok(/const fmtTermDate = \(s\) => \{[\s\S]{0,200}timeZone: 'Asia\/Manila'/.test(src));
  assert.ok(!/fmtEnrollDate\((sub|a|currentSub)[.?]/.test(src), 'a subscription date formatted in the viewer\'s timezone');
  assert.ok(src.includes("['Expires', acc.has ? (acc.legacy ? 'No expiry' : fmtTermDate(sub.ends_at)) : 'No expiry'],"), 'the Dashboard panel');
  assert.ok(src.includes('Access until <span style={{ fontWeight: 600, color: C.textSoft }}>{fmtTermDate(a.ends)}</span>'), 'the sidebar');
  assert.ok(componentSource('ProfileSettingsBody').includes('fmtTermDate(a.ends)'), 'the account drawer');
});

// D6: today's catalog price was shown as a fact of a migrated membership.
test('§27 #68 a migrated term shows no catalog price or duration', () => {
  const drawer = componentSource('ProfileSettingsBody');
  assert.ok(/sub\?\.grant_source === 'import'\s+\? <FactRow k="Payment" v="Migrated membership — already paid" \/>\s+: plan\?\.price_php != null/.test(drawer));
  const modal = componentSource('MembershipPlanModal');
  assert.ok(/sub\?\.grant_source === 'import' \? \(\s+<FactRow k="Payment" v="Migrated membership — already paid" \/>\s+\) : \(\s+<>[\s\S]{0,200}k="Price"[\s\S]{0,200}k="Duration"/.test(modal),
    'both Price and Duration sit in the non-import branch');
});

// D7: a failed complete_import_onboarding was dropped, and "Password updated" shown anyway.
test('§27 #68 a failed onboarding step after a password recovery is shown and retried alone', () => {
  const screen = componentSource('UpdatePasswordScreen');
  assert.ok(screen.includes('setOnboardingFailed(true);'));
  assert.ok(!screen.includes('if (!obErr) {'), 'the #67 silent branch');
  const retry = screen.slice(screen.indexOf('const retryOnboarding = async'), screen.indexOf('const submit = async'));
  assert.ok(retry.includes('finishOnboarding()') && !retry.includes('updatePassword'), 'the retry calls only the RPC');
  assert.ok(screen.includes('if (passwordSetRef.current !== password) {'), 'the password is not "changed" to itself');
});

test('§27 #68 a pricing card is titled by the package, with the product as its eyebrow', () => {
  const paywall = componentSource('EnrollmentPaywall');
  const card = paywall.slice(paywall.indexOf("{step === 'plans' && ("), paywall.indexOf('Save {phpFmt(save)}'));
  assert.ok(card.indexOf("{p.tagline || ' '}") > 0 && card.indexOf("{p.tagline || ' '}") < card.indexOf('{p.name}</div>'),
    'the tagline is the small line ABOVE the name');
  assert.ok(/fontSize: 17, letterSpacing: '-0\.01em', color: C\.text \}\}>\{p\.name\}<\/div>/.test(card), 'the name is the title');
});

// F7: the Package filter narrowed only the page in hand, so the total, the pages and "Select
// all … in this view" each described a different set. #68's rows_page takes p_plan_key.
test('§27 #68 the Package filter is the server\'s, like the batch filter beside it', () => {
  const ws = componentSource('MigrationJobWorkspace');
  const load = ws.slice(ws.indexOf('const loadRows = useCallback('), ws.indexOf('const reload = useCallback('));
  assert.ok(load.includes('if (planKey) args.p_plan_key = planKey;'), 'rows_page is asked for one package only when the filter is set');
  assert.ok(load.includes('}, [jobId, filter, batchCode, planKey, deferredSearch, page]);'), 'a filter change reloads');
  assert.ok(ws.includes('useEffect(() => { setPage(0); }, [filter, batchCode, planKey, deferredSearch]);'), 'and returns to page one');
  assert.ok(!ws.includes('visibleRows'), 'no client-side narrowing of the page in hand');
  assert.ok(ws.includes('{rowsPage.rows.map((r) => {'));
  // The job summary groups by batch only; a self-paced job's "no batch" line is its packages.
  assert.ok(ws.includes("c.batch_name || (jobHasSelfPaced ? 'Self-paced (no cohort)' : 'No batch')"));
});

// P1-2: the bulk resend must not promise, or retry, what the endpoint will never send.
test('§27 #68 the bulk resend tries each row once and never counts an unrecoverable invitation', () => {
  const src = app();
  const server = readFileSync(join(REPO, 'api/admin/student-imports.js'), 'utf8');
  const setOf = (text, name) => {
    const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(text);
    assert.ok(m, `${name} must be declared as a Set literal`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(setOf(src, 'MIGRATION_INVITE_UNRECOVERABLE'), setOf(server, 'NEVER_SUCCEEDS'),
    'the dialog and the endpoint agree on which invitations no resend can fix');
  const modal = componentSource('MigrationResendFailedModal');
  // #68 review, U5: by code AND by the generation cap (migrationInviteUnrecoverable).
  assert.ok(modal.includes('if (migrationInviteUnrecoverable(r)) unrecoverable += 1;'),
    'an unrecoverable row is counted on its own, never in the Resend button');
  assert.ok(app().includes('const migrationInviteUnrecoverable = (r) => MIGRATION_INVITE_UNRECOVERABLE.has(r?.invite_code) || '),
    'the code set is still what the rule reads first');
  assert.ok(modal.includes("for (const id of Array.isArray(r?.tried) ? r.tried : results.map((x) => x.row_id)) if (id && !tried.includes(id)) tried.push(id);"),
    'the ids a pass tried are carried into the next pass');
  const h = migrationHelpers();
  assert.match(h.migrationInviteText({ invite_state: 'failed', invite_code: 'account_missing' }), /no longer exists/);
  assert.match(h.migrationInviteText({ invite_state: 'failed', invite_code: 'invite_cap' }), /maximum number of times/);
  assert.equal(h.migrationInviteText({ invite_state: 'failed', invite_code: 'resend_422' }), 'Not delivered (resend_422)');
});

// Lib contract issue: since the rename the catalog name and the tier heading are the same
// words, and the signed line read "Selected program: VIP Package  VIP PACKAGE".
test('§27 #68 the Training Agreement names the package once', () => {
  const doc = componentSource('AgreementDocInner');
  assert.ok(doc.includes('· Selected package:</strong> {packageName}') && !doc.includes('Selected program'));
  assert.ok(doc.includes('const showTierPill = !!model.tierKey && !!model.tierLabel && !sameName(model.tierLabel, packageName);'));
  assert.ok(doc.includes('{showTierPill && ('), 'the pill is conditional');
  // With today's catalog every package's name IS its tier heading, so no pill is drawn.
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  for (const p of ENROLLMENT_PLANS_FALLBACK) {
    const m = agreementModel(p.key, ENROLLMENT_PLANS_FALLBACK);
    if (!m.tierKey) continue;
    assert.ok(sameName(m.tierLabel, m.planName || m.tierLabel), `${p.key}: the pill would repeat "${m.planName}"`);
  }
});

// D1 follow-through: a reverted student is now held on the "being set up" card, not sent to
// the enrollment page — so the revert dialog and the card must say what actually happens.
test('§27 #68 revert and the migration hold describe the hold, and the hold notices a new membership', () => {
  const panel = componentSource('MigrationRowPanel');
  assert.ok(!panel.includes('they will then see the enrollment page'), 'the #67 revert copy is no longer true');
  assert.ok(panel.includes('your migrated membership is being set up'), 'the revert dialog names the hold');
  const hold = componentSource('ImportMembershipPendingScreen');
  assert.ok(!/We will email you/.test(hold), 'no email is promised: a reverted row may never be activated again');
  assert.ok(hold.includes("window.addEventListener('focus', check);"), 'returning to the tab asks again');
  assert.ok(hold.includes('if (busyRef.current) return;'), 'one check at a time');
});

// A5: one picker label everywhere — the package, then the product it contains.
test('§27 #68 every package picker reads "package — product", and a VIP move needs its batch first', () => {
  const region = migrationRegion();
  assert.ok(!region.includes('value={x.key}>{x.name}</option>'), 'a picker listing product-less names');
  assert.ok((region.match(/\{migrationPlanOption\(x\)\}<\/option>/g) || []).length >= 3, 'the wizard, the terms dialog and the activation dialog');
  const modal = componentSource('MigrationActivateModal');
  const apply = modal.slice(modal.indexOf('const applyTerms = async'), modal.indexOf('setBusy(true); setErr(\'\');', modal.indexOf('const applyTerms = async')));
  assert.ok(apply.includes('!e.batch_id && migrationPlanIsVip(e.plan_key, plans)') && apply.includes('Nothing was saved.'),
    'a group moved onto a VIP package without a batch is refused before any group is saved');
  assert.ok(/if \(needsBatch\.length\) \{\s+setErr\([\s\S]*?\);\s+return;\s+\}/.test(apply), 'and the refusal returns before anything is written');
});

// The owner's rename, outside the migration: the course card's tier toggle named the plan by
// its retired product name, beside a package now itself called "Essentials".
test('§27 #68 the course tier toggle names the Essentials package, not the retired Sampler name', () => {
  const src = app();
  assert.ok(!src.includes('Sampler tier (Essentials)') && !src.includes('Essentials · Sampler</span>'));
  assert.ok(src.includes('Included in the Essentials package') && src.includes('<Sparkles size={11} /> Essentials package</span>'));
});

// E11 on the XLSX path: parseCsv refuses a repeated heading; the workbook reader must too.
test('§27 #68 a workbook with a repeated column heading is refused, as a CSV is', () => {
  const wizard = componentSource('MigrationStageWizard');
  const xlsx = wizard.slice(wizard.indexOf("if (/\\.xlsx?$/i.test(f.name)) {"), wizard.indexOf('parsed = parseCsv('));
  assert.ok(xlsx.includes('if (seenHdr.has(h)) throw new Error(`Duplicate column heading "${h}".'), 'the XLSX path refuses duplicates');
  assert.ok(xlsx.includes('if (!h) continue;'), 'blank headings stay allowed, as in parseCsv');
});

// ─── §27 (#68 review fixes) — what the 2026-09-29 review of #68 found in the client ──────

// V1 / V5 / R3: two new breaker reasons, and a 429 that is not always the daily allowance.
test('§27 #68 review: every breaker reason has its own instruction', () => {
  const h = migrationHelpers();
  const auth = h.migrationStopText('auth_unavailable', 'link_failed');
  assert.match(auth, /^Supabase could not create sign-in links \(link_failed\)\./);
  assert.match(auth, /Nothing more was granted/, 'the owner is told the run stopped granting');
  assert.match(auth, /Press Resume once Auth is healthy\.$/);
  const rate = h.migrationStopText('email_rate_limited', 'resend_429');
  assert.match(rate, /^Resend is rate-limiting \(resend_429\)\./);
  assert.match(rate, /Wait a minute, then press Resume\.$/, 'a rate limit is a minute, not a day');
  const quota = h.migrationStopText('email_quota', 'resend_429');
  assert.match(quota, /daily sending allowance/, 'the quota names the daily allowance');
  assert.match(quota, /upgrade the Resend plan/, 'and the way to raise it');
  assert.doesNotMatch(quota, /Daily email limit reached/, 'the #68 wording that sent a rate limit to wait a day');
  // Every reason the endpoint can return has its own words; none falls to the default.
  const reasons = ['sender_refused', 'email_quota', 'email_rate_limited', 'email_unconfigured', 'invalid_request', 'auth_unavailable'];
  const fallback = h.migrationStopText('something_new', 'x');
  const texts = reasons.map((r) => h.migrationStopText(r, 'x'));
  for (const [i, t] of texts.entries()) assert.notEqual(t, fallback, `${reasons[i]} falls through to the generic stop text`);
  assert.equal(new Set(texts).size, texts.length, 'each reason reads differently');
  // Both screens that show a stop use the one function.
  assert.ok(componentSource('MigrationResendFailedModal').includes('migrationStopText(out.stopped, out.code)'));
});

// S1: the held-back rows are named before the run, and the copy offers only real exits.
test('§27 #68 review: the confirm step names the rows the claim will hold back', () => {
  const modal = componentSource('MigrationActivateModal');
  assert.ok(modal.includes('const held = Array.isArray(p?.held_row_ids) ? new Set(p.held_row_ids).size : 0;'),
    'read from the preflight; a database without the key shows nothing extra');
  assert.ok(modal.includes('{held > 0 && <Fact k="Held back (higher package waiting)" v={held} warn />}'));
  assert.ok(modal.includes('<Fact k="Will be activated" v={held > 0 ? Math.max(0, n - held) : n} />'),
    'held rows are not counted as activated');
  const start = modal.indexOf('{held > 0 && (');
  const notice = modal.slice(start, modal.indexOf('{gaps.length > 0 && (', start));
  assert.ok(start > 0 && notice.length > 0, 'the held notice exists');
  assert.ok(/will be held back as Failed rather than activated/.test(notice));
  assert.ok(/Activate that row first, or change its terms/.test(notice));
  assert.doesNotMatch(notice, /discard/i, 'there is no per-row discard');
});

// U6 / R2: the count is this run's, and the allowance is shared.
test('§27 #68 review: the email count says it is this run\'s, and that the allowance is shared', () => {
  const modal = componentSource('MigrationActivateModal');
  assert.ok(!modal.includes('Emails today (daily limit)'), 'the label claimed a day\'s total it never counted');
  assert.ok(modal.includes('<Fact k="Emails in this run" v={`${emails} · daily allowance ${dailyCap}`} warn={emails > dailyCap} />'));
  assert.ok(/The daily allowance is shared: emails already sent today, the app&rsquo;s other emails \(enrollment alerts,\s+communications, staff invitations\) and the two onboarding emails each student triggers/.test(modal),
    'the shared allowance and the later onboarding emails are named');
  assert.ok(modal.includes('Activating in daily groups of about {Math.max(1, Math.floor(dailyCap / 2))} leaves room for the rest.'),
    'the advice leaves headroom rather than filling the allowance');
});

// U5: the dialog mirrors the endpoint's generation cap, not only its codes.
test('§27 #68 review: the bulk resend never promises a row at the generation cap', () => {
  const server = readFileSync(join(REPO, 'api/admin/student-imports.js'), 'utf8');
  const serverCap = Number(/const MAX_INVITE_GENERATION = (\d+);/.exec(server)?.[1]);
  const h = migrationHelpers();
  assert.ok(serverCap > 0, 'the endpoint declares its cap');
  assert.equal(h.MIGRATION_MAX_INVITE_GENERATION, serverCap, 'the dialog and the endpoint agree on the cap');
  const modal = componentSource('MigrationResendFailedModal');
  assert.ok(modal.includes('if (migrationInviteUnrecoverable(r)) unrecoverable += 1;'), 'the count reads code AND cap');
  assert.equal(h.migrationInviteUnrecoverable({ invite_code: 'resend_403', invite_generation: serverCap }), true,
    'a row at the cap whose last try left a provider code');
  assert.equal(h.migrationInviteUnrecoverable({ invite_code: 'resend_403', invite_generation: serverCap - 1 }), false);
  assert.equal(h.migrationInviteUnrecoverable({ invite_code: 'invite_cap', invite_generation: 3 }), true);
  assert.equal(h.migrationInviteUnrecoverable({ invite_code: 'account_missing' }), true);
  assert.equal(h.migrationInviteUnrecoverable({ invite_code: 'resend_429' }), false);
  // The row panel says so, and does not offer a Resend that begin_invite would refuse.
  assert.match(h.migrationInviteText({ invite_state: 'failed', invite_code: 'resend_403', invite_generation: serverCap }),
    /^Not delivered \(resend_403\) — sent the maximum number of times/);
  assert.ok(componentSource('MigrationRowPanel').includes('&& !(Number(row.invite_generation) >= MIGRATION_MAX_INVITE_GENERATION);'));
  // A refused resend names the causes that still exist.
  const t = h.migrationResendRefusal({ code: 'LEGACY_ROW_NOT_READY' });
  assert.doesNotMatch(t, /already claimed/, 'begin_invite sends a notice to an onboarded account since #68');
  assert.match(t, /no longer activated/);
  assert.match(t, /maximum number of times/);
});

// U8: the featured card's pill must not shrink under the renamed eyebrow.
test('§27 #68 review: the BEST SELLER pill never wraps beside a long eyebrow', () => {
  const paywall = componentSource('EnrollmentPaywall');
  const card = paywall.slice(paywall.indexOf("{step === 'plans' && ("), paywall.indexOf('Save {phpFmt(save)}'));
  const eyebrowAt = card.indexOf("{p.tagline || ' '}");
  const row = card.slice(card.lastIndexOf('<div className="flex', eyebrowAt), card.indexOf('{p.badge}'));
  assert.ok(row.startsWith('<div className="flex items-start justify-between gap-2">'), 'the eyebrow and pill share a top-aligned row');
  assert.ok(/<div className="min-w-0" style=\{\{[^}]*\}\}>\{p\.tagline \|\| ' '\}<\/div>/.test(row), 'the eyebrow may shrink and wrap');
  const pill = row.slice(row.indexOf('{p.badge && ('));
  assert.ok(/<span className="flex-shrink-0 whitespace-nowrap /.test(pill), 'the pill is fixed on one line');
  // One render site serves the enrollment, renewal and upgrade paywalls.
  assert.equal((app().match(/\{p\.badge && \(/g) || []).length, 1, 'no second pricing-card copy to drift');
});

// L4: the bank importer's Excel advice was unreachable once parseCsv refused a repeat first.
test('§27 #68 review: the bank CSV importer maps a repeated heading back to its own advice, by code', () => {
  const card = componentSource('FinanceBankImportCard');
  assert.ok(app().includes("import { toCsv, parseCsv, CSV_DUPLICATE_HEADER, IMPORT_TEMPLATE_COLUMNS } from './lib/studentImport';"));
  assert.ok(card.includes('if (csvErr?.code === CSV_DUPLICATE_HEADER) {'), 'mapped by the code');
  assert.ok(!/Duplicate column heading/.test(card), 'never by matching the message text');
  assert.ok(card.includes("+ 'Give every column a unique heading and export it again (or upload it as Excel).';"),
    'the Excel route is offered again');
  assert.ok(card.includes('throw new Error(`${headingAdvice} Repeated heading: "${csvErr.heading}".`);'), 'naming the heading');
  assert.ok(card.includes('throw csvErr;'), 'any other refusal passes through unchanged');
});

// ★ BULK TERMS (#68). September 2026 was archived on the owner's instruction, so its 65 staged VIP
//   rows must be re-batched into October before promotion — one audited call for the selection,
//   not 65 row panels. The modal sends ONLY the fields the Super Admin set (a null means "keep"),
//   the batch picker gives way for a self-paced package, and the action is offered for exactly
//   the rows set_terms can change (inactive + ready).
test('§27 #68: a selection can be given a batch, package or dates in one audited call', () => {
  const region = migrationRegion();
  const at = region.indexOf('function MigrationBulkTermsModal(');
  assert.ok(at > 0, 'the bulk terms modal exists');
  const modal = region.slice(at, region.indexOf('function MigrationReasonModal(', at));
  assert.ok(modal.includes("const [plan, setPlan] = useState('');"), 'every field starts empty: there is no single row to diff against');
  assert.ok(modal.includes('p_plan_key: plan || null,') && modal.includes('p_start: startDate || null,'), 'only what was set is sent');
  assert.ok(modal.includes('p_batch_id: planIsVip && batchId ? batchId : null,'), 'a batch is sent only for a VIP package');
  assert.ok(modal.includes("<option value=\"\">Keep each row's batch</option>"), 'the empty choice keeps each row\'s own batch');
  assert.ok(modal.includes("filter((x) => x.status !== 'archived')"), 'an archived batch is never offered');
  assert.ok(modal.includes('(changed ? onSave(change, reason) : onClose())'), 'no change means no call');
  assert.ok(region.includes("migrationRpc('legacy_import_set_terms', { p_row_ids: ids, ...change, p_reason: reason })"), 'one audited call for the selection');
  assert.ok(/filter\(\(\[, s\]\) => s === 'ready' \|\| s === 'inactive' \|\| s === 'failed'\)/.test(region), 'the rows set_terms accepts');
  assert.ok(region.includes("setReasonFor('terms')"), 'offered from the selection bar');
  assert.ok(region.includes("{reasonFor === 'terms' && ("), 'and rendered from the same reason state as the other bulk actions');
});

// ─── §28a Media plumbing for the Getting Started video (#69) ─────────────────
//
// The Getting Started video is PLAYED by SignedLessonVideo and UPLOADED by
// LessonVideoUploader — the lesson components themselves, given optional props whose
// defaults reproduce the lesson behaviour exactly. A second player and a second uploader
// would have been the easy thing to write and the wrong one: §6, §6b, §7, §13, §14, §18
// and §19 above each record a way this pipeline has already failed in production, and a
// copy would have inherited none of those fixes.
//
// What generalising them puts at risk, and what this section therefore pins:
//   • a signer that can be pointed at any bucket sits one call away from a PUBLIC url
//     for a private object — the fallback #44 removed;
//   • a module-scope record that names a signer is read while the module is being
//     EVALUATED, so declaration order became a crash neither the build nor any
//     node --test suite can see (neither evaluates the monolith);
//   • optional callbacks on a component whose effect re-signs when a dependency changes
//     are one dependency array away from re-signing on every parent render;
//   • a `target` that can change identity between renders must never be able to restart
//     a transfer in flight, or mint a second signed URL.
//
// ★ THE SLACK BEHIND §6, §6b AND §19, MEASURED 2026-09-30. Those ratchets read FIXED
//   windows of the source, so a correct edit that merely lengthens the text inside one
//   fails a test about a defect that did not happen. #69 had to touch both windows — the
//   tus `fingerprint` and the bucket the transfer names — so everything it could move out
//   was HOISTED above the tus constructor (fpPrefix / fpScope / bucketName), and the
//   course-scoping comment went with it. Where each anchor now ENDS inside its window, and
//   the characters left after it:
//
//                                                       before #69            after #69
//     ratchet  anchor that must end in the window    CRLF       LF         CRLF       LF
//     §6       req.setHeader('authorization'      3882/4000  3823/4000   3642/4000  3586/4000
//                                       to spare     118        177         358        414
//     §6b      Bearer ${lastGood}                 3903/4000  3844/4000   3663/4000  3607/4000
//                                       to spare      97        156         337        393
//     §19      lastModified, after the first       117/200    116/200     118/200    117/200
//              `fingerprint:` in the file
//                                       to spare      83         84          82         83
//
//   (§6 and §6b count from `new tus.Upload(`.) §6b is the binding one: its block is cut out
//   of §6's 4000-character region, so `Bearer ${lastGood}` must end inside THAT, 21
//   characters after the header call §6 looks for. Inside its own 900-character block it
//   has 401 to spare, which is not the limit. §19 lost one character: `${fpPrefix}-${fpScope}`
//   is one longer than the `gh-lesson-${courseId}` it replaced.
//   CRLF is THIS working tree (git stores LF; core.autocrlf rewrites on checkout), where
//   every line costs one character more — so the ratchets have LESS room here than in a
//   clean LF checkout. UPLOAD_WINDOW_SLACK pins the LF column, which is the same number on
//   every checkout; the slack may grow, and may shrink only by changing the record.
//
// Mutation-tested 2026-09-30: 104 deliberate regressions, one at a time, against a scratch
// copy — every one failed the §28a test named for it.
const UPLOAD_WINDOW_SLACK = Object.freeze({ bearerHeader: 414, lastGood: 393, fingerprint: 83 });

/** A hoisted `async function NAME(` of the monolith, up to its column-0 closing brace. */
function moduleAsyncFn(src, name) {
  const start = src.indexOf(`\nasync function ${name}(`);
  assert.ok(start >= 0, `async function ${name} must be a hoisted declaration at module scope`);
  const end = src.indexOf('\n}', start + 1);
  assert.ok(end > start, `async function ${name} must close at column 0`);
  return src.slice(start + 1, end + 2);
}

/** SignedLessonVideo, up to the next top-level function — the window §18 reads. */
const signedVideo = () => {
  const src = app();
  const i = src.indexOf('function SignedLessonVideo');
  assert.ok(i > 0, 'SignedLessonVideo was not found');
  return src.slice(i, src.indexOf('\nfunction ', i + 1));
};

// `target` the PROP — never `e.target`, which the uploader's two file inputs read.
const TARGET_PROP = /(?<![.\w$])target\b/;

/** Every hook dependency array in a slice of executable source, as lists of names. */
const depArrays = (code) => [...code.matchAll(/\}, \[([^\]]*)\]\)/g)]
  .map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));

/** The destructured props of a module-scope component: [names, raw `name = default` parts]. */
const propsOf = (body, component) => {
  const sig = new RegExp(`^function ${component}\\(\\{([^}]*)\\}\\) \\{`).exec(body);
  assert.ok(sig, `${component} must destructure its props in its signature`);
  const parts = sig[1].split(',').map((p) => p.trim()).filter(Boolean);
  return [parts.map((p) => p.split('=')[0].trim()), parts];
};

test('§28a one function signs every private video, and its two wrappers only choose the bucket', async () => {
  const src = app();
  assert.equal((src.match(/\bfunction signPrivateVideo\(/g) || []).length, 1,
    'signPrivateVideo( must be defined exactly once — a second signer is a second place a URL '
    + 'for a private video can be built, and the next one will not know why there is no fallback');

  // ★ HOISTED DECLARATIONS. LESSON_UPLOAD_TARGET stores signLessonVideo while the module is
  //   still being evaluated; a `const` arrow declared below its first reader is a
  //   temporal-dead-zone ReferenceError — a blank page that passes the build and every test.
  for (const name of ['signPrivateVideo', 'signLessonVideo', 'signOnboardingVideo']) {
    assert.ok(!new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(src),
      `${name} must be a hoisted \`async function\`, never a const arrow`);
  }
  assert.match(moduleAsyncFn(src, 'signLessonVideo'),
    /^async function signLessonVideo\(path\) \{\s*return signPrivateVideo\(LESSON_VIDEO_BUCKET, path\);\s*\}$/,
    'signLessonVideo must do nothing but delegate, with the lesson bucket');
  assert.match(moduleAsyncFn(src, 'signOnboardingVideo'),
    /^async function signOnboardingVideo\(path\) \{\s*return signPrivateVideo\(ONBOARDING_VIDEO_BUCKET, path\);\s*\}$/,
    'signOnboardingVideo must do nothing but delegate, with the onboarding bucket');
  assert.match(src, /import\s*\{[^}]*\bONBOARDING_VIDEO_BUCKET\b[^}]*\}\s*from '\.\/lib\/gettingStarted';/,
    'the onboarding bucket has ONE name, in src/lib/gettingStarted.js, which the SQL parity '
    + 'suite pins against the migration — never a second literal here');

  // The three are lifted out and RUN, so this is about what they do, not how they are spelled.
  const load = (result) => {
    const calls = [];
    const supabase = {
      storage: {
        from: (bucket) => ({
          createSignedUrl: async (path, ttl) => { calls.push({ bucket, path, ttl }); return result; },
        }),
      },
    };
    const fns = new Function('supabase', 'LESSON_VIDEO_BUCKET', 'ONBOARDING_VIDEO_BUCKET', 'LESSON_VIDEO_SIGN_TTL_SECONDS',
      `${['signPrivateVideo', 'signLessonVideo', 'signOnboardingVideo'].map((n) => moduleAsyncFn(src, n)).join('\n')}
      return { signPrivateVideo, signLessonVideo, signOnboardingVideo };`,
    )(supabase, LESSON_VIDEO_BUCKET, ONBOARDING_VIDEO_BUCKET, LESSON_VIDEO_SIGN_TTL_SECONDS);
    return { ...fns, calls };
  };

  const ok = load({ data: { signedUrl: 'https://storage.example/signed?token=t' }, error: null });
  const t0 = Date.now();
  const lesson = await ok.signLessonVideo('lessons/a/b.mp4');
  assert.deepEqual(Object.keys(lesson).sort(), ['signedAt', 'url'], 'the shape both callers destructure');
  assert.equal(lesson.url, 'https://storage.example/signed?token=t');
  assert.ok(lesson.signedAt >= t0 && lesson.signedAt <= Date.now(), 'signedAt is the mint time, in ms');
  await ok.signOnboardingVideo('versions/v/u.mp4');
  assert.deepEqual(ok.calls, [
    { bucket: LESSON_VIDEO_BUCKET, path: 'lessons/a/b.mp4', ttl: LESSON_VIDEO_SIGN_TTL_SECONDS },
    { bucket: ONBOARDING_VIDEO_BUCKET, path: 'versions/v/u.mp4', ttl: LESSON_VIDEO_SIGN_TTL_SECONDS },
  ], 'each wrapper signs in its own bucket, for the one shared TTL the players refresh against');
  assert.notEqual(LESSON_VIDEO_BUCKET, ONBOARDING_VIDEO_BUCKET);

  // The error shape SignedLessonVideo and the uploader already handle: the storage error
  // itself when there is one, and a described Error when the answer is merely empty.
  const denied = Object.assign(new Error('Object not found'), { status: 400 });
  await assert.rejects(load({ data: null, error: denied }).signLessonVideo('p'), (e) => e === denied);
  await assert.rejects(load({ data: null, error: denied }).signOnboardingVideo('p'), (e) => e === denied);
  await assert.rejects(load({ data: {}, error: null }).signOnboardingVideo('p'), /No signed URL was returned\./);
  await assert.rejects(load({ data: null, error: null }).signLessonVideo('p'), /No signed URL was returned\./);
});

test('§28a no public URL is ever built for the Getting Started bucket', () => {
  const src = app();
  // What a `.from(X)` argument names: a string literal, or a module-scope const holding one.
  const bucketNamed = (arg) => {
    const lit = /^['"]([^'"]+)['"]$/.exec(arg);
    if (lit) return lit[1];
    if (!/^[A-Za-z_]\w*$/.test(arg)) return null;
    const decl = new RegExp(`\\bconst ${arg} = ['"]([^'"]+)['"]`).exec(src);
    return decl ? decl[1] : null;
  };
  let calls = 0;
  for (const m of src.matchAll(/getPublicUrl\(/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lead = src.slice(lineStart, m.index).trimStart();
    // Prose. This file's comments explain the fallback #44 removed, and they name the call.
    if (lead.startsWith('//') || lead.startsWith('*') || lead.startsWith('/*')) continue;
    calls += 1;
    const near = src.slice(lineStart, m.index + 40).trim();
    const chain = /\.from\(\s*([^()]*?)\s*\)\s*\.\s*getPublicUrl\($/
      .exec(src.slice(Math.max(0, m.index - 300), m.index + m[0].length));
    assert.ok(chain,
      `a getPublicUrl() call whose bucket this scan cannot read. Write it as `
      + `\`.from(<bucket>).getPublicUrl(\` so the bucket stays checkable. Near: ${near}`);
    assert.notEqual(chain[1], 'ONBOARDING_VIDEO_BUCKET',
      `a PUBLIC url is being built for the private Getting Started bucket. Near: ${near}`);
    const bucket = bucketNamed(chain[1]);
    assert.ok(bucket, `this scan could not tell which bucket \`${chain[1]}\` names. Near: ${near}`);
    assert.notEqual(bucket, ONBOARDING_VIDEO_BUCKET,
      'a PUBLIC url is being built for the private Getting Started bucket. getPublicUrl() is a '
      + 'string builder that never round-trips, so it "works" — and hands out an address that '
      + `returns 400 to the student it was built for. Sign it: signOnboardingVideo(). Near: ${near}`);
  }
  assert.ok(calls >= 1,
    'this scan found no getPublicUrl() call in executable code at all — it has stopped reading '
    + 'the file it was written to police');
});

test('§28a SignedLessonVideo signs through `signUrl`, and through nothing else', () => {
  const body = signedVideo();
  const [names, parts] = propsOf(body, 'SignedLessonVideo');
  // ★ NOT `sign`. The body already declares `const sign = useCallback(...)`; a prop of the
  //   same name is a redeclaration — a SyntaxError for the whole 48,000-line module.
  assert.ok(!names.includes('sign'),
    'the signer prop must be `signUrl` — the component body already declares `const sign`');
  assert.deepEqual(names,
    ['lesson', 'isAdmin', 'signUrl', 'mediaRef', 'onEnded', 'onTimeUpdate', 'onSeeking', 'onProblem', 'onReady']);
  assert.ok(parts.includes('signUrl = signLessonVideo'),
    'the default signer must be the lesson one, or LessonStage — which passes none — stops playing');
  assert.ok(parts.includes('isAdmin = false'), 'isAdmin still fails closed to the student copy');
  for (const optional of ['mediaRef', 'onEnded', 'onTimeUpdate', 'onSeeking', 'onProblem', 'onReady']) {
    assert.ok(parts.includes(optional), `${optional} must stay optional, with no default to invent behaviour`);
  }

  const code = jsCode(body);
  const at = code.indexOf('const sign = useCallback(');
  assert.ok(at > 0, 'the inner sign() callback was not found');
  const callback = code.slice(at);
  const deps = /\n  \}, \[([^\]]*)\]\);/.exec(callback);
  assert.ok(deps, 'could not find the dependency array of sign()');
  assert.deepEqual(deps[1].split(',').map((d) => d.trim()), ['path', 'isAdmin', 'signUrl'],
    'signUrl must be a dependency of sign(): without it a player handed a different signer '
    + 'goes on minting URLs with the one it first closed over');
  assert.match(callback.slice(0, deps.index), /const \{ url, signedAt \} = await signUrl\(path\);/,
    'sign() must mint through the prop');
  for (const direct of ['signLessonVideo(', 'signOnboardingVideo(', 'signPrivateVideo(', 'createSignedUrl(', 'getPublicUrl(']) {
    assert.ok(!code.includes(direct),
      `SignedLessonVideo calls ${direct}…) directly — it would then sign in ONE bucket whatever `
      + 'signer it was handed, and the Getting Started video would be asked for in course-videos');
  }
});

test('§28a every path into the error state reports, and no callback can cause a re-sign', () => {
  const code = jsCode(signedVideo());
  const errors = [...code.matchAll(/setState\('error'\);/g)];
  assert.ok(errors.length >= 3,
    'expected the three ways into the error state: a failed sign, a missing path, a media error');
  // ★ EVERY ONE. The Getting Started gate offers "Continue to dashboard for now" only once it
  //   has been told the video cannot play; an error path that stays silent leaves a newly
  //   approved student on a broken player with no way forward.
  assert.equal((code.match(/onProblemRef\.current\?\.\(/g) || []).length, errors.length,
    'a path into the error state does not call onProblem, or one calls it twice');
  for (const e of errors) {
    assert.match(code.slice(e.index, e.index + 260), /onProblemRef\.current\?\.\(/,
      'each setState(\'error\') must be followed by its own onProblem report');
  }
  for (const report of ["onProblemRef.current?.('sign')", "onProblemRef.current?.('missing')",
    'onProblemRef.current?.(decision.reason)']) {
    assert.ok(code.includes(report),
      `${report} is missing — reasons must be the ones the component already keeps in problem.reason, `
      + 'which onboardingProblemCode() in src/lib/gettingStarted.js maps to a stored code');
  }
  // ★ AND ONLY WHILE MOUNTED. sign() can outlive its player — the caller's Retry remounts
  //   it, a card collapses — and a failure that lands afterwards would otherwise report a
  //   problem, and raise the gate's give-up state, for a video nobody is looking at.
  assert.equal((code.match(/if \(mountedRef\.current\) onProblemRef\.current\?\.\(/g) || []).length, errors.length,
    'every onProblem report must be guarded by mountedRef — a late sign failure must not report after unmount');
  // Re-armed on mount, not just disarmed on unmount: StrictMode runs mount → cleanup → mount
  // in development, and a ref the first cleanup left false would silence every report.
  const armed = /const mountedRef = useRef\(true\);\s*useEffect\(\(\) => \{ mountedRef\.current = true; return \(\) => \{ mountedRef\.current = false; \}; \}, \[\]\);/.exec(code);
  assert.ok(armed, 'mountedRef must be set true in the effect BODY and false in its cleanup');
  assert.ok(armed.index < code.indexOf('}, [lesson?.id, path, sign]);'),
    'the mounted effect must be declared above the path effect: effects run in order, and the '
    + 'path effect reports a missing file synchronously');

  // A quiet pre-expiry refresh that fails keeps the current URL and is NOT an error.
  const quietAt = code.indexOf('if (quiet) {');
  assert.ok(quietAt > 0, 'the quiet-refresh branch of sign() was not found');
  const quiet = code.slice(quietAt, code.indexOf('}', quietAt) + 1);
  assert.ok(/return false;/.test(quiet) && !/onProblemRef|setState\(/.test(quiet),
    'a failed quiet refresh must stay quiet — playback is still running on the old URL');

  // ★ THROUGH A REF. sign() and the path effect both report, and that effect re-signs
  //   whenever sign() changes identity. A parent's inline closure in either dependency
  //   array would mint a new URL — and unmount the <video> — on every parent render.
  assert.match(code, /const onProblemRef = useRef\(onProblem\);\s*onProblemRef\.current = onProblem;/,
    'onProblem must be kept in a ref that is refreshed every render');
  const arrays = depArrays(code);
  assert.ok(arrays.length >= 5, 'expected the dependency arrays of the mounted effect, attachVideo, sign and the two effects');
  for (const names of arrays) {
    for (const callback of ['onProblem', 'onReady', 'onEnded', 'onTimeUpdate', 'onSeeking']) {
      assert.ok(!names.includes(callback),
        `${callback} is in a dependency array [${names.join(', ')}]. It is a caller's closure and `
        + 'changes identity every render, so this re-runs — and for sign() or its effect, re-signs');
    }
  }

  // onReady: on every successful (re)load, after the learner's place has been restored.
  const meta = code.slice(code.indexOf('onLoadedMetadata={'), code.indexOf('onError={handleMediaError}'));
  const ready = meta.indexOf('onReady?.();');
  assert.ok(ready > 0, 'onReady must fire from onLoadedMetadata — the one event every (re)load reaches');
  assert.ok(ready > meta.indexOf('resumeAtRef.current = 0;') && ready > meta.indexOf('resumePlayingRef.current = false;'),
    'onReady must come AFTER the resume logic, so a listener reads the restored currentTime');
  assert.equal((code.match(/onReady\?\.\(\)/g) || []).length, 1, 'and from nowhere else');
});

test('§28a the <video> gains observers and a merged ref, and loses nothing', () => {
  const code = jsCode(signedVideo());
  const at = code.indexOf('<video');
  assert.ok(at > 0 && code.indexOf('<video', at + 1) === -1, 'expected exactly one <video> element');
  const tag = code.slice(at, code.indexOf('/>', at) + 2);
  for (const attr of [
    'key={`${lesson.id}:${path}`}', 'src={src}', 'preload="metadata"', 'playsInline',
    'controlsList="nodownload"', 'onError={handleMediaError}',
  ]) {
    assert.ok(tag.includes(attr), `the lesson player lost ${attr}`);
  }
  assert.match(tag, /\n\s*controls\s*\n/, 'the lesson player lost its controls');
  // Global constraint of #69: no autoplay, with or without sound.
  assert.ok(!/autoPlay|\bmuted\b|\bloop\b/.test(tag), 'a lesson or onboarding video never starts itself');
  for (const observer of ['onEnded={onEnded}', 'onTimeUpdate={onTimeUpdate}', 'onSeeking={onSeeking}']) {
    assert.ok(tag.includes(observer),
      `${observer} must be passed straight to the <video> — an absent prop then attaches nothing`);
  }
  // ★ A CALLBACK REF. A re-sign and "Try again" both unmount the element and mount a new
  //   one; a parent that captured the first node would read `played` from, and pause, a
  //   detached element — which is the keep-alive "hidden tab keeps playing" defect.
  assert.ok(tag.includes('ref={attachVideo}'), 'the <video> must attach through the merging callback ref');
  assert.match(code,
    /const attachVideo = useCallback\(\(node\) => \{\s*videoRef\.current = node;\s*if \(typeof mediaRef === 'function'\) mediaRef\(node\);\s*else if \(mediaRef\) mediaRef\.current = node;\s*\}, \[mediaRef\]\);/,
    'attachVideo must keep the component\'s own videoRef AND the caller\'s mediaRef (object or '
    + 'callback) on the current element, and be stable while mediaRef is');
});

test('§28a the upload record is built after everything it reads — and today it is the lesson', () => {
  const src = app();
  const once = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `${needle.trim()} must be declared at module scope`);
    assert.equal(src.indexOf(needle, i + 1), -1, `${needle.trim()} must be declared exactly once`);
    return i;
  };
  const signers = ['signPrivateVideo', 'signLessonVideo', 'signOnboardingVideo']
    .map((n) => once(`\nasync function ${n}(`));
  const copyAt = once('\nconst LESSON_UPLOAD_COPY = Object.freeze({');
  const targetAt = once('\nconst LESSON_UPLOAD_TARGET = Object.freeze({');
  // ★ TEMPORAL DEAD ZONE. The record is built while the module is being evaluated and
  //   reads LESSON_UPLOAD_COPY by value; reversed, the app dies at import with a
  //   ReferenceError that `npm run build` and `npm test` both pass straight through.
  assert.ok(copyAt < targetAt, 'LESSON_UPLOAD_COPY must be declared BEFORE LESSON_UPLOAD_TARGET reads it');
  assert.ok(Math.max(...signers) < copyAt,
    'both upload consts must be declared AFTER the signers they name');

  // Lift the two declarations out and BUILD them, with the real path rules.
  const end = src.indexOf('\n});', targetAt);
  assert.ok(end > targetAt, 'could not delimit LESSON_UPLOAD_TARGET');
  const swept = [];
  const signLessonVideo = async () => ({});
  const removeMediaIfUnreferenced = (paths) => { swept.push(paths); return 'swept'; };
  const { LESSON_UPLOAD_COPY: copy, LESSON_UPLOAD_TARGET: target } = new Function(
    'LESSON_VIDEO_BUCKET', 'buildLessonVideoPath', 'isLessonVideoPath', 'signLessonVideo', 'removeMediaIfUnreferenced',
    `${src.slice(copyAt + 1, end + 4)}\nreturn { LESSON_UPLOAD_COPY, LESSON_UPLOAD_TARGET };`,
  )(LESSON_VIDEO_BUCKET, buildLessonVideoPath, isLessonVideoPath, signLessonVideo, removeMediaIfUnreferenced);

  assert.ok(Object.isFrozen(target) && Object.isFrozen(copy), 'a shared default must not be mutable');
  assert.deepEqual(Object.keys(target),
    ['bucket', 'buildPath', 'isOwnPath', 'fingerprintScope', 'fingerprintPrefix', 'sign', 'discard', 'copy'],
    'this is the shape a second owner (the Getting Started video) implements');
  assert.equal(target.bucket, LESSON_VIDEO_BUCKET);
  assert.equal(target.isOwnPath, isLessonVideoPath);
  assert.equal(target.fingerprintScope, null, 'null = "scope the resume key to the courseId prop"');
  assert.equal(target.fingerprintPrefix, 'gh-lesson');
  assert.equal(target.sign, signLessonVideo);
  assert.equal(target.copy, copy);

  const COURSE = '3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30';
  const UPLOAD = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const built = target.buildPath({ courseId: COURSE, uploadId: UPLOAD, fileName: 'Lesson 1 (final).mov' });
  assert.equal(built, buildLessonVideoPath(COURSE, UPLOAD, 'Lesson 1 (final).mov'),
    'the lesson path is built exactly as it was before the uploader took a target');
  assert.ok(target.isOwnPath(built), 'and it is a path the same record accepts');
  assert.throws(() => target.buildPath({ courseId: 'not-a-uuid', uploadId: UPLOAD, fileName: 'a.mp4' }), /course id/i,
    'a bad id THROWS: inside runTransfer\'s try/catch that is a visible upload error');

  // ★ Reference-aware, and with the ARRAY the helper takes — a duplicated course can share a path.
  assert.equal(target.discard('lessons/x/y.mp4'), 'swept', 'discard returns the helper\'s promise');
  assert.deepEqual(swept, [['lessons/x/y.mp4']]);

  assert.deepEqual({ ...copy }, {
    pickLabel: 'Upload lesson video',
    fallbackName: 'Lesson video',
    accessRequired: 'Admin access to course videos is required.',
    removed: 'Video removed. Save the lesson to confirm.',
  }, 'the lesson uploader must read exactly as it did — these are the four phrases that name a lesson');
});

test('§28a the uploader names no bucket, path rule, signer or cleanup of its own', () => {
  const body = uploaderBody();
  const code = jsCode(body);
  const [names, parts] = propsOf(body, 'LessonVideoUploader');
  assert.deepEqual(names,
    ['courseId', 'value', 'savedPath', 'onChange', 'onStateChange', 'onPendingPath', 'disabled', 'target', 'onMediaFacts']);
  assert.ok(parts.includes('target = LESSON_UPLOAD_TARGET'),
    'the default target must be the lesson one, or the lesson editor — which passes none — stops uploading');

  // Every hard-coded site reads the target. One left behind sends the Getting Started video
  // into course-videos, or signs it there, or sweeps it with a COURSE reference check that
  // can never find it referenced — and deletes it.
  for (const [needle, site] of [
    ['LESSON_VIDEO_BUCKET', 'the bucket'],
    ['buildLessonVideoPath(', 'the path builder'],
    ['isLessonVideoPath(', 'a path validator'],
    ['signLessonVideo(', 'the verification signer'],
    ['removeMediaIfUnreferenced(', 'the orphan cleanup'],
    ['gh-lesson', 'the resume-key prefix'],
    ['Upload lesson video', 'the picker label'],
    ["'Lesson video'", 'the progress fallback name'],
    ['Admin access to course videos', 'the access sentence'],
    ['Save the lesson', 'the removal announcement'],
  ]) {
    assert.ok(!code.includes(needle), `LessonVideoUploader still hard-codes ${site} (${needle})`);
  }
  assert.match(code, /const hasSaved = target\.isOwnPath\(value\?\.storage_path\);/, 'the initial SAVED state');
  assert.match(code, /&& target\.isOwnPath\(resumedName\)\) path = resumedName;/, 'resume adoption');
  assert.match(code, /let path = target\.buildPath\(\{ courseId, uploadId: crypto\.randomUUID\(\), fileName: file\.name \}\);/);
  assert.match(code, /await target\.discard\(path\)/, 'discardPending');
  assert.match(code, /metadata: \{\s*bucketName,\s*objectName: path,/, 'the tus metadata names the hoisted bucket');

  // ★ §14, generalised: verification signs through the CACHED signer and nowhere else.
  assert.equal((code.match(/(?<![.\w$])target\.sign\(/g) || []).length, 1,
    'target.sign( must be called from exactly one place');
  assert.match(jsCode(fnBody(body, 'async function signedUrlFor(')), /const \{ url, signedAt \} = await target\.sign\(path\);/,
    'and that place is signedUrlFor, which reuses a URL — a fresh one per attempt is a cold CDN miss every time');

  // Owner-specific wording, and nothing else, comes from the target.
  assert.match(code, /const copy = \{ \.\.\.LESSON_UPLOAD_COPY, \.\.\.target\.copy \};/,
    'a key a target omits must fall back to the lesson wording, never render nothing');
  for (const use of ['{copy.pickLabel}', 'fileInfo?.name || copy.fallbackName', '+ copy.accessRequired;', 'announce(copy.removed);']) {
    assert.ok(code.includes(use), `expected ${use}`);
  }
  // ★ §13 reads describeVerifyFailure's arms IN PLACE. Only the access sentence moved.
  const verdicts = fnBody(body, 'function describeVerifyFailure(');
  assert.equal((jsCode(verdicts).match(/\bcopy\./g) || []).length, 1,
    'describeVerifyFailure must keep every arm inline except the one owner-specific sentence');
  assert.match(verdicts, /'The file uploaded, but this account was not allowed to read it back\. '\s*\+ copy\.accessRequired;/);
});

test('§28a the target is read above the tus options, and the resume key is unchanged for a lesson', () => {
  const start = fnBody(uploaderBody(), 'async function startUpload(');
  const ctor = start.indexOf('new tus.Upload(');
  assert.ok(ctor > 0, 'the tus constructor was not found in startUpload');
  for (const decl of [
    'const fpPrefix = target.fingerprintPrefix;',
    'const fpScope = target.fingerprintScope ?? courseId;',
    'const bucketName = target.bucket;',
  ]) {
    const at = start.indexOf(decl);
    assert.ok(at > 0 && at < ctor,
      `\`${decl}\` must be hoisted ABOVE the tus constructor: §6 and §6b read a fixed window `
      + 'that starts there, and a lookup written inside the options object spends it');
  }
  const bearer = start.indexOf("req.setHeader('authorization'", ctor);
  assert.ok(bearer > ctor, 'the bearer header was not found after the tus constructor');
  const span = jsCode(start.slice(ctor, bearer));
  assert.ok(!TARGET_PROP.test(span) && !/\bcourseId\b/.test(span),
    'nothing between the tus constructor and the bearer header may read `target` or `courseId` '
    + '— use the consts hoisted above it');

  // ★ BYTE-IDENTICAL FOR A LESSON. The resume key is what tus looks a paused upload up by;
  //   a changed spelling would silently restart every transfer that was mid-flight when
  //   this shipped — "choose the same file again to pick up where it left off" from zero.
  const tpl = /fingerprint: \(f\) => Promise\.resolve\(\s*`([^`]+)`\),/.exec(start);
  assert.ok(tpl, 'the tus fingerprint template was not found');
  const key = new Function('fpPrefix', 'fpScope', 'f', `return \`${tpl[1]}\`;`);
  const file = { name: 'lesson 1.mp4', type: 'video/mp4', size: 123, lastModified: 456 };
  const COURSE = '3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30';
  assert.equal(key('gh-lesson', COURSE, file), `gh-lesson-${COURSE}-lesson 1.mp4-video/mp4-123-456`,
    'with the lesson target this must be the pre-#69 key, character for character');
  assert.notEqual(key('gh-lesson', COURSE, file), key('gh-lesson', 'another-owner', file),
    'the scope keeps the same file, picked for a different owner, from resuming into the first one\'s object');
  assert.notEqual(key('gh-lesson', COURSE, file), key('gh-onboarding', COURSE, file),
    'and the prefix keeps two kinds of owner apart even if their ids ever coincided');
});

test('§28a the slack behind §6, §6b and §19 is at least what is recorded', () => {
  // LF-normalised, so the numbers are the same on every checkout (see the table above).
  const src = app().replace(/\r\n/g, '\n');
  const ctor = src.indexOf('new tus.Upload(');
  assert.ok(ctor > 0, 'the tus constructor was not found');
  const region = src.slice(ctor, ctor + 4000);
  const header = /req\.setHeader\('authorization'/.exec(region);
  const bearer = region.indexOf('Bearer ${lastGood}');
  const at = src.indexOf('fingerprint:');
  const stamp = /lastModified/.exec(src.slice(at, at + 200));
  assert.ok(header && bearer > 0 && stamp, '§6, §6b or §19 no longer finds its anchor inside its window');
  const measured = {
    bearerHeader: 4000 - (header.index + header[0].length),
    lastGood: 4000 - (bearer + 'Bearer ${lastGood}'.length),
    fingerprint: 200 - (stamp.index + stamp[0].length),
  };
  for (const [name, recorded] of Object.entries(UPLOAD_WINDOW_SLACK)) {
    assert.ok(measured[name] >= recorded,
      `the ${name} window has ${measured[name]} characters to spare; ${recorded} are recorded. `
      + 'Something was added between the tus constructor and the bearer header, or to the '
      + 'fingerprint template. Hoist it above the constructor (as fpPrefix / fpScope / '
      + 'bucketName are) — or, if it truly belongs there, lower UPLOAD_WINDOW_SLACK and the '
      + 'table beside it in the same change, and say why');
  }
});

test('§28a a new `target` identity can neither restart a transfer nor sign again', () => {
  const code = jsCode(uploaderBody());
  // ★ Treated exactly as `courseId` always was: read from the closure of the render whose
  //   EVENT started the flow. React itself must never see it change — so no effect reads
  //   it, and the one dependency array that lists it belongs to a callback no effect uses.
  const naming = depArrays(code).filter((names) => names.includes('target'));
  assert.deepEqual(naming, [['savedPath', 'notePendingPath', 'target']],
    '`target` may appear in exactly one dependency array: discardPending\'s, deliberately. '
    + 'Anywhere else, a caller that forgot to memoize its target re-runs that hook every render');
  assert.match(code, /const discardPending = useCallback\(async \(\) => \{[\s\S]*?\}, \[savedPath, notePendingPath, target\]\);/,
    'and that array is discardPending\'s');

  const effects = code.match(/use(?:Layout)?Effect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g) || [];
  assert.equal(effects.length, 2,
    'the uploader has exactly two effects (report the state; disarm on unmount). A third is '
    + 'where an upload starts, or a URL is signed, without anyone having clicked anything');
  for (const effect of effects) {
    assert.ok(!TARGET_PROP.test(effect) && !/discardPending|startUpload|runTransfer|runVerification|signedUrlFor/.test(effect),
      'no effect may read the target, or start, verify, sign or discard anything — every one '
      + 'of those is a user action');
  }
  assert.ok(!/\buseMemo\(/.test(code), 'and nothing is memoized on it either');
});

test('§28a media facts ride beside the READY patch, and the patch gains no key', () => {
  const body = uploaderBody();
  const code = jsCode(fnBody(body, 'async function runVerification('));
  const ready = code.indexOf("onChange?.({ storage_path: path, video_provider: 'upload', video_url: null, __durationSeconds: secs });");
  const facts = code.indexOf('onMediaFacts?.({');
  const ok = code.indexOf('go(UPLOAD_EVENTS.VERIFY_OK);');
  const failed = code.indexOf('} catch (e) {');
  assert.ok(ready > 0, 'the READY patch must stay exactly as the lesson editor consumes it');
  assert.ok(facts > ready && facts < ok && ok < failed,
    'onMediaFacts must fire beside the READY onChange, on the success path only — a caller '
    + 'that stores these facts must never be handed ones for an upload that did not verify');
  assert.equal((jsCode(body).match(/onMediaFacts\?\.\(/g) || []).length, 1, 'and from nowhere else');

  const call = code.slice(facts, code.indexOf('});', facts));
  assert.match(call, /byteSize: Number\.isFinite\(bytes\) && bytes > 0 \? bytes : null,/,
    'byteSize is the expected size verification compared, or null — never 0 or NaN');
  assert.match(code, /const bytes = Number\(expectedBytes\);/);
  // The content type the object was SENT with — one rule, shared with the transfer itself.
  assert.match(call, /mimeType: sent \? videoUploadContentType\(sent\) : null,/);
  assert.match(jsCode(fnBody(body, 'async function startUpload(')), /contentType: videoUploadContentType\(file\),/,
    'the tus metadata and onMediaFacts must agree about what Storage recorded');
  assert.match(call, /fileName: sent\?\.name \|\| null,/);
  assert.match(code, /const sent = fileRef\.current;/, 'the file actually transferred, after any remux');
  assert.match(call, /durationSeconds: secs,/, 'the SAME value the patch carries as __durationSeconds');

  // ★ NEVER A duration_seconds KEY. applyVideoPatch strips __durationSeconds and spreads the
  //   rest of the patch into the lesson draft.
  assert.ok(!/\bduration_seconds\b/.test(jsCode(body)), 'the uploader must not emit a duration_seconds key');
  assert.match(app(), /const \{ __durationSeconds, \.\.\.cols \} = patch \|\| \{\};/,
    'applyVideoPatch must keep stripping the private duration key');

  // And the lesson editor passes neither new prop: its behaviour is the defaults.
  const lessonSites = (app().match(/<LessonVideoUploader\s[^>]*?\/>/g) || [])
    .filter((site) => /courseId=\{course\.id\}/.test(site));
  assert.equal(lessonSites.length, 1, 'the lesson editor\'s LessonVideoUploader call site was not found');
  assert.ok(!/\btarget=|\bonMediaFacts=/.test(lessonSites[0]),
    'the lesson editor relies on the default target and takes no media facts');
});

test('§28a every sidebar icon is imported from lucide-react', () => {
  const src = app();
  const block = /import \{([\s\S]*?)\} from 'lucide-react';/.exec(src);
  assert.ok(block, 'the lucide-react import block was not found');
  // `TrendingUp as Growth` binds Growth; a bare name binds itself.
  const imported = new Set(block[1].split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (/\bas\s+(\w+)$/.exec(s) || [null, s])[1]));
  assert.ok(imported.has('LayoutDashboard') && imported.has('Growth') && !imported.has('TrendingUp as Growth'),
    'the import block was not parsed');

  const stagesAt = src.indexOf('const DEFAULT_STAGES = [');
  const navAt = src.indexOf('const adminNavItems = useMemo(');
  assert.ok(stagesAt > 0 && navAt > 0, 'DEFAULT_STAGES or adminNavItems was not found');
  const stages = jsCode(src.slice(stagesAt, src.indexOf('\n  ];', stagesAt)));
  const nav = jsCode(src.slice(navAt, src.indexOf('].filter(', navAt)));
  const used = [
    ...[...stages.matchAll(/\bicon:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...nav.matchAll(/\bIcon:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ];
  assert.ok(used.length >= 30, `expected the sidebar's icons; found ${used.length} — the scan has stopped reading them`);
  // ★ AN UNIMPORTED ICON IS A ReferenceError AT RENDER, in the root component: a blank
  //   page for every signed-in user. esbuild does not resolve free identifiers and there is
  //   no linter, so the build passes; nothing in node --test mounts the sidebar.
  const missing = [...new Set(used)].filter((name) => !imported.has(name));
  assert.deepEqual(missing, [],
    'these sidebar icons are used but not imported from lucide-react — add them to the import block');
});

// ─── §28b The student surfaces of the Getting Started video (#69) ────────────
//
// What a newly approved student meets before their first dashboard — the gate screen —
// and the two places the video is replayed from: the `gettingstarted` tab and the
// Dashboard card. WHICH screen shows is src/lib/gateScreen.js (test/gateMatrix.test.mjs),
// and every rule that needs no React is src/lib/gettingStarted.js
// (test/gettingStarted.test.mjs). This section pins the React half, where the failures are
// the kind neither of those suites can see:
//   • the root must ASK before the gate decides, and ANSWER during render. A status an
//     effect sets leaves one frame of dashboard ahead of the video it must precede, and a
//     hook below the gate's first early return is a hooks-order crash the day the gate
//     changes its mind;
//   • one door each for the completion, the start and the state read, and every problem
//     report coded — so a refusal reads the same everywhere and no raw reason is stored;
//   • a replay in a hidden keep-alive tab must stop talking, which needs an observer on a
//     frame that outlives the <video> SignedLessonVideo replaces on every re-sign;
//   • the escape hatch ("Continue to dashboard for now") records nothing, and no gate
//     screen quotes a price or starts a video by itself.
// The three hooks are lifted out and RUN on a minimal hook runtime, so the rules of
// useGettingStarted() — the one input the gate's last arm has — are behaviour here, not
// spelling.

/** The root component, from its signature to its column-0 closing brace. */
const rootSource = () => {
  const src = app();
  const i = src.indexOf('export default function BookkeeperProToolkit() {');
  assert.ok(i > 0, 'the root component was not found');
  const end = src.indexOf('\n}', i);
  assert.ok(end > i, 'the root component must close at column 0');
  return src.slice(i, end + 2);
};

// Every new student-surface component and hook — the scope of the "never" scans below.
const GS_PARTS = ['useGettingStarted', 'usePauseWhenHidden', 'useReplayRecorder', 'GettingStartedPlayer',
  'GettingStartedTranscript', 'GettingStartedBody', 'GettingStartedScreen', 'GettingStartedPage', 'GettingStartedCard',
  'refocusIfLost', 'transientFocusTarget', 'useRecheckOnReturn'];
const gsCode = () => jsCode(GS_PARTS.map((name) => componentSource(name)).join('\n'));

/**
 * Just enough React to RUN a module-scope hook of the monolith in node: state, refs, memos
 * and effects with dependency arrays, in call order. No DOM and no scheduler — a test
 * renders by hand, after letting the promises it is waiting on settle.
 */
function hookRuntime({ strict = false } = {}) {
  const cells = [];
  let at = 0;
  let effects = [];
  let mounted = false;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (init) => { const i = at++; if (!cells[i]) cells[i] = init(); return cells[i]; };
  const hooks = {
    useState: (initial) => {
      const c = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [c.value, (next) => { c.value = typeof next === 'function' ? next(c.value) : next; }];
    },
    useRef: (initial) => slot(() => ({ current: initial })),
    useMemo: (fn, deps) => {
      const c = slot(() => ({ deps: null, value: undefined }));
      if (!same(c.deps, deps)) { c.value = fn(); c.deps = deps; }
      return c.value;
    },
    useCallback: (fn, deps) => hooks.useMemo(() => fn, deps),
    useEffect: (fn, deps) => {
      const c = slot(() => ({ deps: null, cleanup: null, effect: true }));
      if (same(c.deps, deps)) return;
      c.deps = deps;
      effects.push(() => { if (typeof c.cleanup === 'function') c.cleanup(); c.cleanup = fn(); });
    },
  };
  return {
    hooks,
    render(fn, ...args) {
      at = 0;
      const out = fn(...args);
      const run = effects;
      effects = [];
      for (const effect of run) effect();
      // <React.StrictMode> on MOUNT: every effect is cleaned up and run once more. (The
      // wrapper runs the previous cleanup before the effect, so running it again is exactly that.)
      if (strict && !mounted) for (const effect of run) effect();
      mounted = true;
      return out;
    },
    unmount() { for (const c of cells) if (c?.effect && typeof c.cleanup === 'function') c.cleanup(); },
  };
}

/** A module-scope hook of the monolith, lifted out and bound to a runtime and its free names. */
function liftHook(name, rt, free = {}) {
  const names = Object.keys(free);
  // eslint-disable-next-line no-new-func
  return new Function('useState', 'useRef', 'useCallback', 'useMemo', 'useEffect', ...names,
    `${componentSource(name)}\nreturn ${name};`)(
    rt.hooks.useState, rt.hooks.useRef, rt.hooks.useCallback, rt.hooks.useMemo, rt.hooks.useEffect,
    ...names.map((k) => free[k]));
}
const settleAll = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The enrollment PHASE the root hands the hook (gettingStartedEnrollPhase()), for a test's
 * (pass, settled): true → 'pass'; otherwise 'hold' while settled — the default, a hold screen, most
 * often the pending one — or 'unknown' while the profile or the enrollment reads are still out. A
 * string IS a phase, passed through as it is.
 */
const phaseOf = (pass, settled = true) => (typeof pass === 'string' ? pass : pass === true ? 'pass' : settled ? 'hold' : 'unknown');

/** useGettingStarted, mounted on a runtime whose every rpc() waits for the test to answer it. */
function mountGettingStarted(timeoutMs = 5_000, { strict = false } = {}) {
  const rt = hookRuntime({ strict });
  const calls = [];
  const supabase = { rpc: (name) => new Promise((resolve, reject) => { calls.push({ name, resolve, reject }); }) };
  const hook = liftHook('useGettingStarted', rt, {
    supabase, gettingStartedStatus, gettingStartedNeedsReask, gettingStartedFailedBeforePass,
    ONBOARDING_STATE_TIMEOUT_MS: timeoutMs, isMigrationMissing, appErrorCode,
  });
  return { calls, render: (uid, pass, settled = true) => rt.render(hook, uid, phaseOf(pass, settled)) };
}
const answer = (call, data) => call.resolve({ data, error: null });

test('§28b the gate renders Getting Started, and the root asks before the gate decides', () => {
  const root = jsCode(rootSource());
  const arm = root.indexOf('case GATE_SCREENS.GETTING_STARTED:');
  assert.ok(arm > 0,
    'the root gate switch has no GETTING_STARTED arm — an unhandled screen falls through `default` and '
    + 'renders the app, which here is the very dashboard the video must come before');
  const armBody = root.slice(arm, root.indexOf('case GATE_SCREENS.', arm + 1));
  assert.match(armBody, /return \(\s*<GettingStartedScreen\b/, 'the arm renders GettingStartedScreen');
  assert.match(armBody, /\bgs=\{gs\}/, 'handed the root\'s answer as a prop — the gate renders outside the provider');
  assert.match(armBody,
    /onDone=\{\(r, forUid\) => \{ if \(!gs\.markCompleted\(r, forUid\)\) return; dismissWelcome\(\); setTab\('dashboard'\); \}\}/,
    'finishing marks the answer (the gate passes at once), closes the first-login welcome so it cannot '
    + 'stack on top of the dashboard, and opens the Dashboard — and only for the account the completion was '
    + 'asked for: a completion that outlived a sign-out opens nothing for whoever signed in next (GF-7)');

  // ★ ABOVE THE GATE, AND BEFORE IT DECIDES — handed the enrollment PHASE: a SETTLED pass (T12-D1) and a
  //   hold told apart from loading (V-GF1-DOUBLE-BOUND), each run in its own test below.
  const pass = root.indexOf("const enrollPass = enroll.state === 'pass';");
  const phase = root.indexOf('const gsEnrollPhase = gettingStartedEnrollPhase({ profileReady, ready: enroll.ready, pass: enrollPass });');
  const hook = root.indexOf('const gs = useGettingStarted(user?.id, gsEnrollPhase);');
  const decide = root.indexOf('const gate = resolveGateScreen({');
  const firstReturn = root.indexOf('switch (gate.screen) {');
  assert.ok(pass > 0 && phase > pass && hook > phase, 'the hook is called right after the phase, which reads enrollPass');
  assert.ok(decide > hook && firstReturn > decide, 'the answer exists before resolveGateScreen() reads it');
  assert.ok(!/\buse[A-Z]\w*\(/.test(root.slice(firstReturn)),
    'a hook is called below the gate\'s first early return — the hook order would then follow the screen');

  const call = root.slice(decide, root.indexOf('});', decide));
  assert.match(call, /\bgettingStarted: gsGate,/, 'the gate reads gettingStartedGateInput() of the answer');
  assert.match(call, /\bgettingStartedDeferred: gsDeferred,/, 'and whether this session deferred it');
  assert.match(root, /const gsGate = gettingStartedGateInput\(gs\);/);
  // Session-only AND per account: the uid that deferred, compared — no effect to reset it.
  assert.match(root, /const \[gsDeferredUid, setGsDeferredUid\] = useState\(null\);/);
  assert.match(root, /const gsDeferred = !!user\?\.id && gsDeferredUid === user\.id;/);

  // The provider's value IS the hook's memoized value — never a useMemo at the provider,
  // which sits below every early return.
  const provider = root.indexOf('<GettingStartedContext.Provider value={gs}>');
  assert.ok(provider > firstReturn, 'the app shell is wrapped in <GettingStartedContext.Provider value={gs}>');
  assert.ok(root.indexOf('</GettingStartedContext.Provider>') > provider);

  // An imported student's one-time summary says "Continue" when Getting Started comes next.
  assert.match(root,
    /<ImportWelcomeScreen onSignOut=\{signOut\} continueLabel=\{gsGate\.required \? 'Continue' : undefined\}/);
});

test('§28b GettingStartedContext is declared before its readers, and its default fails open', () => {
  const src = app();
  const decl = src.indexOf('\nconst GettingStartedContext = React.createContext(');
  assert.ok(decl > 0, 'GettingStartedContext must be a module-scope createContext');
  assert.equal(src.indexOf('const GettingStartedContext =', decl + 2), -1, 'declared once');
  const readers = [...src.matchAll(/useContext\(GettingStartedContext\)/g)].map((m) => m.index);
  assert.ok(readers.length >= 2, 'the page and the card read it');
  for (const at of readers) assert.ok(at > decl, 'a reader sits above the declaration');
  const m = /\nconst GettingStartedContext = React\.createContext\((Object\.freeze\(\{[\s\S]*?\}\))\);/.exec(src);
  assert.ok(m, 'the default must be a frozen object literal');
  // eslint-disable-next-line no-new-func
  const fallback = new Function(`return ${m[1]};`)();
  assert.equal(fallback.status, 'unavailable');
  assert.equal(fallback.data, null);
  assert.equal(typeof fallback.markCompleted, 'function');
  assert.equal(typeof fallback.refresh, 'function');
  assert.ok(Object.isFrozen(fallback));
  assert.deepEqual(gettingStartedGateInput(fallback), { status: 'unavailable', required: false },
    'read outside the provider it can only ever mean "render the app"');
});

test('§28b useGettingStarted asks the moment a uid exists, and answers during render', async () => {
  const U1 = 'uid-1';
  const gs = mountGettingStarted();
  assert.equal(gs.render(null, false).status, 'unavailable', 'signed out: nothing is asked and nothing is held');
  await settleAll();
  assert.equal(gs.calls.length, 0);

  let v = gs.render(U1, false);
  assert.deepEqual([v.status, v.data], ['loading', null],
    'a uid with no answer yet is LOADING, never "ready" — the gate holds its splash rather than render the app');
  await settleAll();
  assert.deepEqual(gs.calls.map((c) => c.name), ['my_onboarding_video'],
    'asked the moment the uid exists, keyed on it alone — not after the profile or the enrollment read');

  answer(gs.calls[0], { eligible: true, required: true, video: { id: 'v1' } });
  await settleAll();
  v = gs.render(U1, false);
  assert.deepEqual([v.status, v.data.required], ['ready', true]);
  assert.equal(gs.render(U1, false), v,
    'MEMOIZED — it is the context value, and a new object every render would re-render every reader');
  assert.deepEqual(gettingStartedGateInput(gs.render(U1, true)), { status: 'ready', required: true });
  await settleAll();
  assert.equal(gs.calls.length, 1, 'an eligible:true answer costs no second round trip when enrollPass turns true');

  // <React.StrictMode> (the dev server) mounts, cleans up and mounts again: still ONE question.
  const strict = mountGettingStarted(5_000, { strict: true });
  strict.render(U1, false); await settleAll();
  assert.equal(strict.calls.length, 1, 'keyed on the uid: StrictMode\'s second mount run must not ask again');
  answer(strict.calls[0], { eligible: true, required: false });
  await settleAll();
  assert.equal(strict.render(U1, false).status, 'ready', 'and the one answer is the one that counts');
});

test('§28b useGettingStarted fails open, and a late answer never drops a session into the gate', async () => {
  const U1 = 'uid-1';
  const U2 = 'uid-2';
  const warn = console.warn;
  console.warn = () => {};
  try {
    // An RPC error (a pre-#69 database answers PGRST202) and a thrown call: both unavailable.
    let gs = mountGettingStarted();
    gs.render(U1, true); await settleAll();
    gs.calls[0].resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.my_onboarding_video' } });
    await settleAll();
    assert.equal(gs.render(U1, true).status, 'unavailable', 'a missing function fails OPEN');
    gs = mountGettingStarted();
    gs.render(U1, true); await settleAll();
    gs.calls[0].reject(new TypeError('Failed to fetch'));
    await settleAll();
    assert.equal(gs.render(U1, true).status, 'unavailable', 'so does a thrown call');

    // No answer inside the bound: unavailable. The answer that lands afterwards is DISCARDED.
    gs = mountGettingStarted(20);
    gs.render(U1, true); await settleAll();
    await wait(80);
    assert.equal(gs.render(U1, true).status, 'unavailable', 'the bound is counted from the request');
    answer(gs.calls[0], { eligible: true, required: true });
    await settleAll();
    assert.equal(gs.render(U1, true).status, 'unavailable',
      'a late required:true must never flip a session that already failed open into the gate');

    // Another account's answer is never rendered, whatever it says.
    gs = mountGettingStarted();
    gs.render(U1, true); await settleAll();
    let v = gs.render(U2, true);
    assert.deepEqual([v.status, v.data], ['loading', null]);
    await settleAll();
    assert.equal(gs.calls.length, 2, 'the new account is asked for itself');
    answer(gs.calls[0], { eligible: true, required: true });
    await settleAll();
    assert.equal(gs.render(U2, true).status, 'loading', 'uid-1\'s answer is discarded for uid-2');
    answer(gs.calls[1], { eligible: true, required: false });
    await settleAll();
    v = gs.render(U2, true);
    assert.deepEqual([v.status, v.data.required], ['ready', false]);

    // A sign-out forgets the answer: the SAME account signing in again is asked afresh.
    gs.render(null, false); await settleAll();
    assert.equal(gs.render(U2, true).status, 'loading', 'never last session\'s answer');
    await settleAll();
    assert.equal(gs.calls.length, 3, 'and it IS asked again — a sign-out re-arms the first question, or the splash never ends');
    answer(gs.calls[2], { eligible: true, required: false });
    await settleAll();
    assert.equal(gs.render(U2, true).status, 'ready');
  } finally {
    console.warn = warn;
  }
});

test('§28b useGettingStarted re-asks once, on the state, when an approval lands on the pending screen', async () => {
  const U1 = 'uid-1';
  const gs = mountGettingStarted();
  gs.render(U1, false); await settleAll();
  answer(gs.calls[0], { eligible: false, required: false });   // still pending: correctly not eligible
  await settleAll();
  assert.equal(gs.render(U1, false).status, 'ready', 'the pending screen shows; nothing is held');

  const held = gs.render(U1, true);                             // the approval lands
  assert.deepEqual([held.status, held.data.eligible], ['loading', false],
    'a cached eligible:false under enrollPass HOLDS — rendering it would flash the dashboard');
  await settleAll();
  assert.equal(gs.calls.length, 2, 'the answer is asked for once more');
  for (let i = 0; i < 3; i += 1) { gs.render(U1, true); await settleAll(); }
  assert.equal(gs.calls.length, 2, 'at most once per account');
  gs.render(U1, false); await settleAll();
  gs.render(U1, true); await settleAll();
  assert.equal(gs.calls.length, 2, '…even when enrollPass wobbles while the re-ask is in flight');
  answer(gs.calls[1], { eligible: true, required: true });
  await settleAll();
  const after = gs.render(U1, true);
  assert.deepEqual([after.status, after.data.required], ['ready', true], 'then Getting Started — never the dashboard first');

  // THE RACE: asked while pending, answered only after the approval landed. The answer was
  // REQUESTED before enrollPass turned true, so it may predate the approval — held, and asked again.
  const race = mountGettingStarted();
  race.render(U1, false); await settleAll();
  race.render(U1, true);
  answer(race.calls[0], { eligible: false, required: false });
  await settleAll();
  assert.equal(race.render(U1, true).status, 'loading',
    'reaskedAfterPass is decided when the request is SENT, never when its answer lands');
  await settleAll();
  assert.equal(race.calls.length, 2);

  // The re-ask is bounded like any request, and failing it fails OPEN.
  const slow = mountGettingStarted(20);
  slow.render(U1, false); await settleAll();
  answer(slow.calls[0], { eligible: false, required: false });
  await settleAll();
  slow.render(U1, true); await settleAll();
  await wait(80);
  assert.equal(slow.render(U1, true).status, 'unavailable', 'a re-ask that times out is unavailable');
});

test('§28b markCompleted lets the gate pass at once, and refresh() asks again', async () => {
  const U1 = 'uid-1';
  const gs = mountGettingStarted();
  gs.render(U1, true); await settleAll();
  answer(gs.calls[0], { eligible: true, required: true, completed: false, completed_current: false, completed_at: null });
  await settleAll();
  let v = gs.render(U1, true);
  assert.equal(v.uid, U1, 'the answer names the account it is for — what a caller hands back to markCompleted');
  assert.equal(v.markCompleted({ ok: true, recorded: true, video_id: 'v1', completed_at: '2026-09-30T02:00:00Z', first_completion: true }, U1), true);
  v = gs.render(U1, true);
  assert.deepEqual(
    [v.status, v.data.required, v.data.completed, v.data.completed_current, v.data.completed_at],
    ['ready', false, true, true, '2026-09-30T02:00:00Z'], 'merged into THIS account\'s answer');
  assert.equal(gs.calls.length, 1, 'with no round trip');

  v.refresh(); await settleAll();
  assert.equal(gs.calls.length, 2, 'refresh() asks again, for the current account');
  answer(gs.calls[1], { eligible: true, required: false, video: null });
  await settleAll();
  v = gs.render(U1, true);
  assert.equal(v.data.video, null, 'a successful refresh replaces the answer');

  // An answer asked for BEFORE a completion is stale the moment the completion is recorded.
  v.refresh(); await settleAll();
  v.markCompleted({ ok: true, recorded: true, completed_at: '2026-09-30T03:00:00Z' }, U1);
  answer(gs.calls[2], { eligible: true, required: true, completed: false });
  await settleAll();
  assert.equal(gs.render(U1, true).data.required, false, 'a completion is never undone by an answer from before it');
});

test('§28b a replay in a hidden keep-alive tab pauses — one scrolled out of view does not', () => {
  const rt = hookRuntime();
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.live = true; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.live = false; }
  }
  const usePauseWhenHidden = liftHook('usePauseWhenHidden', rt, { IntersectionObserver: FakeObserver });
  const frame = { offsetParent: {} };
  let pauses = 0;
  let plays = 0;
  const frameRef = { current: frame };
  const mediaRef = { current: { pause: () => { pauses += 1; }, play: () => { plays += 1; return Promise.resolve(); } } };
  rt.render(usePauseWhenHidden, frameRef, mediaRef);
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].targets, [frame],
    'it observes the always-mounted FRAME — SignedLessonVideo replaces the <video> on every re-sign');
  observers[0].callback([{ isIntersecting: false }]);
  assert.equal(pauses, 0, 'scrolled out of view it still has a box, and keeps playing (a student reading the transcript)');
  frame.offsetParent = null;
  observers[0].callback([{ isIntersecting: false }]);
  assert.equal(pauses, 1, 'its keep-alive panel was hidden: paused');
  observers[0].callback([{ isIntersecting: true }]);
  assert.equal(pauses, 1, 'and coming back never resumes it — nothing here plays by itself');
  assert.equal(plays, 0, 'never a play() — a written-out start (`.play?.()` included) is still a start');
  mediaRef.current = null;
  observers[0].callback([{ isIntersecting: false }]);        // between re-signs there is no <video>
  rt.unmount();
  assert.equal(observers[0].live, false, 'the observer is let go on unmount');

  // ★ THE CASE THE INTERSECTION OBSERVER CANNOT SEE. A frame already scrolled out of view is
  //   hidden with its panel: it was not intersecting before and is not now, so no intersection
  //   entry arrives — measured in Chrome, the video played on in the hidden tab. A box that
  //   goes to display:none is a SIZE change whatever the scroll position, so a resize observer
  //   on the same frame catches it.
  const rt2 = hookRuntime();
  const intersections = [];
  const resizes = [];
  class FakeIntersection { constructor(callback) { this.callback = callback; intersections.push(this); } observe() {} disconnect() {} }
  class FakeResize {
    constructor(callback) { this.callback = callback; this.targets = []; this.live = true; resizes.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.live = false; }
  }
  const pauseHook = liftHook('usePauseWhenHidden', rt2, { IntersectionObserver: FakeIntersection, ResizeObserver: FakeResize });
  const frame2 = { offsetParent: {} };
  let pauses2 = 0;
  let plays2 = 0;
  rt2.render(pauseHook, { current: frame2 },
    { current: { pause: () => { pauses2 += 1; }, play: () => { plays2 += 1; return Promise.resolve(); } } });
  assert.equal(resizes.length, 1, 'a ResizeObserver watches the frame as well');
  assert.deepEqual(resizes[0].targets, [frame2], '…the same frame, never the <video>');
  intersections[0].callback([{ isIntersecting: false }]);      // scrolled out of view: nothing
  frame2.offsetParent = null;                                  // then the panel is hidden…
  resizes[0].callback([{ contentRect: { width: 0, height: 0 } }]);
  assert.equal(pauses2, 1, '…and the size change pauses it');
  frame2.offsetParent = {};
  resizes[0].callback([{ contentRect: { width: 640, height: 360 } }]);
  assert.equal(pauses2, 1, 'shown again, or resized: never a pause…');
  assert.equal(plays2, 0, '…and never a play — a hidden tab shown again stays paused until the student presses play');
  rt2.unmount();
  assert.equal(resizes[0].live, false, 'let go on unmount too');

  // …and every replay player uses it — on the frame, with the ref SignedLessonVideo keeps current.
  const player = jsCode(componentSource('GettingStartedPlayer'));
  assert.match(player, /\n  usePauseWhenHidden\(frameRef, mediaRef\);/, 'called unconditionally, at the top level');
  assert.match(player, /return \(\s*<div ref=\{setFrame\} className="gs-stage"/,
    'the frame is the element the player RETURNS — mounted for its whole life, in every state');
  assert.match(player, /const setFrame = useCallback\(\(node\) => \{\s*frameRef\.current = node;\s*if \(stageRef\) stageRef\.current = node;\s*\}, \[stageRef\]\);/,
    'the frame the observer watches is the element the caller focuses after a Retry — one element, two refs');
  assert.match(player, /<SignedLessonVideo [^>]*\bmediaRef=\{mediaRef\}/,
    'mediaRef is the ref SignedLessonVideo keeps on the current <video>');
  assert.ok(!/mediaRef=\{frameRef\}|\bref=\{mediaRef\}/.test(player), 'the frame and the video refs are never swapped');
  assert.match(jsCode(componentSource('GettingStartedPage')), /<GettingStartedPlayer\b[^>]*\bmode="page"/);
  assert.match(jsCode(componentSource('GettingStartedCard')), /<GettingStartedPlayer\b[^>]*\bmode="card"/);
});

test('§28b one door each: the completion, the start, the state read — and every problem report is coded', async () => {
  const src = app();
  const quoted = (name) => (src.match(new RegExp(`['"\`]${name}['"\`]`, 'g')) || []).length;
  assert.equal(quoted('complete_onboarding_video'), 1,
    'the completion RPC is called from ONE helper — a second call site is a second way to read its refusals');
  assert.ok(moduleAsyncFn(src, 'recordOnboardingCompletion').includes("supabase.rpc('complete_onboarding_video')"));
  assert.equal(quoted('start_onboarding_video'), 1, 'the start RPC is called by the player alone');
  assert.ok(componentSource('GettingStartedPlayer').includes("supabase.rpc('start_onboarding_video')"));
  assert.equal(quoted('my_onboarding_video'), 1, 'the state is read by the root hook alone');
  assert.ok(componentSource('useGettingStarted').includes("supabase.rpc('my_onboarding_video')"));

  const reports = [...src.matchAll(/['"`]report_onboarding_video_problem['"`]/g)];
  assert.ok(reports.length >= 1, 'the player reports playback problems');
  for (const r of reports) {
    assert.match(src.slice(r.index, r.index + 120), /^'report_onboarding_video_problem', \{ p_code: onboardingProblemCode\(/,
      'a problem is reported as onboardingProblemCode(reason): the server keeps only its enum, so a raw '
      + 'player reason would be stored as "other"');
  }
  // The gate screen, the page and the card all record through the one helper — and only they do.
  assert.ok(componentSource('GettingStartedScreen').includes('await recordOnboardingCompletion()'));
  assert.ok(componentSource('useReplayRecorder').includes('await recordOnboardingCompletion()'));
  assert.equal((jsCode(src).match(/\brecordOnboardingCompletion\(/g) || []).length, 3,
    'the definition and its two callers: the gate screen, and the replay recorder the tab and the card share');

  // The helper, RUN: one RPC, the app error's code AND its context, and it never throws.
  const run = (rpc) => new Function('supabase', 'appErrorCode', 'appErrorContext', 'ONBOARDING_COMPLETE_TIMEOUT_MS',
    `${moduleAsyncFn(src, 'recordOnboardingCompletion')}\nreturn recordOnboardingCompletion;`)(
    { rpc }, appErrorCode, appErrorContext, 5_000)();
  const ok = { ok: true, recorded: true, video_id: 'v2', completed_at: '2026-09-30T02:00:00Z', first_completion: true };
  assert.deepEqual(
    await run(async (name) => { assert.equal(name, 'complete_onboarding_video'); return { data: ok, error: null }; }),
    { ok: true, data: ok, code: null, context: {}, error: null });
  const refused = {
    code: 'PT409', message: 'The Getting Started video has not played through.', hint: 'ONBOARDING_VIDEO_NOT_FINISHED',
    details: JSON.stringify({ code: 'ONBOARDING_VIDEO_NOT_FINISHED', context: { current_video_id: 'v2', started: false } }),
  };
  const r = await run(async () => ({ data: null, error: refused }));
  assert.deepEqual([r.ok, r.code, r.context, r.error],
    [false, 'ONBOARDING_VIDEO_NOT_FINISHED', { current_video_id: 'v2', started: false }, refused]);
  const thrown = await run(async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual([thrown.ok, thrown.code], [false, null], 'a network fault is a result, never a throw');
});

test('§28b the player: one start per mount, ranges that outlive the <video>, a verdict only on change', () => {
  const player = jsCode(componentSource('GettingStartedPlayer'));
  // ONE start per mount, <React.StrictMode> included: the request is kept, and each run of
  // the effect only listens to it.
  assert.match(player,
    /if \(!startRef\.current\) startRef\.current = Promise\.resolve\(\)\.then\(\(\) => supabase\.rpc\('start_onboarding_video'\)\);/);
  assert.match(player, /return \(\) => \{ alive = false; \};\s*\}, \[isLive\]\);/,
    'the start effect depends on nothing but whether the source is live');
  // A given version (the Super Admin's preview) starts nothing, and reports nothing.
  assert.match(player, /if \(!isLive\) return undefined;/);
  assert.match(player, /if \(isLive\) \{[\s\S]{0,500}report_onboarding_video_problem/);
  // Signed in the PRIVATE onboarding bucket, with the student's copy, on a memoized lesson.
  assert.match(player, /<SignedLessonVideo signUrl=\{signOnboardingVideo\} lesson=\{lesson\} isAdmin=\{false\}/);
  assert.match(player, /const lesson = useMemo\(/);
  // ★ WHAT WAS WATCHED OUTLIVES THE <video> AND THIS PLAYER (T8-G1). A Retry remounts the
  //   player (a new key) and a closed card unmounts it; ranges kept INSIDE it were lost with it
  //   — a student 55% in read "Watch the video to the end" after Retry, at 0:00. The record is
  //   the caller's (watchRef), the player only reads and extends it, and watchRecordFor() — in
  //   the lib, pinned there — is the ONE place a record starts over: for a different video.
  assert.match(player, /^function GettingStartedPlayer\(\{ mode = 'page', source = 'live', watchRef = null, stageRef = null, onVerdict, onGiveUp, onRecover \}\) \{/);
  assert.match(player, /const ownWatchRef = useRef\(null\);\s*const recordRef = watchRef \|\| ownWatchRef;/);
  assert.ok(!/playedRangesRef|ranges: \[\]|\.ranges = \[\]/.test(player), 'no record is started over here — only by watchRecordFor()');
  assert.match(player,
    /const record = watchRecordFor\(recordRef\.current, videoId\);\s*recordRef\.current = record;\s*record\.ranges = mergeRanges\(record\.ranges, video\.played\);\s*if \(Number\.isFinite\(video\.currentTime\)\) record\.position = video\.currentTime;/,
    'every event merges the element\'s own `played` into the record, and keeps the place');
  assert.match(player, /ranges: record\.ranges, seeking: video\.seeking,/, 'the verdict is measured on the whole record');
  // Seeded when the video is known: the same video carries on; another one starts a record and
  // clears what the caller shows about the old one.
  const seed = player.slice(player.indexOf('const kept = recordRef.current;'), player.indexOf('}, [videoId, recordRef]);'));
  assert.ok(seed.length > 0, 'the seeding effect was not found');
  assert.match(seed, /^const kept = recordRef\.current;\s*const next = watchRecordFor\(kept, videoId\);\s*if \(next === kept\) return;\s*recordRef\.current = next;\s*if \(kept\) onVerdictRef\.current\?\.\(null\);/);
  assert.match(player, /lastVerdictRef\.current = '';\s*if \(!videoId\) return;\s*const kept = recordRef\.current;/,
    'nothing is decided before the video is known — a null id at mount must not drop the caller\'s record');
  // A NEW <video> that opens at 0:00 goes back to where the student was — once per element.
  const ready = player.slice(player.indexOf('const handleReady = useCallback('), player.indexOf('}, [track, videoId, knownSeconds, recordRef]);'));
  assert.match(ready, /if \(video && resumedRef\.current !== video\) \{\s*resumedRef\.current = video;/);
  assert.match(ready, /const at = resumeAt\(recordRef\.current, videoId, Number\.isFinite\(own\) && own > 0 \? own : knownSeconds\);/);
  assert.match(ready, /if \(at > 0 && !\(video\.currentTime > 0\)\) \{\s*try \{ video\.currentTime = at; \}/,
    'only an element still at 0:00 — a re-sign has already put its own element back');
  assert.ok(ready.indexOf('resumeAt(') < ready.indexOf('track(null);'), 'then the verdict, measured on the kept record');
  for (const event of ['onEnded={track}', 'onTimeUpdate={track}', 'onSeeking={track}']) {
    assert.ok(player.includes(event), `${event} — every event that can move the verdict`);
  }
  // A verdict goes up when it CHANGES — not on every timeupdate, four times a second.
  assert.match(player,
    /const key = `\$\{v\.complete\}\|\$\{v\.playedPct\}\|\$\{v\.reason\}`;\s*if \(key === lastVerdictRef\.current\) return;/);
  assert.match(player, /onProblem=\{handleProblem\}/);
  assert.match(player, /onReady=\{handleReady\}/);
  for (const cb of ['onVerdict', 'onGiveUp', 'onRecover']) {
    assert.match(player, new RegExp(`const ${cb}Ref = useRef\\(${cb}\\);\\s*${cb}Ref\\.current = ${cb};`),
      `${cb} is a caller's inline closure — read it through a ref, so no effect re-runs on it`);
  }
});

test('§28b the gate screen answers every refusal of the completion, and its escape hatch records nothing', () => {
  const screen = jsCode(componentSource('GettingStartedScreen'));
  // Each branch is cut out on its own — a window that ran on into the next branch passed with
  // this one's reload deleted (mutation-tested).
  const branch = (from, to) => {
    const a = screen.indexOf(from);
    const b = screen.indexOf(to, a + from.length);
    assert.ok(a > 0 && b > a, `the branch ${from} … was not found`);
    return screen.slice(a, b);
  };
  const IF_NEW = 'if (ctx.current_video_id && ctx.current_video_id !== verdict?.videoId) {';
  const IF_UNSTARTED = '} else if (ctx.started === false) {';
  const IF_EARLY = '} else if (Number(ctx.seconds_remaining) > 0) {';
  // Replaced mid-watch: say so, START the player OVER — the new version's record begins at
  // nothing — and ask the root for the new video's title, length and transcript (T8-G4: they
  // described the retired one), KEEPING its answer if that fails: a cosmetic refresh must never
  // be what opens the gate.
  const replaced = branch(IF_NEW, IF_UNSTARTED);
  assert.ok(replaced.includes('A new Getting Started video was just published — please watch it from the start.'));
  assert.ok(replaced.includes('restartPlayer();'), 'replaced mid-watch: the player starts over');
  assert.ok(replaced.includes('gsRef.current?.refresh({ keep: true });'), '…and the intro and transcript follow the new video');
  assert.ok(branch(IF_UNSTARTED, IF_EARLY).includes('restartPlayer();'),
    'never started this version: start over, so start_onboarding_video() records it');
  assert.ok(!/reloadPlayer\(\);/.test(branch(IF_NEW, IF_EARLY)), 'neither refusal merely reloads: both mean "watch it again from the start"');
  assert.ok(screen.includes('Almost there — try again in a few seconds.'),
    'started too recently: the server\'s floor — said without a number, which a static message leaves to go stale (S5)');
  assert.ok(!/try again in \$\{/.test(screen), 'no count that stops counting');
  assert.match(screen,
    /r\.code === 'ONBOARDING_VIDEO_NOT_ELIGIBLE' \|\| r\.code === 'ONBOARDING_VIDEO_UNAVAILABLE'[\s\S]{0,400}gsRef\.current\?\.refresh\(\);/,
    'no live video, or no longer eligible: ask the root again, and the gate lets go');
  assert.match(screen, /retry: true/, 'anything else: an inline error with Retry');
  assert.ok(!/\b(?:setTab|goto|writeAppRoute|setPanelParam)\b|\blocation\./.test(screen),
    'the gate screen never navigates by itself — onDone is the root\'s to act on');
  // A player that gave up is retried by REMOUNTING it, so start_onboarding_video() runs again.
  assert.match(screen, /const reloadPlayer = useCallback\(\(\) => \{\s*setPlayerKey\(\(k\) => k \+ 1\);/);
  assert.match(screen, /<GettingStartedPlayer key=\{playerKey\} mode="gate" source="live"/);
  // …and a player that recovers by itself (a re-sign, its own "Try again") clears the panel.
  assert.match(screen, /const handleRecover = useCallback\(\(\) => setGiveUp\(null\), \[\]\);/);
  assert.match(screen, /\bonRecover=\{handleRecover\}/);
  // One completion per press: a state flag is not a lock (a double press sent two).
  assert.match(screen, /const finish = async \(\) => \{\s*if \(busyRef\.current\) return;\s*busyRef\.current = true;/);

  // ★ THE ESCAPE HATCH RECORDS NOTHING. It is offered only once the video would not play, and
  //   it must not "helpfully" mark the video watched, or ask any server anything.
  const hatch = screen.indexOf('Continue to dashboard for now');
  assert.ok(hatch > 0, 'a student whose video will not play is offered "Continue to dashboard for now"');
  assert.match(screen.slice(screen.lastIndexOf('<button', hatch), hatch), /onClick=\{onDefer\}/,
    'that button calls onDefer, and nothing else');
  // It holds for this session only, and says so truthfully: a reload asks again, not just a sign-in.
  assert.ok(screen.includes('Continuing now records nothing — we’ll ask you again the next time you open the toolkit.'));
  assert.ok(!/next time you sign in/.test(screen), 'a reload or a new tab asks again too — "sign in" promised less than happens');
  const arm = jsCode(rootSource());
  const defer = /onDefer=\{(\(\) => [^\r\n]*?)\}\r?\n/.exec(arm.slice(arm.indexOf('case GATE_SCREENS.GETTING_STARTED:')));
  assert.ok(defer, 'the root passes onDefer');
  assert.equal(defer[1], "() => { setGsDeferredUid(user?.id ?? null); setTab('dashboard'); }",
    'the defer handler remembers WHO deferred, for this session, asks no server anything — and lands on the '
    + 'Dashboard its button names, like onDone: from /welcome it used to reopen the very player that failed (GF-6)');
});

/**
 * The SPELLINGS of starting playback the scan below refuses, each with what it catches, so a miss
 * names its spelling. The first version caught `autoPlay` and `.play()` and passed
 * `video.autoplay = true`, `setAttribute('autoplay', '')` and `video['play']()` — the Task 8
 * re-verification found all three — and the residue pass's verifier then walked a destructured
 * `play` past the four patterns that followed (D1). Its own test, in the residue block below, keeps
 * it knowing each of them.
 * ★ A SOURCE SCAN, NOT A PROOF. A name built at run time (`video['pl' + 'ay']()`) cannot be listed,
 *   and passes; so this is "these spellings", never "every spelling" — here and in CLAUDE.md.
 * The destructuring pattern takes `play` only straight after the brace or after a comma, so a word
 * in a comment inside a block ("…could play: no card…") is not mistaken for one.
 */
const NO_AUTOPLAY_SPELLINGS = Object.freeze([
  [/autoplay/i, 'autoplay in any case — the autoPlay prop, the .autoplay property, setAttribute(\'autoplay\', …)'],
  [/muted/i, 'muted or defaultMuted — the condition under which a browser lets a page start a video by itself'],
  [/\.\s*play\b/, 'the .play member — .play(), .play?.(), .play.call(…), HTMLMediaElement.prototype.play'],
  [/(['"`])play\1/, '\'play\' looked up by name — video[\'play\'](), Reflect.get(video, \'play\')'],
  [/\{\s*(?:[^{}]*?,\s*)?play\s*[:,}=]/, 'a destructured play — const { play } = video, { play: go } = HTMLMediaElement.prototype'],
]);

test('§28b no gate or replay starts a video, quotes a price, or disables a button under the student\'s focus', () => {
  const code = gsCode();
  // The student presses play — nothing here starts playback, with sound or without.
  for (const [re, what] of NO_AUTOPLAY_SPELLINGS) assert.ok(!re.test(code), `nothing here may start playback: ${what}`);
  assert.ok(!/phpFmt|phpAmount|price_php|useCurrency|extensionPrice|EnrollmentPaywall|₱/.test(code),
    'a gate screen never quotes a price, and neither does its replay');
  const body = jsCode(componentSource('GettingStartedBody'));
  const label = body.indexOf('Go to dashboard <ArrowRight');
  assert.ok(label > 0, 'the Go to dashboard button was not found');
  const tag = body.slice(body.lastIndexOf('<button', label), label);
  assert.match(tag, /aria-disabled=\{locked \? 'true' : undefined\}/, 'while locked it is aria-disabled …');
  assert.ok(!/(?<![-\w])disabled[=\s>]/.test(tag), '… never `disabled`, which throws focus to <body> the moment it applies');
  assert.match(tag, /aria-describedby=\{unlocked \? undefined : hintId\}/, 'and points at the hint that says why');
  // A press while locked only says why, through the one polite live region.
  assert.match(body, /if \(!unlocked\) \{ say\(progress\); return; \}/);
  assert.match(body, /<div role="status" aria-live="polite" className="sr-only">/);
  assert.match(body, /say\('Your dashboard is unlocked\. Press Go to dashboard to continue\.'\);/, 'the unlock is announced …');
  assert.equal((body.match(/announcedRef\.current = true;/g) || []).length, 1, '… once');
});

test('§28b the page and the card read the context; the card sits under the hero and signs only when opened', () => {
  const page = jsCode(componentSource('GettingStartedPage'));
  assert.match(page, /const gs = useContext\(GettingStartedContext\);/);
  assert.match(page, /<SectionHead eyebrow="Home" title="Getting Started"/);
  assert.match(page, /onClick=\{\(\) => goto\?\.\('dashboard'\)\}/, 'Go to dashboard is a navigation on the page, never a completion');
  assert.ok(page.includes('There’s no Getting Started video right now.'), 'no live video, said plainly');

  const card = jsCode(componentSource('GettingStartedCard'));
  assert.match(card, /const gs = useContext\(GettingStartedContext\);/);
  assert.match(card, /const ent = useContext\(EntitlementContext\);/);
  assert.match(card, /ent\.allowsTab\('gettingstarted'\)/, 'the page link only where the plan opens the page');
  assert.match(card, /\{open \? \(\s*<>\s*<GettingStartedPlayer\b/,
    'the player — its start and its signing — mounts only when the card is opened');
  assert.match(card, /aria-expanded=\{open\}/);
  assert.match(card, /className="gs-card glass-card/, 'laid out by the .gs-card container, not the viewport');
  assert.ok(card.includes('No Getting Started video is live — new students go straight to their dashboard.'));

  const dash = jsCode(componentSource('Dashboard'));
  const hero = dash.indexOf('Get Hired With Alex');
  const at = dash.indexOf('<GettingStartedCard goto={goto} />');
  const panel = dash.indexOf('<MembershipPanel />');
  assert.ok(hero > 0 && at > hero && panel > at, 'the card sits directly under the hero, above the membership panel');
});

test('§28b navigation: Getting Started is first in Home, routed, spoken, and not counted as a tool', () => {
  const src = app();
  const at = src.indexOf('const DEFAULT_STAGES = [');
  const stages = src.slice(at, src.indexOf('\n  ];', at));
  const home = /id: 'home',[\s\S]*?tabs: \[\s*\{ id: '(\w+)', label: '([^']+)', icon: (\w+) \}/.exec(stages);
  assert.ok(home, 'the Home stage was not found');
  assert.deepEqual(home.slice(1), ['gettingstarted', 'Getting Started', 'PlayCircle'],
    'FIRST in Home: the flat merge inserts a new first default at index 0 of a saved layout, so no SIDEBAR_VERSION bump');

  const nonTools = extractPureLiteral(src, 'NON_TOOL_TAB_IDS');
  assert.equal(nonTools[0], 'gettingstarted', 'a welcome video is not a toolkit tool — the Dashboard tool count must not move');
  const set = /const NON_TOOL_TAB_IDS = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
  assert.ok(set.includes("'staffroles', 'meetings', 'financialmanagement'")
    && set.includes("'financialmanagement', 'communications', 'mockinterview'"),
  'the substrings test/meetingsSql.test.mjs and test/communicationsSql.test.mjs pin are intact');

  const routes = extractPureLiteral(src, 'TAB_ROUTES');
  assert.equal(routes.gettingstarted, '/getting-started');
  const seed = src.slice(src.indexOf('const ROUTE_TO_TAB ='), src.indexOf('const VALID_APP_TABS ='));
  assert.ok(seed.includes("'/welcome': { tab: 'gettingstarted' },"), 'the /welcome alias rides in the reduce\'s seed');
  assert.ok(!Object.values(routes).includes('/welcome'), 'and no tab owns /welcome');

  const info = extractPureLiteral(src, 'VOICE_TAB_INFO');
  assert.deepEqual(info.gettingstarted, {
    label: 'Getting Started', stage: 'Home',
    desc: 'Replay the Getting Started welcome video and see whether you have finished it.',
  });
  const aliases = extractPureLiteral(src, 'VOICE_TOOL_ALIASES');
  for (const phrase of ['getting started', 'getting started video', 'welcome video', 'onboarding video', 'intro video']) {
    assert.deepEqual(aliases[phrase], { tab: 'gettingstarted' }, phrase);
  }
  assert.ok(!Object.hasOwn(aliases, 'onboarding'), '"onboarding" stays the Client Onboarding tool');
  assert.equal(routes.onboarding, '/client-onboarding');
  assert.match(jsCode(src), /case 'gettingstarted': return <GettingStartedPage goto=\{goto\} \/>;/);
});

test('§28b the two introductions share one journey list, and the imported summary says Continue', () => {
  const src = app();
  const stages = extractPureLiteral(src, 'WELCOME_JOURNEY_STAGES');
  assert.deepEqual(stages.map((s) => [s.n, s.label]),
    [['01', 'Training & Skills'], ['02', 'Job Application'], ['03', 'Client Management']]);
  assert.ok(src.indexOf('\nconst WELCOME_JOURNEY_STAGES = ') < src.indexOf('\nfunction WelcomeOverlay('),
    'declared above its first reader');
  const welcome = jsCode(componentSource('WelcomeOverlay'));
  assert.ok(welcome.includes('{WELCOME_JOURNEY_STAGES.map(s => ('), 'WelcomeOverlay renders the shared list, exactly as before');
  assert.ok(!/const stages = \[/.test(welcome), 'and keeps no copy of its own');
  assert.ok(jsCode(componentSource('GettingStartedBody')).includes('WELCOME_JOURNEY_STAGES.map('));

  const summary = componentSource('ImportWelcomeScreen');
  assert.match(summary, /^function ImportWelcomeScreen\(\{ onContinue, onSignOut, continueLabel = 'Go To Dashboard' \}\) \{/,
    'the default label is unchanged');
  assert.match(summary, /\{continueLabel\}\s*<\/button>/);
});

test('§28b SignedLessonVideo reads onProblem only through its ref (T7-L1)', () => {
  // ★ A RENDER-BODY CALL WOULD REPORT ON EVERY RENDER. The three uses are the prop, the ref
  //   it seeds and the line that refreshes it; every report goes through onProblemRef, after a
  //   state change and guarded by mountedRef (§28a). A fourth bare use is a call §28a cannot
  //   see — `if (state === 'error') onProblem?.(…)` above the error frame, say — which would
  //   report a problem, and raise the gate's give-up state, on every re-render of that frame.
  const code = jsCode(signedVideo());
  assert.equal((code.match(/\bonProblem\b/g) || []).length, 3,
    'onProblem may appear only as the prop, in `useRef(onProblem)` and in `onProblemRef.current = onProblem`');
  assert.match(code, /const onProblemRef = useRef\(onProblem\);\s*onProblemRef\.current = onProblem;/);
});

test('§28b the stylesheet: the frame defers to .course-stage, the card follows its container, reduced motion stills both', () => {
  const sheet = css();
  assert.match(sheet, /\.gs-stage \{[^}]*width: min\(100%, calc\(min\(72vh, 820px\) \* 16 \/ 9\)\);/,
    'tighter than .course-stage\'s own cap, so the 16:9 box inside resolves to 100% and the two never fight');
  assert.match(sheet, /\.course-stage \{[^}]*width: min\(100%, calc\(min\(78vh, 900px\) \* 16 \/ 9\)\);/,
    'and that cap is still what the frame above was sized against');
  assert.match(sheet, /\.gs-card \{ container: gs-card \/ inline-size; \}/);
  assert.match(sheet, /@container gs-card \(min-width: 560px\)/);
  const reduce = [...sheet.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(reduce, /\.gs-card__player \{ animation: none; \}/);
  assert.match(reduce, /\.gs-progress__bar \{ transition: none; \}/);
});

test('§28b the card\'s breakpoint comment is the stylesheet\'s own arithmetic — and sizes the toggle the card has (K3R-CARD-COMMENT)', () => {
  // The widths in that comment were MEASURED in Chrome with Inter loaded (no source scan can see a
  // rendered width); this pins that its arithmetic uses the CSS's own icon, gap, threshold and cap.
  const sheet = css().replace(/\r\n/g, '\n');
  const icon = Number(/\.gs-card__icon \{\n {2}flex: 0 0 auto; width: (\d+)px;/.exec(sheet)?.[1]);
  const gap = Number(/\.gs-card__row \{ display: flex; flex-direction: column; gap: \d+px (\d+)px; \}/.exec(sheet)?.[1]);
  const T = Number(/@container gs-card \(min-width: (\d+)px\)/.exec(sheet)?.[1]);
  const cap = Number(/\.gs-card__actions \{ flex: 0 1 auto; max-width: (\d+)%;/.exec(sheet)?.[1]);
  assert.ok(icon && gap && T && cap, 'the card\'s rules were not found');
  const at = sheet.indexOf('★ The Dashboard card is laid out by the CARD');
  const comment = sheet.slice(at, sheet.indexOf('★ The journey strip', at));
  assert.ok(at > 0 && comment.length > 0, 'the card comment was not found');
  const m = /At (\d+) the\s+text keeps (\d+) − (\d+) − (\d+) − (\d+) ≈ (\d+)px/.exec(comment);
  assert.ok(m, 'the derivation was not found');
  assert.deepEqual([+m[1], +m[2], +m[3], +m[4]], [T, T, icon, 2 * gap], 'the threshold, the icon and the two gaps the CSS sets');
  assert.equal(+m[2] - +m[3] - +m[4] - +m[5], +m[6], 'and the subtraction holds');
  assert.ok(comment.includes(`${Math.round((T * cap) / 100)}px at ${T}`), 'the actions\' cap at the threshold');
  assert.ok(!/Play\/Replay/.test(comment), 'the toggle reads "Open video" / "Close video" now');
  assert.match(comment, /"Open video" \/ "Close video" toggle/);
});

// ── §28b, continued: what the Task 8 review found (#69) ──────────────────────
// Each test below names the verified finding it pins; every guard was mutation-tested.

test('§28b "Continue for now" holds for this session and this account — and a sign-out forgets it (T8-G3)', () => {
  // The root's own lines, RUN: signOut() does not reload the page, so the root stays mounted
  // and a deferral kept only by uid comparison outlived the sign-out — the same student signing
  // in again went straight to the app, though the panel had promised to ask again.
  const root = rootSource().replace(/\r\n/g, '\n');
  const from = root.indexOf('  const [gsDeferredUid, setGsDeferredUid] = useState(null);');
  const to = root.indexOf('  // #49: the invitation token', from);
  assert.ok(from > 0 && to > from, 'the deferral lines were not found');
  const rt = hookRuntime();
  // eslint-disable-next-line no-new-func
  const useDeferral = new Function('useState', 'useRef', 'useCallback', 'useMemo', 'useEffect',
    `return function useDeferral(user) {\n${root.slice(from, to)}\nreturn { gsDeferred, setGsDeferredUid };\n};`)(
    rt.hooks.useState, rt.hooks.useRef, rt.hooks.useCallback, rt.hooks.useMemo, rt.hooks.useEffect);
  const U1 = { id: 'uid-1' };
  let d = rt.render(useDeferral, U1);
  assert.equal(d.gsDeferred, false);
  d.setGsDeferredUid('uid-1');                            // "Continue to dashboard for now"
  assert.equal(rt.render(useDeferral, U1).gsDeferred, true, 'deferred: this account, this session');
  assert.equal(rt.render(useDeferral, { id: 'uid-2' }).gsDeferred, false, 'never another account');
  rt.render(useDeferral, null);                           // signOut() — the root stays mounted
  d = rt.render(useDeferral, U1);                         // the same student signs in again
  assert.equal(d.gsDeferred, false, 'a sign-out forgets it: the student is asked again');
});

test('§28b a refresh asked to keep its answer never opens the gate when it fails (T8-G4)', async () => {
  // A replaced video's title and transcript are refreshed from the root. That refresh is
  // COSMETIC: failing it the ordinary way ('unavailable') would fail the gate open under a
  // student who has not watched the new video — so refresh({ keep: true }) keeps the answer.
  const U1 = 'uid-1';
  const warn = console.warn;
  console.warn = () => {};
  try {
    const gs = mountGettingStarted(150);
    gs.render(U1, true); await settleAll();
    answer(gs.calls[0], { eligible: true, required: true, video: { id: 'v1', transcript: 'V1' } });
    await settleAll();
    let v = gs.render(U1, true);
    assert.deepEqual([v.status, v.data.required], ['ready', true]);

    v.refresh({ keep: true }); await settleAll();
    gs.calls[1].reject(new TypeError('Failed to fetch')); await settleAll();
    v = gs.render(U1, true);
    assert.deepEqual([v.status, v.data?.required, v.data?.video?.transcript], ['ready', true, 'V1'],
      'a thrown keep-refresh leaves the answer — and the gate — where they were');
    v.refresh({ keep: true }); await settleAll();
    gs.calls[2].resolve({ data: null, error: { code: 'XX000', message: 'boom' } }); await settleAll();
    assert.equal(gs.render(U1, true).status, 'ready', 'so does an RPC error');
    v.refresh({ keep: true }); await settleAll();
    await wait(400);                                      // past the 150 ms bound
    assert.equal(gs.render(U1, true).status, 'ready', 'and a timeout');

    v.refresh({ keep: true }); await settleAll();
    answer(gs.calls[4], { eligible: true, required: true, video: { id: 'v2', transcript: 'V2' } }); await settleAll();
    assert.equal(gs.render(U1, true).data.video.transcript, 'V2', 'a keep-refresh that SUCCEEDS replaces it');

    // Without keep, a failure still fails OPEN — the gate's rule for a question it cannot answer.
    v.refresh(); await settleAll();
    gs.calls[5].reject(new TypeError('Failed to fetch')); await settleAll();
    assert.equal(gs.render(U1, true).status, 'unavailable');

    // ★ A cosmetic refresh never CANCELS a real question in flight. The approval re-ask holds
    //   the splash until it lands; had the keep-refresh made it stale and then failed, nothing
    //   would ever end the splash.
    const held = mountGettingStarted(5_000);
    held.render(U1, false); await settleAll();
    answer(held.calls[0], { eligible: false, required: false }); await settleAll();
    const h1 = held.render(U1, true); await settleAll();             // the approval lands: re-ask
    assert.deepEqual([h1.status, held.calls.length], ['loading', 2]);
    h1.refresh({ keep: true }); await settleAll();
    held.calls[2].reject(new TypeError('Failed to fetch')); await settleAll();
    answer(held.calls[1], { eligible: true, required: true }); await settleAll();
    const h2 = held.render(U1, true);
    assert.deepEqual([h2.status, h2.data.required], ['ready', true], 'the re-ask still ends the splash');
    // …and a completion still outranks an answer asked for before it, keep or not.
    h2.refresh({ keep: true }); await settleAll();
    h2.markCompleted({ ok: true, recorded: true, completed_at: '2026-09-30T04:00:00Z' }, U1);
    answer(held.calls[3], { eligible: true, required: true, completed: false }); await settleAll();
    assert.equal(held.render(U1, true).data.required, false, 'a keep-refresh from before a completion never undoes it');
  } finally {
    console.warn = warn;
  }
});

test('§28b a Retry — or closing the card — keeps what was watched: the record lives above the keyed player (T8-G1)', () => {
  for (const name of ['GettingStartedScreen', 'GettingStartedPage', 'GettingStartedCard']) {
    const code = jsCode(componentSource(name));
    assert.match(code, /\n  const watchRef = useRef\(null\);/, `${name} owns the watch record, above the player it keys`);
    const at = code.indexOf('<GettingStartedPlayer ');
    const el = code.slice(at, code.indexOf('/>', at));
    assert.match(el, /\bkey=\{playerKey\}/, `${name}: the player is keyed, so a Retry remounts it…`);
    assert.match(el, /\bwatchRef=\{watchRef\}/, `${name}: …and handed the record that outlives the remount`);
    assert.match(el, /\bstageRef=\{stageRef\}/, `${name}: …and the ref focus returns to`);
    const cut = (sig) => {
      const a = code.indexOf(sig);
      assert.ok(a > 0, `${name}: ${sig} was not found`);
      return code.slice(a, code.indexOf('}, [', a));
    };
    assert.ok(!/watchRef|setVerdict/.test(cut('const retryPlayer = useCallback(')), `${name}: Retry keeps the record and the verdict`);
    assert.match(cut('const restartPlayer = useCallback('), /watchRef\.current = null;/, `${name}: only a start over drops it`);
    assert.equal((code.match(/watchRef\.current = /g) || []).length, 1, `${name}: and nothing else writes it`);
  }
  const screen = jsCode(componentSource('GettingStartedScreen'));
  const reload = screen.slice(screen.indexOf('const reloadPlayer = useCallback('), screen.indexOf('}, []);', screen.indexOf('const reloadPlayer = useCallback(')));
  assert.ok(!/setVerdict/.test(reload), 'the plain reload keeps the verdict — the reloaded player re-derives it from the kept record');
  assert.match(screen, /const restartPlayer = useCallback\(\(\) => \{\s*watchRef\.current = null;\s*setVerdict\(null\);\s*reloadPlayer\(\);\s*\}, \[reloadPlayer\]\);/);
  // The replay recorder's reload IS a start over: a newer version, or one never seen started.
  for (const name of ['GettingStartedPage', 'GettingStartedCard']) {
    assert.match(jsCode(componentSource(name)), /const replay = useReplayRecorder\(gs, restartPlayer\);/);
  }
  // The card's record belongs to the CARD — not to {open ? …}, which unmounts on close.
  const card = jsCode(componentSource('GettingStartedCard'));
  assert.ok(card.indexOf('const watchRef = useRef(null);') < card.indexOf('if (!data) return null;'));
});

/** useReplayRecorder, lifted onto the runtime: each completion waits for the test to answer it. */
function mountReplayRecorder(data) {
  const rt = hookRuntime();
  const sends = [];
  const timers = [];
  let reloads = 0;
  const gs = {
    data, uid: 'uid-replay', marked: [], markedFor: [], refreshed: [],
    markCompleted(r, forUid) { this.marked.push(r); this.markedFor.push(forUid); return forUid === this.uid; },
    refresh(options) { this.refreshed.push(options ?? null); },
  };
  const hook = liftHook('useReplayRecorder', rt, {
    recordOnboardingCompletion: () => new Promise((resolve) => { sends.push(resolve); }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const onReload = () => { reloads += 1; };
  return { gs, sends, timers, render: () => rt.render(hook, gs, onReload), reloads: () => reloads };
}

test('§28b the replay recorder: once per version, only when it counts, and re-armed after a blip (T8-G2, T8-G6, T8-G7)', async () => {
  const V1 = 'v1';
  const done = (over = {}) => ({ complete: true, playedPct: 100, reason: 'ended', videoId: V1, ...over });
  const OK = { ok: true, data: { ok: true, recorded: true, video_id: V1, completed_at: '2026-09-30T02:00:00Z' }, code: null, context: {} };
  const fail = (code, context = {}) => ({ ok: false, data: null, code, context });
  const OPEN = { eligible: true, completed_current: false };

  // Eligible, this version not finished: ONE completion, merged into the root's answer.
  let m = mountReplayRecorder(OPEN);
  let r = m.render();
  r.onVerdict({ complete: false, playedPct: 40, reason: 'watch_more', videoId: V1 });
  assert.equal(m.sends.length, 0, 'an unfinished verdict sends nothing');
  r.onVerdict(done()); r.onVerdict(done()); r.onVerdict(done({ reason: 'near_end' }));
  assert.equal(m.sends.length, 1, 'once per version, however many complete verdicts arrive');
  m.sends[0](OK); await settleAll();
  assert.deepEqual(m.gs.marked, [OK.data], 'a recorded completion is merged into the root\'s answer');
  assert.equal(m.render().note, null);

  // Never for a viewer the server would not record, nor a version already finished.
  for (const data of [{ eligible: false }, { eligible: 'true' }, { eligible: true, completed_current: true }, null]) {
    m = mountReplayRecorder(data);
    m.render().onVerdict(done());
    assert.equal(m.sends.length, 0, `nothing is sent for ${JSON.stringify(data)}`);
  }
  m = mountReplayRecorder(OPEN);
  m.render().onVerdict(done({ videoId: null }));
  assert.equal(m.sends.length, 0, 'nor for a verdict that names no video');

  // ★ "Completed" means the server has it: { ok: true, recorded: false } marks nothing (T8-G7).
  m = mountReplayRecorder(OPEN);
  m.render().onVerdict(done());
  m.sends[0]({ ok: true, data: { ok: true, recorded: false }, code: null, context: {} }); await settleAll();
  assert.deepEqual(m.gs.marked, [], 'a staff viewer\'s replay records nothing, so nothing may read "Completed"');

  // ★ A BLIP RE-ARMS THE VERSION (T8-G2): the note promises "the next time you watch it to the end".
  m = mountReplayRecorder(OPEN);
  r = m.render();
  r.onVerdict(done());
  m.sends[0](fail(null)); await settleAll();
  assert.match(m.render().note, /It will be recorded the next time you watch it to the end\./);
  r.onVerdict({ complete: false, playedPct: 100, reason: 'playing', videoId: V1 });   // rewound…
  r.onVerdict(done());                                                             // …and to the end again
  assert.equal(m.sends.length, 2, 'the promise is kept: the next full watch sends it again');
  m.sends[1](OK); await settleAll();
  assert.deepEqual(m.gs.marked, [OK.data]);
  assert.equal(m.render().note, null, 'and the note goes');
  // NOT_FINISHED with no usable wait is the same kind of failure: re-armed too.
  for (const context of [{ current_video_id: V1, started: true }, { current_video_id: V1, started: true, seconds_remaining: 9999 }]) {
    m = mountReplayRecorder(OPEN);
    m.render().onVerdict(done());
    m.sends[0](fail('ONBOARDING_VIDEO_NOT_FINISHED', context)); await settleAll();
    m.render().onVerdict(done());
    assert.equal(m.sends.length, 2, `re-armed after NOT_FINISHED ${JSON.stringify(context)}`);
  }

  // The server's floor has not passed: asked ONCE more when it has — never re-sent meanwhile.
  m = mountReplayRecorder(OPEN);
  m.render().onVerdict(done());
  m.sends[0](fail('ONBOARDING_VIDEO_NOT_FINISHED', { current_video_id: V1, started: true, seconds_remaining: 3.2 })); await settleAll();
  assert.deepEqual(m.timers.map((t) => t.ms), [5000], 'ceil(3.2) + 1 seconds');
  m.render().onVerdict(done());
  assert.equal(m.sends.length, 1, 'a complete verdict meanwhile sends no second request');
  m.timers[0].fn();
  assert.equal(m.sends.length, 2, 'the retry, once the floor has passed');

  // A newer version: start the player over, and ask for its details — keeping the answer if that fails.
  m = mountReplayRecorder(OPEN);
  m.render().onVerdict(done());
  m.sends[0](fail('ONBOARDING_VIDEO_NOT_FINISHED', { current_video_id: 'v2', started: false })); await settleAll();
  assert.equal(m.reloads(), 1, 'the player starts over on the new version');
  assert.deepEqual(m.gs.refreshed, [{ keep: true }], 'its title, length and transcript are asked for (T8-G4)');
  assert.match(m.render().note, /A new Getting Started video was just published/);

  // This version never started: re-armed, and started over.
  m = mountReplayRecorder(OPEN);
  m.render().onVerdict(done());
  m.sends[0](fail('ONBOARDING_VIDEO_NOT_FINISHED', { current_video_id: V1, started: false })); await settleAll();
  assert.equal(m.reloads(), 1);
  m.render().onVerdict(done());
  assert.equal(m.sends.length, 2);

  // No longer eligible, or nothing live: the root is asked again — plainly, so it may fail open.
  m = mountReplayRecorder(OPEN);
  m.render().onVerdict(done());
  m.sends[0](fail('ONBOARDING_VIDEO_NOT_ELIGIBLE')); await settleAll();
  assert.deepEqual(m.gs.refreshed, [null]);
});

test('§28b every Retry that removes itself hands focus back — never to <body> (T8-UI-1)', () => {
  // The helper, RUN: only when focus really was lost, and only once the removing commit landed.
  const frames = [];
  const doc = { body: { tag: 'body' }, activeElement: null };
  let focused = 0;
  // eslint-disable-next-line no-new-func
  const refocusIfLost = new Function('requestAnimationFrame', 'document',
    `${componentSource('refocusIfLost')}\nreturn refocusIfLost;`)((fn) => { frames.push(fn); return frames.length; }, doc);
  const flush = () => { while (frames.length) frames.shift()(); };
  const focusArgs = [];
  const target = { current: { focus: (...args) => { focused += 1; focusArgs.push(args); } } };
  doc.activeElement = doc.body;
  refocusIfLost(target);
  frames.shift()();
  assert.equal(focused, 0, 'not after one frame — React may not have committed the removal yet');
  flush();
  assert.equal(focused, 1, 'focus had fallen to <body>: it goes to the stable element');
  refocusIfLost(target, { preventScroll: true }); flush();
  assert.deepEqual(focusArgs, [[undefined], [{ preventScroll: true }]],
    'its options go to focus() as they are — the gate\'s hand-over to <main> must not scroll (K3R-FOCUS-HANDOVER)');
  focused = 1;
  doc.activeElement = { tag: 'button' };
  refocusIfLost(target); flush();
  assert.equal(focused, 1, 'focus is somewhere real (a dialog, the next control): left alone');
  doc.activeElement = null;
  refocusIfLost(target); flush();
  assert.equal(focused, 2, 'no active element at all is lost too');
  refocusIfLost({ current: null }); flush();             // the element went too (the gate let go)
  refocusIfLost(null); flush();

  // Every Retry and "Try again" on these surfaces goes through a handler that restores focus.
  const HANDLERS = {
    GettingStartedScreen: ['retryPlayer', 'retryFinish'],
    GettingStartedPage: ['retryPlayer', 'tryAgain'],
    GettingStartedCard: ['retryPlayer'],
  };
  for (const [name, allowed] of Object.entries(HANDLERS)) {
    const code = jsCode(componentSource(name));
    const labels = [...code.matchAll(/aria-hidden="true" \/> (?:Retry|Try again)\b/g)].map((mm) => mm.index);
    assert.ok(labels.length >= 1, `${name} has a Retry`);
    for (const at of labels) {
      const tag = code.slice(code.lastIndexOf('<button', at), at);
      const handler = (/onClick=\{(\w+)\}/.exec(tag) || [])[1] || tag;
      assert.ok(allowed.includes(handler), `${name}: a Retry calls \`${handler}\`, which must hand focus back (${allowed.join(' / ')})`);
    }
  }
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen, /const retryPlayer = useCallback\(\(\) => \{\s*reloadPlayer\(\);\s*refocusIfLost\(stageRef\);\s*\}, \[reloadPlayer\]\);/,
    'the give-up panel goes with its Retry: focus goes to the player that is reloading');
  assert.match(screen, /const retryFinish = \(\) => \{\s*refocusIfLost\(goRef\);\s*finish\(\);\s*\};/,
    'a message goes with its Retry: focus goes to Go to dashboard, the same action, now busy');
  assert.match(screen, /<GettingStartedBody [^>]*\bgoRef=\{goRef\}/);
  for (const name of ['GettingStartedPage', 'GettingStartedCard']) {
    assert.match(jsCode(componentSource(name)),
      /const retryPlayer = useCallback\(\(\) => \{\s*setPlayerKey\(\(k\) => k \+ 1\);\s*setGiveUp\(null\);\s*refocusIfLost\(stageRef\);\s*\}, \[\]\);/, name);
  }
  // "Try again" is replaced by whatever its ANSWER brings, so focus follows the answer.
  const page = jsCode(componentSource('GettingStartedPage'));
  assert.match(page, /const tryAgain = \(\) => \{\s*refocusOnAnswerRef\.current = true;\s*gs\.refresh\(\);\s*\};/);
  assert.match(page, /if \(!refocusOnAnswerRef\.current \|\| !data\) return;\s*refocusOnAnswerRef\.current = false;\s*refocusIfLost\(bodyRef\);\s*\}, \[data\]\);/);
  assert.equal((page.match(/\bref=\{bodyRef\} tabIndex=\{-1\}/g) || []).length, 2,
    'the card every answered state renders — the plain card and the video section — takes it');
  // The targets are focusable, and are the elements the refs name.
  const player = jsCode(componentSource('GettingStartedPlayer'));
  assert.match(player, /<div ref=\{setFrame\} className="gs-stage" data-gs-mode=\{mode\} tabIndex=\{-1\} role="group" aria-label="Getting Started video">/);
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.match(body, /const ownGoRef = useRef\(null\);\s*const goButtonRef = goRef \|\| ownGoRef;/);
  assert.match(body, /<button ref=\{goButtonRef\} type="button" data-gs-go/);
});

test('§28b once the gate unlocks it stays unlocked for that video, and 90% short of the end says "play it to the end" (T8-UI-2)', () => {
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen,
    /const onVerdict = useCallback\(\(v\) => \{\s*if \(v === null\) gsRef\.current\?\.refresh\(\{ keep: true \}\);\s*setVerdict\(\(shown\) => holdWatchVerdict\(shown, v\)\);\s*\}, \[\]\);/,
    'a rewind after the end — or the native replay — re-locked the button under a full progress bar');
  const el = screen.slice(screen.indexOf('<GettingStartedPlayer '), screen.indexOf('/>', screen.indexOf('<GettingStartedPlayer ')));
  assert.match(el, /\bonVerdict=\{onVerdict\}/);
  assert.ok(!/onVerdict=\{setVerdict\}/.test(screen), 'never straight into state');
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.match(body,
    /else if \(verdict\?\.reason === 'playing'\) progress = `Watched \$\{verdict\.playedPct\}% — play it to the end to unlock your dashboard\.`;/);
  assert.ok(body.indexOf('verdict.playedPct == null') < body.indexOf("verdict?.reason === 'playing'"),
    'an unknown share is answered first — never "Watched null%"');
  assert.ok(body.indexOf("verdict?.reason === 'playing'") < body.indexOf('— keep going to unlock your dashboard.'),
    '…and "keep going" is only for under 90%');
});

test('§28b the gate fits its video, progress and "Go to dashboard" on a laptop screen, and says what happens (T8-UI-3)', () => {
  const sheet = css();
  assert.match(sheet,
    /\n\.gs-stage\[data-gs-mode="gate"\] \{\s*width: min\(100%, calc\(max\(200px, 100vh - 420px\) \* 16 \/ 9\)\);\s*width: min\(100%, calc\(max\(200px, 100dvh - 420px\) \* 16 \/ 9\)\);\s*\}/,
    'the gate\'s frame answers to the window\'s height (392px measured around it + 28 spare), never under 200px tall');
  assert.ok(!/leaves a laptop\s+screen room for the heading/.test(sheet),
    'the old comment claimed a fit the 654px column never gave (Go ended 760px down)');
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.ok(!/opens as soon as it ends/.test(body), 'nothing opens by itself: the button unlocks, and the student presses it');
  assert.ok(body.includes('it shows you around. When you’ve watched it to the end, press Go to dashboard below.'),
    'the end alone unlocks nothing for a student who skipped part of it (S2)');
  assert.ok(!body.includes('When it ends, press Go to dashboard below.'));
  // Where the floor still leaves it below the fold, the unlock brings the button into view —
  // in the effect that announces it, once, without moving focus.
  const effect = body.slice(body.indexOf('announcedRef.current = true;'), body.indexOf('}, [unlocked, say, goButtonRef]);'));
  assert.ok(effect.length > 0, 'the unlock effect was not found');
  assert.match(effect, /goButtonRef\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest', behavior: reduce \? 'auto' : 'smooth' \}\);/);
  assert.match(effect, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/, 'no glide under reduced motion');
  assert.ok(!/\.focus\(/.test(effect), 'focus stays where the student left it');
});

test('§28b the small ones: the heading wraps a long name, and reduced motion stills the entrance and the skeleton (T8-UI-7, T8-UI-8)', () => {
  const body = jsCode(componentSource('GettingStartedBody'));
  // The heading's tag follows headingLevel (§28c): <Heading> is the gate's <h1>, and a preview's <h2>.
  const headAt = body.indexOf('<Heading ');
  assert.ok(headAt > 0, 'the Body\'s heading was not found');
  const h1 = body.slice(headAt, body.indexOf('>', headAt));
  assert.match(h1, /overflowWrap: 'anywhere'/, 'a full_name with no spaces (an email address) must wrap, not overflow a phone');
  const page = jsCode(componentSource('GettingStartedPage'));
  assert.match(page, /className="glass-card p-5 animate-pulse motion-reduce:animate-none"/, 'the loading skeleton');
  const reduce = [...css().matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(reduce, /\.gs-surface\.auth-in \{ animation: none; \}/, 'the gate\'s own entrance');
});

test('§28b who gets a player: never an ineligible viewer on the tab; a manager is always told why there is none (T8-G6)', () => {
  const page = jsCode(componentSource('GettingStartedPage'));
  const gate = page.indexOf('if (data.eligible !== true && !canManage) {');
  assert.ok(gate > 0 && gate < page.indexOf('<GettingStartedPlayer'), 'eligibility is decided before any player renders');
  const ret = page.slice(gate, page.indexOf('\n  }', gate));
  assert.match(ret, /return <div>\{head\}\{plain\('The Getting Started video opens here once your enrollment is approved\.'\)\}<\/div>;/);
  const card = jsCode(componentSource('GettingStartedCard'));
  const at = card.indexOf('if (!video || data.media_available === false) {');
  assert.ok(at > 0 && at < card.indexOf('<GettingStartedPlayer'));
  const none = card.slice(at, card.indexOf('\n  }', at));
  assert.match(none, /if \(!canManage\) return null;/, 'nothing a student could play: no card for them…');
  assert.ok(none.includes('No Getting Started video is live — new students go straight to their dashboard.'),
    '…but a manager is told why nobody is being asked');
  // The length verified at upload measures the share when the element reports Infinity.
  const player = jsCode(componentSource('GettingStartedPlayer'));
  assert.match(player, /duration_seconds: data\.duration_seconds \?\? null/);
  assert.match(player, /const duration = Number\.isFinite\(own\) && own > 0 \? own : \(knownSeconds \?\? own\);/);
});

// ─── §28c The Super Admin screen of the Getting Started video (#69, Task 9) ──
//
// GettingStartedVideoAdmin: the tab `gettingstartedadmin` (/admin/getting-started-video), the FIRST
// admin nav row, gated on onboarding.manage — Super Admin only. What it must never do is the kind
// of thing only a source scan or a lifted run can see here, because this repo has no JSX runtime:
//   • reach a student door (§28b pins each at one call site) — it calls admin_onboarding_video_*
//     and nothing else, and touches Storage only through its upload target's discard();
//   • replace the live video without being asked — p_replace_live: true lives in ONE handler;
//   • attach a file with facts about ANOTHER file, or write a stale draft from the render that
//     picked the file (T7-L3); or sweep the draft's SAVED file — the onboarding bucket's discard
//     has no reference check, so the uploader's `path === savedPath` guard is what protects it
//     (T7-L2);
//   • describe who a publish affects in any words but publishImpact()'s, read with required_since
//     exactly as the overview returned it.
// And the Task 10 client half, which rides here: Access Requests names the ACCOUNT (never an
// address) when it asks for the decision email, and Enrollments lands on the request the admin
// alert linked to (?request=<id>).
// Mutation-tested: every guard below was broken on purpose in a scratch copy, one at a time.

const appLF = () => app().replace(/\r\n/g, '\n');
const srcLF = (name) => moduleFn(appLF(), name);
/** A multi-line module-scope `const NAME = …` of the monolith, up to its closing line. */
function moduleBlock(src, name, close = '\n});') {
  const start = src.indexOf(`\nconst ${name} = `);
  assert.ok(start >= 0, `const ${name} must exist at module scope`);
  const end = src.indexOf(close, start);
  assert.ok(end > start, `const ${name} must close with ${JSON.stringify(close)}`);
  return src.slice(start + 1, end + close.length);
}
/** From a `const NAME = …` line inside a component to the end of the statement that closes it. */
function statementFrom(src, head, close) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head.trim()} was not found`);
  const end = src.indexOf(close, at);
  assert.ok(end > at, `${head.trim()} does not close with ${JSON.stringify(close)}`);
  return src.slice(at, end + close.length);
}
// The Super Admin screen and every module-scope helper it owns — the scope of the scans below.
const GS_ADMIN_PARTS = ['onboardingNoticeKind', 'onboardingNeedsAttention', 'onboardingUploadTarget', 'sweepOnboardingFile',
  'onboardingAttachArgs', 'onboardingAudienceLine', 'onboardingUnpublishLine', 'gsTextLength', 'gsLimitTransition',
  'GsLimitAnnouncer', 'GettingStartedManageLink', 'GettingStartedPreview', 'GettingStartedTitlePrompt',
  'GettingStartedConfirm', 'GettingStartedVideoAdmin'];
const gsAdminCode = () => jsCode(GS_ADMIN_PARTS.map((name) => srcLF(name)).join('\n'));
const ADMIN_ONBOARDING_RPCS = Object.freeze(['admin_onboarding_video_overview', 'admin_onboarding_video_create_draft',
  'admin_onboarding_video_update_details', 'admin_onboarding_video_attach_media', 'admin_onboarding_video_publish',
  'admin_onboarding_video_unpublish', 'admin_onboarding_video_delete']);
const V_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const V_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const U_1 = 'cccccccc-0000-4000-8000-000000000001';
const U_2 = 'dddddddd-0000-4000-8000-000000000002';

test('§28c the Super Admin screen calls admin_onboarding_video_* and nothing else — and Storage only through its target', () => {
  const code = gsAdminCode();
  const args = [...code.matchAll(/\.rpc\(\s*([^,)]+?)\s*[,)]/g)].map((m) => m[1]);
  assert.ok(args.length >= ADMIN_ONBOARDING_RPCS.length,
    `found ${args.length} RPC calls — the scan has stopped reading the screen`);
  const names = args.map((a) => {
    const lit = /^'([a-z0-9_]+)'$/.exec(a);
    assert.ok(lit, `an RPC is named by \`${a}\`, not a string literal — the set this screen calls must stay readable`);
    return lit[1];
  });
  for (const name of names) {
    assert.ok(ADMIN_ONBOARDING_RPCS.includes(name),
      `the Super Admin screen calls ${name} — its RPCs are the seven admin_onboarding_video_* and no others`);
  }
  assert.deepEqual([...new Set(names)].sort(), [...ADMIN_ONBOARDING_RPCS].sort(), 'each of the seven is called');
  // ★ THE STUDENT DOORS STAY SHUT. The preview renders the student's Body and Player on a GIVEN
  //   version, which starts nothing and records nothing; §28b counts each door at one call site.
  for (const door of ['my_onboarding_video', 'start_onboarding_video', 'complete_onboarding_video',
    'report_onboarding_video_problem', 'recordOnboardingCompletion']) {
    assert.ok(!code.includes(door), `the Super Admin screen reaches a student's door: ${door}`);
  }
  assert.ok(!/\.from\(\s*'/.test(code), 'no table is read or written from this screen — its RPCs are its only path');
  assert.equal((code.match(/supabase\.storage\b/g) || []).length, 1,
    'Storage is reached from ONE place — the upload target — so every removal is a discard() someone chose');
  assert.match(jsCode(srcLF('onboardingUploadTarget')),
    /discard: async \(p\) => \{\s*const \{ error \} = await supabase\.storage\.from\(ONBOARDING_VIDEO_BUCKET\)\.remove\(\[p\]\);\s*if \(error\) throw error;\s*\},/,
    'remove() RESOLVES its refusal: the discard throws it, so the caller\'s catch can log it (AUI-4)');
  assert.ok(!/getPublicUrl|createSignedUrl|signPrivateVideo\(/.test(code),
    'no URL is built here: the players sign through signOnboardingVideo, and only they do');
  // The badge reads the same overview, from the root.
  assert.ok(jsCode(rootSource()).includes("supabase.rpc('admin_onboarding_video_overview')"));
});

test('§28c replacing the live video is asked for: p_replace_live: true lives in the Replace dialog\'s handler alone', () => {
  assert.equal((jsCode(appLF()).match(/p_replace_live: true/g) || []).length, 1,
    'p_replace_live: true is written exactly once in the whole app');
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const replace = statementFrom(admin, 'const confirmReplace = () => runConfirm(async () => {', '\n  });');
  assert.match(replace,
    /supabase\.rpc\('admin_onboarding_video_publish', \{ p_video_id: v\.id, p_replace_live: true, p_expected_live_id: named\.id \}\)/,
    'and that once is the Replace dialog\'s handler — bound to the live version its dialog named (DBSEC-1)');
  const publish = statementFrom(admin, 'const confirmPublish = () => runConfirm(async () => {', '\n  });');
  assert.match(publish, /supabase\.rpc\('admin_onboarding_video_publish', \{ p_video_id: v\.id, p_replace_live: false \}\)/,
    'a plain publish says false, out loud');
  // ★ A live version it did not know about (published from another window) is answered with the
  //   Replace dialog — naming the version live NOW — never retried with true.
  assert.match(publish,
    /if \(appErrorCode\(error\) === 'ONBOARDING_VIDEO_REPLACE_CONFIRM'\) \{[\s\S]*?const ctx = appErrorContext\(error\);[\s\S]*?setConfirm\(\{ kind: 'replace', version: v, live: \{ id: ctx\.live_id, title: ctx\.live_title \|\| '' \}, raced: true \}\);/);
  // Reachable from ONE button: the Replace dialog's confirm.
  assert.equal((admin.match(/\bconfirmReplace\b/g) || []).length, 2, 'declared once, wired once');
  const branch = admin.slice(admin.indexOf("} else if (confirm.kind === 'replace') {"),
    admin.indexOf("} else if (confirm.kind === 'unpublish') {"));
  assert.ok(branch.length > 0, 'the Replace dialog branch was not found');
  assert.match(branch, /onConfirm=\{confirmReplace\}/, 'and that one wire is the Replace dialog\'s confirm');
  // A list's Publish goes straight to that dialog when another version is live — the overview knows.
  assert.match(admin,
    /const requestPublish = \(v\) => \{\s*if \(live && live\.id !== v\.id\) openConfirm\('replace', v, \{ live \}\);\s*else openConfirm\('publish', v\);\s*\};/);
});

test('§28c Save draft attaches the file with the facts the uploader verified FOR THAT FILE, then drops the file it replaced', () => {
  // eslint-disable-next-line no-new-func
  const args = new Function(`${srcLF('onboardingAttachArgs')}\nreturn onboardingAttachArgs;`)();
  const PATH = buildOnboardingVideoPath(V_A, U_1);
  const facts = { path: PATH, byteSize: 5_000_000, mimeType: 'video/quicktime', durationSeconds: 272.4, fileName: 'welcome.mov' };
  assert.deepEqual(args(V_A, PATH, facts), {
    p_video_id: V_A, p_storage_path: PATH, p_byte_size: 5_000_000, p_mime_type: 'video/quicktime',
    p_duration_seconds: 272.4, p_original_filename: 'welcome.mov',
  }, 'every attach argument, always, from what onMediaFacts reported for this path');
  const unknown = {
    p_video_id: V_A, p_storage_path: PATH, p_byte_size: null, p_mime_type: null,
    p_duration_seconds: null, p_original_filename: null,
  };
  assert.deepEqual(args(V_A, PATH, { ...facts, path: buildOnboardingVideoPath(V_A, U_2) }), unknown,
    'facts about ANOTHER upload describe nothing about this one');
  assert.deepEqual(args(V_A, PATH, null), unknown, 'no facts: the server reads size and type from the object');
  for (const bad of [Infinity, NaN, 0, -3, '272', null, undefined]) {
    assert.equal(args(V_A, PATH, { ...facts, durationSeconds: bad }).p_duration_seconds, null,
      `a length of ${String(bad)} is unknown, never a guess`);
  }
  for (const bad of [0, -1, 1.5, NaN, '5000000']) {
    assert.equal(args(V_A, PATH, { ...facts, byteSize: bad }).p_byte_size, null, `a size of ${String(bad)}`);
  }
  for (const bad of ['', '   ', null, 42]) {
    assert.equal(args(V_A, PATH, { ...facts, mimeType: bad }).p_mime_type, null);
    assert.equal(args(V_A, PATH, { ...facts, fileName: bad }).p_original_filename, null);
  }

  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const save = statementFrom(admin, 'const saveDraft = async () => {', '\n  };');
  assert.match(save, /supabase\.rpc\('admin_onboarding_video_attach_media',\s*onboardingAttachArgs\(id, newPath, mediaFactsRef\.current\)\)/,
    'the attach call reads the facts onMediaFacts recorded — never facts it made up');
  assert.match(admin,
    /const noteMediaFacts = useCallback\(\(facts\) => \{\s*mediaFactsRef\.current = \{ \.\.\.facts, path: readyPathRef\.current \};\s*\}, \[\]\);/,
    'recorded WITH the path the READY patch just named');
  assert.match(admin, /onMediaFacts=\{noteMediaFacts\}/);
  assert.ok(save.indexOf("'admin_onboarding_video_update_details'") > 0
    && save.indexOf("'admin_onboarding_video_update_details'") < save.indexOf("'admin_onboarding_video_attach_media'"),
  'the details, then the file');
  assert.match(save, /const newPath = draft\.storage_path && draft\.storage_path !== saved\.storage_path \? draft\.storage_path : null;/,
    'only a NEW file is attached');
  assert.match(save,
    /const previous = data\?\.previous_storage_path;\s*if \(previous && previous !== newPath\) \{[\s\S]{0,400}?sweepOnboardingFile\(onboardingUploadTarget\(id\), previous, /,
    'the file the upload replaced is removed — best effort, never silently, through the target');
  assert.match(save, /pendingPathRef\.current = null;/, 'an attached file is the draft\'s now, never an orphan to sweep');
});

test('§28c the onboarding upload target: this draft\'s folder, this draft\'s resume key, the private bucket — one record per draft', async () => {
  const src = appLF();
  const removed = [];
  const supabase = {
    storage: { from: (bucket) => ({ remove: async (paths) => { removed.push({ bucket, paths }); return { data: [], error: null }; } }) },
  };
  const signOnboardingVideo = async () => ({ url: 'https://storage.example/s', signedAt: 1 });
  // eslint-disable-next-line no-new-func
  const lifted = new Function('supabase', 'ONBOARDING_VIDEO_BUCKET', 'buildOnboardingVideoPath', 'onboardingVideoPathVideoId',
    'signOnboardingVideo',
    `${moduleBlock(src, 'ONBOARDING_UPLOAD_COPY')}\n${moduleConst(src, 'ONBOARDING_UPLOAD_TARGETS')}\n${srcLF('onboardingUploadTarget')}\n`
    + 'return { onboardingUploadTarget, ONBOARDING_UPLOAD_COPY };')(
    supabase, ONBOARDING_VIDEO_BUCKET, buildOnboardingVideoPath, onboardingVideoPathVideoId, signOnboardingVideo);
  const t = lifted.onboardingUploadTarget(V_A);
  assert.deepEqual(Object.keys(t),
    ['bucket', 'buildPath', 'isOwnPath', 'fingerprintScope', 'fingerprintPrefix', 'sign', 'discard', 'copy'],
    'LESSON_UPLOAD_TARGET\'s shape, key for key (§28a)');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(lifted.ONBOARDING_UPLOAD_COPY), 'a shared record must not be mutable');
  assert.equal(t.bucket, ONBOARDING_VIDEO_BUCKET, 'the PRIVATE onboarding bucket — never course-videos');
  const own = buildOnboardingVideoPath(V_A, U_1);
  assert.equal(t.buildPath({ uploadId: U_1 }), own);
  assert.equal(t.buildPath({ courseId: 'ignored', uploadId: U_1, fileName: 'My Welcome (final).mov' }), own,
    'no course and no filename in the object name — the original name is an admin-only column');
  assert.throws(() => t.buildPath({ uploadId: 'not-a-uuid' }), /upload id/,
    'a bad id THROWS, inside runTransfer\'s try/catch');
  assert.equal(t.isOwnPath(own), true);
  assert.equal(t.isOwnPath(buildOnboardingVideoPath(V_B, U_1)), false,
    'FOLDER-SCOPED: another draft\'s upload is not this draft\'s to adopt or resume into');
  for (const other of ['lessons/3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30/x.mp4', null, undefined, '', own.toUpperCase(), [own]]) {
    assert.equal(t.isOwnPath(other), false, JSON.stringify(other));
  }
  assert.equal(t.fingerprintScope, V_A, 'the tus resume key is this draft\'s…');
  assert.equal(t.fingerprintPrefix, 'gh-onboarding', '…and never a lesson\'s');
  assert.equal(t.sign, signOnboardingVideo);
  await t.discard(own);
  assert.deepEqual(removed, [{ bucket: ONBOARDING_VIDEO_BUCKET, paths: [own] }], 'a plain remove of exactly that object, in this bucket');
  // ★ remove() RESOLVES { error } on a refusal (AUI-4) — so the discard must throw it, or every caller's
  //   catch is dead code and the object stays in the bucket with nothing said anywhere.
  const denied = { status: 403, statusCode: '403', message: 'new row violates row-level security policy' };
  // eslint-disable-next-line no-new-func
  const refusing = new Function('supabase', 'ONBOARDING_VIDEO_BUCKET', 'buildOnboardingVideoPath', 'onboardingVideoPathVideoId',
    'signOnboardingVideo',
    `${moduleBlock(src, 'ONBOARDING_UPLOAD_COPY')}\n${moduleConst(src, 'ONBOARDING_UPLOAD_TARGETS')}\n${srcLF('onboardingUploadTarget')}\n`
    + 'return onboardingUploadTarget;')(
    { storage: { from: () => ({ remove: async () => ({ data: null, error: denied }) }) } },
    ONBOARDING_VIDEO_BUCKET, buildOnboardingVideoPath, onboardingVideoPathVideoId, signOnboardingVideo);
  await assert.rejects(refusing(V_A).discard(own), (e) => e === denied, 'the refusal itself, for the caller to log');
  assert.equal(t.copy, lifted.ONBOARDING_UPLOAD_COPY);
  assert.deepEqual(Object.keys(t.copy), ['pickLabel', 'fallbackName', 'accessRequired', 'removed', 'messages'],
    'LESSON_UPLOAD_COPY\'s four keys, and the refusals whose shared wording names a lesson (T9V-L1)');
  for (const [k, v] of Object.entries(t.copy)) {
    if (k === 'messages') continue;                       // its own test, below
    assert.ok(typeof v === 'string' && v.trim().length > 0, `${k} is said`);
    assert.ok(!/lesson/i.test(v), `${k} still speaks of a lesson: ${v}`);
  }
  assert.equal(lifted.onboardingUploadTarget(V_A), t, 'memoized per draft: the uploader is handed the SAME record every render');
  assert.notEqual(lifted.onboardingUploadTarget(V_B), t);
  assert.equal(lifted.onboardingUploadTarget(V_B).fingerprintScope, V_B);
  assert.equal(lifted.onboardingUploadTarget(null), null, 'no draft, nowhere for an upload to go');
  assert.equal(lifted.onboardingUploadTarget(undefined), null);
  assert.match(jsCode(srcLF('GettingStartedVideoAdmin')), /const uploadTarget = onboardingUploadTarget\(editorId\);/,
    'and the editor hands the uploader exactly this record');
});

test('§28c the uploader never discards the SAVED path — and the draft editor\'s own sweep skips it too (T7-L2)', async () => {
  // ★ LOAD-BEARING FOR THE ONBOARDING BUCKET. A lesson's discard is reference-aware; the Getting
  //   Started target's is a plain remove. This guard is all that stands between a Cancel, a Remove
  //   or a re-pick and the draft's saved file.
  const body = uploaderBody().replace(/\r\n/g, '\n');
  const decl = statementFrom(body, '  const discardPending = useCallback(async () => {',
    '}, [savedPath, notePendingPath, target]);');
  const cb = jsCode(decl);
  const guard = cb.indexOf('if (!path || path === savedPath) return;');
  const discard = cb.indexOf('await target.discard(path)');
  assert.ok(guard > 0, 'the guard `if (!path || path === savedPath) return;` is gone');
  assert.ok(discard > guard, 'the guard must come BEFORE target.discard(');
  assert.ok(!/\bpath\s*=(?!=)/.test(cb.slice(guard, discard)), 'nothing may reassign `path` between the guard and the discard');
  // RUN it.
  const run = async (pending, saved) => {
    const discarded = [];
    const noted = [];
    // eslint-disable-next-line no-new-func
    const fn = new Function('useCallback', 'pendingPathRef', 'notePendingPath', 'signedRef', 'savedPath', 'target', 'console',
      `${decl}\nreturn discardPending;`)((f) => f, { current: pending }, (p) => noted.push(p), { current: { url: 'x' } }, saved,
      { discard: async (p) => { discarded.push(p); } }, { error() {} });
    await fn();
    return { discarded, noted };
  };
  const SAVED = buildOnboardingVideoPath(V_A, U_1);
  const NEW = buildOnboardingVideoPath(V_A, U_2);
  assert.deepEqual((await run(SAVED, SAVED)).discarded, [], 'the SAVED file is never discarded');
  assert.deepEqual((await run(NEW, SAVED)).discarded, [NEW], 'an upload that was never saved is');
  assert.deepEqual((await run(NEW, null)).discarded, [NEW]);
  assert.deepEqual((await run(null, SAVED)).discarded, [], 'nothing pending, nothing removed');
  assert.deepEqual((await run(NEW, SAVED)).noted, [null], 'and the pending path is forgotten either way');
  // The draft editor's close sweep keeps the same rule, for the same reason.
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin,
    /const orphan = pendingPathRef\.current;\s*pendingPathRef\.current = null;\s*if \(orphan && orphan !== editor\.saved\.storage_path\) sweepOnboardingFile\(uploadTarget, orphan, /);
});

test('§28c the health banner speaks AdminNotice\'s language: info is its own kind, and unknown is a warning with a retry', () => {
  const src = appLF();
  const block = moduleBlock(src, 'ADMIN_NOTICE_KINDS', '\n};');
  // The three kinds every existing banner uses, byte for byte.
  for (const line of [
    "  ok: { fg: 'var(--status-ok-fg)', bg: 'var(--status-ok-bg)', bd: 'var(--status-ok-bd)', Icon: CheckCircle2 },",
    "  warn: { fg: 'var(--status-warn-fg)', bg: 'var(--status-warn-bg)', bd: 'var(--status-warn-bd)', Icon: AlertCircle },",
    "  danger: { fg: 'var(--status-danger-fg)', bg: 'var(--status-danger-bg)', bd: 'var(--status-danger-bd)', Icon: AlertTriangle },",
  ]) assert.ok(block.includes(`\n${line}\n`), `an existing AdminNotice kind changed: ${line.trim()}`);
  // eslint-disable-next-line no-new-func
  const kinds = new Function('CheckCircle2', 'AlertCircle', 'AlertTriangle', 'Info', `${block}\nreturn ADMIN_NOTICE_KINDS;`)(
    'CheckCircle2', 'AlertCircle', 'AlertTriangle', 'Info');
  assert.deepEqual(Object.keys(kinds), ['ok', 'warn', 'danger', 'info'], 'info is added, and nothing else moves');
  assert.deepEqual(kinds.info, { fg: 'var(--status-info-fg)', bg: 'var(--status-info-bg)', bd: 'var(--status-info-bd)', Icon: 'Info' });
  const notice = jsCode(srcLF('AdminNotice'));
  assert.match(notice, /const tone = ADMIN_NOTICE_KINDS\[kind\] \? kind : 'danger';/, 'an unknown kind is still danger');
  assert.match(notice, /const urgent = tone === 'danger';/, '…so info is announced politely, never as an alert');
  assert.match(notice, /role=\{urgent \? 'alert' : 'status'\}/);
  // onboardingHealth() level → kind, RUN.
  // eslint-disable-next-line no-new-func
  const kindOf = new Function(`${moduleConst(src, 'ONBOARDING_NOTICE_KINDS')}\n${srcLF('onboardingNoticeKind')}\nreturn onboardingNoticeKind;`)();
  for (const k of ['ok', 'info', 'warn', 'danger']) assert.equal(kindOf(k), k);
  for (const k of ['unknown', undefined, null, '', 'constructor', '__proto__', 'error']) {
    assert.equal(kindOf(k), 'warn', `${String(k)}: an unexpected level is a warning — not the danger an unknown kind renders as`);
  }
  assert.equal(kindOf(onboardingHealth({ live_video_id: null }).level), 'info', 'nothing live is information, neither green nor red');
  assert.equal(kindOf(onboardingHealth(null).level), 'warn', 'a read that failed is a warning');
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /<AdminNotice kind=\{onboardingNoticeKind\(health\.level\)\}>/, 'the banner reads the one mapping');
  assert.match(admin, /const health = onboardingHealth\(loadState === 'ready' \? overview : null\);/,
    'a reload that failed is unknown — never the last verdict shown as if it were current');
  assert.match(admin, /\{health\.code === 'unknown' \? \(\s*<button type="button" onClick=\{retryLoad\}/,
    'unknown: a warning with a retry, and never a badge (see the row test)');
});

test('§28c the admin row: first, a Clapperboard, and a badge raised by the verdict the banner shows', async () => {
  const src = appLF();
  const lucide = /import \{([\s\S]*?)\} from 'lucide-react';/.exec(src)[1].split(',').map((s) => s.trim());
  assert.ok(lucide.includes('Clapperboard'), 'Clapperboard is imported from lucide-react');
  const navAt = src.indexOf('const adminNavItems = useMemo(() => ([');
  const nav = src.slice(navAt, src.indexOf('].filter(', navAt));
  assert.equal([...nav.matchAll(/\{ id: '(\w+)'/g)].map((m) => m[1])[0], 'gettingstartedadmin', 'the FIRST admin row');
  assert.match(nav,
    /\{ id: 'gettingstartedadmin', label: 'Getting Started Video', Icon: Clapperboard, count: onboardingAttention, tone: C\.amber \},/);
  assert.match(src,
    /\]\.filter\(\(item\) => adminTabAllowed\(item\.id\)\)\),\s*\[onboardingAttention, pendingCount, enrollPendingCount, importActiveCount, adminTabAllowed\]\);/,
    'onboardingAttention is a dependency of the memo, or the badge never moves');
  // eslint-disable-next-line no-new-func
  const phrase = new Function(`${srcLF('adminBadgePhrase')}\nreturn adminBadgePhrase;`)();
  assert.equal(phrase('gettingstartedadmin', 1), 'the Getting Started video needs attention');
  assert.equal(phrase('enrollments', 2), '2 enrollment requests awaiting review', 'the others are unchanged');
  // The badge's verdict, RUN: the root's own lines, lifted.
  const root = rootSource().replace(/\r\n/g, '\n');
  const lines = statementFrom(root, '  const [onboardingAttention, setOnboardingAttention] = useState(0);',
    'useEffect(() => { refreshOnboardingHealth(); /* eslint-disable-next-line */ }, [canManageOnboarding]);');
  // eslint-disable-next-line no-new-func
  const needs = new Function('onboardingHealth',
    `${moduleConst(src, 'ONBOARDING_ATTENTION_CODES')}\n${srcLF('onboardingNeedsAttention')}\nreturn onboardingNeedsAttention;`)(onboardingHealth);
  const mount = (canManageOnboarding, answer) => {
    const rt = hookRuntime();
    const calls = [];
    const supabase = {
      rpc: (name, rpcArgs) => { calls.push({ name, rpcArgs }); return typeof answer === 'function' ? answer() : Promise.resolve(answer); },
    };
    // eslint-disable-next-line no-new-func
    const hook = new Function('useState', 'useRef', 'useCallback', 'useMemo', 'useEffect', 'supabase', 'onboardingNeedsAttention',
      'canManageOnboarding',
      `return function useOnboardingAttention() {\n${lines}\nreturn { onboardingAttention, refreshOnboardingHealth };\n};`)(
      rt.hooks.useState, rt.hooks.useRef, rt.hooks.useCallback, rt.hooks.useMemo, rt.hooks.useEffect, supabase, needs,
      canManageOnboarding);
    return { calls, render: () => rt.render(hook) };
  };
  const live = { id: V_A, status: 'published', media_present: true, problems_7d: 0, duration_seconds: 90 };
  const OK = { live_video_id: V_A, required_since: '2026-09-30T00:00:00Z', counts: {}, versions: [live] };
  const cases = [
    [{ data: { live_video_id: null, versions: [] }, error: null }, 1, 'nothing live'],
    [{ data: { ...OK, versions: [{ ...live, media_present: false }] }, error: null }, 1, 'the live file is missing'],
    [{ data: { ...OK, versions: [{ ...live, problems_7d: 2 }] }, error: null }, 1, 'playback problems'],
    [{ data: { ...OK, versions: [{ ...live, duration_seconds: null }] }, error: null }, 1, 'a length never verified'],
    [{ data: OK, error: null }, 0, 'all is well'],
    [{ data: {}, error: null }, 0, 'an answer that is not the overview is unknown — never a badge'],
    [{ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }, 0, 'a database without #69'],
    [{ data: null, error: { code: 'PT403', message: 'no', hint: 'FORBIDDEN' } }, 0, 'a refusal'],
    [() => Promise.reject(new TypeError('Failed to fetch')), 0, 'a network fault'],
  ];
  for (const [answer, want, why] of cases) {
    const m = mount(true, answer);
    m.render(); await settleAll(); await settleAll();
    assert.deepEqual(m.calls.map((c) => [c.name, c.rpcArgs]), [['admin_onboarding_video_overview', undefined]], why);
    assert.equal(m.render().onboardingAttention, want, why);
  }
  const off = mount(false, { data: { live_video_id: null }, error: null });
  off.render(); await settleAll();
  assert.deepEqual(off.calls, [], 'nothing is asked for someone who cannot open the screen');
  assert.equal(off.render().onboardingAttention, 0);
  assert.match(root, /const canManageOnboarding = adminTabAllowed\('gettingstartedadmin'\);/);
  assert.match(root, /const refreshOnboardingHealth = useCallback\(async \(\) => \{[\s\S]*?\}, \[canManageOnboarding\]\);/,
    'STABLE: TabPanel is React.memo\'d, and a new function every render would re-render every hidden panel');
  assert.match(root, /onImportCount=\{refreshImportCount\}\s*onOnboardingHealth=\{refreshOnboardingHealth\}/);
});

test('§28c routing: routed, spoken as navigation only, not counted as a tool, rendered with its health callback', () => {
  const src = appLF();
  assert.equal(extractPureLiteral(src, 'TAB_ROUTES').gettingstartedadmin, '/admin/getting-started-video');
  assert.equal(ADMIN_TAB_PERMISSION.gettingstartedadmin, 'onboarding.manage', 'Super Admin only');
  assert.deepEqual(extractPureLiteral(src, 'NON_TOOL_TAB_IDS'), ['gettingstarted', 'dashboard', 'progress', 'community',
    'gettingstartedadmin', 'accessrequests', 'enrollments', 'studentimports', 'batches', 'staffroles', 'meetings',
    'financialmanagement', 'communications', 'mockinterview'],
  'right after community — so the substrings two SQL suites pin stay intact, and the tool count does not move');
  const info = extractPureLiteral(src, 'VOICE_TAB_INFO').gettingstartedadmin;
  assert.deepEqual(Object.keys(info).sort(), ['adminOnly', 'desc', 'label', 'stage']);
  assert.deepEqual([info.label, info.stage, info.adminOnly], ['Getting Started Video', 'Admin', true]);
  assert.match(info.desc, /^Admin screen: .+ Super Admin only\.$/);
  assert.ok(!/@|₱|\d|storage|bucket|versions\//i.test(info.desc),
    'navigation only — this literal is published to the voice knowledge base');
  assert.deepEqual(extractPureLiteral(src, 'VOICE_TOOL_ALIASES')['getting started video'], { tab: 'gettingstarted' },
    'the spoken phrase stays the STUDENT tab\'s: the resolver matches aliases before labels');
  const code = jsCode(src);
  assert.match(code, /case 'gettingstartedadmin': return <GettingStartedVideoAdmin onHealthChange=\{onOnboardingHealth\} \/>;/);
  assert.match(code, /function renderToolContent\(tabId, \{ goto, onAccessCount, onEnrollCount, onImportCount, onOnboardingHealth, interviewSub \}\)/);
  assert.match(code,
    /const TabPanel = React\.memo\(function TabPanel\(\{ tabId, active, goto, onAccessCount, onEnrollCount, onImportCount, onOnboardingHealth, interviewSub \}\)/);
  assert.match(code, /\{renderToolContent\(tabId, \{ goto, onAccessCount, onEnrollCount, onImportCount, onOnboardingHealth, interviewSub \}\)\}/);
});

test('§28c Access Requests names the account and the decision — never an address — and says when the email is already on its way', () => {
  const access = srcLF('AccessRequests');
  const calls = [...jsCode(access).matchAll(/notifyAccess\(\{([^}]*)\}\)/g)];
  assert.equal(calls.length, 1, 'one decision email per decision');
  assert.deepEqual(calls[0][1].split(',').map((s) => s.trim().split(':')[0].trim()), ['userId', 'status'],
    'exactly { userId, status }: the server reads the address, the name and the reason from the profile row, with the reviewer\'s own JWT');
  assert.equal(calls[0][0], 'notifyAccess({ userId: row.id, status })');
  const at = access.indexOf('  const emailSuffix = (mail) => ');
  assert.ok(at > 0, 'emailSuffix was not found');
  // eslint-disable-next-line no-new-func
  const suffix = new Function(`${access.slice(at, access.indexOf(';\n', at) + 1)}\nreturn emailSuffix;`)();
  assert.equal(suffix({ ok: true, id: 'x' }), ' · email sent');
  assert.equal(suffix({ ok: false, skipped: 'in_flight' }), ' · email already on its way',
    'a duplicate (the provider\'s 409 on a stable key) is not a failure');
  assert.equal(suffix({ ok: false, skipped: 'email_not_configured' }), ' · email not configured');
  assert.equal(suffix({ ok: false }), ' · email not sent');
  assert.equal(suffix(undefined), ' · email not sent');
});

test('§28c the admin alert\'s link lands on its request: after a load that worked, in its filter, marked, focused — then dropped from the address', () => {
  const src = appLF();
  const REQ = 'eeeeeeee-0000-4000-8000-00000000000e';
  const lift = (search) => {
    const replaced = [];
    const window = {
      location: { search, href: `https://app.example/admin/enrollments${search}#top` },
      history: { state: { tab: 'enrollments' }, replaceState: (...a) => replaced.push(a) },
    };
    // eslint-disable-next-line no-new-func
    const f = new Function('window',
      `${moduleConst(src, 'IMPORT_JOB_RE')}\n${srcLF('readEnrollRequestParam')}\n${srcLF('dropEnrollRequestParam')}\n`
      + 'return { readEnrollRequestParam, dropEnrollRequestParam };')(window);
    return { ...f, replaced };
  };
  assert.equal(lift(`?request=${REQ}`).readEnrollRequestParam(), REQ);
  assert.equal(lift(`?request=${REQ.toUpperCase()}`).readEnrollRequestParam(), REQ, 'lowercased, as the rows\' ids are');
  for (const bad of ['', '?request=', '?request=1234', '?request=../../x', `?job=${REQ}`, `?request=${REQ}x`]) {
    assert.equal(lift(bad).readEnrollRequestParam(), null, bad);
  }
  const d = lift(`?request=${REQ}&sub=x`);
  d.dropEnrollRequestParam();
  assert.deepEqual(d.replaced, [[{ tab: 'enrollments' }, '', '/admin/enrollments?sub=x#top']],
    'replaceState(window.history.state, …): the param goes; the entry\'s state, every other param and the hash stay');
  const none = lift('?sub=x');
  none.dropEnrollRequestParam();
  assert.deepEqual(none.replaced, [], 'nothing to drop, nothing written');
  // eslint-disable-next-line no-new-func
  assert.deepEqual(new Function(`${moduleConst(src, 'ENROLL_FILTER_FOR_STATUS')}\nreturn ENROLL_FILTER_FOR_STATUS;`)(),
    { pending_review: 'pending', approved: 'approved', rejected: 'rejected', expired: 'expired' });
  // The resolve effect, RUN.
  const screen = srcLF('AdminEnrollments');
  const effect = statementFrom(screen, '  useEffect(() => {\n    if (!linkedRequest || !rowsOk) return;',
    '}, [linkedRequest, rowsOk, rows]);');
  const resolve = (linkedRequest, rowsOk, rows, cardId = null) => {
    const log = [];
    const set = (name) => (v) => log.push([name, v]);
    const frames = [];
    const focused = [];
    const card = { scrollIntoView: (o) => log.push(['scroll', o.block]), focus: (o) => focused.push(o) };
    const document = { getElementById: (id) => (id === `enroll-card-${cardId}` ? card : null) };
    const window = { matchMedia: () => ({ matches: true }) };
    // eslint-disable-next-line no-new-func
    new Function('useEffect', 'linkedRequest', 'rowsOk', 'rows', 'setLinkedRequest', 'dropEnrollRequestParam',
      'setFocusRequestId', 'setLinkMissing', 'setFilter', 'setQuery', 'setPlanFilter', 'ENROLL_FILTER_FOR_STATUS',
      'requestAnimationFrame', 'document', 'window', effect)(
      (fn) => fn(), linkedRequest, rowsOk, rows, set('linked'), () => log.push(['drop']), set('focus'), set('missing'),
      set('filter'), set('query'), set('plan'), { pending_review: 'pending', approved: 'approved', rejected: 'rejected', expired: 'expired' },
      (fn) => frames.push(fn), document, window);
    for (let i = 0; frames.length && i < 100; i += 1) frames.shift()();
    return { log, focused, framesLeft: frames.length };
  };
  const ROWS = [{ id: 'r-other', status: 'pending_review' }, { id: REQ, status: 'approved' }];
  assert.deepEqual(resolve(REQ, 0, ROWS).log, [], 'before a load has SUCCEEDED nothing is decided — least of all "not found"');
  assert.deepEqual(resolve(null, 1, ROWS).log, [], 'no link, nothing to do');
  const hit = resolve(REQ, 1, ROWS, REQ);
  assert.deepEqual(hit.log, [['linked', null], ['drop'], ['missing', false], ['filter', 'approved'], ['query', ''], ['plan', ''],
    ['focus', REQ], ['scroll', 'center']],
  'shown under the filter its status lives in, with the search and package filter that could hide it cleared, marked, scrolled to');
  assert.deepEqual(hit.focused, [{ preventScroll: true }], '…and focused');
  const late = resolve(REQ, 1, [{ id: REQ, status: 'pending_review' }], 'never');
  assert.equal(late.framesLeft, 0, 'a card that never renders is given up on, never waited for forever');
  assert.deepEqual(late.log.slice(3, 4), [['filter', 'pending']], 'a pending request is under Pending');
  const miss = resolve(REQ, 1, [{ id: 'r-other', status: 'pending_review' }]);
  assert.deepEqual(miss.log, [['linked', null], ['drop'], ['focus', null], ['missing', true]], '"not found" only after a load that worked');
  const code = jsCode(screen);
  assert.ok(code.includes('That request was not found.'));
  assert.match(code, /const \[linkedRequest, setLinkedRequest\] = useState\(\(\) => readEnrollRequestParam\(\)\);/,
    'read when the screen mounts');
  assert.match(code, /window\.addEventListener\(APP_ROUTE_CHANGE_EVENT, onRoute\);/, '…and again on a route change');
  assert.match(code, /setRows\(data\);\s*setRowsOk\(\(n\) => n \+ 1\);/, 'a load that worked counts');
  assert.equal((code.match(/setRowsOk\(0\);/g) || []).length, 2, '…and both ways a load fails reset the count');
  // The card: the mark AFTER aria-label, so §26's id/role/tabIndex/aria-label run and className stay byte-identical.
  assert.match(enrollCardRegion(),
    /id=\{`enroll-card-\$\{r\.id\}`\} role="group" tabIndex=\{-1\} aria-label=\{`Enrollment request from \$\{r\.full_name \|\| r\.email\}`\}\s*data-enroll-focus=\{focusRequestId === r\.id \? 'true' : undefined\}\s*className="glass-card p-4 enroll-card">/);
  const sheet = css();
  assert.match(sheet, /\.enroll-card\[data-enroll-focus\] \{[^}]*outline: 2px solid var\(--c-primary\);/);
  const reduce = [...sheet.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(reduce, /\.enroll-card\[data-enroll-focus\] \{ animation: none; \}/, 'reduced motion keeps the ring and drops the pulse');
});

test('§28c Preview is the student\'s own screen on that version — inert, on a watch record of its own — and the drawer\'s player steps aside for it', () => {
  const preview = jsCode(srcLF('GettingStartedPreview'));
  const bodyAt = preview.indexOf('<GettingStartedBody ');
  assert.ok(bodyAt > 0, 'the preview renders GettingStartedBody');
  const props = preview.slice(bodyAt, preview.indexOf('player=', bodyAt));
  assert.match(props, /^<GettingStartedBody headingLevel=\{2\} /, 'the dialog holds the title, so the Body steps down a level');
  assert.ok(!/onContinue=|onSignOut=/.test(props), 'no onContinue: the Go button is inert, and says it is a preview');
  assert.match(preview,
    /<GettingStartedPlayer key=\{playerKey\} mode="preview" source=\{source\} watchRef=\{watchRef\} stageRef=\{stageRef\}/);
  assert.match(preview, /\n  const watchRef = useRef\(null\);/, 'its OWN record — shared with no other player');
  assert.match(preview,
    /const source = useMemo\(\(\) => \(\{\s*video_id: version\.id, storage_path: version\.storage_path, duration_seconds: version\.duration_seconds \?\? null,\s*\}\)/,
    'a GIVEN version: the player starts nothing, records nothing, reports nothing');
  assert.match(preview, /const onVerdict = useCallback\(\(v\) => setVerdict\(\(shown\) => holdWatchVerdict\(shown, v\)\), \[\]\);/,
    'the unlock holds, as the student\'s does');
  assert.ok(!/isAdmin/.test(preview), 'the student\'s view: the player\'s own copy, never the admin diagnostics');
  const b = jsCode(srcLF('GettingStartedBody'));
  assert.match(b, /goRef = null, headingLevel = 1 \}\) \{/, 'h1 by default, so the gate renders exactly as before');
  assert.match(b, /const Heading = headingLevel === 2 \? 'h2' : 'h1';/);
  assert.match(b, /const SubHeading = headingLevel === 2 \? 'h3' : 'h2';/);
  assert.match(b, /<Heading style=/);
  assert.match(b, /<SubHeading id=\{journeyId\} className="gh-label" style=\{\{ color: C\.textSoft \}\}>The journey ahead<\/SubHeading>/);
  assert.ok(!/headingLevel/.test(jsCode(srcLF('GettingStartedScreen'))), 'the gate passes none — its heading stays the page\'s <h1>');
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin,
    /\{previewFor \? \(\s*<AccountModal [\s\S]{0,400}?maxW="max-w-3xl"[\s\S]{0,400}?>\s*<GettingStartedPreview version=\{previewFor\} \/>\s*<\/AccountModal>/,
    'a list action, in AccountModal');
  assert.match(admin,
    /\{!previewFor && drawerLesson \? \(\s*<div className="rounded-xl overflow-hidden max-w-md">\s*<SignedLessonVideo signUrl=\{signOnboardingVideo\} lesson=\{drawerLesson\} isAdmin \/>/,
    'the drawer\'s own player is UNMOUNTED while a preview is open: two signed URLs, and a hidden <video> keeps talking');
  assert.equal((admin.match(/<SignedLessonVideo /g) || []).length, 1);
  assert.equal((admin.match(/<GettingStartedPlayer /g) || []).length, 0, 'the screen\'s only Getting Started player is the preview\'s');
});

test('§28c the draft editor: a title first, counted fields, the lesson drawer\'s close rule, and patches from the pick-time closure (T7-L3)', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const create = statementFrom(admin, 'const createDraft = async (rawTitle) => {', '\n  };');
  assert.match(create, /supabase\.rpc\('admin_onboarding_video_create_draft', \{\s*p_title: title, p_description: null, p_transcript: null,\s*\}\)/,
    'all three, always');
  assert.ok(create.indexOf("'admin_onboarding_video_create_draft'") < create.indexOf('openEditor('),
    'the editor — and its uploader — open only once the draft exists: the object name needs its id');
  assert.match(jsCode(srcLF('GettingStartedTitlePrompt')), /useEffect\(\(\) => \{ inputRef\.current\?\.focus\(\); \}, \[\]\);/,
    'the prompt starts in the one field to fill in');
  assert.match(admin, /<SidePanel [\s\S]{0,700}?canClose=\{!savingDraft\} onClose=\{closeEditor\}/, 'closable except while SAVING');
  const close = statementFrom(admin, 'const closeEditor = () => {', '\n  };');
  assert.match(close, /if \(!editor \|\| savingDraft\) return;/);
  assert.match(close,
    /if \(needsCloseConfirmation\(uploadState\)\s*&& !window\.confirm\('This draft\\'s video is still uploading\.\\n\\nClose anyway\? The transfer stops, '\s*\+ 'and choosing the same file again later picks up where it left off\.'\)\) return;/,
    'the lesson drawer\'s words, for the same situation');
  assert.match(admin,
    /<LessonVideoUploader key=\{editor\.id\} value=\{uploaderValue\} savedPath=\{editor\.saved\.storage_path\}\s*onChange=\{applyUploadPatch\} onStateChange=\{setUploadState\} onPendingPath=\{notePendingPath\}\s*disabled=\{savingDraft\} target=\{uploadTarget\} onMediaFacts=\{noteMediaFacts\} \/>/);
  assert.match(admin,
    /const applyUploadPatch = useCallback\(\(patch\) => \{\s*const path = patch\?\.storage_path \?\? null;\s*readyPathRef\.current = path;\s*setDraft\(\(d\) => \(d && d\.id === editorId \? \{ \.\.\.d, storage_path: path \} : d\)\);\s*\}, \[editorId\]\);/,
    'a FUNCTIONAL update, for this draft only: the patch comes from the render that picked the file, minutes ago');
  assert.ok(!/setDraft\(\{\s*\.\.\.draft\b/.test(admin), 'no draft is ever written by spreading a captured copy');
  const raw = app();
  const at = raw.indexOf('function LessonVideoUploader(');
  const doc = raw.slice(raw.lastIndexOf('/**', at), at).replace(/\s*\r?\n\s*\*\s*/g, ' ');
  assert.match(doc, /PICKED the file[\s\S]*functional setState or through a ref/, 'the uploader\'s own doc says so (T7-L3)');
  const save = statementFrom(admin, 'const saveDraft = async () => {', '\n  };');
  assert.match(save, /if \(title !== saved\.title \|\| description !== saved\.description \|\| transcript !== saved\.transcript\) \{/,
    'the details are written when they changed…');
  assert.match(save,
    /supabase\.rpc\('admin_onboarding_video_update_details', \{\s*p_video_id: id, p_title: title, p_description: description, p_transcript: transcript,\s*\}\)/,
    '…all three, always: the RPC has no defaults, and a missing field must never read as "leave it"');
  assert.match(save,
    /if \(!title \|\| gsTextLength\(title\) > 120 \|\| gsTextLength\(description\) > 600 \|\| gsTextLength\(transcript\) > 20000\) \{/);
  for (const [key, max] of [['title', 120], ['description', 600], ['transcript', 20000]]) {
    assert.match(admin, new RegExp(`field\\('${key}', '[A-Z][a-z]+', ${max}\\b`), `${key} is counted against ${max}`);
  }
  assert.match(save, /if \(uploadState === UPLOAD_STATES\.UNSUPPORTED_FILE\) \{\s*setEditorErr\(/, 'a refused pick never saves silently');
  assert.match(save, /if \(blocksLessonSave\(uploadState\)\) \{\s*setEditorErr\(/, 'nor does a save in the middle of an upload');
});

test('§28c every change says who it affects, in one tone per action, and tells the root when it is done', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const impacts = [...admin.matchAll(/publishImpact\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(impacts.length >= 3, 'publishImpact speaks for Publish, Replace and "Who sees this"');
  for (const a of impacts) {
    // `\s*(,|$)`: the value ENDS there. `overview.required_since ?? Date.now()` would turn "never
    // published" into a cutoff of now — the one fact the first-publish dialog exists to state.
    assert.match(a, /\brequiredSince: overview\.required_since\s*(,|$)/,
      `required_since exactly as the overview returns it — null before the first publish: ${a.trim()}`);
    assert.match(a, /\bcounts: overview\.counts\s*(,|$)/, a.trim());
  }
  const dialogs = admin.slice(admin.indexOf("if (confirm.kind === 'publish') {"), admin.indexOf('  if (!allowed || loadState'));
  assert.ok(dialogs.length > 0, 'the dialogs were not found');
  const toneOf = (kind, next) => {
    const a = dialogs.indexOf(`confirm.kind === '${kind}'`);
    const b = next ? dialogs.indexOf(`confirm.kind === '${next}'`) : dialogs.length;
    return (/<GettingStartedConfirm tone="(\w+)"/.exec(dialogs.slice(a, b)) || [])[1];
  };
  assert.deepEqual([toneOf('publish', 'replace'), toneOf('replace', 'unpublish'), toneOf('unpublish', 'delete'), toneOf('delete')],
    ['ok', 'primary', 'danger', 'danger'], 'publish, replace, unpublish, delete');
  assert.match(dialogs, /<p>\{onboardingUnpublishLine\(waiting, v\.media_present === false\)\}<\/p>/,
    'unpublishing says who stops being asked — onboardingUnpublishLine, run in its own test below');
  assert.ok(dialogs.includes('who finished it keep their completion'), 'deleting says whose record stays');
  // Deleting a LIVE video: unpublished, then deleted, on ONE confirmation. If the second call fails
  // the first stands, and the screen says so rather than calling the whole thing a failure.
  const del = statementFrom(admin, 'const confirmDelete = () => runConfirm(async () => {', '\n  });');
  const un = del.indexOf("supabase.rpc('admin_onboarding_video_unpublish'");
  const dl = del.indexOf("supabase.rpc('admin_onboarding_video_delete'");
  assert.ok(un > 0 && dl > un, 'unpublished first, then deleted');
  assert.match(del, /if \(v\.status === 'published'\) \{/);
  assert.match(del, /if \(!unpublished\) throw error;/);
  assert.match(del, /was unpublished — nobody is asked to watch it — but it could not be deleted/);
  assert.match(del, /sweepOnboardingFile\(onboardingUploadTarget\(v\.id\), data\?\.storage_path, /,
    'its file goes, through the target — and never silently (AUI-4)');
  const after = statementFrom(admin, 'const afterChange = ', '\n  };');
  assert.match(after, /\breload\(\);/, 'every change reloads, and asks the root to re-read the badge\'s verdict (reload, below)');
  for (const head of ['const createDraft = async', 'const saveDraft = async', 'const confirmPublish = ', 'const confirmReplace = ',
    'const confirmUnpublish = ', 'const confirmDelete = ']) {
    const at = admin.indexOf(head);
    assert.ok(at > 0, `${head} was not found`);
    assert.ok(/afterChange\(/.test(admin.slice(at, admin.indexOf('\n  }', at))), `${head.trim()} does not tell the root when it is done`);
  }
  assert.ok(!/all students/i.test(admin), 'no dialog may say "all students": no change asks everyone');
});

test('§28c a database without #69 gets the setup card, a refusal a plain notice — never a raw error', async () => {
  const admin = srcLF('GettingStartedVideoAdmin');
  const decl = statementFrom(admin, '  const load = useCallback(async () => {', '\n  }, []);');
  const run = async (answer) => {
    const state = {};
    const set = (k) => (v) => { state[k] = typeof v === 'function' ? v(state[k]) : v; };
    // eslint-disable-next-line no-new-func
    const load = new Function('useCallback', 'loadSeqRef', 'supabase', 'isMigrationMissing', 'appErrorCode', 'setLoadState',
      'setOverview', 'setRefreshing', 'console', `${decl}\nreturn load;`)(
      (f) => f, { current: 0 },
      { rpc: async (name) => { state.rpc = name; if (answer instanceof Error) throw answer; return answer; } },
      isMigrationMissing, appErrorCode, set('loadState'), set('overview'), set('refreshing'), { warn() {} });
    await load();
    return state;
  };
  assert.equal((await run({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_onboarding_video_overview' } })).loadState,
    'setup', 'a database without #69');
  assert.equal((await run({ data: null, error: { code: 'PT403', message: 'Only a Super Admin can manage the Getting Started video.', hint: 'FORBIDDEN' } })).loadState,
    'forbidden', 'a refusal');
  assert.equal((await run({ data: null, error: { code: '57014', message: 'canceling statement' } })).loadState, 'error');
  assert.equal((await run(new TypeError('Failed to fetch'))).loadState, 'error');
  const ok = await run({ data: { live_video_id: null, versions: [] }, error: null });
  assert.deepEqual([ok.rpc, ok.loadState, ok.overview?.live_video_id, ok.refreshing], ['admin_onboarding_video_overview', 'ready', null, false]);
  const code = jsCode(admin);
  assert.ok(code.includes('Finish database setup'), 'the setup card…');
  assert.ok(code.includes('db/2026-09-30-getting-started-video.sql'), '…names the migration to run');
  assert.match(code, /if \(!allowed \|\| loadState === 'forbidden'\) \{\s*return \(/, 'a refusal is the plain no-access card');
  assert.match(code,
    /const allowed = adminTabVisible\(staff, \{\s*staffReady, staffDegraded, profileIsAdmin: !!profile\?\.is_admin,\s*\}, 'gettingstartedadmin'\);/,
    'the chokepoint\'s own question, asked again here');
});

test('§28c the screen follows its own width, and no row\'s actions share a grid track with its text', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.ok((admin.match(/<div className="gs-admin">/g) || []).length >= 3, 'every state of the screen sits in the .gs-admin container');
  assert.ok(!/grid-cols-|gridTemplateColumns/.test(admin), 'no grid is declared inline — the rows are the stylesheet\'s');
  assert.ok((admin.match(/className="[^"]*\bgs-admin__row\b[^"]*"/g) || []).length >= 3, 'the live card, a draft, a history row');
  assert.ok((admin.match(/className="gs-admin__actions"/g) || []).length >= 3, 'each row\'s actions are a row of their own');
  const sheet = css();
  assert.match(sheet, /\.gs-admin \{ container: gs-admin \/ inline-size; \}/);
  assert.match(sheet, /@container gs-admin \(min-width: \d+px\)/);
  const rows = cssRules(sheet, '.gs-admin__row');
  assert.ok(rows.length >= 1 && rows.every((r) => /display: flex; flex-direction: column;/.test(r)), 'a row stacks: text, then actions');
  const actions = cssRules(sheet, '.gs-admin__actions');
  assert.ok(actions.length >= 1 && actions.every((r) => /display: flex; flex-wrap: wrap;/.test(r)), 'the actions wrap');
  for (const sel of ['.gs-admin__top', '.gs-admin__facts', '.gs-admin__row', '.gs-admin__actions']) {
    for (const rule of cssRules(sheet, sel)) {
      const cols = /grid-template-columns:\s*([^;]+);/.exec(rule)?.[1];
      if (cols) assert.ok(!/\bauto\b(?!-fill)/.test(cols), `${sel}: no \`auto\` track beside a flexible column — got "${cols}"`);
    }
  }
});

test('§28c "Manage in Getting Started Video": for managers only, on the page and the card, as a real link', () => {
  const link = jsCode(srcLF('GettingStartedManageLink'));
  assert.match(link, /<a href=\{tabHref\('gettingstartedadmin'\)\}/, 'a real <a href> — Ctrl/middle-click opens it in a new tab');
  assert.match(link,
    /onClick=\{\(e\) => \{ if \(!goto \|\| !shouldHandleInAppClick\(e\)\) return; e\.preventDefault\(\); goto\('gettingstartedadmin'\); \}\}/);
  assert.ok(link.includes('Manage in Getting Started Video'));
  const page = jsCode(srcLF('GettingStartedPage'));
  assert.equal((page.match(/<GettingStartedManageLink goto=\{goto\} \/>/g) || []).length, 3, 'no video, the file missing, the normal page');
  assert.match(page, /plain\('There’s no Getting Started video right now\.', canManage \? <GettingStartedManageLink goto=\{goto\} \/> : null\)/);
  assert.match(page, /\{canManage\s*\? plain\('The live Getting Started video’s file is missing[^']*', <GettingStartedManageLink goto=\{goto\} \/>, 'danger'\)/);
  assert.match(page,
    /\{canManage \? \(\s*<div className="flex flex-wrap items-center gap-2"><GettingStartedManageLink goto=\{goto\} \/><\/div>\s*\) : null\}/);
  const card = jsCode(srcLF('GettingStartedCard'));
  assert.equal((card.match(/<GettingStartedManageLink goto=\{goto\} \/>/g) || []).length, 2, 'the manager\'s note and the actions row');
  assert.match(card, /\{canManage \? <GettingStartedManageLink goto=\{goto\} \/> : null\}/);
  const note = card.slice(card.indexOf('if (!video || data.media_available === false) {'),
    card.indexOf('\n  }', card.indexOf('if (!video || data.media_available === false) {')));
  assert.ok(note.indexOf('if (!canManage) return null;') > 0
    && note.indexOf('if (!canManage) return null;') < note.indexOf('<GettingStartedManageLink'), 'the note is a manager\'s alone');
  assert.ok(!/#69 Task 9/.test(app()), 'every place Task 8 marked for the link has it');
});

test('§28c every read of the list is paired with the root\'s read of the badge — so the banner and the badge never disagree', () => {
  // The badge was read when the app started; the banner, when this screen loads or is refreshed.
  // Read apart, a Refresh that finds a new verdict (a playback problem reported since sign-in, a
  // file deleted from the Storage dashboard) showed it in the banner and left the badge saying
  // the opposite. Every read here therefore goes through ONE function that asks the root too.
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /const reload = \(\) => \{\s*load\(\);\s*healthRef\.current\?\.\(\);\s*\};/, 'the pairing');
  assert.equal((admin.match(/\bload\(\);/g) || []).length, 1, 'load() is called from reload() alone — no read goes unpaired');
  // (jsCode strips the eslint comment between the call and the closing brace.)
  assert.match(admin, /useEffect\(\(\) => \{ if \(allowed\) reload\(\);\s*\}, \[allowed\]\);/,
    'the first read, when the screen opens');
  assert.match(admin, /const refresh = \(\) => \{\s*setRefreshing\(true\);\s*reload\(\);\s*\};/, 'Refresh (and the banner\'s Try again)');
  const publish = statementFrom(admin, 'const confirmPublish = () => runConfirm(async () => {', '\n  });');
  assert.match(publish, /raced: true \}\);\s*reload\(\);\s*return;/, 'and a publish that met a version gone live behind its back');
  assert.ok(!/healthRef\.current\?\.\(\);/.test(admin.replace(/const reload = \(\) => \{[\s\S]*?\};/, '')),
    'the root is asked from reload() alone');
});

test('§28c the editor counts what is SAVED — the trimmed text — and holds the limit to that same number', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const field = statementFrom(admin, 'const field = (key, label, max, rows) => {', '\n  };');
  assert.match(field, /const count = gsTextLength\(value\.trim\(\)\);\s*const over = count > max;/,
    'the server stores the trimmed text, so the counter and the limit both measure exactly that — in characters');
  assert.match(field, /\{count\.toLocaleString\('en-US'\)\} \/ \{max\.toLocaleString\('en-US'\)\}/, 'and the counter shows it');
  assert.ok(!/value\.length/.test(field),
    'never the raw length: "601 / 600" in the calm colour, for a draft that then saves, says two things at once');
});

test('§28c a refused pick does not relabel Save: the draft\'s saved video is fine, and the press says why', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /const saveBlocked = blocksLessonSave\(uploadState\);/,
    'only an unfinished upload reads "Video not ready" — the lesson drawer\'s rule for UNSUPPORTED_FILE');
  const save = statementFrom(admin, 'const saveDraft = async () => {', '\n  };');
  const refused = save.indexOf('if (uploadState === UPLOAD_STATES.UNSUPPORTED_FILE) {');
  assert.ok(refused > 0 && refused < save.indexOf('supabase.rpc('),
    'and a press refuses it out loud, before anything is written');
});

test('§28c "Who sees this", in words: the state today, singular and plural — and never "all students"', () => {
  // eslint-disable-next-line no-new-func
  const line = new Function(`${srcLF('onboardingAudienceLine')}\nreturn onboardingAudienceLine;`)();
  const DAY = 'September 30, 2026';
  const live = (pending, completed) => line({ hasLive: true, sinceDay: DAY, pending, completed, members: 9 });
  assert.match(live(0, 0), new RegExp(`^Students approved since the first publish, on ${DAY}, watch it once before their first dashboard`));
  assert.match(live(0, 0), /— nobody is waiting to finish it\. No student has finished a Getting Started video yet\./);
  assert.match(live(1, 1), /— 1 student still to finish it\. 1 student has finished a Getting Started video\./);
  assert.match(live(2, 3), /— 2 students still to finish it\. 3 students have finished a Getting Started video\./);
  assert.match(live(1234, 0), /— 1,234 students still to finish it\./);
  assert.match(live(2, 3), /Anyone approved earlier isn’t asked, but can replay it\.$/);
  const after = (pending) => line({ hasLive: false, sinceDay: DAY, pending, completed: 4, members: 9 });
  assert.match(after(0), new RegExp(`^Nothing is live, so nobody is asked to watch\\. The cutoff stays the first publish, on ${DAY}: `));
  assert.match(after(0), /no student approved since then is waiting, so publishing a video asks only students approved from now on\.$/);
  assert.match(after(1), /publishing a video asks the 1 student approved since then who hasn’t finished one\.$/);
  assert.match(after(2), /publishing a video asks the 2 students approved since then who haven’t finished one\.$/);
  const never = (members) => line({ hasLive: false, sinceDay: '', pending: 0, completed: 0, members });
  assert.match(never(1), /^Nothing has been published yet, so nobody is asked to watch\. The first publish sets the cutoff: only students approved after it are asked\. There is 1 current member today\.$/);
  assert.match(never(2), /There are 2 current members today\.$/);
  assert.match(never(0), /There are no current members yet\.$/);
  for (const s of [live(0, 0), live(1, 1), live(2, 3), after(0), after(1), after(2), never(0), never(1), never(2)]) {
    assert.ok(!/\b[01] students\b/.test(s), `a plural on one: ${s}`);
    assert.ok(!/\b1 student\b[^.]*\bhaven’t\b/.test(s), `a plural verb on one: ${s}`);
    assert.ok(!/all students/i.test(s), `no state asks everyone: ${s}`);
  }
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin,
    /const nowLine = onboardingAudienceLine\(\{ hasLive: !!live, fileMissing: liveFileMissing, sinceDay, pending, completed, members \}\);/,
    'the screen says it in these words');
});

test('§28c unpublishing says who stops being asked — singular and plural', () => {
  // eslint-disable-next-line no-new-func
  const lineOf = new Function(`${srcLF('onboardingUnpublishLine')}\nreturn onboardingUnpublishLine;`)();
  assert.equal(lineOf(0), 'Until you publish a video again, nobody is asked to watch one: newly approved students go '
    + 'straight to their dashboard. Members can’t replay it meanwhile.');
  assert.equal(lineOf(1), 'Until you publish a video again, nobody is asked to watch one: newly approved students go '
    + 'straight to their dashboard, and so does the 1 student who hasn’t finished it yet. Members can’t replay it meanwhile.');
  assert.match(lineOf(1234), /, and so do the 1,234 students who haven’t finished it yet\. /);
  for (const bad of [null, undefined, -2, NaN, 'x']) {
    assert.equal(lineOf(bad), lineOf(0), `${String(bad)} is nobody waiting, never a number it is not`);
  }
});

test('§28c the badge follows the LATEST overview — and a viewer who loses the screen loses the badge', async () => {
  const src = appLF();
  const root = rootSource().replace(/\r\n/g, '\n');
  const lines = statementFrom(root, '  const [onboardingAttention, setOnboardingAttention] = useState(0);',
    'useEffect(() => { refreshOnboardingHealth(); /* eslint-disable-next-line */ }, [canManageOnboarding]);');
  // eslint-disable-next-line no-new-func
  const needs = new Function('onboardingHealth',
    `${moduleConst(src, 'ONBOARDING_ATTENTION_CODES')}\n${srcLF('onboardingNeedsAttention')}\nreturn onboardingNeedsAttention;`)(onboardingHealth);
  const rt = hookRuntime();
  const answers = [];
  const supabase = { rpc: () => new Promise((resolve) => answers.push(resolve)) };
  // eslint-disable-next-line no-new-func
  const hook = new Function('useState', 'useRef', 'useCallback', 'useMemo', 'useEffect', 'supabase', 'onboardingNeedsAttention',
    `return function useOnboardingAttention(canManageOnboarding) {\n${lines}\nreturn { onboardingAttention, refreshOnboardingHealth };\n};`)(
    rt.hooks.useState, rt.hooks.useRef, rt.hooks.useCallback, rt.hooks.useMemo, rt.hooks.useEffect, supabase, needs);
  const NOTHING_LIVE = { data: { live_video_id: null, versions: [] }, error: null };
  const ALL_WELL = {
    data: { live_video_id: V_A, versions: [{ id: V_A, status: 'published', media_present: true, problems_7d: 0, duration_seconds: 90 }] },
    error: null,
  };
  rt.render(hook, true).refreshOnboardingHealth();   // the mount's read (answers[0]), then a change's (answers[1])
  assert.equal(answers.length, 2);
  answers[1](ALL_WELL); await settleAll();           // the NEWER answer lands first…
  answers[0](NOTHING_LIVE); await settleAll();       // …and the older one late: it must not win
  assert.equal(rt.render(hook, true).onboardingAttention, 0, 'an older answer that lands late is dropped');
  rt.render(hook, true).refreshOnboardingHealth();
  answers[2](NOTHING_LIVE); await settleAll();
  assert.equal(rt.render(hook, true).onboardingAttention, 1, 'the newest answer is the badge');
  rt.render(hook, true).refreshOnboardingHealth();    // answers[3], still in flight when…
  rt.render(hook, false);                             // …the viewer can no longer open the screen
  assert.equal(answers.length, 4, 'nothing is asked for a viewer who cannot open the screen');
  assert.equal(rt.render(hook, false).onboardingAttention, 0, 'the badge goes with the screen');
  answers[3](NOTHING_LIVE); await settleAll();
  assert.equal(rt.render(hook, false).onboardingAttention, 0, 'and an answer asked for before that is dropped');
});

// ── §28b/§28c, continued: what the Task 9 review and the Task 8 re-verification found (#69) ──
// Each test names the verified finding it pins. Every guard was mutation-tested, and the guards
// that pin behaviour already correct (T9V-L5) were proven by the mutants that survived before.

test('§28b a keep answer that LANDS supersedes every question asked before it (RV8-K1)', async () => {
  // A keep-refresh shares the newest request's number while it is in flight, so it never cancels
  // a real question. But once its answer LANDED, an older plain question still out — handleGiveUp's
  // refresh(), say — or that question's own 7 s timeout landed after it and put the older answer,
  // or 'unavailable', back: the gate failed open under a replaced video nobody had watched.
  const U1 = 'uid-1';
  const V1 = { eligible: true, required: true, video: { id: 'v1' } };
  const V2 = { eligible: true, required: true, video: { id: 'v2' } };
  const ready = async (gs) => {
    gs.render(U1, true); await settleAll();
    answer(gs.calls[0], V1); await settleAll();
    return gs.render(U1, true);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const a = mountGettingStarted(5_000);
    let v = await ready(a);
    v.refresh(); await settleAll();                      // a plain question, still out (calls[1])
    v.refresh({ keep: true }); await settleAll();        // a keep question (calls[2])
    answer(a.calls[2], V2); await settleAll();
    answer(a.calls[1], { eligible: true, required: false, video: { id: 'v1' } }); await settleAll();
    v = a.render(U1, true);
    assert.deepEqual([v.status, v.data?.required, v.data?.video?.id], ['ready', true, 'v2'],
      'the older plain answer lands late: dropped — the keep answer was the newest word');

    const b = mountGettingStarted(150);
    v = await ready(b);
    v.refresh(); await settleAll();                      // never answered: it times out
    v.refresh({ keep: true }); await settleAll();
    answer(b.calls[2], V2); await settleAll();
    await wait(400);                                     // past the plain question's own bound
    v = b.render(U1, true);
    assert.deepEqual([v.status, v.data?.required, v.data?.video?.id], ['ready', true, 'v2'],
      'its timeout lands late too: dropped, never "unavailable" — which would open the gate');

    // A keep question that FAILS supersedes nothing: the plain question still counts.
    const c = mountGettingStarted(5_000);
    v = await ready(c);
    v.refresh(); await settleAll();
    v.refresh({ keep: true }); await settleAll();
    c.calls[2].reject(new TypeError('Failed to fetch')); await settleAll();
    answer(c.calls[1], { eligible: true, required: false, video: null }); await settleAll();
    v = c.render(U1, true);
    assert.deepEqual([v.status, v.data?.required, v.data?.video], ['ready', false, null]);

    assert.match(jsCode(componentSource('useGettingStarted')),
      /if \(keep && !answer\.data\) return;\s*if \(keep\) seqRef\.current \+= 1;\s*setFetched\(/,
      'superseded only once the keep answer APPLIES — a failed keep must not drop the question still out');
  } finally {
    console.warn = warn;
  }
});

test('§28b a Retry that lands on a REPLACED video asks for its details again — on the gate and on a replay (RV8-UI-L1)', () => {
  // The player says onVerdict(null) when the video it started is not the one its record was about.
  // The NOT_FINISHED branches asked again (T8-G4); a give-up Retry that landed on the replacement
  // did not, so the gate's intro and transcript, and the tab's title and length, stayed the old one's.
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen,
    /const onVerdict = useCallback\(\(v\) => \{\s*if \(v === null\) gsRef\.current\?\.refresh\(\{ keep: true \}\);\s*setVerdict\(\(shown\) => holdWatchVerdict\(shown, v\)\);\s*\}, \[\]\);/,
    'the gate: keep — a failed read must never be what opens it');
  const m = mountReplayRecorder({ eligible: true, completed_current: false });
  m.render().onVerdict(null);
  assert.deepEqual(m.gs.refreshed, [{ keep: true }], 'the tab and the card: asked again, keeping the answer if that fails');
  assert.equal(m.render().verdict, null, 'the old verdict goes');
  assert.equal(m.sends.length, 0, 'and nothing is recorded for it');
  m.render().onVerdict({ complete: false, playedPct: 10, reason: 'watch_more', videoId: 'v2' });
  assert.deepEqual(m.gs.refreshed, [{ keep: true }], 'an ordinary verdict asks nothing');
  // null still means only "a DIFFERENT video" (the player's seed effect, §28b).
  assert.match(jsCode(componentSource('GettingStartedPlayer')),
    /if \(next === kept\) return;\s*recordRef\.current = next;\s*if \(kept\) onVerdictRef\.current\?\.\(null\);/);
});

test('§28b a message never hides an unlocked "Go to dashboard" (RV8-UI-L2)', () => {
  // The message renders ABOVE the button, so on a 1366×657 laptop "Almost there — try again in 3
  // seconds" pushed 38 of the button's 46px below the fold — and the unlock's own scroll had already
  // run, once. Measured in Chrome by the re-verification.
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.ok(body.indexOf('{notice}') > 0 && body.indexOf('{notice}') < body.indexOf('<button ref={goButtonRef}'),
    'the message sits above the button — the reason this is needed');
  const screen = jsCode(componentSource('GettingStartedScreen'));
  const effect = /useEffect\(\(\) => \{\s*if \(!message \|\| verdict\?\.complete !== true\) return;([\s\S]*?)\}, \[message\]\);/.exec(screen);
  assert.ok(effect, 'an effect keyed on the message ALONE — it runs when a message is set, never on every render while one shows');
  assert.match(effect[1], /goRef\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest', behavior: reduce \? 'auto' : 'smooth' \}\);/,
    'to the NEAREST edge: nothing moves when the button is already in view');
  assert.match(effect[1], /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/, 'no glide under reduced motion');
  assert.ok(!/\.focus\(/.test(effect[1]), 'focus stays where the student left it');
});

test('§28b/§28c a focused SURFACE draws the ring, and so do the Super Admin screen and its portaled dialogs (RV8-UI-L3, T9UI-14)', () => {
  const sheet = css().replace(/\r\n/g, '\n');
  assert.match(sheet,
    /\n\.gs-surface:focus-visible,\n\.gs-admin :focus-visible,\n\.gs-dialog :focus-visible \{ outline: 2px solid var\(--c-primary\); outline-offset: 2px; \}/,
    'the page\'s card after "Try again" and the admin\'s live card after a publish are focused THEMSELVES — '
    + '`.gs-surface :focus-visible` matches descendants only, and they drew the browser\'s default ring');
  assert.match(sheet, /\n\.gs-admin \.gh-input:focus-visible,\n\.gs-dialog \.gh-input:focus-visible \{ outline-offset: 4px; \}/,
    'an input keeps its soft halo inside the ring, as .cl-tool\'s do');
  assert.ok(sheet.indexOf('\n.gh-input:focus,') < sheet.indexOf('\n.gs-dialog :focus-visible'),
    'after .gh-input\'s own focus rule, which sets outline: none');
  // The dialogs are portaled out of .gs-admin, so their body and footer carry .gs-dialog.
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /<SidePanel [\s\S]{0,700}?bodyClass="gs-dialog px-6 py-5"/, 'the draft editor');
  assert.match(admin, /const editorFooter = \(\s*<div className="gs-dialog space-y-2">/, '…and its footer, outside its body');
  assert.match(admin, /<AccountModal title=\{`Preview: \$\{previewFor\.title\}`\}[\s\S]{0,300}?bodyClass="gs-dialog p-0"/, 'the preview');
  assert.match(jsCode(srcLF('GettingStartedTitlePrompt')), /<AccountModal [\s\S]{0,500}?bodyClass="gs-dialog px-6 py-5">/, 'the title prompt');
  assert.match(jsCode(srcLF('GettingStartedConfirm')), /<AccountModal [\s\S]{0,300}?bodyClass="gs-dialog px-6 py-5">/, 'every confirmation');
  assert.match(admin, /<section ref=\{liveRef\} tabIndex=\{-1\} aria-labelledby=\{liveTitleId\} className="gs-surface glass-card/,
    'the live card focused after a publish is a .gs-surface');
});

test('§28c a live version whose FILE IS MISSING asks nobody — and every sentence on the screen says so (T9V-H1, T9UI-1, T9V-L6, T9UI-7)', () => {
  // The danger banner said "nobody is asked to watch it and replays won't play" while "Who sees this"
  // said they "watch it once … can replay it", the Unpublish dialog said it would send the waiting
  // students to their dashboard, and the card stayed the green "Live now".
  // eslint-disable-next-line no-new-func
  const line = new Function(`${srcLF('onboardingAudienceLine')}\nreturn onboardingAudienceLine;`)();
  const DAY = 'September 30, 2026';
  const missing = (pending, completed) => line({ hasLive: true, fileMissing: true, sinceDay: DAY, pending, completed, members: 12 });
  for (const s of [missing(0, 0), missing(1, 1), missing(3, 5), missing(1234, 0)]) {
    assert.match(s, /^The live video’s file is missing, so nobody is asked to watch it and replays won’t play\. /, s);
    assert.ok(!/watch it once|can replay it|still to finish it/.test(s), `a missing file asks nobody and plays for nobody: ${s}`);
    assert.ok(!/\b[01] students\b/.test(s), `a plural on one: ${s}`);
    assert.ok(!/\b1 student\b[^.]*\bhaven’t\b/.test(s), `a plural verb on one: ${s}`);
    assert.ok(!/all students/i.test(s), s);
  }
  assert.match(missing(3, 5),
    new RegExp(`Once a working video replaces it, the 3 students approved since the first publish, on ${DAY}, who haven’t finished one will be asked\\.`));
  assert.match(missing(1, 0), /the 1 student approved since the first publish, on September 30, 2026, who hasn’t finished one will be asked\./);
  assert.match(missing(1234, 0), /the 1,234 students approved/);
  assert.match(missing(0, 0), /who haven’t finished one are asked — none are waiting now\./);
  assert.match(missing(3, 5), /5 students have finished a Getting Started video\.$/);
  assert.equal(line({ hasLive: true, fileMissing: false, sinceDay: DAY, pending: 2, completed: 3 }),
    line({ hasLive: true, sinceDay: DAY, pending: 2, completed: 3 }), 'with the file there, unchanged');
  assert.equal(line({ hasLive: false, fileMissing: true, sinceDay: DAY, pending: 2 }), line({ hasLive: false, sinceDay: DAY, pending: 2 }),
    'and a missing file without a live version is no state of its own');

  // eslint-disable-next-line no-new-func
  const unpublish = new Function(`${srcLF('onboardingUnpublishLine')}\nreturn onboardingUnpublishLine;`)();
  for (const n of [0, 1, 3]) {
    const s = unpublish(n, true);
    assert.match(s, /^Its file is missing, so nobody is asked to watch it now and replays already don’t play — unpublishing changes nothing for students\./);
    assert.ok(!/and so do|and so does/.test(s), `nobody is newly sent to their dashboard — they are going there already: ${s}`);
  }
  assert.equal(unpublish(3), unpublish(3, false), 'with the file there, unchanged');

  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /const liveFileMissing = !!live && live\.media_present === false;/,
    'only an explicit false — onboardingHealth()\'s rule: a missing fact is not a missing file');
  assert.match(admin,
    /\{liveFileMissing\s*\? <div className="gh-label" style=\{\{ color: 'var\(--status-danger-fg\)' \}\}>Live — file missing<\/div>\s*: <div className="gh-label" style=\{\{ color: 'var\(--status-ok-fg\)' \}\}>Live now<\/div>\}/,
    'never the green "Live now" over a video nobody can play');
  const del = admin.slice(admin.indexOf("} else if (confirm.kind === 'delete') {"));
  const missingArm = del.indexOf("if (v.status === 'published' && v.media_present === false) {");
  assert.ok(missingArm > 0 && missingArm < del.indexOf("} else if (v.status === 'published') {"),
    'deleting a live version with no file says it asks nobody NOW — before the ordinary live arm');
  assert.match(del.slice(missingArm, missingArm + 500), /is live, but its file is missing, so nobody is asked to watch it now\./);
  // Its Preview, aria-disabled, says why — as a draft's does.
  const pv = admin.indexOf('onClick={() => { if (hasFile(live)) setPreviewFor(live); }}');
  assert.ok(pv > 0, 'the live card\'s Preview was not found');
  assert.match(admin.slice(pv, admin.indexOf('<Eye', pv)),
    /aria-disabled=\{hasFile\(live\) \? undefined : 'true'\} aria-describedby=\{hasFile\(live\) \? undefined : liveHintId\}/);
  assert.match(admin, /<p id=\{liveHintId\}[^>]*>\s*\{liveFileMissing\s*\? 'The live video’s file is missing from storage, so it can’t be previewed\.'/);
  assert.match(admin, /const liveHintId = useId\(\);/);
});

test('§28c a change to what is live asks for the Super Admin\'s OWN answer again — their card and tab follow (T9V-M1)', () => {
  // After a publish the admin's Dashboard card still read "No Getting Started video is live", and
  // after an unpublish it offered Play on a video that was gone — until a reload, one click from here.
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /const ownAnswer = useContext\(GettingStartedContext\);/,
    'the root\'s answer, through the context: the root hook stays the one place the state is asked for');
  const after = statementFrom(admin, 'const afterChange = ', '\n  };');
  assert.match(after, /^const afterChange = \(kind, text, focus = 'top', liveChanged = false\) => \{/);
  assert.match(after, /if \(liveChanged\) ownAnswer\.refresh\?\.\(\{ keep: true \}\);/,
    'keep: a read that fails leaves the answer where it was');
  const asked = [];
  // eslint-disable-next-line no-new-func
  const make = () => new Function('setNotice', 'focusAfterLoadRef', 'reload', 'ownAnswer', `${after}\nreturn afterChange;`)(
    () => {}, { current: null }, () => {}, { refresh: (o) => asked.push(o) });
  make()('ok', 'Published.', 'live', true);
  make()('ok', 'Saved.');
  assert.deepEqual(asked, [{ keep: true }], 'once for a change to what is live; never for a draft');
  const handler = (head) => statementFrom(admin, head, '\n  });');
  assert.match(handler('const confirmPublish = () => runConfirm(async () => {'), /: `“\$\{v\.title\}” is live\.`, 'live', true\);/);
  assert.match(handler('const confirmReplace = () => runConfirm(async () => {'), /afterChange\('ok', `“\$\{v\.title\}” replaced the live video\.`, 'live', true\);/);
  assert.match(handler('const confirmUnpublish = () => runConfirm(async () => {'), /until you publish one\.`, 'top', true\);/);
  const del = handler('const confirmDelete = () => runConfirm(async () => {');
  assert.match(del, /'It is in History, where you can delete it\.', 'top', true\);/, 'unpublished, then the delete refused: still a live change');
  assert.match(del, /afterChange\('ok', `“\$\{v\.title\}” was deleted\.`, 'top', unpublished\);/, 'a deleted draft or retired version is not');
  const createAt = admin.indexOf('const createDraft = async');
  assert.ok(!/afterChange\([^;]*, (?:true|unpublished)\)/.test(admin.slice(createAt, admin.indexOf('\n  };', createAt))),
    'createDraft changes a draft');
  // Saving asks again only when the LIVE version's words changed (AUI-5) — RUN in its own test below.
  assert.match(statementFrom(admin, 'const saveDraft = async () => {', '\n  };'),
    /const words = wasLive && wroteDetails;[\s\S]*?'top', words\);/);
});

test('§28c the uploader speaks of the Getting Started video on its screen — never of lessons, course videos or their bucket (T9V-L1, T9UI-8)', () => {
  const src = appLF();
  // eslint-disable-next-line no-new-func
  const copy = new Function('formatBytes', 'LESSON_VIDEO_MAX_BYTES', `${moduleBlock(src, 'ONBOARDING_UPLOAD_COPY')}\nreturn ONBOARDING_UPLOAD_COPY;`)(
    formatBytes, LESSON_VIDEO_MAX_BYTES);
  assert.ok(copy.messages && typeof copy.messages === 'object' && Object.isFrozen(copy.messages),
    'the owner\'s refusals, frozen — a shared record');
  // DERIVED from the shared module: every refusal it words for a lesson or a course has an
  // override here, so a new lesson-worded refusal fails this test rather than reaching this screen.
  const named = /lesson|course/i;
  const big = { name: 'welcome.mp4', size: LESSON_VIDEO_MAX_BYTES + 1, type: 'video/mp4' };
  const shared = [
    validateVideoFile(null), validateVideoFile({ name: 'a.mp4', size: 0, type: 'video/mp4' }),
    validateVideoFile({ name: 'a.webm', size: 10, type: 'video/webm' }), validateVideoFile({ name: 'a.webm', size: 10, type: '' }),
    validateVideoFile(big),
  ].map((v) => [v.reason, v.message]).concat(Object.entries(UPLOAD_ERROR_MESSAGES));
  let overridden = 0;
  for (const [reason, message] of shared) {
    if (!named.test(message)) continue;
    assert.equal(typeof copy.messages[reason], 'function', `the shared "${reason}" names a lesson or a course: "${message}"`);
    overridden += 1;
  }
  assert.ok(overridden >= 6, `found ${overridden} lesson-worded refusals — the scan has stopped reading the shared module`);
  for (const [reason, say] of Object.entries(copy.messages)) {
    const text = say(big);
    assert.ok(typeof text === 'string' && text.trim().length > 0, `${reason} says something`);
    assert.ok(!named.test(text), `${reason} still names a lesson or a course: ${text}`);
  }
  assert.match(copy.messages['bucket-missing'](), /\bonboarding-videos\b.*db\/2026-09-30-getting-started-video\.sql/,
    'the missing bucket is THIS one, and so is the migration that creates it');
  // A size that cannot be mistaken for the limit (LESSON_VIDEO_MAX_BYTES + 1 formats as the limit does).
  const huge = { ...big, size: Math.round(LESSON_VIDEO_MAX_BYTES * 1.75) };
  assert.notEqual(formatBytes(huge.size), formatBytes(LESSON_VIDEO_MAX_BYTES));
  assert.ok(copy.messages['too-large'](huge).includes(formatBytes(huge.size)), 'the file\'s own size, as the shared refusal gives');
  // The uploader reads them first, and falls back to the shared wording — which a lesson keeps.
  const pick = jsCode(fnBody(uploaderBody(), 'async function handlePick('));
  assert.match(pick,
    /if \(!verdict\.ok\) \{\s*const why = copy\.messages\?\.\[verdict\.reason\]\?\.\(file\) \|\| verdict\.message;\s*setErrMsg\(why\); go\(UPLOAD_EVENTS\.VALIDATE_FAIL\); announce\(why\); return;\s*\}/);
  const transfer = jsCode(fnBody(uploaderBody(), 'async function runTransfer('));
  assert.match(transfer, /const why = copy\.messages\?\.\[d\.reason\]\?\.\(file\) \|\| d\.message;\s*setRetryable\(d\.retryable\);\s*setErrMsg\(why\);\s*go\(UPLOAD_EVENTS\.INTERRUPT\);\s*announce\(why\);/);
  assert.ok(!/setErrMsg\(verdict\.message\)|setErrMsg\(d\.message\)|announce\(d\.message\)/.test(jsCode(uploaderBody())),
    'no refusal reaches the screen in the shared wording past the owner\'s');
});

test('§28c an email whose send got NO CLEAR ANSWER is never reported as "not sent" — on Access Requests AND Enrollments (T9V-L2, EMAIL-4, TDR-5)', async () => {
  // ONE rule for both screens that announce a decision. Enrollments' notifyDecision returned { ok:false }
  // for every non-2xx without reading the body, so a send that timed out — and may well have been
  // delivered — read " · email not sent" there while Access Requests read the same answer correctly.
  assert.ok(!/accessEmailOutcomeUnclear/.test(app()), 'the rule is no longer named for one screen');
  // eslint-disable-next-line no-new-func
  const unclear = new Function(`${srcLF('emailOutcomeUnclear')}\nreturn emailOutcomeUnclear;`)();
  for (const code of ['resend_timeout', 'resend_failed', 'resend_500', 'resend_503', undefined, null, '']) {
    assert.equal(unclear(502, code), true, `502 ${String(code)}: it may have been delivered`);
  }
  assert.equal(unclear(504, undefined), true, 'the function ran out of time — perhaps after sending');
  for (const [status, code] of [[502, 'resend_422'], [502, 'resend_403'], [502, 'resend_401'], [502, 'resend_429'],
    [409, undefined], [404, undefined], [422, undefined], [429, undefined], [503, undefined], [401, undefined], [500, undefined]]) {
    assert.equal(unclear(status, code), false, `${status} ${String(code)}: a clear no`);
  }
  // notifyAccess, RUN: a failed answer's body is read, and a request that never answered is unclear.
  const access = srcLF('AccessRequests');
  const decl = statementFrom(access, '  const notifyAccess = async (payload) => {', '\n  };');
  const run = (fetchImpl) => new Function('supabase', 'fetch', 'emailOutcomeUnclear', `${decl}\nreturn notifyAccess;`)(
    { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } }, fetchImpl, unclear)({ userId: 'u', status: 'approved' });
  const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  assert.deepEqual(await run(reply(502, { ok: false, code: 'resend_timeout' })), { ok: false, unclear: true });
  assert.deepEqual(await run(reply(502, { ok: false, code: 'resend_422' })), { ok: false, unclear: false });
  assert.deepEqual(await run(reply(409, { ok: false, error: 'not the recorded decision' })), { ok: false, unclear: false });
  assert.deepEqual(await run(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('x'); } })), { ok: false, unclear: true },
    'a 502 with no readable code: the send itself threw');
  assert.deepEqual(await run(async () => { throw new TypeError('Failed to fetch'); }), { ok: false, unclear: true });
  assert.deepEqual(await run(reply(200, { ok: true, id: 'e1' })), { ok: true, id: 'e1' });
  // …and the notice says so.
  const at = access.indexOf('  const emailSuffix = (mail) => ');
  // eslint-disable-next-line no-new-func
  const suffix = new Function(`${access.slice(at, access.indexOf(';\n', at) + 1)}\nreturn emailSuffix;`)();
  assert.equal(suffix({ ok: false, unclear: true }), ' · email may not have been sent');
  assert.equal(suffix({ ok: false, unclear: false }), ' · email not sent');
  assert.equal(suffix({ ok: false, skipped: 'in_flight' }), ' · email already on its way');

  // ★ ENROLLMENTS (TDR-5): its own notifyDecision and emailSuffix, RUN through the same answers.
  const enroll = srcLF('AdminEnrollments');
  const nd = statementFrom(enroll, '  const notifyDecision = async (payload) => {', '\n  };');
  const posted = [];
  const decide = (fetchImpl) => new Function('supabase', 'fetch', 'emailOutcomeUnclear', `${nd}\nreturn notifyDecision;`)(
    { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
    async (url, init) => { posted.push([url, JSON.parse(init.body)]); return fetchImpl(); }, unclear)({ requestId: 'r', status: 'approved' });
  const sAt = enroll.indexOf('  const emailSuffix = (mail) => ');
  // eslint-disable-next-line no-new-func
  const enrollSuffix = new Function(`${enroll.slice(sAt, enroll.indexOf(';\n', sAt) + 1)}\nreturn emailSuffix;`)();
  const said = async (fetchImpl) => enrollSuffix(await decide(fetchImpl));
  assert.equal(await said(reply(502, { ok: false, code: 'resend_timeout' })), ' · email may not have been sent', 'a timeout may have been delivered');
  assert.equal(await said(reply(502, { ok: false, code: 'resend_failed' })), ' · email may not have been sent');
  assert.equal(await said(reply(502, { ok: false, code: 'resend_503' })), ' · email may not have been sent', 'a provider 5xx');
  assert.equal(await said(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('x'); } })),
    ' · email may not have been sent', 'a 502 with no readable code: the send itself threw');
  assert.equal(await said(reply(504, null)), ' · email may not have been sent', 'the function ran out of time');
  assert.equal(await said(async () => { throw new TypeError('Failed to fetch'); }), ' · email may not have been sent',
    'no answer at all: it may have reached the server, and the server may have sent it');
  for (const [status, body] of [[502, { ok: false, code: 'resend_422' }], [502, { ok: false, code: 'resend_409' }],
    [502, { ok: false, code: 'resend_429' }], [409, { ok: false }], [404, { ok: false }], [422, { ok: false }], [429, { ok: false }]]) {
    assert.equal(await said(reply(status, body)), ' · email not sent', `${status} ${body?.code || ''}: a clear no`);
  }
  assert.equal(await said(reply(200, { ok: true, id: 'e1' })), ' · email sent');
  assert.equal(await said(reply(200, { ok: false, skipped: 'in_flight' })), ' · email already on its way');
  assert.equal(await said(reply(200, { ok: false, skipped: 'email_not_configured' })), ' · email not configured');
  assert.deepEqual(await decide(reply(429, { ok: false, error: 'wait' })), { ok: false, unclear: false, rateLimited: true },
    'a 429 is the server\'s "not now" — a bulk run waits it out (EMAIL-1)');
  // ★ V-EMAIL1-RATELIMIT — and ONLY a 429 is. Any other answer is recorded exactly as it came (decisionEmail's
  //   rule): read as "not now", an unclear 502 or a 504 would stall a bulk run 20 s + 40 s on that row and ask
  //   again. A provider's own 429 arrives as a 502 (resend_429) — a refusal, not a "not now".
  for (const [status, body, unclearExpected] of [
    [502, { ok: false, code: 'resend_timeout' }, true], [502, { ok: false, code: 'resend_failed' }, true],
    [502, { ok: false, code: 'resend_503' }, true], [504, null, true],
    [502, { ok: false, code: 'resend_429' }, false], [502, { ok: false, code: 'resend_422' }, false],
    [409, { ok: false }, false], [422, { ok: false }, false], [404, { ok: false }, false],
    [503, { ok: false }, false], [500, { ok: false }, false], [401, { ok: false }, false]]) {
    assert.deepEqual(await decide(reply(status, body)), { ok: false, unclear: unclearExpected, rateLimited: false },
      `${status} ${body?.code || ''}: rateLimited is the server's 429 and nothing else`);
  }
  assert.deepEqual(posted[0], ['/api/notify-enrollment', { action: 'decision', requestId: 'r', status: 'approved' }],
    'the body still names only the request and the decision');
  // The two screens read the SAME function, the same way.
  for (const [screen, fn] of [['AccessRequests', 'notifyAccess'], ['AdminEnrollments', 'notifyDecision']]) {
    const code = jsCode(statementFrom(srcLF(screen), `  const ${fn} = async (payload) => {`, '\n  };'));
    assert.match(code, /const body = await res\.json\(\)\.catch\(\(\) => null\);/, `${fn} reads a failed answer's body`);
    assert.match(code, /unclear: emailOutcomeUnclear\(res\.status, body\?\.code\)/, `${fn} reads it by the one rule`);
    assert.match(code, /\} catch \{[\s\S]*?return \{ ok: false, unclear: true \};/, `${fn}: no answer is not a no`);
  }
});

test('§28c lengths are counted as the database counts them — characters, not UTF-16 units (T9V-L3)', () => {
  // eslint-disable-next-line no-new-func
  const len = new Function(`${srcLF('gsTextLength')}\nreturn gsTextLength;`)();
  const emoji = '😀'.repeat(61);
  assert.equal(emoji.length, 122, 'the trap: .length counts UTF-16 units');
  assert.equal(len(emoji), 61, 'char_length() counts characters — so does this');
  assert.equal(len('héllo'), 5);
  for (const none of ['', null, undefined]) assert.equal(len(none), 0);
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const blocks = [
    statementFrom(admin, 'const field = (key, label, max, rows) => {', '\n  };'),
    statementFrom(admin, 'const saveDraft = async () => {', '\n  };'),
    statementFrom(admin, 'const createDraft = async (rawTitle) => {', '\n  };'),
    jsCode(srcLF('GettingStartedTitlePrompt')),
  ];
  assert.match(blocks[2], /if \(!title \|\| gsTextLength\(title\) > 120\) \{/);
  assert.match(blocks[3], /const length = gsTextLength\(title\.trim\(\)\);/);
  for (const code of blocks) {
    assert.ok(!/\b(?:title|description|transcript|value)(?:\.trim\(\))?\.length\b/.test(code), 'no limit is held to .length');
  }
});

test('§28c a discarded upload stops being the draft\'s file — and a refusal after the details landed says they did (T9V-L4)', async () => {
  const admin = srcLF('GettingStartedVideoAdmin');
  const SAVED = buildOnboardingVideoPath(V_A, U_1);
  const N1 = buildOnboardingVideoPath(V_A, U_2);
  // notePendingPath, RUN. The uploader's ONLY null is discardPending — an accepted replacement, a
  // Cancel or a Remove (a refused pick discards nothing since the residue pass; that is pinned in
  // §19's own test). Found while a refused pick still discarded, and left the draft naming a
  // deleted object.
  const decl = jsCode(statementFrom(admin, '  const notePendingPath = useCallback((path) => {', '\n  }, []);'));
  const lift = (s) => new Function('useCallback', 'pendingPathRef', 'readyPathRef', 'mediaFactsRef', 'savedPathRef', 'setDraft',
    `${decl}\nreturn notePendingPath;`)((f) => f, s.pending, s.ready, s.facts, s.saved,
    (fn) => { s.draft = typeof fn === 'function' ? fn(s.draft) : fn; });
  const state = (draftPath, pending, ready = pending) => ({
    pending: { current: pending }, ready: { current: ready }, facts: { current: ready ? { path: ready } : null },
    saved: { current: SAVED }, draft: { id: V_A, title: 'T', storage_path: draftPath },
  });
  let s = state(N1, N1);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.pending.current, s.ready.current, s.facts.current], [SAVED, null, null, null],
    'back to the SAVED file, and the facts about the dropped one go with it');
  s = state(SAVED, N1, null);
  lift(s)(null);
  assert.equal(s.draft.storage_path, SAVED, 'an upload the draft never named (its check failed) changes nothing');
  s = state(SAVED, null);
  lift(s)(N1);
  assert.deepEqual([s.draft.storage_path, s.pending.current], [SAVED, N1], 'a new pending upload is only noted');
  s = state(null, null);
  lift(s)(null);
  assert.equal(s.draft.storage_path, null, 'nothing pending, nothing to undo');

  // saveDraft, RUN: the details are one call and the file another.
  const save = jsCode(statementFrom(admin, '  const saveDraft = async () => {', '\n  };'));
  // eslint-disable-next-line no-new-func
  const attachArgs = new Function(`${srcLF('onboardingAttachArgs')}\nreturn onboardingAttachArgs;`)();
  const MEDIA_INVALID = {
    code: 'P0001', message: 'That upload is not in storage.', hint: 'ONBOARDING_VIDEO_MEDIA_INVALID',
    details: JSON.stringify({ code: 'ONBOARDING_VIDEO_MEDIA_INVALID', context: null }),
  };
  const TEXT_INVALID = { code: 'P0001', message: 'bad', hint: 'ONBOARDING_VIDEO_TEXT_INVALID', details: JSON.stringify({ code: 'ONBOARDING_VIDEO_TEXT_INVALID' }) };
  const runSave = async (draft, answers) => {
    const st = { err: null, rpcs: [], reloads: 0 };
    // eslint-disable-next-line no-new-func
    const fn = new Function('editor', 'draft', 'saveLockRef', 'uploadState', 'UPLOAD_STATES', 'blocksLessonSave', 'gsTextLength',
      'APP_ERROR_COPY', 'setSavingDraft', 'setEditorErr', 'supabase', 'setEditor', 'onboardingAttachArgs', 'mediaFactsRef',
      'pendingPathRef', 'onboardingUploadTarget', 'resetEditor', 'afterChange', 'console', 'appErrorCode', 'appErrorMessage',
      'reload', 'sweepOnboardingFile',
      `${save}\nreturn saveDraft;`)(
      { id: V_A, saved: { title: 'Old', description: '', transcript: '', storage_path: null } }, draft, { current: false },
      UPLOAD_STATES.READY_TO_SAVE, UPLOAD_STATES, blocksLessonSave, (t) => Array.from(String(t ?? '')).length,
      APP_ERROR_COPY, () => {}, (e) => { st.err = e; },
      { rpc: async (name) => { st.rpcs.push(name); return answers[name] || { data: {}, error: null }; } },
      () => {}, attachArgs, { current: null }, { current: N1 }, () => ({ discard: async () => {} }), () => {}, () => {},
      { error() {} }, appErrorCode, appErrorMessage, () => { st.reloads += 1; }, () => {});
    await fn();
    return st;
  };
  const both = await runSave({ id: V_A, title: 'New title', description: '', transcript: '', storage_path: N1 },
    { admin_onboarding_video_attach_media: { data: null, error: MEDIA_INVALID } });
  assert.deepEqual(both.rpcs, ['admin_onboarding_video_update_details', 'admin_onboarding_video_attach_media']);
  assert.match(both.err, /^The details were saved, but the video wasn’t attached\. /, 'what was saved, and what was not');
  assert.ok(!/Nothing was changed/.test(both.err), `the attach's own "Nothing was changed" is false once the details landed: ${both.err}`);
  const fileOnly = await runSave({ id: V_A, title: 'Old', description: '', transcript: '', storage_path: N1 },
    { admin_onboarding_video_attach_media: { data: null, error: MEDIA_INVALID } });
  assert.equal(fileOnly.err, APP_ERROR_COPY.ONBOARDING_VIDEO_MEDIA_INVALID, 'details unchanged: nothing WAS changed, and it says so');
  const detailsRefused = await runSave({ id: V_A, title: 'New title', description: '', transcript: '', storage_path: N1 },
    { admin_onboarding_video_update_details: { data: null, error: TEXT_INVALID } });
  assert.deepEqual(detailsRefused.rpcs, ['admin_onboarding_video_update_details'], 'the file is not attached past a refused first step');
  assert.equal(detailsRefused.err, APP_ERROR_COPY.ONBOARDING_VIDEO_TEXT_INVALID);
  // ★ AND THE LIST BEHIND THE DRAWER IS READ AGAIN WHEN THE DETAILS LANDED (AUI-3). It kept the old
  //   title, so Cancel looked as if it had thrown the rename away too — and an editor re-opened from
  //   that stale row wrote the old title back over the new one.
  assert.deepEqual([both.reloads, fileOnly.reloads, detailsRefused.reloads], [1, 0, 0],
    'read again only when something WAS saved — a refusal that changed nothing leaves the list as it is');
});

test('§28c the guards the Task 9 mutation pass found unpinned — each pinned by what it does (T9V-L5)', async () => {
  const src = appLF();
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  // B2 — the race is answered with the Replace DIALOG: no second publish, literal or computed.
  const publish = statementFrom(admin, 'const confirmPublish = () => runConfirm(async () => {', '\n  });');
  const raced = publish.slice(publish.indexOf("if (appErrorCode(error) === 'ONBOARDING_VIDEO_REPLACE_CONFIRM') {"), publish.indexOf('throw error;'));
  assert.ok(raced.length > 40, 'the REPLACE_CONFIRM branch was not found');
  assert.ok(!/\.rpc\(|p_replace_live/.test(raced), 'nothing is called from the race\'s answer — the admin decides in the dialog');
  assert.deepEqual([...jsCode(src).matchAll(/\bp_replace_live:\s*([^,}\s]+)/g)].map((m) => m[1]).sort(), ['false', 'true'],
    'p_replace_live is written twice in the whole app, each time a literal — never a computed flag');

  // E3 — the close sweep reads the pending path BEFORE resetEditor() forgets it. RUN it.
  const close = statementFrom(admin, 'const closeEditor = () => {', '\n  };');
  const SAVED = buildOnboardingVideoPath(V_A, U_1);
  const N1 = buildOnboardingVideoPath(V_A, U_2);
  const discarded = [];
  let resets = 0;
  const pendingPathRef = { current: N1 };
  // eslint-disable-next-line no-new-func
  const sweep = new Function(`${srcLF('sweepOnboardingFile')}\nreturn sweepOnboardingFile;`)();
  // eslint-disable-next-line no-new-func
  new Function('editor', 'savingDraft', 'needsCloseConfirmation', 'uploadState', 'window', 'draftDirty', 'pendingPathRef',
    'uploadTarget', 'resetEditor', 'sweepOnboardingFile', `${close}\ncloseEditor();`)(
    { id: V_A, status: 'draft', saved: { storage_path: SAVED } }, false, () => false, UPLOAD_STATES.READY_TO_SAVE, { confirm: () => true }, false,
    pendingPathRef, { discard: async (p) => { discarded.push(p); } }, () => { pendingPathRef.current = null; resets += 1; }, sweep);
  await settleAll();
  assert.deepEqual([discarded, resets], [[N1], 1], 'the orphan is swept, THEN the editor resets');

  // J6 — Back and Forward are a popstate, which the route-change event does not cover.
  const enroll = jsCode(srcLF('AdminEnrollments'));
  assert.match(enroll, /window\.addEventListener\('popstate', onRoute\);/);
  assert.match(enroll, /window\.removeEventListener\('popstate', onRoute\);/);

  // J8 — the linked card's scroll is instant under reduced motion. RUN the effect both ways.
  const effect = statementFrom(srcLF('AdminEnrollments'), '  useEffect(() => {\n    if (!linkedRequest || !rowsOk) return;',
    '}, [linkedRequest, rowsOk, rows]);');
  const REQ = 'eeeeeeee-0000-4000-8000-00000000000e';
  const behaviour = (reduce) => {
    const seen = [];
    const frames = [];
    const card = { scrollIntoView: (o) => seen.push(o.behavior), focus: () => {} };
    // eslint-disable-next-line no-new-func
    new Function('useEffect', 'linkedRequest', 'rowsOk', 'rows', 'setLinkedRequest', 'dropEnrollRequestParam', 'setFocusRequestId',
      'setLinkMissing', 'setFilter', 'setQuery', 'setPlanFilter', 'ENROLL_FILTER_FOR_STATUS', 'requestAnimationFrame', 'document',
      'window', effect)(
      (fn) => fn(), REQ, 1, [{ id: REQ, status: 'approved' }], () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      { approved: 'approved' }, (fn) => frames.push(fn), { getElementById: () => card }, { matchMedia: () => ({ matches: reduce }) });
    while (frames.length) frames.shift()();
    return seen;
  };
  assert.deepEqual(behaviour(true), ['auto'], 'no glide under reduced motion');
  assert.deepEqual(behaviour(false), ['smooth']);

  // M5 — no button of this screen is `disabled`: a press is what starts each change, focus is on
  // that button, and a disabled button drops focus out of the dialog, to <body>.
  const code = gsAdminCode();
  const tags = [];
  for (let i = code.indexOf('<button'); i !== -1; i = code.indexOf('<button', i + 1)) {
    let depth = 0;
    let j = i;
    for (; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      else if (code[j] === '}') depth -= 1;
      else if (code[j] === '>' && depth === 0) break;
    }
    tags.push(code.slice(i, j + 1));
  }
  assert.ok(tags.length >= 15, `found ${tags.length} buttons — the scan has stopped reading the screen`);
  for (const tag of tags) {
    assert.ok(!/(?<![-\w])disabled[=\s>]/.test(tag), `a button here is \`disabled\`, not aria-disabled: ${tag.slice(0, 140)}`);
  }

  // M7 — runConfirm is a LOCK: a double press is one publish, one delete. RUN it.
  const rc = statementFrom(admin, 'const runConfirm = async (work) => {', '\n  };');
  const confirmLock = { current: false };
  // eslint-disable-next-line no-new-func
  const runConfirm = new Function('confirmLockRef', 'setConfirmBusy', 'setConfirmErr', 'console', 'appErrorCode', 'appErrorMessage',
    `${rc}\nreturn runConfirm;`)(confirmLock, () => {}, () => {}, { error() {} }, appErrorCode, appErrorMessage);
  let works = 0;
  let release = null;
  const slow = () => { works += 1; return new Promise((r) => { release = r; }); };
  const first = runConfirm(slow);
  const second = runConfirm(slow);
  assert.equal(works, 1, 'the second press while the first runs does nothing');
  release(); await first; await second;
  assert.equal(confirmLock.current, false, 'and the lock lets go');
  await runConfirm(async () => { throw new Error('refused'); });
  assert.equal(confirmLock.current, false, '…after a refusal too');

  // M6 and L3 — createDraft is a lock, and opens the editor only once the draft EXISTS. RUN it.
  const cd = statementFrom(admin, 'const createDraft = async (rawTitle) => {', '\n  };');
  const create = (rpc) => {
    const st = { calls: 0, opened: [], creating: { busy: false, err: '' } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('setCreating', 'createLockRef', 'supabase', 'openEditor', 'afterChange', 'console', 'appErrorCode',
      'appErrorMessage', 'gsTextLength', `${cd}\nreturn createDraft;`)(
      (f) => { st.creating = typeof f === 'function' ? f(st.creating) : f; }, { current: false },
      { rpc: (...a) => { st.calls += 1; return rpc(...a); } }, (v) => st.opened.push(v.id), () => {}, { error() {} },
      appErrorCode, appErrorMessage, (t) => Array.from(String(t ?? '')).length);
    return { st, fn };
  };
  let answerDraft = null;
  const dbl = create(() => new Promise((r) => { answerDraft = r; }));
  const p1 = dbl.fn('Welcome');
  const p2 = dbl.fn('Welcome');
  assert.equal(dbl.st.calls, 1, 'a double press creates ONE draft');
  answerDraft({ data: { video_id: V_A }, error: null }); await p1; await p2;
  assert.deepEqual(dbl.st.opened, [V_A], 'and opens its editor once');
  const refused = create(async () => ({ data: null, error: { code: 'PT403', message: 'no', hint: 'FORBIDDEN' } }));
  await refused.fn('Welcome');
  assert.deepEqual(refused.st.opened, [], 'a refusal opens nothing — the uploader needs the draft\'s id');
  assert.ok(refused.st.creating.err, '…and is said in the prompt');
  const noId = create(async () => ({ data: {}, error: null }));
  await noId.fn('Welcome');
  assert.deepEqual(noId.st.opened, [], 'nor does an answer without an id');
});

test('§28c Dismiss hands focus back — on the admin screen\'s notice and on the Enrollments link notice (T9UI-2)', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /<AdminNotice kind=\{notice\.kind\} onDismiss=\{\(\) => \{ setNotice\(null\); refocusIfLost\(newVideoRef\); \}\}>/,
    'to "New video", which every loaded state renders');
  assert.match(admin, /<button ref=\{newVideoRef\} type="button"/);
  const enroll = jsCode(srcLF('AdminEnrollments'));
  assert.match(enroll, /<AdminNotice kind="warn" onDismiss=\{dismissLinkMissing\}>\s*That request was not found\./);
  // RUN it, with the real refocusIfLost.
  const decl = statementFrom(enroll, 'const dismissLinkMissing = () => {', '\n  };');
  const frames = [];
  const focused = [];
  const doc = { body: {}, activeElement: null, getElementById: (id) => (id === 'enroll-list' ? { focus: () => focused.push(id) } : null) };
  doc.activeElement = doc.body;
  // eslint-disable-next-line no-new-func
  const refocus = new Function('requestAnimationFrame', 'document', `${srcLF('refocusIfLost')}\nreturn refocusIfLost;`)(
    (fn) => { frames.push(fn); return frames.length; }, doc);
  let missing = true;
  // eslint-disable-next-line no-new-func
  new Function('setLinkMissing', 'refocusIfLost', 'document', `${decl}\ndismissLinkMissing();`)((v) => { missing = v; }, refocus, doc);
  while (frames.length) frames.shift()();
  assert.equal(missing, false);
  assert.deepEqual(focused, ['enroll-list'], 'to the list the link was about — never <body>');
});

test('§28c a version title with no spaces wraps — "Who sees this", the dialogs and the notices never scroll sideways (T9UI-3)', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(admin, /<p className="mt-2" style=\{\{ fontSize: 13\.5, lineHeight: 1\.6, color: C\.text, overflowWrap: 'anywhere' \}\}>\{nowLine\}<\/p>/);
  assert.match(admin, /<p className="mt-1" style=\{\{ fontSize: 13, lineHeight: 1\.6, color: C\.textSoft, overflowWrap: 'anywhere' \}\}>\{impact\.body\}<\/p>/);
  assert.match(admin, /<p className="mt-1\.5" style=\{\{ fontSize: 13\.5, lineHeight: 1\.6, color: C\.textSoft, overflowWrap: 'anywhere' \}\}>\s*\{candidate/,
    '"Nothing is live" names the draft that is ready');
  assert.match(jsCode(srcLF('GettingStartedConfirm')), /<div style=\{\{ fontSize: 13\.5, lineHeight: 1\.6, color: C\.text, overflowWrap: 'anywhere' \}\}>/,
    'every confirmation\'s body');
  for (const shell of ['AccountModal', 'SidePanel']) {
    const code = jsCode(srcLF(shell));
    assert.match(code, /<div style=\{\{ fontFamily: fontDisplay, fontWeight: 700, fontSize: 16, color: C\.text, overflowWrap: 'anywhere' \}\}>\{title\}<\/div>/,
      `${shell}: the title wraps, rather than being clipped`);
    assert.match(code,
      /\{subtitle && <div className="mt-0\.5" style=\{\{ fontSize: 12\.5, color: C\.textSoft, lineHeight: 1\.45, overflowWrap: 'anywhere' \}\}>\{subtitle\}<\/div>\}/,
      `${shell}: and so does the subtitle`);
  }
  assert.match(jsCode(srcLF('AdminNotice')), /<div className="text-sm flex-1 min-w-0" style=\{\{ color: C\.text, overflowWrap: 'anywhere' \}\}>\{children\}<\/div>/,
    'a notice naming the version wraps inside the banner — a flex item needs min-w-0 to shrink below its longest word');
});

test('§28c the confirm buttons are SOLID fills that clear AA behind white text, in both themes (T9UI-4)', () => {
  const sheet = css();
  for (const token of ['--ok-solid', '--danger-solid']) {
    const all = [...sheet.matchAll(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`, 'g'))];
    assert.equal(all.length, 1, `${token} is defined ONCE — theme-independent, as --primary-solid is`);
    const ratio = contrastWithWhite(all[0][1]);
    assert.ok(ratio >= 4.5, `${token} (${all[0][1]}) is ${ratio.toFixed(2)}:1 against white — AA needs 4.5:1`);
  }
  const src = appLF();
  assert.match(src, /\nconst GS_OK_BTN = Object\.freeze\(\{ background: 'var\(--ok-solid\)', color: '#fff', border: '1px solid transparent' \}\);/);
  assert.match(src, /\nconst GS_DANGER_BTN = Object\.freeze\(\{ background: 'var\(--danger-solid\)', color: '#fff', border: '1px solid transparent' \}\);/);
  assert.match(jsCode(srcLF('GettingStartedConfirm')), /const action = \{ ok: GS_OK_BTN, danger: GS_DANGER_BTN \}\[tone\] \|\| GS_PRIMARY_BTN;/);
  assert.ok(!/ADMIN_BTN_/.test(gsAdminCode()), 'no gradient puts white text on a bright stop on this screen');
});

test('§28c a dialog that changes under the admin\'s focus SAYS so — through an alert that is always there (T9UI-5)', () => {
  const confirm = jsCode(srcLF('GettingStartedConfirm'));
  assert.match(confirm, /^function GettingStartedConfirm\(\{[^}]*\bwarning = ''[^}]*\}\) \{/);
  assert.match(confirm, /<div role="alert">\s*\{warning \? \(/,
    'mounted whether or not there is a warning: an alert that appears with its text is not reliably heard; one that FILLS is');
  assert.ok(confirm.indexOf('<div role="alert">') < confirm.indexOf('{children}'), 'above what it qualifies');
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const branch = admin.slice(admin.indexOf("} else if (confirm.kind === 'replace') {"), admin.indexOf("} else if (confirm.kind === 'unpublish') {"));
  assert.match(branch, /warning=\{confirm\.raced \? 'Another version went live after this page was loaded, so publishing now replaces it\.' : ''\}/);
  assert.ok(!/confirm\.raced \? \(/.test(admin), 'not a plain paragraph that merely appears');
});

test('§28c a press of Preview\'s unlocked button says it is a preview — on screen, not only to a screen reader (T9UI-6)', () => {
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.match(body, /const \[previewNoted, setPreviewNoted\] = useState\(false\);/);
  assert.match(body, /if \(inert\) \{ setPreviewNoted\(true\); say\('This is a preview, so nothing is recorded\.'\); return; \}/);
  const go = body.indexOf('<button ref={goButtonRef}');
  const note = body.indexOf('{inert && previewNoted ? (');
  assert.ok(go > 0 && note > go, 'shown beside the button that was pressed');
  assert.match(body.slice(note, note + 300), /<p [^>]*>\s*This is a preview, so nothing is recorded\.\s*<\/p>/);
  assert.match(body, /<div role="status" aria-live="polite" className="sr-only">/, 'and still announced');
});

test('§28c the uploader\'s Remove and refused-pick Dismiss hand focus to the picker — never <body> (T9UI-9)', () => {
  const body = jsCode(uploaderBody());
  assert.match(fnBody(body, 'async function removeVideo('),
    /go\(UPLOAD_EVENTS\.RESET\);\s*announce\(copy\.removed\);\s*refocusIfLost\(inputRef\);/);
  assert.match(body,
    /onClick=\{\(\) => \{ setErrMsg\(''\); fileRef\.current = null; setFileInfo\(null\); go\(UPLOAD_EVENTS\.RESET\); refocusIfLost\(inputRef\); \}\}>\s*Dismiss/);
  assert.match(body, /<input ref=\{inputRef\} type="file" accept=\{LESSON_VIDEO_ACCEPT\} className="sr-only"/,
    'the picker every RESET lands on');
  assert.equal((app().match(/\nfunction refocusIfLost\(/g) || []).length, 1, 'one hoisted helper');
});

test('§28c after Remove, the fact is said once — the drawer\'s note is plain text (T9UI-10)', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const at = admin.indexOf('This draft keeps its saved video until you upload a replacement.');
  assert.ok(at > 0, 'the drawer\'s note was not found');
  const tag = admin.slice(admin.lastIndexOf('<p', at), at);
  assert.ok(!/role=|aria-live/.test(tag), 'the uploader has already announced it; a second live region said it twice');
  assert.ok(jsCode(uploaderBody()).includes('announce(copy.removed);'), 'the one announcement');
});

test('§28c the stylesheet\'s layout arithmetic is the CSS\'s own (T9UI-11)', () => {
  const sheet = css().replace(/\r\n/g, '\n');
  const T = Number(/@container gs-admin \(min-width: (\d+)px\)/.exec(sheet)[1]);
  const fr = /@container gs-admin \(min-width: \d+px\) \{\n {2}\.gs-admin__top \{ grid-template-columns: minmax\(0, ([\d.]+)fr\) minmax\(0, ([\d.]+)fr\);/.exec(sheet);
  assert.ok(fr, 'the side-by-side tracks were not found');
  const share = Number(fr[1]) / (Number(fr[1]) + Number(fr[2]));
  const gap = Number(/\.gs-admin__top \{ display: grid; grid-template-columns: minmax\(0, 1fr\); gap: (\d+)px; \}/.exec(sheet)[1]);
  const facts = /\.gs-admin__facts \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(min\((\d+)rem, 100%\), 1fr\)\); gap: \d+px (\d+)px; \}/.exec(sheet);
  const col = Number(facts[1]) * 16;
  const colGap = Number(facts[2]);
  assert.match(jsCode(srcLF('GettingStartedVideoAdmin')), /className="gs-surface glass-card p-5 gs-admin__row"/, '20px of padding a side');
  const pad = 2 * 20;
  const card = share * (T - gap);
  const who = (1 - share) * (T - gap);
  const threeAt = Math.round((3 * col + 2 * colGap + pad) / share + gap);
  const comment = sheet.slice(sheet.indexOf('/* ── The Super Admin screen (GettingStartedVideoAdmin, #69)'), sheet.indexOf('\n.gs-admin { container:'));
  assert.ok(comment.length > 0, 'the comment was not found');
  assert.ok(comment.includes(`≈ ${Math.round(card)}px`), `at ${T}px of screen the live card is ${card.toFixed(1)}px`);
  assert.ok(comment.includes(`≈ ${Math.round(who)}px`), `…and "Who sees this" ${who.toFixed(1)}px`);
  assert.ok(comment.includes(`= ${threeAt}px of screen`), `three fact columns need ${threeAt}px of screen`);
  assert.equal(Math.floor((card - pad + colGap) / (col + colGap)), 2, 'TWO fact columns at the threshold');
  assert.ok(/\bTWO columns\b|\bfit TWO\b/.test(comment), 'and the comment says two');
  assert.ok(!comment.includes('552 + 300 + 16 = 868'), 'the old derivation forgot the 1.5fr : 1fr split');
});

test('§28c going over a limit is SAID, once — and coming back under, once (T9UI-12)', () => {
  // eslint-disable-next-line no-new-func
  const say = new Function(`${srcLF('gsLimitTransition')}\nreturn gsLimitTransition;`)();
  assert.equal(say(false, true, 'Title', 120), 'Title is over its 120-character limit.');
  assert.equal(say(true, false, 'Transcript', 20000), 'Transcript is within its 20,000-character limit again.');
  assert.equal(say(false, false, 'Title', 120), null, 'nothing while it stays under…');
  assert.equal(say(true, true, 'Title', 120), null, '…or over: a long paste is one sentence, not one per keystroke');
  const ann = jsCode(srcLF('GsLimitAnnouncer'));
  assert.match(ann, /<span role="status" aria-live="polite" className="sr-only">\{said\}<\/span>/);
  assert.match(ann, /const next = gsLimitTransition\(wasOverRef\.current, over, label, max\);\s*wasOverRef\.current = over;\s*if \(next\) setSaid\(next\);\s*\}, \[over, label, max\]\);/);
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  assert.match(statementFrom(admin, 'const field = (key, label, max, rows) => {', '\n  };'), /<GsLimitAnnouncer over=\{over\} label=\{label\} max=\{max\} \/>/);
  assert.match(jsCode(srcLF('GettingStartedTitlePrompt')), /<GsLimitAnnouncer over=\{length > 120\} label="Title" max=\{120\} \/>/);
});

// ── §18/§19/§28b, continued: the residue pass (#69) ──────────────────────────────
// What the Task 8–12 reviews carried here: the root hook was handed a pass the enrollment reads had
// not confirmed (T12-D1); the shared SignedLessonVideo's own "Try again" dropped focus to <body>; the
// no-autoplay scan missed three spellings; and a refused "Replace video" pick deleted the upload it
// was meant to replace before it had even looked at the new file. Every guard below was broken on
// purpose in a scratch copy, one at a time, and each break turned it red.

test('§28b the root hands the hook a SETTLED pass — a lapsed member\'s provisional pass spends nothing (T12-D1)', async () => {
  const root = jsCode(rootSource());
  // ONE definition of "pass", and the entitlement memo still reads it as it always did: only the
  // hook's input is settled.
  assert.equal((root.match(/const enrollPass = /g) || []).length, 1);
  assert.match(root, /const enrollPass = enroll\.state === 'pass';/);
  assert.match(root, /const base = enrollPass \? planEntitlement\(planKey\) : null;/);
  assert.match(root, /const gs = useGettingStarted\(user\?\.id, gsEnrollPhase\);/, 'the hook is handed the phase');
  const m = /const gsEnrollPhase = ([^\n]+);/.exec(root);
  assert.ok(m, 'the phase the hook is handed was not found');
  // RUN the root's OWN argument on the real hook, through what really happens to a lapsed member.
  // eslint-disable-next-line no-new-func
  const inputFor = (enroll, profileReady = true) => new Function('enroll', 'enrollPass', 'profileReady', 'gettingStartedEnrollPhase',
    `return (${m[1]});`)(enroll, enroll.state === 'pass', profileReady, gettingStartedEnrollPhase);
  const day = 86_400_000;
  const at = (days) => new Date(Date.now() + days * day).toISOString();
  const paid = { is_paid: true };
  const lapsed = { status: 'active', started_at: at(-120), ends_at: at(-60), grace_ends_at: at(-57) };
  const renewed = { status: 'active', started_at: at(0), ends_at: at(60), grace_ends_at: at(63) };
  // useEnrollmentGate's two facts: `ready` (its reads have landed — true while it is inactive) and
  // the state enrollGateState() derives from what has landed so far.
  const enroll = (ready, profile, sub) => ({ ready, state: enrollGateState({ profile, latestReq: null, sub }) });
  const U1 = 'uid-lapsed';
  const gs = mountGettingStarted();
  assert.equal(inputFor(enroll(true, null, null), false), 'unknown',
    'before the profile the enrollment gate is inactive — so "ready" — yet nothing is settled (V-GF1-DOUBLE-BOUND)');
  gs.render(U1, inputFor(enroll(true, null, null), false)); await settleAll();
  assert.equal(gs.calls.length, 1, 'asked the moment the uid exists, before the profile');
  // The profile lands — paid — and the two enrollment reads are still in flight.
  const inFlight = enroll(false, paid, null);
  assert.equal(inFlight.state, 'pass', 'what the hook used to be handed: enrollGateState() from the profile alone');
  assert.equal(inputFor(inFlight), 'unknown', 'a pass the reads have not confirmed is no pass');
  assert.equal(inputFor(enroll(true, paid, null)), 'pass');
  gs.render(U1, inputFor(inFlight)); await settleAll();
  answer(gs.calls[0], { eligible: false, required: false });          // a lapsed member is not eligible
  await settleAll();
  gs.render(U1, inputFor(inFlight)); await settleAll();
  assert.equal(gs.calls.length, 1, 'no re-ask on it — that re-ask is the one a renewal will need');
  // The reads land: the term ended.
  gs.render(U1, inputFor(enroll(true, paid, lapsed))); await settleAll();
  assert.equal(gs.calls.length, 1);
  // A renewal is approved in this same session.
  const held = gs.render(U1, inputFor(enroll(true, paid, renewed)));
  assert.equal(held.status, 'loading', 'the cached eligible:false holds the splash…');
  await settleAll();
  assert.equal(gs.calls.length, 2, '…while the one re-ask is asked');
  answer(gs.calls[1], { eligible: true, required: true });
  await settleAll();
  assert.deepEqual(gettingStartedGateInput(gs.render(U1, inputFor(enroll(true, paid, renewed)))),
    { status: 'ready', required: true }, 'Getting Started — never the dashboard it must come before');
});

test('§18/§28b SignedLessonVideo\'s own "Try again" hands focus to its frame — the one node every state shares — never <body>', () => {
  const src = app();
  const i = src.indexOf('function SignedLessonVideo');
  assert.ok(i > 0, 'SignedLessonVideo was not found');
  const body = jsCode(src.slice(i, src.indexOf('\nfunction ', i + 1)));
  assert.match(body, /const stageRef = useRef\(null\);/);
  // React keeps the root <div> across the three returns (same type, same place), so it is the only
  // element that outlives the press. EVERY return carries the ref and the tabIndex: a return without
  // the ref detaches it (null), and one without the tabIndex makes a focused frame unfocusable — the
  // browser then drops focus to <body> anyway. And nothing else: no role, no name, no handler, so a
  // lesson renders as it did.
  const frames = body.match(/<div className="course-stage"[^>]*>/g) || [];
  assert.equal(frames.length, 3, 'still exactly the three frames §18 counts');
  for (const tag of frames) assert.equal(tag, '<div className="course-stage" ref={stageRef} tabIndex={-1}>');
  assert.match(body, /onClick=\{\(\) => \{ attemptRef\.current = 0; sign\('retry'\); refocusIfLost\(stageRef\); \}\}>\s*Try again/,
    'the press that unmounts its own button hands focus back to the frame');
  assert.equal((src.match(/\nfunction refocusIfLost\(/g) || []).length, 1, 'the one hoisted helper every self-removing Retry shares');
});

test('§18/§28b the frame "Try again" focuses draws its ring INSIDE itself and ABOVE the video — every caller clips it (D2)', () => {
  // ★ Focus lands on the frame (the test above), and every caller CLIPS that frame: the learner card
  //   is `overflow-hidden`, and .gs-stage rounds and clips. So the scoped rings, drawn 2px OUTSIDE the
  //   element, showed one edge of four on a lesson and none on the gate. Pulling the outline inside
  //   with a negative offset — .lesson-doc-surface's fix — is not enough, and that was measured in
  //   Chrome, not assumed: the <video> is positioned, so it paints AFTER the frame's own outline, and
  //   it hid all four edges whenever a video was showing — the very state "Try again" exists to
  //   reach. So the frame drops its outline and an ::after paints the ring LAST, over what it holds.
  const sheet = css().replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const frame = /\n\.course-stage \{([^}]*)\}/.exec(sheet);
  assert.ok(frame, 'the .course-stage rule was not found');
  assert.match(frame[1], /position: relative;/, 'the frame is the ::after\'s containing block — without it the ring frames some ancestor');
  const own = sheet.indexOf('\n.course-stage:focus-visible { outline: none; }');
  assert.ok(own > 0, 'the frame draws no outline of its own: outside it is clipped away, inside it is under the video');
  const ring = /\n\.course-stage:focus-visible::after \{([^}]*)\}/.exec(sheet);
  assert.ok(ring && ring.index > own, 'the ring is an ::after of the focused frame, after the rule that drops the outline');
  const decl = ring[1].replace(/\s+/g, ' ');
  for (const [d, why] of [
    ["content: '';", 'without content the pseudo-element is never generated'],
    ['position: absolute;', 'positioned, so it paints after the positioned <video>, in tree order'],
    ['top: 0; right: 0; bottom: 0; left: 0;', 'exactly the frame: inside every ancestor that clips it'],
    ['border: 2px solid var(--c-primary);', 'the same 2px --c-primary ring every scoped ring draws'],
    ['pointer-events: none;', 'the video\'s own controls stay usable under it'],
  ]) assert.ok(decl.includes(d), `the ring needs ${d} — ${why}`);
  // ★ The same specificity as each scoped ring it overrides, so it must come AFTER all of them — or a
  //   scope's `outline: 2px solid; outline-offset: 2px` wins back and draws a clipped ring beside it.
  const scoped = [...sheet.matchAll(/\.[\w-]+ :focus-visible/g)];
  for (const scope of ['.course-workspace :focus-visible', '.gs-surface :focus-visible', '.gs-admin :focus-visible', '.gs-dialog :focus-visible']) {
    assert.ok(scoped.some((m) => m[0] === scope), `${scope} — a scope a frame sits in — was not found`);
  }
  for (const m of scoped) assert.ok(m.index < own, `${m[0]} comes after the frame's own ring and would override it`);
});

test('§28b the no-autoplay scan knows each listed spelling of starting playback — and none of the words a student reads', () => {
  // ★ EACH LISTED spelling, never "every spelling" (D1): this is a source scan, not a proof. A name
  //   built at run time — video['pl' + 'ay'](), String.fromCharCode(112, 108, 97, 121) — cannot be
  //   listed, and passes it; CLAUDE.md says so in as many words. A destructured `play` is not that:
  //   `const { play } = video` is an ordinary way to write it, and the residue pass's verifier walked
  //   `const { play: go2 } = HTMLMediaElement.prototype` straight through the four patterns.
  for (const spelling of ['<video autoPlay', 'video.autoplay = true;', "video.setAttribute('autoplay', '');",
    'video.setAttribute("AUTOPLAY", "")', 'video.muted = true;', 'video.defaultMuted = true;', '<video muted',
    'video.play();', 'video.play?.();', 'video .play ()', 'HTMLMediaElement.prototype.play.call(video);',
    "video['play']();", 'video["play"]?.();', 'video[`play`]();', "Reflect.get(video, 'play').call(video);",
    'const { play } = video; play.call(video);', 'const { play: go } = HTMLMediaElement.prototype; go.call(video);',
    'const { pause, play } = video;', 'const {\n    play: go,\n  } = HTMLMediaElement.prototype;',
    'function start({ play }) { play.call(video); }', 'const { play = noop } = video; play.call(video);']) {
    assert.ok(NO_AUTOPLAY_SPELLINGS.some(([re]) => re.test(spelling)), `the scan misses: ${spelling}`);
  }
  for (const harmless of ['record.ranges = mergeRanges(record.ranges, video.played);', 'playsInline',
    "'replays won’t play'", 'Watched 62% — play it to the end', 'onPlay', 'Replay', "reason: 'playing'", "'playback'",
    'const { playedPct, complete } = verdict;', '{ replay }', '{ onReplay: handleReplay }', "{open ? 'Close video' : 'Play'}",
    // GettingStartedCard's own line, an open brace above it: a pattern that let `play` follow ANY
    // text inside a brace (rather than the brace or a comma) refused this comment.
    '{\n    if (!canManage) return null;            // nothing a student could play: no card at all']) {
    assert.ok(!NO_AUTOPLAY_SPELLINGS.some(([re]) => re.test(harmless)), `the scan would refuse a harmless line: ${harmless}`);
  }
});

// ── §28b, continued: what the Task 13 final review found on the student surfaces (#69) ──────
// GF-1…GF-8 and S1…S8 of the final review, each named in its test. Every guard was broken on purpose
// in a scratch copy, one at a time, and each break turned its test red; the render half of each was
// proven in headless Chrome against the whole app (writer A1's harness).

/**
 * Timers a test fires by hand: the hook's setTimeout() records each one, and `fire(ms)` runs every pending
 * timer that was set for exactly `ms` — the 7-s fail-open, without waiting 7 s.
 */
function manualTimers() {
  const pending = [];
  return {
    setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    fire(ms) {
      const due = pending.filter((t) => t.ms === ms);
      for (const t of due) pending.splice(pending.indexOf(t), 1);
      for (const t of due) t.fn();
      return due.length;
    },
  };
}

/**
 * useEnrollmentGate (with isEnrollmentNotConfiguredErr), lifted onto the runtime: every read answers what
 * `answer(table, n, uid)` says — `uid` is the user_id the read filtered on, and the answer may be a promise.
 * `requireEnrollment` is the REQUIRE_ENROLLMENT flag it sees; `timers` (manualTimers()) replaces the real
 * setTimeout, so a test can make the 7-s timeout happen.
 */
function mountEnrollmentGate(answer, { requireEnrollment = true, timers = null } = {}) {
  const rt = hookRuntime();
  const win = new EventTarget();
  const doc = new EventTarget();
  const reads = { enrollment_requests: 0, subscriptions: 0 };
  const from = (table) => {
    let uid;
    const chain = {
      select: () => chain, eq: (col, v) => { if (col === 'user_id') uid = v; return chain; }, order: () => chain, limit: () => chain,
      maybeSingle: () => Promise.resolve().then(() => answer(table, reads[table]++, uid)),
    };
    return chain;
  };
  const channel = () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; };
  // The error classifiers the hook calls — the broad one it logs by, and the code-only one that decides
  // `migrated` (V-MIGRATED-PREDICATE) — lifted by the names in the hook's own body.
  const hookSrc = moduleFn(app(), 'useEnrollmentGate');
  const classifiers = [...new Set(hookSrc.match(/\bisEnrollment\w+Err\b/g) || [])];
  assert.ok(classifiers.includes('isEnrollmentNotConfiguredErr'), 'the hook logs by the broad test');
  const src = `${classifiers.map((n) => moduleFn(app(), n)).join('\n')}\n${hookSrc}\nreturn useEnrollmentGate;`;
  // eslint-disable-next-line no-new-func
  const hook = new Function('useState', 'useEffect', 'useCallback', 'REQUIRE_ENROLLMENT', 'supabase', 'staffBypassesPaywall',
    'enrollGateState', 'window', 'document', 'setTimeout', 'console', src)(
    rt.hooks.useState, rt.hooks.useEffect, rt.hooks.useCallback, requireEnrollment, { from, channel, removeChannel: () => {} },
    staffBypassesPaywall, enrollGateState, win, doc,
    timers ? timers.setTimeout : (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    { ...console, error: () => {}, warn: () => {} });
  return { win, doc, reads, render: (...args) => rt.render(hook, ...args) };
}

test('§28b useEnrollmentGate keeps a MIGRATED fact no transient error can flip — and the gate stays on the video (GF-2)', async () => {
  const user = { id: 'uid-1' };
  const profile = { id: 'uid-1', is_admin: false, is_paid: true, approval_status: 'approved' };
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const approved = { id: 'r1', status: 'approved', created_at: at(-1) };
  const term = { id: 's1', status: 'active', plan_key: 'vip', started_at: at(-1), ends_at: at(90), grace_ends_at: at(93) };
  // The enrollment_requests reads, in order: what the review reproduced, then a MISSING table, then a throw.
  const script = [
    { data: approved, error: null },
    { data: null, error: { code: '', message: 'Bad Gateway', details: null, hint: null, status: 502 } },
    { data: approved, error: null },
    { data: null, error: { code: 'PGRST205', message: 'Could not find the table \'public.enrollment_requests\' in the schema cache' } },
    { data: approved, error: null },
    'throw',
  ];
  const eg = mountEnrollmentGate((table, n) => {
    if (table === 'subscriptions') return { data: term, error: null };
    if (script[n] === 'throw') throw new TypeError('Failed to fetch');
    return script[n];
  });
  const gateFor = (enroll) => resolveGateScreen({
    loading: false, recovery: false, user, profileReady: true, profile, staffReady: true, staffDegraded: false,
    staff: EMPTY_STAFF_CONTEXT, enroll, requireApproval: true, requireEnrollment: true,
    gettingStarted: { status: 'ready', required: true }, gettingStartedDeferred: false,
  }).screen;
  const seen = [];
  const read = async () => {
    eg.render(user, profile, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
    const e = eg.render(user, profile, true, EMPTY_STAFF_CONTEXT);
    seen.push({ configured: e.configured, migrated: e.migrated, screen: gateFor(e) });
  };
  await read();
  for (let i = 1; i < script.length; i += 1) {
    eg.win.dispatchEvent(new Event('focus'));        // the student comes back to the tab: refresh()
    await read();
  }
  assert.equal(eg.reads.enrollment_requests, script.length, 'every focus asked again');
  assert.deepEqual(seen.map((s) => [s.configured, s.migrated]), [
    [true, true], [false, true], [true, true], [false, false], [true, true], [false, true],
  ], 'configured follows the last read, as it always has; migrated changes only on a MISSING table, and back on a good read');
  assert.deepEqual(seen.map((s) => s.screen), [
    GATE_SCREENS.GETTING_STARTED, GATE_SCREENS.GETTING_STARTED, GATE_SCREENS.GETTING_STARTED,
    GATE_SCREENS.APP, GATE_SCREENS.GETTING_STARTED, GATE_SCREENS.GETTING_STARTED,
  ], 'a 502 and a thrown fetch leave the gate on the video; only a missing enrollment table switches the arm off');
});

test('§28b `migrated` is decided by the error CODE: a schema-cache reload or a permission error that names the table never switches Getting Started off (V-MIGRATED-PREDICATE)', async () => {
  // isEnrollmentNotConfiguredErr() is a LOGGING classifier: it also matches messages that say "schema cache",
  // "relation", "does not exist", "could not find" or name enrollment_requests. Reused as `migrated`, a
  // schema-cache reload that outlasted postgrest-js's retries, or a permission error, switched the arm off
  // mid-video — and the code comment said migrated was false "only when a table is MISSING".
  const user = { id: 'uid-1' };
  const profile = { id: 'uid-1', is_admin: false, is_paid: true, approval_status: 'approved' };
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const approved = { id: 'r1', status: 'approved', created_at: at(-1) };
  const term = { id: 's1', status: 'active', plan_key: 'vip', started_at: at(-1), ends_at: at(90), grace_ends_at: at(93) };
  const gateFor = (enroll) => resolveGateScreen({
    loading: false, recovery: false, user, profileReady: true, profile, staffReady: true, staffDegraded: false,
    staff: EMPTY_STAFF_CONTEXT, enroll, requireApproval: true, requireEnrollment: true,
    gettingStarted: { status: 'ready', required: true }, gettingStartedDeferred: false,
  }).screen;
  const transient = [
    { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' },
    { code: '42501', message: 'permission denied for table enrollment_requests' },
    { code: '57014', message: 'canceling statement due to statement timeout on relation enrollment_requests' },
    { code: 'PGRST003', message: 'Timed out acquiring connection from connection pool.' },
    { code: '', message: 'relation "public.enrollment_requests" could not be read', status: 503 },
  ];
  const missing = [
    { code: 'PGRST205', message: 'Could not find the table \'public.enrollment_requests\' in the schema cache' },
    { code: '42P01', message: 'relation "public.enrollment_requests" does not exist' },
    { code: 'PGRST204', message: 'Could not find the \'intake\' column of \'enrollment_requests\' in the schema cache' },
    { code: '42703', message: 'column enrollment_requests.intake does not exist' },
  ];
  for (const [errors, migratedAfter, screenAfter, why] of [
    [transient, true, GATE_SCREENS.GETTING_STARTED, 'a read that failed, whatever its text says: the gate stays on the video'],
    [missing, false, GATE_SCREENS.APP, 'a MISSING table or column, by its code: the arm switches off'],
  ]) {
    for (const error of errors) {
      const script = [{ data: approved, error: null }, { data: null, error }, { data: approved, error: null }];
      const eg = mountEnrollmentGate((table, n) => (table === 'subscriptions' ? { data: term, error: null } : script[n]));
      const read = async () => {
        eg.render(user, profile, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
        return eg.render(user, profile, true, EMPTY_STAFF_CONTEXT);
      };
      let e = await read();
      assert.deepEqual([e.configured, e.migrated, gateFor(e)], [true, true, GATE_SCREENS.GETTING_STARTED]);
      eg.win.dispatchEvent(new Event('focus'));
      e = await read();
      assert.deepEqual([e.configured, e.migrated, gateFor(e)], [false, migratedAfter, screenAfter], `${JSON.stringify(error)}: ${why}`);
      eg.win.dispatchEvent(new Event('focus'));
      e = await read();
      assert.deepEqual([e.configured, e.migrated], [true, true], 'a good read restores both');
    }
  }
  // The broad classifier is unchanged — it still decides what is worth a console.error.
  // eslint-disable-next-line no-new-func
  const broad = new Function(`${moduleFn(app(), 'isEnrollmentNotConfiguredErr')}\nreturn isEnrollmentNotConfiguredErr;`)();
  for (const error of [...transient.slice(0, 3), ...missing]) assert.equal(broad(error), true, JSON.stringify(error));
});

test('§28b useEnrollmentGate reports only the SIGNED-IN account\'s reads — a direct switch is never judged by the previous account\'s term (K3R-GATE-DIRECT-SWITCH)', async () => {
  // ★ A DIRECT account switch — a sign-in to another account with no signed-out render between, e.g. two auth
  //   events batched into one render on a resumed tab — re-ran the read effect without clearing what it held
  //   (it must not clear on a refetch, or every focus would flash the splash), and the hook went on reporting
  //   the PREVIOUS account's request and term, READY, until the new account's reads landed. Measured in
  //   Chrome: a lapsed B was shown A's dashboard for the 2.5 s B's own reads took.
  const A = { id: 'uid-a' };
  const B = { id: 'uid-b' };
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const profA = { id: 'uid-a', is_admin: false, is_paid: true, approval_status: 'approved' };
  const profB = { id: 'uid-b', is_admin: false, is_paid: false, approval_status: 'approved' };
  const termA = { id: 's-a', status: 'active', plan_key: 'vip', started_at: at(-1), ends_at: at(90), grace_ends_at: at(93) };
  const reqA = { id: 'r-a', status: 'approved', created_at: at(-2) };
  const reqB = { id: 'r-b', status: 'pending_review', created_at: at(-1), expires_at: at(5) };
  let releaseB = null;
  const bLanded = new Promise((resolve) => { releaseB = resolve; });
  const askedFor = [];
  const eg = mountEnrollmentGate((table, n, uid) => {
    askedFor.push(`${table}:${uid}`);
    if (uid === A.id) return { data: table === 'subscriptions' ? termA : reqA, error: null };
    return bLanded.then(() => ({ data: table === 'subscriptions' ? null : reqB, error: null }));
  });
  const gateFor = (user, profile, profileReady, enroll) => resolveGateScreen({
    loading: false, recovery: false, user, profileReady, profile, staffReady: true, staffDegraded: false,
    staff: EMPTY_STAFF_CONTEXT, enroll, requireApproval: true, requireEnrollment: true,
    gettingStarted: { status: 'ready', required: false }, gettingStartedDeferred: false,
  }).screen;
  // A is signed in, and A's reads have landed.
  eg.render(A, profA, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
  let e = eg.render(A, profA, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.state, e.sub?.id, e.latestReq?.id], [true, 'pass', 's-a', 'r-a']);
  // B's session arrives with no signed-out render between: A's profile is still the one in hand.
  e = eg.render(B, profA, false, EMPTY_STAFF_CONTEXT); await settleAll();
  assert.deepEqual([e.sub, e.latestReq], [null, null], 'A\'s term and request are never reported for B');
  assert.ok(askedFor.includes('enrollment_requests:uid-b') && askedFor.includes('subscriptions:uid-b'), 'B\'s own reads are out');
  // B's profile lands; B's own reads are still out.
  for (let i = 0; i < 3; i += 1) {
    e = eg.render(B, profB, true, EMPTY_STAFF_CONTEXT); await settleAll();
    assert.deepEqual([e.active, e.ready, e.sub, e.latestReq, e.configured, e.migrated, e.state],
      [true, false, null, null, true, true, enrollGateState({ profile: profB, latestReq: null, sub: null })],
      'not ready, no term, no request, and the state of B\'s profile alone — what a fresh mount reports — until B\'s own reads land');
    assert.equal(gateFor(B, profB, true, e), GATE_SCREENS.SPLASH, 'so the gate holds its splash: B is never judged by A\'s term');
  }
  // B's reads land: B's own data flows.
  releaseB(); await settleAll(); await settleAll();
  e = eg.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.state, e.sub, e.latestReq?.id], [true, 'pending', null, 'r-b']);
  assert.equal(gateFor(B, profB, true, e), GATE_SCREENS.ENROLL_PENDING);
  // ★ The SAME account's refetch — focus, visibility, realtime: one refresh() — never takes `ready` away.
  const asked = askedFor.length;
  eg.win.dispatchEvent(new Event('focus'));
  e = eg.render(B, profB, true, EMPTY_STAFF_CONTEXT);                 // the refetch is in flight
  assert.deepEqual([e.ready, e.latestReq?.id, gateFor(B, profB, true, e)], [true, 'r-b', GATE_SCREENS.ENROLL_PENDING],
    'a refetch for the same account keeps what it has while the new reads are out: no splash');
  await settleAll(); await settleAll();
  assert.equal(askedFor.length, asked + 2, 'it did read again');
  e = eg.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.state], [true, 'pending']);
  // A sign-out forgets whose reads these were — even when the SAME account signs straight back in, it waits
  // for its own fresh reads, never the ones a sign-out already dropped.
  eg.render(null, null, true, EMPTY_STAFF_CONTEXT); await settleAll();
  e = eg.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.sub, e.latestReq, gateFor(B, profB, true, e)], [false, null, null, GATE_SCREENS.SPLASH]);
  await settleAll(); await settleAll();
  e = eg.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.state, e.latestReq?.id], [true, 'pending', 'r-b']);

  // `configured` and `migrated` are facts of the reads too: until B's land, B gets the defaults a fresh mount
  // has. And `configured` is a fact of ONE account's reads: B never gets A's failed read — not before B's reads
  // land, and not after they TIME OUT (below, K3RV-CONFIGURED-CARRYOVER). `migrated` describes the database.
  const missingTable = { code: 'PGRST205', message: 'Could not find the table \'public.enrollment_requests\' in the schema cache' };
  let releaseB2 = null;
  const b2Landed = new Promise((resolve) => { releaseB2 = resolve; });
  const eg2 = mountEnrollmentGate((table, n, uid) => {
    if (uid === A.id) return table === 'subscriptions' ? { data: termA, error: null } : { data: null, error: missingTable };
    return b2Landed.then(() => ({ data: table === 'subscriptions' ? null : reqB, error: null }));
  });
  eg2.render(A, profA, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
  e = eg2.render(A, profA, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.configured, e.migrated], [true, false, false], 'A\'s read found no enrollment table');
  eg2.render(B, profA, false, EMPTY_STAFF_CONTEXT); await settleAll();
  e = eg2.render(B, profB, true, EMPTY_STAFF_CONTEXT); await settleAll();
  assert.deepEqual([e.ready, e.configured, e.migrated], [false, true, true], 'B starts where a fresh mount starts');
  releaseB2(); await settleAll(); await settleAll();
  e = eg2.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.configured, e.migrated, e.state], [true, true, true, 'pending'], 'and then B\'s own reads decide');

  // ★ K3RV-CONFIGURED-CARRYOVER: a TIMED-OUT read is no read. The 7-s timeout leaves `configured` as it was — the
  //   fail-open, for the SAME account — and marks the reads landed, so the next account whose reads stalled was
  //   handed the previous account's failed read: one 502 for A, then B's reads hang, and an unpaid B was passed
  //   by the legacy approval gate into the app instead of the paywall a fresh mount's timeout shows (measured
  //   in Chrome, after a direct switch and after a sign-out).
  const badGateway = { code: '', message: 'Bad Gateway', details: null, hint: null, status: 502 };
  const switchCase = async (between) => {
    const timers = manualTimers();
    const eg3 = mountEnrollmentGate((table, n, uid) => {
      if (uid === A.id && n === 0) return table === 'subscriptions' ? { data: termA, error: null } : { data: null, error: badGateway };
      return new Promise(() => {});                                      // B's reads — and A's later ones — never answer
    }, { timers });
    eg3.render(A, profA, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
    let r = eg3.render(A, profA, true, EMPTY_STAFF_CONTEXT);
    assert.deepEqual([r.ready, r.configured, r.migrated], [true, false, true], `${between}: A's one read failed — a 502, not a missing table`);
    if (between === 'a sign-out') { eg3.render(null, null, true, EMPTY_STAFF_CONTEXT); await settleAll(); }
    eg3.render(B, profA, false, EMPTY_STAFF_CONTEXT); await settleAll();
    r = eg3.render(B, profB, true, EMPTY_STAFF_CONTEXT); await settleAll();
    assert.deepEqual([r.ready, r.configured], [false, true], `${between}: B's reads are out`);
    assert.ok(timers.fire(7000) >= 1, `${between}: B's run set the 7-s timeout`);
    await settleAll(); await settleAll();
    r = eg3.render(B, profB, true, EMPTY_STAFF_CONTEXT);
    assert.deepEqual([r.ready, r.configured, r.migrated, r.latestReq, r.sub], [true, true, true, null, null],
      `${between}: B's reads timed out — ready, failing open, and NEVER with A's failed read`);
    assert.equal(gateFor(B, profB, true, r), GATE_SCREENS.PAYWALL,
      `${between}: an unpaid B gets the paywall a fresh mount's timeout shows — not the legacy gate's app`);
    if (between !== 'a direct switch') return;
    // …and straight back to A while A's new reads are out: A's OLD failed read is not this run's either — the
    // reads in hand are B's, so A is reported as a fresh mount reports it, and the gate holds its splash.
    eg3.render(A, profB, false, EMPTY_STAFF_CONTEXT); await settleAll();
    r = eg3.render(A, profA, true, EMPTY_STAFF_CONTEXT); await settleAll();
    assert.deepEqual([r.ready, r.configured], [false, true], 'back to A: not ready, and not A\'s old failed read');
    assert.equal(gateFor(A, profA, true, r), GATE_SCREENS.SPLASH, 'so the gate holds its splash — never the legacy gate\'s app');
  };
  await switchCase('a direct switch');
  await switchCase('a sign-out');

  // The SAME account's timeout still leaves its own last answer standing — the fail-open it was written for.
  const timers = manualTimers();
  const answers = [{ data: null, error: badGateway }, 'hang', { data: reqB, error: null }, 'hang'];
  const eg4 = mountEnrollmentGate((table, n) => {
    if (table === 'subscriptions') return answers[n] === 'hang' ? new Promise(() => {}) : { data: null, error: null };
    return answers[n] === 'hang' ? new Promise(() => {}) : answers[n];
  }, { timers });
  const readB = async ({ refetch = false, timeout = false } = {}) => {
    if (refetch) eg4.win.dispatchEvent(new Event('focus'));
    eg4.render(B, profB, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
    if (timeout) { assert.ok(timers.fire(7000) >= 1); await settleAll(); await settleAll(); }
    return eg4.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  };
  e = await readB();
  assert.deepEqual([e.ready, e.configured], [true, false], 'B\'s own read failed: configured false, the arm\'s fail-open');
  e = await readB({ refetch: true, timeout: true });
  assert.deepEqual([e.ready, e.configured], [true, false], 'B\'s own refetch timed out: B\'s last answer stands — unchanged, not reset');
  e = await readB({ refetch: true });
  assert.deepEqual([e.ready, e.configured, e.latestReq?.id], [true, true, 'r-b'], 'a good read: configured again');
  e = await readB({ refetch: true, timeout: true });
  assert.deepEqual([e.ready, e.configured], [true, true], 'and a timeout after it changes nothing either');
  // A sign-out forgets it, as it forgets the reads: the SAME account signing back in whose reads then time
  // out is where a fresh mount's timeout is.
  const timers5 = manualTimers();
  const eg5 = mountEnrollmentGate((table, n) => (n === 0 ? (table === 'subscriptions' ? { data: null, error: null } : { data: null, error: badGateway }) : new Promise(() => {})), { timers: timers5 });
  eg5.render(B, profB, true, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
  assert.equal(eg5.render(B, profB, true, EMPTY_STAFF_CONTEXT).configured, false);
  eg5.render(null, null, true, EMPTY_STAFF_CONTEXT); await settleAll();
  eg5.render(B, profB, true, EMPTY_STAFF_CONTEXT); await settleAll();
  assert.ok(timers5.fire(7000) >= 1); await settleAll(); await settleAll();
  e = eg5.render(B, profB, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.configured], [true, true], 'signed out and in again, its reads timed out: the default, not the read a sign-out dropped');
});

test('§28b useEnrollmentGate is READY while it is inactive, and a first load that throws or times out ends ready for that account (K3RV-HOOK-SETTLE-UNPINNED)', async () => {
  // ★ Two properties the hook must keep and nothing pinned — `ready: loaded`, and a loadedFor set only after a
  //   SUCCESSFUL read, both survived the whole suite:
  //   (1) `ready` is true while the hook is INACTIVE — staff, a Super Admin, VITE_REQUIRE_ENROLLMENT=false, a
  //       profile still loading. AccountSettingsPanel's enrollReady, the community bell and gsEnrollPhase read
  //       it, and with the flag off the read effect never marks anything loaded: `ready: loaded` held them false
  //       for ever.
  //   (2) a FIRST load that throws, or times out, still ends ready for that uid — the 7-s fail-open that keeps a
  //       stalled read from trapping a student on the splash.
  const user = { id: 'uid-1' };
  const student = { id: 'uid-1', is_admin: false, is_paid: false, approval_status: 'approved' };
  const never = () => new Promise(() => {});
  // (1) Inactive: ready before any read has landed — or with no read at all.
  let eg = mountEnrollmentGate(never, { requireEnrollment: false });
  eg.render(user, student, true, EMPTY_STAFF_CONTEXT); await settleAll();
  let e = eg.render(user, student, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.active, e.ready], [false, true], 'VITE_REQUIRE_ENROLLMENT=false: ready');
  assert.equal(eg.reads.enrollment_requests + eg.reads.subscriptions, 0, 'and nothing was read');
  const opsAdmin = { ...EMPTY_STAFF_CONTEXT, isStaff: true, roleKey: 'operations_admin', status: 'active' };
  for (const [profile, profileReady, staff, who] of [
    [{ ...student, is_admin: true }, true, EMPTY_STAFF_CONTEXT, 'a Super Admin (is_admin)'],
    [student, true, opsAdmin, 'active staff'],
    [null, false, EMPTY_STAFF_CONTEXT, 'a profile still loading'],
  ]) {
    eg = mountEnrollmentGate(never);
    eg.render(user, profile, profileReady, staff); await settleAll();
    e = eg.render(user, profile, profileReady, staff);
    assert.deepEqual([e.active, e.ready], [false, true], `${who}: inactive, so ready — while its reads are still out`);
  }
  // (2) A first load whose reads THROW: the catch path ends ready, failing open.
  eg = mountEnrollmentGate(() => { throw new TypeError('Failed to fetch'); });
  assert.equal(eg.render(user, student, true, EMPTY_STAFF_CONTEXT).ready, false, 'the reads are out');
  await settleAll(); await settleAll();
  e = eg.render(user, student, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.configured, e.latestReq, e.sub], [true, false, null, null], 'a thrown first load ends ready');
  // (2) A first load that STALLS: the 7-s timeout ends it ready, never a splash for ever.
  const timers = manualTimers();
  eg = mountEnrollmentGate(never, { timers });
  eg.render(user, student, true, EMPTY_STAFF_CONTEXT); await settleAll();
  assert.equal(eg.render(user, student, true, EMPTY_STAFF_CONTEXT).ready, false, 'the reads are out');
  assert.equal(timers.fire(7000), 1, 'the one 7-s timeout');
  await settleAll(); await settleAll();
  e = eg.render(user, student, true, EMPTY_STAFF_CONTEXT);
  assert.deepEqual([e.ready, e.configured, e.latestReq, e.sub, e.state], [true, true, null, null, 'paywall'],
    'a stalled first load ends ready at the timeout: an unpaid student meets the paywall');
});

test('§28b a DIRECT account switch spends nothing of the new account\'s: approved or renewed later that session, it is shown Getting Started (K3R-GATE-DIRECT-SWITCH)', async () => {
  // The checker's two doors, RUN on the real useEnrollmentGate, the root's own phase line and the real
  // useGettingStarted. Door 1: before B's profile lands, A's profile (paid) was read as B's pass, so B's first
  // question went out stamped reaskedAfterPass. Door 2: after B's profile lands, A's term — still in hand —
  // plus B's is_paid made a pass while B's own reads were out, which spent the one re-ask. Either way an
  // approval (or a renewal) later in the same session found no re-ask left, and B reached the dashboard
  // without the video. Measured in Chrome: reporting only the signed-in account's reads closed door 2 alone;
  // a pass that also needs the profile closed door 1.
  const root = jsCode(rootSource());
  const m = /const gsEnrollPhase = ([^\n]+);/.exec(root);
  assert.ok(m, 'the phase the hook is handed was not found');
  // eslint-disable-next-line no-new-func
  const phaseFor = (enroll, profileReady) => new Function('enroll', 'enrollPass', 'profileReady', 'gettingStartedEnrollPhase',
    `return (${m[1]});`)(enroll, enroll.state === 'pass', profileReady, gettingStartedEnrollPhase);
  const A = { id: 'uid-a' };
  const B = { id: 'uid-b' };
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const term = (id, from, to) => ({ id, status: 'active', plan_key: 'vip', started_at: at(from), ends_at: at(to), grace_ends_at: at(to + 3) });
  const profA = { id: 'uid-a', is_admin: false, is_paid: true, approval_status: 'approved' };
  for (const variant of ['pending', 'lapsed']) {
    const profB = { id: 'uid-b', is_admin: false, is_paid: variant === 'lapsed', approval_status: 'approved' };
    const db = {
      [A.id]: { req: { id: 'r-a', status: 'approved', created_at: at(-2) }, sub: term('s-a', -1, 90) },
      [B.id]: variant === 'pending'
        ? { req: { id: 'r-b', status: 'pending_review', created_at: at(-1), expires_at: at(5) }, sub: null }
        : { req: { id: 'r-b', status: 'approved', created_at: at(-200) }, sub: term('s-b', -190, -10) },
    };
    let hold = null;                                                    // while set, B's reads wait for it
    const read = (table, uid) => ({ data: table === 'subscriptions' ? db[uid].sub : db[uid].req, error: null });
    const eg = mountEnrollmentGate((table, n, uid) => (uid === B.id && hold ? hold.then(() => read(table, uid)) : read(table, uid)));
    const gs = mountGettingStarted();
    const step = async (user, profile, profileReady) => {
      eg.render(user, profile, profileReady, EMPTY_STAFF_CONTEXT); await settleAll(); await settleAll();
      const enroll = eg.render(user, profile, profileReady, EMPTY_STAFF_CONTEXT);
      const phase = phaseFor(enroll, profileReady);
      gs.render(user.id, phase); await settleAll();
      const v = gs.render(user.id, phase);
      const screen = resolveGateScreen({
        loading: false, recovery: false, user, profileReady, profile, staffReady: true, staffDegraded: false,
        staff: EMPTY_STAFF_CONTEXT, enroll, requireApproval: true, requireEnrollment: true,
        gettingStarted: gettingStartedGateInput(v), gettingStartedDeferred: false,
      }).screen;
      return { phase, screen };
    };
    // A's app is running.
    await step(A, profA, true);
    answer(gs.calls[0], { eligible: true, required: false, completed: true, completed_current: true });
    let s = await step(A, profA, true);
    assert.deepEqual([s.phase, s.screen], ['pass', GATE_SCREENS.APP], variant);
    // DIRECT switch: B's session, A's profile still in hand, B's reads held.
    let release = null;
    hold = new Promise((resolve) => { release = resolve; });
    s = await step(B, profA, false);
    assert.equal(s.phase, 'unknown', `${variant}: before B's profile lands nothing is settled — never A's pass (door 1)`);
    assert.equal(gs.calls.length, 2, 'B is asked for itself');
    answer(gs.calls[1], { eligible: false, required: false, completed: false, completed_current: false });
    // B's profile lands; B's reads are still out.
    for (let i = 0; i < 3; i += 1) {
      s = await step(B, profB, true);
      assert.deepEqual([s.phase, s.screen], ['unknown', GATE_SCREENS.SPLASH],
        `${variant}: B's own reads are out — A's term is not B's, so no pass and no re-ask (door 2)`);
    }
    assert.equal(gs.calls.length, 2, `${variant}: nothing spent`);
    // B's reads land: a hold.
    release(); hold = null;
    s = await step(B, profB, true);
    assert.deepEqual([s.phase, s.screen],
      ['hold', variant === 'pending' ? GATE_SCREENS.ENROLL_PENDING : GATE_SCREENS.MEMBERSHIP_EXPIRED], variant);
    assert.equal(gs.calls.length, 2);
    // Approved (or renewed) in the same session.
    db[B.id] = { req: { id: 'r-b', status: 'approved', created_at: at(-1) }, sub: term('s-b2', 0, 60) };
    const paidB = { ...profB, is_paid: true };
    eg.win.dispatchEvent(new Event('focus'));
    s = await step(B, paidB, true);
    assert.deepEqual([s.phase, s.screen], ['pass', GATE_SCREENS.SPLASH], `${variant}: the cached eligible:false holds the splash…`);
    assert.equal(gs.calls.length, 3, `${variant}: …while the one re-ask B still has is asked`);
    answer(gs.calls[2], { eligible: true, required: true, completed: false, completed_current: false });
    s = await step(B, paidB, true);
    assert.equal(s.screen, GATE_SCREENS.GETTING_STARTED, `${variant}: Getting Started — never the dashboard it comes before`);
  }
});

test('§28b the root latches a MEMBER\'s running app: a settled pass sets it, a hold ends it, and Getting Started never takes it over (GF-2, V-GF2-LATCH)', () => {
  const root = jsCode(rootSource()).replace(/\r\n/g, '\n');
  assert.match(root, /const \[gsShellUid, setGsShellUid\] = useState\(null\);\n  const gsShellShown = !!user\?\.id && gsShellUid === user\.id;/,
    'per account and per session: the uid whose app is running, compared on every render');
  assert.match(root, /useEffect\(\(\) => \{ if \(!user\?\.id\) \{ setGsDeferredUid\(null\); setGsShellUid\(null\); setGsGateUid\(null\); \} \}, \[user\?\.id\]\);/,
    'a sign-out forgets the latch with the deferral: the same student signing in again is asked again');
  const decide = root.indexOf('const gate = resolveGateScreen({');
  const call = root.slice(decide, root.indexOf('});', decide));
  assert.match(call, /\bappShellShown: gsShellShown,/, 'the gate is told');
  assert.match(root, /\{showWelcome && !gsWelcomeHeld && <WelcomeOverlay /, 'the first-login welcome is held after a finished video (V-GF4-WELCOME)');

  // RUN the root's own lines around resolveGateScreen(): the deferral block (with the latch and the gate's own
  // state), the phase the hook is handed, and the latch effect with the welcome lines after it — cut from the
  // source as written (jsCode() would drop the comments that mark where the blocks end).
  const raw = rootSource().replace(/\r\n/g, '\n');
  const from = raw.indexOf('  const [gsDeferredUid, setGsDeferredUid] = useState(null);');
  const to = raw.indexOf('  // #49: the invitation token', from);
  assert.ok(from > 0 && to > from, 'the deferral block was not found');
  const phaseLine = /\n {2}const gsEnrollPhase = [^\n]+;/.exec(raw);
  assert.ok(phaseLine, 'the phase the hook is handed was not found');
  const rawDecide = raw.indexOf('const gate = resolveGateScreen({');
  const latchAt = raw.indexOf('  useEffect(() => {\n    if (!user?.id) return;\n    if (gate.screen === GATE_SCREENS.APP) {', rawDecide);
  const latchEnd = raw.indexOf('  switch (gate.screen) {', latchAt);
  assert.ok(rawDecide > 0 && latchAt > rawDecide && latchEnd > latchAt,
    'the latch is set from the gate\'s own verdict — after it is decided, above the first early return');
  const latchBlock = raw.slice(latchAt, latchEnd);
  assert.match(latchBlock, /\n {2}\}, \[gate\.screen, user\?\.id, gsEnrollPhase\]\);\n/,
    'an effect, never mid-render: it reads the verdict AND the phase it came with');
  // K3R-FOCUS-HANDOVER: the hand-over effect sits in the same block, after the welcome lines. It hands
  // refocusIfLost() a TRANSIENT target — <main> takes tabindex only for that focus (K3RV-MAIN-CLICK-FOCUS).
  assert.match(latchBlock,
    /const gsLastScreenRef = useRef\(null\);\n {2}useEffect\(\(\) => \{\n {4}if \(gate\.screen === GATE_SCREENS\.SPLASH\) return;\n {4}const prev = gsLastScreenRef\.current;\n {4}gsLastScreenRef\.current = gate\.screen;\n {4}if \(prev === GATE_SCREENS\.GETTING_STARTED && gate\.screen === GATE_SCREENS\.APP\) refocusIfLost\(transientFocusTarget\(mainRef\), \{ preventScroll: true \}\);\n {2}\}, \[gate\.screen\]\);/,
    'the gate hands focus to <main> on its hand-over — an effect on the verdict, above the first early return');
  const rt0 = () => hookRuntime();
  const MAIN_REF = Object.freeze({ current: 'the <main> element' });
  // What transientFocusTarget(ref) is recorded as here; the helper itself is RUN by the next test.
  const TRANSIENT = (ref) => ({ transient: ref });
  // eslint-disable-next-line no-new-func
  const build = new Function('GATE_SCREENS', 'resolveGateScreen', 'gettingStartedEnrollPhase', 'gettingStartedGateInput',
    'EMPTY_STAFF_CONTEXT', 'useState', 'useRef', 'useCallback', 'useMemo', 'useEffect', 'refocusIfLost', 'transientFocusTarget', 'mainRef',
    `return function useRoot({ user, profile, enroll, gs, profileReady = true, showWelcome = false, dismissWelcome = () => {} }) {
${raw.slice(from, to)}
const enrollPass = enroll.state === 'pass';
${phaseLine[0]}
const gate = resolveGateScreen({
  loading: false, recovery: false, user, profileReady, profile, staffReady: true, staffDegraded: false,
  staff: EMPTY_STAFF_CONTEXT, enroll, requireApproval: true, requireEnrollment: true,
  gettingStarted: gettingStartedGateInput(gs), gettingStartedDeferred: gsDeferred, appShellShown: gsShellShown,
});
${latchBlock}
return { screen: gate.screen, latched: gsShellShown, welcomeHeld: gsWelcomeHeld };
};`);
  /**
   * A fresh root. React re-renders after an effect sets state, so every step renders twice and reads the second.
   * `step.handovers` lists every refocusIfLost() the root asked for, as [ref, options].
   */
  const mount = () => {
    const rt = rt0();
    const handovers = [];
    const useRoot = build(GATE_SCREENS, resolveGateScreen, gettingStartedEnrollPhase, gettingStartedGateInput,
      EMPTY_STAFF_CONTEXT, rt.hooks.useState, rt.hooks.useRef, rt.hooks.useCallback, rt.hooks.useMemo, rt.hooks.useEffect,
      (ref, options) => { handovers.push([ref, options]); }, TRANSIENT, MAIN_REF);
    const s = (args) => { rt.render(useRoot, args); return rt.render(useRoot, args); };
    s.handovers = handovers;
    return s;
  };
  const at = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const term = { id: 's1', status: 'active', plan_key: 'vip', started_at: at(-1), ends_at: at(90), grace_ends_at: at(93) };
  const lapsed = { ...term, started_at: at(-120), ends_at: at(-60), grace_ends_at: at(-57) };
  const pendingReq = { id: 'r1', status: 'pending_review', created_at: at(-1), expires_at: at(5) };
  const U = { id: 'uid-1' };
  // Approved BEFORE paying — #69's access email tells such an account to choose a plan — and enrolling now.
  const student = { id: 'uid-1', is_admin: false, is_paid: false, approval_status: 'approved' };
  const member = { ...student, is_paid: true };
  const E = {
    pending: { active: true, ready: true, configured: true, migrated: true, latestReq: pendingReq, sub: null, state: 'pending' },
    // ONE enrollment_requests read failed: configured false, the request dropped — the arm fails OPEN.
    failOpen: { active: true, ready: true, configured: false, migrated: true, latestReq: null, sub: null, state: 'paywall' },
    pass: { active: true, ready: true, configured: true, migrated: true, latestReq: { ...pendingReq, status: 'approved' }, sub: term, state: 'pass' },
    reading: { active: true, ready: false, configured: true, migrated: true, latestReq: null, sub: null, state: 'pass' },
    expired: { active: true, ready: true, configured: true, migrated: true, latestReq: null, sub: lapsed, state: 'expired' },
    // A MEMBER's enrollment_requests read failed: the term still reads, so the pass stands.
    memberFailOpen: { active: true, ready: true, configured: false, migrated: true, latestReq: null, sub: term, state: 'pass' },
  };
  const GS = {
    waiting: { status: 'ready', data: { eligible: false, required: false, completed: false } },
    asking: { status: 'loading', data: null },
    required: { status: 'ready', data: { eligible: true, required: true, completed: false } },
    failedOpen: { status: 'unavailable', data: null },
    finished: { status: 'ready', data: { eligible: true, required: false, completed: true, completed_current: true } },
    unpublished: { status: 'ready', data: { eligible: true, required: false, completed: false } },
  };

  // ★ V-GF2-LATCH, the verifier's sequence: the enrollment arm's fail-open app (not passing) → the pending
  //   screen → approval with Getting Started required. The latch used to fire on ANY app render, so this
  //   ended on the dashboard with no video.
  let step = mount();
  assert.equal(step({ user: U, profile: student, enroll: E.pending, gs: GS.waiting }).screen, GATE_SCREENS.ENROLL_PENDING);
  let r = step({ user: U, profile: student, enroll: E.failOpen, gs: GS.waiting });
  assert.deepEqual([r.screen, r.latched], [GATE_SCREENS.APP, false],
    'one failed read: the enrollment arm fails open into the app — and a not-yet-member\'s app is never latched');
  assert.equal(step({ user: U, profile: student, enroll: E.pending, gs: GS.waiting }).screen, GATE_SCREENS.ENROLL_PENDING,
    'the next good read: the pending screen again');
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.asking }).screen, GATE_SCREENS.SPLASH,
    'approved: the splash while the one re-ask is out');
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.required }).screen, GATE_SCREENS.GETTING_STARTED,
    'Getting Started before the first dashboard, as without the read error');
  // …and without the pending screen in between (the read error was the last thing before the approval).
  step = mount();
  step({ user: U, profile: student, enroll: E.pending, gs: GS.waiting });
  assert.equal(step({ user: U, profile: student, enroll: E.failOpen, gs: GS.waiting }).screen, GATE_SCREENS.APP);
  step({ user: U, profile: member, enroll: E.pass, gs: GS.asking });
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.required }).screen, GATE_SCREENS.GETTING_STARTED,
    'a fail-open app that no hold screen followed is no member\'s running session either');

  // ★ GF-2 still holds: a MEMBER's running app is never taken over…
  step = mount();
  r = step({ user: U, profile: member, enroll: E.pass, gs: GS.failedOpen });
  assert.deepEqual([r.screen, r.latched], [GATE_SCREENS.APP, true], 'the gate failed open on a member\'s pass: latched');
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.required }).screen, GATE_SCREENS.APP,
    'a required answer that arrives later (a replay page\'s "Try again", a refresh) never takes the session over');
  assert.equal(step({ user: U, profile: member, enroll: E.memberFailOpen, gs: GS.required }).screen, GATE_SCREENS.APP,
    'nor does a failed enrollment read while it runs');
  assert.equal(step({ user: U, profile: member, enroll: E.reading, gs: GS.required }).screen, GATE_SCREENS.SPLASH);
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.required }).screen, GATE_SCREENS.APP,
    'a splash decides nothing: it never turns into a takeover');
  assert.equal(step({ user: { id: 'uid-2' }, profile: { ...member, id: 'uid-2' }, enroll: E.pass, gs: GS.required }).screen,
    GATE_SCREENS.GETTING_STARTED, 'never another account\'s latch');
  // …and any HOLD screen ends the running session, so the next pass is the next load's answer.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.failedOpen });
  r = step({ user: U, profile: member, enroll: E.expired, gs: GS.required });
  assert.deepEqual([r.screen, r.latched], [GATE_SCREENS.MEMBERSHIP_EXPIRED, false], 'the term ended mid-session: the shell is gone, and the latch with it');
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.required }).screen, GATE_SCREENS.GETTING_STARTED,
    'renewed in the same session: the video it never watched, before the dashboard');
  // A sign-out forgets it: signOut() does not reload the page, and the root stays mounted.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.failedOpen });
  assert.equal(step({ user: null, profile: null, enroll: E.pass, gs: GS.failedOpen }).screen, GATE_SCREENS.AUTH);
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.required }).screen, GATE_SCREENS.GETTING_STARTED,
    'the same student signing in again is asked again');

  // ★ V-GF4-WELCOME: the gate let go because the video it showed was FINISHED — in another tab, on another
  //   device — so this tab's own finish (which closes the welcome) never ran.
  step = mount();
  let dismissed = 0;
  const welcome = { showWelcome: true, dismissWelcome: () => { dismissed += 1; } };
  r = step({ user: U, profile: member, enroll: E.pass, gs: GS.required, ...welcome });
  assert.deepEqual([r.screen, r.welcomeHeld], [GATE_SCREENS.GETTING_STARTED, false]);
  r = step({ user: U, profile: member, enroll: E.pass, gs: GS.finished, ...welcome });
  assert.deepEqual([r.screen, r.welcomeHeld], [GATE_SCREENS.APP, true], 'the first-login welcome is held — never mounted over the dashboard');
  assert.equal(dismissed, 1, 'and remembered as dismissed, exactly as finishing in this tab does');
  // A member who finished on an EARLIER visit never met the gate this session: their welcome is untouched.
  step = mount();
  r = step({ user: U, profile: member, enroll: E.pass, gs: GS.finished, showWelcome: true,
    dismissWelcome: () => { throw new Error('the welcome of a member the gate never showed was dismissed'); } });
  assert.deepEqual([r.screen, r.welcomeHeld], [GATE_SCREENS.APP, false]);
  // A gate that let go WITHOUT a completion (the video was unpublished) leaves the first-login welcome as it was.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required, showWelcome: true });
  r = step({ user: U, profile: member, enroll: E.pass, gs: GS.unpublished, showWelcome: true,
    dismissWelcome: () => { throw new Error('dismissed without a completion'); } });
  assert.deepEqual([r.screen, r.welcomeHeld], [GATE_SCREENS.APP, false]);
  // And a sign-out forgets whom the gate showed it to.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required });
  step({ user: null, profile: null, enroll: E.pass, gs: GS.failedOpen });
  assert.equal(step({ user: U, profile: member, enroll: E.pass, gs: GS.finished, showWelcome: true }).welcomeHeld, false,
    'signed in again, the gate has not shown this session anything');
  // ★ K3R-X04-TESTGAP: the video another tab finished was an EARLIER version — a new one was published before
  //   this tab's re-check, so completed_current is false. The student HAS finished a Getting Started video, so
  //   the first-login welcome is held all the same: `completed`, never `completed_current`, decides it.
  step = mount();
  dismissed = 0;
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required, ...welcome });
  r = step({ user: U, profile: member, enroll: E.pass, gs: { status: 'ready', data: { eligible: true, required: false, completed: true, completed_current: false } }, ...welcome });
  assert.deepEqual([r.screen, r.welcomeHeld, dismissed], [GATE_SCREENS.APP, true, 1],
    'an earlier version finished elsewhere is a finished video: the welcome is held and remembered as dismissed');

  // ★ K3R-FOCUS-HANDOVER: the gate handing over to the app hands focus to <main>, without scrolling — once.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required });
  assert.deepEqual(step.handovers, [], 'nothing while the gate shows');
  step({ user: U, profile: member, enroll: E.pass, gs: GS.finished });
  assert.deepEqual(step.handovers, [[TRANSIENT(MAIN_REF), { preventScroll: true }]],
    'Go, Continue for now or a re-check that lets go: focus goes to <main>, made focusable for that focus alone');
  step({ user: U, profile: member, enroll: E.memberFailOpen, gs: GS.finished });
  step({ user: U, profile: member, enroll: E.pass, gs: GS.finished });
  assert.equal(step.handovers.length, 1, 'and only on the hand-over, never on a later render of the app');
  // An ordinary load — a splash, then the app — takes no focus.
  step = mount();
  step({ user: U, profile: member, enroll: E.reading, gs: GS.asking });
  step({ user: U, profile: member, enroll: E.pass, gs: GS.finished });
  assert.deepEqual(step.handovers, [], 'an ordinary load leaves focus where the browser put it');
  // A splash between the gate and the app decides nothing: the hand-over still happens.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required });
  assert.equal(step({ user: U, profile: member, enroll: E.reading, gs: GS.required }).screen, GATE_SCREENS.SPLASH);
  step({ user: U, profile: member, enroll: E.pass, gs: GS.finished });
  assert.deepEqual(step.handovers, [[TRANSIENT(MAIN_REF), { preventScroll: true }]]);
  // Any other screen between them — a sign-out, a hold — is no hand-over from the gate.
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required });
  assert.equal(step({ user: null, profile: null, enroll: E.pass, gs: GS.failedOpen }).screen, GATE_SCREENS.AUTH);
  step({ user: U, profile: member, enroll: E.pass, gs: GS.finished });
  assert.deepEqual(step.handovers, [], 'signed out and in again: an ordinary sign-in');
  step = mount();
  step({ user: U, profile: member, enroll: E.pass, gs: GS.required });
  assert.equal(step({ user: U, profile: member, enroll: E.expired, gs: GS.required }).screen, GATE_SCREENS.MEMBERSHIP_EXPIRED);
  step({ user: U, profile: member, enroll: E.pass, gs: GS.finished });
  assert.deepEqual(step.handovers, [], 'a hold screen came between: no hand-over from the gate');

  // <main> is that target: the ref — and NO tabIndex at rest (K3RV-MAIN-CLICK-FOCUS). A static tabIndex={-1}
  // made it CLICK-focusable for its whole life: a mouse click on plain text focused <main>, and the next Tab went
  // to the first control at the top of the page and scrolled there (measured in Chrome with real events: the
  // Dashboard scrolled to 700 jumped to 0, Invoice Creator to 1). The outline it would draw while it holds the
  // hand-over's focus is the container's own, gone — every control inside keeps its :focus-visible ring.
  const rootJs = jsCode(rootSource()).replace(/\r\n/g, '\n');
  const mainAt = rootJs.indexOf('<main\n');
  assert.ok(mainAt > 0, '<main> was not found');
  const mainTag = rootJs.slice(mainAt, rootJs.indexOf('">', mainAt) + 2);
  assert.match(mainTag, /\bref=\{mainRef\}/);
  assert.doesNotMatch(mainTag, /tab-?index/i, 'not focusable at rest: a click on its plain text must leave focus — and the Tab order — where the browser puts them');
  assert.match(mainTag, /className="flex-1 overflow-y-auto focus:outline-none">$/, 'the container draws no ring of its own');
  assert.doesNotMatch(rootJs, /mainRef\.current\??\.(?:setAttribute|tabIndex)/, 'nothing in the root makes <main> focusable behind the JSX\'s back');
});

test('§28b <main> is focusable only while it holds the hand-over\'s focus — gone on the first blur or pointer press (K3RV-MAIN-CLICK-FOCUS)', () => {
  // transientFocusTarget(ref), RUN against a stand-in element: a container that is not focusable at rest takes
  // focus only with a tabindex, so the stand-in's focus() lands only while it carries one.
  // eslint-disable-next-line no-new-func
  const transientFocusTarget = new Function(`${componentSource('transientFocusTarget')}\nreturn transientFocusTarget;`)();
  const doc = new EventTarget();
  doc.activeElement = null;
  const element = (attrs = {}) => {
    const el = new EventTarget();
    const a = new Map(Object.entries(attrs));
    Object.assign(el, {
      ownerDocument: doc, lands: true, focusCalls: [],
      hasAttribute: (n) => a.has(n), getAttribute: (n) => (a.has(n) ? a.get(n) : null),
      setAttribute: (n, v) => { a.set(n, String(v)); }, removeAttribute: (n) => { a.delete(n); },
      focus: (options) => { el.focusCalls.push(options); if (el.lands && a.has('tabindex')) doc.activeElement = el; },
    });
    return el;
  };
  const blur = (el) => { doc.activeElement = null; el.dispatchEvent(new Event('blur')); };
  assert.equal(transientFocusTarget({ current: null }).current, null, 'no element: nothing to focus (the gate let go and the shell is not there)');
  assert.equal(transientFocusTarget(null).current, null);

  // The hand-over: tabindex="-1" while <main> holds that focus, and focus() gets the options as they are.
  const main = element();
  const ref = { current: main };
  assert.equal(main.getAttribute('tabindex'), null, 'not focusable at rest');
  transientFocusTarget(ref).current.focus({ preventScroll: true });
  assert.equal(doc.activeElement, main, 'the focus landed on <main>');
  assert.equal(main.getAttribute('tabindex'), '-1', 'focusable for that focus — and never a Tab stop');
  assert.deepEqual(main.focusCalls, [{ preventScroll: true }], 'never scrolls');
  // (c) the first blur — the next Tab, a click elsewhere — takes it away again.
  blur(main);
  assert.equal(main.getAttribute('tabindex'), null, 'after the hand-over and a blur, <main> carries no tabindex');
  // The first pointer press ANYWHERE takes it away too, before that press can move focus: a click on <main>'s
  // own plain text right after the hand-over then leaves focus — and the Tab order — where the browser puts it.
  transientFocusTarget(ref).current.focus({ preventScroll: true });
  assert.equal(main.getAttribute('tabindex'), '-1');
  doc.dispatchEvent(new Event('pointerdown'));
  assert.equal(main.getAttribute('tabindex'), null, 'a pointer press drops it before the press moves focus');
  // Each way of dropping it takes the OTHER listener with it: neither strips a tabindex set later by anyone else.
  main.setAttribute('tabindex', '0');
  blur(main);
  assert.equal(main.getAttribute('tabindex'), '0', 'the pointer press took the blur listener with it');
  main.removeAttribute('tabindex');
  transientFocusTarget(ref).current.focus();
  blur(main);
  main.setAttribute('tabindex', '0');
  doc.dispatchEvent(new Event('pointerdown'));
  assert.equal(main.getAttribute('tabindex'), '0', 'a blur took the pointer listener with it');
  main.removeAttribute('tabindex');
  // A focus that did not land leaves nothing behind.
  main.lands = false;
  transientFocusTarget(ref).current.focus({ preventScroll: true });
  assert.notEqual(doc.activeElement, main);
  assert.equal(main.getAttribute('tabindex'), null, 'it never took the focus, so it never keeps the attribute');
  // An element that already carries a tabindex is focused and left as it is: that attribute is not the helper's.
  const own = element({ tabindex: '0' });
  transientFocusTarget({ current: own }).current.focus({ preventScroll: true });
  assert.deepEqual([doc.activeElement === own, own.getAttribute('tabindex'), own.focusCalls], [true, '0', [{ preventScroll: true }]]);
  blur(own); doc.dispatchEvent(new Event('pointerdown'));
  assert.equal(own.getAttribute('tabindex'), '0');
  // The ref is read when refocusIfLost() acts — two frames on — never when the target is made.
  const late = { current: null };
  const t = transientFocusTarget(late);
  late.current = main; main.lands = true;
  t.current.focus();
  assert.equal(doc.activeElement, main, 'the element in the ref when the focus happens');
  blur(main);
  assert.equal((app().match(/setAttribute\('tabindex'/g) || []).length, 1, 'the one place an element is made focusable by hand');
});

test('§28b a first answer that FAILED while the student waited is asked again when the approval lands (GF-1, GF-8)', async () => {
  const U1 = 'uid-1';
  const warn = console.warn;
  console.warn = () => {};
  try {
    // An error on the pending screen (enrollPass false): nobody decided anything on it.
    let gs = mountGettingStarted();
    gs.render(U1, false); await settleAll();
    gs.calls[0].resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    await settleAll();
    assert.equal(gs.render(U1, false).status, 'unavailable');
    let v = gs.render(U1, true);                                       // the approval lands
    assert.deepEqual([v.status, v.data], ['loading', null], 'the splash holds — never the dashboard on a failure nobody decided on');
    await settleAll();
    assert.equal(gs.calls.length, 2, 'asked once more');
    answer(gs.calls[1], { eligible: true, required: true });
    await settleAll();
    assert.deepEqual(gettingStartedGateInput(gs.render(U1, true)), { status: 'ready', required: true },
      'Getting Started — the review\'s probe got the app here');
    for (let i = 0; i < 3; i += 1) { gs.render(U1, true); await settleAll(); }
    assert.equal(gs.calls.length, 2, 'once per account');

    // A thrown call, and a timeout that ran out on the pending screen: the same.
    gs = mountGettingStarted();
    gs.render(U1, false); await settleAll();
    gs.calls[0].reject(new TypeError('Failed to fetch')); await settleAll();
    gs.render(U1, true); await settleAll();
    assert.equal(gs.calls.length, 2, 'a thrown call');
    gs = mountGettingStarted(20);
    gs.render(U1, false); await settleAll();
    await wait(80);
    assert.equal(gs.render(U1, false).status, 'unavailable');
    gs.render(U1, true); await settleAll();
    assert.equal(gs.calls.length, 2, 'a timeout');
    gs.calls[1].reject(new TypeError('Failed to fetch')); await settleAll();
    assert.equal(gs.render(U1, true).status, 'unavailable', 'and the re-ask\'s own failure fails OPEN');

    // ★ At sign-in the gate IS waiting on the first question (the pass lands first): a timeout that runs
    //   out after it is the gate's answer — 7 s from the uid, as the plan decided, never a second 7 s.
    gs = mountGettingStarted(60);
    gs.render(U1, false); await settleAll();
    gs.render(U1, true); await settleAll();                           // the enrollment reads land: a pass
    await wait(150);
    assert.equal(gs.render(U1, true).status, 'unavailable');
    await settleAll();
    assert.equal(gs.calls.length, 1, 'no second wait on the splash');

    // ★ A database without #69 (GF-8): no answer can ever come, so it is never asked again — and it says so.
    gs = mountGettingStarted();
    gs.render(U1, false); await settleAll();
    gs.calls[0].resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.my_onboarding_video' } });
    await settleAll();
    v = gs.render(U1, true); await settleAll();
    assert.deepEqual([v.status, v.missing, gs.calls.length], ['unavailable', true, 1]);
    assert.equal(gs.render(U1, true).missing, true);
  } finally {
    console.warn = warn;
  }
});

test('§28b a first answer that failed BEFORE the enrollment reads landed is decided by where they land — never 7 s twice at sign-in (V-GF1-DOUBLE-BOUND)', async () => {
  // ★ At sign-in the question is sent the moment the uid exists, while the profile and the enrollment reads
  //   are still out. Handed a boolean, the hook read that as "no pass known" — the pending screen's GF-1
  //   case — so when the reads landed on a pass it re-asked, and the splash waited a second 7 s (14.4 s in
  //   Chrome, two my_onboarding_video calls). The phase tells loading ('unknown') from a hold.
  const U1 = 'uid-1';
  const warn = console.warn;
  console.warn = () => {};
  try {
    // The verifier's F: the reads and the question both stall; the question's bound runs out first.
    let gs = mountGettingStarted(20);
    gs.render(U1, false, false); await settleAll();                   // the uid exists; the reads are out
    await wait(80);                                                      // the question's bound ran out
    let v = gs.render(U1, false, false);
    assert.deepEqual([v.status, gs.calls.length], ['unavailable', 1]);
    v = gs.render(U1, true); await settleAll();                         // the reads land: a pass
    assert.equal(v.status, 'unavailable', 'the render the reads land in fails open — the splash ends there');
    for (let i = 0; i < 3; i += 1) { gs.render(U1, true); await settleAll(); }
    assert.equal(gs.calls.length, 1, 'and nothing is asked again: 7 s from the uid, never 7 s twice');
    // F2: an error that lands first, then the reads land on a pass — the same.
    gs = mountGettingStarted();
    gs.render(U1, false, false); await settleAll();
    gs.calls[0].resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    await settleAll();
    gs.render(U1, false, false); await settleAll();
    v = gs.render(U1, true); await settleAll();
    assert.equal(v.status, 'unavailable');
    gs.render(U1, true); await settleAll();
    assert.equal(gs.calls.length, 1);
    // …but when the reads land on a HOLD — the pending screen — nobody decided on it: the approval asks again (GF-1).
    gs = mountGettingStarted();
    gs.render(U1, false, false); await settleAll();
    gs.calls[0].reject(new TypeError('Failed to fetch')); await settleAll();
    gs.render(U1, false, false); await settleAll();
    gs.render(U1, false); await settleAll();                           // the reads land: payment under review
    gs.render(U1, false); await settleAll();
    assert.equal(gs.calls.length, 1, 'a hold asks nothing');
    v = gs.render(U1, true);                                            // the approval lands
    assert.deepEqual([v.status, v.data], ['loading', null], 'the splash holds for the one re-ask — never the dashboard');
    await settleAll();
    assert.equal(gs.calls.length, 2);
    answer(gs.calls[1], { eligible: true, required: true }); await settleAll();
    assert.deepEqual(gettingStartedGateInput(gs.render(U1, true)), { status: 'ready', required: true });
    // While the reads are still out, an undecided failure holds nothing — and asks nothing.
    gs = mountGettingStarted();
    gs.render(U1, false, false); await settleAll();
    gs.calls[0].reject(new TypeError('Failed to fetch')); await settleAll();
    for (let i = 0; i < 3; i += 1) { assert.equal(gs.render(U1, false, false).status, 'unavailable'); await settleAll(); }
    assert.equal(gs.calls.length, 1);
  } finally {
    console.warn = warn;
  }
});

test('§28b markCompleted applies only to the account it was asked for — and makes nothing stale when it does not (GF-7)', async () => {
  const A = 'uid-a';
  const B = 'uid-b';
  const done = (at) => ({ ok: true, recorded: true, video_id: 'v1', completed_at: at });
  // D: A's completion lands after A signed out and B's first question was sent.
  let gs = mountGettingStarted(50);
  gs.render(A, true); await settleAll();
  answer(gs.calls[0], { eligible: true, required: true }); await settleAll();
  const vA = gs.render(A, true);
  gs.render(null, false); await settleAll();                            // sign-out (no reload)
  gs.render(B, true); await settleAll();                                // B signs in: question #2
  assert.equal(vA.markCompleted(done('2026-10-01T01:00:00Z'), A), false, 'refused: A is not the signed-in account');
  answer(gs.calls[1], { eligible: true, required: true, completed: false, completed_current: false }); await settleAll();
  let v = gs.render(B, true);
  assert.deepEqual([v.status, v.data?.required], ['ready', true],
    'B\'s own answer still lands — the old completion made nothing stale (the review\'s probe hung on "loading" here)');
  // D2: B's answer first, then A's late completion.
  assert.equal(vA.markCompleted(done('2026-10-01T02:00:00Z'), A), false);
  v = gs.render(B, true);
  assert.deepEqual([v.data.required, v.data.completed], [true, false], 'never merged into another account\'s answer');
  // The right account: merged, and the questions asked before it go stale.
  assert.equal(v.markCompleted(done('2026-10-01T03:00:00Z'), B), true);
  v = gs.render(B, true);
  assert.deepEqual([v.uid, v.data.required, v.data.completed_current, v.data.completed_at], [B, false, true, '2026-10-01T03:00:00Z']);
  assert.equal(v.markCompleted(done('x')), false, 'no account named is not "whoever is signed in now"');
  // The right account with NO answer to merge into: refused, and the question in flight is not made stale.
  gs = mountGettingStarted();
  gs.render(A, true); await settleAll();
  assert.equal(gs.render(A, true).markCompleted(done('x'), A), false);
  answer(gs.calls[0], { eligible: true, required: true }); await settleAll();
  assert.equal(gs.render(A, true).data.required, true, 'its answer still lands');
  // …and an account SWITCH with no signed-out render between: until B's own answer lands, the answer
  // held is still A's — never one to merge B's completion into, nor a reason to make B's question stale.
  gs = mountGettingStarted();
  gs.render(A, true); await settleAll();
  answer(gs.calls[0], { eligible: true, required: false, completed: true, completed_current: true }); await settleAll();
  const vB = gs.render(B, true); await settleAll();                     // B's first question is out (calls[1])
  assert.equal(vB.markCompleted(done('2026-10-01T04:00:00Z'), B), false, 'A\'s answer is not B\'s to merge into');
  answer(gs.calls[1], { eligible: true, required: true, completed: false, completed_current: false }); await settleAll();
  v = gs.render(B, true);
  assert.deepEqual([v.status, v.uid, v.data?.required], ['ready', B, true], 'and B\'s own answer still lands');
  // ★ V-GF7-UNPINNED — the other half: A's OWN late completion after a DIRECT switch (no signed-out render
  //   between: a sign-in to another account in a second tab) while A's answer is still the one held. It names
  //   A, and A's answer is right there to merge into, so only "A is no longer the signed-in account" refuses
  //   it. Without that check it merged, made B's first question stale, and B sat on the splash for good.
  gs = mountGettingStarted(50);
  gs.render(A, true); await settleAll();
  answer(gs.calls[0], { eligible: true, required: true, completed: false, completed_current: false }); await settleAll();
  const vA2 = gs.render(A, true);
  gs.render(B, true); await settleAll();                                // B's first question is out (calls[1])
  assert.equal(vA2.markCompleted(done('2026-10-01T05:00:00Z'), A), false, 'refused: A is no longer the signed-in account');
  answer(gs.calls[1], { eligible: true, required: true, completed: false, completed_current: false }); await settleAll();
  v = gs.render(B, true);
  assert.deepEqual([v.status, v.uid, v.data?.required], ['ready', B, true], 'B\'s own answer still lands — the splash ends');
  await wait(80);
  assert.deepEqual([gs.render(B, true).status, gs.calls.length], ['ready', 2], 'and stays: no bound of B\'s ran out on a stale question');

  // The callers capture the account BEFORE they wait, and hand it back.
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen, /const forUid = gsRef\.current\?\.uid \?\? null;\s*const r = await recordOnboardingCompletion\(\);/);
  assert.match(screen, /if \(r\.ok\) \{ onDone\?\.\(r\.data, forUid\); return; \}/);
  const recorder = jsCode(componentSource('useReplayRecorder'));
  assert.match(recorder, /const forUid = gsRef\.current\?\.uid \?\? null;\s*const r = await recordOnboardingCompletion\(\);/);
  assert.match(recorder, /if \(r\.data\?\.recorded !== false\) gsRef\.current\?\.markCompleted\(r\.data, forUid\);/);
  const m = mountReplayRecorder({ eligible: true, completed_current: false });
  m.render().onVerdict({ complete: true, playedPct: 100, reason: 'ended', videoId: 'v1' });
  m.gs.uid = 'uid-someone-else';                                       // the account changed while it was in flight
  m.sends[0]({ ok: true, data: { ok: true, recorded: true, completed_at: 'x' }, code: null, context: {} }); await settleAll();
  assert.deepEqual(m.gs.markedFor, ['uid-replay'], 'the account it was SENT for — not whoever holds the answer now');
});

test('§28b the player bounds its start and its first signature: a stalled one gives up into the give-up panel (GF-3)', () => {
  const player = jsCode(componentSource('GettingStartedPlayer'));
  assert.match(player, /const settledRef = useRef\(false\);/, 'the video played, or the player already gave up');
  assert.match(player,
    /useEffect\(\(\) => \{\s*if \(!isLive\) return undefined;\s*const timer = setTimeout\(\(\) => \{\s*if \(!settledRef\.current\) onGiveUpRef\.current\?\.\('slow'\);\s*\}, ONBOARDING_LOAD_TIMEOUT_MS\);\s*return \(\) => clearTimeout\(timer\);\s*\}, \[isLive\]\);/,
    'one bound from the mount to the first frame: start_onboarding_video() and the signature postgrest-js and storage-js never time out');
  // Every way the wait can end settles it, so the bound never overrides a real reason, or fires after a video played.
  const start = player.slice(player.indexOf("startRef.current.then(({ data, error }) => {"), player.indexOf('}, [isLive]);'));
  assert.equal((start.match(/settledRef\.current = true;/g) || []).length, 2, 'a refused start and a thrown one');
  const ready = player.slice(player.indexOf('const handleReady = useCallback('), player.indexOf('}, [track, videoId, knownSeconds, recordRef]);'));
  assert.match(ready, /^const handleReady = useCallback\(\(\) => \{\s*settledRef\.current = true;/, 'the video played');
  const problem = player.slice(player.indexOf('const handleProblem = useCallback('), player.indexOf('}, [isLive]);', player.indexOf('const handleProblem')));
  assert.match(problem, /settledRef\.current = true;/, 'a player problem already gave up, with its own reason');
  // A slow load is not a playback problem: nothing is reported to the Super Admin for it.
  assert.ok(!/report_onboarding_video_problem[\s\S]{0,80}slow/.test(player));
  // An answer that lands after the bound still shows the video — and clears the panel (onRecover), unchanged.
  assert.match(player, /onRecoverRef\.current\?\.\(\);/);
});

test('§28b the gate asks again when the student comes back to it — a completion in another tab lets it go (GF-4)', () => {
  const rt = hookRuntime();
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  let now = 1_000_000;
  const hook = liftHook('useRecheckOnReturn', rt, { window: win, document: doc, Date: { now: () => now }, GS_RECHECK_MIN_MS: 10_000 });
  let checks = 0;
  rt.render(hook, () => { checks += 1; });
  win.dispatchEvent(new Event('focus'));
  assert.equal(checks, 0, 'the answer was just read: nothing for the first 10 s');
  now += 10_001;
  win.dispatchEvent(new Event('focus'));
  assert.equal(checks, 1, 'back to the tab: asked again');
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(checks, 1, 'a tab switch fires both events: one question, not two');
  now += 10_001;
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(checks, 1, 'leaving the tab is not coming back');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(checks, 2);
  let latest = 0;
  rt.render(hook, () => { latest += 1; });
  now += 10_001;
  win.dispatchEvent(new Event('focus'));
  assert.deepEqual([checks, latest], [2, 1], 'the newest callback is the one called, and nothing re-registers for it');
  rt.unmount();
  now += 20_000;
  win.dispatchEvent(new Event('focus'));
  assert.equal(latest, 1, 'let go on unmount');
  // The gate asks with keep: a failed check can never be what opens it.
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen, /\n  useRecheckOnReturn\(\(\) => gsRef\.current\?\.refresh\(\{ keep: true \}\)\);/);
});

test('§28b the page and the card ask the root again when the SERVER refuses the start — and say what happened (GF-5, S3)', () => {
  for (const name of ['GettingStartedPage', 'GettingStartedCard']) {
    const code = jsCode(componentSource(name));
    assert.match(code, /const gsRef = useRef\(gs\);\s*gsRef\.current = gs;/, `${name}: the latest answer, read by a stable handler`);
    assert.match(code,
      /const handleGiveUp = useCallback\(\(reason\) => \{\s*setGiveUp\(reason \|\| 'other'\);\s*if \(reason === 'ONBOARDING_VIDEO_UNAVAILABLE' \|\| reason === 'ONBOARDING_VIDEO_NOT_ELIGIBLE'\) gsRef\.current\?\.refresh\(\);\s*\}, \[\]\);/,
      `${name}: an unpublished video or a lapsed term is a fact about the account — the answer is asked for again`);
    const el = code.slice(code.indexOf('<GettingStartedPlayer '), code.indexOf('/>', code.indexOf('<GettingStartedPlayer ')));
    assert.match(el, /\bonGiveUp=\{handleGiveUp\}/, name);
    assert.ok(!/onGiveUp=\{setGiveUp\}/.test(code), name);
    assert.match(code, /\{gettingStartedGiveUpCopy\(giveUp\)\}/, `${name}: the panel says what happened`);
  }
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen, /\{gettingStartedGiveUpCopy\(giveUp\)\} Try it again, or email\{' '\}/);
  for (const name of ['GettingStartedScreen', 'GettingStartedPage', 'GettingStartedCard']) {
    assert.ok(!componentSource(name).includes('isn’t playing on this device right now'),
      `${name}: "on this device" is said by the copy helper, for a decode failure only`);
  }
});

test('§28b the gate brings its way out into view when the video gives up (S3)', () => {
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen, /const giveUpRef = useRef\(null\);/);
  assert.match(screen, /<div ref=\{giveUpRef\} className="rounded-2xl px-4 py-3 space-y-3"/);
  const effect = /useEffect\(\(\) => \{\s*if \(!giveUp\) return;([\s\S]*?)\}, \[giveUp\]\);/.exec(screen);
  assert.ok(effect, 'an effect keyed on the give-up alone');
  assert.match(effect[1], /giveUpRef\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest', behavior: reduce \? 'auto' : 'smooth' \}\);/,
    'to the NEAREST edge: at 1366×657 and 1280×720 Retry and "Continue to dashboard for now" sat half below the fold');
  assert.match(effect[1], /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.ok(!/\.focus\(/.test(effect[1]), 'focus stays where the student left it');
});

test('§28b the completion is bounded: a call that never answers becomes a Retry, never a spinner for good (S4)', async () => {
  const src = app();
  const helper = moduleAsyncFn(src, 'recordOnboardingCompletion');
  assert.match(helper, /setTimeout\(\(\) => resolve\(null\), ONBOARDING_COMPLETE_TIMEOUT_MS\)/);
  assert.match(helper, /finally \{\s*clearTimeout\(timer\);\s*\}/, 'and its timer never outlives the call');
  const run = (rpc, ms) => new Function('supabase', 'appErrorCode', 'appErrorContext', 'ONBOARDING_COMPLETE_TIMEOUT_MS',
    `${helper}\nreturn recordOnboardingCompletion;`)({ rpc }, appErrorCode, appErrorContext, ms)();
  const t0 = Date.now();
  // Raced against the test's own patience: a helper whose bound is broken must FAIL here, not hang the file.
  const hung = await Promise.race([run(() => new Promise(() => {}), 40), wait(2_000).then(() => 'still waiting')]);
  assert.notEqual(hung, 'still waiting', 'a call that never answers must end at the bound');
  assert.deepEqual([hung.ok, hung.code, hung.data, hung.error], [false, 'timeout', null, null]);
  assert.ok(Date.now() - t0 < 2_000, 'at the bound');
  const fine = await run(async () => ({ data: { ok: true, recorded: true }, error: null }), 60_000);
  assert.equal(fine.ok, true, 'an answer inside the bound is the answer');
  // The gate releases its lock when the helper returns — so a hung call ends in the Retry branch.
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.match(screen, /const r = await recordOnboardingCompletion\(\);\s*busyRef\.current = false;\s*setBusy\(false\);/);
  assert.ok(!APP_ERROR_COPY.timeout, '"timeout" is not an app error code: the gate falls back to its connection message');
});

test('§28b at the end with a part skipped the gate says to play it again — never "keep going" (S2)', () => {
  // watchVerdict() says 'skipped' when the video ENDED under 90% (test/gettingStarted.test.mjs). The
  // gate must say what that means: the video has stopped, so "keep going" cannot be done; playing it
  // again can, and what was watched already counts. Measured in Chrome: 0.9 s played, scrubbed to
  // 2.2 s of a 3 s clip, played to the end — "Watched 57% — keep going to unlock your dashboard."
  const body = jsCode(componentSource('GettingStartedBody'));
  const skipped = body.indexOf("else if (verdict?.reason === 'skipped') progress = `You skipped part of it (watched ${verdict.playedPct}%). Play it again — what you’ve already watched still counts.`;");
  assert.ok(skipped > 0, 'the skipped line was not found');
  assert.ok(skipped < body.indexOf('— keep going to unlock your dashboard.'), 'answered before "keep going", which it would otherwise fall into');
  assert.ok(body.indexOf("verdict?.reason === 'playing'") < skipped, 'and after "play it to the end", the other reason with its own words');
});

test('§28b a status message is SAID through a region that was already there — never one mounted with its text (S5)', () => {
  const screen = jsCode(componentSource('GettingStartedScreen'));
  assert.ok(!/role="status"/.test(screen), 'the gate\'s give-up panel and messages carry no live role of their own');
  assert.match(screen, /role=\{message\.tone === 'danger' \? 'alert' : undefined\}/, 'an alert is still an alert');
  assert.match(screen, /const speak = useCallback\(\(text\) => setSpoken\(\(s\) => \(\{ text, n: \(s\?\.n \|\| 0\) \+ 1 \}\)\), \[\]\);/);
  assert.match(screen, /useEffect\(\(\) => \{\s*if \(message && message\.tone !== 'danger'\) speak\(message\.text\);\s*\}, \[message, speak\]\);/);
  assert.match(screen, /useEffect\(\(\) => \{\s*if \(giveUp\) speak\(`\$\{gettingStartedGiveUpCopy\(giveUp\)\} /);
  assert.match(screen, /<GettingStartedBody [^>]*\bannouncement=\{spoken\}/);
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.match(body, /useEffect\(\(\) => \{\s*if \(announcement\?\.text\) say\(announcement\.text\);\s*\}, \[announcement, say\]\);/,
    'through the Body\'s one polite region — the region that announces the unlock');
  for (const name of ['GettingStartedPage', 'GettingStartedCard']) {
    const code = jsCode(componentSource(name));
    assert.match(code, /<p role="status" aria-live="polite" className="sr-only">\{spoken\.text\}\{spoken\.n % 2 \? ' ' : ''\}<\/p>/,
      `${name}: one polite region, mounted with the surface, empty until it speaks`);
    assert.match(code, /useEffect\(\(\) => \{\s*if \(giveUp\) speak\(gettingStartedGiveUpCopy\(giveUp\)\);\s*\}, \[giveUp, speak\]\);/, name);
    assert.match(code, /useEffect\(\(\) => \{\s*if \(replay\.note\) speak\(replay\.note\);\s*\}, \[replay\.note, speak\]\);/, name);
    assert.equal((code.match(/role="status"/g) || []).length, name === 'GettingStartedPage' ? 2 : 1,
      `${name}: the region (and, on the page, the loading hint) — no panel or note mounts with a live role`);
  }
});

test('§28b the card\'s chip agrees with the page, and never assigns a to-do nobody set; its toggle opens a video (S6)', () => {
  const card = jsCode(componentSource('GettingStartedCard'));
  assert.match(card, /const standing = gettingStartedStanding\(data\);/);
  assert.match(card, /const chip = isStaff \? null : \(\{ completed: 'Completed', earlier: 'Finished an earlier version', owed: 'Not finished' \}\)\[standing\] \|\| null;/,
    'an earlier version is finished, and a member who was never asked has no chip at all');
  assert.match(card, /\{chip \? \(/);
  assert.match(card, /\{open \? 'Close video' : 'Open video'\}/, 'it opens a paused player: it never said Play');
  assert.ok(!/'Replay'|'Play'/.test(card));
  const page = jsCode(componentSource('GettingStartedPage'));
  assert.match(page, /const standing = gettingStartedStanding\(data\);/, 'the page reads the same standing');
  assert.match(page, /else if \(standing === 'earlier'\) statusLine = when \? `You finished an earlier version on \$\{when\}\.` : 'You finished an earlier version\.';/);
});

test('§28b a database without #69: the page says Getting Started is not set up — and offers no "try again" that cannot succeed (GF-8)', () => {
  const page = jsCode(componentSource('GettingStartedPage'));
  const at = page.indexOf('if (gs.missing === true) {');
  assert.ok(at > 0 && at < page.indexOf("The Getting Started video isn’t available right now. Please try again in a moment."),
    'decided before the "try again" card');
  const branch = page.slice(at, page.indexOf('\n    }', at));
  assert.ok(branch.includes('Getting Started isn’t set up yet, so there’s no welcome video to watch here.'));
  assert.ok(!/Try again|tryAgain|refresh/.test(branch), 'nothing to retry: no answer can come');
  assert.match(jsCode(componentSource('useGettingStarted')), /settle\(\{ failed: true, missing \}\);/);
});

test('§28b the student surfaces\' small text clears AA in both themes (S8)', () => {
  const body = jsCode(componentSource('GettingStartedBody'));
  assert.match(body, /<p style=\{\{ fontSize: 12\.5, lineHeight: 1\.6, color: C\.textSoft \}\}>\s*Trouble playing the video\? Email/,
    'the one route to support when the video fails — 2.97:1 in the mute grey');
  assert.match(body, /className="font-semibold underline" style=\{\{ color: NAVY, overflowWrap: 'anywhere' \}\}>\{support\}<\/a>/,
    'the deep-blue text token: 6.9:1 light, 7.9:1 dark (the accent blue is 3.6:1 as text)');
  assert.match(body, /<SubHeading id=\{journeyId\} className="gh-label" style=\{\{ color: C\.textSoft \}\}>The journey ahead<\/SubHeading>/);
  assert.match(body, /<button type="button" onClick=\{onSignOut\} className="py-2 text-xs font-semibold" style=\{\{ color: C\.textSoft, overflowWrap: 'anywhere' \}\}>/);
  const page = jsCode(componentSource('GettingStartedPage'));
  assert.match(page, /\{length \? <p className="mt-0\.5" style=\{\{ fontSize: 12\.5, color: C\.textSoft \}\}>\{length\}<\/p> : null\}/);
  const card = jsCode(componentSource('GettingStartedCard'));
  assert.match(card, /<div className="gh-label" style=\{\{ color: NAVY \}\}>Getting Started<\/div>/);
  assert.match(app(), /\nconst NAVY {2}= 'var\(--navy\)';/, 'NAVY is the theme-aware deep-blue text token');
  assert.match(css(), /--navy: #0057B8;/);
  assert.match(css(), /--navy: #7EB0FF;/);
});

test('§28b the replay page\'s frame fits under its sticky header on a phone held sideways (S7)', () => {
  const sheet = css().replace(/\r\n/g, '\n');
  assert.match(sheet,
    /\n\.gs-stage\[data-gs-mode="page"\] \{\s*width: min\(100%, calc\(min\(72vh, 820px, max\(160px, 100vh - 175px\)\) \* 16 \/ 9\)\);\s*width: min\(100%, calc\(min\(72vh, 820px, max\(160px, 100dvh - 175px\)\) \* 16 \/ 9\)\);\s*\}/,
    'the page\'s own height budget: under the 151px sticky header the frame must fit at 844×390 and 667×375');
  assert.ok(sheet.indexOf('\n.gs-stage[data-gs-mode="page"] {') > sheet.indexOf('\n.gs-stage {'), 'after the frame\'s own rule, which it narrows');
});

test('§18/§28b the <video> itself draws the ring when it has focus — the first keyboard stop on the gate, the page and the card (S1)', () => {
  // ★ D2 drew the ring when the FRAME is focused. Tab's first stop on every Getting Started surface is
  //   the <video> (a lesson's too), whose 2px outline sits 2px OUTSIDE it — and .course-stage and
  //   .gs-stage both clip: measured in Chrome, not one ring pixel on any edge, in either theme.
  const sheet = css().replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const frameRing = sheet.indexOf('\n.course-stage:focus-visible::after {');
  const videoOutline = sheet.indexOf('\n.course-stage > video:focus-visible { outline: none; }');
  assert.ok(videoOutline > 0, 'the video draws no outline of its own: outside it, every caller clips it away');
  const ring = /\n\.course-stage:has\(> video:focus-visible\)::after \{([^}]*)\}/.exec(sheet);
  assert.ok(ring, 'the frame paints the ring for its focused <video>');
  assert.ok(frameRing > 0 && ring.index > frameRing && videoOutline > frameRing,
    'beside D2\'s own rule, which stays a rule of its own: a browser without :has() drops only this one');
  const decl = ring[1].replace(/\s+/g, ' ');
  for (const d of ["content: '';", 'position: absolute;', 'top: 0; right: 0; bottom: 0; left: 0;',
    'border: 2px solid var(--c-primary);', 'pointer-events: none;']) {
    assert.ok(decl.includes(d), `the video's ring needs ${d}, as the frame's does`);
  }
  for (const m of sheet.matchAll(/\.[\w-]+ :focus-visible/g)) {
    assert.ok(m.index < ring.index, `${m[0]} comes after the video's ring`);
  }
});

test('§19 a refused "Replace video" keeps the upload it would replace: the uploader reads the new file FIRST, and discards only one it accepts', async () => {
  // ★ PRE-EXISTING, IN THE SHARED UPLOADER. handlePick's first act was `await discardPending()`,
  //   before validateVideoFile had looked at the new file. Pick a video and let it verify (the lesson
  //   draft now names it), press "Replace video", choose the wrong file: the verified upload was
  //   deleted, the pick refused — and the draft still named the deleted object. saveLesson's
  //   refused-pick guard fires only when the draft names NO file, so Save wrote a lesson whose video
  //   was gone.
  const body = uploaderBody().replace(/\r\n/g, '\n');
  const pick = `${fnBody(body, 'async function handlePick(')}\n  }`;
  assert.equal((jsCode(pick).match(/await discardPending\(\);/g) || []).length, 1, 'one discard, in one place');
  // RUN it, against the real validateVideoFile, with every other step stubbed to the branch under test.
  const run = async (file, opts = {}) => {
    const { inspection = { readable: true, codec: 'avc1' }, content = { ok: true }, plan = { ok: false },
      probe = async () => 12, frame = async () => {}, closeDuringDiscard = false } = opts;
    const log = [];
    const mountedRef = { current: true };
    const env = {
      setErrMsg: (m) => { if (m) log.push('refused'); }, setRetryable: () => {}, liveStepRef: { current: 0 },
      setNotice: () => {}, setWeightNote: () => {}, setRemuxNote: () => {}, codecRiskRef: { current: false },
      discardPending: async () => { log.push('discard'); if (closeDuringDiscard) mountedRef.current = false; },
      fileRef: { current: null }, setFileInfo: () => {}, setProgress: () => {}, setDuration: () => {},
      beginPick: () => {}, go: (e) => log.push(e), UPLOAD_EVENTS, announce: () => {}, validateVideoFile, copy: {},
      inspectLessonVideo: async () => inspection, mountedRef, describeVideoContent: () => content,
      planFaststartRemux: async () => plan, buildFaststartFile: (f) => ({ ...f }), releaseBlob: () => {},
      blobUrlRef: { current: null }, URL: { createObjectURL: () => 'blob:harness' },
      probeVideoMetadata: probe, probeVideoFrame: frame, describeVideoWeight: () => ({ message: '' }),
      runTransfer: async () => { log.push('transfer'); },
    };
    // eslint-disable-next-line no-new-func
    const handlePick = new Function(...Object.keys(env), `${pick}\nreturn handlePick;`)(...Object.values(env));
    await handlePick(file);
    return log;
  };
  const mp4 = (name = 'welcome.mp4', size = 4096) => ({ name, type: 'video/mp4', size });
  const remuxable = { content: { ok: false, reason: 'not-faststart', message: 'Its index is at the end.' }, plan: { ok: true } };
  // Every refusal leaves the previous upload where it is…
  for (const [why, file, opts] of [
    ['a .txt', { name: 'notes.txt', type: 'text/plain', size: 1200 }, {}],
    ['an empty file', mp4('empty.mp4', 0), {}],
    ['a file over the cap', mp4('huge.mp4', LESSON_VIDEO_MAX_BYTES + 1), {}],
    ['a file nothing could read that this browser will not play', mp4(),
      { inspection: { readable: false, codec: null }, probe: async () => { throw new Error('decode'); } }],
    ['a file we rearranged that will not decode', mp4(), { ...remuxable, frame: async () => { throw new Error('decode'); } }],
  ]) {
    const log = await run(file, opts);
    assert.ok(log.includes(UPLOAD_EVENTS.VALIDATE_FAIL) && log.includes('refused'), `${why} is refused`);
    assert.ok(!log.includes('discard'), `${why}: refused, so the upload it would replace must still exist — the draft still names it`);
    assert.ok(!log.includes('transfer'), `${why} is never sent`);
  }
  // …and an ACCEPTED replacement drops the old one once — after the last check, before its own transfer.
  for (const [why, opts] of [
    ['a playable H.264 file', {}],
    ['a file whose index was moved to the front', remuxable],
    ['a file with a codec note (a note never stops the upload)', { content: { ok: false, reason: 'codec-unsupported', message: 'HEVC.' } }],
  ]) {
    const log = await run(mp4(), opts);
    assert.deepEqual(log.filter((x) => x === 'discard' || x === UPLOAD_EVENTS.VALIDATE_OK || x === 'transfer'),
      ['discard', UPLOAD_EVENTS.VALIDATE_OK, 'transfer'], `${why}: discarded once, before it is sent`);
    assert.ok(log.indexOf('discard') > log.indexOf(UPLOAD_EVENTS.VALIDATE_START),
      `${why}: never before the new file has even been looked at`);
  }
  // …and an uploader closed WHILE that discard ran (the drawer shut as the old object was being
  // removed) starts no transfer: nothing would be left to track the new object.
  const closed = await run(mp4(), { closeDuringDiscard: true });
  assert.deepEqual(closed.filter((x) => x === 'discard' || x === UPLOAD_EVENTS.VALIDATE_OK || x === 'transfer'), ['discard'],
    'closed during the discard: no "Upload started", no transfer');
});

// ── §19/§28a/§28c, continued: what the Task 13 final review found on the Super Admin screen, the
//    shared uploader and player, the LESSON editor, Enrollments and the chokepoint (#69, writer A2) ──
// RES-1 (data loss in the lesson editor — pre-existing), AUI-1…AUI-7, DBSEC-1's client half, EMAIL-1
// and EMAIL-4's client halves, TDR-5, TDR-8 and T12B-D1, each named in its test. Every guard was
// broken on purpose in a scratch copy, one at a time, and each break turned its test red; the render
// half of each was proven in headless Chrome against the whole app.

const LESSON_C = '3f7c1a2e-9b44-4d61-8a05-6e2f7c9d1b30';
const LESSON_S = `lessons/${LESSON_C}/0a0b0c0d-1111-4222-8333-444455556666-saved.mp4`;
const LESSON_A = `lessons/${LESSON_C}/aaaaaaaa-1111-4222-8333-444455556666-a.mp4`;
const LESSON_B = `lessons/${LESSON_C}/bbbbbbbb-1111-4222-8333-444455556666-b.mp4`;
const LESSON_U = `lessons/${LESSON_C}/cccccccc-1111-4222-8333-444455556666-u.mp4`;
const LESSON_ROW = Object.freeze({
  id: 'L1', type: 'video', title: 'Lesson one', storage_path: LESSON_S, video_provider: 'upload', video_url: null,
  text_content: null, duration_label: null,
});

/** CourseProgram's saveLesson, lifted and RUN in a small world: one lesson row, what is in storage, a log. */
function runSaveLesson({ row = LESSON_ROW, draft, pending = null, stored = [], uploadState = UPLOAD_STATES.EMPTY }) {
  const body = `${fnBody(appLF(), '  async function saveLesson() {')}\n  }`;
  const world = { row: { ...row }, stored: new Set(stored), log: [] };
  const log = (...e) => world.log.push(e);
  const env = {
    editingLesson: draft, setLessonErr: (m) => { if (m) log('err', m); }, liveLessonDraft: () => draft,
    allLessons: [world.row], lessonVideoPayload, refuseSave: (m) => log('refused', m), blocksLessonSave,
    videoUploadState: uploadState, UPLOAD_STATES, lessonImages: [], validateLessonContent: () => ({ ok: true, errors: [] }),
    requestAnimationFrame: () => {}, lessonEditorRef: { current: null }, lessonBodyRef: { current: null },
    parseReplayUrl: () => ({ kind: 'none' }), setReplayErr: () => {}, setLessonPreview: () => {}, replayInputRef: { current: null },
    setSavingLesson: () => {}, lessonRowsArePreReplay: () => true, lessonRowsArePreRichContent: () => true, normalizeFormat: (f) => f,
    lessonVideoInStorage: async (p) => { log('stored?', p); return world.stored.has(p); },
    supabase: {
      from: () => ({
        update: (payload) => ({
          eq: async () => { log('update', payload.storage_path); Object.assign(world.row, payload); return { error: null }; },
        }),
      }),
    },
    sweepLessonAssetOrphans: async () => {},
    removeMediaIfUnreferenced: async (paths) => {
      for (const p of paths) { log('remove', p); if (world.row.storage_path !== p) world.stored.delete(p); }
    },
    pendingVideoPathRef: { current: pending }, setVideoUploadState: () => {}, setLessonImages: () => {},
    clearLessonDraft: () => {}, setEditingLesson: () => log('closed'), load: async () => {}, isAdmin: true,
    aiTrainerEnabled: false, course: { id: LESSON_C }, kickTrainerSync: () => {}, logDbError: () => {},
    describeDbError: (e, fallback) => fallback,
  };
  // eslint-disable-next-line no-new-func
  const saveLesson = new Function(...Object.keys(env), `${body}\nreturn saveLesson;`)(...Object.values(env));
  return { world, pendingRef: env.pendingVideoPathRef, run: () => saveLesson() };
}

test('§19 a discarded upload stops being the LESSON draft\'s video — it goes back to what the row still holds (RES-1)', () => {
  // ★ PRE-EXISTING DATA LOSS. A saved video S; upload A (it verifies, so the draft names A); "Replace
  //   video" with B — ACCEPTED, so A is discarded, by design; Cancel on B; Save. The draft still named
  //   the deleted A: the row was pointed at nothing and saveLesson's cleanup deleted S as "replaced".
  //   The Getting Started drawer already reverted (T9V-L4); the lesson editor now does the same.
  const decl = jsCode(statementFrom(appLF(), '  const notePendingVideoPath = useCallback((path) => {', '\n  }, []);'));
  assert.ok(!/\n {2}(?:const|let|function|useEffect)\b/.test(decl),
    'notePendingVideoPath must be ONE statement that reads the dropped path — it was a one-line setter that forgot it');
  assert.match(decl, /const dropped = pendingVideoPathRef\.current;/);
  const lift = (s) => new Function('useCallback', 'pendingVideoPathRef', 'savedLessonVideoRef', 'prefilledLabelRef', 'setEditingLesson',
    `${decl}\nreturn notePendingVideoPath;`)((f) => f, s.pending, s.saved, { current: null },
    (fn) => { s.draft = typeof fn === 'function' ? fn(s.draft) : fn; });
  const ROW = { id: 'L1', storage_path: LESSON_S, video_provider: 'upload', video_url: null };
  const state = (draftVideo, pending, saved = ROW) => ({
    pending: { current: pending }, saved: { current: saved },
    draft: { id: 'L1', title: 'Lesson one', type: 'video', duration_label: '4:10', ...draftVideo },
  });
  const onA = { storage_path: LESSON_A, video_provider: 'upload', video_url: null };
  let s = state(onA, LESSON_A);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider, s.draft.video_url, s.pending.current],
    [LESSON_S, 'upload', null, null], 'back to the video the row holds — never the deleted A');
  assert.deepEqual([s.draft.title, s.draft.duration_label], ['Lesson one', '4:10'], 'nothing else in the draft moves');
  // A legacy-link lesson goes back to its link, byte for byte — lessonVideoPayload then carries it over.
  const LINK = { id: 'L1', storage_path: null, video_provider: 'youtube', video_url: 'https://youtu.be/abcdefghijk' };
  s = state(onA, LESSON_A, LINK);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider, s.draft.video_url], [null, 'youtube', 'https://youtu.be/abcdefghijk']);
  assert.deepEqual(lessonVideoPayload(s.draft, LINK), { video_url: LINK.video_url, video_provider: 'youtube', storage_path: null },
    'and a save writes the link back unchanged — the guard trigger permits nothing else');
  // A lesson with no video goes back to none; a row for ANOTHER lesson is never applied.
  s = state(onA, LESSON_A, { id: 'L1', storage_path: null, video_provider: null, video_url: null });
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider, s.draft.video_url], [null, null, null]);
  s = state(onA, LESSON_A, { ...ROW, id: 'L2' });
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider], [null, null], 'no row of this lesson: nothing that exists is claimed');
  // An upload the draft never named (its check failed) changes nothing; a new pending one is only noted.
  s = state({ storage_path: LESSON_S, video_provider: 'upload', video_url: null }, LESSON_U);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.pending.current], [LESSON_S, null], 'the draft never named it');
  s = state({ storage_path: LESSON_S, video_provider: 'upload', video_url: null }, null);
  lift(s)(LESSON_A);
  assert.deepEqual([s.draft.storage_path, s.pending.current], [LESSON_S, LESSON_A]);
  // The admin pressed Remove (the draft names no video), then an upload failed its check and was
  // dropped: the removal stands — a discard never brings back a video the admin took away.
  s = state({ storage_path: null, video_provider: null, video_url: null }, LESSON_U);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider], [null, null], 'only a draft that NAMED the dropped upload goes back');
  // ★ V-RES1-GUARD — and a null with NOTHING pending is no discard at all (the `!dropped` half). Remove's own
  //   null, when no upload was pending, must leave a draft that names no video exactly as the admin left it.
  s = state({ storage_path: null, video_provider: null, video_url: null }, null);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider, s.draft.video_url, s.pending.current], [null, null, null, null],
    'an explicit Remove stands — nothing was pending, so nothing is "reverted" to the row\'s video');
  s = state(onA, null);
  lift(s)(null);
  assert.deepEqual([s.draft.storage_path, s.draft.video_provider, s.draft.duration_label], [LESSON_A, 'upload', '4:10'],
    'nor does it move a draft that names a video');
  // The ref is the ROW's, assigned beside originalEditingLesson; the callback stays stable.
  const code = jsCode(appLF());
  assert.match(code, /const savedLessonVideoRef = useRef\(null\);/);
  assert.match(code,
    /const originalEditingLesson = editingLesson \? allLessons\.find\(l => l\.id === editingLesson\.id\) : null;\s*savedLessonVideoRef\.current = originalEditingLesson \? \{\s*id: originalEditingLesson\.id,\s*storage_path: originalEditingLesson\.storage_path \?\? null,\s*video_provider: originalEditingLesson\.video_provider \?\? null,\s*video_url: originalEditingLesson\.video_url \?\? null,\s*\} : null;/);
  assert.match(code, /onPendingPath=\{notePendingVideoPath\}/);
  assert.match(decl, /^ {2}const notePendingVideoPath = useCallback\(\(path\) => \{[\s\S]*\n {2}\}, \[\]\);$/, 'stable: [] deps, read through refs');
});

test('§19 the LENGTH a discarded upload pre-filled goes back with it — never saved beside the row\'s own video (V-RES1-LABEL)', () => {
  // The RES-1 revert put storage_path, video_provider and video_url back on the row's, and KEPT the duration
  // label the dropped upload had pre-filled: Save stored that upload's length beside the row's own video, the
  // curriculum showed it to students, and a replacement that finished could not pre-fill its own.
  const code = appLF();
  const note = jsCode(statementFrom(code, '  const notePendingVideoPath = useCallback((path) => {', '\n  }, []);'));
  const apply = jsCode(statementFrom(code, '  function applyVideoPatch(patch) {', '\n  }\n'));
  assert.match(jsCode(code), /const prefilledLabelRef = useRef\(null\);/);
  const ROW = Object.freeze({ id: 'L1', storage_path: LESSON_S, video_provider: 'upload', video_url: null });
  const world = (draft, row = ROW) => {
    const w = {
      pending: { current: null }, saved: { current: row }, prefilled: { current: null },
      draft: { id: 'L1', title: 'Lesson one', type: 'video', storage_path: row.storage_path, video_provider: row.video_provider, video_url: null, ...draft },
    };
    // eslint-disable-next-line no-new-func
    const fns = new Function('useCallback', 'pendingVideoPathRef', 'savedLessonVideoRef', 'prefilledLabelRef', 'setEditingLesson',
      'formatMediaDuration', `${note}\n${apply}\nreturn { notePendingVideoPath, applyVideoPatch };`)(
      (f) => f, w.pending, w.saved, w.prefilled, (fn) => { w.draft = typeof fn === 'function' ? fn(w.draft) : fn; }, formatMediaDuration);
    return { w, ...fns };
  };
  const upload = (path, seconds) => ({ storage_path: path, video_provider: 'upload', video_url: null, __durationSeconds: seconds });
  // The verifier's sequence: the row's video S has NO label; A (6.5 s) verifies and pre-fills its length; a
  // Replace with B is ACCEPTED, which discards A; then B is cancelled.
  let t = world({ duration_label: null });
  t.notePendingVideoPath(LESSON_A);
  t.applyVideoPatch(upload(LESSON_A, 6.5));
  assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_A, '0:06'], 'A verified: its own length, pre-filled');
  t.notePendingVideoPath(null);                                         // the Replace is accepted: A is gone
  assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_S, null],
    'back on the row\'s video — and the length A put there goes with A');
  t.notePendingVideoPath(LESSON_B);
  t.notePendingVideoPath(null);                                         // Cancel B: B was never the draft's
  assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_S, null], 'and a Cancel moves nothing more');
  // B finishing instead pre-fills ITS length: the label is free again.
  t = world({ duration_label: null });
  t.notePendingVideoPath(LESSON_A);
  t.applyVideoPatch(upload(LESSON_A, 6.5));
  t.notePendingVideoPath(null);
  t.notePendingVideoPath(LESSON_B);
  t.applyVideoPatch(upload(LESSON_B, 2.6));
  assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_B, '0:02'], 'B\'s own length — never A\'s');
  // A label the admin wrote after the pre-fill stands.
  t = world({ duration_label: null });
  t.notePendingVideoPath(LESSON_A);
  t.applyVideoPatch(upload(LESSON_A, 6.5));
  t.w.draft = { ...t.w.draft, duration_label: '7 min' };
  t.notePendingVideoPath(null);
  assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_S, '7 min'], 'the admin\'s own words are theirs');
  // A label the admin had CLEARED before the upload goes back to cleared: undoing the pre-fill is all it does.
  t = world({ duration_label: '' });
  t.notePendingVideoPath(LESSON_A);
  t.applyVideoPatch(upload(LESSON_A, 6.5));
  t.notePendingVideoPath(null);
  assert.equal(t.w.draft.duration_label, '');
  // A label that was never pre-filled — the admin's own, there before the upload — is never touched.
  t = world({ duration_label: '4:10' });
  t.notePendingVideoPath(LESSON_A);
  t.applyVideoPatch(upload(LESSON_A, 6.5));
  assert.equal(t.w.draft.duration_label, '4:10', 'never overwritten');
  t.notePendingVideoPath(null);
  assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_S, '4:10']);
  // A pre-fill recorded for another lesson, or for another upload, is never taken back.
  for (const [what, alter] of [['another lesson', { id: 'L2' }], ['another upload', { path: LESSON_U }]]) {
    t = world({ duration_label: null });
    t.notePendingVideoPath(LESSON_A);
    t.applyVideoPatch(upload(LESSON_A, 6.5));
    t.w.prefilled.current = { ...t.w.prefilled.current, ...alter };
    t.notePendingVideoPath(null);
    assert.deepEqual([t.w.draft.storage_path, t.w.draft.duration_label], [LESSON_S, '0:06'], `a pre-fill recorded for ${what}`);
  }
});

test('§19 a lesson is never pointed at a file that is not there — and its saved video survives the attempt (RES-1)', async () => {
  // The draft names A, already discarded: the RES-1 sequence without the revert, or a restored draft
  // whose upload the "unused files" panel has since deleted.
  const gone = runSaveLesson({ draft: { ...LESSON_ROW, storage_path: LESSON_A }, stored: [LESSON_S] });
  await gone.run();
  assert.deepEqual(gone.world.log.map((e) => e[0]), ['stored?', 'refused'], 'proven first — refused, and nothing written');
  assert.match(gone.world.log[1][1], /isn’t in storage any more, so nothing was saved/);
  assert.equal(gone.world.row.storage_path, LESSON_S, 'the row still names its video');
  assert.ok(gone.world.stored.has(LESSON_S), 'and that video is still in storage — it was never "replaced"');
  // A new upload that IS there is saved, and the file it replaces goes.
  const fresh = runSaveLesson({ draft: { ...LESSON_ROW, storage_path: LESSON_B }, pending: LESSON_B, stored: [LESSON_S, LESSON_B] });
  await fresh.run();
  assert.deepEqual(fresh.world.log, [['stored?', LESSON_B], ['update', LESSON_B], ['remove', LESSON_S], ['closed']]);
  assert.deepEqual([...fresh.world.stored], [LESSON_B]);
  // An unchanged video is never asked about: a title edit costs no round trip.
  const same = runSaveLesson({ draft: { ...LESSON_ROW, title: 'Renamed' }, stored: [LESSON_S] });
  await same.run();
  assert.deepEqual(same.world.log, [['update', LESSON_S], ['closed']]);
  // lessonVideoInStorage, RUN: a signature is a yes; a refusal or a fault is a no.
  const proof = (sign) => new Function('signLessonVideo', `${moduleAsyncFn(appLF(), 'lessonVideoInStorage')}\nreturn lessonVideoInStorage;`)(sign);
  assert.equal(await proof(async () => ({ url: 'https://s.example/x', signedAt: 1 }))(LESSON_B), true);
  assert.equal(await proof(async () => { throw Object.assign(new Error('Object not found'), { status: 400 }); })(LESSON_B), false);
  assert.equal(await proof(async () => { throw new TypeError('Failed to fetch'); })(LESSON_B), false);
  // Inside the try (Save stops spinning) and before the write.
  const save = fnBody(appLF(), '  async function saveLesson() {');
  const guard = save.indexOf('!(await lessonVideoInStorage(payload.storage_path))');
  assert.ok(guard > save.indexOf('setSavingLesson(true)') && guard < save.indexOf(".from('course_lessons').update(payload)"),
    'proven before the row is written');
  assert.match(save,
    /if \(payload\.storage_path && payload\.storage_path !== oldPath\s*&& !\(await lessonVideoInStorage\(payload\.storage_path\)\)\) \{\s*refuseSave\([\s\S]{0,400}?\);\s*return;\s*\}/);
});

test('§19/§28c an upload whose check FAILED is swept when the editor SAVES — in both editors, never the saved file (AUI-1)', async () => {
  // ★ A REGRESSION FROM THE RESIDUE PASS (R5). Moving the discard after validation was right — a
  //   refused pick must never delete the verified upload the draft names — but an upload that FAILED
  //   its check is pending and named by nothing: after a refused pick and Dismiss the uploader is
  //   empty (no "Check again"), and Save dropped the only reference to it. Swept now, at save time.
  const lesson = runSaveLesson({ draft: { ...LESSON_ROW }, pending: LESSON_U, stored: [LESSON_S, LESSON_U] });
  await lesson.run();
  assert.deepEqual(lesson.world.log, [['update', LESSON_S], ['remove', LESSON_U], ['closed']],
    'the row keeps its video; the never-attached upload goes, reference-aware');
  assert.deepEqual([...lesson.world.stored], [LESSON_S]);
  assert.equal(lesson.pendingRef.current, null);
  // A video uploaded and then the lesson switched to Text: the upload goes too (the row's video goes,
  // as switching to Text always did).
  const text = runSaveLesson({ draft: { ...LESSON_ROW, type: 'text', text_content: 'Notes', storage_path: LESSON_B },
    pending: LESSON_B, stored: [LESSON_S, LESSON_B] });
  await text.run();
  assert.deepEqual(text.world.log, [['update', null], ['remove', LESSON_S], ['remove', LESSON_B], ['closed']]);
  // The upload the row now cites is never swept.
  const cited = runSaveLesson({ draft: { ...LESSON_ROW, storage_path: LESSON_B }, pending: LESSON_B, stored: [LESSON_S, LESSON_B] });
  await cited.run();
  assert.ok(!cited.world.log.some((e) => e[0] === 'remove' && e[1] === LESSON_B));
  // ── The Getting Started drawer: saveDraft, RUN.
  const admin = srcLF('GettingStartedVideoAdmin');
  const save = jsCode(statementFrom(admin, '  const saveDraft = async () => {', '\n  };'));
  // eslint-disable-next-line no-new-func
  const attachArgs = new Function(`${srcLF('onboardingAttachArgs')}\nreturn onboardingAttachArgs;`)();
  const SAVED = buildOnboardingVideoPath(V_A, U_1);
  const LEFT = buildOnboardingVideoPath(V_A, U_2);
  const NEW = buildOnboardingVideoPath(V_A, 'eeeeeeee-0000-4000-8000-00000000000e');
  const runSave = async ({ draftPath = SAVED, pending = null, answers = {} }) => {
    const st = { rpcs: [], swept: [], pendingRef: { current: pending } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('editor', 'draft', 'saveLockRef', 'uploadState', 'UPLOAD_STATES', 'blocksLessonSave', 'gsTextLength',
      'APP_ERROR_COPY', 'setSavingDraft', 'setEditorErr', 'supabase', 'setEditor', 'onboardingAttachArgs', 'mediaFactsRef',
      'pendingPathRef', 'onboardingUploadTarget', 'resetEditor', 'afterChange', 'console', 'appErrorCode', 'appErrorMessage',
      'reload', 'sweepOnboardingFile', `${save}\nreturn saveDraft;`)(
      { id: V_A, status: 'draft', saved: { title: 'T', description: '', transcript: '', storage_path: SAVED } },
      { id: V_A, title: 'T', description: '', transcript: '', storage_path: draftPath }, { current: false },
      UPLOAD_STATES.EMPTY, UPLOAD_STATES, blocksLessonSave, (t) => Array.from(String(t ?? '')).length, APP_ERROR_COPY,
      () => {}, () => {}, { rpc: async (name) => { st.rpcs.push(name); return answers[name] || { data: {}, error: null }; } },
      () => {}, attachArgs, { current: null }, st.pendingRef, (id) => ({ id }), () => {}, () => {}, { error() {} },
      appErrorCode, appErrorMessage, () => {}, (target, path, what) => st.swept.push([target.id, path, what]));
    await fn();
    return st;
  };
  const left = await runSave({ pending: LEFT });
  assert.deepEqual(left.swept, [[V_A, LEFT, 'an upload that was never attached']], 'swept through the draft\'s target, said why');
  assert.equal(left.pendingRef.current, null);
  assert.deepEqual((await runSave({ pending: SAVED })).swept, [], 'never the saved file — this bucket\'s discard checks no reference');
  const attached = await runSave({ draftPath: NEW, pending: NEW, answers: {
    admin_onboarding_video_attach_media: { data: { previous_storage_path: SAVED }, error: null } } });
  assert.deepEqual(attached.swept, [[V_A, SAVED, 'the file this upload replaced']], 'the replaced file — and never the one just attached');
  // The residue pass's rule still holds: a REFUSED pick discards nothing (§19's own test runs it).
  assert.ok(fnBody(uploaderBody().replace(/\r\n/g, '\n'), 'async function handlePick(').indexOf('await discardPending();')
    > fnBody(uploaderBody().replace(/\r\n/g, '\n'), 'async function handlePick(').indexOf('setWeightNote(describeVideoWeight('));
});

test('§28c a removal on the Getting Started screen is never silent (AUI-4)', async () => {
  // remove() RESOLVES { error } on a refusal — supabase-js never rejects it — so `.catch(() => {})` and
  // the uploader's try/catch were dead code: a refused or failed removal said nothing, anywhere, and
  // this bucket has no "unused files" panel to find what it left behind.
  const errors = [];
  // eslint-disable-next-line no-new-func
  const sweep = new Function('console', `${srcLF('sweepOnboardingFile')}\nreturn sweepOnboardingFile;`)(
    { error: (...a) => errors.push(a) });
  const removed = [];
  sweep({ discard: async (p) => { removed.push(p); } }, 'versions/a/b.mp4', 'the file this upload replaced');
  sweep({ discard: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } }, 'versions/c/d.mp4', 'an upload that was never saved');
  sweep({ discard: async () => { throw new TypeError('Failed to fetch'); } }, 'versions/e/f.mp4', 'the deleted version\'s file');
  sweep(null, 'versions/g/h.mp4', 'nothing');
  sweep({ discard: async () => { removed.push('NO PATH'); } }, null, 'nothing');
  await settleAll(); await settleAll();
  assert.deepEqual(removed, ['versions/a/b.mp4'], 'a target and a path, or nothing at all');
  assert.deepEqual(errors, [
    ['[getting-started-admin] an upload that was never saved could not be removed', 403],
    ['[getting-started-admin] the deleted version\'s file could not be removed', 'TypeError'],
  ], 'each failure logged with what it was and its status — never the opaque object name');
  // No removal on the screen is swallowed: every one goes through the helper.
  const code = gsAdminCode();
  assert.ok(!/\.catch\(\(\) => \{/.test(code), 'no best-effort catch that says nothing');
  assert.equal((code.match(/\.discard\(/g) || []).length, 1, 'discard() is called from the helper alone');
  assert.equal((jsCode(srcLF('GettingStartedVideoAdmin')).match(/sweepOnboardingFile\(/g) || []).length, 4,
    'the close sweep, the replaced file, the never-attached upload and the deleted version\'s file');
  // …and the uploader logs a discard that throws (its existing catch, now reachable).
  const body = uploaderBody().replace(/\r\n/g, '\n');
  const decl = statementFrom(body, '  const discardPending = useCallback(async () => {', '}, [savedPath, notePendingPath, target]);');
  const logged = [];
  // eslint-disable-next-line no-new-func
  const discardPending = new Function('useCallback', 'pendingPathRef', 'notePendingPath', 'signedRef', 'savedPath', 'target', 'console',
    `${decl}\nreturn discardPending;`)((f) => f, { current: 'versions/x/y.mp4' }, () => {}, { current: null }, null,
    { discard: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } }, { error: (...a) => logged.push(a) });
  await discardPending();
  assert.deepEqual(logged, [['[video-upload] an unsaved upload could not be removed', 403]]);
});

test('§28a the player names the bucket its signer signs in — in its log lines and in the admin\'s sentence (TDR-8, AUI-2)', async () => {
  const src = appLF();
  const at = src.indexOf('\nconst PRIVATE_VIDEO_SIGNERS = new Map([');
  assert.ok(at > 0, 'PRIVATE_VIDEO_SIGNERS was not found');
  const block = `${src.slice(at + 1, src.indexOf('\n]);', at) + 4)}\n${moduleBlock(src, 'PRIVATE_VIDEO_SIGNER_UNKNOWN')}`;
  const signLesson = async () => ({});
  const signOnboarding = async () => ({});
  // eslint-disable-next-line no-new-func
  const { map, unknown } = new Function('signLessonVideo', 'signOnboardingVideo', 'LESSON_VIDEO_BUCKET', 'ONBOARDING_VIDEO_BUCKET',
    `${block}\nreturn { map: PRIVATE_VIDEO_SIGNERS, unknown: PRIVATE_VIDEO_SIGNER_UNKNOWN };`)(
    signLesson, signOnboarding, LESSON_VIDEO_BUCKET, ONBOARDING_VIDEO_BUCKET);
  assert.equal(map.get(signLesson).log, `[${LESSON_VIDEO_BUCKET}]`);
  assert.equal(map.get(signOnboarding).log, `[${ONBOARDING_VIDEO_BUCKET}]`, 'a Getting Started failure is logged as one');
  assert.equal(map.get(signLesson).adminSignFailure, 'This lesson’s video file could not be authorized. Confirm the file is still in the '
    + 'course-videos bucket, and that the course is published for the plans that need it.', 'a lesson reads exactly as it did');
  const gs = map.get(signOnboarding).adminSignFailure;
  assert.ok(!/lesson|course/i.test(gs), `the Getting Started drawer is told about a lesson: ${gs}`);
  assert.match(gs, /Getting Started/);
  assert.ok(!/lesson|course|onboarding/i.test(unknown.adminSignFailure) && unknown.log === '[private-video]');
  assert.ok(Object.isFrozen(map.get(signLesson)) && Object.isFrozen(unknown));
  // sign(), RUN: the log lines and the admin's sentence come from the signer it was handed.
  const code = jsCode(signedVideo());
  const decl = statementFrom(code, 'const sign = useCallback(async (label, { quiet = false } = {}) => {', '}, [path, isAdmin, signUrl]);');
  const run = async (signUrl, { isAdmin = true, quiet = false } = {}) => {
    const st = { errors: [], warns: [], problem: null };
    // eslint-disable-next-line no-new-func
    const sign = new Function('useCallback', 'PRIVATE_VIDEO_SIGNERS', 'PRIVATE_VIDEO_SIGNER_UNKNOWN', 'signUrl', 'genRef', 'setState',
      'setProblem', 'path', 'signedAtRef', 'setSrc', 'console', 'isAdmin', 'mountedRef', 'onProblemRef', `${decl}\nreturn sign;`)(
      (f) => f, map, unknown, signUrl, { current: 1 }, () => {}, (p) => { st.problem = p; }, 'versions/a/b.mp4', { current: 0 },
      () => {}, { error: (...a) => st.errors.push(a), warn: (...a) => st.warns.push(a) }, isAdmin, { current: true }, { current: null });
    await sign(quiet ? 'refresh' : 'sign', { quiet });
    return st;
  };
  const failingOnboarding = async () => { throw Object.assign(new Error('Object not found'), { status: 400 }); };
  map.set(failingOnboarding, map.get(signOnboarding));
  const failed = await run(failingOnboarding);
  assert.deepEqual(failed.errors, [['[onboarding-videos]', 'sign failed', 400]]);
  assert.equal(failed.problem.message, gs, 'the drawer\'s admin sentence is the Getting Started one');
  assert.deepEqual((await run(failingOnboarding, { quiet: true })).warns, [['[onboarding-videos]', 'refresh failed; keeping the current URL', 400]]);
  const failingLesson = async () => { throw Object.assign(new Error('denied'), { status: 403 }); };
  map.set(failingLesson, map.get(signLesson));
  const lesson = await run(failingLesson);
  assert.deepEqual(lesson.errors, [['[course-videos]', 'sign failed', 403]]);
  assert.equal(lesson.problem.message, map.get(signLesson).adminSignFailure);
  assert.equal((await run(failingLesson, { isAdmin: false })).problem.message, 'This video isn’t loading right now.', 'a student\'s copy is unchanged');
  assert.deepEqual((await run(async () => { throw new TypeError('x'); })).errors, [['[private-video]', 'sign failed', 'TypeError']],
    'a signer the map does not know claims no bucket');
  assert.ok(!code.includes('[course-videos]'), 'no bucket is hard-coded into the player any more');
});

test('§28c a draft whose saved file is MISSING opens as missing — an empty uploader, no player, and a note that says so (AUI-2)', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const decl = statementFrom(admin, 'const openEditor = (v) => {', '\n  };');
  const open = (v) => {
    const st = {};
    // eslint-disable-next-line no-new-func
    new Function('pendingPathRef', 'readyPathRef', 'mediaFactsRef', 'setEditorErr', 'setUploadState', 'UPLOAD_STATES', 'setEditor',
      'setDraft', 'v', `${decl}\nopenEditor(v);`)(
      { current: 'x' }, { current: 'x' }, { current: 'x' }, () => {}, (s) => { st.upload = s; }, UPLOAD_STATES,
      (e) => { st.editor = e; }, (d) => { st.draft = d; }, v);
    return st;
  };
  const P = buildOnboardingVideoPath(V_A, U_1);
  const gone = open({ id: V_A, status: 'draft', title: 'T', storage_path: P, media_present: false });
  assert.equal(gone.upload, UPLOAD_STATES.EMPTY, 'the uploader opens empty, ready for the file again — never "Video uploaded ✓"');
  assert.deepEqual([gone.editor.missing, gone.editor.status, gone.editor.saved.storage_path], [true, 'draft', P],
    'the row still names the path: an attach replaces it, and the server sweeps nothing it does not know');
  const there = open({ id: V_A, status: 'draft', title: 'T', storage_path: P, media_present: true });
  assert.deepEqual([there.upload, there.editor.missing], [UPLOAD_STATES.SAVED_AND_PLAYABLE, false]);
  const unknownFact = open({ id: V_A, status: 'draft', title: 'T', storage_path: P });
  assert.deepEqual([unknownFact.upload, unknownFact.editor.missing], [UPLOAD_STATES.SAVED_AND_PLAYABLE, false],
    'only an explicit false: a missing fact is not a missing file');
  assert.deepEqual([open({ id: V_A, title: 'T', storage_path: null }).upload, open({ id: V_A, title: 'T' }).editor.status],
    [UPLOAD_STATES.EMPTY, 'draft']);
  // The uploader and the player read it.
  assert.match(admin,
    /const uploaderValue = useMemo\(\(\) => \{\s*const usable = editor\?\.saved\.storage_path && !editor\.missing \? editor\.saved\.storage_path : null;\s*return \{ storage_path: usable, video_provider: usable \? 'upload' : null, video_url: null \};\s*\}, \[editor\?\.saved\.storage_path, editor\?\.missing\]\);/);
  assert.match(admin,
    /const savedFileGone = !!\(editor\?\.missing && \(!draft\?\.storage_path \|\| draft\.storage_path === editor\.saved\.storage_path\)\);/);
  assert.match(admin, /const drawerLesson = useMemo\(\(\) => \(editorId && draft\?\.storage_path && !savedFileGone\s*\?/,
    'no player for a file that would only fail to sign');
  assert.match(admin, /\{savedFileGone \? \(\s*<p [^>]*>\s*This draft’s saved video file is missing from storage, so it can’t be previewed or published\. Upload the video again\.\s*<\/p>/);
});

test('§28c the LIVE version\'s and a RETIRED version\'s words can be corrected without a new version (AUI-5)', async () => {
  // The database allows it — update_details refuses only a deleted version, and the guard permits text
  // edits in any status — but the screen offered Edit on drafts alone, so a typo in the live title meant
  // New video, a re-upload of the same file and Replace, and "Not finished" for everyone who had.
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const liveCard = admin.slice(admin.indexOf('<section ref={liveRef}'), admin.indexOf('</section>', admin.indexOf('<section ref={liveRef}')));
  assert.match(liveCard, /<button type="button" onClick=\{\(\) => openEditor\(live\)\} className=\{btn\} style=\{GS_SECONDARY_BTN\}>\s*<Pencil size=\{14\} aria-hidden="true" \/> Edit details/);
  const history = admin.slice(admin.indexOf('{history.map((v) => ('));
  const retired = history.slice(history.indexOf("{v.status === 'retired' ? ("), history.indexOf('</li>', history.indexOf("{v.status === 'retired' ? (")));
  assert.match(retired, /onClick=\{\(\) => openEditor\(v\)\}[^>]*>\s*<Pencil size=\{14\} aria-hidden="true" \/> Edit details/,
    'a retired version too — never a deleted one (the server refuses it)');
  // The editor of a version that has been live: words only, and it says why.
  assert.match(admin, /\{editor\.status === 'draft' \? \(\s*<div className="space-y-3">\s*<LessonVideoUploader /,
    'the uploader is a draft\'s alone — attach_media takes no other');
  assert.match(admin, /'A version’s file can’t change once it has been live\. To show students a different video, use Replace\.'/);
  assert.match(admin, /'A version’s file can’t change once it has been live\. To use a different video, start a New video\.'/);
  assert.match(admin, /subtitle=\{GS_EDITOR_SUBTITLE\[editor\.status\] \|\| GS_EDITOR_SUBTITLE\.draft\}/);
  // eslint-disable-next-line no-new-func
  const subtitles = new Function(`${moduleBlock(appLF(), 'GS_EDITOR_SUBTITLE')}\nreturn GS_EDITOR_SUBTITLE;`)();
  assert.equal(subtitles.draft, 'A draft. Students see nothing until you publish it.', 'a draft reads as it did');
  assert.match(subtitles.published, /Students see these details as soon as you save them\./, 'the live version says who its words reach');
  assert.match(subtitles.retired, /only if you publish it again/);
  assert.match(admin, /editor && editor\.status !== 'draft' \? 'Save details' : 'Save draft'/);
  // saveDraft, RUN for each status: the live version's words ask for the admin's own answer again.
  const save = jsCode(statementFrom(admin, 'const saveDraft = async () => {', '\n  };'));
  const P = buildOnboardingVideoPath(V_A, U_1);
  const run = async (status, title) => {
    const st = { rpcs: [], changed: [] };
    // eslint-disable-next-line no-new-func
    const fn = new Function('editor', 'draft', 'saveLockRef', 'uploadState', 'UPLOAD_STATES', 'blocksLessonSave', 'gsTextLength',
      'APP_ERROR_COPY', 'setSavingDraft', 'setEditorErr', 'supabase', 'setEditor', 'onboardingAttachArgs', 'mediaFactsRef',
      'pendingPathRef', 'onboardingUploadTarget', 'resetEditor', 'afterChange', 'console', 'appErrorCode', 'appErrorMessage',
      'reload', 'sweepOnboardingFile', `${save}\nreturn saveDraft;`)(
      { id: V_A, status, saved: { title: 'Welcome', description: '', transcript: '', storage_path: P } },
      { id: V_A, title, description: '', transcript: '', storage_path: P }, { current: false },
      UPLOAD_STATES.SAVED_AND_PLAYABLE, UPLOAD_STATES, blocksLessonSave, (t) => Array.from(String(t ?? '')).length, APP_ERROR_COPY,
      () => {}, () => {}, { rpc: async (name, args) => { st.rpcs.push([name, args]); return { data: {}, error: null }; } },
      () => {}, () => ({}), { current: null }, { current: null }, () => ({}), () => {}, (...a) => st.changed.push(a),
      { error() {} }, appErrorCode, appErrorMessage, () => {}, () => {});
    await fn();
    return st;
  };
  const live = await run('published', 'Welcome to the toolkit');
  assert.deepEqual(live.rpcs, [['admin_onboarding_video_update_details',
    { p_video_id: V_A, p_title: 'Welcome to the toolkit', p_description: '', p_transcript: '' }]], 'its words only — never a file');
  assert.deepEqual(live.changed, [['ok', 'Saved “Welcome to the toolkit”. Students see the new details now.', 'top', true]],
    'and the admin\'s own card and tab are asked for again (T9V-M1)');
  assert.deepEqual((await run('retired', 'Old welcome')).changed, [['ok', 'Saved “Old welcome”.', 'top', false]]);
  assert.deepEqual((await run('draft', 'A draft')).changed, [['ok', 'Saved “A draft”.', 'top', false]]);
  assert.deepEqual((await run('published', 'Welcome')).changed, [['ok', 'Saved “Welcome”.', 'top', false]],
    'nothing changed, nothing to ask again');
});

test('§28c a refused publish reads the list again, and its words fit a publish as well as an attach (AUI-6)', async () => {
  const copy = APP_ERROR_COPY.ONBOARDING_VIDEO_MEDIA_INVALID;
  assert.match(copy, /no longer in storage/, 'what a publish meets: the file vanished after the list loaded');
  assert.match(copy, /in a draft’s editor, or as a new video/, 'a way forward for a draft AND for "Publish again" on a retired version');
  assert.ok(!/attached to this draft/.test(copy), 'not an attach-only sentence: a publish has no draft to attach to');
  assert.match(copy, /Nothing was changed\.$/, 'saveDraft strips this ending when the details had landed first (T9V-L4)');
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const rc = statementFrom(admin, 'const runConfirm = async (work) => {', '\n  };');
  const run = async (error) => {
    const st = { reloads: 0, err: '' };
    // eslint-disable-next-line no-new-func
    const runConfirm = new Function('confirmLockRef', 'setConfirmBusy', 'setConfirmErr', 'console', 'appErrorCode', 'appErrorMessage',
      'reload', `${rc}\nreturn runConfirm;`)({ current: false }, () => {}, (e) => { st.err = e; }, { error() {} }, appErrorCode,
      appErrorMessage, () => { st.reloads += 1; });
    await runConfirm(async () => { throw error; });
    return st;
  };
  const coded = (code) => ({ code: 'P0001', message: 'x', hint: code, details: JSON.stringify({ code, context: null }) });
  for (const code of ['ONBOARDING_VIDEO_MEDIA_INVALID', 'ONBOARDING_VIDEO_NOT_FOUND', 'ONBOARDING_VIDEO_STATE_INVALID']) {
    const st = await run(coded(code));
    assert.equal(st.reloads, 1, `${code}: the list is out of date — read it again so the row says what changed`);
    assert.equal(st.err, APP_ERROR_COPY[code]);
  }
  for (const error of [coded('FORBIDDEN'), coded('ONBOARDING_VIDEO_TEXT_INVALID'), new TypeError('Failed to fetch')]) {
    assert.equal((await run(error)).reloads, 0, `${error.hint || error.name}: nothing about the list changed`);
  }
});

test('§28c a retired version whose file is missing SAYS why it cannot be published again (AUI-7)', () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const row = admin.slice(admin.indexOf('{history.map((v) => ('), admin.indexOf('</details>'));
  assert.match(row,
    /\{v\.status === 'retired' && v\.storage_path && v\.media_present === false \? \(\s*<p [^>]*>\s*File missing from storage, so it can’t be published again\. To use this video, upload it as a new video\.\s*<\/p>\s*\) : null\}/,
    'the Drafts row says "File missing from storage"; a retired row used to lose "Publish again" with no reason given');
  assert.match(row, /\{hasFile\(v\) \? \(\s*<button type="button" onClick=\{\(\) => requestPublish\(v\)\}/, 'Publish again only while the file is there');
});

test('§28c a Replace is bound to the live version its dialog NAMED — a stale one is asked again, never retried (DBSEC-1)', async () => {
  const admin = jsCode(srcLF('GettingStartedVideoAdmin'));
  const decl = statementFrom(admin, 'const confirmReplace = () => runConfirm(async () => {', '\n  });');
  const run = async (answer, confirm) => {
    const st = { rpcs: [], confirms: [], reloads: 0, changes: [] };
    // eslint-disable-next-line no-new-func
    const fn = new Function('runConfirm', 'confirm', 'supabase', 'appErrorCode', 'appErrorContext', 'setConfirm', 'reload',
      'afterChange', `${decl}\nreturn confirmReplace;`)(
      (work) => work(), confirm, { rpc: async (name, args) => { st.rpcs.push([name, args]); return answer; } },
      appErrorCode, appErrorContext, (c) => st.confirms.push(c), () => { st.reloads += 1; }, (...a) => st.changes.push(a));
    await fn();
    return st;
  };
  const L1 = { id: V_A, title: 'Welcome v1' };
  const D = { id: V_B, title: 'Welcome v2' };
  const ok = await run({ data: { ok: true, replaced_video_id: V_A }, error: null }, { kind: 'replace', version: D, live: L1 });
  assert.deepEqual(ok.rpcs, [['admin_onboarding_video_publish', { p_video_id: V_B, p_replace_live: true, p_expected_live_id: V_A }]],
    'the version the dialog NAMED, frozen when it opened');
  assert.deepEqual([ok.confirms, ok.changes.length], [[null], 1]);
  const refused = (context) => ({
    data: null,
    error: { code: 'P0001', message: 'x', hint: 'ONBOARDING_VIDEO_REPLACE_CONFIRM', details: JSON.stringify({ code: 'ONBOARDING_VIDEO_REPLACE_CONFIRM', context }) },
  });
  const moved = await run(refused({ live_id: U_1, live_title: 'Published elsewhere', expected_live_id: V_A }),
    { kind: 'replace', version: D, live: L1 });
  assert.deepEqual(moved.confirms, [{ kind: 'replace', version: D, live: { id: U_1, title: 'Published elsewhere' }, raced: true }],
    'another version went live: asked again, naming what is live NOW — and the next press sends THAT id');
  assert.deepEqual([moved.rpcs.length, moved.reloads, moved.changes.length], [1, 1, 0], 'never retried, the list read again, nothing reported done');
  const gone = await run(refused({ live_id: null, live_title: null, expected_live_id: V_A }), { kind: 'replace', version: D, live: L1 });
  assert.deepEqual(gone.confirms, [{ kind: 'publish', version: D, raced: true }], 'nothing live any more: a plain publish, asked again');
  await assert.rejects(run({ data: null, error: { code: '57014', message: 'canceling statement' } }, { kind: 'replace', version: D, live: L1 }),
    (e) => e.code === '57014', 'any other refusal is the dialog\'s error, as before');
  // The dialog's words name the SAME frozen version the handler sends — never a newer overview's.
  const branch = admin.slice(admin.indexOf("} else if (confirm.kind === 'replace') {"), admin.indexOf("} else if (confirm.kind === 'unpublish') {"));
  assert.match(branch, /publishImpact\(\{ live: confirm\.live, target: v,/);
  assert.ok(!/confirm\.live \|\| live/.test(admin), 'no fallback to the latest overview: it would say one version and retire another');
  assert.match(decl, /const named = confirm\.live;/);
  const pub = admin.slice(admin.indexOf("if (confirm.kind === 'publish') {"), admin.indexOf("} else if (confirm.kind === 'replace') {"));
  assert.match(pub, /warning=\{confirm\.raced \? 'The video this was going to replace is no longer live, so publishing now replaces nothing\.' : ''\}/,
    'a publish that USED to be a replace says why it changed under the admin\'s focus (T9UI-5\'s alert)');
});

test('§28c a bulk decision says what became of EVERY email — and waits out a "not now" rather than dropping it (EMAIL-1)', async () => {
  const enroll = jsCode(srcLF('AdminEnrollments'));
  const helper = statementFrom(enroll, 'const decisionEmail = async (payload, name) => {', '\n  };');
  const runDecl = statementFrom(enroll, 'const runBulk = async () => {', '\n  };');
  const sAt = enroll.indexOf('const emailSuffix = (mail) => ');
  const tAt = enroll.indexOf('const emailTally = (results) => {');
  // eslint-disable-next-line no-new-func
  const { emailSuffix, emailTally } = new Function(`${enroll.slice(sAt, enroll.indexOf(';\n', sAt) + 1)}\n`
    + `${enroll.slice(tAt, enroll.indexOf('\n  };', tAt) + 5)}\nreturn { emailSuffix, emailTally };`)();
  const NAMES = { r2: 'Maria Santos', r4: '  ' };   // r4's request carries no name
  const ROWS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map((id) => ({ id, email: `typed-${id}@example.test`, full_name: NAMES[id] ?? `Student ${id}` }));
  const run = async (kind, answers, finalize = () => ({ data: { already: false }, error: null })) => {
    const st = { bulk: { kind, batchId: '', reason: 'Proof unreadable', running: false, results: [] }, posts: [], waits: [], waiting: [] };
    const setBulk = (f) => { st.bulk = typeof f === 'function' ? f(st.bulk) : f; if (st.bulk?.waiting) st.waiting.push(st.bulk.waiting); };
    const chain = { update: () => chain, eq: () => chain, select: async () => ({ data: [{ id: 'x' }], error: null }) };
    const env = {
      notifyDecision: async (payload) => { st.posts.push(payload.requestId); return answers[payload.requestId].shift(); },
      setBulk, setTimeout: (fn, ms) => { st.waits.push(ms); fn(); }, BULK_EMAIL_RETRY_DELAYS_MS: [20_000, 40_000],
      bulk: st.bulk, selectedRows: ROWS.filter((r) => answers[r.id]), holds: {},
      supabase: { rpc: async (name, args) => finalize(args.p_request_id), from: () => chain },
      user: { id: 'me' }, console: { error() {} }, appErrorMessage, setSelected: () => {}, window: { dispatchEvent: () => {} },
      Event: class {}, FINANCE_LEDGER_CHANGE_EVENT: 'x', onCountChange: () => {}, load: () => {},
    };
    // eslint-disable-next-line no-new-func
    const runBulk = new Function(...Object.keys(env), `${helper}\n${runDecl}\nreturn runBulk;`)(...Object.values(env));
    await runBulk();
    return st;
  };
  const RATE = { ok: false, unclear: false, rateLimited: true };
  const st = await run('approve', {
    r1: [{ ok: true, id: 'e1' }],
    r2: [RATE, { ok: true, id: 'e2' }],
    r3: [{ ok: false, unclear: true }],
    r4: [RATE, RATE, RATE],
    r5: [{ ok: false, skipped: 'in_flight' }],
    r6: [],
    r7: [],
  }, (id) => (id === 'r6' ? { data: { already: true }, error: null }
    : id === 'r7' ? { data: null, error: { code: 'P0001', message: 'admin_finalize_enrollment: request not found' } }
      : { data: { already: false }, error: null }));
  const said = Object.fromEntries(st.bulk.results.map((x) => [x.id, `${x.ok ? '✓' : '✕'} ${x.note}${x.mail ? emailSuffix(x.mail) : ''}`]));
  assert.deepEqual(said, {
    r1: '✓ approved · email sent',
    r2: '✓ approved · email sent',
    r3: '✓ approved · email may not have been sent',
    r4: '✓ approved · email not sent',
    r5: '✓ approved · email already on its way',
    r6: '✓ already approved',
    r7: `✕ ${APP_ERROR_COPY.REQUEST_NOT_FOUND}`,
  }, 'every row says what became of its email — not fifteen green ticks over refused emails');
  assert.deepEqual(st.posts, ['r1', 'r2', 'r2', 'r3', 'r4', 'r4', 'r4', 'r5'], 'a "not now" is asked again — at most twice');
  assert.deepEqual(st.waits, [20_000, 20_000, 40_000], 'waited out, the server\'s minute in two steps');
  assert.deepEqual([...new Set(st.waiting.map((w) => w.name))], ['Maria Santos', ''],
    'and the dialog says which request it is waiting on — by the name on it (K3R-AE-1)…');
  assert.ok(!JSON.stringify(st.waiting).includes('@'),
    '…never the address typed on the request: the email goes to the ACCOUNT\'s address, which may differ');
  assert.equal(st.bulk.waiting, null, '…until it is not');
  assert.equal(emailTally(st.bulk.results), 'Emails: 2 sent, 1 already on its way, 1 may not have been sent, 1 not sent.',
    'in one fixed order — the run goes newest first, and arrival order reads as noise');
  assert.equal(emailTally([...st.bulk.results].reverse()), emailTally(st.bulk.results), 'whatever order the rows ran in');
  assert.equal(emailTally([{ ok: true, note: 'on hold' }]), '', 'no email, no tally');
  assert.equal(emailTally([{ ok: true, note: 'approved', mail: { ok: false, skipped: 'email_not_configured' } }]), 'Emails: 1 not configured.');
  const rejected = await run('reject', { r1: [{ ok: true }], r2: [RATE, { ok: false, unclear: true }] });
  assert.deepEqual(rejected.bulk.results.map((x) => `${x.note}${emailSuffix(x.mail)}`), ['rejected · email sent', 'rejected · email may not have been sent']);
  assert.deepEqual(rejected.posts, ['r1', 'r2', 'r2'], 'a rejection\'s "not now" is waited out too');
  assert.deepEqual([...new Set(rejected.waiting.map((w) => w.name))], ['Maria Santos'], 'under the request\'s name, never its typed address');
  // The dialog promises what happens, and the list shows each row's email.
  assert.ok(!/and the student is emailed\./.test(enroll) && !/'Each student is emailed this reason and can resubmit\.'/.test(enroll),
    'no promise the run cannot keep');
  assert.match(enroll, /the list says what became of every email/);
  assert.match(enroll, /<span style=\{\{ color: C\.textMute \}\}>\{x\.note\}\{x\.mail \? emailSuffix\(x\.mail\) : ''\}<\/span>/);
  assert.match(enroll, /\$\{emailTally\(bulk\.results\) \? ` \$\{emailTally\(bulk\.results\)\}` : ''\}/);
  // ★ K3R-AE-1: the wait line names no typed address and blames no provider. The 429 it waits out is THIS
  //   app's own limit on decision emails; the email service's own refusal arrives as 502 resend_429 and is
  //   recorded, never waited out. RENDERED from the dialog's own template.
  const waitLine = /\? (`Working… \$\{bulk\.results\.length\} of \$\{targets\.length\}\. Pausing[^\n]*`)\n/.exec(enroll);
  assert.ok(waitLine, 'the bulk dialog\'s wait line was not found');
  // eslint-disable-next-line no-new-func
  const sayWait = (name) => new Function('bulk', 'targets', `return ${waitLine[1]};`)({ results: [1, 2, 3], waiting: { name } }, { length: 7 });
  assert.equal(sayWait('Maria Santos'),
    'Working… 3 of 7. Pausing for this app’s own limit on decision emails — the email for Maria Santos’s request is asked for again in a moment.');
  assert.equal(sayWait(''),
    'Working… 3 of 7. Pausing for this app’s own limit on decision emails — the email for the request it just decided is asked for again in a moment.');
  assert.ok(!/email service asked to slow down|before emailing \$\{bulk\.waiting\}/.test(enroll), 'the old line — a typed address, the wrong culprit — is gone');
  // eslint-disable-next-line no-new-func
  assert.deepEqual(new Function(`${moduleConst(appLF(), 'BULK_EMAIL_RETRY_DELAYS_MS')}\nreturn BULK_EMAIL_RETRY_DELAYS_MS;`)(), [20_000, 40_000]);
});

test('§28c the Enrollments badge says an alert MAY not have been sent when the provider gave no clear answer (EMAIL-4)', () => {
  const enroll = jsCode(srcLF('AdminEnrollments'));
  const meta = enroll.slice(enroll.indexOf('const NOTIFY_META = {'), enroll.indexOf('};', enroll.indexOf('const NOTIFY_META = {')));
  assert.match(meta, /provider_unclear: +\{ label: 'Review alert may not have been sent', tone: 'warn' \},/,
    'api/notify-enrollment.js records provider_unclear for a timeout, a dropped connection or a 5xx — an unknown status rendered no badge at all');
  assert.match(meta, /provider_error: +\{ label: 'Review alert not sent — provider', +tone: 'danger' \},/, 'a definite refusal is unchanged');
  assert.match(enroll, /request\.notify_status === 'provider_unclear'\s*\? 'The email provider gave no clear answer, so the enrollment review alert may or may not have reached the configured administrator\.'/);
});

test('§T12B an admin tab waits for my_staff_context, and its refusal is a ROLE answer that sells nothing (T12B-D1)', () => {
  // eslint-disable-next-line no-new-func
  const view = new Function('ADMIN_TAB_PERMISSION', `${srcLF('tabAccessView')}\nreturn tabAccessView;`)(ADMIN_TAB_PERMISSION);
  const ids = Object.keys(ADMIN_TAB_PERMISSION);
  assert.ok(ids.length >= 9 && ids.includes('gettingstartedadmin'));
  for (const id of ids) {
    for (const adminAllowed of [true, false]) {
      for (const planAllows of [true, false]) {
        assert.equal(view(id, { settled: false, adminAllowed, planAllows }), 'checking',
          `${id} before the answer: neither the screen (admitted to nobody) nor a refusal (flashed at a real administrator)`);
      }
    }
    assert.equal(view(id, { settled: true, adminAllowed: true, planAllows: true }), 'panel');
    assert.equal(view(id, { settled: true, adminAllowed: false, planAllows: true }), 'role', `${id}: a plan never opens an admin screen`);
    assert.equal(view(id, { settled: true, adminAllowed: false, planAllows: false }), 'role');
    assert.equal(view(id, { settled: true, adminAllowed: true, planAllows: false }), 'role', 'an admin tab\'s refusal is never a plan upsell');
  }
  for (const id of ['dashboard', 'qbomastery', 'community', 'gettingstarted', 'progress', 'constructor', '__proto__']) {
    assert.equal(view(id, { settled: false, adminAllowed: true, planAllows: true }), 'panel', `${id} never waits on the staff context`);
    assert.equal(view(id, { settled: false, adminAllowed: true, planAllows: false }), 'plan', `${id}: the plan upsell, as before`);
  }
  // The chokepoint asks it, and renders each answer.
  const root = jsCode(rootSource());
  assert.match(root,
    /const view = tabAccessView\(tabId, \{\s*settled: staffReady \|\| staffDegraded,\s*adminAllowed: adminTabAllowed\(tabId\),\s*planAllows: entitlement\.allowsTab\(tabId\),\s*\}\);/);
  assert.match(root, /if \(view === 'panel'\) \{\s*return \(\s*<TabPanel\s+key=\{tabId\}/);
  assert.match(root, /if \(view === 'checking'\) return <TabAccessCheck key=\{tabId\} active=\{tabId === tab\} \/>;/);
  assert.match(root, /return <RestrictedTab key=\{tabId\} active=\{tabId === tab\} goto=\{setTab\} reason=\{view\} \/>;/);
  assert.ok(!/entitlement\.allowsTab\(tabId\) && adminTabAllowed\(tabId\) \?/.test(root), 'the old two-way test is gone');
  // The role refusal sells nothing, and says who to ask.
  const rt = jsCode(srcLF('RestrictedTab'));
  assert.match(rt, /^function RestrictedTab\(\{ active, goto, reason = 'plan' \}\) \{/, 'a plan refusal by default — every other caller is unchanged');
  const roleAt = rt.indexOf("if (reason === 'role') {");
  assert.ok(roleAt > 0, 'the role branch was not found');
  assert.ok(rt.indexOf('useContext(EntitlementContext)') < roleAt && rt.indexOf('const { staff } = useAuth();') < roleAt,
    'every hook above the early return');
  const role = rt.slice(roleAt, rt.indexOf('\n  }\n', roleAt));
  assert.ok(!/setPanelParam|Upgrade|renew|Crown|plan yet|Dashboard membership panel/i.test(role),
    'no billing call to action: no purchase opens an admin screen');
  assert.match(role, /Your account can’t open this screen/);
  assert.match(role, /your role — <span[^>]*>\{roleLabel\}<\/span> — doesn’t include it\. If you need it, ask a Super Admin\./);
  assert.match(role, /'It’s an admin screen for the team that runs the toolkit, and no membership plan includes it\.'/);
  assert.match(role, /const roleLabel = staff\?\.isStaff && staff\.status === 'active' \? staff\.roleLabel : null;/);
  assert.match(role, /onClick=\{\(\) => goto\('dashboard'\)\}[\s\S]*?Back to Dashboard/);
  assert.match(role, /hidden=\{!active\} aria-hidden=\{!active\}/, 'hidden with its tab, as the plan refusal is');
  assert.ok(rt.slice(rt.indexOf('\n  }\n', roleAt)).includes('This tool isn’t part of your plan yet'), 'the plan upsell is unchanged');
  const check = jsCode(srcLF('TabAccessCheck'));
  assert.match(check, /hidden=\{!active\} aria-hidden=\{!active\}/);
  assert.match(check, /role="status"/);
  assert.match(check, /Checking your access…/);
  assert.ok(!/Upgrade|plan|refus/i.test(check), 'neutral: nothing is decided yet');
});
