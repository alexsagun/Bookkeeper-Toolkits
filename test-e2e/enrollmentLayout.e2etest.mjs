// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/enrollmentLayout.e2etest.mjs — the Enrollments request card, MEASURED.
// ─────────────────────────────────────────────────────────────────────────────
// On 2026-09-24 the card that decides whether a payment unlocks the toolkit rendered the
// student's identity at 0px on every common laptop with the sidebar open, and the package
// and amount painted over the phone number. Every static test passed, and the card had no
// horizontal overflow — so "does it scroll sideways?" said it was fine. This suite loads
// the real app against the shadow project, signs in as real staff personas, and measures
// the geometry an admin actually sees:
//
//   • the four regions (who / plan / status / actions) never intersect;
//   • no region's text paints outside that region;
//   • identity keeps at least min(240px, the card's content width);
//   • no control sits outside its card, and the card never overflows;
//   • the actions sit below the head, never beside it;
//   • expanded intake answers are never truncated;
//
// across 9 viewports × sidebar open/collapsed × light/dark × 125/150/200% zoom × every
// request and membership filter, plus role checks: an Operations Admin sees the cards,
// and a Trainer or a student deep-linking to /admin/enrollments triggers no admin query.
//
// Run with `npm run test:e2e`. Needs .env.test (docs/db/shadow-project.md) and Chrome.
// Screenshots land in test-e2e/.artifacts/enrollments/ for review; they are evidence,
// not a pixel baseline — fonts and anti-aliasing differ between machines, geometry
// does not.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { launchChrome } from './_cdp.mjs';
import { skipReason, startApp, signIn, injectSession } from './_app.mjs';
import { REPO_ROOT } from '../scripts/_shadow.mjs';
import { measureCards, sampleSidebarTransition } from './_enrollmentProbe.mjs';
import {
  STUDENTS, ensureEnrollmentPersonas, seedEnrollmentFixtures, cleanupEnrollmentFixtures,
} from './_enrollmentFixtures.mjs';

const SKIP = skipReason();
const ART = join(REPO_ROOT, 'test-e2e', '.artifacts', 'enrollments');
const VIEWPORTS = [[320, 568], [375, 667], [390, 844], [768, 1024], [1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080]];
const FILTERS = ['Pending', 'On hold', 'Follow-up due', 'Overdue', 'Renewals', 'Upgrades', 'Extensions',
  'Approved', 'Rejected', 'Expired', 'Active', 'Expiring', 'In grace', 'Ended'];
const ADMIN_LOADER = /\/rest\/v1\/enrollment_requests\?.*status=(eq|neq)\.pending_review/;

let app; let browser; let personas;
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (SKIP) return;
  personas = await ensureEnrollmentPersonas();
  await seedEnrollmentFixtures(personas);
  app = await startApp();
  browser = await launchChrome();
});

after(async () => {
  if (SKIP) return;
  await browser?.close();
  app?.stop();
  await cleanupEnrollmentFixtures();
});

async function openAs(user, path, { railCollapsed = false } = {}) {
  const page = await browser.newPage();
  const session = await signIn(user.email);
  await injectSession(page, session, { railCollapsed });
  await page.setViewport({ width: 1440, height: 900 });
  await page.setMedia({ colorScheme: 'dark' });
  await page.goto(app.url + path, { timeoutMs: 180000 });
  return page;
}

async function clickFilter(page, label) {
  // ★ Some chips appear a moment AFTER the cards: "On hold" and "Follow-up due" exist only
  //   once the holds query (a second request, after the list) has answered. One look raced
  //   that request and failed a correct page; retry for a few seconds before calling it absent.
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) {
    ok = await page.evaluate((l) => {
      // A chip reads '<label><count>', e.g. 'Pending8' or 'Expiring ≤ 14d1'.
      const b = [...document.querySelectorAll('button')].find((x) => {
        const t = x.textContent.trim().replace(/\d+$/, '').trim();
        return t === l || t.startsWith(`${l} `);
      });
      if (!b) return false;
      b.click();
      return true;
    }, label);
    if (!ok) await tick(200);
  }
  await tick(200);
  return ok;
}

async function setSidebar(page, collapsed) {
  const now = await page.evaluate(() => !!document.querySelector('[aria-label="Expand sidebar"]'));
  if (now !== collapsed) {
    await page.evaluate((c) => document.querySelector(c ? '[aria-label="Collapse sidebar"]' : '[aria-label="Expand sidebar"]')?.click(), collapsed);
    await tick(400);
  }
}

test('the Enrollments card never collapses, overlaps or clips — every width, sidebar, theme, zoom and filter', { skip: SKIP || false, timeout: 20 * 60 * 1000 }, async () => {
  const page = await openAs(personas.staff.superAdmin, '/admin/enrollments');
  await page.waitFor(() => document.querySelectorAll('.enroll-card').length > 0, [], { timeoutMs: 180000, what: 'the first enrollment card' });

  const failures = [];
  const layouts = [];
  for (const [w, h] of VIEWPORTS) {
    for (const collapsed of w >= 1024 ? [false, true] : [false]) layouts.push({ w, h, zoom: 1, collapsed });
  }
  for (const zoom of [1.25, 1.5, 2]) layouts.push({ w: 1280, h: 720, zoom, collapsed: false });
  layouts.push({ w: 1280, h: 720, zoom: 1.25, collapsed: true });

  const narrowest = {};
  for (const L of layouts) {
    await page.setViewport({ width: L.w, height: L.h, zoom: L.zoom });
    await tick(250);
    if (L.w / L.zoom >= 1024) await setSidebar(page, L.collapsed);
    const tag = `${L.w}x${L.h}${L.zoom !== 1 ? `@${L.zoom * 100}%` : ''} sidebar=${L.w / L.zoom >= 1024 ? (L.collapsed ? 'rail' : 'open') : 'drawer'}`;
    for (const theme of ['dark', 'light']) {
      await page.setMedia({ colorScheme: theme });
      for (const f of FILTERS) {
        assert.ok(await clickFilter(page, f), `the "${f}" filter chip was not found`);
        const cards = await page.evaluate(measureCards);
        // Every filter has a fixture, so an empty view means the page failed, not that there
        // was nothing to measure — a suite that measures zero cards passes vacuously.
        if (!cards.length) failures.push(`${tag} ${theme} [${f}]: no cards rendered`);
        for (const c of cards) {
          for (const p of c.problems) failures.push(`${tag} ${theme} [${f}] ${c.name}: ${p}`);
          narrowest[tag] = Math.min(narrowest[tag] ?? Infinity, c.identityW);
        }
      }
      await clickFilter(page, 'Pending');
      await page.screenshot(join(ART, `${tag.replace(/[^a-z0-9@%x=]+/gi, '_')}-${theme}.png`));
    }
  }

  // Expanded details on the longest request: answers wrap, never truncate.
  for (const [w, h] of [[320, 568], [768, 1024], [1024, 768], [1440, 900]]) {
    await page.setViewport({ width: w, height: h });
    await tick(250);
    if (w >= 1024) await setSidebar(page, false);
    await clickFilter(page, 'Pending');
    const opened = await page.evaluate((needle) => {
      const card = [...document.querySelectorAll('.enroll-card')].find((c) => c.textContent.includes(needle));
      const btn = card && [...card.querySelectorAll('button[aria-controls]')].find((b) => /Details/.test(b.textContent));
      if (!btn) return false;
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
      return true;
    }, STUDENTS[0].name.slice(0, 20));
    assert.ok(opened, 'the Details toggle of the long fixture was not found');
    await tick(250);
    const expanded = await page.evaluate((needle) => {
      const card = [...document.querySelectorAll('.enroll-card')].find((c) => c.textContent.includes(needle));
      const btn = card.querySelector('button[aria-controls]');
      const target = document.getElementById(btn.getAttribute('aria-controls'));
      return { ariaExpanded: btn.getAttribute('aria-expanded'), targetVisible: !!(target && !target.hidden && target.getClientRects().length),
        answers: card.querySelectorAll('[data-enroll-intake-value]').length };
    }, STUDENTS[0].name.slice(0, 20));
    assert.equal(expanded.ariaExpanded, 'true');
    assert.ok(expanded.targetVisible, 'aria-controls must name the panel that opened');
    assert.ok(expanded.answers >= 6, 'the intake answers did not render');
    for (const c of await page.evaluate(measureCards)) for (const p of c.problems) failures.push(`${w}x${h} expanded ${c.name}: ${p}`);
    await page.screenshot(join(ART, `expanded-${w}x${h}.png`), '.enroll-card[aria-label*="Maria"]');
    await page.evaluate((needle) => {
      const card = [...document.querySelectorAll('.enroll-card')].find((c) => c.textContent.includes(needle));
      card.querySelector('button[aria-controls]').click();
    }, STUDENTS[0].name.slice(0, 20));
  }

  const problems = page.problems.filter((p) => p.kind === 'exception' || (p.kind === 'console.error' && !/favicon/i.test(p.text)));
  await page.close();
  console.log('narrowest identity per layout (px):', JSON.stringify(narrowest));
  assert.deepEqual(failures, [], `layout failures:\n  ${failures.slice(0, 60).join('\n  ')}`);
  assert.deepEqual(problems, [], 'the page raised errors while being measured');
});

// NEGATIVE CONTROL. A layout check that cannot fail proves nothing, and the pre-fix commit is
// no use as one: it has no `.enroll-card`, so a suite run against it fails on "no card
// rendered" — which it would do for any reason at all. Instead, re-create the ORIGINAL defect
// inside the fixed page (the actions back in an `auto` track beside a `minmax(0,1fr)`
// identity, in a grid that switches on the viewport) and require the probe to report it.
test('negative control: the probe catches the original defect when it is put back', { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
  const page = await openAs(personas.staff.superAdmin, '/admin/enrollments');
  await page.waitFor(() => document.querySelectorAll('.enroll-card').length > 0, [], { timeoutMs: 180000, what: 'the first enrollment card' });
  const MUTANT = `@media (min-width: 1024px) {
    .enroll-card { display: grid !important; grid-template-columns: minmax(0, 1fr) auto !important; column-gap: 16px; align-items: center; }
    .enroll-card__actions { margin-top: 0 !important; }
  }`;
  for (const [w, h] of [[1024, 768], [1280, 720]]) {
    await page.setViewport({ width: w, height: h });
    await tick(250);
    await setSidebar(page, false);
    await clickFilter(page, 'Pending');
    const clean = (await page.evaluate(measureCards)).flatMap((c) => c.problems);
    assert.deepEqual(clean, [], `${w}: the unmutated card must measure clean`);
    await page.evaluate((css) => { const s = document.createElement('style'); s.id = 'e2e-mutant'; s.textContent = css; document.head.appendChild(s); }, MUTANT);
    await tick(250);
    const caught = (await page.evaluate(measureCards)).flatMap((c) => c.problems);
    await page.evaluate(() => document.getElementById('e2e-mutant')?.remove());
    assert.ok(caught.some((p) => /^identity \d+px/.test(p) || /beside the head/.test(p) || /paints outside/.test(p)),
      `${w}: the re-created defect went unreported — the probe cannot see what it exists to catch. Got: ${caught.slice(0, 5).join(' | ') || 'nothing'}`);
  }
  await page.close();
});

// The card has to be readable WHILE the sidebar animates, not only after, and a reload has to
// render the persisted sidebar state with the same card. Only the sidebar changes here: same
// persona, route, data, filter and theme.
test('the card stays readable during the sidebar animation, after a reload in either state, and focus stays on the toggle', { skip: SKIP || false, timeout: 10 * 60 * 1000 }, async () => {
  const page = await openAs(personas.staff.superAdmin, '/admin/enrollments');
  await page.waitFor(() => document.querySelectorAll('.enroll-card').length > 0, [], { timeoutMs: 180000, what: 'the first enrollment card' });
  const failures = [];

  for (const [w, h] of [[1024, 768], [1280, 720], [1366, 768], [1440, 900]]) {
    await page.setViewport({ width: w, height: h });
    await tick(250);
    await clickFilter(page, 'Pending');
    await setSidebar(page, false);
    for (const label of ['Collapse sidebar', 'Expand sidebar']) {
      const s = await page.evaluate(sampleSidebarTransition, label);
      if (s.error) { failures.push(`${w}: ${s.error}`); continue; }
      if (s.frames < 5) failures.push(`${w} ${label}: only ${s.frames} frames sampled`);
      if (s.asideFrom === s.asideTo) failures.push(`${w} ${label}: the sidebar never changed width`);
      for (const f of s.bad) failures.push(`${w} ${label} @${f.ms}ms sidebar=${f.asideW}px: identity ${f.identityW}px of ${f.contentW}px${f.overlap ? ', regions overlap' : ''}`);
      await tick(200);
    }
  }

  // Keyboard: the toggle is two different buttons (one in the header, one in the rail), so
  // pressing one unmounts it. Focus must land on its counterpart, not on <body>.
  await page.setViewport({ width: 1280, height: 720 });
  await setSidebar(page, false);
  for (const [label, other] of [['Collapse sidebar', 'Expand sidebar'], ['Expand sidebar', 'Collapse sidebar']]) {
    const focusAfter = await page.evaluate(async (l) => {
      const b = document.querySelector(`[aria-label="${l}"]`);
      b.focus();
      b.click();
      await new Promise((r) => setTimeout(r, 450));
      const a = document.activeElement;
      return a && a !== document.body ? (a.getAttribute('aria-label') || a.tagName) : 'BODY';
    }, label);
    if (focusAfter !== other) failures.push(`after "${label}" focus went to ${focusAfter}, not "${other}"`);
  }

  // Reload with each persisted state: the state must survive, and the card must be clean.
  for (const collapsed of [true, false]) {
    await setSidebar(page, collapsed);
    await tick(800);   // the rail state is persisted through window.storage on change
    const loaded = page.once('Page.loadEventFired', 180000);
    await page.send('Page.reload', {});
    await loaded;
    await page.waitFor(() => document.querySelectorAll('.enroll-card').length > 0, [], { timeoutMs: 180000, what: 'cards after reload' });
    await tick(500);
    const asideW = await page.evaluate(() => Math.round(document.querySelector('aside').getBoundingClientRect().width));
    const want = collapsed ? 76 : 288;
    if (asideW !== want) failures.push(`reload with the sidebar ${collapsed ? 'collapsed' : 'open'}: sidebar is ${asideW}px, expected ${want}px`);
    for (const c of await page.evaluate(measureCards)) for (const p of c.problems) failures.push(`reload ${collapsed ? 'rail' : 'open'} ${c.name}: ${p}`);
  }

  const problems = page.problems.filter((p) => p.kind === 'exception');
  await page.close();
  assert.deepEqual(failures, [], `failures:\n  ${failures.join('\n  ')}`);
  assert.deepEqual(problems, [], 'the page threw while the sidebar moved');
});

test('an Operations Admin reviews the same cards, without the Super-Admin-only Email action', { skip: SKIP || false, timeout: 5 * 60 * 1000 }, async () => {
  const page = await openAs(personas.staff.ops, '/admin/enrollments');
  await page.waitFor(() => document.querySelectorAll('.enroll-card').length > 0, [], { timeoutMs: 180000, what: 'cards for the Ops Admin' });
  await page.setViewport({ width: 1280, height: 720 });
  await tick(300);
  const view = await page.evaluate(() => ({
    cards: document.querySelectorAll('.enroll-card').length,
    email: [...document.querySelectorAll('.enroll-card button')].some((b) => b.textContent.trim() === 'Email'),
    approve: [...document.querySelectorAll('.enroll-card button')].some((b) => b.textContent.trim() === 'Approve'),
  }));
  assert.ok(view.cards >= 8, `expected the 8 pending fixtures, saw ${view.cards}`);
  assert.equal(view.approve, true, 'an Operations Admin holds enrollments.review and must be able to approve');
  assert.equal(view.email, false, 'emailing a student is communications.send — Super Admin only (#61)');
  const cards = await page.evaluate(measureCards);
  assert.deepEqual(cards.flatMap((c) => c.problems.map((p) => `${c.name}: ${p}`)), []);
  await page.close();
});

for (const [label, pick] of [
  ['a Trainer', () => personas.staff.trainer],
  ['a paying student', () => personas.students['enroll-active']],
]) {
  test(`${label} deep-linking to /admin/enrollments sees no card and triggers no admin query`, { skip: SKIP || false, timeout: 5 * 60 * 1000 }, async () => {
    const page = await openAs(pick(), '/admin/enrollments');
    // Wait until the app has settled on SOMETHING (a gate screen, a restricted tab or the shell).
    // ★ Return a BOOLEAN. A DOM node cannot cross CDP by value, so returning the element made
    //   every poll throw — which waitFor swallows — and the test timed out on a page that was fine.
    try {
      await page.waitFor(() => !!document.querySelector('main, [role="main"], h1, h2'), [], { timeoutMs: 180000, what: 'the app shell' });
    } catch (e) {
      const where = await page.evaluate(() => ({ path: location.pathname, title: document.title,
        headings: [...document.querySelectorAll('h1,h2')].map((h) => h.textContent.trim().slice(0, 40)).slice(0, 3) })).catch(() => null);
      throw new Error(`${e.message}; the page was at ${JSON.stringify(where)}`);
    }
    await tick(4000);
    const cards = await page.evaluate(() => document.querySelectorAll('.enroll-card').length);
    assert.equal(cards, 0, `${label} rendered enrollment cards`);
    const leaked = page.requests.filter((r) => ADMIN_LOADER.test(r.url || ''));
    assert.deepEqual(leaked.map((r) => `${r.method} ${r.url.replace(/\?.*$/, '?…')}`), [],
      `${label} fired the admin enrollment queries — the screen mounted before authorization`);
    await page.close();
  });
}
