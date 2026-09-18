// ─────────────────────────────────────────────────────────────────────────────
// Toolkits Siri — the knowledge document's semantics.
//
// PURE and dependency-free. Owns three things that had no home and therefore had
// no tests:
//
//   1. extractPureLiteral — the balanced-bracket reader that pulls VOICE_TAB_INFO,
//      TAB_ROUTES and friends out of the 37k-line monolith. It existed TWICE, in
//      scripts/generate-voice-agent-knowledge.mjs and scripts/_elevenlabs.mjs, as
//      near-byte copies, and NEITHER had a test. Now there is one copy and it is
//      pinned; _elevenlabs.mjs re-exports it under its old name so its callers are
//      untouched.
//
//   2. The fingerprint — a deterministic digest of the generated document, so
//      provisioning can PROVE the copy attached to the live agent is the copy in
//      this repo. A matching document NAME proves nothing: the live copy on
//      2026-09-16 was named correctly and dated 2026-07-17, advertised 32 tools,
//      two deleted membership plans and two retired tools.
//
//   3. knowledgeInvariants — the semantic checks the generator runs on EVERY
//      build. A check that only runs under `--check` cannot stop a bad document
//      from being written; it can only notice afterwards.
//
// ★ THE FINGERPRINT IS A DRIFT DETECTOR, NOT A MAC. It is unkeyed and uses no
//   crypto, deliberately: anyone who can change the document can change the
//   fingerprint, and that is fine, because the threat it addresses is "we forgot
//   to push", not "someone tampered with the knowledge base". Keeping it
//   crypto-free is what lets this module be imported by the browser bundle, the
//   build scripts and node:test alike. If it ever becomes a security boundary it
//   must move to the src/lib/trainerToken.js idiom — inject the hash primitive —
//   and this comment must be deleted in the same change.
// ─────────────────────────────────────────────────────────────────────────────

/** The one place the fingerprint's textual form is defined. */
const FINGERPRINT_PREFIX = 'kb1-';

// ★ THE READER AND THE NORMALIZER ARE BUILT FROM ONE PATTERN. They used to be two
//   hand-written regexes that disagreed: the reader accepted `Fingerprint: kb1-…`
//   anywhere, while the normalizer stripped it only after a `·` separator. A doc
//   that embedded its token any other way was READ as fingerprinted and then
//   never matched its own digest — a permanent `fingerprint-matches` failure that
//   no content change could fix. The trailing look-ahead refuses a longer run of
//   hex, so a 17-digit token is garbage rather than a truncated match.
const FINGERPRINT_TOKEN_SRC = 'Fingerprint:\\s*(kb1-[0-9a-f]{16})(?![0-9A-Za-z])';
const FINGERPRINT_RE = new RegExp(FINGERPRINT_TOKEN_SRC);
const FINGERPRINT_ALL_RE = new RegExp(FINGERPRINT_TOKEN_SRC, 'g');
const FINGERPRINT_STRIP_RE = new RegExp(`(?:\\s*·)?\\s*${FINGERPRINT_TOKEN_SRC}`, 'g');

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read a `const <name> = ` literal out of a source file and evaluate it.
 *
 * A balanced `[]` / `{}` / `()` scan that honours string literals (with escapes),
 * template strings and both comment forms, so a bracket inside any of those
 * cannot unbalance it. The result is evaluated with `new Function`, which is what
 * enforces the "pure literal" contract the monolith documents beside
 * VOICE_TAB_INFO, VOICE_CLIENT_TOOL_SPECS and VOICE_SERVER_TOOL_SPECS: an
 * identifier reference or a function call throws here rather than silently
 * shipping a broken agent configuration.
 *
 * `const X = new Set([...])` and `const X = Object.freeze({...})` yield the inner
 * literal (the array / the object) — the wrapper is not evaluated.
 *
 * ★ THE DECLARATION MUST START ITS LINE, AND NOTHING BUT A WRAPPER MAY SIT
 *   BETWEEN `=` AND THE BRACKET. Both copies this replaced searched with
 *   `indexOf('const X = ')` and then skipped forward to the next `[` or `{`
 *   ANYWHERE in the file. So `const X = buildX();` silently evaluated whatever
 *   literal came next — possibly thousands of lines later, possibly pure, and
 *   therefore possibly "successful" — and a `// const X = {…}` comment above the
 *   real declaration was read instead of it. Both now throw or are skipped.
 *
 * Throws with an actionable message. Callers decide whether that is fatal.
 */
export function extractPureLiteral(src, name, inject = {}) {
  const text = String(src == null ? '' : src);
  if (!/^[A-Za-z_$][\w$]*$/.test(String(name))) {
    throw new Error(`Literal name "${name}" is not a JavaScript identifier.`);
  }
  const anchor = new RegExp(`^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${escapeRegExp(name)}[ \\t]*=`, 'm').exec(text);
  if (!anchor) {
    throw new Error(`Literal "${name}" not found — it moved or was renamed. Update the caller, or restore the literal.`);
  }
  const afterEquals = anchor.index + anchor[0].length;
  const lead = /^\s*(?:(?:new\s+Set|Object\.freeze)\s*\(\s*)?(?=[[{])/.exec(text.slice(afterEquals));
  if (!lead) {
    throw new Error(`Literal "${name}" is not assigned an array or object literal — keep it a PURE literal (no function calls or expressions before the bracket).`);
  }
  const i = afterEquals + lead[0].length;
  // ★ A STACK, NOT A DEPTH COUNTER, AND IT TRACKS EVERY BRACKET KIND. A counter
  //   that watched only the OUTER pair could not see an inner mismatch at all,
  //   and the consequence was a WRONG ACCUSATION rather than a missed one:
  //   `const X = { a: [1, 2 };` ran `{`→1 then `}`→0, ended the scan on that `}`
  //   and handed the truncated snippet `{ a: [1, 2 }` to new Function — whose
  //   SyntaxError this function then reported as "no longer a PURE literal
  //   (Unexpected token '}')". Measured on every mismatch shape: the outer pair
  //   always closes early, the snippet always fails to parse, and the message
  //   always blamed purity. So whoever read it went hunting for a function call
  //   in a literal that has none, when the real edit is one missing `]`.
  //   The stack names the actual fault, and tracking `()` too is what lets
  //   `{ a: 1, b: (2 }` say "unbalanced" instead of the same false "PURE".
  //   ★ Both arms matter: a closer that does not match the innermost opener is
  //   unbalanced, and so is an opener that is never closed.
  const OPENERS = { '[': ']', '{': '}', '(': ')' };
  const CLOSERS = { ']': '[', '}': '{', ')': '(' };
  const stack = [];
  let end = -1;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      j++;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) break;
        j++;
      }
      continue;
    }
    if (ch === '/' && text[j + 1] === '/') {
      while (j < text.length && text[j] !== '\n') j++;
      continue;
    }
    if (ch === '/' && text[j + 1] === '*') {
      j += 2;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j++;
      continue;
    }
    if (OPENERS[ch]) { stack.push(ch); continue; }
    if (CLOSERS[ch]) {
      const top = stack[stack.length - 1];
      if (top !== CLOSERS[ch]) {
        throw new Error(`Literal "${name}" has unbalanced brackets: "${ch}" closes a "${CLOSERS[ch]}", but the innermost open bracket is "${top}".`);
      }
      stack.pop();
      if (stack.length === 0) { end = j; break; }
    }
  }
  if (end === -1) {
    throw new Error(`Literal "${name}" has unbalanced brackets: ${stack.length} bracket(s) opened and never closed.`);
  }
  const snippet = text.slice(i, end + 1);
  try {
    // eslint-disable-next-line no-new-func
    return new Function(...Object.keys(inject), `return (${snippet});`)(...Object.values(inject));
  } catch (err) {
    throw new Error(`Literal "${name}" is no longer a PURE literal (${err.message}). Keep it free of identifier references and function calls.`);
  }
}

/**
 * The first fenced ``` block after `marker` in a markdown string, dedented by the
 * fence's own indentation (the setup doc nests its fences under list items).
 *
 * This is how the ElevenLabs system prompt and first message are sourced from
 * docs/ai/voice-agent-setup.md, so the human-facing document and the provisioned
 * agent cannot diverge.
 *
 * A fence closes only on a run of backticks at least as long as the one that
 * opened it (CommonMark), so a ```` block may quote a ``` example — a system
 * prompt that shows the model a code sample would otherwise be cut in half at
 * the sample, and the agent provisioned with the first half.
 */
export function fencedBlockAfter(md, marker) {
  const text = String(md == null ? '' : md);
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`Marker "${marker}" not found in the setup doc.`);
  const lines = text.slice(at).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
  if (i >= lines.length) throw new Error(`No opening code fence after "${marker}" in the setup doc.`);
  const [, indent, ticks] = /^(\s*)(`{3,})/.exec(lines[i]);
  const closing = new RegExp(`^\\s*\`{${ticks.length},}\\s*$`);
  i++;
  const out = [];
  for (; i < lines.length; i++) {
    if (closing.test(lines[i])) {
      return out.map((l) => {
        let k = 0;
        while (k < indent.length && (l[k] === ' ' || l[k] === '\t')) k++;
        return l.slice(k);
      }).join('\n').trim();
    }
    out.push(lines[i]);
  }
  throw new Error(`Unterminated code fence after "${marker}" in the setup doc.`);
}

/**
 * Reduce a knowledge document to the bytes that carry MEANING.
 *
 * Drops the generated-on date (a rebuild on a different day is not drift — this
 * reuses the rule the existing `--check` already applies), the fingerprint token
 * itself (or the digest could never match the document containing it), CRLF, and
 * trailing whitespace. Exactly one trailing newline. Leading indentation is kept:
 * in markdown it is structure.
 */
export function normalizeKnowledgeText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/Generated: \d{4}-\d{2}-\d{2}/g, 'Generated: <date>')
    .replace(FINGERPRINT_STRIP_RE, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
    .concat('\n');
}

/**
 * A stable 64-bit FNV-1a digest of the document's meaning, as `kb1-<16 hex>`.
 *
 * FNV-1a over UTF-8 bytes, computed in BigInt so it is identical on every
 * platform and needs no crypto module. See the file header for why this is
 * deliberately not a MAC. Changing the algorithm or the normalization changes
 * every published fingerprint, so it must also change the `kb1-` prefix.
 */
export function knowledgeFingerprint(text) {
  const bytes = new TextEncoder().encode(normalizeKnowledgeText(text));
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return FINGERPRINT_PREFIX + hash.toString(16).padStart(16, '0');
}

/** The fingerprint embedded in a document, or null. Never throws. */
export function readKnowledgeFingerprint(text) {
  const m = FINGERPRINT_RE.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic invariants
// ─────────────────────────────────────────────────────────────────────────────

/** Terms that must never reappear in the knowledge document. */
export const RETIRED_KNOWLEDGE_TERMS = Object.freeze([
  'Budgeting Tool', 'Forecasting Tool', 'Discord', 'Thinkific',
  'core_self_paced', 'gold_live', 'Gold Package', 'QBO Mastery Only',
]);

/**
 * The exact phrases in which a retired term is still a TRUE statement.
 *
 * ★ Student Imports exists to "migrate legacy Thinkific students", and its
 *   VOICE_TAB_INFO description says exactly that. A blanket ban on "Thinkific"
 *   therefore failed every build for an accurate sentence the plan leaves
 *   untouched — and a generator that fails on every build is one people learn
 *   to bypass. The carve-out is a literal phrase, not a looser test: "courses are
 *   hosted on Thinkific" still fails.
 */
export const RETIRED_TERM_HISTORICAL_USES = Object.freeze({
  Thinkific: Object.freeze(['legacy Thinkific']),
});

/**
 * The per-caller ElevenLabs dynamic variables VoiceAssistant sends at session
 * start (its `dynamicVariables` object in src/BookkeeperPro.jsx). None may be
 * named in a document every caller receives. `secret__*` is matched as a family.
 */
export const PER_CALLER_VARIABLE_NAMES = Object.freeze([
  'user_name', 'user_role', 'plan_label', 'plan_scope', 'membership_status',
  'days_left', 'current_tab',
]);

/** A `## ` section's body (up to the next `## ` heading) whose title matches, or null. */
function sectionBody(text, titleRe) {
  const heading = /^##[ \t]+(.+)$/gm;
  let start = -1;
  let m;
  while ((m = heading.exec(text))) {
    if (start === -1) {
      if (titleRe.test(m[1])) start = heading.lastIndex;
    } else {
      return text.slice(start, m.index);
    }
  }
  return start === -1 ? null : text.slice(start);
}

const wholeWord = (term, flags = '') => new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, flags);

/**
 * Check the generated document against the code it claims to describe.
 *
 * Returns `[{ id, ok, message }]` — the generator turns any `ok: false` into a
 * hard failure, and does so on EVERY build rather than only under `--check`,
 * because a check that runs after the write can only report a bad document, not
 * prevent one.
 *
 * Inputs (all derived from code by the caller, never typed by hand):
 *   routeIds          every TAB_ROUTES id
 *   aliasTabIds       route ids that are an alias for another tab's sub-view and
 *                     so have no row by design (today: `mockinterview`)
 *   toolCount         TAB_ROUTES ids minus NON_TOOL_TAB_IDS
 *   voiceTabInfo      VOICE_TAB_INFO
 *   planKeys          ENROLLMENT_PLANS_FALLBACK keys
 *   allowedPrices     '₱' + toLocaleString('en-US') of every price_php / compare_at_php
 *   toolNames         every VOICE_CLIENT_TOOL_SPECS + VOICE_SERVER_TOOL_SPECS name
 *   knownIdentifiers  other snake_case identifiers the agent may legitimately be
 *                     told (show_feature_help keys, tool parameter names)
 *   roleLabels        the staff role labels
 *   adminScreenLabels VOICE_TAB_INFO labels of every adminOnly entry
 *
 * ★ THE POINT OF #6 IS THAT THIS DOCUMENT IS GLOBAL. It is attached to the agent
 *   for every caller, so a per-caller fact in it would be told to the wrong
 *   person. Prices and plan names are safe (they are the same for everyone and
 *   already public on the pricing screen); a name, an address, an expiry date or
 *   a permission list is not, and belongs in a caller-bound tool result.
 */
export function knowledgeInvariants({
  doc = '',
  routeIds = [],
  aliasTabIds = [],
  toolCount = null,
  voiceTabInfo = {},
  planKeys = [],
  allowedPrices = [],
  toolNames = [],
  knownIdentifiers = [],
  roleLabels = [],
  adminScreenLabels = [],
} = {}) {
  const results = [];
  const check = (id, ok, message) => results.push({ id, ok: Boolean(ok), message });
  const text = String(doc == null ? '' : doc).replace(/\r\n/g, '\n');
  const rolesSection = sectionBody(text, /\broles?\b/i);

  // 1. The navigation table has exactly one row per route.
  //    ★ A ROW, not a mention. This used to accept `id` in backticks ANYWHERE, and
  //    most tab ids are also named in the FAQ and course sections — so a deleted
  //    row passed, and a row for a deleted tab was never noticed at all. A row is
  //    `| label | `id` | `/path` | …`, the shape the generator emits.
  const rowIds = [...text.matchAll(/^\|[^|\n]*\|[ \t]*`([^`\n]+)`[ \t]*\|[ \t]*`\/[^`\n]*`[ \t]*\|/gm)].map((m) => m[1]);
  const aliases = new Set(aliasTabIds);
  const missingRows = routeIds.filter((id) => !aliases.has(id) && !rowIds.includes(id));
  const extraRows = [...new Set(rowIds.filter((id) => !routeIds.includes(id)))];
  const duplicateRows = [...new Set(rowIds.filter((id, n) => rowIds.indexOf(id) !== n))];
  check('nav-rows', !missingRows.length && !extraRows.length && !duplicateRows.length, [
    missingRows.length && `tab id(s) with no navigation row: ${missingRows.join(', ')} (an alias of another tab's sub-view belongs in aliasTabIds)`,
    extraRows.length && `navigation row(s) for tab id(s) that are not routes: ${extraRows.join(', ')}`,
    duplicateRows.length && `tab id(s) with more than one navigation row: ${duplicateRows.join(', ')}`,
  ].filter(Boolean).join('; '));

  // 2. Every staff role gets EXACTLY ONE bullet of its own in the ROLES SECTION.
  //    ★ Section-scoped. Counted over the whole document this passed on the
  //    2026-09-16 doc, whose roles section still describes one "Admin" — because
  //    the Team & Roles and Financial Management ROWS mention "Super Admin",
  //    "Operations Admin" and "Trainer". A role named only in a table row is not
  //    a role the agent has been told about.
  for (const label of roleLabels) {
    const id = `role-${label}`;
    if (rolesSection == null) {
      check(id, false, `the document has no "User roles" section, so "${label}" is never described`);
      continue;
    }
    const bulletHeads = (rolesSection.match(new RegExp(`^[ \\t]*[-*+][ \\t]+(?:\\*\\*|__)?${escapeRegExp(label)}(?![\\w])`, 'gm')) || []).length;
    if (!wholeWord(label).test(rolesSection)) {
      check(id, false, `the roles section never names "${label}"`);
    } else if (bulletHeads === 0) {
      // ★ EXACTLY ONE BULLET — A MENTION IS NOT A DESCRIPTION, AND `<= 1` COULD
      //   NOT TELL THEM APART. Zero bullets satisfied `<= 1`, so a roles section
      //   that described one "Admin" and merely said "…unlike a Trainer" inside
      //   that bullet passed `role-Trainer` — the same "named somewhere, never
      //   described" failure as the navigation-row hole this check was
      //   section-scoped to close, one level in. The generator emits one bullet
      //   per staff role by construction, so this is the shape it already has.
      check(id, false, `the roles section mentions "${label}" only inside another role's description; give each role its own bullet`);
    } else {
      check(id, bulletHeads === 1, `the roles section describes "${label}" in ${bulletHeads} bullets; describe each role once`);
    }
  }

  // 3. The tool count is the DERIVED one and is stated once.
  //    ★ Any "<digits> tools" counts as a claim, bold or not: an unbolded stale
  //    "32 tools" in prose is exactly as audible to the agent as the bold one.
  const claimed = [...text.matchAll(/(?<![\w.,-])(\d+)\s+tools\b/g)];
  check('tool-count-once', claimed.length === 1,
    `the document states a tool count ${claimed.length} time(s); it must state it exactly once`);
  if (claimed.length === 1 && toolCount != null) {
    const n = Number(claimed[0][1]);
    check('tool-count-derived', n === toolCount,
      `the document claims ${n} tools but the app's own NON_TOOL_TAB_IDS derives ${toolCount}`);
  }

  // 4. Nothing retired has crept back in.
  for (const term of RETIRED_KNOWLEDGE_TERMS) {
    const scrubbed = (RETIRED_TERM_HISTORICAL_USES[term] || [])
      .reduce((t, phrase) => t.split(phrase).join(''), text);
    check(`retired-${term}`, !scrubbed.includes(term),
      `"${term}" is retired but still appears in the knowledge document`);
  }

  // 5. Tool names: every one declared to the agent is documented, and no
  //    snake_case identifier that is NOT a real tool is advertised.
  //    ★ Whole-identifier matches: `navigate_to_tools` does not document
  //    `navigate_to_tool`, and an identifier with five or more underscores (or a
  //    `secret__` double underscore) is still an identifier.
  const missingTools = toolNames.filter((n) => !wholeWord(n).test(text));
  check('tools-documented', missingTools.length === 0,
    `tool(s) declared to the agent but absent from the document: ${missingTools.join(', ')}`);
  const known = new Set([...toolNames, ...planKeys, ...routeIds, ...Object.keys(voiceTabInfo || {}), ...knownIdentifiers]);
  const mentioned = [...text.matchAll(/`([a-z][a-z0-9]*(?:__?[a-z0-9]+)+)`/g)].map((m) => m[1]);
  const ghosts = [...new Set(mentioned)].filter((n) => !known.has(n));
  check('no-ghost-tools', ghosts.length === 0,
    `the document names identifier(s) that are neither a tool, a plan key nor a tab id: ${ghosts.join(', ')}`);

  // 6. No per-caller facts in a document every caller receives.
  // ★ ANY `{{…}}`, NOT ONLY A BARE IDENTIFIER ONE. The old body required the
  //   braces to wrap `\w+`, so it caught `{{user_name}}` and missed every shape
  //   that actually reaches a document by being pasted out of a prompt: a dotted
  //   `{{ user.name }}`, a hyphenated `{{ plan-label }}`, and ElevenLabs' own
  //   `{{system__caller_id}}` family with a space or a default in it. A
  //   placeholder is a per-caller fact whatever its spelling, and nothing
  //   legitimate here uses `{{` (measured on the real document: zero), so the
  //   broad form costs no coverage. `[^{}]` rather than `.` keeps it linear.
  const templateVar = /\{\{[^{}]*\}\}/.exec(text);
  check('no-template-vars', !templateVar,
    `the document contains a ${templateVar ? templateVar[0] : '{{dynamic_variable}}'} placeholder — those belong in the system prompt, not the shared knowledge base`);
  // ★ THE TLD MUST BE ALPHABETIC, OR A PACKAGE SPEC IS AN "EMAIL ADDRESS". The
  //   old `[\w.+-]+@[\w-]+\.[\w.]+` tail accepted digits, so `tus-js-client@4.1.0`,
  //   `node@24.19.0` and `@elevenlabs/client@1.2.3` — all of which this project's
  //   own docs name — were each reported as "the document contains an email
  //   address". That is a false accusation with no escape hatch (unlike the
  //   retired-term carve-out), and the only way to satisfy it is to delete a true
  //   sentence. Every real TLD is two or more letters, so requiring that costs no
  //   coverage: help.desk@example.com and alex+tag@sub.domain.example.com both
  //   still match.
  check('no-email', !/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/.test(text),
    'the document contains an email address');
  const callerVars = PER_CALLER_VARIABLE_NAMES.filter((v) => wholeWord(v).test(text));
  if (/(?<![\w])secret__\w+/.test(text)) callerVars.push('secret__*');
  check('no-caller-identity', callerVars.length === 0,
    `the document references per-caller variable name(s): ${callerVars.join(', ')}`);

  // 7. Every peso figure came from the plan catalog.
  //    ★ The figure ends on a digit, so "₱1,499, ₱2,999" is two catalog prices
  //    rather than a stray "₱1,499,"; a space after the sign and a decimal tail
  //    are read as part of the figure rather than letting it slip past.
  const prices = [...new Set([...text.matchAll(/₱[ \t ]?(\d(?:[\d,]*\d)?(?:\.\d+)?)/g)].map((m) => `₱${m[1]}`))];
  const strayPrices = prices.filter((p) => !allowedPrices.includes(p));
  check('prices-from-catalog', strayPrices.length === 0,
    `price(s) not produced by the plan catalog: ${strayPrices.join(', ')}`);

  // 8. Every plan key mentioned is a plan that exists.
  //    ★ Two nets. STRUCTURAL: a table row whose backticked key is followed by a
  //    ₱ cell is a plan row whatever its key looks like — the old name-shaped
  //    heuristic alone let `gold_live` (no "plan"/"paced"/"vip"/"sampler" in it)
  //    and any underscore-free key straight through. PROSE: a snake_case key that
  //    names a plan-ish word anywhere else.
  //    ★ ONLY THE PROSE NET CONSULTS `known`, AND IT MUST. Its filter is a
  //    SUBSTRING test for plan/paced/vip/sampler, which is exactly the shape of
  //    the legitimate identifiers around a membership catalog: `enrollment_plans`
  //    (the table), `plan_key` (the column), `vip_batch_id`, `sampler_tier`, a
  //    future `get_my_plan_summary` tool. Each was reported as "plan key(s) that
  //    are not in the catalog" — naming the wrong problem, and unresolvable,
  //    because `knownIdentifiers` silenced its sibling no-ghost-tools and was
  //    ignored here. Both checks now read ONE vocabulary of what this document may
  //    name. The STRUCTURAL net stays unconditional on purpose: a key sitting in a
  //    priced plan row is a claim about what is for sale, and no allow-list entry
  //    may excuse it.
  const planRowKeys = [...text.matchAll(/^\|[^\n]*?\|[ \t]*`([^`\n]+)`[ \t]*\|[ \t]*₱/gm)].map((m) => m[1]);
  const proseKeys = [...text.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1])
    .filter((k) => /_/.test(k) && /plan|paced|vip|sampler/.test(k) && !known.has(k));
  const strayPlans = [...new Set([...planRowKeys, ...proseKeys])].filter((k) => !planKeys.includes(k));
  check('plans-exist', strayPlans.length === 0,
    `plan key(s) that are not in the catalog: ${strayPlans.join(', ')}`);

  // 9. The roles section names every staff screen.
  //    ★ Section-scoped for the same reason as (2): the navigation table lists
  //    every admin screen by construction, so a whole-document test could only
  //    fail if the table itself were gone — and the stale "two admin screens"
  //    prose in the roles section passed it.
  const unnamedScreens = rolesSection == null
    ? adminScreenLabels.slice()
    : adminScreenLabels.filter((label) => !rolesSection.includes(label));
  check('screens-documented', unnamedScreens.length === 0,
    `staff screen(s) the roles section never names: ${unnamedScreens.join(', ')}`);

  // 10. The embedded fingerprint describes this document.
  const embedded = readKnowledgeFingerprint(text);
  const tokens = (text.match(FINGERPRINT_ALL_RE) || []).length;
  check('fingerprint-present', tokens === 1,
    tokens === 0 ? 'the document carries no fingerprint' : `the document carries ${tokens} fingerprints; it must carry exactly one`);
  if (embedded) {
    check('fingerprint-matches', embedded === knowledgeFingerprint(text),
      `the embedded fingerprint ${embedded} does not describe this document`);
  }

  return results;
}

/** The failures from knowledgeInvariants, as one printable block. Empty when clean. */
export function knowledgeInvariantFailures(results) {
  return (results || []).filter((r) => !r.ok).map((r) => `  - [${r.id}] ${r.message}`);
}
