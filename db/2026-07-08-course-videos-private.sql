-- ─────────────────────────────────────────────────────────────────────────────
-- PRIVATE bucket for PAID lesson videos (course-videos).
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the course-media bucket is PUBLIC, and a public Supabase bucket serves EVERY
-- object publicly, bypassing RLS on read. Lesson videos streamed via getPublicUrl were
-- therefore world-readable by anyone with the object URL — the paywall was path
-- obscurity, not access control. RLS on a public bucket cannot protect a subset, so we
-- move lesson VIDEO files into this separate PRIVATE bucket and serve them via
-- short-lived signed URLs gated by is_enrolled(). Course COVERS and feature-guide videos
-- stay in the public course-media bucket — they are meant to be visible while browsing.
--
-- Depends on: public.is_admin() (course-platform-base) + public.is_enrolled() (enrollment
-- migration). HOW TO RUN: Supabase dashboard → SQL Editor → Run. IDEMPOTENT. Run AFTER the
-- enrollment migration. (Also fold into db/000_full_database_bootstrap.sql for fresh installs.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Create the PRIVATE bucket (50 MB, video mime allowlist). Restricted SQL roles →
--    NOTICE + Dashboard fallback (create it manually with Public = OFF).
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('course-videos', 'course-videos', false, 52428800,
          array['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v'])
  on conflict (id) do update set public = false;
exception
  when insufficient_privilege then
    raise notice 'Could not create course-videos from SQL; create it in Dashboard → Storage (Public = OFF). Object policies below still apply.';
end $$;

-- 2) Object policies: enrolled/admin read (so they can mint signed URLs), admin-only write.
drop policy if exists course_videos_read on storage.objects;
create policy course_videos_read on storage.objects for select to authenticated
  using (bucket_id = 'course-videos' and (public.is_admin() or public.is_enrolled()));

drop policy if exists course_videos_admin_write on storage.objects;
create policy course_videos_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'course-videos' and public.is_admin());

drop policy if exists course_videos_admin_update on storage.objects;
create policy course_videos_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'course-videos' and public.is_admin());

drop policy if exists course_videos_admin_delete on storage.objects;
create policy course_videos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-videos' and public.is_admin());

-- EXISTING CONTENT: lesson videos uploaded before this migration remain under
-- course-media/lessons/*. New uploads go to course-videos, and playback falls back to the
-- course-media public URL for legacy paths, so nothing breaks. To fully protect old videos,
-- move them (Storage → move to course-videos, same lessons/<course_id>/… path) — they will
-- then be served as signed URLs automatically. Until moved, legacy videos stay public.
