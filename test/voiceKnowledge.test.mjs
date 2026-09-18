// test/voiceKnowledge.test.mjs — the knowledge document's semantics (fixture half).
//
// src/lib/voiceKnowledge.js owns three things that shipped for months with no test:
// the literal extractor the generator and the provisioner both depend on, the
// fingerprint that lets provisioning PROVE which copy of the document the live agent
// holds, and the invariants the generator runs on every build.
//
// Why each group exists, up front:
//
//   1. On 2026-09-16 the knowledge document attached to the live agent was named
//      correctly and dated 2026-07-17: it advertised 32 tools, two deleted plans and
//      two retired tools. A name match proved nothing; only a content digest can.
//   2. The extractor existed twice as near-byte copies and skipped from `const X = `
//      to the NEXT bracket anywhere in the file, so `const X = build()` silently
//      evaluated an unrelated literal thousands of lines later.
//   3. The heuristic audit of the real document found three invariants that PASSED
//      a genuinely stale document — the roles and staff-screen checks counted
//      mentions in navigation-table rows, and the nav check counted mentions in the
//      FAQ as rows — and one that FAILED an accurate sentence ("legacy Thinkific").
//      Each fix is pinned below by a fixture that fails without it.
//
// This file deliberately asserts NOTHING about the committed
// docs/ai/toolkits-voice-agent-knowledge.md — that half lands after the document is
// regenerated. The monolith is read only for STRUCTURAL facts (shapes and
// subset relations, never counts another session may change).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PER_CALLER_VARIABLE_NAMES,
  RETIRED_KNOWLEDGE_TERMS,
  RETIRED_TERM_HISTORICAL_USES,
  extractPureLiteral,
  fencedBlockAfter,
  knowledgeFingerprint,
  knowledgeInvariantFailures,
  knowledgeInvariants,
  normalizeKnowledgeText,
  readKnowledgeFingerprint,
} from '../src/lib/voiceKnowledge.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = () => readFileSync(join(REPO, 'src/BookkeeperPro.jsx'), 'utf8');

const fp = knowledgeFingerprint;
const toCrlf = (s) => s.replace(/\r?\n/g, '\r\n');

// ═════════════════════════════════════════════════════════════════════════════
// 1. The fingerprint
// ═════════════════════════════════════════════════════════════════════════════

const SAMPLE = [
  '<!-- GENERATED FILE — do not hand-edit. Regenerate with `npm run ai:knowledge`',
  '     (scripts/generate-voice-agent-knowledge.mjs). Generated: 2026-09-16 -->',
  '',
  '# Toolkits by Alex — Voice Assistant Knowledge',
  '',
  '- The toolkit bundles **30 tools** across three career stages.',
  '  - A nested bullet whose indentation is structure.',
  '',
].join('\n');

// Embed a document's own fingerprint the way the generator does: appended to the
// header's Generated stamp with a `·` separator.
const embedFingerprint = (doc) =>
  doc.replace(/Generated: \d{4}-\d{2}-\d{2}/, (stamp) => `${stamp} · Fingerprint: ${fp(doc)}`);

// Independent FNV-1a-64 over raw bytes, used only to prove the module's constants.
const fnv1a64 = (bytes) => {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
};

test('fingerprint: the format is kb1- plus sixteen lowercase hex digits', () => {
  for (const doc of [SAMPLE, '', 'x', toCrlf(SAMPLE), '₱16,999 · Community']) {
    assert.match(fp(doc), /^kb1-[0-9a-f]{16}$/);
  }
});

test('fingerprint: it is FNV-1a-64 of the normalized text, byte for byte', () => {
  // The reference reproduces the published FNV-1a-64 vector for "a", so agreeing with
  // it pins the module's offset basis and prime, not merely its own output.
  assert.equal(fnv1a64([0x61]), 'af63dc4c8601ec8c');
  const enc = new TextEncoder();
  assert.equal(fp(''), `kb1-${fnv1a64(enc.encode('\n'))}`);
  assert.equal(fp(''), 'kb1-af63c74c8601c8dd');
  assert.equal(fp(SAMPLE), `kb1-${fnv1a64(enc.encode(normalizeKnowledgeText(SAMPLE)))}`);
  // Changing the algorithm or the normalization changes every published fingerprint,
  // which must also change the `kb1-` prefix — so these two are golden on purpose.
  assert.equal(fp('a'), 'kb1-089bdc07b544e7b2');
});

test('fingerprint: a rebuild on another day is not drift', () => {
  const tomorrow = SAMPLE.replace('Generated: 2026-09-16', 'Generated: 2027-01-31');
  assert.notEqual(tomorrow, SAMPLE);
  assert.equal(fp(tomorrow), fp(SAMPLE));
});

test('fingerprint: CRLF and LF are the same document', () => {
  assert.equal(fp(toCrlf(SAMPLE)), fp(SAMPLE));
});

test('fingerprint: trailing whitespace and trailing newlines carry no meaning', () => {
  const noisy = SAMPLE.split('\n').map((l) => `${l} \t`).join('\n') + '\n\n\n';
  const bare = SAMPLE.replace(/\n+$/, '');
  assert.equal(fp(noisy), fp(SAMPLE));
  assert.equal(fp(bare), fp(SAMPLE));
  assert.equal(fp(toCrlf(noisy)), fp(SAMPLE));
});

test('fingerprint: one content character changes it, and so does indentation', () => {
  assert.notEqual(fp(SAMPLE.replace('30 tools', '31 tools')), fp(SAMPLE));
  assert.notEqual(fp(SAMPLE.replace('Voice Assistant', 'Voice assistant')), fp(SAMPLE));
  assert.notEqual(fp(SAMPLE.replace('  - A nested', '    - A nested')), fp(SAMPLE));
});

test('fingerprint: a document that embeds its own fingerprint round-trips', () => {
  const doc = embedFingerprint(SAMPLE);
  assert.match(doc, /Generated: 2026-09-16 · Fingerprint: kb1-[0-9a-f]{16} -->/);
  assert.equal(readKnowledgeFingerprint(doc), fp(doc));
  assert.equal(fp(doc), fp(SAMPLE), 'the token must be excluded from the digest');
  // The token's VALUE is excluded, not only its presence.
  assert.equal(fp(doc.replace(/kb1-[0-9a-f]{16}/, 'kb1-0000000000000000')), fp(doc));
  // And it survives the same transport noise as the body.
  const crlf = toCrlf(doc);
  assert.equal(readKnowledgeFingerprint(crlf), fp(crlf));
});

test('fingerprint: the reader and the normalizer agree on a token without the · separator', () => {
  // Before the fix the reader accepted these and the normalizer did not strip them,
  // so the document could never match its own fingerprint.
  const sameLine = SAMPLE.replace(' -->', ` Fingerprint: ${fp(SAMPLE)} -->`);
  const ownLine = SAMPLE.replace(' -->', `\nFingerprint: ${fp(SAMPLE)} -->`);
  for (const doc of [sameLine, ownLine]) {
    assert.equal(readKnowledgeFingerprint(doc), fp(SAMPLE));
    assert.equal(readKnowledgeFingerprint(doc), fp(doc));
  }
});

test('readKnowledgeFingerprint: null when absent or malformed, never a throw', () => {
  for (const bad of [
    undefined, null, '', 42, {}, 'no token here',
    'Fingerprint:', 'Fingerprint: kb1-', 'Fingerprint: kb1-xyz',
    'Fingerprint: kb1-0123456789ABCDEF', // uppercase
    'Fingerprint: kb2-0123456789abcdef', // another format
    'Fingerprint: kb1-0123456789abcde', // 15 digits
    'Fingerprint: kb1-0123456789abcdef0', // 17 digits is not a truncated match
    'Fingerprint: kb1-0123456789abcdefg',
    'kb1-0123456789abcdef', // no label
  ]) {
    assert.equal(readKnowledgeFingerprint(bad), null, `input: ${String(bad)}`);
  }
  assert.equal(readKnowledgeFingerprint('x · Fingerprint: kb1-0123456789abcdef -->'), 'kb1-0123456789abcdef');
});

test('normalizeKnowledgeText: the exact reduction', () => {
  assert.equal(normalizeKnowledgeText('a  \r\nb\t\r\n\r\n\r\n'), 'a\nb\n');
  assert.equal(
    normalizeKnowledgeText('<!-- Generated: 2026-09-16 · Fingerprint: kb1-0123456789abcdef -->'),
    '<!-- Generated: <date> -->\n',
  );
  assert.equal(normalizeKnowledgeText('  indented'), '  indented\n');
  assert.equal(normalizeKnowledgeText(null), '\n');
  assert.equal(normalizeKnowledgeText(undefined), '\n');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. extractPureLiteral — the real monolith (structural facts only)
// ═════════════════════════════════════════════════════════════════════════════

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

test('extractor (real monolith): TAB_ROUTES is an object of absolute paths', () => {
  const routes = extractPureLiteral(app(), 'TAB_ROUTES');
  assert.ok(isPlainObject(routes));
  assert.ok(Object.keys(routes).length > 0);
  for (const [id, path] of Object.entries(routes)) {
    assert.equal(typeof path, 'string', id);
    assert.ok(path.startsWith('/'), `${id} → ${path}`);
  }
});

test('extractor (real monolith): every VOICE_TAB_INFO key is a TAB_ROUTES key', () => {
  const src = app();
  const routes = extractPureLiteral(src, 'TAB_ROUTES');
  const info = extractPureLiteral(src, 'VOICE_TAB_INFO');
  assert.ok(isPlainObject(info));
  assert.ok(Object.keys(info).length > 0);
  for (const [id, entry] of Object.entries(info)) {
    assert.ok(Object.hasOwn(routes, id), `VOICE_TAB_INFO.${id} has no route`);
    assert.equal(typeof entry.label, 'string', id);
  }
});

test('extractor (real monolith): NON_TOOL_TAB_IDS yields the array inside new Set([...])', () => {
  const src = app();
  const routes = extractPureLiteral(src, 'TAB_ROUTES');
  const nonTools = extractPureLiteral(src, 'NON_TOOL_TAB_IDS');
  assert.ok(Array.isArray(nonTools), 'the extractor must land on the array, not evaluate the Set');
  assert.ok(nonTools.length > 0);
  for (const id of nonTools) {
    assert.equal(typeof id, 'string');
    assert.ok(Object.hasOwn(routes, id), `NON_TOOL_TAB_IDS names "${id}", which is not a route`);
  }
});

test('extractor (real monolith): the client tool specs include the two course tools', () => {
  const specs = extractPureLiteral(app(), 'VOICE_CLIENT_TOOL_SPECS');
  assert.ok(Array.isArray(specs));
  for (const spec of specs) assert.equal(typeof spec.name, 'string');
  const names = specs.map((s) => s.name);
  assert.ok(names.includes('open_course_lesson'));
  assert.ok(names.includes('show_lesson_sources'));
});

test('extractor (real monolith): every server tool spec has a name and an action', () => {
  const specs = extractPureLiteral(app(), 'VOICE_SERVER_TOOL_SPECS');
  assert.ok(Array.isArray(specs));
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    assert.ok(typeof spec.name === 'string' && spec.name.length > 0, JSON.stringify(spec));
    assert.ok(typeof spec.action === 'string' && spec.action.length > 0, spec.name);
  }
});

test('extractor (real monolith): the other voice literals and TIPS stay pure', () => {
  const src = app();
  assert.ok(isPlainObject(extractPureLiteral(src, 'VOICE_TOOL_ALIASES')));
  assert.ok(isPlainObject(extractPureLiteral(src, 'VOICE_FEATURE_HELP')));
  const tips = extractPureLiteral(src, 'TIPS');
  assert.ok(Array.isArray(tips) && tips.length > 0);
  for (const tip of tips) assert.equal(typeof tip, 'string');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. extractPureLiteral — synthetic sources
// ═════════════════════════════════════════════════════════════════════════════

test('extractor: braces inside single, double and template strings do not count', () => {
  const src = [
    'const OTHER = 1;',
    "const X = { a: '}', b: \"{{\", c: `}}{`, d: 'it\\'s } still', e: \"say \\\"}\\\"\" };",
    'const AFTER = { never: true };',
  ].join('\n');
  assert.deepEqual(extractPureLiteral(src, 'X'), { a: '}', b: '{{', c: '}}{', d: "it's } still", e: 'say "}"' });
});

test('extractor: braces inside // and /* */ comments do not count', () => {
  const src = [
    'const X = [',
    '  // a stray } and ] here',
    "  'one', /* and { [ here */ 'two',",
    '  /* a multi-line',
    '     comment ] } */',
    "  'three',",
    '];',
  ].join('\n');
  assert.deepEqual(extractPureLiteral(src, 'X'), ['one', 'two', 'three']);
  assert.deepEqual(extractPureLiteral(toCrlf(src), 'X'), ['one', 'two', 'three']);
});

test("extractor: '//' and '/*' inside a string are not comments", () => {
  const src = "const X = { url: 'https://example.com/a}b', glob: \"src/*/x\", tail: '*/' };";
  assert.deepEqual(extractPureLiteral(src, 'X'), { url: 'https://example.com/a}b', glob: 'src/*/x', tail: '*/' });
});

test('extractor: unbalanced brackets throw, and are not misreported as impurity', () => {
  // Measured against the single-pair depth counter this replaced: the outer pair
  // always closed early on an inner mismatch, so the TRUNCATED snippet reached
  // `new Function`, and its SyntaxError was reported as "no longer a PURE literal
  // (Unexpected token '}')" — sending the reader after a function call in a
  // literal that has none, when the real edit is one missing `]`.
  for (const src of [
    'const X = { a: [1, 2 };',           // inner [ never closed
    'const X = { a: { b: 1 }, c: [2 };', // ...after a balanced sibling
    'const X = [ { a: 1 }, { b: 2 ];',   // inner { never closed
    'const X = [1, 2} , 3];',            // a closer of the wrong kind
    'const X = { a: 1, b: (2 };',        // parens are tracked too
  ]) {
    assert.throws(() => extractPureLiteral(src, 'X'), (e) => {
      assert.match(e.message, /unbalanced/, src);
      assert.doesNotMatch(e.message, /PURE/, `${src} — an unbalanced literal is not an impure one`);
      return true;
    });
  }
  // The other arm: an opener the file never closes at all.
  assert.throws(() => extractPureLiteral("const X = { a: '}' ", 'X'), /unbalanced/);
  assert.throws(() => extractPureLiteral('const X = [[1], [2];', 'X'), /never closed/);
});

test('extractor: an identifier reference or a call throws, naming the PURE contract', () => {
  assert.throws(() => extractPureLiteral('const X = { a: someVar };', 'X'), /PURE/);
  assert.throws(() => extractPureLiteral("const X = [label('x')];", 'X'), /PURE/);
});

test('extractor: a missing name throws', () => {
  assert.throws(() => extractPureLiteral('const Y = {};', 'X'), /"X" not found/);
  assert.throws(() => extractPureLiteral('', 'X'), /not found/);
  assert.throws(() => extractPureLiteral(undefined, 'X'), /not found/);
  // A longer name is not the name.
  assert.throws(() => extractPureLiteral('const XY = [1];', 'X'), /not found/);
  assert.deepEqual(extractPureLiteral('const XY = [1];\nconst X = [2];', 'X'), [2]);
});

test('extractor: an expression is refused, never skipped past to the next literal', () => {
  // The old scan jumped from `=` to the next bracket anywhere in the file and would
  // have returned { unrelated: true } here without a word.
  const src = 'const X = buildX();\nfunction buildX() { return 1; }\nconst Y = { unrelated: true };';
  assert.throws(() => extractPureLiteral(src, 'X'), /PURE/);
  assert.throws(() => extractPureLiteral('const X = FLAG ? [1] : [2];', 'X'), /PURE/);
});

test('extractor: a commented-out declaration is not the declaration', () => {
  const src = '// const X = { stale: true };\n/* const X = { older: true }; */\nconst X = { current: true };';
  assert.deepEqual(extractPureLiteral(src, 'X'), { current: true });
});

test('extractor: new Set / Object.freeze wrappers, export, a line break after =, and inject', () => {
  assert.deepEqual(extractPureLiteral("const X = new Set(['a', 'b']);", 'X'), ['a', 'b']);
  assert.deepEqual(extractPureLiteral('const X = Object.freeze({ a: 1 });', 'X'), { a: 1 });
  assert.deepEqual(extractPureLiteral('export const X = [1, 2];', 'X'), [1, 2]);
  assert.deepEqual(extractPureLiteral('const X =\n  [1, 2];', 'X'), [1, 2]);
  assert.deepEqual(extractPureLiteral('const X = { a: FOO };', 'X', { FOO: 7 }), { a: 7 });
  assert.throws(() => extractPureLiteral('const X = [1];', 'X.y'), /identifier/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. fencedBlockAfter
// ═════════════════════════════════════════════════════════════════════════════

const SETUP_MD = [
  '## 3. Agent configuration',
  '',
  '```',
  'a fence BEFORE the marker is never the answer',
  '```',
  '',
  '1. **System prompt**',
  '',
  '   ```text',
  '   You are Toolkits Siri.',
  '',
  '     - an indented detail keeps its relative indentation',
  '   ```',
  '',
  '   ```',
  '   a second fence after the marker',
  '   ```',
  '',
  '2. **First message**',
  '',
  '   ```',
  '   Hi there!',
  '   ```',
].join('\n');

test('fencedBlockAfter: an indented fence under a list item is dedented', () => {
  assert.equal(
    fencedBlockAfter(SETUP_MD, '**System prompt**'),
    'You are Toolkits Siri.\n\n  - an indented detail keeps its relative indentation',
  );
  assert.equal(fencedBlockAfter(SETUP_MD, '**First message**'), 'Hi there!');
});

test('fencedBlockAfter: CRLF input gives the same LF result', () => {
  assert.equal(fencedBlockAfter(toCrlf(SETUP_MD), '**System prompt**'), fencedBlockAfter(SETUP_MD, '**System prompt**'));
  assert.ok(!fencedBlockAfter(toCrlf(SETUP_MD), '**System prompt**').includes('\r'));
});

test('fencedBlockAfter: picks the FIRST fence after the marker', () => {
  const out = fencedBlockAfter(SETUP_MD, '**System prompt**');
  assert.ok(!out.includes('second fence'));
  assert.ok(!out.includes('BEFORE the marker'));
});

test('fencedBlockAfter: a missing marker, a missing fence and an unterminated fence throw', () => {
  assert.throws(() => fencedBlockAfter(SETUP_MD, '**Voice id**'), /not found/);
  assert.throws(() => fencedBlockAfter('**System prompt**\n\nno fence at all\n', '**System prompt**'), /No opening code fence/);
  assert.throws(() => fencedBlockAfter('**System prompt**\n\n```\nnever closed\n', '**System prompt**'), /Unterminated/);
  assert.throws(() => fencedBlockAfter(undefined, '**System prompt**'), /not found/);
});

test('fencedBlockAfter: a longer fence may quote a shorter one', () => {
  const md = ['**System prompt**', '````', 'Show this example:', '```json', '{"ok": true}', '```', 'Then stop.', '````'].join('\n');
  assert.equal(fencedBlockAfter(md, '**System prompt**'), 'Show this example:\n```json\n{"ok": true}\n```\nThen stop.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. knowledgeInvariants — one passing fixture, then one failing fixture per check
// ═════════════════════════════════════════════════════════════════════════════

const BASE_INPUTS = Object.freeze({
  routeIds: ['dashboard', 'bankfeed', 'coa', 'enrollments', 'staffroles', 'mockinterview'],
  aliasTabIds: ['mockinterview'],
  toolCount: 2, // routes minus dashboard, the two staff screens and the alias
  voiceTabInfo: {
    dashboard: { label: 'Dashboard', stage: 'Home' },
    bankfeed: { label: 'Bank Feed AI', stage: 'Client Management & Delivery' },
    coa: { label: 'Chart of Accounts', stage: 'Client Management & Delivery' },
    enrollments: { label: 'Enrollments', stage: 'Admin', adminOnly: true },
    staffroles: { label: 'Team & Roles', stage: 'Admin', adminOnly: true },
  },
  planKeys: ['sampler', 'silver_self_paced'],
  allowedPrices: ['₱1,499', '₱2,999'],
  toolNames: ['navigate_to_tool', 'get_my_training_catalog'],
  knownIdentifiers: [],
  roleLabels: ['Super Admin', 'Operations Admin', 'Trainer'],
  adminScreenLabels: ['Enrollments', 'Team & Roles'],
});

const BASE_BODY = [
  '<!-- GENERATED FILE — fixture. Generated: 2026-09-16 -->',
  '',
  '# Fixture — Voice Assistant Knowledge',
  '',
  '## 1. App overview',
  '',
  '- The toolkit bundles **2 tools** across three career stages.',
  '- Navigate with `navigate_to_tool`.',
  '',
  '## 2. User roles',
  '',
  '- **Student / member**: sees the toolkit their plan opens.',
  '- **Super Admin**: every staff screen — Enrollments and Team & Roles.',
  '- **Operations Admin**: Enrollments.',
  '- **Trainer**: no staff screens; edits the courses assigned to them.',
  '',
  '## 3. Navigation map (tools by stage)',
  '',
  '| Tool | Tab id | URL path | What it does |',
  '|---|---|---|---|',
  '| Dashboard | `dashboard` | `/` | Home. |',
  '| Bank Feed AI | `bankfeed` | `/bank-feed-ai` | Suggests a category. |',
  '| Chart of Accounts | `coa` | `/chart-of-accounts` | Builds a chart. |',
  '| Enrollments | `enrollments` | `/admin/enrollments` | Reviews receipts. |',
  '| Team & Roles | `staffroles` | `/admin/team` | Manages staff. |',
  '',
  '## 4. Subscription plans',
  '',
  '| Plan | Key | Price (PHP) | Access |',
  '|---|---|---|---|',
  '| Sampler Session | `sampler` | ₱1,499 | 60 days |',
  '| QBO + Resume Combo | `silver_self_paced` | ₱2,999 | 60 days |',
  '',
  '## 5. Courses',
  '',
  '- Teach only from `get_my_training_catalog`.',
  '',
].join('\n');

const EXPECTED_CHECK_IDS = [
  'nav-rows',
  'role-Super Admin', 'role-Operations Admin', 'role-Trainer',
  'tool-count-once', 'tool-count-derived',
  ...RETIRED_KNOWLEDGE_TERMS.map((t) => `retired-${t}`),
  'tools-documented', 'no-ghost-tools',
  'no-template-vars', 'no-email', 'no-caller-identity',
  'prices-from-catalog', 'plans-exist', 'screens-documented',
  'fingerprint-present', 'fingerprint-matches',
];

/** Run the invariants on a body, fingerprinted AFTER the edit (so only the edit fails). */
const run = (body = BASE_BODY, overrides = {}, { embed = true } = {}) =>
  knowledgeInvariants({ ...BASE_INPUTS, ...overrides, doc: embed ? embedFingerprint(body) : body });
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.id).sort();
const messageOf = (results, id) => (results.find((r) => r.id === id) || {}).message || '';
const expectOnly = (results, ...ids) => assert.deepEqual(failed(results), [...ids].sort());
const edit = (from, to, body = BASE_BODY) => {
  assert.ok(body.includes(from), `fixture edit anchor missing: ${from}`);
  return body.replace(from, to);
};

test('invariants: the base fixture runs EVERY check and passes all of them', () => {
  const results = run();
  // Pins the check set, so a dropped invariant turns this red rather than passing quietly.
  assert.deepEqual(results.map((r) => r.id).sort(), [...EXPECTED_CHECK_IDS].sort());
  assert.deepEqual(failed(results), [], knowledgeInvariantFailures(results).join('\n'));
  for (const r of results) assert.equal(typeof r.message, 'string');
});

test('invariants: a CRLF working-tree copy of the fixture passes too', () => {
  assert.deepEqual(failed(knowledgeInvariants({ ...BASE_INPUTS, doc: toCrlf(embedFingerprint(BASE_BODY)) })), []);
});

test('invariants: the retired list still names what the stale live copy shipped', () => {
  for (const term of ['Budgeting Tool', 'Forecasting Tool', 'core_self_paced', 'gold_live', 'Discord', 'Thinkific']) {
    assert.ok(RETIRED_KNOWLEDGE_TERMS.includes(term), term);
  }
  assert.ok(Object.isFrozen(RETIRED_KNOWLEDGE_TERMS));
});

// ── nav-rows ────────────────────────────────────────────────────────────────

test('nav-rows: a route with no row fails', () => {
  const results = run(edit('| Chart of Accounts | `coa` | `/chart-of-accounts` | Builds a chart. |\n', ''));
  expectOnly(results, 'nav-rows');
  assert.match(messageOf(results, 'nav-rows'), /no navigation row: coa/);
});

test('nav-rows: a mention elsewhere is not a row', () => {
  // The old check accepted `id` in backticks anywhere, and most tab ids also appear
  // in the FAQ and course sections.
  const body = edit(
    '| Bank Feed AI | `bankfeed` | `/bank-feed-ai` | Suggests a category. |\n',
    '',
    edit('- Navigate with `navigate_to_tool`.', '- Navigate with `navigate_to_tool`, e.g. to `bankfeed`.'),
  );
  expectOnly(run(body), 'nav-rows');
});

test('nav-rows: a row for a tab that is not a route fails', () => {
  const results = run(edit('| Team & Roles |', '| Budgets | `budgeting` | `/budgeting` | Gone. |\n| Team & Roles |'));
  expectOnly(results, 'nav-rows');
  assert.match(messageOf(results, 'nav-rows'), /not routes: budgeting/);
});

test('nav-rows: a duplicated row fails', () => {
  const row = '| Bank Feed AI | `bankfeed` | `/bank-feed-ai` | Suggests a category. |\n';
  const results = run(edit(row, row + row));
  expectOnly(results, 'nav-rows');
  assert.match(messageOf(results, 'nav-rows'), /more than one navigation row: bankfeed/);
});

test('nav-rows: an alias needs no row only when it is declared as one', () => {
  const results = run(BASE_BODY, { aliasTabIds: [] });
  expectOnly(results, 'nav-rows');
  assert.match(messageOf(results, 'nav-rows'), /mockinterview/);
});

// ── role-* ──────────────────────────────────────────────────────────────────

for (const label of BASE_INPUTS.roleLabels) {
  test(`role-${label}: a roles section that does not name it fails`, () => {
    const results = run(edit(`**${label}**`, '**Someone else**'));
    expectOnly(results, `role-${label}`);
    assert.match(messageOf(results, `role-${label}`), /never names/);
  });
}

test('role-*: roles named only in a navigation row do not count (the 2026-09-16 defect)', () => {
  // The real document's roles section describes one "Admin"; the three role names
  // appear only in the Team & Roles and Financial Management rows. Whole-document
  // counting passed it.
  let body = edit(
    '- **Super Admin**: every staff screen — Enrollments and Team & Roles.\n- **Operations Admin**: Enrollments.\n- **Trainer**: no staff screens; edits the courses assigned to them.\n',
    '- **Admin**: Enrollments and Team & Roles.\n',
  );
  body = edit('| Manages staff. |', '| Assign the Super Admin, Operations Admin and Trainer roles. |', body);
  expectOnly(run(body), 'role-Super Admin', 'role-Operations Admin', 'role-Trainer');
});

test('role-*: a document with no roles section fails every role and the screens check', () => {
  const start = BASE_BODY.indexOf('## 2. User roles');
  const end = BASE_BODY.indexOf('## 3. Navigation map');
  const results = run(BASE_BODY.slice(0, start) + BASE_BODY.slice(end));
  expectOnly(results, 'role-Super Admin', 'role-Operations Admin', 'role-Trainer', 'screens-documented');
  assert.match(messageOf(results, 'role-Trainer'), /no "User roles" section/);
});

test('role-*: a role described in two bullets fails', () => {
  const results = run(edit('- **Trainer**:', '- **Trainer**: also edits covers.\n- **Trainer**:'));
  expectOnly(results, 'role-Trainer');
  assert.match(messageOf(results, 'role-Trainer'), /2 bullets/);
});

test("role-*: a mention inside another role's bullet is not a description", () => {
  // `bulletHeads <= 1` could not tell ZERO bullets from one, so a roles section
  // that described a single "Admin" and merely said "…unlike a Trainer" inside
  // that bullet passed role-Trainer: the same "named somewhere, never described"
  // hole the section scoping closed at the navigation table, one level in.
  const body = edit(
    '- **Operations Admin**: Enrollments.\n- **Trainer**: no staff screens; edits the courses assigned to them.\n',
    '- **Operations Admin**: Enrollments — unlike a Trainer, who gets no staff screens.\n',
  );
  const results = run(body);
  expectOnly(results, 'role-Trainer');
  assert.match(messageOf(results, 'role-Trainer'), /only inside another role's description/);
});

test('role-*: naming another role inside a bullet is not a second description', () => {
  expectOnly(run(edit('- **Operations Admin**: Enrollments.', '- **Operations Admin**: Enrollments (the finance screens stay with the Super Admin and no Trainer).')));
});

// ── tool-count-once / tool-count-derived ────────────────────────────────────

test('tool-count-once: a document that never states the count fails', () => {
  const results = run(edit('**2 tools**', 'a set of tools'));
  expectOnly(results, 'tool-count-once');
  assert.ok(!results.some((r) => r.id === 'tool-count-derived'), 'no claim, nothing to derive');
});

test('tool-count-once: a second claim fails, bold or not', () => {
  expectOnly(run(edit('- Navigate with', '- An older copy said 32 tools.\n- Navigate with')), 'tool-count-once');
  expectOnly(run(edit('- Navigate with', '- Also **2 tools** here.\n- Navigate with')), 'tool-count-once');
  // A hyphenated "1-on-1 tools" is not a claim.
  expectOnly(run(edit('- Navigate with', '- Book 1-on-1 tools with Alex.\n- Navigate with')));
});

test('tool-count-derived: a claim that disagrees with NON_TOOL_TAB_IDS fails', () => {
  const results = run(edit('**2 tools**', '**3 tools**'));
  expectOnly(results, 'tool-count-derived');
  assert.match(messageOf(results, 'tool-count-derived'), /claims 3 tools .* derives 2/);
  assert.ok(!run(BASE_BODY, { toolCount: null }).some((r) => r.id === 'tool-count-derived'));
});

// ── retired-* ───────────────────────────────────────────────────────────────

for (const term of RETIRED_KNOWLEDGE_TERMS) {
  test(`retired-${term}: the term fails when it creeps back`, () => {
    expectOnly(run(edit('## 5. Courses\n', `## 5. Courses\n\n- ${term} is back.\n`)), `retired-${term}`);
  });
}

test('retired-Thinkific: the migration sentence is true; any other use still fails', () => {
  const add = (line) => run(edit('| Manages staff. |', `| Manages staff. ${line} |`));
  expectOnly(add('Imports migrate legacy Thinkific students.'));
  expectOnly(add('Courses are hosted on Thinkific.'), 'retired-Thinkific');
  expectOnly(add('Migrate legacy Thinkific students, then log in to Thinkific.'), 'retired-Thinkific');
  // The carve-out is exactly one literal phrase — loosening it must be deliberate.
  assert.deepEqual(RETIRED_TERM_HISTORICAL_USES, { Thinkific: ['legacy Thinkific'] });
  assert.ok(Object.isFrozen(RETIRED_TERM_HISTORICAL_USES));
  assert.ok(Object.isFrozen(RETIRED_TERM_HISTORICAL_USES.Thinkific));
});

// ── tools-documented / no-ghost-tools ───────────────────────────────────────

test('tools-documented: a declared tool the document never names fails', () => {
  const results = run(BASE_BODY, { toolNames: [...BASE_INPUTS.toolNames, 'show_lesson_sources'] });
  expectOnly(results, 'tools-documented');
  assert.match(messageOf(results, 'tools-documented'), /show_lesson_sources/);
});

test('tools-documented: a longer identifier does not document the tool', () => {
  expectOnly(run(edit('- Navigate with `navigate_to_tool`.', '- Navigate with navigate_to_tools.')), 'tools-documented');
});

test('no-ghost-tools: an identifier that is not a tool, plan or tab fails', () => {
  const results = run(edit('## 5. Courses\n', '## 5. Courses\n\n- Approve with `approve_payment`.\n'));
  expectOnly(results, 'no-ghost-tools');
  assert.match(messageOf(results, 'no-ghost-tools'), /approve_payment/);
});

test('no-ghost-tools: five underscores is still an identifier', () => {
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- Call `get_every_single_student_payment_record`.\n')), 'no-ghost-tools');
});

test('no-ghost-tools: knownIdentifiers admits show_feature_help keys and parameter names', () => {
  const body = edit('## 5. Courses\n', '## 5. Courses\n\n- Help for `bank_feed_ai`; pass `course_id`.\n');
  expectOnly(run(body), 'no-ghost-tools');
  expectOnly(run(body, { knownIdentifiers: ['bank_feed_ai', 'course_id'] }));
});

test('no-ghost-tools: a data field the document explains in prose needs knownIdentifiers', () => {
  // The real 2026-09-16 document says "plan `access_days` (60 or 180 days)" — an
  // accurate sentence about a real column, and not a tool the agent could call.
  // The check is right to notice a backticked identifier it was not told about;
  // the resolution is the caller declaring it, not deleting the sentence.
  const body = edit('## 5. Courses\n', '## 5. Courses\n\n- A term lasts the plan\'s `access_days`.\n');
  expectOnly(run(body), 'no-ghost-tools');
  expectOnly(run(body, { knownIdentifiers: ['access_days'] }));
});

// ── per-caller facts ────────────────────────────────────────────────────────

test('no-template-vars: a {{dynamic_variable}} fails', () => {
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- Hello {{ greeting }}.\n')), 'no-template-vars');
});

test('no-template-vars: any {{…}} placeholder fails, not only a bare identifier', () => {
  // `\{\{\s*\w+\s*\}\}` caught `{{greeting}}` and missed every shape a placeholder
  // actually arrives in when it is pasted out of a prompt: a dotted or hyphenated
  // path, ElevenLabs' own `system__` family, and anything carrying a filter or a
  // default. None of these names a per-caller VARIABLE the sibling check knows, so
  // each one used to reach the shared knowledge base unremarked.
  for (const v of [
    '{{greeting}}', '{{ user.name }}', '{{ plan-label }}', '{{system__caller_id}}',
    '{{ first_name | default: "there" }}', '{{}}',
  ]) {
    expectOnly(run(edit('## 5. Courses\n', `## 5. Courses\n\n- Hello ${v}.\n`)), 'no-template-vars');
  }
  const results = run(edit('## 5. Courses\n', '## 5. Courses\n\n- Hello {{ user.name }}.\n'));
  assert.match(messageOf(results, 'no-template-vars'), /\{\{ user\.name \}\}/, 'the message names the offender');
  // A single brace is not a placeholder: the document may show a JSON shape.
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- A result looks like {"ok": true}, a set like { a, b }.\n')));
});

test('no-email: an address fails; an @mention does not', () => {
  for (const address of ['help.desk@example.com', 'a@b.co', 'alex+tag@sub.domain.example.com']) {
    expectOnly(run(edit('## 5. Courses\n', `## 5. Courses\n\n- Write to ${address}.\n`)), 'no-email');
  }
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- Reply with @mentions and reactions.\n')));
});

test('no-email: a package@version is not an address (the digits-in-the-TLD false positive)', () => {
  // `[\w.]+` after the dot accepted digits, so every one of these — all named in
  // this project's own docs — was reported as an email address, with no carve-out
  // and no fix except deleting a true sentence.
  for (const spec of ['tus-js-client@4.1.0', 'node@24.19.0', '@elevenlabs/client@1.2.3', 'jspdf@2.5.1']) {
    expectOnly(run(edit('## 5. Courses\n', `## 5. Courses\n\n- Built on ${spec}.\n`)));
  }
});

test('no-caller-identity: every per-caller variable name fails, secret__* included', () => {
  for (const name of [...PER_CALLER_VARIABLE_NAMES, 'secret__trainer_token']) {
    const results = run(edit('## 5. Courses\n', `## 5. Courses\n\n- The ${name} variable.\n`));
    expectOnly(results, 'no-caller-identity');
  }
  assert.ok(Object.isFrozen(PER_CALLER_VARIABLE_NAMES));
});

test('no-caller-identity: the list covers every variable VoiceAssistant sends', () => {
  // Subset parity with the real dynamicVariables object (structure, not a count):
  // a variable added there and not here would be invisible to this check.
  const block = /dynamicVariables:\s*\{([\s\S]*?)\n\s*\},/.exec(app());
  assert.ok(block, 'dynamicVariables object not found in src/BookkeeperPro.jsx');
  const keys = [...block[1].matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    if (key.startsWith('secret__')) continue;
    assert.ok(PER_CALLER_VARIABLE_NAMES.includes(key), `dynamic variable "${key}" is missing from PER_CALLER_VARIABLE_NAMES`);
  }
});

// ── prices-from-catalog / plans-exist ───────────────────────────────────────

test('prices-from-catalog: a figure the catalog does not produce fails', () => {
  const results = run(edit('₱2,999 | 60 days |', '₱2,999 (was ₱1,999) | 60 days |'));
  expectOnly(results, 'prices-from-catalog');
  assert.match(messageOf(results, 'prices-from-catalog'), /₱1,999/);
});

test('prices-from-catalog: punctuation after a price is not part of it', () => {
  // "₱1,499," used to be read as a stray price of its own.
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- Pay ₱1,499, ₱2,999, or ₱1,499.\n')));
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- All prices are in pesos (₱); its ₱ price is fixed.\n')));
});

test('prices-from-catalog: a spaced or decimal figure is still read', () => {
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- Was ₱ 9,999.\n')), 'prices-from-catalog');
  expectOnly(run(edit('## 5. Courses\n', '## 5. Courses\n\n- Costs ₱1,499.50.\n')), 'prices-from-catalog');
});

test('plans-exist: a retired snake_case plan key fails', () => {
  const results = run(edit('## 5. Courses\n', '## 5. Courses\n\n- The `core_self_paced` plan.\n'));
  assert.ok(failed(results).includes('plans-exist'));
  assert.match(messageOf(results, 'plans-exist'), /core_self_paced/);
});

test('plans-exist: a declared-known identifier is not a bogus plan key', () => {
  // The prose net filters on a SUBSTRING of plan/paced/vip/sampler, which is the
  // shape of every legitimate identifier around a membership catalog. Each of
  // these was reported as "plan key(s) that are not in the catalog" — the wrong
  // problem, and unresolvable, because knownIdentifiers silenced the sibling
  // no-ghost-tools check and was ignored by this one.
  for (const name of ['enrollment_plans', 'plan_key', 'vip_batch_id', 'sampler_tier', 'get_my_plan_summary']) {
    const body = edit('## 5. Courses\n', `## 5. Courses\n\n- See \`${name}\`.\n`);
    assert.ok(failed(run(body)).includes('plans-exist'), `${name} — undeclared, so still flagged`);
    expectOnly(run(body, { knownIdentifiers: [name] }));
  }
});

test('plans-exist: the STRUCTURAL net is unconditional — knownIdentifiers cannot excuse a priced row', () => {
  // A key sitting in a ₱-bearing plan row is a claim about what is for sale.
  const body = edit('| QBO + Resume Combo |', '| Platinum Track | `platinum_plan` | ₱2,999 | 90 days |\n| QBO + Resume Combo |');
  expectOnly(run(body, { knownIdentifiers: ['platinum_plan'] }), 'plans-exist');
  assert.match(messageOf(run(body, { knownIdentifiers: ['platinum_plan'] }), 'plans-exist'), /platinum_plan/);
});

test('plans-exist: a plan-table row is a plan whatever its key looks like', () => {
  // The name-shaped heuristic alone let both of these straight through.
  const row = (key) => edit(
    '| QBO + Resume Combo |',
    `| Platinum Track | \`${key}\` | ₱2,999 | 90 days |\n| QBO + Resume Combo |`,
  );
  const platinum = run(row('platinum'));
  expectOnly(platinum, 'plans-exist');
  assert.match(messageOf(platinum, 'plans-exist'), /platinum/);
  assert.ok(failed(run(row('gold_live'))).includes('plans-exist'));
});

// ── screens-documented ──────────────────────────────────────────────────────

test('screens-documented: a staff screen the roles section never names fails', () => {
  // The navigation row for Team & Roles is still there: the whole-document check this
  // replaced passed this, which is how the stale "two admin screens" prose survived.
  const results = run(edit('Enrollments and Team & Roles.', 'Enrollments.'));
  expectOnly(results, 'screens-documented');
  assert.match(messageOf(results, 'screens-documented'), /Team & Roles/);
  expectOnly(run(BASE_BODY, { adminScreenLabels: [...BASE_INPUTS.adminScreenLabels, 'Batches'] }), 'screens-documented');
});

// ── fingerprint-present / fingerprint-matches ───────────────────────────────

test('fingerprint-present: a document with no fingerprint fails', () => {
  const results = run(BASE_BODY, {}, { embed: false });
  expectOnly(results, 'fingerprint-present');
  assert.ok(!results.some((r) => r.id === 'fingerprint-matches'), 'nothing embedded, nothing to match');
});

test('fingerprint-present: two fingerprints fail', () => {
  const once = embedFingerprint(BASE_BODY);
  const twice = once.replace(' -->', ` · Fingerprint: ${readKnowledgeFingerprint(once)} -->`);
  const results = knowledgeInvariants({ ...BASE_INPUTS, doc: twice });
  expectOnly(results, 'fingerprint-present');
  assert.match(messageOf(results, 'fingerprint-present'), /2 fingerprints/);
});

test('fingerprint-matches: a wrong or stale fingerprint fails', () => {
  const doc = embedFingerprint(BASE_BODY);
  const wrong = doc.replace(/kb1-[0-9a-f]{16}/, 'kb1-0000000000000000');
  expectOnly(knowledgeInvariants({ ...BASE_INPUTS, doc: wrong }), 'fingerprint-matches');
  // The realistic case: a hand edit after generation.
  const handEdited = doc.replace('Suggests a category.', 'Suggests a QuickBooks category.');
  expectOnly(knowledgeInvariants({ ...BASE_INPUTS, doc: handEdited }), 'fingerprint-matches');
});

// ── knowledgeInvariantFailures ──────────────────────────────────────────────

test('knowledgeInvariantFailures: formats failures only, in order', () => {
  assert.deepEqual(knowledgeInvariantFailures(run()), []);
  assert.deepEqual(knowledgeInvariantFailures(null), []);
  assert.deepEqual(knowledgeInvariantFailures(undefined), []);
  assert.deepEqual(knowledgeInvariantFailures([
    { id: 'a', ok: true, message: 'ignored' },
    { id: 'b', ok: false, message: 'first' },
    { id: 'c', ok: false, message: 'second' },
  ]), ['  - [b] first', '  - [c] second']);
  const lines = knowledgeInvariantFailures(run(BASE_BODY, {}, { embed: false }));
  assert.deepEqual(lines, ['  - [fingerprint-present] the document carries no fingerprint']);
});
