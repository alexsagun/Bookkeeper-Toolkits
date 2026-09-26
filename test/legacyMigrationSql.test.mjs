// test/legacyMigrationSql.test.mjs — the #67 migration, read as text (no database needed).
//
// Every assertion runs against the dated file AND its bootstrap fold (§54): the dated file
// is what an existing database runs, the fold is what a fresh install gets, and the fold is
// spliced by hand. Copied function bodies are line-diffed against their sources, because a
// restated body that silently drops a line is the #33/#34 failure this repo keeps recording.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import {
  ACTIVATION_FUNCTION_MAX_SECONDS, ACTIVATION_STATES, GRACE_DAYS, INVITE_STATES, MAX_ACTIVATION_RUN,
  STALE_CLAIM_MINUTES, VALIDATION_STATUSES, legacyRecordKeyInput,
} from '../src/lib/legacyMigration.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const DATED = 'db/2026-09-25-legacy-student-migration.sql';
const BOOT = 'db/000_full_database_bootstrap.sql';
const FOLD_BANNER = '-- §54) FOLDED VERBATIM — 2026-09-25-legacy-student-migration.sql';

const dated = read(DATED);
const boot = read(BOOT);
const foldAt = boot.indexOf(FOLD_BANNER);
const fold = foldAt >= 0 ? boot.slice(foldAt) : '';
const FILES = [[DATED, dated], ['§54 fold', fold]];

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

const SERVICE_ONLY = [
  'legacy_import_require(uuid)', 'legacy_import_log(uuid,uuid,uuid,text,text,jsonb)',
  'legacy_import_safe_date(text)', 'legacy_import_record_key(text,text,text,text)',
  'legacy_import_term(date,date)', 'legacy_import_preview_allocation(text,integer)',
  'legacy_import_grant_closed_start_run(uuid,text,uuid,integer,text,uuid,text,uuid,uuid,timestamptz,uuid,boolean)',
  'legacy_import_stage(uuid,jsonb,jsonb)', 'legacy_import_find_auth_user(uuid,text)',
  'legacy_import_preflight(uuid,uuid,uuid[])', 'legacy_import_start_run(uuid,uuid,uuid[],text,text)',
  'legacy_import_claim_rows(uuid,uuid,text,integer,boolean,uuid[])', 'legacy_import_bind_user(uuid,uuid,uuid,uuid,boolean)',
  'legacy_import_activate_row(uuid,uuid,uuid)', 'legacy_import_mark_failed(uuid,uuid,uuid,text)',
  'legacy_import_begin_invite(uuid,uuid,boolean)', 'legacy_import_record_delivery(uuid,uuid,integer,text,text)',
  'legacy_import_pending_invites(uuid,uuid,integer)', 'legacy_import_release_run(uuid,uuid,text,boolean)',
  'legacy_import_fail_stale_claims(uuid,uuid,uuid[])', 'activate_due_scheduled_subscriptions(uuid,uuid)',
  // Service-only on purpose: a student must not be able to record their own notice outcome.
  'legacy_import_onboarding_notice(uuid,text)',
];
const CLIENT = [
  'legacy_import_jobs_list()', 'legacy_import_job_summary(uuid)',
  'legacy_import_rows_page(uuid,text,text,text,integer,integer)', 'legacy_import_ready_ids(uuid,text,text,text)',
  'legacy_import_events(uuid,uuid)', 'legacy_import_set_eligibility(uuid[],boolean,text)',
  'legacy_import_revert(uuid,text)', 'legacy_import_discard_job(uuid,text)', 'legacy_import_purge_raw(uuid)',
  'admin_activate_due_memberships()', 'activate_my_due_membership()',
  'legacy_import_set_terms(uuid[],text,uuid,date,date,text)',
  'complete_import_onboarding(text)', 'my_migration_summary()',
];
const IMPORT_TABLES = ['student_import_jobs', 'student_import_rows', 'student_import_events',
  'student_import_activation_runs', 'student_external_accounts'];
const NEW_CODES = ['MEMBERSHIP_SCHEDULED_CONFLICT', 'ACCESS_REQUEST_IMPORT_TARGET', 'LEGACY_JOB_NOT_FOUND',
  'LEGACY_JOB_BUSY', 'LEGACY_STAGE_INVALID', 'LEGACY_ROW_NOT_READY', 'LEGACY_CONFIRMATION_MISMATCH',
  'LEGACY_RUN_NOT_FOUND', 'LEGACY_RUN_BUSY', 'LEGACY_IDENTITY_MISMATCH', 'LEGACY_REVERT_REFUSED',
  'LEGACY_JOB_SETTINGS_DIFFER', 'LEGACY_TERMS_INVALID'];

test('the bootstrap carries §54, spliced after §53', () => {
  assert.ok(foldAt > 0, '§54 is missing from the bootstrap');
  assert.ok(boot.indexOf('-- §53) FOLDED VERBATIM') < foldAt, '§54 must come after §53');
  assert.ok(!/\ndo \$pre\$/.test(fold), 'the fold drops the preflight, as every fold does');
  assert.ok(fold.includes("('2026-09-25-legacy-student-migration.sql', null,"), 'the fold keeps the schema_migrations row');
});

for (const [name, sql] of FILES) {
  const exe = code(sql);

  test(`${name}: service-only functions are unreachable from every client role`, () => {
    for (const sig of SERVICE_ONLY) {
      assert.ok(sql.includes(`'public.${sig}'`), `${sig} is not in the service-only grant list`);
    }
    assert.match(exe, /execute format\('revoke all on function %s from public, anon, authenticated', f\);\s*execute format\('grant execute on function %s to service_role', f\);/);
  });

  test(`${name}: the Super Admin RPCs are callable by authenticated and never by anon`, () => {
    for (const sig of CLIENT) assert.ok(sql.includes(`'public.${sig}'`), `${sig} is not in the client grant list`);
    assert.match(exe, /execute format\('revoke all on function %s from public, anon', f\);\s*execute format\('grant execute on function %s to authenticated', f\);/);
  });

  test(`${name}: every service-only function re-checks the actor it was handed`, () => {
    for (const fn of ['legacy_import_stage', 'legacy_import_find_auth_user', 'legacy_import_preflight',
      'legacy_import_start_run', 'legacy_import_claim_rows', 'legacy_import_bind_user', 'legacy_import_activate_row',
      'legacy_import_mark_failed', 'legacy_import_begin_invite', 'legacy_import_record_delivery',
      'legacy_import_pending_invites', 'legacy_import_release_run']) {
      const b = body(sql, fn);
      assert.ok(b, `${fn} is not defined`);
      assert.ok(b.includes('perform public.legacy_import_require(p_actor);'), `${fn} must verify p_actor — auth.uid() is NULL under the service role`);
    }
  });

  test(`${name}: every Super Admin RPC checks the caller's own permission`, () => {
    for (const fn of ['legacy_import_jobs_list', 'legacy_import_job_summary', 'legacy_import_rows_page',
      'legacy_import_ready_ids', 'legacy_import_events', 'admin_activate_due_memberships']) {
      assert.ok(body(sql, fn).includes('perform public.legacy_import_require(auth.uid());'), fn);
    }
    for (const fn of ['legacy_import_set_eligibility', 'legacy_import_revert', 'legacy_import_discard_job', 'legacy_import_purge_raw',
      'legacy_import_set_terms']) {
      const b = body(sql, fn);
      assert.ok(b.includes('v_actor  uuid := auth.uid();') || b.includes('v_actor   uuid := auth.uid();') || b.includes('v_actor uuid := auth.uid();'), `${fn} must act as auth.uid()`);
      assert.ok(b.includes('perform public.legacy_import_require(v_actor);'), fn);
    }
    assert.ok(body(sql, 'legacy_import_require').includes(
      "if p_actor is null or not public.user_has_staff_permission(p_actor, 'students.legacy_migrate') then"));
  });

  test(`${name}: the import tables keep one read policy each and lose every client write`, () => {
    for (const old of ['student_import_jobs_admin_all', 'student_import_rows_admin_all',
      'student_external_accounts_admin_all', 'student_import_events_admin_select', 'student_import_events_admin_insert']) {
      assert.ok(exe.includes(`drop policy if exists ${old}`), `${old} must be dropped`);
    }
    for (const t of IMPORT_TABLES) assert.ok(sql.includes(`'${t}'`), `${t} is not in the read-policy loop`);
    assert.match(exe, /for select to authenticated '\s*'using \(\(select public\.has_staff_permission\(''students\.legacy_migrate''\)\)\)'/);
    assert.match(exe, /revoke insert, update, delete, truncate on table public\.%I from anon, authenticated/);
    assert.ok(!/create policy [^\n]* on public\.student_(import|external)[^\n]*for (insert|update|delete|all)/i.test(exe),
      'no write policy may appear on an import table');
  });

  test(`${name}: the audit trail is append-only but survives an Auth user deletion`, () => {
    const b = body(sql, 'student_import_events_guard').join('\n');
    assert.match(b, /new\.actor\s+is not distinct from old\.actor\s+or new\.actor\s+is null/);
    assert.match(b, /new\.job_id is not distinct from old\.job_id or new\.job_id is null/);
    assert.match(exe, /before update or delete on public\.student_import_events/);
  });

  test(`${name}: a scheduled term is its own status, import-only, one per member, with a named guard`, () => {
    assert.match(exe, /check \(status in \('active', 'cancelled', 'expired', 'scheduled'\)\) not valid;/);
    assert.match(exe, /validate constraint subscriptions_status_check;/);
    assert.match(exe, /do \$chk\$\nbegin\n  alter table public\.subscriptions drop constraint if exists subscriptions_status_check;\n  alter table public\.subscriptions add constraint subscriptions_status_check/,
      'the drop and the re-add must be ONE statement, or a failed re-add leaves no CHECK at all');
    assert.match(exe, /or \(grant_source = 'import' and source_import_row_id is not null and ends_at is not null\)\) not valid;/);
    assert.match(exe, /create unique index if not exists subscriptions_one_live_or_scheduled\s+on public\.subscriptions \(user_id\) where status in \('active', 'scheduled'\);/);
    assert.match(exe, /before insert or update of status on public\.subscriptions/);
    assert.ok(body(sql, 'subscriptions_scheduled_guard').join('\n').includes("MEMBERSHIP_SCHEDULED_CONFLICT"));
  });

  test(`${name}: the sweep is cron-scheduled every 15 minutes and has no JWT guard`, () => {
    assert.match(exe, /perform cron\.schedule\('activate-due-scheduled-subscriptions', '\*\/15 \* \* \* \*',/);
    const b = body(sql, 'activate_due_scheduled_subscriptions').join('\n');
    assert.ok(!/legacy_import_require|has_staff_permission|is_admin/.test(b), 'pg_cron has no JWT; a guard would stop it ever running');
    assert.match(b, /where s\.status = 'scheduled' and s\.started_at <= now\(\)/);
    assert.match(b, /for update skip locked/);
    const self = body(sql, 'activate_my_due_membership').join('\n');
    assert.match(self, /return public\.activate_due_scheduled_subscriptions\(auth\.uid\(\), auth\.uid\(\)\);/,
      'the self-heal touches only the caller');
    // A manual "Open due memberships now" is attributed; only the cron sweep has no actor.
    const adm = body(sql, 'admin_activate_due_memberships').join('\n');
    assert.match(adm, /return public\.activate_due_scheduled_subscriptions\(null, auth\.uid\(\)\);/);
    assert.ok(!/legacy_import_log\([^)]*, null, '/.test(b), 'every sweep event carries p_actor');
  });

  test(`${name}: one activation is one transaction with every refusal first`, () => {
    const b = body(sql, 'legacy_import_activate_row').join('\n');
    for (const refusal of ["'profile_rejected'", "'staff_account'", "'membership_conflict'", "'term_ended'",
      "'identity_mismatch'", "'batch_archived'", "'external_id_conflict'", "'payment_not_paid'"]) {
      assert.ok(b.includes(refusal), `activation must refuse ${refusal}`);
    }
    const blockAt = b.indexOf('if v_block is not null then');
    const insertAt = b.indexOf('insert into public.subscriptions');
    assert.ok(blockAt > 0 && insertAt > blockAt, 'every refusal is decided before anything is written');
    assert.ok(b.indexOf('public.grant_batch_run(') > insertAt, 'the cohort run follows the term');
    assert.ok(b.includes('public.plan_eligible_batch_count(v_plan.key)'), 'run length from the live plan, not arithmetic');
    assert.ok(b.includes("'import', v_sub_id, v_plan.key, null,"), 'grant_reason import, sourced to the subscription');
    assert.ok(b.includes('p_row_id, v_grace, p_actor, false);'), 'valid_until = grace, attributed to the actor, capacity-exempt');
    assert.ok(b.includes("approval_status = case when p.approval_status = 'pending' then 'approved' else p.approval_status end"),
      'a pending profile is approved; a rejected one never reaches this line');
    assert.ok(b.includes("perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'activated', v_status,"),
      'the audit event is written in the same transaction');
    assert.ok(!/insert into public\.(enrollment_requests|finance_)/.test(b), 'no fake request and no finance posting');
  });

  test(`${name}: nothing in #67 creates an enrollment request or posts to finance`, () => {
    assert.ok(!/insert into public\.(enrollment_requests|finance_[a-z_]+)/.test(exe));
  });

  test(`${name}: an activation run takes only READY or FAILED rows and the exact typed phrase`, () => {
    const b = body(sql, 'legacy_import_start_run').join('\n');
    assert.match(b, /sr\.activation_state in \('ready', 'failed'\)\);/);
    const pick = b.slice(b.indexOf('select coalesce(array_agg(x)'), b.indexOf('if cardinality(v_bad) > 0'));
    assert.ok(!/inactive|blocked/.test(pick), 'an inactive or blocked row can never ride along');
    // A retried row starts again from zero attempts, once the run exists, and it is audited.
    const requeueAt = b.indexOf("set activation_state = 'ready', attempts = 0");
    assert.ok(requeueAt > b.indexOf('insert into public.student_import_activation_runs'));
    assert.ok(b.includes("'row_requeued'"), 'the re-queue is logged');
    assert.match(b, /'ACTIVATE ' \|\| cardinality\(v_ids\)/);
    assert.match(b, /cardinality\(v_ids\) not between 1 and 200/);
    assert.match(exe, /row_ids\s+uuid\[\] not null check \(cardinality\(row_ids\) between 1 and 200\)/);
    assert.equal(MAX_ACTIVATION_RUN, 200);
  });

  test(`${name}: claims are row-locked, lease-guarded and reclaimable only once stale`, () => {
    const b = body(sql, 'legacy_import_claim_rows').join('\n');
    assert.match(b, /for update skip locked/);
    assert.match(b, new RegExp(`activation_claimed_at < now\\(\\) - interval '${STALE_CLAIM_MINUTES} minutes'`));
    assert.match(b, /LEGACY_RUN_BUSY/);
    assert.match(b, /not \(sr\.id = any \(coalesce\(p_exclude, '\{\}'::uuid\[\]\)\)\)/);
  });

  // A roster staged again with a CORRECTED date format or mapping must never hand back the
  // job staged with the wrong one: the fingerprint covers the cells, not how they were read,
  // and 11/10 misread as 10/11 still lands inside the batch window, so nothing downstream
  // would notice. The settings are compared, and a difference refuses.
  test(`${name}: re-staging the same rows with different settings is refused, not reopened`, () => {
    const b = body(sql, 'legacy_import_stage').join('\n');
    const reopenAt = b.indexOf("return jsonb_build_object('ok', true, 'job_id', v_existing, 'reopened', true);");
    const diffAt = b.indexOf('LEGACY_JOB_SETTINGS_DIFFER');
    assert.ok(diffAt > 0 && reopenAt > diffAt, 'the comparison must come before the reopen');
    for (const k of ['date_format', 'column_mapping', 'plan_mapping', 'batch_mapping', 'eligible_batch_codes']) {
      assert.ok(b.includes(`('${k}',`), `${k} is not compared`);
    }
    // One staging at a time across EVERY roster: two different files holding the same student
    // could otherwise stage concurrently, neither seeing the other's rows.
    assert.match(b, /pg_advisory_xact_lock\(hashtextextended\('legacy_import_stage', 0\)\)/);
  });

  // A pre-existing account — a real student's own unconfirmed signup, an unaccepted staff
  // invitee — is marked as an import only by a SUCCESSFUL activation. Marking it at bind
  // time, ahead of activate_row's refusals, hid a refused account from Access Requests with
  // nothing able to release it.
  test(`${name}: only an account this import created is marked before the grant`, () => {
    const bind = body(sql, 'legacy_import_bind_user').join('\n');
    assert.match(bind, /if v_created and not v_confirmed then/);
    assert.match(bind, /raw_app_meta_data->>'legacy_import_row_id'\)\s*=\s*p_row_id::text/,
      'a createUser that timed out yet succeeded is still recognised as ours');
    const act = body(sql, 'legacy_import_activate_row').join('\n');
    assert.match(act, /account_origin = case when v_row\.existing_confirmed then p\.account_origin else 'import' end/);
    assert.ok(act.indexOf('account_origin = case') > act.indexOf('if v_block is not null then'),
      'the profile is marked only after every refusal has passed');
  });

  // A row still `activating` after longer than any request can live was granted nothing — its
  // grant is one transaction. Left alone it blocked Discard for ever, with Resume the only exit.
  test(`${name}: an abandoned claim becomes a failed row, and never blocks a discard`, () => {
    const b = body(sql, 'legacy_import_fail_stale_claims').join('\n');
    assert.match(b, new RegExp(`activation_claimed_at < now\\(\\) - interval '${STALE_CLAIM_MINUTES} minutes'`));
    assert.match(b, /set activation_state = 'failed', last_error = 'stale_claim'/);
    for (const fn of ['legacy_import_release_run', 'legacy_import_discard_job']) {
      assert.ok(body(sql, fn).join('\n').includes('public.legacy_import_fail_stale_claims('), fn);
    }
    const disc = body(sql, 'legacy_import_discard_job').join('\n');
    assert.ok(disc.indexOf('legacy_import_fail_stale_claims(') < disc.indexOf("activation_state = 'activating'"),
      'stale claims are cleared before the still-running check');
  });

  // Two overlapping rosters both staged `ready` would make the record-key index abort the
  // whole claim with a bare 23505, repeatedly, wedging the run. It blocks the row instead.
  test(`${name}: a purchase another row already holds is blocked at the claim`, () => {
    const b = body(sql, 'legacy_import_claim_rows').join('\n');
    const dupAt = b.indexOf("blocked_reason = 'duplicate_staged'");
    assert.ok(dupAt > 0 && dupAt < b.indexOf('with pick as ('), 'blocked before the claim picks');
    assert.match(b, /o\.activation_state in \('activating', 'activated'\)/);
    assert.match(b, /if v_run\.status = 'completed' then\s*\n?\s*return '\[\]'::jsonb;/,
      'a finished run stays finished — a retry is a NEW run with its own typed confirmation');
  });

  // A run holds its rows against another run while it is running or paused, and a FAILED row
  // is not "remaining" — the same run cannot retry it past the attempt cap. So a paused run
  // whose only leftovers are failures would hold them beyond the reach of every button.
  test(`${name}: a run with nothing left to do is finished, even when pause was asked for`, () => {
    const b = body(sql, 'legacy_import_release_run').join('\n');
    assert.match(b, /when v_remaining = 0 then 'completed'\s*\n?\s*when coalesce\(p_pause, false\) then 'paused'/,
      'remaining = 0 must be tested BEFORE the pause request');
    assert.match(b, /sr\.activation_state in \('ready', 'activating'\)/, 'a failed row is not remaining');
  });

  // ★ THE TERMS THE SUPER ADMIN ASSIGNS ARE THE TERMS THAT ARE GRANTED. Every reader that
  //   decides or shows what an activation grants must take the override, else the roster.
  test(`${name}: activation and the preflight read the effective terms; the email reads the grant`, () => {
    const act = body(sql, 'legacy_import_activate_row').join('\n');
    assert.ok(act.includes('v_sd := coalesce(v_row.activation_start_date, v_row.legacy_start_date);'));
    assert.ok(act.includes('v_ed := coalesce(v_row.activation_end_date, v_row.legacy_end_date);'));
    assert.ok(act.includes('where key = coalesce(v_row.activation_plan_key, v_row.proposed_plan_key);'));
    assert.ok(act.includes('where id = coalesce(v_row.activation_batch_id, v_row.proposed_batch_id);'));
    assert.ok(act.includes('from public.legacy_import_term(v_sd, v_ed) t;'), 'the term is built from the effective dates');
    assert.ok(!/legacy_import_term\(v_row\.legacy_start_date/.test(act), 'never from the roster dates alone');
    const pf = body(sql, 'legacy_import_preflight').join('\n');
    for (const c of ['coalesce(sr.activation_plan_key, sr.proposed_plan_key)  as eff_plan_key',
      'coalesce(sr.activation_start_date, sr.legacy_start_date) as eff_start']) assert.ok(pf.includes(c), c);
    assert.ok(!/r\.legacy_start_date, r\.legacy_end_date\) t/.test(pf), 'the scheduled count uses effective dates');
    // The invitation quotes the membership the row GRANTED (an extension moves its expiry; a
    // non-VIP plan holds no batch), and falls back to the row only when there is none.
    const inv = body(sql, 'legacy_import_begin_invite').join('\n');
    assert.ok(inv.includes('select * into v_sub from public.subscriptions where id = v_row.subscription_id;'));
    assert.ok(inv.includes("'end_date', case when v_sub.id is not null then to_jsonb(v_sub.ends_at)"));
    assert.ok(inv.includes('then (select b.name from public.batches b where b.id = v_sub.batch_id)'));
    assert.ok(inv.includes('else to_jsonb(coalesce(v_row.activation_end_date, v_row.legacy_end_date)) end);'));
    assert.ok(!/::text/.test(inv), 'no timestamp as text: its format would follow the session DateStyle');
    // ★ The dialog confirms exactly what the start will accept.
    assert.ok(pf.includes("'row_ids', (select coalesce(jsonb_agg(r.id order by r.source_row_number), '[]'::jsonb) from ready r),"));
    assert.ok(/where ru\.job_id = p_job_id and ru\.status in \('running', 'paused'\)\s+and a\.id = any \(ru\.row_ids\)\)/.test(pf),
      'a row held by an unfinished run is not counted as activatable — the start would refuse the whole run');
    // The roster's own columns are never overwritten — they are the record of the purchase.
    assert.ok(!/set[^;]*legacy_start_date\s*=/.test(code(sql).replace(/insert into[\s\S]*?values/g, '')),
      'nothing updates legacy_start_date after staging');
  });

  test(`${name}: assigning terms is audited, validated and all-or-nothing`, () => {
    const b = body(sql, 'legacy_import_set_terms').join('\n');
    assert.ok(b.includes('perform public.legacy_import_require(v_actor);'));
    assert.ok(b.includes("if r.activation_state not in ('ready', 'inactive', 'failed') then"), 'an activated membership is changed in Enrollments');
    for (const refusal of ['That plan is not an active plan.', 'That batch does not exist or is archived.',
      'A membership must end on or after the day it starts.', 'Those dates end a membership that has already finished.',
      'A VIP membership needs a batch.']) assert.ok(b.includes(refusal), refusal);
    assert.ok(b.includes("'LEGACY_TERMS_INVALID'"));
    assert.ok(b.includes("perform public.legacy_import_log(r.job_id, r.id, v_actor, 'terms_set', 'assigned',"));
    assert.ok(b.includes("'before', jsonb_build_object(") && b.includes("'after', jsonb_build_object("));
    assert.ok(b.includes('case when v_sd is not distinct from sr.legacy_start_date then null else v_sd end'),
      'an override equal to the roster is stored as null, so "assigned" means changed');
    // A row inside an unfinished run was confirmed with its old terms.
    assert.ok(/ru\.status in \('running', 'paused'\) and r\.id = any \(ru\.row_ids\)\) then\s+perform public\.app_error\('LEGACY_RUN_BUSY'/.test(b),
      'terms cannot change under a typed confirmation');
    // No change, no audit entry: a retried dialog cannot record the same assignment twice.
    assert.ok(b.includes('and v_ed is not distinct from coalesce(r.activation_end_date, r.legacy_end_date) then\ncontinue;'));
  });

  // ★ THE ONBOARDING EMAILS RING ONCE, AND ONLY THE SERVER RECORDS THAT THEY DID. The
  //   function is service-only (the SERVICE_ONLY list above pins the grant): when it was the
  //   student's own RPC, a student could record 'sent' so the admin was never told, or loop
  //   reserve → 'failed' into the append-only event log.
  test(`${name}: the onboarding notice is service-only, reserved once, final once sent, capped at five`, () => {
    assert.match(exe, /drop function if exists public\.legacy_import_onboarding_notice\(text\);/,
      'the client-callable form is dropped, not left beside the new one');
    const b = body(sql, 'legacy_import_onboarding_notice').join('\n');
    assert.ok(b.includes('v_uid  uuid := p_user;'), 'the uid the endpoint verified');
    assert.ok(!/auth\.uid\(\)/.test(b), 'never auth.uid(): a service-role caller has none');
    assert.ok(b.includes("where sr.target_user_id = v_uid and sr.activation_state = 'activated' and not sr.existing_confirmed"));
    assert.ok(b.includes("if v_prof.onboarding_status is distinct from 'completed' then"), 'only after the password is set');
    assert.ok(b.includes("if v_row.onboarding_notice_state = 'sent' then"), 'sent is final');
    assert.ok(b.includes("where id = v_row.id and onboarding_notice_state = 'sending';"), 'only a reserved send records');
    assert.ok(b.includes('if v_row.onboarding_notice_attempts >= 5 then'), 'five reservations at most');
    assert.ok(b.includes('onboarding_notice_attempts = onboarding_notice_attempts + 1'), 'each reservation counts');
    assert.match(exe, /and onboarding_notice_attempts between 0 and 5\);/, 'and the table says so too');
  });

  test(`${name}: onboarding takes the student's name once, and the summary is their own`, () => {
    assert.match(exe, /drop function if exists public\.complete_import_onboarding\(\);/,
      'the no-argument form is REPLACED, never overloaded — two forms make the old call ambiguous');
    const c = body(sql, 'complete_import_onboarding').join('\n');
    assert.ok(c.includes('full_name = coalesce(v_name, full_name),'));
    assert.ok(c.includes("where id = auth.uid()") && c.includes("and onboarding_status <> 'completed';"),
      'own row only, and only while onboarding — later name changes go through support');
    const s = body(sql, 'my_migration_summary').join('\n');
    assert.ok(s.includes('where p.id = auth.uid()'));
  });

  test(`${name}: a phone is stored and warned on, never used to link an account`, () => {
    const st = body(sql, 'legacy_import_stage').join('\n');
    assert.ok(st.includes("set warnings = sr.warnings || '[\"phone_shared\"]'::jsonb"), 'a warning, not an error');
    assert.ok(!/phone[^\n]*errors/.test(st), 'a shared phone never blocks a row');
    for (const fn of ['legacy_import_find_auth_user', 'legacy_import_bind_user', 'legacy_import_activate_row']) {
      assert.ok(!/phone/.test(body(sql, fn).join('\n')), `${fn} must not match on phone`);
    }
  });

  test(`${name}: one legacy purchase can be activated once, across every job`, () => {
    assert.match(exe, /create unique index if not exists student_import_rows_record_key_live\s+on public\.student_import_rows \(legacy_record_key\)\s+where activation_state in \('activating', 'activated'\);/);
    assert.match(exe, /create unique index if not exists student_import_jobs_content_uniq/);
  });

  test(`${name}: the row vocabularies match the JS library`, () => {
    for (const v of VALIDATION_STATUSES) assert.ok(exe.includes(`'${v}'`), v);
    const vocab = exe.slice(exe.indexOf('student_import_rows_v2_vocab check ('), exe.indexOf('student_import_rows_v2_values'));
    for (const v of ACTIVATION_STATES) assert.ok(vocab.includes(`'${v}'`), `activation state ${v} missing from the CHECK`);
    for (const v of INVITE_STATES) assert.ok(vocab.includes(`'${v}'`), `invite state ${v} missing from the CHECK`);
  });

  test(`${name}: the record key and the term are the ones the JS mirror computes`, () => {
    const key = body(sql, 'legacy_import_record_key').join(' ');
    assert.match(key, /'thinkific\|'/);
    assert.match(key, /then 'ext:' \|\| btrim\(p_external\)/);
    assert.match(key, /else 'email:' \|\| p_email end/);
    assert.match(key, /'\|' \|\| p_plan \|\| '\|' \|\| p_batch_code/);
    assert.equal(legacyRecordKeyInput({ externalId: '', email: 'a@b.test', planKey: 'vip', batchCode: '2026-10' }),
      'thinkific|email:a@b.test|vip|2026-10');
    const term = body(sql, 'legacy_import_term').join(' ');
    assert.match(term, /p_start::timestamp at time zone 'Asia\/Manila'/);
    assert.match(term, /\(\(p_end \+ 1\)::timestamp at time zone 'Asia\/Manila'\) - interval '1 millisecond'/);
    assert.ok(term.includes(`interval '${GRACE_DAYS} days'`));
  });

  test(`${name}: the closed-start run is grant_batch_run with exactly two edits`, () => {
    const src = body(read('db/2026-08-17-three-plan-catalog.sql'), 'grant_batch_run');
    const mine = body(sql, 'legacy_import_grant_closed_start_run');
    assert.ok(src && mine);
    const removed = src.filter((l) => !mine.includes(l));
    const added = mine.filter((l) => !src.includes(l));
    assert.deepEqual(removed, [
      "if v_start.status <> 'open'",
      'and not exists (select 1 from public.batch_entitlements e',
      'where e.user_id = p_user_id and e.batch_id = v_start.id',
      "and e.status in ('queued', 'active')) then",
      "perform public.app_error('BATCH_CLOSED',",
      "format('batch %s is closed to new assignments', v_start.code), 409,",
      "and b.status = 'open'",
    ], 'only the closed-start refusal and the open-only filter may go');
    assert.deepEqual(added, ["and b.status in ('open', 'closed')   -- #67 EDIT 2 of 2: closed cohorts were sold too"]);
    assert.ok(mine.includes("if v_start.status = 'archived' then"), 'the archived refusal stays');
  });

  test(`${name}: the access-request trio adds one import predicate and changes nothing else`, () => {
    const s50 = read('db/2026-08-30-staff-activation-consistency.sql');
    const s51 = read('db/2026-08-31-access-request-staff-target.sql');
    for (const [fn, src] of [['admin_access_request_queue', s50], ['admin_access_request_pending_count', s50],
      ['admin_review_access_request', s51]]) {
      const was = body(src, fn);
      const now = body(sql, fn);
      const removed = was.filter((l) => !now.includes(l));
      assert.deepEqual(removed, [], `${fn} dropped lines from its live body`);
      const added = now.filter((l) => !was.includes(l));
      if (fn === 'admin_review_access_request') {
        assert.ok(added.some((l) => l.includes('ACCESS_REQUEST_IMPORT_TARGET')));
        assert.ok(!added.some((l) => /is_super_admin/.test(l)), 'no Super Admin exemption — the #51 rule');
        assert.ok(now.indexOf("perform public.app_error('ACCESS_REQUEST_IMPORT_TARGET',") < now.indexOf('update public.profiles'),
          'refused before the profile is written');
      } else {
        assert.deepEqual(added, ["and not (p.account_origin = 'import' and p.approval_status = 'pending')"], fn);
      }
    }
  });

  test(`${name}: the catalog adds the thirteen migration codes and keeps every other`, () => {
    const cat = body(sql, 'app_error_catalog').join('\n');
    const codes = cat.match(/\('[A-Z_]+',/g) || [];
    assert.equal(codes.length, 132);
    for (const c of NEW_CODES) assert.ok(cat.includes(`('${c}',`), `${c} missing`);
    for (const c of APP_ERROR_CODES) {
      if (c === 'MIGRATION_MISSING') continue;
      assert.ok(cat.includes(`('${c}',`), `${c} was dropped from the catalog`);
    }
  });

  test(`${name}: students.import is deleted only after its policies are gone`, () => {
    const dropAt = exe.indexOf('drop policy if exists student_import_jobs_admin_all');
    const delAt = exe.indexOf("delete from public.staff_permissions where key = 'students.import';");
    assert.ok(dropAt > 0 && delAt > dropAt);
    assert.ok(exe.includes("delete from public.staff_role_permissions where permission_key = 'students.import';"));
  });

  test(`${name}: the v1 cleanup touches only jobs that never granted anything`, () => {
    const cleanup = exe.slice(exe.indexOf('do $v1$'), exe.indexOf('$v1$;', exe.indexOf('do $v1$') + 6));
    assert.match(cleanup, /where sj\.pipeline = 'v1'/);
    assert.match(cleanup, /r\.target_user_id is not null or r\.auth_user_created or r\.subscription_granted/);
    assert.ok(!/delete from/.test(cleanup), 'discard and purge, never delete');
  });
}

test('every error code #67 adds has client copy', () => {
  for (const c of NEW_CODES) {
    assert.ok(APP_ERROR_CODES.includes(c), `${c} missing from APP_ERROR_CODES`);
    assert.ok(APP_ERROR_COPY[c] && APP_ERROR_COPY[c].length > 30, `${c} needs copy that names the next action`);
  }
});

// ★ The `scheduled` design rests on one claim: every predicate that decides whether a
//   subscription is LIVE also requires status = 'active'. This scans the LATEST definition
//   of every function in the dated migrations and fails if one checks the dates without
//   the status — which is exactly the edit that would let a scheduled term through.
test('every live-subscription predicate still requires status = active', () => {
  const files = readdirSync(join(REPO, 'db')).filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.sql$/.test(f)).sort();
  const latest = new Map();
  for (const f of files) {
    const sql = read(`db/${f}`);
    for (const m of sql.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)) {
      const b = body(sql.slice(0, m.index) + sql.slice(m.index), m[1]);
      if (b) latest.set(m[1], { file: f, body: b.join('\n') });
    }
  }
  const LIVE = /coalesce\(\s*[a-z0-9_]*\.?grace_ends_at\s*,\s*[a-z0-9_]*\.?ends_at\s*\)\s*>\s*now\(\)/i;
  let checked = 0;
  for (const [fn, { file, body: b }] of latest) {
    if (!LIVE.test(b) || !/subscriptions/.test(b)) continue;
    checked += 1;
    assert.ok(/status\s*=\s*'active'|status\s+in\s*\(\s*'active'/.test(b),
      `${fn} (${file}) treats a subscription as live by its dates alone — a scheduled term would pass it`);
  }
  assert.ok(checked >= 10, `expected to check the membership predicates, found ${checked}`);
});

test('the endpoint is gated on the new permission before the service client exists', () => {
  const api = read('api/admin/student-imports.js');
  const gateAt = api.indexOf("const gate = await requireStaff(req, { permission: PERMISSION });");
  const svcAt = api.indexOf('const admin = service();');
  assert.ok(api.includes("const PERMISSION = 'students.legacy_migrate';"));
  assert.ok(gateAt > 0 && svcAt > gateAt, 'requireStaff must run before service()');
  assert.ok(!/\.from\('student_import|\.from\('subscriptions'\)|\.from\([^)]*\)\s*\.(insert|update|delete|upsert)\(/.test(api),
    'the endpoint writes nothing directly; every write is a SECURITY DEFINER function');
});

test('the stale-claim window outlives the function that holds the claim', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const max = vercel.functions['api/admin/student-imports.js']?.maxDuration;
  assert.equal(max, ACTIVATION_FUNCTION_MAX_SECONDS);
  assert.ok(STALE_CLAIM_MINUTES * 60 > max, 'a live request could otherwise have its row re-claimed mid-activation');
});
