// test/appErrors.test.mjs — the stable error-code contract (#35).
//
// These pin the rule that makes the contract survivable: the client branches on
// `hint`, and every other resolution path is a fallback. If someone "simplifies"
// appErrorCode() to read error.code or the HTTP status, these fail.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_ERROR_CODES,
  APP_ERROR_COPY,
  appErrorCode,
  appErrorContext,
  appErrorMessage,
  isMigrationMissing,
} from '../src/lib/appErrors.js';

/** Build a PostgrestError the way supabase-js surfaces one from app_error(). */
function pgErr({ code = 'PT409', message = 'boom', hint = null, context = null } = {}) {
  return {
    code,
    message,
    hint,
    details: hint ? JSON.stringify({ code: hint, context: context || {} }) : null,
  };
}

test('appErrorCode reads the hint — the documented branch key', () => {
  assert.equal(appErrorCode(pgErr({ hint: 'BATCH_FULL' })), 'BATCH_FULL');
  assert.equal(appErrorCode(pgErr({ hint: 'BATCH_REQUIRED', code: 'PT422' })), 'BATCH_REQUIRED');
});

test('appErrorCode never trusts an unknown hint (PostgREST adds its own hints)', () => {
  // PostgREST emits hints like this for a missing function; echoing one as a
  // code would put database internals in front of a user.
  const e = pgErr({ hint: 'Perhaps you meant the function public.foo', code: 'PGRST202' });
  // Falls through to the PGRST202 branch rather than accepting the hint.
  assert.equal(appErrorCode(e), 'MIGRATION_MISSING');

  // Right shape, not in the catalog → rejected.
  assert.equal(appErrorCode({ hint: 'TOTALLY_MADE_UP_CODE', message: 'x' }), null);
});

test('appErrorCode falls back to the details envelope when hint is stripped', () => {
  const e = {
    code: 'PT409',
    message: 'batch 2026-08 is full for gold (10 of 10 seats)',
    hint: null,
    details: JSON.stringify({ code: 'BATCH_FULL', context: { batch_code: '2026-08' } }),
  };
  assert.equal(appErrorCode(e), 'BATCH_FULL');
});

test('appErrorCode maps PGRST202 to MIGRATION_MISSING', () => {
  assert.equal(appErrorCode({ code: 'PGRST202', message: 'Not Found' }), 'MIGRATION_MISSING');
  assert.equal(
    appErrorCode({ code: 'PGRST100', message: 'Could not find the function public.grant_batch_run' }),
    'MIGRATION_MISSING',
  );
  assert.ok(isMigrationMissing({ code: 'PGRST202', message: '' }));
  assert.ok(!isMigrationMissing(pgErr({ hint: 'BATCH_FULL' })));
});

// A function NAME in an error message says which object failed, never why. The
// Progress & Rankings tab used to add /student_progress|student_leaderboard/ to its
// own check, so "permission denied for function my_student_progress" — a missing
// GRANT — rendered as "migration #52 is not applied" and sent an admin to re-run
// SQL that had already run. Every one of these must stay FALSE.
//
// ★ This test alone does NOT pin that bug: it never lived in this module —
// isMigrationMissing() is a one-line code check and never carried a name regex, so
// these cases passed before the fix too. What stops the JSX widening it again is the
// source scan in test/studentProgress.test.mjs ("the setup card is not triggered by
// a function name"). Keep the two together.
test('isMigrationMissing does not fire on failures that merely name our functions', () => {
  const notMissing = [
    { code: '42501', message: 'permission denied for function my_student_progress' },
    { code: '42501', message: 'permission denied for function student_leaderboard' },
    { code: '42501', message: 'permission denied for table student_progress_daily' },
    { code: '42P01', message: 'relation "student_progress_milestones" does not exist' },
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: 'P0001', message: 'student_leaderboard: unknown scope' },
  ];
  for (const e of notMissing) {
    assert.equal(isMigrationMissing(e), false, `should not be MIGRATION_MISSING: ${e.message}`);
  }
  // The genuine article still is.
  assert.ok(isMigrationMissing({
    code: 'PGRST202',
    message: "Could not find the function public.my_student_progress without parameters in the schema cache",
  }));
});

// These strings are HISTORICAL VERBATIM — they are what a pre-#35 database actually
// raised, including plan and segment names that #39 has since removed. They stay as
// written on purpose: the parser's whole job is recognising messages it did not
// author, and rewriting the fixtures to today's vocabulary would stop testing that.
test('appErrorCode recognises pre-#35 free-text raises', () => {
  const legacy = [
    ['admin_finalize_enrollment: batch 2026-08 is full for gold (10 of 10 seats)', 'BATCH_FULL'],
    ['admin_finalize_enrollment: gold_live needs a batch — pick an open batch in the approve dialog', 'BATCH_REQUIRED'],
    ['admin_finalize_enrollment: batch 2026-08 is archived', 'BATCH_CLOSED'],
    ['admin_finalize_enrollment: batch 2026-09 is closed to new assignments', 'BATCH_CLOSED'],
    ['admin_finalize_enrollment: batch not found', 'BATCH_NOT_FOUND'],
    ['admin_finalize_enrollment: batch 2026-08 has no active gold space', 'NO_SPACE_FOR_SEGMENT'],
    ['admin_finalize_enrollment: unknown plan bogus_plan', 'INVALID_PLAN'],
    ['admin_finalize_enrollment: plan gold_live is inactive', 'INVALID_PLAN'],
    ['admin_finalize_enrollment: request not found', 'REQUEST_NOT_FOUND'],
    ['admin_finalize_enrollment: admin only', 'FORBIDDEN'],
  ];
  for (const [message, expected] of legacy) {
    assert.equal(appErrorCode({ message }), expected, message);
  }
});

test('legacy pattern order is specific-before-general', () => {
  // "is full for" must win over any broader batch pattern that follows it.
  assert.equal(
    appErrorCode({ message: 'admin_finalize_enrollment: batch 2026-08 is full for vip (5 of 5 seats)' }),
    'BATCH_FULL',
  );
});

test('appErrorCode returns null for an unrelated error rather than guessing', () => {
  assert.equal(appErrorCode({ code: '23505', message: 'duplicate key value violates unique constraint' }), null);
  assert.equal(appErrorCode(null), null);
  assert.equal(appErrorCode(undefined), null);
  assert.equal(appErrorCode({}), null);
});

test('appErrorContext returns the structured context, always an object', () => {
  const e = pgErr({ hint: 'BATCH_FULL', context: { batch_code: '2026-08', used: 10, capacity: 10 } });
  assert.deepEqual(appErrorContext(e), { batch_code: '2026-08', used: 10, capacity: 10 });

  // Missing / malformed / non-object contexts never throw and never leak a non-object.
  assert.deepEqual(appErrorContext(null), {});
  assert.deepEqual(appErrorContext({ details: 'not json' }), {});
  assert.deepEqual(appErrorContext({ details: JSON.stringify({ code: 'X', context: [1, 2] }) }), {});
  assert.deepEqual(appErrorContext({ details: JSON.stringify({ code: 'X' }) }), {});
});

test('appErrorMessage prefers our copy for a known code', () => {
  const e = pgErr({ hint: 'BATCH_FULL', message: 'admin_finalize_enrollment: batch 2026-08 is full for gold' });
  assert.equal(appErrorMessage(e), APP_ERROR_COPY.BATCH_FULL);
});

test('appErrorMessage falls back to the database sentence for an unknown code', () => {
  // A code added in SQL before the client knows it must still produce something
  // readable — this is what makes the catalog safe to extend server-first.
  const e = { code: 'PT409', message: 'some_rpc: a brand new failure mode', hint: 'FUTURE_CODE' };
  assert.equal(appErrorMessage(e), 'A brand new failure mode');
});

test('appErrorMessage strips the function-name prefix and capitalises', () => {
  assert.equal(appErrorMessage({ message: 'grant_batch_run: something specific happened' }),
    'Something specific happened');
  assert.equal(appErrorMessage({ message: 'admin_assign_batch(uuid[], uuid): nope' }), 'Nope');
});

test('appErrorMessage uses the caller fallback only when there is nothing else', () => {
  assert.equal(appErrorMessage(null, 'Could not approve this enrollment.'), 'Could not approve this enrollment.');
  assert.equal(appErrorMessage({ message: '' }, 'Could not approve this enrollment.'), 'Could not approve this enrollment.');
  assert.equal(appErrorMessage(undefined), 'Something went wrong.');
});

test('every catalog code has user-facing copy', () => {
  const missing = APP_ERROR_CODES.filter((c) => !APP_ERROR_COPY[c]);
  assert.deepEqual(missing, [], `codes without copy: ${missing.join(', ')}`);
});

test('no copy string leaks a placeholder or an undefined interpolation', () => {
  for (const [code, copy] of Object.entries(APP_ERROR_COPY)) {
    assert.ok(!/undefined|\[object|TODO|\$\{/.test(copy), `${code} copy is unfinished: ${copy}`);
    assert.ok(copy.trim().length > 10, `${code} copy is too terse to help: ${copy}`);
  }
});

test('the catalog has no duplicates and every code matches the wire shape', () => {
  assert.equal(new Set(APP_ERROR_CODES).size, APP_ERROR_CODES.length, 'duplicate code in APP_ERROR_CODES');
  for (const c of APP_ERROR_CODES) {
    assert.match(c, /^[A-Z][A-Z0-9_]{2,39}$/, `${c} cannot survive the hint validator`);
  }
});

// ── #68: the legacy migration, round 2 ──────────────────────────────────────

test('LEGACY_BATCH_GAP is a known code, read off the hint, with its missing months', () => {
  assert.ok(APP_ERROR_CODES.includes('LEGACY_BATCH_GAP'));
  // 141 SQL codes in app_error_catalog() after #69, plus the one client-synthesised code.
  assert.equal(APP_ERROR_CODES.filter((c) => c !== 'MIGRATION_MISSING').length, 141);
  const e = pgErr({ hint: 'LEGACY_BATCH_GAP', code: 'PT409', context: { missing: ['2026-11'] } });
  assert.equal(appErrorCode(e), 'LEGACY_BATCH_GAP');
  assert.deepEqual(appErrorContext(e), { missing: ['2026-11'] });
  const msg = appErrorMessage(e);
  assert.match(msg, /no batch yet/);
  assert.match(msg, /Admin → Batches/, 'it names the screen that fixes it');
  assert.match(msg, /skip that month for good/, 'and why it matters: the allocator only moves forward');
});

test('the revert refusal no longer sends the Super Admin to Enrollments', () => {
  // Enrollments cannot change a plan or a term's dates — the old copy pointed at a screen
  // with no way to act.
  const copy = APP_ERROR_COPY.LEGACY_REVERT_REFUSED;
  assert.doesNotMatch(copy, /Enrollments/);
  assert.match(copy, /nothing was changed/i);
  assert.match(copy, /five characters/, 'it covers the short-reason refusal too — this copy replaces the database sentence');
});

test('a busy run no longer blames a window that may not exist', () => {
  const copy = APP_ERROR_COPY.LEGACY_RUN_BUSY;
  assert.match(copy, /stopped part-way/);
  assert.match(copy, /10 minutes/);
});

// ── #69: the Getting Started onboarding video ───────────────────────────────

const ONBOARDING_VIDEO_CODES = [
  'ONBOARDING_VIDEO_NOT_FOUND',
  'ONBOARDING_VIDEO_UNAVAILABLE',
  'ONBOARDING_VIDEO_NOT_ELIGIBLE',
  'ONBOARDING_VIDEO_NOT_FINISHED',
  'ONBOARDING_VIDEO_STATE_INVALID',
  'ONBOARDING_VIDEO_MEDIA_INVALID',
  'ONBOARDING_VIDEO_REPLACE_CONFIRM',
  'ONBOARDING_VIDEO_TEXT_INVALID',
];

test('the eight #69 codes are known, read off the hint, and each shows its own copy', () => {
  for (const code of ONBOARDING_VIDEO_CODES) {
    assert.ok(APP_ERROR_CODES.includes(code), `${code} is not in APP_ERROR_CODES`);
    const copy = APP_ERROR_COPY[code];
    assert.ok(typeof copy === 'string' && copy.length > 20, `${code} has no copy`);
    const e = pgErr({ hint: code, code: 'PT409', message: 'start_onboarding_video: a sentence for the log' });
    assert.equal(appErrorCode(e), code, `${code} must survive the hint validator`);
    assert.equal(appErrorMessage(e), copy, `${code} must show its written copy, not the database sentence`);
  }
  assert.equal(new Set(ONBOARDING_VIDEO_CODES.map((c) => APP_ERROR_COPY[c])).size, ONBOARDING_VIDEO_CODES.length,
    'each refusal says its own thing');
});

test('ONBOARDING_VIDEO_MEDIA_INVALID is worded for the PUBLISH that raises it, as well as the attach (AUI-6)', () => {
  // admin_onboarding_video_publish raises it for "This version has no file in storage", and this copy
  // outranks the server's sentence — which, for "Publish again" on a RETIRED version, used to send the
  // Super Admin to attach a file to a draft from an editor that version does not have.
  const copy = APP_ERROR_COPY.ONBOARDING_VIDEO_MEDIA_INVALID;
  assert.match(copy, /no longer in storage/, 'what a publish meets: the file vanished after the list loaded');
  assert.match(copy, /in a draft’s editor, or as a new video/, 'a way forward for a draft and for a version that was live before');
  assert.doesNotMatch(copy, /attached to this draft/, 'not an attach-only sentence');
  assert.match(copy, /Nothing was changed\.$/, 'the Getting Started editor strips this ending when the details had already been saved');
  const e = pgErr({ hint: 'ONBOARDING_VIDEO_MEDIA_INVALID', code: 'PT422', message: 'admin_onboarding_video_publish: This version has no file in storage.' });
  assert.equal(appErrorMessage(e), copy);
});

test('a student-facing #69 refusal never talks about the admin screen or the storage behind it', () => {
  // These three reach a STUDENT, on the welcome screen or the replay page. The student has
  // no admin screen and no bucket, so copy about drafts or files would only confuse them.
  for (const code of ['ONBOARDING_VIDEO_UNAVAILABLE', 'ONBOARDING_VIDEO_NOT_ELIGIBLE', 'ONBOARDING_VIDEO_NOT_FINISHED']) {
    const copy = APP_ERROR_COPY[code];
    assert.match(copy, /Getting Started video/, `${code} names what it is about`);
    assert.doesNotMatch(copy, /Super Admin|draft|publish|upload|storage|bucket|onboarding_video/i, code);
  }
});
