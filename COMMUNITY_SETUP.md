# Community — in-app member forum setup

The group chat that used to live on Discord now has a first-class home inside the toolkit:
**Community** (sidebar → Home → Community, route `/community`). It is a full forum: categorized
discussions with search, free-form tags, image/video/link attachments, @mentions, reactions on
posts and replies, pinned posts, admin announcements with per-member read-tracking, member
profile pictures, and a notification bell. This doc is the backend walkthrough — **two** SQL
migrations and **two** storage buckets, no env vars.

## What you get

- **A forum home** — category rail with per-category counts, filter tabs
  (Latest / New / Unanswered / Announcements), debounced search over titles + bodies,
  free-form `#tag` filtering, pinned-first ordering, a right rail (latest announcements ·
  most-active discussions · popular tags), and a live "new discussions" pill.
- **Discussions** — title + body + exactly one category (Announcements, Introductions,
  QuickBooks Help, US Bookkeeping, Course Questions, Job Applications, Resume & Interview,
  Client Management, Wins, General Questions), up to 5 free-form tags, and up to 4
  attachments: images (≤5 MB), videos (≤50 MB), and external links. Every discussion has a
  deep-linkable URL (`/community?post=<id>`).
- **Replies and reactions** — flat reply threads with @mention support; three reaction types
  (Like / Celebrate / Helpful) on **both posts and replies**, one of each max per member per
  item, toggle on/off.
- **@Mentions** — typing `@` in a composer opens an autocomplete (display name + avatar —
  **never email**); mentioned members get a notification. Mentions are stored as
  `@[Name](uuid)` markup and parsed **server-side** by the notify triggers.
- **Notification bell** — in the sidebar identity card, the collapsed rail, and the mobile
  top bar. Unread = replies to your discussions + mentions of you + unread announcements.
  Realtime; "mark all read"; clicking an item deep-links to the post.
- **Admin announcements** — the Announcements category is **admin-only for posting**
  (enforced in the database policy, not just the UI) and **read-only for members**:
  announcements are born `comments_locked` (server trigger), so members react and mark
  as read but never comment. Unread announcements surface in the bell and as dots in the
  feed/right rail.
- **Inline moderation** — admins pin/unpin, lock/unlock replies, hide/restore, and
  hard-delete any post or reply (hidden rows vanish for members, stay visible-but-badged
  for admins). Members edit and soft-delete only their **own** posts/replies.
- **Profile pictures** — members upload an avatar in **Profile & Settings** (⋮ account menu).
  It shows in the sidebar, account menu, mention autocomplete, and beside every post/reply.
- **Membership-scoped access** — every **active** paid plan includes Community. Access is
  enforced server-side by the same `is_approved()` + `is_enrolled()` RLS that guards course
  content, so it ends automatically when the membership term (+ 3-day grace) ends — expired
  members are fully blocked, reads included. The Sampler Session's **60-day group chat
  support** is exactly its 60-day access window.
- **Live-ish feed** — new posts/replies/notifications stream in via Supabase realtime when
  available, with a throttled on-focus refetch as the fallback.

## How it works

- **Tables** — base feed in [db/2026-07-20-community.sql](db/2026-07-20-community.sql) (#23):
  `community_tags` (seeded category list; `admin_only` marks Announcements) →
  `community_posts` → `community_comments` (both carry `status`
  `'active' | 'hidden' | 'deleted'`) and `community_reactions`. The forum upgrade
  [db/2026-07-21-community-forum.sql](db/2026-07-21-community-forum.sql) (#24) adds:
  - `community_posts.pinned` / `comments_locked` / `comment_count` / `last_activity_at`
    (+ `author_avatar_url` on posts/comments). These are **server-controlled**: the
    `community_posts_guard()` trigger zeroes counters and blocks pin/lock changes for
    non-admins; `community_comment_rollup()` recomputes `comment_count` (active replies
    only) and advances `last_activity_at` — this is what powers the Unanswered filter and
    activity sort without PostgREST embeds.
  - `community_attachments` (kind `image | video | link`; files carry `storage_path` in the
    private **community-media** bucket, links carry `url`), `community_post_tags`
    (normalized free-form slugs), `community_notifications` (reply/mention fan-out),
    `community_announcement_reads` (per-member "seen it" markers).
  - `community_reactions.comment_id` (XOR with `post_id` + a partial unique index) — the
    same table now serves post AND reply reactions.
- **Author identity is denormalized — and server-stamped.** Non-admins cannot read other
  users' `profiles` rows (deliberate RLS), so each post/reply stores `author_name` **and
  `author_avatar_url`** — the `enrollment_requests.full_name` precedent. The values are
  **never trusted from the client**: the SECURITY DEFINER `community_stamp_author()` trigger
  overwrites them from the author's own profile on insert and freezes them on update, so a
  direct API call can't impersonate another member.
- **Notifications are unforgeable.** `community_notifications` has **no insert policy** —
  rows are written only by the SECURITY DEFINER triggers `community_notify_on_comment()`
  (mentions ∪ the post author, deduped, self-skipped) and `community_notify_on_post()`
  (mentions only), which parse the `@[Name](uuid)` markup out of the **stored** body (cap 10
  per row). Recipients read + mark-read their own rows; nobody can spoof a notification for
  someone else.
- **Profile pictures** go through `set_my_avatar(p_path)` — a SECURITY DEFINER RPC and the
  **one** sanctioned user-facing `profiles` write (`profiles` still has NO user UPDATE
  policy; an open row policy would expose `is_paid`/`plan`). It validates the path is inside
  the caller's own `avatars/<uid>/` folder, updates `avatar_url`, and back-fills the
  caller's denormalized `author_avatar_url` so old posts show the new picture.
  `search_community_members(p_query)` is the mention directory: SECURITY DEFINER, enrolled
  members only, returns `id + display_name + avatar_url`, **never selects email**, and
  excludes profiles with no display name.
- **Storage:**
  - `avatars` — **public** bucket (avatars are meant to be seen; rendered via
    `getPublicUrl`). 5 MB, image mimes. Members write only inside their own `<uid>/` folder.
  - `community-media` — **private** bucket (member-only content; a public bucket serves
    every object publicly and bypasses RLS — the course-videos precedent). 50 MB,
    image + video mimes. Members upload only inside their own `<uid>/` folder; enrolled
    members read via short-lived **batched signed URLs** (`createSignedUrls`, one call per
    feed page). Admin hard-delete of a post also removes its files (attachment files are
    never shared across posts, so no reference-count check is needed — unlike course media).
    A member's soft-delete leaves files in place (rows survive; acceptable orphan risk).
- **Moderation model:** members never hard-DELETE (their "delete" sets `status='deleted'`,
  keeping threads/counts consistent); admins hard-delete (FK cascade clears a post's
  replies/reactions/attachments/notifications). An author can never un-hide a post an admin
  hid, can't move a post into an admin-only category on edit, and can't touch
  `pinned`/`comments_locked` (trigger-frozen) — all enforced server-side.
- **RLS summary:** reads = admin, or (`status='active'` + approved + enrolled); inserts =
  own row + approved + enrolled (+ the admin-only category check on posts; attachments/tags
  additionally require the parent post to be **your own**); updates = own row (edit /
  soft-delete / mark-read); `*_admin_all` catch-alls for moderation. Member reply reads and
  inserts additionally require the **parent post to be active** — hiding a post hides its
  whole thread and freezes new replies; reply inserts on a `comments_locked` post are
  refused (reactions stay allowed — announcements are react-only by design). Helpers are
  `(select …)`-wrapped for once-per-query InitPlans.
- **Client:** the `CommunityHub` component in `src/BookkeeperPro.jsx` (tab id `community`),
  plus the shared `MemberAvatar` primitive, the `AvatarSection` uploader in Profile &
  Settings, and the root-mounted `useCommunityBell` + `NotificationBell`. The tab is in
  every plan's entitlement allowlist; the sidebar/tab gate is cosmetic — RLS is the boundary.
  The `?post=<id>` deep link mirrors the course catalog's `?course=` URL idiom.

## Spaces & batches (#32 — automatic student segregation)

Since [`db/2026-07-28-community-spaces-batches.sql`](db/2026-07-28-community-spaces-batches.sql)
the community is split into **spaces**:

- **General** — every active plan (Core / Sampler / Silver / Gold / VIP + legacy grandfathers).
  Members **post and react but cannot reply** (`community_spaces.member_comments = false`;
  historical replies stay readable). Admins can still reply (moderation, via `*_admin_all`).
- **Gold — \<batch\>** and **VIP — \<batch\>** — one PRIVATE full-forum space per cohort
  (`batches` row, e.g. `2026-08` "August 2026"), auto-created when the batch is created.
  Gold and VIP are never combined, and batches never see each other's private spaces.

**How access derives (no membership table):** `my_community_space_ids()` reads the member's
current valid subscription (active + date-valid incl. the 3-day grace) → General always, plus
the premium space where `enrollment_plans.community_segment` (gold_live → `gold`, vip → `vip`)
and `subscriptions.batch_id` match. Unknown/legacy plans and premium subs **without a batch**
get General only (fail closed — those members appear in Admin → Batches → "Needs batch
assignment"). Expiry, renewal, upgrade, and downgrade therefore apply on the very next query
with nothing to sync or revoke. Every community policy (+ the `community-media` storage read)
is scoped `space_id in (select my_community_space_ids())`; mention search and category counts
take a `p_space_id`; the notify triggers drop cross-space mention uuids; posts/comments carry a
trigger-stamped, frozen `space_id`. New attachment uploads use `<space_id>/<uid>/<uuid>-<name>`
paths (legacy `<uid>/…` files keep working — read authorization is attachment-join based).

**Where batches come from:** the paywall makes Gold/VIP students pick an OPEN batch at
checkout; the transactional `admin_finalize_enrollment()` RPC validates it (open status +
optional per-segment capacity) at approval; imports carry an explicit `batch_code` column;
and Admin → **Batches** manages cohorts (create/close/archive, capacities, bulk assignment —
each change audited in `batch_events`).

> **Capacity is enforced on two paths only** — approval (`admin_finalize_enrollment()`) and
> bulk assignment (`admin_assign_batch()`), both under a batch row lock. **Bulk imports and
> direct SQL grants do not consume seats**, so a premium import can push a batch past its
> stated capacity. Check the counts in Admin → Batches after importing a cohort.

> **Archiving a batch also blocks its members' renewals and extensions** (the approval RPC
> refuses an archived batch before the existing-member carve-out). It never revokes access
> already granted. Use **Close** to stop new assignments while letting members renew.

**Client:** a space switcher appears under the Community header once more than one space is
accessible (`/community?space=<slug>&post=<id>` deep links; gold/vip members land in their
private space by default; the last selection persists per user). On a pre-#32 database the
client silently runs the old single-space forum and admins see a setup notice.

> **The client half of #32 ships in the app bundle, not in the SQL.** Running the migration
> alone does not deliver the space switcher, the batch pickers, Admin → Batches, or the
> single-RPC approve path — those need the matching build deployed.

## Setup order at a glance

1. Prerequisites already in place from earlier setup: user-approval (#9), enrollment (#12),
   subscription-lifecycle (#13) — see [db/README.md](db/README.md).
2. Run the community feed migration **#23** (Step 1).
3. Run the forum upgrade migration **#24** (Step 2).
4. If the bucket creation raised a NOTICE, create the two buckets by hand (Step 3).
5. Run the write-gate migration **#28** ([`db/2026-07-26-community-write-gate.sql`](db/2026-07-26-community-write-gate.sql)) — closes an RLS gap so an expired member can't edit/soft-delete their own posts/comments via REST. Idempotent, policy-only. (A **fresh** install already has it from the bootstrap.)
6. Run the spaces & batches migration **#32** ([`db/2026-07-28-community-spaces-batches.sql`](db/2026-07-28-community-spaces-batches.sql)) — the General + per-batch Gold/VIP model above. Needs #12 + #13 + #20 + #23/#24 + #30; run after #29/#31. Existing posts backfill into General; the August 2026 batch (`2026-08`) is seeded open. (A **fresh** install gets it from the bootstrap §19.)
7. Run the batch hardening migration **#33** ([`db/2026-07-29-community-batch-hardening.sql`](db/2026-07-29-community-batch-hardening.sql)) — seat-occupancy capacity fix, attachment path binding, set-based mention search, notification column grant — **immediately followed by #34** ([`db/2026-07-29-batch-hardening-followup.sql`](db/2026-07-29-batch-hardening-followup.sql)), which corrects #33's copy of `admin_finalize_enrollment` and gates `community_media_delete`. Running #33 without #34 leaves the approval RPC missing its `updated_at`/`rejected_*` housekeeping. Both additive and idempotent. (A **fresh** install gets them from the bootstrap §20/§21.)
8. **Deploy the matching client build.** Steps 2–5 were RLS-only and went live on refresh; **#32 is not** — see the callout above. Until the new build is deployed there is a known gap: General ships with member replies OFF, so the *old* client still renders reply composers whose inserts RLS now refuses. If that window will be long, soften it with one row:
   ```sql
   update public.community_spaces set member_comments = true where slug = 'general';
   ```
   and set it back to `false` in the same session as the deploy.
9. Refresh the app — the forum goes live.

## Step 1 — Run the community migration (#23, required)

Supabase dashboard → **SQL Editor** → paste **all** of
[`db/2026-07-20-community.sql`](db/2026-07-20-community.sql) → **Run**. Idempotent; safe to
re-run. **Order:** after user-approval (#9) + enrollment (#12) + subscription-lifecycle (#13) —
it stops with a clear exception if `is_approved()` / `is_enrolled()` are missing. (A **fresh**
install gets everything — #23 AND #24 — from `db/000_full_database_bootstrap.sql` instead;
don't run both paths.)

## Step 2 — Run the forum upgrade (#24, required)

Same SQL Editor → paste **all** of
[`db/2026-07-21-community-forum.sql`](db/2026-07-21-community-forum.sql) → **Run**. Idempotent;
safe to re-run; stops with a clear exception if #23 hasn't run. It aligns the 10 categories,
adds the forum columns + backfills, creates the four new tables, the guard/rollup/notify
triggers, the `set_my_avatar()` / `search_community_members()` RPCs, both storage buckets +
policies, and adds `community_notifications` to the realtime publication.

Verify with:

```sql
select slug, label, position from public.community_tags order by position;   -- 10 rows
select id, public from storage.buckets where id in ('avatars','community-media');
select proname from pg_proc where proname in ('set_my_avatar','search_community_members');
```

## Step 3 — Storage buckets (only if Step 2 raised a NOTICE)

If your SQL role couldn't write `storage.buckets`, create them in **Dashboard → Storage**:

| Bucket | Public | File size limit | Allowed mime types |
|---|---|---|---|
| `avatars` | **ON** | 5 MB | `image/jpeg, image/png, image/webp, image/gif` |
| `community-media` | **OFF** | 50 MB | the image types above + `video/mp4, video/webm, video/quicktime` |

The object policies were already applied by the migration either way.

## Troubleshooting

- **The Community tab shows "Finish backend setup" (admins) / "Community is coming soon"
  (members).** #23 hasn't run in this Supabase project — run Steps 1–2, then refresh.
- **The tab says "The forum upgrade hasn't been applied yet."** #23 ran but #24 didn't (the
  client hit a missing column — e.g. `comment_count`). Run Step 2, then refresh.
- **Avatar upload says "Profile pictures aren't set up yet."** The `avatars` bucket or the
  `set_my_avatar()` RPC is missing — run Step 2 (and Step 3 if it NOTICEd).
- **Attachments upload fails.** The `community-media` bucket is missing (Step 2/3), or the
  file breaches the bucket caps (50 MB / mime allowlist — enforced server-side even if the
  client checks are bypassed).
- **The bell never appears.** It self-disables on a pre-#24 database (missing
  `community_notifications`) and for signed-out/gated users. Run Step 2; the bell shows on
  the next app load.
- **Mentions don't notify.** The notify triggers only parse the stored `@[Name](uuid)`
  markup — a hand-typed plain `@name` renders as text and notifies nobody (by design; use
  the autocomplete). Also check `community_notifications` exists (#24).
- **New posts don't appear for other members until they refocus the tab.** Realtime isn't
  active for the community tables (publication add skipped, or realtime disabled on the
  project). Harmless — the feed refetches on window focus (throttled to ≥30s) and new posts
  surface as the "new discussions" pill. To fix streaming, re-run the migrations or check
  Database → Replication in the dashboard.
- **A member gets an error posting in Announcements.** By design — the
  `community_posts_own_insert` policy blocks `admin_only` categories for non-admins. The
  Announcements chip isn't offered in the member composer; a direct API attempt is refused
  by RLS.
- **A member asks why they can't reply to an announcement.** By design — announcements are
  born `comments_locked` (react + mark-as-read only). Questions belong in the regular
  categories.
- **A member sees no Community tab at all.** Their plan's entitlement allowlist gates the
  sidebar cosmetically, but every shipped plan includes `community` — so this means the app
  build predates the feature, or the member is held on a gate screen (pending/expired), which
  blocks the whole app, not just Community.
- **An expired member asks why they lost the community.** Expected: `is_enrolled()` date-checks
  the subscription term (+ grace). Renewing (any plan) restores access instantly — no
  admin action needed beyond the normal renewal approval.
- **Deleting a member's account.** `community_*.author_id` / `user_id` columns cascade from
  `profiles`, so deleting the profile removes their posts/replies/reactions/notifications/
  read-markers. Their storage uploads (avatars + community-media) are removed by admin
  cleanup if needed (Storage → browse the `<uid>/` folders).
- **The space switcher never appears.** #32 isn't applied (the client runs legacy single-space
  mode — admins see the inline setup notice naming the migration), or the member genuinely has
  only General (every non-Gold/VIP plan — the switcher hides with a single accessible space).
- **A Gold/VIP member sees only General.** Their active subscription has no `batch_id` —
  grants made outside `admin_finalize_enrollment()` (SQL editor, imports without a
  `batch_code`) land batch-less by design (fail closed). Assign them in Admin → **Batches** →
  "Needs batch assignment".
- **A member asks why they can't reply in General.** By design (#32): General is
  posts + reactions only (`community_spaces.member_comments = false`); replies live in the
  premium batch communities. Flip it back anytime with
  `update public.community_spaces set member_comments = true where slug = 'general';` —
  no migration needed.
- **A mention doesn't autocomplete or notify in a private space.** The directory and the
  notify triggers are space-scoped: only currently-eligible members of THAT space match, and
  a cross-space uuid pasted into the body notifies nobody. Both are server-enforced.
- **Approvals fail with "Approvals need migration #32".** The single-RPC approve path
  (`admin_finalize_enrollment`) is deployed but the migration isn't — run
  `db/2026-07-28-community-spaces-batches.sql`, then click Approve again (nothing was granted).
