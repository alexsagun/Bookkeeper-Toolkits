-- ═════════════════════════════════════════════════════════════════════════════
-- 000 — FULL DATABASE BOOTSTRAP (optional, for a FRESH Supabase project)
-- Ultimate Remote Bookkeeper Toolkits ("Get Hired With Alex")
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT: one self-contained script that stands up the ENTIRE schema from zero —
-- profiles + signup trigger, admin/approval/enrollment helpers, the course
-- platform, sidebar/feature-guide tables, the manual enrollment + subscription
-- lifecycle, both storage buckets + policies, all indexes, and the realtime
-- publication. It expresses the FINAL, fully-gated state (both feature flags
-- VITE_REQUIRE_ADMIN_APPROVAL and VITE_REQUIRE_ENROLLMENT default ON), so the
-- read policies below already require approved AND enrolled.
--
-- WHEN TO RUN THIS:  a brand-new Supabase project only.
-- WHEN NOT TO:       an existing database that already has the dated db/*.sql
--                    migrations applied — run any NEW dated files in the order
--                    documented in db/README.md instead. On an existing DB this file's
--                    `create table if not exists` skips existing tables and will
--                    NOT apply incremental column adds. See db/README.md.
--
-- PROPERTIES:
--   • IDEMPOTENT — create-if-not-exists / create-or-replace / drop-…-if-exists /
--     on-conflict, so re-running it is safe and errors-free.
--   • NON-DESTRUCTIVE — no drop table / drop column / delete / truncate. Seeds use
--     ON CONFLICT DO NOTHING; buckets use ON CONFLICT DO UPDATE (config only). The
--     one-time "grandfather" backfills in the dated files are deliberately OMITTED
--     here (a fresh DB has no rows to migrate; the clean-slate defaults
--     approval_status='pending' / is_paid=false are correct — admins bypass all
--     gates, so promoting the first admin at the end is the only manual step).
--
-- CONFLICT RESOLUTION (objects redefined across the dated files are collapsed to
-- their FINAL form here, defined exactly once):
--   • public.is_enrolled()  = the date-aware version (checks an ACTIVE, non-expired
--     subscription), NOT the early is_admin-or-is_paid version.
--   • courses_read / modules_read / lessons_read = is_admin() OR (published AND
--     is_approved() AND is_enrolled()).
--   • feature_guides_read = is_approved() AND is_enrolled().
--
-- ORDERING NOTE: is_enrolled() and the four gated read policies are created LATE
-- (after the subscriptions table), because is_enrolled() selects from
-- public.subscriptions and the policies call is_enrolled() — defining them earlier
-- would fail on an empty database (check_function_bodies validates table refs).
--
-- HOW TO RUN: paste the whole file into Supabase → SQL Editor → Run.
-- ═════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Extensions (defensive — Supabase already provides gen_random_uuid()).
-- ───────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────────
-- 1) profiles — one row per auth user, full final shape (base + approval columns
--    inline, so no post-hoc ALTERs are needed on a fresh install).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text,
  full_name        text,
  avatar_url       text,
  is_paid          boolean not null default false,   -- "has paid at least once" cache; real access = is_enrolled()
  plan             text not null default 'free',
  is_admin         boolean not null default false,
  approval_status  text not null default 'pending'
                   check (approval_status in ('pending', 'approved', 'rejected')),
  approved_at      timestamptz,
  approved_by      uuid references auth.users(id) on delete set null,
  rejected_at      timestamptz,
  rejected_by      uuid references auth.users(id) on delete set null,
  rejection_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user reads only their own row (so the client can read its own approval_status).
-- The admin-wide profile policies need is_admin(), so they're created in §3 (after it).
drop policy if exists own_profile_select on public.profiles;
create policy own_profile_select on public.profiles
  for select using (auth.uid() = id);

-- ───────────────────────────────────────────────────────────────────
-- 2) Signup trigger — auto-create a profile row on every new auth user (email OR
--    Google). It sets only (id, email, full_name, avatar_url), so the column
--    DEFAULTS apply: approval_status='pending', is_paid=false, is_admin=false.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
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

-- ───────────────────────────────────────────────────────────────────
-- 3) Access helpers (security definer + pinned search_path → no RLS recursion).
--    is_enrolled() is created LATER (§13) — it needs the subscriptions table.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select approval_status = 'approved' or is_admin from public.profiles where id = auth.uid()),
    false
  )
$$;

-- Admin-wide profile RLS (deferred here from §1 because it needs is_admin(), created
-- just above). No user-update policy exists, so a non-admin can never change their
-- own approval_status / is_paid / is_admin.
drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select on public.profiles
  for select to authenticated using (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 4) Course platform tables + indexes + RLS. Only the NON-gated policies are
--    created here (admin-write, own progress/completions); the gated *_read
--    policies are created in §14 (they need is_enrolled()).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.courses (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null default 'qbo-mastery',
  title       text not null,
  subtitle    text,
  description text,
  cover_path  text,
  month       text,                                                       -- legacy cohort label (display fallback only)
  course_date date,                                                       -- editable cohort/run date (defaults to today in-app)
  source_course_id uuid references public.courses(id) on delete set null, -- duplication lineage
  published   boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.course_modules (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  title      text not null,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_modules_course on public.course_modules(course_id, position);

create table if not exists public.course_lessons (
  id             uuid primary key default gen_random_uuid(),
  module_id      uuid not null references public.course_modules(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  title          text not null,
  type           text not null default 'video' check (type in ('video','text')),
  video_url      text,
  video_provider text check (video_provider in ('youtube','vimeo','mp4','upload')),
  storage_path   text,
  text_content   text,
  duration_label text,
  position       integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_lessons_module on public.course_lessons(module_id, position);

create table if not exists public.lesson_progress (
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_id    uuid not null references public.course_lessons(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index if not exists idx_progress_user_course on public.lesson_progress(user_id, course_id);

create table if not exists public.course_completions (
  user_id      uuid not null references auth.users(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

alter table public.courses            enable row level security;
alter table public.course_modules     enable row level security;
alter table public.course_lessons     enable row level security;
alter table public.lesson_progress    enable row level security;
alter table public.course_completions enable row level security;

-- Admin-write (needs only is_admin()); gated *_read policies are in §14.
drop policy if exists courses_admin_write on public.courses;
create policy courses_admin_write on public.courses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists modules_admin_write on public.course_modules;
create policy modules_admin_write on public.course_modules for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists lessons_admin_write on public.course_lessons;
create policy lessons_admin_write on public.course_lessons for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists progress_own on public.lesson_progress;
create policy progress_own on public.lesson_progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists completions_own on public.course_completions;
create policy completions_own on public.course_completions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Seed the canonical course (loaded by slug 'qbo-mastery').
insert into public.courses (title, slug, subtitle, published)
values ('QuickBooks Online Mastering Programme', 'qbo-mastery',
        'From setup to month-end — the complete QBO workflow for remote bookkeepers.', true)
on conflict (slug) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 5) Storage buckets + object policies.
--    course-media   = PUBLIC  (course/cover/feature-guide media, getPublicUrl)
--    enrollment-receipts = PRIVATE (financial receipts, createSignedUrl)
--    Bucket inserts degrade to a NOTICE under a restricted SQL role → then create
--    them in Dashboard → Storage; the object policies below still apply.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('course-media', 'course-media', true)
  on conflict (id) do update set public = true;
exception when insufficient_privilege then
  raise notice 'Create the course-media bucket in Dashboard → Storage (Public = ON); policies still applied.';
end $$;

do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('enrollment-receipts', 'enrollment-receipts', false, 5242880,
          array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
exception when insufficient_privilege then
  raise notice 'Create the enrollment-receipts bucket in Dashboard → Storage (Public = OFF, 5 MB, png/jpeg/webp/pdf); policies still applied.';
end $$;

-- course-media: public read, admin write/update/delete.
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

-- enrollment-receipts: upload/read/delete only own uid-folder (or admin). No UPDATE.
drop policy if exists enrollment_receipts_insert_own on storage.objects;
create policy enrollment_receipts_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'enrollment-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists enrollment_receipts_select on storage.objects;
create policy enrollment_receipts_select on storage.objects
  for select to authenticated
  using (bucket_id = 'enrollment-receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
drop policy if exists enrollment_receipts_delete on storage.objects;
create policy enrollment_receipts_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'enrollment-receipts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- 6) sidebar_settings — global, admin-controlled navigation labels.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.sidebar_settings (
  item_key     text primary key,
  custom_label text not null,
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
alter table public.sidebar_settings enable row level security;
drop policy if exists sidebar_settings_read on public.sidebar_settings;
create policy sidebar_settings_read on public.sidebar_settings
  for select to authenticated using (true);
drop policy if exists sidebar_settings_admin_write on public.sidebar_settings;
create policy sidebar_settings_admin_write on public.sidebar_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 7) feature_guides — admin-curated explainer video + external CTA, keyed by
--    feature. Only the admin-write policy here; the gated read policy is in §14.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.feature_guides (
  feature_key    text primary key,
  title          text,
  description    text,
  video_url      text,
  video_path     text,
  video_provider text,                                               -- 'upload' | 'youtube' | 'vimeo' | 'mp4' | null
  external_url   text,
  is_active      boolean not null default true,
  updated_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.feature_guides enable row level security;
drop policy if exists feature_guides_admin_write on public.feature_guides;
create policy feature_guides_admin_write on public.feature_guides
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 8) feature_video_completions — per-user "watched the guide video" gate.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.feature_video_completions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  feature_key   text not null,
  video_version text,
  completed     boolean not null default true,
  completed_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, feature_key)
);
alter table public.feature_video_completions enable row level security;
drop policy if exists fvc_select_own on public.feature_video_completions;
create policy fvc_select_own on public.feature_video_completions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists fvc_insert_own on public.feature_video_completions;
create policy fvc_insert_own on public.feature_video_completions
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists fvc_update_own on public.feature_video_completions;
create policy fvc_update_own on public.feature_video_completions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────────
-- 9) enrollment_plans — the pricing cards (access/support durations +
--    entitlement chips folded inline). Seed is ON CONFLICT DO NOTHING so admin
--    edits survive re-runs.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.enrollment_plans (
  key                 text primary key,
  name                text not null,
  tagline             text,
  price_php           numeric not null,
  compare_at_php      numeric,
  badge               text,
  features            jsonb not null default '[]'::jsonb,
  limit_note          text,
  position            int not null default 0,
  active              boolean not null default true,
  access_days         int,                                    -- NULL = never expires
  support_days        int,                                    -- informational (not RLS-enforced)
  entitlement_summary jsonb not null default '[]'::jsonb,     -- short chips for compact UI
  updated_at          timestamptz not null default now()
);

insert into public.enrollment_plans
  (key, name, tagline, price_php, compare_at_php, badge, features, limit_note, position, access_days, support_days, entitlement_summary) values
  ('core_self_paced', 'QBO Mastery Only', 'Core · Self-Paced', 999, null, null,
   '["Simulated annual bookkeeping project for an NY-based construction company","60-day QBO Mastery course access","Weekly Discord chat (Thu)"]'::jsonb,
   null, 1, 60, null,
   '["60-day QBO Mastery access","Weekly Discord chat"]'::jsonb),
  ('sampler', 'Sampler Session', 'Essentials', 1499, null, null,
   '["1 Live Zoom Session (3 hours)","60-day course access","30-day group chat support"]'::jsonb,
   'Limited offer', 2, 60, 30,
   '["60-day course access","30-day group chat support","1 live Zoom session"]'::jsonb),
  ('silver_self_paced', 'QBO + Resume Combo', 'Silver · Self-Paced', 1999, null, null,
   '["Simulated annual bookkeeping project for an NY-based construction company","60-day QBO Mastery course access","60-day Resume & Interview course access","Weekly Discord chat (Thu)"]'::jsonb,
   null, 3, 60, null,
   '["60-day QBO Mastery access","60-day Resume & Interview access"]'::jsonb),
  ('gold_live', 'Live Group Track', 'Gold Package', 9999, 35000, 'BEST VALUE',
   '["Simulated annual bookkeeping project for an NY-based construction company","12 LIVE Group Zoom Trainings (MWF 9am to 11am PH time)","180-day resume + interview course access","Weekly group consult until hired","Discord chat support until and after hired"]'::jsonb,
   null, 4, 180, null,
   '["180-day full access","12 live group trainings","Weekly consult until hired"]'::jsonb),
  ('vip', 'Personalized Coaching Program', 'VIP Package', 15999, 35000, 'BEST SELLER',
   '["Simulated annual bookkeeping project for an NY-based construction company","12 Live Group Zoom Trainings (MWF 9am to 11am PH Time)","1-on-1 Resume & Interview Coaching (1 session)","Weekly group consult until hired","Discord chat support until and after hired"]'::jsonb,
   'Limited to 10 slots per month', 5, 180, null,
   '["180-day full access","1-on-1 coaching","Weekly consult until hired"]'::jsonb)
on conflict (key) do nothing;

alter table public.enrollment_plans enable row level security;
drop policy if exists enrollment_plans_read on public.enrollment_plans;
create policy enrollment_plans_read on public.enrollment_plans
  for select to authenticated using (true);
drop policy if exists enrollment_plans_admin_write on public.enrollment_plans;
create policy enrollment_plans_admin_write on public.enrollment_plans
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 10) enrollment_requests — one row per payment-proof submission (append-only
--     from the student; resubmission inserts a new row). Snapshots plan_name /
--     amount_expected at submit time.
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
  receipt_path      text,
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
-- One live submission per student; rejected/expired don't count → resubmission works.
create unique index if not exists enrollment_requests_one_pending
  on public.enrollment_requests (user_id) where status = 'pending_review';
create index if not exists enrollment_requests_status_created
  on public.enrollment_requests (status, created_at desc);
-- Student's own-history read (user_id = auth.uid() order by created_at desc) — the
-- partial one_pending index above doesn't serve it; this closes that gap.
create index if not exists enrollment_requests_user_created
  on public.enrollment_requests (user_id, created_at desc);

alter table public.enrollment_requests enable row level security;
drop policy if exists enroll_req_own_select on public.enrollment_requests;
create policy enroll_req_own_select on public.enrollment_requests
  for select using (user_id = auth.uid());
drop policy if exists enroll_req_own_insert on public.enrollment_requests;
create policy enroll_req_own_insert on public.enrollment_requests
  for insert with check (user_id = auth.uid() and status = 'pending_review');
-- Only student update path: flip an OVERDUE pending row of their own to 'expired'.
drop policy if exists enroll_req_own_expire on public.enrollment_requests;
create policy enroll_req_own_expire on public.enrollment_requests
  for update
  using (user_id = auth.uid() and status = 'pending_review' and expires_at < now())
  with check (user_id = auth.uid() and status = 'expired');
drop policy if exists enroll_req_admin_all on public.enrollment_requests;
create policy enroll_req_admin_all on public.enrollment_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 11) subscriptions — durable "who is on which plan" with lifecycle columns
--     inline. One active subscription per user.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  plan_key    text not null,
  status      text not null default 'active'
              check (status in ('active', 'cancelled', 'expired')),
  started_at  timestamptz not null default now(),
  ends_at        timestamptz,                                          -- NULL = never expires (legacy/non-dated)
  grace_ends_at  timestamptz,
  renewed_from_subscription_id uuid references public.subscriptions(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  request_id  uuid references public.enrollment_requests(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists subscriptions_one_active
  on public.subscriptions (user_id) where status = 'active';
create index if not exists subscriptions_user_created on public.subscriptions (user_id, created_at desc);
create index if not exists subscriptions_status_ends  on public.subscriptions (status, ends_at);

alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_own_select on public.subscriptions;
create policy subscriptions_own_select on public.subscriptions
  for select using (user_id = auth.uid());
drop policy if exists subscriptions_admin_all on public.subscriptions;
create policy subscriptions_admin_all on public.subscriptions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 12) payment_settings — admin-editable manual-payment instructions (keyed rows,
--     everyone reads, admins write). Seed is ON CONFLICT DO NOTHING.
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
-- 13) Lifecycle functions (need the subscriptions table → created now).
--     is_enrolled() is THE access check every gated read policy calls.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.is_enrolled()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select p.is_admin
        or exists (
             select 1 from public.subscriptions s
             where s.user_id = p.id
               and s.status = 'active'
               and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now()))
        or (p.is_paid and not exists (
             select 1 from public.subscriptions s2 where s2.user_id = p.id))
    from public.profiles p where p.id = auth.uid()), false)
$$;

-- The ONLY way a term is granted/renewed (admin Enrollments tab → Approve).
create or replace function public.approve_subscription(
  p_user_id    uuid,
  p_plan_key   text,
  p_request_id uuid
)
returns public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_grace_days constant int := 0;   -- grace knob. 0 = access ends exactly at ends_at.
  v_days   int;
  v_prev   public.subscriptions%rowtype;
  v_base   timestamptz;
  v_ends   timestamptz;
  v_grace  timestamptz;
  v_new    public.subscriptions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'approve_subscription: admin only';
  end if;

  select access_days into v_days from public.enrollment_plans where key = p_plan_key;

  select * into v_prev
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1
    for update;

  -- Renewal stacking: extend from current expiry if still running, else from now.
  if v_prev.id is not null and v_prev.status = 'active'
     and v_prev.ends_at is not null and v_prev.ends_at > now() then
    v_base := v_prev.ends_at;
  else
    v_base := now();
  end if;

  v_ends  := case when v_days is null then null else v_base + make_interval(days => v_days) end;
  v_grace := case when v_ends is null or v_grace_days = 0 then null
                  else v_ends + make_interval(days => v_grace_days) end;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'active';

  insert into public.subscriptions
    (user_id, plan_key, status, started_at, ends_at, grace_ends_at,
     approved_by, request_id, renewed_from_subscription_id)
  values
    (p_user_id, p_plan_key, 'active', now(), v_ends, v_grace,
     auth.uid(), p_request_id, v_prev.id)
  returning * into v_new;

  return v_new;
end;
$$;
revoke all on function public.approve_subscription(uuid, text, uuid) from public;
grant execute on function public.approve_subscription(uuid, text, uuid) to authenticated;

-- Cosmetic status sweep (the date check in is_enrolled() is the real authority).
create or replace function public.expire_overdue_subscriptions()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_count int;
begin
  if not public.is_admin() then
    raise exception 'expire_overdue_subscriptions: admin only';
  end if;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where status = 'active'
     and ends_at is not null
     and coalesce(grace_ends_at, ends_at) < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_overdue_subscriptions() from public;
grant execute on function public.expire_overdue_subscriptions() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 14) FINAL content-gating read policies — defined once, in final form
--     (needs is_approved() §3 + is_enrolled() §13). Approved AND enrolled.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists courses_read on public.courses;
create policy courses_read on public.courses for select to authenticated
  using (public.is_admin() or (published = true and public.is_approved() and public.is_enrolled()));

drop policy if exists modules_read on public.course_modules;
create policy modules_read on public.course_modules for select to authenticated
  using (public.is_admin() or (public.is_approved() and public.is_enrolled() and exists (
    select 1 from public.courses c where c.id = course_id and c.published = true)));

drop policy if exists lessons_read on public.course_lessons;
create policy lessons_read on public.course_lessons for select to authenticated
  using (public.is_admin() or (public.is_approved() and public.is_enrolled() and exists (
    select 1 from public.courses c where c.id = course_id and c.published = true)));

drop policy if exists feature_guides_read on public.feature_guides;
create policy feature_guides_read on public.feature_guides for select to authenticated
  using (public.is_approved() and public.is_enrolled());

-- ───────────────────────────────────────────────────────────────────
-- 15) Supplemental performance indexes (the non-redundant ones; PK/unique
--     already cover slug, user+course completions, user+feature completions).
-- ───────────────────────────────────────────────────────────────────
create index if not exists profiles_approval_status_idx        on public.profiles (approval_status);
create index if not exists courses_position_created_idx        on public.courses (position, created_at);
create index if not exists course_lessons_course_position_idx  on public.course_lessons (course_id, position);
create index if not exists lesson_progress_course_user_idx     on public.lesson_progress (course_id, user_id);

-- ───────────────────────────────────────────────────────────────────
-- 16) Realtime — publish the tables the app subscribes to. Guarded so re-runs
--     and non-Supabase Postgres (no supabase_realtime publication) don't error.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='profiles') then
      alter publication supabase_realtime add table public.profiles;
    end if;
    if not exists (select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='enrollment_requests') then
      alter publication supabase_realtime add table public.enrollment_requests;
    end if;
    if not exists (select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='subscriptions') then
      alter publication supabase_realtime add table public.subscriptions;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 17) Refresh PostgREST's schema cache.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING (fresh install)
--   1. If §5 raised a NOTICE (restricted role), create the two buckets in
--      Dashboard → Storage: course-media (Public ON), enrollment-receipts
--      (Public OFF, 5 MB, png/jpeg/webp/pdf).
--   2. Sign in once with your owner account so a profiles row exists, then promote
--      it to admin (admins bypass the approval + enrollment gates):
--        update public.profiles set is_admin = true where email = 'you@example.com';
--      Sign out/in to re-read the profile.
--   3. Auth config (Confirm email, Site/Redirect URLs, Google provider) is set in
--      the Supabase Dashboard — see AUTH_SETUP.md.
--   4. Feature flags VITE_REQUIRE_ADMIN_APPROVAL / VITE_REQUIRE_ENROLLMENT default
--      ON, so this schema is already the fully-gated final state.
-- ═════════════════════════════════════════════════════════════════════════════
