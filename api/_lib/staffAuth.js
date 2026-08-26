// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/staffAuth.js — the ONE staff authorization gate for api/admin/* (#45).
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS REPLACES
//   Four byte-identical copies of the same check, one per handler:
//     api/admin/course-trainer.js:69   callerIsAdmin()
//     api/admin/student-imports.js:77  callerIsAdmin()
//     api/notify-access.js:70          callerAdminId()
//     api/notify-enrollment.js:123     callerAdminId()
//   Each issued GET /rest/v1/profiles?id=eq.<uid>&select=is_admin with the
//   caller's own JWT and tested `rows[0]?.is_admin === true`. With one boolean
//   that was fine. With three staff roles it is four places to get wrong.
//
// THE CONTRACT
//   1. Verify the caller's Supabase JWT against /auth/v1/user.
//   2. Ask the DATABASE what they are allowed to do, with THEIR OWN JWT.
//   3. Only then may the caller construct a service-role client.
//   Steps 1 and 2 both happen before service() is reachable, preserving the
//   invariant three of the four handlers already documented in their headers.
//
// ★ AUTHORITY IS READ LIVE, NEVER FROM THE TOKEN. my_staff_context() is a
//   database call on every request. A JWT claim would be stale until the user's
//   next refresh, so suspending a staff member would leave them working for up to
//   an hour. This costs one round trip and is the whole reason suspension is
//   immediate.
//
// ★ THE DECISION IS NOT MADE HERE. staffAuthVerdict() in src/lib/staffRoles.js
//   decides; this file only fetches. That keeps the rule under node:test — there
//   is no test infrastructure for api/ handlers in this repo — and keeps this a
//   thin I/O shell, which is the house rule for server code.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import { staffAuthVerdict, staffContextFromRpc } from '../../src/lib/staffRoles.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Verify the bearer token and return { id, token }, or null.
 *
 * Byte-identical in behaviour to the callerUser() it replaces in each handler —
 * deliberately, so this is a lift-and-share rather than a rewrite of a gate.
 */
export async function callerUser(authHeader) {
  if (!authHeader || !SUPABASE_URL || !ANON_KEY) return null;
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, token } : null;
  } catch {
    return null;
  }
}

/**
 * Ask my_staff_context() with the CALLER's JWT.
 *
 * With their own token on purpose: the function is self-scoped to auth.uid(), so
 * it cannot be asked about anybody else, and using the service key here would
 * both overstate what this step needs and construct the privileged client before
 * the caller has been authorized.
 */
async function fetchStaffContext(user) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_staff_context`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!r.ok) {
      const body = await r.text();
      // PostgREST answers a missing function with 404 + PGRST202. That is the
      // pre-#45 database, and staffContextFromRpc classifies it as `missing`.
      return staffContextFromRpc({
        data: null,
        error: { code: r.status === 404 ? 'PGRST202' : String(r.status), message: body.slice(0, 300) },
      });
    }
    return staffContextFromRpc({ data: await r.json(), error: null });
  } catch (e) {
    return staffContextFromRpc({ data: null, error: e });
  }
}

/**
 * The legacy pre-#45 check, consulted ONLY when my_staff_context() is absent.
 * Returns true/false, or null when the check itself could not be run — null is
 * not a grant.
 */
async function legacyIsAdmin(user) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${user.token}` } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0]?.is_admin === true : null;
  } catch {
    return null;
  }
}

/**
 * THE gate. Call it first in every api/admin/* handler.
 *
 * @param {object} req         the request (only `headers.authorization` is read)
 * @param {string} permission  a key from STAFF_PERMISSIONS
 * @returns {Promise<{ok: boolean, status: number, error?: string, code?: string,
 *                    user?: object, context?: object, legacy?: boolean}>}
 *
 * On `ok: false` the handler must return `status` and go no further — in
 * particular it must not construct a service-role client.
 */
export async function requireStaff(req, { permission } = {}) {
  if (!SUPABASE_URL || !ANON_KEY) {
    return { ok: false, status: 500, error: 'Supabase is not configured on the server.' };
  }

  const user = await callerUser(req?.headers?.authorization);
  if (!user) {
    return { ok: false, status: 401, code: 'FORBIDDEN', error: 'Sign in to continue.' };
  }

  const rpc = await fetchStaffContext(user);

  // Only a MISSING function earns a second look. A timeout or a denial must not
  // be answered by consulting a weaker check.
  const legacy = rpc.missing ? await legacyIsAdmin(user) : null;

  const verdict = staffAuthVerdict({ rpc, permission, legacyIsAdmin: legacy });

  if (verdict.legacy) {
    console.warn(
      `[staffAuth] my_staff_context() is missing — fell back to profiles.is_admin for "${permission}". `
      + 'Run db/2026-08-25-staff-authorization.sql (#45).',
    );
  } else if (verdict.degraded) {
    console.warn(`[staffAuth] staff context unavailable — denying "${permission}" for ${user.id}`);
  }

  if (!verdict.allow) {
    return {
      ok: false,
      status: verdict.status,
      code: verdict.code,
      error: verdict.degraded
        ? 'Could not verify your staff permissions. No changes were made.'
        : 'You do not have permission to do that.',
      user,
    };
  }

  return { ok: true, status: 200, user, context: verdict.context, legacy: verdict.legacy };
}

/**
 * Ask whether the caller may manage one specific course, with THEIR OWN JWT.
 *
 * For course-scoped handlers, holding `courses.manage_assigned` is necessary but
 * not sufficient — the assignment is what makes it specific. can_manage_course()
 * is the same function the RLS policies call, so this cannot drift from them.
 *
 * ★ TRI-STATE: `true` | `false` | `'unavailable'`.
 *   can_manage_course() is created by **#46**, not #45. The first version of this
 *   returned `false` when the RPC was missing, which read as "denied" — so
 *   between the two migrations EVERY course-scoped trainer action returned 403
 *   for everyone, Super Admin included. A whole feature went dark ahead of its
 *   dependency. `'unavailable'` lets courseScopeVerdict() distinguish "the
 *   ownership model says no" from "there is no ownership model yet", and fall
 *   through to the capability check only for a `courses.manage_all` holder.
 */
export async function callerCanManageCourse(user, courseId) {
  if (!user || !courseId) return 'unavailable';
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/can_manage_course`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_course_id: courseId }),
    });
    if (r.status === 404) return 'unavailable';        // #46 has not run yet
    if (!r.ok) return 'unavailable';                   // denied ≠ broken; fail safe upward
    return (await r.json()) === true;
  } catch {
    return 'unavailable';
  }
}

/**
 * The service-role client. Construct it ONLY after requireStaff() returned ok.
 *
 * The key is read at module load, but the CLIENT is built here — the invariant
 * every admin handler documents is about the client, and keeping construction
 * behind a function call is what makes "after the gate" reviewable.
 */
export function service() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Is the server configured to do privileged work at all? */
export function serviceConfigured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}
