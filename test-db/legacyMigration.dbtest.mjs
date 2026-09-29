// ─────────────────────────────────────────────────────────────────────────────
// test-db/legacyMigration.dbtest.mjs — the legacy student migration, end to end (#67, #68).
// ─────────────────────────────────────────────────────────────────────────────
// Drives the REAL functions the endpoint calls (service role, with p_actor) and the
// REAL Super Admin RPCs (a signed-in persona through PostgREST), then asserts on what
// the database holds. Synthetic people only (@shadow.test), far-future synthetic
// batches (2034-05 … 2034-12; 2033-01/02/03 for the gap test and an archived 2032-11 for the
// higher-plan test, each removed again by the test that makes it), and a per-run
// nonce in every address, so a re-run never collides with an earlier one and never
// touches another suite's fixtures.
//
// ★ #68: A MISSING MONTH UNDER A LATER BATCH REFUSES A RUN (LEGACY_BATCH_GAP), and "later"
//   is GLOBAL — any batch another suite or the e2e left behind (2035-04/05, 2099-01) counts.
//   So `before()` creates EVERY month this suite's seat runs cover (2034-05 … 2034-12), and
//   the gap test uses months below all of them and removes its own batches again.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import {
  asUser, expectAppError, lit, makeBatch, makePersona, runSql, seedStaff, serviceClient, sqlScalar,
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

async function stage(rows, eligible, { tag = 'main', eligiblePlans = null, planMapping = { vip: 'vip' } } = {}) {
  const content = createHash('sha256').update(`${NONCE}:${tag}:${JSON.stringify(rows)}`).digest('hex');
  const p_job = { filename: `synthetic-${tag}.csv`, content_sha256: content, date_format: 'M/D/YYYY',
    plan_mapping: planMapping, batch_mapping: {}, eligible_batch_codes: eligible };
  // #68: the non-VIP plans ticked Ready. Omitted, the job stores '{}' — what every #67
  // caller (and the reopen test below) implicitly sends.
  if (eligiblePlans) p_job.eligible_plan_keys = eligiblePlans;
  const { data, error } = await svc().rpc('legacy_import_stage', {
    p_actor: sa.id,
    p_job,
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
  // ★ #68: every later month a six-seat run from 2034-05/06/07 covers, so no run here crosses
  //   a month with no batch (see the header) — which would refuse it with LEGACY_BATCH_GAP.
  for (const [code, name] of [['2034-08', 'August 2034'], ['2034-09', 'September 2034'], ['2034-10', 'October 2034'],
    ['2034-11', 'November 2034'], ['2034-12', 'December 2034']]) {
    await makeBatch(code, { name, status: 'open' });
  }
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
    row(60, { phone: '+63 917 000 1234', external_user_id: `thk-phone-${NONCE}` }),
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

  // ★ #68 (E9): a discarded job's phones and Thinkific ids are personal data too, and go
  //   with its names and addresses when it is purged.
  const purged = await sa.db.rpc('legacy_import_purge_raw', { p_job_id: phoneJob.job_id });
  assert.equal(purged.error, null, purged.error && purged.error.message);
  assert.equal(purged.data.purged_rows, 2);
  const left = await runSql(`select legacy_phone, external_user_id, email_normalized, legacy_record_key
    from public.student_import_rows where job_id = '${phoneJob.job_id}'::uuid order by source_row_number`);
  for (const l of left) {
    assert.deepEqual([l.legacy_phone, l.external_user_id, l.email_normalized], [null, null, null]);
    assert.match(l.legacy_record_key, /^[0-9a-f]{64}$/, 'provenance stays');
  }
  assert.equal(await sqlScalar(`select (purged_at is not null)::text from public.student_import_jobs
    where id = '${phoneJob.job_id}'::uuid`), 'true', 'nothing personal is left, so the job is marked purged');
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

// ══ #68: Silver, Essentials and mixed rosters; seats; gaps; the higher plan; recovery ══════

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Every column the #68 assertions read, one row per staged row. */
const detail = async (jobId) => runSql(`select id::text, source_row_number, email_normalized, validation_status,
    activation_state, errors, warnings, proposed_batch_id::text as batch_id, legacy_batch_label, legacy_record_key, last_error
  from public.student_import_rows where job_id = '${jobId}'::uuid order by source_row_number`);

/** A plan's access_days, read from the live catalog so a term can be sized to match it. */
const accessDays = async (key) => Number(await sqlScalar(`select access_days from public.enrollment_plans where key = ${lit(key)}`));

/**
 * A Silver or Essentials roster row, exactly as the library sends one: NO batch code (a
 * batch is a VIP-only fact); a label, when the export has one, travels as history only.
 * The term started three days ago and lasts the plan's own access_days, so it opens at once
 * and draws no term_length_unusual warning.
 */
function selfPacedRow(n, tag, plan, days, over = {}) {
  const email = addr(tag);
  return row(n, {
    email_normalized: email, email_display: email, plan_key: plan,
    legacy_plan_label: plan === 'sampler' ? 'Essentials' : 'Silver',
    batch_code: null, legacy_batch_label: null,
    start_date: iso(TODAY - 3 * DAY), end_date: iso(TODAY + (days - 4) * DAY),
    amount_paid: plan === 'sampler' ? 1499 : 2999,
    ...over,
  });
}

/** A run over `ids` with the exact phrase; returns its id. */
async function startRun(jobId, ids, key) {
  const res = await svc().rpc('legacy_import_start_run', {
    p_actor: sa.id, p_job_id: jobId, p_row_ids: ids, p_phrase: `ACTIVATE ${ids.length}`, p_client_key: `k${NONCE}${key}`,
  });
  assert.equal(res.error, null, res.error && res.error.message);
  return res.data.run_id;
}

const preflight = async (jobId, ids) => {
  const res = await svc().rpc('legacy_import_preflight', { p_actor: sa.id, p_job_id: jobId, p_row_ids: ids });
  assert.equal(res.error, null, res.error && res.error.message);
  return res.data;
};

/**
 * Remove batches no membership references — this suite's own fixtures — with the cohort
 * space, categories and channels batches_create_spaces() made for each. Children first, in
 * one statement, so a refusal leaves nothing half-deleted.
 */
async function dropBatches(codes) {
  const list = codes.map(lit).join(', ');
  const spaces = `select sp.id from public.community_spaces sp join public.batches b on b.id = sp.batch_id where b.code in (${list})`;
  await runSql(`do $drop$ begin
    delete from public.community_channels where space_id in (${spaces});
    delete from public.community_channel_categories where space_id in (${spaces});
    delete from public.community_spaces where id in (${spaces});
    delete from public.batches where code in (${list});
  end $drop$`);
}

/** An Essentials student migrated, activated and through their own account setup. */
async function onboardedMigrant(n, tag) {
  const j = await stage([selfPacedRow(n, tag, 'sampler', await accessDays('sampler'))], [],
    { tag, eligiblePlans: ['sampler'] });
  const [r] = await detail(j.job_id);
  assert.equal(r.activation_state, 'ready', `${tag}: ${JSON.stringify(r.errors)}`);
  const run = await startRun(j.job_id, [r.id], tag);
  const out = await activateOne(run, `L${NONCE}${tag}`);
  assert.equal(out?.outcome, 'activated', `${tag}: ${JSON.stringify(out)}`);
  const me = await signInAs(out.uid, addr(tag));
  const done = await me.rpc('complete_import_onboarding', { p_full_name: `Synthetic ${tag}` });
  assert.equal(done.error, null, done.error && done.error.message);
  return { jobId: j.job_id, rowId: r.id, runId: run, uid: out.uid };
}

test('#68: an Essentials and a Silver roster stage with no batch, are Ready by plan, and activate with no cohort seat', async () => {
  const [essDays, silDays] = [await accessDays('sampler'), await accessDays('silver_self_paced')];
  const j = await stage([
    selfPacedRow(101, 'ess1', 'sampler', essDays),
    selfPacedRow(102, 'sil1', 'silver_self_paced', silDays),
    // A batch label in a non-VIP export is kept as history and named — never checked.
    selfPacedRow(103, 'ess2', 'sampler', essDays, { legacy_batch_label: 'May 2034' }),
    // A term four months longer than the plan sells may be a misread date: named, still Ready.
    selfPacedRow(104, 'ess3', 'sampler', essDays + 120),
  ], [], { tag: 'self-paced', eligiblePlans: ['sampler', 'silver_self_paced'] });
  const got = await detail(j.job_id);
  for (const r of got) {
    assert.equal(r.validation_status, 'valid', `row ${r.source_row_number}: ${JSON.stringify(r.errors)}`);
    assert.equal(r.activation_state, 'ready', 'Ready by its plan: there is no cohort to tick');
    assert.equal(r.batch_id, null, 'a non-VIP row stores no batch');
  }
  const [e1, s1, e2, e3] = got;
  assert.equal(e1.legacy_record_key, sha(`thinkific|email:${addr('ess1')}|sampler|none`),
    "keyed on the literal 'none' — never NULL, which no duplicate check can see");
  assert.equal(s1.legacy_record_key, sha(`thinkific|email:${addr('sil1')}|silver_self_paced|none`));
  assert.ok(e2.warnings.includes('batch_ignored_for_plan'));
  assert.equal(e2.legacy_batch_label, 'May 2034', 'the label is kept as the record of the export');
  assert.ok(!e1.warnings.includes('batch_ignored_for_plan'));
  assert.ok(e3.warnings.includes('term_length_unusual'));
  assert.ok(!e1.warnings.includes('term_length_unusual'), "a term the plan's own length is not unusual");

  const summary = await sa.db.rpc('legacy_import_job_summary', { p_job_id: j.job_id });
  assert.equal(summary.error, null, summary.error && summary.error.message);
  assert.deepEqual(summary.data.job.eligible_plan_keys, ['sampler', 'silver_self_paced']);
  assert.deepEqual(summary.data.cohorts.map((c) => [c.batch_code, c.total, c.ready]), [[null, 4, 4]],
    'grouped under no batch');

  const pf = await preflight(j.job_id, [e1.id, s1.id]);
  assert.equal(pf.to_activate, 2);
  assert.deepEqual(pf.cohorts, [], 'no cohort seat is previewed for a self-paced plan');
  assert.deepEqual(pf.batch_gaps, []);
  assert.equal(pf.emails, 2, 'one claim email per new account');
  assert.equal(pf.grandfathered, 0);
  for (const t of pf.terms) {
    assert.deepEqual([t.seats, t.plan_segment, t.batch_id], [0, 'general', null], t.plan_key);
  }
  assert.deepEqual(pf.terms.map((t) => t.plan_name).sort(), ['Essentials', 'Silver · Self-Paced'], 'package titles');

  const run = await startRun(j.job_id, [e1.id, s1.id], 'self1');
  const out = [await activateOne(run, `L${NONCE}self1`), await activateOne(run, `L${NONCE}self1`)];
  for (const o of out) {
    assert.equal(o?.outcome, 'activated', JSON.stringify(o));
    assert.equal(o.status, 'active', 'a start already passed opens at once');
    assert.equal(Number(await sqlScalar(`select count(*) from public.batch_entitlements
      where source_import_row_id = '${o.rowId}'::uuid`)), 0, 'and takes no cohort seat');
  }
  const subs = await runSql(`select r.source_row_number, s.plan_key, (s.batch_id is null) as no_batch, s.status,
      s.user_id::text as uid, p.plan as profile_plan
    from public.subscriptions s join public.student_import_rows r on r.id = s.source_import_row_id
    join public.profiles p on p.id = s.user_id
   where r.job_id = '${j.job_id}'::uuid order by r.source_row_number`);
  assert.deepEqual(subs.map((s) => [s.source_row_number, s.plan_key, s.no_batch, s.status, s.profile_plan]),
    [[101, 'sampler', true, 'active', 'sampler'], [102, 'silver_self_paced', true, 'active', 'silver_self_paced']]);

  // ★ Scoped access: an Essentials (sampler) student reads the QuickBooks Essentials course
  //   and nothing else; a Silver student reads everything. RLS decides, not the import.
  //   Published AS the Super Admin: #48's courses_publish_insert_guard refuses a published
  //   course when auth.uid() is null, which it always is through the Management API.
  const slug = (s) => `${s}-lm-${NONCE}`;
  await asUser(sa.id, `insert into public.courses (slug, title, published, access_tier) values
    (${lit(slug('qbo-ess'))}, 'LM Essentials (test)', true, 'essentials'),
    (${lit(slug('qbo-mastery'))}, 'LM Mastery (test)', true, 'standard'),
    (${lit(slug('resume-course'))}, 'LM Resume (test)', true, 'standard');`);
  try {
    const seen = async (uid, email) => {
      const db = await signInAs(uid, email);
      assert.equal((await db.rpc('is_enrolled')).data, true, 'the import term is live');
      const { data, error } = await db.from('courses').select('slug').like('slug', `%-lm-${NONCE}`);
      assert.equal(error, null, error && error.message);
      return data.map((c) => c.slug).sort();
    };
    assert.deepEqual(await seen(subs[0].uid, addr('ess1')), [slug('qbo-ess')],
      'Essentials opens the QuickBooks Essentials course only');
    assert.deepEqual(await seen(subs[1].uid, addr('sil1')), [slug('qbo-ess'), slug('qbo-mastery'), slug('resume-course')].sort(),
      'Silver is full access');
  } finally {
    await runSql(`delete from public.courses where slug like '%-lm-${NONCE}'`);
  }
});

test('#68: a mixed roster — VIP by cohort, Silver and Essentials by plan — and every read follows the plan', async () => {
  const [essDays, silDays] = [await accessDays('sampler'), await accessDays('silver_self_paced')];
  const dupe = addr('mixdup');
  const rows = [
    row(111, { email_normalized: addr('mixvip'), email_display: addr('mixvip') }),
    selfPacedRow(112, 'mixsil', 'silver_self_paced', silDays),
    selfPacedRow(113, 'mixess', 'sampler', essDays),
    row(114, { email_normalized: dupe, email_display: dupe }),     // one person, VIP…
    selfPacedRow(115, 'mixdup', 'sampler', essDays),                // …and Essentials, in one file
  ];
  const planMapping = { VIP: 'vip', Silver: 'silver_self_paced', Essentials: 'sampler' };
  const j = await stage(rows, ['2034-05'], { tag: 'mixed', eligiblePlans: ['silver_self_paced'], planMapping });
  const got = await detail(j.job_id);
  const by = Object.fromEntries(got.map((r) => [r.source_row_number, r]));
  assert.deepEqual(got.map((r) => [r.source_row_number, r.activation_state]),
    [[111, 'ready'], [112, 'ready'], [113, 'inactive'], [114, 'blocked'], [115, 'blocked']],
    'VIP Ready by its ticked cohort, Silver by its ticked plan, Essentials left inactive');
  assert.ok(by[111].batch_id, 'the VIP row keeps its cohort');
  for (const n of [114, 115]) {
    assert.ok(by[n].errors.includes('duplicate_in_file') && by[n].errors.includes('multiple_plans_in_file'),
      `row ${n}: ${JSON.stringify(by[n].errors)} — never merged, and the two plans are named`);
  }

  // The plan list is a setting: the same file with another list must not reopen this job.
  const again = await svc().rpc('legacy_import_stage', {
    p_actor: sa.id,
    p_job: { filename: 'mixed-again.csv', content_sha256: j.content, date_format: 'M/D/YYYY', plan_mapping: planMapping,
      batch_mapping: {}, eligible_batch_codes: ['2034-05'], eligible_plan_keys: ['silver_self_paced', 'sampler'] },
    p_rows: rows,
  });
  assert.equal(again.error?.hint, 'LEGACY_JOB_SETTINGS_DIFFER');
  assert.deepEqual(JSON.parse(again.error.details).context.differs, ['eligible_plan_keys']);

  // The Package filter, the package title, and no batch for a non-VIP row.
  const page = await sa.db.rpc('legacy_import_rows_page', { p_job_id: j.job_id, p_plan_key: 'sampler' });
  assert.equal(page.error, null, page.error && page.error.message);
  assert.deepEqual(page.data.rows.map((r) => [r.source_row_number, r.plan_key, r.plan_name, r.batch_code]),
    [[113, 'sampler', 'Essentials', null], [115, 'sampler', 'Essentials', null]]);
  const all = await sa.db.rpc('legacy_import_rows_page', { p_job_id: j.job_id });
  const at = (n) => all.data.rows.find((r) => r.source_row_number === n);
  assert.deepEqual([at(111).plan_name, at(111).batch_code], ['VIP Package', '2034-05']);
  assert.deepEqual([at(112).plan_name, at(112).batch_code], ['Silver · Self-Paced', null]);

  // "Select all inactive in this view", and a batch view that no non-VIP row is in.
  const inactiveEss = await sa.db.rpc('legacy_import_ready_ids', { p_job_id: j.job_id, p_state: 'inactive', p_plan_key: 'sampler' });
  assert.equal(inactiveEss.error, null, inactiveEss.error && inactiveEss.error.message);
  assert.deepEqual(inactiveEss.data, [by[113].id]);
  const inBatch = await sa.db.rpc('legacy_import_ready_ids', { p_job_id: j.job_id, p_batch_code: '2034-05', p_state: 'ready' });
  assert.deepEqual(inBatch.data, [by[111].id], 'a Silver row is in no batch view');
  await expectAppError(sa.db.rpc('legacy_import_ready_ids', { p_job_id: j.job_id, p_state: 'blocked' }),
    'LEGACY_STAGE_INVALID', 'only ready, failed or inactive rows are selectable');

  // Promotion: a missing batch is not "archived" for a non-VIP row, and every skip is named.
  const prom = await sa.db.rpc('legacy_import_set_eligibility', {
    p_row_ids: [by[113].id, by[112].id, by[114].id], p_eligible: true, p_reason: 'synthetic mixed promotion',
  });
  assert.equal(prom.error, null, prom.error && prom.error.message);
  assert.equal(prom.data.changed, 1, 'the Essentials row is promoted');
  assert.deepEqual(prom.data.skipped_reasons, { not_valid: 1, term_ended: 0, batch_archived: 0, wrong_state: 1 });

  const pf = await preflight(j.job_id, [by[111].id, by[112].id, by[113].id]);
  const terms = Object.fromEntries(pf.terms.map((t) => [t.plan_key, [t.seats, t.plan_segment, t.batch_code]]));
  assert.deepEqual(terms, { vip: [6, 'vip', '2034-05'], silver_self_paced: [0, 'general', null], sampler: [0, 'general', null] });
  assert.deepEqual(pf.cohorts.map((c) => [c.code, c.plan_key, c.rows, c.seats]), [['2034-05', 'vip', 1, 6]],
    'cohorts are VIP rows only');
  assert.deepEqual(pf.batch_gaps, []);
  await sa.db.rpc('legacy_import_discard_job', { p_job_id: j.job_id, p_reason: 'synthetic mixed cleanup' });
});

test('#68 (E4): a blocked row does not reserve its purchase; a valid one still does', async () => {
  const email = addr('e4');
  const bad = await stage([row(201, { email_normalized: email, email_display: email, payment_status: 'refunded' })],
    ['2034-05'], { tag: 'e4-bad' });
  const [b] = await detail(bad.job_id);
  assert.equal(b.activation_state, 'blocked');
  assert.match(b.legacy_record_key, /^[0-9a-f]{64}$/, 'a blocked row still carries the key');
  const good = await stage([row(202, { email_normalized: email, email_display: email })], ['2034-05'], { tag: 'e4-good' });
  const [g] = await detail(good.job_id);
  assert.equal(g.legacy_record_key, b.legacy_record_key, 'the same purchase');
  assert.deepEqual([g.validation_status, g.activation_state], ['valid', 'ready'], 'the refunded copy does not hold it');
  const third = await stage([row(203, { email_normalized: email, email_display: email })], ['2034-05'], { tag: 'e4-third' });
  const [t] = await detail(third.job_id);
  assert.ok(t.errors.includes('duplicate_staged'), 'a valid row in a live job still holds the purchase');
  for (const x of [bad, good, third]) {
    await sa.db.rpc('legacy_import_discard_job', { p_job_id: x.job_id, p_reason: 'synthetic E4 cleanup' });
  }
});

test('#68: a grandfathered paid member is blocked at staging, counted by the preflight, and refused at activation', async () => {
  const days = await accessDays('sampler');
  const early = await makePersona(`lm-grand-${NONCE}`, { fullName: 'LM Grandfathered' });
  const late = await makePersona(`lm-grand2-${NONCE}`, { fullName: 'LM Grandfathered Later' });
  // Paid, and no subscription row at all: unlimited access through is_enrolled()'s no-rows branch.
  await runSql(`update public.profiles set is_paid = true where id = '${early.id}'::uuid`);
  const j = await stage([
    selfPacedRow(121, 'g1', 'sampler', days, { email_normalized: early.email, email_display: early.email }),
    selfPacedRow(122, 'g2', 'sampler', days, { email_normalized: late.email, email_display: late.email }),
  ], [], { tag: 'grandfathered', eligiblePlans: ['sampler'] });
  const [g1, g2] = await detail(j.job_id);
  assert.equal(g1.activation_state, 'blocked');
  assert.ok(g1.errors.includes('grandfathered_member'), 'never converted automatically');
  assert.equal(g2.activation_state, 'ready');

  // The second one becomes grandfathered after staging (is_paid flipped by hand).
  await runSql(`update public.profiles set is_paid = true where id = '${late.id}'::uuid`);
  assert.equal((await preflight(j.job_id, [g2.id])).grandfathered, 1, 'the confirm step counts it');
  const run = await startRun(j.job_id, [g2.id], 'grand1');
  const out = await activateOne(run, `L${NONCE}grand1`);
  assert.equal(out?.outcome, 'blocked');
  assert.equal(out.reason, 'grandfathered_member');
  assert.equal(Number(await sqlScalar(`select count(*) from public.subscriptions where user_id = '${late.id}'::uuid`)), 0,
    'no dated term replaced the unlimited one — which a revert could never bring back');
  assert.equal(await sqlScalar(`select is_paid::text from public.profiles where id = '${late.id}'::uuid`), 'true');
});

test('#68: the higher plan wins — a lower row is held while a higher one is unactivated, and goes through once resolved', async () => {
  const both = addr('both');
  const hi = await stage([row(131, { email_normalized: both, email_display: both })], ['2034-05'], { tag: 'hp-vip' });
  const lo = await stage([selfPacedRow(132, 'both', 'sampler', await accessDays('sampler'))], [],
    { tag: 'hp-ess', eligiblePlans: ['sampler'] });
  const [h] = await detail(hi.job_id);
  const [l] = await detail(lo.job_id);
  assert.deepEqual([h.activation_state, l.activation_state], ['ready', 'ready']);
  assert.ok(l.warnings.includes('other_legacy_row'), 'staging names the other roster');

  const pf = await preflight(lo.job_id, [l.id]);
  assert.equal(pf.overlaps.total, 1);
  assert.deepEqual(pf.overlaps.by_plan, [{ plan_key: 'vip', plan_name: 'VIP Package', state: 'ready', rows: 1 }]);
  assert.deepEqual(pf.held_row_ids, [l.id], 'the confirm step names the row the claim will hold (#68 review, S1)');

  const run = await startRun(lo.job_id, [l.id], 'hp1');
  // p_retry_failed: even a claim that retries failures must not take the held row back.
  const claimed = await svc().rpc('legacy_import_claim_rows', {
    p_actor: sa.id, p_run_id: run, p_lease: `L${NONCE}hp1`, p_limit: 5, p_retry_failed: true, p_exclude: [],
  });
  assert.equal(claimed.error, null, claimed.error && claimed.error.message);
  assert.deepEqual(claimed.data, [], 'the cheaper plan is never activated ahead of the dearer one');
  const [held] = await detail(lo.job_id);
  assert.deepEqual([held.activation_state, held.last_error], ['failed', 'higher_plan_pending']);
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${l.id}'::uuid and kind = 'activation_blocked' and status = 'higher_plan_pending'`)), 1, 'and it is logged');
  assert.equal(Number(await sqlScalar(`select count(*) from auth.users where lower(email) = ${lit(both)}`)), 0,
    'no account was created for it');
  const rel = await svc().rpc('legacy_import_release_run', { p_actor: sa.id, p_run_id: run, p_lease: `L${NONCE}hp1`, p_pause: false });
  assert.equal(rel.error, null, rel.error && rel.error.message);

  // Resolved: the VIP roster is discarded. A NEW run re-queues the held row, and nothing outranks it now.
  await sa.db.rpc('legacy_import_discard_job', { p_job_id: hi.job_id, p_reason: 'synthetic: the VIP roster was a mistake' });
  const run2 = await startRun(lo.job_id, [l.id], 'hp2');
  const out = await activateOne(run2, `L${NONCE}hp2`);
  assert.equal(out?.outcome, 'activated', JSON.stringify(out));
  assert.equal(await sqlScalar(`select plan_key from public.subscriptions where source_import_row_id = '${l.id}'::uuid`), 'sampler');
});

test('#68 review (S1): only a higher row that can still become a grant holds the lower one', async () => {
  const who = addr('s1');
  const hi = await stage([row(311, { email_normalized: who, email_display: who })], ['2034-05'], { tag: 's1-vip' });
  const lo = await stage([selfPacedRow(312, 's1', 'sampler', await accessDays('sampler'))], [],
    { tag: 's1-ess', eligiblePlans: ['sampler'] });
  const [h] = await detail(hi.job_id);
  const [l] = await detail(lo.job_id);
  assert.deepEqual([h.activation_state, l.activation_state], ['ready', 'ready']);
  const held = async () => (await preflight(lo.job_id, [l.id])).held_row_ids;
  const setHi = (sets) => runSql(`update public.student_import_rows set ${sets} where id = '${h.id}'::uuid`);
  assert.deepEqual(await held(), [l.id], 'a VIP purchase still to activate holds the Essentials one');

  // Its cohort is archived — terms assigned at activation can point it there — so it can
  // never be granted, and it holds nothing. (A month below every other fixture, removed again.)
  await dropBatches(['2032-11']);
  const archived = await makeBatch('2032-11', { name: 'November 2032', status: 'archived' });
  try {
    await setHi(`activation_batch_id = '${archived}'::uuid`);
    assert.deepEqual(await held(), [], 'an archived cohort is never granted');
    await setHi('activation_batch_id = null');
    assert.deepEqual(await held(), [l.id], 'back on a live cohort, it holds again');
  } finally {
    await setHi('activation_batch_id = null');
    await dropBatches(['2032-11']);
  }

  // Its grace has passed — its effective term, not the roster's — so it can never be granted either.
  await setHi(`activation_start_date = '2025-01-01', activation_end_date = '2025-06-30'`);
  assert.deepEqual(await held(), [], 'a term whose grace has passed is never granted');

  // …and the claim reads the same rule: the Essentials purchase goes through.
  const run = await startRun(lo.job_id, [l.id], 's1');
  const out = await activateOne(run, `L${NONCE}s1`);
  assert.equal(out?.outcome, 'activated', `not held behind a row that can never activate: ${JSON.stringify(out)}`);
  assert.equal(await sqlScalar(`select plan_key from public.subscriptions where source_import_row_id = '${l.id}'::uuid`), 'sampler');
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${l.id}'::uuid and status = 'higher_plan_pending'`)), 0, 'and it was never held');
  await sa.db.rpc('legacy_import_discard_job', { p_job_id: hi.job_id, p_reason: 'synthetic S1 cleanup' });
});

test('#68 review (L1): a copy with no plan is a duplicate, never "under different plans"', async () => {
  const one = addr('l1a');
  const two = addr('l1b');
  const unmapped = (n, email) => row(n, {
    email_normalized: email, email_display: email, plan_key: null, legacy_plan_label: 'VIP Oct promo',
    errors: ['plan_unmapped'],
  });
  // One mapped copy and one the owner left unmapped: the preview says "duplicate", so must the rows.
  const a = await stage([row(321, { email_normalized: one, email_display: one }), unmapped(322, one)],
    ['2034-05'], { tag: 'l1-a' });
  for (const r of await detail(a.job_id)) {
    assert.ok(r.errors.includes('duplicate_in_file'), `row ${r.source_row_number}: ${JSON.stringify(r.errors)}`);
    assert.ok(!r.errors.includes('multiple_plans_in_file'),
      `row ${r.source_row_number}: an unmapped copy is not a different plan — ${JSON.stringify(r.errors)}`);
  }
  // Two DIFFERENT mapped plans beside it: every copy is named, the unmapped one too — as the library does.
  const b = await stage([
    row(323, { email_normalized: two, email_display: two }),
    row(324, { email_normalized: two, email_display: two, plan_key: 'sampler', legacy_plan_label: 'Essentials',
      batch_code: null, legacy_batch_label: null }),
    unmapped(325, two),
  ], ['2034-05'], { tag: 'l1-b', planMapping: { VIP: 'vip', Essentials: 'sampler' } });
  for (const r of await detail(b.job_id)) {
    assert.ok(r.errors.includes('multiple_plans_in_file'), `row ${r.source_row_number}: ${JSON.stringify(r.errors)}`);
  }
  for (const x of [a, b]) await sa.db.rpc('legacy_import_discard_job', { p_job_id: x.job_id, p_reason: 'synthetic L1 cleanup' });
});

test('#68: a cohort month with no batch under a later batch is named, and refuses the start until it exists', async () => {
  // ★ Months below every other batch this suite or the e2e uses, so they can be neither a
  //   gap for, nor a "later batch" to, anybody else — and they are removed again at the end.
  const CODES = ['2033-01', '2033-02', '2033-03'];
  await dropBatches(CODES);                         // a previous run's leftovers, if any
  await makeBatch('2033-01', { name: 'January 2033' });
  await makeBatch('2033-03', { name: 'March 2033' });
  try {
    const email = addr('gap');
    const j = await stage([row(141, {
      email_normalized: email, email_display: email, batch_code: '2033-01', legacy_batch_label: 'January 2033',
      start_date: '2033-01-05', end_date: '2033-04-04',
    })], ['2033-01'], { tag: 'gap' });
    const [r] = await detail(j.job_id);
    assert.equal(r.activation_state, 'ready', JSON.stringify(r.errors));
    const pf = await preflight(j.job_id, [r.id]);
    assert.equal(pf.terms[0].seats, 3, 'three paid months, three cohort seats');
    assert.deepEqual(pf.batch_gaps, ['2033-02'], 'the preflight names the month the run would skip for good');

    const refused = await expectAppError(svc().rpc('legacy_import_start_run', {
      p_actor: sa.id, p_job_id: j.job_id, p_row_ids: [r.id], p_phrase: 'ACTIVATE 1', p_client_key: `k${NONCE}gap01`,
    }), 'LEGACY_BATCH_GAP', 'a run across a missing month');
    assert.deepEqual(JSON.parse(refused.details).context.missing, ['2033-02']);
    assert.equal(Number(await sqlScalar(`select count(*) from public.student_import_activation_runs
      where job_id = '${j.job_id}'::uuid`)), 0, 'refused before anything is written');

    await makeBatch('2033-02', { name: 'February 2033' });
    assert.deepEqual((await preflight(j.job_id, [r.id])).batch_gaps, []);
    await startRun(j.job_id, [r.id], 'gap02');
    await sa.db.rpc('legacy_import_discard_job', { p_job_id: j.job_id, p_reason: 'synthetic gap cleanup' });
  } finally {
    await dropBatches(CODES);
  }
});

test('#68: a VIP student who paid for one month holds one cohort seat, not six', async () => {
  const email = addr('onemonth');
  const j = await stage([row(151, { email_normalized: email, email_display: email, start_date: '2034-05-10', end_date: '2034-06-09' })],
    ['2034-05'], { tag: 'one-month' });
  const [r] = await detail(j.job_id);
  assert.equal(r.activation_state, 'ready');
  assert.ok(r.warnings.includes('term_length_unusual'), 'a month against a 180-day plan is named — and still Ready');
  const pf = await preflight(j.job_id, [r.id]);
  assert.equal(pf.terms[0].seats, 1);
  assert.equal(pf.cohorts[0].seats, 1);
  const run = await startRun(j.job_id, [r.id], 'one1');
  const out = await activateOne(run, `L${NONCE}one1`);
  assert.equal(out?.outcome, 'activated', JSON.stringify(out));
  const seats = await runSql(`select b.code, e.run_length from public.batch_entitlements e
    left join public.batches b on b.id = e.batch_id where e.source_import_row_id = '${r.id}'::uuid order by e.batch_index`);
  assert.deepEqual(seats.map((s) => [s.code, s.run_length]), [['2034-05', 1]]);
});

test('#68 (E6): revert removes the Thinkific-id link it made, so the corrected row can activate', async () => {
  const ext = `thk-${NONCE}`;
  const wrong = addr('extwrong');
  const right = addr('extright');
  const links = async () => Number(await sqlScalar(`select count(*) from public.student_external_accounts
    where source = 'thinkific' and external_user_id = ${lit(ext)}`));
  const j1 = await stage([row(161, { external_user_id: ext, email_normalized: wrong, email_display: wrong })], ['2034-05'],
    { tag: 'ext1' });
  const [r1] = await detail(j1.job_id);
  const out1 = await activateOne(await startRun(j1.job_id, [r1.id], 'ext1'), `L${NONCE}ext1`);
  assert.equal(out1?.outcome, 'activated', JSON.stringify(out1));
  assert.equal(await links(), 1);

  const rev = await sa.db.rpc('legacy_import_revert', { p_row_id: r1.id, p_reason: 'synthetic: the roster had the wrong email' });
  assert.equal(rev.error, null, rev.error && rev.error.message);
  assert.equal(await links(), 0, 'the link goes with the activation that made it');
  const ev = (await runSql(`select detail from public.student_import_events
    where row_id = '${r1.id}'::uuid and kind = 'activation_reverted'`))[0];
  assert.equal(ev.detail.external_links_removed, 1, 'and the audit trail says so');

  // The corrected roster: the same Thinkific id, the right email.
  const j2 = await stage([row(162, { external_user_id: ext, email_normalized: right, email_display: right })], ['2034-05'],
    { tag: 'ext2' });
  const [r2] = await detail(j2.job_id);
  assert.equal(r2.activation_state, 'ready', 'a reverted row no longer holds the purchase');
  const out2 = await activateOne(await startRun(j2.job_id, [r2.id], 'ext2'), `L${NONCE}ext2`);
  assert.equal(out2?.outcome, 'activated', `not refused external_id_conflict: ${JSON.stringify(out2)}`);
  assert.equal(await sqlScalar(`select user_id::text from public.student_external_accounts where external_user_id = ${lit(ext)}`),
    out2.uid);
});

test('#68 (E7): a row refused at activation releases the account the import created for it', async () => {
  const j = await stage([selfPacedRow(171, 'released', 'sampler', await accessDays('sampler'))], [],
    { tag: 'released', eligiblePlans: ['sampler'] });
  const [r] = await detail(j.job_id);
  const run = await startRun(j.job_id, [r.id], 'rel1');
  const claimed = await svc().rpc('legacy_import_claim_rows', {
    p_actor: sa.id, p_run_id: run, p_lease: `L${NONCE}rel1`, p_limit: 1, p_retry_failed: false, p_exclude: [],
  });
  assert.equal(claimed.data?.length, 1);
  const made = await svc().auth.admin.createUser({ email: addr('released'), email_confirm: false,
    app_metadata: { legacy_import_row_id: r.id } });
  assert.equal(made.error, null, made.error && made.error.message);
  const uid = made.data.user.id;
  const bind = await svc().rpc('legacy_import_bind_user', { p_actor: sa.id, p_row_id: r.id, p_run_id: run, p_user_id: uid, p_created: true });
  assert.equal(bind.error, null, bind.error && bind.error.message);
  const marked = (await runSql(`select account_origin, onboarding_status, approval_status, (invited_at is not null) as invited
    from public.profiles where id = '${uid}'::uuid`))[0];
  assert.deepEqual([marked.account_origin, marked.onboarding_status, marked.approval_status, marked.invited],
    ['import', 'invited', 'pending', true], 'the bind step marks the account it created');

  // Between the bind and the grant the person buys a membership of their own.
  await runSql(`insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, grant_source)
    values ('${uid}'::uuid, 'vip', 'active', now() - interval '1 day', now() + interval '60 days', now() + interval '63 days', 'payment')`);
  const act = await svc().rpc('legacy_import_activate_row', { p_actor: sa.id, p_row_id: r.id, p_run_id: run });
  assert.equal(act.error, null, act.error && act.error.message);
  assert.deepEqual([act.data.outcome, act.data.reason], ['blocked', 'membership_conflict']);
  const released = (await runSql(`select account_origin, onboarding_status, approval_status, invited_at
    from public.profiles where id = '${uid}'::uuid`))[0];
  assert.deepEqual([released.account_origin, released.onboarding_status, released.invited_at], ['signup', 'none', null],
    'back to the #26 defaults every ordinary signup carries');
  assert.equal(released.approval_status, 'pending', 'still undecided: nothing was approved');
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${r.id}'::uuid and kind = 'import_marks_cleared'`)), 1);
  const q = await sa.db.rpc('admin_access_request_queue', { p_status: 'pending', p_limit: 500 });
  assert.equal(q.error, null, q.error && q.error.message);
  assert.ok((q.data || []).some((x) => x.id === uid), 'Access Requests can see and decide it again');
});

test('#68: invitations — an onboarded account gets the sign-in notice, a proven refusal hands back, a dead one is recorded', async () => {
  const m = await onboardedMigrant(181, 'invites');
  const inv = await svc().rpc('legacy_import_begin_invite', { p_actor: sa.id, p_row_id: m.rowId, p_resend: false });
  assert.equal(inv.error, null, inv.error && inv.error.message);
  assert.equal(inv.data.kind, 'notify', 'a student who already set a password gets the sign-in notice — #67 raised here');
  assert.equal(inv.data.plan_name, 'Essentials');
  assert.equal(inv.data.batch_name, null, 'a non-VIP plan names no batch');
  const state = async () => (await runSql(`select invite_state, invite_code from public.student_import_rows
    where id = '${m.rowId}'::uuid`))[0];

  // Only a code that proves nothing was delivered may hand the row back.
  await expectAppError(svc().rpc('legacy_import_record_delivery', {
    p_actor: sa.id, p_row_id: m.rowId, p_generation: inv.data.generation, p_state: 'not_sent', p_code: 'resend_422',
  }), 'LEGACY_STAGE_INVALID', 'a 422 proves nothing');
  const back = await svc().rpc('legacy_import_record_delivery', {
    p_actor: sa.id, p_row_id: m.rowId, p_generation: inv.data.generation, p_state: 'not_sent', p_code: 'resend_403',
  });
  assert.equal(back.data, true);
  assert.deepEqual(await state(), { invite_state: 'not_sent', invite_code: 'resend_403' });
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${m.rowId}'::uuid and kind = 'invite_handed_back'`)), 1);
  // Pass 2 finds it again — except in the request that has just tried it.
  const pending = (exclude) => svc().rpc('legacy_import_pending_invites', { p_actor: sa.id, p_run_id: m.runId, p_limit: 20, p_exclude: exclude });
  assert.deepEqual((await pending([])).data, [m.rowId]);
  assert.deepEqual((await pending([m.rowId])).data, []);

  // ★ #68 review (S4): which hand-backs spend a generation. A 401/403/429 reached the provider,
  //   which may replay a refusal to the same idempotency key, so the next attempt takes a NEW
  //   one; a hand-back whose request never left this server keeps its generation, so it no
  //   longer eats into the cap of twenty.
  const begin = async (resend = false) => {
    const r = await svc().rpc('legacy_import_begin_invite', { p_actor: sa.id, p_row_id: m.rowId, p_resend: resend });
    assert.equal(r.error, null, r.error && r.error.message);
    return r.data;
  };
  const handBack = async (generation, code) => {
    const r = await svc().rpc('legacy_import_record_delivery', {
      p_actor: sa.id, p_row_id: m.rowId, p_generation: generation, p_state: 'not_sent', p_code: code,
    });
    assert.equal(r.error, null, r.error && r.error.message);
    assert.equal(r.data, true, `${code} is recorded by the attempt holding generation ${generation}`);
  };
  const storedGen = async () => Number(await sqlScalar(`select invite_generation from public.student_import_rows
    where id = '${m.rowId}'::uuid`));
  let current = (await begin()).generation;
  assert.equal(current, inv.data.generation + 1, 'after a 403 the provider saw: a new generation');
  for (const code of ['link_failed', 'app_url_missing', 'email_not_configured', 'email_from_not_configured']) {
    await handBack(current, code);
    const next = await begin();
    assert.equal(next.generation, current, `${code}: nothing reached the provider, so the same generation`);
    assert.equal(await storedGen(), current);
  }
  const started = await runSql(`select (detail->>'generation')::int as generation, (detail->>'reused')::boolean as reused
    from public.student_import_events where row_id = '${m.rowId}'::uuid and kind = 'invite_started'
    order by created_at, id`);
  assert.deepEqual(started.slice(-5).map((e) => [e.generation, e.reused]),
    [[current, false], [current, true], [current, true], [current, true], [current, true]], 'each reuse is audited');
  await handBack(current, 'resend_429');
  current = (await begin()).generation;
  assert.equal(current, started.at(-1).generation + 1, 'a 429 reached the provider: a new generation');
  await handBack(current, 'resend_403');

  // At the cap, a hand-back that never reached the provider still goes out — under generation 20,
  // automatically or by a person's Resend…
  await runSql(`update public.student_import_rows set invite_generation = 20, invite_state = 'not_sent',
    invite_code = 'link_failed' where id = '${m.rowId}'::uuid`);
  const atCap = await begin();
  assert.deepEqual([atCap.ok, atCap.skip, atCap.generation], [true, false, 20], 'a reused generation adds nothing to the cap');
  await handBack(20, 'email_not_configured');
  assert.equal((await begin(true)).generation, 20, "a person's Resend too");
  await handBack(20, 'resend_429');

  // …but once the provider has seen generation 20 there is no twenty-first: recorded as failed
  // on the automatic path, never raised.
  const capped = await svc().rpc('legacy_import_begin_invite', { p_actor: sa.id, p_row_id: m.rowId, p_resend: false });
  assert.equal(capped.error, null, capped.error && capped.error.message);
  assert.deepEqual([capped.data.ok, capped.data.skip, capped.data.code], [false, true, 'invite_cap']);
  assert.deepEqual(await state(), { invite_state: 'failed', invite_code: 'invite_cap' });
  assert.deepEqual((await pending([])).data, [], 'so pass 2 stops picking it');
  // …while a person's Resend still gets the refusal.
  await expectAppError(svc().rpc('legacy_import_begin_invite', { p_actor: sa.id, p_row_id: m.rowId, p_resend: true }),
    'LEGACY_ROW_NOT_READY');
});

test('#68: an onboarding notice refused by the provider keeps its tries, under a ceiling nothing resets', async () => {
  const m = await onboardedMigrant(191, 'notice');
  const notice = async () => (await runSql(`select onboarding_notice_state as state, onboarding_notice_attempts as n,
      onboarding_notice_reservations as r
    from public.student_import_rows where id = '${m.rowId}'::uuid`))[0];
  const now = async () => { const x = await notice(); return [x.state, Number(x.n), Number(x.r)]; };
  const setRow = (sets) => runSql(`update public.student_import_rows set ${sets} where id = '${m.rowId}'::uuid`);
  const reserve = () => svc().rpc('legacy_import_onboarding_notice', { p_user: m.uid });
  const record = (result, code) => svc().rpc('legacy_import_onboarding_notice', { p_user: m.uid, p_result: result, p_code: code });
  const failedEvents = async () => runSql(`select detail from public.student_import_events
    where row_id = '${m.rowId}'::uuid and kind = 'onboarding_notice_failed' order by created_at, id`);

  assert.deepEqual(await now(), [null, 0, 0], 'a new notice has spent nothing');
  assert.equal((await reserve()).data?.ok, true);
  assert.deepEqual(await now(), ['sending', 1, 1], 'a reservation counts against both');
  assert.equal((await record('failed', 'resend_403')).error, null);
  assert.deepEqual(await now(), ['failed', 0, 1],
    'a refused sender says nothing about this student: the try is refunded — the reservation is not');
  let ev = await failedEvents();
  assert.deepEqual([ev[0].detail.code, ev[0].detail.refunded], ['resend_403', true]);

  // ★ #68 review (S2/V2): a 422 can be about ONE recipient — the failure that repeats for ever —
  //   so it uses up a try, as in #67.
  assert.equal((await reserve()).data?.ok, true);
  assert.equal((await record('failed', 'resend_422')).error, null);
  assert.deepEqual(await now(), ['failed', 1, 2], 'a 422 is not refunded');
  ev = await failedEvents();
  assert.deepEqual([ev[1].detail.code, ev[1].detail.refunded], ['resend_422', false]);

  assert.equal((await reserve()).data?.ok, true);
  assert.equal((await record('failed', 'resend_500')).error, null);
  assert.deepEqual(await now(), ['failed', 2, 3], 'an unclear failure still counts');

  await setRow('onboarding_notice_attempts = 5');
  assert.equal((await reserve()).data?.skip, 'exhausted');

  // The reset: service-only, a Super Admin's only, audited — and it reopens the TRIES only.
  const direct = await sa.db.rpc('legacy_import_reset_onboarding_notice', { p_actor: sa.id, p_row_id: m.rowId });
  assert.ok(direct.error, 'not callable with a user JWT');
  await expectAppError(svc().rpc('legacy_import_reset_onboarding_notice', { p_actor: ops.id, p_row_id: m.rowId }),
    'FORBIDDEN', 'an Operations Admin passed as p_actor');
  const reset = await svc().rpc('legacy_import_reset_onboarding_notice', { p_actor: sa.id, p_row_id: m.rowId });
  assert.equal(reset.error, null, reset.error && reset.error.message);
  assert.deepEqual(reset.data, { ok: true });
  assert.deepEqual(await now(), [null, 0, 3], 'the tries are reopened; the reservations stand');
  const audit = (await runSql(`select detail from public.student_import_events
    where row_id = '${m.rowId}'::uuid and kind = 'onboarding_notice_reset'`))[0];
  assert.deepEqual([Number(audit.detail.previous_attempts), Number(audit.detail.reservations)], [5, 3]);

  // ★ THE CEILING. Twenty reservations, however many were refunded, and the notice is done:
  //   the reserve answers exhausted with tries to spare, and the reset refuses rather than
  //   "reset" it into the same answer.
  await setRow('onboarding_notice_reservations = 20');
  assert.equal((await reserve()).data?.skip, 'exhausted', 'twenty reservations, with no try spent');
  assert.deepEqual(await now(), [null, 0, 20], 'and nothing was reserved');
  const page = await sa.db.rpc('legacy_import_rows_page', { p_job_id: m.jobId });
  assert.equal(page.error, null, page.error && page.error.message);
  assert.equal(page.data.rows.find((r) => r.id === m.rowId)?.onboarding_notice_reservations, 20,
    'the panel can see the ceiling');
  const resets = async () => Number(await sqlScalar(`select count(*) from public.student_import_events
    where row_id = '${m.rowId}'::uuid and kind = 'onboarding_notice_reset'`));
  const before = await resets();
  const refused = await expectAppError(svc().rpc('legacy_import_reset_onboarding_notice', { p_actor: sa.id, p_row_id: m.rowId }),
    'LEGACY_ROW_NOT_READY', 'no reset lowers the ceiling');
  assert.equal(Number(JSON.parse(refused.details).context.reservations), 20);
  assert.equal(await resets(), before, 'refused before any write');
  await assert.rejects(setRow('onboarding_notice_reservations = 21'), /student_import_rows_notice_reservations/,
    'the table holds the ceiling too');

  // Below it, the notice goes, and a sent notice is final.
  await setRow('onboarding_notice_reservations = 19');
  assert.equal((await reserve()).data?.ok, true, 'the twentieth reservation is allowed');
  assert.deepEqual(await now(), ['sending', 1, 20]);
  assert.equal((await record('sent', null)).error, null);
  await expectAppError(svc().rpc('legacy_import_reset_onboarding_notice', { p_actor: sa.id, p_row_id: m.rowId }),
    'LEGACY_ROW_NOT_READY', 'a sent notice is final: the two emails ring once');
  // A student who has not finished their own setup has nothing to reset.
  const r3 = await rowByNumber(job.job_id, 3);
  await expectAppError(svc().rpc('legacy_import_reset_onboarding_notice', { p_actor: sa.id, p_row_id: r3.id }),
    'LEGACY_ROW_NOT_READY');
});
