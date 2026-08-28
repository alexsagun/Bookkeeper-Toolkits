// test/staffInviteSql.test.mjs — #49's SQL, pinned in BOTH files.
//
// WHY BOTH. db/2026-08-29-…sql is what an existing project runs; §36 of
// db/000_full_database_bootstrap.sql is what a fresh install gets. They drift
// silently — this repo has been bitten by fold/apply drift three times (#20/#21,
// #37b, and the §29 re-fold that deleted all 535 lines of §30) — and a drift here
// would mean a new install where nobody can accept an invitation at all.
//
// Reads SQL as TEXT. No database, no credentials.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-08-29-staff-invitation-acceptance.sql';
const HARDENING = 'db/2026-08-28-authorization-hardening.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const SQL_FILES = [MIGRATION, BOOTSTRAP];

/** Executable SQL only — the header prose quotes SQL and names every identifier. */
const statementsOf = (sql) => sql
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

const NEW_CODES = ['STAFF_NO_INVITATION', 'STAFF_INVITATION_NOT_PENDING', 'STAFF_EMAIL_NOT_VERIFIED'];

// ── The acceptance RPC ──────────────────────────────────────────────────────

test('accept_staff_invitation() takes NO arguments, in both files', () => {
  // ★ The property that makes it obviously incapable of naming another user or
  //   choosing a role. A single added parameter is a security review in itself.
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    assert.match(sql, /create or replace function public\.accept_staff_invitation\(\)/,
      `${f}: must be declared with an empty parameter list`);
  }
});

test('it is SECURITY DEFINER with a pinned search_path, in both files', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const body = sql.slice(sql.indexOf('function public.accept_staff_invitation()'));
    const head = body.slice(0, 400);
    assert.match(head, /security definer/, `${f}`);
    assert.match(head, /set search_path = public, pg_temp/,
      `${f}: an unpinned search_path on a SECURITY DEFINER function is a privilege-escalation vector`);
  }
});

test('it is revoked from anon and granted only to authenticated, in both files', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    assert.match(sql, /revoke all on function public\.accept_staff_invitation\(\) from public, anon;/, `${f}`);
    assert.match(sql, /grant execute on function public\.accept_staff_invitation\(\) to authenticated;/, `${f}`);
  }
});

test('it locks the row, and only ever transitions FROM invited', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const body = sql.slice(sql.indexOf('function public.accept_staff_invitation()'));
    const fn = body.slice(0, body.indexOf('$fn$;') + 5);
    assert.match(fn, /for update/,
      `${f}: without a row lock a double-click writes twice and audits twice`);
    assert.match(fn, /v_m\.status = 'active'/, `${f}: the idempotent replay branch`);
    assert.match(fn, /v_m\.status <> 'invited'/,
      `${f}: suspended and revoked must be refused, not reactivated`);
    assert.match(fn, /email_confirmed_at/,
      `${f}: an unconfirmed identity has not proven it owns the invited mailbox`);
    assert.match(fn, /set\s+status\s+=\s+'active'/, `${f}`);
  }
});

test('it never reads user metadata', () => {
  // raw_user_meta_data.invited_as is DISPLAY ONLY and user-editable. Reading it
  // for authorization would let anyone name their own role.
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const body = sql.slice(sql.indexOf('function public.accept_staff_invitation()'));
    const fn = body.slice(0, body.indexOf('$fn$;') + 5);
    assert.ok(!/raw_user_meta_data|user_metadata|invited_as/.test(fn),
      `${f}: metadata must never reach an authorization decision`);
  }
});

test('it writes exactly one audit row, as the invitee, from the invitation flow', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const body = sql.slice(sql.indexOf('function public.accept_staff_invitation()'));
    const fn = body.slice(0, body.indexOf('$fn$;') + 5);
    assert.match(fn, /insert into public\.staff_role_events/, `${f}`);
    assert.match(fn, /'accept'/, `${f}`);
    assert.match(fn, /'staff_invite'/, `${f}`);
    assert.match(fn, /'invited', 'active'/, `${f}: from_status → to_status must be recorded`);
  }
});

// ── The audit vocabulary the RPC depends on ─────────────────────────────────

test('the action CHECK admits accept and invite_resent, and keeps every old value', () => {
  const REQUIRED = ['bootstrap', 'invite', 'assign', 'role_change', 'suspend',
    'reactivate', 'revoke', 'accept', 'invite_resent'];
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('staff_role_events_action_check');
    assert.ok(i > 0, `${f}: the action CHECK must be (re)stated`);
    const block = sql.slice(i, i + 500);
    for (const v of REQUIRED) {
      assert.ok(block.includes(`'${v}'`),
        `${f}: dropping '${v}' from the action CHECK breaks every write that uses it`);
    }
  }
});

test('the source CHECK admits staff_invite, and keeps every old value', () => {
  const REQUIRED = ['admin_ui', 'bootstrap_script', 'migration', 'sql', 'staff_invite'];
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('staff_role_events_source_check');
    assert.ok(i > 0, `${f}`);
    const block = sql.slice(i, i + 400);
    for (const v of REQUIRED) assert.ok(block.includes(`'${v}'`), `${f}: missing source '${v}'`);
  }
});

test('the invite_status CHECK matches the four states the API writes', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('staff_memberships_invite_status_check');
    assert.ok(i > 0, `${f}`);
    const block = sql.slice(i, i + 400);
    for (const v of ['pending', 'sent', 'failed', 'resent']) {
      assert.ok(block.includes(`'${v}'`), `${f}: missing invite_status '${v}'`);
    }
  }
});

// ── my_staff_context() ──────────────────────────────────────────────────────

test('my_staff_context() gates every authority field on active, in both files', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('create or replace function public.my_staff_context()');
    assert.ok(i > 0, `${f}`);
    const fn = sql.slice(i, sql.indexOf('$fn$;', i) + 5);

    assert.match(fn, /'is_staff',\s+\(m\.status = 'active'\)/, `${f}`);
    assert.match(fn, /'permissions',\s+case when m\.status = 'active'/,
      `${f}: an unaccepted invitation must not report permissions — that is what #49 fixes`);
    assert.match(fn, /'role_key',\s+case when m\.status = 'active'/, `${f}`);
    assert.match(fn, /'assigned_course_ids', case when m\.status = 'active'/,
      `${f}: #46's field must stay, and must be gated too`);
  }
});

test('the membership block carries NO permission list', () => {
  // The structural guarantee: there is no field to read, so no boolean to invert.
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('create or replace function public.my_staff_context()');
    const fn = sql.slice(i, sql.indexOf('$fn$;', i) + 5);
    const m = /'membership',\s+jsonb_build_object\(([\s\S]*?)\n\s+\)/.exec(fn);
    assert.ok(m, `${f}: my_staff_context() must emit a membership object`);
    assert.ok(!/permission/i.test(m[1]),
      `${f}: the descriptive membership must never carry permissions`);
    for (const k of ['exists', 'status', 'role_key', 'role_label']) {
      assert.ok(m[1].includes(`'${k}'`), `${f}: membership.${k} is needed by the invitation screen`);
    }
  }
});

test('a caller with no membership still gets a well-formed answer', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('create or replace function public.my_staff_context()');
    const fn = sql.slice(i, sql.indexOf('$fn$;', i) + 5);
    assert.match(fn, /'membership', jsonb_build_object\('exists', false\)/,
      `${f}: the no-membership fallback must still say so explicitly`);
  }
});

// ── The write path stays server-side ────────────────────────────────────────

test('admin_record_staff_invite() is capability-gated and scrubs its error code', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('create or replace function public.admin_record_staff_invite(');
    assert.ok(i > 0, `${f}`);
    const fn = sql.slice(i, sql.indexOf('$fn$;', i) + 5);
    assert.match(fn, /has_staff_permission\('staff\.manage'\)/, `${f}`);
    assert.match(fn, /regexp_replace/,
      `${f}: the code is rendered in an admin UI and must never carry provider prose`);
    assert.match(fn, /left\(/, `${f}: and must be length-bounded`);
  }
});

test('set_my_display_name() touches full_name only — never email, never a role', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('create or replace function public.set_my_display_name(');
    assert.ok(i > 0, `${f}`);
    const fn = sql.slice(i, sql.indexOf('$fn$;', i) + 5);
    const profileUpdate = /update public\.profiles([\s\S]*?);/.exec(fn);
    assert.ok(profileUpdate, `${f}`);
    assert.ok(!/\bemail\b|\bis_admin\b|\bplan\b|approval_status/.test(profileUpdate[1]),
      `${f}: widening this to other columns would reopen the hole #45 closed by revoking `
      + 'UPDATE on profiles from every client role');
    assert.match(fn, /auth\.uid\(\)/, `${f}: it must be pinned to the caller`);
  }
});

test('the membership table is never given a client write policy', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    // #49 must not create one; the guarded RPCs are the only writers.
    const created = sql.match(/create policy[^;]*on public\.staff_memberships[^;]*;/gi) || [];
    for (const p of created) {
      assert.ok(!/for (insert|update|delete|all)/i.test(p),
        `${f}: #49 must not add a client write policy to staff_memberships — ${p.slice(0, 80)}`);
    }
  }
});

// ── Error-code lockstep ─────────────────────────────────────────────────────

test('every #49 code has client copy waiting for it', () => {
  for (const code of NEW_CODES) {
    assert.ok(APP_ERROR_CODES.includes(code),
      `${code} is raised by #49 but missing from APP_ERROR_CODES — appErrorCode() validates the `
      + 'hint against that set, so an unlisted code is discarded and the user sees a fallback');
    assert.ok(APP_ERROR_COPY[code] && APP_ERROR_COPY[code].length > 20,
      `${code} needs a sentence in APP_ERROR_COPY that names the next action`);
  }
});

test('every #49 code is registered in the SQL catalog, in both files', () => {
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    for (const code of NEW_CODES) {
      assert.ok(sql.includes(`('${code}',`),
        `${f}: app_error_catalog() is replaced wholesale, so ${code} must be re-listed there`);
    }
  }
});

// ── The directory ───────────────────────────────────────────────────────────

test('admin_staff_directory() is DROPped before CREATE and re-granted', () => {
  // ★ A return-type change cannot be done with CREATE OR REPLACE (42P13 — the
  //   exact failure #39 hit on admin_batch_overview and #45 shipped once). And a
  //   DROP takes the GRANT with it, so an un-restated grant means "permission
  //   denied for function" for every admin.
  for (const f of SQL_FILES) {
    const sql = statementsOf(read(f));
    const i = sql.lastIndexOf('drop function if exists public.admin_staff_directory()');
    assert.ok(i > 0, `${f}: must DROP before CREATE`);
    const after = sql.slice(i);
    assert.match(after, /create function public\.admin_staff_directory\(\)/, `${f}`);
    assert.match(after, /grant execute on function public\.admin_staff_directory\(\) to authenticated;/,
      `${f}: the grant must be restated after the drop`);
    for (const col of ['invite_sent_at', 'invite_status', 'invite_error_code']) {
      assert.ok(after.includes(col), `${f}: the directory must expose ${col}`);
    }
  }
});

// ── The fold ────────────────────────────────────────────────────────────────

test('the migration records itself and the bootstrap folds it', () => {
  assert.match(statementsOf(read(MIGRATION)),
    /insert into public\.schema_migrations[\s\S]*2026-08-29-staff-invitation-acceptance\.sql/,
    'a migration that does not record itself will be reported unapplied forever');
  assert.match(read(BOOTSTRAP), /§36\)\s*FOLDED VERBATIM\s*—\s*2026-08-29-staff-invitation-acceptance\.sql/,
    'a fresh install must get #49 too');
});

// ── #48's column grant on enrollment_requests ───────────────────────────────
// Lives here rather than in its own file because #48 and #49 deploy together and
// this is the invariant that keeps an Operations Admin — the role #49 exists to
// let you hire — from granting a plan nobody paid for.

const REVIEWER_COLUMNS = [
  'status', 'rejection_reason', 'reviewed_at', 'reviewed_by', 'admin_notes', 'updated_at',
];
// Rewriting any of these is a grant, a re-assignment, or a forged payment.
const FORBIDDEN_COLUMNS = [
  'plan_key', 'user_id', 'amount_paid', 'amount_expected', 'request_kind',
  'extension_days', 'batch_id', 'receipt_path',
];

test('the reviewer UPDATE is bounded by a column GRANT, in both files', () => {
  // ★ RLS HAS NO COLUMN GRANULARITY. enroll_req_staff_update lets an
  //   enrollments.review holder UPDATE the row; without this grant that means
  //   EVERY column, so they could rewrite another student's pending request to
  //   plan_key='vip' and approve it through admin_finalize_enrollment(), which
  //   reads plan_key straight off the row. GRANT is where the granularity lives —
  //   the same idiom #38 uses for batches.code.
  for (const f of [HARDENING, 'db/000_full_database_bootstrap.sql']) {
    const sql = statementsOf(read(f));
    assert.match(sql, /revoke update on public\.enrollment_requests from authenticated;/,
      `${f}: the blanket table-level UPDATE must be revoked first — a column grant `
      + 'does NOT override a table grant');

    const m = /grant update \(([^)]*)\)\s*on public\.enrollment_requests to authenticated;/.exec(sql);
    assert.ok(m, `${f}: the reviewer needs an explicit column grant`);
    const granted = m[1].split(',').map((c) => c.trim());

    assert.deepEqual([...granted].sort(), [...REVIEWER_COLUMNS].sort(),
      `${f}: the granted columns must be exactly what the three client UPDATE paths write`);
    for (const col of FORBIDDEN_COLUMNS) {
      assert.ok(!granted.includes(col),
        `${f}: granting ${col} to a reviewer re-opens the escalation this closes`);
    }
  }
});

test('the revoke comes BEFORE the grant, or the grant is undone', () => {
  for (const f of [HARDENING, 'db/000_full_database_bootstrap.sql']) {
    const sql = statementsOf(read(f));
    const revoke = sql.indexOf('revoke update on public.enrollment_requests');
    const grant = sql.indexOf('grant update (status');
    assert.ok(revoke > 0 && grant > revoke,
      `${f}: ordering matters — revoking after granting would strip the grant`);
  }
});
