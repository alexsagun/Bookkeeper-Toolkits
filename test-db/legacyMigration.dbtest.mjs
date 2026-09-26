// ─────────────────────────────────────────────────────────────────────────────
// test-db/legacyMigration.dbtest.mjs — the legacy student migration, end to end (#67).
// ─────────────────────────────────────────────────────────────────────────────
// Drives the REAL functions the endpoint calls (service role, with p_actor) and the
// REAL Super Admin RPCs (a signed-in persona through PostgREST), then asserts on what
// the database holds. Synthetic people only (@shadow.test), far-future synthetic
// batches (2034-05/06/07), and a per-run nonce in every address, so a re-run never
// collides with an earlier one and never touches another suite's fixtures.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import {
  expectAppError, lit, makeBatch, makePersona, runSql, seedStaff, serviceClient, sqlScalar,
} from './_harness.mjs';
import { shadowEnv } from '../scripts/_shadow.mjs';

const NONCE = randomBytes(4).toString('hex');
const addr = (tag) => `lm-${NONCE}-${tag}@shadow.test`;
const svc = () => serviceClient();
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const TODAY = Date.now();

let sa; let ops; let trainer; let student; let existing; let banned;

/** A roster row in the shape api/admin/student-imports.js hands to legacy_import_stage. */
function row(n, over = {}) {
  return {
    source_row_number: n, external_user_id: null, email_normalized: addr(`r${n}`), email_display: addr(`r${n}`),
    first_name: `Test${n}`, last_name: 'Legacy', plan_key: 'vip', legacy_plan_label: 'VIP',
    batch_code: '2034-05', legacy_batch_label: 'May 2034', start_date: '2034-05-10', end_date: '2034-11-10',
    payment_status: 'paid', amount_paid: 15999, currency: 'PHP', errors: [], warnings: [],
    ...over,
  };
}

async function stage(rows, eligible, { tag = 'main' } = {}) {
  const content = createHash('sha256').update(`${NONCE}:${tag}:${JSON.stringify(rows)}`).digest('hex');
  const { data, error } = await svc().rpc('legacy_import_stage', {
    p_actor: sa.id,
    p_job: { filename: `synthetic-${tag}.csv`, content_sha256: content, date_format: 'M/D/YYYY',
      plan_mapping: { vip: 'vip' }, batch_mapping: {}, eligible_batch_codes: eligible },
    p_rows: rows,
  });
  assert.equal(error, null, error && error.message);
  return { ...data, content };
}

const rowsOf = async (jobId) => runSql(`select id::text, source_row_number, email_normalized, validation_status,
  activation_state, errors, matched_existing from public.student_import_rows where job_id = '${jobId}'::uuid order by source_row_number`);
const rowByNumber = async (jobId, n) => (await rowsOf(jobId)).find((r) => r.source_row_number === n);

/** The saga the endpoint runs for one claimed row, minus the email. */
async function activateOne(runId, lease) {
  const { data: claimed, error } = await svc().rpc('legacy_import_claim_rows', {
    p_actor: sa.id, p_run_id: runId, p_lease: lease, p_limit: 1, p_retry_failed: false, p_exclude: [],
  });
  assert.equal(error, null, error && error.message);
  if (!claimed.length) return null;
  const r = claimed[0];
  let uid = r.target_user_id; let created = false;
  if (!uid) {
    const found = await svc().rpc('legacy_import_find_auth_user', { p_actor: sa.id, p_email: r.email });
    if (found.data?.length) uid = found.data[0].user_id;
    else {
      const c = await svc().auth.admin.createUser({ email: r.email, email_confirm: false, user_metadata: { full_name: r.full_name } });
      assert.equal(c.error, null, c.error && c.error.message);
      uid = c.data.user.id; created = true;
    }
  }
  const bind = await svc().rpc('legacy_import_bind_user', { p_actor: sa.id, p_row_id: r.row_id, p_run_id: runId, p_user_id: uid, p_created: created });
  assert.equal(bind.error, null, bind.error && bind.error.message);
  const act = await svc().rpc('legacy_import_activate_row', { p_actor: sa.id, p_row_id: r.row_id, p_run_id: runId });
  assert.equal(act.error, null, act.error && act.error.message);
  return { rowId: r.row_id, uid, ...act.data };
}

async function signInAs(uid, email) {
  const password = `Lm-${NONCE}-Passw0rd!`;
  await svc().auth.admin.updateUserById(uid, { password, email_confirm: true });
  const env = shadowEnv();
  const c = createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null, error && error.message);
  return createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

let job; let runId;

before(async () => {
  sa = await makePersona('lm-super', { fullName: 'LM Super' });
  ops = await makePersona('lm-ops', { fullName: 'LM Ops' });
  trainer = await makePersona('lm-trainer', { fullName: 'LM Trainer' });
  student = await makePersona('lm-student', { fullName: 'LM Student' });
  existing = await makePersona(`lm-existing-${NONCE}`, { fullName: 'LM Existing' });
  banned = await makePersona(`lm-banned-${NONCE}`, { fullName: 'LM Banned' });
  await seedStaff(sa, 'super_admin');
  await seedStaff(ops, 'operations_admin');
  await seedStaff(trainer, 'trainer');
  await runSql(`update public.profiles set approval_status = 'rejected' where id = '${banned.id}'::uuid`);
  await makeBatch('2034-05', { name: 'May 2034', status: 'open' });
  await makeBatch('2034-06', { name: 'June 2034', status: 'open' });
  await makeBatch('2034-07', { name: 'July 2034', status: 'closed' });
});

// ── Authorization ────────────────────────────────────────────────────────────

test('only a Super Admin can read the migration; nobody can write it from a client', async () => {
  for (const p of [ops, trainer, student]) {
    await expectAppError(p.db.rpc('legacy_import_jobs_list'), 'FORBIDDEN', `${p.label} jobs list`);
    const { data } = await p.db.from('student_import_rows').select('id').limit(1);
    assert.equal((data || []).length, 0, `${p.label} must read no import rows`);
  }
  const ins = await sa.db.from('student_import_jobs').insert({ source: 'manual', pipeline: 'legacy_v2' }).select('id');
  assert.ok(ins.error, 'even a Super Admin cannot insert an import job from the browser');
  const direct = await sa.db.rpc('legacy_import_stage', { p_actor: sa.id, p_job: {}, p_rows: [] });
  assert.ok(direct.error, 'the service-only staging function is not callable with a user JWT');
  const asOps = await svc().rpc('legacy_import_jobs_list');
  assert.ok(asOps.error, 'the service role has no auth.uid(), so the Super Admin RPC refuses it too');
  const forged = await svc().rpc('legacy_import_stage', { p_actor: ops.id, p_job: {}, p_rows: [] });
  await expectAppError(Promise.resolve(forged), 'FORBIDDEN', 'an Ops Admin passed as p_actor');
});

// ── Staging ──────────────────────────────────────────────────────────────────

test('staging classifies rows and creates no account, membership, approval or email', async () => {
  const rows = [
    row(1), row(2), row(3),                                                    // ready (2034-05)
    row(4, { batch_code: '2034-06', start_date: iso(TODAY - 10 * DAY), end_date: iso(TODAY + 170 * DAY) }), // inactive, started
    row(5, { batch_code: '2034-07', start_date: iso(TODAY - 5 * DAY), end_date: iso(TODAY + 175 * DAY) }),  // inactive, closed batch
    row(6, { email_normalized: addr('r1'), email_display: addr('r1') }),       // duplicate of row 1
    row(7, { payment_status: 'refunded' }),                                    // blocked
    row(8, { start_date: '2024-01-01', end_date: '2024-06-01' }),              // term ended
    row(9, { email_normalized: existing.email, email_display: existing.email }),// existing confirmed account
    row(10, { email_normalized: banned.email, email_display: banned.email }),  // rejected account
  ];
  const before = Number(await sqlScalar(`select count(*) from auth.users where email like 'lm-${NONCE}-%'`));
  job = await stage(rows, ['2034-05']);
  assert.equal(job.reopened, false);
  const got = await rowsOf(job.job_id);
  const state = Object.fromEntries(got.map((r) => [r.source_row_number, r.activation_state]));
  assert.deepEqual(state, { 1: 'blocked', 2: 'ready', 3: 'ready', 4: 'inactive', 5: 'inactive',
    6: 'blocked', 7: 'blocked', 8: 'blocked', 9: 'ready', 10: 'blocked' });
  assert.equal(got.find((r) => r.source_row_number === 1).validation_status, 'duplicate', 'row 1 shares an email with row 6');
  assert.ok(got.find((r) => r.source_row_number === 8).errors.includes('term_ended'));
  assert.ok(got.find((r) => r.source_row_number === 10).errors.includes('profile_rejected'));
  assert.equal(got.find((r) => r.source_row_number === 9).matched_existing, true);
  const after = Number(await sqlScalar(`select count(*) from auth.users where email like 'lm-${NONCE}-%'`));
  assert.equal(after, before, 'staging created no Auth user');
  assert.equal(Number(await sqlScalar(`select count(*) from public.subscriptions s join public.student_import_rows r
    on r.id = s.source_import_row_id where r.job_id = '${job.job_id}'::uuid`)), 0, 'and no membership');
});

test('the same roster staged again with the same settings reopens the first job', async () => {
  const { data, error } = await svc().rpc('legacy_import_stage', {
    p_actor: sa.id,
    p_job: { filename: 'again.csv', content_sha256: job.content, date_format: 'M/D/YYYY',
      plan_mapping: { vip: 'vip' }, batch_mapping: {}, eligible_batch_codes: ['2034-05'] },
    p_rows: [row(1)],
  });
  assert.equal(error, null, error && error.message);
  assert.equal(data.reopened, true);
  assert.equal(data.job_id, job.job_id);
});

// ★ The fingerprint covers the CELLS, not how they were read. Re-staging the same file to
//   correct a date format used to hand back the job staged with the WRONG one — and 11/10
//   misread as 10/11 still lands inside the batch window, so nothing downstream would notice.
test('the same rows with different settings are refused, and the difference is named', async () => {
  const { error } = await svc().rpc('legacy_import_stage', {
    p_actor: sa.id,
    p_job: { filename: 'again.csv', content_sha256: job.content, date_format: 'D/M/YYYY',
      plan_mapping: { vip: 'vip' }, batch_mapping: {}, eligible_batch_codes: ['2034-05'] },
    p_rows: [row(1)],
  });
  assert.equal(error?.hint, 'LEGACY_JOB_SETTINGS_DIFFER', 'a corrected date format must not reopen the old job');
  const ctx = JSON.parse(error.details).context;
  assert.equal(ctx.job_id, job.job_id, 'the refusal names the job to open or discard');
  assert.deepEqual(ctx.differs, ['date_format']);
  // The job it refused to reopen is untouched: still its original format, still its rows.
  const [j] = await runSql(`select date_format, total_rows from public.student_import_jobs where id = '${job.job_id}'::uuid`);
  assert.equal(j.date_format, 'M/D/YYYY');
});

test('a purchase already staged in another job stages as a duplicate', async () => {
  const other = await stage([row(2)], ['2034-05'], { tag: 'second' });
  const [r] = await rowsOf(other.job_id);
  assert.equal(r.validation_status, 'duplicate');
  assert.ok(r.errors.includes('duplicate_staged'));
  await sa.db.rpc('legacy_import_discard_job', { p_job_id: other.job_id, p_reason: 'synthetic duplicate' });
});

// ── Selection and the run ────────────────────────────────────────────────────

test('a run takes only READY rows and the exact phrase; a repeated key is the same run', async () => {
  const r2 = await rowByNumber(job.job_id, 2);
  const r4 = await rowByNumber(job.job_id, 4);
  await expectAppError(svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: job.job_id, p_row_ids: [r2.id, r4.id], p_phrase: 'ACTIVATE 2', p_client_key: `k${NONCE}aaaa1`,
  }), 'LEGACY_ROW_NOT_READY', 'an inactive row rode along');
  await expectAppError(svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: job.job_id, p_row_ids: [r2.id], p_phrase: 'ACTIVATE 2', p_client_key: `k${NONCE}aaaa2`,
  }), 'LEGACY_CONFIRMATION_MISMATCH', 'the wrong count');
  const ids = [r2.id, (await rowByNumber(job.job_id, 3)).id, (await rowByNumber(job.job_id, 9)).id];
  const first = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: job.job_id, p_row_ids: ids, p_phrase: 'ACTIVATE 3', p_client_key: `k${NONCE}bbbb1`,
  });
  assert.equal(first.error, null, first.error && first.error.message);
  const again = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: job.job_id, p_row_ids: ids, p_phrase: 'ACTIVATE 3', p_client_key: `k${NONCE}bbbb1`,
  });
  assert.equal(again.data.run_id, first.data.run_id);
  assert.equal(again.data.reused, true);
  runId = first.data.run_id;
});

test('activation grants a scheduled term, a cohort run and approval — and no request or payment', async () => {
  const lease = `lease${NONCE}x1`;
  const paymentsBefore = Number(await sqlScalar('select count(*) from public.finance_payment_events'));
  const out = [];
  for (let i = 0; i < 3; i += 1) out.push(await activateOne(runId, lease));
  assert.equal(Number(await sqlScalar('select count(*) from public.finance_payment_events')), paymentsBefore,
    'a legacy activation posts nothing to Financial Management');
  assert.ok(out.every(Boolean), 'three rows were claimed');
  const newbie = out.find((o) => o.kind === 'claim');
  assert.equal(newbie.status, 'scheduled', 'a start in 2034 is scheduled, not opened early');

  const sub = (await runSql(`select status, started_at, ends_at, grace_ends_at, grant_source, source_import_row_id::text, batch_id is not null as has_batch
    from public.subscriptions where user_id = '${newbie.uid}'::uuid`))[0];
  assert.equal(sub.status, 'scheduled');
  assert.equal(sub.grant_source, 'import');
  assert.equal(new Date(sub.started_at).toISOString(), '2034-05-09T16:00:00.000Z', '00:00 in Manila');
  assert.equal(new Date(sub.ends_at).toISOString(), '2034-11-10T15:59:59.999Z', 'the last millisecond of the end date in Manila');
  const seats = await runSql(`select e.status, b.code from public.batch_entitlements e left join public.batches b on b.id = e.batch_id
    where e.source_import_row_id = '${newbie.rowId}'::uuid order by e.batch_index`);
  assert.equal(seats.length, 6, 'the plan’s run length from the live catalog');
  assert.equal(seats[0].code, '2034-05');
  const prof = (await runSql(`select approval_status, is_paid, plan, account_origin, onboarding_status, approved_by::text
    from public.profiles where id = '${newbie.uid}'::uuid`))[0];
  assert.deepEqual([prof.approval_status, prof.is_paid, prof.plan, prof.account_origin, prof.onboarding_status],
    ['approved', true, 'vip', 'import', 'invited']);
  assert.equal(prof.approved_by, sa.id);
  assert.equal(Number(await sqlScalar(`select count(*) from public.enrollment_requests where user_id = '${newbie.uid}'::uuid`)), 0,
    'no enrollment request is invented');
  const ev = await sqlScalar(`select count(*) from public.student_import_events where row_id = '${newbie.rowId}'::uuid and kind = 'activated'`);
  assert.equal(Number(ev), 1, 'the audit event is written with the grant');
});

test('an existing confirmed account is linked, keeps its origin, and gets a notification', async () => {
  const r9 = await rowByNumber(job.job_id, 9);
  const prof = (await runSql(`select account_origin, approval_status from public.profiles where id = '${existing.id}'::uuid`))[0];
  assert.equal(prof.account_origin, 'signup', 'a confirmed account is never forced back through a password setup');
  assert.equal(r9.activation_state, 'activated');
  const inv = await svc().rpc('legacy_import_begin_invite', { p_actor: sa.id, p_row_id: r9.id, p_resend: false });
  assert.equal(inv.data.kind, 'notify');
  const rec = await svc().rpc('legacy_import_record_delivery', { p_actor: sa.id, p_row_id: r9.id, p_generation: inv.data.generation, p_state: 'notified', p_code: null });
  assert.equal(rec.data, true);
});

test('an activation is never repeated', async () => {
  const again = await activateOne(runId, `lease${NONCE}x1`);
  assert.equal(again, null, 'nothing left to claim');
  const r2 = await rowByNumber(job.job_id, 2);
  await expectAppError(svc().rpc('legacy_import_activate_row', { p_actor: sa.id, p_row_id: r2.id, p_run_id: runId }),
    'LEGACY_ROW_NOT_READY');
  const uid = await sqlScalar(`select target_user_id::text from public.student_import_rows where id = '${r2.id}'::uuid`);
  assert.equal(Number(await sqlScalar(`select count(*) from public.subscriptions where user_id = '${uid}'::uuid`)), 1);
});

// ── The scheduled term ───────────────────────────────────────────────────────

test('a scheduled member has no access and cannot be given a second term beside it', async () => {
  const r3 = await rowByNumber(job.job_id, 3);
  const uid = await sqlScalar(`select target_user_id::text from public.student_import_rows where id = '${r3.id}'::uuid`);
  const db = await signInAs(uid, r3.email_normalized);
  const enrolled = await db.rpc('is_enrolled');
  assert.equal(enrolled.data, false, 'is_enrolled() is false before the start');
  let refused = null;
  try {
    await runSql(`insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at)
      values ('${uid}'::uuid, 'sampler', 'active', now(), now() + interval '60 days', now() + interval '63 days')`);
  } catch (e) { refused = String(e.message || e); }
  assert.ok(refused && /not started yet|MEMBERSHIP_SCHEDULED_CONFLICT|subscriptions_one_live_or_scheduled/.test(refused),
    `an approval beside a scheduled term must be refused, got: ${refused}`);

  // The start arrives: the member's own screen opens it.
  await runSql(`update public.subscriptions set started_at = now() - interval '1 minute' where user_id = '${uid}'::uuid and status = 'scheduled'`);
  const opened = await db.rpc('activate_my_due_membership');
  assert.equal(opened.error, null);
  assert.equal(opened.data.activated, 1);
  assert.equal((await db.rpc('is_enrolled')).data, true, 'and access follows at once');

  // After the end and the grace, access ends.
  await runSql(`update public.subscriptions set ends_at = now() - interval '5 days', grace_ends_at = now() - interval '2 days'
    where user_id = '${uid}'::uuid and status = 'active'`);
  assert.equal((await db.rpc('is_enrolled')).data, false, 'grace over, access over');
});

test('another member cannot open someone else’s scheduled term', async () => {
  const r2 = await rowByNumber(job.job_id, 2);
  await runSql(`update public.subscriptions s set started_at = now() - interval '1 minute'
    from public.student_import_rows r where r.id = '${r2.id}'::uuid and s.source_import_row_id = r.id`);
  const res = await student.db.rpc('activate_my_due_membership');
  assert.equal(res.data.activated, 0, 'the self-heal only ever touches the caller');
  const st = await sqlScalar(`select s.status from public.subscriptions s where s.source_import_row_id = '${r2.id}'::uuid`);
  assert.equal(st, 'scheduled');
});

// ── Refusals, reverts, the audit trail ───────────────────────────────────────

test('a profile rejected after staging blocks its activation and stays rejected', async () => {
  const late = await stage([row(20)], ['2034-05'], { tag: 'late-ban' });
  const [r] = await rowsOf(late.job_id);
  const c = await svc().auth.admin.createUser({ email: r.email_normalized, email_confirm: true });
  await runSql(`update public.profiles set approval_status = 'rejected' where id = '${c.data.user.id}'::uuid`);
  const run = await svc().rpc('legacy_import_start_run', { p_actor: sa.id, p_job_id: late.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}ban01` });
  const out = await activateOne(run.data.run_id, `lease${NONCE}b1`);
  assert.equal(out.outcome, 'blocked');
  assert.equal(out.reason, 'profile_rejected');
  assert.equal(await sqlScalar(`select approval_status from public.profiles where id = '${c.data.user.id}'::uuid`), 'rejected');
  assert.equal(Number(await sqlScalar(`select count(*) from public.subscriptions where user_id = '${c.data.user.id}'::uuid`)), 0);
});

test('a pending import account is hidden from Access Requests and cannot be decided there', async () => {
  const pend = await stage([row(30)], ['2034-05'], { tag: 'pending' });
  const [r] = await rowsOf(pend.job_id);
  const run = await svc().rpc('legacy_import_start_run', { p_actor: sa.id, p_job_id: pend.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}pen01` });
  await svc().rpc('legacy_import_claim_rows', { p_actor: sa.id, p_run_id: run.data.run_id, p_lease: `lease${NONCE}p1`, p_limit: 1, p_retry_failed: false, p_exclude: [] });
  const c = await svc().auth.admin.createUser({ email: r.email_normalized, email_confirm: false });
  await svc().rpc('legacy_import_bind_user', { p_actor: sa.id, p_row_id: r.id, p_run_id: run.data.run_id, p_user_id: c.data.user.id, p_created: true });
  const queue = await ops.db.rpc('admin_access_request_queue', { p_status: 'pending', p_limit: 1000 });
  assert.ok(!(queue.data || []).some((q) => q.id === c.data.user.id), 'a bound-but-unactivated import is not an ordinary signup');
  await expectAppError(ops.db.rpc('admin_review_access_request', { p_user_id: c.data.user.id, p_decision: 'rejected', p_reason: 'x' }),
    'ACCESS_REQUEST_IMPORT_TARGET');
});

test('the closed-start path gives a closed-batch purchase its seat, after an explicit promotion', async () => {
  const r5 = await rowByNumber(job.job_id, 5);
  const promoted = await sa.db.rpc('legacy_import_set_eligibility', { p_row_ids: [r5.id], p_eligible: true, p_reason: 'synthetic later activation' });
  assert.equal(promoted.data.changed, 1);
  const run = await svc().rpc('legacy_import_start_run', { p_actor: sa.id, p_job_id: job.job_id, p_row_ids: [r5.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}cls01` });
  const out = await activateOne(run.data.run_id, `lease${NONCE}c1`);
  assert.equal(out.outcome, 'activated');
  assert.equal(out.status, 'active', 'a start already passed opens at once, with its ORIGINAL dates');
  const first = await sqlScalar(`select b.code from public.batch_entitlements e join public.batches b on b.id = e.batch_id
    where e.source_import_row_id = '${r5.id}'::uuid and e.batch_index = 0`);
  assert.equal(first, '2034-07', 'the closed batch the student bought into');
  assert.equal(await sqlScalar(`select status from public.batches where code = '2034-07'`), 'closed', 'and the batch was not reopened');
});

test('a scheduled activation can be reverted; the account is kept', async () => {
  const r2 = await rowByNumber(job.job_id, 2);
  // Put r2 back in the future so it is scheduled again.
  await runSql(`update public.subscriptions s set started_at = now() + interval '30 days'
    from public.student_import_rows r where r.id = '${r2.id}'::uuid and s.source_import_row_id = r.id`);
  const res = await sa.db.rpc('legacy_import_revert', { p_row_id: r2.id, p_reason: 'synthetic revert check' });
  assert.equal(res.error, null, res.error && res.error.message);
  const uid = await sqlScalar(`select target_user_id::text from public.student_import_rows where id = '${r2.id}'::uuid`);
  assert.equal(await sqlScalar(`select status from public.subscriptions where source_import_row_id = '${r2.id}'::uuid`), 'cancelled');
  assert.equal(Number(await sqlScalar(`select count(*) from public.batch_entitlements where source_import_row_id = '${r2.id}'::uuid and status in ('queued','active')`)), 0);
  assert.equal(await sqlScalar(`select is_paid::text from public.profiles where id = '${uid}'::uuid`), 'false');
  assert.ok(await sqlScalar(`select id::text from auth.users where id = '${uid}'::uuid`), 'the Auth user is never deleted');
});

test('the audit trail cannot be edited or deleted, even by the table owner', async () => {
  const id = await sqlScalar(`select id::text from public.student_import_events where job_id = '${job.job_id}'::uuid limit 1`);
  let upd = null; let del = null;
  try { await runSql(`update public.student_import_events set kind = 'tampered' where id = '${id}'::uuid`); } catch (e) { upd = String(e.message || e); }
  try { await runSql(`delete from public.student_import_events where id = '${id}'::uuid`); } catch (e) { del = String(e.message || e); }
  assert.ok(upd && /append-only/.test(upd), `update must be refused: ${upd}`);
  assert.ok(del && /append-only/.test(del), `delete must be refused: ${del}`);
});

// ★ A row is `activating` from its claim until the grant commits or the endpoint marks it
//   failed, and the grant is ONE transaction — so a row still claimed after longer than any
//   request can live was granted nothing. Left alone it blocked Discard for ever, with
//   Resume (i.e. activating it) the only way out.
test('a claim abandoned by a dead request becomes failed, and can then be retried', async () => {
  const solo = await stage([row(40)], ['2034-05'], { tag: 'stale' });
  const [r] = await rowsOf(solo.job_id);
  const start = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: solo.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}stale1`,
  });
  assert.equal(start.error, null, start.error && start.error.message);
  const claimed = await svc().rpc('legacy_import_claim_rows', {
    p_actor: sa.id, p_run_id: start.data.run_id, p_lease: `L${NONCE}stale`, p_limit: 1, p_retry_failed: false, p_exclude: [],
  });
  assert.equal(claimed.data.length, 1);
  // The request dies here: no bind, no activation, no mark-failed. Age the claim past the window.
  await runSql(`update public.student_import_rows set activation_claimed_at = now() - interval '30 minutes'
    where id = '${r.id}'::uuid`);
  await expectAppError(sa.db.rpc('legacy_import_discard_job', { p_job_id: solo.job_id, p_reason: 'not yet — a claim is stale' }),
    'LEGACY_JOB_BUSY', 'a LEASED run still blocks a discard');
  const rel = await svc().rpc('legacy_import_release_run', {
    p_actor: sa.id, p_run_id: start.data.run_id, p_lease: `L${NONCE}stale`, p_pause: true,
  });
  assert.equal(rel.error, null, rel.error && rel.error.message);
  const [after] = await rowsOf(solo.job_id);
  assert.equal(after.activation_state, 'failed', 'the abandoned claim is a failure, not an activation in progress');
  // …and the run is FINISHED, not paused: it cannot retry that row itself (the attempt cap is
  // per run), so holding it would put it beyond the reach of every button.
  const st = await sqlScalar(`select status from public.student_import_activation_runs where id = '${start.data.run_id}'::uuid`);
  assert.equal(st, 'completed');
  assert.equal(Number(await sqlScalar(`select count(*) from public.subscriptions where source_import_row_id = '${r.id}'::uuid`)), 0,
    'and it granted nothing');

  // A NEW run re-queues it with fresh attempts — so neither an older run nor the per-run
  // attempt cap can leave a row no button in the workspace reaches.
  await runSql(`update public.student_import_rows set attempts = 5 where id = '${r.id}'::uuid`);
  const again = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: solo.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}stale2`,
  });
  assert.equal(again.error, null, again.error && again.error.message);
  const requeued = (await runSql(`select activation_state, attempts from public.student_import_rows where id = '${r.id}'::uuid`))[0];
  assert.equal(requeued.activation_state, 'ready');
  assert.equal(requeued.attempts, 0);
  const out = await activateOne(again.data.run_id, `L${NONCE}stale2`);
  assert.equal(out?.outcome, 'activated', 'the retry activates it');
  await sa.db.rpc('legacy_import_revert', { p_row_id: r.id, p_reason: 'synthetic stale-claim cleanup' });
});

// ★ A PRE-EXISTING account — a real student's own unconfirmed signup, an unaccepted staff
//   invitee — must be marked as an import only by a SUCCESSFUL activation. Marking it at bind
//   time, ahead of activate_row's refusals, left a refused account hidden from Access Requests
//   and undecidable there, with nothing in Student Imports able to release it.
test('a pre-existing unconfirmed account refused at activation keeps its own identity', async () => {
  const email = addr('walkin');
  const made = await svc().auth.admin.createUser({ email, email_confirm: false });
  const uid = made.data.user.id;
  await runSql(`update public.profiles set approval_status = 'pending', account_origin = 'signup',
    onboarding_status = 'not_started' where id = '${uid}'::uuid`);
  const solo = await stage([row(41, { email_normalized: email, email_display: email })], ['2034-05'], { tag: 'walkin' });
  const [r] = await rowsOf(solo.job_id);
  assert.equal(r.activation_state, 'ready', 'staging saw nothing wrong with them');
  // They buy a membership AFTER staging, so the refusal comes from activate_row — after the
  // bind step has already recorded the Auth user on the row.
  await runSql(`insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, grant_source)
    values ('${uid}'::uuid, 'vip', 'active', now() - interval '1 day', now() + interval '60 days', now() + interval '63 days', 'payment')`);
  const start = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: solo.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}walkin`,
  });
  assert.equal(start.error, null, start.error && start.error.message);
  const out = await activateOne(start.data.run_id, `L${NONCE}walkin`);
  assert.equal(out?.outcome, 'blocked');
  assert.equal(out.reason, 'membership_conflict');
  const p = (await runSql(`select account_origin, onboarding_status, approval_status from public.profiles where id = '${uid}'::uuid`))[0];
  assert.equal(p.account_origin, 'signup', 'a refused activation must not relabel a stranger as an import');
  assert.equal(p.onboarding_status, 'not_started', 'nor push them onto the set-password screen');
  assert.equal(p.approval_status, 'pending');
  // …so they are still an ordinary pending signup in Access Requests, and still decidable.
  const q = await sa.db.rpc('admin_access_request_queue', { p_status: 'pending', p_limit: 200 });
  assert.equal(q.error, null, q.error && q.error.message);
  assert.ok((q.data || []).some((x) => x.id === uid), 'the account stays visible to Access Requests');
});

// ★ OPEN ACCESS ON THE ACTIVATION DAY (owner decision, 2026-09-26). The Super Admin assigns
//   the terms at activation; a future roster start brought forward to today grants an
//   ACTIVE membership at once, with the paid end date untouched.
test('terms assigned at activation are the terms granted; a start of today opens access at once', async () => {
  const manilaToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const solo = await stage([row(50)], ['2034-05'], { tag: 'terms' });
  const [r] = await rowsOf(solo.job_id);
  // Only a Super Admin assigns terms, and nonsense is refused whole.
  await expectAppError(ops.db.rpc('legacy_import_set_terms', {
    p_row_ids: [r.id], p_plan_key: null, p_batch_id: null, p_start: manilaToday, p_end: null, p_reason: 'ops tries it',
  }), 'FORBIDDEN', 'an Operations Admin assigning terms');
  await expectAppError(sa.db.rpc('legacy_import_set_terms', {
    p_row_ids: [r.id], p_plan_key: null, p_batch_id: null, p_start: '2034-12-01', p_end: null, p_reason: 'end before start',
  }), 'LEGACY_TERMS_INVALID', 'a start after the end');
  const set = await sa.db.rpc('legacy_import_set_terms', {
    p_row_ids: [r.id], p_plan_key: null, p_batch_id: null, p_start: manilaToday, p_end: null,
    p_reason: 'Access opened on the activation day',
  });
  assert.equal(set.error, null, set.error && set.error.message);
  assert.equal(set.data.changed, 1);
  const kept = (await runSql(`select legacy_start_date::text as roster, activation_start_date::text as assigned
    from public.student_import_rows where id = '${r.id}'::uuid`))[0];
  assert.equal(kept.roster, '2034-05-10', 'the roster value is kept as the record of the purchase');
  assert.equal(kept.assigned, manilaToday);
  assert.ok(Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${r.id}'::uuid and kind = 'terms_set'`)) === 1, 'the assignment is audited');
  // The same assignment again changes nothing and records nothing (a retried dialog).
  const same = await sa.db.rpc('legacy_import_set_terms', {
    p_row_ids: [r.id], p_plan_key: null, p_batch_id: null, p_start: manilaToday, p_end: null, p_reason: 'retried dialog',
  });
  assert.equal(same.error, null, same.error && same.error.message);
  assert.equal(same.data.changed, 0);
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${r.id}'::uuid and kind = 'terms_set'`)), 1, 'no second audit entry for no change');

  // The preflight names exactly the ids the start will take.
  const pf = await svc().rpc('legacy_import_preflight', { p_actor: sa.id, p_job_id: solo.job_id, p_row_ids: [r.id] });
  assert.equal(pf.error, null, pf.error && pf.error.message);
  assert.deepEqual(pf.data.row_ids, [r.id]);

  const start = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: solo.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}terms1`,
  });
  assert.equal(start.error, null, start.error && start.error.message);
  // ★ Inside an unfinished run the row is spoken for: the preflight leaves it out (so a
  //   dialog never sends it into a whole-run refusal), and its terms are frozen under the
  //   typed confirmation that showed them.
  const held = await svc().rpc('legacy_import_preflight', { p_actor: sa.id, p_job_id: solo.job_id, p_row_ids: [r.id] });
  assert.deepEqual(held.data.row_ids, [], 'a held row is not offered again');
  assert.equal(held.data.excluded, 1);
  await expectAppError(sa.db.rpc('legacy_import_set_terms', {
    p_row_ids: [r.id], p_plan_key: null, p_batch_id: null, p_start: null, p_end: '2034-12-01', p_reason: 'under a confirmation',
  }), 'LEGACY_RUN_BUSY', 'changing terms inside an unfinished run');
  const out = await activateOne(start.data.run_id, `L${NONCE}terms`);
  assert.equal(out.outcome, 'activated');
  assert.equal(out.status, 'active', 'no longer scheduled: access opens on the activation day');
  const sub = (await runSql(`select status, (started_at <= now()) as started, to_char(ends_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as ends
    from public.subscriptions where source_import_row_id = '${r.id}'::uuid`))[0];
  assert.equal(sub.status, 'active');
  assert.equal(sub.started, true);
  assert.equal(sub.ends, '2034-11-10', 'the paid end date did not move');
  assert.equal(await sqlScalar(`select public.user_is_enrolled('${out.uid}'::uuid)::text`), 'true', 'access is real, now');
  // An activated row's terms are frozen here; they change in Enrollments.
  const late = await sa.db.rpc('legacy_import_set_terms', {
    p_row_ids: [r.id], p_plan_key: null, p_batch_id: null, p_start: null, p_end: '2034-12-01', p_reason: 'too late now',
  });
  assert.equal(late.data?.changed, 0);

  // ── The student's own account setup ──
  const email = (await runSql(`select email from auth.users where id = '${out.uid}'::uuid`))[0].email;
  const me = await signInAs(out.uid, email);
  const done = await me.rpc('complete_import_onboarding', { p_full_name: '  Synthetic   Renamed  Student ' });
  assert.equal(done.error, null, done.error && done.error.message);
  const prof = (await runSql(`select full_name, onboarding_status from public.profiles where id = '${out.uid}'::uuid`))[0];
  assert.equal(prof.full_name, 'Synthetic Renamed Student', 'the name is taken, whitespace tidied');
  assert.equal(prof.onboarding_status, 'completed');
  const again = await me.rpc('complete_import_onboarding', { p_full_name: 'Someone Else' });
  assert.equal(again.error, null);
  assert.equal(await sqlScalar(`select full_name from public.profiles where id = '${out.uid}'::uuid`), 'Synthetic Renamed Student',
    'after onboarding the name is changed through support, not this call');

  const summary = await me.rpc('my_migration_summary');
  assert.equal(summary.error, null, summary.error && summary.error.message);
  assert.equal(summary.data.status, 'active');
  assert.equal(summary.data.email, email);
  assert.equal(summary.data.batch_code, '2034-05');

  // ── The two onboarding emails ring once, and only the server records them ──
  // ★ Service-only: a student calling it directly — to record 'sent' so the admin is never
  //   told, or to loop failures into the audit trail — is refused outright.
  const direct = await me.rpc('legacy_import_onboarding_notice', { p_user: out.uid, p_result: 'sent' });
  assert.ok(direct.error, 'a student cannot call the notice at all');
  const direct2 = await me.rpc('legacy_import_onboarding_notice', { p_user: out.uid });
  assert.ok(direct2.error, 'not even to reserve it');
  const first = await svc().rpc('legacy_import_onboarding_notice', { p_user: out.uid });
  assert.equal(first.error, null, first.error && first.error.message);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.row_id, r.id);
  assert.equal(first.data.email, email, 'the facts are the account\'s own');
  const dup = await svc().rpc('legacy_import_onboarding_notice', { p_user: out.uid });
  assert.equal(dup.data.skip, 'in_progress', 'a second request while one is sending sends nothing');
  const rec = await svc().rpc('legacy_import_onboarding_notice', { p_user: out.uid, p_result: 'sent' });
  assert.equal(rec.error, null);
  const after = await svc().rpc('legacy_import_onboarding_notice', { p_user: out.uid });
  assert.equal(after.data.skip, 'sent', "'sent' is final");
  const reset = await svc().rpc('legacy_import_onboarding_notice', { p_user: out.uid, p_result: 'failed' });
  assert.equal(reset.error, null);
  assert.equal(await sqlScalar(`select onboarding_notice_state from public.student_import_rows where id = '${r.id}'::uuid`), 'sent',
    'a sent notice never goes back to failed, so the admin inbox rings once');
  assert.equal(Number(await sqlScalar(`select onboarding_notice_attempts from public.student_import_rows where id = '${r.id}'::uuid`)), 1,
    'one reservation was spent');
  // Nobody else's uid reaches this row.
  const other = await svc().rpc('legacy_import_onboarding_notice', { p_user: student.id });
  assert.equal(other.data?.skip, 'not_migrated');
  const otherSummary = await student.db.rpc('my_migration_summary');
  assert.notEqual(otherSummary.data?.email, email, 'the summary is the caller\'s own');

  // (Not reverted: an onboarded membership is changed in Enrollments, by design.)
});

test('a shared phone is a warning, never a block and never a link', async () => {
  const phoneJob = await stage([
    row(60, { phone: '+63 917 000 1234' }),
    row(61, { phone: '63917-000-1234' }),
  ], ['2034-05'], { tag: 'phone' });
  const got = await runSql(`select source_row_number, legacy_phone, activation_state, warnings
    from public.student_import_rows where job_id = '${phoneJob.job_id}'::uuid order by source_row_number`);
  assert.equal(got[0].legacy_phone, '639170001234');
  for (const g of got) {
    assert.ok(g.warnings.includes('phone_shared'), 'two emails, one phone: flagged');
    assert.equal(g.activation_state, 'ready', 'and still ready — a phone never blocks');
  }
  await sa.db.rpc('legacy_import_discard_job', { p_job_id: phoneJob.job_id, p_reason: 'synthetic phone cleanup' });
});

test('purging removes names and addresses from activated rows and keeps their provenance', async () => {
  const res = await sa.db.rpc('legacy_import_purge_raw', { p_job_id: job.job_id });
  assert.equal(res.error, null, res.error && res.error.message);
  const r3 = (await runSql(`select mapped, email_normalized, legacy_record_key, legacy_start_date::text, legacy_amount_paid::text
    from public.student_import_rows where job_id = '${job.job_id}'::uuid and source_row_number = 3`))[0];
  assert.deepEqual(r3.mapped, {});
  assert.equal(r3.email_normalized, null);
  assert.match(r3.legacy_record_key, /^[0-9a-f]{64}$/);
  assert.equal(r3.legacy_start_date, '2034-05-10');
  assert.equal(r3.legacy_amount_paid, '15999.00');
  const inactive = (await runSql(`select email_normalized from public.student_import_rows where job_id = '${job.job_id}'::uuid and source_row_number = 4`))[0];
  assert.ok(inactive.email_normalized, 'an inactive row keeps its data — it may still be activated');
});
