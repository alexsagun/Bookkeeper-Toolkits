// test/legacyClaimEmail.test.mjs — what a migrated student, and the admin, are told (#67, #68),
// and who it is from. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_LINK_TTL_HOURS, MIGRATION_SUPPORT_ADDRESS, addressDomain, bareAddress, firstNameOf, isAddress,
  legacyMembershipEmail, manilaDateOf, migrationAddresses, onboardedAdminEmail, onboardedStudentEmail,
} from '../api/_lib/legacyClaimEmail.js';
import * as claimEmail from '../api/_lib/legacyClaimEmail.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
// Code only: a comment that explains a rule must not satisfy (or fail) a scan for it.
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const NOW = Date.UTC(2026, 8, 25, 4, 0, 0);
const base = {
  kind: 'claim',
  actionUrl: 'https://toolkits.example.test/activate-account#claim=TOKEN123&t=magiclink',
  fullName: 'Ana Maria Cruz', email: 'ana.cruz@example.test',
  planName: 'VIP Package', planKey: 'vip',
  batchName: 'October 2026', startDate: '2026-10-12', endDate: '2027-04-12',
  supportEmail: 'support@example.test', nowMs: NOW,
};
// A Silver or Essentials membership: no cohort seat, so begin_invite returns no batch.
const selfPaced = { ...base, planName: 'Essentials', planKey: 'sampler', batchName: null };

// ── Who a migration email is from, and where replies go (#68) ──────────────────────────

test('the support mailbox is support@alexsagun.com', () => {
  assert.equal(MIGRATION_SUPPORT_ADDRESS, 'support@alexsagun.com');
});

test('by default the From is support@ on RESEND_FROM\'s own domain, and replies go to support@alexsagun.com', () => {
  const a = migrationAddresses({ resendFrom: 'Toolkits by Alex <noreply@toolkits.alexsagun.com>' });
  assert.equal(a.from, 'Toolkits by Alex Support <support@toolkits.alexsagun.com>');
  assert.equal(a.fromDomain, 'toolkits.alexsagun.com');
  assert.equal(addressDomain(a.from), addressDomain('Toolkits by Alex <noreply@toolkits.alexsagun.com>'),
    'the From domain is RESEND_FROM\'s — the domain every other flow already proves');
  assert.equal(a.replyTo, 'support@alexsagun.com');
  // A bare RESEND_FROM works the same, and the domain is compared case-insensitively.
  const bare = migrationAddresses({ resendFrom: 'NoReply@Toolkits.AlexSagun.com' });
  assert.equal(bare.from, 'Toolkits by Alex Support <support@toolkits.alexsagun.com>');
});

test('an overridden From does not move the Reply-To', () => {
  const a = migrationAddresses({
    migrationFrom: 'Alex Sagun Support <support@alexsagun.com>',
    resendFrom: 'Toolkits by Alex <noreply@toolkits.alexsagun.com>',
  });
  assert.equal(a.from, 'Alex Sagun Support <support@alexsagun.com>', 'MIGRATION_EMAIL_FROM is used as given');
  assert.equal(a.fromDomain, 'alexsagun.com');
  assert.equal(a.replyTo, 'support@alexsagun.com');
  // …and pointing the sender at a subdomain (the env-only "fix" for #67's 403) leaves the
  // replies at the monitored mailbox, not at a subdomain with no inbox.
  const sub = migrationAddresses({ migrationFrom: 'support@toolkits.alexsagun.com', resendFrom: '' });
  assert.equal(sub.from, 'support@toolkits.alexsagun.com');
  assert.equal(sub.replyTo, 'support@alexsagun.com');
});

test('MIGRATION_REPLY_TO moves only the Reply-To, and a display name is stripped', () => {
  const a = migrationAddresses({ resendFrom: 'noreply@example.test', replyTo: 'Help Desk <help@example.org>' });
  assert.equal(a.replyTo, 'help@example.org');
  assert.equal(a.from, 'Toolkits by Alex Support <support@example.test>', 'the From is untouched');
  assert.equal(migrationAddresses({ resendFrom: 'noreply@example.test', replyTo: '   ' }).replyTo, 'support@alexsagun.com');
  assert.equal(migrationAddresses({ resendFrom: 'noreply@example.test', replyTo: '<>' }).replyTo, 'support@alexsagun.com');
});

test('with no override and no usable RESEND_FROM there is no sender — never a guess', () => {
  for (const resendFrom of [undefined, null, '', 'noreply', 'Toolkits <noreply@>', 'x@localhost']) {
    const a = migrationAddresses({ resendFrom });
    assert.equal(a.from, null, `resendFrom=${JSON.stringify(resendFrom)}`);
    assert.equal(a.fromDomain, null);
    assert.equal(a.replyTo, 'support@alexsagun.com');
  }
});

test('the address helpers', () => {
  assert.equal(bareAddress('Name <a@b.test>'), 'a@b.test');
  assert.equal(bareAddress('  a@b.test '), 'a@b.test');
  assert.equal(addressDomain('Name <a@Sub.Example.COM>'), 'sub.example.com');
  assert.equal(addressDomain('nope'), null);
  assert.ok(isAddress('Name <a@b.test>'));
  assert.ok(!isAddress('not an address'));
  assert.ok(!isAddress(''));
});

test('both endpoints take their addresses from the one helper; the old coupled sender is gone', () => {
  assert.equal(claimEmail.MIGRATION_SENDER_ADDRESS, undefined, 'the From is no longer a hard-coded address');
  assert.equal(claimEmail.programLabel, undefined, 'no plan-key special case in the templates');
  const api = code(read('api/admin/student-imports.js'));
  assert.match(api, /migrationAddresses\(\{\s*migrationFrom: process\.env\.MIGRATION_EMAIL_FROM,\s*resendFrom: process\.env\.RESEND_FROM,\s*replyTo: process\.env\.MIGRATION_REPLY_TO,\s*\}\)/);
  assert.match(api, /replyTo: ctx\.replyTo,\n\s+from: ctx\.from,\n\s+idempotencyKey: `legacy-claim-/, 'the activation email: From and Reply-To from the helper');
  assert.match(api, /replyTo: ready\.replyTo, from: ready\.from, tag: 'student-imports-test'/, 'the test email too');
  assert.ok(!/migrationSender|migrationSupportAddress|MIGRATION_SENDER_ADDRESS/.test(api));
  const notify = code(read('api/notify-enrollment.js'));
  assert.match(notify, /migrationAddresses\(\{\s*migrationFrom: process\.env\.MIGRATION_EMAIL_FROM,\s*resendFrom: process\.env\.RESEND_FROM,\s*replyTo: process\.env\.MIGRATION_REPLY_TO,\s*\}\)/);
  assert.match(notify, /from: addr\.from, replyTo: addr\.replyTo,/, 'both onboarding emails');
  assert.ok(!/fromAddress\(sender\)|MIGRATION_SENDER_ADDRESS/.test(notify));
});

// ── What each message says ────────────────────────────────────────────────────────────

test('the activation email follows the owner\'s wording and lists every account detail', () => {
  const m = legacyMembershipEmail(base);
  assert.match(m.subject, /Your learning account has moved/);
  for (const part of [m.html, m.text]) {
    assert.match(part, /Hello Ana,/);
    assert.match(part, /Your learning account has successfully been migrated to our new platform\./);
    assert.match(part, /Ana Maria Cruz/);
    assert.match(part, /ana\.cruz@example\.test/);
    assert.match(part, /October 2026/);
    assert.match(part, /Package/);
    assert.match(part, /VIP Package/);
    assert.match(part, /October 12, 2026/);
    assert.match(part, /April 12, 2027/);
    assert.match(part, /create your password and activate your account/);
    assert.match(part, /already paid/);
    assert.match(part, /nothing to buy/);
  }
});

test('the package is printed exactly as the catalog names it — no plan-key suffix, under "Package"', () => {
  const vip = legacyMembershipEmail(base);
  assert.match(vip.text, /\* Package: VIP Package\n/);
  assert.ok(!/\(VIP\)|Membership plan/.test(vip.html + vip.text));
  const silver = legacyMembershipEmail({ ...selfPaced, planName: 'Silver · Self-Paced', planKey: 'silver_self_paced' });
  assert.match(silver.text, /\* Package: Silver · Self-Paced\n/);
  assert.ok(silver.html.includes('Silver · Self-Paced'));
  const ess = legacyMembershipEmail(selfPaced);
  assert.match(ess.text, /\* Package: Essentials\n/);
  // The key never decides the wording: the same name reads the same under any key.
  assert.equal(legacyMembershipEmail({ ...base, planKey: 'sampler' }).text, vip.text);
  const admin = onboardedAdminEmail({ ...base, onboardedAt: '2026-09-26T03:00:00+00:00' });
  assert.match(admin.text, /\* Package: VIP Package\n/);
  assert.ok(!/\(VIP\)|Membership:/.test(admin.html + admin.text));
  const student = onboardedStudentEmail({ ...selfPaced, status: 'active' });
  assert.match(student.text, /\* Package: Essentials\n/);
});

test('a batch community is promised only when there is a batch', () => {
  const later = { nowMs: Date.UTC(2026, 9, 1) };   // before the October 12 start
  const vip = legacyMembershipEmail({ ...base, ...later });
  for (const part of [vip.html, vip.text]) assert.match(part, /your courses and your batch community unlock on that date/);
  const ess = legacyMembershipEmail({ ...selfPaced, ...later });
  for (const part of [ess.html, ess.text]) {
    assert.match(part, /your courses and the member community unlock on that date/);
    assert.ok(!/batch community/.test(part), 'no cohort is promised to a self-paced student');
  }
  assert.ok(!ess.html.includes('>Batch<'), 'the Batch row is dropped, not printed empty');
  assert.ok(!/\* Batch:/.test(ess.text));

  const active = onboardedStudentEmail({ ...base, status: 'active' });
  for (const part of [active.html, active.text]) assert.match(part, /your dashboard, your courses and your batch community\./);
  const activeSelf = onboardedStudentEmail({ ...selfPaced, status: 'active' });
  for (const part of [activeSelf.html, activeSelf.text]) {
    assert.match(part, /your dashboard, your courses and the member community\./);
    assert.ok(!/batch community/.test(part));
  }
  const sched = onboardedStudentEmail({ ...base, status: 'scheduled' });
  assert.match(sched.text, /Your courses and your batch community open on October 12, 2026/);
  const schedSelf = onboardedStudentEmail({ ...selfPaced, status: 'scheduled' });
  assert.match(schedSelf.text, /Your courses and the member community open on October 12, 2026/);
});

test('before the start date it says when access opens', () => {
  const m = legacyMembershipEmail(base);
  assert.match(m.text, /Your access opens on October 12, 2026/);
  const later = legacyMembershipEmail({ ...base, nowMs: Date.UTC(2026, 9, 20) });
  assert.match(later.text, /Your access is open now/);
});

test('the link appears in both parts and its lifetime is stated', () => {
  const m = legacyMembershipEmail(base);
  assert.ok(m.html.includes('href="https://toolkits.example.test/activate-account#claim=TOKEN123&amp;t=magiclink"'));
  assert.ok(m.text.includes(base.actionUrl));
  assert.match(m.text, new RegExp(`expires in ${CLAIM_LINK_TTL_HOURS} hours`));
  assert.match(m.text, /most recent email/);
});

test('an existing account gets a sign-in notification with no token and no password reset', () => {
  const m = legacyMembershipEmail({ ...base, kind: 'notify', actionUrl: 'https://toolkits.example.test/' });
  assert.match(m.subject, /moved to your account/);
  assert.ok(!m.html.includes('claim='));
  assert.ok(!/create your password|Activate my account/i.test(m.html + m.text));
  assert.match(m.text, /Nothing about your login has changed/);
});

test('support is a reply-able address in both parts, defaulting to support@alexsagun.com', () => {
  const m = legacyMembershipEmail(base);
  assert.ok(m.html.includes('mailto:support@example.test'));
  assert.match(m.text, /support@example\.test/);
  const dflt = legacyMembershipEmail({ ...base, supportEmail: null });
  assert.ok(dflt.html.includes('mailto:support@alexsagun.com'));
  assert.match(dflt.text, /support@alexsagun\.com/);
});

// ★ C9: most students read the HTML part, and #67 signed only the plain-text twin.
test('the owner\'s sign-off is in BOTH parts of the student emails, naming the reply-to', () => {
  const claim = legacyMembershipEmail(base);
  const notify = legacyMembershipEmail({ ...base, kind: 'notify', actionUrl: 'https://toolkits.example.test/' });
  const ready = onboardedStudentEmail({ ...base, status: 'active', dashboardUrl: 'https://toolkits.example.test/' });
  for (const m of [claim, notify, ready]) {
    assert.match(m.text, /Regards,\nSupport Team\nsupport@example\.test\n?$/, 'the text part ends with the sign-off');
    assert.match(m.html, /Regards,<br>Support Team<br><a href="mailto:support@example\.test"[^>]*>support@example\.test<\/a>/);
    assert.ok(!m.html.includes('— The Toolkits by Alex team'), 'one signature per message, not two');
    // It closes the card: after the button and the fine print, like the text part.
    assert.ok(m.html.indexOf('Regards,') > m.html.lastIndexOf('Questions? Contact our team'));
  }
  const dflt = legacyMembershipEmail({ ...base, supportEmail: null });
  assert.match(dflt.html, /Regards,<br>Support Team<br><a href="mailto:support@alexsagun\.com"/);
  assert.match(dflt.text, /Regards,\nSupport Team\nsupport@alexsagun\.com/);
});

test('the admin email keeps the team signature and gives its text part the same foot note', () => {
  const m = onboardedAdminEmail({ ...base, onboardedAt: '2026-09-26T03:00:00+00:00' });
  assert.ok(m.html.includes('— The Toolkits by Alex team'));
  assert.ok(!m.html.includes('Regards,'));
  assert.match(m.text, /You receive this once per migrated student/);
});

test('a hostile name is escaped and an email is never used as a greeting', () => {
  const m = legacyMembershipEmail({ ...base, fullName: '<img src=x onerror=alert(1)>' });
  assert.ok(!m.html.includes('<img src=x'));
  assert.equal(firstNameOf('someone@example.test'), null);
  assert.match(legacyMembershipEmail({ ...base, fullName: null }).text, /^Hello,/);
});

test('a hostile reply-to or package name cannot become markup', () => {
  const m = legacyMembershipEmail({ ...base, supportEmail: '"><script>x</script>@evil.test', planName: '<b>Free</b>' });
  assert.ok(!m.html.includes('<script>x'));
  assert.ok(!m.html.includes('<b>Free</b>'));
});

test('the HTML is a complete document with a plain-text twin', () => {
  for (const m of [legacyMembershipEmail(base), onboardedAdminEmail(base), onboardedStudentEmail(base)]) {
    assert.match(m.html, /^<!doctype html>/i);
    assert.ok(m.text.length > 150 && !/<[a-z]/i.test(m.text), 'the text part carries no markup');
  }
});

// ★ A subscription's ends_at is the LAST millisecond of its end date in Manila. Read in UTC
//   it prints the day before; the onboarding emails format it where the student lives.
test('timestamps are read as Manila calendar days', () => {
  assert.equal(manilaDateOf('2027-04-12T15:59:59.999+00:00'), '2027-04-12');
  assert.equal(manilaDateOf('2026-09-25T16:00:00+00:00'), '2026-09-26');
  assert.equal(manilaDateOf('2026-10-12'), '2026-10-12');
  assert.equal(manilaDateOf(null), null);
});

test('the admin is told "Student Successfully Onboarded" with the student\'s details', () => {
  const m = onboardedAdminEmail({ ...base, onboardedAt: '2026-09-26T03:00:00+00:00',
    endDate: '2027-04-12T15:59:59.999+00:00', dashboardUrl: 'https://toolkits.example.test/admin/student-imports' });
  assert.equal(m.subject, 'Student Successfully Onboarded');
  for (const part of [m.html, m.text]) {
    assert.match(part, /Ana Maria Cruz has successfully completed onboarding\./);
    assert.match(part, /ana\.cruz@example\.test/);
    assert.match(part, /October 2026/);
    assert.match(part, /VIP Package/);
    assert.match(part, /September 26, 2026/, 'the activation date');
    assert.match(part, /April 12, 2027/, 'the end date, not the UTC day before');
  }
  assert.ok(m.html.includes('href="https://toolkits.example.test/admin/student-imports"'));
});

test('the student confirmation says the account is ready, how to get in, and who to ask', () => {
  const m = onboardedStudentEmail({ ...base, status: 'active', startDate: '2026-09-25T16:00:00+00:00',
    endDate: '2027-04-12T15:59:59.999+00:00', dashboardUrl: 'https://toolkits.example.test/', supportEmail: null });
  assert.match(m.subject, /account is ready/);
  for (const part of [m.html, m.text]) {
    assert.match(part, /Your account has been created successfully/);
    assert.match(part, /ana\.cruz@example\.test/);
    assert.match(part, /Active/);
    assert.match(part, /April 12, 2027/);
    assert.match(part, /support@alexsagun\.com/);
    assert.match(part, /already paid/);
  }
  assert.ok(m.html.includes('href="https://toolkits.example.test/"'), 'a dashboard link');
  const later = onboardedStudentEmail({ ...base, status: 'scheduled', startDate: '2026-10-12', dashboardUrl: null });
  assert.match(later.text, /open on October 12, 2026/);
});

test('a hostile name is escaped in the admin email too', () => {
  const m = onboardedAdminEmail({ ...base, fullName: '<script>alert(1)</script>' });
  assert.ok(!m.html.includes('<script>alert(1)'));
});
