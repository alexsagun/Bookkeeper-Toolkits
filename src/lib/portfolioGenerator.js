// ─────────────────────────────────────────────────────────────────────────────
// portfolioGenerator.js — PURE, dependency-free engine for the Bookkeeper
// Portfolio Generator (tab `portfoliogenerator`).
// ─────────────────────────────────────────────────────────────────────────────
// The tool takes a bookkeeper's details and emits a self-contained, offline,
// single-file portfolio website. Everything that decides what ends up in that
// file lives here: the draft shape, link and image validation, the section
// table, and the document builder. The React half in src/BookkeeperPro.jsx owns
// only the form, the sandboxed preview frame, and the two things that cannot be
// pure — reading a PDF and re-encoding a photo through a canvas.
//
// NO imports, NO side effects, NO DOM, NO network, NO Date. The single global
// used is the WHATWG `URL` parser, which is synchronous and resolves nothing
// remotely. Pinned by test/portfolioGenerator.test.mjs.
//
// ★ WHY THIS FILE EXISTS. It is ported from a standalone HTML artifact whose
//   `esc()` escaped `& < > "` and nothing else. `:` passed through untouched, so
//   a CTA of "javascript:alert(1)" landed verbatim in FOUR hrefs — the nav CTA,
//   the hero button, every package card, and the contact panel. In a hosted
//   portfolio that is stored XSS against the bookkeeper's own prospects. The
//   photo was interpolated into src="${d.photo}" with no escaping at all. Those
//   are not typos to patch in a template; they are the reason validation is a
//   tested module and the template is the only thing allowed to call it.
//
// ★ THE PARSED `protocol` IS THE ONLY SCHEME AUTHORITY.
//   Never decide a scheme by testing the raw string. WHATWG strips tab, LF and
//   CR *before* parsing, so "java\nscript:alert(1)" parses as `javascript:` and
//   sails straight through a /^javascript:/ guard.
//
// ★ `new URL(raw)` IS CALLED WITHOUT A BASE, ALWAYS.
//   Passing one would resolve "/dashboard" against the app's own origin and turn
//   a typo into a working same-site link.
//
// ★ `url.hostname`, NEVER `url.host`. `host` carries the port.
//
// ★ AN INVALID RESULT NEVER CARRIES AN `href`. The template binds to
//   `result.href` and to nothing else, so a rejected value has nothing to bind
//   to. Same rule for a photo: normalizeDraft DROPS an unsafe data URL rather
//   than carrying it as far as the renderer.
//
// ★ NO `Date` AND NO `toLocaleString`. The footer year and the filename date are
//   parameters, and money is formatted by hand. planCatalog.js:31 records the
//   lesson: a locale-dependent formatter makes the same draft render differently
//   on a de-DE ICU build, and makes a node:test assertion unreproducible.
//
// ★ ONE ORDERED SECTION TABLE, THREE CONSUMERS. The document body, the nav
//   links, and the completion meter all read PORTFOLIO_SECTIONS. The artifact
//   kept those in three places and they already disagreed: its nav emitted
//   <a href="#about"> when `summary` was set, while the section rendered
//   id="about" when `summary || education` was — so an education-only draft
//   rendered a section with no link to it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Layout constants, mirrored in the .pf-tool block of src/index.css ────────
// The CSS is the renderer; these are what the component measures against and
// what the test diffs the stylesheet with. Same contract as coursePlayerLayout.

/** Narrowest usable editor column, px. Below this the 13 accordions wrap badly. */
export const PF_EDITOR_MIN = 400;
/** Widest the editor column may grow — extra room belongs to the preview. */
export const PF_EDITOR_MAX = 460;
/** Narrowest pane that can host a scaled portfolio legibly, px. */
export const PF_PREVIEW_MIN = 560;
/** Gap between the two panes, px. */
export const PF_COL_GAP = 24;

/**
 * The container width at which the tool becomes two panes.
 *
 * ★ DERIVED, NEVER TYPED. A literal here could drift from the three numbers it
 *   is made of, and the drift would show up only as a cramped preview at one
 *   window size — the hardest kind of layout bug to attribute.
 */
export const PF_TWO_PANE_MIN = PF_EDITOR_MIN + PF_COL_GAP + PF_PREVIEW_MIN;

/**
 * Logical viewport widths the preview frame is rendered at, then CSS-scaled to
 * fit the pane.
 *
 * ★ THE PREVIEW IS SCALED, NOT SHRUNK, AND THAT IS LOAD-BEARING. The generated
 *   document has its own breakpoints at 760px (nav links hide, the about grid
 *   collapses) and 640px (transformation cards stack). A 460px editor plus the
 *   gap needs 1184px of tool width before the pane clears 760px — which a
 *   1440px laptop with the sidebar open does not have. Sizing the frame to the
 *   pane would show the MOBILE portfolio to someone designing the desktop one,
 *   with nothing on screen to reveal it.
 */
export const PF_LOGICAL_WIDTHS = Object.freeze({ desktop: 1200, tablet: 820, mobile: 390 });

/** Pre-measurement default for the sticky offset, px. Matches --course-rail-top. */
export const PF_HEAD_FALLBACK = 24;

// ── Value limits ────────────────────────────────────────────────────────────

export const PF_MAX_URL_LENGTH = 2048;
export const PF_MAX_EMAIL_LENGTH = 254;
/** Base64 payload cap for a stored photo. A 640px q0.82 JPEG lands 40–80 KB. */
export const PF_PHOTO_MAX_BASE64 = 200 * 1024;

export const PF_LIMITS = Object.freeze({
  shortText: 200,
  mediumText: 600,
  longText: 4000,
  list: 24,
  features: 12,
  toolLevelMin: 10,
  toolLevelMax: 100,
  metricAbsMax: 1e12,
});

// ── Primitives ──────────────────────────────────────────────────────────────

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
});

/**
 * Escape a value for HTML text or a double-quoted attribute.
 *
 * ★ ESCAPES `'` TOO. The artifact's esc() omitted the apostrophe, which was safe
 *   only while every attribute in its template used double quotes — an invariant
 *   one future style='…' destroys silently. Escaping it deletes the invariant.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const esc = escapeHtml;

/**
 * ★ EVERY CHARACTER CLASS IN THIS FILE IS SPELLED WITH \uXXXX ESCAPES, never
 *   the literal glyph. A bullet, a non-breaking space or a combining accent
 *   pasted into a regex is invisible in a diff, invisible in review, and
 *   silently a different codepoint from the one the next person types. These
 *   are hoisted rather than inlined so there is exactly one definition of
 *   "list-marker noise" for the resume parser to strip.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
/** Bullets, hollow/filled dots and dashes pdf.js hands back as list markers. */
const MARKER_CLASS = "\\u2022\\u00b7\\u25aa\\u25ab\\u25cb\\u25cf\\u25e6\\u2043";
const LEADING_MARKER = new RegExp("^[\\s" + MARKER_CLASS + "\\u2013\\u2014>*-]+");
const STARTS_WITH_MARKER = new RegExp("^[" + MARKER_CLASS + "\\u2013\\u2014-]");

function str(value, cap) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  const out = String(value).replace(CONTROL_CHARS, '').trim();
  return cap && out.length > cap ? out.slice(0, cap) : out;
}

function list(value, cap) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, cap || PF_LIMITS.list);
}

function num(value, fallback) {
  // ★ ABSENT IS NOT ZERO — and JavaScript disagrees. Number(null), Number(''),
  //   Number([]) and Number(false) are every one of them 0, so coercing blindly
  //   turned an unrated tool into level 0, which clamp() then published as "10%
  //   proficiency" in a tool the draft had never rated at all. Only a
  //   number-shaped value is coerced; anything else takes the caller's fallback,
  //   which is what "not specified" is supposed to mean.
  if (value === undefined || value === '') return fallback;
  if (typeof value === 'object' || typeof value === 'boolean') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Group digits with commas, without `toLocaleString`.
 *
 * ★ Deterministic on purpose. `toLocaleString()` with no locale renders 485000
 *   as "485.000" on a de-DE ICU build, so the same draft would produce a
 *   different document on a different machine and no test assertion could pin it.
 */
export function money(value) {
  const n = Math.round(num(value, 0));
  const abs = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `($${abs})` : `$${abs}`;
}

function relativeLuminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 0;
  const parts = [0, 2, 4].map((o) => parseInt(m[1].substr(o, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

/**
 * WCAG contrast ratio between two 6-digit hex colours.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 1..21
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The accent colour for text sitting ON the deep d1→d2 panels — the metric counters,
 * the contact links and the contact eyebrow.
 *
 * ★ IT CANNOT JUST BE `glow`, AND THE LIGHT THEME IS WHY. `glow` is tuned to sit on a
 *   very dark page, which is true of eight of the nine themes. `bluewhite` is the one
 *   light theme, and its panels are mid-blue (#0b46b8 → #1e73d8): its #78b0ff glow
 *   measured 2.75:1 there, failing both the 4.5 floor for the contact links (15px) and
 *   the 3.0 floor for the metric numbers. Measured, not guessed.
 * ★ AND IT CANNOT BE SOLVED BY DARKENING `glow` ITSELF, because `glow` is also the far
 *   end of the proficiency-bar gradient, which sits on a LIGHT chip — white there fades
 *   the bar to nothing. One value genuinely cannot serve both contexts, so the panel
 *   gets its own.
 * ★ The comparison uses the LIGHTER gradient stop (d2), because the gradient runs under
 *   the whole panel and text may sit over any point of it.
 *
 * @param {object} theme
 * @returns {string} the theme's own glow when it is legible there, else white
 */
export function onPanelGlow(theme) {
  const t = isTheme(theme) ? theme : FALLBACK_THEME;
  return contrastRatio(t.glow, t.d2) >= 4.5 ? t.glow : '#ffffff';
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return `rgba(127,127,127,${alpha})`;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`;
}

/**
 * Flatten a translucent hex overlay onto an opaque hex base.
 *
 * ★ WHY THIS EXISTS. Several surfaces in the generated document are a tint over a tint
 *   over the page — `.tside.after` is `rgba(accent,.14)` over `--glass` over `--pg2`.
 *   A contrast ratio measured against `--accent` or `--pg2` alone is therefore not the
 *   ratio a reader actually gets, and measuring the wrong pair is how eleven of eighteen
 *   Before/After label pairs came to sit below 4.5:1 while looking checked.
 */
function mixHex(fg, bg, alpha) {
  const p = (h) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(h || ''));
    return m ? parseInt(m[1], 16) : 0x808080;
  };
  const f = p(fg);
  const b = p(bg);
  const ch = (shift) => {
    const a = (f >> shift) & 255;
    const c = (b >> shift) & 255;
    return Math.round(a * alpha + c * (1 - alpha));
  };
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The first candidate colour that clears `min` against `bg`; the last one if none do.
 *
 * ★ The last candidate must therefore always be a colour known to pass — in practice
 *   `--head`, which is #ffffff or #12213b and clears 11:1 against every shipped page.
 *   This is the `onPanelGlow` pattern generalised: derive a legible colour from the
 *   theme rather than hand-tuning nine hexes and re-checking them by eye on every edit.
 */
function pickReadable(candidates, bg, min) {
  for (const c of candidates) {
    if (contrastRatio(c, bg) >= min) return c;
  }
  return candidates[candidates.length - 1];
}

// ── Themes ──────────────────────────────────────────────────────────────────

const THEME_HEX_KEYS = Object.freeze(['d1', 'd2', 'accent', 'accent2', 'glow', 'on', 'pg1', 'pg2']);

/**
 * The theme used when a draft names one the catalog does not have — a hand-edited
 * stored draft, a retired theme, a typo. Never null: the builder emits CSS custom
 * properties from these values unconditionally.
 */
export const FALLBACK_THEME = Object.freeze({
  key: 'navy',
  name: 'Navy & Teal',
  mode: 'dark',
  d1: '#0a1a2e', d2: '#123a5a', accent: '#19c2b3', accent2: '#12a99b',
  glow: '#5cf0e2', on: '#03231f', pg1: '#0b1f34', pg2: '#0f3340',
});

/**
 * True when every colour is a 6-digit hex and the mode is one of two literals.
 *
 * ★ The theme is the ONLY user-influenced value that reaches a <style> block, so
 *   it is the one place a CSS-injection could exist. Validating the shape means
 *   `themeCssVars` never has to trust its input, and a test can assert that
 *   every shipped theme passes rather than hoping.
 *
 * @param {unknown} theme
 * @returns {boolean}
 */
export function isTheme(theme) {
  if (!theme || typeof theme !== 'object') return false;
  if (theme.mode !== 'light' && theme.mode !== 'dark') return false;
  if (typeof theme.name !== 'string' || !theme.name.trim()) return false;
  return THEME_HEX_KEYS.every((k) => /^#[0-9a-f]{6}$/i.test(String(theme[k] || '')));
}

/**
 * Resolve a theme key (or an already-resolved object) against a theme map.
 *
 * @param {unknown} keyOrTheme
 * @param {Record<string, object>} [themeMap] normally PORTFOLIO_THEMES
 * @returns {object} always a valid theme — FALLBACK_THEME when nothing matches
 */
export function resolveTheme(keyOrTheme, themeMap) {
  if (isTheme(keyOrTheme)) return keyOrTheme;
  const key = typeof keyOrTheme === 'string' ? keyOrTheme : '';
  const found = themeMap && Object.prototype.hasOwnProperty.call(themeMap, key)
    ? themeMap[key] : null;
  if (isTheme(found)) return found.key ? found : { ...found, key };
  return FALLBACK_THEME;
}

// ── Link safety ─────────────────────────────────────────────────────────────

const LINK_MESSAGES = Object.freeze({
  'not-absolute': 'Paste the complete link, starting with https://',
  malformed: 'That isn’t a valid web address. Check for stray spaces or missing characters.',
  insecure: 'Use the https:// version of this link — http:// isn’t secure, and browsers warn visitors about it.',
  'not-https': 'Only https:// links can be used here.',
  credentials: 'Remove the username or password from the link (everything before the @).',
  'too-long': 'That link is too long. Use a short, shareable URL.',
  'bad-fragment': 'A link to a section on your own page should look like #services.',
});

function linkResult(kind, href, host, reason, upgraded) {
  return {
    kind,
    href: href || null,
    host: host || null,
    upgraded: !!upgraded,
    reason: reason || null,
    message: reason ? LINK_MESSAGES[reason] : null,
  };
}

function tryParseUrl(value) {
  try {
    // ★ No base argument — see the header.
    return new URL(value);
  } catch {
    return null;
  }
}

function classifyUrl(url) {
  // Credentials first: "https://calendly.com@evil.example" reads as trustworthy
  // precisely because the recognisable half is the username.
  if (url.username || url.password) return linkResult('invalid', null, null, 'credentials');
  if (url.protocol === 'http:') return linkResult('invalid', null, null, 'insecure');
  if (url.protocol !== 'https:') return linkResult('invalid', null, null, 'not-https');
  const host = url.hostname; // ★ hostname, never host — see the header.
  if (!host || !host.includes('.') || /\s/.test(host)) {
    return linkResult('invalid', null, null, 'malformed');
  }
  // ★ url.href, never the raw input. Normalizing is what percent-encodes " < >
  //   and folds an uppercase scheme, and it guarantees the stored value is
  //   byte-identical to the href the visitor clicks.
  return linkResult('external', url.href, host, null);
}

/**
 * Classify a user-supplied link. THE ONLY authority for any href the generated
 * document contains.
 *
 * ★ THE `https://` RETRY IS EXPLICIT AND RE-VALIDATES. People type
 *   "calendly.com/alex" — the artifact's own sample data carried
 *   `linkedin: 'linkedin.com/in/yourname'`. Without a retry every one of those
 *   users gets a dead CTA. The retry fires ONLY when the first parse THREW, never
 *   when it succeeded with a rejected scheme, or "javascript:alert(1)" would
 *   become "https://javascript:alert(1)" and pass.
 *
 * ★ `#fragment` IS ITS OWN BRANCH, BEFORE THE PARSE. `new URL('#services')`
 *   throws without a base, and passing a base is forbidden above.
 *
 * @param {unknown} raw
 * @returns {{
 *   kind: 'none'|'fragment'|'external'|'invalid',
 *   href: string|null,
 *   host: string|null,
 *   upgraded: boolean,
 *   reason: null|'not-absolute'|'malformed'|'insecure'|'not-https'|'credentials'|'too-long'|'bad-fragment',
 *   message: string|null,
 * }}
 */
export function safeLinkHref(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') {
    return linkResult('none', null, null, null);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return linkResult('none', null, null, null);
  if (trimmed.length > PF_MAX_URL_LENGTH) return linkResult('invalid', null, null, 'too-long');

  if (trimmed.charAt(0) === '#') {
    const id = trimmed.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      return linkResult('invalid', null, null, 'bad-fragment');
    }
    return linkResult('fragment', `#${id}`, null, null);
  }

  const direct = tryParseUrl(trimmed);
  if (direct) return classifyUrl(direct);

  // The parse threw, so there is no scheme at all. One retry, fully re-validated.
  const retried = tryParseUrl(`https://${trimmed}`);
  if (!retried) return linkResult('invalid', null, null, 'malformed');
  const out = classifyUrl(retried);
  return out.kind === 'external'
    ? linkResult('external', out.href, out.host, null, true)
    : out;
}

// ★ NO `%` IN THE LOCAL PART, and that omission is the whole defence.
//   `%` was here (the folk-standard email regex everyone copies has it) and it made
//   every other excluded character expressible, because the value is interpolated into
//   the href RAW. Measured: `x%0D%0ABcc%3A%20a%40evil.example@y.com` was accepted and
//   decodes to `mailto:x<CR><LF>Bcc: a@evil.example@y.com` — exactly the mail-header
//   injection the doc comment below claims the charset makes impossible. A `%` in a real
//   local part is legal but vanishingly rare, and this module refuses rather than guesses
//   (telHref already refuses a valid-looking extension rather than truncating it).
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function contactResult(kind, href, label, reason) {
  return { kind, href: href || null, label: label || null, reason: reason || null };
}

/**
 * SYNTHESISE a mailto: from a validated address. Never accepts a raw mailto.
 *
 * ★ THE THREAT IS MAIL-HEADER INJECTION, NOT XSS.
 *   "x@y.com?subject=hi&bcc=attacker@evil.example" pre-fills the VISITOR's mail
 *   client with a hidden BCC, and escapeHtml would happily let it through
 *   because nothing about it is HTML. The allowlist charset below permits no
 *   `?`, `&`, `%`, `,`, `;`, CR or LF, so there is nothing to inject into.
 *
 * @param {unknown} email
 * @returns {{ kind:'none'|'mailto'|'invalid', href:string|null, label:string|null, reason:string|null }}
 */
export function mailtoHref(email) {
  if (email === null || email === undefined || typeof email === 'object') {
    return contactResult('none', null, null, null);
  }
  const value = String(email).trim();
  if (!value) return contactResult('none', null, null, null);
  if (value.length > PF_MAX_EMAIL_LENGTH) return contactResult('invalid', null, null, 'too-long');
  if (!EMAIL_RE.test(value)) return contactResult('invalid', null, null, 'not-an-email');
  return contactResult('mailto', `mailto:${value}`, value, null);
}

/**
 * SYNTHESISE a tel: from a validated phone number.
 *
 * ★ NEVER TRUNCATE A PHONE NUMBER INTO A VALID-LOOKING WRONG ONE. The artifact
 *   did `phone.replace(/[^0-9+]/g,'')`, so "+1 (555) 123-4567 ext. 89" became
 *   `tel:+1555123456789` — a wrong number a visitor silently dials. Anything
 *   that is not one optional `+` followed by 7–15 digits yields NO LINK; the
 *   digits stay on the page as plain text, which is honest.
 *
 * @param {unknown} phone
 * @returns {{ kind:'none'|'tel'|'invalid', href:string|null, label:string|null, reason:string|null }}
 */
export function telHref(phone) {
  if (phone === null || phone === undefined || typeof phone === 'object') {
    return contactResult('none', null, null, null);
  }
  const value = String(phone).trim();
  if (!value) return contactResult('none', null, null, null);
  // Only formatting characters are removed. A stray letter (an extension, a
  // "call/text") therefore survives into the test below and fails it.
  const compact = value.replace(/[\s().\u2013\u2014-]/g, '');
  if (!/^\+?\d{7,15}$/.test(compact)) return contactResult('invalid', null, value, 'not-dialable');
  return contactResult('tel', `tel:${compact}`, value, null);
}

const PHOTO_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * True when a value is a photo data URL safe to bind to an <img src>.
 *
 * ★ THE ONLY PATH THIS EXISTS FOR is a draft restored from window.storage. A
 *   live pick is re-encoded through a canvas by the component and cannot be
 *   hostile — but a stored draft was JSON on disk, editable by anything.
 * ★ `image/svg+xml` IS REJECTED. SVG carries script, and the preview frame runs
 *   scripts. An <img> would not execute it today, but a `background-image` or a
 *   future direct embed would, and the rule should not depend on which element
 *   the template happens to use this year.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafePhotoDataUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.length > PF_PHOTO_MAX_BASE64 * 2) return false;
  const m = PHOTO_DATA_URL_RE.exec(value);
  if (!m) return false;
  const payload = m[2];
  if (payload.length > PF_PHOTO_MAX_BASE64) return false;
  return payload.length % 4 === 0;
}

// ── The draft ───────────────────────────────────────────────────────────────

/**
 * THE shape. Every field the builder reads, at its zero value.
 *
 * ★ Nothing here is frozen. The editor updates immutably (`{ ...draft, k: v }`)
 *   and rebuilds arrays wholesale; freezing the nested arrays would break the
 *   repeaters for no safety gain, because normalizeDraft is what guarantees the
 *   shape at every boundary.
 *
 * @returns {object}
 */
export function emptyDraft() {
  return {
    theme: 'navy',
    industry: '',
    fullName: '',
    credentials: '',
    title: '',
    location: '',
    email: '',
    phone: '',
    website: '',
    photo: '',
    heroHeadline: '',
    heroSub: '',
    ctaText: 'Book a free discovery call',
    ctaLink: '',
    painPoints: [],
    transformations: [],
    summary: '',
    services: [],
    packages: [],
    tools: [],
    industries: [],
    metrics: [],
    testimonials: [],
    education: [],
    showSamples: true,
    sampleCompany: 'Sample Client, LLC',
    samplePeriod: 'For the Year Ended December 31, 2025',
  };
}

function normalize(input, dropped) {
  const base = emptyDraft();
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const drop = (field) => { if (dropped && !dropped.includes(field)) dropped.push(field); };

  const d = base;
  d.theme = str(src.theme, 40) || base.theme;
  d.industry = str(src.industry, PF_LIMITS.shortText);
  d.fullName = str(src.fullName, PF_LIMITS.shortText);
  d.credentials = str(src.credentials, PF_LIMITS.shortText);
  d.title = str(src.title, PF_LIMITS.shortText);
  d.location = str(src.location, PF_LIMITS.shortText);
  d.email = str(src.email, PF_MAX_EMAIL_LENGTH);
  d.phone = str(src.phone, 60);
  d.website = str(src.website, PF_MAX_URL_LENGTH);
  d.heroHeadline = str(src.heroHeadline, PF_LIMITS.mediumText);
  d.heroSub = str(src.heroSub, PF_LIMITS.mediumText);
  d.ctaText = str(src.ctaText, PF_LIMITS.shortText) || base.ctaText;
  d.ctaLink = str(src.ctaLink, PF_MAX_URL_LENGTH);
  d.summary = str(src.summary, PF_LIMITS.longText);
  d.sampleCompany = str(src.sampleCompany, PF_LIMITS.shortText) || base.sampleCompany;
  d.samplePeriod = str(src.samplePeriod, PF_LIMITS.shortText) || base.samplePeriod;
  d.showSamples = src.showSamples === undefined ? base.showSamples : !!src.showSamples;

  // ★ An unsafe photo is DROPPED, not carried. See the header.
  if (src.photo !== undefined && src.photo !== null && src.photo !== '') {
    if (isSafePhotoDataUrl(src.photo)) d.photo = src.photo;
    else drop('photo');
  }

  // ★ Every list member is RE-SHAPED, not type-checked. The builder calls
  //   `(p.features || []).filter(f => f.trim())` and reads `.length` on each
  //   list, so a restored draft whose `features` holds a number, or whose
  //   `services` is an object, would throw inside the template and blank the
  //   whole preview with no error the user could act on.
  d.painPoints = list(src.painPoints)
    .map((v) => str(v, PF_LIMITS.mediumText))
    .filter(Boolean);

  d.transformations = list(src.transformations).map((v) => ({
    before: str(v && v.before, PF_LIMITS.mediumText),
    after: str(v && v.after, PF_LIMITS.mediumText),
  }));

  d.services = list(src.services).map((v) => ({
    name: str(v && v.name, PF_LIMITS.shortText),
    desc: str(v && v.desc, PF_LIMITS.mediumText),
  }));

  d.packages = list(src.packages).map((v) => ({
    name: str(v && v.name, PF_LIMITS.shortText),
    price: str(v && v.price, 40),
    period: str(v && v.period, 40),
    features: list(v && v.features, PF_LIMITS.features)
      .map((f) => str(f, PF_LIMITS.shortText)),
    featured: !!(v && v.featured),
  }));

  d.tools = list(src.tools).map((v) => ({
    name: str(v && v.name, PF_LIMITS.shortText),
    level: clamp(
      Math.round(num(v && v.level, 75)),
      PF_LIMITS.toolLevelMin,
      PF_LIMITS.toolLevelMax,
    ),
  }));

  d.industries = list(src.industries)
    .map((v) => str(v, PF_LIMITS.shortText))
    .filter(Boolean);

  d.metrics = list(src.metrics).map((v) => ({
    value: clamp(
      Math.round(num(v && v.value, 0)),
      -PF_LIMITS.metricAbsMax,
      PF_LIMITS.metricAbsMax,
    ),
    suffix: str(v && v.suffix, 12),
    label: str(v && v.label, PF_LIMITS.shortText),
  }));

  d.testimonials = list(src.testimonials).map((v) => ({
    quote: str(v && v.quote, PF_LIMITS.mediumText),
    name: str(v && v.name, PF_LIMITS.shortText),
    role: str(v && v.role, PF_LIMITS.shortText),
  }));

  d.education = list(src.education).map((v) => ({
    credential: str(v && v.credential, PF_LIMITS.shortText),
    detail: str(v && v.detail, PF_LIMITS.shortText),
  }));

  return d;
}

/**
 * Coerce anything into a complete draft. The single choke point for every
 * untrusted source: window.storage, the résumé parser, the shipped sample.
 *
 * Total by construction — never throws, never returns a partial object, and
 * never mutates its input.
 *
 * @param {unknown} input
 * @returns {object}
 */
export function normalizeDraft(input) {
  return normalize(input, null);
}

/**
 * Read a persisted draft.
 *
 * `window.storage.get()` resolves `{ value: string|null }` and never throws, so
 * the hostile inputs are null, '' and a string that is not what we wrote — the
 * last of which is reachable for real, because a build that stored a different
 * shape under this key is still sitting in a returning user's localStorage.
 *
 * ★ `recovered` EXISTS SO A PARSE BLIP CANNOT ERASE A GOOD DRAFT. Without it the
 *   caller cannot tell "nothing was saved" from "something was saved and we
 *   could not read it", and the safe-looking response to both — write the empty
 *   draft — destroys the second case.
 *
 * @param {string|null|undefined} raw
 * @returns {{ draft: object, recovered: boolean, dropped: string[] }}
 */
export function parseStoredDraft(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { draft: emptyDraft(), recovered: false, dropped: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { draft: emptyDraft(), recovered: false, dropped: [] };
  }
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed.draft && typeof parsed.draft === 'object' ? parsed.draft : parsed)
    : null;
  if (!payload) return { draft: emptyDraft(), recovered: false, dropped: [] };
  const dropped = [];
  return { draft: normalize(payload, dropped), recovered: true, dropped };
}

/**
 * Field-level warnings for the editor and the pre-download check.
 *
 * ★ ONLY `fullName` BLOCKS. A half-finished portfolio is still worth
 *   downloading, and a tool that refuses the download until everything is
 *   perfect is a tool nobody finishes.
 *
 * @param {object} draft
 * @returns {{ ok: boolean, fields: Record<string, {level:'error'|'warn', code:string, message:string}>, blocking: string[] }}
 */
export function validateDraft(draft) {
  const d = normalizeDraft(draft);
  const fields = {};
  const add = (field, level, code, message) => { fields[field] = { level, code, message }; };

  if (!d.fullName) add('fullName', 'error', 'required', 'Add your name — it headlines the portfolio and names the file.');
  if (!d.title) add('title', 'warn', 'empty', 'A professional title tells a visitor what you do in three words.');
  if (!d.heroHeadline) add('heroHeadline', 'warn', 'empty', 'The headline is the first line a prospect reads.');
  if (!d.summary && d.education.length === 0) add('summary', 'warn', 'empty', 'Without a summary or any credentials the About section is skipped entirely.');
  if (d.services.length === 0) add('services', 'warn', 'empty', 'With no services the portfolio never says what you actually do.');

  const emailCheck = mailtoHref(d.email);
  if (emailCheck.kind === 'invalid') add('email', 'warn', 'invalid', 'That email address is not valid, so no email link will appear.');
  const phoneCheck = telHref(d.phone);
  if (phoneCheck.kind === 'invalid') add('phone', 'warn', 'invalid', 'This number will show as text but will not be tappable — remove any extension or note.');
  const ctaCheck = safeLinkHref(d.ctaLink);
  if (ctaCheck.kind === 'invalid') add('ctaLink', 'warn', ctaCheck.reason, `${ctaCheck.message} Until then the button scrolls to your contact section.`);
  const siteCheck = safeLinkHref(d.website);
  if (siteCheck.kind === 'invalid') add('website', 'warn', siteCheck.reason, siteCheck.message);
  if (!d.email && !d.phone && siteCheck.kind !== 'external') {
    add('contact', 'warn', 'unreachable', 'Add at least one way to reach you — a portfolio with no contact details cannot convert.');
  }

  const blocking = Object.keys(fields).filter((k) => fields[k].level === 'error');
  return { ok: blocking.length === 0, fields, blocking };
}

/**
 * True when the draft holds anything the user actually authored.
 *
 * ★ THIS IS NOT `draftCompletion(d).pct > 0`, AND THE DIFFERENCE SHIPPED AS TWO BUGS.
 *   An untouched draft already scores 8%: `showSamples` defaults to true, so the
 *   sample-reports section counts as done and completion reports "authored" for a form
 *   nobody has typed into. Measured in the browser — the résumé import asked a
 *   brand-new user "You have already written something?" immediately after Clear, and
 *   the autosave persisted a blank draft on mount.
 *
 * ★ A DEFAULT IS NOT CONTENT. `theme`, `ctaText`, `showSamples`, `sampleCompany` and
 *   `samplePeriod` all arrive pre-filled, so their presence proves nothing — but a
 *   value DIFFERENT from the default does, because only a person changes one.
 *
 * @param {object} draft
 * @returns {boolean}
 */
export function draftHasContent(draft) {
  const d = normalizeDraft(draft);
  const base = emptyDraft();
  for (const key of ['industry', 'fullName', 'credentials', 'title', 'location', 'email',
    'phone', 'website', 'photo', 'heroHeadline', 'heroSub', 'summary', 'ctaLink']) {
    if (d[key]) return true;
  }
  for (const key of ['painPoints', 'transformations', 'services', 'packages', 'tools',
    'industries', 'metrics', 'testimonials', 'education']) {
    if (d[key].length) return true;
  }
  for (const key of ['theme', 'ctaText', 'sampleCompany', 'samplePeriod']) {
    if (d[key] !== base[key]) return true;
  }
  return d.showSamples !== base.showSamples;
}

/**
 * Fields that are SHARED DEFAULTS rather than example content, so holding the sample's
 * value is not a misrepresentation and must not be reported.
 *
 * ★ THIS IS AN EXCLUDE LIST, NOT AN INCLUDE LIST, and that inversion is the fix for a
 *   real hole. The include list held seven hand-typed keys and omitted `email`, `phone`,
 *   `website` and `credentials` — so a student could replace all seven, publish
 *   `mailto:jordan@example.com`, `tel:5550104477` and a postnominal `CB` they do not
 *   hold, and be told nothing was left to fix. Deriving the checked set from the sample
 *   itself means a field ADDED to SAMPLE_DRAFT is covered automatically instead of
 *   silently unguarded. Same reasoning as INTAKE_FIELDS in src/lib/enrollmentIntake.js:
 *   one registry, so rendered and checked cannot diverge.
 */
const SAMPLE_SHARED_DEFAULTS = Object.freeze([
  'theme', 'industry', 'ctaText', 'ctaLink', 'showSamples', 'sampleCompany', 'samplePeriod',
  'photo', 'title', 'industries', 'tools',
]);

/** Human labels for the fields that ARE example content. */
const SAMPLE_FIELD_LABELS = Object.freeze({
  fullName: 'Your name',
  credentials: 'Credentials after your name',
  location: 'Location',
  email: 'Contact email',
  phone: 'Contact phone',
  website: 'Website / LinkedIn',
  heroHeadline: 'Headline',
  heroSub: 'Headline sub-text',
  painPoints: 'Client pain points',
  transformations: 'Before / after',
  summary: 'About you',
  services: 'Services',
  packages: 'Packages & rates',
  metrics: 'Results / key numbers',
  testimonials: 'Testimonials',
  education: 'Education & certifications',
});

/**
 * Which fields still hold the shipped example content, verbatim.
 *
 * ★ WHY THIS IS A FUNCTION AND NOT A DISCLAIMER. "Load sample" fills the editor
 *   with invented, plausible-shaped client testimonials and results. A student
 *   who edits three fields and downloads has published two testimonials nobody
 *   gave and metrics nobody measured — under their own name. A banner at the top
 *   of the form is not read at download time; a list of the exact fields still
 *   carrying example text is.
 *
 * ★ A LIST IS COMPARED PER ITEM, NOT WHOLE. Whole-array equality was the second half of
 *   the same hole: edit ONE of two testimonials and the stringified arrays differ, so the
 *   field dropped out of the list entirely while the other testimonial — invented, and
 *   attributed to a named client — was still published. Editing the entry that looks
 *   wrong and leaving the rest is the single most likely thing a student does, and it
 *   turned the warning off. A guard that goes quiet on a partial edit is worse than no
 *   guard, because an empty list reads as an affirmative all-clear.
 *
 * @param {object} draft
 * @param {object} sample the SAMPLE_DRAFT from src/data/portfolio-generator.js
 * @returns {string[]} human labels, empty when nothing example-shaped remains
 */
export function sampleFieldsStillPresent(draft, sample) {
  if (!sample || typeof sample !== 'object') return [];
  const d = normalizeDraft(draft);
  const s = normalizeDraft(sample);
  const out = [];
  for (const key of Object.keys(s)) {
    if (SAMPLE_SHARED_DEFAULTS.includes(key)) continue;
    const a = d[key];
    const b = s[key];
    // Nothing in the sample to match means nothing to warn about.
    if (b === '' || b === null || b === undefined) continue;
    if (Array.isArray(b)) {
      if (b.length === 0) continue;
      const sampleItems = new Set(b.map((x) => JSON.stringify(x)));
      const hit = Array.isArray(a) && a.some((x) => sampleItems.has(JSON.stringify(x)));
      if (hit) out.push(SAMPLE_FIELD_LABELS[key] || key);
      continue;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) out.push(SAMPLE_FIELD_LABELS[key] || key);
  }
  return out;
}

// ── The sample financial statements ─────────────────────────────────────────

/**
 * The three sample statements as ROWS, not markup.
 *
 * ★ ROWS ARE THE WHOLE POINT. The artifact emitted HTML directly, so nothing
 *   could check the arithmetic — and the arithmetic was wrong. Its cash-flow
 *   operating components summed to 96,200 against a printed subtotal of 96,800,
 *   while the P&L and balance sheet were perfect and the cross-statement links
 *   (ending cash 86,300 = balance-sheet cash) both depended on 96,800. So the
 *   defect was in a COMPONENT, not the subtotal: depreciation is corrected from
 *   12,600 to 13,200 here, which is the only line nothing else constrains.
 *   The document's own footnote calls these figures "internally consistent" to
 *   an audience of accountants. Rows let node:test hold it to that.
 *
 * @returns {{ pl: object[], bs: object[], cf: object[] }}
 */
export function financialSampleRows() {
  return {
    pl: [
      { kind: 'group', label: 'Revenue', value: null },
      { kind: 'line', label: 'Sales / Service Revenue', value: 485000 },
      { kind: 'line', label: 'Other Income', value: 6200 },
      { kind: 'sub', label: 'Total Revenue', value: 491200 },
      { kind: 'group', label: 'Cost of Goods Sold', value: null },
      { kind: 'sub', label: 'Total COGS', value: 172500 },
      { kind: 'total', label: 'Gross Profit', value: 318700 },
      { kind: 'group', label: 'Operating Expenses', value: null },
      { kind: 'line', label: 'Payroll & Wages', value: 142000 },
      { kind: 'line', label: 'Rent & Utilities', value: 28400 },
      { kind: 'line', label: 'Software & Subscriptions', value: 9600 },
      { kind: 'line', label: 'Marketing & Advertising', value: 18200 },
      { kind: 'line', label: 'Insurance', value: 11300 },
      { kind: 'line', label: 'Other Operating', value: 14700 },
      { kind: 'sub', label: 'Total Operating Expenses', value: 224200 },
      { kind: 'total', label: 'Net Operating Income', value: 94500 },
      { kind: 'line', label: 'Interest Expense', value: 4100 },
      { kind: 'grand', label: 'Net Income', value: 90400 },
    ],
    bs: [
      { kind: 'group', label: 'Assets — Current', value: null },
      { kind: 'line', label: 'Cash & Equivalents', value: 86300 },
      { kind: 'line', label: 'Accounts Receivable', value: 52400 },
      { kind: 'line', label: 'Inventory', value: 23100 },
      { kind: 'line', label: 'Prepaid Expenses', value: 5200 },
      { kind: 'sub', label: 'Total Current Assets', value: 167000 },
      { kind: 'group', label: 'Assets — Fixed', value: null },
      { kind: 'line', label: 'Equipment (net)', value: 48600 },
      { kind: 'grand', label: 'Total Assets', value: 215600 },
      { kind: 'group', label: 'Liabilities — Current', value: null },
      { kind: 'line', label: 'Accounts Payable', value: 31700 },
      { kind: 'line', label: 'Credit Cards Payable', value: 8400 },
      { kind: 'line', label: 'Payroll Liabilities', value: 6900 },
      { kind: 'sub', label: 'Total Current Liabilities', value: 47000 },
      { kind: 'group', label: 'Liabilities — Long-Term', value: null },
      { kind: 'line', label: 'Notes Payable', value: 38200 },
      { kind: 'sub', label: 'Total Liabilities', value: 85200 },
      { kind: 'group', label: 'Equity', value: null },
      { kind: 'line', label: 'Owner’s Equity', value: 130400 },
      { kind: 'grand', label: 'Total Liabilities & Equity', value: 215600 },
    ],
    cf: [
      { kind: 'group', label: 'Cash Flow from Operating Activities', value: null },
      { kind: 'line', label: 'Net Income', value: 90400 },
      // 13,200, not the artifact's 12,600 — see the ★ above.
      { kind: 'line', label: 'Depreciation & Amortization', value: 13200 },
      { kind: 'line', label: '(Increase) in Accounts Receivable', value: -8300 },
      { kind: 'line', label: '(Increase) in Inventory', value: -4100 },
      { kind: 'line', label: 'Increase in Accounts Payable', value: 5600 },
      { kind: 'sub', label: 'Net Cash from Operations', value: 96800 },
      { kind: 'group', label: 'Investing Activities', value: null },
      { kind: 'line', label: 'Purchase of Equipment', value: -18000 },
      { kind: 'sub', label: 'Net Cash used in Investing', value: -18000 },
      { kind: 'group', label: 'Financing Activities', value: null },
      { kind: 'line', label: 'Loan Repayments', value: -9500 },
      { kind: 'line', label: 'Owner Distributions', value: -24000 },
      { kind: 'sub', label: 'Net Cash used in Financing', value: -33500 },
      { kind: 'total', label: 'Net Change in Cash', value: 45300 },
      { kind: 'line', label: 'Beginning Cash Balance', value: 41000 },
      { kind: 'grand', label: 'Ending Cash Balance', value: 86300 },
    ],
  };
}

// ── Document fragments ──────────────────────────────────────────────────────

function displayName(d) {
  return d.credentials ? `${d.fullName}, ${d.credentials}` : d.fullName;
}

function firstName(d) {
  // ★ .filter(Boolean) — the artifact's split(' ')[0] on a double-spaced name
  //   returned an empty string and the eyebrow read "About ".
  const parts = String(d.fullName || '').split(/\s+/).filter(Boolean);
  return parts[0] || 'me';
}

function initials(name) {
  // ★ The artifact produced "JU" for "Jordan  Reyes": split(' ') yielded an empty
  //   token, w[0] was undefined, and join gave "JundefinedR".
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * A metric suffix, spaced from the number when it is a word.
 *
 * ★ THE SPACE CANNOT LIVE IN THE DATA. normalizeDraft trims every text field, so a
 *   sample authored as " yrs" arrives as "yrs" and the counter renders "5yrs".
 *   Special-casing the trim would be fragile; separating here is also simply
 *   correct for anyone who types "yrs", "years" or "clients", while "+" and "%"
 *   stay tight against the number where they belong.
 *
 * @param {string} suffix
 * @returns {string}
 */
export function metricSuffix(suffix) {
  const s = String(suffix || '');
  return /^[A-Za-z]/.test(s) ? ` ${s}` : s;
}

/**
 * One row of a financial statement.
 *
 * ★ THE LABEL IS A ROW HEADER, NOT A CELL. These are three tables of bare numbers, and
 *   with two `<td>`s per row a screen reader reads "142,000" with nothing tying it to
 *   "Payroll & Wages". `<th scope="row">` is what makes the amount answer a question.
 *   A group heading spans both columns, so it is `scope="colgroup"`. The CSS gives
 *   `table.stmt th` exactly the `td` rules, so nothing moves by a pixel.
 */
function statementRow(row) {
  const cls = [row.kind === 'line' ? '' : row.kind, typeof row.value === 'number' && row.value < 0 ? 'neg' : '']
    .filter(Boolean).join(' ');
  if (row.kind === 'group') {
    return `<tr class="grp"><th colspan="2" scope="colgroup">${esc(row.label)}</th></tr>`;
  }
  const amount = row.value === null || row.value === undefined ? '' : money(row.value);
  return `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${esc(row.label)}</th>`
    + `<td class="amt">${esc(amount)}</td></tr>`;
}

/**
 * @param {Array} rows
 * @param {string} name the statement's own name, so the table is not anonymous
 */
function renderStatementTable(rows, name) {
  // ★ The caption and the column headers are VISUALLY HIDDEN, not absent. The company,
  //   statement name and period are already on screen in `.stmthead`, so showing them
  //   again would be duplication — but a caption is how a screen-reader user knows which
  //   of the three tables they have landed in, and `.stmthead` is a sibling div that no
  //   table semantics connect to this table.
  return `<table class="stmt">`
    + `<caption class="vh">${esc(name)} — illustrative sample figures for a fictional company</caption>`
    + `<thead class="vh"><tr><th scope="col">Line item</th><th scope="col">Amount (USD)</th></tr></thead>`
    + `<tbody>${rows.map(statementRow).join('')}</tbody>`
    + `</table>`;
}

function eyebrow(text, centered) {
  return `<p class="eyebrow${centered ? ' center' : ''}">${esc(text)}</p>`;
}

function sectionPain(d) {
  return `
    <section class="pain reveal">
      <div class="container">
        ${eyebrow('Does this sound familiar?')}
        <h2>If any of these keep you up at night, you’re exactly who I help.</h2>
        <div class="paingrid">
          ${d.painPoints.map((p) => `<div class="paincard"><span class="x" aria-hidden="true">✕</span><p>${esc(p)}</p></div>`).join('')}
        </div>
        <p class="painfoot">Good news: every one of these is fixable — and that’s the work I do every day.</p>
      </div>
    </section>`;
}

function sectionTransformations(d) {
  return `
    <section class="transform reveal">
      <div class="container">
        ${eyebrow('The transformation', true)}
        <h2 class="center">From messy books to money clarity</h2>
        <div class="tfgrid">
          ${d.transformations.map((tf) => `<div class="tfcard">
            <div class="tside before"><span class="tlab">Before</span><p>${esc(tf.before)}</p></div>
            <div class="tarrow" aria-hidden="true">→</div>
            <div class="tside after"><span class="tlab">After</span><p>${esc(tf.after)}</p></div>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function sectionMetrics(d) {
  return `
    <section class="metrics reveal">
      <div class="container"><div class="mpanel"><div class="mgrid">
        ${d.metrics.map((m) => {
    const suffix = metricSuffix(m.suffix);
    return `<div class="metric"><div class="num" data-count="${esc(String(m.value))}" data-suffix="${esc(suffix)}">0${esc(suffix)}</div><div class="mlabel">${esc(m.label)}</div></div>`;
  }).join('')}
      </div></div></div>
    </section>`;
}

function sectionServices(d) {
  return `
    <section id="services" class="services reveal">
      <div class="container">
        ${eyebrow('What I do for you', true)}
        <h2 class="center">Services built around your peace of mind</h2>
        <div class="svcgrid">
          ${d.services.map((s, i) => `<div class="svc"><div class="svcnum">${String(i + 1).padStart(2, '0')}</div><h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p></div>`).join('')}
        </div>
      </div>
    </section>`;
}

function sectionSamples(d) {
  const fs = financialSampleRows();
  return `
    <section id="samples" class="samples reveal">
      <div class="container">
        ${eyebrow('Work samples', true)}
        <h2 class="center">The reports you’ll get in your inbox every month</h2>
        <p class="samplesub center">Clean, accurate, decision-ready financials — here’s the quality you can expect.</p>
        <div class="stmttabs" role="group" aria-label="Choose a sample statement">
          <button type="button" class="stab active" data-tab="pl" aria-pressed="true">Profit &amp; Loss</button>
          <button type="button" class="stab" data-tab="bs" aria-pressed="false">Balance Sheet</button>
          <button type="button" class="stab" data-tab="cf" aria-pressed="false">Cash Flow</button>
        </div>
        <div class="stmtcard">
          <div class="stmthead"><strong>${esc(d.sampleCompany)}</strong><span class="stmttitle" id="stmtTitle">Profit &amp; Loss</span><span>${esc(d.samplePeriod)}</span></div>
          <div class="stmtpanel" data-panel="pl">${renderStatementTable(fs.pl, 'Profit & Loss')}</div>
          <div class="stmtpanel" data-panel="bs" style="display:none">${renderStatementTable(fs.bs, 'Balance Sheet')}</div>
          <div class="stmtpanel" data-panel="cf" style="display:none">${renderStatementTable(fs.cf, 'Cash Flow Statement')}</div>
          <p class="stmtnote">Illustrative sample only — these are demonstration figures for a fictional company, not a real client’s results.</p>
        </div>
      </div>
    </section>`;
}

function renderEducation(d) {
  if (d.education.length === 0) return '';
  return `
    <div class="edu">
      <h3>Education &amp; certifications</h3>
      <ul>${d.education.map((e) => `<li><strong>${esc(e.credential)}</strong>${e.detail ? ` — ${esc(e.detail)}` : ''}</li>`).join('')}</ul>
    </div>`;
}

function renderPhoto(d) {
  if (d.photo && isSafePhotoDataUrl(d.photo)) {
    return `<div class="abphoto"><img src="${esc(d.photo)}" alt="${esc(d.fullName || 'Portrait')}"></div>`;
  }
  return `<div class="abphoto ph"><span aria-hidden="true">${esc(initials(d.fullName))}</span></div>`;
}

function sectionAbout(d) {
  return `
    <section id="about" class="about reveal">
      <div class="container abgrid">
        <div class="abtext">
          ${eyebrow(`About ${firstName(d)}`)}
          <h2>More than a bookkeeper — a partner who keeps your numbers honest.</h2>
          ${d.summary ? `<p>${esc(d.summary)}</p>` : ''}
          ${renderEducation(d)}
        </div>
        ${renderPhoto(d)}
      </div>
    </section>`;
}

function sectionTools(d) {
  return `
    <section id="tools" class="tools reveal">
      <div class="container">
        ${/* A LITERAL ampersand: eyebrow() escapes its argument, so an &amp; here
              would be escaped a second time and the client would read the entity. */ ''}
        ${eyebrow('Tools & proficiency', true)}
        <h2 class="center">The stack I work in</h2>
        <div class="toolgrid">
          ${d.tools.map((t) => `<div class="tool"><div class="tlabel"><span>${esc(t.name)}</span><span>${esc(String(t.level))}%</span></div><div class="bar"><i style="--w:${esc(String(t.level))}%"></i></div></div>`).join('')}
        </div>
      </div>
    </section>`;
}

function sectionIndustries(d) {
  return `
    <section class="industries reveal">
      <div class="container center">
        ${eyebrow('Industries I know', true)}
        <h2 class="center">Experience across the businesses you run</h2>
        <div class="indwrap">${d.industries.map((i) => `<span class="indchip">${esc(i)}</span>`).join('')}</div>
      </div>
    </section>`;
}

function sectionPackages(d, ctx) {
  return `
    <section id="packages" class="packages reveal">
      <div class="container">
        ${eyebrow('Packages', true)}
        <h2 class="center">Simple, transparent pricing</h2>
        <div class="pkggrid">
          ${d.packages.map((p) => `<div class="pkg${p.featured ? ' feat' : ''}">${p.featured ? '<span class="badge">Most popular</span>' : ''}
            <h3>${esc(p.name)}</h3>
            <div class="price">${esc(p.price)}<small>${esc(p.period)}</small></div>
            <ul>${p.features.filter((f) => f.trim()).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
            <a href="${esc(ctx.cta)}"${ctx.ctaRel} class="pkgcta">Get started</a>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
}

function sectionTestimonials(d) {
  return `
    <section class="testi reveal">
      <div class="container">
        ${eyebrow('In their words', true)}
        <h2 class="center">Owners who stopped worrying about their books</h2>
        <div class="tgrid">
          ${d.testimonials.map((t) => `<figure class="quote"><div class="qm" aria-hidden="true">&ldquo;</div><blockquote>${esc(t.quote)}</blockquote><figcaption><strong>${esc(t.name)}</strong><span>${esc(t.role)}</span></figcaption></figure>`).join('')}
        </div>
      </div>
    </section>`;
}

/**
 * THE single ordering authority for the generated document.
 *
 * Read by exactly three consumers — the body, the nav links, and
 * draftCompletion's meter — so a section can never appear in one and not the
 * others. `anchor` is the id the section renders; `nav` is its link label, or
 * null for a section that is not linked.
 */
export const PORTFOLIO_SECTIONS = Object.freeze([
  { key: 'pain', label: 'Pain points', anchor: null, nav: null, has: (d) => d.painPoints.length > 0, render: sectionPain },
  { key: 'transform', label: 'Transformations', anchor: null, nav: null, has: (d) => d.transformations.length > 0, render: sectionTransformations },
  { key: 'metrics', label: 'Results', anchor: null, nav: null, has: (d) => d.metrics.length > 0, render: sectionMetrics },
  { key: 'services', label: 'Services', anchor: 'services', nav: 'Services', has: (d) => d.services.length > 0, render: sectionServices },
  { key: 'samples', label: 'Sample reports', anchor: 'samples', nav: 'Sample Works', has: (d) => !!d.showSamples, render: sectionSamples },
  { key: 'about', label: 'About you', anchor: 'about', nav: 'About', has: (d) => !!d.summary || d.education.length > 0, render: sectionAbout },
  { key: 'tools', label: 'Tools', anchor: 'tools', nav: null, has: (d) => d.tools.length > 0, render: sectionTools },
  { key: 'industries', label: 'Client industries', anchor: null, nav: null, has: (d) => d.industries.length > 0, render: sectionIndustries },
  { key: 'packages', label: 'Packages', anchor: 'packages', nav: 'Pricing', has: (d) => d.packages.length > 0, render: sectionPackages },
  { key: 'testimonials', label: 'Testimonials', anchor: null, nav: null, has: (d) => d.testimonials.length > 0, render: sectionTestimonials },
]);

function navLinks(live, ctx) {
  const items = live
    .filter((s) => s.nav && s.anchor)
    .map((s) => `<a href="#${s.anchor}">${esc(s.nav)}</a>`);
  items.push('<a href="#contact">Contact</a>');
  return items.join('');
}

function contactLinks(d) {
  const out = [];
  const mail = mailtoHref(d.email);
  if (mail.kind === 'mailto') out.push(`<a href="${esc(mail.href)}">${esc(mail.label)}</a>`);
  const tel = telHref(d.phone);
  if (tel.kind === 'tel') out.push(`<a href="${esc(tel.href)}">${esc(tel.label)}</a>`);
  else if (tel.kind === 'invalid') out.push(`<span>${esc(tel.label)}</span>`);
  const site = safeLinkHref(d.website);
  if (site.kind === 'external') {
    out.push(`<a href="${esc(site.href)}" target="_blank" rel="noopener noreferrer">${esc(site.host)}</a>`);
  }
  return out.join('');
}

function sectionNav(d, ctx, links) {
  return `<nav><div class="container">
  <span class="logo"><i aria-hidden="true"></i>${esc(d.fullName || 'Your Name')}</span>
  <div class="links">${links}</div>
  <a class="navcta" href="${esc(ctx.cta)}"${ctx.ctaRel}>${esc(ctx.ctaText)}</a>
</div></nav>`;
}

function sectionHero(d, ctx) {
  return `<header class="hero">
  <div class="container">
    <div class="avail"><span class="pulse" aria-hidden="true"></span> Available for new clients${d.location ? ` · ${esc(d.location)}` : ''}</div>
    <h1>${esc(d.heroHeadline || 'Clean books. Clear numbers. Zero stress.')}</h1>
    ${d.heroSub ? `<p class="sub">${esc(d.heroSub)}</p>` : ''}
    <div class="actions">
      <a class="btn-primary" href="${esc(ctx.cta)}"${ctx.ctaRel}>${esc(ctx.ctaText)}</a>
      ${d.services.length ? '<a class="btn-outline" href="#services">See how I help →</a>' : ''}
    </div>
  </div>
</header>`;
}

function sectionContact(d, ctx) {
  const links = contactLinks(d);
  return `<section id="contact" class="contact reveal">
  <div class="container"><div class="cpanel"><div class="cinner">
    <p class="eyebrow center glowtext">Let’s talk</p>
    <h2>Ready to stop worrying about your books?</h2>
    <p class="lead">Book a quick, no-pressure call and let’s see if we’re a fit.</p>
    <a class="btn-primary inline" href="${esc(ctx.cta)}"${ctx.ctaRel}>${esc(ctx.ctaText)}</a>
    ${links ? `<div class="contactlinks">${links}</div>` : ''}
  </div></div></div>
</section>`;
}

function sectionFooter(d, ctx) {
  const who = displayName(d) || 'Your Name';
  return `<footer>© <span id="yr">${esc(String(ctx.year))}</span> ${esc(who)} · ${esc(d.title || 'Bookkeeping & Accounting')}</footer>`;
}

function backdrop() {
  return '<div class="bgwrap" aria-hidden="true"><span class="orb a"></span><span class="orb b"></span><span class="orb c"></span></div>';
}

// ── Theme CSS + the static stylesheet ───────────────────────────────────────

/**
 * The theme's custom properties.
 *
 * ★ `--accent-tint` IS PRECOMPUTED HERE, not written as `color-mix()`. The
 *   artifact used `color-mix(in srgb, var(--accent) 14%, transparent)` for the
 *   "after" half of every transformation card, so on an engine without
 *   color-mix the panel that carries the good news rendered with no tint at all.
 *   A theme colour is a known hex at build time; there is nothing to compute in
 *   the browser.
 */
export function themeCssVars(theme) {
  const t = isTheme(theme) ? theme : FALLBACK_THEME;
  const dark = t.mode === 'dark';
  const head = dark ? '#ffffff' : '#12213b';
  // The two transformation-card tints, flattened, so the label colours are chosen against
  // the surface a reader actually sees rather than against --accent or --pg2.
  const glassBase = mixHex('#ffffff', t.pg2, dark ? 0.06 : 0.55);
  const beforeBg = mixHex('#ff6b5e', glassBase, 0.14);
  const afterBg = mixHex(t.accent, glassBase, 0.14);
  return `
    :root{
      --focus-ring:${pickReadable([t.glow, t.accent, head], t.pg2, 3)};
      --tlab-before:${pickReadable(['#ff8b7f', head], beforeBg, 4.5)};
      --tlab-after:${pickReadable([t.accent, head], afterBg, 4.5)};
      --d1:${t.d1};--d2:${t.d2};--accent:${t.accent};--accent2:${t.accent2};--glow:${t.glow};--on:${t.on};
      --pg1:${t.pg1};--pg2:${t.pg2};
      --glow-on-panel:${onPanelGlow(t)};
      --accent-tint:${hexToRgba(t.accent, 0.14)};
      --accent-soft:${hexToRgba(t.accent, 0.28)};
      --text:${dark ? '#d7e1ec' : '#33465a'};
      --soft:${dark ? '#9db0c6' : '#5f7488'};
      --head:${dark ? '#ffffff' : '#12213b'};
      --glass:${dark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.55)'};
      --glassBrd:${dark ? 'rgba(255,255,255,.15)' : 'rgba(255,255,255,.8)'};
      --chip:${dark ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.62)'};
      --line:${dark ? 'rgba(255,255,255,.12)' : 'rgba(13,33,55,.10)'};
    }`;
}

/**
 * The generated document's stylesheet. A frozen constant — no interpolation, so
 * no user value can reach it.
 *
 * ★ EVERY auto-fit track floor here is wrapped in `min(…, 100%)`, and that is not
 *   decoration. A bare `minmax(300px, 1fr)` track CANNOT shrink below 300px, so on a
 *   320px phone — where `.container` leaves 272px after its 24px gutters — the
 *   testimonial grid ran 28px wider than the page and the tool grid 8px wider.
 *   `body{overflow-x:hidden}` clipped the evidence, but `<html>` does not, so the page
 *   scrolled sideways: measured at a real emulated 320x568, scrollWidth 325 against a
 *   320 viewport. `min(Npx, 100%)` lets a track collapse to its container when the
 *   container is the smaller of the two, and changes nothing at any width that could
 *   already fit the floor. It must hold for all six grids, not only the two that
 *   happened to be over the line — a wider gutter or a longer label moves that line.
 *
 * ★ `white-space: pre-line` ON THE FIVE PROSE SINKS IS WHAT KEEPS THE STUDENT'S OWN
 *   PARAGRAPHS. Six editor fields are textareas and `normalizeDraft` correctly preserves
 *   their newlines, but HTML collapses whitespace — so a three-paragraph "About you"
 *   published as one wall of text. Measured: the newlines reach the source intact and
 *   render as a single run-on paragraph. `pre-line` rather than `pre-wrap` because it
 *   honours line breaks while still collapsing runs of spaces and indentation, which is
 *   what prose wants. It has no escaping implications — `escapeHtml` still runs, so a
 *   newline can never become markup. Package `features` are deliberately NOT in the list:
 *   they are already split on newlines into a real list.
 *
 * ★ And the explanation lives HERE rather than in a `/* *\/` inside the template,
 *   because everything inside the template is shipped: a comment in there is an
 *   internal engineering note published in the student's own portfolio file.
 */
export const PORTFOLIO_CSS = `
    *{box-sizing:border-box;margin:0;padding:0}
    html{scroll-behavior:smooth;min-height:100%;background:linear-gradient(160deg,var(--pg1),var(--pg2))}
    body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:var(--text);line-height:1.6;min-height:100vh;overflow-x:hidden;background:transparent;overflow-wrap:break-word}
    a{color:inherit}
    .bgwrap{position:fixed;inset:0;z-index:-1;overflow:hidden;background:linear-gradient(160deg,var(--pg1),var(--pg2))}
    .orb{position:absolute;border-radius:50%;filter:blur(80px)}
    .orb.a{width:520px;height:520px;background:var(--accent);top:-140px;right:-120px;opacity:.45;animation:float 15s ease-in-out infinite}
    .orb.b{width:460px;height:460px;background:var(--glow);bottom:-160px;left:-120px;opacity:.30;animation:float 19s ease-in-out infinite reverse}
    .orb.c{width:400px;height:400px;background:var(--accent2);top:44%;left:60%;opacity:.20;animation:float 23s ease-in-out infinite}
    @keyframes float{0%,100%{transform:translate(0,0)}50%{transform:translate(34px,-30px)}}
    .container{max-width:1080px;margin:0 auto;padding:0 24px}
    .eyebrow{color:var(--accent);font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:13px;margin-bottom:10px}
    .eyebrow.center,.center{text-align:center}
    .glowtext{color:var(--glow-on-panel)}
    h2{font-size:clamp(24px,3.6vw,36px);line-height:1.2;color:var(--head);margin-bottom:14px}
    h2.center{margin-left:auto;margin-right:auto;max-width:780px}
    section{padding:72px 0;position:relative}
    nav{position:sticky;top:0;z-index:50;background:var(--glass);-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);border-bottom:1px solid var(--glassBrd)}
    nav .container{display:flex;align-items:center;gap:20px;padding:14px 24px}
    nav .logo{font-weight:800;display:flex;align-items:center;gap:9px;color:var(--head)}
    nav .logo i{width:11px;height:11px;background:var(--accent);border-radius:3px}
    nav .links{margin-left:auto;display:flex;gap:22px}
    nav .links a{color:var(--text);text-decoration:none;font-size:14.5px;font-weight:600;opacity:.85}
    nav .links a:hover,nav .links a:focus-visible{opacity:1;color:var(--head)}
    nav .navcta{background:var(--accent);color:var(--on);padding:9px 16px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 6px 18px rgba(0,0,0,.18)}
    @media(max-width:760px){nav .links{display:none}nav .container{gap:12px}}
    :focus-visible{outline:2px solid var(--focus-ring);outline-offset:3px}
    .hero h1,.hero p.sub,.abtext > p:not(.eyebrow),.svc p,.quote blockquote{white-space:pre-line}
    .hero{position:relative;color:#fff;padding:104px 0 112px;overflow:hidden;background:linear-gradient(150deg,var(--d1),var(--d2))}
    .hero:before{content:"";position:absolute;inset:0;background:radial-gradient(760px 380px at 78% -10%,rgba(255,255,255,.16),transparent)}
    .hero:after{content:"";position:absolute;width:360px;height:360px;border-radius:50%;background:var(--accent);filter:blur(90px);opacity:.5;top:-80px;right:6%;animation:float 13s ease-in-out infinite}
    .hero .container{position:relative;z-index:2;max-width:860px}
    .hero .avail{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);padding:7px 15px;border-radius:30px;font-size:13px;margin-bottom:22px;color:#fff}
    .hero .avail .pulse{width:8px;height:8px;border-radius:50%;background:var(--glow-on-panel);animation:pulse 2s infinite}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.5)}70%{box-shadow:0 0 0 12px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
    .hero h1{font-size:clamp(30px,5.2vw,52px);line-height:1.08;margin-bottom:20px;letter-spacing:-.5px;color:#fff}
    .hero p.sub{font-size:clamp(16px,2vw,20px);color:rgba(255,255,255,.85);max-width:680px;margin-bottom:32px}
    .hero .actions{display:flex;gap:14px;flex-wrap:wrap}
    .btn-primary{background:var(--accent);color:var(--on);padding:15px 26px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;transition:.18s;box-shadow:0 12px 30px rgba(0,0,0,.28)}
    .btn-primary.inline{display:inline-block}
    .btn-primary:hover{transform:translateY(-2px);filter:brightness(1.08)}
    .btn-outline{border:1px solid rgba(255,255,255,.5);color:#fff;background:rgba(255,255,255,.08);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);padding:15px 24px;border-radius:12px;text-decoration:none;font-weight:600;font-size:16px}
    .btn-outline:hover{background:rgba(255,255,255,.16)}
    .paingrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px;margin-top:30px}
    .paincard{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);border:1px solid var(--glassBrd);border-left:4px solid #ff6b5e;border-radius:16px;padding:20px;display:flex;gap:12px;align-items:flex-start;box-shadow:0 10px 30px rgba(0,0,0,.14),inset 0 1px 0 rgba(255,255,255,.22)}
    .paincard .x{color:#ff6b5e;font-weight:800;flex:none;margin-top:1px}
    .paincard p{color:var(--text);font-size:15px}
    .painfoot{margin-top:26px;font-size:17px;color:var(--head);font-weight:600;text-align:center}
    .transform .tfgrid{display:grid;gap:16px;margin-top:34px;max-width:900px;margin-inline:auto}
    .tfcard{display:grid;grid-template-columns:1fr auto 1fr;align-items:stretch;border-radius:16px;overflow:hidden;border:1px solid var(--glassBrd);background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);box-shadow:0 12px 34px rgba(0,0,0,.16)}
    .tside{padding:20px 22px}
    .tside.before{background:rgba(255,107,94,.14);border-left:4px solid #ff6b5e}
    .tside.after{background:var(--accent-tint);border-right:4px solid var(--accent)}
    .tlab{display:inline-block;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px}
    .before .tlab{color:var(--tlab-before)}.after .tlab{color:var(--tlab-after)}
    .tside p{color:var(--text);font-size:15px}
    .tarrow{display:grid;place-items:center;background:var(--accent);color:var(--on);font-size:22px;font-weight:800;padding:0 16px}
    @media(max-width:640px){.tfcard{grid-template-columns:1fr}.tarrow{padding:8px}.tside.after{border-right:0;border-left:4px solid var(--accent)}}
    .metrics{padding:44px 0 72px}
    .mpanel{position:relative;overflow:hidden;background:linear-gradient(120deg,var(--d1),var(--d2));border:1px solid var(--glassBrd);border-radius:24px;padding:42px 30px;box-shadow:0 24px 60px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.18)}
    .mpanel:before{content:"";position:absolute;inset:0;background:radial-gradient(600px 200px at 18% 0,rgba(255,255,255,.14),transparent)}
    .mgrid{position:relative;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:24px;text-align:center}
    .metric .num{font-size:clamp(34px,5vw,48px);font-weight:800;color:var(--glow-on-panel);line-height:1}
    .metric .mlabel{color:rgba(255,255,255,.78);font-size:14px;margin-top:8px}
    .svcgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr));gap:20px;margin-top:34px}
    .svc{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);border:1px solid var(--glassBrd);border-radius:18px;padding:26px 24px;transition:.2s;box-shadow:0 10px 30px rgba(0,0,0,.14),inset 0 1px 0 rgba(255,255,255,.22)}
    .svc:hover{transform:translateY(-4px);box-shadow:0 20px 44px rgba(0,0,0,.22)}
    .svcnum{color:var(--accent);font-weight:800;font-size:15px;letter-spacing:1px;margin-bottom:10px}
    .svc h3{color:var(--head);font-size:19px;margin-bottom:8px}
    .svc p{color:var(--soft);font-size:14.5px}
    .samplesub{color:var(--soft);max-width:620px;margin:0 auto 26px}
    .stmttabs{display:flex;gap:10px;justify-content:center;margin-bottom:20px;flex-wrap:wrap}
    .stab{background:var(--glass);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid var(--glassBrd);color:var(--head);font-weight:700;font-size:14px;padding:10px 22px;border-radius:30px;cursor:pointer;transition:.15s;font-family:inherit}
    .stab.active{background:var(--accent);color:var(--on);border-color:transparent;box-shadow:0 8px 20px rgba(0,0,0,.2)}
    .stmtcard{max-width:620px;margin:0 auto;background:rgba(255,255,255,.92);-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,.85);border-radius:20px;box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden;color:#33465a}
    .stmthead{padding:22px 26px 16px;border-bottom:2px solid var(--d1);text-align:center}
    .stmthead strong{display:block;font-size:18px;color:#12213b}
    .stmthead .stmttitle{display:block;color:var(--accent2);font-weight:700;font-size:14px;margin:4px 0 2px;text-transform:uppercase;letter-spacing:1px}
    .stmthead span{color:#5f7488;font-size:13px}
    .stmtwrap{overflow-x:auto}
    table.stmt{width:100%;border-collapse:collapse;font-size:14px}
    table.stmt td,table.stmt th{padding:8px 26px;color:#33465a;font-weight:inherit;text-align:left}
    /* Visually hidden but present for assistive tech — the caption and column headers. */
    .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
    table.stmt td.amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    table.stmt tr.neg td.amt{color:#c0392b}
    table.stmt tr.grp th{background:#f3f7fc;color:#12213b;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.5px;padding-top:12px;padding-bottom:8px}
    table.stmt tr.sub td,table.stmt tr.sub th{border-top:1px solid #e5edf5;font-weight:600;color:#12213b}
    table.stmt tr.total td,table.stmt tr.total th{border-top:1px solid #e5edf5;font-weight:700;color:#12213b}
    table.stmt tr.grand td,table.stmt tr.grand th{border-top:2px solid var(--d1);border-bottom:2px solid var(--d1);font-weight:800;color:#12213b;background:#f8fbff}
    .stmtnote{padding:14px 26px;color:#6b7a8c;font-size:12px;font-style:italic;text-align:center}
    .abgrid{display:grid;grid-template-columns:1.4fr 1fr;gap:44px;align-items:center}
    .about p{color:var(--text);margin-bottom:14px}
    .edu{margin-top:22px;background:var(--glass);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid var(--glassBrd);border-radius:14px;padding:18px 20px}
    .edu h3{font-size:14px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:10px}
    .edu ul{list-style:none}.edu li{padding:4px 0;color:var(--text);font-size:14.5px}
    .abphoto img{width:100%;border-radius:20px;box-shadow:0 24px 50px rgba(0,0,0,.28);display:block}
    .abphoto.ph{aspect-ratio:1;border-radius:20px;background:linear-gradient(160deg,var(--d1),var(--accent));display:grid;place-items:center;box-shadow:0 24px 50px rgba(0,0,0,.28);border:1px solid var(--glassBrd)}
    .abphoto.ph span{color:#fff;font-size:64px;font-weight:800;letter-spacing:2px}
    @media(max-width:760px){.abgrid{grid-template-columns:1fr}.abphoto{max-width:280px}}
    .toolgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:18px 40px;margin-top:34px}
    .tlabel{display:flex;justify-content:space-between;font-weight:600;color:var(--head);font-size:14.5px;margin-bottom:7px}
    .bar{height:10px;background:var(--chip);border:1px solid var(--glassBrd);border-radius:6px;overflow:hidden}
    .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--glow));border-radius:6px;transition:width 1.1s cubic-bezier(.2,.7,.2,1)}
    .bar.go i{width:var(--w)}
    .indwrap{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:26px}
    .indchip{background:var(--glass);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid var(--glassBrd);color:var(--head);padding:10px 18px;border-radius:30px;font-weight:600;font-size:14.5px;box-shadow:0 6px 16px rgba(0,0,0,.12)}
    .pkggrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:20px;margin-top:34px;align-items:stretch}
    .pkg{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);border:1px solid var(--glassBrd);border-radius:20px;padding:30px 26px;position:relative;display:flex;flex-direction:column;box-shadow:0 12px 34px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.22)}
    .pkg.feat{border:1.5px solid var(--accent);box-shadow:0 22px 50px rgba(0,0,0,.26)}
    .badge{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--accent);color:var(--on);font-size:12px;font-weight:800;padding:5px 14px;border-radius:20px;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,.2)}
    .pkg h3{color:var(--head);font-size:20px;margin-bottom:8px}
    .price{font-size:34px;font-weight:800;color:var(--head);margin-bottom:16px}
    .price small{font-size:15px;color:var(--soft);font-weight:600}
    .pkg ul{list-style:none;margin-bottom:22px;flex:1}
    .pkg li{padding:7px 0 7px 26px;position:relative;color:var(--text);font-size:14.5px;border-bottom:1px solid var(--line)}
    .pkg li:before{content:"✓";position:absolute;left:0;color:var(--accent);font-weight:800}
    .pkgcta{display:block;text-align:center;background:var(--chip);border:1px solid var(--glassBrd);color:var(--head);text-decoration:none;padding:13px;border-radius:12px;font-weight:700;transition:.18s}
    .pkg.feat .pkgcta{background:var(--accent);color:var(--on);border-color:transparent}
    .pkgcta:hover{filter:brightness(1.06)}
    .tgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:20px;margin-top:34px}
    .quote{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);border:1px solid var(--glassBrd);border-radius:18px;padding:30px 28px;position:relative;box-shadow:0 12px 34px rgba(0,0,0,.14)}
    .quote .qm{font-size:60px;color:var(--accent);opacity:.4;font-weight:800;line-height:.5;height:26px;font-family:Georgia,serif}
    .quote blockquote{color:var(--text);font-size:16px;font-style:italic;margin:6px 0 18px}
    .quote figcaption strong{color:var(--head);display:block}
    .quote figcaption span{color:var(--soft);font-size:13.5px}
    .contact .cpanel{position:relative;overflow:hidden;text-align:center;background:linear-gradient(150deg,var(--d1),var(--d2));border:1px solid var(--glassBrd);border-radius:26px;padding:60px 30px;box-shadow:0 24px 60px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.18)}
    .contact .cpanel:before{content:"";position:absolute;inset:0;background:radial-gradient(600px 240px at 50% 0,rgba(255,255,255,.14),transparent)}
    .contact .cinner{position:relative;z-index:2}
    .contact h2{color:#fff}
    .contact p.lead{color:rgba(255,255,255,.82);font-size:18px;max-width:600px;margin:0 auto 28px}
    .contactlinks{display:flex;gap:26px;justify-content:center;flex-wrap:wrap;margin-top:26px}
    /* overflow-wrap:anywhere — an email or URL has no break opportunities, and
       .contactlinks is a flex row, so a long real address ran off both edges of a phone.
       The sample address is short, which is why the 320px sweep looked clean. */
    .contactlinks a,.contactlinks span{color:var(--glow-on-panel);text-decoration:none;font-weight:600;overflow-wrap:anywhere}
    .contactlinks a:hover{color:#fff}
    footer{color:var(--soft);text-align:center;padding:26px;font-size:13.5px}
    .reveal{opacity:0;transform:translateY(28px);transition:opacity .7s ease,transform .7s ease}
    .reveal.in{opacity:1;transform:none}
`;

/**
 * ★ REDUCED MOTION LIVES IN THE GENERATED DOCUMENT, not in the app's stylesheet.
 *   All the motion is inside the frame — three infinite blur-80px orbs, a
 *   pulsing dot, smooth scrolling, a 1.4-second counter animation and the
 *   reveal transitions — and `prefers-reduced-motion` is honoured inside a
 *   sandboxed iframe exactly as it is anywhere else. This block also ships in
 *   every downloaded portfolio, which is where it matters most: that file
 *   outlives the app.
 */
export const REDUCED_MOTION_CSS = `
    @media (prefers-reduced-motion: reduce){
      html{scroll-behavior:auto}
      .orb,.hero:after,.hero .avail .pulse{animation:none}
      .reveal{opacity:1;transform:none;transition:none}
      .bar i{transition:none}
      .btn-primary:hover,.svc:hover{transform:none}
    }
`;

/**
 * Preview-only styling.
 *
 * ★ The orbs are frozen. Three infinite `filter: blur(80px)` animations
 *   compositing continuously beside a React editor is a real cost for an effect
 *   nobody is looking at while typing — and the preview rebuilds anyway.
 */
export const PREVIEW_CSS = `
    .orb,.hero:after{animation:none!important}
    .pf-linknote{position:fixed;left:0;right:0;bottom:0;z-index:99;margin:0;padding:7px 12px;
      font:600 12px/1.4 'Segoe UI',system-ui,sans-serif;text-align:center;color:#fff;
      background:rgba(13,33,55,.86);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
    body{padding-bottom:34px}
`;

/**
 * The runtime the generated document ships with.
 *
 * ★ A FROZEN CONSTANT WITH NO INTERPOLATION. No user value reaches the inline
 *   <script>, which is what makes "a field cannot break out of the script tag" a
 *   structural fact rather than an escaping habit. The only per-render value in
 *   the whole document's JS is the scroll offset, and it travels as a clamped
 *   integer in a `data-` attribute.
 * ★ The 3.5s reveal safety net is deliberately kept. Inside a `display:none`
 *   iframe the viewport is 0x0 and IntersectionObserver never fires, so the
 *   mobile Edit/Preview toggle depends on it.
 */
export const PORTFOLIO_RUNTIME_JS = `
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function runCount(el){
    var end = Number(el.getAttribute('data-count')) || 0;
    var suf = el.getAttribute('data-suffix') || '';
    function show(v){ el.textContent = String(v).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + suf; }
    if (reduce) { show(end); return; }
    var t0 = null, dur = 1400;
    function step(ts){
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      show(Math.round((1 - Math.pow(1 - p, 3)) * end));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function activate(el){
    el.classList.add('in');
    var bars = el.querySelectorAll('.bar');
    for (var i = 0; i < bars.length; i++) bars[i].classList.add('go');
    var nums = el.querySelectorAll('.num[data-count]');
    for (var j = 0; j < nums.length; j++) runCount(nums[j]);
  }
  var reveals = document.querySelectorAll('.reveal');
  if (window.IntersectionObserver && !reduce) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){ if (e.isIntersecting) { activate(e.target); io.unobserve(e.target); } });
    }, { threshold: .15 });
    for (var k = 0; k < reveals.length; k++) io.observe(reveals[k]);
  }
  setTimeout(function(){
    var pending = document.querySelectorAll('.reveal:not(.in)');
    for (var n = 0; n < pending.length; n++) activate(pending[n]);
  }, reduce ? 0 : 3500);
  var titles = { pl: 'Profit & Loss', bs: 'Balance Sheet', cf: 'Cash Flow Statement' };
  var tabs = document.querySelectorAll('.stab');
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener('click', function(){
      var want = this.getAttribute('data-tab');
      for (var a = 0; a < tabs.length; a++) {
        var on = tabs[a] === this;
        tabs[a].classList.toggle('active', on);
        tabs[a].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      var panels = document.querySelectorAll('.stmtpanel');
      for (var b = 0; b < panels.length; b++) {
        panels[b].style.display = panels[b].getAttribute('data-panel') === want ? 'block' : 'none';
      }
      var head = document.getElementById('stmtTitle');
      if (head) head.textContent = titles[want] || 'Profit & Loss';
    });
  }
  var yr = document.getElementById('yr');
  if (yr) yr.textContent = String(new Date().getFullYear());
})();
`;

/**
 * Preview-only runtime.
 *
 * ★ THE SCROLL OFFSET ARRIVES IN THE MARKUP, NOT BY postMessage. Setting
 *   `srcDoc` starts a fresh document load; a message the parent posts before
 *   this script has attached a listener is dropped with no queue and no retry,
 *   so a restore built that way works "sometimes" — the worst outcome. Reading
 *   `data-pf-scroll` is deterministic.
 * ★ The message this DOES send is untrusted at the other end. The parent
 *   authenticates it by `event.source`, not `event.origin`: a sandboxed frame's
 *   origin serialises to the string "null", which every other opaque-origin
 *   context on the page shares, so origin authenticates nothing here.
 * ★ Links are neutralised, not removed, so the design still reads correctly.
 *   Fragment links keep working — the point of a preview is to test the nav.
 */
export const PREVIEW_RUNTIME_JS = `
(function(){
  var y = Number(document.body.getAttribute('data-pf-scroll')) || 0;
  if (y > 0) window.scrollTo(0, y);
  var last = 0, timer = null;
  window.addEventListener('scroll', function(){
    if (timer) return;
    timer = setTimeout(function(){
      timer = null;
      var next = Math.round(window.scrollY || 0);
      if (Math.abs(next - last) < 8) return;
      last = next;
      try { parent.postMessage({ t: 'pf-scroll', y: next }, '*'); } catch (e) {}
    }, 150);
  }, { passive: true });
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    e.preventDefault();
  });
})();
`;

/**
 * ★ NEITHER POLICY IS RUN THROUGH escapeHtml. Both are frozen constants with no
 *   interpolation, so escaping them buys nothing and rewrites every `'none'` as
 *   `&#39;none&#39;`. That still works — an attribute is entity-decoded before the
 *   CSP parser sees it — which is precisely the problem: the document would carry
 *   an unreadable policy and nothing would ever fail to reveal it.
 */
const CSP_PREVIEW = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; "
  + "script-src 'unsafe-inline'; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * ★ THE DOWNLOAD'S POLICY IS DELIBERATELY LOOSER THAN THE PREVIEW'S.
 *   `default-src 'none'` is right for a frame rendering content we just
 *   escaped. In a file the bookkeeper owns and will edit it is a trap: the
 *   moment they add a Google Font, host their headshot, or paste a Calendly
 *   embed, everything fails silently with no error a non-developer can read.
 *   Scripts stay inline-only and `connect-src` stays closed, so the file still
 *   cannot phone anywhere by itself.
 */
const CSP_DOWNLOAD = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; "
  + "script-src 'unsafe-inline'; font-src https: data:; object-src 'none'; connect-src 'none'; "
  + "base-uri 'none'; form-action 'none'";

function clampScroll(y) {
  return clamp(Math.round(num(y, 0)), 0, 200000);
}

function documentHead(d, ctx) {
  const title = displayName(d) || 'Bookkeeping Portfolio';
  const description = d.heroSub
    || (d.fullName ? `Professional bookkeeping services by ${d.fullName}` : 'Professional bookkeeping services');
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${ctx.mode === 'preview' ? CSP_PREVIEW : CSP_DOWNLOAD}">
<title>${esc(title)} — ${esc(d.title || 'Bookkeeper')}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow">
<link rel="icon" href="data:,">`;
}

function buildContext(d, options) {
  const opts = options || {};
  const theme = resolveTheme(opts.theme);
  const mode = opts.mode === 'preview' ? 'preview' : 'download';
  const cta = safeLinkHref(d.ctaLink);
  return {
    theme,
    mode,
    year: clamp(Math.round(num(opts.year, 2026)), 1970, 9999),
    scrollY: clampScroll(opts.scrollY),
    // ★ ONE resolved CTA for all four places the artifact interpolated ctaLink
    //   unvalidated: the nav button, the hero button, every package card, and
    //   the contact panel. Resolving it once is what makes "the CTA is
    //   validated" a structural fact instead of four separate habits.
    cta: cta.kind === 'external' || cta.kind === 'fragment' ? cta.href : '#contact',
    ctaRel: cta.kind === 'external' ? ' target="_blank" rel="noopener noreferrer"' : '',
    ctaText: d.ctaText || 'Get in touch',
  };
}

/**
 * Render the complete standalone portfolio document.
 *
 * @param {object} draft
 * @param {{ theme?: unknown, mode?: 'preview'|'download', year?: number, scrollY?: number }} [options]
 *   `theme` is a resolved theme object or a key already looked up by the caller —
 *   this module cannot see PORTFOLIO_THEMES, so an unrecognised value becomes
 *   FALLBACK_THEME rather than broken CSS. `year` is a PARAMETER: see the header.
 * @returns {string} a complete `<!DOCTYPE html>` document
 */
export function buildPortfolioHtml(draft, options) {
  const d = normalizeDraft(draft);
  const ctx = buildContext(d, options);
  const live = PORTFOLIO_SECTIONS.filter((s) => s.has(d));
  const preview = ctx.mode === 'preview';
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    documentHead(d, ctx),
    `<style>${themeCssVars(ctx.theme)}${PORTFOLIO_CSS}${REDUCED_MOTION_CSS}${preview ? PREVIEW_CSS : ''}</style>`,
    '</head>',
    `<body${preview ? ` data-pf-scroll="${ctx.scrollY}"` : ''}>`,
    backdrop(),
    sectionNav(d, ctx, navLinks(live, ctx)),
    sectionHero(d, ctx),
    ...live.map((s) => s.render(d, ctx)),
    sectionContact(d, ctx),
    sectionFooter(d, ctx),
    preview ? '<p class="pf-linknote">Preview — links open normally in the downloaded file.</p>' : '',
    `<script>${PORTFOLIO_RUNTIME_JS}${preview ? PREVIEW_RUNTIME_JS : ''}<\/script>`,
    '</body>',
    '</html>',
  ].filter((part) => part !== '').join('\n');
}

// ── Completion + filename ───────────────────────────────────────────────────

/**
 * How much of the portfolio exists, by the same table the builder walks.
 *
 * ★ Reading PORTFOLIO_SECTIONS is what stops the meter claiming a section the
 *   document does not render — the failure mode of any second list.
 *
 * @param {object} draft
 * @returns {{ pct:number, done:number, total:number, sections:{key:string,label:string,done:boolean}[] }}
 */
export function draftCompletion(draft) {
  const d = normalizeDraft(draft);
  const identity = [
    { key: 'identity', label: 'Name and title', done: !!d.fullName && !!d.title },
    { key: 'hero', label: 'Headline', done: !!d.heroHeadline },
    { key: 'contact', label: 'Contact details', done: mailtoHref(d.email).kind === 'mailto' || telHref(d.phone).kind === 'tel' },
  ];
  const sections = identity.concat(
    PORTFOLIO_SECTIONS.map((s) => ({ key: s.key, label: s.label, done: !!s.has(d) })),
  );
  const done = sections.filter((s) => s.done).length;
  return { pct: Math.round((done / sections.length) * 100), done, total: sections.length, sections };
}

/**
 * The download filename.
 *
 * ★ `isoDate` IS A PARAMETER. Calling Date here would make the function impure
 *   and its test unreproducible.
 * ★ The artifact hardcoded "index.html", so every download collided in the
 *   browser's downloads folder and none of them said whose portfolio it was.
 *
 * @param {object} draft
 * @param {string} isoDate `YYYY-MM-DD`
 * @returns {string}
 */
export function portfolioFileName(draft, isoDate) {
  const d = normalizeDraft(draft);
  // NFKD folds "José" to "Jose" rather than dropping the letter. Guarded because
  // String.prototype.normalize is absent on a few very old engines.
  const folded = typeof String.prototype.normalize === 'function'
    ? d.fullName.normalize('NFKD')
    : d.fullName;
  const name = folded
    .replace(COMBINING_MARKS, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
    .replace(/-+$/, '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || '')) ? `-${isoDate}` : '';
  return `${name || 'portfolio'}-bookkeeper-portfolio${date}.html`;
}

// ── Résumé parsing ──────────────────────────────────────────────────────────

const HEADING_FAMILIES = Object.freeze([
  { key: 'summary', re: /^(professional |career )?(summary|profile|objective)( of qualifications)?$/ },
  { key: 'skills', re: /^(professional |technical |core |key )?(skills|competencies)( ?& ?(abilities|tools))?$|^software( proficienc(y|ies))?$|^tools?( ?& ?technolog(y|ies))?$|^technical proficienc(y|ies)$/ },
  { key: 'industries', re: /^(client )?industries$|^industry experience$|^sectors$/ },
  { key: 'experience', re: /^(professional |work |relevant )?experience$|^employment( history)?$|^work history$|^career history$/ },
  { key: 'education', re: /^education( ?& ?certifications?)?$|^certifications?$|^credentials$|^licenses?( ?& ?certifications?)?$|^training$/ },
  { key: 'contact', re: /^contact( (info|information|details))?$/ },
  { key: 'other', re: /^(references|awards|volunteer|languages|interests|projects|publications)$/ },
]);

function headingKey(line) {
  const norm = String(line || '')
    .toLowerCase()
    .replace(/\s+/g, ' ') // JS \s already includes U+00A0 and the U+2000 block
    .replace(/^[^a-z0-9]+|[^a-z0-9)]+$/g, '')
    .trim();
  if (!norm || norm.length > 48) return null;
  const found = HEADING_FAMILIES.find((f) => f.re.test(norm));
  return found ? found.key : null;
}

/**
 * Fold case only where the source gives us no signal.
 *
 * ★ The artifact's titleCase() lowercased everything after the first letter of
 *   every word, so MCDONALD became "Mcdonald", O'BRIEN became "O'brien" and a
 *   correctly-typed "McKay" became "Mckay". A name is the one field a user
 *   notices immediately and forgives least.
 */
function smartCase(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  // Mixed case already: the author's own capitalisation beats ours.
  if (/[a-z]/.test(cleaned) && /[A-Z]/.test(cleaned)) return cleaned;
  return cleaned.replace(/\S+/g, (w) => {
    if (w.length <= 4 && /^[A-Z][A-Z.]*$/.test(w)) return w; // MBA, CPA, EA, CB, U.S.
    const lower = w.toLowerCase();
    if (/^mc[a-z]/.test(lower)) return `Mc${lower.charAt(2).toUpperCase()}${lower.slice(3)}`;
    if (/^mac[a-z]{2}/.test(lower)) return `Mac${lower.charAt(3).toUpperCase()}${lower.slice(4)}`;
    if (/^o'[a-z]/.test(lower)) return `O'${lower.charAt(2).toUpperCase()}${lower.slice(3)}`;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

/**
 * Truncate at a word boundary, never mid-word.
 *
 * Shared by the suggested hero sub-line and the metric labels. Both were slicing
 * at a fixed character count, which is how "…across every engag" ends up in a
 * field the user is being asked to approve.
 */
function cutOnWord(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit).replace(/\s+\S*$/, '');
  return cut || text.slice(0, limit);
}

const CREDENTIAL_TOKEN =/^[A-Z][A-Za-z.]{0,4}$/;
const CONTACT_HINT = /@|https?:\/\/|linkedin\.com|\+?\d[\d\s().-]{6,}/i;
const YEAR_RANGE = /^\s*(19|20)\d{2}\s*[-–—to\s]+\s*((19|20)\d{2}|present|current)\s*$/i;
const SPLITTERS = /\s*(?:[•·|/]|,|•|·|\s{2,})\s*/;

function splitInline(line) {
  return String(line || '')
    .split(SPLITTERS)
    .map((part) => part.replace(LEADING_MARKER, '').replace(/\s*[-\u2013]\s*\d+\s*years?/i, '').trim())
    .filter(Boolean);
}

/**
 * Turn extracted résumé lines into a draft PATCH plus an honest report.
 *
 * ★ A PATCH, NOT A MUTATION. The artifact wrote straight into its module-global
 *   `data`, which is why none of its parsing could be tested and none of it
 *   could be undone. Returning fields makes "Undo import" one setState.
 *
 * ★ NOTHING IS FABRICATED. The artifact injected a generic headline and four
 *   generic pain points and then reported "✓ Pre-filled from your resume" — even
 *   when the PDF was a scan and it had extracted nothing at all. Generic copy
 *   comes back in `suggested`, for the UI to offer behind an explicit button,
 *   and `confidence: 'none'` is what an empty extraction returns.
 *
 * ★ EVERY EXTRACTED CONTACT FIELD MUST PASS THE SAME VALIDATOR THE RENDERER
 *   USES. That single rule kills the artifact's best-known bug: its phone regex
 *   matched "2019-2023" and put a date range in the phone field.
 *
 * @param {string[]} lines
 * @param {{ maxSkills?: number, maxIndustries?: number, maxEducation?: number }} [options]
 * @returns {{
 *   patch: object,
 *   suggested: object,
 *   applied: string[],
 *   skipped: {field:string, reason:string}[],
 *   confidence: 'none'|'low'|'good',
 * }}
 */
export function parseResumeLines(lines, options) {
  const opts = options || {};
  const maxSkills = opts.maxSkills || 8;
  const maxIndustries = opts.maxIndustries || 10;
  const maxEducation = opts.maxEducation || 6;

  const all = (Array.isArray(lines) ? lines : [])
    .map((l) => str(l, 2000))
    .filter((l) => l.length > 1);

  const patch = {};
  const suggested = {};
  const applied = [];
  const skipped = [];
  const skip = (field, reason) => { skipped.push({ field, reason }); };

  if (all.length === 0) {
    return { patch, suggested, applied, skipped: [{ field: 'document', reason: 'no-text' }], confidence: 'none' };
  }

  const joined = all.join('\n');

  // ── Contact fields: extracted, then validated by the renderer's own rules ──
  // ★ `%` STAYS IN THIS EXTRACTION CLASS even though EMAIL_RE now refuses it, and the
  //   asymmetry is deliberate: extract GREEDILY, validate STRICTLY. Measured on the line
  //   "x%0D%0ABcc%3A%20a%40evil.example@y.com" — with `%` the whole hostile token matches
  //   and `mailtoHref` then rejects it, so the field is simply skipped; WITHOUT `%` the
  //   match starts after the last percent and yields "40evil.example@y.com", which is a
  //   perfectly valid address on the attacker's domain and would be silently accepted as
  //   the student's own contact email. Narrowing this regex to mirror the validator makes
  //   the importer less safe, not more.
  const emailMatch = joined.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch && mailtoHref(emailMatch[0]).kind === 'mailto') {
    patch.email = emailMatch[0];
    applied.push('email');
  } else if (emailMatch) {
    skip('email', 'not-an-email');
  }

  // ★ CANDIDATES ARE WHOLE PIECES OF A LINE, NEVER A SUBSTRING MATCH. Scanning
  //   the joined document with a phone-shaped regex returns fragments: "(555)
  //   010-4477 ext. 12" yields "555) 010-4477", which telHref then happily
  //   approves as tel:5550104477 — the extension dropped, the number wrong, and
  //   the paren unbalanced. Splitting on the separators a contact line actually
  //   uses makes telHref judge what the résumé says, so an extension disqualifies
  //   the piece instead of being trimmed away from it.
  const phoneCandidates = [];
  for (const line of all) {
    for (const piece of line.split(/[|\u00b7\u2022\u2013]|,\s|\s{2,}/)) {
      const token = piece.trim();
      if (token && /\d/.test(token)) phoneCandidates.push(token);
    }
  }
  const phone = phoneCandidates.find((cand) => {
    if (YEAR_RANGE.test(cand)) return false;
    const check = telHref(cand);
    if (check.kind !== 'tel') return false;
    const digits = check.href.replace(/\D/g, '');
    // A heuristic needs more evidence than a human typing into the field does:
    // require a country code or a full national number, so a bare 8-digit run
    // (a date range, a street address, an invoice number) is never promoted.
    return check.href.indexOf('+') > -1 || digits.length >= 10;
  });
  if (phone) {
    patch.phone = phone.trim();
    applied.push('phone');
  } else if (phoneCandidates.length) {
    skip('phone', 'not-dialable');
  }

  // ★ EMAIL ADDRESSES ARE REMOVED FIRST. A generic domain pattern matches the host
  //   half of "jordan@example.com" before it ever reaches the LinkedIn URL further
  //   along the same contact line — and the wrong answer looks entirely plausible
  //   sitting in the field, which is what makes it dangerous: the student publishes
  //   a portfolio linking to a domain they have never heard of. Found by the
  //   jspdf -> pdfjs -> parseResumeLines round trip, not by reading the regex.
  //   A profile URL is preferred over a bare domain, because that is what a résumé
  //   header almost always carries.
  const withoutEmails = joined.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ');
  const siteMatch = withoutEmails.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|,]+/i)
    || withoutEmails.match(/https?:\/\/[^\s|,]+/i)
    || withoutEmails.match(/(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|co|me|dev|ph)(?:\/[^\s|,]*)?/i);
  if (siteMatch) {
    const site = safeLinkHref(siteMatch[0]);
    if (site.kind === 'external') {
      patch.website = site.href;
      applied.push('website');
    } else {
      skip('website', site.reason || 'malformed');
    }
  }

  // ── Name, credentials, title from the masthead ────────────────────────────
  const masthead = all.filter((l) => !headingKey(l) && !CONTACT_HINT.test(l));
  if (masthead.length) {
    const first = masthead[0];
    const comma = first.indexOf(',');
    if (comma > 0) {
      const tail = first.slice(comma + 1).split(',').map((s) => s.trim()).filter(Boolean);
      if (tail.length && tail.every((tok) => CREDENTIAL_TOKEN.test(tok))) {
        patch.fullName = smartCase(first.slice(0, comma));
        patch.credentials = tail.join(', ');
        applied.push('credentials');
      } else {
        patch.fullName = smartCase(first);
      }
    } else {
      patch.fullName = smartCase(first);
    }
    if (/[A-Za-z]/.test(patch.fullName) && patch.fullName.split(/\s+/).length <= 6) {
      applied.push('fullName');
    } else {
      skip('fullName', 'unrecognized');
      delete patch.fullName;
    }
    // ★ Only a line that is NOT contact information can be a job title. The
    //   artifact accepted any second line under 80 characters, so the title
    //   routinely read "jordan@example.com | (555) 123-4567 | Denver, CO".
    const second = masthead[1];
    if (second && second.length <= 80 && !CONTACT_HINT.test(second)) {
      patch.title = smartCase(second);
      applied.push('title');
    } else if (second) {
      skip('title', 'looks-like-contact');
    }
  }

  // ── Blocks. A block ends at the NEXT heading of any family, wherever it is ─
  // ★ The artifact stopped `education` only at a `contact` heading, so a resume
  //   with CONTACT at the TOP never stopped anything and education absorbed
  //   every line to end of file.
  const headings = all.map((l, i) => ({ i, key: headingKey(l) })).filter((h) => h.key);
  const blockFor = (key) => {
    const at = headings.find((h) => h.key === key);
    if (!at) return [];
    const next = headings.find((h) => h.i > at.i);
    return all.slice(at.i + 1, next ? next.i : all.length).filter(Boolean);
  };

  const summaryBlock = blockFor('summary');
  if (summaryBlock.length) {
    patch.summary = summaryBlock.join(' ').replace(LEADING_MARKER, '').trim().slice(0, PF_LIMITS.longText);
    applied.push('summary');
  }

  const skillLines = blockFor('skills');
  if (skillLines.length) {
    const items = [];
    for (const line of skillLines) {
      const parts = splitInline(line);
      // A single 30+ character "skill" means the line was one visual row of a
      // two-column layout that pdf.js flattened — report it, don't invent a tool.
      if (parts.length === 1 && parts[0].length > 30) {
        skip('skills', 'unsplittable-line');
        continue;
      }
      for (const p of parts) if (p.length > 1 && p.length < 40) items.push(p);
    }
    const uniq = [...new Set(items)].slice(0, maxSkills);
    if (uniq.length) {
      // 80 is a placeholder the user is told to check, not a measurement.
      patch.tools = uniq.map((name) => ({ name, level: 80 }));
      applied.push('tools');
    }
    if (items.length > maxSkills) skip('tools', 'truncated');
  }

  const industryLines = blockFor('industries');
  if (industryLines.length) {
    const items = [];
    for (const line of industryLines) {
      for (const p of splitInline(line)) if (p.length > 1 && p.length < 32) items.push(p);
    }
    const uniq = [...new Set(items)].slice(0, maxIndustries);
    if (uniq.length) {
      patch.industries = uniq;
      applied.push('industries');
    }
  }

  const eduLines = blockFor('education');
  if (eduLines.length) {
    patch.education = eduLines
      .slice(0, maxEducation)
      .map((e) => ({ credential: e.replace(LEADING_MARKER, '').trim(), detail: '' }))
      .filter((e) => e.credential);
    if (patch.education.length) applied.push('education');
    else delete patch.education;
    if (eduLines.length > maxEducation) skip('education', 'truncated');
  }

  // ── Experience → SUGGESTIONS only ─────────────────────────────────────────
  // ★ An achievement is not a service. "Reconciled 45 bank accounts monthly" is
  //   a first-person past-tense fact about a previous job; a services list is a
  //   present-tense offer to a prospect. The artifact mapped one onto the other
  //   silently. These come back as suggestions the UI labels for rewriting.
  const expLines = blockFor('experience');
  const bullets = expLines
    .filter((l) => STARTS_WITH_MARKER.test(l) || l.length > 40)
    .map((l) => l.replace(LEADING_MARKER, '').trim())
    .filter((l) => l.length > 20 && !YEAR_RANGE.test(l));
  if (bullets.length) {
    suggested.services = bullets.slice(0, 4).map((b) => ({
      name: b.split(/\s+/).slice(0, 4).join(' ').replace(/[.,;].*$/, ''),
      desc: b,
    }));
    const metrics = [];
    for (const b of bullets) {
      if (metrics.length >= 4) break;
      // Require an explicit marker. A bare number in a sentence is not a metric,
      // and a 4-digit number in the 1900–2100 range is a year.
      const m = b.match(/(\d[\d,]*)\s*(%|\+|k\b|x\b)/i);
      if (!m) continue;
      const raw = m[1].replace(/,/g, '');
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (/^\d{4}$/.test(raw) && value >= 1900 && value <= 2100) continue;
      // Strip the number wherever it appears, not only at the front.
      const label = cutOnWord(b.replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim(), 60);
      metrics.push({ value, suffix: m[2].toLowerCase() === 'k' ? 'k' : m[2], label: label || 'Key result' });
    }
    if (metrics.length) suggested.metrics = metrics;
  }

  // ── Generic copy: offered, never applied ──────────────────────────────────
  suggested.heroHeadline = 'Clean books, clear numbers, zero tax-season stress.';
  if (patch.summary) {
    // Cut on a word boundary — the artifact sliced at 180 characters mid-word.
    const cut = cutOnWord(patch.summary, 180);
    suggested.heroSub = cut.length < patch.summary.length ? `${cut}…` : cut;
  } else {
    suggested.heroSub = 'I help business owners keep accurate, reconciled books so they always know where they stand.';
  }
  suggested.painPoints = [
    'Books are behind and you dread opening QuickBooks',
    'You’re never sure how much cash you can actually spend',
    'Reconciliations, 1099s, and sales tax keep slipping',
    'Tax season is always a last-minute scramble',
  ];

  const structural = applied.filter((f) => f !== 'email' && f !== 'phone' && f !== 'website');
  const confidence = structural.length === 0 ? 'none' : structural.length <= 2 ? 'low' : 'good';
  return { patch, suggested, applied, skipped, confidence };
}
