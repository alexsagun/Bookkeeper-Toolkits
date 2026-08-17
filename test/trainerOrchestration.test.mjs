// node:test suite for the AI-course-trainer FAIL-CLOSED orchestration (the security
// boundary). The webhook actions take the service client + the precomputed authorized-
// course list as parameters, so we inject a fake `admin` and a controlled `authorized`
// set to pin the guarantees that matter WITHOUT a database:
//   • a course the plan doesn't include ⇒ 'denied', and NO retrieval RPC is called
//   • an unknown course ⇒ 'not_found', and NO retrieval RPC is called
//   • a checkpoint for a course outside the plan is filtered out (never leaked)
//   • saving a checkpoint for a course outside the plan is refused with NO upsert
// (The handler's token/RPC-error fail-closed lives in the default export and is verified
//  by inspection — early returns to a service-error envelope with no content.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  doCatalog, doContext, doGetCheckpoint, doSaveCheckpoint,
} from '../api/elevenlabs/trainer.js';

const UID = 'user-under-test';
const RETRIEVAL_RPCS = ['trainer_match_chunks', 'trainer_match_chunks_fts', 'trainer_lesson_chunks'];
const courseA = { id: '11111111-1111-1111-1111-111111111111', slug: 'alpha', title: 'Alpha Course', access_tier: 'standard' };
const courseB = { id: '22222222-2222-2222-2222-222222222222', slug: 'beta', title: 'Beta Course', access_tier: 'standard' };

// Minimal chainable Supabase-query mock. `.select/.in/.eq/.order` are no-op chains;
// awaiting a builder yields { data: spec.list }, `.maybeSingle()` yields { data: spec.single },
// `.upsert()` records the write. `.rpc()` records the name and returns spec rpc data.
function makeAdmin({ tables = {}, rpc = {} } = {}) {
  const calls = { from: [], rpc: [], upserts: [] };
  const build = (table) => {
    const spec = tables[table] || {};
    const b = {};
    b.select = () => b; b.in = () => b; b.eq = () => b; b.order = () => b;
    b.maybeSingle = () => Promise.resolve({ data: 'single' in spec ? spec.single : null, error: spec.error || null });
    b.upsert = (row, opts) => { calls.upserts.push({ table, row, opts }); return Promise.resolve({ error: spec.upsertError || null }); };
    b.then = (onF, onR) => Promise.resolve({ data: 'list' in spec ? spec.list : [], error: spec.error || null }).then(onF, onR);
    return b;
  };
  const admin = {
    from: (t) => { calls.from.push(t); return build(t); },
    rpc: (name) => { calls.rpc.push(name); return Promise.resolve({ data: name in rpc ? rpc[name] : null, error: null }); },
  };
  return { admin, calls };
}
const calledRetrieval = (calls) => calls.rpc.some((n) => RETRIEVAL_RPCS.includes(n));

// ── Catalog ─────────────────────────────────────────────────────────────────────
test('doCatalog: empty authorized set → empty_catalog, no queries', async () => {
  const { admin, calls } = makeAdmin();
  const r = await doCatalog(admin, UID, []);
  assert.equal(r.status, 'ok');
  assert.equal(r.code, 'empty_catalog');
  assert.equal(calls.from.length, 0);
  assert.equal(calls.rpc.length, 0);
});

// ── Context (the retrieval action) ────────────────────────────────────────────────
test('doContext: course published but NOT in plan → denied, no retrieval, no leak of the denied title', async () => {
  const { admin, calls } = makeAdmin({
    tables: { courses: { list: [courseA, courseB] }, enrollment_plans: { single: { name: 'Sampler Session' } } },
    rpc: { user_plan_key: 'sampler' },
  });
  const r = await doContext(admin, UID, [courseA], { course_ref: 'beta', mode: 'explain' });
  assert.equal(r.status, 'denied');
  assert.equal(r.code, 'denied_plan');
  assert.ok(!calledRetrieval(calls), 'must NOT retrieve chunks on a denial');
  assert.ok(!r.chunks, 'denial must carry no chunks');
  // The denial names the plan + only the learner's OWN allowed titles, never the denied course.
  assert.ok(r.message.includes('Sampler Session'));
  assert.ok(!r.message.includes('Beta'), 'must not name the out-of-plan course');
});

test('doContext: unknown course → not_found, no retrieval', async () => {
  const { admin, calls } = makeAdmin({ tables: { courses: { list: [courseA, courseB] } } });
  const r = await doContext(admin, UID, [courseA], { course_ref: 'gamma', mode: 'explain' });
  assert.equal(r.code, 'not_found');
  assert.ok(!calledRetrieval(calls), 'must NOT retrieve chunks when the course does not exist');
});

test('doContext: no course_ref → bad_request prompt, no retrieval', async () => {
  const { admin, calls } = makeAdmin();
  const r = await doContext(admin, UID, [courseA], { mode: 'explain' });
  assert.equal(r.code, 'bad_request');
  assert.ok(!calledRetrieval(calls));
});

// ── Checkpoint read (cross-course leak guard) ─────────────────────────────────────
test('doGetCheckpoint: a checkpoint for an out-of-plan course is filtered out', async () => {
  const rows = [
    { course_id: courseB.id, lesson_id: null, topic: 'BETA-ONLY-SECRET', mode: 'explain', updated_at: '2026-07-20T00:00:00Z' },
    { course_id: courseA.id, lesson_id: null, topic: 'Alpha topic', mode: 'explain', updated_at: '2026-07-19T00:00:00Z' },
  ];
  const { admin } = makeAdmin({ tables: { ai_training_checkpoints: { list: rows } } });
  const r = await doGetCheckpoint(admin, UID, [courseA], {});
  assert.equal(r.code, 'ok');
  assert.equal(r.checkpoint.course_id, courseA.id, 'returns the in-plan checkpoint');
  assert.ok(!JSON.stringify(r).includes('BETA-ONLY-SECRET'), 'never surfaces an out-of-plan checkpoint');
});

test('doGetCheckpoint: ONLY out-of-plan checkpoints → no_checkpoint', async () => {
  const rows = [{ course_id: courseB.id, lesson_id: null, topic: 'B', mode: 'explain', updated_at: '2026-07-20T00:00:00Z' }];
  const { admin } = makeAdmin({ tables: { ai_training_checkpoints: { list: rows } } });
  const r = await doGetCheckpoint(admin, UID, [courseA], {});
  assert.equal(r.code, 'no_checkpoint');
});

// ── Checkpoint write (out-of-plan write guard) ────────────────────────────────────
test('doSaveCheckpoint: course not in plan → denied, NO upsert', async () => {
  const { admin, calls } = makeAdmin();
  const r = await doSaveCheckpoint(admin, UID, [courseA], { course_id: courseB.id, topic: 'x' });
  assert.equal(r.status, 'denied');
  assert.equal(r.code, 'denied_plan');
  assert.equal(calls.upserts.length, 0, 'must not write a checkpoint for an out-of-plan course');
});

test('doSaveCheckpoint: in-plan course but no topic → bad_request, NO upsert', async () => {
  const { admin, calls } = makeAdmin();
  const r = await doSaveCheckpoint(admin, UID, [courseA], { course_id: courseA.id });
  assert.equal(r.code, 'bad_request');
  assert.equal(calls.upserts.length, 0);
});

test('doSaveCheckpoint: in-plan course + topic → ok, upserts the correct course', async () => {
  const { admin, calls } = makeAdmin();
  const r = await doSaveCheckpoint(admin, UID, [courseA], { course_id: courseA.id, topic: 'Bank recs', mode: 'explain' });
  assert.equal(r.code, 'ok');
  assert.equal(calls.upserts.length, 1);
  assert.equal(calls.upserts[0].row.course_id, courseA.id);
  assert.equal(calls.upserts[0].row.topic, 'Bank recs');
  assert.equal(calls.upserts[0].row.user_id, UID);
});
