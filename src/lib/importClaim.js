// ─────────────────────────────────────────────────────────────────────────────
// importClaim.js — the migrated-student CLAIM LINK format. PURE, shared (#67).
// ─────────────────────────────────────────────────────────────────────────────
// The same design as src/lib/staffInvite.js, for the same reasons, and kept as a
// separate module so neither flow can be steered into the other's screen:
//
//   https://<app>/activate-account#claim=<hashed_token>&t=magiclink
//
// ★ THE TOKEN RIDES IN THE FRAGMENT OF A FIRST-PARTY URL. Supabase's own
//   action_link (/auth/v1/verify) spends the token on GET, so a mail scanner that
//   follows links burns the claim before the student clicks. A fragment is never
//   sent to a server — no access log, no Referer — and the token is exchanged only
//   when a human presses "Claim my account", via verifyOtp({ token_hash, type }).
//
// ★ ONE TOKEN TYPE. The endpoint creates the Auth user itself (admin.createUser,
//   which sends no email) before the grant commits, so by the time a link is
//   minted the account always exists — and generateLink('invite') refuses an
//   existing address. Verifying a magiclink also confirms the mailbox. An
//   allow-list, not a passthrough: a crafted `t` cannot turn the callback into a
//   'recovery' or 'email_change' exchange.
// ─────────────────────────────────────────────────────────────────────────────

/** The path the SPA serves the claim screen from. */
export const IMPORT_CLAIM_PATH = '/activate-account';

export const CLAIM_TOKEN_TYPES = Object.freeze(['magiclink']);

/**
 * How long a claim link stays valid, in hours. Mirrors Supabase `mailer_otp_exp`,
 * exactly as INVITE_LINK_TTL_HOURS does — the two are one setting.
 */
export const CLAIM_LINK_TTL_HOURS = 24;

/** @returns {string|null} null when anything required is missing or malformed. */
export function buildClaimUrl({ appUrl, tokenHash, type = 'magiclink' }) {
  if (!appUrl || !tokenHash) return null;
  if (!CLAIM_TOKEN_TYPES.includes(type)) return null;
  const origin = String(appUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(origin)) return null;
  return `${origin}${IMPORT_CLAIM_PATH}#claim=${encodeURIComponent(tokenHash)}&t=${encodeURIComponent(type)}`;
}

/**
 * Read a claim token out of a URL fragment. Returns null for anything it does not
 * fully recognise — including a staff `invite=` fragment, which is not a claim.
 * @returns {{ token: string, type: string }|null}
 */
export function parseClaimHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw || !raw.includes('claim=')) return null;
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const token = (params.get('claim') || '').trim();
  const type = (params.get('t') || '').trim();
  if (!token || !CLAIM_TOKEN_TYPES.includes(type)) return null;
  return { token, type };
}

/** A plain sign-in link for an account that already has a password. No token. */
export function buildSignInUrl(appUrl) {
  const origin = String(appUrl || '').replace(/\/+$/, '');
  return /^https?:\/\//i.test(origin) ? `${origin}/` : null;
}
