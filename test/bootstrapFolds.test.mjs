// Guards db/000_full_database_bootstrap.sql against losing a migration fold.
//
// Why this exists: on 2026-08-23 a re-fold of §29 (#42) replaced the file from
// §29's start to END-OF-FILE instead of to §29's end, silently deleting all 535
// lines of §30 (#43) — a security policy, two storage-cleanup paths, an admin RPC
// contract and the feed index #43 was written to fix. `npm test` stayed green,
// `npm run build` stayed green, and the last line of the truncated file was a
// tidy "AFTER RUNNING" comment block, so it read as a clean EOF.
//
// Nothing offline could catch it. test/enrollmentIntakeSql.test.mjs reads the
// bootstrap but only for #42's four CHECK constraints — it reads §29 and passes
// with §30 gone. `npm run db:audit` would notice, but it needs credentials, and
// `db:shadow:verify --all` re-applies every dated file on top of the bootstrap,
// which would re-apply #43 and mask the gap entirely.
//
// This codebase has now been bitten three times by fold/apply drift (#20/#21,
// #37b, and this), so the check is structural and needs no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const read = (f) => readFileSync(join(DB_DIR, f), 'utf8').replace(/\r\n/g, '\n');

const BOOTSTRAP = '000_full_database_bootstrap.sql';
const bootstrap = read(BOOTSTRAP);
const bootstrapLines = bootstrap.split('\n');

const datedFiles = readdirSync(DB_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.sql$/.test(f))
  .sort();

// A banner looks like:  -- §30) FOLDED VERBATIM — 2026-08-22-…sql   (#43)
const BANNER = /^--\s*§(\d+)\)\s*FOLDED VERBATIM\s*—\s*(\S+\.sql)/;

const folds = [];
bootstrapLines.forEach((line, i) => {
  const m = BANNER.exec(line);
  if (m) folds.push({ n: Number(m[1]), file: m[2], start: i });
});
folds.forEach((f, i) => {
  f.end = i + 1 < folds.length ? folds[i + 1].start : bootstrapLines.length;
});

/** Executable SQL only: no comments, no blanks, whitespace-collapsed. */
const sqlLines = (text) => text
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('--'))
  .map((l) => l.replace(/\s+/g, ' '));

/**
 * Preflight `do $pre$ … $pre$;` guards are deliberately DROPPED from a fold (the
 * bootstrap creates every dependency itself, in order), so they are excluded from
 * what a fold is required to contain. Some folds keep theirs; both are fine.
 */
const withoutPreflight = (lines) => {
  const out = [];
  let inside = false;
  for (const l of lines) {
    if (!inside && /^do \$pre\$/.test(l)) { inside = true; continue; }
    if (inside) { if (/\$pre\$;/.test(l)) inside = false; continue; }
    out.push(l);
  }
  return out;
};

test('the bootstrap has at least one fold and their § numbers are contiguous', () => {
  assert.ok(folds.length >= 9, `expected the folds to still be there, found ${folds.length}`);
  const nums = folds.map((f) => f.n);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'fold § numbers are out of order');
  for (let i = 1; i < nums.length; i++) {
    assert.equal(nums[i], nums[i - 1] + 1,
      `fold numbering jumps from §${nums[i - 1]} to §${nums[i]} — a section was deleted or renumbered`);
  }
});

test('every folded banner names a dated file that exists', () => {
  for (const f of folds) {
    assert.ok(datedFiles.includes(f.file),
      `§${f.n} claims to fold ${f.file}, which is not in db/`);
  }
});

test('every fold contains the whole SQL body of the file it claims to fold', () => {
  for (const f of folds) {
    const want = withoutPreflight(sqlLines(read(f.file)));
    const got = new Set(sqlLines(bootstrapLines.slice(f.start, f.end).join('\n')));
    const missing = want.filter((l) => !got.has(l));
    assert.equal(missing.length, 0,
      `§${f.n} (${f.file}) is missing ${missing.length} SQL line(s) from the dated file, `
      + `starting with: ${JSON.stringify(missing.slice(0, 3))}`);
  }
});

// The check that would have caught the 2026-08-23 deletion outright: a folded
// migration keeps its own schema_migrations insert, so its filename is a literal
// in the bootstrap. Lose the fold and the filename disappears with it.
test('every self-recording dated migration is named somewhere in the bootstrap', () => {
  for (const file of datedFiles) {
    const body = read(file);
    if (!body.includes('insert into public.schema_migrations')) continue;
    if (!body.includes(`'${file}'`)) continue;   // records something other than itself
    assert.ok(bootstrap.includes(file),
      `${file} records itself in schema_migrations but is not mentioned in ${BOOTSTRAP} — `
      + 'a fresh install would not get it, and db:audit would report it unapplied');
  }
});
