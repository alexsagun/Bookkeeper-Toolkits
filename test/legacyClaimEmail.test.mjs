// test/legacyClaimEmail.test.mjs — what a migrated student, and the admin, are told (#67).
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_LINK_TTL_HOURS, MIGRATION_SENDER_ADDRESS, firstNameOf, legacyMembershipEmail, manilaDateOf,
  onboardedAdminEmail, onboardedStudentEmail, programLabel,
} from '../api/_lib/legacyClaimEmail.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const NOW = Date.UTC(2026, 8, 25, 4, 0, 0);
const base = {
  kind: 'claim',
  actionUrl: 'https://toolkits.example.test/activate-account#claim=TOKEN123&t=magiclink',
  fullName: 'Ana Maria Cruz', email: 'ana.cruz@example.test',
  planName: 'Personalized Coaching Program', planKey: 'vip',
  batchName: 'October 2026', startDate: '2026-10-12', endDate: '2027-04-12',
  supportEmail: 'support@example.test', nowMs: NOW,
};

test('every migration email is sent from support@alexsagun.com unless overridden', () => {
  assert.equal(MIGRATION_SENDER_ADDRESS, 'support@alexsagun.com');
  const api = read('api/admin/student-imports.js');
  assert.match(api, /from: migrationSender\(\),\n\s+idempotencyKey: `legacy-claim-/, 'the activation email names the migration sender');
  assert.match(api, /return env \|\| MIGRATION_SENDER_ADDRESS;/);
  const notify = read('api/notify-enrollment.js');
  assert.match(notify, /String\(process\.env\.MIGRATION_EMAIL_FROM \|\| ''\)\.trim\(\) \|\| MIGRATION_SENDER_ADDRESS/);
  assert.match(notify, /from: sender, replyTo: support,/, 'both onboarding emails come from, and are answered at, the sender');
});

test('the activation email follows the owner\'s wording and lists every account detail', () => {
  const m = legacyMembershipEmail(base);
  assert.match(m.subject, /Your learning account has moved/);
  for (const part of [m.html, m.text]) {
    assert.match(part, /Hello Ana,/);
    assert.match(part, /Your learning account has successfully been migrated to our new platform\./);
    assert.match(part, /Ana Maria Cruz/);
    assert.match(part, /ana\.cruz@example\.test/);
    assert.match(part, /October 2026/);
    assert.match(part, /Personalized Coaching Program \(VIP\)/);
    assert.match(part, /October 12, 2026/);
    assert.match(part, /April 12, 2027/);
    assert.match(part, /create your password and activate your account/);
    assert.match(part, /already paid/);
    assert.match(part, /nothing to buy/);
  }
  assert.match(m.text, /Regards,\nSupport Team\nsupport@example\.test/);
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

test('support is a reply-able address in both parts, defaulting to the migration sender', () => {
  const m = legacyMembershipEmail(base);
  assert.ok(m.html.includes('mailto:support@example.test'));
  assert.match(m.text, /support@example\.test/);
  const dflt = legacyMembershipEmail({ ...base, supportEmail: null });
  assert.ok(dflt.html.includes('mailto:support@alexsagun.com'));
  assert.match(dflt.text, /support@alexsagun\.com/);
});

test('a hostile name is escaped and an email is never used as a greeting', () => {
  const m = legacyMembershipEmail({ ...base, fullName: '<img src=x onerror=alert(1)>' });
  assert.ok(!m.html.includes('<img src=x'));
  assert.equal(firstNameOf('someone@example.test'), null);
  assert.match(legacyMembershipEmail({ ...base, fullName: null }).text, /^Hello,/);
});

test('the program label only adds (VIP) to the VIP plan', () => {
  assert.equal(programLabel('Personalized Coaching Program', 'vip'), 'Personalized Coaching Program (VIP)');
  assert.equal(programLabel('Sampler Session', 'sampler'), 'Sampler Session');
  assert.equal(programLabel('VIP Program', 'vip'), 'VIP Program');
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
    assert.match(part, /Personalized Coaching Program \(VIP\)/);
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
