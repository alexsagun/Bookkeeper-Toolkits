// ─────────────────────────────────────────────────────────────────────────────
// Toolkits Siri — the provisioning PLANNER.
//
// PURE. No fetch, no fs, no env reads. scripts/provision-voice-agent.mjs is the
// I/O shell: it gathers, this decides, it applies, this verifies, and this says
// how to undo it. The split exists because nothing in this repo imported those
// scripts and therefore nothing tested them — and what they do is mutate a live,
// paid, customer-facing agent.
//
// The state machine the shell runs:
//
//   PREFLIGHT → PLAN → CAPTURE → APPLY(tools → agent → kb) → VERIFY → COMMIT
//                                                              ↓ fail
//                                                           ROLLBACK
//
// Several rules here were each written against a specific way the previous
// script could damage the live agent. They are called out at their function.
//
// What the shell calls, in order:
//
//   managedToolManifest · validateToolSpecs · voicePreflight
//   planToolReconciliation → nextToolIds          ← the agent's next tool_ids
//   planKnowledgeReconciliation → nextKnowledgeBase  ← its next knowledge_base
//                              → planKnowledgeOps    ← attach, THEN delete
//   captureRollbackState · redactRollbackState · verifyApplied · planRollback
//
// ★ THE TWO `next*` BUILDERS ARE ALL-OR-NOTHING AND MUST NOT BE BYPASSED. The
//   agent PATCH REPLACES both lists outright, so a list assembled by hand from a
//   partially-successful apply does not mean "most of it worked" — it silently
//   DETACHES everything missing from it, which is how the AI course trainer was
//   lost. Each returns null for "abort before the agent PATCH and unwind"; null
//   is never a list to send, and never a reason to send a shorter one.
//
// ★ UNKNOWN IS NEVER "NONE". Every input here that describes live state — a
//   tool's dependents, a knowledge document's dependents, the trainer's health,
//   whether the agent could be read, how many webhook tools it carries — is
//   either positively KNOWN or treated as the dangerous case. A lookup that
//   failed must never be read as "nobody else uses this", because that is the
//   one reading that licenses a PATCH or a DELETE against another agent.
//   test/voiceProvisioning.test.mjs pins each of these separately.
// ─────────────────────────────────────────────────────────────────────────────

/** Default per-tool response timeout, in seconds. */
export const TOOL_TIMEOUT_SECS = 20;

/** The conversation cap, in seconds. A cost ceiling; do not raise it casually. */
export const MAX_CONVERSATION_SECS = 600;

const hasOwn = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/** An absolute http(s) origin with a host. A webhook base must be one. */
const ABSOLUTE_HTTP_URL_RE = /^https?:\/\/[^/\s?#]+/i;

/** A structural copy of plain JSON-shaped data, so a capture can never alias its source. */
function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneData(v);
    return out;
  }
  return value;
}

/**
 * The dependents of a tool or document OTHER than `agentId`, or null when they
 * are not known.
 *
 * ★ ONLY AN EXPLICIT ARRAY IS KNOWN. `undefined`, `null`, or anything else means
 *   the lookup did not happen or did not succeed, and the caller must treat it as
 *   "may belong to another agent". The previous `(x.dependents || [])` turned a
 *   failed lookup into an empty list — i.e. into permission to PATCH or DELETE.
 *
 * Entries may be agent id strings or `{ id | agent_id }` objects (the shape the
 * dependent-agents endpoint returns). An ENTRY with no readable id — an object
 * without one, a null, an empty string — is an agent the API key cannot see, and
 * it counts as ANOTHER agent, never as this one and never as nothing. Skipping
 * such an entry would be the same fail-open reading one level down: the array
 * says something depends on this, and we would have answered "nobody does".
 * Counting it costs at worst an orphan tool in the workspace.
 *
 * `agentId` empty means we do not know which agent we are, so no entry can be
 * recognised as self and every one of them counts — fail closed there too.
 */
function otherDependents(dependents, agentId) {
  if (!Array.isArray(dependents)) return null;
  const others = [];
  for (const d of dependents) {
    let id = null;
    if (typeof d === 'string') id = d;
    else if (d && typeof d === 'object') id = (typeof d.id === 'string' && d.id) || (typeof d.agent_id === 'string' && d.agent_id) || null;
    if (id && agentId && id === agentId) continue;
    others.push(id || '<unidentified agent>');
  }
  return others;
}

// ─────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────

function clientToolConfig(spec, timeout) {
  return {
    type: 'client',
    name: spec.name,
    description: spec.description || '',
    expects_response: spec.expects_response !== false,
    response_timeout_secs: timeout,
    parameters: spec.parameters,
  };
}

function webhookToolConfig(spec, baseUrl, timeout) {
  return {
    type: 'webhook',
    name: spec.name,
    description: spec.description || '',
    response_timeout_secs: spec.response_timeout_secs || timeout,
    api_schema: {
      url: `${baseUrl}/api/elevenlabs/trainer?action=${encodeURIComponent(spec.action)}`,
      method: 'POST',
      request_headers: {
        // ElevenLabs substitutes a `secret__` dynamic variable into HEADERS only —
        // it is never exposed to the LLM. The browser supplies it from the
        // signed-url mint. If the API ever rejects this object form, the array
        // form is the documented fallback and this is the ONE place to change it
        // (redactRollbackState already handles both forms):
        //   [{ type: 'value', name: 'Authorization', value: 'Bearer {{secret__trainer_token}}' }]
        Authorization: 'Bearer {{secret__trainer_token}}',
        'Content-Type': 'application/json',
      },
      request_body_schema: spec.request_body_schema,
    },
    dynamic_variables: { dynamic_variable_placeholders: { secret__trainer_token: '' } },
  };
}

/**
 * The exact set of tools this repo OWNS on the agent, and their bodies.
 *
 * ★ THE MANIFEST IS AN ALLOWLIST, AND THAT IS ITS WHOLE POINT. The previous
 *   script listed the WORKSPACE's tools and PATCHed anything, anywhere in the
 *   account, whose name matched — so provisioning this product could silently
 *   rewrite a tool belonging to an unrelated agent. Nothing outside these names
 *   is ever written, and nothing outside them is ever removed from the agent.
 *
 * `webhookBase` null/empty means the webhook tools are not planned at all — the
 * caller must have decided that deliberately (see voicePreflight, which refuses
 * to reach that state by accident). Trailing slashes are stripped; a base that is
 * nothing BUT slashes counts as empty, because it would otherwise produce a
 * relative webhook URL ElevenLabs can never call.
 *
 * ★ `clientOnly` OVERRIDES THE BASE, and that is the point of it existing. The
 *   shell resolves `webhookBase` from APP_URL, while `--client-only` is a separate
 *   flag that waives the webhook BLOCKERS in voicePreflight. A shell that passes
 *   the resolved base and forgets the flag here would sail through a waived
 *   preflight and then create and attach the four trainer tools the operator
 *   explicitly opted out of — pointed at a deployment whose TRAINER_TOKEN_SECRET
 *   is exactly what is missing. Passing the same flag to both makes the two
 *   physically unable to disagree, whichever way round the caller supplies it.
 *
 * `includesWebhooks` is DERIVED from the entries actually planned, never from
 * `serverSpecs.length` — a spec array holding only unusable entries plans no
 * webhook tools, and must not report that it did.
 */
export function managedToolManifest({
  clientSpecs = [],
  serverSpecs = [],
  webhookBase = '',
  clientOnly = false,
  toolTimeoutSecs = TOOL_TIMEOUT_SECS,
} = {}) {
  const clients = Array.isArray(clientSpecs) ? clientSpecs : [];
  const servers = Array.isArray(serverSpecs) ? serverSpecs : [];
  const base = (!clientOnly && webhookBase) ? String(webhookBase).trim().replace(/\/+$/, '') : '';

  const entries = [];
  for (const spec of clients) {
    if (!spec) continue;
    entries.push({ name: spec.name, kind: 'client', config: clientToolConfig(spec, toolTimeoutSecs) });
  }
  if (base) {
    for (const spec of servers) {
      if (!spec) continue;
      entries.push({ name: spec.name, kind: 'webhook', config: webhookToolConfig(spec, base, toolTimeoutSecs) });
    }
  }
  const names = entries.map((e) => e.name);
  return {
    entries,
    names,
    byName: new Map(entries.map((e) => [e.name, e])),
    includesWebhooks: entries.some((e) => e.kind === 'webhook'),
  };
}

/** Structural validation of the two spec arrays. Returns a list of problems. */
export function validateToolSpecs({ clientSpecs, serverSpecs } = {}) {
  const problems = [];
  if (!Array.isArray(clientSpecs) || clientSpecs.length === 0) {
    problems.push('VOICE_CLIENT_TOOL_SPECS is missing or empty.');
  } else {
    for (const s of clientSpecs) {
      if (!s || typeof s.name !== 'string' || !s.name) problems.push('A client tool spec has no name.');
      else if (!s.parameters || typeof s.parameters !== 'object') problems.push(`Client tool "${s.name}" has no parameters schema.`);
    }
  }
  if (!Array.isArray(serverSpecs)) {
    problems.push('VOICE_SERVER_TOOL_SPECS is missing.');
  } else {
    for (const s of serverSpecs) {
      if (!s || typeof s.name !== 'string' || !s.name) problems.push('A server tool spec has no name.');
      else if (typeof s.action !== 'string' || !s.action) problems.push(`Server tool "${s.name}" has no action.`);
      else if (!s.request_body_schema || typeof s.request_body_schema !== 'object') problems.push(`Server tool "${s.name}" has no request_body_schema.`);
    }
  }
  const all = [
    ...(Array.isArray(clientSpecs) ? clientSpecs : []),
    ...(Array.isArray(serverSpecs) ? serverSpecs : []),
  ];
  const names = all.map((s) => s && s.name).filter(Boolean);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) problems.push(`Duplicate tool name(s) across the spec arrays: ${[...new Set(dupes)].join(', ')}.`);
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything that must be true before a single mutation is sent.
 *
 * ★ A MISSING APP_URL IS FATAL, NOT A WARNING. The previous script warned and
 *   carried on: the webhook specs never entered its plan, so their ids never
 *   entered `tool_ids`, so the agent PATCH REPLACED the agent's tool list with
 *   the client-only one — silently detaching a working AI course trainer. A
 *   partial configuration is worse than no run at all. An APP_URL that is
 *   present but not an absolute http(s) URL is its own blocker (BAD_APP_URL) so
 *   the operator is sent to the typo rather than to the deployment.
 *
 * ★ TRAINER HEALTH IS CHECKED AGAINST THE DEPLOYED APP, not against local env.
 *   On 2026-09-16 production answered `configured:false` because
 *   TRAINER_TOKEN_SECRET was unset in Vercel — so the four webhook tools would
 *   have been attached to a live agent and every trainer call would have answered
 *   "not configured" to a paying learner mid-lesson. `trainerHealth` is the
 *   already-fetched `GET ${APP_URL}/api/elevenlabs/trainer` body, or null when the
 *   check could not be run — which is itself a blocker, not a pass.
 *
 * ★ LIVE FACTS MUST BE ASSERTED, NOT DEFAULTED. `agentReadable` and
 *   `agentWebhookToolCount` default to null ("not established"). With an
 *   ELEVENLABS_AGENT_ID set, only `agentReadable === true` passes, and
 *   `--client-only` needs a finite webhook count — a shell that forgot to look
 *   is refused rather than waved through.
 *
 * ★ AN EMPTY PROMPT SENTINEL IS A BLOCKER. The sentinel is the check that the
 *   right prompt is about to be published; skipping it because the caller passed
 *   nothing would turn a broken import into a silent pass.
 *
 * `--client-only` is the escape hatch, and it is deliberately narrow: it is
 *   refused when the agent already HAS webhook tools attached (or that could not
 *   be established), because in that case it is not "skip the trainer", it is
 *   "remove the trainer".
 *
 * `knowledgeInvariantFailures` accepts strings (voiceKnowledge's
 * `knowledgeInvariantFailures()` output) or `{ id, message }` result objects.
 */
export function voicePreflight({
  dryRun = false,
  clientOnly = false,
  apiKey = '',
  agentId = '',
  appUrl = '',
  trainerSecret = '',
  knowledgeDocExists = false,
  knowledgeDrift = false,
  knowledgeInvariantFailures = [],
  systemPrompt = '',
  firstMessage = '',
  promptSentinel = '',
  clientSpecs = [],
  serverSpecs = [],
  trainerHealth = null,
  agentReadable = null,
  agentWebhookToolCount = null,
  voiceIdOverride = '',
  llmOverride = '',
} = {}) {
  const blockers = [];
  const warnings = [];
  const block = (code, message, fix) => blockers.push({ code, message, fix });

  if (!apiKey && !dryRun) {
    block('NO_API_KEY', 'ELEVENLABS_API_KEY is not set.',
      'Add it to .env (Profile → API keys at elevenlabs.io), or pass --dry-run to preview.');
  }

  if (!knowledgeDocExists) {
    block('NO_KNOWLEDGE_DOC', 'docs/ai/toolkits-voice-agent-knowledge.md does not exist.',
      'Run `npm run ai:knowledge`.');
  } else if (knowledgeDrift) {
    block('KNOWLEDGE_DRIFT', 'The knowledge document no longer matches the code.',
      'Run `npm run ai:knowledge` and commit the result. A hand-edited document must never be published.');
  }
  const invariantLines = (Array.isArray(knowledgeInvariantFailures) ? knowledgeInvariantFailures : [])
    .filter((f) => f != null && f !== '')
    .map((f) => (typeof f === 'string' ? f : `[${f.id || 'invariant'}] ${f.message || 'failed'}`));
  if (invariantLines.length) {
    block('KNOWLEDGE_INVARIANT', `The knowledge document fails ${invariantLines.length} semantic check(s).`,
      invariantLines.join('\n'));
  }

  for (const problem of validateToolSpecs({ clientSpecs, serverSpecs })) {
    block('BAD_TOOL_SPEC', problem, 'Fix the literal in src/BookkeeperPro.jsx — it is parsed out of the source text.');
  }

  if (!systemPrompt) {
    block('NO_SYSTEM_PROMPT', 'The system prompt could not be read from docs/ai/voice-agent-setup.md.',
      'Keep §3’s "**System prompt**" fenced block intact.');
  } else if (!promptSentinel) {
    block('PROMPT_SENTINEL', 'No prompt sentinel was supplied, so the prompt about to be published cannot be recognised.',
      'Pass VOICE_ASSISTANT_SHORT_NAME from src/lib/voiceAccess.js as the sentinel.');
  } else if (!systemPrompt.includes(promptSentinel)) {
    block('PROMPT_SENTINEL', `The system prompt does not mention "${promptSentinel}".`,
      'The prompt in §3 must name the assistant, or the wrong prompt is about to be published.');
  }
  if (!firstMessage) {
    block('NO_FIRST_MESSAGE', 'The first message could not be read from docs/ai/voice-agent-setup.md.',
      'Keep §3’s "**First message**" fenced block intact.');
  } else if (!/\{\{\s*user_name\s*\}\}/.test(firstMessage)) {
    warnings.push('The first message has no {{user_name}} variable — check §3 of the setup doc.');
  }

  const wantsWebhooks = Array.isArray(serverSpecs) && serverSpecs.length > 0;
  const appUrlIsAbsolute = ABSOLUTE_HTTP_URL_RE.test(String(appUrl || ''));
  if (wantsWebhooks && !clientOnly) {
    if (!appUrl) {
      block('NO_APP_URL', 'APP_URL is not set, but this repo declares trainer webhook tools.',
        'Set APP_URL to the deployed origin (e.g. https://toolkits.alexsagun.com). Running without it would DETACH the trainer tools from the agent, not merely skip them.');
    } else if (!appUrlIsAbsolute) {
      // ★ A SCHEME-LESS APP_URL IS A BLOCKER OF ITS OWN, because without one the
      //   manifest builds `toolkits.example/api/elevenlabs/trainer?action=…` — a
      //   RELATIVE url ElevenLabs can never call, on eleven tools that would
      //   nonetheless be created and attached. The shell's health check fails on
      //   the same typo, so without this the operator is told the deployed
      //   TRAINER is misconfigured and goes to set a Vercel secret, when the real
      //   fault is one missing "https://" in their own .env.
      block('BAD_APP_URL', `APP_URL is "${appUrl}", which is not an absolute http(s) URL.`,
        'Use the full deployed origin including the scheme, e.g. https://toolkits.alexsagun.com — a scheme-less value produces webhook URLs ElevenLabs cannot call.');
    } else if (/^http:\/\//i.test(appUrl)) {
      warnings.push(`APP_URL is plain http (${appUrl}) — the trainer bearer token would cross the network in cleartext.`);
    }
    if (!trainerSecret) {
      block('NO_TRAINER_SECRET', 'TRAINER_TOKEN_SECRET is not set.',
        'Generate 32 bytes (`openssl rand -hex 32`), set it in .env AND in Vercel (Production + Preview), then redeploy.');
    }
    // A health verdict about an unusable URL says nothing, so it is not asked for.
    if (appUrl && appUrlIsAbsolute) {
      if (!trainerHealth || typeof trainerHealth !== 'object') {
        block('TRAINER_HEALTH_UNREACHABLE', `Could not read GET ${appUrl}/api/elevenlabs/trainer.`,
          'The deployed trainer endpoint must answer before its tools are attached to a live agent.');
      } else if (trainerHealth.configured !== true) {
        block('TRAINER_NOT_CONFIGURED', `The deployed trainer reports configured:false at ${appUrl}.`,
          'TRAINER_TOKEN_SECRET is missing in the deployment. Set it in Vercel and redeploy, then re-run. Attaching the tools now would answer "not configured" to a learner mid-lesson.');
      }
    }
  }

  if (clientOnly && agentId) {
    if (!Number.isFinite(agentWebhookToolCount)) {
      block('CLIENT_ONLY_WOULD_DETACH', '--client-only was passed, but how many webhook tools the agent already has could not be established.',
        'Read the agent and resolve its attached tools first. Without that, --client-only may be "remove the trainer", not "skip the trainer".');
    } else if (agentWebhookToolCount > 0) {
      block('CLIENT_ONLY_WOULD_DETACH', `--client-only was passed, but the agent already has ${agentWebhookToolCount} webhook tool(s) attached.`,
        'That is not "skip the trainer", it is "remove the trainer". Fix the trainer configuration instead, or detach them deliberately in the dashboard.');
    }
  }
  if (clientOnly && wantsWebhooks) {
    warnings.push('--client-only: the trainer webhook tools will NOT be created or attached.');
  }

  if (agentId && agentReadable !== true) {
    block('AGENT_UNREADABLE', `ELEVENLABS_AGENT_ID=${agentId} could not be read.`,
      'Check the id and that the API key has access to it.');
  }

  if (!voiceIdOverride) warnings.push('ELEVENLABS_VOICE_ID unset — the agent keeps its dashboard voice.');
  if (!llmOverride) warnings.push('ELEVENLABS_AGENT_LLM unset — the agent keeps its dashboard LLM.');

  return { ok: blockers.length === 0, blockers, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN — tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide, per managed tool, whether to update one the agent already has, reuse an
 * unattached one from the workspace, or create a fresh one — and carry every
 * FOREIGN tool through untouched.
 *
 * ★ A WORKSPACE TOOL IS REUSED ONLY WHEN IT IS KNOWN THAT NO OTHER AGENT DEPENDS
 *   ON IT. Tools are referenced by id, so two agents may legitimately own
 *   same-named tools; PATCHing one because its name matched would rewrite the
 *   other agent's behaviour. An explicit dependents array naming only this agent
 *   (or nobody) is reusable. Another agent → CREATE, `refusedReuse` reason
 *   'attached to another agent'. Dependents NOT KNOWN (a failed or skipped lookup
 *   — anything but an array) → CREATE, reason 'dependents unknown'. Creating is
 *   always safe; the worst it costs is an orphan in the workspace.
 *
 * ★ A MANAGED TOOL ALREADY ATTACHED HERE IS UPDATED — unless its workspace entry
 *   EXPLICITLY names another agent (a dashboard "duplicate agent" copies tool
 *   ids, so the copy shares them). Then it is replaced by a fresh tool on this
 *   agent only, and reported with `attached: true`. Attached with dependents
 *   unknown is still updated: being attached to the agent we are provisioning is
 *   itself the ownership signal a loose tool lacks.
 *
 * ★ A MANAGED NAME ATTACHED TWICE keeps the FIRST id and reports the rest in
 *   `duplicateAttached`. The old code let the last one win and dropped the other
 *   silently; now the drop is visible and the rollback capture still holds it.
 *
 * `agentTools`     : [{ id, name, type }] — the agent's current tool_ids, resolved.
 *                    An entry with no readable name is FOREIGN and carried.
 * `workspaceTools` : [{ id, name, dependents? }] — everything in the account.
 *
 * Returns { creates, updates, foreignIds, managedOrder, refusedReuse, duplicateAttached }.
 * Build the agent's next tool list with nextToolIds(), never by hand.
 */
export function planToolReconciliation({
  manifest,
  agentId = '',
  agentTools = [],
  workspaceTools = [],
} = {}) {
  const entries = manifest && Array.isArray(manifest.entries) ? manifest.entries : [];
  const managed = new Set(entries.map((e) => e.name));
  const creates = [];
  const updates = [];
  const refusedReuse = [];
  const duplicateAttached = [];

  const workspaceById = new Map();
  const workspaceByName = new Map();
  for (const t of Array.isArray(workspaceTools) ? workspaceTools : []) {
    if (!t || !t.id) continue;
    if (!workspaceById.has(t.id)) workspaceById.set(t.id, t);
    if (t.name) {
      if (!workspaceByName.has(t.name)) workspaceByName.set(t.name, []);
      workspaceByName.get(t.name).push(t);
    }
  }

  const attachedByName = new Map();
  const attachedIds = new Set();
  const foreignIds = [];
  for (const t of Array.isArray(agentTools) ? agentTools : []) {
    if (!t || !t.id || attachedIds.has(t.id)) continue;
    attachedIds.add(t.id);
    if (!managed.has(t.name)) { foreignIds.push(t.id); continue; }
    if (attachedByName.has(t.name)) { duplicateAttached.push({ name: t.name, id: t.id }); continue; }
    attachedByName.set(t.name, t.id);
  }

  const managedOrder = [];
  for (const entry of entries) {
    managedOrder.push(entry.name);
    const planned = { name: entry.name, kind: entry.kind, config: entry.config };

    const attachedId = attachedByName.get(entry.name);
    if (attachedId) {
      const ws = workspaceById.get(attachedId);
      const others = ws ? otherDependents(ws.dependents, agentId) : null;
      if (others && others.length) {
        refusedReuse.push({ name: entry.name, id: attachedId, attached: true, dependents: others, reason: 'attached to another agent' });
        creates.push(planned);
      } else {
        updates.push({ id: attachedId, ...planned });
      }
      continue;
    }

    let reuse = null;
    for (const loose of workspaceByName.get(entry.name) || []) {
      if (attachedIds.has(loose.id)) continue;
      const others = otherDependents(loose.dependents, agentId);
      if (others === null) {
        refusedReuse.push({ name: entry.name, id: loose.id, attached: false, dependents: null, reason: 'dependents unknown' });
      } else if (others.length) {
        refusedReuse.push({ name: entry.name, id: loose.id, attached: false, dependents: others, reason: 'attached to another agent' });
      } else if (!reuse) {
        reuse = loose;
      }
    }
    if (reuse) updates.push({ id: reuse.id, ...planned });
    else creates.push(planned);
  }

  return { creates, updates, foreignIds, managedOrder, refusedReuse, duplicateAttached };
}

/**
 * The agent's next `tool_ids`: every foreign id in its original order, then every
 * managed tool in manifest order — or NULL.
 *
 * ★ ALL OR NOTHING. Returns null when ANY managed name has no id, when any id is
 *   not a non-empty string, when an input is not an array, or when the result
 *   would list an id twice (only a shell bug can produce that, and a duplicate
 *   means a different managed tool is missing). The agent PATCH REPLACES
 *   `tool_ids`, so a partial list is not "most of the tools" — it is a silent
 *   detach of the rest, which is exactly how the trainer was lost before. The
 *   shell must treat null as "abort before the agent PATCH and unwind the tools",
 *   and must never assemble the list any other way.
 *
 * `idByName` is a plain object or a Map, name → tool id.
 */
export function nextToolIds({ foreignIds, managedOrder, idByName } = {}) {
  if (!Array.isArray(foreignIds) || !Array.isArray(managedOrder)) return null;
  const lookup = (name) => {
    if (idByName instanceof Map) return idByName.get(name);
    return hasOwn(idByName, name) ? idByName[name] : undefined;
  };
  const out = [];
  for (const id of foreignIds) {
    if (typeof id !== 'string' || !id) return null;
    out.push(id);
  }
  for (const name of managedOrder) {
    const id = lookup(name);
    if (typeof id !== 'string' || !id) return null;
    out.push(id);
  }
  if (new Set(out).size !== out.length) return null;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN — knowledge base
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide what to do with the knowledge document.
 *
 * ★ A SAME-NAME DOCUMENT IS DELETED ONLY WHEN IT IS KNOWN THAT NO OTHER AGENT
 *   REFERENCES IT. The previous helper deleted every detached same-name copy
 *   unconditionally, which would have destroyed another agent's knowledge base
 *   the first time two agents shared this repo's document name. A document whose
 *   `dependentsByDocId` entry is missing or not an array has UNKNOWN dependents
 *   and is undeletable (reason 'dependents unknown') — the old `(… || [])` read a
 *   failed lookup as "nobody", i.e. as permission to delete.
 *
 * ★ FINGERPRINT-FIRST. When the ONE attached copy already carries this repo's
 *   fingerprint and is attached as `usage_mode: 'prompt'` there is nothing to do —
 *   no document churn on a repeat run, and no needless version in the dashboard.
 *   Two copies, or the wrong usage mode, is not "current" (verifyApplied would
 *   refuse either), so it is not skipped.
 *
 * `currentKb` is the agent's `knowledge_base` list. Detaching is this agent's
 * business, so every same-name copy is in `detachIds`; deleting is not, so only
 * `deletableIds` may be deleted, and only AFTER the new copy is attached.
 */
export function planKnowledgeReconciliation({
  currentKb = [],
  docName = '',
  repoFingerprint = '',
  liveFingerprint = null,
  dependentsByDocId = {},
  agentId = '',
} = {}) {
  const kb = Array.isArray(currentKb) ? currentKb : [];
  // No name → nothing can be "ours". Matching '' would target unnamed documents.
  const ours = docName ? kb.filter((d) => d && d.name === docName) : [];
  const keepForeign = kb.filter((d) => d && !(docName && d.name === docName));

  const fingerprintsMatch = Boolean(repoFingerprint && liveFingerprint && repoFingerprint === liveFingerprint);
  // ★ A SKIP MUST NAME THE DOCUMENT IT IS SKIPPING. Without a readable id the
  //   shell has nothing to hand verifyApplied as `kbDocId`, so every knowledge
  //   check there is skipped too and the run "verifies" a document it never
  //   identified. Falling through instead costs one upload.
  if (fingerprintsMatch && ours.length === 1 && ours[0].id && ours[0].usage_mode === 'prompt') {
    return {
      skip: true,
      reason: `already current (${repoFingerprint})`,
      keepForeign,
      detachIds: [],
      deletableIds: [],
      undeletableIds: [],
    };
  }

  const deletableIds = [];
  const undeletableIds = [];
  for (const doc of ours) {
    if (!doc.id) continue;
    const others = otherDependents(hasOwn(dependentsByDocId, doc.id) ? dependentsByDocId[doc.id] : undefined, agentId);
    if (others === null) undeletableIds.push({ id: doc.id, dependents: null, reason: 'dependents unknown' });
    else if (others.length) undeletableIds.push({ id: doc.id, dependents: others, reason: 'attached to another agent' });
    else deletableIds.push(doc.id);
  }

  let reason;
  if (!liveFingerprint) reason = 'no live fingerprint could be read';
  else if (!fingerprintsMatch) reason = `live ${liveFingerprint} != repo ${repoFingerprint}`;
  else if (ours.length !== 1) reason = `${ours.length} copies named "${docName}" are attached`;
  else if (!ours[0].id) reason = `the attached copy of "${docName}" has no readable id`;
  else reason = `attached with usage_mode "${ours[0].usage_mode}", expected "prompt"`;

  return {
    skip: false,
    reason,
    keepForeign,
    detachIds: ours.map((d) => d.id).filter(Boolean),
    deletableIds,
    undeletableIds,
  };
}

/**
 * The agent's next `knowledge_base` list: every foreign document, then ours — or
 * NULL.
 *
 * ★ THE SAME ALL-OR-NOTHING RULE AS nextToolIds, FOR THE SAME REASON. The agent
 *   PATCH REPLACES `knowledge_base`, so a list assembled by hand from a document
 *   whose upload half-succeeded silently DETACHES every other document the agent
 *   had. Null means "abort before the agent PATCH"; it is never a list to send.
 *   Null when either input is the wrong shape, when any document has no readable
 *   id, when `ours` is not attached as `usage_mode: 'prompt'` (verifyApplied
 *   refuses anything else, so sending it would fail the run one step later), or
 *   when an id appears twice — a duplicate means a document counted as foreign is
 *   in fact the one being published.
 *
 * `ours` is the document to attach: the freshly created one, or — on the
 * fingerprint-match SKIP path, where the PATCH must still carry the list it is
 * replacing — the copy already attached. `keepForeign` comes straight from
 * planKnowledgeReconciliation; documents are carried verbatim, so a foreign
 * document keeps its own `usage_mode`.
 */
export function nextKnowledgeBase({ keepForeign, ours } = {}) {
  if (!Array.isArray(keepForeign)) return null;
  const out = [];
  for (const doc of keepForeign) {
    if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string' || !doc.id) return null;
    out.push(cloneData(doc));
  }
  if (!ours || typeof ours !== 'object' || typeof ours.id !== 'string' || !ours.id) return null;
  if (ours.usage_mode !== 'prompt') return null;
  out.push(cloneData(ours));
  if (new Set(out.map((d) => d.id)).size !== out.length) return null;
  return out;
}

/**
 * The knowledge phase as an ORDERED list of operations, built after the upload so
 * the published document's id is known — the same shape and the same discipline as
 * planRollback.
 *
 * ★ ATTACH BEFORE DETACH IS STRUCTURAL HERE, NOT A SENTENCE IN A DOCSTRING.
 *   planKnowledgeReconciliation returns SETS, and a set cannot express "only
 *   after": `deletableIds` beside `detachIds` reads equally well as "delete these,
 *   then attach". Ordering that only a comment asserts is ordering a shell can get
 *   wrong in one line, and getting it wrong means the agent spends the window
 *   between the DELETE and the PATCH with NO knowledge document at all — or, if the
 *   run then fails, permanently. Here the attach is op 0 and every delete is after
 *   it by construction, so a test asserts it by INDEX rather than by reading prose.
 *
 * ★ NULL IS "DELETE NOTHING", AND THAT IS THE SAME ALL-OR-NOTHING RULE AS
 *   nextToolIds / nextKnowledgeBase. When the attach cannot be expressed — no
 *   agent id, no usable document, a foreign document with no id — the answer is
 *   null, never "the deletes at least". A delete list emitted without its attach is
 *   precisely the destructive half on its own.
 *
 * ★ ONLY `deletableIds` ARE DELETED, NEVER `detachIds`. Detaching is this agent's
 *   business and the attach PATCH does it wholesale; deleting is the workspace's,
 *   and a copy another agent still references (or whose dependents could not be
 *   read) is in `undeletableIds` and reaches no op here. The document being
 *   attached is skipped too, however it arrived in the list — deleting what was
 *   just published is the one mistake that survives verification, because the agent
 *   would still carry a reference to an id that no longer exists.
 *
 * The `attach-kb` op's body is the knowledge-base half of the SINGLE agent PATCH
 * the shell sends (it also carries the prompt and `tool_ids`); it is listed as an
 * op so the deletes can be ordered after it, not so it is sent on its own.
 *
 * `plan` is a planKnowledgeReconciliation result; `ours` is the document to
 * attach — the freshly created one, or the already-attached copy on the SKIP path.
 */
export function planKnowledgeOps({ plan, ours, agentId = '' } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  if (typeof agentId !== 'string' || !agentId) return null;
  const nextKb = nextKnowledgeBase({ keepForeign: plan.keepForeign, ours });
  if (nextKb === null) return null;

  const ops = [{
    op: 'attach-kb',
    method: 'PATCH',
    path: `/v1/convai/agents/${encodeURIComponent(agentId)}`,
    body: { conversation_config: { agent: { prompt: { knowledge_base: nextKb } } } },
    why: 'publish the new copy before any old one is destroyed',
  }];

  const attached = new Set(nextKb.map((d) => d.id));
  for (const id of idList(plan.deletableIds)) {
    if (attached.has(id)) continue;
    ops.push({
      op: 'delete-kb',
      method: 'DELETE',
      path: `/v1/convai/knowledge-base/${encodeURIComponent(id)}`,
      body: null,
      why: 'detached by the attach above, and referenced by no other agent',
    });
  }
  return ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE / ROLLBACK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything needed to put the agent back exactly as it was, taken BEFORE the
 * first mutation.
 *
 * ★ THE CAPTURE IS WHOLE OBJECTS, NOT THE HANDFUL OF FIELDS THIS RUN WRITES.
 *   The whole prompt is captured (not only prompt / tool_ids / knowledge_base /
 *   llm), so a restore also returns temperature, RAG and every other prompt
 *   setting — and the same reasoning applies one level UP, which an earlier
 *   version of this function did not follow. It narrowed `conversation` to
 *   `max_duration_seconds`, `tts` to `voice_id` and `platform_settings` to
 *   `auth.enable_auth`, and dropped `turn` and `agent.dynamic_variables`
 *   altogether — so the restore PATCH re-sent truncated objects. Whether an
 *   ElevenLabs PATCH REPLACES a nested config object or deep-merges it is one of
 *   the three API shapes this repo has NOT verified; if it replaces, that restore
 *   silently stripped `conversation.client_events` — which is where
 *   `user_transcript` lives, and the widget's transcript de-duplication depends on
 *   receiving it — along with the TTS model, the auth allowlist and every widget
 *   and privacy setting. `prompt.tools` is the ONE deliberate omission: it is
 *   derived from `tool_ids`, and sending both is a 400.
 *
 * ★ A RESTORE THAT SENDS TOO MUCH FAILS LOUDLY; ONE THAT SENDS TOO LITTLE FAILS
 *   SILENTLY. The cost of capturing whole objects is that the restore PATCH may
 *   be refused over a field the API treats as read-only — which `verify-restore`
 *   (planRollback's second op) is there to catch, and after which the shell prints
 *   the full redacted before-state and the dashboard steps. The cost of the narrow
 *   capture was a restore that SUCCEEDED and quietly left the live agent
 *   misconfigured, with nothing to compare against because the capture no longer
 *   held the truth. Do not narrow this again to make a restore more likely to be
 *   accepted.
 *
 * The three fields the run itself writes — `first_message`, `language`,
 * `conversation.max_duration_seconds` — plus `tts` are normalized so "absent"
 * reads as null rather than as a missing key, because planRollback distinguishes
 * "was absent" (omit) from "was set" (write back).
 *
 * The result is a deep COPY. Mutating the agent object or the tool configs after
 * capture cannot change it — a capture that aliased its source would "restore"
 * whatever the run had already done to it.
 *
 * `managedToolConfigs` maps a tool id to the body it had, so an UPDATE is
 * reversible — without it a failed run could leave a managed tool rewritten with
 * no way back.
 */
export function captureRollbackState({ agent = {}, managedToolConfigs = {}, capturedAt = null } = {}) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const a = obj(agent);
  const cc = obj(a.conversation_config);
  const ag = obj(cc.agent);
  const livePrompt = obj(ag.prompt);
  // `tools` is deliberately discarded — see above.
  const { tools: _derivedFromToolIds, ...promptRest } = livePrompt;

  const prompt = cloneData(promptRest);
  prompt.prompt = livePrompt.prompt ?? null;
  prompt.tool_ids = Array.isArray(livePrompt.tool_ids) ? [...livePrompt.tool_ids] : [];
  prompt.knowledge_base = Array.isArray(livePrompt.knowledge_base) ? cloneData(livePrompt.knowledge_base) : [];
  prompt.llm = livePrompt.llm ?? null;

  const conversationConfig = cloneData(cc);
  conversationConfig.agent = cloneData(ag);
  conversationConfig.agent.prompt = prompt;
  conversationConfig.agent.first_message = ag.first_message ?? null;
  conversationConfig.agent.language = ag.language ?? null;
  conversationConfig.conversation = cloneData(obj(cc.conversation));
  conversationConfig.conversation.max_duration_seconds = obj(cc.conversation).max_duration_seconds ?? null;
  conversationConfig.tts = cc.tts && typeof cc.tts === 'object' ? cloneData(cc.tts) : null;

  const livePlatform = obj(a.platform_settings);
  const platformSettings = cloneData(livePlatform);
  platformSettings.auth = cloneData(obj(livePlatform.auth));
  platformSettings.auth.enable_auth = obj(livePlatform.auth).enable_auth ?? null;

  return {
    agentId: a.agent_id || null,
    capturedAt,
    name: a.name || null,
    conversationConfig,
    platformSettings,
    managedToolConfigs: cloneData(managedToolConfigs && typeof managedToolConfigs === 'object' ? managedToolConfigs : {}),
    createdToolIds: [],
    createdKbIds: [],
  };
}

const REDACTED = '<redacted>';
/** Key names whose VALUE is never printed, at any depth. */
const SECRET_KEY_RE = /^(secret__.*|api_key|apikey|x-api-key|authorization)$/i;
/** Keys whose CONTENTS are secret whatever the container's shape is. */
const SENSITIVE_CONTAINER_KEYS = new Set(['request_headers', 'dynamic_variable_placeholders']);

/**
 * The printable form of a rollback payload.
 *
 * ★ THIS GOVERNS WHAT IS PRINTED, NEVER WHAT IS HELD FOR THE RESTORE. The live
 *   object keeps its real header values, because a restore that wrote back
 *   "<redacted>" would break the trainer's Authorization header. Only the copy
 *   that reaches a log or a `--dump-before` goes through here. It never mutates
 *   its input.
 *
 * Blanked, at any depth including inside arrays: every `request_headers` value
 * (object form `{ Name: value }` AND the array form
 * `[{ type, name, value | secret_id }]`, keeping the header names), every
 * `dynamic_variable_placeholders` value, and the value of any key matching
 * `secret__*`, `api_key`, `x-api-key` or `authorization`.
 *
 * ★ A SENSITIVE CONTAINER IS BLANKED WHATEVER SHAPE IT ARRIVES IN. The two
 *   container keys were handled only in the exact shapes this repo writes — the
 *   object form of `request_headers` and the object form of the placeholders — and
 *   any other shape fell through to the generic walk and was printed verbatim.
 *   A future API version that returns `request_headers` as a serialized string, or
 *   the placeholders as a `[{ name, value }]` array (which is how the headers
 *   already arrive), would therefore print a live bearer token into a log. The key
 *   alone is enough to know the value is a secret, so an unrecognised shape is
 *   blanked whole rather than walked.
 */
export function redactRollbackState(payload) {
  const redactContainer = (value) => {
    if (Array.isArray(value)) {
      return value.map((h) => {
        if (!h || typeof h !== 'object') return REDACTED;
        const out = {};
        for (const [k, v] of Object.entries(h)) out[k] = (k === 'name' || k === 'type') ? v : REDACTED;
        return out;
      });
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map((h) => [h, REDACTED]));
    // A string, number or null container carries no readable structure to keep.
    return value == null ? value : REDACTED;
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_CONTAINER_KEYS.has(k)) {
        out[k] = redactContainer(v);
      } else if (SECRET_KEY_RE.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };
  return walk(payload);
}

/**
 * The usable ids in an `applied.*` list.
 *
 * ★ ONLY AN EXPLICIT ARRAY OF NON-EMPTY STRINGS IS ITERATED. `for (const id of
 *   done.createdToolIds || [])` iterates a STRING one character at a time, so a
 *   shell that recorded a single id as `'tool_x'` rather than `['tool_x']` would
 *   plan seven DELETEs against one-character ids. Nothing else in this module
 *   trusts an unvalidated shape either.
 */
function idList(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * A copy of `obj` without its null/undefined-valued keys.
 *
 * The surviving values are CLONED, not referenced: everything this builds is a
 * request body a caller may edit, and an aliased value would let that edit reach
 * back into the capture the restore is reading from.
 */
function withoutNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    if (v != null) out[k] = cloneData(v);
  }
  return out;
}

/**
 * The ordered undo for a run that failed verification.
 *
 * Agent first, because that is what customers are talking to; the created
 * artefacts afterwards, because they are unreferenced once the agent is back:
 *
 *   restore-agent → verify-restore → delete-kb → restore-tool → delete-tool
 *
 * The restore PATCH carries every captured field — the whole prompt (llm
 * included), the whole agent, conversation, tts and platform_settings objects,
 * and the name — so an env-overridden LLM or voice is put back too, and so is
 * every sibling this run never intended to touch (`conversation.client_events`,
 * the TTS model, the auth allowlist, widget and privacy settings). See the
 * capture's star comment: re-sending a TRUNCATED nested object is only safe if a
 * PATCH deep-merges, which this repo has not verified. A field captured as null
 * was ABSENT before the run and is omitted rather than written as null, which the
 * API may reject and fail the whole restore over; a nested object left empty by
 * that rule is omitted whole for the same reason.
 *
 * `restore-tool` is emitted only for ids in `applied.updatedToolIds` that have a
 * captured prior config. With no captured `agentId` (the run CREATED the agent,
 * so nothing live existed before it) there is no agent to restore and the two
 * agent ops are omitted.
 *
 * ★ `applied.agentPatched === false` IS THE TOOLS-ONLY UNWIND. When the tools
 *   phase fails (nextToolIds returned null, or a create/update was refused) the
 *   agent was never written, so the unwind must not write it either — a restore
 *   PATCH from the capture would revert any dashboard edit made since. Only an
 *   explicit `false` omits the agent ops; anything else keeps them, because
 *   restoring an agent that was not changed is harmless and skipping one that was
 *   is not.
 */
export function planRollback(before, applied = {}) {
  const b = before || {};
  const done = applied || {};
  const ops = [];

  if (b.agentId && done.agentPatched !== false) {
    const cc = b.conversationConfig && typeof b.conversationConfig === 'object' ? b.conversationConfig : {};
    const agentCfg = cc.agent && typeof cc.agent === 'object' ? cc.agent : {};
    const { prompt: capturedPrompt, ...agentRest } = agentCfg;
    const agentBody = withoutNulls(agentRest);
    agentBody.prompt = withoutNulls(capturedPrompt);

    // Every other conversation_config member — `turn`, `asr`, anything a future
    // API version adds — is carried whole. The run did not write them, so the
    // restore must not be the thing that changes them.
    const conversation_config = withoutNulls(cc);
    delete conversation_config.agent;
    delete conversation_config.conversation;
    delete conversation_config.tts;
    conversation_config.agent = agentBody;
    const conversation = withoutNulls(cc.conversation);
    if (Object.keys(conversation).length) conversation_config.conversation = conversation;
    const tts = withoutNulls(cc.tts);
    if (Object.keys(tts).length) conversation_config.tts = tts;

    const body = { conversation_config };
    const ps = b.platformSettings && typeof b.platformSettings === 'object' ? b.platformSettings : {};
    const platform_settings = withoutNulls(ps);
    delete platform_settings.auth;
    const auth = withoutNulls(ps.auth);
    if (Object.keys(auth).length) platform_settings.auth = auth;
    if (Object.keys(platform_settings).length) body.platform_settings = platform_settings;
    if (b.name != null) body.name = b.name;

    const path = `/v1/convai/agents/${encodeURIComponent(b.agentId)}`;
    ops.push({ op: 'restore-agent', method: 'PATCH', path, body, why: 'put the live agent back before touching anything else' });
    ops.push({ op: 'verify-restore', method: 'GET', path, body: null, why: 'a rollback that silently failed is worse than none' });
  }

  for (const id of idList(done.createdKbIds)) {
    ops.push({ op: 'delete-kb', method: 'DELETE', path: `/v1/convai/knowledge-base/${encodeURIComponent(id)}`, body: null, why: 'created by this run and now unreferenced' });
  }
  for (const id of idList(done.updatedToolIds)) {
    if (!hasOwn(b.managedToolConfigs, id)) continue;
    ops.push({ op: 'restore-tool', method: 'PATCH', path: `/v1/convai/tools/${encodeURIComponent(id)}`, body: { tool_config: cloneData(b.managedToolConfigs[id]) }, why: 'this run rewrote it' });
  }
  for (const id of idList(done.createdToolIds)) {
    ops.push({ op: 'delete-tool', method: 'DELETE', path: `/v1/convai/tools/${encodeURIComponent(id)}`, body: null, why: 'created by this run and now unreferenced' });
  }
  return ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-read the agent and prove the run did what it claimed.
 *
 * ★ IT NEVER CLAIMS A MATCH IT DID NOT PROVE. `kbVerified` is 'strong' only when
 *   the published document was read back and fingerprinted; 'weak' means name +
 *   byte length agreed because the content endpoint was unavailable, and that is
 *   reported as weak rather than rounded up to success. Anything else ('none')
 *   while a document is expected is a MISMATCH: nothing was read back at all.
 *
 * ★ DUPLICATES ARE COUNTED OVER EVERYTHING ATTACHED, not only over the ids the
 *   run meant to attach. A stale copy of a managed tool left on the agent is not
 *   in `managedIdByName`, so a check limited to that map could never see it.
 *   `toolsById` should therefore hold every attached tool the shell could read.
 */
export function verifyApplied({
  agent = {},
  toolsById = {},
  expected = {},
  kbVerified = 'none',
} = {}) {
  const mismatches = [];
  const a = agent && typeof agent === 'object' ? agent : {};
  const want = expected && typeof expected === 'object' ? expected : {};
  const tools = toolsById && typeof toolsById === 'object' ? toolsById : {};
  const cc = a.conversation_config || {};
  const prompt = (cc.agent || {}).prompt || {};
  const toolIds = Array.isArray(prompt.tool_ids) ? prompt.tool_ids : [];
  const liveTool = (id) => (hasOwn(tools, id) ? tools[id] : undefined);

  for (const id of want.foreignToolIds || []) {
    if (!toolIds.includes(id)) mismatches.push(`foreign tool ${id} was dropped from the agent`);
  }

  const managedNames = want.managedNames || [];
  for (const name of managedNames) {
    const id = hasOwn(want.managedIdByName, name) ? want.managedIdByName[name] : undefined;
    if (!id) { mismatches.push(`no id resolved for managed tool "${name}"`); continue; }
    if (!toolIds.includes(id)) { mismatches.push(`managed tool "${name}" (${id}) is not attached`); continue; }
    const live = liveTool(id);
    if (!live) { mismatches.push(`managed tool "${name}" (${id}) could not be read back`); continue; }
    if (live.name !== name) mismatches.push(`tool ${id} is named "${live.name}", expected "${name}"`);
    const wantKind = hasOwn(want.kindByName, name) ? want.kindByName[name] : undefined;
    if (wantKind && live.type && live.type !== wantKind) mismatches.push(`tool "${name}" is type "${live.type}", expected "${wantKind}"`);
  }

  const managedSet = new Set(managedNames);
  const idsByName = new Map();
  for (const id of new Set(toolIds)) {
    const live = liveTool(id);
    if (!live || !managedSet.has(live.name)) continue;
    if (!idsByName.has(live.name)) idsByName.set(live.name, new Set());
    idsByName.get(live.name).add(id);
  }
  const dupes = [...idsByName].filter(([, ids]) => ids.size > 1).map(([n]) => n);
  if (dupes.length) mismatches.push(`duplicate managed tool name(s) attached: ${dupes.join(', ')}`);

  const kb = Array.isArray(prompt.knowledge_base) ? prompt.knowledge_base : [];
  if (want.kbDocId) {
    const hit = kb.find((d) => d && d.id === want.kbDocId);
    if (!hit) mismatches.push(`knowledge document ${want.kbDocId} is not attached`);
    else if (hit.usage_mode !== 'prompt') mismatches.push(`knowledge document is attached with usage_mode "${hit.usage_mode}", expected "prompt"`);
    if (kbVerified !== 'strong' && kbVerified !== 'weak') {
      mismatches.push(`knowledge document ${want.kbDocId} was not read back (kbVerified "${kbVerified}") — the run cannot prove what it published`);
    }
  }
  for (const doc of want.foreignKbIds || []) {
    if (!kb.some((d) => d && d.id === doc)) mismatches.push(`foreign knowledge document ${doc} was dropped`);
  }

  const auth = ((a.platform_settings || {}).auth || {}).enable_auth;
  if (auth !== true) mismatches.push('signed-URL authentication is not enabled on the agent');

  const maxSecs = (cc.conversation || {}).max_duration_seconds;
  if (want.maxDurationSecs != null && maxSecs !== want.maxDurationSecs) {
    mismatches.push(`max_duration_seconds is ${maxSecs}, expected ${want.maxDurationSecs}`);
  }

  if (want.promptSentinel && !String(prompt.prompt || '').includes(want.promptSentinel)) {
    mismatches.push(`the published system prompt does not mention "${want.promptSentinel}"`);
  }

  // Dashboard choices must survive a run that did not intend to change them.
  if (want.preserveLlm != null && prompt.llm !== want.preserveLlm) {
    mismatches.push(`llm changed from "${want.preserveLlm}" to "${prompt.llm}" — this run did not intend that`);
  }
  if (want.preserveVoiceId != null && (cc.tts || {}).voice_id !== want.preserveVoiceId) {
    mismatches.push(`voice changed from "${want.preserveVoiceId}" to "${(cc.tts || {}).voice_id}" — this run did not intend that`);
  }

  return { ok: mismatches.length === 0, mismatches, kbVerified };
}
