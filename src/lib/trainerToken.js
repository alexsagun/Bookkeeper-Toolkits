// ─────────────────────────────────────────────────────────────────────────────
// trainerToken.js — PURE, dependency-free trainer-session-token codec.
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the signed-url mint (api/elevenlabs/signed-url.js), the trainer
// webhook (api/elevenlabs/trainer.js), and the node:test suite
// (test/trainerToken.test.mjs). NO imports, NO side effects, NO node:crypto —
// the HMAC and the timing-safe compare are INJECTED by the caller, so every
// claim/expiry/audience rule here is testable without I/O.
//
// Token shape: base64url(JSON claims) + '.' + base64url(HMAC-SHA256(payload)).
// Claims: { v: 1, sub: <user uuid>, aud: 'bk-trainer-tools', iat, exp, jti }.
// The token carries IDENTITY ONLY — never a plan/entitlement claim. Every
// trainer-tool request re-queries live membership + course entitlement in
// Supabase; a replay inside the short TTL grants nothing a fresh Supabase JWT
// wouldn't (and expiry ends it). It rides the ElevenLabs `secret__` dynamic
// variable into webhook tool HEADERS only — never into the LLM context.
// ─────────────────────────────────────────────────────────────────────────────

export const TRAINER_TOKEN_AUD = 'bk-trainer-tools';
export const TRAINER_TOKEN_TTL_SEC = 900;   // 15 min — covers the 600s max session + connect slack
export const TRAINER_TOKEN_SKEW_SEC = 60;   // tolerated clock skew on iat/exp

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UTF-8 → base64url, pure JS (TextEncoder exists in Node ≥11 and every browser).
export function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(String(str));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 3) << 4) | (b1 == null ? 0 : b1 >> 4)];
    if (b1 != null) out += B64URL_ALPHABET[((b1 & 15) << 2) | (b2 == null ? 0 : b2 >> 6)];
    if (b2 != null) out += B64URL_ALPHABET[b2 & 63];
  }
  return out;
}

// base64url → UTF-8 string, or null on any malformed input (never throws).
export function b64urlDecodeUtf8(b64) {
  if (typeof b64 !== 'string' || /[^A-Za-z0-9\-_]/.test(b64)) return null;
  if (b64 === '') return '';
  if (b64.length % 4 === 1) return null;
  const idx = (ch) => B64URL_ALPHABET.indexOf(ch);
  const bytes = [];
  for (let i = 0; i < b64.length; i += 4) {
    const c0 = idx(b64[i]);
    const c1 = i + 1 < b64.length ? idx(b64[i + 1]) : -1;
    const c2 = i + 2 < b64.length ? idx(b64[i + 2]) : -1;
    const c3 = i + 3 < b64.length ? idx(b64[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) return null;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) bytes.push(((c2 & 3) << 6) | c3);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Canonical claims object (stable key order → stable signing input).
export function buildTrainerClaims({ userId, nowSec, ttlSec = TRAINER_TOKEN_TTL_SEC, aud = TRAINER_TOKEN_AUD, jti = '' }) {
  const iat = Math.floor(Number(nowSec) || 0);
  return {
    v: 1,
    sub: String(userId || ''),
    aud: String(aud),
    iat,
    exp: iat + Math.max(1, Math.floor(Number(ttlSec) || TRAINER_TOKEN_TTL_SEC)),
    jti: String(jti || ''),
  };
}

// hmacB64url(input) must return base64url(HMAC-SHA256(secret, input)).
export function mintTrainerToken(claims, hmacB64url) {
  const payload = b64urlEncodeUtf8(JSON.stringify(claims));
  return `${payload}.${hmacB64url(payload)}`;
}

// Verify shape → signature (timing-safe, injected) → claims. Returns
// { ok: true, claims } or { ok: false, reason } with reason one of:
// 'malformed' | 'bad_sig' | 'bad_aud' | 'bad_sub' | 'not_yet_valid' | 'expired'.
export function verifyTrainerToken(token, { nowSec, aud = TRAINER_TOKEN_AUD, skewSec = TRAINER_TOKEN_SKEW_SEC } = {}, hmacB64url, timingSafeEq) {
  if (typeof token !== 'string' || token.length < 3 || token.length > 4096) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmacB64url(payload);
  if (!timingSafeEq(sig, expected)) return { ok: false, reason: 'bad_sig' };
  const json = b64urlDecodeUtf8(payload);
  if (json == null) return { ok: false, reason: 'malformed' };
  let claims;
  try {
    claims = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims || typeof claims !== 'object' || claims.v !== 1) return { ok: false, reason: 'malformed' };
  if (claims.aud !== aud) return { ok: false, reason: 'bad_aud' };
  if (!isUuid(claims.sub)) return { ok: false, reason: 'bad_sub' };
  const now = Math.floor(Number(nowSec) || 0);
  const skew = Math.max(0, Math.floor(Number(skewSec) || 0));
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return { ok: false, reason: 'malformed' };
  if (claims.iat - skew > now) return { ok: false, reason: 'not_yet_valid' };
  if (claims.exp + skew <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
