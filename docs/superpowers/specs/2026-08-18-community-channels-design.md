# Community Channels (#40) — design

**Status:** approved scope, implementation in progress
**Date:** 2026-08-18
**Migration:** `#40` — `db/2026-08-18-community-channels.sql`
**Supersedes nothing.** Extends #23/#24/#25/#28/#32/#33/#34/#35/#36/#37/#39.

> Path classification: **architectural**. New subsystem, new authorization layer,
> changes interfaces (`my_community_spaces()` gains a sibling, the posts guard changes
> shape, a named CHECK constraint is retired). The commissioning brief authorised
> end-to-end implementation up front; this document is the design record, not a
> request for a second approval.

---

## 1. The problem

The community is one flat feed per **space**. Spaces are the entitlement boundary
(General + one private VIP space per batch) and there is exactly one conversation
surface inside each. Categories exist only as `community_tags` — a per-post taxonomy,
not a navigation or authorization concept.

That means:

- Every General member sees one undifferentiated stream.
- There is no way to give one plan (or one cohort) its own room without minting a whole
  new *space*, which is welded to the batch registry by `community_spaces.batch_id` and
  the `unique (kind, batch_id)` constraint.
- **D2** (#36) made General announcement-only via a CHECK constraint
  (`community_spaces_general_announcement_only`) plus `can_post_in_general = false` on
  every plan. It is a space-wide prohibition, so there is no room in General where
  members may talk at all.

The product needs Discord-shaped navigation: grouped, named rooms with per-room
audiences and per-room posting rules.

## 2. The core architectural decision

**Channels narrow a space. They never widen one.**

```
Community
 └── community_spaces          L1 — entitlement boundary        (UNCHANGED)
      └── community_channel_categories   organisation only, never authorization
           └── community_channels        L1.5 — audience + L2 rights
                └── community_posts      (gains channel_id)
                     └── community_comments (gains channel_id)
```

Every channel read is `channel.space_id ∈ user_community_space_ids(user)` **AND** the
channel's own audience test. A bug in the channel layer can only ever *remove* access,
never grant access to a space the member was not already entitled to. The existing L1
seam — `user_entitled_batches()` → `user_community_space_ids()` — is not touched.

The three existing seams are preserved and mirrored one level down:

| Existing (space) | New (channel) |
|---|---|
| `user_community_space_ids(uuid)` / `my_community_space_ids()` | `user_community_channel_ids(uuid)` / `my_community_channel_ids()` |
| `user_community_capabilities(uuid)` / `my_community_capabilities()` | `user_community_channel_capabilities(uuid)` / `my_community_channel_capabilities()` |
| `my_community_spaces()` (sidebar) | `my_community_sidebar()` (sidebar) |
| `community_write_denial(space, kind)` | `community_channel_write_denial(channel, kind)` |

Content policies switch their scoping predicate from
`space_id in (select my_community_space_ids())` to
`channel_id in (select my_community_channel_ids())` and their write predicate from
`space_id in (select ... my_community_capabilities() where can_X)` to
`channel_id in (select ... my_community_channel_capabilities() where can_X)`.
The **uncorrelated `IN (select …)` InitPlan idiom from #29 is preserved verbatim** —
this is the single most important performance property of the existing policy set.

## 3. Audience model

`community_channels.audience_mode ∈ ('space','plans','batches','plans_and_batches','admins_only')`

Let `S` = the member holds L1 access to `channel.space_id`.
Let `P` = the member's **live** plan key ∈ `community_channel_plans(channel)`.
Let `B` = ∃ batch in `user_entitled_batches(member)` ∈ `community_channel_batches(channel)`.

| mode | non-admin can_read |
|---|---|
| `space` | `S` |
| `plans` | `S ∧ P` |
| `batches` | `S ∧ B` |
| `plans_and_batches` | `S ∧ P ∧ B` — **intersection** |
| `admins_only` | `false` |

plus `channel.status = 'active'` for every non-admin mode. Admins get every channel in
every state (they need archived ones in the editor).

**Fail-closed properties, all structural rather than defensive:**

- An empty mapping makes `P` (or `B`) an `EXISTS` over zero rows → `false`. A `plans`
  channel with no plans selected is invisible to everyone but admins. No special case.
- A member with no live subscription has `plan_key = NULL`; `cp.plan_key = NULL` is
  `NULL`, never `true`.
- `B` is read from `user_entitled_batches()` — the authoritative ledger, which already
  requires the stamped seat segment to equal the member's *live* plan segment. Batch
  **status** is deliberately not consulted: closing or archiving a batch must not revoke
  a seat a member already paid for. Nothing anywhere reads a batch name, code, month or
  price.
- An unknown `audience_mode` value falls to the `else false` arm of the `CASE`.

## 4. Rights model

Space capabilities remain the ceiling; channel flags narrow them.

```
can_read    = is_admin ∨ (audience test above)
can_post    = is_admin ∨ (can_read ∧ space.can_post    ∧ ch.member_posting     ∧ ch.status='active')
can_comment = is_admin ∨ (can_read ∧ space.can_comment ∧ ch.member_comments    ∧ ch.status='active')
can_react   = is_admin ∨ (can_read ∧ space.can_react   ∧ ch.member_reactions   ∧ ch.status='active')
can_attach  = is_admin ∨ (can_read ∧ space.can_attach  ∧ ch.member_attachments ∧ ch.member_posting ∧ ch.status='active')
```

`space.can_*` is `user_community_capabilities()` verbatim — which is itself
`plan capability × space flag × L1 membership × approved`. So the full chain is
**plan × space × channel**, and `can_attach` still requires the right to create the
thing an attachment hangs off (the #36 property).

Announcement channels are enforced by a CHECK, not by policy prose:

```sql
constraint community_channels_announcement_no_member_posting
  check (kind = 'text' or member_posting = false)
```

so `kind='announcement'` ⇒ `member_posting=false` ⇒ `can_post=false` for every member,
and it cannot be flipped by an admin UPDATE that forgets to change the kind.

## 5. Retiring D2 as a space-wide rule

D2 currently lives in three places that must move together:

1. `community_spaces_general_announcement_only` CHECK — **dropped**.
2. `community_spaces` General row `member_posting/member_comments = false` — **flipped to true**.
3. `enrollment_plans.can_post_in_general` / `can_comment_in_general` = false for all three
   plans — **flipped to true**.

D2's *intent* — "only admins post announcements, and nobody replies to them" — is
re-expressed as channel state on `#announcements`:
`kind='announcement'` (⇒ `member_posting=false`) **and** `member_comments=false`,
`member_reactions=true`. Posts created in an announcement channel are born
`comments_locked`, matching the existing admin-only-tag behaviour.

`can_upload_attachments` is **not** touched: sampler and silver stay `false`, VIP stays
`true`. The brief is explicit that attachment rights keep their existing fail-closed
plan semantics.

**This is a deliberate, recorded product policy change**, exactly as the constraint's own
COMMENT demands ("DROP this constraint explicitly and record it in db/README.md"). The
replacement is tested: `test-db/communityChannels.dbtest.mjs` asserts that relaxing the
parent space does **not** make every channel writable — sampler can post in
`#general-discussion` and is refused in `#announcements`, in `#wins-and-opportunities`
(plans-scoped to VIP) and in every VIP channel.

## 6. Data model

New tables, all `public`, all RLS-enabled, all writes RPC-only (the `batch_entitlements`
grant idiom: `revoke insert, update, delete, truncate … from authenticated, anon, public`).

| Table | Purpose | Key columns |
|---|---|---|
| `community_settings` | singleton config | `id bool pk check(id)`, `community_name`, `description`, `welcome_message`, `default_channel_id`, `updated_at`, `updated_by` |
| `community_channel_categories` | organisation only | `id`, `space_id`, `name`, `position`, `status`, audit cols |
| `community_channels` | navigation + authorization | `id`, `space_id`, `category_id`, `slug` (immutable), `name`, `topic`, `kind`, `audience_mode`, `member_posting/comments/reactions/attachments`, `position`, `status`, `is_default`, `last_activity_at`, audit cols |
| `community_channel_plans` | audience mapping | `(channel_id, plan_key)` pk |
| `community_channel_batches` | audience mapping | `(channel_id, batch_id)` pk |
| `community_channel_reads` | per-user read marker | `(user_id, channel_id)` pk, `last_read_at`, `last_read_post_id` |
| `community_channel_events` | immutable audit | `id`, `channel_id`, `category_id`, `actor_id`, `action`, `detail jsonb`, `created_at` |

Content columns added: `community_posts.channel_id`, `community_comments.channel_id`,
`community_notifications.channel_id`. Posts and comments both carry it because a
realtime `postgres_changes` filter can only reference a column of the published table —
the same reason `space_id` was denormalised onto comments in #32.

Identity rules, all enforced by trigger rather than by trusting the client:

- `community_posts.space_id` is **derived from** `channel_id`, never accepted from the
  client. A forged `{channel_id: <vip>, space_id: <general>}` pair is silently corrected
  to the channel's real space and then judged by the channel policy.
- `channel_id` and `space_id` are frozen after insert for client-originated updates
  (the existing `pg_trigger_depth() <= 1 and auth.uid() is not null` escape hatch is kept
  so an audited admin move is still possible from the SQL editor).
- Comments inherit both from the parent post.
- A NULL `channel_id` on insert (an old client) resolves to the space's default channel,
  so pre-#40 bundles keep working. Because the seeded default is an interactive text
  channel, those inserts land somewhere writable rather than bouncing off `#announcements`.

Uniqueness: `unique (space_id, slug)`; `unique (space_id) where is_default` — one default
channel per space.

## 7. Migration and backfill

Order matters, and two steps are ordering traps of the kind #39 documented:

1. Tables, then `channel_id` columns **nullable**.
2. Seed `community_settings`, categories and channels for every existing space via
   `seed_default_channels(space_id)` — one function, also called by the batch trigger, so
   a new cohort can never get a space without channels.
3. Backfill: General `tag_slug='announcements'` → `#announcements`; other General → the
   General default; every VIP-space post → that space's `#lounge`. Comments and
   notifications derive from their parent post.
4. **Replace `community_posts_guard()` and `community_comment_space()` BEFORE adding
   `NOT NULL`** — otherwise every insert between the constraint and the trigger fails.
5. `NOT NULL` + FKs.
6. Drop the D2 CHECK, flip the General space flags and the plan capability columns
   (in that order — flipping first violates the live constraint).
7. Policies, grants, RPCs, indexes.
8. `notify pgrst` → `insert into schema_migrations`.

Nothing is deleted: no post, comment, reaction, attachment, tag, user, batch or
entitlement row. `community_tags` is untouched and keeps its role as post taxonomy —
it is *not* repurposed as categories, and both coexist (a post has a channel **and** a
tag).

Production currently holds 2 posts (both announcements, both in General), 0 comments,
0 attachments, 5 spaces, 4 batches, 12 entitlements. The backfill is written generically
regardless.

`#40` was informally earmarked in #39's log note for retiring the
`subscriptions.batch_id` bridge. That work moves to **#41**; the note is corrected in
`db/README.md`.

## 8. Search

Channel-scoped search stays the default. Cross-channel search is opt-in.
`community_posts` gains a stored generated `search_tsv` with a GIN index, and
`search_community_posts(p_query, p_channel_id, p_scope, p_limit, p_offset)` runs with
**invoker rights** so `community_posts_read` — now channel-scoped — is the authorization,
not client filtering. `websearch_to_tsquery` handles the query; the existing bounded
pagination is preserved. This replaces an unindexed `ilike '%…%'` OR-scan that would have
gotten materially worse once "all accessible channels" existed.

## 9. Frontend

- **New pure lib** `src/lib/communityChannels.js` (dependency-free, the house `src/lib`
  rule) mirroring the audience truth table, effective capabilities, selection precedence,
  slug normalisation, the access summary sentence and the widen/narrow diff.
  Pinned by `test/communityChannels.test.mjs`.
- **Capability drift is fixed first.** `src/lib/communityCapabilities.js` is currently
  imported by nothing but its own test; `CommunityHub` re-derives rights from raw space
  flags and **fails open** on an unresolved space (`!currentSpace || member_posting !== false`),
  and has no `canAttach` gate at all. Every decision site moves onto server-supplied
  effective capabilities, fail-closed while loading.
- **Navigation**: a channel rail inside the Community tab — collapsible categories,
  `#` / lock glyphs, selected state, unread dots, bounded `99+` counts. On mobile the
  same rail opens in a portaled `SidePanel`. The global app sidebar is untouched.
- **Admin editor**: one `SidePanel` (`sm:max-w-xl lg:max-w-2xl`) with Community /
  Categories / Channels / Access sections, accessible move-up/move-down reordering (no new
  drag dependency), a human-readable access summary and a privacy-impact confirmation
  before widening or narrowing.
- **Routing**: `?channel=<slug>` joins `?space=` and `?post=` in `tabHref`/`readAppRoute`,
  and is threaded through all six `writeAppRoute('community', …)` call sites. Selection
  precedence: URL → `window.storage['community:lastChannel']` → server default → first
  accessible. An unknown or inaccessible slug falls back silently — it never reveals that
  a private channel exists.
- **Realtime**: one subscription for the selected channel (`channel_id=eq.<id>`), not one
  per channel. Sidebar activity refreshes through the bounded `my_community_sidebar()`
  RPC on focus and after writes.

## 10. What is deliberately out of scope

Voice, DMs, friends, user-created servers, bots, role hierarchies, invite codes,
presence, typing indicators, custom emoji, and threads beyond the existing post/comment
model. The existing social primitives (reactions, attachments, tags, mentions,
notifications, moderation, announcement reads) are reused as-is, not rebuilt.

## 11. Lockstep obligations this feature creates

Recorded in `CLAUDE.md` so a later change cannot silently break one half:

- **Channel audience rules** → `user_community_channel_ids()` ↔ `channelAudienceAllows()`
  in `src/lib/communityChannels.js` ↔ `test/communityChannels.test.mjs` ↔
  `test-db/communityChannels.dbtest.mjs`.
- **Channel rights** → `user_community_channel_capabilities()` ↔ the channel write
  policies ↔ `effectiveChannelCaps()` ↔ both suites.
- **Community write permissions** (the existing #36 four-place rule) gains a fifth place:
  the channel flags.
- **New error codes** → `app_error_catalog()` ↔ `APP_ERROR_CODES` ↔ `APP_ERROR_COPY`.
