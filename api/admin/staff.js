// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — STAFF MANAGEMENT (invite / assign / suspend). #45
// Rewritten by #49: branded invitation email + a real invited→active lifecycle.
// ─────────────────────────────────────────────────────────────────────────────
// Holds the Supabase SERVICE-ROLE key, and needs it for exactly two things: the
// Auth Admin API (the only way to look a user up by email or mint an invitation
// link) and nothing else. Every membership change, role and audit row goes
// through the admin_* RPCs with the CALLER's JWT, so the database enforces the
// same rules whether the change came from here or from the SQL editor.
//
// Every action:
//   1. verifies the caller's Supabase Bearer JWT (against /auth/v1/user), AND
//   2. independently confirms the staff.manage capability via my_staff_context()
//      (read with the CALLER's JWT),
//   BEFORE the service-role client is constructed.
//
// Actions (POST body.action):
//   'list'          — the staff directory + the role/capability matrix
//   'invite'        — invite a NEW person, or promote an EXISTING account
//   'resend-invite' — mint a fresh link for someone still at status='invited'
//   'assign-role'   — change someone's role
//   'set-status'    — suspend / reactivate / revoke
//   'audit'         — the staff_role_events ledger
//   'email-diagnostics' — (#50) the sending domain's verification + DNS record
//                     status and its click/open-tracking flags, read from Resend.
//                     Names and statuses only: no key, no DNS value.
//   GET             — health { ok, configured, hasResend, hasAppUrl }
//
// ★ #49 — THE INVITE PATH BRANCHES ON *CONFIRMED*, NOT ON *EXISTS*, AND THAT WAS
//   A REAL BUG. The old code asked only whether an Auth user existed. Re-inviting
//   somebody who had been invited but had NOT yet accepted therefore took the
//   "promote an existing account" branch and flipped their membership straight to
//   ACTIVE — no acceptance, no email, no proof they ever read the invitation. The
//   three cases are now distinct:
//     • no account          → generateLink('invite')    → status stays 'invited'
//     • account, unconfirmed→ generateLink('magiclink') → status stays 'invited'
//     • account, confirmed  → promote to 'active' + a plain notification email
//   Only the third grants anything, and only because that person has already
//   proven they own the mailbox.
//
// ★ #49 — inviteUserByEmail() IS GONE. It sends through Supabase's own mailer,
//   which meant the invitation used the hosted "Invite user" template — verified
//   in production as verbatim the Supabase default: an <h2>, one sentence, one
//   bare link, subject "You've been invited". It could not name the role, could
//   not be tested, and could not be changed without a dashboard edit nobody would
//   review. generateLink() mints WITHOUT sending, so the message is built in this
//   repo (api/_lib/staffInviteEmail.js) and sent through the same Resend path as
//   every other transactional email here.
//
// ★ ORDER IS A SAFETY PROPERTY: caller → role validated → auth user → MEMBERSHIP
//   ROW → email → record the delivery outcome. Auth, the database and the mail
//   provider cannot share a transaction, so the compensating rule is that an
//   email may never be sent for a membership that does not exist, and a failed
//   send must leave a recoverable 'invited' row rather than an active one.
//
// ★ THE LINK IS MINTED, SENT, AND DISCARDED. It is never returned to the browser,
//   never written to a row, never logged, and never put in an audit event. Only
//   its OUTCOME is recorded, as a short safe code.
//
// ★ Membership is keyed by the Auth user's UUID, never by email. An email can be
//   changed, reassigned, or belong to two accounts across environments; the UUID
//   is what auth.uid() returns inside every RLS policy.
//
// Runs on Vercel AND under `npm run dev` (staffDevApi in vite.config.js).
// ─────────────────────────────────────────────────────────────────────────────

import { requireStaff, service, serviceConfigured } from '../_lib/staffAuth.js';
import { emailConfigured, sendEmail } from '../_lib/email.js';
import {
  buildInviteUrl, staffInviteEmail, staffRoleAssignedEmail,
} from '../_lib/staffInviteEmail.js';
import { STAFF_ROLE_KEYS } from '../../src/lib/staffRoles.js';
import { inviteBranchFor } from '../../src/lib/staffInvite.js';

const MAX_BODY_BYTES = 64 * 1024;

// ── Per-warm-instance burst guard (the anthropic-proxy idiom) ──
// Staff changes are rare and deliberate; 20/min stops a scripted loop without
// ever inconveniencing a human.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 20;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (rateHits.get(userId) || []).filter((t) => t >= cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

// A separate, tighter guard for resends, keyed on the TARGET rather than the
// actor. The burst limit above is per-admin, so two admins could hammer one
// invitee's mailbox between them and still be under it.
const RESEND_COOLDOWN_MS = 60_000;
const resendHits = new Map();
function resendTooSoon(targetId) {
  const last = resendHits.get(targetId) || 0;
  return Date.now() - last < RESEND_COOLDOWN_MS;
}
// ★ Stamped only after the provider ACCEPTS. Stamping at the check would lock the
//   admin out for a minute over an invitation that never left — and a failed send
//   is exactly the moment they need to retry.
function markResent(targetId) {
  resendHits.set(targetId, Date.now());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

/**
 * The absolute origin invitation links point at.
 * APP_URL when set; otherwise the request host, matching notify-enrollment.js —
 * an unset env var must not silently produce a link to nowhere.
 */
function appOrigin(req) {
  const configured = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  const host = req?.headers?.host;
  return host ? `https://${host}` : '';
}

/**
 * Call an admin_* RPC with the CALLER's JWT, not the service key.
 *
 * Deliberate: those functions carry their own has_staff_permission() guard and
 * their own audit write. Calling them as the service role would run them with
 * auth.uid() = null, so the staff_role_events row would record no actor — an
 * audit ledger that cannot say who did it is not an audit ledger.
 */
async function callerRpc(user, fn, args) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anon,
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    // PostgREST puts our app_error code in `hint`. Clients branch on that,
    // never on the HTTP status.
    const err = new Error(data?.message || `rpc ${fn} failed`);
    err.status = r.status;
    err.hint = data?.hint || null;

    // ★ A function that does not exist is NOT a server fault, and reporting it as
    //   one is how "run the migration" reached the browser as
    //   "500 Internal Server Error". PostgREST answers a missing function with
    //   PGRST202, whose `hint` is null or a "Perhaps you meant…" suggestion —
    //   never one of our codes — so the generic branch in the handler's catch
    //   swallowed it. Classify it here, where the cause is actually known.
    if (data?.code === 'PGRST202' || (r.status === 404 && !err.hint)) {
      err.hint = 'MIGRATION_MISSING';
      err.status = 501;   // Not Implemented: the endpoint is fine, the schema is not
      err.migrationMissing = true;
      err.message = `${fn}() does not exist in this database — run the staff-authorization migrations.`;
    }
    throw err;
  }
  return data;
}

/**
 * Find an Auth user by email. Returns { id, confirmed }, null when the account
 * genuinely does not exist, or the string 'capped' when the search ran out of
 * pages WITHOUT proving absence.
 *
 * ★ THE CAP IS A DISTINCT ANSWER, NOT A NULL (#50). At >2000 Auth users the old
 *   version returned null, the branch classified an existing confirmed account
 *   as brand-new, generateLink('invite') refused the existing address, and the
 *   admin read "Could not create the invitation" — an error pointing nowhere
 *   near the cause. Failing with a named reason keeps it closed AND diagnosable.
 */
async function findAuthUserByEmail(admin, email) {
  // listUsers is paginated and has no server-side email filter in supabase-js v2,
  // so page until found. Staff lists are small; this is bounded at 10 pages.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const hit = users.find((u) => normalizeEmail(u.email) === email);
    if (hit) return { id: hit.id, confirmed: Boolean(hit.email_confirmed_at || hit.confirmed_at) };
    if (users.length < 200) return null; // a short page proves we saw everyone
  }
  return 'capped';
}

/**
 * The address invitation replies and "contact our team" point at (#50).
 * The admin-editable payment_settings.notify_email first — read with the
 * CALLER's JWT, the same source the enrollment notifier resolves — then the
 * NOTIFY_ADMIN_EMAIL env var. Null when neither is set: the email builders omit
 * the contact line rather than inventing an address.
 */
async function supportEmailFor(user) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  try {
    // ★ payment_settings is a KEY/VALUE table (key, value, …) — there is no
    //   notify_email COLUMN. Selecting one returns 400/42703, which `r.ok`
    //   swallows, so the admin-editable address would be silently unreachable and
    //   every invitation would fall through to the env var. Same query shape as
    //   api/notify-enrollment.js, which is the precedent this resolves against.
    const r = await fetch(
      `${url}/rest/v1/payment_settings?key=eq.notify_email&select=value`,
      { headers: { apikey: anon, Authorization: `Bearer ${user.token}` } },
    );
    if (r.ok) {
      const rows = await r.json();
      const addr = normalizeEmail(rows?.[0]?.value);
      if (EMAIL_RE.test(addr)) return addr;
    }
  } catch { /* best-effort — fall through to the env var */ }
  const envAddr = normalizeEmail(process.env.NOTIFY_ADMIN_EMAIL);
  return EMAIL_RE.test(envAddr) ? envAddr : null;
}

/** The inviter's display name, for the email. Best-effort — never blocks a send. */
async function callerName(user) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  try {
    const r = await fetch(`${url}/rest/v1/profiles?id=eq.${user.id}&select=full_name`, {
      headers: { apikey: anon, Authorization: `Bearer ${user.token}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const name = rows?.[0]?.full_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Mint a one-time link WITHOUT sending anything.
 * @returns {{ tokenHash: string|null, userId: string|null, error: string|null }}
 */
async function mintLink(admin, { email, type, metadata }) {
  const options = {};
  if (metadata) options.data = metadata;
  const { data, error } = await admin.auth.admin.generateLink({ type, email, options });
  if (error) return { tokenHash: null, userId: null, error: error.message || 'generate_link_failed' };
  return {
    // ★ hashed_token, NOT properties.action_link. action_link points at
    //   /auth/v1/verify, which consumes the token on GET — a mail scanner that
    //   follows links would burn the invitation before the human saw it.
    tokenHash: data?.properties?.hashed_token || null,
    userId: data?.user?.id || null,
    error: null,
  };
}

/** Record how the send went. Best-effort: never turns a live invite into a failure. */
async function recordDelivery(user, userId, status, code) {
  try {
    await callerRpc(user, 'admin_record_staff_invite', {
      p_user_id: userId,
      p_status: status,
      p_error_code: code || null,
    });
  } catch {
    // A pre-#49 database has no such function. The membership is already correct;
    // only the delivery badge is missing, and that must not fail the request.
  }
}

/**
 * Upsert the membership, absorbing the signup-trigger race.
 * The profiles row is created by a trigger on auth.users INSERT, and an invite
 * races it; admin_upsert_staff_membership requires the profile to exist.
 */
async function upsertMembership(user, args) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { out: await callerRpc(user, 'admin_upsert_staff_membership', args), err: null };
    } catch (e) {
      lastErr = e;
      if (e.hint !== 'STAFF_NOT_FOUND') throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return { out: null, err: lastErr };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // hasResend / hasAppUrl are reported because an unconfigured sender and an
    // unset origin both look exactly like "invitations are broken" from the UI,
    // and neither was visible anywhere before.
    return res.status(200).json({
      ok: true,
      configured: serviceConfigured(),
      hasResend: emailConfigured(),
      hasAppUrl: Boolean(process.env.APP_URL),
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  if (!serviceConfigured()) {
    return res.status(500).json({ error: 'Supabase service credentials are not configured.' });
  }

  // Auth: valid JWT + independently-confirmed staff.manage, BEFORE service().
  const gate = await requireStaff(req, { permission: 'staff.manage' });
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
  const u = gate.user;
  if (rateLimited(u.id)) return res.status(429).json({ error: 'Too many requests — wait a minute.' });

  if (Number(req.headers?.['content-length']) > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request too large.' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};
  const action = body.action;

  try {
    // ── list ──────────────────────────────────────────────────────────────
    if (action === 'list') {
      const [directory, matrix] = await Promise.all([
        callerRpc(u, 'admin_staff_directory', {}),
        callerRpc(u, 'staff_role_permission_matrix', {}),
      ]);
      return res.status(200).json({ ok: true, staff: directory || [], matrix: matrix || [] });
    }

    // ── audit ─────────────────────────────────────────────────────────────
    if (action === 'audit') {
      const events = await callerRpc(u, 'admin_staff_events', {
        p_user_id: UUID_RE.test(body.user_id || '') ? body.user_id : null,
        p_limit: Math.min(Math.max(Number(body.limit) || 100, 1), 500),
      });
      return res.status(200).json({ ok: true, events: events || [] });
    }

    // ── assign-role / set-status ──────────────────────────────────────────
    // Both are pure RPC calls: no service key needed, and the database enforces
    // the last-Super-Admin rule in the RPC AND in a guard trigger.
    if (action === 'assign-role') {
      if (!UUID_RE.test(body.user_id || '')) {
        return res.status(400).json({ error: 'user_id required.' });
      }
      const out = await callerRpc(u, 'admin_upsert_staff_membership', {
        p_user_id: body.user_id,
        p_role_key: body.role_key,
        p_display_title: body.display_title || null,
        p_reason: body.reason || null,
        p_status: body.status || 'active',
      });
      return res.status(200).json({ ok: true, result: out });
    }

    if (action === 'set-status') {
      if (!UUID_RE.test(body.user_id || '')) {
        return res.status(400).json({ error: 'user_id required.' });
      }
      const out = await callerRpc(u, 'admin_set_staff_status', {
        p_user_id: body.user_id,
        p_status: body.status,
        p_reason: body.reason || null,
      });
      return res.status(200).json({ ok: true, result: out });
    }

    // ── invite ────────────────────────────────────────────────────────────
    if (action === 'invite') {
      const email = normalizeEmail(body.email);
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });

      // ★ Validated against the trusted catalog BEFORE any Auth call, so a bad
      //   role can never create an account, and body.role_key never reaches the
      //   email as free text — the label and description are looked up from it.
      const roleKey = String(body.role_key || '');
      if (!STAFF_ROLE_KEYS.includes(roleKey)) {
        return res.status(400).json({ error: 'Unknown role.', code: 'STAFF_ROLE_INVALID' });
      }

      const origin = appOrigin(req);
      const admin = service();
      const existing = await findAuthUserByEmail(admin, email);
      if (existing === 'capped') {
        // See findAuthUserByEmail: absence was NOT proven, so classifying this
        // address as "new" could promote-or-invite the wrong way. Refuse loudly.
        return res.status(502).json({
          error: 'Too many accounts to search for that address. Contact support to invite this person.',
          code: 'user_search_capped',
        });
      }

      // The decision lives in src/lib/staffInvite.js so node:test can reach it —
      // api/ handlers have no test harness here, and this is precisely the branch
      // that was wrong (it asked "exists?" instead of "confirmed?").
      const branch = inviteBranchFor(existing);
      const promote = branch.action === 'promote';

      let userId = existing?.id || null;
      let tokenHash = null;
      let tokenType = null;

      if (branch.action === 'invite') {
        // Creates the Auth user and returns a token — but sends nothing.
        const minted = await mintLink(admin, {
          email,
          type: 'invite',
          metadata: {
            // Metadata is DISPLAY ONLY. It is user-editable and must never be
            // read for authorization — the membership row is the authority, and
            // accept_staff_invitation() never looks at it.
            invited_as: roleKey,
            full_name: body.full_name || null,
          },
        });
        if (minted.error) {
          return res.status(502).json({ error: 'Could not create the invitation.' });
        }
        userId = minted.userId;
        tokenHash = minted.tokenHash;
        tokenType = branch.tokenType;
      } else if (branch.action === 'reinvite') {
        // ★ The case the old code got wrong. This account exists but has never
        //   proven it owns the mailbox, so it does NOT get promoted — it gets a
        //   fresh link and stays 'invited'. ('invite' would fail here: the user
        //   already exists.)
        const minted = await mintLink(admin, { email, type: branch.tokenType });
        if (minted.error) {
          return res.status(502).json({ error: 'Could not create the invitation.' });
        }
        tokenHash = minted.tokenHash;
        tokenType = branch.tokenType;
      }

      if (!userId) {
        return res.status(502).json({ error: 'The invitation did not return a user id.' });
      }

      // ── The membership row exists BEFORE any email goes out ──
      const { out, err } = await upsertMembership(u, {
        p_user_id: userId,
        p_role_key: roleKey,
        p_display_title: body.display_title || null,
        p_reason: body.reason
          || (promote ? 'Promoted from an existing account.' : 'Invited from Team & Roles.'),
        p_status: branch.status,
      });
      if (!out) {
        return res.status(502).json({
          error: 'The account was created but the staff role could not be assigned. '
            + 'Open Team & Roles and assign it directly.',
          code: err?.hint || null,
        });
      }

      // ── Now the email ──
      const [inviterName, supportEmail] = await Promise.all([callerName(u), supportEmailFor(u)]);
      let sent;
      if (promote) {
        const msg = staffRoleAssignedEmail({
          roleKey, appUrl: origin, inviteeName: body.full_name || null, inviterName, supportEmail,
        });
        sent = await sendEmail({ to: email, ...msg, replyTo: supportEmail, tag: 'staff-invite' });
      } else {
        const actionUrl = buildInviteUrl({ appUrl: origin, tokenHash, type: tokenType });
        if (!actionUrl) {
          sent = { ok: false, code: origin ? 'no_link' : 'app_url_not_configured' };
        } else {
          const msg = staffInviteEmail({
            roleKey, actionUrl, inviteeName: body.full_name || null, inviterName, supportEmail,
          });
          sent = await sendEmail({ to: email, ...msg, replyTo: supportEmail, tag: 'staff-invite' });
        }
        await recordDelivery(u, userId, sent.ok ? 'sent' : 'failed', sent.code);
      }

      // 200 with an explicit outcome, not a 502: the membership really was
      // created, and the client must be able to say "invited, but the email did
      // not go out — resend" rather than either lying or implying nothing
      // happened.
      return res.status(200).json({
        ok: true,
        user_id: userId,
        invited: !promote,
        promoted: promote,
        email_sent: Boolean(sent?.ok),
        email_code: sent?.ok ? null : (sent?.code || 'email_failed'),
        result: out,
      });
    }

    // ── resend-invite ─────────────────────────────────────────────────────
    // Only for someone still at status='invited'. Resending is not a way to
    // reactivate a suspended or revoked account, and it never changes status.
    if (action === 'resend-invite') {
      if (!UUID_RE.test(body.user_id || '')) {
        return res.status(400).json({ error: 'user_id required.' });
      }
      const targetId = body.user_id;

      // Read the row through the caller's own JWT, so the directory's
      // staff.manage guard decides what this admin may even see.
      const directory = await callerRpc(u, 'admin_staff_directory', {});
      const row = (directory || []).find((r) => r.user_id === targetId);
      if (!row) return res.status(404).json({ error: 'That account is not a staff member.' });
      if (row.status !== 'invited') {
        return res.status(409).json({
          error: `That invitation was already ${row.status === 'active' ? 'accepted' : row.status}.`,
        });
      }
      if (resendTooSoon(targetId)) {
        return res.status(429).json({ error: 'An invitation was just sent. Wait a minute before resending.' });
      }

      const admin = service();
      const { data: got, error: getErr } = await admin.auth.admin.getUserById(targetId);
      if (getErr || !got?.user?.email) {
        return res.status(502).json({ error: 'Could not read that account.' });
      }
      const email = normalizeEmail(got.user.email);

      // Always 'magiclink' on a resend: the Auth user necessarily exists by now
      // (they were invited), and generateLink('invite') refuses an existing
      // address. magiclink verification also confirms an unconfirmed mailbox,
      // which is what accept_staff_invitation() requires before it will activate.
      const minted = await mintLink(admin, { email, type: 'magiclink' });
      if (minted.error) return res.status(502).json({ error: 'Could not create a new invitation link.' });

      const origin = appOrigin(req);
      const actionUrl = buildInviteUrl({ appUrl: origin, tokenHash: minted.tokenHash, type: 'magiclink' });
      if (!actionUrl) {
        await recordDelivery(u, targetId, 'failed', origin ? 'no_link' : 'app_url_not_configured');
        return res.status(502).json({ error: 'Could not build the invitation link. Set APP_URL.' });
      }

      const [inviterName, supportEmail] = await Promise.all([callerName(u), supportEmailFor(u)]);
      const msg = staffInviteEmail({
        roleKey: row.role_key, actionUrl, inviteeName: row.full_name || null, inviterName,
        resent: true, supportEmail,
      });
      const sent = await sendEmail({ to: email, ...msg, replyTo: supportEmail, tag: 'staff-invite' });
      await recordDelivery(u, targetId, sent.ok ? 'resent' : 'failed', sent.code);

      if (!sent.ok) {
        return res.status(502).json({ error: 'The invitation email could not be sent.', code: sent.code });
      }
      markResent(targetId);
      return res.status(200).json({ ok: true, email_sent: true });
    }

    // ── email-diagnostics ─────────────────────────────────────────────────
    // A real deliverability audit, not a promise (#50): reads the sending
    // domain's verification + DNS record status and its tracking flags from
    // Resend's own API. Reported because CLICK TRACKING REWRITES EVERY LINK to a
    // Resend redirect domain — which breaks the "the CTA's domain matches the
    // From domain" property the fragment-token design depends on, and hands the
    // one-time URL to a redirect service. Resend has no per-message opt-out, so
    // if it is on, the fix is the dashboard toggle and this report says so.
    // No secret and no full DNS values leave this handler — names and statuses only.
    if (action === 'email-diagnostics') {
      const apiKey = process.env.RESEND_API_KEY;
      const from = String(process.env.RESEND_FROM || '');
      const fromDomain = (from.match(/@([^\s>]+)>?\s*$/) || [])[1]?.toLowerCase() || null;
      const appDomain = (() => {
        try { return new URL(appOrigin(req)).hostname.toLowerCase(); } catch { return null; }
      })();
      if (!apiKey) {
        return res.status(200).json({
          ok: true, configured: false, fromDomain, appDomain,
          note: 'RESEND_API_KEY is not set — nothing to audit.',
        });
      }
      const rr = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!rr.ok) {
        return res.status(200).json({ ok: false, configured: true, error: `resend_${rr.status}` });
      }
      const listing = await rr.json();
      const domains = listing?.data || [];
      const match = fromDomain
        ? domains.find((d) => String(d.name || '').toLowerCase() === fromDomain) || null
        : null;
      let detail = null;
      if (match?.id) {
        const dr = await fetch(`https://api.resend.com/domains/${match.id}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (dr.ok) detail = await dr.json();
      }
      const d = detail || match;
      return res.status(200).json({
        ok: true,
        configured: true,
        fromDomain,
        appDomain,
        // Aligned From/CTA/app domains are what a reader (and a filter) expects.
        domainsAligned: Boolean(fromDomain && appDomain
          && (appDomain === fromDomain || appDomain.endsWith(`.${fromDomain}`)
            || fromDomain.endsWith(`.${appDomain}`))),
        domainFound: Boolean(match),
        domainStatus: d?.status || null,
        clickTracking: d?.click_tracking ?? null,
        openTracking: d?.open_tracking ?? null,
        // Record NAMES + statuses only — enough to see an unverified DKIM/SPF
        // entry without echoing DNS values into a browser.
        records: Array.isArray(d?.records)
          ? d.records.map((r) => ({ record: r.record, type: r.type, status: r.status }))
          : [],
        warnings: [
          ...(d?.click_tracking ? ['Click tracking is ON for this domain: every invitation link is rewritten to a Resend redirect, which breaks the same-domain property one-time links rely on. Turn it off in Resend → Domains.'] : []),
          ...(match && d?.status !== 'verified' ? [`The sending domain is ${d?.status || 'not verified'} — SPF/DKIM will not align until every DNS record shows verified.`] : []),
          ...(!match && fromDomain ? [`RESEND_FROM's domain (${fromDomain}) is not registered in this Resend account, so mail is sent from a shared/unaligned domain.`] : []),
        ],
      });
    }

    return res.status(400).json({
      error: "action must be 'list', 'invite', 'resend-invite', 'assign-role', 'set-status', 'audit' or 'email-diagnostics'.",
    });
  } catch (err) {
    // app_error codes travel in `hint`; surface them so the client can render
    // the right copy (e.g. STAFF_LAST_SUPER_ADMIN).
    if (err?.hint) {
      return res.status(err.status || 400).json({ error: err.message, code: err.hint });
    }
    // A missing migration already returned above with its own code; anything that
    // reaches here is a real failure worth a log line. Never log the message or any
    // PII — only a code.
    console.error(`[staff] ${action} failed: ${String(err?.code || err?.name || 'error')}`);
    return res.status(500).json({ error: 'Staff operation failed.' });
  }
}
