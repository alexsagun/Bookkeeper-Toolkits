// test/financeDailyIncomeSql.test.mjs — the Daily Income report (#64), pinned in the dated file
// AND the §51 fold. Reads files as TEXT; no database and no network. The behaviour (what each
// bucket holds, the reconciliation, the role refusals) is proven against a real stack in
// test-db/financeDailyIncome.dbtest.mjs — this suite pins the SHAPE that makes that behaviour
// safe to rely on, so a later edit cannot quietly undo it.
//
// ★ THE REPORT READS THE LEDGER, NEVER THE CATALOG OR THE REQUEST. Income is what was posted:
//   the journal lines on income accounts, dated by entry_date. A report that multiplied today's
//   price by a count, or summed the student-typed amount_paid, would rewrite history every time
//   a price changed — so neither word may appear in the function body.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-19-finance-daily-income.sql';
const FILENAME = '2026-09-19-finance-daily-income.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const FN = 'finance_daily_income_report';

/** Executable SQL only — comments explain invariants by naming what must not exist. */
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

/** The §51 fold, bounded at the next banner if one is ever added after it. */
function foldSection() {
  const boot = read(BOOTSTRAP);
  const at = boot.indexOf('§51) FOLDED VERBATIM');
  assert.ok(at > 0, `§51 is missing from the bootstrap — fold ${MIGRATION}`);
  const next = boot.slice(at + 1).search(/^--\s*§\d+\) FOLDED VERBATIM/m);
  return next < 0 ? boot.slice(at) : boot.slice(at, at + 1 + next);
}

function bodyOf(sql) {
  const at = sql.indexOf(`create or replace function public.${FN}(`);
  assert.ok(at >= 0, `${FN} is not defined`);
  const end = sql.indexOf('$fn$;', at);
  assert.ok(end > at, `${FN} has no $fn$ terminator`);
  return sql.slice(at, end);
}

const SOURCES = [['dated file', () => read(MIGRATION)], ['bootstrap §51', foldSection]];

for (const [label, sqlOf] of SOURCES) {
  const code = () => codeOf(sqlOf());
  const body = () => codeOf(bodyOf(sqlOf()));

  test(`${label}: one reader, STABLE SECURITY DEFINER, search_path pinned with pg_temp last`, () => {
    const s = code();
    const defs = s.match(new RegExp(`create or replace function public\\.${FN}\\(`, 'g')) || [];
    assert.equal(defs.length, 1, 'exactly one definition — a second overload would be a second, unaudited surface');
    assert.match(s, new RegExp(`create or replace function public\\.${FN}\\(p_month date default null\\)\\s*returns jsonb`));
    assert.match(body(), /language plpgsql stable security definer set search_path = public, pg_temp as \$fn\$/);
  });

  test(`${label}: the permission check is the FIRST thing the body does`, () => {
    const b = body();
    const declare = b.slice(b.indexOf('declare'), b.search(/\bbegin\b/));
    assert.ok(!/\bselect\b/i.test(declare),
      'a query in a DECLARE default runs before the guard, and the order checks scan only from begin');
    const begin = b.search(/\bbegin\b/);
    const guard = b.indexOf("if not public.has_staff_permission('finance.manage') then");
    assert.ok(begin > 0 && guard > begin, 'no finance.manage check in the body');
    assert.ok(!/\b(select|insert|update|delete|with)\b/i.test(b.slice(begin, guard)),
      'the body touches data before checking the permission');
    assert.match(b.slice(guard, guard + 220), /perform public\.app_error\('FORBIDDEN'/);
  });

  test(`${label}: the month is validated AFTER the guard, with the reader-argument errcode`, () => {
    const b = body();
    const guard = b.indexOf("has_staff_permission('finance.manage')");
    const bad = b.indexOf("using errcode = '22023'");
    assert.ok(bad > guard, 'an unauthorized caller must get FORBIDDEN, never a bounds message it can probe');
    assert.match(b, /v_month < v_min or v_month > v_max/);
  });

  test(`${label}: revoked from every client role, granted back to authenticated only`, () => {
    const s = code();
    assert.ok(s.includes(`revoke all on function public.${FN}(date) from public, anon, authenticated;`));
    assert.ok(s.includes(`grant execute on function public.${FN}(date) to authenticated;`));
    const grants = s.match(new RegExp(`grant execute on function public\\.${FN}\\(date\\) to (\\w+)`, 'g')) || [];
    assert.equal(grants.length, 1, 'anon and public must never be granted back');
  });

  test(`${label}: income is read from the LEDGER — never a price, a request amount or a lifetime total`, () => {
    const b = body();
    for (const banned of ['price_php', 'compare_at_php', 'amount_paid', 'amount_expected',
      'finance_request_collected', 'enrollment_requests']) {
      assert.ok(!b.includes(banned), `the report must not read ${banned}`);
    }
    // Scoped to the `inc` CTE: the independent reconciliation select below uses the same three
    // predicates, so a whole-body match would still pass if the classification lost them.
    const inc = b.slice(b.indexOf('inc as ('), b.indexOf('chain as ('));
    assert.ok(inc.length > 0, 'the inc CTE could not be found');
    assert.match(inc, /a\.account_type = 'income'/, 'income must be the income-account lines');
    assert.match(inc, /sum\(l\.credit - l\.debit\)/, 'income is credit minus debit, exactly as the P&L computes it');
    assert.match(inc, /e\.entry_date between v_from and v_to/, 'dated by the ledger entry date');
  });

  test(`${label}: no retired plan is named, and the columns come from enrollment_plans`, () => {
    const b = body();
    assert.ok(!/'(gold|core|gold_live|core_self_paced|essentials)'/i.test(b),
      'a plan key literal would re-create a retired package or turn Essentials into a fourth plan');
    assert.match(b, /from public\.enrollment_plans ep/);
    assert.match(b, /order by pc\.position, pc\.key/, 'the column order is the catalog order');
  });

  test(`${label}: a reversal is attributed through its ROOT, and no row is ever lost`, () => {
    const b = body();
    assert.match(b, /with recursive/);
    assert.match(b, /reverses_entry_id/);
    assert.match(b, /c\.depth < 32/, 'the chain walk is depth-bounded');
    assert.match(b, /coalesce\(x\.root_id, i\.id\)/,
      'an entry whose root could not be resolved falls back to itself instead of dropping out');
    assert.match(b, /pe\.event_kind = 'enrollment_collection'/,
      'only an enrollment collection event may attribute money to a package');
    assert.ok(!/not exists \(select 1 from public\.finance_journal_entries rv\s+where rv\.reverses_entry_id/.test(b),
      'filtering reversed collections out would delete the original from its own date');
  });

  test(`${label}: dates never depend on the session timezone`, () => {
    const b = body();
    assert.equal((b.match(/at time zone/g) || []).length, 1, 'the only conversion is "today" in the business timezone');
    assert.match(b, /\(now\(\) at time zone v_tz\)::date/);
    assert.match(b, /generate_series\(0, v_to - v_from\)/,
      'an integer calendar — a date/interval series resolves to timestamptz and follows the session TimeZone');
    assert.ok(!/current_date|localtimestamp|current_timestamp/.test(b));
  });

  test(`${label}: the reconciliation is computed INDEPENDENTLY of the classification`, () => {
    const b = body();
    const recon = b.indexOf('into v_ledger');
    assert.ok(recon > 0, 'no independent ledger total');
    const stmt = b.slice(b.lastIndexOf('select', recon), b.indexOf(';', recon));
    assert.ok(!/\btagged\b|\bcls\b|\binc\b/.test(stmt),
      'the check total must not be built from the CTEs it is checking');
    assert.match(stmt, /a\.account_type = 'income' and e\.entry_date between v_from and v_to/);
    // The flag must be COMPUTED from the two totals — a hard-coded true would pass every other check.
    const net = String.raw`\(v_report #>> '\{totals,net_cash_income\}'\)::numeric\(14,2\)`;
    assert.match(b, new RegExp(`'classified_total', ${net}`));
    assert.match(b, new RegExp(`'difference', \\(v_ledger - ${net}\\)::numeric\\(14,2\\)`));
    assert.match(b, new RegExp(`'reconciled', v_ledger = ${net}`));
    assert.match(b, /'unlinked_collection_entries'/);
  });

  test(`${label}: a READER — no writes, no schedule, no catalog, no identity in the output`, () => {
    const b = body();
    assert.ok(!/\b(insert|update|delete|truncate)\b/i.test(b), 'the report writes nothing');
    assert.ok(!/\bcron\b/i.test(b), 'no scheduled posting — approvals already post each collection');
    for (const pii of ['student_email', 'student_user_id', 'full_name', 'email', 'payee', 'memo',
      'reference', 'created_by']) {
      assert.ok(!new RegExp(`\\b${pii}\\b`).test(b), `the report must not read ${pii}`);
    }
    const s = code();
    assert.ok(!/app_error_catalog/.test(s), '#64 adds no error code, so it must not restate the catalog');
    assert.ok(!/create policy|create table|alter table/.test(s), '#64 is one function');
    assert.ok(!/insert into public\.staff_(permissions|role_permissions)/.test(s));
  });

  test(`${label}: it reloads the schema cache and records itself`, () => {
    const s = code();
    assert.ok(s.includes("notify pgrst, 'reload schema'"));
    assert.ok(s.includes(`insert into public.schema_migrations (filename, checksum, notes) values\n ('${FILENAME}'`));
    assert.ok(!/^\s*(begin|commit|rollback)\s*;/im.test(s), 'no transaction wrapper');
  });
}

test('the dated file refuses to run before #63 and expects the matrix it leaves alone', () => {
  const s = read(MIGRATION);
  const at = s.indexOf('do $pre$');
  assert.ok(at > 0, 'no preflight');
  const pre = s.slice(at, s.indexOf('$pre$;', at));
  assert.ok(pre.includes('2026-09-18-management-hardening.sql'), 'the preflight must require #63');
  assert.match(pre, /count\(\*\) from public\.staff_permissions\) <> 22/);
  assert.ok(!s.includes('FOLDED VERBATIM'),
    'the fold banner phrase inside the dated file would break every fold slice in the bootstrap');
});

test('§51 is the last fold and keeps the schema_migrations insert but not the preflight', () => {
  const fold = foldSection();
  assert.match(fold, /^§51\) FOLDED VERBATIM — 2026-09-19-finance-daily-income\.sql/);
  assert.ok(!codeOf(fold).includes('do $pre$'), 'folds drop the preflight');
  assert.ok(fold.includes(`('${FILENAME}'`), 'folds keep the schema_migrations insert');
  // Actually assert LASTNESS, which the title has always claimed and the body never checked.
  // On a fresh install the last definition wins, so a later fold spliced ABOVE §51 would
  // silently reinstate an older finance_daily_income_report. A §52 appended BELOW is fine and
  // expected — what must never happen is another banner appearing before this one.
  const boot = read(BOOTSTRAP);
  const banners = [...boot.matchAll(/^--\s*§(\d+)\) FOLDED VERBATIM/gm)].map((m) => Number(m[1]));
  assert.ok(banners.length > 0, 'the bootstrap lost its fold banners');
  assert.equal(Math.max(...banners), banners[banners.length - 1],
    'the highest-numbered fold must also be the LAST one in the file');
  assert.equal(banners.filter((n) => n === 51).length, 1, '§51 appears exactly once');
  assert.ok(banners.indexOf(51) === banners.length - 1 || Math.max(...banners) > 51,
    '§51 must be last, or superseded only by a higher-numbered fold placed after it');
});
