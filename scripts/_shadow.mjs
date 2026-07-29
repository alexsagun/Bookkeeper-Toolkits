// ─────────────────────────────────────────────────────────────────────────────
// Shared plumbing for the SHADOW Supabase project — the disposable target the
// DB/RLS suite (`npm run test:db`) runs against.
//
// WHY A SHADOW PROJECT: the live project holds real member data, so it can
// never be a test target. There is no Docker/WSL on the development machine, so
// `supabase start` is not available either. A second free-tier project gives us
// the real stack — Postgres 17, PostgREST (including its `max_rows` cap),
// GoTrue, Storage, and the actual `anon` / `authenticated` roles that every
// policy names. Testing against anything less would verify a model of the
// system rather than the system.
//
// TWO ACCESS PATHS, DELIBERATELY:
//   • runSql()        — Management API, executes as the `postgres` superuser.
//                       Used for applying migrations and for privileged
//                       assertions (pg_policies, pg_proc, has_table_privilege).
//                       It BYPASSES RLS, so it must never be used to assert
//                       that a member can or cannot see something.
//   • personas        — supabase-js with a REAL signed-in user's JWT, hitting
//                       PostgREST exactly as the browser does. This is the only
//                       path that proves an authorization claim, because it
//                       exercises grants + RLS + PostgREST together.
//
// Credentials live in .env.test (gitignored). Nothing here reads .env, so a
// mistake cannot point the suite at production — and assertLiveProjectNotTargeted()
// makes that explicit rather than implicit.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');

// The production project ref. Hardcoded on purpose: it is the one value that
// must never appear in the shadow config, and reading it from .env would defeat
// the check whenever .env is absent (CI, a fresh clone).
const LIVE_PROJECT_REF = 'ifxcobxsjdjzlozagmls';

let cachedEnv = null;

/** Parse .env.test into a plain object. Values are never logged. */
export function shadowEnv() {
  if (cachedEnv) return cachedEnv;
  let raw;
  try {
    raw = readFileSync(join(REPO_ROOT, '.env.test'), 'utf8');
  } catch {
    throw new Error(
      'Missing .env.test. The DB suite needs a shadow Supabase project.\n' +
      'Expected keys: SHADOW_PROJECT_REF, SHADOW_SUPABASE_URL, ' +
      'SHADOW_SUPABASE_ANON_KEY, SHADOW_SUPABASE_SECRET_KEY.\n' +
      'See docs/db/shadow-project.md.',
    );
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  const required = [
    'SHADOW_PROJECT_REF',
    'SHADOW_SUPABASE_URL',
    'SHADOW_SUPABASE_ANON_KEY',
    'SHADOW_SUPABASE_SECRET_KEY',
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`.env.test is missing: ${missing.join(', ')}`);

  assertLiveProjectNotTargeted(env);
  cachedEnv = env;
  return env;
}

/**
 * Refuse to run if the shadow config points at production. Every destructive
 * helper in this file routes through shadowEnv(), so this one check covers the
 * whole suite — including `resetShadow()`, which truncates tables.
 */
export function assertLiveProjectNotTargeted(env) {
  const ref = env.SHADOW_PROJECT_REF || '';
  const url = env.SHADOW_SUPABASE_URL || '';
  if (ref === LIVE_PROJECT_REF || url.includes(LIVE_PROJECT_REF)) {
    throw new Error(
      `REFUSING TO RUN: .env.test points at the LIVE project (${LIVE_PROJECT_REF}). ` +
      'The DB suite truncates data. Point it at a disposable shadow project.',
    );
  }
}

/** The Supabase Management API token, read from .env (developer machine only). */
function managementToken() {
  let raw = '';
  try {
    raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    /* fall through to the clearer error below */
  }
  const m = /^SUPABASE_ACCESS_TOKEN=(.*)$/m.exec(raw);
  const token = m && m[1].trim().replace(/^["']|["']$/g, '');
  if (!token) {
    throw new Error(
      'SUPABASE_ACCESS_TOKEN not found in .env — needed to apply SQL to the shadow project ' +
      '(Supabase dashboard → Account → Access Tokens).',
    );
  }
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Errors worth retrying rather than failing the run.
 *
 * `40P01` (deadlock) and `40001` (serialization failure) show up when creating
 * policies on `storage.objects`: Supabase's own background processes hold locks
 * on that table, so an AccessExclusiveLock can lose a race that succeeds
 * immediately on retry. `53300`/`57P03` cover a project still warming up, and
 * HTTP 429/5xx cover the Management API itself. None of these indicate a
 * problem with the SQL, so failing on them would just make the suite flaky.
 */
function isTransient(detail, status) {
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /40P01|40001|55P03|53300|57P03|deadlock detected|could not obtain lock/i.test(detail || '');
}

/**
 * Execute SQL on the shadow project as `postgres` via the Management API.
 *
 * Returns the rows array for a single statement, or the last statement's rows
 * for a script. Throws with the Postgres message on failure.
 *
 * REMEMBER: this runs as a superuser and bypasses RLS. Use it to build state
 * and to inspect the catalog — never to prove what a member can see.
 */
export async function runSql(sql, { label = 'sql', retries = 4 } = {}) {
  const env = shadowEnv();
  let lastDetail = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${env.SHADOW_PROJECT_REF}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${managementToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      },
    );
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        return [];
      }
    }
    lastStatus = res.status;
    lastDetail = text;
    try {
      const j = JSON.parse(text);
      lastDetail = j.message || j.error || text;
    } catch { /* keep raw text */ }

    if (attempt < retries && isTransient(lastDetail, res.status)) {
      await sleep(400 * 2 ** attempt); // 400ms, 800ms, 1.6s, 3.2s
      continue;
    }
    break;
  }

  const err = new Error(`[${label}] SQL failed (HTTP ${lastStatus}): ${lastDetail}`);
  err.sqlDetail = lastDetail;
  throw err;
}

/** Convenience: run SQL and return the first row (or null). */
export async function runSqlOne(sql, opts) {
  const rows = await runSql(sql, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Convenience: run SQL and return the first column of the first row. */
export async function runSqlScalar(sql, opts) {
  const row = await runSqlOne(sql, opts);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}
