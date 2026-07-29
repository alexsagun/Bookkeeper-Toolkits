-- ─────────────────────────────────────────────────────────────────────────────
-- Community forum — performance + privacy hardening (#25)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: a post-deploy performance/privacy review of the forum (#23 + #24) surfaced
-- four small, real issues. All additive — safe to run on a database that already
-- has #23 + #24 applied.
--   PERFORMANCE
--   1. Category sidebar counts were computed in the browser by streaming up to
--      5000 active-post tag_slugs per feed load. community_category_counts() does
--      the GROUP BY server-side and returns ~10 rows (RLS-scoped, no truncation).
--   2. Mention autocomplete runs `full_name ILIKE '%q%'` (leading wildcard = no
--      btree index) → a full profiles scan per keystroke. A pg_trgm GIN index lets
--      that predicate use an index as the member directory grows.
--   PRIVACY (completes the moderation + enrollment model already in #23/#24)
--   3. community_reactions_read had no parent-active guard (its sibling read
--      policies do), so reaction rows on a HIDDEN post stayed enumerable via direct
--      REST — leaking who-reacted metadata after moderation. Add the same guard.
--   4. The own-delete policies on reactions/attachments/post_tags gated only on
--      ownership, not is_approved()+is_enrolled() like their INSERT siblings — an
--      expired member could still delete their own rows via REST. Align them with
--      the documented "expired members are fully blocked" model.
--
-- ORDER: run db/2026-07-21-community-forum.sql (#24) BEFORE this file. The guard
-- below stops with a clear message otherwise.
--
-- HOW TO RUN: paste into Supabase → SQL Editor → Run. IDEMPOTENT (create-or-replace,
-- create-extension/index-if-not-exists, drop-policy-if-exists + create) — safe to
-- run more than once. Data-safe: no row changes, only functions/indexes/policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard.
do $$
begin
  if to_regclass('public.community_attachments') is null
     or to_regclass('public.community_post_tags') is null
     or to_regproc('public.search_community_members') is null then
    raise exception 'Community forum objects missing — run db/2026-07-21-community-forum.sql (#24) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) Server-side category counts (replaces the client's up-to-5000-row
--    tag_slug pull). SECURITY INVOKER: community_posts_read RLS scopes
--    the caller, so an expired/non-member simply gets no rows.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_category_counts()
returns table (tag_slug text, n bigint)
language sql stable set search_path = public
as $$
  select p.tag_slug, count(*)::bigint
    from public.community_posts p
   where p.status = 'active'
   group by p.tag_slug;
$$;

revoke all on function public.community_category_counts() from public;
grant execute on function public.community_category_counts() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 2) Trigram index for the mention-autocomplete ILIKE '%q%'. The GIN
--    index makes search_community_members()'s leading-wildcard match
--    index-assisted instead of a full profiles scan per keystroke.
-- ───────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;
create index if not exists profiles_full_name_trgm
  on public.profiles using gin (full_name gin_trgm_ops);

-- ───────────────────────────────────────────────────────────────────
-- 3) community_reactions_read — add the parent-active guard its sibling
--    read policies (comments/attachments/post_tags) already carry, so
--    hiding a post also hides who reacted to it (and its comments).
--    Admins still read everything; the target row + its parent post must
--    be active for members. Mirrors community_reactions_own_insert.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_reactions_read on public.community_reactions;
create policy community_reactions_read on public.community_reactions
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and ((post_id is not null
                and exists (select 1 from public.community_posts p
                            where p.id = post_id and p.status = 'active'))
            or (comment_id is not null
                and exists (select 1 from public.community_comments c
                            join public.community_posts p on p.id = c.post_id
                            where c.id = comment_id and c.status = 'active'
                              and p.status = 'active')))));

-- ───────────────────────────────────────────────────────────────────
-- 4) Enrollment gate on the own-delete policies — match their INSERT
--    siblings so an expired/rejected member (JWT still valid until
--    refresh) can't delete their own community rows via REST. Ownership
--    is still required; admins keep their admin_all delete path.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_reactions_own_delete on public.community_reactions;
create policy community_reactions_own_delete on public.community_reactions
  for delete to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_attachments_own_delete on public.community_attachments;
create policy community_attachments_own_delete on public.community_attachments
  for delete to authenticated
  using (uploader_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_post_tags_own_delete on public.community_post_tags;
create policy community_post_tags_own_delete on public.community_post_tags
  for delete to authenticated
  using (((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())));

-- 5) Refresh PostgREST's schema cache (the new RPC).
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • The forum sidebar counts come from community_category_counts() (10 rows,
--     no 5000-row transfer, no truncation); mention search is index-assisted;
--     hidden posts no longer leak reactor identity; expired members can no longer
--     delete their own community rows.
--   • Verify with:
--       select * from public.community_category_counts();
--       select indexname from pg_indexes where indexname = 'profiles_full_name_trgm';
--       select polname from pg_policy where polname in
--         ('community_reactions_read','community_reactions_own_delete',
--          'community_attachments_own_delete','community_post_tags_own_delete');
-- ─────────────────────────────────────────────────────────────────────────────
