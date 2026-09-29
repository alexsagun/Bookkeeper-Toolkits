// test/legacyMigrationRound2Sql.test.mjs — the #68 migration, read as text (no database needed).
//
// Every assertion runs against the dated file AND its bootstrap fold (§55): the dated file
// is what an existing database runs, the fold is what a fresh install gets. #68 restates
// fifteen #67 function bodies and the catalog, and each was COPIED by a script and edited at
// anchors — so each is line-diffed against #67 here, with the exact lines it may drop and
// add. A restated body that silently loses a line is the #33/#34 failure this repo keeps
// recording; a diff that grows by one unexpected line fails here, not in production.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
// ★ A namespace import, not named ones: these mirrors are written by another change in the
//   same release, and a missing named export would fail this WHOLE file at link time instead
//   of the one assertion that needs it.
import * as LM from '../src/lib/legacyMigration.js';
import * as PC from '../src/lib/planCatalog.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const DATED = 'db/2026-09-28-legacy-migration-round2.sql';
const PREV = 'db/2026-09-25-legacy-student-migration.sql';
const BOOT = 'db/000_full_database_bootstrap.sql';
const FOLD_BANNER = '-- §55) FOLDED VERBATIM — 2026-09-28-legacy-migration-round2.sql';

const dated = read(DATED);
const prev = read(PREV);
const boot = read(BOOT);
const foldAt = boot.indexOf(FOLD_BANNER);
/** §55, bounded at the next fold banner if one is ever added after it. */
const fold = (() => {
  if (foldAt < 0) return '';
  const next = boot.slice(foldAt + 1).search(/^--\s*§\d+\) FOLDED VERBATIM/m);
  return next < 0 ? boot.slice(foldAt) : boot.slice(foldAt, foldAt + 1 + next);
})();
const FILES = [[DATED, dated], ['§55 fold', fold]];

/** Executable SQL: comment lines removed. */
const code = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

/** The LAST body of a function in `sql`, comments and blank lines stripped, trimmed lines. */
function body(sql, name) {
  const marker = `create or replace function public.${name}(`;
  const at = sql.lastIndexOf(marker);
  if (at < 0) return null;
  const open = sql.slice(at).match(/\nas (\$[a-z]*\$)\n/);
  if (!open) return null;
  const q = open[1];
  const start = at + open.index + open[0].length;
  const end = sql.indexOf(`\n${q};`, start);
  return sql.slice(start, end).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
}
/** The signature text of the LAST definition: from `create or replace` to `returns`. */
function signature(sql, name) {
  const at = sql.lastIndexOf(`create or replace function public.${name}(`);
  if (at < 0) return null;
  return sql.slice(at, sql.indexOf('\nreturns ', at)).replace(/\s+/g, ' ');
}
/**
 * The top-level argument count of every `jsonb_build_object(` call in `sql`: quotes, nested
 * parentheses and trailing `--` comments understood. Postgres caps a call at 100 arguments,
 * and in a plpgsql body that surfaces only when the statement first RUNS.
 */
function jsonbBuildObjectArgCounts(sql) {
  const out = [];
  const open = 'jsonb_build_object(';
  let i = 0;
  while ((i = sql.indexOf(open, i)) >= 0) {
    let depth = 1; let commas = 0; let inStr = false; let empty = true;
    for (let j = i + open.length; j < sql.length && depth > 0; j += 1) {
      const c = sql[j];
      if (inStr) {
        if (c === "'") { if (sql[j + 1] === "'") j += 1; else inStr = false; }
        continue;
      }
      if (c === '-' && sql[j + 1] === '-') { const nl = sql.indexOf('\n', j); j = nl < 0 ? sql.length : nl; continue; }
      if (c === "'") { inStr = true; empty = false; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 1) commas += 1;
      if (depth > 0 && !/\s/.test(c)) empty = false;
    }
    out.push(empty ? 0 : commas + 1);
    i += open.length;
  }
  return out;
}

// ★ THE EDITS #68 MAKES TO EACH #67 BODY, AND NOTHING ELSE. Lines are compared as sets of
//   trimmed executable lines (whole-line comments stripped), exactly as the #67 suite
//   compares its copy of grant_batch_run. Reviewed line by line when #68 was assembled.
const EDITS = {
  legacy_import_stage: {
    removed: [
      "('eligible_batch_codes', j.eligible_batch_codes is distinct from v_eligible)) as d(k, differs)",
      "created_by, pipeline, date_format, plan_mapping, batch_mapping, eligible_batch_codes)",
      "coalesce(p_job->'plan_mapping', '{}'::jsonb), coalesce(p_job->'batch_mapping', '{}'::jsonb), v_eligible)",
      "case when v_plan_ok then r.plan_key end, v_batch.code);",
      "case when v_plan_ok then r.plan_key end, v_batch.id,",
      "when v_batch.code = any (v_eligible) then 'ready'",
      "or (oj.discarded_at is null and o.activation_state is distinct from 'reverted')));",
      "'eligible_batch_codes', to_jsonb(v_eligible), 'date_format', v_fmt));",
    ],
    added: [
      "v_eligible_plans text[];",
      "v_seg       text;",
      "v_days      int;",
      "select coalesce(array_agg(distinct c order by c), '{}'::text[]) into v_eligible_plans",
      "from jsonb_array_elements_text(coalesce(p_job->'eligible_plan_keys', '[]'::jsonb)) c;",
      "if exists (select 1 from unnest(v_eligible_plans) c",
      "where not exists (select 1 from public.enrollment_plans p where p.key = c)) then",
      "perform public.app_error('LEGACY_STAGE_INVALID', 'An eligible plan is not a plan in the catalog.', 422, null);",
      "('eligible_batch_codes', j.eligible_batch_codes is distinct from v_eligible),",
      "('eligible_plan_keys',   j.eligible_plan_keys is distinct from v_eligible_plans)) as d(k, differs)",
      "created_by, pipeline, date_format, plan_mapping, batch_mapping, eligible_batch_codes, eligible_plan_keys)",
      "coalesce(p_job->'plan_mapping', '{}'::jsonb), coalesce(p_job->'batch_mapping', '{}'::jsonb), v_eligible,",
      "v_eligible_plans)",
      "v_seg := null;",
      "v_days := null;",
      "if v_plan_ok then",
      "select p.community_segment, p.access_days into v_seg, v_days",
      "from public.enrollment_plans p where p.key = r.plan_key;",
      "if v_seg = 'vip' then",
      "elsif v_plan_ok and nullif(btrim(coalesce(r.legacy_batch_label, r.batch_code, '')), '') is not null then",
      "v_warn := v_warn || '[\"batch_ignored_for_plan\"]'::jsonb;",
      "if v_days is not null and abs((v_ed - v_sd + 1) - v_days) > 31 then",
      "v_warn := v_warn || '[\"term_length_unusual\"]'::jsonb;",
      "if exists (select 1 from public.profiles p where p.id = v_uid and p.is_paid)",
      "and not exists (select 1 from public.subscriptions s where s.user_id = v_uid) then",
      "v_errs := v_errs || '[\"grandfathered_member\"]'::jsonb;",
      "case when v_plan_ok then r.plan_key end,",
      "case when v_seg = 'vip' then v_batch.code else 'none' end);",
      "if v_key is null and jsonb_array_length(v_errs) = 0 then",
      "v_errs := v_errs || '[\"record_key_missing\"]'::jsonb;",
      "case when v_plan_ok then r.plan_key end, case when v_seg = 'vip' then v_batch.id end,",
      "when v_seg = 'vip' and v_batch.code = any (v_eligible) then 'ready'",
      "when v_seg is distinct from 'vip' and r.plan_key = any (v_eligible_plans) then 'ready'",
      "set errors = sr.errors || '[\"multiple_plans_in_file\"]'::jsonb",
      "and not (sr.errors ? 'multiple_plans_in_file')",
      "and (select count(distinct o.proposed_plan_key) from public.student_import_rows o",
      "where o.job_id = v_job and o.email_normalized = sr.email_normalized) > 1;",
      "or (oj.discarded_at is null and o.validation_status = 'valid'",
      "and o.activation_state in ('inactive', 'ready', 'failed'))));",
      "set warnings = sr.warnings || '[\"other_legacy_row\"]'::jsonb",
      "and not (sr.warnings ? 'other_legacy_row')",
      "where o.job_id <> v_job",
      "and oj.pipeline = 'legacy_v2' and oj.discarded_at is null",
      "and o.validation_status = 'valid'",
      "and o.activation_state in ('inactive', 'ready', 'failed', 'activating', 'activated')",
      "and (o.email_normalized = sr.email_normalized",
      "or (sr.external_user_id is not null and o.external_user_id = sr.external_user_id))",
      "and coalesce(o.activation_plan_key, o.proposed_plan_key)",
      "is distinct from coalesce(sr.activation_plan_key, sr.proposed_plan_key));",
      "'eligible_batch_codes', to_jsonb(v_eligible), 'eligible_plan_keys', to_jsonb(v_eligible_plans),",
      "'date_format', v_fmt));",
    ],
  },
  legacy_import_preflight: {
    removed: [
      "coalesce(sr.activation_batch_id, sr.proposed_batch_id)  as eff_batch_id,",
      "coalesce(sr.activation_end_date, sr.legacy_end_date)     as eff_end",
      "'roster_start', t.roster_start, 'roster_end', t.roster_end, 'row_ids', to_jsonb(t.ids))",
      "from (select r.eff_plan_key, r.eff_batch_id, r.eff_start, r.eff_end, count(*) as n, array_agg(r.id) as ids,",
      "from ready r group by 1, 2, 3, 4) t",
      "'allocation', public.legacy_import_preview_allocation(b.code,",
      "public.plan_eligible_batch_count(g.plan_key))) order by b.code, g.plan_key), '[]'::jsonb)",
      "from (select r.eff_batch_id, r.eff_plan_key as plan_key, count(*) as n",
      "from ready r group by r.eff_batch_id, r.eff_plan_key) g",
      "join public.batches b on b.id = g.eff_batch_id)",
    ],
    added: [
      "case when ep.community_segment = 'vip'",
      "then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end as eff_batch_id,",
      "coalesce(sr.activation_end_date, sr.legacy_end_date)     as eff_end,",
      "ep.community_segment                                     as eff_segment",
      "left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)",
      "), ov as (",
      "select r.id, o.activation_state as state,",
      "coalesce(o.activation_plan_key, o.proposed_plan_key) as plan_key",
      "from ready r",
      "join public.student_import_rows o",
      "on o.job_id <> p_job_id",
      "and (o.email_normalized = r.email_normalized",
      "or (r.external_user_id is not null and o.external_user_id = r.external_user_id))",
      "join public.student_import_jobs oj on oj.id = o.job_id and oj.pipeline = 'legacy_v2' and oj.discarded_at is null",
      "where o.validation_status = 'valid'",
      "and o.activation_state in ('inactive', 'ready', 'failed', 'activating', 'activated')",
      "and coalesce(o.activation_plan_key, o.proposed_plan_key) is distinct from r.eff_plan_key",
      "'roster_start', t.roster_start, 'roster_end', t.roster_end, 'row_ids', to_jsonb(t.ids),",
      "'plan_segment', t.eff_segment,",
      "'seats', coalesce(public.legacy_import_seat_count(t.eff_start, t.eff_end, t.eff_plan_key), 0))",
      "from (select r.eff_plan_key, r.eff_batch_id, r.eff_start, r.eff_end, r.eff_segment, count(*) as n, array_agg(r.id) as ids,",
      "from ready r group by 1, 2, 3, 4, 5) t",
      "'seats', g.seats,",
      "'allocation', public.legacy_import_preview_allocation(b.code, g.seats)) order by b.code, g.plan_key), '[]'::jsonb)",
      "from (select r.eff_batch_id, r.eff_plan_key as plan_key, count(*) as n,",
      "max(public.legacy_import_seat_count(r.eff_start, r.eff_end, r.eff_plan_key)) as seats",
      "from ready r",
      "where r.eff_segment = 'vip'   -- #68: cohorts are VIP rows only",
      "group by r.eff_batch_id, r.eff_plan_key) g",
      "join public.batches b on b.id = g.eff_batch_id),",
      "'emails', (select count(*) from ready where uid is null or not confirmed)",
      "+ (select count(*) from ready where uid is not null and confirmed),",
      "'grandfathered', (select count(*) from ready r",
      "where r.uid is not null",
      "and exists (select 1 from public.profiles p where p.id = r.uid and p.is_paid)",
      "and not exists (select 1 from public.subscriptions s where s.user_id = r.uid)),",
      "'overlaps', jsonb_build_object(",
      "'total', (select count(distinct x.id) from ov x),",
      "'by_plan', (select coalesce(jsonb_agg(jsonb_build_object(",
      "'plan_key', y.plan_key,",
      "'plan_name', (select p.name from public.enrollment_plans p where p.key = y.plan_key),",
      "'state', y.state, 'rows', y.n) order by y.plan_key, y.state), '[]'::jsonb)",
      "from (select x.plan_key, x.state, count(distinct x.id) as n",
      "from ov x group by x.plan_key, x.state) y)),",
      "'held_row_ids', (select coalesce(jsonb_agg(r.id order by r.source_row_number), '[]'::jsonb)",
      "from ready r where public.legacy_import_higher_plan_pending(r.id)),",
      "'batch_gaps', to_jsonb(public.legacy_import_batch_gaps(p_job_id, array(select r.id from ready r)))",
    ],
  },
  legacy_import_start_run: {
    removed: [

    ],
    added: [
      "v_gaps     text[];",
      "v_gaps := public.legacy_import_batch_gaps(p_job_id, v_ids);",
      "if cardinality(v_gaps) > 0 then",
      "perform public.app_error('LEGACY_BATCH_GAP',",
      "format('%s has no batch yet, while a later batch exists. Create it in Admin → Batches before activating.',",
      "array_to_string(v_gaps, ', ')), 409,",
      "jsonb_build_object('missing', to_jsonb(v_gaps)));",
    ],
  },
  legacy_import_claim_rows: {
    removed: [
      "or (p_retry_failed and sr.activation_state = 'failed' and sr.attempts < 5)",
    ],
    added: [
      "v_hold record;",
      "for v_hold in",
      "set activation_state = 'failed', last_error = 'higher_plan_pending', activation_claimed_at = null,",
      "and sr.activation_state = 'ready'",
      "and public.legacy_import_higher_plan_pending(sr.id)",
      "perform public.legacy_import_log(v_run.job_id, v_hold.id, p_actor, 'activation_blocked', 'higher_plan_pending',",
      "or (p_retry_failed and sr.activation_state = 'failed' and sr.attempts < 5",
      "and sr.last_error is distinct from 'higher_plan_pending')",
    ],
  },
  legacy_import_activate_row: {
    removed: [
      "public.plan_eligible_batch_count(v_plan.key), 'import', v_sub_id, v_plan.key, null,",
      "public.plan_eligible_batch_count(v_plan.key), 'import', v_sub_id, v_plan.key, null,",
    ],
    added: [
      "when v_prof.is_paid and not exists (select 1 from public.subscriptions s where s.user_id = v_prof.id)",
      "then 'grandfathered_member'",
      "if v_row.auth_user_created and v_prof.id is not null",
      "and v_prof.account_origin = 'import' and v_prof.approval_status = 'pending'",
      "and v_prof.onboarding_status = 'invited' then",
      "update public.profiles",
      "set account_origin = default, onboarding_status = default, invited_at = null, updated_at = now()",
      "where id = v_prof.id;",
      "perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'import_marks_cleared', v_block,",
      "jsonb_build_object('run_id', p_run_id, 'user_id', v_prof.id));",
      "public.legacy_import_seat_count(v_sd, v_ed, v_plan.key), 'import', v_sub_id, v_plan.key, null,",
      "public.legacy_import_seat_count(v_sd, v_ed, v_plan.key), 'import', v_sub_id, v_plan.key, null,",
    ],
  },
  legacy_import_begin_invite: {
    removed: [
      "v_kind := case when v_row.existing_confirmed then 'notify' else 'claim' end;",
      "if v_kind = 'claim' and v_prof.onboarding_status = 'completed' then",
      "perform public.app_error('LEGACY_ROW_NOT_READY',",
      "'The student has already claimed this account; there is nothing to resend.', 409,",
      "if v_row.invite_generation >= 20 then",
      "v_gen := v_row.invite_generation + 1;",
      "jsonb_build_object('generation', v_gen, 'resend', coalesce(p_resend, false)));",
    ],
    added: [
      "v_code  text;",
      "v_reuse boolean;",
      "v_reuse := coalesce(v_row.invite_state = 'not_sent' and v_row.invite_generation >= 1",
      "and v_row.invite_code in ('link_failed', 'app_url_missing',",
      "'email_not_configured', 'email_from_not_configured'), false);",
      "if (v_email is null or (v_row.invite_generation >= 20 and not v_reuse)) and not coalesce(p_resend, false) then",
      "v_code := case when v_email is null then 'account_missing' else 'invite_cap' end;",
      "set invite_state = 'failed', invite_code = v_code, updated_at = now()",
      "perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'invite_failed', v_code,",
      "jsonb_build_object('generation', v_row.invite_generation, 'resend', false));",
      "return jsonb_build_object('ok', false, 'skip', true, 'code', v_code);",
      "v_kind := case when v_row.existing_confirmed or v_prof.onboarding_status = 'completed' then 'notify' else 'claim' end;",
      "if v_row.invite_generation >= 20 and not v_reuse then   -- #68: a reused generation adds nothing",
      "v_gen := case when v_reuse then v_row.invite_generation else v_row.invite_generation + 1 end;   -- #68",
      "jsonb_build_object('generation', v_gen, 'resend', coalesce(p_resend, false), 'reused', v_reuse));   -- #68",
    ],
  },
  legacy_import_record_delivery: {
    removed: [
      "if p_state not in ('sent', 'uncertain', 'failed', 'notified') then",
      "perform public.legacy_import_log(v_job, p_row_id, p_actor, 'invite_' || p_state, nullif(v_code, ''),",
    ],
    added: [
      "if p_state not in ('sent', 'uncertain', 'failed', 'notified', 'not_sent') then",
      "if p_state = 'not_sent' and v_code not in ('resend_401', 'resend_403', 'resend_429', 'link_failed',",
      "'app_url_missing', 'email_not_configured', 'email_from_not_configured') then",
      "perform public.app_error('LEGACY_STAGE_INVALID',",
      "'Only a refusal that proves nothing was delivered can hand an invitation back.', 422,",
      "jsonb_build_object('code', v_code));",
      "perform public.legacy_import_log(v_job, p_row_id, p_actor,",
      "case when p_state = 'not_sent' then 'invite_handed_back' else 'invite_' || p_state end, nullif(v_code, ''),",
    ],
  },
  legacy_import_pending_invites: {
    removed: [

    ],
    added: [
      "and not (sr.id = any (coalesce(p_exclude, '{}'::uuid[])))",
    ],
  },
  legacy_import_job_summary: {
    removed: [
      "left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)",
    ],
    added: [
      "'eligible_plan_keys', to_jsonb(v_job.eligible_plan_keys),   -- #68",
      "left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)",
      "left join public.batches b on b.id = case when ep.community_segment = 'vip'",
      "then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end",
    ],
  },
  legacy_import_rows_page: {
    removed: [
      "rb.code as roster_batch_code, rb.name as roster_batch_name",
      "left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)",
      "'plan_key', coalesce(x.activation_plan_key, x.proposed_plan_key), 'legacy_plan_label', x.legacy_plan_label,",
    ],
    added: [
      "rb.code as roster_batch_code, rb.name as roster_batch_name, ep.name as plan_name",
      "left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)",
      "left join public.batches b on b.id = case when ep.community_segment = 'vip'",
      "then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end",
      "and (p_plan_key is null or coalesce(sr.activation_plan_key, sr.proposed_plan_key) = p_plan_key)   -- #68",
      "'plan_key', coalesce(x.activation_plan_key, x.proposed_plan_key), 'plan_name', x.plan_name,   -- #68",
      "'legacy_plan_label', x.legacy_plan_label,",
      "'onboarding_notice_attempts', x.onboarding_notice_attempts, 'onboarding_notice_at', x.onboarding_notice_at,",
      "'onboarding_notice_reservations', x.onboarding_notice_reservations,",
    ],
  },
  legacy_import_ready_ids: {
    removed: [
      "if coalesce(p_state, '') not in ('ready', 'failed') then",
      "perform public.app_error('LEGACY_STAGE_INVALID', 'Only ready or failed rows can be selected for activation.', 422, null);",
      "left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)",
    ],
    added: [
      "if coalesce(p_state, '') not in ('ready', 'failed', 'inactive') then",
      "perform public.app_error('LEGACY_STAGE_INVALID', 'Only ready, failed or inactive rows can be selected.', 422, null);",
      "left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)",
      "left join public.batches b on b.id = case when ep.community_segment = 'vip'",
      "then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end",
      "and (p_plan_key is null or coalesce(sr.activation_plan_key, sr.proposed_plan_key) = p_plan_key)",
    ],
  },
  legacy_import_set_eligibility: {
    removed: [
      "select sr.id, sr.job_id, sr.activation_state,",
      "b.status as batch_status, j.discarded_at",
      "and coalesce(r.batch_status, 'archived') <> 'archived'",
      "'skipped', cardinality(p_row_ids) - v_changed, 'found', v_seen);",
    ],
    added: [
      "v_not_valid int := 0;",
      "v_ended   int := 0;",
      "v_archived int := 0;",
      "v_wrong   int := 0;",
      "select sr.id, sr.job_id, sr.activation_state, sr.validation_status,",
      "b.status as batch_status, j.discarded_at, ep.community_segment as plan_segment",
      "left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)",
      "v_wrong := v_wrong + 1;",
      "and (r.plan_segment is distinct from 'vip' or coalesce(r.batch_status, 'archived') <> 'archived')",
      "elsif r.validation_status is distinct from 'valid' then",
      "v_not_valid := v_not_valid + 1;",
      "elsif (p_eligible and r.activation_state is distinct from 'inactive')",
      "or (not p_eligible and r.activation_state is distinct from 'ready') then",
      "v_wrong := v_wrong + 1;",
      "elsif r.plan_segment = 'vip' and coalesce(r.batch_status, 'archived') = 'archived' then",
      "v_archived := v_archived + 1;",
      "else",
      "v_ended := v_ended + 1;",
      "'skipped', cardinality(p_row_ids) - v_changed, 'found', v_seen,",
      "'skipped_reasons', jsonb_build_object('not_valid', v_not_valid, 'term_ended', v_ended,",
      "'batch_archived', v_archived, 'wrong_state', v_wrong));",
    ],
  },
  legacy_import_revert: {
    removed: [
      "'The student has already started using this membership. Change it from Enrollments instead.', 409,",
      "'reason', v_reason));",
    ],
    added: [
      "v_links  int := 0;",
      "'The student has already started using this membership, so it cannot be reverted here.', 409,   -- #68",
      "delete from public.student_external_accounts a",
      "where a.import_row_id = p_row_id and a.user_id = v_row.target_user_id;",
      "get diagnostics v_links = row_count;",
      "'reason', v_reason, 'external_links_removed', v_links));",
    ],
  },
  legacy_import_purge_raw: {
    removed: [
      "set mapped = '{}'::jsonb, email_display = null, email_normalized = null, updated_at = now()",
      "and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null);",
      "and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null)) then",
    ],
    added: [
      "set mapped = '{}'::jsonb, email_display = null, email_normalized = null,",
      "legacy_phone = null,",
      "external_user_id = case when v_job.discarded_at is not null then null else sr.external_user_id end,",
      "updated_at = now()",
      "and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null",
      "or sr.legacy_phone is not null",
      "or (v_job.discarded_at is not null and sr.external_user_id is not null));",
      "and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null",
      "or sr.legacy_phone is not null",
      "or (v_job.discarded_at is not null and sr.external_user_id is not null))) then",
    ],
  },
  legacy_import_onboarding_notice: {
    removed: [
      "set onboarding_notice_state = p_result, onboarding_notice_at = now(), updated_at = now()",
      "'{}'::jsonb);",
      "if v_row.onboarding_notice_attempts >= 5 then",
      "onboarding_notice_attempts = onboarding_notice_attempts + 1, updated_at = now()",
    ],
    added: [
      "v_code text := left(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9_:.-]', '', 'g'), 40);",
      "v_refund boolean;",
      "v_refund := p_result = 'failed'",
      "and v_code in ('resend_401', 'resend_403', 'resend_429',",
      "'email_not_configured', 'email_from_not_configured');",
      "set onboarding_notice_state = p_result, onboarding_notice_at = now(),",
      "onboarding_notice_attempts = case when v_refund then greatest(0, onboarding_notice_attempts - 1)",
      "else onboarding_notice_attempts end,",
      "updated_at = now()",
      "jsonb_build_object('code', nullif(v_code, ''), 'refunded', v_refund));",
      "if v_row.onboarding_notice_attempts >= 5 or v_row.onboarding_notice_reservations >= 20 then",
      "onboarding_notice_attempts = onboarding_notice_attempts + 1,",
      "onboarding_notice_reservations = onboarding_notice_reservations + 1,   -- #68: never handed back",
      "updated_at = now()",
    ],
  },
  app_error_catalog: {
    removed: [
      "('LEGACY_REVERT_REFUSED',        409, 'The activation cannot be reverted here; the student has started using it.')",
    ],
    added: [
      "('LEGACY_REVERT_REFUSED',        409, 'The activation cannot be reverted here; the student has started using it.'),",
      "('LEGACY_BATCH_GAP',             409, 'A month inside a cohort run has no batch while a later batch exists, so the run would skip it for good.')",
    ],
  },
};

const SERVICE_ONLY = [
  'legacy_import_plan_rank(text)', 'legacy_import_seat_count(date,date,text)', 'legacy_import_batch_gaps(uuid,uuid[])',
  'legacy_import_higher_plan_pending(uuid)',
  'legacy_import_stage(uuid,jsonb,jsonb)', 'legacy_import_preflight(uuid,uuid,uuid[])',
  'legacy_import_start_run(uuid,uuid,uuid[],text,text)', 'legacy_import_claim_rows(uuid,uuid,text,integer,boolean,uuid[])',
  'legacy_import_activate_row(uuid,uuid,uuid)', 'legacy_import_begin_invite(uuid,uuid,boolean)',
  'legacy_import_record_delivery(uuid,uuid,integer,text,text)', 'legacy_import_pending_invites(uuid,uuid,integer,uuid[])',
  'legacy_import_onboarding_notice(uuid,text,text)', 'legacy_import_reset_onboarding_notice(uuid,uuid)',
];
const CLIENT = [
  'legacy_import_job_summary(uuid)', 'legacy_import_rows_page(uuid,text,text,text,integer,integer,text)',
  'legacy_import_ready_ids(uuid,text,text,text,text)', 'legacy_import_set_eligibility(uuid[],boolean,text)',
  'legacy_import_revert(uuid,text)', 'legacy_import_purge_raw(uuid)',
];
/** Contract §0: keys never change; name is the package title, tagline the product line. */
const PACKAGE_TITLES = {
  vip: { name: 'VIP Package', tagline: 'Personalized Coaching Program' },
  silver_self_paced: { name: 'Silver · Self-Paced', tagline: 'QBO + Resume Combo' },
  sampler: { name: 'Essentials', tagline: 'Sampler Session' },
};
/** The codes a hand-back or a refund may carry: each proves nothing was delivered. */
const HAND_BACK_CODES = ['resend_401', 'resend_403', 'resend_429', 'link_failed', 'app_url_missing',
  'email_not_configured', 'email_from_not_configured'];
/**
 * #68 review (S4): the hand-backs whose request never reached the provider, so the provider
 * never saw the idempotency key — the ONLY ones that may reuse a generation. A 401/403/429
 * was received, and a provider may replay a refused answer to the same key.
 */
const NO_REQUEST_CODES = ['link_failed', 'app_url_missing', 'email_not_configured', 'email_from_not_configured'];
/**
 * #68 review (S2/V2): a 422 can be about ONE recipient — the failure that repeats for ever —
 * so it is not refunded, as in #67.
 */
const REFUND_CODES = ['resend_401', 'resend_403', 'resend_429', 'email_not_configured',
  'email_from_not_configured'];
/** The hard, never-refunded ceiling on a notice's reservations. */
const NOTICE_RESERVATION_CEILING = 20;

/** Postgres age() months between two ISO dates: field by field, borrowing on a negative day. */
function pgAgeMonths(fromIso, toIso) {
  const [sy, sm, sd] = fromIso.split('-').map(Number);
  const [ey, em, ed] = toIso.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm) - (ed < sd ? 1 : 0);
}
const plusDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
/** The SQL function's arithmetic, restated so the JS mirror can be pinned to it. */
const sqlSeatCount = (start, end, cap) => Math.max(1, Math.min(cap, pgAgeMonths(start, plusDay(end))));

// ── Structure ────────────────────────────────────────────────────────────────

test('the bootstrap carries §55, spliced after §54, preflight dropped, apply-log kept', () => {
  assert.ok(foldAt > 0, '§55 is missing from the bootstrap');
  assert.ok(boot.indexOf('-- §54) FOLDED VERBATIM') < foldAt, '§55 must come after §54');
  assert.ok(!/\ndo \$pre\$/.test(fold), 'the fold drops the preflight, as every fold does');
  assert.ok(fold.includes("('2026-09-28-legacy-migration-round2.sql', null,"), 'the fold keeps the schema_migrations row');
  assert.ok(dated.includes("('2026-09-28-legacy-migration-round2.sql', null,"), 'the dated file records itself');
});

test('the preflight requires #67 and accepts only the #67 catalog, or a re-run', () => {
  const pre = dated.slice(dated.indexOf('do $pre$'), dated.indexOf('$pre$;', dated.indexOf('do $pre$') + 8));
  assert.match(pre, /filename = '2026-09-25-legacy-student-migration\.sql'/);
  assert.match(pre, /not in \(132, 133\)/);
  assert.match(pre, /community_segment from public\.enrollment_plans where key = 'vip'\) is distinct from 'vip'/,
    'every #68 rule asks the segment, so a VIP plan that is not segment vip must stop the file');
});

test('the §9 seed carries the package titles, in lockstep with the client fallback', () => {
  const seed = code(boot.slice(boot.indexOf('insert into public.enrollment_plans'), boot.indexOf('on conflict (key) do nothing;',
    boot.indexOf('insert into public.enrollment_plans'))));
  for (const [key, { name, tagline }] of Object.entries(PACKAGE_TITLES)) {
    assert.ok(seed.includes(`('${key}', '${name}', '${tagline}',`), `§9 seeds ${key} as ${name} / ${tagline}`);
  }
  assert.ok(Array.isArray(PC.ENROLLMENT_PLANS_FALLBACK), 'ENROLLMENT_PLANS_FALLBACK is exported');
  for (const p of PC.ENROLLMENT_PLANS_FALLBACK) {
    const want = PACKAGE_TITLES[p.key];
    if (!want) continue;
    assert.equal(p.name, want.name, `ENROLLMENT_PLANS_FALLBACK.${p.key}.name must match the §9 seed`);
    assert.equal(p.tagline, want.tagline, `ENROLLMENT_PLANS_FALLBACK.${p.key}.tagline must match the §9 seed`);
  }
});

for (const [name, sql] of FILES) {
  const exe = code(sql);

  // ── Copied bodies ─────────────────────────────────────────────────────────

  for (const [fn, { removed, added }] of Object.entries(EDITS)) {
    test(`${name}: ${fn} is #67's body with exactly the #68 edits`, () => {
      const was = body(prev, fn);
      const now = body(sql, fn);
      assert.ok(was && now, `${fn} must be defined in both files`);
      assert.deepEqual(was.filter((l) => !now.includes(l)), removed, `${fn} dropped a line #68 did not mean to drop`);
      assert.deepEqual(now.filter((l) => !was.includes(l)), added, `${fn} gained a line #68 did not mean to add`);
    });
  }

  test(`${name}: a changed signature drops the old form BEFORE creating the new one`, () => {
    for (const [drop, fn] of [
      ['drop function if exists public.legacy_import_pending_invites(uuid, uuid, integer);', 'legacy_import_pending_invites'],
      ['drop function if exists public.legacy_import_rows_page(uuid, text, text, text, integer, integer);', 'legacy_import_rows_page'],
      ['drop function if exists public.legacy_import_ready_ids(uuid, text, text, text);', 'legacy_import_ready_ids'],
      ['drop function if exists public.legacy_import_onboarding_notice(uuid, text);', 'legacy_import_onboarding_notice'],
    ]) {
      const d = exe.indexOf(drop);
      assert.ok(d > 0, `${fn}'s old form must be dropped, not left beside the new one`);
      assert.ok(exe.indexOf(`create or replace function public.${fn}(`) > d, `${fn} is created after the drop`);
    }
    assert.match(signature(sql, 'legacy_import_pending_invites'), /p_limit int, p_exclude uuid\[\] default '\{\}'::uuid\[\]\)/);
    assert.match(signature(sql, 'legacy_import_ready_ids'), /p_state text default 'ready', p_plan_key text default null\)/);
    assert.match(signature(sql, 'legacy_import_rows_page'), /p_offset int default 0, p_plan_key text default null\)/);
    assert.match(signature(sql, 'legacy_import_onboarding_notice'),
      /p_user uuid, p_result text default null, p_code text default null\)/);
  });

  // ── Grants ────────────────────────────────────────────────────────────────

  test(`${name}: new and changed service-only functions are unreachable from every client role`, () => {
    const block = exe.slice(exe.indexOf('do $grants$'), exe.indexOf('$grants$;', exe.indexOf('do $grants$') + 10));
    const loops = [...block.matchAll(/foreach f in array array\[([\s\S]*?)\] loop([\s\S]*?)end loop;/g)];
    assert.equal(loops.length, 2, 'one service-only loop and one client loop');
    const [[, svcList, svcBody], [, cliList, cliBody]] = loops;
    assert.match(svcBody, /execute format\('revoke all on function %s from public, anon, authenticated', f\);\s*execute format\('grant execute on function %s to service_role', f\);/);
    assert.match(cliBody, /execute format\('revoke all on function %s from public, anon', f\);\s*execute format\('grant execute on function %s to authenticated', f\);/);
    for (const sig of SERVICE_ONLY) {
      assert.ok(svcList.includes(`'public.${sig}'`), `${sig} is not in the service-only list`);
      assert.ok(!cliList.includes(`'public.${sig}'`), `${sig} must never be granted to authenticated`);
    }
    for (const sig of CLIENT) assert.ok(cliList.includes(`'public.${sig}'`), `${sig} is not in the client list`);
  });

  test(`${name}: every new or changed service-only function re-checks the actor it was handed`, () => {
    for (const fn of ['legacy_import_stage', 'legacy_import_preflight', 'legacy_import_start_run', 'legacy_import_claim_rows',
      'legacy_import_activate_row', 'legacy_import_begin_invite', 'legacy_import_record_delivery',
      'legacy_import_pending_invites', 'legacy_import_reset_onboarding_notice']) {
      assert.ok(body(sql, fn).includes('perform public.legacy_import_require(p_actor);'), `${fn} must verify p_actor`);
    }
    for (const fn of ['legacy_import_job_summary', 'legacy_import_rows_page', 'legacy_import_ready_ids']) {
      assert.ok(body(sql, fn).includes('perform public.legacy_import_require(auth.uid());'), fn);
    }
  });

  // ── A batch is a VIP-only fact ────────────────────────────────────────────

  test(`${name}: staging checks a batch for a VIP row only, and keeps a non-VIP label as history`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    const vipAt = b.indexOf("if v_seg = 'vip' then");
    const lookupAt = b.indexOf('select * into v_batch from public.batches b where b.code = r.batch_code;');
    assert.ok(vipAt > 0 && lookupAt > vipAt, 'the registry lookup sits inside the VIP branch');
    assert.ok(b.indexOf('"batch_unknown"') > vipAt && b.indexOf('"batch_archived"') > vipAt);
    assert.ok(b.indexOf('"batch_ignored_for_plan"') > lookupAt, 'a non-VIP label becomes a warning');
    assert.ok(b.includes("select p.community_segment, p.access_days into v_seg, v_days"), 'the segment comes from the catalog');
    assert.ok(b.includes("case when v_plan_ok then r.plan_key end, case when v_seg = 'vip' then v_batch.id end,"),
      'a non-VIP row stores no batch');
    assert.ok(b.includes('left(r.legacy_plan_label, 120), left(r.legacy_batch_label, 120),'), 'the label is still recorded');
  });

  test(`${name}: a non-VIP row is Ready by its plan, a VIP row by its cohort, and the plan list is a setting`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(b.includes("when v_seg = 'vip' and v_batch.code = any (v_eligible) then 'ready'"));
    assert.ok(b.includes("when v_seg is distinct from 'vip' and r.plan_key = any (v_eligible_plans) then 'ready'"));
    assert.ok(b.includes("('eligible_plan_keys',   j.eligible_plan_keys is distinct from v_eligible_plans)) as d(k, differs)"),
      'a different plan list must refuse the reopen like every other setting');
    assert.ok(b.indexOf('LEGACY_JOB_SETTINGS_DIFFER') < b.indexOf("'reopened', true"));
    assert.match(exe, /add column if not exists eligible_plan_keys text\[\] not null default '\{\}'::text\[\];/);
  });

  test(`${name}: every read treats the batch as absent for a non-VIP plan`, () => {
    const vipOnly = /case when ep\.community_segment = 'vip'\s+then coalesce\(sr\.activation_batch_id, sr\.proposed_batch_id\) end/;
    for (const fn of ['legacy_import_preflight', 'legacy_import_job_summary', 'legacy_import_rows_page', 'legacy_import_ready_ids']) {
      assert.match(body(sql, fn).join('\n'), vipOnly, `${fn} must report no batch for a non-VIP row`);
    }
    const pf = body(sql, 'legacy_import_preflight').join('\n');
    assert.ok(pf.includes("where r.eff_segment = 'vip'"), 'cohorts are VIP rows only');
    assert.ok(pf.includes("'plan_segment', t.eff_segment,"));
    const elig = body(sql, 'legacy_import_set_eligibility').join('\n');
    assert.ok(elig.includes("and (r.plan_segment is distinct from 'vip' or coalesce(r.batch_status, 'archived') <> 'archived')"),
      'a missing batch is not "archived" for a Silver or Essentials row');
    assert.ok(!elig.includes("and coalesce(r.batch_status, 'archived') <> 'archived'\n"), 'the plan-blind guard is gone');
  });

  // ── The record key ────────────────────────────────────────────────────────

  test(`${name}: a non-VIP record key uses the literal 'none', and a valid row never has a NULL key`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(b.includes("case when v_seg = 'vip' then v_batch.code else 'none' end);"));
    const missingAt = b.indexOf('"record_key_missing"');
    assert.ok(missingAt > b.indexOf('v_key := public.legacy_import_record_key(') && missingAt < b.indexOf('v_valid := case'),
      'the NULL-key refusal is decided between the key and the validity');
    // The record-key function itself is unchanged: #67's body, its NULL guard intact.
    assert.equal(body(sql, 'legacy_import_record_key'), null, '#68 must not restate legacy_import_record_key');
  });

  test(`${name}: E4 — only a row that can still activate reserves its record key`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(b.includes("or (oj.discarded_at is null and o.validation_status = 'valid'\nand o.activation_state in ('inactive', 'ready', 'failed'))));"));
    assert.ok(!b.includes("o.activation_state is distinct from 'reverted'"), 'a blocked row no longer holds the key');
  });

  // ── Staging reasons ───────────────────────────────────────────────────────

  test(`${name}: grandfathered members are blocked at staging and at activation, never converted`, () => {
    const st = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(st.includes('if exists (select 1 from public.profiles p where p.id = v_uid and p.is_paid)\nand not exists (select 1 from public.subscriptions s where s.user_id = v_uid) then'));
    assert.ok(st.includes('"grandfathered_member"'));
    const act = body(sql, 'legacy_import_activate_row').join('\n');
    const gAt = act.indexOf("then 'grandfathered_member'");
    assert.ok(gAt > 0 && gAt < act.indexOf("then 'membership_conflict'"), 'refused in the block CASE, before any write');
    assert.ok(gAt < act.indexOf('insert into public.subscriptions'));
    assert.ok(act.includes('when v_prof.is_paid and not exists (select 1 from public.subscriptions s where s.user_id = v_prof.id)'));
  });

  test(`${name}: term length, a batch on a non-VIP row, and two plans in one file are named`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(b.includes('if v_days is not null and abs((v_ed - v_sd + 1) - v_days) > 31 then'), 'the 31-day tolerance');
    assert.ok(b.indexOf('"term_length_unusual"') > 0 && !/term_length_unusual[^\n]*v_errs/.test(b), 'a warning, never a block');
    assert.ok(!/batch_ignored_for_plan[^\n]*v_errs/.test(b), 'a warning, never a block');
    const multiAt = b.indexOf('"multiple_plans_in_file"');
    assert.ok(multiAt > b.indexOf('"duplicate_in_file"'), 'the row keeps duplicate_in_file too');
    // #68 review (L1): a copy with NO plan (unmapped / unknown) is not a DIFFERENT plan.
    // count(distinct) skips a NULL, as the library's Set of mapped keys does.
    assert.ok(b.includes('and (select count(distinct o.proposed_plan_key) from public.student_import_rows o\n'
      + 'where o.job_id = v_job and o.email_normalized = sr.email_normalized) > 1;'),
      'two DISTINCT, NON-NULL plans in the email group — never "a NULL is distinct from vip"');
    assert.ok(!b.includes('o.proposed_plan_key is distinct from sr.proposed_plan_key'),
      'the NULL-blind comparison is gone');
  });

  test(`${name}: the same person in another live roster under another plan is a staging warning`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(b.includes('set warnings = sr.warnings || \'["other_legacy_row"]\'::jsonb'));
    assert.ok(!/other_legacy_row[^\n]*errors/.test(b), 'never a block at staging');
    const at = b.indexOf('"other_legacy_row"');
    const clause = b.slice(at, b.indexOf('select coalesce(jsonb_object_agg', at));
    assert.match(clause, /oj\.pipeline = 'legacy_v2' and oj\.discarded_at is null/);
    assert.match(clause, /o\.activation_state in \('inactive', 'ready', 'failed', 'activating', 'activated'\)/);
    assert.match(clause, /is distinct from coalesce\(sr\.activation_plan_key, sr\.proposed_plan_key\)/);
  });

  // ── The rank and the seats ────────────────────────────────────────────────

  test(`${name}: the plan rank is explicit — vip 3, silver 2, sampler 1, anything else 0`, () => {
    const b = body(sql, 'legacy_import_plan_rank').join(' ');
    assert.match(b, /when 'vip' then 3 when 'silver_self_paced' then 2 when 'sampler' then 1 else 0/);
    assert.match(exe, /function public\.legacy_import_plan_rank\(p_key text\)\nreturns integer\nlanguage sql\nimmutable/);
    assert.ok(!/price|position/.test(b), 'never price and never position: price does not imply scope');
  });

  test(`${name}: seats are the whole months the paid term covers, at least one, capped by the plan`, () => {
    const b = body(sql, 'legacy_import_seat_count').join('\n');
    assert.ok(b.includes("if v_seg is distinct from 'vip' then\nreturn 0;"), 'a non-VIP plan takes no seat');
    assert.ok(b.includes('v_cap := public.plan_eligible_batch_count(p_plan);'), 'the cap is the plan\'s live run length');
    assert.ok(b.includes('v_age := age((p_end + 1)::timestamp, p_start::timestamp);'), 'the end date is inclusive');
    assert.ok(b.includes('v_months := (extract(year from v_age) * 12 + extract(month from v_age))::int;'));
    assert.ok(b.includes('return greatest(1, least(v_cap, v_months));'));
    // Both grants read it, and nothing in activation reads the plan's full run length any more.
    const act = body(sql, 'legacy_import_activate_row');
    assert.equal(act.filter((l) => l === "public.legacy_import_seat_count(v_sd, v_ed, v_plan.key), 'import', v_sub_id, v_plan.key, null,").length, 2,
      'the open-start AND the closed-start run are sized by the paid term');
    assert.ok(!act.join('\n').includes('plan_eligible_batch_count'));
  });

  // ── The batch gap ─────────────────────────────────────────────────────────

  test(`${name}: a month with no batch under a later batch refuses the start, by the preflight's own rule`, () => {
    const g = body(sql, 'legacy_import_batch_gaps').join('\n');
    assert.ok(g.includes("and ep.community_segment = 'vip'"), 'VIP rows only');
    assert.ok(g.includes('and not exists (select 1 from public.batches x where x.code = m.code)'), 'the month has no batch');
    assert.ok(g.includes('and exists (select 1 from public.batches y where y.code > m.code)'), 'while a later batch exists');
    assert.ok(g.includes('cross join lateral generate_series(0, coalesce(public.legacy_import_seat_count('),
      'the months are the seat run, from the effective batch month');
    const st = body(sql, 'legacy_import_start_run').join('\n');
    const gapAt = st.indexOf('v_gaps := public.legacy_import_batch_gaps(p_job_id, v_ids);');
    assert.ok(gapAt > st.indexOf("perform public.app_error('LEGACY_CONFIRMATION_MISMATCH',"), 'after the phrase check');
    assert.ok(gapAt < st.indexOf('insert into public.student_import_activation_runs'), 'before anything is written');
    assert.ok(st.includes("perform public.app_error('LEGACY_BATCH_GAP',"));
    assert.ok(st.includes("jsonb_build_object('missing', to_jsonb(v_gaps)));"), 'the context names the missing months');
    const pf = body(sql, 'legacy_import_preflight').join('\n');
    assert.ok(pf.includes("'batch_gaps', to_jsonb(public.legacy_import_batch_gaps(p_job_id, array(select r.id from ready r)))"),
      'the preflight names the same months by the same function');
  });

  test(`${name}: the preflight adds overlaps, grandfathered, gaps and emails, and keeps every #67 key`, () => {
    const pf = body(sql, 'legacy_import_preflight').join('\n');
    for (const k of ['requested', 'found', 'to_activate', 'row_ids', 'retrying', 'excluded', 'new_accounts',
      'existing_accounts', 'claim_emails', 'notifications', 'scheduled', 'plans', 'starts', 'ends', 'terms', 'cohorts',
      'overlaps', 'held_row_ids', 'grandfathered', 'batch_gaps', 'emails', 'seats', 'plan_segment']) {
      assert.ok(pf.includes(`'${k}',`), `the preflight must carry ${k}`);
    }
    assert.ok(/where ru\.job_id = p_job_id and ru\.status in \('running', 'paused'\)\s+and a\.id = any \(ru\.row_ids\)\)/.test(pf),
      'the ready CTE still leaves out rows an unfinished run holds');
  });

  // ── The claim ─────────────────────────────────────────────────────────────

  test(`${name}: the higher plan wins — a lower row is held before it is claimed`, () => {
    const b = body(sql, 'legacy_import_claim_rows').join('\n');
    const holdAt = b.indexOf("set activation_state = 'failed', last_error = 'higher_plan_pending'");
    assert.ok(holdAt > b.indexOf("blocked_reason = 'duplicate_staged'"), 'next to the duplicate sweep');
    assert.ok(holdAt < b.indexOf('with pick as ('), 'before the claim picks, so no account is created for it');
    // #68 review (S1): the rule lives in ONE function the preflight reads too.
    const callAt = b.indexOf('and public.legacy_import_higher_plan_pending(sr.id)');
    assert.ok(callAt > holdAt && callAt < b.indexOf('with pick as ('), 'the hold asks the shared rule');
    assert.ok(b.includes("and sr.activation_state = 'ready'\nand public.legacy_import_higher_plan_pending(sr.id)"),
      'only a ready row is held');
    assert.ok(!b.includes('legacy_import_plan_rank('), 'the claim no longer restates the rule inline');
    assert.ok(b.includes("'activation_blocked', 'higher_plan_pending',"), 'and it is logged');
    assert.ok(b.includes("and sr.last_error is distinct from 'higher_plan_pending')"), 'this run never takes a held row back');
  });

  test(`${name}: S1 — only a higher row that can still become a grant holds, and the preflight names the held rows`, () => {
    const h = body(sql, 'legacy_import_higher_plan_pending');
    assert.ok(h, 'legacy_import_higher_plan_pending is defined');
    const t = h.join('\n');
    // Everything the #68 hold already required…
    assert.ok(t.includes("and oj.pipeline = 'legacy_v2' and oj.discarded_at is null"), 'a live legacy roster');
    assert.ok(t.includes("and o.validation_status = 'valid'"));
    assert.ok(t.includes("and o.activation_state in ('inactive', 'ready', 'failed', 'activating')"), 'not yet activated');
    assert.ok(t.includes('and (o.email_normalized = sr.email_normalized\nor (sr.external_user_id is not null and o.external_user_id = sr.external_user_id))'),
      'the same person, by email or Thinkific id');
    assert.ok(t.includes('and public.legacy_import_plan_rank(coalesce(o.activation_plan_key, o.proposed_plan_key))\n> public.legacy_import_plan_rank(coalesce(sr.activation_plan_key, sr.proposed_plan_key))'),
      'strictly higher, by the explicit rank');
    // …plus: it can still become a grant. The grace is the one set_eligibility promotes by.
    assert.ok(t.includes('and (select t.grace_ends_at\nfrom public.legacy_import_term(coalesce(o.activation_start_date, o.legacy_start_date),\ncoalesce(o.activation_end_date, o.legacy_end_date)) t) > now()'),
      "the higher row's EFFECTIVE term must still have its grace ahead");
    assert.ok(t.includes("and (op.community_segment is distinct from 'vip'\nor exists (select 1 from public.batches ob\nwhere ob.id = coalesce(o.activation_batch_id, o.proposed_batch_id)\nand ob.status <> 'archived')))"),
      'a VIP higher row needs its effective cohort to exist and not be archived');
    assert.ok(t.includes('left join public.enrollment_plans op on op.key = coalesce(o.activation_plan_key, o.proposed_plan_key)'),
      "the segment is the higher row's EFFECTIVE plan's");
    assert.match(exe, /function public\.legacy_import_higher_plan_pending\(p_row_id uuid\)\nreturns boolean\nlanguage sql\nstable\nsecurity definer/);
    // The preflight names the rows by the SAME function, over the rows the run would take.
    const pf = body(sql, 'legacy_import_preflight').join('\n');
    assert.ok(pf.includes("'held_row_ids', (select coalesce(jsonb_agg(r.id order by r.source_row_number), '[]'::jsonb)\n"
      + 'from ready r where public.legacy_import_higher_plan_pending(r.id)),'));
    // It is defined before the two bodies that call it (a SQL function body is checked on create).
    const defAt = exe.indexOf('create or replace function public.legacy_import_higher_plan_pending(');
    assert.ok(defAt > 0 && defAt < exe.indexOf('create or replace function public.legacy_import_preflight(')
      && defAt < exe.indexOf('create or replace function public.legacy_import_claim_rows('));
    assert.ok(defAt > exe.indexOf('create or replace function public.legacy_import_plan_rank('), 'after the rank it reads');
  });

  // ── Invitations ───────────────────────────────────────────────────────────

  test(`${name}: an onboarded account gets the sign-in notice, and a never-sendable invite is recorded, not raised`, () => {
    const b = body(sql, 'legacy_import_begin_invite').join('\n');
    assert.ok(b.includes("v_kind := case when v_row.existing_confirmed or v_prof.onboarding_status = 'completed' then 'notify' else 'claim' end;"));
    assert.ok(!b.includes('there is nothing to resend'), 'the completed + claim raise is gone');
    const skipAt = b.indexOf("if (v_email is null or (v_row.invite_generation >= 20 and not v_reuse)) and not coalesce(p_resend, false) then");
    const genAt = b.indexOf('v_gen := case when v_reuse then v_row.invite_generation else v_row.invite_generation + 1 end;');
    assert.ok(skipAt > 0 && genAt > skipAt, 'decided before a generation is reserved');
    assert.ok(b.includes("v_code := case when v_email is null then 'account_missing' else 'invite_cap' end;"));
    assert.ok(b.includes("set invite_state = 'failed', invite_code = v_code, updated_at = now()"));
    assert.ok(b.includes("return jsonb_build_object('ok', false, 'skip', true, 'code', v_code);"));
    // …while a person's Resend keeps both refusals.
    assert.ok(b.includes("perform public.app_error('LEGACY_IDENTITY_MISMATCH', 'The account for this row no longer exists.', 409,"));
    assert.ok(b.includes("perform public.app_error('LEGACY_ROW_NOT_READY', 'This invitation has been sent too many times.', 409,"));
  });

  test(`${name}: S4 — a hand-back that never reached the provider keeps its generation; one the provider saw does not`, () => {
    const b = body(sql, 'legacy_import_begin_invite').join('\n');
    const at = b.indexOf('v_reuse := coalesce(');
    assert.ok(at > 0, 'the reuse decision exists');
    const expr = b.slice(at, b.indexOf('false);', at) + 'false);'.length);
    // Only a not_sent row, that has had a generation, and whose recorded code proves no request left.
    assert.ok(expr.includes("v_row.invite_state = 'not_sent'"), 'only a row handed back to the queue');
    assert.ok(expr.includes('v_row.invite_generation >= 1'), 'generation 0 was never started: nothing to reuse');
    const codes = [...(/v_row\.invite_code in \(([^)]*)\)/.exec(expr)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(codes.sort(), [...NO_REQUEST_CODES].sort());
    for (const c of ['resend_401', 'resend_403', 'resend_429', 'resend_422', 'resend_timeout']) {
      assert.ok(!codes.includes(c), `${c}: the provider received it, and may replay a refusal to the same key`);
    }
    assert.ok(NO_REQUEST_CODES.every((c) => HAND_BACK_CODES.includes(c)), 'every reusable code is a hand-back code');
    // A NULL (no recorded code) must read as "not reusable", or the cap below would read NULL.
    assert.ok(expr.startsWith('v_reuse := coalesce(') && expr.endsWith(', false);'));
    // Reserved AFTER the row is locked and before either cap reads it.
    assert.ok(at > b.indexOf('for update;') && at < b.indexOf("if (v_email is null or (v_row.invite_generation >= 20 and not v_reuse))"));
    // Both caps let a reused generation through — it adds nothing — and nothing else.
    assert.ok(b.includes('if v_row.invite_generation >= 20 and not v_reuse then'), "a person's Resend too");
    assert.equal((b.match(/invite_generation >= 20/g) || []).length, 2, 'exactly the two caps');
    assert.equal((b.match(/invite_generation >= 20 and not v_reuse/g) || []).length, 2, 'both know about reuse');
    // The generation and its audit row.
    assert.ok(b.includes('v_gen := case when v_reuse then v_row.invite_generation else v_row.invite_generation + 1 end;'));
    assert.ok(b.includes("jsonb_build_object('generation', v_gen, 'resend', coalesce(p_resend, false), 'reused', v_reuse));"));
    assert.ok(!b.includes('v_gen := v_row.invite_generation + 1;'), 'no unconditional increment is left');
    // The CHECK the cap lives under is untouched (#67).
    assert.match(read(PREV), /and invite_generation between 0 and 50/);
  });

  test(`${name}: only a code that proves nothing was delivered hands an invitation back`, () => {
    const b = body(sql, 'legacy_import_record_delivery').join('\n');
    assert.ok(b.includes("if p_state not in ('sent', 'uncertain', 'failed', 'notified', 'not_sent') then"));
    const list = [...(/p_state = 'not_sent' and v_code not in \(([^)]*)\)/.exec(b)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(list.sort(), [...HAND_BACK_CODES].sort());
    assert.ok(!list.includes('resend_422') && !list.includes('timeout'), 'an unclear answer is never re-sent blind');
    assert.ok(b.includes("case when p_state = 'not_sent' then 'invite_handed_back' else 'invite_' || p_state end"));
    assert.ok(b.includes("where id = p_row_id and invite_generation = p_generation and invite_state = 'sending'"),
      'only the attempt holding the generation records');
    const pend = body(sql, 'legacy_import_pending_invites').join('\n');
    assert.ok(pend.includes("and not (sr.id = any (coalesce(p_exclude, '{}'::uuid[])))"));
  });

  // ── Onboarding notice ─────────────────────────────────────────────────────

  test(`${name}: a provider or configuration refusal refunds the notice's reservation`, () => {
    const b = body(sql, 'legacy_import_onboarding_notice').join('\n');
    const list = [...(/v_code in \(([^)]*)\)/.exec(b)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(list.sort(), [...REFUND_CODES].sort());
    assert.ok(!list.includes('resend_422'), 'a 422 can be about one recipient: it uses up a try, as in #67');
    assert.ok(b.includes("v_refund := p_result = 'failed'"), 'only a failure is refunded');
    assert.ok(b.includes('onboarding_notice_attempts = case when v_refund then greatest(0, onboarding_notice_attempts - 1)'));
    assert.ok(b.includes('onboarding_notice_attempts = onboarding_notice_attempts + 1,'), 'each reservation still counts');
    for (const skip of ["'skip', 'sent'", "'skip', 'in_progress'", "'skip', 'exhausted'", "'skip', 'not_migrated'", "'skip', 'not_onboarded'"]) {
      assert.ok(b.includes(skip), skip);
    }
    assert.ok(!/auth\.uid\(\)/.test(b), 'service-only: never auth.uid()');
  });

  test(`${name}: S2 — a hard ceiling of twenty reservations that no refund and no reset lowers`, () => {
    // The column: never NULL, bounded by its own CHECK, backfilled from the #67 attempts.
    assert.match(exe, /alter table public\.student_import_rows\n\s+add column if not exists onboarding_notice_reservations smallint not null default 0;/);
    assert.match(exe, new RegExp(`add constraint student_import_rows_notice_reservations\\n\\s+check \\(onboarding_notice_reservations between 0 and ${NOTICE_RESERVATION_CEILING}\\);`));
    assert.match(exe, /drop constraint if exists student_import_rows_notice_reservations;/, 're-runnable');
    assert.match(exe, /update public\.student_import_rows\n\s+set onboarding_notice_reservations = onboarding_notice_attempts\n\s+where onboarding_notice_reservations < onboarding_notice_attempts;/,
      'a #67 row had no refunds, so its reservations ARE its attempts');
    const colAt = exe.indexOf('add column if not exists onboarding_notice_reservations');
    assert.ok(colAt < exe.indexOf('create or replace function public.legacy_import_onboarding_notice('), 'the column exists before the body reads it');

    const b = body(sql, 'legacy_import_onboarding_notice').join('\n');
    // It goes UP in the reserve branch — and that is the only write to it anywhere in #68.
    assert.ok(b.includes('onboarding_notice_attempts = onboarding_notice_attempts + 1,\n'
      + 'onboarding_notice_reservations = onboarding_notice_reservations + 1,   -- #68: never handed back\n'
      + 'updated_at = now()'));
    const writes = [...exe.matchAll(/onboarding_notice_reservations\s*=\s*([^,\n]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(writes.sort(), ['onboarding_notice_attempts', 'onboarding_notice_reservations + 1'].sort(),
      'the backfill, and the reserve branch — no refund, no reset, no other write');
    // …and the reserve refuses at the ceiling, next to the five tries.
    const exhaustedAt = b.indexOf(`if v_row.onboarding_notice_attempts >= 5 or v_row.onboarding_notice_reservations >= ${NOTICE_RESERVATION_CEILING} then`);
    assert.ok(exhaustedAt > 0, 'the ceiling answers exhausted');
    assert.ok(exhaustedAt < b.indexOf("set onboarding_notice_state = 'sending'"), 'before the reservation is taken');
    assert.ok(b.slice(exhaustedAt, exhaustedAt + 200).includes("'skip', 'exhausted'"));
    // The refund only ever touches the attempts.
    const refund = b.slice(b.indexOf("v_refund := p_result = 'failed'"), b.indexOf("where id = v_row.id and onboarding_notice_state = 'sending';"));
    assert.ok(!refund.includes('onboarding_notice_reservations'), 'a refund never lowers the ceiling');
  });

  test(`${name}: resetting a notice is a Super Admin action, audited, and never reopens a sent one`, () => {
    const b = body(sql, 'legacy_import_reset_onboarding_notice').join('\n');
    assert.ok(b.includes('perform public.legacy_import_require(p_actor);'));
    assert.ok(b.includes("v_row.activation_state is distinct from 'activated' or not coalesce(v_done, false)"));
    assert.ok(b.includes("if v_row.onboarding_notice_state = 'sent'"), 'the two emails ring once');
    assert.ok(b.includes('set onboarding_notice_state = null, onboarding_notice_attempts = 0, updated_at = now()'));
    assert.ok(b.includes("'onboarding_notice_reset', 'reset',"));
    assert.ok(b.indexOf("'LEGACY_ROW_NOT_READY'") < b.indexOf('update public.student_import_rows'), 'refused before any write');
    // #68 review (S2): the reset reopens the five tries, never the ceiling — and says so
    // instead of "resetting" a notice whose next reservation would answer exhausted anyway.
    assert.ok(!/onboarding_notice_reservations\s*=/.test(b), 'the reset never writes the ceiling');
    const ceilAt = b.indexOf(`if v_row.onboarding_notice_reservations >= ${NOTICE_RESERVATION_CEILING} then`);
    assert.ok(ceilAt > 0 && ceilAt < b.indexOf('update public.student_import_rows'), 'refused at the ceiling, before any write');
    assert.ok(b.slice(ceilAt, ceilAt + 300).includes("perform public.app_error('LEGACY_ROW_NOT_READY',"));
    assert.ok(b.includes("'reservations', v_row.onboarding_notice_reservations));"), 'the audit row records where the ceiling stood');
  });

  test(`${name}: the rows page carries the reservations, within jsonb_build_object's 100 arguments`, () => {
    const b = body(sql, 'legacy_import_rows_page').join('\n');
    assert.ok(b.includes("'onboarding_notice_reservations', x.onboarding_notice_reservations,"),
      'so the panel can hide a reset that can only be refused');
    // ★ A plpgsql body is parsed at its FIRST CALL, not at create: a 101st argument would pass
    //   every apply and fail on the first page load. Count every call's top-level arguments.
    for (const fn of ['legacy_import_rows_page', 'legacy_import_preflight', 'legacy_import_begin_invite']) {
      for (const n of jsonbBuildObjectArgCounts(body(sql, fn).join('\n'))) {
        assert.ok(n <= 100, `${fn}: a jsonb_build_object call has ${n} arguments (the limit is 100)`);
        assert.equal(n % 2, 0, `${fn}: a jsonb_build_object call has an odd argument count (${n})`);
      }
    }
  });

  // ── Recovery ──────────────────────────────────────────────────────────────

  test(`${name}: E7 — a refused row releases the account the import created, to the #26 defaults`, () => {
    const b = body(sql, 'legacy_import_activate_row').join('\n');
    const blockAt = b.indexOf('if v_block is not null then');
    const clearAt = b.indexOf('set account_origin = default, onboarding_status = default, invited_at = null');
    assert.ok(clearAt > blockAt && clearAt < b.indexOf('insert into public.subscriptions'), 'inside the refusal branch');
    assert.ok(b.includes("if v_row.auth_user_created and v_prof.id is not null\nand v_prof.account_origin = 'import' and v_prof.approval_status = 'pending'\nand v_prof.onboarding_status = 'invited' then"),
      'only an account this import created, still exactly as the bind step left it');
    assert.ok(b.includes("'import_marks_cleared', v_block,"));
    // The columns are NOT NULL (#26), so DEFAULT — never NULL.
    assert.match(read('db/2026-07-23-student-imports.sql'), /account_origin text not null default 'signup'/);
    assert.match(read('db/2026-07-23-student-imports.sql'), /onboarding_status text not null default 'none'/);
  });

  test(`${name}: E6 — revert removes the Thinkific-id link its activation made, and logs it`, () => {
    const b = body(sql, 'legacy_import_revert').join('\n');
    assert.ok(b.includes('delete from public.student_external_accounts a\nwhere a.import_row_id = p_row_id and a.user_id = v_row.target_user_id;'));
    assert.ok(b.includes("'external_links_removed', v_links"));
    assert.ok(!b.includes('Enrollments instead'), 'Enrollments cannot change a plan; the refusal must not send anyone there');
  });

  test(`${name}: E9 — purge clears phones, and the Thinkific id only in a discarded job`, () => {
    const b = body(sql, 'legacy_import_purge_raw').join('\n');
    assert.ok(b.includes('legacy_phone = null,'));
    assert.ok(b.includes('external_user_id = case when v_job.discarded_at is not null then null else sr.external_user_id end,'));
    assert.equal(b.split('or sr.legacy_phone is not null').length - 1, 2, 'both the update and the still-has-data test know the phone');
  });

  test(`${name}: set_eligibility names why each row was skipped`, () => {
    const b = body(sql, 'legacy_import_set_eligibility').join('\n');
    assert.ok(b.includes("'skipped_reasons', jsonb_build_object('not_valid', v_not_valid, 'term_ended', v_ended,"));
    assert.ok(b.includes("'batch_archived', v_archived, 'wrong_state', v_wrong));"));
    const ids = body(sql, 'legacy_import_ready_ids').join('\n');
    assert.ok(ids.includes("if coalesce(p_state, '') not in ('ready', 'failed', 'inactive') then"));
    // …and inactive stays unstartable: the start run still takes ready or failed rows alone.
    assert.ok(body(sql, 'legacy_import_start_run').join('\n').includes("sr.activation_state in ('ready', 'failed'));"));
  });

  // ── Data and catalog ──────────────────────────────────────────────────────

  test(`${name}: the three plans take their package titles; keys never change`, () => {
    const upd = exe.slice(exe.indexOf('update public.enrollment_plans p'), exe.indexOf(';', exe.indexOf('update public.enrollment_plans p')));
    assert.ok(upd.length > 0, 'the rename is in the file');
    for (const [key, { name: n, tagline }] of Object.entries(PACKAGE_TITLES)) {
      assert.match(upd, new RegExp(`\\('${key}',\\s+'${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s+'${tagline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`),
        `${key} → ${n} / ${tagline}`);
    }
    const setClause = upd.slice(upd.indexOf('set '), upd.indexOf('from ('));
    assert.match(setClause, /set name = v\.name, tagline = v\.tagline, updated_at = now\(\)/);
    assert.ok(!/\bkey\s*=/.test(setClause), 'a key is never rewritten');
    assert.ok(upd.includes('Silver · Self-Paced'), 'U+00B7 with a single space each side');
  });

  test(`${name}: the catalog adds LEGACY_BATCH_GAP and keeps every other code`, () => {
    const cat = body(sql, 'app_error_catalog').join('\n');
    const codes = cat.match(/\('[A-Z_]+',/g) || [];
    assert.equal(codes.length, 133);
    assert.ok(cat.includes("('LEGACY_BATCH_GAP',             409,"));
    for (const c of body(prev, 'app_error_catalog').join('\n').match(/\('[A-Z_]+',/g)) {
      assert.ok(cat.includes(c), `${c} was dropped from the catalog`);
    }
  });
}

// db:shadow:verify never compares prosrc, and nothing but the live audit sees a column's CHECK
// in production — so the review fixes each have a tripwire in scripts/audit-db.mjs.
test('npm run db:audit carries a live tripwire for each #68 review fix', () => {
  const audit = read('scripts/audit-db.mjs');
  for (const needle of [
    "'legacy_import_higher_plan_pending(uuid)',",
    "column_name = 'onboarding_notice_reservations'",
    "conname = 'student_import_rows_notice_reservations'",
    'where onboarding_notice_reservations < onboarding_notice_attempts',
    "p.prosrc not like '%''resend_422''%'",
    "p.prosrc like '%v_reuse := coalesce(%'",
    "p.prosrc like '%count(distinct o.proposed_plan_key)%'",
  ]) {
    assert.ok(audit.includes(needle), `scripts/audit-db.mjs must check: ${needle}`);
  }
});

test('every error code #68 adds has client copy', () => {
  assert.ok(APP_ERROR_CODES.includes('LEGACY_BATCH_GAP'), 'LEGACY_BATCH_GAP missing from APP_ERROR_CODES');
  assert.ok(APP_ERROR_COPY.LEGACY_BATCH_GAP && APP_ERROR_COPY.LEGACY_BATCH_GAP.length > 30,
    'LEGACY_BATCH_GAP needs copy that names the next action');
});

// ── The JS mirrors ────────────────────────────────────────────────────────────

test("the record key's non-VIP literal is the library's NON_VIP_BATCH_TOKEN", () => {
  assert.equal(LM.NON_VIP_BATCH_TOKEN, 'none');
  assert.ok(dated.includes(`case when v_seg = 'vip' then v_batch.code else '${LM.NON_VIP_BATCH_TOKEN}' end);`));
  assert.equal(LM.legacyRecordKeyInput({ externalId: '', email: 'a@b.test', planKey: 'sampler', batchCode: LM.NON_VIP_BATCH_TOKEN }),
    'thinkific|email:a@b.test|sampler|none');
  assert.ok(!/^\d{4}-\d{2}$/.test(LM.NON_VIP_BATCH_TOKEN), 'it cannot collide with a batch code');
});

test('planRank() mirrors legacy_import_plan_rank()', () => {
  assert.equal(typeof LM.planRank, 'function', 'planRank is exported');
  for (const [k, r] of [['vip', 3], ['silver_self_paced', 2], ['sampler', 1], ['gold_live', 0], [null, 0], ['', 0]]) {
    assert.equal(LM.planRank(k), r, `planRank(${k})`);
  }
});

test('legacySeatCount() mirrors legacy_import_seat_count()', () => {
  assert.equal(typeof LM.legacySeatCount, 'function', 'legacySeatCount is exported');
  // The contract's worked examples.
  assert.equal(LM.legacySeatCount('2026-10-12', '2027-04-12', 6), 6);
  assert.equal(LM.legacySeatCount('2026-10-12', '2026-11-11', 6), 1);
  assert.equal(LM.legacySeatCount('2026-10-12', '2026-11-10', 6), 1);
  assert.equal(LM.legacySeatCount('2026-10-12', '2027-10-11', 6), 6);
  // …and every pair of dates the SQL arithmetic can meet: month ends, leap days, a day short.
  const starts = ['2026-01-31', '2026-02-28', '2028-02-29', '2026-10-12', '2026-12-31', '2026-03-01'];
  const lengths = [0, 1, 27, 28, 29, 30, 31, 58, 59, 60, 89, 90, 179, 180, 181, 364, 365];
  for (const s of starts) {
    for (const d of lengths) {
      const e = new Date(Date.parse(`${s}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
      for (const cap of [1, 6]) {
        assert.equal(LM.legacySeatCount(s, e, cap), sqlSeatCount(s, e, cap), `${s} → ${e} (cap ${cap})`);
      }
    }
  }
});

// #68 review (L1): the endpoint passes the library's errors to legacy_import_stage(), which can
// only ADD to them — so any row the SQL tags multiple_plans_in_file that the preview did not
// shows up after staging as an error nobody was shown. The SQL rule, restated over the rows
// the library returns, must tag exactly the rows the library tags.
test('multiple_plans_in_file: the SQL rule and the library agree when a copy has no plan', () => {
  assert.equal(typeof LM.normalizeLegacyRows, 'function', 'normalizeLegacyRows is exported');
  const HEADERS = ['thinkific_user_id', 'first_name', 'last_name', 'email', 'plan_key', 'membership_started_at',
    'membership_ends_at', 'payment_status', 'amount_paid', 'currency', 'batch_code'];
  const PLANS = [
    { key: 'sampler', name: 'Essentials', price_php: 1499, active: true, access_days: 60, community_segment: 'general' },
    { key: 'silver_self_paced', name: 'Silver · Self-Paced', price_php: 2999, active: true, access_days: 60, community_segment: 'general' },
    { key: 'vip', name: 'VIP Package', price_php: 16999, active: true, access_days: 180, community_segment: 'vip' },
  ];
  const opts = {
    mapping: LM.autoMapLegacyHeaders(HEADERS), dateFormat: 'M/D/YYYY',
    planMapping: { vip: 'vip', silver: 'silver_self_paced', essentials: 'sampler' },
    batchMapping: { 'october 2026': '2026-10' },
    plans: PLANS, batches: [{ id: 'b10', code: '2026-10', name: 'October 2026', status: 'open' }],
    eligibleBatchCodes: ['2026-10'], eligiblePlanKeys: [], nowMs: Date.UTC(2026, 8, 25, 4, 0, 0),
  };
  const copy = (email, planLabel) => ({
    thinkific_user_id: '', first_name: 'Test', last_name: 'Copy', email, plan_key: planLabel,
    membership_started_at: '10/12/2026', membership_ends_at: '4/12/2027', payment_status: 'Paid',
    amount_paid: '15999', currency: 'PHP', batch_code: 'October 2026',
  });
  /** legacy_import_stage's rule: two or more DISTINCT, NON-NULL plans among the email's copies. */
  const sqlTags = (rows) => rows.map((r) => r.email_normalized != null
    && new Set(rows.filter((o) => o.email_normalized === r.email_normalized && o.plan_key != null)
      .map((o) => o.plan_key)).size > 1);
  const CASES = [
    // [labels of one person's copies, what the preview and the stored rows must both say]
    [['VIP', 'VIP Oct promo'], [false, false]],            // one mapped, one unmapped: a duplicate, not two plans
    [['VIP', 'Silver'], [true, true]],                      // two mapped plans
    [['VIP', 'Silver', 'VIP Oct promo'], [true, true, true]],
    [['VIP', 'VIP'], [false, false]],                       // one plan twice
    [['Nope', 'Also nope'], [false, false]],                // no plan at all
  ];
  for (const [labels, want] of CASES) {
    const rows = LM.normalizeLegacyRows(labels.map((l) => copy('same.person@example.test', l)), opts);
    const lib = rows.map((r) => r.errors.includes('multiple_plans_in_file'));
    assert.ok(rows.every((r) => r.errors.includes('duplicate_in_file')), `${labels}: every copy is a duplicate`);
    assert.deepEqual(lib, want, `${labels}: the library`);
    assert.deepEqual(sqlTags(rows), want, `${labels}: the SQL rule`);
  }
});
