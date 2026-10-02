// test/gettingStartedSql.test.mjs — the #69 migration, read as text (no database needed).
//
// Getting Started (#69): the video a newly approved student watches once before their first
// dashboard. Every assertion runs against the dated file AND its bootstrap fold (§56): the
// dated file is what an existing database runs, the fold is what a fresh install gets, and
// bootstrapFolds.test.mjs only proves a fold CONTAINS its file — never that nothing wrong was
// added beside it, and on a fresh install the last definition wins.
//
// ★ WHAT THIS FILE PINS, AND WHY HERE RATHER THAN IN A DATABASE TEST:
//   • the two COPIED blocks — the staff seed (#67 §1) and app_error_catalog() (#68) — are
//     line-diffed against their sources, with the exact lines #69 may add. A copy that loses a
//     line is the #33/#34 failure this repo keeps recording;
//   • the three function-ACL classes, per function name. A storage-policy helper without its
//     grant breaks EVERY storage.objects statement, in every bucket, and a database test that
//     exercises one bucket cannot tell you which bucket broke first;
//   • the SQL mirrors of src/lib/gettingStarted.js — the path shape (compared BEHAVIOURALLY, by
//     running the same paths through both patterns), the bucket, the elapsed guard and the
//     problem codes;
//   • the wiring: every #69 RPC the app calls exists and is granted, and every call sends only
//     argument NAMES the function declares, and every one it requires — PostgREST matches a
//     function by those names, so a renamed parameter is a PGRST202 at the first click (TDR-3).
//     A #69 name written as a quoted string that is NOT the name of a call the scan reads (a
//     constant, a map, a template, a generic helper's argument) fails, and so does a client RPC
//     with no call the scan reads: a call it cannot follow is a call whose arguments go unchecked;
//   • the gate rule, every policy and every policy helper WHOLE — the boolean operators as well as
//     the terms. A term check passes `and` → `or`, which turns "a student who joined after the
//     cutoff AND …" into "OR …" (TDR-2); scripts/audit-db.mjs is held to the same text.
//
// Reads SQL as TEXT. No database, no credentials, runs anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import { LESSON_VIDEO_BUCKET, LESSON_VIDEO_MAX_BYTES, LESSON_VIDEO_UPLOAD_MIMES } from '../src/lib/courseVideo.js';
// ★ A namespace import, not named ones: a renamed export fails the ONE assertion that reads
//   it instead of failing this whole file at link time.
import * as GS from '../src/lib/gettingStarted.js';
import { STAFF_PERMISSIONS } from '../src/lib/staffRoles.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const readIfExists = (rel) => (existsSync(join(REPO, rel)) ? read(rel) : '');

const DATED = 'db/2026-09-30-getting-started-video.sql';
const DATED_NAME = '2026-09-30-getting-started-video.sql';
const SEED_SOURCE = 'db/2026-09-25-legacy-student-migration.sql';      // #67 §1
const CATALOG_SOURCE = 'db/2026-09-28-legacy-migration-round2.sql';    // #68
const BOOT = 'db/000_full_database_bootstrap.sql';
const FOLD_BANNER = '-- §56) FOLDED VERBATIM — 2026-09-30-getting-started-video.sql';

const dated = readIfExists(DATED);
const boot = read(BOOT);
const foldAt = boot.indexOf(FOLD_BANNER);
/** §56, bounded at the next fold banner if one is ever added after it. */
const fold = (() => {
  if (foldAt < 0) return '';
  const next = boot.slice(foldAt + 1).search(/^--\s*§\d+\) FOLDED VERBATIM/m);
  return next < 0 ? boot.slice(foldAt) : boot.slice(foldAt, foldAt + 1 + next);
})();
const FILES = [[DATED, dated], ['§56 fold', fold]];

// ── The contract ─────────────────────────────────────────────────────────────

/** Client RPCs → their argument types. Each gates itself on auth.uid() inside. */
const CLIENT_RPCS = {
  my_onboarding_video: '',
  start_onboarding_video: '',
  complete_onboarding_video: '',
  report_onboarding_video_problem: 'text',
  admin_onboarding_video_overview: '',
  admin_onboarding_video_create_draft: 'text,text,text',
  admin_onboarding_video_update_details: 'uuid,text,text,text',
  admin_onboarding_video_attach_media: 'uuid,text,bigint,text,numeric,text',
  // + p_expected_live_id (DBSEC-1): the live version the Replace dialog named.
  admin_onboarding_video_publish: 'uuid,boolean,uuid',
  admin_onboarding_video_unpublish: 'uuid',
  admin_onboarding_video_delete: 'uuid',
  enrollment_decision_email_facts: 'uuid',
};
/** Named inside a storage.objects policy, so they MUST be executable by authenticated. */
const POLICY_HELPERS = {
  onboarding_video_object_readable: 'text',
  onboarding_video_upload_allowed: 'text',
  onboarding_video_object_is_live: 'text',
};
/**
 * Each policy helper's WHOLE body, whitespace collapsed (TDR-2). Each is ONE statement, so it is
 * compared by equality, never by "contains": a SQL function answers with its LAST statement, and
 * a `select true;` appended after the real one would be the whole answer.
 */
const HELPER_BODIES = {
  onboarding_video_object_readable:
    'select (select auth.uid()) is not null and exists (select 1 from public.onboarding_videos v '
    + "where v.status = 'published' and v.storage_path = p_name) "
    + 'and public.user_is_approved((select auth.uid())) and public.user_is_enrolled((select auth.uid()));',
  onboarding_video_upload_allowed:
    "select public.has_staff_permission('onboarding.manage') and exists (select 1 from public.onboarding_videos v "
    + "where v.status = 'draft' and v.id = public.onboarding_video_path_version_id(p_name));",
  onboarding_video_object_is_live:
    "select public.has_staff_permission('onboarding.manage') and exists (select 1 from public.onboarding_videos v "
    + "where v.status = 'published' and v.storage_path = p_name);",
};
/** Called only from SECURITY DEFINER bodies or as a trigger: no client role may execute them. */
const INTERNAL = {
  onboarding_video_path_version_id: 'text',
  user_onboarding_video_state: 'uuid',
  onboarding_videos_guard: '',
  onboarding_video_events_guard: '',
};
const STUDENT_RPCS = ['my_onboarding_video', 'start_onboarding_video', 'complete_onboarding_video',
  'report_onboarding_video_problem'];
const ADMIN_RPCS = Object.keys(CLIENT_RPCS).filter((n) => n.startsWith('admin_onboarding_video_'));
const TABLES = ['onboarding_videos', 'student_onboarding_progress', 'onboarding_video_events'];
const STORAGE_POLICIES = ['onboarding_videos_object_read', 'onboarding_videos_object_insert',
  'onboarding_videos_object_update', 'onboarding_videos_object_delete'];

/** The HTTP status each new code is raised with — the catalog row and every app_error() call. */
const ONBOARDING_HTTP = {
  ONBOARDING_VIDEO_NOT_FOUND: 404,
  ONBOARDING_VIDEO_UNAVAILABLE: 409,
  ONBOARDING_VIDEO_NOT_ELIGIBLE: 403,
  ONBOARDING_VIDEO_NOT_FINISHED: 409,
  ONBOARDING_VIDEO_STATE_INVALID: 409,
  ONBOARDING_VIDEO_MEDIA_INVALID: 422,
  ONBOARDING_VIDEO_REPLACE_CONFIRM: 409,
  ONBOARDING_VIDEO_TEXT_INVALID: 422,
};
const ONBOARDING_CODES = APP_ERROR_CODES.filter((c) => c.startsWith('ONBOARDING_VIDEO_'));

// ── Reading SQL ──────────────────────────────────────────────────────────────

/**
 * The SQL with every `--` comment removed, whole-line or trailing — but never one inside a
 * single-quoted string. Assertions read EXECUTABLE SQL: the header prose explains each
 * invariant by naming the thing that must not exist, and a raw-text scan would match it
 * (financeSql.test.mjs records the false failure that shape produced).
 */
function stripComments(sql) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 1; } else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Trimmed non-blank lines, comment lines removed — the unit every copy is diffed in. */
const bodyLines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));

/** The LAST definition of a function: its header (up to `as $tag$`) and its body. */
function fnDef(sql, name) {
  const marker = `create or replace function public.${name}(`;
  const at = sql.lastIndexOf(marker);
  if (at < 0) return null;
  const open = /\nas (\$[a-z]*\$)\n/.exec(sql.slice(at));
  if (!open) return null;
  const tag = open[1];
  const start = at + open.index + open[0].length;
  const end = sql.indexOf(`\n${tag};`, start);
  if (end < 0) return null;
  return { header: sql.slice(at, at + open.index), body: sql.slice(start, end) };
}

/** A function's executable body as one string (comments removed). */
const bodyOf = (sql, name) => {
  const d = fnDef(sql, name);
  return d ? stripComments(d.body) : null;
};

/** Split on top-level commas: quotes and parentheses understood. */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === "'") { if (text[i + 1] === "'") { cur += "'"; i += 1; } else inStr = false; }
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The parameter list of the LAST definition: [[name, type], …]. */
function params(sql, name) {
  const d = fnDef(sql, name);
  if (!d) return null;
  const header = stripComments(d.header);
  const open = header.indexOf('(');
  const close = header.lastIndexOf(')', header.search(/\nreturns\s/));
  const inner = header.slice(open + 1, close).trim();
  if (!inner) return [];
  return splitTopLevel(inner).map((p) => p.trim().replace(/\s+default\s+[\s\S]*$/i, '').split(/\s+/));
}

/**
 * The parameter list of the LAST definition with what a caller may leave out:
 * [{ name, type, optional }]. A parameter with a default is optional; every other one must be
 * named by a PostgREST call, or the call matches no function.
 */
function paramSpecs(sql, name) {
  const d = fnDef(sql, name);
  if (!d) return null;
  const header = stripComments(d.header);
  const open = header.indexOf('(');
  const close = header.lastIndexOf(')', header.search(/\nreturns\s/));
  const inner = header.slice(open + 1, close).trim();
  if (!inner) return [];
  return splitTopLevel(inner).map((p) => {
    const t = p.trim();
    const [n, type] = t.replace(/\s+(default|=)\s+[\s\S]*$/i, '').split(/\s+/);
    return { name: n, type, optional: /\s(default|=)\s/i.test(t) };
  });
}

/** Whitespace collapsed to one space: the unit a WHOLE-expression pin compares. */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** The arguments of every call to `fn(` in `sql`, split at top level. */
function callsOf(sql, fn) {
  const out = [];
  const open = `${fn}(`;
  let i = 0;
  while ((i = sql.indexOf(open, i)) >= 0) {
    if (/[a-z0-9_]/.test(sql[i - 1] || '')) { i += open.length; continue; }
    let depth = 1;
    let inStr = false;
    let j = i + open.length;
    for (; j < sql.length && depth > 0; j += 1) {
      const c = sql[j];
      if (inStr) { if (c === "'") { if (sql[j + 1] === "'") j += 1; else inStr = false; } continue; }
      if (c === "'") inStr = true;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
    }
    out.push(splitTopLevel(sql.slice(i + open.length, j - 1)).map((a) => a.trim()));
    i = j;
  }
  return out;
}

/** Every single-quoted SQL string on one line, '' un-doubled. */
function sqlStrings(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "'") continue;
    let buf = '';
    let j = i + 1;
    for (; j < line.length; j += 1) {
      if (line[j] === "'" && line[j + 1] === "'") { buf += "'"; j += 1; continue; }
      if (line[j] === "'") break;
      buf += line[j];
    }
    out.push(buf);
    i = j;
  }
  return out;
}

/** Dollar-quoted bodies removed, so only TOP-LEVEL statements remain. */
const topLevel = (sql) => stripComments(sql).replace(/\$([a-z]*)\$[\s\S]*?\$\1\$/g, '$$$$');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sigRe = (name, args) =>
  `public\\.${name}\\(${args.split(',').filter(Boolean).map(esc).join('\\s*,\\s*')}\\)`;
const revokeClient = (name, args) =>
  new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${sigRe(name, args)}\\s+from\\s+public\\s*,\\s*anon\\s*;`, 'i');
const revokeEveryClient = (name, args) =>
  new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${sigRe(name, args)}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`, 'i');
const grantAuthenticated = (name, args) =>
  new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${sigRe(name, args)}\\s+to\\s+authenticated\\s*;`, 'i');

/**
 * Every GRANT statement, parsed whole: its privileges, the kind and names of the objects it
 * covers, and its grantees. ★ A statement may name SEVERAL objects (`on function public.a(),
 * public.b() to anon`), and a pattern anchored on one object right after `on function` never
 * sees the second — so the negative checks below read this parse, never a single-object regex.
 */
function grantsOf(exe) {
  return [...exe.matchAll(/\bgrant\s+([^;]*?)\s+on\s+(table\s+|function\s+|routine\s+)?([^;]*?)\s+to\s+([^;]*?)\s*;/gi)]
    .map((m) => ({
      privs: m[1].trim().toLowerCase().split(/\s*,\s*/),
      kind: (m[2] || 'table').trim().toLowerCase(),
      objects: [...m[3].matchAll(/\bpublic\.([a-z0-9_]+)/gi)].map((x) => x[1].toLowerCase()),
      grantees: m[4].trim().toLowerCase().split(/\s*,\s*/),
    }));
}
/** The function grants that name `fn`, however many other functions the statement names. */
const fnGrantsOf = (exe, fn) => grantsOf(exe).filter((g) => g.kind !== 'table' && g.objects.includes(fn));

/** The staff-seed section: from its banner to the next section banner. */
function seedLines(sql) {
  const a = sql.indexOf('-- == 1) Staff capability');
  if (a < 0) return null;
  const b = sql.indexOf('\n-- == 2)', a);
  return b < 0 ? null : bodyLines(sql.slice(a, b));
}

/** Every `create policy <name> on <target> …;` statement. */
const policiesOf = (exe) => [...exe.matchAll(/create policy (\w+) on ([a-z_]+\.[a-z_]+)([\s\S]*?);/g)]
  .map((m) => ({ name: m[1], target: m[2], text: m[3] }));

// ── Structure ────────────────────────────────────────────────────────────────

test('the dated migration exists', () => {
  assert.ok(dated.length > 0, `${DATED} is missing`);
});

test('the bootstrap carries §56, spliced after §55, preflight dropped, apply-log kept', () => {
  assert.ok(foldAt > 0, `§56 is missing from the bootstrap — fold ${DATED} at the tail`);
  assert.ok(boot.indexOf('-- §55) FOLDED VERBATIM') < foldAt, '§56 must come after §55: it restates §55\'s catalog');
  assert.ok(!/\ndo \$pre\$/.test(fold), 'the fold drops the preflight, as every fold does');
  assert.ok(fold.includes(`('${DATED_NAME}', null,`), 'the fold keeps the schema_migrations row');
});

test('the preflight requires #68, and accepts only the #68 catalog and seed — or a re-run', () => {
  const at = dated.indexOf('do $pre$');
  assert.ok(at >= 0, 'the dated file must open with a do $pre$ preflight');
  const pre = dated.slice(at, dated.indexOf('$pre$;', at + 8));
  assert.match(pre, /filename = '2026-09-28-legacy-migration-round2\.sql'/, 'it needs #68');
  assert.match(pre, /from public\.app_error_catalog\(\)\) not in \(133, 141\)/,
    '133 = the #68 catalog; 141 = a re-run of this file');
  assert.match(pre, /from public\.staff_permissions\) not in \(22, 23\)/,
    '22 = the #67 seed; 23 = a re-run of this file');
  for (const fn of ['public.has_staff_permission(text)', 'public.user_is_approved(uuid)',
    'public.user_is_enrolled(uuid)']) {
    assert.ok(pre.includes(`to_regprocedure('${fn}')`), `the preflight must check ${fn} exists`);
  }
});

for (const [name, sql] of FILES) {
  const exe = stripComments(sql);

  test(`${name}: it ends with notify pgrst, then its own apply-log row, and nothing after`, () => {
    const notify = exe.lastIndexOf("notify pgrst, 'reload schema';");
    const log = exe.lastIndexOf('insert into public.schema_migrations (filename, checksum, notes) values');
    assert.ok(notify > 0, 'new tables and functions are invisible to PostgREST until the schema cache reloads');
    assert.ok(log > notify, 'the reload comes first, then the log row');
    const tail = exe.slice(log);
    assert.ok(tail.includes(`('${DATED_NAME}', null,`), 'the row names this exact file');
    assert.ok(tail.includes('#69'), 'the notes name the migration number');
    const end = tail.indexOf('on conflict (filename) do nothing;');
    assert.ok(end > 0, "#68's exact on-conflict clause, so a re-run is a no-op");
    assert.equal(tail.slice(end + 'on conflict (filename) do nothing;'.length).trim(), '',
      'nothing executable may follow the log row');
  });

  test(`${name}: no top-level transaction control`, () => {
    assert.doesNotMatch(topLevel(sql), /^\s*(begin|commit|rollback|end|start\s+transaction)\b\s*;?\s*$/im,
      'scripts/apply-db-files.mjs sends one statement per call, and the rehearsal wraps the file in its '
      + 'own transaction: an explicit begin/commit here breaks both');
  });

  test(`${name}: every object it creates is re-runnable`, () => {
    for (const m of exe.matchAll(/create\s+(unique\s+)?(table|index)\s+(?!if not exists)/gi)) {
      assert.fail(`"${m[0].trim()}" without "if not exists" — the second run fails`);
    }
    assert.doesNotMatch(exe, /create\s+function/i, 'every function is create or replace');
    for (const p of policiesOf(exe)) {
      assert.ok(exe.includes(`drop policy if exists ${p.name} on ${p.target};`),
        `policy ${p.name} must be dropped before it is created`);
    }
    for (const m of exe.matchAll(/create trigger (\w+)\s+[\s\S]*?\bon (public\.\w+)/g)) {
      assert.ok(exe.includes(`drop trigger if exists ${m[1]} on ${m[2]};`),
        `trigger ${m[1]} must be dropped before it is created`);
    }
  });

  // ── Tables and RLS ──────────────────────────────────────────────────────────

  test(`${name}: the three tables are created, RLS-enabled (never forced), and grant clients SELECT only`, () => {
    assert.doesNotMatch(exe, /force\s+row\s+level\s+security/i,
      'FORCE subjects the table owner to the policies, and there is no write policy: every guard and '
      + 'every SECURITY DEFINER write would be refused');
    // ★ EVERY grant that names one of the tables, parsed whole. A lookahead that skipped any
    //   statement mentioning `select on` let `grant insert, select on …` through beside the real
    //   one, and a pattern anchored on one table missed `grant insert on public.x, public.y`.
    const tableGrants = grantsOf(exe).filter((g) => g.kind === 'table');
    for (const t of TABLES) {
      assert.ok(exe.includes(`create table if not exists public.${t} (`), `${t} is not created`);
      assert.ok(exe.includes(`alter table public.${t} enable row level security;`), `${t} has no RLS`);
      assert.ok(exe.includes(`revoke all on table public.${t} from public, anon, authenticated;`),
        `${t} keeps Supabase's default grants`);
      const mine = tableGrants.filter((g) => g.objects.includes(t));
      assert.equal(mine.length, 1, `${t}: exactly one grant, SELECT, for its one policy`);
      assert.deepEqual(mine[0].privs, ['select'],
        `${t}: a client write grant — every write goes through a SECURITY DEFINER function`);
      assert.deepEqual(mine[0].grantees, ['authenticated'], `${t}: granted to authenticated alone`);
    }
  });

  test(`${name}: every grant names its objects — nothing schema-wide, no default privileges`, () => {
    assert.doesNotMatch(exe, /\bon\s+all\s+(tables|functions|routines|procedures|sequences)\s+in\s+schema\b/i,
      'a schema-wide grant reaches every table and function in the schema, these included');
    assert.doesNotMatch(exe, /\balter\s+default\s+privileges\b/i,
      'default privileges change what every LATER object is born with, far outside this migration');
  });

  test(`${name}: each table has exactly one policy, and it is a SELECT gated as planned`, () => {
    const pols = policiesOf(exe).filter((p) => p.target.startsWith('public.'));
    for (const t of TABLES) {
      const mine = pols.filter((p) => p.target === `public.${t}`);
      assert.equal(mine.length, 1, `${t} must have exactly ONE policy — no insert/update/delete path`);
      assert.match(mine[0].text, /^\s*for select to authenticated\s+using\s*\(/, `${t}: SELECT only`);
      assert.match(mine[0].text, /\(select public\.has_staff_permission\('onboarding\.manage'\)\)/,
        `${t}: the Super Admin reads it, through an InitPlan-wrapped permission check`);
    }
    const progress = pols.find((p) => p.target === 'public.student_onboarding_progress');
    assert.match(progress.text, /user_id = \(select auth\.uid\(\)\)/, 'a student reads their OWN progress');
    const videos = pols.find((p) => p.target === 'public.onboarding_videos');
    assert.doesNotMatch(videos.text, /auth\.uid\(\)/,
      'students never read the videos table: my_onboarding_video() returns the metadata, never a draft');
  });

  test(`${name}: onboarding_videos — one live version, a live row has media, a file lives in its own folder`, () => {
    assert.match(exe, /create unique index if not exists onboarding_videos_one_live\s+on public\.onboarding_videos \(\(true\)\) where status = 'published';/);
    assert.match(exe, /constraint onboarding_videos_live_has_media\s+check \(status <> 'published' or \(storage_path is not null and media_attached_at is not null\)\)/);
    assert.match(exe, /constraint onboarding_videos_path_in_own_folder\s+check \(storage_path is null or split_part\(storage_path, '\/', 2\) = id::text\)/);
    assert.match(exe, /status\s+text not null default 'draft'\s+check \(status in \('draft', 'published', 'retired', 'deleted'\)\)/);
    assert.match(exe, /title\s+text not null check \(char_length\(btrim\(title\)\) between 1 and 120\)/);
    assert.match(exe, /byte_size\s+bigint check \(byte_size is null or byte_size between 1 and 2147483648\)/);
    for (const col of ['published_by', 'retired_by', 'deleted_by', 'created_by']) {
      assert.match(exe, new RegExp(`${col}\\s+uuid references auth\\.users\\(id\\) on delete set null`),
        `${col}: deleting a staff account must not be blocked by a video it once touched`);
    }
  });

  test(`${name}: student_onboarding_progress — per student per version; the video FK restricts`, () => {
    const t = exe.slice(exe.indexOf('create table if not exists public.student_onboarding_progress ('));
    const ddl = t.slice(0, t.indexOf(');') + 2);
    assert.match(ddl, /user_id\s+uuid not null references public\.profiles\(id\) on delete cascade/);
    assert.match(ddl, /video_id\s+uuid not null references public\.onboarding_videos\(id\) on delete restrict/);
    assert.match(ddl, /primary key \(user_id, video_id\)/);
    for (const col of ['first_started_at', 'last_started_at', 'completed_at', 'last_problem_at',
      'last_problem_code', 'created_at', 'updated_at']) {
      assert.match(ddl, new RegExp(`\\b${col}\\s`), `${col} is missing`);
    }
    assert.match(exe, /create index if not exists \w+\s+on public\.student_onboarding_progress \(video_id, completed_at\);/);
  });

  test(`${name}: the audit trail is append-only, with the FK SET NULL exemption`, () => {
    const t = exe.slice(exe.indexOf('create table if not exists public.onboarding_video_events ('));
    const ddl = t.slice(0, t.indexOf(');') + 2);
    assert.match(ddl, /id\s+bigint generated always as identity primary key/);
    assert.match(ddl, /video_id\s+uuid references public\.onboarding_videos\(id\) on delete set null/);
    assert.match(ddl, /actor_id\s+uuid references auth\.users\(id\) on delete set null/);
    const g = bodyOf(sql, 'onboarding_video_events_guard');
    assert.ok(g, 'onboarding_video_events_guard() is not defined');
    assert.match(g, /if tg_op = 'UPDATE'/);
    assert.match(g, /\(new\.video_id is not distinct from old\.video_id or new\.video_id is null\)/);
    assert.match(g, /\(new\.actor_id is not distinct from old\.actor_id or new\.actor_id is null\)/);
    assert.match(exe, /create trigger onboarding_video_events_guard\s+before update or delete on public\.onboarding_video_events/);
  });

  test(`${name}: the version guard refuses a row delete and enforces the state machine`, () => {
    const g = bodyOf(sql, 'onboarding_videos_guard');
    assert.ok(g, 'onboarding_videos_guard() is not defined');
    assert.match(exe, /create trigger onboarding_videos_guard\s+before update or delete on public\.onboarding_videos/);
    assert.match(g, /if tg_op = 'DELETE' then/, 'history is permanent: a row delete is refused');
    assert.match(g, /old\.status = 'draft'\s+and new\.status in \('published', 'deleted'\)/);
    assert.match(g, /old\.status = 'published' and new\.status = 'retired'/);
    assert.match(g, /old\.status = 'retired'\s+and new\.status in \('published', 'deleted'\)/);
    assert.match(g, /not \(old\.status = 'draft' and new\.status = 'draft'\)/, 'media changes only draft → draft');
    assert.match(g, /new\.updated_at := now\(\);/, 'the guard stamps updated_at');
    for (const col of ['published_by', 'retired_by', 'deleted_by', 'created_by']) {
      assert.match(g, new RegExp(`new\\.${col} is distinct from old\\.${col} and new\\.${col} is not null`),
        `${col} may always become NULL (the FK action), and otherwise only in its own transition`);
    }
  });

  // ── The copies ──────────────────────────────────────────────────────────────

  test(`${name}: the staff seed is #67 §1 with exactly the two onboarding.manage tuples added`, () => {
    const was = seedLines(read(SEED_SOURCE));
    const now = seedLines(sql);
    assert.ok(was && now, 'both files must carry a "-- == 1) Staff capability" section');
    const removed = was.filter((l) => !now.includes(l));
    const added = now.filter((l) => !was.includes(l));
    assert.equal(removed.length, 2, `only the two last tuples may change (they gain a comma): ${JSON.stringify(removed)}`);
    assert.ok(removed[0].startsWith("('meetings.manage',"), 'the last permission tuple gains a comma');
    assert.equal(removed[1], "('trainer', 'community.moderate')", 'the last grant tuple gains a comma');
    assert.equal(added.length, 4, `exactly the two commas and the two new tuples: ${JSON.stringify(added)}`);
    assert.equal(added[0], `${removed[0]},`);
    assert.equal(added[2], `${removed[1]},`);
    assert.equal(added[3], "('super_admin', 'onboarding.manage')", 'super_admin ALONE holds it, last in the list');
    const js = STAFF_PERMISSIONS.find((p) => p.key === 'onboarding.manage');
    assert.ok(js, 'onboarding.manage must exist in src/lib/staffRoles.js');
    assert.deepEqual(sqlStrings(added[1]), [js.key, js.category, js.label, js.description],
      'the seeded tuple must say exactly what the JS mirror says');
    assert.ok(added[1].endsWith("')"), 'it is the LAST tuple, so it takes no comma');
    // Last inside each VALUES list — never a second INSERT.
    assert.equal(now[now.indexOf(added[1]) + 1], 'on conflict (key) do update');
    assert.equal(now[now.indexOf(added[3]) + 1], 'on conflict do nothing;');
    for (const t of ['staff_roles', 'staff_permissions', 'staff_role_permissions']) {
      assert.equal((exe.match(new RegExp(`insert into public\\.${t} \\(`, 'g')) || []).length, 1,
        `exactly one insert into ${t}: a new tuple goes INSIDE the copied VALUES list`);
    }
  });

  test(`${name}: app_error_catalog() is #68's, plus a comma and the eight ONBOARDING_VIDEO_* rows — 141 codes`, () => {
    const src = fnDef(read(CATALOG_SOURCE), 'app_error_catalog');
    const mine = fnDef(sql, 'app_error_catalog');
    assert.ok(src && mine, 'app_error_catalog() must be defined in both files');
    assert.equal(mine.header, src.header, 'the signature and attributes are copied unchanged');
    const was = bodyLines(src.body);
    const now = bodyLines(mine.body);
    const removed = was.filter((l) => !now.includes(l));
    const added = now.filter((l) => !was.includes(l));
    assert.equal(removed.length, 1, `only LEGACY_BATCH_GAP may change: ${JSON.stringify(removed)}`);
    assert.ok(removed[0].startsWith("('LEGACY_BATCH_GAP',"));
    assert.equal(added[0], `${removed[0]},`, 'LEGACY_BATCH_GAP gains the comma the new rows need');
    const rows = added.slice(1);
    assert.equal(rows.length, 8, `exactly eight new rows: ${JSON.stringify(rows)}`);
    const parsed = rows.map((l) => /^\('(ONBOARDING_VIDEO_[A-Z_]+)',\s*(\d{3}),\s*'(?:[^']|'')+'\)(,?)$/.exec(l));
    assert.ok(parsed.every(Boolean), `every new row is ('CODE', http, 'summary'): ${JSON.stringify(rows)}`);
    assert.deepEqual(parsed.map((m) => m[1]), ONBOARDING_CODES, 'the rows follow APP_ERROR_CODES, in order');
    for (const m of parsed) assert.equal(Number(m[2]), ONBOARDING_HTTP[m[1]], `${m[1]}: HTTP status`);
    assert.deepEqual(parsed.map((m) => m[3]), [...Array(7).fill(','), ''], 'the last row takes no comma');
    const codes = [...mine.body.matchAll(/\('([A-Z_]+)',/g)].map((m) => m[1]);
    assert.equal(codes.length, 141, '133 inherited + 8');
    assert.equal(new Set(codes).size, 141, 'no code is listed twice');
  });

  // ── Function security ───────────────────────────────────────────────────────

  const created = [...exe.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)].map((m) => m[1]);

  test(`${name}: every function is SECURITY DEFINER with search_path pinned — but the path parser and the catalog`, () => {
    assert.ok(created.length >= 20, `expected the #69 functions, found ${created.length}`);
    for (const fn of created) {
      if (fn === 'app_error_catalog') continue;   // copied verbatim from #68
      const header = stripComments(fnDef(sql, fn).header);
      assert.match(header, /set search_path = public, pg_temp/, `${fn}: search_path must be pinned, pg_temp last`);
      if (fn === 'onboarding_video_path_version_id') {
        assert.match(header, /\bimmutable\b/, 'the path parser is immutable');
        assert.doesNotMatch(header, /security definer/, 'the path parser needs no privileges');
      } else {
        assert.match(header, /security definer/, `${fn} must be SECURITY DEFINER`);
      }
    }
  });

  test(`${name}: every function is in exactly one ACL class, under its real signature`, () => {
    const classes = [CLIENT_RPCS, POLICY_HELPERS, INTERNAL];
    for (const fn of created) {
      if (fn === 'app_error_catalog') continue;
      assert.equal(classes.filter((c) => fn in c).length, 1, `${fn} must be in exactly one ACL class`);
    }
    for (const cls of classes) {
      for (const [fn, args] of Object.entries(cls)) {
        const p = params(sql, fn);
        assert.ok(p, `${fn} is not defined`);
        assert.equal(p.map((x) => x[1]).join(','), args, `${fn}: the ACL statements name (${args})`);
      }
    }
  });

  /** Every grant of `fn` is EXECUTE to authenticated alone: no other grantee, privilege or grant option. */
  const onlyExecuteToAuthenticated = (fn) => {
    for (const g of fnGrantsOf(exe, fn)) {
      assert.deepEqual(g.privs, ['execute'], `${fn}: EXECUTE is the only privilege a function grant needs`);
      assert.deepEqual(g.grantees, ['authenticated'],
        `${fn}: a grant to anon, public or anyone else beside the right pair undoes the revoke`);
    }
  };

  test(`${name}: client RPCs are revoked from public and anon, and granted to authenticated`, () => {
    for (const [fn, args] of Object.entries(CLIENT_RPCS)) {
      assert.match(exe, revokeClient(fn, args), `${fn}: revoke all … from public, anon`);
      assert.match(exe, grantAuthenticated(fn, args), `${fn}: grant execute … to authenticated`);
      onlyExecuteToAuthenticated(fn);
    }
  });

  test(`${name}: the storage-policy helpers are granted to authenticated`, () => {
    for (const [fn, args] of Object.entries(POLICY_HELPERS)) {
      assert.match(exe, revokeClient(fn, args), `${fn}: revoke all … from public, anon`);
      assert.match(exe, grantAuthenticated(fn, args),
        `${fn} runs AS THE CALLER inside a storage policy: without this grant every storage.objects `
        + 'statement fails with "permission denied for function", in every bucket');
      onlyExecuteToAuthenticated(fn);
    }
  });

  test(`${name}: internal functions are revoked from every client role and granted to none`, () => {
    for (const [fn, args] of Object.entries(INTERNAL)) {
      assert.match(exe, revokeEveryClient(fn, args), `${fn}: revoke all … from public, anon, authenticated`);
      assert.deepEqual(fnGrantsOf(exe, fn), [], `${fn} must never be granted to a client role`);
      // user_onboarding_video_state is ALSO revoked right after its definition (the
      // apply-db-files.mjs window). Every revoke of an internal function must name authenticated:
      // a narrowed one is correct only while a later full revoke happens to follow it.
      for (const m of exe.matchAll(new RegExp(`revoke\\s+[^;]*\\bon\\s+function\\s+public\\.${fn}\\([^)]*\\)\\s+from\\s+([^;]+);`, 'gi'))) {
        assert.match(m[1], /\bauthenticated\b/, `${fn}: a revoke that leaves authenticated out`);
      }
    }
  });

  test(`${name}: section 10 lists all three ACL classes, complete and in order`, () => {
    const at = sql.indexOf('-- == 10) Grants');
    assert.ok(at > 0, 'section 10 is the one place the ACLs are listed');
    const s10 = stripComments(sql.slice(at, sql.indexOf("notify pgrst, 'reload schema';", at)));
    const firstOf = (cls, re) => Math.min(...Object.entries(cls).map(([fn, args]) => {
      const m = re(fn, args).exec(s10);
      assert.ok(m, `section 10 must list ${fn}`);
      return m.index;
    }));
    const lastOf = (cls, re) => Math.max(...Object.entries(cls).map(([fn, args]) => re(fn, args).exec(s10).index));
    assert.ok(lastOf(CLIENT_RPCS, grantAuthenticated) < firstOf(POLICY_HELPERS, revokeClient)
      && lastOf(POLICY_HELPERS, grantAuthenticated) < firstOf(INTERNAL, revokeEveryClient),
    'three classes, listed separately: client RPCs, then policy helpers, then internal');
    for (const [fn, args] of Object.entries({ ...CLIENT_RPCS, ...POLICY_HELPERS })) {
      assert.match(s10, revokeClient(fn, args), `section 10: revoke ${fn} from public, anon`);
    }
  });

  test(`${name}: every function a storage.objects policy calls is executable by authenticated`, () => {
    const pols = policiesOf(exe).filter((p) => p.target === 'storage.objects');
    assert.deepEqual(pols.map((p) => p.name).sort(), [...STORAGE_POLICIES].sort(), 'exactly the four onboarding policies');
    const named = new Set(pols.flatMap((p) => [...p.text.matchAll(/public\.([a-z0-9_]+)\(/g)].map((m) => m[1])));
    assert.ok(named.size >= 4, 'the policies call the helpers');
    for (const fn of named) {
      if (fn in POLICY_HELPERS) {
        assert.match(exe, grantAuthenticated(fn, POLICY_HELPERS[fn]), `${fn} must be granted to authenticated`);
      } else {
        assert.equal(fn, 'has_staff_permission', `${fn} is called by a storage policy but is not a policy helper`);
        assert.match(stripComments(boot), /grant execute on function public\.has_staff_permission\(text\) to authenticated;/,
          'has_staff_permission(text) is granted to authenticated by #45');
      }
    }
  });

  test(`${name}: student RPCs take no user, path or video id — the one parameter is p_code`, () => {
    for (const fn of STUDENT_RPCS) {
      const p = params(sql, fn);
      assert.ok(p, `${fn} is not defined`);
      if (fn === 'report_onboarding_video_problem') {
        assert.deepEqual(p, [['p_code', 'text']], 'report_onboarding_video_problem(p_code text), nothing else');
      } else {
        assert.deepEqual(p, [], `${fn}() takes no arguments: the subject is auth.uid()`);
      }
      assert.match(bodyOf(sql, fn), /\(select auth\.uid\(\)\)/, `${fn} derives its subject from auth.uid()`);
    }
  });

  test(`${name}: every admin RPC opens with the onboarding.manage guard; the facts with enrollments.review`, () => {
    const opensWith = (fn, perm) => {
      const lines = bodyLines(bodyOf(sql, fn) || '');
      const at = lines.indexOf('begin');
      assert.ok(at > 0, `${fn} has no begin`);
      assert.equal(lines[at + 1], `if not public.has_staff_permission('${perm}') then`,
        `${fn}: the permission check is the FIRST statement`);
      assert.match(lines[at + 2], /^perform public\.app_error\('FORBIDDEN',/);
    };
    for (const fn of ADMIN_RPCS) opensWith(fn, 'onboarding.manage');
    opensWith('enrollment_decision_email_facts', 'enrollments.review');
  });

  // ── Who is asked to watch ───────────────────────────────────────────────────

  test(`${name}: user_onboarding_video_state — the gate rule, staff excluded, required a boolean`, () => {
    const b = bodyOf(sql, 'user_onboarding_video_state');
    assert.ok(b, 'user_onboarding_video_state() is not defined');
    assert.match(b, /select min\(published_at\) into v_since\s+from public\.onboarding_videos\s+where published_at is not null;/,
      'the cutoff is the FIRST publish of ANY version — never filtered by status (edge c)');
    assert.match(b, /select min\(s\.created_at\) into v_first\s+from public\.subscriptions s\s+where s\.user_id = p_user;/,
      'the FIRST subscription row, whatever its status (edges a and b)');
    assert.match(b, /\bis_admin\b/, 'is_admin is staff');
    assert.match(b, /m\.status in \('invited', 'active'\)/, "staff = an 'invited' or 'active' membership (#50/#52)");
    assert.match(b, /coalesce\(public\.user_is_approved\(p_user\) and public\.user_is_enrolled\(p_user\), false\)/);
    assert.match(b, new RegExp(`o\\.bucket_id = '${esc(GS.ONBOARDING_VIDEO_BUCKET)}' and o\\.name = v_video\\.storage_path`),
      'the live file must really be in storage, or nobody is gated');
    assert.match(b, /'required',\s*coalesce\([\s\S]*?v_first >= v_since, false\)/,
      '`required` is coalesced to false: always a JSON boolean, never null');
    assert.match(b, /select min\(g\.completed_at\) into v_done\s+from public\.student_onboarding_progress g\s+where g\.user_id = p_user and g\.completed_at is not null;/,
      'a completion of ANY version counts: scoped to the live one, publishing V2 would ask every V1 finisher again');
    for (const term of ['v_media', 'v_eligible', 'not v_staff', 'v_done is null', 'v_since is not null',
      'v_first is not null']) {
      const req = b.slice(b.indexOf("'required',"));
      assert.ok(req.includes(term), `required must include ${term}`);
    }
  });

  // ★ THE RULE WHOLE, OPERATORS INCLUDED (TDR-2). The term checks above pass `and` → `or`: with
  //   `… and not v_staff or v_done is null and …` the expression parses as (A∧B∧C∧D) ∨ (E∧F∧G∧H),
  //   and a student who joined after the cutoff and finished nothing is held with nothing live, a
  //   missing file, a lapsed term or a staff membership — a player whose start answers UNAVAILABLE
  //   at every sign-in. The same holds one level down: each input the rule reads is an operator
  //   away from meaning something else (staff = is_admin AND a membership stops counting an
  //   Operations Admin who is also a paying member as staff, so they are gated like a student).
  //   So the four statements are compared whole, whitespace collapsed — and so are the two
  //   completion lookups beside them. `user_id = p_user OR video_id = <live>` in the second one
  //   reads ANOTHER student's row, and `completed_current` — which the replay recorder trusts —
  //   then says this student finished a version they never opened.
  test(`${name}: user_onboarding_video_state — the rule, its inputs and the completion lookups, pinned whole (operators too)`, () => {
    const b = norm(bodyOf(sql, 'user_onboarding_video_state') || '');
    const whole = [
      "v_staff := coalesce((select p.is_admin from public.profiles p where p.id = p_user), false) "
        + "or exists (select 1 from public.staff_memberships m where m.user_id = p_user and m.status in ('invited', 'active'));",
      'v_eligible := coalesce(public.user_is_approved(p_user) and public.user_is_enrolled(p_user), false);',
      `v_media := v_video.id is not null and exists ( select 1 from storage.objects o where o.bucket_id = '${GS.ONBOARDING_VIDEO_BUCKET}' `
        + 'and o.name = v_video.storage_path);',
      "'required', coalesce(v_video.id is not null and v_media and v_eligible and not v_staff and v_done is null "
        + 'and v_since is not null and v_first is not null and v_first >= v_since, false))',
      'select min(g.completed_at) into v_done from public.student_onboarding_progress g '
        + 'where g.user_id = p_user and g.completed_at is not null;',
      'select g.completed_at into v_done_cur from public.student_onboarding_progress g '
        + 'where g.user_id = p_user and g.video_id = v_video.id;',
    ];
    for (const stmt of whole) {
      assert.ok(b.includes(stmt), `the rule must read, operators and all: ${stmt}`);
    }
    // Each value is set ONCE — counted in both forms a later line could override it with.
    for (const v of ['v_video', 'v_since', 'v_first', 'v_staff', 'v_eligible', 'v_media', 'v_done', 'v_done_cur']) {
      assert.equal((b.match(new RegExp(`\\b${v}\\s*:=|\\binto\\s+${v}\\b`, 'g')) || []).length, 1,
        `${v} is assigned once: a second assignment would override it`);
    }
    assert.equal(b.split("'required',").length - 1, 1,
      'one `required` key: jsonb_build_object keeps the LAST of two, so a second one would override the rule');
  });

  test(`${name}: my_onboarding_video never returns a path, and shows the video only to a viewer or manager`, () => {
    const b = bodyOf(sql, 'my_onboarding_video');
    assert.ok(b, 'my_onboarding_video() is not defined');
    assert.doesNotMatch(b, /storage_path/, 'no path: start_onboarding_video() discloses it, to an eligible viewer only');
    assert.match(b, /\(v_state->>'eligible'\)::boolean or v_manage/, 'metadata only to an eligible viewer or a manager');
    assert.match(b, /'required',\s*coalesce\(\(v_state->>'required'\)::boolean, false\)/);
    for (const key of ['configured', 'eligible', 'required', 'completed', 'completed_at', 'completed_current',
      'media_available', 'can_manage', 'video']) {
      assert.ok(b.includes(`'${key}',`), `my_onboarding_video() returns ${key}`);
    }
  });

  // ── Storage ─────────────────────────────────────────────────────────────────

  test(`${name}: the bucket is private, LESSON_VIDEO_MAX_BYTES, LESSON_VIDEO_UPLOAD_MIMES`, () => {
    const m = /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s*values \('([^']+)', '([^']+)', (\w+), (\d+),\s*array\[([^\]]*)\]\)\s*on conflict \(id\) do update([\s\S]*?);/.exec(exe);
    assert.ok(m, 'the bucket insert must carry an on-conflict update');
    assert.equal(m[1], GS.ONBOARDING_VIDEO_BUCKET);
    assert.equal(m[2], GS.ONBOARDING_VIDEO_BUCKET);
    assert.equal(m[3], 'false', 'the bucket is PRIVATE: a public bucket serves every object and bypasses RLS');
    assert.equal(Number(m[4]), LESSON_VIDEO_MAX_BYTES, 'the size limit is the lesson video limit');
    assert.deepEqual(sqlStrings(m[5]), [...LESSON_VIDEO_UPLOAD_MIMES], 'the MIME list is the lesson video list');
    assert.match(m[6], /public\s*=\s*false/, 'a re-run can never flip it public');
    assert.match(m[6], /file_size_limit\s*=\s*excluded\.file_size_limit/);
    assert.match(m[6], /allowed_mime_types\s*=\s*excluded\.allowed_mime_types/);
  });

  // ★ THE MANUAL FALLBACK STATES THE LIMIT IN BYTES. The Dashboard reads "2 GB" as 2,000,000,000,
  //   under LESSON_VIDEO_MAX_BYTES — the trap scripts/storage-config.mjs was written about.
  test(`${name}: the bucket notice gives the exact byte limit, never "a 2 GB" one`, () => {
    const notices = [...exe.matchAll(/raise notice '((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    const notice = notices.find((s) => s.includes(`"${GS.ONBOARDING_VIDEO_BUCKET}"`));
    assert.ok(notice, 'the bucket block tells whoever runs it how to create the bucket by hand');
    assert.ok(notice.includes(`${LESSON_VIDEO_MAX_BYTES} bytes`), `the limit is stated as ${LESSON_VIDEO_MAX_BYTES} bytes`);
    assert.doesNotMatch(notice, /\ba 2 GB file size limit\b/i, '"2 GB" typed into the Dashboard is 147 MB short');
    for (const mime of LESSON_VIDEO_UPLOAD_MIMES) assert.ok(notice.includes(mime), `the notice names ${mime}`);
  });

  test(`${name}: every bucket literal is ONBOARDING_VIDEO_BUCKET, and every onboarding policy names it`, () => {
    const literals = [...exe.matchAll(/bucket_id = '([^']+)'/g)].map((m) => m[1]);
    assert.ok(literals.length >= 7, 'the four policies, the state, the overview, attach and publish read it');
    assert.deepEqual([...new Set(literals)], [GS.ONBOARDING_VIDEO_BUCKET]);
    for (const p of policiesOf(exe).filter((x) => x.target === 'storage.objects')) {
      assert.ok(p.text.includes(`bucket_id = '${GS.ONBOARDING_VIDEO_BUCKET}'`), `${p.name} must name the bucket`);
    }
  });

  test(`${name}: storage policies read by reference, write by path, never delete the live object`, () => {
    const pol = Object.fromEntries(policiesOf(exe).filter((p) => p.target === 'storage.objects').map((p) => [p.name, p.text]));
    const staff = "(select public.has_staff_permission('onboarding.manage'))";
    assert.match(pol.onboarding_videos_object_read, /^\s*for select to authenticated\s+using/);
    assert.ok(pol.onboarding_videos_object_read.includes(staff));
    assert.ok(pol.onboarding_videos_object_read.includes('public.onboarding_video_object_readable(name)'),
      'a student reads the ONE object the published row cites');
    assert.ok(!pol.onboarding_videos_object_read.includes('onboarding_video_upload_allowed'),
      'a read is never authorized by the write-side path parser');
    assert.match(pol.onboarding_videos_object_insert, /^\s*for insert to authenticated\s+with check/);
    assert.match(pol.onboarding_videos_object_update, /^\s*for update to authenticated\s+using/);
    for (const k of ['onboarding_videos_object_insert', 'onboarding_videos_object_update']) {
      assert.ok(pol[k].includes(staff), `${k}: Super Admin only`);
      assert.ok(pol[k].includes('public.onboarding_video_upload_allowed(name)'), `${k}: into a draft's folder only`);
      assert.ok(!pol[k].includes('onboarding_video_object_readable'), `${k}: never the read helper`);
    }
    assert.match(pol.onboarding_videos_object_delete, /^\s*for delete to authenticated\s+using/);
    assert.ok(pol.onboarding_videos_object_delete.includes(staff));
    assert.ok(pol.onboarding_videos_object_delete.includes('not public.onboarding_video_object_is_live(name)'),
      'the live object can never be deleted');
    for (const text of Object.values(pol)) {
      assert.doesNotMatch(text.replace(/\(select public\.has_staff_permission\(/g, ''), /has_staff_permission\(/,
        'wrap the permission check as (select …) so it runs once per statement');
    }
  });

  // ★ EVERY POLICY WHOLE, OPERATORS INCLUDED (TDR-2). The test above checks each policy's TERMS; it
  //   passes `… and (select …manage) or public.onboarding_video_upload_allowed(name)`, which
  //   parses as (bucket ∧ staff) ∨ upload_allowed — a Super Admin then upserts over the LIVE object,
  //   the one thing the write policies exist to stop — and a read policy whose top-level `and`
  //   became `or` serves every object in this bucket to anyone signed in. So each of the seven
  //   policies is compared whole, whitespace collapsed.
  test(`${name}: all seven policies, pinned whole (operators too)`, () => {
    const B = GS.ONBOARDING_VIDEO_BUCKET;
    const staff = "(select public.has_staff_permission('onboarding.manage'))";
    const got = Object.fromEntries(policiesOf(exe).map((p) => [p.name, norm(p.text)]));
    assert.deepEqual(got, {
      onboarding_videos_manage_read: `for select to authenticated using (${staff})`,
      student_onboarding_progress_read: `for select to authenticated using (user_id = (select auth.uid()) or ${staff})`,
      onboarding_video_events_manage_read: `for select to authenticated using (${staff})`,
      onboarding_videos_object_read:
        `for select to authenticated using (bucket_id = '${B}' and (${staff} or public.onboarding_video_object_readable(name)))`,
      onboarding_videos_object_insert:
        `for insert to authenticated with check (bucket_id = '${B}' and ${staff} and public.onboarding_video_upload_allowed(name))`,
      onboarding_videos_object_update:
        `for update to authenticated using (bucket_id = '${B}' and ${staff} and public.onboarding_video_upload_allowed(name))`,
      onboarding_videos_object_delete:
        `for delete to authenticated using (bucket_id = '${B}' and ${staff} and not public.onboarding_video_object_is_live(name))`,
    });
  });

  test(`${name}: the policy helpers check what the plan says, and fail closed`, () => {
    const readable = bodyOf(sql, 'onboarding_video_object_readable');
    assert.match(readable, /v\.status = 'published' and v\.storage_path = p_name/);
    assert.match(readable, /\(select auth\.uid\(\)\) is not null/);
    assert.match(readable, /public\.user_is_approved\(\(select auth\.uid\(\)\)\)/);
    assert.match(readable, /public\.user_is_enrolled\(\(select auth\.uid\(\)\)\)/);
    const upload = bodyOf(sql, 'onboarding_video_upload_allowed');
    assert.match(upload, /public\.has_staff_permission\('onboarding\.manage'\)/, 'no oracle for non-managers');
    assert.match(upload, /v\.status = 'draft'/);
    assert.match(upload, /v\.id = public\.onboarding_video_path_version_id\(p_name\)/,
      'a NULL parse matches no row, so it authorizes nothing');
    const live = bodyOf(sql, 'onboarding_video_object_is_live');
    assert.match(live, /public\.has_staff_permission\('onboarding\.manage'\)/, 'no oracle for non-managers');
    assert.match(live, /v\.status = 'published' and v\.storage_path = p_name/);
  });

  // ★ THE HELPERS WHOLE, OPERATORS INCLUDED (TDR-2, one level down). The policies are pinned whole
  //   above, but each one calls a helper, and the test before this one checks a helper's TERMS — it
  //   passes `and` → `or` inside a body. Then a Super Admin may write ANY name, the live object
  //   included (upload_allowed: `staff OR a draft's folder`); every signed-in user reads every
  //   object in the bucket (readable: `signed in OR …`), or an approved or an enrolled one reads
  //   the drafts (its last two `and`s); and the live check answers true for every name, so no
  //   Super Admin can delete any file at all (is_live). So each body is compared WHOLE.
  test(`${name}: the three storage helpers, pinned whole (operators too)`, () => {
    for (const [fn, whole] of Object.entries(HELPER_BODIES)) {
      assert.equal(norm(bodyOf(sql, fn) || ''), whole,
        `${fn} must be exactly this one statement, operators and all — nothing beside it either: ${whole}`);
    }
  });

  test(`${name}: the path CHECK and the parser share one pattern, which behaves as ONBOARDING_VIDEO_PATH_RE`, () => {
    const check = /storage_path is null or storage_path ~ '([^']+)'/.exec(exe);
    assert.ok(check, 'the storage_path CHECK is missing');
    const parser = bodyOf(sql, 'onboarding_video_path_version_id');
    assert.ok(parser, 'onboarding_video_path_version_id() is not defined');
    const parsed = /when p_name ~ '([^']+)'/.exec(parser);
    assert.ok(parsed, 'the parser must test the same kind of pattern (case-sensitive ~, never ~*)');
    assert.equal(parsed[1], check[1], 'the CHECK and the parser use ONE pattern');
    assert.match(parser, /then split_part\(p_name, '\/', 2\)::uuid/, 'the id is the second segment, as in the JS');
    assert.match(parser, /else null/, 'anything else is NULL, and NULL authorizes nothing');
    const sqlRe = new RegExp(check[1]);
    assert.equal(sqlRe.source.replace(/\\\//g, '/'),
      GS.ONBOARDING_VIDEO_PATH_RE.source.replace(/\\\//g, '/').replace('(', '').replace(')', ''),
      'the SQL pattern is the JS pattern minus its capture group');
    const A = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const B = '11111111-2222-4333-8444-555555555555';
    const good = GS.buildOnboardingVideoPath(A, B);
    const hostile = [
      `versions/${A}/${B}.MP4`, `versions/${A.toUpperCase()}/${B}.mp4`, `versions/${A}/${B}`,
      `versions/${A}/${B}.mov`, `versions/${A}/${B}.mp4/extra`, `versions/${A}/x/${B}.mp4`,
      `versions/../${A}/${B}.mp4`, `../versions/${A}/${B}.mp4`, `/versions/${A}/${B}.mp4`,
      `versions/${A}/${B}.mp4\n`, ` versions/${A}/${B}.mp4`, `versions/${A}/${B}.mp4 `,
      `versions/not-a-uuid/${B}.mp4`, `versions/${A}/${B}.mp4.mp4`, `versions//${B}.mp4`,
      `lessons/${A}/${B}.mp4`, `versions/${A}/${B}xmp4`, `versions/${A.slice(0, -1)}/${B}.mp4`, '',
    ];
    assert.equal(sqlRe.test(good), true);
    assert.equal(GS.ONBOARDING_VIDEO_PATH_RE.test(good), true);
    for (const p of hostile) {
      assert.equal(sqlRe.test(p), GS.ONBOARDING_VIDEO_PATH_RE.test(p), `the patterns disagree on ${JSON.stringify(p)}`);
      assert.equal(sqlRe.test(p), false, `${JSON.stringify(p)} must be refused`);
    }
  });

  // ── Watching and finishing ──────────────────────────────────────────────────

  test(`${name}: the elapsed guard is built from the three JS constants, the duration coalesced`, () => {
    const b = bodyOf(sql, 'complete_onboarding_video');
    assert.ok(b, 'complete_onboarding_video() is not defined');
    const n = (x) => esc(String(x));
    // ★ ANCHORED AT BOTH ENDS: the whole assignment, up to its semicolon. Unanchored, a
    //   `… , 5) * 0;` appended to the statement still matched, and the guard waited for nothing.
    const guard = new RegExp(`v_min_secs\\s*:=\\s*greatest\\(\\s*coalesce\\(\\s*v_video\\.duration_seconds\\s*,\\s*${n(GS.ONBOARDING_UNKNOWN_DURATION_SECONDS)}\\s*\\)`
      + `\\s*\\*\\s*${n(GS.ONBOARDING_MIN_ELAPSED_FRACTION)}\\s*,\\s*${n(GS.ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS)}\\s*\\)\\s*;`);
    assert.match(b, guard,
      'v_min_secs := greatest(coalesce(duration, ONBOARDING_UNKNOWN_DURATION_SECONDS) × ONBOARDING_MIN_ELAPSED_FRACTION, ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS);');
    assert.doesNotMatch(b.replace(guard, ''), /duration_seconds\s*\*/, 'no uncoalesced duration operand anywhere');
    assert.equal((b.match(/\bv_min_secs\s*:=/g) || []).length, 1, 'v_min_secs is assigned once: a second assignment would override the guard');
    assert.match(b, /v_ready_at := v_row\.first_started_at \+ make_interval\(secs => v_min_secs::double precision\);/,
      'counted from the FIRST open, and nothing appended to the interval');
    assert.equal((b.match(/\bv_ready_at\s*:=/g) || []).length, 1, 'v_ready_at is assigned once');
    assert.match(b, /if now\(\) < v_ready_at then\s+perform public\.app_error\('ONBOARDING_VIDEO_NOT_FINISHED'/,
      'refused while now() is still BEFORE the ready time — a flipped comparator refuses every honest viewer and admits a forger');
  });

  test(`${name}: complete writes the CALLER's own row for the live version, and nothing else`, () => {
    const b = bodyOf(sql, 'complete_onboarding_video');
    assert.match(b, /update public\.student_onboarding_progress\s+set completed_at = coalesce\(completed_at, now\(\)\),\s+updated_at = now\(\)\s+where user_id = v_uid and video_id = v_video\.id\s+returning completed_at into v_done_at;/,
      'without `user_id = v_uid` the update names every student\'s row for the live version');
    assert.equal((b.match(/\bupdate public\.student_onboarding_progress\b/g) || []).length, 1, 'one write');
    assert.doesNotMatch(b, /\binsert into\b|\bdelete from\b/, 'a completion never creates or removes a row');
  });

  // ★ READ COMMITTED: a statement that waited on the live row re-reads it when the publish that
  //   held it commits. The row it found is no longer live, and the new version was still a
  //   draft in its snapshot, so one look answers "nothing is live" while a video IS live.
  //   (A row that IS returned always matches the WHERE: FOR SHARE re-checks it on the newest
  //   version. So "no row" is the one case, and it is `v_video.id is null`.)
  test(`${name}: complete looks at the live row a second time before it answers UNAVAILABLE`, () => {
    const d = fnDef(sql, 'complete_onboarding_video');
    assert.match(stripComments(d.header), /\bvolatile\b/,
      'VOLATILE is what gives each statement its own snapshot: in a STABLE function the second look sees the first one\'s data');
    const b = bodyOf(sql, 'complete_onboarding_video');
    const locked = "select * into v_video from public.onboarding_videos where status = 'published' for share;";
    assert.equal(b.split(locked).length - 1, 2,
      'the live row is read, locked, at most twice: the second look must lock it too, or the version it finds can be retired before the completion is written');
    const first = b.indexOf(locked);
    const second = b.indexOf(locked, first + 1);
    const notLive = 'if v_video.id is null then';
    assert.equal(b.slice(first + locked.length, second).trim(), notLive,
      'the second read runs only when the first found no live row');
    const unavailable = b.indexOf("'ONBOARDING_VIDEO_UNAVAILABLE'");
    assert.ok(unavailable > second, 'UNAVAILABLE only after the second, fresh-snapshot read');
    assert.match(b.slice(second + locked.length, unavailable), new RegExp(`^\\s*end if;\\s*${esc(notLive)}\\s*perform public\\.app_error\\($`),
      'UNAVAILABLE only when the fresh read found nothing live either');
    assert.equal((b.match(/'ONBOARDING_VIDEO_UNAVAILABLE'/g) || []).length, 1);
  });

  test(`${name}: a completion is never re-stamped`, () => {
    assert.match(exe, /completed_at = coalesce\(completed_at, now\(\)\)/);
    assert.doesNotMatch(exe, /completed_at\s*=\s*now\(\)/, 'a replay must keep the first completion (#52/#53)');
  });

  test(`${name}: complete locks the live row FOR SHARE and the progress row FOR UPDATE`, () => {
    const b = bodyOf(sql, 'complete_onboarding_video');
    assert.match(b, /from public\.onboarding_videos where status = 'published' for share;/);
    assert.match(b, /from public\.student_onboarding_progress g\s+where g\.user_id = v_uid and g\.video_id = v_video\.id\s+for update;/);
    assert.match(b, /jsonb_build_object\('current_video_id', v_video\.id, 'started', false\)/,
      'a missing row names the CURRENT video, so a student mid-way through a replaced one is told');
    assert.match(b, /'current_video_id', v_video\.id, 'started', true,\s*'seconds_remaining'/);
    assert.ok(b.indexOf("'ONBOARDING_VIDEO_NOT_ELIGIBLE'") < b.indexOf("'recorded', false"),
      'eligibility first, then the staff answer');
    assert.match(b, /return jsonb_build_object\('ok', true, 'recorded', false\);/, 'staff are never learners (#52)');
  });

  test(`${name}: start keeps the first open, records nothing for staff, and returns the path last`, () => {
    const b = bodyOf(sql, 'start_onboarding_video');
    assert.ok(b, 'start_onboarding_video() is not defined');
    const upsert = b.slice(b.indexOf('insert into public.student_onboarding_progress'));
    const set = upsert.slice(upsert.indexOf('on conflict (user_id, video_id) do update'), upsert.indexOf(';'));
    assert.ok(set.length > 0, 'the start is an upsert');
    assert.doesNotMatch(set, /first_started_at/, 'the elapsed guard counts from the FIRST open: never moved');
    assert.match(set, /last_started_at = now\(\)/);
    assert.match(b, /not coalesce\(\(v_state->>'staff'\)::boolean, false\)/, 'staff are never recorded');
    assert.ok(b.indexOf("'ONBOARDING_VIDEO_NOT_ELIGIBLE'") < b.indexOf("'storage_path'"),
      'the path is disclosed only after the eligibility check');
    assert.match(b, new RegExp(`o\\.bucket_id = '${esc(GS.ONBOARDING_VIDEO_BUCKET)}'`), 'a missing object is UNAVAILABLE');
  });

  // ★ WHO LEARNS AN OBJECT NAME (DBSEC-5). start_onboarding_video() is the only STUDENT RPC that
  //   names an object — but not the only function that does: a Super Admin sees every version's
  //   path in the overview, in the events trail and through the table's own SELECT policy. Its
  //   comment once said it was "the only function that discloses its object name, to an eligible
  //   viewer or a manager", which is false for a manager; this comment is folded verbatim into
  //   §56, and a future restatement is read against it.
  test(`${name}: only start names an object to a student, and its comment does not claim it is the only disclosure`, () => {
    for (const fn of STUDENT_RPCS.filter((f) => f !== 'start_onboarding_video')) {
      assert.doesNotMatch(bodyOf(sql, fn) || '', /storage_path/, `${fn} never names an object`);
    }
    const create = sql.indexOf('create or replace function public.start_onboarding_video(');
    assert.ok(create > 0, 'start_onboarding_video() is not defined');
    const comment = sql.slice(sql.lastIndexOf('\n\n', create), create).replace(/\n--\s*/g, ' ');
    assert.doesNotMatch(comment, /only function that discloses its object name/,
      'a manager learns every path from the overview and the trail, not only from start');
    assert.match(comment, /admin_onboarding_video_overview\(\)/,
      'the comment names the other place a Super Admin sees paths');
  });

  test(`${name}: report is UPDATE-only, once a minute, coerced to ONBOARDING_PROBLEM_CODES`, () => {
    const b = bodyOf(sql, 'report_onboarding_video_problem');
    assert.ok(b, 'report_onboarding_video_problem() is not defined');
    assert.doesNotMatch(b, /insert into/, 'a report never creates a row');
    // ★ The whole statement: without `user_id = v_uid` one student's report rewrites every
    //   student's last problem on the live version, silently.
    assert.match(b, /update public\.student_onboarding_progress\s+set last_problem_at = now\(\),\s+last_problem_code = v_code,\s+updated_at = now\(\)\s+where user_id = v_uid\s+and video_id = \(v_state->>'video_id'\)::uuid\s+and \(last_problem_at is null or last_problem_at <= now\(\) - interval '1 minute'\);/,
      "the caller's own row, for the live version, at most once a minute");
    assert.equal((b.match(/\bupdate public\.student_onboarding_progress\b/g) || []).length, 1, 'one write');
    const m = /if v_code not in \(([^)]*)\) then\s+v_code := '([a-z]+)';/.exec(b);
    assert.ok(m, 'the code is coerced to the enum');
    assert.deepEqual(sqlStrings(m[1]), [...GS.ONBOARDING_PROBLEM_CODES], 'exactly ONBOARDING_PROBLEM_CODES, in order');
    assert.equal(m[2], 'other', 'anything else is stored as other');
    assert.ok(GS.ONBOARDING_PROBLEM_CODES.includes('other'));
    assert.match(b, /return jsonb_build_object\('ok', false\);/, 'silent for an ineligible or staff caller');
  });

  test(`${name}: the problem-code CHECK is exactly ONBOARDING_PROBLEM_CODES`, () => {
    const m = /last_problem_code is null\s+or last_problem_code in \(([^)]*)\)/.exec(exe);
    assert.ok(m, 'last_problem_code needs its CHECK');
    assert.deepEqual(sqlStrings(m[1]), [...GS.ONBOARDING_PROBLEM_CODES]);
  });

  // ── The Super Admin's RPCs ──────────────────────────────────────────────────

  test(`${name}: publish locks in id order, needs p_replace_live, and retires before it publishes`, () => {
    const b = bodyOf(sql, 'admin_onboarding_video_publish');
    assert.ok(b, 'admin_onboarding_video_publish() is not defined');
    assert.match(stripComments(fnDef(sql, 'admin_onboarding_video_publish').header), /p_replace_live boolean default false/);
    assert.match(b, /where v\.id = p_video_id or v\.status = 'published'\s+order by v\.id\s+for update;/);
    const confirm = b.indexOf("'ONBOARDING_VIDEO_REPLACE_CONFIRM'");
    const retire = b.indexOf("set status = 'retired'");
    const publish = b.indexOf("set status = 'published'");
    assert.ok(confirm > 0 && retire > confirm && publish > retire,
      'refuse without confirmation, then retire the old row, THEN publish — the one-live index sees one at a time');
    assert.match(b, /if not coalesce\(p_replace_live, false\) then/);
    assert.match(b, /jsonb_build_object\('live_id', v_live\.id, 'live_title', v_live\.title\)/);
    assert.match(b, /published_at = coalesce\(published_at, now\(\)\)/, 'published_at is the FIRST publish, set once');
  });

  // ★ A REPLACE RETIRES THE VERSION ITS DIALOG NAMED, OR NOTHING (DBSEC-1). The Replace dialog says
  //   "“L1” will be retired"; a publish that retired whatever was live at commit retired a version
  //   somebody else had just published from a second window, which the dialog never named, with no
  //   refusal and no warning. p_expected_live_id carries the named version back, and anything else
  //   live now — or nothing, because someone unpublished it — is refused with the facts as they are
  //   NOW (the existing REPLACE_CONFIRM, whose context the client already re-opens the dialog from).
  //   NULL keeps the original contract, so a caller that names no version behaves exactly as before.
  test(`${name}: a replace is refused unless the live version is the one the dialog named (DBSEC-1)`, () => {
    assert.deepEqual(paramSpecs(sql, 'admin_onboarding_video_publish'), [
      { name: 'p_video_id', type: 'uuid', optional: false },
      { name: 'p_replace_live', type: 'boolean', optional: true },
      { name: 'p_expected_live_id', type: 'uuid', optional: true },
    ], 'publish(p_video_id, p_replace_live default false, p_expected_live_id default null)');
    assert.match(stripComments(fnDef(sql, 'admin_onboarding_video_publish').header), /p_expected_live_id uuid default null/,
      'NULL is the default: a caller that names no version keeps the original contract');
    const b = norm(bodyOf(sql, 'admin_onboarding_video_publish'));
    const lockLive = "select * into v_live from public.onboarding_videos v where v.status = 'published' and v.id <> p_video_id for update;";
    const guard = 'if coalesce(p_replace_live, false) and p_expected_live_id is not null '
      + "and v_live.id is distinct from p_expected_live_id then perform public.app_error('ONBOARDING_VIDEO_REPLACE_CONFIRM', ";
    const at = b.indexOf(guard);
    assert.ok(at > 0, `the replace must be refused when the live version is not the one named: ${guard}`);
    assert.equal(b.split(guard).length - 1, 1, 'one such refusal');
    // `is distinct from`, not `<>`: with NOTHING live, v_live.id is null and `<>` would let the replace through.
    assert.ok(b.indexOf(lockLive) >= 0 && b.indexOf(lockLive) < at, 'it compares against the live row read — and locked — just before');
    assert.ok(at < b.indexOf('if v_live.id is not null then'),
      'it runs BEFORE the live-row branch, or "nothing is live any more" would slip through as a plain publish');
    assert.ok(at < b.indexOf("set status = 'retired'"), 'and before anything is retired');
    const refusal = b.slice(at, b.indexOf('end if;', at));
    assert.match(refusal, /, 409, jsonb_build_object\('live_id', v_live\.id, 'live_title', v_live\.title, 'expected_live_id', p_expected_live_id\)\); $/,
      'the context names the version live NOW, so the dialog can ask again about it');
  });

  // ★ ONE SIGNATURE (DBSEC-1). CREATE OR REPLACE with a third parameter does not replace
  //   publish(uuid, boolean): it adds an OVERLOAD beside it, and then PostgREST refuses every call as
  //   ambiguous (PGRST203) and a two-argument SQL call is "not unique". The old one is dropped first
  //   — never CASCADE, so a dependency would stop the file instead of being stripped silently.
  test(`${name}: the two-argument publish is dropped before the three-argument one is created`, () => {
    const drop = 'drop function if exists public.admin_onboarding_video_publish(uuid, boolean);';
    const at = exe.indexOf(drop);
    assert.ok(at >= 0, `an existing database keeps publish(uuid, boolean) as an overload unless the file says: ${drop}`);
    assert.equal(exe.split(drop).length - 1, 1);
    assert.ok(at < exe.indexOf('create or replace function public.admin_onboarding_video_publish('),
      'dropped BEFORE the new signature is created');
    assert.doesNotMatch(exe, /\bdrop\s+function\b[^;]*\bcascade\b/i, 'never CASCADE');
    assert.equal((exe.match(/\bdrop\s+function\b/gi) || []).length, 1, 'publish is the one function #69 re-signs');
  });

  test(`${name}: every grant and revoke names the signature its function is created with`, () => {
    const sigs = new Map(created.filter((fn) => fn !== 'app_error_catalog')
      .map((fn) => [fn, params(sql, fn).map((x) => x[1]).join(',')]));
    let seen = 0;
    for (const m of exe.matchAll(/\b(grant|revoke)\b[^;]*?\bon\s+function\s+public\.([a-z0-9_]+)\(([^)]*)\)/gi)) {
      if (!sigs.has(m[2])) continue;
      seen += 1;
      const args = m[3].split(',').map((a) => a.trim()).filter(Boolean).join(',');
      assert.equal(args, sigs.get(m[2]),
        `${m[1]} on ${m[2]}(${m[3]}): the function is (${sigs.get(m[2])}), so this names a function that does not exist`);
    }
    assert.ok(seen >= 2 * (Object.keys(CLIENT_RPCS).length + Object.keys(POLICY_HELPERS).length), 'the scan read section 10');
  });

  test(`${name}: attach_media binds a file in the draft's own folder that really exists`, () => {
    const b = bodyOf(sql, 'admin_onboarding_video_attach_media');
    assert.ok(b, 'admin_onboarding_video_attach_media() is not defined');
    assert.match(b, /v_row\.status <> 'draft'/, 'only a draft takes a file');
    assert.match(b, /public\.onboarding_video_path_version_id\(p_storage_path\) is distinct from p_video_id/);
    assert.match(b, /from storage\.objects o\s+where o\.bucket_id = '[^']+' and o\.name = p_storage_path;/);
    assert.match(b, /v_meta->>'size'/, 'the size is checked against the object when storage recorded one');
    assert.match(b, /'previous_storage_path'/, 'the caller sweeps the file it replaced');
  });

  // ★ A CALL THAT CHANGES NOTHING WRITES NOTHING — attach_media too (DBSEC-4). Re-attaching the file
  //   a draft already cites, with the same facts (a Save retried after its answer was lost), used to
  //   move media_attached_at and append an 'attach_media' event, against section 7's own rule and
  //   the #56 ledger rule. The no-op answer compares every column the write would set, and comes
  //   AFTER every check, so a file that has since vanished from storage is refused, not "unchanged".
  test(`${name}: attach_media re-attaching the same file with the same facts writes nothing (DBSEC-4)`, () => {
    const b = norm(bodyOf(sql, 'admin_onboarding_video_attach_media'));
    const noop = 'if (v_row.storage_path, v_row.original_filename, v_row.mime_type, v_row.byte_size, v_row.duration_seconds) '
      + 'is not distinct from (p_storage_path, v_name, v_mime, v_size, v_duration) then '
      + "return jsonb_build_object('ok', true, 'video_id', p_video_id, 'storage_path', p_storage_path, "
      + "'previous_storage_path', null, 'changed', false); end if;";
    const at = b.indexOf(noop);
    assert.ok(at > 0, `the same file with the same facts must answer "unchanged": ${noop}`);
    const write = "update public.onboarding_videos set storage_path = p_storage_path, original_filename = v_name, mime_type = v_mime, "
      + 'byte_size = v_size, duration_seconds = v_duration, media_attached_at = now() where id = p_video_id;';
    assert.ok(b.includes(write), 'the write sets exactly the five columns the no-op compares, and the stamp');
    assert.ok(at < b.indexOf(write) && at < b.indexOf('insert into public.onboarding_video_events'),
      'the no-op returns before the write and before the event');
    assert.ok(at > b.lastIndexOf("perform public.app_error('ONBOARDING_VIDEO_MEDIA_INVALID'"),
      'after every check: a vanished file is still refused');
    assert.match(b, /'previous_storage_path', case when v_row\.storage_path is distinct from p_storage_path then v_row\.storage_path end, 'changed', true\); end;?$/,
      'a real attach says it changed something');
  });

  test(`${name}: delete refuses a published version and returns the path to sweep`, () => {
    const b = bodyOf(sql, 'admin_onboarding_video_delete');
    assert.ok(b, 'admin_onboarding_video_delete() is not defined');
    assert.match(b, /if v_row\.status = 'published' then\s+perform public\.app_error\('ONBOARDING_VIDEO_STATE_INVALID'/);
    assert.match(b, /set status = 'deleted'/);
    assert.match(b, /'storage_path', v_row\.storage_path/);
  });

  test(`${name}: every writer records one event, and a no-op records none`, () => {
    for (const fn of ADMIN_RPCS.filter((f) => f !== 'admin_onboarding_video_overview')) {
      const b = bodyOf(sql, fn);
      assert.equal((b.match(/insert into public\.onboarding_video_events/g) || []).length, 1,
        `${fn} writes exactly one audit row`);
    }
    assert.doesNotMatch(bodyOf(sql, 'admin_onboarding_video_overview'), /insert into|update public\.|delete from/,
      'the overview only reads');
  });

  // Every writer that CAN be a no-op says which it was, and says it before it writes. create_draft
  // cannot be one: every call makes a new version.
  test(`${name}: every writer but create_draft answers changed:false before any write, changed:true after`, () => {
    for (const fn of ADMIN_RPCS.filter((f) => !['admin_onboarding_video_overview', 'admin_onboarding_video_create_draft'].includes(f))) {
      const b = norm(bodyOf(sql, fn) || '');
      const noop = b.indexOf("'changed', false");
      assert.ok(noop > 0, `${fn}: a call that changes nothing says so`);
      assert.ok(b.indexOf("'changed', true") > noop, `${fn}: a call that changes something says that`);
      for (const w of ['update public.onboarding_videos', 'insert into public.onboarding_video_events']) {
        const wi = b.indexOf(w);
        assert.ok(wi > noop, `${fn}: the no-op answer returns before ${w}`);
      }
    }
  });

  test(`${name}: the overview returns facts only, counted set-based`, () => {
    const b = bodyOf(sql, 'admin_onboarding_video_overview');
    assert.ok(b, 'admin_onboarding_video_overview() is not defined');
    for (const key of ['live_video_id', 'required_since', 'counts', 'versions', 'storage_path', 'media_present',
      'completions', 'problems_7d', 'active_members', 'pending_students', 'completed_students',
      'created_by_name', 'published_by_name']) {
      assert.ok(b.includes(`'${key}'`), `the overview reports ${key}`);
    }
    assert.doesNotMatch(b, /user_onboarding_video_state\(|user_is_enrolled\(|user_is_approved\(/,
      'no per-row function call: the counts are one set-based statement');
    assert.match(b, /m\.status in \('invited', 'active'\)/, 'staff are never counted as learners');
  });

  // ── The decision email ──────────────────────────────────────────────────────

  test(`${name}: enrollment_decision_email_facts states plan, term, cohort and Getting Started`, () => {
    const b = bodyOf(sql, 'enrollment_decision_email_facts');
    assert.ok(b, 'enrollment_decision_email_facts() is not defined');
    assert.match(b, /perform public\.app_error\('REQUEST_NOT_FOUND'/);
    for (const key of ['request', 'plan', 'term', 'batch', 'getting_started_required', 'status', 'kind',
      'extension_days', 'key', 'name', 'tagline', 'entitlement_summary', 'community_segment', 'access_days',
      'started_at', 'ends_at', 'grace_ends_at', 'code', 'starts_on']) {
      assert.ok(b.includes(`'${key}'`), `the facts include ${key}`);
    }
    assert.match(b, /s\.request_id = v_req\.id/, 'the term is the subscription carrying the request');
    assert.match(b, /v_req\.request_kind = 'extension'/, 'an extension reads the live term it extended');
    // ★ A DECISION STATES WHAT IT GRANTED. approve_extension() returns a term with no end date
    //   unchanged (no row carries the request), so only an APPROVED extension falls back to the
    //   live term; a rejected or pending one granted nothing and has no term to state.
    assert.match(b, /if v_sub\.id is null and v_req\.request_kind = 'extension' and v_req\.status = 'approved' then/,
      'the live-term fallback is for an APPROVED extension only');
    // …and the plan is the granted term's: an extension is granted on the member's CURRENT plan
    //   (approve_extension copies it from their latest term), not the one named on the request.
    assert.match(b, /select \* into v_plan from public\.enrollment_plans p where p\.key = coalesce\(v_sub\.plan_key, v_req\.plan_key\);/,
      "the plan comes from the term the decision granted; the request's plan only when nothing was granted");
    assert.equal((b.match(/\binto v_plan\b/g) || []).length, 1, 'one plan lookup');
    assert.ok(b.indexOf('into v_plan') > b.lastIndexOf('into v_sub'), 'the plan is read after the term it comes from');
    assert.match(b, /community_segment = 'vip'/, 'a cohort is a VIP-only fact (#68)');
    assert.doesNotMatch(b, /(plan_key|\.key)\s*=\s*'vip'/, 'VIP-ness comes from the segment, never the key');
    assert.match(b, /coalesce\(\(v_gs->>'required'\)::boolean, false\)/);
  });

  test(`${name}: no access-request facts function (ruling EML-5)`, () => {
    assert.doesNotMatch(exe, /admin_access_request_email_facts/,
      'notify-access reads the profile with the reviewer\'s own JWT instead');
  });

  // ── Error codes ─────────────────────────────────────────────────────────────

  test(`${name}: every ONBOARDING_VIDEO_* raise uses the catalog's HTTP status`, () => {
    const calls = callsOf(exe, 'app_error').filter((a) => /^'ONBOARDING_VIDEO_/.test(a[0]));
    assert.ok(calls.length >= 12, `expected the #69 refusals, found ${calls.length}`);
    for (const [codeArg, , http] of calls) {
      const c = codeArg.slice(1, -1);
      assert.ok(c in ONBOARDING_HTTP, `${c} is not an #69 code`);
      assert.equal(Number(http), ONBOARDING_HTTP[c], `${c} is raised with ${http}, the catalog says ${ONBOARDING_HTTP[c]}`);
    }
    const raised = new Set(calls.map((a) => a[0].slice(1, -1)));
    for (const c of ONBOARDING_CODES) assert.ok(raised.has(c), `${c} is in the catalog but nothing raises it`);
  });
}

test('every #69 code has client copy, and the catalog and APP_ERROR_CODES list the same codes', () => {
  assert.deepEqual(ONBOARDING_CODES, Object.keys(ONBOARDING_HTTP), 'the eight codes, in order');
  for (const c of ONBOARDING_CODES) {
    assert.ok(APP_ERROR_COPY[c] && APP_ERROR_COPY[c].length > 30, `${c} needs copy that names the next action`);
  }
  const d = fnDef(dated, 'app_error_catalog');
  assert.ok(d, 'the dated file restates app_error_catalog()');
  const sqlCodes = new Set([...d.body.matchAll(/\('([A-Z_]+)',/g)].map((m) => m[1]));
  const jsCodes = new Set(APP_ERROR_CODES.filter((c) => c !== 'MIGRATION_MISSING'));
  assert.deepEqual([...jsCodes].filter((c) => !sqlCodes.has(c)), [], 'a client code the catalog lacks');
  assert.deepEqual([...sqlCodes].filter((c) => !jsCodes.has(c)), [], 'a catalog code the client lacks');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

/** Every .js/.jsx/.mjs file under a repo directory. */
function sourceFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      const next = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(next); } else if (/\.(m?js|jsx)$/.test(e.name)) out.push(next);
    }
  };
  walk(dir);
  return out;
}

const SOURCES = [...sourceFiles('src'), ...sourceFiles('api')];
/**
 * A call whose function name is a quoted string: `.rpc('name'`, with or without space before the
 * parenthesis, and `.rpc?.('name'`. ★ `.rpc (` was invisible to the scan once, and a call it cannot
 * see is a call whose arguments nobody checks (TDR-3).
 */
const RPC_CALL_RE = /\.rpc\s*(?:\?\.\s*)?\(\s*(['"`])([a-z0-9_]+)\1/g;
/** A PostgREST URL that names its function: `/rest/v1/rpc/name` — in src/ as well as api/. */
const REST_RPC_RE = /\/rest\/v1\/rpc\/([a-z0-9_]+)/g;

/** name → the files that call it: `.rpc('name'` and `/rest/v1/rpc/name`, in src/ and api/. */
const RPC_CALLS = (() => {
  const found = new Map();
  const add = (name, file) => found.set(name, [...(found.get(name) || []), file]);
  for (const file of SOURCES) {
    const text = read(file);
    for (const m of text.matchAll(RPC_CALL_RE)) add(m[2], file);
    for (const m of text.matchAll(REST_RPC_RE)) add(m[1], file);
  }
  return found;
})();

test('the wiring scan sees the call shapes the app really uses', () => {
  // A scan that finds nothing passes everything; prove it finds calls it must find.
  assert.ok(RPC_CALLS.size > 20, `found only ${RPC_CALLS.size} RPC names`);
  assert.ok((RPC_CALLS.get('legacy_import_onboarding_notice') || []).some((f) => f.startsWith('api/')), 'svc.rpc( in api/');
  assert.ok((RPC_CALLS.get('record_enrollment_notification') || []).some((f) => f.startsWith('api/')), '/rest/v1/rpc/ in api/');
  assert.ok([...RPC_CALLS.values()].flat().some((f) => f.startsWith('src/')), ".rpc(' in src/");
});

// ★ Every #69 function name contains `onboarding_video`, and the facts function is named in
//   full. A bare /onboarding/ would also catch #26/#67's complete_import_onboarding and
//   legacy_import_onboarding_notice, which are not this migration's. A test over an empty list
//   passes, so three others keep this one from being vacuous: the scan-sanity test above, the
//   decision-facts test below, and the census further down (every client RPC has a call the
//   scan reads).
const OURS = /onboarding_video|^enrollment_decision_email_facts$/;

test('every #69 RPC the app calls is a client RPC, defined and granted in both files', () => {
  const ours = [...RPC_CALLS.keys()].filter((n) => OURS.test(n));
  for (const n of ours) {
    assert.ok(n in CLIENT_RPCS, `${n} is called by ${RPC_CALLS.get(n).join(', ')} but is not a client RPC`);
    for (const [name, sql] of FILES) {
      const exe = stripComments(sql);
      assert.ok(exe.includes(`create or replace function public.${n}(`), `${name}: ${n} is called but not defined`);
      assert.match(exe, grantAuthenticated(n, CLIENT_RPCS[n]), `${name}: ${n} is called but not granted`);
    }
  }
});

// ★ The decision email states what the DATABASE recorded (plan, term, cohort, Getting Started),
//   never what the page sent. Removing this call would send the generic copy for ever, and the
//   wiring scan above cannot see a call that is no longer there — so its presence is pinned.
test('api/ reads the decision facts from enrollment_decision_email_facts', () => {
  const inApi = (RPC_CALLS.get('enrollment_decision_email_facts') || []).some((f) => f.startsWith('api/'));
  assert.ok(inApi, 'the decision email must state server-read facts');
});

// ── The argument NAMES each call sends (TDR-3) ──────────────────────────────
// ★ PostgREST finds a function by the NAMES of the arguments a call sends: a key the function does
//   not declare, or a declared parameter without a default left out, matches no function, and
//   the call fails with PGRST202 at the first click. The scan above proves each name is defined
//   and granted with the right TYPES; this reads every #69 call in src/ and api/ — an object
//   literal, the object a local helper returns (onboardingAttachArgs), or a fetch body — and holds
//   its keys to the SQL parameter list, in both files. A call it finds but cannot read FAILS: a
//   scan that skips what it does not understand passes everything. A call it cannot FIND is the
//   job of the two nets after the argument test (TDR-3).

/** The index just past a JS string, template literal or comment that starts at `i`; `i` if none starts there. */
function skipJs(text, i) {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); return nl < 0 ? text.length : nl; }
  if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2; }
  if (c === "'" || c === '"') {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === '\\') { j += 1; continue; }
      if (text[j] === c || text[j] === '\n') return j + 1;
    }
    return text.length;
  }
  if (c === '`') {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === '\\') { j += 1; continue; }
      if (text[j] === '`') return j + 1;
      if (text[j] === '$' && text[j + 1] === '{') {
        const e = closeOf(text, j + 1);
        if (e < 0) return text.length;
        j = e;
      }
    }
    return text.length;
  }
  return i;
}

/** The index of the bracket closing the one at `open` (strings, templates and comments skipped); -1 if none. */
function closeOf(text, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[text[open]]];
  for (let i = open + 1; i < text.length; i += 1) {
    const j = skipJs(text, i);
    if (j !== i) { i = j - 1; continue; }
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * The top-level keys of the object literal whose `{` is at `open`: { keys } or { error }. A
 * spread, a computed key or a method cannot be named, so it is an error — never "no keys".
 */
function objectKeys(text, open) {
  const close = closeOf(text, open);
  if (close < 0) return { error: 'an object literal that never closes' };
  const entries = [];
  let cur = '';
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    const j = skipJs(text, i);
    if (j !== i) {
      if (text[i] !== '/') cur += text.slice(i, j);   // keep strings (a quoted key), drop comments
      i = j - 1;
      continue;
    }
    const c = text[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) { entries.push(cur); cur = ''; continue; }
    cur += c;
  }
  entries.push(cur);
  const keys = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(e) || /^(?:'([^'\\]*)'|"([^"\\]*)")\s*:/.exec(e);
    if (!m) return { error: `an entry the scan cannot name: ${JSON.stringify(e.slice(0, 48))}` };
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return { keys };
}

/**
 * The keys of the object literal `function name(…) { … }` returns. ★ Conservative on purpose: the
 * body must hold exactly ONE `return` (nested functions included) and it must return an object
 * literal — a helper with branches is a helper this scan cannot vouch for, so it is an error.
 */
function helperKeys(text, name) {
  const at = text.search(new RegExp(`\\bfunction ${esc(name)}\\s*\\(`));
  if (at < 0) return { error: `${name}() is not a function declared in this file` };
  const paramsClose = closeOf(text, text.indexOf('(', at));
  const bodyOpen = paramsClose < 0 ? -1 : text.indexOf('{', paramsClose);
  const bodyClose = bodyOpen < 0 ? -1 : closeOf(text, bodyOpen);
  if (bodyClose < 0) return { error: `${name}()'s body cannot be read` };
  const found = [];
  for (let i = bodyOpen + 1; i < bodyClose; i += 1) {
    const j = skipJs(text, i);
    if (j !== i) { i = j - 1; continue; }
    if (text.startsWith('return', i) && !/[\w$]/.test(text[i - 1]) && !/[\w$]/.test(text[i + 6])) {
      let k = i + 6;
      while (/\s/.test(text[k])) k += 1;
      found.push(text[k] === '{' ? objectKeys(text, k) : { error: `${name}() returns something other than an object literal` });
    }
  }
  if (found.length !== 1) return { error: `${name}() must hold exactly ONE return, of an object literal; it holds ${found.length}` };
  return found[0];
}

/**
 * Is index `i` of `text` inside a comment? Only a line that STARTS as one counts — `//`, `/*`, or a
 * JSDoc ` * ` — and not once a block comment has closed before `i` on that line. A trailing comment
 * after code is read as code, on purpose: a wrong "comment" would skip a call silently, while a
 * wrong "code" fails loudly.
 */
function commented(text, i) {
  const pre = text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trimStart();
  if (pre.startsWith('//')) return true;
  if (pre.startsWith('/*')) return !pre.slice(2).includes('*/');
  if (pre.startsWith('*') && !pre.startsWith('*/')) return !pre.slice(1).includes('*/');
  return false;
}

/**
 * Every #69 RPC call in one file's text: { file, line, at, name, via, keys } or { …, error } — `at`
 * is where its function name is written. Reads `.rpc('name', …)` in every spelling RPC_CALL_RE
 * knows, and `fetch(…/rest/v1/rpc/name…, { body: JSON.stringify({ … }) })`, in src/ and api/ alike.
 */
function rpcCallsOf(file, text) {
  const out = [];
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(RPC_CALL_RE)) {
    if (!OURS.test(m[2]) || commented(text, m.index)) continue;
    const call = { file, line: lineOf(m.index), at: m.index + m[0].length - 1 - m[2].length, name: m[2] };
    let k = m.index + m[0].length;
    while (/\s/.test(text[k])) k += 1;
    if (text[k] === ')') { out.push({ ...call, via: 'none', keys: [] }); continue; }
    if (text[k] !== ',') { out.push({ ...call, error: 'neither ")" nor "," follows the function name' }); continue; }
    k += 1;
    while (/\s/.test(text[k])) k += 1;
    if (text[k] === '{') { out.push({ ...call, via: 'literal', ...objectKeys(text, k) }); continue; }
    const helper = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(k));
    if (helper) { out.push({ ...call, via: 'helper', helper: helper[1], ...helperKeys(text, helper[1]) }); continue; }
    out.push({ ...call, error: `arguments the scan cannot read: ${JSON.stringify(text.slice(k, k + 40))}` });
  }
  for (const m of text.matchAll(REST_RPC_RE)) {
    if (!OURS.test(m[1]) || commented(text, m.index)) continue;
    const call = { file, line: lineOf(m.index), at: m.index + '/rest/v1/rpc/'.length, name: m[1], via: 'fetch' };
    const f = text.lastIndexOf('fetch(', m.index);
    const fClose = f < 0 ? -1 : closeOf(text, f + 'fetch'.length);
    if (fClose < m.index) { out.push({ ...call, error: 'not inside a fetch(…) call the scan can read' }); continue; }
    const body = /\bbody\s*:\s*JSON\.stringify\(\s*\{/.exec(text.slice(f, fClose));
    if (!body) { out.push({ ...call, error: 'no `body: JSON.stringify({ … })` in its fetch options' }); continue; }
    out.push({ ...call, ...objectKeys(text, f + body.index + body[0].length - 1) });
  }
  return out;
}

/**
 * Every #69 name written as a WHOLE quoted string — 'name', "name", `name`, or the head of a template,
 * `name${…}` — outside a comment line: { file, line, at, name }. A message that only mentions a name
 * ('[gs] start_onboarding_video failed'), an error code and the bucket are not names.
 */
function quotedNamesOf(file, text) {
  const out = [];
  for (const m of text.matchAll(/(['"`])([a-z0-9_]+)(?=\1|\$\{)/g)) {
    if (!OURS.test(m[2]) || commented(text, m.index)) continue;
    out.push({ file, line: text.slice(0, m.index).split('\n').length, at: m.index + 1, name: m[2] });
  }
  return out;
}

const SCANS = SOURCES.map((file) => {
  const text = read(file);
  return { calls: rpcCallsOf(file, text), quoted: quotedNamesOf(file, text) };
});
/** Every #69 RPC call in src/ and api/. */
const RPC_ARGS = SCANS.flatMap((s) => s.calls);
/** Every #69 name written as a quoted string in src/ and api/. */
const QUOTED = SCANS.flatMap((s) => s.quoted);

test('the argument scan reads literals, helper returns and fetch bodies — and refuses what it cannot read', () => {
  const src = [
    "a.rpc('x_onboarding_video_a', { p_one: 1, 'p_two': f({ nested: 1 }, [1, 2], '}'), // p_ghost: 1\n p_three })",
    'function argsFor(v) { const g = (y) => (y ? `{${y}}` : null); return { p_four: g(v), p_five: `${v}` }; }',
    'function branchy(v) { if (v) return { p_six: v }; return { p_seven: v }; }',
    "c.rpc('x_onboarding_video_c', { ...spread })",
  ].join('\n');
  const literal = objectKeys(src, src.indexOf('{'));
  assert.deepEqual(literal.keys, ['p_one', 'p_two', 'p_three'], 'quoted and shorthand keys; nested objects, strings and comments ignored');
  assert.deepEqual(helperKeys(src, 'argsFor').keys, ['p_four', 'p_five'], "the object the helper returns");
  assert.match(helperKeys(src, 'branchy').error || '', /exactly ONE return/, 'a helper with two returns is not vouched for');
  assert.match(objectKeys(src, src.indexOf('{ ...spread')).error || '', /cannot name/, 'a spread is unreadable, never "no keys"');
  assert.match(helperKeys(src, 'missingHelper').error || '', /not a function/);
  // And the real scan found the shapes the app uses.
  const calls = RPC_ARGS.filter((c) => OURS.test(c.name));
  assert.ok(calls.length >= 12, `found only ${calls.length} #69 calls`);
  assert.ok(calls.some((c) => c.via === 'helper' && c.name === 'admin_onboarding_video_attach_media'), 'the attach call is read through onboardingAttachArgs()');
  assert.ok(calls.some((c) => c.via === 'fetch' && c.file.startsWith('api/')), 'the api/ fetch body is read');
  assert.ok(calls.some((c) => c.via === 'none'), 'a call with no arguments is read as sending none');
  assert.ok(new Set(calls.map((c) => c.name)).size >= 10, 'calls of most #69 functions are read');
});

test('every #69 RPC call sends only argument names the function declares, and every one it requires (TDR-3)', () => {
  for (const c of RPC_ARGS.filter((x) => OURS.test(x.name))) {
    const where = `${c.file}:${c.line} ${c.name}`;
    assert.ok(!c.error, `${where}: ${c.error}`);
    assert.equal(new Set(c.keys).size, c.keys.length, `${where} sends a key twice`);
    for (const [label, sql] of FILES) {
      const spec = paramSpecs(sql, c.name);
      assert.ok(spec, `${label}: ${c.name} is called by ${where} but not defined`);
      const declared = spec.map((p) => p.name);
      const unknown = c.keys.filter((k) => !declared.includes(k));
      assert.deepEqual(unknown, [],
        `${where} sends ${unknown.join(', ')}, but ${label} declares ${c.name}(${declared.join(', ')}): PostgREST finds no such function (PGRST202)`);
      const missing = spec.filter((p) => !p.optional && !c.keys.includes(p.name)).map((p) => p.name);
      assert.deepEqual(missing, [],
        `${where} leaves out ${missing.join(', ')}, which ${label}'s ${c.name} requires (no default): PGRST202`);
    }
  }
});

// ★ A CALL THE SCAN CANNOT FOLLOW IS A CALL WHOSE ARGUMENTS NOBODY CHECKS. The argument test
//   above reads the calls it can find, and it found `.rpc('name', …)` only: `.rpc ('name', …)`, a
//   name in a constant, and a name handed to a generic helper (src/BookkeeperPro.jsx already
//   routes other features' calls through `.rpc(fn, …)`) all sent unchecked argument names and
//   passed. So the scan reads every spelling of a quoted-name call, and two nets catch what it
//   still cannot read: a #69 name in a quoted string that is not the name of a call it read, and
//   a client RPC with no call it read at all. ★ A SOURCE SCAN, NOT A PROOF: a name built from
//   pieces, or never written in quotes, is not seen.
test('the call scan reads `.rpc (`, `.rpc?.(`, a split call, a call after a closed comment and a fetch in src/ — and skips a doc line (TDR-3)', () => {
  const src = [
    "a.rpc ('x_onboarding_video_a', { p_one: 1 })",
    "b.rpc?.('x_onboarding_video_b')",
    "c.rpc(\n  'x_onboarding_video_c',\n  { p_two: 2 },\n)",
    "/* a note */ d.rpc('x_onboarding_video_d', { p_three: 3 })",
    " * e.rpc('x_onboarding_video_e', { p_doc: 1 })",
    "// f.rpc('x_onboarding_video_f', { p_doc: 1 })",
    "g = fetch(`${u}/rest/v1/rpc/x_onboarding_video_g`, { method: 'POST', body: JSON.stringify({ p_four: 4 }) })",
  ].join('\n');
  const calls = rpcCallsOf('src/x.jsx', src);
  assert.deepEqual(calls.map((c) => [c.name, c.via, c.keys]), [
    ['x_onboarding_video_a', 'literal', ['p_one']],
    ['x_onboarding_video_b', 'none', []],
    ['x_onboarding_video_c', 'literal', ['p_two']],
    ['x_onboarding_video_d', 'literal', ['p_three']],
    ['x_onboarding_video_g', 'fetch', ['p_four']],
  ], 'every spelling is read; only a line that starts as a comment is documentation');
  for (const c of calls) {
    assert.equal(src.slice(c.at, c.at + c.name.length), c.name, `${c.name}: the scan records where its name is written`);
  }
});

test('a quoted #69 name the scan did not read as a call is caught — a constant, a map, a template, a helper, an index (TDR-3)', () => {
  const src = [
    "const DEL = 'x_onboarding_video_del'; a.rpc(DEL, { p_vid: 1 })",
    'const fns = { pub: "x_onboarding_video_pub" }',
    'b.rpc(`x_onboarding_video_${kind}`, { p_one: 1 })',
    "call('x_onboarding_video_call', { p_one: 1 })",
    "c['rpc']('x_onboarding_video_idx', { p_one: 1 })",
    "d.rpc('x_onboarding_video_ok', { p_one: 1 })",
    " * e.g. d.rpc('x_onboarding_video_doc', { p_one: 1 }) or 'x_onboarding_video_doc2'",
    "console.error('[gs] start_onboarding_video failed', 'ONBOARDING_VIDEO_NOT_FOUND', 'onboarding-videos')",
  ].join('\n');
  const readAt = new Set(rpcCallsOf('src/x.jsx', src).map((c) => c.at));
  const quoted = quotedNamesOf('src/x.jsx', src);
  assert.deepEqual(quoted.filter((q) => !readAt.has(q.at)).map((q) => q.name), [
    'x_onboarding_video_del', 'x_onboarding_video_pub', 'x_onboarding_video_', 'x_onboarding_video_call',
    'x_onboarding_video_idx',
  ], 'every quoted #69 name that is not the name of a call the scan read');
  assert.deepEqual(quoted.filter((q) => readAt.has(q.at)).map((q) => q.name), ['x_onboarding_video_ok'],
    'the name of a call it read is accounted for; a doc line, a log message, a code and the bucket are not names');
});

test('every quoted #69 name in src/ and api/ is the name of a call the scan reads (TDR-3)', () => {
  const readAt = new Set(RPC_ARGS.map((c) => `${c.file}:${c.at}`));
  const unread = QUOTED.filter((q) => !readAt.has(`${q.file}:${q.at}`));
  assert.deepEqual(unread.map((q) => `${q.file}:${q.line} '${q.name}'`), [],
    "a #69 function name in a string the scan cannot follow into a call — its arguments go unchecked. Write the call as supabase.rpc('<name>', { … }) "
    + '(an object literal, or a one-return helper), or in api/ as a fetch to /rest/v1/rpc/<name> with body: JSON.stringify({ … }). '
    + "A string that is not a call at all (a log tag) is not the bare name: '[tag] <name> failed' is a message");
  assert.ok(QUOTED.length >= Object.keys(CLIENT_RPCS).length, `found only ${QUOTED.length} quoted #69 names: the scan is not reading the app`);
});

test('every #69 client RPC has a call the scan reads (TDR-3)', () => {
  const called = new Set(RPC_ARGS.map((c) => c.name));
  const unread = Object.keys(CLIENT_RPCS).filter((n) => !called.has(n));
  assert.deepEqual(unread, [],
    `granted to authenticated, but no call in src/ or api/ that the scan can read names ${unread.join(', ')} — `
    + 'a call whose name is not a quoted string is invisible to it, and so are its arguments');
});

// ★ The manual bucket list is what someone types into the Dashboard when the bootstrap could not
//   create a bucket. Both buckets at the lesson-video cap are given in BYTES: "2 GB" typed there
//   is 2,000,000,000, 147,483,648 bytes under LESSON_VIDEO_MAX_BYTES (scripts/storage-config.mjs).
test('db/README.md gives both lesson-cap buckets their exact byte limit, and never says "2 GB"', () => {
  const readme = read('db/README.md');
  const from = readme.indexOf('3. **Storage buckets:**');
  const to = readme.indexOf('The object policies are already applied.', from);
  assert.ok(from > 0 && to > from, 'the Fresh install step 3 bucket list is where the manual limits live');
  const list = readme.slice(from, to);
  assert.doesNotMatch(list, /\b2\s*GB\b/i, 'a limit written "2 GB" is 2,000,000,000 bytes once typed into the Dashboard');
  const entry = (bucket) => {
    const at = list.indexOf(`\`${bucket}\``);
    assert.ok(at >= 0, `the manual bucket list names ${bucket}`);
    return list.slice(at, list.indexOf(')', at) + 1).replace(/\s+/g, ' ');
  };
  for (const bucket of [LESSON_VIDEO_BUCKET, GS.ONBOARDING_VIDEO_BUCKET]) {
    const e = entry(bucket);
    assert.ok(e.includes('(**Public = OFF**'), `${bucket} is private`);
    assert.ok(e.includes(`\`${LESSON_VIDEO_MAX_BYTES}\` bytes`),
      `${bucket}: the limit is written as \`${LESSON_VIDEO_MAX_BYTES}\` bytes`);
    for (const mime of LESSON_VIDEO_UPLOAD_MIMES) assert.ok(e.includes(`\`${mime}\``), `${bucket}: it names ${mime}`);
  }
});

// ★ THE PRODUCTION TRIPWIRE MUST SEE WHAT THE SHADOW SUITE KILLS (Task 6 review, T6-L3). The
//   #69 prosrc probe in scripts/audit-db.mjs matched only a PREFIX of the `required`
//   expression, so dropping the first-publish cutoff (`and v_first >= v_since`) left it passing,
//   and it did not count complete_onboarding_video's second locked read of the live row
//   (SEM-1). Both regressions fail test-db/onboardingVideo.dbtest.mjs on shadow; after the
//   production apply, the audit is the only thing that looks.
test('scripts/audit-db.mjs: the #69 probe names the cutoff clause and counts both locked reads', () => {
  const LIVE_READ = "from public.onboarding_videos where status = 'published' for share;";
  for (const [label, sql] of FILES) {
    assert.ok(bodyOf(sql, 'user_onboarding_video_state')?.includes('and v_first >= v_since, false)'),
      `${label}: the required rule ends on the first-publish cutoff`);
    assert.equal((bodyOf(sql, 'complete_onboarding_video') || '').split(LIVE_READ).length - 1, 2,
      `${label}: complete_onboarding_video reads the live row twice, both locked`);
  }
  const audit = read('scripts/audit-db.mjs');
  assert.ok(audit.includes("and p.prosrc like '%and v_first >= v_since, false)%'"),
    'the audit probe names the cutoff clause itself, not a prefix of the expression');
  assert.ok(audit.includes("= 2 * length('from public.onboarding_videos where status = ''published'' for share;')"),
    'the audit probe counts both locked reads of the live row');
});

// ── The production audit holds the same text (TDR-2, DBSEC-1) ──────────────
// ★ After the production apply the audit is the only thing that looks, and a LIKE probe per TERM
//   passes `and` → `or`. So it compares WHOLE statements: prosrc with its whitespace collapsed
//   (`[[:space:]]+`, no backslash to lose in a JS template), and each storage policy as Postgres
//   DEPARSES it. The rule's statements are derived here from the dated file itself, so the audit
//   and the migration cannot drift apart; the deparsed policies are checked against the source.

const sqlLit = (s) => String(s).replace(/'/g, "''");
const auditCheck = async (prefix) => {
  const { OBJECT_CHECKS } = await import('../scripts/audit-db.mjs');
  const found = OBJECT_CHECKS.filter(([label]) => label.startsWith(prefix));
  assert.equal(found.length, 1, `exactly one audit check is labelled "${prefix}…"`);
  return found[0][1];
};

/** The index of the `)` closing the `(` at `open` in SQL text — quoted strings ('' doubled) skipped; -1 if none. */
function sqlClose(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "'") {
      let j = i + 1;
      while ((j = text.indexOf("'", j)) >= 0 && text[j + 1] === "'") j += 2;
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The inside of an audit check's `(p.proname = '<fn>' …)` branch. ★ Every probe in it must be a
 * CONJUNCT: an `or` outside a string would let the branch pass without the probe beside it, and a
 * test that only finds the probe's text cannot tell.
 */
function branchOf(check, fn) {
  const open = check.indexOf(`(p.proname = '${fn}'`);
  assert.ok(open >= 0, `the audit check has no (p.proname = '${fn}' …) branch`);
  const close = sqlClose(check, open);
  assert.ok(close > open, `the ${fn} branch never closes`);
  const branch = check.slice(open + 1, close);
  assert.doesNotMatch(branch.replace(/'(?:[^']|'')*'/g, "''"), /\bor\b/i,
    `the ${fn} branch must AND its probes: an OR outside a string lets one pass without the others`);
  return branch;
}

/**
 * The four onboarding-videos storage policies as Postgres DEPARSES them (pg_policies.qual /
 * with_check), read on the shadow project — PostgreSQL 17.6 — after #69 was applied, `public.`
 * removed (the catalog qualifies a call only when the reading session's search_path cannot see
 * it, and the audit strips it the same way). The INSERT policy has only WITH CHECK; the others
 * only USING.
 */
const DEPARSED = (() => {
  const B = GS.ONBOARDING_VIDEO_BUCKET;
  const bucket = `(bucket_id = '${B}'::text)`;
  const staff = "( SELECT has_staff_permission('onboarding.manage'::text) AS has_staff_permission)";
  return {
    onboarding_videos_object_read: { col: 'qual', text: `(${bucket} AND (${staff} OR onboarding_video_object_readable(name)))` },
    onboarding_videos_object_insert: { col: 'with_check', text: `(${bucket} AND ${staff} AND onboarding_video_upload_allowed(name))` },
    onboarding_videos_object_update: { col: 'qual', text: `(${bucket} AND ${staff} AND onboarding_video_upload_allowed(name))` },
    onboarding_videos_object_delete: { col: 'qual', text: `(${bucket} AND ${staff} AND (NOT onboarding_video_object_is_live(name)))` },
  };
})();

/** What a deparse cannot change: parentheses, the ::text casts, the sublink's alias, `public.`, case and spacing removed. */
const exprTokens = (s) => String(s).toLowerCase()
  .replace(/::text\b/g, '')
  .replace(/\s+as\s+has_staff_permission\b/g, '')
  .replace(/\bpublic\./g, '')
  .replace(/[()\s]/g, '');

test('scripts/audit-db.mjs holds the gate rule, its inputs and the completion lookups WHOLE, as the dated file writes them (TDR-2)', async () => {
  const check = await auditCheck('#69    the gate rule, the completion rule and the problem report hold (prosrc)');
  const b = norm(bodyOf(dated, 'user_onboarding_video_state') || '');
  const stmt = (from, to) => {
    const at = b.indexOf(from);
    assert.ok(at >= 0, `the dated file has no "${from}"`);
    return b.slice(at, b.indexOf(to, at) + to.length);
  };
  const whole = [stmt('v_staff :=', ';'), stmt('v_eligible :=', ';'), stmt('v_media :=', ';'),
    stmt("'required', coalesce(", ', false))'),
    stmt('select min(g.completed_at) into v_done from', ';'), stmt('select g.completed_at into v_done_cur from', ';')];
  // prosrc keeps the body's comments, so a comment inside one of these statements would make the
  // live text differ from the one compared here.
  const raw = norm(fnDef(dated, 'user_onboarding_video_state').body);
  const branch = branchOf(check, 'user_onboarding_video_state');
  for (const s of whole) {
    assert.ok(raw.includes(s), `no comment may sit inside a statement the audit compares against prosrc: ${s}`);
    assert.ok(branch.includes(`regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g') like '%${sqlLit(s)}%'`),
      `the audit must compare the whole statement, operators and all: ${s}`);
  }
  assert.ok(check.includes(`regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g') not like '%''required'',%''required'',%'`),
    'and refuse a second `required` key, which would override the first');
  assert.doesNotMatch(check, /prosrc like '%coalesce\(v_video\.id is not null and v_media and v_eligible and not v_staff%'/,
    'the prefix probe that let `and` → `or` through is gone');
});

// ★ EACH STORAGE HELPER WHOLE, BY EQUALITY (TDR-2). A probe per term passed `and` → `or` in every
//   helper body — the one that lets a Super Admin write over the live object among them — and
//   "contains" is not enough for a SQL function either: it answers with its LAST statement, so a
//   `select true;` after the real one would be its answer. The expected body is the dated file's,
//   comments included, because prosrc keeps them.
test('scripts/audit-db.mjs holds each storage helper to its WHOLE body, as the dated file writes it (TDR-2)', async () => {
  const check = await auditCheck('#69    the storage helpers');
  assert.match(check, /^select count\(\*\) = 3 as ok\b/, 'all three helpers must pass, one row each');
  for (const fn of Object.keys(POLICY_HELPERS)) {
    const d = fnDef(dated, fn);
    assert.ok(d, `${fn} is not defined in the dated file`);
    const raw = norm(d.body);
    assert.equal(raw, norm(stripComments(d.body)),
      `no comment may sit inside ${fn}: prosrc keeps it, so the whole-body comparison would fail on the live database`);
    assert.ok(branchOf(check, fn).includes(`btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) = '${sqlLit(raw)}'`),
      `the audit's ${fn} branch must compare the WHOLE body, by equality: ${raw}`);
  }
});

test('scripts/audit-db.mjs holds each storage policy to its WHOLE deparsed text, which says what the source says (TDR-2)', async () => {
  const check = await auditCheck('#69    onboarding-video READS are by reference, WRITES by path');
  const exe = stripComments(dated);
  for (const [name, { col, text }] of Object.entries(DEPARSED)) {
    assert.ok(check.includes(`replace(${col}, 'public.', '') = '${sqlLit(text)}'`),
      `${name}: the audit must compare its whole ${col}, operators and all, with: ${text}`);
    const src = policiesOf(exe).find((p) => p.name === name);
    assert.ok(src, `${name} is not in the dated file`);
    const expr = norm(src.text).replace(/^for \w+ to authenticated (using|with check) /, '');
    assert.equal(exprTokens(text), exprTokens(expr), `${name}: the deparsed text the audit expects is not the policy the file creates`);
  }
  assert.ok(check.includes("and policyname = 'onboarding_videos_object_insert'") && /\bqual is null\b/.test(check),
    'the insert policy has no USING of its own');
});

test('scripts/audit-db.mjs reads the three-argument publish, and refuses any second signature of a #69 function (DBSEC-1)', async () => {
  const check = await auditCheck('#69    12 client RPCs + 3 policy helpers callable by authenticated');
  assert.ok(check.includes("('admin_onboarding_video_publish(uuid,boolean,uuid)', 'client')"), 'the ACL check reads the new signature');
  assert.ok(!check.includes("'admin_onboarding_video_publish(uuid,boolean)', 'client'"), '…not the dropped one');
  assert.match(check, /p2\.proname = split_part\(v\.sig, '\(', 1\)\) = 1/, 'one signature per #69 name: an overload left behind fails');
  assert.ok(check.includes("to_regprocedure('public.admin_onboarding_video_publish(uuid,boolean)') is null"), 'the two-argument publish is gone');
  // Every client RPC in the contract above is in the audit's list, by its exact signature.
  for (const [fn, args] of Object.entries(CLIENT_RPCS)) {
    assert.ok(check.includes(`('${fn}(${args})', 'client')`), `the audit's ACL list names ${fn}(${args})`);
  }
});
