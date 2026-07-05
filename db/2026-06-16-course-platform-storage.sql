-- ─────────────────────────────────────────────────────────────────────────────
-- BASE (foundation) — public `course-media` storage bucket + its object policies
-- ─────────────────────────────────────────────────────────────────────────────
-- This file promotes the storage setup that previously lived ONLY as COURSE_SETUP.md
-- Step 2 (a Dashboard "New bucket" step + a SQL policy block) into a real, dated
-- migration. The bucket is created here via SQL for a hands-off fresh install; if
-- your SQL role can't insert into storage.buckets (rare, restricted roles) the insert
-- degrades to a NOTICE and you create the bucket in Dashboard → Storage (Public = ON)
-- — the object policies below still apply either way.
--
-- The `course-media` bucket is PUBLIC-read: uploaded course videos + cover images are
-- streamed straight from Storage via getPublicUrl. It is ALSO reused by feature-guide
-- videos under a `feature-guides/<feature_key>/…` prefix (db/2026-06-22-feature-guides.sql)
-- — the policies key only on bucket_id, so that prefix is already covered.
--
-- Depends on: public.is_admin() (db/2026-06-16-course-platform-base.sql).
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (on conflict do update / drop … if exists) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Create the bucket (public). Restricted SQL roles → NOTICE + Dashboard fallback.
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('course-media', 'course-media', true)
  on conflict (id) do update set public = true;
exception
  when insufficient_privilege then
    raise notice 'Could not create the course-media bucket from SQL; create it in Dashboard → Storage (Public = ON). Object policies below still apply.';
end $$;

-- 2) Object policies: public read, admin-only write/update/delete.
drop policy if exists course_media_read on storage.objects;
create policy course_media_read on storage.objects for select to public
  using (bucket_id = 'course-media');

drop policy if exists course_media_admin_write on storage.objects;
create policy course_media_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'course-media' and public.is_admin());

drop policy if exists course_media_admin_update on storage.objects;
create policy course_media_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'course-media' and public.is_admin());

drop policy if exists course_media_admin_delete on storage.objects;
create policy course_media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-media' and public.is_admin());

-- Note: the standard Supabase tier caps uploads (commonly 50 MB/file). Raise it in
-- Storage → Settings, or paste a YouTube/Vimeo link in the lesson editor instead.
