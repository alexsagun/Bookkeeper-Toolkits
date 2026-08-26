// ─────────────────────────────────────────────────────────────────────────────
// npm run staff:bootstrap -- --email you@example.com [--apply]
// ─────────────────────────────────────────────────────────────────────────────
// THE BREAK-GLASS PATH. Grants an existing account an ACTIVE super_admin staff
// membership, from a trusted environment, when nobody can do it from the app.
//
// WHY THIS EXISTS
//   After #45, super_admin is the only role that can create another super_admin.
//   The last active one is protected by admin_set_staff_status(), by
//   admin_upsert_staff_membership(), and by a staff_memberships BEFORE trigger —
//   so the product cannot paint itself into a corner from the UI. But if every
//   Super Admin credential is genuinely lost, there has to be a way back in that
//   does NOT exist as a browser-callable "make me an admin" function. This is it.
//
// ★ WHY IT WRITES THE TABLES DIRECTLY INSTEAD OF CALLING THE RPC.
//   admin_upsert_staff_membership() is gated on has_staff_permission('staff.manage'),
//   which resolves through auth.uid(). The Supabase Management API executes as the
//   `postgres` role with NO JWT, so auth.uid() is NULL, so the permission check is
//   false and the RPC would refuse with FORBIDDEN — every time, for everyone. A
//   SECURITY DEFINER function that self-gates on the caller's identity is exactly
//   the wrong tool for a path whose whole point is that there is no caller yet.
//   So this inserts the membership row and its audit row itself, in one statement,
//   and lets the section-7 trigger reconcile profiles.is_admin.
//
// ★ IT NEVER SETS profiles.is_admin. That column is a CACHE of "has an active
//   super_admin membership" and staff_sync_is_admin() is its only writer. Setting
//   it here would appear to work and then be silently reconciled away by the next
//   membership change anywhere in the system.
//
// SAFETY
//   · Read-only by default. Nothing is written without --apply.
//   · The project ref is hardcoded, exactly as scripts/audit-db.mjs hardcodes it,
//     so no stray env var can point a privileged write at another database.
//   · Refuses an email that matches zero or more than one profile.
//   · Idempotent: re-running on an already-active Super Admin is a no-op.
//   · The access token is read from .env and never printed.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The production project. Hardcoded on purpose — see the SAFETY note above.
const LIVE_REF = 'ifxcobxsjdjzlozagmls';

const ROLE = 'super_admin';

function managementToken() {
  let raw = '';
  try { raw = readFileSync(join(REPO, '.env'), 'utf8'); } catch { /* handled below */ }
  const m = /^SUPABASE_ACCESS_TOKEN=(.*)$/m.exec(raw);
  const token = m && m[1].trim().replace(/^["']|["']$/g, '');
  if (!token) {
    console.error(
      'SUPABASE_ACCESS_TOKEN not found in .env.\n'
      + 'Create one at Supabase Dashboard → Account → Access Tokens, then add:\n'
      + '  SUPABASE_ACCESS_TOKEN=sbp_…',
    );
    process.exit(2);
  }
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function q(sql, token) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${LIVE_REF}/database/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: sql }),
        },
      );
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : [];
      if (res.status < 500 && res.status !== 429) {
        let detail = text;
        try { detail = JSON.parse(text).message || text; } catch { /* raw */ }
        throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
      }
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await sleep(600 * 2 ** attempt);
  }
  throw new Error('unreachable');
}

/** SQL string literal. Fixture/CLI input only — never user-supplied web input. */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const email = String(arg('--email') || '').trim().toLowerCase();
  const apply = process.argv.includes('--apply');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: node scripts/bootstrap-super-admin.mjs --email you@example.com [--apply]');
    process.exit(2);
  }

  const token = managementToken();

  console.log(`\nSuper Admin bootstrap — project ${LIVE_REF}`);
  console.log(`  target : ${email}`);
  console.log(`  mode   : ${apply ? 'APPLY (writes)' : 'dry run (no writes)'}\n`);

  // 0) Is #45 even installed? Without it there is no table to write to, and the
  //    honest answer is "run the migration", not a confusing SQL error.
  const [{ installed }] = await q(
    `select to_regclass('public.staff_memberships') is not null as installed`, token,
  );
  if (!installed) {
    console.error('staff_memberships does not exist — run db/2026-08-25-staff-authorization.sql (#45) first.');
    process.exitCode = 1;
    return;
  }

  // 1) Resolve the account. Refuse anything ambiguous rather than guessing.
  const matches = await q(
    `select id::text as id, email, coalesce(full_name,'') as full_name
       from public.profiles where lower(email) = ${lit(email)}`, token,
  );
  if (matches.length === 0) {
    console.error(`No profile has that email. They must sign in once so the signup trigger creates their row.`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    console.error(`${matches.length} profiles share that email — refusing to guess. Resolve the duplicate first.`);
    process.exitCode = 1;
    return;
  }
  const target = matches[0];

  // 2) Current state, so the plan below describes a real change.
  const current = await q(
    `select m.role_key, m.status
       from public.staff_memberships m where m.user_id = ${lit(target.id)}::uuid`, token,
  );
  const now = current[0] || null;
  const already = now && now.role_key === ROLE && now.status === 'active';

  const [{ n: activeSupers }] = await q(
    `select count(*)::int as n from public.staff_memberships
      where role_key = ${lit(ROLE)} and status = 'active'`, token,
  );

  console.log(`  account          : ${target.full_name || '(no name)'} <${target.email}>`);
  console.log(`  user id          : ${target.id}`);
  console.log(`  current staff    : ${now ? `${now.role_key} / ${now.status}` : 'none'}`);
  console.log(`  active Super Admins now : ${activeSupers}`);
  console.log(`  planned          : ${already ? 'NOTHING — already an active Super Admin' : `${ROLE} / active`}\n`);

  if (already) {
    console.log('Nothing to do.');
    return;
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to make this change.');
    return;
  }

  // 3) Apply. One statement, so the membership and its audit row cannot separate.
  //    The section-7 trigger fires on the insert and reconciles profiles.is_admin —
  //    which is why this never touches that column itself.
  await q(`
    with upsert as (
      insert into public.staff_memberships
        (user_id, role_key, status, activated_at, invited_at)
      values (${lit(target.id)}::uuid, ${lit(ROLE)}, 'active', now(), now())
      on conflict (user_id) do update
        set role_key = ${lit(ROLE)},
            status = 'active',
            activated_at = coalesce(public.staff_memberships.activated_at, now()),
            suspended_at = null,
            revoked_at = null,
            suspension_reason = null,
            updated_at = now()
      returning user_id
    )
    insert into public.staff_role_events
      (actor_user_id, actor_email, target_user_id, target_email, action,
       from_role_key, to_role_key, from_status, to_status, reason, source)
    select null, null, u.user_id, ${lit(target.email)}, 'bootstrap',
           ${now ? lit(now.role_key) : 'null'}, ${lit(ROLE)},
           ${now ? lit(now.status) : 'null'}, 'active',
           'Break-glass grant via scripts/bootstrap-super-admin.mjs.', 'bootstrap_script'
      from upsert u
  `, token);

  // 4) Prove it, including the cache the trigger was supposed to write.
  const [check] = await q(`
    select m.role_key, m.status, p.is_admin
      from public.staff_memberships m
      join public.profiles p on p.id = m.user_id
     where m.user_id = ${lit(target.id)}::uuid
  `, token);

  console.log(`  ✔ membership     : ${check.role_key} / ${check.status}`);
  console.log(`  ${check.is_admin ? '✔' : '✘'} profiles.is_admin cache : ${check.is_admin}`);
  if (!check.is_admin) {
    console.error('\nThe is_admin cache did not update — staff_sync_is_admin() may be missing. Re-run #45.');
    process.exitCode = 1;
    return;
  }
  console.log('\nDone. Sign out and back in for the change to reach the browser session.');
}

main().catch((e) => {
  // Never print the token, and never print a raw body that might echo it back.
  console.error(`\nbootstrap failed: ${String(e?.message || e).slice(0, 300)}`);
  process.exit(2);
});
