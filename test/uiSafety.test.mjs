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
