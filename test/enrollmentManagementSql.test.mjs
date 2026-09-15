// ─────────────────────────────────────────────────────────────────────────────
// test/enrollmentManagementSql.test.mjs — the #60 enrollment-management contract,
// asserted against the dated migration AND its bootstrap fold §47. No database.
// ─────────────────────────────────────────────────────────────────────────────
// Runtime behaviour (a direct approval refused, a hold released on decision, a student
// unable to read a hold) is proved against the live catalog in an aborted transaction
// before apply. This suite pins the SHAPE that makes those true.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-15-enrollment-management.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const FILES = [MIGRATION, BOOTSTRAP];
const TABLES = ['enrollment_request_holds', 'enrollment_request_events'];

const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

function section(rel) {
  const sql = read(rel);
  if (rel !== BOOTSTRAP) return sql;
  const at = sql.indexOf('§47) FOLDED VERBATIM');
  assert.ok(at > 0, '§47 is missing from the bootstrap — re-fold db/2026-09-15-enrollment-management.sql');
  const next = sql.slice(at + 1).search(/^--\s*§\d+\) FOLDED VERBATIM/m);
  return next < 0 ? sql.slice(at) : sql.slice(at, at + 1 + next);
}
const fnBody = (s, name) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$fn\\$;`).exec(s)?.[0] || '';

for (const file of FILES) {
  const sql = () => codeOf(section(file));

  test(`${file}: both tables are RLS-enabled, revoked, and have exactly one SELECT policy`, () => {
    const s = sql();
    for (const t of TABLES) {
      assert.ok(s.includes(`create table if not exists public.${t} (`), `${t} is not created`);
      assert.ok(s.includes(`alter table public.${t} enable row level security`), `${t} has no RLS`);
      assert.ok(s.includes(`revoke all on table public.${t} from public, anon, authenticated`), `${t} keeps default grants`);
    }
    const block = /do \$pol\$[\s\S]*?\$pol\$;/.exec(s)?.[0] || '';
    assert.equal([...block.matchAll(/create policy/gi)].length, 1, 'one policy per table, built in one loop');
    assert.ok(/for select to authenticated/.test(block) && !/\bfor\s+(all|insert|update|delete)\b/i.test(block),
      'the only policy is a SELECT — a hold or a timeline row is written only through the RPCs');
    assert.ok(/has_staff_permission\(''enrollments\.review''\)/.test(block), 'gated on enrollments.review');
    assert.ok(!/grant\s+(insert|update|delete|all)\s+on\s+table\s+public\.enrollment_request_/i.test(s),
      'a write verb was granted on a staff-only table');
  });

  test(`${file}: a hold is a side table — never a column a student can read, never a change to expires_at`, () => {
    const s = sql();
    assert.ok(!/alter table public\.enrollment_requests\s+add column/i.test(s),
      'students SELECT their own request rows, so a hold reason on that table would be visible to them');
    assert.ok(!/set[^;]*\bexpires_at\s*=/i.test(s),
      'expires_at drives the student\'s own self-expire path; "overdue" must stay derived');
    assert.ok(/and not exists \(select 1 from public\.enrollment_request_holds h where h\.request_id = r\.id\)/.test(fnBody(s, 'admin_enrollment_queue_counts')),
      'overdue is pending, past expires_at, and NOT on hold');
  });

  test(`${file}: every granted function checks enrollments.review before touching data`, () => {
    const s = sql();
    const granted = [...new Set([...s.matchAll(/grant execute on function public\.(\w+)\(/g)].map((m) => m[1]))];
    assert.deepEqual(granted.sort(), ['admin_clear_enrollment_hold', 'admin_correct_enrollment_amount',
      'admin_enrollment_queue_counts', 'admin_set_enrollment_hold', 'admin_staff_display_names']);
    for (const name of granted) {
      const body = fnBody(s, name);
      assert.ok(/security definer set search_path = public, pg_temp/.test(body), `${name}: SECURITY DEFINER with a pinned search_path`);
      const begin = body.search(/\bbegin\b/);
      const guard = body.indexOf("has_staff_permission('enrollments.review')");
      assert.ok(begin > 0 && guard > begin, `${name} has no enrollments.review check`);
      assert.ok(!/\b(select|insert|update|delete)\b/i.test(body.slice(begin, guard).replace(/if not public\.$/, '')),
        `${name} touches data before checking the permission`);
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked first`);
    }
    for (const internal of ['enrollment_approval_requires_grant', 'enrollment_hold_release_trg', 'enrollment_request_events_guard']) {
      assert.ok(s.includes(`revoke all on function public.${internal}(`), `${internal} is not revoked`);
      assert.ok(!s.includes(`grant execute on function public.${internal}(`), `${internal} is trigger-only and must not be granted`);
    }
  });

  test(`${file}: an approval without its membership grant is refused`, () => {
    const s = sql();
    assert.ok(/create trigger enrollment_approval_requires_grant\s+before update on public\.enrollment_requests\s+for each row\s+when \(new\.status = 'approved' and old\.status is distinct from 'approved'\)/.test(s),
      'the guard must be a BEFORE UPDATE trigger scoped to the approval transition');
    const body = /create or replace function public\.enrollment_approval_requires_grant\(\)[\s\S]*?\$fn\$;/.exec(s)?.[0] || '';
    assert.ok(/s\.request_id = new\.id/.test(body), 'both grant paths stamp subscriptions.request_id — that is the proof of a grant');
    assert.ok(/s\.status = 'active' and s\.ends_at is null/.test(body),
      "approve_extension returns a grandfathered no-expiry term unchanged; refusing it would block that member's approval");
    assert.ok(/not public\.is_super_admin\(\)/.test(body), 'Super Admin keeps the break-glass path');
    assert.ok(!/create or replace function public\.admin_finalize_enrollment\(/.test(s),
      'admin_finalize_enrollment must not be retyped here — the #33/#34 failure mode');
  });

  test(`${file}: an amount is corrected only while pending, never on your own request, and always audited`, () => {
    const body = fnBody(sql(), 'admin_correct_enrollment_amount');
    assert.ok(/v_req\.status <> 'pending_review'/.test(body),
      'an approved request already posted its collection; correcting the request would not move the ledger');
    assert.ok(/v_req\.user_id = v_actor and not public\.is_super_admin\(\)/.test(body), 'the #48 segregation rule');
    assert.ok(/'amount_corrected'/.test(body) && /'before', v_req\.amount_paid, 'after', v_new/.test(body),
      'the timeline must record both figures');
    assert.ok(/for update/.test(body), 'the row is locked so a correction cannot race an approval');
  });

  test(`${file}: the staff-name lookup can never name a student`, () => {
    const body = fnBody(sql(), 'admin_staff_display_names');
    assert.ok(/from public\.staff_memberships m/.test(body), 'names come only from accounts with a staff membership');
    assert.ok(!/\bemail\b/.test(body), 'no email is returned');
    assert.ok(/cardinality\(p_user_ids\) > 200/.test(body), 'the lookup is bounded');
  });

  test(`${file}: the timeline is append-only and outlives the request`, () => {
    const s = sql();
    const table = /create table if not exists public\.enrollment_request_events \(([\s\S]*?)\n\);/.exec(s)?.[1] || '';
    assert.ok(/request_id\s+uuid not null,/.test(table), 'request_id carries no FK, so deleting an account keeps its history');
    assert.ok(/before update or delete on public\.enrollment_request_events/.test(s), 'the append-only guard is missing');
    assert.ok(/when \(old\.status = 'pending_review' and new\.status is distinct from 'pending_review'\)/.test(s),
      'a decided request must release its hold');
  });

  test(`${file}: no permission change, no transaction wrapper, records itself`, () => {
    const s = sql();
    assert.ok(!/insert into public\.staff_(permissions|role_permissions)\b/.test(s), 'no permission change in #60');
    assert.ok(!/^\s*(begin|commit|rollback)\s*;/im.test(s), 'no transaction wrapper');
    assert.ok(s.includes("notify pgrst, 'reload schema'"), 'the new RPCs are invisible until the cache reloads');
    assert.ok(s.includes("'2026-09-15-enrollment-management.sql'"), 'the migration must name itself in schema_migrations');
  });
}

test('#60 error codes are in the catalog, the client list and the copy table', () => {
  const sql = read(MIGRATION);
  const catalog = sql.slice(sql.indexOf('create or replace function public.app_error_catalog()'));
  assert.ok(catalog.length > 100, 'the catalog restatement is missing');
  const raised = new Set([...sql.matchAll(/app_error\(\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
  for (const code of raised) {
    assert.ok(catalog.includes(`('${code}'`), `${code} is raised but not catalogued`);
    assert.ok(APP_ERROR_CODES.includes(code), `${code} is unknown to the client`);
    assert.ok(APP_ERROR_COPY[code], `${code} has no user-facing copy`);
  }
});
