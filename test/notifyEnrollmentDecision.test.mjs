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
// #69 adds what the email may STATE. The approval used to say "everything is unlocked", which
// is false for the Essentials package. It now states facts the database returns —
// enrollment_decision_email_facts(), asked with the reviewer's own JWT: the package, the
// Manila day the term runs to, the cohort, whether Getting Started comes next. ANY failure of
// that read sends the generic copy rather than refusing; a rejected or expired decision states
// no term at all. It also gains a text part, a Reply-To that is never RESEND_FROM, and a
// stable idempotency key, so a double click is one email.
//
// The final review of #69 (Task 13) found three more, pinned at the end of this file:
//   • EMAIL-1: the burst guard counted every decision a REVIEWER sent, so a bulk approval lost
//     every email after the tenth in a minute while the dialog said "the student is emailed". It
//     now counts sends of ONE decision — which is also all a runaway loop can repeat.
//   • EMAIL-2: the key now names the MOMENT the decision was recorded (reviewed_at), so a request
//     a Super Admin reopened (#66) and decided again is a new email instead of a provider 409; and
//     only a 409 the provider names "in progress" (concurrent_idempotent_requests) reads as
//     "already on its way" — the same key with a different payload is a refusal.
//   • EMAIL-3: no Unicode line break in a name — VT, FF, NEL, LINE or PARAGRAPH SEPARATOR, as well
//     as CR and LF — can start a line of the text part.
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
// reviewed_at is the moment the decision was recorded: admin_finalize_enrollment stamps now(), and
// both decline paths stamp it as they write the status. PostgREST writes MICROseconds.
const REVIEWED_AT = '2026-09-30T03:59:58.123456+00:00';
const STAMP = '1790740798123';   // its epoch MILLIseconds: digits only, as a key must be
const ROW = {
  id: REQ, user_id: STUDENT, email: 'typed-on-the-request@third-party.test', full_name: 'Real Student',
  plan_name: 'Essentials', status: 'approved', rejection_reason: null, reviewed_at: REVIEWED_AT,
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

// ── #69 fixtures ─────────────────────────────────────────────────────────────────────
// The clock is pinned (see beforeEach), so "is this term open yet?" has one answer for ever.
const NOW = Date.parse('2026-09-30T04:00:00Z');
const FACTS_URL = `${SUPA}/rest/v1/rpc/enrollment_decision_email_facts`;
// Exactly the shape enrollment_decision_email_facts() returns (db/2026-09-30-getting-started-video.sql §8).
const FACTS = {
  request: { id: REQ, status: 'approved', kind: 'new', extension_days: null },
  plan: {
    key: 'sampler', name: 'Essentials', tagline: 'Sampler Session',
    entitlement_summary: ['60-day course access', '60-day group chat support', '1 live Zoom session'],
    community_segment: 'general', access_days: 60,
  },
  // 17:00 UTC on the 29th is 01:00 on the 30th in Manila: the day the STUDENT's access runs to.
  term: { status: 'active', started_at: '2026-09-30T02:00:00+00:00', ends_at: '2026-11-29T17:00:00+00:00', grace_ends_at: '2026-12-02T17:00:00+00:00' },
  batch: null,
  getting_started_required: false,
};
const SUPPORT = 'support-desk@example.test';
const A_DATE = /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/;

let savedFetch; let savedConsole; let calls; let sent;
let savedEnv; let savedNow; let keys; let factsCalls; let settingsReads;
// Every line the handler wrote to the console, at any level. Nothing it logs may carry an
// address, the provider's words, a key or a token — and a delivered email logs nothing.
let logged;

/**
 * #69 — each of these is UNROUTED unless given, so the tests written before it run with the
 * facts and the support address unavailable: the read throws, and the generic email goes out.
 * @param {object|*}    [o.facts]          what enrollment_decision_email_facts() returns
 * @param {number}      [o.factsStatus]    its HTTP status (404 = PGRST202, the pre-#69 database)
 * @param {boolean}     [o.factsHang]      never answers: only the caller's time limit ends it
 * @param {string|null} [o.settingsValue]  payment_settings.notify_email; null = no stored address
 * @param {number}      [o.resendStatus]   the provider's answer
 * @param {string|null} [o.resend409Name]  a 409's error name, as Resend sends it (docs: idempotency
 *                                         keys, "Possible responses"); null = a body that is not JSON
 * @param {{ answer: (body: object, key: string) => { status: number, json: object } }} [o.provider]
 *        a provider of the test's own, which answers every send (resendStatus is then not used)
 * @param {(id: string) => object|null} [o.rowFor]  a row per requested id — one reviewer, many requests
 */
function install({
  staff = OPS, row = ROW, rowStatus = 200, profile = PROFILE,
  facts, factsStatus = 200, factsHang = false, settingsValue, resendStatus = 200,
  resend409Name = 'concurrent_idempotent_requests', provider = null, rowFor = null,
} = {}) {
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
      const found = rowFor ? rowFor(decodeURIComponent((u.match(/[?&]id=eq\.([^&]+)/) || [])[1] || '')) : row;
      return res(found ? [found] : [], rowStatus);
    }
    if (u.startsWith(`${SUPA}/rest/v1/profiles?`)) {
      assert.match(String(init.headers?.Authorization), /^Bearer caller-token$/,
        'the account must be read with the CALLER\'s JWT too');
      assert.ok(u.includes(`id=eq.${STUDENT}`), 'the profile looked up must be the request\'s own user_id');
      return res(profile ? [profile] : []);
    }
    if (u === FACTS_URL && (facts !== undefined || factsStatus !== 200 || factsHang)) {
      factsCalls.push({
        method: init.method, auth: String(new Headers(init.headers).get('authorization')),
        body: JSON.parse(init.body || 'null'), bounded: Boolean(init.signal),
      });
      if (factsHang) {
        return new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        });
      }
      // A refusal normally carries PostgREST's error object; a test may give it a body of its own.
      return factsStatus === 200 ? res(facts)
        : res(facts !== undefined ? facts
          : { code: factsStatus === 404 ? 'PGRST202' : 'XX000', message: 'Could not find the function' }, factsStatus);
    }
    if (settingsValue !== undefined && u.startsWith(`${SUPA}/rest/v1/payment_settings?`)) {
      settingsReads.push({ auth: String(new Headers(init.headers).get('authorization')), bounded: Boolean(init.signal) });
      return res(settingsValue == null ? [] : [{ value: settingsValue }]);
    }
    if (u === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(init.body));
      keys.push(new Headers(init.headers).get('idempotency-key'));
      if (provider) {
        const { status, json } = provider.answer(sent.at(-1), keys.at(-1));
        return res(json, status);
      }
      // Resend's 409 names WHICH conflict it is: a request with this key still in progress, or the
      // key already used with a different payload. Its message names the recipient, like any refusal.
      if (resendStatus === 409) {
        return resend409Name === null ? new Response('<html>409 Conflict</html>', { status: 409 })
          : res({ statusCode: 409, name: resend409Name, message: `PROVIDER-SENTENCE about ${JSON.parse(init.body).to[0]}` }, 409);
      }
      return resendStatus === 200 ? res({ id: 'resend-test-id' })
        : res({ name: 'validation_error', message: `PROVIDER-SENTENCE about ${JSON.parse(init.body).to[0]}` }, resendStatus);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function call(body, headers = {}) {
  const req = { method: 'POST', headers: { authorization: 'Bearer caller-token', ...headers }, body: { action: 'decision', ...body } };
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
  keys = []; factsCalls = []; settingsReads = []; logged = [];
  savedFetch = globalThis.fetch;
  savedConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const level of Object.keys(savedConsole)) console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
  savedEnv = { ...process.env };
  savedNow = Date.now;
  Date.now = () => NOW;
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits <noreply@example.test>';
  delete process.env.NOTIFY_ADMIN_EMAIL;
  delete process.env.APP_URL;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  Object.assign(console, savedConsole);
  Date.now = savedNow;
  process.env = savedEnv;
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
  assert.match(sent[0].html, /Essentials/);
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

// ═════════════════════════════════════════════════════════════════════════════════════
// #69 — what the decision email states
// ═════════════════════════════════════════════════════════════════════════════════════

/** Every href in an HTML part, entity-decoded back to the address a click would open. */
const hrefsOf = (html) => [...String(html).matchAll(/href="([^"]*)"/g)].map((m) => m[1]
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
/** The HTML part with its entities decoded, so one sentence can be looked for in both parts. */
const plain = (html) => String(html).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const approve = (extra = {}) => call({ requestId: REQ, status: 'approved', ...extra });
const termOf = (term) => ({ ...FACTS, term: { ...FACTS.term, ...term } });

test('#69: an approval states the package and the Manila day it is active until — never "everything is unlocked"', async () => {
  install({ facts: FACTS, settingsValue: SUPPORT });
  const out = await approve();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.deepEqual(m.to, [PROFILE.email]);
  for (const part of [plain(m.html), m.text]) {
    assert.ok(!/everything is unlocked/i.test(part), 'false for Essentials, which opens one course');
    assert.ok(part.includes('Hello Real Student, your payment for Essentials has been verified and your enrollment is approved.'));
    assert.ok(part.includes('Your Essentials access is active until November 30, 2026.'), 'the plan, and the day it runs to');
    assert.ok(part.includes('Sign in to Toolkits by Alex to continue.'));
    assert.ok(part.includes('60-day course access · 60-day group chat support · 1 live Zoom session'), 'the plan\'s own scope');
  }
  assert.match(m.text, /\n {2}\* Package: Essentials \(Sampler Session\)\n/);
  assert.match(m.text, /\n {2}\* Program access: 60-day course access · 60-day group chat support · 1 live Zoom session\n/);
  assert.match(m.text, /\n {2}\* Active until: November 30, 2026\n/);
  assert.doesNotMatch(m.text, /Cohort|Extension|Access opens/, 'no cohort for a plan without one; nothing about a later start');

  // The package is named as the CATALOG names it; the row's plan_name is a snapshot the
  // student's own client wrote, and speaks only when the facts could not be read.
  sent = [];
  install({ row: { ...ROW, plan_name: 'Stale Snapshot Name' }, facts: FACTS });
  await approve();
  assert.ok(sent[0].text.includes('your payment for Essentials has been verified'));
  assert.ok(!/Stale Snapshot Name/.test(sent[0].html + sent[0].text));
  sent = [];
  install({ row: { ...ROW, plan_name: 'Stale Snapshot Name' } });
  await approve();
  assert.ok(sent[0].text.includes('your payment for Stale Snapshot Name has been verified'));
});

test('#69: a name that is really an email address is never echoed as a greeting', async () => {
  // The paywall stores the account's EMAIL as the request's full_name when no name was typed,
  // and Extend Access sends no name at all — so an account with a blank profile name files a
  // request whose "name" is an address. The enrollment confirmation and the access decision
  // already refuse to greet by one; "Hello someone@example.test," must not be the third.
  const NAMED = 'someone.else@example.test';
  const opening = {
    approved: 'Hello, your payment for Essentials has been verified and your enrollment is approved.',
    rejected: 'Hello, we couldn’t verify your payment for Essentials yet.',
    expired: 'Hello, your enrollment request for Essentials was not completed within the review window and has expired.',
  };
  for (const [why, names] of [
    ['the profile has no name and the request\'s is an address', { profile: '', row: NAMED }],
    ['the profile has no name at all and the request\'s is an address', { profile: null, row: NAMED }],
    ['both names are an address', { profile: NAMED, row: NAMED }],
    ['the address is padded with spaces', { profile: '', row: `  ${NAMED}  ` }],
  ]) {
    for (const status of ['approved', 'rejected', 'expired']) {
      sent = [];
      install({ row: { ...ROW, status, full_name: names.row }, profile: { ...PROFILE, full_name: names.profile } });
      const out = await call({ requestId: REQ, status });
      assert.equal(out.statusCode, 200, `${why}, ${status}: ${JSON.stringify(out.body)}`);
      assert.deepEqual(sent[0].to, [PROFILE.email], 'still sent, to the account');
      for (const part of [plain(sent[0].html), sent[0].text]) {
        assert.ok(part.includes(opening[status]), `${why}, ${status}: the greeting names nobody`);
        assert.ok(!part.includes(NAMED) && !/Hello [^,]*@/.test(part), `${why}, ${status}: an address was echoed`);
      }
      assert.ok(sent[0].text.includes(`\n\n${opening[status]}`), 'the sentence opens its own paragraph');
      assert.ok(!sent[0].subject.includes('@'));
    }
  }
  // The account's own name can be an address too (some signups carry one): whatever the
  // request says beside it, that address is not a greeting.
  sent = [];
  install({ row: { ...ROW, full_name: 'Real Student' }, profile: { ...PROFILE, full_name: NAMED } });
  await approve();
  assert.ok(!(sent[0].html + sent[0].text).includes(NAMED) && !/Hello [^,]*@/.test(sent[0].text));
  // A real name is still greeted by name — with or without a profile name to prefer.
  sent = [];
  install({ row: { ...ROW, full_name: 'Typed Name' }, profile: { ...PROFILE, full_name: '' } });
  await approve();
  assert.ok(sent[0].text.includes('\n\nHello Typed Name, your payment for Essentials has been verified'));
});

test('#69: the facts are asked of the database with the reviewer\'s own JWT, about the request on the row', async () => {
  install({ facts: FACTS });
  await approve({ p_request_id: 'not-this-one', facts: { plan: { name: 'Free iPhone' } } });
  assert.deepEqual(factsCalls, [{ method: 'POST', auth: 'Bearer caller-token', body: { p_request_id: REQ }, bounded: true }]);
  assert.ok(!/Free iPhone/.test(JSON.stringify(sent[0])), 'facts in the BODY are not facts');
  // …and only once the decision itself has been verified.
  const at = (needle) => calls.findIndex((u) => u.includes(needle));
  assert.ok(at('/rest/v1/enrollment_requests') < at('/rpc/enrollment_decision_email_facts'));
  assert.ok(at('/rest/v1/profiles') < at('/rpc/enrollment_decision_email_facts'));
});

test('#69: Getting Started is mentioned exactly when the server says it comes next', async () => {
  const sentence = 'When you next sign in, you will be guided through Getting Started — a welcome video to watch before your dashboard opens.';
  install({ facts: { ...FACTS, getting_started_required: true } });
  await approve();
  for (const part of [plain(sent[0].html), sent[0].text]) {
    assert.ok(part.includes(sentence));
    assert.ok(part.includes('Your Essentials access is active until November 30, 2026.'));
    assert.ok(!part.includes('to continue.'), 'one next step, not two');
  }
  // false, missing, or a truthy value that is not the boolean: not mentioned.
  for (const flag of [false, undefined, null, 'true', 1]) {
    sent = [];
    install({ facts: { ...FACTS, getting_started_required: flag } });
    await approve();
    assert.ok(!/Getting Started/.test(sent[0].html + sent[0].text), `getting_started_required=${JSON.stringify(flag)}`);
  }
});

test('#69: a term that has not opened says when it opens — and nothing that implies access now', async () => {
  const notYet = /active until|is active|you.re in|Sign in|to continue|Getting Started|dashboard|unlocked/i;
  // A scheduled term (#67). 16:00 UTC on the 25th is midnight on the 26th in Manila.
  install({ facts: { ...termOf({ status: 'scheduled', started_at: '2026-09-25T16:00:00+00:00', ends_at: '2027-03-24T15:59:59.999+00:00' }), getting_started_required: true } });
  process.env.APP_URL = 'https://toolkits.example.test';
  await approve();
  for (const part of [plain(sent[0].html), sent[0].text]) {
    assert.ok(part.includes('Your access opens on September 26, 2026.'));
    assert.ok(!notYet.test(part), `implies access now: ${(part.match(notYet) || [])[0]}`);
  }
  assert.match(sent[0].text, /\n {2}\* Access opens: September 26, 2026\n {2}\* Access until: March 24, 2027\n/);
  assert.deepEqual(hrefsOf(sent[0].html), [], 'no sign-in button for a membership that is not open');

  // An ACTIVE row whose start is still ahead of the clock reads the same way.
  sent = [];
  install({ facts: termOf({ status: 'active', started_at: '2026-10-05T16:00:00+00:00', ends_at: '2027-04-03T15:59:59.999+00:00' }) });
  await approve();
  assert.ok(sent[0].text.includes('Your access opens on October 6, 2026.'));
  assert.ok(!notYet.test(sent[0].text));
});

test('#69: a term with no end date prints no date at all', async () => {
  install({ facts: termOf({ ends_at: null, grace_ends_at: null }) });
  await approve();
  for (const part of [plain(sent[0].html), sent[0].text]) {
    assert.doesNotMatch(part, A_DATE);
    assert.ok(!/active until|Active until|Access until/.test(part));
    assert.ok(part.includes('your payment for Essentials has been verified and your enrollment is approved.'));
  }
  assert.match(sent[0].text, /\n {2}\* Package: Essentials \(Sampler Session\)\n/, 'the package is still stated');
});

test('#69: every date is the MANILA calendar day, not the UTC one', async () => {
  // ends_at 17:00 UTC on Nov 29 → Nov 30 in Manila.
  install({ facts: FACTS });
  await approve();
  assert.ok(sent[0].text.includes('active until November 30, 2026.'));
  assert.ok(!sent[0].text.includes('November 29'));
  // The last instant of a Manila day stays on that day (the database writes microseconds).
  sent = [];
  install({ facts: termOf({ ends_at: '2027-04-12T15:59:59.999999+00:00' }) });
  await approve();
  assert.ok(sent[0].text.includes('active until April 12, 2027.'));
  // started_at 16:00 UTC on Sep 25 → Sep 26 in Manila.
  sent = [];
  install({ facts: termOf({ status: 'scheduled', started_at: '2026-09-25T16:00:00+00:00' }) });
  await approve();
  assert.ok(sent[0].text.includes('Your access opens on September 26, 2026.'));
  assert.ok(!sent[0].text.includes('September 25'));
});

test('#69: a term that was superseded, or has already lapsed, is not stated', async () => {
  for (const term of [
    { status: 'expired' },                                   // a later approval superseded this one
    { status: 'cancelled' },
    { status: 'active', ends_at: '2026-09-29T00:00:00+00:00' },   // ended before the pinned clock
    { status: 'active', ends_at: 'not a timestamp' },
  ]) {
    sent = [];
    install({ facts: termOf(term) });
    const out = await approve();
    assert.equal(out.statusCode, 200, JSON.stringify(term));
    const all = sent[0].html + sent[0].text;
    assert.ok(!/active until|Active until|Program access|Access opens/.test(all), JSON.stringify(term));
    assert.doesNotMatch(all, A_DATE, JSON.stringify(term));
    assert.ok(sent[0].text.includes('your enrollment is approved.'), 'the decision itself is still announced');
  }
});

test('#69: a VIP approval names its cohort; an approved extension states its days instead of the plan\'s length', async () => {
  const vip = {
    ...FACTS,
    plan: { key: 'vip', name: 'VIP Package', tagline: 'Personalized Coaching Program',
      entitlement_summary: ['180-day full access', '1-on-1 coaching', 'Weekly consult until hired'], community_segment: 'vip', access_days: 180 },
    batch: { name: 'October 2026', code: '2026-10', starts_on: '2026-10-01' },
    term: { status: 'active', started_at: '2026-09-30T02:00:00+00:00', ends_at: '2027-03-29T02:00:00+00:00', grace_ends_at: null },
  };
  install({ row: { ...ROW, plan_name: 'VIP Package' }, facts: vip });
  await approve();
  assert.match(sent[0].text, /\n {2}\* Package: VIP Package \(Personalized Coaching Program\)\n/);
  assert.match(sent[0].text, /\n {2}\* Cohort: October 2026\n/);
  assert.ok(sent[0].text.includes('Your VIP Package access is active until March 29, 2027.'));

  sent = [];
  install({ row: { ...ROW, plan_name: 'VIP Package' }, facts: { ...vip, request: { id: REQ, status: 'approved', kind: 'extension', extension_days: 60 } } });
  await approve();
  assert.match(sent[0].text, /\n {2}\* Extension: 60 days\n/);
  assert.doesNotMatch(sent[0].text, /Program access|180-day/, 'the plan\'s standard length is not what an extension granted');
  assert.ok(sent[0].text.includes('active until March 29, 2027.'));
});

// ── The facts are best-effort ────────────────────────────────────────────────────────

test('#69: ANY facts failure sends the generic copy — never a refusal', { timeout: 30_000 }, async () => {
  const generic = (m, why) => {
    for (const part of [plain(m.html), m.text]) {
      assert.ok(part.includes('Hello Real Student, your payment for Essentials has been verified and your enrollment is approved. Sign in to Toolkits by Alex to continue.'), why);
      assert.ok(!/everything is unlocked|active until|Getting Started|Program access|Package:/i.test(part), why);
      assert.doesNotMatch(part, A_DATE, why);
    }
  };
  const cases = [
    ['the function does not exist (a database without #69)', { factsStatus: 404 }],
    ['the reviewer is refused', { factsStatus: 403 }],
    ['the database answers 500', { factsStatus: 500 }],
    ['a refusal whose body happens to look like facts', { facts: FACTS, factsStatus: 500 }],
    ['the read throws', {}],                                         // unrouted: fetch rejects
    ['the answer is an array', { facts: [] }],
    ['the answer is a string', { facts: 'nope' }],
    ['the answer is null', { facts: null }],
    ['the answer is about another request', { facts: { ...FACTS, request: { ...FACTS.request, id: '99999999-2222-4333-8444-555555555555' } } }],
    ['the answer is about another decision', { facts: { ...FACTS, request: { ...FACTS.request, status: 'rejected' } } }],
    ['the read never answers', { factsHang: true }],
  ];
  for (const [why, opts] of cases) {
    sent = [];
    install(opts);
    const out = await approve();
    assert.equal(out.statusCode, 200, `${why}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.ok, true, why);
    assert.equal(sent.length, 1, why);
    assert.deepEqual(sent[0].to, [PROFILE.email], why);
    generic(sent[0], why);
  }
  assert.equal(factsCalls.at(-1).bounded, true, 'the read that never answered was ended by its own time limit');
});

test('#69: a rejected or expired decision states no term at all — even for an extension that still carries one', async () => {
  // A Super Admin can reopen and re-decide a request (#66); the term it once granted stays in
  // the database, and the facts function returns it. The email must not.
  const stale = {
    ...FACTS, getting_started_required: true,
    batch: { name: 'October 2026', code: '2026-10', starts_on: '2026-10-01' },
  };
  for (const status of ['rejected', 'expired']) {
    sent = [];
    install({
      row: { ...ROW, status, rejection_reason: 'Amount does not match' },
      facts: { ...stale, request: { id: REQ, status, kind: 'extension', extension_days: 60 } },
    });
    const out = await call({ requestId: REQ, status });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    for (const part of [plain(sent[0].html), sent[0].text]) {
      assert.doesNotMatch(part, A_DATE, status);
      assert.ok(!/active until|Active until|Access until|Access opens|Program access|Cohort|Extension|60 days|Getting Started|is approved/i.test(part), status);
      assert.ok(part.includes('Amount does not match'), 'the recorded reason');
      assert.ok(part.includes('Essentials'), 'the package the request was for');
    }
  }
});

// ── Reply-To ─────────────────────────────────────────────────────────────────────────

test('#69: replies go to the stored support address, then NOTIFY_ADMIN_EMAIL — and never to RESEND_FROM', async () => {
  install({ facts: FACTS, settingsValue: SUPPORT });
  await approve();
  assert.equal(sent[0].reply_to, SUPPORT);
  assert.deepEqual(settingsReads, [{ auth: 'Bearer caller-token', bounded: true }], 'one read, with the reviewer\'s JWT, that cannot hang');

  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  sent = [];
  install({ facts: FACTS, settingsValue: SUPPORT });
  await approve();
  assert.equal(sent[0].reply_to, SUPPORT, 'the admin-editable address outranks the env one');
  // Not one bare address — nothing, a sentence, a list, a bracketed form — is not a Reply-To.
  for (const opts of [{ settingsValue: null }, { settingsValue: 'not an address' }, { settingsValue: 'one,two@example.test' },
    { settingsValue: 'Support <support-desk@example.test>' }, { settingsValue: 42 }, {}]) {   // {} = the read throws
    sent = [];
    install({ facts: FACTS, ...opts });
    await approve();
    assert.equal(sent[0].reply_to, 'owner@example.test', JSON.stringify(opts));
  }

  delete process.env.NOTIFY_ADMIN_EMAIL;
  for (const opts of [{ settingsValue: null }, {}]) {
    sent = [];
    install({ facts: FACTS, ...opts });
    const out = await approve();
    assert.equal(out.statusCode, 200, 'an email with nowhere to reply is still sent');
    assert.ok(!('reply_to' in sent[0]), 'the header is left out');
    assert.ok(!JSON.stringify(sent[0].reply_to ?? '').includes('noreply@example.test'), 'never the no-reply From');
  }
});

test('#69: an approval never prints a reason, even when an old one is still on the row', async () => {
  // Reject → (a Super Admin reopens) → approve can leave the earlier reason behind.
  install({ row: { ...ROW, rejection_reason: 'a stale reason from an earlier decision' }, facts: FACTS });
  await approve();
  assert.ok(!/stale reason|Reason:/.test(sent[0].html + sent[0].text));
  // …and a rejection with no reason does not point at one.
  sent = [];
  install({ row: { ...ROW, status: 'rejected', rejection_reason: null } });
  await call({ requestId: REQ, status: 'rejected' });
  assert.ok(!/reason is below|Reason:/.test(sent[0].html + sent[0].text));
  assert.ok(sent[0].text.includes('Please log in and resubmit your payment proof.'));
});

test('#69: a rejection invites a reply only when a reply has somewhere to go', async () => {
  const rejected = { ...ROW, status: 'rejected', rejection_reason: 'Receipt unreadable' };
  install({ row: rejected, settingsValue: SUPPORT });
  await call({ requestId: REQ, status: 'rejected' });
  assert.equal(sent[0].reply_to, SUPPORT);
  for (const part of [plain(sent[0].html), sent[0].text]) assert.ok(part.includes('just reply to this email'));

  sent = [];
  install({ row: rejected, settingsValue: null });
  await call({ requestId: REQ, status: 'rejected' });
  assert.ok(!('reply_to' in sent[0]));
  for (const part of [plain(sent[0].html), sent[0].text]) {
    assert.ok(!/reply to this email/i.test(part), 'a reply would reach the no-reply From');
    assert.ok(part.includes('Receipt unreadable') && part.includes('resubmit your payment proof'));
  }
});

// ── Idempotency and the provider's answer ────────────────────────────────────────────

test('#69: one decision is one email — the key names the request and the decision, and a text part rides along', async () => {
  install({ facts: FACTS, settingsValue: SUPPORT });
  const out = await approve();
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body, { ok: true, id: 'resend-test-id' });
  assert.deepEqual(keys, [`enrollment-decision-${REQ}-approved-${STAMP}`]);
  assert.ok(typeof sent[0].text === 'string' && sent[0].text.length > 60 && sent[0].html.length > 60, 'multipart');
  assert.ok(!/<[a-z!/]/i.test(sent[0].text), 'the text part is text');

  // The key is built from the ROW's id — what the database stores — so the same request named
  // in another letter-case is the same email, not a second one. (REQ is all digits, so this
  // needs an id with letters in it to mean anything.)
  const LETTERS = 'abcdef12-2222-4333-8444-555555555555';
  keys = []; sent = [];
  install({ row: { ...ROW, id: LETTERS }, facts: { ...FACTS, request: { ...FACTS.request, id: LETTERS } } });
  const upper = await approve({ requestId: LETTERS.toUpperCase() });
  assert.equal(upper.statusCode, 200, JSON.stringify(upper.body));
  assert.deepEqual(keys, [`enrollment-decision-${LETTERS}-approved-${STAMP}`]);
  assert.deepEqual(factsCalls.at(-1).body, { p_request_id: LETTERS }, 'and the facts are asked about the row, not the spelling');
  assert.ok(sent[0].text.includes('active until November 30, 2026.'), 'the facts still match the request');
  assert.match(keys[0], /^[A-Za-z0-9:_-]{8,128}$/, 'a key outside this set is silently replaced by a random one');

  for (const status of ['rejected', 'expired']) {
    keys = []; sent = [];
    install({ row: { ...ROW, status } });
    await call({ requestId: REQ, status });
    assert.deepEqual(keys, [`enrollment-decision-${REQ}-${status}-${STAMP}`]);
    assert.ok(sent[0].text.length > 60);
  }
});

test('#69: a 409 for the same key is the email already in flight; any other refusal is a 502 with its code', async () => {
  install({ facts: FACTS, resendStatus: 409 });
  const dup = await approve();
  assert.equal(dup.statusCode, 200);
  assert.deepEqual(dup.body, { ok: false, skipped: 'in_flight' });

  install({ facts: FACTS, resendStatus: 422 });
  const refused = await approve();
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, 'resend_422');
  assert.ok(!JSON.stringify(refused.body).includes('PROVIDER-SENTENCE'), 'the provider\'s sentence names the recipient');
  assert.ok(!JSON.stringify(refused.body).includes(PROFILE.email));
});

test('#69: a refused decision email is logged as a status code — never the provider\'s sentence, an address, a name, a key or a token', async () => {
  // With NOTIFY_ADMIN_EMAIL set and a support address stored, every address this action can
  // hold is in play: the student's, the Reply-To, the From and the one typed on the request.
  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  const secrets = [
    'PROVIDER-SENTENCE', PROFILE.email, ROW.email, SUPPORT, 'owner@example.test', 'noreply@example.test',
    PROFILE.full_name, 'Receipt unreadable', 're_test', 'caller-token', ANON,
  ];
  for (const status of ['approved', 'rejected']) {
    for (const resendStatus of [422, 403, 500]) {
      logged = []; sent = [];
      install({
        row: { ...ROW, status, rejection_reason: status === 'rejected' ? 'Receipt unreadable' : null },
        facts: { ...FACTS, request: { ...FACTS.request, status } }, settingsValue: SUPPORT, resendStatus,
      });
      const out = await call({ requestId: REQ, status });
      assert.equal(out.statusCode, 502, `${status} ${resendStatus}`);
      assert.equal(out.body.code, `resend_${resendStatus}`);
      assert.equal(sent[0].reply_to, SUPPORT, 'the refused message did carry the support address');
      const all = logged.join('\n');
      assert.ok(all.includes(String(resendStatus)), `${status}: the ${resendStatus} is what gets logged`);
      for (const secret of secrets) assert.ok(!all.includes(secret), `${status} ${resendStatus}: ${secret} reached a log line`);
    }
  }
  // …and a delivered decision logs nothing at all.
  logged = []; sent = [];
  install({ facts: FACTS, settingsValue: SUPPORT });
  const ok = await approve();
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(sent.length, 1);
  assert.deepEqual(logged, []);
});

// ── Links ────────────────────────────────────────────────────────────────────────────

test('#69: every link in the HTML part is in the text part, and on Vercel a link is APP_URL or nothing', async () => {
  process.env.APP_URL = 'https://toolkits.example.test/';
  install({ facts: FACTS });
  await approve();
  assert.deepEqual(hrefsOf(sent[0].html), ['https://toolkits.example.test/']);
  for (const href of hrefsOf(sent[0].html)) assert.ok(sent[0].text.includes(href), `${href} is missing from the text part`);
  assert.ok(sent[0].text.includes('Sign in to Toolkits by Alex: https://toolkits.example.test/'));

  // A rejection links back to the same place, to resubmit.
  sent = [];
  install({ row: { ...ROW, status: 'rejected', rejection_reason: 'Receipt unreadable' } });
  await call({ requestId: REQ, status: 'rejected' });
  assert.deepEqual(hrefsOf(sent[0].html), ['https://toolkits.example.test/']);
  assert.ok(sent[0].text.includes('Sign in to resubmit: https://toolkits.example.test/'));

  // On Vercel with no APP_URL the request's Host is not trusted: a preview shares production's database.
  delete process.env.APP_URL;
  process.env.VERCEL_ENV = 'preview';
  sent = [];
  install({ facts: FACTS });
  await call({ requestId: REQ, status: 'approved' }, { host: 'evil-preview.example.test' });
  assert.deepEqual(hrefsOf(sent[0].html), []);
  assert.ok(!/evil-preview|https?:\/\//.test(sent[0].text + sent[0].html.replace(/xmlns="[^"]*"/g, '')));

  // Under `npm run dev` the local origin is the only one there is.
  delete process.env.VERCEL_ENV;
  sent = [];
  install({ facts: FACTS });
  await call({ requestId: REQ, status: 'approved' }, { host: 'localhost:5173' });
  assert.deepEqual(hrefsOf(sent[0].html), ['http://localhost:5173/']);
});

test('#69: no storage path or signed URL can reach a decision email', async () => {
  install({
    row: { ...ROW, receipt_path: `${STUDENT}/receipt-0a1b2c3d-proof.png`, resume_path: `${STUDENT}/resume-0a1b2c3d.pdf` },
    facts: { ...FACTS, receipt_path: `${STUDENT}/receipt-0a1b2c3d-proof.png`, signed_url: 'https://x.supabase.co/storage/v1/object/sign/enrollment-receipts/a?token=abc' },
  });
  await approve();
  const all = `${sent[0].subject}\n${sent[0].html}\n${sent[0].text}`;
  for (const banned of ['receipt_path', 'enrollment-receipts', '/storage/', '/object/sign/', 'token=', `${STUDENT}/`, 'receipt-0a1b2c3d']) {
    assert.ok(!all.includes(banned), `${banned} must not reach an email`);
  }
});

// ── The HTML part ────────────────────────────────────────────────────────────────────
// Two values nobody types honestly: one that would be an element, and one that would close
// the attribute or the cell it sits in and open a link of its own.
const XSS_TAG = '<img src=x onerror=alert(1)>';
const XSS_ATTR = '"><a href="http://evil.example">x</a>';
/** A value as it must be spelled inside an HTML part to be shown as text. */
const escaped = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Every element an HTML part opens or closes, in order — what a mail client would build from it. */
const tagsOf = (html) => [...String(html).matchAll(/<\/?[a-zA-Z][a-zA-Z0-9]*/g)].map((m) => m[0].toLowerCase());

test('#69: nothing the database returns — a name, a package, a cohort, a reason — becomes markup in the HTML part', async () => {
  process.env.APP_URL = 'https://toolkits.example.test';
  // The name reaches the email inside a SENTENCE (the greeting), the package inside that
  // sentence and a table cell, the cohort and the scope in cells, the reason in its own block.
  // A student controls the first (their own profile and request); the catalog and a reviewer
  // write the rest.
  const fixture = (a, b, status) => ({
    row: { ...ROW, status, full_name: `${a} typed`, plan_name: b, rejection_reason: status === 'approved' ? null : `${a} ${b}` },
    profile: { ...PROFILE, full_name: `${a} ${b}` },
    facts: {
      ...FACTS,
      request: { ...FACTS.request, status },
      plan: { ...FACTS.plan, name: a, tagline: b, entitlement_summary: [a, b], community_segment: 'vip' },
      batch: { name: b, code: '2026-10', starts_on: '2026-10-01' },
    },
  });
  const render = async (a, b, status, withFacts) => {
    sent = [];
    const f = fixture(a, b, status);
    install(withFacts ? f : { row: f.row, profile: f.profile });
    const out = await call({ requestId: REQ, status });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    return sent[0];
  };
  const name = `${XSS_TAG} ${XSS_ATTR}`;
  for (const [status, withFacts] of [['approved', true], ['approved', false], ['rejected', true], ['rejected', false], ['expired', true]]) {
    const why = `${status}${withFacts ? '' : ', the generic copy'}`;
    const benign = await render('Alpha', 'Beta', status, withFacts);
    const hostile = await render(XSS_TAG, XSS_ATTR, status, withFacts);
    // The same elements as the harmless render, in the same order: a hostile value added none.
    assert.deepEqual(tagsOf(hostile.html), tagsOf(benign.html), `${why}: a value became an element`);
    assert.deepEqual(hrefsOf(hostile.html), ['https://toolkits.example.test/'], `${why}: a value became a link`);
    assert.ok(!hostile.html.includes('<img src=x') && !hostile.html.includes('href="http://evil'), `${why}: raw markup in the HTML part`);
    // The greeting and the package are in the intro sentence — shown, as text.
    const plan = withFacts ? XSS_TAG : XSS_ATTR;   // the catalog's name, else the row's snapshot
    assert.ok(hostile.html.includes(`>Hello ${escaped(name)}, `), `${why}: the name`);
    assert.ok(hostile.html.includes(` for ${escaped(plan)} `), `${why}: the package`);
    // A text part is not markup: it keeps the characters exactly as they are stored.
    assert.ok(hostile.text.includes(`\n\nHello ${name}, `) && hostile.text.includes(` for ${plan} `), `${why}: the text part keeps the literal characters`);
    assert.ok(!hostile.text.includes('&lt;') && !hostile.text.includes('&quot;'), `${why}: no entity in a text part`);
    if (status !== 'approved') {
      assert.ok(hostile.html.includes(`<strong>Reason:</strong> ${escaped(`${XSS_TAG} ${XSS_ATTR}`)}</div>`), `${why}: the recorded reason`);
      assert.ok(hostile.text.includes(`\nReason: ${XSS_TAG} ${XSS_ATTR}\n`), `${why}: the reason, literal`);
    }
  }
  // The approval's own rows: the package and its tagline, the scope chips, the cohort.
  const approved = await render(XSS_TAG, XSS_ATTR, 'approved', true);
  for (const [label, value] of [
    ['Package', `${XSS_TAG} (${XSS_ATTR})`],
    ['Program access', `${XSS_TAG} · ${XSS_ATTR}`],
    ['Cohort', XSS_ATTR],
  ]) {
    assert.ok(approved.text.includes(`\n  * ${label}: ${value}\n`), `${label}: the text row`);
    assert.ok(approved.html.includes(`>${label}</td>`) && approved.html.includes(`>${escaped(value)}</td>`), `${label}: the HTML cell`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The final review of #69 (Task 13): EMAIL-1, EMAIL-2, EMAIL-3
// ═════════════════════════════════════════════════════════════════════════════════════

/**
 * A provider that keeps Resend's idempotency contract (docs: idempotency keys): a key it has seen
 * with the SAME payload replays the first answer and sends nothing more; the same key with a
 * DIFFERENT payload is a 409 invalid_idempotent_request; a new key is a new email.
 */
function idempotentResend() {
  const seen = new Map();   // key -> { payload, id }
  const delivered = [];
  return {
    delivered,
    answer(body, key) {
      const payload = JSON.stringify(body);
      const prior = seen.get(key);
      if (prior) {
        return prior.payload === payload
          ? { status: 200, json: { id: prior.id } }
          : { status: 409, json: { statusCode: 409, name: 'invalid_idempotent_request', message: 'PROVIDER-SENTENCE: this key was used with a different payload' } };
      }
      const id = `delivered-${delivered.length + 1}`;
      seen.set(key, { payload, id });
      delivered.push(body);
      return { status: 200, json: { id } };
    },
  };
}

test('EMAIL-2: the key names the request, the decision AND the moment it was recorded — a decision made again is a new email', async () => {
  install();
  await approve();
  assert.deepEqual(keys, [`enrollment-decision-${REQ}-approved-${STAMP}`]);
  assert.equal(keys[0], `enrollment-decision-${REQ}-approved-1790740798123`, 'epoch MILLIseconds — never an ISO string');
  assert.match(keys[0], /^[A-Za-z0-9:_-]{8,128}$/, 'a key outside this set is silently replaced by a random one');
  assert.ok(calls.find((u) => u.includes('/rest/v1/enrollment_requests?')).includes('reviewed_at'),
    'the moment is read from the request row');

  // The same decision sent again is the same key: a double click is one email.
  keys = [];
  install(); await approve();
  install(); await approve({ requestId: REQ.toUpperCase() });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);

  // A Super Admin reopened it (#66) and it was approved again: a new moment, a new key. The second
  // approval stacked a new term, and its email is the one that says so.
  keys = [];
  install({ row: { ...ROW, reviewed_at: '2026-09-30T05:10:00+00:00' } });
  await approve();
  assert.deepEqual(keys, [`enrollment-decision-${REQ}-approved-1790745000000`]);

  // Every decision keys on the same column; a row with no readable moment still gets a well-formed key.
  for (const [status, reviewedAt, stamp] of [
    ['rejected', '2026-09-30T06:00:00.5+00:00', '1790748000500'],
    ['expired', REVIEWED_AT, STAMP],
    ['rejected', null, '0'],
    ['approved', 'not a timestamp', '0'],
  ]) {
    keys = [];
    install({ row: { ...ROW, status, reviewed_at: reviewedAt } });
    const out = await call({ requestId: REQ, status });
    assert.equal(out.statusCode, 200, `${status} at ${reviewedAt}: ${JSON.stringify(out.body)}`);
    assert.deepEqual(keys, [`enrollment-decision-${REQ}-${status}-${stamp}`], `${status} at ${reviewedAt}`);
  }
});

test('EMAIL-2: only a 409 the provider names "in progress" is "already on its way" — the same key with a different payload is a refusal', async () => {
  install({ facts: FACTS, resendStatus: 409, resend409Name: 'concurrent_idempotent_requests' });
  const inFlight = await approve();
  assert.equal(inFlight.statusCode, 200);
  assert.deepEqual(inFlight.body, { ok: false, skipped: 'in_flight' });

  for (const [why, resend409Name] of [
    ['the key was already used with a DIFFERENT payload', 'invalid_idempotent_request'],
    ['a 409 the provider names something else', 'validation_error'],
    ['a 409 whose body is not JSON', null],
  ]) {
    install({ facts: FACTS, resendStatus: 409, resend409Name });
    const out = await approve();
    assert.equal(out.statusCode, 502, `${why}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.ok, false, why);
    assert.equal(out.body.code, 'resend_409', why);
    assert.ok(!('skipped' in out.body), `${why}: never "already on its way" — nobody is sending it`);
    assert.ok(!JSON.stringify(out.body).includes('PROVIDER-SENTENCE'), `${why}: the provider's sentence names the recipient`);
  }
});

test('EMAIL-2: a decision reopened and made again reaches the student — against a provider that keeps Resend\'s idempotency contract', async () => {
  const provider = idempotentResend();
  const reasonOf = (m) => (m.text.match(/\nReason: ([^\n]*)\n/) || [])[1] ?? null;
  const decide = async (row) => {
    install({ row: { ...ROW, ...row }, provider });
    return call({ requestId: REQ, status: row.status });
  };

  // Rejected — and the reviewer's double click sends the same request again: one email.
  const first = await decide({ status: 'rejected', rejection_reason: 'Receipt unreadable', reviewed_at: '2026-09-30T04:00:00+00:00' });
  const click = await decide({ status: 'rejected', rejection_reason: 'Receipt unreadable', reviewed_at: '2026-09-30T04:00:00+00:00' });
  assert.deepEqual([first.body.ok, click.body.ok], [true, true], JSON.stringify([first.body, click.body]));
  assert.equal(provider.delivered.length, 1, 'a double click is one email');

  // A Super Admin reopens it (#66) and rejects it again with the corrected reason, an hour later…
  const corrected = await decide({ status: 'rejected', rejection_reason: 'Amount does not match', reviewed_at: '2026-09-30T05:00:00+00:00' });
  assert.equal(corrected.statusCode, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.ok, true, 'a corrected decision is not "already on its way" — nothing else is sending it');
  // …and approves it after that.
  const approved = await decide({ status: 'approved', rejection_reason: null, reviewed_at: '2026-09-30T05:30:00+00:00' });
  assert.equal(approved.body.ok, true, JSON.stringify(approved.body));

  assert.deepEqual(provider.delivered.map(reasonOf), ['Receipt unreadable', 'Amount does not match', null],
    'the student hears every decision, and the corrected reason is the one they read');
  assert.ok(provider.delivered[2].text.includes('your enrollment is approved'));
});

const runOf = (n, prefix = '11111111-2222-4333-8444-') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(12, '0')}`);

test('EMAIL-1: a reviewer deciding many requests in one minute — a bulk approval or rejection — has every decision emailed', async () => {
  // ONE reviewer for the whole run, on a pinned clock: every send lands in the same minute.
  const approve15 = runOf(15);
  const reject15 = runOf(15, '22222222-2222-4333-8444-');
  install({
    rowFor: (id) => (approve15.includes(id) ? { ...ROW, id }
      : reject15.includes(id) ? { ...ROW, id, status: 'rejected', rejection_reason: 'Receipt unreadable' } : null),
  });
  const answers = [];
  for (const id of approve15) answers.push(await call({ requestId: id, status: 'approved' }));
  for (const id of reject15) answers.push(await call({ requestId: id, status: 'rejected' }));
  assert.deepEqual(answers.map((a) => a.statusCode), answers.map(() => 200),
    'a 429 here is a student who is never told — and the dialog said "the student is emailed"');
  assert.deepEqual(answers.map((a) => a.body.ok), answers.map(() => true));
  assert.equal(sent.length, 30);
  assert.equal(new Set(keys).size, 30, 'thirty decisions, thirty keys');
});

test('EMAIL-1: the guard still bounds a loop on ONE decision — and only that decision', async () => {
  const OTHER = '11111111-2222-4333-8444-999999999999';
  install({ rowFor: (id) => (id === REQ ? ROW : id === OTHER ? { ...ROW, id: OTHER } : null) });
  const loop = [];
  for (let i = 0; i < 12; i += 1) loop.push(await approve());
  assert.deepEqual(loop.map((a) => a.statusCode), [...Array(10).fill(200), 429, 429],
    'the same decision, again and again in one minute: the eleventh is refused');
  assert.equal(sent.length, 10, 'and a refused one sends nothing');
  assert.equal(calls.filter((u) => u.includes('/rest/v1/profiles?')).length, 10, 'nor reads the student\'s account');
  assert.ok(!JSON.stringify(loop[10].body).includes(PROFILE.email));

  // That reviewer's next decision is not held up by the loop.
  const next = await call({ requestId: OTHER, status: 'approved' });
  assert.equal(next.statusCode, 200, JSON.stringify(next.body));
  assert.equal(next.body.ok, true);
  assert.equal(sent.length, 11);
});

test('EMAIL1-R1: one reviewer\'s decision emails have a ceiling of their own — 60 a minute, every decision together', async () => {
  // A decision's key carries reviewed_at, and an enrollments.review holder can re-stamp reviewed_at on a DECIDED
  // row (#48's column grant; #66 locks only the status). Every re-stamp is a new key: a "new" decision the
  // per-decision guard has never counted, and an email the provider has never de-duplicated. The review
  // reproduced 30 emails to one student this way, all delivered.
  let n = 0;
  install({
    rowFor: (id) => (id === REQ ? {
      ...ROW, status: 'rejected', rejection_reason: `Reason ${n}`,
      reviewed_at: new Date(NOW - 3_600_000 + (n += 1) * 1000).toISOString(),
    } : null),
  });
  const loop = [];
  for (let i = 0; i < 70; i += 1) loop.push(await call({ requestId: REQ, status: 'rejected' }));
  assert.deepEqual(loop.map((a) => a.statusCode), [...Array(60).fill(200), ...Array(10).fill(429)],
    'the re-stamp loop: sixty in a minute, then "not now"');
  assert.equal(sent.length, 60, 'and a refused one sends nothing');
  assert.equal(new Set(keys).size, 60, 'every one a distinct decision key — the per-decision guard could not see the loop');
  assert.ok(!JSON.stringify(loop[60].body).includes(PROFILE.email));

  // A bulk run is far below it — one row at a time — but 61 distinct decisions in one minute are 60, then a wait.
  const ids = runOf(61, '33333333-2222-4333-8444-');
  install({ rowFor: (id) => (ids.includes(id) ? { ...ROW, id } : null) });
  const run = [];
  for (const id of ids) run.push((await call({ requestId: id, status: 'approved' })).statusCode);
  assert.deepEqual(run, [...Array(60).fill(200), 429]);
  // The ceiling is that reviewer's: another reviewer is not held up by it.
  install({ rowFor: (id) => (ids.includes(id) ? { ...ROW, id } : null) });
  assert.equal((await call({ requestId: ids[60], status: 'approved' })).statusCode, 200);
  // ★ Checked AFTER the per-decision guard: a loop on ONE decision is refused by that guard and never spends the
  //   reviewer's run — their next fifty decisions all go.
  install({ rowFor: (id) => (id === REQ ? ROW : ids.includes(id) ? { ...ROW, id } : null) });
  const repeated = [];
  for (let i = 0; i < 70; i += 1) repeated.push((await approve()).statusCode);
  assert.deepEqual(repeated, [...Array(10).fill(200), ...Array(60).fill(429)]);
  const next = [];
  for (const id of ids.slice(0, 50)) next.push((await call({ requestId: id, status: 'approved' })).statusCode);
  assert.deepEqual(next, Array(50).fill(200), 'a loop on one decision never spends the reviewer\'s run');
});

// Every MANDATORY line break in Unicode (UAX #14: BK — VT, FF, LINE and PARAGRAPH SEPARATOR; CR; LF;
// NL — NEL). A renderer that honours them starts a new line at each one.
const SEPARATORS = {
  CR: '\r', LF: '\n', CRLF: '\r\n', VT: '\v', FF: '\f', NEL: '\u0085', 'LINE SEPARATOR': '\u2028', 'PARAGRAPH SEPARATOR': '\u2029',
};
/** The lines such a renderer would show. */
const renderedLines = (text) => String(text).split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);

test('EMAIL-3: no line break a student can type — CR, LF, VT, FF, NEL, LINE or PARAGRAPH SEPARATOR — starts a line of the text part', async () => {
  for (const [name, sep] of Object.entries(SEPARATORS)) {
    sent = [];
    install({ facts: FACTS, profile: { ...PROFILE, full_name: `Mallory${sep}  * Active until: January 1, 2099` } });
    const out = await approve();
    assert.equal(out.statusCode, 200, `${name}: ${JSON.stringify(out.body)}`);
    const m = sent[0];
    assert.deepEqual(renderedLines(m.text).filter((l) => l.startsWith('  * Active until: ')), ['  * Active until: November 30, 2026'],
      `${name}: a name forged a row of its own`);
    assert.ok(!/[\r\v\f\u0085\u2028\u2029]/.test(m.text), `${name}: the text part's only line break is LF`);
    assert.ok(!/[\r\n\v\f\u0085\u2028\u2029]/.test(m.subject), `${name}: one-line subject`);
    assert.ok(m.text.includes('\n\nHello Mallory * Active until: January 1, 2099, your payment for Essentials'), `${name}: folded into one space`);
  }
});
