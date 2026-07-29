-- ─────────────────────────────────────────────────────────────────────────────
-- Community — in-app member feed (posts, comments, reactions, categories)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the group chat that used to live on Discord moves into the app (route
-- /community — sidebar → Home → Community). Members post under one of nine
-- fixed categories, comment, and react; admins moderate inline (hide/restore/
-- hard-delete) and are the only ones who may post in Announcements.
--
-- MODEL / access:
--   • EVERY active paid plan includes Community (all plans advertise group
--     chat), so the server gate is simply is_approved() + is_enrolled() —
--     the same date-aware check (term + 3-day grace) that guards courses.
--     Access ends when the membership term ends; the Sampler Session's
--     60-day group-chat support is exactly its 60-day access window.
--   • author_name is DENORMALIZED onto posts/comments because non-admins
--     cannot read other users' profiles rows (own_profile_select only) — same
--     precedent as enrollment_requests.full_name — but it is STAMPED
--     SERVER-SIDE by the community_stamp_author() trigger (§4b), never trusted
--     from the client (a direct API call could otherwise impersonate anyone in
--     a feed every member sees). Avatars are initials-rendered client-side; no
--     image URLs stored.
--   • Moderation: rows carry status 'active' | 'hidden' (admin-moderated) |
--     'deleted' (author soft-delete). Members never hard-DELETE posts or
--     comments (threads/counts stay consistent); admins can. Member comment
--     reads/inserts also require the PARENT POST to be active, so hiding a
--     post hides its whole thread and freezes new replies. Reactions have
--     no status — toggling off hard-deletes the member's own row (a reaction
--     carries no content to moderate).
--   • Tags are a fixed seeded list; admin_only = true marks the categories
--     only admins may post in (Announcements). The posts insert/update
--     policies check that flag via a subquery, which itself runs under the
--     tags read policy — so that read policy deliberately does NOT filter on
--     `active` (the client filters `active` for the picker; hiding inactive
--     rows here would let a deactivated admin-only tag slip past the guard).
--
-- ORDER: run db/2026-06-29-user-approval.sql (#9), db/2026-07-04-enrollment.sql
-- (#12) and db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file —
-- it reuses their is_approved() / date-aware is_enrolled() helpers. The guard
-- below stops with a clear message otherwise.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create-if-not-exists tables/indexes, on-conflict seed,
-- drop-policy-if-exists + create, guarded do-blocks) — safe to run more than
-- once. See COMMUNITY_SETUP.md for the full walkthrough.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard — the policies below reuse the membership helpers.
do $$
begin
  if to_regproc('public.is_admin') is null then
    raise exception 'public.is_admin() is missing — run db/2026-06-16-course-platform-base.sql first.';
  end if;
  if to_regproc('public.is_approved') is null then
    raise exception 'public.is_approved() is missing — run db/2026-06-29-user-approval.sql (#9) BEFORE this file.';
  end if;
  if to_regproc('public.is_enrolled') is null then
    raise exception 'public.is_enrolled() is missing — run db/2026-07-04-enrollment.sql (#12) + db/2026-07-04-subscription-lifecycle.sql (#13) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) community_tags — the fixed category list (one category per post,
--    Skool-style). admin_only = only admins may post there (Announcements);
--    active = shown in the composer/filter pickers (client-filtered).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_tags (
  slug        text primary key,
  label       text not null,
  admin_only  boolean not null default false,
  active      boolean not null default true,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

insert into public.community_tags (slug, label, admin_only, position) values
  ('announcements',     'Announcements',      true,  1),
  ('introductions',     'Introductions',      false, 2),
  ('questions',         'Questions',          false, 3),
  ('quickbooks-help',   'QuickBooks Help',    false, 4),
  ('us-bookkeeping',    'US Bookkeeping',     false, 5),
  ('job-applications',  'Job Applications',   false, 6),
  ('resume-interview',  'Resume & Interview', false, 7),
  ('client-management', 'Client Management',  false, 8),
  ('wins',              'Wins',               false, 9)
on conflict (slug) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 2) community_posts — title optional, body required + capped (the client
--    mirrors both caps). status machinery documented in the header.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  author_name text not null,
  title       text check (title is null or char_length(title) <= 120),
  body        text not null check (char_length(body) between 1 and 5000),
  tag_slug    text not null references public.community_tags(slug),
  status      text not null default 'active' check (status in ('active','hidden','deleted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────
-- 3) community_comments — flat (no nesting in v1), per post.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.community_posts(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  author_name text not null,
  body        text not null check (char_length(body) between 1 and 2000),
  status      text not null default 'active' check (status in ('active','hidden','deleted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────
-- 4) community_reactions — fixed set; one row per (post, user, type);
--    toggle off = DELETE own row.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_reactions (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.community_posts(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('like','celebrate','helpful')),
  created_at    timestamptz not null default now(),
  unique (post_id, user_id, reaction_type)
);

-- ───────────────────────────────────────────────────────────────────
-- 4b) Server-stamped author identity. The insert policies pin
--     author_id = auth.uid(), but author_name would otherwise be any string
--     the client sends — a direct API call could impersonate another member
--     (or the admin) in a feed everyone sees. This BEFORE trigger overwrites
--     author_name from the author's own profiles row on INSERT (SECURITY
--     DEFINER — profiles RLS is closed to members) and freezes it on UPDATE.
--     The app still sends a name; it's simply overwritten (and keeps working
--     on a DB where this trigger hasn't been applied yet).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_stamp_author()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    select coalesce(nullif(trim(p.full_name), ''), p.email, 'Member')
      into new.author_name
      from public.profiles p where p.id = new.author_id;
    new.author_name := coalesce(new.author_name, 'Member');
  else
    new.author_name := old.author_name;   -- immutable after insert
  end if;
  return new;
end;
$$;

revoke all on function public.community_stamp_author() from public;

drop trigger if exists community_posts_stamp_author on public.community_posts;
create trigger community_posts_stamp_author
  before insert or update on public.community_posts
  for each row execute function public.community_stamp_author();

drop trigger if exists community_comments_stamp_author on public.community_comments;
create trigger community_comments_stamp_author
  before insert or update on public.community_comments
  for each row execute function public.community_stamp_author();

-- ───────────────────────────────────────────────────────────────────
-- 5) Indexes — feed is newest-first over non-deleted rows, optionally by tag;
--    comments load per post in chronological order. The reactions UNIQUE
--    constraint already serves (post_id, …) lookups.
-- ───────────────────────────────────────────────────────────────────
create index if not exists community_posts_feed_idx    on public.community_posts (status, created_at desc);
create index if not exists community_posts_tag_idx     on public.community_posts (tag_slug, created_at desc);
create index if not exists community_comments_post_idx on public.community_comments (post_id, created_at);

-- ───────────────────────────────────────────────────────────────────
-- 6) RLS. Helpers are (select …)-wrapped so each runs once per query
--    (InitPlan), not once per row. is_approved()/is_enrolled() already OR-in
--    is_admin, but reads still need an explicit admin branch: admins must see
--    hidden/deleted rows to moderate them.
-- ───────────────────────────────────────────────────────────────────
alter table public.community_tags      enable row level security;
alter table public.community_posts     enable row level security;
alter table public.community_comments  enable row level security;
alter table public.community_reactions enable row level security;

-- Tags: readable by any approved+enrolled member (NO `active` filter here —
-- see the header note; the insert/update guards below depend on members being
-- able to see admin_only rows). Writes are admin-only.
drop policy if exists community_tags_read on public.community_tags;
create policy community_tags_read on public.community_tags
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())));

drop policy if exists community_tags_admin_all on public.community_tags;
create policy community_tags_admin_all on public.community_tags
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Posts.
drop policy if exists community_posts_read on public.community_posts;
create policy community_posts_read on public.community_posts
  for select to authenticated
  using ((select public.is_admin())
      or (status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())));

-- Members insert their own active posts; the admin-only category rule
-- (Announcements) is enforced HERE, not just in the client. Admin posts flow
-- through community_posts_admin_all below (permissive policies OR together).
drop policy if exists community_posts_own_insert on public.community_posts;
create policy community_posts_own_insert on public.community_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and (select public.is_approved()) and (select public.is_enrolled())
    and not exists (select 1 from public.community_tags t
                    where t.slug = tag_slug and t.admin_only)
  );

-- Edit / soft-delete own rows. USING excludes 'hidden' so an author can never
-- un-hide a moderated post; WITH CHECK allows only active (edit) or deleted
-- (soft-delete) and re-blocks admin-only categories (no moving a post into
-- Announcements on edit).
drop policy if exists community_posts_own_update on public.community_posts;
create policy community_posts_own_update on public.community_posts
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))))
  with check (
    author_id = (select auth.uid())
    and status in ('active','deleted')
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())))
    and not exists (select 1 from public.community_tags t
                    where t.slug = tag_slug and t.admin_only)
  );

drop policy if exists community_posts_admin_all on public.community_posts;
create policy community_posts_admin_all on public.community_posts
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Comments — same four shapes, minus the tag guard, PLUS a parent-post guard:
-- members read/insert comments only while the post itself is still active, so
-- hiding a post hides its whole thread and freezes new replies (the subquery
-- runs under the posts read policy, which gives members exactly that view;
-- admins bypass via their own branch / admin_all).
drop policy if exists community_comments_read on public.community_comments;
create policy community_comments_read on public.community_comments
  for select to authenticated
  using ((select public.is_admin())
      or (status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

drop policy if exists community_comments_own_insert on public.community_comments;
create policy community_comments_own_insert on public.community_comments
  for insert to authenticated
  with check (author_id = (select auth.uid())
          and status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active'));

drop policy if exists community_comments_own_update on public.community_comments;
create policy community_comments_own_update on public.community_comments
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))))
  with check (author_id = (select auth.uid()) and status in ('active','deleted')
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_comments_admin_all on public.community_comments;
create policy community_comments_admin_all on public.community_comments
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Reactions.
drop policy if exists community_reactions_read on public.community_reactions;
create policy community_reactions_read on public.community_reactions
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())));

drop policy if exists community_reactions_own_insert on public.community_reactions;
create policy community_reactions_own_insert on public.community_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled()));

drop policy if exists community_reactions_own_delete on public.community_reactions;
create policy community_reactions_own_delete on public.community_reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists community_reactions_admin_all on public.community_reactions;
create policy community_reactions_admin_all on public.community_reactions
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- 7) Realtime — live feed/comment INSERTs (best-effort; the client also
--    refetches on window focus). Guarded so re-runs and non-Supabase Postgres
--    (no supabase_realtime publication) don't error. Reactions are left out —
--    their counts refresh with normal feed loads.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_posts') then
      alter publication supabase_realtime add table public.community_posts;
    end if;
    if not exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_comments') then
      alter publication supabase_realtime add table public.community_comments;
    end if;
  end if;
end $$;

-- 8) Refresh PostgREST's schema cache so the new tables are queryable immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • The in-app Community tab (/community) loads: members with an active term
--     can post/comment/react; admins moderate inline and own Announcements.
--   • Expired members are blocked server-side automatically (is_enrolled()) —
--     no extra revocation step, mirroring course content.
--   • Verify with:
--       select slug, label, admin_only from public.community_tags order by position;
--       select count(*) from public.community_posts;
-- ─────────────────────────────────────────────────────────────────────────────
