// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/_cdp.mjs — a small Chrome DevTools Protocol client with no dependencies.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//   The repo had no rendered test at all. Everything under test/ reads source text,
//   and a source scan cannot see geometry: the 2026-09-24 Enrollments card collapsed
//   its identity column to 0px while every static check passed and the card reported
//   no horizontal overflow. Only a real layout engine can measure that.
//
// WHY NOT PUPPETEER OR PLAYWRIGHT
//   Owner decision, 2026-09-24: no new dependency and no second test runner. Node 24
//   ships a WebSocket client, and the handful of CDP methods a layout test needs fit
//   in this file. It drives the Chrome that is already installed, under `node --test`.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   Print anything a page evaluates. A signed-in page holds a session token, and an
//   evaluate() that returned it would put it in the test log. Callers return
//   measurements, never storage.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** The installed Chrome, or null. Tests skip — loudly — when there is none. */
export function chromePath() {
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer, method } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
    ws.addEventListener('close', () => {
      for (const { reject, timer, method } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: the browser connection closed`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

/**
 * Launch a headless Chrome with a throwaway profile.
 *
 * Scrollbars are left ON: <main> is the app's scroller, and its classic Windows
 * scrollbar takes real width away from every card. Hiding it would measure a
 * layout no user sees.
 */
export async function launchChrome({ headless = true } = {}) {
  const exe = chromePath();
  if (!exe) throw new Error('No Chrome found. Set CHROME_PATH to run the browser suite.');
  const profile = mkdtempSync(join(tmpdir(), 'bk-e2e-chrome-'));
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--window-size=1440,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools endpoint within 20s')), 20000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (${code})`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not open the DevTools socket')), { once: true });
  });
  const conn = new Connection(ws);
  return {
    conn,
    /**
     * A page in its OWN browser context: separate cookies and localStorage. Each
     * persona needs one — a shared origin would hand the second persona the first
     * one's session token.
     */
    async newPage() {
      const { browserContextId } = await conn.send('Target.createBrowserContext', { disposeOnDetach: true });
      return Page.open(conn, browserContextId);
    },
    async close() {
      try { await conn.send('Browser.close', {}, undefined, 5000); } catch { /* already gone */ }
      try { ws.close(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      // Chrome releases its profile lock a moment after exit on Windows.
      for (let i = 0; i < 10; i++) {
        try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
      }
    },
  };
}

export class Page {
  static async open(conn, browserContextId) {
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', ...(browserContextId ? { browserContextId } : {}) });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(conn, sessionId, targetId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Log.enable');
    return page;
  }

  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    /** Console errors/warnings, uncaught exceptions and failed requests, in order. */
    this.problems = [];
    /** Every request the page made: { method, url }. Used to prove a fetch did NOT happen. */
    this.requests = [];
    this.off = conn.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params || {};
      switch (msg.method) {
        case 'Runtime.consoleAPICalled':
          if (p.type === 'error' || p.type === 'warning') {
            this.problems.push({ kind: `console.${p.type}`, text: (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
          }
          break;
        case 'Runtime.exceptionThrown':
          this.problems.push({ kind: 'exception', text: (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 400) });
          break;
        case 'Log.entryAdded':
          if (p.entry?.level === 'error') this.problems.push({ kind: `log.${p.entry.source}`, text: String(p.entry.text || '').slice(0, 400), url: p.entry.url });
          break;
        case 'Network.requestWillBeSent':
          this.requests.push({ method: p.request?.method, url: p.request?.url });
          break;
        case 'Network.responseReceived':
          if (p.response?.status >= 400) this.problems.push({ kind: 'http', status: p.response.status, url: p.response.url });
          break;
        case 'Network.loadingFailed':
          if (!p.canceled) this.problems.push({ kind: 'network', text: p.errorText, type: p.type });
          break;
        default:
      }
    });
  }

  send(method, params = {}, timeoutMs) { return this.conn.send(method, params, this.sessionId, timeoutMs); }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${method} did not fire within ${timeoutMs}ms`)); }, timeoutMs);
      const off = this.conn.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === method) { clearTimeout(timer); off(); resolve(msg.params); }
      });
    });
  }

  /** Run code before any page script, on every navigation. */
  addInitScript(source) { return this.send('Page.addScriptToEvaluateOnNewDocument', { source }); }

  async goto(url, { timeoutMs = 45000 } = {}) {
    const loaded = this.once('Page.loadEventFired', timeoutMs);
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /**
   * Evaluate a function in the page. Arguments and the return value cross as JSON,
   * so return MEASUREMENTS — never a token, a storage value or a signed URL.
   */
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluate: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async waitFor(fn, args = [], { timeoutMs = 30000, intervalMs = 150, what = 'condition' } = {}) {
    // ★ A predicate like `() => document.querySelector('main')` returns a DOM NODE, which CDP
    //   cannot return by value — every poll throws, the catch below (there for navigations)
    //   swallows it, and a page that was fine "times out". It cost two runs on 2026-09-24.
    //   Coerce a node to `true` inside the page, so no caller has to remember.
    const expression = `(() => { const v = (${fn.toString()})(...${JSON.stringify(args)});
      return (typeof Node !== 'undefined' && v instanceof Node) ? true : v; })()`;
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (!res.exceptionDetails) { last = res.result?.value; if (last) return last; }
      } catch { /* page mid-navigation */ }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
  }

  /**
   * Size the layout viewport. `zoom` emulates browser zoom exactly the way Chrome
   * applies it: the CSS viewport shrinks by the factor and every CSS pixel is drawn
   * with zoom × device pixels. Layout is identical to real Ctrl+ zoom.
   */
  async setViewport({ width, height, zoom = 1, mobile = width < 768 }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width / zoom),
      height: Math.round(height / zoom),
      deviceScaleFactor: zoom,
      mobile,
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }

  async setMedia({ colorScheme = 'light', reducedMotion = 'no-preference' } = {}) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: colorScheme },
        { name: 'prefers-reduced-motion', value: reducedMotion },
      ],
    });
  }

  /** PNG of the viewport, or of one element (scrolled into view first). */
  async screenshot(path, selector = null) {
    let clip;
    if (selector) {
      clip = await this.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, window.innerHeight), scale: 1 };
      }, selector);
    }
    const { data } = await this.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  async close() {
    this.off?.();
    try { await this.conn.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000); } catch { /* ignore */ }
  }
}
