// test/staffInvite.test.mjs — the staff invitation link + the emails that carry it (#49).
//
// WHY THIS EXISTS. The invitation is the one flow in this product where a bug is
// invisible from the inside: the server returns 200, the membership row is
// correct, and the only symptom is that a person somewhere else never got a
// usable email. Nobody notices until they ask why their new hire has not shown
// up. So the parts that can be checked without a mailbox are checked here.
//
// Reads the real modules. No network, no credentials, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVITE_LINK_TTL_HOURS, INVITE_TOKEN_TYPES, STAFF_INVITE_PATH,
  buildInviteUrl, inviteBranchFor, parseInviteHash,
} from '../src/lib/staffInvite.js';
import {
  staffInviteEmail, staffRoleAssignedEmail,
} from '../api/_lib/staffInviteEmail.js';
import { esc, plainText, displayFrom, sendEmail, BRAND } from '../api/_lib/email.js';
import {
  EMPTY_STAFF_MEMBERSHIP, STAFF_ROLES,
  staffEntitlement, staffInvitationPending, staffLandingTab, staffMembershipFromRpc,
} from '../src/lib/staffRoles.js';

const APP = 'https://toolkits.example.com';
const TOKEN = 'abc123hashedtoken';

// ── The link ────────────────────────────────────────────────────────────────

test('build → parse round-trips every supported token type', () => {
  for (const type of INVITE_TOKEN_TYPES) {
    const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type });
    assert.ok(url, `${type} must produce a url`);
    const hash = url.slice(url.indexOf('#'));
    assert.deepEqual(parseInviteHash(hash), { token: TOKEN, type },
      `${type}: the browser must read back exactly what the server wrote`);
  }
});

test('the token rides in the FRAGMENT, never the query string', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const [beforeHash] = url.split('#');
  assert.ok(!beforeHash.includes(TOKEN),
    'a token in the path or query reaches Vercel access logs and Referer headers; '
    + 'a fragment is never transmitted to a server');
  assert.equal(beforeHash, `${APP}${STAFF_INVITE_PATH}`);
});

test('the link is first-party — it never points at Supabase /auth/v1/verify', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  assert.ok(!/auth\/v1\/verify/.test(url),
    'that URL consumes the one-time token on GET, so a mail scanner that follows '
    + 'links burns the invitation before the human clicks it');
  assert.ok(url.startsWith(APP));
});

test('buildInviteUrl refuses anything it cannot make a real link from', () => {
  assert.equal(buildInviteUrl({ appUrl: '', tokenHash: TOKEN, type: 'invite' }), null);
  assert.equal(buildInviteUrl({ appUrl: APP, tokenHash: '', type: 'invite' }), null);
  assert.equal(buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'recovery' }), null,
    'recovery is not an invitation type — minting one would issue the wrong credential');
  assert.equal(buildInviteUrl({ appUrl: 'toolkits.example.com', tokenHash: TOKEN, type: 'invite' }), null,
    'a scheme-less origin would produce a relative link that goes nowhere from an email');
});

test('parseInviteHash rejects an unknown type instead of defaulting one', () => {
  // The type is handed straight to verifyOtp. Defaulting it would let a crafted
  // URL steer the callback into exchanging a token as something it was not issued for.
  assert.equal(parseInviteHash('#invite=tok&t=recovery'), null);
  assert.equal(parseInviteHash('#invite=tok&t=email_change'), null);
  assert.equal(parseInviteHash('#invite=tok'), null, 'a missing type is not an assumption to make');
  assert.equal(parseInviteHash('#t=invite'), null);
  assert.equal(parseInviteHash(''), null);
  assert.equal(parseInviteHash('#access_token=xyz'), null, 'a Supabase implicit-flow hash is not ours');
});

test('parseInviteHash tolerates the leading # being present or absent', () => {
  const want = { token: 'tok', type: 'invite' };
  assert.deepEqual(parseInviteHash('#invite=tok&t=invite'), want);
  assert.deepEqual(parseInviteHash('invite=tok&t=invite'), want);
});

test('a token containing URL-significant characters survives the round trip', () => {
  const gnarly = 'a+b/c=d&e#f';
  const url = buildInviteUrl({ appUrl: APP, tokenHash: gnarly, type: 'invite' });
  const parsed = parseInviteHash(url.slice(url.indexOf('#')));
  assert.equal(parsed.token, gnarly, 'an unencoded + or & would silently truncate the token');
});

test('a trailing slash on APP_URL does not produce a double slash', () => {
  const url = buildInviteUrl({ appUrl: `${APP}/`, tokenHash: TOKEN, type: 'invite' });
  assert.ok(url.startsWith(`${APP}${STAFF_INVITE_PATH}`), url);
});

// ── The invitation email ────────────────────────────────────────────────────

const ROLES = STAFF_ROLES.map((r) => r.key);

test('every role produces an email naming that role in the subject, HTML and text', () => {
  for (const roleKey of ROLES) {
    const label = STAFF_ROLES.find((r) => r.key === roleKey).label;
    const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
    const { subject, html, text } = staffInviteEmail({ roleKey, actionUrl: url });

    assert.ok(subject.includes(label),
      `subject must name the role — "You've been invited" is what the Supabase default said, `
      + 'and it is indistinguishable from phishing');
    assert.ok(html.includes(label), `${roleKey}: HTML must name the role`);
    assert.ok(text.includes(label), `${roleKey}: the PLAIN TEXT part must name it too — a reader `
      + 'whose client shows text/plain must not get a worse message');
  }
});

test('both parts carry the link, and the text part is not just stripped HTML', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html, text } = staffInviteEmail({ roleKey: 'trainer', actionUrl: url });

  // ★ The href is ENTITY-ENCODED, and that is correct, not a bug. The link
  //   contains `&t=invite`, and a bare `&` inside an attribute is malformed HTML;
  //   esc() writes `&amp;`, which every mail client decodes back before
  //   navigating. Asserting the raw URL here would be asserting broken markup —
  //   and "fixing" the escaping to satisfy it would be a real XSS regression,
  //   since the same esc() is what neutralises a hostile display name.
  assert.ok(html.includes(`href="${esc(url)}"`), 'the HTML CTA must carry the escaped link');
  assert.equal(esc(url).replace(/&amp;/g, '&'), url, 'and it must decode back to exactly the link');

  assert.ok(text.includes(url), 'the text part must carry the link verbatim — nothing decodes it there');
  assert.ok(!/<[a-z]/i.test(text), 'the plain-text part must contain no markup');
  assert.ok(text.trim().length > 200, 'a two-line text part is a spam signal in its own right');
});

test('the email states there is nothing to buy', () => {
  // The whole incident: a staff member was shown a ₱1,499 pricing page. The
  // message that gets them there should say plainly that it is not a purchase.
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  for (const roleKey of ROLES) {
    const { html, text } = staffInviteEmail({ roleKey, actionUrl: url });
    for (const [name, body] of [['html', html], ['text', text]]) {
      assert.match(body, /nothing to buy/i, `${roleKey} ${name}`);
      assert.match(body, /not be asked to choose a plan/i, `${roleKey} ${name}`);
    }
  }
});

test('the expiry claim matches the pinned TTL in both parts', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html, text } = staffInviteEmail({ roleKey: 'trainer', actionUrl: url });
  assert.ok(html.includes(`${INVITE_LINK_TTL_HOURS} hours`));
  assert.ok(text.includes(`${INVITE_LINK_TTL_HOURS} hours`));
});

test('INVITE_LINK_TTL_HOURS is pinned, because it mirrors a Supabase setting', () => {
  // GoTrue does not expose mailer_otp_exp to a server function, so this constant
  // is a hand-kept mirror. Pinning it means a change has to be deliberate and
  // reviewed alongside the dashboard change — see AUTH_SETUP.md.
  assert.equal(INVITE_LINK_TTL_HOURS, 24);
});

test('the security note tells the reader what to do if it was not expected', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html, text } = staffInviteEmail({ roleKey: 'trainer', actionUrl: url });
  assert.match(html, /not expecting this invitation/i);
  assert.match(text, /not expecting this invitation/i);
});

test('a resent invitation says so, and does not claim to be the first one', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'magiclink' });
  const first = staffInviteEmail({ roleKey: 'trainer', actionUrl: url });
  const again = staffInviteEmail({ roleKey: 'trainer', actionUrl: url, resent: true });
  assert.notEqual(first.subject, again.subject);
  assert.match(again.html, /fresh link/i);
  assert.match(again.text, /fresh link/i);
});

// ── Escaping ────────────────────────────────────────────────────────────────

test('a hostile name cannot inject markup into the invitation', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const evil = '<script>alert(1)</script>';
  const { html } = staffInviteEmail({
    roleKey: 'trainer', actionUrl: url, inviteeName: evil, inviterName: evil,
  });
  assert.ok(!html.includes('<script>'), 'raw markup from a name reached the body');
  assert.ok(html.includes('&lt;script&gt;'), 'the name should appear, escaped');
});

test('esc covers every character that can break out of an attribute or a tag', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('an unknown role key degrades to a neutral label rather than echoing input', () => {
  // api/admin/staff.js validates the key first, so this is defence in depth — but
  // if it ever slipped through, the reader must not be shown raw request text.
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html, subject } = staffInviteEmail({ roleKey: '<b>root</b>', actionUrl: url });
  assert.ok(!html.includes('<b>root</b>'));
  assert.ok(subject.includes('Team member'));
});

// ── The role-assigned notification ──────────────────────────────────────────

test('the existing-account notification carries NO token and no invitation link', () => {
  // That account already has a password. Minting a one-time credential for it
  // would be issuing a sign-in link nobody asked for.
  const { html, text } = staffRoleAssignedEmail({ roleKey: 'operations_admin', appUrl: APP });
  assert.ok(!html.includes('#invite='), 'a promotion must not carry an invitation token');
  assert.ok(!text.includes('#invite='));
  assert.match(html, /password you already use/i);
});

test('the notification reassures that existing membership is untouched', () => {
  const { html, text } = staffRoleAssignedEmail({ roleKey: 'trainer', appUrl: APP });
  for (const body of [html, text]) {
    assert.match(body, /course progress|membership/i);
  }
});

// ── plainText builder ───────────────────────────────────────────────────────

test('plainText drops empties and never emits a run of blank lines', () => {
  const out = plainText(['one', null, '', 'two', { rule: true }, { bullet: 'a' }]);
  assert.ok(!/\n{3,}/.test(out), 'ragged blank runs read as a broken message');
  assert.ok(out.includes('  * a'));
  assert.ok(out.endsWith('\n'));
});

// ── The membership descriptor cannot authorize ──────────────────────────────

test('staffMembershipFromRpc NEVER produces a permissions field', () => {
  // This is the structural guarantee that a pending invitation cannot become
  // authority: there is no field to read, so there is no boolean to invert.
  const m = staffMembershipFromRpc({
    membership: { exists: true, status: 'invited', role_key: 'super_admin', role_label: 'Super Admin' },
    permissions: ['staff.manage'],
    is_staff: true,
  });
  assert.equal(m.status, 'invited');
  assert.equal(m.roleKey, 'super_admin');
  assert.ok(!('permissions' in m), 'the descriptive membership must carry no permission list');
  assert.ok(!('isSuperAdmin' in m), 'nor a super-admin flag');
});

test('a missing or pre-#49 membership block degrades to "no membership"', () => {
  assert.deepEqual(staffMembershipFromRpc(null), EMPTY_STAFF_MEMBERSHIP);
  assert.deepEqual(staffMembershipFromRpc({ is_staff: false }), EMPTY_STAFF_MEMBERSHIP,
    'a pre-#49 server has no membership block; showing an invitation screen then '
    + 'would strand someone on a database that cannot accept one');
  assert.deepEqual(staffMembershipFromRpc({ membership: { exists: false } }), EMPTY_STAFF_MEMBERSHIP);
  assert.deepEqual(staffMembershipFromRpc({ membership: { exists: true, status: 'invited' } }),
    EMPTY_STAFF_MEMBERSHIP, 'a membership with no role is not renderable');
});

test('staffInvitationPending is true only for invited', () => {
  const of = (status) => staffMembershipFromRpc({
    membership: { exists: true, status, role_key: 'trainer', role_label: 'Trainer' },
  });
  assert.equal(staffInvitationPending(of('invited')), true);
  for (const s of ['active', 'suspended', 'revoked']) {
    assert.equal(staffInvitationPending(of(s)), false, `${s} must not offer acceptance`);
  }
  assert.equal(staffInvitationPending(EMPTY_STAFF_MEMBERSHIP), false);
  assert.equal(staffInvitationPending(null), false);
});

// ── Landing ─────────────────────────────────────────────────────────────────

const ctx = (roleKey, permissions, status = 'active') => ({
  isStaff: true, status, roleKey, permissions,
  isSuperAdmin: roleKey === 'super_admin',
});

test('every role lands somewhere it may actually open — and never on pricing', () => {
  assert.equal(staffLandingTab(ctx('super_admin', ['staff.manage'])), 'staffroles');
  assert.equal(staffLandingTab(ctx('operations_admin', ['enrollments.review'])), 'enrollments');
  assert.equal(staffLandingTab(ctx('trainer', ['courses.create'])), 'qbomastery');
});

test('an Ops Admin without the enrollments queue falls to the next one they hold', () => {
  assert.equal(staffLandingTab(ctx('operations_admin', ['batches.manage'])), 'batches');
  assert.equal(staffLandingTab(ctx('operations_admin', ['students.import'])), 'studentimports');
});

test('a role with no landing surface still gets the app, not a refusal', () => {
  assert.equal(staffLandingTab(ctx('operations_admin', [])), 'dashboard');
});

test('a non-active membership has no landing at all', () => {
  for (const s of ['invited', 'suspended', 'revoked']) {
    assert.equal(staffLandingTab(ctx('operations_admin', ['enrollments.review'], s)), null,
      `${s}: landing is decided after acceptance, never from the invitation itself`);
  }
  assert.equal(staffLandingTab(null), null);
});

// ── The branch that was actually wrong ──────────────────────────────────────

test('a brand-new address is invited, and stays invited', () => {
  const b = inviteBranchFor(null);
  assert.equal(b.action, 'invite');
  assert.equal(b.tokenType, 'invite');
  assert.equal(b.status, 'invited');
});

test('an UNCONFIRMED existing account is re-invited — never promoted', () => {
  // ★ THE BUG. The old handler asked only whether an Auth user existed, so
  //   re-inviting someone who had been invited but had not yet accepted took the
  //   promote branch and flipped them to ACTIVE with no acceptance and no email.
  const b = inviteBranchFor({ id: 'u1', confirmed: false });
  assert.equal(b.action, 'reinvite');
  assert.equal(b.status, 'invited', 'an account that exists is not an account that is proven');
  assert.equal(b.tokenType, 'magiclink',
    "generateLink('invite') refuses an existing address, and verifying a magiclink "
    + 'also confirms the mailbox — which is what accept_staff_invitation() requires');
});

test('a CONFIRMED existing account is promoted, with no token minted', () => {
  const b = inviteBranchFor({ id: 'u1', confirmed: true });
  assert.equal(b.action, 'promote');
  assert.equal(b.status, 'active');
  assert.equal(b.tokenType, null,
    'they already have a password; minting one would be an unrequested sign-in link');
});

test('only the confirmed branch grants anything', () => {
  const granting = [null, { id: 'u', confirmed: false }, { id: 'u', confirmed: true }]
    .map(inviteBranchFor)
    .filter((b) => b.status === 'active');
  assert.equal(granting.length, 1, 'exactly one of the three branches may produce an active row');
});

test('every branch that mints a token uses a supported type', () => {
  for (const existing of [null, { id: 'u', confirmed: false }, { id: 'u', confirmed: true }]) {
    const b = inviteBranchFor(existing);
    if (b.tokenType !== null) {
      assert.ok(INVITE_TOKEN_TYPES.includes(b.tokenType), `${b.action} minted ${b.tokenType}`);
    }
  }
});

// ── "Bypass payment" is not "get everything" ────────────────────────────────

test('a staff member with NO plan gets role tools only, not the whole toolkit', () => {
  // ★ The trap #49 introduced and review caught. The root used to compute the base
  //   as `enroll.active ? planEntitlement(...) : FULL_ENTITLEMENT`, and #49 makes
  //   enroll.active FALSE for every active staff member — so the base became FULL,
  //   and staffEntitlement() returns a full base unchanged. The union would have
  //   silently become a replacement.
  const trainer = ctx('trainer', ['courses.create', 'courses.manage_assigned']);
  const ent = staffEntitlement(trainer, null);

  assert.equal(ent.full, false, 'a Trainer must never resolve to full access');
  assert.equal(ent.allowsTab('qbomastery'), true, 'they do get the course catalogs');
  assert.equal(ent.allowsTab('dashboard'), true);
  for (const paid of ['bankfeed', 'statementconverter', 'invoice', 'proposal']) {
    assert.equal(ent.allowsTab(paid), false,
      `${paid} is paid student content — authoring courses does not buy it`);
  }
  assert.equal(ent.allowsTab('enrollments'), false, 'nor an admin queue they do not hold');
});

test('a FULL base is still returned unchanged — a paying staff member keeps their plan', () => {
  const trainer = ctx('trainer', ['courses.create']);
  const full = { full: true, allowsTab: () => true, allowsStage: () => true, allowsCourse: () => true };
  assert.equal(staffEntitlement(trainer, full), full,
    'an Ops Admin who also bought VIP keeps every VIP tab');
});

test('an Ops Admin with no plan gets their queues and nothing else', () => {
  const ops = ctx('operations_admin', ['enrollments.review', 'batches.manage']);
  const ent = staffEntitlement(ops, null);
  assert.equal(ent.full, false);
  assert.equal(ent.allowsTab('enrollments'), true);
  assert.equal(ent.allowsTab('batches'), true);
  assert.equal(ent.allowsTab('qbomastery'), false, 'they are not a course author');
  assert.equal(ent.allowsTab('bankfeed'), false, 'and they did not buy the toolkit');
});

test('a non-staff context passes the base straight through', () => {
  const plain = { isStaff: false, status: null, permissions: [] };
  const base = { full: false, allowsTab: () => false };
  assert.equal(staffEntitlement(plain, base), base);
});

// ── The rebuilt shell (#50): a real email document, not a floating div ──────
// The #49 shell had no doctype, no table layout, no preheader, no lang, no
// responsive rules and nowhere for a support address — Outlook rendered it in
// quirks mode and the inbox preview showed the first body sentence.

test('the invitation renders as a full HTML document', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html } = staffInviteEmail({ roleKey: 'operations_admin', actionUrl: url });
  assert.match(html, /^<!doctype html>/i, 'no doctype means quirks mode in Outlook');
  assert.match(html, /<html lang="en"/, 'a lang attribute for screen readers');
  assert.match(html, /name="color-scheme" content="light dark"/, 'dark-mode clients must not invert the card');
  assert.match(html, /role="presentation"/, 'layout tables must be presentation, not data');
  assert.match(html, /@media only screen and \(max-width: 600px\)/, 'the responsive narrow-screen rules');
});

test('the preheader carries the no-payment promise into the inbox preview', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html } = staffInviteEmail({ roleKey: 'trainer', actionUrl: url });
  assert.match(html, /display:none;max-height:0;overflow:hidden/, 'hidden in the body');
  assert.match(html, /nothing to buy, no plan to choose/, 'the preview is the first thing read');
});

test('the CTA is a table button whose href is the exact invitation URL', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const { html } = staffInviteEmail({ roleKey: 'operations_admin', actionUrl: url });
  assert.ok(html.includes(`href="${esc(url)}"`), 'the URL, verbatim after entity-escaping');
  // The button must sit in its own table cell — a padded <a> alone dies in Outlook.
  const ctaIdx = html.indexOf(`href="${esc(url)}"`);
  const before = html.slice(Math.max(0, ctaIdx - 300), ctaIdx);
  assert.match(before, /<table role="presentation"[^>]*>/, 'bulletproof table CTA');
});

test('a support address is rendered as a reachable mailto in HTML and named in text', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const msg = staffInviteEmail({
    roleKey: 'operations_admin', actionUrl: url, supportEmail: 'support@toolkits.example.com',
  });
  assert.match(msg.html, /mailto:support@toolkits\.example\.com/);
  assert.match(msg.text, /support@toolkits\.example\.com/);
});

test('no support address means the contact line is omitted, never invented', () => {
  const url = buildInviteUrl({ appUrl: APP, tokenHash: TOKEN, type: 'invite' });
  const msg = staffInviteEmail({ roleKey: 'operations_admin', actionUrl: url });
  assert.ok(!/mailto:/.test(msg.html), 'no fabricated address');
  assert.ok(!/Questions\? Contact our team at/.test(msg.text));
});

test('the promote notification gets the same support plumbing and still no token', () => {
  const msg = staffRoleAssignedEmail({
    roleKey: 'trainer', appUrl: APP, supportEmail: 'help@toolkits.example.com',
  });
  assert.match(msg.html, /mailto:help@toolkits\.example\.com/);
  assert.ok(!msg.html.includes('#invite='), 'a promotion mints no credential');
  assert.ok(!msg.text.includes('#invite='));
});

// ── From / Reply-To (#50) ───────────────────────────────────────────────────

test('a bare From address gains the brand display name', () => {
  assert.equal(displayFrom('noreply@toolkits.example.com'), `${BRAND} <noreply@toolkits.example.com>`);
});

test('a From that already carries a display name passes through untouched', () => {
  assert.equal(displayFrom('Alex <alex@toolkits.example.com>'), 'Alex <alex@toolkits.example.com>');
  assert.equal(displayFrom(''), '');
});

test('sendEmail posts reply_to and the display-name From to Resend', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.RESEND_API_KEY;
  const oldFrom = process.env.RESEND_FROM;
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM = 'noreply@toolkits.example.com';
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) };
  };
  try {
    const out = await sendEmail({
      to: 'invitee@example.com', subject: 's', html: '<p>h</p>', text: 't',
      replyTo: 'support@toolkits.example.com', tag: 'staff-invite',
    });
    assert.equal(out.ok, true);
    assert.equal(captured.body.reply_to, 'support@toolkits.example.com');
    assert.equal(captured.body.from, `${BRAND} <noreply@toolkits.example.com>`);
    assert.equal(captured.body.text, 't', 'the plain-text part still rides along');
    assert.ok(captured.headers['Idempotency-Key'], 'one key per logical send');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = oldFrom;
  }
});

test('omitting replyTo omits the field — Resend must not see reply_to: undefined', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.RESEND_API_KEY;
  const oldFrom = process.env.RESEND_FROM;
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM = 'noreply@toolkits.example.com';
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ id: 'msg_2' }) };
  };
  try {
    await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' });
    assert.ok(!('reply_to' in captured));
    assert.ok(!('headers' in captured));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = oldFrom;
  }
});
