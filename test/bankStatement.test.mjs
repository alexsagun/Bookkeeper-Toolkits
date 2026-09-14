// test/bankStatement.test.mjs — the statement reader (#59). Pure; no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BANK_STATEMENT_PRESETS, statementDate, statementAmount, presetColumnMap, readStatementRows,
} from '../src/lib/bankStatement.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a declared date format is the only thing that decides day vs month', () => {
  assert.equal(statementDate('03/04/2026', 'DMY'), '2026-04-03');
  assert.equal(statementDate('03/04/2026', 'MDY'), '2026-03-04');
  assert.equal(statementDate('2026-04-03', 'ISO'), '2026-04-03');
  assert.equal(statementDate('3.4.26', 'DMY'), '2026-04-03');
  assert.equal(statementDate('03/04/2026', undefined), null, 'no declared format means no date — never a guess');
});

test('an impossible calendar date is refused, not rolled forward', () => {
  assert.equal(statementDate('31/02/2026', 'DMY'), null);
  assert.equal(statementDate('2026-13-01', 'ISO'), null);
  assert.equal(statementDate('', 'DMY'), null);
});

test('parentheses, minus signs and DR mean money out', () => {
  assert.equal(statementAmount('(1,234.50)'), -1234.5,
    'the legacy parser stripped every non-digit and imported this as +1234');
  assert.equal(statementAmount('-500'), -500);
  assert.equal(statementAmount('500-'), -500);
  assert.equal(statementAmount('₱-500.25'), -500.25);
  assert.equal(statementAmount('1,234.50 DR'), -1234.5);
  assert.equal(statementAmount('1,234.50 CR'), 1234.5);
  assert.equal(statementAmount('(500) DR'), -500, 'a DR marker is not a double negative');
  assert.equal(statementAmount('PHP 2,999.00'), 2999);
});

test('blank, zero and unreadable amounts are null, never 0', () => {
  for (const v of ['', '   ', '0', '0.00', 'n/a', '1.2.3', null, undefined]) {
    assert.equal(statementAmount(v), null, `${JSON.stringify(v)} must not become a zero transaction`);
  }
});

test('centavos are kept, rounded to two places', () => {
  assert.equal(statementAmount('20,750.50'), 20750.5);
  assert.equal(statementAmount('0.05'), 0.05, 'five centavos is a transaction, not a rounding error');
});

test('every legacy layout is present, and only the card preset flips the sign', () => {
  assert.deepEqual(BANK_STATEMENT_PRESETS.map((p) => p.key),
    ['BDO', 'BPI', 'Metrobank', 'UnionBank', 'SecurityBank', 'CreditCard', 'Custom']);
  assert.deepEqual(BANK_STATEMENT_PRESETS.filter((p) => p.flipSign).map((p) => p.key), ['CreditCard'],
    'a card PAYMENT is positive and a CHARGE negative; issuers export charges as positive');
});

test('a preset maps header positions, and Custom maps nothing', () => {
  const headers = ['Date', 'Ref', 'Description', 'Amount'];
  const ub = presetColumnMap('UnionBank', headers);
  assert.equal(ub.date, 'Date'); assert.equal(ub.desc, 'Description'); assert.equal(ub.amount, 'Amount');
  const custom = presetColumnMap('Custom', headers);
  assert.equal(custom.date, ''); assert.equal(custom.amount, '');
  const short = presetColumnMap('Metrobank', ['Date', 'Description']);
  assert.equal(short.amount, '', 'a column past the end of the header row maps to nothing, not undefined');
});

test('a card statement stores a charge as negative and a payment as positive', () => {
  const map = presetColumnMap('CreditCard', ['Date', 'Description', 'Amount']);
  const { good, bad } = readStatementRows([
    { Date: '05/09/2026', Description: 'SOFTWARE', Amount: '1,500.00' },
    { Date: '10/09/2026', Description: 'PAYMENT THANK YOU', Amount: '(1,500.00)' },
  ], map, 'DMY');
  assert.deepEqual(bad, []);
  assert.equal(good[0].amount, -1500, 'a charge increases what is owed');
  assert.equal(good[1].amount, 1500, 'a payment reduces what is owed');
});

test('split in/out columns are signed, and a row with both filled is refused', () => {
  const map = { date: 'D', desc: 'X', moneyIn: 'In', moneyOut: 'Out', balance: 'Bal', mode: 'split', flipSign: false };
  const { good, bad } = readStatementRows([
    { D: '2026-09-01', X: 'deposit', In: '2,000.00', Out: '', Bal: '12,000.00' },
    { D: '2026-09-02', X: 'withdrawal', In: '', Out: '500.00', Bal: '11,500.00' },
    { D: '2026-09-03', X: 'ambiguous', In: '10', Out: '10', Bal: '' },
    { D: 'not a date', X: 'bad', In: '10', Out: '', Bal: '' },
  ], map, 'ISO');
  assert.deepEqual(good.map((g) => g.amount), [2000, -500]);
  assert.equal(good[0].balance_after, 12000);
  assert.deepEqual(bad, [4, 5], 'spreadsheet row numbers, header = row 1');
});

// ★ ONE READER. The monolith used to carry its own copies of these parsers; a second copy
//   is how a fix to one reaches only half the screens.
test('the monolith does not re-implement the statement parsers', () => {
  const app = readFileSync(join(REPO, 'src/BookkeeperPro.jsx'), 'utf8');
  assert.ok(!/function financeStatementDate\(|function financeStatementAmount\(/.test(app),
    'financeStatementDate/financeStatementAmount are back in BookkeeperPro.jsx — use src/lib/bankStatement.js');
});
