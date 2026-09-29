// ─────────────────────────────────────────────────────────────────────────────
// test/notifyImportOnboarded.test.mjs — api/notify-enrollment.js 'import_onboarded' (#67, #68).
// ─────────────────────────────────────────────────────────────────────────────
// Once a migrated student sets their password, the administrator is told ("Student
// Successfully Onboarded") and the student gets a confirmation. The contract pinned here:
//   • the caller must hold a valid JWT, and the body carries NOTHING the emails use —
//     every fact comes from the SERVICE-ONLY legacy_import_onboarding_notice(p_user), called
//     with the service key and the uid the JWT proved, never with the student's own token
//     (which is what let a student record their own outcome in the first version);
//   • a caller who is not a migrated, onboarded student gets a skip and no email;
//   • both emails come From support@<RESEND_FROM's domain> — a domain Resend has verified —
//     and are answered at support@alexsagun.com (#68), with per-row idempotency keys;
//   • the outcome is recorded, so 'sent' is final and a failure is retried; a failure in
//     which NEITHER email can have been delivered carries its code, so the database can
//     refund a try the student did not cause — and a partial success carries none, so the
//     five-try cap still bounds how often the delivered half can ring again (#68, V2);
//   • a malformed migration address is refused before a try is reserved (#68, V2).
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
  plan_key: 'vip', plan_name: 'VIP Package', batch_name: 'October 2026',
  status: 'active', started_at: '2026-09-25T16:00:00+00:00', ends_at: '2027-04-12T15:59:59.999+00:00',
  onboarded_at: '2026-09-26T03:00:00+00:00',
};

let savedFetch; let savedEnv; let savedErr; let rpcCalls; let sent; let caller;

/**
 * @param {object} o
 * @param {(body: object) => number} [o.resendStatusFor]  the provider's answer per message
 */
function install({ claim = FACTS, userOk = true, resendStatus = 200, resendStatusFor = null, settingsHang = false } = {}) {
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
    if (u.startsWith(`${SUPA}/rest/v1/payment_settings?`)) {
      if (!settingsHang) return res([]);
      // A read that never answers: it ends only if the caller gave it a time limit.
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    }
    if (u === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      sent.push({ body, key: init.headers?.['Idempotency-Key'] || init.headers?.['idempotency-key'] });
      const status = resendStatusFor ? resendStatusFor(body) : resendStatus;
      return status === 200 ? res({ id: `e-${sent.length}` }) : res({ message: 'nope' }, status);
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

const domainOf = (v) => String(v).match(/@([^>\s]+)>?\s*$/)?.[1]?.toLowerCase();

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedEnv = { ...process.env };
  savedErr = console.error;
  console.error = () => {};
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits by Alex <noreply@toolkits.example.test>';
  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  process.env.APP_URL = 'https://toolkits.example.test';
  delete process.env.MIGRATION_EMAIL_FROM;
  delete process.env.MIGRATION_REPLY_TO;
  rpcCalls = []; sent = [];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = savedEnv;
  console.error = savedErr;
});

test('no JWT, no email', async () => {
  install({ userOk: false });
  const out = await call({}, {});
  assert.equal(out.statusCode, 403);
  assert.equal(sent.length, 0);
  assert.equal(rpcCalls.length, 0);
});

test('both are emailed From RESEND_FROM\'s domain, answered at support@alexsagun.com, facts from the database only', async () => {
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
    // ★ The From domain is RESEND_FROM's — the one Resend has verified — never alexsagun.com,
    //   which Resend refused with a 403 on every #67 migration email.
    assert.equal(s.body.from, 'Toolkits by Alex Support <support@toolkits.example.test>');
    assert.equal(domainOf(s.body.from), domainOf(process.env.RESEND_FROM));
    assert.equal(s.body.reply_to, 'support@alexsagun.com');
    assert.ok(!JSON.stringify(s.body).includes('attacker@evil.test'), 'nothing from the body reaches an email');
    assert.ok(!JSON.stringify(s.body).includes('Forged'));
    assert.ok(s.body.text && s.body.html, 'multipart');
  }
  const admin = sent.find((s) => s.body.to[0] === 'owner@example.test');
  assert.equal(admin.body.subject, 'Student Successfully Onboarded');
  assert.equal(admin.key, `legacy-onboarded-admin-${ROW_ID}`);
  assert.match(admin.body.text, /\* Package: VIP Package\n/);
  const student = sent.find((s) => s.body.to[0] === 'synthetic.student@example.test');
  assert.equal(student.key, `legacy-onboarded-student-${ROW_ID}`);
  assert.match(student.body.text, /Regards,\nSupport Team\nsupport@alexsagun\.com/);
  assert.ok(student.body.html.includes('mailto:support@alexsagun.com'));
  assert.deepEqual(rpcCalls, [{}, { p_result: 'sent' }], 'reserved, then recorded as sent');
});

test('a caller who is not a migrated, onboarded student gets a skip and no email', async () => {
  install({ claim: { ok: false, skip: 'not_migrated' } });
  const out = await call();
  assert.equal(out.body.ok, false);
  assert.equal(out.body.skipped, 'not_migrated');
  assert.equal(sent.length, 0);
});

test('a provider failure is recorded as failed, with its code, so the next call retries', async () => {
  install({ resendStatus: 500 });
  const out = await call();
  assert.equal(out.body.ok, false);
  assert.deepEqual(rpcCalls.at(-1), { p_result: 'failed', p_code: 'resend_500' });
});

// ★ #68: legacy_import_onboarding_notice refunds the reservation for a refusal that says
//   nothing about the student, so the endpoint must say which refusal it was.
test('when NEITHER email was delivered and both refusals prove it, the code is passed so the try can be refunded', async () => {
  for (const status of [401, 403, 422, 429]) {
    install({ resendStatus: status });
    rpcCalls = []; sent = [];
    const out = await call();
    assert.equal(out.body.ok, false);
    assert.equal(out.body.admin, `resend_${status}`);
    assert.deepEqual(rpcCalls, [{}, { p_result: 'failed', p_code: `resend_${status}` }]);
  }
});

// ★ #68 V2/S2: a refund while one email WAS delivered let every later session send both again,
//   and once Resend's 24-hour idempotency window passed, the delivered one rang again — about
//   once a day, uncapped, for as long as the other half kept failing. (This used to pin the
//   opposite: "admin sent + student 422 → the refundable 422 is recorded".)
test('V2: when one email was delivered, the try is consumed — failed, with no code to refund', async () => {
  for (const [admin, student] of [[200, 422], [200, 429], [200, 403], [422, 200], [429, 200], [200, 500]]) {
    install({ resendStatusFor: (b) => (b.to[0] === FACTS.email ? student : admin) });
    rpcCalls = []; sent = [];
    const out = await call();
    assert.equal(out.body.ok, false);
    assert.deepEqual(rpcCalls, [{}, { p_result: 'failed' }], `admin ${admin}, student ${student}`);
  }
});

test('when both fail and one may have gone out anyway, THAT code is recorded, which is never refunded', async () => {
  install({ resendStatusFor: (b) => (b.to[0] === FACTS.email ? 403 : 500) });
  await call();
  assert.deepEqual(rpcCalls.at(-1), { p_result: 'failed', p_code: 'resend_500' });
  install({ resendStatusFor: (b) => (b.to[0] === FACTS.email ? 500 : 403) });
  rpcCalls = [];
  await call();
  assert.deepEqual(rpcCalls.at(-1), { p_result: 'failed', p_code: 'resend_500' },
    'the student email may have been delivered: the admin\'s refundable 403 must not hand the try back');
});

test('V2: onboardingFailure — a refund is offered only when neither email can have been delivered', async () => {
  const { onboardingFailure } = await import('../api/notify-enrollment.js');
  const ok = { ok: true };
  const f = (code) => ({ ok: false, code });
  assert.deepEqual(onboardingFailure(ok, f('resend_422')), { p_result: 'failed' });
  assert.deepEqual(onboardingFailure(f('resend_429'), ok), { p_result: 'failed' });
  assert.deepEqual(onboardingFailure(f('resend_403'), f('resend_403')), { p_result: 'failed', p_code: 'resend_403' });
  assert.deepEqual(onboardingFailure(f('resend_401'), f('recipient_invalid')), { p_result: 'failed', p_code: 'resend_401' });
  assert.deepEqual(onboardingFailure(f('recipient_invalid'), f('resend_429')), { p_result: 'failed', p_code: 'recipient_invalid' });
  for (const unclear of ['resend_timeout', 'resend_failed', 'resend_409', 'resend_500']) {
    assert.deepEqual(onboardingFailure(f('resend_403'), f(unclear)), { p_result: 'failed', p_code: unclear }, unclear);
    assert.deepEqual(onboardingFailure(f(unclear), f('resend_403')), { p_result: 'failed', p_code: unclear }, unclear);
  }
});

test('V2: a malformed migration address is refused before a try is reserved', async () => {
  for (const [from, replyTo] of [['Support <support@>', undefined], ['not an address', undefined],
    [undefined, 'nobody'], [undefined, 'Help <help@>']]) {
    if (from === undefined) delete process.env.MIGRATION_EMAIL_FROM; else process.env.MIGRATION_EMAIL_FROM = from;
    if (replyTo === undefined) delete process.env.MIGRATION_REPLY_TO; else process.env.MIGRATION_REPLY_TO = replyTo;
    install();
    rpcCalls = []; sent = [];
    const out = await call();
    assert.equal(out.body.ok, false, `${from} / ${replyTo}`);
    assert.equal(out.body.skipped, 'email_address_invalid');
    assert.equal(rpcCalls.length, 0, 'none of the student\'s tries is spent');
    assert.equal(sent.length, 0);
  }
});

test('MIGRATION_EMAIL_FROM overrides the sender and does not move the Reply-To', async () => {
  process.env.MIGRATION_EMAIL_FROM = 'Alex Sagun Support <support@alexsagun.com>';
  install();
  await call();
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.body.from, 'Alex Sagun Support <support@alexsagun.com>');
    assert.equal(s.body.reply_to, 'support@alexsagun.com');
  }
});

test('MIGRATION_REPLY_TO moves the Reply-To and the printed contact, not the From', async () => {
  process.env.MIGRATION_REPLY_TO = 'Help <help@example.org>';
  install();
  await call();
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.equal(s.body.reply_to, 'help@example.org');
    assert.equal(s.body.from, 'Toolkits by Alex Support <support@toolkits.example.test>');
  }
  const student = sent.find((s) => s.body.to[0] === FACTS.email);
  assert.match(student.body.text, /Regards,\nSupport Team\nhelp@example\.org/);
  assert.ok(student.body.html.includes('mailto:help@example.org'));
});

test('with no sender at all, nothing is reserved and nothing is sent', async () => {
  delete process.env.RESEND_FROM;
  install();
  const out = await call();
  assert.equal(out.body.ok, false);
  assert.equal(out.body.skipped, 'email_from_not_configured');
  assert.equal(rpcCalls.length, 0, 'none of the student\'s five tries is spent');
  assert.equal(sent.length, 0);
});

test('a self-paced package is named as the catalog names it, with no batch community', async () => {
  install({ claim: { ...FACTS, plan_key: 'sampler', plan_name: 'Essentials', batch_name: null } });
  await call();
  const student = sent.find((s) => s.body.to[0] === FACTS.email);
  assert.match(student.body.text, /\* Package: Essentials\n/);
  assert.match(student.body.text, /the member community/);
  assert.ok(!/batch community|\(VIP\)/.test(student.body.text + student.body.html));
});

test('a hung admin-address read cannot hold the reserved notice: it gives up and falls back', { timeout: 15_000 }, async () => {
  // The read happens AFTER the reservation; with no time limit, a stalled payment_settings
  // read would hold the student's try until Vercel killed the function.
  delete process.env.NOTIFY_ADMIN_EMAIL;
  install({ settingsHang: true });
  const out = await call();
  assert.equal(out.body.ok, true);
  const admin = sent.find((s) => s.body.to[0] !== FACTS.email);
  assert.deepEqual(admin.body.to, ['noreply@toolkits.example.test'], 'the documented last fallback, RESEND_FROM\'s address');
  assert.deepEqual(rpcCalls.map((a) => a.p_result || 'reserve'), ['reserve', 'sent']);
});

test('the student cannot record the outcome: nothing reaches the notice RPC with their token', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/notify-enrollment.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("if (action === 'import_onboarded')"), src.indexOf("if (action === 'test')"));
  assert.ok(block.length > 200, 'found the handler');
  assert.ok(!/\bu\.token\b/.test(block.replace(/resolveAdminRecipient\(u\.token[^)]*\)/, '')),
    'the student token reaches no database call here but the admin-address read');
  assert.ok(block.includes("svc.rpc('legacy_import_onboarding_notice', { p_user: u.id, ...args })"));
  assert.ok(block.indexOf('callerUser(') < block.indexOf('service()'), 'the service client is built only after the JWT is verified');
  assert.ok(block.indexOf("skipped: 'email_from_not_configured'") < block.indexOf('await notice({})'),
    'the sender is checked before a try is reserved');
  assert.ok(block.indexOf("skipped: 'email_address_invalid'") < block.indexOf('await notice({})'),
    'and so is the form of both addresses');
});

// ★ #68 R6: the 3-second bound on the admin-address read belongs to THIS action only, which
//   holds a reservation while it reads. 'submitted' and 'test' keep their unbounded read —
//   behaviour pinned in test/notifyEnrollmentSubmitted.test.mjs.
test('R6: only import_onboarded bounds the admin-address read', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/notify-enrollment.js', import.meta.url), 'utf8');
  const sites = [...src.matchAll(/await resolveAdminRecipient\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.equal(sites.length, 3, "the three callers: 'submitted', 'import_onboarded', 'test'");
  const block = src.slice(src.indexOf("if (action === 'import_onboarded')"), src.indexOf("if (action === 'test')"));
  assert.ok(block.includes('resolveAdminRecipient(u.token, { timeoutMs: ADMIN_RECIPIENT_TIMEOUT_MS })'));
  assert.deepEqual(sites.filter((a) => /timeoutMs/.test(a)).length, 1, 'exactly one bounded call site');
  assert.ok(sites.includes('u.token') && sites.includes('u?.token'), "'submitted' and 'test' pass no bound");
  assert.match(src, /const ADMIN_RECIPIENT_TIMEOUT_MS = 3_000;/);
});
