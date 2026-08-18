// ─────────────────────────────────────────────────────────────────────────────
// lessonReplay.js — PURE, dependency-free validation for a lesson's optional
// "Zoom Live Replay" link (#37b).
// ─────────────────────────────────────────────────────────────────────────────
// The client half of public.course_lessons.zoom_replay_url
// (db/2026-08-05-lesson-zoom-replay.sql). That column deliberately carries NO
// CHECK constraint and NO index — it is never queried by value, and the rule it
// obeys ("absolute https only; Zoom hosts are linked, never embedded") is about
// how the value is DISPLAYED, which SQL cannot express. This file is therefore
// the ONLY enforcement point, and its contract is recorded in the column's own
// COMMENT. Keep the two in lockstep.
//
// Consumed by CourseProgram's lesson editor (validation + the "Detected:" hint)
// and by LessonReplayLink (the learner card) in src/BookkeeperPro.jsx — both
// read the SAME result object, so the editor can never accept something the
// renderer would refuse. Pinned by test/lessonReplay.test.mjs.
//
// NO imports, NO side effects, NO DOM, NO network. The single global used is
// the WHATWG `URL` parser, which is synchronous and resolves nothing remotely.
//
// ★ THE PARSED `protocol` IS THE ONLY SCHEME AUTHORITY.
//   Never decide a scheme by testing the raw string. WHATWG strips tab, LF and
//   CR *before* parsing, so "java\nscript:alert(1)" parses as `javascript:` and
//   sails straight through a /^javascript:/ guard. The one raw-string regex in
//   this file picks between two error sentences and never accepts anything.
//
// ★ `url.hostname`, NEVER `url.host`.
//   `host` carries the port, so "us02web.zoom.us:8443" would fail an
//   endsWith('.zoom.us') test and a genuine Zoom link would be mislabelled.
//
// ★ AN INVALID RESULT NEVER CARRIES A `url`.
//   The renderer binds its href to `result.url` and to nothing else, so there
//   is literally nothing for a rejected value to bind to.
//
// ★ `new URL(raw)` IS CALLED WITHOUT A BASE, ALWAYS.
//   Passing one would resolve "/dashboard" against the app's own origin and
//   turn a typo into a working same-site link.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Host families whose recordings are labelled a Zoom replay.
 *
 * `zoom.us` covers the vanity subdomains every account gets (`us02web.zoom.us`,
 * `umich.zoom.us`); `zoomgov.com` is Zoom for Government; `zoom.com` is the
 * corporate rebrand. Exported because the lesson editor renders this list in
 * its hint copy — one edit here updates the rule, the tests and the UI text.
 *
 * Deliberately a host list and not a path pattern: Zoom has changed its share
 * routes before, and a brittle `/rec/share/` regex would reject valid links.
 */
export const ZOOM_HOST_SUFFIXES = Object.freeze(['zoom.us', 'zoomgov.com', 'zoom.com']);

const MESSAGES = Object.freeze({
  'not-absolute': 'Paste the complete link, starting with https:// — a path or bare domain won’t work.',
  malformed: 'That isn’t a valid web address. Check for stray spaces or missing characters.',
  insecure: 'Use the https:// version of this link — http:// isn’t secure.',
  'not-https': 'Only https:// links can be used here.',
  credentials: 'Remove the username or password from the link (everything before the @).',
});

function result(kind, url, host, reason) {
  return { kind, url, host, reason, message: reason ? MESSAGES[reason] : null };
}

/**
 * True when `host` is one of ZOOM_HOST_SUFFIXES or a subdomain of one.
 *
 * The `length > suffix.length + 1` guard is what makes the match boundary-safe:
 * a bare endsWith would accept the unregistrable-but-parseable ".zoom.us", and
 * requiring the leading dot is what keeps "zoom.us.attacker.example" and
 * "myzoom.us" out.
 */
function isZoomHost(host) {
  return ZOOM_HOST_SUFFIXES.some(suffix => (
    host === suffix || (host.length > suffix.length + 1 && host.endsWith('.' + suffix))
  ));
}

/**
 * Classify a lesson's optional replay link.
 *
 * An absent value is NOT an error — the field is optional, and `kind: 'none'`
 * is what the save path turns into a SQL NULL.
 *
 * ★ The returned `reason` is a stable code; `message` is throwaway UI prose.
 * Assert the code in tests so the copy can be reworded freely.
 *
 * ★ `url` is `url.href`, not the pasted string. Normalizing is what neutralizes
 * "https://@host" and an uppercase scheme, and it guarantees the value stored in
 * the database is byte-identical to the href the learner clicks. The only
 * visible effect is that a bare origin gains a trailing slash; path, query
 * (including a `?pwd=` passcode) and fragment are preserved exactly as pasted.
 *
 * @param {string|null|undefined} raw
 * @returns {{
 *   kind: 'none'|'zoom'|'external'|'invalid',
 *   url: string|null,
 *   host: string|null,
 *   reason: null|'not-absolute'|'malformed'|'insecure'|'not-https'|'credentials',
 *   message: string|null,
 * }}
 */
export function parseReplayUrl(raw) {
  const trimmed = raw == null ? '' : String(raw).trim();
  if (!trimmed) return result('none', null, null, null);

  let url;
  try {
    url = new URL(trimmed); // ★ no base argument — see the header.
  } catch {
    // The ONLY raw-string test in this file, and it never accepts: it just picks
    // the more useful of two sentences ("check for typos" vs "paste the whole link").
    return result('invalid', null, null, /^https:\/\//i.test(trimmed) ? 'malformed' : 'not-absolute');
  }

  if (url.protocol !== 'https:') {
    return result('invalid', null, null, url.protocol === 'http:' ? 'insecure' : 'not-https');
  }
  // Credentials in a link are either a mistake or the classic "https://zoom.us@evil.com"
  // phishing shape, where the trustworthy-looking part is the username, not the host.
  if (url.username || url.password) return result('invalid', null, null, 'credentials');

  const host = url.hostname; // ★ hostname, not host — see the header.
  return result(isZoomHost(host) ? 'zoom' : 'external', url.href, host, null);
}
