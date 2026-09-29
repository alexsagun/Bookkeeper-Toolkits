// ─────────────────────────────────────────────────────────────────────────────
// test/notifyEnrollmentSubmitted.test.mjs — api/notify-enrollment.js 'submitted' and 'test' (#68).
// ─────────────────────────────────────────────────────────────────────────────
// Two things #68's review found in the admin alert a student's submission sends:
//   • L3: the "Agreement" row printed the STORED tier key uppercased — "Signed as SAMPLER ·
//     v2026-09-28" — naming the retired product beside an agreement version whose column
//     heading reads "Essentials". It now prints tierLabelFor()'s heading, and an unknown key
//     prints no tier at all rather than the raw key.
//   • R6: #68 bounded the payment_settings admin-address read at 3 seconds for the onboarding
//     notice, but the function is shared, so a slow read made a student's "new enrollment"
//     alert fall through to RESEND_FROM's no-reply mailbox — recorded as sent, seen by nobody.
//     The bound is now a parameter only 'import_onboarded' passes; 'submitted' and 'test'
//     wait for the read as they did before #68.
//
// No network. globalThis.fetch is a router keyed on URL; an unexpected URL throws.
// Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPA = 'https://notify-submitted-test.supabase.example';
const ANON = 'anon-key-for-notify-submitted-tests';
process.env.VITE_SUPABASE_URL = SUPA;
process.env.VITE_SUPABASE_ANON_KEY = ANON;
const { default: handler } = await import('../api/notify-enrollment.js');

const REQ = '11111111-2222-4333-8444-555555555555';
const ROW = {
  id: REQ, user_id: '66666666-7777-4888-9999-aaaaaaaaaaaa', plan_name: 'Essentials', full_name: 'Synthetic Student',
  email: 'synthetic.student@example.test', phone: '0917', city_country: 'Manila', amount_expected: 1499,
  amount_paid: 1499, payment_reference: null, created_at: '2026-09-28T02:00:00Z', status: 'pending_review',
  notify_status: null, batch_id: null, agreement_version: '2026-09-28', agreement_tier: 'sampler',
};
const OPS = {
  is_staff: true, role_key: 'operations_admin', role_label: 'Operations Admin', status: 'active',
  is_super_admin: false, permissions: ['enrollments.review'], assigned_course_ids: [],
  membership: { exists: true, status: 'active', role_key: 'operations_admin' },
};
const SETTINGS_ADDRESS = 'proofs@example.test';

let savedFetch; let savedEnv; let savedErr; let sent; let settingsReads;

/**
 * @param {object} [o]
 * @param {object} [o.row]            the request row the student's own JWT reads
 * @param {number} [o.settingsDelayMs] how long payment_settings takes to answer
 */
function install({ row = ROW, settingsDelayMs = 0 } = {}) {
  const caller = crypto.randomUUID();   // the burst limiter is per caller, at module scope
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u === `${SUPA}/auth/v1/user`) return res({ id: caller });
    if (u === `${SUPA}/rest/v1/rpc/my_staff_context`) return res(OPS);
    if (u.startsWith(`${SUPA}/rest/v1/enrollment_requests?`)) return res([row]);
    if (u.startsWith(`${SUPA}/rest/v1/subscriptions?`)) return res([]);
    if (u === `${SUPA}/rest/v1/rpc/record_enrollment_notification`) return res(null);
    if (u.startsWith(`${SUPA}/rest/v1/payment_settings?`)) {
      settingsReads.push({ bounded: Boolean(init.signal) });
      // A slow read — answered unless the caller gave it a time limit that runs out first.
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(res([{ value: SETTINGS_ADDRESS }])), settingsDelayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    }
    if (u === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(init.body));
      return res({ id: `e-${sent.length}` });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function call(body) {
  const req = { method: 'POST', headers: { authorization: 'Bearer caller-token', host: 'localhost:5173' }, body };
  const out = { statusCode: 200, body: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
  };
  await handler(req, res);
  return out;
}

const adminAlert = () => sent.find((m) => m.to[0] === SETTINGS_ADDRESS || m.to[0] === 'noreply@example.test');

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedEnv = { ...process.env };
  savedErr = console.error;
  console.error = () => {};
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits <noreply@example.test>';
  process.env.APP_URL = 'https://toolkits.example.test';
  delete process.env.NOTIFY_ADMIN_EMAIL;   // so the payment_settings read is the one that decides
  sent = []; settingsReads = [];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = savedEnv;
  console.error = savedErr;
});

// ── L3 ───────────────────────────────────────────────────────────────────────────────

test('L3: the admin alert names the agreement column the student signed under, never the stored key', async () => {
  for (const [tier, heading] of [['sampler', 'Essentials'], ['silver', 'Silver · Self-Paced'], ['vip', 'VIP Package']]) {
    install({ row: { ...ROW, agreement_tier: tier } });
    sent = [];
    const out = await call({ action: 'submitted', requestId: REQ });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    const alert = adminAlert();
    assert.ok(alert, 'the admin alert went out');
    assert.ok(alert.html.includes(`Signed as ${heading} · v2026-09-28`), `${tier} → ${heading}`);
    assert.ok(!alert.html.includes(`Signed as ${tier.toUpperCase()} ·`), `the stored key ${tier} is never printed`);
    // ("VIP" is also the first word of its own heading, so only the other two can be absent outright.)
    if (tier !== 'vip') assert.ok(!alert.html.includes(tier.toUpperCase()), `no ${tier.toUpperCase()} anywhere`);
  }
});

test('L3: an unknown or missing tier prints no tier at all, never the raw key', async () => {
  for (const tier of ['gold', null]) {
    install({ row: { ...ROW, agreement_tier: tier } });
    sent = [];
    await call({ action: 'submitted', requestId: REQ });
    const alert = adminAlert();
    assert.ok(alert.html.includes('Signed · v2026-09-28'), String(tier));
    assert.ok(!/GOLD|gold/.test(alert.html), 'the key never reaches the email');
  }
});

// ── R6 ───────────────────────────────────────────────────────────────────────────────

test('R6: a student\'s "new enrollment" alert waits for a slow admin-address read instead of falling back', { timeout: 20_000 }, async () => {
  install({ settingsDelayMs: 3_400 });
  const out = await call({ action: 'submitted', requestId: REQ });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(settingsReads, [{ bounded: false }], 'no time limit on this read');
  assert.deepEqual(adminAlert().to, [SETTINGS_ADDRESS], 'the configured Proof/support address, not the no-reply From');
});

test('R6: the admin "Test email" still resolves a slow payment_settings address', { timeout: 20_000 }, async () => {
  install({ settingsDelayMs: 3_400 });
  const out = await call({ action: 'test' });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.to, SETTINGS_ADDRESS);
  assert.equal(out.body.source, 'payment_settings');
  assert.deepEqual(settingsReads, [{ bounded: false }]);
});
