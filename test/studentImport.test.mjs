// node:test suite for the pure student-import logic. Run: `node --test`
// Uses ONLY sanitized SYNTHETIC fixtures — never the real student CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS,
  isValidEmail, normalizeEmail, parseExternalId, parseStrictDate,
  sanitizeCsvCell, csvField, toCsv, parseCsv,
  parseEnrollmentsList, comboKeyOf, classifyCourse, suggestPlanForCombo,
  resolveMatchDecision, validateRowFields,
} from '../src/lib/studentImport.js';

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0); // 2026-07-22T12:00:00Z, fixed for determinism

// ── CSV parsing: quoted commas, BOM, CRLF, Unicode, doubled quotes ──────────────
test('parseCsv handles BOM, quoted commas, CRLF and Unicode', () => {
  const csv = '﻿First Name,Last Name,list\r\n'
    + 'José,"Dela Cruz, Jr.","A, B, C"\r\n'
    + 'Zoë,"O""Hara",D\r\n';
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['First Name', 'Last Name', 'list']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['First Name'], 'José');
  assert.equal(rows[0]['Last Name'], 'Dela Cruz, Jr.');       // embedded comma preserved
  assert.equal(rows[0]['list'], 'A, B, C');
  assert.equal(rows[1]['Last Name'], 'O"Hara');                // doubled quote unescaped
  assert.equal(rows[1]['First Name'], 'Zoë');
});

test('parseCsv tolerates a trailing newline and empty input', () => {
  assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
  const { rows } = parseCsv('a,b\n1,2\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { a: '1', b: '2' });
});

// ── Email ───────────────────────────────────────────────────────────────────────
test('email normalization + validation', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.equal(normalizeEmail(null), '');
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail('  '), false);
});

// ── External id: leading zeros preserved (string) ───────────────────────────────
test('parseExternalId keeps leading zeros and stays a string', () => {
  assert.equal(parseExternalId('007'), '007');
  assert.equal(parseExternalId(236365005), '236365005');
  assert.equal(parseExternalId('  42 '), '42');
  assert.equal(parseExternalId(''), '');
});

// ── Strict date parsing ─────────────────────────────────────────────────────────
test('parseStrictDate accepts unambiguous UTC forms only', () => {
  const iso = parseStrictDate('2026-07-20T01:52:00Z');
  assert.equal(iso.valid, true);
  assert.equal(iso.epochMs, Date.UTC(2026, 6, 20, 1, 52, 0));
  assert.match(iso.display, /UTC/);

  const think = parseStrictDate('2026-07-20 01:52:00 UTC');
  assert.equal(think.valid, true);
  assert.equal(think.epochMs, Date.UTC(2026, 6, 20, 1, 52, 0));

  const dateOnly = parseStrictDate('2026-07-20');
  assert.equal(dateOnly.valid, true);
  assert.equal(dateOnly.epochMs, Date.UTC(2026, 6, 20, 0, 0, 0));
});

test('parseStrictDate rejects ambiguous / malformed / out-of-range', () => {
  assert.equal(parseStrictDate('07/20/2026').valid, false); // locale-ambiguous → rejected
  assert.equal(parseStrictDate('July 20, 2026').valid, false);
  assert.equal(parseStrictDate('not a date').valid, false);
  assert.equal(parseStrictDate('').valid, false);
  assert.equal(parseStrictDate(null).valid, false);
  assert.equal(parseStrictDate('0202-01-01').valid, false);  // out of range
});

// ── CSV formula-injection-safe output ───────────────────────────────────────────
test('sanitizeCsvCell neutralizes formula-trigger prefixes', () => {
  assert.equal(sanitizeCsvCell('=1+1'), "'=1+1");
  assert.equal(sanitizeCsvCell('+cmd'), "'+cmd");
  assert.equal(sanitizeCsvCell('-2'), "'-2");
  assert.equal(sanitizeCsvCell('@SUM'), "'@SUM");
  assert.equal(sanitizeCsvCell('\tTAB'), "'\tTAB");
  assert.equal(sanitizeCsvCell('safe'), 'safe');
  assert.equal(sanitizeCsvCell(null), '');
  // A number TYPE passes untouched (it cannot be a formula); the same text as a STRING is still guarded.
  assert.equal(sanitizeCsvCell(-1200.5), '-1200.5');
  assert.equal(sanitizeCsvCell(Number.NaN), "NaN");
  assert.equal(sanitizeCsvCell('-1200.5'), "'-1200.5");
});

test('toCsv quotes + sanitizes', () => {
  const csv = toCsv([{ name: '=HYPERLINK("x")', note: 'a, b' }], ['name', 'note']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'name,note');
  assert.match(lines[1], /^"'=HYPERLINK/);      // formula neutralized AND quoted
  assert.match(lines[1], /"a, b"$/);            // comma-bearing field quoted
});

// ── Course combos + plan SUGGESTION ─────────────────────────────────────────────
test('parseEnrollmentsList + comboKeyOf is order-independent + deduped', () => {
  const a = parseEnrollmentsList('Resume and Interview Mastery, QuickBooks Online Mastery - Jan 2026');
  assert.equal(a.length, 2);
  const k1 = comboKeyOf(['B', 'A', 'A']);
  const k2 = comboKeyOf(['A', 'B']);
  assert.equal(k1, k2);
  assert.equal(k1, 'A | B');
  assert.deepEqual(parseEnrollmentsList(''), []);
});

test('suggestPlanForCombo only ever suggests silver — never sampler or vip', () => {
  assert.equal(classifyCourse('QuickBooks Online Mastery - Jan 2026'), 'qbo');
  assert.equal(classifyCourse('Resume and Interview Mastery'), 'resume');

  // #39: QBO-only history used to suggest core_self_paced. That plan is gone, and
  // every remaining plan grants MORE than it did, so this must go to manual review
  // rather than silently upselling an imported student.
  const qboOnly = suggestPlanForCombo(['QuickBooks Online Mastery - Jan 2026']);
  assert.equal(qboOnly.suggested, null);
  assert.match(qboOnly.reason, /manually|review/i);

  const combo = suggestPlanForCombo(['QuickBooks Online Mastery - Jan 2026', 'Resume and Interview Mastery']);
  assert.equal(combo.suggested, 'silver_self_paced');

  const unknown = suggestPlanForCombo(['Onboarding QuickBooks Mentors']);
  // 'onboarding' alone is not QBO-course history → no confident suggestion
  assert.equal(unknown.suggested, null);

  // Nothing ever auto-suggests the coaching tiers or a retired plan.
  for (const s of [qboOnly, combo, unknown]) {
    assert.ok(!['sampler', 'vip', 'core_self_paced', 'gold_live'].includes(s.suggested));
  }
});

// ── Matching (never by name) ────────────────────────────────────────────────────
test('resolveMatchDecision covers every branch', () => {
  // existing source link → merge
  assert.deepEqual(
    resolveMatchDecision({ hasEmail: true, emailValid: true }, { bySource: 'u1' }),
    { match_result: 'existing_by_source', target_user_id: 'u1', intended_action: 'merge_grant', blocked: false, reason: 'Matched an existing Thinkific source link.' }
  );
  // email match → merge
  assert.equal(resolveMatchDecision({ hasEmail: true, emailValid: true }, { byEmail: 'u2' }).intended_action, 'merge_grant');
  // source + email → DIFFERENT users → conflict, blocked
  const conflict = resolveMatchDecision({ hasEmail: true, emailValid: true }, { bySource: 'u1', byEmail: 'u2' });
  assert.equal(conflict.match_result, 'conflict');
  assert.equal(conflict.blocked, true);
  // ambiguous email
  assert.equal(resolveMatchDecision({ hasEmail: true, emailValid: true }, { byEmailAmbiguous: true }).blocked, true);
  // new + valid email → invite
  assert.equal(resolveMatchDecision({ hasEmail: true, emailValid: true }, {}).intended_action, 'create_invite');
  // new + missing email → BLOCKED
  const noEmail = resolveMatchDecision({ hasEmail: false, emailValid: false }, {});
  assert.equal(noEmail.match_result, 'new');
  assert.equal(noEmail.blocked, true);
  // new + invalid email → BLOCKED
  assert.equal(resolveMatchDecision({ hasEmail: true, emailValid: false }, {}).blocked, true);
});

// ── Membership terms ─────────────────────────────────────────────────────────────
// computeImportTerm (fresh / lifetime / preserve / overwrite) was the v1 grant path and was
// removed by #67: a legacy term now comes ONLY from the roster's own dates, computed in SQL by
// legacy_import_term() and mirrored by manilaTerm() — see test/legacyMigration.test.mjs.

test('validateRowFields flags missing email, invalid email, reversed dates', () => {
  assert.equal(validateRowFields({ hasEmail: false, hasExternalId: true }).errors.length, 1);
  assert.ok(validateRowFields({ hasEmail: true, emailRaw: 'bad', hasExternalId: true }).errors.some((e) => /invalid/i.test(e)));
  const rev = validateRowFields({ hasEmail: true, emailRaw: 'a@b.co', hasExternalId: true, startedAt: NOW + DAY_MS, endsAt: NOW });
  assert.ok(rev.errors.some((e) => /after the end/i.test(e)));
  assert.ok(validateRowFields({ hasEmail: true, emailRaw: 'a@b.co', hasExternalId: false }).warnings.length >= 1);
});

// ── ACCEPTANCE TEST: a 358-row Thinkific-user-style file blocks ALL new accounts ──
// Synthetic mimic of the real export shape: unique ids, blank emails, mixed course
// history (incl. 5 zero-enrollment rows). Must stage 358 rows, 0 ready, 358 blocked.
function buildSyntheticThinkificExport(n) {
  const header = 'First Name,Last Name,ID,Amount spent,Date created,Email,Enrollments,Enrollments - list,Scheduled enrollments,Last sign in,Sign in count';
  const rows = [];
  for (let i = 0; i < n; i++) {
    const id = 236000000 + i;
    const zeroEnroll = i < 5; // first 5 have no enrollments
    const list = zeroEnroll ? '' : '"Resume and Interview Mastery, QuickBooks Online Mastery - Jan 2026"';
    const enrollCount = zeroEnroll ? 0 : 2;
    // Email column is intentionally BLANK on every row (mirrors the real export).
    rows.push(`First${i},Last${i},${id},0,2026-01-01 00:00:00 UTC,,${enrollCount},${list},,2026-07-01 00:00:00 UTC,3`);
  }
  return `${header}\n${rows.join('\n')}`;
}

test('ACCEPTANCE: 358-row user export → 358 staged, 0 ready, 358 blocked (missing email)', () => {
  const csv = buildSyntheticThinkificExport(358);
  const { rows } = parseCsv(csv);
  assert.equal(rows.length, 358);

  let ready = 0;
  let blocked = 0;
  for (const r of rows) {
    const emailNorm = normalizeEmail(r['Email']);
    const hasEmail = emailNorm.length > 0;
    // No supplementary data yet → no source/email matches exist for anyone.
    const decision = resolveMatchDecision({ hasEmail, emailValid: hasEmail }, {});
    if (decision.blocked) blocked++;
    else ready++;
  }
  assert.equal(blocked, 358);
  assert.equal(ready, 0);
});

// ── The template (#32) ─────────────────────────────────────────────────────────
// The v1 proposeForRow resolver was removed by #67; batch resolution is now an explicit
// label→code mapping checked against the registry (test/legacyMigration.test.mjs).
import { IMPORT_TEMPLATE_COLUMNS } from '../src/lib/studentImport.js';

test('IMPORT_TEMPLATE_COLUMNS carries batch_code as the 12th column', () => {
  assert.equal(IMPORT_TEMPLATE_COLUMNS.length, 12);
  assert.equal(IMPORT_TEMPLATE_COLUMNS[11], 'batch_code');
  assert.equal(IMPORT_TEMPLATE_COLUMNS[0], 'thinkific_user_id');
});

test('suggestPlanForCombo never suggests sampler, vip, or a retired plan (re-pin for #39)', () => {
  const combos = [
    ['QuickBooks Online Mastery'],
    ['QuickBooks Online Mastery', 'Resume Winning Strategy'],
    ['QuickBooks Online Mastery', 'Resume Winning Strategy', 'Interview Strategy', 'US Tax'],
    [],
  ];
  for (const c of combos) {
    const { suggested } = suggestPlanForCombo(c);
    assert.ok(!['sampler', 'vip', 'core_self_paced', 'gold_live'].includes(suggested),
      `suggestPlanForCombo must never suggest a premium/sampler/retired plan (got ${suggested})`);
    assert.ok(suggested === null || suggested === 'silver_self_paced');
  }
});
