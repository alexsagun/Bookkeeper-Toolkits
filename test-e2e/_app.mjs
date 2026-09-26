// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/_app.mjs — the real app, served against the SHADOW project, with personas.
// ─────────────────────────────────────────────────────────────────────────────
// SAFETY, IN ORDER OF IMPORTANCE
//   1. Everything routes through shadowEnv(), which refuses to run when .env.test
//      names the live project. Seeding here writes enrollment requests, subscriptions
//      and holds; against production that would be fabricated payment records.
//   2. The dev server is started with the shadow URL/keys in process.env. Every dev
//      middleware in vite.config.js copies a .env value only when process.env lacks
//      it, and loadEnv() prefers process.env too — so .env (production) never wins.
//   3. Every outbound provider is pinned to a dead value, so nothing a test clicks can
//      spend money, send mail or schedule a meeting: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY,
//      the RESEND_* pair and the ZOOM_* trio. Pinned rather than assumed absent from .env,
//      because every dev middleware copies a .env value whenever process.env lacks one.
//   4. Sessions are minted in THIS process and injected with an init script. They are
//      never returned from the page, never logged, never written to disk.
//   5. Fixtures are keyed by the `e2e-` email prefix and removed in cleanup. Auth
//      users are kept for reuse (the test-db harness does the same: GoTrue
//      rate-limits user creation), their data is not. resetShadow() is never called.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { REPO_ROOT, runSql, shadowEnv } from '../scripts/_shadow.mjs';
import { chromePath } from './_cdp.mjs';

export const E2E_PASSWORD = 'E2e-Shadow-Passw0rd!';
const CLIENT_OPTS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

/** Why the browser suite cannot run here, or null when it can. */
export function skipReason() {
  if (!existsSync(join(REPO_ROOT, '.env.test'))) return 'no .env.test (see docs/db/shadow-project.md)';
  if (!chromePath()) return 'no Chrome found (set CHROME_PATH)';
  try { shadowEnv(); } catch (e) { return e.message.split('\n')[0]; }
  return null;
}

export function lit(v) {
  if (v === null || v === undefined) return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/**
 * Start `vite` against the shadow project. Returns { url, stop }.
 *
 * `root` serves a different checkout with the same harness — used to measure a worktree at
 * an older commit side by side with this one (the 2026-09-24 A/B that proved the 0px
 * identity column). It is NOT the suite's negative control: an old commit fails for
 * structural reasons (no `.enroll-card`), so enrollmentLayout re-creates the defect in the
 * live page instead. A worktree needs node_modules (a junction to this one is enough).
 */
export async function startApp({ root = process.env.E2E_APP_ROOT || REPO_ROOT } = {}) {
  const env = shadowEnv();
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: env.SHADOW_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: env.SHADOW_SUPABASE_ANON_KEY,
      SUPABASE_URL: env.SHADOW_SUPABASE_URL,
      SUPABASE_ANON_KEY: env.SHADOW_SUPABASE_ANON_KEY,
      SUPABASE_SECRET_KEY: env.SHADOW_SUPABASE_SECRET_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.SHADOW_SUPABASE_SECRET_KEY,
      ANTHROPIC_API_KEY: 'e2e-disabled',
      ELEVENLABS_API_KEY: 'e2e-disabled',
      // Pinned, not assumed absent: every dev middleware copies a .env value whenever
      // process.env LACKS one, so the day someone adds a real Resend or Zoom key to .env the
      // browser suite would start mailing and scheduling for real. A dead value is refused by
      // the provider; nothing leaves.
      RESEND_API_KEY: 'e2e-disabled',
      RESEND_FROM: 'E2E <e2e-disabled@shadow.test>',
      NOTIFY_ADMIN_EMAIL: 'e2e-disabled@shadow.test',
      ZOOM_ACCOUNT_ID: 'e2e-disabled',
      ZOOM_CLIENT_ID: 'e2e-disabled',
      ZOOM_CLIENT_SECRET: 'e2e-disabled',
      // Both flags on, exactly as production builds them.
      VITE_REQUIRE_ENROLLMENT: 'true',
      VITE_REQUIRE_ADMIN_APPROVAL: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${out.slice(-2000)}`);
    try { const r = await fetch(url); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() - start > 60000) throw new Error(`vite did not start within 60s:\n${out.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    url,
    stop() {
      // E2E_APP_LOG=<file> keeps the dev server's own output (the api/ handlers log there),
      // which is otherwise lost with the process — the only record of a request that stalled.
      if (process.env.E2E_APP_LOG) { try { writeFileSync(process.env.E2E_APP_LOG, out); } catch { /* best effort */ } }
      if (child.exitCode !== null) return;
      // Vite leaves an esbuild child; kill the tree on Windows or it outlives the run.
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}

let _svc = null;
function service() {
  if (!_svc) { const e = shadowEnv(); _svc = createClient(e.SHADOW_SUPABASE_URL, e.SHADOW_SUPABASE_SECRET_KEY, CLIENT_OPTS); }
  return _svc;
}

async function scalar(sql) {
  const rows = await runSql(sql);
  if (!Array.isArray(rows) || !rows.length) return null;
  return Object.values(rows[0])[0];
}

/**
 * A real auth user (created through GoTrue so the signup trigger builds the profile
 * exactly as production does), approved, with a known name. Email is always
 * `e2e-<label>@shadow.test`, which is what cleanup keys on.
 */
export async function ensureUser(label, { fullName = null } = {}) {
  const email = `e2e-${label}@shadow.test`.toLowerCase();
  let id = await scalar(`select id::text from auth.users where email = ${lit(email)}`);
  if (!id) {
    const { data, error } = await service().auth.admin.createUser({ email, password: E2E_PASSWORD, email_confirm: true });
    if (error) throw new Error(`ensureUser(${label}): ${error.message}`);
    id = data.user.id;
  }
  return { id, email, label, fullName: fullName || label };
}

/** ensureUser for many labels, with ONE lookup round trip (each costs ~4s here). */
export async function ensureUsers(specs) {
  const emails = specs.map(({ label }) => `e2e-${label}@shadow.test`.toLowerCase());
  const rows = await runSql(`select id::text as id, email from auth.users where email in (${emails.map(lit).join(',')})`);
  const byEmail = new Map((rows || []).map((r) => [r.email, r.id]));
  const out = {};
  for (const [i, { label, fullName }] of specs.entries()) {
    const email = emails[i];
    let id = byEmail.get(email);
    if (!id) {
      const { data, error } = await service().auth.admin.createUser({ email, password: E2E_PASSWORD, email_confirm: true });
      if (error) throw new Error(`ensureUsers(${label}): ${error.message}`);
      id = data.user.id;
    }
    out[label] = { id, email, label, fullName: fullName || label };
  }
  return out;
}

/** A signed-in session for a persona. Kept in memory only. */
export async function signIn(email) {
  const e = shadowEnv();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = createClient(e.SHADOW_SUPABASE_URL, e.SHADOW_SUPABASE_ANON_KEY, CLIENT_OPTS);
    const { data, error } = await c.auth.signInWithPassword({ email, password: E2E_PASSWORD });
    if (!error && data?.session) return data.session;
    lastErr = error;
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw new Error(`signIn(${email}): ${lastErr?.message || 'unknown'}`);
}

/**
 * Put a session (and the per-user "welcome already seen" flag) into localStorage
 * before any app script runs. The storage key is the one supabase-js derives from
 * the project URL; the welcome flag uses main.jsx's `u:<uid>:` namespace.
 */
export async function injectSession(page, session, { railCollapsed = null } = {}) {
  const ref = new URL(shadowEnv().SHADOW_SUPABASE_URL).hostname.split('.')[0];
  const uid = session.user.id;
  const entries = {
    [`sb-${ref}-auth-token`]: JSON.stringify(session),
    [`u:${uid}:onboarding:welcomed`]: '1',
    [`u:${uid}:sidebar:adminExpanded`]: 'true',
  };
  if (railCollapsed !== null) entries[`u:${uid}:sidebar:railCollapsed`] = String(railCollapsed);
  // Only on the app origin, and only if absent — a token supabase-js refreshed
  // during the test must not be clobbered by the stale one on the next navigation.
  await page.addInitScript(`(() => {
    if (location.protocol !== 'http:') return;
    const e = ${JSON.stringify(entries)};
    for (const k of Object.keys(e)) { if (localStorage.getItem(k) === null) localStorage.setItem(k, e[k]); }
  })();`);
}

export { runSql, scalar, shadowEnv };
