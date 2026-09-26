// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/legacyClaimEmail.js — the migrated-student messages (#67). PURE.
// ─────────────────────────────────────────────────────────────────────────────
// No env reads, no I/O — test/legacyClaimEmail.test.mjs asserts the rendered bodies.
// api/admin/student-imports.js and api/notify-enrollment.js mint links and send; this
// file only decides what each message says.
//
// ★ EVERY MEMBERSHIP FACT COMES FROM THE DATABASE, NEVER FROM THE REQUEST.
//   legacy_import_begin_invite() and legacy_import_onboarding_notice() return the plan
//   name (enrollment_plans), the batch name (batches) and the dates. The browser never
//   names a plan, a batch, a date or a recipient for any of these emails.
//
// ★ "ALREADY PAID" IS SAID IN SO MANY WORDS. A migrated student who is shown our
//   pricing page — or who merely fears they will be — assumes they are being asked
//   to pay twice. The message tells them there is nothing to buy before they click.
//
// ★ EVERY MIGRATION EMAIL IS SENT FROM, AND ANSWERED AT, support@alexsagun.com (owner
//   requirement, 2026-09-26). MIGRATION_SENDER_ADDRESS is the default; the endpoints let
//   MIGRATION_EMAIL_FROM override it. Its domain must be verified in Resend — the
//   workspace's "Send test email" proves it before any student is emailed.
//
// Four messages:
//   claim            — a new account, or one that never confirmed its email: a single-use
//                      link to create a password (first-party URL, token in the fragment).
//   notify           — an account that already has a password: a plain sign-in link.
//   onboardedAdmin   — to the administrator, once the student has set their password.
//   onboardedStudent — to the student, confirming the account and how to reach it.
// ─────────────────────────────────────────────────────────────────────────────

import { CLAIM_LINK_TTL_HOURS } from '../../src/lib/importClaim.js';
import { formatCalendarDate, manilaTodayISO } from '../../src/lib/legacyMigration.js';
import { BRAND, detailsCard, emailShell, p, plainText } from './email.js';

export { CLAIM_LINK_TTL_HOURS };

/** The sender and reply-to of every migration email. */
export const MIGRATION_SENDER_ADDRESS = 'support@alexsagun.com';

/** First name if usable, else null. Never echoes an email address. */
export function firstNameOf(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first && first.length <= 40 && !first.includes('@') ? first : null;
}

/** "Personalized Coaching Program (VIP)" for the VIP plan; any other plan by its own name. */
export function programLabel(planName, planKey) {
  const name = String(planName || '').trim();
  if (!name) return null;
  return planKey === 'vip' && !/\bvip\b/i.test(name) ? `${name} (VIP)` : name;
}

/**
 * A timestamp (or an ISO date) as the Manila calendar day it falls on, 'YYYY-MM-DD'.
 * A subscription's ends_at is the LAST millisecond of its end date in Manila, so reading
 * it in UTC would print the day before; this reads it where the student lives.
 */
export function manilaDateOf(value) {
  if (!value) return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? manilaTodayISO(ms) : null;
}

const dateText = (v) => {
  const d = manilaDateOf(v);
  return d ? formatCalendarDate(d) : null;
};

function accountRows({ fullName, email, batchName, planName, planKey, startDate, endDate }) {
  return [
    ['Name', String(fullName || '').trim() || null],
    ['Email', String(email || '').trim() || null],
    ['Batch', batchName || null],
    ['Membership plan', programLabel(planName, planKey)],
    ['Subscription start', dateText(startDate)],
    ['Subscription expiry', dateText(endDate)],
  ];
}

/** Is the start still ahead of `nowMs`, reading the date as a Manila calendar day? */
function startsLater(startDate, nowMs) {
  const d = manilaDateOf(startDate);
  if (!d || typeof nowMs !== 'number') return false;
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day) - 8 * 3600 * 1000 > nowMs;
}

// One block, three lines — the owner's sign-off.
const signOff = (supportEmail) => [
  `Regards,\nSupport Team\n${supportEmail || MIGRATION_SENDER_ADDRESS}`,
];

/**
 * The activation email: "your account has moved — create your password".
 * @param {object} o
 * @param {'claim'|'notify'} o.kind
 * @param {string|null} o.actionUrl   claim: the first-party activation URL; notify: sign-in URL
 * @param {string|null} o.fullName
 * @param {string|null} o.email
 * @param {string|null} o.planName
 * @param {string|null} o.planKey
 * @param {string|null} o.batchName
 * @param {string|null} o.startDate  'YYYY-MM-DD'
 * @param {string|null} o.endDate    'YYYY-MM-DD'
 * @param {string|null} o.supportEmail
 * @param {number} o.nowMs
 * @returns {{ subject: string, html: string, text: string }}
 */
export function legacyMembershipEmail(o) {
  const kind = o.kind === 'notify' ? 'notify' : 'claim';
  const first = firstNameOf(o.fullName);
  const greeting = first ? `Hello ${first},` : 'Hello,';
  const rows = accountRows(o);
  const later = startsLater(o.startDate, o.nowMs);
  const startLine = o.startDate
    ? (later
      ? `Your access opens on ${dateText(o.startDate)}. You can set up your account today; your courses and your batch community unlock on that date.`
      : 'Your access is open now.')
    : '';
  const paid = 'Your membership is already paid. There is nothing to buy and no plan to choose, and you will not be asked for a payment.';
  const support = o.supportEmail || MIGRATION_SENDER_ADDRESS;

  const subject = kind === 'claim'
    ? 'Your learning account has moved — activate it now'
    : `Your ${BRAND} membership has moved to your account`;

  const opening = kind === 'claim'
    ? 'Your learning account has successfully been migrated to our new platform.'
    : `We have added your membership to the ${BRAND} account you already use.`;

  const action = kind === 'claim'
    ? 'Click the link below to create your password and activate your account.'
    : 'Sign in with your usual email and password. Nothing about your login has changed.';

  const cta = kind === 'claim'
    ? { href: o.actionUrl, label: 'Activate my account' }
    : { href: o.actionUrl, label: 'Sign in' };

  const footNote = kind === 'claim'
    ? `This link expires in ${CLAIM_LINK_TTL_HOURS} hours and works once. If we send you another one, use the most recent email; the older link stops working. If it has expired, use "Forgot password" on the sign-in page with this email address.`
    : 'If you did not expect this email, you can ignore it; nothing changes unless you sign in.';

  const bodyHtml = [
    p(greeting),
    p(opening),
    detailsCard({ title: 'Your account details', rows }),
    p(paid),
    startLine ? p(startLine) : '',
    p(action),
  ].join('');

  const html = emailShell({
    heading: kind === 'claim' ? 'Your account has moved' : 'Your membership is on your account',
    bodyHtml,
    cta,
    footNote,
    preheader: `${paid.split('.')[0]}.${later ? ` Access opens ${dateText(o.startDate)}.` : ''}`,
    supportEmail: support,
  });

  const text = plainText([
    greeting,
    opening,
    { rule: true },
    'Your account details',
    ...rows.filter(([, v]) => v).map(([k, v]) => ({ bullet: `${k}: ${v}` })),
    { rule: true },
    paid,
    startLine,
    action,
    kind === 'claim' ? `Activate your account: ${o.actionUrl}` : `Sign in: ${o.actionUrl}`,
    footNote,
    `Questions? Reply to this email or write to ${support}.`,
    ...signOff(support),
  ]);

  return { subject, html, text };
}

/**
 * To the administrator once a migrated student has set their password.
 * @param {object} o  fullName, email, batchName, planName, planKey, onboardedAt (timestamp),
 *                    startDate, endDate, dashboardUrl (the admin's Student Imports link)
 */
export function onboardedAdminEmail(o) {
  const name = String(o.fullName || '').trim() || 'A migrated student';
  const rows = [
    ['Student', String(o.fullName || '').trim() || null],
    ['Email', String(o.email || '').trim() || null],
    ['Batch', o.batchName || null],
    ['Membership', programLabel(o.planName, o.planKey)],
    ['Access until', dateText(o.endDate)],
    ['Activation date', dateText(o.onboardedAt)],
  ];
  const line = `${name} has successfully completed onboarding.`;
  const html = emailShell({
    heading: 'Student successfully onboarded',
    bodyHtml: [p(line), detailsCard({ title: 'Student', rows }),
      p('Their migrated membership is active on the account. Nothing further is needed unless the details above are wrong.')].join(''),
    cta: o.dashboardUrl ? { href: o.dashboardUrl, label: 'Open Student Imports' } : null,
    footNote: 'You receive this once per migrated student, when they set their password.',
    preheader: line,
    supportEmail: null,
  });
  const text = plainText([
    line,
    { rule: true },
    ...rows.filter(([, v]) => v).map(([k, v]) => ({ bullet: `${k}: ${v}` })),
    { rule: true },
    o.dashboardUrl ? `Student Imports: ${o.dashboardUrl}` : null,
    `— ${BRAND}`,
  ]);
  return { subject: 'Student Successfully Onboarded', html, text };
}

/**
 * To the student once their account is created: how to get in, what they have, who to ask.
 * @param {object} o  fullName, email, batchName, planName, planKey, startDate, endDate,
 *                    status, dashboardUrl, supportEmail, nowMs
 */
export function onboardedStudentEmail(o) {
  const first = firstNameOf(o.fullName);
  const greeting = first ? `Hello ${first},` : 'Hello,';
  const support = o.supportEmail || MIGRATION_SENDER_ADDRESS;
  const rows = [
    ...accountRows(o),
    ['Subscription status', o.status === 'scheduled' ? `Starts ${dateText(o.startDate)}` : (o.status === 'active' ? 'Active' : null)],
  ];
  const opening = 'Your account has been created successfully, and your migrated membership is on it.';
  const access = o.status === 'scheduled'
    ? `Sign in any time at the link below. Your courses and batch community open on ${dateText(o.startDate)}.`
    : 'Sign in any time at the link below to reach your dashboard, your courses and your batch community.';
  const signIn = `Use ${String(o.email || '').trim() || 'your email address'} and the password you just created.`;
  const html = emailShell({
    heading: 'Your account is ready',
    bodyHtml: [p(greeting), p(opening), detailsCard({ title: 'Your subscription', rows }), p(access), p(signIn),
      p('Your membership is already paid; you will not be asked for a payment.')].join(''),
    cta: o.dashboardUrl ? { href: o.dashboardUrl, label: 'Go to my dashboard' } : null,
    footNote: `Need help? Reply to this email or write to ${support}.`,
    preheader: opening,
    supportEmail: support,
  });
  const text = plainText([
    greeting,
    opening,
    { rule: true },
    'Your subscription',
    ...rows.filter(([, v]) => v).map(([k, v]) => ({ bullet: `${k}: ${v}` })),
    { rule: true },
    access,
    signIn,
    o.dashboardUrl ? `Your dashboard: ${o.dashboardUrl}` : null,
    'Your membership is already paid; you will not be asked for a payment.',
    `Need help? Reply to this email or write to ${support}.`,
    ...signOff(support),
  ]);
  return { subject: `Your ${BRAND} account is ready`, html, text };
}
