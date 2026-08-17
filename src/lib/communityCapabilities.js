// ─────────────────────────────────────────────────────────────────────────────
// communityCapabilities.js — PURE, dependency-free community permission logic (#36).
// ─────────────────────────────────────────────────────────────────────────────
// The JS mirror of public.user_community_capabilities() and
// public.community_write_denial(). Used by CommunityHub to decide which
// affordances to render, and by test/communityCapabilities.test.mjs.
// NO imports, NO side effects.
//
// ★ THIS FILE IS NOT A SECURITY BOUNDARY. The database refuses the write; this
// only decides whether to show a button and what to say when it is hidden. It
// is written to fail CLOSED anyway, because a UI that offers an action the
// server will refuse is a worse experience than one that explains why.
//
// THE RULE (mirrored from SQL):
//     effective = plan capability
//             AND space flag
//             AND space membership (L1)
//             AND is_approved() AND is_enrolled()
// The last three are already true of any space the server returned to us, so
// the client-side job is the first two.
//
// D2: General is announcement-only. No plan — not even VIP — may post or comment
// there. Reactions stay on for everyone.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror of the #36 capability seed. Used ONLY when a plan row is unavailable
 * (the in-code ENROLLMENT_PLANS_FALLBACK path, or a pre-#36 database). The live
 * enrollment_plans columns are the authority wherever a row exists.
 *
 * Every unknown plan resolves to the fail-closed default: read and react,
 * write nothing.
 */
export const PLAN_CAPABILITY_FALLBACK = {
  sampler: {
    can_post_in_general: false,
    can_comment_in_general: false,
    can_react_in_general: true,
    can_post_in_private: false,
    can_comment_in_private: false,
    can_react_in_private: true,
    can_upload_attachments: false,
  },
  silver_self_paced: {
    can_post_in_general: false,
    can_comment_in_general: false,
    can_react_in_general: true,
    can_post_in_private: false,
    can_comment_in_private: false,
    can_react_in_private: true,
    can_upload_attachments: false,
  },
  vip: {
    can_post_in_general: false,
    can_comment_in_general: false,
    can_react_in_general: true,
    can_post_in_private: true,
    can_comment_in_private: true,
    can_react_in_private: true,
    can_upload_attachments: true,
  },
};

/** The fail-closed default for an unknown, legacy, or missing plan. */
export const CAPABILITY_DEFAULT = {
  can_post_in_general: false,
  can_comment_in_general: false,
  can_react_in_general: true,
  can_post_in_private: false,
  can_comment_in_private: false,
  can_react_in_private: true,
  can_upload_attachments: false,
};

const NO_CAPS = Object.freeze({
  canPost: false, canComment: false, canReact: false, canAttach: false,
});

/** Resolve a plan's capability row, falling back safely. */
export function planCapabilities(planKey, planRow) {
  const row = planRow && typeof planRow === 'object' ? planRow : null;
  const pick = (k) => {
    if (row && typeof row[k] === 'boolean') return row[k];
    const fb = PLAN_CAPABILITY_FALLBACK[planKey];
    if (fb && typeof fb[k] === 'boolean') return fb[k];
    return CAPABILITY_DEFAULT[k];
  };
  return {
    can_post_in_general: pick('can_post_in_general'),
    can_comment_in_general: pick('can_comment_in_general'),
    can_react_in_general: pick('can_react_in_general'),
    can_post_in_private: pick('can_post_in_private'),
    can_comment_in_private: pick('can_comment_in_private'),
    can_react_in_private: pick('can_react_in_private'),
    can_upload_attachments: pick('can_upload_attachments'),
  };
}

/**
 * The full mirror: fuse a plan row with a space row exactly as SQL does.
 * Used by the truth-table test to prove the two sides agree.
 *
 * @param {string|null} planKey
 * @param {object|null} planRow  an enrollment_plans row (or null → fallback)
 * @param {object|null} spaceRow a community_spaces row
 * @param {boolean} isAdmin
 * @returns {{canPost:boolean, canComment:boolean, canReact:boolean, canAttach:boolean}}
 */
export function capabilitiesFor(planKey, planRow, spaceRow, isAdmin = false) {
  if (!spaceRow || typeof spaceRow !== 'object') return { ...NO_CAPS };
  if (isAdmin) return { canPost: true, canComment: true, canReact: true, canAttach: true };

  const p = planCapabilities(planKey, planRow);
  const general = spaceRow.kind === 'general';

  // A space flag of `false` closes the door regardless of plan; `undefined` is
  // treated as open, matching the NOT NULL DEFAULT true columns in SQL.
  const flag = (v) => v !== false;

  const post = flag(spaceRow.member_posting) && (general ? p.can_post_in_general : p.can_post_in_private);
  const comment = flag(spaceRow.member_comments) && (general ? p.can_comment_in_general : p.can_comment_in_private);
  const react = flag(spaceRow.member_reactions) && (general ? p.can_react_in_general : p.can_react_in_private);

  return {
    canPost: post,
    canComment: comment,
    canReact: react,
    // Attaching needs both the attachment right and the right to create the
    // thing it hangs off — otherwise a plan that cannot post could still fill
    // the private bucket.
    canAttach: p.can_upload_attachments && post,
  };
}

/**
 * What CommunityHub actually calls: read the effective capabilities off a space
 * row returned by my_community_spaces().
 *
 * Post-#36 that RPC carries can_post/can_comment/can_react/can_attach already
 * resolved by the server, so we use them verbatim — the server is the authority
 * and the client must not second-guess it. On a #35-only database those columns
 * are absent, so we degrade to the raw space flags, which reproduces exactly the
 * pre-#36 behaviour for that schema.
 *
 * ★ A null/unresolved space returns ALL FALSE. The shipped client did the
 * opposite (`!currentSpace || member_posting !== false` → open), which meant an
 * unresolved space showed a New Topic button whose submit failed with a raw
 * permission error.
 */
export function effectiveCaps(spaceRow) {
  if (!spaceRow || typeof spaceRow !== 'object') return { ...NO_CAPS };

  const hasServerCaps = typeof spaceRow.can_post === 'boolean'
    || typeof spaceRow.can_comment === 'boolean'
    || typeof spaceRow.can_react === 'boolean';

  if (hasServerCaps) {
    return {
      canPost: spaceRow.can_post === true,
      canComment: spaceRow.can_comment === true,
      canReact: spaceRow.can_react === true,
      canAttach: spaceRow.can_attach === true,
    };
  }

  // Pre-#36 fallback: raw space flags only (no plan dimension exists yet).
  return {
    canPost: spaceRow.member_posting !== false,
    canComment: spaceRow.member_comments !== false,
    canReact: spaceRow.member_reactions !== false,
    canAttach: spaceRow.member_posting !== false,
  };
}

/** True when a space is a read-and-react announcement space (D2 shape). */
export function isAnnouncementSpace(spaceRow) {
  const caps = effectiveCaps(spaceRow);
  return !!spaceRow && !caps.canPost && !caps.canComment && caps.canReact;
}

const DENIAL_COPY = {
  no_such_space: 'This space is no longer available. Pick another from the switcher.',
  not_a_member: "You don't have access to this space.",
  announcement_space:
    'This is an announcements space — only Alex posts here. React to let him know what landed.',
  plan_or_space: 'Your plan includes reading and reacting here, not posting.',
};

/**
 * Turn a community_write_denial() result into a sentence.
 * Always returns something usable, including for a shape we don't recognise —
 * an unexplained disabled button is worse than a slightly generic reason.
 */
export function denialCopy(denial, kind = 'post') {
  if (denial && denial.allowed === true) return null;
  const reason = denial && typeof denial.reason === 'string' ? denial.reason : '';
  if (DENIAL_COPY[reason]) return DENIAL_COPY[reason];
  if (kind === 'comment') return 'Replies are turned off here.';
  if (kind === 'attach') return 'Your plan cannot upload attachments here.';
  return 'Your plan cannot post here.';
}
