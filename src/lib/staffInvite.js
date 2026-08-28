// ─────────────────────────────────────────────────────────────────────────────
// staffInvite.js — the staff invitation LINK format. PURE, shared, testable (#49).
// ─────────────────────────────────────────────────────────────────────────────
// One module owns the URL, so the server that builds it and the browser that
// reads it cannot disagree. api/_lib/staffInviteEmail.js imports buildInviteUrl();
// BookkeeperPro.jsx imports parseInviteHash(). test/staffInvite.test.mjs round-trips
// them against each other — a format change that breaks the callback fails there
// rather than in someone's inbox.
//
// ★ WHY THE TOKEN RIDES IN THE FRAGMENT, AND WHY THE LINK IS OURS.
//
//   Supabase's own action_link points at /auth/v1/verify, which CONSUMES the
//   one-time token on GET. Corporate mail scanners follow links; a scanned
//   invitation is a spent invitation, and the human then sees "expired" on their
//   first click. Worse, that URL's redirect has to appear in the project's
//   Redirect-URL allow-list, and this project's list is a bare origin — so a
//   /staff/invitation redirect would have been silently discarded in favour of
//   Site URL, dropping the invitee on the dashboard (or the paywall) with no
//   explanation. Both failure modes are designed out by not using it.
//
//   Instead the link is first-party and the token sits after the `#`:
//     https://<app>/staff/invitation#invite=<hashed_token>&t=invite
//
//   A fragment is never transmitted to a server, so the token cannot appear in a
//   Vercel access log, a proxy log, or a Referer header. A GET to our SPA
//   consumes nothing, so a prefetch is harmless. The token is exchanged only when
//   a human clicks Accept, via supabase.auth.verifyOtp({ token_hash, type }).
//   And the link's domain matches the From domain, which is what both a reader
//   and a spam filter expect to see.
// ─────────────────────────────────────────────────────────────────────────────

/** The path the SPA serves the invitation screen from. */
export const STAFF_INVITE_PATH = '/staff/invitation';

/**
 * The ONLY token types this flow mints or accepts.
 *
 * 'invite'    — a brand-new account (generateLink creates the Auth user).
 * 'magiclink' — an account that already exists but has never confirmed its
 *               mailbox, and every resend. generateLink('invite') refuses an
 *               existing address, and verifying a magiclink also confirms the
 *               email, which is what accept_staff_invitation() requires.
 *
 * An allow-list, not a passthrough: whatever arrives in `t` is checked against
 * this before it is handed to verifyOtp, so a crafted URL cannot steer the
 * callback into a 'recovery' or 'email_change' exchange.
 */
export const INVITE_TOKEN_TYPES = Object.freeze(['invite', 'magiclink']);

/**
 * How long an invitation link stays valid, in hours.
 *
 * ★ MIRRORS the Supabase `mailer_otp_exp` setting; it is not read from it, because
 *   GoTrue does not expose that value to a server function and a wrong number in
 *   the email is worse than no number. If the setting changes, change this in the
 *   same commit — test/staffInvite.test.mjs pins it so the drift cannot be silent,
 *   and AUTH_SETUP.md records where the setting lives.
 */
export const INVITE_LINK_TTL_HOURS = 24;

/**
 * Build the first-party invitation URL.
 * @returns {string|null} null when anything required is missing or malformed —
 *   callers must treat that as "could not invite", never as "send it anyway".
 */
export function buildInviteUrl({ appUrl, tokenHash, type }) {
  if (!appUrl || !tokenHash) return null;
  if (!INVITE_TOKEN_TYPES.includes(type)) return null;
  const origin = String(appUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(origin)) return null;
  return `${origin}${STAFF_INVITE_PATH}#invite=${encodeURIComponent(tokenHash)}&t=${encodeURIComponent(type)}`;
}

/**
 * Decide what an invite request should DO, given what the Auth directory says
 * about the address.
 *
 * ★ THIS BRANCHES ON `confirmed`, NOT ON EXISTENCE, AND THAT WAS THE BUG.
 *   api/admin/staff.js used to ask only whether an Auth user existed. So
 *   re-inviting somebody who had been invited but had NOT yet accepted — an
 *   account that exists but has never proven it owns the mailbox — took the
 *   "promote an existing account" branch and flipped their membership straight to
 *   ACTIVE, with no acceptance and no email sent. Extracting the decision here is
 *   what makes it testable: `api/` handlers have no test harness in this repo, so
 *   a decision left inline in the handler is a decision nothing can check.
 *
 * @param {{ id: string, confirmed: boolean }|null} existing
 * @returns {{ action: 'invite'|'reinvite'|'promote', tokenType: string|null, status: 'invited'|'active' }}
 */
export function inviteBranchFor(existing) {
  // No account: generateLink('invite') creates the user and mints a token.
  if (!existing) return { action: 'invite', tokenType: 'invite', status: 'invited' };

  // Exists but unconfirmed. generateLink('invite') refuses an address that already
  // exists, so the token type is 'magiclink' — verifying which also confirms the
  // mailbox, which is exactly what accept_staff_invitation() requires. The
  // membership stays 'invited': existing is not the same as proven.
  if (!existing.confirmed) return { action: 'reinvite', tokenType: 'magiclink', status: 'invited' };

  // Confirmed. They already own the mailbox and already have a password, so there
  // is nothing to accept and no credential to mint — minting one would be issuing
  // an unrequested sign-in link.
  return { action: 'promote', tokenType: null, status: 'active' };
}

/**
 * Read an invitation token out of a URL fragment.
 *
 * @param {string} hash - `window.location.hash`, with or without the leading '#'.
 * @returns {{ token: string, type: string }|null}
 *
 * Returns null for anything it does not fully recognise. In particular an
 * unknown `t` is rejected outright rather than defaulted, so the callback can
 * never be talked into exchanging a token as a type it was not issued for.
 */
export function parseInviteHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw || !raw.includes('invite=')) return null;
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const token = (params.get('invite') || '').trim();
  const type = (params.get('t') || '').trim();
  if (!token) return null;
  if (!INVITE_TOKEN_TYPES.includes(type)) return null;
  return { token, type };
}
