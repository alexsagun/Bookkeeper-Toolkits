// test-db/communityStaffRls.dbtest.mjs — #56 against a real Postgres.
//
// The offline suites pin the SQL TEXT. This one pins the BEHAVIOUR, with distinct
// identities, because the whole argument of #56 is that authority moved from a column to a
// table and that student isolation did not move at all.
//
// Run with:  npm run test:db      (needs .env.test pointing at a DISPOSABLE shadow project)
//
// ★ Never assert with serviceClient() — it bypasses RLS and would prove nothing.

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonClient,
  expectAppError,
  expectDenied,
  generalSpaceId,
  makeBatch,
  makePersona,
  resetShadow,
  runSql,
  seedMember,
  seedStaff,
  clearStaff,
  spaceIdFor,
  sqlScalar,
} from './_harness.mjs';

const STARTED = '2026-01-01';
const TAG = 'questions';
const BATCH_A = '2026-08';
const BATCH_B = '2026-09';

let superAdmin, ops, trainer, invitedTrainer, suspendedOps, revokedTrainer;
let sampler, silver, vipA, vipB, outsider;

before(async () => {
  superAdmin     = await makePersona('cs-super',     { isAdmin: true, fullName: 'Alex Admin' });
  ops            = await makePersona('cs-ops',       { fullName: 'Olive Ops' });
  trainer        = await makePersona('cs-trainer',   { fullName: 'Tam Trainer' });
  invitedTrainer = await makePersona('cs-invited',   { fullName: 'Ivy Invited' });
  suspendedOps   = await makePersona('cs-suspended', { fullName: 'Sue Suspended' });
  revokedTrainer = await makePersona('cs-revoked',   { fullName: 'Rob Revoked' });
  sampler        = await makePersona('cs-sampler',   { fullName: 'Sam Sampler' });
  silver         = await makePersona('cs-silver',    { fullName: 'Silvia Silver' });
  vipA           = await makePersona('cs-vip-a',     { fullName: 'Vera VipA' });
  vipB           = await makePersona('cs-vip-b',     { fullName: 'Vince VipB' });
  outsider       = await makePersona('cs-outsider',  { fullName: 'Otto Outsider' });
});

beforeEach(async () => {
  await resetShadow();
  await makeBatch(BATCH_A, { startsOn: STARTED });
  await makeBatch(BATCH_B, { startsOn: STARTED });

  await seedStaff(superAdmin, 'super_admin');
  await seedStaff(ops, 'operations_admin');
  await seedStaff(trainer, 'trainer');
  await seedStaff(invitedTrainer, 'trainer', 'invited');
  await seedStaff(suspendedOps, 'operations_admin', 'suspended');
  await seedStaff(revokedTrainer, 'trainer', 'revoked');
  for (const p of [sampler, silver, vipA, vipB, outsider]) await clearStaff(p);

  // ★ Staff hold NO subscription. That is the point: is_enrolled() is false for them, so
  //   every assertion below runs through the staff arm and nothing else.
  await seedMember(sampler, { planKey: 'sampler', days: 60 });
  await seedMember(silver,  { planKey: 'silver_self_paced', days: 60 });
  await seedMember(vipA,    { planKey: 'vip', days: 180, startBatchCode: BATCH_A, seats: 1 });
  await seedMember(vipB,    { planKey: 'vip', days: 180, startBatchCode: BATCH_B, seats: 1 });
});

after(async () => { await resetShadow(); });

// ── helpers ────────────────────────────────────────────────────────────

const STAFF = () => [['super_admin', superAdmin], ['operations_admin', ops], ['trainer', trainer]];
const DENIED_STAFF = () => [
  ['invited', invitedTrainer], ['suspended', suspendedOps], ['revoked', revokedTrainer],
];

async function categoryOf(spaceId) {
  return sqlScalar(`select id::text from public.community_channel_categories
                     where space_id = '${spaceId}' order by position limit 1`);
}

async function makeChannel(who, spaceId, over = {}) {
  return who.db.rpc('admin_save_community_channel', {
    p_id: over.id || null,
    p_space_id: spaceId,
    p_category_id: await categoryOf(spaceId),
    p_slug: over.slug || null,
    p_name: over.name || over.slug || 'probe',
    p_topic: null,
    p_kind: over.kind || 'text',
    p_audience_mode: over.audience_mode || 'space',
    p_plan_keys: over.plan_keys || [],
    p_batch_ids: over.batch_ids || [],
    p_member_posting: over.member_posting !== false,
    p_member_comments: over.member_comments !== false,
    p_member_reactions: over.member_reactions !== false,
    p_member_attachments: over.member_attachments !== false,
  });
}

async function visibleChannelIds(who) {
  const { data, error } = await who.db.rpc('my_community_sidebar');
  assert.equal(error, null, `sidebar failed for ${who.label}: ${error && error.message}`);
  return (data || []).map((r) => r.channel_id);
}

const seedPost = (author, channelId, title, status = 'active') => sqlScalar(`
  insert into public.community_posts (author_id, author_name, title, body, tag_slug, channel_id, status)
  values ('${author.id}', 'Seed', '${title}', 'body', '${TAG}', '${channelId}', '${status}')
  returning id::text`);

const seedComment = (author, postId, channelId) => sqlScalar(`
  insert into public.community_comments (post_id, author_id, author_name, body, channel_id)
  values ('${postId}', '${author.id}', 'Seed', 'reply', '${channelId}')
  returning id::text`);

const generalDefault = async () => sqlScalar(`
  select id::text from public.community_channels
   where space_id = '${await generalSpaceId()}' and kind = 'text' and status = 'active'
   order by position limit 1`);

const eventCount = (targetId) => sqlScalar(
  `select count(*)::int from public.community_moderation_events where target_id = '${targetId}'`);

// ── Who is Community staff ─────────────────────────────────────────────

test('all three roles are Community staff; nobody else is', async () => {
  for (const [role, who] of STAFF()) {
    assert.equal(await sqlScalar(
      `select public.user_is_community_staff('${who.id}')::text`), 'true', role);
  }
  for (const [status, who] of DENIED_STAFF()) {
    assert.equal(await sqlScalar(
      `select public.user_is_community_staff('${who.id}')::text`), 'false',
      `a ${status} membership must confer nothing`);
  }
  for (const who of [sampler, silver, vipA, vipB, outsider]) {
    assert.equal(await sqlScalar(
      `select public.user_is_community_staff('${who.id}')::text`), 'false', who.label);
  }
});

test('the per-user helper is not callable from a client at all', async () => {
  await expectDenied(
    ops.db.rpc('user_is_community_staff', { p_user: sampler.id }),
    'user_is_community_staff answers about an arbitrary user',
  );
});

test('staff reach the community with NO subscription', async () => {
  for (const [role, who] of STAFF()) {
    assert.equal(await sqlScalar(
      `select count(*)::int from public.subscriptions where user_id = '${who.id}'`), 0,
      `${role} must hold no subscription for this test to mean anything`);
    const ids = await visibleChannelIds(who);
    assert.ok(ids.length > 0, `${role} sees no channels — is_enrolled() is false for them, `
      + 'so only the staff arm can be carrying this');
  }
});

// ── Configuration ──────────────────────────────────────────────────────

test('Ops Admin and Trainer can open the community editor', async () => {
  for (const [role, who] of STAFF()) {
    const { data, error } = await who.db.rpc('admin_community_config');
    assert.equal(error, null, `${role}: ${error && error.message}`);
    assert.ok(data && data.spaces, `${role} got no config payload`);
  }
});

test('Ops Admin and Trainer can create, rename, reorder, archive and restore a channel', async () => {
  const general = await generalSpaceId();
  for (const [role, who] of STAFF()) {
    const created = await makeChannel(who, general, { slug: `probe-${role}`.slice(0, 24) });
    assert.equal(created.error, null, `${role} create: ${created.error && created.error.message}`);
    const id = created.data;

    const renamed = await who.db.rpc('admin_save_community_channel', {
      p_id: id, p_space_id: null, p_category_id: null, p_slug: null,
      p_name: `${role} room`, p_topic: null, p_kind: null, p_audience_mode: null,
      p_plan_keys: null, p_batch_ids: null, p_member_posting: null,
      p_member_comments: null, p_member_reactions: null, p_member_attachments: null,
    });
    assert.equal(renamed.error, null, `${role} rename: ${renamed.error && renamed.error.message}`);

    assert.equal((await who.db.rpc('admin_move_community_channel', { p_id: id, p_delta: -1 })).error, null);
    assert.equal((await who.db.rpc('admin_set_community_channel_status', { p_id: id, p_status: 'archived' })).error, null);
    assert.equal((await who.db.rpc('admin_set_community_channel_status', { p_id: id, p_status: 'active' })).error, null);
  }
});

test('a rename still preserves topic and audience (#41/#43 survived the re-gate)', async () => {
  const general = await generalSpaceId();
  const { data: id } = await makeChannel(ops, general, { slug: 'topicful', audience_mode: 'plans', plan_keys: ['vip'] });
  await runSql(`update public.community_channels set topic = 'keep me' where id = '${id}'`);
  await ops.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null, p_slug: null, p_name: 'renamed',
    p_topic: null, p_kind: null, p_audience_mode: null, p_plan_keys: null, p_batch_ids: null,
    p_member_posting: null, p_member_comments: null, p_member_reactions: null,
    p_member_attachments: null,
  });
  assert.equal(await sqlScalar(`select topic from public.community_channels where id = '${id}'`), 'keep me');
  assert.equal(await sqlScalar(`select audience_mode from public.community_channels where id = '${id}'`), 'plans');
});

test('staff can preview a privacy change, and students cannot', async () => {
  const general = await generalSpaceId();
  const { data: id } = await makeChannel(ops, general, { slug: 'preview-me' });
  for (const [role, who] of STAFF()) {
    const { data, error } = await who.db.rpc('admin_channel_privacy_preview', {
      p_channel_id: id, p_audience_mode: 'plans', p_plan_keys: ['vip'], p_batch_ids: [],
    });
    assert.equal(error, null, `${role} preview: ${error && error.message}`);
    assert.ok(data, `${role} got no preview`);
  }
  await expectAppError(sampler.db.rpc('admin_channel_privacy_preview', {
    p_channel_id: id, p_audience_mode: 'plans', p_plan_keys: ['vip'], p_batch_ids: [],
  }), 'FORBIDDEN', 'a student must never see the audience arithmetic');
});

test('a non-active staff membership configures nothing', async () => {
  for (const [status, who] of DENIED_STAFF()) {
    await expectAppError(who.db.rpc('admin_community_config'), 'FORBIDDEN',
      `a ${status} membership must be refused`);
  }
});

test('students and anon cannot touch any community config RPC', async () => {
  const general = await generalSpaceId();
  for (const who of [sampler, silver, vipA, outsider]) {
    await expectAppError(who.db.rpc('admin_community_config'), 'FORBIDDEN', who.label);
    await expectAppError(who.db.rpc('admin_save_channel_category', {
      p_id: null, p_space_id: general, p_name: 'nope', p_status: 'active',
    }), 'FORBIDDEN', who.label);
    await expectAppError(who.db.rpc('admin_set_community_channel_status', {
      p_id: await generalDefault(), p_status: 'archived',
    }), 'FORBIDDEN', who.label);
  }
  await expectDenied(anonClient().rpc('admin_community_config'), 'anon');
});

test('the channel and audience tables have no client write path at all', async () => {
  const general = await generalSpaceId();
  await expectDenied(
    ops.db.from('community_channels').update({ name: 'direct' }).eq('space_id', general),
    'even Community staff must go through the audited RPC',
  );
  await expectDenied(
    ops.db.from('community_channel_plans').insert({ channel_id: await generalDefault(), plan_key: 'vip' }),
    'the audience map is RPC-only',
  );
});

test('a student cannot read the plan/batch audience maps', async () => {
  const { data } = await sampler.db.from('community_channel_plans').select('*');
  assert.deepEqual(data || [], [],
    'telling a member which plans a room is limited to leaks the cohort roster shape');
  const { data: b } = await sampler.db.from('community_channel_batches').select('*');
  assert.deepEqual(b || [], []);
});

test('staff CAN read the audience maps and the channel audit log', async () => {
  const general = await generalSpaceId();
  await makeChannel(ops, general, { slug: 'audienced', audience_mode: 'plans', plan_keys: ['vip'] });
  for (const [role, who] of STAFF()) {
    const { data, error } = await who.db.from('community_channel_plans').select('*');
    assert.equal(error, null, `${role}: ${error && error.message}`);
    assert.ok((data || []).length > 0, `${role} must see the audience map to edit it`);
    const ev = await who.db.from('community_channel_events').select('id').limit(1);
    assert.equal(ev.error, null, `${role} must be able to read the configuration audit`);
  }
});

// ── admins_only, and student isolation ─────────────────────────────────

test('an admins_only channel is visible to Community staff and to nobody else', async () => {
  const general = await generalSpaceId();
  const { data: id } = await makeChannel(ops, general, { slug: 'staffroom', audience_mode: 'admins_only' });
  for (const [role, who] of STAFF()) {
    assert.ok((await visibleChannelIds(who)).includes(id), `${role} must see the staff room`);
  }
  for (const who of [sampler, silver, vipA, vipB]) {
    assert.ok(!(await visibleChannelIds(who)).includes(id), `${who.label} must not`);
  }
  for (const [status, who] of DENIED_STAFF()) {
    assert.ok(!(await visibleChannelIds(who)).includes(id),
      `a ${status} membership must not open the staff room`);
  }
});

test('VIP Batch A still cannot discover Batch B — the widening changed nothing here', async () => {
  const spaceB = await spaceIdFor('vip', BATCH_B);
  const bChannels = await sqlScalar(
    `select count(*)::int from public.community_channels where space_id = '${spaceB}'`);
  assert.ok(bChannels > 0, 'batch B must have channels for this test to mean anything');
  const seen = await visibleChannelIds(vipA);
  const bIds = (await sqlScalar(
    `select string_agg(id::text, ',') from public.community_channels where space_id = '${spaceB}'`) || '').split(',');
  for (const id of bIds.filter(Boolean)) {
    assert.ok(!seen.includes(id), 'Batch A must never see a Batch B room');
  }
});

test('an unknown or unauthorized channel reports identically to a nonexistent one', async () => {
  const general = await generalSpaceId();
  const { data: hidden } = await makeChannel(ops, general, { slug: 'invisible', audience_mode: 'admins_only' });
  const postId = await seedPost(superAdmin, hidden, 'secret');
  // A student moderating a room they cannot see, and a made-up uuid, must be the same code.
  await expectAppError(sampler.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' }),
    'FORBIDDEN', 'a student is refused before the target is even looked up');
  await expectAppError(
    trainer.db.rpc('community_moderate_post',
      { p_post_id: '00000000-0000-0000-0000-000000000000', p_action: 'hide' }),
    'MODERATION_TARGET_NOT_FOUND', 'a nonexistent post');
});

// ── Moderation ─────────────────────────────────────────────────────────

test('Ops Admin and Trainer can pin, lock, hide, restore and delete', async () => {
  const ch = await generalDefault();
  for (const [role, who] of STAFF()) {
    const postId = await seedPost(sampler, ch, `by a student for ${role}`);
    for (const [action, col, want] of [
      ['pin', 'pinned', 'true'], ['unpin', 'pinned', 'false'],
      ['lock', 'comments_locked', 'true'], ['unlock', 'comments_locked', 'false'],
      ['hide', 'status', 'hidden'], ['restore', 'status', 'active'],
    ]) {
      const { data, error } = await who.db.rpc('community_moderate_post',
        { p_post_id: postId, p_action: action });
      assert.equal(error, null, `${role} ${action}: ${error && error.message}`);
      assert.equal(data.ok, true);
      assert.equal(
        await sqlScalar(`select ${col}::text from public.community_posts where id = '${postId}'`),
        want, `${role}: ${action} did not take effect — check community_posts_guard`);
    }
    const del = await who.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'delete' });
    assert.equal(del.error, null, `${role} delete: ${del.error && del.error.message}`);
    assert.equal(
      await sqlScalar(`select count(*)::int from public.community_posts where id = '${postId}'`), 0);
  }
});

test('a comment can be hidden, restored and deleted by staff', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'thread');
  const cId = await seedComment(silver, postId, ch);
  assert.equal((await ops.db.rpc('community_moderate_comment', { p_comment_id: cId, p_action: 'hide' })).error, null);
  assert.equal(await sqlScalar(`select status from public.community_comments where id = '${cId}'`), 'hidden');
  assert.equal((await trainer.db.rpc('community_moderate_comment', { p_comment_id: cId, p_action: 'restore' })).error, null);
  assert.equal(await sqlScalar(`select status from public.community_comments where id = '${cId}'`), 'active');
  assert.equal((await trainer.db.rpc('community_moderate_comment', { p_comment_id: cId, p_action: 'delete' })).error, null);
  assert.equal(await sqlScalar(`select count(*)::int from public.community_comments where id = '${cId}'`), 0);
});

test('moderation NEVER rewrites the content it acts on', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'untouchable');
  const before = await sqlScalar(`select author_id::text || '|' || title || '|' || body
     || '|' || created_at::text || '|' || channel_id::text || '|' || comment_count::text
     from public.community_posts where id = '${postId}'`);
  for (const action of ['pin', 'lock', 'hide', 'restore', 'unlock', 'unpin']) {
    await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: action });
  }
  const after = await sqlScalar(`select author_id::text || '|' || title || '|' || body
     || '|' || created_at::text || '|' || channel_id::text || '|' || comment_count::text
     from public.community_posts where id = '${postId}'`);
  assert.equal(after, before,
    'author, title, body, created_at, channel and the counter must be byte-identical');
});

test('a moderator cannot rewrite a post by any other route', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'not yours');
  await expectDenied(
    trainer.db.from('community_posts').update({ body: 'impersonated' }).eq('id', postId),
    'a direct table write must be refused for a non-super moderator',
  );
  assert.equal(await sqlScalar(`select body from public.community_posts where id = '${postId}'`), 'body');
});

test('an unknown action is refused before the target is looked up', async () => {
  await expectAppError(
    ops.db.rpc('community_moderate_post', { p_post_id: '00000000-0000-0000-0000-000000000000', p_action: 'destroy' }),
    'MODERATION_ACTION_INVALID',
    'validating the action first is what stops it being an existence oracle',
  );
});

test('a moderator cannot resurrect an author own withdrawal', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'withdrawn', 'deleted');
  await expectAppError(
    ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'restore' }),
    'MODERATION_STATE_INVALID',
    'republishing content its author retracted is not moderation',
  );
});

test('students, anon and non-active staff cannot moderate', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(silver, ch, 'target');
  for (const who of [sampler, silver, vipA, outsider]) {
    await expectAppError(who.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' }),
      'FORBIDDEN', who.label);
  }
  for (const [status, who] of DENIED_STAFF()) {
    await expectAppError(who.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' }),
      'FORBIDDEN', `a ${status} membership`);
  }
  await expectDenied(anonClient().rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' }), 'anon');
  assert.equal(await sqlScalar(`select status from public.community_posts where id = '${postId}'`), 'active');
});

test('a student cannot forge moderation by writing the columns directly', async () => {
  const ch = await generalDefault();
  const own = await seedPost(sampler, ch, 'mine');
  // The guard freezes pinned/comments_locked for anyone without community.moderate, so this
  // succeeds as an UPDATE and changes nothing — the #40 contract, still true after #56.
  await sampler.db.from('community_posts').update({ pinned: true }).eq('id', own);
  assert.equal(await sqlScalar(`select pinned::text from public.community_posts where id = '${own}'`),
    'false', 'community_posts_guard must still freeze pinned for a member');
});

// ── Hidden content, and the ledger ─────────────────────────────────────

test('hidden content is visible to Community staff and to nobody else', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'to be hidden');
  await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' });

  for (const [role, who] of STAFF()) {
    const { data } = await who.db.from('community_posts').select('id').eq('id', postId);
    assert.equal((data || []).length, 1, `${role} must see hidden content to moderate it`);
  }
  for (const who of [sampler, silver, vipA, outsider]) {
    const { data } = await who.db.from('community_posts').select('id').eq('id', postId);
    assert.equal((data || []).length, 0, `${who.label} must not see a hidden post`);
  }
  // Not even its author — an author can never un-hide what a moderator hid.
  await expectDenied(
    sampler.db.from('community_posts').update({ status: 'active' }).eq('id', postId),
    'an author must never be able to reverse a moderation decision',
  );
  assert.equal(await sqlScalar(`select status from public.community_posts where id = '${postId}'`), 'hidden');
});

test('every state change writes exactly one audit row, and a no-op writes none', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'audited');
  assert.equal(await eventCount(postId), 0);

  await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'pin' });
  assert.equal(await eventCount(postId), 1, 'one action, one row');

  const again = await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'pin' });
  assert.equal(again.error, null);
  assert.equal(again.data.already, true, 'a repeat must report itself as a no-op');
  assert.equal(await eventCount(postId), 1,
    'a double-click must not corrupt "when did this become pinned"');

  await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' });
  assert.equal(await eventCount(postId), 2);

  const row = await sqlScalar(`select actor_id::text || '|' || action || '|' || target_kind
     from public.community_moderation_events
    where target_id = '${postId}' order by created_at desc limit 1`);
  assert.equal(row, `${ops.id}|hide|post`, 'the ledger must name the real actor');
});

test('the ledger is append-only from every client', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'ledger');
  await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'pin' });

  for (const who of [ops, trainer, superAdmin, sampler]) {
    await expectDenied(who.db.from('community_moderation_events').insert({
      target_kind: 'post', target_id: postId, action: 'hide',
    }), `${who.label} must not be able to forge an audit row`);
    await expectDenied(
      who.db.from('community_moderation_events').update({ action: 'unpin' }).eq('target_id', postId),
      `${who.label} must not be able to edit the ledger`);
    await expectDenied(
      who.db.from('community_moderation_events').delete().eq('target_id', postId),
      `${who.label} must not be able to erase the ledger`);
  }
  assert.equal(await eventCount(postId), 1);
});

test('the ledger is readable by Community staff only', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'private ledger');
  await ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' });
  for (const [role, who] of STAFF()) {
    const { data } = await who.db.from('community_moderation_events').select('id');
    assert.ok((data || []).length >= 1, `${role} must be able to read the moderation log`);
  }
  for (const who of [sampler, silver, vipA, outsider]) {
    const { data } = await who.db.from('community_moderation_events').select('id');
    assert.deepEqual(data || [], [],
      `${who.label} must not learn who moderated what, or why`);
  }
});

test('a delete returns the storage paths it detached, and records them', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'with media');
  const path = `${await generalSpaceId()}/${sampler.id}/probe.png`;
  await runSql(`
    insert into public.community_attachments (post_id, uploader_id, kind, storage_path, position)
    values ('${postId}', '${sampler.id}', 'image', '${path}', 0)`);

  const { data, error } = await ops.db.rpc('community_moderate_post',
    { p_post_id: postId, p_action: 'delete' });
  assert.equal(error, null, error && error.message);
  assert.deepEqual(data.storage_paths, [path],
    'the client cannot read them afterwards — the cascade is already gone');
  const recorded = await sqlScalar(`select detail -> 'storage_paths' ->> 0
     from public.community_moderation_events where target_id = '${postId}'`);
  assert.equal(recorded, path, 'a failed sweep must be recoverable from the ledger');
});

// ── What community authority must NOT carry with it ────────────────────

test('a Trainer gains no student, payment, batch, staff or progress authority', async () => {
  await expectDenied(trainer.db.from('enrollment_requests').select('id'), 'payment proofs');
  await expectDenied(trainer.db.from('subscriptions').select('id').neq('user_id', trainer.id),
    'other people terms');
  // #52 gates the report on student_progress.read, which a Trainer does not hold. The
  // refusal shape is the suite's own tolerant matcher: some paths raise app_error, others
  // a bare permission error, and this assertion is about the REFUSAL, not its wording.
  {
    const { error } = await trainer.db.rpc('admin_student_progress_report', {});
    assert.ok(error, 'a Trainer must be refused the private progress report');
  }
  await expectDenied(trainer.db.from('staff_memberships').update({ role_key: 'super_admin' })
    .eq('user_id', trainer.id), 'self-promotion');
  await expectDenied(trainer.db.from('payment_settings').update({ notify_email: 'x@y.z' })
    .neq('id', false), 'payment settings');
  await expectDenied(trainer.db.from('sidebar_settings').insert({
    item_key: 'tab:dashboard', custom_label: 'Nope',
  }), 'sidebar customization');
});

test('an Operations Admin gains no course-publishing or staff authority', async () => {
  await expectDenied(ops.db.from('staff_memberships').update({ role_key: 'super_admin' })
    .eq('user_id', ops.id), 'self-promotion');
  await expectDenied(ops.db.from('courses').update({ published: true }).neq('id', ops.id),
    'publishing is courses.publish, which an Ops Admin does not hold');
});

test('staff status is not a subscription: is_enrolled stays false', async () => {
  for (const [role, who] of STAFF()) {
    if (role === 'super_admin') continue;   // is_admin() short-circuits is_enrolled by design
    const enrolled = await sqlScalar(`select public.user_is_enrolled('${who.id}')::text`)
      .catch(() => null);
    if (enrolled !== null) {
      assert.equal(enrolled, 'false',
        `${role} must not be granted a paid membership by being staff`);
    }
    assert.equal(await sqlScalar(
      `select count(*)::int from public.batch_entitlements where user_id = '${who.id}'`), 0,
      `${role} must hold no cohort seat`);
  }
});

test('revoking the permission removes the authority on the very next request', async () => {
  const general = await generalSpaceId();
  assert.equal((await ops.db.rpc('admin_community_config')).error, null);
  await seedStaff(ops, 'operations_admin', 'suspended');
  await expectAppError(ops.db.rpc('admin_community_config'), 'FORBIDDEN',
    'only status=active confers authority, and it is read live on every request — not '
    + 'decoded from a token, which is what makes a suspension immediate');
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'after suspension');
  await expectAppError(ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' }),
    'FORBIDDEN', 'moderation goes too');
  assert.ok(!(await visibleChannelIds(ops)).includes(
    await makeChannel(superAdmin, general, { slug: 'post-suspend', audience_mode: 'admins_only' })
      .then((r) => r.data)),
    'and so does the staff room');
  await seedStaff(ops, 'operations_admin');   // restore for the next test
});

test('audience changes cannot accidentally expose a private channel', async () => {
  const spaceA = await spaceIdFor('vip', BATCH_A);
  const { data: id } = await makeChannel(ops, spaceA, {
    slug: 'cohort-only', audience_mode: 'batches',
    batch_ids: [await sqlScalar(`select id::text from public.batches where code = '${BATCH_A}'`)],
  });
  assert.ok((await visibleChannelIds(vipA)).includes(id), 'Batch A belongs here');
  assert.ok(!(await visibleChannelIds(vipB)).includes(id), 'Batch B does not');
  assert.ok(!(await visibleChannelIds(silver)).includes(id), 'and neither does Silver');

  // An audience mode that needs a mapping fails CLOSED on an empty one.
  await ops.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null, p_slug: null, p_name: null, p_topic: null,
    p_kind: null, p_audience_mode: 'plans', p_plan_keys: [], p_batch_ids: null,
    p_member_posting: null, p_member_comments: null, p_member_reactions: null,
    p_member_attachments: null,
  });
  for (const who of [vipA, vipB, silver, sampler]) {
    assert.ok(!(await visibleChannelIds(who)).includes(id),
      `${who.label}: an empty mapping must admit nobody`);
  }
});

// ── The blanket-write trap (#56 review finding) ────────────────────────────

test('a moderator CANNOT rewrite another author by any direct table write', async () => {
  // The five *_admin_all policies are FOR ALL, and these tables have no table-level DML
  // revoke — so re-gating them onto community.moderate would have been a raw PostgREST
  // write path over every row. They stay Super-Admin-only; Ops and Trainer reach other
  // people's content only through the audited RPCs.
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'not yours');
  for (const [role, who] of [['operations_admin', ops], ['trainer', trainer]]) {
    await expectDenied(who.db.from('community_posts').update({ body: 'impersonated' }).eq('id', postId), `${role} body`);
    await expectDenied(who.db.from('community_posts').update({ author_id: who.id }).eq('id', postId), `${role} author_id`);
    await expectDenied(who.db.from('community_posts').update({ title: 'rewritten' }).eq('id', postId), `${role} title`);
    await expectDenied(who.db.from('community_posts').delete().eq('id', postId), `${role} raw delete`);
  }
  const row = await sqlScalar(
    `select author_id::text || '|' || title || '|' || body from public.community_posts where id = '${postId}'`);
  assert.equal(row, `${sampler.id}|not yours|body`, 'nothing may have changed');
  assert.equal(await eventCount(postId), 0, 'and no audit row was written, because nothing happened');
});

test('a raw delete leaves no un-swept media, because it is refused', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'has media');
  const path = `${await generalSpaceId()}/${sampler.id}/orphan-probe.png`;
  await runSql(`
    insert into public.community_attachments (post_id, uploader_id, kind, storage_path, position)
    values ('${postId}', '${sampler.id}', 'image', '${path}', 0)`);
  await expectDenied(trainer.db.from('community_posts').delete().eq('id', postId),
    'a raw delete would cascade the attachment rows away with no ledger row and no captured '
    + 'paths, leaving the private object permanently unreachable');
  assert.equal(await sqlScalar(
    `select count(*)::int from public.community_attachments where post_id = '${postId}'`), 1);
});

test('staff can post, comment, react and attach as THEMSELVES, with no subscription', async () => {
  // is_enrolled() is false for them, so every *_own_insert policy would refuse without the
  // section 8d standing bypass — an Ops Admin could moderate the forum and never post in it.
  const ch = await generalDefault();
  for (const [role, who] of [['operations_admin', ops], ['trainer', trainer]]) {
    const ins = await who.db.from('community_posts')
      .insert({ author_id: who.id, author_name: role, title: `by ${role}`, body: 'hello',
        tag_slug: TAG, channel_id: ch })
      .select('id').single();
    assert.equal(ins.error, null, `${role} post: ${ins.error && ins.error.message}`);

    const cm = await who.db.from('community_comments')
      .insert({ post_id: ins.data.id, author_id: who.id, author_name: role, body: 'reply' })
      .select('id').single();
    assert.equal(cm.error, null, `${role} comment: ${cm.error && cm.error.message}`);

    const rx = await who.db.from('community_reactions')
      .insert({ post_id: ins.data.id, user_id: who.id, reaction_type: 'like' });
    assert.equal(rx.error, null, `${role} reaction: ${rx.error && rx.error.message}`);

    // ...and can edit and withdraw their OWN post.
    const ed = await who.db.from('community_posts').update({ body: 'edited' }).eq('id', ins.data.id);
    assert.equal(ed.error, null, `${role} own edit: ${ed.error && ed.error.message}`);
    const wd = await who.db.from('community_posts').update({ status: 'deleted' }).eq('id', ins.data.id);
    assert.equal(wd.error, null, `${role} own withdraw: ${wd.error && wd.error.message}`);
  }
});

test('staff can post in an announcement channel; a member cannot', async () => {
  const general = await generalSpaceId();
  const { data: annId } = await makeChannel(ops, general, { slug: 'staff-ann', kind: 'announcement' });
  for (const [role, who] of [['operations_admin', ops], ['trainer', trainer]]) {
    const ins = await who.db.from('community_posts')
      .insert({ author_id: who.id, author_name: role, title: 'notice', body: 'x',
        tag_slug: 'announcements', channel_id: annId })
      .select('id').single();
    assert.equal(ins.error, null, `${role} announcement: ${ins.error && ins.error.message}`);
  }
  const bad = await silver.db.from('community_posts')
    .insert({ author_id: silver.id, author_name: 'S', title: 'nope', body: 'x',
      tag_slug: TAG, channel_id: annId });
  assert.ok(bad.error, 'member_posting is false by CHECK in an announcement channel');
});

test('hide cannot be used to launder an author withdrawal back into the feed', async () => {
  const ch = await generalDefault();
  const postId = await seedPost(sampler, ch, 'withdrawn', 'deleted');
  await expectAppError(ops.db.rpc('community_moderate_post', { p_post_id: postId, p_action: 'hide' }),
    'MODERATION_STATE_INVALID',
    "hide on a 'deleted' row would leave it 'hidden', at which point restore's guard passes "
    + 'and the post is republished in two calls — and the author can no longer re-withdraw it');
  assert.equal(await sqlScalar(`select status from public.community_posts where id = '${postId}'`), 'deleted');
});
