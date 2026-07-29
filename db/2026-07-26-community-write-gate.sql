-- ─────────────────────────────────────────────────────────────────────────────
-- Community forum — enrollment gate on own-UPDATE policies (#28)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: #25 added is_approved()+is_enrolled() to the own-DELETE policies on
-- reactions/attachments/post_tags (so an expired/rejected member with a still-valid
-- JWT couldn't delete their own rows via direct REST) — but it never revisited the
-- own-UPDATE policies on community_posts / community_comments. Those still gate only
-- on `author_id = auth.uid() and status <> 'hidden'`, with a WITH CHECK that permits
-- `status in ('active','deleted')`. Because Postgres evaluates an UPDATE's USING/CHECK
-- independently of the SELECT policy, an expired member (JWT valid until refresh) can
-- therefore still EDIT the body of, or SOFT-DELETE (status='deleted'), their own
-- non-hidden posts/comments via REST — even though the whole app UI is blocked. That
-- contradicts the documented "expired members are fully blocked, writes included"
-- invariant, and soft-delete-via-update is itself the exact class of write #25 closed
-- for deletes. This file aligns the two own-update policies with that model.
--
-- All additive — safe on a database that already has #23 + #24 (+ #25) applied. The
-- bootstrap (db/000_full_database_bootstrap.sql §15b) and the standalone #23 file
-- (db/2026-07-20-community.sql) are patched to the gated form too, so a FRESH install
-- is born correct — but an ALREADY-DEPLOYED prod database only picks up the fix by
-- running THIS migration (editing the bootstrap does not reach an existing install).
--
-- ORDER: run db/2026-07-20-community.sql (#23) BEFORE this file. The guard below stops
-- with a clear message otherwise. Independent of #24/#25 (touches only the two base
-- own-update policies), but conventionally runs after them.
--
-- HOW TO RUN: paste into Supabase → SQL Editor → Run. IDEMPOTENT (drop-policy-if-exists
-- + create). Data-safe: no row changes, only policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Ordering guard.
do $$
begin
  if to_regclass('public.community_posts') is null
     or to_regclass('public.community_comments') is null then
    raise exception 'Community base tables missing — run db/2026-07-20-community.sql (#23) BEFORE this file.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) community_posts_own_update — add the enrollment gate to BOTH the
--    USING (guards edit/soft-delete of an existing row) and the WITH
--    CHECK (guards the resulting row). Ownership + the admin-only-tag
--    block are unchanged; admins keep their community_posts_admin_all
--    path. Grace members still pass (is_enrolled() covers the 3-day
--    grace). Mirrors the #25 own-delete gate.
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 2) community_comments_own_update — same gate.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_comments_own_update on public.community_comments;
create policy community_comments_own_update on public.community_comments
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))))
  with check (author_id = (select auth.uid()) and status in ('active','deleted')
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled()))));

-- 3) Refresh PostgREST's schema cache.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • Expired/rejected members can no longer edit or soft-delete their own posts
--     or comments via REST — writes are now fully blocked, matching reads.
--   • Verify with:
--       select polname, polcmd from pg_policy
--        where polname in ('community_posts_own_update','community_comments_own_update');
--     then, as an expired member's JWT, an UPDATE on your own post must return 0 rows.
-- ─────────────────────────────────────────────────────────────────────────────
