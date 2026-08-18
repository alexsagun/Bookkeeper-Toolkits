// test/lessonReplay.test.mjs — the optional "Zoom Live Replay" lesson link (#37b).
//
// public.course_lessons.zoom_replay_url has no CHECK constraint by design, so this
// module is the only thing standing between an admin's paste and an <a href> shown
// to every student in the course. A hole here is not a cosmetic bug — it is a live
// link to somewhere nobody intended, on a page members paid to see.
//
// Assertions target the stable `reason` codes, never the `message` prose, so the
// copy can be reworded without touching this suite.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ZOOM_HOST_SUFFIXES,
  parseReplayUrl,
} from '../src/lib/lessonReplay.js';

const ZOOM_SHARE = 'https://us02web.zoom.us/rec/share/abc123';

// ── Absence is not an error ──────────────────────────────────────────────────

test('null, undefined, empty and whitespace-only all read as no replay link', () => {
  for (const raw of [null, undefined, '', '   ', '\t\n ']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'none', `${JSON.stringify(raw)} is an absent optional field, not a mistake`);
    assert.equal(r.url, null, 'nothing absent may produce a url');
    assert.equal(r.reason, null, 'an empty field must never show an error');
  }
});

test('surrounding whitespace is trimmed and never changes the verdict', () => {
  const bare = parseReplayUrl(ZOOM_SHARE);
  const padded = parseReplayUrl(`  \n${ZOOM_SHARE}\t  `);
  assert.deepEqual(padded, bare, 'a pasted link often carries whitespace on both ends');
});

// ── Only an absolute https link survives ─────────────────────────────────────

test('an http link is rejected under its own reason so the copy can say "use https"', () => {
  const r = parseReplayUrl('http://us02web.zoom.us/rec/share/abc123');
  assert.equal(r.kind, 'invalid');
  assert.equal(r.reason, 'insecure', 'http deserves a more useful sentence than "not https"');
});

test('javascript:, data:, file: and vbscript: are rejected as non-https schemes', () => {
  for (const raw of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///c:/secret.txt', 'vbscript:msgbox(1)']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'invalid', `${raw} must never reach an href`);
    assert.equal(r.reason, 'not-https');
    assert.equal(r.url, null);
  }
});

test('a scheme split by a newline or tab still parses as javascript: and is still rejected', () => {
  // WHATWG strips tab/LF/CR before parsing, so a raw-string /^javascript:/ guard
  // would wave these through. Testing the PARSED protocol is what catches them.
  for (const raw of ['java\nscript:alert(1)', 'java\tscript:alert(1)', 'java\r\nscript:alert(1)']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(raw)} parses as javascript: once the control chars are stripped`);
    assert.equal(r.reason, 'not-https');
  }
});

test('a relative path, a bare host and a protocol-relative //host are all rejected as not absolute', () => {
  for (const raw of ['/courses/1', 'rec/share/abc', 'zoom.us/rec/share/abc', '//evil.example/rec']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'invalid', `${raw} is not a complete address`);
    assert.equal(r.reason, 'not-absolute');
  }
});

test('no base url is ever passed — "/x" cannot become a link on the app origin', () => {
  // new URL('/x', location.href) would happily resolve. Passing a base is the
  // difference between rejecting a typo and shipping a working same-site link.
  assert.equal(parseReplayUrl('/admin/enrollments').url, null, 'a path must not resolve against the app origin');
});

test('an uppercase HTTPS scheme is accepted and normalized to lowercase', () => {
  const r = parseReplayUrl('HTTPS://ZOOM.US/Rec/ABC');
  assert.equal(r.kind, 'zoom', 'scheme and host case are not the admin’s problem');
  assert.equal(r.url, 'https://zoom.us/Rec/ABC', 'the path keeps its case — only scheme and host normalize');
});

test('a link carrying embedded credentials is rejected even when the host is Zoom', () => {
  for (const raw of ['https://user:pass@zoom.us/rec/x', 'https://user@zoom.us/rec/x']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'invalid', `${raw} must not be stored or linked`);
    assert.equal(r.reason, 'credentials');
  }
});

test('https://zoom.us@evil.com is rejected — the host is evil.com and the credentials give it away', () => {
  const r = parseReplayUrl('https://zoom.us@evil.example/rec');
  assert.equal(r.kind, 'invalid', 'the trustworthy-looking part is the username, not the host');
  assert.equal(r.reason, 'credentials');
  assert.equal(r.url, null);
});

test('a bare "@" with no credentials is harmless and normalizes away', () => {
  const r = parseReplayUrl('https://@zoom.us/rec/x');
  assert.equal(r.kind, 'zoom');
  assert.equal(r.url, 'https://zoom.us/rec/x', 'the empty credential is dropped by normalization');
});

test('a space in the host, or a bare "https://", is rejected as malformed', () => {
  for (const raw of ['https://zoom us/rec', 'https://', 'https:// ']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'invalid', `${JSON.stringify(raw)} does not parse`);
    assert.equal(r.reason, 'malformed', 'it started with https, so the useful advice is "check for typos"');
  }
});

// ── Host classification is boundary-safe ─────────────────────────────────────

test('zoom.us itself and its vanity subdomains classify as zoom', () => {
  for (const raw of ['https://zoom.us/rec/x', 'https://us02web.zoom.us/rec/x', 'https://umich.zoom.us/rec/x', 'https://deep.sub.zoom.us/rec/x']) {
    assert.equal(parseReplayUrl(raw).kind, 'zoom', `${raw} is a real Zoom host`);
  }
});

test('zoom.us.attacker.example does not classify as zoom', () => {
  const r = parseReplayUrl('https://zoom.us.attacker.example/rec/share/abc');
  assert.equal(r.kind, 'external', 'suffix matching must require a dot boundary at the END of the host');
  assert.equal(r.host, 'zoom.us.attacker.example');
});

test('myzoom.us and notzoom.us do not classify as zoom — the dot boundary is required', () => {
  for (const raw of ['https://myzoom.us/rec', 'https://notzoom.us/rec', 'https://xzoom.com/rec']) {
    assert.equal(parseReplayUrl(raw).kind, 'external', `${raw} merely ends with the letters`);
  }
});

test('a leading-dot host .zoom.us does not classify as zoom', () => {
  // Unregistrable, but it parses — and a bare endsWith('.zoom.us') would accept it.
  assert.equal(parseReplayUrl('https://.zoom.us/rec').kind, 'external', 'the guard on host length is what rejects this');
});

test('zoomgov.com and zoom.com are recognized alongside zoom.us', () => {
  assert.equal(parseReplayUrl('https://zoomgov.com/rec/x').kind, 'zoom', 'Zoom for Government');
  assert.equal(parseReplayUrl('https://agency.zoomgov.com/rec/x').kind, 'zoom');
  assert.equal(parseReplayUrl('https://zoom.com/rec/x').kind, 'zoom', 'the corporate rebrand domain');
});

test('a unicode homograph of zoom.us punycodes to a different host and classifies as external', () => {
  const r = parseReplayUrl('https://\u0437oom.us/rec'); // Cyrillic ze
  assert.equal(r.kind, 'external', 'a lookalike must not borrow Zoom’s label');
  assert.notEqual(r.host, 'zoom.us', 'the parser punycodes it away from the real host');
});

test('a port on a zoom host does not defeat the suffix match', () => {
  const r = parseReplayUrl('https://us02web.zoom.us:8443/rec/x');
  assert.equal(r.kind, 'zoom', 'classification reads hostname, which excludes the port');
  assert.equal(r.host, 'us02web.zoom.us', 'host would have carried ":8443" and broken the match');
});

test('every other valid https link classifies as external and is still safe to link', () => {
  for (const raw of ['https://drive.google.com/file/d/1/view', 'https://www.loom.com/share/abc', 'https://vimeo.com/12345']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'external', `${raw} is a replay, just not a Zoom one`);
    assert.equal(r.url, raw, 'an external replay is linked, never relabelled or rewritten');
  }
});

// ── The url is preserved, not rewritten ──────────────────────────────────────

test('path, query and fragment survive — a ?pwd= passcode is never dropped', () => {
  const raw = 'https://us02web.zoom.us/rec/share/abc123?pwd=Xy7.Zq1#t=90';
  const r = parseReplayUrl(raw);
  assert.equal(r.kind, 'zoom');
  assert.equal(r.url, raw, 'dropping the passcode would make every stored link useless');
});

test('percent-encoding in the path and query is left exactly as pasted', () => {
  const raw = 'https://us02web.zoom.us/rec/share/a%2Fb?pwd=A1b2%2B3';
  assert.equal(parseReplayUrl(raw).url, raw, 're-encoding %2B to + would corrupt the token');
});

test('classification never reads the path — Zoom is free to change its share routes', () => {
  for (const raw of ['https://zoom.us', 'https://zoom.us/', 'https://zoom.us/j/123', 'https://zoom.us/some/future/route']) {
    assert.equal(parseReplayUrl(raw).kind, 'zoom', `${raw} is Zoom because of its host, not its route`);
  }
});

test('a bare origin gains a trailing slash and nothing else', () => {
  // The one visible effect of storing url.href. Documented so nobody later
  // asserts that the stored value is byte-identical to what was typed.
  assert.equal(parseReplayUrl('https://zoom.us').url, 'https://zoom.us/');
});

// ── One shape, two consumers ─────────────────────────────────────────────────

test('every result carries the same keys, so the editor and the renderer read one object', () => {
  const keys = ['kind', 'url', 'host', 'reason', 'message'];
  for (const raw of ['', ZOOM_SHARE, 'https://loom.com/share/x', 'http://zoom.us/x']) {
    assert.deepEqual(Object.keys(parseReplayUrl(raw)).sort(), [...keys].sort(), `shape must not vary for ${JSON.stringify(raw)}`);
  }
});

test('an invalid result never carries a url — there is nothing for an href to bind to', () => {
  for (const raw of ['http://zoom.us/x', 'javascript:alert(1)', '//evil.example', 'https://user:pass@zoom.us/x', 'https://']) {
    const r = parseReplayUrl(raw);
    assert.equal(r.kind, 'invalid');
    assert.equal(r.url, null, `${raw} must not survive as a linkable url`);
    assert.equal(r.host, null, 'a rejected value has no host worth showing either');
  }
});

test('an invalid result carries both a stable reason code and a sentence to render', () => {
  const r = parseReplayUrl('http://zoom.us/x');
  assert.equal(typeof r.reason, 'string', 'tests and branching read the code');
  assert.ok(r.message && r.message.length > 10, 'the editor renders the sentence under the field');
});

test('a valid result carries no reason and no message', () => {
  const r = parseReplayUrl(ZOOM_SHARE);
  assert.equal(r.reason, null);
  assert.equal(r.message, null, 'nothing to apologise for');
});

test('the exported Zoom suffix list is frozen and is what drives classification', () => {
  assert.ok(Object.isFrozen(ZOOM_HOST_SUFFIXES), 'the editor hint renders this list — it must not be mutable');
  for (const suffix of ZOOM_HOST_SUFFIXES) {
    assert.equal(parseReplayUrl(`https://${suffix}/rec/x`).kind, 'zoom', `${suffix} is advertised but not recognized`);
  }
});

// ── It never touches the network ─────────────────────────────────────────────

test('a stubbed global fetch is never called — classification is offline and synchronous', () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('lessonReplay must not make network requests'); };
  try {
    for (const raw of [ZOOM_SHARE, 'https://loom.com/x', 'http://zoom.us/x', 'nonsense']) parseReplayUrl(raw);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0, 'a validator that phones home would leak the recording url');
});
