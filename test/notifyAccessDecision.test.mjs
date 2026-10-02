// ─────────────────────────────────────────────────────────────────────────────
// test/notifyAccessDecision.test.mjs — api/notify-access.js, end to end (#69).
// ─────────────────────────────────────────────────────────────────────────────
// Until #69 this endpoint took the recipient address, the name and the rejection "reason"
// from the request BODY. Any access_requests.review holder — an Operations Admin included —
// could therefore send the business's own "your access has been approved" email to any
// address, with any text in it: the hole closed for the enrollment decision on 2026-09-24,
// left open here. These tests pin the replacement contract:
//   • the body names an ACCOUNT and a DECISION, and nothing else in it is read;
//   • the server reads that account's profile with the reviewer's own JWT (RLS decides
//     whether they may see it) and mails only the account's own address;
//   • the email is refused unless the decision it announces is the one recorded on the row,
//     and for a migrated account the migration is still setting up;
//   • the approved copy is true — an approved ACCOUNT still has to choose a plan — and the
//     email carries a text part, a Reply-To that is never RESEND_FROM, and a key that makes a
//     double click one email while a later re-decision is a new one;
//   • nothing the provider says, and no address, reaches a log.
//
// And what the final review of #69 (Task 13) changed, pinned at the end of this file:
//   • EMAIL-1: the burst guard counts sends of ONE decision, not every decision a reviewer makes —
//     clearing a backlog of signups is not a runaway loop;
//   • EMAIL-2: only a provider 409 named "in progress" reads as "already on its way";
//   • EMAIL-3: no Unicode line break in a name starts a line of the text part;
//   • TDR-7: a page opened before #69 posts the old body; it is refused BY NAME, so the deployment
//     log says why that decision's email did not go — and the address in that body is never read.
//
// No network. globalThis.fetch is a router keyed on URL; an unexpected URL throws and is
// recorded, so a stray call fails the test that made it. Synthetic data only.
// ─────────────────────────────────────────────────────────────────────────────

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SUPA = 'https://notify-access-test.supabase.example';
const ANON = 'anon-key-for-notify-access-tests';
// staffAuth.js and the handler read these at import time, so set them BEFORE importing.
process.env.VITE_SUPABASE_URL = SUPA;
process.env.VITE_SUPABASE_ANON_KEY = ANON;
const { default: handler } = await import('../api/notify-access.js');

const USER = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const APPROVED_AT = '2026-09-30T03:15:42.123+00:00';
const REJECTED_AT = '2026-09-30T05:00:00+00:00';
const PROFILE = {
  email: 'real.student@example.test', full_name: 'Real Student', approval_status: 'approved',
  approved_at: APPROVED_AT, rejected_at: null, rejection_reason: null, account_origin: 'signup',
};
const REJECTED = {
  ...PROFILE, approval_status: 'rejected', approved_at: null, rejected_at: REJECTED_AT,
  rejection_reason: 'We could not confirm your enrollment details',
};
const PROFILE_URL = `${SUPA}/rest/v1/profiles?id=eq.${USER}`
  + '&select=email,full_name,approval_status,approved_at,rejected_at,rejection_reason,account_origin';
const SUPPORT = 'support-desk@example.test';
const APPROVED_SENTENCE = "Your account is approved. Sign in to continue — if you haven't enrolled yet, you'll be asked to choose a plan.";

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

let savedFetch; let savedEnv; let savedConsole; let logged;
let calls; let sent; let keys; let profileReads; let settingsReads;

/**
 * @param {object}      [o]
 * @param {object|null} [o.profile]        the account's profiles row; null = no row the caller may see
 * @param {number}      [o.profileStatus]  the HTTP status of that read
 * @param {string|null} [o.settingsValue]  payment_settings.notify_email; undefined = the read throws
 * @param {number}      [o.resendStatus]   the provider's answer
 * @param {boolean}     [o.userOk]         is the bearer token a real session?
 * @param {string|null} [o.resend409Name]  a 409's error name, as Resend sends it; null = a body that is not JSON
 * @param {(id: string) => object|null} [o.profileFor]  a profile per requested id — one reviewer, many accounts
 */
function install({
  staff = OPS, profile = PROFILE, profileStatus = 200, settingsValue, resendStatus = 200, userOk = true,
  resend409Name = 'concurrent_idempotent_requests', profileFor = null,
} = {}) {
  const caller = crypto.randomUUID();   // the rate limiter is per caller, at module scope
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
    const auth = () => String(new Headers(init.headers).get('authorization'));
    if (u === `${SUPA}/auth/v1/user`) return userOk ? res({ id: caller }) : res({ msg: 'bad jwt' }, 401);
    if (u === `${SUPA}/rest/v1/rpc/my_staff_context`) return res(staff);
    if (u.startsWith(`${SUPA}/rest/v1/profiles?`)) {
      profileReads.push({ url: u, auth: auth(), bounded: Boolean(init.signal) });
      const found = profileFor ? profileFor(decodeURIComponent((u.match(/[?&]id=eq\.([^&]+)/) || [])[1] || '')) : profile;
      return res(found ? [found] : [], profileStatus);
    }
    if (settingsValue !== undefined && u.startsWith(`${SUPA}/rest/v1/payment_settings?`)) {
      settingsReads.push({ auth: auth(), bounded: Boolean(init.signal) });
      return res(settingsValue == null ? [] : [{ value: settingsValue }]);
    }
    if (u === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      sent.push(body);
      keys.push(new Headers(init.headers).get('idempotency-key'));
      // Resend's 409 names WHICH conflict it is (docs: idempotency keys, "Possible responses").
      if (resendStatus === 409) {
        return resend409Name === null ? new Response('<html>409 Conflict</html>', { status: 409 })
          : res({ statusCode: 409, name: resend409Name, message: `PROVIDER-SENTENCE about ${body.to[0]}` }, 409);
      }
      // A refusal body names the recipient, as the real provider's does.
      return resendStatus === 200 ? res({ id: 'resend-test-id' })
        : res({ name: 'validation_error', message: `PROVIDER-SENTENCE about ${body.to[0]}` }, resendStatus);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function call(body, { method = 'POST', headers = { authorization: 'Bearer caller-token' } } = {}) {
  const req = { method, headers, body };
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

/** The HTML part with its entities decoded, so one sentence can be looked for in both parts. */
const plain = (html) => String(html).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

beforeEach(() => {
  calls = []; sent = []; keys = []; profileReads = []; settingsReads = []; logged = [];
  savedFetch = globalThis.fetch;
  savedEnv = { ...process.env };
  savedConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const level of Object.keys(savedConsole)) console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Toolkits <noreply@example.test>';
  delete process.env.NOTIFY_ADMIN_EMAIL;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = savedEnv;
  Object.assign(console, savedConsole);
});

// ── Who is emailed, and with what ────────────────────────────────────────────────────

test('the body names an account and a decision — nothing else in it reaches the email', async () => {
  install();
  const out = await call({
    userId: USER, status: 'approved',
    email: 'attacker@evil.test', fullName: 'Click Here Friend', reason: 'Log in at http://evil.example',
    to: 'attacker@evil.test', subject: 'You won', html: '<a href="http://evil.example">here</a>',
  });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body, { ok: true, id: 'resend-test-id' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [PROFILE.email], 'the address in the body must be ignored');
  assert.match(sent[0].html, /Real Student/);
  assert.ok(!/attacker|Click Here Friend|evil\.example|You won/.test(JSON.stringify(sent[0])),
    'no body-supplied text may reach the email');
  assert.ok(!(sent[0].cc || sent[0].bcc));
});

test('the recipient is the account\'s own address, read with the REVIEWER\'s JWT', async () => {
  install();
  await call({ userId: USER, status: 'approved' });
  assert.deepEqual(profileReads, [{ url: PROFILE_URL, auth: 'Bearer caller-token', bounded: true }],
    'one read of that one row, under RLS, that cannot hang the function');
  assert.deepEqual(sent[0].to, [PROFILE.email]);
  // The account is named however the request spelled its id; the row is the same row.
  profileReads = []; sent = [];
  install();
  const upper = await call({ userId: USER.toUpperCase(), status: 'approved' });
  assert.equal(upper.statusCode, 200, JSON.stringify(upper.body));
  assert.deepEqual(sent[0].to, [PROFILE.email]);
});

test('a rejection carries the reason recorded on the ROW, not the body\'s', async () => {
  install({ profile: REJECTED, settingsValue: SUPPORT });
  const out = await call({ userId: USER, status: 'rejected', reason: 'Log in at http://evil.example' });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(sent[0].subject, 'Your Toolkits by Alex Access Request Was Not Approved');
  for (const part of [plain(sent[0].html), sent[0].text]) {
    assert.ok(part.includes('We could not confirm your enrollment details'));
    assert.ok(!/evil\.example/.test(part));
    assert.ok(part.includes('your access request was not approved'));
  }
  assert.match(sent[0].text, /\nReason: We could not confirm your enrollment details\n/);
  // An approval never prints a reason, even if an old one is still on the row.
  sent = [];
  install({ profile: { ...PROFILE, rejection_reason: 'a stale reason from an earlier decision' } });
  await call({ userId: USER, status: 'approved' });
  assert.ok(!/stale reason|Reason:/.test(sent[0].html + sent[0].text));
});

// ── What is refused ──────────────────────────────────────────────────────────────────

test('a malformed account id or decision is refused before anything is read', async () => {
  for (const body of [
    {},
    { status: 'approved' },
    { userId: 'not-a-uuid', status: 'approved' },
    { userId: `${USER}&select=*`, status: 'approved' },
    { userId: `${USER},${USER}`, status: 'approved' },
    { userId: 12345, status: 'approved' },
    { userId: [USER], status: 'approved' },
    { userId: USER },
    { userId: USER, status: 'pending' },
    { userId: USER, status: 'expired' },
    { email: PROFILE.email, status: 'approved' },          // the pre-#69 body: no longer a way in
  ]) {
    install();   // a fresh reviewer each time: the burst limiter counts refused requests too
    const out = await call(body);
    assert.equal(out.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(profileReads.length, 0);
  assert.equal(sent.length, 0);
});

test('an account the reviewer cannot see is a 404, and nothing is sent', async () => {
  install({ profile: null });
  const out = await call({ userId: USER, status: 'approved' });
  assert.equal(out.statusCode, 404);
  assert.equal(sent.length, 0);
});

test('an account that could not be READ is not "no such account" — and nothing is sent', async () => {
  for (const opts of [{ profileStatus: 500 }, { profileStatus: 400 }]) {
    install(opts);
    const out = await call({ userId: USER, status: 'approved' });
    assert.equal(out.statusCode, 503, JSON.stringify(opts));
    assert.equal(out.body.ok, false);
  }
  assert.equal(sent.length, 0);
});

test('an email for a decision that was not recorded is refused', async () => {
  for (const [recorded, asked] of [['pending', 'approved'], ['pending', 'rejected'], ['approved', 'rejected'], ['rejected', 'approved'], [null, 'approved']]) {
    install({ profile: { ...PROFILE, approval_status: recorded } });
    const out = await call({ userId: USER, status: asked });
    assert.equal(out.statusCode, 409, `${recorded} on the row, ${asked} asked`);
    assert.equal(out.body.ok, false);
  }
  assert.equal(sent.length, 0, 'announcing a decision that did not happen is exactly the forgery');
});

test('a migrated account the migration is still setting up is refused by name', async () => {
  // admin_review_access_request() refuses this account too (ACCESS_REQUEST_IMPORT_TARGET, #67):
  // deciding on it here would happen behind the migration's back, and so would announcing it.
  for (const status of ['approved', 'rejected']) {
    install({ profile: { ...PROFILE, approval_status: 'pending', account_origin: 'import' } });
    const out = await call({ userId: USER, status });
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.code, 'ACCESS_REQUEST_IMPORT_TARGET');
  }
  assert.equal(sent.length, 0);
});

test('with no valid account address nothing is sent', async () => {
  for (const email of [null, '', 'not-an-address', 'two@example.test three@example.test']) {
    install({ profile: { ...PROFILE, email } });
    const out = await call({ userId: USER, status: 'approved' });
    assert.equal(out.statusCode, 422, JSON.stringify(email));
  }
  assert.equal(sent.length, 0);
});

test('without access_requests.review nothing is read and nothing is sent', async () => {
  install({ staff: TRAINER });
  const out = await call({ userId: USER, status: 'approved' });
  assert.equal(out.statusCode, 403);
  assert.equal(profileReads.length, 0, 'the gate must refuse before the account is read');
  assert.equal(sent.length, 0);

  install({ userOk: false });
  const anon = await call({ userId: USER, status: 'approved' });
  assert.equal(anon.statusCode, 401);
  assert.equal(profileReads.length, 0);
  assert.equal(sent.length, 0);
});

test('with email unconfigured the decision is still verified first, then skipped', async () => {
  delete process.env.RESEND_API_KEY;
  install();
  const out = await call({ userId: USER, status: 'approved' });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { ok: false, skipped: 'email_not_configured' });
  assert.equal(profileReads.length, 1);

  // …so an unrecorded decision is a 409 whether or not email is set up.
  install({ profile: { ...PROFILE, approval_status: 'pending' } });
  assert.equal((await call({ userId: USER, status: 'approved' })).statusCode, 409);

  process.env.RESEND_API_KEY = 're_test';
  delete process.env.RESEND_FROM;
  install();
  assert.deepEqual((await call({ userId: USER, status: 'approved' })).body, { ok: false, skipped: 'email_from_not_configured' });
  assert.equal(sent.length, 0);
});

// ── What it says ─────────────────────────────────────────────────────────────────────

test('the approved copy is true: the account is approved, and a plan is still to be chosen', async () => {
  install();
  await call({ userId: USER, status: 'approved' });
  assert.equal(sent[0].subject, 'Your Toolkits by Alex Account Is Approved');
  for (const part of [plain(sent[0].html), sent[0].text]) {
    assert.ok(part.includes(APPROVED_SENTENCE), 'the exact sentence');
    assert.ok(part.includes('Hello Real Student,'));
    assert.ok(!/use your dashboard|everything is unlocked|access has been approved/i.test(part),
      'an approved account has not enrolled yet: the paywall comes next');
  }
  assert.equal(sent[0].text,
    `Your account is approved 🎉\n\nHello Real Student,\n\n${APPROVED_SENTENCE}\n\nThank you,\nThe Toolkits by Alex team\n`);
  // A name that is really an email address is not echoed as a greeting.
  sent = [];
  install({ profile: { ...PROFILE, full_name: 'someone.else@example.test' } });
  await call({ userId: USER, status: 'approved' });
  assert.ok(sent[0].text.includes('\nHello,\n') && !sent[0].text.includes('someone.else@example.test'));
});

test('a text part rides along, and it is text', async () => {
  for (const profile of [PROFILE, REJECTED]) {
    sent = [];
    install({ profile });
    await call({ userId: USER, status: profile.approval_status });
    assert.ok(typeof sent[0].text === 'string' && sent[0].text.length > 60 && sent[0].html.length > 60, 'multipart');
    assert.ok(!/<[a-z!/]/i.test(sent[0].text), 'no markup in the text part');
    assert.ok(!/href=/.test(sent[0].html), 'the email carries no link, so the text part has none to repeat');
  }
});

// Two values nobody types honestly: one that would be an element, and one that would close
// the attribute or the block it sits in and open a link of its own.
const XSS_TAG = '<img src=x onerror=alert(1)>';
const XSS_ATTR = '"><a href="http://evil.example">x</a>';
/** A value as it must be spelled inside an HTML part to be shown as text. */
const escaped = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Every element an HTML part opens or closes, in order — what a mail client would build from it. */
const tagsOf = (html) => [...String(html).matchAll(/<\/?[a-zA-Z][a-zA-Z0-9]*/g)].map((m) => m[0].toLowerCase());

test('no name and no reason on the row becomes markup in the HTML part', async () => {
  // The name is the ACCOUNT's own (a signup chooses it), and it is printed as the greeting;
  // the reason is whatever a reviewer recorded. Both reach the HTML part only as text.
  const render = async (profile) => {
    sent = [];
    install({ profile });
    const out = await call({ userId: USER, status: profile.approval_status });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    return sent[0];
  };
  const name = `${XSS_TAG} ${XSS_ATTR}`;
  const reason = `${XSS_ATTR} ${XSS_TAG}`;
  for (const base of [PROFILE, REJECTED]) {
    const rejected = base.approval_status === 'rejected';
    const benign = await render({ ...base, full_name: 'Alpha Beta', rejection_reason: rejected ? 'Beta Alpha' : null });
    const hostile = await render({ ...base, full_name: name, rejection_reason: rejected ? reason : null });
    const why = base.approval_status;
    // The same elements as the harmless render, in the same order: a hostile value added none.
    assert.deepEqual(tagsOf(hostile.html), tagsOf(benign.html), `${why}: a value became an element`);
    assert.ok(!/href="/.test(hostile.html), `${why}: a value became a link`);
    assert.ok(!hostile.html.includes('<img') && !hostile.html.includes('<a '), `${why}: raw markup in the HTML part`);
    assert.ok(hostile.html.includes('&lt;img') && hostile.html.includes('&quot;&gt;&lt;a href=&quot;http://evil.example&quot;&gt;x&lt;/a&gt;'), why);
    assert.ok(hostile.html.includes(`>Hello ${escaped(name)},</p>`), `${why}: the greeting, as text`);
    // A text part is not markup: it keeps the characters exactly as they are stored.
    assert.ok(hostile.text.includes(`\nHello ${name},\n`), `${why}: the text part keeps the literal characters`);
    assert.ok(!hostile.text.includes('&lt;') && !hostile.text.includes('&quot;'), `${why}: no entity in a text part`);
    if (rejected) {
      assert.ok(hostile.html.includes(`<strong>Reason:</strong> ${escaped(reason)}</div>`), 'the recorded reason, as text');
      assert.ok(hostile.text.includes(`\nReason: ${reason}\n`), 'the reason, literal');
    }
  }
});

// ── Reply-To ─────────────────────────────────────────────────────────────────────────

test('replies go to the stored support address, then NOTIFY_ADMIN_EMAIL — and never to RESEND_FROM', async () => {
  install({ profile: REJECTED, settingsValue: SUPPORT });
  await call({ userId: USER, status: 'rejected' });
  assert.equal(sent[0].reply_to, SUPPORT);
  assert.deepEqual(settingsReads, [{ auth: 'Bearer caller-token', bounded: true }], 'one read, with the reviewer\'s JWT');
  for (const part of [plain(sent[0].html), sent[0].text]) assert.ok(/reply to this email/.test(part));

  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  sent = [];
  install({ profile: REJECTED, settingsValue: SUPPORT });
  await call({ userId: USER, status: 'rejected' });
  assert.equal(sent[0].reply_to, SUPPORT, 'the admin-editable address outranks the env one');
  for (const opts of [{ settingsValue: null }, { settingsValue: 'not an address' }, {}]) {   // {} = the read throws
    sent = [];
    install({ profile: REJECTED, ...opts });
    await call({ userId: USER, status: 'rejected' });
    assert.equal(sent[0].reply_to, 'owner@example.test', JSON.stringify(opts));
  }

  delete process.env.NOTIFY_ADMIN_EMAIL;
  for (const opts of [{ settingsValue: null }, {}]) {
    sent = [];
    install({ profile: REJECTED, ...opts });
    const out = await call({ userId: USER, status: 'rejected' });
    assert.equal(out.statusCode, 200, 'an email with nowhere to reply is still sent');
    assert.ok(!('reply_to' in sent[0]), 'the header is left out');
    for (const part of [plain(sent[0].html), sent[0].text]) {
      assert.ok(!/reply to this email/i.test(part), 'a reply would reach the no-reply From');
      assert.ok(part.includes('please contact the admin team'));
    }
  }
});

// ── Idempotency and the provider's answer ────────────────────────────────────────────

test('the key names the account, the decision and the moment it was recorded — digits only', async () => {
  install();
  await call({ userId: USER, status: 'approved' });
  assert.deepEqual(keys, [`access-decision-${USER}-approved-${Date.parse(APPROVED_AT)}`]);
  assert.equal(keys[0], `access-decision-${USER}-approved-1790738142123`);
  assert.match(keys[0], /^[A-Za-z0-9:_-]{8,128}$/, 'a key outside this set is silently replaced by a random one');

  keys = [];
  install({ profile: REJECTED });
  await call({ userId: USER, status: 'rejected' });
  assert.deepEqual(keys, [`access-decision-${USER}-rejected-${Date.parse(REJECTED_AT)}`], 'a rejection is keyed on rejected_at');

  // The same decision sent twice is the same key (one email); decided again later, a new one.
  keys = [];
  install(); await call({ userId: USER, status: 'approved' });
  install(); await call({ userId: USER.toUpperCase(), status: 'approved' });
  install({ profile: { ...PROFILE, approved_at: '2026-10-02T01:00:00+00:00' } }); await call({ userId: USER, status: 'approved' });
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);

  // PostgREST writes a timestamptz with MICROseconds; the key is the same millisecond.
  keys = [];
  install({ profile: { ...PROFILE, approved_at: '2026-09-30T03:15:42.123456+00:00' } });
  await call({ userId: USER, status: 'approved' });
  assert.deepEqual(keys, [`access-decision-${USER}-approved-1790738142123`]);

  // A row with no timestamp still gets a stable, well-formed key.
  keys = [];
  install({ profile: { ...PROFILE, approved_at: null } });
  await call({ userId: USER, status: 'approved' });
  assert.deepEqual(keys, [`access-decision-${USER}-approved-0`]);
});

test('a 409 for the same key is the email already in flight; any other refusal is a 502 with its code', async () => {
  install({ resendStatus: 409 });
  const dup = await call({ userId: USER, status: 'approved' });
  assert.equal(dup.statusCode, 200);
  assert.deepEqual(dup.body, { ok: false, skipped: 'in_flight' });

  install({ resendStatus: 422 });
  const refused = await call({ userId: USER, status: 'approved' });
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, 'resend_422');
  assert.ok(!JSON.stringify(refused.body).includes('PROVIDER-SENTENCE'));
  assert.ok(!JSON.stringify(refused.body).includes(PROFILE.email));
});

test('a refusal is logged as a status code — never the provider\'s sentence, and never an address', async () => {
  process.env.NOTIFY_ADMIN_EMAIL = 'owner@example.test';
  for (const resendStatus of [422, 403, 500]) {
    logged = [];
    install({ resendStatus, settingsValue: SUPPORT });
    const out = await call({ userId: USER, status: 'approved' });
    assert.equal(out.statusCode, 502);
    const all = logged.join('\n');
    assert.ok(all.includes(String(resendStatus)), `the ${resendStatus} is what gets logged`);
    for (const secret of ['PROVIDER-SENTENCE', PROFILE.email, SUPPORT, 'owner@example.test', 'noreply@example.test', 'Real Student', 're_test']) {
      assert.ok(!all.includes(secret), `${secret} reached a log line`);
    }
  }
  // …and a delivered email logs nothing at all.
  logged = [];
  install({ settingsValue: SUPPORT });
  await call({ userId: USER, status: 'approved' });
  assert.deepEqual(logged, []);
});

// ── The rest of the surface ──────────────────────────────────────────────────────────

test('the health check still answers without a session, and says nothing but what is configured', async () => {
  install();
  const out = await call(undefined, { method: 'GET', headers: {} });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { ok: true, hasKey: true, hasFrom: true });
  assert.equal(calls.length, 0);
  assert.equal((await call({}, { method: 'PUT' })).statusCode, 405);
});

test('the handler never takes an address, a name or a reason from the body', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/notify-access.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/body\??\.(email|fullName|reason|to|subject|html)\b/.test(code), 'a body field other than userId/status is read');
  assert.ok(!/\{[^}]*\b(email|fullName|reason)\b[^}]*\}\s*=\s*body/.test(code), 'the body is destructured for a recipient or text');
  assert.match(code, /requireStaff\(req, \{ permission: 'access_requests\.review' \}\)/);
  const gateAt = code.indexOf('await requireStaff(');
  const readAt = code.indexOf('await fetchReviewedAccount(');
  assert.ok(gateAt > 0 && readAt > gateAt, 'the gate runs before the account is read');
  assert.ok(!/service\(|SUPABASE_SECRET_KEY|SERVICE_ROLE/.test(code), 'no service-role client: the reviewer\'s own JWT reads the row');
  assert.ok(!/api\.resend\.com/.test(code), 'every send goes through the shared sendEmail');
  assert.match(code, /const decisionKey = `access-decision-\$\{userId\.toLowerCase\(\)\}-\$\{status\}-\$\{stamp\}`;/);
  assert.match(code, /idempotencyKey: decisionKey,/);
  assert.match(code, /timeoutMs: 10_000, maxAttempts: 2/);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The final review of #69 (Task 13): EMAIL-1, EMAIL-2, EMAIL-3, TDR-7
// ═════════════════════════════════════════════════════════════════════════════════════

const runOf = (n) => Array.from({ length: n }, (_, i) => `66666666-7777-4888-9999-${String(i + 1).padStart(12, '0')}`);

test('EMAIL-1: a reviewer deciding many accounts in one minute has every decision emailed — a loop on ONE decision is still bounded', async () => {
  // ONE reviewer clearing a backlog: fifteen signups approved and fifteen rejected, in a minute.
  const approve15 = runOf(15);
  const reject15 = runOf(30).slice(15);
  install({ profileFor: (id) => (approve15.includes(id) ? PROFILE : reject15.includes(id) ? REJECTED : null) });
  const answers = [];
  for (const id of approve15) answers.push(await call({ userId: id, status: 'approved' }));
  for (const id of reject15) answers.push(await call({ userId: id, status: 'rejected' }));
  assert.deepEqual(answers.map((a) => a.statusCode), answers.map(() => 200), 'a 429 here is an account that is never told');
  assert.deepEqual(answers.map((a) => a.body.ok), answers.map(() => true));
  assert.equal(sent.length, 30);
  assert.equal(new Set(keys).size, 30);

  // The same decision, again and again in one minute: the eleventh is refused, and sends nothing.
  const OTHER = '66666666-7777-4888-9999-999999999999';
  sent = [];
  install({ profileFor: (id) => (id === USER || id === OTHER ? PROFILE : null) });
  const loop = [];
  for (let i = 0; i < 12; i += 1) loop.push((await call({ userId: USER, status: 'approved' })).statusCode);
  assert.deepEqual(loop, [...Array(10).fill(200), 429, 429]);
  assert.equal(sent.length, 10);
  // …and that reviewer's next decision is not held up by it.
  const next = await call({ userId: OTHER, status: 'approved' });
  assert.equal(next.statusCode, 200, JSON.stringify(next.body));
  assert.equal(sent.length, 11);
});

test('EMAIL1-R1: one reviewer\'s decision emails have a ceiling of their own — 60 a minute, every account together', async () => {
  // admin_review_access_request() stamps approved_at / rejected_at = now() on EVERY call — it has no "already
  // decided" branch — so deciding one account again mints a new key each time: the per-decision guard never
  // counts a repeat, and the provider never de-duplicates one. The review reproduced 30 emails to one account.
  const savedNow = Date.now;
  const NOW = Date.parse('2026-09-30T06:00:00Z');
  Date.now = () => NOW;
  try {
    let n = 0;
    install({
      profileFor: (id) => (id === USER
        ? { ...PROFILE, approved_at: new Date(NOW - 3_600_000 + (n += 1) * 1000).toISOString() } : null),
    });
    const loop = [];
    for (let i = 0; i < 70; i += 1) loop.push(await call({ userId: USER, status: 'approved' }));
    assert.deepEqual(loop.map((a) => a.statusCode), [...Array(60).fill(200), ...Array(10).fill(429)],
      're-deciding one account: sixty in a minute, then "not now"');
    assert.equal(sent.length, 60, 'a refused one sends nothing');
    assert.equal(new Set(keys).size, 60, 'every one a distinct decision key — the per-decision guard could not see the loop');
    assert.ok(!JSON.stringify(loop[60].body).includes(PROFILE.email));
    // 61 distinct accounts in one minute: 60, then a wait — and the ceiling is that reviewer's alone.
    const ids = runOf(61);
    install({ profileFor: (id) => (ids.includes(id) ? PROFILE : null) });
    const run = [];
    for (const id of ids) run.push((await call({ userId: id, status: 'approved' })).statusCode);
    assert.deepEqual(run, [...Array(60).fill(200), 429]);
    install({ profileFor: (id) => (ids.includes(id) ? PROFILE : null) });
    assert.equal((await call({ userId: ids[60], status: 'approved' })).statusCode, 200);
    // ★ Checked AFTER the per-decision guard: a loop on ONE decision is refused by that guard and never spends
    //   the reviewer's run — their next fifty decisions all go.
    install({ profileFor: (id) => (id === USER || ids.includes(id) ? PROFILE : null) });
    const repeated = [];
    for (let i = 0; i < 70; i += 1) repeated.push((await call({ userId: USER, status: 'approved' })).statusCode);
    assert.deepEqual(repeated, [...Array(10).fill(200), ...Array(60).fill(429)]);
    const next = [];
    for (const id of ids.slice(0, 50)) next.push((await call({ userId: id, status: 'approved' })).statusCode);
    assert.deepEqual(next, Array(50).fill(200), 'a loop on one decision never spends the reviewer\'s run');
  } finally {
    Date.now = savedNow;
  }
});

test('EMAIL-2: only a 409 the provider names "in progress" is "already on its way" — the same key with a different payload is a refusal', async () => {
  install({ resendStatus: 409, resend409Name: 'concurrent_idempotent_requests' });
  const inFlight = await call({ userId: USER, status: 'approved' });
  assert.equal(inFlight.statusCode, 200);
  assert.deepEqual(inFlight.body, { ok: false, skipped: 'in_flight' });
  for (const [why, resend409Name] of [
    ['the key was already used with a DIFFERENT payload', 'invalid_idempotent_request'],
    ['a 409 the provider names something else', 'validation_error'],
    ['a 409 whose body is not JSON', null],
  ]) {
    install({ resendStatus: 409, resend409Name });
    const out = await call({ userId: USER, status: 'approved' });
    assert.equal(out.statusCode, 502, `${why}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.code, 'resend_409', why);
    assert.ok(!('skipped' in out.body), `${why}: never "already on its way"`);
    assert.ok(!JSON.stringify(out.body).includes('PROVIDER-SENTENCE'), why);
  }
});

// Every MANDATORY line break in Unicode (UAX #14: BK — VT, FF, LINE and PARAGRAPH SEPARATOR; CR; LF;
// NL — NEL). A renderer that honours them starts a new line at each one.
const SEPARATORS = {
  CR: '\r', LF: '\n', CRLF: '\r\n', VT: '\v', FF: '\f', NEL: '\u0085', 'LINE SEPARATOR': '\u2028', 'PARAGRAPH SEPARATOR': '\u2029',
};
const renderedLines = (text) => String(text).split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/);

test('EMAIL-3: no Unicode line break in an account\'s name starts a line of the text part', async () => {
  for (const [name, sep] of Object.entries(SEPARATORS)) {
    sent = [];
    install({ profile: { ...PROFILE, full_name: `Mallory${sep}  * Access: lifetime` } });
    const out = await call({ userId: USER, status: 'approved' });
    assert.equal(out.statusCode, 200, `${name}: ${JSON.stringify(out.body)}`);
    assert.deepEqual(renderedLines(sent[0].text).filter((l) => /^ {2}\* /.test(l)), [], `${name}: a name forged a row`);
    assert.ok(!/[\r\v\f\u0085\u2028\u2029]/.test(sent[0].text), `${name}: the text part's only line break is LF`);
    assert.ok(sent[0].text.includes('\n\nHello Mallory * Access: lifetime,\n\n'), `${name}: folded into one space`);
  }
});

test('TDR-7: a page opened before the #69 deploy posts the old body — refused BY NAME, logged without the address, nothing read or sent', async () => {
  // HEAD's AccessRequests posted { email, fullName, status, reason } — there was no userId then.
  for (const status of ['approved', 'rejected']) {
    logged = [];
    install();
    const out = await call({ email: PROFILE.email, fullName: 'Real Student', status, reason: status === 'rejected' ? 'x' : null });
    assert.equal(out.statusCode, 400, JSON.stringify(out.body));
    assert.equal(out.body.code, 'stale_client');
    assert.match(out.body.error, /reload/i);
    const all = logged.join('\n');
    assert.match(all, /\[notify-access\]/, 'the deployment log says why this decision\'s email did not go');
    assert.match(all, /reload/i);
    for (const s of [PROFILE.email, 'Real Student']) {
      assert.ok(!all.includes(s) && !JSON.stringify(out.body).includes(s), `${s}: the old body's address is never read`);
    }
  }
  assert.equal(profileReads.length, 0);
  assert.equal(sent.length, 0);
  // Only a DECISION with no userId is "an old page". A malformed userId, or a body that names no
  // decision, gets the plain refusal — and no log line.
  for (const body of [{ userId: 'not-a-uuid', status: 'approved' }, {}, { status: 'pending' }, { email: PROFILE.email }, { userId: null, status: 'approved' }]) {
    logged = [];
    install();
    const bad = await call(body);
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
    assert.ok(!('code' in bad.body), `${JSON.stringify(body)}: ${JSON.stringify(bad.body)}`);
    assert.deepEqual(logged, [], JSON.stringify(body));
  }
  // …and an unauthenticated caller still meets the gate first.
  install({ userOk: false });
  assert.equal((await call({ email: PROFILE.email, status: 'approved' })).statusCode, 401);
});
