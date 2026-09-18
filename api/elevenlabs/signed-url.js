// Vercel serverless endpoint that mints an ElevenLabs Conversational-AI signed URL
// for the in-app voice assistant (Toolkits Siri) — AUTHENTICATED and FAIL-CLOSED.
//
// GET  → unauthenticated health check: { ok, configured }. No auth, no network call.
//        The client FAB keys off `configured` — unset env vars simply hide the widget.
// POST → mint. Every step refuses rather than guesses:
//          1. ElevenLabs configured?    no → 200 { ok:false, skipped }   (feature off)
//          2. verify the Supabase JWT   definite 401/403 → 401
//                                       network error / timeout / 5xx → 503
//          3. per-user rate limit       → 429, BEFORE any RPC
//          4. is_enrolled() and my_staff_context(), IN PARALLEL, with the CALLER's JWT
//          5. voiceSessionVerdict()     allow → mint · deny → 403 · unavailable → 503
//
// ★ THIS ENDPOINT FAILS CLOSED, AND THAT REVERSES ITS ORIGINAL DESIGN.
//   It used to treat an indeterminate is_enrolled() as a pass ("the valid JWT is
//   the gate"), and it had no staff arm. Both halves were wrong in production:
//     - a NON-member — a lapsed student included — got a metered ElevenLabs
//       session whenever Supabase was slow, because an error read as "yes";
//     - an ACTIVE Operations Admin or Trainer was refused outright, because
//       is_enrolled() is false for a staff account with no subscription.
//   Every POST that gets past this gate mints a METERED voice session AND an
//   identity-bearing trainer token, so an unverifiable caller is refused with a
//   503 + Retry-After instead. The stated trade: a Supabase outage now takes the
//   widget down rather than opening it to every signed-in account. It is softened
//   by one retry per check, a 2-second bound on every attempt, and honest copy.
//   The decision itself lives in voiceSessionVerdict() (src/lib/voiceAccess.js),
//   whose docstring is the full rationale — this file only fetches facts.
//
// ★ api/anthropic/v1/messages.js DELIBERATELY STAYS FAIL-OPEN and is not changed
//   here. Its worst case under an outage is some spent tokens on a request that
//   still needed a valid session; this one hands out a long-lived paid voice
//   session and a trainer token. Same inputs, different blast radius, so the two
//   gates now disagree on purpose. Do not "unify" them in either direction.
//
// ★ THIS ENDPOINT NEVER READS OR SENDS A SERVICE-ROLE KEY. Both RPCs are
//   auth.uid()-scoped SECURITY DEFINER functions already granted to
//   `authenticated`, so the caller's own JWT is the only credential they need —
//   and it means neither call can be asked about anybody else. It also does NOT
//   import api/_lib/staffAuth.js: that module constructs service-role clients,
//   and pulling its module scope in here would put the service key one import
//   away from an endpoint that must never hold it.
//
// Env: ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID (server-only, never VITE_-prefixed),
//      optional ELEVENLABS_SERVER_LOCATION ('us' | 'eu-residency' | 'in-residency' or a
//      full https base URL), VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (public; the
//      unprefixed SUPABASE_URL / SUPABASE_ANON_KEY are accepted as fallbacks), and
//      optional TRAINER_TOKEN_SECRET.
// Under `npm run dev` this handler IS executed via the elevenlabsDevApi middleware in
// vite.config.js (unlike the notify-* functions) — dev runs the same gate as prod.
// Pinned by test/voiceSignedUrl.test.mjs, which drives this handler with a stubbed
// fetch; the decision table itself is pinned by test/voiceAccess.test.mjs.

import crypto from 'node:crypto';
import { buildTrainerClaims, mintTrainerToken } from '../../src/lib/trainerToken.js';
import { staffContextFromRpc } from '../../src/lib/staffRoles.js';
import { VOICE_SESSION, voiceSessionVerdict } from '../../src/lib/voiceAccess.js';

// ★ ENV IS READ PER REQUEST, NEVER AT MODULE LOAD. A module-scope constant freezes
//   whatever process.env held the first time this file was imported, and two
//   callers set it afterwards: test/voiceSignedUrl.test.mjs sets and clears
//   variables between cases against ONE imported handler, and the elevenlabsDevApi
//   bridge in vite.config.js copies .env values into process.env inside the
//   request itself. Reading here is a handful of property lookups per request.
function readEnv() {
  return {
    supabaseUrl: (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    anonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    agentId: process.env.ELEVENLABS_AGENT_ID || '',
    trainerSecret: process.env.TRAINER_TOKEN_SECRET || '',
  };
}

// ── Response copy ──
// ★ The `error` strings are load-bearing: the DEPLOYED client renders body.error
//   verbatim, so an old bundle that knows nothing about `code` still tells the
//   user something true. `code` is for the new client and for the logs.
const SIGN_IN_MESSAGE = 'Sign in to use the voice assistant.';
const FORBIDDEN_MESSAGE = 'An active membership is required to use the voice assistant.';
const UNAVAILABLE_MESSAGE = 'Voice sessions are temporarily unavailable — we could not verify your access. Please try again in a moment.';
const RATE_LIMITED_MESSAGE = 'Too many voice sessions — wait a minute and try again.';
const START_FAILED_MESSAGE = 'Could not start a voice session — try again shortly.';

// ── Timing budget ──
// One retry per RPC, each attempt bounded. Both RPCs run in parallel, so the
// worst case the access check adds is two attempts (~4 s), not four.
const RPC_ATTEMPTS = 2;
const RPC_ATTEMPT_TIMEOUT_MS = 2000;
const AUTH_TIMEOUT_MS = 3000;

// The back-off a failed session verification advertises. Read from the verdict
// module rather than retyped, so the auth-step 503 and the RPC-step 503 can never
// tell a client two different stories about when to come back.
const UNAVAILABLE_RETRY_AFTER_SECS = voiceSessionVerdict({ enrolled: null, staff: null }).retryAfterSecs;

// The AI-course-trainer session token (see api/elevenlabs/trainer.js). Minted
// here right after a signed URL is issued to an already-authorized caller, so the
// browser gets both in one round trip. Server-only secret; unset = the trainer
// webhook tools simply report "not configured" and the rest of the widget is
// unaffected. The token carries IDENTITY only — every trainer request re-checks
// live entitlement fail-closed against trainer_visible_courses(). Minting it is
// one of the two reasons this gate fails closed (see the header).
function mintTrainerSessionToken(secret, userId) {
  if (!secret || !userId) return null;
  const claims = buildTrainerClaims({
    userId,
    nowSec: Math.floor(Date.now() / 1000),
    // Opaque per-mint id (logging/uniqueness only — NOT tracked for replay defense; the token
    // is identity-only and every trainer call re-authorizes live membership, see trainerToken.js).
    jti: crypto.randomBytes(8).toString('hex'),
  });
  const hmacB64url = (input) => crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return mintTrainerToken(claims, hmacB64url);
}

const LOCATION_BASES = {
  us: 'https://api.elevenlabs.io',
  'eu-residency': 'https://api.eu.residency.elevenlabs.io',
  'in-residency': 'https://api.in.residency.elevenlabs.io',
};

// Also imported by api/admin/course-trainer.js (Scribe transcription) — keep the export.
export function elevenLabsApiBase() {
  const loc = (process.env.ELEVENLABS_SERVER_LOCATION || '').trim();
  if (!loc) return LOCATION_BASES.us;
  if (/^https:\/\//i.test(loc)) return loc.replace(/\/+$/, '');
  return LOCATION_BASES[loc.toLowerCase()] || LOCATION_BASES.us;
}

// Best-effort per-user rate limit (per warm instance — same caveat as the Anthropic
// proxy). 8/min allows legit reconnects/retries while stopping a scripted mint loop;
// the ElevenLabs dashboard's max-call-duration cap is the other half of cost control.
// ★ It runs BEFORE the two access RPCs, so a refused caller in a loop costs one auth
//   round trip per attempt rather than three. The price is that denied and
//   unavailable attempts count toward the limit too — which is the point.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 8;
const RATE_MAX_TRACKED_USERS = 500;
const rateHits = new Map(); // userId -> [timestamps]

function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  if (rateHits.size > RATE_MAX_TRACKED_USERS) {
    for (const [uid, hits] of rateHits) {
      if (!hits.length || hits[hits.length - 1] < cutoff) rateHits.delete(uid);
    }
  }
  const hits = (rateHits.get(userId) || []).filter((t) => t >= cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) {
    rateHits.set(userId, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(userId, hits);
  return false;
}

function bearerToken(req) {
  const authz = req?.headers?.authorization || req?.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
  return m ? m[1].trim() : '';
}

// A value safe to put in a log line: a short machine code, or null. Never a
// message, never a body — those can carry addresses, tokens or signed URLs.
function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;
}

/**
 * Verify the Supabase JWT against the auth server.
 *
 * Returns { state: 'ok', userId } | { state: 'unauthorized' } |
 * { state: 'unavailable', reason }.
 *
 * ★ "THE AUTH SERVER SAID NO" AND "THE AUTH SERVER DID NOT ANSWER" ARE DIFFERENT
 *   FACTS. The old verifyCaller() collapsed both into 401, so a Supabase blip told
 *   a signed-in member to sign in again. Only a definite refusal is a 401; a
 *   network error, a timeout, a 5xx (or a 408/429 — both "try later") is a 503.
 *   Neither grants anything.
 */
async function verifyCaller(env, token) {
  let r;
  try {
    r = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (err) {
    return { state: 'unavailable', reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  if (!r.ok) {
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      return { state: 'unavailable', reason: `http_${r.status}` };
    }
    return { state: 'unauthorized' };
  }
  let user;
  try {
    user = await r.json();
  } catch {
    return { state: 'unavailable', reason: 'malformed' };
  }
  // A 200 that names no user is not a verified identity — and not a verdict on
  // the caller's session either, so it is not a 401.
  return user && typeof user.id === 'string' && user.id
    ? { state: 'ok', userId: user.id }
    : { state: 'unavailable', reason: 'malformed' };
}

/**
 * One bounded attempt at POST /rest/v1/rpc/<fn> with the CALLER's JWT.
 * Returns { ok: true, status, data } or { ok: false, status, kind }. Never throws.
 */
async function rpcAttempt(env, token, fn) {
  let r;
  try {
    r = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(RPC_ATTEMPT_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, kind: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  if (!r.ok) return { ok: false, status: r.status, kind: 'http' };
  try {
    return { ok: true, status: r.status, data: await r.json() };
  } catch (err) {
    // The timeout signal also bounds reading the body.
    return { ok: false, status: r.status, kind: err?.name === 'TimeoutError' ? 'timeout' : 'malformed' };
  }
}

/**
 * is_enrolled() → true / false, or null when no clean boolean arrived after the retry.
 *
 * is_enrolled() is SECURITY DEFINER on auth.uid() and returns true for admins and
 * active-subscription members. ★ null is NOT a pass. It used to be.
 */
async function callerEnrolled(env, token) {
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt += 1) {
    const out = await rpcAttempt(env, token, 'is_enrolled');
    if (out.ok && typeof out.data === 'boolean') return out.data;
  }
  return null;
}

/**
 * my_staff_context() → a staffContextFromRpc() result: { context, degraded, missing }.
 *
 * The same call api/_lib/staffAuth.js makes, copied rather than imported (see the
 * header). Read LIVE on every request — never cached — which is what makes a
 * suspension take effect on the very next mint.
 *
 * ★ A 404 IS AN ANSWER, NOT AN OUTAGE. PostgREST answers a function that does not
 *   exist with 404 (PGRST202): a pre-#45 database with no staff model at all.
 *   staffContextFromRpc() classifies it `missing`, which voiceSessionVerdict()
 *   reads as a definite "not staff" — so it is not retried either.
 *
 * ★ A FAILURE CARRIES ONLY A STATUS, NEVER THE RESPONSE TEXT. staffContextFromRpc()
 *   also recognises a missing function by MESSAGE (/schema cache/), and PostgREST's
 *   PGRST002 outage answer is literally "Could not query the database for the
 *   schema cache" — passing that body through would reclassify an outage as a
 *   definite negative and turn a 503 into a 403. It would also put a response body
 *   one log line away from a logger.
 */
async function callerStaffContext(env, token) {
  let last = null;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt += 1) {
    const out = await rpcAttempt(env, token, 'my_staff_context');
    // The function always returns a jsonb object; anything else is not a clean answer.
    if (out.ok && out.data && typeof out.data === 'object') {
      return staffContextFromRpc({ data: out.data, error: null });
    }
    if (!out.ok && out.status === 404) {
      return staffContextFromRpc({ data: null, error: { code: 'PGRST202', message: '' } });
    }
    last = out;
  }
  const code = last && last.status ? String(last.status) : (last && last.kind) || 'unavailable';
  return staffContextFromRpc({ data: null, error: { code, message: '' } });
}

function sendUnavailable(res, retryAfterSecs) {
  res.setHeader('Retry-After', String(retryAfterSecs));
  return res.status(503).json({ error: UNAVAILABLE_MESSAGE, code: 'VOICE_CHECK_UNAVAILABLE' });
}

export default async function handler(req, res) {
  const env = readEnv();
  const configured = Boolean(env.apiKey && env.agentId);

  // Health check — GET reports configuration only (no auth, no network call).
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, configured });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  if (!configured) {
    // Same graceful-degrade convention as the notify-* functions: the feature is
    // simply off when env vars are unset — not an error.
    return res.status(200).json({ ok: false, skipped: 'elevenlabs_not_configured' });
  }

  // ── 1. Who is calling ──
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: SIGN_IN_MESSAGE });
  }
  if (!env.supabaseUrl || !env.anonKey) {
    // The server cannot verify anyone. That is not the caller's fault, so it is not
    // a 401 — and it is certainly not a pass.
    console.warn('[elevenlabs] Supabase is not configured on the server — refusing (503)');
    return sendUnavailable(res, UNAVAILABLE_RETRY_AFTER_SECS);
  }
  const caller = await verifyCaller(env, token);
  if (caller.state === 'unauthorized') {
    return res.status(401).json({ error: SIGN_IN_MESSAGE });
  }
  if (caller.state !== 'ok') {
    console.warn('[elevenlabs] session verification indeterminate — refusing (503)', { reason: caller.reason });
    return sendUnavailable(res, UNAVAILABLE_RETRY_AFTER_SECS);
  }

  // ── 2. How often ── (before any RPC — see rateLimited)
  if (rateLimited(caller.userId)) {
    return res.status(429).json({ error: RATE_LIMITED_MESSAGE });
  }

  // ── 3. What may they do ── both checks, in parallel, with the caller's own JWT.
  const [enrolled, staff] = await Promise.all([
    callerEnrolled(env, token),
    callerStaffContext(env, token),
  ]);
  const verdict = voiceSessionVerdict({ enrolled, staff });

  if (verdict.decision === VOICE_SESSION.UNAVAILABLE) {
    console.warn('[elevenlabs] voice access indeterminate — refusing (503)', { checks: verdict.indeterminate });
    return sendUnavailable(res, verdict.retryAfterSecs || UNAVAILABLE_RETRY_AFTER_SECS);
  }
  // ★ Only an explicit ALLOW mints. DENY — and any decision this file does not
  //   recognise — is a 403.
  if (verdict.decision !== VOICE_SESSION.ALLOW) {
    return res.status(403).json({ error: FORBIDDEN_MESSAGE, code: 'VOICE_FORBIDDEN' });
  }

  // ── 4. Mint ──
  try {
    const upstream = await fetch(
      `${elevenLabsApiBase()}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(env.agentId)}`,
      { headers: { 'xi-api-key': env.apiKey } }
    );
    const text = await upstream.text();
    if (!upstream.ok) {
      // Log the status and ElevenLabs' short machine code only. The body is never
      // logged and never echoed to the browser.
      let upstreamCode = null;
      try {
        upstreamCode = safeCode(JSON.parse(text)?.detail?.status);
      } catch { /* not JSON — the status alone will do */ }
      console.error('[elevenlabs] signed-url upstream refused', { status: upstream.status, code: upstreamCode });
      return res
        .status(upstream.status === 429 ? 429 : 502)
        .json({ error: START_FAILED_MESSAGE });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[elevenlabs] signed-url upstream returned non-JSON', { status: upstream.status });
      return res.status(502).json({ error: START_FAILED_MESSAGE });
    }
    if (!data || typeof data.signed_url !== 'string' || !data.signed_url) {
      console.error('[elevenlabs] signed-url upstream response had no signed_url', { status: upstream.status });
      return res.status(502).json({ error: START_FAILED_MESSAGE });
    }
    const trainerToken = mintTrainerSessionToken(env.trainerSecret, caller.userId);
    return res.status(200).json({ signedUrl: data.signed_url, ...(trainerToken ? { trainerToken } : {}) });
  } catch (err) {
    // Generic to the browser; the error's name and code (never its message) to the log.
    console.error('[elevenlabs] signed-url request failed', {
      name: safeCode(err?.name) || 'Error',
      code: safeCode(err?.cause?.code) || safeCode(err?.code),
    });
    return res.status(502).json({ error: START_FAILED_MESSAGE });
  }
}
