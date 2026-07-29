#!/usr/bin/env node
// Uploads docs/ai/toolkits-voice-agent-knowledge.md to the ElevenLabs knowledge base and
// attaches it to the voice-assistant agent — replacing the previous version in place.
//
//   npm run ai:knowledge:push          (always regenerates the doc first — see package.json)
//   node scripts/push-voice-agent-knowledge.mjs --dry-run   (print the calls, no key needed)
//
// Stateless and idempotent by NAME: the KB document is always created under the fixed name
// (KB_DOC_NAME in _elevenlabs.mjs); the agent's knowledge_base list is patched to keep every
// OTHER document untouched, swap in the new one, and the detached old same-name documents are
// deleted. Running it twice leaves exactly one attached copy.
//
// Env (server-side only, from the shell or .env): ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID,
// optional ELEVENLABS_SERVER_LOCATION. Real env vars win over .env values.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, makeApi, attachKnowledgeDoc } from './_elevenlabs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = join(ROOT, 'docs', 'ai', 'toolkits-voice-agent-knowledge.md');
const DRY_RUN = process.argv.includes('--dry-run') || process.env.PROVISION_DRY_RUN === '1';
const log = (m) => console.log(`[ai:knowledge:push] ${m}`);

function fail(msg) {
  console.error(`\n[ai:knowledge:push] FAILED: ${msg}\n`);
  process.exit(1);
}

loadDotEnv(ROOT);
if (!DRY_RUN && !process.env.ELEVENLABS_API_KEY) fail('ELEVENLABS_API_KEY is not set (env or .env).');
const agentId = process.env.ELEVENLABS_AGENT_ID || (DRY_RUN ? 'dry-agent-id' : null);
if (!agentId) fail('ELEVENLABS_AGENT_ID is not set (env or .env).');
if (!existsSync(DOC_PATH)) fail(`${DOC_PATH} does not exist — run \`npm run ai:knowledge\` first.`);

const text = readFileSync(DOC_PATH, 'utf8');
const api = makeApi({ apiKey: process.env.ELEVENLABS_API_KEY, dryRun: DRY_RUN, log });

try {
  await attachKnowledgeDoc(api, agentId, text, log);
  log(DRY_RUN ? 'Dry run complete — no changes made.' : 'Done.');
} catch (err) {
  fail(err.message);
}
