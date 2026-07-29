-- ─────────────────────────────────────────────────────────────────────────────
-- Community Forum upgrade — pinning, attachments, tags, mentions, notifications,
-- announcement reads, comment reactions, avatars (#24)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the Community feed (#23) grows into a real forum: pinned + locked posts,
-- denormalized activity counters (Unanswered filter / activity sort), free-form
-- tags, image/video/link attachments, @mentions with notifications, per-user
-- announcement read-tracking, reactions on comments, and member profile
-- pictures (a public avatars bucket + the set_my_avatar() RPC — the ONE
-- sanctioned user-facing profiles write; profiles still has NO user UPDATE
-- policy).
--
-- MODEL / access (everything inherits #23's access model):
--   • Server gate stays is_approved() + is_enrolled() — expired members are
--     FULLY blocked (reads included), matching courses. No read-only mode.
--   • community_notifications rows are created ONLY by SECURITY DEFINER
--     triggers (reply / mention fan-out). There is deliberately NO insert
--     policy — a client can never forge a notification for another member.
--     Recipients read + mark-read their own rows.
--   • Announcements (admin_only tag) are born comments_locked (BEFORE-insert
--     trigger) — students react + mark-as-read, never comment. Unread state is
--     computed from community_announcement_reads (no per-member fan-out rows).
--   • pinned / comments_locked / comment_count / last_activity_at are
--     SERVER-CONTROLLED columns: community_posts_guard() zeroes them on member
--     INSERT and freezes them on member UPDATE (RLS row policies cannot do
--     column-level protection). Admins toggle pin/lock via their admin_all
--     policy; counters are maintained by community_comment_rollup().
--   • author_avatar_url is denormalized beside author_name (same reason: other
--     members' profiles rows are unreadable) and stamped by the same trigger;
--     set_my_avatar() back-fills the author's old rows so avatars never go
--     stale.
--   • Attachments: files live in the PRIVATE community-media bucket (a public
--     bucket would bypass RLS on read — course-videos precedent), path
--     <uid>/<uuid>-<name>, rendered via short-lived signed URLs. Avatars live
--     in the PUBLIC avatars bucket (they are meant to be seen everywhere),
--     path <uid>/<uuid>.<ext>, rendered via getPublicUrl.
--
-- ORDER: run db/2026-07-20-community.sql (#23) BEFORE this file — it owns the
-- base tables/policies this file extends. The guard below stops otherwise.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor →
-- Run. IDEMPOTENT (add-column-if-not-exists, drop-policy-if-exists + create,
-- create-or-replace functions, guarded constraint/bucket/publication blocks) —
-- safe to run more than once. See COMMUNITY_SETUP.md for the walkthrough.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard.
do $$
begin
  if to_regproc('public.is_admin') is null
     or to_regproc('public.is_approved') is null
     or to_regproc('public.is_enrolled') is null then
    raise exception 'Membership helpers missing — run migrations #9/#12/#13 first (see db/README.md).';
  end if;
  if to_regclass('public.community_posts') is null then
    raise exception 'community_posts is missing — run db/2026-07-20-community.sql (#23) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) Categories — align the seeded list with the forum taxonomy:
--    add Course Questions; the old generic "Questions" becomes
--    "General Questions" at the end of the list. (Rows are never
--    deleted — deactivate with active=false if one must go.)
-- ───────────────────────────────────────────────────────────────────
insert into public.community_tags (slug, label, admin_only, position) values
  ('course-questions', 'Course Questions', false, 5)
on conflict (slug) do nothing;

update public.community_tags as t
   set label = v.label, position = v.pos
  from (values
    ('announcements',     'Announcements',      1),
    ('introductions',     'Introductions',      2),
    ('quickbooks-help',   'QuickBooks Help',    3),
    ('us-bookkeeping',    'US Bookkeeping',     4),
    ('course-questions',  'Course Questions',   5),
    ('job-applications',  'Job Applications',   6),
    ('resume-interview',  'Resume & Interview', 7),
    ('client-management', 'Client Management',  8),
    ('wins',              'Wins',               9),
    ('questions',         'General Questions', 10)
  ) as v(slug, label, pos)
 where t.slug = v.slug
   and (t.label <> v.label or t.position <> v.pos);

-- ───────────────────────────────────────────────────────────────────
-- 2) community_posts forum columns + avatar denormalization.
--    comment_count / last_activity_at power the Unanswered filter and
--    activity-sorted feed without PostgREST embeds; both are maintained
--    server-side (§4) and protected from client writes (§3).
-- ───────────────────────────────────────────────────────────────────
alter table public.community_posts add column if not exists pinned            boolean not null default false;
alter table public.community_posts add column if not exists comments_locked   boolean not null default false;
alter table public.community_posts add column if not exists comment_count     int     not null default 0;
alter table public.community_posts add column if not exists last_activity_at  timestamptz not null default now();
alter table public.community_posts add column if not exists author_avatar_url text;
alter table public.community_comments add column if not exists author_avatar_url text;

-- Backfills (safe to re-run).
update public.community_posts p
   set comment_count = (select count(*) from public.community_comments c
                         where c.post_id = p.id and c.status = 'active'),
       last_activity_at = greatest(
         p.created_at,
         coalesce((select max(c.created_at) from public.community_comments c
                    where c.post_id = p.id and c.status = 'active'), p.created_at));

update public.community_posts set comments_locked = true
 where tag_slug in (select slug from public.community_tags where admin_only)
   and comments_locked = false;

update public.community_posts p
   set author_avatar_url = pr.avatar_url
  from public.profiles pr
 where pr.id = p.author_id and p.author_avatar_url is null and pr.avatar_url is not null;

update public.community_comments c
   set author_avatar_url = pr.avatar_url
  from public.profiles pr
 where pr.id = c.author_id and c.author_avatar_url is null and pr.avatar_url is not null;

-- Forum feed order: pinned first, then latest activity.
create index if not exists community_posts_forum_idx
  on public.community_posts (status, pinned desc, last_activity_at desc);

-- ───────────────────────────────────────────────────────────────────
-- 3) community_posts_guard() — column-level protection RLS can't give.
--    On INSERT: counters start clean; non-admins can't pin; admin-only
--    categories (Announcements) are born comments_locked. On UPDATE the
--    freeze applies only to CLIENT-originated writes: trigger-originated
--    ones (community_comment_rollup runs at pg_trigger_depth() 2) and
--    no-JWT SQL (SQL editor / service role → auth.uid() is null) must
--    pass, or the rollup's counter maintenance and the §2 backfills
--    would be silently reverted. Within the frozen path, a member
--    editing their post can never flip moderation state, and counters
--    stay trigger-owned even for admins.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_posts_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members: a client-forged future date
    -- would launder into last_activity_at below and self-pin the post
    -- above the whole activity-sorted feed.
    if not public.is_admin() then
      new.created_at := now();
    end if;
    new.comment_count    := 0;
    new.last_activity_at := coalesce(new.created_at, now());
    if not public.is_admin() then
      new.pinned := false;
    end if;
    if exists (select 1 from public.community_tags t
                where t.slug = new.tag_slug and t.admin_only) then
      new.comments_locked := true;
    elsif not public.is_admin() then
      new.comments_locked := false;
    end if;
  else
    -- Freeze only client-originated updates (see header): depth > 1 =
    -- another trigger (the comment rollup) is writing; auth.uid() null =
    -- privileged SQL with no JWT (SQL editor / service role).
    if pg_trigger_depth() <= 1 and auth.uid() is not null then
      if not public.is_admin() then
        new.pinned           := old.pinned;
        new.comments_locked  := old.comments_locked;
      end if;
      new.comment_count    := old.comment_count;
      new.last_activity_at := old.last_activity_at;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.community_posts_guard() from public;

drop trigger if exists community_posts_guard on public.community_posts;
create trigger community_posts_guard
  before insert or update on public.community_posts
  for each row execute function public.community_posts_guard();

-- ───────────────────────────────────────────────────────────────────
-- 3b) community_stamp_author() — superset of the #23 version: now also
--     stamps author_avatar_url from the author's profile on INSERT. On
--     UPDATE author_name stays frozen, but the avatar is RE-STAMPED from
--     profiles (the source of truth) instead of frozen — freezing it
--     would silently revert set_my_avatar()'s denorm backfill, and the
--     re-stamp also means a forged client value never sticks. (Existing
--     triggers on posts/comments keep pointing at this name — no
--     re-create needed.)
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_stamp_author()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members (comments feed the parent's
    -- last_activity_at rollup — a forged date would top the feed forever).
    if not public.is_admin() then
      new.created_at := now();
    end if;
    select coalesce(nullif(trim(p.full_name), ''), p.email, 'Member'), p.avatar_url
      into new.author_name, new.author_avatar_url
      from public.profiles p where p.id = new.author_id;
    new.author_name := coalesce(new.author_name, 'Member');
  else
    new.created_at  := old.created_at;   -- immutable after insert
    new.author_name := old.author_name;  -- immutable after insert
    -- Re-stamp (never freeze) the avatar: profiles.avatar_url is the
    -- source of truth and its only user-facing writer is set_my_avatar().
    -- Missing profile → null → the client's initials fallback.
    select p.avatar_url into new.author_avatar_url
      from public.profiles p where p.id = old.author_id;
  end if;
  return new;
end;
$$;

revoke all on function public.community_stamp_author() from public;

-- ───────────────────────────────────────────────────────────────────
-- 4) community_comment_rollup() — recomputes the parent post's active
--    comment_count (self-healing across hide/restore/soft-delete/hard-
--    delete, unlike ±1 bookkeeping) and advances last_activity_at when a
--    new comment lands. SECURITY DEFINER: the commenting member has no
--    UPDATE policy on someone else's post row.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_comment_rollup()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
begin
  update public.community_posts p
     set comment_count = (select count(*) from public.community_comments c
                           where c.post_id = v_post and c.status = 'active'),
         last_activity_at = greatest(
           p.last_activity_at,
           coalesce((select max(c.created_at) from public.community_comments c
                      where c.post_id = v_post and c.status = 'active'), p.created_at))
   where p.id = v_post;
  return coalesce(new, old);
end;
$$;

revoke all on function public.community_comment_rollup() from public;

drop trigger if exists community_comments_rollup on public.community_comments;
create trigger community_comments_rollup
  after insert or update of status or delete on public.community_comments
  for each row execute function public.community_comment_rollup();

-- ───────────────────────────────────────────────────────────────────
-- 5) community_notifications — reply/mention fan-out. Rows are written
--    ONLY by the SECURITY DEFINER triggers below (table owner bypasses
--    RLS; there is no insert policy). actor_* and post_title are
--    denormalized so the bell dropdown renders with zero joins.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,  -- recipient
  kind             text not null check (kind in ('mention','reply')),
  actor_id         uuid references public.profiles(id) on delete set null,
  actor_name       text not null,
  actor_avatar_url text,
  post_id          uuid references public.community_posts(id) on delete cascade,
  comment_id       uuid references public.community_comments(id) on delete cascade,
  post_title       text,
  read_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists community_notifications_user_idx
  on public.community_notifications (user_id, read_at, created_at desc);

alter table public.community_notifications enable row level security;

-- Own rows AND an active membership — expired members are fully blocked,
-- notification titles/actors included (the house "reads included" rule).
drop policy if exists community_notifications_own_select on public.community_notifications;
create policy community_notifications_own_select on public.community_notifications
  for select to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

-- Only the recipient may update their row (mark read). No insert/delete policies.
drop policy if exists community_notifications_own_update on public.community_notifications;
create policy community_notifications_own_update on public.community_notifications
  for update to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))))
  with check (user_id = (select auth.uid()));

-- ───────────────────────────────────────────────────────────────────
-- 5b) Mention parsing + notification fan-out triggers. Mentions travel
--     in the body as @[Display Name](uuid) markup (the client inserts it
--     via autocomplete and renders it as a chip). Parsing happens HERE,
--     server-side, so a client can only ever notify members whose uuids
--     genuinely appear in its own stored content. Cap 10 per row.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_notify_on_comment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_name   text;
  v_actor_avatar text;
  v_post         record;
  v_title        text;
  v_done         uuid[] := array[]::uuid[];
  v_uid          uuid;
  m              text;
begin
  if new.status <> 'active' then return new; end if;
  select p.author_id, p.title, p.body into v_post
    from public.community_posts p where p.id = new.post_id;
  if v_post.author_id is null then return new; end if;
  select coalesce(nullif(trim(pr.full_name), ''), pr.email, 'Member'), pr.avatar_url
    into v_actor_name, v_actor_avatar
    from public.profiles pr where pr.id = new.author_id;
  v_title := left(coalesce(nullif(trim(v_post.title), ''), v_post.body), 120);

  for m in select (regexp_matches(new.body, '@\[[^\]]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g'))[1] loop
    exit when coalesce(array_length(v_done, 1), 0) >= 10;
    begin
      v_uid := m::uuid;
    exception when others then
      continue;
    end;
    if v_uid <> new.author_id
       and not (v_uid = any(v_done))
       -- Target must be MENTIONABLE (the search_community_members bar:
       -- named + approved-or-admin) — never an arbitrary/blocked uuid.
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       -- Collapse repeats: at most one UNREAD entry per actor/post/kind —
       -- this also caps the flood a scripted commenter could generate.
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.post_id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, comment_id, post_title)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar, new.post_id, new.id, v_title);
    end if;
  end loop;

  if v_post.author_id <> new.author_id and not (v_post.author_id = any(v_done))
     and not exists (select 1 from public.community_notifications n
                      where n.user_id = v_post.author_id and n.actor_id = new.author_id
                        and n.post_id = new.post_id and n.kind = 'reply'
                        and n.read_at is null) then
    insert into public.community_notifications
      (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, comment_id, post_title)
    values (v_post.author_id, 'reply', new.author_id, v_actor_name, v_actor_avatar, new.post_id, new.id, v_title);
  end if;
  return new;
end;
$$;

revoke all on function public.community_notify_on_comment() from public;

drop trigger if exists community_comments_notify on public.community_comments;
create trigger community_comments_notify
  after insert on public.community_comments
  for each row execute function public.community_notify_on_comment();

create or replace function public.community_notify_on_post()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_name   text;
  v_actor_avatar text;
  v_title        text;
  v_done         uuid[] := array[]::uuid[];
  v_uid          uuid;
  m              text;
begin
  if new.status <> 'active' then return new; end if;
  select coalesce(nullif(trim(pr.full_name), ''), pr.email, 'Member'), pr.avatar_url
    into v_actor_name, v_actor_avatar
    from public.profiles pr where pr.id = new.author_id;
  v_title := left(coalesce(nullif(trim(new.title), ''), new.body), 120);

  for m in select (regexp_matches(new.body, '@\[[^\]]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g'))[1] loop
    exit when coalesce(array_length(v_done, 1), 0) >= 10;
    begin
      v_uid := m::uuid;
    exception when others then
      continue;
    end;
    if v_uid <> new.author_id
       and not (v_uid = any(v_done))
       -- Same mentionable-target + unread-collapse rules as the comment
       -- trigger above.
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, post_title)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar, new.id, v_title);
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.community_notify_on_post() from public;

drop trigger if exists community_posts_notify on public.community_posts;
create trigger community_posts_notify
  after insert on public.community_posts
  for each row execute function public.community_notify_on_post();

-- ───────────────────────────────────────────────────────────────────
-- 6) community_announcement_reads — per-user "seen it" marker for
--    announcement posts. Unread = announcement posts minus these rows
--    (computed client-side; no fan-out). Insert-only.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_announcement_reads (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  post_id  uuid not null references public.community_posts(id) on delete cascade,
  read_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);

alter table public.community_announcement_reads enable row level security;

drop policy if exists community_announcement_reads_own_select on public.community_announcement_reads;
create policy community_announcement_reads_own_select on public.community_announcement_reads
  for select to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_announcement_reads_own_insert on public.community_announcement_reads;
create policy community_announcement_reads_own_insert on public.community_announcement_reads
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and ((select public.is_admin())
            or ((select public.is_approved()) and (select public.is_enrolled()))));

-- ───────────────────────────────────────────────────────────────────
-- 7) community_attachments — images / videos (private community-media
--    bucket) and external links, per post. Metadata only; the file
--    itself is guarded by the bucket policies (§11). Members attach
--    only to their OWN posts; files die with the post (admin hard-
--    delete also removes the storage objects client-side).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_attachments (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.community_posts(id) on delete cascade,
  uploader_id  uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('image','video','link')),
  storage_path text,
  url          text,
  file_name    text,
  mime_type    text,
  file_size    bigint,
  position     int not null default 0,
  created_at   timestamptz not null default now(),
  check ((kind = 'link') = (url is not null)),
  check ((kind = 'link') = (storage_path is null))
);

create index if not exists community_attachments_post_idx
  on public.community_attachments (post_id);

alter table public.community_attachments enable row level security;

drop policy if exists community_attachments_read on public.community_attachments;
create policy community_attachments_read on public.community_attachments
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

drop policy if exists community_attachments_own_insert on public.community_attachments;
create policy community_attachments_own_insert on public.community_attachments
  for insert to authenticated
  with check (uploader_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.author_id = (select auth.uid())));

drop policy if exists community_attachments_own_delete on public.community_attachments;
create policy community_attachments_own_delete on public.community_attachments
  for delete to authenticated
  using (uploader_id = (select auth.uid()));

drop policy if exists community_attachments_admin_all on public.community_attachments;
create policy community_attachments_admin_all on public.community_attachments
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- 8) community_post_tags — free-form tags (beside the fixed category).
--    Normalized slugs, no lookup table; ≤5 per post enforced client-side,
--    shape enforced here.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_post_tags (
  post_id uuid not null references public.community_posts(id) on delete cascade,
  tag     text not null check (char_length(tag) between 1 and 24 and tag ~ '^[a-z0-9][a-z0-9-]*$'),
  primary key (post_id, tag)
);

create index if not exists community_post_tags_tag_idx
  on public.community_post_tags (tag);

alter table public.community_post_tags enable row level security;

drop policy if exists community_post_tags_read on public.community_post_tags;
create policy community_post_tags_read on public.community_post_tags
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

drop policy if exists community_post_tags_own_insert on public.community_post_tags;
create policy community_post_tags_own_insert on public.community_post_tags
  for insert to authenticated
  with check ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.author_id = (select auth.uid())));

drop policy if exists community_post_tags_own_delete on public.community_post_tags;
create policy community_post_tags_own_delete on public.community_post_tags
  for delete to authenticated
  using (exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())));

drop policy if exists community_post_tags_admin_all on public.community_post_tags;
create policy community_post_tags_admin_all on public.community_post_tags
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- 9) Comment reactions — community_reactions grows a second target.
--    Exactly one of post_id / comment_id is set (XOR check). The #23
--    UNIQUE(post_id, user_id, reaction_type) keeps guarding post
--    reactions (NULLs are distinct); the partial unique index below
--    guards comment reactions and serves their lookups.
-- ───────────────────────────────────────────────────────────────────
alter table public.community_reactions alter column post_id drop not null;
alter table public.community_reactions add column if not exists comment_id uuid references public.community_comments(id) on delete cascade;

do $$
begin
  alter table public.community_reactions
    add constraint community_reactions_target_xor check ((post_id is null) <> (comment_id is null));
exception when duplicate_object then null;
end $$;

create unique index if not exists community_reactions_comment_uniq
  on public.community_reactions (comment_id, user_id, reaction_type)
  where comment_id is not null;

-- Insert policy now covers both targets. Reactions stay allowed on
-- comments_locked posts (announcements are react-only by design); the
-- target row (and its parent post) must be active either way.
drop policy if exists community_reactions_own_insert on public.community_reactions;
create policy community_reactions_own_insert on public.community_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and ((post_id is not null
                and exists (select 1 from public.community_posts p
                            where p.id = post_id and p.status = 'active'))
            or (comment_id is not null
                and exists (select 1 from public.community_comments c
                            join public.community_posts p on p.id = c.post_id
                            where c.id = comment_id and c.status = 'active'
                              and p.status = 'active'))));

-- Comment INSERTs now refuse comments_locked parents server-side (the
-- client only hides the composer — cosmetic): announcements and admin-
-- locked threads can't be replied to via direct REST. Admins still can,
-- through community_comments_admin_all.
drop policy if exists community_comments_own_insert on public.community_comments;
create policy community_comments_own_insert on public.community_comments
  for insert to authenticated
  with check (author_id = (select auth.uid())
          and status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active'
                        and not p.comments_locked));

-- ───────────────────────────────────────────────────────────────────
-- 10) Profile pictures. profiles deliberately still has NO user UPDATE
--     policy (RLS can't protect single columns — an open row policy
--     would expose is_paid/plan). set_my_avatar() is the one sanctioned
--     write path: SECURITY DEFINER, own row only, avatar_url only, and
--     the path is pinned to the caller's own avatars/<uid>/ folder. It
--     also refreshes the caller's denormalized author_avatar_url so old
--     posts/comments show the new picture.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.set_my_avatar(p_path text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  -- Same eligibility as every community write: a rejected/expired account
  -- keeps no write path into profiles or the public avatars denorms.
  if not (public.is_admin() or (public.is_approved() and public.is_enrolled())) then
    raise exception 'Not allowed.';
  end if;
  if p_path is not null and p_path !~ ('^' || v_uid::text || '/[A-Za-z0-9._-]{1,120}$') then
    raise exception 'Invalid avatar path.';
  end if;
  update public.profiles set avatar_url = p_path where id = v_uid;
  update public.community_posts    set author_avatar_url = p_path where author_id = v_uid;
  update public.community_comments set author_avatar_url = p_path where author_id = v_uid;
end;
$$;

revoke all on function public.set_my_avatar(text) from public;
grant execute on function public.set_my_avatar(text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 10b) Mention autocomplete directory. SECURITY DEFINER because members
--      cannot read other profiles rows. Returns display name + avatar
--      ONLY — never email (nameless profiles are simply not mentionable;
--      their feed identity still falls back to email via the stamp
--      trigger, unchanged #23 behavior).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.search_community_members(p_query text)
returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public
as $$
  select p.id, trim(p.full_name) as display_name, p.avatar_url
    from public.profiles p
   where ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and nullif(trim(p.full_name), '') is not null
     and (p.approval_status = 'approved' or p.is_admin)
     and p.full_name ilike '%' || coalesce(p_query, '') || '%'
   order by trim(p.full_name)
   limit 8;
$$;

revoke all on function public.search_community_members(text) from public;
grant execute on function public.search_community_members(text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 11) Storage buckets.
--     • avatars — PUBLIC (profile pictures are meant to be seen; the
--       client renders getPublicUrl). 5 MB, images only. Members write
--       only inside their own <uid>/ folder.
--     • community-media — PRIVATE (member-only content; a public bucket
--       serves every object publicly and bypasses RLS — the
--       course-videos precedent). 50 MB, images + video. Own-folder
--       writes; enrolled-member reads via signed URLs.
--     Bucket creation is guarded like #15: if the SQL role can't write
--     storage.buckets, create them in Dashboard → Storage instead.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 5242880,
          array['image/jpeg','image/png','image/webp','image/gif'])
  on conflict (id) do update
    set public = true,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception when insufficient_privilege then
  raise notice 'Could not create the avatars bucket from SQL — create a PUBLIC bucket named "avatars" (5 MB limit, image/jpeg,png,webp,gif) in Dashboard → Storage.';
end $$;

do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('community-media', 'community-media', false, 52428800,
          array['image/jpeg','image/png','image/webp','image/gif',
                'video/mp4','video/webm','video/quicktime'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception when insufficient_privilege then
  raise notice 'Could not create the community-media bucket from SQL — create a PRIVATE bucket named "community-media" (50 MB limit, image + video mime types) in Dashboard → Storage.';
end $$;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select to public
  using (bucket_id = 'avatars');

-- Writes require an ACTIVE membership (own folder + approved + enrolled) —
-- a rejected/expired account must not keep free public-bucket hosting.
drop policy if exists avatars_own_insert on storage.objects;
create policy avatars_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
          and ((select public.is_admin())
            or ((storage.foldername(name))[1] = (select auth.uid())::text
                and (select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists avatars_own_update on storage.objects;
create policy avatars_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars'
     and ((select public.is_admin())
       or ((storage.foldername(name))[1] = (select auth.uid())::text
           and (select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists avatars_own_delete on storage.objects;
create policy avatars_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars'
     and ((select public.is_admin())
       or ((storage.foldername(name))[1] = (select auth.uid())::text
           and (select public.is_approved()) and (select public.is_enrolled()))));

-- Serves the storage read policy's path lookup below.
create index if not exists community_attachments_path_idx
  on public.community_attachments (storage_path);

-- Member read is scoped to files attached to an ACTIVE post — hiding a
-- post also revokes signed-URL access to its media (moderation must bite
-- on image/video content, not just the row). Admins read everything.
drop policy if exists community_media_read on storage.objects;
create policy community_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'community-media'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())
           and exists (select 1 from public.community_attachments a
                       join public.community_posts p on p.id = a.post_id
                       where a.storage_path = name and p.status = 'active'))));

drop policy if exists community_media_own_insert on storage.objects;
create policy community_media_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'community-media'
          and (storage.foldername(name))[1] = (select auth.uid())::text
          and (select public.is_approved()) and (select public.is_enrolled()));

drop policy if exists community_media_delete on storage.objects;
create policy community_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'community-media'
     and ((storage.foldername(name))[1] = (select auth.uid())::text
       or (select public.is_admin())));

-- ───────────────────────────────────────────────────────────────────
-- 12) Realtime — the bell subscribes to its own notification INSERTs
--     (RLS-filtered; recipients only ever receive their own rows).
--     posts/comments were already published by #23.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_notifications') then
      alter publication supabase_realtime add table public.community_notifications;
    end if;
  end if;
end $$;

-- 13) Refresh PostgREST's schema cache.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • The forum UI lights up: pinning, Unanswered filter, attachments, tags,
--     mentions, the notification bell, announcement read-tracking, comment
--     reactions, and profile pictures.
--   • Verify with:
--       select slug, label, position from public.community_tags order by position;  -- 10 rows
--       select column_name from information_schema.columns
--         where table_name = 'community_posts' and column_name in
--         ('pinned','comments_locked','comment_count','last_activity_at','author_avatar_url');
--       select id, public from storage.buckets where id in ('avatars','community-media');
--       select proname from pg_proc where proname in ('set_my_avatar','search_community_members');
-- ─────────────────────────────────────────────────────────────────────────────
