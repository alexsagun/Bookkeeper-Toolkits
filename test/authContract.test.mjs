// test/authContract.test.mjs — AuthProvider's documented contract vs what it exports.
//
// WHY THIS EXISTS. `useAuth()` is destructured in ~14 components, and a key that
// is documented but never placed on the context value comes back as `undefined` —
// which is falsy, which means a guard written as `if (staffMissing) …` silently
// never fires. Nothing catches that: JSX destructuring of a missing key is legal,
// `npm run build` is happy, and the feature just quietly does the old thing.
//
// That is not hypothetical. While fixing the Team & Roles 500s, `staffMissing` was
// added as state, set in three places, and consumed in BookkeeperPro.jsx — but the
// line adding it to the context value was dropped by a bad scripted edit. The build
// passed and all 633 tests passed; the screen would have kept firing the request it
// was supposed to skip.
//
// So: the header comment IS the contract, and this asserts the file honours it.
// Reads source as TEXT. No React, no DOM, no credentials.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const SRC = read('src/auth/AuthProvider.jsx');

/** The `const value = { … };` object literal, as text. */
function contextValueBlock(src) {
  const start = src.indexOf('const value = {');
  assert.ok(start > 0, 'AuthProvider must build its context as `const value = { … }`');
  // Walk braces so a nested object or arrow body cannot end the block early.
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated context value object');
}

/**
 * The keys the file's own header block advertises, from the
 * `const { … } = useAuth();` example it opens with.
 */
function documentedKeys(src) {
  const header = src.slice(0, src.indexOf('// ---', 40));
  const m = /const \{([\s\S]*?)\} = useAuth\(\);/.exec(header);
  assert.ok(m, 'the header must document the useAuth() shape — it is the contract');
  return m[1]
    .split(',')
    .map((k) => k.replace(/\/\//g, '').trim())
    .filter(Boolean);
}

const VALUE = contextValueBlock(SRC);
const DOCUMENTED = documentedKeys(SRC);

test('the header documents a non-trivial contract', () => {
  assert.ok(DOCUMENTED.length >= 15,
    `expected the documented useAuth() shape to list the real surface, got ${DOCUMENTED.length}`);
  for (const k of ['staff', 'staffReady', 'staffDegraded', 'staffMissing', 'can', 'isSuperAdmin']) {
    assert.ok(DOCUMENTED.includes(k), `${k} must be documented in the header contract`);
  }
});

test('every key the header documents is actually on the context value', () => {
  const missing = DOCUMENTED.filter((k) => {
    // `key,` shorthand or `key:` explicit — either satisfies the contract.
    const re = new RegExp(`(^|[\\s,{])${k}\\s*[,:]`, 'm');
    return !re.test(VALUE);
  });
  assert.deepEqual(missing, [],
    'these are documented but never placed on the context value, so every consumer '
    + 'destructures `undefined` — falsy, so any guard written on them silently never fires, '
    + 'and the build stays green');
});

test('the staff authority keys are wired end to end, not just declared', () => {
  // A state hook that is never set, or set but never exported, is the same bug in
  // two different disguises. Both halves have to be present.
  for (const key of ['staffDegraded', 'staffMissing']) {
    const setter = `set${key[0].toUpperCase()}${key.slice(1)}`;
    assert.match(SRC, new RegExp(`const \\[${key}, ${setter}\\] = useState`),
      `${key} must be React state`);
    // Set on the happy path, and cleared when the session goes away.
    const setCount = (SRC.match(new RegExp(`${setter}\\(`, 'g')) || []).length;
    assert.ok(setCount >= 3,
      `${setter}() is called ${setCount} time(s) — expected at least three: the sign-out reset, `
      + 'the session effect, and refreshStaff(). A path that forgets one leaves stale authority '
      + 'on screen after the thing it described has changed.');
  }
});

test('authority is read live, never decoded from the token', () => {
  // The property that makes suspending a staff member take effect on their next
  // REQUEST rather than their next token refresh. If someone ever "optimises" this
  // into a JWT claim, that guarantee is gone and nothing else would notice.
  assert.match(SRC, /supabase\.rpc\('my_staff_context'\)/,
    'the staff context must come from the my_staff_context() RPC');
  assert.ok(!/user_metadata[\s\S]{0,120}(permission|role_key|is_super)/i.test(SRC),
    'staff authority must never be read from user metadata — it is user-editable');
});
