// test-db/communityChannels.dbtest.mjs — channel-level community isolation (#40).
//
// #40 moved the community from one feed per SPACE to many channels inside each
// space, and retired D2 as a space-wide rule. That means the thing standing
// between a Sampler member and a VIP cohort's private room is no longer "General
// is read-only" — it is the channel audience test. This suite proves the
// database enforces it, with no UI involved at all.
//
// The properties that matter, and would each be a real incident:
//   • a channel can only NARROW its space — never widen it
//   • an empty plan/batch mapping means NOBODY, not everybody
//   • batch A cannot read batch B, ever
//   • #announcements stays admin-post-only even though General is now open
//   • what my_community_sidebar() reports as can_post is what RLS actually allows
//
// ★ Every assertion goes through a persona's own JWT. runSql/sqlScalar are the
//   superuser and bypass RLS — fixtures only, never proof.
//
// Run: npm run test:db   (needs .env.test pointing at a shadow project)

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonClient,
  assertIds,
  channelIdFor,
  expectAppError,
  expectDenied,
  generalSpaceId,
  makeBatch,
  makePersona,
  resetShadow,
  seedMember,
  spaceIdFor,
  sqlScalar,
} from './_harness.mjs';

const STARTED = '2026-01-01';
const TAG = 'questions';          // one of the ten seeded community_tags
const BATCH_A = '2026-08';
const BATCH_B = '2026-09';

let admin, sampler, silver, vipA, vipB, expired;

before(async () => {
  admin   = await makePersona('ch-admin',   { isAdmin: true, fullName: 'Alex Admin' });
  sampler = await makePersona('ch-sampler', { fullName: 'Sam Sampler' });
  silver  = await makePersona('ch-silver',  { fullName: 'Silvia Silver' });
  vipA    = await makePersona('ch-vip-a',   { fullName: 'Vera VipA' });
  vipB    = await makePersona('ch-vip-b',   { fullName: 'Vince VipB' });
  expired = await makePersona('ch-expired', { fullName: 'Ellie Expired' });
});

beforeEach(async () => {
  await resetShadow();
  await makeBatch(BATCH_A, { startsOn: STARTED });
  await makeBatch(BATCH_B, { startsOn: STARTED });
  await seedMember(sampler, { planKey: 'sampler', days: 60 });
  await seedMember(silver,  { planKey: 'silver_self_paced', days: 60 });
  await seedMember(vipA,    { planKey: 'vip', days: 180, startBatchCode: BATCH_A, seats: 1 });
  await seedMember(vipB,    { planKey: 'vip', days: 180, startBatchCode: BATCH_B, seats: 1 });
  await seedMember(expired, { planKey: 'silver_self_paced', days: 60, expired: true });
});

after(async () => { await resetShadow(); });

// ── helpers ────────────────────────────────────────────────────────────

/** Channel ids the persona's own JWT can actually see. */
async function visibleChannelIds(who) {
  const { data, error } = await who.db.rpc('my_community_sidebar');
  assert.equal(error, null, `sidebar failed for ${who.label}: ${error && error.message}`);
  return (data || []).map((r) => r.channel_id);
}

async function sidebarRow(who, channelId) {
  const { data } = await who.db.rpc('my_community_sidebar');
  return (data || []).find((r) => r.channel_id === channelId) || null;
}

/** Create a channel as the admin, through the real RPC. */
async function makeChannel(spaceId, over = {}) {
  const { data, error } = await admin.db.rpc('admin_save_community_channel', {
    p_id: null,
    p_space_id: spaceId,
    p_category_id: await sqlScalar(
      `select id::text from public.community_channel_categories
        where space_id = '${spaceId}' order by position limit 1`),
    p_slug: over.slug || 'probe',
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
  assert.equal(error, null, `channel create failed: ${error && error.message}`);
  return data;
}

const adminPost = (channelId, title) => sqlScalar(`
  insert into public.community_posts (author_id, author_name, title, body, tag_slug, channel_id)
  values ('${admin.id}', 'Alex Admin', '${title}', 'body', '${TAG}', '${channelId}')
  returning id::text`);

// ── seeding ────────────────────────────────────────────────────────────

test('every space is seeded with channels, and a new cohort gets its own', async () => {
  const gen = await generalSpaceId();
  const genChannels = await sqlScalar(
    `select count(*)::int from public.community_channels where space_id = '${gen}'`);
  assert.equal(Number(genChannels), 6, 'General seeds six channels');

  const cohort = await spaceIdFor('vip', BATCH_A);
  const cohortChannels = await sqlScalar(
    `select count(*)::int from public.community_channels where space_id = '${cohort}'`);
  assert.equal(Number(cohortChannels), 2, 'a cohort space seeds lounge + coaching-questions');

  // The batch trigger, not a migration one-off, is what guarantees this.
  await makeBatch('2026-11', { startsOn: STARTED });
  const fresh = await spaceIdFor('vip', '2026-11');
  assert.equal(
    Number(await sqlScalar(`select count(*)::int from public.community_channels where space_id = '${fresh}'`)),
    2, 'a brand-new batch gets its channels automatically');
});

// ── discovery: channels NARROW, never widen ────────────────────────────

test('a self-paced member sees General channels and no cohort channel at all', async () => {
  const gen = await generalSpaceId();
  for (const [name, who] of [['sampler', sampler], ['silver', silver]]) {
    const ids = await visibleChannelIds(who);
    assert.ok(ids.length >= 6, `${name} should see the General channels`);
    const leaked = Number(await sqlScalar(`
      select count(*)::int from public.community_channels ch
       where ch.space_id <> '${gen}'
         and ch.id::text = any(array[${ids.map((i) => `'${i}'`).join(',') || `''`}])`));
    assert.equal(leaked, 0, `${name} must not discover any cohort channel`);
  }
});

test('a VIP member reaches their own cohort rooms and never the neighbouring batch', async () => {
  const mine = await spaceIdFor('vip', BATCH_A);
  const theirs = await spaceIdFor('vip', BATCH_B);
  const ids = await visibleChannelIds(vipA);

  const mineCount = Number(await sqlScalar(`
    select count(*)::int from public.community_channels
     where space_id = '${mine}' and id::text = any(array[${ids.map((i) => `'${i}'`).join(',')}])`));
  assert.equal(mineCount, 2, 'VIP A sees both of their own cohort channels');

  const theirsCount = Number(await sqlScalar(`
    select count(*)::int from public.community_channels
     where space_id = '${theirs}' and id::text = any(array[${ids.map((i) => `'${i}'`).join(',')}])`));
  assert.equal(theirsCount, 0, 'VIP A must not see batch B channels');
});

// ── audience modes ─────────────────────────────────────────────────────

test('an empty plan mapping makes a channel invisible to everyone but admins', async () => {
  const gen = await generalSpaceId();
  // The RPC refuses to CREATE one empty, so build it then strip the mapping —
  // which is exactly the state a later plan deletion would leave behind.
  const id = await makeChannel(gen, { slug: 'plan-probe', audience_mode: 'plans', plan_keys: ['vip'] });
  await sqlScalar(`delete from public.community_channel_plans where channel_id = '${id}' returning 1`);

  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vipA', vipA]]) {
    assert.ok(!(await visibleChannelIds(who)).includes(id),
      `${name} must not see a channel whose audience is empty`);
  }
  assert.ok((await visibleChannelIds(admin)).includes(id), 'the admin still manages it');
});

test('the RPC refuses to create a channel nobody could see', async () => {
  const gen = await generalSpaceId();
  await expectAppError(
    admin.db.rpc('admin_save_community_channel', {
      p_id: null, p_space_id: gen,
      p_category_id: await sqlScalar(
        `select id::text from public.community_channel_categories where space_id = '${gen}' order by position limit 1`),
      p_slug: 'empty-probe', p_name: 'empty-probe', p_topic: null, p_kind: 'text',
      p_audience_mode: 'plans', p_plan_keys: [], p_batch_ids: [],
      p_member_posting: true, p_member_comments: true,
      p_member_reactions: true, p_member_attachments: true,
    }),
    'CHANNEL_AUDIENCE_EMPTY', 'creating a channel with no audience');
});

test('a plan-scoped channel admits exactly the listed plans', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'vip-corner', audience_mode: 'plans', plan_keys: ['vip'] });
  assert.ok((await visibleChannelIds(vipA)).includes(id), 'vip is on the list');
  assert.ok(!(await visibleChannelIds(sampler)).includes(id), 'sampler is not');
  assert.ok(!(await visibleChannelIds(silver)).includes(id), 'silver is not');
});

test('a batch-scoped channel admits only that cohort', async () => {
  const gen = await generalSpaceId();
  const batchA = await sqlScalar(`select id::text from public.batches where code = '${BATCH_A}'`);
  const id = await makeChannel(gen, { slug: 'aug-only', audience_mode: 'batches', batch_ids: [batchA] });
  assert.ok((await visibleChannelIds(vipA)).includes(id), 'batch A is entitled');
  assert.ok(!(await visibleChannelIds(vipB)).includes(id), 'batch B is not');
  assert.ok(!(await visibleChannelIds(sampler)).includes(id), 'a batch-less plan is not');
});

test('plans_and_batches is an INTERSECTION — both must match', async () => {
  const gen = await generalSpaceId();
  const batchA = await sqlScalar(`select id::text from public.batches where code = '${BATCH_A}'`);
  // Right batch, wrong plan: silver is not VIP, so nobody in batch A but a VIP qualifies.
  const id = await makeChannel(gen, {
    slug: 'vip-aug', audience_mode: 'plans_and_batches',
    plan_keys: ['vip'], batch_ids: [batchA],
  });
  assert.ok((await visibleChannelIds(vipA)).includes(id), 'vip in batch A qualifies');
  assert.ok(!(await visibleChannelIds(vipB)).includes(id), 'vip in batch B fails the batch half');
  assert.ok(!(await visibleChannelIds(silver)).includes(id), 'silver fails the plan half');
});

test('an admins_only channel is invisible to every member', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'staff-room', audience_mode: 'admins_only' });
  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vipA', vipA]]) {
    assert.ok(!(await visibleChannelIds(who)).includes(id), `${name} must not see the staff room`);
  }
  assert.ok((await visibleChannelIds(admin)).includes(id));
});

test('archiving a channel hides it and stops new content', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'temporary' });
  assert.ok((await visibleChannelIds(sampler)).includes(id), 'visible while active');

  const { error } = await admin.db.rpc('admin_set_community_channel_status', { p_id: id, p_status: 'archived' });
  assert.equal(error, null, `archive failed: ${error && error.message}`);

  assert.ok(!(await visibleChannelIds(sampler)).includes(id), 'hidden once archived');
  await expectDenied(
    sampler.db.from('community_posts').insert({
      author_id: sampler.id, author_name: 'Sam Sampler', body: 'late', tag_slug: TAG, channel_id: id,
    }).select('id'), 'posting into an archived channel');
});

// ── D2, re-expressed per channel ───────────────────────────────────────

test('#announcements stays admin-post-only even though General is now open', async () => {
  const gen = await generalSpaceId();
  const ann = await channelIdFor('general', 'announcements');
  const talk = await channelIdFor('general', 'general-discussion');
  assert.ok(gen && ann && talk);

  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vipA', vipA]]) {
    // The whole point of #40: they CAN talk in General...
    const ok = await who.db.from('community_posts').insert({
      author_id: who.id, author_name: name, body: 'hello', tag_slug: TAG, channel_id: talk,
    });
    assert.equal(ok.error, null, `${name} should post in #general-discussion: ${ok.error && ok.error.message}`);

    // ...but never in the announcement channel.
    await expectDenied(who.db.from('community_posts').insert({
      author_id: who.id, author_name: name, body: 'me too', tag_slug: TAG, channel_id: ann,
    }), `${name} posting in #announcements`);
  }

  assert.equal(
    Number(await sqlScalar(`select count(*)::int from public.community_posts where channel_id = '${ann}'`)),
    0, 'not one member post landed in #announcements');
});

test('replies are refused in a comments-off channel but allowed in a normal one', async () => {
  const ann = await channelIdFor('general', 'announcements');
  const talk = await channelIdFor('general', 'general-discussion');
  const annPost = await adminPost(ann, 'Program update');
  const talkPost = await adminPost(talk, 'Say hello');

  await expectDenied(sampler.db.from('community_comments').insert({
    post_id: annPost, author_id: sampler.id, author_name: 'Sam Sampler', body: 'reply?',
  }).select('id'), 'replying to an announcement');

  const ok = await sampler.db.from('community_comments').insert({
    post_id: talkPost, author_id: sampler.id, author_name: 'Sam Sampler', body: 'hi',
  });
  assert.equal(ok.error, null, `sampler should reply in #general-discussion: ${ok.error && ok.error.message}`);
});

test('reactions stay on for everyone, including in #announcements', async () => {
  const ann = await channelIdFor('general', 'announcements');
  const post = await adminPost(ann, 'React to me');
  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vipA', vipA]]) {
    const { error } = await who.db.from('community_reactions')
      .insert({ post_id: post, user_id: who.id, reaction_type: 'like' });
    assert.equal(error, null, `${name} should be able to react: ${error && error.message}`);
  }
});

// ── content isolation ──────────────────────────────────────────────────

test('posts in an inaccessible channel are invisible, and so are their replies', async () => {
  const cohort = await spaceIdFor('vip', BATCH_A);
  const lounge = await sqlScalar(
    `select id::text from public.community_channels where space_id = '${cohort}' and slug = 'lounge'`);
  const post = await adminPost(lounge, 'Cohort only');
  await sqlScalar(`
    insert into public.community_comments (post_id, author_id, author_name, body)
    values ('${post}', '${admin.id}', 'Alex Admin', 'private reply') returning id::text`);

  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vipB', vipB]]) {
    const posts = await who.db.from('community_posts').select('id').eq('id', post);
    assertIds(posts.data || [], [], `${name} must not read a batch-A post`);
    const comments = await who.db.from('community_comments').select('id').eq('post_id', post);
    assertIds(comments.data || [], [], `${name} must not read batch-A replies`);
  }
  const ok = await vipA.db.from('community_posts').select('id').eq('id', post);
  assert.equal((ok.data || []).length, 1, 'the cohort member reads their own room');
});

test('reacting to a post in an inaccessible channel is refused', async () => {
  const cohort = await spaceIdFor('vip', BATCH_A);
  const lounge = await sqlScalar(
    `select id::text from public.community_channels where space_id = '${cohort}' and slug = 'lounge'`);
  const post = await adminPost(lounge, 'No reactions from outsiders');
  await expectDenied(
    vipB.db.from('community_reactions').insert({ post_id: post, user_id: vipB.id, reaction_type: 'like' }).select('id'), 'reacting across cohorts');
});

// ── forgery ────────────────────────────────────────────────────────────

test('a forged space_id cannot smuggle a post into a channel', async () => {
  // The guard DERIVES space_id from the channel, so the mismatch is corrected
  // and the row is then judged by the channel it actually names.
  const gen = await generalSpaceId();
  const cohort = await spaceIdFor('vip', BATCH_A);
  const lounge = await sqlScalar(
    `select id::text from public.community_channels where space_id = '${cohort}' and slug = 'lounge'`);

  await expectDenied(sampler.db.from('community_posts').insert({
    author_id: sampler.id, author_name: 'Sam Sampler', body: 'smuggled',
    tag_slug: TAG, channel_id: lounge, space_id: gen,
  }).select('id'), 'forging a General space onto a cohort channel');
});

test('a post that names a channel but a foreign author is refused', async () => {
  const talk = await channelIdFor('general', 'general-discussion');
  await expectDenied(sampler.db.from('community_posts').insert({
    author_id: admin.id, author_name: 'Alex Admin', body: 'not mine', tag_slug: TAG, channel_id: talk,
  }).select('id'), 'forging author_id');
});

test('an old client that sends no channel_id lands in the default room, not #announcements', async () => {
  const talk = await channelIdFor('general', 'general-discussion');
  const { data, error } = await sampler.db.from('community_posts')
    .insert({ author_id: sampler.id, author_name: 'Sam Sampler', body: 'legacy client', tag_slug: TAG })
    .select('id, channel_id').single();
  assert.equal(error, null, `a pre-#40 insert should still work: ${error && error.message}`);
  assert.equal(data.channel_id, talk, 'it lands in the writable default channel');
});

// ── leak surfaces ──────────────────────────────────────────────────────

test('the mention directory never names someone who cannot open the channel', async () => {
  const cohort = await spaceIdFor('vip', BATCH_A);
  const lounge = await sqlScalar(
    `select id::text from public.community_channels where space_id = '${cohort}' and slug = 'lounge'`);

  // A member of the room may search it...
  const mine = await vipA.db.rpc('search_community_members', { p_query: 'Vip', p_channel_id: lounge });
  assert.equal(mine.error, null, `search failed: ${mine.error && mine.error.message}`);
  const ids = (mine.data || []).map((r) => r.id);
  assert.ok(!ids.includes(vipB.id), 'batch B is not mentionable inside batch A');

  // ...and someone outside it gets nothing at all.
  const theirs = await sampler.db.rpc('search_community_members', { p_query: 'Vip', p_channel_id: lounge });
  assert.deepEqual(theirs.data || [], [], 'an outsider gets an empty directory, not a roster');
});

test('a notification for an unreachable channel is not readable', async () => {
  const cohort = await spaceIdFor('vip', BATCH_A);
  const lounge = await sqlScalar(
    `select id::text from public.community_channels where space_id = '${cohort}' and slug = 'lounge'`);
  const post = await adminPost(lounge, 'Private');
  // Forge a notification aimed at an outsider — the notify triggers would never
  // create this, which is exactly why the read policy must also refuse it.
  await sqlScalar(`
    insert into public.community_notifications
      (user_id, kind, actor_id, actor_name, post_id, post_title, space_id, channel_id)
    values ('${sampler.id}', 'mention', '${admin.id}', 'Alex Admin', '${post}',
            'Private', '${cohort}', '${lounge}') returning id::text`);

  const { data } = await sampler.db.from('community_notifications').select('id, post_title');
  assert.equal((data || []).length, 0, 'a notification about an unreachable channel stays hidden');
});

test('an expired member reads nothing and writes nothing', async () => {
  const talk = await channelIdFor('general', 'general-discussion');
  await adminPost(talk, 'Still here');
  const { data } = await expired.db.rpc('my_community_sidebar');
  assert.deepEqual(data || [], [], 'an expired member has no channels');
  await expectDenied(expired.db.from('community_posts').insert({
    author_id: expired.id, author_name: 'Ellie Expired', body: 'back?', tag_slug: TAG, channel_id: talk,
  }).select('id'), 'an expired member posting');
});

test('an anonymous visitor sees no channel and no post', async () => {
  const anon = anonClient();
  const talk = await channelIdFor('general', 'general-discussion');
  await adminPost(talk, 'Members only');
  const chans = await anon.from('community_channels').select('id');
  assert.equal((chans.data || []).length, 0, 'anonymous reads no channels');
  const posts = await anon.from('community_posts').select('id');
  assert.equal((posts.data || []).length, 0, 'anonymous reads no posts');
});

// ── admin operations ───────────────────────────────────────────────────

test('only admins can create, edit, reorder or archive a channel', async () => {
  const gen = await generalSpaceId();
  const id = await channelIdFor('general', 'general-discussion');
  const cat = await sqlScalar(
    `select id::text from public.community_channel_categories where space_id = '${gen}' order by position limit 1`);

  for (const [name, who] of [['sampler', sampler], ['vipA', vipA]]) {
    await expectAppError(who.db.rpc('admin_save_community_channel', {
      p_id: null, p_space_id: gen, p_category_id: cat, p_slug: 'sneaky', p_name: 'sneaky',
      p_topic: null, p_kind: 'text', p_audience_mode: 'space', p_plan_keys: [], p_batch_ids: [],
      p_member_posting: true, p_member_comments: true, p_member_reactions: true, p_member_attachments: true,
    }), 'FORBIDDEN', `${name} creating a channel`);

    await expectAppError(who.db.rpc('admin_set_community_channel_status', { p_id: id, p_status: 'archived' }),
      'FORBIDDEN', `${name} archiving a channel`);

    await expectAppError(who.db.rpc('admin_community_config'), 'FORBIDDEN', `${name} reading the config`);
  }
});

test('members cannot write channel rows or audience mappings directly', async () => {
  const gen = await generalSpaceId();
  const id = await channelIdFor('general', 'general-discussion');
  await expectDenied(
    sampler.db.from('community_channels').update({ member_posting: true }).eq('id', id),
    'a member editing a channel row');
  await expectDenied(
    sampler.db.from('community_channel_plans').insert({ channel_id: id, plan_key: 'sampler' }).select('id'), 'a member inserting an audience mapping');
  await expectDenied(
    sampler.db.from('community_channel_categories').insert({ space_id: gen, name: 'mine' }).select('id'), 'a member creating a category');
});

test('members cannot read who a private channel is limited to', async () => {
  const gen = await generalSpaceId();
  await makeChannel(gen, { slug: 'vip-corner-2', audience_mode: 'plans', plan_keys: ['vip'] });
  const { data } = await vipA.db.from('community_channel_plans').select('channel_id, plan_key');
  assert.equal((data || []).length, 0, 'the audience mapping is admin-only config');
});

test('the slug is a permalink — renaming a channel never moves it', async () => {
  const id = await channelIdFor('general', 'general-discussion');
  const { error } = await admin.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null,
    p_slug: 'totally-different', p_name: 'General chat', p_topic: 'renamed',
    p_kind: 'text', p_audience_mode: 'space', p_plan_keys: [], p_batch_ids: [],
    p_member_posting: true, p_member_comments: true, p_member_reactions: true, p_member_attachments: true,
  });
  assert.equal(error, null, `rename failed: ${error && error.message}`);
  const slug = await sqlScalar(`select slug from public.community_channels where id = '${id}'`);
  assert.equal(slug, 'general-discussion', 'the address survives a rename');
});

test('every channel change is written to the audit ledger', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'audited' });
  await admin.db.rpc('admin_set_community_channel_status', { p_id: id, p_status: 'archived' });
  const actions = await sqlScalar(`
    select string_agg(distinct action, ',' order by action)
      from public.community_channel_events where channel_id = '${id}'`);
  assert.match(actions || '', /channel_create/, 'creation is audited');
  assert.match(actions || '', /channel_archive/, 'archiving is audited');
});

// ── the sidebar tells the truth ────────────────────────────────────────

test('what the sidebar reports as can_post is what RLS actually allows', async () => {
  // The whole point of routing the UI through server capabilities: if these ever
  // disagree, a member sees a button whose submit is refused.
  for (const [name, who] of [['sampler', sampler], ['silver', silver], ['vipA', vipA]]) {
    const { data } = await who.db.rpc('my_community_sidebar');
    for (const row of data || []) {
      const attempt = await who.db.from('community_posts').insert({
        author_id: who.id, author_name: name, body: 'probe', tag_slug: TAG, channel_id: row.channel_id,
      }).select('id');
      const landed = !attempt.error && (attempt.data || []).length === 1;
      assert.equal(landed, row.can_post === true,
        `${name} in ${row.channel_name}: sidebar said can_post=${row.can_post}, RLS said ${landed}`);
      if (landed) {
        await sqlScalar(`delete from public.community_posts where id = '${attempt.data[0].id}' returning 1`);
      }
    }
  }
});

test('unread counts only rise for other people’s posts, and clear on open', async () => {
  const talk = await channelIdFor('general', 'general-discussion');
  await adminPost(talk, 'Something new');

  let row = await sidebarRow(sampler, talk);
  assert.ok(Number(row.unread_count) >= 1, 'an admin post shows as unread');

  const { error } = await sampler.db.rpc('mark_community_channel_read', { p_channel_id: talk });
  assert.equal(error, null, `mark read failed: ${error && error.message}`);

  row = await sidebarRow(sampler, talk);
  assert.equal(Number(row.unread_count), 0, 'opening the channel clears it');
});

test('a member cannot mark a channel read that they cannot open', async () => {
  const cohort = await spaceIdFor('vip', BATCH_A);
  const lounge = await sqlScalar(
    `select id::text from public.community_channels where space_id = '${cohort}' and slug = 'lounge'`);
  await expectAppError(
    sampler.db.rpc('mark_community_channel_read', { p_channel_id: lounge }),
    'COMMUNITY_ACCESS_DENIED', 'marking an unreachable channel read');
});

test('narrowing a channel takes access away from someone who had it', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'was-open' });
  assert.ok((await visibleChannelIds(sampler)).includes(id), 'open to begin with');

  const { error } = await admin.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null, p_slug: null, p_name: 'was-open',
    p_topic: null, p_kind: 'text', p_audience_mode: 'plans', p_plan_keys: ['vip'], p_batch_ids: [],
    p_member_posting: true, p_member_comments: true, p_member_reactions: true, p_member_attachments: true,
  });
  assert.equal(error, null, `narrowing failed: ${error && error.message}`);

  assert.ok(!(await visibleChannelIds(sampler)).includes(id), 'sampler loses it immediately');
  assert.ok((await visibleChannelIds(vipA)).includes(id), 'vip keeps it');
});
// ── rename-only saves (#41) ────────────────────────────────────────────

// ★ This is the case #41 exists for. The rail's Customize mode sends p_id +
//   p_name and NULL for everything else, meaning "leave this alone". #40 got
//   that wrong twice: it wiped the topic, and it refused outright on any
//   plan/batch-scoped channel. Both were invisible to the full-payload test
//   below it, which is exactly why this one sends the real argument set.
test('a rename-only save changes the name and nothing else', async () => {
  const gen = await generalSpaceId();
  const batchA = await sqlScalar(`select id::text from public.batches where code = '${BATCH_A}'`);
  const id = await makeChannel(gen, {
    slug: 'rename-probe', audience_mode: 'plans_and_batches',
    plan_keys: ['vip'], batch_ids: [batchA],
    member_reactions: false, member_attachments: false,
  });
  // Give it a topic the rename must not touch.
  await sqlScalar(`update public.community_channels
                      set topic = 'Keep this description'
                    where id = '${id}' returning 1`);

  const { error } = await admin.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null, p_slug: null,
    p_name: 'renamed-in-place', p_topic: null, p_kind: null, p_audience_mode: null,
    p_plan_keys: null, p_batch_ids: null, p_member_posting: null,
    p_member_comments: null, p_member_reactions: null, p_member_attachments: null,
  });
  assert.equal(error, null, `a rename must not fail on a scoped channel: ${error && error.message}`);

  const row = JSON.parse(await sqlScalar(`
    select to_jsonb(c)::text from public.community_channels c where c.id = '${id}'`));
  assert.equal(row.name, 'renamed-in-place', 'the name changed');
  assert.equal(row.topic, 'Keep this description', 'the topic survived the rename');
  assert.equal(row.audience_mode, 'plans_and_batches', 'the audience survived');
  assert.equal(row.slug, 'rename-probe', 'the slug is a permalink');
  assert.equal(row.member_reactions, false, 'member_reactions survived');
  assert.equal(row.member_attachments, false, 'member_attachments survived');
  assert.equal(
    Number(await sqlScalar(`select count(*)::int from public.community_channel_plans where channel_id = '${id}'`)),
    1, 'the plan mapping survived');
  assert.equal(
    Number(await sqlScalar(`select count(*)::int from public.community_channel_batches where channel_id = '${id}'`)),
    1, 'the batch mapping survived');
});

test('a rename does not write a permissions audit row', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'audit-probe' });
  const before = Number(await sqlScalar(`
    select count(*)::int from public.community_channel_events
     where channel_id = '${id}' and action = 'channel_permissions'`));

  await admin.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null, p_slug: null,
    p_name: 'audit-probe-renamed', p_topic: null, p_kind: null, p_audience_mode: null,
    p_plan_keys: null, p_batch_ids: null, p_member_posting: null,
    p_member_comments: null, p_member_reactions: null, p_member_attachments: null,
  });

  assert.equal(Number(await sqlScalar(`
    select count(*)::int from public.community_channel_events
     where channel_id = '${id}' and action = 'channel_permissions'`)),
    before, 'renaming is not a permissions change and must not be logged as one');
});

test('an explicit empty topic still clears it', async () => {
  const gen = await generalSpaceId();
  const id = await makeChannel(gen, { slug: 'clear-probe' });
  await sqlScalar(`update public.community_channels set topic = 'temporary' where id = '${id}' returning 1`);

  const { error } = await admin.db.rpc('admin_save_community_channel', {
    p_id: id, p_space_id: null, p_category_id: null, p_slug: null,
    p_name: 'clear-probe', p_topic: '', p_kind: null, p_audience_mode: null,
    p_plan_keys: null, p_batch_ids: null, p_member_posting: null,
    p_member_comments: null, p_member_reactions: null, p_member_attachments: null,
  });
  assert.equal(error, null, `clearing a topic should work: ${error && error.message}`);
  assert.equal(await sqlScalar(`select coalesce(topic,'<null>') from public.community_channels where id = '${id}'`),
    '<null>', 'an empty string clears the topic');
});
