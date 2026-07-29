// Run with: node --test  (no framework — built-in node:test)
// Covers src/lib/trainerToken.js — the trainer-session-token codec used by
// api/elevenlabs/signed-url.js (mint) and api/elevenlabs/trainer.js (verify).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  TRAINER_TOKEN_AUD,
  TRAINER_TOKEN_TTL_SEC,
  TRAINER_TOKEN_SKEW_SEC,
  b64urlEncodeUtf8,
  b64urlDecodeUtf8,
  isUuid,
  buildTrainerClaims,
  mintTrainerToken,
  verifyTrainerToken,
} from '../src/lib/trainerToken.js';

const SECRET = 'test-secret-at-least-32-characters-long!!';
const NOW = 1_800_000_000; // fixed epoch seconds
const UID = '5d8f0a54-9c1e-4f4b-8a34-1c2d3e4f5a6b';

const hmac = (input) => crypto.createHmac('sha256', SECRET).update(input).digest('base64url');
const otherHmac = (input) => crypto.createHmac('sha256', 'a-different-secret-key-material!!').update(input).digest('base64url');
const timingSafeEq = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function mint(overrides = {}) {
  const claims = { ...buildTrainerClaims({ userId: UID, nowSec: NOW, jti: 'abc123' }), ...overrides };
  return { claims, token: mintTrainerToken(claims, hmac) };
}
const verify = (token, at = NOW) => verifyTrainerToken(token, { nowSec: at }, hmac, timingSafeEq);

test('b64url roundtrips utf-8 including multibyte', () => {
  for (const s of ['', 'hello', '{"a":1}', 'péso ₱ 日本語', 'a'.repeat(500)]) {
    assert.equal(b64urlDecodeUtf8(b64urlEncodeUtf8(s)), s);
  }
  assert.equal(b64urlDecodeUtf8('not base64!!'), null);
  assert.equal(b64urlDecodeUtf8('abcde'), null); // len % 4 === 1
});

test('isUuid accepts canonical uuids only', () => {
  assert.equal(isUuid(UID), true);
  assert.equal(isUuid(UID.toUpperCase()), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(null), false);
});

test('mint → verify roundtrip returns the claims', () => {
  const { claims, token } = mint();
  const res = verify(token);
  assert.equal(res.ok, true);
  assert.deepEqual(res.claims, claims);
  assert.equal(res.claims.aud, TRAINER_TOKEN_AUD);
  assert.equal(res.claims.exp, NOW + TRAINER_TOKEN_TTL_SEC);
});

test('expired token is rejected (with skew honored at the boundary)', () => {
  const { token } = mint();
  // Just inside skew after exp → still valid.
  assert.equal(verify(token, NOW + TRAINER_TOKEN_TTL_SEC + TRAINER_TOKEN_SKEW_SEC - 1).ok, true);
  // At exp + skew → expired.
  const at = verify(token, NOW + TRAINER_TOKEN_TTL_SEC + TRAINER_TOKEN_SKEW_SEC);
  assert.equal(at.ok, false);
  assert.equal(at.reason, 'expired');
});

test('not-yet-valid token beyond skew is rejected', () => {
  const { token } = mint();
  assert.equal(verify(token, NOW - TRAINER_TOKEN_SKEW_SEC).ok, true); // boundary passes
  const res = verify(token, NOW - TRAINER_TOKEN_SKEW_SEC - 1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_yet_valid');
});

test('wrong audience is rejected', () => {
  const { token } = mint({ aud: 'some-other-service' });
  const res = verify(token);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad_aud');
});

test('non-uuid sub is rejected', () => {
  const { token } = mint({ sub: 'admin' });
  const res = verify(token);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad_sub');
});

test('tampered payload fails the signature check', () => {
  const { claims } = mint();
  const forged = { ...claims, sub: 'e2e40000-0000-4000-8000-000000000000' };
  const [, sig] = mintTrainerToken(claims, hmac).split('.');
  const forgedToken = `${b64urlEncodeUtf8(JSON.stringify(forged))}.${sig}`;
  const res = verify(forgedToken);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad_sig');
});

test('token signed with a different secret is rejected', () => {
  const claims = buildTrainerClaims({ userId: UID, nowSec: NOW });
  const res = verify(mintTrainerToken(claims, otherHmac));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad_sig');
});

test('truncated signature is rejected', () => {
  const { token } = mint();
  const res = verify(token.slice(0, -4));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad_sig');
});

test('validly-signed tokens with bad claim shapes are rejected as malformed', () => {
  // These bypass buildTrainerClaims to exercise verify()'s defensive branches directly:
  // a wrong version, and a non-numeric exp — both correctly SIGNED, so the signature
  // check passes and only the claim validation can reject them.
  const signClaims = (claims) => {
    const payload = b64urlEncodeUtf8(JSON.stringify(claims));
    return `${payload}.${hmac(payload)}`;
  };
  const good = buildTrainerClaims({ userId: UID, nowSec: NOW, jti: 'x' });
  assert.equal(verify(signClaims({ ...good, v: 2 })).reason, 'malformed');       // wrong version
  assert.equal(verify(signClaims({ ...good, exp: 'soon' })).reason, 'malformed'); // non-numeric exp
  assert.equal(verify(signClaims({ ...good, iat: null })).reason, 'malformed');   // non-numeric iat
  assert.equal(verify(signClaims({ sub: UID, aud: TRAINER_TOKEN_AUD })).reason, 'malformed'); // missing v
});

test('malformed shapes are rejected without throwing', () => {
  for (const bad of [null, undefined, 42, '', 'nodot', '.leadingdot', 'trailingdot.', 'a.b.c', `${'x'.repeat(5000)}.sig`]) {
    const res = verifyTrainerToken(bad, { nowSec: NOW }, hmac, timingSafeEq);
    assert.equal(res.ok, false);
    assert.ok(['malformed', 'bad_sig'].includes(res.reason), `${String(bad).slice(0, 20)} → ${res.reason}`);
  }
  // Valid signature over a non-JSON payload → malformed (sig checked first, so
  // craft one signed correctly).
  const payload = b64urlEncodeUtf8('not json at all');
  const res = verify(`${payload}.${hmac(payload)}`);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'malformed');
});
