// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — STAFF MANAGEMENT (invite / assign / suspend). #45
// ─────────────────────────────────────────────────────────────────────────────
// Holds the Supabase SERVICE-ROLE key, and needs it for exactly one thing: the
// Auth Admin API, which is the only way to look a user up by email or send an
// invitation. Everything else — the membership row, the role, the audit event —
// goes through the admin_* RPCs with the CALLER's JWT, so the database enforces
// the same rules whether the change came from here or from the SQL editor.
//
// Every action:
//   1. verifies the caller's Supabase Bearer JWT (against /auth/v1/user), AND
//   2. independently confirms the staff.manage capability via my_staff_context()
//      (read with the CALLER's JWT),
//   BEFORE the service-role client is constructed.
//
// Actions (POST body.action):
//   'list'        — the staff directory + the role/capability matrix
//   'invite'      — invite a NEW person, or promote an EXISTING account
//   'assign-role' — change someone's role
//   'set-status'  — suspend / reactivate / revoke
//   'audit'       — the staff_role_events ledger
//   GET           — health { ok, configured }
//
// ★ THE INVITE PATH HAS TWO BRANCHES AND THAT IS NOT AN OPTIMISATION.
//   auth.admin.inviteUserByEmail FAILS on an email that already belongs to a
//   confirmed user — which is the common case here, because the people being
//   made staff are usually existing students or the founder's own second
//   account. So this looks the address up first and PROMOTES an existing user
//   (membership + audit row, no email) rather than erroring at them.
//
// ★ Membership is keyed by the Auth user's UUID, never by email. An email can be
//   changed, reassigned, or belong to two accounts across environments; the UUID
//   is what auth.uid() returns inside every RLS policy.
//
// Runs on Vercel AND under `npm run dev` (staffDevApi in vite.config.js).
// ─────────────────────────────────────────────────────────────────────────────

import { requireStaff, service, serviceConfigured } from '../_lib/staffAuth.js';

const APP_URL = process.env.APP_URL || '';
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

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

/** Find an Auth user by email. Returns { id, confirmed } or null. */
async function findAuthUserByEmail(admin, email) {
  // listUsers is paginated and has no server-side email filter in supabase-js v2,
  // so page until found. Staff lists are small; this is bounded at 10 pages.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const hit = users.find((u) => normalizeEmail(u.email) === email);
    if (hit) return { id: hit.id, confirmed: Boolean(hit.email_confirmed_at || hit.confirmed_at) };
    if (users.length < 200) break;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, configured: serviceConfigured() });
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
      if (!body.role_key) return res.status(400).json({ error: 'role_key required.' });

      const admin = service();
      const existing = await findAuthUserByEmail(admin, email);

      let userId = existing?.id || null;
      let invited = false;

      if (!existing) {
        // Brand-new person: create the Auth user via an invitation email.
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: APP_URL ? `${APP_URL}/` : undefined,
          data: {
            // Metadata is DISPLAY ONLY. It is user-editable and must never be
            // read for authorization — the membership row is the authority.
            invited_as: body.role_key,
            full_name: body.full_name || null,
          },
        });
        if (error) {
          return res.status(502).json({ error: `Could not send the invitation: ${error.message}` });
        }
        userId = data?.user?.id || null;
        invited = true;
      }

      if (!userId) {
        return res.status(502).json({ error: 'The invitation did not return a user id.' });
      }

      // The signup trigger creates the profiles row on auth.users INSERT, but an
      // invite and that trigger race. admin_upsert_staff_membership requires the
      // profile to exist, so give it a moment and retry rather than failing a
      // legitimate invite on a timing artefact.
      let out = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          out = await callerRpc(u, 'admin_upsert_staff_membership', {
            p_user_id: userId,
            p_role_key: body.role_key,
            p_display_title: body.display_title || null,
            p_reason: body.reason || (invited ? 'Invited from Team & Roles.' : 'Promoted from an existing account.'),
            // An invitee has not accepted yet. An existing account is active now.
            p_status: invited ? 'invited' : 'active',
          });
          break;
        } catch (e) {
          lastErr = e;
          if (e.hint !== 'STAFF_NOT_FOUND') throw e;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (!out) {
        return res.status(502).json({
          error: 'The account was created but the staff role could not be assigned. '
            + 'Open Team & Roles and assign it directly.',
          code: lastErr?.hint || null,
        });
      }

      return res.status(200).json({
        ok: true,
        user_id: userId,
        invited,
        promoted: !invited,
        result: out,
      });
    }

    return res.status(400).json({
      error: "action must be 'list', 'invite', 'assign-role', 'set-status' or 'audit'.",
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
