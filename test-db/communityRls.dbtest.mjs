// test-db/communityRls.dbtest.mjs — the plan-gated community (#36).
//
// This is the business rule the whole feature exists for:
//
//   In Discord, Core/Self-Paced students ask questions freely, and the support
//   load lands on one person. Here, the DATABASE refuses the write. Hiding the
//   button is a UI nicety; these tests bypass the UI entirely and send the
//   request supabase-js would send, as a real signed-in member.
//
// D2: General is announcement-only for EVERY plan — including Gold and VIP.
//     Reactions stay on for everyone. Cohort plans discuss in their own space.
//
// Run: npm run test:db

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonClient,
  expectDenied,
  generalSpaceId,
  makeBatch,
  makePersona,
  resetShadow,
  runSql,
  seedMember,
  spaceIdFor,
  sqlScalar,
} from './_harness.mjs';

const STARTED = '2026-01-01';
const TAG = 'questions'; // one of the ten seeded community_tags

let admin, core, sampler, silver, gold, vip;

before(async () => {
  admin = await makePersona('c-admin', { isAdmin: true, fullName: 'Alex Admin' });
  core = await makePersona('c-core', { fullName: 'Cora Core' });
  sampler = await makePersona('c-sampler', { fullName: 'Sam Sampler' });
  silver = await makePersona('c-silver', { fullName: 'Silvia Silver' });
  gold = await makePersona('c-gold', { fullName: 'Gina Gold' });
  vip = await makePersona('c-vip', { fullName: 'Vera Vip' });
});

beforeEach(async () => {
  await resetShadow();
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(core, { planKey: 'core_self_paced', days: 60 });
  await seedMember(sampler, { planKey: 'sampler', days: 60 });
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  await seedMember(gold, { planKey: 'gold_live', days: 180, startBatchCode: '2026-08', seats: 1 });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08', seats: 1 });
});

after(async () => { await resetShadow(); });

/** Post an announcement into a space as the admin, returning its id. */
async function adminPost(spaceId, title = 'Announcement') {
  return sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${admin.id}'::uuid, '${spaceId}'::uuid, '${title}', 'body text', '${TAG}', 'active')
    returning id::text`);
}

const SELF_PACED = () => [
  ['core_self_paced', core],
  ['sampler', sampler],
  ['silver_self_paced', silver],
];

// ── D2: nobody writes in General ─────────────────────────────────────────────

test('D2: NO plan can create a post in General — not even Gold or VIP', async () => {
  const general = await generalSpaceId();

  for (const [name, who] of [...SELF_PACED(), ['gold_live', gold], ['vip', vip]]) {
    await expectDenied(
      who.db.from('community_posts').insert({
        author_id: who.id, space_id: general, title: 'Question!',
        body: 'How do I reconcile this?', tag_slug: TAG, status: 'active',
      }),
      `${name} posting in General`,
    );
  }

  const n = await sqlScalar(
    `select count(*)::int from public.community_posts where space_id = '${general}'::uuid`);
  assert.equal(n, 0, 'not one member post landed in General');
});

test('D2: NO plan can reply in General, on an admin announcement', async () => {
  const general = await generalSpaceId();
  const postId = await adminPost(general, 'Welcome to August');

  for (const [name, who] of [...SELF_PACED(), ['gold_live', gold], ['vip', vip]]) {
    await expectDenied(
      who.db.from('community_comments').insert({
        author_id: who.id, post_id: postId, body: 'Can you explain?', status: 'active',
      }),
      `${name} replying in General`,
    );
  }

  assert.equal(
    await sqlScalar(`select count(*)::int from public.community_comments where post_id = '${postId}'::uuid`),
    0, 'the announcement has no replies');
});

test('D2: EVERY plan can read General and react — and un-react', async () => {
  const general = await generalSpaceId();
  const postId = await adminPost(general, 'Reactable');

  for (const [name, who] of [...SELF_PACED(), ['gold_live', gold], ['vip', vip]]) {
    const { data: readable, error: readErr } = await who.db
      .from('community_posts').select('id,title').eq('space_id', general);
    assert.equal(readErr, null, `${name} read error`);
    assert.equal(readable.length, 1, `${name} must be able to read the announcement`);

    const { error: reactErr } = await who.db.from('community_reactions')
      .insert({ user_id: who.id, post_id: postId, reaction_type: 'like' });
    assert.equal(reactErr, null, `${name} must be able to react: ${reactErr && reactErr.message}`);

    const { error: unreactErr } = await who.db.from('community_reactions')
      .delete().eq('user_id', who.id).eq('post_id', postId);
    assert.equal(unreactErr, null, `${name} must be able to remove their reaction`);
  }

  assert.equal(
    await sqlScalar(`select count(*)::int from public.community_reactions where post_id = '${postId}'::uuid`),
    0, 'every reaction was withdrawn cleanly');
});

test('the admin can still post announcements in General', async () => {
  const general = await generalSpaceId();
  const { error } = await admin.db.from('community_posts').insert({
    author_id: admin.id, space_id: general, title: 'August kickoff',
    body: 'Live call Thursday', tag_slug: TAG, status: 'active',
  });
  assert.equal(error, null, `admin post failed: ${error && error.message}`);
});

// ── Cohort spaces: Gold and VIP hold the full forum, separately ──────────────

test('a Gold member holds the full forum inside their own cohort space', async () => {
  const goldSpace = await spaceIdFor('gold', '2026-08');

  const { data: post, error: postErr } = await gold.db.from('community_posts')
    .insert({
      author_id: gold.id, space_id: goldSpace, title: 'My reconciliation question',
      body: 'Stuck on a bank feed', tag_slug: TAG, status: 'active',
    }).select('id').single();
  assert.equal(postErr, null, `gold post failed: ${postErr && postErr.message}`);

  const { error: cErr } = await gold.db.from('community_comments')
    .insert({ author_id: gold.id, post_id: post.id, body: 'Following up', status: 'active' });
  assert.equal(cErr, null, `gold reply failed: ${cErr && cErr.message}`);

  const { error: rErr } = await gold.db.from('community_reactions')
    .insert({ user_id: gold.id, post_id: post.id, reaction_type: 'helpful' });
  assert.equal(rErr, null, `gold reaction failed: ${rErr && rErr.message}`);
});

test('a Gold member cannot write into the VIP space of the SAME cohort', async () => {
  // Gold and VIP share a batch, so this is the case a batch-id-only check misses.
  const vipSpace = await spaceIdFor('vip', '2026-08');
  await expectDenied(
    gold.db.from('community_posts').insert({
      author_id: gold.id, space_id: vipSpace, title: 'Sneaking in',
      body: 'hello', tag_slug: TAG, status: 'active',
    }),
    'gold posting into VIP',
  );

  const vipPost = await adminPost(vipSpace, 'VIP only');
  const { data: seen } = await gold.db.from('community_posts').select('id').eq('id', vipPost);
  assert.deepEqual(seen, [], 'and cannot read VIP content either');

  await expectDenied(
    gold.db.from('community_reactions').insert({
      user_id: gold.id, post_id: vipPost, reaction_type: 'like',
    }),
    'gold reacting to a VIP post',
  );
});

test('a self-paced member cannot write into a cohort space they are not in', async () => {
  const goldSpace = await spaceIdFor('gold', '2026-08');
  const goldPost = await adminPost(goldSpace, 'Cohort material');

  for (const [name, who] of SELF_PACED()) {
    await expectDenied(
      who.db.from('community_posts').insert({
        author_id: who.id, space_id: goldSpace, title: 'Question',
        body: 'x', tag_slug: TAG, status: 'active',
      }),
      `${name} posting into a Gold cohort`,
    );
    await expectDenied(
      who.db.from('community_comments').insert({
        author_id: who.id, post_id: goldPost, body: 'x', status: 'active',
      }),
      `${name} replying in a Gold cohort`,
    );
    await expectDenied(
      who.db.from('community_reactions').insert({
        user_id: who.id, post_id: goldPost, reaction_type: 'like',
      }),
      `${name} reacting on a Gold post`,
    );
  }
});

// ── Forgery attempts ─────────────────────────────────────────────────────────

test('a member cannot forge author_id to post as somebody else', async () => {
  const goldSpace = await spaceIdFor('gold', '2026-08');
  await expectDenied(
    gold.db.from('community_posts').insert({
      author_id: admin.id, space_id: goldSpace, title: 'Posted as Alex',
      body: 'impersonation', tag_slug: TAG, status: 'active',
    }),
    'forging author_id',
  );
});

test('a member cannot forge space_id to publish a cohort post to everyone', async () => {
  const general = await generalSpaceId();
  await expectDenied(
    gold.db.from('community_posts').insert({
      author_id: gold.id, space_id: general, title: 'Broadcast',
      body: 'to every plan', tag_slug: TAG, status: 'active',
    }),
    'forging space_id to General',
  );
});

test('a member cannot post under an admin-only tag', async () => {
  const goldSpace = await spaceIdFor('gold', '2026-08');
  const adminTag = await sqlScalar(
    `select slug from public.community_tags where admin_only limit 1`);
  await expectDenied(
    gold.db.from('community_posts').insert({
      author_id: gold.id, space_id: goldSpace, title: 'Fake announcement',
      body: 'x', tag_slug: adminTag, status: 'active',
    }),
    'posting under an admin-only tag',
  );
});

// ── The UPDATE split: withdraw vs keep-published ─────────────────────────────

test('an author can WITHDRAW a historical General post but not re-publish it', async () => {
  // General went announcement-only AFTER these posts existed. Their authors must
  // still be able to delete them — the whole reason the UPDATE policy is split.
  const general = await generalSpaceId();
  const legacyPost = await sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${core.id}'::uuid, '${general}'::uuid, 'Old question', 'from before D2', '${TAG}', 'active')
    returning id::text`);

  // Editing it (keeping it published) needs create rights, which Core lacks.
  await expectDenied(
    core.db.from('community_posts').update({ body: 'edited' }).eq('id', legacyPost).select(),
    'editing a General post without post rights',
  );

  // Withdrawing it is always allowed in a space you belong to.
  //
  // Note the missing .select(): once status = 'deleted' the row no longer
  // satisfies the READ policy, so a returning-select comes back empty even
  // though the write succeeded. Asserting on the returned rows here would fail
  // against a perfectly correct database — check the stored state instead.
  const { error } = await core.db.from('community_posts')
    .update({ status: 'deleted' }).eq('id', legacyPost);
  assert.equal(error, null, `withdraw failed: ${error && error.message}`);

  assert.equal(
    await sqlScalar(`select status from public.community_posts where id = '${legacyPost}'::uuid`),
    'deleted', 'the author withdrew their own post');
});

test('historical General content stays READABLE after D2', async () => {
  const general = await generalSpaceId();
  await runSql(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${core.id}'::uuid, '${general}'::uuid, 'Old thread', 'still here', '${TAG}', 'active')`);

  for (const [name, who] of [...SELF_PACED(), ['gold_live', gold]]) {
    const { data } = await who.db.from('community_posts')
      .select('id,title').eq('space_id', general);
    assert.ok(data.length >= 1, `${name} must still read historical General content`);
  }
});

test('an author can never un-hide a post an admin hid', async () => {
  const goldSpace = await spaceIdFor('gold', '2026-08');
  const postId = await sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${gold.id}'::uuid, '${goldSpace}'::uuid, 'Moderated', 'x', '${TAG}', 'hidden')
    returning id::text`);

  await expectDenied(
    gold.db.from('community_posts').update({ status: 'active' }).eq('id', postId).select(),
    'restoring an admin-hidden post',
  );
});

// ── Leak surfaces ────────────────────────────────────────────────────────────

test('the mention directory is refused in General and scoped in a cohort', async () => {
  const general = await generalSpaceId();
  const goldSpace = await spaceIdFor('gold', '2026-08');

  const { data: inGeneral } = await gold.db.rpc('search_community_members',
    { p_query: 'a', p_space_id: general });
  assert.deepEqual(inGeneral || [], [], 'D2: nobody is mentionable in an announcement space');

  const { data: noSpace } = await gold.db.rpc('search_community_members', { p_query: 'Gina' });
  assert.deepEqual(noSpace || [], [], 'a null space must not default to General');

  const { data: short } = await gold.db.rpc('search_community_members',
    { p_query: 'G', p_space_id: goldSpace });
  assert.deepEqual(short || [], [], 'a one-character query cannot walk the roster');

  // A self-paced member has no create rights anywhere, so no directory at all.
  const { data: forCore } = await core.db.rpc('search_community_members',
    { p_query: 'Gina', p_space_id: goldSpace });
  assert.deepEqual(forCore || [], [], 'no create rights, no roster');
});

test('a member cannot forge a notification for themselves', async () => {
  await expectDenied(
    gold.db.from('community_notifications').insert({
      user_id: gold.id, kind: 'mention', post_id: null,
    }),
    'forging a notification',
  );
});

test('an EXPIRED member can no longer write, edit, or react', async () => {
  const goldSpace = await spaceIdFor('gold', '2026-08');
  const postId = await sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${gold.id}'::uuid, '${goldSpace}'::uuid, 'Before expiry', 'x', '${TAG}', 'active')
    returning id::text`);

  await runSql(`
    update public.subscriptions
       set ends_at = now() - interval '10 days', grace_ends_at = now() - interval '7 days'
     where user_id = '${gold.id}'::uuid`);

  await expectDenied(
    gold.db.from('community_posts').insert({
      author_id: gold.id, space_id: goldSpace, title: 'After expiry',
      body: 'x', tag_slug: TAG, status: 'active',
    }),
    'expired member posting');

  // #28's write-gate: even withdrawing own content is refused once expired.
  await expectDenied(
    gold.db.from('community_posts').update({ status: 'deleted' }).eq('id', postId).select(),
    'expired member editing own post');

  await expectDenied(
    gold.db.from('community_reactions').insert({
      user_id: gold.id, post_id: postId, reaction_type: 'like',
    }),
    'expired member reacting');
});

test('an anonymous visitor sees no community content and cannot write', async () => {
  const general = await generalSpaceId();
  await adminPost(general, 'Public-looking announcement');

  const anon = anonClient();
  for (const t of ['community_posts', 'community_comments', 'community_spaces',
    'community_reactions', 'community_tags', 'community_notifications']) {
    const { data, error } = await anon.from(t).select('*').limit(5);
    assert.ok(error || (data || []).length === 0, `anon must not read ${t}`);
  }
  await expectDenied(
    anon.from('community_posts').insert({
      author_id: '00000000-0000-0000-0000-000000000000', space_id: general,
      title: 'x', body: 'x', tag_slug: TAG, status: 'active',
    }),
    'anon posting');
});

test('community_write_denial explains a refusal without granting anything', async () => {
  const general = await generalSpaceId();
  const goldSpace = await spaceIdFor('gold', '2026-08');

  const { data: g } = await core.db.rpc('community_write_denial',
    { p_space_id: general, p_kind: 'post' });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'announcement_space', 'the UI can say why, honestly');

  const { data: notMine } = await core.db.rpc('community_write_denial',
    { p_space_id: goldSpace, p_kind: 'post' });
  assert.equal(notMine.allowed, false);
  assert.equal(notMine.reason, 'not_a_member');

  const { data: ok } = await gold.db.rpc('community_write_denial',
    { p_space_id: goldSpace, p_kind: 'post' });
  assert.equal(ok.allowed, true, 'and confirms the case that IS allowed');
});

test('my_community_spaces reports capabilities the database will actually honour', async () => {
  // If the RPC said canPost where RLS refuses, the UI would offer an action that
  // fails. This asserts the two agree, per space, per plan.
  for (const [name, who] of [['core', core], ['gold', gold], ['vip', vip]]) {
    const { data: spaces, error } = await who.db.rpc('my_community_spaces');
    assert.equal(error, null, `${name}: ${error && error.message}`);

    for (const sp of spaces) {
      const { data: post } = await who.db.from('community_posts')
        .insert({
          author_id: who.id, space_id: sp.id, title: `probe ${name}`,
          body: 'x', tag_slug: TAG, status: 'active',
        }).select('id');
      const actuallyPosted = Array.isArray(post) && post.length === 1;
      assert.equal(actuallyPosted, sp.can_post,
        `${name} in ${sp.kind}: RPC says can_post=${sp.can_post}, database says ${actuallyPosted}`);
      if (actuallyPosted) {
        await runSql(`delete from public.community_posts where id = '${post[0].id}'::uuid`);
      }
    }
  }
});
