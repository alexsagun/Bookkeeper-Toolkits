// test-db/communityRls.dbtest.mjs — the plan-gated community (#36).
//
// This is the business rule the whole feature exists for:
//
//   In Discord, self-paced students ask questions freely, and the support load
//   lands on one person. Here, the DATABASE refuses the write. Hiding the
//   button is a UI nicety; these tests bypass the UI entirely and send the
//   request supabase-js would send, as a real signed-in member.
//
// ★ D2 IS RETIRED AS A SPACE-WIDE RULE (#40). It used to read "General is
//   announcement-only for EVERY plan — including VIP", pinned by a CHECK. #40
//   dropped that deliberately and on the record, and moved the intent one level
//   down: #announcements is kind='announcement', where member_posting=false is
//   true BY CHECK rather than by policy prose. The tests below are restated for
//   that, not deleted — General now accepts posts and #announcements still does
//   not. Reactions stay on for everyone, as before.
//
// ★ #39 (three-plan catalog): the catalog is sampler / silver_self_paced / vip,
//   and VIP is the only cohort segment. The Core and Gold personas are gone
//   with their plans — see the note where the Gold-vs-VIP test used to be.
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

let admin, sampler, silver, vip;

before(async () => {
  admin = await makePersona('c-admin', { isAdmin: true, fullName: 'Alex Admin' });
  sampler = await makePersona('c-sampler', { fullName: 'Sam Sampler' });
  silver = await makePersona('c-silver', { fullName: 'Silvia Silver' });
  vip = await makePersona('c-vip', { fullName: 'Vera Vip' });
});

beforeEach(async () => {
  await resetShadow();
  await makeBatch('2026-08', { startsOn: STARTED });
  await seedMember(sampler, { planKey: 'sampler', days: 60 });
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60 });
  await seedMember(vip, { planKey: 'vip', days: 180, startBatchCode: '2026-08', seats: 1 });
});

after(async () => { await resetShadow(); });

/** The cohort lounge — the channel the mention/denial tests now scope to. */
async function cohortLoungeId() {
  return sqlScalar(`
    select ch.id::text from public.community_channels ch
      join public.community_spaces sp on sp.id = ch.space_id
      join public.batches b on b.id = sp.batch_id
     where b.code = '2026-08' and ch.slug = 'lounge'`);
}

/** Post an announcement into a space as the admin, returning its id. */
async function adminPost(spaceId, title = 'Announcement') {
  return sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${admin.id}'::uuid, '${spaceId}'::uuid, '${title}', 'body text', '${TAG}', 'active')
    returning id::text`);
}

// Both surviving plans that buy no cohort. #39 removed the third
// (core_self_paced); silver_self_paced is now the full-access self-paced plan.
const SELF_PACED = () => [
  ['sampler', sampler],
  ['silver_self_paced', silver],
];

// ── D2: nobody writes in General ─────────────────────────────────────────────

// ★ RESTATED FOR #40, not deleted. Under #36 this asserted that NO plan could
//   post in General, because D2 was a space-wide prohibition. #40 retired that
//   and moved the rule onto the channel, so the honest assertion is now:
//   General accepts posts, and #announcements still does not. The channel-level
//   matrix lives in test-db/communityChannels.dbtest.mjs.
test('#40: General accepts member posts, but #announcements still does not', async () => {
  const general = await generalSpaceId();
  const ann = await sqlScalar(`
    select ch.id::text from public.community_channels ch
     where ch.space_id = '${general}'::uuid and ch.slug = 'announcements'`);

  for (const [name, who] of [...SELF_PACED(), ['vip', vip]]) {
    // A post with no channel_id lands in the space default (#general-discussion).
    const ok = await who.db.from('community_posts').insert({
      author_id: who.id, space_id: general, title: 'Question!',
      body: 'How do I reconcile this?', tag_slug: TAG, status: 'active',
    }).select('id');
    assert.equal(ok.error, null,
      `${name} should be able to post in General since #40: ${ok.error && ok.error.message}`);

    await expectDenied(
      who.db.from('community_posts').insert({
        author_id: who.id, channel_id: ann, title: 'Me too',
        body: 'Adding to the announcement', tag_slug: TAG, status: 'active',
      }).select('id'),
      `${name} posting in #announcements`,
    );
  }

  assert.equal(
    await sqlScalar(`select count(*)::int from public.community_posts where channel_id = '${ann}'::uuid`),
    0, 'not one member post landed in #announcements');
});

// Also restated: replies are refused because the ANNOUNCEMENT CHANNEL has them
// off (and its posts are born comments_locked), not because the space is closed.
test('#40: replies are still refused on an announcement, by the channel', async () => {
  const general = await generalSpaceId();
  const ann = await sqlScalar(`
    select ch.id::text from public.community_channels ch
     where ch.space_id = '${general}'::uuid and ch.slug = 'announcements'`);
  const postId = await sqlScalar(`
    insert into public.community_posts (author_id, author_name, title, body, tag_slug, channel_id)
    values ('${admin.id}', 'Alex Admin', 'Welcome to August', 'body', '${TAG}', '${ann}'::uuid)
    returning id::text`);

  for (const [name, who] of [...SELF_PACED(), ['vip', vip]]) {
    await expectDenied(
      who.db.from('community_comments').insert({
        author_id: who.id, post_id: postId, body: 'Can you explain?', status: 'active',
      }).select('id'),
      `${name} replying to an announcement`,
    );
  }

  assert.equal(
    await sqlScalar(`select count(*)::int from public.community_comments where post_id = '${postId}'::uuid`),
    0, 'the announcement has no replies');
});

test('D2: EVERY plan can read General and react — and un-react', async () => {
  const general = await generalSpaceId();
  const postId = await adminPost(general, 'Reactable');

  for (const [name, who] of [...SELF_PACED(), ['vip', vip]]) {
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

// ★ REGRESSION (#43). community_reactions_own_delete was scoped by #33
//   (approved + enrolled + space), reduced by #36 to a bare
//   `user_id = auth.uid()`, and skipped by #40 while its two named siblings —
//   community_post_tags_own_delete and community_attachments_own_delete — were
//   moved to the channel model. Nothing in this suite noticed, because every
//   other reaction test uses a CURRENT member, for whom the two versions behave
//   identically. This is the case that separates them.
test('#43: an EXPIRED member cannot delete a reaction they left while enrolled', async () => {
  const general = await generalSpaceId();
  const postId = await adminPost(general, 'Reactable');

  // React while the term is live...
  const { error: reactErr } = await silver.db.from('community_reactions')
    .insert({ user_id: silver.id, post_id: postId, reaction_type: 'like' });
  assert.equal(reactErr, null, `seeding the reaction failed: ${reactErr && reactErr.message}`);

  // ...then let the term lapse past its grace window.
  await seedMember(silver, { planKey: 'silver_self_paced', days: 60, expired: true });

  await expectDenied(
    silver.db.from('community_reactions').delete()
      .eq('user_id', silver.id).eq('post_id', postId),
    'an expired member deleting their own reaction',
  );

  assert.equal(
    await sqlScalar(`select count(*)::int from public.community_reactions where post_id = '${postId}'::uuid`),
    1, 'the reaction survives — an expired term is a read-only one, writes included');
});

test('the admin can still post announcements in General', async () => {
  const general = await generalSpaceId();
  const { error } = await admin.db.from('community_posts').insert({
    author_id: admin.id, space_id: general, title: 'August kickoff',
    body: 'Live call Thursday', tag_slug: TAG, status: 'active',
  });
  assert.equal(error, null, `admin post failed: ${error && error.message}`);
});

// ── The cohort space: VIP holds the full forum, and only there ───────────────

test('a VIP member holds the full forum inside their own cohort space', async () => {
  const vipSpace = await spaceIdFor('vip', '2026-08');

  const { data: post, error: postErr } = await vip.db.from('community_posts')
    .insert({
      author_id: vip.id, space_id: vipSpace, title: 'My reconciliation question',
      body: 'Stuck on a bank feed', tag_slug: TAG, status: 'active',
    }).select('id').single();
  assert.equal(postErr, null, `vip post failed: ${postErr && postErr.message}`);

  const { error: cErr } = await vip.db.from('community_comments')
    .insert({ author_id: vip.id, post_id: post.id, body: 'Following up', status: 'active' });
  assert.equal(cErr, null, `vip reply failed: ${cErr && cErr.message}`);

  const { error: rErr } = await vip.db.from('community_reactions')
    .insert({ user_id: vip.id, post_id: post.id, reaction_type: 'helpful' });
  assert.equal(rErr, null, `vip reaction failed: ${rErr && rErr.message}`);
});

// ★ REMOVED by #39: 'a Gold member cannot write into the VIP space of the SAME
//   cohort'. It existed to prove that two premium segments sharing one batch are
//   still separated — i.e. that the space check is not merely a batch-id check.
//   #39 deleted the Gold segment, so a batch now has exactly ONE cohort space and
//   that scenario cannot be constructed at all; re-homing it would have produced
//   a test that passes because its premise is gone. The general form of the claim
//   — a member who does not hold a seat in a space can neither write, read, nor
//   react there — is still asserted by the next test.

test('a self-paced member cannot write into a cohort space they are not in', async () => {
  const vipSpace = await spaceIdFor('vip', '2026-08');
  const vipPost = await adminPost(vipSpace, 'Cohort material');

  for (const [name, who] of SELF_PACED()) {
    await expectDenied(
      who.db.from('community_posts').insert({
        author_id: who.id, space_id: vipSpace, title: 'Question',
        body: 'x', tag_slug: TAG, status: 'active',
      }),
      `${name} posting into a VIP cohort`,
    );
    await expectDenied(
      who.db.from('community_comments').insert({
        author_id: who.id, post_id: vipPost, body: 'x', status: 'active',
      }),
      `${name} replying in a VIP cohort`,
    );
    await expectDenied(
      who.db.from('community_reactions').insert({
        user_id: who.id, post_id: vipPost, reaction_type: 'like',
      }),
      `${name} reacting on a VIP post`,
    );

    const { data: seen } = await who.db.from('community_posts').select('id').eq('id', vipPost);
    assert.deepEqual(seen, [], `${name} must not read cohort content either`);
  }
});

// ── Forgery attempts ─────────────────────────────────────────────────────────

test('a member cannot forge author_id to post as somebody else', async () => {
  const vipSpace = await spaceIdFor('vip', '2026-08');
  await expectDenied(
    vip.db.from('community_posts').insert({
      author_id: admin.id, space_id: vipSpace, title: 'Posted as Alex',
      body: 'impersonation', tag_slug: TAG, status: 'active',
    }),
    'forging author_id',
  );
});

test('a member cannot forge space_id to publish a cohort post to everyone', async () => {
  const general = await generalSpaceId();
  await expectDenied(
    vip.db.from('community_posts').insert({
      author_id: vip.id, space_id: general, title: 'Broadcast',
      body: 'to every plan', tag_slug: TAG, status: 'active',
    }),
    'forging space_id to General',
  );
});

test('a member cannot post under an admin-only tag', async () => {
  const vipSpace = await spaceIdFor('vip', '2026-08');
  const adminTag = await sqlScalar(
    `select slug from public.community_tags where admin_only limit 1`);
  await expectDenied(
    vip.db.from('community_posts').insert({
      author_id: vip.id, space_id: vipSpace, title: 'Fake announcement',
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
    values ('${silver.id}'::uuid, '${general}'::uuid, 'Old question', 'from before D2', '${TAG}', 'active')
    returning id::text`);

  // Editing it (keeping it published) needs create rights, which D2 gives no
  // plan in an announcement space.
  await expectDenied(
    silver.db.from('community_posts').update({ body: 'edited' }).eq('id', legacyPost).select(),
    'editing a General post without post rights',
  );

  // Withdrawing it is always allowed in a space you belong to.
  //
  // Note the missing .select(): once status = 'deleted' the row no longer
  // satisfies the READ policy, so a returning-select comes back empty even
  // though the write succeeded. Asserting on the returned rows here would fail
  // against a perfectly correct database — check the stored state instead.
  const { error } = await silver.db.from('community_posts')
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
    values ('${silver.id}'::uuid, '${general}'::uuid, 'Old thread', 'still here', '${TAG}', 'active')`);

  for (const [name, who] of [...SELF_PACED(), ['vip', vip]]) {
    const { data } = await who.db.from('community_posts')
      .select('id,title').eq('space_id', general);
    assert.ok(data.length >= 1, `${name} must still read historical General content`);
  }
});

test('an author can never un-hide a post an admin hid', async () => {
  const vipSpace = await spaceIdFor('vip', '2026-08');
  const postId = await sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${vip.id}'::uuid, '${vipSpace}'::uuid, 'Moderated', 'x', '${TAG}', 'hidden')
    returning id::text`);

  await expectDenied(
    vip.db.from('community_posts').update({ status: 'active' }).eq('id', postId).select(),
    'restoring an admin-hidden post',
  );
});

// ── Leak surfaces ────────────────────────────────────────────────────────────

test('the mention directory is refused in General and scoped in a cohort', async () => {
  const general = await generalSpaceId();
  const vipSpace = await spaceIdFor('vip', '2026-08');

  // A real, 2+ character name of somebody who IS in the caller's spaces, so the
  // empty result is the announcement-space rule and not the min-length guard.
  const { data: inGeneral } = await vip.db.rpc('search_community_members',
    { p_query: 'Vera', p_space_id: general });
  assert.deepEqual(inGeneral || [], [], 'D2: nobody is mentionable in an announcement space');

  const { data: noSpace } = await vip.db.rpc('search_community_members', { p_query: 'Vera' });
  assert.deepEqual(noSpace || [], [], 'a null space must not default to General');

  const { data: short } = await vip.db.rpc('search_community_members',
    { p_query: 'V', p_space_id: vipSpace });
  assert.deepEqual(short || [], [], 'a one-character query cannot walk the roster');

  // A self-paced member has no create rights anywhere, so no directory at all.
  const { data: forSilver } = await silver.db.rpc('search_community_members',
    { p_query: 'Vera', p_space_id: vipSpace });
  assert.deepEqual(forSilver || [], [], 'no create rights, no roster');
});

test('a member cannot forge a notification for themselves', async () => {
  await expectDenied(
    vip.db.from('community_notifications').insert({
      user_id: vip.id, kind: 'mention', post_id: null,
    }),
    'forging a notification',
  );
});

test('an EXPIRED member can no longer write, edit, or react', async () => {
  const vipSpace = await spaceIdFor('vip', '2026-08');
  const postId = await sqlScalar(`
    insert into public.community_posts (author_id, space_id, title, body, tag_slug, status)
    values ('${vip.id}'::uuid, '${vipSpace}'::uuid, 'Before expiry', 'x', '${TAG}', 'active')
    returning id::text`);

  await runSql(`
    update public.subscriptions
       set ends_at = now() - interval '10 days', grace_ends_at = now() - interval '7 days'
     where user_id = '${vip.id}'::uuid`);

  await expectDenied(
    vip.db.from('community_posts').insert({
      author_id: vip.id, space_id: vipSpace, title: 'After expiry',
      body: 'x', tag_slug: TAG, status: 'active',
    }),
    'expired member posting');

  // #28's write-gate: even withdrawing own content is refused once expired.
  await expectDenied(
    vip.db.from('community_posts').update({ status: 'deleted' }).eq('id', postId).select(),
    'expired member editing own post');

  await expectDenied(
    vip.db.from('community_reactions').insert({
      user_id: vip.id, post_id: postId, reaction_type: 'like',
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

// ★ This replaces a test that called the SPACE-level community_write_denial(),
//   which #40 DROPped — `scripts/audit-db.mjs` even asserts it is gone. The old
//   test did not merely stop testing anything: the RPC returned
//   { data: null, error: PGRST202 } and `g.allowed` threw a TypeError, so the
//   whole suite crashed before reaching everything after it. Its neighbours were
//   restated for #40; this one was missed.
//
//   What it protects is worth having: community_channel_write_denial() is the
//   source of every sentence a member reads after a 42501, and it must explain a
//   refusal WITHOUT becoming an oracle for rooms they cannot see. An invisible
//   channel must report exactly as a nonexistent one does.
test('community_channel_write_denial explains a refusal without granting anything', async () => {
  const general = await generalSpaceId();
  const chanIn = (slug) => sqlScalar(`
    select ch.id::text from public.community_channels ch
     where ch.space_id = '${general}'::uuid and ch.slug = '${slug}'`);
  const ann = await chanIn('announcements');
  const talk = await chanIn('general-discussion');
  const vipLounge = await cohortLoungeId();

  const { data: annDenial, error: annErr } = await silver.db
    .rpc('community_channel_write_denial', { p_channel_id: ann, p_kind: 'post' });
  assert.equal(annErr, null, annErr && annErr.message);
  assert.equal(annDenial.allowed, false, 'members cannot post in an announcement channel');
  assert.equal(annDenial.reason, 'announcement_channel', 'and the UI can say why, honestly');

  // A private cohort room the caller is not in must be indistinguishable from a
  // channel that does not exist — naming it would confirm the cohort exists.
  const { data: notMine } = await silver.db
    .rpc('community_channel_write_denial', { p_channel_id: vipLounge, p_kind: 'post' });
  assert.equal(notMine.allowed, false, 'silver cannot write in a VIP cohort room');
  assert.equal(notMine.reason, 'no_such_channel',
    'an invisible channel must report exactly as a nonexistent one does');

  const { data: nowhere } = await silver.db.rpc('community_channel_write_denial', {
    p_channel_id: '00000000-0000-0000-0000-000000000000', p_kind: 'post',
  });
  assert.equal(nowhere.reason, notMine.reason,
    'same reason for invisible and nonexistent — otherwise this is a membership oracle');

  // And it must still confirm the cases that ARE allowed, or the client would
  // show a denial banner over a working composer.
  const { data: okGeneral } = await silver.db
    .rpc('community_channel_write_denial', { p_channel_id: talk, p_kind: 'post' });
  assert.equal(okGeneral.allowed, true, '#40 opened General to every plan');

  const { data: okVip } = await vip.db
    .rpc('community_channel_write_denial', { p_channel_id: vipLounge, p_kind: 'post' });
  assert.equal(okVip.allowed, true, 'a VIP may write in their own cohort room');
});

test('my_community_spaces reports capabilities the database will actually honour', async () => {
  // If the RPC said canPost where RLS refuses, the UI would offer an action that
  // fails. This asserts the two agree, per space, per plan.
  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vip', vip]]) {
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
