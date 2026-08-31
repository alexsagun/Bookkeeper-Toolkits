// ─────────────────────────────────────────────────────────────────────────────
// #55 — approve_subscription / approve_extension must not be client-callable.
//
// Pinned against BOTH the dated migration and its bootstrap fold, because
// bootstrapFolds.test.mjs is a line-set CONTAINMENT check: it proves nothing was
// dropped from a fold, never that nothing wrong was added, and on a fresh install
// the last definition wins.
//
// The defect this pins was verified live on 2026-08-31: a real active
// operations_admin called approve_subscription(<own uid>, 'vip', null) through
// PostgREST and minted itself an active VIP term with no payment, no request row
// and no audit entry, flipping is_enrolled() false -> true and unlocking all three
// published courses. #48's self-approval trigger is on enrollment_requests, a table
// neither function touches, so it could not fire.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'db/2026-09-04-approve-rpc-grant-revoke.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const read = (f) => readFileSync(join(REPO, f), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();

for (const file of [MIGRATION, BOOTSTRAP]) {
  test(`${file}: authenticated EXECUTE is revoked on both approve RPCs`, () => {
    const sql = norm(read(file));
    assert.ok(
      sql.includes('revoke execute on function public.approve_subscription(uuid, text, uuid) from public, anon, authenticated'),
      'approve_subscription must be revoked from authenticated');
    assert.ok(
      sql.includes('revoke execute on function public.approve_extension(uuid, uuid, integer) from public, anon, authenticated'),
      'approve_extension must be revoked from authenticated');
  });

  test(`${file}: neither approve RPC is granted back to a client role`, () => {
    const sql = norm(read(file));
    // A later `grant execute … to authenticated` on either function would silently
    // reopen the escalation. Scoped to this migration's own text.
    // Anchor on the full banner, not a bare `§42`: a future section that merely
    // MENTIONS §42 in prose would move indexOf() earlier and drag the legacy
    // `grant execute ... to authenticated` (bootstrap ~line 664) into the scan,
    // turning this test spuriously red.
    const banner = norm('§42) FOLDED VERBATIM');
    const at = sql.indexOf(banner);
    if (file !== MIGRATION) assert.notEqual(at, -1, 'the §42 fold banner is missing from the bootstrap');
    const section = file === MIGRATION ? sql : sql.slice(at);
    assert.ok(!/grant execute on function public\.approve_subscription[^;]*to [^;]*authenticated/.test(section),
      'approve_subscription must not be re-granted to authenticated');
    assert.ok(!/grant execute on function public\.approve_extension[^;]*to [^;]*authenticated/.test(section),
      'approve_extension must not be re-granted to authenticated');
  });
}

test('the migration records itself in the apply log', () => {
  const sql = norm(read(MIGRATION));
  assert.ok(sql.includes("insert into public.schema_migrations"),
    'every dated migration from #31 onward must self-record');
  assert.ok(sql.includes("'2026-09-04-approve-rpc-grant-revoke.sql'"),
    'it must record its own filename');
  assert.ok(sql.includes("notify pgrst, 'reload schema'"),
    'PostgREST must be told to reload after a grant change');
});

test('the sanctioned nested caller is left alone', () => {
  // The whole safety argument for the revoke is that admin_finalize_enrollment()
  // calls both nested and is itself SECURITY DEFINER, so the effective user inside
  // it is the owner. If this migration ever started redefining that function, the
  // revoke would stop being a safe, isolated change.
  const sql = norm(read(MIGRATION));
  assert.ok(!sql.includes('create or replace function public.admin_finalize_enrollment'),
    '#55 must not redefine admin_finalize_enrollment — it only changes grants');
  assert.ok(!sql.includes('create or replace function public.approve_subscription'),
    '#55 must not redefine approve_subscription — it only changes grants');
});

test('the client still calls neither RPC directly', () => {
  // The revoke is only safe because nothing in the browser calls these. If a call
  // site ever appears, it will 403 in production and this test says why first.
  const app = read('src/BookkeeperPro.jsx');
  for (const fn of ['approve_subscription', 'approve_extension']) {
    const called = new RegExp(`rpc\\(\\s*['"]${fn}['"]`);
    assert.ok(!called.test(app),
      `${fn} is now called from the client, but #55 revoked EXECUTE from authenticated — `
      + 'route it through admin_finalize_enrollment() instead');
  }
});
