#!/usr/bin/env node
// Provisions the ElevenLabs "Toolkits Guide" voice agent end-to-end from the repo, so the
// only manual step is providing an API key:
//
//   npm run ai:provision                         (regenerates the KB doc first, then this)
//   node scripts/provision-voice-agent.mjs --dry-run   (print every call, no key needed)
//
// What it does, idempotently:
//   1. Creates/updates the CLIENT tools from VOICE_CLIENT_TOOL_SPECS AND the AI-course-trainer
//      WEBHOOK (server) tools from VOICE_SERVER_TOOL_SPECS (both single-source-of-truth pure
//      literals in src/BookkeeperPro.jsx — extracted verbatim so the agent's tool names +
//      schemas can never drift from the code), matched by name. Webhook tools point at
//      `${APP_URL}/api/elevenlabs/trainer?action=<action>` and carry the secret dynamic
//      variable `{{secret__trainer_token}}` in their Authorization header (headers only —
//      never visible to the LLM). APP_URL unset → webhook tools are SKIPPED with a loud
//      warning (client-only setup still works; ElevenLabs cannot call localhost anyway).
//   2. Creates (or updates, if ELEVENLABS_AGENT_ID is set) the agent: system prompt + first
//      message sourced from docs/ai/voice-agent-setup.md (§3, so doc and agent stay in sync),
//      the tool ids from step 1, signed-URL auth ON, and a max-duration cost cap.
//   3. Uploads + attaches the generated knowledge-base document (shared logic with
//      ai:knowledge:push).
//   4. Prints the agent id to copy into ELEVENLABS_AGENT_ID (.env + Vercel).
//
// Env (server-side only, from the shell or .env): ELEVENLABS_API_KEY (required unless
// --dry-run); optional ELEVENLABS_AGENT_ID (update in place vs create), ELEVENLABS_VOICE_ID,
// ELEVENLABS_AGENT_LLM, ELEVENLABS_SERVER_LOCATION, APP_URL (the deployed origin the webhook
// tools call — e.g. https://toolkits.alexsagun.com). Real env vars win over .env values.
//
// API-shape note: ElevenLabs revised the tools API in 2026 (inline agent tools deprecated in
// favor of standalone tools referenced by tool_ids). The client tool_config body is built in
// ONE place (toolConfigFor) and every tool/agent failure prints the request + ElevenLabs'
// own response, so if a field name has changed the error names it and the fix is local.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, makeApi, attachKnowledgeDoc, extractLiteral, fencedBlockAfter } from './_elevenlabs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'BookkeeperPro.jsx');
const SETUP_DOC = join(ROOT, 'docs', 'ai', 'voice-agent-setup.md');
const KB_PATH = join(ROOT, 'docs', 'ai', 'toolkits-voice-agent-knowledge.md');

const DRY_RUN = process.argv.includes('--dry-run') || process.env.PROVISION_DRY_RUN === '1';
const AGENT_NAME = 'Toolkits Guide by Alex';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel — swap in the dashboard or via env
const LLM = process.env.ELEVENLABS_AGENT_LLM || 'gpt-4o-mini';
const LANGUAGE = 'en';
const MAX_DURATION = 600; // seconds — cost cap
const TOOL_TIMEOUT = 20;  // seconds the agent waits for a client tool result

const log = (m) => console.log(`[ai:provision] ${m}`);
const warn = (m) => console.warn(`[ai:provision] WARN: ${m}`);
function fail(msg) {
  console.error(`\n[ai:provision] FAILED: ${msg}\n`);
  process.exit(1);
}

// ── Inputs ───────────────────────────────────────────────────────────────────
loadDotEnv(ROOT);
if (!DRY_RUN && !process.env.ELEVENLABS_API_KEY) {
  fail('ELEVENLABS_API_KEY is not set (env or .env). Add your ElevenLabs key, or pass --dry-run to preview.');
}
if (!existsSync(KB_PATH)) fail(`${KB_PATH} does not exist — run \`npm run ai:knowledge\` first (or use \`npm run ai:provision\`, which chains it).`);
if (!existsSync(SOURCE)) fail(`${SOURCE} not found.`);
if (!existsSync(SETUP_DOC)) fail(`${SETUP_DOC} not found — the system prompt is sourced from it.`);

const sourceText = readFileSync(SOURCE, 'utf8');
let TOOL_SPECS;
try {
  TOOL_SPECS = extractLiteral(sourceText, 'VOICE_CLIENT_TOOL_SPECS');
} catch (err) {
  fail(`Could not extract VOICE_CLIENT_TOOL_SPECS from src/BookkeeperPro.jsx (${err.message}). Keep it a pure literal.`);
}
if (!Array.isArray(TOOL_SPECS) || TOOL_SPECS.length === 0 || TOOL_SPECS.some((t) => !t?.name || !t?.parameters)) {
  fail('VOICE_CLIENT_TOOL_SPECS is empty or malformed (each entry needs a name + parameters).');
}

let SERVER_TOOL_SPECS;
try {
  SERVER_TOOL_SPECS = extractLiteral(sourceText, 'VOICE_SERVER_TOOL_SPECS');
} catch (err) {
  fail(`Could not extract VOICE_SERVER_TOOL_SPECS from src/BookkeeperPro.jsx (${err.message}). Keep it a pure literal.`);
}
if (!Array.isArray(SERVER_TOOL_SPECS) || SERVER_TOOL_SPECS.some((t) => !t?.name || !t?.action || !t?.request_body_schema)) {
  fail('VOICE_SERVER_TOOL_SPECS is malformed (each entry needs name + action + request_body_schema).');
}
{
  const all = [...TOOL_SPECS, ...SERVER_TOOL_SPECS].map((t) => t.name);
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  if (dupes.length) fail(`Duplicate tool names across VOICE_CLIENT_TOOL_SPECS + VOICE_SERVER_TOOL_SPECS: ${[...new Set(dupes)].join(', ')}`);
}

// The deployed origin the webhook tools call. Reuses APP_URL (already documented for the
// notify emails). Without it we can still provision the client tools — but the trainer's
// webhook tools would point nowhere, so they're skipped loudly instead of created broken.
const APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
const WEBHOOK_BASE = APP_URL || (DRY_RUN ? 'https://YOUR-DEPLOYED-APP.example' : '');

const setupMd = readFileSync(SETUP_DOC, 'utf8');
let SYSTEM_PROMPT, FIRST_MESSAGE;
try {
  SYSTEM_PROMPT = fencedBlockAfter(setupMd, '**System prompt**');
  FIRST_MESSAGE = fencedBlockAfter(setupMd, '**First message**');
} catch (err) {
  fail(`Could not read the system prompt / first message from docs/ai/voice-agent-setup.md (${err.message}). Keep §3's fenced blocks intact.`);
}
if (!/Toolkits Guide/i.test(SYSTEM_PROMPT)) fail('The extracted system prompt looks wrong (no "Toolkits Guide" sentinel) — check §3 of the setup doc.');
if (!/\{\{\s*user_name\s*\}\}/.test(FIRST_MESSAGE)) warn('First message has no {{user_name}} variable — double-check §3 of the setup doc.');

const api = makeApi({ apiKey: process.env.ELEVENLABS_API_KEY, dryRun: DRY_RUN, log });

log(DRY_RUN ? 'DRY RUN — no key used, no changes made.' : `Provisioning against ${process.env.ELEVENLABS_SERVER_LOCATION || 'us'} …`);

// ── 1) Tools (create or update by name) ──────────────────────────────────────
function toolConfigFor(spec) {
  return {
    type: 'client',
    name: spec.name,
    description: spec.description || '',
    expects_response: spec.expects_response !== false,
    response_timeout_secs: TOOL_TIMEOUT,
    parameters: spec.parameters,
  };
}

// AI-course-trainer webhook (server) tool. The Authorization header interpolates the
// secret dynamic variable the browser passes at startSession — ElevenLabs substitutes
// it into HEADERS only, never the LLM context. If ElevenLabs ever rejects the plain
// object header map, the documented fallback is the array form:
//   request_headers: [{ type: 'value', name: 'Authorization', value: 'Bearer {{secret__trainer_token}}' }]
// — change it HERE only (this is the single place webhook bodies are built).
function webhookToolConfigFor(spec, baseUrl) {
  return {
    type: 'webhook',
    name: spec.name,
    description: spec.description || '',
    response_timeout_secs: spec.response_timeout_secs || TOOL_TIMEOUT,
    api_schema: {
      url: `${baseUrl}/api/elevenlabs/trainer?action=${encodeURIComponent(spec.action)}`,
      method: 'POST',
      request_headers: {
        'Authorization': 'Bearer {{secret__trainer_token}}',
        'Content-Type': 'application/json',
      },
      request_body_schema: spec.request_body_schema,
    },
    dynamic_variables: {
      dynamic_variable_placeholders: { secret__trainer_token: '' },
    },
  };
}

async function ensureTools() {
  const listRes = await api('GET', '/v1/convai/tools');
  if (!listRes.ok) fail(`Could not list tools (${listRes.status}): ${listRes.text.slice(0, 300)}`);
  const existing = Array.isArray(listRes.json) ? listRes.json : (listRes.json?.tools || []);
  const byName = new Map();
  for (const t of existing) {
    const name = t?.name ?? t?.tool_config?.name;
    const id = t?.id ?? t?.tool_id;
    if (name && id) byName.set(name, id);
  }

  const plans = TOOL_SPECS.map((spec) => ({ spec, kind: 'client', config: toolConfigFor(spec) }));
  if (WEBHOOK_BASE) {
    for (const spec of SERVER_TOOL_SPECS) plans.push({ spec, kind: 'webhook', config: webhookToolConfigFor(spec, WEBHOOK_BASE) });
  } else {
    warn('APP_URL is not set — SKIPPING the 4 trainer webhook tools. ElevenLabs cannot call localhost;');
    warn('set APP_URL to your deployed origin (e.g. https://toolkits.alexsagun.com) and re-run to add them.');
  }

  const ids = [];
  const failed = [];
  for (const { spec, kind, config } of plans) {
    const body = { tool_config: config };
    const existingId = byName.get(spec.name);
    const res = existingId
      ? await api('PATCH', `/v1/convai/tools/${encodeURIComponent(existingId)}`, body)
      : await api('POST', '/v1/convai/tools', body);
    const id = res.json?.id ?? res.json?.tool_id ?? existingId;
    if (res.ok && id) {
      ids.push(id);
      log(`${existingId ? 'Updated' : 'Created'} ${kind} tool "${spec.name}" (${id}).`);
    } else {
      failed.push(spec.name);
      warn(`Tool "${spec.name}" ${existingId ? 'update' : 'create'} failed (${res.status}): ${res.text.slice(0, 300)}`);
      warn(`  Request tool_config was: ${JSON.stringify(body.tool_config)}`);
    }
  }
  if (failed.length) {
    warn(`${failed.length} tool(s) failed: ${failed.join(', ')}. The agent will be created with the ${ids.length} that succeeded; fix the tool_config shape (see the error above) and re-run to attach the rest.`);
  }
  return ids;
}

// ── 2) Agent (create, or update ELEVENLABS_AGENT_ID in place) ─────────────────
async function ensureAgent(toolIds) {
  const platform_settings = { auth: { enable_auth: true } };
  // No dry-run fallback here: with ELEVENLABS_AGENT_ID unset we take the CREATE path (the
  // representative first-run), whose synthetic response returns an id for the KB step.
  const agentId = process.env.ELEVENLABS_AGENT_ID || null;

  if (agentId) {
    // Update in place. The app-integration contract IS set authoritatively (system prompt,
    // first message, client tools, auth, max-duration), but PRESERVE the agent's dashboard
    // choices — voice + LLM + any other prompt fields like knowledge_base — unless explicitly
    // overridden via env. Alex created this agent in the dashboard, so re-provisioning must
    // not silently reset the voice he picked. (`...curPrompt` already keeps the current llm;
    // `tts` is omitted entirely unless overridden so PATCH leaves the voice untouched.)
    const cur = await api('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}`);
    if (!cur.ok) fail(`ELEVENLABS_AGENT_ID=${agentId} could not be read (${cur.status}): ${cur.text.slice(0, 300)}`);
    const curPrompt = cur.json?.conversation_config?.agent?.prompt || {};
    const prompt = { ...curPrompt, prompt: SYSTEM_PROMPT, tool_ids: toolIds };
    if (prompt.tools != null) delete prompt.tools; // manage tools via tool_ids; sending both is a 400
    if (process.env.ELEVENLABS_AGENT_LLM) prompt.llm = LLM; // else keep the agent's existing llm
    const conversation_config = {
      agent: { prompt, first_message: FIRST_MESSAGE, language: LANGUAGE },
      conversation: { max_duration_seconds: MAX_DURATION },
    };
    if (process.env.ELEVENLABS_VOICE_ID) conversation_config.tts = { voice_id: VOICE_ID }; // else keep the dashboard voice
    const res = await api('PATCH', `/v1/convai/agents/${encodeURIComponent(agentId)}`, { conversation_config, platform_settings });
    if (!res.ok) fail(`Could not update agent ${agentId} (${res.status}): ${res.text.slice(0, 300)}`);
    log(`Updated agent ${agentId}${process.env.ELEVENLABS_VOICE_ID ? '' : ' (kept its dashboard voice)'}.`);
    return agentId;
  }

  const body = {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        prompt: { prompt: SYSTEM_PROMPT, llm: LLM, tool_ids: toolIds },
        first_message: FIRST_MESSAGE,
        language: LANGUAGE,
      },
      tts: { voice_id: VOICE_ID },
      conversation: { max_duration_seconds: MAX_DURATION },
    },
    platform_settings,
  };
  const res = await api('POST', '/v1/convai/agents/create', body);
  const newId = res.json?.agent_id ?? res.json?.id;
  if (!res.ok || !newId) fail(`Could not create the agent (${res.status}): ${res.text.slice(0, 300)}`);
  log(`Created agent "${AGENT_NAME}" (${newId}).`);
  return newId;
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  const toolIds = await ensureTools();
  const agentId = await ensureAgent(toolIds);
  await attachKnowledgeDoc(api, agentId, readFileSync(KB_PATH, 'utf8'), log);

  console.log('\n────────────────────────────────────────────────────────');
  if (DRY_RUN) {
    console.log('[ai:provision] DRY RUN complete — nothing was created. Re-run without --dry-run (and with ELEVENLABS_API_KEY set) to apply.');
  } else {
    console.log(`[ai:provision] Done. Agent id: ${agentId}`);
    console.log('[ai:provision] Next: set ELEVENLABS_AGENT_ID to that id in .env AND in Vercel (Production + Preview), then redeploy.');
    console.log('[ai:provision] Verify the client tools + the 4 trainer webhook tools (Authorization: Bearer {{secret__trainer_token}}) + signed-URL auth in the ElevenLabs dashboard, and pick a brand voice if you want (ELEVENLABS_VOICE_ID).');
    if (!APP_URL) console.log('[ai:provision] REMINDER: the trainer webhook tools were SKIPPED (APP_URL unset) — see the warning above.');
  }
  console.log('────────────────────────────────────────────────────────\n');
} catch (err) {
  fail(err.message);
}
