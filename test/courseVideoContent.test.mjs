// Pins the CONTAINER inspection in src/lib/courseVideo.js — the codec and index-position
// checks that run before a single byte of a lesson video is uploaded.
//
// Why this suite exists. `validateVideoFile` reads the NAME, the MIME type and the SIZE.
// An H.265/HEVC file satisfies all three — it is a `.mp4`, it is `video/mp4`, it is under
// the cap — so the only thing keeping HEVC out of a paid course was a decode probe run in
// THE ADMIN'S OWN browser. On a Windows 11 machine with the HEVC extensions Chrome answers
// `canPlayType(...) === 'probably'`, so the file sailed through; Firefox ships no HEVC
// decoder on any platform, and neither do plenty of the phones and older laptops students
// use. The verify step exists so an admin never publishes a lesson "broken only for the
// people who paid for it", and on codec it was measuring the one machine guaranteed not to
// be theirs.
//
// Faststart is here for a different reason, and it is not cosmetic. With the index at the
// END of the file a player must reach the tail before it knows anything at all. Measured
// against this project's own Storage on an 859 MB lesson: a cold 2 MiB tail range took
// ~50 s (CDN MISS), the same range warm took ~1.9 s, and a range at the HEAD took ~1.7 s
// cold. The post-upload check had a flat 20 s budget, so it could never pass — and the
// timeout was then reported to the admin as a codec fault, sending them to re-encode a file
// whose encoding was not what stopped it.
//
// Every fixture below is hand-built ISO-BMFF, so these cases need no media files and no
// browser. Assertions target stable reason codes, not prose, except where the prose itself
// is the thing under test (an admin acting on the wrong remedy is the bug).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readBoxes,
  videoSampleEntryFourcc,
  inspectLessonVideo,
  describeVideoContent,
  describeVideoWeight,
  LESSON_VIDEO_CODECS,
  LESSON_VIDEO_HEAVY_BPS,
  LESSON_VIDEO_VERIFY_TIMEOUT_MS,
  parseObjectTotalBytes,
} from '../src/lib/courseVideo.js';

const FOURCC = (s) => [...s].map((c) => c.charCodeAt(0));

/** One ISO-BMFF box: 4-byte big-endian size, 4-byte type, then payload. */
function box(type, ...payloads) {
  const body = payloads.flat();
  const size = 8 + body.length;
  return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...FOURCC(type), ...body];
}

/** A box declaring a 64-bit largesize: size === 1, then an 8-byte length. */
function box64(type, byteLength) {
  const n = byteLength;
  const hi = Math.floor(n / 0x100000000);
  return [
    0, 0, 0, 1, ...FOURCC(type),
    (hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
    (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255,
  ];
}

/** hdlr payload: version+flags(4), pre_defined(4), handler_type(4), reserved. */
function hdlr(handlerType) {
  return box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], FOURCC(handlerType), [0, 0, 0, 0]);
}

/** stsd: version+flags, entry_count, then the sample-entry box whose TYPE is the codec. */
function stsd(codec) {
  return box('stsd', [0, 0, 0, 0], [0, 0, 0, 1], box(codec, new Array(8).fill(0)));
}

function trak(handlerType, codec) {
  return box('trak', box('mdia', hdlr(handlerType), box('minf', box('stbl', stsd(codec)))));
}

function ftyp(...brands) {
  return box('ftyp', FOURCC(brands[0] || 'isom'), [0, 0, 0, 0], ...brands.map((b) => FOURCC(b)));
}

/** A whole file. `faststart` puts moov before mdat, as a web-ready export does. */
function mp4({ codec = 'avc1', faststart = true, mdatBytes = 4096, audio = true } = {}) {
  const moov = box('moov', ...(audio ? [trak('soun', 'mp4a')] : []), trak('vide', codec));
  const mdat = box('mdat', new Array(mdatBytes).fill(0x21));
  const parts = faststart ? [ftyp('isom', 'mp41'), moov, mdat] : [ftyp('isom', 'mp41'), mdat, moov];
  return Uint8Array.from(parts.flat());
}

/** Serve bytes the way a browser File does, counting what was actually read. */
function reader(bytes) {
  const stats = { calls: 0, bytesRead: 0 };
  const readSlice = async (start, end) => {
    stats.calls++;
    stats.bytesRead += end - start;
    return bytes.slice(start, end);
  };
  return { readSlice, stats, size: bytes.length };
}

// ── The box walker ──────────────────────────────────────────────────────────

test('readBoxes walks top-level boxes and reports absolute file offsets', () => {
  const bytes = mp4({ faststart: false, mdatBytes: 512 });
  const boxes = readBoxes(bytes, { totalSize: bytes.length });
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(boxes[2].fileStart, boxes[1].fileEnd, 'moov must begin exactly where mdat ends');
  assert.ok(boxes.every((b) => b.complete), 'every box is present in this buffer');
});

test('readBoxes understands the 64-bit largesize form', () => {
  const big = 8 * 1024 * 1024 * 1024;                  // only expressible as size === 1
  const bytes = Uint8Array.from([...ftyp('isom'), ...box64('mdat', big)]);
  const boxes = readBoxes(bytes, { totalSize: big + 100 });
  assert.equal(boxes[1].type, 'mdat');
  assert.equal(boxes[1].size, big, '64-bit size must survive, not wrap');
  assert.equal(boxes[1].complete, false, 'a box larger than the window is not "complete"');
});

test('readBoxes never returns a negative size for a box at or above 2 GiB', () => {
  // `bytes[o] << 24` is a SIGNED shift: a 2 GiB box comes back negative, and the walker
  // then marches backwards through the file inventing boxes out of video payload.
  const bytes = Uint8Array.from([0x80, 0, 0, 0, ...FOURCC('mdat'), 0, 0, 0, 0]);
  const boxes = readBoxes(bytes, { totalSize: 0x80000000 + 64 });
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].size > 0, `size must be positive, got ${boxes[0].size}`);
  assert.equal(boxes[0].size, 0x80000000);
});

test('readBoxes stops at a malformed box rather than inventing more', () => {
  const bytes = Uint8Array.from([...ftyp('isom'), 0, 0, 0, 2, ...FOURCC('junk')]);  // size < header
  assert.deepEqual(readBoxes(bytes, { totalSize: bytes.length }).map((b) => b.type), ['ftyp']);
});

// ── Finding the video codec ─────────────────────────────────────────────────

test('videoSampleEntryFourcc reads the VIDEO track, not the first track it meets', () => {
  const bytes = mp4({ codec: 'avc1', audio: true });
  const moov = readBoxes(bytes, { totalSize: bytes.length }).find((b) => b.type === 'moov');
  assert.equal(videoSampleEntryFourcc(bytes, moov), 'avc1',
    'an audio track comes first in this fixture; picking it would report mp4a');
});

test('a bare avc1 byte sequence outside stsd never satisfies the codec check', () => {
  // The shortcut this guards against is `bytes.includes("avc1")`. A free box, a filename
  // in udta, or plain luck inside compressed payload all match it — and reporting H.264
  // for an HEVC file is the exact bug this module exists to prevent.
  const bytes = Uint8Array.from([
    ...ftyp('isom'),
    ...box('moov', box('free', FOURCC('avc1'), FOURCC('avc1')), trak('vide', 'hvc1')),
    ...box('mdat', [1, 2, 3, 4]),
  ]);
  const moov = readBoxes(bytes, { totalSize: bytes.length }).find((b) => b.type === 'moov');
  assert.equal(videoSampleEntryFourcc(bytes, moov), 'hvc1',
    'the decoy must be ignored; only the stsd sample entry counts');
});

test('a file with no video track reports no codec rather than guessing', () => {
  const bytes = Uint8Array.from([...ftyp('isom'), ...box('moov', trak('soun', 'mp4a')), ...box('mdat', [0])]);
  const moov = readBoxes(bytes, { totalSize: bytes.length }).find((b) => b.type === 'moov');
  assert.equal(videoSampleEntryFourcc(bytes, moov), null);
  assert.equal(videoSampleEntryFourcc(bytes, null), null);
});

// ── Whole-file inspection ───────────────────────────────────────────────────

test('inspectLessonVideo identifies a web-ready H.264 file', async () => {
  const { readSlice, size } = reader(mp4({ codec: 'avc1', faststart: true }));
  const insp = await inspectLessonVideo(size, readSlice);
  assert.equal(insp.readable, true);
  assert.equal(insp.codec, 'avc1');
  assert.equal(insp.faststart, true);
  assert.deepEqual(describeVideoContent(insp), { ok: true, reason: null, severity: null, message: '' });
});

test('inspectLessonVideo finds a TRAILING moov without reading the whole file', async () => {
  // The shape of the file that prompted all this: index at ~99.8% of 859 MB.
  const bytes = mp4({ codec: 'avc1', faststart: false, mdatBytes: 3 * 1024 * 1024 });
  const { readSlice, stats, size } = reader(bytes);
  const insp = await inspectLessonVideo(size, readSlice);
  assert.equal(insp.codec, 'avc1');
  assert.equal(insp.faststart, false);
  assert.ok(insp.moovOffset > size * 0.9, 'moov really is near the end of this fixture');
  assert.ok(stats.bytesRead < size / 2,
    `must seek to the index, not stream the file: read ${stats.bytesRead} of ${size} bytes`);
});

// ── The verdicts ────────────────────────────────────────────────────────────

test('H.265/HEVC is flagged, and the reason names the codec rather than the symptom', async () => {
  for (const codec of ['hvc1', 'hev1']) {
    const { readSlice, size } = reader(mp4({ codec }));
    const v = describeVideoContent(await inspectLessonVideo(size, readSlice));
    assert.equal(v.ok, false, `${codec} must be flagged`);
    assert.equal(v.reason, 'codec-unsupported');
    assert.match(v.message, /H\.265|HEVC/, 'the admin must be told what the file actually is');
    assert.match(v.message, /Firefox/, 'and which students it would fail for');
  }
});

test('AV1, VP9, ProRes and MPEG-4 Part 2 are flagged too — the allowlist is H.264 only', async () => {
  for (const codec of ['av01', 'vp09', 'apch', 'ap4h', 'mp4v', 'dvh1']) {
    const { readSlice, size } = reader(mp4({ codec }));
    const v = describeVideoContent(await inspectLessonVideo(size, readSlice));
    assert.equal(v.reason, 'codec-unsupported', `${codec} must not pass silently`);
  }
});

test('both spellings of H.264 are accepted', async () => {
  assert.deepEqual([...LESSON_VIDEO_CODECS].sort(), ['avc1', 'avc3']);
  for (const codec of LESSON_VIDEO_CODECS) {
    const { readSlice, size } = reader(mp4({ codec }));
    assert.equal(describeVideoContent(await inspectLessonVideo(size, readSlice)).ok, true,
      `${codec} is plain H.264 and must be accepted`);
  }
});

test('a non-faststart H.264 file is flagged, and told the LOSSLESS remedy', async () => {
  const { readSlice, size } = reader(mp4({ codec: 'avc1', faststart: false }));
  const v = describeVideoContent(await inspectLessonVideo(size, readSlice));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not-faststart');
  assert.match(v.message, /faststart/, 'the fix must be named, not merely implied');
  assert.doesNotMatch(v.message, /libx264/,
    'moving the index is a remux (-c copy), not a re-encode — the wrong advice costs hours');
});

test('★ NEITHER finding is a hard refusal — both are warnings the admin may override', async () => {
  // The hard blocks live in validateVideoFile (not an MP4, empty, over the cap). These
  // two do not: `not-faststart` is repaired in-browser by planFaststartRemux and only
  // reaches a human when that declines, and `codec-unsupported` is a judgement about the
  // admin's own audience. Blocking either one is what made every upload cost an ffmpeg
  // pass — nine lesson objects in production are named `*_faststart.mp4` because of it.
  for (const opts of [{ codec: 'hvc1' }, { codec: 'avc1', faststart: false }]) {
    const { readSlice, size } = reader(mp4(opts));
    const v = describeVideoContent(await inspectLessonVideo(size, readSlice));
    assert.equal(v.severity, 'warn', `${JSON.stringify(opts)} must be overridable, not fatal`);
  }
  const { readSlice, size } = reader(mp4({ codec: 'avc1', faststart: true }));
  assert.equal(describeVideoContent(await inspectLessonVideo(size, readSlice)).severity, null,
    'a clean file carries no severity at all');
});

test('a bad codec outranks a bad index — re-encoding fixes both, remuxing fixes one', async () => {
  const { readSlice, size } = reader(mp4({ codec: 'hvc1', faststart: false }));
  assert.equal(describeVideoContent(await inspectLessonVideo(size, readSlice)).reason, 'codec-unsupported',
    'reporting faststart first would send the admin to remux a file that still would not play');
});

// ── Failing open ────────────────────────────────────────────────────────────

test('an unreadable container is UNKNOWN, never BAD — it must fail open', async () => {
  // Blocking on "we could not parse it" would refuse perfectly good lessons whenever this
  // walker meets a shape it does not know. The decode probe still runs afterwards, so
  // failing open here is exactly today's behaviour and never worse.
  for (const bytes of [new Uint8Array(0), Uint8Array.from([1, 2, 3]), Uint8Array.from(new Array(64).fill(7))]) {
    const { readSlice } = reader(bytes);
    assert.equal(describeVideoContent(await inspectLessonVideo(bytes.length || 1, readSlice)).ok, true,
      'unparseable must not be refused');
  }
  assert.equal(describeVideoContent(null).ok, true);
  assert.equal(describeVideoContent(undefined).ok, true);
});

test('a parsable file whose codec cannot be determined is still accepted', async () => {
  const bytes = Uint8Array.from([...ftyp('isom'), ...box('moov', trak('soun', 'mp4a')), ...box('mdat', [0, 0])]);
  const { readSlice, size } = reader(bytes);
  const insp = await inspectLessonVideo(size, readSlice);
  assert.equal(insp.codec, null);
  assert.equal(describeVideoContent(insp).ok, true, 'no video track found is not proof of a bad codec');
});

test('inspectLessonVideo never throws, whatever the reader does', async () => {
  const insp = await inspectLessonVideo(1024, async () => { throw new Error('disk gone'); });
  assert.equal(insp.codec, null);
  assert.equal(describeVideoContent(insp).ok, true, 'a read failure must not block the admin');
  assert.equal((await inspectLessonVideo(0, async () => new Uint8Array(0))).readable, false);
  assert.equal((await inspectLessonVideo(1024, null)).readable, false);
  assert.equal((await inspectLessonVideo(NaN, async () => new Uint8Array(0))).readable, false);
});

// ── The budget the reported bug was actually about ──────────────────────────

test('the verification budget leaves room for a cold object fetch', () => {
  // The reported failure was a flat 20 s budget against a ~50 s cold tail seek, measured
  // on this project's Storage. Faststart is enforced now so the probe reads the head
  // (~1.7 s), but the budget must not drift back under what was actually observed.
  assert.ok(LESSON_VIDEO_VERIFY_TIMEOUT_MS >= 60_000,
    `verification budget ${LESSON_VIDEO_VERIFY_TIMEOUT_MS}ms is below the measured cold-fetch cost`);
});

// ── Reading the object's real length off a ranged response ──────────────────
//
// This nearly shipped as a bug that would have failed EVERY upload. The completeness
// check compares the object's total length against the bytes we sent, and the total was
// read as `content-range ?? content-length`. But `Content-Range` is not a CORS-safelisted
// response header and Supabase Storage does not expose it, so in the browser it is null on
// every real call — while `Content-Length` on a 206 is the size of the RANGE, 65536. The
// fallback therefore compared 64 KiB against 859 MB and called a perfect upload incomplete.
// Verified from the live app origin on 2026-09-03: status 206, 65536 bytes, content-range
// null. There is no fallback now, and this is what keeps one from being added back.

test('parseObjectTotalBytes reads the total after the slash, not the range length', () => {
  assert.equal(parseObjectTotalBytes('bytes 0-65535/900376169'), 900376169);
  assert.equal(parseObjectTotalBytes('bytes 898279017-900376168/900376169'), 900376169);
  assert.equal(parseObjectTotalBytes(' bytes 0-99 / 1024 '), 1024);
});

test('parseObjectTotalBytes returns null rather than guessing', () => {
  for (const bad of [null, undefined, '', 'bytes 0-99/*', 'bytes */1024', '900376169',
    'items 0-99/500', 'bytes 0-99/0', 'bytes 0-99/abc']) {
    assert.equal(parseObjectTotalBytes(bad), null, `${JSON.stringify(bad)} must not yield a number`);
  }
});

test('a Content-Length value is never mistaken for the object total', () => {
  // The exact shape of the near-miss: the chunk length arriving where the total belongs.
  assert.equal(parseObjectTotalBytes('65536'), null,
    'a bare length must not parse as a total — that is Content-Length, and it is the range size');
});

// ── The oversize advisory ───────────────────────────────────────────────────
// Advisory ONLY. It never blocks and never gates a save. It exists because the
// recorders in use here produce screen captures at ~30 Mbps — a 124 MB local test file
// holds 35 seconds — and one live lesson is 1.45 GiB, 72% of the whole 2 GiB ceiling.

test('a normal screen recording is not called heavy', () => {
  // 40 minutes at ~2 Mbps — a typical faststart H.264 lesson.
  const w = describeVideoWeight(600 * 1000 * 1000, 40 * 60);
  assert.equal(w.heavy, false);
  assert.equal(w.message, '');
});

test('a wildly over-bitrate recording is flagged, with the number that shows it', () => {
  const w = describeVideoWeight(130472525, 34.95);          // the real 124 MB test file
  assert.equal(w.heavy, true);
  assert.ok(w.bitsPerSecond > 29 * 1000 * 1000, 'that file really is ~30 Mbps');
  assert.match(w.message, /Mbps/, 'the admin must see the number, not just an adjective');
  assert.match(w.message, /upload fine/, 'it must be unmistakably advisory, never a refusal');
});

test('an unknown duration produces no opinion at all', () => {
  // The duration comes from a decode probe that is allowed to fail. Without a
  // denominator any verdict would be a guess, and it would be told to the admin as fact.
  for (const secs of [null, undefined, 0, -1, NaN, 'abc']) {
    assert.equal(describeVideoWeight(2 * 1000 * 1000 * 1000, secs).heavy, false,
      `duration ${JSON.stringify(secs)} must yield no verdict`);
  }
  assert.equal(describeVideoWeight(0, 60).heavy, false);
  assert.equal(describeVideoWeight(null, 60).heavy, false);
});

test('the heavy threshold sits well above a real lesson and well below the pathological one', () => {
  assert.ok(LESSON_VIDEO_HEAVY_BPS > 3 * 1000 * 1000, 'must not nag about ordinary 1080p');
  assert.ok(LESSON_VIDEO_HEAVY_BPS < 29 * 1000 * 1000, 'must catch the 30 Mbps captures');
});

// ── Purity ──────────────────────────────────────────────────────────────────

test('inspection never touches the network', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; return Promise.reject(new Error('no')); };
  try {
    const { readSlice, size } = reader(mp4({ codec: 'hvc1' }));
    describeVideoContent(await inspectLessonVideo(size, readSlice));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0, 'the whole point is that this runs against a local File, offline');
});
