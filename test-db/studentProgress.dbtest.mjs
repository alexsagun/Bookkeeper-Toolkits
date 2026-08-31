// Real PostgREST/RLS coverage for student progress and rankings (#52).
// Run with: npm run test:db (requires a disposable .env.test shadow project).
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  expectDenied,
  makeBatch,
  makePersona,
  resetShadow,
  runSql,
  seedMember,
  sqlScalar,
} from './_harness.mjs';

let sampler; let silver; let vipA; let vipB; let expired; let hidden;
let superAdmin; let operationsAdmin; let trainer; let unrelated;

const monthCode = (offset = 0) => {
  const date = new Date();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + offset);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function seedCatalog() {
  const rows = await runSql(`
    with
    qbo_e as (
      insert into public.courses (slug, title, published, access_tier, position)
      values ('qbo-essentials-test', 'QBO Essentials', true, 'essentials', 1) returning id
    ), qbo_e_m as (
      insert into public.course_modules (course_id, title, position)
      select id, 'Essentials', 1 from qbo_e returning id, course_id
    ), qbo_e_l as (
      insert into public.course_lessons (module_id, course_id, title, position)
      select id, course_id, 'Essential lesson', 1 from qbo_e_m returning id
    ),
    qbo_p as (
      insert into public.courses (slug, title, published, access_tier, position)
      values ('qbo-mastery-test', 'QBO Mastery', true, 'standard', 2) returning id
    ), qbo_p_m as (
      insert into public.course_modules (course_id, title, position)
      select id, 'Mastery', 1 from qbo_p returning id, course_id
    ), qbo_p_l as (
      insert into public.course_lessons (module_id, course_id, title, position)
      select id, course_id, 'Premium QBO lesson', 1 from qbo_p_m returning id
    ),
    resume as (
      insert into public.courses (slug, title, published, access_tier, position)
      values ('resume-strategy-test', 'Resume Strategy', true, 'standard', 3) returning id
    ), resume_m as (
      insert into public.course_modules (course_id, title, position)
      select id, 'Resume', 1 from resume returning id, course_id
    ), resume_l as (
      insert into public.course_lessons (module_id, course_id, title, position)
      select id, course_id, 'Resume lesson', 1 from resume_m returning id
    ),
    interview as (
      insert into public.courses (slug, title, published, access_tier, position)
      values ('interview-readiness-test', 'Interview Readiness', true, 'standard', 4) returning id
    ), interview_m as (
      insert into public.course_modules (course_id, title, position)
      select id, 'Interview', 1 from interview returning id, course_id
    ), interview_l as (
      insert into public.course_lessons (module_id, course_id, title, position)
      select id, course_id, 'Interview lesson', 1 from interview_m returning id
    )
    select (select id::text from qbo_e_l) essential_lesson,
           (select id::text from qbo_p_l) premium_lesson,
           (select id::text from resume_l) resume_lesson,
           (select id::text from interview_l) interview_lesson,
           (select id::text from qbo_p) premium_course`);
  return rows[0];
}

async function seedStaff(persona, role) {
  await runSql(`
    insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at)
    values ('${persona.id}'::uuid, '${role}', 'active', now(), now())
    on conflict (user_id) do update
      set role_key = excluded.role_key, status = 'active', activated_at = now(), updated_at = now()`);
}

async function rpcDenied(promise, label) {
  const { error } = await promise;
  assert.ok(error, `${label}: expected an error`);
  assert.match(`${error.code || ''} ${error.message || ''}`, /42501|permission denied|outside your plan|unavailable/i, label);
}

before(async () => {
  [sampler, silver, vipA, vipB, expired, hidden, superAdmin, operationsAdmin, trainer, unrelated] = await Promise.all([
    makePersona('progress-sampler', { fullName: 'Sara Sampler' }),
    makePersona('progress-silver', { fullName: 'Silvia Silver' }),
    makePersona('progress-vip-a', { fullName: 'Victor Alpha' }),
    makePersona('progress-vip-b', { fullName: 'Violet Beta' }),
    makePersona('progress-expired', { fullName: 'Erin Expired' }),
    makePersona('progress-hidden', { fullName: 'Helen Hidden' }),
    makePersona('progress-super', { fullName: 'Alex Super' }),
    makePersona('progress-ops', { fullName: 'Omar Operations' }),
    makePersona('progress-trainer', { fullName: 'Tara Trainer' }),
    makePersona('progress-unrelated', { fullName: 'Una Related' }),
  ]);
  await seedStaff(superAdmin, 'super_admin');
  await seedStaff(operationsAdmin, 'operations_admin');
  await seedStaff(trainer, 'trainer');
});

beforeEach(async () => { await resetShadow(); });
after(async () => { await resetShadow(); });

test('Sampler is normalized only against published Essentials QBO content', async () => {
  const catalog = await seedCatalog();
  await seedMember(sampler, { planKey: 'sampler', days: 60 });

  let result = await sampler.db.rpc('my_student_progress');
  assert.equal(result.error, null);
  assert.equal(result.data.tracks.qbo.total, 1);
  assert.equal(result.data.tracks.foundation.total, 0);
  assert.equal(result.data.tracks.profile.total, 0);
  assert.equal(result.data.tracks.interview.total, 0);

  result = await sampler.db.rpc('complete_course_lesson', { p_lesson_id: catalog.essential_lesson });
  assert.equal(result.error, null);
  const done = await sampler.db.rpc('my_student_progress');
  assert.equal(Number(done.data.overall_score), 100, 'the one available track is reweighted to 100%');

  await rpcDenied(
    sampler.db.rpc('complete_course_lesson', { p_lesson_id: catalog.premium_lesson }),
    'Sampler premium completion',
  );
  await rpcDenied(
    sampler.db.rpc('set_foundation_milestone', { p_milestone_key: 'accounting-101-module-01', p_completed: true }),
    'Sampler foundation completion',
  );
});

test('direct progress writes cannot bypass the validated lesson RPC', async () => {
  const catalog = await seedCatalog();
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  const courseId = await sqlScalar(`select course_id::text from public.course_lessons where id = '${catalog.premium_lesson}'::uuid`);
  await runSql(`
    insert into public.feature_guides (feature_key, title, video_url, video_provider, is_active)
    values ('mock_interview_simulator', 'Mock guide', 'https://example.test/guide.mp4', 'mp4', true)
    on conflict (feature_key) do update set video_url = excluded.video_url, video_path = null,
      video_provider = excluded.video_provider, is_active = true`);

  await expectDenied(
    silver.db.from('lesson_progress').insert({
      user_id: silver.id, lesson_id: catalog.premium_lesson, course_id: courseId,
    }).select(),
    'direct lesson_progress insert',
  );
  await rpcDenied(
    silver.db.rpc('complete_course_lesson', { p_lesson_id: '00000000-0000-0000-0000-000000000000' }),
    'unknown lesson',
  );
  await expectDenied(silver.db.from('feature_video_completions').insert({
    user_id: silver.id, feature_key: 'mock_interview_simulator',
    video_version: 'forged-version', completed: true,
  }).select(), 'direct guide completion');
  const guide = await silver.db.rpc('complete_progress_feature_guide', { p_feature_key: 'mock_interview_simulator' });
  assert.equal(guide.error, null);
  assert.equal(await sqlScalar(`select video_version from public.feature_video_completions where user_id = '${silver.id}'::uuid`), 'https://example.test/guide.mp4');
});

test('hidden learners disappear publicly but remain in authorized staff reports', async () => {
  const catalog = await seedCatalog();
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  await seedMember(hidden, { planKey: 'silver_self_paced', days: 60 });
  await silver.db.rpc('complete_course_lesson', { p_lesson_id: catalog.essential_lesson });
  await hidden.db.rpc('complete_course_lesson', { p_lesson_id: catalog.premium_lesson });
  await hidden.db.rpc('set_leaderboard_visibility', { p_visible: false });

  const board = await silver.db.rpc('student_leaderboard', {
    p_scope: 'my_plan', p_batch_id: null, p_window: 'overall', p_limit: 100, p_offset: 0,
  });
  assert.equal(board.error, null);
  assert.ok(board.data.some((row) => row.learner_label === 'Silvia S.'));
  assert.ok(!board.data.some((row) => row.learner_label === 'Helen H.'));
  const safeKeys = [
    'rank', 'learner_label', 'initials', 'overall_score', 'completed_milestones',
    'total_milestones', 'weekly_gain', 'foundation_score', 'qbo_score',
    'profile_score', 'interview_score', 'is_current_user', 'total_count',
  ].sort();
  assert.deepEqual(Object.keys(board.data[0]).sort(), safeKeys);

  const report = await operationsAdmin.db.rpc('admin_student_progress_report', {
    p_plan_key: null, p_batch_id: null, p_track: null, p_completion_min: null,
    p_completion_max: null, p_inactive_days: null, p_include_inactive: false,
    p_limit: 100, p_offset: 0,
  });
  assert.equal(report.error, null);
  const hiddenRow = report.data.find((row) => row.user_id === hidden.id);
  assert.ok(hiddenRow, 'Operations Admin sees the operational record');
  assert.equal(hiddenRow.public_visible, false);

  await rpcDenied(trainer.db.rpc('admin_student_progress_report', {
    p_plan_key: null, p_batch_id: null, p_track: null, p_completion_min: null,
    p_completion_max: null, p_inactive_days: null, p_include_inactive: false,
    p_limit: 100, p_offset: 0,
  }), 'Trainer private report');
});

test('VIP batch scope is derived from the entitlement ledger and rejects another batch id', async () => {
  await seedCatalog();
  const ownCode = monthCode(0); const otherCode = monthCode(1);
  const ownBatch = await makeBatch(ownCode);
  const otherBatch = await makeBatch(otherCode);
  await seedMember(vipA, { planKey: 'vip', days: 180, startBatchCode: ownCode, seats: 1 });
  await seedMember(vipB, { planKey: 'vip', days: 180, startBatchCode: otherCode, seats: 1 });

  const mine = await vipA.db.rpc('my_student_progress');
  assert.equal(mine.error, null);
  assert.equal(mine.data.batch_id, ownBatch);
  assert.equal(mine.data.default_scope, 'my_batch');

  const ownBoard = await vipA.db.rpc('student_leaderboard', {
    p_scope: 'my_batch', p_batch_id: ownBatch, p_window: 'overall', p_limit: 25, p_offset: 0,
  });
  assert.equal(ownBoard.error, null);
  await rpcDenied(vipA.db.rpc('student_leaderboard', {
    p_scope: 'my_batch', p_batch_id: otherBatch, p_window: 'overall', p_limit: 25, p_offset: 0,
  }), 'foreign VIP batch');
});

test('expired learners are excluded publicly while their snapshot can remain private to staff', async () => {
  await seedCatalog();
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  await seedMember(expired, { planKey: 'silver_self_paced', expired: true });
  await runSql(`
    insert into public.student_progress_daily
      (user_id, snapshot_date, overall_score, completed_milestones, total_milestones, plan_scope)
    values ('${expired.id}'::uuid, current_date - 1, 50, 5, 10, 'silver_self_paced')`);

  const board = await silver.db.rpc('student_leaderboard', {
    p_scope: 'all', p_batch_id: null, p_window: 'overall', p_limit: 100, p_offset: 0,
  });
  assert.equal(board.error, null);
  assert.ok(!board.data.some((row) => row.learner_label === 'Erin E.'));
  await rpcDenied(expired.db.rpc('my_student_progress'), 'expired private current report');

  const report = await superAdmin.db.rpc('admin_student_progress_report', {
    p_plan_key: null, p_batch_id: null, p_track: null, p_completion_min: null,
    p_completion_max: null, p_inactive_days: null, p_include_inactive: true,
    p_limit: 100, p_offset: 0,
  });
  assert.equal(report.error, null);
  assert.equal(report.data.find((row) => row.user_id === expired.id)?.access_status, 'inactive');
});

test('daily snapshots are retry-safe, preserve old denominators and enforce retention', async () => {
  const catalog = await seedCatalog();
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  await silver.db.rpc('complete_course_lesson', { p_lesson_id: catalog.essential_lesson });

  await runSql(`select public.student_progress_snapshot(current_date - 1)`);
  await runSql(`select public.student_progress_snapshot(current_date - 1)`);
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_progress_daily where user_id = '${silver.id}'::uuid and snapshot_date = current_date - 1`)), 1);
  assert.equal(Number(await sqlScalar(`select track_counts->'qbo'->>'total' from public.student_progress_daily where user_id = '${silver.id}'::uuid and snapshot_date = current_date - 1`)), 2);

  await runSql(`update public.courses set published = false where id = '${catalog.premium_course}'::uuid`);
  const live = await silver.db.rpc('my_student_progress');
  assert.equal(live.error, null);
  assert.equal(live.data.tracks.qbo.total, 1, 'current denominator follows publication state');
  assert.equal(Number(await sqlScalar(`select track_counts->'qbo'->>'total' from public.student_progress_daily where user_id = '${silver.id}'::uuid and snapshot_date = current_date - 1`)), 2, 'history is not rewritten');

  await runSql(`select public.student_progress_snapshot(current_date - 401)`);
  await runSql(`select public.student_progress_snapshot(current_date)`);
  assert.equal(Number(await sqlScalar(`select count(*) from public.student_progress_daily where snapshot_date < current_date - 400`)), 0);
});

test('needs-attention aggregates are server-calculated and permission-gated', async () => {
  await seedCatalog();
  await seedMember(unrelated, { planKey: 'silver_self_paced', days: 60 });
  await runSql(`update public.subscriptions set started_at = now() - interval '20 days' where user_id = '${unrelated.id}'::uuid`);

  const report = await operationsAdmin.db.rpc('admin_student_progress_report', {
    p_plan_key: null, p_batch_id: null, p_track: null, p_completion_min: null,
    p_completion_max: null, p_inactive_days: null, p_include_inactive: false,
    p_limit: 100, p_offset: 0,
  });
  assert.equal(report.error, null);
  const row = report.data.find((item) => item.user_id === unrelated.id);
  assert.equal(row.needs_attention, true);
  assert.equal(Number(row.needs_attention_count), 1);
  assert.equal(Number(row.total_count), 1);
});

// ★ THE PROMOTED STUDENT. Every other staff persona here is seeded with seedStaff()
//   and NO subscription, so they are excluded incidentally by the population's
//   "has a term" check rather than by any staff rule — which is exactly why the
//   missing staff exclusion survived review. Promotion does not cancel a
//   subscription (no staff migration touches subscriptions), so this is the real
//   shape: an Operations Admin who is still, on paper, a paying Silver member.
test('a promoted staff member is scored by nobody, but can still read a board', async () => {
  const catalog = await seedCatalog();
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  await silver.db.rpc('complete_course_lesson', { p_lesson_id: catalog.essential_lesson });

  // Omar keeps a live Silver term AND holds an active Operations Admin role.
  await seedMember(operationsAdmin, { planKey: 'silver_self_paced', days: 60 });
  await seedStaff(operationsAdmin, 'operations_admin');

  for (const scope of ['general', 'all']) {
    const board = await silver.db.rpc('student_leaderboard', {
      p_scope: scope, p_batch_id: null, p_window: 'overall', p_limit: 100, p_offset: 0,
    });
    assert.equal(board.error, null, `${scope}: board loads`);
    assert.ok(
      !board.data.some((row) => row.learner_label === 'Omar O.'),
      `${scope}: staff must never occupy a public rank — they would shift every real learner down`,
    );
    assert.ok(board.data.some((row) => row.learner_label === 'Silvia S.'), `${scope}: real learners still rank`);
  }

  // ...and they are not counted in the population either, not merely hidden from the page.
  const board = await silver.db.rpc('student_leaderboard', {
    p_scope: 'all', p_batch_id: null, p_window: 'overall', p_limit: 100, p_offset: 0,
  });
  assert.equal(Number(board.data[0].total_count), 1, 'total_count must not include staff');

  // Reading is still allowed: staff see the same privacy-safe boards a learner does.
  const asStaff = await operationsAdmin.db.rpc('student_leaderboard', {
    p_scope: 'all', p_batch_id: null, p_window: 'overall', p_limit: 100, p_offset: 0,
  });
  assert.equal(asStaff.error, null, 'staff may READ the public boards');
  assert.ok(!asStaff.data.some((row) => row.is_current_user), 'but they are never a row on one');

  // A Super Admin with no subscription is excluded by the same rule, not by luck.
  const asSuper = await superAdmin.db.rpc('student_leaderboard', {
    p_scope: 'all', p_batch_id: null, p_window: 'overall', p_limit: 100, p_offset: 0,
  });
  assert.equal(asSuper.error, null);
  assert.ok(!asSuper.data.some((row) => row.learner_label === 'Alex S.'), 'no admin on a student board');
});
