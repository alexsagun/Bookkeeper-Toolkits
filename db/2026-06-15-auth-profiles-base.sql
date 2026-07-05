-- ─────────────────────────────────────────────────────────────────────────────
-- BASE (foundation) — auth profiles table + signup trigger
-- ─────────────────────────────────────────────────────────────────────────────
-- This file promotes the foundational SQL that previously lived ONLY as a paste
-- block in AUTH_SETUP.md (§3) into a real, dated migration, so the db/ chain is
-- gapless and self-contained. Its content is the AUTH_SETUP.md block verbatim.
--
-- It is dated before the earliest delta migration (2026-06-17) because it is the
-- first thing that must exist: every later migration (course platform, approval,
-- enrollment) builds on public.profiles. On a fresh project you can either run the
-- consolidated db/000_full_database_bootstrap.sql (recommended) OR run the dated
-- files in the order documented in db/README.md, starting here.
--
-- WHY: one profile row per auth user. is_paid / plan are the paid-gate fields;
-- the admin-approval columns are ADDED later by db/2026-06-29-user-approval.sql
-- (kept out of here on purpose so the historical shape stays faithful).
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (if not exists / drop … if exists) — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Profile row per user. is_paid / plan are reserved for the paid gate.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  is_paid boolean not null default false,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists avatar_url text;

alter table public.profiles enable row level security;

-- A user can read only their own profile.
drop policy if exists "own_profile_select" on public.profiles;
create policy "own_profile_select" on public.profiles
  for select using (auth.uid() = id);

-- Phase 1 keeps profiles read-only from the client. Do NOT add a client UPDATE policy
-- that lets a user change is_paid — that flag is flipped server-side (admin action).

-- Auto-create a profile row whenever a new auth user signs up (email OR Google).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
