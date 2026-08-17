// Tolerant JSON extraction for model responses.
//
// Dependency-free ESM (no imports, no side effects, no DOM) so `node --test` exercises
// exactly what the browser runs — see test/partialJson.test.mjs.
//
// Three tools in this app ask Claude for JSON and hand-roll the same fence-strip +
// brace-slice dance inline. This module is the tested version of that, plus the piece
// none of them have: recovering the COMPLETE PREFIX of a response that was cut off by
// `max_tokens`. That matters when the response is a multi-section object emitted in
// order — losing the tail should cost the tail, not the whole payload.
//
// Deliberately NOT included: the `[“”] -> "` substitution the inline copies
// perform. Curly double quotes are valid unescaped inside a JSON string, so rewriting
// them injects an unescaped delimiter — it can only ever turn parseable output into
// garbage, and it fires most often on prose containing quoted speech.

/**
 * Walk a JSON-ish string tracking string state and bracket depth.
 * @returns {{stack: string[], inString: boolean, stringStart: number}}
 *   `stack` holds the CLOSING characters still owed, outermost first.
 */
function scanJson(str) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') { inString = false; stringStart = -1; }
      continue;
    }
    if (ch === '"') { inString = true; stringStart = i; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return { stack, inString, stringStart };
}

/** Strip ```json fences and any prose surrounding the outermost object. */
export function stripFences(raw) {
  let s = String(raw == null ? '' : raw).replace(/```json|```/g, '').trim();
  const first = s.indexOf('{');
  if (first > 0) s = s.slice(first);
  return s;
}

/**
 * Close a JSON object that was cut off mid-flight, discarding the incomplete tail.
 *
 * Naively slicing to the last `}` does NOT work: on a response clipped inside a nested
 * object, the last `}` is the close of an inner element, leaving its parent array and
 * object unterminated. This walks the prefix instead, drops whatever partial token is
 * at the end, and closes the structures that are still open.
 */
/** Drop a dangling separator or an orphaned `"key":` from the end of a prefix. */
function peelDangling(str) {
  let s = str;
  for (;;) {
    const before = s;
    s = s.replace(/\s+$/, '');
    if (s.endsWith(',')) { s = s.slice(0, -1); continue; }
    if (s.endsWith(':')) {
      const key = s.match(/"(?:[^"\\]|\\.)*"\s*:$/);
      s = key ? s.slice(0, s.length - key[0].length) : s.slice(0, -1);
      continue;
    }
    if (s === before) return s;
  }
}

/** Index of the opening bracket of the LAST closed group. -1 when there is none. */
function lastGroupStart(s) {
  const opens = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') opens.push(i);
    else if (ch === '}' || ch === ']') start = opens.length ? opens.pop() : -1;
  }
  return start;
}

/** Remove the last complete token (string, balanced group, or bare literal). */
function dropLastToken(str) {
  const s = str.replace(/\s+$/, '');
  if (!s) return '';
  const last = s[s.length - 1];
  if (last === '"') {
    const m = s.match(/"(?:[^"\\]|\\.)*"$/);
    return m ? s.slice(0, s.length - m[0].length) : s.slice(0, -1);
  }
  if (last === '}' || last === ']') {
    const start = lastGroupStart(s);
    return start >= 0 ? s.slice(0, start) : '';
  }
  const bare = s.match(/[A-Za-z0-9+.eE_-]+$/);
  return bare ? s.slice(0, s.length - bare[0].length) : s.slice(0, -1);
}

function closeOpenStructures(s) {
  const { stack } = scanJson(s);
  let out = s;
  while (stack.length) out += stack.pop();
  return out;
}

export function repairTruncatedJson(input) {
  let s = stripFences(input);
  if (!s) return '';

  // If we ended mid-string, discard that string entirely — a partial value is worse
  // than a missing one, and the caller filters missing fields out anyway.
  const first = scanJson(s);
  if (first.inString && first.stringStart >= 0) s = s.slice(0, first.stringStart);

  // Peel one token at a time, VERIFYING each candidate by actually parsing it. Checking
  // the result rather than reasoning about it is what makes the postcondition — "the
  // output parses, or it is empty" — hold for every possible cut point, including the
  // ones that are easy to miss (a bare `{"key"` with no value, a half-written number).
  for (let guard = 0; guard < 500 && s; guard++) {
    const peeled = peelDangling(s);
    if (!peeled) return '';
    const candidate = closeOpenStructures(peeled);
    try {
      JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1'));
      return candidate;
    } catch {
      const next = dropLastToken(peeled);
      if (next === peeled) return '';
      s = next;
    }
  }
  return '';
}

/**
 * Parse a model response into an object, trying progressively more aggressive recovery.
 *
 * @param {string} raw the model's text
 * @param {{ allowTruncated?: boolean }} [opts] when true, attempt prefix recovery for a
 *   response cut off by `max_tokens`. Off by default: silently salvaging a prefix hides
 *   a genuinely malformed response, so callers opt in only when they KNOW it was clipped.
 * @returns {any} the parsed value
 * @throws {SyntaxError} when nothing parses
 */
export function parseLooseJson(raw, opts = {}) {
  const stripped = stripFences(raw);

  // 1. As-is, between the outermost braces.
  const last = stripped.lastIndexOf('}');
  const sliced = last > 0 ? stripped.slice(0, last + 1) : stripped;
  try {
    return JSON.parse(sliced);
  } catch { /* fall through */ }

  // 2. Common model slips that do NOT change meaning: a trailing comma before a
  //    closer, and curly SINGLE quotes (safe — they are ordinary characters inside a
  //    double-quoted JSON string, unlike curly double quotes).
  try {
    return JSON.parse(sliced.replace(/,(\s*[}\]])/g, '$1').replace(/[‘’]/g, "'"));
  } catch { /* fall through */ }

  // 3. Recover the complete prefix of a clipped response.
  if (opts.allowTruncated) {
    const repaired = repairTruncatedJson(stripped);
    // Not in a try: if this throws, the response was unusable and the caller needs to know.
    return JSON.parse(repaired.replace(/,(\s*[}\]])/g, '$1'));
  }

  // Re-throw the original failure with its real message.
  return JSON.parse(sliced);
}
