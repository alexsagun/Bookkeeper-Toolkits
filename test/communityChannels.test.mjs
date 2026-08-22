// test/communityChannels.test.mjs — community channel audience + rights (#40).
//
// This suite exists because the audience rules live in two places: the SQL in
// db/2026-08-18-community-channels.sql (which decides) and
// src/lib/communityChannels.js (which decides what the UI shows). When they
// disagree, the member sees a control the database then refuses — the exact class
// of bug #40 was written to end.
//
// It answers "does this audience admit this member", NOT "is this member in the
// space" — L1 membership comes from the batch-entitlement ledger and is asserted
// in test-db/communityChannels.dbtest.mjs against real RLS.
//
// Run with: node --test

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIENCE_MODES,
  accessDiff,
  channelAccessSummary,
  channelAudienceAllows,
  channelDenialCopy,
  cohortLandingChannel,
  effectiveChannelCaps,
  groupChannelsByCategory,
  normalizeChannelSlug,
  pickInitialChannel,
  unreadLabel,
} from '../src/lib/communityChannels.js';

const SAMPLER = 'sampler';
const SILVER = 'silver_self_paced';
const VIP = 'vip';
const ALL_PLANS = [SAMPLER, SILVER, VIP];

const BATCH_A = '11111111-1111-1111-1111-111111111111';
const BATCH_B = '22222222-2222-2222-2222-222222222222';

// A member who is already inside the parent space — the only interesting case,
// since anyone outside it is refused by the space conjunct before we get here.
const member = (over) => ({ inSpace: true, memberPlanKey: SAMPLER, memberBatchIds: [], ...over });

// ── Audience modes ──────────────────────────────────────────────────────

test('space mode admits every member of the parent space', () => {
  for (const plan of ALL_PLANS) {
    assert.equal(
      channelAudienceAllows(member({ mode: 'space', memberPlanKey: plan })), true,
      `${plan} should reach a space-wide channel`,
    );
  }
});

test('admins_only admits no member, whatever their plan or cohort', () => {
  for (const plan of ALL_PLANS) {
    assert.equal(
      channelAudienceAllows(member({
        mode: 'admins_only', memberPlanKey: plan, memberBatchIds: [BATCH_A],
      })), false,
      `${plan} must not reach an admins_only channel`,
    );
  }
});

test('an admin reaches every mode, including archived channels', () => {
  for (const mode of AUDIENCE_MODES) {
    assert.equal(
      channelAudienceAllows({ mode, isAdmin: true, status: 'archived' }), true,
      `admin should reach ${mode}`,
    );
  }
});

test('plans mode admits exactly the listed plans', () => {
  const channel = { mode: 'plans', planKeys: [VIP] };
  assert.equal(channelAudienceAllows(member({ ...channel, memberPlanKey: VIP })), true);
  assert.equal(channelAudienceAllows(member({ ...channel, memberPlanKey: SILVER })), false);
  assert.equal(channelAudienceAllows(member({ ...channel, memberPlanKey: SAMPLER })), false);
});

test('batches mode admits an entitled cohort and refuses a neighbouring one', () => {
  const channel = { mode: 'batches', batchIds: [BATCH_A] };
  assert.equal(channelAudienceAllows(member({ ...channel, memberBatchIds: [BATCH_A] })), true);
  assert.equal(channelAudienceAllows(member({ ...channel, memberBatchIds: [BATCH_B] })), false,
    'batch B must never reach a batch A channel');
});

test('plans_and_batches is an INTERSECTION, not a union', () => {
  const channel = { mode: 'plans_and_batches', planKeys: [VIP], batchIds: [BATCH_A] };
  const cases = [
    [VIP, [BATCH_A], true, 'right plan and right batch'],
    [VIP, [BATCH_B], false, 'right plan, wrong batch'],
    [SILVER, [BATCH_A], false, 'wrong plan, right batch'],
    [SILVER, [BATCH_B], false, 'wrong plan, wrong batch'],
  ];
  for (const [plan, batches, expected, label] of cases) {
    assert.equal(
      channelAudienceAllows(member({ ...channel, memberPlanKey: plan, memberBatchIds: batches })),
      expected, label,
    );
  }
});

// ── Fail-closed behaviour ───────────────────────────────────────────────

test('an empty mapping means NOBODY, never everybody', () => {
  const empties = [
    { mode: 'plans', planKeys: [] },
    { mode: 'batches', batchIds: [] },
    { mode: 'plans_and_batches', planKeys: [], batchIds: [] },
    { mode: 'plans_and_batches', planKeys: [VIP], batchIds: [] },
    { mode: 'plans_and_batches', planKeys: [], batchIds: [BATCH_A] },
  ];
  for (const channel of empties) {
    assert.equal(
      channelAudienceAllows(member({ ...channel, memberPlanKey: VIP, memberBatchIds: [BATCH_A] })),
      false, `${channel.mode} with an empty mapping must admit nobody`,
    );
  }
});

test('a member with no live plan matches no plan-scoped channel', () => {
  assert.equal(
    channelAudienceAllows(member({ mode: 'plans', planKeys: [SAMPLER], memberPlanKey: null })),
    false, 'a null plan key must not match');
});

test('an archived channel admits no member', () => {
  assert.equal(
    channelAudienceAllows(member({ mode: 'space', status: 'archived' })), false);
});

test('space membership is never assumed — inSpace must be proven', () => {
  // Defaulting this to true would let a forgetful caller widen access.
  assert.equal(channelAudienceAllows({ mode: 'space' }), false, 'omitted inSpace fails closed');
  assert.equal(channelAudienceAllows({ mode: 'space', inSpace: false }), false);
});

test('an unrecognised audience mode fails closed', () => {
  for (const mode of ['', null, undefined, 'everyone', 'public', 'plans_or_batches']) {
    assert.equal(channelAudienceAllows(member({ mode })), false, `${String(mode)} must be refused`);
  }
});

// ── Effective capabilities ──────────────────────────────────────────────

test('server capabilities are used verbatim', () => {
  assert.deepEqual(
    effectiveChannelCaps({
      can_post: true, can_comment: true, can_react: true, can_attach: false,
    }),
    { canRead: true, canPost: true, canComment: true, canReact: true, canAttach: false },
  );
});

test('a missing or still-loading channel row grants nothing', () => {
  const closed = { canRead: false, canPost: false, canComment: false, canReact: false, canAttach: false };
  for (const row of [null, undefined, 0, '', 'channel', {}, { slug: 'general-discussion' }]) {
    assert.deepEqual(effectiveChannelCaps(row), closed,
      `${JSON.stringify(row)} must grant nothing`);
  }
});

test('only a literal true grants a right', () => {
  const caps = effectiveChannelCaps({
    can_post: 'yes', can_comment: 1, can_react: true, can_attach: null,
  });
  assert.equal(caps.canPost, false, 'a truthy string is not a boolean true');
  assert.equal(caps.canComment, false, 'a truthy number is not a boolean true');
  assert.equal(caps.canReact, true);
  assert.equal(caps.canAttach, false);
});

test('an announcement channel reads and reacts but never posts or comments', () => {
  const caps = effectiveChannelCaps({
    can_post: false, can_comment: false, can_react: true, can_attach: false,
  });
  assert.deepEqual(caps,
    { canRead: true, canPost: false, canComment: false, canReact: true, canAttach: false });
});

// ── Selection precedence ────────────────────────────────────────────────

const CHANNELS = [
  { channel_id: 'c1', channel_slug: 'announcements', is_default: false },
  { channel_id: 'c2', channel_slug: 'general-discussion', is_default: true },
  { channel_id: 'c3', channel_slug: 'lounge', is_default: false },
];

test('the URL wins over everything else', () => {
  const got = pickInitialChannel({
    urlSlug: 'lounge', storedSlug: 'announcements', channels: CHANNELS, defaultChannelId: 'c2',
  });
  assert.equal(got.channel_id, 'c3');
});

test('the stored preference wins when the URL names no channel', () => {
  const got = pickInitialChannel({
    storedSlug: 'announcements', channels: CHANNELS, defaultChannelId: 'c2',
  });
  assert.equal(got.channel_id, 'c1');
});

test('the server default wins when neither the URL nor storage applies', () => {
  assert.equal(pickInitialChannel({ channels: CHANNELS, defaultChannelId: 'c3' }).channel_id, 'c3');
});

test('an inaccessible or unknown slug falls back SILENTLY', () => {
  // Reporting "no such channel" would confirm a private room exists.
  const got = pickInitialChannel({
    urlSlug: 'vip-coaching', storedSlug: 'also-gone', channels: CHANNELS, defaultChannelId: 'c2',
  });
  assert.equal(got.channel_id, 'c2', 'falls through to the default, no error');
});

test('with no accessible channels at all, selection yields nothing', () => {
  assert.equal(pickInitialChannel({ urlSlug: 'lounge', channels: [] }), null);
  assert.equal(pickInitialChannel({}), null);
});

// ── Rail grouping ───────────────────────────────────────────────────────

test('grouping preserves RPC order and locks cohort categories', () => {
  const groups = groupChannelsByCategory([
    { category_id: 'k1', category_name: 'Start here', space_id: 's1', space_kind: 'general', channel_id: 'c1' },
    { category_id: 'k1', category_name: 'Start here', space_id: 's1', space_kind: 'general', channel_id: 'c2' },
    { category_id: 'k2', category_name: 'VIP - August 2026', space_id: 's2', space_kind: 'vip', batch_code: '2026-08', channel_id: 'c3' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].categoryName, 'Start here');
  assert.equal(groups[0].channels.length, 2);
  assert.equal(groups[0].isPrivate, false, 'General is not a private group');
  assert.equal(groups[1].isPrivate, true, 'a cohort group carries the lock');
  assert.equal(groups[1].batchCode, '2026-08');
});

test('grouping an empty sidebar yields no groups', () => {
  assert.deepEqual(groupChannelsByCategory([]), []);
  assert.deepEqual(groupChannelsByCategory(null), []);
});

// ── Slugs ───────────────────────────────────────────────────────────────

test('slugs are lowercased, hyphenated and bounded', () => {
  assert.equal(normalizeChannelSlug('QuickBooks Help'), 'quickbooks-help');
  assert.equal(normalizeChannelSlug('  Wins & Opportunities!  '), 'wins-opportunities');
  assert.equal(normalizeChannelSlug('a'.repeat(80)).length, 48);
});

test('a name with nothing sluggable yields no slug rather than a bad one', () => {
  for (const bad of ['', '   ', '!!!', '---', null, undefined, 42]) {
    assert.equal(normalizeChannelSlug(bad), '', `${String(bad)} has no valid slug`);
  }
});

// ── Unread badge ────────────────────────────────────────────────────────

test('unread counts are bounded at 99+', () => {
  assert.equal(unreadLabel(0), '');
  assert.equal(unreadLabel(1), '1');
  assert.equal(unreadLabel(99), '99');
  assert.equal(unreadLabel(100), '99+');
  assert.equal(unreadLabel(4821), '99+');
  assert.equal(unreadLabel(null), '');
  assert.equal(unreadLabel('nope'), '');
});

// ── Access summary ──────────────────────────────────────────────────────

test('the access summary names the audience and what they may do', () => {
  const s = channelAccessSummary({
    mode: 'plans_and_batches',
    planLabels: ['VIP'],
    batchLabels: ['August 2026 Batch'],
    memberPosting: true, memberComments: true, memberReactions: true,
  });
  assert.match(s, /VIP members who are also in August 2026 Batch/);
  assert.match(s, /post, comment and react/);
});

test('the summary never promises attachments the plan may not allow', () => {
  const s = channelAccessSummary({ mode: 'space', memberAttachments: true });
  assert.match(s, /only where the member plan allows them/i);
});

test('an unsatisfiable audience says so instead of describing rights', () => {
  const s = channelAccessSummary({ mode: 'plans', planLabels: [] });
  assert.match(s, /Nobody can see this channel yet/);
  assert.doesNotMatch(s, /They can/, 'no point listing rights nobody has');
});

test('an announcement channel is described as read-and-react', () => {
  const s = channelAccessSummary({ mode: 'space', kind: 'announcement', memberReactions: true });
  assert.match(s, /They can read and react\./);
  assert.doesNotMatch(s, /post/);
});

test('an admins_only channel is described as hidden from members', () => {
  const s = channelAccessSummary({ mode: 'admins_only', planLabels: ['VIP'] });
  assert.match(s, /Only administrators/);
  assert.match(s, /hidden from every member/);
});

// ── Privacy-impact diff ─────────────────────────────────────────────────

test('widening warns that existing discussions become visible', () => {
  const d = accessDiff({}, { gaining: 3, losing: 0, has_content: true });
  assert.equal(d.widened, true);
  assert.equal(d.narrowed, false);
  assert.ok(d.notes.some((n) => /3 members will gain access/.test(n)));
  assert.ok(d.notes.some((n) => /become visible/.test(n)));
});

test('narrowing warns that current readers lose access', () => {
  const d = accessDiff({}, { gaining: 0, losing: 1 });
  assert.equal(d.narrowed, true);
  assert.ok(d.notes.some((n) => /1 member will lose access/.test(n)));
  assert.ok(d.notes.some((n) => /right now/.test(n)));
});

test('an unchanged audience says nothing changes', () => {
  const d = accessDiff({}, { gaining: 0, losing: 0 });
  assert.equal(d.changed, false);
  assert.deepEqual(d.notes, ['No one gains or loses access.']);
});

// ── Denial copy ─────────────────────────────────────────────────────────

test('an allowed denial envelope produces no message', () => {
  assert.equal(channelDenialCopy({ allowed: true }), null);
  assert.equal(channelDenialCopy(null), null);
});

test('denial copy never names the plan or batch behind a private channel', () => {
  for (const reason of ['no_such_channel', 'not_a_member', 'archived_channel',
    'announcement_channel', 'comments_off', 'plan_or_channel']) {
    const copy = channelDenialCopy({ allowed: false, reason }, 'post');
    assert.ok(copy && copy.length > 0, `${reason} needs copy`);
    assert.doesNotMatch(copy, /vip|sampler|silver|batch|2026/i,
      `${reason} must not leak audience configuration`);
  }
});

test('an unknown denial reason still produces a usable sentence per action', () => {
  assert.match(channelDenialCopy({ allowed: false, reason: 'brand_new' }, 'comment'), /reply/i);
  assert.match(channelDenialCopy({ allowed: false, reason: 'brand_new' }, 'attach'), /attachment/i);
  assert.match(channelDenialCopy({ allowed: false, reason: 'brand_new' }, 'post'), /post/i);
});

// ── Where a member LANDS (#43) ──────────────────────────────────────────
//
// defaultSpaceOf() used to prefer a non-general space, so a VIP opening the
// Community arrived in their private cohort room. That preference was lost when
// space selection became channel selection in #40, and nothing replaced it:
// my_community_sidebar() orders general first, and community_settings
// .default_channel_id points into General, so EVERY remaining fallback led back
// to the public room. A member who paid ₱16,999 for a cohort had no indication
// their cohort room existed unless they scanned the rail.

const RAIL = [
  { channel_id: 'g1', channel_slug: 'general-discussion', space_kind: 'general', is_default: true, is_space_default: true },
  { channel_id: 'g2', channel_slug: 'announcements', space_kind: 'general' },
  { channel_id: 'v1', channel_slug: 'coaching-questions', space_kind: 'vip' },
  { channel_id: 'v2', channel_slug: 'lounge', space_kind: 'vip', is_space_default: true },
];

test('the cohort landing room is that space own default, not merely its first row', () => {
  assert.equal(cohortLandingChannel(RAIL).channel_id, 'v2',
    'is_space_default wins over rail order inside the cohort space');
});

test('a member with no cohort space has no cohort landing room', () => {
  const generalOnly = RAIL.filter(r => r.space_kind === 'general');
  assert.equal(cohortLandingChannel(generalOnly), null,
    'null, so the caller falls through to the community-wide default');
  assert.equal(cohortLandingChannel([]), null, 'and an empty rail is not a crash');
  assert.equal(cohortLandingChannel(null), null, 'nor is a missing one');
});

test('a cohort space with no marked default still yields a room', () => {
  const rows = RAIL.filter(r => r.channel_id !== 'v2');
  assert.equal(cohortLandingChannel(rows).channel_id, 'v1',
    'first cohort row — landing somewhere private beats landing in General');
});

test('an explicit link still outranks the cohort preference', () => {
  // The precedence this feeds is URL -> stored -> defaultChannelId -> is_default
  // -> first, and the cohort room is supplied AS the defaultChannelId. So a
  // shared ?channel= link must still win, or a cohort member cannot follow one.
  const chosen = pickInitialChannel({
    urlSlug: 'announcements',
    channels: RAIL,
    defaultChannelId: cohortLandingChannel(RAIL).channel_id,
  });
  assert.equal(chosen.channel_id, 'g2', 'the link the member actually clicked');

  const stored = pickInitialChannel({
    storedSlug: 'general-discussion',
    channels: RAIL,
    defaultChannelId: cohortLandingChannel(RAIL).channel_id,
  });
  assert.equal(stored.channel_id, 'g1', 'and a remembered choice is still a choice');

  const fresh = pickInitialChannel({
    channels: RAIL,
    defaultChannelId: cohortLandingChannel(RAIL).channel_id,
  });
  assert.equal(fresh.channel_id, 'v2',
    'but with nothing asked for, a VIP lands in their cohort — the #43 fix');
});
