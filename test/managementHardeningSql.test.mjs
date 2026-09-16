// test/managementHardeningSql.test.mjs — Management hardening (#63): the three SQL findings of
// the final #58–#62 security review, pinned in the dated file AND the §50 fold, plus the two JS
// halves that must move with them. Reads files as TEXT and the pure client mirrors; no database
// and no network.
//
// ★ EVERY FUNCTION IN #63 IS A COPY OF THE BODY THAT IS ALREADY APPLIED, with one edit made to
//   it. That is the #33/#34 rule: #59 added the feed-link refusals to four reconciliation
//   functions, and a #63 that retyped them from #58's text would silently delete those. The pins
//   below therefore assert that #59's and #58's own invariants are STILL PRESENT alongside the
//   new join — a pin on the new behaviour alone would pass on a body that had lost the old.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import { MAX_INTAKE_AMOUNT, validateIntake, blankIntake } from '../src/lib/enrollmentIntake.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-18-management-hardening.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';

/** Executable SQL only — comments explain invariants and must neither satisfy nor fail a scan. */
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
/** Executable JS only, for the same reason. */
const jsCode = (src) => src.split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')
    && !l.trimStart().startsWith('/*')).join('\n');

/** The §50 fold, bounded at the next banner (never to EOF — that is how §30 was lost). */
function foldSection() {
  const boot = read(BOOTSTRAP);
  const at = boot.indexOf('§50) FOLDED VERBATIM');
  assert.ok(at > 0, '§50 is missing from the bootstrap — re-fold db/2026-09-18-management-hardening.sql');
  const next = boot.indexOf('FOLDED VERBATIM', at + 30);
  return boot.slice(at, next > 0 ? next : undefined);
}

function bodyOf(sql, name) {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(at > 0, `${name} is not restated`);
  const end = sql.indexOf('$fn$;', at);
  return sql.slice(at, end < 0 ? undefined : end);
}

/** An INNER join, anchored at the start of its line so "left join …" can never count as one. */
const COMMITTED_JOIN = /^\s*join public\.finance_bank_imports bi on bi\.id = t\.import_id and bi\.status = 'committed'\s*$/gm;
const count = (s, re) => (s.match(re) || []).length;

const SOURCES = [['dated file', () => read(MIGRATION)], ['bootstrap §50', foldSection]];

for (const [label, sqlOf] of SOURCES) {
  // ── 1) The approval guard ──────────────────────────────────────────────────
  test(`${label}: the approval exemption belongs to the extension path, not to the member`, () => {
    const g = codeOf(bodyOf(sqlOf(), 'enrollment_approval_requires_grant'));
    // The no-expiry subscription test may only be reached through request_kind — and the POLARITY
    // matters: without the "not" the guard refuses only the one legitimate case and admits the rest.
    assert.match(g, /and not \(new\.request_kind = 'extension'\s*\n\s*and exists \(select 1 from public\.subscriptions s\s*\n\s*where s\.user_id = new\.user_id and s\.status = 'active' and s\.ends_at is null\)\) then/,
      'the grandfathered-term exemption is not "and not (extension and holds a no-expiry term)"');
    assert.ok(!/and not exists \(select 1 from public\.subscriptions s\s*\n\s*where s\.user_id = new\.user_id/.test(g),
      'the unconditional member-wide exemption is still there');
    // What #60 already had, and must keep — anchored, so an inverted break-glass fails too.
    assert.match(g, /if not public\.is_super_admin\(\)\s*\n\s*and not exists \(select 1 from public\.subscriptions s where s\.request_id = new\.id\)/,
      'the Super Admin break-glass or the request-carrying-grant test changed');
    assert.ok(g.includes("'ENROLLMENT_APPROVE_VIA_RPC'"), 'the refusal code changed');
  });

  // ── 2) A reconciliation counts only committed statement lines ──────────────
  test(`${label}: every reconciliation site reads only transactions of a COMMITTED import`, () => {
    const s = sqlOf();
    // detail: cleared, feed_cleared, open_transactions. close: v_open, v_cleared. list: unmatched.
    for (const [fn, n] of [['finance_reconciliation_detail', 3], ['finance_close_reconciliation', 2],
      ['finance_reconciliations_list', 1]]) {
      const body = codeOf(bodyOf(s, fn));
      assert.equal(count(body, COMMITTED_JOIN), n,
        `${fn} does not join the committed imports at all ${n} of its transaction reads`);
      // An OUTER join with the status in its ON clause keeps every staged row — the defect itself.
      assert.ok(!/(left|right|full)\s+(outer\s+)?join public\.finance_bank_imports/.test(body),
        `${fn} reaches the imports through an outer join, which filters nothing`);
    }
  });

  test(`${label}: matching refuses a line whose import is not committed, and #59's refusals survive`, () => {
    const m = codeOf(bodyOf(sqlOf(), 'finance_match_reconciliation_item'));
    assert.ok(m.includes("'FINANCE_BANK_IMPORT_STATE'"), 'an uncommitted import is not refused');
    // The CONDITION, not just the code: "not exists … committed" for this very line.
    assert.match(m, /if not exists \(select 1 from public\.finance_bank_transactions t\s*\n\s*join public\.finance_bank_imports bi on bi\.id = t\.import_id\s*\n\s*where t\.id = p_bank_transaction_id and bi\.status = 'committed'\) then\s*\n\s*perform public\.app_error\('FINANCE_BANK_IMPORT_STATE'/,
      'the refusal does not fire exactly when the line\'s own import is not committed');
    const refusal = m.indexOf("'FINANCE_BANK_IMPORT_STATE'");
    const insert = m.indexOf('insert into public.finance_reconciliation_items');
    assert.ok(insert > 0 && refusal < insert, 'the refusal must come before anything is written');
    // #59's own invariants, which a body retyped from #58 would have lost.
    assert.ok(m.includes("'FINANCE_BANK_TXN_LINKED'"), '#59 feed-link refusal lost');
    assert.ok(/for update/.test(m), '#59 row lock lost');
    assert.ok(m.indexOf("has_staff_permission('finance.manage')") < refusal,
      'the permission check is no longer the first thing this function does');
  });

  test(`${label}: the commit pass cannot re-flag a transaction that is no longer unmatched`, () => {
    const c = codeOf(bodyOf(sqlOf(), 'finance_commit_bank_import'));
    assert.equal(count(c, /where t\.import_id = p_import_id and t\.status = 'unmatched'\s*\n\s*\)/g), 2,
      'both the exact-duplicate and the likely-duplicate pass must be scoped to unmatched rows');
    assert.ok(!/where t\.import_id = p_import_id\s*\n\s*\)/.test(c),
      'an unscoped duplicate CTE is still there');
  });

  test(`${label}: commit and discard are serialized on the import row`, () => {
    for (const fn of ['finance_commit_bank_import', 'finance_discard_bank_import']) {
      const b = codeOf(bodyOf(sqlOf(), fn));
      const lock = b.search(/from public\.finance_bank_imports where id = p_import_id for update;/);
      const check = b.indexOf("'FINANCE_BANK_IMPORT_STATE'");
      assert.ok(lock > 0 && lock < check, `${fn} must lock the import row before it tests its status`);
      assert.ok(b.indexOf("has_staff_permission('finance.manage')") < lock, `${fn}: the permission check comes first`);
    }
    // Discard keeps #58's RESTRICT refusal, restated from the applied body.
    const d = codeOf(bodyOf(sqlOf(), 'finance_discard_bank_import'));
    assert.match(d, /Unmatch them\s*'\s*\n\s*'before discarding the import\./, "discard lost #58's matched-line refusal");
    assert.ok(/revoke all on function public\.finance_discard_bank_import\(uuid, text\) from public, anon, authenticated;\s*\n\s*grant execute on function public\.finance_discard_bank_import\(uuid, text\) to authenticated;/.test(sqlOf()),
      'discard is not revoked and re-granted exactly as #58 did');
  });

  test(`${label}: a commit cannot drop unreviewed lines into a closed reconciliation`, () => {
    const c = codeOf(bodyOf(sqlOf(), 'finance_commit_bank_import'));
    assert.match(c, /if exists \(select 1\s*\n\s*from public\.finance_bank_transactions t\s*\n\s*join public\.finance_reconciliations r\s*\n\s*on r\.account_id = t\.account_id and r\.status = 'closed'\s*\n\s*and t\.posted_on between r\.period_start and r\.period_end\s*\n\s*where t\.import_id = p_import_id and t\.status = 'unmatched'\) then\s*\n\s*perform public\.app_error\('FINANCE_RECONCILIATION_CLOSED'/,
      'commit does not refuse an unmatched line inside a closed reconciliation');
    assert.ok(c.indexOf("'FINANCE_RECONCILIATION_CLOSED'") > c.indexOf('with near as')
      && c.indexOf("'FINANCE_RECONCILIATION_CLOSED'") < c.indexOf("set status = 'committed'"),
      'the refusal must follow both duplicate passes (a set-aside duplicate needs no review) and precede the commit');
  });

  test(`${label}: a likely duplicate never points at a line of another file that is still staged`, () => {
    const c = codeOf(bodyOf(sqlOf(), 'finance_commit_bank_import'));
    const near = c.slice(c.indexOf('with near as'), c.indexOf("set duplicate_kind = 'likely'"));
    assert.match(near, /join public\.finance_bank_imports oi on oi\.id = other\.import_id\s*\n\s*and \(oi\.status = 'committed' or other\.import_id = t\.import_id\)/,
      'the likely-duplicate pass can flag against a staged file that may be discarded');
  });

  // ── 3) A collection may only post an amount the books can hold ─────────────
  test(`${label}: enrollment amounts are bounded NOT VALID, then validated tolerantly — never skipped`, () => {
    const s = codeOf(sqlOf());
    const ceiling = String(MAX_INTAKE_AMOUNT);
    // The add is unconditional on the data: NOT VALID binds every future write even if a legacy row fails.
    assert.match(s, new RegExp(`if not exists \\(select 1 from pg_constraint where conname = 'enrollment_requests_amounts_bounded'\\) then\\s*\\n\\s*alter table public\\.enrollment_requests\\s*\\n\\s*add constraint enrollment_requests_amounts_bounded\\s*\\n\\s*check \\(amount_paid <= ${ceiling} and amount_expected <= ${ceiling}\\) not valid;\\s*\\n\\s*end if;`),
      'the bound is not added NOT VALID, on both columns, at MAX_INTAKE_AMOUNT');
    // Only the VALIDATION tolerates a legacy row, and it says so.
    assert.match(s, /if exists \(select 1 from pg_constraint where conname = 'enrollment_requests_amounts_bounded' and not convalidated\) then\s*\n\s*begin\s*\n\s*alter table public\.enrollment_requests validate constraint enrollment_requests_amounts_bounded;\s*\n\s*exception when check_violation then\s*\n\s*raise notice/,
      'the validation is not a tolerant sub-block that reports a legacy row');
    assert.ok(!/add constraint enrollment_requests_amounts_bounded\s*\n\s*check \([^)]*\);/.test(s),
      'a VALID add would be skipped whole by a single legacy row — the #30 idiom this file replaces');
  });

  test(`${label}: the approval hook names its refusal instead of overflowing, and rounds to centavos`, () => {
    const t = codeOf(bodyOf(sqlOf(), 'finance_enrollment_collection_trg'));
    assert.match(t, new RegExp(`if new\\.amount_paid > ${MAX_INTAKE_AMOUNT} then`), 'the hook does not bound the amount at MAX_INTAKE_AMOUNT');
    // The comped test reads what the lines will hold: ₱0.004 must be comped, not post two 0.00 lines.
    assert.match(t, /if round\(coalesce\(new\.amount_paid, 0\), 2\) <= 0 then\s*\n\s*return null;/,
      'the comped-approval test reads the unrounded amount');
    assert.ok(t.includes("'FINANCE_COLLECTION_AMOUNT_INVALID'"), 'the refusal is unnamed');
    assert.ok(t.indexOf('if new.amount_paid > 1000000') < t.indexOf('insert into public.finance_journal_entries'),
      'the bound must be checked before anything is posted');
    // Every amount that reaches the books, the payment event or the audit row is rounded.
    assert.equal(count(t, /round\(new\.amount_paid, 2\)/g), 4,
      'the two journal lines, the payment event and the audit row must all round');
    assert.ok(!/[^(]new\.amount_paid\b(?!, 2\))/.test(t.replace(/round\(new\.amount_paid, 2\)/g, '')
      .replace(/round\(coalesce\(new\.amount_paid, 0\), 2\) <= 0/, '').replace(/if new\.amount_paid > 1000000 then/, '')),
      'an unrounded amount_paid still reaches a write');
    // What #58 had, and must keep.
    assert.ok(t.includes("'enrollment:' || new.id::text || ':collection'"), 'the idempotency key changed');
    assert.ok(!t.includes('has_staff_permission'),
      'a permission check here would refuse every Operations Admin approval (#58)');
  });

  test(`${label}: the backfill SKIPS an out-of-range legacy row rather than dying on it`, () => {
    const b = codeOf(bodyOf(sqlOf(), 'finance_backfill_enrollment_collections'));
    // Anchored at the line end, so a larger ceiling (1000000000000) cannot satisfy it.
    assert.match(b, new RegExp(`\\n\\s*and er\\.amount_paid <= ${MAX_INTAKE_AMOUNT}\\s*\\n`),
      'one bad legacy row would abort the whole backfill (or the ceiling is not MAX_INTAKE_AMOUNT)');
    assert.match(b, /where er\.status = 'approved' and round\(coalesce\(er\.amount_paid, 0\), 2\) > 0/,
      'the backfill filter reads the unrounded amount, so ₱0.004 would abort the run');
    assert.ok(!/app_error\('FINANCE_COLLECTION_AMOUNT_INVALID'/.test(b),
      'the backfill must not raise on an out-of-range row — it is a batch over history');
    assert.equal(count(b, /round\(r\.amount_paid, 2\)/g), 3,
      'the two journal lines and the payment event must all round');
  });

  // ── 4) Lockstep ────────────────────────────────────────────────────────────
  test(`${label}: the catalog is restated whole and gains exactly the one new code`, () => {
    const s = sqlOf();
    const at = s.indexOf('create or replace function public.app_error_catalog()');
    assert.ok(at > 0, 'app_error_catalog() is not restated');
    const catalog = s.slice(at, s.indexOf('$cat$;', at));
    assert.equal((catalog.match(/^ {4}\('[A-Z0-9_]+',/gm) || []).length, 112,
      'the catalog is not 112 codes');
    for (const code of APP_ERROR_CODES) {
      if (code === 'MIGRATION_MISSING') continue;   // client-synthesised, never raised by SQL
      assert.ok(catalog.includes(`('${code}'`), `${code} fell out of the restated catalog`);
    }
  });

  test(`${label}: #63 changes no permission — it only re-signs functions`, () => {
    const s = codeOf(sqlOf());
    assert.ok(!/insert into public\.staff_permissions/.test(s), '#63 must not restate the permission seed');
    assert.ok(!/insert into public\.staff_role_permissions/.test(s), '#63 must not restate the grant seed');
    assert.ok(!/create policy/.test(s), '#63 adds no policy');
    assert.ok(!/grant execute on function/.test(s) || /revoke all on function/.test(s),
      'a re-granted function must be revoked first');
  });
}

test('the dated file refuses to run before #62, and expects the matrix it does not change', () => {
  const s = read(MIGRATION);
  const at = s.indexOf('do $pre$');
  assert.ok(at > 0, 'no preflight');
  const pre = s.slice(at, s.indexOf('$pre$;', at));
  assert.ok(pre.includes('2026-09-17-meetings-tasks.sql'),
    'the preflight must require #62 — #63 restates the catalog #62 owns');
  assert.match(pre, /count\(\*\) from public\.staff_permissions\) <> 22/,
    'the preflight must assert the 22-permission matrix it leaves alone');
  assert.ok(s.includes("insert into public.schema_migrations (filename, checksum, notes) values\n ('2026-09-18-management-hardening.sql'"),
    'the migration does not log itself');
});

// ── The three-place rule, and the client halves ──────────────────────────────
test('FINANCE_COLLECTION_AMOUNT_INVALID exists in all three places', () => {
  assert.ok(APP_ERROR_CODES.includes('FINANCE_COLLECTION_AMOUNT_INVALID'));
  assert.ok(APP_ERROR_COPY.FINANCE_COLLECTION_AMOUNT_INVALID, 'no user-facing copy');
  assert.match(APP_ERROR_COPY.FINANCE_COLLECTION_AMOUNT_INVALID, /Correct amount/,
    'the copy must name the action that fixes it');
});

test('the client refuses an amount the ledger could not post, at the same ceiling as the SQL', () => {
  assert.equal(MAX_INTAKE_AMOUNT, 1000000, 'the client ceiling drifted from the CHECK and the hook');
  const base = { ...blankIntake(), amountPaid: '16999' };
  const ctx = { hasReceipt: true, needsBatch: false, requireAgreement: false };
  assert.ok(!validateIntake(base, ctx).errors.amountPaid, 'a real price must pass');
  // A pasted phone number: parseAmountPaid keeps the digits, so this reads as ₱9,171,234,567.
  const phone = validateIntake({ ...base, amountPaid: '09171234567' }, ctx);
  assert.ok(phone.errors.amountPaid, 'a pasted phone number is still accepted as pesos');
  assert.ok(!validateIntake({ ...base, amountPaid: String(MAX_INTAKE_AMOUNT) }, ctx).errors.amountPaid,
    'the ceiling itself must be allowed');
  assert.ok(validateIntake({ ...base, amountPaid: String(MAX_INTAKE_AMOUNT + 1) }, ctx).errors.amountPaid,
    'one peso over the ceiling must be refused');
});

test('Extend Access enforces the same ceiling as the intake form, and the monolith imports it', () => {
  const raw = read('src/BookkeeperPro.jsx');
  const src = jsCode(raw);
  const at = src.indexOf('function ExtendAccessModal(');
  assert.ok(at > 0, 'ExtendAccessModal moved');
  const body = src.slice(at, at + 12000);
  assert.ok(body.includes('amt > MAX_INTAKE_AMOUNT'),
    'the extension path writes the same student-typed amount_paid and must bound it too');
  assert.ok(!/amt > 1000000/.test(body), 'the ceiling must be the shared constant, never a literal');
  // Vite builds an undeclared name as a global, so a dropped import passes the build and throws a
  // ReferenceError on submit — before setBusy, so the button silently does nothing.
  assert.match(raw, /import \{[^}]*\bMAX_INTAKE_AMOUNT\b[^}]*\} from '\.\/lib\/enrollmentIntake';/,
    'BookkeeperPro.jsx uses MAX_INTAKE_AMOUNT without importing it');
});

test('a provider rejection is recorded as a code, never as the provider sentence', () => {
  const src = jsCode(read('api/notify-enrollment.js'));
  // notify_detail is stored on the student's OWN request row, which they can read.
  assert.ok(!/recordNotify\([^)]*out\.detail/.test(src),
    'the provider body reaches a row the student can read');
  assert.match(src, /recordNotify\(requestId, u\.token, 'provider_error', `resend_\$\{out\.status\}`\)/,
    'the stable code is not what gets recorded');
  assert.ok(!/console\.error\(`\[notify-enrollment\] resend \$\{r\.status\}: \$\{text/.test(src),
    'the provider body is still logged');
  // The admin-gated diagnostic keeps the detail — that is what it is for.
  assert.ok(/detail: out\.detail/.test(src), "the 'test' action must still surface the detail");
});

test('an invitation refusal is not reported as an uncertainty, and an uncertainty says nothing false', () => {
  const src = jsCode(read('api/admin/meetings.js'));
  assert.ok(!/uncertain: true/.test(src),
    'a definite 4xx refusal must not claim the invitations may have been queued');
  assert.match(src, /const uncertain = !\(e instanceof HttpError\) \|\| e\.status === 502;/,
    'only callerRpc\'s 502 (timeout, network fault, 5xx) may have committed');
  // The banner prints "It is not certain whether the invitations were queued: <error>" — so the
  // uncertain error must be neutral, never "could not be queued" or callerRpc's "Try again."
  assert.match(src, /error: uncertain \? 'The database did not confirm the invitations in time\.' : e\.message,/,
    'an uncertain outcome quotes a sentence that contradicts it');
});

test('the schedule banner turns amber whenever the invitations need attention', () => {
  const src = read('src/BookkeeperPro.jsx');
  const at = src.indexOf('Scheduled in Zoom —');
  assert.ok(at > 0, 'the schedule result banner moved');
  const around = src.slice(at - 600, at + 1800);
  assert.match(around, /kind=\{meetingInviteNeedsAttention\(inv\) \? 'warn' : 'ok'\}/,
    'a green banner carrying a failure reads as a success');
  // The two sentences in the right order: uncertain → "not certain"; refused → "No invitations were queued".
  assert.match(around, /\{inv\?\.error && \(inv\.uncertain\s*\n\s*\? ` It is not certain whether the invitations were queued[\s\S]*?\n\s*: ` No invitations were queued/,
    'the uncertain and refused sentences are swapped or missing');
  // The classification is the Invite panel's own heading, so the two surfaces cannot disagree.
  const fnAt = src.indexOf('function meetingInviteNeedsAttention(');
  assert.ok(fnAt > 0, 'meetingInviteNeedsAttention is gone');
  const fn = src.slice(fnAt, src.indexOf('\n}\n', fnAt));
  assert.match(fn, /if \(invite\.error \|\| invite\.send_error\) return true;/, 'a refusal or a send error must warn');
  assert.match(fn, /return !\['Sent', 'Finished'\]\.includes\(commDoneHeading\(invite\)\);/,
    'anything but a clean "Sent"/"Finished" heading must warn (failed, cut off, not configured, waiting)');
});

test('a 5xx with no sentence is not reported as "the meeting was not scheduled"', () => {
  const src = read('src/BookkeeperPro.jsx');
  const at = src.indexOf('No clear answer came back, so it is not certain whether Zoom created the meeting');
  assert.ok(at > 0, 'the uncertain-schedule copy is gone');
  const around = src.slice(at - 900, at + 400);
  assert.match(around, /!e\?\.status \|\| \(e\.status >= 500 && !String\(e\?\.message \|\| ''\)\.trim\(\)\)/,
    'a gateway 502/504 still claims the meeting was not scheduled');
  assert.match(around, /Zoom does not recognise a repeated request/,
    'the recovery advice must stay: pressing Schedule again creates a second meeting');
});

test('an unclear invite answer freezes who is invited, so a retry reuses its request key', () => {
  const src = read('src/BookkeeperPro.jsx');
  const at = src.indexOf('function MeetingInvitePanel(');
  assert.ok(at > 0, 'MeetingInvitePanel moved');
  const panel = src.slice(at, src.indexOf('\nfunction MeetingTemplateEditor(', at));
  // The key is replaced whenever the audience changes — the freeze is what keeps it.
  assert.match(panel, /useEffect\(\(\) => \{ keyRef\.current = null; setPreview\(null\); \}, \[audienceKey\]\);/,
    'the request key no longer follows the audience (update this pin together with the freeze)');
  assert.match(panel, /const noAnswer = !e\?\.status \|\| \(e\.status >= 500 && !String\(e\?\.message \|\| ''\)\.trim\(\)\);/,
    'a gateway 5xx with no sentence is not treated as unclear');
  const branch = panel.slice(panel.indexOf('if (noAnswer) {'), panel.indexOf('} else {', panel.indexOf('if (noAnswer) {')));
  assert.ok(branch.includes('setUnclear(true)'), 'an unclear answer does not freeze the audience');
  assert.ok(branch.includes('onDone?.()'), 'an unclear answer does not refresh the calendar count');
  assert.match(branch, /without changing who is invited/, 'the admin is not told to keep the audience as it is');
  assert.match(panel, /<MeetingAudienceFields value=\{aud\} onChange=\{setAud\} disabled=\{step !== 'edit' \|\| unclear\}/,
    'the audience fields stay editable after an unclear answer');
  const ok = panel.slice(panel.indexOf("action: 'invite'"), panel.indexOf('} catch (e) {', panel.indexOf("action: 'invite'")));
  assert.ok(ok.includes('setUnclear(false)'), 'only a success may release the freeze');
});
