// test/voiceSignedUrl.test.mjs — api/elevenlabs/signed-url.js, driven end to end.
//
// test/voiceAccess.test.mjs pins voiceSessionVerdict() as a pure function. This
// suite pins that the HANDLER actually asks the right questions, in the right
// order, with the right credential, and honours the answer — which no amount of
// testing the pure function can show. Two production bugs motivate it:
//
//   1. The endpoint treated an indeterminate is_enrolled() as a PASS, so a
//      non-member got a metered ElevenLabs session whenever Supabase was slow.
//   2. It had no staff arm, so an ACTIVE Operations Admin or Trainer — for whom
//      is_enrolled() is false by design — was refused.
//
// No network: globalThis.fetch is replaced by a router keyed on URL for every
// test and restored afterwards. An unexpected URL throws AND is recorded, so a
// stray call fails the test that made it instead of reaching the internet.
//
// Rate-limit state lives at module scope in the handler, so every test uses a
// fresh caller uuid rather than a fresh import.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import handler from '../api/elevenlabs/signed-url.js';
import { verifyTrainerToken } from '../src/lib/trainerToken.js';
import { voiceSessionVerdict } from '../src/lib/voiceAccess.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SUPA = 'https://shadow-voice-test.supabase.example';
const ANON = 'anon-key-for-voice-tests';
const SERVICE_SENTINEL = 'SERVICE-ROLE-SENTINEL-must-never-leave-the-server';
const LEGACY_SERVICE_SENTINEL = 'LEGACY-SERVICE-ROLE-SENTINEL-must-never-leave';
const ELEVEN_KEY = 'xi-test-key';
const AGENT_ID = 'agent_voice_test';
const TRAINER_SECRET = 'trainer-secret-for-tests-0123456789abcdef';
const ELEVEN_URL_PREFIX = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const SIGNED_URL = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_voice_test&conversation_signature=sig';

const UNAVAILABLE_ERROR = 'Voice sessions are temporarily unavailable — we could not verify your access. Please try again in a moment.';
const FORBIDDEN_ERROR = 'An active membership is required to use the voice assistant.';
const RETRY_AFTER = String(voiceSessionVerdict({ enrolled: null, staff: null }).retryAfterSecs);

const ENV_KEYS = [
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
  'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_SERVER_LOCATION',
  'TRAINER_TOKEN_SECRET',
];

// my_staff_context() bodies, in the shape db/2026-08-29-staff-invitation-acceptance.sql returns.
const ACTIVE_OPS_ADMIN = {
  is_staff: true, role_key: 'operations_admin', role_label: 'Operations Admin', status: 'active',
  display_title: null, is_super_admin: false,
  permissions: ['access_requests.review', 'enrollments.review'], assigned_course_ids: [],
  membership: { exists: true, status: 'active', role_key: 'operations_admin' },
};
const ACTIVE_TRAINER = {
  is_staff: true, role_key: 'trainer', role_label: 'Trainer', status: 'active',
  display_title: null, is_super_admin: false,
  permissions: ['courses.manage_assigned'], assigned_course_ids: [],
  membership: { exists: true, status: 'active', role_key: 'trainer' },
};
const NOT_STAFF = { is_staff: false, membership: { exists: false } };
const SUSPENDED_TRAINER = {
  is_staff: false, role_key: null, role_label: null, status: 'suspended', display_title: null,
  is_super_admin: false, permissions: [], assigned_course_ids: [],
  membership: { exists: true, status: 'suspended', role_key: 'trainer' },
};
const REVOKED_OPS_ADMIN = {
  is_staff: false, role_key: null, role_label: null, status: 'revoked', display_title: null,
  is_super_admin: false, permissions: [], assigned_course_ids: [],
  membership: { exists: true, status: 'revoked', role_key: 'operations_admin' },
};
// The pre-#49 shape, which still carried a role and permissions for a non-active
// row. Authority must come from `status`, never from the presence of a role.
const SUSPENDED_RAW_PRE49 = {
  is_staff: true, role_key: 'operations_admin', status: 'suspended',
  permissions: ['enrollments.review'], assigned_course_ids: [],
};
const REVOKED_RAW_PRE49 = {
  is_staff: true, role_key: 'super_admin', status: 'revoked', is_super_admin: true,
  permissions: ['finance.manage'], assigned_course_ids: [],
};

// Per-attempt behaviours for a stubbed endpoint.
const THROW = Symbol('throw');      // fetch rejects, like a DNS or socket failure
const HANG = Symbol('hang');        // never answers until the request's signal aborts
const json = (body, status = 200) => ({ status, text: JSON.stringify(body) });
const http = (status, text = '') => ({ status, text });

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let savedEnv;
let savedFetch;
let savedWarn;
let savedError;
let logs;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.VITE_SUPABASE_URL = SUPA;
  process.env.VITE_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SECRET_KEY = SERVICE_SENTINEL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE_SENTINEL;
  process.env.ELEVENLABS_API_KEY = ELEVEN_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;

  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`test did not install a fetch router, but the handler fetched ${url}`);
  };

  logs = [];
  savedWarn = console.warn;
  savedError = console.error;
  console.warn = (...args) => { logs.push(['warn', args]); };
  console.error = (...args) => { logs.push(['error', args]); };
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  console.warn = savedWarn;
  console.error = savedError;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function makeReq({ method = 'POST', token } = {}) {
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function makeRes() {
  const res = { statusCode: null, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  res.send = (text) => { res.body = text; return res; };
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
  return res;
}

function newCaller() {
  const userId = crypto.randomUUID();
  return { userId, token: `caller-jwt-${userId}` };
}

/**
 * Install a fetch router and return the recorder.
 *
 * `enrolled` / `staff` are per-attempt behaviour lists; the last entry repeats.
 * `auth` is one behaviour, or 'ok' to accept exactly the caller's token.
 * `eleven` is one behaviour, or 'ok' for a real-looking signed URL.
 */
function installRouter({ caller, auth = 'ok', enrolled = [true], staff = [NOT_STAFF], eleven = 'ok' }) {
  const calls = [];
  const counts = { auth: 0, is_enrolled: 0, my_staff_context: 0, eleven: 0, unexpected: 0 };

  const nth = (list, i) => (Array.isArray(list) ? list[Math.min(i, list.length - 1)] : list);

  async function play(behaviour, init) {
    if (behaviour === THROW) throw new TypeError('fetch failed');
    if (behaviour === HANG) {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        // AbortSignal.timeout() uses an UNREF'd timer, and a stub opens no socket,
        // so without a ref'd handle the process could exit mid-hang and the test
        // would be cancelled rather than answered. This keeps the loop alive; it
        // is cleared the moment the handler's own bound fires. With no signal at
        // all it fires after 10 s and the elapsed-time assertion fails loudly.
        const keepAlive = setTimeout(() => reject(new Error('request was never aborted — unbounded fetch')), 10_000);
        if (!signal) return;
        const abort = () => { clearTimeout(keepAlive); reject(signal.reason); };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    return new Response(behaviour.text, {
      status: behaviour.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const record = {
      url,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? init.body : init.body == null ? '' : String(init.body),
      signal: init.signal,
    };
    calls.push(record);

    if (url === `${SUPA}/auth/v1/user`) {
      counts.auth += 1;
      if (auth === 'ok') {
        return headers.authorization === `Bearer ${caller.token}` && headers.apikey === ANON
          ? new Response(JSON.stringify({ id: caller.userId, email: 'student@example.com' }), { status: 200 })
          : new Response(JSON.stringify({ msg: 'invalid JWT' }), { status: 401 });
      }
      return play(auth, init);
    }
    if (url === `${SUPA}/rest/v1/rpc/is_enrolled`) {
      const i = counts.is_enrolled;
      counts.is_enrolled += 1;
      const b = nth(enrolled, i);
      return play(typeof b === 'boolean' ? json(b) : b, init);
    }
    if (url === `${SUPA}/rest/v1/rpc/my_staff_context`) {
      const i = counts.my_staff_context;
      counts.my_staff_context += 1;
      const b = nth(staff, i);
      const isBehaviour = b === THROW || b === HANG || (b && typeof b.status === 'number' && 'text' in b);
      return play(isBehaviour ? b : json(b), init);
    }
    if (url.startsWith(ELEVEN_URL_PREFIX)) {
      counts.eleven += 1;
      if (eleven === 'ok') return new Response(JSON.stringify({ signed_url: SIGNED_URL }), { status: 200 });
      return play(eleven, init);
    }
    counts.unexpected += 1;
    throw new Error(`unexpected network call in test: ${url}`);
  };

  const rpcCalls = () => calls.filter((c) => c.url.startsWith(`${SUPA}/rest/v1/rpc/`));
  return { calls, counts, rpcCalls };
}

async function post(caller, opts = {}) {
  const router = installRouter({ caller, ...opts });
  const res = makeRes();
  await handler(makeReq({ token: caller.token }), res);
  assert.equal(router.counts.unexpected, 0, 'the handler made a network call no test anticipated');
  return { res, ...router };
}

const logText = () => JSON.stringify(logs, (_k, v) => (typeof v === 'symbol' ? String(v) : v));

// ─────────────────────────────────────────────────────────────────────────────
// Method handling and configuration
// ─────────────────────────────────────────────────────────────────────────────

test('GET is an unauthenticated health check that makes no network call', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network on GET'); };

  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, configured: true });

  delete process.env.ELEVENLABS_AGENT_ID;
  const res2 = makeRes();
  await handler(makeReq({ method: 'GET' }), res2);
  assert.deepEqual(res2.body, { ok: true, configured: false }, 'env is read per request, not at import');

  assert.equal(fetched, 0);
});

test('a method other than GET or POST is 405', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network'); };
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = makeRes();
    await handler(makeReq({ method, token: 'x' }), res);
    assert.equal(res.statusCode, 405, method);
  }
  assert.equal(fetched, 0);
});

test('POST while ElevenLabs is not configured is a quiet 200 skip, before any auth', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network'); };
  delete process.env.ELEVENLABS_API_KEY;
  const res = makeRes();
  await handler(makeReq({ token: 'anything' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: false, skipped: 'elevenlabs_not_configured' });
  assert.equal(fetched, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Session verification
// ─────────────────────────────────────────────────────────────────────────────

test('a missing bearer token is 401 with no network call', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network'); };
  const res = makeRes();
  await handler(makeReq({}), res);
  assert.equal(res.statusCode, 401);
  assert.equal(fetched, 0);
});

test('a token the auth server refuses (401 or 403) is 401 and asks no RPC', async () => {
  for (const status of [401, 403]) {
    const caller = newCaller();
    const { res, counts } = await post(caller, { auth: json({ msg: 'invalid JWT' }, status) });
    assert.equal(res.statusCode, 401, `auth ${status}`);
    assert.equal(counts.is_enrolled + counts.my_staff_context, 0);
    assert.equal(counts.eleven, 0);
  }
  // And a token that is not the caller's, through the real accept-only-this-token route.
  const caller = newCaller();
  const router = installRouter({ caller });
  const res = makeRes();
  await handler(makeReq({ token: 'forged-token' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(router.counts.eleven, 0);
});

test('an auth server that does not answer is 503, never 401 and never a pass', async () => {
  for (const auth of [THROW, http(500, 'upstream down'), http(502), http(429)]) {
    const caller = newCaller();
    const { res, counts } = await post(caller, { auth });
    assert.equal(res.statusCode, 503, `auth behaviour ${String(auth?.status ?? auth.toString())}`);
    assert.equal(res.headers['retry-after'], RETRY_AFTER);
    assert.deepEqual(res.body, { error: UNAVAILABLE_ERROR, code: 'VOICE_CHECK_UNAVAILABLE' });
    assert.equal(counts.is_enrolled + counts.my_staff_context, 0);
    assert.equal(counts.eleven, 0);
  }
});

test('a Supabase-less server refuses a signed-in caller with 503 rather than guessing', async () => {
  delete process.env.VITE_SUPABASE_URL;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network'); };
  const res = makeRes();
  await handler(makeReq({ token: 'some-token' }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'VOICE_CHECK_UNAVAILABLE');
  assert.equal(fetched, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit — before any RPC
// ─────────────────────────────────────────────────────────────────────────────

test('after 8 mints the 9th is 429, and it costs ZERO RPC round trips', async () => {
  const caller = newCaller();
  for (let i = 1; i <= 8; i += 1) {
    const { res } = await post(caller, { enrolled: [true], staff: [NOT_STAFF] });
    assert.equal(res.statusCode, 200, `mint ${i}`);
  }
  const { res, counts, rpcCalls } = await post(caller, { enrolled: [true], staff: [NOT_STAFF] });
  assert.equal(res.statusCode, 429);
  assert.equal(counts.auth, 1, 'identity is still verified — the limit is keyed on the verified user');
  assert.equal(rpcCalls().length, 0, 'the rate limit must run before is_enrolled / my_staff_context');
  assert.equal(counts.eleven, 0);

  // A different caller is unaffected.
  const other = await post(newCaller(), { enrolled: [true], staff: [NOT_STAFF] });
  assert.equal(other.res.statusCode, 200);
});

// ─────────────────────────────────────────────────────────────────────────────
// The 3 × 3 grid, through the handler
// ─────────────────────────────────────────────────────────────────────────────

const ENROLLED_CASES = {
  true: [true],
  false: [false],
  error: [http(500, '{"message":"boom"}')],
};
const STAFF_CASES = {
  active: [ACTIVE_OPS_ADMIN],
  'not-staff': [NOT_STAFF],
  error: [http(500, '{"message":"boom"}')],
};
//              staff:  active  not-staff  error
const GRID = {
  true: { active: 200, 'not-staff': 200, error: 200 },
  false: { active: 200, 'not-staff': 403, error: 503 },
  error: { active: 200, 'not-staff': 503, error: 503 },
};

for (const [enrolledName, enrolled] of Object.entries(ENROLLED_CASES)) {
  for (const [staffName, staff] of Object.entries(STAFF_CASES)) {
    const expected = GRID[enrolledName][staffName];
    test(`grid: is_enrolled ${enrolledName} × staff ${staffName} → ${expected}`, async () => {
      const caller = newCaller();
      const { res, counts } = await post(caller, { enrolled, staff });
      assert.equal(res.statusCode, expected);

      // Both checks are ALWAYS asked — a staff grant does not skip is_enrolled, nor vice versa.
      assert.ok(counts.is_enrolled >= 1, 'is_enrolled was asked');
      assert.ok(counts.my_staff_context >= 1, 'my_staff_context was asked');

      if (expected === 200) {
        assert.equal(counts.eleven, 1, 'an allowed caller gets exactly one ElevenLabs call');
        assert.equal(res.body.signedUrl, SIGNED_URL);
      } else {
        assert.equal(counts.eleven, 0, 'a refused caller must never reach ElevenLabs');
        assert.equal(res.body.signedUrl, undefined);
      }
      if (expected === 403) {
        assert.deepEqual(res.body, { error: FORBIDDEN_ERROR, code: 'VOICE_FORBIDDEN' });
      }
      if (expected === 503) {
        assert.deepEqual(res.body, { error: UNAVAILABLE_ERROR, code: 'VOICE_CHECK_UNAVAILABLE' });
        assert.equal(res.headers['retry-after'], RETRY_AFTER);
      }
    });
  }
}

test('an active Trainer with no subscription is allowed — the bug that hid the assistant from staff', async () => {
  const { res, counts } = await post(newCaller(), { enrolled: [false], staff: [ACTIVE_TRAINER] });
  assert.equal(res.statusCode, 200);
  assert.equal(counts.eleven, 1);
});

test('missing my_staff_context (404) is a definite "not staff": with is_enrolled false it is 403, not 503', async () => {
  const missing = [http(404, '{"code":"PGRST202","message":"Could not find the function public.my_staff_context"}')];

  const denied = await post(newCaller(), { enrolled: [false], staff: missing });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.body.code, 'VOICE_FORBIDDEN');
  assert.equal(denied.counts.my_staff_context, 1, 'a definite answer is not re-asked');
  assert.equal(denied.counts.eleven, 0);

  const member = await post(newCaller(), { enrolled: [true], staff: missing });
  assert.equal(member.res.statusCode, 200, 'a pre-#45 database still serves its members');

  const unknown = await post(newCaller(), { enrolled: [http(500)], staff: missing });
  assert.equal(unknown.res.statusCode, 503, 'missing staff model does not rescue an unanswered is_enrolled');
});

test('a PostgREST schema-cache OUTAGE is not mistaken for a missing function', async () => {
  // PGRST002 is a 503 whose message mentions the schema cache — the same words the
  // "function is missing" classifier looks for. It must stay indeterminate.
  const outage = [http(503, '{"code":"PGRST002","message":"Could not query the database for the schema cache. Retrying."}')];
  const { res, counts } = await post(newCaller(), { enrolled: [false], staff: outage });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'VOICE_CHECK_UNAVAILABLE');
  assert.equal(counts.eleven, 0);
});

test('suspended and revoked staff are refused (403) — in both the current and the pre-#49 shape', async () => {
  for (const staff of [SUSPENDED_TRAINER, REVOKED_OPS_ADMIN, SUSPENDED_RAW_PRE49, REVOKED_RAW_PRE49]) {
    const { res, counts } = await post(newCaller(), { enrolled: [false], staff: [staff] });
    assert.equal(res.statusCode, 403, `status ${staff.status} / role ${staff.role_key}`);
    assert.equal(res.body.code, 'VOICE_FORBIDDEN');
    assert.equal(counts.eleven, 0);
  }
});

test('an invited-but-not-accepted staff member with no subscription is refused', async () => {
  const invited = {
    is_staff: false, role_key: null, status: 'invited', permissions: [],
    membership: { exists: true, status: 'invited', role_key: 'operations_admin' },
  };
  const { res, counts } = await post(newCaller(), { enrolled: [false], staff: [invited] });
  assert.equal(res.statusCode, 403);
  assert.equal(counts.eleven, 0);
});

test('a non-boolean is_enrolled body or a non-object my_staff_context body is not a clean answer', async () => {
  const oddEnrolled = await post(newCaller(), { enrolled: [json('true')], staff: [NOT_STAFF] });
  assert.equal(oddEnrolled.res.statusCode, 503, 'the STRING "true" is not true');
  assert.equal(oddEnrolled.counts.is_enrolled, 2, 'it was retried once');

  const oddStaff = await post(newCaller(), { enrolled: [false], staff: [json(null)] });
  assert.equal(oddStaff.res.statusCode, 503, 'a null staff context is indeterminate, not "not staff"');
  assert.equal(oddStaff.counts.my_staff_context, 2);

  const garbage = await post(newCaller(), { enrolled: [http(200, '<html>proxy error</html>')], staff: [NOT_STAFF] });
  assert.equal(garbage.res.statusCode, 503);
  assert.equal(garbage.counts.eleven, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry and timeout
// ─────────────────────────────────────────────────────────────────────────────

test('a first attempt that fails is retried once, and a good retry is honoured', async () => {
  const member = await post(newCaller(), { enrolled: [http(500), true], staff: [NOT_STAFF] });
  assert.equal(member.res.statusCode, 200);
  assert.equal(member.counts.is_enrolled, 2);

  const staff = await post(newCaller(), { enrolled: [false], staff: [THROW, ACTIVE_OPS_ADMIN] });
  assert.equal(staff.res.statusCode, 200);
  assert.equal(staff.counts.my_staff_context, 2);

  const thrice = await post(newCaller(), { enrolled: [THROW, THROW, true], staff: [NOT_STAFF] });
  assert.equal(thrice.res.statusCode, 503, 'exactly ONE retry — a third attempt is never made');
  assert.equal(thrice.counts.is_enrolled, 2);
});

test('every RPC attempt is bounded: a hung is_enrolled is abandoned and refused, not waited on', async () => {
  const started = Date.now();
  const { res, counts, rpcCalls } = await post(newCaller(), { enrolled: [HANG], staff: [NOT_STAFF] });
  const elapsed = Date.now() - started;

  assert.equal(res.statusCode, 503);
  assert.equal(counts.is_enrolled, 2, 'the hung attempt was retried once');
  assert.ok(elapsed < 7000, `the two bounded attempts took ${elapsed} ms`);
  for (const call of rpcCalls()) {
    assert.ok(call.signal instanceof AbortSignal, `${call.url} carries an abort signal`);
  }
  assert.match(logText(), /voice access indeterminate/);
  assert.match(logText(), /"checks":\["is_enrolled"\]/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────

test('every RPC carries the CALLER\'s bearer and the anon apikey; no service-role key ever leaves', async () => {
  const scenarios = [
    { enrolled: [true], staff: [NOT_STAFF] },              // allow (member)
    { enrolled: [false], staff: [ACTIVE_OPS_ADMIN] },      // allow (staff)
    { enrolled: [false], staff: [NOT_STAFF] },             // deny
    { enrolled: [http(500)], staff: [THROW] },             // unavailable, with retries
  ];
  for (const scenario of scenarios) {
    const caller = newCaller();
    const { res, calls, rpcCalls } = await post(caller, scenario);

    const rpcs = rpcCalls();
    assert.ok(rpcs.length >= 2, 'both RPCs were called');
    for (const call of rpcs) {
      assert.equal(call.method, 'POST', call.url);
      assert.equal(call.headers.authorization, `Bearer ${caller.token}`, `${call.url} uses the caller's JWT`);
      assert.equal(call.headers.apikey, ANON, `${call.url} uses the anon apikey`);
      assert.equal(call.body, '{}');
    }
    assert.deepEqual(
      [...new Set(rpcs.map((c) => c.url))].sort(),
      [`${SUPA}/rest/v1/rpc/is_enrolled`, `${SUPA}/rest/v1/rpc/my_staff_context`],
    );

    const outgoing = JSON.stringify(calls.map(({ url, method, headers, body }) => ({ url, method, headers, body })));
    assert.ok(!outgoing.includes(SERVICE_SENTINEL), 'SUPABASE_SECRET_KEY must never be sent');
    assert.ok(!outgoing.includes(LEGACY_SERVICE_SENTINEL), 'SUPABASE_SERVICE_ROLE_KEY must never be sent');

    const answer = JSON.stringify(res.body);
    assert.ok(!answer.includes(caller.token), 'the caller token is never echoed');
    assert.ok(!answer.includes(SERVICE_SENTINEL));
  }

  const logged = logText();
  assert.ok(!logged.includes('caller-jwt-'), 'no bearer token is ever logged');
  assert.ok(!logged.includes(SERVICE_SENTINEL) && !logged.includes(LEGACY_SERVICE_SENTINEL));
  assert.ok(!logged.includes('@'), 'no email address is ever logged');
});

test('the two access RPCs are issued in parallel, not one after the other', async () => {
  const caller = newCaller();
  let inFlight = 0;
  let peak = 0;
  const router = installRouter({ caller });
  const routed = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const isRpc = String(input).includes('/rest/v1/rpc/');
    if (isRpc) { inFlight += 1; peak = Math.max(peak, inFlight); }
    try {
      if (isRpc) await new Promise((r) => setTimeout(r, 20));
      return await routed(input, init);
    } finally {
      if (isRpc) inFlight -= 1;
    }
  };
  const res = makeRes();
  await handler(makeReq({ token: caller.token }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(peak, 2);
  assert.equal(router.counts.unexpected, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusal shapes and logging
// ─────────────────────────────────────────────────────────────────────────────

test('a 503 carries Retry-After, the stable code, and the copy an OLD client can show verbatim', async () => {
  const { res } = await post(newCaller(), { enrolled: [THROW], staff: [THROW] });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['retry-after'], RETRY_AFTER);
  assert.equal(res.body.code, 'VOICE_CHECK_UNAVAILABLE');
  assert.equal(res.body.error, UNAVAILABLE_ERROR);
  assert.equal(Object.keys(res.body).length, 2, 'nothing else rides along');
  assert.match(logText(), /"checks":\["is_enrolled","my_staff_context"\]/);
});

test('a 403 carries the stable code and is not accompanied by a Retry-After', async () => {
  const { res } = await post(newCaller(), { enrolled: [false], staff: [NOT_STAFF] });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: FORBIDDEN_ERROR, code: 'VOICE_FORBIDDEN' });
  assert.equal(res.headers['retry-after'], undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// The mint
// ─────────────────────────────────────────────────────────────────────────────

test('an allowed caller gets the signed URL, and a verifiable trainer token only when the secret is set', async () => {
  const withoutSecret = await post(newCaller(), { enrolled: [true], staff: [NOT_STAFF] });
  assert.equal(withoutSecret.res.statusCode, 200);
  assert.deepEqual(withoutSecret.res.body, { signedUrl: SIGNED_URL });

  const eleven = withoutSecret.calls.find((c) => c.url.startsWith(ELEVEN_URL_PREFIX));
  assert.equal(eleven.url, `${ELEVEN_URL_PREFIX}?agent_id=${AGENT_ID}`);
  assert.equal(eleven.headers['xi-api-key'], ELEVEN_KEY);

  process.env.TRAINER_TOKEN_SECRET = TRAINER_SECRET;
  const caller = newCaller();
  const withSecret = await post(caller, { enrolled: [false], staff: [ACTIVE_OPS_ADMIN] });
  assert.equal(withSecret.res.statusCode, 200);
  assert.equal(withSecret.res.body.signedUrl, SIGNED_URL);
  assert.equal(typeof withSecret.res.body.trainerToken, 'string');

  const hmac = (input) => crypto.createHmac('sha256', TRAINER_SECRET).update(input).digest('base64url');
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const verified = verifyTrainerToken(
    withSecret.res.body.trainerToken, { nowSec: Math.floor(Date.now() / 1000) }, hmac, eq,
  );
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(verified.claims.sub, caller.userId, 'the token names the VERIFIED caller');
});

test('no trainer token is minted for a refused caller, even with the secret set', async () => {
  process.env.TRAINER_TOKEN_SECRET = TRAINER_SECRET;
  for (const scenario of [
    { enrolled: [false], staff: [NOT_STAFF] },
    { enrolled: [http(500)], staff: [NOT_STAFF] },
  ]) {
    const { res } = await post(newCaller(), scenario);
    assert.ok(res.statusCode === 403 || res.statusCode === 503);
    assert.equal(res.body.trainerToken, undefined);
  }
});

test('an ElevenLabs failure is a generic 502 (or 429) that never echoes or logs the upstream text', async () => {
  const LEAK = 'UPSTREAM-LEAK-7f3a — internal agent config for alex@example.com';
  const upstreamBody = JSON.stringify({ detail: { status: 'agent_unavailable', message: LEAK } });

  const failed = await post(newCaller(), { enrolled: [true], staff: [NOT_STAFF], eleven: http(500, upstreamBody) });
  assert.equal(failed.res.statusCode, 502);
  assert.deepEqual(failed.res.body, { error: 'Could not start a voice session — try again shortly.' });
  assert.ok(!JSON.stringify(failed.res.body).includes('UPSTREAM-LEAK'));
  assert.ok(!logText().includes('UPSTREAM-LEAK'), 'the upstream body is never logged');
  assert.match(logText(), /agent_unavailable/, 'the short machine code is logged for diagnosis');

  const limited = await post(newCaller(), { enrolled: [true], staff: [NOT_STAFF], eleven: http(429, LEAK) });
  assert.equal(limited.res.statusCode, 429);
  assert.ok(!JSON.stringify(limited.res.body).includes('UPSTREAM-LEAK'));

  const nonJson = await post(newCaller(), { enrolled: [true], staff: [NOT_STAFF], eleven: http(200, LEAK) });
  assert.equal(nonJson.res.statusCode, 502);
  assert.ok(!JSON.stringify(nonJson.res.body).includes('UPSTREAM-LEAK'));

  const noUrl = await post(newCaller(), { enrolled: [true], staff: [NOT_STAFF], eleven: json({ note: LEAK }) });
  assert.equal(noUrl.res.statusCode, 502);

  assert.ok(!logText().includes('UPSTREAM-LEAK'));
});

test('a fetch that throws during the ElevenLabs call is a 502 with no detail field', async () => {
  const caller = newCaller();
  const router = installRouter({ caller, enrolled: [true], staff: [NOT_STAFF] });
  const routed = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(ELEVEN_URL_PREFIX)) {
      throw new TypeError('SOCKET-LEAK-TEXT connect ECONNREFUSED 10.0.0.7:443');
    }
    return routed(input, init);
  };
  const res = makeRes();
  await handler(makeReq({ token: caller.token }), res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(res.body.detail, undefined);
  assert.ok(!JSON.stringify(res.body).includes('SOCKET-LEAK'));
  assert.ok(!logText().includes('SOCKET-LEAK'), 'the error message is not logged either');
  assert.equal(router.counts.unexpected, 0);
});
