// src/lib/financeModel.js — the shared vocabulary of the Financial Management domain (#58).
//
// ★ THE SERVER IS THE AUTHORITY, AND THIS MODULE DELIBERATELY DOES NOT MIRROR IT.
//   Every figure a Super Admin sees is computed in SQL by finance_dashboard_summary(),
//   finance_sales_by_plan(), finance_receivables_worklist(), finance_ledger_list() and
//   finance_cash_basis_pl(), because those are the only places that can see the whole
//   ledger and enforce RLS. The client renders what the server returns.
//
//   What this module owns is exactly what the UI needs BEFORE a round trip: the account
//   vocabulary its forms offer, the reporting classes those forms may combine, the aging
//   buckets its filter chips are built from, and the idempotency key shape a dialog mints.
//   Nothing else.
//
// ★ FOUR EXPORTS, AND IT MUST STAY FOUR. src/lib/studentProgress.js is the cautionary
//   precedent: it shipped with twelve exports, of which three were ever imported. The
//   other nine were second implementations of server-owned rules — a client dense-rank, a
//   client hidden-row filter, a client score calculator — each with a passing unit test
//   and no caller, and two had already DRIFTED from the SQL they claimed to mirror.
//   Tested, green, wrong, and one import away from production.
//
//   So this file contains NO client balance check, NO P&L calculator, NO aging
//   arithmetic, NO outstanding derivation, NO duplicate fingerprint and NO money
//   formatter that rounds. Each would be a second implementation of a rule the database
//   already enforces. If the client needs a number, it reads it off the response.
//   (Money is rendered with phpFmt in BookkeeperPro.jsx, which keeps centavos — the
//   legacy app rounded them away everywhere.)
//
// NO imports, NO side effects, NO DOM/Node/Supabase — the same rules run identically in
// the browser and in node:test. test/financeSql.test.mjs pins the two constants below
// against BOTH db/2026-09-09-financial-management.sql and the §45 bootstrap fold, so a
// vocabulary changed here without the SQL following fails offline rather than in
// production.

/**
 * The five account types and which side increases them.
 *
 * `normalBalance` is NOT a client calculation — it labels the account form and lets it
 * show "debit increases this" next to the right field. In SQL it is a GENERATED column
 * derived from account_type, so it can never disagree with the type it describes.
 */
export const FINANCE_ACCOUNT_TYPES = Object.freeze([
  Object.freeze({ key: 'asset',     label: 'Asset',     normalBalance: 'debit'  }),
  Object.freeze({ key: 'liability', label: 'Liability', normalBalance: 'credit' }),
  Object.freeze({ key: 'equity',    label: 'Equity',    normalBalance: 'credit' }),
  Object.freeze({ key: 'income',    label: 'Income',    normalBalance: 'credit' }),
  Object.freeze({ key: 'expense',   label: 'Expense',   normalBalance: 'debit'  }),
]);

/**
 * Business / personal / owner's draw, and which account types each may legally apply to.
 *
 * ★ `allowedAccountTypes` is a PRESENTATION FILTER, NOT A PERMISSION. It lets the account
 *   form grey out an impossible combination before the server refuses it. The boundary is
 *   the CHECK constraint `reporting_class = 'business' or account_type not in
 *   ('income','expense')`, which is what makes personal spending structurally unable to
 *   be an expense — so it leaves the P&L while the cash side of its entry still ties.
 *   The legacy app did this with four hardcoded strings in the browser, invisible to the
 *   server and absent from its own CSV export.
 */
export const FINANCE_REPORTING_CLASSES = Object.freeze([
  Object.freeze({
    key: 'business', label: 'Business',
    allowedAccountTypes: Object.freeze(['asset', 'liability', 'equity', 'income', 'expense']),
  }),
  Object.freeze({
    key: 'personal', label: 'Personal',
    // Never income or expense — that is the constraint, stated here only so the form
    // can say so before the round trip.
    allowedAccountTypes: Object.freeze(['asset', 'liability', 'equity']),
  }),
  Object.freeze({
    key: 'owner_draw', label: "Owner's draw",
    allowedAccountTypes: Object.freeze(['equity']),
  }),
]);

/**
 * The receivables aging buckets.
 *
 * These keys are the ones `finance_receivables_worklist(p_bucket => …)` validates against
 * and returns in `aging_bucket`; the server computes the bucket from the SAME expression
 * it filters on, so there is one definition rather than two that drift. This list exists
 * only so the filter chips cannot offer a bucket the server would reject.
 */
export const FINANCE_AGING_BUCKETS = Object.freeze([
  Object.freeze({ key: 'current', label: 'Current' }),
  Object.freeze({ key: '1-30',    label: '1–30 days' }),
  Object.freeze({ key: '31-60',   label: '31–60 days' }),
  Object.freeze({ key: '61-90',   label: '61–90 days' }),
  Object.freeze({ key: '90+',     label: '90+ days' }),
]);

/**
 * The idempotency key a manual entry dialog mints when it OPENS.
 *
 * ★ Minted on open, not on submit. That is the whole point: a double-click, a retry after
 *   a timeout, and a re-submitted form all carry the SAME key, so the unique index on
 *   finance_payment_events.idempotency_key collapses them into one posting instead of
 *   three. A key generated at submit time would be fresh every time and guarantee
 *   duplicates — which is exactly how the legacy daily job re-recognised the same
 *   receivable as revenue every day it stayed open.
 *
 * ★ THE UUID IS REQUIRED, AND THERE IS DELIBERATELY NO CRYPTO FALLBACK. The first draft
 *   fell back to globalThis.crypto.randomUUID(), which is worse than useless here: a
 *   caller whose state is not yet initialised passes nothing, the function mints a FRESH
 *   uuid on every call, and a double-click therefore produces two DIFFERENT keys and two
 *   postings — defeating, silently, the exact guarantee this function exists to provide.
 *   Requiring the argument forces the caller to mint once, when the dialog opens. It also
 *   keeps this module free of platform crypto, the same inject-don't-reach idiom
 *   src/lib/trainerToken.js uses.
 *
 * @param {string} uuid a v4 UUID, minted when the dialog OPENED (not when it submitted)
 * @returns {string} e.g. "manual:3f2a…"
 */
export function manualEntryIdempotencyKey(uuid) {
  if (typeof uuid !== 'string' || !uuid.trim()) {
    // Failing loudly beats returning a key that is not stable: a per-call key would
    // silently post a duplicate, and a colliding one would silently DROP a real posting
    // via ON CONFLICT DO NOTHING. Both are invisible at the call site.
    throw new Error('manualEntryIdempotencyKey: no UUID available — pass one explicitly.');
  }
  return `manual:${uuid.trim()}`;
}
