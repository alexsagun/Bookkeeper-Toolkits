// ─────────────────────────────────────────────────────────────────────────────
// test/financeSql.test.mjs — the #58 Financial Management contract, asserted
// against the SQL text. No database required.
// ─────────────────────────────────────────────────────────────────────────────
// Runs every assertion against BOTH the dated migration and the bootstrap fold.
// bootstrapFolds.test.mjs is a line-set CONTAINMENT check: it proves nothing was
// dropped from a fold, never that nothing wrong was added — and on a fresh install
// the LAST definition wins. Only these assertions cover that direction.
//
// ★ ASSERT AGAINST EXECUTABLE SQL AND EXTRACTED VOCABULARIES, NEVER RAW TEXT.
//   While writing #58 a scratch check of the form "the string 'accounts_receivable'
//   appears nowhere in the file" FAILED — on the two comments that explain why the
//   subtype is absent, and on the migration's own schema_migrations notes, which
//   describe the design in prose. The SQL was correct; the assertion shape was
//   wrong. The tempting "fix" would have been deleting the comment that documents
//   the invariant. Extract the CHECK list and test THAT.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import { STAFF_PERMISSION_KEYS, ADMIN_TAB_PERMISSION } from '../src/lib/staffRoles.js';
import {
  FINANCE_ACCOUNT_TYPES, FINANCE_REPORTING_CLASSES, FINANCE_AGING_BUCKETS,
  manualEntryIdempotencyKey,
} from '../src/lib/financeModel.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-09-financial-management.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const FILES = [MIGRATION, BOOTSTRAP];

/** Executable SQL only — prose explains the invariants by NAMING what must not exist. */
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

/** #59 re-signs #58 functions and owns the error catalog from here on. */
const PARITY = 'db/2026-09-14-finance-parity.sql';

/** The bootstrap carries every migration; scope it to the §45 fold. */
function financeSection(rel) {
  const sql = read(rel);
  if (rel !== BOOTSTRAP) return sql;
  const at = sql.indexOf('§45) FOLDED VERBATIM');
  assert.ok(at > 0, '§45 is missing from the bootstrap — re-fold db/2026-09-09-financial-management.sql');
  // ★ BOUNDED AT THE NEXT FOLD. Sliced to end-of-file, every later migration's text was
  //   asserted as though it were #58's — so a #59 restatement could satisfy (or break) a
  //   #58 assertion for a reason that has nothing to do with #58.
  const next = sql.slice(at + 1).search(/^--\s*§\d+\) FOLDED VERBATIM/m);
  return next < 0 ? sql.slice(at) : sql.slice(at, at + 1 + next);
}

const FINANCE_TABLES = [
  'finance_settings', 'finance_accounts', 'finance_journal_entries', 'finance_journal_lines',
  'finance_payment_events', 'finance_period_locks', 'finance_audit_events',
  'finance_bank_imports', 'finance_bank_transactions', 'finance_reconciliations',
  'finance_reconciliation_items', 'finance_recurring_templates',
];

/** Each `generated always as (…)` expression, walked to its balanced close paren.
 *  ★ `\s+`, not a literal space: normal_balance breaks the line between `as` and `(`,
 *  and a one-space pattern silently skipped it — the count assertion is what noticed.
 *  `generated always as identity` has no paren and is correctly not matched. */
function generatedExpressions(code) {
  const out = [];
  for (const m of code.matchAll(/generated\s+always\s+as\s*\(/g)) {
    let i = m.index + m[0].length, depth = 1, inStr = false;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (inStr) { if (ch === "'") inStr = false; continue; }
      if (ch === "'") inStr = true; else if (ch === '(') depth++; else if (ch === ')') depth--;
    }
    out.push(code.slice(m.index, i));
  }
  return out;
}

/** Functions Postgres marks STABLE or VOLATILE that are easy to reach for in a generated column.
 *  Verified on PG 17.6: to_char, convert_to and textsend are STABLE; md5(text), sha256(bytea),
 *  extract(text, date), lower, regexp_replace, btrim and encode are IMMUTABLE. */
const NOT_IMMUTABLE_IN_GENERATED = /\b(to_char|to_date|convert_to|convert_from|textsend|now|current_date|current_timestamp|localtimestamp|clock_timestamp|statement_timestamp|random|gen_random_uuid)\b/i;

for (const file of FILES) {
  const sql = () => codeOf(financeSection(file));

  test(`${file}: all ${FINANCE_TABLES.length} finance tables are created and RLS-enabled`, () => {
    const s = sql();
    for (const t of FINANCE_TABLES) {
      assert.ok(s.includes(`create table if not exists public.${t} (`), `${t} is not created`);
      assert.ok(s.includes(`alter table public.${t} enable row level security`),
        `${t} has no "enable row level security" — Supabase grants on public tables by default, so `
        + 'every statement before that line is a window in which the table is world-readable');
      assert.ok(s.includes(`revoke all on table public.${t} from public, anon, authenticated`),
        `${t} keeps its default grants`);
    }
  });

  // ★ THE MOST VALUABLE ASSERTION IN THIS FILE. It pins the zero-client-write-path
  //   rule, which is what makes the legacy system's 30 unguarded mutations
  //   structurally unreachable rather than merely gated.
  test(`${file}: finance tables have exactly one policy and it is SELECT`, () => {
    const s = sql();
    // ★ ASSERT ON THE LOOP, NOT ON LITERAL TEXT. The policies are built inside a
    //   `do $pol$` block with format('create policy %I on public.%I …'), so the table
    //   name never appears literally. The first version of this test required
    //   `finance_` to follow the `for` clause — which means a write policy added to
    //   that same loop (`for all`, table still `%I`) could never match it. The most
    //   valuable assertion in this file was unable to fail. This is the "passes for
    //   the wrong reason" shape this file's own header warns about.
    const block = /do \$pol\$[\s\S]*?\$pol\$;/.exec(s)?.[0];
    assert.ok(block, 'the policy loop could not be found');

    const created = [...block.matchAll(/create policy/gi)];
    assert.equal(created.length, 1,
      `the policy loop creates ${created.length} policies — exactly one SELECT policy per finance `
      + 'table is the rule, and it is what keeps the zero-client-write-path guarantee true');
    assert.ok(/for select to authenticated/.test(block), 'the single policy must be a SELECT');
    assert.ok(!/\bfor\s+(all|insert|update|delete)\b/i.test(block),
      'the policy loop grants a write verb. All mutation must go through the SECURITY DEFINER '
      + 'RPCs; a FOR ALL / INSERT / UPDATE / DELETE policy is a raw PostgREST write path.');
    assert.ok(/has_staff_permission\(''finance\.manage''\)/.test(block),
      'the policy must be gated on finance.manage');

    // Nothing may create a finance policy OUTSIDE the single audited loop.
    const outside = s.split(block).join('');
    assert.ok(!/create policy[^;]*finance_/i.test(outside),
      'a finance policy is created outside the audited loop');

    assert.ok(!/grant\s+(insert|update|delete|all)\s+on\s+table\s+public\.finance_/i.test(s),
      'a finance table was granted a write verb — only SELECT may be granted back');
    assert.ok(/grant select on table public\.%I to authenticated/.test(block),
      'authenticated must be granted SELECT on each finance table');
  });

  test(`${file}: the balance invariant has all three layers`, () => {
    const s = sql();
    assert.ok(/check \(\(debit > 0\) <> \(credit > 0\)\)/.test(s),
      'the one-side-per-line CHECK is missing — without it the legacy shape (all amounts '
      + 'positive, sign carried in a separate AccountType column) becomes insertable again');
    assert.ok(s.includes('check (debit >= 0)') && s.includes('check (credit >= 0)'),
      'debit/credit must both be non-negative');

    const deferred = (s.match(/deferrable initially deferred/g) || []).length;
    assert.equal(deferred, 2,
      'both constraint triggers must be DEFERRABLE INITIALLY DEFERRED. Non-deferred, the balance '
      + 'trigger fires after line 1, sees a one-sided entry, and rejects EVERY multi-line entry '
      + 'while reading as correct in review.');
    for (const fn of ['finance_assert_entry_balanced', 'finance_assert_entry_has_lines']) {
      assert.ok(s.includes(`create or replace function public.${fn}()`), `${fn} is missing`);
    }
    assert.ok(s.includes('create or replace function public.finance_entry_guard()')
      && s.includes('FINANCE_ENTRY_IMMUTABLE'),
      'the immutability guard is missing — a posted entry must never be editable');
  });

  // ★ Extract the vocabulary; do not scan the file. See the header note.
  test(`${file}: the subtype vocabulary has no accounts_receivable`, () => {
    const m = /subtype\s+text not null check \(subtype in \(([\s\S]*?)\)\)/.exec(sql());
    assert.ok(m, 'the subtype CHECK could not be found');
    const subtypes = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    assert.ok(subtypes.length >= 15, `expected the full subtype list, found ${subtypes.length}`);
    assert.ok(!subtypes.includes('accounts_receivable'),
      'accounts_receivable is back in the chart. With a receivable account the legacy '
      + '`gross = collections + outstanding` becomes representable again, and every cash-basis '
      + 'claim in this feature stops being true by construction.');
  });

  // ★ The P&L maps sections by SUBTYPE first, so an `expense` account of subtype
  //   `other_income` would have its spending ADDED to profit.
  test(`${file}: a subtype can only be used with its own account type`, () => {
    const m = /constraint finance_accounts_subtype_matches_type check \(([\s\S]*?)\)\),/.exec(sql());
    assert.ok(m, 'the subtype <-> account_type pairing CHECK is missing');
    const pairs = [...m[1].matchAll(/account_type = '(\w+)'\s+and subtype in \(([^)]*)\)/g)]
      .map((x) => [x[1], [...x[2].matchAll(/'(\w+)'/g)].map((y) => y[1])]);
    assert.deepEqual(pairs.map((p) => p[0]), FINANCE_ACCOUNT_TYPES.map((t) => t.key),
      'every account type needs exactly one arm in the pairing CHECK');
    const all = pairs.flatMap((p) => p[1]);
    assert.equal(new Set(all).size, all.length, 'a subtype appears under two account types');
    const vocab = [...(/subtype\s+text not null check \(subtype in \(([\s\S]*?)\)\)/.exec(sql())?.[1] || '')
      .matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    assert.deepEqual(all.slice().sort(), vocab.slice().sort(),
      'the pairing must cover exactly the subtype vocabulary — an unpaired subtype is uncreatable');
    assert.ok(!all.includes('accounts_receivable'), 'accounts_receivable must not be pairable either');
  });

  test(`${file}: a card balance is reported as owed, not held`, () => {
    const fn = /create or replace function public\.finance_dashboard_summary\([\s\S]*?\$fn\$;/.exec(sql())?.[0] || '';
    assert.ok(/'balance', case when a\.cash_flow_class = 'card' then -coalesce\(b\.bal, 0\)/.test(fn),
      'cash_position must negate card rows, or summing it as cash adds the debt to the money');
  });

  test(`${file}: ledger search treats % and _ as text, not wildcards`, () => {
    const fn = /create or replace function public\.finance_ledger_list\([\s\S]*?\$fn\$;/.exec(sql())?.[0] || '';
    assert.ok(/replace\(replace\(replace\(btrim\(p_search\), '!', '!!'\), '%', '!%'\), '_', '!_'\)/.test(fn)
      && /escape '!'/.test(fn),
      'p_search must be escaped — unescaped, a search for "50%" matches every memo containing "50"');
  });

  test(`${file}: a weekly recurring template is keyed by date, and a repeat does not advance it`, () => {
    const fn = /create or replace function public\.finance_post_recurring\([\s\S]*?\$fn\$;/.exec(sql())?.[0] || '';
    assert.ok(/case when v_t\.cadence = 'weekly' then v_date::text/.test(fn),
      'a month-scoped key collapses the 2nd-4th weekly postings of a month into the first');
    const early = fn.indexOf('return v_existing');
    assert.ok(early > 0 && early < fn.indexOf('update public.finance_recurring_templates'),
      'confirming an already-posted occurrence must return BEFORE next_due_on advances, or a '
      + 'double-click silently skips a whole period');
  });

  test(`${file}: personal spending can never be an expense account`, () => {
    assert.ok(/check \(reporting_class = 'business' or account_type not in \('income','expense'\)\)/.test(sql()),
      "the reporting_class CHECK is missing. Decision 2 — personal spending is an owner's draw, "
      + 'not an expense — is a constraint, not a filter someone can forget to apply.');
  });

  test(`${file}: the P&L is cash-basis by construction, with no basis flag`, () => {
    const s = sql();
    assert.ok(!/p_basis/.test(s),
      'a basis argument is back. The legacy selector was echoed straight back and branched on '
      + 'nothing — a control that changes no number actively lies about what the number is.');
    assert.ok(s.includes("'cash'"), "the reported basis must be the literal 'cash'");
  });

  test(`${file}: the approval hook is shaped so an Ops Admin can trigger it`, () => {
    const s = sql();
    assert.ok(/create trigger finance_enrollment_collection_trg\s+after update on public\.enrollment_requests/.test(s),
      'the approval hook must be an AFTER UPDATE trigger on enrollment_requests');
    assert.ok(/when \(new\.status = 'approved' and old\.status is distinct from 'approved'\)/.test(s),
      'the WHEN clause is missing — without it the hook fires on every admin_notes edit');

    const hook = /finance_enrollment_collection_trg\(\)\s*returns trigger[\s\S]*?\$fn\$;/.exec(s)?.[0] || '';
    assert.ok(hook, 'the hook function body could not be found');
    assert.ok(/language plpgsql security definer/.test(hook),
      'the hook must be SECURITY DEFINER — the approver is usually an Operations Admin whose '
      + 'SELECT policies on the finance tables evaluate false');
    assert.ok(!hook.includes('has_staff_permission'),
      'the hook checks a permission. auth.uid() is unchanged inside a SECURITY DEFINER chain, so '
      + 'that check would refuse EVERY Operations Admin approval. Its authorization is structural: '
      + 'the only route in is a legitimate status -> approved transition.');
    assert.ok(!/exception\s+when/.test(hook),
      'the hook swallows an exception. The legacy logger wrapped every audit write in an empty '
      + 'catch, so the trail silently stopped being complete. If the audit write fails, the '
      + 'approval must fail.');
    assert.ok(/join public\.finance_accounts a on a\.id = p\.finance_income_account_id\s+and a\.active and a\.account_type = 'income'/.test(hook)
      && /v_income := coalesce\(v_mapped, v_cfg\.default_income_account_id\)/.test(hook),
      "the hook must post to the plan's mapped income account only when it is an ACTIVE income "
      + 'account, and fall back to the settings default otherwise — refusing would block approvals');
    assert.ok(!/force row level security/.test(s),
      'FORCE ROW LEVEL SECURITY subjects the table OWNER to policies and would break this trigger. '
      + 'It looks like hardening; it is a breakage.');
  });

  test(`${file}: one idempotency namespace, shared by the hook and the backfill`, () => {
    const s = sql();
    assert.ok(s.includes('idempotency_key      text not null unique')
      || /idempotency_key\s+text not null unique/.test(s),
      'finance_payment_events.idempotency_key must be NOT NULL UNIQUE — a real constraint, not a '
      + 'read-then-write check, which is the race the legacy daily job lost');
    const hits = s.split("'enrollment:'").length - 1;
    assert.ok(hits >= 2,
      'the hook and the backfill must mint the SAME key shape, or running the backfill would '
      + `duplicate every approval-created collection (found ${hits} uses)`);
    assert.ok(s.includes("':collection'"), 'the collection key suffix is missing');
  });

  test(`${file}: finance never writes the enrollment or subscription tables`, () => {
    const s = sql();
    assert.ok(!/insert into public\.(enrollment_requests|subscriptions)\b/.test(s),
      'finance must never write enrollment_requests or subscriptions — it reads the approval, it '
      + 'does not make one');
    assert.ok(!/update public\.subscriptions\b/.test(s),
      'finance must never mutate a membership term — admin_finalize_enrollment is the one grant path');
  });

  // ★ Owner decision 2026-09-12: the workbook showed the data SHAPE only, and no
  //   student was ever on it. Asserted on executable SQL, so the header comment that
  //   explains the removal cannot fail this.
  test(`${file}: there is no legacy-import subsystem`, () => {
    const s = sql();
    assert.ok(!/finance_legacy_/.test(s), 'a finance_legacy_* object is back in executable SQL');
    assert.ok(!/legacy_enrollment_id|p_include_legacy/.test(s), 'a legacy column or argument is back');
    const worklists = s.match(/create or replace function public\.finance_receivables_worklist\(/g) || [];
    assert.equal(worklists.length, 1, 'the receivables worklist must be defined exactly once');
    const drop = s.indexOf('drop function if exists public.finance_receivables_worklist(numeric, boolean, text, integer, integer)');
    assert.ok(drop > 0 && drop < s.indexOf('create or replace function public.finance_receivables_worklist('),
      '`create or replace` cannot change an argument list, so the retired 5-argument overload must be '
      + 'DROPPED before the 4-argument create or it survives beside it, still granted');
  });

  // ★ ONE DEFINITION OF "COLLECTED". Three reports used to carry a private copy, and
  //   none of them excluded a reversed collection or signed a refund.
  test(`${file}: every report reads collected money from the one helper`, () => {
    const s = sql();
    const helper = /create or replace function public\.finance_request_collected\(p_request_id uuid\)[\s\S]*?\$fn\$;/.exec(s)?.[0];
    assert.ok(helper, 'finance_request_collected is missing');
    assert.ok(/reverses_entry_id = pe\.journal_entry_id/.test(helper),
      'a reversed collection must not count as collected, or the P&L and the receivables disagree');
    assert.ok(/when 'out' then -pe\.amount/.test(helper),
      'an outgoing event (a refund) must SUBTRACT — `amount` is a magnitude');
    assert.ok(s.includes('revoke all on function public.finance_request_collected(uuid)')
      && !s.includes('grant execute on function public.finance_request_collected('),
      'the helper is internal and must not be granted to a client role');
    for (const name of ['finance_dashboard_summary', 'finance_sales_by_plan', 'finance_receivables_worklist']) {
      const body = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$fn\\$;`).exec(s)?.[0] || '';
      assert.ok(body.includes('public.finance_request_collected('), `${name} does not use the helper`);
      assert.ok(!/select sum\(pe\.amount\)/.test(body), `${name} sums payment events itself again`);
      // ★ ONE APPROVAL DATE. A bare reviewed_at (nullable) or a UTC ::date puts the
      //   same approved row in one report and out of another.
      assert.ok(/coalesce\(r\.reviewed_at, r\.created_at\) at time zone/.test(body),
        `${name} must date an approval as coalesce(reviewed_at, created_at) in the business timezone`);
      assert.ok(!/r\.reviewed_at::date/.test(body), `${name} dates an approval in UTC again`);
    }
  });

  // ★ WALK EACH GENERATED EXPRESSION TO ITS CLOSING PAREN. The first version of this
  //   pin searched a fixed 500-character window for to_char ALONE — and passed while
  //   the bank fingerprint used convert_to, which is STABLE too. The first production
  //   apply of #58 was refused on exactly that ("generation expression is not
  //   immutable"), which reads like a Postgres bug and is not. It rolled back whole
  //   only because it was sent as one transaction.
  test(`${file}: generated columns use IMMUTABLE functions only`, () => {
    const exprs = generatedExpressions(sql());
    assert.ok(exprs.length >= 3,
      `expected normal_balance, period_key and fingerprint to be generated, found ${exprs.length}`);
    for (const e of exprs) {
      const bad = NOT_IMMUTABLE_IN_GENERATED.exec(e);
      assert.ok(!bad, `"${bad?.[0]}" is not IMMUTABLE, so this generated column is refused at apply `
        + `time: ${e.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    const fp = exprs.find((e) => e.includes('description_raw'));
    assert.ok(fp, 'the bank fingerprint is no longer a generated column');
    assert.ok(/^generated\s+always\s+as\s*\(\s*md5\(/.test(fp),
      'the fingerprint must be md5(<normalized text>) — IMMUTABLE, and no encoding step');
    assert.ok(!/::bytea/.test(fp),
      'text::bytea runs byteain, which parses backslash escapes: it is safe only while the '
      + 'description regexp happens to strip every backslash');
  });

  test(`${file}: a period can only be locked once it has elapsed, in the business timezone`, () => {
    const fn = /finance_lock_period\(p_period_key text, p_note text default null\)[\s\S]*?\$fn\$;/.exec(sql())?.[0] || '';
    assert.ok(fn, 'finance_lock_period could not be found');
    assert.ok(fn.includes('FINANCE_PERIOD_NOT_ELAPSED'),
      'locking a period that has not finished must be refused');
    assert.ok(fn.includes('reporting_timezone'),
      'the comparison must be made in the business timezone — a UTC comparison would lock an '
      + 'Asia/Manila month up to 16 hours early');
  });

  test(`${file}: every reporting RPC checks the permission before it reads anything`, () => {
    const s = sql();
    const reporting = ['finance_dashboard_summary', 'finance_sales_by_plan',
      'finance_receivables_worklist', 'finance_ledger_list', 'finance_cash_basis_pl',
      'finance_audit_feed',
      // The "manage" screens' readers. A reader that forgets the check is an
      // exfiltration path: SECURITY DEFINER in public is callable by authenticated.
      'finance_setup_state', 'finance_accounts_list', 'finance_period_locks_list',
      'finance_recurring_list', 'finance_bank_imports_list', 'finance_bank_transactions_list',
      'finance_reconciliations_list', 'finance_reconciliation_detail'];
    for (const name of reporting) {
      const body = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$fn\\$;`).exec(s)?.[0];
      assert.ok(body, `${name} could not be found`);
      assert.ok(/stable security definer/.test(body), `${name} must be STABLE SECURITY DEFINER`);
      assert.ok(/set search_path = public, pg_temp/.test(body),
        `${name} must pin search_path with pg_temp LAST`);
      const guard = body.indexOf("has_staff_permission('finance.manage')");
      assert.ok(guard > 0, `${name} has no permission check`);
      const firstRead = body.search(/\breturn query\b|\bselect .* into \b/);
      assert.ok(firstRead === -1 || guard < firstRead,
        `${name} reads a table before checking the permission. A SECURITY DEFINER function in `
        + 'public is callable by authenticated by default, so the in-body check — not the grant — '
        + 'is the boundary.');
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked first`);
      assert.ok(s.includes(`grant execute on function public.${name}(`), `${name} is not granted`);
    }
  });

  // ★ EVERY client-callable finance function, not a hand-kept list: a writer added
  //   later and missed here would be an unguarded SECURITY DEFINER mutation.
  test(`${file}: every granted finance function checks finance.manage first`, () => {
    const s = sql();
    const granted = [...new Set([...s.matchAll(/grant execute on function public\.(finance_\w+)\(/g)].map((m) => m[1]))];
    assert.ok(granted.length >= 30, `expected the finance RPC surface, found ${granted.length}`);
    for (const name of granted) {
      const body = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$fn\\$;`).exec(s)?.[0];
      assert.ok(body, `${name} is granted but its body could not be found`);
      assert.ok(/security definer/.test(body), `${name} must be SECURITY DEFINER`);
      const begin = body.search(/\bbegin\b/);
      const guard = body.indexOf("has_staff_permission('finance.manage')");
      assert.ok(guard > begin && begin > 0, `${name} has no finance.manage check in its body`);
      const beforeGuard = body.slice(begin, guard);
      assert.ok(!/\b(select|insert|update|delete)\b/i.test(beforeGuard.replace(/if not public\.$/, '')),
        `${name} touches data before checking the permission`);
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked first`);
    }
  });

  test(`${file}: trigger functions are revoked and never granted back`, () => {
    const s = sql();
    const triggerFns = ['finance_entry_guard', 'finance_line_guard', 'finance_payment_event_guard',
      'finance_audit_guard', 'finance_enrollment_collection_trg', 'finance_post_entry',
      'finance_resolve_period'];
    for (const fn of triggerFns) {
      assert.ok(s.includes(`revoke all on function public.${fn}(`), `${fn} is not revoked`);
      assert.ok(!s.includes(`grant execute on function public.${fn}(`),
        `${fn} is granted to a client role. It is trigger-only or internal, so a grant would give `
        + 'it an argument surface it must not have.');
    }
  });

  test(`${file}: it records itself and reloads the schema cache`, () => {
    const s = sql();
    assert.ok(s.includes("notify pgrst, 'reload schema'"),
      'without the reload every new RPC is invisible to PostgREST');
    assert.ok(s.includes("'2026-09-09-financial-management.sql'"),
      'the migration must name itself in schema_migrations — that filename literal is the '
      + 'tripwire that would have caught the 2026-08-23 deletion of §30');
  });

  test(`${file}: no transaction wrapper`, () => {
    const s = sql();
    assert.ok(!/^\s*(begin|commit|rollback)\s*;/im.test(s),
      'apply-db-files.mjs sends one statement per HTTP round trip, so a migration cannot be '
      + 'wrapped in a transaction');
  });
}

// ── Client mirror parity ─────────────────────────────────────────────────────

test('finance.manage is the 20th permission and is Super-Admin-only', () => {
  assert.ok(STAFF_PERMISSION_KEYS.includes('finance.manage'), 'finance.manage is missing from the mirror');
  // #61 appended communications.send and #62 meetings.manage after it; the SQL seed order is still what
  // staffRolesSql.test.mjs diffs, so position 20 is pinned rather than "last".
  assert.equal(STAFF_PERMISSION_KEYS.indexOf('finance.manage'), 19,
    'finance.manage must stay the 20th key, matching the SQL seed order — staffRolesSql.test.mjs '
    + 'asserts deepEqual on order, not set membership');
  assert.equal(ADMIN_TAB_PERMISSION.financialmanagement, 'finance.manage',
    'the admin tab chokepoint must gate financialmanagement on finance.manage');

  const seed = read(MIGRATION);
  const grants = [...seed.matchAll(/\('(\w+)',\s*'finance\.manage'\)/g)].map((m) => m[1]);
  assert.deepEqual(grants, ['super_admin'],
    'finance.manage is granted to a non-super role. An Operations Admin reviews payment proofs — '
    + 'and causes a finance write when they approve one — but may not read the books.');
});

test('every finance error code is in the SQL catalog, the client list and the copy table', () => {
  // The catalog is one VALUES list restated whole, so the CURRENT owner is the last file
  // that restates it (#59). Raised codes come from both finance migrations.
  const owner = read(PARITY);
  const catalog = owner.slice(owner.indexOf('create or replace function public.app_error_catalog()'));
  const sql = read(MIGRATION) + '\n' + owner;
  const financeCodes = APP_ERROR_CODES.filter((c) => c.startsWith('FINANCE_'));
  assert.ok(financeCodes.length >= 27, `expected the finance codes, found ${financeCodes.length}`);
  for (const code of financeCodes) {
    assert.ok(catalog.includes(`('${code}'`), `${code} is not in app_error_catalog()`);
    assert.ok(APP_ERROR_COPY[code], `${code} has no user-facing copy`);
  }
  // And the other direction: nothing raised in SQL is missing from the client.
  const raised = new Set([...sql.matchAll(/app_error\(\s*'(FINANCE_[A-Z0-9_]+)'/g)].map((m) => m[1]));
  for (const code of raised) {
    assert.ok(APP_ERROR_CODES.includes(code),
      `${code} is raised by SQL but unknown to the client, so appErrorCode() rejects the hint and `
      + 'the user sees a raw Postgres string instead of the written copy');
  }
});

test('financeModel vocabularies match the SQL CHECK constraints', () => {
  const sql = codeOf(read(MIGRATION));

  const types = [...(/account_type\s+text not null check \(account_type in \(([^)]*)\)\)/
    .exec(sql)?.[1] || '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(FINANCE_ACCOUNT_TYPES.map((t) => t.key), types,
    'FINANCE_ACCOUNT_TYPES has drifted from the account_type CHECK');

  const classes = [...(/reporting_class\s+text not null default 'business'\s*\n?\s*check \(reporting_class in \(([^)]*)\)\)/
    .exec(sql)?.[1] || '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(FINANCE_REPORTING_CLASSES.map((c) => c.key).sort(), classes.slice().sort(),
    'FINANCE_REPORTING_CLASSES has drifted from the reporting_class CHECK');

  // The worklist validates p_bucket against this exact list.
  const buckets = [...(/p_bucket not in \(([^)]*)\)/.exec(sql)?.[1] || '').matchAll(/'([^']+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual(FINANCE_AGING_BUCKETS.map((b) => b.key), buckets,
    'FINANCE_AGING_BUCKETS has drifted from the bucket the worklist accepts, so the UI would '
    + 'offer a filter chip the server rejects');
});

test('the manual idempotency key is stable and refuses to invent a weak one', () => {
  assert.equal(manualEntryIdempotencyKey('abc-123'), 'manual:abc-123');
  assert.throws(() => manualEntryIdempotencyKey(''), /no UUID available/,
    'returning a non-unique key would silently DROP a real posting via ON CONFLICT DO NOTHING');
});

// ★ THE BUILD CANNOT CATCH THIS, AND IT ALREADY HAPPENED ONCE. The component used
//   FINANCE_AGING_BUCKETS while financeModel.js appeared in BookkeeperPro.jsx only
//   inside a COMMENT. `npm run build` succeeded and all 1391 tests passed; opening
//   the Sales & Receivables sub-tab threw a ReferenceError, which AppErrorBoundary
//   turns into a blanked screen. There is no linter and no jsdom in this repo, so a
//   source scan is the only thing standing between that mistake and production —
//   the same reasoning as uiSafety.test.mjs §12's staffDegraded check.
test('every financeModel constant the app uses is actually imported', () => {
  const app = read('src/BookkeeperPro.jsx');
  // Strip line comments, or a mention in prose counts as a use.
  const code = app.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

  const importBlock = /import \{([^}]*)\} from '\.\/lib\/financeModel'/.exec(code)?.[1] || '';
  const imported = new Set(importBlock.split(',').map((s) => s.trim()).filter(Boolean));
  // FINANCE_SUBTABS is declared in the monolith itself; excluding locally-declared
  // names is what keeps this test from failing for the wrong reason.
  const declared = new Set(
    [...code.matchAll(/^(?:const|let|function)\s+(FINANCE_[A-Z0-9_]+)/gm)].map((m) => m[1]),
  );
  const used = new Set([...code.matchAll(/\bFINANCE_[A-Z0-9_]+\b/g)].map((m) => m[0]));

  const missing = [...used].filter((n) => !imported.has(n) && !declared.has(n));
  assert.deepEqual(missing, [],
    `BookkeeperPro.jsx uses ${missing.join(', ')} without importing it from ./lib/financeModel. `
    + 'That is a ReferenceError at render which the build cannot see and no unit test reaches.');
});

// ★ THE ONLY GUARD ON AN RPC NAME. There is no jsdom and no linter, so a typo in
//   call('finance_…') builds, passes every other test, and fails only when a Super
//   Admin clicks the button. Every finance function the app names must exist in #58
//   AND be granted — and an internal one (never granted) must never be called.
test('every finance RPC the app calls exists and is granted to authenticated', () => {
  const app = read('src/BookkeeperPro.jsx');
  const sql = codeOf(read(MIGRATION)) + '\n' + codeOf(read(PARITY));
  const called = [...new Set([...app.matchAll(/(?:call|supabase\.rpc)\(\s*'(finance_\w+)'/g)].map((m) => m[1]))];
  assert.ok(called.length >= 6, `expected the app to call the finance RPCs, found ${called.length}`);
  for (const name of called) {
    assert.ok(sql.includes(`create or replace function public.${name}(`), `the app calls ${name}, which neither #58 nor #59 defines`);
    assert.ok(sql.includes(`grant execute on function public.${name}(`),
      `the app calls ${name}, which is not granted — it would 403 for the Super Admin too`);
  }
});

// The Add-account form offers only pairs the CHECK accepts. A drift here is a form
// whose every submission of the drifted pair fails with a bare 23514.
test('the UI subtype pairs match the SQL pairing CHECK exactly', () => {
  const app = read('src/BookkeeperPro.jsx');
  const literal = /const FINANCE_SUBTYPES_BY_TYPE = \{([\s\S]*?)\n\};/.exec(app)?.[1];
  assert.ok(literal, 'FINANCE_SUBTYPES_BY_TYPE could not be found in the monolith');
  const ui = Object.fromEntries([...literal.matchAll(/(\w+): \[([^\]]*)\]/g)]
    .map((m) => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1])]));

  const check = /constraint finance_accounts_subtype_matches_type check \(([\s\S]*?)\)\),/.exec(codeOf(read(MIGRATION)))?.[1];
  assert.ok(check, 'the pairing CHECK could not be found');
  const db = Object.fromEntries([...check.matchAll(/account_type = '(\w+)'\s+and subtype in \(([^)]*)\)/g)]
    .map((m) => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1])]));

  assert.deepEqual(ui, db, 'FINANCE_SUBTYPES_BY_TYPE has drifted from finance_accounts_subtype_matches_type');
});

test('financeModel stays small — the studentProgress.js lesson', () => {
  const src = read('src/lib/financeModel.js');
  const exports = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), [
    'FINANCE_ACCOUNT_TYPES', 'FINANCE_AGING_BUCKETS', 'FINANCE_REPORTING_CLASSES',
    'manualEntryIdempotencyKey',
  ], 'financeModel.js must keep exactly four exports. studentProgress.js shipped twelve, three '
    + 'were ever imported, and two had already drifted from the SQL they claimed to mirror.');
  assert.ok(!/^import /m.test(src), 'financeModel.js must stay dependency-free');
});
