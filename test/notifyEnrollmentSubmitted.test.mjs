// ─────────────────────────────────────────────────────────────────────────────
// test/notifyEnrollmentSubmitted.test.mjs — api/notify-enrollment.js 'submitted' and 'test' (#68, #69).
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
// And what #69 changed about the same submission:
//   • THE STUDENT COPY GOES TO THE ACCOUNT, NEVER TO THE ADDRESS TYPED ON THE REQUEST. The
//     row's `email` is written by the student (enroll_req_own_insert checks user_id, status and
//     batch — not email), so any signed-in account could file a request naming a stranger and
//     have the business's branded "Enrollment received" delivered there. The confirmation now
//     goes to profiles.email, read with the caller's own JWT, and is skipped when that address
//     cannot be read. The admin alert names the account, and shows the typed address beside it
//     only when the two differ.
//   • The package, its scope and the cohort come from the catalog (enrollment_plans, batches),
//     never from the row's snapshot; VIP-ness is the plan's community_segment, never its key.
//   • Both emails carry a text part, a stable idempotency key (so a retry is a retry, not a
//     second email) and — the student copy — a Reply-To that is never RESEND_FROM.
//   • Every one of those reads is best-effort: the four #68 tests below run with none of them
//     routed, which IS the "facts unavailable" path, and the admin alert still goes out.
//
// And what the final review of #69 (Task 13) changed, pinned at the end of this file:
//   • EMAIL-4: an alert whose send got NO CLEAR ANSWER — an attempt that ran out of time or lost
//     its connection, a provider 5xx, a 409 that is not "in progress" — may have been delivered,
//     so it is recorded as notify_status 'provider_unclear' (the badge says "may not have been
//     sent"), never as 'provider_error' (the badge says "not sent"). The detail is still a slug.
//   • EMAIL-2: sendEmail can name a 409 (classify409) — only the provider's own "in progress" is
//     another invocation's to finish — and every other caller still gets the bare 'resend_409'.
//   • EMAIL-3: a row is ONE line for every mandatory line break in Unicode, not only CR and LF.
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
const { plainTextEmail } = await import('../api/_lib/email.js');

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

// ── #69 fixtures ─────────────────────────────────────────────────────────────────────
// The ACCOUNT (profiles) differs from what the row carries on purpose: only the account
// address may ever be mailed, and only the account name leads the alert.
const PROFILE = { email: 'account.holder@example.test', full_name: 'Account Holder' };
const TYPED = 'typed-on-the-form@third-party.test';
const BATCH_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const BATCH = { name: 'October 2026', code: '2026-10' };
const ESSENTIALS = {
  key: 'sampler', name: 'Essentials', tagline: 'Sampler Session', price_php: 1499, access_days: 60,
  entitlement_summary: ['60-day course access', '60-day group chat support', '1 live Zoom session'],
  community_segment: 'general',
};
const VIP = {
  key: 'vip', name: 'VIP Package', tagline: 'Personalized Coaching Program', price_php: 16999, access_days: 180,
  entitlement_summary: ['180-day full access', '1-on-1 coaching', 'Weekly consult until hired'],
  community_segment: 'vip',
};

let savedFetch; let savedEnv; let savedConsole; let sent; let settingsReads;
// #69: the Idempotency-Key of each send (index-aligned with `sent`), every
// record_enrollment_notification body, the facts reads, and each request-row select list.
let keys; let recorded; let reads; let requestSelects;
// Every line the handler wrote to the console, at any level. Nothing it logs may carry an
// address, the provider's words, a key or a token — and a delivered email logs nothing.
let logged;

// A read that never answers: only the CALLER's own time limit can end it.
const never = (init) => new Promise((_, reject) => {
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
});

/**
 * @param {object} [o]
 * @param {object} [o.row]            the request row the student's own JWT reads
 * @param {number} [o.settingsDelayMs] how long payment_settings takes to answer
 *
 * #69 — each of these is UNROUTED unless given, so a test that names none of them (the four
 * #68 tests) runs the "facts unavailable" path: the read throws and the handler carries on.
 * @param {object|null} [o.profile]   the request owner's profiles row; null = no row
 * @param {object|null} [o.plan]      the enrollment_plans row for row.plan_key; null = no row
 * @param {object|null} [o.batch]     the batches row for row.batch_id; null = no row
 * @param {string|null} [o.settingsValue]   what payment_settings.notify_email holds
 * @param {object[]}    [o.subscriptions]   the caller's prior terms (the renewal inference)
 * @param {string[]}    [o.missingColumns]  columns this database lacks: a select naming one is a 400
 * @param {(body: object) => number|string|object} [o.resendStatusFor]  the provider's answer per
 *        message: a status; 0 = the request never gets an answer; 'timeout' = the attempt runs out
 *        of time; { status: 409, name } = a 409 carrying Resend's error name (null = not JSON).
 *        A bare 409 is the one Resend sends while the same key is still being processed.
 * @param {string[]}    [o.hang]  the facts reads that never answer — 'subscriptions', 'profiles',
 *                                'enrollment_plans', 'batches' (the last three must also be routed)
 */
function install({
  row = ROW, settingsDelayMs = 0, profile, plan, batch,
  settingsValue = SETTINGS_ADDRESS, subscriptions = [], missingColumns = [], resendStatusFor = null, hang = [],
} = {}) {
  const caller = crypto.randomUUID();   // the burst limiter is per caller, at module scope
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
    const auth = () => String(new Headers(init.headers).get('authorization'));
    if (u === `${SUPA}/auth/v1/user`) return res({ id: caller });
    if (u === `${SUPA}/rest/v1/rpc/my_staff_context`) return res(OPS);
    if (u.startsWith(`${SUPA}/rest/v1/enrollment_requests?`)) {
      const select = decodeURIComponent(u.split('&select=')[1] || '').split(',');
      if (missingColumns.some((c) => select.includes(c))) return res({ code: '42703', message: 'column does not exist' }, 400);
      requestSelects.push(select);
      return res([row]);
    }
    // One of the facts reads: recorded with whether the caller gave it a time limit, then
    // answered — or, when the test hangs that table, never.
    const factsRead = (table, answer) => {
      reads.push({ table, url: u, auth: auth(), bounded: Boolean(init.signal) });
      return hang.includes(table) ? never(init) : res(answer);
    };
    if (u.startsWith(`${SUPA}/rest/v1/subscriptions?`)) return factsRead('subscriptions', subscriptions);
    if (u === `${SUPA}/rest/v1/rpc/record_enrollment_notification`) { recorded.push(JSON.parse(init.body)); return res(null); }
    if (u.startsWith(`${SUPA}/rest/v1/payment_settings?`)) {
      settingsReads.push({ bounded: Boolean(init.signal) });
      // A slow read — answered unless the caller gave it a time limit that runs out first.
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(res(settingsValue == null ? [] : [{ value: settingsValue }])), settingsDelayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    }
    if (profile !== undefined && u.startsWith(`${SUPA}/rest/v1/profiles?`)) return factsRead('profiles', profile ? [profile] : []);
    if (plan !== undefined && u.startsWith(`${SUPA}/rest/v1/enrollment_plans?`)) return factsRead('enrollment_plans', plan ? [plan] : []);
    if (batch !== undefined && u.startsWith(`${SUPA}/rest/v1/batches?`)) return factsRead('batches', batch ? [batch] : []);
    if (u === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      sent.push(body);
      keys.push(new Headers(init.headers).get('idempotency-key'));
      const answer = resendStatusFor ? resendStatusFor(body) : 200;
      const status = answer && typeof answer === 'object' ? answer.status : answer;
      if (status === 0) throw new TypeError('fetch failed');   // the request got no answer at all
      if (status === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      if (status === 409) {
        // Resend's 409 names WHICH conflict it is (docs: idempotency keys, "Possible responses").
        const name = answer && typeof answer === 'object' ? answer.name : 'concurrent_idempotent_requests';
        return name === null ? new Response('<html>409 Conflict</html>', { status: 409 })
          : res({ statusCode: 409, name, message: `PROVIDER-SENTENCE about ${body.to[0]}` }, 409);
      }
      // A refusal body names the recipient, as the real provider's does: nothing may store it.
      return status === 200 ? res({ id: `e-${sent.length}` })
        : res({ name: 'validation_error', message: `PROVIDER-SENTENCE about ${body.to[0]}` }, status);
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
  logged = [];
  savedConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const level of Object.keys(savedConsole)) console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits <noreply@example.test>';
  process.env.APP_URL = 'https://toolkits.example.test';
  delete process.env.NOTIFY_ADMIN_EMAIL;   // so the payment_settings read is the one that decides
  delete process.env.VERCEL_ENV;           // a developer's machine, unless a test says otherwise
  sent = []; settingsReads = [];
  keys = []; recorded = []; reads = []; requestSelects = [];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = savedEnv;
  Object.assign(console, savedConsole);
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

// ═════════════════════════════════════════════════════════════════════════════════════
// #69
// ═════════════════════════════════════════════════════════════════════════════════════

/** Every href in an HTML part, entity-decoded back to the address a click would open. */
const hrefsOf = (html) => [...String(html).matchAll(/href="([^"]*)"/g)].map((m) => m[1]
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

// ★ THE ROW EVERY #69 TEST STARTS FROM CARRIES plan_key, as every real row does (the column
//   is NOT NULL). The #68 fixture above predates the handler reading it, and a row without
//   one is never looked up in the catalog at all — so a test built on it would "pass" any
//   assertion about what the catalog must NOT print, without the catalog ever being read.
const ROW69 = { ...ROW, plan_key: 'sampler' };
const install69 = (opts = {}) => install({ row: ROW69, ...opts });

const studentCopy = () => sent.find((m) => m.to[0] === PROFILE.email);
const submit = () => call({ action: 'submitted', requestId: REQ });

// ── Who is emailed ───────────────────────────────────────────────────────────────────

test('#69: the student copy goes ONLY to the account address, never the one typed on the request', async () => {
  install69({ row: { ...ROW69, email: TYPED }, profile: PROFILE, plan: ESSENTIALS });
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(sent.length, 2, 'the admin alert, then the student confirmation');
  const student = studentCopy();
  assert.ok(student, 'the confirmation went to profiles.email');
  for (const m of sent) {
    assert.ok(!m.to.includes(TYPED), 'no message is addressed to the typed address');
    assert.notEqual(m.reply_to, TYPED, 'nor answered at it');
    assert.ok(!(m.cc || m.bcc), 'and nothing is copied anywhere');
  }
  assert.ok(!JSON.stringify(student).includes(TYPED), 'the typed address is nowhere in the student copy');
  // The account looked up is the REQUEST's own user, asked with the caller's own JWT.
  const lookup = reads.filter((r) => r.table === 'profiles');
  assert.equal(lookup.length, 1);
  assert.ok(lookup[0].url.includes(`id=eq.${ROW.user_id}`) && lookup[0].url.includes('select=email,full_name'));
  assert.equal(lookup[0].auth, 'Bearer caller-token');
  assert.equal(out.body.student, 'sent');
});

test('#69: with no readable account address there is NO student copy — and the admin alert still goes', async () => {
  const cases = [
    ['the read fails', undefined],
    ['there is no profile row', null],
    ['the account address is not an address', { email: 'not-an-address', full_name: 'Account Holder' }],
    ['the account address is empty', { email: null, full_name: 'Account Holder' }],
  ];
  for (const [why, profile] of cases) {
    sent = []; recorded = [];
    install69({ row: { ...ROW69, email: TYPED }, profile, plan: ESSENTIALS });
    const out = await submit();
    assert.equal(out.statusCode, 200, `${why}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.ok, true, why);
    assert.equal(sent.length, 1, `${why}: exactly the admin alert`);
    assert.deepEqual(sent[0].to, [SETTINGS_ADDRESS], why);
    assert.equal(out.body.student, 'no_account_address', why);
    assert.equal(recorded.at(-1).p_status, 'sent', `${why}: the alert is recorded as delivered`);
  }
});

test('#69: the admin alert names the ACCOUNT, and shows the address typed on the form only when it differs', async () => {
  install69({ row: { ...ROW69, email: TYPED, full_name: 'Name Typed On Form' }, profile: PROFILE, plan: ESSENTIALS });
  await submit();
  const alert = adminAlert();
  assert.equal(alert.subject, 'New enrollment submitted — Account Holder · Essentials');
  assert.match(alert.text, /\n {2}\* Student: Account Holder\n/);
  assert.match(alert.text, /\n {2}\* Name on form: Name Typed On Form\n/);
  assert.match(alert.text, /\n {2}\* Email: account\.holder@example\.test\n/);
  assert.match(alert.text, /\n {2}\* Contact email on form: typed-on-the-form@third-party\.test\n/);
  for (const s of ['Account Holder', PROFILE.email, 'Contact email on form', TYPED]) assert.ok(alert.html.includes(s), s);

  // The same address (whatever its case) and the same name are not repeated.
  sent = [];
  install69({ row: { ...ROW69, email: 'Account.Holder@Example.test', full_name: 'account holder' }, profile: PROFILE, plan: ESSENTIALS });
  await submit();
  const same = adminAlert();
  assert.ok(!/Contact email on form|Name on form/.test(same.html + same.text), 'nothing differs, so nothing is added');
  assert.match(same.text, /\n {2}\* Email: account\.holder@example\.test\n/);
});

test('#69: when the account cannot be read, the typed address is shown as what it is — never as "Email"', async () => {
  install69({ row: { ...ROW69, email: TYPED } });   // profile, plan and batch all unrouted
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  const alert = adminAlert();
  assert.match(alert.text, /\n {2}\* Student: Synthetic Student\n/, 'the row\'s name stands in');
  assert.match(alert.text, /\n {2}\* Contact email on form: typed-on-the-form@third-party\.test\n/);
  assert.doesNotMatch(alert.text, /\n {2}\* Email: /, 'an unverified address is not labelled as the account\'s');
  assert.match(alert.text, /\n {2}\* Package: Essentials\n/, 'the row\'s snapshot names the package');
  assert.doesNotMatch(alert.text, /Program access|Cohort|Package price/, 'and no catalog fact is invented');
});

// ── The facts reads are bounded ──────────────────────────────────────────────────────

/** `promise` — or null once `ms` have passed, so a handler that never returns fails its test instead of hanging the file. */
const within = (ms, promise) => {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })])
    .finally(() => clearTimeout(timer));
};

test('#69: every facts read carries a time limit — one that never answers cannot hold the admin alert', { timeout: 30_000 }, async () => {
  // All four at once: whether this student has had a term before (the renewal inference), the
  // account, the package and the cohort. They are awaited TOGETHER, so one of them left
  // without a limit holds the alert however well the other three are bounded — and the
  // alert is the email that decides whether a payment is ever reviewed.
  install69({
    row: { ...ROW69, email: TYPED, plan_key: 'vip', batch_id: BATCH_ID },
    profile: PROFILE, plan: VIP, batch: BATCH,
    hang: ['subscriptions', 'profiles', 'enrollment_plans', 'batches'],
  });
  const out = await within(9_000, submit());
  assert.deepEqual(reads.map((r) => r.table).sort(), ['batches', 'enrollment_plans', 'profiles', 'subscriptions'], 'all four were asked');
  assert.deepEqual(reads.filter((r) => !r.bounded).map((r) => r.table), [], 'a read with no time limit can hold the alert for ever');
  assert.ok(out, 'the handler was still waiting on a read that never answered');
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(sent.length, 1, 'the admin alert — and no student copy, because the account could not be read');
  assert.deepEqual(sent[0].to, [SETTINGS_ADDRESS]);
  assert.equal(out.body.student, 'no_account_address');
  assert.deepEqual(recorded, [{ p_request_id: REQ, p_status: 'sent', p_detail: 'resend:e-1' }]);
  // What could not be read is not guessed. The renewal inference falls back to "New
  // enrollment" — a label, never a refusal — and no catalog fact is printed.
  const alert = adminAlert();
  assert.match(alert.text, /\n {2}\* Type: New enrollment\n/);
  assert.match(alert.text, /\n {2}\* Student: Synthetic Student\n/);
  assert.match(alert.text, /\n {2}\* Contact email on form: typed-on-the-form@third-party\.test\n/);
  assert.doesNotMatch(alert.text, /\n {2}\* Email: |Program access|Cohort|Package price/);
});

// ── What the alert states ────────────────────────────────────────────────────────────

test('#69: the package comes from the catalog — name, tagline, price, access and a "Program access" row', async () => {
  install69({ row: { ...ROW69, plan_key: 'sampler', plan_name: 'Stale Snapshot Name' }, profile: PROFILE, plan: ESSENTIALS });
  await submit();
  const alert = adminAlert();
  assert.match(alert.text, /\n {2}\* Package: Essentials \(Sampler Session\)\n/);
  assert.match(alert.text, /\n {2}\* Package price: ₱1,499\n/);
  assert.match(alert.text, /\n {2}\* Access: 60 days\n/);
  assert.match(alert.text, /\n {2}\* Program access: 60-day course access · 60-day group chat support · 1 live Zoom session\n/);
  assert.ok(alert.html.includes('Program access') && alert.html.includes('60-day course access · 60-day group chat support · 1 live Zoom session'));
  assert.ok(!/Stale Snapshot Name/.test(alert.html + alert.text + alert.subject), 'the student-written snapshot is not what is printed');
  assert.ok(!/Stale Snapshot Name/.test(JSON.stringify(studentCopy())), 'nor in the student copy');
  const lookup = reads.filter((r) => r.table === 'enrollment_plans');
  assert.equal(lookup.length, 1);
  assert.ok(lookup[0].url.includes('key=eq.sampler'), 'looked up by the request\'s plan_key');
  assert.equal(lookup[0].auth, 'Bearer caller-token');
  // The Agreement row still prints the tier's heading, through tierLabelFor().
  assert.match(alert.text, /\n {2}\* Agreement: Signed as Essentials · v2026-09-28\n/);
});

test('#69: Type comes from request_kind, and an extension shows "Extension: N days" with the amount expected', async () => {
  const typeOf = async (row, extra = {}) => {
    sent = [];
    install69({ row: { ...ROW69, ...row }, profile: PROFILE, plan: ESSENTIALS, ...extra });
    await submit();
    return adminAlert();
  };
  assert.match((await typeOf({ request_kind: 'renewal' })).text, /\n {2}\* Type: Renewal\n/);
  assert.match((await typeOf({ request_kind: 'upgrade' })).text, /\n {2}\* Type: Upgrade\n/);

  const ext = await typeOf({ request_kind: 'extension', extension_days: 90, amount_expected: 2248.5, amount_paid: 2248.5 });
  assert.match(ext.text, /\n {2}\* Type: Extension: 90 days\n/);
  assert.ok(ext.html.includes('Extension: 90 days'));
  assert.match(ext.text, /\n {2}\* Expected: ₱2,248\.5\n/, 'the extension\'s own price, not the package price');
  // …and neither is the package's scope line: its chips open with the plan's OWN length
  // ("60-day course access"), a second and different duration beside "Extension: 90 days".
  assert.doesNotMatch(ext.text, /Package price|\* Access: |Program access|60-day/, 'the catalog price, length and scope are not this request\'s');
  assert.ok(!/Package price|Program access|60-day/.test(ext.html), 'nor in the HTML part');
  assert.match(ext.text, /\n {2}\* Package: Essentials \(Sampler Session\)\n/, 'the package itself is still named');
  assert.match(ext.subject, /^Extension submitted — /);
  // Every other kind keeps the scope line: there the plan's length IS what is being bought.
  for (const kind of ['renewal', 'upgrade']) {
    assert.match((await typeOf({ request_kind: kind })).text,
      /\n {2}\* Program access: 60-day course access · 60-day group chat support · 1 live Zoom session\n/, kind);
  }
  assert.ok(!reads.some((r) => r.table === 'subscriptions'), 'a recorded kind needs no inference');

  // 'new' (or no column at all, before #20) keeps the renewal inference the Enrollments card uses.
  assert.match((await typeOf({ request_kind: 'new' })).text, /\n {2}\* Type: New enrollment\n/);
  assert.match((await typeOf({ request_kind: 'new' }, { subscriptions: [{ id: 'prior-term' }] })).text, /\n {2}\* Type: Renewal\n/);
  assert.match((await typeOf({}, { subscriptions: [{ id: 'prior-term' }] })).text, /\n {2}\* Type: Renewal\n/);
  // A value the CHECK would never allow prints nothing of itself.
  const odd = await typeOf({ request_kind: 'constructor' });
  assert.match(odd.text, /\n {2}\* Type: New enrollment\n/);
});

test('#69: the cohort row follows the plan\'s community_segment — never its key', async () => {
  const cohortOf = async (row, extra) => {
    sent = [];
    install69({ row: { ...ROW69, ...row }, profile: PROFILE, ...extra });
    await submit();
    const alert = adminAlert();
    return { alert, line: (alert.text.match(/\n {2}\* Cohort: ([^\n]*)\n/) || [])[1] ?? null };
  };
  const chosen = await cohortOf({ plan_key: 'vip', batch_id: BATCH_ID }, { plan: VIP, batch: BATCH });
  assert.equal(chosen.line, 'October 2026 — confirmed at approval');
  assert.ok(chosen.alert.html.includes('October 2026 — confirmed at approval'));
  const lookup = reads.filter((r) => r.table === 'batches');
  assert.ok(lookup.at(-1).url.includes(`id=eq.${BATCH_ID}`) && lookup.at(-1).auth === 'Bearer caller-token');

  // A VIP member renewing or extending picks nothing: the cohort they hold carries on.
  for (const kind of ['renewal', 'extension']) {
    const none = await cohortOf({ plan_key: 'vip', batch_id: null, request_kind: kind, extension_days: 60 }, { plan: VIP, batch: BATCH });
    assert.equal(none.line, 'Current cohort continues (set at approval)', kind);
  }
  // A NEW VIP enrollment (or an upgrade into VIP) with no batch has no current cohort to continue.
  for (const kind of ['new', 'upgrade']) {
    const none = await cohortOf({ plan_key: 'vip', batch_id: null, request_kind: kind }, { plan: VIP, batch: BATCH });
    assert.equal(none.line, 'Not chosen — assigned at approval', kind);
  }
  assert.equal((await cohortOf({ plan_key: 'sampler', batch_id: null }, { plan: ESSENTIALS })).line, 'No batch cohort');

  // ★ The segment decides. A plan KEYED 'sampler' that is a VIP segment has a cohort; one keyed
  //   'vip' that is not, has none.
  const bySegment = await cohortOf({ plan_key: 'sampler', batch_id: BATCH_ID }, { plan: { ...ESSENTIALS, community_segment: 'vip' }, batch: BATCH });
  assert.equal(bySegment.line, 'October 2026 — confirmed at approval');
  assert.equal((await cohortOf({ plan_key: 'vip', batch_id: BATCH_ID }, { plan: { ...VIP, community_segment: 'general' }, batch: BATCH })).line,
    'No batch cohort');

  // Unknown is not guessed: no catalog row, or a batch that cannot be read, prints no cohort row.
  assert.equal((await cohortOf({ plan_key: 'vip', batch_id: BATCH_ID }, { batch: BATCH })).line, null, 'the plan could not be read');
  assert.equal((await cohortOf({ plan_key: 'vip', batch_id: BATCH_ID }, { plan: VIP })).line, null, 'the batch could not be read');
});

test('#69: the "Submitted" row is a Manila calendar day and hour, not a UTC one', async () => {
  // 17:30 UTC on the 28th is 01:30 on the 29th in Manila.
  install69({ row: { ...ROW69, created_at: '2026-09-28T17:30:00+00:00' }, profile: PROFILE, plan: ESSENTIALS });
  await submit();
  assert.match(adminAlert().text, /\n {2}\* Submitted: September 29, 2026 · 1:30 AM \(Manila time\)\n/);
  assert.ok(!/GMT/.test(adminAlert().html + adminAlert().text));
});

// ── Links ────────────────────────────────────────────────────────────────────────────

test('#69: the review button opens THE request, and every link in an HTML part is in its text part', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS });
  await submit();
  const alert = adminAlert();
  const link = `https://toolkits.example.test/admin/enrollments?request=${REQ}`;
  assert.deepEqual(hrefsOf(alert.html), [link], 'one link: the record, not the queue');
  assert.ok(alert.text.includes(`Review in Enrollments: ${link}`));

  const student = studentCopy();
  const studentLinks = hrefsOf(student.html);
  assert.deepEqual(studentLinks, ['https://www.youtube.com/watch?v=U78IBZwIr7U'], 'the onboarding video');
  for (const m of [alert, student]) {
    assert.ok(m.text && m.html, 'multipart');
    for (const href of hrefsOf(m.html)) assert.ok(m.text.includes(href), `${href} is missing from the text part`);
    assert.ok(!/<[a-z!/]/i.test(m.text), 'the text part is text');
  }
});

test('#69: on Vercel without APP_URL there is no link at all — the request\'s host is never trusted there', async () => {
  delete process.env.APP_URL;
  process.env.VERCEL_ENV = 'preview';
  install69({ profile: PROFILE, plan: ESSENTIALS });
  await submit();
  const alert = adminAlert();
  assert.deepEqual(hrefsOf(alert.html), [], 'a preview shares production\'s database: no link from its Host header');
  assert.ok(!/localhost|Review in Enrollments/.test(alert.html + alert.text));

  // Under `npm run dev` (no VERCEL_ENV) the local origin is the only one there is.
  delete process.env.VERCEL_ENV;
  sent = [];
  install69({ profile: PROFILE, plan: ESSENTIALS });
  await submit();
  assert.deepEqual(hrefsOf(adminAlert().html), [`http://localhost:5173/admin/enrollments?request=${REQ}`]);
});

test('#69: neither email carries a storage path or a signed URL', async () => {
  const uid = ROW.user_id;
  install69({
    row: {
      ...ROW69,
      receipt_path: `${uid}/receipt-0a1b2c3d-proof.png`,
      resume_path: `${uid}/resume-0a1b2c3d-cv.pdf`,
      signature_path: `${uid}/signature-0a1b2c3d.png`,
      agreement_pdf_path: `${uid}/agreement-0a1b2c3d.pdf`,
    },
    profile: PROFILE, plan: ESSENTIALS,
  });
  await submit();
  assert.equal(sent.length, 2);
  for (const m of sent) {
    const all = `${m.subject}\n${m.html}\n${m.text}`;
    for (const banned of ['receipt_path', 'enrollment-receipts', '/storage/', '/object/sign/', 'token=', `${uid}/`, 'receipt-0a1b2c3d', 'resume-0a1b2c3d']) {
      assert.ok(!all.includes(banned), `${banned} must not reach an email`);
    }
    // Neither email so much as mentions the receipt or where files are kept: the admin opens
    // the proof from Enrollments, signed in, and nowhere else.
    assert.doesNotMatch(all, /receipt|storage/i);
  }
  // The admin is still told a resume exists — and where to open it.
  assert.match(adminAlert().text, /\n {2}\* Resume: Attached — open it from Enrollments\n/);
});

// ── Idempotency, Reply-To and the recorded outcome ───────────────────────────────────

test('#69: each email carries a stable idempotency key and a text part; the outcome is recorded once', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS });
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(keys, [`enrollment-submitted-admin-${REQ}`, `enrollment-submitted-student-${REQ}`]);
  assert.deepEqual(sent.map((m) => m.to[0]), [SETTINGS_ADDRESS, PROFILE.email], 'the admin alert first, then the student');
  for (const m of sent) assert.ok(typeof m.text === 'string' && m.text.length > 40 && m.html.length > 40);
  assert.deepEqual(recorded, [{ p_request_id: REQ, p_status: 'sent', p_detail: 'resend:e-1' }]);
  // Sending it again is the same two keys: the provider de-duplicates, nothing is minted.
  sent = []; keys = [];
  install69({ profile: PROFILE, plan: ESSENTIALS });
  await submit();
  assert.deepEqual(keys, [`enrollment-submitted-admin-${REQ}`, `enrollment-submitted-student-${REQ}`]);
});

test('#69: both keys are built from the ROW\'s id — the same request in another letter-case is the same two emails', async () => {
  // The database resolves a uuid spelled in either case to the same row. A key built from the
  // BODY's spelling would differ between AAAA… and aaaa…, so the provider would de-duplicate
  // neither — and that de-duplication is the real replay bound here, because the row's own
  // notify_status is a stamp its owner can overwrite (record_enrollment_notification).
  // REQ is all digits, so it cannot tell the two apart; this id has letters in it.
  const LETTERS = 'abcdef12-2222-4333-8444-555555555555';
  install69({ row: { ...ROW69, id: LETTERS }, profile: PROFILE, plan: ESSENTIALS });
  const out = await call({ action: 'submitted', requestId: LETTERS.toUpperCase() });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(keys, [`enrollment-submitted-admin-${LETTERS}`, `enrollment-submitted-student-${LETTERS}`]);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9:_-]{8,128}$/, 'a key outside this set is silently replaced by a random one');
  // The review link names the row as the database stores it, too.
  assert.deepEqual(hrefsOf(adminAlert().html), [`https://toolkits.example.test/admin/enrollments?request=${LETTERS}`]);

  // Spelled as stored, it is the same two keys: one request, one pair of emails.
  const first = [...keys];
  keys = []; sent = [];
  install69({ row: { ...ROW69, id: LETTERS }, profile: PROFILE, plan: ESSENTIALS });
  await call({ action: 'submitted', requestId: LETTERS });
  assert.deepEqual(keys, first);
});

test('#69: the student Reply-To comes from the ONE payment_settings read — never a second one', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS });
  await submit();
  assert.deepEqual(settingsReads, [{ bounded: false }], 'exactly the read the admin recipient already makes');
  assert.equal(studentCopy().reply_to, SETTINGS_ADDRESS);
  assert.equal(adminAlert().reply_to, undefined, 'the admin alert is not a student-facing message');
});

test('#69: with NOTIFY_ADMIN_EMAIL set, replies still go to the stored support address first, then to it', async () => {
  // The admin ALERT goes to the env address and never reads payment_settings; the student's
  // Reply-To prefers the admin-editable support address, so it is read once, with a time limit.
  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  install69({ profile: PROFILE, plan: ESSENTIALS });
  await submit();
  assert.deepEqual(sent[0].to, ['owner@example.test']);
  assert.equal(studentCopy().reply_to, SETTINGS_ADDRESS);
  assert.deepEqual(settingsReads, [{ bounded: true }], 'one read, and it cannot hang the function');

  for (const settingsValue of [null, 'not an address', 'two@example.test, three@example.test']) {
    sent = []; settingsReads = [];
    install69({ profile: PROFILE, plan: ESSENTIALS, settingsValue });
    await submit();
    assert.equal(studentCopy().reply_to, 'owner@example.test', `stored ${JSON.stringify(settingsValue)} → the env address`);
    assert.equal(settingsReads.length, 1);
  }
});

test('#69: the Reply-To is never RESEND_FROM — with nowhere to reply, the header is left out', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS, settingsValue: null });
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(adminAlert().to, ['noreply@example.test'], 'the ALERT keeps its documented last fallback');
  const student = studentCopy();
  assert.ok(student, 'the confirmation is still sent');
  assert.ok(!('reply_to' in student), 'no Reply-To at all');
  assert.ok(!JSON.stringify(student.reply_to ?? '').includes('noreply@example.test'));
  assert.deepEqual(settingsReads, [{ bounded: false }]);
});

test('#69: a refused admin alert records the provider CODE, and no student copy is sent', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS, resendStatusFor: () => 422 });
  const out = await submit();
  assert.equal(out.statusCode, 502);
  assert.equal(out.body.ok, false);
  assert.equal(sent.length, 1, 'the student is not told "received" for an alert nobody got');
  assert.deepEqual(recorded, [{ p_request_id: REQ, p_status: 'provider_error', p_detail: 'resend_422' }]);
  assert.ok(!JSON.stringify(recorded).includes('PROVIDER-SENTENCE'), 'the provider\'s sentence is never stored on the student\'s row');
  assert.ok(!JSON.stringify(out.body).includes('PROVIDER-SENTENCE'));

  // An attempt that got NO answer is recorded as that — a code, where it used to be the
  // words 'send failed' — and it was retried under the SAME key, never a second one. And it is
  // not a refusal: a request that got no answer may have been delivered (EMAIL-4).
  sent = []; keys = []; recorded = [];
  install69({ profile: PROFILE, plan: ESSENTIALS, resendStatusFor: () => 0 });
  const dropped = await submit();
  assert.equal(dropped.statusCode, 502);
  assert.deepEqual(recorded, [{ p_request_id: REQ, p_status: 'provider_unclear', p_detail: 'resend_failed' }]);
  assert.deepEqual(keys, [`enrollment-submitted-admin-${REQ}`, `enrollment-submitted-admin-${REQ}`], 'two attempts, one key');
});

test('#69: a 409 for the same key means the alert is already in flight — nothing is recorded over it', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS, resendStatusFor: () => 409 });
  const out = await submit();
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { ok: false, skipped: 'in_flight' });
  assert.deepEqual(recorded, [], 'an earlier "sent" stamp must never be replaced by a provider_error');
  assert.equal(sent.length, 1, 'and the other invocation owns the student copy');
});

test('#69: a request already alerted, or already decided, sends nothing at all — before any fact is read', async () => {
  for (const [row, skipped] of [
    [{ ...ROW69, notify_status: 'sent' }, 'already_notified'],
    [{ ...ROW69, status: 'approved' }, 'not_pending_review'],
    [{ ...ROW69, status: 'rejected' }, 'not_pending_review'],
  ]) {
    reads = []; settingsReads = [];
    install69({ row, profile: PROFILE, plan: ESSENTIALS });
    const out = await submit();
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body, { ok: false, skipped });
    assert.deepEqual([sent.length, recorded.length, reads.length, settingsReads.length], [0, 0, 0, 0], skipped);
  }
  // Email not configured: the skip is stamped on the row, and still nothing is read or sent.
  delete process.env.RESEND_API_KEY;
  install69({ profile: PROFILE, plan: ESSENTIALS });
  const out = await submit();
  assert.deepEqual(out.body, { ok: false, skipped: 'email_not_configured' });
  assert.deepEqual(recorded, [{ p_request_id: REQ, p_status: 'email_not_configured', p_detail: null }]);
  assert.deepEqual([sent.length, reads.length, settingsReads.length], [0, 0, 0]);
});

test('#69: a student copy that fails never changes the admin outcome', async () => {
  install69({ profile: PROFILE, plan: ESSENTIALS, resendStatusFor: (b) => (b.to[0] === PROFILE.email ? 422 : 200) });
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.student, 'resend_422');
  assert.deepEqual(recorded, [{ p_request_id: REQ, p_status: 'sent', p_detail: 'resend:e-1' }]);
});

// ── What reaches a log ───────────────────────────────────────────────────────────────

test('#69: a refused send is logged as a status code — never the provider\'s sentence, an address, a name, a key or a token', async () => {
  // With NOTIFY_ADMIN_EMAIL set and a support address stored, every address this action can
  // hold is in play: the alert's recipient, the student's, the Reply-To, the From and the one
  // typed on the form. A deployment log is read by people the student never wrote to.
  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  const secrets = [
    'PROVIDER-SENTENCE', PROFILE.email, TYPED, SETTINGS_ADDRESS, 'owner@example.test', 'noreply@example.test',
    PROFILE.full_name, ROW.full_name, 're_test', 'caller-token', ANON,
  ];
  const logLines = (why) => {
    const all = logged.join('\n');
    for (const secret of secrets) assert.ok(!all.includes(secret), `${why}: ${secret} reached a log line`);
    return all;
  };
  const row = { ...ROW69, email: TYPED };
  for (const status of [422, 403, 500]) {
    // The student copy is refused (the alert before it was delivered).
    logged = []; sent = [];
    install69({ row, profile: PROFILE, plan: ESSENTIALS, resendStatusFor: (b) => (b.to[0] === PROFILE.email ? status : 200) });
    const copy = await submit();
    assert.equal(copy.statusCode, 200, JSON.stringify(copy.body));
    assert.equal(copy.body.student, `resend_${status}`);
    assert.equal(studentCopy().reply_to, SETTINGS_ADDRESS, 'the refused message did carry the support address');
    assert.ok(logLines(`student copy ${status}`).includes(`resend_${status}`), `the code for the ${status} is what gets logged`);
    assert.ok(!JSON.stringify(copy.body).includes('PROVIDER-SENTENCE'));

    // The admin alert itself is refused.
    logged = []; sent = [];
    install69({ row, profile: PROFILE, plan: ESSENTIALS, resendStatusFor: () => status });
    const alert = await submit();
    assert.equal(alert.statusCode, 502);
    assert.deepEqual(sent.map((m) => m.to[0]), ['owner@example.test']);
    assert.ok(logLines(`admin alert ${status}`).includes(String(status)), `the ${status} is what gets logged`);
    assert.ok(!JSON.stringify(alert.body).includes('PROVIDER-SENTENCE'));
  }
  // …and a delivered pair of emails logs nothing at all.
  logged = []; sent = [];
  install69({ row, profile: PROFILE, plan: ESSENTIALS });
  const ok = await submit();
  assert.equal(ok.body.student, 'sent');
  assert.equal(sent.length, 2);
  assert.deepEqual(logged, []);
});

test('#69: the student-facing sends share one sender and one budget; only the admin "test" keeps the raw one', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/notify-enrollment.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const block = (from, to) => {
    const a = code.indexOf(from); const b = code.indexOf(to, a + from.length);
    assert.ok(a > 0 && b > a, `anchors not found: ${from} … ${to}`);
    return code.slice(a, b);
  };
  const submittedBlock = block("if (action === 'submitted')", "if (action === 'decision')");
  const decisionBlock = block("if (action === 'decision')", "if (action === 'import_onboarded')");
  const testBlock = block("if (action === 'test')", "return res.status(400).json({ error: \"action must be");
  // Two sends in 'submitted' (the alert, the confirmation) and one in 'decision': each through
  // sendEmail, each with a stable key, a ten-second limit and two attempts.
  for (const [name, text, sends] of [['submitted', submittedBlock, 2], ['decision', decisionBlock, 1]]) {
    assert.equal((text.match(/await sendEmail\(\{/g) || []).length, sends, `${name}: sendEmail calls`);
    assert.equal((text.match(/timeoutMs: 10_000, maxAttempts: 2,/g) || []).length, sends, `${name}: the send budget`);
    assert.equal((text.match(/idempotencyKey: (`enrollment-|decisionKey,)/g) || []).length, sends, `${name}: a stable key on every send`);
    assert.ok(!/sendResend\(/.test(text), `${name} must not use the key-less sender`);
    assert.ok(!/service\(\)/.test(text), `${name} builds no service-role client`);
  }
  // The decision's key names the request, the decision AND the moment it was recorded (EMAIL-2).
  assert.match(decisionBlock, /const decisionKey = `enrollment-decision-\$\{row\.id\}-\$\{status\}-\$\{stamp\}`;/);
  // The admin diagnostic keeps sendResend: it exists to show the provider's own words.
  assert.match(testBlock, /await sendResend\(apiKey, from, adminTo, subject, html\)/);
  assert.match(testBlock, /detail: out\.detail/);
});

// ── The student confirmation ─────────────────────────────────────────────────────────

test('#69: the confirmation is worded for what was submitted, and only a new student gets the onboarding video', async () => {
  const copyOf = async (row) => {
    sent = [];
    install69({ row: { ...ROW69, ...row }, profile: PROFILE, plan: ESSENTIALS });
    await submit();
    return studentCopy();
  };
  const fresh = await copyOf({ request_kind: 'new' });
  assert.equal(fresh.subject, 'Enrollment received — Get Hired with Alex');
  assert.match(fresh.text, /^Welcome, Account\n/);
  assert.ok(fresh.text.includes('https://www.youtube.com/watch?v=U78IBZwIr7U'));
  assert.match(fresh.text, /\n {2}\* Package: Essentials\n/);
  assert.match(fresh.text, /\n {2}\* Amount sent: ₱1,499\n/);
  assert.match(fresh.text, /\n {2}\* Training Agreement: Signed and on file\n/);
  assert.match(fresh.text, /Enrollment processing hours: 9:00 AM to 5:00 PM, Monday to Friday\./, 'the processing-hours note, line by line');

  for (const [kind, subject] of [['renewal', 'Renewal received'], ['upgrade', 'Upgrade request received'], ['extension', 'Extension request received']]) {
    const m = await copyOf({ request_kind: kind, extension_days: kind === 'extension' ? 60 : null });
    assert.equal(m.subject, `${subject} — Get Hired with Alex`, kind);
    assert.match(m.text, /^Thanks, Account\n/, kind);
    assert.ok(!/youtube/i.test(m.html + m.text), `${kind}: a member six months in is not told how to start`);
  }
  assert.match((await copyOf({ request_kind: 'extension', extension_days: 60 })).text, /\n {2}\* Extension: 60 days\n/);
  // A name that is really an email address is never echoed as a greeting.
  sent = [];
  install69({ row: { ...ROW69, full_name: 'someone@example.test' }, profile: { ...PROFILE, full_name: '' }, plan: ESSENTIALS });
  await submit();
  assert.match(studentCopy().text, /^Welcome, future QBO pro\n/);
});

// ── The request row's column ladder ──────────────────────────────────────────────────

test('#69: plan_key is always read, and request_kind rides its own rung of the ladder', async () => {
  const ext = { request_kind: 'extension', extension_days: 60 };
  // A current database: one read, everything on the top rung.
  install69({ row: { ...ROW69, ...ext }, profile: PROFILE, plan: ESSENTIALS });
  await submit();
  assert.equal(requestSelects.length, 1);
  for (const col of ['plan_key', 'notify_status', 'request_kind', 'extension_days', 'batch_id', 'agreement_tier']) {
    assert.ok(requestSelects[0].includes(col), `${col} is read on the top rung`);
  }
  assert.ok(!requestSelects[0].includes('receipt_path'), 'the receipt path is never even read');

  // Without #42's intake columns, and then without #32's batch_id, the kind is still read.
  for (const missingColumns of [['college_course'], ['college_course', 'batch_id']]) {
    sent = []; requestSelects = [];
    install69({ row: { ...ROW69, ...ext }, profile: PROFILE, plan: ESSENTIALS, missingColumns });
    const out = await submit();
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.match(adminAlert().text, /\n {2}\* Type: Extension: 60 days\n/, `without ${missingColumns.join(' + ')}`);
    assert.ok(requestSelects[0].includes('plan_key') && requestSelects[0].includes('request_kind'));
  }

  // Before #20 there is no request_kind: the alert still goes, with the older inference.
  sent = []; requestSelects = [];
  install69({ row: { ...ROW69 }, profile: PROFILE, plan: ESSENTIALS, missingColumns: ['college_course', 'batch_id', 'request_kind'] });
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.match(adminAlert().text, /\n {2}\* Type: New enrollment\n/);
  assert.ok(requestSelects[0].includes('plan_key') && requestSelects[0].includes('notify_status'));
  assert.ok(!requestSelects[0].includes('request_kind'));
});

// ── plainTextEmail ───────────────────────────────────────────────────────────────────

// Every MANDATORY line break in Unicode (UAX #14: BK — VT, FF, LINE and PARAGRAPH SEPARATOR; CR; LF;
// NL — NEL). A renderer that honours them starts a new line at each one.
const SEPARATORS = {
  CR: '\r', LF: '\n', CRLF: '\r\n', VT: '\v', FF: '\f', NEL: '\u0085', 'LINE SEPARATOR': '\u2028', 'PARAGRAPH SEPARATOR': '\u2029',
};
/** The lines such a renderer would show. */
const renderedLines = (text) => String(text).split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);

test('#69: plainTextEmail is the text twin of emailHtml — same inputs, links spelled out', () => {
  const t = plainTextEmail({
    heading: 'Heading', intro: 'Intro sentence.',
    rows: [['Package', 'Essentials'], ['Blank', ''], ['Missing', null], ['Days', 60]],
    reason: 'Receipt unreadable',
    cta: { href: 'https://app.example.test/x?a=1&b=2', label: 'Open it' },
    note: ['first line', 'second line'],
    video: { id: 'abc123XYZ_-', label: 'Watch this first' },
  });
  assert.match(t, /^Heading\n\nIntro sentence\.\n\nWatch this first: https:\/\/www\.youtube\.com\/watch\?v=abc123XYZ_-\n/);
  assert.ok(t.includes('  * Package: Essentials\n  * Days: 60\n'), 'rows as bullets, in order');
  assert.ok(!/Blank|Missing/.test(t), 'a row with no value is dropped, not printed as a dangling label');
  assert.ok(t.includes('Reason: Receipt unreadable'));
  assert.ok(t.includes('Open it: https://app.example.test/x?a=1&b=2'), 'the CTA address, unescaped');
  assert.ok(t.includes('first line\nsecond line'), 'an array note is one line per line');
  assert.match(t, /\nThank you,\nThe Toolkits by Alex team\n$/);
  assert.ok(!/\n{3,}/.test(t) && !/[<>]/.test(t), 'no blank runs and no markup');

  // A note may also be one string; every part is optional; an intro may be several paragraphs.
  assert.ok(plainTextEmail({ heading: 'H', intro: 'I', note: 'just one line' }).includes('\njust one line\n'));
  assert.equal(plainTextEmail({ heading: 'H', intro: ['Hello A,', 'Body.'] }), 'H\n\nHello A,\n\nBody.\n\nThank you,\nThe Toolkits by Alex team\n');
  assert.equal(plainTextEmail({ heading: 'Only a heading' }), 'Only a heading\n\nThank you,\nThe Toolkits by Alex team\n');
  assert.ok(!plainTextEmail({ heading: 'H', video: { label: 'no id' }, cta: { label: 'no href' } }).includes('http'));

  // A row is ONE line: a value (or a label) with a line break in it cannot start a row of its own.
  const forged = plainTextEmail({ heading: 'H', rows: [['Location', 'Manila\r\n  * Paid / sent: ₱99,999'], ['Two\nlines', 'ok']] });
  assert.ok(forged.includes('  * Location: Manila * Paid / sent: ₱99,999\n  * Two lines: ok\n'));
  assert.equal((forged.match(/^ {2}\* /gm) || []).length, 2, 'two rows in, two bullets out');
  // ★ EMAIL-3: EVERY mandatory line break in Unicode — not only CR and LF. A renderer that honours
  //   VT, FF, NEL or a LINE/PARAGRAPH SEPARATOR starts a line at it, so folding two of the eight
  //   left five ways for a typed value to forge a row. A run of them, with spaces, is ONE space.
  for (const [name, sep] of Object.entries(SEPARATORS)) {
    const t = plainTextEmail({ heading: 'H', rows: [['Location', `Manila ${sep} ${sep}  * Paid / sent: ₱99,999`], [`Two${sep}lines`, 'ok']] });
    assert.ok(t.includes('  * Location: Manila * Paid / sent: ₱99,999\n  * Two lines: ok\n'), `${name}: ${JSON.stringify(t)}`);
    assert.equal(renderedLines(t).filter((l) => /^ {2}\* /.test(l)).length, 2, `${name}: two rows in, two bullets out`);
  }
});

test('EMAIL3-PERF: the fold is LINEAR — a long run of whitespace with no line break in it cannot stall a send — and it folds exactly as before', () => {
  // The single pattern it replaced (/[\s\u0085]*[breaks][\s\u0085]*/g) backtracked quadratically on such a run:
  // 80,000 spaces took 18 s. The values folded here include columns a student types with no length CHECK.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const NEL = String.fromCharCode(0x85);
  const long = `a${' '.repeat(100_000)}b`;
  const t0 = performance.now();
  const t = plainTextEmail({ heading: 'H', rows: [['City', long], ['Phone', `0917${'\t'.repeat(60_000)}x`], ['Note', `${NEL}${' '.repeat(50_000)}`]] });
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `folded in ${Math.round(ms)} ms — a long run must cost a pass over it, never a pass per character`);
  assert.ok(t.includes(`  * City: ${long}\n`), 'a run with no line break in it is left as typed');
  // The SAME output as the pattern it replaced, on every string of up to four characters over the alphabet that
  // matters: a letter, three spaces that break nothing, and all eight mandatory breaks (UAX #14).
  const OLD_FOLD = new RegExp(String.raw`[\s${NEL}]*[\r\n\v\f${NEL}${LS}${PS}][\s${NEL}]*`, 'g');
  assert.equal(OLD_FOLD.source.slice(0, 3), String.raw`[\s`, 'the reference really is the old pattern');
  const ALPHABET = ['a', ' ', '\t', String.fromCharCode(0xa0), '\r', '\n', '\v', '\f', NEL, LS, PS];
  let strings = [''];
  let checked = 0;
  for (let len = 1; len <= 4; len += 1) {
    strings = strings.flatMap((s) => ALPHABET.map((c) => s + c));
    for (const s of strings) {
      // Between two letters, so the value is never blank — a run of nothing but whitespace is the case that matters.
      const out = plainTextEmail({ heading: 'H', rows: [['K', `x${s}y`]] });
      const expected = `  * K: ${`x${s}y`.replace(OLD_FOLD, ' ').trim()}\n`;
      assert.ok(out.includes(expected), `${JSON.stringify(s)}: ${JSON.stringify(out)}`);
      checked += 1;
    }
  }
  assert.equal(checked, 11 + 11 ** 2 + 11 ** 3 + 11 ** 4, 'every string of up to four characters over the alphabet');
});

test('#69: what a student typed cannot forge a row of the alert\'s text part, or break its subject', async () => {
  install69({
    row: {
      ...ROW69, full_name: 'Mallory\nSubject: You won', phone: '0917\n  * Paid / sent: ₱99,999',
      city_country: 'Manila\n  * Expected: ₱1', referred_by: 'a friend\n\n  * Type: Extension: 365 days',
    },
  });
  const out = await submit();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  const alert = adminAlert();
  assert.ok(!/[\r\n]/.test(alert.subject), 'one line');
  for (const label of ['Type', 'Expected', 'Paid / sent', 'Student']) {
    const lines = alert.text.split('\n').filter((l) => l.startsWith(`  * ${label}: `));
    assert.equal(lines.length, 1, `exactly one "${label}" row: ${JSON.stringify(lines)}`);
  }
  assert.match(alert.text, /\n {2}\* Paid \/ sent: ₱1,499\n/, 'the real amount, on its own line');
  assert.match(alert.text, /\n {2}\* Type: New enrollment\n/);
});

// ── The HTML part ────────────────────────────────────────────────────────────────────
// Two values no honest student types: one that would be an element, and one that would close
// the attribute or the cell it sits in and open a link of its own.
const XSS_TAG = '<img src=x onerror=alert(1)>';
const XSS_ATTR = '"><a href="http://evil.example">x</a>';
/** A value as it must be spelled inside an HTML part to be shown as text. */
const escaped = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Every element an HTML part opens or closes, in order — what a mail client would build from it. */
const tagsOf = (html) => [...String(html).matchAll(/<\/?[a-zA-Z][a-zA-Z0-9]*/g)].map((m) => m[0].toLowerCase());

test('#69: nothing a student typed, and nothing the catalog holds, becomes markup in an HTML part', async () => {
  // Every value that reaches the alert or the confirmation, filled from two strings: the name
  // on the account and the one typed on the form, the phone, the location, the reference, the
  // intake answers, and the catalog's own package name, tagline, scope chips and cohort name.
  const fixture = (a, b) => ({
    row: {
      ...ROW69, plan_key: 'vip', batch_id: BATCH_ID, email: TYPED, full_name: `${a} typed`, phone: b, city_country: a,
      payment_reference: b, college_course: a, current_job: b, ph_experience: a, us_experience: b,
      currently_employed: a, prior_training: b, referred_by: a, intake: { facebook_link: b, struggles: a },
    },
    profile: { email: PROFILE.email, full_name: `${b} account` },
    plan: { ...VIP, name: a, tagline: b, entitlement_summary: [a, b] },
    batch: { name: b, code: '2026-10' },
  });
  const render = async (a, b) => {
    sent = [];
    install69(fixture(a, b));
    const out = await submit();
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(sent.length, 2, 'the alert and the confirmation');
    return { alert: adminAlert(), student: studentCopy() };
  };
  const benign = await render('Alpha', 'Beta');
  const hostile = await render(XSS_TAG, XSS_ATTR);

  for (const which of ['alert', 'student']) {
    const { html, text } = hostile[which];
    // The same elements as the harmless render, in the same order: a hostile value added none.
    assert.deepEqual(tagsOf(html), tagsOf(benign[which].html), `${which}: a value became an element`);
    assert.deepEqual(hrefsOf(html), hrefsOf(benign[which].html), `${which}: a value became a link`);
    assert.ok(!html.includes('<img src=x') && !html.includes('href="http://evil'), `${which}: raw markup in the HTML part`);
    assert.ok(html.includes('&lt;img') && html.includes(escaped(XSS_TAG)), `${which}: the value is shown, as text`);
    // A text part is not markup: it keeps the characters exactly as they were typed.
    assert.ok(text.includes(XSS_TAG), `${which}: the text part keeps the literal characters`);
    assert.ok(!text.includes('&lt;') && !text.includes('&quot;'), `${which}: no entity in a text part`);
  }

  const { alert, student } = hostile;
  assert.ok(alert.html.includes('&quot;&gt;&lt;a href=&quot;http://evil.example&quot;&gt;x&lt;/a&gt;'));
  // Row by row — the account's name, the typed one, the package and its tagline, the scope
  // chips, the cohort, a typed answer: literal in the text part, one escaped cell in the HTML.
  for (const [label, value] of [
    ['Student', `${XSS_ATTR} account`],
    ['Name on form', `${XSS_TAG} typed`],
    ['Phone', XSS_ATTR],
    ['Location', XSS_TAG],
    ['Package', `${XSS_TAG} (${XSS_ATTR})`],
    ['Program access', `${XSS_TAG} · ${XSS_ATTR}`],
    ['Cohort', `${XSS_ATTR} — confirmed at approval`],
    ['Reference', XSS_ATTR],
    ['Three struggles', XSS_TAG],
  ]) {
    assert.ok(alert.text.includes(`\n  * ${label}: ${value}\n`), `${label}: the text row`);
    assert.ok(alert.html.includes(`>${label}</td>`) && alert.html.includes(`>${escaped(value)}</td>`), `${label}: the HTML cell`);
  }
  // The confirmation greets by first name, and its HEADING is the one place a name sits
  // outside a table cell.
  assert.ok(student.html.includes(`>Welcome, ${escaped('"><a')}</h2>`), 'the greeting, escaped');
  assert.ok(student.text.startsWith('Welcome, "><a\n'));
  assert.ok(student.html.includes(`>${escaped(XSS_TAG)}</td>`), 'the package name, in its row');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The final review of #69 (Task 13): EMAIL-4, EMAIL-2, EMAIL-3
// ═════════════════════════════════════════════════════════════════════════════════════

test('EMAIL-4: an alert with no clear answer is recorded as provider_unclear — never as "not sent" — and a refusal stays provider_error', async () => {
  for (const [why, resendStatusFor, p_status, p_detail] of [
    ['no attempt got an answer', () => 0, 'provider_unclear', 'resend_failed'],
    ['both attempts ran out of time', () => 'timeout', 'provider_unclear', 'resend_timeout'],
    ['the provider failed (500)', () => 500, 'provider_unclear', 'resend_500'],
    ['the provider was unavailable (503)', () => 503, 'provider_unclear', 'resend_503'],
    ['this request\'s key was already used with another payload — an alert went out for it earlier', () => ({ status: 409, name: 'invalid_idempotent_request' }), 'provider_unclear', 'resend_409'],
    ['a 409 the provider does not name', () => ({ status: 409, name: 'validation_error' }), 'provider_unclear', 'resend_409'],
    ['a 409 whose body is not JSON', () => ({ status: 409, name: null }), 'provider_unclear', 'resend_409'],
    ['refused outright (422)', () => 422, 'provider_error', 'resend_422'],
    ['refused outright (403)', () => 403, 'provider_error', 'resend_403'],
    ['refused outright (400)', () => 400, 'provider_error', 'resend_400'],
  ]) {
    sent = []; recorded = [];
    install69({ profile: PROFILE, plan: ESSENTIALS, resendStatusFor });
    const out = await submit();
    assert.equal(out.statusCode, 502, `${why}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.ok, false, why);
    assert.deepEqual(recorded, [{ p_request_id: REQ, p_status, p_detail }], why);
    assert.match(recorded[0].p_detail, /^[a-z0-9_]+$/, `${why}: a slug, never the provider's words`);
    assert.ok(sent.length > 0 && sent.every((m) => m.to[0] === SETTINGS_ADDRESS), `${why}: no student copy for an alert that is not known to have gone`);
    assert.ok(!JSON.stringify(out.body).includes('PROVIDER-SENTENCE'), why);
  }
  // A 409 the provider names "in progress" is another invocation's alert to finish and record.
  sent = []; recorded = [];
  install69({ profile: PROFILE, plan: ESSENTIALS, resendStatusFor: () => ({ status: 409, name: 'concurrent_idempotent_requests' }) });
  const inFlight = await submit();
  assert.deepEqual(inFlight.body, { ok: false, skipped: 'in_flight' });
  assert.deepEqual(recorded, [], 'an earlier "sent" stamp must never be replaced');
});

test('EMAIL-2: sendEmail names a 409 only when asked — every other caller still gets the bare resend_409', async () => {
  const { sendEmail, resendConflictKind } = await import('../api/_lib/email.js');
  const MSG = { to: 'a@example.test', subject: 's', html: '<p>h</p>', idempotencyKey: 'unit-test-key-0001' };
  let script;   // the provider's answers, in order
  globalThis.fetch = async () => {
    const next = script.shift();
    if (next === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return next.raw !== undefined ? new Response(next.raw, { status: next.status })
      : new Response(JSON.stringify(next.body), { status: next.status });
  };
  const named409 = (name) => ({ status: 409, body: { statusCode: 409, name, message: 'PROVIDER-SENTENCE about a@example.test' } });

  // Not asked: EXACTLY the answer the queue (commSend), the migration and the onboarding notice
  // read today — each of them decides on 'resend_409' itself.
  script = [named409('invalid_idempotent_request')];
  assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 1 }), { ok: false, code: 'resend_409' });
  // Asked: which conflict, from the provider's own error name — and never the body.
  for (const [name, conflict] of [
    ['concurrent_idempotent_requests', 'in_flight'],
    ['invalid_idempotent_request', 'payload'],
    ['  Concurrent_Idempotent_Requests ', 'in_flight'],
    ['validation_error', 'unknown'],
    [undefined, 'unknown'],
  ]) {
    script = [named409(name)];
    assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 1, classify409: true }), { ok: false, code: 'resend_409', conflict }, String(name));
  }
  script = [{ status: 409, raw: '<html>409 Conflict</html>' }];
  assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 1, classify409: true }), { ok: false, code: 'resend_409', conflict: 'unknown' });
  // A 409 that follows an attempt with no answer stays the unclear answer it is (#68, V4).
  script = ['timeout', named409('concurrent_idempotent_requests')];
  assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 2, timeoutMs: 50, classify409: true }), { ok: false, code: 'resend_timeout' });
  // Nothing else changes when asked.
  script = [{ status: 422, body: { name: 'validation_error' } }];
  assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 1, classify409: true }), { ok: false, code: 'resend_422' });
  script = [{ status: 200, body: { id: 'x-1' } }];
  assert.deepEqual(await sendEmail({ ...MSG, maxAttempts: 1, classify409: true }), { ok: true, id: 'x-1' });

  // The pure classifier: the provider's own words, and nothing else, earn 'in_flight'.
  assert.equal(resendConflictKind({ name: 'concurrent_idempotent_requests' }), 'in_flight');
  assert.equal(resendConflictKind({ name: 'invalid_idempotent_request' }), 'payload');
  for (const o of [{}, { name: '' }, { name: 42 }, { name: 'concurrent_idempotent_request' }, { name: 'in progress' }, undefined]) {
    assert.equal(resendConflictKind(o), 'unknown', JSON.stringify(o));
  }
});

test('EMAIL-3: no Unicode line break in what a student typed starts a row of the alert\'s text part, or a line of its subject', async () => {
  for (const [name, sep] of Object.entries(SEPARATORS)) {
    sent = [];
    install69({
      row: {
        ...ROW69, full_name: `Mallory${sep}Subject: You won`, phone: `0917${sep}  * Paid / sent: ₱99,999`,
        city_country: `Manila${sep}  * Expected: ₱1`, referred_by: `a friend${sep}${sep}  * Type: Extension: 365 days`,
        intake: { struggles: `one${sep}  * Student: Somebody Else` },
      },
    });
    const out = await submit();
    assert.equal(out.statusCode, 200, `${name}: ${JSON.stringify(out.body)}`);
    const alert = adminAlert();
    assert.ok(!/[\r\n\v\f\u0085\u2028\u2029]/.test(alert.subject), `${name}: one-line subject: ${JSON.stringify(alert.subject)}`);
    for (const label of ['Type', 'Expected', 'Paid / sent', 'Student']) {
      const lines = renderedLines(alert.text).filter((l) => l.startsWith(`  * ${label}: `));
      assert.equal(lines.length, 1, `${name}: exactly one "${label}" row: ${JSON.stringify(lines)}`);
    }
    assert.ok(!/[\r\v\f\u0085\u2028\u2029]/.test(alert.text), `${name}: the text part's only line break is LF`);
    assert.match(alert.text, /\n {2}\* Paid \/ sent: ₱1,499\n/, `${name}: the real amount, on its own line`);
  }
});
