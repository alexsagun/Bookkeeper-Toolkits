// ─────────────────────────────────────────────────────────────────────────────
// Chart of Accounts integrity — from the 2026-08-31 full-stack audit.
//
// CoaGenerator merges COA_BASE with one COA_INDUSTRY pack and exports a
// "QBO-Ready" CSV. QuickBooks Online REJECTS a chart import that contains two
// accounts with the same number, so a collision does not degrade the export —
// it makes the export unusable for that industry, after the user has filled in
// the form and downloaded the file.
//
// A 2026-07-08 audit logged this and no later audit recorded it as fixed. When
// this test was written, 4 of 17 industries collided on 6 numbers, including
// `1020 Petty Cash` vs `1020 Client Trust Account` — which is not merely an
// import failure but an operating account merged with a client trust account.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pull a top-level array/object literal out of the monolith and evaluate it. */
function literal(name) {
  const src = readFileSync(join(REPO, 'src/BookkeeperPro.jsx'), 'utf8');
  const decl = src.indexOf(`const ${name} =`);
  assert.ok(decl > 0, `${name} not found in src/BookkeeperPro.jsx`);
  const open = src.indexOf(src[src.indexOf('=', decl) + 2] === '[' ? '[' : '{', decl);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `could not bracket-match ${name}`);
  // eslint-disable-next-line no-eval
  return eval(`(${src.slice(open, end)})`);
}

const COA_BASE = literal('COA_BASE');
const COA_INDUSTRY = literal('COA_INDUSTRY');

test('COA_BASE has no duplicate account numbers', () => {
  const seen = new Map();
  for (const row of COA_BASE) {
    assert.ok(!seen.has(row.num),
      `COA_BASE reuses ${row.num}: "${seen.get(row.num)}" and "${row.name}"`);
    seen.set(row.num, row.name);
  }
});

test('no industry pack collides with the base chart', () => {
  const collisions = [];
  for (const [industry, rows] of Object.entries(COA_INDUSTRY)) {
    const seen = new Map(COA_BASE.map((r) => [r.num, r.name]));
    for (const row of rows) {
      if (seen.has(row.num)) {
        collisions.push(`${industry}: ${row.num} — "${seen.get(row.num)}" vs "${row.name}"`);
      }
      seen.set(row.num, row.name);
    }
  }
  assert.deepEqual(collisions, [],
    'QuickBooks rejects a chart import with duplicate account numbers, so every one of '
    + 'these makes the generated CSV unusable for that industry:\n  ' + collisions.join('\n  '));
});

test('every account row is shaped for the CSV export', () => {
  const all = [...COA_BASE, ...Object.values(COA_INDUSTRY).flat()];
  for (const row of all) {
    assert.match(String(row.num), /^\d{3,5}$/, `account number is not numeric: ${JSON.stringify(row)}`);
    assert.ok(row.name && row.name.trim(), `account has no name: ${JSON.stringify(row)}`);
    assert.ok(row.type && row.type.trim(), `account has no type: ${JSON.stringify(row)}`);
  }
});

test('every industry pack is non-empty', () => {
  for (const [industry, rows] of Object.entries(COA_INDUSTRY)) {
    assert.ok(Array.isArray(rows) && rows.length > 0, `${industry} has no accounts`);
  }
});
