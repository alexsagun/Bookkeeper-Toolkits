// test/voiceProvisioning.test.mjs — Toolkits Siri's provisioning PLANNER.
//
// src/lib/voiceProvisioning.js decides everything scripts/provision-voice-agent.mjs
// does to a live, paid, customer-facing ElevenLabs agent. Before it existed nothing
// imported that script, so nothing tested it, and it had already done — or was one
// run away from doing — each of the following:
//
//   1. Warned on a missing APP_URL and carried on, so the agent PATCH replaced
//      `tool_ids` with the client-only list and silently DETACHED the trainer.
//   2. PATCHed any tool in the whole account whose name matched — including one
//      that belongs to a different agent.
//   3. Deleted every same-name knowledge document unconditionally, including one
//      another agent still references.
//   4. Patched the agent with whatever SUBSET of tools had succeeded.
//
// Two further defects were found while writing this suite, and both were
// fail-OPEN in the same way: a dependents lookup that returned nothing usable was
// read as "no dependents" — i.e. as permission to PATCH a tool, or DELETE a
// document, that may belong to another agent. "Unknown" is pinned separately from
// "another agent" everywhere below, because they are separate failure modes.
//
// Pure: no network, no fs writes, no env. The one fs read is the monolith, so the
// manifest is also checked against the REAL spec literals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_CONVERSATION_SECS,
  TOOL_TIMEOUT_SECS,
  captureRollbackState,
  managedToolManifest,
  nextKnowledgeBase,
  nextToolIds,
  planKnowledgeOps,
  planKnowledgeReconciliation,
  planRollback,
  planToolReconciliation,
  redactRollbackState,
  validateToolSpecs,
  verifyApplied,
  voicePreflight,
} from '../src/lib/voiceProvisioning.js';
import { extractPureLiteral } from '../src/lib/voiceKnowledge.js';
import { VOICE_ASSISTANT_SHORT_NAME } from '../src/lib/voiceAccess.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SELF = 'agent_self';
const OTHER = 'agent_other';
const BASE = 'https://app.example';
const BEARER = 'Bearer {{secret__trainer_token}}';

const clientSpecs = () => [
  { name: 'navigate_to_tool', description: 'Navigate', parameters: { type: 'object', properties: { tool: { type: 'string' } } } },
  { name: 'open_account_panel', description: 'Panel', parameters: { type: 'object', properties: {} }, expects_response: false },
];
const serverSpecs = () => [
  { name: 'get_my_training_catalog', description: 'Catalog', action: 'get_my_training_catalog', request_body_schema: { type: 'object', properties: {} } },
  { name: 'save_training_checkpoint', description: 'Save', action: 'save_training_checkpoint', request_body_schema: { type: 'object', properties: { note: { type: 'string' } } }, response_timeout_secs: 45 },
];
const CLIENT_NAMES = ['navigate_to_tool', 'open_account_panel'];
const SERVER_NAMES = ['get_my_training_catalog', 'save_training_checkpoint'];

const fullManifest = () => managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs(), webhookBase: BASE });

const codes = (r) => r.blockers.map((b) => b.code);

/** A preflight input that passes every check. Each blocker test breaks ONE field. */
const green = (over = {}) => ({
  dryRun: false,
  clientOnly: false,
  apiKey: 'fake-api-key-for-tests',
  agentId: SELF,
  appUrl: BASE,
  trainerSecret: 'fake-trainer-secret-for-tests',
  knowledgeDocExists: true,
  knowledgeDrift: false,
  knowledgeInvariantFailures: [],
  systemPrompt: `You are ${VOICE_ASSISTANT_SHORT_NAME}, the voice guide.`,
  firstMessage: 'Hi {{user_name}}, how can I help?',
  promptSentinel: VOICE_ASSISTANT_SHORT_NAME,
  clientSpecs: clientSpecs(),
  serverSpecs: serverSpecs(),
  trainerHealth: { ok: true, configured: true },
  agentReadable: true,
  agentWebhookToolCount: 4,
  voiceIdOverride: 'voice_override',
  llmOverride: 'llm_override',
  ...over,
});

function assertOnlyBlocker(over, code) {
  const r = voicePreflight(green(over));
  assert.equal(r.ok, false, `expected ${code} to block`);
  assert.deepEqual(codes(r), [code]);
  for (const b of r.blockers) {
    assert.equal(typeof b.message, 'string');
    assert.ok(b.message.length > 0);
    assert.equal(typeof b.fix, 'string');
    assert.ok(b.fix.length > 0, `${code} must say how to fix it`);
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// managedToolManifest
// ─────────────────────────────────────────────────────────────────────────────

test('manifest: client-only when no webhook base is given', () => {
  const m = managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs() });
  assert.deepEqual(m.names, CLIENT_NAMES);
  assert.equal(m.includesWebhooks, false);
  assert.ok(m.entries.every((e) => e.kind === 'client' && e.config.type === 'client'));
  assert.equal(m.byName.size, 2);
  assert.equal(m.byName.has('get_my_training_catalog'), false);
});

test('manifest: a base that is only slashes or empty plans no webhooks', () => {
  for (const webhookBase of ['', null, undefined, '/', '///']) {
    const m = managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs(), webhookBase });
    assert.deepEqual(m.names, CLIENT_NAMES, `base ${JSON.stringify(webhookBase)}`);
    assert.equal(m.includesWebhooks, false);
  }
});

test('manifest: client tool body', () => {
  const m = managedToolManifest({ clientSpecs: clientSpecs(), toolTimeoutSecs: 7 });
  const nav = m.byName.get('navigate_to_tool').config;
  assert.deepEqual(nav, {
    type: 'client',
    name: 'navigate_to_tool',
    description: 'Navigate',
    expects_response: true,
    response_timeout_secs: 7,
    parameters: { type: 'object', properties: { tool: { type: 'string' } } },
  });
  assert.equal(m.byName.get('open_account_panel').config.expects_response, false);
  assert.equal(managedToolManifest({ clientSpecs: clientSpecs() }).entries[0].config.response_timeout_secs, TOOL_TIMEOUT_SECS);
});

test('manifest: webhook url is base + /api/elevenlabs/trainer?action=<action>', () => {
  const m = fullManifest();
  for (const spec of serverSpecs()) {
    const cfg = m.byName.get(spec.name).config;
    assert.equal(cfg.type, 'webhook');
    assert.equal(cfg.api_schema.url, `${BASE}/api/elevenlabs/trainer?action=${spec.action}`);
    assert.equal(cfg.api_schema.method, 'POST');
    assert.deepEqual(cfg.api_schema.request_body_schema, spec.request_body_schema);
  }
  const odd = managedToolManifest({
    clientSpecs: clientSpecs(),
    serverSpecs: [{ name: 'x', action: 'a b&c', request_body_schema: {} }],
    webhookBase: BASE,
  });
  assert.equal(odd.byName.get('x').config.api_schema.url, `${BASE}/api/elevenlabs/trainer?action=a%20b%26c`);
});

test('manifest: trailing slashes on the base are stripped', () => {
  for (const webhookBase of [`${BASE}/`, `${BASE}///`, ` ${BASE}/ `]) {
    const m = managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs(), webhookBase });
    assert.equal(m.byName.get('get_my_training_catalog').config.api_schema.url,
      `${BASE}/api/elevenlabs/trainer?action=get_my_training_catalog`);
  }
});

test('manifest: webhook Authorization header is the secret dynamic variable, never a value', () => {
  const cfg = fullManifest().byName.get('get_my_training_catalog').config;
  assert.equal(cfg.api_schema.request_headers.Authorization, BEARER);
  assert.equal(cfg.api_schema.request_headers['Content-Type'], 'application/json');
  assert.deepEqual(cfg.dynamic_variables, { dynamic_variable_placeholders: { secret__trainer_token: '' } });
});

test('manifest: webhook timeout honours a per-spec override', () => {
  const m = fullManifest();
  assert.equal(m.byName.get('save_training_checkpoint').config.response_timeout_secs, 45);
  assert.equal(m.byName.get('get_my_training_catalog').config.response_timeout_secs, TOOL_TIMEOUT_SECS);
});

test('manifest: client names come before server names; includesWebhooks', () => {
  const m = fullManifest();
  assert.deepEqual(m.names, [...CLIENT_NAMES, ...SERVER_NAMES]);
  assert.deepEqual(m.entries.map((e) => e.kind), ['client', 'client', 'webhook', 'webhook']);
  assert.equal(m.includesWebhooks, true);
  assert.equal(managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: [], webhookBase: BASE }).includesWebhooks, false);
});

test('manifest: clientOnly overrides a resolved webhook base', () => {
  // The shell resolves the base from APP_URL and the flag separately; passing the
  // flag without clearing the base must not still attach the trainer tools, which
  // is precisely what --client-only waives the preflight blockers FOR.
  const m = managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs(), webhookBase: BASE, clientOnly: true });
  assert.deepEqual(m.names, CLIENT_NAMES);
  assert.equal(m.includesWebhooks, false);
  assert.equal(m.byName.has('get_my_training_catalog'), false);
  // …and a falsy flag is the ordinary path, not a second way to opt out.
  for (const clientOnly of [false, undefined, null, 0, '']) {
    assert.deepEqual(managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs(), webhookBase: BASE, clientOnly }).names,
      [...CLIENT_NAMES, ...SERVER_NAMES], `clientOnly ${JSON.stringify(clientOnly)}`);
  }
});

test('manifest: includesWebhooks is DERIVED from the entries planned, not from serverSpecs.length', () => {
  // A spec array of unusable entries plans no webhook tools. Reporting that it did
  // would tell the shell a trainer is configured when nothing points at one.
  const m = managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: [null, undefined], webhookBase: BASE });
  assert.deepEqual(m.names, CLIENT_NAMES);
  assert.equal(m.includesWebhooks, false);
});

test('manifest: the REAL monolith specs validate and yield 7 client + 4 webhook tools', () => {
  const src = readFileSync(new URL('../src/BookkeeperPro.jsx', import.meta.url), 'utf8');
  const realClient = extractPureLiteral(src, 'VOICE_CLIENT_TOOL_SPECS');
  const realServer = extractPureLiteral(src, 'VOICE_SERVER_TOOL_SPECS');
  assert.deepEqual(validateToolSpecs({ clientSpecs: realClient, serverSpecs: realServer }), []);
  const m = managedToolManifest({ clientSpecs: realClient, serverSpecs: realServer, webhookBase: BASE });
  assert.equal(m.names.length, 11);
  assert.equal(m.entries.filter((e) => e.kind === 'client').length, 7);
  assert.equal(m.entries.filter((e) => e.kind === 'webhook').length, 4);
  assert.ok(m.names.includes('open_course_lesson'));
  assert.ok(m.names.includes('show_lesson_sources'));
});

// ─────────────────────────────────────────────────────────────────────────────
// validateToolSpecs
// ─────────────────────────────────────────────────────────────────────────────

test('validateToolSpecs: valid specs have no problems', () => {
  assert.deepEqual(validateToolSpecs({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs() }), []);
  assert.deepEqual(validateToolSpecs({ clientSpecs: clientSpecs(), serverSpecs: [] }), []);
});

test('validateToolSpecs: an empty or missing client array', () => {
  for (const c of [[], undefined, null, {}]) {
    const p = validateToolSpecs({ clientSpecs: c, serverSpecs: serverSpecs() });
    assert.ok(p.some((x) => /VOICE_CLIENT_TOOL_SPECS is missing or empty/.test(x)), JSON.stringify(c));
  }
});

test('validateToolSpecs: a client spec with no parameters schema', () => {
  const bad = clientSpecs();
  delete bad[1].parameters;
  assert.deepEqual(validateToolSpecs({ clientSpecs: bad, serverSpecs: [] }), ['Client tool "open_account_panel" has no parameters schema.']);
});

test('validateToolSpecs: a spec with no name', () => {
  const p = validateToolSpecs({ clientSpecs: [...clientSpecs(), { parameters: {} }], serverSpecs: [null] });
  assert.ok(p.includes('A client tool spec has no name.'));
  assert.ok(p.includes('A server tool spec has no name.'));
});

test('validateToolSpecs: a server spec with no action', () => {
  const bad = serverSpecs();
  delete bad[0].action;
  assert.deepEqual(validateToolSpecs({ clientSpecs: clientSpecs(), serverSpecs: bad }), ['Server tool "get_my_training_catalog" has no action.']);
});

test('validateToolSpecs: a server spec with no request_body_schema', () => {
  const bad = serverSpecs();
  delete bad[1].request_body_schema;
  assert.deepEqual(validateToolSpecs({ clientSpecs: clientSpecs(), serverSpecs: bad }), ['Server tool "save_training_checkpoint" has no request_body_schema.']);
});

test('validateToolSpecs: a missing server array', () => {
  assert.ok(validateToolSpecs({ clientSpecs: clientSpecs() }).includes('VOICE_SERVER_TOOL_SPECS is missing.'));
});

test('validateToolSpecs: duplicate names across the two arrays', () => {
  const server = serverSpecs();
  server[0].name = 'navigate_to_tool';
  const p = validateToolSpecs({ clientSpecs: clientSpecs(), serverSpecs: server });
  assert.deepEqual(p, ['Duplicate tool name(s) across the spec arrays: navigate_to_tool.']);
});

// ─────────────────────────────────────────────────────────────────────────────
// voicePreflight
// ─────────────────────────────────────────────────────────────────────────────

test('preflight: a fully green input passes with no blockers and no warnings', () => {
  const r = voicePreflight(green());
  assert.equal(r.ok, true);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.warnings, []);
});

test('preflight: green with no agent id (the create path) needs no readable agent', () => {
  const r = voicePreflight(green({ agentId: '', agentReadable: null, agentWebhookToolCount: null }));
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
});

test('preflight NO_API_KEY — but not under --dry-run', () => {
  assertOnlyBlocker({ apiKey: '' }, 'NO_API_KEY');
  const dry = voicePreflight(green({ apiKey: '', dryRun: true }));
  assert.equal(dry.ok, true);
  assert.ok(!codes(dry).includes('NO_API_KEY'));
});

test('preflight NO_KNOWLEDGE_DOC (and it outranks drift)', () => {
  assertOnlyBlocker({ knowledgeDocExists: false }, 'NO_KNOWLEDGE_DOC');
  assertOnlyBlocker({ knowledgeDocExists: false, knowledgeDrift: true }, 'NO_KNOWLEDGE_DOC');
});

test('preflight KNOWLEDGE_DRIFT — a hand-edited document is never published', () => {
  assertOnlyBlocker({ knowledgeDrift: true }, 'KNOWLEDGE_DRIFT');
});

test('preflight KNOWLEDGE_INVARIANT — strings and result objects', () => {
  const r = assertOnlyBlocker({ knowledgeInvariantFailures: ['  - [nav-rows] missing', '  - [retired] Budgeting'] }, 'KNOWLEDGE_INVARIANT');
  assert.match(r.blockers[0].message, /2 semantic check/);
  assert.match(r.blockers[0].fix, /nav-rows/);
  const o = assertOnlyBlocker({ knowledgeInvariantFailures: [{ id: 'tool-count', ok: false, message: 'claims 32 tools' }] }, 'KNOWLEDGE_INVARIANT');
  assert.match(o.blockers[0].fix, /\[tool-count\] claims 32 tools/);
  assert.doesNotMatch(o.blockers[0].fix, /object Object/);
  assert.equal(voicePreflight(green({ knowledgeInvariantFailures: null })).ok, true);
});

test('preflight BAD_TOOL_SPEC', () => {
  assertOnlyBlocker({ clientSpecs: [] }, 'BAD_TOOL_SPEC');
  const dupServer = serverSpecs();
  dupServer[1].name = 'open_account_panel';
  assertOnlyBlocker({ serverSpecs: dupServer }, 'BAD_TOOL_SPEC');
});

test('preflight NO_SYSTEM_PROMPT', () => {
  assertOnlyBlocker({ systemPrompt: '' }, 'NO_SYSTEM_PROMPT');
});

test('preflight PROMPT_SENTINEL — a prompt that does not name the assistant', () => {
  assertOnlyBlocker({ systemPrompt: 'You are the Toolkits Guide.' }, 'PROMPT_SENTINEL');
});

test('preflight PROMPT_SENTINEL — an EMPTY sentinel is a blocker, not a skipped check', () => {
  assertOnlyBlocker({ promptSentinel: '' }, 'PROMPT_SENTINEL');
});

test('preflight NO_FIRST_MESSAGE', () => {
  assertOnlyBlocker({ firstMessage: '' }, 'NO_FIRST_MESSAGE');
});

test('preflight: a first message without {{user_name}} is a WARNING, not a blocker', () => {
  const r = voicePreflight(green({ firstMessage: 'Hello there!' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.blockers, []);
  assert.ok(r.warnings.some((w) => /\{\{user_name\}\}/.test(w)));
  assert.equal(voicePreflight(green({ firstMessage: 'Hi {{ user_name }}' })).warnings.length, 0);
});

test('preflight NO_APP_URL — fatal, because running without it DETACHES the trainer', () => {
  const r = assertOnlyBlocker({ appUrl: '' }, 'NO_APP_URL');
  assert.match(r.blockers[0].fix, /DETACH/);
});

test('preflight BAD_APP_URL — a scheme-less APP_URL builds relative webhook URLs', () => {
  // …and it must not ALSO report the deployed trainer as unreachable: that code
  // sends the operator to Vercel when the fault is one missing "https://".
  for (const appUrl of ['toolkits.alexsagun.com', '/api', 'ftp://toolkits.example', 'https://', 'https:/toolkits.example', ' ']) {
    const r = assertOnlyBlocker({ appUrl, trainerHealth: null }, 'BAD_APP_URL');
    assert.match(r.blockers[0].fix, /https:\/\//);
  }
});

test('preflight: a plain-http APP_URL is a warning about the bearer token, not a blocker', () => {
  const r = voicePreflight(green({ appUrl: 'http://localhost:3000' }));
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.ok(r.warnings.some((w) => /cleartext/.test(w)));
  assert.equal(voicePreflight(green()).warnings.length, 0, 'https says nothing');
});

test('preflight NO_TRAINER_SECRET', () => {
  assertOnlyBlocker({ trainerSecret: '' }, 'NO_TRAINER_SECRET');
});

test('preflight TRAINER_HEALTH_UNREACHABLE — an unrun health check is not a pass', () => {
  for (const trainerHealth of [null, undefined, 'configured', 42]) {
    assertOnlyBlocker({ trainerHealth }, 'TRAINER_HEALTH_UNREACHABLE');
  }
});

test('preflight TRAINER_NOT_CONFIGURED — today\'s production answer', () => {
  assertOnlyBlocker({ trainerHealth: { ok: true, configured: false } }, 'TRAINER_NOT_CONFIGURED');
  assertOnlyBlocker({ trainerHealth: { ok: true } }, 'TRAINER_NOT_CONFIGURED');
  assertOnlyBlocker({ trainerHealth: { ok: true, configured: 'true' } }, 'TRAINER_NOT_CONFIGURED');
});

test('preflight CLIENT_ONLY_WOULD_DETACH — webhook tools already attached', () => {
  const r = assertOnlyBlocker({ clientOnly: true, agentWebhookToolCount: 4 }, 'CLIENT_ONLY_WOULD_DETACH');
  assert.match(r.blockers[0].message, /4 webhook tool/);
});

test('preflight CLIENT_ONLY_WOULD_DETACH — an UNKNOWN webhook count is refused, not read as zero', () => {
  for (const agentWebhookToolCount of [null, undefined, NaN, '0']) {
    assertOnlyBlocker({ clientOnly: true, agentWebhookToolCount }, 'CLIENT_ONLY_WOULD_DETACH');
  }
});

test('preflight: --client-only suppresses every webhook blocker and says so', () => {
  const r = voicePreflight(green({
    clientOnly: true,
    appUrl: '',
    trainerSecret: '',
    trainerHealth: null,
    agentWebhookToolCount: 0,
  }));
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.ok(r.warnings.some((w) => /--client-only/.test(w)));
  // …and the same input without --client-only is blocked three ways.
  const noEscape = voicePreflight(green({ appUrl: '', trainerSecret: '', trainerHealth: null }));
  assert.deepEqual(codes(noEscape).sort(), ['NO_APP_URL', 'NO_TRAINER_SECRET']);
});

test('preflight AGENT_UNREADABLE — false, and never assumed readable', () => {
  assertOnlyBlocker({ agentReadable: false }, 'AGENT_UNREADABLE');
  assertOnlyBlocker({ agentReadable: null }, 'AGENT_UNREADABLE');
  const omitted = green();
  delete omitted.agentReadable;
  assert.deepEqual(codes(voicePreflight(omitted)), ['AGENT_UNREADABLE']);
});

test('preflight: unset voice/LLM overrides are warnings only', () => {
  const r = voicePreflight(green({ voiceIdOverride: '', llmOverride: '' }));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some((w) => /ELEVENLABS_VOICE_ID/.test(w)));
  assert.ok(r.warnings.some((w) => /ELEVENLABS_AGENT_LLM/.test(w)));
});

test('preflight: blocker codes are exactly the documented set', () => {
  const everything = voicePreflight({
    clientOnly: false,
    agentId: SELF,
    agentReadable: false,
    serverSpecs: serverSpecs(),
    clientSpecs: [],
    knowledgeInvariantFailures: ['x'],
  });
  assert.deepEqual(codes(everything).sort(), [
    'AGENT_UNREADABLE', 'BAD_TOOL_SPEC', 'KNOWLEDGE_INVARIANT', 'NO_API_KEY', 'NO_APP_URL',
    'NO_FIRST_MESSAGE', 'NO_KNOWLEDGE_DOC', 'NO_SYSTEM_PROMPT', 'NO_TRAINER_SECRET',
  ]);
  // ★ Every code the module can emit is pinned by reading the module's own
  //   source, so a NEW blocker cannot be added without a test proving it fires.
  //   A hand-kept list in a test can only ever agree with itself.
  const ALL_CODES = [
    'AGENT_UNREADABLE', 'BAD_APP_URL', 'BAD_TOOL_SPEC', 'CLIENT_ONLY_WOULD_DETACH',
    'KNOWLEDGE_DRIFT', 'KNOWLEDGE_INVARIANT', 'NO_API_KEY', 'NO_APP_URL', 'NO_FIRST_MESSAGE',
    'NO_KNOWLEDGE_DOC', 'NO_SYSTEM_PROMPT', 'NO_TRAINER_SECRET', 'PROMPT_SENTINEL',
    'TRAINER_HEALTH_UNREACHABLE', 'TRAINER_NOT_CONFIGURED',
  ];
  const moduleSrc = readFileSync(new URL('../src/lib/voiceProvisioning.js', import.meta.url), 'utf8');
  const emitted = [...moduleSrc.matchAll(/\bblock\('([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(emitted)].sort(), ALL_CODES, 'a new blocker code needs a test below');

  const seen = new Set([
    ...codes(everything),
    ...codes(voicePreflight(green({ knowledgeDrift: true }))),
    ...codes(voicePreflight(green({ appUrl: 'toolkits.example' }))),
    ...codes(voicePreflight(green({ promptSentinel: '' }))),
    ...codes(voicePreflight(green({ trainerHealth: null }))),
    ...codes(voicePreflight(green({ trainerHealth: { configured: false } }))),
    ...codes(voicePreflight(green({ clientOnly: true, agentWebhookToolCount: 2 }))),
  ]);
  assert.deepEqual([...seen].sort(), ALL_CODES, 'every code is reachable from a plain input');
});

// ─────────────────────────────────────────────────────────────────────────────
// planToolReconciliation
// ─────────────────────────────────────────────────────────────────────────────

const plan = (over) => planToolReconciliation({ manifest: fullManifest(), agentId: SELF, agentTools: [], workspaceTools: [], ...over });

test('tools: nothing anywhere → create every managed tool, in manifest order', () => {
  const p = plan({});
  assert.deepEqual(p.creates.map((c) => c.name), [...CLIENT_NAMES, ...SERVER_NAMES]);
  assert.deepEqual(p.updates, []);
  assert.deepEqual(p.managedOrder, [...CLIENT_NAMES, ...SERVER_NAMES]);
  assert.deepEqual(p.foreignIds, []);
  assert.deepEqual(p.refusedReuse, []);
  assert.deepEqual(p.duplicateAttached, []);
  assert.equal(p.creates[2].kind, 'webhook');
  assert.equal(p.creates[2].config.api_schema.request_headers.Authorization, BEARER);
});

test('tools: a managed tool attached to this agent → UPDATE with the manifest body', () => {
  const p = plan({
    agentTools: [{ id: 't_nav', name: 'navigate_to_tool', type: 'client' }],
    workspaceTools: [{ id: 't_nav', name: 'navigate_to_tool', dependents: [SELF] }],
  });
  assert.deepEqual(p.updates.map((u) => [u.id, u.name, u.kind]), [['t_nav', 'navigate_to_tool', 'client']]);
  assert.deepEqual(p.updates[0].config, fullManifest().byName.get('navigate_to_tool').config);
  assert.ok(!p.creates.some((c) => c.name === 'navigate_to_tool'));
  assert.deepEqual(p.refusedReuse, []);
});

test('tools: attached managed with UNKNOWN dependents is still updated (attachment is the ownership signal)', () => {
  const p = plan({ agentTools: [{ id: 't_nav', name: 'navigate_to_tool' }] });
  assert.deepEqual(p.updates.map((u) => u.id), ['t_nav']);
});

test('tools: attached managed that ANOTHER agent also uses → replaced by a fresh tool, never PATCHed', () => {
  const p = plan({
    agentTools: [{ id: 't_nav', name: 'navigate_to_tool' }],
    workspaceTools: [{ id: 't_nav', name: 'navigate_to_tool', dependents: [SELF, OTHER] }],
  });
  assert.ok(!p.updates.some((u) => u.id === 't_nav'));
  assert.ok(p.creates.some((c) => c.name === 'navigate_to_tool'));
  assert.deepEqual(p.refusedReuse, [{ name: 'navigate_to_tool', id: 't_nav', attached: true, dependents: [OTHER], reason: 'attached to another agent' }]);
  assert.ok(!p.foreignIds.includes('t_nav'), 'the shared id is swapped out of THIS agent, not carried');
});

test('tools: foreign attached ids are carried verbatim, in order', () => {
  const p = plan({
    agentTools: [
      { id: 'f_1', name: 'someone_elses_tool' },
      { id: 't_nav', name: 'navigate_to_tool' },
      { id: 'f_2', name: 'another_foreign_tool' },
      { id: 'f_3' }, // unreadable name → foreign, carried
      { id: 'f_1', name: 'someone_elses_tool' }, // repeated id → carried once
      null,
      { name: 'no_id' },
    ],
  });
  assert.deepEqual(p.foreignIds, ['f_1', 'f_2', 'f_3']);
});

test('tools: a loose workspace tool whose dependents are KNOWN to be empty (or only this agent) is reused', () => {
  for (const dependents of [[], [SELF], [{ id: SELF }], [{ agent_id: SELF }]]) {
    const p = plan({ workspaceTools: [{ id: 'loose_nav', name: 'navigate_to_tool', dependents }] });
    assert.deepEqual(p.updates.map((u) => [u.id, u.name]), [['loose_nav', 'navigate_to_tool']], JSON.stringify(dependents));
    assert.ok(!p.creates.some((c) => c.name === 'navigate_to_tool'));
    assert.deepEqual(p.refusedReuse, []);
  }
});

test('tools: a loose workspace tool another agent depends on → CREATE + refusedReuse', () => {
  const p = plan({ workspaceTools: [{ id: 'loose_nav', name: 'navigate_to_tool', dependents: [OTHER] }] });
  assert.deepEqual(p.updates, []);
  assert.ok(p.creates.some((c) => c.name === 'navigate_to_tool'));
  assert.deepEqual(p.refusedReuse, [{ name: 'navigate_to_tool', id: 'loose_nav', attached: false, dependents: [OTHER], reason: 'attached to another agent' }]);
});

test('tools: a dependent the API key cannot identify counts as ANOTHER agent', () => {
  // An entry with no readable id says SOMETHING depends on this tool. Skipping it
  // would be the same fail-open reading one level down, inside a known array.
  for (const dependents of [[{ type: 'unknown' }], [null], [''], [{}], [{ id: 42 }], [SELF, null]]) {
    const p = plan({ workspaceTools: [{ id: 'loose_nav', name: 'navigate_to_tool', dependents }] });
    assert.deepEqual(p.updates, [], JSON.stringify(dependents));
    assert.equal(p.refusedReuse[0].reason, 'attached to another agent');
    assert.deepEqual(p.refusedReuse[0].dependents, ['<unidentified agent>']);
    assert.ok(p.creates.some((c) => c.name === 'navigate_to_tool'));
  }
});

test('tools: with no known agent id, no dependent can be recognised as self', () => {
  const p = planToolReconciliation({
    manifest: fullManifest(),
    agentId: '',
    agentTools: [],
    workspaceTools: [{ id: 'loose_nav', name: 'navigate_to_tool', dependents: [SELF] }],
  });
  assert.deepEqual(p.updates, []);
  assert.deepEqual(p.refusedReuse, [{ name: 'navigate_to_tool', id: 'loose_nav', attached: false, dependents: [SELF], reason: 'attached to another agent' }]);
});

test('tools: a loose tool with UNKNOWN dependents is never reused — CREATE + refusedReuse "dependents unknown"', () => {
  for (const dependents of [undefined, null, 'agent_self', { 0: SELF }, 0]) {
    const tool = { id: 'loose_nav', name: 'navigate_to_tool' };
    if (dependents !== undefined) tool.dependents = dependents;
    const p = plan({ workspaceTools: [tool] });
    assert.deepEqual(p.updates, [], `dependents ${JSON.stringify(dependents)} must not be reused`);
    assert.ok(p.creates.some((c) => c.name === 'navigate_to_tool'));
    assert.deepEqual(p.refusedReuse, [{ name: 'navigate_to_tool', id: 'loose_nav', attached: false, dependents: null, reason: 'dependents unknown' }]);
  }
});

test('tools: among same-name loose candidates the first KNOWN-free one is reused; the rest are reported', () => {
  const p = plan({
    workspaceTools: [
      { id: 'c_other', name: 'navigate_to_tool', dependents: [OTHER] },
      { id: 'c_unknown', name: 'navigate_to_tool' },
      { id: 'c_free', name: 'navigate_to_tool', dependents: [] },
      { id: 'c_free_2', name: 'navigate_to_tool', dependents: [] },
    ],
  });
  assert.deepEqual(p.updates.map((u) => u.id), ['c_free']);
  assert.deepEqual(p.refusedReuse.map((r) => [r.id, r.reason]), [['c_other', 'attached to another agent'], ['c_unknown', 'dependents unknown']]);
});

test('tools: a managed name attached TWICE keeps the first and reports the drop', () => {
  const p = plan({
    agentTools: [
      { id: 't_nav_a', name: 'navigate_to_tool' },
      { id: 't_nav_b', name: 'navigate_to_tool' },
    ],
  });
  assert.deepEqual(p.updates.map((u) => u.id), ['t_nav_a']);
  assert.deepEqual(p.duplicateAttached, [{ name: 'navigate_to_tool', id: 't_nav_b' }]);
  assert.ok(!p.foreignIds.includes('t_nav_b'));
});

test('tools: a loose candidate that is actually attached here is not double-counted', () => {
  const p = plan({
    agentTools: [{ id: 't_nav', name: 'navigate_to_tool' }],
    workspaceTools: [{ id: 't_nav', name: 'navigate_to_tool', dependents: [SELF] }],
  });
  assert.equal(p.updates.filter((u) => u.id === 't_nav').length, 1);
});

test('tools: in a client-only manifest an attached webhook tool is FOREIGN and carried, never dropped', () => {
  const clientOnly = managedToolManifest({ clientSpecs: clientSpecs(), serverSpecs: serverSpecs() });
  const p = planToolReconciliation({
    manifest: clientOnly,
    agentId: SELF,
    agentTools: [{ id: 'w_cat', name: 'get_my_training_catalog', type: 'webhook' }],
    workspaceTools: [],
  });
  assert.deepEqual(p.foreignIds, ['w_cat']);
  assert.deepEqual(p.managedOrder, CLIENT_NAMES);
});

// ─────────────────────────────────────────────────────────────────────────────
// nextToolIds — the all-or-nothing half
// ─────────────────────────────────────────────────────────────────────────────

test('nextToolIds: foreign ids first, then managed ids in manifest order', () => {
  const idByName = { navigate_to_tool: 'n1', open_account_panel: 'n2', get_my_training_catalog: 'n3', save_training_checkpoint: 'n4' };
  const managedOrder = [...CLIENT_NAMES, ...SERVER_NAMES];
  assert.deepEqual(nextToolIds({ foreignIds: ['f1', 'f2'], managedOrder, idByName }), ['f1', 'f2', 'n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(nextToolIds({ foreignIds: ['f1'], managedOrder, idByName: new Map(Object.entries(idByName)) }), ['f1', 'n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(nextToolIds({ foreignIds: [], managedOrder: [], idByName: {} }), []);
});

test('nextToolIds: NULL when any managed name has no id — never a partial list', () => {
  const managedOrder = [...CLIENT_NAMES, ...SERVER_NAMES];
  const full = { navigate_to_tool: 'n1', open_account_panel: 'n2', get_my_training_catalog: 'n3', save_training_checkpoint: 'n4' };
  for (const name of managedOrder) {
    const partial = { ...full };
    delete partial[name];
    assert.equal(nextToolIds({ foreignIds: ['f1'], managedOrder, idByName: partial }), null, `missing ${name}`);
    assert.equal(nextToolIds({ foreignIds: ['f1'], managedOrder, idByName: { ...full, [name]: '' } }), null, `empty ${name}`);
    assert.equal(nextToolIds({ foreignIds: ['f1'], managedOrder, idByName: { ...full, [name]: null } }), null, `null ${name}`);
  }
  assert.equal(nextToolIds({ foreignIds: ['f1'], managedOrder, idByName: undefined }), null);
  assert.equal(nextToolIds({ foreignIds: ['f1'], managedOrder: ['constructor'], idByName: {} }), null, 'no prototype lookups');
});

test('nextToolIds: NULL on malformed inputs or a duplicate id', () => {
  const idByName = { a: 'x1' };
  assert.equal(nextToolIds({ foreignIds: null, managedOrder: ['a'], idByName }), null);
  assert.equal(nextToolIds({ foreignIds: [], managedOrder: 'a', idByName }), null);
  assert.equal(nextToolIds({ foreignIds: [''], managedOrder: ['a'], idByName }), null);
  assert.equal(nextToolIds({ foreignIds: ['x1'], managedOrder: ['a'], idByName }), null);
  assert.equal(nextToolIds({ foreignIds: [], managedOrder: ['a', 'b'], idByName: { a: 'x1', b: 'x1' } }), null);
  assert.equal(nextToolIds(), null);
});

test('all-or-nothing: a tool that failed mid-list leaves NO agent tool list to PATCH, and the unwind never touches the agent', () => {
  const p = plan({
    agentTools: [{ id: 'f_keep', name: 'foreign_tool' }, { id: 't_nav', name: 'navigate_to_tool' }],
    workspaceTools: [{ id: 't_nav', name: 'navigate_to_tool', dependents: [SELF] }],
  });
  // Simulated APPLY: the update and the first two creates succeed, the last create fails.
  const idByName = { navigate_to_tool: 't_nav' };
  const created = [];
  for (const [i, c] of p.creates.entries()) {
    if (i === p.creates.length - 1) break; // refused by the API
    idByName[c.name] = `new_${i}`;
    created.push(`new_${i}`);
  }
  assert.equal(nextToolIds({ foreignIds: p.foreignIds, managedOrder: p.managedOrder, idByName }), null);

  const before = captureRollbackState({ agent: liveAgent(), managedToolConfigs: { t_nav: { type: 'client', name: 'navigate_to_tool' } } });
  const ops = planRollback(before, { agentPatched: false, updatedToolIds: ['t_nav'], createdToolIds: created });
  assert.ok(!ops.some((o) => o.path.startsWith('/v1/convai/agents/')), 'a tools-phase failure must not write the agent');
  assert.deepEqual(ops.map((o) => o.op), ['restore-tool', 'delete-tool', 'delete-tool']);
});

// ─────────────────────────────────────────────────────────────────────────────
// planKnowledgeReconciliation
// ─────────────────────────────────────────────────────────────────────────────

const DOC = 'toolkits-voice-agent-knowledge.md';
const FP = 'kb1-0123456789abcdef';
const kbPlan = (over) => planKnowledgeReconciliation({
  currentKb: [],
  docName: DOC,
  repoFingerprint: FP,
  liveFingerprint: FP,
  dependentsByDocId: {},
  agentId: SELF,
  ...over,
});
const foreignDoc = { id: 'kb_foreign', name: 'pricing-faq.md', type: 'text', usage_mode: 'auto' };

test('kb: SKIP when fingerprints match AND exactly one copy is attached as prompt', () => {
  const r = kbPlan({ currentKb: [{ id: 'kb_ours', name: DOC, usage_mode: 'prompt' }, foreignDoc] });
  assert.equal(r.skip, true);
  assert.match(r.reason, /already current/);
  assert.deepEqual(r.detachIds, []);
  assert.deepEqual(r.deletableIds, []);
  assert.deepEqual(r.undeletableIds, []);
  assert.deepEqual(r.keepForeign, [foreignDoc]);
});

test('kb: two copies with a matching fingerprint are NOT skipped', () => {
  const r = kbPlan({
    currentKb: [{ id: 'kb_a', name: DOC, usage_mode: 'prompt' }, { id: 'kb_b', name: DOC, usage_mode: 'prompt' }],
    dependentsByDocId: { kb_a: [SELF], kb_b: [SELF] },
  });
  assert.equal(r.skip, false);
  assert.match(r.reason, /2 copies/);
  assert.deepEqual(r.detachIds, ['kb_a', 'kb_b']);
  assert.deepEqual(r.deletableIds, ['kb_a', 'kb_b']);
});

test('kb: not skipped on a mismatch, an unread live fingerprint, no copy, or the wrong usage mode', () => {
  const one = [{ id: 'kb_ours', name: DOC, usage_mode: 'prompt' }];
  assert.equal(kbPlan({ currentKb: one, liveFingerprint: 'kb1-ffffffffffffffff' }).skip, false);
  assert.match(kbPlan({ currentKb: one, liveFingerprint: 'kb1-ffffffffffffffff' }).reason, /!= repo/);
  assert.equal(kbPlan({ currentKb: one, liveFingerprint: null }).skip, false);
  assert.match(kbPlan({ currentKb: one, liveFingerprint: null }).reason, /no live fingerprint/);
  assert.equal(kbPlan({ currentKb: one, repoFingerprint: '' }).skip, false);
  assert.equal(kbPlan({ currentKb: [] }).skip, false);
  const auto = kbPlan({ currentKb: [{ id: 'kb_ours', name: DOC, usage_mode: 'auto' }] });
  assert.equal(auto.skip, false);
  assert.match(auto.reason, /usage_mode "auto"/);
});

test('kb: foreign documents are always kept and never detached or deleted', () => {
  const r = kbPlan({
    currentKb: [foreignDoc, { id: 'kb_ours', name: DOC, usage_mode: 'prompt' }, { id: 'kb_f2', name: 'other.md' }],
    liveFingerprint: 'kb1-ffffffffffffffff',
    dependentsByDocId: { kb_ours: [SELF], kb_foreign: [], kb_f2: [] },
  });
  assert.deepEqual(r.keepForeign.map((d) => d.id), ['kb_foreign', 'kb_f2']);
  assert.deepEqual(r.detachIds, ['kb_ours']);
  assert.deepEqual(r.deletableIds, ['kb_ours']);
});

test('kb: deletable only when dependents are KNOWN and name no other agent', () => {
  const r = kbPlan({
    currentKb: [
      { id: 'kb_none', name: DOC },
      { id: 'kb_self', name: DOC },
      { id: 'kb_obj_self', name: DOC },
      { id: 'kb_other', name: DOC },
      { id: 'kb_ghost', name: DOC },
    ],
    liveFingerprint: null,
    dependentsByDocId: {
      kb_none: [],
      kb_self: [SELF],
      kb_obj_self: [{ id: SELF, name: 'this agent' }],
      kb_other: [SELF, OTHER],
      kb_ghost: [{ type: 'unknown' }],
    },
  });
  assert.deepEqual(r.deletableIds, ['kb_none', 'kb_self', 'kb_obj_self']);
  assert.deepEqual(r.undeletableIds, [
    { id: 'kb_other', dependents: [OTHER], reason: 'attached to another agent' },
    { id: 'kb_ghost', dependents: ['<unidentified agent>'], reason: 'attached to another agent' },
  ]);
  assert.deepEqual(r.detachIds, ['kb_none', 'kb_self', 'kb_obj_self', 'kb_other', 'kb_ghost'], 'detaching from THIS agent is always ours to do');
});

test('kb: UNKNOWN dependents make a document UNDELETABLE', () => {
  const r = kbPlan({
    currentKb: [
      { id: 'kb_missing', name: DOC },
      { id: 'kb_null', name: DOC },
      { id: 'kb_string', name: DOC },
      { id: 'constructor', name: DOC },
    ],
    liveFingerprint: null,
    dependentsByDocId: { kb_null: null, kb_string: SELF },
  });
  assert.deepEqual(r.deletableIds, []);
  assert.deepEqual(r.undeletableIds, [
    { id: 'kb_missing', dependents: null, reason: 'dependents unknown' },
    { id: 'kb_null', dependents: null, reason: 'dependents unknown' },
    { id: 'kb_string', dependents: null, reason: 'dependents unknown' },
    { id: 'constructor', dependents: null, reason: 'dependents unknown' },
  ]);
  // No dependents map at all: nothing is deletable.
  const noMap = kbPlan({ currentKb: [{ id: 'kb_x', name: DOC }], liveFingerprint: null, dependentsByDocId: undefined });
  assert.deepEqual(noMap.deletableIds, []);
  assert.equal(noMap.undeletableIds[0].reason, 'dependents unknown');
});

test('kb: a matching copy with NO readable id is not skipped — a skip must name its document', () => {
  const r = kbPlan({ currentKb: [{ name: DOC, usage_mode: 'prompt' }] });
  assert.equal(r.skip, false, 'skipping leaves the shell with no kbDocId, so verify checks nothing');
  assert.match(r.reason, /no readable id/);
  assert.deepEqual(r.detachIds, []);
  assert.deepEqual(r.deletableIds, []);
});

test('kb: nothing is ever deletable that is not also detached', () => {
  for (const over of [
    { currentKb: [{ id: 'kb_a', name: DOC }], liveFingerprint: null, dependentsByDocId: { kb_a: [] } },
    { currentKb: [{ id: 'kb_a', name: DOC }, { id: 'kb_b', name: DOC }], liveFingerprint: null, dependentsByDocId: { kb_a: [], kb_b: [OTHER] } },
    { currentKb: [{ id: 'kb_ours', name: DOC, usage_mode: 'prompt' }, foreignDoc] },
  ]) {
    const r = kbPlan(over);
    for (const id of r.deletableIds) {
      assert.ok(r.detachIds.includes(id), `${id} is deletable but never detached`);
    }
    for (const doc of r.keepForeign) {
      assert.ok(!r.detachIds.includes(doc.id) && !r.deletableIds.includes(doc.id), `foreign ${doc.id} touched`);
    }
  }
});

test('kb: detachIds lists every same-name copy with an id', () => {
  const r = kbPlan({
    currentKb: [{ id: 'kb_a', name: DOC }, { name: DOC }, { id: 'kb_b', name: DOC }],
    liveFingerprint: null,
  });
  assert.deepEqual(r.detachIds, ['kb_a', 'kb_b']);
});

test('kb: with no document name nothing is "ours" — unnamed documents are never targeted', () => {
  const r = kbPlan({ docName: '', currentKb: [{ id: 'kb_unnamed', name: '' }, { id: 'kb_noname' }], dependentsByDocId: { kb_unnamed: [], kb_noname: [] } });
  assert.equal(r.skip, false);
  assert.deepEqual(r.detachIds, []);
  assert.deepEqual(r.deletableIds, []);
  assert.deepEqual(r.keepForeign.map((d) => d.id), ['kb_unnamed', 'kb_noname']);
});

// ─────────────────────────────────────────────────────────────────────────────
// nextKnowledgeBase — the all-or-nothing half, on the knowledge side
// ─────────────────────────────────────────────────────────────────────────────

const OURS = { id: 'kb_new', name: DOC, type: 'text', usage_mode: 'prompt' };

test('nextKnowledgeBase: foreign documents first, ours last, carried verbatim', () => {
  const second = { id: 'kb_f2', name: 'other.md', usage_mode: 'auto' };
  assert.deepEqual(nextKnowledgeBase({ keepForeign: [foreignDoc, second], ours: OURS }), [foreignDoc, second, OURS]);
  assert.deepEqual(nextKnowledgeBase({ keepForeign: [], ours: OURS }), [OURS]);
  // A foreign document keeps ITS OWN usage_mode — only ours is required to be prompt.
  assert.equal(nextKnowledgeBase({ keepForeign: [foreignDoc], ours: OURS })[0].usage_mode, 'auto');
});

test('nextKnowledgeBase: NULL rather than a list that would DETACH a document', () => {
  assert.equal(nextKnowledgeBase({ keepForeign: [foreignDoc], ours: null }), null, 'no document to attach');
  assert.equal(nextKnowledgeBase({ keepForeign: [foreignDoc], ours: { name: DOC, usage_mode: 'prompt' } }), null, 'our upload has no id');
  assert.equal(nextKnowledgeBase({ keepForeign: [foreignDoc], ours: { ...OURS, id: '' } }), null);
  assert.equal(nextKnowledgeBase({ keepForeign: [foreignDoc], ours: { ...OURS, usage_mode: 'auto' } }), null, 'verifyApplied would refuse it a step later');
  assert.equal(nextKnowledgeBase({ keepForeign: [foreignDoc], ours: { ...OURS, usage_mode: undefined } }), null);
  assert.equal(nextKnowledgeBase({ keepForeign: [{ name: 'no-id.md' }], ours: OURS }), null, 'a foreign document with no id cannot be re-sent');
  assert.equal(nextKnowledgeBase({ keepForeign: [null], ours: OURS }), null);
  assert.equal(nextKnowledgeBase({ keepForeign: [{ ...foreignDoc, id: OURS.id }], ours: OURS }), null, 'a duplicate id means a "foreign" document is in fact ours');
  assert.equal(nextKnowledgeBase({ keepForeign: null, ours: OURS }), null);
  assert.equal(nextKnowledgeBase({ keepForeign: 'kb_foreign', ours: OURS }), null);
  assert.equal(nextKnowledgeBase(), null);
});

test('nextKnowledgeBase: the SKIP path re-sends the copy already attached', () => {
  // The forward PATCH replaces the whole prompt, so even a run that changes
  // nothing about the document must still send the list it is replacing.
  const attached = { id: 'kb_ours', name: DOC, usage_mode: 'prompt' };
  const plan = kbPlan({ currentKb: [attached, foreignDoc] });
  assert.equal(plan.skip, true);
  assert.deepEqual(nextKnowledgeBase({ keepForeign: plan.keepForeign, ours: attached }), [foreignDoc, attached]);
});

test('nextKnowledgeBase: the result is a copy — mutating it cannot corrupt the plan', () => {
  const plan = kbPlan({ currentKb: [foreignDoc, { id: 'kb_ours', name: DOC, usage_mode: 'prompt' }], liveFingerprint: null });
  const snapshot = JSON.stringify({ plan, OURS });
  const list = nextKnowledgeBase({ keepForeign: plan.keepForeign, ours: OURS });
  list[0].usage_mode = 'prompt';
  list[1].name = 'renamed.md';
  assert.equal(JSON.stringify({ plan, OURS }), snapshot);
});

// ─────────────────────────────────────────────────────────────────────────────
// planKnowledgeOps — attach BEFORE detach, asserted by op index
//
// planKnowledgeReconciliation returns SETS, and a set cannot express "only
// after": `deletableIds` beside `detachIds` reads equally well as "delete these,
// then attach". These tests are the reason the ordering is an op LIST.
// ─────────────────────────────────────────────────────────────────────────────

const opsOf = (list) => list.map((o) => o.op);

test('kb ops: the attach is op 0 and EVERY delete comes after it — by INDEX, not by comment', () => {
  const plan = kbPlan({
    currentKb: [foreignDoc, { id: 'kb_old_a', name: DOC }, { id: 'kb_old_b', name: DOC }],
    liveFingerprint: null,
    dependentsByDocId: { kb_old_a: [], kb_old_b: [SELF] },
  });
  assert.deepEqual(plan.deletableIds, ['kb_old_a', 'kb_old_b']);

  const ops = planKnowledgeOps({ plan, ours: OURS, agentId: SELF });
  assert.deepEqual(opsOf(ops), ['attach-kb', 'delete-kb', 'delete-kb']);
  const attachAt = opsOf(ops).indexOf('attach-kb');
  assert.equal(attachAt, 0, 'nothing may precede the attach');
  ops.forEach((o, i) => {
    if (o.op === 'delete-kb') assert.ok(i > attachAt, `delete at index ${i} runs before the attach at ${attachAt}`);
  });
  assert.equal(opsOf(ops).lastIndexOf('attach-kb') < opsOf(ops).indexOf('delete-kb'), true);

  assert.equal(ops[0].method, 'PATCH');
  assert.equal(ops[0].path, `/v1/convai/agents/${SELF}`);
  assert.deepEqual(ops[0].body.conversation_config.agent.prompt.knowledge_base, [foreignDoc, OURS]);
  assert.deepEqual(ops.slice(1).map((o) => [o.method, o.path]), [
    ['DELETE', '/v1/convai/knowledge-base/kb_old_a'],
    ['DELETE', '/v1/convai/knowledge-base/kb_old_b'],
  ]);
  for (const o of ops) assert.ok(typeof o.why === 'string' && o.why.length > 0);
});

test('kb ops: NULL when the attach cannot be expressed — and NULL deletes nothing', () => {
  // The destructive half must never be emitted on its own. Each of these inputs
  // makes nextKnowledgeBase refuse, so there is no list at all — not "the deletes
  // at least".
  const plan = kbPlan({
    currentKb: [{ id: 'kb_old', name: DOC }],
    liveFingerprint: null,
    dependentsByDocId: { kb_old: [] },
  });
  assert.deepEqual(plan.deletableIds, ['kb_old'], 'the fixture really does want a delete');
  for (const [label, args] of [
    ['no document to attach', { ours: null }],
    ['our upload has no id', { ours: { name: DOC, usage_mode: 'prompt' } }],
    ['wrong usage_mode', { ours: { ...OURS, usage_mode: 'auto' } }],
    ['no agent id', { agentId: '' }],
    ['agent id is not a string', { agentId: 42 }],
  ]) {
    assert.equal(planKnowledgeOps({ plan, ours: OURS, agentId: SELF, ...args }), null, label);
  }
  assert.equal(planKnowledgeOps({ plan: { keepForeign: [{ name: 'no-id.md' }], deletableIds: ['kb_old'] }, ours: OURS, agentId: SELF }), null,
    'a foreign document that cannot be re-sent aborts the phase rather than dropping it');
  assert.equal(planKnowledgeOps({ plan: null, ours: OURS, agentId: SELF }), null);
  assert.equal(planKnowledgeOps({ plan: 'plan', ours: OURS, agentId: SELF }), null);
  assert.equal(planKnowledgeOps(), null);
});

test('kb ops: only deletableIds are deleted — an undeletable copy reaches no op', () => {
  const plan = kbPlan({
    currentKb: [{ id: 'kb_free', name: DOC }, { id: 'kb_shared', name: DOC }, { id: 'kb_unknown', name: DOC }],
    liveFingerprint: null,
    dependentsByDocId: { kb_free: [], kb_shared: [OTHER] },
  });
  assert.deepEqual(plan.detachIds, ['kb_free', 'kb_shared', 'kb_unknown'], 'all three ARE detached');
  assert.deepEqual(plan.undeletableIds.map((u) => u.id), ['kb_shared', 'kb_unknown']);

  const ops = planKnowledgeOps({ plan, ours: OURS, agentId: SELF });
  const deleted = ops.filter((o) => o.op === 'delete-kb').map((o) => o.path);
  assert.deepEqual(deleted, ['/v1/convai/knowledge-base/kb_free']);
  const printed = JSON.stringify(ops.filter((o) => o.op === 'delete-kb'));
  assert.ok(!printed.includes('kb_shared'), "another agent's document is never deleted");
  assert.ok(!printed.includes('kb_unknown'), 'unknown dependents are never read as none');
});

test('kb ops: the document being attached is never deleted, however it got into the list', () => {
  // Deleting what was just published is the one mistake that survives
  // verification: the agent keeps a reference to an id that no longer exists.
  const ops = planKnowledgeOps({
    plan: { keepForeign: [foreignDoc], deletableIds: [OURS.id, 'kb_old'] },
    ours: OURS,
    agentId: SELF,
  });
  assert.deepEqual(ops.filter((o) => o.op === 'delete-kb').map((o) => o.path), ['/v1/convai/knowledge-base/kb_old']);
  // The same guard covers a foreign document carried into the next list.
  const carried = planKnowledgeOps({
    plan: { keepForeign: [foreignDoc], deletableIds: [foreignDoc.id] },
    ours: OURS,
    agentId: SELF,
  });
  assert.deepEqual(opsOf(carried), ['attach-kb']);
});

test('kb ops: the SKIP path still attaches the list it is replacing, and deletes nothing', () => {
  const attached = { id: 'kb_ours', name: DOC, usage_mode: 'prompt' };
  const plan = kbPlan({ currentKb: [attached, foreignDoc] });
  assert.equal(plan.skip, true);
  const ops = planKnowledgeOps({ plan, ours: attached, agentId: SELF });
  assert.deepEqual(opsOf(ops), ['attach-kb']);
  assert.deepEqual(ops[0].body.conversation_config.agent.prompt.knowledge_base, [foreignDoc, attached]);
});

test('kb ops: malformed delete ids are dropped, and ids are URL-encoded', () => {
  const ops = planKnowledgeOps({
    plan: { keepForeign: [], deletableIds: ['kb/1', '', null, 7, undefined] },
    ours: OURS,
    agentId: 'a/b?c',
  });
  assert.equal(ops[0].path, '/v1/convai/agents/a%2Fb%3Fc');
  assert.deepEqual(ops.slice(1).map((o) => o.path), ['/v1/convai/knowledge-base/kb%2F1']);
  // A bare string would otherwise be iterated one CHARACTER at a time.
  assert.deepEqual(opsOf(planKnowledgeOps({ plan: { keepForeign: [], deletableIds: 'kb_old' }, ours: OURS, agentId: SELF })), ['attach-kb']);
});

test('kb ops: mutating an op cannot corrupt the plan or the document', () => {
  const plan = kbPlan({ currentKb: [foreignDoc, { id: 'kb_old', name: DOC }], liveFingerprint: null, dependentsByDocId: { kb_old: [] } });
  const snapshot = JSON.stringify({ plan, OURS });
  const ops = planKnowledgeOps({ plan, ours: OURS, agentId: SELF });
  ops[0].body.conversation_config.agent.prompt.knowledge_base[0].usage_mode = 'prompt';
  ops[0].body.conversation_config.agent.prompt.knowledge_base[1].name = 'renamed.md';
  assert.equal(JSON.stringify({ plan, OURS }), snapshot);
});

// ─────────────────────────────────────────────────────────────────────────────
// captureRollbackState / redactRollbackState
// ─────────────────────────────────────────────────────────────────────────────

// The live agent as the API actually returns it — including the settings this run
// never writes. Those siblings are the point of the fixture: a capture narrowed to
// the fields the run DOES write re-sends truncated objects, and if a PATCH replaces
// rather than deep-merges (one of the three unverified API shapes) the restore is
// what destroys them. `conversation.client_events` carries `user_transcript`, which
// the widget's transcript de-duplication depends on receiving.
function liveAgent() {
  return {
    agent_id: SELF,
    name: 'toolkits bookkeeping siri',
    conversation_config: {
      agent: {
        prompt: {
          prompt: 'old prompt',
          tool_ids: ['f_1', 't_nav'],
          tools: [{ id: 't_nav', name: 'navigate_to_tool' }],
          knowledge_base: [{ id: 'kb_old', name: DOC, type: 'text', usage_mode: 'prompt' }],
          llm: 'gemini-2.5-flash',
          temperature: 0.3,
          rag: { enabled: false },
        },
        first_message: 'Hi {{user_name}}',
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: { plan_label: 'Silver' } },
      },
      conversation: { max_duration_seconds: 600, client_events: ['audio', 'user_transcript'], text_only: false },
      tts: { voice_id: 'cjVigY5qzO86Huf0OWal', model_id: 'eleven_flash', stability: 0.5 },
      turn: { turn_timeout: 7 },
    },
    platform_settings: {
      auth: { enable_auth: true, allowlist: [{ hostname: 'toolkits.alexsagun.com' }] },
      widget: { variant: 'compact' },
      privacy: { record_voice: true },
    },
  };
}

function webhookToolConfigWithSecrets() {
  return {
    type: 'webhook',
    name: 'get_my_training_catalog',
    api_schema: {
      url: `${BASE}/api/elevenlabs/trainer?action=get_my_training_catalog`,
      request_headers: { Authorization: 'Bearer live-header-value-123', 'Content-Type': 'application/json' },
    },
    dynamic_variables: { dynamic_variable_placeholders: { secret__trainer_token: 'placeholder-value-456' } },
  };
}

test('capture: every field needed for the restore is captured', () => {
  const managedToolConfigs = { w_cat: webhookToolConfigWithSecrets() };
  const s = captureRollbackState({ agent: liveAgent(), managedToolConfigs, capturedAt: '2026-09-16T00:00:00Z' });
  assert.equal(s.agentId, SELF);
  assert.equal(s.name, 'toolkits bookkeeping siri');
  assert.equal(s.capturedAt, '2026-09-16T00:00:00Z');
  const p = s.conversationConfig.agent.prompt;
  assert.equal(p.prompt, 'old prompt');
  assert.deepEqual(p.tool_ids, ['f_1', 't_nav']);
  assert.deepEqual(p.knowledge_base, [{ id: 'kb_old', name: DOC, type: 'text', usage_mode: 'prompt' }]);
  assert.equal(p.llm, 'gemini-2.5-flash');
  assert.equal(p.temperature, 0.3, 'the whole prompt object is captured, not four fields of it');
  assert.deepEqual(p.rag, { enabled: false });
  assert.equal('tools' in p, false, 'prompt.tools is derived from tool_ids; sending both is a 400');
  assert.equal(s.conversationConfig.agent.first_message, 'Hi {{user_name}}');
  assert.equal(s.conversationConfig.agent.language, 'en');
  assert.equal(s.conversationConfig.conversation.max_duration_seconds, 600);
  assert.deepEqual(s.conversationConfig.tts, { voice_id: 'cjVigY5qzO86Huf0OWal', model_id: 'eleven_flash', stability: 0.5 });
  assert.equal(s.platformSettings.auth.enable_auth, true);
  assert.deepEqual(s.managedToolConfigs, managedToolConfigs);
  assert.equal(s.managedToolConfigs.w_cat.api_schema.request_headers.Authorization, 'Bearer live-header-value-123',
    'the HELD capture keeps real header values — only the printed copy is redacted');
  assert.deepEqual(s.createdToolIds, []);
  assert.deepEqual(s.createdKbIds, []);
});

test('capture: settings this run never writes are captured WHOLE, not narrowed to the fields it does', () => {
  // An earlier capture kept `conversation` as {max_duration_seconds}, `tts` as
  // {voice_id} and `platform_settings` as {auth:{enable_auth}}, and dropped `turn`
  // and `agent.dynamic_variables` entirely — so the restore PATCH re-sent truncated
  // objects. Whether a PATCH replaces a nested object or deep-merges it is NOT a
  // verified API shape; if it replaces, that restore is what destroys these.
  const cc = captureRollbackState({ agent: liveAgent() }).conversationConfig;
  assert.deepEqual(cc.conversation.client_events, ['audio', 'user_transcript'],
    'user_transcript lives here, and the widget transcript dedup depends on receiving it');
  assert.equal(cc.conversation.text_only, false);
  assert.equal(cc.tts.model_id, 'eleven_flash');
  assert.equal(cc.tts.stability, 0.5);
  assert.deepEqual(cc.turn, { turn_timeout: 7 });
  assert.deepEqual(cc.agent.dynamic_variables, { dynamic_variable_placeholders: { plan_label: 'Silver' } });

  const ps = captureRollbackState({ agent: liveAgent() }).platformSettings;
  assert.deepEqual(ps.auth.allowlist, [{ hostname: 'toolkits.alexsagun.com' }]);
  assert.deepEqual(ps.widget, { variant: 'compact' });
  assert.deepEqual(ps.privacy, { record_voice: true });

  // Nothing the live agent carries is dropped, other than the ONE documented
  // omission: prompt.tools is derived from tool_ids and sending both is a 400.
  const live = liveAgent();
  assert.deepEqual(Object.keys(cc).sort(), Object.keys(live.conversation_config).sort());
  assert.deepEqual(Object.keys(cc.agent).sort(), Object.keys(live.conversation_config.agent).sort());
  assert.deepEqual(Object.keys(ps).sort(), Object.keys(live.platform_settings).sort());
});

test('capture: arrays and nested objects are COPIED, not aliased', () => {
  const agent = liveAgent();
  const managedToolConfigs = { w_cat: webhookToolConfigWithSecrets() };
  const s = captureRollbackState({ agent, managedToolConfigs });
  const snapshot = JSON.stringify(s);

  agent.conversation_config.agent.prompt.tool_ids.push('t_new');
  agent.conversation_config.agent.prompt.knowledge_base[0].usage_mode = 'auto';
  agent.conversation_config.agent.prompt.knowledge_base.push({ id: 'kb_new' });
  agent.conversation_config.agent.prompt.rag.enabled = true;
  agent.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.plan_label = 'changed';
  agent.conversation_config.conversation.client_events.push('changed');
  agent.conversation_config.turn.turn_timeout = 99;
  agent.conversation_config.tts.voice_id = 'changed';
  agent.conversation_config.tts.stability = 0.9;
  agent.platform_settings.auth.enable_auth = false;
  agent.platform_settings.auth.allowlist[0].hostname = 'changed.example';
  agent.platform_settings.widget.variant = 'changed';
  managedToolConfigs.w_cat.api_schema.url = 'https://evil.example';
  managedToolConfigs.w_cat.api_schema.request_headers.Authorization = 'changed';
  managedToolConfigs.added = { name: 'x' };

  assert.equal(JSON.stringify(s), snapshot);
});

test('capture: an empty or partial agent captures nulls, never throws', () => {
  for (const agent of [undefined, null, {}, { conversation_config: {} }]) {
    const s = captureRollbackState({ agent });
    assert.equal(s.agentId, null);
    assert.equal(s.conversationConfig.agent.prompt.prompt, null);
    assert.deepEqual(s.conversationConfig.agent.prompt.tool_ids, []);
    assert.deepEqual(s.conversationConfig.agent.prompt.knowledge_base, []);
    assert.equal(s.conversationConfig.agent.prompt.llm, null);
    assert.equal(s.conversationConfig.agent.first_message, null);
    assert.equal(s.conversationConfig.conversation.max_duration_seconds, null);
    assert.equal(s.conversationConfig.tts, null);
    assert.equal(s.platformSettings.auth.enable_auth, null);
  }
});

test('redact: request_headers values, placeholder values and secret__* keys are blanked at any depth', () => {
  const payload = {
    agentId: SELF,
    managedToolConfigs: { w_cat: webhookToolConfigWithSecrets() },
    list: [
      { deep: [{ secret__trainer_token: 'deep-secret-789', keep: 'visible' }] },
      { request_headers: { 'X-Custom': 'custom-header-value' } },
      // A placeholder whose key is NOT secret__* — the placeholder rule must blank it on its own.
      { dynamic_variables: { dynamic_variable_placeholders: { plan_label: 'placeholder-plain-321' } } },
    ],
    secret__top: { nested: 'top-secret-000' },
  };
  const r = redactRollbackState(payload);
  assert.deepEqual(r.managedToolConfigs.w_cat.api_schema.request_headers, { Authorization: '<redacted>', 'Content-Type': '<redacted>' });
  assert.deepEqual(r.managedToolConfigs.w_cat.dynamic_variables.dynamic_variable_placeholders, { secret__trainer_token: '<redacted>' });
  assert.deepEqual(r.list[2].dynamic_variables.dynamic_variable_placeholders, { plan_label: '<redacted>' });
  assert.equal(r.list[0].deep[0].secret__trainer_token, '<redacted>');
  assert.equal(r.list[0].deep[0].keep, 'visible');
  assert.deepEqual(r.list[1].request_headers, { 'X-Custom': '<redacted>' });
  assert.equal(r.secret__top, '<redacted>');
  // Non-secret structure survives, so the printed payload is still useful.
  assert.equal(r.agentId, SELF);
  assert.equal(r.managedToolConfigs.w_cat.api_schema.url, `${BASE}/api/elevenlabs/trainer?action=get_my_training_catalog`);
  const printed = JSON.stringify(r);
  for (const leak of ['live-header-value-123', 'placeholder-value-456', 'deep-secret-789', 'custom-header-value', 'top-secret-000', 'application/json', 'placeholder-plain-321']) {
    assert.ok(!printed.includes(leak), `leaked ${leak}`);
  }
});

test('redact: the ARRAY header form keeps names and blanks values and secret ids', () => {
  const r = redactRollbackState({
    request_headers: [
      { type: 'value', name: 'Authorization', value: 'Bearer array-form-secret' },
      { type: 'secret', name: 'X-Key', secret_id: 'secret-id-abc' },
      'raw-string-header',
    ],
  });
  assert.deepEqual(r.request_headers, [
    { type: 'value', name: 'Authorization', value: '<redacted>' },
    { type: 'secret', name: 'X-Key', secret_id: '<redacted>' },
    '<redacted>',
  ]);
});

test('redact: a sensitive container is blanked whatever SHAPE it arrives in', () => {
  // Only the two shapes this repo writes were handled; every other shape fell
  // through to the generic walk and was printed verbatim. The key alone is enough
  // to know the value is secret.
  const r = redactRollbackState({
    a: { request_headers: 'Authorization: Bearer serialized-form-secret' },
    b: { dynamic_variable_placeholders: [{ name: 'secret__trainer_token', value: 'array-form-placeholder' }] },
    c: { dynamic_variable_placeholders: 'secret__trainer_token=flat-form-placeholder' },
    d: { request_headers: null, dynamic_variable_placeholders: undefined },
  });
  assert.equal(r.a.request_headers, '<redacted>');
  assert.deepEqual(r.b.dynamic_variable_placeholders, [{ name: 'secret__trainer_token', value: '<redacted>' }]);
  assert.equal(r.c.dynamic_variable_placeholders, '<redacted>');
  assert.equal(r.d.request_headers, null, 'an absent container stays absent rather than inventing a secret');
  assert.equal(r.d.dynamic_variable_placeholders, undefined);
  const printed = JSON.stringify(r);
  for (const leak of ['serialized-form-secret', 'array-form-placeholder', 'flat-form-placeholder']) {
    assert.ok(!printed.includes(leak), `leaked ${leak}`);
  }
});

test('redact: api keys and Authorization values are blanked wherever they appear', () => {
  const r = redactRollbackState({ prompt: { custom_llm: { api_key: { secret_id: 'llm-secret-id' } } }, headers: { authorization: 'Bearer loose' } });
  assert.equal(r.prompt.custom_llm.api_key, '<redacted>');
  assert.equal(r.headers.authorization, '<redacted>');
});

test('redact: the WIDENED capture prints no more secrets than the narrow one did', () => {
  // Capturing whole objects means whole objects reach a log or --dump-before.
  // Every secret container inside them is still blanked by KEY, wherever it sits.
  const agent = liveAgent();
  agent.platform_settings.workspace_overrides = {
    conversation_initiation_client_data_webhook: {
      url: `${BASE}/hook`,
      request_headers: { Authorization: 'Bearer platform-settings-secret' },
    },
  };
  const held = captureRollbackState({ agent });
  assert.equal(held.platformSettings.workspace_overrides.conversation_initiation_client_data_webhook.request_headers.Authorization,
    'Bearer platform-settings-secret', 'the HELD capture keeps the real value — a restore needs it');
  assert.equal(held.conversationConfig.agent.dynamic_variables.dynamic_variable_placeholders.plan_label, 'Silver');

  const printed = JSON.stringify(redactRollbackState(held));
  assert.ok(!printed.includes('platform-settings-secret'), 'a secret inside platform_settings reached a log');
  assert.ok(!printed.includes('Silver'), 'a dynamic-variable placeholder value reached a log');
  assert.ok(printed.includes(`${BASE}/hook`), 'non-secret structure still survives, or the dump is useless');
});

test('redact: never mutates its input', () => {
  const input = captureRollbackState({ agent: liveAgent(), managedToolConfigs: { w_cat: webhookToolConfigWithSecrets() } });
  input.list = [{ secret__x: 'keep-me', request_headers: [{ name: 'A', value: 'keep-me-too' }] }];
  const before = JSON.stringify(input);
  const r = redactRollbackState(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(r, input);
  assert.equal(input.managedToolConfigs.w_cat.api_schema.request_headers.Authorization, 'Bearer live-header-value-123');
  assert.equal(redactRollbackState(null), null);
  assert.equal(redactRollbackState('text'), 'text');
});

// ─────────────────────────────────────────────────────────────────────────────
// planRollback
// ─────────────────────────────────────────────────────────────────────────────

test('rollback: restore-agent → verify-restore → delete-kb → restore-tool → delete-tool', () => {
  const before = captureRollbackState({
    agent: liveAgent(),
    managedToolConfigs: { t_nav: { type: 'client', name: 'navigate_to_tool', v: 'old' }, t_other: { type: 'client', name: 'open_account_panel' } },
  });
  const ops = planRollback(before, {
    createdKbIds: ['kb_new_1', 'kb_new_2'],
    updatedToolIds: ['t_nav'],
    createdToolIds: ['t_new_1', 't_new_2'],
  });
  assert.deepEqual(ops.map((o) => o.op), [
    'restore-agent', 'verify-restore', 'delete-kb', 'delete-kb', 'restore-tool', 'delete-tool', 'delete-tool',
  ]);
  const last = (name) => ops.map((o) => o.op).lastIndexOf(name);
  const first = (name) => ops.map((o) => o.op).indexOf(name);
  assert.ok(last('restore-agent') < first('verify-restore'));
  assert.ok(last('verify-restore') < first('delete-kb'));
  assert.ok(last('delete-kb') < first('restore-tool'));
  assert.ok(last('restore-tool') < first('delete-tool'));

  assert.deepEqual(ops.map((o) => o.method), ['PATCH', 'GET', 'DELETE', 'DELETE', 'PATCH', 'DELETE', 'DELETE']);
  assert.equal(ops[0].path, `/v1/convai/agents/${SELF}`);
  assert.equal(ops[1].path, `/v1/convai/agents/${SELF}`);
  assert.equal(ops[2].path, '/v1/convai/knowledge-base/kb_new_1');
  assert.equal(ops[5].path, '/v1/convai/tools/t_new_1');
});

test('rollback: restore-tool only for ids listed as UPDATED, with the captured (unredacted) body', () => {
  const cfg = webhookToolConfigWithSecrets();
  const before = captureRollbackState({ agent: liveAgent(), managedToolConfigs: { w_cat: cfg, t_nav: { name: 'navigate_to_tool' } } });
  const ops = planRollback(before, { updatedToolIds: ['w_cat', 'not_captured'] });
  const restores = ops.filter((o) => o.op === 'restore-tool');
  assert.deepEqual(restores.map((o) => o.path), ['/v1/convai/tools/w_cat']);
  assert.deepEqual(restores[0].body, { tool_config: cfg });
  assert.equal(restores[0].body.tool_config.api_schema.request_headers.Authorization, 'Bearer live-header-value-123');
  assert.equal(planRollback(before, {}).filter((o) => o.op === 'restore-tool').length, 0);
});

test('rollback: the restore PATCH carries every captured field — including llm, voice, auth and name', () => {
  const before = captureRollbackState({ agent: liveAgent() });
  const [restore] = planRollback(before, {});
  assert.deepEqual(restore.body, {
    name: 'toolkits bookkeeping siri',
    conversation_config: {
      agent: {
        prompt: {
          prompt: 'old prompt',
          tool_ids: ['f_1', 't_nav'],
          knowledge_base: [{ id: 'kb_old', name: DOC, type: 'text', usage_mode: 'prompt' }],
          llm: 'gemini-2.5-flash',
          temperature: 0.3,
          rag: { enabled: false },
        },
        first_message: 'Hi {{user_name}}',
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: { plan_label: 'Silver' } },
      },
      conversation: { max_duration_seconds: 600, client_events: ['audio', 'user_transcript'], text_only: false },
      tts: { voice_id: 'cjVigY5qzO86Huf0OWal', model_id: 'eleven_flash', stability: 0.5 },
      turn: { turn_timeout: 7 },
    },
    platform_settings: {
      auth: { enable_auth: true, allowlist: [{ hostname: 'toolkits.alexsagun.com' }] },
      widget: { variant: 'compact' },
      privacy: { record_voice: true },
    },
  });
});

test('rollback: the restore puts back the siblings this run never touched, not a truncated object', () => {
  // ★ THE DEFECT THIS PINS: the restore used to send
  //   conversation:{max_duration_seconds}, tts:{voice_id} and
  //   platform_settings:{auth:{enable_auth}}. If an ElevenLabs PATCH REPLACES a
  //   nested object rather than deep-merging it — an API shape this repo has NOT
  //   verified — that restore is itself what strips client_events, the TTS model,
  //   the auth allowlist and every widget and privacy setting from the live agent.
  //   A restore that sends too much is refused LOUDLY and caught by verify-restore;
  //   one that sends too little succeeds and leaves the agent quietly broken.
  const [restore] = planRollback(captureRollbackState({ agent: liveAgent() }), {});
  const cc = restore.body.conversation_config;
  assert.deepEqual(cc.conversation.client_events, ['audio', 'user_transcript']);
  assert.equal(cc.conversation.text_only, false);
  assert.equal(cc.tts.model_id, 'eleven_flash');
  assert.equal(cc.tts.stability, 0.5);
  assert.deepEqual(cc.turn, { turn_timeout: 7 });
  assert.deepEqual(cc.agent.dynamic_variables, { dynamic_variable_placeholders: { plan_label: 'Silver' } });
  assert.deepEqual(restore.body.platform_settings.auth.allowlist, [{ hostname: 'toolkits.alexsagun.com' }]);
  assert.deepEqual(restore.body.platform_settings.widget, { variant: 'compact' });
  assert.deepEqual(restore.body.platform_settings.privacy, { record_voice: true });

  // …and a capture that DID lose them cannot be papered over here: the restore
  // reports only what it was given.
  const narrowed = captureRollbackState({ agent: liveAgent() });
  narrowed.conversationConfig.conversation = { max_duration_seconds: 600 };
  const [fromNarrow] = planRollback(narrowed, {});
  assert.equal(fromNarrow.body.conversation_config.conversation.client_events, undefined);
});

test('rollback: fields that were ABSENT before are omitted, never written as null', () => {
  const before = captureRollbackState({ agent: { agent_id: SELF, conversation_config: { agent: { prompt: { tool_ids: [] } } } } });
  const [restore] = planRollback(before, {});
  assert.deepEqual(restore.body, { conversation_config: { agent: { prompt: { tool_ids: [], knowledge_base: [] } } } });
  assert.ok(!JSON.stringify(restore.body).includes('null'));
});

test('rollback: no captured agent id (the run created the agent) → no agent ops', () => {
  const before = captureRollbackState({ agent: {} });
  const ops = planRollback(before, { createdToolIds: ['t1'] });
  assert.deepEqual(ops.map((o) => o.op), ['delete-tool']);
  assert.ok(!ops.some((o) => /null|undefined/.test(o.path)));
});

test('rollback: only an EXPLICIT agentPatched:false skips the agent restore', () => {
  const before = captureRollbackState({ agent: liveAgent() });
  assert.equal(planRollback(before, { agentPatched: false }).length, 0);
  for (const agentPatched of [true, undefined, null, 0, '']) {
    assert.equal(planRollback(before, { agentPatched })[0].op, 'restore-agent', `agentPatched ${JSON.stringify(agentPatched)}`);
  }
  assert.equal(planRollback(before)[0].op, 'restore-agent');
});

test('rollback: mutating a planned body cannot corrupt the capture', () => {
  const before = captureRollbackState({ agent: liveAgent(), managedToolConfigs: { t_nav: { name: 'navigate_to_tool' } } });
  const snapshot = JSON.stringify(before);
  const ops = planRollback(before, { updatedToolIds: ['t_nav'] });
  ops[0].body.conversation_config.agent.prompt.tool_ids.push('x');
  ops[0].body.conversation_config.agent.prompt.knowledge_base[0].usage_mode = 'auto';
  ops.find((o) => o.op === 'restore-tool').body.tool_config.name = 'renamed';
  assert.equal(JSON.stringify(before), snapshot);
});

test('rollback: an applied list that is not an array of ids plans nothing from it', () => {
  const before = captureRollbackState({ agent: liveAgent(), managedToolConfigs: { t_nav: { name: 'navigate_to_tool' } } });
  // A bare string would otherwise be iterated one CHARACTER at a time.
  const ops = planRollback(before, { agentPatched: false, createdToolIds: 't_nav', createdKbIds: 'kb_1', updatedToolIds: 't_nav' });
  assert.deepEqual(ops, []);
  const mixed = planRollback(before, { agentPatched: false, createdToolIds: ['t_ok', '', null, 7, undefined] });
  assert.deepEqual(mixed.map((o) => o.path), ['/v1/convai/tools/t_ok']);
});

test('rollback: ids are URL-encoded into paths', () => {
  const before = captureRollbackState({ agent: { agent_id: 'a/b?c' } });
  const ops = planRollback(before, { createdKbIds: ['k#1'], createdToolIds: ['t 1'] });
  assert.equal(ops[0].path, '/v1/convai/agents/a%2Fb%3Fc');
  assert.equal(ops.find((o) => o.op === 'delete-kb').path, '/v1/convai/knowledge-base/k%231');
  assert.equal(ops.find((o) => o.op === 'delete-tool').path, '/v1/convai/tools/t%201');
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyApplied
// ─────────────────────────────────────────────────────────────────────────────

/** A post-run agent + read-back + expectations that verify cleanly. */
function verifiedFixture() {
  return {
    agent: {
      agent_id: SELF,
      conversation_config: {
        agent: {
          prompt: {
            prompt: `You are ${VOICE_ASSISTANT_SHORT_NAME}.`,
            tool_ids: ['f_1', 'n_nav', 'n_cat'],
            knowledge_base: [
              { id: 'kb_foreign', name: 'pricing-faq.md', usage_mode: 'auto' },
              { id: 'kb_new', name: DOC, usage_mode: 'prompt' },
            ],
            llm: 'gemini-2.5-flash',
          },
        },
        conversation: { max_duration_seconds: MAX_CONVERSATION_SECS },
        tts: { voice_id: 'cjVigY5qzO86Huf0OWal' },
      },
      platform_settings: { auth: { enable_auth: true } },
    },
    toolsById: {
      f_1: { id: 'f_1', name: 'someone_elses_tool', type: 'client' },
      n_nav: { id: 'n_nav', name: 'navigate_to_tool', type: 'client' },
      n_cat: { id: 'n_cat', name: 'get_my_training_catalog', type: 'webhook' },
    },
    expected: {
      foreignToolIds: ['f_1'],
      managedNames: ['navigate_to_tool', 'get_my_training_catalog'],
      managedIdByName: { navigate_to_tool: 'n_nav', get_my_training_catalog: 'n_cat' },
      kindByName: { navigate_to_tool: 'client', get_my_training_catalog: 'webhook' },
      kbDocId: 'kb_new',
      foreignKbIds: ['kb_foreign'],
      maxDurationSecs: MAX_CONVERSATION_SECS,
      promptSentinel: VOICE_ASSISTANT_SHORT_NAME,
      preserveLlm: 'gemini-2.5-flash',
      preserveVoiceId: 'cjVigY5qzO86Huf0OWal',
    },
    kbVerified: 'strong',
  };
}

function assertOneMismatch(mutate, pattern) {
  const f = verifiedFixture();
  mutate(f);
  const r = verifyApplied(f);
  assert.equal(r.ok, false, `expected a mismatch matching ${pattern}`);
  assert.equal(r.mismatches.length, 1, `expected exactly one mismatch, got ${JSON.stringify(r.mismatches)}`);
  assert.match(r.mismatches[0], pattern);
}

const promptOf = (f) => f.agent.conversation_config.agent.prompt;

test('verify: a clean run passes', () => {
  const r = verifyApplied(verifiedFixture());
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.ok, true);
  assert.equal(r.kbVerified, 'strong');
});

test('verify: a WEAK knowledge read-back passes but is reported as weak, never rounded up', () => {
  const r = verifyApplied({ ...verifiedFixture(), kbVerified: 'weak' });
  assert.equal(r.ok, true);
  assert.equal(r.kbVerified, 'weak');
});

test('verify: a knowledge document that was not read back at all is a mismatch', () => {
  assertOneMismatch((f) => { f.kbVerified = 'none'; }, /not read back/);
  assertOneMismatch((f) => { delete f.kbVerified; }, /not read back/);
});

test('verify: foreign tool dropped', () => {
  assertOneMismatch((f) => { promptOf(f).tool_ids = ['n_nav', 'n_cat']; }, /foreign tool f_1 was dropped/);
});

test('verify: managed tool not attached', () => {
  assertOneMismatch((f) => { promptOf(f).tool_ids = ['f_1', 'n_nav']; }, /managed tool "get_my_training_catalog" \(n_cat\) is not attached/);
});

test('verify: managed tool with no resolved id', () => {
  assertOneMismatch((f) => { delete f.expected.managedIdByName.navigate_to_tool; }, /no id resolved for managed tool "navigate_to_tool"/);
});

test('verify: managed tool could not be read back', () => {
  assertOneMismatch((f) => { delete f.toolsById.n_nav; }, /"navigate_to_tool" \(n_nav\) could not be read back/);
});

test('verify: managed tool has the wrong name', () => {
  assertOneMismatch((f) => { f.toolsById.n_nav.name = 'navigate_somewhere_else'; }, /tool n_nav is named "navigate_somewhere_else", expected "navigate_to_tool"/);
});

test('verify: managed tool has the wrong type', () => {
  assertOneMismatch((f) => { f.toolsById.n_cat.type = 'client'; }, /tool "get_my_training_catalog" is type "client", expected "webhook"/);
});

test('verify: a stale second copy of a managed tool left attached is a duplicate', () => {
  assertOneMismatch((f) => {
    promptOf(f).tool_ids.push('stale_nav');
    f.toolsById.stale_nav = { id: 'stale_nav', name: 'navigate_to_tool', type: 'client' };
  }, /duplicate managed tool name\(s\) attached: navigate_to_tool/);
});

test('verify: knowledge document missing', () => {
  assertOneMismatch((f) => { promptOf(f).knowledge_base = [{ id: 'kb_foreign', name: 'pricing-faq.md' }]; }, /knowledge document kb_new is not attached/);
});

test('verify: knowledge document attached with the wrong usage_mode', () => {
  assertOneMismatch((f) => { promptOf(f).knowledge_base[1].usage_mode = 'auto'; }, /usage_mode "auto", expected "prompt"/);
});

test('verify: foreign knowledge document dropped', () => {
  assertOneMismatch((f) => { promptOf(f).knowledge_base = [{ id: 'kb_new', name: DOC, usage_mode: 'prompt' }]; }, /foreign knowledge document kb_foreign was dropped/);
});

test('verify: signed-URL auth disabled', () => {
  assertOneMismatch((f) => { f.agent.platform_settings.auth.enable_auth = false; }, /authentication is not enabled/);
  assertOneMismatch((f) => { delete f.agent.platform_settings; }, /authentication is not enabled/);
});

test('verify: max duration wrong', () => {
  assertOneMismatch((f) => { f.agent.conversation_config.conversation.max_duration_seconds = 1800; }, /max_duration_seconds is 1800, expected 600/);
});

test('verify: prompt sentinel missing', () => {
  assertOneMismatch((f) => { promptOf(f).prompt = 'You are the Toolkits Guide.'; }, /does not mention "Toolkits Siri"/);
});

test('verify: llm changed', () => {
  assertOneMismatch((f) => { promptOf(f).llm = 'gpt-4o'; }, /llm changed from "gemini-2.5-flash" to "gpt-4o"/);
});

test('verify: voice changed', () => {
  assertOneMismatch((f) => { f.agent.conversation_config.tts.voice_id = 'other_voice'; }, /voice changed from "cjVigY5qzO86Huf0OWal" to "other_voice"/);
});

test('verify: an empty read-back fails loudly rather than passing vacuously', () => {
  const f = verifiedFixture();
  const r = verifyApplied({ agent: {}, toolsById: {}, expected: f.expected, kbVerified: 'none' });
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.length >= 5);
  assert.equal(verifyApplied().ok, false, 'auth is always required');
});
