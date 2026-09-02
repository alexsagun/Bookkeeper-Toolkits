// ─────────────────────────────────────────────────────────────────────────────
// npm run storage:config [-- --apply]
// ─────────────────────────────────────────────────────────────────────────────
// Read — and with --apply, raise — the PROJECT-WIDE Supabase Storage upload limit.
//
// WHY THIS EXISTS
//   Supabase enforces min(bucket file_size_limit, project-wide fileSizeLimit).
//   db/2026-08-24-course-video-upload-only.sql (#44) set course-videos to 2 GiB and
//   documented the project-wide step in three places as MANUAL. It was never done.
//   The project sat at the 50 MiB default — which upgrading to Pro does NOT change —
//   so every lesson video over 50 MiB failed at ~6 MiB (one TUS chunk), while the app
//   told the admin their file exceeded 2 GB. The bucket's 2 GiB had never meant
//   anything, and nothing in the repo could tell: this value is storage-api config,
//   not a row, so no migration, no test-db suite and no db:shadow:verify can see it.
//
//   npm run db:audit now DETECTS that drift. This script FIXES it, so the audit's
//   FAIL line can name a command instead of asking someone to click through a
//   dashboard — which is the class of instruction that produced the outage.
//
// ★ THERE IS DELIBERATELY NO --limit FLAG.
//   The target is exactly LESSON_VIDEO_MAX_BYTES, imported from the same module the
//   browser enforces. The Dashboard field happily accepts "2000000000" typed as
//   "2 GB" — 147 MiB short of the bucket — which would reintroduce the identical bug
//   at 1.86 GiB instead of 6 MiB, where it is far harder to recognise. A command that
//   cannot be typed wrong beats a text field that can.
//
// SAFETY
//   · Read-only by default. Nothing is written without --apply.
//   · The project ref is hardcoded, exactly as scripts/audit-db.mjs hardcodes it, so
//     no stray env var can point a privileged write at another database.
//   · Idempotent: already at or above the target is a no-op.
//   · REFUSES TO LOWER an existing higher limit. A script that can shrink production's
//     upload ceiling is a footgun with no use case.
//   · The access token is read from .env and never printed; errors are truncated.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LESSON_VIDEO_MAX_BYTES, LESSON_VIDEO_BUCKET } from '../src/lib/courseVideo.js';
// Imported, not re-implemented: the audit and the fix must agree on what "correct"
// means, or the fix can leave the audit still failing.
import { describeStorageLimits, prettyBytes } from './audit-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The production project. Hardcoded on purpose — see the SAFETY note above.
const LIVE_REF = 'ifxcobxsjdjzlozagmls';

function managementToken() {
  let raw = '';
  try { raw = readFileSync(join(REPO, '.env'), 'utf8'); } catch { /* handled below */ }
  const m = /^SUPABASE_ACCESS_TOKEN=(.*)$/m.exec(raw);
  const token = m && m[1].trim().replace(/^["']|["']$/g, '');
  if (!token) {
    console.error(
      'SUPABASE_ACCESS_TOKEN not found in .env.\n'
      + 'Create one at Supabase Dashboard → Account → Access Tokens, then add:\n'
      + '  SUPABASE_ACCESS_TOKEN=sbp_…',
    );
    process.exit(2);
  }
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Management API call. `body` present => PATCH. Errors never carry the token. */
async function api(path, token, body) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res; let text;
    try {
      res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}${path}`, {
        method: body ? 'PATCH' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      text = await res.text();
    } catch (e) {
      last = e;                                   // transport failure — worth another try
      if (attempt === 4) throw e;
      await sleep(600 * 2 ** attempt);
      continue;
    }
    if (res.ok) return text ? JSON.parse(text) : {};
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch { /* raw */ }
    last = new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
    // ★ A 4xx that is not 429 will not answer differently on a retry — an expired token
    //   stays expired. Surface it now instead of after ~19s of silent backoff.
    if (res.status < 500 && res.status !== 429) throw last;
    if (attempt === 4) throw last;
    await sleep(600 * 2 ** attempt);
  }
  // ★ Never lose the real status. This used to throw Error('unreachable'), which
  //   turned five 503s into an audit FAIL line that named no cause.
  throw last || new Error('unreachable');
}

async function sql(query, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(text).slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

/**
 * The lesson bucket's EFFECTIVE ceiling — min(bucket, project) — and whether it exists.
 *
 * ★ A MISSING bucket is not "no own limit". Treating the two alike reported
 *   "effective ceiling: 2 GiB — verified" for a project where lesson video cannot be
 *   stored at all.
 */
function lessonCeiling(buckets, projectLimit) {
  const row = buckets.find((b) => b.id === LESSON_VIDEO_BUCKET);
  if (!row) return { present: false, ceiling: 0 };
  return {
    present: true,
    ceiling: row.file_size_limit == null
      ? projectLimit
      : Math.min(Number(row.file_size_limit), projectLimit),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = managementToken();
  const target = LESSON_VIDEO_MAX_BYTES;

  console.log(`\nStorage upload limits — project ${LIVE_REF}`);
  console.log(`  mode   : ${apply ? 'APPLY (writes)' : 'dry run (no writes)'}`);
  console.log(`  target : ${prettyBytes(target)} (${target})  — from LESSON_VIDEO_MAX_BYTES\n`);

  const cfg = await api('/config/storage', token);
  const buckets = await sql(
    'select id, file_size_limit from storage.buckets order by id', token,
  );
  const current = Number(cfg?.fileSizeLimit);
  const verdict = describeStorageLimits({
    projectLimit: current, buckets, required: target,
  });

  console.log(`  project-wide fileSizeLimit : ${prettyBytes(current)} (${current})`);
  console.log('\n  Effective limit per bucket — Supabase enforces the SMALLER of the two:\n');
  for (const b of buckets) {
    const eff = b.file_size_limit == null
      ? current
      : Math.min(Number(b.file_size_limit), current);
    const capped = b.file_size_limit != null && Number(b.file_size_limit) > current;
    console.log(
      `    ${b.id.padEnd(20)} bucket ${
        (b.file_size_limit == null ? 'none' : prettyBytes(b.file_size_limit)).padEnd(9)
      } → effective ${prettyBytes(eff).padEnd(9)}${capped ? '  ⚠ capped by the project limit' : ''}`,
    );
  }
  console.log('');

  if (!verdict.belowRequired) {
    // ★ The SAME checks the --apply path runs after writing. They used to live only
    //   there, so the "already at target" branch — the one a correctly-configured
    //   project always takes — printed a green tick without ever looking at the lesson
    //   bucket. A 50 MiB course-videos under a 2 GiB project limit passed silently.
    const lc = lessonCeiling(buckets, current);
    const problems = [];
    if (verdict.overPromising.length) {
      problems.push(`buckets promising more than the project allows: ${verdict.overPromising.join(', ')}`);
    }
    if (!lc.present) {
      problems.push(`the ${LESSON_VIDEO_BUCKET} bucket does not exist — run db/2026-08-24-course-video-upload-only.sql`);
    } else if (lc.ceiling < target) {
      problems.push(`${LESSON_VIDEO_BUCKET} effective ceiling is ${prettyBytes(lc.ceiling)}, below the ${prettyBytes(target)} lesson cap`);
    }
    if (problems.length) {
      console.log(`✘ The project-wide limit allows ${prettyBytes(target)}, but the picture is not consistent:`);
      for (const p of problems) console.log(`  · ${p}`);
      console.log('');
      process.exit(1);
    }
    console.log(`✔ The project-wide limit already allows ${prettyBytes(target)}, and `
      + `${LESSON_VIDEO_BUCKET} can carry it (effective ${prettyBytes(lc.ceiling)}). Nothing to do.\n`);
    process.exit(0);
  }

  // Refuse to lower. Unreachable while belowRequired is true, but stated explicitly
  // so the intent survives anyone later making the target configurable.
  if (Number.isFinite(current) && current > target) {
    console.log(`✘ Refusing to LOWER the project limit from ${prettyBytes(current)} to ${prettyBytes(target)}.\n`);
    process.exit(1);
  }

  if (!apply) {
    console.log(`✘ The project-wide limit is below ${prettyBytes(target)}, so uploads over `
      + `${prettyBytes(current)} fail with a 413 partway through.`);
    console.log('  Re-run with --apply to raise it:\n');
    console.log('      npm run storage:config -- --apply\n');
    process.exit(1);
  }

  console.log(`Raising the project-wide limit to ${prettyBytes(target)} (${target})…`);
  await api('/config/storage', token, { fileSizeLimit: target });

  // Read back. A PATCH that returns 200 and did not take effect is exactly the kind of
  // silent success that produced this bug in the first place.
  //
  // ★ AND COMPARE THE WHOLE CONFIG, not just the field we set. The PATCH body carries
  //   only fileSizeLimit; if the endpoint ever replaced nested objects rather than
  //   merging them, this call would silently disable imageTransformation / s3Protocol
  //   and a one-field check would still print a tick. (Verified merging on 2026-09-02 —
  //   every features value was byte-identical across the write — but "verified once" is
  //   not a guarantee, and this script exists because a limit nobody re-checked drifted.)
  const after = await api('/config/storage', token);
  const gotLimit = Number(after?.fileSizeLimit);
  if (gotLimit !== target) {
    console.error(`\n✘ Read-back mismatch: expected ${target}, got ${gotLimit}.`);
    console.error('  On the Free plan the limit cannot exceed 52428800 — check the org plan.\n');
    process.exit(1);
  }
  const beforeRest = JSON.stringify({ ...cfg, fileSizeLimit: null });
  const afterRest = JSON.stringify({ ...after, fileSizeLimit: null });
  if (beforeRest !== afterRest) {
    console.error('\n✘ The PATCH changed more than the size limit. Nested config differs:');
    console.error(`  before: ${beforeRest.slice(0, 300)}`);
    console.error(`  after : ${afterRest.slice(0, 300)}`);
    console.error('  Restore the other settings in Dashboard → Storage → Settings.\n');
    process.exit(1);
  }
  // ★ RE-VALIDATE AGAINST THE NEW LIMIT BEFORE CLAIMING SUCCESS.
  //   The verdict computed at the top of main() used the OLD project limit. A bucket
  //   whose own limit sits above the NEW ceiling still over-promises, so without this
  //   the fixer prints a tick while the detector (npm run db:audit) fails — and a fixer
  //   that disagrees with its own detector is worse than no fixer.
  const afterBuckets = await sql('select id, file_size_limit from storage.buckets order by id', token);
  const afterVerdict = describeStorageLimits({
    projectLimit: gotLimit, buckets: afterBuckets, required: target,
  });

  // And the LESSON bucket specifically: the effective ceiling is min(bucket, project),
  // so raising the project alone does not deliver 2 GB if that bucket is lower.
  //
  // ★ Deliberately NOT a blanket "every bucket must reach the lesson cap" rule. Four of
  //   the five buckets are meant to be far smaller — avatars 5 MB, enrollment-receipts
  //   10 MB, community-media and course-media 50 MB — and failing them would make this
  //   report permanently red, which is precisely how the #44 external-link check stopped
  //   being read and how this whole class of drift survived.
  const lc = lessonCeiling(afterBuckets, gotLimit);

  if (!afterVerdict.ok || !lc.present || lc.ceiling < target) {
    console.error('\n✘ The project limit was raised, but the picture is still not consistent:');
    if (afterVerdict.overPromising.length) {
      console.error(`  buckets promising more than the project allows: ${afterVerdict.overPromising.join(', ')}`);
    }
    if (!lc.present || lc.ceiling < target) {
      console.error(`  ${LESSON_VIDEO_BUCKET} effective ceiling is ${prettyBytes(lc.ceiling)}, `
        + `below the ${prettyBytes(target)} lesson cap — raise that bucket’s own limit `
        + '(db/2026-08-24-course-video-upload-only.sql sets it).');
    }
    console.error('');
    process.exit(1);
  }

  console.log(`\n✔ project-wide fileSizeLimit is now ${prettyBytes(gotLimit)} (${gotLimit}).`);
  console.log(`  ${LESSON_VIDEO_BUCKET} effective ceiling: ${prettyBytes(lc.ceiling)} — verified after the write.`);
  console.log('  Verify the whole picture with: npm run db:audit\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nstorage:config failed: ${String(e?.message || e).slice(0, 300)}\n`);
  process.exit(2);
});
