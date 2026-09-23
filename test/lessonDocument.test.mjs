// ─────────────────────────────────────────────────────────────────────────────
// src/lib/lessonDocument.js — the bridge between stored lesson markdown and the
// editable document model.
//
// The editor's document model is a convenience; `course_lessons.text_content` is the
// contract. Every test here is really one question: can a creator's lesson survive a
// trip through the editor unchanged? Where the answer is "not exactly", the test names
// the normalization out loud rather than letting it be discovered in production.
//
// The hazards in §C and §D are not hypothetical — each was found by driving the real
// parser in src/lib/lessonContent.js, and several of them change a link's DESTINATION
// rather than merely its appearance.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LESSON_DOC_MARKS, LESSON_DOC_NODES,
  docAssetIds, docImagesMissingAlt, docPendingUploads,
  docToMarkdown, emptyLessonDoc, markdownToDoc, normalizeDoc,
} from '../src/lib/lessonDocument.js';
import {
  LESSON_ASSET_SCHEME, LESSON_IMAGE_CAPTION_MAX,
  escapeMarkdown, lessonAssetIds, lessonAssetRefs, lessonContentToPlainText,
  parseLessonContent, plainToMarkdown, validateLessonContent,
} from '../src/lib/lessonContent.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = () => readFileSync(join(REPO, 'src/lib/lessonContent.js'), 'utf8');

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BS = String.fromCharCode(92); // a literal backslash, un-mangled by any escaping
const img = (alt, id) => `![${alt}](${LESSON_ASSET_SCHEME}${id})`;

const S = (v) => JSON.stringify(v);
const blocks = (doc) => doc.content.map((b) => b.type);
const md2doc = (m) => markdownToDoc(m, 'markdown');

/** The three round-trip statements from the module header, as one reusable check. */
function roundTrip(md) {
  const d1 = md2doc(md);
  const out = docToMarkdown(d1);
  const d2 = md2doc(out);
  return {
    doc: d1, out, out2: docToMarkdown(d2),
    stable: S(d1.content) === S(d2.content),
  };
}

function assertRoundTrip(md, label) {
  const r = roundTrip(md);
  assert.equal(r.stable, true,
    `${label}: the document changed shape on the way back\n  in:   ${S(md)}\n  out:  ${S(r.out)}`);
  assert.equal(r.out, r.out2, `${label}: serialization is not idempotent from the second pass`);
  return r;
}

/** Every href a document actually renders, via the parser rather than a regex. */
function hrefsIn(text) {
  const out = [];
  const walk = (tokens) => {
    for (const t of tokens || []) {
      if (t.type === 'link' && t.href) out.push(t.href);
      if (t.tokens) walk(t.tokens);
    }
  };
  for (const b of parseLessonContent(text, 'markdown')) {
    if (b.type === 'paragraph') walk(b.tokens);
    else if (b.type === 'list') b.items.forEach(walk);
    if (b.caption) walk(b.caption);
  }
  return out;
}

// ── A. plain lessons are shown, never reinterpreted ─────────────────────────

test('a plain lesson becomes paragraphs and hard breaks, nothing else', () => {
  const doc = markdownToDoc('First line\nsecond line\n\nNew paragraph', 'plain');
  assert.deepEqual(blocks(doc), ['paragraph', 'paragraph']);
  assert.deepEqual(doc.content[0].content.map((n) => n.type), ['text', 'hardBreak', 'text']);
  assert.equal(doc.content[1].content[0].text, 'New paragraph');
});

test('a plain lesson acquires NO formatting by being opened', () => {
  // ★ THE WHOLE POINT OF THE 'plain' FORMAT. A legacy note that happens to contain "**"
  //   or "[1]" or "- " must read afterwards exactly as it read before. Conversion is an
  //   explicit, separate act (plainToMarkdown), never something opening a drawer does.
  const legacy = `**not bold** [1] see [x](https://y.example/)\n- not a list\n1. not a step`;
  const doc = markdownToDoc(legacy, 'plain');
  const json = S(doc);
  for (const t of ['bold', 'link', 'lessonImage', 'bulletList', 'orderedList', 'brokenToken']) {
    assert.ok(!json.includes(`"${t}"`), `a plain lesson must not produce a ${t} node`);
  }
  assert.ok(json.includes('**not bold**'), 'the asterisks survive as the literal text they are');
});

test('whitespace-only lines end a paragraph, matching the parser', () => {
  const doc = markdownToDoc('A\n   \nB', 'plain');
  assert.deepEqual(blocks(doc), ['paragraph', 'paragraph']);
});

test('opening a plain lesson and writing it back reproduces plainToMarkdown', () => {
  // Opening a lesson must not be a conversion. Once the creator DOES convert, the editor
  // has to agree with the one function that performs it, or the two disagree about the
  // single intentional change (a bare URL becoming clickable).
  for (const sample of ['A note with * stars *', 'See [1] and - dashes', '1. Step one', 'Plain words']) {
    const viaOptIn = plainToMarkdown(sample);
    const viaEditor = docToMarkdown(markdownToDoc(viaOptIn, 'markdown'));
    assert.equal(
      lessonContentToPlainText(viaEditor, 'markdown').replace(/\s+/g, ' ').trim(),
      lessonContentToPlainText(viaOptIn, 'markdown').replace(/\s+/g, ' ').trim(),
      `converting ${S(sample)} must read the same either way`);
  }
});

test('junk input never throws and always yields a usable document', () => {
  for (const v of [null, undefined, '', 42, {}, []]) {
    for (const f of ['plain', 'markdown', undefined]) {
      const doc = markdownToDoc(v, f);
      assert.equal(doc.type, 'doc');
      assert.ok(doc.content.length >= 1, 'doc content is block+, so never empty');
    }
  }
  assert.equal(docToMarkdown(null), '');
  assert.equal(docToMarkdown({}), '');
  assert.equal(docToMarkdown(emptyLessonDoc()), '');
});

// ── B. markdown → document ──────────────────────────────────────────────────

test('paragraphs, blank lines and hard breaks map one to one', () => {
  const doc = md2doc('One\nTwo\n\nThree');
  assert.deepEqual(blocks(doc), ['paragraph', 'paragraph']);
  assert.deepEqual(doc.content[0].content.map((n) => n.type), ['text', 'hardBreak', 'text']);
});

test('bold becomes a mark, and the two shapes that are not bold stay text', () => {
  const bold = md2doc('**yes** no').content[0].content;
  assert.deepEqual(bold[0].marks, [{ type: 'bold' }]);
  assert.ok(!bold[1].marks, 'the rest of the line carries no mark');
  // Verified against the parser: `****` never opens a run (close > i + 2 fails), and
  // `**a****b**` is two runs which the model merges into one.
  assert.ok(!S(md2doc('****')).includes('bold'), 'empty bold is literal text');
  const merged = md2doc('**a****b**').content[0].content;
  assert.equal(merged.length, 1, 'adjacent bold runs are one text node');
  assert.equal(merged[0].text, 'ab');
});

test('both list kinds map, and the ordered delimiter is not preserved because it cannot be', () => {
  assert.deepEqual(blocks(md2doc('- a\n- b')), ['bulletList']);
  assert.deepEqual(blocks(md2doc('1. a\n2. b')), ['orderedList']);
  // OL_RE accepts `.` and `)` and the parser discards the number entirely, so there is
  // nothing in the document to preserve either with.
  assert.equal(S(md2doc('1) a\n2) b')), S(md2doc('1. a\n2. b')));
  const li = md2doc('- a\n- b').content[0].content;
  assert.equal(li.length, 2);
  assert.deepEqual(li[0].content.map((c) => c.type), ['paragraph']);
});

test('a link is a mark on its words, and a bare URL is marked as bare', () => {
  const explicit = md2doc('Open the [form](https://forms.gle/abc) now').content[0].content;
  const linked = explicit.find((n) => (n.marks || []).some((m) => m.type === 'link'));
  assert.equal(linked.text, 'form', 'the WORDS carry the link, not the address');
  assert.equal(linked.marks.find((m) => m.type === 'link').attrs.bare, false);

  const bare = md2doc('Go to https://forms.gle/abc now').content[0].content;
  const b = bare.find((n) => (n.marks || []).some((m) => m.type === 'link'));
  assert.equal(b.text, 'https://forms.gle/abc');
  assert.equal(b.marks.find((m) => m.type === 'link').attrs.bare, true);
});

test('an image block becomes one node carrying its own caption', () => {
  const doc = md2doc(`${img('A chart', ID_A)}\n^ Figure 1 — the button`);
  assert.deepEqual(blocks(doc), ['lessonImage']);
  assert.deepEqual(doc.content[0].attrs, {
    assetId: ID_A, alt: 'A chart', caption: 'Figure 1 — the button',
  });
  assert.equal(md2doc(img('A chart', ID_A)).content[0].attrs.caption, '');
});

test('an inline image is LIFTED out of its paragraph, which splits', () => {
  // ★ THE ONE NORMALIZATION THAT MOVES THE AI TRAINER'S CONTENT HASH. lessonImage is a
  //   block node, so `See ![A](…) here` becomes three blocks — which is also how it
  //   reads on the page. Worth saying out loud: it re-indexes the affected lessons once.
  const doc = md2doc(`See ${img('A', ID_A)} here`);
  assert.deepEqual(blocks(doc), ['paragraph', 'lessonImage', 'paragraph']);
  assert.equal(doc.content[0].content[0].text, 'See', 'the split space is not kept');
  assert.equal(doc.content[2].content[0].text, 'here');
});

test('an image that cannot be a block keeps its real token bytes', () => {
  // Inside a list item there is nowhere to put a block, and `listItem` holds exactly one
  // paragraph. Dropping the token would delete a reference the DATABASE derives from the
  // text, so the image is shown as source instead — visibly, not silently.
  const doc = md2doc(`- Step with ${img('A', ID_A)} in it`);
  const inner = doc.content[0].content[0].content[0].content;
  const broken = inner.find((n) => n.type === 'brokenToken');
  assert.ok(broken, 'the token survives as a brokenToken');
  assert.equal(broken.attrs.raw, img('A', ID_A));
  assert.deepEqual(lessonAssetIds(docToMarkdown(doc), 'markdown'), [ID_A],
    'and the lesson still cites the image, so its authorization row survives');
});

test('a refused link or image round-trips verbatim instead of being rewritten', () => {
  // ★ REACHABLE ONLY BY A HAND-EDITED ROW — validateLessonContent blocks saving any of
  //   these — which is exactly why the editor must not quietly "repair" one. Rewriting
  //   somebody's stored lesson while showing them something else is the failure mode.
  for (const src of [
    '[HERE](javascript:alert(1))',
    '[HERE](http://old.example/)',
    '![A chart](https://tracker.example/pixel.png)',
    `![A](${LESSON_ASSET_SCHEME}not-a-uuid)`,
  ]) {
    const r = assertRoundTrip(src, src);
    assert.equal(r.out, src, `${src} must survive byte-identically`);
  }
});

// ── C. document → markdown: escaping is the crux ────────────────────────────

test('text is escaped exactly as escapeMarkdown escapes it', () => {
  // The character loop, character by character. `-` and `.` are deliberately absent:
  // escapeMarkdown handles those by POSITION, which escapeLeading mirrors below.
  for (const ch of [BS, '*', '[', ']', '!']) {
    const out = docToMarkdown(md2doc(`a${BS}${ch}b`));
    assert.equal(out, `a${BS}${ch}b`, `${ch} must stay escaped`);
    assert.equal(parseLessonContent(out, 'markdown')[0].tokens[0].value, `a${ch}b`,
      `${ch} must read back as itself`);
  }
  // And the same answer escapeMarkdown would give for ordinary prose.
  const prose = 'Costs * 2 and [see note] and !important';
  assert.equal(docToMarkdown(markdownToDoc(prose, 'plain')), escapeMarkdown(prose));
});

test('a line that would become a list is escaped by POSITION, including with a tab', () => {
  for (const sep of [' ', '\t']) {
    for (const src of [`-${sep}not a list`, `1.${sep}not a step`, `1)${sep}not a step`]) {
      const out = docToMarkdown(markdownToDoc(src, 'plain'));
      assert.deepEqual(blocks(md2doc(out)), ['paragraph'], `${S(src)} must stay a paragraph`);
      assert.equal(parseLessonContent(out, 'markdown')[0].tokens[0].value, src,
        `${S(src)} must read back as itself`);
    }
  }
  // ★ THE TAB CASE IS THE ONE escapeMarkdown USED TO GET WRONG. UL_RE/OL_RE accept \s+
  //   while the two escapes required a literal space, so `-\tx` escaped to itself and
  //   then parsed as a LIST — the hyphen silently disappeared from a converted lesson.
  assert.equal(escapeMarkdown(`-${BS}tx`.replace(`${BS}t`, '\t')), `${BS}-\tx`,
    'escapeMarkdown itself must escape a tab-separated hyphen');
});

test('the leading escape is applied BEFORE the list marker, not after', () => {
  // An item whose own text begins "- " must not produce "- - x", which reads back as a
  // one-item list containing "- x" only by luck of the regex.
  const doc = {
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '- x' }] }] }],
    }],
  };
  const out = docToMarkdown(doc);
  assert.equal(out, `- ${BS}- x`);
  const back = md2doc(out);
  assert.deepEqual(blocks(back), ['bulletList']);
  assert.equal(back.content[0].content[0].content[0].content[0].text, '- x');
});

test('a bold run ending in an asterisk degrades rather than corrupting itself', () => {
  // parseInline closes a run with indexOf('**'), which cannot see a backslash — verified:
  // `**a\***` reads back as bold("a\") + "*", a stray backslash in somebody's lesson.
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a*', marks: [{ type: 'bold' }] }] }] };
  const out = docToMarkdown(doc);
  assert.equal(out, `**a**${BS}*`);
  const back = parseLessonContent(out, 'markdown')[0].tokens;
  assert.equal(back[0].type, 'bold');
  assert.equal(back[0].tokens[0].value, 'a');
  assert.equal(back[1].value, '*', 'the asterisk is visible text, not a swallowed escape');
});

test('parentheses in an address are encoded only when they have to be', () => {
  const balanced = 'https://en.wikipedia.org/wiki/Trial_balance_(accounting)';
  const link = (href) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'TB', marks: [{ type: 'link', attrs: { href, bare: false } }] }] }],
  });
  // Balanced survives verbatim, or every save would churn the stored text.
  assert.equal(docToMarkdown(link(balanced)), `[TB](${balanced})`);
  assert.deepEqual(hrefsIn(docToMarkdown(link(balanced))), [balanced]);

  // Unbalanced closes the token EARLY, producing a working link to a different address.
  for (const raw of ['https://x.example/a)b', 'https://x.example/a(b']) {
    const out = docToMarkdown(link(raw));
    const got = hrefsIn(out);
    assert.equal(got.length, 1, `${raw}: exactly one link`);
    assert.equal(decodeURIComponent(got[0]), decodeURIComponent(raw),
      `${raw}: the destination must be preserved exactly`);
  }
});

test('a label drops "]" and keeps an escaped "["', () => {
  // Verified: linkAt's indexOf(']') is escape-blind, so a `]` closes the label early and
  // the token stops being a link at all. `[` is harmless — a token is only accepted when
  // the character after `]` is `(`.
  const mk = (label) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: 'https://x.example/', bare: false } }] }] }],
  });
  assert.equal(docToMarkdown(mk('a]b')), '[ab](https://x.example/)');
  assert.equal(docToMarkdown(mk('a[b')), `[a${BS}[b](https://x.example/)`);
  assert.deepEqual(hrefsIn(docToMarkdown(mk('a[b'))), ['https://x.example/'],
    'and it is still exactly one link');
});

test('an upload still in flight is never written to the lesson', () => {
  // ★ The asset row does not exist yet, so a token for it would make the trigger refuse
  //   the whole save with an accurate error that reads like a bug.
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      { type: 'uploadingImage', attrs: { uploadKey: 'blob:https://app.example/abc-123' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ],
  };
  const out = docToMarkdown(doc);
  assert.equal(out, 'Before\n\nAfter');
  assert.ok(!out.includes('blob:'), 'and no object URL can reach the stored text');
  assert.deepEqual(docPendingUploads(doc), ['blob:https://app.example/abc-123']);
  // A paragraph holding only a placeholder must not leave an empty block behind.
  assert.equal(docToMarkdown({ type: 'doc', content: [{ type: 'uploadingImage', attrs: {} }] }), '');

  // ★ THE RULE HOLDS BY CONSTRUCTION, WHICH IS WHY IT NEEDS THIS SCAN RATHER THAN A
  //   BEHAVIOUR TEST. `uploadingImage` is an ATOM WITH NO CONTENT, so there is nothing for
  //   any serializer branch to emit — disabling all three of its explicit exclusions
  //   changes no output, because the default branch drops it too. Breaking it therefore
  //   takes ADDING a branch that reads its attrs, not removing one, and no mutation of
  //   existing code can simulate that. So the check is: the serializer never learns the
  //   attribute name at all. `uploadKey` is where an object URL lives.
  const src = readFileSync(join(REPO, 'src/lib/lessonDocument.js'), 'utf8');
  const serializer = src.slice(src.indexOf('// document  →  markdown'), src.indexOf('// Small readers'));
  const code = serializer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/uploadKey/.test(code),
    'the half of this module that writes text must not know an upload placeholder has attrs');
  assert.ok(!/previewUrl|objectURL|blob:/i.test(code),
    'nor anything else that only exists while bytes are still moving');
});

test('unknown nodes degrade to their contents and never throw', () => {
  const junk = {
    type: 'doc',
    content: [
      null, {}, 'nope', { type: 'table', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'also kept' }] },
      { type: 'iframe', attrs: { src: 'https://evil.example/' } },
      { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'https://evil.example/x.png' } }] },
    ],
  };
  const out = docToMarkdown(junk);
  assert.ok(out.includes('kept'), 'words inside an unknown wrapper survive');
  assert.ok(!out.includes('evil.example'), 'but no foreign address comes with them');
  assert.ok(!/<[a-z]/i.test(out), 'and nothing HTML-shaped is written');

  // Depth is bounded rather than trusted.
  let deep = { type: 'paragraph', content: [{ type: 'text', text: 'x' }] };
  for (let i = 0; i < 200; i += 1) deep = { type: 'wrapper', content: [deep] };
  assert.doesNotThrow(() => docToMarkdown({ type: 'doc', content: [deep] }));
});

test('an image whose id is not a uuid is never written, whatever it is', () => {
  for (const assetId of [
    'not-a-uuid', '', null, undefined, 42,
    'https://x.supabase.co/storage/v1/object/sign/course-lesson-assets/a.png?token=ey',
    `lessons/${ID_A}/${ID_B}/pic.png`,
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:https://app.example/abc',
  ]) {
    const doc = { type: 'doc', content: [{ type: 'lessonImage', attrs: { assetId, alt: 'A', caption: '' } }] };
    assert.equal(docToMarkdown(doc), '', `${S(assetId)} must produce nothing`);
  }
  // But a VALID id with no description is still written, so IMAGE_ALT_REQUIRED can fire.
  const missing = { type: 'doc', content: [{ type: 'lessonImage', attrs: { assetId: ID_A, alt: '', caption: '' } }] };
  const out = docToMarkdown(missing);
  assert.equal(out, `![](${LESSON_ASSET_SCHEME}${ID_A})`);
  assert.deepEqual(validateLessonContent(out, 'markdown').errors.map((e) => e.code), ['IMAGE_ALT_REQUIRED'],
    'declining to write it would delete the picture AND the error that explains it');
  assert.deepEqual(docImagesMissingAlt(missing), [ID_A]);
});

// ── D. round trips ──────────────────────────────────────────────────────────

const CORPUS = [
  ['paragraph', 'Hello world'],
  ['two paragraphs', 'One\n\nTwo'],
  ['hard break', 'One\nTwo'],
  ['bold', '**Important** note'],
  ['bold inside a sentence', 'The **very** important note'],
  ['bullets', '- one\n- two\n- three'],
  ['numbers', '1. one\n2. two'],
  ['explicit link', 'Open the [form](https://forms.gle/abc123) now'],
  ['link with parens', 'See [TB](https://en.wikipedia.org/wiki/Trial_balance_(accounting)) here'],
  ['bare url', 'Go to https://forms.gle/abc123 now'],
  ['bare url at end', 'The form is https://forms.gle/abc123'],
  ['bold link label', 'Open [**the form**](https://forms.gle/abc123)'],
  ['image', img('A chart', ID_A)],
  ['image with caption', `${img('A chart', ID_A)}\n^ Figure 1 — the three-dot button`],
  ['two images', `${img('First', ID_A)}\n\n${img('Second', ID_B)}`],
  ['duplicate image', `${img('First', ID_A)}\n\n${img('First again', ID_A)}`],
  ['image between prose', `Step one\n\n${img('A chart', ID_A)}\n\nStep two`],
  ['inline image', `See ${img('A', ID_A)} here`],
  ['list then image', `- one\n- two\n\n${img('A', ID_A)}`],
  ['two bullet lists', '- a\n\n- b'],
  ['two ordered lists', '1. a\n\n1. b'],
  ['list kinds adjacent', '- a\n1. b'],
  ['caret prose', 'Look up\n^ at the arrow'],
  ['lone caret line', '^ no image above me'],
  ['caption with a bare url', `${img('A', ID_A)}\n^ see https://forms.gle/abc for it`],
  ['escaped hyphen', `${BS}- not a list`],
  ['escaped number', `1${BS}. not a step`],
  ['literal stars', `a ${BS}* b`],
  ['literal brackets', `see ${BS}[1${BS}] there`],
  ['refused link', '[HERE](javascript:alert(1))'],
  ['refused image', '![A chart](https://tracker.example/pixel.png)'],
  ['long prose', 'A'.repeat(400)],
];

test('every document in the corpus survives the round trip exactly', () => {
  for (const [label, md] of CORPUS) assertRoundTrip(md, label);
});

test('markdownToDoc always returns an already-normal document', () => {
  for (const [label, md] of CORPUS) {
    const d = md2doc(md);
    assert.equal(S(normalizeDoc(d)), S(d), `${label}: markdownToDoc must not need normalizing`);
  }
  assert.equal(S(normalizeDoc(normalizeDoc(emptyLessonDoc()))), S(normalizeDoc(emptyLessonDoc())),
    'normalizeDoc is idempotent');
});

test('the serializer never writes a document its own validator would refuse', () => {
  for (const [label, md] of CORPUS) {
    const verdict = validateLessonContent(md, 'markdown');
    if (!verdict.ok) continue; // a refused source stays refused — see the verbatim test
    const out = docToMarkdown(md2doc(md));
    assert.equal(validateLessonContent(out, 'markdown').ok, true,
      `${label}: ${S(out)} was refused: ${S(validateLessonContent(out, 'markdown').errors)}`);
  }
});

test('the serializer never invents a broken image reference', () => {
  // validateLessonContent counts raw scheme occurrences against readable tokens, so an
  // alt text carrying a "]" strands a reference. The serializer strips those from alt
  // text via sanitizeAltText; this proves the counting agrees for the whole corpus.
  for (const [label, md] of CORPUS) {
    const out = docToMarkdown(md2doc(md));
    const schemeHits = (out.match(new RegExp(LESSON_ASSET_SCHEME, 'g')) || []).length;
    assert.equal(schemeHits, lessonAssetRefs(out, 'markdown').length,
      `${label}: every scheme occurrence must be a readable token`);
  }
  const awkward = { type: 'doc', content: [{ type: 'lessonImage', attrs: { assetId: ID_A, alt: 'Screenshot [1] of the menu', caption: '' } }] };
  const out = docToMarkdown(awkward);
  assert.deepEqual(validateLessonContent(out, 'markdown').errors, []);
  assert.deepEqual(lessonAssetIds(out, 'markdown'), [ID_A]);
});

test('a plain-text URL beside a link and a bold run destroys neither', () => {
  // ★ THE WORST BUG THIS MODULE HAS HAD, AND THE NET WAS WHAT CAUSED IT. Nothing in the
  //   canvas linkifies as you type, so a URL pasted into a sentence is an UNMARKED text
  //   node. markdownToDoc of the serialized text autolinks it, so the re-parse never
  //   matched the model, all three tiers were rejected, and blockMarkdown shipped the
  //   LITERAL rendering — which drops every [label](href) and every **bold** in the block.
  //   Measured: the Google Form link and the bold sentence both vanished,
  //   validateLessonContent said ok, and the canvas still showed them because it is seeded
  //   once and never re-read. The creator had no way to know.
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Submit the form ' },
        { type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: 'https://forms.gle/abc123', bare: false } }] },
        { type: 'text', text: ' or copy https://acme.example/backup into your browser. ' },
        { type: 'text', text: 'Do not skip this.', marks: [{ type: 'bold' }] },
      ],
    }],
  };
  const out = docToMarkdown(doc);
  assert.ok(out.includes('[here](https://forms.gle/abc123)'), `the link was destroyed: ${S(out)}`);
  assert.ok(out.includes('**Do not skip this.**'), `the bold was destroyed: ${S(out)}`);
  assert.deepEqual(hrefsIn(out).sort(), ['https://acme.example/backup', 'https://forms.gle/abc123']);
  assertRoundTrip(out, 'link + plain url + bold');
  // The same shape inside a list item, which took the identical path.
  const li = {
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Open', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'the sheet', marks: [{ type: 'link', attrs: { href: 'https://docs.google.com/x', bare: false } }] },
            { type: 'text', text: ' at https://acme.example/s' },
          ],
        }],
      }],
    }],
  };
  const liOut = docToMarkdown(li);
  assert.ok(liOut.includes('**Open**') && liOut.includes('[the sheet](https://docs.google.com/x)'), liOut);
});

test('an unmarked URL is autolinked by the MODEL, exactly as the parser would', () => {
  // The fix above only works because normalizeInline mirrors parseInline here. If the two
  // ever disagree again, the net starts rejecting correct renderings all over again.
  const doc = normalizeDoc({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Go to https://x.example/p now.' }] }],
  });
  const marks = doc.content[0].content.map((n) => (n.marks || []).map((m) => m.type).join(','));
  assert.deepEqual(marks, ['', 'link', ''], 'the URL run carries a link mark, the prose does not');
  const link = doc.content[0].content[1];
  assert.equal(link.text, 'https://x.example/p', 'the trailing full stop belongs to the sentence');
  assert.equal(link.marks[0].attrs.bare, true);
  // A refused scheme must NOT be autolinked, and must not loop for ever either.
  const http = normalizeDoc({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see http://old.example/a and more' }] }],
  });
  assert.ok(!S(http).includes('"link"'), 'http:// is not linkable, so no mark is invented');
  assert.equal(docToMarkdown(http), 'see http://old.example/a and more');
});

test('a bare URL containing a parenthesis is never rewritten to a different address', () => {
  // ★ BARE_URL_RE EXCLUDES ")", so a parsed Wikipedia URL is ALREADY truncated and
  //   therefore unbalanced. Percent-encoding it during NORMALIZATION (rather than only at
  //   emit) broke "markdownToDoc's output is already normal": the comparison failed, the
  //   conservative tier was accepted, and the stored text became a link whose visible text
  //   was truncated and whose href was a 404 — with a stray ")" beside it. It converged
  //   after one save, so it was permanent.
  const src = 'See https://en.wikipedia.org/wiki/Trial_balance_(accounting) for detail.';
  const doc = md2doc(src);
  assert.equal(S(normalizeDoc(doc).content), S(doc.content), 'the parse must already be normal');
  assert.equal(docToMarkdown(doc), src, 'and it must round-trip byte-identically');
  for (const u of [
    'https://acme.sharepoint.com/sites/f/Q3%20(final).xlsx',
    'https://acme.example/a(b)c/d',
  ]) {
    const line = `Open ${u} today.`;
    assert.equal(docToMarkdown(md2doc(line)), line, `${u} must survive verbatim`);
  }
});

test('an escape beside a bare URL never becomes part of the address', () => {
  // escapeText escapes `\ * [ ] !`, and BARE_URL_RE's class excludes none of them — so the
  // backslash was swallowed into the URL and WHATWG turned it into a "/", giving students
  // a visible backslash and a link to a different resource.
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Download https://acme.example/report.pdf!' }] }],
  };
  const out = docToMarkdown(doc);
  assert.deepEqual(hrefsIn(out), ['https://acme.example/report.pdf'],
    `the destination drifted: ${S(out)}`);
  const prose = lessonContentToPlainText(out, 'markdown');
  assert.ok(!prose.includes('\\'), `a raw escape reached the reader: ${S(prose)}`);
});

test('a bare URL with text typed after it is demoted rather than silently redirected', () => {
  // ★ THE HAZARD THAT CHANGES A DESTINATION. BARE_URL_RE is greedy, so a bare link with
  //   a character typed straight after it re-parses as a LONGER url — a different
  //   address, with nothing on screen to say so. Demoting to an explicit link is lossless.
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'https://x.example/p', marks: [{ type: 'link', attrs: { href: 'https://x.example/p', bare: true } }] },
        { type: 'text', text: 'xyz' },
      ],
    }],
  };
  const out = docToMarkdown(doc);
  assert.deepEqual(hrefsIn(out), ['https://x.example/p'], 'the destination did not drift');
  assert.ok(out.includes(']('), 'so it had to become an explicit link');
  assertRoundTrip(out, 'demoted bare link');
});

test('a bare URL under bold is demoted too', () => {
  // BARE_URL_RE's class allows `*`, so `**https://x/a**` would shatter the run.
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text', text: 'https://x.example/p',
        marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://x.example/p', bare: true } }],
      }],
    }],
  };
  const out = docToMarkdown(doc);
  assert.deepEqual(hrefsIn(out), ['https://x.example/p']);
  assertRoundTrip(out, 'bold bare link');
});

test('adjacent lists of the same kind stay two lists', () => {
  const doc = md2doc('- a\n\n- b');
  assert.deepEqual(blocks(doc), ['bulletList', 'bulletList']);
  assert.deepEqual(blocks(md2doc(docToMarkdown(doc))), ['bulletList', 'bulletList']);
  const ord = md2doc('1. a\n\n1. b');
  assert.deepEqual(blocks(ord), ['orderedList', 'orderedList']);
  assert.deepEqual(blocks(md2doc(docToMarkdown(ord))), ['orderedList', 'orderedList']);
});

test('an image followed by ordinary "^" prose keeps both', () => {
  const src = `${img('A', ID_A)}\n\n^ this is prose, not a caption`;
  const doc = md2doc(src);
  assert.deepEqual(blocks(doc), ['lessonImage', 'paragraph']);
  assert.equal(doc.content[0].attrs.caption, '', 'the prose did not become a caption');
  assertRoundTrip(src, 'image then caret prose');
});

test('the conservative and literal fallbacks are never reached by the corpus', () => {
  // The three-tier net exists for the hazard nobody enumerated. If it fires for anything
  // in the corpus, the PREFERRED rendering has a defect that should be fixed directly —
  // the net is not a licence to emit something that reads back differently.
  const single = (node) => ({ type: 'doc', content: [node] });
  const preferredIsEnough = (node) => {
    const one = single(node);
    // `bare` is a hint, not content: docToMarkdown may legitimately demote a bare link to
    // an explicit one, so compare the way blockMarkdown does.
    const strip = (v) => JSON.stringify(v, (k, val) => (k === 'bare' ? undefined : val));
    return strip(md2doc(docToMarkdown(one)).content) === strip(normalizeDoc(one).content);
  };
  for (const [label, md] of CORPUS) {
    for (const node of md2doc(md).content) {
      assert.ok(preferredIsEnough(node), `${label}: block ${node.type} needed a fallback`);
    }
  }
  // ★ AND THE HAND-BUILT DOCS THE CORPUS CANNOT EXPRESS. A bare link with text typed
  //   straight after it is the case bareSurvives() exists for: the net would catch the
  //   drift and demote, so behaviour stays correct either way — but silently leaning on
  //   the net means the cheap check could be deleted and nothing would notice.
  const bareThen = (rest) => single({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'https://x.example/p', marks: [{ type: 'link', attrs: { href: 'https://x.example/p', bare: true } }] },
      { type: 'text', text: rest },
    ],
  });
  for (const rest of ['xyz', '.more', '/deeper', '?q=1']) {
    assert.ok(preferredIsEnough(bareThen(rest).content[0]),
      `a bare link followed by ${S(rest)} must be got right on the first pass`);
    assert.deepEqual(hrefsIn(docToMarkdown(bareThen(rest))), ['https://x.example/p'],
      `and the destination must not drift when ${S(rest)} follows it`);
  }
});

// ── E. what may never reach stored content ──────────────────────────────────

const REFUSED_HREFS = [
  'javascript:alert(1)', 'JavaScript:alert(1)', `java${BS}nscript:alert(1)`.replace(`${BS}n`, '\n'),
  'data:text/html,<script>alert(1)</script>', 'blob:https://app.example/abc-123',
  'file:///etc/passwd', 'http://insecure.example/', '//evil.example/x',
  'https://forms.google.com@evil.example/', 'vbscript:msgbox(1)', '', '   ',
];

test('no refused scheme can be written as a link, and the words survive', () => {
  for (const href of REFUSED_HREFS) {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click here', marks: [{ type: 'link', attrs: { href, bare: false } }] }] }],
    };
    const out = docToMarkdown(doc);
    assert.deepEqual(hrefsIn(out), [], `${S(href)} must produce no href at all`);
    assert.ok(!out.includes(']('), `${S(href)} must not produce a link token`);
    assert.equal(out, 'Click here', 'the label stays readable text');
  }
});

test('the address written is the one safeLessonHref returns, not the one the mark carries', () => {
  // ★ EVERY href GOES THROUGH THE VERDICT, and that is only observable with an address the
  //   parser NORMALIZES. Both the model and the emitter write `verdict.href`; a version
  //   that wrote the mark's own value would look identical for every canonical URL, so the
  //   guard needs a non-canonical one to be worth anything.
  const mk = (href) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open', marks: [{ type: 'link', attrs: { href, bare: false } }] }] }],
  });
  for (const [raw, canonical] of [
    ['HTTPS://EXAMPLE.COM/Path', 'https://example.com/Path'],
    ['https://Example.COM', 'https://example.com/'],
    ['https://example.com', 'https://example.com/'],
  ]) {
    const out = docToMarkdown(mk(raw));
    assert.equal(out, `[Open](${canonical})`, `${S(raw)} must be written canonically`);
    assert.deepEqual(hrefsIn(out), [canonical]);
    // And the model agrees, so the round-trip check never sees a difference.
    assert.equal(normalizeDoc(mk(raw)).content[0].content[0].marks[0].attrs.href, canonical);
  }
});

test('HTML never reaches stored content', () => {
  const nasty = '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold?</b>';
  const out = docToMarkdown(markdownToDoc(nasty, 'plain'));
  assert.ok(out.includes('<script>'), 'the angle brackets stay literal TEXT');
  const toks = parseLessonContent(out, 'markdown');
  assert.ok(!/"type":"(bold|link|image|badlink|badimage)"/.test(S(toks)),
    'and none of it parses as markup');
  assertRoundTrip(out, 'html as text');
});

test('no signed URL, blob URL, data URI or storage path can become an image source', () => {
  // ★ THE GUARANTEE IS ABOUT IMAGE SOURCES AND UPLOAD STATE, not about every character a
  //   creator may type. An image is addressed ONLY by `lesson-asset://<uuid>`, so a
  //   signed URL — which expires, so a stored one is a dead link within the hour — a
  //   blob URL, a data URI and a raw bucket path are all unwritable by construction.
  //   Pasting a signed URL as an ordinary LINK is a different act: it is a valid https
  //   address and the creator gets the link they asked for.
  const secrets = [
    'https://ref.supabase.co/storage/v1/object/sign/course-lesson-assets/lessons/a/b/c.png?token=eyJhbGci',
    'blob:https://app.example/9f0c-4a1b',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    `lessons/${ID_A}/${ID_B}/screenshot.png`,
  ];
  for (const s of secrets) {
    const out = docToMarkdown({
      type: 'doc',
      content: [
        { type: 'lessonImage', attrs: { assetId: s, alt: 'A', caption: '' } },
        { type: 'uploadingImage', attrs: { uploadKey: s } },
      ],
    });
    assert.equal(out, '', `${S(s)} must produce no block at all\n  got ${S(out)}`);
  }
  // And the two schemes that are not addresses at all can never become an href either.
  for (const s of ['blob:https://app.example/9f0c', 'data:text/html,<b>x</b>']) {
    const out = docToMarkdown({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: s, bare: false } }] }] }],
    });
    assert.deepEqual(hrefsIn(out), [], `${S(s)} must not become a link`);
  }
});

test('the AI trainer projection stays clean for everything the serializer writes', () => {
  for (const [label, md] of CORPUS) {
    const out = docToMarkdown(md2doc(md));
    const prose = lessonContentToPlainText(out, 'markdown');
    for (const forbidden of [LESSON_ASSET_SCHEME, '![', '](', '**', ID_A, ID_B]) {
      assert.ok(!prose.includes(forbidden),
        `${label}: ${S(forbidden)} reached the trainer\n  prose: ${S(prose)}`);
    }
  }
  // A caption's MARKER is markup and must not be spoken; a `^` the creator typed as
  // ordinary prose is their word and must be. The corpus above contains both.
  const withCaption = docToMarkdown(md2doc(`${img('A chart', ID_A)}\n^ Figure 1`));
  assert.equal(lessonContentToPlainText(withCaption, 'markdown'), 'Image: A chart — Figure 1');
  assert.equal(lessonContentToPlainText(docToMarkdown(md2doc('Look up\n^ at the arrow')), 'markdown'),
    'Look up\n^ at the arrow');
});

test('duplicate image references stay one asset and two references', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'lessonImage', attrs: { assetId: ID_A, alt: 'First', caption: '' } },
      { type: 'lessonImage', attrs: { assetId: ID_A, alt: 'Again', caption: '' } },
    ],
  };
  const out = docToMarkdown(doc);
  assert.equal(lessonAssetRefs(out, 'markdown').length, 2);
  assert.deepEqual(lessonAssetIds(out, 'markdown'), [ID_A]);
  assert.deepEqual(docAssetIds(doc), [ID_A]);
  assert.equal(validateLessonContent(out, 'markdown').ok, true);
});

// ── F. captions ─────────────────────────────────────────────────────────────

test('a bare URL in a caption survives instead of collapsing to its host', () => {
  // ★ A LIVE DATA-LOSS BUG THIS MODULE HAD TO FIX. inlineToText renders a bare link as
  //   its HOST, which is right for a speaking agent and wrong for a caption the editor
  //   reads back and writes out again: `see https://forms.gle/abc for the form` became
  //   `see forms.gle for the form`, permanently, on the creator's next save.
  const src = `${img('A', ID_A)}\n^ see https://forms.gle/abc123 for the form`;
  const doc = md2doc(src);
  assert.equal(doc.content[0].attrs.caption, 'see https://forms.gle/abc123 for the form');
  assertRoundTrip(src, 'caption with a bare url');
});

test('a caption cannot smuggle in a second image, and the save says so', () => {
  const doc = {
    type: 'doc',
    content: [{ type: 'lessonImage', attrs: { assetId: ID_A, alt: 'A', caption: `see ${img('X', ID_B)} here` } }],
  };
  const out = docToMarkdown(doc);
  assert.deepEqual(lessonAssetIds(out, 'markdown'), [ID_A],
    'the caption is escaped, so it authorizes no second image');
  assert.ok(out.includes(`${BS}!${BS}[X${BS}]`), 'the token is written as the literal prose it now is');
  // ★ AND THE SAVE IS THEN CORRECTLY REFUSED, which is pre-existing and deliberate:
  //   validateLessonContent counts RAW scheme occurrences, and escaping does not touch
  //   `:` or `/`. The alternative — stripping the scheme out of the creator's caption —
  //   would delete their words to make a checker happy. Faithful and refused is better.
  assert.deepEqual(validateLessonContent(out, 'markdown').errors.map((e) => e.code),
    ['BROKEN_IMAGE_REFERENCE']);
  assertRoundTrip(out, 'caption with a token in it');
});

test('a caption is capped on its UNESCAPED length, so the limit is the stated one', () => {
  const long = '*'.repeat(LESSON_IMAGE_CAPTION_MAX + 50);
  const doc = { type: 'doc', content: [{ type: 'lessonImage', attrs: { assetId: ID_A, alt: 'A', caption: long } }] };
  const out = docToMarkdown(doc);
  const codes = validateLessonContent(out, 'markdown').errors.map((e) => e.code);
  assert.ok(!codes.includes('CAPTION_TOO_LONG'),
    'slicing the ESCAPED text would over-count every escape and could cut a pair in half');
  assert.equal(md2doc(out).content[0].attrs.caption.length, LESSON_IMAGE_CAPTION_MAX);
});

// ── G. lockstep with lessonContent.js ───────────────────────────────────────

test('the two opt-in parameters default to the safe answer', () => {
  // ★ THE SIBLING OF "NO FUNCTION MAY DEFAULT ITS format". A default that fires on
  //   `undefined` is exactly how a caller who asked for nothing gets the new behaviour.
  const src = lib();
  assert.match(src, /function parseInline\(src, depth = 0, inLink = false, withSource = false\)/,
    'parseInline must default withSource to false');
  assert.match(src, /export function parseLessonContent\(text, format, \{ withSource = false \} = \{\}\)/);
  assert.match(src, /const imageAt = \(src, i, withSource\) =>/);
  assert.match(src, /const linkAt = \(src, i, depth, withSource\) =>/);
  assert.match(src, /export function buildAssetToken\(assetId, altText, \{ requireAlt = true \} = \{\}\)/,
    'buildAssetToken must still require alt text by default — the composer relies on it');
  assert.match(src, /export function inlineToText\(tokens, \{ bareLinkAs = 'host' \} = \{\}\)/,
    "the trainer's projection must be unchanged by default, or every lesson re-indexes");
});

test('recording the source is opt-in, so a refused target still leaks nowhere', () => {
  const remote = '![A chart](https://tracker.example/pixel.png)';
  assert.ok(!S(parseLessonContent(remote, 'markdown')).includes('tracker.example'),
    'the default parse must not carry a third-party URL — the existing suite asserts this too');
  assert.ok(S(parseLessonContent(remote, 'markdown', { withSource: true })).includes('tracker.example'),
    'and only the editor, which writes it straight back, asks for it');
});

test('the document vocabulary is exactly the allowlist', () => {
  assert.deepEqual([...LESSON_DOC_NODES], [
    'doc', 'paragraph', 'text', 'hardBreak',
    'bulletList', 'orderedList', 'listItem',
    'lessonImage', 'uploadingImage', 'brokenToken',
  ]);
  assert.deepEqual([...LESSON_DOC_MARKS], ['bold', 'link']);
  // Anything this list does not name cannot be represented, so it cannot be stored.
  for (const banned of ['heading', 'image', 'table', 'codeBlock', 'blockquote', 'iframe',
    'horizontalRule', 'italic', 'strike', 'underline', 'textStyle', 'video']) {
    assert.ok(!LESSON_DOC_NODES.includes(banned) && !LESSON_DOC_MARKS.includes(banned),
      `${banned} must not be in the schema`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Documents only the EDITOR can build.
//
// ★ THE EXISTING CORPUS IS markdown → doc → markdown, so by construction it can only
//   contain shapes markdownToDoc emits — and it therefore could not see either of the two
//   real bugs code review found here: a hardBreak inside a list item (ordinary Shift+Enter;
//   HardBreak binds it and ListItem does not override it) and a newline inside a text node.
//   Both were verified against the live converter before these tests were written.
// ─────────────────────────────────────────────────────────────────────────────
const P = (...content) => ({ type: 'paragraph', content });
const T = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const LINK = (href) => ({ type: 'link', attrs: { href } });
const BOLD = { type: 'bold' };
const BR = { type: 'hardBreak' };
const DOC = (...content) => ({ type: 'doc', content });
const LI = (...content) => ({ type: 'listItem', content: [{ type: 'paragraph', content }] });

test('Shift+Enter in a bullet becomes a SPACE, never nothing', () => {
  // ★ MEASURED BEFORE THE FIX: "- open [the form](https://x.example/)then bold **word**".
  //   The canvas kept showing two lines — normalization happens at serialize time — so the
  //   creator saw a line break and the student read "the formthen bold word". The
  //   round-trip net cannot catch this: it compares against the already-normalized model,
  //   so both sides agreed on the corrupted text.
  const out = docToMarkdown(DOC({
    type: 'bulletList',
    content: [LI(T('open '), T('the form', [LINK('https://x.example/')]), BR, T('then bold '), T('word', [BOLD]))],
  }));
  assert.equal(out, '- open [the form](https://x.example/) then bold **word**');
  assert.ok(!/\)then|formthen/.test(out), 'the two words must not be glued together');
  assert.equal(docToMarkdown(markdownToDoc(out, 'markdown')), out, 'and it is stable');
  // A paragraph is unaffected: there a hard break is a real newline in the grammar.
  assert.equal(docToMarkdown(DOC(P(T('one'), BR, T('two')))), 'one\ntwo');
});

test('a newline inside a text node is normalized in the MODEL too', () => {
  // ★ THE FIFTH NORMALIZATION. escapeText() turns it into a space; before normalizeInline
  //   did the same, blockMarkdown\'s re-parse disagreed with the model it was checking and
  //   sent the block to the LITERAL tier. Measured: "a b and link" — BOTH marks lost.
  const out = docToMarkdown(DOC(P(T('a\nb', [BOLD]), T(' and '), T('link', [LINK('https://y.example/')]))));
  assert.equal(out, '**a b** and [link](https://y.example/)');
  assert.equal(docToMarkdown(markdownToDoc(out, 'markdown')), out);
});

test('an editor-shaped document keeps every mark it is allowed to keep', () => {
  // The general form of the two bugs above: serialize, and assert no mark the NORMALIZED
  // model still carries has vanished from the output. A literal-tier fallback strips marks
  // wholesale, so this catches the whole class rather than the two known instances.
  const cases = [
    ['break in a bullet', DOC({ type: 'bulletList', content: [LI(T('a', [BOLD]), BR, T('b', [LINK('https://z.example/')]))] })],
    ['break in an ordered item', DOC({ type: 'orderedList', content: [LI(T('x'), BR, T('y', [BOLD]))] })],
    ['newline in bold', DOC(P(T('p\nq', [BOLD])))],
    ['carriage return in a link label', DOC(P(T('r\r\ns', [LINK('https://z.example/')])))],
    ['bold spanning a link boundary', DOC(P(T('before ', [BOLD]), T('inside', [BOLD, LINK('https://z.example/')]), T(' after', [BOLD])))],

    ['two breaks in one item', DOC({ type: 'bulletList', content: [LI(T('one'), BR, BR, T('two'))] })],
    ['break at the end of an item', DOC({ type: 'bulletList', content: [LI(T('tail'), BR)] })],
  ];
  for (const [name, doc] of cases) {
    const out = docToMarkdown(doc);
    assert.equal(docToMarkdown(markdownToDoc(out, 'markdown')), out, `${name}: not stable`);
    const norm = JSON.stringify(normalizeDoc(doc));
    if (/"type":"bold"/.test(norm)) assert.match(out, /\*\*/, `${name}: bold vanished`);
    // A link whose LABEL is only whitespace is correctly dropped — the grammar has no way
    // to spell an empty label — so require a label with a visible character.
    if (/"type":"link"/.test(norm) && /"text":"[^"]*\S/.test(norm)) {
      assert.ok(/\]\(|https?:\/\//.test(out), `${name}: link vanished`);
    }
    assert.ok(validateLessonContent(out, 'markdown', { required: false }).ok,
      `${name}: the serializer wrote something its own validator refuses`);
    assert.ok(!/\r|\u2028|\u2029/.test(out), `${name}: stray line separator survived`);
  }
});

test('no two words are ever joined without a separator', () => {
  // A blunt property over the whole editor-shaped corpus: a hard break carries a word
  // boundary, so whatever replaces it must too.
  for (const doc of [
    DOC({ type: 'bulletList', content: [LI(T('alpha'), BR, T('beta'))] }),
    DOC({ type: 'orderedList', content: [LI(T('alpha', [BOLD]), BR, T('beta'))] }),
    DOC({ type: 'bulletList', content: [LI(T('alpha', [LINK('https://q.example/')]), BR, T('beta'))] }),
  ]) {
    // ★ NOT .replace(/[^a-z]/g,'') — that strips the very space being tested for, which is
    //   how this assertion first failed against a CORRECT output of "- alpha beta".
    assert.ok(!/alphabeta/.test(docToMarkdown(doc)),
      'a dropped break glued two words together');
  }
});

test('both list paths flatten a hard break — one by behaviour, one by construction', () => {
  // ★ AN EXPECTED MUTATION SURVIVOR, and it is pinned by SOURCE SCAN for that reason.
  //   docToMarkdown normalizes first, so normalizeBlocks flattens before pushBlock is ever
  //   reached on the serialize path — and on the PARSE path a list item comes from one
  //   source line, so it cannot carry a hard break in the first place. Deleting pushBlock's
  //   flatten therefore changes no observable output, exactly like the boldWrap peel and the
  //   uploadingImage exclusions CLAUDE.md already records. Scan for the call instead.
  const src = readFileSync(join(REPO, 'src/lib/lessonDocument.js'), 'utf8');
  assert.equal((src.match(/flattenBreaksToSpaces\(/g) || []).length, 3,
    'the helper plus its two call sites — pushBlock (parse) and normalizeBlocks (serialize)');
  // To the NEXT top-level function, not to a named one: inlineNodes is defined BEFORE
  // pushBlock, so naming it produced an empty slice and an assertion that failed on
  // correct code — the same shape as the §24 count anchor.
  const at = src.indexOf('function pushBlock(');
  assert.ok(at > 0, 'pushBlock was not found');
  const push = src.slice(at, src.indexOf('\nfunction ', at + 1));
  assert.match(push, /flattenBreaksToSpaces\(trimBreaks\(content\)\)/,
    'the parse path must flatten, not filter — a dropped break glues two words together');
  assert.ok(!/filter\(\(n\) => n\.type !== 'hardBreak'\)/.test(src),
    'no list path may DROP a hard break; both turn it into a space');
});

