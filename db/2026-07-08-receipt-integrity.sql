-- ─────────────────────────────────────────────────────────────────────────────
-- Receipt integrity — remove the student self-delete on enrollment-receipts.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the original enrollment migration let a receipt's OWNER delete it. A student
-- could therefore delete their payment proof AFTER submitting (or after an admin
-- approved based on it), destroying the evidence trail. Receipts are already immutable
-- (no UPDATE policy); this makes them non-deletable by students too. Admins keep delete
-- (cleanup of rejected/orphaned files). The client's best-effort failed-submit cleanup
-- (BookkeeperPro.jsx: supabase.storage.from('enrollment-receipts').remove([path]) in the
-- submit catch) becomes a harmless no-op — orphaned files from a failed submit are
-- unreferenced and admin-purgeable.
--
-- Depends on: db/2026-07-04-enrollment.sql (the enrollment-receipts bucket + policies).
-- HOW TO RUN: Supabase dashboard → SQL Editor → Run. IDEMPOTENT. Run AFTER the enrollment
-- migration. (Also fold this into db/000_full_database_bootstrap.sql for fresh installs.)
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists enrollment_receipts_delete on storage.objects;
create policy enrollment_receipts_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'enrollment-receipts'
    and public.is_admin()
  );
