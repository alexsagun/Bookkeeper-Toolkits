// src/lib/bankStatement.js — reading a bank or card statement file into signed rows (#59).
//
// Pure: no imports, no DOM, no Supabase. The browser parses the file (CSV or XLSX) into a
// header list and row objects; this module turns those into the rows
// finance_stage_bank_import() stores. It is the only place a statement's date format, sign
// convention and column layout are interpreted, so node:test can pin every one of them.
//
// ★ THE SIGN CONVENTION IS THE ACCOUNT'S, NOT THE BANK'S. A stored amount is POSITIVE when
//   money comes INTO the account's favour and NEGATIVE when it goes out:
//     * bank account — a deposit is positive, a withdrawal negative;
//     * credit card  — a PAYMENT is positive (it reduces what is owed), a CHARGE negative.
//   Card issuers usually export charges as positive numbers, so the Credit Card preset
//   flips the sign. finance_categorize_bank_transaction() relies on this: a positive amount
//   debits the statement's account, a negative one credits it, for cash and card alike.
//
// ★ THE DATE FORMAT IS DECLARED BY A HUMAN, never guessed. 03/04/2026 is the 3rd of April
//   or the 4th of March, and nothing in the file says which. The legacy importer stored
//   the raw string and left that ambiguity in the ledger permanently.

/**
 * Column layouts for the statement exports this business receives. Indices are 0-based
 * positions in the header row. `flipSign` is true where the export shows money leaving the
 * account's favour as a positive number (card charges).
 */
export const BANK_STATEMENT_PRESETS = Object.freeze([
  Object.freeze({ key: 'BDO', label: 'BDO', date: 0, description: 1, amount: 2, flipSign: false, hint: 'Date, Description, Amount' }),
  Object.freeze({ key: 'BPI', label: 'BPI', date: 0, description: 1, amount: 2, flipSign: false, hint: 'Date, Description, Amount' }),
  Object.freeze({ key: 'Metrobank', label: 'Metrobank', date: 0, description: 1, amount: 3, flipSign: false, hint: 'Date, Description, Ref, Amount' }),
  Object.freeze({ key: 'UnionBank', label: 'UnionBank', date: 0, description: 2, amount: 3, flipSign: false, hint: 'Date, Ref, Description, Amount' }),
  Object.freeze({ key: 'SecurityBank', label: 'Security Bank', date: 0, description: 1, amount: 2, flipSign: false, hint: 'Date, Description, Amount' }),
  Object.freeze({ key: 'CreditCard', label: 'Credit card', date: 0, description: 1, amount: 2, flipSign: true, hint: 'Date, Description, Amount — charges shown as positive' }),
  Object.freeze({ key: 'Custom', label: 'Custom — pick the columns', date: null, description: null, amount: null, flipSign: false, hint: 'Choose each column yourself' }),
]);

/** "31/12/2026" + 'DMY' -> "2026-12-31". Null for anything that is not a real calendar date. */
export function statementDate(value, format) {
  const s = String(value ?? '').trim();
  let y; let m; let d;
  if (format === 'ISO') {
    const hit = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (!hit) return null;
    [, y, m, d] = hit;
  } else if (format === 'DMY' || format === 'MDY') {
    const hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!hit) return null;
    [d, m] = format === 'DMY' ? [hit[1], hit[2]] : [hit[2], hit[1]];
    y = hit[3].length === 2 ? `20${hit[3]}` : hit[3];
  } else {
    return null;
  }
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  // Rejects 2026-02-31 instead of rolling it into March.
  return Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * "(1,234.50)" -> -1234.5, "1,234.50 DR" -> -1234.5, "₱500 CR" -> 500. Null for blank,
 * unreadable or zero. The legacy parser stripped every non-digit, so "(1,234.00)" imported
 * as +1234 — a payment landing on the wrong side of the P&L.
 */
export function statementAmount(value) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  let negative;
  // A DR/CR marker, when present, decides the sign on its own — "(500) DR" is not a
  // double negative. Otherwise parentheses or a minus sign anywhere before the digits
  // ("-500", "₱-500", "500-") do.
  const suffix = /\s*(DR|CR)\.?$/i.exec(s);
  if (suffix) {
    negative = suffix[1].toUpperCase() === 'DR';
    s = s.slice(0, suffix.index).trim();
  } else {
    negative = /^\(.*\)$/.test(s) || /-$/.test(s) || /^[^\d]*-/.test(s);
  }
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits || (digits.match(/\./g) || []).length > 1) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

/** The column map a preset implies for a given header row. A Custom preset maps nothing. */
export function presetColumnMap(presetKey, headers) {
  const preset = BANK_STATEMENT_PRESETS.find((p) => p.key === presetKey);
  const h = Array.isArray(headers) ? headers : [];
  const at = (i) => (Number.isInteger(i) && i >= 0 && i < h.length ? h[i] : '');
  if (!preset || preset.key === 'Custom') {
    return { date: '', desc: '', amount: '', moneyIn: '', moneyOut: '', balance: '', mode: 'single', flipSign: false };
  }
  return {
    date: at(preset.date), desc: at(preset.description), amount: at(preset.amount),
    moneyIn: '', moneyOut: '', balance: '', mode: 'single', flipSign: preset.flipSign,
  };
}

/**
 * Rows the declared mapping can read, and the spreadsheet row numbers it cannot (header =
 * row 1, so data row i is row i + 2). Both are returned so the screen can say exactly which
 * rows will be left out BEFORE anything is staged.
 */
export function readStatementRows(rows, map, format) {
  const good = []; const bad = [];
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const posted = statementDate(r?.[map.date], format);
    let amt = null;
    if (map.mode === 'split') {
      const inAmt = statementAmount(r?.[map.moneyIn]);
      const outAmt = statementAmount(r?.[map.moneyOut]);
      if (inAmt !== null && outAmt === null) amt = Math.abs(inAmt);
      else if (outAmt !== null && inAmt === null) amt = -Math.abs(outAmt);
    } else {
      amt = statementAmount(r?.[map.amount]);
    }
    if (amt !== null && map.flipSign) amt = -amt;
    if (!posted || amt === null) { bad.push(i + 2); return; }
    good.push({
      posted_on: posted,
      description: String(r?.[map.desc] ?? '').trim(),
      amount: amt,
      balance_after: map.balance ? statementAmount(r?.[map.balance]) : null,
    });
  });
  return { good, bad };
}
