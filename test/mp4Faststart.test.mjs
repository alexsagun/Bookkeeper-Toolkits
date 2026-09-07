// Pins the in-browser faststart remux in src/lib/mp4Faststart.js.
//
// Why this suite is unusually paranoid. Every other check in the lesson-video pipeline is
// structurally incapable of catching the bug this module could introduce:
//
//   • confirmSignedObject compares the uploaded object's size against the local file's.
//     A remux CANNOT change the size — that is its defining property — so this check is
//     by construction blind to a wrong index.
//   • the ftyp sniff reads bytes 4-8. A corrupt remux still starts with `ftyp`.
//   • probeVideoMetadata resolves on `loadedmetadata`, which fires once the demuxer has
//     parsed `moov` and has decoded ZERO samples. A moov whose every chunk offset is
//     wrong still reports the correct duration, dimensions and codec.
//   • tus only counts bytes.
//
// So the failure mode is a 1.45 GiB paid lesson that uploads clean, verifies clean, and
// plays as noise for students. The assertions below are written against that, not against
// "did the function return ok".
//
// Every fixture is hand-built ISO-BMFF — no media files, no browser, no File API. The
// >4 GiB cases use a sparse reader that fabricates headers on demand rather than
// allocating, so this suite stays fast and memory-flat.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planFaststartRemux,
  applyRemuxPlan,
  FASTSTART_REFUSALS,
  MAX_REMUX_MOOV_BYTES,
} from '../src/lib/mp4Faststart.js';
import {
  readBoxes,
  inspectLessonVideo,
  describeVideoContent,
  LESSON_VIDEO_MAX_BYTES,
} from '../src/lib/courseVideo.js';

// ── Fixture vocabulary (same idiom as test/courseVideoContent.test.mjs) ─────

const FOURCC = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n) => [...u32(Math.floor(n / 0x100000000)), ...u32(n >>> 0)];

/** One ISO-BMFF box: 4-byte big-endian size, 4-byte type, then payload. */
function box(type, ...payloads) {
  const body = payloads.flat();
  return [...u32(8 + body.length), ...FOURCC(type), ...body];
}

/** A box header declaring a 64-bit largesize, for spans above 4 GiB. */
function boxHeader64(type, totalBytes) {
  return [0, 0, 0, 1, ...FOURCC(type), ...u64(totalBytes)];
}

function hdlr(handlerType) {
  return box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], FOURCC(handlerType), [0, 0, 0, 0]);
}

function stsd(codec) {
  return box('stsd', [0, 0, 0, 0], u32(1), box(codec, new Array(8).fill(0)));
}

const stco = (offsets) => box('stco', [0, 0, 0, 0], u32(offsets.length), ...offsets.map(u32));
const co64 = (offsets) => box('co64', [0, 0, 0, 0], u32(offsets.length), ...offsets.map(u64));

/** dinf > dref > `url ` — flags bit 0 set means "the media is in THIS file". */
const dinf = (selfContained = true) => box(
  'dinf', box('dref', [0, 0, 0, 0], u32(1), box('url ', [0, 0, 0, selfContained ? 1 : 0])),
);

function ftyp() {
  return box('ftyp', FOURCC('isom'), u32(0), FOURCC('isom'), FOURCC('mp41'));
}

function trakWith({ handler, codec, offsets, wide, stblExtras, selfContained, omitChunkTable }) {
  const table = omitChunkTable ? [] : (wide ? co64(offsets) : stco(offsets));
  // `.flat()` because `box()` flattens exactly one level: a list OF boxes would
  // otherwise be emitted as a nested array and silently corrupt the byte stream.
  return box('trak', box('mdia', hdlr(handler), box('minf',
    dinf(selfContained),
    box('stbl', stsd(codec), table, (stblExtras || []).flat()))));
}

const DEFAULT_TRACKS = [{ handler: 'vide', codec: 'avc1' }, { handler: 'soun', codec: 'mp4a' }];

/**
 * A whole MP4 whose chunk offsets REALLY POINT at marked bytes inside the mdat.
 *
 * The markers are what make the round-trip assertion meaningful: after the remux we look
 * up each patched offset in the OUTPUT and require the marker to still be there. That
 * catches a wrong sign, a wrong predicate, a skipped table and an off-by-moovSize —
 * none of which an "did it grow by S?" assertion would catch.
 *
 * Built in two passes because a faststart layout's offsets depend on the moov's size:
 * pass one with zeroed tables just to measure it, pass two for real. The entry count is
 * identical in both, so the size is too (asserted by the caller).
 */
function buildMp4(options = {}) {
  const {
    tracks = DEFAULT_TRACKS,
    chunksPerTrack = 3,
    wide = false,
    faststart = false,
    mdatPayload = 4096,
    leading = [],
    trailing = [],
    moovExtras = [],
    stblExtras = [],
    selfContained = true,
    omitChunkTable = false,
    duplicateMoov = false,
    mangleMoov = null,
    overrideOffsets = null,
  } = options;

  const ftypBytes = ftyp();
  const leadBytes = leading.flat();
  const trailBytes = trailing.flat();

  const makeMoov = (offsetsByTrack) => {
    const traks = tracks.map((t, i) => trakWith({
      ...t, offsets: offsetsByTrack[i], wide, stblExtras, selfContained, omitChunkTable,
    }));
    const built = box('moov', moovExtras.flat(), ...traks);
    return mangleMoov ? mangleMoov(built) : built;
  };

  const zeroed = tracks.map(() => new Array(chunksPerTrack).fill(0));
  const moovSize = makeMoov(zeroed).length;

  const ftypEnd = ftypBytes.length;
  const mdatStart = faststart
    ? ftypEnd + leadBytes.length + moovSize
    : ftypEnd + leadBytes.length;
  const moovStart = faststart ? ftypEnd + leadBytes.length : mdatStart + 8 + mdatPayload;
  const payloadStart = mdatStart + 8;

  const perChunk = Math.floor(mdatPayload / (tracks.length * chunksPerTrack));
  const chunks = [];
  const offsetsByTrack = tracks.map((_, ti) => Array.from({ length: chunksPerTrack }, (_, ci) => {
    const id = ti * chunksPerTrack + ci;
    const offset = payloadStart + id * perChunk;
    chunks.push({ id, offset });
    return offset;
  }));

  const finalOffsets = overrideOffsets
    ? overrideOffsets(offsetsByTrack, { payloadStart, moovStart, moovSize, mdatStart })
    : offsetsByTrack;
  const moovBytes = makeMoov(finalOffsets);

  // Marker: C0 DE <id:16be>, written at each chunk's real position in the payload.
  const payload = new Array(mdatPayload).fill(0x21);
  for (const { id, offset } of chunks) {
    const rel = offset - payloadStart;
    payload[rel] = 0xc0; payload[rel + 1] = 0xde;
    payload[rel + 2] = (id >>> 8) & 255; payload[rel + 3] = id & 255;
  }

  const mdatBytes = box('mdat', payload);
  const ordered = faststart
    ? [ftypBytes, leadBytes, moovBytes, mdatBytes, trailBytes]
    : [ftypBytes, leadBytes, mdatBytes, moovBytes, ...(duplicateMoov ? [moovBytes] : []), trailBytes];

  const bytes = Uint8Array.from(ordered.flat());
  return { bytes, fileSize: bytes.length, ftypEnd, mdatStart, moovStart, moovSize, chunks };
}

/** Serve bytes the way a browser File does, recording every read. */
function reader(bytes) {
  const reads = [];
  const readSlice = async (start, end) => {
    reads.push({ start, end, length: end - start });
    return bytes.slice(start, end);
  };
  return { readSlice, reads, size: bytes.length };
}

/**
 * A file too big to allocate. `regions` are the byte ranges that actually matter (the
 * headers and the moov); everything else reads as filler. Lets the >4 GiB overflow and
 * co64 cases run in milliseconds with no memory.
 */
function sparseReader(fileSize, regions) {
  const readSlice = async (start, end) => {
    const out = new Uint8Array(end - start).fill(0x21);
    for (const { at, bytes } of regions) {
      for (let i = 0; i < bytes.length; i += 1) {
        const abs = at + i;
        if (abs >= start && abs < end) out[abs - start] = bytes[i];
      }
    }
    return out;
  };
  return { readSlice, size: fileSize };
}

/** The transform under test, stated independently of the implementation. */
const expectedOffset = (offset, moovStart, moovSize) => (offset < moovStart ? offset + moovSize : offset);

function markerAt(bytes, offset) {
  if (bytes[offset] !== 0xc0 || bytes[offset + 1] !== 0xde) return null;
  return (bytes[offset + 2] << 8) | bytes[offset + 3];
}

// ── Round trip: the bytes actually end up where the index says ──────────────

test('a non-faststart file comes back with moov in front and everything else in order', async () => {
  const f = buildMp4();
  const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  assert.equal(plan.ok, true, `expected a plan, got ${plan.reason}`);

  const out = applyRemuxPlan(f.bytes, plan);
  assert.deepEqual(readBoxes(out, { totalSize: out.length }).map((b) => b.type), ['ftyp', 'moov', 'mdat']);
});

test('★ every patched chunk offset still points at the byte it pointed at before', async () => {
  const f = buildMp4({ chunksPerTrack: 4 });
  const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  assert.equal(plan.ok, true);
  const out = applyRemuxPlan(f.bytes, plan);

  // Sanity: the markers were really there in the source, or this test proves nothing.
  for (const { id, offset } of f.chunks) {
    assert.equal(markerAt(f.bytes, offset), id, `fixture is wrong: no marker ${id} at ${offset}`);
  }

  // Read the offsets back out of the REMUXED moov and follow each one.
  const moov = readBoxes(out, { totalSize: out.length }).find((b) => b.type === 'moov');
  const patched = [];
  const walk = (start, end) => {
    for (const b of readBoxes(out, { start, end })) {
      if (b.type === 'stco') {
        const n = (out[b.dataStart + 4] << 24 >>> 0) + (out[b.dataStart + 5] << 16)
          + (out[b.dataStart + 6] << 8) + out[b.dataStart + 7];
        for (let i = 0; i < n; i += 1) {
          const at = b.dataStart + 8 + i * 4;
          patched.push(out[at] * 0x1000000 + (out[at + 1] << 16) + (out[at + 2] << 8) + out[at + 3]);
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(b.type)) walk(b.dataStart, b.dataEnd);
    }
  };
  walk(moov.dataStart, moov.dataEnd);

  assert.equal(patched.length, f.chunks.length, 'every chunk must survive into the output');
  patched.sort((a, b) => a - b);
  const wanted = f.chunks.map((c) => expectedOffset(c.offset, f.moovStart, f.moovSize)).sort((a, b) => a - b);
  assert.deepEqual(patched, wanted, 'the offsets must be the source offsets shifted by exactly moovSize');

  for (const { id, offset } of f.chunks) {
    const moved = expectedOffset(offset, f.moovStart, f.moovSize);
    assert.equal(markerAt(out, moved), id,
      `chunk ${id} moved from ${offset} to ${moved} but its bytes are not there`);
  }
});

test('output size equals input size, across every layout', async () => {
  const shapes = [
    { name: 'plain', opts: {} },
    { name: 'a free box before mdat', opts: { leading: [box('free', new Array(64).fill(0))] } },
    { name: 'a free box after moov (region B)', opts: { trailing: [box('free', new Array(32).fill(0))] } },
    { name: 'co64 tables', opts: { wide: true } },
    { name: 'three tracks', opts: { tracks: [...DEFAULT_TRACKS, { handler: 'meta', codec: 'mebx' }] } },
    { name: 'one track', opts: { tracks: [{ handler: 'vide', codec: 'avc1' }] } },
  ];
  for (const { name, opts } of shapes) {
    const f = buildMp4(opts);
    const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
    assert.equal(plan.ok, true, `${name}: ${plan.reason}`);
    assert.equal(plan.outputSize, f.fileSize, `${name}: size changed`);
    assert.equal(applyRemuxPlan(f.bytes, plan).length, f.fileSize, `${name}: applied size changed`);
  }
});

test('ftyp is preserved byte for byte and is still the first box', async () => {
  const f = buildMp4();
  const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  const out = applyRemuxPlan(f.bytes, plan);
  assert.deepEqual([...out.slice(0, f.ftypEnd)], [...f.bytes.slice(0, f.ftypEnd)]);
});

test('both tracks are patched, not just the video one', async () => {
  const f = buildMp4({ chunksPerTrack: 2 });
  const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  assert.equal(plan.ok, true);
  assert.equal(plan.tablesPatched, 2, 'one chunk table per stbl');
  assert.equal(plan.patchedChunks, 4);
  const out = applyRemuxPlan(f.bytes, plan);
  // The audio chunks are the second half of the id range; a video-only walk would miss them.
  for (const { id, offset } of f.chunks.filter((c) => c.id >= 2)) {
    assert.equal(markerAt(out, expectedOffset(offset, f.moovStart, f.moovSize)), id,
      'the audio track kept offsets into the old layout — it would play as noise');
  }
});

test('a trailing box after the moov does not move, and its offsets are left alone', async () => {
  // ftyp | mdat | moov | free — region B is non-empty, which is the least-exercised path.
  const f = buildMp4({ trailing: [box('free', new Array(48).fill(0x5a))] });
  const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  assert.equal(plan.ok, true, plan.reason);
  const out = applyRemuxPlan(f.bytes, plan);
  assert.deepEqual(readBoxes(out, { totalSize: out.length }).map((b) => b.type), ['ftyp', 'moov', 'mdat', 'free']);
  // The trailing bytes sit at the identical absolute offset in both files.
  const tailStart = f.fileSize - 48;
  assert.deepEqual([...out.slice(tailStart)], [...f.bytes.slice(tailStart)]);
});

test('the remuxed bytes are what describeVideoContent calls ready', async () => {
  const f = buildMp4();
  assert.equal(
    describeVideoContent(await inspectLessonVideo(f.fileSize, reader(f.bytes).readSlice)).reason,
    'not-faststart', 'the fixture must start out as the problem we are fixing',
  );
  const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  const out = applyRemuxPlan(f.bytes, plan);
  assert.deepEqual(
    describeVideoContent(await inspectLessonVideo(out.length, reader(out).readSlice)),
    { ok: true, reason: null, severity: null, message: '' },
    'the output must pass the production verdict, not just our own parser',
  );
});

// ── The memory guarantee ────────────────────────────────────────────────────

test('★ the planner never reads a byte of the media payload', async () => {
  const f = buildMp4({ mdatPayload: 65536 });
  let violation = null;
  const readSlice = async (start, end) => {
    // Region A is [ftypEnd, moovStart). Header probes there are 16 bytes; anything
    // larger means we pulled in media, which on a 1.45 GiB file is a dead tab.
    if (start >= f.ftypEnd && start < f.moovStart && end - start > 16) {
      violation = `read ${end - start} bytes at ${start}`;
    }
    return f.bytes.slice(start, end);
  };
  const plan = await planFaststartRemux(f.fileSize, readSlice);
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(violation, null, violation || '');
});

test('the whole plan costs a handful of small reads', async () => {
  const f = buildMp4({ mdatPayload: 1 << 20 });
  const r = reader(f.bytes);
  const plan = await planFaststartRemux(f.fileSize, r.readSlice);
  assert.equal(plan.ok, true);
  const total = r.reads.reduce((n, x) => n + x.length, 0);
  assert.ok(total < f.moovSize + 1024,
    `read ${total} bytes for a ${f.fileSize}-byte file; the moov is ${f.moovSize}`);
});

// ── 64-bit offsets ──────────────────────────────────────────────────────────

test('co64 offsets keep their high word instead of truncating', async () => {
  // A 6 GiB file, served sparsely. The chunk sits above 2^32, so a 32-bit write would
  // silently drop the high word and point the player at a byte 4 GiB too early.
  const FILE = 6 * 1024 * 1024 * 1024;
  const chunk = 5 * 1024 * 1024 * 1024;
  const ftypBytes = ftyp();
  const moovOf = (offset) => box('moov', box('trak', box('mdia', hdlr('vide'),
    box('minf', dinf(true), box('stbl', stsd('avc1'), co64([offset]))))));
  const moovSize = moovOf(0).length;
  const moovStart = FILE - moovSize;
  const mdatHeader = boxHeader64('mdat', moovStart - ftypBytes.length);

  const { readSlice } = sparseReader(FILE, [
    { at: 0, bytes: ftypBytes },
    { at: ftypBytes.length, bytes: mdatHeader },
    { at: moovStart, bytes: moovOf(chunk) },
  ]);
  const plan = await planFaststartRemux(FILE, readSlice);
  assert.equal(plan.ok, true, plan.reason);

  const table = readBoxes(plan.moovBytes, { start: 0, end: plan.moovBytes.length });
  const find = (bytes, boxes, type) => {
    for (const b of boxes) {
      if (b.type === type) return b;
      const kid = find(bytes, readBoxes(bytes, { start: b.dataStart, end: b.dataEnd }), type);
      if (kid) return kid;
    }
    return null;
  };
  const co = find(plan.moovBytes, table, 'co64');
  const view = new DataView(plan.moovBytes.buffer, plan.moovBytes.byteOffset, plan.moovBytes.byteLength);
  const written = view.getUint32(co.dataStart + 8, false) * 0x100000000 + view.getUint32(co.dataStart + 12, false);
  assert.equal(written, chunk + moovSize, 'the 64-bit offset must shift, high word intact');
});

test('a 32-bit table that cannot hold the shifted value is refused, not wrapped', async () => {
  // Above 4 GiB an stco physically cannot express the shifted offset. Wrapping would
  // produce a small number: the file still uploads, every check still passes, and it
  // plays as noise. Unreachable under the 2 GiB cap — guarded so raising the cap fails.
  const ftypBytes = ftyp();
  const chunk = 0xfffffff0;                                  // 16 bytes below the u32 ceiling
  const moovOf = (offset) => box('moov', box('trak', box('mdia', hdlr('vide'),
    box('minf', dinf(true), box('stbl', stsd('avc1'), stco([offset]))))));
  const moovSize = moovOf(0).length;
  const moovStart = 0x100000000 + 4096;
  const FILE = moovStart + moovSize;
  const mdatHeader = boxHeader64('mdat', moovStart - ftypBytes.length);

  const { readSlice } = sparseReader(FILE, [
    { at: 0, bytes: ftypBytes },
    { at: ftypBytes.length, bytes: mdatHeader },
    { at: moovStart, bytes: moovOf(chunk) },
  ]);
  assert.equal((await planFaststartRemux(FILE, readSlice)).reason, 'offset-overflow');
});

test('the 2 GiB upload cap makes that overflow unreachable in production', () => {
  // If the cap is ever raised past 4 GiB this fails, rather than shipping a silent wrap.
  assert.ok(LESSON_VIDEO_MAX_BYTES < 2 ** 32,
    'raise the cap past 4 GiB and stco offsets can overflow — promote to co64 first');
});

// ── Refusals ────────────────────────────────────────────────────────────────

const refusalCases = [
  ['already-faststart', { faststart: true }],
  ['multiple-moov', { duplicateMoov: true }],
  ['fragmented (mvex in moov)', { moovExtras: [box('mvex', box('trex', new Array(24).fill(0)))] }, 'fragmented'],
  ['fragmented (top-level moof)', { trailing: [box('moof', new Array(16).fill(0))] }, 'fragmented'],
  ['fragmented (top-level sidx)', { trailing: [box('sidx', new Array(16).fill(0))] }, 'fragmented'],
  ['encrypted (pssh)', { moovExtras: [box('pssh', new Array(20).fill(0))] }, 'encrypted'],
  ['encrypted (senc in stbl)', { stblExtras: [box('senc', new Array(12).fill(0))] }, 'encrypted'],
  ['encrypted (sinf)', { stblExtras: [box('sinf', new Array(12).fill(0))] }, 'encrypted'],
  ['encrypted (encv sample entry)', { tracks: [{ handler: 'vide', codec: 'encv' }] }, 'encrypted'],
  ['aux-offsets (saio)', { stblExtras: [box('saio', new Array(12).fill(0))] }, 'aux-offsets'],
  ['aux-offsets (saiz)', { stblExtras: [box('saiz', new Array(12).fill(0))] }, 'aux-offsets'],
  ['external-media', { selfContained: false }, 'external-media'],
  ['chunk-table-missing', { omitChunkTable: true }, 'chunk-table-missing'],
];

for (const [label, opts, expected] of refusalCases) {
  test(`refuses: ${label}`, async () => {
    const f = buildMp4(opts);
    const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
    assert.equal(plan.ok, false, `${label} must be refused`);
    assert.equal(plan.reason, expected || label);
    assert.equal(plan.parts, null, 'a refusal must never hand back a partial plan');
  });
}

test('refuses an iloc under a FullBox meta AND under a QuickTime meta', async () => {
  const iloc = box('iloc', new Array(12).fill(0));
  // ISO-BMFF: `meta` is a FullBox, so 4 bytes of version+flags come first.
  const isoMeta = box('meta', [0, 0, 0, 0], iloc);
  // QuickTime: Apple's writer omits them. Guessing one alignment misses the other.
  const qtMeta = box('meta', iloc);
  for (const [name, meta] of [['ISO-BMFF', isoMeta], ['QuickTime', qtMeta]]) {
    const f = buildMp4({ moovExtras: [meta] });
    const plan = await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
    assert.equal(plan.reason, 'item-offsets', `${name} meta: item offsets must be refused`);
  }
});

test('refuses a moov larger than the cap without allocating it', async () => {
  const ftypBytes = ftyp();
  const huge = MAX_REMUX_MOOV_BYTES + 4096;
  const moovStart = ftypBytes.length + 8 + 4096;
  const FILE = moovStart + huge;
  const { readSlice } = sparseReader(FILE, [
    { at: 0, bytes: ftypBytes },
    { at: ftypBytes.length, bytes: box('mdat', new Array(4096).fill(0x21)).slice(0, 8) },
    { at: moovStart, bytes: [...u32(huge), ...FOURCC('moov')] },
  ]);
  assert.equal((await planFaststartRemux(FILE, readSlice)).reason, 'moov-too-large');
});

test('refuses a file with no moov and a file with no mdat', async () => {
  const noMoov = Uint8Array.from([...ftyp(), ...box('mdat', new Array(64).fill(0x21))]);
  assert.equal((await planFaststartRemux(noMoov.length, reader(noMoov).readSlice)).reason, 'no-moov');

  const moovOnly = box('moov', box('trak', box('mdia', hdlr('vide'),
    box('minf', dinf(true), box('stbl', stsd('avc1'), stco([0]))))));
  const noMdat = Uint8Array.from([...ftyp(), ...moovOnly]);
  assert.equal((await planFaststartRemux(noMdat.length, reader(noMdat).readSlice)).reason, 'no-mdat');
});

test('refuses anything whose box chain does not tile the file exactly', async () => {
  const f = buildMp4();

  const withJunk = Uint8Array.from([...f.bytes, 0xde, 0xad, 0xbe, 0xef]);
  assert.equal((await planFaststartRemux(withJunk.length, reader(withJunk).readSlice)).reason, 'malformed',
    'appended junk means we cannot account for every byte');

  const truncated = f.bytes.slice(0, f.fileSize - 16);
  assert.equal((await planFaststartRemux(truncated.length, reader(truncated).readSlice)).reason, 'malformed');

  const notFtypFirst = Uint8Array.from([...box('free', new Array(8).fill(0)), ...f.bytes]);
  assert.equal((await planFaststartRemux(notFtypFirst.length, reader(notFtypFirst).readSlice)).reason, 'malformed');
});

test('refuses an stco whose entry_count overruns its own box', async () => {
  const f = buildMp4({
    // Claim 9999 entries in a box that holds three.
    mangleMoov: (bytes) => {
      const out = [...bytes];
      for (let i = 0; i + 8 <= out.length; i += 1) {
        if (String.fromCharCode(out[i + 4], out[i + 5], out[i + 6], out[i + 7]) === 'stco') {
          const count = i + 8 + 4;                    // header(8) + version/flags(4)
          [out[count], out[count + 1], out[count + 2], out[count + 3]] = u32(9999);
          break;
        }
      }
      return out;
    },
  });
  assert.equal((await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice)).reason, 'malformed');
});

test('refuses chunk offsets that were already impossible', async () => {
  const past = buildMp4({ overrideOffsets: (o, m) => o.map((t) => t.map(() => m.moovStart + 4)) });
  assert.equal((await planFaststartRemux(past.fileSize, reader(past.bytes).readSlice)).reason,
    'offset-out-of-range', 'an offset inside the index is not sample data');

  const beyond = buildMp4({ overrideOffsets: (o) => o.map((t) => t.map(() => 0x7ffffff0)) });
  assert.equal((await planFaststartRemux(beyond.fileSize, reader(beyond.bytes).readSlice)).reason,
    'offset-out-of-range', 'an offset past EOF must not be "fixed" into one that uploads');

  const inFtyp = buildMp4({ overrideOffsets: (o) => o.map((t) => t.map(() => 4)) });
  assert.equal((await planFaststartRemux(inFtyp.fileSize, reader(inFtyp.bytes).readSlice)).reason,
    'offset-out-of-range', 'no sample lives inside ftyp, which does not move');
});

// ── Contracts ───────────────────────────────────────────────────────────────

test('planFaststartRemux never throws, whatever it is handed', async () => {
  const f = buildMp4();
  const inputs = [
    ['a throwing reader', f.fileSize, async () => { throw new Error('disk went away'); }],
    ['a reader returning nothing', f.fileSize, async () => new Uint8Array(0)],
    ['a reader returning junk', f.fileSize, async (s, e) => new Uint8Array(e - s).fill(0xff)],
    ['a reader returning null', f.fileSize, async () => null],
    ['no reader', f.fileSize, null],
    ['size 0', 0, reader(f.bytes).readSlice],
    ['negative size', -1, reader(f.bytes).readSlice],
    ['NaN size', NaN, reader(f.bytes).readSlice],
    ['null size', null, reader(f.bytes).readSlice],
    ['a fractional size', 12.5, reader(f.bytes).readSlice],
  ];
  for (const [name, size, read] of inputs) {
    const plan = await planFaststartRemux(size, read);
    assert.equal(plan.ok, false, `${name} must refuse, not succeed`);
    assert.ok(FASTSTART_REFUSALS.includes(plan.reason), `${name} gave "${plan.reason}"`);
  }
});

test('every refusal is a stable code from the published set, never prose', async () => {
  const seen = new Set();
  for (const [, opts, expected] of refusalCases) {
    const f = buildMp4(opts);
    seen.add((await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice)).reason);
  }
  for (const reason of seen) {
    assert.ok(FASTSTART_REFUSALS.includes(reason), `"${reason}" is not in FASTSTART_REFUSALS`);
    assert.match(reason, /^[a-z][a-z-]*$/, 'reason codes are kebab-case, not sentences');
  }
  assert.equal(new Set(FASTSTART_REFUSALS).size, FASTSTART_REFUSALS.length, 'no duplicate codes');
});

test('the module touches no network and no globals', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('no'); };
  try {
    const f = buildMp4();
    await planFaststartRemux(f.fileSize, reader(f.bytes).readSlice);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});

test('the moov cap comfortably exceeds a real lesson index', () => {
  // The 36-minute 859 MB file that prompted this work had a 1.68 MiB moov.
  assert.ok(MAX_REMUX_MOOV_BYTES > 16 * 1024 * 1024,
    'the cap must never be able to refuse a genuine lesson');
});

test('applyRemuxPlan refuses a refusal', () => {
  assert.equal(applyRemuxPlan(new Uint8Array(4), { ok: false, reason: 'malformed' }), null);
  assert.equal(applyRemuxPlan(new Uint8Array(4), null), null);
});
