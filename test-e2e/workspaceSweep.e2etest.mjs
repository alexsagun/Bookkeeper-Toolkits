// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/workspaceSweep.e2etest.mjs — every route, sidebar open AND collapsed.
// ─────────────────────────────────────────────────────────────────────────────
// The Enrollments card collapsed only when the sidebar was open, because its layout
// switched on the VIEWPORT (`lg:`) while the sidebar took 212px more of it than the rail
// does. Any tab can make the same mistake, so this walks the whole route table as a Super
// Admin (who can open every tab), including each tab's own sections (Financial
// Management's eight, Communications', Meetings', Progress'), at the two laptop widths
// where the sidebar costs the most, in both sidebar states, and runs the generic detector
// in test-e2e/_layoutSweep.mjs. Only the sidebar and the viewport change; the account,
// data and theme do not.
//
// The sweep itself clicks nothing that saves: navigation is history.pushState + popstate
// (the app's own Back/Forward path), and section switchers only change which section
// renders. Mounting a tab can still write what that tab writes on mount — Enrollments runs
// expire_overdue_subscriptions(), Community marks a channel read — which is why this runs
// only against the shadow project.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { launchChrome } from './_cdp.mjs';
import { skipReason, startApp, signIn, injectSession } from './_app.mjs';
import { REPO_ROOT } from '../scripts/_shadow.mjs';
import { extractLiteral } from '../scripts/_elevenlabs.mjs';
import { ensureEnrollmentPersonas, seedEnrollmentFixtures, cleanupEnrollmentFixtures } from './_enrollmentFixtures.mjs';
import { detectLayoutDefects, sectionLabels, clickSection } from './_layoutSweep.mjs';

const SKIP = skipReason();
const LAYOUTS = [
  { w: 1024, h: 768, collapsed: false }, { w: 1024, h: 768, collapsed: true },
  { w: 1280, h: 720, collapsed: false }, { w: 1280, h: 720, collapsed: true },
  // A phone: the sidebar is the off-canvas drawer, closed, and the tab owns the whole width.
  // The shared SectionHead band used to overhang it by 24px and scroll every page sideways.
  { w: 390, h: 844, collapsed: null },
];
// A redirect alias, not a screen of its own (it renders InterviewPrep's mock sub-tab).
const ALIASES = new Set(['mockinterview']);

let app; let browser; let personas;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (SKIP) return;
  personas = await ensureEnrollmentPersonas();
  await seedEnrollmentFixtures(personas);   // so the admin lists are not empty
  app = await startApp();
  browser = await launchChrome();
});

after(async () => {
  if (SKIP) return;
  await browser?.close();
  app?.stop();
  await cleanupEnrollmentFixtures();
});

async function setSidebar(page, collapsed) {
  const now = await page.evaluate(() => !!document.querySelector('[aria-label="Expand sidebar"]'));
  if (now !== collapsed) {
    await page.evaluate((c) => document.querySelector(c ? '[aria-label="Collapse sidebar"]' : '[aria-label="Expand sidebar"]')?.click(), collapsed);
    await tick(450);   // the 300ms width transition, and a frame to settle
  }
}

test('no route collapses, stacks or overlaps its content with the sidebar open or collapsed', { skip: SKIP || false, timeout: 45 * 60 * 1000 }, async () => {
  const routes = extractLiteral(readFileSync(join(REPO_ROOT, 'src/BookkeeperPro.jsx'), 'utf8'), 'TAB_ROUTES');
  const page = await browser.newPage();
  const session = await signIn(personas.staff.superAdmin.email);
  await injectSession(page, session, { railCollapsed: false });
  await page.setViewport({ width: 1280, height: 720 });
  await page.setMedia({ colorScheme: 'dark' });
  await page.goto(`${app.url}/`, { timeoutMs: 240000 });
  // A BOOLEAN — a DOM node cannot cross CDP by value, and waitFor swallows the throw.
  await page.waitFor(() => !!document.querySelector('main [aria-hidden="false"]'), [], { timeoutMs: 240000, what: 'the dashboard' });

  const failures = [];
  const visited = [];
  const check = async (where) => {
    for (const L of LAYOUTS) {
      await page.setViewport({ width: L.w, height: L.h });
      await tick(200);
      if (L.collapsed !== null) await setSidebar(page, L.collapsed);
      const r = await page.evaluate(detectLayoutDefects, { pageOnly: L.collapsed === null });
      const tag = `${where} @${L.w} ${L.collapsed === null ? 'phone' : L.collapsed ? 'rail' : 'open'}`;
      if (r.error) failures.push(`${tag}: ${r.error}`);
      for (const d of r.defects || []) failures.push(`${tag}: ${d}`);
    }
  };

  for (const [id, path] of Object.entries(routes)) {
    if (ALIASES.has(id)) continue;
    await page.setViewport({ width: 1280, height: 720 });
    await setSidebar(page, false);
    await page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);
    await tick(2500);   // data loads after the tab mounts; measure what an admin sees, not the skeleton
    visited.push(id);
    await check(id);
    for (const label of await page.evaluate(sectionLabels)) {
      if (!(await page.evaluate(clickSection, label))) continue;
      await tick(1500);
      await check(`${id} › ${label}`);
    }
  }

  const thrown = page.problems.filter((p) => p.kind === 'exception');
  await page.close();
  console.log(`swept ${visited.length} routes: ${visited.join(', ')}`);
  assert.ok(visited.length >= 40, `only ${visited.length} routes were swept — the route table was not read`);
  assert.deepEqual(failures, [], `layout defects:\n  ${failures.slice(0, 80).join('\n  ')}`);
  assert.deepEqual(thrown, [], 'a route threw while it was being swept');
});
