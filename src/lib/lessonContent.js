// ─────────────────────────────────────────────────────────────────────────────
// src/lib/lessonContent.js — what a course lesson's instructions may contain (pure).
//
// PURE, dependency-free, no DOM, no Node, no Supabase. Shared by the lesson editor, the
// learner renderer, the AI-trainer ingest path and `node --test`.
//
// ★ WHY A HAND-WRITTEN TOKENIZER AND NOT A MARKDOWN LIBRARY.
//   The threat here is not "does this parse like CommonMark". It is that a course
//   creator's text becomes markup on a page hundreds of students load while signed in.
//   A general parser is safe only while it stays correctly configured — raw HTML off, a
//   URL transform installed, a component map that never falls through to `innerHTML`.
//   This module cannot be misconfigured into unsafety, because it has no HTML to enable:
//   it emits a CLOSED set of typed tokens and the renderer turns those into React
//   elements. Unsafe markup is unrepresentable rather than filtered out.
//
// ★ THE SUBSET IS CLOSED AND DELIBERATELY SMALL.
//   Paragraphs, hard line breaks, **bold**, "- " bullets, "1. " numbers, [label](url),
//   bare-URL autolinking, and ![alt](lesson-asset://<uuid>). No headings, no raw HTML,
//   no code fences, no tables, no inline styles. Every one of those is a decision the
//   owner can revisit; none of them can be smuggled in by a document.
//
// ★ EXISTING LESSONS ARE NOT REINTERPRETED.
//   course_lessons.content_format is 'plain' for every row that predates this feature,
//   and 'plain' means exactly what it meant before: escaped text with preserved line
//   breaks. Converting a lesson ESCAPES its metacharacters first, so a note that happens
//   to contain "*" or "[1]" does not silently acquire formatting. The one intentional
//   change on conversion is that a bare https:// URL becomes clickable, which is what
//   the community feed has always done to a bare URL and is the thing creators were
//   working around by typing "copy this link".
//
// ★ ASSET TOKENS, NOT URLs.
//   An image is stored as `lesson-asset://<uuid>` — never a signed URL (they expire, so
//   a stored one is a dead link in an hour), never a storage path (it would leak the
//   layout of a private bucket into text students can read), and never a base64 data
//   URI (it would put megabytes into a text column and into every draft autosave).
//   The uuid is resolved to a short-lived signed URL at render time, and the database
//   derives its own reference rows from these same tokens.
// ─────────────────────────────────────────────────────────────────────────────

/** The two values course_lessons.content_format may take. Mirrored by a SQL CHECK. */
export const LESSON_CONTENT_FORMATS = Object.freeze(['plain', 'markdown']);

/** Private bucket for lesson instruction images. Paid content: never course-media. */
export const LESSON_ASSET_BUCKET = 'course-lesson-assets';

/** The token scheme. Deliberately not http(s), so it can never be mistaken for a URL. */
export const LESSON_ASSET_SCHEME = 'lesson-asset://';

/** Upload limits. Mirrored by the bucket's own settings and by CHECKs on the row. */
export const LESSON_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const LESSON_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const LESSON_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);
export const LESSON_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

/** Per-document bounds. A lesson is instructions, not a gallery or a book. */
export const LESSON_IMAGE_MAX_PER_LESSON = 10;
export const LESSON_IMAGE_ALT_MAX = 300;
export const LESSON_IMAGE_CAPTION_MAX = 300;
export const LESSON_CONTENT_MAX_CHARS = 20000;

/**
 * A caption is `^ text` on the line directly under an image, and it is CLIENT-ONLY.
 *
 * ★ WHY IT IS NOT PART OF THE TOKEN. The database parses `![alt](lesson-asset://<uuid>)`
 *   with its own Postgres regex to derive the reference rows that authorize an image.
 *   Putting the caption inside the token would mean editing that regex — in a migration
 *   already applied to production — and would put the two parsers one wording change away
 *   from disagreeing about where a token ends. A separate LINE is invisible to the
 *   trigger, so the token keeps exactly one possible reading and captions cost no schema.
 *
 * ★ ALT TEXT AND A CAPTION ARE NOT THE SAME THING. Alt is what a screen reader announces
 *   and what shows when the image will not load; it stays required. A caption is visible
 *   prose under the picture ("Figure 1 — the three-dot button"), and it is optional.
 *   Repeating the alt as a caption makes a screen reader read the same sentence twice.
 */
export const LESSON_CAPTION_MARKER = '^ ';
const CAPTION_RE = /^\^[ \t]+(\S.*)$/;

/** How long an image's signed URL lasts, and how early to replace it. */
export const LESSON_ASSET_SIGN_TTL_SECONDS = 3600;
export const LESSON_ASSET_RESIGN_MARGIN_MS = 5 * 60 * 1000;

const UUID_SRC = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID_SRC}$`);

/**
 * The ONE image-token pattern, and the reason it is this strict.
 *
 * The alt text may not contain `]` or a newline and the target may not contain `)`, so
 * the token has exactly one possible reading. That matters because the DATABASE parses
 * these same tokens with a Postgres regex to build its reference rows: if the two
 * parsers could ever disagree about where a token ends, the text a student reads and
 * the references that authorize its images would describe different documents.
 * `test/lessonContentSql.test.mjs` pins the two patterns against each other.
 */
export const LESSON_ASSET_TOKEN_SRC = `!\\[([^\\]\\n]*)\\]\\(lesson-asset://(${UUID_SRC})\\)`;

/**
 * Characters a backslash may escape. Kept minimal: every one of these starts a token.
 *
 * ★ `)` IS HERE FOR THE POSITIONAL RULE BELOW, AND IT WAS MISSING.
 *   escapeMarkdown already wrote `1\)` to stop `1) Step one` becoming a list — but `)`
 *   was not escapable, so parseInline never consumed that backslash and the creator read
 *   `1\) Step one` back. Like `-` and `.`, it is escapable by POSITION only: the
 *   character loop skips it, so ordinary prose full of brackets does not turn into
 *   backslash soup.
 */
const ESCAPABLE = '\\*[]!-.)';
/** The three ESCAPABLE characters the character loop leaves alone; see escapeMarkdown. */
const POSITIONAL_ONLY = '-.)';

/**
 * Bare URLs we auto-link, matching the community feed's long-standing behaviour.
 *
 * ★ EXPORTED so src/lib/lessonDocument.js can replay this exact match when deciding
 *   whether a bare URL may be written back AS a bare URL. A copy over there would be a
 *   second reading of the same thing — the failure mode this whole module exists to
 *   avoid — and the character class is greedy, so a wrong reading silently changes a
 *   destination rather than failing.
 */
export const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

const isStr = (v) => typeof v === 'string';

/**
 * Coerce anything to a supported format name, defaulting to the safe one.
 *
 * ★ NO FUNCTION IN THIS MODULE MAY DEFAULT ITS `format` PARAMETER, and that is a rule
 *   with a scar. Five exported functions were written `format = 'markdown'`. A JS default
 *   fires on `undefined`, and `undefined` is exactly what a row carries when the column is
 *   absent — on a database without the migration, and on a lesson `addLesson` just seeded
 *   from COURSE_LESSON_SELECT_LEGACY. So the two places that decide whether a lesson may
 *   be SAVED and what the AI trainer INDEXES both read a plain note as markdown: a legacy
 *   `[see here](http://old-site.com)` became an UNSAFE_LINK that blocked the save, and
 *   every lesson on a pre-#65 database re-hashed and re-embedded for nothing.
 *   Passing no format now means `plain` — the format that predates the feature and cannot
 *   refuse anything — because every one of those functions already routes through here.
 */
export function normalizeFormat(value) {
  return value === 'markdown' ? 'markdown' : 'plain';
}

// ─────────────────────────────────────────────────────────────────────────────
// Link safety
// ─────────────────────────────────────────────────────────────────────────────

function linkResult(kind, href, host, reason) {
  return { kind, href, host, reason };
}

/**
 * The ONLY authority for any href a lesson renders.
 *
 * Follows the idiom already established by parseReplayUrl() and safeLinkHref():
 *   • the PARSED `protocol` decides the scheme — never a regex on the raw string,
 *     because WHATWG strips tab/LF/CR before parsing, so "java\nscript:alert(1)"
 *     parses as javascript: and would sail through /^javascript:/;
 *   • `new URL` is called with NO base argument, or a rejected scheme would be
 *     re-parsed as a relative path and pass;
 *   • `hostname`, never `host`, so a port cannot smuggle anything past a suffix test;
 *   • an invalid result carries NO href at all, rather than a "safe-looking" one.
 *
 * Accepts absolute https:// and same-origin app paths ("/courses/...", "#anchor").
 * Rejects http:, javascript:, data:, file:, protocol-relative ("//evil.example") and
 * credential-bearing URLs ("https://forms.google.com@evil.example").
 */
export function safeLessonHref(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') {
    return linkResult('none', null, null, null);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return linkResult('none', null, null, null);
  if (trimmed.length > 2000) return linkResult('invalid', null, null, 'too-long');

  // ★ Checked BEFORE the parse. "//evil.example/x" is protocol-relative: with no base it
  //   throws, and with one it would inherit https and become a real cross-origin link.
  if (trimmed.startsWith('//')) return linkResult('invalid', null, null, 'protocol-relative');

  // In-app destinations. Their own branch, BEFORE the parse, because `new URL('/x')`
  // throws without a base and passing a base is forbidden above.
  if (trimmed.charAt(0) === '#') {
    return /^#[A-Za-z][\w-]*$/.test(trimmed)
      ? linkResult('fragment', trimmed, null, null)
      : linkResult('invalid', null, null, 'bad-fragment');
  }
  if (trimmed.charAt(0) === '/') {
    // A single leading slash, no scheme, no backslashes, no control characters.
    return /^\/[\w\-./?=&%+#]*$/.test(trimmed)
      ? linkResult('internal', trimmed, null, null)
      : linkResult('invalid', null, null, 'bad-path');
  }

  let url;
  try {
    url = new URL(trimmed); // ★ no base argument — see above.
  } catch {
    return linkResult('invalid', null, null, 'not-absolute');
  }

  if (url.protocol !== 'https:') {
    return linkResult('invalid', null, null, url.protocol === 'http:' ? 'insecure' : 'not-https');
  }
  // Either a mistake or the classic "https://trusted.example@evil.example" shape, where
  // the trustworthy-looking part is the username and the real host is the attacker's.
  if (url.username || url.password) return linkResult('invalid', null, null, 'credentials');
  if (!url.hostname) return linkResult('invalid', null, null, 'no-host');

  return linkResult('external', url.href, url.hostname, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaping / conversion
// ─────────────────────────────────────────────────────────────────────────────

/** Escape every character that could otherwise start a token. */
export function escapeMarkdown(text) {
  if (!isStr(text)) return '';
  return text.split('\n').map((line) => {
    let out = '';
    for (const ch of line) out += ESCAPABLE.includes(ch) && !POSITIONAL_ONLY.includes(ch) ? `\\${ch}` : ch;
    // Only a LEADING "- " or "1. " makes a list, so those two are escaped by position
    // rather than everywhere — escaping every hyphen would turn ordinary prose into
    // backslash soup the creator then has to read.
    // No `* ` rule here: the character loop above already escaped every `*`, so no line
    // can still begin with a bare one. A rule for it would be dead code that reads like
    // a guarantee.
    // ★ THE SEPARATOR IS \s, NOT A LITERAL SPACE, AND THAT WAS A REAL DEFECT.
    //   UL_RE and OL_RE accept `\s+`, but these two rules required a space — so `-\tx`
    //   escaped to itself and then parsed as a LIST, and the converted lesson silently
    //   lost its hyphen. That breaks this module's headline promise that converting a
    //   plain lesson does not change what it looks like.
    return out
      .replace(/^(\s*)-(\s)/, '$1\\-$2')
      .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4');
  }).join('\n');
}

/**
 * Convert an existing plain lesson to markdown WITHOUT changing what it looks like.
 *
 * The visible output is identical except that a bare https:// URL becomes clickable —
 * which is the whole reason creators were typing "copy this link" into their notes.
 */
export function plainToMarkdown(text) {
  return escapeMarkdown(isStr(text) ? text : '');
}

/** Trim and bound an alt text. Returns '' for anything unusable. */
export function sanitizeAltText(value) {
  if (!isStr(value)) return '';
  // Newlines and ']' would break the token's single possible reading.
  const flat = value.replace(/[\r\n]+/g, ' ').replace(/\]/g, '').replace(/\s+/g, ' ').trim();
  return flat.slice(0, LESSON_IMAGE_ALT_MAX);
}

/** Trim and bound a caption. Returns '' for anything unusable. */
export function sanitizeCaption(value) {
  if (!isStr(value)) return '';
  const flat = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.slice(0, LESSON_IMAGE_CAPTION_MAX);
}

/** Build one image token. Returns '' when the inputs cannot make a valid one. */
export function buildAssetToken(assetId, altText, { requireAlt = true } = {}) {
  const id = isStr(assetId) ? assetId.trim().toLowerCase() : '';
  if (!UUID_RE.test(id)) return '';
  const alt = sanitizeAltText(altText);
  // ★ requireAlt STAYS TRUE FOR THE COMPOSER: an image with no description is never
  //   INSERTED into a lesson. A serializer needs the other answer, because an alt-less
  //   image ALREADY in a document has to be written back — otherwise the picture
  //   disappears on the next save AND the IMAGE_ALT_REQUIRED that would have told the
  //   creator disappears with it. Declining to write it is not a refusal; it is a
  //   silent deletion of somebody's screenshot.
  if (requireAlt && !alt) return '';
  return `![${alt}](${LESSON_ASSET_SCHEME}${id})`;
}

/**
 * Build the caption LINE that sits under an image token. Returns '' for no caption.
 *
 * An image token inside a caption would render in the figcaption while the database still
 * counted it as a reference, so the marker is refused when the text contains one — the
 * caption then stays literal prose, which is visible and harmless.
 */
export function buildCaptionLine(caption) {
  const text = sanitizeCaption(caption);
  if (!text) return '';
  if (/!\[[^\]\n]*\]\(/.test(text)) return '';
  return `${LESSON_CAPTION_MARKER}${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The index of the `)` that closes the `(` at `open`, allowing balanced nesting.
 *
 * Plain indexOf(')') cuts a real URL short: Wikipedia and SharePoint both produce
 * addresses containing parentheses, and stopping at the first one leaves a stray ")" in
 * the sentence and a truncated href. Scanning stops at the end of the line, so an
 * unbalanced "(" cannot run away through the whole document.
 */
const closingParen = (src, open) => {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '\n') return -1;
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return k; }
  }
  return -1;
};

/**
 * ★ `withSource` IS OPT-IN, AND THAT IS THE WHOLE POINT.
 *
 * The parse that the RENDERER, `validateLessonContent` and the AI trainer see is
 * unchanged: a refused remote target still does not survive anywhere in it, which
 * `test/lessonContent.test.mjs` asserts by stringifying the whole document and looking
 * for the attacker's host. Recording it unconditionally would break that, and would put
 * a third party's URL into the trainer's neighbourhood for no gain.
 *
 * Only `src/lib/lessonDocument.js` asks for the source bytes, and the only thing it does
 * with them is write them back out unchanged, so that a document the editor cannot
 * REPRESENT is still a document the editor cannot silently REWRITE. It never becomes an
 * href and never becomes an <img src>: a lesson containing one of these cannot be saved
 * at all — `validateLessonContent` refuses it.
 */
const imageAt = (src, i, withSource) => {
  if (src[i] !== '!' || src[i + 1] !== '[') return null;
  const close = src.indexOf(']', i + 2);
  if (close === -1 || src[close + 1] !== '(') return null;
  const end = closingParen(src, close + 1);
  if (end === -1) return null;
  const alt = src.slice(i + 2, close);
  if (alt.includes('\n')) return null;
  const target = src.slice(close + 2, end);
  const next = end + 1;
  // ★ EXACT CASE. This was `target.toLowerCase().startsWith(...)`, which made the RENDERER
  //   case-insensitive while both reference extractors — LESSON_ASSET_TOKEN_SRC and the
  //   Postgres regex in course_lesson_sync_assets — stayed case-sensitive. So
  //   `![Menu](LESSON-ASSET://<uuid>)` drew an image that no reference row covered: the
  //   orphan sweep would then delete its bytes while the lesson still displayed it, and
  //   course_lesson_asset_delete would raise no LESSON_ASSET_IN_USE. Of the two possible
  //   disagreements that is the unsafe one, so the three parsers agree exactly.
  const source = withSource ? { raw: src.slice(i, next) } : null;
  if (target.startsWith(LESSON_ASSET_SCHEME)) {
    const id = target.slice(LESSON_ASSET_SCHEME.length);
    if (!UUID_RE.test(id)) return { token: { type: 'badimage', alt, reason: 'bad-id', ...source }, next };
    return { token: { type: 'image', assetId: id.toLowerCase(), alt: alt.trim() }, next };
  }
  // ★ A REMOTE IMAGE IS NEVER RENDERED, NOT EVEN AS A BROKEN ONE.
  //   Hot-linking would load a third party's server on every student's lesson page,
  //   handing that server each student's IP, referrer and viewing time. Pasting rich
  //   HTML from a web page is the common way this arrives, so the creator is told to
  //   download the image and upload it instead.
  return { token: { type: 'badimage', alt, reason: 'remote', ...source }, next };
};

const linkAt = (src, i, depth, withSource) => {
  if (src[i] !== '[') return null;
  const close = src.indexOf(']', i + 1);
  if (close === -1 || src[close + 1] !== '(') return null;
  const end = closingParen(src, close + 1);
  if (end === -1) return null;
  const label = src.slice(i + 1, close);
  if (label.includes('\n')) return null;
  const verdict = safeLessonHref(src.slice(close + 2, end));
  // ★ inLink = true. A LABEL MAY NOT CONTAIN ANOTHER LINK, and that is not tidiness.
  //   React builds elements programmatically, so unlike an HTML parser it will happily
  //   nest <a> inside <a> — and a click then resolves to the INNER href. So
  //   `[Visit https://example.com for details](https://real-target.example)` sent the
  //   reader to example.com, silently ignoring the destination the author chose. Same
  //   class of fault as the unbalanced-parenthesis one: the link works, and goes
  //   somewhere else. Inside a label, a bare URL stays text.
  const tokens = parseInline(label, depth + 1, true, withSource);
  const next = end + 1;
  // An invalid target keeps the LABEL as readable text and carries no href at all —
  // the rule safeLinkHref() established: never emit a "safe-looking" fallback URL.
  if (verdict.kind === 'none' || verdict.kind === 'invalid') {
    return {
      token: {
        type: 'badlink', tokens, reason: verdict.reason || 'empty',
        ...(withSource ? { raw: src.slice(i, next) } : null),
      },
      next,
    };
  }
  return { token: { type: 'link', href: verdict.href, host: verdict.host, kind: verdict.kind, tokens }, next };
};

// `withSource` defaults to false — the safe value, the same direction normalizeFormat
// fails in. A caller that does not ask gets exactly the tokens it got before.
function parseInline(src, depth = 0, inLink = false, withSource = false) {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ type: 'text', value: buf }); buf = ''; } };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1]; i += 2; continue;
    }
    if (ch === '*' && src[i + 1] === '*' && depth < 3) {
      const close = src.indexOf('**', i + 2);
      if (close > i + 2) {
        flush();
        // Bold inside a label is fine; it carries inLink so a URL in it stays text.
        out.push({ type: 'bold', tokens: parseInline(src.slice(i + 2, close), depth + 1, inLink, withSource) });
        i = close + 2; continue;
      }
    }
    if (ch === '!') {
      const img = imageAt(src, i, withSource);
      if (img) { flush(); out.push(img.token); i = img.next; continue; }
    }
    if (ch === '[' && depth < 3 && !inLink) {
      const lnk = linkAt(src, i, depth, withSource);
      if (lnk) { flush(); out.push(lnk.token); i = lnk.next; continue; }
    }
    if ((ch === 'h' || ch === 'H') && depth < 3 && !inLink) {
      const m = BARE_URL_RE.exec(src.slice(i));
      if (m && m.index === 0) {
        // Trailing sentence punctuation belongs to the sentence, not the URL.
        let raw = m[0];
        while (raw.length && '.,;:!?'.includes(raw[raw.length - 1])) raw = raw.slice(0, -1);
        const verdict = safeLessonHref(raw);
        if (verdict.kind === 'external') {
          flush();
          out.push({
            type: 'link', href: verdict.href, host: verdict.host, kind: 'external',
            tokens: [{ type: 'text', value: raw }], bare: true,
          });
          i += raw.length; continue;
        }
      }
    }
    buf += ch; i += 1;
  }
  flush();
  return out;
}

const UL_RE = /^(\s*)[-*]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

/**
 * Parse a lesson document into blocks.
 *
 * `plain` is not parsed at all: it returns one paragraph of literal text per line group,
 * which is byte-for-byte what `whitespace-pre-line` rendered before this module existed.
 */
export function parseLessonContent(text, format, { withSource = false } = {}) {
  const src = isStr(text) ? text.replace(/\r\n?/g, '\n') : '';
  if (!src.trim()) return [];
  if (normalizeFormat(format) === 'plain') {
    return [{ type: 'plain', value: src }];
  }

  const lines = src.split('\n');
  const blocks = [];
  let para = [];
  const meaningfulOf = (toks) => toks.filter((t) => !(t.type === 'text' && !t.value.trim()));
  const isImageRow = (row) => row.meaningful.length > 0
    && row.meaningful.every((t) => t.type === 'image' || t.type === 'badimage');

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join('\n');

    const rows = para.map((line) => {
      const toks = parseInline(line, 0, false, withSource);
      const m = CAPTION_RE.exec(line);
      const meaningful = meaningfulOf(toks);
      // A caption may not carry an image token: it would render inside the figcaption
      // while the database still counted it as a reference. Such a line is not a caption.
      const hasImage = meaningful.some((t) => t.type === 'image' || t.type === 'badimage');
      return { toks, meaningful, caption: m && !hasImage ? m[1] : null };
    });

    // A paragraph that is nothing but image lines — each optionally followed by ONE
    // caption line — becomes figure blocks, so each image can carry its own caption
    // instead of being trapped inline in a <p>. Anything else is an ordinary paragraph,
    // and a "^ " line inside one stays the literal text the creator typed.
    let figure = rows.some((r) => !r.caption);
    for (let i = 0; i < rows.length && figure; i++) {
      if (rows[i].caption) {
        const prev = i > 0 ? rows[i - 1] : null;
        if (!prev || prev.caption || !isImageRow(prev)) figure = false;
      } else if (!isImageRow(rows[i])) {
        figure = false;
      }
    }

    if (figure) {
      let pending = null;
      rows.forEach((r) => {
        if (r.caption) {
          if (pending) pending.caption = parseInline(r.caption, 0, false, withSource);
          return;
        }
        r.meaningful.forEach((t) => {
          const block = { ...t, type: t.type === 'image' ? 'imageBlock' : 'badimageBlock' };
          blocks.push(block);
          pending = block; // a caption attaches to the LAST image on the line above it
        });
      });
      para = [];
      return;
    }

    const tokens = [];
    rows.forEach((r, k) => {
      if (k) tokens.push({ type: 'break' });
      r.toks.forEach((t) => tokens.push(t));
    });
    blocks.push({ type: 'paragraph', tokens, raw: joined });
    para = [];
  };

  let list = null;
  const flushList = () => { if (list) { blocks.push(list); list = null; } };

  for (const line of lines) {
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, items: [] }; }
      list.items.push(parseInline((ul ? ul[2] : ol[3]), 0, false, withSource));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset references
// ─────────────────────────────────────────────────────────────────────────────

/** Every image token in document order: `[{ assetId, alt, index }]`, duplicates kept. */
export function lessonAssetRefs(text, format) {
  if (normalizeFormat(format) === 'plain') return [];
  const src = isStr(text) ? text.replace(/\r\n?/g, '\n') : '';
  const re = new RegExp(LESSON_ASSET_TOKEN_SRC, 'g');
  const out = [];
  let m;
  let index = 0;
  while ((m = re.exec(src))) {
    out.push({ assetId: m[2].toLowerCase(), alt: m[1].trim(), index: index++ });
  }
  return out;
}

/**
 * The DISTINCT asset ids a document cites, in first-appearance order.
 *
 * De-duplicated because the same screenshot may legitimately appear twice, and because
 * this is what decides how many references a lesson holds and how many signed URLs one
 * lesson page needs — both of which must count an image once.
 */
export function lessonAssetIds(text, format) {
  const seen = new Set();
  const out = [];
  for (const ref of lessonAssetRefs(text, format)) {
    if (seen.has(ref.assetId)) continue;
    seen.add(ref.assetId);
    out.push(ref.assetId);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const err = (code, message, extra = {}) => ({ code, message, ...extra });

/**
 * Everything wrong with a document, all at once.
 *
 * Returns every problem rather than the first, because the editor shows a summary the
 * creator can work through — being sent back one error at a time is how a long form
 * becomes unusable.
 */
export function validateLessonContent(text, format, { required = false } = {}) {
  const src = isStr(text) ? text : '';
  const errors = [];

  if (required && !src.trim()) {
    return { ok: false, errors: [err('EMPTY', 'Add some lesson content before saving.')] };
  }
  if (src.length > LESSON_CONTENT_MAX_CHARS) {
    errors.push(err('TOO_LONG',
      `These instructions are ${src.length.toLocaleString()} characters — the limit is `
      + `${LESSON_CONTENT_MAX_CHARS.toLocaleString()}. Split the lesson, or move the detail into a linked document.`));
  }
  if (normalizeFormat(format) === 'plain') {
    return { ok: errors.length === 0, errors };
  }

  const refs = lessonAssetRefs(src, 'markdown');

  // ★ AN ASSET SCHEME THAT IS NOT A TOKEN IS A DELETED IMAGE, NOT A TYPO.
  //   Everything this function knows about images comes from the token pattern, so a
  //   `lesson-asset://<uuid>` the pattern cannot read was invisible here — and the document
  //   saved clean. Three things then happened at once, none of them visible to the creator:
  //   the raw markdown was published verbatim to every student; the post-save sweep saw the
  //   asset as uncited and called course_lesson_asset_delete, which CANNOT refuse with
  //   LESSON_ASSET_IN_USE because the trigger derived no reference from an unreadable token —
  //   so the row and the bytes went; and lessonContentToPlainText passed the string through
  //   untouched, putting the scheme and the uuid into the AI trainer's index, which is exactly
  //   what this module promises never to do.
  //   One `]` in the alt text is enough (`![Screenshot [1]](lesson-asset://…)`), and so is half
  //   a hand-deleted token. Counting is the whole check: every readable token contains the
  //   scheme once, so more scheme occurrences than tokens means at least one is stranded.
  const schemeHits = (src.match(new RegExp(`${LESSON_ASSET_SCHEME}${UUID_SRC}`, 'g')) || []).length;
  if (schemeHits > refs.length) {
    errors.push(err('BROKEN_IMAGE_REFERENCE',
      'An image reference in this lesson is written in a way the lesson cannot read — usually a "]" '
      + 'in the description, or part of an image that was deleted by hand. Remove that line and add '
      + 'the image again with the Image button. Saving it as it stands would show students the raw '
      + 'text and delete the picture.'));
  }

  const distinct = new Set(refs.map((r) => r.assetId));
  if (distinct.size > LESSON_IMAGE_MAX_PER_LESSON) {
    errors.push(err('TOO_MANY_IMAGES',
      `This lesson has ${distinct.size} images — the limit is ${LESSON_IMAGE_MAX_PER_LESSON}.`));
  }

  // Walk the parsed document, not the raw text: a token inside an escape or a malformed
  // bracket run is not a token, and flagging it would block a save over nothing.
  const walk = (tokens) => {
    for (const t of tokens || []) {
      if (t.type === 'image') {
        if (!t.alt) {
          errors.push(err('IMAGE_ALT_REQUIRED',
            'Every image needs a short description for students using a screen reader, and for when the image cannot load.',
            { assetId: t.assetId }));
        } else if (t.alt.length > LESSON_IMAGE_ALT_MAX) {
          errors.push(err('IMAGE_ALT_TOO_LONG',
            `An image description is ${t.alt.length} characters — the limit is ${LESSON_IMAGE_ALT_MAX}.`,
            { assetId: t.assetId }));
        }
      } else if (t.type === 'badimage') {
        errors.push(t.reason === 'remote'
          ? err('REMOTE_IMAGE',
            'Images must be uploaded, not linked from another website. Download the image, then add it with the Image button.')
          : err('BAD_IMAGE_TOKEN', 'An image reference in this lesson is not valid. Remove it and add the image again.'));
      } else if (t.type === 'badlink') {
        // Wording matters here: this BLOCKS the save (saveLesson refuses on any error), so
        // it must not describe the renderer's behaviour as if the save had gone through.
        // It used to end "...so it is shown as plain text", which is true of the renderer
        // and false of what just happened to the creator.
        errors.push(err('UNSAFE_LINK',
          t.reason === 'insecure'
            ? 'Links must start with https:// — an http:// link is not secure, so this lesson was not saved.'
            : 'A link in this lesson is not a valid https:// address, so this lesson was not saved. Fix or remove it.',
          { reason: t.reason }));
      }
      if (t.tokens) walk(t.tokens);
    }
  };
  for (const block of parseLessonContent(src, 'markdown')) {
    if (block.type === 'paragraph') walk(block.tokens);
    else if (block.type === 'list') block.items.forEach(walk);
    else walk([block.type === 'imageBlock' ? { ...block, type: 'image' } : block.type === 'badimageBlock' ? { ...block, type: 'badimage' } : block]);
    // A caption is rendered prose, so an unsafe link in one must block the save exactly
    // as it does in a paragraph. `walk` recurses through `tokens`, which a caption is not.
    if (block.caption) {
      walk(block.caption);
      const capText = inlineToText(block.caption);
      if (capText.length > LESSON_IMAGE_CAPTION_MAX) {
        errors.push(err('CAPTION_TOO_LONG',
          `An image caption is ${capText.length} characters — the limit is ${LESSON_IMAGE_CAPTION_MAX}.`,
          { assetId: block.assetId }));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain-text projection (the AI trainer's view)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten inline tokens to prose.
 *
 * ★ `bareLinkAs` EXISTS BECAUSE THE DEFAULT SILENTLY REWRITES A CAPTION.
 *   A bare URL reads as its HOST for the AI trainer, and that is right there — the agent
 *   is speaking, not clicking, and ninety characters of query string is noise. But a
 *   caption is a plain-text ATTRIBUTE the editor reads back and writes out again, so the
 *   same rule turns `see https://forms.gle/abc123 for the form` into
 *   `see forms.gle for the form` — permanently, on the creator's next save, with nothing
 *   on screen to say it happened. `bareLinkAs: 'text'` keeps the words.
 *   The default is unchanged, so `lessonContentToPlainText` is byte-identical and no
 *   lesson is re-hashed or re-embedded for this.
 */
export function inlineToText(tokens, { bareLinkAs = 'host' } = {}) {
  const opts = { bareLinkAs };
  return (tokens || []).map((t) => {
    switch (t.type) {
      case 'text': return t.value;
      case 'break': return '\n';
      case 'bold': return inlineToText(t.tokens, opts);
      // A link reads as its LABEL. The agent is speaking, not clicking — reading a URL
      // aloud is noise, and the label is the thing the creator wrote for a human.
      case 'link':
        return t.bare && bareLinkAs !== 'text' ? (t.host || '') : inlineToText(t.tokens, opts);
      case 'badlink': return inlineToText(t.tokens, opts);
      case 'image': return t.alt ? `Image: ${t.alt}` : '';
      case 'badimage': return t.alt ? `Image: ${t.alt}` : '';
      default: return '';
    }
  }).join('');
}

/**
 * The document as prose, for the AI course trainer's knowledge index.
 *
 * ★ THIS IS THE ONLY THING THAT STOPS THE TRAINER READING MARKDOWN ALOUD.
 *   api/admin/course-trainer.js sends lesson text into the index with nothing but a
 *   trim(), and the retrieval path copies chunk content byte-for-byte into the agent's
 *   envelope. Without this projection the agent would narrate "star star Important star
 *   star" and "bracket HERE bracket paren h-t-t-p-s colon...".
 *
 * ★ AND IT IS WHAT KEEPS ASSET IDS OUT OF THE AGENT. An image becomes its alt text and
 *   nothing else — no uuid, no scheme, no storage path, no signed URL.
 *
 * `plain` is returned unchanged, so every lesson that predates this feature hashes and
 * chunks exactly as it did before and is not needlessly re-indexed.
 */
export function lessonContentToPlainText(text, format) {
  const src = isStr(text) ? text : '';
  if (normalizeFormat(format) === 'plain') return src;

  const out = [];
  for (const block of parseLessonContent(src, 'markdown')) {
    if (block.type === 'paragraph') {
      const s = inlineToText(block.tokens).trim();
      if (s) out.push(s);
    } else if (block.type === 'list') {
      const lines = block.items.map((item, i) => {
        const s = inlineToText(item).trim();
        if (!s) return '';
        // Numbers carry meaning in an instruction ("step 3"); bullets are read aloud as
        // punctuation for no gain, so they are dropped.
        return block.ordered ? `${i + 1}. ${s}` : s;
      }).filter(Boolean);
      if (lines.length) out.push(lines.join('\n'));
    } else if (block.type === 'imageBlock' || block.type === 'badimageBlock') {
      // The caption is prose the creator wrote for a reader, so the agent gets it too —
      // after the alt text and in the same breath, which is how it reads on the page.
      const cap = block.caption ? inlineToText(block.caption).trim() : '';
      const line = [block.alt ? `Image: ${block.alt}` : '', cap].filter(Boolean).join(' — ');
      if (line) out.push(line);
    } else if (block.type === 'plain') {
      out.push(block.value.trim());
    }
  }
  return out.join('\n\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor helpers — pure, so the composer stays thin and the behaviour is testable
// ─────────────────────────────────────────────────────────────────────────────

const clampSel = (text, start, end) => {
  const len = text.length;
  const a = Math.max(0, Math.min(Number.isFinite(start) ? start : len, len));
  const b = Math.max(0, Math.min(Number.isFinite(end) ? end : a, len));
  return a <= b ? [a, b] : [b, a];
};

/** Splice `insert` over a selection, returning the new text and where the caret lands. */
export function spliceSelection(text, start, end, insert, { selectFrom = null, selectTo = null } = {}) {
  const src = isStr(text) ? text : '';
  const [a, b] = clampSel(src, start, end);
  const next = src.slice(0, a) + insert + src.slice(b);
  return {
    text: next,
    selectionStart: a + (selectFrom === null ? insert.length : selectFrom),
    selectionEnd: a + (selectTo === null ? insert.length : selectTo),
  };
}

/**
 * Every link token in the document, with its exact range. Skips images and escapes, and
 * never reports a token nested inside another — the same reading `linkAt` gives the
 * renderer, so "the link the caret is in" is the link the student would click.
 */
function scanLinks(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }        // an escaped bracket opens nothing
    if (ch !== '[') continue;
    if (i > 0 && src[i - 1] === '!') continue;    // that is an image, not a link
    const close = src.indexOf(']', i + 1);
    if (close === -1 || src[close + 1] !== '(') continue;
    const end = closingParen(src, close + 1);
    if (end === -1) continue;
    const label = src.slice(i + 1, close);
    if (label.includes('\n')) continue;
    out.push({ start: i, end: end + 1, label, url: src.slice(close + 2, end) });
    i = end;
  }
  return out;
}

/**
 * The link token the selection sits inside, or null.
 *
 * This is what makes a link EDITABLE. Without it the only way to change a destination was
 * to select the rendered words and press Ctrl+K again, which wrapped the whole existing
 * token in a new one and produced `[label(url)](newurl)` — a link whose visible text is
 * somebody's raw markdown.
 */
export function linkAtSelection(text, start, end) {
  const src = isStr(text) ? text : '';
  const [a, b] = clampSel(src, start, end);
  for (const l of scanLinks(src)) {
    if (a >= l.start && b <= l.end) return { start: l.start, end: l.end, label: l.label, url: l.url };
  }
  return null;
}

/** Replace the link the selection sits in with its own label. */
export function applyUnlink(text, start, end) {
  const src = isStr(text) ? text : '';
  const found = linkAtSelection(src, start, end);
  if (!found) return { ok: false, reason: 'no-link', text: src };
  const label = found.label.replace(/[[\]]/g, '');
  return {
    ok: true,
    ...spliceSelection(src, found.start, found.end, label, { selectFrom: 0, selectTo: label.length }),
  };
}

/** Wrap the selection in a link, or insert a placeholder when nothing is selected. */
export function applyLink(text, start, end, url, { label = null } = {}) {
  const src = isStr(text) ? text : '';
  const [a, b] = clampSel(src, start, end);
  const chosen = label !== null ? label : src.slice(a, b);
  const verdict = safeLessonHref(url);
  if (verdict.kind === 'none' || verdict.kind === 'invalid') {
    return { ok: false, reason: verdict.reason || 'empty', text: src };
  }
  // ★ A LABEL IS ONE LINE. `linkAt` and `scanLinks` both refuse a label containing a newline,
  //   so a multi-line selection produced a token no reader would ever accept: it validated
  //   clean and rendered as a literal "[", the two lines, "](", an autolinked URL and a stray
  //   ")". The brackets are stripped for the same reason — the label must have exactly one
  //   reading — and a newline is no different, so it collapses to a space here rather than
  //   being carried into a token that cannot survive the round trip.
  const chosenOneLine = String(chosen || '').replace(/\s*\r?\n\s*/g, ' ');
  const shown = (chosenOneLine || verdict.host || 'this link').replace(/[[\]]/g, '');
  // ★ PARENTHESES ARE PERCENT-ENCODED, AND THE REASON IS NOT TIDINESS.
  //   A token ends at the `)` that balances its `(`. A URL carrying an UNBALANCED `)` —
  //   `https://x.example/a)b` — therefore closes the token early, and the creator gets a
  //   working link to `https://x.example/a`, a DIFFERENT destination, with the remainder
  //   sitting beside it as text. Silently linking somewhere else is worse than not
  //   linking at all. Encoding both characters makes the token unambiguous, and
  //   %28/%29 resolve to exactly the same address when clicked.
  const href = verdict.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const md = `[${shown}](${href})`;
  return { ok: true, ...spliceSelection(src, a, b, md, { selectFrom: 1, selectTo: 1 + shown.length }) };
}

/** Insert an image token at the caret, on its own line, with an optional caption under it. */
export function applyImage(text, start, end, assetId, altText, caption) {
  const token = buildAssetToken(assetId, altText);
  if (!token) return { ok: false, reason: 'invalid-image', text: isStr(text) ? text : '' };
  const capLine = buildCaptionLine(caption);
  // The caption is the NEXT line, never a blank line away: a blank line ends the block and
  // the caption would become an ordinary paragraph of "^ …" text.
  const body = capLine ? `${token}\n${capLine}` : token;
  const src = isStr(text) ? text : '';
  const [a, b] = clampSel(src, start, end);
  const before = src.slice(0, a);
  const needsLead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const after = src.slice(b);
  const needsTail = after && !after.startsWith('\n') ? '\n\n' : '';
  return { ok: true, ...spliceSelection(src, a, b, `${needsLead}${body}${needsTail}`) };
}

/**
 * Take an image out of a document: every token for that asset, and the caption that
 * belongs to it.
 *
 * ★ WHY THIS EXISTS. Removing an image from the composer's list deleted the asset row and
 *   its bytes but left `![alt](lesson-asset://<uuid>)` sitting in the text. Reference rows
 *   are only derived on SAVE, so the server's LESSON_ASSET_IN_USE guard could not fire —
 *   it saw no reference. The next save then raised LESSON_ASSET_UNKNOWN_REF, and the only
 *   way out was to find and hand-delete a raw token inside a textarea.
 *
 * Matching goes through LESSON_ASSET_TOKEN_SRC — the same pattern the renderer and the
 * database use — so the thing removed is exactly the thing they would have seen.
 */
export function removeAssetToken(text, assetId) {
  const src = isStr(text) ? text.replace(/\r\n?/g, '\n') : '';
  const id = isStr(assetId) ? assetId.trim().toLowerCase() : '';
  if (!src || !UUID_RE.test(id)) return { ok: false, text: src, removed: 0 };

  let removed = 0;
  const stripLine = (line) => {
    const re = new RegExp(LESSON_ASSET_TOKEN_SRC, 'g');
    return line.replace(re, (match, _alt, matchedId) => {
      if (matchedId.toLowerCase() !== id) return match;
      removed += 1;
      return '';
    });
  };

  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i];
    const hits = removed;
    const line = stripLine(before);
    if (removed > hits && !line.trim()) {
      // The line held nothing but this image, so the line goes — and with it the caption
      // that described it, which would otherwise be left captioning the image above.
      if (i + 1 < lines.length && CAPTION_RE.test(lines[i + 1])) i += 1;
      continue;
    }
    out.push(line);
  }

  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { ok: removed > 0, text: next, removed };
}

/** Wrap the selection in bold, or insert an empty pair for the creator to type into. */
export function applyBold(text, start, end) {
  const src = isStr(text) ? text : '';
  const [a, b] = clampSel(src, start, end);
  const chosen = src.slice(a, b);
  if (!chosen) return spliceSelection(src, a, b, '****', { selectFrom: 2, selectTo: 2 });
  return spliceSelection(src, a, b, `**${chosen}**`, { selectFrom: 2, selectTo: 2 + chosen.length });
}

/** Turn the selected lines into a bulleted or numbered list. */
export function applyList(text, start, end, ordered) {
  const src = isStr(text) ? text : '';
  const [a, b] = clampSel(src, start, end);
  const lineStart = src.lastIndexOf('\n', a - 1) + 1;
  const lineEndRaw = src.indexOf('\n', b);
  const lineEnd = lineEndRaw === -1 ? src.length : lineEndRaw;
  const chunk = src.slice(lineStart, lineEnd) || '';
  const lines = chunk.split('\n');
  const marked = lines.map((line, i) => {
    const bare = line.replace(UL_RE, '$2').replace(OL_RE, '$3');
    if (!bare.trim()) return bare;
    return ordered ? `${i + 1}. ${bare}` : `- ${bare}`;
  }).join('\n');
  return spliceSelection(src, lineStart, lineEnd, marked);
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload validation
// ─────────────────────────────────────────────────────────────────────────────

const extensionOf = (name) => {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot === -1 ? '' : s.slice(dot).toLowerCase();
};

/** A storage-safe object name. The creator's filename is never trusted or reused. */
export function lessonAssetObjectName(mimeType, randomId) {
  const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  return `${String(randomId || '').toLowerCase()}${ext}`;
}

/** The full object path. Carries course AND lesson, and the storage policy parses both. */
export function lessonAssetPath(courseId, lessonId, objectName) {
  return `lessons/${courseId}/${lessonId}/${objectName}`;
}

/** Exactly `lessons/<uuid>/<uuid>/<file>` — anything else must fail closed. */
export const LESSON_ASSET_PATH_RE = new RegExp(`^lessons/(${UUID_SRC})/(${UUID_SRC})/[^/]+$`);

/**
 * Refuse a file BEFORE a byte is transferred.
 *
 * ★ The MIME type is checked, but it is the browser's guess from the extension and a
 *   creator can rename anything. It is a courtesy check that saves an upload; the real
 *   boundary is the bucket's own allowed_mime_types plus the fact that these objects are
 *   only ever rendered inside an <img>. SVG is refused by name as well as by type: it
 *   can carry script, and it is the one image format that is really a document.
 */
export function validateLessonImageFile(file) {
  if (!file) return { ok: false, code: 'NO_FILE', message: 'Choose an image to upload.' };
  const name = String(file.name || 'image');
  const ext = extensionOf(name);
  const type = String(file.type || '').toLowerCase();
  const size = Number(file.size || 0);

  if (ext === '.svg' || type === 'image/svg+xml') {
    return { ok: false, code: 'SVG_REFUSED',
      message: 'SVG images are not supported. Export the picture as PNG, JPEG or WebP and upload that.' };
  }
  if (!LESSON_IMAGE_MIMES.includes(type) && !LESSON_IMAGE_EXTENSIONS.includes(ext)) {
    return { ok: false, code: 'WRONG_TYPE',
      message: 'Images must be PNG, JPEG or WebP.' };
  }
  if (!size) {
    return { ok: false, code: 'EMPTY_FILE', message: `${name} is empty.` };
  }
  if (size > LESSON_IMAGE_MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return { ok: false, code: 'TOO_LARGE',
      message: `${name} is ${mb} MB — the limit is ${LESSON_IMAGE_MAX_BYTES / 1024 / 1024} MB. Resize it and try again.` };
  }
  // ★ DERIVE FROM THE EXTENSION WHEN THE BROWSER SAYS NOTHING. `file.type` is empty for
  //   some drag sources and for .webp on older platforms, and defaulting to image/jpeg
  //   there uploaded a PNG declared — and stored, via lessonAssetObjectName — as a JPEG.
  //   Browsers sniff, so it still rendered; the bucket's allow-list was simply told
  //   something untrue, which is not a boundary worth eroding for a default.
  const byExt = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return {
    ok: true, code: null, message: null,
    mimeType: LESSON_IMAGE_MIMES.includes(type) ? type : byExt,
  };
}
