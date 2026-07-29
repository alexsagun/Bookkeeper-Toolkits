// ─────────────────────────────────────────────────────────────────────────────
// npm run db:audit — is the LIVE database actually up to date?
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY. Every statement is a SELECT. This script never writes, and it is
// the intended answer to "have all my migrations been applied?".
//
// WHY IT EXISTS
//   Three different things get counted and none of them match:
//     · Supabase Dashboard → SQL Editor  — saved editor TABS (paste history,
//       ad-hoc queries, retries). Says nothing about what ran. Migrations applied
//       through the Management API leave no tab at all.
//     · db/*.sql                          — 1 bootstrap + N dated migrations.
//       The bootstrap is fresh-install-only and is never applied to an existing
//       database, so it is never logged.
//     · public.schema_migrations          — the apply log. Authoritative.
//   See docs/db/sql-editor-snippets.md for the full explanation.
//
//   The log alone is still not quite enough: a row only CLAIMS a file ran. So
//   this also checks that the objects each migration promises actually exist.
//   That is the failure mode that bit this project — #20 and #21 sat unapplied
//   in production for two weeks while the deployed Extend Access UI depended on
//   them, which is why the apply-log (#31) exists in the first place.
//
// USAGE
//   npm run db:audit              # audit the live project
//   npm run db:audit -- --json    # machine-readable, for CI
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The production project. Hardcoded so this can never be pointed somewhere else
// by a stray env var — it is a read-only audit of one specific database.
const LIVE_REF = 'ifxcobxsjdjzlozagmls';

function managementToken() {
  let raw = '';
  try { raw = readFileSync(join(REPO, '.env'), 'utf8'); } catch { /* handled below */ }
  const m = /^SUPABASE_ACCESS_TOKEN=(.*)$/m.exec(raw);
  const token = m && m[1].trim().replace(/^["']|["']$/g, '');
  if (!token) {
    console.error(
      'SUPABASE_ACCESS_TOKEN not found in .env.\n' +
      'Create one at Supabase Dashboard → Account → Access Tokens, then add:\n' +
      '  SUPABASE_ACCESS_TOKEN=sbp_…',
    );
    process.exit(2);
  }
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one read-only query, retrying the transient network failures that are common here. */
async function q(sql, token) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${LIVE_REF}/database/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: sql }),
        },
      );
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      if (res.status < 500 && res.status !== 429) {
        let detail = text;
        try { detail = JSON.parse(text).message || text; } catch { /* raw */ }
        throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 200)}`);
      }
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await sleep(600 * 2 ** attempt);
  }
  throw new Error('unreachable');
}

/**
 * Object-level checks. A log row says a file ran; these say the schema really
 * has what the file promised. Keep one entry per meaningful migration — when a
 * new dated file lands, add the object it is known for.
 */
const OBJECT_CHECKS = [
  ['#1/#2  profiles + is_admin()', `select to_regclass('public.profiles') is not null and to_regprocedure('public.is_admin()') is not null as ok`],
  ['#2     courses / modules / lessons', `select to_regclass('public.courses') is not null and to_regclass('public.course_lessons') is not null as ok`],
  ['#5     sidebar_settings', `select to_regclass('public.sidebar_settings') is not null as ok`],
  ['#6     feature_guides', `select to_regclass('public.feature_guides') is not null as ok`],
  ['#7     feature_video_completions', `select to_regclass('public.feature_video_completions') is not null as ok`],
  ['#9     is_approved()', `select to_regprocedure('public.is_approved()') is not null as ok`],
  ['#10    profiles in realtime publication', `select exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='profiles') as ok`],
  ['#12    enrollment tables + is_enrolled()', `select to_regclass('public.enrollment_requests') is not null and to_regclass('public.subscriptions') is not null and to_regprocedure('public.is_enrolled()') is not null as ok`],
  ['#13    approve_subscription()', `select to_regprocedure('public.approve_subscription(uuid,text,uuid)') is not null as ok`],
  ['#17    current_plan_key() / plan_is_qbo_only()', `select to_regprocedure('public.current_plan_key()') is not null and to_regprocedure('public.plan_is_qbo_only()') is not null as ok`],
  ['#19    courses.access_tier + plan_is_sampler()', `select to_regprocedure('public.plan_is_sampler()') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='courses' and column_name='access_tier') as ok`],
  ['#20/#21 approve_extension()', `select to_regprocedure('public.approve_extension(uuid,uuid,integer)') is not null as ok`],
  ['#23/#24 community_posts + community_tags', `select to_regclass('public.community_posts') is not null and to_regclass('public.community_tags') is not null as ok`],
  ['#26    student_import_jobs', `select to_regclass('public.student_import_jobs') is not null as ok`],
  ['#27    course_ai_chunks + user_is_enrolled()', `select to_regclass('public.course_ai_chunks') is not null and to_regprocedure('public.user_is_enrolled(uuid)') is not null as ok`],
  ['#31    schema_migrations', `select to_regclass('public.schema_migrations') is not null as ok`],
  ['#32    batches + community_spaces', `select to_regclass('public.batches') is not null and to_regclass('public.community_spaces') is not null as ok`],
  ['#32/#34 admin_finalize_enrollment()', `select to_regprocedure('public.admin_finalize_enrollment(uuid,uuid)') is not null as ok`],
  ['#34    finalize keeps the rejected_* housekeeping', `select coalesce(bool_or(prosrc like '%rejected_at = null%'), false) as ok from pg_proc where proname='admin_finalize_enrollment'`],
  ['#35    batch_entitlements ledger', `select to_regclass('public.batch_entitlements') is not null as ok`],
  ['#35    ledger not writable by authenticated', `select not has_table_privilege('authenticated','public.batch_entitlements','insert') as ok`],
  ['#36    user_community_capabilities()', `select to_regprocedure('public.user_community_capabilities(uuid)') is not null as ok`],
  ['#36    General is announcement-only (D2)', `select coalesce(bool_and(not member_posting and not member_comments), false) as ok from public.community_spaces where kind='general'`],
  ['#37    attachment insert binds uploader + link + space', `select coalesce(bool_and(with_check ilike '%uploader_id =%' and with_check ilike '%storage_path IS NULL%' and with_check ilike '%(p.space_id)::text%'), false) as ok from pg_policies where policyname='community_attachments_own_insert'`],
  ['#37    only a revoke clears the batch_id cache', `select coalesce(bool_and(prosrc like '%revoked%then%'), false) as ok from pg_proc where proname='revoke_batch_run'`],
  ['#37    FIFO binder is forward-only within a run', `select coalesce(bool_and(prosrc like '%max(b2.code)%'), false) as ok from pg_proc where proname='allocate_queued_entitlements'`],
];

async function main() {
  const json = process.argv.includes('--json');
  const token = managementToken();

  const files = readdirSync(join(REPO, 'db'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.sql$/.test(f))
    .sort();

  const logged = (await q('select filename from public.schema_migrations', token))
    .map((r) => r.filename);

  const notApplied = files.filter((f) => !logged.includes(f));
  const orphanRows = logged.filter((f) => !files.includes(f));

  const objects = [];
  for (const [label, sql] of OBJECT_CHECKS) {
    let ok = false;
    let err = null;
    try { ok = (await q(sql, token))[0]?.ok === true; } catch (e) { err = e.message; }
    objects.push({ label, ok, err });
  }

  const failedObjects = objects.filter((o) => !o.ok);
  const clean = notApplied.length === 0 && orphanRows.length === 0 && failedObjects.length === 0;

  if (json) {
    console.log(JSON.stringify({
      project: LIVE_REF, files: files.length, logged: logged.length,
      notApplied, orphanRows,
      objectChecks: objects.map(({ label, ok }) => ({ label, ok })),
      clean,
    }, null, 2));
    process.exit(clean ? 0 : 1);
  }

  console.log(`\nDatabase audit — live project ${LIVE_REF}\n`);
  console.log(`  dated migrations in db/    : ${files.length}`);
  console.log(`  rows in schema_migrations  : ${logged.length}`);
  console.log(`  files NOT applied          : ${notApplied.length ? notApplied.join(', ') : 'none'}`);
  console.log(`  log rows with no file      : ${orphanRows.length ? orphanRows.join(', ') : 'none'}`);
  console.log(`\n  (db/000_full_database_bootstrap.sql is fresh-install only — never logged, by design)`);

  console.log('\nObject-level checks — does the schema really contain it?\n');
  for (const o of objects) {
    console.log(`  ${o.ok ? 'OK  ' : 'FAIL'}  ${o.label}${o.err ? `  (${o.err})` : ''}`);
  }

  console.log(
    clean
      ? '\n✔ Database is up to date: every migration is applied and every checked object exists.\n'
      : '\n✘ Database is NOT clean — see the FAIL lines above.\n',
  );
  console.log('Note: the Supabase Dashboard SQL Editor tab count is unrelated to any of this.');
  console.log('      See docs/db/sql-editor-snippets.md.\n');
  process.exit(clean ? 0 : 1);
}

main().catch((e) => {
  console.error(`\naudit failed: ${e.message}\n`);
  process.exit(2);
});
