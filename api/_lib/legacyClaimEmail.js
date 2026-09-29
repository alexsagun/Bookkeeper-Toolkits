// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/legacyClaimEmail.js — the migrated-student messages (#67, #68). PURE.
// ─────────────────────────────────────────────────────────────────────────────
// No env reads, no I/O — test/legacyClaimEmail.test.mjs asserts the rendered bodies.
// api/admin/student-imports.js and api/notify-enrollment.js mint links and send; this
// file only decides what each message says, and who it is from and answered at.
//
// ★ EVERY MEMBERSHIP FACT COMES FROM THE DATABASE, NEVER FROM THE REQUEST.
//   legacy_import_begin_invite() and legacy_import_onboarding_notice() return the plan
//   name (enrollment_plans), the batch name (batches) and the dates. The browser never
//   names a plan, a batch, a date or a recipient for any of these emails.
//
// ★ THE PACKAGE IS NAMED AS THE CATALOG NAMES IT. #68 renamed the plans to their package
//   titles (VIP Package, Silver · Self-Paced, Essentials) in enrollment_plans itself, so
//   the templates print `planName` exactly as given, under one label, "Package". There is
//   no plan-key special case: the old "(VIP)" suffix existed only because the VIP plan's
//   name did not say VIP, and a key literal in a template is how two screens drift apart.
//
// ★ "ALREADY PAID" IS SAID IN SO MANY WORDS. A migrated student who is shown our
//   pricing page — or who merely fears they will be — assumes they are being asked
//   to pay twice. The message tells them there is nothing to buy before they click.
//
// ★ THE SENDER AND THE REPLY-TO ARE TWO SETTINGS, AND THEY MUST STAY TWO (#68).
//   Resend authorizes the From domain against the account's verified domains, and a
//   verified subdomain does not cover its parent. Only toolkits.alexsagun.com is verified,
//   so #67's From support@alexsagun.com was refused with a 403 on every migration email.
//   #67 also derived the reply-to, the printed contact and the sign-off FROM the sender,
//   so the obvious fix — point MIGRATION_EMAIL_FROM at the subdomain — would have sent
//   every student's reply to a mailbox that does not exist. migrationAddresses() splits
//   them (owner decision, 2026-09-28):
//     From      MIGRATION_EMAIL_FROM, else support@<the domain of RESEND_FROM> — the domain
//               every other flow in the app proves every day.
//     Reply-To  MIGRATION_REPLY_TO, else MIGRATION_SUPPORT_ADDRESS (support@alexsagun.com),
//               a monitored mailbox. Also the footer contact, the "write to" line and the
//               sign-off. Moving the From never moves it.
//
// ★ COMMUNITY COPY FOLLOWS THE BATCH. A batch community exists only for a VIP cohort seat;
//   begin_invite and the onboarding notice return batch_name null for every other plan.
//   The copy promises "your batch community" only when a batch is named, and "the member
//   community" otherwise, so an Essentials student is never sent looking for a cohort.
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
import { BRAND, detailsCard, emailShell, esc, p, plainText } from './email.js';

export { CLAIM_LINK_TTL_HOURS };

/**
 * Where a migrated student's reply goes, and the contact every migration email prints.
 * ★ The held-student screen prints a BUILD-TIME copy (MIGRATION_SUPPORT_EMAIL in
 *   src/BookkeeperPro.jsx), which cannot see MIGRATION_REPLY_TO: an override of that setting
 *   must change the constant in the same deploy (.env.example says so beside the setting).
 */
export const MIGRATION_SUPPORT_ADDRESS = 'support@alexsagun.com';

/** The display name of the default migration sender. */
export const MIGRATION_SENDER_NAME = `${BRAND} Support`;

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The bare address inside "Name <addr>", or the value itself, trimmed. */
export function bareAddress(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /<([^>]*)>/.exec(s);
  return (m ? m[1] : s).trim();
}

/** Is this a usable email address (bare or "Name <addr>")? */
export function isAddress(value) {
  return EMAIL_RE.test(bareAddress(value));
}

/**
 * The lower-cased domain of an address ("Name <a@Example.com>" → "example.com"), or null
 * when the value has no well-formed domain.
 */
export function addressDomain(value) {
  const a = bareAddress(value);
  const at = a.lastIndexOf('@');
  if (at < 1) return null;
  const d = a.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/**
 * Who a migration email is from, and where its replies go.
 *
 * @param {object} o
 * @param {string|null} [o.migrationFrom]  MIGRATION_EMAIL_FROM — used as given when set
 * @param {string|null} [o.resendFrom]     RESEND_FROM — its DOMAIN is the default sender's
 * @param {string|null} [o.replyTo]        MIGRATION_REPLY_TO — bare address or "Name <addr>"
 * @returns {{ from: string|null, fromDomain: string|null, replyTo: string }}
 *   `from` is null when neither setting yields a domain: a caller must then refuse to send
 *   rather than fall back to RESEND_FROM's (typically no-reply) address.
 */
export function migrationAddresses({ migrationFrom, resendFrom, replyTo } = {}) {
  const override = String(migrationFrom == null ? '' : migrationFrom).trim();
  const resendDomain = addressDomain(resendFrom);
  const from = override
    || (resendDomain ? `${MIGRATION_SENDER_NAME} <support@${resendDomain}>` : null);
  return {
    from,
    fromDomain: from ? addressDomain(from) : null,
    replyTo: bareAddress(replyTo) || MIGRATION_SUPPORT_ADDRESS,
  };
}

/** First name if usable, else null. Never echoes an email address. */
export function firstNameOf(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first && first.length <= 40 && !first.includes('@') ? first : null;
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

/** "your batch community" only when the membership holds a batch; else the member community. */
const communityOf = (batchName) =>
  (String(batchName || '').trim() ? 'your batch community' : 'the member community');

const packageOf = (planName) => String(planName || '').trim() || null;

function accountRows({ fullName, email, batchName, planName, startDate, endDate }) {
  return [
    ['Name', String(fullName || '').trim() || null],
    ['Email', String(email || '').trim() || null],
    ['Batch', batchName || null],
    ['Package', packageOf(planName)],
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

// The owner's sign-off: one block, three lines, naming the reply-to mailbox.
const signOffLines = (replyTo) => ['Regards,', 'Support Team', replyTo || MIGRATION_SUPPORT_ADDRESS];
const signOffText = (replyTo) => [signOffLines(replyTo).join('\n')];

// ★ THE SIGN-OFF IS IN THE HTML TOO (C9). Most students read the HTML part, and #67 put the
//   owner's sign-off only in the plain-text twin, so the two parts of one message carried
//   different signatures. The shell's generic "— The Toolkits by Alex team" line is replaced
//   with it; should the shell ever stop ending on that line, the sign-off is appended to the
//   body instead, so it can never silently vanish from the part people actually see.
const SHELL_TEAM_LINE = new RegExp(`<p([^>]*)>— The ${BRAND} team</p>`);

function signOffHtml(replyTo) {
  const [a, b, addr] = signOffLines(replyTo);
  return `<p style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.65;color:#48505e;margin:18px 0 0;">`
    + `${esc(a)}<br>${esc(b)}<br><a href="mailto:${esc(addr)}" style="color:#0A84FF;text-decoration:none;">${esc(addr)}</a></p>`;
}

function signedShell(shell, replyTo) {
  const block = signOffHtml(replyTo);
  const html = emailShell(shell);
  const signed = html.replace(SHELL_TEAM_LINE, block);
  return signed !== html ? signed : emailShell({ ...shell, bodyHtml: `${shell.bodyHtml}${block}` });
}

/**
 * The activation email: "your account has moved — create your password".
 * @param {object} o
 * @param {'claim'|'notify'} o.kind
 * @param {string|null} o.actionUrl   claim: the first-party activation URL; notify: sign-in URL
 * @param {string|null} o.fullName
 * @param {string|null} o.email
 * @param {string|null} o.planName    the package, exactly as enrollment_plans names it
 * @param {string|null} o.batchName   null for every plan without a cohort seat
 * @param {string|null} o.startDate  'YYYY-MM-DD' or a timestamp
 * @param {string|null} o.endDate    'YYYY-MM-DD' or a timestamp
 * @param {string|null} o.supportEmail  the Reply-To (migrationAddresses().replyTo)
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
      ? `Your access opens on ${dateText(o.startDate)}. You can set up your account today; your courses and ${communityOf(o.batchName)} unlock on that date.`
      : 'Your access is open now.')
    : '';
  const paid = 'Your membership is already paid. There is nothing to buy and no plan to choose, and you will not be asked for a payment.';
  const support = String(o.supportEmail || '').trim() || MIGRATION_SUPPORT_ADDRESS;

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

  const html = signedShell({
    heading: kind === 'claim' ? 'Your account has moved' : 'Your membership is on your account',
    bodyHtml,
    cta,
    footNote,
    preheader: `${paid.split('.')[0]}.${later ? ` Access opens ${dateText(o.startDate)}.` : ''}`,
    supportEmail: support,
  }, support);

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
    ...signOffText(support),
  ]);

  return { subject, html, text };
}

/**
 * To the administrator once a migrated student has set their password.
 * @param {object} o  fullName, email, batchName, planName, onboardedAt (timestamp),
 *                    startDate, endDate, dashboardUrl (the admin's Student Imports link)
 */
export function onboardedAdminEmail(o) {
  const name = String(o.fullName || '').trim() || 'A migrated student';
  const rows = [
    ['Student', String(o.fullName || '').trim() || null],
    ['Email', String(o.email || '').trim() || null],
    ['Batch', o.batchName || null],
    ['Package', packageOf(o.planName)],
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
    'You receive this once per migrated student, when they set their password.',
    `— ${BRAND}`,
  ]);
  return { subject: 'Student Successfully Onboarded', html, text };
}

/**
 * To the student once their account is created: how to get in, what they have, who to ask.
 * @param {object} o  fullName, email, batchName, planName, startDate, endDate,
 *                    status, dashboardUrl, supportEmail (the Reply-To), nowMs
 */
export function onboardedStudentEmail(o) {
  const first = firstNameOf(o.fullName);
  const greeting = first ? `Hello ${first},` : 'Hello,';
  const support = String(o.supportEmail || '').trim() || MIGRATION_SUPPORT_ADDRESS;
  const rows = [
    ...accountRows(o),
    ['Subscription status', o.status === 'scheduled' ? `Starts ${dateText(o.startDate)}` : (o.status === 'active' ? 'Active' : null)],
  ];
  const community = communityOf(o.batchName);
  const opening = 'Your account has been created successfully, and your migrated membership is on it.';
  const access = o.status === 'scheduled'
    ? `Sign in any time at the link below. Your courses and ${community} open on ${dateText(o.startDate)}.`
    : `Sign in any time at the link below to reach your dashboard, your courses and ${community}.`;
  const signIn = `Use ${String(o.email || '').trim() || 'your email address'} and the password you just created.`;
  const html = signedShell({
    heading: 'Your account is ready',
    bodyHtml: [p(greeting), p(opening), detailsCard({ title: 'Your subscription', rows }), p(access), p(signIn),
      p('Your membership is already paid; you will not be asked for a payment.')].join(''),
    cta: o.dashboardUrl ? { href: o.dashboardUrl, label: 'Go to my dashboard' } : null,
    footNote: `Need help? Reply to this email or write to ${support}.`,
    preheader: opening,
    supportEmail: support,
  }, support);
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
    ...signOffText(support),
  ]);
  return { subject: `Your ${BRAND} account is ready`, html, text };
}
