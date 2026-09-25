// test/enrollmentDecisionLockSql.test.mjs — the enrollment decision lock (#66), pinned in the
// dated file AND the §53 fold. Reads files as TEXT; no database and no network. The behaviour
// itself — a real Operations Admin refused through PostgREST, a Super Admin let through — is
// test-db/enrollmentDecisionLock.dbtest.mjs.
//
// ★ THE HOLE: #48 granted UPDATE (status, …) to every enrollments.review holder and nothing
//   limited which status a row could leave. approve → PATCH back to pending_review → approve
//   again stacked a second paid term on one payment, with no finance entry (#58's idempotency
//   key) and no audit row. The lock is a BEFORE UPDATE trigger scoped by its WHEN clause.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-24-enrollment-decision-lock.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';

/** Executable SQL only — comments explain invariants and must neither satisfy nor fail a scan. */
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
const squash = (s) => s.replace(/\s+/g, ' ');

/** The §53 fold, bounded at the next banner (never to EOF — that is how §30 was lost). */
function foldSection() {
  const boot = read(BOOTSTRAP);
  const at = boot.indexOf('§53) FOLDED VERBATIM');
  assert.ok(at > 0, '§53 is missing from the bootstrap — fold db/2026-09-24-enrollment-decision-lock.sql');
  const next = boot.indexOf('FOLDED VERBATIM', at + 30);
  return boot.slice(at, next > 0 ? next : undefined);
}

function lockBody(sql) {
  const at = sql.indexOf('create or replace function public.enrollment_decision_lock(');
  assert.ok(at >= 0, 'enrollment_decision_lock() is not defined');
  const end = sql.indexOf('$fn$;', at);
  assert.ok(end > at, 'enrollment_decision_lock() has no closing $fn$');
  return codeOf(sql.slice(at, end));
}

const SOURCES = [['dated file', () => read(MIGRATION)], ['bootstrap §53', foldSection]];

for (const [label, sqlOf] of SOURCES) {
  test(`${label}: the trigger is BEFORE UPDATE and scoped to a status change out of a decided state`, () => {
    const sql = squash(codeOf(sqlOf()));
    const m = /create trigger enrollment_decision_lock before update on public\.enrollment_requests for each row when \((.+?)\) execute function public\.enrollment_decision_lock\(\);/.exec(sql);
    assert.ok(m, 'the trigger must be BEFORE UPDATE FOR EACH ROW on enrollment_requests, with a WHEN clause');
    const when = m[1];
    // All three decided states — leaving one out reopens the hole through that state.
    assert.match(when, /old\.status in \('approved', 'rejected', 'expired'\)/,
      'every decided state must be final: approved, rejected AND expired');
    // Only a CHANGE of status. Without this the trigger runs on every admin_notes save and
    // every notify stamp — and would refuse them.
    assert.match(when, /new\.status is distinct from old\.status/);
    assert.ok(!/pending_review/.test(when), 'pending_review is the one state a decision moves FROM');
    assert.match(sql, /drop trigger if exists enrollment_decision_lock on public\.enrollment_requests;/,
      'the file must be re-runnable');
  });

  test(`${label}: the refusal carries the stable code, and only a Super Admin or the owner's override passes`, () => {
    const body = squash(lockBody(sqlOf()));
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = public, pg_temp/);
    assert.match(body, /if not \(v_override or public\.is_super_admin\(\)\) then perform public\.app_error\('INVALID_MEMBERSHIP_TRANSITION'/,
      'a non-Super-Admin must be refused with INVALID_MEMBERSHIP_TRANSITION');
    assert.match(body, /, 409, /, 'a transition conflict is a 409');
    // No "no caller means trusted" exemption: a Management API session has no JWT.
    assert.ok(!/auth\.uid\(\) is null/.test(body), 'a missing JWT must never be treated as a trusted caller');
    // The override is the #38 idiom: an explicit setting AND ownership of the table — never
    // rolsuper, which Supabase's postgres does not have.
    assert.match(body, /current_setting\('app\.enrollment_admin_override', true\)/);
    assert.match(body, /pg_has_role\(session_user, \(select c\.relowner from pg_class c join pg_namespace n on n\.oid = c\.relnamespace where n\.nspname = 'public' and c\.relname = 'enrollment_requests'\), 'member'\)/,
      'the override must be gated on ownership of enrollment_requests');
    assert.ok(!/rolsuper/.test(body), 'a rolsuper gate is unreachable on Supabase');
  });

  test(`${label}: every permitted reopen is written to the append-only timeline`, () => {
    const sql = squash(codeOf(sqlOf()));
    const body = squash(lockBody(sqlOf()));
    // The insert follows the refusal, so only a PERMITTED reopen is logged, never an attempt.
    const refuse = body.indexOf("perform public.app_error('INVALID_MEMBERSHIP_TRANSITION'");
    const log = body.indexOf('insert into public.enrollment_request_events');
    assert.ok(refuse > 0 && log > refuse, 'the reopen must be logged after the refusal check');
    assert.match(body, /'decision_reopened'/);
    assert.match(body, /jsonb_build_object\('from', old\.status, 'to', new\.status/);
    // The CHECK must accept the new action, and must be VALIDATED — never a silent skip.
    assert.match(sql, /add constraint enrollment_request_events_action_check check \(action in \('hold_set', 'hold_updated', 'hold_cleared', 'amount_corrected', 'decision_reopened'\)\) not valid;/);
    assert.match(sql, /validate constraint enrollment_request_events_action_check;/);
  });

  test(`${label}: the function is reachable only as a trigger`, () => {
    const sql = squash(codeOf(sqlOf()));
    assert.match(sql, /revoke all on function public\.enrollment_decision_lock\(\) from public, anon, authenticated;/);
    assert.ok(!/grant execute on function public\.enrollment_decision_lock/.test(sql));
  });

  test(`${label}: no catalog restatement, no permission change, and the migration is logged`, () => {
    const sql = codeOf(sqlOf());
    // INVALID_MEMBERSHIP_TRANSITION already exists; restating app_error_catalog() here would
    // make this file the catalog owner and every future restatement would have to copy it.
    assert.ok(!/create or replace function public\.app_error_catalog/.test(sql), 'the catalog must not be restated');
    assert.ok(!/staff_permissions|staff_role_permissions/.test(sql), '#66 changes no permission');
    assert.ok(!/create policy|alter policy|grant update/i.test(sql), '#66 changes no policy or column grant');
    assert.match(sql, /insert into public\.schema_migrations \(filename, checksum, notes\) values\s*\('2026-09-24-enrollment-decision-lock\.sql'/);
  });
}

test('the refusal code exists in the client catalog', () => {
  assert.ok(APP_ERROR_CODES.includes('INVALID_MEMBERSHIP_TRANSITION'),
    'the client branches on error.hint — the code must be one it knows');
});

test('the dated file keeps its preflight; the fold drops it', () => {
  assert.match(codeOf(read(MIGRATION)), /do \$pre\$/);
  assert.ok(!/do \$pre\$/.test(codeOf(foldSection())), 'a fold drops the preflight (every dependency is created above it)');
});

test('the client only ever declines a request that is still pending', () => {
  const src = read('src/BookkeeperPro.jsx');
  const at = src.indexOf('const doDecline = async');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\n  };', at));
  assert.match(body, /\.eq\('status', 'pending_review'\)/,
    'a stale card must not be able to re-decide a request (the database refuses it too, since #66)');
});

test('the timeline has a label for a reopened decision', () => {
  const src = read('src/BookkeeperPro.jsx');
  assert.match(src, /decision_reopened:\s*`Decision reopened/,
    'a Super Admin reopen is logged as decision_reopened and must not render as a raw action key');
});
