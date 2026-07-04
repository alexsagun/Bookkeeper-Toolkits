-- ─────────────────────────────────────────────────────────────────────────────
-- Manual enrollment & payment-verification workflow (in-app paywall)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: students enroll by paying manually (BPI / Security Bank / GCash) and uploading
-- a receipt INSIDE the app. An unpaid, non-admin user is held on the Enrollment
-- Paywall (pricing cards → payment instructions → proof-upload form) and, after
-- submitting, on a "payment under review" screen — until an admin approves the
-- request in the new "Enrollments" admin tab. Approving flips the student's
-- profiles.is_paid / plan / approval_status in one action and records an active
-- subscription. This is manual verification, NOT online checkout.
--
-- ⚠️ LOCKOUT SAFETY (read this): deploying the client gate keyed on profiles.is_paid
-- would lock out every existing student (they all have is_paid = false). So the
-- FIRST-TIME run of this file back-fills is_paid = true for every account that is
-- already approved under the admin-approval gate (they predate the paywall and paid
-- outside the app). The backfill is guarded by "does enrollment_requests exist yet?"
-- so re-running this file NEVER re-grants someone an admin later un-paid.
--
-- ORDER: run db/2026-06-29-user-approval.sql BEFORE this file (it creates
-- approval_status + public.is_approved(), which section 7 builds on). If you run
-- this file first, section 7 safely skips with a NOTICE — re-run after.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create-if-not-exists, guarded do-blocks, drop/create policy) — safe
-- to run more than once. See ENROLLMENT_SETUP.md for the full walkthrough.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Helpers. is_admin() re-created defensively (identical to COURSE_SETUP.md Step 1).
--    is_enrolled() = "current user is an admin or has paid" — the payment counterpart
--    of is_approved(); security definer + pinned search_path → no RLS recursion.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_enrolled()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin or is_paid from public.profiles where id = auth.uid()), false) $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) ONE-TIME grandfather backfill — MUST stay above the create-table statements.
--    First run (enrollment_requests doesn't exist yet): every already-approved
--    account keeps access (is_paid = true). Later runs: table exists → skip, so an
--    account an admin deliberately un-paid is never silently re-granted.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'enrollment_requests'
  ) then
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'approval_status'
    ) then
      update public.profiles set is_paid = true
        where is_paid = false and (is_admin = true or approval_status = 'approved');
    else
      -- approval migration not run yet: only admins are provably trusted.
      update public.profiles set is_paid = true where is_paid = false and is_admin = true;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 2) enrollment_plans — the pricing cards. Seeded below; admins may edit rows
--    (price, bullets, badge) and the paywall re-reads them. Seed uses ON CONFLICT
--    DO NOTHING so admin edits always survive a re-run of this file.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.enrollment_plans (
  key            text primary key,              -- stable id, stored on requests/profiles.plan
  name           text not null,
  tagline        text,                          -- card eyebrow, e.g. 'Gold Package'
  price_php      numeric not null,
  compare_at_php numeric,                       -- strikethrough compare-at price
  badge          text,                          -- 'BEST SELLER' / 'BEST VALUE'
  features       jsonb not null default '[]'::jsonb,  -- array of bullet strings
  limit_note     text,                          -- e.g. 'Limited to 10 slots per month'
  position       int not null default 0,
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);

insert into public.enrollment_plans (key, name, tagline, price_php, compare_at_php, badge, features, limit_note, position) values
  ('core_self_paced', 'QBO Mastery Only', 'Core · Self-Paced', 999, null, null,
   '["Simulated annual bookkeeping project for an NY-based construction company","60-day QBO Mastery course access","Weekly Discord chat (Thu)"]'::jsonb,
   null, 1),
  ('sampler', 'Sampler Session', 'Essentials', 1499, null, null,
   '["1 Live Zoom Session (3 hours)","60-day course access","30-day group chat support"]'::jsonb,
   'Limited offer', 2),
  ('silver_self_paced', 'QBO + Resume Combo', 'Silver · Self-Paced', 1999, null, null,
   '["Simulated annual bookkeeping project for an NY-based construction company","60-day QBO Mastery course access","60-day Resume & Interview course access","Weekly Discord chat (Thu)"]'::jsonb,
   null, 3),
  ('gold_live', 'Live Group Track', 'Gold Package', 9999, 35000, 'BEST VALUE',
   '["Simulated annual bookkeeping project for an NY-based construction company","12 LIVE Group Zoom Trainings (MWF 9am to 11am PH time)","180-day resume + interview course access","Weekly group consult until hired","Discord chat support until and after hired"]'::jsonb,
   null, 4),
  ('vip', 'Personalized Coaching Program', 'VIP Package', 15999, 35000, 'BEST SELLER',
   '["Simulated annual bookkeeping project for an NY-based construction company","12 Live Group Zoom Trainings (MWF 9am to 11am PH Time)","1-on-1 Resume & Interview Coaching (1 session)","Weekly group consult until hired","Discord chat support until and after hired"]'::jsonb,
   'Limited to 10 slots per month', 5)
on conflict (key) do nothing;

alter table public.enrollment_plans enable row level security;

drop policy if exists enrollment_plans_read on public.enrollment_plans;
create policy enrollment_plans_read on public.enrollment_plans
  for select to authenticated using (true);

drop policy if exists enrollment_plans_admin_write on public.enrollment_plans;
create policy enrollment_plans_admin_write on public.enrollment_plans
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 3) enrollment_requests — one row per payment-proof submission (append-only from
--    the student's side; resubmission INSERTS a new row, preserving history).
--    plan_name / amount_expected are SNAPSHOTS taken at submit time so later plan
--    edits never rewrite what the student actually saw and owed.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.enrollment_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  plan_key          text not null references public.enrollment_plans(key),
  plan_name         text not null,
  full_name         text not null,
  email             text not null,
  phone             text,
  city_country      text,
  background        text,
  amount_expected   numeric not null,
  amount_paid       numeric not null,
  payment_reference text,
  receipt_path      text,                       -- object path in the enrollment-receipts bucket
  status            text not null default 'pending_review'
                    check (status in ('pending_review', 'approved', 'rejected', 'expired')),
  expires_at        timestamptz not null default (now() + interval '3 days'),
  rejection_reason  text,
  admin_notes       text,
  reviewed_at       timestamptz,
  reviewed_by       uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One live submission per student (double-submit protection at the DB level);
-- rejected/expired rows don't count, so resubmission is always possible.
create unique index if not exists enrollment_requests_one_pending
  on public.enrollment_requests (user_id) where status = 'pending_review';
create index if not exists enrollment_requests_status_created
  on public.enrollment_requests (status, created_at desc);

alter table public.enrollment_requests enable row level security;

-- Students read their own requests (powers the pending / rejected screens).
drop policy if exists enroll_req_own_select on public.enrollment_requests;
create policy enroll_req_own_select on public.enrollment_requests
  for select using (user_id = auth.uid());

-- Students create their own requests — always born pending_review.
drop policy if exists enroll_req_own_insert on public.enrollment_requests;
create policy enroll_req_own_insert on public.enrollment_requests
  for insert with check (user_id = auth.uid() and status = 'pending_review');

-- The ONLY student update path: flip an OVERDUE pending row of their own to
-- 'expired' (frees the one-pending unique index so they can resubmit). There is
-- structurally no student path to status = 'approved' — approval is admin-only.
drop policy if exists enroll_req_own_expire on public.enrollment_requests;
create policy enroll_req_own_expire on public.enrollment_requests
  for update
  using (user_id = auth.uid() and status = 'pending_review' and expires_at < now())
  with check (user_id = auth.uid() and status = 'expired');

-- Admins see and manage everything (Enrollments admin tab).
drop policy if exists enroll_req_admin_all on public.enrollment_requests;
create policy enroll_req_admin_all on public.enrollment_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 4) subscriptions — the durable "who is on which plan" record, written by the
--    admin approve action. One active subscription per user.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  plan_key    text not null,
  status      text not null default 'active'
              check (status in ('active', 'cancelled', 'expired')),
  started_at  timestamptz not null default now(),
  approved_by uuid references auth.users(id) on delete set null,
  request_id  uuid references public.enrollment_requests(id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index if not exists subscriptions_one_active
  on public.subscriptions (user_id) where status = 'active';

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_own_select on public.subscriptions;
create policy subscriptions_own_select on public.subscriptions
  for select using (user_id = auth.uid());

drop policy if exists subscriptions_admin_all on public.subscriptions;
create policy subscriptions_admin_all on public.subscriptions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 5) payment_settings — admin-editable manual-payment instructions shown on the
--    paywall (sidebar_settings pattern: keyed rows, everyone reads, admins write).
--    Seeded with ON CONFLICT DO NOTHING so in-app edits survive re-runs.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.payment_settings (
  key        text primary key,
  value      text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.payment_settings (key, value) values
  ('account_name',  'Alexander Sagun'),
  ('bpi',           '4359-11-9572'),
  ('security_bank', '00000-2729-5323'),
  ('gcash',         '0905-415-7015'),
  ('notify_email',  'alex.capinding.sagun@gmail.com'),
  ('note',          '')
on conflict (key) do nothing;

alter table public.payment_settings enable row level security;

drop policy if exists payment_settings_read on public.payment_settings;
create policy payment_settings_read on public.payment_settings
  for select to authenticated using (true);

drop policy if exists payment_settings_admin_write on public.payment_settings;
create policy payment_settings_admin_write on public.payment_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 6) PRIVATE storage bucket for receipts. Unlike course-media this bucket is NOT
--    public — receipts are financial documents. Students upload under their own
--    uid folder ( <uid>/<uuid>-<filename> ); only the owner and admins can read.
--    ON CONFLICT also force-corrects the bucket to private if it was ever made
--    public by hand. 5 MB cap + image/PDF mime allowlist enforced server-side too.
-- ───────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('enrollment-receipts', 'enrollment-receipts', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Upload: only into your own uid-named folder.
drop policy if exists enrollment_receipts_insert_own on storage.objects;
create policy enrollment_receipts_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'enrollment-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Read: the owner (their own folder) or an admin (review + signed URLs).
drop policy if exists enrollment_receipts_select on storage.objects;
create policy enrollment_receipts_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'enrollment-receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- Delete: owner (failed-submit cleanup) or admin. No UPDATE policy — receipts are
-- immutable once submitted; a resubmission uploads a brand-new file.
drop policy if exists enrollment_receipts_delete on storage.objects;
create policy enrollment_receipts_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'enrollment-receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ───────────────────────────────────────────────────────────────────
-- 7) Defense-in-depth: tighten Supabase-backed CONTENT reads to approved AND
--    enrolled (paid) users — the payment counterpart of user-approval.sql step 5.
--    Safe because step 1 back-filled every approved account to is_paid = true.
--    Skips (with a NOTICE) if user-approval.sql hasn't run yet — re-run after.
--    Revert snippet: ENROLLMENT_SETUP.md "Turning the paywall OFF".
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regproc('public.is_approved') is null then
    raise notice 'Skipping content-RLS tightening: run db/2026-06-29-user-approval.sql first, then re-run this file.';
    return;
  end if;

  if to_regclass('public.courses') is not null then
    execute 'drop policy if exists courses_read on public.courses';
    execute $pol$create policy courses_read on public.courses for select to authenticated
      using (public.is_admin() or (published = true and public.is_approved() and public.is_enrolled()))$pol$;
  end if;

  if to_regclass('public.course_modules') is not null then
    execute 'drop policy if exists modules_read on public.course_modules';
    execute $pol$create policy modules_read on public.course_modules for select to authenticated
      using (public.is_admin() or (public.is_approved() and public.is_enrolled() and exists (
        select 1 from public.courses c where c.id = course_id and c.published = true)))$pol$;
  end if;

  if to_regclass('public.course_lessons') is not null then
    execute 'drop policy if exists lessons_read on public.course_lessons';
    execute $pol$create policy lessons_read on public.course_lessons for select to authenticated
      using (public.is_admin() or (public.is_approved() and public.is_enrolled() and exists (
        select 1 from public.courses c where c.id = course_id and c.published = true)))$pol$;
  end if;

  if to_regclass('public.feature_guides') is not null then
    execute 'drop policy if exists feature_guides_read on public.feature_guides';
    execute $pol$create policy feature_guides_read on public.feature_guides for select to authenticated
      using (public.is_approved() and public.is_enrolled())$pol$;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 8) Realtime on enrollment_requests (optional but recommended): the student's
--    "payment under review" screen reacts the instant an admin rejects, and the
--    admin tab hears new submissions live (badge + optional sound). RLS still
--    applies — students only ever receive their own rows. Without this, the app
--    falls back to a 30s poll / on-focus refetch.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'enrollment_requests'
  ) then
    alter publication supabase_realtime add table public.enrollment_requests;
  end if;
end $$;

-- 9) Refresh PostgREST's schema cache so the new tables are queryable immediately.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • New signups land on the Enrollment Paywall (pricing → payment proof → review).
--   • Review submissions in-app: sign in as an admin → sidebar → "Enrollments".
--   • Approving sets the request approved + profiles.is_paid/plan/approval_status +
--     an active subscriptions row, in one click. Rejecting keeps the student blocked
--     (they see your reason and can resubmit).
--   • Payment instructions (BPI / Security Bank / GCash / account name) are editable
--     in the Enrollments tab → "Payment details" — no SQL needed.
--   • Emails are OPTIONAL — set RESEND_API_KEY + RESEND_FROM (and optionally
--     NOTIFY_ADMIN_EMAIL) in Vercel. Everything works without them.
--   • Turn the paywall OFF later: set VITE_REQUIRE_ENROLLMENT=false (rebuild), and
--     optionally revert section 7 policies — see ENROLLMENT_SETUP.md.
-- ─────────────────────────────────────────────────────────────────────────────
