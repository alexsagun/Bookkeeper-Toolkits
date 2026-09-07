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
  const body = src.slice(i, src.indexOf('\nfunction resumableUploadEndpoint', i));
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
  const i = src.indexOf('function renderVideo(lesson)');
  assert.ok(i > 0, 'renderVideo was not found');
  const textBranch = src.slice(i, src.indexOf("video_provider === 'upload'", i));
  assert.ok(!/course-stage/.test(textBranch),
    'the type === "text" branch must not render a media stage — its prose and its '
    + '"No content yet." card would sit in a black video box');
  assert.ok(/lessonUsesMediaStage\(activeLesson\)/.test(src),
    'renderLearner must gate the full-bleed stage slot on lessonUsesMediaStage');
});

test('only course tabs get the wide canvas, and only the max-width is conditional', () => {
  const src = app();
  const m = /const WIDE_CANVAS_TABS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'WIDE_CANVAS_TABS was not found');
  const ids = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.ok(ids.length > 0 && ids.length <= 3, 'this is a course exception, not a redesign');
  for (const id of ids) {
    assert.ok(['qbomastery', 'resumestrategy', 'interview'].includes(id),
      `${id} does not host a course catalog`);
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

test('"Upload anyway" walks real transitions instead of inventing one', () => {
  const body = fnBody(uploaderBody(), 'function uploadAnyway(');
  for (const ev of ['SELECT_FILE', 'VALIDATE_START', 'VALIDATE_OK']) {
    assert.match(body, new RegExp(`UPLOAD_EVENTS\\.${ev}`),
      `UNSUPPORTED_FILE reaches UPLOADING only via ${ev} — do not add a transition`);
  }
  assert.match(body, /acknowledgedRef\.current = true/);
});

test('an acknowledged file is not re-blocked AFTER its upload finishes', () => {
  const body = fnBody(uploaderBody(), 'async function verifyPrivateObject(');
  assert.match(body, /acknowledgedRef\.current && \(e\?\.code === 3 \|\| e\?\.code === 4\)/,
    'this probe runs in the SAME browser that already said it cannot decode this codec. '
    + 'Warning at pick time, then refusing twenty minutes later on the answer we already '
    + 'predicted, is worse than never having offered the choice');
  assert.match(body, /await confirmSignedObject\(url, expectedBytes\);/,
    'presence, authorization and byte-completeness are still proven for every file');
  assert.ok(body.indexOf('confirmSignedObject') < body.indexOf('acknowledgedRef.current &&'),
    'the existence/size check must run BEFORE any leniency, never be skipped by it');
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
