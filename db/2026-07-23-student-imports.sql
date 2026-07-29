-- ─────────────────────────────────────────────────────────────────────────────
-- Student Import — Thinkific → Toolkit migration staging + provenance (#26)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: legacy students live in Thinkific. This migration adds the server-side
-- scaffolding for an ADMIN-ONLY, resumable import that (a) STAGES an uploaded
-- roster, (b) matches each row against existing Supabase accounts, and (c) grants
-- REAL, dated subscription terms that flow through public.is_enrolled() exactly
-- like a paid enrollment — never faking enrollment_requests / receipts / payments.
--
-- Imported subscriptions are VISIBLY MARKED (subscriptions.grant_source='import' +
-- source_import_row_id) so a migration grant is never confused with a verified
-- payment. The membership date is still the authority: an imported active term
-- passes is_enrolled(); an imported expired term locks the student onto the normal
-- renewal screen. Nothing here bypasses RLS or the access gate.
--
-- WHAT THIS ADDS
--   • student_import_jobs / student_import_rows — staged upload + per-row proposal,
--     with a resumable processing cursor. Admin-only.
--   • student_external_accounts — durable link user_id ↔ (source, external_user_id),
--     unique per source id. The idempotency anchor for "already imported this user".
--   • student_import_events — immutable admin audit (IDs + safe codes only).
--   • subscriptions.grant_source / source_import_row_id (+ one-grant-per-row unique
--     index) — provenance + idempotency WITHOUT touching approve_subscription() /
--     approve_extension() (their inserts leave the new columns at defaults, which the
--     PARTIAL index never covers).
--   • profiles.account_origin / onboarding_status / invited_at / onboarding_completed_at
--     — the minimal fields the forced set-password onboarding gate reads.
--   • complete_import_onboarding() — the ONE new narrow user-facing profiles write
--     (SECURITY DEFINER; own row; onboarding fields only — mirrors set_my_avatar()).
--
-- SERVER MODEL: the actual account creation + subscription grant runs in the
-- server-only endpoint api/admin/student-imports.js under the SERVICE ROLE key,
-- which verifies the caller is an admin BEFORE any write. Under the service role
-- auth.uid() is NULL, so those writes are plain admin-verified INSERTs, NOT a
-- SECURITY DEFINER grant RPC (an is_admin() guard would reject its own call). The
-- DB boundary here is RLS (admin-only) + the unique indexes (idempotency).
--
-- ORDER: run db/2026-07-04-subscription-lifecycle.sql BEFORE this file (it creates
-- the dated-term subscriptions columns this file extends). Running this first stops
-- with a clear exception — nothing partial is applied.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create-if-not-exists, add-column-if-not-exists, create-or-replace,
-- drop/create policy, guarded do-blocks) — safe to run more than once.
-- See STUDENT_IMPORT_SETUP.md for the full walkthrough.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Hard ordering guards — everything below extends the enrollment/lifecycle schema.
do $$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql + db/2026-07-04-subscription-lifecycle.sql before this file (public.subscriptions does not exist yet).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'ends_at'
  ) then
    raise exception 'Run db/2026-07-04-subscription-lifecycle.sql before this file (subscriptions.ends_at missing — the dated-term columns are required).';
  end if;
  if to_regproc('public.is_admin') is null then
    raise exception 'public.is_admin() missing — run the course/enrollment migrations first.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) subscriptions provenance + idempotency. ADDITIVE only — the existing
--    approve_subscription()/approve_extension() inserts don't set these columns,
--    so they keep grant_source='payment' and source_import_row_id=NULL. The
--    PARTIAL unique index only covers rows with a non-null source_import_row_id,
--    so it can NEVER collide with a payment/extension grant, and it enforces
--    exactly ONE subscription per import row (retry-safe).
-- ───────────────────────────────────────────────────────────────────
alter table public.subscriptions add column if not exists grant_source text not null default 'payment';
alter table public.subscriptions add column if not exists source_import_row_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'subscriptions_grant_source_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_grant_source_check
      check (grant_source in ('payment', 'import', 'extension'));
  end if;
end $$;

create unique index if not exists subscriptions_one_import_grant
  on public.subscriptions (source_import_row_id) where source_import_row_id is not null;

-- ───────────────────────────────────────────────────────────────────
-- 2) profiles onboarding fields — read by the forced set-password gate. Defaults
--    keep every existing account as a normal 'signup' with no onboarding step; an
--    imported account is stamped account_origin='import' + onboarding_status='invited'
--    by the import endpoint, and flips to 'completed' via complete_import_onboarding().
-- ───────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists account_origin text not null default 'signup';
alter table public.profiles add column if not exists onboarding_status text not null default 'none';
alter table public.profiles add column if not exists invited_at timestamptz;
alter table public.profiles add column if not exists onboarding_completed_at timestamptz;

-- ───────────────────────────────────────────────────────────────────
-- 3) student_import_jobs — one row per uploaded roster / reconcile run.
--    'cursor' is the resumable position: process advances it after each row so a
--    browser close / deploy / timeout resumes exactly where it stopped. 'counts'
--    is a denormalized jsonb summary for the admin UI. 'purged_at' marks a job
--    whose staged raw rows have been scrubbed (retention).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.student_import_jobs (
  id           uuid primary key default gen_random_uuid(),
  source       text not null default 'thinkific_users'
               check (source in ('thinkific_users', 'thinkific_orders', 'ledger', 'manual')),
  filename     text,
  file_sha256  text,                                   -- duplicate-file detection
  mapping      jsonb not null default '{}'::jsonb,      -- column-name → field mapping
  settings     jsonb not null default '{}'::jsonb,      -- combo→plan map, conflict policy, default term mode
  status       text not null default 'draft'
               check (status in ('draft', 'validating', 'dry_run', 'ready', 'processing', 'paused', 'completed', 'failed')),
  total_rows   int not null default 0,
  counts       jsonb not null default '{}'::jsonb,
  cursor       int not null default 0,                  -- resumable processing position
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  purged_at    timestamptz
);

create index if not exists student_import_jobs_creator on public.student_import_jobs (created_by, created_at desc);

alter table public.student_import_jobs enable row level security;

drop policy if exists student_import_jobs_admin_all on public.student_import_jobs;
create policy student_import_jobs_admin_all on public.student_import_jobs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 4) student_import_rows — one staged row per source line. 'mapped' holds the
--    normalized values (the PURGEABLE raw staging payload). The proposed_* /
--    match_result / intended_action columns are filled by the server dry-run.
--    processing_status/attempts/auth_user_created/subscription_granted make each
--    row independently retryable and partial-failure-recoverable.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.student_import_rows (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references public.student_import_jobs(id) on delete cascade,
  source_row_number    int not null,
  mapped               jsonb not null default '{}'::jsonb,   -- purgeable normalized raw
  external_user_id     text,                                 -- string (preserves leading zeros)
  email_normalized     text,
  email_display        text,
  proposed_plan_key    text,
  proposed_started_at  timestamptz,
  proposed_ends_at     timestamptz,
  proposed_term_mode   text
                       check (proposed_term_mode is null or proposed_term_mode in
                         ('preserve', 'fresh', 'expired_history', 'lifetime', 'profile_only')),
  match_result         text
                       check (match_result is null or match_result in
                         ('new', 'existing_by_source', 'existing_by_email', 'conflict', 'ambiguous')),
  intended_action      text
                       check (intended_action is null or intended_action in
                         ('create_invite', 'merge_grant', 'profile_only', 'skip', 'manual_review')),
  target_user_id       uuid references public.profiles(id) on delete set null,
  warnings             jsonb not null default '[]'::jsonb,
  errors               jsonb not null default '[]'::jsonb,
  processing_status    text not null default 'pending'
                       check (processing_status in ('blocked', 'ready', 'pending', 'processing', 'done', 'failed', 'skipped')),
  invite_status        text not null default 'not_sent'
                       check (invite_status in ('not_sent', 'sent', 'failed', 'resent')),
  attempts             int not null default 0,
  auth_user_created    boolean not null default false,
  subscription_granted boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (job_id, source_row_number)
);

create index if not exists student_import_rows_job_status on public.student_import_rows (job_id, processing_status);
create index if not exists student_import_rows_job_extid on public.student_import_rows (job_id, external_user_id);

alter table public.student_import_rows enable row level security;

drop policy if exists student_import_rows_admin_all on public.student_import_rows;
create policy student_import_rows_admin_all on public.student_import_rows
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 5) student_external_accounts — the durable identity link. unique(source,
--    external_user_id) is the idempotency anchor: re-importing the same Thinkific
--    id can never create a second link. Admin-managed; the owning user may read
--    their OWN lineage row, but never anyone else's (no other-student PII exposure).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.student_external_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  source             text not null default 'thinkific',
  external_user_id   text not null,
  source_created_at  timestamptz,
  last_sign_in_at    timestamptz,
  sign_in_count      int,
  legacy_enrollments jsonb not null default '[]'::jsonb,
  import_job_id      uuid references public.student_import_jobs(id) on delete set null,
  import_row_id      uuid references public.student_import_rows(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (source, external_user_id)
);

create index if not exists student_external_accounts_user on public.student_external_accounts (user_id);

alter table public.student_external_accounts enable row level security;

drop policy if exists student_external_accounts_admin_all on public.student_external_accounts;
create policy student_external_accounts_admin_all on public.student_external_accounts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists student_external_accounts_own_select on public.student_external_accounts;
create policy student_external_accounts_own_select on public.student_external_accounts
  for select to authenticated using (user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────────
-- 6) student_import_events — immutable admin audit. Written by the service-role
--    endpoint (which bypasses RLS) AND allowed for admin JWTs; NO update/delete
--    policy exists, so audit rows can never be altered from the client. 'detail'
--    must hold IDs + safe status codes only — never names/emails/raw rows/links.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.student_import_events (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid references public.student_import_jobs(id) on delete cascade,
  row_id     uuid references public.student_import_rows(id) on delete set null,
  kind       text not null,
  status     text,
  detail     jsonb not null default '{}'::jsonb,   -- REDACTED: ids + safe codes only
  actor      uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists student_import_events_job on public.student_import_events (job_id, created_at desc);

alter table public.student_import_events enable row level security;

-- Immutable: admins may READ and INSERT audit rows; there is deliberately NO
-- update or delete policy (nobody can rewrite history from the client).
drop policy if exists student_import_events_admin_select on public.student_import_events;
create policy student_import_events_admin_select on public.student_import_events
  for select to authenticated using (public.is_admin());

drop policy if exists student_import_events_admin_insert on public.student_import_events;
create policy student_import_events_admin_insert on public.student_import_events
  for insert to authenticated with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 7) complete_import_onboarding() — the ONE sanctioned user-facing profiles write
--    for imported students (there is still NO broad user-update RLS on profiles).
--    Runs under the STUDENT's own JWT (auth.uid()), touches ONLY their onboarding
--    fields, and only for an import-origin account. Mirrors set_my_avatar().
-- ───────────────────────────────────────────────────────────────────
create or replace function public.complete_import_onboarding()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.profiles
     set onboarding_status = 'completed',
         onboarding_completed_at = now()
   where id = auth.uid()
     and account_origin = 'import'
     and onboarding_status <> 'completed';
end;
$$;

revoke all on function public.complete_import_onboarding() from public;
grant execute on function public.complete_import_onboarding() to authenticated;

-- 8) Refresh PostgREST's schema cache so the new tables/columns/function are usable immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • Set SUPABASE_SECRET_KEY (service role) + reuse RESEND_* / APP_URL in Vercel,
--     and add "${APP_URL}/welcome/set-password" to Supabase → Auth → URL
--     Configuration → Redirect URLs. See STUDENT_IMPORT_SETUP.md.
--   • Sign in as an admin → sidebar → "Student Imports" to stage/validate/import.
--   • The attached Thinkific user export alone STAGES rows but grants NOTHING —
--     every email is blank, so all new-account processing is blocked until you
--     supply emails + exact expiry via an Orders/ledger export or the template.
--   • Imported terms are real subscriptions (grant_source='import'); they expire,
--     grace, and renew through the same machinery as paid memberships.
-- ─────────────────────────────────────────────────────────────────────────────
