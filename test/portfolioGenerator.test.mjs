// test/portfolioGenerator.test.mjs — the Bookkeeper Portfolio Generator engine.
//
// ★ WHY THIS SUITE EXISTS. This tool emits an HTML file the student then HOSTS.
//   Everything user-typed in it — a name, a headline, a calendar link, a photo —
//   ends up as markup on a public page, and the standalone artifact this was
//   ported from got that wrong in four separate ways at once:
//
//     · its esc() escaped `& < > "` and NOT `:`, so a CTA of "javascript:alert(1)"
//       landed verbatim in four hrefs — stored XSS against the bookkeeper's own
//       prospects, in a file they published themselves;
//     · the photo was interpolated into src="${d.photo}" with no escaping at all;
//     · its phone handler turned "+1 (555) 123-4567 ext. 89" into
//       tel:+1555123456789 — a wrong number a visitor silently dials;
//     · and its sample cash-flow statement did not tie out, under a footnote
//       calling the figures "internally consistent", for an audience of
//       accountants.
//
//   Assertions target stable `reason`/`kind` codes, never the `message` prose, so
//   the copy can be reworded without touching this suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PF_EDITOR_MIN,
  PF_EDITOR_MAX,
  PF_PREVIEW_MIN,
  PF_COL_GAP,
  PF_TWO_PANE_MIN,
  PF_LOGICAL_WIDTHS,
  PF_PHOTO_MAX_BASE64,
  FALLBACK_THEME,
  PORTFOLIO_SECTIONS,
  buildPortfolioHtml,
  contrastRatio,
  draftCompletion,
  draftHasContent,
  emptyDraft,
  escapeHtml,
  financialSampleRows,
  isSafePhotoDataUrl,
  isTheme,
  mailtoHref,
  metricSuffix,
  money,
  normalizeDraft,
  onPanelGlow,
  parseResumeLines,
  parseStoredDraft,
  portfolioFileName,
  resolveTheme,
  safeLinkHref,
  sampleFieldsStillPresent,
  telHref,
  themeCssVars,
  validateDraft,
} from '../src/lib/portfolioGenerator.js';
import {
  PORTFOLIO_INDUSTRIES,
  PORTFOLIO_THEMES,
  PORTFOLIO_THEME_ORDER,
  SAMPLE_DRAFT,
} from '../src/data/portfolio-generator.js';

const B64 = 'QUJDRA==';
const PNG = `data:image/png;base64,${B64}`;
const download = (draft, extra) => buildPortfolioHtml(draft, { mode: 'download', year: 2026, ...extra });
const preview = (draft, extra) => buildPortfolioHtml(draft, { mode: 'preview', year: 2026, ...extra });
const navBlock = (html) => (/<div class="links">([\s\S]*?)<\/div>/.exec(html) || [, ''])[1];

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = () => readFileSync(join(REPO, 'src/index.css'), 'utf8');
/** The .pf-tool block only, so a rule elsewhere in the sheet cannot satisfy a test. */
const pfCss = () => {
  const sheet = css();
  const at = sheet.indexOf('PORTFOLIO GENERATOR (.pf-tool)');
  assert.ok(at > 0, 'the .pf-tool block is missing from src/index.css');
  return sheet.slice(at);
};
/**
 * One rule's body, by selector, inside the .pf-tool block, with CSS comments removed.
 *
 * ★ Stripping comments is necessary, not tidy. The .pf-preview rule carries a comment
 *   EXPLAINING why it must not declare `display: flex`, and a scan for that hazard
 *   matched the sentence warning about it — the same way a comment about localStorage
 *   tripped the network scan in section 11.
 */
const rule = (selector) => {
  const sheet = pfCss();
  const at = sheet.indexOf(`\n${selector} {`);
  assert.ok(at > 0, `${selector} was not found in the .pf-tool block`);
  return sheet.slice(at, sheet.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, ' ');
};

// ── 1. The draft shape is total ─────────────────────────────────────────────
//
// normalizeDraft is the single choke point for window.storage, the résumé parser
// and the shipped example. If it can return a partial object the builder throws
// mid-template and the whole preview goes blank with no error the user can act on.

test('emptyDraft returns every field the builder reads', () => {
  const d = emptyDraft();
  for (const key of ['theme', 'industry', 'fullName', 'credentials', 'title', 'location',
    'email', 'phone', 'website', 'photo', 'heroHeadline', 'heroSub', 'ctaText', 'ctaLink',
    'painPoints', 'transformations', 'summary', 'services', 'packages', 'tools', 'industries',
    'metrics', 'testimonials', 'education', 'showSamples', 'sampleCompany', 'samplePeriod']) {
    assert.ok(key in d, `${key} is missing — the builder would read undefined and throw`);
  }
});

test('normalizeDraft coerces every junk input to a complete draft', () => {
  const shape = Object.keys(emptyDraft()).sort();
  for (const input of [null, undefined, '', 0, false, [], [1, 2], 'a string', 42, NaN,
    { nested: { deep: true } }, () => {}]) {
    const d = normalizeDraft(input);
    assert.deepEqual(Object.keys(d).sort(), shape,
      `${JSON.stringify(input)} produced a partial draft — the builder throws on the first missing list`);
  }
});

test('a list field holding the wrong type becomes an empty list, never a crash', () => {
  for (const key of ['painPoints', 'transformations', 'services', 'packages', 'tools',
    'industries', 'metrics', 'testimonials', 'education']) {
    for (const junk of [5, 'text', {}, true, null]) {
      const d = normalizeDraft({ [key]: junk });
      assert.ok(Array.isArray(d[key]), `${key} = ${JSON.stringify(junk)} must still be an array`);
      assert.equal(d[key].length, 0, `${key} = ${JSON.stringify(junk)} must be empty, not fabricated`);
    }
  }
});

test('packages[].features survives a number, a null and a nested array', () => {
  const d = normalizeDraft({ packages: [{ features: 5 }, { features: null }, { features: [['a'], 'b'] }] });
  assert.equal(d.packages.length, 3);
  for (const p of d.packages) {
    assert.ok(Array.isArray(p.features), 'the builder calls .filter(f => f.trim()) on this');
    for (const f of p.features) {
      assert.equal(typeof f, 'string', 'a non-string feature reaches .trim() and throws');
    }
  }
});

test('tools[].level clamps to 10..100 and rounds', () => {
  // A non-finite level is not a big number, it is a missing one: it takes the
  // default rather than clamping to 100, because 75 is a believable placeholder
  // and 100 would be a claim the draft never made.
  const cases = [[-50, 10], [0, 10], [9, 10], [10, 10], [75.6, 76], [100, 100], [9999, 100],
    [Infinity, 75], [-Infinity, 75], [NaN, 75], ['80', 80], [null, 75], [undefined, 75]];
  for (const [input, want] of cases) {
    const d = normalizeDraft({ tools: [{ name: 'x', level: input }] });
    assert.equal(d.tools[0].level, want,
      `level ${JSON.stringify(input)} lands in a CSS custom property and a width — it must be a sane integer`);
  }
});

test('metrics[].value coerces to a finite number', () => {
  for (const [input, want] of [[Infinity, 0], [-Infinity, 0], [NaN, 0], ['1000', 1000],
    [null, 0], [undefined, 0], [{}, 0], [12.7, 13], [1e15, 1e12], [-1e15, -1e12]]) {
    const d = normalizeDraft({ metrics: [{ value: input }] });
    assert.equal(d.metrics[0].value, want,
      `value ${JSON.stringify(input)} becomes a data-count attribute the counter animates`);
  }
});

test('an unsafe photo is DROPPED by normalizeDraft, not carried', () => {
  for (const bad of [`data:image/svg+xml;base64,${B64}`, `data:text/html;base64,${B64}`,
    'javascript:alert(1)', 'data:image/png,%3Csvg%3E', 'https://evil.example/x.png', '  ', 'x']) {
    assert.equal(normalizeDraft({ photo: bad }).photo, '',
      `${JSON.stringify(bad)} must never reach the renderer — there is nothing for it to bind to`);
  }
  assert.equal(normalizeDraft({ photo: PNG }).photo, PNG, 'a valid re-encoded photo must survive');
});

test('normalizeDraft never mutates its input', () => {
  const input = { fullName: 'A', tools: [{ name: 'x', level: 9999 }], packages: [{ features: 5 }] };
  const snapshot = JSON.stringify(input);
  normalizeDraft(input);
  assert.equal(JSON.stringify(input), snapshot,
    'the editor holds this object in React state — mutating it desyncs the UI from the preview');
});

test('control characters are stripped from every text field', () => {
  const d = normalizeDraft({ fullName: 'Jor\u0000dan\u001f Reyes' });
  assert.equal(d.fullName, 'Jordan Reyes', 'a NUL in a name breaks the generated document silently');
});

test('SAMPLE_DRAFT normalizes to itself — the shipped example cannot be a broken draft', () => {
  const once = normalizeDraft(SAMPLE_DRAFT);
  assert.deepEqual(normalizeDraft(once), once,
    'if the example needs coercing, what a student sees after "Load example" is not what the file holds');
});

test('every shipped theme satisfies isTheme, so no theme can emit broken CSS', () => {
  const keys = Object.keys(PORTFOLIO_THEMES);
  assert.equal(keys.length, 9, 'nine themes ship; the artifact\'s own comment said six and defined nine');
  for (const key of keys) {
    assert.ok(isTheme(PORTFOLIO_THEMES[key]),
      `${key} is malformed — theme values are the only user-selected data that reaches a <style> block`);
    assert.equal(PORTFOLIO_THEMES[key].key, key, `${key}.key must match its map key`);
  }
  assert.deepEqual([...PORTFOLIO_THEME_ORDER].sort(), [...keys].sort(),
    'the swatch order must name every theme exactly once, or a theme is unreachable in the UI');
});

test('isTheme rejects anything that could inject CSS', () => {
  const base = PORTFOLIO_THEMES.navy;
  for (const bad of [null, undefined, 'navy', 42, {}, { ...base, accent: 'red' },
    { ...base, accent: '#fff' }, { ...base, accent: '#12345g' },
    { ...base, accent: '#000; } body { display:none' }, { ...base, mode: 'sepia' },
    { ...base, name: '' }]) {
    assert.equal(isTheme(bad), false, `${JSON.stringify(bad)?.slice(0, 60)} must not pass as a theme`);
  }
});

test('every industry preset has pain points and before/after transformations', () => {
  assert.equal(PORTFOLIO_INDUSTRIES.length, 10, 'ten industry libraries ship');
  const keys = new Set();
  for (const ind of PORTFOLIO_INDUSTRIES) {
    assert.ok(ind.key && ind.label, 'an industry needs a stable key and a visible label');
    assert.ok(!keys.has(ind.key), `${ind.key} is duplicated — a preset would be unreachable`);
    keys.add(ind.key);
    assert.ok(ind.pains.length >= 3, `${ind.key} has too few pain points to fill the band`);
    assert.ok(ind.transforms.length >= 3, `${ind.key} has too few transformations`);
    for (const t of ind.transforms) {
      assert.ok(t.before && t.after, `${ind.key} has a half-empty transformation, which renders as a blank card`);
    }
  }
});

// ── 2. Stored-draft recovery ────────────────────────────────────────────────

test('a null, blank or non-JSON stored value yields the empty draft and recovered:false', () => {
  for (const raw of [null, undefined, '', '   ', 'not json', '{oops', '<html>', 42]) {
    const r = parseStoredDraft(raw);
    assert.deepEqual(r.draft, emptyDraft(), `${JSON.stringify(raw)} must not produce a partial draft`);
    assert.equal(r.recovered, false,
      'recovered:false is what tells the caller NOT to overwrite whatever is on disk');
  }
});

test('JSON that is an array, a number or a string yields the empty draft', () => {
  for (const raw of ['[]', '[1,2,3]', '42', '"hello"', 'null', 'true']) {
    const r = parseStoredDraft(raw);
    assert.equal(r.recovered, false, `${raw} is valid JSON but not a draft`);
  }
});

test('a stored draft round-trips, and a wrapper envelope is unwrapped', () => {
  const draft = normalizeDraft({ ...SAMPLE_DRAFT, fullName: 'Restored Person' });
  const bare = parseStoredDraft(JSON.stringify(draft));
  assert.equal(bare.recovered, true);
  assert.deepEqual(bare.draft, draft, 'a bare draft must survive a save/load cycle byte for byte');
  const wrapped = parseStoredDraft(JSON.stringify({ v: 1, savedAt: 'x', draft }));
  assert.equal(wrapped.recovered, true, 'an envelope is the shape CourseProgram\'s drafts use');
  assert.deepEqual(wrapped.draft, draft);
});

test('a stored draft whose photo is an SVG comes back with photo:"" and photo in dropped', () => {
  const r = parseStoredDraft(JSON.stringify({ fullName: 'A', photo: `data:image/svg+xml;base64,${B64}` }));
  assert.equal(r.recovered, true, 'the rest of the draft is still good and must be restored');
  assert.equal(r.draft.photo, '');
  assert.deepEqual(r.dropped, ['photo'],
    'the user must be told their photo did not come back, not silently shown a portfolio without it');
});

test('an older draft missing fields this build reads is filled, not rejected', () => {
  const r = parseStoredDraft(JSON.stringify({ fullName: 'A', title: 'B' }));
  assert.equal(r.recovered, true, 'a draft from a build with fewer fields is still the user\'s work');
  assert.deepEqual(r.draft.services, []);
  assert.equal(r.draft.ctaText, emptyDraft().ctaText, 'a missing default must be restored, not left blank');
});

// ── 3. Link safety ──────────────────────────────────────────────────────────
//
// The `ctaLink` field is the artifact's live XSS: esc() never touched `:`, so
// "javascript:…" reached four hrefs. safeLinkHref is the only authority now.

test('every scheme that is not https is rejected', () => {
  const table = [
    ['javascript:alert(1)', 'not-https'],
    ['JaVaScRiPt:alert(1)', 'not-https'],
    ['vbscript:msgbox(1)', 'not-https'],
    ['data:text/html,<script>alert(1)</script>', 'not-https'],
    ['blob:https://evil.example/uuid', 'not-https'],
    ['file:///C:/Windows/win.ini', 'not-https'],
    ['about:blank', 'not-https'],
    ['mailto:x@y.com', 'not-https'],
    ['tel:+15551234567', 'not-https'],
    ['ftp://evil.example/x', 'not-https'],
    ['http://calendly.com/x', 'insecure'],
  ];
  for (const [raw, reason] of table) {
    const r = safeLinkHref(raw);
    assert.equal(r.kind, 'invalid', `${raw} must never reach an href`);
    assert.equal(r.reason, reason, `${raw} should report ${reason}`);
    assert.equal(r.href, null, 'an invalid result must carry no href for the template to bind');
  }
});

test('a control character inside the scheme cannot smuggle javascript: past the parser', () => {
  // ★ WHATWG strips tab, LF and CR BEFORE parsing, so a /^javascript:/ guard on
  //   the raw string reads "java\nscript:" as harmless and lets it through.
  for (const raw of ['java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
    '  javascript:alert(1)', '\njavascript:alert(1)', 'java\t\n\rscript:alert(1)']) {
    const r = safeLinkHref(raw);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(raw)} parses as javascript: and must be refused`);
    assert.equal(r.reason, 'not-https');
  }
});

test('credentials are rejected, including the trustworthy-looking phishing shape', () => {
  for (const raw of ['https://user:pass@evil.example', 'https://calendly.com@evil.example',
    'https://linkedin.com@evil.example/in/someone', 'https://:pass@evil.example']) {
    const r = safeLinkHref(raw);
    assert.equal(r.reason, 'credentials',
      `${raw} puts a recognisable name where the username goes — that is the entire trick`);
    assert.equal(r.href, null);
  }
});

test('a bare domain is retried as https and the retry re-runs every check', () => {
  const r = safeLinkHref('calendly.com/alex');
  assert.equal(r.kind, 'external', 'without a retry every user who types a bare domain gets a dead CTA');
  assert.equal(r.href, 'https://calendly.com/alex');
  assert.equal(r.upgraded, true, 'the UI shows the upgrade so the user is not surprised by the scheme');
  // The artifact's own sample data shipped exactly this shape.
  assert.equal(safeLinkHref('linkedin.com/in/yourname').href, 'https://linkedin.com/in/yourname');
});

test('the https retry never fires on a value that PARSED with a rejected scheme', () => {
  // ★ Retrying unconditionally would turn "javascript:alert(1)" into
  //   "https://javascript:alert(1)", which parses and would be accepted.
  for (const raw of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', 'http://x.example']) {
    const r = safeLinkHref(raw);
    assert.equal(r.kind, 'invalid', `${raw} must not be rescued by the retry`);
    assert.equal(r.upgraded, false, `${raw} must not be reported as upgraded`);
  }
});

test('a retried value must still resolve to a real host', () => {
  for (const raw of ['/etc/passwd', 'not a url at all', 'https://', '::::', 'localhost']) {
    const r = safeLinkHref(raw);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(raw)} has no host and must be refused`);
  }
});

test('a fragment is its own branch and only a real element id passes', () => {
  assert.equal(safeLinkHref('#services').kind, 'fragment');
  assert.equal(safeLinkHref('#services').href, '#services');
  for (const raw of ['#', '#javascript:alert(1)', '#a b', '#"onload="x', '#1abc', '#<script>']) {
    const r = safeLinkHref(raw);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(raw)} is not a usable element id`);
    assert.equal(r.reason, 'bad-fragment');
  }
});

test('the returned href is always url.href, never the raw input', () => {
  const r = safeLinkHref('https://example.com/">' + '<script>alert(1)</script>');
  assert.equal(r.kind, 'external');
  assert.ok(!/["<>]/.test(r.href),
    'normalization is what percent-encodes the quote and the angle brackets: ' + r.href);
  assert.equal(safeLinkHref('HTTPS://EXAMPLE.COM').href, 'https://example.com/',
    'an uppercase scheme must be folded, or a case-sensitive comparison elsewhere disagrees');
});

test('query and fragment are preserved exactly — a Calendly link carries both', () => {
  const r = safeLinkHref('https://calendly.com/jordan/30min?month=2026-09#pick');
  assert.equal(r.href, 'https://calendly.com/jordan/30min?month=2026-09#pick');
});

test('host is url.hostname, so a port never changes the verdict', () => {
  const r = safeLinkHref('https://us02web.zoom.us:8443/j/1');
  assert.equal(r.kind, 'external');
  assert.equal(r.host, 'us02web.zoom.us', 'url.host would carry :8443 and break any host comparison');
});

test('a protocol-relative link resolves to the host the user typed', () => {
  // Not a hole: the editor renders result.host beside the field, so what the
  // user reads is the host their visitors reach.
  assert.equal(safeLinkHref('//evil.example').host, 'evil.example');
  assert.equal(safeLinkHref('//a.example\\@b.example').host, 'a.example');
});

test('an over-long URL is refused before it is parsed', () => {
  const r = safeLinkHref(`https://example.com/${'x'.repeat(4096)}`);
  assert.equal(r.reason, 'too-long');
  assert.equal(r.href, null);
});

test('empty and non-string values read as absent, not as errors', () => {
  for (const raw of [null, undefined, '', '   ', {}, []]) {
    const r = safeLinkHref(raw);
    assert.equal(r.kind, 'none', `${JSON.stringify(raw)} is an empty optional field, not a mistake`);
    assert.equal(r.reason, null, 'an untouched field must never show a validation error');
  }
});

test('mailtoHref rejects mail-header injection — there is nothing to inject into', () => {
  // ★ The threat here is not XSS. "?bcc=" pre-fills the VISITOR's mail client
  //   with a hidden recipient, and escapeHtml would pass it through untouched.
  // ★ THE PERCENT PAYLOADS BELONG ON THE LOCAL SIDE OF THE `@`, and getting that wrong
  //   is why this test passed for a broken validator. The original payload here was
  //   'x@y.com%0d%0aBcc:a@evil' — on the DOMAIN side, where neither `%` nor `:` is in the
  //   charset and the trailing 'a@evil' adds a second `@`. It was rejected for three
  //   reasons unrelated to percent-encoding, so it never exercised the branch it named.
  //   Moved to the local part, the identical payload was ACCEPTED: the charset allowed
  //   `%`, and `mailto:${value}` interpolates raw, so
  //   'x%0D%0ABcc%3A%20a%40evil.example@y.com' decoded to
  //   'mailto:x<CR><LF>Bcc: a@evil.example@y.com' in the published file.
  for (const bad of ['x@y.com?subject=hi&bcc=attacker@evil.example', 'x@y.com%0d%0aBcc:a@evil',
    'x@y.com\r\nBcc: a@evil', 'x@y.com,z@evil.example', 'x@y.com;z@evil.example',
    '"><img src=x onerror=alert(1)>@y.com', 'x@y.com?', 'notanemail', 'x@', '@y.com',
    'x y@z.com', 'x@y', `${'a'.repeat(300)}@y.com`,
    // local-part percent payloads — the cases the domain-side version could not reach
    'x%0D%0ABcc%3A%20a%40evil.example@y.com', 'x%0d%0aBcc%3Aa%40evil.example@y.com',
    'x%3Fbcc%3Da%40evil.example@y.com', 'x%26bcc%3Da%40evil.example@y.com',
    'x%2Cz%40evil.example@y.com', 'x%3Bz%40evil.example@y.com',
    'alex%zz%@y.com', 'x%25%30%44@y.com', 'plain%percent@y.com']) {
    const r = mailtoHref(bad);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(bad)} must not become a mailto href`);
    assert.equal(r.href, null);
  }
  // And the invariant stated in the doc comment, asserted directly rather than by example:
  // no accepted address may contain a character that could open a second header.
  for (const ch of ['%', '?', '&', ',', ';', ':', '\r', '\n', ' ', '"', '<', '>']) {
    const r = mailtoHref(`a${ch}b@y.com`);
    assert.equal(r.kind, 'invalid', `a local part containing ${JSON.stringify(ch)} must be refused`);
  }
});

test('a hostile résumé email is SKIPPED, never salvaged into a valid one', () => {
  // ★ The tempting fix — narrowing the importer's extraction regex to mirror EMAIL_RE —
  //   is WORSE, and measurably so. Without `%` in the extraction class the match starts
  //   after the last percent and yields '40evil.example@y.com': a perfectly valid address
  //   on the attacker's domain, which the validator then happily accepts as the student's
  //   own contact email. Extract greedily, validate strictly.
  const out = parseResumeLines([
    'Jane Doe', 'Senior Bookkeeper',
    'x%0D%0ABcc%3A%20a%40evil.example@y.com', '(555) 010-4477',
  ]);
  assert.equal(out.patch.email, undefined, 'the hostile token must not become an email');
  assert.equal(out.applied.includes('email'), false, 'and must not be reported as applied');
  const emitted = JSON.stringify(out.patch);
  assert.equal(emitted.includes('evil.example'), false,
    'no part of the attacker domain may survive anywhere in the patch');
});

test('mailtoHref accepts a plain address unencoded', () => {
  const r = mailtoHref('jordan.reyes+books@example.co.uk');
  assert.equal(r.href, 'mailto:jordan.reyes+books@example.co.uk',
    'encodeURIComponent would turn the @ into %40 and the visible label into noise');
  assert.equal(r.label, 'jordan.reyes+books@example.co.uk');
  assert.equal(mailtoHref('').kind, 'none', 'an empty email is an empty optional field');
});

test('telHref keeps one leading + and 7..15 digits, and returns NO link otherwise', () => {
  assert.equal(telHref('(555) 010-4477').href, 'tel:5550104477');
  assert.equal(telHref('+63 917 123 4567').href, 'tel:+639171234567');
  assert.equal(telHref('555.010.4477').href, 'tel:5550104477');
  for (const bad of ['+1 (555) 123-4567 ext. 89', '555-0104 or 555-0105', 'call me',
    '123456', `+${'9'.repeat(20)}`, '+1+2 5550104477', '(555) 010-4477 (cell)']) {
    const r = telHref(bad);
    assert.equal(r.kind, 'invalid',
      `${JSON.stringify(bad)}: the artifact stripped non-digits and dialled a wrong number instead`);
    assert.equal(r.href, null, 'no link at all is honest; a truncated number is not');
    assert.equal(r.label, bad.trim(), 'the digits still render as visible text');
  }
});

// ── 4. Photo safety ─────────────────────────────────────────────────────────

test('isSafePhotoDataUrl accepts only base64 png, jpeg and webp', () => {
  for (const type of ['png', 'jpeg', 'webp']) {
    assert.equal(isSafePhotoDataUrl(`data:image/${type};base64,${B64}`), true, `${type} must be allowed`);
  }
  for (const type of ['svg+xml', 'gif', 'bmp', 'tiff', 'avif', 'x-icon']) {
    assert.equal(isSafePhotoDataUrl(`data:image/${type};base64,${B64}`), false,
      `${type} is not in the re-encoder's output set, so a stored one did not come from us`);
  }
});

test('an SVG photo is rejected — SVG carries script and the preview runs scripts', () => {
  assert.equal(isSafePhotoDataUrl(`data:image/svg+xml;base64,${B64}`), false);
  assert.equal(isSafePhotoDataUrl('data:image/svg+xml,<svg onload="alert(1)"/>'), false);
});

test('a non-base64 data URL, an html data URL and a javascript value are rejected', () => {
  for (const bad of ['data:image/png,%3Csvg%3E', `data:text/html;base64,${B64}`,
    'javascript:alert(1)', 'data:;base64,QUJD', `data:image/png;base64,${B64}#x`,
    'https://evil.example/x.png', 'DATA:IMAGE/PNG;BASE64,QUJD']) {
    assert.equal(isSafePhotoDataUrl(bad), false, `${JSON.stringify(bad).slice(0, 50)} must be refused`);
  }
});

test('a payload containing anything outside the base64 alphabet is rejected', () => {
  for (const payload of ['AB CD', 'AB<CD', 'AB"CD', 'AB\nCD', 'AB=CD', 'ABC']) {
    assert.equal(isSafePhotoDataUrl(`data:image/png;base64,${payload}`), false,
      `${JSON.stringify(payload)} is not valid base64 and must not reach an img src`);
  }
});

test('a payload over the size cap is rejected', () => {
  const huge = 'A'.repeat(PF_PHOTO_MAX_BASE64 + 4);
  assert.equal(isSafePhotoDataUrl(`data:image/png;base64,${huge}`), false,
    'an oversized photo exhausts the localStorage quota and bloats every download');
  assert.equal(isSafePhotoDataUrl(`data:image/png;base64,${'A'.repeat(1024)}`), true);
});

test('non-strings and empties are rejected without throwing', () => {
  for (const bad of [null, undefined, 0, {}, [], true, '']) {
    assert.equal(isSafePhotoDataUrl(bad), false);
  }
});

// ── 5. The generated document ───────────────────────────────────────────────

test('escapeHtml escapes & < > " and \' , and maps null/undefined to an empty string', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0', 'a zero is content, not absence');
  // ★ The apostrophe matters: the artifact omitted it, which was safe only while
  //   every attribute used double quotes — an invariant one style='…' destroys.
  assert.ok(escapeHtml("it's").includes('&#39;'));
});

test('a script tag in every text field lands escaped, in both modes', () => {
  const payload = '</script><script>alert(1)</script>';
  const draft = {
    fullName: payload, credentials: payload, title: payload, location: payload,
    heroHeadline: payload, heroSub: payload, ctaText: payload, summary: payload,
    sampleCompany: payload, samplePeriod: payload, industry: payload,
    painPoints: [payload], transformations: [{ before: payload, after: payload }],
    services: [{ name: payload, desc: payload }],
    packages: [{ name: payload, price: payload, period: payload, features: [payload] }],
    tools: [{ name: payload, level: 50 }], industries: [payload],
    metrics: [{ value: 1, suffix: payload, label: payload }],
    testimonials: [{ quote: payload, name: payload, role: payload }],
    education: [{ credential: payload, detail: payload }],
  };
  for (const [label, html] of [['download', download(draft)], ['preview', preview(draft)]]) {
    assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
      `${label}: an unescaped payload reached the document`);
    // Exactly one script element, ours.
    assert.equal((html.match(/<script>/g) || []).length, 1,
      `${label}: the document must contain exactly one script element`);
    assert.equal((html.match(/<\/script>/g) || []).length, 1,
      `${label}: a stray closing tag means a field broke out of the runtime block`);
    assert.ok(html.includes('&lt;/script&gt;'), `${label}: the payload should be present as text`);
  }
});

test('an event-handler payload never becomes a live attribute', () => {
  const html = download({ heroHeadline: '"><img src=x onerror=alert(1)>' });
  assert.ok(!/<img[^>]*onerror/i.test(html), 'an escaped payload must not form a real img element');
  assert.ok(html.includes('onerror=alert(1)&gt;'), 'it should still be readable as text');
});

test('an unknown theme key falls back to a real theme instead of emitting invalid CSS', () => {
  for (const bad of [undefined, null, '', 'nope', 42, {}, 'navy; } body { display:none']) {
    const theme = resolveTheme(bad, PORTFOLIO_THEMES);
    assert.ok(isTheme(theme), `${JSON.stringify(bad)} must resolve to a valid theme`);
    const css = themeCssVars(theme);
    assert.ok(/--accent:#[0-9a-f]{6}/i.test(css), 'the accent must be a plain hex value');
    assert.ok(!/}/.test(css.replace(/}\s*$/, '')), 'nothing may close the custom-property block early');
  }
  assert.equal(resolveTheme('nope', PORTFOLIO_THEMES).key, FALLBACK_THEME.key);
});

test('every theme’s on-panel accent is legible on that theme’s own panel', () => {
  // ★ MEASURED ACROSS ALL NINE, and one failed. The metric counters, the contact links
  //   and the contact eyebrow sit on the d1→d2 gradient. `glow` is tuned for a very dark
  //   page, which holds for eight themes — but `bluewhite` is the one LIGHT theme and its
  //   panels are mid-blue, where its #78b0ff glow measured 2.75:1. That fails the 4.5
  //   floor for the 15px contact links and the 3.0 floor for the counters, in a document
  //   the student publishes.
  // ★ The comparison is against d2, the LIGHTER stop: the gradient runs under the whole
  //   panel, so text may sit over any point of it.
  for (const [key, t] of Object.entries(PORTFOLIO_THEMES)) {
    const chosen = onPanelGlow(t);
    assert.ok(contrastRatio(chosen, t.d2) >= 4.5,
      `${key}: on-panel accent ${chosen} is ${contrastRatio(chosen, t.d2).toFixed(2)}:1 on d2 `
      + `(${t.d2}) — the contact links are normal-size text and need 4.5:1`);
    assert.ok(contrastRatio(chosen, t.d1) >= 4.5, `${key}: also check the darker stop`);
  }
});

test('the on-panel accent is a SEPARATE token, because one value cannot serve both uses', () => {
  // ★ Darkening `glow` itself was the obvious fix and it is wrong: `glow` is also the far
  //   end of the proficiency-bar gradient, which sits on a LIGHT chip, so white there
  //   fades the bar to nothing. The bar must keep the raw glow.
  const light = download(SAMPLE_DRAFT, { theme: resolveTheme('bluewhite', PORTFOLIO_THEMES) });
  assert.ok(light.includes('--glow-on-panel:#ffffff'),
    'the light theme must promote its on-panel accent');
  assert.ok(light.includes('linear-gradient(90deg,var(--accent),var(--glow))'),
    'the proficiency bar must still use the RAW glow, or it fades out on a light theme');
  assert.ok(light.includes('color:var(--glow-on-panel)'), 'on-panel text uses the derived token');
  // The eight dark themes must be untouched by this.
  const dark = resolveTheme('navy', PORTFOLIO_THEMES);
  assert.equal(onPanelGlow(dark), dark.glow, 'a theme that already passes keeps its own glow');
});

test('every text/surface pair in the published document clears WCAG AA, in all 9 themes', () => {
  // ★ THE PAIR YOU MEASURE IS THE WHOLE ANSWER, and three of these were measured against
  //   the wrong surface until now. `.tside.after` is rgba(accent,.14) over --glass over
  //   --pg2, so a ratio taken against --accent or --pg2 alone is not what a reader gets:
  //   eleven of eighteen Before/After label pairs were below 4.5:1 while appearing
  //   checked. The focus ring was 1.80:1 on the one light theme — invisible on every
  //   focusable element, WCAG 2.2 SC 1.4.11. And redblack's accent put white CTA text at
  //   4.27:1 on the primary button, the nav button, the price badge and the active
  //   statement tab. This test audits the tokens the stylesheet ACTUALLY EMITS.
  const readToken = (css, name) => {
    const m = new RegExp(`--${name}:([^;]+);`).exec(css);
    assert.ok(m, `themeCssVars must emit --${name}`);
    return m[1].trim();
  };
  // Flatten a translucent overlay the same way the browser composites it.
  const chan = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mix = (fg, bg, a) => {
    const [f1, f2, f3] = chan(fg); const [b1, b2, b3] = chan(bg);
    const m = (x, y) => Math.round(x * a + y * (1 - a));
    return `#${[m(f1, b1), m(f2, b2), m(f3, b3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };
  const failures = [];
  for (const key of PORTFOLIO_THEME_ORDER) {
    const t = PORTFOLIO_THEMES[key];
    const css = themeCssVars(t);
    const dark = t.mode === 'dark';
    const head = dark ? '#ffffff' : '#12213b';
    const text = dark ? '#d7e1ec' : '#33465a';
    const glass = mix('#ffffff', t.pg2, dark ? 0.06 : 0.55);
    const pairs = [
      // [what, foreground, background, floor]
      ['focus ring vs page', readToken(css, 'focus-ring'), t.pg2, 3],
      ['BEFORE label', readToken(css, 'tlab-before'), mix('#ff6b5e', glass, 0.14), 4.5],
      ['AFTER label', readToken(css, 'tlab-after'), mix(t.accent, glass, 0.14), 4.5],
      ['CTA text on accent', t.on, t.accent, 4.5],
      ['body text on page', text, t.pg2, 4.5],
      ['heading on page', head, t.pg2, 4.5],
      ['body text on glass', text, glass, 4.5],
      ['on-panel accent vs d2', readToken(css, 'glow-on-panel'), t.d2, 4.5],
      ['on-panel accent vs d1', readToken(css, 'glow-on-panel'), t.d1, 4.5],
      ['hero white on d1', '#ffffff', t.d1, 4.5],
      ['hero white on d2', '#ffffff', t.d2, 4.5],
      ['accent as a border', t.accent, t.pg2, 3],
    ];
    for (const [what, fg, bg, floor] of pairs) {
      const r = contrastRatio(fg, bg);
      if (r < floor) failures.push(`${key}: ${what} = ${r.toFixed(2)} (needs ${floor}) ${fg} on ${bg}`);
    }
  }
  assert.deepEqual(failures, [], `contrast failures:\n${failures.join('\n')}`);
});

test('contrastRatio agrees with the WCAG reference values', () => {
  assert.equal(Number(contrastRatio('#ffffff', '#000000').toFixed(2)), 21);
  assert.equal(Number(contrastRatio('#ffffff', '#ffffff').toFixed(2)), 1);
  // #0070E0 is --primary-solid, documented in CLAUDE.md as 4.78:1 against white.
  assert.equal(Number(contrastRatio('#ffffff', '#0070e0').toFixed(2)), 4.78);
  // #0A84FF is --c-primary, documented as 3.65:1 — the reason --primary-solid exists.
  assert.equal(Number(contrastRatio('#ffffff', '#0a84ff').toFixed(2)), 3.65);
  assert.equal(contrastRatio('nonsense', '#ffffff') > 1, true, 'a bad input must not throw');
});

test('every shipped theme builds a complete document', () => {
  for (const key of Object.keys(PORTFOLIO_THEMES)) {
    const html = download(SAMPLE_DRAFT, { theme: resolveTheme(key, PORTFOLIO_THEMES) });
    assert.ok(html.startsWith('<!DOCTYPE html>'), `${key} lost its doctype`);
    assert.ok(html.trimEnd().endsWith('</html>'), `${key} produced a truncated document`);
    assert.ok(html.includes(`--accent:${PORTFOLIO_THEMES[key].accent}`), `${key} did not apply its accent`);
  }
});

test('preview mode is locked down and download mode is editable', () => {
  const pv = preview(SAMPLE_DRAFT);
  const dl = download(SAMPLE_DRAFT);
  assert.ok(pv.includes("default-src 'none'; img-src data:;"),
    'the preview renders content we just escaped — the policy is defence in depth behind that');
  const policy = (html) => (/content="(default-src[^"]*)"/.exec(html) || [, ''])[1];
  assert.ok(!policy(pv).includes('https:'),
    'the preview policy must allow no remote fetch of any kind');
  // ★ The download's policy is deliberately looser. `default-src 'none'` in a file
  //   the bookkeeper owns booby-traps it against adding a font, a hosted photo or
  //   a Calendly embed — all failing silently, with no error they can read.
  assert.ok(dl.includes('img-src data: https:'), 'a hosted headshot must be addable');
  assert.ok(dl.includes("connect-src 'none'"), 'the file still may not phone anywhere by itself');
  for (const html of [pv, dl]) {
    assert.ok(html.includes("base-uri 'none'"), 'base-uri does not fall back to default-src');
    assert.ok(html.includes("form-action 'none'"), 'form-action does not fall back to default-src');
    assert.ok(!html.includes('&#39;none&#39;'),
      'the policy must not be HTML-escaped — it still works, which is why the mangling would go unnoticed');
  }
});

test('preview mode carries the link guard and the note; download mode carries neither', () => {
  const pv = preview(SAMPLE_DRAFT, { scrollY: 1247 });
  const dl = download(SAMPLE_DRAFT, { scrollY: 1247 });
  assert.ok(pv.includes('pf-linknote'), 'the user must be told why a preview link did nothing');
  assert.ok(pv.includes('data-pf-scroll="1247"'),
    'the scroll offset rides in the markup — a postMessage before the child listener attaches is dropped');
  assert.ok(pv.includes('pf-scroll'), 'the preview reports its scroll position back');
  assert.ok(!dl.includes('pf-linknote'), 'the downloaded file has live links and needs no note');
  assert.ok(!dl.includes('data-pf-scroll'), 'the download must carry no preview plumbing');
  assert.ok(!dl.includes('postMessage'), 'a published portfolio must not message anyone');
});

test('the scroll offset is clamped and can never be anything but a number', () => {
  for (const [input, want] of [[-5, 0], [0, 0], [1247.6, 1248], [1e9, 200000],
    ['abc', 0], [null, 0], [undefined, 0], [NaN, 0], [Infinity, 0], ['1247', 1247]]) {
    const html = preview(SAMPLE_DRAFT, { scrollY: input });
    assert.ok(html.includes(`data-pf-scroll="${want}"`),
      `scrollY ${JSON.stringify(input)} must render as ${want}, not as arbitrary text in an attribute`);
  }
});

test('buildPortfolioHtml calls no Date — the same input is byte-identical every time', () => {
  const a = download(SAMPLE_DRAFT);
  const b = download(SAMPLE_DRAFT);
  assert.equal(a, b, 'a non-deterministic builder cannot be asserted on at all');
  assert.ok(a.includes('<span id="yr">2026</span>'),
    'the year is a parameter; the runtime still refreshes it for a file opened years later');
  assert.ok(download(SAMPLE_DRAFT, { year: 2030 }).includes('<span id="yr">2030</span>'));
});

test('a section absent from the body is absent from the nav, across the whole table', () => {
  // ★ THE BUG THIS PREVENTS. The artifact emitted <a href="#about"> when `summary`
  //   was set but rendered id="about" when `summary || education` was — so an
  //   education-only draft had a section with no link to it. One table, one truth.
  const filled = {
    painPoints: ['p'], transformations: [{ before: 'b', after: 'a' }],
    metrics: [{ value: 1, suffix: '+', label: 'l' }], services: [{ name: 'n', desc: 'd' }],
    showSamples: true, summary: 's', education: [{ credential: 'c', detail: '' }],
    tools: [{ name: 't', level: 50 }], industries: ['i'],
    packages: [{ name: 'p', price: '$1', period: '/mo', features: ['f'] }],
    testimonials: [{ quote: 'q', name: 'n', role: 'r' }],
  };
  const keys = PORTFOLIO_SECTIONS.map((s) => s.key);
  // 2^10 combinations of present/absent, checked in full.
  for (let mask = 0; mask < (1 << keys.length); mask += 1) {
    const draft = normalizeDraft({});
    keys.forEach((key, i) => {
      if (!(mask & (1 << i))) return;
      const section = PORTFOLIO_SECTIONS[i];
      if (key === 'about') { draft.summary = filled.summary; draft.education = filled.education; }
      else if (key === 'samples') draft.showSamples = true;
      else if (key === 'pain') draft.painPoints = filled.painPoints;
      else if (key === 'transform') draft.transformations = filled.transformations;
      else draft[key] = filled[key];
      assert.ok(section.has(draft), `${key} should now be live`);
    });
    if (!(mask & (1 << keys.indexOf('samples')))) draft.showSamples = false;
    const html = download(draft);
    const nav = navBlock(html);
    for (const section of PORTFOLIO_SECTIONS) {
      if (!section.nav || !section.anchor) continue;
      const inNav = nav.includes(`href="#${section.anchor}"`);
      const inBody = html.includes(`id="${section.anchor}"`);
      assert.equal(inNav, inBody,
        `mask ${mask}: #${section.anchor} is ${inNav ? 'linked but missing' : 'present but unlinked'}`);
    }
  }
});

test('every nav href resolves to an id that exists in the document', () => {
  for (const draft of [emptyDraft(), SAMPLE_DRAFT, { showSamples: false, summary: 'x' }]) {
    const html = download(draft);
    const nav = navBlock(html);
    const ids = [...nav.matchAll(/href="#([A-Za-z][\w-]*)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 0, 'the nav must always offer at least Contact');
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `#${id} is linked but no element carries that id`);
    }
  }
});

test('the CTA is resolved once and the same validated href reaches all four sites', () => {
  const draft = { ...SAMPLE_DRAFT, ctaLink: 'https://calendly.com/jordan/30min' };
  const html = download(draft);
  const hrefs = [...html.matchAll(/href="(https:\/\/calendly\.com[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 4, `the nav, hero, each package and the contact panel: got ${hrefs.length}`);
  assert.equal(new Set(hrefs).size, 1, 'four call sites must not be able to disagree');
  assert.ok(html.includes('rel="noopener noreferrer"'), 'an external CTA opens in a new tab safely');
});

test('an invalid CTA degrades to #contact, never to an empty or dangerous href', () => {
  for (const bad of ['javascript:alert(1)', 'http://x.example', 'https://u:p@evil.example', 'nonsense', '']) {
    const html = download({ ...SAMPLE_DRAFT, ctaLink: bad });
    assert.ok(!/href="javascript:/i.test(html), `${bad} reached an href`);
    assert.ok(!/href=""/.test(html), `${bad} produced an empty href`);
    assert.ok(html.includes('href="#contact"'), `${bad} should fall back to the contact section`);
  }
});

test('the empty draft still produces a valid, complete document', () => {
  const html = download(emptyDraft());
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0">'));
  assert.ok(/<title>[^<]+<\/title>/.test(html), 'a document with no title is unusable as a bookmark');
  assert.ok(html.includes('id="contact"'), 'contact is unconditional');
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('optional sections disappear cleanly when empty', () => {
  const html = download({ fullName: 'A', title: 'B', showSamples: false });
  for (const anchor of ['services', 'samples', 'about', 'tools', 'packages']) {
    assert.ok(!html.includes(`id="${anchor}"`), `#${anchor} rendered from an empty draft`);
  }
  assert.ok(!html.includes('<section class="pain'), 'an empty pain band must not render its heading');
  assert.ok(!/<div class="tfgrid">\s*<\/div>/.test(html), 'no empty grid may be left behind');
});

test('a photo renders as an img and its absence renders initials', () => {
  const withPhoto = download({ fullName: 'Jordan Reyes', summary: 's', photo: PNG });
  assert.ok(withPhoto.includes(`src="${PNG}"`), 'a validated photo must render');
  const without = download({ fullName: 'Jordan Reyes', summary: 's' });
  assert.ok(without.includes('>JR<'), 'initials are the fallback');
  // ★ The artifact produced "JU" here: split(' ') on a double space yielded an
  //   empty token, w[0] was undefined, and join gave "JundefinedR".
  assert.ok(download({ fullName: 'Jordan  Reyes', summary: 's' }).includes('>JR<'),
    'a double space must not produce "JU" from "JundefinedR"');
  assert.ok(download({ fullName: '', summary: 's' }).includes('class="abphoto ph"'),
    'an empty name must still render the placeholder frame, not a broken img');
});

test('a word-shaped metric suffix is spaced from the number, a symbol is not', () => {
  // ★ Found in the browser, not in a unit test: the counter read "5yrs". The sample
  //   authored the suffix as " yrs", and normalizeDraft trims every text field — so the
  //   space could never survive in the DATA. Separating here also fixes it for every
  //   user who types "yrs", "years" or "clients" rather than only for the example.
  for (const [input, want] of [['+', '+'], ['%', '%'], ['yrs', ' yrs'], ['years', ' years'],
    ['k', ' k'], ['clients', ' clients'], [' yrs', ' yrs'], ['', ''], [null, ''], ['/mo', '/mo']]) {
    assert.equal(metricSuffix(input), want, `suffix ${JSON.stringify(input)}`);
  }
  const html = download({ metrics: [{ value: 5, suffix: 'yrs', label: 'experience' }] });
  assert.ok(html.includes('data-suffix=" yrs"'),
    'the space must be baked into the attribute, because the counter animation reads it back');
  assert.ok(html.includes('>0 yrs<'), 'and into the pre-animation text, or the value jumps');
  const tight = download({ metrics: [{ value: 1000, suffix: '+', label: 'transactions' }] });
  assert.ok(tight.includes('>0+<'), 'a symbol must stay tight against the number');
});

test('the financial samples are labelled illustrative wherever they appear', () => {
  const html = download({ showSamples: true });
  assert.match(html, /Illustrative sample only/,
    'these figures are shown to prospects; they must never read as a real client result');
  assert.match(html, /fictional company/);
});

test('the generated CSS stills every animation under prefers-reduced-motion', () => {
  const html = download(SAMPLE_DRAFT);
  const block = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(block, 'the reduced-motion block must ship in the downloaded file, not just the app');
  for (const selector of ['.orb', '.reveal', '.bar i']) {
    assert.ok(block.includes(selector), `${selector} still animates for a user who asked it not to`);
  }
  assert.ok(html.includes('scroll-behavior:auto'), 'smooth scrolling must be disabled too');
  assert.ok(html.includes('prefers-reduced-motion: reduce'), 'the runtime also gates the counters on it');
});

test('the reveal safety net survives, because a hidden iframe never fires IntersectionObserver', () => {
  const html = download(SAMPLE_DRAFT);
  assert.ok(html.includes('.reveal:not(.in)'),
    'inside a display:none frame the viewport is 0x0 and IO never fires — the mobile toggle depends on this');
});

test('preview mode freezes the three infinite blur orbs', () => {
  assert.ok(preview(SAMPLE_DRAFT).includes('.orb,.hero:after{animation:none!important}'),
    'three infinite blur(80px) animations compositing beside a React editor is a real cost');
  assert.ok(!download(SAMPLE_DRAFT).includes('animation:none!important'),
    'the downloaded portfolio keeps its motion');
});

test('the generated document leaks no app internals', () => {
  const html = download(SAMPLE_DRAFT);
  for (const secret of ['supabase', 'sb-', 'anon', 'apikey', 'api_key', 'Bearer', 'localStorage',
    'portfolio:draft', 'VITE_', 'anthropic', '/api/', 'u:', 'is_enrolled', 'access_token']) {
    assert.ok(!html.toLowerCase().includes(secret.toLowerCase()),
      `the downloaded file mentions "${secret}" — a portfolio is published, so anything in it is public`);
  }
});

test('the document declares a charset first and needs no network to render', () => {
  const html = download(SAMPLE_DRAFT);
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert.ok(head.indexOf('<meta charset="UTF-8">') < head.indexOf('<title>'),
    'a charset declared after content can be applied too late');
  assert.ok(!/<link[^>]+href="https?:/.test(html), 'a stylesheet or font request breaks the offline promise');
  assert.ok(!/<script[^>]+src=/.test(html), 'an external script breaks the offline promise');
  assert.ok(html.includes('<link rel="icon" href="data:,">'),
    "without this the browser requests /favicon.ico and default-src 'none' logs a CSP violation");
});

// ── 6. The financial samples tie out ────────────────────────────────────────
//
// ★ THE ARTIFACT'S CASH FLOW DID NOT TIE OUT. Its operating components summed to
//   96,200 against a printed subtotal of 96,800 — while the P&L and balance sheet
//   were perfect and ending cash correctly matched balance-sheet cash. So the
//   defect was in a COMPONENT, and the subtotal had to stay put: depreciation is
//   13,200 here, not 12,600. The document tells prospects these figures are
//   internally consistent, to an audience of accountants.

const rows = financialSampleRows();
const val = (set, label) => {
  const row = set.find((r) => r.label === label);
  assert.ok(row, `${label} is missing from the statement`);
  return row.value;
};
const sumLinesBetween = (set, from, to) => {
  const a = set.findIndex((r) => r.label === from);
  const b = set.findIndex((r) => r.label === to);
  assert.ok(a >= 0 && b > a, `${from}..${to} is not a valid range`);
  return set.slice(a, b).filter((r) => r.kind === 'line').reduce((t, r) => t + r.value, 0);
};

test('the P&L subtotals equal the sum of their lines', () => {
  assert.equal(sumLinesBetween(rows.pl, 'Sales / Service Revenue', 'Total Revenue'),
    val(rows.pl, 'Total Revenue'));
  assert.equal(sumLinesBetween(rows.pl, 'Payroll & Wages', 'Total Operating Expenses'),
    val(rows.pl, 'Total Operating Expenses'));
  assert.equal(val(rows.pl, 'Total Revenue') - val(rows.pl, 'Total COGS'), val(rows.pl, 'Gross Profit'));
  assert.equal(val(rows.pl, 'Gross Profit') - val(rows.pl, 'Total Operating Expenses'),
    val(rows.pl, 'Net Operating Income'));
  assert.equal(val(rows.pl, 'Net Operating Income') - val(rows.pl, 'Interest Expense'),
    val(rows.pl, 'Net Income'));
});

test('the balance sheet balances', () => {
  assert.equal(sumLinesBetween(rows.bs, 'Cash & Equivalents', 'Total Current Assets'),
    val(rows.bs, 'Total Current Assets'));
  assert.equal(val(rows.bs, 'Total Current Assets') + val(rows.bs, 'Equipment (net)'),
    val(rows.bs, 'Total Assets'));
  assert.equal(sumLinesBetween(rows.bs, 'Accounts Payable', 'Total Current Liabilities'),
    val(rows.bs, 'Total Current Liabilities'));
  assert.equal(val(rows.bs, 'Total Current Liabilities') + val(rows.bs, 'Notes Payable'),
    val(rows.bs, 'Total Liabilities'));
  assert.equal(val(rows.bs, 'Total Assets'), val(rows.bs, 'Total Liabilities & Equity'),
    'a balance sheet that does not balance is the single worst thing this tool could show');
  assert.equal(val(rows.bs, 'Total Liabilities') + val(rows.bs, 'Owner’s Equity'),
    val(rows.bs, 'Total Liabilities & Equity'));
});

test('★ the cash-flow operating subtotal equals the sum of its components', () => {
  assert.equal(sumLinesBetween(rows.cf, 'Net Income', 'Net Cash from Operations'),
    val(rows.cf, 'Net Cash from Operations'),
    'this is the line the artifact got wrong by 600, under a footnote claiming consistency');
});

test('net change in cash equals operating plus investing plus financing', () => {
  assert.equal(
    val(rows.cf, 'Net Cash from Operations')
    + val(rows.cf, 'Net Cash used in Investing')
    + val(rows.cf, 'Net Cash used in Financing'),
    val(rows.cf, 'Net Change in Cash'),
  );
  assert.equal(val(rows.cf, 'Purchase of Equipment'), val(rows.cf, 'Net Cash used in Investing'));
  assert.equal(sumLinesBetween(rows.cf, 'Loan Repayments', 'Net Cash used in Financing'),
    val(rows.cf, 'Net Cash used in Financing'));
});

test('beginning cash plus net change equals ending cash', () => {
  assert.equal(val(rows.cf, 'Beginning Cash Balance') + val(rows.cf, 'Net Change in Cash'),
    val(rows.cf, 'Ending Cash Balance'));
});

test('the three statements agree with each other', () => {
  assert.equal(val(rows.cf, 'Net Income'), val(rows.pl, 'Net Income'),
    'cash flow starts from the P&L bottom line');
  assert.equal(val(rows.cf, 'Ending Cash Balance'), val(rows.bs, 'Cash & Equivalents'),
    'ending cash IS the balance-sheet cash line');
});

test('money is locale-independent and marks negatives as accountants expect', () => {
  assert.equal(money(485000), '$485,000');
  assert.equal(money(0), '$0');
  assert.equal(money(-8300), '($8,300)',
    'parentheses, not a minus sign — this is a financial statement');
  assert.equal(money(1234567), '$1,234,567');
  assert.equal(money('485000'), '$485,000');
  assert.equal(money(NaN), '$0');
  // ★ toLocaleString() with no locale renders 485000 as "485.000" on a de-DE ICU
  //   build, so the same draft would produce a different document per machine.
  assert.ok(!/toLocaleString/.test(money.toString()));
});

test('every statement row renders, and negatives are tagged for the stylesheet', () => {
  const html = download({ showSamples: true });
  assert.ok(html.includes('$485,000'), 'the P&L must render its figures');
  assert.ok(html.includes('($8,300)'), 'a negative must render in parentheses');
  assert.ok(html.includes('class="line neg"') || html.includes('class="neg"'),
    'a negative row needs a class so it can be coloured');
  for (const set of ['pl', 'bs', 'cf']) {
    assert.ok(html.includes(`data-panel="${set}"`), `the ${set} panel is missing`);
  }
});

// ── 7. The résumé parser ────────────────────────────────────────────────────

test('parseResumeLines never mutates its input and returns a patch, not a draft', () => {
  const lines = ['Jordan Reyes', 'Bookkeeper'];
  const snapshot = JSON.stringify(lines);
  const r = parseResumeLines(lines);
  assert.equal(JSON.stringify(lines), snapshot);
  assert.ok(!('showSamples' in r.patch), 'a patch must not carry fields the résumé said nothing about');
  assert.ok(Array.isArray(r.applied) && Array.isArray(r.skipped));
});

test('no text at all yields confidence:none — a scanned PDF is not a successful import', () => {
  for (const input of [[], null, undefined, ['', ' ', 'a'], 'not an array']) {
    const r = parseResumeLines(input);
    assert.equal(r.confidence, 'none',
      'the artifact printed "✓ Pre-filled from your resume" after extracting nothing at all');
    assert.equal(r.applied.length, 0, 'nothing may be reported as applied');
  }
});

test('a date range is never accepted as a phone number', () => {
  // ★ The artifact's regex /(\+?\d[\d\s().-]{7,}\d)/ matched "2019-2023" and put
  //   a date range in the phone field.
  for (const line of ['Managed accounts payable from 2019-2023 for three separate entities',
    'Worked at 1234 Main Street, Suite 200 in a busy downtown practice',
    'Handled 2018 - 2024 reconciliations across every entity in the group']) {
    const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'EXPERIENCE', line]);
    assert.equal(r.patch.phone, undefined, `${JSON.stringify(line)} produced a phone number`);
  }
});

test('an extracted phone must pass telHref and carry real evidence', () => {
  const good = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'CONTACT', '+1 (555) 010-4477']);
  assert.equal(good.patch.phone, '+1 (555) 010-4477');
  const ext = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'CONTACT', '(555) 010-4477 ext. 12']);
  assert.equal(ext.patch.phone, undefined, 'an extension makes the number undialable');
  assert.ok(ext.skipped.some((s) => s.field === 'phone'), 'the user must be told why it was skipped');
});

test('an extracted email must pass mailtoHref', () => {
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'jordan@example.com']);
  assert.equal(r.patch.email, 'jordan@example.com');
  assert.equal(parseResumeLines(['Jordan Reyes', 'reach me at jordan@localhost']).patch.email, undefined);
});

test('a name splits from trailing credentials, and only from credential-shaped tokens', () => {
  const r = parseResumeLines(['Jordan Reyes, MBA, CPA', 'Remote Bookkeeper']);
  assert.equal(r.patch.fullName, 'Jordan Reyes');
  assert.equal(r.patch.credentials, 'MBA, CPA',
    'the artifact\'s lazy regex produced fullName "Jordan Reyes, Mba" and credentials "CPA"');
  const notCreds = parseResumeLines(['Reyes, Jordan Patrick', 'Bookkeeper']);
  assert.equal(notCreds.patch.credentials, undefined, 'a second given name is not a credential');
});

test('ALL-CAPS credentials survive title-casing, and so do McKay and O’Brien', () => {
  for (const [input, want] of [['MCDONALD', 'McDonald'], ["O'BRIEN", "O'Brien"],
    ['MACARTHUR', 'MacArthur'], ['JORDAN REYES', 'Jordan Reyes'], ['Jordan Reyes', 'Jordan Reyes'],
    ['McKay Reyes', 'McKay Reyes']]) {
    const r = parseResumeLines([input, 'Bookkeeper']);
    assert.equal(r.patch.fullName, want,
      `the artifact's titleCase turned ${input} into something the owner would not recognise`);
  }
});

test('a contact line is never accepted as a professional title', () => {
  for (const second of ['jordan@example.com | (555) 010-4477 | Denver, CO',
    'linkedin.com/in/jordan-reyes', '+63 917 123 4567', 'https://example.com']) {
    const r = parseResumeLines(['Jordan Reyes', second]);
    assert.equal(r.patch.title, undefined, `${JSON.stringify(second)} became the job title`);
  }
  assert.equal(parseResumeLines(['Jordan Reyes', 'Senior Bookkeeper']).patch.title, 'Senior Bookkeeper');
});

test('a heading is matched by family, not by an exact-length cliff', () => {
  // ★ simpleHead() required l.length <= keyword.length + 3, so
  //   "SUMMARY OF QUALIFICATIONS" (25 chars vs "summary" + 3) never matched.
  for (const heading of ['SUMMARY', 'Summary', 'Professional Summary',
    'SUMMARY OF QUALIFICATIONS', 'Career Summary', 'Profile', 'OBJECTIVE', 'Summary:']) {
    const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', heading, 'Five years of full-cycle work.']);
    assert.equal(r.patch.summary, 'Five years of full-cycle work.', `${heading} did not match`);
  }
});

test('a skills line splits on every separator a résumé actually uses', () => {
  for (const line of ['QuickBooks Online, Xero, Excel', 'QuickBooks Online | Xero | Excel',
    'QuickBooks Online \u00b7 Xero \u00b7 Excel', 'QuickBooks Online / Xero / Excel',
    '\u2022 QuickBooks Online \u2022 Xero \u2022 Excel']) {
    const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'SKILLS', line]);
    const names = (r.patch.tools || []).map((t) => t.name);
    assert.deepEqual(names, ['QuickBooks Online', 'Xero', 'Excel'], `failed on ${JSON.stringify(line)}`);
  }
});

test('an unsplittable line is reported, not turned into one absurd tool', () => {
  // A single 30+ character "skill" means pdf.js flattened two columns into one row.
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'SKILLS',
    'Reconciliation AP AR Payroll Month-End Close Financial Reporting']);
  assert.ok(!(r.patch.tools || []).some((t) => t.name.length > 40),
    'the artifact stored the whole row as one 63-character skill');
  assert.ok(r.skipped.some((s) => s.field === 'skills'), 'the user should be told to fill this in');
});

test('an education section is bounded even when CONTACT appears above it', () => {
  // ★ The artifact stopped `education` only at a `contact` heading and scanned
  //   forward from the start index, so a CONTACT block at the TOP of the résumé
  //   never stopped anything and education absorbed every line to end of file.
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'CONTACT', 'jordan@example.com',
    'EDUCATION', 'BS Accountancy, State University', 'EXPERIENCE',
    'Reconciled forty-five bank accounts every month without fail']);
  assert.equal(r.patch.education.length, 1, 'education must stop at the next heading of ANY family');
  assert.equal(r.patch.education[0].credential, 'BS Accountancy, State University');
});

test('a metric never takes a four-digit year as its value', () => {
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'EXPERIENCE',
    'Reconciled accounts continuously from 2019+ onwards for a dozen different clients']);
  const metrics = r.suggested.metrics || [];
  assert.equal(metrics.filter((m) => m.value >= 1900 && m.value <= 2100).length, 0,
    'the artifact rendered "2,019+" as an animated achievement counter');
});

test('a metric needs an explicit marker, and the number leaves the label', () => {
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'EXPERIENCE',
    'Maintained a 99% reconciliation accuracy rate across every client engagement']);
  const m = (r.suggested.metrics || [])[0];
  assert.ok(m, 'a percentage is a real metric');
  assert.equal(m.value, 99);
  assert.equal(m.suffix, '%', 'a plain count must not silently gain a "+"');
  assert.ok(!/99/.test(m.label), `the number renders twice otherwise: ${m.label}`);
  const plain = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'EXPERIENCE',
    'Reconciled 12 accounts monthly for a mid-sized construction contractor']);
  assert.equal((plain.suggested.metrics || []).length, 0,
    'a bare number in a sentence is not a measured result');
});

test('generic copy is SUGGESTED and never applied', () => {
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper']);
  for (const field of ['heroHeadline', 'heroSub', 'painPoints']) {
    assert.equal(r.patch[field], undefined,
      `the artifact injected ${field} and reported it as parsed from the résumé`);
    assert.ok(r.suggested[field], `${field} should be offered explicitly instead`);
  }
});

test('a suggested hero sub-line is cut on a word boundary', () => {
  const long = `${'Detail-oriented bookkeeper with extensive experience. '.repeat(6)}End.`;
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'SUMMARY', long]);
  const sub = r.suggested.heroSub;
  assert.ok(sub.length <= 182, 'the sub-line must stay short');
  assert.ok(sub.endsWith('\u2026'), 'a truncated line needs an ellipsis');
  assert.ok(!/\s\u2026$/.test(sub), 'no space before the ellipsis');
  const body = sub.slice(0, -1);
  assert.ok(long.startsWith(body), 'the sub-line must be a real prefix of the summary');
  assert.match(long.charAt(body.length), /\s/,
    'the cut must land on a space — the artifact sliced at 180 characters mid-word');
});

test('experience bullets become suggested services, never applied ones', () => {
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'EXPERIENCE',
    '\u2022 Reconciled forty-five bank accounts monthly for a construction client']);
  assert.equal(r.patch.services, undefined,
    'an achievement is past-tense about a previous job; a service is an offer to a prospect');
  assert.ok((r.suggested.services || []).length > 0, 'they should still be offered for rewriting');
});

test('the website is never harvested out of an email address', () => {
  // ★ Found by a jspdf -> pdfjs -> parseResumeLines round trip, not by reading the
  //   regex: a contact line of "jordan@example.com | (555) 010-4477 |
  //   linkedin.com/in/jordan-reyes" yielded website "https://example.com/", because
  //   the generic domain pattern matched the host half of the EMAIL first. The
  //   wrong answer looks completely plausible sitting in the field, which is what
  //   makes it worth a test: the student publishes a link to a stranger's domain.
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper',
    'jordan@example.com | (555) 010-4477 | linkedin.com/in/jordan-reyes']);
  assert.equal(r.patch.website, 'https://linkedin.com/in/jordan-reyes');
  assert.equal(r.patch.email, 'jordan@example.com', 'the email itself must still be extracted');
  const emailOnly = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'jordan@example.com']);
  assert.equal(emailOnly.patch.website, undefined,
    'an email alone is not a website, and inventing one from its domain is a fabrication');
});

test('a suggested metric label is cut on a word boundary', () => {
  const r = parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'EXPERIENCE',
    'Maintained a 99% reconciliation accuracy rate across every single client engagement']);
  const label = r.suggested.metrics[0].label;
  assert.ok(label.length <= 60);
  assert.ok(!/\s$/.test(label), 'no trailing space');
  assert.ok(!/engag$/.test(label),
    `a suggestion the user is asked to approve must not look like a truncation bug: ${label}`);
});

test('confidence rises with structural evidence, not with contact details alone', () => {
  assert.equal(parseResumeLines(['jordan@example.com']).confidence, 'none',
    'an email alone means we read a header, not a résumé');
  assert.equal(parseResumeLines(['Jordan Reyes', 'Bookkeeper']).confidence, 'low');
  assert.equal(parseResumeLines(['Jordan Reyes', 'Bookkeeper', 'SUMMARY', 'Five years of work.',
    'SKILLS', 'QuickBooks Online, Xero', 'EDUCATION', 'BS Accountancy']).confidence, 'good');
});

test('a parsed patch survives normalizeDraft unchanged in meaning', () => {
  const r = parseResumeLines(['Jordan Reyes, CPA', 'Senior Bookkeeper', 'SKILLS', 'Xero, Excel']);
  const merged = normalizeDraft({ ...emptyDraft(), ...r.patch });
  assert.equal(merged.fullName, 'Jordan Reyes');
  assert.equal(merged.credentials, 'CPA');
  assert.equal(merged.tools.length, 2, 'the parser must not emit a shape normalizeDraft discards');
});

// ── 8. Completion, validation and the filename ──────────────────────────────

test('draftCompletion reads the same section table the builder walks', () => {
  const keys = draftCompletion(emptyDraft()).sections.map((s) => s.key);
  for (const section of PORTFOLIO_SECTIONS) {
    assert.ok(keys.includes(section.key),
      `${section.key} renders in the document but the meter cannot see it`);
  }
});

test('an empty draft is near zero and the example is complete', () => {
  const empty = draftCompletion(emptyDraft());
  assert.ok(empty.pct < 15, `an untouched editor must not look nearly done: got ${empty.pct}%`);
  assert.equal(draftCompletion(SAMPLE_DRAFT).pct, 100,
    'the shipped example should demonstrate a finished portfolio');
  assert.equal(empty.total, draftCompletion(SAMPLE_DRAFT).total, 'the denominator must not move');
});

test('draftHasContent is false for an untouched draft, even though completion is not zero', () => {
  // ★ THE WHOLE REASON THIS FUNCTION EXISTS, and it shipped as two visible bugs before
  //   it did. An untouched draft scores 8% — showSamples defaults on, so the
  //   sample-reports section counts as done — so `pct > 0` reported "authored" for a
  //   form nobody had typed into. Measured in the browser: the résumé import asked a
  //   brand-new user "You have already written something?" straight after Clear, and
  //   the autosave persisted a blank draft on mount.
  assert.ok(draftCompletion(emptyDraft()).pct > 0,
    'if this ever becomes 0, say so here rather than quietly re-coupling the two');
  assert.equal(draftHasContent(emptyDraft()), false,
    'an untouched draft holds nothing the student authored');
  assert.equal(draftHasContent(null), false);
  assert.equal(draftHasContent(undefined), false);
});

test('draftHasContent notices any authored field, including a changed default', () => {
  const base = emptyDraft();
  for (const [key, value] of [
    ['fullName', 'A'], ['title', 'B'], ['email', 'a@example.com'], ['phone', '5550104477'],
    ['website', 'https://example.com'], ['heroHeadline', 'H'], ['heroSub', 'S'],
    ['summary', 'X'], ['industry', 'Construction'], ['credentials', 'CPA'],
    ['location', 'Remote'], ['ctaLink', '#contact'], ['photo', PNG],
  ]) {
    assert.equal(draftHasContent({ ...base, [key]: value }), true, `${key} is authored content`);
  }
  for (const key of ['painPoints', 'industries']) {
    assert.equal(draftHasContent({ ...base, [key]: ['x'] }), true, `${key} is authored content`);
  }
  assert.equal(draftHasContent({ ...base, services: [{ name: 'n', desc: 'd' }] }), true);
  // A DEFAULT is not content, but a value different from it is — only a person changes one.
  assert.equal(draftHasContent({ ...base, ctaText: base.ctaText }), false, 'the default CTA text is not authorship');
  assert.equal(draftHasContent({ ...base, ctaText: 'Book me' }), true, 'a rewritten CTA is');
  assert.equal(draftHasContent({ ...base, theme: base.theme }), false);
  assert.equal(draftHasContent({ ...base, theme: 'coral' }), true, 'picking a theme is a decision');
  assert.equal(draftHasContent({ ...base, showSamples: true }), false, 'samples default to on');
  assert.equal(draftHasContent({ ...base, showSamples: false }), true, 'turning them off is a choice');
  assert.equal(draftHasContent({ ...base, sampleCompany: 'Acme' }), true);
  assert.equal(draftHasContent(SAMPLE_DRAFT), true, 'the loaded example is content to be warned about');
});

test('validateDraft blocks only on a missing name', () => {
  const empty = validateDraft(emptyDraft());
  assert.deepEqual(empty.blocking, ['fullName'],
    'a tool that refuses the download until everything is perfect is one nobody finishes');
  assert.equal(empty.ok, false);
  const named = validateDraft({ ...emptyDraft(), fullName: 'Jordan Reyes' });
  assert.equal(named.ok, true, 'a half-finished portfolio is still worth downloading');
  assert.ok(named.fields.services, 'it should still warn about what is missing');
  assert.equal(named.fields.services.level, 'warn');
});

test('an invalid link is a warning that names the reason, not a block', () => {
  const v = validateDraft({ ...SAMPLE_DRAFT, ctaLink: 'javascript:alert(1)', website: 'http://x.example' });
  assert.equal(v.ok, true);
  assert.equal(v.fields.ctaLink.level, 'warn');
  assert.equal(v.fields.ctaLink.code, 'not-https');
  assert.equal(v.fields.website.code, 'insecure');
});

test('a portfolio with no way to reach the author is flagged', () => {
  const v = validateDraft({ ...emptyDraft(), fullName: 'A' });
  assert.ok(v.fields.contact, 'a portfolio nobody can reply to cannot convert');
  const reachable = validateDraft({ ...emptyDraft(), fullName: 'A', email: 'a@example.com' });
  assert.ok(!reachable.fields.contact);
});

test('sampleFieldsStillPresent names the example fields and narrows as they are edited', () => {
  const fresh = sampleFieldsStillPresent(SAMPLE_DRAFT, SAMPLE_DRAFT);
  assert.ok(fresh.includes('Testimonials'), 'invented testimonials are the highest-stakes field');
  assert.ok(fresh.includes('Results / key numbers'));
  const edited = {
    ...normalizeDraft(SAMPLE_DRAFT),
    fullName: 'A Real Person',
    testimonials: [{ quote: 'a real quote', name: 'Real Client', role: 'Owner' }],
    metrics: [],
  };
  const after = sampleFieldsStillPresent(edited, SAMPLE_DRAFT);
  assert.ok(!after.includes('Testimonials'), 'a replaced testimonial must stop being reported');
  assert.ok(!after.includes('Your name'));
  assert.ok(after.length < fresh.length);
  assert.deepEqual(sampleFieldsStillPresent(emptyDraft(), SAMPLE_DRAFT), [],
    'an empty draft holds no example content');
});

test('a PARTIALLY edited list is still reported — the likely edit must not silence the guard', () => {
  // ★ Whole-array equality made this the guard's blind spot: edit one of two testimonials
  //   and the stringified arrays differ, so the field dropped off the list while the OTHER
  //   testimonial — invented, attributed to a named client — was still published under the
  //   student's own name. Fixing the entry that looks wrong and leaving the rest is the
  //   single most likely thing a student does.
  const half = {
    ...normalizeDraft(SAMPLE_DRAFT),
    testimonials: [
      { quote: 'A quote from a client I really had.', name: 'A. Real', role: 'Owner' },
      normalizeDraft(SAMPLE_DRAFT).testimonials[1],
    ],
  };
  assert.ok(sampleFieldsStillPresent(half, SAMPLE_DRAFT).includes('Testimonials'),
    'one surviving invented testimonial is still a misrepresentation');
});

test('the guard covers EVERY example field, contact details included', () => {
  // ★ The old hand-typed include list held seven keys and omitted email, phone, website
  //   and credentials — so replacing all seven reported nothing while the published file
  //   still carried mailto:jordan@example.com and tel:5550104477.
  const replacedTheSeven = {
    ...normalizeDraft(SAMPLE_DRAFT),
    fullName: 'Ana Cruz',
    summary: 'My own summary.',
    testimonials: [{ quote: 'mine', name: 'X', role: 'Y' }],
    metrics: [{ value: 1, suffix: '', label: 'mine' }],
    packages: [{ name: 'mine', price: '1', blurb: 'b', features: ['f'], featured: false }],
    education: [{ title: 'mine', org: 'o', year: '2020' }],
    services: [{ title: 'mine', blurb: 'b', icon: '' }],
  };
  const left = sampleFieldsStillPresent(replacedTheSeven, SAMPLE_DRAFT);
  for (const label of ['Contact email', 'Contact phone', 'Website / LinkedIn']) {
    assert.ok(left.includes(label), `${label} must be reported while it still holds the example value`);
  }
  // Every key the sample actually populates must be reachable by the guard, so adding a
  // field to SAMPLE_DRAFT can never leave it silently unguarded.
  const all = sampleFieldsStillPresent(SAMPLE_DRAFT, SAMPLE_DRAFT);
  assert.equal(all.some((l) => /^[a-z]/.test(l)), false,
    `every reported field needs a human label, got: ${all.filter((l) => /^[a-z]/.test(l)).join(', ')}`);
});

test('the example ships NO professional credential postnominal', () => {
  // ★ It shipped 'CB' — the AIPB's Certified Bookkeeper designation. displayName() puts it
  //   in the hero, the nav and the <title>, so a student who changed the name and cleared
  //   the education section published a real certification they may not hold. Unlike a
  //   testimonial, there is no wording of a postnominal that reads as obviously invented.
  assert.equal(SAMPLE_DRAFT.credentials, '', 'the example must not assert a credential');
  const html = download({ ...SAMPLE_DRAFT, fullName: 'Ana Cruz', education: [] });
  assert.equal(/,\s*(CB|CPA|EA|CMA|CIA|ACCA)\b/.test(html), false,
    'no credential postnominal may reach the published document from the example');
});

test('portfolioFileName slugs the name and takes the date as a parameter', () => {
  assert.equal(portfolioFileName({ fullName: 'Jordan Reyes' }, '2026-09-08'),
    'jordan-reyes-bookkeeper-portfolio-2026-09-08.html');
  assert.equal(portfolioFileName({ fullName: 'José Núñez' }, '2026-09-08'),
    'jose-nunez-bookkeeper-portfolio-2026-09-08.html',
    'NFKD folds the accent rather than dropping the letter');
  assert.equal(portfolioFileName({ fullName: '  Jordan   Reyes, MBA  ' }, '2026-09-08'),
    'jordan-reyes-mba-bookkeeper-portfolio-2026-09-08.html');
  assert.equal(portfolioFileName({}, '2026-09-08'),
    'portfolio-bookkeeper-portfolio-2026-09-08.html',
    'the artifact hardcoded index.html, so every download collided');
  assert.equal(portfolioFileName({ fullName: '???' }, '2026-09-08'),
    'portfolio-bookkeeper-portfolio-2026-09-08.html');
  assert.ok(portfolioFileName({ fullName: 'A' }, 'not-a-date').endsWith('-bookkeeper-portfolio.html'),
    'a bad date is omitted rather than embedded');
  assert.ok(!/[^a-z0-9.-]/.test(portfolioFileName({ fullName: 'A/B\\C:D*E?F' }, '2026-09-08')),
    'a filename must carry no path or wildcard characters');
});

test('portfolioFileName calls no Date', () => {
  assert.ok(!/new Date|Date\.now/.test(portfolioFileName.toString()),
    'the date is a parameter so the test is reproducible and the function stays pure');
});

// ── 9. Layout constants ─────────────────────────────────────────────────────

test('PF_TWO_PANE_MIN is derived from the parts, never typed', () => {
  assert.equal(PF_TWO_PANE_MIN, PF_EDITOR_MIN + PF_COL_GAP + PF_PREVIEW_MIN);
  assert.equal(PF_TWO_PANE_MIN, 984);
  assert.ok(PF_EDITOR_MAX > PF_EDITOR_MIN, 'the editor track needs room to grow');
});

test('the logical preview widths straddle the generated documents own breakpoints', () => {
  // The document hides its nav at 760px and stacks transformation cards at 640px.
  assert.ok(PF_LOGICAL_WIDTHS.desktop > 760, 'the desktop preview must show the desktop layout');
  assert.ok(PF_LOGICAL_WIDTHS.tablet > 760, 'the tablet preview must still show the nav');
  assert.ok(PF_LOGICAL_WIDTHS.mobile < 640, 'the mobile preview must show the stacked layout');
});

test('each financial statement is a NAMED table whose amounts have row headers', () => {
  // ★ These were three tables of bare numbers: two <td>s per row, no <th>, no scope, no
  //   caption. A screen reader read "142,000" with nothing tying it to "Payroll & Wages",
  //   and a user browsing by table landed in one of three anonymous grids. For an audience
  //   of accountants, reading a statement is the entire point of the section.
  const html = download(SAMPLE_DRAFT);
  const tables = html.match(/<table class="stmt">[\s\S]*?<\/table>/g) || [];
  assert.equal(tables.length, 3, 'P&L, balance sheet and cash flow');
  for (const name of ['Profit &amp; Loss', 'Balance Sheet', 'Cash Flow Statement']) {
    assert.ok(html.includes(`<caption class="vh">${name}`), `${name} needs its own caption`);
  }
  for (const t of tables) {
    assert.match(t, /<thead class="vh"><tr><th scope="col">Line item<\/th><th scope="col">Amount \(USD\)<\/th>/,
      'both columns need a header');
    assert.match(t, /<tbody>/, 'the body rows must be grouped');
    assert.ok((t.match(/<th scope="row">/g) || []).length >= 10,
      'every line item is the header for its own amount');
    assert.ok((t.match(/<th colspan="2" scope="colgroup">/g) || []).length >= 3,
      'a group heading spans both columns');
  }
  // The caption and headers must be HIDDEN, not shown — .stmthead already says all of this
  // on screen, so revealing them would be duplication rather than an improvement.
  assert.match(html, /\.vh\{position:absolute;width:1px;height:1px/,
    'the visually-hidden helper must exist, or the caption becomes visible clutter');
  // And `th` must carry every `td` rule, or the labels shift and go bold.
  assert.match(html, /table\.stmt td,table\.stmt th\{[^}]*text-align:left/,
    'th defaults to centred bold; it must inherit the td rules to stay pixel-identical');
  for (const variant of ['sub', 'total', 'grand']) {
    assert.match(html, new RegExp(`table\\.stmt tr\\.${variant} td,table\\.stmt tr\\.${variant} th\\{`),
      `the ${variant} row rules must apply to the row header too`);
  }
});

test('no entity is escaped twice, in any theme or draft', () => {
  // ★ FOUND IN THE BUILT OUTPUT, not by reading the source. The eyebrow over the tools
  //   section was ported across as the string 'Tools &amp; proficiency' — correct in the
  //   artifact, where that text was raw markup, and wrong here, because eyebrow() escapes
  //   its argument. The published page read "Tools &amp; proficiency" to the student's
  //   prospective clients. Nothing else caught it: it is valid HTML, it renders, and no
  //   test asserted on that heading's text.
  // ★ The assertion is the GENERAL case rather than that one string, because the same
  //   mistake is available at every one of these call sites.
  for (const key of PORTFOLIO_THEME_ORDER) {
    const html = download(SAMPLE_DRAFT, { theme: resolveTheme(key, PORTFOLIO_THEMES) });
    for (const dbl of ['&amp;amp;', '&amp;lt;', '&amp;gt;', '&amp;quot;', '&amp;#39;']) {
      assert.equal(html.includes(dbl), false, `${key}: ${dbl} reached the document`);
    }
  }
  // A draft whose own text contains an entity must still escape exactly once: the reader
  // must see what they typed, not a decoded tag.
  const typed = download({ ...SAMPLE_DRAFT, heroHeadline: 'Payroll &amp; <b>AP</b> cleanup' });
  assert.ok(typed.includes('Payroll &amp;amp; &lt;b&gt;AP&lt;/b&gt; cleanup'),
    'a user-typed entity is data, so its ampersand is escaped once like any other');
  assert.equal(typed.includes('<b>AP</b>'), false, 'and the tag never becomes markup');
  // A plain ampersand in the shipped data is the correct shape, and must stay escaped once.
  assert.ok(typed.includes('Payroll &amp; 1099 Support'), 'a literal & escapes to exactly &amp;');
});

test('no auto-fit track floor can out-size a 320px phone', () => {
  // ★ MEASURED, at a real emulated 320x568: scrollWidth 325 against a 320 viewport.
  //   A bare minmax(300px,1fr) track cannot shrink below its floor, and .container
  //   leaves only 272px at that width — so the testimonial grid overhung by 28px and
  //   the tool grid by 8px. body{overflow-x:hidden} clipped the evidence; <html> still
  //   scrolled. min(Npx,100%) is the fix, and it must hold for EVERY such grid, not
  //   just the two that happened to be over the line — a wider gutter or a longer
  //   label moves that line.
  const html = download(SAMPLE_DRAFT);
  const bare = [...html.matchAll(/minmax\((?!min\()([^,)]+),/g)].map((m) => m[1]);
  assert.deepEqual(bare, [],
    `every auto-fit floor must be wrapped in min(...,100%); un-wrapped: ${bare.join(', ')}`);
  // And the wrapping must actually be there — a document with no grids would pass above.
  assert.ok(html.match(/minmax\(min\(/g).length >= 6,
    'the six responsive grids must all still be present');
  // ★ A LONG EMAIL OR URL HAS NO BREAK OPPORTUNITIES. The generated sheet had no
  //   overflow-wrap anywhere, and .contactlinks is a flex row, so a real address ran off
  //   both edges of a phone. The SAMPLE address is short, which is exactly why every
  //   earlier 320px sweep looked clean.
  assert.match(html, /body\{[^}]*overflow-wrap:break-word/,
    'the document needs a baseline wrap so one long word cannot widen the page');
  assert.match(html, /\.contactlinks a,\.contactlinks span\{[^}]*overflow-wrap:anywhere/,
    'an email and a URL need `anywhere`, because they contain no break opportunities');
});

// ── 10. The stylesheet matches the constants ─────────────────────────────────
//
// The layout is CSS; these constants are what the component measures against.
// coursePlayerLayout.test.mjs pins the same contract for the .course-* block, and
// for the same reason: a threshold that drifts shows up only as a cramped preview
// at one window size, which is the hardest kind of layout bug to attribute.

test('the @container threshold in src/index.css equals PF_TWO_PANE_MIN', () => {
  const m = /@container portfolio \(min-width: (\d+)px\)/.exec(pfCss());
  assert.ok(m, 'the two-pane layout must be a container query, not a media query');
  assert.equal(Number(m[1]), PF_TWO_PANE_MIN,
    'the CSS and the JS disagree about when this tool has two panes, so the component '
    + 'would render a Preview toggle for a layout that is already showing both');
});

test('the layout is a CONTAINER query, because one viewport width gives three tool widths', () => {
  const block = pfCss();
  assert.match(block, /container-type: inline-size/,
    'the sidebar is 288px expanded / 76px collapsed / 0 below lg — a media query cannot see that');
  assert.ok(!/@media[^\n]*min-width:\s*98[0-9]px/.test(block),
    'a media query at the two-pane threshold would fire at the wrong times');
  assert.ok(!/container-type: size/.test(block),
    'container-type: size requires a containment-independent height and collapses this layout');
});

test('the editor track uses PF_EDITOR_MIN and PF_EDITOR_MAX', () => {
  const m = /minmax\((\d+)px, (\d+)px\)/.exec(pfCss());
  assert.ok(m, 'the editor column must be a bounded track, not a fraction');
  assert.equal(Number(m[1]), PF_EDITOR_MIN);
  assert.equal(Number(m[2]), PF_EDITOR_MAX);
});

test('.pf-grid sets align-items:start — stretch makes the sticky preview immovable', () => {
  assert.match(rule('.pf-grid'), /align-items: start/,
    'the grid default makes the preview item as tall as its row, so it equals its own '
    + 'containing block and position:sticky can never move it. This is THE sticky bug.');
});

test('both grid items can shrink below their content', () => {
  assert.match(pfCss(), /\.pf-grid > \* \{ min-width: 0; \}/,
    "a grid item's automatic minimum is its content, so one pasted long URL h-scrolls <main>");
  assert.match(pfCss(), /minmax\(0, 1fr\)/, 'the preview track must be able to shrink too');
});

test('.pf-preview uses height, not max-height, so the iframe resolves', () => {
  const block = pfCss().slice(pfCss().indexOf('@container portfolio'));
  assert.match(block, /height: calc\(100vh - var\(--pf-head\) - var\(--pf-gap\)\)/,
    'iframe height:100% resolves against the parent CONTENT height, which is 0 in a '
    + 'max-height-only box — .course-rail can use max-height only because its content is a list');
  assert.ok(!/max-height: calc\(100vh/.test(block), 'max-height would give the frame zero height');
  assert.match(block, /top: var\(--pf-head\)/,
    'the sticky offset must be the MEASURED header height, not a hardcoded number');
});

test('the frame wrapper can shrink and clips inside the sticky element, not around it', () => {
  const wrap = rule('.pf-frame-wrap');
  assert.match(wrap, /min-height: 0/,
    'a flex item defaults to min-height:auto and overflows the height budget without this');
  assert.match(wrap, /overflow: hidden/, 'the rounded corners need clipping');
  // ★ The clip must be INSIDE .pf-preview. An overflow:hidden ancestor anywhere
  //   between the sticky element and <main> disables sticky outright.
  assert.ok(!/overflow: (hidden|auto|scroll)/.test(rule('.pf-preview')),
    'an overflow on the sticky element itself makes it its own scrollport and kills sticky');
  assert.ok(!/overflow: (hidden|auto|scroll)/.test(rule('.pf-grid')),
    'an overflow on the grid would disable sticky for the preview inside it');
});

test('.pf-preview declares no display, so Tailwind’s .hidden can still hide it', () => {
  // ★ MEASURED AT 390px, AND IT SHIPPED WRONG ONCE. src/index.css is emitted AFTER
  //   @tailwind utilities, so `display: flex` on .pf-preview out-cascades `.hidden` at
  //   equal specificity — the pane stayed flex in the Edit state, both panes rendered
  //   stacked, and the toggle only ever hid the editor. Same hazard as the `hidden`
  //   ATTRIBUTE losing to a display utility, one layer down. The JSX supplies `flex` or
  //   `hidden` itself, and `showPreview` is true whenever the layout is two-pane, so a
  //   visible preview always gets its display from the class list.
  const base = rule('.pf-preview');
  assert.ok(!/display:/.test(base),
    `.pf-preview must not declare display — that is what defeats .hidden. Found: ${base}`);
  assert.match(base, /flex-direction: column/,
    'flex-direction is inert while display is none, so it belongs here');
  const twoPane = pfCss().slice(pfCss().indexOf('@container portfolio'));
  assert.ok(!/\.pf-preview \{[^}]*display:/.test(twoPane),
    'the two-pane branch must not reintroduce it either');
});

test('the preview frame is scaled from a fixed logical width', () => {
  const scaler = rule('.pf-frame-scaler');
  assert.match(scaler, /width: var\(--pf-vw\)/,
    'the frame renders at a logical width so the document sees its own desktop breakpoints');
  assert.match(scaler, /transform: scale\(var\(--pf-scale\)\)/);
  assert.match(scaler, /transform-origin: top left/,
    'the default 50% origin would centre the scaled frame and clip its left edge');
  assert.match(scaler, /height: calc\(100% \/ var\(--pf-scale\)\)/,
    'without dividing by the scale the scaled frame is shorter than the pane');
});

test('every custom property the .pf-tool block references actually exists', () => {
  // ★ FOUND ONE: `.pf-swatch { background: var(--c-white) }`, and --c-white is defined
  //   nowhere in the sheet, so all nine theme swatches rendered with no background at all.
  //   A missing custom property is the quietest failure in CSS — no console warning, no
  //   parse error, the declaration is simply dropped — and this one read as almost-right
  //   because the label inside it themes correctly on its own. Nothing else can catch it:
  //   there is no linter in this repo, and a screenshot of a nearly-invisible surface
  //   looks like a design choice.
  const sheet = css();
  const defined = new Set([...sheet.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  // A token the component writes inline is legitimate — but only when it is READ with a
  // fallback, so the rule still resolves before React has measured anything. `var(--x, y)`
  // therefore cannot fail and is exempt; a bare `var(--x)` must be defined in the sheet.
  const block = pfCss();
  const bare = [...block.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/gi)]
    .filter((m) => m[2] === ')')
    .map((m) => m[1]);
  const missing = [...new Set(bare)].filter((t) => !defined.has(t));
  assert.deepEqual(missing, [],
    `the .pf-tool block reads custom properties that are never defined and carry no `
    + `fallback: ${missing.join(', ')}`);
  assert.ok(bare.length > 10, 'sanity: the block should be token-driven, not hardcoded');
  // And the inline-written ones must keep their fallbacks, or a first paint has no colour.
  for (const inlineToken of ['--pf-frame-bg']) {
    assert.match(block, new RegExp(`var\\(${inlineToken},\\s*[^)]+\\)`),
      `${inlineToken} is written inline by React, so every read of it needs a fallback`);
  }
});

test('the tool scopes its own focus ring and its own reduced-motion rules', () => {
  const block = pfCss();
  assert.match(block, /\.pf-tool :focus-visible \{ outline: 2px solid var\(--c-primary\)/,
    'no button in this app has a visible focus style by default; a 90-control form needs one');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok(!/\.pf-tool \* \{[^}]*animation: none/.test(block),
    'a blanket animation:none would still the Loader2 spinner shown while a resume is read, '
    + 'leaving exactly these users unable to tell a working import from a dead one');
});

test('the active segmented-control pill clears WCAG AA', () => {
  // .gh-pill.is-active is a gradient on --c-primary-hi (#3D8BFF) = 3.31:1 behind
  // white text, and uiSafety section 3 cannot see it because it only scans for the
  // FLAT C.primary pattern. This tool opts into --primary-solid (4.78:1) instead.
  assert.match(pfCss(), /\.pf-tool \.gh-pill\.is-active \{\s*background: var\(--primary-solid\)/,
    'the house pill token ships a known AA failure; a new control should not inherit it');
  const solid = /--primary-solid:\s*(#[0-9A-Fa-f]{6})/.exec(css());
  assert.ok(solid, '--primary-solid is missing from src/index.css');
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((t, v, i) => t + [0.2126, 0.7152, 0.0722][i] * v, 0);
  assert.ok(1.05 / (lum(solid[1]) + 0.05) >= 4.5,
    `--primary-solid ${solid[1]} no longer clears 4.5:1 behind white text`);
});

// ── 11. Navigation wiring and browser-side security (source scans) ───────────
//
// House idiom: read the monolith as text (uiSafety.test.mjs, studentProgress.test.mjs).
// There is no jsdom in this repo, so these pin the SHAPE of things no unit test can
// reach — and one of them, the sandbox flag list, guards a one-word regression that
// would hand the previewed document the app's localStorage.

const app = () => readFileSync(join(REPO, 'src/BookkeeperPro.jsx'), 'utf8');
/** One named module-scope object literal, by anchor. */
const literalOf = (src, name) => {
  const at = src.indexOf(`const ${name} = `);
  assert.ok(at > 0, `${name} was not found`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`${name} is unterminated`);
};
const componentBody = (src) => {
  const at = src.indexOf('function PortfolioGeneratorInner(');
  assert.ok(at > 0, 'PortfolioGeneratorInner was not found');
  const end = src.indexOf('\nfunction ', at + 10);
  return src.slice(at, end > 0 ? end : src.length);
};
/**
 * The component with every comment removed.
 *
 * ★ Necessary, not tidy: the comment EXPLAINING why allow-same-origin would be
 *   dangerous contains the word "localStorage", and a naive scan reads a warning
 *   about a hazard as the hazard. uiSafety section 19 strips comments for exactly
 *   this reason.
 */
const componentCode = (src) => componentBody(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

test('portfoliogenerator is in TAB_ROUTES with an unquoted key and its own path', () => {
  const routes = literalOf(app(), 'TAB_ROUTES');
  assert.match(routes, /\n {2}portfoliogenerator: '\/profile-optimization\/portfolio-generator',/,
    'the key must be an unquoted identifier — navRemoval.test.mjs counts routes with '
    + 'a /^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*:/ regex, and TOOL_COUNT derives from it');
  // The route sits between its two siblings, so the file reads in navigation order.
  const order = ['resumestrategy:', 'portfoliogenerator:', 'linkedinopt:']
    .map((k) => routes.indexOf(k));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'TAB_ROUTES should read in sidebar order');
});

test('VOICE_TAB_INFO has a matching Job Application entry', () => {
  // scripts/generate-voice-agent-knowledge.mjs HARD-fails on TAB_ROUTES <-> VOICE_TAB_INFO
  // drift, so this is belt-and-braces — but it fails here in one second rather than in
  // an npm script somebody may not run.
  const info = literalOf(app(), 'VOICE_TAB_INFO');
  const row = /portfoliogenerator: \{([^}]*)\}/.exec(info);
  assert.ok(row, 'the voice assistant cannot navigate to a tab it has no entry for');
  assert.match(row[1], /label: 'Portfolio Generator'/,
    'the label must match the sidebar item, the Dashboard tile and the SectionHead title '
    + 'exactly — it is the fuzzy-match key resolveVoiceTool uses');
  assert.match(row[1], /stage: 'Job Application'/,
    "the stage must be one of the generator's STAGE_ORDER values");
  assert.ok(!/adminOnly/.test(row[1]), 'this is a student tool, not an admin screen');
});

test('the voice aliases do not collide with ones already taken', () => {
  const aliases = literalOf(app(), 'VOICE_TOOL_ALIASES');
  for (const phrase of ['portfolio', 'portfolio generator', 'bookkeeper portfolio',
    'bookkeeping portfolio', 'create my portfolio']) {
    const key = /^[a-z]+$/.test(phrase) ? phrase : `'${phrase}'`;
    assert.ok(aliases.includes(`${key}: { tab: 'portfoliogenerator' }`),
      `"${phrase}" should reach the portfolio generator`);
  }
  // 'profile optimization' belongs to linkedinopt and 'profile' to the settings panel.
  assert.match(aliases, /'profile optimization': \{ tab: 'linkedinopt' \}/,
    'taking this phrase would silently break the booking page it already names');
});

test('renderToolContent has a one-line case for it', () => {
  assert.match(app(), /\n {4}case 'portfoliogenerator': return <BookkeeperPortfolioGenerator \/>;/,
    'navRemoval.test.mjs scans for the literal one-line `case \'<id>\':` form');
});

test('DEFAULT_STAGES names it in the group AND in the flat tabs list', () => {
  const src = app();
  const at = src.indexOf('const DEFAULT_STAGES');
  assert.ok(at > 0);
  const stages = src.slice(at, src.indexOf('\n  ];', at));
  // ★ BOTH are required. A grouped stage renders `g.tabIds.map(id => tabById[id])`,
  //   where tabById is built from stage.tabs — so a tab named in only one of the two
  //   is silently dropped from the sidebar with no error anywhere.
  assert.match(stages, /tabIds: \['resumestrategy', 'portfoliogenerator', 'linkedinopt'\]/,
    'the Profile Optimization group must list it between its two siblings');
  assert.match(stages, /\{ id: 'portfoliogenerator', label: 'Portfolio Generator',\s+icon: Briefcase \}/,
    'without a tabs[] entry there is no object for tabById to resolve');
  const tabs = stages.slice(stages.indexOf('tabs: ['));
  const order = ["id: 'resumestrategy'", "id: 'portfoliogenerator'", "id: 'linkedinopt'"]
    .map((k) => tabs.indexOf(k));
  assert.ok(order[0] < order[1] && order[1] < order[2],
    'the tabs[] order is what mergeStoredWithDefaults uses to place the tab in a saved layout');
});

test('the Dashboard tile group and tile list match the sidebar order', () => {
  const src = app();
  // "label: 'Job Application'" appears three times in this file — a roadmap strip,
  // DEFAULT_STAGES, and the Dashboard tiles — so anchor on stageTiles first.
  const tilesAt = src.indexOf('const stageTiles');
  assert.ok(tilesAt > 0, 'the Dashboard stageTiles array was not found');
  const at = src.indexOf("label: 'Job Application'", tilesAt);
  assert.ok(at > 0, 'the Dashboard Job Application stage was not found');
  const stage = src.slice(at, src.indexOf('\n    },', at));
  assert.match(stage, /tabIds: \['resumestrategy', 'portfoliogenerator', 'linkedinopt'\]/);
  assert.match(stage, /\{ id: 'portfoliogenerator', label: 'Portfolio Generator',\s+desc: 'Build and download a client-ready bookkeeping portfolio\.'/,
    'the Dashboard description is part of the spec and is what a student reads first');
  const order = ["id: 'resumestrategy'", "id: 'portfoliogenerator'", "id: 'linkedinopt'"]
    .map((k) => stage.lastIndexOf(k));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'the tiles must render in sidebar order');
});

test('it counts as a real tool and TOOL_COUNT stays derived', () => {
  const src = app();
  assert.ok(src.includes('const TOOL_COUNT = Object.keys(TAB_ROUTES)'),
    'TOOL_COUNT must never become a hardcoded number');
  const nonTool = /const NON_TOOL_TAB_IDS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(nonTool, 'NON_TOOL_TAB_IDS was not found');
  assert.ok(!nonTool[1].includes('portfoliogenerator'),
    'this is a toolkit tool, so it must increase the Dashboard tool count, not be excluded');
});

test('the wide-canvas allowlist stays an exception list, and says why', () => {
  const src = app();
  const m = /const WIDE_CANVAS_TABS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'WIDE_CANVAS_TABS was not found');
  const ids = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.ok(ids.includes('portfoliogenerator'),
    'a 460px editor beside a preview needs more than 1200px of canvas');
  assert.ok(ids.length <= 4, 'this is an exception list, not a redesign');
  // The comment above it must justify the new member, not just describe course pages.
  const comment = src.slice(src.lastIndexOf('//', src.indexOf('const WIDE_CANVAS_TABS')) - 1400,
    src.indexOf('const WIDE_CANVAS_TABS'));
  assert.match(comment, /760px/,
    'the comment must name the measurement that earned the exception, the way the course '
    + 'entry names its 744px video');
});

test('the sandbox on the preview frame is EXACTLY allow-scripts', () => {
  // ★ THE ONE-WORD REGRESSION THIS EXISTS FOR. A `srcdoc` document normally INHERITS
  //   its embedder's origin — which is how the standalone artifact's preview could read
  //   the app's localStorage, where the Supabase session lives. The sandbox attribute
  //   overrides that inheritance at document creation, and `allow-same-origin` is the
  //   only thing that clears it again.
  // ★ componentCode, NOT componentBody — AND THIS WAS A REAL BUG IN THIS TEST.
  //   componentBody keeps comments, and the JSX comment eight lines above the attribute
  //   contains the literal string `sandbox="allow-scripts"`. Because the regex is not
  //   global it returned that FIRST match, so the assertion read the comment on every
  //   run. Mutation-proved on copies: with componentBody, adding `allow-same-origin` to
  //   the real attribute still PASSED, and so did `allow-top-navigation`. The suite's
  //   flagship security assertion could not fail — while the componentCode docstring
  //   below it warned about exactly this ("a naive scan reads a warning about a hazard
  //   as the hazard"). Stripping comments makes both mutations fail as they must.
  const body = componentCode(app());
  const m = /sandbox="([^"]*)"/.exec(body);
  assert.ok(m, 'the preview iframe must carry an explicit sandbox attribute');
  const flags = m[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(flags, ['allow-scripts'],
    'allow-same-origin restores srcdoc origin inheritance and hands the previewed '
    + 'document the app\'s localStorage; allow-top-navigation lets a hostile URL repaint '
    + 'the toolkit; allow-popups, allow-forms and allow-modals are simply unnecessary '
    + `for a static document. Found: ${m[1]}`);
  // Belt and braces: the token must not appear ANYWHERE in the component's code — not in
  // a second sandbox attribute, not in a variable, not spread in from an object. The
  // regex above only ever inspects the first match.
  assert.equal(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(body), false,
    'no escape-hatch sandbox token may appear anywhere in this component');
  assert.equal((body.match(/<iframe/g) || []).length, 1, 'one frame, one place to get this wrong');
  assert.match(body, /title="Portfolio preview"/, 'a frame with no title is unlabelled for a screen reader');
});

test('the preview iframe is RECREATED per rebuild, so typing does not fill the Back button', () => {
  // ★ MEASURED IN CHROME, and it is not intuitive. Assigning `srcdoc` to an EXISTING
  //   iframe adds one entry to the joint session history PER ASSIGNMENT — 5 rebuilds
  //   gave +5 — so after typing one sentence the browser Back button walked backwards
  //   through stale previews and never left the tool. The URL did not even change, so
  //   there was nothing on screen to explain why Back appeared broken.
  //   Creating a FRESH iframe for each document adds none (5 rebuilds → +0), because the
  //   first navigation of a new browsing context is a replace rather than a push. The
  //   `key` is what makes React create one instead of mutating the attribute.
  //   Verified after the fix in a clean tab: 37 rebuilds → 0 entries, and ONE Back
  //   returned to the page the user came from.
  const body = componentBody(app());
  assert.match(body, /key=\{previewSeq\}/,
    'without a changing key React mutates srcdoc in place and every rebuild becomes a '
    + 'history entry');
  assert.match(body, /setPreviewSeq\(\(n\) => n \+ 1\)/,
    'the sequence must advance with the debounced preview draft, in the same effect');
  // ★ AND IT MUST ADVANCE AT EVERY SITE, NOT JUST THE ONE THAT WAS MEASURED.
  //   setPreviewDraft was called at five places and the bump at only one — the typing path.
  //   Load Sample, Clear, the mount restore and the résumé import each mutated the LIVE
  //   iframe and left a stray history entry, so Back stopped behaving predictably after any
  //   of them. It survived the original measurement precisely because it is one entry per
  //   ACTION rather than one per keystroke. The two writes are now inseparable: they live in
  //   one helper, and nothing outside it may touch either setter.
  const code = componentCode(app());
  const raw = (code.match(/setPreviewDraft\(/g) || []).length;
  const bumps = (code.match(/setPreviewSeq\(/g) || []).length;
  assert.equal(raw, 1, 'setPreviewDraft may be CALLED in exactly one place, the helper — '
    + `found ${raw}; a new caller must go through the helper instead`);
  assert.equal(bumps, 1, `setPreviewSeq likewise, in the same helper — found ${bumps}`);
  assert.match(code, /const pushPreview = useCallback\(\(next\) => \{\s*setPreviewDraft\(next\);\s*setPreviewSeq/,
    'one helper must perform both writes, so a future call site cannot do half of it');
  assert.ok((code.match(/pushPreview\(/g) || []).length >= 5,
    'every path that changes the preview document must go through it');
  // Remounting is only safe because the scroll offset lives in the markup.
  assert.match(app(), /data-pf-scroll/,
    'a remount discards the frame, so the scroll offset has to be restored from the '
    + 'document itself — this is exactly what that attribute is for');
});

test('the frame is authenticated by event.source, never by event.origin', () => {
  const body = componentBody(app());
  assert.match(body, /e\.source !== frameRef\.current\.contentWindow/,
    'a sandboxed frame\'s origin serialises to the STRING "null", which every other '
    + 'opaque-origin context on the page shares — so an origin check authenticates nothing');
  assert.ok(!/e\.origin ===/.test(body), 'an origin comparison here would be security theatre');
  assert.match(body, /Number\.isFinite\(y\)/, 'the only value accepted from the frame is a finite number');
});

test('nothing in this tool leaves the browser', () => {
  const body = componentBody(app());
  const code = componentCode(app());
  for (const forbidden of ['supabase', 'callClaude', 'fetch(', '/api/']) {
    assert.ok(!code.includes(forbidden),
      `the portfolio tool must not use ${forbidden} — a student's CV and headshot are `
      + 'exactly what must not be uploaded as a side effect of previewing a layout');
  }
});

test('the mobile pane toggle uses the hidden CLASS, not the hidden attribute', () => {
  // Tailwind preflight emits `[hidden] { display: none }` in the BASE layer, and
  // utilities come later at equal specificity — so `hidden={true}` on an element that
  // also carries `flex` or `grid` loses and the pane stays visible. TabPanel gets away
  // with the attribute only because it carries no display utility.
  const body = componentBody(app());
  assert.match(body, /showEditor \? 'block' : 'hidden'/,
    'the editor pane must toggle with the class');
  assert.match(body, /showPreview \? 'flex' : 'hidden'/,
    'the preview pane must toggle with the class');
  assert.ok(!/hidden=\{!show/.test(body), 'the attribute form would not hide a flex/grid pane');
});

test('the sticky offset is measured with a ResizeObserver and skips a hidden tab', () => {
  const body = componentBody(app());
  assert.match(body, /new ResizeObserver\(measure\)/,
    'collapsing the sidebar changes <main> by 212px and fires NO window resize event');
  assert.match(body, /if \(!panel \|\| panel\.hidden\) return;/,
    'a hidden keep-alive tab measures 0x0; writing that would clobber a good offset and, '
    + 'since the deps cannot see a tab switch, it would never be re-measured');
  assert.match(body, /parentElement\.tagName !== 'MAIN'/,
    'the header lookup must be scoped to this tool\'s own TabPanel — every visited tab '
    + 'stays mounted in <main>, so a document-wide query can measure a hidden tab\'s header');
});

test('the draft key is namespaced by window.storage and listed in LEGACY_KEYS', () => {
  const body = componentBody(app());
  assert.ok(!/localStorage/.test(componentCode(app())),
    'window.storage namespaces per user; raw localStorage would leak one account\'s draft to another');
  assert.match(app(), /const PF_DRAFT_KEY = 'portfolio:draft:v1';/);
  const legacy = readFileSync(join(REPO, 'src/auth/AuthProvider.jsx'), 'utf8');
  const keys = legacy.slice(legacy.indexOf('LEGACY_KEYS'), legacy.indexOf('LEGACY_MARKER'));
  assert.match(keys, /'portfolio:draft:v1'/, 'the persistence convention requires the entry');
});

test('a quota failure is detected from the RESOLVED value, not from a rejection', () => {
  // window.storage.set resolves `false` on a quota error and never rejects
  // (src/main.jsx), so a bare .catch() reports a silent success and the student loses
  // their work on reload having been told it saved.
  const body = componentBody(app());
  assert.match(body, /\.then\(\(r\) => r !== false\)/,
    'the resolved value is the only signal a quota failure gives');
  assert.match(body, /saved-no-photo/,
    'the photo is the largest field: drop it and retry before calling the save failed');
});

test('a field hint and error are wired to their control, for every field at once', () => {
  // ★ role="alert" announces on INSERTION. An error that is already present when the user
  //   arrives at the field — the normal case, because validation runs at download — is
  //   therefore announced to nobody. aria-describedby is what makes it part of the control.
  const app_ = app();
  const field = app_.slice(app_.indexOf('function PfField('));
  const body = field.slice(0, field.indexOf('\nfunction '));
  assert.match(body, /aria-describedby/, 'the control must reference its hint and error');
  assert.match(body, /aria-invalid/, 'an invalid control must say so programmatically');
  assert.match(body, /React\.cloneElement\(children/,
    'the wiring must be central — done per call site it stays half-done across ~30 fields');
  assert.match(body, /id=\{hintId\}/, 'the hint needs the id the control points at');
  assert.match(body, /id=\{errId\}/, 'and so does the error');
  // Error before hint, so the problem is read before the guidance is repeated.
  assert.match(body, /\[errId, hintId\]/, 'the error must be announced first');
  // An explicitly-passed aria-describedby must win, or the résumé dropzone loses its label.
  assert.match(body, /children\.props\['aria-describedby'\] \|\|/,
    'a control that already names its own description must keep it');
});

test('a multi-paragraph field keeps its paragraphs in the published page', () => {
  // ★ Six editor fields are textareas. normalizeDraft preserves their newlines correctly and
  //   they reach the HTML source intact — but HTML collapses whitespace, so a student's
  //   three-paragraph "About you" published as one wall of text. Their own writing, on the
  //   page they hand to a prospect.
  const html = download({ ...SAMPLE_DRAFT, summary: 'One.\n\nTwo.\nThree.' });
  assert.ok(html.includes('One.\n\nTwo.\nThree.'),
    'the newlines must reach the document — the loss was at the render sink, not the data');
  for (const sel of ['.hero h1', '.hero p.sub', '.abtext > p:not(.eyebrow)', '.svc p', '.quote blockquote']) {
    assert.ok(html.includes(sel), `${sel} must be in the pre-line rule`);
  }
  assert.match(html, /\.quote blockquote\{white-space:pre-line\}/,
    'the five prose sinks need white-space:pre-line, or every line break is dropped');
  // pre-line, not pre-wrap: runs of spaces and source indentation must still collapse.
  assert.equal(html.includes('white-space:pre-wrap'), false,
    'pre-wrap would preserve the template’s own indentation as visible whitespace');
  // The eyebrow is a <p> inside .abtext too, and must NOT be caught by the rule.
  assert.ok(html.includes(':not(.eyebrow)'), 'the eyebrow paragraph must be excluded');
  // And a newline must never become markup.
  const sneaky = download({ ...SAMPLE_DRAFT, summary: 'a\n<script>alert(1)</script>' });
  assert.equal(sneaky.includes('<script>alert(1)'), false, 'still escaped');
  assert.ok(sneaky.includes('&lt;script&gt;alert(1)'), 'and escaped as text');
});

test('a metric value can be cleared, and a minus sign survives being typed', () => {
  // ★ `Number('')` is 0, so the editor snapped an emptied field straight back to 0 and ate a
  //   lone leading "-" before it could become "-4". The engine's num() already treats '' and
  //   undefined as ABSENT, so the coercion belongs at render — where it already is.
  const body = componentCode(app());
  const metric = body.slice(body.indexOf("met-v-"), body.indexOf('met-v-') + 400);
  assert.equal(/value: Number\(v\)/.test(metric), false,
    'Number() in the editor makes the field impossible to clear');
  assert.match(metric, /value: v \}/, 'the raw string goes to state; the engine coerces it');
  // The engine must still publish a sane number for every shape the editor can now produce.
  for (const [raw, expect] of [['42', 42], ['-4', -4], ['', 0], ['abc', 0], ['3.5', 4]]) {
    const n = normalizeDraft({ ...SAMPLE_DRAFT, metrics: [{ value: raw, suffix: '%', label: 'x' }] });
    assert.equal(n.metrics[0].value, expect, `a metric typed as ${JSON.stringify(raw)} publishes as ${expect}`);
  }
});

test('the photo canvas is flattened onto white before it is drawn', () => {
  // ★ The re-encode to JPEG is what strips EXIF/GPS, and JPEG has no alpha — so without an
  //   opaque fill every transparent pixel of a cut-out PNG or WebP headshot composites
  //   against transparent black and the portrait ships as a black silhouette. Both formats
  //   are in PF_PHOTO_MIMES, so this is an ordinary file. No unit test can drive a canvas
  //   here (there is no jsdom in this repo), so the ORDER is pinned in the source.
  const body = componentCode(app());
  const fill = body.indexOf('ctx.fillRect(');
  const draw = body.indexOf('ctx.drawImage(');
  const encode = body.indexOf("toDataURL('image/jpeg'");
  assert.ok(fill > 0, 'the canvas must be filled with an opaque colour');
  assert.ok(draw > fill, 'the fill must come BEFORE the draw, or it paints over the face');
  assert.ok(encode > draw, 'and the encode after both');
  assert.match(body.slice(fill - 90, fill), /ctx\.fillStyle = '#(fff|ffffff)'/,
    'the fill must be white — black would read as a fault rather than a backdrop');
});

test('the object URL for a picked photo is always revoked', () => {
  const body = componentBody(app());
  const at = body.indexOf('async function pickPhoto(');
  assert.ok(at > 0, 'pickPhoto was not found');
  const fn = body.slice(at, body.indexOf('\n  }', at));
  assert.match(fn, /finally \{[\s\S]*URL\.revokeObjectURL\(url\)/,
    'a blob URL held open pins the whole file in memory for the life of the tab');
  assert.ok(!/image\/svg/.test(fn), 'SVG must not be in the accepted set — it carries script');
  // Module scope, so it lives outside the component body.
  assert.match(app(), /PF_PHOTO_MIMES = \['image\/jpeg', 'image\/png', 'image\/webp'\]/,
    'the accepted set must be an explicit allowlist, never an image\/* wildcard');
});

test('the resume file input is reset BEFORE its handler runs', () => {
  const body = componentBody(app());
  assert.match(body, /e\.target\.value = '';\s*\n\s*pickResume\(f\)/,
    'resetting after the handler means a file cannot be retried if the handler throws — '
    + "StatementConverter's input is never reset at all and silently ignores a re-pick");
});

test('pdf.js is imported dynamically, so it never reaches the main bundle', () => {
  const src = app();
  assert.ok(!/^import .*pdfjs-dist/m.test(src),
    'a static import would put 400 kB of PDF parser in front of every user of every tool');
  assert.match(src, /await Promise\.all\(\[\s*import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/,
    'the parser and its worker URL must both load on demand');
  assert.match(src, /isEvalSupported: false/, 'the PDF parser must not be allowed to eval');
  assert.ok(!/cMapUrl|standardFontDataUrl/.test(src),
    'both would be network requests; text extraction for Latin scripts needs neither');
  const vite = readFileSync(join(REPO, 'vite.config.js'), 'utf8');
  const chunks = vite.slice(vite.indexOf('manualChunks'), vite.indexOf('manualChunks') + 400);
  assert.ok(!/pdfjs/.test(chunks),
    'listing a dynamically-imported lib in manualChunks forces it back into a static chunk');
});

test('the tool renders no hand-rolled fixed overlay', () => {
  // container-type on .pf-tool makes it a containing block for position:fixed, so a
  // hand-rolled overlay would anchor to this tool's tall canvas rather than the
  // viewport. AccountModal and SidePanel portal to document.body.
  const body = componentBody(app());
  assert.ok(!/fixed inset-0/.test(componentCode(app())),
    'use AccountModal or SidePanel, which portal out');
  assert.match(body, /<AccountModal/, 'the confirmations must use the shared dialog shell');
  assert.ok(!/window\.confirm|window\.alert|[^.]\balert\(/.test(componentCode(app())),
    'the artifact used confirm() and alert(); both are unstyleable and untestable');
});

test('the component declares no component type inside a render', () => {
  const body = componentBody(app());
  assert.ok(!/\n\s+function [A-Z][A-Za-z0-9]*\(/.test(componentCode(app())),
    'a component type created during render is a new type every keystroke, so React '
    + 'remounts the subtree and every input loses focus mid-word');
});

test('the example draft is never the initial draft', () => {
  const body = componentBody(app());
  assert.match(body, /useState\(\(\) => lib\.emptyDraft\(\)\)/,
    'the artifact loaded its sample on mount, so every new user saw somebody else\'s '
    + 'name over invented testimonials');
  // ★ THE AUTOSAVE COMPARES AGAINST THE SEED. Two earlier gates were both wrong and
  //   both were caught in the browser: `draftCompletion(d).pct === 0` never fired (an
  //   untouched draft scores 8%, because showSamples defaults on), and
  //   `draftHasContent(d)` fired on a bare VISIT, because the prefilled
  //   profile.full_name is content — so opening the tab left a storage row behind in
  //   every user's browser.
  assert.match(body, /if \(seedRef\.current === null \|\| JSON\.stringify\(draft\) === seedRef\.current\) return undefined;/,
    'the autosave must not write until the draft differs from what the tool put there');
  assert.ok(!/draftCompletion\(draft\)\.pct === 0/.test(body),
    'completion cannot answer "did the student author anything" — 8% is the empty draft');
  // Every site that establishes a draft must stamp the seed, or the gate is wrong after it.
  const seedStamps = (body.match(/seedRef\.current = JSON\.stringify\(/g) || []).length;
  assert.ok(seedStamps >= 6,
    'restore, the prefilled seed, the no-storage path, Clear AND BOTH WRITE SUCCESS PATHS '
    + `must each re-stamp the seed — found ${seedStamps}`);
  // ★ A COMPLETED WRITE IS SUCH A SITE, and it was the one that was missed. Without it the
  //   seed stays the mount-time value forever, so the gate means "differs from what was on
  //   screen at mount" instead of "differs from storage": revert an edit and the write is
  //   skipped while the last dirty value stays on disk, under a "Saved" indicator.
  const saveArm = body.slice(body.indexOf('const write = (payload)'));
  const armEnd = saveArm.indexOf('setSaveState(\'failed\')');
  const writeArm = saveArm.slice(0, armEnd > 0 ? armEnd : 1200);
  assert.equal((writeArm.match(/seedRef\.current = JSON\.stringify\(/g) || []).length, 2,
    'both the full-draft and the photo-stripped write must stamp the seed with what they '
    + 'actually stored — stamping the full draft on the trimmed path would claim the photo '
    + 'is saved when it was dropped');
  assert.match(writeArm, /const trimmed = \{ \.\.\.draft, photo: '' \};/,
    'the trimmed payload must be named so the same value is both written and stamped');
  assert.match(body, /sampleFieldsStillPresent/,
    'the download step must name the fields still holding example content');
});
