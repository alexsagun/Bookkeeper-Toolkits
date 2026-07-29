// ─────────────────────────────────────────────────────────────────────────────
// Apply repo SQL to the SHADOW project.
//
//   node scripts/apply-db-files.mjs                 # bootstrap only (fresh install)
//   node scripts/apply-db-files.mjs db/2026-07-30-batch-entitlements.sql ...
//   node scripts/apply-db-files.mjs --all           # bootstrap + every db/*.sql newer
//                                                   # than the bootstrap's fold point
//   node scripts/apply-db-files.mjs --verify        # compare shadow vs LIVE schema
//
// This script is also the project's only automated check that
// db/000_full_database_bootstrap.sql actually reproduces the live schema — the
// "fresh installation reaches the same final schema" requirement. Nothing else
// exercises the bootstrap, and it has silently drifted before (db/README.md
// still claimed it collapsed "#1-#32" after #33/#34 were folded in).
//
// Large scripts are split into statements before sending, because the
// Management API rejects very large bodies and, more importantly, a failure in
// a 5,000-line script reports one opaque error. Splitting lets us name the
// statement that broke. The splitter understands dollar-quoting ($$, $tag$),
// single quotes, and both comment styles — anything less would cut a plpgsql
// body in half.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSql, REPO_ROOT, shadowEnv } from './_shadow.mjs';

const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';

/**
 * Split a SQL script into top-level statements.
 *
 * Correctness here is load-bearing: `admin_finalize_enrollment` alone contains
 * dozens of semicolons inside a $$-quoted plpgsql body, and a naive split on
 * ';' would produce garbage that still parses far enough to do damage.
 */
export function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next2 = sql.slice(i, i + 2);

    // line comment
    if (next2 === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // block comment (Postgres allows nesting)
    if (next2 === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; continue; }
        if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; continue; }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // single-quoted literal ('' escapes a quote)
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // double-quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j++; break; }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // dollar-quoted body: $$ ... $$ or $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? n : close + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);

  // Drop chunks that are only comments/whitespace — they are not statements and
  // sending them wastes a round trip each.
  return out.filter((s) => {
    const stripped = s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '')
      .trim();
    return stripped.length > 0;
  });
}

/** Apply one .sql file, statement by statement, reporting the first failure precisely. */
export async function applyFile(relPath, { verbose = true } = {}) {
  const abs = join(REPO_ROOT, relPath);
  const sql = readFileSync(abs, 'utf8');
  const statements = splitSqlStatements(sql);
  if (verbose) process.stdout.write(`\n▸ ${relPath} — ${statements.length} statements\n`);

  let applied = 0;
  for (const [idx, stmt] of statements.entries()) {
    try {
      await runSql(stmt, { label: `${relPath}#${idx + 1}` });
      applied++;
      if (verbose && applied % 25 === 0) process.stdout.write(`  … ${applied}/${statements.length}\n`);
    } catch (err) {
      const head = stmt.replace(/\s+/g, ' ').slice(0, 220);
      throw new Error(
        `${relPath}: statement ${idx + 1}/${statements.length} failed.\n` +
        `  SQL: ${head}${stmt.length > 220 ? ' …' : ''}\n` +
        `  ${err.sqlDetail || err.message}`,
      );
    }
  }
  if (verbose) process.stdout.write(`  ✔ ${relPath} applied (${applied} statements)\n`);
  return applied;
}

/** Dated db/*.sql files in filename order (which is also apply order). */
export function datedSqlFiles() {
  return readdirSync(join(REPO_ROOT, 'db'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.sql$/.test(f))
    .sort()
    .map((f) => `db/${f}`);
}

/**
 * Snapshot the schema shape: tables, RLS flags, policies, functions, and their
 * security attributes. Used both for bootstrap-parity and for the idempotency
 * suite (applying a migration twice must not change this).
 */
const SNAPSHOT_SQL = `
select json_build_object(
  'tables', (select coalesce(json_agg(json_build_object('t', c.relname, 'rls', c.relrowsecurity) order by c.relname), '[]'::json)
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r'),
  'policies', (select coalesce(json_agg(json_build_object('t', tablename, 'p', policyname, 'cmd', cmd) order by tablename, policyname), '[]'::json)
                 from pg_policies where schemaname = 'public'),
  'functions', (select coalesce(json_agg(json_build_object(
                         'f', p.proname,
                         'args', pg_get_function_identity_arguments(p.oid),
                         'secdef', p.prosecdef,
                         'cfg', coalesce(array_to_string(p.proconfig, ','), '')
                       ) order by p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::json)
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'),
  'columns', (select coalesce(json_agg(json_build_object('t', table_name, 'c', column_name, 'd', data_type) order by table_name, column_name), '[]'::json)
                from information_schema.columns where table_schema = 'public')
) as snap`;

export async function schemaSnapshot() {
  const rows = await runSql(SNAPSHOT_SQL, { label: 'snapshot' });
  return rows[0].snap;
}

/** Same snapshot, but against the LIVE project (read-only) — for parity checks. */
async function liveSchemaSnapshot() {
  const raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  const token = /^SUPABASE_ACCESS_TOKEN=(.*)$/m.exec(raw)?.[1]?.trim().replace(/^["']|["']$/g, '');
  const res = await fetch(
    'https://api.supabase.com/v1/projects/ifxcobxsjdjzlozagmls/database/query',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: SNAPSHOT_SQL }),
    },
  );
  if (!res.ok) throw new Error(`live snapshot failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json())[0].snap;
}

function diffLists(label, live, shadow, keyFn) {
  const l = new Map(live.map((x) => [keyFn(x), x]));
  const s = new Map(shadow.map((x) => [keyFn(x), x]));
  const onlyLive = [...l.keys()].filter((k) => !s.has(k));
  const onlyShadow = [...s.keys()].filter((k) => !l.has(k));
  const differing = [...l.keys()]
    .filter((k) => s.has(k))
    .filter((k) => JSON.stringify(l.get(k)) !== JSON.stringify(s.get(k)));
  return { label, onlyLive, onlyShadow, differing };
}

async function verifyParity() {
  process.stdout.write('Comparing SHADOW schema against LIVE …\n');
  const [live, shadow] = await Promise.all([liveSchemaSnapshot(), schemaSnapshot()]);
  const reports = [
    diffLists('tables', live.tables, shadow.tables, (x) => x.t),
    diffLists('policies', live.policies, shadow.policies, (x) => `${x.t}.${x.p}`),
    diffLists('functions', live.functions, shadow.functions, (x) => `${x.f}(${x.args})`),
    diffLists('columns', live.columns, shadow.columns, (x) => `${x.t}.${x.c}`),
  ];
  let clean = true;
  for (const r of reports) {
    const total = r.onlyLive.length + r.onlyShadow.length + r.differing.length;
    if (total === 0) {
      process.stdout.write(`  ✔ ${r.label}: identical\n`);
      continue;
    }
    clean = false;
    process.stdout.write(`  ✘ ${r.label}: ${total} difference(s)\n`);
    const show = (title, arr) => {
      if (!arr.length) return;
      process.stdout.write(`      ${title} (${arr.length}): ${arr.slice(0, 25).join(', ')}${arr.length > 25 ? ' …' : ''}\n`);
    };
    show('only in LIVE (bootstrap is missing these)', r.onlyLive);
    show('only in SHADOW (bootstrap adds these)', r.onlyShadow);
    show('attributes differ', r.differing);
  }
  process.stdout.write(clean
    ? '\nBootstrap parity: PASS — a fresh install reaches the live schema.\n'
    : '\nBootstrap parity: DIFFERENCES FOUND (see above).\n');
  return clean;
}

async function main() {
  const args = process.argv.slice(2);
  const env = shadowEnv();
  process.stdout.write(`Shadow project: ${env.SHADOW_PROJECT_REF}\n`);

  if (args.includes('--verify')) {
    const clean = await verifyParity();
    process.exit(clean ? 0 : 1);
  }

  const explicit = args.filter((a) => !a.startsWith('--'));
  let files;
  if (explicit.length) {
    files = explicit;
  } else if (args.includes('--all')) {
    files = [BOOTSTRAP, ...datedSqlFiles().filter((f) => f >= 'db/2026-07-30')];
  } else {
    files = [BOOTSTRAP];
  }

  const started = Date.now();
  for (const f of files) await applyFile(f);
  process.stdout.write(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
}

// Only run when invoked directly, so the helpers stay importable by tests.
if (process.argv[1] && process.argv[1].endsWith('apply-db-files.mjs')) {
  main().catch((err) => {
    process.stderr.write(`\n${err.message}\n`);
    process.exit(1);
  });
}
