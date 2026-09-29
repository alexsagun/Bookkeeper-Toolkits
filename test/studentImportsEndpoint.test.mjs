// ─────────────────────────────────────────────────────────────────────────────
// test/studentImportsEndpoint.test.mjs — api/admin/student-imports.js, end to end (#68).
// ─────────────────────────────────────────────────────────────────────────────
// What #68 changed in the migration endpoint, pinned by driving the real handler:
//   • readiness: the sender is support@<RESEND_FROM's domain> unless MIGRATION_EMAIL_FROM
//     says otherwise, replies go to support@alexsagun.com, senderProven compares domains,
//     and a run cannot start without a well-formed sender;
//   • the CIRCUIT BREAKER: a 401/403/429 (or a missing configuration) stops a run at the
//     first row, hands that row back to `not_sent`, and pauses the run; a 422 stops it only
//     on two rows in a row; so does an Auth failure — a claim link that could not be minted,
//     or an old password that could not be replaced ('auth_unavailable', V1); a 429 whose
//     body names Resend's per-second rate stops as 'email_rate_limited', not the quota (V5);
//   • sendEmail: a 429/4xx after an unanswered attempt is unclear, never "nothing sent" (V4);
//   • E8 is durable: every CLAIM send replaces a pre-existing unconfirmed account's password
//     first, and holds the link back (rotation_failed) when it cannot (V3);
//   • owed invitations are sent BEFORE any new row is claimed, so a Resume against a sender
//     still refused grants nobody new;
//   • pass 2's p_exclude, and a begin_invite that records a hopeless invitation itself;
//   • a stale lease answers with busyUntil, and the lease is released on that path too;
//   • `resend-failed`: failed rows only (uncertain on request), resend: true, never handed
//     back, stopped by the same breaker, and never to a student who has already onboarded (V6);
//   • `send-test`: both addresses, a message naming the real domain, click tracking;
//   • `reset-onboarding-notice`, and staging's eligible_plan_keys.
//
// No network. globalThis.fetch is a router keyed on URL; an unexpected URL throws.
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPA = 'https://student-imports-test.supabase.example';
const ANON = 'anon-key-for-student-imports-tests';
const SERVICE = 'service-key-for-student-imports-tests';
process.env.VITE_SUPABASE_URL = SUPA;
process.env.VITE_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SECRET_KEY = SERVICE;   // read at module load by api/_lib/staffAuth.js
const mod = await import('../api/admin/student-imports.js');
const {
  default: handler, invitationBreaker, sendTestMessage,
  AUTH_FAILURE_CODES, MAX_INVITE_GENERATION, NOTHING_SENT_CODES, STOP_CODES,
} = mod;
const { sendEmail, resendLimitKind } = await import('../api/_lib/email.js');

const SUPER = {
  is_staff: true, role_key: 'super_admin', role_label: 'Super Admin', status: 'active', is_super_admin: true,
  permissions: ['students.legacy_migrate'], assigned_course_ids: [],
  membership: { exists: true, status: 'active', role_key: 'super_admin' },
};
const RUN = '0b0b0b0b-1111-4222-8333-444444444444';
const JOB = '0c0c0c0c-1111-4222-8333-444444444444';
const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The account bound to row id(n): id(900 + n), as row(n) below says. */
const userOf = (rowId) => id(900 + Number(String(rowId).slice(-12)));
const LEASE_UNTIL = '2026-09-28T09:15:30.000Z';

let savedFetch; let savedEnv; let savedErr; let caller; let calls;

const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
/** A PostgREST error as app_error() raises it: the code in `hint`, context in `details`. */
const appError = (hint, context = null, status = 400) => ({
  __error: { code: 'P0001', message: 'refused', hint, details: JSON.stringify({ context }) }, status,
});

/**
 * @param {object} o
 * @param {object} [o.rpc]            fn → (args, n) => body | appError(...)   (n: 0-based call index)
 * @param {Array}  [o.claimQueue]     rows legacy_import_claim_rows hands out, one per call
 * @param {Array}  [o.pending]        row ids legacy_import_pending_invites knows are owed
 * @param {(body, n) => number} [o.resendStatus]  the provider's answer per message
 * @param {Array}  [o.failedRows]     what the resend-failed read returns
 * @param {object} [o.domains]        { list: {status, body}, detail: {status, body} }
 * @param {Array|{status, body}} [o.runLease]  what the run's lease_until read returns
 * @param {number} [o.pwdStatus]      Auth's answer to updateUserById (default 200)
 * @param {'claim'|'notify'} [o.kind] the kind the default begin_invite answers (default notify)
 * @param {Array|{status, body}} [o.rowFlags]  the E8 read of a row's account facts
 *                                    (default: an account the import created — no rotation)
 * @param {Array|{status, body}} [o.profiles]  resend-failed's onboarding read (default [])
 * @param {(body, n) => object} [o.resendBody]  the provider's error body per message
 * @param {(body, n) => object} [o.resendHeaders] the provider's response headers per message
 */
function install(o = {}) {
  caller = crypto.randomUUID();   // the burst limiter is per caller, at module scope
  calls = { rpc: [], resend: [], selects: [], genLink: 0, pwd: [], seq: [], flagReads: [], profileReads: [] };
  const claimQueue = [...(o.claimQueue || [])];
  let generation = 0;
  const count = {};
  const defaults = {
    legacy_import_pending_invites: (a) => (o.pending || []).filter((x) => !(a.p_exclude || []).includes(x)).slice(0, 1),
    legacy_import_claim_rows: () => (claimQueue.length ? [claimQueue.shift()] : []),
    legacy_import_bind_user: () => ({ ok: true, created: false, confirmed: true }),
    legacy_import_activate_row: () => ({ ok: true, status: 'active' }),
    legacy_import_begin_invite: (a) => ({
      ok: true, skip: false, generation: (generation += 1), kind: o.kind || 'notify',
      email: `student-${a.p_row_id.slice(-4)}@example.test`, full_name: 'Sam Student',
      user_id: userOf(a.p_row_id),
      plan_key: 'vip', plan_name: 'VIP Package', batch_name: 'October 2026',
      start_date: '2026-10-12', end_date: '2027-04-12',
    }),
    legacy_import_record_delivery: () => true,
    legacy_import_release_run: (a) => ({ ok: true, run_id: a.p_run_id, status: a.p_pause ? 'paused' : 'running', remaining: 0 }),
    legacy_import_mark_failed: () => true,
    legacy_import_reset_onboarding_notice: () => ({ ok: true }),
    legacy_import_stage: () => ({ ok: true, job_id: JOB }),
  };
  const handlers = { ...defaults, ...(o.rpc || {}) };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === `${SUPA}/auth/v1/user`) return res({ id: caller, email: 'owner@example.test' });
    if (u === `${SUPA}/rest/v1/rpc/my_staff_context`) return res(SUPER);
    const m = new RegExp(`^${SUPA.replace(/[.]/g, '\\.')}/rest/v1/rpc/([a-z_]+)$`).exec(u);
    if (m) {
      const fn = m[1];
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${SERVICE}`, `${fn}: the service client`);
      const args = JSON.parse(init.body || '{}');
      assert.equal(args.p_actor, caller, `${fn}: p_actor is the verified caller`);
      calls.rpc.push({ fn, args });
      calls.seq.push(fn);
      const h = handlers[fn];
      if (!h) throw new Error(`unexpected rpc: ${fn}`);
      count[fn] = (count[fn] || 0) + 1;
      const out = h(args, count[fn] - 1);
      if (out && out.__error) return res(out.__error, out.status || 400);
      return res(out);
    }
    if (u.startsWith(`${SUPA}/rest/v1/student_import_rows?`) && decodeURIComponent(u).includes('select=matched_existing,')) {
      assert.equal((init.method || 'GET').toUpperCase(), 'GET', 'the endpoint only READS import rows');
      calls.flagReads.push(u);
      calls.seq.push('read.rowFlags');
      const f = o.rowFlags;
      if (f && !Array.isArray(f)) return res(f.body, f.status);
      return res(f || [{ matched_existing: false, existing_confirmed: false, auth_user_created: true }]);
    }
    if (u.startsWith(`${SUPA}/rest/v1/student_import_rows?`)) {
      assert.equal((init.method || 'GET').toUpperCase(), 'GET', 'the endpoint only READS import rows');
      calls.selects.push(u);
      return res(o.failedRows || []);
    }
    if (u.startsWith(`${SUPA}/rest/v1/profiles?`)) {
      assert.equal((init.method || 'GET').toUpperCase(), 'GET', 'the endpoint only READS profiles');
      calls.profileReads.push(u);
      const p = o.profiles;
      if (p && !Array.isArray(p)) return res(p.body, p.status);
      return res(p || []);
    }
    if (u.startsWith(`${SUPA}/rest/v1/enrollment_plans?`)) {
      calls.selects.push(u);
      return res(o.plans || [{ key: 'vip', name: 'VIP Package' }]);
    }
    if (u.startsWith(`${SUPA}/rest/v1/batches?`)) return res(o.batches || []);
    if (u.startsWith(`${SUPA}/rest/v1/student_import_activation_runs?`)) {
      assert.equal((init.method || 'GET').toUpperCase(), 'GET', 'the endpoint only READS a run');
      calls.selects.push(u);
      const l = o.runLease;
      return l && !Array.isArray(l) ? res(l.body, l.status) : res(l || []);
    }
    if (u === `${SUPA}/auth/v1/admin/users/${caller}`) return res({ id: caller, email: 'owner@example.test' });
    const pw = new RegExp(`^${SUPA.replace(/[.]/g, '\\.')}/auth/v1/admin/users/([0-9a-f-]{36})$`).exec(u);
    if (pw && (init.method || 'GET').toUpperCase() === 'PUT') {
      const body = JSON.parse(init.body || '{}');
      calls.pwd.push({ uid: pw[1], body });
      calls.seq.push('auth.updateUserById');
      const status = o.pwdStatus || 200;
      return status === 200 ? res({ id: pw[1], email: 'x@example.test' }) : res({ msg: 'no' }, status);
    }
    if (u === `${SUPA}/auth/v1/admin/generate_link`) {
      calls.genLink += 1;
      calls.seq.push('auth.generateLink');
      return o.linkFails ? res({ msg: 'no' }, 500)
        : res({ id: 'u', email: 'x@example.test', hashed_token: 'HASHED-TOKEN', action_link: 'https://unused.example/verify' });
    }
    if (u === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      calls.resend.push({ body, key: init.headers?.['Idempotency-Key'] });
      calls.seq.push('resend.send');
      const n = calls.resend.length - 1;
      const status = o.resendStatus ? o.resendStatus(body, n) : 200;
      if (status === 200) return res({ id: `e-${calls.resend.length}` });
      return new Response(JSON.stringify(o.resendBody ? o.resendBody(body, n) : { message: 'no' }),
        { status, headers: o.resendHeaders ? o.resendHeaders(body, n) : {} });
    }
    if (u === 'https://api.resend.com/domains') {
      const d = o.domains?.list || { status: 200, body: { data: [{ id: 'dom-1', name: 'toolkits.example.test' }] } };
      return res(d.body, d.status);
    }
    if (u === 'https://api.resend.com/domains/dom-1') {
      const d = o.domains?.detail || { status: 200, body: { id: 'dom-1', name: 'toolkits.example.test', click_tracking: false } };
      return res(d.body, d.status);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function call(body) {
  const req = { method: 'POST', headers: { authorization: 'Bearer caller-token', host: 'localhost:5173' }, body };
  const out = { statusCode: 200, body: null };
  const r = {
    status(c) { out.statusCode = c; return r; },
    json(b) { out.body = b; return r; },
  };
  await handler(req, r);
  return out;
}

const rpcCalls = (fn) => calls.rpc.filter((c) => c.fn === fn);
const row = (n) => ({ row_id: id(n), email: `s${n}@example.test`, target_user_id: id(900 + n), full_name: `Student ${n}` });

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedEnv = { ...process.env };
  savedErr = console.error;
  console.error = () => {};
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits by Alex <noreply@toolkits.example.test>';
  process.env.APP_URL = 'https://toolkits.example.test';
  delete process.env.MIGRATION_EMAIL_FROM;
  delete process.env.MIGRATION_REPLY_TO;
  delete process.env.MIGRATION_DAILY_EMAIL_CAP;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = savedEnv;
  console.error = savedErr;
});

// ── Pure pieces ──────────────────────────────────────────────────────────────────────

test('the stop codes and the nothing-sent codes are exactly the agreed lists', () => {
  assert.deepEqual({ ...STOP_CODES }, {
    email_not_configured: 'email_unconfigured',
    email_from_not_configured: 'email_unconfigured',
    resend_401: 'sender_refused',
    resend_403: 'sender_refused',
    resend_429: 'email_quota',
  });
  // Mirrors legacy_import_record_delivery's hand-back list. Nothing the provider might have
  // acted on is on it: a timeout, a 5xx or a 409 may already be in the inbox.
  assert.deepEqual([...NOTHING_SENT_CODES].sort(), [
    'app_url_missing', 'email_from_not_configured', 'email_not_configured', 'link_failed',
    'resend_401', 'resend_403', 'resend_429',
  ]);
  for (const c of ['resend_422', 'resend_timeout', 'resend_failed', 'resend_409', 'resend_500']) {
    assert.ok(!NOTHING_SENT_CODES.has(c), `${c} may have been delivered`);
  }
  // Supabase Auth's part: a link that could not be minted, an old password not replaced.
  assert.deepEqual([...AUTH_FAILURE_CODES].sort(), ['link_failed', 'rotation_failed']);
  // ★ rotation_failed is recorded `failed`, never handed back: the SQL's hand-back list does not
  //   carry it, so a run's pass 1 cannot spend a generation on it chunk after chunk.
  assert.ok(!NOTHING_SENT_CODES.has('rotation_failed'));
});

test('V1: two Auth failures in a row stop as auth_unavailable; a delivered email or a provider answer ends the streak', () => {
  let b = invitationBreaker();
  assert.equal(b({ state: 'not_sent', code: 'link_failed' }), null, 'one link can be one account\'s problem');
  assert.equal(b({ state: 'not_sent', code: 'link_failed' }), 'auth_unavailable');
  b = invitationBreaker();
  assert.equal(b({ state: 'failed', code: 'rotation_failed' }), null);
  assert.equal(b({ state: 'not_sent', code: 'link_failed' }), 'auth_unavailable', 'both are Supabase Auth failing');
  for (const between of [{ state: 'sent', code: null }, { state: 'notified', code: null },
    { state: 'uncertain', code: 'resend_500' }, { state: 'failed', code: 'resend_422' }]) {
    b = invitationBreaker();
    assert.equal(b({ state: 'not_sent', code: 'link_failed' }), null);
    assert.equal(b(between), null);
    assert.equal(b({ state: 'not_sent', code: 'link_failed' }), null, `ended by ${JSON.stringify(between)}`);
  }
  // Not a provider answer: neither trips it nor breaks the streak.
  for (const between of [{ state: 'skipped', code: null }, { state: 'failed', code: 'account_missing' },
    { state: 'error', code: 'LEGACY_ROW_NOT_READY' }]) {
    b = invitationBreaker();
    assert.equal(b({ state: 'not_sent', code: 'link_failed' }), null);
    assert.equal(b(between), null);
    assert.equal(b({ state: 'not_sent', code: 'link_failed' }), 'auth_unavailable', `kept across ${JSON.stringify(between)}`);
  }
  // …and an Auth failure is not a provider answer either: it does not end a 422 streak.
  b = invitationBreaker();
  assert.equal(b({ state: 'failed', code: 'resend_422' }), null);
  assert.equal(b({ state: 'not_sent', code: 'link_failed' }), null);
  assert.equal(b({ state: 'failed', code: 'resend_422' }), 'invalid_request');
});

test('V5: a 429 naming the per-second rate stops as email_rate_limited; any other 429 is the quota', () => {
  assert.equal(invitationBreaker()({ state: 'not_sent', code: 'resend_429', limit: 'rate' }), 'email_rate_limited');
  assert.equal(invitationBreaker()({ state: 'not_sent', code: 'resend_429', limit: 'quota' }), 'email_quota');
  assert.equal(invitationBreaker()({ state: 'not_sent', code: 'resend_429' }), 'email_quota', 'unknown is the quota');
  assert.equal(invitationBreaker()({ state: 'failed', code: 'resend_403', limit: 'rate' }), 'sender_refused',
    'a limit only means something on a 429');
});

test('V5: resendLimitKind reads the cause from the error name, and anything unrecognised is the quota', () => {
  assert.equal(resendLimitKind({ name: 'rate_limit_exceeded', message: 'Too many requests. You can only make 2 requests per second.' }), 'rate');
  assert.equal(resendLimitKind({ name: 'RATE_LIMIT_EXCEEDED' }), 'rate');
  assert.equal(resendLimitKind({ message: 'Too many requests' }), 'rate', 'no name, a message that names only the rate');
  assert.equal(resendLimitKind({ name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }), 'quota');
  assert.equal(resendLimitKind({ name: 'monthly_quota_exceeded' }), 'quota');
  assert.equal(resendLimitKind({ name: 'rate_limit_exceeded', message: 'daily sending quota reached' }), 'quota',
    'a body that names an allowance anywhere is the quota');
  assert.equal(resendLimitKind({ name: 'rate_limit_exceeded', retryAfter: '3600' }), 'quota',
    'an hour\'s wait is not a per-second limit');
  assert.equal(resendLimitKind({ name: 'rate_limit_exceeded', retryAfter: '1' }), 'rate');
  for (const o of [{}, undefined, { name: 42 }, { name: 'something_new' }, { message: 'no' }]) {
    assert.equal(resendLimitKind(o), 'quota', JSON.stringify(o));
  }
});

test('the breaker: one refusal stops at once; a 422 only twice in a row', () => {
  let b = invitationBreaker();
  assert.equal(b({ state: 'not_sent', code: 'resend_403' }), 'sender_refused');
  b = invitationBreaker();
  assert.equal(b({ state: 'not_sent', code: 'resend_401' }), 'sender_refused');
  b = invitationBreaker();
  assert.equal(b({ state: 'not_sent', code: 'resend_429' }), 'email_quota');
  b = invitationBreaker();
  assert.equal(b({ state: 'not_sent', code: 'email_not_configured' }), 'email_unconfigured');
  b = invitationBreaker();
  assert.equal(b({ state: 'failed', code: 'resend_422' }), null);
  assert.equal(b({ state: 'failed', code: 'resend_422' }), 'invalid_request');
  // A delivered email, or another provider answer, ends the streak.
  b = invitationBreaker();
  assert.equal(b({ state: 'failed', code: 'resend_422' }), null);
  assert.equal(b({ state: 'sent', code: null }), null);
  assert.equal(b({ state: 'failed', code: 'resend_422' }), null);
  assert.equal(b({ state: 'uncertain', code: 'resend_500' }), null);
  assert.equal(b({ state: 'failed', code: 'resend_422' }), null);
  // Not a provider answer: neither trips it nor breaks a streak.
  b = invitationBreaker();
  assert.equal(b({ state: 'failed', code: 'resend_422' }), null);
  assert.equal(b({ state: 'failed', code: 'account_missing' }), null);
  assert.equal(b({ state: 'error', code: 'LEGACY_ROW_NOT_READY' }), null);
  assert.equal(b({ state: 'skipped', code: null }), null);
  assert.equal(b({ state: 'failed', code: 'resend_422' }), 'invalid_request');
  for (const c of ['link_failed', 'resend_timeout', 'resend_409', 'recipient_invalid']) {
    assert.equal(invitationBreaker()({ state: 'failed', code: c }), null, c);
  }
});

test('send-test copy names the real sender domain, per code, and never a hard-coded one', () => {
  const ctx = { from: 'Toolkits by Alex Support <support@toolkits.example.test>', fromDomain: 'toolkits.example.test', replyTo: 'help@example.org' };
  const m403 = sendTestMessage({ ...ctx, ok: false, code: 'resend_403' });
  assert.match(m403, /toolkits\.example\.test/);
  assert.match(m403, /verified/);
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'resend_401' }), /API key/);
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'resend_422' }), /malformed/);
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'resend_429' }), /limit/);
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'resend_429', limit: 'rate' }), /per-second.*try again in a minute/);
  assert.ok(!/daily/.test(sendTestMessage({ ...ctx, ok: false, code: 'resend_429', limit: 'rate' })));
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'resend_timeout' }), /may still arrive/);
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'resend_503' }), /may or may not arrive/);
  assert.match(sendTestMessage({ ...ctx, ok: false, code: 'email_from_not_configured' }), /MIGRATION_EMAIL_FROM/);
  const ok = sendTestMessage({ ...ctx, ok: true, code: null });
  assert.ok(ok.includes(ctx.from) && ok.includes(ctx.replyTo), 'a success names both addresses');
  for (const code of [null, 'resend_401', 'resend_403', 'resend_422', 'resend_429', 'resend_timeout', 'resend_500', 'x']) {
    assert.ok(!/alexsagun\.com/.test(sendTestMessage({ ...ctx, ok: !code, code })), `no literal domain (${code})`);
  }
});

// ── Readiness ────────────────────────────────────────────────────────────────────────

test('readiness: the From is support@ RESEND_FROM\'s domain, proven by domain, replies to support@alexsagun.com', async () => {
  install();
  const out = await call({ action: 'health' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.sender, 'Toolkits by Alex Support <support@toolkits.example.test>');
  assert.equal(out.body.replyTo, 'support@alexsagun.com');
  assert.equal(out.body.senderProven, true);
  assert.equal(out.body.support, true);
  assert.equal(out.body.dailyCap, 100);
  assert.equal(out.body.canActivate, true);
  for (const k of ['service', 'email', 'appUrl', 'sender', 'replyTo', 'senderProven', 'support', 'dailyCap', 'canActivate']) {
    assert.ok(k in out.body, `flag ${k}`);
  }
});

test('readiness: an override on another domain is not proven, and does not move the Reply-To', async () => {
  process.env.MIGRATION_EMAIL_FROM = 'Alex Sagun Support <support@alexsagun.com>';
  process.env.MIGRATION_DAILY_EMAIL_CAP = '3000';
  install();
  const out = await call({ action: 'health' });
  assert.equal(out.body.sender, 'Alex Sagun Support <support@alexsagun.com>');
  assert.equal(out.body.senderProven, false, 'a different domain than RESEND_FROM\'s is unproven');
  assert.equal(out.body.replyTo, 'support@alexsagun.com');
  assert.equal(out.body.dailyCap, 3000);
  assert.equal(out.body.canActivate, true, 'unproven is a warning, not a block: the breaker bounds it');
});

test('readiness: no sender, or a malformed address, pauses activation', async () => {
  delete process.env.RESEND_FROM;
  install();
  let out = await call({ action: 'health' });
  assert.equal(out.body.sender, null);
  assert.equal(out.body.canActivate, false);
  // A run cannot even ask for rows.
  out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, 'NOT_READY');
  assert.match(out.body.error, /MIGRATION_EMAIL_FROM/);
  assert.equal(calls.rpc.length, 0, 'nothing was claimed or sent');

  process.env.RESEND_FROM = 'noreply@toolkits.example.test';
  process.env.MIGRATION_REPLY_TO = 'not-an-address';
  install();
  out = await call({ action: 'health' });
  assert.equal(out.body.support, false);
  assert.equal(out.body.canActivate, false);
  for (const cap of ['-5', 'lots', '0']) {
    process.env.MIGRATION_DAILY_EMAIL_CAP = cap;
    install();
    assert.equal((await call({ action: 'health' })).body.dailyCap, 100, `cap ${cap}`);
  }
});

// ── The circuit breaker ──────────────────────────────────────────────────────────────

test('a 403 stops the run at the first row, hands it back to not_sent, and pauses the run', async () => {
  install({ claimQueue: [row(1), row(2), row(3)], resendStatus: () => 403 });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.stopped, 'sender_refused');
  assert.equal(out.body.code, 'resend_403');
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 1, 'no second row is claimed');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 1, 'at most one row is granted without its email');
  assert.equal(calls.resend.length, 1);
  const rec = rpcCalls('legacy_import_record_delivery');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].args.p_state, 'not_sent', 'nothing was delivered, so it is owed again');
  assert.equal(rec[0].args.p_code, 'resend_403');
  const rel = rpcCalls('legacy_import_release_run');
  assert.equal(rel.length, 1);
  assert.equal(rel[0].args.p_pause, true);
  assert.equal(out.body.results.length, 1);
  assert.equal(out.body.results[0].invite, 'not_sent');
  assert.equal(out.body.results[0].code, 'resend_403');
  // …and the email it tried to send came From the verified domain, answered at support.
  assert.equal(calls.resend[0].body.from, 'Toolkits by Alex Support <support@toolkits.example.test>');
  assert.equal(calls.resend[0].body.reply_to, 'support@alexsagun.com');
});

test('a 429 pauses the run as a quota stop, and the row is owed again', async () => {
  install({ claimQueue: [row(1), row(2)], resendStatus: () => 429 });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'email_quota');
  assert.equal(out.body.code, 'resend_429');
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 1);
  assert.equal(rpcCalls('legacy_import_record_delivery')[0].args.p_state, 'not_sent');
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, true);
});

test('V5: a 429 Resend names as its daily quota is a quota stop', async () => {
  install({
    claimQueue: [row(1), row(2)], resendStatus: () => 429,
    resendBody: () => ({ statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }),
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'email_quota');
  assert.equal(out.body.code, 'resend_429');
});

test('V5: a 429 Resend names as its per-second rate stops as email_rate_limited, and the row is owed again', async () => {
  install({
    claimQueue: [row(1), row(2)], resendStatus: () => 429,
    resendBody: () => ({ statusCode: 429, name: 'rate_limit_exceeded',
      message: 'Too many requests. You can only make 2 requests per second.' }),
    resendHeaders: () => ({ 'retry-after': '1' }),
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.stopped, 'email_rate_limited', 'never "wait for the daily reset" for a per-second limit');
  assert.equal(out.body.code, 'resend_429');
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 1, 'still a stop: no second row is claimed');
  const rec = rpcCalls('legacy_import_record_delivery');
  assert.deepEqual(rec.map((r) => [r.args.p_state, r.args.p_code]), [['not_sent', 'resend_429']],
    'the SQL\'s hand-back code is unchanged: resend_429');
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, true);
  assert.ok(!JSON.stringify(out.body).includes('requests per second'), 'the provider\'s body reaches no response');
});

test('V5: resend-failed and send-test tell the rate from the quota too', async () => {
  const rate = () => ({ name: 'rate_limit_exceeded', message: 'Too many requests.' });
  install({ failedRows: [{ id: id(1), invite_code: 'resend_429' }, { id: id(2), invite_code: 'resend_429' }],
    resendStatus: () => 429, resendBody: rate });
  let out = await call({ action: 'resend-failed', jobId: JOB });
  assert.equal(out.body.stopped, 'email_rate_limited');
  assert.deepEqual(out.body.tried, [id(1)]);
  install({ resendStatus: () => 429, resendBody: rate });
  out = await call({ action: 'send-test' });
  assert.equal(out.body.code, 'resend_429');
  assert.match(out.body.message, /per-second/);
  assert.deepEqual(Object.keys(out.body).sort(), ['clickTracking', 'code', 'from', 'message', 'ok', 'replyTo'],
    'the answer shape is unchanged');
});

test('a 401 stops the run as a sender refusal', async () => {
  install({ claimQueue: [row(1), row(2)], resendStatus: () => 401 });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'sender_refused');
  assert.equal(out.body.code, 'resend_401');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 1);
});

test('one 422 is a row\'s problem; two in a row stop the run, and neither is handed back', async () => {
  install({ claimQueue: [row(1), row(2), row(3)], resendStatus: () => 422 });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'invalid_request');
  assert.equal(out.body.code, 'resend_422');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 2, 'stopped on the second consecutive 422');
  for (const r of rpcCalls('legacy_import_record_delivery')) {
    assert.equal(r.args.p_state, 'failed', 'a 422 is not on the nothing-sent list: recorded failed, never handed back');
  }
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, true);
});

test('a 422 between successes does not stop the run', async () => {
  install({ claimQueue: [row(1), row(2), row(3)], resendStatus: (b, n) => (n === 1 ? 200 : 422) });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, null);
  assert.equal(out.body.code, null);
  assert.equal(rpcCalls('legacy_import_activate_row').length, 3);
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, false, 'nothing stopped, nothing paused');
});

test('ONE link that could not be minted is owed again, and the run goes on', async () => {
  install({
    claimQueue: [row(1), row(2)],
    linkFails: true,
    rpc: {
      legacy_import_begin_invite: (a, n) => ({
        ok: true, skip: false, generation: n + 1, kind: n === 0 ? 'claim' : 'notify', email: 'x@example.test',
        user_id: userOf(a.p_row_id),
        full_name: 'Sam', plan_key: 'sampler', plan_name: 'Essentials', batch_name: null,
        start_date: '2026-10-12', end_date: '2026-12-10',
      }),
    },
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, null);
  assert.equal(calls.genLink, 1);
  const rec = rpcCalls('legacy_import_record_delivery');
  assert.deepEqual(rec.map((r) => [r.args.p_state, r.args.p_code]), [['not_sent', 'link_failed'], ['notified', null]]);
  assert.equal(calls.resend.length, 1, 'no email without a link');
});

// ★ V1: with Supabase Auth unable to mint links, pass 2 used to keep GRANTING — paid terms and
//   cohort seats — with no email going out, and pass 1 spent a generation of the same owed rows
//   on every chunk until the cap of 20 made them unreachable from the app.
test('V1: two links in a row that could not be minted stop the run as auth_unavailable, and pause it', async () => {
  install({ claimQueue: [row(1), row(2), row(3)], linkFails: true, kind: 'claim' });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.stopped, 'auth_unavailable');
  assert.equal(out.body.code, 'link_failed');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 2, 'no third student is granted without an email');
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 2);
  assert.deepEqual(rpcCalls('legacy_import_record_delivery').map((r) => [r.args.p_state, r.args.p_code]),
    [['not_sent', 'link_failed'], ['not_sent', 'link_failed']], 'both are owed again for a Resume');
  const rel = rpcCalls('legacy_import_release_run');
  assert.equal(rel.length, 1);
  assert.equal(rel[0].args.p_pause, true, 'paused through the release path, like every other stop');
  assert.equal(calls.resend.length, 0);
});

test('V1: a Resume while Auth is still down spends at most two generations and grants nobody', async () => {
  install({ pending: [id(50), id(51), id(52)], claimQueue: [row(1)], linkFails: true, kind: 'claim' });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'auth_unavailable');
  assert.equal(out.body.code, 'link_failed');
  assert.deepEqual(rpcCalls('legacy_import_begin_invite').map((c) => c.args.p_row_id), [id(50), id(51)],
    'two generations, not one per owed row per chunk');
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 0, 'no new row is claimed');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 0);
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, true);
});

test('V1: a link failure between delivered emails does not stop the run', async () => {
  install({
    claimQueue: [row(1), row(2), row(3)],
    rpc: {
      legacy_import_begin_invite: (a, n) => ({
        ok: true, skip: false, generation: n + 1, kind: n === 1 ? 'notify' : 'claim', email: 'x@example.test',
        user_id: userOf(a.p_row_id), full_name: 'Sam', plan_key: 'sampler', plan_name: 'Essentials', batch_name: null,
        start_date: '2026-10-12', end_date: '2026-12-10',
      }),
    },
    linkFails: true,
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, null, 'link_failed, notified, link_failed is not two in a row');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 3);
});

test('V1: resend-failed stops on the same Auth streak', async () => {
  install({
    failedRows: [{ id: id(1), invite_code: 'link_failed' }, { id: id(2), invite_code: 'link_failed' }, { id: id(3), invite_code: 'link_failed' }],
    linkFails: true, kind: 'claim',
  });
  const out = await call({ action: 'resend-failed', jobId: JOB });
  assert.equal(out.body.stopped, 'auth_unavailable');
  assert.equal(out.body.code, 'link_failed');
  assert.deepEqual(out.body.tried, [id(1), id(2)]);
  assert.deepEqual(rpcCalls('legacy_import_record_delivery').map((r) => r.args.p_state), ['failed', 'failed'],
    'a resend is never handed back');
});

test('owed invitations go first: a Resume with the sender still refused grants nobody new', async () => {
  install({ pending: [id(50)], claimQueue: [row(1)], resendStatus: () => 403 });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'sender_refused');
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 0, 'no row was claimed');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 0, 'no one was granted');
  assert.equal(rpcCalls('legacy_import_record_delivery')[0].args.p_state, 'not_sent');
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, true);
  assert.equal(out.body.results[0].outcome, 'invited');
});

test('pass 2 excludes the rows it tried, and a hopeless invitation recorded by the database is handled, not a stop', async () => {
  install({
    pending: [id(50), id(51)],
    rpc: {
      legacy_import_begin_invite: (a) => (a.p_row_id === id(50)
        ? { ok: false, skip: true, code: 'account_missing' }
        : { ok: true, skip: false, generation: 1, kind: 'notify', email: 'y@example.test', full_name: 'Y',
          plan_key: 'vip', plan_name: 'VIP Package', batch_name: 'October 2026', start_date: '2026-10-12', end_date: '2027-04-12' }),
    },
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, null);
  const pend = rpcCalls('legacy_import_pending_invites');
  assert.deepEqual(pend.map((p) => p.args.p_exclude), [[], [id(50)], [id(50), id(51)]]);
  assert.deepEqual(out.body.results.map((r) => [r.row_id, r.invite, r.code]),
    [[id(50), 'failed', 'account_missing'], [id(51), 'notified', null]]);
  // begin_invite already recorded the hopeless one; nothing records over it.
  assert.deepEqual(rpcCalls('legacy_import_record_delivery').map((r) => r.args.p_row_id), [id(51)]);
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 1, 'then pass 2 claims as usual');
});

test('a stale lease answers with busyUntil, and touches nothing of the lease holder\'s', async () => {
  install({
    rpc: { legacy_import_claim_rows: () => appError('LEGACY_RUN_BUSY', { run_id: RUN, lease_until: LEASE_UNTIL }, 409) },
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, 'LEGACY_RUN_BUSY');
  assert.equal(out.body.busyUntil, LEASE_UNTIL);
  // claim_rows raises BUSY before it takes a lease, and release_run would recompute the run's
  // status — flipping a run the other window just paused back to 'running'.
  assert.equal(rpcCalls('legacy_import_release_run').length, 0);
});

test('a claim that failed some other way still releases this request\'s lease (B5)', async () => {
  install({ rpc: { legacy_import_claim_rows: () => appError('LEGACY_STAGE_INVALID', null, 422) } });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 422);
  assert.equal(out.body.busyUntil, null);
  const rel = rpcCalls('legacy_import_release_run');
  assert.equal(rel.length, 1, 'released on the early-error path');
  assert.equal(rel[0].args.p_lease, rpcCalls('legacy_import_claim_rows')[0].args.p_lease, 'with this request\'s own lease');
  assert.equal(rel[0].args.p_pause, false);
});

test('a busy error whose context has no lease time reads it from the run itself', async () => {
  // claim_rows' own refusal carries only { run_id }: without this read busyUntil is always null.
  install({
    rpc: { legacy_import_claim_rows: () => appError('LEGACY_RUN_BUSY', { run_id: RUN }, 409) },
    runLease: [{ lease_until: LEASE_UNTIL }],
  });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, 'LEGACY_RUN_BUSY');
  assert.equal(out.body.busyUntil, LEASE_UNTIL);
  const q = decodeURIComponent(calls.selects.find((s) => s.includes('student_import_activation_runs')));
  assert.match(q, /select=lease_until/);
  assert.match(q, new RegExp(`id=eq\\.${RUN}`), 'the run the caller named, nothing wider');
  assert.equal(rpcCalls('legacy_import_release_run').length, 0);
});

test('a busy error with no readable lease time says so with null, never a made-up time', async () => {
  for (const runLease of [[], [{ lease_until: null }], [{ lease_until: 'soon' }], { status: 500, body: { message: 'down' } }]) {
    install({ rpc: { legacy_import_claim_rows: () => appError('LEGACY_RUN_BUSY', { run_id: RUN }, 409) }, runLease });
    const out = await call({ action: 'activate-chunk', runId: RUN });
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.busyUntil, null, JSON.stringify(runLease));
  }
  // A context time wins, and then the run is not read at all.
  install({
    rpc: { legacy_import_claim_rows: () => appError('LEGACY_RUN_BUSY', { run_id: RUN, lease_until: LEASE_UNTIL }, 409) },
    runLease: [{ lease_until: '2030-01-01T00:00:00.000Z' }],
  });
  assert.equal((await call({ action: 'activate-chunk', runId: RUN })).body.busyUntil, LEASE_UNTIL);
  assert.ok(!calls.selects.some((s) => s.includes('student_import_activation_runs')));
  // Any other refusal never reads the run.
  install({ rpc: { legacy_import_claim_rows: () => appError('LEGACY_STAGE_INVALID', null, 422) } });
  await call({ action: 'activate-chunk', runId: RUN });
  assert.ok(!calls.selects.some((s) => s.includes('student_import_activation_runs')));
});

// ── E8: a stranger's password on a pre-existing unconfirmed account ──────────────────

const PRE_EXISTING_UNCONFIRMED = [{ matched_existing: true, existing_confirmed: false, auth_user_created: false }];
const UNCONFIRMED_BIND = { legacy_import_bind_user: () => ({ ok: true, created: false, confirmed: false }) };

test('E8: an unconfirmed account the import did not create gets an unknown password — after the grant, before the link', async () => {
  const logged = [];
  install({ claimQueue: [row(1), row(2)], kind: 'claim', rpc: UNCONFIRMED_BIND });
  console.error = (...a) => { logged.push(a.join(' ')); };
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.stopped, null);
  assert.deepEqual(calls.pwd.map((p) => p.uid), [id(901), id(902)], 'the bound account of each row, once each');
  const [a, b] = calls.pwd.map((p) => p.body.password);
  assert.ok(typeof a === 'string' && a.length >= 32, 'a long random password');
  assert.notEqual(a, b, 'never the same one twice');
  assert.deepEqual(Object.keys(calls.pwd[0].body), ['password'], 'nothing else about the account changes');
  // ★ After activate_row (which refuses staff invitees, whose has_password must stay false),
  //   and before the claim link is minted and sent.
  const order = calls.seq.filter((s) => ['legacy_import_bind_user', 'legacy_import_activate_row',
    'legacy_import_begin_invite', 'auth.updateUserById', 'auth.generateLink', 'resend.send'].includes(s)).slice(0, 6);
  assert.deepEqual(order, ['legacy_import_bind_user', 'legacy_import_activate_row', 'legacy_import_begin_invite',
    'auth.updateUserById', 'auth.generateLink', 'resend.send']);
  // The bind answer is the row's own fact: no extra read on the activation path.
  assert.equal(calls.flagReads.length, 0);
  // The password never reaches a response or a log line.
  assert.ok(!JSON.stringify(out.body).includes(a) && !JSON.stringify(out.body).includes(b));
  assert.ok(!logged.some((l) => l.includes(a) || l.includes(b)));
});

test('E8: no password change for a confirmed account, an account the import created, a refused grant, or a sign-in notice', async () => {
  const cases = [
    [{ ok: true, created: false, confirmed: true }, null, 'claim', 'confirmed: the owner\'s own password'],
    [{ ok: true, created: true, confirmed: false }, null, 'claim', 'created by the import: it has none'],
    [{ ok: true, created: false, confirmed: false }, { ok: false, outcome: 'blocked', reason: 'staff_account' }, 'claim',
      'refused: e.g. a staff invitee'],
    [{ ok: true, created: false, confirmed: false }, null, 'notify', 'a sign-in notice: the student already set a password'],
  ];
  for (const [bind, act, kind, why] of cases) {
    install({
      claimQueue: [row(1)], kind, rowFlags: PRE_EXISTING_UNCONFIRMED,
      rpc: { legacy_import_bind_user: () => bind, ...(act ? { legacy_import_activate_row: () => act } : {}) },
    });
    const out = await call({ action: 'activate-chunk', runId: RUN });
    assert.equal(out.statusCode, 200, why);
    assert.equal(calls.pwd.length, 0, why);
  }
});

test('E8: an unclear bind answer is settled by the row itself, never assumed', async () => {
  // Row says: an account the import created → no rotation.
  install({ claimQueue: [row(1)], kind: 'claim', rpc: { legacy_import_bind_user: () => ({ ok: true, created: false }) } });
  let out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(calls.flagReads.length, 1);
  assert.match(decodeURIComponent(calls.flagReads[0]), new RegExp(`id=eq\\.${id(1)}`), 'that row, and nothing wider');
  assert.equal(calls.pwd.length, 0);
  assert.equal(out.body.results[0].invite, 'sent');
  // Row says: a pre-existing account that never confirmed → rotated before the link.
  install({ claimQueue: [row(1)], kind: 'claim', rowFlags: PRE_EXISTING_UNCONFIRMED,
    rpc: { legacy_import_bind_user: () => ({ ok: true, created: false }) } });
  out = await call({ action: 'activate-chunk', runId: RUN });
  assert.deepEqual(calls.pwd.map((p) => p.uid), [id(901)]);
  assert.equal(out.body.results[0].invite, 'sent');
});

// ★ V3: the rotation used to happen once, after activate_row, best effort. A lost activate_row
//   answer, a killed function or a refused password change let the next chunk's owed claim —
//   or a Resend — go out over whatever password the account's registrant had chosen.
test('V3: a password change Auth refuses holds the claim back — recorded failed/rotation_failed, never handed back', async () => {
  install({ claimQueue: [row(1)], kind: 'claim', pwdStatus: 500, rpc: UNCONFIRMED_BIND });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(calls.pwd.length, 1);
  assert.equal(out.body.results[0].outcome, 'activated');
  assert.equal(out.body.results[0].invite, 'failed');
  assert.equal(out.body.results[0].code, 'rotation_failed');
  assert.equal(calls.genLink, 0, 'no link is minted over the old password');
  assert.equal(calls.resend.length, 0, 'and no email goes');
  assert.deepEqual(rpcCalls('legacy_import_record_delivery').map((r) => [r.args.p_state, r.args.p_code]),
    [['failed', 'rotation_failed']], 'failed, so it shows in the problem list; the SQL refuses it as a hand-back');
  assert.equal(out.body.stopped, null, 'one refusal can be one account\'s');
});

test('V3: two refused password changes in a row stop the run as auth_unavailable', async () => {
  install({ claimQueue: [row(1), row(2), row(3)], kind: 'claim', pwdStatus: 500, rpc: UNCONFIRMED_BIND });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.stopped, 'auth_unavailable');
  assert.equal(out.body.code, 'rotation_failed');
  assert.equal(rpcCalls('legacy_import_activate_row').length, 2);
  assert.equal(rpcCalls('legacy_import_release_run')[0].args.p_pause, true);
});

test('V3: an owed claim sent by a LATER chunk still replaces the old password first', async () => {
  // The row was activated by a request that never got as far as the email (a lost answer, a
  // killed function): pass 1 of the next chunk sends it, with no bind answer to go on.
  install({ pending: [id(50)], kind: 'claim', rowFlags: PRE_EXISTING_UNCONFIRMED });
  const out = await call({ action: 'activate-chunk', runId: RUN });
  assert.equal(out.body.results[0].outcome, 'invited');
  assert.equal(out.body.results[0].invite, 'sent');
  assert.equal(calls.flagReads.length, 1, 'the row\'s own facts decide');
  assert.match(decodeURIComponent(calls.flagReads[0]), /select=matched_existing,existing_confirmed,auth_user_created/);
  assert.deepEqual(calls.pwd.map((p) => p.uid), [id(950)], 'the account begin_invite names');
  const order = calls.seq.filter((s) => ['legacy_import_begin_invite', 'read.rowFlags', 'auth.updateUserById',
    'auth.generateLink', 'resend.send'].includes(s));
  assert.deepEqual(order, ['legacy_import_begin_invite', 'read.rowFlags', 'auth.updateUserById', 'auth.generateLink', 'resend.send']);
});

test('V3: a single Resend and "Resend failed" replace the old password too', async () => {
  install({ kind: 'claim', rowFlags: PRE_EXISTING_UNCONFIRMED });
  let out = await call({ action: 'resend', rowId: id(7) });
  assert.equal(out.body.state, 'sent');
  assert.deepEqual(calls.pwd.map((p) => p.uid), [id(907)]);
  install({ kind: 'claim', rowFlags: PRE_EXISTING_UNCONFIRMED, failedRows: [{ id: id(8), invite_code: 'rotation_failed' }] });
  out = await call({ action: 'resend-failed', jobId: JOB });
  assert.deepEqual(out.body.results.map((r) => r.invite), ['sent']);
  assert.deepEqual(calls.pwd.map((p) => p.uid), [id(908)]);
});

test('V3: account facts that cannot be read hold the claim back, rather than assume', async () => {
  for (const rowFlags of [{ status: 500, body: { message: 'down' } }, []]) {
    install({ kind: 'claim', rowFlags });
    const out = await call({ action: 'resend', rowId: id(7) });
    assert.equal(out.body.state, 'failed', JSON.stringify(rowFlags));
    assert.equal(out.body.code, 'rotation_failed');
    assert.equal(calls.pwd.length, 0);
    assert.equal(calls.genLink, 0);
    assert.equal(calls.resend.length, 0);
  }
});

test('V3: begin_invite\'s own flags, when it carries them, win over a read', async () => {
  install({
    rowFlags: PRE_EXISTING_UNCONFIRMED,
    rpc: {
      legacy_import_begin_invite: (a) => ({
        ok: true, skip: false, generation: 1, kind: 'claim', email: 'x@example.test', user_id: userOf(a.p_row_id),
        full_name: 'Sam', plan_key: 'vip', plan_name: 'VIP Package', batch_name: 'October 2026',
        start_date: '2026-10-12', end_date: '2027-04-12',
        matched_existing: false, existing_confirmed: false, auth_user_created: true,
      }),
    },
  });
  const out = await call({ action: 'resend', rowId: id(7) });
  assert.equal(out.body.state, 'sent');
  assert.equal(calls.flagReads.length, 0);
  assert.equal(calls.pwd.length, 0);
});

// ── resend-failed ────────────────────────────────────────────────────────────────────

test('resend-failed re-sends the job\'s failed invitations, skips the hopeless, and stops on a refusal', async () => {
  install({
    failedRows: [
      { id: id(1), invite_code: 'resend_403' },
      { id: id(2), invite_code: 'account_missing' },
      { id: id(3), invite_code: 'resend_429' },
      { id: id(4), invite_code: 'resend_403' },
      { id: id(5), invite_code: 'link_failed' },
    ],
    resendStatus: (b, n) => (n === 0 ? 200 : 403),
  });
  const out = await call({ action: 'resend-failed', jobId: JOB, exclude: [id(4), 'not-a-uuid'] });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.stopped, 'sender_refused');
  assert.equal(out.body.code, 'resend_403');
  assert.deepEqual(out.body.tried, [id(1), id(3)]);
  assert.equal(out.body.remaining, 1, 'row 5 is still to try; row 4 was excluded; row 2 cannot succeed');
  assert.equal(out.body.unrecoverable, 1);
  assert.deepEqual(out.body.results.map((r) => [r.row_id, r.invite, r.code]),
    [[id(1), 'notified', null], [id(3), 'failed', 'resend_403']]);
  for (const b of rpcCalls('legacy_import_begin_invite')) assert.equal(b.args.p_resend, true);
  // ★ Never handed back: the row stays in the failed list this action works from.
  assert.deepEqual(rpcCalls('legacy_import_record_delivery').map((r) => r.args.p_state), ['notified', 'failed']);
  assert.equal(rpcCalls('legacy_import_claim_rows').length, 0);
  assert.equal(rpcCalls('legacy_import_release_run').length, 0, 'no run is touched');
  // The read: this job's activated rows with a failed invitation, least recently touched first.
  const q = decodeURIComponent(calls.selects.find((s) => s.includes('student_import_rows')));
  assert.match(q, new RegExp(`job_id=eq\\.${JOB}`));
  assert.match(q, /activation_state=eq\.activated/);
  assert.match(q, /invite_state=in\.\(failed\)/);
  assert.match(q, /order=updated_at\.asc/);
});

test('resend-failed counts a row at the generation cap as unrecoverable, whatever its last code', async () => {
  install({
    failedRows: [
      { id: id(1), invite_code: 'resend_403', invite_generation: MAX_INVITE_GENERATION },
      { id: id(2), invite_code: 'resend_403', invite_generation: MAX_INVITE_GENERATION - 1 },
      { id: id(3), invite_code: 'resend_429', invite_generation: null },
    ],
  });
  const out = await call({ action: 'resend-failed', jobId: JOB });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body.tried, [id(2), id(3)], 'the capped row is never offered to begin_invite');
  assert.equal(out.body.unrecoverable, 1);
  assert.equal(out.body.remaining, 0);
  assert.ok(!rpcCalls('legacy_import_begin_invite').some((c) => c.args.p_row_id === id(1)));
  assert.match(decodeURIComponent(calls.selects.find((s) => s.includes('student_import_rows'))),
    /select=id,invite_code,invite_generation/);
});

// ★ V6: nothing moves invite_state when a student claims, so a delivered-but-unclear claim, or
//   one recovered through "Forgot password", stayed in the failed list — and a bulk resend sent
//   that onboarded student the "your membership has moved, sign in" notice out of the blue.
test('V6: resend-failed skips a student who has already onboarded, unless the row is a sign-in notice', async () => {
  install({
    failedRows: [
      { id: id(1), invite_code: 'resend_403', target_user_id: id(901), existing_confirmed: false },
      { id: id(2), invite_code: 'resend_403', target_user_id: id(902), existing_confirmed: false },
      { id: id(3), invite_code: 'resend_403', target_user_id: id(903), existing_confirmed: true },
      { id: id(4), invite_code: 'account_missing', target_user_id: id(904), existing_confirmed: false },
      // The SAME onboarded student's other purchase, on an account that already had a password
      // when it was imported: its invitation is the sign-in notice, and it still goes.
      { id: id(5), invite_code: 'resend_403', target_user_id: id(901), existing_confirmed: true },
    ],
    profiles: [
      { id: id(901), onboarding_status: 'completed' },
      { id: id(902), onboarding_status: 'invited' },
      { id: id(904), onboarding_status: 'completed' },
    ],
  });
  const out = await call({ action: 'resend-failed', jobId: JOB, includeUncertain: true });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.skipped_onboarded, 2, 'rows 1 and 4: their students have finished setting up');
  assert.deepEqual(out.body.tried, [id(2), id(3), id(5)],
    'rows 3 and 5 are existing_confirmed: their invitation IS the sign-in notice, and still goes');
  assert.equal(out.body.unrecoverable, 0, 'an onboarded row is not counted as unrecoverable');
  assert.equal(out.body.remaining, 0);
  assert.ok(!rpcCalls('legacy_import_begin_invite').some((c) => [id(1), id(4)].includes(c.args.p_row_id)));
  // The reads: the rows (with their account and kind), then only the claim-kind rows' profiles.
  assert.match(decodeURIComponent(calls.selects[0]), /select=id,invite_code,invite_generation,target_user_id,existing_confirmed/);
  assert.equal(calls.profileReads.length, 1);
  const q = decodeURIComponent(calls.profileReads[0]);
  assert.match(q, /select=id,onboarding_status/);
  assert.match(q, new RegExp(`id=in\\.\\(${id(901)},${id(902)},${id(904)}\\)`), 'claim-kind rows only');
});

test('V6: an unreadable profile list sends nothing', async () => {
  install({
    failedRows: [{ id: id(1), invite_code: 'resend_403', target_user_id: id(901), existing_confirmed: false }],
    profiles: { status: 500, body: { message: 'down' } },
  });
  const out = await call({ action: 'resend-failed', jobId: JOB });
  assert.equal(out.statusCode, 500);
  assert.equal(out.body.error, 'The failed invitations could not be read. Nothing was sent.',
    'refused on purpose, not by a crash');
  assert.equal(rpcCalls('legacy_import_begin_invite').length, 0);
  assert.equal(calls.resend.length, 0);
});

test('V6: a large job reads its profiles in bounded chunks', async () => {
  const failedRows = Array.from({ length: 230 }, (_, i) => ({
    id: id(1000 + i), invite_code: 'resend_403', target_user_id: id(5000 + i), existing_confirmed: false,
  }));
  install({ failedRows, profiles: failedRows.map((r) => ({ id: r.target_user_id, onboarding_status: 'completed' })) });
  const out = await call({ action: 'resend-failed', jobId: JOB });
  assert.equal(out.statusCode, 200);
  assert.equal(calls.profileReads.length, 3, '100 + 100 + 30 ids — a URL carries them');
  assert.equal(out.body.skipped_onboarded, 230);
  assert.deepEqual(out.body.tried, []);
});

test('the generation cap mirrors legacy_import_begin_invite in #68', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../db/2026-09-28-legacy-migration-round2.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create or replace function public.legacy_import_begin_invite(');
  assert.ok(start > 0, 'begin_invite is in #68');
  const body = sql.slice(start, sql.indexOf('$fn$;', start));
  // `invite_generation >= 1` is not a cap: it is "tried at least once", part of the test for
  // re-using the generation of a hand-back that never reached the provider (S4).
  const caps = [...body.matchAll(/invite_generation\s*>=\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 1);
  assert.ok(caps.length >= 2, 'the automatic path and the resend path both check it');
  assert.deepEqual([...new Set(caps)], [MAX_INVITE_GENERATION]);
});

test('resend-failed includes possibly-delivered invitations only when asked', async () => {
  install({ failedRows: [] });
  let out = await call({ action: 'resend-failed', jobId: JOB, includeUncertain: true });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body.results, []);
  assert.equal(out.body.remaining, 0);
  assert.match(decodeURIComponent(calls.selects[0]), /invite_state=in\.\(failed,uncertain\)/);
  install({ failedRows: [] });
  out = await call({ action: 'resend-failed', jobId: JOB, includeUncertain: 'yes' });
  assert.match(decodeURIComponent(calls.selects[0]), /invite_state=in\.\(failed\)/, 'only a literal true opts in');
});

test('resend-failed needs a job id and a ready server', async () => {
  install();
  assert.equal((await call({ action: 'resend-failed', jobId: 'nope' })).statusCode, 400);
  delete process.env.RESEND_FROM;
  install();
  const out = await call({ action: 'resend-failed', jobId: JOB });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, 'NOT_READY');
  assert.equal(calls.selects.length, 0);
});

test('a single resend records a refusal as failed, not handed back', async () => {
  install({ resendStatus: () => 403 });
  const out = await call({ action: 'resend', rowId: id(7) });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.state, 'failed');
  assert.equal(out.body.code, 'resend_403');
  assert.equal(rpcCalls('legacy_import_record_delivery')[0].args.p_state, 'failed');
});

// ── send-test ────────────────────────────────────────────────────────────────────────

test('send-test goes to the caller, names both addresses and the catalog\'s package, and reads click tracking', async () => {
  install({ plans: [{ name: 'VIP Package' }] });
  const out = await call({ action: 'send-test' });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(Object.keys(out.body).sort(), ['clickTracking', 'code', 'from', 'message', 'ok', 'replyTo']);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.code, null);
  assert.equal(out.body.from, 'Toolkits by Alex Support <support@toolkits.example.test>');
  assert.equal(out.body.replyTo, 'support@alexsagun.com');
  assert.equal(out.body.clickTracking, 'off');
  assert.match(out.body.message, /support@toolkits\.example\.test/);
  assert.equal(calls.resend.length, 1);
  const sentMsg = calls.resend[0].body;
  assert.deepEqual(sentMsg.to, ['owner@example.test'], 'the caller\'s own address');
  assert.equal(sentMsg.from, out.body.from);
  assert.equal(sentMsg.reply_to, 'support@alexsagun.com');
  assert.match(sentMsg.text, /\* Package: VIP Package\n/);
  assert.equal(calls.genLink, 0, 'no token is minted');
});

test('send-test explains a 403 with the real domain, and reports click tracking on', async () => {
  install({
    resendStatus: () => 403,
    domains: { detail: { status: 200, body: { id: 'dom-1', name: 'toolkits.example.test', click_tracking: true } } },
  });
  const out = await call({ action: 'send-test' });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.code, 'resend_403');
  assert.match(out.body.message, /toolkits\.example\.test/);
  assert.ok(!/alexsagun/.test(out.body.message));
  assert.equal(out.body.clickTracking, 'on');
});

test('send-test: a key that cannot read domains, or an unknown domain, is "unknown"', async () => {
  install({ domains: { list: { status: 401, body: { message: 'restricted' } } } });
  assert.equal((await call({ action: 'send-test' })).body.clickTracking, 'unknown');
  install({ domains: { list: { status: 200, body: { data: [{ id: 'dom-9', name: 'other.example' }] } } } });
  assert.equal((await call({ action: 'send-test' })).body.clickTracking, 'unknown');
});

test('send-test with no sender sends nothing and says why', async () => {
  // Unset, and set to something with no domain: either way there is no migration sender,
  // and the provider must never be handed RESEND_FROM's own value instead.
  for (const resendFrom of [undefined, 'noreply']) {
    if (resendFrom === undefined) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = resendFrom;
    install();
    const out = await call({ action: 'send-test' });
    assert.equal(out.body.ok, false);
    assert.equal(out.body.code, 'email_from_not_configured');
    assert.equal(out.body.from, null);
    assert.match(out.body.message, /MIGRATION_EMAIL_FROM/);
    assert.equal(calls.resend.length, 0, `never falls back to RESEND_FROM's own address (${resendFrom})`);
  }
});

test('send-test with no email key answers in the same shape, names what to set, and sends nothing', async () => {
  delete process.env.RESEND_API_KEY;
  install();
  const out = await call({ action: 'send-test' });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(Object.keys(out.body).sort(), ['clickTracking', 'code', 'from', 'message', 'ok', 'replyTo']);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.code, 'email_not_configured');
  assert.equal(out.body.clickTracking, 'unknown');
  assert.equal(out.body.from, 'Toolkits by Alex Support <support@toolkits.example.test>');
  assert.equal(out.body.replyTo, 'support@alexsagun.com');
  assert.match(out.body.message, /RESEND_API_KEY/);
  assert.ok(!/Activation is paused/.test(out.body.message), 'not the activation-readiness sentence');
  assert.equal(calls.resend.length, 0);
});

// ── reset-onboarding-notice, stage ───────────────────────────────────────────────────

test('reset-onboarding-notice calls the service-only reset for the caller and the row', async () => {
  install();
  const out = await call({ action: 'reset-onboarding-notice', rowId: id(8) });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { ok: true });
  assert.deepEqual(rpcCalls('legacy_import_reset_onboarding_notice').map((c) => c.args), [{ p_actor: caller, p_row_id: id(8) }]);
  assert.equal((await call({ action: 'reset-onboarding-notice', rowId: '' })).statusCode, 400);
});

test('reset-onboarding-notice passes a refusal through with its code', async () => {
  install({ rpc: { legacy_import_reset_onboarding_notice: () => appError('LEGACY_ROW_NOT_READY', { row_id: id(8) }, 409) } });
  const out = await call({ action: 'reset-onboarding-notice', rowId: id(8) });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, 'LEGACY_ROW_NOT_READY');
});

test('staging reads each plan\'s segment and records which self-paced plans start Ready', async () => {
  install({
    plans: [
      { key: 'vip', name: 'VIP Package', tagline: 'Personalized Coaching Program', price_php: 16999, active: true, access_days: 180, community_segment: 'vip' },
      { key: 'sampler', name: 'Essentials', tagline: 'Sampler Session', price_php: 1499, active: true, access_days: 60, community_segment: 'general' },
    ],
  });
  const out = await call({
    action: 'stage', filename: 'essentials.csv', dateFormat: 'YYYY-MM-DD',
    rows: [{ Email: 'ess@example.test', Plan: 'Essentials', Start: '2026-10-01', End: '2026-11-29', Status: 'Paid' }],
    mapping: { email: 'Email', plan_label: 'Plan', start_date: 'Start', end_date: 'End', payment_status: 'Status' },
    planMapping: { essentials: 'sampler' }, batchMapping: {}, eligibleBatchCodes: [],
    eligiblePlanKeys: ['sampler', 42, ' silver_self_paced '],
  });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  const planRead = decodeURIComponent(calls.selects.find((s) => s.includes('enrollment_plans')));
  assert.match(planRead, /select=key,name,tagline,price_php,active,access_days,community_segment/);
  const stage = rpcCalls('legacy_import_stage')[0].args;
  assert.deepEqual(stage.p_job.eligible_plan_keys, ['sampler', 'silver_self_paced']);
  assert.deepEqual(stage.p_job.eligible_batch_codes, []);
});

// ── api/_lib/email.js: what a refusal proves (V4) and which limit a 429 is (V5) ─────────

/**
 * A provider stub: `script` lists what each attempt meets — 'hang' (never answers until the
 * caller's time limit aborts it), 'drop' (the connection fails), or a status with an optional
 * body and headers.
 */
function providerScript(script) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), 'https://api.resend.com/emails');
    seen.push(init.headers?.['Idempotency-Key']);
    const step = script[seen.length - 1];
    if (step === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    }
    if (step === 'drop') throw new TypeError('fetch failed');
    const { status, body = { message: 'no' }, headers = {} } = step;
    return new Response(JSON.stringify(status === 200 ? { id: 'e-1' } : body), { status, headers });
  };
  return seen;
}
const MSG = { to: 'student@example.test', subject: 'S', html: '<p>h</p>', text: 't', tag: 'test' };

test('V4: a 429 or 4xx on the retry after an attempt that got no answer is unclear, never proof nothing was sent', async () => {
  for (const [script, want] of [
    [['hang', { status: 429, body: { name: 'rate_limit_exceeded' } }], 'resend_timeout'],
    [['hang', { status: 403 }], 'resend_timeout'],
    [['hang', { status: 422 }], 'resend_timeout'],
    [['hang', { status: 409 }], 'resend_timeout'],
    [['drop', { status: 429 }], 'resend_failed'],
    [['drop', { status: 401 }], 'resend_failed'],
    [['drop', 'hang', { status: 403 }], 'resend_timeout'],
  ]) {
    const seen = providerScript(script);
    const out = await sendEmail({ ...MSG, timeoutMs: 40, maxAttempts: script.length, retry429: false, idempotencyKey: 'legacy-claim-test-1' });
    assert.deepEqual({ ok: out.ok, code: out.code }, { ok: false, code: want }, JSON.stringify(script));
    assert.ok(!('limit' in out), 'an unclear answer carries no limit');
    assert.equal(new Set(seen).size, 1, 'one key for every attempt');
  }
});

test('V4: a refusal with nothing unanswered before it is still the refusal', async () => {
  for (const status of [401, 403, 422]) {
    providerScript([{ status }]);
    assert.equal((await sendEmail({ ...MSG, timeoutMs: 40, maxAttempts: 2, retry429: false })).code, `resend_${status}`);
  }
  providerScript(['hang', 'hang']);
  assert.equal((await sendEmail({ ...MSG, timeoutMs: 40, maxAttempts: 2, retry429: false })).code, 'resend_timeout');
  providerScript(['hang', { status: 200 }]);
  assert.equal((await sendEmail({ ...MSG, timeoutMs: 40, maxAttempts: 2, retry429: false })).ok, true);
  providerScript(['hang', { status: 503 }]);
  assert.equal((await sendEmail({ ...MSG, timeoutMs: 40, maxAttempts: 2, retry429: false })).code, 'resend_503');
});

test('V5: sendEmail classifies a 429 from its body when asked, and returns the classification, never the body', async () => {
  const ask = { ...MSG, maxAttempts: 1, retry429: false, classify429: true };
  providerScript([{ status: 429, body: { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. 2 per second. Contact support@resend.com' } }]);
  let out = await sendEmail(ask);
  assert.deepEqual(out, { ok: false, code: 'resend_429', limit: 'rate' });
  providerScript([{ status: 429, body: { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' } }]);
  out = await sendEmail(ask);
  assert.deepEqual(out, { ok: false, code: 'resend_429', limit: 'quota' });
  globalThis.fetch = async () => new Response('<html>busy</html>', { status: 429 });
  assert.deepEqual(await sendEmail(ask), { ok: false, code: 'resend_429', limit: 'quota' }, 'an unreadable body is the quota');
  providerScript([{ status: 429, body: { name: 'rate_limit_exceeded' }, headers: { 'retry-after': '7200' } }]);
  assert.equal((await sendEmail(ask)).limit, 'quota');
  // Opt-in: every other sender (the #61 queue, staff invitations) keeps its exact answer shape.
  providerScript([{ status: 429, body: { name: 'rate_limit_exceeded' } }]);
  assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 1, retry429: false }), { ok: false, code: 'resend_429' });
});

test('V5: both migration senders ask sendEmail to classify a 429', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/admin/student-imports.js', import.meta.url), 'utf8');
  const calls429 = src.match(/sendEmail\(\{[\s\S]*?\}\);/g) || [];
  assert.equal(calls429.length, 2, 'sendInvite and send-test');
  for (const c of calls429) assert.match(c, /classify429: true/);
});

// ── Source guards the behaviour tests cannot see ─────────────────────────────────────

test('the endpoint only READS import tables, and only after the gate', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/admin/student-imports.js', import.meta.url), 'utf8');
  const reads = src.match(/\.from\('student_import[^']*'\)[\s\S]{0,900}?;/g) || [];
  assert.deepEqual(reads.map((r) => /\.from\('([^']+)'\)/.exec(r)[1]).sort(),
    ['student_import_activation_runs', 'student_import_rows', 'student_import_rows'],
    'three reads: the resend-failed list, a row\'s account facts (E8), and a busy run\'s lease time');
  for (const r of reads) assert.ok(!/\.(insert|update|delete|upsert)\(/.test(r), 'a SELECT, never a write');
  // #68 V6: the onboarding check reads profiles — a SELECT of two columns, nothing else.
  const profiles = src.match(/\.from\('profiles'\)[\s\S]{0,300}?;/g) || [];
  assert.equal(profiles.length, 1);
  assert.match(profiles[0], /\.from\('profiles'\)\.select\('id,onboarding_status'\)\.in\('id', chunk\)/);
  assert.ok(!/\.(insert|update|delete|upsert)\(/.test(profiles[0]));
  assert.ok(src.indexOf("const gate = await requireStaff(req, { permission: PERMISSION });") < src.indexOf('const admin = service();'));
});

test('V3: the password is replaced in ONE place — sendInvite, before the link is minted — never twice', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/admin/student-imports.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal((code.match(/await rotatePassword\(/g) || []).length, 1, 'one call site');
  const send = code.slice(code.indexOf('async function sendInvite('), code.indexOf('\nasync function processRow('));
  const rot = send.indexOf('await rotatePassword(');
  assert.ok(rot > 0 && rot < send.indexOf('generateLink('), 'inside sendInvite, before a token is minted');
  assert.ok(send.indexOf("return record('failed', 'rotation_failed');") > rot, 'and a refusal returns before it');
  const proc = code.slice(code.indexOf('async function processRow('), code.indexOf('\nasync function doActivateChunk('));
  assert.ok(!/rotatePassword\(/.test(proc), 'processRow no longer rotates on its own');
});

test('sendInvite refuses to send with no migration sender, before any link is minted', async () => {
  // Unreachable through the handler (readiness refuses first), so pinned in the source:
  // sendEmail reads an empty `from` as "use RESEND_FROM", and that fallback must never happen.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/admin/student-imports.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function sendInvite(');
  const body = src.slice(start, src.indexOf('\nasync function processRow(', start));
  const guard = body.indexOf("if (!ctx.from) return record('failed', 'email_from_not_configured');");
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(guard < body.indexOf('generateLink('), 'before a token is minted');
  assert.ok(guard < body.indexOf('legacyMembershipEmail('), 'before the message is built');
  assert.ok(guard < body.indexOf('sendEmail('), 'before the provider is called');
  assert.ok(NOTHING_SENT_CODES.has('email_from_not_configured') && STOP_CODES.email_from_not_configured,
    'in a run it is handed back and stops the run');
});
