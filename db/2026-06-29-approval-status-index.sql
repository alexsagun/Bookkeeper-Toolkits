-- Admin-approval performance index
--
-- Backs the two approval_status equality queries the app runs:
--   - the sidebar pending-count badge: profiles ... where approval_status = 'pending'
--   - the Access Requests panel load (ordered by created_at, filtered client-side)
--
-- The migration db/2026-06-29-user-approval.sql adds the approval_status column; run that first.
-- Safe to run more than once. Guards on both the table AND the column existing, so a project that
-- has not yet run the approval migration can run this without error (it simply does nothing).

do $$
begin
  if to_regclass('public.profiles') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name   = 'profiles'
         and column_name  = 'approval_status'
     )
  then
    create index if not exists profiles_approval_status_idx
      on public.profiles (approval_status);
  end if;
end $$;

-- Make PostgREST pick up any schema changes immediately.
notify pgrst, 'reload schema';
