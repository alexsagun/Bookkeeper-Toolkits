// node:test suite for the pure student-import logic. Run: `node --test`
// Uses ONLY sanitized SYNTHETIC fixtures — never the real student CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRACE_DAYS, DAY_MS,
  isValidEmail, normalizeEmail, parseExternalId, parseStrictDate,
  sanitizeCsvCell, csvField, toCsv, parseCsv,
  parseEnrollmentsList, comboKeyOf, classifyCourse, suggestPlanForCombo,
  resolveMatchDecision, computeImportTerm, validateRowFields, decideOnboardingStep,
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

// ── Membership term computation ─────────────────────────────────────────────────
test('preserve: active term keeps exact expiry + 3-day grace', () => {
  const endsAt = NOW + 30 * DAY_MS;
  const t = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, endsAt, mode: 'preserve', now: NOW });
  assert.equal(t.action, 'grant');
  assert.equal(t.status, 'active');
  assert.equal(t.ends_at, endsAt);
  assert.equal(t.grace_ends_at, endsAt + GRACE_DAYS * DAY_MS);
  assert.equal(t.started_at, endsAt - 60 * DAY_MS);
});

test('preserve: past expiry → status expired (renewal screen)', () => {
  const endsAt = NOW - 10 * DAY_MS;
  const t = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, endsAt, mode: 'preserve', now: NOW });
  assert.equal(t.status, 'expired');
  assert.equal(t.action, 'grant');
});

test('preserve: missing expiry is blocked (never guessed)', () => {
  const t = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, endsAt: null, mode: 'preserve', now: NOW });
  assert.equal(t.action, 'block_missing_expiry');
});

test('fresh + lifetime + expired_history + profile_only modes', () => {
  const fresh = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, mode: 'fresh', now: NOW });
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.ends_at, NOW + 60 * DAY_MS);

  const life = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, mode: 'lifetime', now: NOW });
  assert.equal(life.ends_at, null);
  assert.equal(life.status, 'active');

  const hist = computeImportTerm({ planKey: 'silver_self_paced', endsAt: NOW - 5 * DAY_MS, mode: 'expired_history', now: NOW });
  assert.equal(hist.status, 'expired');

  const po = computeImportTerm({ planKey: 'silver_self_paced', mode: 'profile_only', now: NOW });
  assert.equal(po.action, 'noop_profile_only');
  assert.equal(po.ends_at, null);
});

test('same-plan conflict: never shorten a longer existing term', () => {
  const existing = { plan_key: 'silver_self_paced', ends_at: NOW + 90 * DAY_MS, grace_ends_at: NOW + 93 * DAY_MS };
  // imported ends sooner → skip (preserve the longer live term)
  const shorter = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, endsAt: NOW + 30 * DAY_MS, mode: 'preserve', existingActiveSub: existing, now: NOW });
  assert.equal(shorter.action, 'skip_preserve_longer');
  // imported ends later → grant (extends)
  const longer = computeImportTerm({ planKey: 'silver_self_paced', accessDays: 60, endsAt: NOW + 200 * DAY_MS, mode: 'preserve', existingActiveSub: existing, now: NOW });
  assert.equal(longer.action, 'grant');
});

test('different-plan conflict defaults to manual review, overwrite is explicit', () => {
  const existing = { plan_key: 'silver_self_paced', ends_at: NOW + 90 * DAY_MS, grace_ends_at: NOW + 93 * DAY_MS };
  const blocked = computeImportTerm({ planKey: 'sampler', accessDays: 60, endsAt: NOW + 30 * DAY_MS, mode: 'preserve', existingActiveSub: existing, now: NOW });
  assert.equal(blocked.action, 'block_conflict');
  const over = computeImportTerm({ planKey: 'sampler', accessDays: 60, endsAt: NOW + 30 * DAY_MS, mode: 'preserve', existingActiveSub: existing, conflictPolicy: 'overwrite', now: NOW });
  assert.equal(over.action, 'grant');
});

test('an expired-history import never disturbs a live active term', () => {
  const existing = { plan_key: 'silver_self_paced', ends_at: NOW + 90 * DAY_MS, grace_ends_at: NOW + 93 * DAY_MS };
  const t = computeImportTerm({ planKey: 'silver_self_paced', endsAt: NOW - 5 * DAY_MS, mode: 'expired_history', existingActiveSub: existing, now: NOW });
  assert.equal(t.action, 'skip_preserve_longer');
});

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

// ── decideOnboardingStep: the retry-safe stamp/invite gate (regression for the bug where
//    a retry after a mid-row failure stranded the account with no password) ──────────────
test('decideOnboardingStep: happy-path first run stamps + invites', () => {
  const d = decideOnboardingStep({ createdThisPass: true, authUserCreated: false, inviteStatus: null });
  assert.deepEqual(d, { isImportStub: true, shouldStamp: true, shouldInvite: true });
});

test('decideOnboardingStep: RETRY after a mid-row failure (account already created) still stamps + invites', () => {
  // The bug: keying only on this-pass creation (createdThisPass=false on a retry) skipped the
  // stamp + invite forever. Keying on the durable row flag fixes it.
  const d = decideOnboardingStep({ createdThisPass: false, authUserCreated: true, inviteStatus: null });
  assert.equal(d.isImportStub, true);
  assert.equal(d.shouldStamp, true);
  assert.equal(d.shouldInvite, true);
});

test('decideOnboardingStep: an already-sent/resent invite is NOT re-sent (still stamps)', () => {
  for (const inviteStatus of ['sent', 'resent']) {
    const d = decideOnboardingStep({ createdThisPass: false, authUserCreated: true, inviteStatus });
    assert.equal(d.isImportStub, true);
    assert.equal(d.shouldStamp, true, `stamp stays idempotent for invite_status=${inviteStatus}`);
    assert.equal(d.shouldInvite, false, `no re-invite for invite_status=${inviteStatus}`);
  }
});

test('decideOnboardingStep: a merged native user (never import-created) is neither stamped nor invited', () => {
  const d = decideOnboardingStep({ createdThisPass: false, authUserCreated: false, inviteStatus: null });
  assert.deepEqual(d, { isImportStub: false, shouldStamp: false, shouldInvite: false });
});

test('decideOnboardingStep: a failed prior invite IS retried', () => {
  const d = decideOnboardingStep({ createdThisPass: false, authUserCreated: true, inviteStatus: 'failed' });
  assert.equal(d.shouldInvite, true);
});

// ── computeImportTerm: never shorten an existing LIFETIME (ends_at = null) active term ──
test('computeImportTerm: a finite preserve term never supersedes an existing lifetime active term', () => {
  const term = computeImportTerm({
    planKey: 'silver_self_paced',
    accessDays: 60,
    endsAt: Date.UTC(2026, 8, 1),          // a finite future expiry
    mode: 'preserve',
    existingActiveSub: { plan_key: 'silver_self_paced', ends_at: null, grace_ends_at: null }, // lifetime
    now: NOW,
  });
  // The existing term is effectively Infinity → the finite candidate must not shorten it.
  assert.equal(term.action, 'skip_preserve_longer');
});

test('computeImportTerm: a lifetime candidate over an existing lifetime term is left untouched', () => {
  const term = computeImportTerm({
    planKey: 'silver_self_paced',
    mode: 'lifetime',
    existingActiveSub: { plan_key: 'silver_self_paced', ends_at: null, grace_ends_at: null },
    now: NOW,
  });
  // candidateEnd = Infinity, existingEnd = Infinity → not strictly greater → preserve existing.
  assert.equal(term.action, 'skip_preserve_longer');
});

// ── batch_code (#32): template column + end-to-end proposal via proposeForRow ──
// proposeForRow is the endpoint's exported pure resolver (the trainerOrchestration
// pattern) — these pin the "VIP rows need a confirmed OPEN batch" rule.
import { IMPORT_TEMPLATE_COLUMNS } from '../src/lib/studentImport.js';
import { proposeForRow } from '../api/admin/student-imports.js';

test('IMPORT_TEMPLATE_COLUMNS carries batch_code as the 12th column', () => {
  assert.equal(IMPORT_TEMPLATE_COLUMNS.length, 12);
  assert.equal(IMPORT_TEMPLATE_COLUMNS[11], 'batch_code');
  assert.equal(IMPORT_TEMPLATE_COLUMNS[0], 'thinkific_user_id');
});

const BATCHES_BY_CODE = {
  '2026-08': { id: 'b-aug', code: '2026-08', status: 'open' },
  '2026-09': { id: 'b-sep', code: '2026-09', status: 'closed' },
};

function proposalCtx(extra = {}) {
  return {
    bySourceMap: new Map(),
    byEmailMap: new Map(),
    comboPlanMap: { 'QBO Mastery': 'vip', 'QBO Mastery | Resume': 'silver_self_paced' },
    planAccessDays: new Map([
      ['sampler', 60], ['silver_self_paced', 60], ['vip', 180],
    ]),
    planRows: {
      vip: { key: 'vip', community_segment: 'vip' },
      silver_self_paced: { key: 'silver_self_paced', community_segment: 'general' },
      sampler: { key: 'sampler', community_segment: 'general' },
    },
    batchesByCode: BATCHES_BY_CODE,
    defaultTermMode: 'fresh',
    now: NOW,
    ...extra,
  };
}

function vipRow(batchCode) {
  return {
    external_user_id: '9001',
    email_normalized: 'synthetic.vip@example.com',
    mapped: { combo_key: 'QBO Mastery', batch_code: batchCode },
    errors: [], warnings: [],
  };
}

test('proposeForRow: VIP row with a confirmed open batch is ready and carries the batch id', () => {
  const p = proposeForRow(vipRow('2026-08'), proposalCtx());
  assert.equal(p.proposed_plan_key, 'vip');
  assert.equal(p.proposed_batch_id, 'b-aug');
  assert.equal(p.processing_status, 'ready');
});

test('proposeForRow: VIP row without a batch_code is BLOCKED for manual review', () => {
  const p = proposeForRow(vipRow(''), proposalCtx());
  assert.equal(p.processing_status, 'blocked');
  assert.equal(p.intended_action, 'manual_review');
  assert.equal(p.proposed_batch_id, null);
  assert.ok(p.errors.some((e) => /Needs batch assignment/.test(e)));
});

test('proposeForRow: VIP row into a CLOSED batch is BLOCKED (closed batches reject new assignments)', () => {
  const p = proposeForRow(vipRow('2026-09'), proposalCtx());
  assert.equal(p.processing_status, 'blocked');
  assert.ok(p.errors.some((e) => /closed/.test(e)));
});

test('proposeForRow: VIP row with an unknown batch_code is BLOCKED, never guessed', () => {
  const p = proposeForRow(vipRow('2027-01'), proposalCtx());
  assert.equal(p.processing_status, 'blocked');
  assert.ok(p.errors.some((e) => /Unknown batch_code/.test(e)));
});

// #39: a retired plan key must never survive the allowlist, even if a stale combo
// map or a hand-edited CSV column still names it.
test('proposeForRow: a retired plan key is refused, not granted', () => {
  const row = {
    external_user_id: '9003',
    email_normalized: 'synthetic.legacy@example.com',
    mapped: { combo_key: 'QBO Mastery', plan_key: 'core_self_paced', batch_code: '' },
    errors: [], warnings: [],
  };
  const p = proposeForRow(row, proposalCtx());
  assert.notEqual(p.proposed_plan_key, 'core_self_paced',
    'a plan key absent from planAccessDays must not be accepted');
});

test('proposeForRow: general-plan row ignores a stray batch_code with a warning', () => {
  const row = {
    external_user_id: '9002',
    email_normalized: 'synthetic.silver@example.com',
    mapped: { combo_key: 'QBO Mastery | Resume', batch_code: '2026-08' },
    errors: [], warnings: [],
  };
  const p = proposeForRow(row, proposalCtx());
  assert.equal(p.proposed_plan_key, 'silver_self_paced');
  assert.equal(p.proposed_batch_id, null);
  assert.equal(p.processing_status, 'ready');
  assert.ok(p.warnings.some((w) => /ignored/.test(w)));
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
