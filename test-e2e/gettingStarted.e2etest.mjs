// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/gettingStarted.e2etest.mjs — the Getting Started video (#69), in a real browser.
// ─────────────────────────────────────────────────────────────────────────────
// The real app, served by Vite against the SHADOW project (E2E_APP_ROOT may serve another
// checkout), with every mail/AI/Zoom key pinned dead by _app.mjs. A clip is recorded in this
// Chrome and published by a Super Admin's OWN session — the admin RPCs and the bucket's storage
// policies, the real authorization path — and then every kind of account signs in:
//
//   0. the Super Admin publishes the recorded clip (create draft → upload → attach → publish),
//      and while it is live the guard the other suites run refuses them;
//   1. an approved student whose first term is newer than the first publish meets the video
//      INSTEAD of the Dashboard. Its answer is held back until every other read the gate waits on
//      has landed, so for a while the gate waits on #69 alone — and the Dashboard never renders
//      first. Go to dashboard stays aria-disabled — never `disabled`, not while locked
//      and not while the completion is being recorded — with its hint until the clip has really
//      played: 90% of it, measured at a quarter of normal speed so that boundary is resolved to
//      about 2% of the clip. A keyboard reaches and presses it; the accessibility tree names it
//      and says it is disabled; the unlock is announced once; it lands on the Dashboard with no
//      first-login welcome on top, and the server has the completion;
//   2. the gate fits 390×844, 1280×800, 1366×657 and 1440×900 in light and dark — no sideways
//      scroll, no overlapping boxes, Go and the progress line in view on a laptop (and the probe
//      that says so is shown each failure first, a negative control); the keyboard reaches Go and
//      the accessibility tree reads it on a phone in dark mode too; its player signs the video
//      1–2 times per mount (StrictMode) and never asks for a public URL; the answer is read once
//      per sign-in; and a skip to the end does not unlock it;
//   3. a student who finished it goes straight to the Dashboard; the card says Completed, and a
//      replay played to the end leaves completed_at alone;
//   4. a replay in a hidden keep-alive tab stops — the SAME <video>, paused where it was — in the
//      tab page and in the card, each player signing 1–2 times per mount; and the sidebar lists
//      Getting Started directly above Dashboard, open and as the rail;
//   5. unpaid and pending students get the paywall and the pending screen, and no video;
//   6. a migrated student: account setup → the summary (whose button now reads "Continue") →
//      Getting Started, where a press INSIDE the server's floor is refused on screen and records
//      nothing → the Dashboard once the floor has passed;
//   7. expired and scheduled members get their own screens, never the video;
//  7b. a lapsed member whose term read is slow is still asked ONCE — the T12-D1 regression check:
//      the read is held until BOTH the gate's answer and the member's profile have landed — the
//      window that bug needs — and a run in which that window never opened fails, never passes;
//   8. an Operations Admin and a Trainer — each holding a paid term newer than the first publish —
//      are never held, have no Getting Started Video admin row or link, are refused the admin
//      screen's address without it running (and still refused a moment later), send no
//      admin_onboarding_video_* RPC, and the manager overview refuses their JWT — all of it read
//      only once the page knows their role: before that, EVERY staff member is shown no admin
//      row and refused every admin tab;
//   9. the Super Admin — holding such a term too, so only the staff exclusion keeps them off the
//      gate — is never held, the Dashboard card shows the manager's view, and (test 8's controls)
//      their first Administration row IS the screen and the root DOES ask for its badge;
//  10. a member whose first term predates the first publish is never held (the cutoff; a plain
//      payment-sourced member, so NOT edge (a)'s migrated student — the dbtest pins that) — and still
//      gets the first-login welcome, which proves `welcomed: false` really leaves it unseen;
//  11. the Dashboard card, closed and open, and the Getting Started tab fit a phone, a 1024 and a
//      1280 window with the sidebar open and as the rail, light and dark — no sideways scroll, no
//      box outside its surface, no overlap, no squeezed or letter-stacked text, no covered
//      control (and that probe, too, is shown each failure first);
//  12. with the video unpublished nobody is held, and only a manager is told why. ★ KEEP IT
//      AFTER 0–11: it takes test 0's video down;
//  13. then, with nothing live, the Super Admin's first Administration row says the video needs
//      attention (on screen and to a screen reader, open and as the rail); they publish a new one
//      THROUGH THE SCREEN — New video, a title, the editor, the real uploader given the clip
//      through its <input type=file>, Save draft, Publish and its confirmation — and the badge
//      clears; every write is read back as postgres; a student approved after that publish meets
//      THIS video; and it is taken down again. ★ KEEP IT LAST.
//
// ★ A LIVE VIDEO LEFT ON SHADOW BREAKS OTHER SUITES: every student persona they seed would meet
//   this screen. before() AND after() call resetOnboardingVideos(); legacyMigration.e2etest.mjs
//   refuses to start while one is live. And after() first STOPS tests 0 and 13 — the two that
//   write — and waits for whatever they already started (see "Stopping test 0"): node:test does
//   not stop a test body that times out, so a publish still in flight would otherwise land on the
//   shadow after() just cleaned.
// ★ NEVER PRINT A SIGNED URL OR A TOKEN. Pages return measurements; request URLs are counted, and
//   printed only with their query string cut off (a signed URL's token lives there).
//
// Run: node --test --test-concurrency=1 test-e2e/gettingStarted.e2etest.mjs
// Needs .env.test (docs/db/shadow-project.md) and Chrome. Screenshots and an evidence file land in
// test-e2e/.artifacts/getting-started/.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { launchChrome } from './_cdp.mjs';
import { E2E_PASSWORD, ensureUsers, injectSession, lit, runSql, shadowEnv, signIn, skipReason, startApp } from './_app.mjs';
import {
  assertNoLiveOnboardingVideo, clientFor, liveOnboardingVideoCount, publishOnboardingVideo, recordClip,
  resetOnboardingVideos,
} from './_onboarding.mjs';
import { REPO_ROOT } from '../scripts/_shadow.mjs';
import { extractLiteral } from '../scripts/_elevenlabs.mjs';
import {
  ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS, ONBOARDING_MIN_ELAPSED_FRACTION, ONBOARDING_NEAR_END_SECONDS,
  ONBOARDING_UNKNOWN_DURATION_SECONDS, ONBOARDING_WATCH_MIN_FRACTION, formatVideoDuration,
} from '../src/lib/gettingStarted.js';

const SKIP = skipReason();
const NONCE = randomBytes(3).toString('hex');
const ART = join(REPO_ROOT, 'test-e2e', '.artifacts', 'getting-started');
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const LAPTOPS = [[1280, 800], [1366, 657], [1440, 900]];
const PHONE = [390, 844];
// In the app shell the room a tab gets depends on the sidebar as much as on the window: 1024 is
// where the open sidebar costs the most (a 726px workspace), 1280 the common laptop, and below
// `lg` the sidebar is the off-canvas drawer, so a phone has one layout only.
const SHELL_SIZES = [[1280, 800], [1024, 768], PHONE];
// Keep-alive: a replay played this slowly outlasts the wait for its pause several times over,
// so "paused" can only mean the app paused it — never that the clip ran out.
const SLOW_RATE = 0.1;
const PAUSE_WAIT_MS = 10000;
// The gate's clip, played at a quarter of normal speed. Chrome fires timeupdate about every 250 ms
// of WALL time — the watch rule is evaluated on those samples — so at 1× a 3 s clip is sampled
// every ~8% of its length, and a rule unlocking anywhere from ~82% to 90% picks the very sample
// the real 90% rule picks. At 0.25× the samples are ~2% apart, and the boundary is resolved.
const GATE_RATE = 0.25;
// Test 6 plays the clip fast, so its button unlocks quickly; the press it then makes inside the
// server's floor is refused by the server's own elapsed guard.
const FAST_RATE = 8;
const ADMIN_SCREEN_PATH = '/admin/getting-started-video';
const VIDEO = {
  title: `Welcome to Toolkits (e2e ${NONCE})`,
  description: 'A short tour of the toolkit, recorded by the rendered suite.',
  transcript: 'Hello and welcome.\nThis is the Getting Started video the rendered suite recorded.',
};

// Every persona is an `e2e-gs-` account: that prefix is what cleanup keys on. Auth users are
// kept between runs (GoTrue rate-limits their creation); every row they own is removed.
const PERSONAS = [
  { label: 'gs-super', fullName: 'Grace Superadmin' },
  { label: 'gs-ops', fullName: 'Oscar Operations' },
  { label: 'gs-trainer', fullName: 'Tessa Trainer' },
  { label: 'gs-new', fullName: 'Gia Novak' },            // 1 — approved, not finished
  { label: 'gs-layout', fullName: 'Liza Mendoza' },      // 2 — the gate, measured
  { label: 'gs-done', fullName: 'Dana Reyes' },          // 3, 4, 11 — finished it
  { label: 'gs-unpaid', fullName: 'Una Cruz' },          // 5 — no request yet
  { label: 'gs-pending', fullName: 'Pia Lim' },          // 5 — payment under review
  { label: 'gs-import', fullName: 'Ina Villanueva' },    // 6 — migrated, term starts now
  { label: 'gs-expired', fullName: 'Eli Santos' },       // 7
  { label: 'gs-scheduled', fullName: 'Sol Garcia' },     // 7
  { label: 'gs-existing', fullName: 'Ezra Tan' },        // 10 — first term predates the publish
  { label: 'gs-late', fullName: 'Lara Bautista' },       // 13 — approved after the Super Admin's own publish
];

let app; let browser; let people; let clip; let video;
const sessions = new Map();
const EVIDENCE = { nonce: NONCE, appRoot: process.env.E2E_APP_ROOT ? 'E2E_APP_ROOT' : 'repo', steps: {} };
const note = (step, facts) => { EVIDENCE.steps[step] = { ...(EVIDENCE.steps[step] || {}), ...facts }; };

// ── Stopping test 0 ──────────────────────────────────────────────────────────────────────────
// ★ node:test DOES NOT STOP A TEST BODY THAT TIMES OUT. It aborts the test's t.signal and moves
//   on — to the next test and, at the end, to after() — while the body keeps running (shown in a
//   scratch run: a timed-out body wrote 1.2 s after after() had finished). Test 0 is the body that
//   WRITES what no other suite may find: a published video, and the persona terms. So every write
//   it makes first asks halt(), which throws once the test has timed out (t.signal) or after() has
//   begun (`stopping`); and after() waits for whatever test 0 already started — a request in
//   flight is let finish, never abandoned, because an abandoned request can still commit on the
//   server, AFTER the reset — before it resets the shadow. Every request test 0 makes has a
//   deadline (publishOnboardingVideo's requestTimeoutMs), which is what bounds that wait.
// ★ TEST 13 WRITES TOO — through the Super Admin's screen: a draft, an upload, a publish — so it
//   follows the same rule (its own halt() before every one, its work in `screenWork`), and
//   after() waits for both.
let stopping = false;
let publishWork = null;
let screenWork = null;
const PUBLISH_SETTLE_MS = 90000;

/** Wait for `promise` to settle, for at most `ms` → 'settled' | 'timed-out' | 'nothing-in-flight'. */
async function settleWithin(promise, ms) {
  if (!promise) return 'nothing-in-flight';
  let timer;
  const outcome = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise((r) => { timer = setTimeout(() => r('timed-out'), ms); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

/**
 * One minted session per persona, reused while it has ten minutes or more left. An access token
 * lasts an hour; a run once came back from a sleeping laptop with every cached token expired, and
 * a page restoring an expired session signs nobody in.
 */
async function sessionFor(person) {
  const cached = sessions.get(person.label);
  if (cached && (cached.expires_at || 0) * 1000 - Date.now() > 10 * 60 * 1000) return cached;
  const fresh = await signIn(person.email);
  sessions.set(person.label, fresh);
  return fresh;
}
const ids = (...labels) => labels.map((l) => `${lit(people[l].id)}::uuid`).join(', ');

/** Remove every row the e2e-gs- personas own, and put their profiles back to a plain signup. */
async function cleanupPersonas() {
  await runSql(`do $clean$
    declare v_ids uuid[];
    begin
      select coalesce(array_agg(id), '{}') into v_ids from auth.users where email like 'e2e-gs-%@shadow.test';
      delete from public.batch_entitlements where user_id = any(v_ids);
      delete from public.enrollment_requests where user_id = any(v_ids);
      delete from public.subscriptions where user_id = any(v_ids);
      begin
        delete from public.staff_memberships where user_id = any(v_ids);
      exception when others then
        -- staff_memberships_guard refuses to remove the LAST active Super Admin: keep ours then.
        delete from public.staff_memberships where user_id = any(v_ids)
           and not (role_key = 'super_admin' and status = 'active');
      end;
      update public.profiles
         set is_paid = false, approval_status = 'approved', account_origin = 'signup',
             onboarding_status = 'none', onboarding_completed_at = null
       where id = any(v_ids);
    end $clean$;`);
}

/**
 * Does the checkout being served route the Super Admin's screen? Read from ITS OWN source: the
 * suite may be pointed (E2E_APP_ROOT) at a snapshot taken before that screen existed, where the
 * address names no tab and the app sends it to the Dashboard.
 */
function servedTreeRoutesAdminScreen() {
  const root = process.env.E2E_APP_ROOT || REPO_ROOT;
  const routes = extractLiteral(readFileSync(join(root, 'src', 'BookkeeperPro.jsx'), 'utf8'), 'TAB_ROUTES');
  return routes.gettingstartedadmin === ADMIN_SCREEN_PATH;
}

/**
 * Which of these personas' FIRST subscription row is newer than the first publish → { id: bool }.
 * That is the gate's own cohort test, so for staff holding such a term only the staff exclusion
 * can make `required` false.
 */
async function firstTermAfterFirstPublish(...labels) {
  const rows = await runSql(`select u.id::text as id,
      coalesce((select min(s.created_at) from public.subscriptions s where s.user_id = u.id)
        > (select min(v.published_at) from public.onboarding_videos v), false) as after
    from unnest(array[${ids(...labels)}]) as u(id)`);
  return Object.fromEntries((rows || []).map((r) => [r.id, r.after === true]));
}

// ── In-page probes (SELF-CONTAINED: they run through page.evaluate / waitFor) ────────────────

/**
 * Installed before any app script: when each screen FIRST appears, and every change of the
 * gate's polite live region. Measurements only.
 */
function watchScreens() {
  if (location.protocol !== 'http:') return;
  const marks = { gate: null, shell: null, welcome: null };
  const probes = {
    gate: '.gs-stage[data-gs-mode="gate"]',
    shell: 'nav[aria-label="Main navigation"]',
    welcome: '#welcome-overlay-title',
  };
  const live = [];
  let lastLive = null;
  const check = () => {
    const t = Math.round(performance.now());
    for (const k of Object.keys(probes)) {
      if (marks[k] === null && document.querySelector(probes[k])) marks[k] = t;
    }
    const region = document.querySelector('main.gs-surface [role="status"][aria-live="polite"]');
    if (region && region.textContent !== lastLive) {
      lastLive = region.textContent;
      live.push({ t, text: lastLive });
    }
  };
  window.__gsWatch = { marks, live };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
}
const WATCH = `(${watchScreens.toString()})();`;

const watchState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__gsWatch || null)));

function onDashboard() {
  if (location.pathname !== '/') return false;
  if (!document.querySelector('nav[aria-label="Main navigation"]')) return false;
  const panel = [...document.querySelectorAll('main [aria-hidden="false"]')].find((el) => !el.hidden);
  return !!panel && [...panel.querySelectorAll('h1')].some((h) => /Get Hired With Alex/.test(h.textContent));
}

function onGettingStartedTab() {
  if (location.pathname !== '/getting-started') return false;
  const panel = [...document.querySelectorAll('main [aria-hidden="false"]')].find((el) => !el.hidden);
  return !!panel && !!panel.querySelector('.gs-stage[data-gs-mode="page"]');
}

/** Resolves once every FINITE running animation has finished, then two frames. */
function settleAnimations() {
  const finite = document.getAnimations().filter((a) => {
    const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
    return a.playState === 'running' && t && t.iterations !== Infinity;
  });
  return Promise.all(finite.map((a) => a.finished.catch(() => null)))
    .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
}

/**
 * The gate's geometry: sideways scroll, boxes painting outside the window, overlapping sibling
 * boxes anywhere in the gate's column, and — on a laptop — Go to dashboard and the progress line
 * in view without scrolling, with nothing covering the button.
 */
function measureGate({ fold }) {
  const main = document.querySelector('main.gs-surface');
  if (!main) return { error: 'no gate <main>' };
  const column = main.parentElement;
  const scroller = main.closest('.overflow-y-auto');
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = window.innerHeight;
  const out = [];
  const say = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${text}"`;
  };
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.classList.contains('sr-only');
  };
  if (de.scrollWidth > de.clientWidth + 1) out.push(`the page scrolls sideways by ${de.scrollWidth - de.clientWidth}px`);
  if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
    out.push(`the gate scrolls sideways by ${scroller.scrollWidth - scroller.clientWidth}px`);
  }
  const all = [column, ...column.querySelectorAll('*')].filter(shown);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.left < -1 || r.right > vw + 1) out.push(`${say(el)} paints outside the window (${Math.round(r.left)}…${Math.round(r.right)} of ${vw}px)`);
  }
  for (const parent of all) {
    const kids = [...parent.children].filter((k) => shown(k) && !/absolute|fixed/.test(getComputedStyle(k).position));
    if (kids.length < 2) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = rects[i]; const b = rects[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) out.push(`${say(kids[i])} and ${say(kids[j])} overlap by ${Math.round(ox)}x${Math.round(oy)}px`);
      }
    }
  }
  const go = main.querySelector('[data-gs-go]');
  const hint = go && document.getElementById(go.getAttribute('aria-describedby') || '');
  const stage = main.querySelector('.gs-stage');
  const gr = go && go.getBoundingClientRect();
  const hr = hint && hint.getBoundingClientRect();
  const sr = stage && stage.getBoundingClientRect();
  if (!go) out.push('no Go to dashboard button');
  if (!hint) out.push('Go to dashboard names no hint (aria-describedby) while it is locked');
  if (fold && go && hint) {
    if (scroller && scroller.scrollTop !== 0) out.push(`the gate was already scrolled by ${scroller.scrollTop}px`);
    for (const [label, r] of [['Go to dashboard', gr], ['the progress line', hr]]) {
      if (r.top < 0 || r.bottom > vh) out.push(`${label} needs scrolling (${Math.round(r.top)}…${Math.round(r.bottom)} of a ${vh}px window)`);
    }
    // Hit-testing only means something inside the window; off-screen is reported above.
    const cy = gr.top + gr.height / 2;
    if (cy >= 0 && cy <= vh) {
      const at = document.elementFromPoint(gr.left + gr.width / 2, cy);
      if (!at || !go.contains(at)) out.push(`Go to dashboard is covered at its centre by ${at ? say(at) : 'nothing'}`);
    }
  }
  return {
    problems: [...new Set(out)].slice(0, 40),
    theme: de.getAttribute('data-theme'),
    vw, vh,
    go: gr ? { top: Math.round(gr.top), bottom: Math.round(gr.bottom), width: Math.round(gr.width) } : null,
    hint: hr ? { top: Math.round(hr.top), bottom: Math.round(hr.bottom) } : null,
    stage: sr ? { width: Math.round(sr.width), height: Math.round(sr.height) } : null,
  };
}

/**
 * One #69 surface INSIDE the app shell — the Dashboard card (target 'card': its `.gs-card`) or
 * the whole Getting Started tab (target 'page': its active panel). The gate has its own probe;
 * this one looks for what a layout that answers to the workspace's width does wrong — the
 * Enrollments card's 0px column was the scar — without knowing anything of the surface but its
 * root:
 *   • the document or <main> scrolling sideways;
 *   • a box painting outside the surface, or outside the window;
 *   • in-flow sibling boxes overlapping;
 *   • a box holding text squeezed under 12px, or text stacked a few characters per line;
 *   • a control covered at its centre (where its centre is inside the window).
 * <main> is scrolled to the top first, so the sticky page header sits in its own place.
 */
function measureShellSurface({ target }) {
  const main = document.querySelector('main');
  if (!main) return { error: 'no <main>' };
  main.scrollTop = 0;
  const panel = [...main.querySelectorAll('[aria-hidden="false"]')].find((el) => !el.hidden && el.getClientRects().length);
  if (!panel) return { error: 'no active tab panel' };
  const root = target === 'card' ? panel.querySelector('.gs-card') : panel;
  if (!root) return { error: target === 'card' ? 'no Getting Started card on the active panel' : 'no active panel' };
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = window.innerHeight;
  const out = [];
  const say = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${text}"`;
  };
  // An <svg> is one box. The shapes inside an icon overlap by design (PlayCircle is a circle with
  // a triangle on it), so nothing inside an <svg> is measured on its own.
  const shown = (el) => {
    if (el.ownerSVGElement || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.classList.contains('sr-only');
  };
  const where = target === 'card' ? 'the card' : 'the tab';
  if (de.scrollWidth > de.clientWidth + 1) out.push(`the page scrolls sideways by ${de.scrollWidth - de.clientWidth}px`);
  if (main.scrollWidth > main.clientWidth + 1) out.push(`<main> scrolls sideways by ${main.scrollWidth - main.clientWidth}px`);
  const rr = root.getBoundingClientRect();
  const all = [root, ...root.querySelectorAll('*')].filter(shown);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (el !== root && (r.left < rr.left - 1 || r.right > rr.right + 1)) {
      out.push(`${say(el)} paints outside ${where} (${Math.round(r.left)}…${Math.round(r.right)}; ${where} is ${Math.round(rr.left)}…${Math.round(rr.right)})`);
    }
    if (r.left < -1 || r.right > vw + 1) out.push(`${say(el)} paints outside the window (${Math.round(r.left)}…${Math.round(r.right)} of ${vw}px)`);
  }
  for (const parent of all) {
    const kids = [...parent.children].filter((k) => shown(k) && !/absolute|fixed|sticky/.test(getComputedStyle(k).position));
    if (kids.length < 2) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = rects[i]; const b = rects[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) out.push(`${say(kids[i])} and ${say(kids[j])} overlap by ${Math.round(ox)}x${Math.round(oy)}px`);
      }
    }
  }
  // Text: a box squeezed under 12px holding 4+ characters of its own (a squeezed column is a few
  // px; the card's "0:03" is ~25px wide, which is why this is not 24), or a run of text broken
  // into 3+ lines of under 4 characters each (or 3+ lines in a box narrower than 56px).
  for (const el of all) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    if (own.length >= 4 && el.getBoundingClientRect().width < 12) {
      out.push(`${say(el)} holds its text in ${Math.round(el.getBoundingClientRect().width)}px`);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    const host = n.parentElement;
    if (t.length < 4 || !host || !shown(host)) continue;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    const tops = [];
    for (const r of rg.getClientRects()) if (r.width > 0 && !tops.some((x) => Math.abs(x - r.top) < 3)) tops.push(r.top);
    if (tops.length < 3) continue;
    const w = host.getBoundingClientRect().width;
    if (t.length / tops.length < 4 || w < 56) {
      out.push(`${say(host)} is stacked ${tops.length} lines deep at ${(t.length / tops.length).toFixed(1)} characters a line, ${Math.round(w)}px wide`);
    }
  }
  for (const c of root.querySelectorAll('button, a[href], summary')) {
    if (!shown(c)) continue;
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue;
    const at = document.elementFromPoint(cx, cy);
    if (!at || !c.contains(at)) out.push(`${say(c)} is covered at its centre by ${at ? say(at) : 'nothing'}`);
  }
  const facts = { width: Math.round(rr.width) };
  if (target === 'card') {
    const cs = getComputedStyle(root);
    facts.inner = Math.round(root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const text = root.querySelector('.gs-card__text');
    const actions = root.querySelector('.gs-card__actions');
    if (text && actions) facts.layout = actions.getBoundingClientRect().top < text.getBoundingClientRect().bottom - 1 ? 'inline' : 'stacked';
  }
  const stage = root.querySelector('.gs-stage');
  if (stage && shown(stage)) facts.stage = Math.round(stage.getBoundingClientRect().width);
  return { problems: [...new Set(out)].slice(0, 40), facts };
}

/** The sidebar as the user left it: open (the 288px column) or collapsed to the 76px rail. */
function sidebarIs(rail) {
  const navs = [...document.querySelectorAll('nav[aria-label="Main navigation"]')].filter((n) => n.getClientRects().length);
  if (navs.length !== 1) return false;
  const w = navs[0].getBoundingClientRect().width;
  return rail
    ? !!document.querySelector('[aria-label="Expand sidebar"]') && w < 120
    : !!document.querySelector('[aria-label="Collapse sidebar"]') && w > 200;
}

/**
 * The Go button's every state change — locked, busy, the disabled attribute — with how much of
 * the clip had really played at that moment. It keeps recording until the button is gone, so the
 * press and the completion it starts are in the log too.
 */
function recordGoButton() {
  const go = document.querySelector('[data-gs-go]');
  if (!go) return false;
  const log = [];
  const rec = (why) => {
    const v = document.querySelector('.gs-stage[data-gs-mode="gate"] video');
    let played = 0;
    if (v) for (let i = 0; i < v.played.length; i += 1) played += v.played.end(i) - v.played.start(i);
    log.push({
      why, t: Math.round(performance.now()),
      locked: go.getAttribute('aria-disabled') === 'true',
      busy: go.getAttribute('aria-busy') === 'true',
      disabledAttr: go.hasAttribute('disabled') || go.disabled === true,
      described: !!go.getAttribute('aria-describedby'),
      focused: document.activeElement === go,
      current: v ? v.currentTime : null,
      duration: v && Number.isFinite(v.duration) ? v.duration : null,
      played, ended: v ? v.ended : null,
    });
  };
  rec('start');
  new MutationObserver(() => rec('attr')).observe(go, {
    attributes: true, attributeFilter: ['aria-disabled', 'aria-describedby', 'aria-busy', 'disabled'],
  });
  window.__gsGo = log;
  window.__gsGoRec = rec;
  return true;
}

function focusState() {
  const a = document.activeElement;
  if (!a || a === document.body) return { go: false, what: 'body' };
  const label = a.getAttribute('aria-label');
  return { go: a.matches('[data-gs-go]'), what: `${a.tagName.toLowerCase()}${label ? `[${label}]` : ''}${a.hasAttribute('data-gs-go') ? '[data-gs-go]' : ''}` };
}

function goState() {
  const go = document.querySelector('[data-gs-go]');
  if (!go) return null;
  const hint = document.getElementById(go.getAttribute('aria-describedby') || '');
  return {
    ariaDisabled: go.getAttribute('aria-disabled'),
    disabledAttr: go.hasAttribute('disabled'),
    busy: go.getAttribute('aria-busy'),
    hint: hint ? hint.textContent.trim() : null,
    live: (document.querySelector('main.gs-surface [role="status"][aria-live="polite"]') || {}).textContent || '',
    focused: document.activeElement === go,
  };
}

function clickNav(href) {
  const navs = [...document.querySelectorAll('nav[aria-label="Main navigation"]')].filter((n) => n.getClientRects().length);
  for (const nav of navs) {
    const a = [...nav.querySelectorAll('a[href]')]
      .find((x) => x.getAttribute('href') === href && x.getAttribute('target') !== '_blank' && x.getClientRects().length);
    if (a) { a.click(); return true; }
  }
  return false;
}

/** The visible main navigation's order around Getting Started and Dashboard. */
function sidebarOrder() {
  const navs = [...document.querySelectorAll('nav[aria-label="Main navigation"]')]
    .filter((n) => n.getClientRects().length && getComputedStyle(n).display !== 'none');
  if (navs.length !== 1) return { error: `${navs.length} visible main navigations` };
  const nav = navs[0];
  const links = [...nav.querySelectorAll('a[href]')]
    .filter((a) => a.getAttribute('target') !== '_blank' && a.getClientRects().length);
  const hrefs = links.map((a) => a.getAttribute('href'));
  const gi = hrefs.indexOf('/getting-started');
  const di = hrefs.indexOf('/');
  const g = links[gi]; const d = links[di];
  const icon = g && g.querySelector('svg');
  const gr = g && g.getBoundingClientRect(); const dr = d && d.getBoundingClientRect(); const ir = icon && icon.getBoundingClientRect();
  return {
    navWidth: Math.round(nav.getBoundingClientRect().width),
    first: hrefs.slice(0, 5), gi, di,
    label: g ? (g.getAttribute('aria-label') || g.textContent.replace(/\s+/g, ' ').trim()) : null,
    icon: !!ir && ir.width > 0 && ir.height > 0,
    above: !!gr && !!dr && gr.bottom <= dr.top + 1
      && Math.abs((gr.left + gr.width / 2) - (dr.left + dr.width / 2)) < 2,
  };
}

/**
 * Links to the Super Admin's screen anywhere in the document — a sidebar row, a rail icon, a
 * "Manage" link — and, as a control, whether the visible navigation shows the Enrollments admin
 * row (an Operations Admin's own), which proves the admin group is rendered at all.
 */
function adminLinks(path) {
  const navs = [...document.querySelectorAll('nav[aria-label="Main navigation"]')].filter((n) => n.getClientRects().length);
  const list = document.getElementById('sidebar-admin-list');
  return {
    toAdminScreen: document.querySelectorAll(`a[href="${path}"]`).length,
    enrollmentsRow: navs.some((n) => !!n.querySelector('a[href="/admin/enrollments"]')),
    // The Administration group's rows, in order — and any navigation item NAMED for the screen,
    // whatever its address.
    rows: list ? [...list.querySelectorAll(':scope > li > a[href]')].map((a) => a.getAttribute('href')) : [],
    namedRows: navs.reduce((n, nav) => n + [...nav.querySelectorAll('a')]
      .filter((a) => /Getting Started Video/.test(a.getAttribute('aria-label') || a.textContent || '')).length, 0),
  };
}

/**
 * The Administration group in the open sidebar: is it open, and its rows in order — each with
 * its visible label, the count beside it (aria-hidden, so a screen reader never hears a bare
 * number) and the words a screen reader IS given for that count (the row's .sr-only phrase).
 */
function adminGroup() {
  const list = document.getElementById('sidebar-admin-list');
  const toggle = document.getElementById('sidebar-admin-toggle');
  if (!list || !toggle) return { present: false, open: false, rows: [] };
  const rows = [...list.querySelectorAll(':scope > li > a[href]')].map((a) => {
    const label = a.querySelector('span.truncate');
    const count = [...a.querySelectorAll('span[aria-hidden="true"]')].map((s) => s.textContent.trim()).find((x) => /^\d+$/.test(x));
    const spoken = [...a.querySelectorAll('.sr-only')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()).join(' ');
    return { href: a.getAttribute('href'), label: label ? label.textContent.trim() : null, count: count || null, spoken: spoken || null };
  });
  return { present: true, open: toggle.getAttribute('aria-expanded') === 'true' && !list.hidden, rows };
}

/** The collapsed rail's admin icons, in order: where each goes and what it is called. */
function railAdminLinks() {
  const navs = [...document.querySelectorAll('nav[aria-label="Main navigation"]')]
    .filter((n) => n.getClientRects().length && getComputedStyle(n).display !== 'none');
  if (navs.length !== 1) return { error: `${navs.length} visible main navigations` };
  return {
    links: [...navs[0].querySelectorAll('a[href^="/admin/"]')]
      .map((a) => ({ href: a.getAttribute('href'), label: a.getAttribute('aria-label'), count: (a.querySelector('span[aria-hidden="true"]') || {}).textContent || null })),
  };
}

/** The Getting Started Video screen's health banner: its role and its words. */
function healthBanner() {
  const admin = document.querySelector('.gs-admin');
  if (!admin) return null;
  const n = [...admin.querySelectorAll('[role="status"], [role="alert"]')]
    .find((el) => /Getting Started video|Couldn.t check/.test(el.textContent));
  return n ? { role: n.getAttribute('role'), text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 240) } : null;
}

/** An open dialog by its accessible name (AccountModal and SidePanel both name it aria-label={title}). */
function dialogText(label) {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.getAttribute('aria-label') === label);
  return d ? d.textContent.replace(/\s+/g, ' ').trim() : false;
}

/** Press the button whose words are `text`, inside the dialog named `label`. */
function clickInDialog(label, text) {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.getAttribute('aria-label') === label);
  const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === text);
  if (!b) return false;
  b.click();
  return true;
}

/** Focus the field a label in an open dialog names — so the next Input.insertText types into it. */
function focusLabelled(labelText) {
  const lab = [...document.querySelectorAll('[role="dialog"] label')].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === labelText);
  const el = lab && document.getElementById(lab.htmlFor);
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
}

/** What a typed admin address rendered: the role refusal, the Dashboard, or the admin screen itself. */
function typedAddressOutcome() {
  const panel = [...document.querySelectorAll('main [aria-hidden="false"]')].find((el) => !el.hidden);
  if (!panel) return false;
  const adminScreen = [...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === 'Getting Started Video');
  // An admin screen is refused by ROLE (T12B-D1): the refusal names the role and sells nothing.
  // `sells` reports any plan-upsell wording or Upgrade control on it, so a slide back to the upsell
  // fails instead of passing; the old upsell itself reads as its own outcome, never as 'refused'.
  if (/Your account can.t open this screen/.test(panel.textContent)) {
    const text = panel.textContent.replace(/\s+/g, ' ').trim();
    return { screen: 'refused', path: location.pathname, adminScreen, sells: /isn.t part of your plan|Upgrade or renew/.test(text), text: text.slice(0, 300) };
  }
  if (/This tool isn.t part of your plan yet/.test(panel.textContent)) return { screen: 'plan-upsell', path: location.pathname, adminScreen };
  if (location.pathname === '/' && [...panel.querySelectorAll('h1')].some((h) => /Get Hired With Alex/.test(h.textContent))) {
    return { screen: 'dashboard', path: location.pathname, adminScreen };
  }
  if (adminScreen) return { screen: 'admin', path: location.pathname, adminScreen };
  return false;
}

function gsCard() {
  const c = document.querySelector('.gs-card');
  if (!c) return null;
  const chip = [...c.querySelectorAll('span')].map((s) => s.textContent.trim())
    .find((t) => t === 'Completed' || t === 'Finished an earlier version' || t === 'Not finished') || null;
  const toggle = c.querySelector('button[aria-controls]');
  return {
    title: (c.querySelector('h2') || {}).textContent || null,
    chip,
    toggle: toggle ? toggle.textContent.trim() : null,
    openLink: [...c.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/getting-started'),
  };
}

/** Tag the replay that is playing now, so "paused" can later be checked on THIS element. */
function tagPlaying(mode) {
  const v = document.querySelector(`.gs-stage[data-gs-mode="${mode}"] video`);
  if (!v || v.paused || !(v.currentTime > 0.05)) return false;
  v.dataset.e2ePlayed = '1';
  return true;
}

/** The replay of one mode now: is it the element tagged while it played, and where is it? */
function replayState(mode) {
  const all = [...document.querySelectorAll(`.gs-stage[data-gs-mode="${mode}"] video`)];
  const v = all[0];
  if (!v) return { present: false };
  return {
    present: true, count: all.length, same: v.dataset.e2ePlayed === '1',
    paused: v.paused, ended: v.ended, currentTime: v.currentTime,
    hidden: v.closest('.gs-stage').offsetParent === null,
  };
}

// ── Node-side helpers ────────────────────────────────────────────────────────────────────────

/**
 * Record every PostgREST RPC this page POSTs — its name, status, its arguments, whether it
 * finished and when (Node's clock) — from the page's own CDP events, so a count can prove an RPC
 * did or did not happen, the gate's own answer (my_onboarding_video) can be read back, and a hold
 * can wait for an answer to have landed. An RPC's arguments are ids and flags, never a token.
 */
function trackRpcs(page) {
  const calls = [];
  const byId = new Map();
  const off = page.conn.on((msg) => {
    if (msg.sessionId !== page.sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Network.requestWillBeSent') {
      const m = /\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(p.request?.url || '');
      if (m && p.request.method === 'POST' && !byId.has(p.requestId)) {
        const c = { name: m[1], id: p.requestId, status: null, done: false, sentAt: Date.now(), doneAt: null, body: p.request.postData || null };
        calls.push(c);
        byId.set(p.requestId, c);
      }
    } else if (msg.method === 'Network.responseReceived') {
      const c = byId.get(p.requestId);
      if (c) c.status = p.response?.status ?? null;
    } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      const c = byId.get(p.requestId);
      if (c && !c.done) { c.done = true; c.doneAt = Date.now(); }
    }
  });
  page.rpcs = { calls, count: (name) => calls.filter((c) => c.name === name).length };
  const close = page.close.bind(page);
  page.close = async () => { off(); return close(); };
}

async function openAs(person, path, {
  width = 1280, height = 800, theme = 'light', welcomed = true, railCollapsed = false, beforeGoto = null,
} = {}) {
  const page = await browser.newPage();
  trackRpcs(page);
  await page.addInitScript(WATCH);
  await injectSession(page, await sessionFor(person), { railCollapsed, welcomed });
  await page.setViewport({ width, height });
  await page.setMedia({ colorScheme: theme });
  // Focus as if this page were the one in front: key events, focus and :focus-visible behave
  // as they do for a real user, whichever of the run's pages Chrome thinks is foremost.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (beforeGoto) await beforeGoto(page);
  await page.goto(app.url + path, { timeoutMs: 180000 });
  return page;
}

/**
 * What a paid student's gate waits on BEFORE it ever reaches the Getting Started arm
 * (resolveGateScreen in src/lib/gateScreen.js): the session check (`loading`), the profile
 * (`profileReady`) and the two enrollment reads (`enroll.ready`) — plus the staff context, which a
 * student's gate does not wait on but which costs nothing to outlast.
 */
const GATE_READS = [
  ['session check', 'GET', /\/auth\/v1\/user(?:\?|$)/],
  ['profile', 'GET', /\/rest\/v1\/profiles\?/],
  ['latest request', 'GET', /\/rest\/v1\/enrollment_requests\?/],
  ['latest term', 'GET', /\/rest\/v1\/subscriptions\?/],
  ['staff context', 'POST', /\/rest\/v1\/rpc\/my_staff_context(?:\?|$)/],
];
// Half a second is plenty: the page renders what the last read brought within a frame, and the
// answer still has its own trip across the network after it is released. Kept short because
// the whole hold has to fit inside the hook's 7 s fail-open timeout (HOLD_CAP_MS, with room for
// that trip): the shorter this margin, the slower a network the check survives.
const HOLD_AFTER_MS = 500;
// Counted from the FIRST of the sign-in's requests (the gate's reads, or the question itself) —
// the nearest thing the page shows to the moment the hook's 7 s timer started. A cap counted from
// the paused request alone could release an answer the hook had already given up on.
const HOLD_CAP_MS = 5000;

/**
 * Hold the gate's own question (my_onboarding_video) until every read in GATE_READS has landed,
 * and HOLD_AFTER_MS more — so for that long, and for the answer's own trip, the ONLY thing the
 * gate waits for is #69's answer, and a gate that renders the app while it waits (shown: the D1
 * mutant) is caught doing it. A FIXED delay could not promise that: on a slow network the other
 * reads outlast it, the gate holds its splash for THEIR sake, and a check that "the Dashboard
 * never renders first" passes without testing anything (shown: the old 2.5 s hold, with the
 * profile read 2 s slow, let D1 through). Capped at HOLD_CAP_MS, inside the hook's 7 s fail-open
 * timeout; a capped hold FAILS the test rather than passing vacuously. The delay is a simulated
 * network, not a wait. Returns the record, filled in as it happens (Node's clock, ms):
 * { firstRequestAt, pausedAt, releasedAt, capped, done: { read → when it finished } }.
 */
async function holdAnswerPastGateReads(page) {
  const hold = { firstRequestAt: null, pausedAt: null, releasedAt: null, capped: false, done: {} };
  const readOf = new Map();
  const off = page.conn.on((msg) => {
    if (msg.sessionId !== page.sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Network.requestWillBeSent') {
      const url = p.request?.url || '';
      const read = GATE_READS.find(([, method, re]) => p.request?.method === method && re.test(url));
      if (read) readOf.set(p.requestId, read[0]);
      if ((read || /\/rest\/v1\/rpc\/my_onboarding_video(?:\?|$)/.test(url)) && hold.firstRequestAt === null) hold.firstRequestAt = Date.now();
    } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      const read = readOf.get(p.requestId);
      if (read && !hold.done[read]) hold.done[read] = Date.now();
    } else if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request } = p;
      const go = () => page.send('Fetch.continueRequest', { requestId }).catch(() => {});
      if (request?.method !== 'POST' || hold.pausedAt) { go(); return; }
      hold.pausedAt = Date.now();
      const release = () => {
        const now = Date.now();
        const times = GATE_READS.map(([read]) => hold.done[read]);
        const ready = times.every(Boolean) && now >= Math.max(...times) + HOLD_AFTER_MS;
        if (ready || now - (hold.firstRequestAt ?? hold.pausedAt) >= HOLD_CAP_MS) {
          hold.capped = !ready;
          hold.releasedAt = now;
          go();
          return;
        }
        setTimeout(release, 25);
      };
      release();
    }
  });
  const close = page.close.bind(page);
  page.close = async () => { off(); return close(); };
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/rest/v1/rpc/my_onboarding_video*', requestStage: 'Request' }] });
  return hold;
}

/**
 * The gate's own question, answered: my_onboarding_video's response for this sign-in — its
 * booleans, and which video it names (id and title). Never its storage path.
 */
async function gsAnswer(page, { timeoutMs = 60000 } = {}) {
  const until = Date.now() + timeoutMs;
  let call;
  while (!(call = page.rpcs.calls.find((c) => c.name === 'my_onboarding_video' && c.done))) {
    assert.ok(Date.now() < until, 'my_onboarding_video was never asked, or never answered');
    await tick(100);
  }
  assert.equal(call.status, 200, `my_onboarding_video answered HTTP ${call.status}`);
  const r = await page.send('Network.getResponseBody', { requestId: call.id });
  const body = JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body);
  return {
    eligible: body.eligible, required: body.required, completed: body.completed,
    completed_current: body.completed_current, media_available: body.media_available,
    can_manage: body.can_manage, videoId: body.video ? body.video.id : null,
    title: body.video ? body.video.title : null,
  };
}

// Never print a query string: a signed URL carries its token there.
const redact = (u) => String(u || '').replace(/\?.*$/, '?…');
/** The shadow project's ref masked out of anything written to evidence or a failure message. */
const hideRef = (s) => String(s || '').split(shadowEnv().SHADOW_PROJECT_REF).join('<shadow-ref>');
const SIGN_RE = /\/storage\/v1\/object\/sign\/onboarding-videos\//;
const signPosts = (page) => page.requests.filter((r) => r.method === 'POST' && SIGN_RE.test(r.url || '')).length;
const signedGets = (page) => page.requests.filter((r) => r.method === 'GET' && SIGN_RE.test(r.url || '')).length;
/** Every request for an onboarding object that is NOT the signing call or the signed URL itself. */
const unsignedHits = (page) => page.requests
  .filter((r) => /\/onboarding-videos\//.test(r.url || '') && !SIGN_RE.test(r.url || ''))
  .map((r) => `${r.method} ${redact(r.url)}`);

// The #69 requests — the signing calls, the signed URL, and every *onboarding* RPC.
const ONBOARDING_URL_RE = /\/storage\/v1\/object\/sign\/onboarding-videos\/|\/rest\/v1\/rpc\/[a-z0-9_]*onboarding[a-z0-9_]*(?:\?|$)/;

/**
 * The page's errors: uncaught exceptions, console errors — and any #69 request that FAILED, even
 * when the app shrugged it off. A 4xx on a background onboarding RPC, or a signing call that
 * failed before a retry recovered, never reaches the console as an error of its own: Chrome logs
 * it only as a network entry. `allowUrls` names an expected refusal; the caller pins it some other
 * way (test 6 pins the one 409 it provokes by its status list).
 */
function pageErrors(page, { allowUrls = null } = {}) {
  const allowed = (url) => !!allowUrls && allowUrls.test(url || '');
  return page.problems.filter((p) => {
    if (p.kind === 'exception') return true;
    if (p.kind === 'console.error') return !/favicon|Failed to load resource/i.test(p.text);
    if (p.kind === 'http') return p.status >= 400 && ONBOARDING_URL_RE.test(p.url || '') && !allowed(p.url);
    if (p.kind.startsWith('log.')) return ONBOARDING_URL_RE.test(p.url || '') && !/favicon/i.test(p.url || '') && !allowed(p.url);
    return false;
  }).map((p) => ({ kind: p.kind, status: p.status, text: p.text ? redact(p.text) : undefined, url: p.url ? redact(p.url) : undefined }));
}

const bodyHas = (page, text) => page.evaluate((t) => document.body.textContent.includes(t), text);

async function typeInto(page, selector, text) {
  const ok = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.focus(); if (el.select) el.select(); return true; }, selector);
  assert.ok(ok, `no ${selector}`);
  await page.send('Input.insertText', { text });
}

const clickButton = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t && !x.disabled);
  if (!b) return false;
  b.click();
  return true;
}, text);

const KEYS = {
  Tab: { down: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Enter: { down: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
};
/** A REAL key press through CDP's input pipeline — the browser's own focus and activation rules. */
async function press(page, name) {
  const { down, text, unmodifiedText, ...k } = KEYS[name];
  await page.send('Input.dispatchKeyEvent', { type: down, ...k, ...(text ? { text, unmodifiedText } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

/** Real Tab presses, at most 30, until Go to dashboard has focus → { reached, path, from }. */
async function tabToGo(page) {
  const from = (await page.evaluate(focusState)).what;
  const path = [];
  for (let i = 0; i < 30; i += 1) {
    await press(page, 'Tab');
    const f = await page.evaluate(focusState);
    path.push(f.what);
    if (f.go) return { reached: true, path, from };
  }
  return { reached: false, path, from };
}

/** The Go button as the accessibility tree reports it. */
async function axOfGo(page) {
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-gs-go]' });
  assert.ok(nodeId, 'no Go to dashboard in the DOM');
  const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const n = (nodes || []).find((x) => !x.ignored) || (nodes || [])[0];
  assert.ok(n, 'Go to dashboard has no accessibility node');
  const prop = (name) => (n.properties || []).find((p) => p.name === name)?.value?.value;
  return {
    role: n.role?.value ?? null,
    name: (n.name?.value ?? '').trim(),
    description: (n.description?.value ?? '').trim() || null,
    disabled: prop('disabled') === true,
  };
}

/** The role and the accessible name Chrome computes for the first element `selector` matches. */
async function axNameOf(page, selector) {
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `no ${selector} in the DOM`);
  const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const n = (nodes || []).find((x) => !x.ignored) || (nodes || [])[0];
  assert.ok(n, `${selector} has no accessibility node`);
  return { role: n.role?.value ?? null, name: String(n.name?.value ?? '').replace(/\s+/g, ' ').trim() };
}

/**
 * Hand files to an <input type=file> the way a person choosing them does: CDP's own
 * DOM.setFileInputFiles, which fills the input and fires its input and change events — so the
 * app's real onChange runs, with a real File read from disk (its name, type and size).
 */
async function setInputFiles(page, selector, files) {
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `no ${selector} to choose a file with`);
  await page.send('DOM.setFileInputFiles', { files, nodeId });
}

/** Wait until this page has had `n` answers to the RPC `name` — counting its calls from index `from` on (see trackRpcs). */
async function waitForRpc(page, name, { n = 1, timeoutMs = 60000, from = 0 } = {}) {
  const until = Date.now() + timeoutMs;
  const done = () => page.rpcs.calls.filter((c, i) => i >= from && c.name === name && c.done).length;
  while (done() < n) {
    assert.ok(Date.now() < until, `${name} was not answered ${n} time(s) within ${timeoutMs / 1000}s`);
    await tick(100);
  }
}

// The root renders with a staff context in the render right after it lands; this covers that
// render with a wide margin (two frames are waited for first).
const STAFF_SETTLE_MS = 500;
// What AuthProvider logs when it stops waiting for my_staff_context (AUTH_CALL_TIMEOUT_MS, 8 s) or
// the call fails, and goes on with an EMPTY context. Read from page.problems (_cdp.mjs records
// console warnings).
const STAFF_GAVE_UP_RE = /\[auth\] staff context unavailable/;

/**
 * Wait until this page KNOWS who its staff member is: my_staff_context has answered HTTP 200,
 * naming `role` with an active membership, and the root has had time to render with it.
 *
 * ★ BEFORE THAT, EVERY STAFF MEMBER LOOKS THE SAME (V12B-2). adminTabVisible() is false while
 *   !staffReady, so the sidebar lists no admin row and the chokepoint renders RestrictedTab for
 *   every admin address — and the gate does not wait for the staff context for a paid staff
 *   member, so their Dashboard, or a typed admin address, can be on screen first. "No row", "no
 *   link" and "refused" read before this returns are what the page shows everyone; read after
 *   it, they are what the page decided about this role.
 * ★ AND THE PAGE MUST HAVE TAKEN IT. AuthProvider waits 8 s for the call, then treats the account
 *   as non-staff (an EMPTY, degraded context) — which refuses everything for that reason — and a
 *   response landing later changes nothing on screen. So an HTTP 200 naming the right role is not
 *   enough on its own: a slow enough call comes back 200 with the role AFTER the page has given
 *   up on it, and the page then refuses what a broken build would have opened (shown on a mirror
 *   that opens the screen to a Trainer: with the Trainer's call held 8.5 s, this check without
 *   the line below passed). The page's own warning says it gave up. Returns the role's facts —
 *   never a token.
 */
async function waitForStaffContext(page, who, role, { timeoutMs = 60000 } = {}) {
  await waitForRpc(page, 'my_staff_context', { timeoutMs });
  const call = page.rpcs.calls.find((c) => c.name === 'my_staff_context' && c.done);
  assert.equal(call.status, 200, `${who}'s staff context answered HTTP ${call.status}, so a refusal now would not be the role's`);
  const r = await page.send('Network.getResponseBody', { requestId: call.id });
  const body = JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body);
  const ctx = Array.isArray(body) ? body[0] : body;
  assert.equal(ctx?.role_key, role, `${who}'s page was told another role`);
  assert.equal(ctx?.status, 'active', `${who}'s page was told their membership is not active`);
  await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true)))));
  await tick(STAFF_SETTLE_MS);
  const ms = call.doneAt - call.sentAt;
  assert.equal(page.problems.some((p) => p.kind === 'console.warning' && STAFF_GAVE_UP_RE.test(p.text || '')), false,
    `${who}'s page gave up on its staff context (the call took ${ms} ms; the app waits 8 s), so what it shows now is not the role's decision`);
  return { role: ctx.role_key, status: ctx.status, ms };
}

// T12-D1's condition (7b): a PAID profile and the gate's answer have BOTH landed while the
// member's TERM is still loading. Only then can the bug act: with the profile in and no term yet,
// enrollGateState() says 'pass' (the grandfather rule), and a hook handed that unsettled 'pass'
// re-asks as soon as its answer says eligible:false. Before the profile lands it says 'paywall',
// and once the term lands it says 'expired' — either way a broken build asks once. So the term
// read is held until the LATER of the two has landed, and this much longer: far past the moment
// a re-ask would be sent, which is the render right after the later of them (measured on a mirror
// with the fix reverted: 4, 10 and 16 ms after it). The term still needs its own round trip once
// let go, so the window stays open well over half a second; and the shorter this margin, the
// slower a network the check survives inside the cap below — keyed on the later of two reads,
// the release can only come later than an answer-only hold's did.
const TERM_HOLD_AFTER_MS = 500;
// Counted from the hold's start, and well inside the enrollment gate's own 7 s fail-open timeout:
// held past it, the gate passes on its timeout, and the re-ask that follows is a legitimate one.
// A capped hold FAILS the test: the profile and the answer did not both land while the term was
// loading, so the condition was not exercised and the count proves nothing.
const TERM_HOLD_CAP_MS = 5000;
// The profile read, as test 1's GATE_READS knows it (AuthProvider's GET of the member's row).
const [, , PROFILE_READ_RE] = GATE_READS.find(([read]) => read === 'profile');
// What the Fetch pattern below pauses. Anything else paused on the page is another hold's.
const TERM_READ_PATH_RE = /\/rest\/v1\/subscriptions/;

/**
 * Hold every read of the member's TERM (the subscriptions read useEnrollmentGate makes as soon
 * as a uid exists) until BOTH the gate's own answer (my_onboarding_video) and the member's
 * PROFILE (the read that brings is_paid) have landed, and TERM_HOLD_AFTER_MS more; then let them
 * all through. The delay is a slow network, not a wait. Needs trackRpcs (openAs installs it
 * before beforeGoto runs). Returns the record, filled in as it happens (Node's clock):
 * { pausedAt, releasedAt, answerDoneAt, profileDoneAt, profileReads, held, capped }.
 *
 * ★ KEYED ON BOTH, NOT ON THE ANSWER ALONE (V12B-1). Keyed on the answer, a profile that landed
 *   after the term had been released left a broken build nothing to re-ask with: on a mirror with
 *   the fix reverted, the same build read twice with the profile on time and ONCE — passing —
 *   with the profile landing about a second after the term. The profile has landed once a read of
 *   it has SUCCEEDED and none is still on its way; a failed read never counts (it leaves the
 *   profile unknown).
 */
async function holdTermReadPastAnswer(page) {
  const hold = {
    pausedAt: null, releasedAt: null, answerDoneAt: null, profileDoneAt: null, profileReads: [], held: 0, capped: false,
  };
  const waiting = [];
  const profiles = new Map();   // requestId → { status, done, ok }
  const go = (requestId) => page.send('Fetch.continueRequest', { requestId }).catch(() => {});
  const answeredAt = () => page.rpcs.calls.find((c) => c.name === 'my_onboarding_video' && c.done)?.doneAt ?? null;
  const release = () => {
    if (hold.releasedAt) return;
    const now = Date.now();
    const a = answeredAt();
    const p = hold.profileDoneAt;
    const ready = a !== null && p !== null && now >= Math.max(a, p) + TERM_HOLD_AFTER_MS;
    if (ready || now - hold.pausedAt >= TERM_HOLD_CAP_MS) {
      hold.capped = !ready;
      hold.answerDoneAt = a;
      hold.releasedAt = now;
      for (const id of waiting.splice(0)) go(id);
      return;
    }
    setTimeout(release, 25);
  };
  const off = page.conn.on((msg) => {
    if (msg.sessionId !== page.sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Network.requestWillBeSent') {
      if (p.request?.method === 'GET' && PROFILE_READ_RE.test(p.request.url || '') && !profiles.has(p.requestId)) {
        profiles.set(p.requestId, { status: null, done: false, ok: false });
      }
    } else if (msg.method === 'Network.responseReceived') {
      const read = profiles.get(p.requestId);
      if (read) read.status = p.response?.status ?? null;
    } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      const read = profiles.get(p.requestId);
      if (!read || read.done) return;
      read.done = true;
      read.ok = msg.method === 'Network.loadingFinished' && read.status >= 200 && read.status < 300;
      hold.profileReads.push(read.ok ? read.status : (read.status ?? 'failed'));
      const all = [...profiles.values()];
      if (hold.profileDoneAt === null && all.some((x) => x.ok) && all.every((x) => x.done)) hold.profileDoneAt = Date.now();
    } else if (msg.method === 'Fetch.requestPaused') {
      if (!TERM_READ_PATH_RE.test(p.request?.url || '')) return;
      if (hold.releasedAt) { go(p.requestId); return; }
      hold.held += 1;
      waiting.push(p.requestId);
      if (hold.pausedAt === null) { hold.pausedAt = Date.now(); release(); }
    }
  });
  const close = page.close.bind(page);
  page.close = async () => { off(); return close(); };
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/rest/v1/subscriptions*', requestStage: 'Request' }] });
  return hold;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "September 30, 2026": the Asia/Manila calendar day (+08:00, no daylight saving) of a timestamp. */
function manilaDay(ts) {
  const d = new Date(new Date(ts).getTime() + 8 * 60 * 60 * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Wait until the gate is up with its <video> loaded (metadata). */
async function waitForGateVideo(page, what = 'the Getting Started gate with its video loaded') {
  await page.waitFor(() => {
    const v = document.querySelector('.gs-stage[data-gs-mode="gate"] video');
    return !!document.querySelector('[data-gs-go]') && !!v && v.readyState >= 1;
  }, [], { timeoutMs: 180000, what });
}

/** Wait until one mode's player has its <video> loaded (metadata). */
async function waitForPlayer(page, mode, what) {
  await page.waitFor((m) => { const v = document.querySelector(`.gs-stage[data-gs-mode="${m}"] video`); return !!v && v.readyState >= 1; },
    [mode], { timeoutMs: 60000, what: what || `the ${mode} player's video` });
}

async function playVideo(page, mode, { rate = 1 } = {}) {
  await page.send('Page.bringToFront');
  const r = await page.evaluate(async (m, speed) => {
    const v = document.querySelector(`.gs-stage[data-gs-mode="${m}"] video`);
    if (!v) return { error: `no ${m} <video>` };
    if (m === 'gate' && typeof window.__gsGoRec === 'function') {
      v.addEventListener('timeupdate', () => window.__gsGoRec('timeupdate'));
    }
    // The clip has no sound, so muting it changes nothing a viewer could notice — and muted
    // playback is the one kind Chrome starts without a user gesture.
    v.muted = true;
    v.playbackRate = speed;
    try { await v.play(); } catch (e) { return { error: `play() refused: ${e.name}` }; }
    return { playing: !v.paused, visibility: document.visibilityState, rate: v.playbackRate };
  }, mode, rate);
  assert.ok(!r.error, r.error);
  return r;
}

/**
 * Hide a playing replay's tab, then wait for the replay to stop → its state. "Stopped" means the
 * SAME <video> that was tagged while it played, paused, not ended, still where it was: a player
 * remounted in the hidden panel would hand back a fresh element that is paused because it never
 * played, and an ended one reports paused too.
 */
async function waitForHiddenPause(page, mode) {
  const until = Date.now() + PAUSE_WAIT_MS;
  let s;
  for (;;) {
    s = await page.evaluate(replayState, mode);
    if (s.present && s.same && s.paused && !s.ended) return s;
    if (Date.now() > until) return s;
    await tick(150);
  }
}

/** The server's own completion floor, evaluated on the SERVER's clock. Returns seconds since the first start. */
async function waitForServerFloor(userId) {
  const until = Date.now() + 90000;
  for (;;) {
    const [row] = await runSql(`select
        (now() >= g.first_started_at + make_interval(secs => greatest(
          coalesce(v.duration_seconds, ${ONBOARDING_UNKNOWN_DURATION_SECONDS}) * ${ONBOARDING_MIN_ELAPSED_FRACTION},
          ${ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS})::double precision)) as ready,
        extract(epoch from (now() - g.first_started_at))::float8 as since
      from public.student_onboarding_progress g
      join public.onboarding_videos v on v.id = g.video_id
     where g.user_id = ${lit(userId)}::uuid and v.status = 'published'`);
    if (row?.ready) return Number(row.since);
    assert.ok(Date.now() < until, 'the server\'s completion floor never passed — was the start never recorded?');
    await tick(500);
  }
}

/**
 * A student's progress row for one version — test 0's live one unless another is named — read
 * back as postgres. The timestamps come twice: as text (exact, to compare) and as epoch seconds
 * (to do arithmetic on).
 */
async function progressRow(userId, videoId = video.videoId) {
  const [row] = await runSql(`select g.video_id::text as video_id,
        g.first_started_at::text as first_started_at, g.last_started_at::text as last_started_at,
        g.completed_at::text as completed_at,
        extract(epoch from g.first_started_at)::float8 as first_started_s,
        extract(epoch from g.last_started_at)::float8 as last_started_s,
        extract(epoch from g.completed_at)::float8 as completed_s
      from public.student_onboarding_progress g where g.user_id = ${lit(userId)}::uuid and g.video_id = ${lit(videoId)}::uuid`);
  return row || null;
}

/**
 * Never held: the gate never appeared at any point of this page's life (the watcher records the
 * first moment it does), it is not up now, and the server did not ask for it.
 */
async function assertNeverGated(page, who, answer) {
  const w = await watchState(page);
  assert.ok(w, 'the screen watcher did not run');
  assert.equal(w.marks.gate, null, `${who} was shown the Getting Started gate`);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-gs-go]')
    || /Welcome to Toolkits,/.test(document.body.textContent)), false, `${who} has the Getting Started gate on screen`);
  assert.equal(answer.required, false, `the server said ${who} must watch the video`);
  return w;
}

/** Nothing of #69's on a membership screen: no player frame, no Dashboard card. */
const noGettingStarted = (page) => page.evaluate(() => !document.querySelector('.gs-stage, .gs-card, [data-gs-go]'));

const adminRpcs = (page) => page.rpcs.calls.filter((c) => c.name.startsWith('admin_onboarding_video_')).map((c) => c.name);

function requireVideo() {
  assert.ok(video && video.videoId, 'no Getting Started video was published — see the first test');
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

before(async () => {
  if (SKIP) return;
  mkdirSync(ART, { recursive: true });
  people = await ensureUsers(PERSONAS);
  await resetOnboardingVideos();
  // The guard legacyMigration.e2etest.mjs runs first: after a reset it has nothing to refuse.
  await assertNoLiveOnboardingVideo('gettingStarted.e2etest.mjs');
  await cleanupPersonas();
  const name = (l) => lit(PERSONAS.find((p) => p.label === l).fullName);
  // Everything that must exist BEFORE the first publish, in one round trip.
  await runSql(`do $seed$
    begin
      update public.profiles set full_name = ${name('gs-super')} where id = ${ids('gs-super')};
      update public.profiles set full_name = ${name('gs-ops')} where id = ${ids('gs-ops')};
      update public.profiles set full_name = ${name('gs-trainer')} where id = ${ids('gs-trainer')};
      update public.profiles set full_name = ${name('gs-new')}, is_paid = true where id = ${ids('gs-new')};
      update public.profiles set full_name = ${name('gs-layout')}, is_paid = true where id = ${ids('gs-layout')};
      update public.profiles set full_name = ${name('gs-done')}, is_paid = true where id = ${ids('gs-done')};
      update public.profiles set full_name = ${name('gs-unpaid')}, approval_status = 'pending' where id = ${ids('gs-unpaid')};
      update public.profiles set full_name = ${name('gs-pending')}, approval_status = 'pending' where id = ${ids('gs-pending')};
      update public.profiles set full_name = ${name('gs-import')}, is_paid = true, account_origin = 'import',
             onboarding_status = 'invited', onboarding_completed_at = null where id = ${ids('gs-import')};
      update public.profiles set full_name = ${name('gs-expired')}, is_paid = true where id = ${ids('gs-expired')};
      update public.profiles set full_name = ${name('gs-scheduled')} where id = ${ids('gs-scheduled')};
      update public.profiles set full_name = ${name('gs-existing')}, is_paid = true where id = ${ids('gs-existing')};
      -- 13: a plain signup until test 13 approves it, after its own publish.
      update public.profiles set full_name = ${name('gs-late')} where id = ${ids('gs-late')};
      -- Real staff memberships, so has_staff_permission() answers as in production; the
      -- staff_sync_is_admin trigger sets profiles.is_admin for the Super Admin only.
      insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at) values
        (${ids('gs-super')}, 'super_admin', 'active', now(), now()),
        (${ids('gs-ops')}, 'operations_admin', 'active', now(), now()),
        (${ids('gs-trainer')}, 'trainer', 'active', now(), now())
      on conflict (user_id) do update set role_key = excluded.role_key, status = 'active', activated_at = now();
      -- 10: an EXISTING member, whose first term began a month before the video existed.
      insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, created_at, updated_at)
      values (${ids('gs-existing')}, 'silver_self_paced', 'active', now() - interval '30 days', now() + interval '30 days',
              now() + interval '33 days', now() - interval '30 days', now() - interval '30 days');
      -- 5: a payment still under review.
      insert into public.enrollment_requests (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid,
                                              status, expires_at, request_kind)
      values (${ids('gs-pending')}, 'sampler', 'Essentials', ${name('gs-pending')}, ${lit(people['gs-pending'].email)}, 1499, 1499,
              'pending_review', now() + interval '3 days', 'new');
    end $seed$;`);
  app = await startApp();
  browser = await launchChrome();
});

after(async () => {
  if (SKIP) return;
  // ★ FIRST: nothing of test 0's or test 13's may START after this line, and what they have
  //   already started must FINISH before the reset below — see "Stopping test 0".
  stopping = true;
  const writing = [publishWork, screenWork].filter(Boolean);
  const inFlight = await settleWithin(writing.length ? Promise.allSettled(writing) : null, PUBLISH_SETTLE_MS);
  EVIDENCE.after = { writers: inFlight };
  if (inFlight === 'timed-out') {
    console.warn(`[gettingStarted.e2etest] test 0 or 13 was still running ${PUBLISH_SETTLE_MS / 1000}s into after(); resetting anyway. `
      + 'Anything of it that lands later is caught by the next run\'s before() and by legacyMigration.e2etest.mjs\'s guard.');
  }
  await browser?.close();
  app?.stop();
  try {
    await resetOnboardingVideos();
  } finally {
    await cleanupPersonas();
    try { writeFileSync(join(ART, `evidence-${NONCE}.json`), JSON.stringify(EVIDENCE, null, 2)); } catch { /* evidence only */ }
  }
});

// ── 0. The Super Admin publishes, through their own session ─────────────────────────────────

test('0 · the Super Admin publishes a clip recorded in this Chrome — draft, upload, attach, publish — with their own session',
  { skip: SKIP || false, timeout: 5 * 60 * 1000 }, async (t) => {
    // Before every write: stop if this test has timed out, or the suite is shutting down.
    const halt = (step) => {
      if (stopping || t.signal.aborted) {
        throw new Error(`test 0 stopped before ${step}: ${stopping ? 'the suite is shutting down' : 'it ran out of time'}`);
      }
    };
    publishWork = (async () => {
      clip = await recordClip(browser);
      assert.ok(clip.bytes > 0, 'the recorded clip is empty');
      assert.ok(Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0, 'the recorded clip has no finite duration');
      writeFileSync(join(ART, `clip-${NONCE}.mp4`), clip.buffer);   // evidence; test 13 uploads these bytes through the screen
      note('0-publish', { clipBytes: clip.bytes, clipSeconds: clip.durationSeconds, recordAttempts: clip.attempts });

      const live = await publishOnboardingVideo(await sessionFor(people['gs-super']), clip, { ...VIDEO, halt });
      assert.equal(live.published?.changed, true, 'the draft did not publish');
      assert.equal(live.published?.first_publish, true, 'this should be the first publish on a reset shadow');
      const [row] = await runSql(`select v.status, v.byte_size, v.mime_type, v.duration_seconds::float8 as duration,
          v.published_at is not null as has_cutoff, o.id is not null as object_present,
          (select count(*)::int from public.onboarding_video_events e where e.video_id = v.id) as events
        from public.onboarding_videos v
        left join storage.objects o on o.bucket_id = 'onboarding-videos' and o.name = v.storage_path
       where v.id = ${lit(live.videoId)}::uuid`);
      assert.equal(row.status, 'published');
      assert.equal(Number(row.byte_size), clip.bytes, 'the stored size is the clip\'s');
      assert.equal(row.mime_type, 'video/mp4');
      assert.equal(row.duration, live.durationSeconds, 'the verified duration was stored');
      assert.equal(row.object_present, true, 'the object is in the private bucket');
      assert.equal(row.events, 3, 'create_draft, attach_media and publish each wrote one audit row');
      // …and while it is live, the guard the other suites run refuses them, naming the cause.
      await assert.rejects(assertNoLiveOnboardingVideo('guard probe'), /1 Getting Started video is PUBLISHED/,
        'the live-video guard must refuse while a video is live');
      const floor = Math.max(live.durationSeconds * ONBOARDING_MIN_ELAPSED_FRACTION, ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS);
      note('0-publish', { durationSeconds: live.durationSeconds, serverFloorSeconds: floor, auditRows: row.events });

      // Everything that must be NEWER than the first publish, in one round trip. The three staff
      // hold paid terms too, so `required: false` for them rests on the staff exclusion alone.
      halt('seeding the personas');
      await runSql(`do $seed$
        begin
          insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, grant_source, source_import_row_id)
          values
            (${ids('gs-new')}, 'sampler', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null),
            (${ids('gs-layout')}, 'silver_self_paced', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null),
            (${ids('gs-done')}, 'silver_self_paced', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null),
            (${ids('gs-import')}, 'sampler', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'import', null),
            (${ids('gs-expired')}, 'silver_self_paced', 'expired', now() - interval '70 days', now() - interval '10 days',
              now() - interval '7 days', 'payment', null),
            (${ids('gs-scheduled')}, 'sampler', 'scheduled', now() + interval '20 days', now() + interval '80 days',
              now() + interval '83 days', 'import', gen_random_uuid()),
            (${ids('gs-ops')}, 'silver_self_paced', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null),
            (${ids('gs-trainer')}, 'silver_self_paced', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null),
            (${ids('gs-super')}, 'silver_self_paced', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null);
          update public.profiles set is_paid = true where id in (${ids('gs-ops', 'gs-trainer', 'gs-super')});
          -- 3/4/11: finished the live version (written as postgres: the table has no client write path).
          insert into public.student_onboarding_progress (user_id, video_id, first_started_at, last_started_at, completed_at)
          values (${ids('gs-done')}, ${lit(live.videoId)}::uuid, now() - interval '1 minute', now() - interval '1 minute', now());
        end $seed$;`);
      // Only now does the rest of the suite have a video to test.
      video = live;
    })();
    await publishWork;
  });

// ── 1. The gate, for an approved student who has not watched it ─────────────────────────────

test('1 · an approved student meets the video before the Dashboard: locked until really played, keyboard-reachable, announced once, then the Dashboard with no welcome on top',
  { skip: SKIP || false, timeout: 8 * 60 * 1000 }, async () => {
    requireVideo();
    const who = people['gs-new'];
    let hold = null;
    // The gate's answer arrives late — after everything else the gate waits on — so the gate must
    // hold its splash through a 'loading' window that is #69's alone, instead of rendering the
    // Dashboard the video has to come before.
    const page = await openAs(who, '/', {
      width: 1280, height: 800, welcomed: false,
      beforeGoto: async (p) => { hold = await holdAnswerPastGateReads(p); },
    });
    try {
      // The gate — or the app shell, which must not come first. Either one ends the wait at once.
      const first = await page.waitFor(() => {
        const w = window.__gsWatch;
        if (w && w.marks.shell !== null) return { shell: true };
        const v = document.querySelector('.gs-stage[data-gs-mode="gate"] video');
        return !!document.querySelector('[data-gs-go]') && !!v && v.readyState >= 1 ? { gate: true } : false;
      }, [], { timeoutMs: 180000, what: 'the Getting Started gate with its video loaded' });
      assert.ok(hold?.pausedAt, 'the gate\'s answer was not held back, so the slow path was not exercised');
      const readTimes = JSON.stringify(Object.fromEntries(GATE_READS.map(([read]) => [read, hold.done[read] ? hold.done[read] - hold.pausedAt : null])));
      const unseen = GATE_READS.map(([read]) => read).filter((read) => !hold.done[read]);
      assert.deepEqual(unseen, [], `the gate's other reads were never seen to finish: ${unseen.join(', ')} (ms after the pause: ${readTimes})`);
      assert.equal(hold.capped, false,
        `the gate's other reads were still landing ${HOLD_CAP_MS} ms into the sign-in, so its 'loading' window may have been theirs, not #69's (ms after the pause: ${readTimes})`);
      assert.ok(!first.shell,
        `the app shell rendered before the gate — the Dashboard flashed while the answer was on its way (the gate's other reads, ms after the pause: ${readTimes})`);
      const lastRead = Math.max(...GATE_READS.map(([read]) => hold.done[read]));
      assert.ok(hold.releasedAt - lastRead >= HOLD_AFTER_MS,
        `the answer was released ${hold.releasedAt - lastRead} ms after the last of the gate's other reads (needs ${HOLD_AFTER_MS})`);
      const answer = await gsAnswer(page);
      assert.equal(answer.required, true, 'the server must ask this student to watch it');
      assert.equal(answer.videoId, video.videoId);
      assert.equal(await page.evaluate(() => document.querySelector('main.gs-surface h1')?.textContent.trim()),
        'Welcome to Toolkits, Gia!', 'the gate greets the student by first name');
      const w0 = await watchState(page);
      assert.equal(w0.marks.shell, null, 'the app shell rendered before the gate — the Dashboard flashed while the answer was on its way');
      assert.ok(await page.evaluate(recordGoButton), 'could not watch the Go button');

      // Locked: aria-disabled, never disabled, described by its hint.
      const locked = await page.evaluate(goState);
      assert.equal(locked.ariaDisabled, 'true', 'Go to dashboard must be aria-disabled before the video is watched');
      assert.equal(locked.disabledAttr, false, 'Go to dashboard must never carry the disabled attribute');
      assert.ok(locked.hint, 'the locked button names a hint through aria-describedby');
      await page.screenshot(join(ART, 'gate-locked.png'));

      // A keyboard reaches it: real Tab presses from the top of the page.
      const walk = await tabToGo(page);
      assert.ok(walk.reached, `Tab never reached Go to dashboard; focus went ${walk.path.join(' → ')}`);
      const axLocked = await axOfGo(page);
      assert.equal(axLocked.role, 'button');
      assert.equal(axLocked.name, 'Go to dashboard', 'the accessible name');
      assert.equal(axLocked.disabled, true, 'the accessibility tree must report the locked button as disabled');
      assert.equal(axLocked.description, locked.hint, 'the accessible description is the progress hint');

      // Enter while locked says why, and does nothing else.
      await press(page, 'Enter');
      await page.waitFor(() => {
        const go = document.querySelector('[data-gs-go]');
        const hint = go && document.getElementById(go.getAttribute('aria-describedby') || '');
        const live = document.querySelector('main.gs-surface [role="status"][aria-live="polite"]');
        return !!hint && !!live && live.textContent.trim() === hint.textContent.trim();
      }, [], { what: 'the locked press announcing the progress line' });
      const afterLockedPress = await page.evaluate(goState);
      assert.equal(afterLockedPress.ariaDisabled, 'true', 'a locked press must not unlock anything');
      assert.equal(afterLockedPress.busy, null, 'a locked press must not start recording a completion');

      // Play the clip — at a quarter speed, see GATE_RATE — and the button unlocks only once 90% of
      // it has really played.
      const play = await playVideo(page, 'gate', { rate: GATE_RATE });
      await page.waitFor(() => { const go = document.querySelector('[data-gs-go]'); return !!go && !go.hasAttribute('aria-disabled'); },
        [], { timeoutMs: 90000, what: 'Go to dashboard unlocking once the clip has played' });
      const log = await page.evaluate(() => window.__gsGo);
      const unlockAt = log.findIndex((e) => !e.locked);
      assert.ok(unlockAt > 0, 'the log must show the button locked first');
      const lockedSamples = log.slice(0, unlockAt).filter((e) => e.why === 'timeupdate' && e.current > 0);
      assert.ok(lockedSamples.length > 0, 'no sample showed the button still locked while the clip played');
      assert.ok(log.slice(unlockAt).every((e) => !e.locked), 'the button locked again after unlocking');
      assert.ok(log.every((e) => !e.disabledAttr), 'the disabled attribute appeared at some point');
      const u = log[unlockAt];
      const duration = u.duration || video.durationSeconds;
      // The samples the rule was evaluated on must be close enough together to place the 90%
      // boundary: the widest step between consecutive samples just before the unlock.
      const nearUnlock = lockedSamples.slice(-5);
      const widestStep = nearUnlock.slice(1).reduce((m, e, i) => Math.max(m, (e.played - nearUnlock[i].played) / duration), 0);
      assert.ok(nearUnlock.length >= 3 && widestStep <= 0.05,
        `the watch rule was sampled ${(100 * widestStep).toFixed(1)}% of the clip apart near the unlock (${nearUnlock.length} samples) — too coarse to tell 90% from 85%`);
      // `played` is read after the unlock was committed, so it is never less than what the rule saw.
      assert.ok(u.played / duration >= ONBOARDING_WATCH_MIN_FRACTION,
        `unlocked after ${(100 * u.played / duration).toFixed(1)}% had played (needs ${ONBOARDING_WATCH_MIN_FRACTION * 100}%)`);
      assert.ok(u.ended || duration - u.current <= ONBOARDING_NEAR_END_SECONDS + 0.05,
        `unlocked ${(duration - u.current).toFixed(2)}s before the end, neither ended nor within the near-end window`);
      assert.equal(u.described, false, 'the unlocked button no longer points at a "keep watching" hint');

      const unlocked = await page.evaluate(goState);
      assert.equal(unlocked.focused, true, 'the unlock must leave focus on Go to dashboard');
      const axUnlocked = await axOfGo(page);
      assert.equal(axUnlocked.name, 'Go to dashboard');
      assert.equal(axUnlocked.disabled, false, 'the accessibility tree must report the unlocked button as enabled');
      await page.screenshot(join(ART, 'gate-unlocked.png'));

      // The server keeps its own floor, counted from the first start; press only once it has
      // passed. (A press INSIDE the floor, and the server refusing it, is test 6.)
      const sinceStart = await waitForServerFloor(who.id);
      const w1 = await watchState(page);
      const unlockAnnouncements = w1.live.filter((e) => /\bunlocked\b/i.test(e.text));
      assert.equal(unlockAnnouncements.length, 1,
        `the unlock must be announced exactly once in the polite live region; it was announced ${unlockAnnouncements.length} times`);

      // Enter on the unlocked button: the completion, then the Dashboard.
      assert.equal((await page.evaluate(focusState)).go, true, 'focus left Go to dashboard before the press');
      await press(page, 'Enter');
      await page.waitFor(onDashboard, [], { timeoutMs: 60000, what: 'the Dashboard after Go to dashboard' });
      // The button's log ran on through the press until the gate unmounted (the SPA keeps the
      // document): while the completion was being recorded the button was aria-busy and locked —
      // and at no point did it carry the disabled attribute, which would have dropped the
      // student's focus to <body> in the middle of the call.
      const fullLog = await page.evaluate(() => window.__gsGo);
      const pressPhase = fullLog.slice(unlockAt + 1).filter((e) => e.why === 'attr');
      assert.ok(pressPhase.some((e) => e.busy && e.locked),
        `the press was never seen on the button — no aria-busy state after the unlock: ${JSON.stringify(pressPhase.map((e) => ({ locked: e.locked, busy: e.busy })))}`);
      assert.ok(fullLog.every((e) => !e.disabledAttr),
        'the disabled attribute appeared on Go to dashboard — before the unlock, or while the completion was being recorded');
      // The gate's completion handler calls dismissWelcome(), which writes this flag. The welcome
      // was already scheduled while the gate was up (this account had never seen it); the flag
      // being written proves the handler closed it, and the watcher proves it never painted.
      await page.waitFor((uid) => localStorage.getItem(`u:${uid}:onboarding:welcomed`) === '1', [who.id],
        { what: 'the first-login welcome closed by the gate' });
      await page.evaluate(settleAnimations);
      const w2 = await watchState(page);
      assert.equal(w2.marks.welcome, null, 'the first-login WelcomeOverlay was stacked on the Dashboard');
      assert.equal(await page.evaluate(() => !!document.getElementById('welcome-overlay-title')), false, 'the WelcomeOverlay is showing');
      assert.ok(w2.marks.shell > w2.marks.gate, 'the app shell must render only after the gate');
      const card = await page.waitFor(gsCard, [], { timeoutMs: 30000, what: 'the Getting Started card on the Dashboard' });
      assert.equal(card.chip, 'Completed', 'the Dashboard card shows the completion at once');
      await page.screenshot(join(ART, 'dashboard-after-gate.png'));

      const row = await progressRow(who.id);
      assert.ok(row, 'no student_onboarding_progress row for the live version');
      assert.ok(row.completed_at, 'the completion was not recorded');
      const heldFor = Math.round((row.completed_s - row.first_started_s) * 10) / 10;

      // One answer per sign-in, one start and one completion per mount, 1–2 signing calls.
      assert.equal(page.rpcs.count('my_onboarding_video'), 1, 'my_onboarding_video must be read once per sign-in');
      assert.equal(page.rpcs.count('start_onboarding_video'), 1, 'start_onboarding_video once per mount');
      assert.equal(page.rpcs.count('complete_onboarding_video'), 1, 'exactly one completion — the locked press sent none');
      const posts = signPosts(page);
      assert.ok(posts >= 1 && posts <= 2, `the gate's player signed its video ${posts} times (1–2 per mount)`);
      assert.ok(signedGets(page) >= 1, 'the video was not loaded from its signed URL');
      assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');
      assert.deepEqual(pageErrors(page), [], 'the gate raised errors');
      note('1-gate', {
        tabPath: walk.path, axLocked, axUnlocked, lockedHint: locked.hint,
        unlock: { playedPct: Math.round(1000 * u.played / duration) / 10, secondsBeforeEnd: Math.round((duration - u.current) * 100) / 100, ended: u.ended, why: u.why },
        rate: play.rate, lockedSamplesWhilePlaying: lockedSamples.length, widestStepPct: Math.round(1000 * widestStep) / 10,
        pressPhase: pressPhase.map((e) => ({ locked: e.locked, busy: e.busy, disabledAttr: e.disabledAttr, focused: e.focused })),
        unlockAnnouncements: unlockAnnouncements.length, liveRegion: w1.live.map((e) => e.text.trim()).filter(Boolean),
        secondsFromFirstStartToPress: Math.round(sinceStart * 10) / 10, recordedSecondsAfterStart: heldFor,
        marks: w2.marks, visibility: play.visibility, signPosts: posts,
        hold: {
          ms: hold.releasedAt - hold.pausedAt,
          pausedMsAfterTheFirstRequest: hold.pausedAt - hold.firstRequestAt,
          readsFinishedMsAfterThePause: Object.fromEntries(GATE_READS.map(([read]) => [read, hold.done[read] - hold.pausedAt])),
        },
        rpcs: { my: 1, start: 1, complete: 1 },
      });
    } finally {
      await page.close();
    }
  });

// ── 2. The gate's layout, its requests, and a skip to the end ────────────────────────────────

test('2 · the gate fits a phone and three laptops in light and dark, is keyboard-reachable on the phone in dark, signs its video 1–2 times, asks once, and a skip to the end does not unlock it',
  { skip: SKIP || false, timeout: 8 * 60 * 1000 }, async () => {
    requireVideo();
    const page = await openAs(people['gs-layout'], '/', { width: 1280, height: 800, theme: 'light' });
    try {
      await waitForGateVideo(page);
      const answer = await gsAnswer(page);
      assert.equal(answer.required, true);
      const failures = [];
      const measured = [];
      for (const [w, h] of [...LAPTOPS, PHONE]) {
        for (const theme of ['light', 'dark']) {
          await page.setViewport({ width: w, height: h });
          await page.setMedia({ colorScheme: theme });
          await page.waitFor((t) => document.documentElement.getAttribute('data-theme') === t, [theme], { what: `the ${theme} theme` });
          await page.evaluate(settleAnimations);
          const m = await page.evaluate(measureGate, { fold: w >= 1024 });
          const tag = `${w}x${h} ${theme}`;
          if (m.error) failures.push(`${tag}: ${m.error}`);
          for (const p of m.problems || []) failures.push(`${tag}: ${p}`);
          measured.push({ tag, go: m.go, hint: m.hint, stage: m.stage });
          await page.screenshot(join(ART, `gate-${w}x${h}-${theme}.png`));
        }
      }
      note('2-layout', { measured });
      assert.deepEqual(failures, [], `the gate's layout:\n  ${failures.join('\n  ')}`);

      // The keyboard and the accessibility tree on the PHONE, in DARK mode — where the loop above
      // ended — and still locked (nothing has played): Tab reaches Go to dashboard, and the tree
      // names it, says it is disabled and reads its hint.
      const phone = await page.evaluate(() => ({ width: window.innerWidth, theme: document.documentElement.getAttribute('data-theme') }));
      assert.deepEqual(phone, { width: PHONE[0], theme: 'dark' }, 'the keyboard check must run at 390×844 in dark mode');
      const lockedHint = (await page.evaluate(goState)).hint;
      const walk = await tabToGo(page);
      assert.ok(walk.reached, `on the phone, Tab never reached Go to dashboard; focus went ${walk.from} → ${walk.path.join(' → ')}`);
      const ax = await axOfGo(page);
      assert.equal(ax.role, 'button', 'on the phone: the role');
      assert.equal(ax.name, 'Go to dashboard', 'on the phone: the accessible name');
      assert.equal(ax.disabled, true, 'on the phone: the accessibility tree must report the locked button as disabled');
      assert.equal(ax.description, lockedHint, 'on the phone: the accessible description is the progress hint');
      note('2-layout', { phoneDark: { tabFrom: walk.from, tabPath: walk.path, ax } });
      // Leave the gate as the negative control below measures it: nothing focused, not scrolled.
      await page.evaluate(() => {
        document.activeElement?.blur?.();
        const s = document.querySelector('main.gs-surface')?.closest('.overflow-y-auto');
        if (s) s.scrollTop = 0;
        return true;
      });

      // NEGATIVE CONTROL: a probe that cannot fail proves nothing. Put the failure class back in
      // the live gate — a box pulled over its neighbour, a box wider than the window, and Go
      // pushed below the fold — require the probe to report each, then take them away again.
      await page.setViewport({ width: 1366, height: 657 });
      await page.setMedia({ colorScheme: 'light' });
      await page.waitFor(() => document.documentElement.getAttribute('data-theme') === 'light', [], { what: 'the light theme' });
      await page.evaluate(settleAnimations);
      const MUTANT = `main.gs-surface .gs-progress, main.gs-surface [data-gs-go] ~ details { margin-top: -48px !important; }
        main.gs-surface .gs-journey { min-width: 2400px !important; }
        main.gs-surface [data-gs-go] { margin-top: 240px !important; }`;
      await page.evaluate((css) => {
        const s = document.createElement('style');
        s.id = 'e2e-gs-mutant';
        s.textContent = css;
        document.head.appendChild(s);
        return true;
      }, MUTANT);
      const caught = await page.evaluate(measureGate, { fold: true });
      await page.evaluate(() => { document.getElementById('e2e-gs-mutant')?.remove(); return true; });
      assert.ok(caught.problems.some((p) => /overlap/.test(p)), `the probe missed an overlap put in front of it: ${caught.problems.join(' | ') || 'nothing'}`);
      assert.ok(caught.problems.some((p) => /sideways|outside the window/.test(p)), `the probe missed a sideways overflow: ${caught.problems.join(' | ') || 'nothing'}`);
      assert.ok(caught.problems.some((p) => /^Go to dashboard needs scrolling/.test(p)), `the probe missed Go below the fold: ${caught.problems.join(' | ') || 'nothing'}`);
      await page.evaluate(settleAnimations);
      const clean = await page.evaluate(measureGate, { fold: true });
      assert.deepEqual(clean.problems, [], 'the gate did not measure clean again once the mutant was removed');
      note('2-layout', { negativeControl: caught.problems.slice(0, 6) });

      // Resizing and re-theming never remounted the player: still one mount's worth of requests.
      assert.equal(page.rpcs.count('my_onboarding_video'), 1, 'my_onboarding_video must be read once per sign-in');
      assert.equal(page.rpcs.count('start_onboarding_video'), 1, 'start_onboarding_video once per mount');
      const posts = signPosts(page);
      assert.ok(posts >= 1 && posts <= 2, `the gate's player signed its video ${posts} times (1–2 per mount)`);
      assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');

      // A skip to the end is not a watch: the button stays locked and says how much was watched.
      await page.setViewport({ width: 1280, height: 800 });
      await page.setMedia({ colorScheme: 'light' });
      const seek = await page.evaluate(async () => {
        const v = document.querySelector('.gs-stage[data-gs-mode="gate"] video');
        v.muted = true;
        const seeked = new Promise((r) => v.addEventListener('seeked', r, { once: true }));
        v.currentTime = Math.max(0, v.duration - 0.3);
        await seeked;
        try { await v.play(); } catch (e) { return { error: e.name }; }
        return { from: v.currentTime, duration: v.duration };
      });
      assert.ok(!seek.error, `play() after the seek: ${seek.error}`);
      const skipped = await page.waitFor(() => {
        const v = document.querySelector('.gs-stage[data-gs-mode="gate"] video');
        const go = document.querySelector('[data-gs-go]');
        const hint = go && document.getElementById(go.getAttribute('aria-describedby') || '');
        if (!v || !v.ended || !go) return false;
        if (!go.hasAttribute('aria-disabled')) return { unlocked: true };
        return hint && /\d+%/.test(hint.textContent) ? { unlocked: false, hint: hint.textContent.trim() } : false;
      }, [], { timeoutMs: 30000, what: 'the skipped-to clip reaching its end' });
      assert.equal(skipped.unlocked, false, 'seeking to the end unlocked Go to dashboard');
      assert.deepEqual(pageErrors(page), [], 'the gate raised errors');
      note('2-layout', { skipToEnd: skipped, signPosts: posts, rpcs: { my: 1, start: 1 } });
    } finally {
      await page.close();
    }
  });

// ── 3. A student who finished it ─────────────────────────────────────────────────────────────

test('3 · a student who finished it goes straight to the Dashboard; the card says Completed, and a replay leaves completed_at alone',
  { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
    requireVideo();
    const who = people['gs-done'];
    const page = await openAs(who, '/');
    try {
      await page.waitFor(onDashboard, [], { timeoutMs: 180000, what: 'the Dashboard' });
      const answer = await gsAnswer(page);
      assert.equal(answer.completed_current, true);
      await assertNeverGated(page, 'a student who finished it', answer);
      const card = await page.waitFor(gsCard, [], { timeoutMs: 60000, what: 'the Getting Started card' });
      assert.equal(card.chip, 'Completed', 'the card shows the completion');
      assert.equal(card.toggle, 'Open video', 'the closed card offers the video (a paused player); the chip carries the completion');
      assert.equal(card.title, VIDEO.title);

      const before0 = await progressRow(who.id);
      assert.ok(before0?.completed_at, 'the seeded completion is missing');
      assert.ok(await page.evaluate(() => { const b = document.querySelector('.gs-card button[aria-controls]'); b.click(); return true; }));
      await waitForPlayer(page, 'card', "the card's player");
      await playVideo(page, 'card');
      await page.waitFor(() => document.querySelector('.gs-stage[data-gs-mode="card"] video')?.ended === true,
        [], { timeoutMs: 60000, what: 'the replay playing to its end' });
      await page.screenshot(join(ART, 'card-replayed.png'));
      const after0 = await progressRow(who.id);
      assert.equal(after0.completed_at, before0.completed_at, 'a replay re-stamped completed_at');
      assert.equal(after0.first_started_at, before0.first_started_at, 'a replay moved first_started_at');
      assert.ok(after0.last_started_s > before0.last_started_s, 'the replay\'s start was not recorded');
      assert.equal(page.rpcs.count('complete_onboarding_video'), 0, 'a replay of a finished version sends no completion');
      assert.equal(page.rpcs.count('start_onboarding_video'), 1, 'one start for the one card player');
      const posts = signPosts(page);
      assert.ok(posts >= 1 && posts <= 2, `the card's player signed its video ${posts} times (1–2 per mount)`);
      assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');
      assert.deepEqual(pageErrors(page), [], 'the Dashboard raised errors');
      note('3-completed', { card, completedAt: 'unchanged', lastStartedAt: 'advanced', rpcs: { complete: 0, start: 1 }, signPosts: posts });
    } finally {
      await page.close();
    }
  });

// ── 4. Keep-alive tabs, and the sidebar ──────────────────────────────────────────────────────

test('4 · a hidden tab pauses the replay in page and card modes — the same <video>, where it was — each player signing 1–2 times; the sidebar lists Getting Started directly above Dashboard, open and as the rail',
  { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
    requireVideo();
    const page = await openAs(people['gs-done'], '/getting-started');
    try {
      await page.waitFor(onGettingStartedTab, [], { timeoutMs: 180000, what: 'the Getting Started page' });
      await waitForPlayer(page, 'page', "the page's player");
      // One mount, one signing (two under StrictMode's double mount) — counted once its video has
      // loaded, by which point every signing call of the mount has been made.
      const pageSigns = signPosts(page);
      assert.ok(pageSigns >= 1 && pageSigns <= 2, `the page's player signed its video ${pageSigns} times (1–2 per mount)`);
      assert.ok(await bodyHas(page, 'Completed on'), 'the page says when it was finished');

      // PAGE mode: playing, then hidden. At a tenth of normal speed the 3 s clip plays for 30 s,
      // three times longer than the wait below — so a video that stops here was PAUSED; it cannot
      // have simply reached its end (an ended video reports paused too). And the element is tagged
      // while it plays, so the paused one must be THAT element, not a fresh one a remounted
      // player put in its place — which is paused because it never played.
      await playVideo(page, 'page', { rate: SLOW_RATE });
      await page.waitFor(tagPlaying, ['page'], { what: 'the page replay playing' });
      assert.ok(await page.evaluate(clickNav, '/'), 'no Dashboard link in the sidebar');
      await page.waitFor(onDashboard, [], { timeoutMs: 60000, what: 'the Dashboard tab' });
      const pageMode = await waitForHiddenPause(page, 'page');
      assert.equal(pageMode.present, true, 'the page\'s <video> is gone from the hidden tab');
      assert.equal(pageMode.same, true, 'the <video> that was playing in the page was replaced while its tab was hidden');
      assert.equal(pageMode.paused, true, 'the hidden Getting Started page\'s video kept playing');
      assert.equal(pageMode.ended, false, 'the page video ended rather than being paused');
      assert.ok(pageMode.currentTime > 0.05, `the page video was put back to ${pageMode.currentTime}s rather than paused where it was`);
      assert.equal(pageMode.hidden, true, 'the page video is not in a hidden panel');

      // CARD mode: expanded and playing on the Dashboard, then the tab changes back.
      await page.waitFor(gsCard, [], { timeoutMs: 60000, what: 'the Getting Started card' });
      assert.ok(await page.evaluate(() => { const b = document.querySelector('.gs-card button[aria-controls]'); b.click(); return true; }));
      await waitForPlayer(page, 'card', "the card's player");
      const cardSigns = signPosts(page) - pageSigns;
      assert.ok(cardSigns >= 1 && cardSigns <= 2, `the card's player signed its video ${cardSigns} times (1–2 per mount)`);
      await playVideo(page, 'card', { rate: SLOW_RATE });
      await page.waitFor(tagPlaying, ['card'], { what: 'the card replay playing' });
      assert.ok(await page.evaluate(clickNav, '/getting-started'), 'no Getting Started link in the sidebar');
      await page.waitFor(onGettingStartedTab, [], { timeoutMs: 60000, what: 'the Getting Started tab again' });
      const cardMode = await waitForHiddenPause(page, 'card');
      assert.equal(cardMode.present, true, 'the card\'s <video> is gone from the hidden tab');
      assert.equal(cardMode.same, true, 'the <video> that was playing in the card was replaced while its tab was hidden');
      assert.equal(cardMode.paused, true, 'the hidden Dashboard card\'s video kept playing');
      assert.equal(cardMode.ended, false, 'the card video ended rather than being paused');
      assert.ok(cardMode.currentTime > 0.05, `the card video was put back to ${cardMode.currentTime}s rather than paused where it was`);
      assert.equal(cardMode.hidden, true, 'the card video is not in a hidden panel');

      // The sidebar, open: Getting Started directly above Dashboard.
      const open = await page.evaluate(sidebarOrder);
      assert.ok(!open.error, open.error);
      assert.equal(open.label, 'Getting Started');
      assert.equal(open.di, open.gi + 1, `Getting Started is not directly above Dashboard: ${JSON.stringify(open.first)}`);
      assert.equal(open.above, true, 'Getting Started does not sit above Dashboard');
      assert.equal(open.icon, true, 'the Getting Started item has no icon');
      await page.screenshot(join(ART, 'sidebar-open.png'));

      // …and collapsed to the rail, where the item is its icon.
      assert.ok(await page.evaluate(() => { const b = document.querySelector('[aria-label="Collapse sidebar"]'); if (!b) return false; b.click(); return true; }));
      await page.waitFor(sidebarIs, [true], { what: 'the collapsed rail' });
      await page.evaluate(settleAnimations);
      const rail = await page.evaluate(sidebarOrder);
      assert.ok(!rail.error, rail.error);
      assert.equal(rail.label, 'Getting Started', 'the rail item is named for a screen reader');
      assert.equal(rail.di, rail.gi + 1, `on the rail Getting Started is not directly above Dashboard: ${JSON.stringify(rail.first)}`);
      assert.equal(rail.above, true, 'on the rail Getting Started does not sit above Dashboard');
      assert.equal(rail.icon, true, 'the rail shows no Getting Started icon');
      await page.screenshot(join(ART, 'sidebar-rail.png'));
      await page.evaluate(() => document.querySelector('[aria-label="Expand sidebar"]')?.click());

      // Hiding and showing tabs never re-signed a kept-alive player.
      assert.equal(signPosts(page), pageSigns + cardSigns, 'a player signed its video again while its tab was hidden or shown');
      assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');
      assert.deepEqual(pageErrors(page), [], 'the Getting Started page or the Dashboard raised errors');
      note('4-keepalive-sidebar', { pageMode, cardMode, signPosts: { page: pageSigns, card: cardSigns }, sidebarOpen: open, sidebarRail: rail });
    } finally {
      await page.close();
    }
  });

// ── 5. Unpaid and pending students ───────────────────────────────────────────────────────────

test('5 · unpaid and pending students get the paywall and the pending screen — no Getting Started, and the player never starts',
  { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
    for (const [label, marker] of [['gs-unpaid', 'Enroll in Toolkits by Alex'], ['gs-pending', 'Payment Under Review']]) {
      const page = await openAs(people[label], '/');
      try {
        await page.waitFor((m) => document.body.textContent.includes(m), [marker], { timeoutMs: 180000, what: `${label}'s screen` });
        const answer = await gsAnswer(page);
        assert.equal(answer.eligible, false, `${label} is not a member yet`);
        await assertNeverGated(page, label, answer);
        assert.equal(await noGettingStarted(page), true, `${label}'s screen shows a Getting Started player or card`);
        assert.equal(page.rpcs.count('start_onboarding_video'), 0, `${label} started the video`);
        assert.equal(page.rpcs.count('complete_onboarding_video'), 0, `${label} completed the video`);
        assert.equal(page.rpcs.count('my_onboarding_video'), 1, 'my_onboarding_video must be read once per sign-in');
        assert.deepEqual(pageErrors(page), [], `${label}'s screen raised errors`);
        await page.screenshot(join(ART, `${label}.png`));
        note(`5-${label}`, { screen: marker, answer });
      } finally {
        await page.close();
      }
    }
  });

// ── 6. A migrated student ─────────────────────────────────────────────────────────────────────

test('6 · a migrated student: account setup → the summary, whose button now reads Continue → Getting Started, where a press inside the server\'s floor is refused and records nothing → Dashboard',
  { skip: SKIP || false, timeout: 8 * 60 * 1000 }, async () => {
    requireVideo();
    const who = people['gs-import'];
    const page = await openAs(who, '/');
    try {
      await page.waitFor(() => !!document.getElementById('setup-email'), [], { timeoutMs: 180000, what: 'the account setup page' });
      const form = await page.evaluate(() => ({
        name: document.getElementById('setup-name').value,
        locked: document.getElementById('setup-email').readOnly,
      }));
      assert.equal(form.name, 'Ina Villanueva', 'the name is prefilled');
      assert.equal(form.locked, true, 'the sign-in email is locked');
      // The persona's own password: setting it again is accepted as "already set".
      await typeInto(page, '#setup-password', E2E_PASSWORD);
      await typeInto(page, '#setup-confirm', E2E_PASSWORD);
      assert.ok(await clickButton(page, 'Create my account'), 'no Create my account button');

      await page.waitFor(() => [...document.querySelectorAll('button')].some((b) => ['Continue', 'Go To Dashboard'].includes(b.textContent.trim())),
        [], { timeoutMs: 60000, what: 'the one-time summary' });
      await page.waitFor(() => document.body.textContent.includes('Essentials') && document.body.textContent.includes('Active'),
        [], { timeoutMs: 30000, what: 'the summary facts' });
      const labels = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
      assert.ok(labels.includes('Continue'), `the summary's button must read Continue when Getting Started comes next; saw ${JSON.stringify(labels)}`);
      assert.ok(!labels.includes('Go To Dashboard'), 'the summary still says Go To Dashboard');
      await page.screenshot(join(ART, 'import-summary.png'));
      const answer = await gsAnswer(page);
      assert.equal(answer.required, true, 'the server must ask this migrated student to watch it');

      const signsBeforeGate = signPosts(page);
      assert.ok(await clickButton(page, 'Continue'));
      await waitForGateVideo(page, 'the Getting Started gate after the summary');
      const gateSigns = signPosts(page) - signsBeforeGate;
      assert.ok(gateSigns >= 1 && gateSigns <= 2, `the gate's player signed its video ${gateSigns} times (1–2 per mount)`);
      assert.equal((await watchState(page)).marks.shell, null, 'the Dashboard rendered before Getting Started');

      // A press INSIDE the server's floor: the server's own elapsed guard refuses it, and the screen
      // must say so, keep the student where they are, and record nothing.
      // ★ The start is RE-STAMPED TO NOW the moment the button unlocks (as postgres — the fixture
      //   idiom of test 0's seed). Signing and loading the clip can eat most of a 5 s floor: a press
      //   made "as soon as it unlocked" once reached the server with 1 s to spare, so on a slower
      //   run it would land after the floor and test nothing. Re-stamped, the press lands seconds
      //   inside the floor every time, and what is tested is unchanged: the server's guard, and the
      //   screen's handling of its refusal.
      await playVideo(page, 'gate', { rate: FAST_RATE });
      await page.waitFor(() => { const go = document.querySelector('[data-gs-go]'); return !!go && !go.hasAttribute('aria-disabled'); },
        [], { timeoutMs: 60000, what: 'Go to dashboard unlocking' });
      const restamped = await runSql(`update public.student_onboarding_progress
           set first_started_at = now(), last_started_at = now()
         where user_id = ${lit(who.id)}::uuid and video_id = ${lit(video.videoId)}::uuid and completed_at is null
        returning 1 as one`);
      assert.equal(restamped.length, 1, 'the student\'s start of the live version was not found to re-stamp');
      assert.ok(await clickButton(page, 'Go to dashboard'), 'no Go to dashboard button');
      const early = await page.waitFor(() => {
        const panel = [...document.querySelectorAll('main [aria-hidden="false"]')].find((el) => !el.hidden);
        if (panel && [...panel.querySelectorAll('h1')].some((h) => /Get Hired With Alex/.test(h.textContent))) return { dashboard: true };
        const msg = [...document.querySelectorAll('main.gs-surface [role="status"], main.gs-surface [role="alert"]')]
          .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
          .find((t) => /^Almost there — try again in a few seconds\.$/.test(t));
        return msg ? { message: msg, path: location.pathname, gate: !!document.querySelector('[data-gs-go]') } : false;
      }, [], { timeoutMs: 30000, what: 'the answer to a press inside the server\'s floor' });
      assert.ok(!early.dashboard, 'a press inside the server\'s floor opened the Dashboard');
      assert.equal(early.gate, true, 'a refused press must leave the student on the Getting Started screen');
      assert.equal(early.path, '/');
      assert.equal((await watchState(page)).marks.shell, null, 'a refused press opened the app');
      const refused = page.rpcs.calls.filter((c) => c.name === 'complete_onboarding_video');
      assert.deepEqual(refused.map((c) => c.status), [409], 'the press inside the floor is ONE call, refused by the server (HTTP 409)');
      const notYet = await progressRow(who.id);
      assert.ok(notYet, 'the start was not recorded');
      assert.equal(notYet.completed_at, null, 'a press inside the server\'s floor recorded a completion');
      const still = await page.evaluate(goState);
      assert.equal(still.ariaDisabled, null, 'the refusal locked Go to dashboard again');

      // Once the floor has passed, the same button records it.
      await waitForServerFloor(who.id);
      assert.ok(await clickButton(page, 'Go to dashboard'), 'no Go to dashboard button');
      await page.waitFor(onDashboard, [], { timeoutMs: 60000, what: 'the Dashboard' });

      const [prof] = await runSql(`select onboarding_status from public.profiles where id = ${lit(who.id)}::uuid`);
      assert.equal(prof.onboarding_status, 'completed', 'the account setup was recorded');
      const row = await progressRow(who.id);
      assert.ok(row?.completed_at, 'the Getting Started completion was not recorded');
      assert.deepEqual(page.rpcs.calls.filter((c) => c.name === 'complete_onboarding_video').map((c) => c.status), [409, 200],
        'one refusal inside the floor, then one completion');
      assert.equal(page.rpcs.count('start_onboarding_video'), 1, 'the refusal restarted the player');
      assert.equal(signPosts(page), signsBeforeGate + gateSigns, 'the refusal made the player sign its video again');
      assert.equal(await bodyHas(page, '₱'), false, 'a price was shown to a migrated student');
      assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');
      // The one refusal is pinned above, by its status list; nothing else may fail.
      assert.deepEqual(pageErrors(page, { allowUrls: /\/rest\/v1\/rpc\/complete_onboarding_video(?:\?|$)/ }), [],
        'the migrated student\'s flow raised errors');
      await page.screenshot(join(ART, 'import-dashboard.png'));
      note('6-import', {
        summaryButtons: labels.filter((l) => /Continue|Dashboard/.test(l)), earlyPress: early.message,
        signPosts: gateSigns, seeded: 'directly (profile + import term), not staged/activated',
      });
    } finally {
      await page.close();
    }
  });

// ── 7. Expired and scheduled members ─────────────────────────────────────────────────────────

test('7 · expired and scheduled members get their own screens, never the video',
  { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
    for (const [label, marker] of [['gs-expired', 'Membership limit reached'], ['gs-scheduled', 'You are all set']]) {
      const page = await openAs(people[label], '/');
      try {
        await page.waitFor((m) => document.body.textContent.includes(m), [marker], { timeoutMs: 180000, what: `${label}'s screen` });
        const answer = await gsAnswer(page);
        assert.equal(answer.eligible, false, `${label} holds no live term`);
        await assertNeverGated(page, label, answer);
        assert.equal(await noGettingStarted(page), true, `${label}'s screen shows a Getting Started player or card`);
        assert.equal(page.rpcs.count('start_onboarding_video'), 0, `${label} started the video`);
        assert.equal(page.rpcs.count('my_onboarding_video'), 1, 'my_onboarding_video must be read once per sign-in');
        assert.equal(page.rpcs.count('complete_onboarding_video'), 0, `${label} completed the video`);
        assert.deepEqual(pageErrors(page), [], `${label}'s screen raised errors`);
        await page.screenshot(join(ART, `${label}.png`));
        note(`7-${label}`, { screen: marker, answer });
      } finally {
        await page.close();
      }
    }
  });

// ── 7b. A lapsed member whose term is slow to load (T12-D1) ──────────────────────────────────
// ★ THE REGRESSION CHECK FOR T12-D1. While the enrollment reads are in flight, enrollGateState()
//   says 'pass' for a PAID profile with no term loaded yet (the grandfather rule) — so a hook
//   handed `enroll.state === 'pass'` alone saw a lapsed member "pass", and spent its one re-ask of
//   my_onboarding_video on the way in: a second read, and no re-ask left for a renewal later in
//   the same session (the gate then failed open). The fix hands the hook `enroll.ready && pass`
//   (gettingStartedEnrollPass). That bug has a window only once the member's PROFILE and the
//   gate's answer have BOTH landed while the term is still loading — so the term read is held past
//   the later of the two (holdTermReadPastAnswer), and the test checks that the window really
//   opened: the question first asked before the profile could say "paid", then the answer and the
//   profile both in before the term was let go, and the enrollment gate still waiting for it. When
//   it did not open — the profile or the answer slower than the hold's cap allows — the run FAILS;
//   it never passes on a window that was not there. On a build without the fix this test reads the
//   answer twice (shown on a private mirror with the fix reverted, with the profile on time and
//   with it slower than the answer).

test('7b · a lapsed member whose membership read is slow is still asked once — the slow read never spends the gate\'s one re-ask (T12-D1)',
  { skip: SKIP || false, timeout: 4 * 60 * 1000 }, async () => {
    requireVideo();   // test 0 seeds this member's lapsed term
    const who = people['gs-expired'];
    let hold = null;
    const page = await openAs(who, '/', { beforeGoto: async (p) => { hold = await holdTermReadPastAnswer(p); } });
    try {
      await page.waitFor((m) => document.body.textContent.includes(m), ['Membership limit reached'],
        { timeoutMs: 180000, what: 'the lapsed member\'s screen' });
      // Anything the page was going to ask, it has asked: the re-ask is the render right after the
      // later of the answer and the profile, and those and the term are all in by now — two more
      // seconds to be sure.
      const settleUntil = Math.max(Date.now(), (hold?.releasedAt || 0) + 2000);
      while (Date.now() < settleUntil) await tick(100);

      // The condition really happened — the term read was held, and the window opened inside it.
      assert.ok(hold?.pausedAt, 'the member\'s term read was never held, so the slow-term path was not exercised');
      const rel = (at) => (at === null || at === undefined ? null : at - hold.pausedAt);
      const firstAsk = page.rpcs.calls.find((c) => c.name === 'my_onboarding_video') || null;
      const timing = JSON.stringify({
        heldReads: hold.held,
        firstAskSentMsIntoTheHold: firstAsk ? rel(firstAsk.sentAt) : null,
        answerLandedMsIntoTheHold: rel(hold.answerDoneAt),
        profileLandedMsIntoTheHold: rel(hold.profileDoneAt),
        profileReads: hold.profileReads,
        releasedMsIntoTheHold: rel(hold.releasedAt),
      });
      assert.equal(hold.capped, false,
        `the gate's answer and the member's profile did not both land while the term was still loading (${timing}), `
        + 'so this run cannot tell the fix from the bug');
      assert.ok(hold.answerDoneAt !== null && hold.answerDoneAt < hold.releasedAt, `the answer landed after the term was released (${timing})`);
      assert.ok(hold.profileDoneAt !== null && hold.profileDoneAt < hold.releasedAt,
        `the member's profile landed after the term was released (${timing}), so the window T12-D1 needs never opened`);
      // …and the question was first asked before the profile could say "paid". Asked after it, a
      // build without the fix would have taken that first request for its re-ask, and asked once.
      assert.ok(firstAsk && firstAsk.sentAt < hold.profileDoneAt,
        `the gate's question was first asked after the member's profile had landed (${timing}), so a build without the fix could not be told apart`);
      // …and the enrollment gate waited for the term. Had its own 7 s timeout fired, it would have
      // failed OPEN — a settled 'pass' with no term — and the re-ask that follows is legitimate, so
      // the count below could not be blamed on T12-D1. The page says so when it happens.
      assert.equal(page.problems.some((p) => p.kind === 'console.warning' && /\[enroll\] gate load timed out/.test(p.text || '')), false,
        `the enrollment gate gave up waiting for the term (${timing}), so this run cannot tell the fix from the bug`);

      const answer = await gsAnswer(page);
      assert.equal(answer.eligible, false, 'a lapsed member holds no live term');
      await assertNeverGated(page, 'a lapsed member whose term loaded slowly', answer);
      const asks = page.rpcs.calls.filter((c) => c.name === 'my_onboarding_video')
        .map((c) => ({ msIntoTheHold: c.sentAt - hold.pausedAt, status: c.status }));
      assert.equal(asks.length, 1,
        `my_onboarding_video must be read once per sign-in, a slow term read included — it was read ${asks.length} times `
        + `(ms into the term hold: ${JSON.stringify(asks)}; ${timing}). A second read while the term was loading is T12-D1: `
        + 'the hook was handed a "pass" before the enrollment reads had landed.');
      assert.equal(page.rpcs.count('start_onboarding_video'), 0, 'a lapsed member started the video');
      assert.deepEqual(pageErrors(page), [], 'the lapsed member\'s screen raised errors');
      note('7b-slow-term', { asks, hold: JSON.parse(timing) });
    } finally {
      await page.close();
    }
  });

// ── 8. Operations Admin and Trainer ──────────────────────────────────────────────────────────

test('8 · an Operations Admin and a Trainer, each holding a paid term, are never held, have no admin row, are refused the admin screen\'s address — and the manager overview refuses their JWT',
  { skip: SKIP || false, timeout: 8 * 60 * 1000 }, async () => {
    requireVideo();
    const routed = servedTreeRoutesAdminScreen();
    const after0 = await firstTermAfterFirstPublish('gs-ops', 'gs-trainer');
    const ROLE_OF = { 'gs-ops': 'operations_admin', 'gs-trainer': 'trainer' };
    for (const label of ['gs-ops', 'gs-trainer']) {
      assert.equal(after0[people[label].id], true,
        `${label}'s first term must be newer than the first publish, so only the staff exclusion keeps them off the gate`);
      const page = await openAs(people[label], '/');
      try {
        await page.waitFor(onDashboard, [], { timeoutMs: 180000, what: `${label}'s Dashboard` });
        const answer = await gsAnswer(page);
        assert.equal(answer.eligible, true, `${label} holds a paid, live term`);
        assert.equal(answer.can_manage, false, `${label} must not manage the video`);
        await assertNeverGated(page, label, answer);
        // What follows means something only once the page KNOWS the role (waitForStaffContext):
        // until my_staff_context answers, every staff member is shown no admin row at all.
        const staffContext = await waitForStaffContext(page, label, ROLE_OF[label]);
        // No way to the Super Admin's screen: not a sidebar row, not a rail icon, not a Manage link.
        const links = await page.evaluate(adminLinks, ADMIN_SCREEN_PATH);
        assert.equal(links.toAdminScreen, 0, `${label} is offered a link to the Getting Started Video admin screen`);
        assert.equal(links.namedRows, 0, `${label}'s navigation has an item named Getting Started Video`);
        assert.ok(!links.rows.includes(ADMIN_SCREEN_PATH), `${label}'s Administration group lists the Getting Started Video screen: ${JSON.stringify(links.rows)}`);
        // The control: an Operations Admin's own admin rows ARE rendered, so the absence above is
        // the row's, not the whole admin group's. (A Trainer has no admin rows at all.) The same
        // build gives a Super Admin the row, FIRST — tests 9 and 13 — so the absence is the gate's.
        if (label === 'gs-ops') {
          assert.equal(links.enrollmentsRow, true, 'the Operations Admin\'s own admin rows are not rendered, so the check above proves nothing');
          assert.ok(links.rows.length > 0, 'the Operations Admin\'s Administration group lists nothing, so the check above proves nothing');
        }
        const { data, error } = await clientFor(await sessionFor(people[label])).rpc('admin_onboarding_video_overview');
        assert.equal(data, null, `${label} read the manager overview`);
        assert.ok(error && (error.hint === 'FORBIDDEN' || error.code === '42501'),
          `${label}: expected FORBIDDEN or 42501, got ${error ? `${error.code} ${error.hint}` : 'no error'}`);
        assert.equal(page.rpcs.count('complete_onboarding_video'), 0);
        assert.deepEqual(adminRpcs(page), [], `${label}'s Dashboard called a Getting Started Video admin RPC`);
        assert.deepEqual(pageErrors(page), [], `${label}'s Dashboard raised errors`);
        await page.screenshot(join(ART, `${label}.png`));
        note(`8-${label}`, { answer, staffContext, overview: `${error.code} ${error.hint}`, links });
      } finally {
        await page.close();
      }

      // The admin screen's address, typed: refused where the build has the screen — the ROLE
      // refusal, naming the role and selling nothing (T12B-D1), the screen never mounted — and sent
      // to the Dashboard where it has none. Either way, no admin RPC leaves the page.
      const typed = await openAs(people[label], ADMIN_SCREEN_PATH);
      try {
        // Again only once the page knows the role: until then the chokepoint refuses every admin
        // tab to every staff member, so a refusal read before it says nothing about this one.
        await waitForStaffContext(typed, label, ROLE_OF[label]);
        const outcome = await typed.waitFor(typedAddressOutcome, [], { timeoutMs: 180000, what: `${label}'s answer at ${ADMIN_SCREEN_PATH}` });
        const expected = routed ? 'refused' : 'dashboard';
        if (routed) {
          assert.equal(outcome.screen, 'refused', `${label} was not refused the Getting Started Video screen (saw ${outcome.screen})`);
          assert.equal(outcome.path, ADMIN_SCREEN_PATH, 'the refusal keeps the address that was typed');
          assert.equal(outcome.sells, false, `${label}'s refusal of an admin screen offers a plan or an upgrade (T12B-D1): ${outcome.text}`);
          assert.match(outcome.text, /your role/, `${label}'s refusal does not name their role (T12B-D1): ${outcome.text}`);
        } else {
          assert.equal(outcome.screen, 'dashboard', `a build without the admin screen must send its address to the Dashboard (saw ${outcome.screen})`);
        }
        assert.equal(outcome.adminScreen, false, `the Getting Started Video screen rendered for ${label}`);
        await tick(1500);   // anything the page was going to ask or render, it has by now
        // …and the answer still stands. Read again, so a screen that changed its mind after the
        // first read is caught on screen — not only by an admin RPC it might never send.
        const settled = await typed.evaluate(typedAddressOutcome);
        assert.equal(settled ? settled.screen : null, expected,
          `${label}'s answer at ${ADMIN_SCREEN_PATH} changed after it was first read (${outcome.screen} → ${settled ? settled.screen : 'nothing'})`);
        assert.equal(settled.adminScreen, false, `the Getting Started Video screen rendered for ${label} after the first read`);
        assert.deepEqual(adminRpcs(typed), [], `${label}'s typed address called a Getting Started Video admin RPC`);
        assert.deepEqual(pageErrors(typed), [], `${label}'s typed address raised errors`);
        note(`8-${label}`, { typedAddress: { routed, ...outcome, settled: settled.screen } });
      } finally {
        await typed.close();
      }
    }
  });

// ── 9. The Super Admin ───────────────────────────────────────────────────────────────────────

test('9 · the Super Admin — holding a paid term newer than the first publish — is never held, and the Dashboard card shows the manager view',
  { skip: SKIP || false, timeout: 5 * 60 * 1000 }, async () => {
    requireVideo();
    // Without a term of their own the Super Admin would be off the gate for want of one, whatever
    // the staff exclusion did; with one newer than the first publish, only that exclusion is left.
    const after0 = await firstTermAfterFirstPublish('gs-super');
    assert.equal(after0[people['gs-super'].id], true,
      'the Super Admin\'s first term must be newer than the first publish, so only the staff exclusion keeps them off the gate');
    const page = await openAs(people['gs-super'], '/');
    try {
      await page.waitFor(onDashboard, [], { timeoutMs: 180000, what: "the Super Admin's Dashboard" });
      const answer = await gsAnswer(page);
      assert.equal(answer.eligible, true, 'the Super Admin is eligible to watch it');
      assert.equal(answer.can_manage, true, 'the Super Admin manages the video');
      await assertNeverGated(page, 'the Super Admin', answer);
      const card = await page.waitFor(gsCard, [], { timeoutMs: 60000, what: 'the Getting Started card' });
      assert.equal(card.title, VIDEO.title, 'the card names the live version');
      assert.equal(card.chip, null, 'a manager is not a learner: the card shows no Completed / Not finished');
      assert.equal(card.toggle, 'Open video', 'a manager can still preview the live version');
      // The controls for test 8: on this same build a Super Admin HAS the row — the first one in
      // Administration — and the root DOES ask admin_onboarding_video_overview for its badge. So
      // an Operations Admin's or a Trainer's missing row and missing admin RPC are the gate's
      // doing, not a build that has neither. (A served snapshot without the screen has neither.)
      let group = null;
      if (servedTreeRoutesAdminScreen()) {
        // The group renders only once my_staff_context has answered (adminTabVisible() is false
        // while !staffReady, fail-closed by design), and the card can land first — a read taken
        // before then sees no group at all. So wait for the role, as test 8 does, then read it.
        await waitForStaffContext(page, 'the Super Admin', 'super_admin');
        group = await page.evaluate(adminGroup);
        assert.equal(group.present, true, 'the Super Admin\'s Administration group is not rendered');
        assert.equal(group.open, true, 'the Super Admin\'s Administration group is not open');
        assert.equal(group.rows[0]?.href, ADMIN_SCREEN_PATH,
          `the Super Admin's first Administration row is not the Getting Started Video screen: ${JSON.stringify(group.rows.map((r) => r.href))}`);
        assert.equal(group.rows[0]?.label, 'Getting Started Video');
        await waitForRpc(page, 'admin_onboarding_video_overview', { timeoutMs: 30000 });
      }
      assert.deepEqual(pageErrors(page), [], "the Super Admin's Dashboard raised errors");
      await page.screenshot(join(ART, 'super-dashboard.png'));
      note('9-super', {
        answer, card, firstTermAfterFirstPublish: true,
        firstAdminRow: group ? group.rows[0] : 'the served build has no Getting Started Video screen',
        overviewReads: page.rpcs.count('admin_onboarding_video_overview'),
      });
    } finally {
      await page.close();
    }
  });

// ── 10. A member from before the first publish (the cutoff) ─────────────────────────────────

test('10 · a member whose first term predates the first publish is never held (the cutoff), and still gets the first-login welcome',
  { skip: SKIP || false, timeout: 5 * 60 * 1000 }, async () => {
    requireVideo();
    const page = await openAs(people['gs-existing'], '/', { welcomed: false });
    try {
      await page.waitFor(onDashboard, [], { timeoutMs: 180000, what: 'the Dashboard' });
      // The control for `welcomed: false`: an account that is NOT held sees the first-login welcome,
      // so its absence after the gate (test 1) is the gate's doing, not the fixture's.
      await page.waitFor(() => !!document.getElementById('welcome-overlay-title'), [], { timeoutMs: 30000, what: 'the first-login welcome' });
      const answer = await gsAnswer(page);
      assert.equal(answer.eligible, true, 'an existing member with a live term');
      assert.equal(answer.completed, false, 'who never watched it');
      await assertNeverGated(page, 'an existing member', answer);
      const card = await page.waitFor(gsCard, [], { timeoutMs: 60000, what: 'the Getting Started card' });
      assert.equal(card.chip, null, 'never asked to watch it: the card shows no chip (the page calls it optional), and the video stays available, unforced');
      assert.deepEqual(pageErrors(page), [], 'the Dashboard raised errors');
      await page.screenshot(join(ART, 'existing-member.png'));
      note('10-existing', { answer, card, welcomeShown: true });
    } finally {
      await page.close();
    }
  });

// ── 11. The card and the tab, inside the app shell ───────────────────────────────────────────

// Each failure class measureShellSurface() claims to see, put back into the live surface: the
// probe must report every one, or a clean measurement proves nothing.
const CARD_MUTANTS = [
  ['a box wider than the card', '.gs-card .gs-card__actions { min-width: 1600px !important; }', /paints outside|sideways/],
  ['a box pulled over its neighbour', '.gs-card .gs-card__actions { margin-left: -240px !important; }', /overlap/],
  ['a text column squeezed to nothing', '.gs-card .gs-card__text { flex: 0 0 6px !important; }', /holds its text in|stacked/],
];
const PAGE_MUTANTS = [
  ['a box wider than the tab', 'main [aria-hidden="false"] section.gs-surface > div:first-child { min-width: 2400px !important; }', /paints outside|sideways/],
  ['a box pulled over its neighbour', 'main [aria-hidden="false"] section.gs-surface .gs-stage[data-gs-mode="page"] { margin-top: -90px !important; }', /overlap/],
];

/** Show the probe each failure class on the live surface — one at a time — then measure clean. */
async function negativeControl(page, target, mutants) {
  const caught = {};
  for (const [what, css, expect] of mutants) {
    await page.evaluate((c) => {
      const s = document.createElement('style');
      s.id = 'e2e-gs-shell-mutant';
      s.textContent = c;
      document.head.appendChild(s);
      return true;
    }, css);
    await page.evaluate(settleAnimations);
    const m = await page.evaluate(measureShellSurface, { target });
    await page.evaluate(() => { document.getElementById('e2e-gs-shell-mutant')?.remove(); return true; });
    assert.ok((m.problems || []).some((p) => expect.test(p)),
      `the ${target} probe missed ${what} put in front of it: ${(m.problems || []).join(' | ') || m.error || 'nothing'}`);
    caught[what] = (m.problems || []).filter((p) => expect.test(p)).slice(0, 2);
  }
  await page.evaluate(settleAnimations);
  const clean = await page.evaluate(measureShellSurface, { target });
  assert.deepEqual(clean.problems, [], `the ${target} did not measure clean again once the mutants were removed`);
  return caught;
}

test('11 · the Dashboard card, closed and open, and the Getting Started tab fit a phone, a 1024 and a 1280 window — sidebar open and as the rail, light and dark',
  { skip: SKIP || false, timeout: 10 * 60 * 1000 }, async () => {
    requireVideo();
    const failures = [];
    const measured = [];
    const controls = {};
    for (const rail of [false, true]) {
      // The rail exists from `lg` up; a phone is measured once, with the sidebar as its drawer.
      const sizes = rail ? SHELL_SIZES.filter(([w]) => w >= 1024) : SHELL_SIZES;
      const side = rail ? 'rail' : 'open';
      const page = await openAs(people['gs-done'], '/', { width: 1280, height: 800, railCollapsed: rail });
      try {
        await page.waitFor(onDashboard, [], { timeoutMs: 180000, what: 'the Dashboard' });
        await page.waitFor(sidebarIs, [rail], { timeoutMs: 30000, what: `the sidebar ${side}` });
        await page.waitFor(gsCard, [], { timeoutMs: 60000, what: 'the Getting Started card' });
        const sweep = async (state, target) => {
          for (const [w, h] of sizes) {
            for (const theme of ['light', 'dark']) {
              await page.setViewport({ width: w, height: h });
              await page.setMedia({ colorScheme: theme });
              await page.waitFor((t) => document.documentElement.getAttribute('data-theme') === t, [theme], { what: `the ${theme} theme` });
              await page.evaluate(settleAnimations);
              const m = await page.evaluate(measureShellSurface, { target });
              const tag = `${state} @${w}x${h} ${w >= 1024 ? side : 'phone'} ${theme}`;
              if (m.error) failures.push(`${tag}: ${m.error}`);
              for (const p of m.problems || []) failures.push(`${tag}: ${p}`);
              measured.push({ tag, ...(m.facts || {}) });
              if (theme === 'dark') await page.screenshot(join(ART, `shell-${state.replace(/\s+/g, '-')}-${w}x${h}-${w >= 1024 ? side : 'phone'}.png`));
            }
          }
          // Back to a laptop in light, where the sidebar's links can be clicked.
          await page.setViewport({ width: 1280, height: 800 });
          await page.setMedia({ colorScheme: 'light' });
          await page.waitFor(() => document.documentElement.getAttribute('data-theme') === 'light', [], { what: 'the light theme' });
          await page.evaluate(settleAnimations);
        };

        await sweep('card closed', 'card');
        if (!rail) controls.card = await negativeControl(page, 'card', CARD_MUTANTS);
        assert.ok(await page.evaluate(() => { const b = document.querySelector('.gs-card button[aria-controls]'); if (!b) return false; b.click(); return true; }),
          'no Open video on the card');
        await waitForPlayer(page, 'card', "the card's player");
        await sweep('card open', 'card');

        assert.ok(await page.evaluate(clickNav, '/getting-started'), 'no Getting Started link in the sidebar');
        await page.waitFor(onGettingStartedTab, [], { timeoutMs: 60000, what: 'the Getting Started tab' });
        await waitForPlayer(page, 'page', "the page's player");
        await sweep('tab', 'page');
        if (!rail) controls.page = await negativeControl(page, 'page', PAGE_MUTANTS);

        assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');
        assert.deepEqual(pageErrors(page), [], `the card or the tab raised errors (sidebar ${side})`);
      } finally {
        await page.close();
      }
    }
    note('11-shell-layout', { measured, negativeControl: controls });
    assert.deepEqual(failures, [], `the Getting Started card and tab in the app shell:\n  ${failures.join('\n  ')}`);
  });

// ── 12. Nothing live ─────────────────────────────────────────────────────────────────────────
// ★ KEEP THIS AFTER 0–11: it takes test 0's video down. Only test 13 comes after it, and that
//   one starts from — and leaves — nothing live.

test('12 · with the video unpublished nobody is held, and only a manager is told why',
  { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
    requireVideo();
    const { data, error } = await clientFor(await sessionFor(people['gs-super'])).rpc('admin_onboarding_video_unpublish', { p_video_id: video.videoId });
    assert.equal(error, null, error && `${error.hint} ${error.message}`);
    assert.equal(data?.changed, true, 'the live version did not come down');

    const admin = await openAs(people['gs-super'], '/');
    try {
      await admin.waitFor(onDashboard, [], { timeoutMs: 180000, what: "the Super Admin's Dashboard" });
      await admin.waitFor(() => [...document.querySelectorAll('[role="note"]')].some((n) => /No Getting Started video is live/.test(n.textContent)),
        [], { timeoutMs: 60000, what: "the manager's note that nothing is live" });
      const answer = await gsAnswer(admin);
      assert.equal(answer.videoId, null);
      assert.equal(answer.can_manage, true);
      assert.deepEqual(unsignedHits(admin), [], 'an onboarding object was requested other than through a signed URL');
      assert.deepEqual(pageErrors(admin), [], "the Super Admin's Dashboard raised errors with nothing live");
      await admin.screenshot(join(ART, 'super-none-live.png'));
    } finally {
      await admin.close();
    }

    const student = await openAs(people['gs-layout'], '/');
    try {
      await student.waitFor(onDashboard, [], { timeoutMs: 180000, what: 'the Dashboard' });
      const answer = await gsAnswer(student);
      await assertNeverGated(student, 'a student with nothing live', answer);
      assert.equal(await student.evaluate(() => !!document.querySelector('.gs-card') || [...document.querySelectorAll('[role="note"]')]
        .some((n) => /Getting Started/.test(n.textContent))), false, 'a student is shown a Getting Started card with nothing live');
      assert.deepEqual(unsignedHits(student), [], 'an onboarding object was requested other than through a signed URL');
      assert.deepEqual(pageErrors(student), [], 'the Dashboard raised errors');
      note('12-none-live', { studentAnswer: answer });
    } finally {
      await student.close();
    }
  });

// ── 13. The Super Admin's own screen, end to end ────────────────────────────────────────────
// ★ AFTER 12, which takes test 0's video down. With nothing live, the Super Admin's FIRST
//   Administration row says the video needs attention — to the eye (a count) and to a screen
//   reader (its name) — and so does the collapsed rail. Then the owner's own path: the row →
//   New video → a title (the draft is created on submit) → the draft editor → the real uploader,
//   given the clip through its <input type=file> (a resumable upload into the draft's folder,
//   which the app then signs back and plays before it says "ready") → Save draft → Publish,
//   confirmed in a dialog that says who is affected. The badge clears, a student approved after
//   that publish meets THIS video, and the test takes it down again.
// ★ Every write follows "Stopping test 0": halt() before each, the work in `screenWork`.
// ★ Everything the screen did is read back as postgres (the Management API), outside every policy.

const SCREEN_VIDEO = {
  title: `Welcome to Toolkits — uploaded on screen (e2e ${NONCE})`,
  description: 'Published through the Getting Started Video screen by the rendered suite.',
  transcript: `Hello from the on-screen upload (e2e ${NONCE}). This transcript was typed into the draft editor.`,
};
const BADGE_PHRASE = 'the Getting Started video needs attention';
const FIRST_ADMIN_ROW = '#sidebar-admin-list > li:first-child > a';
// A served snapshot from before the screen existed skips this test, and says why.
const SCREEN_SKIP = (() => {
  try {
    return servedTreeRoutesAdminScreen() ? false : 'the served build has no Getting Started Video screen';
  } catch (e) {
    return `the served build's routes could not be read: ${e.message}`;
  }
})();

test('13 · the Super Admin, with nothing live: the Getting Started Video row comes first in Administration and says it needs attention; New video → the real uploader → Save draft → Publish, confirmed → the badge clears, and a student approved after it meets THIS video',
  { skip: SKIP || SCREEN_SKIP, timeout: 10 * 60 * 1000 }, async (t) => {
    // Before every write: stop if this test has timed out, or the suite is shutting down.
    const halt = (step) => {
      if (stopping || t.signal.aborted) {
        throw new Error(`test 13 stopped before ${step}: ${stopping ? 'the suite is shutting down' : 'it ran out of time'}`);
      }
    };
    const superId = people['gs-super'].id;
    const superDb = clientFor(await sessionFor(people['gs-super']), { timeoutMs: 60000 });
    let liveId = null;   // the version THIS test made live, until it is taken down again
    screenWork = (async () => {
      try {
        // ── Nothing live to start from. Test 12 took test 0's video down; when it did not run (a
        //    name filter), what is live comes down the way 12 does it — the Super Admin's own session.
        const liveBefore = await runSql(`select id::text as id from public.onboarding_videos where status = 'published'`);
        for (const { id } of liveBefore || []) {
          halt('taking down what was live');
          const { data, error } = await superDb.rpc('admin_onboarding_video_unpublish', { p_video_id: id });
          assert.equal(error, null, error && `${error.hint} ${error.message}`);
          assert.equal(data?.changed, true, 'a live version did not come down');
        }
        assert.equal(await liveOnboardingVideoCount(), 0, 'a Getting Started video is still live, so this test cannot start from nothing live');
        const [cut] = await runSql(`select (extract(epoch from min(published_at)) * 1000)::float8 as ms from public.onboarding_videos`);
        const cutoffMs = Number.isFinite(cut?.ms) ? cut.ms : null;   // test 0's first publish, if it ran

        // The clip, as a file on disk — what a person picks is a file, and the uploader reads its
        // name, type, size and bytes from it.
        const theClip = clip || await recordClip(browser);
        const fileName = `welcome-${NONCE}.mp4`;
        const filePath = join(ART, fileName);
        writeFileSync(filePath, theClip.buffer);
        note('13-screen', { tookDownFirst: (liveBefore || []).length, cutoffAlreadySet: cutoffMs !== null, clipBytes: theClip.bytes, clipSeconds: theClip.durationSeconds });

        let videoId = null;
        let durationSeconds = null;
        const page = await openAs(people['gs-super'], '/', { width: 1280, height: 800 });
        try {
          // ── 1. Nothing live: the first Administration row, its badge, and what is said for it.
          await page.waitFor(onDashboard, [], { timeoutMs: 180000, what: "the Super Admin's Dashboard" });
          const badgeBy = Date.now() + 60000;
          let group = await page.evaluate(adminGroup);
          while (!group.rows[0]?.count) {
            assert.ok(Date.now() < badgeBy, `the first Administration row never showed an attention badge with nothing live: ${JSON.stringify(group)}`);
            await tick(150);
            group = await page.evaluate(adminGroup);
          }
          assert.equal(group.open, true, 'the Administration group is not open');
          assert.equal(group.rows[0].href, ADMIN_SCREEN_PATH,
            `the first Administration row is not the Getting Started Video screen: ${JSON.stringify(group.rows.map((r) => r.href))}`);
          assert.equal(group.rows[0].label, 'Getting Started Video');
          assert.equal(group.rows[0].count, '1', 'the attention badge shows 1');
          assert.ok((group.rows[0].spoken || '').includes(BADGE_PHRASE), `the row does not say why it is badged: "${group.rows[0].spoken}"`);
          const axBefore = await axNameOf(page, FIRST_ADMIN_ROW);
          assert.equal(axBefore.role, 'link');
          assert.match(axBefore.name, /^Getting Started Video\s*,\s*the Getting Started video needs attention$/,
            `the row's accessible name does not announce the badge: "${axBefore.name}"`);
          // The badge is the root's own read of the video's health.
          assert.ok(page.rpcs.count('admin_onboarding_video_overview') >= 1, 'the root never asked admin_onboarding_video_overview for the badge');
          await page.screenshot(join(ART, 'super-badge-open.png'));

          // …and the collapsed rail says the same, in its own words (an aria-label).
          assert.ok(await page.evaluate(() => { const b = document.querySelector('[aria-label="Collapse sidebar"]'); if (!b) return false; b.click(); return true; }),
            'no Collapse sidebar button');
          await page.waitFor(sidebarIs, [true], { what: 'the collapsed rail' });
          const rail = await page.evaluate(railAdminLinks);
          assert.ok(!rail.error, rail.error);
          assert.equal(rail.links[0]?.href, ADMIN_SCREEN_PATH, `the rail's first admin icon is not the Getting Started Video screen: ${JSON.stringify(rail.links)}`);
          assert.equal(rail.links[0]?.label, `Getting Started Video, ${BADGE_PHRASE}`, 'the rail icon does not announce the badge');
          await page.screenshot(join(ART, 'super-badge-rail.png'));
          assert.ok(await page.evaluate(() => { const b = document.querySelector('[aria-label="Expand sidebar"]'); if (!b) return false; b.click(); return true; }),
            'no Expand sidebar button');
          await page.waitFor(sidebarIs, [false], { what: 'the open sidebar again' });

          // ── 2. The screen, by its row.
          assert.ok(await page.evaluate(clickNav, ADMIN_SCREEN_PATH), 'the Getting Started Video row could not be clicked');
          await page.waitFor((p) => location.pathname === p && /Who sees this/.test(document.querySelector('.gs-admin')?.textContent || ''),
            [ADMIN_SCREEN_PATH], { timeoutMs: 60000, what: 'the Getting Started Video screen' });
          const health0 = await page.evaluate(healthBanner);
          assert.equal(health0?.role, 'status', `the nothing-live banner is not a polite status: ${JSON.stringify(health0)}`);
          assert.match(health0.text, /No Getting Started video is live/);

          // ── 3. New video: the title first — the draft is created on submit, because the
          //    upload's object name needs its id.
          assert.ok(await clickButton(page, 'New video'), 'no New video button');
          const PROMPT = 'New Getting Started video';
          await page.waitFor(dialogText, [PROMPT], { what: 'the title prompt' });
          await typeInto(page, `[role="dialog"][aria-label="${PROMPT}"] input`, SCREEN_VIDEO.title);
          halt('creating the draft');
          assert.ok(await page.evaluate(clickInDialog, PROMPT, 'Create draft'), 'no Create draft button');
          const EDITOR = `Edit “${SCREEN_VIDEO.title}”`;
          await page.waitFor(dialogText, [EDITOR], { timeoutMs: 60000, what: 'the draft editor' });
          for (const [label, text] of [['Description (optional)', SCREEN_VIDEO.description], ['Transcript (optional)', SCREEN_VIDEO.transcript]]) {
            assert.ok(await page.evaluate(focusLabelled, label), `no ${label} field in the draft editor`);
            await page.send('Input.insertText', { text });
          }

          // ── 4. The video, through the uploader's own <input type=file>.
          halt('uploading the clip');
          const sentFrom = page.requests.length;
          await setInputFiles(page, '[role="dialog"] input[type="file"]', [filePath]);
          const upload = await page.waitFor((label) => {
            const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.getAttribute('aria-label') === label);
            if (!d) return { error: 'the draft editor closed' };
            const alert = [...d.querySelectorAll('[role="alert"]')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()).find(Boolean);
            if (alert) return { error: alert };
            return /Uploaded — ready to save/.test(d.textContent) ? { ready: true } : false;
          }, [EDITOR], { timeoutMs: 180000, what: 'the upload to be verified ("Uploaded — ready to save")' });
          assert.ok(!upload.error, `the uploader refused or failed: ${upload.error}`);
          const sent = page.requests.slice(sentFrom);
          const tusHits = sent.filter((r) => /\/storage\/v1\/upload\/resumable/.test(r.url || ''));
          const storageHost = `${shadowEnv().SHADOW_PROJECT_REF}.storage.supabase.co`;
          assert.ok(tusHits.length >= 1, 'no resumable (tus) upload request was made');
          assert.ok(tusHits.every((r) => new URL(r.url).hostname === storageHost),
            `a resumable upload request went somewhere other than the shadow project's storage: ${tusHits.map((r) => hideRef(redact(r.url))).join(', ')}`);
          assert.ok(sent.some((r) => r.method === 'POST' && SIGN_RE.test(r.url || '')), 'the uploader never signed the object back to check that it plays');
          await page.screenshot(join(ART, 'super-upload-ready.png'));

          // ── 5. Save draft: the details, then the file.
          halt('saving the draft');
          assert.ok(await page.evaluate(clickInDialog, EDITOR, 'Save draft'), 'no Save draft button');
          await page.waitFor((title) => !document.querySelector('[role="dialog"]')
            && [...document.querySelectorAll('.gs-admin li')].some((li) => li.textContent.includes(title) && /Video uploaded/.test(li.textContent)),
          [SCREEN_VIDEO.title], { timeoutMs: 60000, what: 'the saved draft, with its video, in Drafts' });
          const [d] = await runSql(`select v.id::text as id, v.status, v.title, v.description, v.transcript, v.storage_path,
               v.byte_size, v.mime_type, v.duration_seconds::float8 as duration, v.original_filename,
               v.created_by::text as created_by, v.media_attached_at is not null as attached,
               (o.id is not null) as object_present, (o.metadata->>'size')::bigint as object_size
             from public.onboarding_videos v
             left join storage.objects o on o.bucket_id = 'onboarding-videos' and o.name = v.storage_path
            where v.title = ${lit(SCREEN_VIDEO.title)}`);
          assert.ok(d, 'the draft is not in the database');
          videoId = d.id;
          assert.equal(d.status, 'draft');
          assert.equal(d.description, SCREEN_VIDEO.description, 'the description typed in the editor');
          assert.equal(d.transcript, SCREEN_VIDEO.transcript, 'the transcript typed in the editor');
          assert.match(d.storage_path || '', new RegExp(`^versions/${d.id}/[0-9a-f-]{36}\\.mp4$`), 'the file is not in the draft\'s own folder');
          assert.equal(d.attached, true, 'the file was not attached');
          assert.equal(d.object_present, true, 'the uploaded object is not in the private bucket');
          if (d.object_size !== null) assert.equal(Number(d.object_size), theClip.bytes, 'the stored object is not the clip\'s size');
          assert.equal(Number(d.byte_size), theClip.bytes, 'byte_size is not the clip\'s size');
          assert.equal(d.mime_type, 'video/mp4');
          assert.ok(Number.isFinite(d.duration) && d.duration > 0, `the verified duration was not stored: ${d.duration}`);
          assert.ok(Math.abs(d.duration - theClip.durationSeconds) <= 0.1, `the stored duration ${d.duration}s is not the clip's ${theClip.durationSeconds}s`);
          assert.equal(d.original_filename, fileName, 'the file name as picked');
          assert.equal(d.created_by, superId);
          durationSeconds = d.duration;
          await page.screenshot(join(ART, 'super-draft-saved.png'));

          // ── 6. Publish, through its confirmation — which says who is affected.
          assert.ok(await page.evaluate((title) => {
            const li = [...document.querySelectorAll('.gs-admin li')].find((x) => x.textContent.includes(title));
            const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === 'Publish');
            if (!b) return false;
            b.click();
            return true;
          }, SCREEN_VIDEO.title), 'no Publish on the draft\'s row');
          const CONFIRM = `Publish “${SCREEN_VIDEO.title}”?`;
          const said = await page.waitFor(dialogText, [CONFIRM], { timeoutMs: 30000, what: 'the Publish confirmation' });
          if (cutoffMs !== null) {
            assert.ok(said.includes(`Students approved since the first publish (${manilaDay(cutoffMs)}) who haven’t finished a Getting Started video`),
              `the confirmation does not say who is asked — those approved since the first publish: ${said}`);
            assert.ok(said.includes('Members approved before the first publish aren’t asked'), `the confirmation does not say who is not asked: ${said}`);
          } else {
            assert.match(said, /New students approved from now on \(from [A-Z][a-z]+ \d{1,2}, \d{4}\)/, 'the first publish does not name its cutoff');
          }
          assert.doesNotMatch(said, /all students/i, 'the confirmation claims to ask all students');
          const mark = page.rpcs.calls.length;
          halt('publishing');
          liveId = videoId;   // from the press on, a failure must take it down again
          assert.ok(await page.evaluate(clickInDialog, CONFIRM, 'Publish'), 'no Publish button in the confirmation');
          await page.waitFor((title) => !document.querySelector('[role="dialog"]')
            && [...document.querySelectorAll('.gs-admin section h2')].some((h) => h.textContent.trim() === title),
          [SCREEN_VIDEO.title], { timeoutMs: 60000, what: 'the live card naming the published video' });
          const publishCalls = page.rpcs.calls.slice(mark).filter((c) => c.name === 'admin_onboarding_video_publish');
          assert.equal(publishCalls.length, 1, 'one press, one publish');
          assert.deepEqual(JSON.parse(publishCalls[0].body || 'null'), { p_video_id: videoId, p_replace_live: false },
            'the publish named another version, or asked to replace a live one');
          assert.equal(publishCalls[0].status, 200, 'the publish was refused');

          // ── 7. The badge clears: the root re-reads the video's health after the change.
          await page.waitFor((sel) => {
            const a = document.querySelector(sel);
            return !!a && !a.querySelector('.sr-only') && ![...a.querySelectorAll('span[aria-hidden="true"]')].some((s) => /^\d+$/.test(s.textContent.trim()));
          }, [FIRST_ADMIN_ROW], { timeoutMs: 60000, what: 'the attention badge to clear' });
          const axAfter = await axNameOf(page, FIRST_ADMIN_ROW);
          assert.equal(axAfter.name, 'Getting Started Video', 'the row still announces something once its badge has cleared');
          const health1 = await page.evaluate(healthBanner);
          assert.match(health1?.text || '', /The Getting Started video is live/, `the banner after the publish: ${JSON.stringify(health1)}`);
          assert.ok(page.rpcs.calls.slice(mark).some((c) => c.name === 'admin_onboarding_video_overview'), 'nothing re-read the overview after the publish');
          // …and the Super Admin's OWN answer — their Dashboard card — is asked for again (T9V-M1).
          await waitForRpc(page, 'my_onboarding_video', { from: mark, timeoutMs: 30000 });
          await page.screenshot(join(ART, 'super-published.png'));
          assert.ok(await page.evaluate(clickNav, '/'), 'no Dashboard link in the sidebar');
          await page.waitFor(onDashboard, [], { timeoutMs: 60000, what: 'the Dashboard' });
          await page.waitFor((title) => (document.querySelector('.gs-card h2')?.textContent || '').trim() === title,
            [SCREEN_VIDEO.title], { timeoutMs: 60000, what: "the Super Admin's Dashboard card naming the video just published" });

          const [p] = await runSql(`select v.status, v.byte_size, v.duration_seconds::float8 as duration,
               v.published_by::text as published_by, v.last_published_at is not null as last_published,
               (o.id is not null) as object_present,
               (select string_agg(e.action, ',' order by e.id) from public.onboarding_video_events e where e.video_id = v.id) as actions,
               (select count(*)::int from public.onboarding_video_events e
                 where e.video_id = v.id and e.actor_id is distinct from ${lit(superId)}::uuid) as by_others
             from public.onboarding_videos v
             left join storage.objects o on o.bucket_id = 'onboarding-videos' and o.name = v.storage_path
            where v.id = ${lit(videoId)}::uuid`);
          assert.equal(p.status, 'published');
          assert.equal(Number(p.byte_size), theClip.bytes, 'byte_size is not the clip\'s size');
          assert.ok(Number.isFinite(p.duration) && p.duration > 0, 'the live version has no known duration');
          assert.equal(p.published_by, superId, 'published by someone else');
          assert.equal(p.last_published, true);
          assert.equal(p.object_present, true, 'the live version\'s file is not in the private bucket');
          assert.equal(p.actions, 'create_draft,update_details,attach_media,publish', 'the audit trail of what the screen did');
          assert.equal(p.by_others, 0, 'an audit row names another actor');
          assert.equal(await liveOnboardingVideoCount(), 1, 'exactly one version is live');
          assert.deepEqual(unsignedHits(page), [], 'an onboarding object was requested other than through a signed URL');
          assert.deepEqual(pageErrors(page), [], 'the Super Admin\'s screen raised errors');
          note('13-screen', {
            firstRow: group.rows[0], axNameBefore: axBefore.name, axNameAfter: axAfter.name, rail: rail.links[0],
            health: { before: health0, after: health1 },
            upload: { tusRequests: tusHits.length, storageHost: hideRef(storageHost), objectSizeKnown: d.object_size !== null },
            saved: { bytes: Number(d.byte_size), duration: d.duration, mime: d.mime_type, file: d.original_filename },
            confirmation: said.slice(0, 600), audit: p.actions,
            adminRpcs: adminRpcs(page),
          });
        } finally {
          await page.close();
        }

        // ── 8. A student approved AFTER that publish meets THIS video — no other.
        halt('approving a student');
        await runSql(`do $seed$
          begin
            update public.profiles set is_paid = true, approval_status = 'approved' where id = ${ids('gs-late')};
            insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, grant_source, source_import_row_id)
            values (${ids('gs-late')}, 'sampler', 'active', now(), now() + interval '60 days', now() + interval '63 days', 'payment', null);
          end $seed$;`);
        const [order] = await runSql(`select (select min(s.created_at) from public.subscriptions s where s.user_id = ${ids('gs-late')})
            > v.last_published_at as after_publish
          from public.onboarding_videos v where v.id = ${lit(videoId)}::uuid`);
        assert.equal(order?.after_publish, true, 'the student must be approved after the publish');
        const student = await openAs(people['gs-late'], '/');
        try {
          await waitForGateVideo(student, 'the Getting Started gate, for a student approved after the publish');
          const answer = await gsAnswer(student);
          assert.equal(answer.required, true, 'the server must ask this student to watch it');
          assert.equal(answer.videoId, videoId, 'the gate holds the student for a different video');
          assert.equal(answer.title, SCREEN_VIDEO.title, 'the gate\'s answer names a different title');
          // The gate does not print the title (it greets the student); what it shows of THIS video is
          // its length and the transcript the Super Admin typed.
          const gate = await student.evaluate(() => {
            const main = document.querySelector('main.gs-surface');
            return {
              intro: ((main && main.querySelector('p')) || {}).textContent || '',
              transcript: ((main && main.querySelector('details')) || {}).textContent || '',
            };
          });
          const length = formatVideoDuration(durationSeconds);
          assert.ok(length && gate.intro.includes(`Start with this ${length} welcome video`),
            `the gate does not give this video's length (${length}): "${gate.intro}"`);
          assert.ok(gate.transcript.includes(SCREEN_VIDEO.transcript), 'the gate does not offer the transcript typed in the editor');
          const signs = student.requests.filter((r) => r.method === 'POST' && SIGN_RE.test(r.url || ''));
          assert.ok(signs.length >= 1 && signs.length <= 2, `the gate's player signed its video ${signs.length} times (1–2 per mount)`);
          assert.ok(signs.every((r) => (r.url || '').includes(`/onboarding-videos/versions/${videoId}/`)),
            `the gate signed an object outside this video's folder: ${signs.map((r) => redact(r.url)).join(', ')}`);
          // The file uploaded through the screen plays for the student, to the end — and only then unlocks.
          await playVideo(student, 'gate', { rate: FAST_RATE });
          await student.waitFor(() => { const go = document.querySelector('[data-gs-go]'); return !!go && !go.hasAttribute('aria-disabled'); },
            [], { timeoutMs: 60000, what: 'Go to dashboard unlocking once the uploaded clip has played' });
          const row = await progressRow(people['gs-late'].id, videoId);
          assert.ok(row?.first_started_at, 'the student\'s start was not recorded against this video');
          assert.equal(row.completed_at, null, 'nothing was pressed, so nothing may be completed');
          assert.deepEqual(unsignedHits(student), [], 'an onboarding object was requested other than through a signed URL');
          assert.deepEqual(pageErrors(student), [], 'the student\'s gate raised errors');
          await student.screenshot(join(ART, 'late-student-gate.png'));
          note('13-screen', { student: { answer, signPosts: signs.length, intro: gate.intro.trim() } });
        } finally {
          await student.close();
        }

        // ── 9. Taken down again: nothing live for whatever runs next.
        const { data: down, error: downErr } = await superDb.rpc('admin_onboarding_video_unpublish', { p_video_id: videoId });
        assert.equal(downErr, null, downErr && `${downErr.hint} ${downErr.message}`);
        assert.equal(down?.changed, true, 'the video did not come down');
        liveId = null;
        assert.equal(await liveOnboardingVideoCount(), 0, 'test 13 left a Getting Started video live');
      } finally {
        if (liveId) {
          // The flow failed after the press: take down what it made live, however it failed.
          try { await superDb.rpc('admin_onboarding_video_unpublish', { p_video_id: liveId }); } catch { /* the reset below */ }
          try { if (await liveOnboardingVideoCount() > 0) await resetOnboardingVideos(); } catch { /* after() resets too */ }
        }
      }
    })();
    await screenWork;
  });
