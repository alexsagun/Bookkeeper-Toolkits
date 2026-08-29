// ─────────────────────────────────────────────────────────────────────────────
// test/tokenLeakage.test.mjs — the one-time invitation token stays a secret (#50).
// ─────────────────────────────────────────────────────────────────────────────
// The token is minted by generateLink(), carried in a URL FRAGMENT (never a query
// string — a fragment is not sent to servers, so it cannot land in a Vercel log or
// a Referer), exchanged exactly once by supabase.auth.verifyOtp(), and discarded.
//
// That property is an agreement between several files, and nothing enforced it:
// one `console.log(invite)` while debugging, one `?invite=` instead of `#invite=`,
// one `window.storage.set('invite', …)` and the secret is in a log, a history
// entry, or localStorage. This suite is a SOURCE SCAN — crude on purpose, because
// the rule itself is crude: the token appears in exactly the places listed here
// and nowhere else.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const app = read('src/BookkeeperPro.jsx');
const staffApi = read('api/admin/staff.js');
const inviteLib = read('src/lib/staffInvite.js');
const inviteEmail = read('api/_lib/staffInviteEmail.js');
const emailLib = read('api/_lib/email.js');
const migration50 = read('db/2026-08-30-staff-activation-consistency.sql');
const migration49 = read('db/2026-08-29-staff-invitation-acceptance.sql');

/** Lines that mention the invite token in any form. */
function tokenLines(src) {
  return src.split('\n').filter((l) => /token_hash|tokenHash|hashed_token|invite\.token|tokenRef/.test(l));
}

/**
 * Slice the region between two anchors, ASSERTING both were found first.
 *
 * ★ WHY THIS IS NOT JUST src.slice(indexOf(a), indexOf(b)). String.slice() reads a
 *   negative index as an offset from the END, so a missing anchor silently widens
 *   the region instead of failing. Rename `INITIAL_STAFF_INVITE` and the first scan
 *   below would slice nearly the whole 24k-line file, find `history.replaceState`
 *   somewhere unrelated, and PASS — reporting success while inspecting the wrong
 *   code. A source scan that can pass for the wrong reason is worse than no scan,
 *   because it is the only thing enforcing this rule. (CodeRabbit, PR #5.)
 *
 * @param {string} src
 * @param {string} from   anchor the region starts at (searched from the end when `last`)
 * @param {string} to     anchor the region ends at, searched AFTER `from`
 */
function region(src, from, to, { last = false } = {}) {
  const start = last ? src.lastIndexOf(from) : src.indexOf(from);
  assert.ok(start >= 0, `anchor not found, so this scan would prove nothing: ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `closing anchor not found after "${from}", so the slice would be wrong: ${to}`);
  return src.slice(start, end);
}

// ── The browser ──────────────────────────────────────────────────────────────

test('the token is never logged in the browser', () => {
  for (const line of tokenLines(app)) {
    assert.ok(!/console\.(log|warn|error|debug|info)/.test(line),
      `token on a console line: ${line.trim()}`);
  }
});

test('the token never reaches window.storage, localStorage or sessionStorage', () => {
  for (const line of tokenLines(app)) {
    assert.ok(!/window\.storage|localStorage|sessionStorage/.test(line),
      `token near a storage call: ${line.trim()}`);
  }
});

test('the URL is stripped of the fragment before anything else can read it', () => {
  // readStaffInviteFromUrl() must strip inside the same function that parses.
  const fn = region(app, 'function readStaffInviteFromUrl', 'const INITIAL_STAFF_INVITE');
  assert.match(fn, /history\.replaceState/, 'the strip is what keeps the token out of bookmarks and Back entries');
  assert.match(fn, /window\.location\.pathname \+ window\.location\.search/,
    'path and query survive; only the fragment goes');
});

test('the redeemed root state carries NO token', () => {
  // markStaffInviteRedeemed must null the secret while keeping the redeemed fact.
  const fn = region(app, 'const markStaffInviteRedeemed', '}, []');
  assert.match(fn, /token: null/, 'the secret must leave root state the moment it is spent');
  assert.match(fn, /redeemed: true/, 'while the FACT of a token this session keeps pinning the gate');
});

test('the component holds the secret in a ref and clears it on spend', () => {
  assert.match(app, /const tokenRef = useRef/, 'a ref, not state — never in a devtools state dump');
  assert.match(app, /tokenRef\.current = null/, 'and it is cleared');
});

test('the exchange is the only browser call the token reaches', () => {
  // Every read of tokenRef/invite.token must be either the verifyOtp call site,
  // the ref's own initialisation, or a null-out.
  const uses = tokenLines(app).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  for (const line of uses) {
    const ok = /verifyOtp|useRef|tokenRef\.current = null|tokenRef\.current;|token: null|invite && invite\.token|parseInviteHash|token_hash: tok\.token/.test(line)
      || /tokenSpent|TokenSpent|hasToken/.test(line); // booleans about the token, not the token
    assert.ok(ok, `unexpected token use: ${line.trim()}`);
  }
});

// ── The URL format ───────────────────────────────────────────────────────────

test('the link builder puts the token in the fragment, never the query', () => {
  assert.match(inviteLib, /#invite=/, 'fragment');
  assert.ok(!/\?invite=/.test(inviteLib), 'a query string reaches servers, logs and Referers');
});

// ── The server ───────────────────────────────────────────────────────────────

test('the API never logs the token', () => {
  for (const line of tokenLines(staffApi)) {
    assert.ok(!/console\./.test(line), `token on a console line: ${line.trim()}`);
  }
});

test('the API extracts hashed_token, never the self-consuming action_link', () => {
  assert.match(staffApi, /properties\?\.hashed_token/);
  const code = staffApi.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|★)/.test(l)).join('\n');
  assert.ok(!/properties\?\.action_link|properties\.action_link/.test(code),
    'action_link is consumed on GET — a mail-scanner prefetch burns it');
});

test('the token appears in no API response body', () => {
  // Every res.status(...).json({...}) payload must be free of the token vars.
  const jsonCalls = staffApi.match(/res\.status\([^)]*\)\.json\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(jsonCalls.length > 10, 'expected to find the response sites');
  for (const call of jsonCalls) {
    assert.ok(!/tokenHash|hashed_token|actionUrl/.test(call),
      `token or link in a response: ${call.slice(0, 80)}…`);
  }
});

test('the email builders receive the URL and nothing else stores it', () => {
  assert.ok(!/console\./.test(tokenLines(inviteEmail).join('')), 'no logging in the builder');
  assert.ok(!/localStorage|sessionStorage|window\./.test(inviteEmail), 'pure — no browser surface at all');
});

test('the email sender never logs a link or a body', () => {
  // email.js's own contract: on failure it logs a status code only.
  const consoleLines = emailLib.split('\n').filter((l) => /console\./.test(l));
  for (const line of consoleLines) {
    assert.ok(!/html|text|payload|link|url/i.test(line.replace(/console/i, '')),
      `email log line may carry content: ${line.trim()}`);
  }
});

// ── The database ─────────────────────────────────────────────────────────────

test('no migration stores a token column', () => {
  for (const [name, sql] of [['#49', migration49], ['#50', migration50]]) {
    assert.ok(!/token_hash|hashed_token|invite_token|action_link/.test(sql),
      `${name} must not persist the credential — invite_status/invite_error_code are the only delivery state`);
  }
});

test('the resend audit row records the act, never the link', () => {
  const body = region(
    migration50, 'create or replace function public.admin_record_staff_invite', '$fn$;', { last: true },
  );
  assert.match(body, /'invite_resent'/);
  assert.ok(!/url|link|token/i.test(body.replace(/--[^\n]*/g, '').replace(/one-time credential/gi, '')),
    'the ledger must stay clean of the credential');
});
