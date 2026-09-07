/**
 * Move an MP4's index in front of its media — "faststart" — WITHOUT re-encoding.
 *
 * An MP4 that stores `moov` after `mdat` cannot start playing until the player has
 * reached the very end of the file. Measured against this project's Storage on an
 * 859 MB lesson: a cold tail range took 49.4 s, the same range warm 1.9 s, a range at
 * the head 1.7 s. That cost is paid by the post-upload verification probe — which is
 * by construction the first-ever read of a fresh object, so always the cold case — and
 * again by every student's first play.
 *
 * The app used to answer this by printing an ffmpeg command and refusing the file. It
 * was followed: all nine lesson objects in production are named `*_faststart.mp4`. This
 * module removes that step by doing the rearrangement in the browser instead.
 *
 * ★ THIS IS A BYTE MOVE, NOT A TRANSCODE. The media payload is never read, never
 *   decoded and never rewritten — it is referenced. Output bytes are the input bytes in
 *   a different order, with the chunk-offset tables corrected, at the IDENTICAL size.
 *
 * ★ IT REFUSES RATHER THAN GUESSES. Sixteen stable reason codes, every one of which
 *   falls the caller back to exactly the behaviour that shipped before this module: the
 *   manual ffmpeg remedy. The asymmetry is the whole design — a wrong refusal costs the
 *   admin one command they were already running, while a wrong REWRITE produces a
 *   1.45 GiB paid lesson that uploads clean, verifies clean and plays as noise.
 *
 * ★ IT NEVER THROWS, mirroring `inspectLessonVideo`'s contract. Every failure resolves
 *   to `{ ok: false, reason }`.
 *
 * The planner is pure and takes an injectable `readSlice`, so `test/mp4Faststart.test.mjs`
 * drives it with synthetic buffers and no File API. Turning a plan into an actual upload
 * is the caller's job (`buildFaststartFile` in BookkeeperPro.jsx), deliberately, because
 * that half needs `File`/`Blob` and this half must stay testable under `node --test`.
 *
 * Lockstep: this module ↔ `handlePick`'s remux branch ↔ `test/mp4Faststart.test.mjs` ↔
 * `test/uiSafety.test.mjs` §19. There is NO server half — a faststart remux has no SQL
 * mirror, which is why it lives here rather than in the SQL-mirrored `courseVideo.js`.
 */

import { readBoxes } from './courseVideo.js';

/**
 * The largest `moov` we will read into memory and patch.
 *
 * A moov is proportional to sample count. A 60-minute 1080p30 H.264 + AAC lesson has
 * ~108,000 video and ~169,000 audio samples; `stsz` at 4 bytes each dominates at ~1.1 MB.
 * The 36-minute file that prompted this work measured 1.68 MiB. 64 MiB is ~38x the
 * largest index ever observed here, so it cannot refuse a real lesson — it exists to
 * bound the one allocation this module makes, so a corrupt header claiming a 300 GB
 * moov is a refusal rather than a dead tab.
 */
export const MAX_REMUX_MOOV_BYTES = 64 * 1024 * 1024;

/** A sane ceiling on the top-level chain. Real MP4s have well under ten. */
const MAX_TOP_LEVEL_BOXES = 64;

/** Enough for a box header in either the 8-byte or the 64-bit largesize form. */
const BOX_HEADER_PROBE_BYTES = 16;

/** Depth cap for the moov walk. Real files reach 5; this stops a nesting bomb. */
const MAX_BOX_DEPTH = 8;

/**
 * Every reason `planFaststartRemux` can decline with. Exported so a test can prove the
 * set is closed and that no refusal ever leaks prose the UI would have to interpret.
 */
export const FASTSTART_REFUSALS = Object.freeze([
  'unreadable',            // the reader threw, or the size is not a positive integer
  'malformed',             // the box chain does not tile the file exactly
  'no-moov',               // no index, or it could not be read back whole
  'no-mdat',               // nothing for the index to sit behind
  'multiple-moov',         // which one is authoritative? do not guess
  'already-faststart',     // nothing to do
  'moov-too-large',        // above MAX_REMUX_MOOV_BYTES
  'fragmented',            // fMP4: offsets are moof-relative, moov is already first
  'encrypted',             // CENC carries its own offsets we do not patch
  'aux-offsets',           // saio/saiz: absolute offsets we do not patch
  'external-media',        // dref says the samples live in another file
  'item-offsets',          // iloc: absolute item offsets we do not patch
  'chunk-table-missing',   // an stbl with no chunk table, or a count mismatch
  'offset-out-of-range',   // a chunk offset that was already impossible
  'offset-overflow',       // a 32-bit table that cannot hold the shifted value
]);

/** Boxes we descend into. Everything else is a leaf and its payload is never parsed. */
const REMUX_CONTAINERS = Object.freeze(new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts',
]));

/**
 * Sample-entry fourccs that mean the track is encrypted. The real offsets then live in
 * `saio`, and `sinf`/`schm` hide inside the entry — so testing the entry type catches
 * the whole family without descending into `stsd`, which is a FullBox and would need
 * its own alignment rules.
 */
const ENCRYPTED_SAMPLE_ENTRIES = Object.freeze(new Set([
  'encv', 'enca', 'encs', 'enct', 'encf', 'encm', 'encu',
]));

/** Boxes whose mere presence anywhere in the moov means "we do not handle this". */
const FRAGMENT_MARKERS = Object.freeze(new Set(['mvex', 'moof', 'traf', 'mfra', 'sidx']));
const ENCRYPTION_MARKERS = Object.freeze(new Set(['pssh', 'senc', 'sinf', 'schm', 'schi']));
const AUX_OFFSET_MARKERS = Object.freeze(new Set(['saio', 'saiz']));

const U32_MAX = 0xffffffff;

function refuse(reason) {
  return { ok: false, reason, parts: null, moovBytes: null, outputSize: 0 };
}

function readU32be(bytes, off) {
  // Not `<<24` — that is a SIGNED shift, so a value at or above 2 GiB comes back
  // negative. Same reasoning as readU32 in courseVideo.js, and the same fix.
  return bytes[off] * 0x1000000 + ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]);
}

function fourccAt(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

/** `readSlice` normalized: clamped to the file, always a Uint8Array. */
function clampedReader(size, readSlice) {
  return async (start, end) => {
    const a = Math.max(0, Math.min(start, size));
    const b = Math.max(a, Math.min(end, size));
    if (b <= a) return new Uint8Array(0);
    const raw = await readSlice(a, b);
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  };
}

/**
 * The top-level box chain, walked HEADER BY HEADER — 16 bytes per box, never a payload.
 *
 * ★ This is what keeps a 1.45 GiB lesson to four tiny reads. `inspectLessonVideo` solves
 *   a different problem (find moov fast, wherever it is) with a 256 KiB head window and a
 *   16 MiB tail scan. Here we need the EXACT tiling of the whole file — including
 *   anything AFTER the moov — so we follow the chain instead of scanning windows.
 *
 * Returns `tiled: false` unless the boxes account for every byte. Trailing junk (some
 * downloaders append bytes) and truncation both land there: if we cannot account for
 * every byte we must not rearrange any of them.
 */
async function topLevelBoxes(fileSize, readAt) {
  const out = [];
  let off = 0;
  while (off < fileSize && out.length < MAX_TOP_LEVEL_BOXES) {
    const win = await readAt(off, off + BOX_HEADER_PROBE_BYTES);
    if (win.length < 8) return { boxes: out, tiled: false };
    // `size === 0` ("runs to end of file") needs no special case. readBoxes resolves it
    // against `totalSize`, so the box ends at EOF, the loop ends, and it is by
    // definition the LAST box — which means no `moov` can follow it and the caller
    // refuses with `no-moov` before anything would be relocated. An open-ended box can
    // therefore never sit in the region this module shifts.
    const box = readBoxes(win, { baseOffset: off, totalSize: fileSize })[0];
    if (!box || box.fileStart !== off || box.fileEnd <= off || box.fileEnd > fileSize) {
      return { boxes: out, tiled: false };
    }
    out.push({ type: box.type, fileStart: box.fileStart, fileEnd: box.fileEnd, size: box.size });
    off = box.fileEnd;
  }
  return { boxes: out, tiled: off === fileSize };
}

/**
 * Every box inside the moov, depth-first, with the type of its parent.
 *
 * Offsets are relative to `bytes` (no `baseOffset`), which is what `DataView` wants.
 * Only `REMUX_CONTAINERS` are descended: parsing a leaf's payload as boxes is exactly
 * the class of bug `videoSampleEntryFourcc` exists to avoid, and `udta` in particular
 * is a bag of vendor junk that would misparse into imaginary boxes.
 */
function walkMoov(bytes, moov) {
  const out = [];
  const visit = (start, end, depth, parentType) => {
    if (depth > MAX_BOX_DEPTH) return;
    for (const box of readBoxes(bytes, { start, end })) {
      out.push({ box, parentType });
      if (REMUX_CONTAINERS.has(box.type) && box.complete) {
        visit(box.dataStart, Math.min(box.dataEnd, bytes.length), depth + 1, box.type);
      }
    }
  };
  visit(moov.dataStart, Math.min(moov.dataEnd, bytes.length), 0, 'moov');
  return out;
}

/**
 * `meta` is a FullBox in ISO-BMFF (4 bytes of version+flags before its children) and a
 * PLAIN container in QuickTime — Apple's writer omits them, and an iPhone `.mov` renamed
 * `.mp4` reaches us intact because `validateVideoFile` judges on the extension.
 *
 * Guessing the alignment misparses payload as boxes. So do not guess: try BOTH, and
 * refuse if either finds an `iloc`, whose item offsets are absolute file offsets this
 * module does not patch.
 */
function hasItemLocations(bytes, meta) {
  const end = Math.min(meta.dataEnd, bytes.length);
  return [0, 4].some((skip) => readBoxes(bytes, { start: meta.dataStart + skip, end })
    .some((child) => child.type === 'iloc'));
}

/**
 * A track's media may live in ANOTHER file. `dref` entry flags bit 0 means
 * "self-contained": the chunk offsets index THIS file. Without it they index a file we
 * have never seen, and shifting them corrupts a reference we do not own.
 *
 * Vanishingly rare in a finished MP4 — and exactly the kind of thing that stays rare
 * until it is somebody's paid lesson.
 */
function drefIsSelfContained(bytes, dref) {
  if (dref.dataStart + 8 > bytes.length || dref.dataStart + 8 > dref.dataEnd) return false;
  const count = readU32be(bytes, dref.dataStart + 4);
  const entries = readBoxes(bytes, { start: dref.dataStart + 8, end: Math.min(dref.dataEnd, bytes.length) });
  // A count that disagrees with what we could parse means we cannot account for every
  // entry, so we cannot claim they are all self-contained.
  if (entries.length !== count) return false;
  return entries.every((e) => e.dataStart + 4 <= bytes.length && (bytes[e.dataStart + 3] & 1) === 1);
}

/** Refuse-or-null: everything about the moov that means "not ours to rearrange". */
function classifyMoov(bytes, walked) {
  for (const { box } of walked) {
    if (FRAGMENT_MARKERS.has(box.type)) return 'fragmented';
    if (ENCRYPTION_MARKERS.has(box.type)) return 'encrypted';
    if (AUX_OFFSET_MARKERS.has(box.type)) return 'aux-offsets';
  }
  for (const { box, parentType } of walked) {
    if (box.type === 'meta' && hasItemLocations(bytes, box)) return 'item-offsets';
    if (box.type === 'dref' && parentType === 'dinf' && !drefIsSelfContained(bytes, box)) {
      return 'external-media';
    }
    if (box.type === 'stsd' && parentType === 'stbl') {
      // stsd payload: version+flags(4), entry_count(4), then the sample entries.
      const entries = readBoxes(bytes, {
        start: box.dataStart + 8,
        end: Math.min(box.dataEnd, bytes.length),
      });
      if (entries.some((e) => ENCRYPTED_SAMPLE_ENTRIES.has(e.type.toLowerCase()))) return 'encrypted';
    }
  }
  return null;
}

/**
 * Patch one `stco`/`co64` in place, big-endian.
 *
 * `view` is a DataView over OUR OWN copy of the moov — bounded by MAX_REMUX_MOOV_BYTES
 * and never the user's file — so no write here can reach the media payload.
 *
 * The transform is `o' = o < moovStart ? o + moovSize : o`: everything between the ftyp
 * and the old moov shifts forward by exactly the moov's size, and everything already
 * past the moov does not move at all.
 *
 * ★ `Number` hi/lo rather than BigInt for `co64`, for three reasons. It matches
 *   `readU64` in courseVideo.js, so there is one 64-bit representation in this codebase
 *   rather than two. Every comparison below mixes the offset with plain Numbers, and
 *   `BigInt < Number` THROWS — inside a module whose contract is that it never throws,
 *   on a path only a `co64` file would reach, i.e. one the admin's usual files never
 *   exercise. And it is provably exact: offsets are bounded by the 2 GiB upload cap,
 *   Number is exact to 2^53, and `isSafeInteger` refuses garbage before any arithmetic.
 */
function patchOffsetTable(view, box, wide, ftypEnd, moovStart, moovSize, fileSize) {
  const stride = wide ? 8 : 4;
  if (box.dataStart + 8 > box.dataEnd) return { reason: 'malformed' };
  const count = view.getUint32(box.dataStart + 4, false);
  const base = box.dataStart + 8;
  if (!Number.isSafeInteger(count) || base + count * stride > box.dataEnd) {
    return { reason: 'malformed' };            // entry_count overruns its own box
  }

  for (let i = 0; i < count; i += 1) {
    const at = base + i * stride;
    let offset;
    if (wide) {
      const hi = view.getUint32(at, false);
      const lo = view.getUint32(at + 4, false);
      offset = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(offset)) return { reason: 'offset-out-of-range' };
    } else {
      offset = view.getUint32(at, false);
    }

    // A chunk offset that was already impossible. Do not "fix" a broken file into one
    // that uploads.
    if (offset >= fileSize) return { reason: 'offset-out-of-range' };
    if (offset >= moovStart && offset < moovStart + moovSize) return { reason: 'offset-out-of-range' };
    if (offset < ftypEnd) return { reason: 'offset-out-of-range' };   // no sample lives in ftyp

    if (offset >= moovStart) continue;                                // region B: does not move

    const shifted = offset + moovSize;
    if (shifted > fileSize) return { reason: 'offset-out-of-range' };
    if (wide) {
      view.setUint32(at, Math.floor(shifted / 0x100000000), false);
      view.setUint32(at + 4, shifted >>> 0, false);
    } else {
      // Unreachable while LESSON_VIDEO_MAX_BYTES is 2 GiB (2^31 < 2^32), and guarded
      // anyway: an unguarded overflow wraps to a small number, the file still uploads,
      // every existing check still passes, and it plays as noise.
      if (shifted > U32_MAX) return { reason: 'offset-overflow' };
      view.setUint32(at, shifted, false);
    }
  }
  return { reason: null, patched: count };
}

/**
 * Plan a faststart remux without reading a byte of the media payload.
 *
 * `readSlice(start, end)` resolves to the bytes in `[start, end)` — the same injectable
 * shape `inspectLessonVideo` takes, so this is drivable from `node --test`.
 *
 * On success:
 *   { ok: true, reason: null,
 *     parts: [{kind:'slice',start,end} | {kind:'bytes',data:Uint8Array}, ...],
 *     moovBytes, outputSize, moovOffset, moovSize, patchedChunks, tablesPatched }
 *
 * `parts` is data-only — no Blob, no File, no DOM — so a test can apply it to a
 * Uint8Array and re-parse the result. `outputSize` always equals the input size.
 */
export async function planFaststartRemux(fileSize, readSlice) {
  const size = Number(fileSize);
  if (!Number.isSafeInteger(size) || size <= 0 || typeof readSlice !== 'function') {
    return refuse('unreadable');
  }
  const readAt = clampedReader(size, readSlice);

  try {
    const { boxes, tiled } = await topLevelBoxes(size, readAt);
    if (!boxes.length || !tiled) return refuse('malformed');
    if (boxes[0].type !== 'ftyp' || boxes[0].fileStart !== 0) return refuse('malformed');
    if (boxes.some((b) => FRAGMENT_MARKERS.has(b.type))) return refuse('fragmented');

    const moovs = boxes.filter((b) => b.type === 'moov');
    if (!moovs.length) return refuse('no-moov');
    if (moovs.length > 1) return refuse('multiple-moov');
    const mdat = boxes.find((b) => b.type === 'mdat');
    if (!mdat) return refuse('no-mdat');
    if (moovs[0].fileStart < mdat.fileStart) return refuse('already-faststart');

    const ftypEnd = boxes[0].fileEnd;
    const moovStart = moovs[0].fileStart;
    const moovSize = moovs[0].size;
    if (moovSize > MAX_REMUX_MOOV_BYTES) return refuse('moov-too-large');

    const moovBytes = await readAt(moovStart, moovStart + moovSize);
    if (moovBytes.length !== moovSize) return refuse('no-moov');
    const moov = readBoxes(moovBytes, { start: 0, end: moovSize })[0];
    if (!moov || moov.type !== 'moov' || moov.size !== moovSize || !moov.complete) {
      return refuse('no-moov');
    }

    const walked = walkMoov(moovBytes, moov);
    const disqualified = classifyMoov(moovBytes, walked);
    if (disqualified) return refuse(disqualified);

    const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    let patchedChunks = 0;
    let tablesPatched = 0;
    for (const { box, parentType } of walked) {
      // Only a DIRECT child of an stbl is a chunk table. Anywhere else the fourcc is a
      // coincidence, and patching it would corrupt bytes that are not offsets.
      if (parentType !== 'stbl' || (box.type !== 'stco' && box.type !== 'co64')) continue;
      if (!box.complete) return refuse('malformed');
      const result = patchOffsetTable(
        view, box, box.type === 'co64', ftypEnd, moovStart, moovSize, size,
      );
      if (result.reason) return refuse(result.reason);
      patchedChunks += result.patched;
      tablesPatched += 1;
    }

    // ★ Every stbl must have had exactly one chunk table, and every one must have been
    //   patched. A track we silently skipped keeps offsets into the OLD layout — which
    //   for an audio track plays as noise while the video looks perfect, and NO probe
    //   anywhere would catch it. This is the structural half of that defence; the
    //   caller's decode probe is the empirical half.
    const stblCount = walked.filter((e) => e.box.type === 'stbl').length;
    if (!tablesPatched || !patchedChunks || tablesPatched !== stblCount) {
      return refuse('chunk-table-missing');
    }

    const parts = [{ kind: 'slice', start: 0, end: ftypEnd }, { kind: 'bytes', data: moovBytes }];
    if (moovStart > ftypEnd) parts.push({ kind: 'slice', start: ftypEnd, end: moovStart });
    if (moovStart + moovSize < size) parts.push({ kind: 'slice', start: moovStart + moovSize, end: size });

    const outputSize = parts.reduce(
      (n, p) => n + (p.kind === 'bytes' ? p.data.length : p.end - p.start), 0,
    );
    // The arithmetic must close, and the source ranges must tile everything except the
    // moov's old home. If either fails we ship nothing rather than something.
    if (outputSize !== size) return refuse('malformed');
    const covered = parts.filter((p) => p.kind === 'slice').sort((a, b) => a.start - b.start);
    const expected = [[0, ftypEnd], [ftypEnd, moovStart], [moovStart + moovSize, size]]
      .filter(([a, b]) => b > a);
    if (covered.length !== expected.length
      || covered.some((p, i) => p.start !== expected[i][0] || p.end !== expected[i][1])) {
      return refuse('malformed');
    }

    return {
      ok: true,
      reason: null,
      parts,
      moovBytes,
      outputSize,
      moovOffset: moovStart,
      moovSize,
      patchedChunks,
      tablesPatched,
    };
  } catch (_) {
    return refuse('unreadable');               // unreadable is never "rearrange it anyway"
  }
}

/**
 * Apply a plan to an in-memory source buffer, returning the remuxed bytes.
 *
 * This is the TEST path — the browser never calls it, because materialising 1.45 GiB is
 * the one thing `buildFaststartFile` exists to avoid. It is exported so the suite can
 * round-trip a fixture through the real planner and re-parse the result, rather than
 * asserting against a reimplementation of the same arithmetic.
 */
export function applyRemuxPlan(sourceBytes, plan) {
  if (!plan || !plan.ok) return null;
  const out = new Uint8Array(plan.outputSize);
  let at = 0;
  for (const part of plan.parts) {
    const chunk = part.kind === 'bytes' ? part.data : sourceBytes.subarray(part.start, part.end);
    out.set(chunk, at);
    at += chunk.length;
  }
  return at === plan.outputSize ? out : null;
}
