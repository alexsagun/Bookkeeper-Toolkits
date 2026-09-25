// ─────────────────────────────────────────────────────────────────────────────
// test-db/enrollmentDecisionLock.dbtest.mjs — a decided enrollment request stays decided (#66).
// ─────────────────────────────────────────────────────────────────────────────
// THE HOLE THIS PINS SHUT
//   #48 granted `UPDATE (status, …)` on enrollment_requests to every enrollments.review
//   holder — Operations Admins included — so the reject button could work. Nothing
//   then limited WHICH status a row could move from. admin_finalize_enrollment()'s only
//   idempotency is `if status = 'approved' then return already`, and
//   approve_subscription() has no per-request guard at all. So a reviewer could:
//
//     approve  →  PATCH status back to 'pending_review'  →  approve again
//
//   and the second approval stacked a SECOND paid term onto the student with no second
//   payment. #60's enrollment_approval_requires_grant let it through (a subscription
//   already carried the request id) and #58's idempotency key stopped a second finance
//   collection — so the extra months left no trace in the books at all. That is more
//   than admin_grant_special_extension() allows, which is Super-Admin-only and audited
//   precisely because it creates paid access with no payment behind it (#47, #55).
//
// Every assertion runs as a REAL signed-in persona through PostgREST. The Management
// API (postgres) only builds fixtures and reads counts.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { makePersona, seedStaff, runSql, lit, sqlScalar } from './_harness.mjs';

let superAdmin; let ops; let student;

async function pendingRequest(persona, { overdue = false } = {}) {
  return sqlScalar(`
    with r as (
      insert into public.enrollment_requests
        (user_id, plan_key, plan_name, full_name, email, amount_expected, amount_paid, status, expires_at)
      values ('${persona.id}'::uuid, 'sampler', 'Sampler Session', ${lit(persona.label)},
              ${lit(persona.email)}, 1499, 1499, 'pending_review',
              ${overdue ? `now() - interval '1 day'` : `now() + interval '3 days'`})
      returning id)
    select id::text from r`);
}

const statusOf = (id) => sqlScalar(`select status from public.enrollment_requests where id = '${id}'::uuid`);
const termsOf = (p) => sqlScalar(`select count(*)::int from public.subscriptions where user_id = '${p.id}'::uuid`).then(Number);
const collectionsOf = (id) => sqlScalar(`select count(*)::int from public.finance_payment_events
                                          where idempotency_key = 'enrollment:${id}:collection'`).then(Number);

before(async () => {
  superAdmin = await makePersona('lock-super', { fullName: 'Lock Super' });
  ops = await makePersona('lock-ops', { fullName: 'Lock Ops' });
  student = await makePersona('lock-student', { fullName: 'Lock Student' });
  await seedStaff(superAdmin, 'super_admin');
  await seedStaff(ops, 'operations_admin');
  // This suite's own rows only — it does not truncate, so it cannot disturb another
  // suite's fixtures, and a re-run starts from the same state.
  await runSql(`
    delete from public.enrollment_requests where user_id = '${student.id}'::uuid;
    delete from public.batch_entitlements where user_id = '${student.id}'::uuid;
    delete from public.subscriptions where user_id = '${student.id}'::uuid;`);
});

test('an Operations Admin cannot reopen an approved request and approve it a second time', async () => {
  const reqId = await pendingRequest(student);
  const first = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  assert.equal(first.error, null, first.error && first.error.message);
  const termsAfterFirst = await termsOf(student);
  const collectionsAfterFirst = await collectionsOf(reqId);

  const reopen = await ops.db.from('enrollment_requests')
    .update({ status: 'pending_review', updated_at: new Date().toISOString() })
    .eq('id', reqId).select('id');

  const afterReopen = await statusOf(reqId);
  let terms = termsAfterFirst;
  let again = null;
  if (afterReopen === 'pending_review') {
    // The lock is missing. Finish the attack so the failure states what it costs.
    again = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
    terms = await termsOf(student);
  }

  assert.equal(afterReopen, 'approved',
    `a reviewer reopened an approved request; approving it again ${again?.error ? `failed (${again.error.message})` : 'succeeded'} ` +
    `and one payment now carries ${terms} membership terms (was ${termsAfterFirst}), ` +
    `${await collectionsOf(reqId)} finance collection(s)`);
  assert.equal(reopen.error?.hint, 'INVALID_MEMBERSHIP_TRANSITION',
    `the refusal must carry a stable code, got ${reopen.error?.code}: ${reopen.error?.message}`);
  assert.equal(terms, termsAfterFirst, 'no second term');
  assert.equal(await collectionsOf(reqId), collectionsAfterFirst, 'no second finance collection');
});

test('a reviewer cannot re-decide an approved request as rejected or expired', async () => {
  const reqId = await sqlScalar(`select id::text from public.enrollment_requests
                                  where user_id = '${student.id}'::uuid and status = 'approved' limit 1`);
  assert.ok(reqId, 'the previous test leaves one approved request');
  for (const status of ['rejected', 'expired']) {
    const res = await ops.db.from('enrollment_requests')
      .update({ status, rejection_reason: 'stale card', updated_at: new Date().toISOString() })
      .eq('id', reqId).select('id');
    assert.equal(await statusOf(reqId), 'approved', `an approved request was re-decided as ${status}`);
    assert.equal(res.error?.hint, 'INVALID_MEMBERSHIP_TRANSITION', `${status}: ${res.error?.message}`);
  }
});

test('a PENDING request can still be rejected by a reviewer', async () => {
  const other = await makePersona('lock-student2', { fullName: 'Lock Student Two' });
  await runSql(`delete from public.enrollment_requests where user_id = '${other.id}'::uuid`);
  const reqId = await pendingRequest(other);
  const res = await ops.db.from('enrollment_requests')
    .update({ status: 'rejected', rejection_reason: 'Receipt unreadable', updated_at: new Date().toISOString() })
    .eq('id', reqId).eq('status', 'pending_review').select('id');
  assert.equal(res.error, null, res.error && res.error.message);
  assert.equal(await statusOf(reqId), 'rejected');

  // …and, once rejected, it is as final as an approval.
  await ops.db.from('enrollment_requests')
    .update({ status: 'pending_review', updated_at: new Date().toISOString() }).eq('id', reqId);
  assert.equal(await statusOf(reqId), 'rejected', 'a rejected request was reopened');
});

test("a student can still expire their OWN overdue request", async () => {
  const self = await makePersona('lock-student3', { fullName: 'Lock Student Three' });
  await runSql(`delete from public.enrollment_requests where user_id = '${self.id}'::uuid`);
  const reqId = await pendingRequest(self, { overdue: true });
  const res = await self.db.from('enrollment_requests')
    .update({ status: 'expired' }).eq('id', reqId).select('id');
  assert.equal(res.error, null, res.error && res.error.message);
  assert.equal(await statusOf(reqId), 'expired');
});

// Self-contained: builds its own approved request, so it cannot depend on what an earlier
// test did to `student`'s row (before #66, test 2 re-decided that row, and this one then
// found nothing to reopen).
async function approvedRequest(label) {
  const who = await makePersona(label, { fullName: label });
  await runSql(`
    delete from public.enrollment_requests where user_id = '${who.id}'::uuid;
    delete from public.batch_entitlements where user_id = '${who.id}'::uuid;
    delete from public.subscriptions where user_id = '${who.id}'::uuid;`);
  const reqId = await pendingRequest(who);
  const ok = await ops.db.rpc('admin_finalize_enrollment', { p_request_id: reqId, p_batch_id: null });
  assert.equal(ok.error, null, ok.error && ok.error.message);
  assert.equal(await statusOf(reqId), 'approved');
  return reqId;
}
const reopenEvents = (id) => sqlScalar(`select count(*)::int from public.enrollment_request_events
                                         where request_id = '${id}'::uuid and action = 'decision_reopened'`).then(Number);

test('a Super Admin keeps break-glass over a decided request, and it is logged', async () => {
  const reqId = await approvedRequest('lock-student4');
  const res = await superAdmin.db.from('enrollment_requests')
    .update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', reqId).select('id');
  assert.equal(res.error, null, res.error && res.error.message);
  assert.equal(await statusOf(reqId), 'expired');
  assert.equal(await reopenEvents(reqId), 1, 'a re-decision creates or removes paid access and must leave a timeline row');
  const via = await sqlScalar(`select detail->>'via' from public.enrollment_request_events
                                where request_id = '${reqId}'::uuid and action = 'decision_reopened'`);
  assert.equal(via, 'super_admin');
});

test('a note on a DECIDED request still saves — the lock is scoped to a status change', async () => {
  const reqId = await approvedRequest('lock-student5');
  const res = await ops.db.from('enrollment_requests')
    .update({ admin_notes: 'Paid by GCash, verified.', updated_at: new Date().toISOString() })
    .eq('id', reqId).select('id');
  assert.equal(res.error, null, res.error && res.error.message);
  assert.equal(res.data?.length, 1, 'the note was not written');
  assert.equal(await sqlScalar(`select admin_notes from public.enrollment_requests where id = '${reqId}'::uuid`),
    'Paid by GCash, verified.');
  assert.equal(await reopenEvents(reqId), 0, 'a same-status write is not a reopen');
});

test('a session with no JWT is refused unless the table owner opts in explicitly', async () => {
  const reqId = await approvedRequest('lock-student6');
  // The Management API runs as postgres with no JWT. "No caller" must not mean "trusted".
  await assert.rejects(
    runSql(`update public.enrollment_requests set status = 'pending_review' where id = '${reqId}'::uuid`, { retries: 0 }),
    /already approved|INVALID_MEMBERSHIP_TRANSITION/);
  assert.equal(await statusOf(reqId), 'approved');
  // The documented break-glass: SET LOCAL in the owner's session, inside one transaction.
  await runSql(`begin;
    set local app.enrollment_admin_override = 'on';
    update public.enrollment_requests set status = 'pending_review', updated_at = now() where id = '${reqId}'::uuid;
    commit;`);
  assert.equal(await statusOf(reqId), 'pending_review');
  assert.equal(await sqlScalar(`select detail->>'via' from public.enrollment_request_events
                                 where request_id = '${reqId}'::uuid and action = 'decision_reopened'`), 'owner_override');
});
