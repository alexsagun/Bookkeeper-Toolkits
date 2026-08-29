// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/staffInviteEmail.js — the staff invitation messages (#49). PURE.
// ─────────────────────────────────────────────────────────────────────────────
// No env reads, no I/O, no imports from the handler — so test/staffInvite.test.mjs
// can assert the rendered bodies directly. api/admin/staff.js does the minting and
// the sending; this file only decides what the message says.
//
// ★ EVERY ROLE FACT COMES FROM THE TRUSTED CATALOG, NEVER FROM THE REQUEST.
//   The caller hands us a role KEY, which api/admin/staff.js has already checked
//   against STAFF_ROLE_KEYS. The human-readable label and description are then
//   looked up in src/lib/staffRoles.js. An invitation cannot be made to describe
//   a role that does not exist, and `body.role_key` never reaches the reader as
//   free text.
//
// ★ THE LINK IS FIRST-PARTY AND CARRIES THE TOKEN IN A FRAGMENT.
//   Supabase's own action_link points at /auth/v1/verify, which CONSUMES the
//   one-time token on GET — so a corporate mail scanner that follows links burns
//   the invitation before the human ever clicks. It also means the redirect has
//   to be on Supabase's allow-list, and this project's list is a bare origin, so
//   a /staff/invitation redirect would have been silently discarded in favour of
//   Site URL (exactly the trap that makes these flows land on the wrong screen).
//
//   Instead we build our own URL to our own SPA and put the hashed token after
//   the `#`. A fragment is never sent to the server, so it cannot appear in a
//   Vercel access log or a Referer header; a GET to the SPA consumes nothing; and
//   the link's domain matches the From domain, which is what a reader (and a
//   filter) expects. The token is exchanged only when a human clicks Accept, via
//   supabase.auth.verifyOtp({ token_hash, type }).
// ─────────────────────────────────────────────────────────────────────────────

import { staffRole } from '../../src/lib/staffRoles.js';
// The link format lives in src/lib/ so the browser callback and this builder read
// one definition; test/staffInvite.test.mjs round-trips build → parse.
import { INVITE_LINK_TTL_HOURS } from '../../src/lib/staffInvite.js';
import { BRAND, emailShell, roleCard, p, plainText } from './email.js';

export { INVITE_LINK_TTL_HOURS };
export { STAFF_INVITE_PATH, INVITE_TOKEN_TYPES, buildInviteUrl } from '../../src/lib/staffInvite.js';


/** First name if we have a usable one, else null. Never echoes an email address. */
function firstNameOf(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first && first.length <= 40 ? first : null;
}

/**
 * "a Trainer" but "an Operations Admin". Of the three role labels exactly one is
 * vowel-initial, so the hardcoded "a" was wrong in the SUBJECT LINE of every
 * Operations Admin invitation — the first thing the reader sees, on the message
 * whose credibility is the point.
 */
function articleFor(label) {
  return /^[aeiou]/i.test(String(label || '').trim()) ? 'an' : 'a';
}

/**
 * The invitation itself.
 *
 * @returns {{ subject: string, html: string, text: string }}
 */
export function staffInviteEmail({
  roleKey, actionUrl, inviteeName = null, inviterName = null, resent = false,
  supportEmail = null,
}) {
  const role = staffRole(roleKey);
  const label = role?.label || 'Team member';
  const description = role?.description
    || 'A staff account on the Toolkits by Alex platform.';

  const greetName = firstNameOf(inviteeName);
  const greeting = greetName ? `Hi ${greetName},` : 'Hi,';
  const inviter = String(inviterName || '').trim();

  // The role is in the SUBJECT, because that is the fact the reader needs before
  // deciding whether this is real. "You've been invited" — the stock Supabase
  // subject — is indistinguishable from every phishing message ever sent.
  const subject = resent
    ? `Your ${BRAND} ${label} invitation (new link)`
    : `You're invited to join ${BRAND} as ${articleFor(label)} ${label}`;

  const openingLine = inviter
    ? `${inviter} has invited you to join the ${BRAND} team.`
    : `You've been invited to join the ${BRAND} team.`;

  const resentLine = resent
    ? 'Here is a fresh link — the previous one has expired or was already used.'
    : null;

  const bodyHtml = [
    p(greeting),
    p(openingLine),
    resentLine ? p(resentLine) : '',
    roleCard({ label, description }),
    // Says the quiet part out loud: this is the exact confusion that put a real
    // Operations Admin on the pricing page.
    p('This is a staff account, so there is nothing to buy — you will not be asked to choose a plan or make a payment.'),
  ].join('');

  const html = emailShell({
    heading: `You're invited to join ${BRAND}`,
    bodyHtml,
    cta: { href: actionUrl, label: 'Accept invitation and set up my account' },
    footNote: `This link works once and expires in ${INVITE_LINK_TTL_HOURS} hours. `
      + 'If you were not expecting this invitation, ignore this email or contact our team.',
    // The inbox preview line. Without it, clients promote the first body sentence.
    preheader: `Your ${label} account is ready to set up — nothing to buy, no plan to choose.`,
    supportEmail,
  });

  const text = plainText([
    greeting,
    openingLine,
    resentLine,
    { rule: true },
    `YOUR ROLE: ${label}`,
    description,
    { rule: true },
    'This is a staff account, so there is nothing to buy — you will not be asked to choose a plan or make a payment.',
    'Accept your invitation and set up your account:',
    actionUrl,
    `This link works once and expires in ${INVITE_LINK_TTL_HOURS} hours.`,
    'If you were not expecting this invitation, ignore this email or contact our team.',
    supportEmail ? `Questions? Contact our team at ${supportEmail}.` : null,
    `— The ${BRAND} team`,
  ]);

  return { subject, html, text };
}

/**
 * The notification for an EXISTING confirmed account that was granted a role.
 *
 * No token and no link to accept: that account already exists and already has a
 * password, so minting a one-time credential for it would be issuing a
 * sign-in link nobody asked for. It just tells them what changed and where to go.
 */
export function staffRoleAssignedEmail({
  roleKey, appUrl, inviteeName = null, inviterName = null, supportEmail = null,
}) {
  const role = staffRole(roleKey);
  const label = role?.label || 'Team member';
  const description = role?.description
    || 'A staff account on the Toolkits by Alex platform.';

  const greetName = firstNameOf(inviteeName);
  const greeting = greetName ? `Hi ${greetName},` : 'Hi,';
  const inviter = String(inviterName || '').trim();
  const origin = String(appUrl || '').replace(/\/+$/, '');

  const subject = `You're now ${articleFor(label)} ${label} on ${BRAND}`;
  const openingLine = inviter
    ? `${inviter} has given your existing ${BRAND} account a staff role.`
    : `Your existing ${BRAND} account has been given a staff role.`;

  const bodyHtml = [
    p(greeting),
    p(openingLine),
    roleCard({ label, description }),
    p('Sign in with the email and password you already use. Nothing about your existing membership, course progress or community history has changed.'),
  ].join('');

  const html = emailShell({
    heading: `You're now ${articleFor(label)} ${label}`,
    bodyHtml,
    cta: origin ? { href: origin, label: 'Open the toolkit' } : null,
    footNote: 'If you were not expecting this, contact our team.',
    preheader: `Your existing ${BRAND} account now has the ${label} role.`,
    supportEmail,
  });

  const text = plainText([
    greeting,
    openingLine,
    { rule: true },
    `YOUR ROLE: ${label}`,
    description,
    { rule: true },
    'Sign in with the email and password you already use. Nothing about your existing membership, course progress or community history has changed.',
    origin ? `Open the toolkit: ${origin}` : null,
    'If you were not expecting this, contact our team.',
    supportEmail ? `Questions? Contact our team at ${supportEmail}.` : null,
    `— The ${BRAND} team`,
  ]);

  return { subject, html, text };
}
