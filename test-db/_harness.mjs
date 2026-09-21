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

/**
 * Give a persona a real, ACTIVE staff membership.
 *
 * ★ makePersona({isAdmin:true}) writes profiles.is_admin DIRECTLY and creates NO
 *   staff_memberships row. Since #45 that column is a trigger-maintained CACHE meaning
 *   "has an active super_admin membership", so such a persona satisfies is_admin() but
 *   has_staff_permission() answers FALSE for every key. Before #56 that did not matter —
 *   the community surface asked is_admin(). It matters now: a suite that re-gates onto
 *   has_staff_permission and keeps the old fixture would see every admin path 403.
 *
 * Writing the membership directly (rather than through admin_upsert_staff_membership) is
 * the scripts/bootstrap-super-admin.mjs idiom: the Management API runs as postgres with no
 * JWT, so auth.uid() is null and the RPC's own guard would refuse. The trigger still fires,
 * so profiles.is_admin lands correctly for a super_admin and stays false for the others.
 */
export async function seedStaff(persona, roleKey, status = 'active') {
  await runSql(`
    insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at)
    values ('${persona.id}'::uuid, ${lit(roleKey)}, ${lit(status)},
            ${status === 'active' ? 'now()' : 'null'}, now())
    on conflict (user_id) do update
      set role_key = excluded.role_key,
          status = excluded.status,
          activated_at = excluded.activated_at,
          updated_at = now()`);
}

/** Remove any staff membership, so a persona is a plain member again. */
export async function clearStaff(persona) {
  await runSql(`delete from public.staff_memberships where user_id = '${persona.id}'::uuid`);
}

/** SQL string literal with quote escaping. Fixtures only — never user input. */
/**
 * Run fixture SQL with auth.uid() set to a persona, inside ONE transaction.
 *
 * ★ WHY THIS EXISTS. The Management API runs as `postgres` with no JWT, so auth.uid() is
 *   null and every self-gating trigger refuses. #48 added `courses_publish_insert_guard`
 *   (BEFORE INSERT ... WHEN new.published), which means a fixture cannot create a
 *   PUBLISHED course from here at all — it fails with COURSE_PUBLISH_FORBIDDEN before a
 *   single test runs.
 *
 * ★ AND WHY NOT `ALTER TABLE ... DISABLE TRIGGER`. Setting the claim leaves the guard
 *   armed: it still runs, still reads a real staff membership, and still has to pass. A
 *   fixture that satisfies the rule is evidence; one that switches the rule off is a
 *   fixture that would keep working after the rule broke.
 *
 * `is_local = true` scopes the identity to this DO block's implicit transaction, so
 * nothing else in the run inherits it. Pass statements, each ending in a semicolon.
 */
export async function asUser(userId, sql) {
  await runSql(`do $as$
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', ${lit(String(userId))})::text, true);
      ${sql}
    end
  $as$`);
}

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
      public.student_progress_daily,
      public.student_foundation_completions,
      public.student_ranking_preferences,
      public.feature_video_completions,
      public.feature_guides,
      public.batch_entitlements,
      public.batch_events,
      public.community_channel_events,
      public.community_channel_reads,
      public.community_reactions,
      public.community_attachments,
      public.community_post_tags,
      public.community_notifications,
      public.community_announcement_reads,
      public.community_moderation_events,
      public.community_comments,
      public.community_posts,
      public.subscriptions,
      public.enrollment_requests,
      -- #44: the course-video suite creates courses, modules and lessons. Without these
      -- three the next suite inherits them, and courseVideos.dbtest's own fixtures would
      -- accumulate across runs until a slug collision made the failure look unrelated.
      -- CASCADE carries course_modules/course_lessons/lesson_progress/course_completions
      -- and the course_ai_* rows; naming the two children anyway keeps the intent legible.
      -- ★ #65's two tables are named for the same reason, and one of them needs it more
      --   than legibility: course_lesson_assets.course_id is ON DELETE SET NULL, so a row
      --   would survive a plain DELETE of its course. TRUNCATE CASCADE reaches it anyway
      --   (cascade follows the reference, not the delete action), but a reader checking
      --   whether test data leaks between suites should not have to know that.
      public.course_lesson_asset_refs,
      public.course_lesson_assets,
      public.course_lessons,
      public.course_modules,
      public.courses
    restart identity cascade`);
  // Objects the course-video tests file under the private bucket. Deleted rather than
  // truncated: storage.objects is shared with the community-media and receipts suites.
  // ★ Supabase added a platform trigger, storage.protect_delete(), that raises 42501 on ANY
  //   direct DELETE from a storage table — which broke this line, and with it the `before()`
  //   of every suite in this directory, so `npm run test:db` failed 100% at setup with an error
  //   that named storage and looked nothing like the feature under test. The trigger has one
  //   sanctioned escape: it returns early when `storage.allow_delete_query` is 'true'. It must
  //   be set with is_local = true, which needs a transaction — and the Management API commits
  //   each request on its own — so the setting and the delete have to travel in ONE statement.
  //   A `do` block is that statement: its implicit transaction scopes the setting to exactly
  //   this delete, so nothing else in the run inherits permission to bypass the guard.
  await runSql(`do $storage$
    begin
      perform set_config('storage.allow_delete_query', 'true', true);
      delete from storage.objects where bucket_id in ('course-videos', 'course-lesson-assets');
    end
  $storage$`);
  // Cohorts and their spaces: delete the batches, let the FK cascade take the
  // spaces (and, since #40, their categories and channels). General is seeded
  // by #32 and its channels by #40 — both must survive.
  await runSql(`delete from public.community_spaces where kind <> 'general'`);
  // ★ #40 seed channels are MUTABLE: a test can rename, archive, re-audience or
  //   re-categorise one, and slug-keyed lookups would then silently resolve to a
  //   channel in a state nobody asked for - poisoning every later test AND every
  //   other suite. Deleting General's channels + categories and re-seeding is the
  //   only way back to a known state (seed_default_channels() early-returns if any
  //   channel survives, so the delete has to come first).
  await runSql(`delete from public.community_channels ch
     using public.community_spaces sp
     where sp.id = ch.space_id and sp.kind = 'general'`);
  await runSql(`delete from public.community_channel_categories cat
     using public.community_spaces sp
     where sp.id = cat.space_id and sp.kind = 'general'`);
  await runSql(`delete from public.community_settings`);
  await runSql(`select public.seed_default_channels(id) from public.community_spaces where kind = 'general'`);
  await runSql(`
    insert into public.community_settings (id, community_name, description, welcome_message)
    values (true, 'Community',
            'Ask questions, share wins, and keep up with program news.',
            'Welcome. Start in #general-discussion and say hello.')
    on conflict (id) do nothing`);
  await runSql(`
    update public.community_settings s
       set default_channel_id = (
         select ch.id from public.community_channels ch
         join public.community_spaces sp on sp.id = ch.space_id
        where sp.kind = 'general' and ch.is_default limit 1)
     where s.default_channel_id is null`);

  // (legacy) leftover non-seed General channels from a pre-restore run
  await runSql(`delete from public.community_channels ch
     using public.community_spaces sp
     where sp.id = ch.space_id and sp.kind = 'general'
       and ch.slug not in ('announcements','community-guide','general-discussion',
                           'quickbooks-help','job-search','client-work')`);
  await runSql(`delete from public.batches`);
  // plan and is_paid are NOT NULL with defaults ('free', false) — reset to the
  // defaults rather than to null.
  await runSql(`
    update public.profiles
       set is_paid = false, plan = 'free', approval_status = 'approved',
           rejected_at = null, rejection_reason = null`);
}

/**
 * Wipe the finance LEDGER back to the #58 seed, keeping the chart, settings and presets.
 *
 * ★ resetShadow() alone leaves the ledger inconsistent. Its `truncate enrollment_requests …
 *   cascade` also empties finance_payment_events (the FK reaches it), while the journal entries
 *   those events belonged to survive — so every surviving enrollment collection reads as income
 *   with no package, and a report asserting exact figures fails for a reason unrelated to it.
 *   The #58 suite also inserts a 2020-01 period lock with no ON CONFLICT, so without this a
 *   second run against the same shadow project failed in its own before().
 *
 * TRUNCATE bypasses the append-only ROW triggers (it fires no DELETE trigger) and needs table
 * ownership: the Management API runs as postgres, and every client role lost TRUNCATE when #58
 * revoked all on these tables — which is the reason this is safe to have at all.
 */
export async function resetFinance() {
  shadowEnv(); // re-asserts we are not pointed at production
  await runSql(`
    truncate table
      public.finance_reconciliation_items,
      public.finance_reconciliations,
      public.finance_bank_transactions,
      public.finance_bank_imports,
      public.finance_payment_events,
      public.finance_journal_lines,
      public.finance_journal_entries,
      public.finance_recurring_templates,
      public.finance_period_locks,
      public.finance_audit_events
    restart identity`);
  await runSql(`update public.finance_accounts set active = true
                 where code in ('1010', '4000', '4010', '4040', '4900')`);
  await runSql(`update public.enrollment_plans set finance_income_account_id = null`);
}

/** Convenience for tests that need the General space id. */
export async function generalSpaceId() {
  return runSqlScalarSafe(`select id::text from public.community_spaces where kind = 'general'`);
}

export async function channelIdFor(spaceSlug, channelSlug) {
  return runSqlScalarSafe(`
    select ch.id::text from public.community_channels ch
      join public.community_spaces sp on sp.id = ch.space_id
     where sp.slug = ${lit(spaceSlug)} and ch.slug = ${lit(channelSlug)}`);
}

export async function spaceIdFor(kind, batchCode) {
  return runSqlScalarSafe(`
    select sp.id::text from public.community_spaces sp
      join public.batches b on b.id = sp.batch_id
     where sp.kind = ${lit(kind)} and b.code = ${lit(batchCode)}`);
}

export { runSqlScalarSafe as sqlScalar };
