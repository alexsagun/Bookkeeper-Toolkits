// Vercel serverless endpoint that mints an ElevenLabs Conversational-AI signed URL
// for the in-app voice assistant ("Toolkits Guide") — AUTHENTICATED.
//
// GET  → unauthenticated health check: { ok, configured } (no ElevenLabs call).
//        The client FAB keys off `configured` — unset env vars simply hide the widget.
// POST → mint: requires a valid Supabase session (Authorization: Bearer <access_token>)
//        AND an active membership or admin (is_enrolled() RPC — same gate as the
//        Anthropic proxy at api/anthropic/v1/messages.js). Every mint is a potential
//        paid ElevenLabs conversation, so this is a cost gate, not just access control.
//
// Env: ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID (server-only, never VITE_-prefixed),
//      optional ELEVENLABS_SERVER_LOCATION ('us' | 'eu-residency' | 'in-residency' or a
//      full https base URL), VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (public).
// Under `npm run dev` this handler IS executed via the elevenlabsDevApi middleware in
// vite.config.js (unlike the notify-* functions) — dev runs the same auth gate.

import crypto from 'node:crypto';
import { buildTrainerClaims, mintTrainerToken } from '../../src/lib/trainerToken.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

// The AI-course-trainer session token (see api/elevenlabs/trainer.js). Minted
// here right after a signed URL is issued to an already-verified caller, so the
// browser gets both in one round trip. Server-only secret; unset = the trainer
// webhook tools simply report "not configured" and the rest of the widget is
// unaffected. The token carries IDENTITY only — every trainer request re-checks
// live entitlement fail-closed, so it deliberately does NOT weaken this
// endpoint's existing (fail-open) membership gate.
const TRAINER_TOKEN_SECRET = process.env.TRAINER_TOKEN_SECRET || '';
function mintTrainerSessionToken(userId) {
  if (!TRAINER_TOKEN_SECRET || !userId) return null;
  const claims = buildTrainerClaims({
    userId,
    nowSec: Math.floor(Date.now() / 1000),
    // Opaque per-mint id (logging/uniqueness only — NOT tracked for replay defense; the token
    // is identity-only and every trainer call re-authorizes live membership, see trainerToken.js).
    jti: crypto.randomBytes(8).toString('hex'),
  });
  const hmacB64url = (input) => crypto.createHmac('sha256', TRAINER_TOKEN_SECRET).update(input).digest('base64url');
  return mintTrainerToken(claims, hmacB64url);
}

const LOCATION_BASES = {
  us: 'https://api.elevenlabs.io',
  'eu-residency': 'https://api.eu.residency.elevenlabs.io',
  'in-residency': 'https://api.in.residency.elevenlabs.io',
};

export function elevenLabsApiBase() {
  const loc = (process.env.ELEVENLABS_SERVER_LOCATION || '').trim();
  if (!loc) return LOCATION_BASES.us;
  if (/^https:\/\//i.test(loc)) return loc.replace(/\/+$/, '');
  return LOCATION_BASES[loc.toLowerCase()] || LOCATION_BASES.us;
}

// Best-effort per-user rate limit (per warm instance — same caveat as the Anthropic
// proxy). 8/min allows legit reconnects/retries while stopping a scripted mint loop;
// the ElevenLabs dashboard's max-call-duration cap is the other half of cost control.
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

// Validate the Supabase JWT against the auth server. Returns { ok, userId }.
async function verifyCaller(token) {
  if (!token || !SUPABASE_URL || !ANON_KEY) return { ok: false };
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { ok: false };
    const u = await r.json();
    return u && u.id ? { ok: true, userId: u.id } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// is_enrolled() is SECURITY DEFINER on auth.uid() and returns true for admins or
// active-subscription members. Returns true / false, or null when the RPC is missing
// or errored — fail OPEN on null (valid JWT stays the gate), but loudly: a stream of
// these warnings in the Vercel logs means the membership gate is off.
async function callerEnrolled(token) {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_enrolled`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!r.ok) {
      console.warn(`[elevenlabs] is_enrolled indeterminate (${r.status}) — failing open`);
      return null;
    }
    const v = await r.json();
    return v === true;
  } catch (err) {
    console.warn(`[elevenlabs] is_enrolled check failed — failing open: ${String(err)}`);
    return null;
  }
}

export default async function handler(req, res) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const configured = Boolean(apiKey && agentId);

  // Health check — GET reports configuration only (no auth, no ElevenLabs call).
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

  // ── Auth gate ──
  const authz = req.headers.authorization || req.headers.Authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  const caller = await verifyCaller(token);
  if (!caller.ok) {
    return res.status(401).json({ error: 'Sign in to use the voice assistant.' });
  }
  const enrolled = await callerEnrolled(token);
  if (enrolled === false) {
    return res.status(403).json({ error: 'An active membership is required to use the voice assistant.' });
  }
  if (rateLimited(caller.userId)) {
    return res.status(429).json({ error: 'Too many voice sessions — wait a minute and try again.' });
  }

  try {
    const upstream = await fetch(
      `${elevenLabsApiBase()}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey } }
    );
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(`[elevenlabs] signed-url ${upstream.status}: ${text.slice(0, 300)}`);
      return res
        .status(upstream.status === 429 ? 429 : 502)
        .json({ error: 'Could not start a voice session — try again shortly.' });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[elevenlabs] signed-url non-JSON response: ${text.slice(0, 300)}`);
      return res.status(502).json({ error: 'Could not start a voice session — try again shortly.' });
    }
    if (!data || !data.signed_url) {
      return res.status(502).json({ error: 'Could not start a voice session — try again shortly.' });
    }
    const trainerToken = mintTrainerSessionToken(caller.userId);
    return res.status(200).json({ signedUrl: data.signed_url, ...(trainerToken ? { trainerToken } : {}) });
  } catch (err) {
    return res.status(502).json({ error: 'Voice session request failed', detail: String(err) });
  }
}
