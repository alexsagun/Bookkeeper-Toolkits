// test/communityCapabilities.test.mjs — the plan × space capability matrix (#36).
//
// The 24-cell truth table (3 plans × 2 space kinds × 4 actions) is the JS half of
// a lockstep pair with public.user_community_capabilities(). It encodes D2:
//
//     General is an ANNOUNCEMENT space. No member posts or comments there —
//     not Sampler, not Silver, and NOT VIP. Everyone reacts. VIP holds the full
//     forum only inside its own per-batch space.
//
// #39 removed the Gold plan and the whole 'gold' space kind, so the matrix is
// 3 × 2 rather than the 5 × 3 it was under #36.
//
// SCOPE NOTE: capabilitiesFor() answers "what may this plan DO in this kind of
// space", not "may this member SEE this space". Membership is L1's job
// (user_community_space_ids), and SQL applies it as a separate conjunct. So a
// row below like "sampler in a vip space" describes a combination the server
// never produces — it is here to prove the capability half is not what would
// let it through if it ever did.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_DEFAULT,
  PLAN_CAPABILITY_FALLBACK,
  capabilitiesFor,
  denialCopy,
  effectiveCaps,
  isAnnouncementSpace,
  planCapabilities,
} from '../src/lib/communityCapabilities.js';

// The live enrollment_plans rows after #36's seed.
const PLAN_ROWS = {
  sampler:           { community_segment: 'general', ...PLAN_CAPABILITY_FALLBACK.sampler },
  silver_self_paced: { community_segment: 'general', ...PLAN_CAPABILITY_FALLBACK.silver_self_paced },
  vip:               { community_segment: 'vip',     ...PLAN_CAPABILITY_FALLBACK.vip },
};

// The live community_spaces rows after #36's D2 flip.
const SPACES = {
  general: { kind: 'general', member_posting: false, member_comments: false, member_reactions: true },
  vip:     { kind: 'vip',     member_posting: true,  member_comments: true,  member_reactions: true },
};

const SELF_PACED = ['sampler', 'silver_self_paced'];
const COHORT = ['vip'];
const ALL_PLANS = [...SELF_PACED, ...COHORT];
const SPACE_KINDS = ['general', 'vip'];

const caps = (plan, spaceKind) =>
  capabilitiesFor(plan, PLAN_ROWS[plan], SPACES[spaceKind], false);

test('D2: NO plan may post or comment in General — including VIP', () => {
  for (const plan of ALL_PLANS) {
    const c = caps(plan, 'general');
    assert.equal(c.canPost, false, `${plan} must not post in General`);
    assert.equal(c.canComment, false, `${plan} must not comment in General`);
    assert.equal(c.canAttach, false, `${plan} must not attach in General`);
  }
});

test('D2: EVERY plan may react in General — reacting is not creating discussion', () => {
  for (const plan of ALL_PLANS) {
    assert.equal(caps(plan, 'general').canReact, true, `${plan} must be able to react in General`);
  }
});

test('the Discord problem: self-paced plans can never write, in any space', () => {
  // This is the whole point of #36. Sampler/Silver read and react; the
  // support load that made Discord unmanageable cannot reappear.
  for (const plan of SELF_PACED) {
    for (const kind of SPACE_KINDS) {
      const c = caps(plan, kind);
      assert.equal(c.canPost, false, `${plan} must not post in ${kind}`);
      assert.equal(c.canComment, false, `${plan} must not comment in ${kind}`);
      assert.equal(c.canAttach, false, `${plan} must not attach in ${kind}`);
      assert.equal(c.canReact, true, `${plan} must still react in ${kind}`);
    }
  }
});

test('VIP holds the full forum inside its private cohort space', () => {
  const vip = caps('vip', 'vip');
  assert.deepEqual(vip, { canPost: true, canComment: true, canReact: true, canAttach: true });
});

test('the full 24-cell matrix matches the #36 seed exactly', () => {
  const expected = {};
  for (const plan of ALL_PLANS) {
    expected[`${plan}/general`] = { canPost: false, canComment: false, canReact: true, canAttach: false };
  }
  for (const plan of SELF_PACED) {
    expected[`${plan}/vip`] = { canPost: false, canComment: false, canReact: true, canAttach: false };
  }
  // Cohort plans have private rights; L1 decides WHICH private space they see.
  for (const plan of COHORT) {
    expected[`${plan}/vip`] = { canPost: true, canComment: true, canReact: true, canAttach: true };
  }

  let cells = 0;
  for (const plan of ALL_PLANS) {
    for (const kind of SPACE_KINDS) {
      const got = caps(plan, kind);
      assert.deepEqual(got, expected[`${plan}/${kind}`], `${plan} in ${kind}`);
      cells += 4;
    }
  }
  assert.equal(cells, 24, 'the matrix must cover 3 plans x 2 kinds x 4 actions');
});

// #39 deleted the plan; a stale row must not carry cohort write rights into any
// space that still exists.
test('the retired gold_live key has no capabilities left', () => {
  assert.equal(PLAN_CAPABILITY_FALLBACK.gold_live, undefined);
  assert.equal(PLAN_CAPABILITY_FALLBACK.core_self_paced, undefined);
  for (const kind of SPACE_KINDS) {
    const c = capabilitiesFor('gold_live', null, SPACES[kind], false);
    assert.equal(c.canPost, false, `gold_live must not post in ${kind}`);
    assert.equal(c.canComment, false, `gold_live must not comment in ${kind}`);
    assert.equal(c.canAttach, false, `gold_live must not attach in ${kind}`);
  }
});

test('an unknown or legacy plan fails CLOSED', () => {
  for (const kind of SPACE_KINDS) {
    const c = capabilitiesFor('some_plan_added_next_year', null, SPACES[kind], false);
    assert.equal(c.canPost, false);
    assert.equal(c.canComment, false);
    assert.equal(c.canAttach, false);
    assert.equal(c.canReact, true, 'reacting stays the one safe default');
  }
  const nullPlan = capabilitiesFor(null, null, SPACES.vip, false);
  assert.equal(nullPlan.canPost, false);
  assert.equal(nullPlan.canComment, false);
});

test('CAPABILITY_DEFAULT is the fail-closed shape', () => {
  assert.equal(CAPABILITY_DEFAULT.can_post_in_general, false);
  assert.equal(CAPABILITY_DEFAULT.can_comment_in_general, false);
  assert.equal(CAPABILITY_DEFAULT.can_post_in_private, false);
  assert.equal(CAPABILITY_DEFAULT.can_comment_in_private, false);
  assert.equal(CAPABILITY_DEFAULT.can_upload_attachments, false);
  assert.equal(CAPABILITY_DEFAULT.can_react_in_general, true);
  assert.equal(CAPABILITY_DEFAULT.can_react_in_private, true);
});

test('a live plan row overrides the fallback', () => {
  // Alex opens posting in the cohort spaces for Silver via one UPDATE.
  const row = { ...PLAN_ROWS.silver_self_paced, can_post_in_private: true };
  assert.equal(capabilitiesFor('silver_self_paced', row, SPACES.vip, false).canPost, true);
  // …and the fallback is untouched, so nothing else moves.
  assert.equal(caps('silver_self_paced', 'vip').canPost, false);
});

test('a space flag closes the door regardless of plan', () => {
  const lockedVip = { ...SPACES.vip, member_comments: false };
  const c = capabilitiesFor('vip', PLAN_ROWS.vip, lockedVip, false);
  assert.equal(c.canComment, false, 'space flag wins over plan capability');
  assert.equal(c.canPost, true, 'and only closes what it names');
});

test('admins bypass the matrix (they moderate every space)', () => {
  const c = capabilitiesFor('sampler', PLAN_ROWS.sampler, SPACES.general, true);
  assert.deepEqual(c, { canPost: true, canComment: true, canReact: true, canAttach: true });
});

test('attaching requires the right to create the thing it hangs off', () => {
  // A plan with the attachment flag but no posting right must not be able to
  // fill the private bucket with orphan objects.
  const row = { ...PLAN_ROWS.sampler, can_upload_attachments: true };
  assert.equal(capabilitiesFor('sampler', row, SPACES.vip, false).canAttach, false);
});

// ── effectiveCaps: what CommunityHub actually reads ──────────────────────────

test('effectiveCaps FAILS CLOSED on an unresolved space', () => {
  // The shipped client did the opposite (`!currentSpace || member_posting !== false`),
  // so an unresolved space showed a New Topic button whose submit 42501'd.
  assert.deepEqual(effectiveCaps(null),
    { canPost: false, canComment: false, canReact: false, canAttach: false });
  assert.deepEqual(effectiveCaps(undefined),
    { canPost: false, canComment: false, canReact: false, canAttach: false });
});

test('effectiveCaps trusts the server-resolved capabilities verbatim', () => {
  const row = {
    kind: 'vip', member_posting: true, member_comments: true, member_reactions: true,
    can_post: true, can_comment: false, can_react: true, can_attach: false,
  };
  assert.deepEqual(effectiveCaps(row),
    { canPost: true, canComment: false, canReact: true, canAttach: false });
});

test('effectiveCaps degrades to raw flags on a pre-#36 database', () => {
  // A #35-only DB returns no can_* columns; reproducing the old behaviour there
  // is correct, because the plan dimension does not exist yet.
  const row = { kind: 'general', member_posting: true, member_comments: false, member_reactions: true };
  assert.deepEqual(effectiveCaps(row),
    { canPost: true, canComment: false, canReact: true, canAttach: true });
});

test('effectiveCaps treats an explicit false as false, not missing', () => {
  const row = { kind: 'general', can_post: false, can_comment: false, can_react: true, can_attach: false };
  const c = effectiveCaps(row);
  assert.equal(c.canPost, false);
  assert.equal(c.canReact, true);
});

test('isAnnouncementSpace recognises the D2 General shape', () => {
  assert.ok(isAnnouncementSpace({ kind: 'general', can_post: false, can_comment: false, can_react: true }));
  assert.ok(!isAnnouncementSpace({ kind: 'vip', can_post: true, can_comment: true, can_react: true }));
  assert.ok(!isAnnouncementSpace(null));
});

// ── denial copy ──────────────────────────────────────────────────────────────

test('denialCopy explains every reason community_write_denial can return', () => {
  const reasons = ['no_such_space', 'not_a_member', 'announcement_space', 'plan_or_space'];
  for (const reason of reasons) {
    const copy = denialCopy({ allowed: false, reason });
    assert.ok(copy && copy.length > 10, `${reason} needs real copy`);
    assert.ok(!/undefined|\[object/.test(copy), `${reason} copy is broken: ${copy}`);
  }
});

test('denialCopy returns null when the action IS allowed', () => {
  assert.equal(denialCopy({ allowed: true }), null);
});

test('denialCopy never leaves a disabled control unexplained', () => {
  // An unrecognised shape must still produce a sentence — a silently disabled
  // button is worse than a slightly generic reason.
  assert.ok(denialCopy(null, 'post').length > 10);
  assert.ok(denialCopy({}, 'comment').length > 10);
  assert.ok(denialCopy({ allowed: false, reason: 'something_new' }, 'attach').length > 10);
});

test('planCapabilities resolves a partial row without inventing permissions', () => {
  // A row from an older schema carries only some columns; the missing ones must
  // come from the fallback/default, never default to true.
  const partial = { can_post_in_private: true };
  const p = planCapabilities('vip', partial);
  assert.equal(p.can_post_in_private, true);
  assert.equal(p.can_post_in_general, false);
  assert.equal(p.can_comment_in_general, false);
});
