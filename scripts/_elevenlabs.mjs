// Shared ElevenLabs REST helpers for the voice-agent scripts (push + provision).
// No dependencies beyond Node built-ins (global fetch, Node 18+). The generator script
// does NOT import this — it only reads source files and keeps its own copy of
// extractLiteral to stay a pure, side-effect-free build step.
//
// Env (server-side only): ELEVENLABS_API_KEY, optional ELEVENLABS_SERVER_LOCATION
// ('us' | 'eu-residency' | 'in-residency' or a full https base URL). Real env vars win
// over .env values.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The fixed name the knowledge-base document is always created under. The agent's
// knowledge_base list is reconciled by NAME so re-running leaves exactly one copy.
export const KB_DOC_NAME = 'toolkits-voice-agent-knowledge';

// Minimal .env fallback (Node 18-safe, no dotenv): fills only keys not already set in the
// environment. Handles KEY=VALUE lines, ignores comments/blank lines, strips optional
// surrounding quotes.
export function loadDotEnv(root) {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key] && val) process.env[key] = val;
  }
}

const LOCATION_BASES = {
  us: 'https://api.elevenlabs.io',
  'eu-residency': 'https://api.eu.residency.elevenlabs.io',
  'in-residency': 'https://api.in.residency.elevenlabs.io',
};
export function apiBase() {
  const loc = (process.env.ELEVENLABS_SERVER_LOCATION || '').trim();
  if (!loc) return LOCATION_BASES.us;
  if (/^https:\/\//i.test(loc)) return loc.replace(/\/+$/, '');
  return LOCATION_BASES[loc.toLowerCase()] || LOCATION_BASES.us;
}

// Plausible responses for --dry-run so the calling script's control flow works end-to-end
// without a key or any network call.
function dryResponse(method, path) {
  if (path === '/v1/convai/tools' && method === 'GET') return { tools: [] };
  if (path === '/v1/convai/tools' && method === 'POST') return { id: 'dry-tool-id', tool_id: 'dry-tool-id' };
  if (path.startsWith('/v1/convai/tools/')) return { id: path.split('/').pop() };
  if (path === '/v1/convai/agents/create') return { agent_id: 'dry-agent-id' };
  if (path.startsWith('/v1/convai/agents/') && method === 'GET') return { conversation_config: { agent: { prompt: {} } } };
  if (path.startsWith('/v1/convai/agents/')) return {}; // PATCH
  if (path === '/v1/convai/knowledge-base/text') return { id: 'dry-kb-id' };
  return {};
}

// Returns an `api(method, path, body)` helper bound to the given key. In dry-run it prints
// the request it WOULD make and returns a synthetic ok response — no network, no key needed.
export function makeApi({ apiKey, dryRun = false, log = () => {} }) {
  return async function api(method, path, body) {
    if (dryRun) {
      const preview = body ? ` ${JSON.stringify(body).slice(0, 160)}${JSON.stringify(body).length > 160 ? '…' : ''}` : '';
      log(`DRY-RUN ${method} ${path}${preview}`);
      return { ok: true, status: 200, json: dryResponse(method, path), text: '' };
    }
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        'xi-api-key': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, text };
  };
}

// Upload the knowledge-base text document and attach it to the agent — keeping every OTHER
// knowledge document, swapping in the new copy, and deleting the detached old same-name
// copies. Idempotent by name. Throws (with an actionable message) on any hard failure; the
// caller decides how to report it. Used by both push and provision so the KB reconcile
// logic lives in ONE place.
export async function attachKnowledgeDoc(api, agentId, text, log = () => {}) {
  // 1) Read the agent's current knowledge-base list.
  const agentRes = await api('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}`);
  if (!agentRes.ok) {
    throw new Error(`Could not read agent ${agentId} (${agentRes.status}): ${agentRes.text.slice(0, 300)}`);
  }
  const prompt = agentRes.json?.conversation_config?.agent?.prompt || {};
  const currentKb = Array.isArray(prompt.knowledge_base) ? prompt.knowledge_base : [];
  const oldOurs = currentKb.filter((d) => d?.name === KB_DOC_NAME);
  const foreign = currentKb.filter((d) => d?.name !== KB_DOC_NAME);

  // 2) Create the new KB text document.
  const createRes = await api('POST', '/v1/convai/knowledge-base/text', { text, name: KB_DOC_NAME });
  if (!createRes.ok || !createRes.json?.id) {
    throw new Error(`Could not create the knowledge-base document (${createRes.status}): ${createRes.text.slice(0, 300)}`);
  }
  const newId = createRes.json.id;
  log(`Created KB document ${newId} ("${KB_DOC_NAME}").`);

  // 3) Re-attach: keep every foreign document, swap in the new one. The full existing prompt
  // object is sent back so a partial PATCH can't drop other prompt fields.
  const newKb = [...foreign, { type: 'text', name: KB_DOC_NAME, id: newId, usage_mode: 'prompt' }];
  const nextPrompt = { ...prompt, knowledge_base: newKb };
  // A prompt may not carry BOTH `tools` (deprecated inline) and `tool_ids`. Once tool_ids is
  // set, the agent GET echoes back an (empty) `tools` alongside it; sending both in a PATCH is
  // a 400 ("Cannot specify both tools and tool IDs"). We manage tools via tool_ids, so drop
  // the echoed `tools` whenever tool_ids is present.
  if (nextPrompt.tool_ids != null && nextPrompt.tools != null) delete nextPrompt.tools;
  const patchRes = await api('PATCH', `/v1/convai/agents/${encodeURIComponent(agentId)}`, {
    conversation_config: { agent: { prompt: nextPrompt } },
  });
  if (!patchRes.ok) {
    throw new Error(`Created document ${newId} but could not attach it to the agent (${patchRes.status}): ${patchRes.text.slice(0, 300)}. Attach it manually in the dashboard.`);
  }
  log(`Attached to agent ${agentId} (${foreign.length} other KB doc(s) untouched).`);

  // 4) Delete the detached old copies (best-effort — they are no longer referenced).
  for (const doc of oldOurs) {
    if (!doc?.id || doc.id === newId) continue;
    const del = await api('DELETE', `/v1/convai/knowledge-base/${encodeURIComponent(doc.id)}`);
    log(del.ok
      ? `Deleted old KB document ${doc.id}.`
      : `WARN: could not delete old KB document ${doc.id} (${del.status}) — remove it in the dashboard.`);
  }
  return newId;
}

// Anchored balanced-bracket extraction of a PURE module-scope literal from a source string
// (mirrors the copy in scripts/generate-voice-agent-knowledge.mjs). Honors string/template
// literals with escapes and // + /* */ comments so braces inside them never unbalance the
// count. Evaluates the snippet with `new Function`. Throws on missing/unbalanced/impure.
export function extractLiteral(src, name) {
  const anchor = `const ${name} = `;
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error(`Literal "${name}" not found in source — it moved or was renamed.`);
  let i = at + anchor.length;
  while (i < src.length && src[i] !== '[' && src[i] !== '{') i++;
  const open = src[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let end = -1;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      j++;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      continue;
    }
    if (ch === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (ch === '/' && src[j + 1] === '*') { j += 2; while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++; j++; continue; }
    if (ch === open) depth++;
    if (ch === close) { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end === -1) throw new Error(`Literal "${name}" has unbalanced brackets.`);
  const snippet = src.slice(i, end + 1);
  try {
    return new Function(`return (${snippet});`)();
  } catch (err) {
    throw new Error(`Literal "${name}" is not a PURE literal (${err.message}). Keep it free of refs/calls.`);
  }
}

// Extract the first fenced ``` code block that appears after `marker` in a markdown string,
// dedenting by the fence's own indentation (the setup doc nests fences under list items).
// Used by provision to source the agent's system prompt + first message from the doc, so
// the human-facing doc and the provisioned agent can never diverge.
export function fencedBlockAfter(md, marker) {
  const at = md.indexOf(marker);
  if (at === -1) throw new Error(`Marker "${marker}" not found in the setup doc.`);
  const lines = md.slice(at).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
  if (i >= lines.length) throw new Error(`No opening code fence after "${marker}" in the setup doc.`);
  const indent = (lines[i].match(/^(\s*)```/) || [null, ''])[1];
  i++;
  const out = [];
  for (; i < lines.length; i++) {
    if (/^\s*```\s*$/.test(lines[i])) {
      const dedented = out.map((l) => {
        let k = 0;
        while (k < indent.length && (l[k] === ' ' || l[k] === '\t')) k++;
        return l.slice(k);
      });
      return dedented.join('\n').trim();
    }
    out.push(lines[i]);
  }
  throw new Error(`Unterminated code fence after "${marker}" in the setup doc.`);
}
