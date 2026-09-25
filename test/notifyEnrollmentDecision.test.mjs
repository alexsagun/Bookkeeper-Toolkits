// ─────────────────────────────────────────────────────────────────────────────
// test/notifyEnrollmentDecision.test.mjs — api/notify-enrollment.js 'decision', end to end.
// ─────────────────────────────────────────────────────────────────────────────
// Until 2026-09-24 this action took the recipient, the student's name, the package and the
// rejection "reason" from the request BODY. Any enrollments.review holder — an Operations
// Admin included — could therefore send the business's own "Your enrollment is approved"
// email to any address, with any text in it. These tests pin the replacement contract:
// the body names a request and a decision; the server reads the row with the caller's JWT
// and sends only the decision actually recorded on it.
//
// No network. globalThis.fetch is a router keyed on URL; an unexpected URL throws and is
// recorded, so a stray call fails the test that made it.
// ─────────────────────────────────────────────────────────────────────────────

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPA = 'https://notify-decision-test.supabase.example';
const ANON = 'anon-key-for-notify-decision-tests';
// staffAuth.js and the handler read these at import time, so set them BEFORE importing.
process.env.VITE_SUPABASE_URL = SUPA;
process.env.VITE_SUPABASE_ANON_KEY = ANON;
const { default: handler } = await import('../api/notify-enrollment.js');

const REQ = '11111111-2222-4333-8444-555555555555';
const STUDENT = '66666666-7777-4888-9999-aaaaaaaaaaaa';
// The request row's `email` is what the STUDENT typed at insert; the account address lives
// on profiles. They differ here on purpose: only the account address may ever be mailed.
const ROW = {
  id: REQ, user_id: STUDENT, email: 'typed-on-the-request@third-party.test', full_name: 'Real Student',
  plan_name: 'Sampler Session', status: 'approved', rejection_reason: null,
};
const PROFILE = { email: 'real.student@example.test', full_name: 'Real Student' };
const OPS = {
  is_staff: true, role_key: 'operations_admin', role_label: 'Operations Admin', status: 'active',
  is_super_admin: false, permissions: ['access_requests.review', 'enrollments.review'], assigned_course_ids: [],
  membership: { exists: true, status: 'active', role_key: 'operations_admin' },
};
const TRAINER = {
  is_staff: true, role_key: 'trainer', role_label: 'Trainer', status: 'active',
  is_super_admin: false, permissions: ['courses.manage_assigned'], assigned_course_ids: [],
  membership: { exists: true, status: 'active', role_key: 'trainer' },
};

let savedFetch; let savedErr; let calls; let sent;

function install({ staff = OPS, row = ROW, rowStatus = 200, profile = PROFILE } = {}) {
  const caller = crypto.randomUUID();   // the rate limiter is per caller, at module scope
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u === `${SUPA}/auth/v1/user`) return res({ id: caller });
    if (u === `${SUPA}/rest/v1/rpc/my_staff_context`) return res(staff);
    if (u.startsWith(`${SUPA}/rest/v1/enrollment_requests?`)) {
      assert.match(String(init.headers?.Authorization), /^Bearer caller-token$/,
        'the row must be read with the CALLER\'s JWT, so RLS decides what they may see');
      return res(row ? [row] : [], rowStatus);
    }
    if (u.startsWith(`${SUPA}/rest/v1/profiles?`)) {
      assert.match(String(init.headers?.Authorization), /^Bearer caller-token$/,
        'the account must be read with the CALLER\'s JWT too');
      assert.ok(u.includes(`id=eq.${STUDENT}`), 'the profile looked up must be the request\'s own user_id');
      return res(profile ? [profile] : []);
    }
    if (u === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(init.body));
      return res({ id: 'resend-test-id' });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function call(body) {
  const req = { method: 'POST', headers: { authorization: 'Bearer caller-token' }, body: { action: 'decision', ...body } };
  const out = { statusCode: 200, body: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader() { return res; },
    send(t) { out.body = t; return res; },
  };
  await handler(req, res);
  return out;
}

beforeEach(() => {
  calls = []; sent = [];
  savedFetch = globalThis.fetch;
  savedErr = console.error;
  console.error = () => {};
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits <noreply@example.test>';
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  console.error = savedErr;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
});

test('nothing the reviewer puts in the body reaches the email: not an address, a name or a package', async () => {
  install();
  const out = await call({
    requestId: REQ, status: 'approved',
    email: 'attacker@evil.test', fullName: 'Click Here Friend', planName: 'Free iPhone',
  });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [PROFILE.email], 'the address the reviewer typed must be ignored');
  assert.match(sent[0].html, /Real Student/);
  assert.match(sent[0].html, /Sampler Session/);
  assert.ok(!/attacker|Click Here Friend|Free iPhone/.test(JSON.stringify(sent[0])),
    'no body-supplied text may reach the email');
});

test('the recipient is the ACCOUNT address, never the email the student typed on the request', async () => {
  // enroll_req_own_insert checks user_id, status and batch — not email — so a request row can
  // name a third party. A reviewer's decision must not mail the business's email there.
  install();
  const out = await call({ requestId: REQ, status: 'approved' });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(sent[0].to, [PROFILE.email]);
  assert.ok(!JSON.stringify(sent[0]).includes(ROW.email), 'the request-row address must never be used');
});

test('with no readable account address nothing is sent', async () => {
  install({ profile: null });
  const out = await call({ requestId: REQ, status: 'approved' });
  assert.equal(out.statusCode, 422);
  assert.equal(sent.length, 0);
});

test("a rejection carries the reason recorded on the row, not the body's", async () => {
  install({ row: { ...ROW, status: 'rejected', rejection_reason: 'Receipt unreadable' } });
  const out = await call({ requestId: REQ, status: 'rejected', reason: 'Log in at http://evil.example' });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.match(sent[0].html, /Receipt unreadable/);
  assert.ok(!/evil\.example/.test(sent[0].html));
});

test('an email for a decision that was not recorded is refused', async () => {
  install({ row: { ...ROW, status: 'pending_review' } });
  const out = await call({ requestId: REQ, status: 'approved' });
  assert.equal(out.statusCode, 409);
  assert.equal(sent.length, 0, 'announcing an approval that did not happen is exactly the forgery');
});

test('a request the caller cannot see is a 404, and nothing is sent', async () => {
  install({ row: null });
  const out = await call({ requestId: REQ, status: 'approved' });
  assert.equal(out.statusCode, 404);
  assert.equal(sent.length, 0);
});

test('without enrollments.review nothing is read and nothing is sent', async () => {
  install({ staff: TRAINER });
  const out = await call({ requestId: REQ, status: 'approved' });
  assert.equal(out.statusCode, 403);
  assert.equal(sent.length, 0);
  assert.ok(!calls.some((u) => u.includes('/rest/v1/enrollment_requests')),
    'the gate must refuse before the row is read');
});

test('a malformed request id or decision is refused before anything is read', async () => {
  install();
  for (const body of [
    { status: 'approved' },
    { requestId: 'not-a-uuid', status: 'approved' },
    { requestId: `${REQ}&select=*`, status: 'approved' },
    { requestId: REQ, status: 'pending_review' },
  ]) {
    const out = await call(body);
    assert.equal(out.statusCode, 400, JSON.stringify(body));
  }
  assert.ok(!calls.some((u) => u.includes('/rest/v1/enrollment_requests')));
  assert.equal(sent.length, 0);
});

test('with email unconfigured the decision is still verified first, then skipped', async () => {
  delete process.env.RESEND_API_KEY;
  install();
  const out = await call({ requestId: REQ, status: 'approved' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.skipped, 'email_not_configured');
  assert.equal(sent.length, 0);
});
