// test/communicationsSql.test.mjs — Communications (#61): the SQL contract, the send
// endpoints, and the client wiring. Reads files as TEXT (plus three pure imports); no database.
//
// The live behaviour — who is refused, the daily cap, dedupe, born-paused rules, the
// attempt limit, cancel/pause stopping in-flight rows, backoff — was probed against the
// production catalog in a rolled-back transaction before this migration was applied. This
// suite pins the SHAPE that probe relied on, so a later edit cannot quietly undo it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import { ADMIN_TAB_PERMISSION, ROLE_PERMISSIONS } from '../src/lib/staffRoles.js';
import { cronAuthorized, cronSecretUsable } from '../api/cron/communications.js';
import { buildDeliveryEmail, processQueue } from '../api/_lib/commSend.js';
import { sendEmail } from '../api/_lib/email.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-16-communications.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';

/** Executable SQL only — comments explain invariants and must not satisfy or fail a scan. */
/** Executable JS only, for the same reason: a comment that NAMES service() is not a call to it. */
const jsCode = (src) => src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

/** The §48 fold, bounded at the next banner (never to EOF). */
function foldSection() {
  const boot = read(BOOTSTRAP);
  const at = boot.indexOf('§48) FOLDED VERBATIM');
  assert.ok(at > 0, '§48 is missing from the bootstrap — re-fold db/2026-09-16-communications.sql');
  const next = boot.indexOf('FOLDED VERBATIM', at + 30);
  return boot.slice(at, next > 0 ? next : undefined);
}

const TABLES = ['comm_settings', 'comm_automation_rules', 'comm_campaigns', 'comm_deliveries'];
const SERVICE_ONLY = ['comm_claim_deliveries', 'comm_begin_send', 'comm_record_delivery', 'comm_enqueue_automations'];
const INTERNAL = ['comm_used_today', 'comm_program_root', 'comm_current_members', 'comm_member_vars', 'comm_audience_rows',
  'comm_resolve_audience', 'comm_validate_rule', 'comm_rule_matches', 'comm_rules_born_paused'];

const bodyOf = (sql, name) =>
  new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$fn\\$;`).exec(sql)?.[0];

for (const [label, sqlOf] of [[MIGRATION, () => codeOf(read(MIGRATION))], ['bootstrap §48', () => codeOf(foldSection())]]) {
  test(`${label}: four comm tables, RLS on, default grants revoked`, () => {
    const s = sqlOf();
    for (const t of TABLES) {
      assert.ok(s.includes(`create table if not exists public.${t} (`), `${t} is not created`);
      assert.ok(s.includes(`alter table public.${t} enable row level security`), `${t} has no RLS`);
      assert.ok(s.includes(`revoke all on table public.${t} from public, anon, authenticated`), `${t} keeps its default grants`);
    }
  });

  test(`${label}: exactly one policy loop, SELECT only, gated on communications.send`, () => {
    const s = sqlOf();
    const loops = [...s.matchAll(/do \$pol\$([\s\S]*?)\$pol\$;/g)].map((m) => m[1]);
    assert.equal(loops.length, 1, 'one policy loop');
    const loop = loops[0];
    for (const t of TABLES) assert.ok(loop.includes(`'${t}'`), `${t} is missing from the policy loop`);
    assert.ok(/for select to authenticated/.test(loop), 'the single policy must be a SELECT');
    assert.ok(!/\bfor\s+(all|insert|update|delete)\b/i.test(loop), 'a write policy is a raw PostgREST write path');
    assert.ok(/has_staff_permission\(''communications\.send''\)/.test(loop), 'the policy must be gated on communications.send');
    assert.ok(!/create policy [\s\S]{0,80}on public\.comm_/i.test(s.replace(loop, '')), 'no other comm_ policy may exist');
  });

  test(`${label}: payment-reminder rows need finance.manage to READ — in the policy and in every reader`, () => {
    const s = sqlOf();
    const loop = /do \$pol\$([\s\S]*?)\$pol\$;/.exec(s)?.[1] || '';
    assert.ok(/if t in \('comm_campaigns', 'comm_deliveries'\) then\s+v_using := v_using \|\| ' and \(kind <> ''payment_reminder'' or \(select public\.has_staff_permission\(''finance\.manage''\)\)\)';/.test(loop),
      'the SELECT policy on campaigns and deliveries must hide payment reminders from a sender without finance.manage');
    for (const name of ['comm_campaigns_list', 'comm_delivery_log', 'comm_delivery_summary', 'comm_request_email_status']) {
      const body = bodyOf(s, name) || '';
      assert.ok(/v_fin := public\.has_staff_permission\('finance\.manage'\)/.test(body), `${name} does not compute v_fin`);
      assert.ok(/kind <> 'payment_reminder' or v_fin/.test(body), `${name} returns payment reminders to a sender without finance.manage`);
    }
    assert.ok((bodyOf(s, 'comm_delivery_summary').match(/kind <> 'payment_reminder' or v_fin/g) || []).length >= 2,
      'both the per-kind and the per-student summaries must filter payment reminders');
  });

  test(`${label}: every client-callable comm function checks communications.send before touching data`, () => {
    const s = sqlOf();
    const granted = [...new Set([...s.matchAll(/grant execute on function public\.(comm_\w+)\([^)]*\) to authenticated/g)].map((m) => m[1]))];
    assert.ok(granted.length >= 14, `expected the comm RPC surface, found ${granted.length}`);
    for (const name of granted) {
      const body = bodyOf(s, name);
      assert.ok(body, `${name} is granted but its body could not be found`);
      assert.ok(/security definer/.test(body), `${name} must be SECURITY DEFINER`);
      const begin = body.search(/\bbegin\b/);
      const guard = body.indexOf("has_staff_permission('communications.send')");
      assert.ok(begin > 0 && guard > begin, `${name} has no communications.send check in its body`);
      assert.ok(!/\b(select|insert|update|delete)\b/i.test(body.slice(begin, guard).replace(/if not public\.$/, '')),
        `${name} touches data before checking the permission`);
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked first`);
    }
  });

  test(`${label}: the service-only functions are never granted to a client role`, () => {
    const s = sqlOf();
    for (const name of SERVICE_ONLY) {
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked`);
      const grants = [...s.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to (\\w+)`, 'g'))].map((m) => m[1]);
      assert.deepEqual(grants, ['service_role'], `${name} may be granted to service_role only, found ${grants.join(', ')}`);
    }
    for (const name of INTERNAL) {
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked`);
      assert.ok(!new RegExp(`grant execute on function public\\.${name}\\(`).test(s), `${name} is internal and must not be granted`);
    }
  });

  test(`${label}: payment reminders also require finance.manage, in every path that writes or resolves one`, () => {
    const s = sqlOf();
    for (const name of ['comm_create_campaign', 'comm_preview_audience', 'comm_retry_failed', 'comm_cancel_campaign', 'comm_audience_rows']) {
      assert.ok(bodyOf(s, name)?.includes("has_staff_permission('finance.manage')"), `${name} does not require finance.manage`);
    }
  });

  test(`${label}: a meeting invitation needs meetings.manage, which nobody holds until #62`, () => {
    const s = sqlOf();
    for (const name of ['comm_create_campaign', 'comm_preview_audience']) {
      assert.ok(/if p_kind = 'meeting_invite' and not public\.has_staff_permission\('meetings\.manage'\) then/.test(bodyOf(s, name) || ''),
        `${name} lets a meeting invitation through without meetings.manage`);
    }
  });

  test(`${label}: a rule is born paused; editing or pausing it drops what it queued`, () => {
    const s = sqlOf();
    assert.ok(/before insert on public\.comm_automation_rules\s+for each row execute function public\.comm_rules_born_paused\(\)/.test(s),
      'the born-paused trigger is missing');
    assert.ok(/new\.status := 'paused'/.test(bodyOf(s, 'comm_rules_born_paused')), 'the trigger must force paused');
    const save = bodyOf(s, 'comm_save_rule');
    const update = /update public\.comm_automation_rules\s+set name = v_name[\s\S]*?where id = p_id;/.exec(save)?.[0] || '';
    assert.ok(/status = 'paused'/.test(update), 'saving an existing rule must pause it');
    assert.ok(/'in_flight', \(select count\(\*\) from public\.comm_deliveries\s+where rule_id = p_id and status = 'sending' and send_started_at is not null\)\)/.test(save),
      'an edit reports rows already cleared to send, as a pause does');
    assert.ok(/last_complete_on = null/.test(update), 'an edited rule must not catch up days matched under its old timing');
    assert.ok(/set status = 'skipped', error_code = 'rule_edited'[\s\S]*?where rule_id = p_id and status = 'queued'/.test(save),
      'rows an edited rule already queued would go out with the NEW text');
    const status = bodyOf(s, 'comm_set_rule_status');
    assert.ok(/if p_status = 'paused' then\s+update public\.comm_deliveries set status = 'skipped', error_code = 'rule_paused'/.test(status),
      'pausing a rule must stop what it already queued');
    assert.ok(/last_complete_on = case when p_status = 'active' and status <> 'active' then null/.test(status),
      'turning a rule on must not wake up and email a week of missed days');
  });

  test(`${label}: deliveries de-duplicate on a unique key, and the enqueue uses it`, () => {
    const s = sqlOf();
    assert.ok(/constraint comm_deliveries_dedupe_key_unique unique \(dedupe_key\)/.test(s));
    assert.ok(/on conflict \(dedupe_key\) do update/.test(bodyOf(s, 'comm_enqueue_automations')));
    assert.ok(/'rule:' \|\| v_rule\.id::text \|\| ':' \|\| v_match\.dedupe_suffix/.test(bodyOf(s, 'comm_enqueue_automations')));
  });

  test(`${label}: staff are never a membership audience, and a term with no end is never matched`, () => {
    const s = sqlOf();
    assert.ok(/sm\.status in \('invited', 'active'\)/.test(bodyOf(s, 'comm_current_members')), 'staff exclusion missing');
    const approved = /if v_mode = 'approved_between' then([\s\S]*?)return;\s+end if;/.exec(bodyOf(s, 'comm_audience_rows'))?.[1] || '';
    assert.ok(/sm\.status in \('invited', 'active'\)/.test(approved), 'an approval-date audience must exclude staff');
    assert.ok(/pr\.approval_status <> 'rejected'/.test(approved), 'an approval-date audience must exclude banned accounts');
    const matches = bodyOf(s, 'comm_rule_matches');
    assert.ok(/where m\.ends_at is not null/.test(matches), 'no-expiry terms must be skipped');
    assert.ok(/\(\(p_on - s\.program_on\) % 7\) < s\.w/.test(matches), 'program_week must fire on 7-day anniversaries (within the catch-up window) only');
    assert.ok(/\(p_on - s\.program_on\) >= 7/.test(matches), 'week 1 is not an anniversary');
  });

  test(`${label}: program weeks count from the FIRST term of a renewal chain`, () => {
    const s = sqlOf();
    const root = bodyOf(s, 'comm_program_root') || '';
    assert.ok(/with recursive chain/.test(root) && /c\.depth < 50/.test(root) && /p\.user_id = c\.user_id/.test(root),
      'the renewal chain walk must be recursive, depth-bounded and single-user');
    assert.ok(/and p\.plan_key = c\.plan_key/.test(root), 'a plan change starts a new program (a VIP is not counted from their Sampler term)');
    assert.ok(/coalesce\(p\.grace_ends_at, p\.ends_at\) >= c\.started_at - interval '1 day'/.test(root),
      'a lapse starts a new program: the parent must still have been running when the child started');
    assert.ok(/left join lateral public\.comm_program_root\(c\.sid\) r on true/.test(bodyOf(s, 'comm_current_members')));
    assert.ok(/s\.program_id::text \|\| ':week:'/.test(bodyOf(s, 'comm_rule_matches')),
      'the week key must be the program, or a renewal re-sends week 1');
  });

  test(`${label}: a missed or capped day is caught up, never lost`, () => {
    const s = sqlOf();
    assert.ok(/p_on date, p_window integer default 1/.test(bodyOf(s, 'comm_rule_matches')));
    assert.ok(/greatest\(1, least\(coalesce\(p_window, 1\), 7\)\) as w/.test(bodyOf(s, 'comm_rule_matches')), 'the window is bounded to a week');
    const enq = bodyOf(s, 'comm_enqueue_automations');
    assert.ok(/v_window := least\(greatest\(v_on - coalesce\(v_rule\.last_complete_on,\s+\(v_rule\.activated_at at time zone 'Asia\/Manila'\)::date - 1,\s+v_on - 1\), 1\), 7\);/.test(enq),
      'a rule that has never completed a run must catch up from the day it was turned on');
    assert.ok(/last_complete_on = case when v_capped = 0 then v_on else last_complete_on end/.test(enq),
      'a capped day must stay incomplete so the next run looks back to it');
    assert.ok(/comm_rule_matches\(p_trigger, v_days, p_scope, v_batch, v_plans, v_on, 1\)/.test(bodyOf(s, 'comm_rule_preview')),
      'the preview shows today only');
  });

  test(`${label}: audiences are addressed to the PROFILE, and dates are YYYY-MM-DD only`, () => {
    const s = sqlOf();
    const rows = bodyOf(s, 'comm_audience_rows');
    assert.ok(!/\br\.email\b/.test(rows), 'enrollment_requests.email is typed by the student and must never address a message');
    assert.ok(rows.includes("~ '^\\d{4}-\\d{2}-\\d{2}$'"), "a bare ::date cast accepts 'infinity' and 'today'");
  });

  test(`${label}: two balances for one student are two reminders`, () => {
    const s = sqlOf();
    assert.ok(/distinct on \(a\.email, case when p_kind = 'payment_reminder' then a\.enrollment_request_id end\)/.test(bodyOf(s, 'comm_resolve_audience')));
    assert.ok(/'campaign:' \|\| v_id::text \|\| ':' \|\| a\.email \|\| coalesce\(':' \|\| a\.enrollment_request_id::text, ''\)/.test(bodyOf(s, 'comm_create_campaign')));
  });

  test(`${label}: a double submit returns the campaign it already made`, () => {
    const s = sqlOf();
    assert.ok(/create unique index if not exists comm_campaigns_client_key_idx\s+on public\.comm_campaigns \(client_key\) where client_key is not null;/.test(s));
    const create = bodyOf(s, 'comm_create_campaign');
    assert.ok(/p_audience jsonb, p_client_key text default null/.test(create));
    const lock = create.indexOf('from public.comm_settings s where s.id for update');
    const dup = create.indexOf('where c.client_key = p_client_key');
    const insert = create.indexOf('insert into public.comm_campaigns');
    assert.ok(lock > 0 && dup > lock && insert > dup, 'the duplicate check must run under the settings lock and before the insert');
    assert.ok(s.includes('grant execute on function public.comm_create_campaign(text, text, text, text, jsonb, text) to authenticated;'));
  });

  test(`${label}: the claim re-checks every row and hands over only rows that may still go out`, () => {
    const s = sqlOf();
    const claim = bodyOf(s, 'comm_claim_deliveries');
    assert.ok(/error_code = case when coalesce\(d\.ambiguous_since, d\.send_started_at\) < now\(\) - interval '20 hours' or d\.attempts >= 3\s+then 'unknown_outcome'/.test(claim),
      'a row whose first unclear attempt is older than the provider idempotency window, or a cleared claim on its last attempt, must not be sent again');
    assert.ok(/ambiguous_since = coalesce\(d\.ambiguous_since, d\.send_started_at\),/.test(claim), 'a released claim that was cleared to send is unclear, and keeps an earlier unclear time');
    assert.ok(/where d\.status = 'sending' and d\.send_started_at is not null and d\.claimed_at < now\(\) - interval '10 minutes';/.test(claim));
    assert.ok(/set status = 'queued', attempts = greatest\(d\.attempts - 1, 0\), claimed_at = null,\s+next_attempt_at = null, updated_at = now\(\)\s+where d\.status = 'sending' and d\.send_started_at is null and d\.claimed_at < now\(\) - interval '10 minutes';/.test(claim),
      'a stale claim never cleared to send reached nobody: back to the queue, attempt refunded, nothing marked unclear');
    assert.ok(/set status = 'sending', claimed_at = now\(\), send_started_at = null,/.test(claim), 'every claim starts uncleared');
    assert.ok(/claimed_rule_version = \(select r\.updated_at from public\.comm_automation_rules r where r\.id = d\.rule_id\),/.test(claim),
      'the claim records the rule version its text and audience were judged under');
    assert.ok(/error_code = case when j\.fresh is null then \(case when j\.edited then 'rule_edited' else 'no_longer_eligible' end\)/.test(claim),
      'a row an edit made ineligible is recorded as dropped by the edit, so the next run can queue the member under the new definition');
    assert.ok(/where d\.status = 'queued' and d\.ambiguous_since < now\(\) - interval '20 hours';/.test(claim),
      'a queued row whose first unclear attempt is 20 hours old must not be sent again, whatever its latest code');
    assert.ok(!/last_attempted_at/.test(s), 'the latest-attempt time let a later rate limit hide an earlier unclear attempt');
    assert.ok(/where d\.id = j\.jid and d\.status = 'queued'/.test(claim),
      'step 3 must re-test the status on the row it updates, or a claim that waited on another can skip a row that one is sending');
    assert.ok(/if p_campaign_id is null then\s+with pending_rules as/.test(claim), 'a campaign-scoped claim must not re-run every rule');
    assert.ok(/email = coalesce\(j\.fresh_email, d\.email\)/.test(claim), 'the address is refreshed from the profile at send time');
    assert.ok(/'no_longer_eligible'/.test(claim), 'automations must be re-checked at send time');
    assert.ok(/cross join lateral public\.comm_rule_matches\(r\.trigger_kind, r\.days, r\.scope, r\.scope_batch_id,\s+r\.scope_plan_keys, \(now\(\) at time zone 'Asia\/Manila'\)::date, 7\) m/.test(claim),
      'an automation must still match its rule at send time — term, end date, batch, packages and timing');
    assert.ok(/vars = coalesce\(j\.fresh, d\.vars\)/.test(claim), 'tag values are refreshed to the day of sending');
    assert.ok(/error_code = 'nothing_due'/.test(claim), 'a paid balance must not be reminded');
    const pick = /with picked as \(([\s\S]*?)for update skip locked/.exec(claim)?.[1] || '';
    assert.ok(/d\.attempts < 3/.test(pick), 'the pick must respect the attempt limit');
    assert.ok(/d\.next_attempt_at is null or d\.next_attempt_at <= now\(\)/.test(pick), 'the pick must respect the retry backoff');
    assert.ok(/r\.status = 'active'/.test(pick), 'the pick must repeat the rule-active condition');
    assert.ok(/c\.cancelled_at is not null/.test(pick), 'the pick must repeat the cancelled condition');
    assert.ok(/retry_generation integer\)/.test(claim) && /c\.retry_generation/.test(claim), 'the claim returns the retry generation');
    assert.ok(/finance_request_collected\(rq\.id\)/.test(claim), 'the balance is recomputed at claim time');
  });

  test(`${label}: only the claiming attempt may record a delivery, and a stopped retry is skipped`, () => {
    const s = sqlOf();
    const rec = bodyOf(s, 'comm_record_delivery');
    assert.ok(/p_id uuid, p_attempt integer, p_ok boolean/.test(rec));
    assert.ok(/where d\.id = p_id and d\.status = 'sending' and d\.attempts = p_attempt/.test(rec));
    assert.ok(/when \(v_deferred or v_retry\) and v_stop then 'skipped'/.test(rec));
    assert.ok(/attempts = case when v_deferred then greatest\(d\.attempts - 1, 0\) else d\.attempts end/.test(rec),
      'a hand-back must not spend an attempt');
    assert.ok(/next_attempt_at = case when not v_stop and not v_deferred and v_retry and d\.attempts < 3\s+then now\(\) \+/.test(rec),
      'a transient failure must back off');
    assert.ok(s.includes('grant execute on function public.comm_record_delivery(uuid, integer, boolean, boolean, text, text, text) to service_role;'));
    assert.ok(/ambiguous_since = case when v_ambiguous then coalesce\(d\.ambiguous_since, d\.send_started_at, d\.claimed_at, now\(\)\)\s+else d\.ambiguous_since end/.test(rec),
      'the FIRST unclear attempt is kept: a later rate limit or local failure must neither move nor clear it');
    const unclearSrc = /v_ambiguous boolean := not coalesce\(p_ok, false\)\s+and coalesce\(p_error_code, ''\) ~ '([^']+)'/.exec(rec)?.[1];
    assert.ok(unclearSrc, 'comm_record_delivery must classify unclear answers');
    const unclear = new RegExp(unclearSrc);
    for (const code of ['resend_timeout', 'resend_failed', 'send_error', 'resend_500', 'resend_503', 'possibly_sent']) {
      assert.ok(unclear.test(code), `${code} may have been delivered and must mark the row`);
    }
    for (const code of ['resend_429', 'resend_422', 'payment_details_missing', 'payment_settings_unreadable', 'render_empty', 'deferred']) {
      assert.ok(!unclear.test(code), `${code} never reached the provider and must not mark the row`);
    }
    assert.ok(/when 'paused' then 'rule_paused'/.test(rec) && /when 'edited' then 'rule_edited'/.test(rec)
      && /r\.updated_at is distinct from d\.claimed_rule_version/.test(rec)
      && /when \(v_deferred or v_retry\) and v_stop then v_stop_code/.test(rec),
      "an automation row stopped by a pause must be recorded as 'rule_paused', or turning the rule on again never queues the member");
    const retry = bodyOf(s, 'comm_retry_failed');
    assert.ok(/coalesce\(d\.error_code, ''\) not in \('unknown_outcome', 'possibly_sent'\)/.test(retry),
      "'Retry failed' must never re-send a message that may have been delivered");
    assert.ok(/retry_generation = case when d\.ambiguous_since is not null then d\.retry_generation\s+else least\(d\.retry_generation \+ 1, 100\) end/.test(retry),
      'a row that was ever unclear keeps its idempotency key whatever its latest code; only a row refused outright becomes a new provider request');
    assert.ok(/and \(d\.ambiguous_since is null or d\.ambiguous_since >= now\(\) - interval '20 hours'\);/.test(retry),
      'an unclear failure past the key window is not re-sent');
    assert.ok(!/error_code, ''\) ~ /.test(retry), 'Retry failed must not judge ambiguity by the latest error code');
  });

  test(`${label}: a batch audience and a batch rule honour the member's LIVE plan segment`, () => {
    const s = sqlOf();
    for (const name of ['comm_audience_rows', 'comm_rule_matches']) {
      const body = bodyOf(s, name) || '';
      assert.ok(/e\.segment = coalesce\(\(select ep\.community_segment from public\.enrollment_plans ep\s+where ep\.key = m\.plan_key\), 'general'\)/.test(body),
        `${name} lets a member who left VIP keep receiving cohort email`);
      assert.ok(/not exists \(select 1 from public\.batch_entitlements e0 where e0\.user_id = m\.user_id\)/.test(body),
        `${name}: the subscription cache counts only for members with no ledger rows`);
    }
  });

  test(`${label}: no payment details in a subject, and a rule re-queues what a pause or an edit dropped`, () => {
    const s = sqlOf();
    for (const name of ['comm_create_campaign', 'comm_save_rule']) {
      assert.ok((bodyOf(s, name) || '').includes("if v_subject ~ '\\{\\{\\s*payment_instructions\\s*\\}\\}' then"),
        `${name} accepts payment details in a subject`);
    }
    const enq = bodyOf(s, 'comm_enqueue_automations');
    assert.ok(/select \* into v_rule from public\.comm_automation_rules r\s+where r\.id = v_rule_id and r\.status = 'active' for update;\s+continue when not found;/.test(enq),
      'each rule must be re-read under a lock, or a run queues matches from a definition already replaced');
    assert.ok(/on conflict \(dedupe_key\) do update[\s\S]*?where comm_deliveries\.status = 'skipped'\s+and comm_deliveries\.error_code in \('rule_edited', 'rule_paused', 'rule_inactive'\)/.test(enq),
      'a row a pause or an edit dropped was never sent, and must not block the member for good');
    assert.ok(/on conflict \(dedupe_key\) do update\s+set status = 'queued', error_code = null, next_attempt_at = null, attempts = 0, claimed_at = null,/.test(enq),
      'a re-queued row must start over with its attempts, or one stopped on its third attempt sits queued forever');
    assert.ok(!/retry_generation|ambiguous_since/.test(/on conflict \(dedupe_key\) do update\s+set([\s\S]*?)\s+where comm_deliveries\.status/.exec(enq)?.[1] || 'x retry_generation'),
      'a re-queue must keep the key and the unclear-attempt time, or an earlier delivery could be sent again');
    const AGE = "and \\(d\\.ambiguous_since is null or d\\.ambiguous_since >= now\\(\\) - interval '20 hours'\\)";
    assert.ok(new RegExp(`and not \\(d\\.status = 'skipped'\\s+and d\\.error_code in \\('rule_edited', 'rule_paused', 'rule_inactive'\\)\\s+${AGE}\\)\\)\\) as already`).test(bodyOf(s, 'comm_rule_preview')),
      "the preview must use the enqueue's own test, or it promises emails the run will not queue");
    assert.ok(new RegExp(`and not \\(d\\.status = 'skipped'\\s+and d\\.error_code in \\('rule_edited', 'rule_paused', 'rule_inactive'\\)\\s+${AGE}\\)\\);`).test(enq),
      'a dropped row whose earlier try may have been delivered 20+ hours ago must not be queued again — the claim would only write it off');
    assert.ok(/and \(comm_deliveries\.ambiguous_since is null\s+or comm_deliveries\.ambiguous_since >= now\(\) - interval '20 hours'\);/.test(enq),
      'the ON CONFLICT re-queue carries the same 20-hour guard');
    assert.ok(/public\.comm_rule_matches\([^)]*v_on, 7\) m\s+left join public\.comm_rule_matches\([^)]*v_on, v_window\) w/.test(enq),
      "a member a pause dropped must be re-queued anywhere in the claim's week-long window, not only today's catch-up window");
    assert.ok(/continue when not v_match\.in_window and not exists \(/.test(enq), 'outside the catch-up window only a dropped row is taken');
  });

  test(`${label}: every send is cleared by comm_begin_send, which refuses a cancel, a pause and an edited rule`, () => {
    const s = sqlOf();
    const begin = bodyOf(s, 'comm_begin_send');
    assert.ok(begin, 'comm_begin_send is missing');
    assert.ok(/where d\.id = p_id and d\.status = 'sending' and d\.attempts = p_attempt/.test(begin), 'only the claiming attempt may be cleared');
    assert.ok(/r\.status = 'active'\s+and r\.updated_at is not distinct from d\.claimed_rule_version/.test(begin),
      'a rule edited (or switched off and on) since the claim must not send the text claimed before');
    assert.ok(/perform 1 from public\.comm_deliveries d\s+where d\.id = p_id and d\.status = 'sending' and d\.attempts = p_attempt\s+for update;\s+if not found then\s+return false;/.test(begin),
      'the row is locked before the check');
    assert.ok(/perform 1 from public\.comm_automation_rules r where r\.id = v_rule for share;/.test(begin)
      && /perform 1 from public\.comm_campaigns c where c\.id = v_campaign for share;/.test(begin),
      'the clearance holds the rule or campaign row, so a racing pause, edit or cancel is either seen or counts this clearance');
    assert.ok(/select d\.rule_id, d\.campaign_id into v_rule, v_campaign from public\.comm_deliveries d where d\.id = p_id;/.test(begin),
      'the parent ids are read before any lock');
    const shareAt = begin.indexOf('for share;');
    const rowLockAt = begin.indexOf("d.attempts = p_attempt\n   for update;");
    assert.ok(shareAt > 0 && rowLockAt > shareAt,
      'the rule or campaign row is locked BEFORE the delivery row (the order pause, edit, cancel, delete and the enqueue keep), or a delete deadlocks');
    assert.ok(rowLockAt < begin.indexOf('set send_started_at'), 'the locks come before the check');
    assert.ok(/c\.cancelled_at is not null/.test(begin), 'a cancelled campaign must not be cleared');
    assert.ok(/set send_started_at = coalesce\(d\.send_started_at, now\(\)\)/.test(begin), 'the first clearance is kept');
    assert.ok(s.includes('grant execute on function public.comm_begin_send(uuid, integer) to service_role;'));
    for (const name of ['comm_cancel_campaign', 'comm_set_rule_status']) {
      const body = bodyOf(s, name);
      assert.ok(/status = 'sending' and send_started_at is not null;/.test(body), `${name} must count only rows already cleared to send`);
      assert.ok(!/for update\) x/.test(body), `${name} must not lock the delivery rows it counts — with the claim's row locks that deadlocks`);
    }
  });

  test(`${label}: the tracker and the stop actions say what may already have gone out`, () => {
    const s = sqlOf();
    const log = bodyOf(s, 'comm_delivery_log');
    assert.ok(/enrollment_request_id uuid, may_have_sent boolean, total_count bigint\)/.test(log));
    assert.ok(/\(d\.status <> 'sent' and d\.ambiguous_since is not null\),/.test(log));
    assert.ok(/'in_flight', v_sending/.test(bodyOf(s, 'comm_cancel_campaign')), 'cancel reports rows already being sent');
    assert.ok(/'in_flight', v_sending/.test(bodyOf(s, 'comm_set_rule_status')), 'pause reports rows already being sent');
    const delRule = bodyOf(s, 'comm_delete_rule');
    assert.ok(/'in_flight', v_sending\)/.test(delRule), 'delete reports rows already being sent');
    const delLock = delRule.indexOf('select r.id into v_found from public.comm_automation_rules r where r.id = p_id for update;');
    assert.ok(delLock > 0 && delLock < delRule.indexOf('update public.comm_deliveries'),
      'delete locks the rule BEFORE any delivery row; dropping rows first deadlocked against a pause, an edit and a clearance');
    const delCount = delRule.indexOf("status = 'sending' and send_started_at is not null;");
    assert.ok(delCount > 0 && delCount < delRule.indexOf('delete from public.comm_automation_rules'),
      'in-flight rows are counted before the delete clears their rule_id');
    const members = bodyOf(s, 'comm_current_members');
    assert.ok(members.includes("and lower(btrim(p.email)) ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' and char_length(btrim(p.email)) <= 320"),
      'one malformed profile address must not abort an automation run or a claim');
  });

  test(`${label}: the migration never reads payment details`, () => {
    // Payment instructions are filled by api/_lib/commSend.js at send time; SQL must not
    // copy them into a delivery row.
    // The permission key `payment_settings.manage` is in the restated staff seed; the TABLE is what is forbidden.
    assert.ok(!/public.payment_settings/.test(sqlOf()), 'the comm SQL must not touch payment_settings');
  });

  test(`${label}: the worklist is re-signed with one overload and reminder counts keyed on the request`, () => {
    const s = sqlOf();
    assert.ok(s.includes('drop function if exists public.finance_receivables_worklist(numeric, text, integer, integer);'));
    assert.ok(s.includes('grant execute on function public.finance_receivables_worklist(numeric, text, integer, integer, text[], uuid[]) to authenticated;'));
    const body = bodyOf(s, 'finance_receivables_worklist');
    assert.ok(/d\.enrollment_request_id = f\.eid and d\.kind = 'payment_reminder' and d\.status = 'sent'/.test(body),
      'reminder counts must key on the enrollment request, never a subject line');
    assert.ok(body.indexOf("has_staff_permission('finance.manage')") < body.indexOf('return query'));
  });
}

test('the preflight tolerates a re-run after the worklist was dropped', () => {
  const pre = /do \$pre\$([\s\S]*?)\$pre\$;/.exec(read(MIGRATION))?.[1] || '';
  assert.ok(/proname = 'finance_receivables_worklist'\) not in \(0, 1\)/.test(pre));
  assert.ok(/staff_permissions\) not in \(20, 21\)/.test(pre));
});

test('every COMM_ code raised is in the catalog, the client list and the copy table', () => {
  const s = read(MIGRATION);
  const catalog = s.slice(s.indexOf('create or replace function public.app_error_catalog()'));
  const raised = new Set([...codeOf(s).matchAll(/app_error\(\s*'(COMM_[A-Z_]+)'/g)].map((m) => m[1]));
  assert.ok(raised.size >= 8, `expected the comm codes, found ${raised.size}`);
  for (const code of raised) {
    assert.ok(catalog.includes(`('${code}'`), `${code} is not in app_error_catalog()`);
    assert.ok(APP_ERROR_CODES.includes(code), `${code} is unknown to the client`);
    assert.ok(APP_ERROR_COPY[code], `${code} has no user-facing copy`);
  }
});

test('communications.send belongs to super_admin alone and gates the tab', () => {
  assert.equal(ADMIN_TAB_PERMISSION.communications, 'communications.send');
  assert.ok(ROLE_PERMISSIONS.super_admin.includes('communications.send'));
  assert.ok(!ROLE_PERMISSIONS.operations_admin.includes('communications.send'));
  assert.ok(!ROLE_PERMISSIONS.trainer.includes('communications.send'));
  const grants = [...read(MIGRATION).matchAll(/\('(\w+)',\s*'communications\.send'\)/g)].map((m) => m[1]);
  assert.deepEqual(grants, ['super_admin']);
});

// ── The client ───────────────────────────────────────────────────────────────

const APP = read('src/BookkeeperPro.jsx');

test('every comm RPC the app calls is granted to authenticated, and none is service-only', () => {
  const s = codeOf(read(MIGRATION));
  const called = [...new Set([...APP.matchAll(/(?:supabase\.rpc|call)\(\s*'(comm_[a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(called.length >= 12, `expected the comm calls, found ${called.length}`);
  for (const fn of called) {
    assert.ok(!SERVICE_ONLY.includes(fn), `${fn} is service-only and would be refused from the browser`);
    assert.ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`).test(s),
      `the app calls ${fn}, which #61 does not grant to authenticated — a typo here is invisible to the build`);
  }
});

test('the email preview is an EMPTY sandbox', () => {
  const frame = /function CommPreviewFrame\(([\s\S]*?)\n}\n/.exec(APP)?.[0];
  assert.ok(frame, 'CommPreviewFrame is missing');
  assert.ok(/<iframe[^>]*\bsandbox=""/.test(frame), 'the preview iframe must carry sandbox=""');
  assert.ok(!/allow-/.test(frame), 'no sandbox token may be added — the preview renders student data');
  const comm = APP.slice(APP.indexOf('// Communications (#61)'), APP.indexOf('function FinancialManagement()'));
  assert.ok(!/dangerouslySetInnerHTML/.test(comm), 'Communications must never inject HTML into the app');
  assert.equal((jsCode(comm).match(/<iframe/g) || []).length, 1, 'the only iframe in Communications is the sandboxed preview');
});

test('the tab is wired at every site', () => {
  assert.ok(/communications: '\/admin\/communications'/.test(APP), 'TAB_ROUTES');
  assert.ok(/'financialmanagement', 'communications', 'mockinterview'\]/.test(APP), 'NON_TOOL_TAB_IDS');
  assert.ok(/case 'communications': return <Communications \/>;/.test(APP), 'renderToolContent');
  assert.ok(/\{ id: 'financialmanagement'[^\n]*\n[^\n]*\n\s*\{ id: 'communications'/.test(APP),
    'adminNavItems: Communications sits directly after Financial Management');
  const voice = /communications: \{ label: 'Communications'[^\n]*/.exec(APP)?.[0] || '';
  assert.ok(/Super Admin only/.test(voice), 'VOICE_TAB_INFO names the restriction');
  assert.ok(!/@|₱|\d{3}/.test(voice), 'voice metadata must stay navigation-only');
});

test('the client only asks the endpoint for actions it handles', () => {
  const handler = read('api/admin/communications.js');
  const actions = [...new Set([...APP.matchAll(/commApi\(\{ action: '([a-z-]+)'/g)].map((m) => m[1]))];
  assert.ok(actions.length >= 2);
  for (const a of actions) assert.ok(handler.includes(`action === '${a}'`), `api/admin/communications.js does not handle '${a}'`);
});

/** A pure module-scope function out of the monolith, evaluated with its collaborators stubbed. */
function extractFn(name, deps) {
  const src = new RegExp(`(?:async )?function ${name}\\(([\\s\\S]*?)\\n}\\n`).exec(APP)?.[0];
  assert.ok(src, `${name} is missing from the monolith`);
  return new Function(...Object.keys(deps), `${src}\nreturn ${name};`)(...Object.values(deps));
}

test('the send loop stops when nothing more can go out now — done, backoff, stalled or unknown', async () => {
  const run = async (responses) => {
    let calls = 0; let pauses = 0;
    const commApi = async () => responses[Math.min(calls++, responses.length - 1)];
    const setTimeout = (fn) => { pauses += 1; fn(); };
    const loop = extractFn('commSendLoop', { commApi, setTimeout });
    const t = await loop('c1', null);
    return { ...t, calls, pauses };
  };
  const done = await run([{ sent: 2, remaining: 3, retry_later: 0 }, { sent: 3, remaining: 0, retry_later: 0 }]);
  assert.equal(done.stopped, 'done'); assert.equal(done.sent, 5); assert.equal(done.calls, 2);
  const backoff = await run([{ sent: 1, remaining: 2, retry_later: 2 }]);
  assert.equal(backoff.stopped, 'backoff'); assert.equal(backoff.calls, 1, 'rows waiting out a backoff must not be hammered');
  const stalled = await run([{ sent: 0, failed: 0, remaining: 4, retry_later: 0 }]);
  assert.equal(stalled.stopped, 'stalled'); assert.equal(stalled.calls, 3); assert.equal(stalled.pauses, 2);
  const unknown = await run([{ sent: 0, remaining: null }]);
  assert.equal(unknown.stopped, 'unknown'); assert.equal(unknown.calls, 1);
  const leftover = extractFn('commLeftoverText', {});
  assert.equal(leftover({ remaining: 0 }), '');
  assert.match(leftover({ remaining: 2, stopped: 'backoff' }), /temporary error/);
  assert.match(leftover({ remaining: null, stopped: 'unknown' }), /could not be confirmed/, 'an unreadable count must not read as "Sent"');
  assert.match(leftover({ remaining: 3, stopped: 'halted' }), /database was slow/);
  assert.match(leftover({ remaining: null, stopped: 'cancelled' }), /cancelled/);
  const haltedRun = await run([{ sent: 1, remaining: 4, retry_later: 0, halted: true }]);
  assert.equal(haltedRun.stopped, 'halted'); assert.equal(haltedRun.calls, 1, 'a run the database stopped must not be repeated at once');
  assert.match(leftover({ remaining: 2, stopped: 'backoff' }), /20 hours/, 'a retry is not a promise: an unconfirmed delivery is written off, never sent twice');
  assert.doesNotMatch(leftover({ remaining: 2, stopped: 'backoff' }), /they go out with the next daily run/);
  assert.match(leftover({ remaining: null, stopped: 'not_configured' }), /not set up/);
  const stoppedRun = await run([{ sent: 1, stopped: 2, remaining: 0, retry_later: 0 }]);
  assert.equal(stoppedRun.stoppedRows, 2, 'rows stopped by a cancel are counted');
  const heading = extractFn('commDoneHeading', {});
  assert.equal(heading({ sent: 0, failed: 5, remaining: 0 }), 'Not sent', 'a message nothing delivered must not be headed "Sent"');
  assert.equal(heading({ sent: 3, failed: 0, remaining: 0 }), 'Sent');
  assert.equal(heading({ sent: 2, failed: 1, remaining: 0 }), 'Sent, with failures');
  assert.equal(heading({ sent: 0, remaining: null, stopped: 'not_configured' }), 'Not sent yet');
  assert.equal(heading({ sent: 1, remaining: 4 }), 'Partly sent');
  assert.equal(heading({ sent: 1, remaining: 0, stoppedRows: 2 }), 'Stopped part-way');
  assert.equal(heading({ sent: 0, remaining: null, stopped: 'unknown' }), 'Sending interrupted', 'a cut-off loop may have delivered emails it never heard about');
  assert.equal(heading({ sent: 0, remaining: 2, stopped: 'backoff' }), 'Not confirmed yet');
  assert.equal(heading({ sent: 0, failed: 0, remaining: 0 }), 'Finished', 'rows another sender delivered must not read as "Nothing sent"');
  assert.equal(heading({ sent: 0, remaining: null, stopped: 'cancelled' }), 'Stopped');
});

test('Run now, Retry failed, cancel, pause and the tracker say what actually happened', () => {
  const comm = APP.slice(APP.indexOf('function Communications()'), APP.indexOf('function FinancialManagement()'));
  assert.ok(/stopped: remaining === null \? 'unknown'/.test(comm), 'an unreadable count after Run now must be said, not dropped');
  assert.ok(/if \(out\?\.requeued\) await runSend\([^\n]*\n\s+else setNotice\(/.test(comm), 'a Retry failed that re-queues nothing must say why');
  assert.ok(/commDeliveryLabel\(d\.error_code, d\.may_have_sent\)/.test(comm) && /d\.may_have_sent/.test(comm), 'the tracker explains its codes');
  const label = new Function(`${/const COMM_DELIVERY_ERROR_LABELS = \{[\s\S]*?\n\};\n/.exec(APP)?.[0]}\n${/function commDeliveryLabel\([\s\S]*?\n}\n/.exec(APP)?.[0]}\nreturn commDeliveryLabel;`)();
  assert.equal(label('rule_paused', false), 'Automation paused before sending');
  assert.equal(label('rule_paused', true), 'Automation paused', 'after a try that may have been delivered, a stop is not "before sending"');
  assert.match(label('resend_failed', true), /outcome unclear/, 'a failed connection may have delivered the email');
  assert.ok(/label: 'May have been delivered', value: \(r\) => \(r\.may_have_sent \? 'yes' : ''\)/.test(comm), 'the CSV carries the warning too');
  assert.ok(/health\.hasCronSecret === false[\s\S]{0,260}goes out only when you press Send/.test(comm), 'Messages says when nothing will be sent automatically');
  assert.ok(/out\.stopped \? `, \$\{out\.stopped\} stopped because the message was cancelled or its automation turned off`/.test(comm) && /: out\.halted \? 'halted'/.test(comm),
    'Run now reports stopped rows and a halted run');
  assert.equal((comm.match(/out\?\.in_flight/g) || []).length, 4, 'cancel, pause, edit and delete say an email already with the provider may still arrive');
  assert.equal((read('src/BookkeeperPro.jsx').match(/if \(error\?\.code === '40P01'\) \(\{ data, error \} = await supabase\.rpc\(/g) || []).length, 2,
    'the Communications call helper and the rule save each ask a deadlock victim once more');
  assert.ok(!/one already being handed/.test(comm), 'more than one sender can be mid-send; the copy must not promise one');
  const composer = /function CommComposer\(([\s\S]*?)\n}\n/.exec(APP)?.[0] || '';
  assert.ok(/const stopped = e\?\.hint === 'email_not_configured' \? 'not_configured'\s+: e\?\.hint === 'COMM_CAMPAIGN_CLOSED' \? 'cancelled' : 'unknown';/.test(composer),
    'a send that failed part-way must not quote the preview count as still waiting, and only the server code says email is unconfigured');
  assert.ok(/\{commDoneHeading\(progress\)\}/.test(composer));
});

test('the composer mints one client key per reviewed message, locks a double click, and freezes its audience', () => {
  const composer = /function CommComposer\(([\s\S]*?)\n}\n/.exec(APP)?.[0] || '';
  assert.ok(/p_client_key: clientKeyRef\.current/.test(composer), 'comm_create_campaign must receive the client key');
  assert.ok(/const review = \(\) => \{ if \(!clientKeyRef\.current\) clientKeyRef\.current = commClientKey\(\);/.test(composer), 'Review mints the key once');
  assert.ok(/const backToEdit = \(\) => \{ setStep\('edit'\); \};/.test(composer), 'Back keeps the key: after a dropped connection the campaign may already exist');
  assert.ok(/useEffect\(\(\) => \{ clientKeyRef\.current = null; \}, \[subject, body, templateKey, audienceKey\]\);/.test(composer),
    'a changed message or audience needs a new key');
  assert.ok(/const uncertain = !campaignId && !e\?\.code && !e\?\.status && !appErrorCode\(e\);/.test(composer),
    'a dropped connection must not be reported as "not queued"');
  assert.ok(/onClick=\{backToEdit\}/.test(composer) && /onClick=\{review\}/.test(composer));
  assert.ok(/if \(sendLockRef\.current\) return;\s+sendLockRef\.current = true;/.test(composer), 'a double click must not create two campaigns');
  assert.ok(/if \(key === audienceKeyRef\.current\) setPreview\(data\)/.test(composer), 'a stale preview would quote the wrong count');
  const controls = composer.split('\n').filter((l) => /onChange=\{\(e\) => (setMode|setBatchId|setRange|setManualText|setActiveOnly)\(/.test(l));
  assert.ok(controls.length >= 6, `expected the audience controls, found ${controls.length}`);
  for (const l of controls) assert.ok(l.includes("disabled={step !== 'edit'}"), `an audience control stays editable after review: ${l.trim().slice(0, 80)}`);
  assert.ok(/<CommPlanChecks [^>]*disabled=\{step !== 'edit'\}/.test(composer));
  const keySrc = /const commClientKey = ([\s\S]*?\));\n/.exec(APP)?.[1];
  assert.ok(keySrc, 'commClientKey is missing from the monolith');
  const mint = new Function(`return ${keySrc};`)();
  assert.match(mint(), /^[A-Za-z0-9-]{8,64}$/, 'the key must match the server CHECK');
  const noCrypto = new Function('globalThis', `return ${keySrc};`)({});
  assert.match(noCrypto(), /^[A-Za-z0-9-]{8,64}$/, 'the fallback key (no crypto.randomUUID) must match the server CHECK too');
});

test('Communications reads health through the gated endpoint and gives each list its own retry', () => {
  const comm = APP.slice(APP.indexOf('function Communications()'), APP.indexOf('function FinancialManagement()'));
  assert.ok(/commApi\(\{ action: 'status' \}\)/.test(comm), 'health must come from the signed-in status action');
  assert.ok(!/fetch\('\/api\/admin\/communications'\)/.test(APP), 'the public GET no longer reports configuration');
  assert.ok(!/<[a-z]+[^>]*\brole="tablist"/.test(comm), 'the sub-tab row is toggle buttons, not an ARIA tablist');
  assert.ok(/aria-pressed=\{sub === t\.key\}/.test(comm));
  for (const k of ['campaigns', 'rules', 'tracker']) {
    assert.ok(new RegExp(`<CommListError message=\\{listErr\\.${k}\\} onRetry=`).test(comm), `the ${k} list has no error state with a retry`);
  }
});

test('the receivables composer lives outside the list it reloads', () => {
  const fin = APP.slice(APP.indexOf('function FinancialManagement()'));
  const footnote = fin.indexOf('Both ages are shown rather than one chosen for you');
  const composerAt = fin.indexOf('<CommComposer kind="payment_reminder"');
  assert.ok(footnote > 0 && composerAt > footnote, 'the payment-reminder composer must follow the receivables table');
  assert.ok(/<\/>\s+\)\}/.test(fin.slice(footnote, composerAt)), 'the composer must be outside the non-empty branch, or a reload unmounts it mid-send');
  assert.ok(/onClose=\{\(\) => \{ setReminding\(null\); setRecvPick\(\{\}\); load\('sales'\); \}\}/.test(fin),
    'closing must reload the list — clearing it alone left "Nobody has an outstanding balance" on screen');
});

test('the rule editor ignores a stale preview, previews the payment block, and refuses payment details in a subject', () => {
  const editor = /function CommRuleEditor\(([\s\S]*?)\n}\n/.exec(APP)?.[0] || '';
  const composer = /function CommComposer\(([\s\S]*?)\n}\n/.exec(APP)?.[0] || '';
  assert.ok(/if \(key === argsKeyRef\.current\) setPreview\(data\)/.test(editor), 'a preview for changed settings would name the wrong people');
  assert.ok(/payment_instructions: COMM_PREVIEW_VARS\.payment_instructions/.test(editor), 'the sender fills the payment block, so the preview must show it');
  assert.ok(/aria-label="Who receives this automation"/.test(editor));
  for (const [label, src] of [['rule editor', editor], ['composer', composer]]) {
    assert.ok(src.includes('const subjectPayment = /\\{\\{\\s*payment_instructions\\s*\\}\\}/.test(subject);'), `${label} does not check the subject`);
    assert.ok(/!subjectPayment/.test(src), `${label} lets a subject with payment details through`);
  }
  assert.ok(/const e = new Error\(json\.error \|\| ''\);/.test(APP), 'an endpoint error with no sentence must fall back to the caller copy');
});

// ── The endpoints ────────────────────────────────────────────────────────────

test('the send endpoint gates before building the service client, and takes no recipient or content', () => {
  const src = jsCode(read('api/admin/communications.js'));
  const gate = src.indexOf("requireStaff(req, { permission: 'communications.send' })");
  const svc = src.indexOf('service()', src.indexOf('export default'));
  assert.ok(gate > 0 && svc > gate, 'requireStaff must run before service()');
  assert.ok(!/body\.(to|email|emails|recipients|subject|html|text)\b/.test(src),
    'the endpoint must not accept a recipient or message from the browser — the legacy open relay');
  assert.ok(/found\.row\.kind === 'payment_reminder' && !canFinance/.test(src), 'a payment reminder also needs finance.manage');
  assert.ok(/found\.row\.cancelled_at\) \{\s+return res\.status\(409\)/.test(src), 'a cancelled campaign is a 409, not a silent no-op');
  assert.equal((src.match(/stopped: out\.stopped, halted: out\.halted, left: out\.left, \.\.\.waitingPayload\(waiting\)/g) || []).length, 2,
    'send and Run now both report rows stopped, whether the run halted, and rows left for the next claim');
  assert.ok(/\.abortSignal\(AbortSignal\.timeout\(ENQUEUE_TIMEOUT_MS\)\)/.test(src), 'the enqueue has a time limit');
  const cron = jsCode(read('api/cron/communications.js'));
  assert.ok(/stopped: out\.stopped,/.test(cron) && /halted: out\.halted, left: out\.left,/.test(cron), 'the cron reports stopped, halted and left rows');
  assert.ok(/\.abortSignal\(AbortSignal\.timeout\(ENQUEUE_TIMEOUT_MS\)\)/.test(cron), 'the cron enqueue has a time limit');
  assert.ok(/const enqueueFailed = Boolean\(error\);/.test(cron) && /if \(e\.migrationMissing\) throw e;/.test(cron)
    && !/if \(error\) throw rpcError\(error, 'comm_enqueue_automations'\);/.test(cron),
    'a failed enqueue must not stop the daily run sending what was already waiting (a missing migration still stops it)');
  assert.ok(/enqueue_failed: enqueueFailed,/.test(cron), 'the cron reports a failed enqueue');
});

test('the public GET says nothing about which secrets are configured', () => {
  const src = jsCode(read('api/admin/communications.js'));
  assert.ok(/if \(req\.method === 'GET'\) return res\.status\(200\)\.json\(\{ ok: true \}\);/.test(src));
  const gate = src.indexOf('requireStaff(req');
  for (const flag of ['hasResend', 'hasCronSecret', 'emailConfigured()']) {
    const at = src.indexOf(flag, src.indexOf('export default'));
    assert.ok(at < 0 || at > gate, `${flag} is reachable before the staff gate`);
  }
});

test('the cron endpoint works on GET, fails closed without a secret, and compares in constant time', () => {
  const src = jsCode(read('api/cron/communications.js'));
  assert.ok(/req\.method !== 'GET'/.test(src), 'Vercel Cron calls GET');
  assert.ok(/timingSafeEqual/.test(src));
  assert.ok(!/status\(503\)/.test(src), 'an unset secret must answer like a wrong one, or the status code reveals the configuration');
  const unset = src.indexOf('if (!cronSecretUsable(secret))');
  const refuse = src.indexOf('status(401)', unset);
  const svc = src.indexOf('service()', src.indexOf('export default'));
  assert.ok(unset > 0 && refuse > unset && svc > refuse, 'the missing-secret refusal must come before service()');
  const mail = src.indexOf('if (!emailConfigured())');
  const enqueue = src.indexOf("'comm_enqueue_automations'");
  assert.ok(mail > 0 && enqueue > mail, 'nothing may be queued while email is unconfigured — it would go out days late');

  const secret = 'a-long-enough-cron-secret';
  assert.equal(cronAuthorized(`Bearer ${secret}`, secret), true);
  assert.equal(cronAuthorized(`Bearer ${secret}x`, secret), false);
  assert.equal(cronAuthorized(undefined, secret), false);
  assert.equal(cronAuthorized('Bearer short', 'short'), false, 'a short secret is treated as no secret');
  assert.equal(cronAuthorized('Bearer ', ''), false);
  assert.equal(cronSecretUsable('x'.repeat(15)), false);
  assert.equal(cronSecretUsable('x'.repeat(16)), true);
  assert.ok(/hasCronSecret: cronSecretUsable\(process\.env\.CRON_SECRET\),/.test(read('api/admin/communications.js')),
    'Settings must not report a secret the cron would refuse as configured');
});

test('vercel.json schedules the cron at 09:00 Manila and both handlers have a dev route', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.deepEqual(vercel.crons, [{ path: '/api/cron/communications', schedule: '0 1 * * *' }]);
  assert.ok(vercel.functions['api/admin/communications.js']);
  assert.ok(vercel.functions['api/cron/communications.js']);
  const vite = read('vite.config.js');
  assert.ok(vite.includes("commDevApi(env, '/api/admin/communications', './api/admin/communications.js')"));
  assert.ok(vite.includes("commDevApi(env, '/api/cron/communications', './api/cron/communications.js')"));
});

test('the sender records only its own attempt, keys each retry generation, and never sleeps on a 429', () => {
  const src = jsCode(read('api/_lib/commSend.js'));
  assert.ok(src.includes('p_id: row.id, p_attempt: row.attempts'), 'the record call must name the attempt that claimed the row');
  assert.ok(src.includes('idempotencyKey: `comm-${row.id}-${Number(row.retry_generation) || 0}`'));
  assert.ok(/retry429: false/.test(src) && /maxAttempts: 1,/.test(src), 'one provider request per email, and no sleeping on a 429');
  assert.ok(src.includes('const PER_EMAIL_WORST_MS = 3 * RPC_TIMEOUT_MS + SEND_TIMEOUT_MS + PACE_MS;'),
    'the budget must assume the real worst case — clearance, payment read, send, record and pace');
  assert.ok(/const timeoutMs = \(\) => Math\.max\(1_000, Math\.min\(SEND_TIMEOUT_MS, deadlineMs - Date\.now\(\) - RPC_TIMEOUT_MS - PACE_MS\)\)/.test(src));
  assert.ok(/deadlineMs - Date\.now\(\) >= REPEAT_PAUSE_MS \+ PER_EMAIL_WORST_MS/.test(src), 'an unclear answer is asked again only when a whole email still fits');
  assert.ok(/if \(\(await recheck\(\)\) === 'go'\) \{/.test(src), 'the repeat is cleared again, so a cancel during the first request stops it');
  assert.ok(/if \(again\.ok \|\| UNCLEAR\.test\(again\.code \|\| ''\)\) out = again;/.test(src), 'only a success or another unclear answer replaces the first');
  assert.ok(/p_limit: Math\.max\(1, Math\.min\(BATCH, fit\)\)/.test(src), 'a claim is sized to the time left');
  assert.ok(/if \(!out\.ok && out\.code === 'resend_409'\) out = \{ ok: false, code: 'possibly_sent' \};/.test(src), 'a 409 may have been delivered');
  assert.ok(/const cleared = await clear\(row\);/.test(src) && /'comm_begin_send'/.test(src), 'every send is cleared by the database first');
  const flow = src.slice(src.indexOf('export async function processQueue'));
  const clearedAt = flow.indexOf('const cleared = await clear(row);');
  const sendAt = flow.indexOf('await sendDelivery({', clearedAt);
  assert.ok(flow.indexOf('await paymentInstructions(admin)') > 0 && flow.indexOf('await paymentInstructions(admin)') < clearedAt,
    'the payment details read happens before the clearance');
  assert.ok(sendAt > clearedAt && !/admin\.|paymentInstructions/.test(flow.slice(clearedAt + 34, sendAt)),
    'nothing reads or writes the database between the clearance and the provider request');
  assert.ok(!/p_rule_version|rule_updated_at/.test(src), 'the rule version lives on the row, not in a round trip through the sender');
  assert.ok(/if \(claim\.timedOut\) \{/.test(src), 'a claim that does not answer ends the run instead of hanging it');
  assert.ok(!/admin\.rpc\(/.test(src.replace(/async function rpcWithin\([\s\S]*?\n}\n/, '')), 'every RPC goes through rpcWithin, so none is unbounded');
  assert.ok(/await admin\.rpc\(fn, args\)\.abortSignal\(signal\);/.test(src), 'rpcWithin attaches the time limit');
  assert.ok(/select\('key,value'\)\.abortSignal\(AbortSignal\.timeout\(RPC_TIMEOUT_MS\)\)/.test(src), 'the payment details read has a time limit');
  // #67 moved the support-address read into api/_lib/supportAddress.js, shared with the
  // migration's claim emails. The limit is still the sender's own RPC limit.
  const support = jsCode(read('api/_lib/supportAddress.js'));
  assert.ok(/eq\('key', 'notify_email'\)\s+\.abortSignal\(AbortSignal\.timeout\(timeoutMs\)\)/.test(support), 'the support address read has a time limit');
  assert.ok(/sharedSupportAddress\(admin, \{ timeoutMs: RPC_TIMEOUT_MS \}\)/.test(src), 'and the sender passes its own RPC limit to it');
  assert.ok(!/stillWanted|STOP_CHECK_MS/.test(src), 'the read-only stop check is replaced by the clearance');
  assert.ok(/p_error_code: 'deferred'/.test(src), 'a row the budget cannot reach is handed back, not left sending');
});

test('a delivery email escapes tag values and adds payment details only when the body asks', () => {
  const row = { subject: 'Hi {{first_name}}', body: 'Hello {{name}}\n\n{{payment_instructions}}', vars: { name: '<b>Ana</b> Cruz' }, recipient_name: 'x' };
  const withPay = buildDeliveryEmail(row, { supportEmail: 'support@example.test', payment: 'BPI: test-value' });
  assert.ok(!withPay.html.includes('<b>Ana</b>'), 'a name must never become markup');
  assert.ok(withPay.html.includes('&lt;b&gt;Ana&lt;/b&gt;'));
  assert.ok(withPay.text.includes('BPI: test-value'));
  assert.ok(withPay.text.includes('support@example.test'));
  const noPay = buildDeliveryEmail({ ...row, body: 'Hello {{name}}' }, { supportEmail: null, payment: null });
  assert.ok(!noPay.text.includes('BPI'));
  assert.equal(noPay.empty, false);
  assert.equal(buildDeliveryEmail({ subject: '', body: '' }, {}).empty, true);
  assert.equal(buildDeliveryEmail({ subject: 's', body: 'Pay:\n\n{{payment_instructions}}' }, { payment: '' }).missingPayment, true,
    'a body that asks for payment details must fail when none are configured, not send a blank');
});

// ── sendEmail under a time limit (fetch stubbed; no network) ─────────────────

async function withStubbedResend(fetchImpl, fn) {
  const saved = { fetch: globalThis.fetch, key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM };
  globalThis.fetch = fetchImpl;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'sender@example.test';
  try { return await fn(); } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = saved.from;
  }
}
const MSG = { to: 'a@example.test', subject: 's', html: '<p>h</p>', tag: 'test' };

test('sendEmail with retry429:false returns a rate limit at once instead of sleeping', async () => {
  let calls = 0;
  const out = await withStubbedResend(async () => { calls += 1; return new Response('{}', { status: 429, headers: { 'retry-after': '5' } }); },
    () => sendEmail({ ...MSG, retry429: false }));
  assert.deepEqual(out, { ok: false, code: 'resend_429' });
  assert.equal(calls, 1);
});

test('sendEmail passes an abort signal and reports a timeout as resend_timeout', async () => {
  let signals = 0;
  const started = Date.now();
  const out = await withStubbedResend(async (_url, init) => {
    if (init?.signal) signals += 1;
    const e = new Error('timed out'); e.name = 'TimeoutError'; throw e;
  }, () => sendEmail({ ...MSG, timeoutMs: 50 }));
  assert.deepEqual(out, { ok: false, code: 'resend_timeout' });
  assert.equal(signals, 3, 'every attempt carries the time limit');
  assert.ok(Date.now() - started < 2800, 'no backoff sleep after the final attempt');
});

test('sendEmail sends a stable idempotency key when one is supplied', async () => {
  const keys = [];
  const out = await withStubbedResend(async (_url, init) => { keys.push(init.headers['Idempotency-Key']); return new Response('{"id":"x"}', { status: 200 }); },
    () => sendEmail({ ...MSG, idempotencyKey: 'comm-abc12345-2' }));
  assert.equal(out.ok, true);
  assert.deepEqual(keys, ['comm-abc12345-2']);
});

test('sendEmail without timeoutMs sets no abort signal — staff invitations keep their old behaviour', async () => {
  let signal = 'unset';
  await withStubbedResend(async (_url, init) => { signal = init.signal; return new Response('{"id":"x"}', { status: 200 }); },
    () => sendEmail({ ...MSG }));
  assert.equal(signal, undefined);
});

// ── The sender against a stand-in database (fetch stubbed; no network, no database) ──

function fakeAdmin({ rows, begin = true, beginError = false, supportError = false, retryStatus = 'queued', recordError = false, claimError = null }) {
  const log = { claims: 0, begins: 0, records: [], signals: [] };
  let handed = false;
  const builder = (label, produce) => {
    const q = {
      select: () => q, eq: () => q, in: () => q, gt: () => q, maybeSingle: () => q,
      abortSignal: (s) => { log.signals.push([label, s instanceof AbortSignal]); return q; },
      then: (ok, bad) => Promise.resolve().then(produce).then(ok, bad),
    };
    return q;
  };
  const from = (table) => builder(table, () => (table === 'payment_settings' && supportError
    ? { data: null, error: { code: 'PGRST000' } } : { data: null, error: null }));
  const rpc = (name, args) => builder(name, () => {
    if (name === 'comm_claim_deliveries') {
      log.claims += 1;
      if (claimError) return { data: null, error: { code: claimError } };
      if (handed) return { data: [], error: null };
      handed = true;
      return { data: rows, error: null };
    }
    if (name === 'comm_begin_send') {
      log.begins += 1;
      if (beginError) return { data: null, error: { code: 'PGRST000' } };
      return { data: typeof begin === 'function' ? begin(log.begins) : begin, error: null };
    }
    if (name === 'comm_record_delivery') {
      log.records.push(args);
      if (recordError) return { data: null, error: { code: 'PGRST000' } };
      const status = args.p_ok ? 'sent' : args.p_error_code === 'deferred' ? (begin === false ? 'skipped' : 'queued')
        : args.p_retry ? retryStatus : 'failed';
      return { data: status, error: null };
    }
    return { data: null, error: null };
  });
  return { admin: { from, rpc }, log };
}
const ROW = {
  id: '00000000-0000-4000-8000-000000000001', kind: 'announcement', campaign_id: 'c1', rule_id: null, attempts: 1,
  retry_generation: 0, email: 'student@example.test', recipient_name: 'Ana', vars: {}, subject: 'Hello', body: 'Hi {{name}}',
};
const timeoutError = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; return e; };
const drain = (admin, campaignId = 'c1') => processQueue(admin, { campaignId, deadlineMs: Date.now() + 60_000, wait: async () => {} });

test('an unclear answer is asked again once, under the same key, after a second clearance, and the second answer is recorded', async () => {
  const { admin, log } = fakeAdmin({ rows: [ROW] });
  const keys = [];
  const out = await withStubbedResend(async (_url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    if (keys.length === 1) throw timeoutError();
    return new Response('{"id":"prov-1"}', { status: 200 });
  }, () => drain(admin));
  assert.deepEqual(keys, [`comm-${ROW.id}-0`, `comm-${ROW.id}-0`], 'the repeat must reuse the key, or it is a second email');
  assert.equal(log.begins, 2, 'the repeat is cleared again first');
  assert.equal(out.sent, 1);
  assert.equal(log.records.length, 1);
  assert.equal(log.records[0].p_ok, true);
  assert.equal(log.records[0].p_provider_id, 'prov-1');
});

test('a cancel or pause that lands during the first request stops the repeat', async () => {
  const { admin, log } = fakeAdmin({ rows: [ROW], begin: (n) => n === 1 });
  let calls = 0;
  await withStubbedResend(async () => { calls += 1; throw timeoutError(); }, () => drain(admin));
  assert.equal(calls, 1, 'no repeat after the clearance was refused');
  assert.equal(log.records[0].p_error_code, 'resend_timeout', 'the first unclear answer is recorded, so the row keeps its unclear mark');
  assert.equal(log.records[0].p_retry, true);
});

test('a 409, a rate limit or a refusal on the repeat keeps the unclear answer, so nothing clears the unclear mark', async () => {
  for (const status of [409, 429, 401]) {
    const { admin, log } = fakeAdmin({ rows: [ROW] });
    let calls = 0;
    await withStubbedResend(async () => {
      calls += 1;
      if (calls === 1) throw timeoutError();
      return new Response('{}', { status });
    }, () => drain(admin));
    assert.equal(calls, 2);
    assert.equal(log.records[0].p_error_code, 'resend_timeout', `a ${status} on the repeat says nothing about the first request`);
    assert.equal(log.records[0].p_retry, true);
  }
});

test('a 409 on a first request is recorded as possibly_sent, not repeated and not retried', async () => {
  const { admin, log } = fakeAdmin({ rows: [ROW] });
  let calls = 0;
  await withStubbedResend(async () => { calls += 1; return new Response('{}', { status: 409 }); }, () => drain(admin));
  assert.equal(calls, 1);
  assert.equal(log.records[0].p_error_code, 'possibly_sent');
  assert.equal(log.records[0].p_retry, false);
});

test('a refused clearance (cancelled, paused, or a rule edited since the claim) sends nothing and hands the row back', async () => {
  const auto = { ...ROW, kind: 'automation', campaign_id: null, rule_id: 'r1' };
  const { admin, log } = fakeAdmin({ rows: [auto], begin: false });
  let calls = 0;
  const out = await withStubbedResend(async () => { calls += 1; return new Response('{}', { status: 200 }); }, () => drain(admin, null));
  assert.equal(calls, 0, 'nothing may be sent without a clearance');
  assert.equal(out.stopped, 1);
  assert.equal(log.records[0].p_error_code, 'deferred');
});

test('a clearance that cannot be answered hands back that row, leaves the rest for the next claim, and sends nothing', async () => {
  const { admin, log } = fakeAdmin({ rows: [ROW, { ...ROW, id: '00000000-0000-4000-8000-000000000002' }], beginError: true });
  let calls = 0;
  const out = await withStubbedResend(async () => { calls += 1; return new Response('{}', { status: 200 }); }, () => drain(admin));
  assert.equal(calls, 0, 'a sender that could not get a clearance must not send');
  assert.equal(out.halted, true);
  assert.equal(log.begins, 2, 'one slow answer gets exactly one more try');
  assert.equal(log.claims, 1, 'it stops claiming too');
  assert.equal(log.records.length, 1, 'once the database has stopped answering, the rest are left, not hammered');
  assert.equal(out.left, 1, 'a row left claimed is released by the next claim with its attempt refunded');
});

test('a support address that cannot be read stops the run before anything is sent', async () => {
  const saved = process.env.NOTIFY_ADMIN_EMAIL;
  delete process.env.NOTIFY_ADMIN_EMAIL;
  try {
    const { admin, log } = fakeAdmin({ rows: [ROW], supportError: true });
    let calls = 0;
    const out = await withStubbedResend(async () => { calls += 1; return new Response('{}', { status: 200 }); }, () => drain(admin));
    assert.equal(calls, 0, 'no email goes out with nowhere for a reply to go');
    assert.equal(out.halted, true);
    assert.equal(log.begins, 0);
    assert.equal(out.left, 1);
  } finally {
    if (saved === undefined) delete process.env.NOTIFY_ADMIN_EMAIL; else process.env.NOTIFY_ADMIN_EMAIL = saved;
  }
});

test('every database call the sender makes carries a time limit', async () => {
  const { admin, log } = fakeAdmin({ rows: [ROW] });
  await withStubbedResend(async () => new Response('{"id":"p"}', { status: 200 }), () => drain(admin));
  for (const name of ['comm_claim_deliveries', 'comm_begin_send', 'comm_record_delivery', 'payment_settings']) {
    assert.ok(log.signals.some(([t, ok]) => t === name && ok), `${name} was called without an abort signal`);
  }
});

test('a claim the server rolled back (deadlock, lock or statement time limit) ends the run instead of failing it', async () => {
  const ok = async () => new Response('{"id":"p"}', { status: 200 });
  for (const code of ['40P01', '55P03', '57014']) {
    const { admin, log } = fakeAdmin({ rows: [ROW], claimError: code });
    const out = await withStubbedResend(ok, () => drain(admin));
    assert.equal(out.halted, true, `${code} must halt the run`);
    assert.equal(out.sent, 0);
    assert.equal(log.begins, 0, 'nothing is cleared after a rolled-back claim');
  }
  const { admin } = fakeAdmin({ rows: [ROW], claimError: 'PGRST000' });
  await assert.rejects(() => withStubbedResend(ok, () => drain(admin)), 'any other claim error is still a failure');
});

test('a local failure is recorded without a clearance, so a lost record can never make it look delivered', async () => {
  const { admin, log } = fakeAdmin({ rows: [{ ...ROW, body: 'Pay here:\n\n{{payment_instructions}}' }] });
  let calls = 0;
  const out = await withStubbedResend(async () => { calls += 1; return new Response('{}', { status: 200 }); }, () => drain(admin));
  assert.equal(calls, 0);
  assert.equal(log.begins, 0, 'nothing that failed locally is ever cleared (stamped)');
  assert.equal(log.records[0].p_error_code, 'payment_details_missing');
  assert.equal(out.failed, 1);
});

test('a retry the record step stops is counted as stopped, not failed', async () => {
  const { admin } = fakeAdmin({ rows: [ROW], begin: (n) => n === 1, retryStatus: 'skipped' });
  const out = await withStubbedResend(async () => { throw timeoutError(); }, () => drain(admin));
  assert.equal(out.stopped, 1);
  assert.equal(out.failed, 0, 'a cancelled send that may have been delivered must not read "Not sent"');
});

test('a record the database does not take stops the run before another row is cleared', async () => {
  const { admin, log } = fakeAdmin({ rows: [ROW, { ...ROW, id: '00000000-0000-4000-8000-000000000002' }], recordError: true });
  const out = await withStubbedResend(async () => new Response('{"id":"p"}', { status: 200 }), () => drain(admin));
  assert.equal(out.sent, 1, 'the email that went out is still counted');
  assert.equal(out.halted, true);
  assert.equal(log.begins, 1, 'the second row is not cleared against a database that stopped taking writes');
  assert.equal(out.left, 1);
});

test('sendEmail with maxAttempts:1 makes exactly one request', async () => {
  let calls = 0;
  const started = Date.now();
  const out = await withStubbedResend(async () => { calls += 1; throw new TypeError('fetch failed'); },
    () => sendEmail({ ...MSG, maxAttempts: 1 }));
  assert.deepEqual(out, { ok: false, code: 'resend_failed' });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 400, 'a single attempt must not sleep');
});
