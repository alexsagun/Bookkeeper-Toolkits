// ─────────────────────────────────────────────────────────────────────────────
// The intake option lists and the SQL CHECKs that bind them must agree.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXISTS
//   EXPERIENCE_OPTIONS and EMPLOYED_OPTIONS live in src/lib/enrollmentIntake.js,
//   which drives BOTH rendering and validateIntake(). The same strings are then
//   re-stated as SQL string literals in four CHECK constraints, across two files
//   (the dated migration and its verbatim bootstrap fold). Nothing pinned the
//   pair, and test/enrollmentIntake.test.mjs only ever iterated the JS half.
//
// WHAT BREAKS IF THEY DRIFT
//   Reword an option — '2-5 years' to '2–5 years' with an en dash, say. Every
//   render agrees, validateIntake() agrees, the whole JS suite passes, the form
//   submits cleanly. Then the INSERT fails with a raw 23514, which submit()
//   surfaces as the generic "Could not submit your enrollment. Please try
//   again." By then the receipt, resume, signature PNG and agreement PDF have
//   ALL been uploaded — submit uploads before it inserts — so every retry
//   re-uploads and re-orphans, and no retry can ever succeed. Every paying
//   student hits it at once, with nothing anywhere naming a CHECK constraint.
//
//   The same reasoning covers AGREEMENT_TIERS: a tier the CHECK rejects makes
//   the signed agreement unstorable.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EXPERIENCE_OPTIONS, EMPLOYED_OPTIONS } from '../src/lib/enrollmentIntake.js';
import { AGREEMENT_TIERS } from '../src/lib/trainingAgreement.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Both files must carry the constraint — the bootstrap is what a FRESH install
// gets, and it is folded by hand, so it is exactly where a correction gets lost.
const SQL_FILES = [
  'db/2026-08-20-enrollment-intake.sql',
  'db/000_full_database_bootstrap.sql',
];

/**
 * Pull the `in ('a', 'b', …)` list out of one named CHECK constraint.
 *
 * Deliberately literal-minded: it finds the constraint by name and reads the
 * first parenthesised IN list after it. If the migration is ever reformatted so
 * this stops matching, the test fails loudly rather than silently passing —
 * which is the correct direction for a guard.
 */
function checkOptions(sql, constraintName) {
  const at = sql.indexOf(constraintName);
  if (at === -1) return null;
  const tail = sql.slice(at, at + 900);
  const m = /\bin\s*\(([^)]*)\)/i.exec(tail);
  if (!m) return null;
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^'|'$/g, '').replace(/''/g, "'"));
}

const CASES = [
  ['enrollment_requests_ph_experience_chk', EXPERIENCE_OPTIONS, 'EXPERIENCE_OPTIONS'],
  ['enrollment_requests_us_experience_chk', EXPERIENCE_OPTIONS, 'EXPERIENCE_OPTIONS'],
  ['enrollment_requests_currently_employed_chk', EMPLOYED_OPTIONS, 'EMPLOYED_OPTIONS'],
  ['enrollment_requests_agreement_tier_chk', AGREEMENT_TIERS, 'AGREEMENT_TIERS'],
];

let comparisons = 0;

for (const file of SQL_FILES) {
  const sql = readFileSync(join(REPO, file), 'utf8');

  for (const [constraint, jsOptions, jsName] of CASES) {
    test(`${file}: ${constraint} accepts exactly ${jsName}`, () => {
      const sqlOptions = checkOptions(sql, constraint);
      assert.ok(
        sqlOptions,
        `${constraint} not found in ${file} — a CHECK that binds what the form `
        + 'writes must exist in the dated migration AND in the bootstrap fold',
      );
      assert.deepEqual(
        sqlOptions,
        [...jsOptions],
        `${constraint} in ${file} disagrees with ${jsName}. A student would pass `
        + 'every client check and then be refused by Postgres with a bare 23514, '
        + 'AFTER all four files had already uploaded.',
      );
      comparisons += 1;
    });
  }
}

test('every option list is pinned in both SQL files', () => {
  assert.equal(
    comparisons,
    SQL_FILES.length * CASES.length,
    `expected ${SQL_FILES.length * CASES.length} constraint comparisons `
    + '(4 constraints x 2 files) — a missing one means a CHECK is unpinned',
  );
});
