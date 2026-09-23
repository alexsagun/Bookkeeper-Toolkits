// ─────────────────────────────────────────────────────────────────────────────
// src/lib/lessonDocument.js — the bridge between stored lesson markdown and the
// editable document model (pure).
//
// PURE and dependency-free apart from ./lessonContent.js, which is the authority for
// what a lesson MAY contain. This is the second sanctioned lib→lib import in the repo
// (src/lib/mp4Faststart.js → courseVideo.js is the first) and for the same reason: a
// second reading of a rule that already has one owner is how two parsers come to
// disagree about the same document.
//
// It emits and consumes plain JSON shaped like a ProseMirror document. That is DATA,
// not a dependency — no Tiptap, no ProseMirror, no React, no DOM — so `node --test`
// exercises every rule below directly.
//
// ★ WHY A CONVERTER AND NOT A NEW STORAGE FORMAT.
//   The editor's document model is a convenience that lives for as long as a drawer is
//   open. What is STORED stays the closed markdown subset lessonContent.js defines,
//   because three other things already read it and must keep reading exactly the same
//   bytes: validateLessonContent (what may be saved), the Postgres trigger
//   course_lesson_sync_assets (which images a lesson is authorized to show), and
//   lessonContentToPlainText (what the AI trainer indexes). Changing the storage format
//   would mean changing a regex inside a migration already applied to production.
//
// ★ THE SERIALIZER'S ALPHABET IS CLOSED, AND THAT IS THE SECURITY ARGUMENT.
//   docToMarkdown concatenates only: escaped text, `**`, `[`, `](`, `)`, `- `, `N. `,
//   `^ `, buildAssetToken() output, and a brokenToken's verbatim source. There is no
//   branch anywhere that writes `<`…`>` as structure, so raw HTML is unrepresentable
//   rather than filtered — the same argument lessonContent.js makes about its parser.
//
// ★ AND THE ROUND TRIP IS CHECKED, NOT ASSERTED.
//   Every block is serialized, re-parsed and compared against what it should give back.
//   On a mismatch it falls back to a more conservative rendering rather than writing a
//   document that reads differently from the one the creator was looking at. See
//   blockMarkdown(). The tests prove the fallbacks are unreachable for every hazard we
//   know about; the net is there for the one nobody enumerated.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BARE_URL_RE,
  LESSON_CAPTION_MARKER,
  buildAssetToken,
  inlineToText,
  normalizeFormat,
  parseLessonContent,
  safeLessonHref,
  sanitizeAltText,
  sanitizeCaption,
} from './lessonContent.js';

/**
 * The document model's complete vocabulary — everything this converter will read or write.
 *
 * ★ THE EDITOR SCHEMA IS NOT *DERIVED* FROM THESE LISTS, AND SAYING SO WAS AN OVERSTATEMENT.
 *   `buildLessonExtensions` in `src/editor/LessonDocumentEditor.jsx` is a hand-written array
 *   (it also carries behavioural extensions — undo, dropcursor, gapcursor, placeholder,
 *   shortcuts — that are not schema at all, so a pure derivation would not be natural). What
 *   IS true, and is what the guarantee rests on: ProseMirror's schema is an allowlist, so a
 *   node the editor does not declare cannot exist in its document; and this converter ignores
 *   anything it does not recognise, so an unknown node cannot reach the serializer either.
 *   Two independent allowlists rather than one derived from the other — which is only safe
 *   while they agree, so `test/uiSafety.test.mjs` §24 checks each name here against the
 *   extension that declares it, in both directions. Reported by code review: the previous
 *   wording claimed an enforcement that nothing performed.
 */
export const LESSON_DOC_NODES = Object.freeze([
  'doc', 'paragraph', 'text', 'hardBreak',
  'bulletList', 'orderedList', 'listItem',
  'lessonImage', 'uploadingImage', 'brokenToken',
]);

export const LESSON_DOC_MARKS = Object.freeze(['bold', 'link']);

/** A document with nothing in it still needs one block: `doc` content is `block+`. */
export const emptyLessonDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** ESCAPABLE from lessonContent.js minus `-` and `.`, which are handled by POSITION. */
const ESCAPABLE_INLINE = '\\*[]!';

/** Trailing punctuation parseInline gives back to the sentence when autolinking. */
const URL_TRAILING = '.,;:!?';

const isObj = (v) => !!v && typeof v === 'object';
const nodesOf = (doc) => (isObj(doc) && Array.isArray(doc.content) ? doc.content : []);
const contentOf = (n) => (isObj(n) && Array.isArray(n.content) ? n.content : []);

// ─────────────────────────────────────────────────────────────────────────────
// Marks
// ─────────────────────────────────────────────────────────────────────────────

const markKey = (m) => (m && m.type === 'link'
  ? `link:${m.attrs && m.attrs.href}:${m.attrs && m.attrs.bare ? 1 : 0}`
  : `${m && m.type}`);

/** Marks in a stable order, so two nodes that carry the same marks compare equal. */
const sortMarks = (marks) => (Array.isArray(marks) ? marks : [])
  .filter((m) => isObj(m) && LESSON_DOC_MARKS.includes(m.type))
  .map((m) => (m.type === 'link'
    ? { type: 'link', attrs: { href: String((m.attrs && m.attrs.href) || ''), bare: !!(m.attrs && m.attrs.bare) } }
    : { type: m.type }))
  .sort((a, b) => (markKey(a) < markKey(b) ? -1 : markKey(a) > markKey(b) ? 1 : 0));

const marksKey = (marks) => sortMarks(marks).map(markKey).join('|');
const hasMark = (n, type) => (isObj(n) && Array.isArray(n.marks) ? n.marks : []).some((m) => m && m.type === type);
const linkMarkOf = (n) => ((isObj(n) && Array.isArray(n.marks) ? n.marks : []).find((m) => m && m.type === 'link') || null);

const withMarks = (node, marks) => (marks && marks.length ? { ...node, marks: sortMarks(marks) } : node);

const addMark = (marks, mark) => {
  // A link inside a link is unrepresentable in the source grammar (linkAt parses a label
  // with inLink = true), so a second link mark can never legitimately arrive. Replacing
  // rather than appending keeps that true if one ever does.
  const kept = mark.type === 'link' ? marks.filter((m) => m.type !== 'link') : marks;
  return kept.some((m) => markKey(m) === markKey(mark)) ? kept : [...kept, mark];
};

// ─────────────────────────────────────────────────────────────────────────────
// markdown / plain  →  document
// ─────────────────────────────────────────────────────────────────────────────

const textNode = (text, marks) => withMarks({ type: 'text', text }, marks);

const pushText = (out, value, marks) => {
  if (!value) return;
  const last = out[out.length - 1];
  // Adjacent text with identical marks is ONE node. An editor normalizes them anyway,
  // so an unmerged document could never compare equal to a re-parsed one.
  if (last && last.type === 'text' && marksKey(last.marks) === marksKey(marks)) {
    out[out.length - 1] = { ...last, text: last.text + value };
    return;
  }
  out.push(textNode(value, marks));
};

/**
 * `plain` is not parsed at all — that is the whole meaning of the format.
 *
 * Blank lines end a paragraph and single newlines become hard breaks, which is exactly
 * what `whitespace-pre-line` showed before any of this existed. No parseInline, ever:
 * a legacy note containing `**` or `[1]` must not acquire formatting by being opened.
 */
function plainToBlocks(src) {
  const out = [];
  let lines = [];
  const flush = () => {
    if (!lines.length) return;
    const content = [];
    lines.forEach((line, i) => {
      if (i) content.push({ type: 'hardBreak' });
      if (line) content.push(textNode(line, []));
    });
    out.push({ type: 'paragraph', content });
    lines = [];
  };
  for (const line of String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')) {
    // The same test parseLessonContent uses, so a whitespace-only line means the same
    // thing on both sides of the bridge.
    if (!line.trim()) { flush(); continue; }
    lines.push(line);
  }
  flush();
  return out;
}

/**
 * Inline tokens → inline nodes.
 *
 * An `image` token reaching here is one the caller could not lift into a block — nested
 * in bold, or inside a list item, where `listItem` holds exactly one paragraph. It keeps
 * its real token bytes as a brokenToken, so the reference the DATABASE derives from the
 * text survives even though the picture is shown as source. Losing the bytes would
 * silently drop an authorized image.
 */
function inlineNodes(tokens, marks, out) {
  for (const t of tokens || []) {
    if (!isObj(t)) continue;
    switch (t.type) {
      case 'text':
        pushText(out, t.value, marks);
        break;
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
      case 'bold':
        inlineNodes(t.tokens, addMark(marks, { type: 'bold' }), out);
        break;
      case 'link':
        inlineNodes(t.tokens, addMark(marks, {
          type: 'link', attrs: { href: t.href, bare: !!t.bare },
        }), out);
        break;
      case 'image': {
        const raw = buildAssetToken(t.assetId, t.alt, { requireAlt: false });
        if (raw) out.push(withMarks({ type: 'brokenToken', attrs: { raw } }, marks));
        break;
      }
      case 'badlink':
      case 'badimage':
        if (t.raw) out.push(withMarks({ type: 'brokenToken', attrs: { raw: t.raw } }, marks));
        // Without the source bytes the words are still worth keeping — losing a refused
        // link's LABEL would delete the creator's sentence along with its address.
        else inlineNodes(t.tokens || [], marks, out);
        break;
      default:
        break;
    }
  }
}

const imageNode = (assetId, alt, caption) => ({
  type: 'lessonImage',
  attrs: {
    assetId: String(assetId || '').trim().toLowerCase(),
    alt: sanitizeAltText(alt),
    caption: sanitizeCaption(caption),
  },
});

/** A caption is a plain-text attribute, so a token array has to be flattened to read it. */
const captionText = (tokens) => sanitizeCaption(
  inlineToText(tokens || [], { bareLinkAs: 'text' }),
);

/**
 * A paragraph splits at every inline image, because `lessonImage` is a BLOCK node.
 *
 * `See ![A](…) here` becomes paragraph / image / paragraph, which is also how it reads
 * on the page. This is the one normalization that changes what lessonContentToPlainText
 * produces, so it moves the AI trainer's content hash for the affected lessons — once.
 */
function pushParagraph(out, tokens) {
  let run = [];
  let split = false;
  const flushRun = () => {
    if (!run.length) { return; }
    const content = [];
    inlineNodes(run, [], content);
    // The space either side of a lifted image is an artifact of the split, not something
    // anybody typed — `See ![A](…) here` should read "See" / image / "here", not carry a
    // dangling space into two separate paragraphs.
    const trimmed = trimBreaks(split ? trimEdgeSpace(content) : content);
    if (trimmed.length) out.push({ type: 'paragraph', content: trimmed });
    run = [];
  };
  for (const t of tokens || []) {
    if (isObj(t) && t.type === 'image') {
      split = true;
      flushRun();
      out.push(imageNode(t.assetId, t.alt, ''));
    } else {
      run.push(t);
    }
  }
  flushRun();
}

function pushBlock(out, b) {
  if (!isObj(b)) return;
  switch (b.type) {
    case 'paragraph':
      pushParagraph(out, b.tokens);
      return;
    case 'list': {
      const items = [];
      for (const item of b.items || []) {
        const content = [];
        inlineNodes(item, [], content);
        // An item is ONE line in the source grammar, so a hard break cannot survive in
        // one; flattening them here keeps the document honest about what can be stored.
        const flat = flattenBreaksToSpaces(trimBreaks(content));
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: flat }] });
      }
      if (items.length) out.push({ type: b.ordered ? 'orderedList' : 'bulletList', content: items });
      return;
    }
    case 'imageBlock':
      out.push(imageNode(b.assetId, b.alt, captionText(b.caption)));
      return;
    case 'badimageBlock': {
      const content = [];
      if (b.raw) content.push({ type: 'brokenToken', attrs: { raw: b.raw } });
      const cap = captionText(b.caption);
      if (content.length && cap) {
        content.push({ type: 'hardBreak' });
        pushText(content, `${LESSON_CAPTION_MARKER}${cap}`, []);
      }
      if (content.length) out.push({ type: 'paragraph', content });
      return;
    }
    case 'plain':
      for (const p of plainToBlocks(b.value)) out.push(p);
      return;
    default:
      return;
  }
}

/**
 * Stored text → an editable document.
 *
 * `withSource: true` is asked for here and nowhere else in the app: it is what lets a
 * token this model cannot REPRESENT round-trip byte-identically instead of being
 * silently rewritten. See the comment on imageAt() in lessonContent.js.
 */
export function markdownToDoc(text, format) {
  const src = typeof text === 'string' ? text : '';
  const content = [];
  if (normalizeFormat(format) === 'plain') {
    for (const b of plainToBlocks(src)) content.push(b);
  } else {
    for (const b of parseLessonContent(src, 'markdown', { withSource: true })) pushBlock(content, b);
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization — the shape every document the editor loads is already in
// ─────────────────────────────────────────────────────────────────────────────

/** Drop whitespace at the very start and end of an inline run, keeping the run's shape. */
function trimEdgeSpace(nodes) {
  const out = nodes.slice();
  while (out.length && out[0].type === 'text') {
    const t = out[0].text.replace(/^\s+/, '');
    if (t === out[0].text) break;
    if (t) { out[0] = { ...out[0], text: t }; break; }
    out.shift();
  }
  for (let i = out.length - 1; i >= 0 && out[i].type === 'text'; i -= 1) {
    const t = out[i].text.replace(/\s+$/, '');
    if (t === out[i].text) break;
    if (t) { out[i] = { ...out[i], text: t }; break; }
    out.pop();
  }
  return out;
}

/** Collapse runs of hard breaks and drop them at either end: a blank line ends a block. */
function trimBreaks(nodes) {
  const out = [];
  for (const n of nodes) {
    if (!isObj(n)) continue;
    if (n.type === 'hardBreak') {
      if (!out.length) continue;
      if (out[out.length - 1].type === 'hardBreak') continue;
      out.push(n);
      continue;
    }
    if (n.type === 'text' && !n.text) continue;
    out.push(n);
  }
  while (out.length && out[out.length - 1].type === 'hardBreak') out.pop();
  return out;
}

/**
 * Canonicalize a node's marks the way the serializer will write them.
 *
 * A link whose address `safeLessonHref` refuses loses the mark entirely, because that is
 * exactly what renderLinkSegment does with it — the words stay, the address does not.
 */
function canonMarks(marks) {
  const out = [];
  for (const m of sortMarks(marks)) {
    if (m.type !== 'link') { out.push(m); continue; }
    const verdict = safeLessonHref(m.attrs.href);
    if (!['external', 'internal', 'fragment'].includes(verdict.kind)) continue;
    // ★ THE HREF IS NOT PERCENT-ENCODED HERE, AND THAT MATTERS. Encoding at this point
    //   broke the "markdownToDoc's output is already normal" invariant: a bare Wikipedia
    //   URL parses to an href BARE_URL_RE already truncated at the `)`, so the raw form is
    //   unbalanced, normalization rewrote it, the comparison failed, and the conservative
    //   tier shipped `[truncated text](different address)` — a live link to a 404, with a
    //   stray `)` beside it, converging permanently after one save. Encoding belongs at
    //   EMIT time only (renderLinkSegment); the comparison key applies the same rule to
    //   both sides so the two never disagree about it.
    out.push({ type: 'link', attrs: { href: verdict.href, bare: !!m.attrs.bare } });
  }
  return out;
}

/**
 * Attach the link mark the PARSER would attach to a bare URL sitting in ordinary text.
 *
 * ★ WITHOUT THIS THE ROUND-TRIP NET FAILED OPEN AND DELETED PEOPLE'S LINKS. Nothing in the
 *   canvas linkifies as you type, so a URL a creator pastes into a sentence is a plain
 *   text node with no mark. `markdownToDoc` of the serialized text DOES autolink it, so
 *   the re-parse never matched the model, all three tiers were rejected, and
 *   `blockMarkdown` shipped the LITERAL rendering — which drops every `[label](href)` and
 *   every `**bold**` in that block. Measured on an ordinary paragraph: the Google Form
 *   link and the bold sentence both vanished, `validateLessonContent` said ok, and the
 *   canvas still showed them because it is seeded once and never re-read.
 *   Mirroring the parser here makes the common case match at the first tier.
 */
function autolinkBareText(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type !== 'text' || (n.marks || []).some((m) => m.type === 'link')) { out.push(n); continue; }
    let rest = String(n.text || '');
    let guard = 0;
    while (rest && guard < 500) {
      guard += 1;
      const m = BARE_URL_RE.exec(rest);
      if (!m) break;
      let raw = m[0];
      // The same trailing-punctuation rule parseInline applies: a full stop at the end of
      // a sentence belongs to the sentence, not to the address.
      while (raw.length && URL_TRAILING.includes(raw[raw.length - 1])) raw = raw.slice(0, -1);
      const verdict = raw ? safeLessonHref(raw) : { kind: 'none' };
      const before = rest.slice(0, m.index);
      if (verdict.kind !== 'external') {
        // Not linkable: keep it as text and step past it, or this loops for ever.
        out.push({ ...n, text: before + m[0] });
        rest = rest.slice(m.index + m[0].length);
        continue;
      }
      if (before) out.push({ ...n, text: before });
      out.push(withMarks({ type: 'text', text: raw },
        [...(n.marks || []), { type: 'link', attrs: { href: verdict.href, bare: true } }]));
      rest = rest.slice(m.index + raw.length);
    }
    if (rest) out.push({ ...n, text: rest });
  }
  return out;
}

/**
 * ★ EVERY NORMALIZATION THE SERIALIZER PERFORMS, THE MODEL MUST PERFORM TOO.
 *
 * blockMarkdown() serializes a block and reads it back to check it still says the same
 * thing. That check cannot tell a CORRECT normalization from a defect, so a normalization
 * the model does not know about looks like corruption and sends the block down to the
 * literal fallback — which drops the link or the bold it was trying to protect. Both of
 * those were real, and both were caught here rather than in production.
 *
 * Three of them live in this function: a refused address loses its mark, a `]` cannot
 * survive inside a label, and an unbalanced parenthesis is percent-encoded. The fourth,
 * peeling a trailing asterisk out of a bold run, needs a whole run and follows below.
 */
/**
 * A hard break cannot exist inside a list item — an item is ONE line in the stored
 * grammar. It becomes a SPACE, never nothing.
 *
 * ★ DROPPING IT SILENTLY GLUED TWO WORDS TOGETHER. Shift+Enter is an ordinary gesture
 *   (HardBreak binds it and ListItem does not override it), and the canvas goes on
 *   showing two lines because normalization happens at serialize time — so the creator
 *   saw a line break and the student read "open the formthen bold word". Measured on the
 *   real converter before the fix. The round-trip net could never catch it: it compares
 *   against the already-normalized model, so both sides agreed on the corrupted text.
 */
function flattenBreaksToSpaces(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (isObj(n) && n.type === 'hardBreak') { pushText(out, ' ', []); continue; }
    out.push(n);
  }
  return trimBreaks(out);
}

function normalizeInline(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (!isObj(n)) continue;
    if (n.type === 'text') {
      const marks = canonMarks(n.marks);
      let text = String(n.text == null ? '' : n.text);
      // linkAt's indexOf(']') is escape-blind, so a `]` closes the label early and the
      // token stops being a link at all. It cannot be carried; it is dropped here so the
      // document and the stored text agree about that.
      if (marks.some((m) => m.type === 'link')) text = text.replace(/]/g, '');
      // ★ THE FIFTH NORMALIZATION, AND IT MUST BE MIRRORED HERE LIKE THE OTHER FOUR.
      //   escapeText() turns a newline inside a text node into a space; without the same
      //   move in the model, blockMarkdown's re-parse disagreed with the model it was
      //   checking and sent the block to the LITERAL tier — which drops the very bold and
      //   link it exists to protect. Measured: a bold node containing "a\nb" beside a link
      //   serialized to "a b and link", losing BOTH marks, where the same content without
      //   the newline kept both. Reachable only from a programmatic insert today, but it
      //   is an instance of exactly the defect class this invariant forbids.
      text = text.replace(/[\r\n]+/g, ' ');
      pushText(out, text, marks);
      continue;
    }
    if (n.type === 'hardBreak') { out.push({ type: 'hardBreak' }); continue; }
    if (n.type === 'brokenToken') {
      const raw = String((n.attrs && n.attrs.raw) || '');
      if (raw) out.push(withMarks({ type: 'brokenToken', attrs: { raw } }, canonMarks(n.marks)));
      continue;
    }
    // uploadingImage, lessonImage and anything unknown are not inline content. A
    // lessonImage caught here is lifted by normalizeBlocks, which runs first.
  }
  return trimBreaks(peelBoldAsterisks(autolinkBareText(out)));
}

/**
 * Move trailing asterisks OUT of a bold run.
 *
 * parseInline closes a run with `indexOf('**')`, which cannot see a backslash, so a run
 * ending in an asterisk closes one character early and swallows the escape: `**a\***`
 * reads back as bold("a\") + "*", putting a stray backslash in somebody's lesson. Bold
 * over "a" followed by a plain "*" is the honest reading, and it is stable.
 */
function peelBoldAsterisks(nodes) {
  const res = [];
  let i = 0;
  while (i < nodes.length) {
    if (!hasMark(nodes[i], 'bold')) { res.push(nodes[i]); i += 1; continue; }
    let j = i;
    while (j < nodes.length && hasMark(nodes[j], 'bold')) j += 1;
    const run = nodes.slice(i, j);
    let tail = '';
    const last = run[run.length - 1];
    if (last && last.type === 'text') {
      const m = /\*+$/.exec(last.text);
      if (m) {
        tail = m[0];
        const rest = last.text.slice(0, -tail.length);
        if (rest) run[run.length - 1] = { ...last, text: rest };
        else run.pop();
      }
    }
    for (const n of run) res.push(n);
    if (tail) {
      const kept = (run[0] || last || {}).marks || [];
      res.push(withMarks({ type: 'text', text: tail }, kept.filter((m) => m.type !== 'bold')));
    }
    i = j;
  }
  // Peeling can leave two adjacent text nodes with identical marks, which an editor
  // would have merged — so merge them, or the document could never compare equal.
  const merged = [];
  for (const n of res) {
    if (n.type === 'text') pushText(merged, n.text, n.marks || []);
    else merged.push(n);
  }
  return merged;
}

/**
 * Put a document into the one shape `markdownToDoc` can return.
 *
 * This is what makes the round-trip contract provable rather than hopeful:
 *   markdownToDoc(docToMarkdown(d))  ===  normalizeDoc(d)
 * and since markdownToDoc's own output is already normal, a document that came out of
 * it survives a save and a reload exactly.
 */
export function normalizeBlocks(nodes, depth = 0) {
  const out = [];
  if (depth > 20) return out;
  for (const node of nodes || []) {
    if (!isObj(node)) continue;
    switch (node.type) {
      case 'uploadingImage':
        // ★ NEVER STORED. An upload still in flight is not lesson content: the asset row
        //   does not exist yet, so a token for it would make the database refuse the
        //   whole save with an accurate error that reads like a bug.
        break;
      case 'lessonImage': {
        const img = imageNode(node.attrs && node.attrs.assetId, node.attrs && node.attrs.alt,
          node.attrs && node.attrs.caption);
        // An id buildAssetToken would refuse is a node that can never be written; keeping
        // it would mean the editor showed something the save silently dropped.
        if (buildAssetToken(img.attrs.assetId, 'x', { requireAlt: false })) out.push(img);
        break;
      }
      case 'paragraph': {
        // Defensive: an inline image should not exist (the node is a block), but if one
        // arrives it is lifted here rather than discarded by normalizeInline.
        let run = [];
        const flush = () => {
          const inline = normalizeInline(run);
          if (inline.length) out.push({ type: 'paragraph', content: inline });
          run = [];
        };
        for (const c of contentOf(node)) {
          if (isObj(c) && (c.type === 'lessonImage' || c.type === 'uploadingImage')) {
            flush();
            for (const lifted of normalizeBlocks([c], depth + 1)) out.push(lifted);
          } else run.push(c);
        }
        flush();
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const items = [];
        for (const li of contentOf(node)) {
          if (!isObj(li)) continue;
          const para = contentOf(li).find((c) => isObj(c) && c.type === 'paragraph');
          const inline = flattenBreaksToSpaces(normalizeInline(contentOf(para || li)));
          if (inline.length) items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline }] });
        }
        if (items.length) out.push({ type: node.type, content: items });
        break;
      }
      default: {
        // An unknown block degrades to its own contents rather than throwing or
        // vanishing — a paste that slipped past the schema keeps its words.
        const inner = normalizeBlocks(contentOf(node), depth + 1);
        for (const n of inner) out.push(n);
        break;
      }
    }
  }
  return out;
}

export function normalizeDoc(doc) {
  const content = normalizeBlocks(nodesOf(doc));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// document  →  markdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape every character that could otherwise start a token.
 *
 * Mirrors escapeMarkdown's CHARACTER loop only; the two positional rules are applied to
 * a finished LINE by escapeLeading(), because inside a list item the `- ` prefix is
 * written by this module after the text is already escaped.
 */
function escapeText(value, { inLabel = false } = {}) {
  let out = '';
  // for…of iterates code points, so a surrogate pair is never split — escapeMarkdown
  // does the same and a split pair would corrupt an emoji in a lesson.
  for (const ch of String(value == null ? '' : value)) {
    // A newline inside a text node would end the block on re-parse. It is a hardBreak
    // NODE in this model, so a stray one collapses to a space, the way applyLink's
    // "a label is one line" rule collapses one.
    if (ch === '\n' || ch === '\r') { out += ' '; continue; }
    // ★ linkAt's `indexOf(']')` is ESCAPE-BLIND, so `\]` closes a label one character
    //   early and the whole token stops being a link — verified: `[a\]b](https://x/)`
    //   parses as text, a BARE autolink and a stray `)`. `[` is harmless, because a
    //   token is only accepted when the character after `]` is `(`, so it is escaped
    //   and kept rather than dropped.
    if (inLabel && ch === ']') continue;
    out += ESCAPABLE_INLINE.includes(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** The two POSITIONAL rules, applied to an assembled line BEFORE any list marker. */
const escapeLeading = (line) => line
  .replace(/^(\s*)-(\s)/, '$1\\-$2')
  .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4');

/**
 * Wrap a run in bold, or degrade rather than corrupt it.
 *
 * `parseInline` finds the closing delimiter with `indexOf('**')`, which cannot see a
 * backslash — so a run ENDING in an asterisk closes one character early and the bold
 * swallows the escape: `**a\***` reads back as bold("a\") + "*". Peeling the trailing
 * asterisks out of the run gives bold("a") + "*" instead: visible, minimal, idempotent.
 */
function boldWrap(inner) {
  if (!inner) return ''; // `****` is literal text, not an empty bold run.
  let body = inner;
  let tail = '';
  while (body.endsWith('*')) {
    const cut = body.endsWith('\\*') ? 2 : 1;
    tail = body.slice(-cut) + tail;
    body = body.slice(0, -cut);
  }
  return body ? `**${body}**${tail}` : tail;
}

/** Mirrors closingParen's depth walk: an UNBALANCED `(` is as fatal as an unbalanced `)`. */
function parensBalanced(s) {
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
}

/**
 * ★ PARENTHESES ARE ENCODED ONLY WHEN THEY HAVE TO BE.
 *   A token ends at the `)` that BALANCES its `(`, so a balanced address survives
 *   verbatim — Wikipedia's `/Trial_balance_(accounting)` is the everyday case and
 *   encoding it would churn the stored text on every save. An unbalanced one closes the
 *   token early and produces a working link to a DIFFERENT address, which is worse than
 *   no link at all, so those get applyLink's %28/%29 treatment.
 */
const encodeUnbalancedParens = (href) => (parensBalanced(href)
  ? href
  : href.replace(/\(/g, '%28').replace(/\)/g, '%29'));

/**
 * May this bare URL be written as a bare URL, given what follows it on the line?
 *
 * BARE_URL_RE is greedy and parseInline hands trailing `.,;:!?` back to the sentence, so
 * a URL with text typed straight after it re-parses as a LONGER url — a silently
 * different destination. Replaying the parser's own match is the only honest test; a
 * failure demotes the link to an explicit `[label](href)`, which is lossless.
 */
function bareSurvives(urlText, rest) {
  const m = BARE_URL_RE.exec(urlText + rest);
  if (!m || m.index !== 0) return false;
  let raw = m[0];
  while (raw.length && URL_TRAILING.includes(raw[raw.length - 1])) raw = raw.slice(0, -1);
  return raw === urlText;
}

/** Text, broken tokens and bold — everything that is not a link boundary. */
function renderRun(nodes, mode, opts) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += escapeText(n.text, opts);
    else if (n.type === 'brokenToken') out += String((n.attrs && n.attrs.raw) || '');
  }
  return out;
}

function renderInline(nodes, mode, opts) {
  let out = '';
  let i = 0;
  while (i < nodes.length) {
    if (mode !== 'literal' && hasMark(nodes[i], 'bold')) {
      let j = i;
      while (j < nodes.length && hasMark(nodes[j], 'bold')) j += 1;
      out += boldWrap(renderRun(nodes.slice(i, j), mode, opts));
      i = j;
      continue;
    }
    out += renderRun([nodes[i]], mode, opts);
    i += 1;
  }
  return out;
}

/** One text node, no bold — the only shape a bare URL may be written back in. */
function onlyPlainText(nodes) {
  if (nodes.length !== 1) return null;
  const n = nodes[0];
  return n.type === 'text' && !hasMark(n, 'bold') ? String(n.text || '') : null;
}

/**
 * ★ THE SINGLE CHOKEPOINT FOR EVERY href THIS MODULE EMITS.
 *   The address written is `verdict.href` — never the mark's own value — so a
 *   `javascript:`, `data:`, `blob:`, `http:`, protocol-relative or credential-bearing
 *   URL cannot be written at all. The label survives as ordinary text with no brackets,
 *   which is the rule safeLinkHref() established: never emit a "safe-looking" fallback.
 */
function renderLinkSegment(nodes, link, mode, rest) {
  if (mode === 'literal') return renderInline(nodes, mode, {});
  const verdict = safeLessonHref(link.attrs && link.attrs.href);
  if (!['external', 'internal', 'fragment'].includes(verdict.kind)) {
    return renderInline(nodes, mode, {});
  }
  if (mode === 'preferred' && link.attrs && link.attrs.bare && verdict.kind === 'external') {
    const only = onlyPlainText(nodes);
    // The destination may not drift: the text has to resolve to the same address the
    // mark carries, or writing it bare would change where the words point.
    if (only && safeLessonHref(only).href === verdict.href && bareSurvives(only, rest)) return only;
  }
  const label = renderInline(nodes, mode, { inLabel: true });
  if (!label.trim()) return ''; // an empty label is not a link, it is a stray token
  return `[${label}](${encodeUnbalancedParens(verdict.href)})`;
}

/** Split a line into runs that share a link mark, so each link is emitted once. */
function segmentsOf(nodes) {
  const segs = [];
  for (const n of nodes) {
    const link = linkMarkOf(n);
    const last = segs[segs.length - 1];
    if (last && markKey(last.link) === markKey(link)) last.nodes.push(n);
    else segs.push({ link, nodes: [n] });
  }
  return segs;
}

function renderLine(nodes, mode) {
  const segs = segmentsOf(nodes);
  const out = new Array(segs.length);
  // Right to left, because a bare link's verdict depends on what FOLLOWS it.
  let rest = '';
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const seg = segs[i];
    out[i] = seg.link ? renderLinkSegment(seg.nodes, seg.link, mode, rest) : renderInline(seg.nodes, mode, {});
    rest = out[i] + rest;
  }
  return out.join('');
}

function renderLines(content, mode) {
  const lines = [[]];
  for (const n of content || []) {
    if (!isObj(n)) continue;
    if (n.type === 'hardBreak') { lines.push([]); continue; }
    if (n.type === 'uploadingImage') continue;
    lines[lines.length - 1].push(n);
  }
  // A blank line ENDS a block, so an empty line inside a paragraph is not representable.
  return lines.map((l) => escapeLeading(renderLine(l, mode))).filter((l) => l.trim() !== '');
}

/**
 * ★ THE ONLY PLACE THIS MODULE WRITES AN IMAGE TOKEN.
 *   buildAssetToken tests UUID_RE and hard-codes LESSON_ASSET_SCHEME, so a signed URL,
 *   a storage path, a blob: URL or a base64 data URI placed in `assetId` produces the
 *   empty string and nothing is written. A lessonImage node carries no other address.
 */
function figureMarkdown(attrs) {
  const token = buildAssetToken(attrs && attrs.assetId, attrs && attrs.alt, { requireAlt: false });
  if (!token) return '';
  // The cap is applied to the UNESCAPED text, because validateLessonContent measures the
  // unescaped length too — slicing escaped text could cut a `\x` pair in half.
  const cap = sanitizeCaption(attrs && attrs.caption);
  if (!cap) return token;
  // Directly the NEXT line, never a blank line away: a blank line ends the block and the
  // caption would become an ordinary paragraph of "^ …" text.
  return `${token}\n${LESSON_CAPTION_MARKER}${escapeText(cap)}`;
}

function renderList(node, mode) {
  const ordered = node.type === 'orderedList';
  const items = [];
  for (const li of contentOf(node)) {
    if (!isObj(li)) continue;
    const para = contentOf(li).find((c) => isObj(c) && c.type === 'paragraph');
    // Joined with a space: an item is one line in the source grammar, so a hard break
    // inside one cannot be stored and silently ending the list would be worse.
    const text = renderLines(contentOf(para || li), mode).join(' ').trim();
    if (text) items.push(text);
  }
  // Always `N. `: OL_RE accepts `.` and `)` and the parser discards the number, so there
  // is nothing to preserve. lessonContentToPlainText already renumbers from 1, so this
  // does not move the AI trainer's hash.
  return items.map((t, i) => (ordered ? `${i + 1}. ${t}` : `- ${t}`)).join('\n');
}

function renderBlock(node, mode, depth = 0) {
  if (!isObj(node) || depth > 20) return '';
  switch (node.type) {
    case 'paragraph': return renderLines(contentOf(node), mode).join('\n');
    case 'bulletList':
    case 'orderedList': return renderList(node, mode);
    case 'lessonImage': return figureMarkdown(node.attrs);
    case 'uploadingImage': return '';
    default:
      return contentOf(node).map((c) => renderBlock(c, mode, depth + 1)).filter(Boolean).join('\n\n');
  }
}

/**
 * A comparison key for "do these two documents say the same thing".
 *
 * ★ `bare` IS DROPPED, BECAUSE IT IS A RENDERING HINT AND NOT CONTENT. It means "this
 *   address was written as a bare URL, keep it that way if you can" — and whether it CAN
 *   depends on what follows it on the line, which only the serializer knows. Comparing on
 *   it made a correct demotion (see bareSurvives) look like corruption, so the block fell
 *   through to the literal fallback and the link was lost along with the hint.
 */
const contentKey = (v) => JSON.stringify(v, (k, val) => {
  if (k === 'bare') return undefined;
  // ★ AND BOTH SIDES MUST SEE AN href THE SAME WAY. An unbalanced parenthesis is
  //   percent-encoded at EMIT time, so the re-parse carries %28/%29 where the model
  //   carries the raw form. Comparing them literally rejected a correct rendering and
  //   dropped the block to a conservative tier that changed the destination — a live link
  //   to a 404 with a stray `)` beside it. Normalizing here, and nowhere in the document
  //   itself, keeps markdownToDoc's output genuinely normal.
  if (k === 'href' && typeof val === 'string') return encodeUnbalancedParens(val);
  if (!isObj(val) || Array.isArray(val)) return val;
  return Object.keys(val).sort().reduce((acc, key) => { acc[key] = val[key]; return acc; }, {});
});

/**
 * Serialize one block, then READ IT BACK and check it says the same thing.
 *
 * Per-block isolation is sound because `\n\n` is a hard boundary in parseLessonContent.
 * The tiers are: `preferred` (bare links stay bare), `conservative` (every link explicit,
 * no bold), `literal` (escaped text and hard breaks only). The tests assert tiers 2 and 3
 * are never reached for any hazard we know about — this exists for the one nobody did.
 */
/**
 * Serializing a block is EXPENSIVE, and it is done on every keystroke.
 *
 * ★ MEASURED, NOT GUESSED: 16 ms for a 10 000-character lesson — at the 16 ms frame budget
 *   on a document half the size of the 20 000 the format allows. The cost is the net
 *   below, which per block serializes, RE-PARSES and key-sorts twice; `markdownToDoc` over
 *   the same document is 1.7 ms, so the verification is roughly ten times the parse.
 *   An edit only changes the block it touches, so the other 77 are recomputed for nothing.
 *
 * A plain `JSON.stringify` is the key: different content cannot collide (stringify is
 * injective for a given key order), and a different key order is only a miss, which costs
 * exactly what not caching costs. Bounded so a long session cannot grow it without limit.
 */
const BLOCK_CACHE = new Map();
const BLOCK_CACHE_MAX = 400;

function blockMarkdown(node) {
  let key = null;
  try {
    key = JSON.stringify(node);
    const hit = BLOCK_CACHE.get(key);
    if (hit !== undefined) return hit;
  } catch { key = null; } // a cyclic node cannot be cached; it still serializes below
  const value = computeBlockMarkdown(node);
  if (key !== null) {
    if (BLOCK_CACHE.size >= BLOCK_CACHE_MAX) BLOCK_CACHE.clear();
    BLOCK_CACHE.set(key, value);
  }
  return value;
}

function computeBlockMarkdown(node) {
  const target = normalizeBlocks([node]);
  if (!target.length) return '';
  const want = contentKey(target);
  let last = '';
  for (const mode of ['preferred', 'conservative', 'literal']) {
    last = renderBlock(node, mode);
    if (!last) return '';
    if (contentKey(markdownToDoc(last, 'markdown').content) === want) return last;
  }
  return last;
}

/** An editable document → the closed markdown that gets stored. */
export function docToMarkdown(doc) {
  const out = [];
  for (const node of normalizeBlocks(nodesOf(doc))) {
    const md = blockMarkdown(node);
    if (md) out.push(md);
  }
  return out.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Small readers the editor and its host need
// ─────────────────────────────────────────────────────────────────────────────

const walkNodes = (nodes, visit, depth = 0) => {
  if (depth > 20) return;
  for (const n of nodes || []) {
    if (!isObj(n)) continue;
    visit(n);
    walkNodes(contentOf(n), visit, depth + 1);
  }
};

/** Distinct asset ids a document shows, in first-appearance order. */
export function docAssetIds(doc) {
  const seen = new Set();
  const out = [];
  walkNodes(nodesOf(doc), (n) => {
    if (n.type !== 'lessonImage') return;
    const id = String((n.attrs && n.attrs.assetId) || '').trim().toLowerCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

/** Images already placed that still have no description — the save gate's own question. */
export function docImagesMissingAlt(doc) {
  const out = [];
  walkNodes(nodesOf(doc), (n) => {
    if (n.type !== 'lessonImage') return;
    if (!sanitizeAltText(n.attrs && n.attrs.alt)) {
      out.push(String((n.attrs && n.attrs.assetId) || '').trim().toLowerCase());
    }
  });
  return out;
}

/** Upload placeholders still in the document. Their presence blocks a save. */
export function docPendingUploads(doc) {
  const out = [];
  walkNodes(nodesOf(doc), (n) => {
    if (n.type === 'uploadingImage') out.push(String((n.attrs && n.attrs.uploadKey) || ''));
  });
  return out;
}
