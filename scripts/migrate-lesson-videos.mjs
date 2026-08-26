#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Legacy lesson-video inventory + relocation into the PRIVATE bucket (#44).
// ─────────────────────────────────────────────────────────────────────────────
//   npm run media:audit     → report only. Never writes. Run this first.
//   npm run media:migrate   → move legacy objects from course-media to course-videos.
//
// WHY
//   Before #15 every lesson video lived in the PUBLIC course-media bucket. The split moved
//   new uploads to the private course-videos bucket, but nothing moved the ones already
//   there — and SignedLessonVideo quietly papered over it with a public-URL fallback that
//   was taken for ANY signing failure, so a legacy object stayed world-readable and nobody
//   could tell. #44 deletes that fallback. This script is what makes deleting it safe.
//
// HOW THE MOVE WORKS
//   storage.from('course-media').copy(path, path, { destinationBucket: 'course-videos' })
//   — a SERVER-SIDE copy. No bytes pass through this process, so a 2 GB lesson costs no
//   memory here. The source is deleted only after the destination is verified to exist,
//   to be non-empty, and to be signable.
//
// SAFETY
//   * Dry-run by DEFAULT. --apply is required to change anything.
//   * Idempotent: an object already in course-videos is skipped, not re-copied.
//   * Resumable: re-running picks up whatever is left.
//   * It NEVER deletes a lesson row, a module, progress, a completion, a transcript or a
//     Zoom replay link, and it never touches video_url. Its only write is to Storage.
//   * It never downloads or scrapes a YouTube/Vimeo video. Those are reported for a human
//     to re-upload, and nothing else.
//
// Needs SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) + VITE_SUPABASE_URL in .env.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

// ── Env (.env, same shape the other scripts read) ───────────────────────────
function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env — rely on the real environment */ }
  return out;
}
const env = loadEnv();
const URL_ = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
const KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) {
  console.error('Missing VITE_SUPABASE_URL and/or SUPABASE_SECRET_KEY. Add them to .env.');
  process.exit(2);
}
const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const PRIVATE_BUCKET = 'course-videos';
const PUBLIC_BUCKET = 'course-media';
const LEGACY_PROVIDERS = ['youtube', 'vimeo', 'mp4'];

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const bytes = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} ${u[i]}`;
};

/** Does an object exist in a bucket? Uses list() on its folder — head-free and cheap. */
async function objectInfo(bucket, path) {
  const idx = path.lastIndexOf('/');
  const dir = idx > 0 ? path.slice(0, idx) : '';
  const name = idx > 0 ? path.slice(idx + 1) : path;
  const { data, error } = await db.storage.from(bucket).list(dir, { limit: 1000, search: name });
  if (error) return { exists: false, size: null, error };
  const hit = (data || []).find((o) => o.name === name);
  return { exists: !!hit, size: hit?.metadata?.size ?? null, error: null };
}

async function main() {
  // ── 1. Read every lesson. Service role, so RLS does not filter. ───────────
  const { data: lessons, error } = await db
    .from('course_lessons')
    .select('id,course_id,title,type,video_provider,video_url,storage_path,text_content');
  if (error) { console.error('Could not read course_lessons:', error.message); process.exit(1); }
  const { data: courses, error: cErr } = await db.from('courses').select('id,slug,title,published,access_tier');
  if (cErr) { console.error('Could not read courses:', cErr.message); process.exit(1); }
  const courseById = new Map((courses || []).map((c) => [c.id, c]));

  const videoLessons = (lessons || []).filter((l) => l.type === 'video');
  const report = {
    externalLinks: [], uploads: [], invalid: [], inPublicBucket: [], sharedPaths: [], moved: [], failed: [], correctCount: 0,
  };

  // ── 2. Classify. Four categories, exactly as the migration's AFTER RUNNING block. ──
  const refCount = new Map();
  for (const l of videoLessons) if (l.storage_path) refCount.set(l.storage_path, (refCount.get(l.storage_path) || 0) + 1);

  for (const l of videoLessons) {
    const c = courseById.get(l.course_id) || {};
    const row = { lesson_id: l.id, title: l.title, course: c.slug, published: !!c.published };
    const hasLink = !!String(l.video_url || '').trim();
    if (LEGACY_PROVIDERS.includes(l.video_provider) && hasLink) {
      report.externalLinks.push({ ...row, provider: l.video_provider, url: l.video_url });
    } else if (l.video_provider === 'upload' && l.storage_path) {
      report.uploads.push({ ...row, storage_path: l.storage_path });
    } else if (l.video_provider === 'upload' && !l.storage_path) {
      report.invalid.push({ ...row, defect: 'upload_without_path' });
    } else if (l.storage_path && l.video_provider !== 'upload') {
      report.invalid.push({ ...row, defect: 'path_without_upload_provider', storage_path: l.storage_path });
    } else if (LEGACY_PROVIDERS.includes(l.video_provider) && !hasLink) {
      report.invalid.push({ ...row, defect: 'link_provider_without_url' });
    } else if (String(l.text_content || '').trim()) {
      report.invalid.push({ ...row, defect: 'notes_only_video_lesson' });
    } else {
      report.invalid.push({ ...row, defect: 'empty_video_lesson' });
    }
  }
  for (const [path, n] of refCount) if (n > 1) report.sharedPaths.push({ storage_path: path, refs: n });

  // ── 3. Where does each uploaded object actually live? ─────────────────────
  // ★ Distinct PATHS, not lesson rows: duplicated courses legitimately share one object
  //   (copy-on-write), so probing per row would re-probe the same file N times.
  const paths = [...new Set(videoLessons.map((l) => l.storage_path).filter(Boolean))];
  const privatePaths = new Set();
  for (const path of paths) {
    const priv = await objectInfo(PRIVATE_BUCKET, path);
    if (priv.exists) { privatePaths.add(path); continue; }   // already private — nothing to do
    const pub = await objectInfo(PUBLIC_BUCKET, path);
    report.inPublicBucket.push({ storage_path: path, in_public: pub.exists, size: pub.size });
  }
  // ★ Counted from the same units. Subtracting a distinct-PATH count from a lesson-ROW
  //   count made this headline wrong wherever a duplicate shared a file — and negative
  //   once two courses shared more files than the source had lessons.
  report.correctCount = report.uploads.filter((u) => privatePaths.has(u.storage_path)).length;

  // ── 4. Move, only with --apply. ──────────────────────────────────────────
  const movable = report.inPublicBucket.filter((r) => r.in_public);
  if (APPLY && movable.length) {
    for (const r of movable) {
      // Server-side copy: no bytes through this process, so file size is irrelevant here.
      const { error: cpErr } = await db.storage.from(PUBLIC_BUCKET)
        .copy(r.storage_path, r.storage_path, { destinationBucket: PRIVATE_BUCKET });
      if (cpErr) { report.failed.push({ ...r, stage: 'copy', message: cpErr.message }); continue; }

      // Verify BEFORE deleting the source: exists, non-empty, and actually signable.
      const dest = await objectInfo(PRIVATE_BUCKET, r.storage_path);
      if (!dest.exists) { report.failed.push({ ...r, stage: 'verify-exists' }); continue; }
      if (r.size != null && dest.size != null && Number(dest.size) !== Number(r.size)) {
        report.failed.push({ ...r, stage: 'verify-size', message: `${dest.size} != ${r.size}` });
        continue;
      }
      const { data: signed, error: sErr } = await db.storage.from(PRIVATE_BUCKET)
        .createSignedUrl(r.storage_path, 60);
      if (sErr || !signed?.signedUrl) { report.failed.push({ ...r, stage: 'verify-sign' }); continue; }

      // Only now. The public copy is what students were being served; losing it before the
      // private one is proven would take the lesson down.
      const { error: rmErr } = await db.storage.from(PUBLIC_BUCKET).remove([r.storage_path]);
      if (rmErr) {
        // The move SUCCEEDED; only the cleanup of the public copy did not. Report it as a
        // move so a re-run does not try to copy again, but name it loudly — that object is
        // still world-readable until it is gone.
        report.moved.push({ ...r, public_copy_remains: true, message: rmErr.message });
        continue;
      }
      report.moved.push({ ...r, public_copy_remains: false });
    }
  }

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return finish(report, movable); }

  // ── 5. Human report ──────────────────────────────────────────────────────
  say('');
  say(`  Lesson video inventory — ${APPLY ? 'APPLY' : 'DRY RUN (nothing was changed)'}`);
  say('  ' + '─'.repeat(72));
  say(`  Video lessons                     ${videoLessons.length}`);
  say(`  Uploaded (private, correct)       ${report.correctCount}  of ${report.uploads.length} upload lesson(s)`);
  say(`  External links, must be replaced  ${report.externalLinks.length}`);
  say(`  Invalid / incomplete              ${report.invalid.length}`);
  say(`  Files not yet in ${PRIVATE_BUCKET}  ${report.inPublicBucket.length}`);
  say(`  Paths shared by 2+ courses        ${report.sharedPaths.length}   (duplication reuses files by reference — expected)`);
  say('');

  if (report.externalLinks.length) {
    say('  EXTERNAL LINKS — a human must upload a replacement for each. Never scraped.');
    const pub = report.externalLinks.filter((r) => r.published);
    if (pub.length) {
      say(`  ★ ${pub.length} of these are in a PUBLISHED course. Those courses cannot be`);
      say('    re-published after #44, and their lessons show students a placeholder.');
    }
    for (const r of report.externalLinks.slice(0, 40)) {
      say(`    ${r.published ? '[LIVE]' : '[draft]'} ${r.course} — ${r.title}  (${r.provider})`);
      say(`            ${r.url}`);
    }
    if (report.externalLinks.length > 40) say(`    …and ${report.externalLinks.length - 40} more`);
    say('');
  }

  if (report.invalid.length) {
    say('  INVALID / INCOMPLETE video lessons:');
    for (const r of report.invalid.slice(0, 40)) say(`    ${r.defect.padEnd(30)} ${r.course} — ${r.title}`);
    if (report.invalid.length > 40) say(`    …and ${report.invalid.length - 40} more`);
    say('');
  }

  if (report.inPublicBucket.length) {
    say(`  FILES NOT IN ${PRIVATE_BUCKET}:`);
    for (const r of report.inPublicBucket.slice(0, 40)) {
      say(`    ${r.in_public ? `in ${PUBLIC_BUCKET} (${bytes(r.size)}) — movable` : 'MISSING from both buckets — re-upload needed'}`);
      say(`      ${r.storage_path}`);
    }
    if (report.inPublicBucket.length > 40) say(`    …and ${report.inPublicBucket.length - 40} more`);
    say('');
  }

  if (report.moved.length) {
    say(`  MOVED ${report.moved.length} file(s) into ${PRIVATE_BUCKET}.`);
    const stuck = report.moved.filter((r) => r.public_copy_remains);
    if (stuck.length) {
      say(`  ★ ${stuck.length} public copy/copies could NOT be deleted and are STILL WORLD-READABLE:`);
      for (const r of stuck) say(`      ${r.storage_path}  (${r.message})`);
      say('    Remove them in Dashboard → Storage → course-media.');
    }
    say('');
  }
  if (report.failed.length) {
    say(`  FAILED ${report.failed.length} file(s) — the public copy was left in place:`);
    for (const r of report.failed) say(`    [${r.stage}] ${r.storage_path} ${r.message || ''}`);
    say('');
  }

  return finish(report, movable);
}

function finish(report, movable) {
  if (!APPLY && movable.length) {
    say(`  ${movable.length} file(s) can be moved. Re-run with:  npm run media:migrate`);
    say('');
  }
  // Non-zero only for things a human must act on, so this is CI-usable.
  const blocking = report.externalLinks.filter((r) => r.published).length
    + report.failed.length
    + report.inPublicBucket.filter((r) => !r.in_public).length;
  process.exit(blocking ? 1 : 0);
}

main().catch((e) => { console.error('migrate-lesson-videos failed:', e?.message || e); process.exit(1); });
