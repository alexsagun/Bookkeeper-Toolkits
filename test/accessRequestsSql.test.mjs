// ─────────────────────────────────────────────────────────────────────────────
// test/accessRequestsSql.test.mjs — staff activation consistency, #50.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXISTS
//
// Every accepted Operations Admin and Trainer stayed a PENDING STUDENT forever:
// their Auth row was created by generateLink(), handle_new_user() let the column
// DEFAULT apply (approval_status='pending'), and nothing ever cleared it. They
// appeared in the student Access Requests queue, inflated the amber badge, and —
// because access_requests.review is a permission an Ops Admin holds — found their
// own row, with an Approve button, in the queue they had just been given.
//
// This suite pins #50's SQL as text, in BOTH files (the dated migration and its
// bootstrap fold), the staffInviteSql.test.mjs idiom: the shadow-database harness
// needs credentials this environment does not have, so text is the strongest
// always-runnable check, and the runtime half is verified by dry-run against the
// live schema before the migration is applied.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_FILES = [
  'db/2026-08-30-staff-activation-consistency.sql',
  'db/000_full_database_bootstrap.sql',
];
const sqlOf = Object.fromEntries(SQL_FILES.map((f) => [
  f, readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'),
]));

/** The body of the LAST definition of a function in a file (the fold must win). */
function functionBody(sql, name) {
  const marker = `create or replace function public.${name}`;
  const start = sql.lastIndexOf(marker);
  assert.ok(start >= 0, `${name} not defined`);
  const end = sql.indexOf('$fn$;', start);
  const endCat = sql.indexOf('$cat$;', start);
  const stop = end >= 0 && (endCat < 0 || end < endCat) ? end : endCat;
  assert.ok(stop > start, `${name} body unterminated`);
  return sql.slice(start, stop);
}

// ── The approval invariant lives on the ONE trigger that already fires ───────

for (const file of SQL_FILES) {
  const sql = sqlOf[file];
  const short = path.basename(file);

  test(`staff_sync_is_admin() approves a pending profile with an active membership — ${short}`, () => {
    const body = functionBody(sql, 'staff_sync_is_admin');
    assert.match(body, /set approval_status = 'approved'/, 'must write the approval');
    assert.match(body, /p\.approval_status = 'pending'/, 'must be scoped to pending rows only');
    assert.match(body, /m\.status = 'active'/, 'only an ACTIVE membership clears the gate');
  });

  test(`the trigger never launders a ban and never un-approves — ${short}`, () => {
    const body = functionBody(sql, 'staff_sync_is_admin');
    // The ONLY approval_status value the WHERE clause admits is 'pending'. A
    // 'rejected' row is untouched (a staff grant is not a ban appeal) and an
    // 'approved' row is never rewritten (a revoke must not un-approve a person).
    assert.ok(!/approval_status\s*=\s*'rejected'/.test(body),
      'the trigger must not read or write rejected rows');
    assert.ok(!/set approval_status = 'pending'/.test(body),
      'the trigger must never move anyone BACK to pending');
    assert.ok(!/set approval_status = 'rejected'/.test(body),
      'the trigger must never ban anyone');
  });

  test(`is_admin still means active super_admin, and nothing else — ${short}`, () => {
    const body = functionBody(sql, 'staff_sync_is_admin');
    assert.match(body, /m\.role_key = 'super_admin'/,
      'the is_admin recompute must stay pinned to super_admin');
    // The approval half must not touch is_admin, and the is_admin half must not
    // gain a role escape hatch: exactly one `set is_admin` write.
    const writes = body.match(/set is_admin/g) || [];
    assert.equal(writes.length, 1, 'exactly one is_admin write');
  });

  test(`the backfill exists, is idempotent by its own WHERE, and matches the trigger — ${short}`, () => {
    // The backfill is the same UPDATE the trigger runs, outside any function.
    const backfills = sql.split('create or replace function')
      .filter((chunk) => /update public\.profiles p\s+set approval_status = 'approved'/.test(chunk)
        && /where p\.approval_status = 'pending'/.test(chunk));
    assert.ok(backfills.length >= 1, 'the one-time backfill must exist outside the trigger');
  });

  // ── accept_staff_invitation(): the ban, enforced in the database ───────────

  test(`accept_staff_invitation() refuses a rejected profile — ${short}`, () => {
    const body = functionBody(sql, 'accept_staff_invitation');
    assert.match(body, /STAFF_ACCOUNT_REJECTED/, 'the refusal must carry its stable code');
    assert.match(body, /v_approval = 'rejected'/, 'and must key on the profile approval status');
  });

  test(`the #49 markers all survive the #50 rewrite — ${short}`, () => {
    const body = functionBody(sql, 'accept_staff_invitation');
    for (const marker of [
      'for update', "v_m.status = 'active'", "v_m.status <> 'invited'",
      'email_confirmed_at', "set status       = 'active'",
      "'accept', v_m.role_key", "'staff_invite'",
    ]) {
      assert.ok(body.includes(marker), `#49 marker lost: ${marker}`);
    }
  });

  test(`the rejected check comes BEFORE the membership update — ${short}`, () => {
    const body = functionBody(sql, 'accept_staff_invitation');
    assert.ok(body.indexOf('STAFF_ACCOUNT_REJECTED') < body.indexOf("set status       = 'active'"),
      'refusing after the write would not be refusing');
  });

  // ── staff_invitation_state(): the durable fact the screen renders from ─────

  test(`staff_invitation_state() takes no arguments and is self-scoped — ${short}`, () => {
    assert.match(sql, /create or replace function public\.staff_invitation_state\(\)/,
      'no parameters: it can only be asked about the caller');
    const body = functionBody(sql, 'staff_invitation_state');
    assert.match(body, /auth\.uid\(\)/);
    assert.ok(!/p_user/.test(body), 'no user parameter may exist');
  });

  test(`it reports has_password without ever exposing the hash — ${short}`, () => {
    const body = functionBody(sql, 'staff_invitation_state');
    assert.match(body, /coalesce\(u\.encrypted_password, ''\) <> ''/,
      'an OAuth-only identity stores NULL or empty — both must read as "no password"');
    assert.ok(!/'password',/.test(body), 'the hash itself must never be a key in the payload');
    assert.ok(!/'encrypted_password',/.test(body));
  });

  test(`it carries NO permissions and NO authority — ${short}`, () => {
    const body = functionBody(sql, 'staff_invitation_state');
    assert.ok(!/permission/i.test(body.replace(/--[^\n]*/g, '')),
      'my_staff_context() is the only source of authority');
    assert.ok(!/is_admin/.test(body));
  });

  test(`it is granted to authenticated and revoked from anon — ${short}`, () => {
    assert.match(sql, /revoke all on function public\.staff_invitation_state\(\) from public, anon;/);
    assert.match(sql, /grant execute on function public\.staff_invitation_state\(\) to authenticated;/);
  });

  // ── The queue and the badge: one predicate, one gate ───────────────────────

  test(`the Access Requests queue excludes invited and active staff — ${short}`, () => {
    const body = functionBody(sql, 'admin_access_request_queue');
    assert.match(body, /not exists \(\s*select 1 from public\.staff_memberships m/);
    assert.match(body, /m\.status in \('invited', 'active'\)/,
      'exactly these two — a suspended or revoked ex-staffer may be a REAL student');
  });

  test(`suspended and revoked are deliberately NOT hidden from the queue — ${short}`, () => {
    const body = functionBody(sql, 'admin_access_request_queue');
    assert.ok(!/'suspended'/.test(body), 'hiding a suspended ex-staffer would lose a real student');
    assert.ok(!/'revoked'/.test(body));
  });

  test(`the badge count shares the queue's predicate AND its permission gate — ${short}`, () => {
    const body = functionBody(sql, 'admin_access_request_pending_count');
    assert.match(body, /has_staff_permission\('access_requests\.review'\)/,
      'the badge answered through profiles_admin_select RLS before — a different authorization path');
    assert.match(body, /p\.approval_status = 'pending'/);
    assert.match(body, /m\.status in \('invited', 'active'\)/);
  });

  test(`both new read functions return zero rather than erroring for a non-reviewer — ${short}`, () => {
    // The permission test is in the WHERE clause / expression, not an app_error.
    for (const fn of ['admin_access_request_queue', 'admin_access_request_pending_count']) {
      const body = functionBody(sql, fn);
      assert.ok(!/app_error\('FORBIDDEN'/.test(body),
        `${fn} must answer empty, not throw — the #45 shape`);
    }
  });

  // ── Self-review ────────────────────────────────────────────────────────────

  test(`reviewing your own access request is refused — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.match(body, /ACCESS_REQUEST_SELF_REVIEW/);
    assert.match(body, /p_user_id = \(select auth\.uid\(\)\)/);
  });

  test(`the self-review guard exempts a Super Admin, exactly as #48 does — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.match(body, /not public\.is_super_admin\(\)/,
      'the exemption keeps one lockout escape hatch open, mirroring enrollment_self_approval_guard');
  });

  test(`student approval cannot mint staff privileges — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.ok(!/is_admin\s*=/.test(body), 'is_admin is not in the UPDATE list');
    // ★ READING staff_memberships is expected since #51 — that is how the decider
    //   refuses a staff target. What must never appear is a WRITE: the student
    //   approval path has to stay structurally incapable of granting a role.
    assert.ok(!/update public\.staff_memberships/.test(body),
      'the approval path must never write the membership table');
    assert.ok(!/insert into public\.staff_memberships/.test(body));
  });

  // ── The resend audit row #49 declared and never wrote ──────────────────────

  test(`a resent invitation now writes the invite_resent ledger row — ${short}`, () => {
    const body = functionBody(sql, 'admin_record_staff_invite');
    assert.match(body, /'invite_resent'/, "#49 put it in the CHECK; #50 finally writes it");
    assert.match(body, /p_status = 'resent'/, 'and only a real resend produces one');
    assert.ok(!/action_link|token_hash|hashed_token/.test(body),
      'the ledger records who resent to whom — never the link');
  });

  // ── Error-code lockstep ────────────────────────────────────────────────────

  test(`the two #50 codes are in the catalog — ${short}`, () => {
    const cat = functionBody(sql, 'app_error_catalog');
    for (const code of ['STAFF_ACCOUNT_REJECTED', 'ACCESS_REQUEST_SELF_REVIEW']) {
      assert.ok(cat.includes(`('${code}',`), `${code} missing from app_error_catalog()`);
    }
  });
}

test('every #50 code has client copy waiting for it', () => {
  for (const code of ['STAFF_ACCOUNT_REJECTED', 'ACCESS_REQUEST_SELF_REVIEW']) {
    assert.ok(APP_ERROR_CODES.includes(code), `${code} missing from APP_ERROR_CODES`);
    assert.ok((APP_ERROR_COPY[code] || '').length > 20, `${code} needs real user-facing copy`);
  }
});

test('the migration records itself and the bootstrap folds it', () => {
  assert.match(sqlOf[SQL_FILES[0]],
    /insert into public\.schema_migrations \(filename, checksum, notes\) values\s*\n?\s*\('2026-08-30-staff-activation-consistency\.sql'/);
  assert.match(sqlOf[SQL_FILES[1]],
    /§37\) FOLDED VERBATIM — 2026-08-30-staff-activation-consistency\.sql/);
});

// ── #51: the decider refuses exactly what the queue hides ───────────────────
// admin_review_access_request() is granted to `authenticated` and gated only on
// access_requests.review — a permission Operations Admins hold — so hiding staff
// rows from the queue is a UI fact, not a boundary: a direct PostgREST call takes
// any uuid.

const SQL_51 = [
  'db/2026-08-31-access-request-staff-target.sql',
  'db/000_full_database_bootstrap.sql',
];
const sql51 = Object.fromEntries(SQL_51.map((f) => [
  f, readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'),
]));

for (const file of SQL_51) {
  const sql = sql51[file];
  const short = path.basename(file);

  test(`the decider refuses an invited or active staff target — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.match(body, /ACCESS_REQUEST_STAFF_TARGET/);
    assert.match(body, /m\.status in \('invited', 'active'\)/,
      'the same predicate the queue and the badge count use');
  });

  test(`suspended and revoked stay reviewable — a former staffer may be a real student — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.ok(!/'suspended'/.test(body));
    assert.ok(!/'revoked'/.test(body));
  });

  test(`the staff check runs BEFORE the profile is written — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.ok(
      body.indexOf('ACCESS_REQUEST_STAFF_TARGET') < body.indexOf('update public.profiles'),
      'refusing after the write would not be refusing',
    );
  });

  test(`there is NO Super Admin exemption on the staff-target refusal — ${short}`, () => {
    // Unlike the self-review guard (where the exemption grants a Super Admin
    // nothing they did not already have), this is the wrong tool for everyone:
    // withdrawing staff access is admin_set_staff_status(), which is audited.
    const body = functionBody(sql, 'admin_review_access_request');
    const staffBlock = body.slice(body.indexOf('#51'), body.indexOf('ACCESS_REQUEST_STAFF_TARGET') + 200);
    assert.ok(!/is_super_admin/.test(staffBlock),
      'the staff-target branch must apply to every reviewer');
    assert.match(body, /not public\.is_super_admin\(\)/,
      "but #50's self-review exemption must survive");
  });

  test(`#50's self-review guard survives the #51 rewrite — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.match(body, /ACCESS_REQUEST_SELF_REVIEW/);
    assert.match(body, /p_user_id = \(select auth\.uid\(\)\)/);
  });

  test(`student approval still cannot mint staff privileges — ${short}`, () => {
    const body = functionBody(sql, 'admin_review_access_request');
    assert.ok(!/is_admin\s*=/.test(body), 'is_admin is not in the UPDATE list');
    assert.ok(!/update public\.staff_memberships/.test(body),
      'the approval path must never write the membership table');
  });

  test(`the #51 code is in the catalog — ${short}`, () => {
    const cat = functionBody(sql, 'app_error_catalog');
    assert.ok(cat.includes("('ACCESS_REQUEST_STAFF_TARGET',"));
  });
}

test('the #51 code has client copy waiting for it', () => {
  assert.ok(APP_ERROR_CODES.includes('ACCESS_REQUEST_STAFF_TARGET'));
  assert.ok((APP_ERROR_COPY.ACCESS_REQUEST_STAFF_TARGET || '').length > 20);
});

test('#51 records itself and the bootstrap folds it', () => {
  assert.match(sql51[SQL_51[0]],
    /insert into public\.schema_migrations \(filename, checksum, notes\) values\s*\n?\s*\('2026-08-31-access-request-staff-target\.sql'/);
  assert.match(sql51[SQL_51[1]],
    /§38\) FOLDED VERBATIM — 2026-08-31-access-request-staff-target\.sql/);
});

test('#51 preflights on #50 rather than assuming it ran', () => {
  // Running #51 first would drop #50's self-review guard and its error code.
  assert.match(sql51[SQL_51[0]], /ACCESS_REQUEST_SELF_REVIEW'\s*\n?\s*\)\s*then/);
});
