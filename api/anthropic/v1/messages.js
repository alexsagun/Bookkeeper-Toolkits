// Vercel serverless proxy for the Anthropic Messages API — AUTHENTICATED.
//
// EXACT-PATH function: it lives at api/anthropic/v1/messages.js so it answers
// `/api/anthropic/v1/messages` directly. The browser app calls
// `https://api.anthropic.com/v1/messages`; the fetch shim in src/main.jsx rewrites
// that to this path, and callClaude() attaches the caller's Supabase session token.
// The function injects ANTHROPIC_API_KEY server-side, so the key never reaches the
// browser — AND it now requires a valid session + an active membership (or admin)
// before spending a token, so the endpoint is no longer an open, abusable proxy.
//
// Env: ANTHROPIC_API_KEY (server), VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (public).
// Locally, `npm run dev` uses the Vite dev proxy (vite.config.js) which does NOT run
// this auth check — dev is local and uses the developer's own key.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

const ALLOWED_MODELS = new Set(['claude-sonnet-4-6']);
const MAX_TOKENS_CAP = 8192;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // vision base64 headroom

// Best-effort per-user rate limit. Serverless caveat: this Map lives per warm instance,
// so it is NOT a hard global cap (cold starts / parallel instances each get their own
// window) — it exists to stop a runaway client loop or a scripted burst from burning
// tokens, not to be a billing boundary. Membership gating + MAX_TOKENS_CAP remain the
// real cost controls. 20/min is far above any legit tool (every AI tool fires one
// request per user action; StatementConverter sends a whole PDF in a single call).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 20;
const RATE_MAX_TRACKED_USERS = 500;
const rateHits = new Map(); // userId -> [timestamps]

function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  // Opportunistic prune so a warm instance never grows unbounded.
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

// Cost control: is_enrolled() is SECURITY DEFINER on auth.uid() and returns true for admins
// or active-subscription members. Returns true / false, or null when the RPC is missing
// (pre-enrollment migration) — in which case the valid-JWT check above is the gate.
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
      // RPC absent (pre-enrollment migration) or errored → indeterminate. We fail OPEN
      // for availability (the valid-JWT check stays the gate), but loudly: a persistent
      // stream of these warnings in the Vercel logs means membership gating is OFF.
      console.warn(`[anthropic-proxy] is_enrolled indeterminate (${r.status}) — failing open`);
      return null;
    }
    const v = await r.json();
    return v === true;
  } catch (err) {
    console.warn(`[anthropic-proxy] is_enrolled check failed — failing open: ${String(err)}`);
    return null;
  }
}

export default async function handler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Health check — GET returns deploy/key status with NO Anthropic call (zero token cost).
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, hasKey: Boolean(apiKey) });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set in the environment.' });
  }

  // ── Auth gate: a valid Supabase session is required (closes the open-proxy abuse) ──
  const authz = req.headers.authorization || req.headers.Authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  const caller = await verifyCaller(token);
  if (!caller.ok) {
    return res.status(401).json({ error: 'Sign in to use AI features.' });
  }
  // Membership gate: only paying members / admins spend tokens (best-effort — see helper).
  const enrolled = await callerEnrolled(token);
  if (enrolled === false) {
    return res.status(403).json({ error: 'An active membership is required to use AI features.' });
  }
  // Burst guard (per-instance best-effort — see rateLimited above). callClaude surfaces
  // this message in each tool's existing error state, so no client change is needed.
  if (rateLimited(caller.userId)) {
    return res.status(429).json({ error: 'Too many AI requests — wait a minute and try again.' });
  }

  // ── Input caps ──
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request too large.' });
  }
  let parsed;
  try {
    parsed = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (parsed.model && !ALLOWED_MODELS.has(parsed.model)) {
    return res.status(400).json({ error: `Model not allowed: ${parsed.model}` });
  }
  if (typeof parsed.max_tokens === 'number' && parsed.max_tokens > MAX_TOKENS_CAP) {
    return res.status(400).json({ error: `max_tokens exceeds the cap of ${MAX_TOKENS_CAP}.` });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: rawBody,
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(`[anthropic-proxy] ${upstream.status}: ${text.slice(0, 500)}`);
    }
    res.status(upstream.status);
    res.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/json'
    );
    return res.send(text);
  } catch (err) {
    return res
      .status(502)
      .json({ error: 'Proxy request to Anthropic failed', detail: String(err) });
  }
}
