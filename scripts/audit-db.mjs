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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
export const OBJECT_CHECKS = [
  ['#1/#2  profiles + is_admin()', `select to_regclass('public.profiles') is not null and to_regprocedure('public.is_admin()') is not null as ok`],
  ['#2     courses / modules / lessons', `select to_regclass('public.courses') is not null and to_regclass('public.course_lessons') is not null as ok`],
  ['#5     sidebar_settings', `select to_regclass('public.sidebar_settings') is not null as ok`],
  ['#6     feature_guides', `select to_regclass('public.feature_guides') is not null as ok`],
  ['#7     feature_video_completions', `select to_regclass('public.feature_video_completions') is not null as ok`],
  ['#9     is_approved()', `select to_regprocedure('public.is_approved()') is not null as ok`],
  ['#10    profiles in realtime publication', `select exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='profiles') as ok`],
  ['#12    enrollment tables + is_enrolled()', `select to_regclass('public.enrollment_requests') is not null and to_regclass('public.subscriptions') is not null and to_regprocedure('public.is_enrolled()') is not null as ok`],
  ['#13    approve_subscription()', `select to_regprocedure('public.approve_subscription(uuid,text,uuid)') is not null as ok`],
  // #39 DROPPED plan_is_qbo_only() with core_self_paced, so #17's own object is
  // gone by design. current_plan_key() survives — it still feeds plan_is_sampler().
  ['#17    current_plan_key()', `select to_regprocedure('public.current_plan_key()') is not null as ok`],
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
  // ★ #40 RETIRED the space-wide D2 rule. General now permits conversation and
  // the restriction lives on the channel, so the #36 check is inverted on
  // purpose: if the old CHECK constraint came back, every General channel would
  // be silently unwritable again.
  ['#40    D2 is no longer a space-wide rule', `select not exists (select 1 from pg_constraint where conname='community_spaces_general_announcement_only') as ok`],
  ['#40    #announcements is admin-post-only', `select coalesce(bool_and(not member_posting and not member_comments), false) as ok from public.community_channels where slug='announcements'`],
  ['#40    community_channels table', `select to_regclass('public.community_channels') is not null as ok`],
  ['#40    channels not writable by authenticated', `select not has_table_privilege('authenticated','public.community_channels','update') as ok`],
  ['#40    audience mappings not writable by authenticated', `select not has_table_privilege('authenticated','public.community_channel_plans','insert') as ok`],
  ['#40    my_community_sidebar()', `select to_regprocedure('public.my_community_sidebar()') is not null as ok`],
  ['#40    user_community_channel_ids() is revoked from clients', `select case when to_regprocedure('public.user_community_channel_ids(uuid)') is null then false else not has_function_privilege('authenticated','public.user_community_channel_ids(uuid)','execute') end as ok`],
  ['#40    posts carry a channel', `select coalesce(bool_and(attnotnull), false) as ok from pg_attribute where attrelid='public.community_posts'::regclass and attname='channel_id'`],
  ['#40    comments carry a channel', `select coalesce(bool_and(attnotnull), false) as ok from pg_attribute where attrelid='public.community_comments'::regclass and attname='channel_id'`],
  ['#40    community-media reads are channel-scoped', `select coalesce(bool_and(qual ilike '%my_community_channel_ids%'), false) as ok from pg_policies where schemaname='storage' and policyname='community_media_read'`],
  ['#40    community-media deletes match the row policy', `select coalesce(bool_and(qual ilike '%my_community_channel_ids%'), false) as ok from pg_policies where schemaname='storage' and policyname='community_media_delete'`],
  ['#40    no ambiguous search_community_members overload', `select to_regprocedure('public.search_community_members(text,uuid)') is null as ok`],
  ['#40    the superseded space-level denial fn is gone', `select to_regprocedure('public.community_write_denial(uuid,text)') is null as ok`],
  ['#41    a rename preserves the channel topic', `select coalesce(bool_and(prosrc like '%when p_topic is null then topic%'), false) as ok from pg_proc where proname='admin_save_community_channel'`],
  ['#41    audience checks are inside the audience guard', `select coalesce(bool_and(prosrc like '%if p_audience_mode is not null then%'), false) as ok from pg_proc where proname='admin_save_community_channel'`],
  ['#41    the permissions audit row is conditional', `select coalesce(bool_and(prosrc like '%if v_touched then%'), false) as ok from pg_proc where proname='admin_save_community_channel'`],
  ['#41    unread index carries author_id', `select coalesce(bool_and(indexdef like '%INCLUDE (author_id)%'), false) as ok from pg_indexes where indexname='community_posts_channel_unread_idx'`],
  ['#42    intake columns exist', `select count(*) = 7 as ok from information_schema.columns where table_schema='public' and table_name='enrollment_requests' and column_name in ('college_course','current_job','ph_experience','us_experience','currently_employed','prior_training','referred_by')`],
  ['#42    free-text intake lands in jsonb', `select coalesce(bool_and(data_type='jsonb' and is_nullable='NO'), false) as ok from information_schema.columns where table_schema='public' and table_name='enrollment_requests' and column_name='intake'`],
  ['#42    the signature record is complete', `select count(*) = 4 as ok from information_schema.columns where table_schema='public' and table_name='enrollment_requests' and column_name in ('agreement_version','agreement_tier','agreement_signed_at','agreement_snapshot')`],
  ['#42    experience answers are constrained', `select count(*) = 4 as ok from pg_constraint where conname in ('enrollment_requests_ph_experience_chk','enrollment_requests_us_experience_chk','enrollment_requests_currently_employed_chk','enrollment_requests_agreement_tier_chk')`],
  ['#42    intake columns stayed nullable for legacy rows', `select coalesce(bool_and(is_nullable='YES'), false) as ok from information_schema.columns where table_schema='public' and table_name='enrollment_requests' and column_name in ('college_course','ph_experience','agreement_version')`],
  ['#42    receipts bucket accepts a Word resume', `select coalesce(bool_and('application/vnd.openxmlformats-officedocument.wordprocessingml.document' = any(allowed_mime_types) and file_size_limit >= 10485760), false) as ok from storage.buckets where id='enrollment-receipts'`],
  ['#42    plan copy no longer promises Discord', `select coalesce(bool_and(features::text not ilike '%discord%'), false) as ok from public.enrollment_plans`],
  ['#40    post reads are channel-scoped', `select coalesce(bool_and(qual ilike '%my_community_channel_ids%'), false) as ok from pg_policies where schemaname='public' and policyname='community_posts_read'`],
  // #43 — each line is one of the defects the review found. They are object
  // checks, not log checks, because #36 proved a policy can be quietly reduced
  // to a bare own-row test while every migration still claims to have run.
  ['#43    reaction deletes are gated again', `select coalesce(bool_and(qual ilike '%is_enrolled%' and qual ilike '%my_community_channel_ids%'), false) as ok from pg_policies where schemaname='public' and policyname='community_reactions_own_delete'`],
  ['#43    an uploader can clear their own orphan', `select coalesce(bool_and(qual ilike '%not (EXISTS%' or qual ilike '%NOT (EXISTS%'), false) as ok from pg_policies where schemaname='storage' and policyname='community_media_delete'`],
  ['#43    a failed enrollment submit can clean up', `select coalesce(bool_and(qual ilike '%enrollment_file_is_referenced%'), false) as ok from pg_policies where schemaname='storage' and policyname='enrollment_receipts_delete'`],
  ['#43    a category rename cannot un-archive', `select coalesce(bool_and(pg_get_expr(p.proargdefaults, 0) not ilike '%active%'), true) as ok from pg_proc p where p.proname='admin_save_channel_category'`],
  ['#43    kind counts as a permissions change', `select coalesce(bool_and(prosrc like '%p_kind           is not null%'), false) as ok from pg_proc where proname='admin_save_community_channel'`],
  // The one with real production blast radius: a partial predicate here is never
  // implied by the feed query, so the index silently stops being used at all.
  ['#43    the feed index is usable (not partial)', `select coalesce(bool_and(indexdef not ilike '%WHERE%'), false) as ok from pg_indexes where indexname='community_posts_channel_feed_idx'`],
  ['#43    in-channel search can use the GIN index', `select to_regprocedure('public.search_community_posts(text,uuid,text,int,int,text,boolean)') is not null as ok`],
  ['#43    category counts are sargable', `select coalesce(bool_and(prolang=(select oid from pg_language where lanname='plpgsql')), false) as ok from pg_proc where proname='community_category_counts'`],
  ['#43    mention search has its trigram index', `select to_regclass('public.profiles_full_name_trgm_idx') is not null as ok`],
  ['#43    channel read markers index their post fk', `select to_regclass('public.community_channel_reads_post_idx') is not null as ok`],
  ['#37    attachment insert binds uploader + link + space', `select coalesce(bool_and(with_check ilike '%uploader_id =%' and with_check ilike '%storage_path IS NULL%' and with_check ilike '%(p.space_id)::text%'), false) as ok from pg_policies where policyname='community_attachments_own_insert'`],
  ['#37    only a revoke clears the batch_id cache', `select coalesce(bool_and(prosrc like '%revoked%then%'), false) as ok from pg_proc where proname='revoke_batch_run'`],
  ['#37    FIFO binder is forward-only within a run', `select coalesce(bool_and(prosrc like '%max(b2.code)%'), false) as ok from pg_proc where proname='allocate_queued_entitlements'`],
  // #37b is a RECONSTRUCTION of a file that ran in prod and was never committed —
  // found by this script's own "log rows with no file" check. The object check is
  // what stops the same gap reopening silently if the file is ever lost again.
  ['#37b   course_lessons.zoom_replay_url', `select exists(select 1 from information_schema.columns where table_schema='public' and table_name='course_lessons' and column_name='zoom_replay_url') as ok`],
  // #38's real boundary is a COLUMN privilege, not a policy — and a later blanket
  // `grant all on all tables in schema public to authenticated` would silently undo
  // it while every policy still looked correct. That is exactly what this checks.
  ['#38    batch code not writable over REST', `select not has_column_privilege('authenticated','public.batches','code','UPDATE') as ok`],
  ['#38    batches_guard is armed', `select coalesce(bool_or(tgname='batches_guard'), false) as ok from pg_trigger where tgrelid='public.batches'::regclass and not tgisinternal`],
  // CASE, not AND: Postgres does not promise left-to-right short-circuiting, and
  // has_function_privilege() ERRORS on a function that does not exist — which would
  // abort the whole audit instead of reporting one failed check.
  ['#38    the month-end sweep exists and is client-unreachable', `select case when to_regprocedure('public.close_due_batches()') is null then false else not has_function_privilege('authenticated','public.close_due_batches()','execute') end as ok`],
  ['#38    every batch has a period', `select coalesce(bool_and(starts_on is not null and ends_on is not null and coalesce(timezone,'') <> ''), true) as ok from public.batches`],
  // The CASE guard that works for has_function_privilege() does NOT work here: a
  // string argument is evaluated at runtime, but `from cron.job` is resolved during
  // PARSE ANALYSIS, so the whole statement fails with "schema cron does not exist"
  // before any branch is chosen — and #38 explicitly supports the install where
  // pg_cron could not be created. query_to_xml() takes the query as TEXT, so the
  // reference is only ever parsed when the CASE has already decided cron exists.
  ['#38    the sweep is scheduled', `select coalesce((select (xpath('/row/ok/text()', x))[1]::text::boolean from query_to_xml(case when to_regclass('cron.job') is null then 'select false as ok' else 'select exists(select 1 from cron.job where jobname = ''close-due-batches'') as ok' end, false, true, '') as t(x)), false) as ok`],
  // #39 is a REMOVAL, so its checks assert absence. A migration that only deletes
  // has no new object to point at — the log row alone would not notice a re-created
  // plan or a resurrected gold space.
  ['#39    exactly three plans', `select count(*) = 3 as ok from public.enrollment_plans`],
  ['#39    the retired plan keys are gone', `select not exists(select 1 from public.enrollment_plans where key in ('core_self_paced','gold_live')) as ok`],
  ['#39    silver 2999 / vip 16999', `select coalesce(bool_and(case key when 'silver_self_paced' then price_php = 2999 when 'vip' then price_php = 16999 when 'sampler' then price_php = 1499 else true end), false) as ok from public.enrollment_plans`],
  ['#39    the gold segment is gone', `select not exists(select 1 from public.community_spaces where kind='gold')
      and not exists(select 1 from public.enrollment_plans where community_segment='gold')
      and not exists(select 1 from public.batch_entitlements where segment <> 'vip')
      and not exists(select 1 from information_schema.columns
                      where table_schema='public' and table_name='batches' and column_name='gold_capacity') as ok`],
  ['#39    plan_is_qbo_only is dropped', `select to_regprocedure('public.plan_is_qbo_only()') is null as ok`],
  // Both overloads resolving would let a client silently bind a different function
  // depending on whether it sent p_gold_capacity.
  ['#39    admin_update_batch is 8-arg only', `select to_regprocedure('public.admin_update_batch(uuid,text,text,date,date,text,int,int)') is not null
      and to_regprocedure('public.admin_update_batch(uuid,text,text,date,date,text,int,int,int)') is null as ok`],

  // #42/#43 both failed silently when their bootstrap fold went missing on
  // 2026-08-23 — a policy that returns fewer rows, an index the planner ignores and
  // a 403 swallowed by a .catch() all look exactly like nothing happening. These
  // three turn that into a red line in `npm run db:audit`.
  ['#42    plan copy matches the agreement', `select
      not exists(select 1 from public.enrollment_plans where features::text ilike '%discord%')
      and not exists(select 1 from public.enrollment_plans where key='vip' and features::text ilike '%1-on-1 Resume%')
      and exists(select 1 from public.enrollment_plans where key='sampler' and features::text ilike '%4 hours%') as ok`],
  // #41 made this partial on status='active' believing RLS pinned it. It does not,
  // so the planner could not use the index AT ALL and every feed page was a seq
  // scan + sort. If the predicate is ever back, so is the regression.
  ['#43    feed index is NOT partial', `select coalesce(bool_and(indexdef not ilike '%where%'), false) as ok
      from pg_indexes where indexname = 'community_posts_channel_feed_idx'`],
  // Without this an uploader's failed-submit cleanup 403s, stranding up to four
  // private files per failed enrollment where admin hard-delete cannot reach them.
  ['#43    enrollment_file_is_referenced exists', `select to_regprocedure('public.enrollment_file_is_referenced(text)') is not null as ok`],
  // ── #44, course video upload-only ─────────────────────────────────────────
  // db:shadow:verify CANNOT see any of this: SNAPSHOT_SQL filters pg_policies to
  // schemaname='public' (so storage policies are never snapshotted at all) and
  // even there compares only tablename/policyname/cmd, never qual. These checks
  // are therefore the ONLY automated proof that the private video bucket is
  // still gated the way #44 left it.
  ['#44    video reads are authorized by reference, not by path', `select coalesce(bool_and(qual ilike '%course_video_object_readable%'), false) as ok
      from pg_policies where schemaname='storage' and policyname='course_videos_read'`],
  ['#44    video reads finally require approval', `select coalesce(bool_and(qual ilike '%is_approved%' and qual ilike '%is_enrolled%'), false) as ok
      from pg_policies where schemaname='storage' and policyname='course_videos_read'`],
  // The whole point of #44. This helper returned TRUE on an unparseable path, on
  // an unknown course, and for every non-sampler plan, and it never checked
  // courses.published. Assert it is GONE, the way #39 asserts plan_is_qbo_only is.
  ['#44    the fail-open path parser is dropped', `select to_regprocedure('public.course_object_allowed(text)') is null as ok`],
  // CASE, not AND: has_function_privilege() ERRORS on a function that does not
  // exist, which aborts the whole audit instead of failing one line.
  ['#44    members can execute the readability helper', `select case
      when to_regprocedure('public.course_video_object_readable(text,boolean)') is null then false
      else has_function_privilege('authenticated','public.course_video_object_readable(text,boolean)','execute') end as ok`],
  ['#44    anon cannot execute the readability helper', `select case
      when to_regprocedure('public.course_video_object_readable(text,boolean)') is null then false
      else not has_function_privilege('anon','public.course_video_object_readable(text,boolean)','execute') end as ok`],
  // Unlike #43's original feed index, this partial predicate IS implied by the
  // query (storage_path = $1 implies storage_path is not null), so it is usable.
  ['#44    lesson storage_path is indexed', `select to_regclass('public.course_lessons_storage_path_idx') is not null as ok`],
  ['#44    the lesson video guard is armed', `select coalesce(bool_or(tgname='course_lessons_video_guard'), false) as ok
      from pg_trigger where tgrelid='public.course_lessons'::regclass and not tgisinternal`],
  ['#44    the publish guard is armed', `select coalesce(bool_or(tgname='courses_publish_guard'), false) as ok
      from pg_trigger where tgrelid='public.courses'::regclass and not tgisinternal`],
  // DELTA, not state. Re-scoping this guard to fire on new.published alone would
  // refuse EVERY unrelated update to a published course: reorderCourse (N updates
  // in one Promise.all), uploadCover, setCourseTier, saveCourseMeta, the AI-trainer
  // toggle. The WHEN clause is what keeps them working, so assert it is still there.
  ['#44    the publish guard fires on the transition only', `select coalesce(bool_and(
        pg_get_triggerdef(oid) ilike '%when%' and pg_get_triggerdef(oid) ilike '%old.published%'), false) as ok
      from pg_trigger where tgrelid='public.courses'::regclass and tgname='courses_publish_guard'`],
  // saveLesson re-derives video_provider from the URL on every write, so keying
  // the grandfather rule on the provider would refuse title-only edits to legacy
  // rows forever, with no way to fix it from the UI.
  ['#44    grandfathering keys off video_url, not the re-derived provider', `select coalesce(bool_and(
        prosrc like '%v_old_link%' and prosrc not like '%old.video_provider is distinct from new.video_provider%'), false) as ok
      from pg_proc where proname='course_lessons_video_guard'`],
  ['#44    the publish preflight RPC exists', `select to_regprocedure('public.course_publish_blockers(uuid)') is not null as ok`],
  // #15 wrote `on conflict (id) do update set public = false` and nothing else, so
  // these two settings were write-once from creation and NO file in this repo could
  // correct a drift. #44 re-asserts them; this is what notices if they drift again.
  ['#44    the video bucket is private and capped at 2 GiB', `select coalesce(bool_and(
        not public and file_size_limit >= 2147483648), false) as ok
      from storage.buckets where id='course-videos'`],
  ['#44    the video bucket accepts mp4 and nothing else', `select coalesce(bool_and(
        allowed_mime_types = array['video/mp4']), false) as ok
      from storage.buckets where id='course-videos'`],
  // Assert ABSENCE, the #39 idiom. A published course playing from an external
  // link is exactly the state #44 exists to eliminate, and nothing else in the
  // repo would notice it drifting back.
  ['#44    no published course plays from an external link', `select not exists (
      select 1 from public.course_lessons l join public.courses c on c.id = l.course_id
       where c.published and l.type='video'
         and coalesce(l.video_provider,'') <> 'upload'
         and nullif(btrim(coalesce(l.video_url,'')),'') is not null) as ok`],

  // ── #45, staff authorization ──────────────────────────────────────────────
  // The role model replaces one boolean with a permission matrix, and it does so
  // by REDEFINING profiles.is_admin as a trigger-maintained cache of "has an
  // active super_admin membership". Two classes of thing therefore need proving:
  // that the model exists and is locked down, and that the cache still agrees
  // with the table it caches. Drift between those two is invisible until an
  // administrator silently loses — or silently gains — every legacy is_admin()
  // surface at once.
  ['#45    staff tables exist', `select coalesce(bool_and(t is not null), false) as ok from (values
      (to_regclass('public.staff_roles')), (to_regclass('public.staff_permissions')),
      (to_regclass('public.staff_role_permissions')), (to_regclass('public.staff_memberships')),
      (to_regclass('public.staff_role_events'))) as v(t)`],
  ['#45/#56 role x permission matrix is seeded', `select count(*) = 32 as ok
      from public.staff_role_permissions`],
  ['#45/#52 all 19 permissions are seeded', `select count(*) = 19 as ok from public.staff_permissions`],
  // The caller-scoped helpers MUST be executable by authenticated: an RLS qual is
  // evaluated AS THE QUERYING ROLE, so without the grant every gated read fails
  // with "permission denied for function" instead of a clean authorization denial.
  ['#45    members can execute the caller-scoped helpers', `select case
      when to_regprocedure('public.has_staff_permission(text)') is null then false
      when to_regprocedure('public.my_staff_context()') is null then false
      when to_regprocedure('public.is_super_admin()') is null then false
      else has_function_privilege('authenticated','public.has_staff_permission(text)','execute')
       and has_function_privilege('authenticated','public.my_staff_context()','execute')
       and has_function_privilege('authenticated','public.is_super_admin()','execute') end as ok`],
  // The parameterised form answers about ANY user, so it is the one that must NOT
  // be reachable from a client — the same split #27 uses for its trainer mirrors.
  ['#45    the per-user helper is NOT client-executable', `select case
      when to_regprocedure('public.user_has_staff_permission(uuid,text)') is null then false
      else not has_function_privilege('authenticated','public.user_has_staff_permission(uuid,text)','execute')
       and not has_function_privilege('anon','public.user_has_staff_permission(uuid,text)','execute') end as ok`],
  ['#45    staff tables are not writable over PostgREST', `select coalesce(bool_and(
        not has_table_privilege('authenticated', t, 'insert')
        and not has_table_privilege('authenticated', t, 'update')
        and not has_table_privilege('authenticated', t, 'delete')), false) as ok
      from (values ('public.staff_memberships'), ('public.staff_roles'),
                   ('public.staff_permissions'), ('public.staff_role_permissions'),
                   ('public.staff_role_events')) as v(t)`],
  // The privilege-escalation primitive #45 exists to remove: a whole-row admin
  // UPDATE on profiles let any admin set is_admin = true on any account.
  ['#45    profiles is read-only over PostgREST', `select not has_table_privilege(
      'authenticated','public.profiles','update') as ok`],
  ['#45    the blanket admin profile UPDATE policy is gone', `select not exists (
      select 1 from pg_policies where schemaname='public' and tablename='profiles'
        and policyname='profiles_admin_update') as ok`],
  ['#45    the is_admin cache trigger is armed', `select coalesce(bool_or(tgname='staff_sync_is_admin'), false) as ok
      from pg_trigger where tgrelid='public.staff_memberships'::regclass and not tgisinternal`],
  ['#45    the last-Super-Admin guard is armed', `select coalesce(bool_or(tgname='staff_memberships_guard'), false) as ok
      from pg_trigger where tgrelid='public.staff_memberships'::regclass and not tgisinternal`],
  // The invariant that trigger exists to maintain. If these ever disagree, every
  // legacy is_admin() check in the product is answering from a stale cache.
  ['#45    profiles.is_admin agrees with the membership table', `select not exists (
      select 1 from public.profiles p
       where p.is_admin <> exists (
         select 1 from public.staff_memberships m
          where m.user_id = p.id and m.status='active' and m.role_key='super_admin')) as ok`],
  ['#45    at least one active Super Admin exists', `select exists (
      select 1 from public.staff_memberships
       where role_key='super_admin' and status='active') as ok`],
  ['#45    the access-request RPCs exist and are client-callable', `select case
      when to_regprocedure('public.admin_review_access_request(uuid,text,text)') is null then false
      when to_regprocedure('public.admin_access_request_queue(text,integer)') is null then false
      else has_function_privilege('authenticated','public.admin_review_access_request(uuid,text,text)','execute')
       and has_function_privilege('authenticated','public.admin_access_request_queue(text,integer)','execute')
       and not has_function_privilege('anon','public.admin_review_access_request(uuid,text,text)','execute') end as ok`],
  // Section 15. An Operations Admin who cannot pass this is a role that exists on
  // paper and refuses at the first server call it makes.
  ['#45    the operations RPCs are gated on capability, not is_admin()', `select coalesce(bool_and(
        prosrc like '%has_staff_permission%' and prosrc not like '%if not public.is_admin() then%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace and proname in (
        'admin_finalize_enrollment','approve_subscription','approve_extension',
        'expire_overdue_subscriptions','admin_assign_batch','admin_update_batch',
        'admin_batch_overview','admin_grant_batch_run','admin_revoke_batch_run',
        'admin_reconcile_queued_entitlements','admin_close_due_batches')`],
  ['#45    enrollment + import + batch policies read the capability', `select coalesce(bool_and(
        qual ilike '%has_staff_permission%'), false) as ok
      from pg_policies where schemaname='public' and policyname in (
        'enroll_req_admin_all','subscriptions_admin_all','batches_admin_all',
        'student_import_jobs_admin_all','student_import_rows_admin_all',
        'student_external_accounts_admin_all','profiles_admin_select')`],
  // db:shadow:verify filters pg_policies to schemaname='public', so a STORAGE
  // policy is invisible to it. The migration's own comment (section 15c) says
  // this line is where enrollment_receipts_select gets pinned — so here it is.
  ['#45    an Ops Admin can open the receipt they are approving', `select coalesce(bool_and(
        qual ilike '%has_staff_permission%' and qual ilike '%enrollments.review%'), false) as ok
      from pg_policies where schemaname='storage' and policyname='enrollment_receipts_select'`],
  ['#45    the batch ledger guard accepts an Operations Admin', `select coalesce(bool_and(
        prosrc like '%user_has_staff_permission%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace and proname='batch_entitlements_guard'`],
  ['#45    the gate helpers are no longer world-executable', `select coalesce(bool_and(
        not has_function_privilege('anon', f, 'execute')), false) as ok
      from (values ('public.is_admin()'), ('public.is_approved()'), ('public.is_enrolled()')) as v(f)`],

  // ── #46, trainer course ownership ─────────────────────────────────────────
  ['#46    course_staff_assignments exists', `select to_regclass('public.course_staff_assignments') is not null as ok`],
  ['#46    assignments are not writable over PostgREST', `select case
      when to_regclass('public.course_staff_assignments') is null then false
      else not has_table_privilege('authenticated','public.course_staff_assignments','insert')
       and not has_table_privilege('authenticated','public.course_staff_assignments','update')
       and not has_table_privilege('authenticated','public.course_staff_assignments','delete') end as ok`],
  ['#46    one LIVE assignment per person per course', `select to_regclass(
      'public.course_staff_assignments_live_idx') is not null as ok`],
  ['#46    can_manage_course is callable, its per-user form is not', `select case
      when to_regprocedure('public.can_manage_course(uuid)') is null then false
      when to_regprocedure('public.user_can_manage_course(uuid,uuid)') is null then false
      else has_function_privilege('authenticated','public.can_manage_course(uuid)','execute')
       and not has_function_privilege('authenticated','public.user_can_manage_course(uuid,uuid)','execute') end as ok`],
  // ★ Actually EXERCISE the parser rather than asserting it exists. This is the
  //   function that decides who may write into a course's storage folder, and the
  //   whole design rests on it returning NULL — which denies — for anything it does
  //   not recognise. #44 removed its read-side predecessor for failing OPEN.
  ['#46    the storage path parser fails closed', `select
        public.course_object_course_id('lessons/not-a-uuid/x.mp4') is null
    and public.course_object_course_id('lessons/') is null
    and public.course_object_course_id('../etc/passwd') is null
    and public.course_object_course_id('lessons/11111111-1111-1111-1111-111111111111') is null
    and public.course_object_course_id('lessons/11111111-1111-1111-1111-111111111111/a.mp4')
          = '11111111-1111-1111-1111-111111111111'::uuid
    and public.course_object_course_id('covers/11111111-1111-1111-1111-111111111111/a.png')
          = '11111111-1111-1111-1111-111111111111'::uuid as ok`],
  ['#46    the blanket FOR ALL course policy is split into three verbs', `select
      not exists (select 1 from pg_policies where schemaname='public'
                   and tablename='courses' and policyname='courses_admin_write')
      and (select count(*) = 3 from pg_policies where schemaname='public' and tablename='courses'
            and policyname in ('courses_staff_insert','courses_staff_update','courses_staff_delete')) as ok`],
  ['#46    module and lesson writes are assignment-scoped', `select coalesce(bool_and(
        qual ilike '%can_manage_course%'), false) as ok
      from pg_policies where schemaname='public'
       and policyname in ('modules_staff_write','lessons_staff_write')`],
  ['#46    a Trainer can preview their own draft', `select coalesce(bool_and(
        qual ilike '%can_manage_course%'), false) as ok
      from pg_policies where schemaname='public'
       and policyname in ('courses_read','modules_read','lessons_read')`],
  ['#46    course storage writes are assignment-scoped', `select coalesce(bool_and(
        coalesce(qual, with_check) ilike '%can_manage_course%'), false) as ok
      from pg_policies where schemaname='storage' and policyname in (
        'course_videos_admin_write','course_videos_admin_update','course_videos_admin_delete',
        'course_media_admin_write','course_media_admin_update','course_media_admin_delete')`],
  // Reads must NOT have moved to the path parser — that is the #44 regression.
  ['#46    video READS are still reference-based, not path-based', `select coalesce(bool_and(
        qual ilike '%course_video_object_readable%'), false) as ok
      from pg_policies where schemaname='storage' and policyname='course_videos_read'`],
  ['#46    publishing is its own capability', `select coalesce(bool_and(
        prosrc like '%courses.publish%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace and proname='courses_publish_guard'`],
  ['#46    the publish guard covers BOTH directions, still delta-scoped', `select coalesce(bool_and(
        pg_get_triggerdef(oid) ilike '%is distinct from%'
        and pg_get_triggerdef(oid) ilike '%old.published%'), false) as ok
      from pg_trigger where tgrelid='public.courses'::regclass and tgname='courses_publish_guard'`],
  ['#46    a course creator is auto-assigned as owner', `select coalesce(bool_or(
        tgname='courses_assign_creator'), false) as ok
      from pg_trigger where tgrelid='public.courses'::regclass and not tgisinternal`],
  ['#46    my_staff_context reports real assignments, not a placeholder', `select coalesce(bool_and(
        prosrc like '%course_staff_assignments%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace and proname='my_staff_context'`],
  ['#46    AI trainer indexing is a course capability', `select coalesce(bool_and(
        qual ilike '%course_trainer.manage%'), false) as ok
      from pg_policies where schemaname='public'
       and policyname in ('course_ai_sources_admin_all','course_ai_index_jobs_admin_all')`],

  // ── #47, the discretionary expiry extension ───────────────────────────────
  ['#47    the access ledger exists and is append-only', `select case
      when to_regclass('public.student_access_events') is null then false
      else not has_table_privilege('authenticated','public.student_access_events','insert')
       and not has_table_privilege('authenticated','public.student_access_events','update')
       and not has_table_privilege('authenticated','public.student_access_events','delete') end as ok`],
  // Without this index a double-clicked button grants the days twice, and the
  // second grant is indistinguishable from a deliberate one.
  ['#47    the idempotency guard is a real unique index', `select coalesce(bool_and(
        indexdef ilike '%unique%'), false) as ok
      from pg_indexes where indexname='student_access_events_idem_idx'`],
  ['#47    the extension RPC exists and anon cannot call it', `select case
      when to_regprocedure('public.admin_grant_special_extension(uuid,text,integer,timestamptz,text,text)') is null then false
      else has_function_privilege('authenticated','public.admin_grant_special_extension(uuid,text,integer,timestamptz,text,text)','execute')
       and not has_function_privilege('anon','public.admin_grant_special_extension(uuid,text,integer,timestamptz,text,text)','execute') end as ok`],
  ['#47    granting access is gated on students.extend_access', `select coalesce(bool_and(
        prosrc like '%students.extend_access%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace
       and proname='admin_grant_special_extension'`],
  // The invariant the whole function exists to keep. A body that lost this could
  // shorten a member's access while reporting success.
  ['#47    an extension can never move an expiry backwards', `select coalesce(bool_and(
        prosrc like '%may never shorten access%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace
       and proname='admin_grant_special_extension'`],
  ['#47    a no-expiry term is refused, not silently shortened', `select coalesce(bool_and(
        prosrc like '%EXTENSION_NOT_ALLOWED%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace
       and proname='admin_grant_special_extension'`],
  // Only super_admin may hold the key. If another role ever gains it, that is a
  // deliberate product decision and this line is where it gets noticed.
  ['#47    only Super Admin may grant a discretionary extension', `select coalesce(bool_and(
        role_key = 'super_admin'), false) as ok
      from public.staff_role_permissions where permission_key='students.extend_access'`],

  // ── #48, authorization hardening ──────────────────────────────────────────
  // The finding that mattered: subscriptions_admin_all / enroll_req_admin_all were
  // FOR ALL gated on enrollments.review, and `authenticated` keeps Supabase's
  // default table grants — so RLS was the only gate and an Operations Admin could
  // PATCH any subscription to plan_key=vip / ends_at=2099 and DELETE rows outright,
  // making #47's Super-Admin-only extension split decorative.
  ['#48    money tables are no longer FOR ALL to a reviewer', `select not exists (
      select 1 from pg_policies where schemaname='public'
       and policyname in ('subscriptions_admin_all','enroll_req_admin_all')) as ok`],
  ['#48    reviewers read subscriptions, Super Admin writes them', `select
      exists (select 1 from pg_policies where schemaname='public'
               and policyname='subscriptions_staff_read' and cmd='SELECT')
      and exists (select 1 from pg_policies where schemaname='public'
                   and policyname='subscriptions_super_write'
                   and qual ilike '%is_super_admin%') as ok`],
  ['#48    a reviewer may update a request but not create one', `select
      exists (select 1 from pg_policies where schemaname='public'
               and policyname='enroll_req_staff_update' and cmd='UPDATE')
      and exists (select 1 from pg_policies where schemaname='public'
                   and policyname='enroll_req_super_write'
                   and qual ilike '%is_super_admin%') as ok`],
  ['#48    a reviewer cannot approve their OWN request', `select coalesce(bool_or(
        tgname='enrollment_self_approval_guard'), false) as ok
      from pg_trigger where tgrelid='public.enrollment_requests'::regclass and not tgisinternal`],
  // ★ count(DISTINCT tablename), not count(*) — the original counted POLICIES, so
  //   one table carrying two matching policies while another carried none would
  //   sum to 3 and PASS while a table sat unscoped: the exact regression this line
  //   exists to catch. It also read `qual` only, and two of these are FOR ALL
  //   policies whose write path lives in with_check. (CodeRabbit, PR #3.)
  ['#48    ALL THREE AI-trainer tables are course-scoped', `select count(distinct tablename) = 3 as ok
      from pg_policies where schemaname='public'
       and tablename in ('course_ai_sources','course_ai_chunks','course_ai_index_jobs')
       and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ilike '%can_manage_course%'`],
  ['#48    no AI-trainer write path is unscoped', `select not exists (
      select 1 from pg_policies where schemaname='public'
       and tablename in ('course_ai_sources','course_ai_chunks','course_ai_index_jobs')
       and with_check is not null
       and with_check not ilike '%can_manage_course%') as ok`],
  // The escalation CodeRabbit caught: RLS has no column granularity, so the
  // reviewer UPDATE policy has to be bounded by a column GRANT instead.
  ['#48    a reviewer cannot rewrite a request plan_key', `select not exists (
      select 1 from information_schema.column_privileges
       where table_schema='public' and table_name='enrollment_requests'
         and grantee='authenticated' and privilege_type='UPDATE'
         and column_name in ('plan_key','user_id','amount_paid','request_kind','extension_days')) as ok`],
  // A Trainer could not create a course at all: createCourse() emits
  // INSERT ... RETURNING and the returned row failed courses_read.
  ['#48    a course creator can read what they just created', `select coalesce(bool_and(
        qual ilike '%created_by%'), false) as ok
      from pg_policies where schemaname='public' and policyname='courses_read'`],
  // ...but that branch must expire with employment, not outlive it via provenance.
  ['#48    the creator branch expires with the staff role', `select coalesce(bool_and(
        qual ilike '%courses.create%'), false) as ok
      from pg_policies where schemaname='public' and policyname='courses_read'`],
  // Every per-row can_manage_course() call in a READ policy must sit behind an
  // InitPlan-able capability test, or an ordinary student pays a SECURITY DEFINER
  // call once per row (#44 reasoned about exactly this ordering).
  ['#48    no read policy calls can_manage_course unguarded', `select not exists (
      select 1 from pg_policies
       where schemaname in ('public','storage') and cmd='SELECT'
         and coalesce(qual,'') ilike '%can_manage_course%'
         and coalesce(qual,'') not ilike '%has_staff_permission%') as ok`],
  ['#48    feature-guide media is writable again', `select coalesce(bool_and(
        coalesce(with_check, qual) ilike '%feature-guides%'), false) as ok
      from pg_policies where schemaname='storage'
       and policyname in ('course_media_admin_write','course_media_admin_update','course_media_admin_delete')`],
  // ── #49, staff invitation acceptance ──────────────────────────────────────
  // #45 shipped an invitation nothing could accept: staff_memberships allowed
  // status='invited', the API wrote it and the directory rendered it, but no
  // function, trigger or policy ever moved a row out of it. A real Operations
  // Admin sat there with a confirmed email and a password, being shown the
  // student pricing page.
  ['#49    accept_staff_invitation() exists and takes no arguments', `select coalesce(bool_or(
        pg_get_function_arguments(p.oid) = ''), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='accept_staff_invitation'`],
  ['#49    it is reachable by a member and not by anon', `select coalesce(bool_and(
        has_function_privilege('authenticated', p.oid, 'execute')
        and not has_function_privilege('anon', p.oid, 'execute')), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='accept_staff_invitation'`],
  ['#49    it is SECURITY DEFINER with a pinned search_path', `select coalesce(bool_and(
        p.prosecdef and array_to_string(p.proconfig,',') ilike '%search_path=public, pg_temp%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='accept_staff_invitation'`],
  // The reason #49 exists at all: an unaccepted invitation was being described
  // as an authority. has_staff_permission() always refused it, but the one RPC
  // the browser AND api/_lib/staffAuth.js treat as authoritative did not.
  ['#49    my_staff_context() gates permissions on active', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%''permissions'',%case when m.status = ''active''%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='my_staff_context'`],
  ['#49    it reports the membership WITHOUT a permission list', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%''membership'',%jsonb_build_object%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='my_staff_context'`],
  ['#49    the audit ledger can record an acceptance', `select coalesce(bool_and(
        pg_get_constraintdef(oid) like '%accept%'
        and pg_get_constraintdef(oid) like '%invite_resent%'), false) as ok
      from pg_constraint
     where conrelid='public.staff_role_events'::regclass and conname='staff_role_events_action_check'`],
  ['#49    the source vocabulary admits the invitation flow', `select coalesce(bool_and(
        pg_get_constraintdef(oid) like '%staff_invite%'), false) as ok
      from pg_constraint
     where conrelid='public.staff_role_events'::regclass and conname='staff_role_events_source_check'`],
  ['#49    delivery state exists on the membership', `select count(*) = 3 as ok
      from information_schema.columns
     where table_schema='public' and table_name='staff_memberships'
       and column_name in ('invite_sent_at','invite_status','invite_error_code')`],
  // staff_memberships must stay writable ONLY through the guarded RPCs, or the
  // whole "is_admin is a cache with one writer" argument from #45 collapses.
  ['#49    staff_memberships is still not client-writable', `select coalesce(bool_and(
        not has_table_privilege('authenticated','public.staff_memberships', priv)), true) as ok
      from unnest(array['INSERT','UPDATE','DELETE']) as priv`],
  ['#49    the directory exposes the delivery state', `select coalesce(bool_or(
        pg_get_function_result(p.oid) ilike '%invite_status%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='admin_staff_directory'`],
  // The second sanctioned user-facing profiles write, after set_my_avatar().
  ['#49    set_my_display_name() cannot touch email or is_admin', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) not ilike '%set%email%=%'
        and pg_get_functiondef(p.oid) not ilike '%is_admin%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='set_my_display_name'`],
  ['#49    profiles still has no client UPDATE grant', `select
      not has_table_privilege('authenticated','public.profiles','UPDATE') as ok`],

  // ── #50, staff activation consistency ─────────────────────────────────────
  // An active staff member must not still be a pending STUDENT. Before #50 an
  // accepted Operations Admin kept approval_status='pending' forever, appeared
  // in the student Access Requests queue, inflated the amber badge — and found
  // their OWN row, with an Approve button, in the queue they had just been given.
  ['#50    no active staff member is still a pending student', `select count(*) = 0 as ok
      from public.profiles p
     where p.approval_status = 'pending'
       and exists (select 1 from public.staff_memberships m
                    where m.user_id = p.id and m.status = 'active')`],
  ['#50    staff_sync_is_admin() also clears the pending approval', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%approval_status = ''approved''%'
        and pg_get_functiondef(p.oid) ilike '%approval_status = ''pending''%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='staff_sync_is_admin'`],
  // …and it must still be scoped so a ban is never laundered: the approval half
  // only ever moves 'pending', and is_admin still means active super_admin only.
  ['#50    the trigger never writes is_admin outside the super_admin recompute', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%role_key = ''super_admin''%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='staff_sync_is_admin'`],
  ['#50    accept_staff_invitation() refuses a rejected profile', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%STAFF_ACCOUNT_REJECTED%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='accept_staff_invitation'`],
  ['#50    staff_invitation_state() exists, self-scoped, no arguments', `select case
      when to_regprocedure('public.staff_invitation_state()') is null then false
      else has_function_privilege('authenticated','public.staff_invitation_state()','execute')
           and not has_function_privilege('anon','public.staff_invitation_state()','execute')
      end as ok`],
  ['#50    it reads has_password from auth.users, never exposing the hash', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%encrypted_password%<>%'
        and pg_get_functiondef(p.oid) not ilike '%''password''%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='staff_invitation_state'`],
  ['#50    the Access Requests queue excludes invited and active staff', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%not exists%staff_memberships%'
        and pg_get_functiondef(p.oid) ilike '%''invited'', ''active''%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='admin_access_request_queue'`],
  ['#50    the badge count RPC exists and shares the queue predicate', `select case
      when to_regprocedure('public.admin_access_request_pending_count()') is null then false
      else (select coalesce(bool_and(
              pg_get_functiondef(p.oid) ilike '%has_staff_permission(''access_requests.review'')%'
              and pg_get_functiondef(p.oid) ilike '%not exists%staff_memberships%'), false)
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='admin_access_request_pending_count')
      end as ok`],
  ['#50    reviewing your own access request is refused', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%ACCESS_REQUEST_SELF_REVIEW%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='admin_review_access_request'`],
  ['#50    the two new codes are in the catalog', `select count(*) = 2 as ok
      from public.app_error_catalog()
     where code in ('STAFF_ACCOUNT_REJECTED','ACCESS_REQUEST_SELF_REVIEW')`],

  // ── #51, access-request staff target ──────────────────────────────────────
  // The decider must refuse what the queue hides. admin_review_access_request()
  // is granted to `authenticated` and gated only on access_requests.review — a
  // permission Ops Admins hold — so the UI hiding staff rows is not a boundary:
  // a direct PostgREST call takes any uuid.
  ['#51    the decider refuses an invited or active staff target', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%ACCESS_REQUEST_STAFF_TARGET%'
        and pg_get_functiondef(p.oid) ilike '%''invited'', ''active''%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='admin_review_access_request'`],
  // suspended/revoked stay reviewable: a former staff member may be a real student.
  ['#51    it still refuses a self-review, keeping the #50 guard', `select coalesce(bool_and(
        pg_get_functiondef(p.oid) ilike '%ACCESS_REQUEST_SELF_REVIEW%'
        and pg_get_functiondef(p.oid) ilike '%is_super_admin()%'), false) as ok
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='admin_review_access_request'`],
  ['#51    the new code is in the catalog', `select count(*) = 1 as ok
      from public.app_error_catalog()
     where code = 'ACCESS_REQUEST_STAFF_TARGET'`],

  // ── #52, student progress and privacy-safe rankings ──────────────────────
  ['#52    progress tables exist with RLS', `select coalesce(bool_and(c.relrowsecurity), false) as ok
      from pg_class c where c.oid in (
        'public.student_progress_milestones'::regclass,
        'public.student_foundation_completions'::regclass,
        'public.student_ranking_preferences'::regclass,
        'public.student_progress_daily'::regclass)`],
  // All SEVEN functions #52 grants to `authenticated`. complete_progress_feature_guide
  // was missing here, so the audit passed clean while the mock-interview watch-gate
  // had no server-side write path at all.
  ['#52    the seven client APIs exist', `select coalesce(bool_and(p is not null), false) as ok from (values
      (to_regprocedure('public.my_student_progress()')),
      (to_regprocedure('public.student_leaderboard(text,uuid,text,integer,integer)')),
      (to_regprocedure('public.admin_student_progress_report(text,uuid,text,numeric,numeric,integer,boolean,integer,integer)')),
      (to_regprocedure('public.set_leaderboard_visibility(boolean)')),
      (to_regprocedure('public.set_foundation_milestone(text,boolean)')),
      (to_regprocedure('public.complete_progress_feature_guide(text)')),
      (to_regprocedure('public.complete_course_lesson(uuid)'))) as v(p)`],
  ['#52    internal scorer and snapshot are client-unreachable', `select case
      when to_regprocedure('public.student_progress_current(uuid)') is null then false
      when to_regprocedure('public.student_progress_snapshot(date)') is null then false
      else not has_function_privilege('authenticated','public.student_progress_current(uuid)','execute')
       and not has_function_privilege('authenticated','public.student_progress_snapshot(date)','execute')
       and not has_function_privilege('anon','public.student_progress_current(uuid)','execute')
       and not has_function_privilege('anon','public.student_progress_snapshot(date)','execute') end as ok`],
  // insert, update AND delete: checking only insert would pass a future migration that
  // re-granted update on lesson_progress, which is just as much a client write path.
  ['#52    raw progress mutation is revoked', `select bool_and(
        not has_table_privilege('authenticated', t, 'insert')
        and not has_table_privilege('authenticated', t, 'update')
        and not has_table_privilege('authenticated', t, 'delete')) as ok
      from unnest(array[
        'public.lesson_progress','public.course_completions',
        'public.feature_video_completions','public.student_foundation_completions',
        'public.student_ranking_preferences']) as t`],
  ['#52    snapshots are not client-readable', `select
      not has_table_privilege('authenticated','public.student_progress_daily','select')
      and not has_table_privilege('anon','public.student_progress_daily','select') as ok`],
  ['#52    lesson/course identity has a composite FK', `select exists (
      select 1 from pg_constraint where conrelid='public.lesson_progress'::regclass
        and conname='lesson_progress_lesson_course_fkey' and contype='f') as ok`],
  ['#52    public leaderboard return type has no private identity', `select case
      when to_regprocedure('public.student_leaderboard(text,uuid,text,integer,integer)') is null then false
      else pg_get_function_result(to_regprocedure('public.student_leaderboard(text,uuid,text,integer,integer)'))
             not similar to '%(user_id|email|full_name|avatar|batch_id|receipt|payment)%' end as ok`],
  ['#52    My Batch is derived from the entitlement ledger', `select
      exists(select 1 from pg_proc where pronamespace='public'::regnamespace
        and proname='student_progress_current' and prosrc like '%user_entitled_batches%')
      and exists(select 1 from pg_proc where pronamespace='public'::regnamespace
        and proname='student_leaderboard' and prosrc like '%v_caller.batch_id%'
        -- and the wrong one is ABSENT: 'appears somewhere' is not the invariant.
        -- Filtering on the caller-supplied p_batch_id is exactly the batch oracle
        -- this check exists to forbid, and a substring test for the right name
        -- passes happily while the wrong name sits two lines below it.
        and prosrc not like '%batch_id = p_batch_id%') as ok`],
  ['#52    student_progress.read belongs only to Super and Operations', `select
      (select count(*) from public.staff_role_permissions where permission_key='student_progress.read') = 2
      and exists(select 1 from public.staff_role_permissions where role_key='super_admin' and permission_key='student_progress.read')
      and exists(select 1 from public.staff_role_permissions where role_key='operations_admin' and permission_key='student_progress.read')
      and not exists(select 1 from public.staff_role_permissions where role_key='trainer' and permission_key='student_progress.read') as ok`],
  ['#52    all eight Accounting 101 milestones are seeded', `select count(*) = 8 as ok
      from public.student_progress_milestones where track_key='foundation' and active`],
  ['#52    snapshots retain at most 400 days', `select coalesce(bool_and(
      prosrc like '%snapshot_date < p_date - 400%'), false) as ok
      from pg_proc where pronamespace='public'::regnamespace and proname='student_progress_snapshot'`],
  ['#53    a learner reads only their own segment board', `select
      src ~ 'v_scope = ''vip''\\s+and v_caller\\.plan_key <> ''vip'''
      and src ~ 'v_scope = ''general''\\s+and v_caller\\.plan_key =\\s+''vip'''
      and src like '%not v_is_staff%' as ok
      from (select regexp_replace(prosrc, '--[^\n]*', '', 'g') as src
              from pg_proc where pronamespace='public'::regnamespace
                and proname='student_leaderboard') t`],
  ['#53    guide completion cannot re-mint its own recency', `select
      prosrc like '%is distinct from excluded.video_version%'
      and prosrc not like '%completed = true,%completed_at = now(),%' as ok
      from pg_proc where pronamespace='public'::regnamespace
        and proname='complete_progress_feature_guide'`],
  ['#53    staff are excluded from BOTH arms of the report', `select
      prosrc like '%staff_memberships sm%' as ok
      from pg_proc where pronamespace='public'::regnamespace
        and proname='admin_student_progress_report'`],
  ['#54    one run per course family in the denominator', `select
      src like '%distinct on (cr.user_id, cr.root_id)%'
      and src like '%l.depth < 10%'
      and src like '%source_course_id%'
      -- course_date stays a display label the scorer must never read. Checked against
      -- COMMENT-STRIPPED source: the comment explaining the rule names the column.
      and src not like '%course_date%' as ok
      from (select regexp_replace(prosrc, '--[^\n]*', '', 'g') as src
              from pg_proc where pronamespace='public'::regnamespace
                and proname='student_progress_current') t`],
  ['#52    daily snapshot cron is scheduled', `select coalesce((select
      (xpath('/row/ok/text()', x))[1]::text::boolean from query_to_xml(
        case when to_regclass('cron.job') is null then 'select false as ok'
             else 'select exists(select 1 from cron.job where jobname = ''snapshot-student-progress'') as ok' end,
        false, true, '') as t(x)), false) as ok`],

  // #55 — the approve RPCs must not be client-callable. Verified live on 2026-08-31:
  // an active operations_admin called approve_subscription(<own uid>,'vip',null) through
  // PostgREST and minted itself an unpaid VIP term. #48's self-approval trigger is on
  // enrollment_requests, which neither function touches, so it could not fire. The
  // sanctioned caller (admin_finalize_enrollment) is SECURITY DEFINER and unaffected.
  ['#55    approve RPCs are not callable by a client', `select coalesce(bool_and(
      not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')), false) as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('approve_subscription','approve_extension')`],
  // #56 — Community authority moved off is_admin() and onto community.manage /
  // community.moderate, which operations_admin and trainer now hold. Every check below is
  // a TRIPWIRE: a later migration that re-creates one of these nine RPCs from the
  // #40/#41/#43 text would silently put it back on Super-Admin-only, and nothing else in
  // the toolchain would notice — db:shadow:verify compares proname/args/prosecdef/proconfig
  // and never prosrc, and it filters pg_policies to schemaname='public', so the two
  // community-media policies are invisible to it entirely.
  ['#56    both community permissions reach both non-super roles', `select count(*) = 6 as ok
    from public.staff_role_permissions
   where permission_key in ('community.manage','community.moderate')`],
  ['#56    the nine community RPCs are on community.manage', `select count(*) = 9 as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc like '%has_staff_permission(''community.manage'')%'
     and p.proname in ('admin_community_config','admin_save_community_settings',
                       'admin_save_channel_category','admin_move_channel_category',
                       'admin_save_community_channel','admin_move_community_channel',
                       'admin_set_community_channel_status','admin_channel_privacy_preview',
                       'admin_community_media_orphans')`],
  ['#56    no community RPC still carries the legacy guard', `select count(*) = 0 as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.prosrc like '%if not public.is_admin() then%'
          or p.prosrc like '%where public.is_admin()%')
     and p.proname in ('admin_community_config','admin_save_community_settings',
                       'admin_save_channel_category','admin_move_channel_category',
                       'admin_save_community_channel','admin_move_community_channel',
                       'admin_set_community_channel_status','admin_channel_privacy_preview',
                       'admin_community_media_orphans')`],
  // The re-gate rewrites each function through pg_get_functiondef(). If it ever ran against
  // a body that had lost #43's runtime patch, this is what would say so.
  ['#56    the re-gate preserved #43 p_kind conjunct', `select prosrc like '%p_kind           is not null%' as ok
    from pg_proc where proname = 'admin_save_community_channel'`],
  ['#56    backdating a post is still Super-Admin-only', `select
      prosrc like '%is_super_admin()%' and prosrc not like '%if not public.is_admin() then%' as ok
    from pg_proc where proname = 'community_posts_guard'`],
  ['#56    the per-user community-staff helper is internal only', `select count(*) = 1 and coalesce(bool_and(
      not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')), false) as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'user_is_community_staff'`],
  ['#56    the caller-pinned helper IS granted, or RLS fails closed for all', `select
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'is_community_staff'`],
  ['#56    the moderation RPCs are callable by a signed-in staff member', `select count(*) = 2 and coalesce(bool_and(
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')), false) as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('community_moderate_post','community_moderate_comment')`],
  ['#56    the moderation ledger is append-only from a client', `select
      not has_table_privilege('authenticated','public.community_moderation_events','insert')
      and not has_table_privilege('authenticated','public.community_moderation_events','update')
      and not has_table_privilege('authenticated','public.community_moderation_events','delete') as ok`],
  ['#56    the moderation ledger has exactly one policy, a select', `select count(*) = 1 as ok
    from pg_policies where schemaname='public' and tablename='community_moderation_events'`],
  // ★ The blanket FOR ALL policies must stay SUPER-ADMIN-ONLY. These tables carry no
  // table-level DML revoke, so a FOR ALL policy is a raw PostgREST write path over every
  // row: gating one on community.moderate would let a Trainer rewrite another member's
  // body, set author_id, or DELETE a post with no ledger row and no captured storage
  // paths. Ops Admins and Trainers reach other people's content only through the RPCs.
  // ★ BOTH CLAUSES, AND with_check IS THE ONE THAT MATTERS. These are FOR ALL policies on
  // tables with no DML revoke, so with_check IS the blanket write path — the exact thing
  // #56 argues must not reach a non-super role. A check reading only `qual` would pass a
  // future migration that re-gated the write half alone. `count(*) = 5` is asserted beside
  // bool_and because bool_and over a PARTIAL set is true over the survivors: one policy
  // renamed or dropped would otherwise pass clean.
  ['#56    the blanket FOR ALL policies stay Super-Admin-only', `select
      count(*) = 5 and coalesce(bool_and(
        qual ilike '%is_super_admin%'
        and coalesce(with_check, '') ilike '%is_super_admin%'
        and qual not ilike '%community.moderate%'
        and coalesce(with_check, '') not ilike '%community.moderate%'
        and qual not ilike '%is_community_staff%'
        and coalesce(with_check, '') not ilike '%is_community_staff%'), false) as ok
    from pg_policies where schemaname='public'
      and policyname in ('community_posts_admin_all','community_comments_admin_all',
                         'community_reactions_admin_all','community_attachments_admin_all',
                         'community_post_tags_admin_all')`],
  ['#56    community_tags_admin_all stays Super-Admin-only too', `select
      count(*) = 1 and coalesce(bool_and(
        qual ilike '%is_super_admin%'
        and coalesce(with_check, '') ilike '%is_super_admin%'), false) as ok
    from pg_policies where schemaname='public' and policyname = 'community_tags_admin_all'`],
  ['#56    staff own-row writes admit staff standing, and stay own-row', `select count(*) = 7 and coalesce(bool_and(
      with_check ilike '%is_community_staff%'
      and with_check ilike '%is_enrolled%'
      and with_check ilike '%auth.uid()%'), false) as ok
    from pg_policies where schemaname='public'
      and policyname in ('community_posts_own_insert','community_posts_own_update',
                         'community_comments_own_insert','community_comments_own_update',
                         'community_reactions_own_insert','community_attachments_own_insert',
                         'community_post_tags_own_insert')`],
  // The storage half of the same rule, in a different schema so the query above cannot see
  // it. Both matter: the ROW policy lets staff record an attachment, the OBJECT policy lets
  // them upload the file, and community_media_delete's member arm lets them clear the
  // orphan when a publish fails. Widening any one alone is a broken feature.
  ['#56    staff can upload community media, and clear their own orphan', `select
      count(*) = 2 and coalesce(bool_and(
        coalesce(with_check, qual) ilike '%is_community_staff%'), false) as ok
    from pg_policies where schemaname='storage'
      and policyname in ('community_media_own_insert','community_media_delete')`],
  ['#56    the channel audience maps are community.manage only', `select count(*) = 2 and coalesce(bool_and(
      qual ilike '%community.manage%'), false) as ok
    from pg_policies where schemaname='public'
      and policyname in ('community_channel_plans_admin_select',
                         'community_channel_batches_admin_select')`],
  ['#56    community reads admit staff and keep the channel scope', `select count(*) = 4 and coalesce(bool_and(
      qual ilike '%is_community_staff%' and qual ilike '%my_community_channel_ids%'), false) as ok
    from pg_policies where schemaname='public'
      and policyname in ('community_posts_read','community_comments_read',
                         'community_attachments_read','community_post_tags_read')`],
  ['#56    a moderator storage delete is bounded, blanket stays super', `select
      qual ilike '%is_super_admin%' and qual ilike '%community_moderation_events%'
      and qual ilike '%a.storage_path = name%' and qual not ilike '%is_admin()%' as ok
    from pg_policies where schemaname='storage' and policyname='community_media_delete'`],
  ['#56    community_spaces_admin_all is still the batch lifecycle', `select
      qual ilike '%batches.manage%' as ok
    from pg_policies where schemaname='public' and policyname='community_spaces_admin_all'`],

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

// Only run the audit when this file is the entry point. Exporting OBJECT_CHECKS
// lets a dry-run harness assert the SAME checks inside a rolled-back transaction,
// which is the only way to prove a not-yet-applied migration satisfies them.
const INVOKED_DIRECTLY = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (INVOKED_DIRECTLY) main().catch((e) => {
  console.error(`\naudit failed: ${e.message}\n`);
  process.exit(2);
});
