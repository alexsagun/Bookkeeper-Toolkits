// test/lessonContent.test.mjs — what a lesson's instructions may contain (#65).
//
// ★ WHY THIS SUITE EXISTS. This module decides what a course creator's typing becomes on
//   a page that hundreds of signed-in students load. There is no markdown library to
//   lean on and no sanitizer downstream: if a token can carry a javascript: URL or a
//   third party's image, it reaches the student. The link tests below are the same
//   shapes portfolioGenerator.js and lessonReplay.js were written against, because the
//   Portfolio Generator shipped a `javascript:` CTA into four hrefs by escaping
//   `& < > "` and not `:`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LESSON_ASSET_PATH_RE,
  LESSON_ASSET_TOKEN_SRC,
  LESSON_ASSET_SCHEME,
  LESSON_CONTENT_FORMATS,
  LESSON_CONTENT_MAX_CHARS,
  LESSON_IMAGE_ALT_MAX,
  LESSON_IMAGE_MAX_BYTES,
  LESSON_IMAGE_MAX_PER_LESSON,
  LESSON_IMAGE_MIMES,
  LESSON_CAPTION_MARKER,
  LESSON_IMAGE_CAPTION_MAX,
  applyBold,
  applyImage,
  applyLink,
  applyList,
  applyUnlink,
  buildAssetToken,
  buildCaptionLine,
  linkAtSelection,
  removeAssetToken,
  sanitizeCaption,
  escapeMarkdown,
  lessonAssetIds,
  lessonAssetObjectName,
  lessonAssetPath,
  lessonAssetRefs,
  lessonContentToPlainText,
  normalizeFormat,
  parseLessonContent,
  plainToMarkdown,
  safeLessonHref,
  sanitizeAltText,
  spliceSelection,
  validateLessonContent,
  validateLessonImageFile,
} from '../src/lib/lessonContent.js';

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const img = (alt, id) => `![${alt}](${LESSON_ASSET_SCHEME}${id})`;

/** Every href the parser would emit for a document. */
const hrefsIn = (text) => {
  const out = [];
  const walk = (tokens) => (tokens || []).forEach((t) => {
    if (t.href) out.push(t.href);
    if (t.tokens) walk(t.tokens);
  });
  for (const b of parseLessonContent(text, 'markdown')) {
    if (b.type === 'paragraph') walk(b.tokens);
    else if (b.type === 'list') b.items.forEach(walk);
  }
  return out;
};

// ── Link safety ─────────────────────────────────────────────────────────────

test('https is accepted and normalized; the host is reported from hostname', () => {
  const r = safeLessonHref('https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=sf_link');
  assert.equal(r.kind, 'external');
  assert.equal(r.host, 'docs.google.com');
  assert.match(r.href, /^https:\/\/docs\.google\.com\/forms/);
  assert.match(r.href, /usp=sf_link/, 'a query string is part of the link, not noise');
});

test('every dangerous scheme is refused, and none of them keeps an href', () => {
  const hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)  ',
    'java\nscript:alert(1)',        // WHATWG strips the newline BEFORE parsing
    'java\tscript:alert(1)',
    'java\rscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'blob:https://example.com/abc',
    'http://example.com',           // not secure
    '//evil.example/x',             // protocol-relative
    'https://docs.google.com@evil.example/x',
    'https://user:pw@evil.example/x',
  ];
  for (const raw of hostile) {
    const r = safeLessonHref(raw);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(raw)} must be refused`);
    assert.equal(r.href, null, `${JSON.stringify(raw)} must carry NO href`);
  }
});

test('a rejected scheme is never re-parsed as a relative path', () => {
  // The bug this prevents: new URL(x, base) turns 'javascript:alert(1)' into
  // 'https://host/javascript:alert(1)' — a "valid https URL" that passes every later check.
  for (const raw of ['javascript:alert(1)', 'data:text/html,x']) {
    const r = safeLessonHref(raw);
    assert.equal(r.href, null);
    assert.ok(!/^https:/.test(String(r.href)), 'no base argument may ever be introduced');
  }
});

test('same-origin destinations are allowed in their own branch', () => {
  assert.deepEqual(
    (({ kind, href }) => ({ kind, href }))(safeLessonHref('/courses/quickbooks-online-mastery')),
    { kind: 'internal', href: '/courses/quickbooks-online-mastery' },
  );
  assert.equal(safeLessonHref('#setup').kind, 'fragment');
  assert.equal(safeLessonHref('#not a fragment').kind, 'invalid');
  assert.equal(safeLessonHref('/x\\..\\y').kind, 'invalid', 'backslashes are not a path');
});

test('empty, absurd and non-string inputs are handled without throwing', () => {
  for (const raw of [null, undefined, '', '   ', {}, [], 42, true]) {
    const r = safeLessonHref(raw);
    assert.ok(['none', 'invalid'].includes(r.kind));
    assert.equal(r.href, null);
  }
  assert.equal(safeLessonHref(`https://x.example/${'a'.repeat(3000)}`).reason, 'too-long');
});

test('an unsafe link in a document reaches no href at all — the label survives as text', () => {
  const doc = 'Open the form [HERE](javascript:alert(document.cookie)) now.';
  assert.deepEqual(hrefsIn(doc), [], 'not one href may be emitted');
  assert.match(lessonContentToPlainText(doc, 'markdown'), /Open the form HERE now\./,
    'the creator still sees their words; only the link is dropped');
  const v = validateLessonContent(doc, 'markdown');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'UNSAFE_LINK'), 'and they are told why');
});

// ── No HTML, ever ───────────────────────────────────────────────────────────

test('HTML in a document stays literal text and never becomes a token', () => {
  const doc = '<script>alert(1)</script> and <img src=x onerror=alert(1)> and <b>bold?</b>';
  const blocks = parseLessonContent(doc, 'markdown');
  const flat = JSON.stringify(blocks);
  assert.ok(!/"type":"(link|image|bold)"/.test(flat), 'no HTML may become a token');
  assert.equal(lessonContentToPlainText(doc, 'markdown'), doc.replace(/\s+/g, ' ').trim(),
    'it survives as the characters the creator typed');
});

test('the parser emits only known token types', () => {
  const doc = [
    'Intro **bold** and [a link](https://x.example) and https://bare.example/p',
    '',
    '- one',
    '- two **b**',
    '',
    '1. first',
    '2. second',
    '',
    img('A screenshot', ID_A),
  ].join('\n');
  const allowed = new Set(['paragraph', 'list', 'imageBlock', 'badimageBlock', 'plain',
    'text', 'break', 'bold', 'link', 'badlink', 'image', 'badimage']);
  const walk = (tokens) => (tokens || []).forEach((t) => {
    assert.ok(allowed.has(t.type), `unexpected token type ${t.type}`);
    if (t.tokens) walk(t.tokens);
  });
  for (const b of parseLessonContent(doc, 'markdown')) {
    assert.ok(allowed.has(b.type), `unexpected block type ${b.type}`);
    if (b.type === 'paragraph') walk(b.tokens);
    if (b.type === 'list') b.items.forEach(walk);
  }
});

test('a link can never contain an image, and LessonRichText depends on that', () => {
  // ★ THIS PINS AN ASSUMPTION MADE ELSEWHERE, WHICH IS THE ONLY REASON IT IS A TEST.
  //   LessonRichText gives an external link whose visible words do not name its host an
  //   aria-label — INCLUDING when there are no visible words at all, because `[](url)`
  //   parses to a real link and would otherwise have no accessible name whatsoever.
  //   An aria-label REPLACES the contents as the accessible name, so if a link could wrap
  //   an image that label would silently eat the alt text. It cannot: `linkAt` scans for
  //   the FIRST `]`, so the inner image token's `]` closes the label and the href becomes
  //   `lesson-asset://…`, a scheme safeLessonHref refuses. The result is a badlink.
  //   If this ever stops holding, the empty-words branch in LessonRichText needs an
  //   image check — which is why this fails loudly rather than the render going quiet.
  const md = `[${img('A screenshot', ID_A)}](https://example.com/page)`;
  const [block] = parseLessonContent(md, 'markdown');
  const types = [];
  const walk = (ts) => (ts || []).forEach((t) => { types.push(t.type); if (t.tokens) walk(t.tokens); });
  walk(block.tokens);

  assert.ok(types.includes('badlink'),
    'a link label holding an image must come back refused, not as a link');
  for (const t of block.tokens) {
    if (t.type !== 'link') continue;
    const inner = [];
    (function collect(ts) { (ts || []).forEach((x) => { inner.push(x.type); if (x.tokens) collect(x.tokens); }); })(t.tokens);
    assert.ok(!inner.includes('image') && !inner.includes('badimage'),
      'no link token may carry an image — LessonRichText would override its alt text');
  }
});

// ── plain stays plain ───────────────────────────────────────────────────────

test('a plain lesson is never parsed, so nothing it contains can become formatting', () => {
  const doc = '**not bold** [not a link](https://x.example)\n- not a list\n<b>not html</b>';
  const blocks = parseLessonContent(doc, 'plain');
  assert.deepEqual(blocks, [{ type: 'plain', value: doc }]);
  assert.equal(lessonContentToPlainText(doc, 'plain'), doc,
    'byte-identical: a pre-#65 lesson must hash and chunk exactly as it did before');
});

test('normalizeFormat fails safe for anything unexpected', () => {
  assert.equal(normalizeFormat('markdown'), 'markdown');
  for (const v of ['plain', '', null, undefined, 'MARKDOWN', 'html', 42, {}]) {
    assert.equal(normalizeFormat(v), 'plain', `${JSON.stringify(v)} must fall back to plain`);
  }
  assert.deepEqual([...LESSON_CONTENT_FORMATS], ['plain', 'markdown']);
});

test('converting a plain lesson does not change what it looks like', () => {
  const samples = [
    'Sample Discovery / Onboarding Call with client',
    '1. Open the Google Form template HERE\n2. Click the 3 dots in the upper left',
    'Use the * key and the [bracket] and a ! bang',
    '- already looks like a list\n* and this one too',
    'a ** b ** c',
    'C:\\Users\\path\\to\\file',
    '100% of 3.5 items',
  ];
  for (const original of samples) {
    const converted = plainToMarkdown(original);
    assert.equal(lessonContentToPlainText(converted, 'markdown'), original,
      `converting must not change the visible text of: ${JSON.stringify(original)}`);
    assert.deepEqual(hrefsIn(converted), [], 'and must not invent links');
  }
});

test('conversion does change ONE thing, deliberately: a bare URL becomes clickable', () => {
  const converted = plainToMarkdown('Open https://forms.gle/abc123 and fill it in');
  assert.deepEqual(hrefsIn(converted), ['https://forms.gle/abc123'],
    'this is the documented, intended difference');
});

test('escapeMarkdown neutralises every token opener', () => {
  const escaped = escapeMarkdown('**x** [y](z) ![a](b) \\ backslash');
  const blocks = parseLessonContent(escaped, 'markdown');
  assert.ok(!/"type":"(bold|link|image|badlink|badimage)"/.test(JSON.stringify(blocks)));
});

// ── Asset tokens ────────────────────────────────────────────────────────────

test('asset ids are extracted in order and de-duplicated', () => {
  const doc = [img('First', ID_A), 'text', img('Second', ID_B), img('First again', ID_A)].join('\n\n');
  assert.deepEqual(lessonAssetIds(doc, 'markdown'), [ID_A, ID_B], 'distinct, in first-appearance order');
  assert.deepEqual(lessonAssetRefs(doc, 'markdown').map((r) => r.assetId), [ID_A, ID_B, ID_A],
    'refs keep every occurrence — the same screenshot may legitimately appear twice');
  assert.deepEqual(lessonAssetRefs(doc, 'markdown').map((r) => r.alt), ['First', 'Second', 'First again']);
});

test('a plain lesson cites no assets, whatever its text looks like', () => {
  assert.deepEqual(lessonAssetIds(img('x', ID_A), 'plain'), []);
});

test('an asset id is normalized to lower case, and a malformed one is not an asset', () => {
  assert.deepEqual(lessonAssetIds(img('x', ID_B.toUpperCase()), 'markdown'), [ID_B]);
  for (const bad of ['not-a-uuid', '', '1111', `${ID_A}extra`]) {
    assert.deepEqual(lessonAssetIds(`![x](${LESSON_ASSET_SCHEME}${bad})`, 'markdown'), [],
      `${bad} must not be read as an asset`);
  }
});

test('an image token cannot be smuggled past the single-reading rule', () => {
  // ']' in alt and ')' in the target are the two characters that could give a token more
  // than one reading — and the DATABASE parses these same tokens to build its reference
  // rows, so a disagreement would mean text and authorization describing different docs.
  // An alt containing ']' has no single reading, so it is NOT an asset token at all —
  // and the SQL pattern, whose alt class is [^\]\n]*, reaches the same verdict. Agreeing
  // on a refusal matters as much as agreeing on a match.
  assert.deepEqual(lessonAssetIds(`![a]b](${LESSON_ASSET_SCHEME}${ID_A})`, 'markdown'), []);
  assert.equal(new RegExp(LESSON_ASSET_TOKEN_SRC).test(`![a]b](${LESSON_ASSET_SCHEME}${ID_A})`), false);
  // Which is exactly why sanitizeAltText strips ']' before a token is ever built.
  assert.equal(sanitizeAltText('a]b'), 'ab');
  assert.deepEqual(lessonAssetIds(buildAssetToken(ID_A, 'a]b'), 'markdown'), [ID_A]);
  assert.equal(sanitizeAltText('line\none'), 'line one');
  assert.equal(sanitizeAltText('  x   y  '), 'x y');
  assert.equal(sanitizeAltText('a'.repeat(400)).length, LESSON_IMAGE_ALT_MAX);
  assert.equal(sanitizeAltText(null), '');
});

test('buildAssetToken refuses to build an unusable token', () => {
  assert.equal(buildAssetToken(ID_A, 'A screenshot'), img('A screenshot', ID_A));
  assert.equal(buildAssetToken(ID_A.toUpperCase(), 'x'), img('x', ID_A));
  for (const [id, alt] of [[ID_A, ''], [ID_A, '   '], ['nope', 'x'], [null, 'x'], [ID_A, null]]) {
    assert.equal(buildAssetToken(id, alt), '', `(${id}, ${alt}) must not build`);
  }
});

test('a remote image is refused rather than hot-linked', () => {
  const doc = '![A chart](https://tracker.example/pixel.png)';
  const blocks = parseLessonContent(doc, 'markdown');
  assert.equal(JSON.stringify(blocks).includes('tracker.example'), false,
    'the third-party URL must not survive anywhere in the parsed document');
  const v = validateLessonContent(doc, 'markdown');
  assert.ok(v.errors.some((e) => e.code === 'REMOTE_IMAGE'));
  assert.match(v.errors.find((e) => e.code === 'REMOTE_IMAGE').message, /Download the image/,
    'the creator needs to be told what to do instead');
});

test('an image alone on a line becomes its own block, so it can be a figure', () => {
  const blocks = parseLessonContent(`Intro\n\n${img('A screenshot', ID_A)}\n\nOutro`, 'markdown');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'imageBlock', 'paragraph']);
  assert.equal(blocks[1].assetId, ID_A);
  assert.equal(blocks[1].alt, 'A screenshot');
});

// ── Validation ──────────────────────────────────────────────────────────────

test('alt text is required on every image', () => {
  const v = validateLessonContent(`![](${LESSON_ASSET_SCHEME}${ID_A})`, 'markdown');
  assert.equal(v.ok, false);
  const e = v.errors.find((x) => x.code === 'IMAGE_ALT_REQUIRED');
  assert.ok(e, 'a missing description must block the save');
  assert.equal(e.assetId, ID_A, 'and must say WHICH image, so the editor can focus it');
  assert.match(e.message, /screen reader/, 'and why it matters');
});

test('the image count and document length are bounded', () => {
  const many = Array.from({ length: LESSON_IMAGE_MAX_PER_LESSON + 1 }, (_, i) =>
    img(`Shot ${i}`, `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`)).join('\n\n');
  assert.ok(validateLessonContent(many, 'markdown').errors.some((e) => e.code === 'TOO_MANY_IMAGES'));

  const long = 'a'.repeat(LESSON_CONTENT_MAX_CHARS + 1);
  assert.ok(validateLessonContent(long, 'markdown').errors.some((e) => e.code === 'TOO_LONG'));
  assert.ok(validateLessonContent(long, 'plain').errors.some((e) => e.code === 'TOO_LONG'),
    'the length bound applies to a plain lesson too — it is a column, not a format');
});

test('validation reports EVERY problem, not just the first', () => {
  const doc = [
    `![](${LESSON_ASSET_SCHEME}${ID_A})`,
    '[x](javascript:alert(1))',
    '![y](https://remote.example/a.png)',
  ].join('\n\n');
  const codes = validateLessonContent(doc, 'markdown').errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['IMAGE_ALT_REQUIRED', 'REMOTE_IMAGE', 'UNSAFE_LINK'],
    'being sent back one error at a time is how a long form becomes unusable');
});

test('an empty document is only an error when content is required', () => {
  assert.equal(validateLessonContent('', 'markdown').ok, true, 'notes are optional on a video lesson');
  const v = validateLessonContent('   ', 'markdown', { required: true });
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'EMPTY');
});

test('a token inside an escape is not a token, and does not block a save', () => {
  assert.equal(validateLessonContent('\\!\\[x\\](not-a-link)', 'markdown').ok, true);
});

// ── The AI trainer's view ───────────────────────────────────────────────────

test('the trainer text keeps link labels and image descriptions', () => {
  const doc = [
    'Sample Discovery / Onboarding Call with client',
    '',
    '1. Open the Google Form template [HERE](https://docs.google.com/forms/d/e/1FAIpQ/viewform)',
    '2. Click the **3 dots** in the upper left',
    '',
    img('Google Form menu showing the three-dot button', ID_A),
  ].join('\n');
  const out = lessonContentToPlainText(doc, 'markdown');
  assert.match(out, /Open the Google Form template HERE/, 'the label is the readable part');
  assert.match(out, /Click the 3 dots in the upper left/, 'bold is stripped, its words are kept');
  assert.match(out, /1\. /, 'step numbers carry meaning and are kept');
  assert.match(out, /Image: Google Form menu showing the three-dot button/);
});

test('NOTHING internal reaches the trainer — no ids, schemes, paths or syntax', () => {
  const doc = [
    `Read [the guide](https://x.example/g) and see ${img('The settings screen', ID_A)}`,
    '',
    '- **bold** item',
    `${img('Another', ID_B)}`,
  ].join('\n');
  const out = lessonContentToPlainText(doc, 'markdown');
  for (const forbidden of [LESSON_ASSET_SCHEME, ID_A, ID_B, 'lessons/', 'course-lesson-assets',
    '](', '![', '**', 'token=', 'X-Amz', '/object/sign/']) {
    assert.ok(!out.includes(forbidden),
      `the agent must never receive ${JSON.stringify(forbidden)} — got: ${out}`);
  }
});

test('a bare URL reads as its host, not as a spelled-out address', () => {
  const out = lessonContentToPlainText('See https://docs.google.com/forms/d/e/1FAIpQ/viewform', 'markdown');
  assert.equal(out, 'See docs.google.com', 'reading a full URL aloud is noise');
});

test('an empty document projects to an empty string, so the source is deleted not emptied', () => {
  // doSync treats falsy text as "remove this source". A projection that returned
  // whitespace for an emptied lesson would leave a stale source indexed for ever.
  for (const doc of ['', '   ', '\n\n', '**  **']) {
    assert.equal(lessonContentToPlainText(doc, 'markdown').trim(), '');
  }
});

// ── Editor helpers ──────────────────────────────────────────────────────────

test('spliceSelection replaces a selection and reports the caret', () => {
  const r = spliceSelection('hello world', 6, 11, 'there');
  assert.equal(r.text, 'hello there');
  assert.equal(r.selectionStart, 11);
  for (const [a, b] of [[-5, 99], [99, -5], [NaN, NaN], [null, undefined]]) {
    assert.equal(typeof spliceSelection('abc', a, b, 'X').text, 'string', 'must never throw');
  }
});

test('applyLink wraps the selection and selects the label for immediate editing', () => {
  const r = applyLink('Open the form HERE now', 14, 18, 'https://forms.gle/abc');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Open the form [HERE](https://forms.gle/abc) now');
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), 'HERE');
});

test('applyLink refuses an unsafe or empty URL without touching the text', () => {
  for (const bad of ['javascript:alert(1)', '', '   ', 'not a url', 'http://x.example']) {
    const r = applyLink('abc', 0, 3, bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(r.text, 'abc', 'and the draft must be left exactly as it was');
  }
});

test('applyLink with no selection still produces a usable link', () => {
  const r = applyLink('Open ', 5, 5, 'https://forms.gle/abc');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Open [forms.gle](https://forms.gle/abc)', 'the host is a sane default label');
});

test('applyImage puts the token on its own line and refuses without alt text', () => {
  const r = applyImage('Intro text', 10, 10, ID_A, 'A screenshot');
  assert.equal(r.ok, true);
  assert.equal(r.text, `Intro text\n\n${img('A screenshot', ID_A)}`);
  assert.deepEqual(lessonAssetIds(r.text, 'markdown'), [ID_A]);

  const bad = applyImage('Intro', 5, 5, ID_A, '');
  assert.equal(bad.ok, false);
  assert.equal(bad.text, 'Intro', 'an image with no description is never inserted');
});

test('applyBold and applyList transform the selection predictably', () => {
  assert.equal(applyBold('make this bold', 5, 9).text, 'make **this** bold');
  const empty = applyBold('x', 1, 1);
  assert.equal(empty.text, 'x****');
  assert.equal(empty.selectionStart, 3, 'the caret lands between the markers');

  assert.equal(applyList('one\ntwo', 0, 7, false).text, '- one\n- two');
  assert.equal(applyList('one\ntwo', 0, 7, true).text, '1. one\n2. two');
  assert.equal(applyList('- one\n- two', 0, 11, true).text, '1. one\n2. two',
    'switching list type must not double the markers');
});

// ── Uploads ─────────────────────────────────────────────────────────────────

test('SVG is refused by name AND by type', () => {
  for (const f of [{ name: 'a.svg', type: 'image/png', size: 10 },
    { name: 'a.png', type: 'image/svg+xml', size: 10 }]) {
    const r = validateLessonImageFile(f);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SVG_REFUSED', 'SVG is the one image format that is really a document');
  }
});

test('only PNG, JPEG and WebP are accepted, and the size is bounded', () => {
  assert.equal(validateLessonImageFile({ name: 'a.png', type: 'image/png', size: 1000 }).ok, true);
  assert.equal(validateLessonImageFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 }).ok, true);
  assert.equal(validateLessonImageFile({ name: 'a.webp', type: 'image/webp', size: 1000 }).ok, true);
  assert.equal(validateLessonImageFile({ name: 'a.gif', type: 'image/gif', size: 1000 }).code, 'WRONG_TYPE');
  assert.equal(validateLessonImageFile({ name: 'a.pdf', type: 'application/pdf', size: 10 }).code, 'WRONG_TYPE');
  assert.equal(validateLessonImageFile({ name: 'a.png', type: 'image/png', size: 0 }).code, 'EMPTY_FILE');
  const big = validateLessonImageFile({ name: 'a.png', type: 'image/png', size: LESSON_IMAGE_MAX_BYTES + 1 });
  assert.equal(big.code, 'TOO_LARGE');
  assert.match(big.message, /10 MB/, 'the message must state the limit the creator hit');
  assert.equal(validateLessonImageFile(null).code, 'NO_FILE');
});

test('the stored object name never reuses the creator filename', () => {
  const name = lessonAssetObjectName('image/png', ID_A);
  assert.equal(name, `${ID_A}.png`);
  assert.equal(lessonAssetObjectName('image/webp', ID_A).endsWith('.webp'), true);
  assert.equal(lessonAssetObjectName('image/jpeg', ID_A).endsWith('.jpg'), true);
  assert.ok(!lessonAssetObjectName('image/png', ID_A).includes('..'));
});

test('the object path carries course AND lesson, and the pattern fails closed', () => {
  const path = lessonAssetPath(ID_A, ID_B, lessonAssetObjectName('image/png', ID_A));
  assert.equal(path, `lessons/${ID_A}/${ID_B}/${ID_A}.png`);
  assert.ok(LESSON_ASSET_PATH_RE.test(path));
  for (const bad of [
    `lessons/${ID_A}/x.png`,                       // the VIDEO shape — two segments
    `lessons/${ID_A}/${ID_B}/sub/x.png`,           // deeper
    `covers/${ID_A}/${ID_B}/x.png`,                // another prefix
    `lessons/not-a-uuid/${ID_B}/x.png`,
    `lessons/${ID_A}/${ID_B}/`,
    `../lessons/${ID_A}/${ID_B}/x.png`,
    `lessons/${ID_A}/${ID_B}/x.png/../../y`,
  ]) {
    assert.equal(LESSON_ASSET_PATH_RE.test(bad), false, `${bad} must not parse`);
  }
});

test('the declared limits are the ones the rest of the system is built on', () => {
  assert.equal(LESSON_IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  assert.deepEqual([...LESSON_IMAGE_MIMES], ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(LESSON_IMAGE_MAX_PER_LESSON, 10);
  assert.equal(LESSON_IMAGE_ALT_MAX, 300);
  assert.equal(LESSON_CONTENT_MAX_CHARS, 20000);
});

test('a link containing parentheses keeps its real destination', () => {
  // ★ A token ends at the `)` that balances its `(`. An UNBALANCED `)` in a URL therefore
  //   closed the token early and produced a working link to a DIFFERENT address, with the
  //   rest of the URL sitting beside it as text — silently wrong, which is worse than
  //   visibly broken. applyLink percent-encodes both characters so the token has one
  //   reading; %28/%29 resolve to the same address when clicked.
  const hrefsOf = (text) => {
    const walk = (t) => (t || []).flatMap((x) => (x.href ? [x.href] : (x.tokens ? walk(x.tokens) : [])));
    return parseLessonContent(text, 'markdown').flatMap((b) => walk(b.tokens));
  };
  for (const url of [
    'https://en.wikipedia.org/wiki/Trial_balance_(accounting)',   // balanced
    'https://x.example/a)b',                                      // unbalanced close
    'https://x.example/a(b',                                      // unbalanced open
    'https://forms.gle/abc',                                      // none
  ]) {
    const r = applyLink('x', 0, 1, url);
    assert.equal(r.ok, true, url);
    const [out] = hrefsOf(r.text);
    assert.ok(out, `${url} produced no href`);
    assert.equal(decodeURIComponent(out), decodeURIComponent(url),
      `${url} must survive insertion as the same destination, got ${out}`);
  }
});

test('a link label never becomes a second link', () => {
  // ★ REACT BUILDS ELEMENTS, IT DOES NOT PARSE HTML — so unlike a browser parser it will
  //   happily nest <a> inside <a>, and a click resolves to the INNER href. That made
  //   `[Visit https://example.com for details](https://real-target.example)` send the
  //   reader to example.com, silently ignoring the destination the author chose. The link
  //   worked; it just went somewhere else. Inside a label, a URL stays text.
  const links = (tokens, inside = false) => (tokens || []).reduce((n, t) =>
    n + (t.type === 'link' ? 1 : 0) + links(t.tokens, inside || t.type === 'link'), 0);
  const nested = (tokens, inside = false) => (tokens || []).some((t) =>
    (t.type === 'link' && inside) || nested(t.tokens, inside || t.type === 'link'));

  for (const doc of [
    '[https://evil.example/x](https://ok.example/)',
    '[Visit https://example.com for details](https://real-target.example)',
    '[**bold** https://x.example label](https://ok.example/)',
  ]) {
    const tokens = parseLessonContent(doc, 'markdown')[0].tokens;
    assert.equal(nested(tokens), false, `${doc} produced a nested link`);
    assert.equal(links(tokens), 1, `${doc} must yield exactly one link`);
  }

  // A genuinely ambiguous document — brackets inside brackets — is not required to yield
  // one link, because there is no single correct reading of it. What it IS required to do
  // is never nest: it degrades into a link, literal text, and an autolinked bare URL, all
  // of which the author sees in Preview.
  const ambiguous = parseLessonContent(
    '[nested [inner](https://a.example) label](https://b.example)', 'markdown')[0].tokens;
  assert.equal(nested(ambiguous), false, 'ambiguity must never resolve into nesting');

  // A bare URL OUTSIDE a label must still autolink — the fix must not disable that.
  const mixed = parseLessonContent('[a](https://ok.example/) and https://bare.example/p', 'markdown')[0].tokens;
  assert.equal(links(mixed), 2);
  assert.equal(nested(mixed), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// An ABSENT format means plain — never markdown
// ─────────────────────────────────────────────────────────────────────────────

test('an absent content_format is read as plain, not as markdown', () => {
  // ★ THE REGRESSION THIS PINS. Five exports were written `format = 'markdown'`. A JS
  //   default fires on `undefined`, which is exactly what a row carries when the column
  //   is absent — on a pre-#65 database, and on a lesson addLesson just seeded from the
  //   frozen legacy select. So a legacy note containing an http:// link was validated as
  //   markdown, raised UNSAFE_LINK, and its save was REFUSED; and the trainer re-parsed
  //   every plain lesson, moving every hash and re-embedding a whole course for nothing.
  const legacy = 'See [the old page](http://old-site.com) and ![shot](https://cdn.example/x.png)';

  for (const absent of [undefined, null, '', 'MARKDOWN', 'rich', 0]) {
    assert.deepEqual(validateLessonContent(legacy, absent).errors, [],
      `format ${JSON.stringify(absent)} must be treated as plain, which refuses nothing`);
    assert.equal(lessonContentToPlainText(legacy, absent), legacy,
      'a plain lesson is returned byte-identical, so its content hash cannot move');
    assert.deepEqual(lessonAssetIds(img('x', ID_A), absent), [],
      'a plain lesson cites no assets, however its text reads');
    assert.deepEqual(lessonAssetRefs(img('x', ID_A), absent), []);
    assert.deepEqual(parseLessonContent(legacy, absent), [{ type: 'plain', value: legacy }]);
  }

  // And the opposite must still hold, or the feature does nothing.
  assert.ok(validateLessonContent(legacy, 'markdown').errors.length > 0);
  assert.equal(normalizeFormat(undefined), 'plain');
});

// ─────────────────────────────────────────────────────────────────────────────
// Captions
// ─────────────────────────────────────────────────────────────────────────────

const figureOf = (text) => parseLessonContent(text, 'markdown')[0];
const capText = (block) => (block.caption || []).map((t) => t.value ?? '').join('');

test('a caption is the line under an image, and it never touches the token', () => {
  const doc = `${img('Google Form menu', ID_A)}\n${LESSON_CAPTION_MARKER}Figure 1 — the three-dot button`;
  const block = figureOf(doc);
  assert.equal(block.type, 'imageBlock');
  assert.equal(block.assetId, ID_A);
  assert.equal(block.alt, 'Google Form menu', 'alt stays the screen-reader text');
  assert.equal(capText(block), 'Figure 1 — the three-dot button');

  // ★ THE INVARIANT THE WHOLE DESIGN RESTS ON: the database's token regex cannot see a
  //   caption, so adding one needs no migration and cannot desynchronise the two parsers.
  const tokens = new RegExp(LESSON_ASSET_TOKEN_SRC, 'g');
  assert.deepEqual(doc.match(tokens), [img('Google Form menu', ID_A)],
    'exactly one token, and the caption line is not part of it');
  assert.deepEqual(lessonAssetIds(doc, 'markdown'), [ID_A], 'still one reference, not two');
});

test('an image with no caption is still a figure, and a caption is optional', () => {
  const block = figureOf(img('Alone', ID_A));
  assert.equal(block.type, 'imageBlock');
  assert.equal(block.caption, undefined);
});

test('a caption marker in ordinary prose stays literal text', () => {
  // The marker only means "caption" directly under an image. Anywhere else a creator
  // typed it, and silently eating their line would be worse than printing it.
  const prose = parseLessonContent(`Look up\n${LESSON_CAPTION_MARKER}at the arrow`, 'markdown')[0];
  assert.equal(prose.type, 'paragraph');
  assert.match(prose.tokens.map((t) => t.value ?? '').join(''), /\^ at the arrow/);

  const orphan = parseLessonContent(`${LESSON_CAPTION_MARKER}no image above me`, 'markdown')[0];
  assert.equal(orphan.type, 'paragraph');
});

test('a second caption line degrades visibly instead of attaching twice', () => {
  const doc = `${img('A', ID_A)}\n${LESSON_CAPTION_MARKER}one\n${LESSON_CAPTION_MARKER}two`;
  const block = figureOf(doc);
  assert.equal(block.type, 'paragraph', 'the creator sees both lines as text and can fix it');
});

test('a caption may not smuggle in an image token', () => {
  // It would render inside the figcaption while the database still counted it as a
  // reference — a picture nobody can see holding one of the ten slots.
  assert.equal(buildCaptionLine(`see ${img('x', ID_B)}`), '');
  const doc = `${img('A', ID_A)}\n${LESSON_CAPTION_MARKER}${img('B', ID_B)}`;
  assert.equal(figureOf(doc).type, 'paragraph', 'not a caption, so both images render');
});

test('captions are bounded, flattened and carried to the AI trainer', () => {
  assert.equal(sanitizeCaption('  two\nlines  '), 'two lines');
  assert.equal(sanitizeCaption('x'.repeat(LESSON_IMAGE_CAPTION_MAX + 50)).length, LESSON_IMAGE_CAPTION_MAX);
  assert.equal(buildCaptionLine('   '), '', 'a blank caption emits no line at all');

  const doc = `${img('Google Form menu', ID_A)}\n${LESSON_CAPTION_MARKER}Figure 1`;
  const spoken = lessonContentToPlainText(doc, 'markdown');
  assert.equal(spoken, 'Image: Google Form menu — Figure 1');
  for (const leak of ['lesson-asset://', ID_A, '![', '](', LESSON_CAPTION_MARKER.trim()]) {
    assert.ok(!spoken.includes(leak), `the agent must never receive ${leak}`);
  }

  const long = `${img('A', ID_A)}\n${LESSON_CAPTION_MARKER}${'y'.repeat(LESSON_IMAGE_CAPTION_MAX + 1)}`;
  assert.ok(validateLessonContent(long, 'markdown').errors.some((e) => e.code === 'CAPTION_TOO_LONG'));
});

test('an unsafe link inside a caption blocks the save like any other', () => {
  const doc = `${img('A', ID_A)}\n${LESSON_CAPTION_MARKER}see [here](javascript:alert(1))`;
  const codes = validateLessonContent(doc, 'markdown').errors.map((e) => e.code);
  assert.ok(codes.includes('UNSAFE_LINK'), 'a caption is rendered prose, so it is validated prose');
});

test('applyImage writes the caption as the very next line', () => {
  const r = applyImage('Intro', 5, 5, ID_A, 'A screenshot', 'Figure 1');
  assert.equal(r.ok, true);
  assert.equal(r.text, `Intro\n\n${img('A screenshot', ID_A)}\n${LESSON_CAPTION_MARKER}Figure 1`);
  // A blank line between them would end the block and make the caption a paragraph.
  assert.ok(!r.text.includes(`)\n\n${LESSON_CAPTION_MARKER}`));
  assert.equal(capText(parseLessonContent(r.text, 'markdown')[1]), 'Figure 1');

  const none = applyImage('Intro', 5, 5, ID_A, 'A screenshot', '');
  assert.equal(none.text, `Intro\n\n${img('A screenshot', ID_A)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Removing an image from a document
// ─────────────────────────────────────────────────────────────────────────────

test('removeAssetToken takes the image and its caption, and nothing else', () => {
  // ★ WHY. Removing an image deleted its row and its bytes but left the token in the
  //   text. References are only derived on SAVE, so LESSON_ASSET_IN_USE could not fire,
  //   and the next save died on LESSON_ASSET_UNKNOWN_REF with no way out but hand-editing
  //   a raw token out of a textarea.
  const doc = [
    'Intro here.', '',
    img('Menu', ID_A), `${LESSON_CAPTION_MARKER}Figure 1`, '',
    'Middle text.', '',
    img('Other', ID_B), '',
    'End.',
  ].join('\n');

  const r = removeAssetToken(doc, ID_A);
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1);
  assert.ok(!r.text.includes(ID_A), 'the token is gone');
  assert.ok(!r.text.includes('Figure 1'), 'and so is the caption that described it');
  assert.deepEqual(lessonAssetIds(r.text, 'markdown'), [ID_B], 'the other image is untouched');
  assert.ok(!/\n{3,}/.test(r.text), 'no crater of blank lines is left behind');
  assert.match(r.text, /Intro here\.\n\nMiddle text\./);

  // Uppercase in the stored id must still match — the token parser lowercases it.
  assert.equal(removeAssetToken(doc, ID_A.toUpperCase()).removed, 1);
});

test('removeAssetToken leaves a sentence intact when the image was inline', () => {
  const r = removeAssetToken(`See ${img('x', ID_A)} here`, ID_A);
  assert.equal(r.text, 'See  here', 'the line survives because it held more than the image');
});

test('removeAssetToken refuses an unknown or malformed id rather than guessing', () => {
  const doc = img('Menu', ID_A);
  for (const id of [ID_B, '', null, 'not-a-uuid', undefined]) {
    const r = removeAssetToken(doc, id);
    assert.equal(r.removed, 0);
    assert.equal(r.text, doc, 'the document is returned untouched');
    assert.equal(r.ok, false);
  }
});

test('removeAssetToken removes every copy of the same image', () => {
  const doc = `${img('a', ID_A)}\n\nmid\n\n${img('a again', ID_A)}`;
  const r = removeAssetToken(doc, ID_A);
  assert.equal(r.removed, 2);
  assert.deepEqual(lessonAssetIds(r.text, 'markdown'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Editing and removing an existing link
// ─────────────────────────────────────────────────────────────────────────────

const LINKED = 'Open the [form](https://forms.example/a) now';

test('linkAtSelection finds the link the caret is inside', () => {
  const found = linkAtSelection(LINKED, 12, 12);
  assert.deepEqual(found, { start: 9, end: 40, label: 'form', url: 'https://forms.example/a' });
  assert.equal(LINKED.slice(found.start, found.end), '[form](https://forms.example/a)');

  assert.equal(linkAtSelection(LINKED, 2, 2), null, 'outside the token there is no link');
  assert.equal(linkAtSelection(LINKED, 0, LINKED.length), null, 'a selection wider than the token is not inside it');
  assert.equal(linkAtSelection('', 0, 0), null);
  assert.equal(linkAtSelection(null, 0, 0), null);
});

test('linkAtSelection never mistakes an image or an escape for a link', () => {
  assert.equal(linkAtSelection(img('a', ID_A), 3, 3), null, 'an image is not a link');
  assert.equal(linkAtSelection('\\[not a link](https://x.example)', 3, 3), null,
    'an escaped bracket opens nothing');
});

test('editing a link replaces the whole token instead of wrapping it', () => {
  // ★ THE BUG. Selecting the rendered words and pressing Ctrl+K again wrapped the entire
  //   existing token in a new one and produced `[form(https://forms.example/a)](https://new…)`
  //   — a link whose visible text is somebody else's raw markdown.
  const found = linkAtSelection(LINKED, 12, 12);
  const edited = applyLink(LINKED, found.start, found.end, 'https://new.example/z', { label: 'form' });
  assert.equal(edited.ok, true);
  assert.equal(edited.text, 'Open the [form](https://new.example/z) now');
  assert.equal(linkAtSelection(edited.text, 12, 12).url, 'https://new.example/z');
});

test('unlink leaves the words and takes the address', () => {
  const r = applyUnlink(LINKED, 12, 12);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Open the form now');
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), 'form', 'the freed words stay selected');

  const miss = applyUnlink('no link here', 4, 4);
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'no-link');
  assert.equal(miss.text, 'no link here', 'a miss changes nothing');
});

test('an asset scheme that is not a readable token blocks the save', () => {
  // ★ THE WORST FAILURE THIS MODULE CAN HAVE, AND IT WAS SILENT IN THREE PLACES AT ONCE.
  //   Everything validation knows about images comes from the token pattern, so a
  //   `lesson-asset://<uuid>` that pattern cannot read was invisible: the document saved
  //   clean, the raw markdown went to every student, the post-save sweep saw the asset as
  //   uncited and DELETED its row and its bytes — course_lesson_asset_delete cannot answer
  //   IN_USE when the trigger derived no reference — and the flattener passed the scheme and
  //   the uuid straight into the AI trainer's index.
  const broken = `![Screenshot [1]](${LESSON_ASSET_SCHEME}${ID_A})`;   // one "]" is enough
  const verdict = validateLessonContent(broken, 'markdown');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.code === 'BROKEN_IMAGE_REFERENCE'));
  assert.deepEqual(lessonAssetIds(broken, 'markdown'), [],
    'the premise: the sweep would see this asset as uncited');

  // Half a hand-deleted token leaves the same stranded scheme.
  assert.ok(validateLessonContent(`see (${LESSON_ASSET_SCHEME}${ID_A}) here`, 'markdown')
    .errors.some((e) => e.code === 'BROKEN_IMAGE_REFERENCE'));

  // An ESCAPED token is refused too, though by a different route: `\!` makes the rest parse
  // as a link whose target is not https. What matters is that it cannot save silently — the
  // student would otherwise read the raw markup either way.
  assert.equal(validateLessonContent(`\\![alt](${LESSON_ASSET_SCHEME}${ID_A})`, 'markdown').ok, false);

  // ★ NO FALSE POSITIVES. Counting works because every readable token carries the scheme
  //   exactly once, so a valid document — including the same picture used twice — balances.
  assert.equal(validateLessonContent(img('Menu', ID_A), 'markdown').ok, true);
  const twice = `${img('Menu', ID_A)}\n\n${img('Menu again', ID_A)}`;
  assert.equal(validateLessonContent(twice, 'markdown').ok, true);
  assert.equal(validateLessonContent(`${img('A', ID_A)}\n${LESSON_CAPTION_MARKER}cap`, 'markdown').ok, true,
    'a caption line does not disturb the count');
  assert.equal(validateLessonContent(`nothing to do with images`, 'markdown').ok, true);
});

test('a multi-line selection cannot make a link no reader accepts', () => {
  // linkAt and scanLinks both refuse a label containing a newline, so carrying one into a
  // token produced markdown that validated clean and rendered as literal brackets around an
  // autolinked URL — the creator's only way out being to hand-edit raw markup.
  const r = applyLink('line one\nline two', 0, 17, 'https://x.example');
  assert.equal(r.ok, true);
  assert.equal(r.text, '[line one line two](https://x.example/)');
  assert.ok(!r.text.includes('\n'), 'the label is one line');
  const tokens = parseLessonContent(r.text, 'markdown')[0].tokens;
  assert.equal(tokens.filter((t) => t.type === 'link').length, 1, 'and it reads back as ONE link');
  assert.equal(linkAtSelection(r.text, 2, 2).url, 'https://x.example/');
});

test('an edited link is still refused when the new address is unsafe', () => {
  const found = linkAtSelection(LINKED, 12, 12);
  const bad = applyLink(LINKED, found.start, found.end, 'javascript:alert(1)', { label: 'form' });
  assert.equal(bad.ok, false);
  assert.equal(bad.text, LINKED, 'the document is untouched by a refused edit');
});
