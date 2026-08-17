// ─────────────────────────────────────────────────────────────────────────────
// test-db/_harness.mjs — personas and assertions for the RLS suite.
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SHAPE
//   Every authorization claim in this project used to be verified by reading the
//   SQL. That is not verification: a policy can look right and still be defeated
//   by a default grant, a missing WITH CHECK, or a PostgREST behaviour nobody
//   modelled. So these tests drive the REAL stack the way a browser does —
//   supabase-js, a real signed-in user's JWT, PostgREST — and assert on what the
//   server actually returns.
//
//   Setup uses the Management API (as `postgres`, bypassing RLS) because building
//   fixtures is not the thing under test. Assertions NEVER use it: a claim about
//   what a member can see is only meaningful through that member's own client.
//
// SAFETY
//   Everything routes through shadowEnv(), which refuses to run when .env.test
//   points at the live project. resetShadow() truncates data, so that check is
//   the difference between a test run and an incident.
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { runSql, shadowEnv } from '../scripts/_shadow.mjs';

export { runSql };

const CLIENT_OPTS = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};

let _service = null;
let _anon = null;

/** Service-role client — for creating auth users. Bypasses RLS; never assert with it. */
export function serviceClient() {
  if (!_service) {
    const env = shadowEnv();
    _service = createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_SECRET_KEY, CLIENT_OPTS);
  }
  return _service;
}

/**
 * Anonymous client — exactly what an unauthenticated visitor holds.
 *
 * ★ This client must NEVER be signed in. It was, once: makePersona() called
 * anonClient().auth.signInWithPassword(), which mutated this shared singleton
 * into an authenticated session. The "anonymous visitor" test then read a
 * member's rows and reported a data leak that did not exist. Sign-in now uses
 * its own throwaway client (freshAuthClient) so this one stays pristine.
 */
export function anonClient() {
  if (!_anon) {
    const env = shadowEnv();
    _anon = createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_ANON_KEY, CLIENT_OPTS);
  }
  return _anon;
}

/** A disposable anon-key client used only to exchange credentials for a session. */
function freshAuthClient() {
  const env = shadowEnv();
  return createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_ANON_KEY, CLIENT_OPTS);
}

/** A fresh anon-key client carrying one user's session — i.e. a real member. */
function personaClient(session) {
  const env = shadowEnv();
  return createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_ANON_KEY, {
    ...CLIENT_OPTS,
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
}

const PASSWORD = 'Sh4dow-Test-Passw0rd!';
const personaCache = new Map();

/**
 * Create (or reuse) a real auth user and return a client authenticated as them.
 *
 * Goes through GoTrue rather than inserting into auth.users, so the signup
 * trigger fires and the profiles row exists exactly as it does in production.
 *
 * @returns {Promise<{id: string, email: string, db: import('@supabase/supabase-js').SupabaseClient}>}
 */
export async function makePersona(label, { isAdmin = false, fullName = null } = {}) {
  if (personaCache.has(label)) return personaCache.get(label);

  const email = `${label}@shadow.test`.toLowerCase();
  const svc = serviceClient();

  // Idempotent: reuse the user if a previous run left it behind.
  let userId = await runSqlScalarSafe(
    `select id::text from auth.users where email = ${lit(email)}`,
  );
  if (!userId) {
    const { data, error } = await svc.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`makePersona(${label}): ${error.message}`);
    userId = data.user.id;
  }

  await runSql(`
    update public.profiles
       set approval_status = 'approved',
           is_admin = ${isAdmin ? 'true' : 'false'},
           full_name = ${lit(fullName || label)},
           updated_at = now()
     where id = '${userId}'::uuid`);

  // Own client, never the shared anon one (see anonClient's note). Retried
  // because GoTrue occasionally resets a connection under a burst of sign-ins.
  let signIn = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await freshAuthClient().auth.signInWithPassword({ email, password: PASSWORD });
      if (res.error) { lastErr = res.error; } else { signIn = res.data; break; }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  if (!signIn) throw new Error(`makePersona(${label}) sign-in: ${lastErr?.message || 'unknown'}`);

  const persona = { id: userId, email, label, db: personaClient(signIn.session) };
  personaCache.set(label, persona);
  return persona;
}

/** SQL string literal with quote escaping. Fixtures only — never user input. */
export function lit(v) {
  if (v === null || v === undefined) return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function runSqlScalarSafe(sql) {
  const rows = await runSql(sql);
  if (!Array.isArray(rows) || !rows.length) return null;
  const k = Object.keys(rows[0]);
  return k.length ? rows[0][k[0]] : null;
}

/**
 * Give a persona a live membership term, and optionally cohort seats.
 *
 * Seats are granted through grant_batch_run — the same allocator production
 * uses — rather than by inserting ledger rows, so a fixture can never create a
 * state the real code could not produce.
 *
 * ★ #39: only a VIP-segment plan may pass startBatchCode. grant_batch_run now
 * refuses any other segment with INVALID_PLAN, so seeding a cohort seat on a
 * general-segment plan (sampler, silver_self_paced) fails LOUDLY in the fixture
 * instead of quietly producing a member the product cannot create.
 */
export async function seedMember(persona, {
  planKey,
  days = 180,
  startBatchCode = null,
  seats = null,
  status = 'active',
  expired = false,
  inGrace = false,
} = {}) {
  const endsAt = expired
    ? `now() - interval '10 days'`
    : inGrace
      ? `now() - interval '1 day'`
      : `now() + interval '${days} days'`;
  const graceEnds = inGrace
    ? `now() + interval '2 days'`
    : expired
      ? `now() - interval '7 days'`
      : `now() + interval '${days + 3} days'`;

  // One round trip: every Management API call is ~1-2s, and a suite that seeds
  // a dozen members one statement at a time spends minutes doing nothing else.
  await runSql(`
    do $seed$
    declare
      v_sub uuid;
      v_seg text;
      v_cnt int;
    begin
      insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at)
      values ('${persona.id}'::uuid, ${lit(planKey)}, ${lit(status)}, now(), ${endsAt}, ${graceEnds})
      returning id into v_sub;

      update public.profiles set is_paid = true, plan = ${lit(planKey)}
       where id = '${persona.id}'::uuid;

      ${startBatchCode ? `
      select coalesce(community_segment, 'general') into v_seg
        from public.enrollment_plans where key = ${lit(planKey)};
      v_cnt := ${seats ?? `coalesce(public.plan_eligible_batch_count(${lit(planKey)}), 1)`};

      perform public.grant_batch_run(
        '${persona.id}'::uuid, v_seg,
        (select id from public.batches where code = ${lit(startBatchCode)}),
        v_cnt, 'approval', v_sub, ${lit(planKey)}, null, null,
        (select coalesce(grace_ends_at, ends_at) from public.subscriptions where id = v_sub),
        null, true);
      ` : ''}
    end
    $seed$;`);
  return persona;
}

/**
 * Create a batch. The #32 trigger spawns its cohort space — since #39 that is
 * exactly ONE space per batch (vip-<code>), because VIP is the only segment.
 *
 * endsOn / timezone are #38: left null, batches_guard() fills the period from the
 * code, which is exactly what production does — so the default fixture exercises
 * that fill rather than papering over it.
 */
export async function makeBatch(code, {
  name = null, status = 'open',
  vipCap = null, totalCap = null,
  startsOn = null, endsOn = null, timezone = null,
} = {}) {
  await runSql(`
    insert into public.batches (code, name, status, vip_capacity, total_capacity,
                                starts_on, ends_on, timezone)
    values (${lit(code)}, ${lit(name || `Batch ${code}`)}, ${lit(status)},
            ${vipCap ?? 'null'}, ${totalCap ?? 'null'},
            ${startsOn ? lit(startsOn) + '::date' : 'null'},
            ${endsOn ? lit(endsOn) + '::date' : 'null'},
            -- DEFAULT, not a literal: a fixture that hard-codes 'Asia/Manila' makes
            -- any assertion about the column default trivially true.
            ${timezone ? lit(timezone) : 'default'})
    on conflict (code) do update set status = excluded.status,
      vip_capacity = excluded.vip_capacity,
      total_capacity = excluded.total_capacity, starts_on = excluded.starts_on
    -- #38: three of those four columns are frozen once a batch's period has passed,
    -- so re-calling makeBatch for a PAST code would raise BATCH_PAST from a FIXTURE
    -- rather than from the code under test. Skip the update instead; the row the
    -- caller wanted already exists.
    where not public.batch_is_past(public.batches.ends_on, public.batches.timezone)`);
  return runSqlScalarSafe(`select id::text from public.batches where code = ${lit(code)}`);
}

/**
 * Assert a write was REFUSED by the database.
 *
 * A PostgREST RLS refusal on INSERT is a 42501 error; a refusal on UPDATE/DELETE
 * filtered by USING returns success with ZERO rows affected, which is why this
 * helper accepts both and why asserting "no error" would be a false pass.
 */
export async function expectDenied(promise, what = 'operation') {
  const { data, error } = await promise;
  if (error) {
    assert.match(
      String(error.code || '') + ' ' + String(error.message || ''),
      /42501|permission denied|violates row-level security|PGRST301|JWT/i,
      `${what}: expected an authorization refusal, got ${error.code}: ${error.message}`,
    );
    return error;
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  assert.equal(rows.length, 0,
    `${what}: expected the database to refuse, but it returned ${rows.length} row(s)`);
  return null;
}

/** Assert an RPC failed with one of our stable error codes (#35's contract). */
export async function expectAppError(promise, code, what = 'rpc') {
  const { error } = await promise;
  assert.ok(error, `${what}: expected ${code}, but the call succeeded`);
  const got = error.hint || (() => {
    try { return JSON.parse(error.details || '{}').code; } catch { return null; }
  })();
  assert.equal(got, code,
    `${what}: expected ${code}, got hint=${error.hint} message=${error.message}`);
  return error;
}

/** Assert a read returned exactly the expected set of ids (order-insensitive). */
export function assertIds(rows, expected, what = 'rows') {
  const got = (rows || []).map((r) => r.id ?? r).sort();
  assert.deepEqual(got, [...expected].sort(), what);
}

/**
 * Wipe all test data. Auth users are LEFT in place (recreating them on every
 * run costs ~1s each and GoTrue rate-limits), so personas are reused; their
 * profiles are reset to a known state.
 */
export async function resetShadow() {
  shadowEnv(); // re-asserts we are not pointed at production
  // personaCache is deliberately NOT cleared: auth users and their profiles rows
  // survive a data reset, and re-creating + re-signing-in a persona costs ~3s
  // each. Their membership state is wiped below and re-seeded per test.
  await runSql(`
    truncate table
      public.batch_entitlements,
      public.batch_events,
      public.community_reactions,
      public.community_attachments,
      public.community_post_tags,
      public.community_notifications,
      public.community_announcement_reads,
      public.community_comments,
      public.community_posts,
      public.subscriptions,
      public.enrollment_requests
    restart identity cascade`);
  // Cohorts and their spaces: delete the batches, let the FK cascade take the
  // spaces. General is seeded by #32 and must survive.
  await runSql(`delete from public.community_spaces where kind <> 'general'`);
  await runSql(`delete from public.batches`);
  // plan and is_paid are NOT NULL with defaults ('free', false) — reset to the
  // defaults rather than to null.
  await runSql(`
    update public.profiles
       set is_paid = false, plan = 'free', approval_status = 'approved',
           rejected_at = null, rejection_reason = null`);
}

/** Convenience for tests that need the General space id. */
export async function generalSpaceId() {
  return runSqlScalarSafe(`select id::text from public.community_spaces where kind = 'general'`);
}

export async function spaceIdFor(kind, batchCode) {
  return runSqlScalarSafe(`
    select sp.id::text from public.community_spaces sp
      join public.batches b on b.id = sp.batch_id
     where sp.kind = ${lit(kind)} and b.code = ${lit(batchCode)}`);
}

export { runSqlScalarSafe as sqlScalar };
