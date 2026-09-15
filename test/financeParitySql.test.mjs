// ─────────────────────────────────────────────────────────────────────────────
// test/financeParitySql.test.mjs — the #59 finance-parity contract, asserted against the
// SQL text of BOTH the dated migration and its bootstrap fold §46. No database.
// ─────────────────────────────────────────────────────────────────────────────
// Behaviour that only a database can prove (a feed-linked line cannot be cleared twice,
// undo-then-add posts anew, the P&L memo stays out of net) was probed against the live
// catalog in an aborted transaction before apply; test-db/financeRls.dbtest.mjs carries
// the durable versions. What lives here is the SHAPE that makes those true.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-14-finance-parity.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const FILES = [MIGRATION, BOOTSTRAP];

/** Executable SQL only — prose names the things that must not exist. */
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

function section(rel) {
  const sql = read(rel);
  if (rel !== BOOTSTRAP) return sql;
  const at = sql.indexOf('§46) FOLDED VERBATIM');
  assert.ok(at > 0, '§46 is missing from the bootstrap — re-fold db/2026-09-14-finance-parity.sql');
  const next = sql.slice(at + 1).search(/^--\s*§\d+\) FOLDED VERBATIM/m);
  return next < 0 ? sql.slice(at) : sql.slice(at, at + 1 + next);
}

const fnBody = (s, name) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$fn\\$;`).exec(s)?.[0] || '';

/** Functions whose argument list or return type #59 changes — each must be dropped first. */
const RESIGNED = {
  finance_post_entry: 'date, text, text, text, jsonb, text',
  finance_post_manual_entry: 'date, text, text, jsonb, text',
  finance_ledger_list: 'date, date, uuid, text, text, integer, integer',
  finance_cash_basis_pl: 'date, date, text',
  finance_bank_transactions_list: 'uuid, uuid, text, date, date, integer, integer',
};

for (const file of FILES) {
  const sql = () => codeOf(section(file));

  test(`${file}: the preset table is RLS-enabled, revoked, and has exactly one SELECT policy`, () => {
    const s = sql();
    const t = 'finance_expense_presets';
    assert.ok(s.includes(`create table if not exists public.${t} (`), `${t} is not created`);
    assert.ok(s.includes(`alter table public.${t} enable row level security`), `${t} has no RLS`);
    assert.ok(s.includes(`revoke all on table public.${t} from public, anon, authenticated`), `${t} keeps default grants`);
    const block = /do \$pol\$[\s\S]*?\$pol\$;/.exec(s)?.[0];
    assert.ok(block, 'the policy loop could not be found');
    assert.equal([...block.matchAll(/create policy/gi)].length, 1, 'exactly one policy per table');
    assert.ok(/for select to authenticated/.test(block) && !/\bfor\s+(all|insert|update|delete)\b/i.test(block),
      'the only policy must be a SELECT — a write policy is a raw PostgREST write path over finance data');
    assert.ok(!/create policy[^;]*finance_/i.test(s.split(block).join('')), 'a finance policy is created outside the loop');
    assert.ok(!/grant\s+(insert|update|delete|all)\s+on\s+table\s+public\.finance_/i.test(s), 'a finance table was granted a write verb');
  });

  test(`${file}: a preset never carries an amount`, () => {
    const table = /create table if not exists public\.finance_expense_presets \(([\s\S]*?)\n\);/.exec(sql())?.[1] || '';
    assert.ok(table, 'the preset table could not be found');
    assert.ok(!/\bamount\b/.test(table),
      'a preset with an amount is a recurring posting in disguise — the legacy pre-posted expenses');
  });

  test(`${file}: every granted function is SECURITY DEFINER and checks finance.manage first`, () => {
    const s = sql();
    const granted = [...new Set([...s.matchAll(/grant execute on function public\.(finance_\w+)\(/g)].map((m) => m[1]))];
    assert.ok(granted.length >= 20, `expected the #59 RPC surface, found ${granted.length}`);
    for (const name of granted) {
      const body = fnBody(s, name);
      assert.ok(body, `${name} is granted but its body could not be found`);
      assert.ok(/security definer/.test(body), `${name} must be SECURITY DEFINER`);
      assert.ok(/set search_path = public, pg_temp/.test(body), `${name} must pin search_path with pg_temp last`);
      const begin = body.search(/\bbegin\b/);
      const guard = body.indexOf("has_staff_permission('finance.manage')");
      assert.ok(begin > 0 && guard > begin, `${name} has no finance.manage check`);
      assert.ok(!/\b(select|insert|update|delete)\b/i.test(body.slice(begin, guard).replace(/if not public\.$/, '')),
        `${name} touches data before checking the permission`);
      assert.ok(s.includes(`revoke all on function public.${name}(`), `${name} is not revoked first`);
    }
  });

  test(`${file}: every re-signed function is dropped before it is created`, () => {
    const s = sql();
    for (const [name, oldArgs] of Object.entries(RESIGNED)) {
      const drop = s.indexOf(`drop function if exists public.${name}(${oldArgs});`);
      const create = s.indexOf(`create or replace function public.${name}(`);
      assert.ok(drop >= 0, `${name}(${oldArgs}) is never dropped — it would survive beside the new overload`);
      assert.ok(create > drop, `${name} must be dropped BEFORE it is re-created`);
    }
    assert.ok(!s.includes('grant execute on function public.finance_post_entry('),
      'finance_post_entry is internal; a grant would give it an argument surface');
  });

  test(`${file}: the entry guard freezes payee and the adjustment link`, () => {
    const guard = /create or replace function public\.finance_entry_guard\(\)[\s\S]*?\$fn\$;/.exec(sql())?.[0] || '';
    assert.ok(/new\.payee is distinct from old\.payee/.test(guard), 'payee must be frozen after insert');
    assert.ok(/new\.adjusts_entry_id is distinct from old\.adjusts_entry_id/.test(guard),
      'adjusts_entry_id must be frozen after insert');
  });

  test(`${file}: one entry clears one statement line, and the link has one shape`, () => {
    const s = sql();
    assert.ok(/create unique index if not exists finance_bank_txn_entry_once\s+on public\.finance_bank_transactions \(matched_entry_id, account_id\) where matched_entry_id is not null/.test(s),
      'without the unique index two deposits could be matched to the same approval; keyed on the entry '
      + 'ALONE, a transfer could never be cleared on its second statement');
    assert.ok(/check \(\(matched_entry_id is null\) = \(matched_via is null\)\)/.test(s), 'matched_via and matched_entry_id must agree');
  });

  test(`${file}: Add posts only from a committed import, under a lock, keyed per attempt`, () => {
    const body = fnBody(sql(), 'finance_categorize_bank_transaction');
    assert.ok(/for update/.test(body), 'two tabs pressing Add must not both post');
    assert.ok(/status = 'committed'/.test(body), 'a staged import can still be discarded, stranding the entry');
    assert.ok(/'bank:' \|\| p_txn_id::text \|\| ':' \|\| v_attempt::text/.test(body),
      'keyed on the transaction alone, Add -> Undo -> Add silently re-links the reversed entry');
    assert.ok(/categorize_attempts = v_attempt/.test(body), 'the attempt counter must advance');
  });

  test(`${file}: every reconciliation writer refuses a line the feed already cleared`, () => {
    const s = sql();
    assert.ok(/matched_entry_id is not null[\s\S]*FINANCE_BANK_TXN_LINKED/.test(fnBody(s, 'finance_bank_txn_set_status')),
      'excluding or restoring a feed-linked line must be refused');
    const match = fnBody(s, 'finance_match_reconciliation_item');
    assert.ok(/t\.status <> 'unmatched' or t\.matched_entry_id is not null/.test(match),
      'a reconciliation item must not clear a feed-linked or excluded line');
    assert.ok(/bt\.matched_entry_id = jl\.entry_id/.test(match), 'nor name a ledger line the feed already claimed');
    assert.ok(/status = 'matched' and matched_entry_id is null/.test(fnBody(s, 'finance_unmatch_reconciliation_item')),
      'unmatching an item must not reset a line the feed still holds');
    const detail = fnBody(s, 'finance_reconciliation_detail');
    assert.ok(/'feed_cleared'/.test(detail), 'the screen must explain what the feed cleared');
    assert.ok(/bt\.matched_entry_id = e\.id/.test(detail), 'candidate lines must exclude feed-claimed entries');
  });

  test(`${file}: Undo reverses only what the feed added, and never inside a closed reconciliation`, () => {
    const body = fnBody(sql(), 'finance_undo_bank_transaction');
    assert.ok(/r\.status = 'closed'\s+and v_t\.posted_on between r\.period_start and r\.period_end/.test(body),
      'feed-linked lines have no item row, so the freeze must be checked by account and date');
    assert.ok(/if v_t\.matched_via = 'add' then\s+v_rev := public\.finance_reverse_entry/.test(body),
      'a MATCHED entry (an approval) is still true and must only be unlinked');
  });

  test(`${file}: reclassify moves only what is left, between allowed accounts`, () => {
    const s = sql();
    const body = fnBody(s, 'finance_reclassify_entry');
    assert.ok(/e\.adjusts_entry_id = p_entry_id/.test(body),
      'measured on the original lines alone, reclassifying twice moves the money twice');
    assert.ok(/v_from\.account_type = 'expense' and v_to\.subtype = 'owner_draw'/.test(body),
      "expense -> owner's draw is the legacy correction that must be allowed");
    assert.ok(/'reclassify:' \|\| p_idempotency_key/.test(body), 'a replayed click must not post twice');
    assert.ok(/FINANCE_ENTRY_HAS_ADJUSTMENTS/.test(fnBody(s, 'finance_reverse_entry')),
      'reversing an entry with a live adjustment would leave that adjustment orphaned');
  });

  test(`${file}: the owner's draw memo is shown beside the P&L and never counted in it`, () => {
    const body = fnBody(sql(), 'finance_cash_basis_pl');
    assert.ok(/'memo_owner_draw'/.test(body), 'the memo section is missing');
    const total = /sum\(case when g\.sect in \('income','other_income'\) then g\.amt\s+when g\.sect in \('cost_of_sales','operating_expense','other_expense'\) then -g\.amt\s+else 0 end\)/.exec(body);
    assert.ok(total, 'period_total must name the profit sections explicitly and give everything else 0');
    assert.ok(/p_group not in \('month','quarter','week','total'\)/.test(body), 'unknown groupings must be refused');
  });

  test(`${file}: seeded presets resolve their account by code AND type`, () => {
    assert.ok(/join public\.finance_accounts a on a\.code = v\.code and a\.account_type = 'expense'/.test(sql()),
      'a same-code account of another type must never be bound to an expense preset');
  });

  test(`${file}: every audit action written is in the widened CHECK`, () => {
    const s = sql();
    const check = /add constraint finance_audit_events_action_check check \(action in \(([\s\S]*?)\)\);/.exec(s)?.[1] || '';
    const allowed = new Set([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    assert.ok(allowed.has('backfill_run') && allowed.has('bank_undo'), 'the CHECK must carry #58 and #59 actions');
    const written = new Set([...s.matchAll(/values \(v_actor, v_email, '([a-z_]+)'/g)].map((m) => m[1]));
    for (const a of written) assert.ok(allowed.has(a), `audit action ${a} is written but not allowed by the CHECK`);
  });

  // ── Findings of the #59 stage review, pinned so they cannot quietly return ─────
  test(`${file}: a transfer can be cleared on both of its statements`, () => {
    const s = sql();
    assert.ok(/matched_entry_id = p_entry_id and account_id = v_t\.account_id/.test(fnBody(s, 'finance_match_bank_transaction')),
      'Match must treat an entry as claimed only on THIS statement account');
    assert.ok(/bt\.matched_entry_id = e\.id and bt\.account_id = v_t\.account_id/.test(fnBody(s, 'finance_bank_match_candidates')),
      'the other side of a transfer must stay a candidate on its own statement');
    assert.ok(/bt\.matched_entry_id = e\.id and bt\.account_id = v_rec\.account_id/.test(fnBody(s, 'finance_reconciliation_detail')),
      'reconciliation candidates must exclude only lines the feed claimed on this account');
    assert.ok(/bt\.matched_entry_id = jl\.entry_id and bt\.account_id = jl\.account_id/.test(fnBody(s, 'finance_match_reconciliation_item')),
      'a reconciliation item may name a transfer line the feed cleared on the OTHER account');
  });

  test(`${file}: writers lock the row they check before they change it`, () => {
    const s = sql();
    for (const [fn, pattern] of [
      ['finance_reclassify_entry', /from public\.finance_journal_entries where id = p_entry_id for update/],
      ['finance_reverse_entry', /from public\.finance_journal_entries where id = p_entry_id for update/],
      ['finance_match_bank_transaction', /from public\.finance_journal_entries where id = p_entry_id for update/],
      ['finance_match_reconciliation_item', /from public\.finance_bank_transactions where id = p_bank_transaction_id for update/],
      ['finance_categorize_bank_transaction', /from public\.finance_bank_transactions where id = p_txn_id for update/],
      ['finance_undo_bank_transaction', /from public\.finance_bank_transactions where id = p_txn_id for update/],
    ]) {
      assert.ok(pattern.test(fnBody(s, fn)), `${fn} must lock before checking — two tabs could otherwise both pass`);
    }
  });

  test(`${file}: only an ORIGINAL entry can be reclassified`, () => {
    assert.ok(/if v_orig\.adjusts_entry_id is not null then/.test(fnBody(sql(), 'finance_reclassify_entry')),
      'an adjustment of an adjustment points elsewhere, so its remaining amount is not netted and money moves twice');
  });

  test(`${file}: a closed reconciliation freezes Add, Match and status changes`, () => {
    const s = sql();
    for (const fn of ['finance_categorize_bank_transaction', 'finance_match_bank_transaction',
      'finance_bank_txn_set_status', 'finance_undo_bank_transaction']) {
      assert.ok(/r\.status = 'closed'/.test(fnBody(s, fn)) && /FINANCE_RECONCILIATION_CLOSED/.test(fnBody(s, fn)),
        `${fn} must refuse inside a closed reconciliation — otherwise its cleared total moves with no reopen`);
    }
  });

  test(`${file}: a card reconciliation compares amounts OWED`, () => {
    const s = sql();
    for (const fn of ['finance_close_reconciliation', 'finance_reconciliation_detail']) {
      assert.ok(/cash_flow_class = 'card' then -1 else 1/.test(fnBody(s, fn)),
        `${fn}: a card statement's balance rises with charges, which are stored negative — without the sign it can never close`);
    }
  });

  test(`${file}: a deposit cannot be added to an account approvals post to`, () => {
    const body = fnBody(sql(), 'finance_categorize_bank_transaction');
    assert.ok(/FINANCE_BANK_ENROLLMENT_INCOME/.test(body), 'the refusal is missing');
    assert.ok(/s\.default_income_account_id = v_cat\.id/.test(body) && /p\.finance_income_account_id = v_cat\.id/.test(body),
      'both the settings default and every plan-mapped income account receive approvals');
  });

  test(`${file}: the feed filters to committed lines before the limit`, () => {
    const body = fnBody(sql(), 'finance_bank_transactions_list');
    assert.ok(/p_committed_only boolean default false/.test(body), 'the committed-only argument is missing');
    assert.ok(/not coalesce\(p_committed_only, false\) or imp\.status = 'committed'/.test(body),
      'filtered after the limit, a large staged file pushes every committed line off the page');
  });

  test(`${file}: no permission change, no transaction wrapper, records itself`, () => {
    const s = sql();
    assert.ok(!/insert into public\.staff_(permissions|role_permissions)\b/.test(s),
      '#59 must not restate the permission seed; staffRolesSql reads #58 as the current seed');
    assert.ok(!/^\s*(begin|commit|rollback)\s*;/im.test(s), 'no transaction wrapper');
    assert.ok(s.includes("notify pgrst, 'reload schema'"), 'without the reload the new RPCs are invisible');
    assert.ok(s.includes("'2026-09-14-finance-parity.sql'"), 'the migration must name itself in schema_migrations');
  });
}

test('#59 error codes are in the catalog, the client list and the copy table', () => {
  const sql = read(MIGRATION);
  const catalog = sql.slice(sql.indexOf('create or replace function public.app_error_catalog()'));
  const raised = new Set([...sql.matchAll(/app_error\(\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
  for (const code of raised) {
    assert.ok(catalog.includes(`('${code}'`), `${code} is raised but not catalogued`);
    assert.ok(APP_ERROR_CODES.includes(code), `${code} is unknown to the client`);
    assert.ok(APP_ERROR_COPY[code], `${code} has no user-facing copy`);
  }
  for (const code of ['FINANCE_RECLASSIFY_INVALID', 'FINANCE_PRESET_INVALID', 'FINANCE_BANK_TXN_LINKED',
    'FINANCE_BANK_TXN_NOT_LINKED', 'FINANCE_BANK_MATCH_MISMATCH', 'FINANCE_BANK_CATEGORY_INVALID',
    'FINANCE_ENTRY_HAS_ADJUSTMENTS']) {
    assert.ok(catalog.includes(`('${code}'`), `${code} missing from the catalog`);
  }
});
