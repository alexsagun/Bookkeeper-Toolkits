// ─────────────────────────────────────────────────────────────────────────────
// test/notifyImportOnboarded.test.mjs — api/notify-enrollment.js 'import_onboarded' (#67).
// ─────────────────────────────────────────────────────────────────────────────
// Once a migrated student sets their password, the administrator is told ("Student
// Successfully Onboarded") and the student gets a confirmation. The contract pinned here:
//   • the caller must hold a valid JWT, and the body carries NOTHING the emails use —
//     every fact comes from the SERVICE-ONLY legacy_import_onboarding_notice(p_user), called
//     with the service key and the uid the JWT proved, never with the student's own token
//     (which is what let a student record their own outcome in the first version);
//   • a caller who is not a migrated, onboarded student gets a skip and no email;
//   • both emails come from support@alexsagun.com, with per-row idempotency keys;
//   • the outcome is recorded, so 'sent' is final and a failure is retried.
//
// No network. globalThis.fetch is a router keyed on URL; an unexpected URL throws.
// ─────────────────────────────────────────────────────────────────────────────

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPA = 'https://notify-onboarded-test.supabase.example';
const ANON = 'anon-key-for-notify-onboarded-tests';
const SERVICE = 'service-key-for-notify-onboarded-tests';
process.env.VITE_SUPABASE_URL = SUPA;
process.env.VITE_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SECRET_KEY = SERVICE;   // read at module load by api/_lib/staffAuth.js
const { default: handler } = await import('../api/notify-enrollment.js');

const ROW_ID = '11111111-2222-4333-8444-555555555555';
const FACTS = {
  ok: true, row_id: ROW_ID, full_name: 'Synthetic Student', email: 'synthetic.student@example.test',
  plan_key: 'vip', plan_name: 'Personalized Coaching Program', batch_name: 'October 2026',
  status: 'active', started_at: '2026-09-25T16:00:00+00:00', ends_at: '2027-04-12T15:59:59.999+00:00',
  onboarded_at: '2026-09-26T03:00:00+00:00',
};

let savedFetch; let savedEnv; let rpcCalls; let sent; let caller;

function install({ claim = FACTS, userOk = true, resendStatus = 200 } = {}) {
  caller = crypto.randomUUID();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u === `${SUPA}/auth/v1/user`) return userOk ? res({ id: caller }) : res({ msg: 'bad jwt' }, 401);
    if (u === `${SUPA}/rest/v1/rpc/legacy_import_onboarding_notice`) {
      const auth = new Headers(init.headers).get('authorization');
      assert.equal(auth, `Bearer ${SERVICE}`, 'called with the service key, never the student token');
      const { p_user, ...args } = JSON.parse(init.body || '{}');
      assert.equal(p_user, caller, 'and with the uid the JWT proved');
      rpcCalls.push(args);
      return res(args.p_result ? { ok: true } : claim);
    }
    if (u.startsWith(`${SUPA}/rest/v1/payment_settings?`)) return res([]);
    if (u === 'https://api.resend.com/emails') {
      sent.push({ body: JSON.parse(init.body), key: init.headers?.['Idempotency-Key'] || init.headers?.['idempotency-key'] });
      return resendStatus === 200 ? res({ id: `e-${sent.length}` }) : res({ message: 'nope' }, resendStatus);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function call(body = {}, headers = { authorization: 'Bearer student-token' }) {
  const req = { method: 'POST', headers, body: { action: 'import_onboarded', ...body } };
  const out = { statusCode: 200, body: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
  };
  await handler(req, res);
  return out;
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedEnv = { ...process.env };
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits by Alex <noreply@example.test>';
  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  process.env.APP_URL = 'https://toolkits.example.test';
  delete process.env.MIGRATION_EMAIL_FROM;
  rpcCalls = []; sent = [];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = savedEnv;
});

test('no JWT, no email', async () => {
  install({ userOk: false });
  const out = await call({}, {});
  assert.equal(out.statusCode, 403);
  assert.equal(sent.length, 0);
  assert.equal(rpcCalls.length, 0);
});

test('the admin and the student are emailed from support@alexsagun.com, facts from the database only', async () => {
  install();
  // A body that tries to steer the email: every one of these must be ignored.
  const out = await call({ email: 'attacker@evil.test', fullName: 'Forged', to: 'attacker@evil.test', planName: 'Free',
    p_user: crypto.randomUUID(), p_result: 'sent' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.ok, true);
  assert.equal(sent.length, 2);
  const to = sent.map((s) => s.body.to[0]).sort();
  assert.deepEqual(to, ['owner@example.test', 'synthetic.student@example.test']);
  for (const s of sent) {
    assert.match(s.body.from, /<support@alexsagun\.com>$/);
    assert.equal(s.body.reply_to, 'support@alexsagun.com');
    assert.ok(!JSON.stringify(s.body).includes('attacker@evil.test'), 'nothing from the body reaches an email');
    assert.ok(!JSON.stringify(s.body).includes('Forged'));
    assert.ok(s.body.text && s.body.html, 'multipart');
  }
  const admin = sent.find((s) => s.body.to[0] === 'owner@example.test');
  assert.equal(admin.body.subject, 'Student Successfully Onboarded');
  assert.equal(admin.key, `legacy-onboarded-admin-${ROW_ID}`);
  const student = sent.find((s) => s.body.to[0] === 'synthetic.student@example.test');
  assert.equal(student.key, `legacy-onboarded-student-${ROW_ID}`);
  assert.deepEqual(rpcCalls, [{}, { p_result: 'sent' }], 'reserved, then recorded as sent');
});

test('a caller who is not a migrated, onboarded student gets a skip and no email', async () => {
  install({ claim: { ok: false, skip: 'not_migrated' } });
  const out = await call();
  assert.equal(out.body.ok, false);
  assert.equal(out.body.skipped, 'not_migrated');
  assert.equal(sent.length, 0);
});

test('a provider failure is recorded as failed, so the next call retries', async () => {
  install({ resendStatus: 500 });
  const out = await call();
  assert.equal(out.body.ok, false);
  assert.deepEqual(rpcCalls.at(-1), { p_result: 'failed' });
});

test('MIGRATION_EMAIL_FROM overrides the sender', async () => {
  process.env.MIGRATION_EMAIL_FROM = 'Alex Sagun Support <support@alexsagun.com>';
  install();
  await call();
  for (const s of sent) assert.equal(s.body.from, 'Alex Sagun Support <support@alexsagun.com>');
});

test('the student cannot record the outcome: nothing reaches the notice RPC with their token', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/notify-enrollment.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("if (action === 'import_onboarded')"), src.indexOf("if (action === 'test')"));
  assert.ok(block.length > 200, 'found the handler');
  assert.ok(!/\bu\.token\b/.test(block.replace(/resolveAdminRecipient\(u\.token\)/, '')),
    'the student token reaches no database call here but the admin-address read');
  assert.ok(block.includes("svc.rpc('legacy_import_onboarding_notice', { p_user: u.id, ...args })"));
  assert.ok(block.indexOf('callerUser(') < block.indexOf('service()'), 'the service client is built only after the JWT is verified');
});
