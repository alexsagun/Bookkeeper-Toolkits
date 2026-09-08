-- ═════════════════════════════════════════════════════════════════════════════
-- #57 — Accept QuickTime (.mov) as a lesson-video upload
-- 2026-09-08
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- `course-videos` has accepted exactly one MIME type since #44: `video/mp4`. The
-- client matched it, and refused a `.mov` outright with "Lesson videos must be MP4
-- (H.264 video, AAC audio). Convert the file with HandBrake…" — no override, and the
-- exact opposite of the policy the rest of the uploader now implements, which is that
-- an unusual codec is REPORTED and uploaded rather than refused.
--
-- iPhone recordings, Mac screen captures and plenty of QuickTime exports are `.mov`,
-- and usually HEVC. Those are precisely the files the 2026-09-08 client change stops
-- treating as errors, so the bucket has to stop treating them as errors too.
--
-- ★ A `.mov` IS an MP4 structurally. Both are ISO base media (ISO/IEC 14496-12); MP4
--   is the derived spec. The box tree parses identically — src/lib/mp4Faststart.js
--   already handles the one real divergence, QuickTime's non-FullBox `meta` — and
--   sanitizeVideoFileName() still renames the stored object to `.mp4`. Only the
--   declared content type differs, and that is the single thing this file changes.
--
-- ★ WHY THIS MIGRATION EXISTS AT ALL, given the client could have skipped it.
--   Until today the browser sent `contentType: 'video/mp4'` as a hardcoded constant
--   for every upload, so a `.mov` would already have passed this check — while being
--   stored under a type it is not. The client now sends the file's real type, which
--   makes this row the thing that actually decides. Passing by mislabelling is not a
--   grant; it is a bug that has not been noticed yet.
--
-- SAFETY
--
--   * Additive. `video/mp4` is unchanged, so every existing upload path is unaffected.
--   * `allowed_mime_types` is consulted ONLY on upload (storage-api's validateMimeType).
--     GET, createSignedUrl, copy and move never read it — so this cannot change how any
--     existing object is read, and could not have made one unreadable either.
--   * Client-neutral in one direction only: a NEW client with an OLD bucket would 400 on
--     a .mov upload, so run this BEFORE or WITH the deploy. An old client with the new
--     bucket is completely unaffected.
--   * No policy, function, trigger or column is touched.
--
-- LOCKSTEP (CLAUDE.md, "Changing what a course lesson video may be")
--   this file ↔ bootstrap fold §44 ↔ LESSON_VIDEO_UPLOAD_MIMES / LESSON_VIDEO_ACCEPT /
--   validateVideoFile() in src/lib/courseVideo.js ↔ the tus `contentType` in
--   BookkeeperPro.jsx ↔ test/courseVideoSql.test.mjs.
--
-- ═════════════════════════════════════════════════════════════════════════════

do $blk$
begin
  -- Mirrors #44's assertion exactly, including its privilege fallback: on a hosted
  -- Supabase project the SQL editor may not own storage.buckets, and a NOTICE that
  -- tells the operator what to click beats a migration that dies half-applied.
  update storage.buckets
     set allowed_mime_types = array['video/mp4', 'video/quicktime']
   where id = 'course-videos';

  if not found then
    raise notice '#57: bucket course-videos does not exist yet — run #44 first.';
  end if;
exception
  when insufficient_privilege then
    raise notice '#57: could not update course-videos from SQL. In Dashboard → Storage → '
                 'course-videos → Settings, set allowed MIME types to: video/mp4, video/quicktime';
end
$blk$;

-- Verify (should print exactly {video/mp4,video/quicktime}):
--   select allowed_mime_types from storage.buckets where id = 'course-videos';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-08-lesson-video-quicktime.sql', null,
  'lesson video quicktime (#57): widen course-videos.allowed_mime_types to '
  'video/mp4 + video/quicktime, so an iPhone/Mac .mov recording uploads instead of '
  'being refused with advice to convert it. Additive; upload-path only; no policy, '
  'function or column changes. Pairs with the client change that stops gating on '
  'codec and starts sending the file''s real content type.')
on conflict (filename) do nothing;
