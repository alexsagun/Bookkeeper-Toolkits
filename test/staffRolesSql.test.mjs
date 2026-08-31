// test/staffRolesSql.test.mjs — the JS permission matrix vs. the SQL seed (#45).
//
// src/lib/staffRoles.js is the client MIRROR of staff_roles / staff_permissions /
// staff_role_permissions. The database is the authority: every write is gated by
// has_staff_permission() reading those tables. If the two drift, the app renders
// a control the server then refuses — or worse, hides one it would have allowed,
// so a Super Admin quietly loses a capability nobody can find again.
//
// ★ BOTH FILES ARE CHECKED, and that is the point. The dated migration is what an
//   EXISTING database runs; the bootstrap fold is what a FRESH install gets, and
//   it is spliced by hand. The bootstrap is exactly where a correction gets lost —
//   on 2026-08-23 a re-fold silently deleted 535 lines of §30 and every offline
//   check stayed green.
//
// Reads SQL as TEXT. No database, no credentials, runs anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import {
  ROLE_PERMISSIONS,
  STAFF_PERMISSION_KEYS,
  STAFF_ROLES,
  STAFF_ROLE_KEYS,
} from '../src/lib/staffRoles.js';

/** The stable codes #45 introduces. Clients branch on error.hint, never on status. */
const NEW_CODES = ['STAFF_LAST_SUPER_ADMIN', 'STAFF_NOT_FOUND', 'STAFF_ROLE_INVALID'];

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-08-25-staff-authorization.sql';
const CURRENT_SEED_MIGRATION = 'db/2026-09-01-student-progress-rankings.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const SQL_FILES = [MIGRATION, BOOTSTRAP];
const SEED_SQL_FILES = [CURRENT_SEED_MIGRATION, BOOTSTRAP];

/**
 * Executable SQL only — the header prose quotes SQL and names permission keys in
 * comments, and must not be matched as if it were the seed.
 */
const statementsOf = (sql) => sql
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

/**
 * Pull the VALUES block of one INSERT, taking the LAST occurrence.
 *
 * ★ Last-writer-wins, deliberately. The bootstrap may restate a seed across
 *   sections (§14b creates the course-videos bucket and §31 corrects it; the same
 *   shape is possible here), and at runtime the last statement is the one that
 *   decides what the table holds. Asserting on the first would pin a value a
 *   later section exists to replace. Same idiom as courseVideoSql.test.mjs.
 */
function lastValuesBlock(sql, table) {
  const re = new RegExp(
    String.raw`insert\s+into\s+public\.${table}\s*\([^)]*\)\s*values([\s\S]*?)on\s+conflict`,
    'gi',
  );
  let last = null;
  for (const m of statementsOf(sql).matchAll(re)) last = m[1];
  return last;
}

/** Every `'a'` appearing as the FIRST column of a `( … )` tuple. */
const firstColumnKeys = (block) =>
  [...block.matchAll(/\(\s*'([^']+)'/g)].map((m) => m[1]);

/** Every `('a', 'b')` two-string tuple, as `a|b`. */
const pairs = (block) =>
  [...block.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)].map((m) => `${m[1]}|${m[2]}`);

// ── The seeds exist at all ───────────────────────────────────────────────────

test('the current migration and bootstrap carry the three staff seeds', () => {
  for (const file of SEED_SQL_FILES) {
    const sql = read(file);
    for (const table of ['staff_permissions', 'staff_roles', 'staff_role_permissions']) {
      assert.ok(lastValuesBlock(sql, table),
        `${file} has no "insert into public.${table} (...) values ... on conflict" block — `
        + (file === BOOTSTRAP ? 'the fold is missing or was spliced away' : 'the migration is incomplete'));
    }
  }
});

// ── Permission keys ──────────────────────────────────────────────────────────

let permissionComparisons = 0;

for (const file of SEED_SQL_FILES) {
  test(`${file}: staff_permissions seeds exactly STAFF_PERMISSION_KEYS`, () => {
    const seeded = firstColumnKeys(lastValuesBlock(read(file), 'staff_permissions'));
    assert.deepEqual(seeded, [...STAFF_PERMISSION_KEYS],
      'the SQL seed and src/lib/staffRoles.js must list the same permissions in the same order — '
      + 'a key in one and not the other is a control the client shows and the server refuses');
    permissionComparisons += 1;
  });
}

// ── Roles ────────────────────────────────────────────────────────────────────

let roleComparisons = 0;

for (const file of SEED_SQL_FILES) {
  test(`${file}: staff_roles seeds exactly STAFF_ROLE_KEYS`, () => {
    const seeded = firstColumnKeys(lastValuesBlock(read(file), 'staff_roles'));
    assert.deepEqual(seeded, [...STAFF_ROLE_KEYS], 'the three roles must match, in rank order');
    roleComparisons += 1;
  });

  test(`${file}: super_admin is the only role seeded as protected`, () => {
    const block = lastValuesBlock(read(file), 'staff_roles');
    // ('key', 'label', rank, is_protected, ...)
    const rows = [...block.matchAll(/\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,\s*(true|false)/g)];
    assert.equal(rows.length, STAFF_ROLE_KEYS.length, 'every role row must parse');
    for (const [, key, rank, isProtected] of rows) {
      const js = STAFF_ROLES.find((r) => r.key === key);
      assert.ok(js, `${key} is seeded in SQL but absent from STAFF_ROLES`);
      assert.equal(Number(rank), js.rank, `${key}: rank disagrees between SQL and JS`);
      assert.equal(isProtected === 'true', js.isProtected,
        `${key}: is_protected disagrees — the last-Super-Admin guard keys off this`);
    }
  });
}

// ── The matrix ───────────────────────────────────────────────────────────────

const JS_PAIRS = STAFF_ROLE_KEYS.flatMap((role) =>
  ROLE_PERMISSIONS[role].map((perm) => `${role}|${perm}`));

let matrixComparisons = 0;

for (const file of SEED_SQL_FILES) {
  test(`${file}: staff_role_permissions seeds exactly the JS matrix`, () => {
    const seeded = pairs(lastValuesBlock(read(file), 'staff_role_permissions'));

    const missingInSql = JS_PAIRS.filter((p) => !seeded.includes(p));
    const extraInSql = seeded.filter((p) => !JS_PAIRS.includes(p));

    assert.deepEqual(missingInSql, [],
      'the JS matrix grants these and the SQL seed does not — the client would render a control '
      + 'the server refuses');
    assert.deepEqual(extraInSql, [],
      'the SQL seed grants these and the JS matrix does not — a real capability nobody can see '
      + 'in the UI, which is how a privilege goes unnoticed');
    matrixComparisons += 1;
  });
}

test('the matrix is pinned in both current seed definitions, all 28 grants', () => {
  assert.equal(JS_PAIRS.length, 28,
    '19 super_admin + 6 operations_admin + 3 trainer; a change here must be deliberate');
  assert.equal(permissionComparisons, SEED_SQL_FILES.length, 'permissions unchecked in one file');
  assert.equal(roleComparisons, SEED_SQL_FILES.length, 'roles unchecked in one file');
  assert.equal(matrixComparisons, SEED_SQL_FILES.length, 'the matrix is unchecked in one file');
});

// ── Escalation invariants, asserted against the SQL itself ───────────────────

test('no non-super role is seeded any staff.* permission, in either file', () => {
  for (const file of SEED_SQL_FILES) {
    const seeded = pairs(lastValuesBlock(read(file), 'staff_role_permissions'));
    const offenders = seeded.filter((p) => {
      const [role, perm] = p.split('|');
      return role !== 'super_admin' && perm.startsWith('staff.');
    });
    assert.deepEqual(offenders, [],
      `${file}: a role that can manage staff can promote itself to Super Admin`);
  }
});

test('no non-super role is seeded students.extend_access or courses.manage_all', () => {
  for (const file of SEED_SQL_FILES) {
    const seeded = pairs(lastValuesBlock(read(file), 'staff_role_permissions'));
    for (const perm of ['students.extend_access', 'courses.manage_all']) {
      const holders = seeded.filter((p) => p.endsWith(`|${perm}`)).map((p) => p.split('|')[0]);
      assert.deepEqual(holders, ['super_admin'],
        `${file}: ${perm} must be Super-Admin-only; found ${holders.join(', ') || 'nobody'}`);
    }
  }
});

// ── Structural guarantees of the migration itself ────────────────────────────

test('the migration backfills existing admins BEFORE it asserts one survives', () => {
  const sql = statementsOf(read(MIGRATION));
  const backfill = sql.indexOf('insert into public.staff_memberships');
  const assertion = sql.search(/no active super_admin/i);
  assert.ok(backfill > 0, 'the migration must backfill profiles.is_admin into staff_memberships');
  assert.ok(assertion > 0, 'the migration must refuse to complete with zero active super_admins');
  assert.ok(backfill < assertion,
    'the backfill must run FIRST — asserting before backfilling would fail on every real database');
});

test('the internal per-user helper is revoked from client roles', () => {
  for (const file of SQL_FILES) {
    const sql = statementsOf(read(file));
    assert.match(sql,
      /revoke\s+all\s+on\s+function\s+public\.user_has_staff_permission\(uuid,\s*text\)\s+from\s+public,\s*anon,\s*authenticated/i,
      `${file}: user_has_staff_permission(uuid,text) answers about ANY user and must not be callable `
      + 'by a client — only by other SECURITY DEFINER bodies');
  }
});

test('the self-scoped helpers ARE granted to authenticated, or RLS fails closed for everyone', () => {
  for (const file of SQL_FILES) {
    const sql = statementsOf(read(file));
    for (const fn of ['has_staff_permission(text)', 'is_super_admin()', 'my_staff_context()']) {
      const name = fn.replace(/\(.*/, '');
      assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\([^)]*\\)\\s+to\\s+authenticated`, 'i'),
        `${file}: ${fn} is evaluated AS THE QUERYING ROLE inside an RLS qual — without this grant `
        + 'every non-admin read fails with "permission denied for function" instead of a clean denial');
    }
  }
});

test('profiles loses its blanket admin UPDATE, table-level not column-level', () => {
  for (const file of SQL_FILES) {
    const sql = statementsOf(read(file));
    assert.match(sql, /drop\s+policy\s+if\s+exists\s+profiles_admin_update\s+on\s+public\.profiles/i,
      `${file}: profiles_admin_update let any admin set is_admin=true on any profile`);
    assert.match(sql, /revoke\s+update\s+on\s+public\.profiles\s+from\s+authenticated/i,
      `${file}: a column-level revoke does NOT override a table-level grant — the whole UPDATE `
      + 'privilege must go, as #38 did for batches.code');
  }
});

// ── The restated-function parity check ───────────────────────────────────────
// #45 restates batch_entitlements_guard() wholesale in order to change ONE
// predicate. That is the shape of the bug #34 exists to fix: #33 reconstructed
// admin_finalize_enrollment's tail instead of copying it and quietly dropped
// updated_at, the rejected_at clearing and rejection_reason = null.
//
// It happened again here. The first #45 draft rewrote the valid_until branch:
// it dropped `new.valid_until is null` (so a cohort seat could be cleared to
// NULL and become PERMANENT — the #39 comment says in as many words that
// "clearing it would silently grant perpetual access") and dropped the
// `new.status not in ('revoked','superseded')` carve-out that lets revoke_batch_run
// shorten a seat it is ending. This test is what makes a third occurrence loud.

const GUARD = 'create or replace function public.batch_entitlements_guard()';
const LIVE_GUARD_FILE = 'db/2026-08-17-three-plan-catalog.sql';

/**
 * The executable body of a named function, comments and blank lines stripped.
 *
 * ★ LAST occurrence, not first. The bootstrap defines batch_entitlements_guard()
 *   three times — §22 (#35), §26 (#39) and §32 (#45) — because each fold restates
 *   it. `create or replace` means the LAST one is what the database actually ends
 *   up running, so asserting on the first would pin a body that two later
 *   sections exist to replace. Same last-writer-wins rule as bucketValues() in
 *   test/courseVideoSql.test.mjs.
 */
function functionBody(sql, marker) {
  const at = sql.lastIndexOf(marker);
  if (at === -1) return null;
  const start = sql.indexOf('as $$', at);
  const end = sql.indexOf('$$;', start);
  if (start === -1 || end === -1) return null;
  return sql.slice(start, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'));
}

// The ONLY lines #45 is allowed to change: the granted_by authorization predicate.
const GRANTED_BY_DRIFT = /granted_by|enrollments\.review|must reference an admin|must be an admin or hold/i;

for (const file of SQL_FILES) {
  test(`${file}: batch_entitlements_guard keeps every rule from the live #39 version`, () => {
    const live = functionBody(read(LIVE_GUARD_FILE), GUARD);
    const mine = functionBody(read(file), GUARD);
    assert.ok(live, 'could not find the live guard body to compare against');
    assert.ok(mine, `${file} does not restate batch_entitlements_guard()`);

    const missing = live
      .filter((l) => !GRANTED_BY_DRIFT.test(l))
      .filter((l) => !mine.includes(l));

    assert.deepEqual(missing, [],
      `${file} restates batch_entitlements_guard() but DROPS ${missing.length} line(s) that are `
      + 'live in production. Restate it byte-for-byte and change only the granted_by predicate. '
      + `Missing: ${JSON.stringify(missing.slice(0, 6))}`);
  });
}

// ── Section 15: the operations-surface re-gate ───────────────────────────────
// #45 restates eleven live SECURITY DEFINER bodies in order to change ONE line
// each: `if not public.is_admin()` becomes `if not
// public.has_staff_permission('<key>')`. Without that, an Operations Admin holds
// permissions no server-side path consults and the role is decorative.
//
// Restating a long body by hand is how #33 dropped three statements from
// admin_finalize_enrollment, and how this migration's own first draft dropped a
// fail-closed branch from batch_entitlements_guard. These bodies were extracted
// mechanically; this test is what keeps them that way.

const REGATED = {
  admin_finalize_enrollment: ['enrollments.review', 'db/2026-08-17-three-plan-catalog.sql'],
  approve_subscription: ['enrollments.review', 'db/000_full_database_bootstrap.sql'],
  approve_extension: ['enrollments.review', 'db/000_full_database_bootstrap.sql'],
  admin_assign_batch: ['batches.manage', 'db/2026-08-17-three-plan-catalog.sql'],
  admin_update_batch: ['batches.manage', 'db/2026-08-17-three-plan-catalog.sql'],
};

test('every re-gated function swaps exactly one guard and changes nothing else', () => {
  const mine = read(MIGRATION);
  let checked = 0;

  for (const [fn, [perm, sourceFile]] of Object.entries(REGATED)) {
    const marker = `create or replace function public.${fn}(`;
    const live = functionBody(read(sourceFile), marker);
    const now = functionBody(mine, marker);
    assert.ok(live, `could not find a previous definition of ${fn} to compare against`);
    assert.ok(now, `#45 does not restate ${fn} — section 15 is incomplete`);

    // The guard is the ONE line allowed to differ, in either direction.
    const isGuard = (l) => /if not public\.(is_admin\(\)|has_staff_permission\()/.test(l);

    const missing = live.filter((l) => !isGuard(l)).filter((l) => !now.includes(l));
    assert.deepEqual(missing, [],
      `#45's ${fn} DROPS ${missing.length} line(s) from its live body. Extract it mechanically, `
      + `do not retype it. Missing: ${JSON.stringify(missing.slice(0, 5))}`);

    const added = now.filter((l) => !isGuard(l)).filter((l) => !live.includes(l));
    assert.deepEqual(added, [],
      `#45's ${fn} ADDS ${added.length} line(s) not in its live body: ${JSON.stringify(added.slice(0, 5))}`);

    assert.ok(now.some((l) => l.includes(`has_staff_permission('${perm}')`)),
      `${fn} must gate on ${perm} — otherwise the capability grants nothing`);
    assert.ok(!now.some((l) => /if not public\.is_admin\(\) then/.test(l)),
      `${fn} still has an is_admin() guard, so an Operations Admin is refused before reaching it`);
    checked += 1;
  }

  assert.equal(checked, Object.keys(REGATED).length, 'a re-gated function went unchecked');
});

test('no operations-surface RPC is left gated on is_admin()', () => {
  // The four permissions an Operations Admin holds must each be reachable.
  const mine = statementsOf(read(MIGRATION));
  for (const perm of ['enrollments.review', 'batches.manage', 'students.import']) {
    assert.ok(mine.includes(`has_staff_permission('${perm}')`),
      `${perm} is granted by the section-2 matrix but no server-side path consults it`);
  }
});

test('the guard still refuses to let valid_until be cleared to NULL', () => {
  // Named separately from the diff above because this is the ESCALATION, not just
  // a drift: a NULL valid_until is a cohort seat that never expires.
  for (const file of SQL_FILES) {
    const body = (functionBody(read(file), GUARD) || []).join('\n');
    assert.match(body, /new\.valid_until is null/,
      `${file}: without this disjunct a seat can be cleared to NULL and become permanent`);
    assert.match(body, /new\.status not in \('revoked', 'superseded'\)/,
      `${file}: without this carve-out revoke_batch_run() cannot shorten the seat it is ending`);
  }
});

test('the batch_entitlements guard accepts an Operations Admin as granted_by', () => {
  for (const file of SQL_FILES) {
    const sql = statementsOf(read(file));
    assert.match(sql, /user_has_staff_permission\(\s*new\.granted_by\s*,\s*'enrollments\.review'\s*\)/i,
      `${file}: batch_entitlements_guard asserts "granted_by must be an admin" by reading `
      + 'profiles.is_admin. An Operations Admin has is_admin=false, so approving a VIP enrollment '
      + 'would fail with FORBIDDEN inside grant_batch_run.');
  }
});

test('the three gate helpers stop being world-executable', () => {
  const sql = statementsOf(read(MIGRATION));
  for (const fn of ['is_admin', 'is_approved', 'is_enrolled']) {
    assert.match(sql, new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\(\\)\\s+from\\s+public,\\s*anon`, 'i'),
      `${fn}() is the only SECDEF family in the repo with no REVOKE — anon can call it over PostgREST`);
  }
});

// ── Error-code lockstep ──────────────────────────────────────────────────────
// app_error_catalog() ↔ APP_ERROR_CODES ↔ APP_ERROR_COPY move together, or a
// refusal reaches the user as a raw Postgres string.

test('every #45 code the SQL raises has client copy waiting for it', () => {
  for (const code of NEW_CODES) {
    assert.ok(APP_ERROR_CODES.includes(code),
      `${code} is raised by #45 but missing from APP_ERROR_CODES — appErrorCode() validates the `
      + 'hint against that set, so an unlisted code is discarded and the user sees a fallback');
    assert.ok(APP_ERROR_COPY[code] && APP_ERROR_COPY[code].length > 20,
      `${code} needs a sentence in APP_ERROR_COPY that names the next action`);
  }
});

test('every #45 code is registered in the SQL catalog, in both files', () => {
  for (const file of SQL_FILES) {
    const sql = statementsOf(read(file));
    for (const code of NEW_CODES) {
      assert.ok(sql.includes(`('${code}',`),
        `${file}: app_error_catalog() is replaced wholesale, so ${code} must be re-listed there`);
    }
  }
});

test('no code was dropped by the newest rewrite of app_error_catalog()', () => {
  // app_error_catalog() is a create-or-replace of the WHOLE list. The failure mode
  // is dropping an existing code while adding a new one, which is invisible until
  // some older feature raises it and the client shows a fallback string.
  //
  // ★ It resolves the LATEST rewrite rather than naming #45, and that generality is
  //   the point: this test was pinned to #45 and would have started failing the
  //   moment #46 added a code — reporting a "dropped" code that had simply moved to
  //   a newer catalog. The last dated file that redefines the function is the one
  //   that decides what the database ends up holding.
  const latest = readdirSync(join(REPO, 'db'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.sql$/.test(f))
    .sort()
    .filter((f) => read(`db/${f}`).includes('create or replace function public.app_error_catalog'))
    .pop();

  assert.ok(latest, 'some dated migration must define app_error_catalog()');

  const sql = statementsOf(read(`db/${latest}`));
  for (const code of APP_ERROR_CODES) {
    if (code === 'MIGRATION_MISSING') continue;   // client-synthesised, never in SQL
    assert.ok(sql.includes(`('${code}',`),
      `${latest} rewrote app_error_catalog() and dropped ${code} — every existing code must be re-listed`);
  }
});

test('the migration records itself in the apply log', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /insert into public\.schema_migrations \(filename, checksum, notes\) values/,
    'without this row npm run db:audit reports the file unapplied forever');
  assert.ok(sql.includes(`'${MIGRATION.replace('db/', '')}'`),
    'the row must name this exact filename');
  assert.match(sql, /notify pgrst, 'reload schema';/,
    'new tables and functions are invisible to PostgREST until the schema cache reloads');
});

test('the migration is transaction-free, or the statement splitter breaks', () => {
  const sql = statementsOf(read(MIGRATION));
  assert.doesNotMatch(sql, /^\s*(begin|commit|rollback)\s*;/im,
    'scripts/apply-db-files.mjs sends one statement per HTTP round trip — an explicit '
    + 'transaction block cannot span them and breaks the splitter');
});
