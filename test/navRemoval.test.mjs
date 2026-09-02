// test/navRemoval.test.mjs — the three retired tools are GONE from the active app (#56).
//
// Niche Selector Quiz (`niche`), Budgeting Tool (`budgeting`) and Forecasting Tool
// (`forecasting`) were removed. "Removed" means not routed, not rendered, not advertised
// to the voice agent, not counted, and not shipped — not merely hidden from the sidebar.
//
// ★ WHY A SOURCE SCAN AND NOT A RENDER TEST. There is no jsdom or RTL in this repo, and
//   BookkeeperPro.jsx cannot be imported by node --test. What CAN be pinned is that no
//   ACTIVE REGISTRY still names these ids — which is exactly the failure mode that leaves
//   a dead tab reachable: a leftover VOICE_TOOL_ALIASES entry sends the voice agent to a
//   tab setTab() will silently refuse, and a leftover TAB_ROUTES entry mounts a keep-alive
//   panel for a component that no longer exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/BookkeeperPro.jsx');

const RETIRED = ['niche', 'budgeting', 'forecasting'];

/**
 * The balanced-bracket literal extractor, same idea as
 * scripts/generate-voice-agent-knowledge.mjs: find `const NAME = ` and take the object
 * that follows. Good enough for these pure literals, and it fails loudly if one moves.
 */
function literalOf(name) {
  const at = APP.indexOf(`const ${name} = `);
  assert.notEqual(at, -1, `${name} not found — did it move or get renamed?`);
  const open = APP.indexOf('{', at);
  assert.notEqual(open, -1, `${name} is not an object literal`);
  let depth = 0;
  for (let i = open; i < APP.length; i += 1) {
    if (APP[i] === '{') depth += 1;
    else if (APP[i] === '}') {
      depth -= 1;
      if (depth === 0) return APP.slice(open, i + 1);
    }
  }
  throw new Error(`${name}: unbalanced braces`);
}

for (const name of ['TAB_ROUTES', 'VOICE_TAB_INFO', 'VOICE_TOOL_ALIASES', 'VOICE_FEATURE_HELP']) {
  test(`${name} names none of the retired tools`, () => {
    const lit = literalOf(name);
    for (const id of RETIRED) {
      // ★ Built with an explicit escape, NOT in a template literal. `\b` inside a template
      //   literal is U+0008 (BACKSPACE), so the original form compiled to /\x08niche\x08/
      //   and could never match — four registry scans that always passed. Line 94 below
      //   already used the safe `'${id}'` form; this one had drifted.
      const whole = new RegExp('\\b' + id + '\\b');
      assert.ok(!whole.test(lit),
        `${name} still names "${id}" — it was retired in #56`);
    }
  });
}

test('VOICE_FEATURE_HELP has no niche_selector_quiz key, and no spec advertises one', () => {
  assert.ok(!literalOf('VOICE_FEATURE_HELP').includes('niche_selector_quiz'));
  // The feature_id parameter description is pushed verbatim to the live ElevenLabs agent
  // by scripts/provision-voice-agent.mjs, so a stale example is not merely cosmetic.
  assert.ok(!APP.includes('niche_selector_quiz'),
    'no voice tool spec may still offer niche_selector_quiz as an example');
});

test('renderToolContent has no case for a retired tab', () => {
  for (const id of RETIRED) {
    assert.ok(!APP.includes(`case '${id}':`),
      `renderToolContent still has a case for "${id}"`);
  }
});

test('the retired components and their orphaned constants are gone', () => {
  for (const sym of [
    'NicheSelectorQuiz', 'NicheSelectorQuizInner', 'BudgetingTool', 'ForecastingTool',
    'BUDGET_CATEGORIES', 'FORECAST_DEFAULTS', 'loadNicheData',
  ]) {
    assert.ok(!APP.includes(sym), `${sym} is still in the bundle`);
  }
});

test('src/data/niche.js is deleted, and nothing imports it', () => {
  assert.equal(existsSync(join(REPO, 'src/data/niche.js')), false,
    'the lazy niche data chunk must not ship');
  assert.ok(!APP.includes('data/niche'));
});

test('DEFAULT_STAGES lists no retired tab, and no group still references one', () => {
  const at = APP.indexOf('const DEFAULT_STAGES');
  assert.notEqual(at, -1);
  const end = APP.indexOf('\n  ];', at);
  assert.notEqual(end, -1, 'DEFAULT_STAGES terminator not found');
  const block = APP.slice(at, end);
  for (const id of RETIRED) {
    assert.ok(!new RegExp(`'${id}'`).test(block),
      `DEFAULT_STAGES still references "${id}" (a tab entry or a group tabIds list)`);
  }
});

test('the derived tool count excludes the retired tools and matches TAB_ROUTES', () => {
  // TOOL_COUNT is derived, so it self-heals — this pins that it is still DERIVED and that
  // nobody replaced it with a literal when the number changed.
  assert.ok(APP.includes('const TOOL_COUNT = Object.keys(TAB_ROUTES)'),
    'TOOL_COUNT must stay derived from TAB_ROUTES, never a hardcoded number');
  const routes = literalOf('TAB_ROUTES');
  const ids = [...routes.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  assert.ok(ids.length > 20, 'TAB_ROUTES failed to parse');
  for (const id of RETIRED) assert.ok(!ids.includes(id));
});

test('the generated voice knowledge advertises none of them', () => {
  const kb = read('docs/ai/toolkits-voice-agent-knowledge.md').toLowerCase();
  for (const word of ['niche selector', '/niche-selector-quiz', '/budgeting', '/forecasting']) {
    assert.ok(!kb.includes(word),
      `the generated knowledge doc still mentions "${word}" — re-run npm run ai:knowledge`);
  }
});

test('the hand-authored FAQ template no longer recommends a retired tool', () => {
  // Nothing else catches this: the generator's parity guard only compares TAB_ROUTES
  // against VOICE_TAB_INFO, and this sentence is free prose in the template.
  const gen = read('scripts/generate-voice-agent-knowledge.mjs');
  assert.ok(!/Niche Selector/i.test(gen));
});

test('the legacy-storage inventory no longer carries the retired tools keys', () => {
  const auth = read('src/auth/AuthProvider.jsx');
  for (const key of ['budget:state', 'forecast:state']) {
    assert.ok(!auth.includes(key),
      `${key} is still in LEGACY_KEYS, but nothing writes it any more`);
  }
});

test('an unknown route is normalized instead of left in the address bar', () => {
  // Without this, /budgeting kept claiming to be the Budgeting Tool while the Dashboard
  // rendered underneath it.
  assert.ok(APP.includes('function normalizeUnknownRoute()'),
    'normalizeUnknownRoute() is what corrects a retired tool URL');
  assert.ok(APP.includes('if (path === STAFF_INVITE_PATH) return false;'),
    '/staff/invitation is NOT in TAB_ROUTES and must be exempt — normalizing it away '
    + 'strands a new staff member mid-acceptance');
});
