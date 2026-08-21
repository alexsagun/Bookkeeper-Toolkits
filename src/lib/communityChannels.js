// src/lib/communityChannels.js — the client mirror of community channels (#40).
//
// PURE, dependency-free ESM: NO imports, NO side effects, no DOM/Node/Supabase,
// so the same rules run in the browser, in api/ endpoints, and under `node --test`.
//
// ★ THIS FILE IS NOT A SECURITY BOUNDARY. The database is. Every rule here has a
//   twin in db/2026-08-18-community-channels.sql, and the twin is the one that
//   decides. What this file buys is a UI that agrees with the database, so a
//   member is never shown a control whose submit then 42501s.
//
// The rule it mirrors, in one line:
//
//   can_read = admin OR (space membership AND audience match AND channel active)
//   can_X    = can_read AND plan capability AND space flag AND channel flag
//
// Space membership (L1) is decided by the batch-entitlement ledger and is NEVER
// re-derived here — callers pass it in. A batch is never inferred from a name,
// code, month, price or date.

export const AUDIENCE_MODES = ['space', 'plans', 'batches', 'plans_and_batches', 'admins_only'];
export const CHANNEL_KINDS = ['text', 'announcement'];
export const CHANNEL_STATUSES = ['active', 'archived'];

/** Modes that are meaningless without a mapping — an empty one means "nobody". */
export const MODES_NEEDING_PLANS = ['plans', 'plans_and_batches'];
export const MODES_NEEDING_BATCHES = ['batches', 'plans_and_batches'];

const NO_CAPS = Object.freeze({
  canRead: false, canPost: false, canComment: false, canReact: false, canAttach: false,
});

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);

/**
 * Turn a display name into the stable address a channel is reachable at.
 *
 * The slug is a PERMALINK: ?channel=<slug> links and the stored last-channel
 * preference resolve through it, and an unknown slug falls back silently. That is
 * why renaming a channel never moves it — only creation mints one.
 */
export function normalizeChannelSlug(input) {
  const raw = typeof input === 'string' ? input : '';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(slug) ? slug : '';
}

/**
 * The audience CASE from user_community_channel_ids(), verbatim.
 *
 * `inSpace` defaults to FALSE on purpose. This function answers "does the
 * audience admit this member", and the space conjunct is the caller's to supply;
 * defaulting it to true would let a forgetful caller widen access, which is
 * exactly the direction that must never fail open.
 */
export function channelAudienceAllows(input) {
  const o = input || {};
  if (o.isAdmin === true) return true;

  const status = o.status === undefined || o.status === null ? 'active' : o.status;
  if (status !== 'active') return false;
  if (o.inSpace !== true) return false;

  const planKeys = asArray(o.planKeys);
  const batchIds = asArray(o.batchIds);
  const memberPlanKey = o.memberPlanKey || null;
  const memberBatchIds = asArray(o.memberBatchIds);

  // An EXISTS over an empty mapping is false in SQL; the same must hold here.
  const planMatch = () => !!memberPlanKey && planKeys.indexOf(memberPlanKey) !== -1;
  const batchMatch = () => memberBatchIds.some((b) => batchIds.indexOf(b) !== -1);

  switch (o.mode) {
    case 'space': return true;
    case 'plans': return planMatch();
    case 'batches': return batchMatch();
    case 'plans_and_batches': return planMatch() && batchMatch();
    case 'admins_only': return false;
    // An unknown mode (a newer server, a typo, a truncated payload) is refused.
    default: return false;
  }
}

/**
 * The effective rights for one channel row from my_community_sidebar().
 *
 * The server has already fused plan x space x channel, so its can_* booleans are
 * used VERBATIM. Anything else — a missing row, a payload without the columns, a
 * still-loading sidebar — is all-false.
 *
 * ★ The shipped pre-#40 client did the opposite: `!currentSpace || member_posting
 *   !== false` fails OPEN before the space resolves, which is how members got a
 *   New-discussion button whose submit was then refused by RLS.
 */
export function effectiveChannelCaps(row) {
  if (!row || typeof row !== 'object') return { ...NO_CAPS };
  const hasServerCaps =
    typeof row.can_post === 'boolean' ||
    typeof row.can_comment === 'boolean' ||
    typeof row.can_react === 'boolean' ||
    typeof row.can_attach === 'boolean';
  if (!hasServerCaps) return { ...NO_CAPS };
  return {
    canRead: true,
    canPost: row.can_post === true,
    canComment: row.can_comment === true,
    canReact: row.can_react === true,
    canAttach: row.can_attach === true,
  };
}

const slugOf = (c) => (c ? c.channel_slug || c.slug || null : null);
const idOf = (c) => (c ? c.channel_id || c.id || null : null);

/**
 * Selection precedence: URL -> stored preference -> server default -> first.
 *
 * A slug that is unknown, archived or simply not visible to this member falls
 * through SILENTLY. Reporting "no such channel" would confirm that a private room
 * exists, so the member just lands somewhere they can actually read.
 */
export function pickInitialChannel(input) {
  const o = input || {};
  const list = asArray(o.channels);
  if (!list.length) return null;
  const bySlug = (s) => (s ? list.find((c) => slugOf(c) === s) || null : null);
  return (
    bySlug(o.urlSlug) ||
    bySlug(o.storedSlug) ||
    (o.defaultChannelId ? list.find((c) => idOf(c) === o.defaultChannelId) || null : null) ||
    list.find((c) => c.is_default === true) ||
    list[0]
  );
}

/**
 * Fold the flat sidebar rows into rail groups, preserving the RPC's ordering.
 *
 * A cohort space is private by construction, so the lock belongs on the group
 * header rather than repeated on every row inside it.
 */
export function groupChannelsByCategory(rows) {
  const list = asArray(rows);
  const out = [];
  const index = new Map();
  for (const r of list) {
    const key = r.category_id || `${r.space_id}:uncategorised`;
    let group = index.get(key);
    if (!group) {
      group = {
        key,
        categoryId: r.category_id || null,
        categoryName: r.category_name || 'Channels',
        spaceId: r.space_id || null,
        spaceName: r.space_name || '',
        spaceKind: r.space_kind || 'general',
        batchCode: r.batch_code || null,
        isPrivate: r.space_kind !== 'general',
        channels: [],
      };
      index.set(key, group);
      out.push(group);
    }
    group.channels.push(r);
  }
  return out;
}

/** Bounded unread badge. Past 99 the exact number stops meaning anything. */
export function unreadLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return v > 99 ? '99+' : String(v);
}

const listSentence = (items) => {
  const a = asArray(items).map((x) => String(x)).filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return a[0] + ' and ' + a[1];
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
};

/**
 * The plain-language access summary an admin reads before saving.
 *
 * Written from the member's side of the screen ("VIP members ... can view this
 * channel"), because that is the question the admin is actually asking.
 */
export function channelAccessSummary(input) {
  const o = input || {};
  const planNames = asArray(o.planLabels);
  const batchNames = asArray(o.batchLabels);
  const kind = o.kind === 'announcement' ? 'announcement' : 'text';

  if (o.mode === 'admins_only') {
    return 'Only administrators can see this channel. It stays hidden from every member.';
  }

  let who;
  switch (o.mode) {
    case 'space':
      who = o.spaceKind && o.spaceKind !== 'general'
        ? 'Everyone in ' + (o.spaceName || 'this cohort')
        : 'Every active member';
      break;
    case 'plans':
      who = planNames.length ? listSentence(planNames) + ' members' : '';
      break;
    case 'batches':
      who = batchNames.length ? 'Members in ' + listSentence(batchNames) : '';
      break;
    case 'plans_and_batches':
      who = planNames.length && batchNames.length
        ? listSentence(planNames) + ' members who are also in ' + listSentence(batchNames)
        : '';
      break;
    default:
      who = '';
  }

  if (!who) {
    return 'Nobody can see this channel yet. Choose at least one plan or batch.';
  }

  const may = [];
  if (kind === 'announcement') {
    may.push('read');
    if (o.memberReactions !== false) may.push('react');
  } else {
    if (o.memberPosting !== false) may.push('post');
    if (o.memberComments !== false) may.push('comment');
    if (o.memberReactions !== false) may.push('react');
  }
  const canDo = may.length ? 'They can ' + listSentence(may) + '.' : 'They can read only.';

  // Attachments stay bound to the plan, so the summary must not promise them.
  const attach = o.memberAttachments === false
    ? ' Attachments are off in this channel.'
    : ' Attachments are permitted only where the member plan allows them.';

  return who + ' can view this channel. ' + canDo + attach;
}

/**
 * What changes if this audience is saved? Drives the confirmation step.
 *
 * Counts come from the server (admin_channel_privacy_preview); this only decides
 * how to describe them, so the wording cannot disagree with the numbers.
 */
export function accessDiff(before, after) {
  const b = before || {};
  const a = after || {};
  const gaining = Number(a.gaining) || 0;
  const losing = Number(a.losing) || 0;
  const hasContent = a.has_content === true || b.has_content === true;

  const notes = [];
  if (gaining > 0) {
    notes.push(gaining + ' member' + (gaining === 1 ? '' : 's') + ' will gain access.');
    if (hasContent) notes.push('Discussions already in this channel become visible to them.');
  }
  if (losing > 0) {
    notes.push(losing + ' member' + (losing === 1 ? '' : 's') + ' will lose access.');
    notes.push('Anyone reading it right now loses it on their next load.');
  }
  if (!notes.length) notes.push('No one gains or loses access.');

  return {
    widened: gaining > 0,
    narrowed: losing > 0,
    changed: gaining > 0 || losing > 0,
    gaining,
    losing,
    notes,
  };
}

const DENIAL_COPY = {
  no_such_channel: 'This channel is not available to you.',
  not_a_member: 'This channel is not available to you.',
  archived_channel: 'This channel is archived, so it is read-only.',
  announcement_channel: 'Only admins post in this channel.',
  comments_off: 'Replies are turned off in this channel.',
  plan_or_channel: 'Your plan does not include posting in this channel.',
};

/**
 * Turn community_channel_write_denial()'s envelope into a sentence.
 *
 * Never names the plan or batch a channel is limited to — that would leak the
 * shape of the cohort roster to someone who cannot see the room.
 */
export function channelDenialCopy(denial, kind) {
  if (!denial || typeof denial !== 'object') return null;
  if (denial.allowed === true) return null;
  const copy = DENIAL_COPY[denial.reason];
  if (copy) {
    if (denial.reason === 'plan_or_channel' && kind === 'comment') {
      return 'Your plan does not include replying in this channel.';
    }
    return copy;
  }
  if (kind === 'comment') return 'You cannot reply in this channel.';
  if (kind === 'attach') return 'You cannot add attachments in this channel.';
  return 'You cannot post in this channel.';
}
