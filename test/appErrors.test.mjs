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
