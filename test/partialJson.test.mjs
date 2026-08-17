// Pins the tolerant JSON extraction used by the Cover Letter Generator.
//
// The truncation-recovery path is the reason this file exists: it only runs when a
// response was clipped by max_tokens, which is rare, non-deterministic, and impossible
// to trigger on demand in a browser. Without these tests it would be shipped unverified
// — which is exactly how it shipped broken the first time (lastIndexOf('}') on a clipped
// response yields an unclosed array, so the "salvage" path threw instead of salvaging).

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripFences, repairTruncatedJson, parseLooseJson } from '../src/lib/partialJson.js';

test('stripFences removes code fences and leading prose', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('Here you go:\n{"a":1}'), '{"a":1}');
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
  assert.equal(stripFences(''), '');
  assert.equal(stripFences(null), '');
  assert.equal(stripFences(undefined), '');
});

test('parseLooseJson handles clean, fenced and comma-sloppy input', () => {
  assert.deepEqual(parseLooseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('Sure!\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.deepEqual(parseLooseJson('{"a":[1,2,],}'), { a: [1, 2] });
});

test('parseLooseJson does NOT rewrite curly double quotes', () => {
  // The inline copies elsewhere in the app do this, and it corrupts valid data: curly
  // double quotes are ordinary characters inside a JSON string, so replacing them with
  // straight quotes injects an unescaped delimiter.
  const body = 'He said “fix it” and hung up';
  const parsed = parseLooseJson(JSON.stringify({ body }));
  assert.equal(parsed.body, body, 'curly double quotes must survive verbatim');
});

test('curly SINGLE quotes are normalised only as a fallback', () => {
  // Valid JSON parses on the first attempt, untouched.
  const apostrophe = 'the owner’s books';
  assert.equal(parseLooseJson(JSON.stringify({ b: apostrophe })).b, apostrophe);
});

test('parseLooseJson throws on unsalvageable input without allowTruncated', () => {
  assert.throws(() => parseLooseJson('not json at all'), SyntaxError);
  assert.throws(() => parseLooseJson('{"a":'), SyntaxError);
  // A clipped response must NOT be silently salvaged unless the caller opts in.
  assert.throws(() => parseLooseJson('{"variations":[{"body":"a"}],"tmay":{"hook":"h'), SyntaxError);
});

test('THE REGRESSION: a response clipped mid-nested-object keeps its complete prefix', () => {
  // Three complete letters, then the cut lands inside tmayScript.hook.
  const clipped = '{"variations":[{"label":"Direct","subject":"a","body":"b"},'
    + '{"label":"Story","subject":"c","body":"d"},'
    + '{"label":"Curious","subject":"e","body":"f"}],'
    + '"tmayScript":{"hook":"h","credib';

  // lastIndexOf('}') alone produces an unclosed array — the original bug.
  assert.throws(() => JSON.parse(clipped.slice(0, clipped.lastIndexOf('}') + 1)), SyntaxError);

  const out = parseLooseJson(clipped, { allowTruncated: true });
  assert.equal(out.variations.length, 3, 'all three completed letters must survive');
  assert.equal(out.variations[2].body, 'f');
  assert.equal(out.tmayScript.hook, 'h');
  assert.ok(!('credib' in out.tmayScript), 'the partial key must be dropped, not invented');
});

test('truncation recovery drops a partial trailing element rather than corrupting it', () => {
  const cases = [
    // cut inside a string value
    ['{"a":"one","b":"tw', { a: 'one' }],
    // cut right after a comma
    ['{"a":"one",', { a: 'one' }],
    // cut on an orphaned key
    ['{"a":"one","b":', { a: 'one' }],
    // cut on an orphaned key with no colon yet
    ['{"a":"one","b', { a: 'one' }],
    // cut inside a nested array element
    ['{"a":["x","y","z', { a: ['x', 'y'] }],
    // cut inside a bare literal
    ['{"a":1,"b":tru', { a: 1 }],
    // cut inside a number — `12.` could have been 12.5, so the key is dropped rather
    // than salvaged as 12. A partial value is worse than a missing one.
    ['{"a":1,"b":12.', { a: 1 }],
    // deeply nested
    ['{"p":{"q":{"r":["s","t', { p: { q: { r: ['s'] } } }],
  ];
  for (const [input, expected] of cases) {
    const got = parseLooseJson(input, { allowTruncated: true });
    assert.deepEqual(got, expected, `input ${JSON.stringify(input)}`);
  }
});

test('truncation recovery preserves escapes and newlines inside surviving strings', () => {
  const clipped = '{"body":"Talk soon.\\nMaria \\"M\\" Santos","next":"cut he';
  const out = parseLooseJson(clipped, { allowTruncated: true });
  assert.equal(out.body, 'Talk soon.\nMaria "M" Santos');
  assert.ok(!('next' in out));
});

test('a brace inside a string does not confuse the scanner', () => {
  const clipped = '{"a":"a } b ] c","b":"cut';
  const out = parseLooseJson(clipped, { allowTruncated: true });
  assert.deepEqual(out, { a: 'a } b ] c' });
});

test('allowTruncated still parses a COMPLETE response unchanged', () => {
  const whole = { variations: [{ body: 'x' }], prep: { redFlags: ['a', 'b'] } };
  assert.deepEqual(parseLooseJson(JSON.stringify(whole), { allowTruncated: true }), whole);
});

test('repairTruncatedJson output is always parseable or empty', () => {
  const base = '{"variations":[{"label":"Direct","subject":"a","body":"b"}],"tmayScript":{"hook":"h","close":"c"},"prep":{"redFlags":["x"]}}';
  // The postcondition, checked at EVERY possible cut point: the output parses, or it
  // is empty. This is the test that caught `{"variations"}` (a key closed with no
  // value) and the unreachable number-peel branch.
  for (let i = 1; i <= base.length; i++) {
    const repaired = repairTruncatedJson(base.slice(0, i));
    if (repaired === '') continue;
    assert.doesNotThrow(
      () => JSON.parse(repaired.replace(/,(\s*[}\]])/g, '$1')),
      `cut at ${i} produced unparseable output: ${repaired}`,
    );
  }
});
