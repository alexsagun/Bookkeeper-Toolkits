#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// dev-purge-removed-plans.mjs — ONE-OFF development cleanup for #39.
//
// Deletes the Supabase Auth accounts that existed ONLY to test the retired
// `core_self_paced` / `gold_live` plans, plus the storage objects those accounts
// owned. Nothing else. This is the half of #39 that SQL cannot do: deleting an
// auth user needs the Admin API, and the migration deliberately contains no
// UUIDs so it stays replayable and foldable into the bootstrap.
//
// ★ THIS IS DESTRUCTIVE AND IRREVERSIBLE. Read the refusal gate below before
//   running it. It is DRY RUN by default and needs an exact confirmation phrase
//   to do anything at all.
//
// USAGE
//   node scripts/dev-purge-removed-plans.mjs --project-ref=<ref> --user=<uuid> [--user=<uuid> ...]
//       → dry run: prints the plan, touches nothing, exits 0.
//
//   node scripts/dev-purge-removed-plans.mjs --project-ref=<ref> --user=<uuid> \
//        --apply --confirm="PURGE REMOVED-PLAN TEST USERS FROM <ref>"
//
//   --purge-orphan-receipts   also delete receipt folders whose owner has no
//                             profiles row and no live request (residue of
//                             accounts deleted before this script existed).
//   --keep-storage            skip the storage phase. The auth delete may then
//                             fail on storage.objects.owner in some Supabase
//                             versions — see PHASE ORDER below.
//   --allow-before-migration  proceed even if #39 is not yet applied.
//   --json                    machine-readable summary on stdout.
//
// PHASE ORDER IS LOAD-BEARING: storage first, auth second. Some Supabase storage
// schemas carry `objects.owner uuid references auth.users(id)` with no cascade,
// so deleting the user first fails with a foreign_key_violation. That is a
// database-level constraint — it applies to the Admin API path too.
//
// OUTPUT DISCIPLINE: counts and 8-char id prefixes only. No emails, no names, no
// receipt paths, no object names, no signed URLs, no keys. This script reads a
// service-role key; it never prints it, and it refuses a VITE_-prefixed source.
//
// Idempotent and resumable: every phase is "check, then act", so re-running
// after a partial failure completes the remainder and exits 0.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── The allowlist ───────────────────────────────────────────────────────────
// This ref is hardcoded as the LIVE / production target in scripts/audit-db.mjs
// (LIVE_REF) and scripts/_shadow.mjs (LIVE_PROJECT_REF), which refuse to touch
// it. That is correct for those tools. This script is the deliberate exception:
// the owner has verified this deployment is a DEVELOPMENT project with no real
// customers and authorized permanent deletion of the Core/Gold test data.
//
// An allowlist entry is the ONLY way a ref becomes purgeable. Never read the
// target from .env, and never default it — a stray environment file must not be
// able to redirect a delete.
const PURGEABLE_DEV_REFS = ['ifxcobxsjdjzlozagmls'];

const MIGRATION = '2026-08-17-three-plan-catalog.sql';
const RETIRED_PLANS = ['core_self_paced', 'gold_live'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const all = (name) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const APPLY = flag('apply');
const JSON_OUT = flag('json');
const KEEP_STORAGE = flag('keep-storage');
const PURGE_ORPHANS = flag('purge-orphan-receipts');
const ALLOW_EARLY = flag('allow-before-migration');

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const short = (id) => String(id || '').slice(0, 8);
const die = (msg) => { console.error(`\n[dev-purge] REFUSING TO RUN: ${msg}\n`); process.exit(1); };

// ─── Refusal gate — every check runs BEFORE any write ────────────────────────

const ref = opt('project-ref');
if (!ref) {
  die('--project-ref=<ref> is required and must be typed on the command line. '
    + 'It is never read from .env, so a stray environment file cannot redirect this delete.');
}
if (!PURGEABLE_DEV_REFS.includes(ref)) {
  die(`project ref "${ref}" is not in PURGEABLE_DEV_REFS. Add it to this file, in a reviewed `
    + 'commit, only after verifying that project is a development environment with no real users.');
}

function readEnvFile(name) {
  try {
    const raw = readFileSync(join(REPO_ROOT, name), 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
}

const fileEnv = readEnvFile('.env');
const env = { ...fileEnv, ...process.env };

// The key and the target must provably agree: a service key for project A with
// --project-ref=B would otherwise delete from A while every message said B.
const publicUrl = env.VITE_SUPABASE_URL || '';
if (publicUrl && !publicUrl.includes(ref)) {
  die(`VITE_SUPABASE_URL does not name ${ref}. The credentials in .env belong to a different `
    + 'project than the one requested — refusing rather than deleting from the wrong database.');
}

const SERVICE_KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SERVICE_KEY) {
  die('SUPABASE_SECRET_KEY is not set. This script needs the server-only service-role key '
    + '(legacy SUPABASE_SERVICE_ROLE_KEY is accepted). It is never printed.');
}
for (const [k, v] of Object.entries(env)) {
  if (k.startsWith('VITE_') && v && v === SERVICE_KEY) {
    die(`the service-role key is also exposed as ${k}. A VITE_-prefixed variable is inlined into `
      + 'the browser bundle. Rotate that key before running anything.');
  }
}

const targets = all('user');
if (targets.length === 0) {
  die('at least one --user=<uuid> is required. This script never derives its own target set — '
    + 'a heuristic sweep is exactly how an unintended account gets deleted.');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const t of targets) if (!UUID_RE.test(t)) die(`"${short(t)}…" is not a UUID.`);

const EXPECTED_CONFIRM = `PURGE REMOVED-PLAN TEST USERS FROM ${ref}`;
if (APPLY && opt('confirm') !== EXPECTED_CONFIRM) {
  die(`--apply needs the exact confirmation phrase.\n  Expected: --confirm="${EXPECTED_CONFIRM}"`);
}

const admin = createClient(`https://${ref}.supabase.co`, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const summary = {
  project_ref: ref, dry_run: !APPLY, targets: targets.length,
  receipts_deleted: 0, receipts_retained: 0, avatars_deleted: 0,
  users_deleted: 0, users_already_gone: 0,
  orphan_folders_seen: 0, orphan_objects_deleted: 0,
  verified: false,
};

async function main() {
  log(`\n[dev-purge] project ${ref} · ${targets.length} target(s) · ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // ── Phase 0: inventory + per-target safety re-verification ────────────────
  const { count: planCount, error: planErr } = await admin
    .from('enrollment_plans').select('key', { count: 'exact', head: true });
  if (planErr) die(`cannot read enrollment_plans: ${planErr.message}`);

  const { data: mig } = await admin
    .from('schema_migrations').select('filename').eq('filename', MIGRATION).maybeSingle();
  if (!mig && !ALLOW_EARLY) {
    die(`${MIGRATION} is not in schema_migrations. Apply the migration first (it clears the `
      + 'subscription/request rows this script expects to be gone), or pass --allow-before-migration.');
  }

  log(`[dev-purge] catalog: ${planCount} plan(s) · migration ${mig ? 'applied' : 'NOT applied'}`);

  // Safety re-verification is independent of the migration: refuse if a target
  // looks like anything other than a retired-plan test account. Any failure
  // aborts the WHOLE run before phase 1 — a partial purge of a mixed target set
  // is worse than none.
  const problems = [];
  for (const uid of targets) {
    const [profRes, subs, reqs, seats, posts, comments] = await Promise.all([
      admin.from('profiles').select('id,is_admin,plan').eq('id', uid).maybeSingle(),
      admin.from('subscriptions').select('id,plan_key').eq('user_id', uid),
      admin.from('enrollment_requests').select('id,plan_key').eq('user_id', uid),
      admin.from('batch_entitlements').select('id').eq('user_id', uid),
      admin.from('community_posts').select('id').eq('author_id', uid),
      admin.from('community_comments').select('id').eq('author_id', uid),
    ]);

    // ★ A FAILED safety query is not a passed one. Without this, one transient network
    // blip makes `posts.data` undefined, the "did they author anything?" check reads as
    // clean, and --apply hard-deletes the account — cascading away the very content the
    // guard exists to protect. Abort the whole run instead.
    for (const [label, res] of [['profiles', profRes], ['subscriptions', subs],
      ['enrollment_requests', reqs], ['batch_entitlements', seats],
      ['community_posts', posts], ['community_comments', comments]]) {
      if (res?.error) {
        die(`the ${label} safety check for ${short(uid)}… did not complete (${res.error.message}). `
          + 'Refusing to treat an unanswered question as a clean result.');
      }
    }
    const prof = profRes.data;

    if (prof?.is_admin) problems.push(`${short(uid)} is an ADMIN`);
    for (const s of subs.data || []) {
      if (!RETIRED_PLANS.includes(s.plan_key)) {
        problems.push(`${short(uid)} holds a RETAINED-plan subscription (${s.plan_key})`);
      } else {
        problems.push(`${short(uid)} still has a retired-plan subscription — run the migration first`);
      }
    }
    for (const r of reqs.data || []) {
      if (!RETIRED_PLANS.includes(r.plan_key)) {
        problems.push(`${short(uid)} has a RETAINED-plan enrollment request (${r.plan_key})`);
      } else {
        problems.push(`${short(uid)} still has a retired-plan request — run the migration first`);
      }
    }
    if ((seats.data || []).length) problems.push(`${short(uid)} holds ${seats.data.length} cohort seat(s)`);
    if ((posts.data || []).length) problems.push(`${short(uid)} authored ${posts.data.length} community post(s)`);
    if ((comments.data || []).length) problems.push(`${short(uid)} authored ${comments.data.length} comment(s)`);
    if (!prof) log(`[dev-purge] target ${short(uid)}…  no profiles row (already partly purged)`);
  }
  if (problems.length) {
    console.error('\n[dev-purge] REFUSING TO RUN — target set is not clean:');
    for (const p of problems) console.error(`  · ${p}`);
    console.error('');
    process.exit(1);
  }

  // The keep-set: every receipt path a SURVIVING request still points at. This
  // is what makes "belongs exclusively to a deleted request" a fact about live
  // data rather than an assumption.
  const { data: liveReqs, error: reqErr } = await admin
    .from('enrollment_requests').select('receipt_path').not('receipt_path', 'is', null);
  if (reqErr) die(`cannot read the receipt keep-set: ${reqErr.message}`);
  const keep = new Set((liveReqs || []).map((r) => r.receipt_path));
  log(`[dev-purge] receipt keep-set: ${keep.size} path(s) still referenced by a live request`);

  // ── Phase 1: storage (BEFORE auth — see PHASE ORDER) ──────────────────────
  if (!KEEP_STORAGE) {
    for (const uid of targets) {
      const rec = await purgeFolder('enrollment-receipts', uid, keep);
      const av = await purgeFolder('avatars', uid, null);
      summary.receipts_deleted += rec.deleted;
      summary.receipts_retained += rec.retained;
      summary.avatars_deleted += av.deleted;
      log(`[dev-purge] target ${short(uid)}…  receipts: ${rec.deleted} deleted, ${rec.retained} retained`
        + ` · avatars: ${av.deleted} deleted`);
    }
  } else {
    log('[dev-purge] --keep-storage: skipping the storage phase. If storage.objects.owner has an '
      + 'FK to auth.users on this project, the auth delete below will fail.');
  }

  // ── Phase 1b: orphan receipt folders ──────────────────────────────────────
  const orphans = await findOrphanReceiptFolders(keep);
  summary.orphan_folders_seen = orphans.length;
  if (orphans.length && !PURGE_ORPHANS) {
    log(`[dev-purge] orphan receipt folders (not in scope, pass --purge-orphan-receipts): ${orphans.length}`);
  } else if (orphans.length) {
    for (const o of orphans) {
      const r = await purgeFolder('enrollment-receipts', o, keep);
      summary.orphan_objects_deleted += r.deleted;
    }
    log(`[dev-purge] orphan receipt folders purged: ${orphans.length} folder(s), `
      + `${summary.orphan_objects_deleted} object(s)`);
  }

  // ── Phase 2: auth ─────────────────────────────────────────────────────────
  for (const uid of targets) {
    const { data: got, error } = await admin.auth.admin.getUserById(uid);
    if (error || !got?.user) {
      summary.users_already_gone += 1;
      log(`[dev-purge] target ${short(uid)}…  auth user: already deleted`);
      continue;
    }
    if (!APPLY) {
      log(`[dev-purge] target ${short(uid)}…  auth user: WOULD DELETE (profiles cascades)`);
      continue;
    }
    const { error: delErr } = await admin.auth.admin.deleteUser(uid, false);
    if (delErr) die(`deleting auth user ${short(uid)}… failed: ${delErr.message}`);
    summary.users_deleted += 1;
    log(`[dev-purge] target ${short(uid)}…  auth user: deleted`);
  }

  // ── Phase 3: post-verify (always, read-only) ──────────────────────────────
  const [plans, spaces, seatRows, admins] = await Promise.all([
    admin.from('enrollment_plans').select('key', { count: 'exact', head: true }),
    admin.from('community_spaces').select('kind'),
    admin.from('batch_entitlements').select('id', { count: 'exact', head: true }),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('is_admin', true),
  ]);
  const goldSpaces = (spaces.data || []).filter((s) => s.kind === 'gold').length;
  const vipSpaces = (spaces.data || []).filter((s) => s.kind === 'vip').length;

  log(`[dev-purge] verify: plans ${plans.count} · gold spaces ${goldSpaces} · vip spaces ${vipSpaces}`
    + ` · cohort seats ${seatRows.count} · admins ${admins.count}`);

  const failures = [];
  if (mig && plans.count !== 3) failures.push(`expected 3 plans, found ${plans.count}`);
  if (mig && goldSpaces !== 0) failures.push(`${goldSpaces} gold space(s) survived`);
  if (admins.count < 1) failures.push('no admin accounts remain');
  if (failures.length) {
    console.error('\n[dev-purge] POST-VERIFY FAILED:');
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  summary.verified = true;

  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
  else if (!APPLY) {
    log(`\n[dev-purge] DRY RUN complete — nothing was changed. Re-run with:\n`
      + `  --apply --confirm="${EXPECTED_CONFIRM}"\n`);
  } else {
    log(`\n[dev-purge] done. ${summary.users_deleted} user(s) deleted, `
      + `${summary.users_already_gone} already gone.\n`);
  }
}

/** Delete every object under <bucket>/<folder>/ that no live request still references. */
async function purgeFolder(bucket, folder, keep) {
  const { data: files, error } = await admin.storage.from(bucket).list(folder, { limit: 1000 });
  if (error) {
    // A missing folder is not an error — this script is resumable.
    if (/not found/i.test(error.message)) return { deleted: 0, retained: 0 };
    die(`listing ${bucket}/${short(folder)}… failed: ${error.message}`);
  }
  const paths = [];
  let retained = 0;
  for (const f of files || []) {
    if (!f?.name) continue;
    const full = `${folder}/${f.name}`;
    if (keep && keep.has(full)) { retained += 1; continue; }
    paths.push(full);
  }
  if (paths.length && APPLY) {
    const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
    if (rmErr) die(`removing ${paths.length} object(s) from ${bucket} failed: ${rmErr.message}`);
  }
  return { deleted: paths.length, retained };
}

/**
 * Receipt folders whose owning uid has no profiles row — residue of accounts
 * deleted before this script existed. Folders belonging to a live account are
 * never returned, and neither is anything a live request still references.
 */
async function findOrphanReceiptFolders(keep) {
  const { data: folders, error } = await admin.storage.from('enrollment-receipts').list('', { limit: 1000 });
  if (error) die(`listing enrollment-receipts failed: ${error.message}`);
  const names = (folders || []).map((f) => f.name).filter((n) => UUID_RE.test(n || ''));
  if (!names.length) return [];
  const { data: profs } = await admin.from('profiles').select('id').in('id', names);
  const live = new Set((profs || []).map((p) => p.id));
  const keepOwners = new Set([...keep].map((p) => String(p).split('/')[0]));
  return names.filter((n) => !live.has(n) && !keepOwners.has(n) && !targets.includes(n));
}

main().catch((e) => {
  console.error(`\n[dev-purge] FAILED: ${e?.message || e}\n`);
  process.exit(1);
});
