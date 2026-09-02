// test/communityStaffSql.test.mjs — #56's SQL, pinned against the sources it re-gates.
//
// #56 does something unusual and it needs unusual tests. Eight community config RPCs are
// re-gated by a `do $regate$` block that reads pg_get_functiondef() and string-replaces
// ONE guard, because admin_save_community_channel() has no current body in this repo:
// #41 is its last `create or replace` and #43 then TEXT-PATCHES it at runtime. There is
// therefore no function body in the migration to diff, so these tests pin the MECHANISM
// and the RESULT instead:
//
//   * the literal the block searches for is byte-identical to what #40/#41/#43 wrote
//     (an indentation typo here is a silent no-op on a live database);
//   * the block names every RPC that still carries that guard;
//   * the migration restates NO community admin body — the anti-retype pin, which is what
//     makes "we used the live definition" enforced rather than merely intended;
//   * the block refuses to no-op silently;
//   * community_posts_guard() keeps the timestamp-forgery carve-out;
//   * no user_community_*(uuid) body calls the CALLER-pinned helper.
//
// Everything runs against BOTH the dated file and its bootstrap fold, because
// bootstrapFolds.test.mjs is a line-set CONTAINMENT check: it proves nothing was dropped
// from a fold, never that nothing wrong was added, and on a fresh install the last
// definition wins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-05-community-staff-authority.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const CHANNELS = 'db/2026-08-18-community-channels.sql';
const FILES = [MIGRATION, BOOTSTRAP];

/** The nine RPCs #56 re-gates. */
const REGATED = [
  'admin_community_config',
  'admin_save_community_settings',
  'admin_save_channel_category',
  'admin_move_channel_category',
  'admin_save_community_channel',
  'admin_move_community_channel',
  'admin_set_community_channel_status',
  'admin_channel_privacy_preview',
  'admin_community_media_orphans',
];

/** The #56 section of a file — the whole dated file, or the §43 fold of the bootstrap. */
function section56(rel) {
  const sql = read(rel);
  if (rel !== BOOTSTRAP) return sql;
  const at = sql.indexOf('§43) FOLDED VERBATIM');
  assert.notEqual(at, -1, 'the bootstrap has no §43 fold — re-fold #56');
  return sql.slice(at);
}

// ── The guard literal ────────────────────────────────────────────────────────

test('the legacy-guard literal is byte-identical to the one #40/#41/#43 actually wrote', () => {
  // THE highest-value assertion in this file. The do-block matches a three-line string
  // including its leading whitespace; one space out and the re-gate finds nothing,
  // reports "the body has drifted" and refuses — or, worse for a future edit, matches
  // nothing and no-ops. Reconstruct it from the migration and compare against the source.
  const mig = read(MIGRATION);
  const at = mig.indexOf("  v_old constant text :=");
  assert.notEqual(at, -1, 'v_old is not declared — did the re-gate change shape?');
  // Slice to the NEXT declaration, not to the first ';' - the guard text itself
  // contains ', 403, null);'.
  const decl = mig.slice(at, mig.indexOf('v_new constant text :=', at));
  const parts = [...decl.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const rebuilt = parts.filter((p) => p !== '').join('\n');

  const live = read(CHANNELS);
  const expected = [
    '  if not public.is_admin() then',
    "    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);",
    '  end if;',
  ].join('\n');
  assert.ok(live.includes(expected),
    'the guard this file claims to replace is not present verbatim in #40 — check both');
  assert.equal(rebuilt, expected,
    'the string #56 searches for must equal the string #40/#41/#43 wrote, byte for byte');
});

test('#56 re-gates every community RPC that still carries the legacy guard', () => {
  // Catches a tenth RPC nobody noticed. Walk the dated community files, keep the LAST
  // definition of each function, and see which still carry the guard.
  const sources = [
    'db/2026-07-31-community-plan-capabilities.sql',
    CHANNELS,
    'db/2026-08-19-community-channel-rename-fixes.sql',
    'db/2026-08-22-community-channel-followup.sql',
  ];
  const guarded = new Set();
  for (const rel of sources) {
    const sql = read(rel);
    for (const m of sql.matchAll(/create or replace function public\.(admin_[a-z_]+)\s*\(/g)) {
      const name = m[1];
      const next = sql.indexOf('create or replace function', m.index + 10);
      const body = sql.slice(m.index, next === -1 ? undefined : next);
      if (body.includes('if not public.is_admin() then') || body.includes('where public.is_admin()')) {
        guarded.add(name);
      }
    }
  }
  const named = new Set(REGATED);
  const missed = [...guarded].filter((n) => !named.has(n));
  assert.deepEqual(missed, [],
    'these community admin RPCs still gate on is_admin() and #56 does not name them');
});

// ── The anti-retype pin ──────────────────────────────────────────────────────

for (const file of FILES) {
  test(`${file}: #56 restates no community admin body`, () => {
    // The mechanism is only trustworthy if it is the ONLY mechanism. A future edit that
    // "just pastes the function in" would silently drop #43's runtime patch to
    // admin_save_community_channel, which is precisely the #33/#34 failure mode.
    const s = section56(file);
    for (const name of REGATED) {
      // ★ A PLAIN SUBSTRING, DELIBERATELY, NOT A REGEX. The first version of this line
      //   built the pattern in a TEMPLATE LITERAL — where `\b` is the escape for U+0008
      //   (BACKSPACE), not a word boundary, and `\.` collapses to "any character". SQL
      //   never contains U+0008, so the assertion could never fail: it was the anti-retype
      //   pin CLAUDE.md points at, pinning nothing. None of the nine names is a prefix of
      //   another, so no boundary is needed; and if one ever were, a substring match
      //   over-matches, which fails LOUDLY rather than silently.
      assert.ok(!s.includes(`create or replace function public.${name}`),
        `#56 restates ${name}() instead of re-gating the live definition — use the `
        + 'do $regate$ block, or #43\'s runtime patch is lost');
    }
  });

  test(`${file}: the re-gate refuses to no-op silently`, () => {
    const s = section56(file);
    assert.ok(s.includes('do $regate$'), 'the re-gate block is missing');
    assert.ok(/elsif v_hits <> 1 then\s*\n\s*raise exception/.test(s),
      'more than one guard match must raise, not pick one arbitrarily');
    assert.ok(/carries neither the legacy is_admin\(\) guard nor the/.test(s),
      'a body that matches neither guard must RAISE — a silent skip would leave the '
      + 'function on is_admin() and nobody would know');
    assert.ok(s.includes('the re-gate did not reach all nine community RPCs'),
      'the block must prove its own postcondition; raise notice is unreliable through '
      + 'the Management API');
  });

  test(`${file}: the re-gate probes for the exact string it writes`, () => {
    // #43's own do $touch$ probes 'or p_kind is not null' while writing
    // 'or p_kind           is not null', so its early-return can never fire. #56 must not
    // repeat it: its already-applied check looks for the literal it inserts.
    const s = section56(file);
    assert.ok(s.includes("if position('has_staff_permission(''community.manage'')' in v_src) > 0 then"),
      'the already-re-gated probe must look for the guard the block actually writes');
  });

  test(`${file}: all nine RPCs are named, and the self-verify counts all nine`, () => {
    const s = section56(file);
    for (const name of REGATED) {
      assert.ok(s.includes(`'${name}'`) || s.includes(`public.${name}(`),
        `${name} is not named by #56`);
    }
    assert.ok(/\) <> 9 then/.test(s), 'the self-verify must assert all nine');
  });
}

// ── community_posts_guard(): the forgery carve-out ──────────────────────────

/** Executable lines of the LAST definition of a $tag$-quoted function. */
function bodyOf(sql, name, tag) {
  const at = sql.lastIndexOf(`create or replace function public.${name}()`);
  if (at === -1) return null;
  const start = sql.indexOf(`as $${tag}$`, at);
  const end = sql.indexOf(`$${tag}$;`, start);
  if (start === -1 || end === -1) return null;
  return sql.slice(start, end).split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'));
}

for (const file of FILES) {
  test(`${file}: community_posts_guard keeps every rule from the live #40 version`, () => {
    const mine = bodyOf(section56(file), 'community_posts_guard', 'guard');
    const live = bodyOf(read(CHANNELS), 'community_posts_guard', 'guard');
    assert.ok(mine && live, 'both bodies must parse');

    const changed = [...new Set(mine.filter((l) => !live.includes(l)))];
    const dropped = [...new Set(live.filter((l) => !mine.includes(l)))];
    // Exactly three distinct guard lines appear and two disappear, and nothing else moves.
    assert.deepEqual(changed.sort(), [
      "elsif not public.has_staff_permission('community.moderate') then",
      "if not public.has_staff_permission('community.moderate') then",
      'if not public.is_super_admin() then',
    ].sort(), 'only the authorization lines may differ from #40');
    assert.deepEqual(dropped.sort(), [
      'elsif not public.is_admin() then',
      'if not public.is_admin() then',
    ].sort(), 'nothing but the legacy guards may be removed');
    // Four guards in, four out: one is_super_admin + three community.moderate.
    const count = (arr, l) => arr.filter((x) => x === l).length;
    assert.equal(count(mine, 'if not public.is_super_admin() then'), 1);
    assert.equal(
      count(mine, "if not public.has_staff_permission('community.moderate') then")
      + count(mine, "elsif not public.has_staff_permission('community.moderate') then"), 3,
      'pinned-on-insert, comments_locked-on-insert and the UPDATE freeze');
    assert.equal(mine.filter((l) => l.includes('public.is_admin()')).length, 0,
      'no legacy guard may survive in the re-stated guard');
  });

  test(`${file}: backdating a post stays SUPER-ADMIN-ONLY`, () => {
    const body = bodyOf(section56(file), 'community_posts_guard', 'guard').join('\n');
    const at = body.indexOf('new.created_at := now();');
    assert.notEqual(at, -1);
    const before = body.slice(0, at);
    assert.ok(before.trimEnd().endsWith('if not public.is_super_admin() then'),
      'the created_at bypass must be guarded by is_super_admin(). Widening it to '
      + 'community.moderate would let a moderator forge a timestamp, which launders into '
      + 'last_activity_at and self-pins a post above the activity-sorted feed.');
    assert.ok(!/community\.moderate.*\n.*new\.created_at := now\(\)/.test(body));
  });

  test(`${file}: the UPDATE branch still freezes pinned and comments_locked`, () => {
    // Without this the moderation RPCs would silently do nothing and still return success.
    const body = bodyOf(section56(file), 'community_posts_guard', 'guard').join('\n');
    assert.ok(body.includes("if not public.has_staff_permission('community.moderate') then\nnew.pinned          := old.pinned;"),
      'the UPDATE freeze must be gated on community.moderate');
  });
}

// ── The two-form split ──────────────────────────────────────────────────────

for (const file of FILES) {
  test(`${file}: no user_community_* body calls the CALLER-pinned helper`, () => {
    // The single most dangerous mistake available in #56. user_community_*(p_user) answers
    // about an arbitrary subject; is_community_staff() answers about auth.uid(). Swapping
    // them would compute a student's channel set from the MODERATOR's authority — and it
    // fails OPEN, so nothing else would notice.
    const s = section56(file);
    for (const fn of ['user_community_space_ids', 'user_community_capabilities',
      'user_community_channel_ids', 'user_community_channel_capabilities']) {
      const at = s.indexOf(`create or replace function public.${fn}(p_user uuid)`);
      assert.notEqual(at, -1, `${fn} is not restated by #56`);
      const next = s.indexOf('create or replace function', at + 10);
      const body = s.slice(at, next === -1 ? undefined : next);
      assert.ok(body.includes('public.user_is_community_staff(p_user)'),
        `${fn} must widen via the per-user form`);
      assert.ok(!/[^_]\bpublic\.is_community_staff\(\)/.test(body),
        `${fn} calls the caller-pinned is_community_staff() — it would answer about the `
        + 'caller instead of p_user, and it fails OPEN');
    }
  });

  test(`${file}: the per-user helper is revoked from every client role`, () => {
    const s = section56(file);
    assert.ok(s.includes('revoke all on function public.user_is_community_staff(uuid) from public, anon, authenticated;'),
      'user_is_community_staff answers about an arbitrary user and must never be callable');
    assert.ok(s.includes('grant execute on function public.is_community_staff() to authenticated;'),
      'the caller-pinned form MUST be granted: an RLS qual is evaluated as the querying '
      + 'role, and without the grant every gated read fails "permission denied for '
      + 'function" instead of denying cleanly');
  });

  test(`${file}: the approval/eligibility reads are deliberately NOT widened`, () => {
    const s = section56(file);
    // `approved` asks whether the account is in good standing, not whether it has
    // authority — and #50 already flips an active staff profile to 'approved'.
    assert.ok(s.includes("(p.approval_status = 'approved' or p.is_admin) as approved"),
      'user_community_space_ids must keep its approval expression unchanged');
    assert.ok(!s.includes('create or replace function public.is_enrolled'),
      '#56 must not touch is_enrolled() — it gates courses, lessons and the paywall');
    assert.ok(!s.includes('create or replace function public.community_stamp_author'),
      'community_stamp_author is already Super-Admin-only for the same created_at bypass');
  });

  test(`${file}: community_spaces_admin_all is left on batches.manage`, () => {
    const s = section56(file);
    assert.ok(!/alter policy community_spaces_admin_all/.test(s),
      'a space is created and destroyed by the BATCH lifecycle; giving a community '
      + 'configurator write access there could break enrolment approval for a cohort');
    assert.ok(s.includes('alter policy community_spaces_read'),
      'the community side does need the READ');
  });
}

// ── Policies ────────────────────────────────────────────────────────────────

/**
 * The text of ONE `alter policy` statement.
 *
 * Paren-aware, and it skips both quoted literals and `--` comments. Skipping comments is not
 * fussiness: `community_attachments_own_insert`'s qual carries a comment containing "#37's",
 * and treating that apostrophe as the start of a string literal swallowed the rest of the
 * statement and ran the extraction into the NEXT policy.
 */
function alterPolicy(sql, name) {
  const at = sql.indexOf(`alter policy ${name} on `);
  if (at === -1) return null;
  let depth = 0;
  for (let i = at; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {          // line comment: skip to end of line
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === "'") {                                 // quoted literal, '' included
      i += 1;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) {
        i += sql[i] === "'" ? 2 : 1;
      }
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ';' && depth === 0) return sql.slice(at, i + 1);
  }
  return sql.slice(at);
}

/**
 * The five blanket FOR ALL policies. They must stay SUPER-ADMIN-ONLY.
 *
 * ★ These tables carry no table-level DML revoke, so `authenticated` keeps Supabase's
 *   default INSERT/UPDATE/DELETE grants and RLS is the only boundary. A FOR ALL policy is
 *   therefore a raw PostgREST write path over EVERY row: re-gating these onto
 *   community.moderate — the obvious edit, and the one #56 nearly made — would have let an
 *   Operations Admin or Trainer PATCH another member's body, set author_id, or DELETE a
 *   post with no ledger row and no captured storage paths, leaving its private objects
 *   permanently unreachable. The bounded RPCs would have become optional.
 */
const SUPER_ONLY_ALL = [
  'community_posts_admin_all', 'community_comments_admin_all', 'community_reactions_admin_all',
  'community_attachments_admin_all', 'community_post_tags_admin_all',
  // ★ The SIXTH one, and the easy one to miss. community_tags has no DML revoke either, so
  //   gating it on community.manage would let a Trainer set admin_only = true on every tag
  //   and switch off posting for every ordinary member — through a path with no RPC and no
  //   audit row. Nothing in the app writes this table.
  'community_tags_admin_all',
];

/** Own-row write policies whose enrolment-standing conjunct #56 widens (section 8d). */
const STAFF_OWN_WRITE = [
  'community_posts_own_insert', 'community_posts_own_update',
  'community_comments_own_insert', 'community_comments_own_update',
  'community_reactions_own_insert', 'community_attachments_own_insert',
  'community_post_tags_own_insert',
  // ★ The OBJECT upload, not just the attachment row. Widening one without the other left
  //   staff with attach buttons the storage layer refused — and the upload runs BEFORE the
  //   post insert, so the whole publish aborted.
  'community_media_own_insert',
];
const MANAGE_POLICIES = [
  'community_channel_plans_admin_select',
  'community_channel_batches_admin_select', 'community_channel_events_admin_select',
];
const STAFF_READ_POLICIES = [
  'community_posts_read', 'community_comments_read', 'community_reactions_read',
  'community_reactions_own_delete', 'community_attachments_read',
  'community_attachments_own_delete', 'community_tags_read', 'community_post_tags_read',
  'community_post_tags_own_delete', 'community_notifications_own_select',
  'community_notifications_own_update', 'community_announcement_reads_own_select',
  'community_announcement_reads_own_insert', 'community_spaces_read',
  'community_channels_read', 'community_channel_categories_read', 'community_settings_read',
];

for (const file of FILES) {
  test(`${file}: no altered community policy still names is_admin()`, () => {
    const s = section56(file);
    for (const name of [...SUPER_ONLY_ALL, ...MANAGE_POLICIES, ...STAFF_READ_POLICIES,
      ...STAFF_OWN_WRITE, 'community_media_read', 'community_media_delete']) {
      const clause = alterPolicy(s, name);
      assert.ok(clause, `${name} is not altered by #56`);
      assert.ok(!clause.includes('public.is_admin()'),
        `${name} still gates on is_admin() — the two predicates are no longer equivalent`);
    }
  });

  test(`${file}: a FOR ALL policy is altered with BOTH clauses`, () => {
    // Passing only `using` widens the read path and leaves WRITES on is_admin(): fail
    // closed, but it presents as a moderator who can SEE a hidden post and gets 42501
    // trying to unhide it.
    const s = section56(file);
    for (const name of SUPER_ONLY_ALL) {
      const clause = alterPolicy(s, name);
      assert.ok(clause.includes('using ('), `${name}: missing using`);
      assert.ok(clause.includes('with check ('), `${name}: FOR ALL needs with check too`);
    }
  });

  test(`${file}: the INSERT policy is altered with WITH CHECK only`, () => {
    // `using` on an INSERT policy is a syntax error, mid-file, with no transaction.
    const clause = alterPolicy(section56(file), 'community_announcement_reads_own_insert');
    assert.ok(clause.includes('with check ('));
    assert.ok(!/\busing\s*\(/.test(clause),
      'an INSERT policy has no USING clause');
  });

  test(`${file}: NO blanket FOR ALL policy is reachable by a non-super role`, () => {
    // The single most important assertion in this file. See SUPER_ONLY_ALL above: these are
    // unbounded client write paths, and community.moderate is held by two roles that must
    // reach other people's content ONLY through the audited RPCs.
    const s = section56(file);
    for (const name of SUPER_ONLY_ALL) {
      const clause = alterPolicy(s, name);
      assert.ok(clause.includes('public.is_super_admin()'),
        `${name} must stay Super-Admin-only — it is a blanket client write path`);
      assert.ok(!clause.includes("has_staff_permission('community.moderate')"),
        `${name} is FOR ALL: gating it on community.moderate would let a Trainer rewrite `
        + "another member's body and author_id straight through PostgREST, with no ledger row");
      assert.ok(!clause.includes('is_community_staff()'),
        `${name} must not admit the community-staff union either`);
    }
  });

  test(`${file}: staff get an OWN-ROW write path, and only own-row`, () => {
    // is_enrolled() is false for a staff account with no subscription, so without this an
    // Operations Admin could moderate the forum and never post in it.
    const s = section56(file);
    for (const name of STAFF_OWN_WRITE) {
      const clause = alterPolicy(s, name);
      assert.ok(clause, `${name} is not altered by #56`);
      assert.ok(clause.includes('public.is_community_staff()'),
        `${name} must admit staff standing`);
      assert.ok(clause.includes('public.is_enrolled()'),
        `${name} must keep the member arm exactly as it was`);
      const owns = ['author_id = (select auth.uid())',
                    '(storage.foldername(name))[1] = ((select auth.uid()))::text',
                    'user_id = (select auth.uid())',
                    'uploader_id = (select auth.uid())'];
      assert.ok(owns.some((t) => clause.includes(t)),
        `${name} must stay bound to the caller's own row — that is what stops it becoming `
        + 'the blanket write path 8a refuses to open');
    }
  });

  test(`${file}: config policies use community.manage, reads use is_community_staff`, () => {
    const s = section56(file);
    for (const name of MANAGE_POLICIES) {
      assert.ok(alterPolicy(s, name).includes("has_staff_permission('community.manage')"),
        `${name} is configuration`);
    }
    for (const name of STAFF_READ_POLICIES) {
      assert.ok(alterPolicy(s, name).includes('public.is_community_staff()'),
        `${name} is a staff READ / standing arm`);
    }
  });

  test(`${file}: the read policies keep their channel scope and member arms`, () => {
    // Only the FIRST disjunct moves. If a re-typed qual dropped the channel scope, a
    // student could read every room.
    const s = section56(file);
    for (const name of ['community_posts_read', 'community_comments_read',
      'community_reactions_read', 'community_attachments_read', 'community_post_tags_read']) {
      const clause = alterPolicy(s, name);
      assert.ok(clause.includes('my_community_channel_ids()'),
        `${name} lost its channel scope`);
      assert.ok(clause.includes('public.is_enrolled()'),
        `${name} lost the member enrolment gate`);
    }
    assert.ok(alterPolicy(s, 'community_posts_read').includes("author_id = (select auth.uid()) and status = 'deleted'"),
      'the author-owns-deleted branch is what makes member soft-delete possible at all '
      + '(the #36 bug) and must survive');
  });
}

// ── Storage, the ledger, the RPCs, and the error-code lockstep ──────────────

for (const file of FILES) {
  test(`${file}: a moderator's storage delete is BOUNDED, and the blanket arm stays super-only`, () => {
    const clause = alterPolicy(section56(file), 'community_media_delete');
    assert.ok(clause.includes('public.is_super_admin()'),
      "today's blanket bucket reach must stay Super-Admin-only");
    assert.ok(!clause.includes('public.is_admin()'));
    // The bound is the attachment join to a LIVE post, not the channel test — after the
    // visibility widening, community staff reach every channel anyway.
    const moderatorArms = clause.split("has_staff_permission('community.moderate')").length - 1;
    assert.equal(moderatorArms, 2, 'exactly two moderator arms: the join arm and the receipt arm');
    assert.ok(clause.includes('a.storage_path = name'),
      'the join arm must be bound to an existing attachment of an existing post');
    assert.ok(clause.includes("e.action = 'delete'") && clause.includes('community_moderation_events'),
      'the receipt arm must be bound to this actor\'s own audited delete');
    assert.ok(clause.includes("interval '15 minutes'"), 'the receipt arm must expire');
    assert.ok(clause.includes('e.actor_id = (select auth.uid())'),
      'a receipt must belong to the caller, not to any moderator');
    // #40 + #43's member arms, reproduced.
    assert.ok(clause.includes('a.uploader_id = (select auth.uid())'), 'the uploader arm is gone');
    assert.ok(clause.includes('not exists (select 1 from public.community_attachments a2'),
      "#43's own-orphan branch is gone — the composer's failed-upload cleanup would 403");
  });

  test(`${file}: the moderation ledger is append-only from a client`, () => {
    const s = section56(file);
    assert.ok(s.includes('revoke insert, update, delete, truncate on public.community_moderation_events'),
      'a client must not be able to forge, edit or erase an audit row');
    assert.ok(s.includes('enable row level security'), 'RLS must be on');
    const policies = [...s.matchAll(/create policy (community_moderation_events_\w+)/g)].map((m) => m[1]);
    assert.deepEqual(policies, ['community_moderation_events_staff_select'],
      'exactly one policy, and it is a SELECT — the only writer is the SECDEF RPC');
    assert.ok(!/community_moderation_events[\s\S]{0,400}?references public\.community_posts/.test(s),
      'target_id must carry NO foreign key: the delete action hard-deletes the row it '
      + 'names, and CASCADE would erase the audit trail of the deletion itself');
  });

  test(`${file}: the moderation RPCs are bounded by construction`, () => {
    const s = section56(file);
    for (const fn of ['community_moderate_post', 'community_moderate_comment']) {
      const at = s.indexOf(`create or replace function public.${fn}(`);
      assert.notEqual(at, -1, `${fn} is missing`);
      const body = s.slice(at, s.indexOf('$mod$;', at));
      assert.ok(body.includes('security definer'), `${fn} must be SECURITY DEFINER`);
      assert.ok(body.includes('set search_path = public, pg_temp'), `${fn}: explicit search_path`);
      assert.ok(body.includes("has_staff_permission('community.moderate')"), `${fn}: guard`);
      assert.ok(body.includes('MODERATION_ACTION_INVALID'), `${fn}: strict action enum`);
      assert.ok(body.includes('MODERATION_TARGET_NOT_FOUND'), `${fn}: target check`);
      assert.ok(body.includes('user_community_channel_ids(v_actor)'),
        `${fn} must re-check the channel with the CALLER-pinned subject`);
      assert.ok(body.includes('for update'), `${fn}: the row lock serialises two moderators`);
      // The whole safety argument: no argument can name a content column.
      for (const col of ['p_body', 'p_title', 'p_author', 'p_channel', 'p_created']) {
        assert.ok(!body.includes(col), `${fn} accepts ${col} — it must not`);
      }
      assert.ok(!/set\s+\w+\s*=\s*[^,\n]+,\s*\w+\s*=/.test(body),
        `${fn} performs a multi-column UPDATE; one column per action`);
    }
    assert.ok(s.includes('revoke all on function public.community_moderate_post(uuid, text, text) from public, anon;'));
    assert.ok(s.includes('grant execute on function public.community_moderate_post(uuid, text, text) to authenticated;'));
  });

  test(`${file}: a moderator cannot resurrect an author's own withdrawal`, () => {
    const s = section56(file);
    const hits = s.split('MODERATION_STATE_INVALID').length - 1;
    assert.ok(hits >= 2, 'both RPCs must refuse restoring a status=deleted row');
  });
}

test('the three new error codes are in lockstep across SQL and the client', () => {
  const sql = read(MIGRATION);
  for (const code of ['MODERATION_TARGET_NOT_FOUND', 'MODERATION_ACTION_INVALID',
    'MODERATION_STATE_INVALID']) {
    assert.ok(sql.indexOf("('" + code + "'") !== -1, code + ' missing from app_error_catalog()');
    assert.ok(APP_ERROR_CODES.includes(code), `${code} missing from APP_ERROR_CODES`);
    assert.ok(APP_ERROR_COPY[code], `${code} has no user-facing copy`);
  }
});

test('the catalog rewrite drops no existing code', () => {
  const sql = read(MIGRATION);
  const at = sql.indexOf('create or replace function public.app_error_catalog()');
  const catalog = sql.slice(at, sql.indexOf('$cat$;', at));
  for (const code of APP_ERROR_CODES) {
    if (code === 'MIGRATION_MISSING') continue;   // client-synthesised, never raised by SQL
    assert.ok(catalog.includes(`('${code}'`), `${code} fell out of the rewritten catalog`);
  }
});
