-- ═════════════════════════════════════════════════════════════════════════════
-- 000 — FULL DATABASE BOOTSTRAP (optional, for a FRESH Supabase project)
-- Ultimate Remote Bookkeeper Toolkits ("Get Hired With Alex")
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT: one self-contained script that stands up the ENTIRE schema from zero —
-- profiles + signup trigger, admin/approval/enrollment helpers, the course
-- platform, sidebar/feature-guide tables, the manual enrollment + subscription
-- lifecycle, the community feed (posts/comments/reactions/tags), the community
-- spaces + batches segmentation (§19, #32: General + per-batch Gold/VIP private
-- communities derived from the member's subscription), both storage
-- buckets + policies, all indexes, and the realtime publication. It expresses the FINAL, fully-gated state (both feature flags
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
--     is_approved() AND is_enrolled() AND per-plan course scope) — the plan conjuncts scope
--     higher-tier courses (core_self_paced → qbo-* only; sampler → qbo-* AND
--     access_tier='essentials' only, i.e. QBO Essentials not Mastery; §13b). No-arg helpers
--     are wrapped in (select …) so each is one InitPlan per query.
--   • course_videos_read = is_admin() OR (is_enrolled() AND (full-access plan OR
--     course_object_allowed(name))).
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
--    pgvector (extensions schema, Supabase idiom) powers the AI course trainer's
--    384-dim gte-small embeddings (§16b); pg_trgm is created with the community
--    section (§15b) that uses it.
-- ───────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

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
  access_tier text not null default 'standard',                          -- 'standard' = premium; 'essentials' = Sampler-accessible (see §13b/§14)
  ai_trainer_enabled boolean not null default false,                     -- per-course opt-in for the AI voice trainer (§16b)
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
--    avatars        = PUBLIC  (member profile pictures, getPublicUrl; #24)
--    (community-media is created in §14b — its read policy needs is_enrolled().)
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
-- Delete: ADMIN ONLY. Students cannot delete their own receipt after submitting (payment
-- evidence integrity — see db/2026-07-08-receipt-integrity.sql). Receipts are immutable
-- (no UPDATE policy); a resubmission uploads a brand-new file.
drop policy if exists enrollment_receipts_delete on storage.objects;
create policy enrollment_receipts_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'enrollment-receipts' and public.is_admin());

-- avatars (#24): public read; members write only inside their own <uid>/ folder.
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 5242880,
          array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  on conflict (id) do update set
    public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
exception when insufficient_privilege then
  raise notice 'Create the avatars bucket in Dashboard → Storage (Public = ON, 5 MB, image mimes); policies still applied.';
end $$;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select to public
  using (bucket_id = 'avatars');
-- The avatars WRITE policies (own folder + active membership) are created at
-- the end of §15b — they reference is_approved()/is_enrolled(), which are not
-- defined until §13.

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
   '["1 Live Zoom Session (3 hours)","60-day course access","60-day group chat support"]'::jsonb,
   'Limited offer', 2, 60, 60,
   '["60-day course access","60-day group chat support","1 live Zoom session"]'::jsonb),
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
  notify_status     text,          -- admin-alert email outcome (record_enrollment_notification)
  notified_at       timestamptz,
  notify_detail     text,          -- short, non-secret provider detail slice
  request_kind      text not null default 'new'
                    check (request_kind in ('new', 'renewal', 'upgrade', 'extension')),  -- #20
  extension_days    int            -- #20: purchased days for a request_kind='extension' row
                    check (extension_days is null or (extension_days between 60 and 365)),  -- #21 cap
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
  v_grace_days constant int := 3;   -- grace knob. 3 = access continues 3 days past ends_at.
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

-- approve_extension() (#20, #21 form) — grant EXTRA days on the member's CURRENT plan
-- (Enrollments → Approve on a request_kind='extension' row). Same-plan; term length = the
-- request's extension_days; extends from the current expiry while a term still runs, else
-- from now. #21 caps p_days at 60–365 (the request column is student-declared).
create or replace function public.approve_extension(
  p_user_id    uuid,
  p_request_id uuid,
  p_days       int
)
returns public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_grace_days constant int := 3;
  v_prev   public.subscriptions%rowtype;
  v_base   timestamptz;
  v_ends   timestamptz;
  v_grace  timestamptz;
  v_new    public.subscriptions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'approve_extension: admin only';
  end if;
  if p_days is null or p_days < 60 then
    raise exception 'approve_extension: minimum extension is 60 days (2 months)';
  end if;
  if p_days > 365 then
    raise exception 'approve_extension: maximum extension is 365 days (12 months)';
  end if;

  select * into v_prev
    from public.subscriptions
    where user_id = p_user_id
    order by created_at desc
    limit 1
    for update;

  if v_prev.id is null then
    raise exception 'approve_extension: no subscription to extend for this user';
  end if;
  -- Idempotency + never shorten a legacy no-expiry term.
  if v_prev.status = 'active' and v_prev.request_id = p_request_id then return v_prev; end if;
  if v_prev.status = 'active' and v_prev.ends_at is null then return v_prev; end if;

  if v_prev.status = 'active' and v_prev.ends_at is not null and v_prev.ends_at > now() then
    v_base := v_prev.ends_at;
  else
    v_base := now();
  end if;

  v_ends  := v_base + make_interval(days => p_days);
  v_grace := case when v_grace_days = 0 then null else v_ends + make_interval(days => v_grace_days) end;

  update public.subscriptions
     set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'active';

  insert into public.subscriptions
    (user_id, plan_key, status, started_at, ends_at, grace_ends_at,
     approved_by, request_id, renewed_from_subscription_id)
  values
    (p_user_id, v_prev.plan_key, 'active', now(), v_ends, v_grace,
     auth.uid(), p_request_id, v_prev.id)
  returning * into v_new;

  return v_new;
end;
$$;
revoke all on function public.approve_extension(uuid, uuid, int) from public;
grant execute on function public.approve_extension(uuid, uuid, int) to authenticated;

-- record_enrollment_notification() — the ONLY write path for the enrollment_requests
-- notify_* audit columns. SECURITY DEFINER + internal owner-or-admin guard so the
-- notify-enrollment function (running as the student's JWT on a 'submitted' action)
-- can stamp the send outcome without a broad student UPDATE policy or a service-role key.
create or replace function public.record_enrollment_notification(
  p_request_id uuid,
  p_status     text,
  p_detail     text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.enrollment_requests
     set notify_status = left(coalesce(p_status, ''), 40),
         notified_at   = now(),
         notify_detail = nullif(left(coalesce(p_detail, ''), 300), '')
   where id = p_request_id
     and (user_id = auth.uid() or public.is_admin());
end;
$$;
revoke all on function public.record_enrollment_notification(uuid, text, text) from public;
grant execute on function public.record_enrollment_notification(uuid, text, text) to authenticated;

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
-- 13b) PLAN-SCOPED course access helpers (server half of the per-plan entitlement model;
--      client half = PLAN_ENTITLEMENTS in src/BookkeeperPro.jsx). core_self_paced may read
--      ONLY qbo-* courses (the sole Supabase courses in Training & Skills); admins + every
--      OTHER/null plan → full. Consumed by the §14/§14b read policies. See
--      db/2026-07-09-plan-course-access.sql for the full rationale. Placed after
--      subscriptions (§12) since current_plan_key() selects from it. Keep in sync with the
--      client PLAN_ENTITLEMENTS map when entitlements change.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.current_plan_key()
returns text
language sql stable security definer set search_path = public
as $$
  select s.plan_key
  from public.subscriptions s
  where s.user_id = auth.uid()
    and s.status = 'active'
    and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
  order by s.created_at desc
  limit 1
$$;

-- plan_is_qbo_only() — NON-NULL, no-arg boolean → InitPlan-friendly in the §14 policies
-- and safe inside `not (...)`. core_self_paced → true; admins/other/null plan → false.
create or replace function public.plan_is_qbo_only()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_plan_key() = 'core_self_paced', false)
$$;

-- plan_is_sampler() — sampler is scoped even tighter than core: within the qbo catalog it
-- reads ONLY the `access_tier = 'essentials'` course (QuickBooks Online Essentials), not
-- Mastery. Same shape/rationale as plan_is_qbo_only(); see db/2026-07-11-sampler-essentials-access.sql.
create or replace function public.plan_is_sampler()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_plan_key() = 'sampler', false)
$$;

create or replace function public.course_object_allowed(p_name text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_cid  uuid;
  v_slug text;
  v_tier text;
begin
  if public.is_admin() then return true; end if;
  if not public.plan_is_qbo_only() and not public.plan_is_sampler() then
    return true;                                 -- full-access plans: no restriction
  end if;
  begin
    v_cid := split_part(p_name, '/', 2)::uuid;   -- lessons/<course_id>/...
  exception when others then
    return true;
  end;
  select slug, access_tier into v_slug, v_tier from public.courses where id = v_cid;
  if v_slug is null then return true; end if;
  if public.plan_is_sampler() then
    return v_slug like 'qbo-%' and v_tier = 'essentials';
  end if;
  return v_slug like 'qbo-%';                     -- plan_is_qbo_only (core)
end;
$$;

grant execute on function public.current_plan_key()          to authenticated;
grant execute on function public.plan_is_qbo_only()          to authenticated;
grant execute on function public.plan_is_sampler()           to authenticated;
grant execute on function public.course_object_allowed(text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 14) FINAL content-gating read policies — defined once, in final form
--     (needs is_approved() §3 + is_enrolled() §13 + plan_is_qbo_only() §13b).
--     Approved AND enrolled AND the course is in the caller's plan scope.
--     No-arg helpers are wrapped in `(select …)` so each is a single InitPlan
--     (evaluated once per query, not per row — the Supabase RLS perf pattern); the
--     plan check short-circuits so full-access members do zero per-row plan work.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists courses_read on public.courses;
create policy courses_read on public.courses for select to authenticated
  using ((select public.is_admin())
    or (published = true and (select public.is_approved()) and (select public.is_enrolled())
        and (not (select public.plan_is_qbo_only()) or slug like 'qbo-%')
        and (not (select public.plan_is_sampler()) or (slug like 'qbo-%' and access_tier = 'essentials'))));

drop policy if exists modules_read on public.course_modules;
create policy modules_read on public.course_modules for select to authenticated
  using ((select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled()) and exists (
      select 1 from public.courses c where c.id = course_id and c.published = true
        and (not (select public.plan_is_qbo_only()) or c.slug like 'qbo-%')
        and (not (select public.plan_is_sampler()) or (c.slug like 'qbo-%' and c.access_tier = 'essentials')))));

drop policy if exists lessons_read on public.course_lessons;
create policy lessons_read on public.course_lessons for select to authenticated
  using ((select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled()) and exists (
      select 1 from public.courses c where c.id = course_id and c.published = true
        and (not (select public.plan_is_qbo_only()) or c.slug like 'qbo-%')
        and (not (select public.plan_is_sampler()) or (c.slug like 'qbo-%' and c.access_tier = 'essentials')))));

drop policy if exists feature_guides_read on public.feature_guides;
create policy feature_guides_read on public.feature_guides for select to authenticated
  using (public.is_approved() and public.is_enrolled());

-- ───────────────────────────────────────────────────────────────────
-- 14b) PRIVATE bucket for PAID lesson videos (course-videos). Created here — AFTER
--      is_enrolled() (§13) — because course_videos_read calls it. The public course-media
--      bucket (§5) holds covers + feature-guide videos; a public bucket serves every object
--      publicly (bypassing RLS on read), so lesson VIDEO files live in this private bucket
--      and are served via short-lived signed URLs gated by is_enrolled().
--      See db/2026-07-08-course-videos-private.sql.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('course-videos', 'course-videos', false, 52428800,
          array['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v'])
  on conflict (id) do update set public = false;
exception
  when insufficient_privilege then
    raise notice 'Create the course-videos bucket in Dashboard → Storage (Public = OFF); policies still applied.';
end $$;

drop policy if exists course_videos_read on storage.objects;
create policy course_videos_read on storage.objects for select to authenticated
  using (bucket_id = 'course-videos'
    and ((select public.is_admin())
         or ((select public.is_enrolled())
             and ((not (select public.plan_is_qbo_only()) and not (select public.plan_is_sampler()))
                  or public.course_object_allowed(name)))));
drop policy if exists course_videos_admin_write on storage.objects;
create policy course_videos_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'course-videos' and public.is_admin());
drop policy if exists course_videos_admin_update on storage.objects;
create policy course_videos_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'course-videos' and public.is_admin());
drop policy if exists course_videos_admin_delete on storage.objects;
create policy course_videos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-videos' and public.is_admin());

-- community-media (#24): PRIVATE bucket for community post attachments (images +
-- videos) — member-only content, served via short-lived signed URLs, so it lives
-- here beside course-videos (same reasoning: a public bucket bypasses RLS on
-- read). Members upload only inside their own <uid>/ folder; enrolled members
-- read; delete own-or-admin.
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('community-media', 'community-media', false, 52428800,
          array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
                'video/mp4', 'video/webm', 'video/quicktime'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
exception
  when insufficient_privilege then
    raise notice 'Create the community-media bucket in Dashboard → Storage (Public = OFF, 50 MB, image + video mimes); policies still applied.';
end $$;

-- community_media_read (member read scoped to active-post attachments) is
-- created at the END of §15b — CREATE POLICY validates its USING references
-- immediately, and community_attachments/community_posts don't exist yet here.
drop policy if exists community_media_own_insert on storage.objects;
create policy community_media_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'community-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_approved()) and (select public.is_enrolled()));
drop policy if exists community_media_delete on storage.objects;
create policy community_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'community-media'
    and ((storage.foldername(name))[1] = (select auth.uid())::text
      or (select public.is_admin())));

-- Remove the superseded per-row helper LAST — only after the §14/§14b policies above no
-- longer reference it (RLS policies hold a pg_depend on functions in their USING clause).
-- NO CASCADE. Harmless no-op on a genuinely fresh DB (it was never created here).
drop function if exists public.course_plan_allowed(text);

-- ───────────────────────────────────────────────────────────────────
-- 15) Supplemental performance indexes (the non-redundant ones; PK/unique
--     already cover slug, user+course completions, user+feature completions).
-- ───────────────────────────────────────────────────────────────────
create index if not exists profiles_approval_status_idx        on public.profiles (approval_status);
create index if not exists courses_position_created_idx        on public.courses (position, created_at);
create index if not exists course_lessons_course_position_idx  on public.course_lessons (course_id, position);
create index if not exists lesson_progress_course_user_idx     on public.lesson_progress (course_id, user_id);

-- ───────────────────────────────────────────────────────────────────
-- 15b) Community forum (db/2026-07-20-community.sql #23 + the forum upgrade
--      db/2026-07-21-community-forum.sql #24). EVERY active paid plan includes
--      it, so the gate is is_approved() + is_enrolled() (term + grace — mirrors
--      courses; expired members are FULLY blocked, reads included).
--      author_name / author_avatar_url are DENORMALIZED at insert (non-admins
--      can't read other profiles rows) and server-stamped. status: 'active' |
--      'hidden' (admin) | 'deleted' (author soft-delete; members never
--      hard-DELETE posts/comments). admin_only tags (Announcements) are
--      enforced in the insert/update policies via a subquery — which is why
--      community_tags_read does NOT filter on `active` (the client filters
--      `active` for its pickers; hiding inactive rows here would let a
--      deactivated admin-only tag slip past the guard). Forum extras:
--      pinned/comments_locked/comment_count/last_activity_at are SERVER-
--      CONTROLLED (community_posts_guard() + community_comment_rollup());
--      announcements are born comments_locked; notifications are written ONLY
--      by SECURITY DEFINER triggers (no insert policy — unforgeable);
--      set_my_avatar() is the ONE sanctioned user-facing profiles write;
--      search_community_members() is the mention directory (name + avatar,
--      never email). Buckets: avatars (public) + community-media (private) in §5.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_tags (
  slug        text primary key,
  label       text not null,
  admin_only  boolean not null default false,
  active      boolean not null default true,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

insert into public.community_tags (slug, label, admin_only, position) values
  ('announcements',     'Announcements',      true,  1),
  ('introductions',     'Introductions',      false, 2),
  ('quickbooks-help',   'QuickBooks Help',    false, 3),
  ('us-bookkeeping',    'US Bookkeeping',     false, 4),
  ('course-questions',  'Course Questions',   false, 5),
  ('job-applications',  'Job Applications',   false, 6),
  ('resume-interview',  'Resume & Interview', false, 7),
  ('client-management', 'Client Management',  false, 8),
  ('wins',              'Wins',               false, 9),
  ('questions',         'General Questions',  false, 10)
on conflict (slug) do nothing;

-- Converge a #23-era database (its 9 rows survive the on-conflict seed with
-- the OLD labels/positions) on the forum taxonomy. No-op on a fresh install.
update public.community_tags as t
   set label = v.label, position = v.pos
  from (values
    ('announcements',     'Announcements',      1),
    ('introductions',     'Introductions',      2),
    ('quickbooks-help',   'QuickBooks Help',    3),
    ('us-bookkeeping',    'US Bookkeeping',     4),
    ('course-questions',  'Course Questions',   5),
    ('job-applications',  'Job Applications',   6),
    ('resume-interview',  'Resume & Interview', 7),
    ('client-management', 'Client Management',  8),
    ('wins',              'Wins',               9),
    ('questions',         'General Questions', 10)
  ) as v(slug, label, pos)
 where t.slug = v.slug
   and (t.label <> v.label or t.position <> v.pos);

create table if not exists public.community_posts (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid not null references public.profiles(id) on delete cascade,
  author_name       text not null,
  author_avatar_url text,
  title             text check (title is null or char_length(title) <= 120),
  body              text not null check (char_length(body) between 1 and 5000),
  tag_slug          text not null references public.community_tags(slug),
  status            text not null default 'active' check (status in ('active','hidden','deleted')),
  pinned            boolean not null default false,
  comments_locked   boolean not null default false,
  comment_count     int not null default 0,
  last_activity_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Forum columns (#24) — add-if-missing so a #23-era database that re-runs this
-- bootstrap converges on the same shape as a fresh install.
alter table public.community_posts add column if not exists author_avatar_url text;
alter table public.community_posts add column if not exists pinned           boolean not null default false;
alter table public.community_posts add column if not exists comments_locked  boolean not null default false;
alter table public.community_posts add column if not exists comment_count    int not null default 0;
alter table public.community_posts add column if not exists last_activity_at timestamptz not null default now();

create table if not exists public.community_comments (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references public.community_posts(id) on delete cascade,
  author_id         uuid not null references public.profiles(id) on delete cascade,
  author_name       text not null,
  author_avatar_url text,
  body              text not null check (char_length(body) between 1 and 2000),
  status            text not null default 'active' check (status in ('active','hidden','deleted')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.community_comments add column if not exists author_avatar_url text;

-- Backfills — converge #23-era data (fresh installs have no rows; safe to
-- re-run: on a re-run the posts guard already exists but its freeze exempts
-- no-JWT SQL like this script, so the counter writes land).
update public.community_posts p
   set comment_count = (select count(*) from public.community_comments c
                         where c.post_id = p.id and c.status = 'active'),
       last_activity_at = greatest(
         p.created_at,
         coalesce((select max(c.created_at) from public.community_comments c
                    where c.post_id = p.id and c.status = 'active'), p.created_at));

update public.community_posts set comments_locked = true
 where tag_slug in (select slug from public.community_tags where admin_only)
   and comments_locked = false;

update public.community_posts p
   set author_avatar_url = pr.avatar_url
  from public.profiles pr
 where pr.id = p.author_id and p.author_avatar_url is null and pr.avatar_url is not null;

update public.community_comments c
   set author_avatar_url = pr.avatar_url
  from public.profiles pr
 where pr.id = c.author_id and c.author_avatar_url is null and pr.avatar_url is not null;

-- Reactions target EITHER a post OR a comment (XOR check). The UNIQUE on
-- (post_id, user_id, reaction_type) guards post reactions (NULLs are distinct);
-- the partial unique index guards comment reactions and serves their lookups.
create table if not exists public.community_reactions (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid references public.community_posts(id) on delete cascade,
  comment_id    uuid references public.community_comments(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('like','celebrate','helpful')),
  created_at    timestamptz not null default now(),
  unique (post_id, user_id, reaction_type),
  constraint community_reactions_target_xor check ((post_id is null) <> (comment_id is null))
);

alter table public.community_reactions alter column post_id drop not null;
alter table public.community_reactions add column if not exists comment_id uuid references public.community_comments(id) on delete cascade;

do $$
begin
  alter table public.community_reactions
    add constraint community_reactions_target_xor check ((post_id is null) <> (comment_id is null));
exception when duplicate_object then null;
end $$;

create unique index if not exists community_reactions_comment_uniq
  on public.community_reactions (comment_id, user_id, reaction_type)
  where comment_id is not null;

-- Server-stamped author identity: author_name + author_avatar_url are
-- overwritten from the author's own profiles row on INSERT (SECURITY DEFINER —
-- profiles RLS is closed to members). On UPDATE the name is frozen but the
-- avatar is RE-STAMPED from profiles (freezing it would silently revert
-- set_my_avatar()'s denorm backfill; re-stamping also means a forged client
-- value never sticks), so a direct API call can't impersonate anyone.
create or replace function public.community_stamp_author()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members (comments feed the parent's
    -- last_activity_at rollup — a forged date would top the feed forever).
    if not public.is_admin() then
      new.created_at := now();
    end if;
    select coalesce(nullif(trim(p.full_name), ''), p.email, 'Member'), p.avatar_url
      into new.author_name, new.author_avatar_url
      from public.profiles p where p.id = new.author_id;
    new.author_name := coalesce(new.author_name, 'Member');
  else
    new.created_at  := old.created_at;   -- immutable after insert
    new.author_name := old.author_name;  -- immutable after insert
    -- Re-stamp (never freeze) the avatar: profiles.avatar_url is the source
    -- of truth and its only user-facing writer is set_my_avatar().
    select p.avatar_url into new.author_avatar_url
      from public.profiles p where p.id = old.author_id;
  end if;
  return new;
end;
$$;

revoke all on function public.community_stamp_author() from public;

drop trigger if exists community_posts_stamp_author on public.community_posts;
create trigger community_posts_stamp_author
  before insert or update on public.community_posts
  for each row execute function public.community_stamp_author();

drop trigger if exists community_comments_stamp_author on public.community_comments;
create trigger community_comments_stamp_author
  before insert or update on public.community_comments
  for each row execute function public.community_stamp_author();

-- community_posts_guard(): column-level protection RLS can't give. On INSERT
-- counters start clean, non-admins can't pin, and admin-only categories
-- (Announcements) are born comments_locked. On UPDATE the freeze applies only
-- to CLIENT-originated writes — trigger-originated ones (the comment rollup
-- runs at pg_trigger_depth() 2) and no-JWT SQL (SQL editor / service role →
-- auth.uid() is null) must pass, or counter maintenance and the backfills
-- below would be silently reverted. Within the frozen path a non-admin can't
-- flip pinned/comments_locked, and counters stay trigger-owned even for admins.
create or replace function public.community_posts_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members: a client-forged future date
    -- would launder into last_activity_at below and self-pin the post
    -- above the whole activity-sorted feed.
    if not public.is_admin() then
      new.created_at := now();
    end if;
    new.comment_count    := 0;
    new.last_activity_at := coalesce(new.created_at, now());
    if not public.is_admin() then
      new.pinned := false;
    end if;
    if exists (select 1 from public.community_tags t
                where t.slug = new.tag_slug and t.admin_only) then
      new.comments_locked := true;
    elsif not public.is_admin() then
      new.comments_locked := false;
    end if;
  else
    -- Freeze only client-originated updates (see comment above).
    if pg_trigger_depth() <= 1 and auth.uid() is not null then
      if not public.is_admin() then
        new.pinned           := old.pinned;
        new.comments_locked  := old.comments_locked;
      end if;
      new.comment_count    := old.comment_count;
      new.last_activity_at := old.last_activity_at;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.community_posts_guard() from public;

drop trigger if exists community_posts_guard on public.community_posts;
create trigger community_posts_guard
  before insert or update on public.community_posts
  for each row execute function public.community_posts_guard();

-- community_comment_rollup(): recomputes the parent post's active
-- comment_count (self-healing across hide/restore/soft-delete/hard-delete)
-- and advances last_activity_at when a new comment lands. SECURITY DEFINER:
-- the commenting member has no UPDATE policy on someone else's post row.
create or replace function public.community_comment_rollup()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_post uuid := coalesce(new.post_id, old.post_id);
begin
  update public.community_posts p
     set comment_count = (select count(*) from public.community_comments c
                           where c.post_id = v_post and c.status = 'active'),
         last_activity_at = greatest(
           p.last_activity_at,
           coalesce((select max(c.created_at) from public.community_comments c
                      where c.post_id = v_post and c.status = 'active'), p.created_at))
   where p.id = v_post;
  return coalesce(new, old);
end;
$$;

revoke all on function public.community_comment_rollup() from public;

drop trigger if exists community_comments_rollup on public.community_comments;
create trigger community_comments_rollup
  after insert or update of status or delete on public.community_comments
  for each row execute function public.community_comment_rollup();

-- community_notifications — reply/mention fan-out. Rows are written ONLY by
-- the SECURITY DEFINER notify triggers (table owner bypasses RLS; there is no
-- insert policy — a client can never forge a notification for another member).
-- actor_* / post_title are denormalized so the bell renders with zero joins.
create table if not exists public.community_notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,  -- recipient
  kind             text not null check (kind in ('mention','reply')),
  actor_id         uuid references public.profiles(id) on delete set null,
  actor_name       text not null,
  actor_avatar_url text,
  post_id          uuid references public.community_posts(id) on delete cascade,
  comment_id       uuid references public.community_comments(id) on delete cascade,
  post_title       text,
  read_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists community_notifications_user_idx
  on public.community_notifications (user_id, read_at, created_at desc);

-- community_announcement_reads — per-user "seen it" marker for announcement
-- posts (unread = announcements minus these rows; no per-member fan-out).
create table if not exists public.community_announcement_reads (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  post_id  uuid not null references public.community_posts(id) on delete cascade,
  read_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);

-- community_attachments — images/videos (private community-media bucket) and
-- external links, per post. Metadata only; the file itself is guarded by the
-- bucket policies in §5. Members attach only to their OWN posts.
create table if not exists public.community_attachments (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.community_posts(id) on delete cascade,
  uploader_id  uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('image','video','link')),
  storage_path text,
  url          text,
  file_name    text,
  mime_type    text,
  file_size    bigint,
  position     int not null default 0,
  created_at   timestamptz not null default now(),
  check ((kind = 'link') = (url is not null)),
  check ((kind = 'link') = (storage_path is null))
);

create index if not exists community_attachments_post_idx
  on public.community_attachments (post_id);

-- community_post_tags — free-form tags beside the fixed category. Normalized
-- slugs, no lookup table; ≤5 per post enforced client-side, shape enforced here.
create table if not exists public.community_post_tags (
  post_id uuid not null references public.community_posts(id) on delete cascade,
  tag     text not null check (char_length(tag) between 1 and 24 and tag ~ '^[a-z0-9][a-z0-9-]*$'),
  primary key (post_id, tag)
);

create index if not exists community_post_tags_tag_idx
  on public.community_post_tags (tag);

-- Mention parsing + notification fan-out. Mentions travel in the body as
-- @[Display Name](uuid) markup; parsing happens HERE, server-side, so a client
-- can only ever notify members whose uuids genuinely appear in its own stored
-- content. Cap 10 per row; self-mentions and unknown uuids are skipped.
create or replace function public.community_notify_on_comment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_name   text;
  v_actor_avatar text;
  v_post         record;
  v_title        text;
  v_done         uuid[] := array[]::uuid[];
  v_uid          uuid;
  m              text;
begin
  if new.status <> 'active' then return new; end if;
  select p.author_id, p.title, p.body into v_post
    from public.community_posts p where p.id = new.post_id;
  if v_post.author_id is null then return new; end if;
  select coalesce(nullif(trim(pr.full_name), ''), pr.email, 'Member'), pr.avatar_url
    into v_actor_name, v_actor_avatar
    from public.profiles pr where pr.id = new.author_id;
  v_title := left(coalesce(nullif(trim(v_post.title), ''), v_post.body), 120);

  for m in select (regexp_matches(new.body, '@\[[^\]]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g'))[1] loop
    exit when coalesce(array_length(v_done, 1), 0) >= 10;
    begin
      v_uid := m::uuid;
    exception when others then
      continue;
    end;
    if v_uid <> new.author_id
       and not (v_uid = any(v_done))
       -- Target must be MENTIONABLE (the search_community_members bar:
       -- named + approved-or-admin) — never an arbitrary/blocked uuid.
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       -- Collapse repeats: at most one UNREAD entry per actor/post/kind —
       -- this also caps the flood a scripted commenter could generate.
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.post_id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, comment_id, post_title)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar, new.post_id, new.id, v_title);
    end if;
  end loop;

  if v_post.author_id <> new.author_id and not (v_post.author_id = any(v_done))
     and not exists (select 1 from public.community_notifications n
                      where n.user_id = v_post.author_id and n.actor_id = new.author_id
                        and n.post_id = new.post_id and n.kind = 'reply'
                        and n.read_at is null) then
    insert into public.community_notifications
      (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, comment_id, post_title)
    values (v_post.author_id, 'reply', new.author_id, v_actor_name, v_actor_avatar, new.post_id, new.id, v_title);
  end if;
  return new;
end;
$$;

revoke all on function public.community_notify_on_comment() from public;

drop trigger if exists community_comments_notify on public.community_comments;
create trigger community_comments_notify
  after insert on public.community_comments
  for each row execute function public.community_notify_on_comment();

create or replace function public.community_notify_on_post()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_name   text;
  v_actor_avatar text;
  v_title        text;
  v_done         uuid[] := array[]::uuid[];
  v_uid          uuid;
  m              text;
begin
  if new.status <> 'active' then return new; end if;
  select coalesce(nullif(trim(pr.full_name), ''), pr.email, 'Member'), pr.avatar_url
    into v_actor_name, v_actor_avatar
    from public.profiles pr where pr.id = new.author_id;
  v_title := left(coalesce(nullif(trim(new.title), ''), new.body), 120);

  for m in select (regexp_matches(new.body, '@\[[^\]]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g'))[1] loop
    exit when coalesce(array_length(v_done, 1), 0) >= 10;
    begin
      v_uid := m::uuid;
    exception when others then
      continue;
    end;
    if v_uid <> new.author_id
       and not (v_uid = any(v_done))
       -- Same mentionable-target + unread-collapse rules as the comment
       -- trigger above.
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, post_title)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar, new.id, v_title);
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.community_notify_on_post() from public;

drop trigger if exists community_posts_notify on public.community_posts;
create trigger community_posts_notify
  after insert on public.community_posts
  for each row execute function public.community_notify_on_post();

-- set_my_avatar(): the ONE sanctioned user-facing profiles write (profiles has
-- NO user UPDATE policy — an open row policy would expose is_paid/plan). Own
-- row, avatar_url only, path pinned to the caller's own avatars/<uid>/ folder;
-- also refreshes the caller's denormalized author_avatar_url.
create or replace function public.set_my_avatar(p_path text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  -- Same eligibility as every community write: a rejected/expired account
  -- keeps no write path into profiles or the public avatars denorms.
  if not (public.is_admin() or (public.is_approved() and public.is_enrolled())) then
    raise exception 'Not allowed.';
  end if;
  if p_path is not null and p_path !~ ('^' || v_uid::text || '/[A-Za-z0-9._-]{1,120}$') then
    raise exception 'Invalid avatar path.';
  end if;
  update public.profiles set avatar_url = p_path where id = v_uid;
  update public.community_posts    set author_avatar_url = p_path where author_id = v_uid;
  update public.community_comments set author_avatar_url = p_path where author_id = v_uid;
end;
$$;

revoke all on function public.set_my_avatar(text) from public;
grant execute on function public.set_my_avatar(text) to authenticated;

-- search_community_members(): mention-autocomplete directory. SECURITY DEFINER
-- because members can't read other profiles rows. Returns display name +
-- avatar ONLY — never email (nameless profiles simply aren't mentionable).
create or replace function public.search_community_members(p_query text)
returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public
as $$
  select p.id, trim(p.full_name) as display_name, p.avatar_url
    from public.profiles p
   where ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and nullif(trim(p.full_name), '') is not null
     and (p.approval_status = 'approved' or p.is_admin)
     and p.full_name ilike '%' || coalesce(p_query, '') || '%'
   order by trim(p.full_name)
   limit 8;
$$;

revoke all on function public.search_community_members(text) from public;
grant execute on function public.search_community_members(text) to authenticated;

-- community_category_counts() (#25): server-side GROUP BY for the sidebar counts
-- (SECURITY INVOKER — community_posts_read RLS scopes the caller) instead of the
-- client streaming every active post's tag_slug.
create or replace function public.community_category_counts()
returns table (tag_slug text, n bigint)
language sql stable set search_path = public
as $$
  select p.tag_slug, count(*)::bigint
    from public.community_posts p
   where p.status = 'active'
   group by p.tag_slug;
$$;

revoke all on function public.community_category_counts() from public;
grant execute on function public.community_category_counts() to authenticated;

-- Trigram index (#25) so search_community_members()'s full_name ILIKE '%q%'
-- (leading wildcard) is index-assisted instead of a full profiles scan per keystroke.
create extension if not exists pg_trgm;
create index if not exists profiles_full_name_trgm
  on public.profiles using gin (full_name gin_trgm_ops);

create index if not exists community_posts_feed_idx    on public.community_posts (status, created_at desc);
create index if not exists community_posts_tag_idx     on public.community_posts (tag_slug, created_at desc);
create index if not exists community_posts_forum_idx   on public.community_posts (status, pinned desc, last_activity_at desc);
create index if not exists community_comments_post_idx on public.community_comments (post_id, created_at);

alter table public.community_tags               enable row level security;
alter table public.community_posts              enable row level security;
alter table public.community_comments           enable row level security;
alter table public.community_reactions          enable row level security;
alter table public.community_notifications      enable row level security;
alter table public.community_announcement_reads enable row level security;
alter table public.community_attachments        enable row level security;
alter table public.community_post_tags          enable row level security;

drop policy if exists community_tags_read on public.community_tags;
create policy community_tags_read on public.community_tags
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())));

drop policy if exists community_tags_admin_all on public.community_tags;
create policy community_tags_admin_all on public.community_tags
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists community_posts_read on public.community_posts;
create policy community_posts_read on public.community_posts
  for select to authenticated
  using ((select public.is_admin())
      or (status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())));

drop policy if exists community_posts_own_insert on public.community_posts;
create policy community_posts_own_insert on public.community_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and (select public.is_approved()) and (select public.is_enrolled())
    and not exists (select 1 from public.community_tags t
                    where t.slug = tag_slug and t.admin_only)
  );

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

drop policy if exists community_posts_admin_all on public.community_posts;
create policy community_posts_admin_all on public.community_posts
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Member comment reads/inserts also require the PARENT POST to be active, so
-- hiding a post hides its whole thread and freezes new replies.
drop policy if exists community_comments_read on public.community_comments;
create policy community_comments_read on public.community_comments
  for select to authenticated
  using ((select public.is_admin())
      or (status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

-- Member comment INSERTs refuse comments_locked parents server-side (the
-- client only hides the composer): announcements and admin-locked threads
-- can't be replied to via direct REST. Admins pass via admin_all below.
drop policy if exists community_comments_own_insert on public.community_comments;
create policy community_comments_own_insert on public.community_comments
  for insert to authenticated
  with check (author_id = (select auth.uid())
          and status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active'
                        and not p.comments_locked));

drop policy if exists community_comments_own_update on public.community_comments;
create policy community_comments_own_update on public.community_comments
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))))
  with check (author_id = (select auth.uid()) and status in ('active','deleted')
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_comments_admin_all on public.community_comments;
create policy community_comments_admin_all on public.community_comments
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Read carries the same parent-active guard as its sibling read policies (#25), so
-- hiding a post also hides who reacted to it + its comments. Admins read everything.
drop policy if exists community_reactions_read on public.community_reactions;
create policy community_reactions_read on public.community_reactions
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and ((post_id is not null
                and exists (select 1 from public.community_posts p
                            where p.id = post_id and p.status = 'active'))
            or (comment_id is not null
                and exists (select 1 from public.community_comments c
                            join public.community_posts p on p.id = c.post_id
                            where c.id = comment_id and c.status = 'active'
                              and p.status = 'active')))));

-- Reactions may target a post OR a comment; either way the target (and, for a
-- comment, its parent post) must be active. Reactions stay allowed on
-- comments_locked posts — announcements are react-only by design.
drop policy if exists community_reactions_own_insert on public.community_reactions;
create policy community_reactions_own_insert on public.community_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and ((post_id is not null
                and exists (select 1 from public.community_posts p
                            where p.id = post_id and p.status = 'active'))
            or (comment_id is not null
                and exists (select 1 from public.community_comments c
                            join public.community_posts p on p.id = c.post_id
                            where c.id = comment_id and c.status = 'active'
                              and p.status = 'active'))));

drop policy if exists community_reactions_own_delete on public.community_reactions;
create policy community_reactions_own_delete on public.community_reactions
  for delete to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_reactions_admin_all on public.community_reactions;
create policy community_reactions_admin_all on public.community_reactions
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Notifications: recipients read + mark-read their own rows. No insert/delete
-- policies — rows are written only by the SECURITY DEFINER notify triggers.
-- Own rows AND an active membership — expired members are fully blocked,
-- notification titles/actors included (the house "reads included" rule).
drop policy if exists community_notifications_own_select on public.community_notifications;
create policy community_notifications_own_select on public.community_notifications
  for select to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_notifications_own_update on public.community_notifications;
create policy community_notifications_own_update on public.community_notifications
  for update to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))))
  with check (user_id = (select auth.uid()));

-- Announcement reads: insert-only own rows.
drop policy if exists community_announcement_reads_own_select on public.community_announcement_reads;
create policy community_announcement_reads_own_select on public.community_announcement_reads
  for select to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_announcement_reads_own_insert on public.community_announcement_reads;
create policy community_announcement_reads_own_insert on public.community_announcement_reads
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and ((select public.is_admin())
            or ((select public.is_approved()) and (select public.is_enrolled()))));

-- Attachments: visible with the parent post; members attach only to their own
-- posts; delete own-or-admin.
drop policy if exists community_attachments_read on public.community_attachments;
create policy community_attachments_read on public.community_attachments
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

drop policy if exists community_attachments_own_insert on public.community_attachments;
create policy community_attachments_own_insert on public.community_attachments
  for insert to authenticated
  with check (uploader_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.author_id = (select auth.uid())));

drop policy if exists community_attachments_own_delete on public.community_attachments;
create policy community_attachments_own_delete on public.community_attachments
  for delete to authenticated
  using (uploader_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists community_attachments_admin_all on public.community_attachments;
create policy community_attachments_admin_all on public.community_attachments
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Free-form post tags: visible with the parent post; managed by the post author.
drop policy if exists community_post_tags_read on public.community_post_tags;
create policy community_post_tags_read on public.community_post_tags
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

drop policy if exists community_post_tags_own_insert on public.community_post_tags;
create policy community_post_tags_own_insert on public.community_post_tags
  for insert to authenticated
  with check ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.author_id = (select auth.uid())));

drop policy if exists community_post_tags_own_delete on public.community_post_tags;
create policy community_post_tags_own_delete on public.community_post_tags
  for delete to authenticated
  using (((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())));

drop policy if exists community_post_tags_admin_all on public.community_post_tags;
create policy community_post_tags_admin_all on public.community_post_tags
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Storage policies deferred from §5/§14b (they need is_approved()/is_enrolled()
-- from §13 and the community tables above).

-- avatars bucket writes: own folder + an ACTIVE membership — a rejected/
-- expired account must not keep free public-bucket hosting. (Read stays
-- public in §5 — the bucket is public by design.)
drop policy if exists avatars_own_insert on storage.objects;
create policy avatars_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
          and ((select public.is_admin())
            or ((storage.foldername(name))[1] = (select auth.uid())::text
                and (select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists avatars_own_update on storage.objects;
create policy avatars_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars'
     and ((select public.is_admin())
       or ((storage.foldername(name))[1] = (select auth.uid())::text
           and (select public.is_approved()) and (select public.is_enrolled()))));

drop policy if exists avatars_own_delete on storage.objects;
create policy avatars_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars'
     and ((select public.is_admin())
       or ((storage.foldername(name))[1] = (select auth.uid())::text
           and (select public.is_approved()) and (select public.is_enrolled()))));

-- Serves the storage read policy's path lookup below.
create index if not exists community_attachments_path_idx
  on public.community_attachments (storage_path);

-- community-media read: member access is scoped to files attached to an
-- ACTIVE post — hiding a post also revokes signed-URL access to its media
-- (moderation must bite on image/video content, not just the row).
drop policy if exists community_media_read on storage.objects;
create policy community_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'community-media'
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_attachments a
                      join public.community_posts p on p.id = a.post_id
                      where a.storage_path = name and p.status = 'active'))));

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
    if not exists (select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='community_posts') then
      alter publication supabase_realtime add table public.community_posts;
    end if;
    if not exists (select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='community_comments') then
      alter publication supabase_realtime add table public.community_comments;
    end if;
    if not exists (select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='community_notifications') then
      alter publication supabase_realtime add table public.community_notifications;
    end if;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- §16) STUDENT IMPORT (Thinkific migration, #26). Admin-only staging + provenance.
--   subscriptions.grant_source/source_import_row_id (+ partial unique index) and the
--   profiles onboarding columns are folded in here (add-if-not-exists over the base
--   tables defined earlier). Import terms are granted by the admin-verified service-
--   role endpoint api/admin/student-imports.js — NOT a SECURITY DEFINER RPC.
-- ───────────────────────────────────────────────────────────────────

-- subscriptions provenance + one-grant-per-import-row idempotency (non-breaking:
-- approve_subscription()/approve_extension() leave these at defaults, so the PARTIAL
-- index never covers a payment/extension grant).
alter table public.subscriptions add column if not exists grant_source text not null default 'payment';
alter table public.subscriptions add column if not exists source_import_row_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_grant_source_check') then
    alter table public.subscriptions add constraint subscriptions_grant_source_check
      check (grant_source in ('payment', 'import', 'extension'));
  end if;
end $$;
create unique index if not exists subscriptions_one_import_grant
  on public.subscriptions (source_import_row_id) where source_import_row_id is not null;

-- profiles onboarding fields (read by the forced set-password gate).
alter table public.profiles add column if not exists account_origin text not null default 'signup';
alter table public.profiles add column if not exists onboarding_status text not null default 'none';
alter table public.profiles add column if not exists invited_at timestamptz;
alter table public.profiles add column if not exists onboarding_completed_at timestamptz;

create table if not exists public.student_import_jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'thinkific_users'
    check (source in ('thinkific_users','thinkific_orders','ledger','manual')),
  filename text, file_sha256 text,
  mapping jsonb not null default '{}'::jsonb, settings jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','validating','dry_run','ready','processing','paused','completed','failed')),
  total_rows int not null default 0, counts jsonb not null default '{}'::jsonb, cursor int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), purged_at timestamptz
);
create index if not exists student_import_jobs_creator on public.student_import_jobs (created_by, created_at desc);
alter table public.student_import_jobs enable row level security;
drop policy if exists student_import_jobs_admin_all on public.student_import_jobs;
create policy student_import_jobs_admin_all on public.student_import_jobs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.student_import_rows (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.student_import_jobs(id) on delete cascade,
  source_row_number int not null, mapped jsonb not null default '{}'::jsonb,
  external_user_id text, email_normalized text, email_display text,
  proposed_plan_key text, proposed_started_at timestamptz, proposed_ends_at timestamptz,
  proposed_term_mode text check (proposed_term_mode is null or proposed_term_mode in
    ('preserve','fresh','expired_history','lifetime','profile_only')),
  match_result text check (match_result is null or match_result in
    ('new','existing_by_source','existing_by_email','conflict','ambiguous')),
  intended_action text check (intended_action is null or intended_action in
    ('create_invite','merge_grant','profile_only','skip','manual_review')),
  target_user_id uuid references public.profiles(id) on delete set null,
  warnings jsonb not null default '[]'::jsonb, errors jsonb not null default '[]'::jsonb,
  processing_status text not null default 'pending'
    check (processing_status in ('blocked','ready','pending','processing','done','failed','skipped')),
  invite_status text not null default 'not_sent' check (invite_status in ('not_sent','sent','failed','resent')),
  attempts int not null default 0, auth_user_created boolean not null default false,
  subscription_granted boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (job_id, source_row_number)
);
create index if not exists student_import_rows_job_status on public.student_import_rows (job_id, processing_status);
create index if not exists student_import_rows_job_extid on public.student_import_rows (job_id, external_user_id);
alter table public.student_import_rows enable row level security;
drop policy if exists student_import_rows_admin_all on public.student_import_rows;
create policy student_import_rows_admin_all on public.student_import_rows
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.student_external_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null default 'thinkific', external_user_id text not null,
  source_created_at timestamptz, last_sign_in_at timestamptz, sign_in_count int,
  legacy_enrollments jsonb not null default '[]'::jsonb,
  import_job_id uuid references public.student_import_jobs(id) on delete set null,
  import_row_id uuid references public.student_import_rows(id) on delete set null,
  created_at timestamptz not null default now(),
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

create table if not exists public.student_import_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.student_import_jobs(id) on delete cascade,
  row_id uuid references public.student_import_rows(id) on delete set null,
  kind text not null, status text, detail jsonb not null default '{}'::jsonb,
  actor uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists student_import_events_job on public.student_import_events (job_id, created_at desc);
alter table public.student_import_events enable row level security;
-- Immutable audit: admin select + insert only; NO update/delete policy.
drop policy if exists student_import_events_admin_select on public.student_import_events;
create policy student_import_events_admin_select on public.student_import_events
  for select to authenticated using (public.is_admin());
drop policy if exists student_import_events_admin_insert on public.student_import_events;
create policy student_import_events_admin_insert on public.student_import_events
  for insert to authenticated with check (public.is_admin());

-- The ONE narrow user-facing profiles write for imported students (own row, onboarding
-- fields only) — mirrors set_my_avatar(); there is still no broad user-update RLS.
create or replace function public.complete_import_onboarding()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set onboarding_status = 'completed', onboarding_completed_at = now()
   where id = auth.uid() and account_origin = 'import' and onboarding_status <> 'completed';
end;
$$;
revoke all on function public.complete_import_onboarding() from public;
grant execute on function public.complete_import_onboarding() to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 16b) AI COURSE TRAINER (#27) — entitlement-aware voice-trainer knowledge base.
-- Derived teaching sources → bounded chunks (pgvector 384 + FTS fallback), the
-- async index-job queue, per-user AI checkpoints + durable usage counters, and
-- the SERVICE-ROLE-ONLY parameterized entitlement/retrieval functions consumed
-- by api/elevenlabs/trainer.js / api/admin/course-trainer.js. The functions
-- MIRROR the §14 courses_read policy — keep them in lockstep. Learners have NO
-- RLS path to sources/chunks/jobs; retrieval happens server-side AFTER
-- authorization. See db/2026-07-24-course-ai-trainer.sql + COURSE_AI_TRAINER_SETUP.md.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.course_ai_sources (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses(id) on delete cascade,
  lesson_id         uuid references public.course_lessons(id) on delete cascade,
  kind              text not null check (kind in ('lesson_text','transcript','trainer_notes')),
  status            text not null default 'pending'
                    check (status in ('pending','processing','ready','failed','stale')),
  included          boolean not null default true,
  title             text,
  content           text,
  content_hash      text,
  source_version    integer not null default 1,
  transcript_origin text check (transcript_origin in ('scribe','manual')),
  language_code     text,
  error_detail      text,          -- safe codes/messages only — NEVER lesson content
  transcribed_at    timestamptz,
  indexed_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists course_ai_sources_lesson_kind
  on public.course_ai_sources (lesson_id, kind) where lesson_id is not null;
create unique index if not exists course_ai_sources_course_notes
  on public.course_ai_sources (course_id, kind) where lesson_id is null;
create index if not exists course_ai_sources_course_idx
  on public.course_ai_sources (course_id, status);

create table if not exists public.course_ai_chunks (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid not null references public.course_ai_sources(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  lesson_id      uuid,
  module_title   text,
  lesson_title   text,
  chunk_index    integer not null,
  content        text not null,
  content_hash   text not null,
  source_version integer not null,
  embedding      extensions.vector(384),
  fts            tsvector generated always as (to_tsvector('english', coalesce(content, ''))) stored,
  created_at     timestamptz not null default now(),
  unique (source_id, source_version, chunk_index)
);
create index if not exists course_ai_chunks_embedding_idx
  on public.course_ai_chunks using hnsw (embedding extensions.vector_ip_ops);
create index if not exists course_ai_chunks_fts_idx
  on public.course_ai_chunks using gin (fts);
create index if not exists course_ai_chunks_course_idx
  on public.course_ai_chunks (course_id);
create index if not exists course_ai_chunks_source_idx
  on public.course_ai_chunks (source_id);
create index if not exists course_ai_chunks_lesson_idx
  on public.course_ai_chunks (lesson_id);

create table if not exists public.course_ai_index_jobs (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses(id) on delete cascade,
  source_id    uuid references public.course_ai_sources(id) on delete cascade,
  kind         text not null check (kind in ('index','transcribe')),
  status       text not null default 'queued'
               check (status in ('queued','processing','done','failed')),
  attempts     integer not null default 0,
  max_attempts integer not null default 3,
  error_detail text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists course_ai_index_jobs_course_idx
  on public.course_ai_index_jobs (course_id, status);

create table if not exists public.ai_training_checkpoints (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  course_id     uuid not null references public.courses(id) on delete cascade,
  lesson_id     uuid references public.course_lessons(id) on delete set null,
  topic         text check (char_length(topic) <= 200),
  mode          text check (mode in ('explain','guided','quiz','practice','recap')),
  understanding text check (char_length(understanding) <= 400),
  next_step     text check (char_length(next_step) <= 400),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, course_id)
);
create index if not exists ai_training_checkpoints_user_idx
  on public.ai_training_checkpoints (user_id, updated_at desc);

create table if not exists public.ai_training_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  tool    text not null,
  calls   integer not null default 0,
  primary key (user_id, day, tool)
);

alter table public.course_ai_sources       enable row level security;
alter table public.course_ai_chunks        enable row level security;
alter table public.course_ai_index_jobs    enable row level security;
alter table public.ai_training_checkpoints enable row level security;
alter table public.ai_training_usage       enable row level security;

drop policy if exists course_ai_sources_admin_all on public.course_ai_sources;
create policy course_ai_sources_admin_all on public.course_ai_sources
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists course_ai_chunks_admin_read on public.course_ai_chunks;
create policy course_ai_chunks_admin_read on public.course_ai_chunks
  for select to authenticated using (public.is_admin());
-- (no insert/update/delete policies on chunks — service role only)

drop policy if exists course_ai_index_jobs_admin_all on public.course_ai_index_jobs;
create policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists ai_training_checkpoints_own_read on public.ai_training_checkpoints;
create policy ai_training_checkpoints_own_read on public.ai_training_checkpoints
  for select to authenticated using (user_id = auth.uid());
-- (writes go through the service path only — no authenticated write policy)

drop policy if exists ai_training_usage_admin_read on public.ai_training_usage;
create policy ai_training_usage_admin_read on public.ai_training_usage
  for select to authenticated using (public.is_admin());

-- Parameterized entitlement helpers (the auth.uid() helpers can't serve the
-- webhook — the service role has auth.uid() = NULL). MIRROR is_enrolled()/
-- is_approved()/current_plan_key() EXACTLY. SERVICE-ROLE-ONLY (revoked below).
create or replace function public.user_is_enrolled(p_user uuid)
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
    from public.profiles p where p.id = p_user), false)
$$;

create or replace function public.user_is_approved(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select approval_status = 'approved' or is_admin
    from public.profiles where id = p_user), false)
$$;

create or replace function public.user_plan_key(p_user uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select s.plan_key
  from public.subscriptions s
  where s.user_id = p_user
    and s.status = 'active'
    and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
  order by s.created_at desc
  limit 1
$$;

-- THE course-authorization source of truth for the trainer. MIRRORS the §14
-- courses_read policy PLUS ai_trainer_enabled. Drift here is a security bug.
create or replace function public.trainer_visible_courses(p_user uuid)
returns table (id uuid, slug text, title text, access_tier text)
language sql stable security definer set search_path = public
as $$
  select c.id, c.slug, c.title, c.access_tier
  from public.courses c
  where c.ai_trainer_enabled = true
    and (
      coalesce((select p.is_admin from public.profiles p where p.id = p_user), false)
      or (c.published = true
          and public.user_is_approved(p_user)
          and public.user_is_enrolled(p_user)
          and (not coalesce(public.user_plan_key(p_user) = 'core_self_paced', false) or c.slug like 'qbo-%')
          and (not coalesce(public.user_plan_key(p_user) = 'sampler', false)
               or (c.slug like 'qbo-%' and c.access_tier = 'essentials')))
    )
$$;

create or replace function public.trainer_courses_for_plan(p_plan_key text)
returns table (id uuid, slug text, title text, access_tier text)
language sql stable security definer set search_path = public
as $$
  select c.id, c.slug, c.title, c.access_tier
  from public.courses c
  where c.ai_trainer_enabled = true and c.published = true
    and (not coalesce(p_plan_key = 'core_self_paced', false) or c.slug like 'qbo-%')
    and (not coalesce(p_plan_key = 'sampler', false)
         or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
$$;

-- Retrieval functions. The join conditions ARE the immediate-unretrievability
-- guarantee: published + ai_trainer_enabled + ready + included + version match
-- + plan scope, re-evaluated on every call.
create or replace function public.trainer_match_chunks(
  p_user       uuid,
  p_course_ids uuid[],
  p_query      extensions.vector(384),
  p_limit      integer default 6,
  p_min_score  double precision default 0.30
)
returns table (chunk_id uuid, course_id uuid, lesson_id uuid, course_title text,
               module_title text, lesson_title text, content text, score double precision)
language sql stable security definer set search_path = public
as $$
  select ch.id, ch.course_id, ch.lesson_id, c.title, ch.module_title, ch.lesson_title,
         ch.content, -(ch.embedding operator(extensions.<#>) p_query) as score
  from public.course_ai_chunks ch
  join public.course_ai_sources s
    on s.id = ch.source_id
   and s.status = 'ready' and s.included = true
   and ch.source_version = s.source_version
  join public.courses c
    on c.id = ch.course_id and c.published = true and c.ai_trainer_enabled = true
  where ch.course_id = any (p_course_ids)
    and ch.course_id in (select tv.id from public.trainer_visible_courses(p_user) tv)
    and ch.embedding is not null
    and -(ch.embedding operator(extensions.<#>) p_query) >= p_min_score
  order by ch.embedding operator(extensions.<#>) p_query
  limit least(greatest(coalesce(p_limit, 6), 1), 12)
$$;

create or replace function public.trainer_match_chunks_fts(
  p_user       uuid,
  p_course_ids uuid[],
  p_query      text,
  p_limit      integer default 6
)
returns table (chunk_id uuid, course_id uuid, lesson_id uuid, course_title text,
               module_title text, lesson_title text, content text, score double precision)
language sql stable security definer set search_path = public
as $$
  select ch.id, ch.course_id, ch.lesson_id, c.title, ch.module_title, ch.lesson_title,
         ch.content, ts_rank(ch.fts, websearch_to_tsquery('english', p_query))::double precision
  from public.course_ai_chunks ch
  join public.course_ai_sources s
    on s.id = ch.source_id
   and s.status = 'ready' and s.included = true
   and ch.source_version = s.source_version
  join public.courses c
    on c.id = ch.course_id and c.published = true and c.ai_trainer_enabled = true
  where ch.course_id = any (p_course_ids)
    and ch.course_id in (select tv.id from public.trainer_visible_courses(p_user) tv)
    and ch.fts @@ websearch_to_tsquery('english', p_query)
  order by ts_rank(ch.fts, websearch_to_tsquery('english', p_query)) desc
  limit least(greatest(coalesce(p_limit, 6), 1), 12)
$$;

create or replace function public.trainer_lesson_chunks(
  p_user      uuid,
  p_course_id uuid,
  p_lesson_id uuid,
  p_limit     integer default 8
)
returns table (chunk_id uuid, course_id uuid, lesson_id uuid, course_title text,
               module_title text, lesson_title text, content text, chunk_index integer)
language sql stable security definer set search_path = public
as $$
  select ch.id, ch.course_id, ch.lesson_id, c.title, ch.module_title, ch.lesson_title,
         ch.content, ch.chunk_index
  from public.course_ai_chunks ch
  join public.course_ai_sources s
    on s.id = ch.source_id
   and s.status = 'ready' and s.included = true
   and ch.source_version = s.source_version
  join public.courses c
    on c.id = ch.course_id and c.published = true and c.ai_trainer_enabled = true
  where ch.course_id = p_course_id
    and ch.lesson_id = p_lesson_id
    and ch.course_id in (select tv.id from public.trainer_visible_courses(p_user) tv)
  order by (s.kind = 'lesson_text') desc, ch.chunk_index
  limit least(greatest(coalesce(p_limit, 8), 1), 12)
$$;

create or replace function public.trainer_preview_chunks(
  p_plan_key text,
  p_query    text,
  p_query_embedding extensions.vector(384) default null,
  p_limit    integer default 6
)
returns table (chunk_id uuid, course_id uuid, lesson_id uuid, course_title text,
               module_title text, lesson_title text, content text, score double precision)
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_query_embedding is not null then
    return query
      select ch.id, ch.course_id, ch.lesson_id, c.title, ch.module_title, ch.lesson_title,
             ch.content, -(ch.embedding operator(extensions.<#>) p_query_embedding)
      from public.course_ai_chunks ch
      join public.course_ai_sources s
        on s.id = ch.source_id
       and s.status = 'ready' and s.included = true
       and ch.source_version = s.source_version
      join public.courses c
        on c.id = ch.course_id and c.published = true and c.ai_trainer_enabled = true
      where ch.course_id in (select pv.id from public.trainer_courses_for_plan(p_plan_key) pv)
        and ch.embedding is not null
      order by ch.embedding operator(extensions.<#>) p_query_embedding
      limit least(greatest(coalesce(p_limit, 6), 1), 12);
  else
    return query
      select ch.id, ch.course_id, ch.lesson_id, c.title, ch.module_title, ch.lesson_title,
             ch.content, ts_rank(ch.fts, websearch_to_tsquery('english', p_query))::double precision
      from public.course_ai_chunks ch
      join public.course_ai_sources s
        on s.id = ch.source_id
       and s.status = 'ready' and s.included = true
       and ch.source_version = s.source_version
      join public.courses c
        on c.id = ch.course_id and c.published = true and c.ai_trainer_enabled = true
      where ch.course_id in (select pv.id from public.trainer_courses_for_plan(p_plan_key) pv)
        and ch.fts @@ websearch_to_tsquery('english', p_query)
      order by ts_rank(ch.fts, websearch_to_tsquery('english', p_query)) desc
      limit least(greatest(coalesce(p_limit, 6), 1), 12);
  end if;
end;
$$;

create or replace function public.trainer_bump_usage(p_user uuid, p_tool text)
returns integer
language sql volatile security definer set search_path = public
as $$
  insert into public.ai_training_usage (user_id, day, tool, calls)
  values (p_user, (now() at time zone 'utc')::date, p_tool, 1)
  on conflict (user_id, day, tool)
  do update set calls = public.ai_training_usage.calls + 1
  returning calls
$$;

-- Lockdown — EXECUTE defaults to PUBLIC; these revokes are load-bearing.
revoke all on function public.user_is_enrolled(uuid) from public, anon, authenticated;
revoke all on function public.user_is_approved(uuid) from public, anon, authenticated;
revoke all on function public.user_plan_key(uuid) from public, anon, authenticated;
revoke all on function public.trainer_visible_courses(uuid) from public, anon, authenticated;
revoke all on function public.trainer_courses_for_plan(text) from public, anon, authenticated;
revoke all on function public.trainer_match_chunks(uuid, uuid[], extensions.vector, integer, double precision) from public, anon, authenticated;
revoke all on function public.trainer_match_chunks_fts(uuid, uuid[], text, integer) from public, anon, authenticated;
revoke all on function public.trainer_lesson_chunks(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.trainer_preview_chunks(text, text, extensions.vector, integer) from public, anon, authenticated;
revoke all on function public.trainer_bump_usage(uuid, text) from public, anon, authenticated;

grant execute on function public.user_is_enrolled(uuid) to service_role;
grant execute on function public.user_is_approved(uuid) to service_role;
grant execute on function public.user_plan_key(uuid) to service_role;
grant execute on function public.trainer_visible_courses(uuid) to service_role;
grant execute on function public.trainer_courses_for_plan(text) to service_role;
grant execute on function public.trainer_match_chunks(uuid, uuid[], extensions.vector, integer, double precision) to service_role;
grant execute on function public.trainer_match_chunks_fts(uuid, uuid[], text, integer) to service_role;
grant execute on function public.trainer_lesson_chunks(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.trainer_preview_chunks(text, text, extensions.vector, integer) to service_role;
grant execute on function public.trainer_bump_usage(uuid, text) to service_role;

-- Stale-marking trigger — pure SQL, no network inside the write transaction.
create or replace function public.course_ai_mark_lesson_stale()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.text_content is distinct from old.text_content
     or new.title is distinct from old.title
     or new.video_url is distinct from old.video_url
     or new.storage_path is distinct from old.storage_path then
    update public.course_ai_sources
       set status = 'stale', updated_at = now()
     where lesson_id = new.id and kind = 'lesson_text' and status in ('ready','failed');
    if new.video_url is distinct from old.video_url
       or new.storage_path is distinct from old.storage_path then
      update public.course_ai_sources
         set status = 'stale', updated_at = now()
       where lesson_id = new.id and kind = 'transcript' and status = 'ready';
    end if;
    insert into public.course_ai_index_jobs (course_id, source_id, kind)
    select s.course_id, s.id, 'index'
    from public.course_ai_sources s
    where s.lesson_id = new.id and s.status = 'stale'
      and not exists (
        select 1 from public.course_ai_index_jobs j
        where j.source_id = s.id and j.kind = 'index' and j.status = 'queued');
  end if;
  return new;
end;
$$;
revoke all on function public.course_ai_mark_lesson_stale() from public;

drop trigger if exists course_ai_lessons_stale on public.course_lessons;
create trigger course_ai_lessons_stale
  after update on public.course_lessons
  for each row execute function public.course_ai_mark_lesson_stale();

-- ───────────────────────────────────────────────────────────────────
-- 17) Refresh PostgREST's schema cache.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';


-- ═════════════════════════════════════════════════════════════════════════════
-- 18) 2026-07-26 BACKEND PASS (#29 + #30 + #31) — folded verbatim.
--     The three files below are appended rather than woven into the sections
--     above so this bootstrap provably produces the same end state as the live
--     project (which ran them as increments). Each is idempotent and self-
--     guarded, so running them at the tail of a fresh install is safe:
--       • #29 db/2026-07-26-rls-initplan-and-indexes.sql — wraps the bare
--         auth/gate calls the earlier sections create, adds FK/hot-path
--         indexes, drops duplicate indexes.
--       • #30 db/2026-07-26-backend-hardening.sql — subscriptions.plan_key FK,
--         CHECK constraints, function EXECUTE hygiene, storage read-policy
--         scoping, course-media bucket limits.
--       • #31 db/2026-07-26-schema-migrations-log.sql — the apply-log table.
--     When you edit one of those files, re-fold it here (keep them identical).
-- ═════════════════════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────────────────────
-- Backend performance — RLS initplan wraps + FK/hot-path indexes (#29)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY (from the 2026-07-26 full backend audit against the live project):
--   • 42 RLS policies called auth.uid()/auth.jwt()/is_admin()/is_approved()/
--     is_enrolled()/plan_is_*() BARE in USING/WITH CHECK. Postgres re-evaluates a
--     bare call PER CANDIDATE ROW; wrapped in a scalar subquery `(select fn())` it
--     becomes a one-per-statement InitPlan. Semantics are identical (all wrapped
--     helpers are zero-arg + STABLE); only the plan changes. (The community
--     #23/#24 policies were already authored wrapped — this brings the older
--     course/enrollment/import/storage-era policies up to the same idiom.
--     `course_object_allowed(name)` is deliberately NOT wrapped: it takes a
--     per-row argument, so a subselect stays correlated and wins nothing.)
--   • 29 foreign keys had no covering index — every cascade delete (course, post,
--     profile) seq-scans the child table, and the hottest authenticated query
--     (useEnrollmentGate's latest-request read: WHERE user_id ORDER BY created_at
--     DESC LIMIT 1) had no usable index at all.
--   • 5 indexes were exact duplicates / redundant with a PK or unique constraint.
--
-- Deliberately SKIPPED indexes (documented decision, revisit at real scale):
--   • auth.users audit columns (reviewed_by/approved_by/rejected_by/updated_by):
--     admin rows are essentially never deleted; write cost isn't worth it yet.
--   • enrollment_requests.plan_key → enrollment_plans: ~5-row parent, never
--     bulk-deleted.
--   • storage.s3_multipart_* / vector tables: Supabase-managed schema.
--
-- Plain CREATE INDEX (not CONCURRENTLY) is intentional: current tables are tiny
-- (< a few hundred rows) so the lock is milliseconds, and CONCURRENTLY cannot run
-- inside a transaction (the SQL editor / Management API wraps this file in one).
-- If you ever re-run this on a LARGE table, split the index section out and use
-- CREATE INDEX CONCURRENTLY statement-by-statement.
--
-- ORDER: run AFTER #20/#21 (it re-asserts policies from earlier migrations;
-- missing policies are skipped with a NOTICE, so partial installs are safe).
-- IDEMPOTENT — safe to re-run.
-- HOW TO RUN: paste into Supabase SQL Editor → Run (or apply via the CLI/API).
-- ─────────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────
-- 1) Wrap bare zero-arg auth/gate calls in scalar subqueries (InitPlan).
--    Generated from the live pg_policies definitions; each statement is guarded
--    so a DB missing a policy (older install) skips it with a NOTICE.
-- ───────────────────────────────────────────────────────────────────
do $wrap$
begin
  begin
    alter policy ai_training_checkpoints_own_read on public.ai_training_checkpoints
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy ai_training_checkpoints_own_read on public.ai_training_checkpoints not found - skipped';
  end;
  begin
    alter policy ai_training_usage_admin_read on public.ai_training_usage
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy ai_training_usage_admin_read on public.ai_training_usage not found - skipped';
  end;
  begin
    alter policy course_ai_chunks_admin_read on public.course_ai_chunks
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy course_ai_chunks_admin_read on public.course_ai_chunks not found - skipped';
  end;
  begin
    alter policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy course_ai_index_jobs_admin_all on public.course_ai_index_jobs not found - skipped';
  end;
  begin
    alter policy course_ai_sources_admin_all on public.course_ai_sources
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy course_ai_sources_admin_all on public.course_ai_sources not found - skipped';
  end;
  begin
    alter policy completions_own on public.course_completions
          using ((user_id = (select auth.uid())))
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy completions_own on public.course_completions not found - skipped';
  end;
  begin
    alter policy lessons_admin_write on public.course_lessons
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy lessons_admin_write on public.course_lessons not found - skipped';
  end;
  begin
    alter policy modules_admin_write on public.course_modules
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy modules_admin_write on public.course_modules not found - skipped';
  end;
  begin
    alter policy courses_admin_write on public.courses
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy courses_admin_write on public.courses not found - skipped';
  end;
  begin
    alter policy enrollment_plans_admin_write on public.enrollment_plans
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy enrollment_plans_admin_write on public.enrollment_plans not found - skipped';
  end;
  begin
    alter policy enroll_req_admin_all on public.enrollment_requests
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy enroll_req_admin_all on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy enroll_req_own_expire on public.enrollment_requests
          using (((user_id = (select auth.uid())) AND (status = 'pending_review'::text) AND (expires_at < now())))
          with check (((user_id = (select auth.uid())) AND (status = 'expired'::text)));
  exception when undefined_object then
    raise notice 'policy enroll_req_own_expire on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy enroll_req_own_insert on public.enrollment_requests
          with check (((user_id = (select auth.uid())) AND (status = 'pending_review'::text)));
  exception when undefined_object then
    raise notice 'policy enroll_req_own_insert on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy enroll_req_own_select on public.enrollment_requests
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy enroll_req_own_select on public.enrollment_requests not found - skipped';
  end;
  begin
    alter policy feature_guides_admin_write on public.feature_guides
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy feature_guides_admin_write on public.feature_guides not found - skipped';
  end;
  begin
    alter policy feature_guides_read on public.feature_guides
          using (((select is_approved()) AND (select is_enrolled())));
  exception when undefined_object then
    raise notice 'policy feature_guides_read on public.feature_guides not found - skipped';
  end;
  begin
    alter policy fvc_insert_own on public.feature_video_completions
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy fvc_insert_own on public.feature_video_completions not found - skipped';
  end;
  begin
    alter policy fvc_select_own on public.feature_video_completions
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy fvc_select_own on public.feature_video_completions not found - skipped';
  end;
  begin
    alter policy fvc_update_own on public.feature_video_completions
          using ((user_id = (select auth.uid())))
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy fvc_update_own on public.feature_video_completions not found - skipped';
  end;
  begin
    alter policy progress_own on public.lesson_progress
          using ((user_id = (select auth.uid())))
          with check ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy progress_own on public.lesson_progress not found - skipped';
  end;
  begin
    alter policy payment_settings_admin_write on public.payment_settings
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy payment_settings_admin_write on public.payment_settings not found - skipped';
  end;
  begin
    alter policy own_profile_select on public.profiles
          using (((select auth.uid()) = id));
  exception when undefined_object then
    raise notice 'policy own_profile_select on public.profiles not found - skipped';
  end;
  begin
    alter policy profiles_admin_select on public.profiles
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy profiles_admin_select on public.profiles not found - skipped';
  end;
  begin
    alter policy profiles_admin_update on public.profiles
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy profiles_admin_update on public.profiles not found - skipped';
  end;
  begin
    alter policy sidebar_settings_admin_write on public.sidebar_settings
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy sidebar_settings_admin_write on public.sidebar_settings not found - skipped';
  end;
  begin
    alter policy student_external_accounts_admin_all on public.student_external_accounts
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_external_accounts_admin_all on public.student_external_accounts not found - skipped';
  end;
  begin
    alter policy student_external_accounts_own_select on public.student_external_accounts
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy student_external_accounts_own_select on public.student_external_accounts not found - skipped';
  end;
  begin
    alter policy student_import_events_admin_insert on public.student_import_events
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_events_admin_insert on public.student_import_events not found - skipped';
  end;
  begin
    alter policy student_import_events_admin_select on public.student_import_events
          using ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_events_admin_select on public.student_import_events not found - skipped';
  end;
  begin
    alter policy student_import_jobs_admin_all on public.student_import_jobs
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_jobs_admin_all on public.student_import_jobs not found - skipped';
  end;
  begin
    alter policy student_import_rows_admin_all on public.student_import_rows
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy student_import_rows_admin_all on public.student_import_rows not found - skipped';
  end;
  begin
    alter policy subscriptions_admin_all on public.subscriptions
          using ((select is_admin()))
          with check ((select is_admin()));
  exception when undefined_object then
    raise notice 'policy subscriptions_admin_all on public.subscriptions not found - skipped';
  end;
  begin
    alter policy subscriptions_own_select on public.subscriptions
          using ((user_id = (select auth.uid())));
  exception when undefined_object then
    raise notice 'policy subscriptions_own_select on public.subscriptions not found - skipped';
  end;
  begin
    alter policy course_media_admin_delete on storage.objects
          using (((bucket_id = 'course-media'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_media_admin_delete on storage.objects not found - skipped';
  end;
  begin
    alter policy course_media_admin_update on storage.objects
          using (((bucket_id = 'course-media'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_media_admin_update on storage.objects not found - skipped';
  end;
  begin
    alter policy course_media_admin_write on storage.objects
          with check (((bucket_id = 'course-media'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_media_admin_write on storage.objects not found - skipped';
  end;
  begin
    alter policy course_videos_admin_delete on storage.objects
          using (((bucket_id = 'course-videos'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_videos_admin_delete on storage.objects not found - skipped';
  end;
  begin
    alter policy course_videos_admin_update on storage.objects
          using (((bucket_id = 'course-videos'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_videos_admin_update on storage.objects not found - skipped';
  end;
  begin
    alter policy course_videos_admin_write on storage.objects
          with check (((bucket_id = 'course-videos'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy course_videos_admin_write on storage.objects not found - skipped';
  end;
  begin
    alter policy enrollment_receipts_delete on storage.objects
          using (((bucket_id = 'enrollment-receipts'::text) AND (select is_admin())));
  exception when undefined_object then
    raise notice 'policy enrollment_receipts_delete on storage.objects not found - skipped';
  end;
  begin
    alter policy enrollment_receipts_insert_own on storage.objects
          with check (((bucket_id = 'enrollment-receipts'::text) AND ((storage.foldername(name))[1] = ((select auth.uid()))::text)));
  exception when undefined_object then
    raise notice 'policy enrollment_receipts_insert_own on storage.objects not found - skipped';
  end;
  begin
    alter policy enrollment_receipts_select on storage.objects
          using (((bucket_id = 'enrollment-receipts'::text) AND (((storage.foldername(name))[1] = ((select auth.uid()))::text) OR (select is_admin()))));
  exception when undefined_object then
    raise notice 'policy enrollment_receipts_select on storage.objects not found - skipped';
  end;
end $wrap$;

-- ───────────────────────────────────────────────────────────────────
-- 2) Drop exact-duplicate / PK-redundant indexes (each duplicated by the index
--    named in the trailing comment; none backs a constraint).
-- ───────────────────────────────────────────────────────────────────
drop index if exists public.idx_lessons_module;                 -- = course_lessons_module_position_idx (module_id, position)
drop index if exists public.idx_modules_course;                 -- = course_modules_course_position_idx (course_id, position)
drop index if exists public.idx_progress_user_course;           -- = lesson_progress_user_course_idx (user_id, course_id)
drop index if exists public.course_completions_user_course_idx; -- = course_completions_pkey (user_id, course_id)
drop index if exists public.courses_slug_idx;                   -- = courses_slug_key unique index (slug)

-- ───────────────────────────────────────────────────────────────────
-- 3) Hot-path index: the enrollment gate's own-latest-request read
--    (WHERE user_id = $uid ORDER BY created_at DESC LIMIT 1) — the single most
--    frequent authenticated query. Also serves the drawer's last-5 history read.
-- ───────────────────────────────────────────────────────────────────
create index if not exists enrollment_requests_user_created_idx
  on public.enrollment_requests (user_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────
-- 4) FK covering indexes — cascade-delete + join paths.
--    Course platform (course/lesson deletes cascade into these):
-- ───────────────────────────────────────────────────────────────────
create index if not exists lesson_progress_lesson_idx
  on public.lesson_progress (lesson_id);
create index if not exists course_completions_course_idx
  on public.course_completions (course_id);
create index if not exists courses_source_course_idx
  on public.courses (source_course_id) where source_course_id is not null;
create index if not exists ai_training_checkpoints_course_idx
  on public.ai_training_checkpoints (course_id);
create index if not exists ai_training_checkpoints_lesson_idx
  on public.ai_training_checkpoints (lesson_id);
create index if not exists course_ai_index_jobs_source_idx
  on public.course_ai_index_jobs (source_id);

--    Community (post hard-deletes cascade into these; author columns are hit
--    when a profile is deleted and by author-scoped reads):
create index if not exists community_notifications_post_idx
  on public.community_notifications (post_id);
create index if not exists community_notifications_comment_idx
  on public.community_notifications (comment_id) where comment_id is not null;
create index if not exists community_notifications_actor_idx
  on public.community_notifications (actor_id);
create index if not exists community_announcement_reads_post_idx
  on public.community_announcement_reads (post_id);
create index if not exists community_posts_author_idx
  on public.community_posts (author_id);
create index if not exists community_comments_author_idx
  on public.community_comments (author_id);
create index if not exists community_reactions_user_idx
  on public.community_reactions (user_id);
create index if not exists community_attachments_uploader_idx
  on public.community_attachments (uploader_id);

--    Subscriptions lineage + request linkage (renewal chains, approve lookups):
create index if not exists subscriptions_renewed_from_idx
  on public.subscriptions (renewed_from_subscription_id) where renewed_from_subscription_id is not null;
create index if not exists subscriptions_request_idx
  on public.subscriptions (request_id) where request_id is not null;

--    Student imports (job purges + audit lookups):
create index if not exists student_external_accounts_job_idx
  on public.student_external_accounts (import_job_id);
create index if not exists student_external_accounts_row_idx
  on public.student_external_accounts (import_row_id);
create index if not exists student_import_events_row_idx
  on public.student_import_events (row_id);
create index if not exists student_import_events_actor_idx
  on public.student_import_events (actor);
create index if not exists student_import_rows_target_user_idx
  on public.student_import_rows (target_user_id) where target_user_id is not null;

-- 5) Refresh PostgREST's schema cache.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • The performance advisor's auth_rls_initplan warnings drop to zero; every
--     policy evaluates auth/gate helpers once per statement.
--   • Cascade deletes (courses, posts, profiles) and the enrollment-gate read use
--     index scans instead of sequential scans as the tables grow.
--   • 5 duplicate/redundant indexes no longer tax every write.
-- ─────────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Backend hardening — integrity constraints, function grants, storage scoping (#30)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY (from the 2026-07-26 full backend audit against the live project):
--   • subscriptions.plan_key had NO foreign key to enrollment_plans. A typo'd key
--     in an approve_subscription() call would grant a NO-EXPIRY term (NULL
--     access_days lookup) that BOTH plan-scope gates treat as full access — a
--     silent permanent full-access grant. enrollment_requests.plan_key already
--     has this FK; this brings subscriptions (the authoritative access record)
--     in line.
--   • Several enum-ish / money / duration columns had no CHECK constraints, so a
--     bad admin write (courses.access_tier typo, negative price, NULL/zero
--     access_days) silently corrupted entitlement logic instead of erroring.
--   • student_import_events is the IMMUTABLE audit trail, but its job_id FK was
--     ON DELETE CASCADE — purging a staged import job deleted its audit history.
--     (actor and row_id were already ON DELETE SET NULL.)
--   • Supabase's default privileges grant EXECUTE to anon on every new function.
--     The internal guards hold (verified — no privilege boundary holes), but
--     anonymous visitors have no business invoking admin/member RPCs, and
--     trigger-only functions should be invocable by nobody. The pure gate
--     helpers (is_admin/is_approved/is_enrolled/current_plan_key/plan_is_*)
--     deliberately KEEP anon EXECUTE — they run inside RLS policy evaluation
--     for whatever role issues the query, and they leak nothing (no JWT → false).
--   • The avatars + course-media buckets had a bucket-wide SELECT policy for the
--     public role, letting ANY visitor enumerate every object (and thus every
--     member's UID) via the list API. Public-bucket URL serving does NOT go
--     through RLS, so listing can be scoped without affecting <img> playback:
--     the app only lists avatars/<own uid>/ (upload cleanup) and course-media
--     as admin (cover/legacy sweeps).
--   • course-media had no size/MIME limits (the other buckets' client guards are
--     50 MB video / 5 MB image; the bucket itself must enforce a ceiling too).
--
-- Deliberately DEFERRED (documented, revisit at real scale):
--   • Consolidating multiple permissive policies per (table, action) — real but
--     latent perf cost; an OR-merge mistake changes access, so it needs its own
--     carefully-validated pass.
--   • Moving pg_trgm out of the public schema — SECDEF functions are pinned to
--     search_path=public, so relocating the extension risks breaking trigram
--     operator lookups for near-zero benefit.
--
-- ORDER: run AFTER #29. IDEMPOTENT — safe to re-run.
-- HOW TO RUN: paste into Supabase SQL Editor → Run (or apply via the CLI/API).
-- ─────────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────
-- 1) Referential integrity: subscriptions.plan_key → enrollment_plans(key).
--    ON UPDATE CASCADE keeps a key rename consistent; ON DELETE RESTRICT stops
--    a plan delete from stranding live terms. Orphans (none in prod as of
--    2026-07-26) would make the ADD fail — surfaced as a NOTICE, not an abort.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'subscriptions_plan_key_fkey'
  ) then
    begin
      alter table public.subscriptions
        add constraint subscriptions_plan_key_fkey
        foreign key (plan_key) references public.enrollment_plans(key)
        on update cascade on delete restrict;
    exception when foreign_key_violation then
      raise notice 'subscriptions has plan_key values missing from enrollment_plans — FK NOT added; repair the orphans and re-run.';
    end;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 2) CHECK constraints — enforce the enums/ranges the app logic assumes.
--    Each is guarded so a re-run (or a legacy out-of-range row) never aborts.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  -- courses.access_tier is the Essentials/Standard entitlement enum (#19); it was
  -- enforced only in client code + the plan_is_sampler() SQL predicate.
  if not exists (select 1 from pg_constraint where conname = 'courses_access_tier_check') then
    begin
      alter table public.courses
        add constraint courses_access_tier_check
        check (access_tier in ('standard', 'essentials'));
    exception when check_violation then
      raise notice 'courses has unexpected access_tier values — constraint NOT added; clean up and re-run.';
    end;
  end if;

  -- A NULL/zero/negative access_days on a plan silently grants a no-expiry term
  -- via approve_subscription()'s NULL branch. Every live plan has a positive
  -- value; make that the rule.
  if not exists (select 1 from pg_constraint where conname = 'enrollment_plans_access_days_positive') then
    begin
      alter table public.enrollment_plans
        add constraint enrollment_plans_access_days_positive
        check (access_days > 0);
    exception when check_violation then
      raise notice 'enrollment_plans has non-positive access_days rows — constraint NOT added; clean up and re-run.';
    end;
  end if;
  begin
    alter table public.enrollment_plans alter column access_days set not null;
  exception when not_null_violation then
    raise notice 'enrollment_plans has NULL access_days rows — NOT NULL not set; clean up and re-run.';
  end;

  -- Money columns: negative values are always a data error.
  if not exists (select 1 from pg_constraint where conname = 'enrollment_plans_price_nonneg') then
    begin
      alter table public.enrollment_plans
        add constraint enrollment_plans_price_nonneg
        check (price_php >= 0 and (compare_at_php is null or compare_at_php >= 0));
    exception when check_violation then
      raise notice 'enrollment_plans has negative price rows — constraint NOT added; clean up and re-run.';
    end;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'enrollment_requests_amounts_nonneg') then
    begin
      alter table public.enrollment_requests
        add constraint enrollment_requests_amounts_nonneg
        check (amount_expected >= 0 and amount_paid >= 0);
    exception when check_violation then
      raise notice 'enrollment_requests has negative amount rows — constraint NOT added; clean up and re-run.';
    end;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 3) Audit immutability: student_import_events must SURVIVE a job purge.
--    job_id is already nullable; only the FK action changes (CASCADE → SET NULL,
--    matching the actor/row_id FKs). Events keep IDs + safe codes only, so a
--    NULL job_id row remains a valid, meaningful audit record.
-- ───────────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'student_import_events_job_id_fkey';
  if v_def is not null and v_def like '%ON DELETE CASCADE%' then
    alter table public.student_import_events
      drop constraint student_import_events_job_id_fkey;
    alter table public.student_import_events
      add constraint student_import_events_job_id_fkey
      foreign key (job_id) references public.student_import_jobs(id) on delete set null;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 4) Function EXECUTE hygiene.
--    4a) Member/admin RPCs: callable by signed-in users only (their internal
--        guards do the real authorization) — strip the default anon grant.
--    4b) Trigger-only functions: invocable by NOBODY via RPC (triggers fire
--        regardless of the caller's EXECUTE privilege).
--    trainer_* functions already have the correct service-role-only grants (#27).
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  -- 4a) anon has no business calling these; authenticated keeps EXECUTE.
  begin revoke execute on function public.approve_subscription(uuid, text, uuid) from public, anon;
  exception when undefined_function then null; end;
  begin revoke execute on function public.approve_extension(uuid, uuid, int) from public, anon;
  exception when undefined_function then null; end;
  begin revoke execute on function public.expire_overdue_subscriptions() from public, anon;
  exception when undefined_function then null; end;
  begin revoke execute on function public.record_enrollment_notification(uuid, text, text) from public, anon;
  exception when undefined_function then null; end;
  begin revoke execute on function public.set_my_avatar(text) from public, anon;
  exception when undefined_function then null; end;
  begin revoke execute on function public.search_community_members(text) from public, anon;
  exception when undefined_function then null; end;
  begin revoke execute on function public.complete_import_onboarding() from public, anon;
  exception when undefined_function then null; end;

  -- 4b) trigger-only — nobody calls these directly.
  begin revoke execute on function public.handle_new_user() from public, anon, authenticated;
  exception when undefined_function then null; end;
  begin revoke execute on function public.community_stamp_author() from public, anon, authenticated;
  exception when undefined_function then null; end;
  begin revoke execute on function public.community_posts_guard() from public, anon, authenticated;
  exception when undefined_function then null; end;
  begin revoke execute on function public.community_comment_rollup() from public, anon, authenticated;
  exception when undefined_function then null; end;
  begin revoke execute on function public.community_notify_on_post() from public, anon, authenticated;
  exception when undefined_function then null; end;
  begin revoke execute on function public.community_notify_on_comment() from public, anon, authenticated;
  exception when undefined_function then null; end;
  begin revoke execute on function public.course_ai_mark_lesson_stale() from public, anon, authenticated;
  exception when undefined_function then null; end;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 5) Storage read-policy scoping (public-bucket URL serving is unaffected —
--    it never consults RLS; only the list/copy/move APIs check SELECT).
--    • avatars: a member lists ONLY their own folder (AvatarSection's upload
--      cleanup); admins may list all. Anonymous listing (UID enumeration) ends.
--    • course-media: only admins list (cover upload cleanup + the legacy media
--      sweep in removeMediaIfUnreferenced). Students play covers/guide videos
--      via public URLs, which need no SELECT.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = ((select auth.uid()))::text
      or (select is_admin())
    )
  );

drop policy if exists course_media_read on storage.objects;
create policy course_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'course-media' and (select is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- 6) course-media bucket limits — 50 MB ceiling (matches the client's video
--    guard; covers are client-capped at 5 MB) + an image/video MIME allowlist.
--    Existing objects are untouched (only image/png lives there today).
-- ───────────────────────────────────────────────────────────────────
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array[
         'image/jpeg','image/png','image/webp','image/gif',
         'video/mp4','video/webm','video/ogg','video/quicktime','video/x-m4v'
       ]
 where id = 'course-media';

-- 7) Refresh PostgREST's schema cache.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER RUNNING
--   • A typo'd plan key in approve_subscription() now errors instead of granting
--     permanent full access; bad tier/price/duration writes error at the table.
--   • Purging a student-import job keeps its audit events (job_id goes NULL).
--   • anon can no longer invoke any member/admin RPC; trigger functions are not
--     invocable via the API at all.
--   • Anonymous visitors can no longer enumerate avatars/course-media objects;
--     members still list exactly what the app needs (own avatar folder; admins
--     everything). Public URL playback is unchanged.
--   • course-media uploads are capped at 50 MB and image/video MIME types.
-- ─────────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration apply-log — public.schema_migrations (#31)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: this project applies db/*.sql by hand (SQL editor / CLI), and until
-- 2026-07-26 nothing recorded WHICH files had run. That is exactly how #20/#21
-- (account-membership-requests + hardening) were silently skipped for two weeks
-- while the deployed client depended on them (the Extend Access over-grant bug).
-- This table is the lightweight fix: one row per applied migration file.
--
-- RULE going forward: whenever you run a db/*.sql file against an environment,
-- insert its row here IN THE SAME SQL editor session (each new migration file
-- should end by inserting its own row — see the tail of this file for the
-- pattern). To audit for drift: compare rows against `ls db/*.sql` — any dated
-- file missing here is unapplied.
--
-- RLS: admins can read it (so a future admin UI can show apply state); nobody
-- can write through the API — inserts happen only via the SQL editor / CLI
-- (postgres role, which owns the table and bypasses RLS).
--
-- ORDER: any time (independent). IDEMPOTENT — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.schema_migrations (
  filename   text primary key,
  checksum   text,          -- sha256 of the repo file at apply/backfill time (informational)
  applied_at timestamptz not null default now(),
  notes      text
);

alter table public.schema_migrations enable row level security;

drop policy if exists schema_migrations_admin_select on public.schema_migrations;
create policy schema_migrations_admin_select on public.schema_migrations
  for select to authenticated
  using ((select is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- Backfill: every dated db/*.sql file confirmed applied to the live project as
-- of 2026-07-26 (via the full live-schema audit), plus the files applied by the
-- same day's backend pass. The 000 bootstrap is deliberately absent — it is the
-- from-scratch equivalent of this series and never ran against this database.
-- ───────────────────────────────────────────────────────────────────
insert into public.schema_migrations (filename, checksum, notes)
values
    ('2026-06-15-auth-profiles-base.sql', '063cf858c9ad4f4ede891cc06743b10d16e132073555fb0453361b608de560d7', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-16-course-platform-base.sql', '2090524fce0c0b654794b572d2f8a466a4a7dab72e72f61d0fc32e2a22bcfb0e', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-16-course-platform-storage.sql', 'c77bc6369f2f4578d954d792335fe9e3b36dcce79d22c87e0fbcdb9d0ed56212', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-17-course-date-source-id.sql', 'b8536bbf6822212b0d9cea4eb641c84bb331aece59ac527277ab20fbc6542017', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-18-sidebar-settings.sql', '2a44049a8487a1d5b308d1e6855decbc08ee3b4c3451a3a09aeff7be212248b0', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-22-feature-guides.sql', '48b62c6dd01f2f0f2ac96ba268df78d5ee2c65180bc67ee54c44086248df7884', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-22-feature-video-completions.sql', '594c4c42c4840729cc2b0c056f035b15cf6aba7d36905a393caf21f4e6e642f0', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-24-navigation-performance-indexes.sql', '965c0e376e34fe28ae3ae01b6b95db351f2f92bac242ffcaebddcf558244a508', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-29-approval-status-index.sql', '8de549a725b3448b338dea184e71106972cba6e6106219f34dda58ad367c7c15', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-06-29-profiles-realtime.sql', '7747dd38deb01de77ba7834a8494e61079f5049ff9c37ac78f8f468802e8fc5b', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-29-user-approval.sql', '176947ce1b8b981644746d64fd28caf74789cf83eac41d858659c4527a848295', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-04-enrollment.sql', '3b732e7436197b86516ccf09e70d540982e15c674164b1e6525b42ad244b7b8a', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-04-subscription-lifecycle.sql', '9545e3a17ba400129c6980cca02e73fe868116151c29c7541ce273912ed877b3', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-08-course-videos-private.sql', '98c444a8e7cebc613c61a4cf67ce47f1d9b13d1d766160334f44581dd0b5f177', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-08-enrollment-notify-status.sql', '614000d16a9c512380c7773ecb68652d5b96fa4fcff68e271540db706378eed8', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-08-receipt-integrity.sql', '42ed063015a7c66420b04adfbe3de348cabcf52cce86455955ccc0bdd34ad871', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-09-plan-course-access.sql', '8dfa494b466d4c5f2cc555a1fa764ab0808e530f4a4b6f3cc2e0a87333d4264d', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-10-subscription-grace.sql', 'ef2b42fa69966b0e7a3980eb3ac6d9ba24ebce8a4a93a18a2d195ecd01c51de0', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-11-account-membership-requests.sql', '94f7da53e165ef3fb86a2d8bcc77b80063c499344c9d9c22f1716cee20f8ae69', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-11-hardening.sql', '9e642840f2d4eaa36bc8a30fa4744b93d1f30a795cd3aeecbf88717616d64651', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-11-sampler-essentials-access.sql', 'e66ac9cc4a1e3ad8960ae0975efc8a1b524c55db8658d29fc135b5ab6fa50b31', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-20-community.sql', 'b4a5f67718d3ebde38f3dcc33b8567f0aa52cf18242f1bb3be1c45fed2649e8d', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-20-sampler-support-60-days.sql', 'c6966143bcbdbeb209ceae6b591bab1ae587dc63ba4a370e3e7c2128ef71e53c', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-21-community-forum.sql', '4f761fb33d959618cae38aa4dfb527b3eadf2331b526f81748d2a416ef079a46', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-22-community-hardening.sql', 'f7f7c0cac2ed61086813b25dfd20093238e7dd3f6856cb4fdc004d72cf654094', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-23-student-imports.sql', '249b74ca589f020dfd0b56c762d0ac62e45d2f046f1cc9e46bf786b29e272eff', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-24-course-ai-trainer.sql', 'f7b57a4008548c5ca0a4c40fd125e8f2ce9b05119eef16eb9a8b0570237f98c5', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-26-backend-hardening.sql', '1835fa614c5a9bddb808c48be69ee6e2927317887ca1eb7876747d4f7e1b7164', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-26-community-write-gate.sql', 'd77c723aee8ec4fad4f8db85268dcb07e0e3b74dc1df0e8a24e702a7670cb30b', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-26-rls-initplan-and-indexes.sql', '2f18757429346c839505bf07c8e34ca19b7be73e19ce34c40ab5353818117a62', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-26-schema-migrations-log.sql', null, 'self-recorded at creation - checksum is of the repo file, see git')
on conflict (filename) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- PATTERN for future migration files — end each new db/<date>-<name>.sql with:
--
--   insert into public.schema_migrations (filename, checksum, notes)
--   values ('<date>-<name>.sql', '<sha256 of the file>', null)
--   on conflict (filename) do nothing;
--
-- so applying the file records it in the same run.
-- ─────────────────────────────────────────────────────────────────────────────
-- ───────────────────────────────────────────────────────────────────
-- 19) COMMUNITY SPACES & BATCHES (#32) — folded VERBATIM from
--     db/2026-07-28-community-spaces-batches.sql (the §18 idiom: when that
--     file changes, re-fold it here and keep the two identical). Placed
--     LAST deliberately: §15b/§18 above create/re-touch the PRE-#32
--     community policy shapes, and this section's space-aware DROP+CREATE
--     must win on a fresh install. Every #32 guard passes at this point.
-- ───────────────────────────────────────────────────────────────────
-- ════════════════════════════════════════════════════════════════════════════
-- COMMUNITY SPACES & BATCHES (#32) — automatic student segregation
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY
--   The community was ONE flat forum: every predicate was
--   is_admin() OR (is_approved() AND is_enrolled()) — no plan/batch dimension.
--   The gold_live and vip packages are cohort-based and need PRIVATE per-batch
--   communities ("Gold — August 2026", "VIP — August 2026") beside a General
--   community every active plan keeps. Access must derive automatically from
--   the member's current dated subscription (plan + batch) and be enforced by
--   RLS — never by hidden buttons.
--
-- WHAT THIS ADDS
--   • batches            — cohort registry ('2026-08' → August 2026; open/closed/archived,
--                          optional per-segment capacities). Creating a batch auto-creates
--                          its Gold + VIP spaces (batches_create_spaces trigger).
--                          CAPACITY SCOPE: seats are enforced (under a FOR UPDATE batch
--                          lock) only on the two admin RPC paths below — approval and
--                          batch assignment. Bulk student imports and direct SQL grants
--                          deliberately do NOT consume/check seats; verify the counts in
--                          Admin → Batches after a premium import.
--   • community_spaces   — one 'general' space + one 'gold' and one 'vip' space per batch.
--                          Capability flags (member_posting / member_comments /
--                          member_reactions) are read INSIDE the insert policies —
--                          General ships with member_comments = false (posts + reactions
--                          only; historical replies stay readable).
--   • batch_events       — immutable admin audit trail (student_import_events precedent).
--   • enrollment_plans.community_segment  ('general'|'gold'|'vip'; gold_live→gold, vip→vip)
--   • subscriptions.batch_id / enrollment_requests.batch_id / student_import_rows.proposed_batch_id
--   • community_posts.space_id (NOT NULL, trigger-filled + frozen)
--     community_comments.space_id (trigger-stamped from parent, frozen)
--     community_notifications.space_id (trigger-stamped)
--   • user_community_space_ids(p_user) / my_community_space_ids() — THE derived-membership
--     predicate (no membership table: current valid sub → plan segment + batch → spaces;
--     unknown/legacy plans and batch-less premium subs fail closed to General only).
--   • my_community_spaces() — one call drives the client space switcher.
--   • admin_finalize_enrollment(p_request_id, p_batch_id) — the ONE transactional approval:
--     validates request + plan + batch + capacity together, wraps the existing
--     approve_subscription()/approve_extension() (term math stays in one place), stamps
--     subscriptions.batch_id, patches the profiles cache, marks the request approved.
--     Replaces the client's 3-step approve + its local-grant fallback.
--   • admin_assign_batch(p_user_ids, p_batch_id) — idempotent bulk assignment for the
--     "needs batch assignment" queue (+ batch_events audit rows).
--   • admin_batch_overview() — per-batch enrollment counts for the admin batch manager.
--   • Every community RLS policy rewritten space-aware (minimal-diff: original predicate
--     text preserved, space/capability predicates ADDED). Storage community-media policies
--     accept BOTH path shapes: legacy <uid>/… and new <space_id>/<uid>/…
--   • search_community_members(p_query, p_space_id) — mention directory scoped to the
--     eligible members of one space. community_category_counts(p_space_id) — stays
--     SECURITY INVOKER (caller RLS keeps scoping the counts).
--
-- ORDER
--   Requires #13 (subscription lifecycle: subscriptions.ends_at), #23/#24 (community
--   forum tables incl. comments_locked), and #30 (subscriptions.plan_key FK). Run AFTER
--   #29/#31. The guard below aborts if a prerequisite is missing.
--
-- SAFE FOR THE SQL-FIRST WINDOW
--   Apply this BEFORE deploying the matching client: old clients keep working — posts
--   without space_id are trigger-filled into General, and the replaced RPC signatures
--   keep default params so zero-arg / one-arg calls still resolve.
--   KNOWN GAP until the new client ships: every existing post now lives in General,
--   which is reactions-only, so the old client shows a reply composer on EVERY post
--   and any member reply is refused by RLS (an error toast, nothing lost). Reading,
--   posting, and reactions are unaffected, and admins can still reply. Deploy the
--   matching client promptly — or, to keep replies open during a longer window, run
--   `update public.community_spaces set member_comments = true where slug='general';`
--   and set it back to false once the client is live.
--
-- HOW TO RUN — paste into the Supabase SQL editor and run once. IDEMPOTENT: safe to
-- re-run (add column if not exists / create or replace / drop policy if exists / on
-- conflict do nothing throughout).
-- ════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Guards — refuse to run against a DB missing the prerequisites.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception '#32 requires the enrollment migration (db/2026-07-04-enrollment.sql) first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'subscriptions'
                    and column_name = 'ends_at') then
    raise exception '#32 requires the subscription lifecycle migration (db/2026-07-04-subscription-lifecycle.sql, #13) first.';
  end if;
  if to_regclass('public.community_posts') is null then
    raise exception '#32 requires the community migration (db/2026-07-20-community.sql, #23) first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'community_posts'
                    and column_name = 'comments_locked') then
    raise exception '#32 requires the community forum upgrade (db/2026-07-21-community-forum.sql, #24) first.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_plan_key_fkey') then
    raise exception '#32 requires the backend hardening pass (db/2026-07-26-backend-hardening.sql, #30) first.';
  end if;
  if to_regproc('public.approve_subscription') is null or to_regproc('public.approve_extension') is null then
    raise exception '#32 requires approve_subscription/approve_extension (#13/#20) first.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) batches — the cohort registry. code is the stable business key
--    ('2026-08'); display name is what members see ("August 2026").
--    Capacities are OPTIONAL — null = unlimited; enforced transactionally
--    only through the admin RPC paths below.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.batches (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^\d{4}-\d{2}$'),
  name          text not null,
  starts_on     date,
  ends_on       date,
  timezone      text not null default 'Asia/Manila',
  status        text not null default 'open'
                check (status in ('open', 'closed', 'archived')),
  gold_capacity int check (gold_capacity is null or gold_capacity > 0),
  vip_capacity  int check (vip_capacity is null or vip_capacity > 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────
-- 2) community_spaces — one 'general' row (batch_id NULL) plus exactly one
--    'gold' and one 'vip' row per batch. Capability flags are the data-driven
--    switchboard the insert policies read (flip member_comments back on for
--    General later with a one-row UPDATE — no migration needed).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.community_spaces (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('general', 'gold', 'vip')),
  batch_id         uuid references public.batches(id) on delete restrict,
  slug             text not null unique,
  name             text not null,
  member_posting   boolean not null default true,
  member_comments  boolean not null default true,
  member_reactions boolean not null default true,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 'general' has no batch; premium spaces always belong to one.
  check ((kind = 'general') = (batch_id is null)),
  unique (kind, batch_id)
);

-- Exactly ONE general space, ever.
create unique index if not exists community_spaces_one_general
  on public.community_spaces ((true)) where kind = 'general';
create index if not exists community_spaces_batch_idx
  on public.community_spaces (batch_id);

-- ───────────────────────────────────────────────────────────────────
-- 3) batch_events — immutable admin audit (create/status/assign actions).
--    Admin select + insert only; no update/delete (student_import_events
--    precedent). detail carries ids + safe codes, never PII.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.batch_events (
  id         uuid primary key default gen_random_uuid(),
  batch_id   uuid references public.batches(id) on delete set null,
  user_id    uuid references public.profiles(id) on delete set null,
  actor_id   uuid,
  action     text not null check (action in
             ('create', 'open', 'close', 'archive', 'assign', 'reassign', 'unassign', 'capacity')),
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists batch_events_batch_idx
  on public.batch_events (batch_id, created_at desc);
-- FK-covering index (the #29 discipline): batch_events.user_id cascades from
-- profiles, and the admin queue reads a member's assignment history by user.
create index if not exists batch_events_user_idx
  on public.batch_events (user_id);

-- ───────────────────────────────────────────────────────────────────
-- 4) Auto-create the Gold + VIP spaces whenever a batch is born — covers
--    admin-UI inserts AND SQL-editor inserts. Also writes the 'create'
--    audit row.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batches_create_spaces()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.community_spaces (kind, batch_id, slug, name)
  values ('gold', new.id, 'gold-' || new.code, 'Gold — ' || new.name),
         ('vip',  new.id, 'vip-'  || new.code, 'VIP — '  || new.name)
  on conflict (kind, batch_id) do nothing;
  insert into public.batch_events (batch_id, actor_id, action, detail)
  values (new.id, auth.uid(), 'create',
          jsonb_build_object('code', new.code, 'name', new.name));
  return new;
end;
$$;

revoke all on function public.batches_create_spaces() from public, anon, authenticated;

drop trigger if exists batches_create_spaces on public.batches;
create trigger batches_create_spaces
  after insert on public.batches
  for each row execute function public.batches_create_spaces();

-- ───────────────────────────────────────────────────────────────────
-- 5) New columns on existing tables.
-- ───────────────────────────────────────────────────────────────────
alter table public.enrollment_plans
  add column if not exists community_segment text not null default 'general'
  check (community_segment in ('general', 'gold', 'vip'));

-- Seed the segment map. NEVER inferred from price/name — explicit keys only.
update public.enrollment_plans set community_segment = 'gold' where key = 'gold_live' and community_segment <> 'gold';
update public.enrollment_plans set community_segment = 'vip'  where key = 'vip'       and community_segment <> 'vip';

alter table public.subscriptions
  add column if not exists batch_id uuid references public.batches(id) on delete restrict;
create index if not exists subscriptions_batch_idx on public.subscriptions (batch_id);

alter table public.enrollment_requests
  add column if not exists batch_id uuid references public.batches(id) on delete set null;
create index if not exists enrollment_requests_batch_idx on public.enrollment_requests (batch_id);

-- Student imports (#26) may not be installed everywhere — column is conditional.
do $$
begin
  if to_regclass('public.student_import_rows') is not null then
    alter table public.student_import_rows
      add column if not exists proposed_batch_id uuid references public.batches(id) on delete set null;
  end if;
end $$;

alter table public.community_posts
  add column if not exists space_id uuid references public.community_spaces(id) on delete restrict;
alter table public.community_comments
  add column if not exists space_id uuid references public.community_spaces(id) on delete restrict;
alter table public.community_notifications
  add column if not exists space_id uuid references public.community_spaces(id) on delete cascade;

-- ───────────────────────────────────────────────────────────────────
-- 6) Seeds: the single General space (posts + reactions only — the owner's
--    call: replies live in the premium batch communities) and the first
--    cohort. The batch insert fires batches_create_spaces → gold-2026-08 +
--    vip-2026-08 exist right after.
-- ───────────────────────────────────────────────────────────────────
insert into public.community_spaces (kind, batch_id, slug, name, member_comments)
values ('general', null, 'general', 'General', false)
on conflict do nothing;

insert into public.batches (code, name, status)
values ('2026-08', 'August 2026', 'open')
on conflict (code) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 7) Backfill: every existing post/comment/notification belongs to General
--    (the whole forum WAS General until now). Content is preserved — nothing
--    is deleted. Then pin NOT NULL on posts/comments.
-- ───────────────────────────────────────────────────────────────────
update public.community_posts p
   set space_id = (select id from public.community_spaces where kind = 'general')
 where p.space_id is null;

update public.community_comments c
   set space_id = p.space_id
  from public.community_posts p
 where p.id = c.post_id and c.space_id is null;

update public.community_notifications n
   set space_id = p.space_id
  from public.community_posts p
 where p.id = n.post_id and n.space_id is null;

alter table public.community_posts    alter column space_id set not null;
alter table public.community_comments alter column space_id set not null;
-- community_notifications.space_id stays nullable: legacy rows with a deleted
-- post keep null → still visible to their owner (policy treats null as owner-only).

create index if not exists community_posts_space_feed_idx
  on public.community_posts (space_id, pinned desc, last_activity_at desc);
create index if not exists community_posts_space_created_idx
  on public.community_posts (space_id, created_at desc);
create index if not exists community_posts_space_tag_idx
  on public.community_posts (space_id, tag_slug) where status = 'active';
create index if not exists community_comments_space_idx
  on public.community_comments (space_id);
create index if not exists community_notifications_space_idx
  on public.community_notifications (space_id);

-- Superseded by the space-leading feed indexes above (#29 drop precedent).
-- community_posts_tag_idx is KEPT — the bell's announcements lookup filters by
-- tag_slug across spaces.
drop index if exists public.community_posts_feed_idx;
drop index if exists public.community_posts_forum_idx;

-- ───────────────────────────────────────────────────────────────────
-- 8) THE membership predicate. No membership table — spaces are DERIVED from
--    the caller's current valid subscription every time, so approval, renewal,
--    expiry (+3-day grace), upgrade, and downgrade all take effect on the very
--    next query with nothing to sync or revoke.
--
--    user_community_space_ids(p_user)  — parameterized canonical form
--      (trainer_visible_courses precedent). NOT API-callable.
--      · admins → every space (moderation, incl. inactive);
--      · else: approved + (valid current sub per is_enrolled()'s date math,
--        OR the is_paid-no-subs grandfather) → General always; PLUS the active
--        premium space where enrollment_plans.community_segment = space.kind
--        AND sub.batch_id = space.batch_id.
--      · Unknown/legacy plan keys → segment 'general' → General only.
--      · Premium sub with batch_id NULL → General only (fails CLOSED — that
--        member surfaces in the admin "needs batch assignment" queue).
--
--    my_community_space_ids() — the auth.uid() wrapper every policy uses via
--      `space_id in (select public.my_community_space_ids())` (InitPlan-once,
--      #29 discipline). SECURITY DEFINER so its own reads bypass RLS — no
--      policy recursion.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.user_community_space_ids(p_user uuid)
returns setof uuid
language sql stable security definer set search_path = public
as $$
  with me as (
    select p.is_admin,
           (p.approval_status = 'approved' or p.is_admin) as approved,
           p.is_paid
      from public.profiles p
     where p.id = p_user
  ),
  cur as (
    select s.plan_key, s.batch_id
      from public.subscriptions s
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  gate as (
    select coalesce((select is_admin from me), false) as is_admin,
           (coalesce((select approved from me), false)
            and (exists (select 1 from cur)
                 or (coalesce((select is_paid from me), false)
                     and not exists (select 1 from public.subscriptions s2
                                      where s2.user_id = p_user)))) as is_member
  )
  select sp.id
    from public.community_spaces sp, gate g
   where g.is_admin
      or (g.is_member and sp.active
          and (sp.kind = 'general'
               or exists (select 1
                            from cur c
                            join public.enrollment_plans ep on ep.key = c.plan_key
                           where ep.community_segment = sp.kind
                             and c.batch_id is not null
                             and c.batch_id = sp.batch_id)));
$$;

revoke all on function public.user_community_space_ids(uuid) from public, anon, authenticated;

create or replace function public.my_community_space_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select * from public.user_community_space_ids(auth.uid());
$$;

revoke all on function public.my_community_space_ids() from public, anon;
grant execute on function public.my_community_space_ids() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 9) my_community_spaces() — everything the client switcher needs in one call:
--    accessible spaces, capability flags, an eligible-member count per space
--    (derived, small scale), and which space is the caller's default (their
--    premium space if any, else General).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.my_community_spaces()
returns table (
  id uuid, slug text, kind text, name text, batch_code text,
  member_posting boolean, member_comments boolean, member_reactions boolean,
  member_count bigint, is_default boolean
)
language sql stable security definer set search_path = public
as $$
  with mine as (
    select t.sid from public.user_community_space_ids(auth.uid()) as t(sid)
  ),
  valid_subs as (
    select distinct on (s.user_id) s.user_id, s.plan_key, s.batch_id
      from public.subscriptions s
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.user_id, s.created_at desc
  ),
  eligible as (
    -- non-admin members with a live term…
    select v.user_id, coalesce(ep.community_segment, 'general') as segment, v.batch_id
      from valid_subs v
      join public.profiles p on p.id = v.user_id
      left join public.enrollment_plans ep on ep.key = v.plan_key
     where (p.approval_status = 'approved' or p.is_admin)
    union
    -- …plus legacy grandfathers (is_paid, zero subscription rows → General).
    select p.id, 'general', null::uuid
      from public.profiles p
     where p.is_paid
       and (p.approval_status = 'approved' or p.is_admin)
       and not exists (select 1 from public.subscriptions s2 where s2.user_id = p.id)
  ),
  my_default as (
    select coalesce(
      (select sp.id
         from public.community_spaces sp
         join valid_subs v on v.user_id = auth.uid()
         join public.enrollment_plans ep on ep.key = v.plan_key
        where sp.kind = ep.community_segment
          and sp.kind <> 'general'
          and sp.batch_id = v.batch_id
          and sp.active
        limit 1),
      (select sp.id from public.community_spaces sp where sp.kind = 'general' limit 1)
    ) as space_id
  )
  select sp.id, sp.slug, sp.kind, sp.name, b.code as batch_code,
         sp.member_posting, sp.member_comments, sp.member_reactions,
         (select count(*)
            from eligible e
           where case when sp.kind = 'general' then true
                      else e.segment = sp.kind and e.batch_id = sp.batch_id end)::bigint
           as member_count,
         (sp.id = (select space_id from my_default)) as is_default
    from public.community_spaces sp
    left join public.batches b on b.id = sp.batch_id
   where sp.id in (select sid from mine)
   order by (sp.kind = 'general') desc, b.code desc nulls last, sp.kind;
$$;

revoke all on function public.my_community_spaces() from public, anon;
grant execute on function public.my_community_spaces() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 10) RLS for the new tables. batches_read is deliberately NOT enrollment-
--     gated: a signed-in student on the paywall must list OPEN batches to pick
--     one at checkout, and a member of a since-closed batch must still resolve
--     its name in the membership panel (the own-subscription branch).
-- ───────────────────────────────────────────────────────────────────
alter table public.batches          enable row level security;
alter table public.community_spaces enable row level security;
alter table public.batch_events     enable row level security;

drop policy if exists batches_read on public.batches;
create policy batches_read on public.batches
  for select to authenticated
  using ((select public.is_admin())
      or status = 'open'
      -- batches.id MUST be qualified: unqualified `id` inside this subquery
      -- would bind to subscriptions.id (innermost scope wins) and the branch
      -- would silently never match.
      or exists (select 1 from public.subscriptions s
                  where s.batch_id = batches.id and s.user_id = (select auth.uid())));

drop policy if exists batches_admin_all on public.batches;
create policy batches_admin_all on public.batches
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists community_spaces_read on public.community_spaces;
create policy community_spaces_read on public.community_spaces
  for select to authenticated
  using ((select public.is_admin())
      or (active and id in (select public.my_community_space_ids())));

drop policy if exists community_spaces_admin_all on public.community_spaces;
create policy community_spaces_admin_all on public.community_spaces
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists batch_events_admin_select on public.batch_events;
create policy batch_events_admin_select on public.batch_events
  for select to authenticated
  using ((select public.is_admin()));

drop policy if exists batch_events_admin_insert on public.batch_events;
create policy batch_events_admin_insert on public.batch_events
  for insert to authenticated
  with check ((select public.is_admin()));
-- No update/delete policies — the audit trail is immutable via the API.

-- Students may reference only an OPEN batch on their own pending request
-- (still student-declared — admin_finalize_enrollment() is the authority).
drop policy if exists enroll_req_own_insert on public.enrollment_requests;
create policy enroll_req_own_insert on public.enrollment_requests
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and status = 'pending_review'
          and (batch_id is null
               or exists (select 1 from public.batches b
                           where b.id = batch_id and b.status = 'open')));

-- ───────────────────────────────────────────────────────────────────
-- 11) community_posts_guard() — replaced: same freezes as before PLUS
--     space_id handling. INSERT: a null space_id is filled with General so the
--     pre-deploy client (which doesn't send it) keeps publishing. UPDATE:
--     space_id is frozen for EVERYONE inside the client-originated branch —
--     posts never move between spaces via the API (SQL editor only: the
--     auth.uid() IS NULL escape hatch, which backfills and the depth-2 rollup
--     already use, still applies).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_posts_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members: a client-forged future date
    -- would launder into last_activity_at below and self-pin the post
    -- above the whole activity-sorted feed.
    if not public.is_admin() then
      new.created_at := now();
    end if;
    if new.space_id is null then
      select id into new.space_id from public.community_spaces where kind = 'general';
    end if;
    new.comment_count    := 0;
    new.last_activity_at := coalesce(new.created_at, now());
    if not public.is_admin() then
      new.pinned := false;
    end if;
    if exists (select 1 from public.community_tags t
                where t.slug = new.tag_slug and t.admin_only) then
      new.comments_locked := true;
    elsif not public.is_admin() then
      new.comments_locked := false;
    end if;
  else
    -- Freeze only client-originated updates (see comment above).
    if pg_trigger_depth() <= 1 and auth.uid() is not null then
      if not public.is_admin() then
        new.pinned           := old.pinned;
        new.comments_locked  := old.comments_locked;
      end if;
      new.comment_count    := old.comment_count;
      new.last_activity_at := old.last_activity_at;
      new.space_id         := old.space_id;   -- immutable after creation
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.community_posts_guard() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 12) community_comment_space() — comments inherit the parent post's space,
--     server-side (never trusted from the client) and frozen on update. The
--     denorm exists so the comments realtime channel can filter by space_id
--     (postgres_changes filters only see columns of the published table) and
--     so notification policies stay index-direct.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_comment_space()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    select p.space_id into new.space_id
      from public.community_posts p where p.id = new.post_id;
  elsif auth.uid() is not null and pg_trigger_depth() <= 1 then
    new.space_id := old.space_id;                 -- frozen for every client write
  else
    -- No-JWT SQL-editor / service-role update: the SAME escape hatch
    -- community_posts_guard() uses for moving a post between spaces. Re-derive
    -- from the parent so a moved thread's replies follow it instead of
    -- desyncing (stale replies would otherwise stay visible to the old space).
    select p.space_id into new.space_id
      from public.community_posts p where p.id = new.post_id;
  end if;
  return new;
end;
$$;

revoke all on function public.community_comment_space() from public, anon, authenticated;

drop trigger if exists community_comments_space on public.community_comments;
create trigger community_comments_space
  before insert or update on public.community_comments
  for each row execute function public.community_comment_space();

-- ───────────────────────────────────────────────────────────────────
-- 13) Notify triggers — replaced: identical mention regex / cap-10 /
--     mentionable-target / unread-collapse / reply rules (keep the client
--     COMMUNITY_MENTION_SRC regex in lockstep), PLUS:
--       • every notification row is stamped with the content's space_id;
--       • a mentioned member who cannot access that space is silently
--         DROPPED — cross-space mention markup notifies nobody.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_notify_on_comment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_name   text;
  v_actor_avatar text;
  v_post         record;
  v_title        text;
  v_done         uuid[] := array[]::uuid[];
  v_uid          uuid;
  m              text;
begin
  if new.status <> 'active' then return new; end if;
  select p.author_id, p.title, p.body into v_post
    from public.community_posts p where p.id = new.post_id;
  if v_post.author_id is null then return new; end if;
  select coalesce(nullif(trim(pr.full_name), ''), pr.email, 'Member'), pr.avatar_url
    into v_actor_name, v_actor_avatar
    from public.profiles pr where pr.id = new.author_id;
  v_title := left(coalesce(nullif(trim(v_post.title), ''), v_post.body), 120);

  for m in select (regexp_matches(new.body, '@\[[^\]]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g'))[1] loop
    exit when coalesce(array_length(v_done, 1), 0) >= 10;
    begin
      v_uid := m::uuid;
    exception when others then
      continue;
    end;
    if v_uid <> new.author_id
       and not (v_uid = any(v_done))
       -- Target must be MENTIONABLE (the search_community_members bar:
       -- named + approved-or-admin) — never an arbitrary/blocked uuid.
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       -- Target must be able to ACCESS this space — a cross-space uuid
       -- pasted into the body notifies nobody.
       and new.space_id in (select public.user_community_space_ids(v_uid))
       -- Collapse repeats: at most one UNREAD entry per actor/post/kind —
       -- this also caps the flood a scripted commenter could generate.
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.post_id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, comment_id, post_title, space_id)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar, new.post_id, new.id, v_title, new.space_id);
    end if;
  end loop;

  if v_post.author_id <> new.author_id and not (v_post.author_id = any(v_done))
     and not exists (select 1 from public.community_notifications n
                      where n.user_id = v_post.author_id and n.actor_id = new.author_id
                        and n.post_id = new.post_id and n.kind = 'reply'
                        and n.read_at is null) then
    insert into public.community_notifications
      (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, comment_id, post_title, space_id)
    values (v_post.author_id, 'reply', new.author_id, v_actor_name, v_actor_avatar, new.post_id, new.id, v_title, new.space_id);
  end if;
  return new;
end;
$$;

revoke all on function public.community_notify_on_comment() from public, anon, authenticated;

create or replace function public.community_notify_on_post()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_name   text;
  v_actor_avatar text;
  v_title        text;
  v_done         uuid[] := array[]::uuid[];
  v_uid          uuid;
  m              text;
begin
  if new.status <> 'active' then return new; end if;
  select coalesce(nullif(trim(pr.full_name), ''), pr.email, 'Member'), pr.avatar_url
    into v_actor_name, v_actor_avatar
    from public.profiles pr where pr.id = new.author_id;
  v_title := left(coalesce(nullif(trim(new.title), ''), new.body), 120);

  for m in select (regexp_matches(new.body, '@\[[^\]]{1,80}\]\(([0-9a-fA-F-]{36})\)', 'g'))[1] loop
    exit when coalesce(array_length(v_done, 1), 0) >= 10;
    begin
      v_uid := m::uuid;
    exception when others then
      continue;
    end;
    if v_uid <> new.author_id
       and not (v_uid = any(v_done))
       -- Same mentionable-target + space-access + unread-collapse rules as
       -- the comment trigger above.
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       and new.space_id in (select public.user_community_space_ids(v_uid))
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url, post_id, post_title, space_id)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar, new.id, v_title, new.space_id);
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.community_notify_on_post() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 14) Replaced RPCs.
--     community_category_counts(p_space_id default null) — STAYS SECURITY
--     INVOKER: community_posts_read RLS keeps scoping whatever the caller may
--     see, so the space filter is a narrowing convenience, not the boundary.
--     search_community_members(p_query, p_space_id default null) — the mention
--     directory is now per-space: the CALLER must have access to the space,
--     and every returned member must be currently eligible for that same
--     space (default = General). Never returns email.
--     Old signatures are DROPPED (PostgREST would otherwise see ambiguous
--     overloads); default params keep the old client's calls resolving.
-- ───────────────────────────────────────────────────────────────────
drop function if exists public.community_category_counts();
create or replace function public.community_category_counts(p_space_id uuid default null)
returns table (tag_slug text, n bigint)
language sql stable set search_path = public
as $$
  select p.tag_slug, count(*)::bigint
    from public.community_posts p
   where p.status = 'active'
     and (p_space_id is null or p.space_id = p_space_id)
   group by p.tag_slug;
$$;

revoke all on function public.community_category_counts(uuid) from public, anon;
grant execute on function public.community_category_counts(uuid) to authenticated;

drop function if exists public.search_community_members(text);
create or replace function public.search_community_members(p_query text, p_space_id uuid default null)
returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public
as $$
  with target as (
    select coalesce(p_space_id,
                    (select sp.id from public.community_spaces sp
                      where sp.kind = 'general' limit 1)) as space_id
  )
  select p.id, trim(p.full_name) as display_name, p.avatar_url
    from public.profiles p, target t
   where ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     -- The caller must have access to the requested space…
     and (p_space_id is null
          or p_space_id in (select public.my_community_space_ids()))
     and nullif(trim(p.full_name), '') is not null
     and (p.approval_status = 'approved' or p.is_admin)
     -- …and every hit must be a currently-eligible member of that space.
     and t.space_id in (select public.user_community_space_ids(p.id))
     and p.full_name ilike '%' || coalesce(p_query, '') || '%'
   order by trim(p.full_name)
   limit 8;
$$;

revoke all on function public.search_community_members(text, uuid) from public, anon;
grant execute on function public.search_community_members(text, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 15) Community RLS — space-aware rewrite. Minimal diff: the original
--     predicate text is preserved and the space/capability predicates are
--     ADDED (the membership function embeds approved+enrolled+grace, so the
--     original gates are now belt-and-braces — kept for review clarity).
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_posts_read on public.community_posts;
create policy community_posts_read on public.community_posts
  for select to authenticated
  using ((select public.is_admin())
      or (status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and space_id in (select public.my_community_space_ids())));

drop policy if exists community_posts_own_insert on public.community_posts;
create policy community_posts_own_insert on public.community_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and (select public.is_approved()) and (select public.is_enrolled())
    and space_id in (select public.my_community_space_ids())
    and exists (select 1 from public.community_spaces s
                 where s.id = space_id and s.member_posting)
    and not exists (select 1 from public.community_tags t
                    where t.slug = tag_slug and t.admin_only)
  );

drop policy if exists community_posts_own_update on public.community_posts;
create policy community_posts_own_update on public.community_posts
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())
           and space_id in (select public.my_community_space_ids()))))
  with check (
    author_id = (select auth.uid())
    and status in ('active','deleted')
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and space_id in (select public.my_community_space_ids())))
    and not exists (select 1 from public.community_tags t
                    where t.slug = tag_slug and t.admin_only)
  );

drop policy if exists community_comments_read on public.community_comments;
create policy community_comments_read on public.community_comments
  for select to authenticated
  using ((select public.is_admin())
      or (status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and space_id in (select public.my_community_space_ids())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active')));

-- Member comment INSERTs also require the parent SPACE to permit member
-- replies (General ships with member_comments = false → posts + reactions
-- only there; historical replies stay readable). Admins pass via admin_all.
drop policy if exists community_comments_own_insert on public.community_comments;
create policy community_comments_own_insert on public.community_comments
  for insert to authenticated
  with check (author_id = (select auth.uid())
          and status = 'active'
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      join public.community_spaces s on s.id = p.space_id
                      where p.id = post_id and p.status = 'active'
                        and not p.comments_locked
                        and s.member_comments
                        and p.space_id in (select public.my_community_space_ids())));

drop policy if exists community_comments_own_update on public.community_comments;
create policy community_comments_own_update on public.community_comments
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())
           and space_id in (select public.my_community_space_ids()))))
  with check (author_id = (select auth.uid()) and status in ('active','deleted')
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and space_id in (select public.my_community_space_ids()))));

drop policy if exists community_reactions_read on public.community_reactions;
create policy community_reactions_read on public.community_reactions
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and ((post_id is not null
                and exists (select 1 from public.community_posts p
                            where p.id = post_id and p.status = 'active'
                              and p.space_id in (select public.my_community_space_ids())))
            or (comment_id is not null
                and exists (select 1 from public.community_comments c
                            join public.community_posts p on p.id = c.post_id
                            where c.id = comment_id and c.status = 'active'
                              and p.status = 'active'
                              and p.space_id in (select public.my_community_space_ids()))))));

-- Reaction INSERTs check the target is visible IN AN ACCESSIBLE SPACE and the
-- space has reactions enabled. Reactions stay allowed on comments_locked
-- posts — announcements are react-only by design.
drop policy if exists community_reactions_own_insert on public.community_reactions;
create policy community_reactions_own_insert on public.community_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and ((post_id is not null
                and exists (select 1 from public.community_posts p
                            join public.community_spaces s on s.id = p.space_id
                            where p.id = post_id and p.status = 'active'
                              and s.member_reactions
                              and p.space_id in (select public.my_community_space_ids())))
            or (comment_id is not null
                and exists (select 1 from public.community_comments c
                            join public.community_posts p on p.id = c.post_id
                            join public.community_spaces s on s.id = p.space_id
                            where c.id = comment_id and c.status = 'active'
                              and p.status = 'active'
                              and s.member_reactions
                              and p.space_id in (select public.my_community_space_ids())))));

drop policy if exists community_notifications_own_select on public.community_notifications;
create policy community_notifications_own_select on public.community_notifications
  for select to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and (space_id is null or space_id in (select public.my_community_space_ids())));

drop policy if exists community_notifications_own_update on public.community_notifications;
create policy community_notifications_own_update on public.community_notifications
  for update to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and (space_id is null or space_id in (select public.my_community_space_ids())))
  with check (user_id = (select auth.uid()));

drop policy if exists community_announcement_reads_own_insert on public.community_announcement_reads;
create policy community_announcement_reads_own_insert on public.community_announcement_reads
  for insert to authenticated
  with check (user_id = (select auth.uid())
          and ((select public.is_admin())
            or ((select public.is_approved()) and (select public.is_enrolled())))
          and exists (select 1 from public.community_posts p
                       where p.id = post_id and p.status = 'active'
                         and p.space_id in (select public.my_community_space_ids())));

drop policy if exists community_attachments_read on public.community_attachments;
create policy community_attachments_read on public.community_attachments
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active'
                        and p.space_id in (select public.my_community_space_ids()))));

drop policy if exists community_attachments_own_insert on public.community_attachments;
create policy community_attachments_own_insert on public.community_attachments
  for insert to authenticated
  with check (uploader_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.author_id = (select auth.uid())
                        and p.space_id in (select public.my_community_space_ids())));

drop policy if exists community_post_tags_read on public.community_post_tags;
create policy community_post_tags_read on public.community_post_tags
  for select to authenticated
  using ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.status = 'active'
                        and p.space_id in (select public.my_community_space_ids()))));

drop policy if exists community_post_tags_own_insert on public.community_post_tags;
create policy community_post_tags_own_insert on public.community_post_tags
  for insert to authenticated
  with check ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = post_id and p.author_id = (select auth.uid())
                        and p.space_id in (select public.my_community_space_ids())));

drop policy if exists community_post_tags_own_delete on public.community_post_tags;
create policy community_post_tags_own_delete on public.community_post_tags
  for delete to authenticated
  using (((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())));

-- ───────────────────────────────────────────────────────────────────
-- 16) Storage — community-media. READ authorization stays attachment-join
--     based (never path based), so every legacy <uid>/… file keeps working;
--     the join simply gains the space predicate. WRITE/DELETE accept BOTH
--     path shapes: legacy <uid>/… and the new <space_id>/<uid>/… (the new
--     client uploads under the space prefix; the space segment must be one
--     the uploader can access).
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_media_read on storage.objects;
create policy community_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'community-media'
    and ((select public.is_admin())
      or ((select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_attachments a
                      join public.community_posts p on p.id = a.post_id
                      where a.storage_path = name and p.status = 'active'
                        and p.space_id in (select public.my_community_space_ids())))));

drop policy if exists community_media_own_insert on storage.objects;
create policy community_media_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'community-media'
    and (select public.is_approved()) and (select public.is_enrolled())
    and ((storage.foldername(name))[1] = (select auth.uid())::text
      or ((storage.foldername(name))[2] = (select auth.uid())::text
          and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and ((storage.foldername(name))[1])::uuid in (select public.my_community_space_ids()))));

drop policy if exists community_media_delete on storage.objects;
create policy community_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'community-media'
    and ((storage.foldername(name))[1] = (select auth.uid())::text
      or (storage.foldername(name))[2] = (select auth.uid())::text
      or (select public.is_admin())));

-- ───────────────────────────────────────────────────────────────────
-- 17) admin_finalize_enrollment() — the ONE transactional approval. Validates
--     everything TOGETHER (request status, plan, batch, capacity), then wraps
--     the existing term RPCs so stacking/supersede/grace/clamp math stays in
--     exactly one place, then stamps batch + profile cache + request row.
--     All-or-nothing: any raise rolls the whole approval back and the request
--     stays pending_review (retryable). Replaces the client's 3-step approve
--     AND its local-grant fallback (which could bypass batch validation).
--
--     Batch resolution (premium segments only; 'general' plans always NULL —
--     an upgrade DOWN to a general plan clears private visibility):
--       explicit p_batch_id
--       → renewal/extension: the current subscription's batch
--       → upgrade: the current batch IF the target segment has an active
--         space there (gold↔vip same-batch switch), else fall through
--       → the batch chosen at checkout (request.batch_id)
--       → error: 'select an open batch'.
--     Extensions must NOT move batches (p_batch_id ≠ current → error).
--     A NEW batch assignment requires the batch OPEN; staying in the same
--     batch is allowed unless the batch is archived. Capacity (if set) is
--     counted under a FOR UPDATE batch lock — concurrency-safe.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_finalize_enrollment(
  p_request_id uuid,
  p_batch_id   uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_req       public.enrollment_requests%rowtype;
  v_prev      public.subscriptions%rowtype;
  v_new       public.subscriptions%rowtype;
  v_plan      public.enrollment_plans%rowtype;
  v_kind      text;
  v_eff_plan  text;
  v_segment   text;
  v_prev_segment text;
  v_batch     uuid;
  v_batch_row public.batches%rowtype;
  v_new_assignment boolean;
  v_cap       int;
  v_used      int;
begin
  if not public.is_admin() then
    raise exception 'admin_finalize_enrollment: admin only';
  end if;

  select * into v_req from public.enrollment_requests
   where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'admin_finalize_enrollment: request not found';
  end if;

  -- Idempotency: re-approving an approved request is a no-op.
  if v_req.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_req.status <> 'pending_review' then
    raise exception 'admin_finalize_enrollment: request is % — only pending_review can be approved', v_req.status;
  end if;

  v_kind := coalesce(v_req.request_kind, 'new');

  select * into v_prev from public.subscriptions
   where user_id = v_req.user_id
   order by created_at desc limit 1;

  -- Effective plan: extensions stay on the member's CURRENT plan.
  v_eff_plan := case when v_kind = 'extension'
                     then coalesce(v_prev.plan_key, v_req.plan_key)
                     else v_req.plan_key end;

  select * into v_plan from public.enrollment_plans where key = v_eff_plan;
  if v_plan.key is null then
    raise exception 'admin_finalize_enrollment: unknown plan %', v_eff_plan;
  end if;
  -- New sales require a sellable plan; extensions may continue a retired one.
  if v_kind <> 'extension' and not v_plan.active then
    raise exception 'admin_finalize_enrollment: plan % is inactive', v_eff_plan;
  end if;

  v_segment := coalesce(v_plan.community_segment, 'general');
  -- The segment the member is CURRENTLY in — a gold→vip (or vip→gold) move is a
  -- new seat even when the batch is unchanged (see v_new_assignment below).
  if v_prev.plan_key is not null then
    select coalesce(ep.community_segment, 'general') into v_prev_segment
      from public.enrollment_plans ep where ep.key = v_prev.plan_key;
  end if;

  if v_segment not in ('gold', 'vip') then
    v_batch := null;
  else
    if v_kind in ('renewal', 'extension') then
      v_batch := coalesce(p_batch_id, v_prev.batch_id, v_req.batch_id);
      if v_kind = 'extension' and p_batch_id is not null
         and v_prev.batch_id is not null and p_batch_id <> v_prev.batch_id then
        raise exception 'admin_finalize_enrollment: an extension keeps the current batch — use the batch manager to move members';
      end if;
    elsif v_kind = 'upgrade' then
      v_batch := p_batch_id;
      if v_batch is null and v_prev.batch_id is not null
         and exists (select 1 from public.community_spaces sp
                      where sp.kind = v_segment and sp.batch_id = v_prev.batch_id and sp.active) then
        v_batch := v_prev.batch_id;
      end if;
      if v_batch is null then v_batch := v_req.batch_id; end if;
    else
      v_batch := coalesce(p_batch_id, v_req.batch_id);
    end if;

    if v_batch is null then
      raise exception 'admin_finalize_enrollment: % needs a batch — pick an open batch in the approve dialog', v_eff_plan;
    end if;

    select * into v_batch_row from public.batches where id = v_batch for update;
    if v_batch_row.id is null then
      raise exception 'admin_finalize_enrollment: batch not found';
    end if;

    -- A NEW assignment = no prior term, a different batch, OR a different
    -- segment in the same batch (gold→vip takes a VIP seat it never held, so
    -- it must pass the open-batch + VIP-capacity checks like any new member).
    v_new_assignment := (v_prev.id is null
                         or v_prev.batch_id is distinct from v_batch
                         or v_prev_segment is distinct from v_segment);
    if v_batch_row.status = 'archived' then
      raise exception 'admin_finalize_enrollment: batch % is archived', v_batch_row.code;
    end if;
    if v_new_assignment and v_batch_row.status <> 'open' then
      raise exception 'admin_finalize_enrollment: batch % is closed to new assignments', v_batch_row.code;
    end if;
    if not exists (select 1 from public.community_spaces sp
                    where sp.kind = v_segment and sp.batch_id = v_batch and sp.active) then
      raise exception 'admin_finalize_enrollment: batch % has no active % space', v_batch_row.code, v_segment;
    end if;

    v_cap := case v_segment when 'gold' then v_batch_row.gold_capacity
                            else v_batch_row.vip_capacity end;
    if v_cap is not null and v_new_assignment then
      select count(*) into v_used
        from public.subscriptions s
        join public.enrollment_plans ep on ep.key = s.plan_key
       where s.status = 'active'
         and s.batch_id = v_batch
         and ep.community_segment = v_segment
         and s.user_id <> v_req.user_id
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());
      if v_used >= v_cap then
        raise exception 'admin_finalize_enrollment: batch % is full for % (% of % seats)', v_batch_row.code, v_segment, v_used, v_cap;
      end if;
    end if;
  end if;

  -- Grant the term through the EXISTING functions (stacking / supersede /
  -- grace / 60–365 clamp / legacy-lifetime guard all live there).
  if v_kind = 'extension' then
    if v_req.extension_days is null or v_req.extension_days <= 0 then
      raise exception 'admin_finalize_enrollment: extension request has no extension_days';
    end if;
    v_new := public.approve_extension(v_req.user_id, v_req.id, v_req.extension_days);
  else
    v_new := public.approve_subscription(v_req.user_id, v_req.plan_key, v_req.id);
  end if;

  update public.subscriptions
     set batch_id = v_batch, updated_at = now()
   where id = v_new.id;

  -- Profile cache (mirrors the old client step ②).
  update public.profiles
     set is_paid = true,
         plan = v_eff_plan,
         approval_status = 'approved',
         approved_at = now(),
         approved_by = auth.uid(),
         rejected_at = null,
         rejected_by = null,
         rejection_reason = null,
         updated_at = now()
   where id = v_req.user_id;

  -- Request row (mirrors the old client step ③) + the resolved batch.
  update public.enrollment_requests
     set status = 'approved',
         rejection_reason = null,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         batch_id = v_batch,
         updated_at = now()
   where id = v_req.id;

  return jsonb_build_object(
    'ok', true,
    'subscription_id', v_new.id,
    'ends_at', v_new.ends_at,
    'batch_id', v_batch,
    'batch_code', (select code from public.batches where id = v_batch)
  );
end;
$$;

revoke all on function public.admin_finalize_enrollment(uuid, uuid) from public, anon;
grant execute on function public.admin_finalize_enrollment(uuid, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 18) admin_assign_batch() — the "needs batch assignment" queue action:
--     idempotent bulk (re)assignment of ACTIVE premium subscriptions into an
--     OPEN batch, capacity-checked under the batch lock, one audit row per
--     actual change. Skips (with a reason) rather than fails per member.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_assign_batch(
  p_user_ids uuid[],
  p_batch_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_batch    public.batches%rowtype;
  v_uid      uuid;
  v_sub      record;
  v_segment  text;
  v_cap      int;
  v_used     int;
  v_assigned int := 0;
  v_skipped  jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_assign_batch: admin only';
  end if;

  select * into v_batch from public.batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'admin_assign_batch: batch not found';
  end if;
  if v_batch.status <> 'open' then
    raise exception 'admin_assign_batch: batch % is % — only open batches accept assignments', v_batch.code, v_batch.status;
  end if;

  foreach v_uid in array p_user_ids loop
    select s.id, s.batch_id, s.plan_key, ep.community_segment
      into v_sub
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = v_uid and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc limit 1;

    if v_sub.id is null then
      v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_active_subscription');
      continue;
    end if;
    v_segment := coalesce(v_sub.community_segment, 'general');
    if v_segment not in ('gold', 'vip') then
      v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'not_a_premium_plan');
      continue;
    end if;
    if v_sub.batch_id = p_batch_id then
      v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'already_assigned');
      continue;
    end if;
    if not exists (select 1 from public.community_spaces sp
                    where sp.kind = v_segment and sp.batch_id = p_batch_id and sp.active) then
      v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_space_for_segment');
      continue;
    end if;

    v_cap := case v_segment when 'gold' then v_batch.gold_capacity else v_batch.vip_capacity end;
    if v_cap is not null then
      select count(*) into v_used
        from public.subscriptions s
        join public.enrollment_plans ep on ep.key = s.plan_key
       where s.status = 'active' and s.batch_id = p_batch_id
         and ep.community_segment = v_segment
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());
      if v_used >= v_cap then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'batch_full');
        continue;
      end if;
    end if;

    update public.subscriptions
       set batch_id = p_batch_id, updated_at = now()
     where id = v_sub.id;

    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (p_batch_id, v_uid, auth.uid(),
            case when v_sub.batch_id is null then 'assign' else 'reassign' end,
            jsonb_build_object('subscription_id', v_sub.id, 'segment', v_segment,
                               'from_batch_id', v_sub.batch_id, 'to_batch_id', p_batch_id));
    v_assigned := v_assigned + 1;
  end loop;

  return jsonb_build_object('ok', true, 'assigned', v_assigned, 'skipped', v_skipped);
end;
$$;

revoke all on function public.admin_assign_batch(uuid[], uuid) from public, anon;
grant execute on function public.admin_assign_batch(uuid[], uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 19) admin_batch_overview() — per-batch active enrollment counts vs
--     capacity for the batch manager table. (The "needs batch assignment"
--     queue is a plain admin REST query — premium-segment active subs with
--     batch_id IS NULL — so it isn't duplicated here.)
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_batch_overview()
returns table (
  batch_id uuid, code text, name text, status text,
  starts_on date, ends_on date,
  gold_active bigint, vip_active bigint,
  gold_capacity int, vip_capacity int
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_batch_overview: admin only';
  end if;
  return query
  select b.id, b.code, b.name, b.status, b.starts_on, b.ends_on,
         count(*) filter (where ep.community_segment = 'gold')::bigint as gold_active,
         count(*) filter (where ep.community_segment = 'vip')::bigint  as vip_active,
         b.gold_capacity, b.vip_capacity
    from public.batches b
    left join public.subscriptions s
      on s.batch_id = b.id and s.status = 'active'
     and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
    left join public.enrollment_plans ep on ep.key = s.plan_key
   group by b.id
   order by b.code desc;
end;
$$;

revoke all on function public.admin_batch_overview() from public, anon;
grant execute on function public.admin_batch_overview() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 20) Refresh PostgREST's schema cache so the new tables/columns/RPCs are
--     visible immediately.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   1. Verify:  select code, status from public.batches;
--               select slug, kind, member_comments from public.community_spaces order by slug;
--               select count(*) from public.community_posts where space_id is null;   -- 0
--   2. Deploy the matching client build (space switcher, batch pickers,
--      single-RPC approve, admin batch manager).
--   3. Admin → Batches: confirm "August 2026" (2026-08) + set capacities if
--      you want seat limits enforced at approval.
--   4. Existing premium members granted OUTSIDE admin_finalize_enrollment
--      (SQL editor / imports without batch_code) appear in the "Needs batch
--      assignment" queue — assign them from the batch manager.
-- ═══════════════════════════════════════════════════════════════════

-- Record this migration (see db/2026-07-26-schema-migrations-log.sql #31).
insert into public.schema_migrations (filename, checksum, notes)
values ('2026-07-28-community-spaces-batches.sql', null,
        'community spaces + batches (#32); checksum of the repo file — see git')
on conflict (filename) do nothing;

-- ═══════════════════════════════════════════════════════════════════
-- #33 — Community batch hardening (follow-up to #32)
--
-- WHY
--   Independent review of #32 (already applied to production) surfaced four
--   correctness/robustness gaps. All are additive fixes to objects #32 created;
--   nothing here changes the segmentation model or the access matrix.
--
-- WHAT
--   1. admin_finalize_enrollment(): the capacity + closed-batch checks keyed on
--      "is the batch/segment CHANGING?" when the real question is "does this
--      member currently OCCUPY a counted seat?". A member whose term expired
--      still matched their old batch+segment, so renewing them skipped both the
--      open-batch check and the seat count — while their expired row was NOT
--      counted in v_used. A 10-seat batch could reach 11 active members, and a
--      closed batch silently accepted returning members.
--   2. community_attachments_own_insert did not constrain storage_path. Because
--      community_media_read authorizes an object by "some attachment row on a
--      visible post points at this path", a member could create an attachment on
--      their OWN General post pointing at a Gold object path and unlock reads on
--      it. Not exploitable today (paths carry a random uuid and are unlistable),
--      but it made path secrecy load-bearing for the privacy boundary.
--   3. search_community_members() called the SECURITY DEFINER SRF
--      user_community_space_ids(p.id) once per candidate row. p_query = '' matches
--      every profile, and the RPC is directly callable by any member.
--   4. Minor hardening: notifications UPDATE narrowed to read_at (a member could
--      null their own space_id, which the SELECT policy treats as visible);
--      the three own-DELETE policies brought into the space model; a month-range
--      CHECK on batches.code; the missing FK index; and a safer uuid cast.
--
-- ORDER
--   Run AFTER db/2026-07-28-community-spaces-batches.sql (#32).
--   Idempotent and re-runnable. Additive only — no data is modified except the
--   batches.code CHECK (validated against existing rows before it is added).
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Guards
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.batches') is null or to_regclass('public.community_spaces') is null then
    raise exception '#33 requires db/2026-07-28-community-spaces-batches.sql (#32) first.';
  end if;
  if to_regproc('public.admin_finalize_enrollment') is null then
    raise exception '#33 requires admin_finalize_enrollment (#32) first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#33 requires db/2026-07-26-schema-migrations-log.sql (#31) first — the tail insert would otherwise abort the whole migration.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) admin_finalize_enrollment — seat-occupancy semantics.
--
--    ⚠ SUPERSEDED BY #34 (db/2026-07-29-batch-hardening-followup.sql).
--    This version's tail was reconstructed rather than copied from #32 and
--    silently dropped `updated_at = now()` (×3), `rejected_at`/`rejected_by`
--    clearing, `rejection_reason = null` on the request, and changed
--    `approved_at`/`approved_by` to first-approval semantics. #34 restores
--    #32's body verbatim and re-applies ONLY the v_holds_seat change below.
--    If you are applying this file fresh, apply #34 immediately after.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_finalize_enrollment(
  p_request_id uuid,
  p_batch_id   uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_req       public.enrollment_requests%rowtype;
  v_prev      public.subscriptions%rowtype;
  v_new       public.subscriptions%rowtype;
  v_plan      public.enrollment_plans%rowtype;
  v_kind      text;
  v_eff_plan  text;
  v_segment   text;
  v_prev_segment text;
  v_batch     uuid;
  v_batch_row public.batches%rowtype;
  v_holds_seat boolean;
  v_new_assignment boolean;
  v_cap       int;
  v_used      int;
  v_code      text;
begin
  if not public.is_admin() then
    raise exception 'admin_finalize_enrollment: admin only';
  end if;

  select * into v_req from public.enrollment_requests
   where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'admin_finalize_enrollment: request not found';
  end if;

  -- Idempotency: re-approving an approved request is a no-op.
  if v_req.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_req.status <> 'pending_review' then
    raise exception 'admin_finalize_enrollment: request is % — only pending_review can be approved', v_req.status;
  end if;

  v_kind := coalesce(v_req.request_kind, 'new');

  select * into v_prev from public.subscriptions
   where user_id = v_req.user_id
   order by created_at desc limit 1;

  -- Effective plan: extensions stay on the member's CURRENT plan.
  v_eff_plan := case when v_kind = 'extension'
                     then coalesce(v_prev.plan_key, v_req.plan_key)
                     else v_req.plan_key end;

  select * into v_plan from public.enrollment_plans where key = v_eff_plan;
  if v_plan.key is null then
    raise exception 'admin_finalize_enrollment: unknown plan %', v_eff_plan;
  end if;
  -- New sales require a sellable plan; extensions may continue a retired one.
  if v_kind <> 'extension' and not v_plan.active then
    raise exception 'admin_finalize_enrollment: plan % is inactive', v_eff_plan;
  end if;

  v_segment := coalesce(v_plan.community_segment, 'general');
  if v_prev.plan_key is not null then
    select coalesce(ep.community_segment, 'general') into v_prev_segment
      from public.enrollment_plans ep where ep.key = v_prev.plan_key;
  end if;

  if v_segment not in ('gold', 'vip') then
    v_batch := null;
  else
    if v_kind in ('renewal', 'extension') then
      v_batch := coalesce(p_batch_id, v_prev.batch_id, v_req.batch_id);
      if v_kind = 'extension' and p_batch_id is not null
         and v_prev.batch_id is not null and p_batch_id <> v_prev.batch_id then
        raise exception 'admin_finalize_enrollment: an extension keeps the current batch — use the batch manager to move members';
      end if;
    elsif v_kind = 'upgrade' then
      v_batch := p_batch_id;
      if v_batch is null and v_prev.batch_id is not null
         and exists (select 1 from public.community_spaces sp
                      where sp.kind = v_segment and sp.batch_id = v_prev.batch_id and sp.active) then
        v_batch := v_prev.batch_id;
      end if;
      if v_batch is null then v_batch := v_req.batch_id; end if;
    else
      v_batch := coalesce(p_batch_id, v_req.batch_id);
    end if;

    if v_batch is null then
      raise exception 'admin_finalize_enrollment: % needs a batch — pick an open batch in the approve dialog', v_eff_plan;
    end if;

    select * into v_batch_row from public.batches where id = v_batch for update;
    if v_batch_row.id is null then
      raise exception 'admin_finalize_enrollment: batch not found';
    end if;

    -- #33: does this member CURRENTLY occupy a seat in this batch+segment? The
    -- predicate deliberately mirrors the v_used count below (status + the
    -- is_enrolled() date math), because the two answer the same question from
    -- opposite sides. Keying on "is the batch changing?" instead — as #32 did —
    -- let an EXPIRED member of this batch renew while being counted by nobody:
    -- they skipped the open-batch and capacity checks, yet their expired row was
    -- excluded from v_used, so the batch could exceed its stated capacity.
    v_holds_seat := (v_prev.id is not null
                     and v_prev.status = 'active'
                     and (v_prev.ends_at is null or coalesce(v_prev.grace_ends_at, v_prev.ends_at) > now())
                     and v_prev.batch_id is not distinct from v_batch
                     and v_prev_segment is not distinct from v_segment);
    v_new_assignment := not v_holds_seat;

    if v_batch_row.status = 'archived' then
      raise exception 'admin_finalize_enrollment: batch % is archived', v_batch_row.code;
    end if;
    if v_new_assignment and v_batch_row.status <> 'open' then
      raise exception 'admin_finalize_enrollment: batch % is closed to new assignments', v_batch_row.code;
    end if;
    if not exists (select 1 from public.community_spaces sp
                    where sp.kind = v_segment and sp.batch_id = v_batch and sp.active) then
      raise exception 'admin_finalize_enrollment: batch % has no active % space', v_batch_row.code, v_segment;
    end if;

    v_cap := case v_segment when 'gold' then v_batch_row.gold_capacity
                            else v_batch_row.vip_capacity end;
    if v_cap is not null and v_new_assignment then
      select count(*) into v_used
        from public.subscriptions s
        join public.enrollment_plans ep on ep.key = s.plan_key
       where s.status = 'active'
         and s.batch_id = v_batch
         and ep.community_segment = v_segment
         and s.user_id <> v_req.user_id
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());
      if v_used >= v_cap then
        raise exception 'admin_finalize_enrollment: batch % is full for % (% of % seats)', v_batch_row.code, v_segment, v_used, v_cap;
      end if;
    end if;
  end if;

  -- Grant the term through the EXISTING functions (stacking / supersede /
  -- grace / 60–365 clamp / legacy-lifetime guard all live there).
  if v_kind = 'extension' then
    if v_req.extension_days is null or v_req.extension_days <= 0 then
      raise exception 'admin_finalize_enrollment: extension request has no extension_days';
    end if;
    perform public.approve_extension(v_req.user_id, p_request_id, v_req.extension_days);
  else
    perform public.approve_subscription(v_req.user_id, v_eff_plan, p_request_id);
  end if;

  select * into v_new from public.subscriptions
   where user_id = v_req.user_id
   order by created_at desc limit 1;

  -- Stamp the batch on the granted term (no triggers on subscriptions).
  if v_new.id is not null then
    update public.subscriptions set batch_id = v_batch where id = v_new.id;
  end if;

  -- Profile cache (is_paid/plan are caches; is_enrolled() is the authority).
  update public.profiles
     set is_paid = true,
         plan = v_eff_plan,
         approval_status = 'approved',
         approved_at = coalesce(approved_at, now()),
         approved_by = coalesce(approved_by, auth.uid()),
         rejection_reason = null
   where id = v_req.user_id;

  update public.enrollment_requests
     set status = 'approved',
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         batch_id = v_batch
   where id = p_request_id;

  select code into v_code from public.batches where id = v_batch;

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'subscription_id', v_new.id,
    'ends_at', v_new.ends_at,
    'batch_id', v_batch,
    'batch_code', v_code
  );
end $$;

revoke all on function public.admin_finalize_enrollment(uuid, uuid) from public, anon;
grant execute on function public.admin_finalize_enrollment(uuid, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 2) community_attachments_own_insert — bind storage_path to the uploader
--    and (for new-style paths) to the post's space, so an attachment row can
--    never be pointed at another space's object to unlock reads on it.
--    Both path shapes stay valid: legacy <uid>/… and #32's <space_id>/<uid>/…
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_attachments_own_insert on public.community_attachments;
create policy community_attachments_own_insert on public.community_attachments
  for insert to authenticated
  with check (uploader_id = (select auth.uid())
          and (select public.is_approved()) and (select public.is_enrolled())
          and exists (select 1 from public.community_posts p
                      where p.id = community_attachments.post_id
                        and p.author_id = (select auth.uid())
                        and p.space_id in (select public.my_community_space_ids())
                        and (community_attachments.storage_path is null
                             or (storage.foldername(community_attachments.storage_path))[1] = (select auth.uid())::text
                             or ((storage.foldername(community_attachments.storage_path))[1] = p.space_id::text
                                 and (storage.foldername(community_attachments.storage_path))[2] = (select auth.uid())::text))));

-- ───────────────────────────────────────────────────────────────────
-- 3) search_community_members — set-based eligibility instead of a
--    SECURITY DEFINER SRF invoked once per candidate row.
--    Same contract: name + avatar only (NEVER email), ≤8 rows, caller must
--    have access to the space, hits must be currently-eligible members of it.
--    Admins stay mentionable everywhere (matching #32, where
--    user_community_space_ids returns every space for an admin).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.search_community_members(
  p_query    text,
  p_space_id uuid default null
)
returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public
as $$
  with target as (
    select coalesce(p_space_id,
                    (select sp.id from public.community_spaces sp
                      where sp.kind = 'general' limit 1)) as space_id
  ),
  tgt as (
    select sp.id, sp.kind, sp.batch_id
      from public.community_spaces sp, target t
     where sp.id = t.space_id
  ),
  valid_subs as (
    select distinct on (s.user_id) s.user_id, s.plan_key, s.batch_id
      from public.subscriptions s
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.user_id, s.created_at desc
  ),
  eligible as (
    select v.user_id, coalesce(ep.community_segment, 'general') as segment, v.batch_id
      from valid_subs v
      join public.profiles p on p.id = v.user_id
      left join public.enrollment_plans ep on ep.key = v.plan_key
     where (p.approval_status = 'approved' or p.is_admin)
    union
    -- legacy grandfathers (is_paid, zero subscription rows → General)
    select p.id, 'general', null::uuid
      from public.profiles p
     where p.is_paid
       and (p.approval_status = 'approved' or p.is_admin)
       and not exists (select 1 from public.subscriptions s2 where s2.user_id = p.id)
  )
  select p.id, trim(p.full_name) as display_name, p.avatar_url
    from public.profiles p
    left join eligible e on e.user_id = p.id
    cross join tgt
   where ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     -- The caller must have access to the requested space…
     and (p_space_id is null
          or p_space_id in (select public.my_community_space_ids()))
     and nullif(trim(p.full_name), '') is not null
     and (p.approval_status = 'approved' or p.is_admin)
     -- …and every hit must be an admin (mentionable everywhere) or a currently
     -- eligible member of THIS space.
     and (p.is_admin
          or (e.user_id is not null
              and case when tgt.kind = 'general' then true
                       else e.segment = tgt.kind and e.batch_id = tgt.batch_id end))
     and p.full_name ilike '%' || coalesce(p_query, '') || '%'
   order by trim(p.full_name)
   limit 8;
$$;

revoke all on function public.search_community_members(text, uuid) from public, anon;
grant execute on function public.search_community_members(text, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 4) Notifications — a member may only mark their own row read.
--    The #32 UPDATE policy pinned user_id but left every other column writable,
--    so a member could null their own space_id, which the SELECT policy
--    (space_id is null or space_id in …) then treats as visible. Column-level
--    privileges are the right tool; the policy stays as the row-level guard.
-- ───────────────────────────────────────────────────────────────────
revoke update on public.community_notifications from authenticated;
grant update (read_at) on public.community_notifications to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 5) Own-DELETE policies — bring the last three into the space model, so a
--    member who has left a space cannot keep deleting their rows inside it.
--    (Own rows only, so this was never a read leak — just an inconsistency
--    with the SELECT/INSERT/UPDATE policies #32 already scoped.)
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_post_tags_own_delete on public.community_post_tags;
create policy community_post_tags_own_delete on public.community_post_tags
  for delete to authenticated
  using (((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and exists (select 1 from public.community_posts p
                 where p.id = community_post_tags.post_id
                   and p.author_id = (select auth.uid())
                   and p.space_id in (select public.my_community_space_ids())));

drop policy if exists community_reactions_own_delete on public.community_reactions;
create policy community_reactions_own_delete on public.community_reactions
  for delete to authenticated
  using (user_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and (
       (community_reactions.post_id is not null
        and exists (select 1 from public.community_posts p
                    where p.id = community_reactions.post_id
                      and p.space_id in (select public.my_community_space_ids())))
       or
       (community_reactions.comment_id is not null
        and exists (select 1 from public.community_comments c
                    join public.community_posts p on p.id = c.post_id
                    where c.id = community_reactions.comment_id
                      and p.space_id in (select public.my_community_space_ids())))
     ));

drop policy if exists community_attachments_own_delete on public.community_attachments;
create policy community_attachments_own_delete on public.community_attachments
  for delete to authenticated
  using (uploader_id = (select auth.uid())
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())))
     and exists (select 1 from public.community_posts p
                 where p.id = community_attachments.post_id
                   and p.space_id in (select public.my_community_space_ids())));

-- ───────────────────────────────────────────────────────────────────
-- 6) community_media_own_insert — evaluate the uuid cast only when the regex
--    already matched. Postgres does not guarantee left-to-right AND evaluation,
--    so a plan change could turn a clean policy denial into
--    "invalid input syntax for type uuid" (a 500 instead of a 403).
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_media_own_insert on storage.objects;
create policy community_media_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'community-media'
          and (select public.is_approved()) and (select public.is_enrolled())
          and (
            -- legacy <uid>/…
            (storage.foldername(name))[1] = (select auth.uid())::text
            or
            -- #32 <space_id>/<uid>/…
            ((storage.foldername(name))[2] = (select auth.uid())::text
             and (case when (storage.foldername(name))[1] ~
                            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       then ((storage.foldername(name))[1])::uuid
                       else null end) in (select public.my_community_space_ids()))
          ));

-- ───────────────────────────────────────────────────────────────────
-- 7) batches.code — reject an impossible month (#32 accepted 2026-13/2026-99,
--    and batches_create_spaces() would happily mint gold-2026-99).
--    Validated against existing rows first so the migration cannot fail
--    mid-way on a database that already holds a bad code.
-- ───────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
  v_con text;
begin
  select count(*) into v_bad from public.batches
   where code !~ '^\d{4}-(0[1-9]|1[0-2])$';
  if v_bad > 0 then
    raise warning '#33: % batch code(s) fail the YYYY-MM month range — leaving the old CHECK in place. Fix them, then re-run this file.', v_bad;
    return;
  end if;
  select conname into v_con from pg_constraint
   where conrelid = 'public.batches'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%code%~%';
  if v_con is not null then
    execute format('alter table public.batches drop constraint %I', v_con);
  end if;
  alter table public.batches
    add constraint batches_code_check check (code ~ '^\d{4}-(0[1-9]|1[0-2])$');
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 8) Missing FK-covering index (#29 discipline — every other #32 FK got one).
-- ───────────────────────────────────────────────────────────────────
create index if not exists student_import_rows_batch_idx
  on public.student_import_rows (proposed_batch_id);

-- ───────────────────────────────────────────────────────────────────
-- 9) Refresh PostgREST's schema cache.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   1. Verify the seat fix — an expired member renewing into a full batch must
--      now be refused:
--        select code, status, gold_capacity, vip_capacity from public.batches;
--   2. Verify the mention directory still returns members:
--        select * from public.search_community_members('a');
--   3. Verify a member can still mark a notification read, and nothing else:
--        \dp public.community_notifications      -- UPDATE only on (read_at)
-- ═══════════════════════════════════════════════════════════════════

-- Record this migration (see db/2026-07-26-schema-migrations-log.sql #31).
insert into public.schema_migrations (filename, checksum, notes)
values ('2026-07-29-community-batch-hardening.sql', null,
        'community batch hardening (#33): seat-occupancy capacity fix, attachment path binding, set-based member search, notification column grant, own-delete space scoping')
on conflict (filename) do nothing;

-- ═══════════════════════════════════════════════════════════════════
-- #34 — Correct #33's admin_finalize_enrollment rewrite + one missed policy
--
-- WHY
--   Review of #33 found that its `create or replace` of admin_finalize_enrollment
--   claimed "only the v_new_assignment computation changes" but had in fact
--   reconstructed the function's tail from memory rather than copying #32's,
--   silently dropping four things:
--     • `updated_at = now()` on subscriptions, profiles and enrollment_requests
--     • `rejected_at = null, rejected_by = null` on profiles
--     • `rejection_reason = null` on enrollment_requests
--     • `approved_at`/`approved_by` became first-approval (`coalesce(...)`)
--       instead of most-recent-approval semantics
--   Consequence: a user who was rejected in Access Requests and later approved
--   through Enrollments keeps a stale `rejected_at`/`rejection_reason`, and the
--   admin screens that read those columns show contradictory state.
--   It also replaced `v_new := approve_*(…)` with a `perform` + re-select, which
--   is equivalent today but discards the RPCs' own return value for no reason.
--
--   This file restores #32's body VERBATIM and re-applies ONLY the intended
--   change: v_holds_seat / v_new_assignment (see #33 §1 for the rationale —
--   capacity and closed-batch checks must key on whether the member currently
--   OCCUPIES a counted seat, not on whether the batch id is changing).
--
--   It also gates `community_media_delete`, which #33's own-DELETE sweep missed:
--   `community_attachments_own_delete` now requires approved + enrolled + space
--   access, but the storage half did not, so an expired or departed member could
--   still delete the object while the row delete was refused — leaving dangling
--   attachment rows and broken media in a feed other members can still read.
--   (Not a confidentiality issue: both branches already pin the caller's own uid.)
--
-- ORDER
--   Run AFTER db/2026-07-29-community-batch-hardening.sql (#33).
--   Idempotent, additive, non-destructive.
-- ═══════════════════════════════════════════════════════════════════

do $$
begin
  if to_regproc('public.admin_finalize_enrollment') is null then
    raise exception '#34 requires #32/#33 (admin_finalize_enrollment) first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#34 requires db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) admin_finalize_enrollment — #32's body, with ONLY the seat fix applied.
--    Diff vs #32: the v_new_assignment block (marked #33/#34 below). Nothing else.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_finalize_enrollment(
  p_request_id uuid,
  p_batch_id   uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_req       public.enrollment_requests%rowtype;
  v_prev      public.subscriptions%rowtype;
  v_new       public.subscriptions%rowtype;
  v_plan      public.enrollment_plans%rowtype;
  v_kind      text;
  v_eff_plan  text;
  v_segment   text;
  v_prev_segment text;
  v_batch     uuid;
  v_batch_row public.batches%rowtype;
  v_holds_seat boolean;
  v_new_assignment boolean;
  v_cap       int;
  v_used      int;
begin
  if not public.is_admin() then
    raise exception 'admin_finalize_enrollment: admin only';
  end if;

  select * into v_req from public.enrollment_requests
   where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'admin_finalize_enrollment: request not found';
  end if;

  -- Idempotency: re-approving an approved request is a no-op.
  if v_req.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_req.status <> 'pending_review' then
    raise exception 'admin_finalize_enrollment: request is % — only pending_review can be approved', v_req.status;
  end if;

  v_kind := coalesce(v_req.request_kind, 'new');

  select * into v_prev from public.subscriptions
   where user_id = v_req.user_id
   order by created_at desc limit 1;

  -- Effective plan: extensions stay on the member's CURRENT plan.
  v_eff_plan := case when v_kind = 'extension'
                     then coalesce(v_prev.plan_key, v_req.plan_key)
                     else v_req.plan_key end;

  select * into v_plan from public.enrollment_plans where key = v_eff_plan;
  if v_plan.key is null then
    raise exception 'admin_finalize_enrollment: unknown plan %', v_eff_plan;
  end if;
  -- New sales require a sellable plan; extensions may continue a retired one.
  if v_kind <> 'extension' and not v_plan.active then
    raise exception 'admin_finalize_enrollment: plan % is inactive', v_eff_plan;
  end if;

  v_segment := coalesce(v_plan.community_segment, 'general');
  -- The segment the member is CURRENTLY in — a gold→vip (or vip→gold) move is a
  -- new seat even when the batch is unchanged (see v_new_assignment below).
  if v_prev.plan_key is not null then
    select coalesce(ep.community_segment, 'general') into v_prev_segment
      from public.enrollment_plans ep where ep.key = v_prev.plan_key;
  end if;

  if v_segment not in ('gold', 'vip') then
    v_batch := null;
  else
    if v_kind in ('renewal', 'extension') then
      v_batch := coalesce(p_batch_id, v_prev.batch_id, v_req.batch_id);
      if v_kind = 'extension' and p_batch_id is not null
         and v_prev.batch_id is not null and p_batch_id <> v_prev.batch_id then
        raise exception 'admin_finalize_enrollment: an extension keeps the current batch — use the batch manager to move members';
      end if;
    elsif v_kind = 'upgrade' then
      v_batch := p_batch_id;
      if v_batch is null and v_prev.batch_id is not null
         and exists (select 1 from public.community_spaces sp
                      where sp.kind = v_segment and sp.batch_id = v_prev.batch_id and sp.active) then
        v_batch := v_prev.batch_id;
      end if;
      if v_batch is null then v_batch := v_req.batch_id; end if;
    else
      v_batch := coalesce(p_batch_id, v_req.batch_id);
    end if;

    if v_batch is null then
      raise exception 'admin_finalize_enrollment: % needs a batch — pick an open batch in the approve dialog', v_eff_plan;
    end if;

    select * into v_batch_row from public.batches where id = v_batch for update;
    if v_batch_row.id is null then
      raise exception 'admin_finalize_enrollment: batch not found';
    end if;

    -- ── #33/#34: the ONLY behavioral change vs #32 ──────────────────
    -- Does this member CURRENTLY occupy a seat in this batch+segment? The
    -- predicate deliberately mirrors the v_used count below (status + the
    -- is_enrolled() date math) because the two answer the same question from
    -- opposite sides. #32 keyed on "is the batch changing?", which let an
    -- EXPIRED member of this batch renew while being counted by nobody: they
    -- skipped the open-batch and capacity checks, yet their expired row was
    -- excluded from v_used, so a capped batch could be oversold.
    -- `is not distinct from` (not `=`) is load-bearing: a NULL batch/segment
    -- would otherwise make v_holds_seat NULL and silently skip the checks.
    v_holds_seat := (v_prev.id is not null
                     and v_prev.status = 'active'
                     and (v_prev.ends_at is null or coalesce(v_prev.grace_ends_at, v_prev.ends_at) > now())
                     and v_prev.batch_id is not distinct from v_batch
                     and v_prev_segment is not distinct from v_segment);
    v_new_assignment := not v_holds_seat;
    -- ────────────────────────────────────────────────────────────────

    if v_batch_row.status = 'archived' then
      raise exception 'admin_finalize_enrollment: batch % is archived', v_batch_row.code;
    end if;
    if v_new_assignment and v_batch_row.status <> 'open' then
      raise exception 'admin_finalize_enrollment: batch % is closed to new assignments', v_batch_row.code;
    end if;
    if not exists (select 1 from public.community_spaces sp
                    where sp.kind = v_segment and sp.batch_id = v_batch and sp.active) then
      raise exception 'admin_finalize_enrollment: batch % has no active % space', v_batch_row.code, v_segment;
    end if;

    v_cap := case v_segment when 'gold' then v_batch_row.gold_capacity
                            else v_batch_row.vip_capacity end;
    if v_cap is not null and v_new_assignment then
      select count(*) into v_used
        from public.subscriptions s
        join public.enrollment_plans ep on ep.key = s.plan_key
       where s.status = 'active'
         and s.batch_id = v_batch
         and ep.community_segment = v_segment
         and s.user_id <> v_req.user_id
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());
      if v_used >= v_cap then
        raise exception 'admin_finalize_enrollment: batch % is full for % (% of % seats)', v_batch_row.code, v_segment, v_used, v_cap;
      end if;
    end if;
  end if;

  -- Grant the term through the EXISTING functions (stacking / supersede /
  -- grace / 60–365 clamp / legacy-lifetime guard all live there).
  if v_kind = 'extension' then
    if v_req.extension_days is null or v_req.extension_days <= 0 then
      raise exception 'admin_finalize_enrollment: extension request has no extension_days';
    end if;
    v_new := public.approve_extension(v_req.user_id, v_req.id, v_req.extension_days);
  else
    v_new := public.approve_subscription(v_req.user_id, v_req.plan_key, v_req.id);
  end if;

  update public.subscriptions
     set batch_id = v_batch, updated_at = now()
   where id = v_new.id;

  -- Profile cache (mirrors the old client step ②).
  update public.profiles
     set is_paid = true,
         plan = v_eff_plan,
         approval_status = 'approved',
         approved_at = now(),
         approved_by = auth.uid(),
         rejected_at = null,
         rejected_by = null,
         rejection_reason = null,
         updated_at = now()
   where id = v_req.user_id;

  -- Request row (mirrors the old client step ③) + the resolved batch.
  update public.enrollment_requests
     set status = 'approved',
         rejection_reason = null,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         batch_id = v_batch,
         updated_at = now()
   where id = v_req.id;

  return jsonb_build_object(
    'ok', true,
    'subscription_id', v_new.id,
    'ends_at', v_new.ends_at,
    'batch_id', v_batch,
    'batch_code', (select code from public.batches where id = v_batch)
  );
end;
$$;

revoke all on function public.admin_finalize_enrollment(uuid, uuid) from public, anon;
grant execute on function public.admin_finalize_enrollment(uuid, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 2) community_media_delete — match community_attachments_own_delete, so the
--    row and its object stay deletable (or not) together.
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_media_delete on storage.objects;
create policy community_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'community-media'
     and ((select public.is_admin())
       or ((select public.is_approved()) and (select public.is_enrolled())
           and (
             -- legacy <uid>/…
             (storage.foldername(name))[1] = (select auth.uid())::text
             or
             -- #32 <space_id>/<uid>/… — must still be a space the caller can see
             ((storage.foldername(name))[2] = (select auth.uid())::text
              and (case when (storage.foldername(name))[1] ~
                             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                        then ((storage.foldername(name))[1])::uuid
                        else null end) in (select public.my_community_space_ids()))
           ))));

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   1. Confirm the restored assignments are back:
--        select prosrc like '%rejected_at = null%' as clears_rejection,
--               prosrc like '%v_holds_seat%'      as has_seat_fix
--          from pg_proc where proname = 'admin_finalize_enrollment';
--      Both must be true.
-- ═══════════════════════════════════════════════════════════════════

insert into public.schema_migrations (filename, checksum, notes)
values ('2026-07-29-batch-hardening-followup.sql', null,
        'restores #32 body of admin_finalize_enrollment (updated_at / rejected_* / rejection_reason / approved_at) keeping only the #33 seat fix; gates community_media_delete')
on conflict (filename) do nothing;


-- ═════════════════════════════════════════════════════════════════════════════
-- §22) FOLDED VERBATIM — 2026-07-30-batch-entitlements.sql
--      the cohort-entitlement ledger (L1) + stable error codes
--
--      Appended at the tail for the same reason as §19-§21: the earlier
--      sections create the pre-#35 shapes, and these files' DROP+CREATE must
--      win on a fresh install. Every file is idempotent and self-guarded, so
--      appending reproduces the live end state exactly.
--      RE-FOLD whenever the dated file changes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- #35 — batch_entitlements: the durable cohort-seat ledger
--
-- WHY
--   Until now a member's cohort membership was ONE nullable, mutable column:
--   subscriptions.batch_id. That column cannot express the product:
--     • a 180-day Gold plan buys SIX monthly cohorts (D1), not one;
--     • reassigning a member OVERWRITES the record of why they had access, so
--       "which batches has this student been in, and why?" is unanswerable;
--     • user_community_space_ids() read exactly one subscription (limit 1) and
--       its single batch_id, so multi-cohort access was impossible by construction.
--
--   #35 introduces public.batch_entitlements — an append-only ledger where one
--   row is ONE SEAT IN ONE COHORT, stamped with WHY it exists (grant_reason +
--   the source subscription/request/import row), WHERE it sits in the purchased
--   run (batch_index), and HOW LONG it lasts (valid_until). History is never
--   rewritten; a seat is withdrawn by revoking it, not by editing it.
--
-- THE ONE AUTHORITATIVE ENTITLEMENT SOURCE
--   Three layers. Each reads only the layer below. Nothing re-derives a lower one.
--
--     L2  CAPABILITY  user_community_capabilities()  (#36)
--                     user_batch_course_access()     (#37)
--     L1  SCOPE       ★ public.batch_entitlements ★
--                     user_entitled_batches(p_user) · batch_seat_holders()
--                     user_community_space_ids(p_user) · my_* wrappers
--     L0  MEMBERSHIP  user_is_enrolled() · user_is_approved() · user_plan_key()
--                     ↑ these ALREADY EXIST (#27). #35 must NOT redefine them —
--                       they are the AI trainer's authorization mirrors, and a
--                       create-or-replace here would silently change who can
--                       talk to the paid course trainer. The preflight asserts
--                       their bodies are intact instead.
--
-- TWO PREDICATES, ONE CORE (read this before editing either)
--   OCCUPANCY (capacity) — batch_seat_holders(batch, segment):
--       status='active' AND batch_id=B AND segment=S
--       AND (valid_until is null or valid_until > now())
--       AND segment = the member's LIVE plan segment
--   ACCESS (RLS) — user_entitled_batches(p_user): the same, PLUS
--       AND (activates_at is null or activates_at <= now())
--   The single difference is activates_at. A seat in next month's cohort is
--   OCCUPIED (it was sold, it consumes capacity — D8) but does not yet GRANT
--   access. Collapsing these two would either let capacity be oversold or reveal
--   a cohort before it starts.
--
-- LIVE PLAN RECONCILIATION (the security conjunct — do not remove)
--   Both predicates require e.segment = the member's CURRENT plan segment.
--   #32 had this property for free because it joined the live subscription to
--   enrollment_plans. Stamping entitlements loses it, and without the conjunct a
--   member who downgrades, refunds, or charges back keeps the ₱9,999 Gold space
--   forever. With it, the instant their live plan stops selling that segment,
--   every stamped row for it stops resolving. revoke_batch_run() is ALSO
--   implemented — as bookkeeping, not as the control.
--
-- REGISTRY ALLOCATION, NEVER CALENDAR ARITHMETIC
--   A seat does not compute a month. grant_batch_run() walks the batches
--   REGISTRY in `code` order and takes the next N cohorts that actually exist.
--   A shortfall is recorded as status='queued' (batch_id null) and bound by a
--   FIFO trigger when the next batch is created. Computing `start + N months`
--   would violate the project's non-negotiable rule (src/lib/communitySpaces.js:11
--   — a batch is NEVER inferred from a date) and would promise cohorts that
--   Alex, who skips months, may never run.
--
-- LOCK ORDER
--   grant_batch_run() is the ONLY function that locks `batches`, and it always
--   locks in ascending `code` order in a single statement. admin_finalize_enrollment
--   and admin_assign_batch therefore no longer take their own batch lock —
--   doing so inverted the order against the run and could deadlock two
--   concurrent approvals into overlapping runs.
--
-- ORDER
--   Run AFTER db/2026-07-29-batch-hardening-followup.sql (#34).
--   Idempotent, additive, non-destructive. Nothing is dropped; no data is deleted.
--   subscriptions.batch_id keeps being written as the start-batch cache and keeps
--   working as a read bridge for members who predate the ledger (#39 retires it).
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and run once, then confirm the
--   verification block at the tail. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Preflight — abort with an actionable message, never degrade silently.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.batches') is null or to_regclass('public.community_spaces') is null then
    raise exception '#35 requires #32 — run db/2026-07-28-community-spaces-batches.sql first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#35 requires #31 — run db/2026-07-26-schema-migrations-log.sql first (the tail insert would abort).';
  end if;
  if to_regproc('public.admin_finalize_enrollment') is null then
    raise exception '#35 requires #32 (admin_finalize_enrollment).';
  end if;

  -- #34 restored four things #33's rewrite dropped (updated_at, the rejected_*
  -- clearing, rejection_reason = null, most-recent-approval semantics). #35's
  -- base text is #34's, so applying on a #33-only database would re-lose them.
  --
  -- The check must stay true AFTER #35 has run, or this file stops being
  -- re-runnable (#35 replaces admin_finalize_enrollment, and its replacement no
  -- longer contains v_holds_seat — that concept moved into grant_batch_run).
  -- So: the housekeeping marker must be present, and the body must be either
  -- #34's (v_holds_seat) or #35's own (grant_batch_run). #31's apply-log is
  -- accepted as independent evidence for installs that logged the run.
  if not exists (select 1 from public.schema_migrations
                  where filename = '2026-07-29-batch-hardening-followup.sql')
     and not exists (
       select 1 from pg_proc
        where proname = 'admin_finalize_enrollment'
          and prosrc like '%rejected_at = null%'
          and (prosrc like '%v_holds_seat%' or prosrc like '%grant_batch_run%')
     ) then
    raise exception '#35 requires BOTH #33 and #34 — run db/2026-07-29-batch-hardening-followup.sql first.';
  end if;

  -- L0 mirrors belong to #27. Assert, never replace.
  -- to_regPROCEDURE, not to_regproc: only the former parses an argument list —
  -- to_regproc('f(uuid)') silently returns NULL, which would make this guard
  -- fire on a perfectly good database.
  if to_regprocedure('public.user_is_enrolled(uuid)') is null
     or to_regprocedure('public.user_is_approved(uuid)') is null
     or to_regprocedure('public.user_plan_key(uuid)') is null then
    raise exception '#35 requires #27 — db/2026-07-24-course-ai-trainer.sql supplies user_is_enrolled/user_is_approved/user_plan_key.';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'user_is_enrolled'
       and prosrc like '%grace_ends_at%' and prosrc like '%not exists%'
  ) then
    raise exception '#35: user_is_enrolled(uuid) has drifted from #27''s body — reconcile before proceeding.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='enrollment_plans' and column_name='community_segment'
  ) then
    raise exception '#35 requires enrollment_plans.community_segment (#32).';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) app_error() — stable, machine-readable error codes across PostgREST.
--
--    SQLSTATE 'PT###' is PostgREST's HTTP-status override. The code itself
--    rides in HINT (the client's branch key) and, redundantly, inside a JSON
--    envelope in DETAIL — so a proxy that strips one still leaves the other.
--    The MESSAGE stays a human sentence, which is what an admin reads when the
--    client does not know the code yet.
--
--    Clients branch on `hint`. They must NOT branch on the HTTP status: PT###
--    is a PostgREST convention, not a Postgres guarantee, so if that mapping
--    ever changes the status degrades while hint/details keep working.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.app_error(
  p_code    text,
  p_message text,
  p_http    int default 400,
  p_context jsonb default null
)
returns void
language plpgsql
-- VOLATILE (the default) on purpose: this function's entire job is to raise.
-- Marking it IMMUTABLE would invite the planner to constant-fold a call with
-- literal arguments, moving the raise from execution time to plan time.
volatile
set search_path = public
as $$
begin
  raise exception using
    errcode = 'PT' || lpad(greatest(400, least(599, coalesce(p_http, 400)))::text, 3, '0'),
    message = p_message,
    detail  = jsonb_build_object('code', p_code, 'context', coalesce(p_context, '{}'::jsonb))::text,
    hint    = p_code;
end;
$$;

revoke all on function public.app_error(text, text, int, jsonb) from public, anon, authenticated;

-- The catalog, readable by the client so it can render safe fallback copy for a
-- code it does not know yet — and so a test can diff it against APP_ERROR_CODES
-- in src/lib/appErrors.js. Adding a code in SQL before the client ships is safe.
create or replace function public.app_error_catalog()
returns table (code text, http int, summary text)
language sql
immutable
parallel safe
set search_path = public
as $$
  select * from (values
    ('BATCH_REQUIRED',               422, 'A Gold/VIP action needs an explicit batch; none was supplied.'),
    ('BATCH_NOT_FOUND',              404, 'The batch id or month code does not exist.'),
    ('BATCH_CLOSED',                 409, 'The batch is closed to new assignments, or archived.'),
    ('BATCH_FULL',                   409, 'A cohort in the run has no seats left.'),
    ('NO_SPACE_FOR_SEGMENT',         409, 'The batch has no active community space for that plan segment.'),
    ('INVALID_BATCH_CODE',           422, 'Not a real YYYY-MM month.'),
    ('ENTITLEMENT_EXPIRED',          403, 'The membership term (or its grace) has ended.'),
    ('INVALID_PLAN',                 422, 'Unknown, inactive, or non-premium plan for this action.'),
    ('ALREADY_ENTITLED',             409, 'The member already holds an outstanding seat in that cohort.'),
    ('RUN_LIMIT_EXCEEDED',           409, 'Outstanding seats would exceed the per-member ceiling.'),
    ('SEGMENT_MISMATCH',             409, 'The grant would mix Gold and VIP seats in one outstanding run.'),
    ('INVALID_MEMBERSHIP_TRANSITION',409, 'The current membership state does not allow this transition.'),
    ('IMMUTABLE_ENTITLEMENT',        409, 'An attempt to rewrite a frozen ledger column.'),
    ('FORBIDDEN',                    403, 'Admin-only operation called by a non-admin.'),
    ('REQUEST_NOT_FOUND',            404, 'The enrollment request does not exist.'),
    ('COURSE_ACCESS_DENIED',         403, 'Course hidden by plan scope, publication, or cohort entitlement.'),
    ('LESSON_NOT_RELEASED',          403, 'The cohort drip has not unlocked this lesson yet.'),
    ('COMMUNITY_ACCESS_DENIED',      403, 'The community write was refused.'),
    ('COMMENT_PERMISSION_DENIED',    403, 'Replies are off in this space.'),
    ('ASSIGNMENT_CLOSED',            409, 'Past the due date, or the assignment is unpublished.'),
    ('SUBMISSION_LOCKED',            409, 'The submission is handed in or graded; edits refused.'),
    ('COURSE_HAS_SUBMISSIONS',       409, 'The course has graded assignment work and cannot be deleted.')
  ) as t(code, http, summary);
$$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 2) Column additions + the updated_at trigger #32 forgot.
-- ───────────────────────────────────────────────────────────────────

-- D1's override. NULL = derive from access_days. Pinning Gold back to 2 cohorts
-- is then a one-row UPDATE with no migration.
alter table public.enrollment_plans
  add column if not exists eligible_batch_count int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'enrollment_plans_eligible_batch_count_check') then
    alter table public.enrollment_plans
      add constraint enrollment_plans_eligible_batch_count_check
      check (eligible_batch_count is null or (eligible_batch_count between 1 and 24));
  end if;
end $$;

comment on column public.enrollment_plans.eligible_batch_count is
  'D1 override for how many monthly cohorts this plan grants. NULL = derive ceil(access_days/30). '
  'Mirrored by planBatchCount() in src/lib/batchEntitlements.js — keep in lockstep.';

-- A combined cap alongside the per-segment ones. NULL = unlimited, as before.
alter table public.batches
  add column if not exists total_capacity int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'batches_total_capacity_check') then
    alter table public.batches
      add constraint batches_total_capacity_check
      check (total_capacity is null or total_capacity > 0);
  end if;
end $$;

comment on column public.batches.total_capacity is
  'Combined gold+vip seat cap for this cohort. NULL = unlimited. Checked alongside '
  'gold_capacity/vip_capacity by grant_batch_run(). Under D8 a seat is consumed in EVERY '
  'cohort of a member''s run, so one 6-cohort Gold approval consumes one seat in six batches.';

-- #32 created batches/community_spaces with updated_at defaults but no trigger,
-- so the column has silently never advanced. Admin screens sort by it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists batches_touch_updated_at on public.batches;
create trigger batches_touch_updated_at
  before update on public.batches
  for each row execute function public.touch_updated_at();

drop trigger if exists community_spaces_touch_updated_at on public.community_spaces;
create trigger community_spaces_touch_updated_at
  before update on public.community_spaces
  for each row execute function public.touch_updated_at();

-- batch_events is the immutable admin audit trail; widen its vocabulary for the
-- ledger's actions. Strictly more permissive, so no existing row can fail.
do $$
declare v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.batch_events'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%action%';
  if v_con is not null then
    execute format('alter table public.batch_events drop constraint %I', v_con);
  end if;
  alter table public.batch_events
    add constraint batch_events_action_check
    check (action in (
      'create', 'open', 'close', 'archive', 'assign', 'reassign', 'unassign',
      'capacity', 'space_create',
      'entitle', 'entitle_allocate', 'entitle_revoke', 'entitle_supersede', 'entitle_extend'
    ));
exception when undefined_table then
  raise notice '#35: public.batch_events not present — skipping its CHECK widening.';
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 3) batch_entitlements — L1, the ledger.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.batch_entitlements (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,

  -- The ALLOCATED cohort. NULL while the seat is queued: it was paid for, but
  -- the cohort it will occupy does not exist in the registry yet.
  batch_id               uuid references public.batches(id) on delete restrict,
  segment                text not null check (segment in ('gold', 'vip')),

  -- Position in the member's purchased run (0-based) and the run it belongs to.
  -- batch_index is the FIFO ordering key, not a month number.
  batch_index            int  not null check (batch_index >= 0 and batch_index < 24),
  run_id                 uuid not null,
  run_length             int  not null check (run_length between 1 and 24),

  status                 text not null default 'queued'
                         check (status in ('queued', 'active', 'revoked', 'superseded')),

  -- WHY this seat exists. Never inferred.
  grant_reason           text not null check (grant_reason in
                           ('approval', 'renewal', 'extension', 'upgrade', 'import', 'admin_manual', 'backfill')),
  source_subscription_id uuid references public.subscriptions(id)       on delete set null,
  source_plan_key        text references public.enrollment_plans(key)   on delete set null on update cascade,
  source_request_id      uuid references public.enrollment_requests(id) on delete set null,
  source_import_row_id   uuid,
  granted_by             uuid references public.profiles(id) on delete set null,
  granted_at             timestamptz not null default now(),

  -- HOW LONG. Stamped from the source term's coalesce(grace_ends_at, ends_at).
  -- Forward-only: an extension advances it, nothing moves it back.
  valid_until            timestamptz,
  -- WHEN it starts granting access. Stamped at allocation from batches.starts_on.
  activates_at           timestamptz,
  allocated_at           timestamptz,

  revoked_at             timestamptz,
  revoked_by             uuid references public.profiles(id) on delete set null,
  revoke_reason          text,
  superseded_by_run_id   uuid,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint batch_entitlements_active_bound   check (status <> 'active' or batch_id is not null),
  constraint batch_entitlements_queued_unbound check (status <> 'queued' or batch_id is null),
  constraint batch_entitlements_revoked_shape  check ((status = 'revoked') = (revoked_at is not null))
);

-- student_import_rows may not exist on an install that skipped #26; add the FK
-- conditionally so the ledger still works there.
do $$
begin
  if to_regclass('public.student_import_rows') is not null
     and not exists (select 1 from pg_constraint where conname = 'batch_entitlements_source_import_row_fk') then
    alter table public.batch_entitlements
      add constraint batch_entitlements_source_import_row_fk
      foreign key (source_import_row_id) references public.student_import_rows(id) on delete set null;
  end if;
end $$;

comment on table public.batch_entitlements is
  'L1 — THE authoritative cohort-entitlement source (#35). One row = one seat in one cohort. '
  'Append-only: history is never rewritten, only revoked/superseded. Writes go exclusively through '
  'the SECURITY DEFINER RPCs; authenticated holds SELECT on own rows and nothing else.';

-- Indexes. Each serves a named query shape; see db/README.md.
-- THE RLS hot path: user_entitled_batches runs once per statement (InitPlan) on
-- every community read and write and every LMS read. Index-only, ~6 rows/user.
create index if not exists batch_entitlements_user_active_idx
  on public.batch_entitlements (user_id)
  include (batch_id, segment, valid_until, activates_at)
  where status = 'active' and batch_id is not null;

-- batch_seat_holders(): the capacity count inside grant_batch_run (once per
-- candidate, under the lock) and every admin_batch_overview count.
create index if not exists batch_entitlements_batch_segment_idx
  on public.batch_entitlements (batch_id, segment)
  include (user_id, valid_until)
  where status = 'active';

-- The FIFO binder and admin_reconcile_queued_entitlements().
create index if not exists batch_entitlements_queued_fifo_idx
  on public.batch_entitlements (segment, granted_at, batch_index)
  where status = 'queued';

-- Member panel + admin drill-down; also covers the user_id FK (ON DELETE CASCADE).
create index if not exists batch_entitlements_user_granted_idx
  on public.batch_entitlements (user_id, granted_at desc);

-- Covers the batch_id FK (ON DELETE RESTRICT scans this on every batch delete)
-- and the batch roster query.
create index if not exists batch_entitlements_batch_idx
  on public.batch_entitlements (batch_id);

-- FK cover + the drift view's join + "what did this term grant?".
create index if not exists batch_entitlements_source_sub_idx
  on public.batch_entitlements (source_subscription_id);

-- FK cover + the approve receipt.
create index if not exists batch_entitlements_source_request_idx
  on public.batch_entitlements (source_request_id);

-- CORRECTNESS: a member can never hold two outstanding seats in one cohort.
-- NOTE: this index protects BOUND seats only — a queued seat has batch_id NULL
-- and is therefore outside it, which is why admin_grant_batch_run needs its own
-- ALREADY_ENTITLED check (#37) to stay idempotent.
create unique index if not exists batch_entitlements_one_seat_per_cohort
  on public.batch_entitlements (user_id, batch_id)
  where status in ('queued', 'active') and batch_id is not null;

-- Exact per-approval idempotency: re-running a grant for the same request
-- cannot duplicate the run. The ON CONFLICT inference target.
create unique index if not exists batch_entitlements_request_seat_uniq
  on public.batch_entitlements (user_id, source_request_id, batch_index)
  where status in ('queued', 'active') and source_request_id is not null;

-- Import idempotency (mirrors subscriptions.source_import_row_id's partial unique).
create unique index if not exists batch_entitlements_import_seat_uniq
  on public.batch_entitlements (source_import_row_id, batch_index)
  where status in ('queued', 'active') and source_import_row_id is not null;

alter table public.batch_entitlements enable row level security;

-- ONE permissive SELECT policy rather than the house *_read + *_admin_all pair,
-- so this table adds nothing to the 31 multiple_permissive_policies advisor
-- findings. Both branches are (select …)-wrapped per #29 (InitPlan once).
drop policy if exists batch_entitlements_read on public.batch_entitlements;
create policy batch_entitlements_read on public.batch_entitlements
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- NO insert/update/delete policy — writes go only through the SECURITY DEFINER
-- RPCs (the community_notifications precedent).
--
-- ★ The revoke is load-bearing and is NOT implied by the missing policy:
-- Supabase's default grants leave `authenticated` holding table-level DML, and
-- RLS without a policy denies... but only while RLS stays enabled. Belt and
-- braces on the table that decides who is in a ₱9,999 cohort.
revoke insert, update, delete, truncate on public.batch_entitlements from authenticated, anon, public;
grant select on public.batch_entitlements to authenticated;

drop trigger if exists batch_entitlements_touch_updated_at on public.batch_entitlements;
create trigger batch_entitlements_touch_updated_at
  before update on public.batch_entitlements
  for each row execute function public.touch_updated_at();

-- ───────────────────────────────────────────────────────────────────
-- 4) Run length (D1). Pure integer arithmetic — no date maths anywhere.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.plan_batch_count(p_access_days int, p_override int)
returns int
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
           when p_override is not null then least(24, greatest(1, p_override))
           when p_access_days is null or p_access_days <= 0 then null   -- caller MUST fail closed
           else least(24, greatest(1, ceil(p_access_days / 30.0)::int))
         end;
$$;

-- Pure arithmetic, but there is no reason for anon to hold it. authenticated
-- keeps EXECUTE because plan_eligible_batch_count() runs with invoker rights
-- and calls straight through to it.
revoke all on function public.plan_batch_count(int, int) from public, anon;
grant execute on function public.plan_batch_count(int, int) to authenticated;

comment on function public.plan_batch_count(int, int) is
  'D1: coalesce(override, ceil(access_days/30)), clamped 1..24. NULL for a lifetime plan so the '
  'caller fails closed rather than granting unlimited cohorts. Mirrored by planBatchCount() in '
  'src/lib/batchEntitlements.js (test/batchEntitlements.test.mjs pins the truth table).';

create or replace function public.plan_eligible_batch_count(p_plan_key text)
returns int
language sql
stable
parallel safe
set search_path = public
as $$
  select public.plan_batch_count(ep.access_days, ep.eligible_batch_count)
    from public.enrollment_plans ep
   where ep.key = p_plan_key;
$$;

revoke all on function public.plan_eligible_batch_count(text) from public, anon;
grant execute on function public.plan_eligible_batch_count(text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 5) Guard trigger — the layer that survives a policy mistake.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batch_entitlements_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seg_ok boolean;
begin
  if tg_op = 'INSERT' then
    -- A bound seat must have a real, active space for its segment. This is what
    -- makes "granted into a cohort with no Gold space" impossible rather than
    -- merely unlikely.
    if new.batch_id is not null then
      select exists (
        select 1 from public.community_spaces sp
         where sp.batch_id = new.batch_id and sp.kind = new.segment and sp.active
      ) into v_seg_ok;
      if not v_seg_ok then
        perform public.app_error('NO_SPACE_FOR_SEGMENT',
          format('batch has no active %s space', new.segment), 409,
          jsonb_build_object('batch_id', new.batch_id, 'segment', new.segment));
      end if;
    end if;

    -- valid_until may never outlive the source term.
    if new.valid_until is not null and new.source_subscription_id is not null then
      if exists (
        select 1 from public.subscriptions s
         where s.id = new.source_subscription_id
           and s.ends_at is not null
           and new.valid_until > coalesce(s.grace_ends_at, s.ends_at) + interval '1 minute'
      ) then
        perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
          'entitlement would outlive its source subscription term', 409,
          jsonb_build_object('source_subscription_id', new.source_subscription_id));
      end if;
    end if;

    -- granted_by, when set, must be an admin.
    if new.granted_by is not null
       and not coalesce((select p.is_admin from public.profiles p where p.id = new.granted_by), false) then
      perform public.app_error('FORBIDDEN', 'granted_by must reference an admin', 403, null);
    end if;

    if new.batch_index >= new.run_length then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'batch_index must be inside the run', 409,
        jsonb_build_object('batch_index', new.batch_index, 'run_length', new.run_length));
    end if;

    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────
  -- Frozen identity/provenance columns. Rewriting any of these would destroy
  -- the audit answer to "why did this member have access?".
  if new.user_id     is distinct from old.user_id
     or new.segment      is distinct from old.segment
     or new.batch_index  is distinct from old.batch_index
     or new.run_id       is distinct from old.run_id
     or new.run_length   is distinct from old.run_length
     or new.grant_reason is distinct from old.grant_reason
     or new.granted_at   is distinct from old.granted_at
     or new.created_at   is distinct from old.created_at then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batch entitlement identity columns are frozen', 409, null);
  end if;

  -- ★ Provenance FKs and granted_by may transition to NULL. That is Postgres
  -- executing ON DELETE SET NULL / ON UPDATE CASCADE, which arrives here as an
  -- UPDATE. Freezing them outright would make every referenced profile,
  -- request, subscription and plan key permanently undeletable — a reviewer
  -- found exactly this. Reject only non-null → a DIFFERENT non-null.
  if (old.source_subscription_id is not null and new.source_subscription_id is not null
      and new.source_subscription_id is distinct from old.source_subscription_id)
     or (old.source_plan_key is not null and new.source_plan_key is not null
         and new.source_plan_key is distinct from old.source_plan_key)
     or (old.source_request_id is not null and new.source_request_id is not null
         and new.source_request_id is distinct from old.source_request_id)
     or (old.source_import_row_id is not null and new.source_import_row_id is not null
         and new.source_import_row_id is distinct from old.source_import_row_id)
     or (old.granted_by is not null and new.granted_by is not null
         and new.granted_by is distinct from old.granted_by) then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batch entitlement provenance cannot be re-pointed', 409, null);
  end if;

  -- batch_id: NULL → a real id exactly once (allocation). Never re-pointed,
  -- never cleared. Moving a member between cohorts revokes and re-grants, so
  -- the old seat stays in the record.
  if old.batch_id is not null and new.batch_id is distinct from old.batch_id then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'an allocated seat cannot be moved — revoke it and grant a new one', 409,
      jsonb_build_object('batch_id', old.batch_id));
  end if;

  -- status: queued → active → {revoked|superseded}, both terminal.
  if old.status <> new.status then
    if old.status in ('revoked', 'superseded') then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        format('%s is a terminal entitlement status', old.status), 409, null);
    end if;
    if old.status = 'active' and new.status = 'queued' then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'an allocated seat cannot return to the queue', 409, null);
    end if;
  end if;

  -- valid_until is forward-only. Clearing it (→ NULL) would silently grant
  -- perpetual access; shortening it is a revoke, which has its own path.
  if old.valid_until is not null
     and (new.valid_until is null or new.valid_until < old.valid_until)
     and new.status not in ('revoked', 'superseded') then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'valid_until only moves forward — revoke the seat to end it early', 409, null);
  end if;

  return new;
end;
$$;

-- A trigger function needs no EXECUTE grant to fire from its trigger, and
-- Postgres refuses a direct call anyway ("trigger functions can only be called
-- as triggers"). But it is SECURITY DEFINER, so leaving the default PUBLIC
-- EXECUTE in place raises a Supabase advisor finding — and a definer function
-- reachable by anon is the wrong shape to normalise, exploitable or not.
revoke all on function public.batch_entitlements_guard() from public, anon, authenticated;

drop trigger if exists batch_entitlements_guard_trg on public.batch_entitlements;
create trigger batch_entitlements_guard_trg
  before insert or update on public.batch_entitlements
  for each row execute function public.batch_entitlements_guard();

-- ───────────────────────────────────────────────────────────────────
-- 6) batch_seat_holders() — THE occupancy predicate (capacity).
--
--    Counts members who OCCUPY a seat in (batch, segment): sold and unexpired,
--    whether or not the cohort has started (D8). Used by grant_batch_run's
--    capacity check, admin_batch_overview, and the batch roster.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batch_seat_holders(p_batch_id uuid, p_segment text)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.user_id
    from public.batch_entitlements e
    join public.profiles pr on pr.id = e.user_id
    -- LIVE plan reconciliation: a downgraded/refunded member stops occupying a
    -- seat the moment their current plan stops selling this segment.
    join lateral (
      select coalesce(ep.community_segment, 'general') as segment
        from public.subscriptions s
        left join public.enrollment_plans ep on ep.key = s.plan_key
       where s.user_id = e.user_id
         and s.status = 'active'
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       order by s.created_at desc
       limit 1
    ) live on true
   where e.batch_id = p_batch_id
     and e.segment = p_segment
     and e.status = 'active'
     and (e.valid_until is null or e.valid_until > now())
     and live.segment = e.segment
     and (pr.approval_status = 'approved' or pr.is_admin)
   group by e.user_id;
$$;

revoke all on function public.batch_seat_holders(uuid, text) from public, anon, authenticated;

comment on function public.batch_seat_holders(uuid, text) is
  'Occupancy predicate: who consumes a seat in (batch, segment). Differs from the ACCESS predicate '
  '(user_entitled_batches) by ONE conjunct — it ignores activates_at, because a seat in a future '
  'cohort is sold and therefore consumes capacity (D8) without yet granting access.';

-- ───────────────────────────────────────────────────────────────────
-- 7) user_entitled_batches() — THE access predicate (L1), and its wrappers.
--
--    The `legacy` CTE is a STAGED BRIDGE for members granted before #35, and it
--    is subordinate to the ledger: it applies only to users with ZERO ledger
--    rows. The moment a member has one row, revocation bites immediately and
--    the stale subscriptions.batch_id cache can no longer resurrect access.
--    #39 deletes the CTE once the drift view reads clean.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.user_entitled_batches(p_user uuid)
returns table (batch_id uuid, segment text, batch_index int, activates_at timestamptz, valid_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with gate as (
    select public.user_is_enrolled(p_user) as enrolled,
           public.user_is_approved(p_user) as approved
  ),
  live as (
    select coalesce(ep.community_segment, 'general') as segment
      from public.subscriptions s
      left join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  ledger as (
    select e.batch_id, e.segment, e.batch_index, e.activates_at, e.valid_until
      from public.batch_entitlements e
     where e.user_id = p_user
       and e.status = 'active'
       and e.batch_id is not null
       and (e.valid_until  is null or e.valid_until  > now())
       and (e.activates_at is null or e.activates_at <= now())
       and e.segment = (select segment from live)
  ),
  bridge as (
    -- Pre-#35 grants only. Scoped to members with NO ledger rows at all.
    select s.batch_id,
           coalesce(ep.community_segment, 'general') as segment,
           0 as batch_index,
           null::timestamptz as activates_at,
           coalesce(s.grace_ends_at, s.ends_at) as valid_until
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       and s.batch_id is not null
       and coalesce(ep.community_segment, 'general') in ('gold', 'vip')
       and not exists (select 1 from public.batch_entitlements e2 where e2.user_id = p_user)
  )
  select b.batch_id, b.segment, b.batch_index, b.activates_at, b.valid_until
    from (select * from ledger union all select * from bridge) b, gate g
   where g.enrolled and g.approved;
$$;

revoke all on function public.user_entitled_batches(uuid) from public, anon, authenticated;

create or replace function public.my_entitled_batches()
returns table (batch_id uuid, segment text, batch_index int, activates_at timestamptz, valid_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.user_entitled_batches(auth.uid());
$$;

revoke all on function public.my_entitled_batches() from public, anon;
grant execute on function public.my_entitled_batches() to authenticated;

-- Bare id set, for policies that do not need the segment.
-- ★ Cohort tables that carry per-segment content (sessions, announcements) must
-- use my_entitled_batches() and match the SEGMENT too — Gold and VIP share a
-- batch, so a batch-id-only check leaks VIP call links to Gold.
create or replace function public.my_entitled_batch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select batch_id from public.user_entitled_batches(auth.uid());
$$;

revoke all on function public.my_entitled_batch_ids() from public, anon;
grant execute on function public.my_entitled_batch_ids() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 8) user_community_space_ids() — rewritten over L1 (#32 §8 replaced).
--    Same signature, same fail-closed shape; the premium branch now reads the
--    ledger instead of one mutable subscriptions.batch_id.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.user_community_space_ids(p_user uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.is_admin,
           (p.approval_status = 'approved' or p.is_admin) as approved,
           p.is_paid
      from public.profiles p
     where p.id = p_user
  ),
  cur as (
    select s.plan_key, s.batch_id
      from public.subscriptions s
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  gate as (
    select coalesce((select is_admin from me), false) as is_admin,
           (coalesce((select approved from me), false)
            and (exists (select 1 from cur)
                 or (coalesce((select is_paid from me), false)
                     and not exists (select 1 from public.subscriptions s2
                                      where s2.user_id = p_user)))) as is_member
  ),
  scope as (select batch_id, segment from public.user_entitled_batches(p_user))
  select sp.id
    from public.community_spaces sp, gate g
   where g.is_admin
      or (g.is_member and sp.active
          and (sp.kind = 'general'
               or exists (select 1 from scope s
                           where s.segment = sp.kind and s.batch_id = sp.batch_id)));
$$;

revoke all on function public.user_community_space_ids(uuid) from public, anon, authenticated;

-- my_community_space_ids() is unchanged in shape but re-issued so its grants are
-- unambiguous after the rewrite above.
create or replace function public.my_community_space_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select * from public.user_community_space_ids(auth.uid());
$$;

revoke all on function public.my_community_space_ids() from public, anon;
grant execute on function public.my_community_space_ids() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 9) grant_batch_run() — the ONE allocator.
--
--    Every path that grants cohort access routes through this function:
--    admin_finalize_enrollment (approval/renewal/extension/upgrade),
--    admin_assign_batch (manual), and the import endpoint. That is what makes
--    "one writer, one reader" true, and it is why capacity, closed-batch and
--    ordering rules cannot be bypassed by picking a different entry point.
--
--    ★ THIS IS THE ONLY FUNCTION THAT LOCKS `batches`, and it always locks in
--    ascending `code` order in ONE statement. Callers must NOT take their own
--    batch lock: doing so inverts the order against a run and deadlocks two
--    concurrent approvals whose runs overlap in different orders.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.grant_batch_run(
  p_user_id                uuid,
  p_segment                text,
  p_start_batch_id         uuid,
  p_count                  int,
  p_grant_reason           text,
  p_source_subscription_id uuid        default null,
  p_source_plan_key        text        default null,
  p_source_request_id      uuid        default null,
  p_source_import_row_id   uuid        default null,
  p_valid_until            timestamptz default null,
  p_actor                  uuid        default null,
  p_enforce_capacity       boolean     default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_run_id      uuid := gen_random_uuid();
  v_start       public.batches%rowtype;
  v_outstanding int;
  v_other_seg   text;
  v_cand        record;
  v_idx         int := 0;
  v_cap         int;
  v_used        int;
  v_allocated   jsonb := '[]'::jsonb;
  v_queued      int := 0;
  v_activates   timestamptz;
begin
  if p_segment not in ('gold', 'vip') then
    perform public.app_error('INVALID_PLAN',
      format('%s is not a cohort segment', coalesce(p_segment, 'null')), 422,
      jsonb_build_object('segment', p_segment));
  end if;
  if p_count is null or p_count < 1 then
    perform public.app_error('INVALID_PLAN',
      'this plan has no cohort run length - set enrollment_plans.eligible_batch_count', 422,
      jsonb_build_object('plan_key', p_source_plan_key));
  end if;
  if p_count > 24 then
    perform public.app_error('RUN_LIMIT_EXCEEDED', 'a run cannot exceed 24 cohorts', 409,
      jsonb_build_object('requested', p_count));
  end if;

  select * into v_start from public.batches where id = p_start_batch_id;
  if v_start.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'batch not found', 404,
      jsonb_build_object('batch_id', p_start_batch_id));
  end if;

  -- Mixing segments inside one member's outstanding run makes "which seat does
  -- this member occupy?" ambiguous for capacity. An upgrade must supersede the
  -- old run first (admin_finalize_enrollment does).
  select e.segment into v_other_seg
    from public.batch_entitlements e
   where e.user_id = p_user_id
     and e.status in ('queued', 'active')
     and e.segment <> p_segment
   limit 1;
  if v_other_seg is not null then
    perform public.app_error('SEGMENT_MISMATCH',
      format('member already holds outstanding %s seats', v_other_seg), 409,
      jsonb_build_object('held_segment', v_other_seg, 'requested_segment', p_segment));
  end if;

  select count(*) into v_outstanding
    from public.batch_entitlements e
   where e.user_id = p_user_id and e.status in ('queued', 'active');
  if v_outstanding + p_count > 24 then
    perform public.app_error('RUN_LIMIT_EXCEEDED',
      'this member already holds the maximum number of upcoming cohort seats', 409,
      jsonb_build_object('outstanding', v_outstanding, 'requested', p_count));
  end if;

  -- The explicitly chosen starting cohort must itself be usable - a precise
  -- error here beats silently starting the run a month later.
  if v_start.status = 'archived' then
    perform public.app_error('BATCH_CLOSED', format('batch %s is archived', v_start.code), 409,
      jsonb_build_object('batch_code', v_start.code, 'status', v_start.status));
  end if;
  if not exists (select 1 from public.community_spaces sp
                  where sp.batch_id = v_start.id and sp.kind = p_segment and sp.active) then
    perform public.app_error('NO_SPACE_FOR_SEGMENT',
      format('batch %s has no active %s space', v_start.code, p_segment), 409,
      jsonb_build_object('batch_code', v_start.code, 'segment', p_segment));
  end if;
  -- A closed start batch blocks only when this is a NEW seat there. A member who
  -- already holds a seat in it (renewal, extension) continues unimpeded - the
  -- #33/#34 v_holds_seat intent, now expressed per cohort.
  if v_start.status <> 'open'
     and not exists (select 1 from public.batch_entitlements e
                      where e.user_id = p_user_id and e.batch_id = v_start.id
                        and e.status in ('queued', 'active')) then
    perform public.app_error('BATCH_CLOSED',
      format('batch %s is closed to new assignments', v_start.code), 409,
      jsonb_build_object('batch_code', v_start.code, 'status', v_start.status));
  end if;

  -- Allocate from the REGISTRY, in code order, under one ordered lock.
  for v_cand in
    select b.id, b.code, b.status, b.starts_on, b.gold_capacity, b.vip_capacity, b.total_capacity
      from public.batches b
     where b.code >= v_start.code
       and b.status = 'open'
       and exists (select 1 from public.community_spaces sp
                    where sp.batch_id = b.id and sp.kind = p_segment and sp.active)
       and not exists (select 1 from public.batch_entitlements e2
                        where e2.user_id = p_user_id and e2.batch_id = b.id
                          and e2.status in ('queued', 'active'))
     order by b.code
     limit p_count
     for update
  loop
    if p_enforce_capacity then
      v_cap := case p_segment when 'gold' then v_cand.gold_capacity else v_cand.vip_capacity end;
      if v_cap is not null then
        select count(*) into v_used
          from public.batch_seat_holders(v_cand.id, p_segment) h
         where h <> p_user_id;
        if v_used >= v_cap then
          perform public.app_error('BATCH_FULL',
            format('batch %s is full for %s (%s of %s seats)', v_cand.code, p_segment, v_used, v_cap), 409,
            jsonb_build_object('batch_code', v_cand.code, 'segment', p_segment,
                               'used', v_used, 'capacity', v_cap, 'scope', 'segment'));
        end if;
      end if;

      if v_cand.total_capacity is not null then
        select count(*) into v_used from (
          select h from public.batch_seat_holders(v_cand.id, 'gold') h
          union
          select h from public.batch_seat_holders(v_cand.id, 'vip')  h
        ) all_holders where h <> p_user_id;
        if v_used >= v_cand.total_capacity then
          perform public.app_error('BATCH_FULL',
            format('batch %s is full (%s of %s total seats)', v_cand.code, v_used, v_cand.total_capacity), 409,
            jsonb_build_object('batch_code', v_cand.code, 'used', v_used,
                               'capacity', v_cand.total_capacity, 'scope', 'total'));
        end if;
      end if;
    end if;

    -- A cohort reveals itself when it starts. Falling back to the month encoded
    -- in `code` keeps this deterministic when starts_on has not been set.
    v_activates := coalesce(v_cand.starts_on::timestamptz,
                            to_date(v_cand.code || '-01', 'YYYY-MM-DD')::timestamptz);

    insert into public.batch_entitlements (
      user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason,
      source_subscription_id, source_plan_key, source_request_id, source_import_row_id,
      granted_by, valid_until, activates_at, allocated_at
    ) values (
      p_user_id, v_cand.id, p_segment, v_idx, v_run_id, p_count, 'active', p_grant_reason,
      p_source_subscription_id, p_source_plan_key, p_source_request_id, p_source_import_row_id,
      p_actor, p_valid_until, v_activates, now()
    );

    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (v_cand.id, p_user_id, p_actor, 'entitle_allocate',
            jsonb_build_object('run_id', v_run_id, 'segment', p_segment,
                               'batch_index', v_idx, 'reason', p_grant_reason));

    v_allocated := v_allocated || jsonb_build_object('batch_id', v_cand.id, 'code', v_cand.code,
                                                     'batch_index', v_idx);
    v_idx := v_idx + 1;
  end loop;

  -- Shortfall: cohorts that do not exist yet. The seat is still owed, so it is
  -- recorded and bound by the FIFO trigger when Alex creates the next batch.
  while v_idx < p_count loop
    insert into public.batch_entitlements (
      user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason,
      source_subscription_id, source_plan_key, source_request_id, source_import_row_id,
      granted_by, valid_until
    ) values (
      p_user_id, null, p_segment, v_idx, v_run_id, p_count, 'queued', p_grant_reason,
      p_source_subscription_id, p_source_plan_key, p_source_request_id, p_source_import_row_id,
      p_actor, p_valid_until
    );
    v_queued := v_queued + 1;
    v_idx := v_idx + 1;
  end loop;

  if v_queued > 0 then
    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (null, p_user_id, p_actor, 'entitle',
            jsonb_build_object('run_id', v_run_id, 'segment', p_segment,
                               'queued', v_queued, 'reason', p_grant_reason));
  end if;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run_id, 'segment', p_segment,
    'run_length', p_count, 'allocated', v_allocated, 'queued', v_queued
  );
end;
$fn$;

revoke all on function public.grant_batch_run(uuid, text, uuid, int, text, uuid, text, uuid, uuid, timestamptz, uuid, boolean)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 10) revoke_batch_run() and the admin wrappers.
--     Revocation is bookkeeping hygiene, NOT the security control - the live
--     segment conjunct in L1 already cuts access the moment a plan changes.
--     It exists so the ledger tells the truth and so the seat is released.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.revoke_batch_run(
  p_user_id uuid,
  p_run_id  uuid default null,
  p_reason  text default null,
  p_actor   uuid default null,
  p_status  text default 'revoked'
)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if p_status not in ('revoked', 'superseded') then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      'revoke_batch_run can only set revoked or superseded', 409, null);
  end if;

  with touched as (
    update public.batch_entitlements e
       set status        = p_status,
           revoked_at    = case when p_status = 'revoked' then now() else e.revoked_at end,
           revoked_by    = case when p_status = 'revoked' then p_actor else e.revoked_by end,
           revoke_reason = coalesce(p_reason, e.revoke_reason),
           updated_at    = now()
     where e.user_id = p_user_id
       and e.status in ('queued', 'active')
       and (p_run_id is null or e.run_id = p_run_id)
    returning e.batch_id, e.run_id, e.segment
  )
  insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
  select t.batch_id, p_user_id, p_actor,
         case when p_status = 'revoked' then 'entitle_revoke' else 'entitle_supersede' end,
         jsonb_build_object('run_id', t.run_id, 'segment', t.segment, 'reason', p_reason)
    from touched t;

  get diagnostics v_n = row_count;

  -- Keep the legacy cache honest: leaving a stale subscriptions.batch_id behind
  -- would let the #39 bridge resurrect access for a member with no ledger rows.
  update public.subscriptions s
     set batch_id = null, updated_at = now()
   where s.user_id = p_user_id
     and s.batch_id is not null
     and not exists (select 1 from public.batch_entitlements e
                      where e.user_id = p_user_id and e.status in ('queued', 'active'));

  return v_n;
end;
$fn$;

revoke all on function public.revoke_batch_run(uuid, uuid, text, uuid, text) from public, anon, authenticated;

create or replace function public.admin_revoke_batch_run(
  p_user_id uuid,
  p_run_id  uuid default null,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_revoke_batch_run: admin only', 403, null);
  end if;
  v_n := public.revoke_batch_run(p_user_id, p_run_id, p_reason, auth.uid(), 'revoked');
  return jsonb_build_object('ok', true, 'revoked', v_n);
end;
$fn$;

revoke all on function public.admin_revoke_batch_run(uuid, uuid, text) from public, anon;
grant execute on function public.admin_revoke_batch_run(uuid, uuid, text) to authenticated;

-- Admin manual grant: the audited override. Capacity is enforced by DEFAULT -
-- an admin who wants to overfill must pass p_force, because the whole point of
-- capacity is that Alex can only teach so many people at once.
create or replace function public.admin_grant_batch_run(
  p_user_id  uuid,
  p_batch_id uuid,
  p_count    int     default null,
  p_force    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sub     public.subscriptions%rowtype;
  v_segment text;
  v_count   int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_grant_batch_run: admin only', 403, null);
  end if;

  select * into v_sub from public.subscriptions s
   where s.user_id = p_user_id and s.status = 'active'
     and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
   order by s.created_at desc limit 1;
  if v_sub.id is null then
    perform public.app_error('ENTITLEMENT_EXPIRED',
      'member has no active membership term to attach a cohort seat to', 403,
      jsonb_build_object('user_id', p_user_id));
  end if;

  select coalesce(ep.community_segment, 'general') into v_segment
    from public.enrollment_plans ep where ep.key = v_sub.plan_key;
  if v_segment not in ('gold', 'vip') then
    perform public.app_error('INVALID_PLAN',
      format('plan %s is not a cohort plan', v_sub.plan_key), 422,
      jsonb_build_object('plan_key', v_sub.plan_key, 'segment', v_segment));
  end if;

  v_count := coalesce(p_count, public.plan_eligible_batch_count(v_sub.plan_key), 1);

  return public.grant_batch_run(
    p_user_id, v_segment, p_batch_id, v_count, 'admin_manual',
    v_sub.id, v_sub.plan_key, null, null,
    coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), not p_force);
end;
$fn$;

revoke all on function public.admin_grant_batch_run(uuid, uuid, int, boolean) from public, anon;
grant execute on function public.admin_grant_batch_run(uuid, uuid, int, boolean) to authenticated;

-- Import path: the endpoint has already verified the caller is an admin and
-- holds the service role, but it has no is_admin() JWT context. This wrapper
-- exists only to bridge that, and is revoked from every browser-reachable role.
create or replace function public.grant_batch_run_for_import(
  p_user_id                uuid,
  p_segment                text,
  p_batch_id               uuid,
  p_count                  int,
  p_source_subscription_id uuid,
  p_source_plan_key        text,
  p_source_import_row_id   uuid,
  p_valid_until            timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Imports are capacity-EXEMPT by design (the #32 precedent: a CSV migration of
  -- existing paying students must not be refused by a cap set afterwards), but
  -- they now WRITE the ledger, so those seats are visible in Admin - Batches and
  -- count against every subsequent capacity check.
  return public.grant_batch_run(
    p_user_id, p_segment, p_batch_id, p_count, 'import',
    p_source_subscription_id, p_source_plan_key, null, p_source_import_row_id,
    p_valid_until, null, false);
end;
$fn$;

revoke all on function public.grant_batch_run_for_import(uuid, text, uuid, int, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 11) FIFO binder - when a cohort is created, the oldest owed seats claim it.
--     Capacity is deliberately NOT enforced here: these seats were already sold.
--     Refusing them would repudiate a paid entitlement; the admin sees committed
--     demand per cohort in Admin - Batches and sets capacity from that evidence.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.allocate_queued_entitlements(p_batch_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_b   record;
  v_e   record;
  v_n   int := 0;
  v_act timestamptz;
begin
  for v_b in
    select b.id, b.code, b.starts_on
      from public.batches b
     where (p_batch_id is null or b.id = p_batch_id)
       and b.status = 'open'
     order by b.code
  loop
    v_act := coalesce(v_b.starts_on::timestamptz, to_date(v_b.code || '-01', 'YYYY-MM-DD')::timestamptz);

    for v_e in
      select e.id, e.user_id, e.segment, e.run_id
        from public.batch_entitlements e
       where e.status = 'queued'
         and (e.valid_until is null or e.valid_until > now())
         and exists (select 1 from public.community_spaces sp
                      where sp.batch_id = v_b.id and sp.kind = e.segment and sp.active)
         and not exists (select 1 from public.batch_entitlements e2
                          where e2.user_id = e.user_id and e2.batch_id = v_b.id
                            and e2.status in ('queued', 'active'))
       order by e.granted_at, e.batch_index
       for update skip locked
    loop
      -- ★ The cursor's `not exists` guard was evaluated against the snapshot
      -- taken when the cursor opened, so it cannot see seats allocated by
      -- EARLIER ITERATIONS OF THIS LOOP. A member holding three queued seats
      -- would therefore have all three bound to this one cohort, violating
      -- batch_entitlements_one_seat_per_cohort. Re-check inside the loop, where
      -- our own uncommitted writes are visible: one member, one seat, per cohort.
      if exists (select 1 from public.batch_entitlements e2
                  where e2.user_id = v_e.user_id
                    and e2.batch_id = v_b.id
                    and e2.status in ('queued', 'active')) then
        continue;
      end if;

      update public.batch_entitlements
         set batch_id = v_b.id, status = 'active',
             activates_at = v_act, allocated_at = now(), updated_at = now()
       where id = v_e.id;

      insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
      values (v_b.id, v_e.user_id, null, 'entitle_allocate',
              jsonb_build_object('run_id', v_e.run_id, 'segment', v_e.segment, 'source', 'fifo_binder'));
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$fn$;

revoke all on function public.allocate_queued_entitlements(uuid) from public, anon, authenticated;

-- zz_ prefix so it fires AFTER batches_create_spaces - the binder needs the new
-- cohort's Gold/VIP spaces to exist before it can bind a seat to them.
create or replace function public.zz_batches_allocate_queued()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.allocate_queued_entitlements(new.id);
  return null;
end;
$fn$;

revoke all on function public.zz_batches_allocate_queued() from public, anon, authenticated;

drop trigger if exists zz_batches_allocate_queued on public.batches;
create trigger zz_batches_allocate_queued
  after insert on public.batches
  for each row execute function public.zz_batches_allocate_queued();

create or replace function public.admin_reconcile_queued_entitlements(p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_reconcile_queued_entitlements: admin only', 403, null);
  end if;
  v_n := public.allocate_queued_entitlements(p_batch_id);
  return jsonb_build_object('ok', true, 'allocated', v_n);
end;
$fn$;

revoke all on function public.admin_reconcile_queued_entitlements(uuid) from public, anon;
grant execute on function public.admin_reconcile_queued_entitlements(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 12) admin_finalize_enrollment() — #34's body, extended to materialise the run.
--
--     WHAT IS PRESERVED FROM #34 (do not "tidy" any of it away):
--       · the FOR UPDATE on the request row and the already-approved no-op;
--       · v_eff_plan (an extension stays on the member's CURRENT plan);
--       · the batch precedence chain per request kind;
--       · the profile patch INCLUDING updated_at, rejected_at/rejected_by = null
--         and rejection_reason = null - #33 dropped these and #34 restored them,
--         which is exactly the mistake this file must not repeat;
--       · most-recent-approval semantics for approved_at/approved_by.
--
--     WHAT CHANGED, AND WHY:
--       · The start batch is no longer locked here, and capacity is no longer
--         counted here. grant_batch_run() owns every `batches` lock and takes
--         them in ascending code order; a second lock taken here would invert
--         that order against the run and deadlock concurrent approvals.
--       · v_holds_seat / v_new_assignment are gone as separate concepts: the
--         per-cohort equivalent lives in grant_batch_run (a closed batch blocks
--         only a NEW seat there), which is the same intent expressed per seat.
--       · An upgrade that CHANGES segment supersedes the outstanding run first,
--         so gold and vip seats never coexist for one member.
--       · An extension advances valid_until on seats already held (forward-only)
--         and grants ceil(extension_days/30) MORE cohorts (D9).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_finalize_enrollment(
  p_request_id uuid,
  p_batch_id   uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_req          public.enrollment_requests%rowtype;
  v_prev         public.subscriptions%rowtype;
  v_new          public.subscriptions%rowtype;
  v_plan         public.enrollment_plans%rowtype;
  v_kind         text;
  v_eff_plan     text;
  v_segment      text;
  v_prev_segment text;
  v_batch        uuid;
  v_batch_row    public.batches%rowtype;
  v_count        int;
  v_valid_until  timestamptz;
  v_run          jsonb := null;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_finalize_enrollment: admin only', 403, null);
  end if;

  select * into v_req from public.enrollment_requests
   where id = p_request_id for update;
  if v_req.id is null then
    perform public.app_error('REQUEST_NOT_FOUND', 'admin_finalize_enrollment: request not found', 404,
      jsonb_build_object('request_id', p_request_id));
  end if;

  -- Idempotency: re-approving an approved request is a no-op.
  if v_req.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_req.status <> 'pending_review' then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      format('admin_finalize_enrollment: request is %s - only pending_review can be approved', v_req.status),
      409, jsonb_build_object('status', v_req.status));
  end if;

  v_kind := coalesce(v_req.request_kind, 'new');

  select * into v_prev from public.subscriptions
   where user_id = v_req.user_id
   order by created_at desc limit 1;

  -- Effective plan: extensions stay on the member's CURRENT plan.
  v_eff_plan := case when v_kind = 'extension'
                     then coalesce(v_prev.plan_key, v_req.plan_key)
                     else v_req.plan_key end;

  select * into v_plan from public.enrollment_plans where key = v_eff_plan;
  if v_plan.key is null then
    perform public.app_error('INVALID_PLAN', format('admin_finalize_enrollment: unknown plan %s', v_eff_plan),
      422, jsonb_build_object('plan_key', v_eff_plan));
  end if;
  -- New sales require a sellable plan; extensions may continue a retired one.
  if v_kind <> 'extension' and not v_plan.active then
    perform public.app_error('INVALID_PLAN', format('admin_finalize_enrollment: plan %s is inactive', v_eff_plan),
      422, jsonb_build_object('plan_key', v_eff_plan));
  end if;

  v_segment := coalesce(v_plan.community_segment, 'general');
  if v_prev.plan_key is not null then
    select coalesce(ep.community_segment, 'general') into v_prev_segment
      from public.enrollment_plans ep where ep.key = v_prev.plan_key;
  end if;

  if v_segment not in ('gold', 'vip') then
    v_batch := null;
  else
    if v_kind in ('renewal', 'extension') then
      v_batch := coalesce(p_batch_id, v_prev.batch_id, v_req.batch_id);
      if v_kind = 'extension' and p_batch_id is not null
         and v_prev.batch_id is not null and p_batch_id <> v_prev.batch_id then
        perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
          'admin_finalize_enrollment: an extension keeps the current batch - use the batch manager to move members',
          409, jsonb_build_object('current_batch_id', v_prev.batch_id));
      end if;
      -- A renewal may arrive after every held seat lapsed; fall back to the
      -- member's most recent cohort so the run continues from the right place.
      if v_batch is null then
        select e.batch_id into v_batch
          from public.batch_entitlements e
         where e.user_id = v_req.user_id and e.batch_id is not null
         order by e.granted_at desc, e.batch_index desc
         limit 1;
      end if;
    elsif v_kind = 'upgrade' then
      v_batch := p_batch_id;
      if v_batch is null and v_prev.batch_id is not null
         and exists (select 1 from public.community_spaces sp
                      where sp.kind = v_segment and sp.batch_id = v_prev.batch_id and sp.active) then
        v_batch := v_prev.batch_id;
      end if;
      if v_batch is null then v_batch := v_req.batch_id; end if;
    else
      v_batch := coalesce(p_batch_id, v_req.batch_id);
    end if;

    if v_batch is null then
      perform public.app_error('BATCH_REQUIRED',
        format('admin_finalize_enrollment: %s needs a batch - pick an open batch in the approve dialog', v_eff_plan),
        422, jsonb_build_object('plan_key', v_eff_plan, 'segment', v_segment));
    end if;

    -- Read-only validation for a precise error. The LOCK belongs to
    -- grant_batch_run, which takes every batch lock in code order.
    select * into v_batch_row from public.batches where id = v_batch;
    if v_batch_row.id is null then
      perform public.app_error('BATCH_NOT_FOUND', 'admin_finalize_enrollment: batch not found', 404,
        jsonb_build_object('batch_id', v_batch));
    end if;
  end if;

  -- Grant the term through the EXISTING functions (stacking / supersede / grace /
  -- the 60-365 clamp / the legacy-lifetime guard all live there).
  if v_kind = 'extension' then
    if v_req.extension_days is null or v_req.extension_days <= 0 then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'admin_finalize_enrollment: extension request has no extension_days', 409, null);
    end if;
    v_new := public.approve_extension(v_req.user_id, v_req.id, v_req.extension_days);
  else
    v_new := public.approve_subscription(v_req.user_id, v_req.plan_key, v_req.id);
  end if;

  update public.subscriptions
     set batch_id = v_batch, updated_at = now()
   where id = v_new.id;

  -- ── Materialise the cohort run (L1) ───────────────────────────────
  if v_segment in ('gold', 'vip') then
    v_valid_until := coalesce(v_new.grace_ends_at, v_new.ends_at);

    -- Every outstanding seat rides the new expiry. Forward-only, enforced by the
    -- guard trigger. Without this an extension would leave already-held seats
    -- expiring on the old date.
    update public.batch_entitlements e
       set valid_until = v_valid_until, updated_at = now()
     where e.user_id = v_req.user_id
       and e.status in ('queued', 'active')
       and v_valid_until is not null
       and (e.valid_until is null or e.valid_until < v_valid_until);

    -- A segment change must not leave gold and vip seats coexisting.
    if v_prev_segment is not null and v_prev_segment <> v_segment then
      perform public.revoke_batch_run(v_req.user_id, null,
        format('upgrade %s -> %s', v_prev_segment, v_segment), auth.uid(), 'superseded');
    end if;

    v_count := case
                 when v_kind = 'extension'
                   then greatest(1, least(12, ceil(v_req.extension_days / 30.0)::int))   -- D9
                 else public.plan_batch_count(v_plan.access_days, v_plan.eligible_batch_count)
               end;

    if v_count is null then
      perform public.app_error('INVALID_PLAN',
        format('plan %s has no access_days and no eligible_batch_count - cannot size the cohort run', v_eff_plan),
        422, jsonb_build_object('plan_key', v_eff_plan));
    end if;

    v_run := public.grant_batch_run(
      v_req.user_id, v_segment, v_batch, v_count,
      case when v_kind = 'new' then 'approval' else v_kind end,
      v_new.id, v_eff_plan, v_req.id, null, v_valid_until, auth.uid(), true);
  end if;

  -- Profile cache (mirrors the old client step 2).
  update public.profiles
     set is_paid = true,
         plan = v_eff_plan,
         approval_status = 'approved',
         approved_at = now(),
         approved_by = auth.uid(),
         rejected_at = null,
         rejected_by = null,
         rejection_reason = null,
         updated_at = now()
   where id = v_req.user_id;

  -- Request row (mirrors the old client step 3) + the resolved batch.
  update public.enrollment_requests
     set status = 'approved',
         rejection_reason = null,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         batch_id = v_batch,
         updated_at = now()
   where id = v_req.id;

  return jsonb_build_object(
    'ok', true,
    'subscription_id', v_new.id,
    'ends_at', v_new.ends_at,
    'batch_id', v_batch,
    'batch_code', (select code from public.batches where id = v_batch),
    'run', v_run
  );
end;
$fn$;

revoke all on function public.admin_finalize_enrollment(uuid, uuid) from public, anon;
grant execute on function public.admin_finalize_enrollment(uuid, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 13) admin_assign_batch() - routed through the ledger.
--
--     #32's version overwrote subscriptions.batch_id, which destroyed the record
--     of the previous cohort: the member instantly lost that cohort's courses,
--     recordings and discussion with nothing left to say why they ever had them.
--     Reassignment now SUPERSEDES the outstanding run and grants a new one, so
--     both the old and the new seats stay in the ledger.
--
--     The skip-reason vocabulary is preserved so the existing client message
--     ("N assigned - M skipped (reason, reason)") keeps working, with two
--     additions: no_run_length and run_conflict.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_assign_batch(p_user_ids uuid[], p_batch_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_uid       uuid;
  v_sub       public.subscriptions%rowtype;
  v_segment   text;
  v_count     int;
  v_assigned  int := 0;
  v_skipped   jsonb := '[]'::jsonb;
  v_batch     public.batches%rowtype;
  v_held      boolean;
  v_hint      text;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_assign_batch: admin only', 403, null);
  end if;

  select * into v_batch from public.batches where id = p_batch_id;
  if v_batch.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'admin_assign_batch: batch not found', 404,
      jsonb_build_object('batch_id', p_batch_id));
  end if;
  if v_batch.status <> 'open' then
    perform public.app_error('BATCH_CLOSED',
      format('admin_assign_batch: batch %s is %s', v_batch.code, v_batch.status), 409,
      jsonb_build_object('batch_code', v_batch.code, 'status', v_batch.status));
  end if;

  foreach v_uid in array coalesce(p_user_ids, array[]::uuid[]) loop
    begin
      select * into v_sub from public.subscriptions s
       where s.user_id = v_uid and s.status = 'active'
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       order by s.created_at desc limit 1;

      if v_sub.id is null then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_active_subscription');
        continue;
      end if;

      select coalesce(ep.community_segment, 'general') into v_segment
        from public.enrollment_plans ep where ep.key = v_sub.plan_key;
      if v_segment not in ('gold', 'vip') then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'not_a_premium_plan');
        continue;
      end if;

      select exists (select 1 from public.batch_entitlements e
                      where e.user_id = v_uid and e.batch_id = p_batch_id
                        and e.status in ('queued', 'active')) into v_held;
      if v_held then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'already_assigned');
        continue;
      end if;

      if not exists (select 1 from public.community_spaces sp
                      where sp.batch_id = p_batch_id and sp.kind = v_segment and sp.active) then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_space_for_segment');
        continue;
      end if;

      v_count := public.plan_eligible_batch_count(v_sub.plan_key);
      if v_count is null then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_run_length');
        continue;
      end if;

      -- Move, do not destroy: supersede the outstanding run, then grant a new
      -- one from the chosen cohort. Both remain in the ledger.
      perform public.revoke_batch_run(v_uid, null,
        format('reassigned to %s', v_batch.code), auth.uid(), 'superseded');

      perform public.grant_batch_run(
        v_uid, v_segment, p_batch_id, v_count, 'admin_manual',
        v_sub.id, v_sub.plan_key, null, null,
        coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), true);

      update public.subscriptions set batch_id = p_batch_id, updated_at = now() where id = v_sub.id;

      insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
      values (p_batch_id, v_uid, auth.uid(),
              case when v_sub.batch_id is null then 'assign' else 'reassign' end,
              jsonb_build_object('subscription_id', v_sub.id, 'segment', v_segment,
                                 'from_batch_id', v_sub.batch_id, 'to_batch_id', p_batch_id));
      v_assigned := v_assigned + 1;

    exception
      -- Only OUR refusals become a per-user skip. A deadlock or serialization
      -- failure must surface, not masquerade as "this member was skipped" —
      -- that would silently under-assign a bulk operation.
      when sqlstate 'PT409' or sqlstate 'PT422' or sqlstate 'PT403' or sqlstate 'PT404' then
        get stacked diagnostics v_hint = pg_exception_hint;
        v_skipped := v_skipped || jsonb_build_object(
          'user_id', v_uid,
          'reason', lower(coalesce(nullif(v_hint, ''), 'run_conflict')));
    end;
  end loop;

  return jsonb_build_object('ok', true, 'assigned', v_assigned,
                            'skipped', v_skipped, 'batch_code', v_batch.code);
end;
$fn$;

revoke all on function public.admin_assign_batch(uuid[], uuid) from public, anon;
grant execute on function public.admin_assign_batch(uuid[], uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 14) Admin read RPCs, all counting from L1 so the numbers agree everywhere.
-- ───────────────────────────────────────────────────────────────────
-- DROP + CREATE: the return type gains total_capacity and the queued counters,
-- and Postgres refuses to change an OUT-parameter row type in place. A dropped
-- function LOSES ITS GRANTS, so the grant below is not optional housekeeping —
-- omitting it is the classic way a drop+recreate silently breaks an admin screen.
drop function if exists public.admin_batch_overview();

create function public.admin_batch_overview()
returns table (
  batch_id uuid, code text, name text, status text,
  starts_on date, ends_on date,
  gold_capacity int, vip_capacity int, total_capacity int,
  gold_active bigint, vip_active bigint, total_active bigint,
  gold_queued bigint, vip_queued bigint
)
language sql stable security definer set search_path = public
as $fn$
  select b.id, b.code, b.name, b.status, b.starts_on, b.ends_on,
         b.gold_capacity, b.vip_capacity, b.total_capacity,
         (select count(*) from public.batch_seat_holders(b.id, 'gold')) as gold_active,
         (select count(*) from public.batch_seat_holders(b.id, 'vip'))  as vip_active,
         (select count(*) from (
            select h from public.batch_seat_holders(b.id, 'gold') h
            union
            select h from public.batch_seat_holders(b.id, 'vip') h) u)  as total_active,
         -- Committed demand: seats already sold that no cohort has absorbed yet.
         -- Alex needs this BEFORE setting a capacity, because queued seats are
         -- never retro-refused (they were paid for).
         (select count(*) from public.batch_entitlements e
           where e.status = 'queued' and e.segment = 'gold'
             and (e.valid_until is null or e.valid_until > now()))       as gold_queued,
         (select count(*) from public.batch_entitlements e
           where e.status = 'queued' and e.segment = 'vip'
             and (e.valid_until is null or e.valid_until > now()))       as vip_queued
    from public.batches b
   where public.is_admin()
   order by b.code desc;
$fn$;

revoke all on function public.admin_batch_overview() from public, anon;
grant execute on function public.admin_batch_overview() to authenticated;

-- Server-side, paged replacement for the client's "needs batch assignment"
-- queue. The old client query fetched 400 subscriptions and THEN filtered to
-- premium in JS, so 400+ general rows hid the queue entirely.
create or replace function public.admin_batches_needing_assignment(
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  user_id uuid, email text, full_name text,
  plan_key text, segment text, subscription_id uuid, ends_at timestamptz, total_count bigint
)
language sql stable security definer set search_path = public
as $fn$
  with live as (
    select distinct on (s.user_id) s.user_id, s.id as subscription_id, s.plan_key,
           coalesce(ep.community_segment, 'general') as segment,
           coalesce(s.grace_ends_at, s.ends_at) as ends_at
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.user_id, s.created_at desc
  ),
  needy as (
    select l.*
      from live l
     where l.segment in ('gold', 'vip')
       and not exists (select 1 from public.batch_entitlements e
                        where e.user_id = l.user_id and e.status in ('queued', 'active'))
  )
  select n.user_id, p.email, p.full_name, n.plan_key, n.segment,
         n.subscription_id, n.ends_at,
         (select count(*) from needy) as total_count
    from needy n
    join public.profiles p on p.id = n.user_id
   where public.is_admin()
   order by n.ends_at nulls last, n.user_id
   limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$fn$;

revoke all on function public.admin_batches_needing_assignment(int, int) from public, anon;
grant execute on function public.admin_batches_needing_assignment(int, int) to authenticated;

-- Roster for one cohort+segment, paged.
create or replace function public.admin_batch_roster(
  p_batch_id uuid, p_segment text, p_limit int default 50, p_offset int default 0
)
returns table (user_id uuid, email text, full_name text, avatar_url text, total_count bigint)
language sql stable security definer set search_path = public
as $fn$
  with holders as (select h from public.batch_seat_holders(p_batch_id, p_segment) h)
  select p.id, p.email, p.full_name, p.avatar_url, (select count(*) from holders)
    from holders
    join public.profiles p on p.id = holders.h
   where public.is_admin()
   order by p.full_name nulls last, p.id
   limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$fn$;

revoke all on function public.admin_batch_roster(uuid, text, int, int) from public, anon;
grant execute on function public.admin_batch_roster(uuid, text, int, int) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 15) Drift view - the #39 gate. Every premium member should have a ledger row
--     that agrees with their subscription cache. Anything else is named here.
-- ───────────────────────────────────────────────────────────────────
create or replace view public.v_batch_entitlement_drift
with (security_invoker = true)
as
select s.user_id,
       s.id as subscription_id,
       s.plan_key,
       coalesce(ep.community_segment, 'general') as segment,
       s.batch_id as cached_batch_id,
       (select count(*) from public.batch_entitlements e
         where e.user_id = s.user_id and e.status in ('queued', 'active')) as outstanding_seats,
       case
         when coalesce(ep.community_segment, 'general') not in ('gold', 'vip') then
           case when s.batch_id is null then 'ok' else 'general_plan_has_batch' end
         when not exists (select 1 from public.batch_entitlements e
                           where e.user_id = s.user_id and e.status in ('queued', 'active'))
           then 'premium_without_ledger'
         when s.batch_id is null then 'missing_cache'
         when not exists (select 1 from public.batch_entitlements e
                           where e.user_id = s.user_id and e.batch_id = s.batch_id
                             and e.status in ('queued', 'active'))
           then 'cache_not_in_ledger'
         else 'ok'
       end as drift
  from public.subscriptions s
  left join public.enrollment_plans ep on ep.key = s.plan_key
 where s.status = 'active'
   and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());

comment on view public.v_batch_entitlement_drift is
  'Gate for #39 (retiring the subscriptions.batch_id read bridge). security_invoker = the caller''s '
  'RLS applies, so a member sees only their own row and an admin sees all. #39 may run only when '
  'this reads ''ok'' for every row.';

-- ───────────────────────────────────────────────────────────────────
-- 16) Backfill - idempotent, capacity-EXEMPT, archived batches skipped.
--
--     Members granted before #35 already paid; a capacity set afterwards must
--     never retro-refuse them. On the live database this matches nothing today
--     (zero subscriptions carry a batch_id), which is precisely why it has to be
--     written and reviewed now rather than the first time it matters.
--
--     Historical expired/cancelled premium terms are deliberately NOT
--     backfilled: inventing granted_at/valid_until for closed terms would put
--     fiction in an audit table. subscriptions + batch_events remain the
--     pre-#35 record.
-- ───────────────────────────────────────────────────────────────────
do $$
declare
  r        record;
  v_users  int := 0;
  v_skip   int := 0;
begin
  for r in
    select s.id, s.user_id, s.plan_key, s.request_id,
           coalesce(s.grace_ends_at, s.ends_at) as valid_until,
           b.id as batch_id, b.status as batch_status,
           coalesce(ep.community_segment, 'general') as segment,
           public.plan_batch_count(ep.access_days, ep.eligible_batch_count) as run_count
      from public.subscriptions s
      join public.batches b on b.id = s.batch_id
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       and coalesce(ep.community_segment, 'general') in ('gold', 'vip')
       and not exists (select 1 from public.batch_entitlements e
                        where e.user_id = s.user_id and e.status in ('queued', 'active'))
     order by s.user_id
  loop
    if r.run_count is null then
      raise notice '#35 backfill: user % on lifetime premium plan % has no eligible_batch_count - skipped',
        r.user_id, r.plan_key;
      v_skip := v_skip + 1;
      continue;
    end if;
    if r.batch_status = 'archived' then
      raise notice '#35 backfill: user % cached into ARCHIVED batch - skipped, assign manually', r.user_id;
      v_skip := v_skip + 1;
      continue;
    end if;

    perform public.grant_batch_run(
      r.user_id, r.segment, r.batch_id, r.run_count, 'backfill',
      r.id, r.plan_key, r.request_id, null, r.valid_until, null, false);
    v_users := v_users + 1;
  end loop;

  raise notice '#35 backfill: % premium subscription(s) materialised, % skipped', v_users, v_skip;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 17) Reload PostgREST's schema cache so the new RPCs resolve immediately.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING - paste these and confirm the expected values.
--
--   -- the ledger exists and is empty on a database with no premium members
--   select count(*) from public.batch_entitlements;                          -- 0
--
--   -- authenticated cannot write it, policy or no policy
--   select has_table_privilege('authenticated','public.batch_entitlements','insert'),   -- f
--          has_table_privilege('authenticated','public.batch_entitlements','update'),   -- f
--          has_table_privilege('authenticated','public.batch_entitlements','delete');   -- f
--
--   -- the allocator is not callable from a browser
--   select has_function_privilege('authenticated',
--     'public.grant_batch_run(uuid,text,uuid,int,text,uuid,text,uuid,uuid,timestamptz,uuid,boolean)',
--     'execute');                                                            -- f
--
--   -- #34's housekeeping survived, and the run is materialised
--   select prosrc like '%rejected_at = null%'  as clears_rejection,
--          prosrc like '%grant_batch_run%'     as materialises_run
--     from pg_proc where proname = 'admin_finalize_enrollment';              -- t | t
--
--   -- L1 is the space source, with the bridge subordinate to the ledger
--   select prosrc like '%user_entitled_batches%' as reads_ledger
--     from pg_proc where proname = 'user_community_space_ids';               -- t
--   select prosrc like '%not exists (select 1 from public.batch_entitlements e2%' as bridge_subordinate
--     from pg_proc where proname = 'user_entitled_batches';                  -- t
--
--   -- D1 run lengths
--   select public.plan_eligible_batch_count('gold_live'),                    -- 6
--          public.plan_eligible_batch_count('vip'),                          -- 6
--          public.plan_eligible_batch_count('core_self_paced');              -- 2
--
--   -- a nobody gets nothing
--   select count(*) from public.user_community_space_ids
--     ('00000000-0000-0000-0000-000000000000'::uuid);                        -- 0
--
--   -- no drift
--   select drift, count(*) from public.v_batch_entitlement_drift group by 1; -- only 'ok'
--
--   -- error contract, from the APP as an admin (not the SQL editor):
--   --   rpc('admin_finalize_enrollment', { p_request_id: '<a gold request>' })
--   --   -> HTTP 422, { hint: 'BATCH_REQUIRED', details: '{"code":"BATCH_REQUIRED",...}' }
-- ═══════════════════════════════════════════════════════════════════

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-07-30-batch-entitlements.sql', null,
  'batch_entitlements ledger (#35): registry-allocated cohort runs + FIFO queue, one seat predicate, '
  'live-segment reconciliation, entitlement-backed user_community_space_ids (per-user legacy bridge), '
  'PT-errcode stable error codes, admin_assign_batch + imports routed through grant_batch_run')
on conflict (filename) do nothing;


-- ═════════════════════════════════════════════════════════════════════════════
-- §23) FOLDED VERBATIM — 2026-07-31-community-plan-capabilities.sql
--      per-plan community capabilities + D2 General announcement-only
--
--      Appended at the tail for the same reason as §19-§21: the earlier
--      sections create the pre-#35 shapes, and these files' DROP+CREATE must
--      win on a fresh install. Every file is idempotent and self-guarded, so
--      appending reproduces the live end state exactly.
--      RE-FOLD whenever the dated file changes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- #36 — per-PLAN community capabilities, and General as an announcement space
--
-- WHY
--   Until now a member's community rights came from ONE place: the three
--   capability flags on community_spaces (member_posting / member_comments /
--   member_reactions), read inline by each INSERT policy. Those flags are
--   per-SPACE, so inside the shared General space every plan necessarily has
--   identical rights. That makes the product rule inexpressible:
--
--     Core / Sampler(Essentials) / Silver  →  read + react, never write
--     Gold / VIP                           →  full forum, but only inside their
--                                             own per-batch private space
--
--   In Discord this gap is the actual business problem: self-paced students ask
--   questions in the open channel and the support load lands on one person.
--
-- WHAT #36 ADDS
--   The missing dimension — the PLAN — as seven fail-closed booleans on
--   enrollment_plans, fused with the existing space flags by ONE resolver:
--
--     effective = plan capability
--             AND space flag
--             AND space membership (L1)
--             AND is_approved() AND is_enrolled()
--
--   No policy re-derives that. They all read user_community_capabilities().
--
-- ★ D2 — GENERAL IS ANNOUNCEMENT-ONLY (a product decision, applied as data)
--   No member may create a post or a comment in General. Not Core, not Sampler,
--   not Silver, and NOT Gold or VIP. Reactions stay ON for every plan, because
--   reacting is not creating discussion and the plan matrix grants it to all.
--   Admins still post announcements through the *_admin_all policies.
--
--   PRODUCTION HAS DRIFTED: #32 seeded General with member_comments = false, and
--   a documented "temporary softening" UPDATE (COMMUNITY_SETUP.md step 8) set it
--   back to true and was never reverted. Live right now, member_posting = true
--   and member_comments = true, so every plan can post AND reply in General.
--
--   ⚠ USER-VISIBLE CONSEQUENCE, STATED PLAINLY
--     On the day this ships, EVERY CURRENT MEMBER LOSES THE ABILITY TO WRITE
--     ANYTHING IN THE COMMUNITY. There are 4 profiles, 2 active subscriptions and
--     zero Gold/VIP members; all three existing posts are in General and every
--     member is on a general-segment plan. What remains for them: reading
--     everything — including those three posts and all historical replies — and
--     reacting. Only the admin can post. Gold and VIP members regain the full
--     forum, but only inside their own per-batch space, and there are none of
--     those members yet.
--
--     Existing content is NEVER deleted. Authors keep the ability to withdraw
--     their own posts (see the UPDATE split below).
--
--     #36 MUST SHIP WITH ITS CLIENT BUILD. The currently deployed client
--     computes canPost as `!currentSpace || currentSpace.member_posting !== false`
--     — it defaults OPEN when the space is unresolved, so a stale bundle would
--     show a New Topic button whose submit returns a bare 42501.
--
-- ORDER
--   Run AFTER db/2026-07-30-batch-entitlements.sql (#35) — the resolver reads L1.
--   Idempotent, additive. No table or column is dropped; no row is deleted.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Preflight.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.batch_entitlements') is null then
    raise exception '#36 requires #35 — run db/2026-07-30-batch-entitlements.sql first.';
  end if;
  if to_regclass('public.community_spaces') is null or to_regclass('public.community_posts') is null then
    raise exception '#36 requires #32/#23/#24 (community spaces + forum).';
  end if;
  if to_regproc('public.app_error') is null then
    raise exception '#36 requires public.app_error() from #35.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#36 requires #31 — the tail insert would abort the migration.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) Per-plan capability columns.
--
--    Every default is FALSE except the two react flags. That is the whole
--    safety property: a plan added later — or an unknown/typo'd plan key —
--    grants no ability to write anything until someone deliberately says so.
--    Reactions default true because D2 grants them to every plan and a reaction
--    creates no content and no support load.
--
--    There is deliberately NO `private_community_access` column:
--    enrollment_plans.community_segment already is that flag and L1 already is
--    its enforcement point. A second boolean could disagree with the segment,
--    and would add one more member to the lockstep set for no gain.
-- ───────────────────────────────────────────────────────────────────
alter table public.enrollment_plans
  add column if not exists can_post_in_general     boolean not null default false,
  add column if not exists can_comment_in_general  boolean not null default false,
  add column if not exists can_react_in_general    boolean not null default true,
  add column if not exists can_post_in_private     boolean not null default false,
  add column if not exists can_comment_in_private  boolean not null default false,
  add column if not exists can_react_in_private    boolean not null default true,
  add column if not exists can_upload_attachments  boolean not null default false;

comment on column public.enrollment_plans.can_post_in_general is
  'D2: false for EVERY plan — General is announcement-only. Flipping this to true for a plan is a '
  'product decision; the community_spaces_general_announcement_only CHECK must be dropped too.';
comment on column public.enrollment_plans.can_comment_in_private is
  'Gold/VIP only. Fused with community_spaces.member_comments by user_community_capabilities(); '
  'mirrored by src/lib/communityCapabilities.js — keep in lockstep.';

-- D2 seed. Guarded so it runs only on FIRST apply: a later admin edit (say,
-- opening posting in the Gold spaces) must not be clobbered by a re-run.
do $$
declare v_seeded boolean;
begin
  select exists (
    select 1 from public.schema_migrations
     where filename = '2026-07-31-community-plan-capabilities.sql'
  ) into v_seeded;

  if v_seeded then
    raise notice '#36: capability seed skipped — already applied once (admin edits preserved).';
  else
    -- Nobody writes in General.
    update public.enrollment_plans
       set can_post_in_general = false,
           can_comment_in_general = false,
           can_react_in_general = true;

    -- The two cohort plans get the full forum in their own private space.
    update public.enrollment_plans
       set can_post_in_private = true,
           can_comment_in_private = true,
           can_react_in_private = true,
           can_upload_attachments = true
     where coalesce(community_segment, 'general') in ('gold', 'vip');

    -- Self-paced plans may still react, and may attach nothing (they cannot
    -- create the content an attachment would belong to).
    update public.enrollment_plans
       set can_upload_attachments = false
     where coalesce(community_segment, 'general') = 'general';

    raise notice '#36: capability columns seeded for D2.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 2) ★ The D2 flip on the General space, pinned by a CHECK.
--
--    The UPDATE is written so it is a no-op once correct (idempotent), and the
--    CHECK makes the state deliberate: reversing D2 means dropping a named
--    constraint and recording it, not quietly running an UPDATE that the next
--    deploy silently re-applies. That is exactly how prod drifted the first time.
-- ───────────────────────────────────────────────────────────────────
update public.community_spaces
   set member_posting = false,
       member_comments = false,
       member_reactions = true,
       updated_at = now()
 where kind = 'general'
   and (member_posting or member_comments or not member_reactions);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'community_spaces_general_announcement_only') then
    alter table public.community_spaces
      add constraint community_spaces_general_announcement_only
      check (kind <> 'general' or (member_posting = false and member_comments = false));
  end if;
end $$;

comment on constraint community_spaces_general_announcement_only on public.community_spaces is
  'D2 (#36): General is announcement-only — members read and react, only admins post. To reverse '
  'the product decision, DROP this constraint explicitly and record it in db/README.md. Do not work '
  'around it with an UPDATE: an un-recorded UPDATE is how production drifted from #32 in the first place.';

-- ───────────────────────────────────────────────────────────────────
-- 3) The resolver — ONE definition of "what may I do here?".
--
--    Set-returning rather than a per-row scalar so policies consume it as an
--    UNCORRELATED subquery:
--
--      ✅ space_id in (select c.space_id from public.my_community_capabilities() c where c.can_post)
--      ❌ exists (select 1 from public.my_community_capabilities() c where c.space_id = <row>.space_id ...)
--
--    The first is an InitPlan — evaluated ONCE per statement (the #29
--    discipline). The second re-runs the whole resolver per candidate row,
--    which on a 20-post feed page means 20 executions of a function that itself
--    joins subscriptions and enrollment_plans.
--
--    bool_or across every currently-valid term: a member has exactly one live
--    subscription today, but if that ever changes the most permissive of their
--    paid plans is the defensible answer, and bool_or over an empty set is NULL
--    → coalesced to the fail-closed default below.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.user_community_capabilities(p_user uuid)
returns table (
  space_id uuid, kind text,
  can_post boolean, can_comment boolean, can_react boolean, can_attach boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  with me as (
    select coalesce(p.is_admin, false) as is_admin,
           (p.approval_status = 'approved' or p.is_admin) as approved
      from public.profiles p where p.id = p_user
  ),
  caps as (
    select bool_or(coalesce(ep.can_post_in_general, false))    as post_general,
           bool_or(coalesce(ep.can_comment_in_general, false)) as comment_general,
           bool_or(coalesce(ep.can_react_in_general, true))    as react_general,
           bool_or(coalesce(ep.can_post_in_private, false))    as post_private,
           bool_or(coalesce(ep.can_comment_in_private, false)) as comment_private,
           bool_or(coalesce(ep.can_react_in_private, true))    as react_private,
           bool_or(coalesce(ep.can_upload_attachments, false)) as attach
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
  ),
  eff as (
    select coalesce((select is_admin from me), false)  as is_admin,
           -- A member with no resolvable plan row (legacy grandfather, unknown
           -- key) gets the fail-closed defaults: read and react, write nothing.
           coalesce((select post_general    from caps), false) as post_general,
           coalesce((select comment_general from caps), false) as comment_general,
           coalesce((select react_general   from caps), true)  as react_general,
           coalesce((select post_private    from caps), false) as post_private,
           coalesce((select comment_private from caps), false) as comment_private,
           coalesce((select react_private   from caps), true)  as react_private,
           coalesce((select attach          from caps), false) as attach,
           coalesce((select approved from me), false) as approved
  )
  select sp.id,
         sp.kind,
         e.is_admin or (e.approved and sp.member_posting
                        and case when sp.kind = 'general' then e.post_general else e.post_private end),
         e.is_admin or (e.approved and sp.member_comments
                        and case when sp.kind = 'general' then e.comment_general else e.comment_private end),
         e.is_admin or (e.approved and sp.member_reactions
                        and case when sp.kind = 'general' then e.react_general else e.react_private end),
         -- Attaching requires BOTH the attachment right and the right to create
         -- the thing the attachment hangs off — otherwise a plan that cannot
         -- post could still fill the private bucket.
         e.is_admin or (e.approved and e.attach and sp.member_posting
                        and case when sp.kind = 'general' then e.post_general else e.post_private end)
    from public.community_spaces sp, eff e
   -- L1 is the single membership seam. Never re-derive it here.
   where sp.id in (select public.user_community_space_ids(p_user));
$fn$;

revoke all on function public.user_community_capabilities(uuid) from public, anon, authenticated;

create or replace function public.my_community_capabilities()
returns table (
  space_id uuid, kind text,
  can_post boolean, can_comment boolean, can_react boolean, can_attach boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  select * from public.user_community_capabilities(auth.uid());
$fn$;

revoke all on function public.my_community_capabilities() from public, anon;
grant execute on function public.my_community_capabilities() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 4) my_community_spaces() — the client switcher RPC, now carrying the
--    EFFECTIVE capabilities so the UI and the database cannot disagree.
--
--    DROP + CREATE because the return type changes. A dropped function loses
--    its grants, so the grant is re-applied immediately below — forgetting that
--    is the classic way a drop+recreate silently breaks an admin screen.
--
--    member_count now comes from the indexed seat predicate instead of the old
--    whole-table DISTINCT ON over subscriptions, which ran on every community load.
-- ───────────────────────────────────────────────────────────────────
drop function if exists public.my_community_spaces();

create function public.my_community_spaces()
returns table (
  id uuid, slug text, kind text, name text, batch_code text,
  member_posting boolean, member_comments boolean, member_reactions boolean,
  can_post boolean, can_comment boolean, can_react boolean, can_attach boolean,
  member_count bigint, is_default boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  with caps as (select * from public.user_community_capabilities(auth.uid())),
  my_default as (
    select coalesce(
      -- A cohort member lands in their own private space, newest cohort first.
      (select sp.id
         from public.community_spaces sp
         join public.user_entitled_batches(auth.uid()) eb
           on eb.batch_id = sp.batch_id and eb.segment = sp.kind
        where sp.active
        order by sp.created_at desc
        limit 1),
      (select sp.id from public.community_spaces sp where sp.kind = 'general' limit 1)
    ) as space_id
  )
  select sp.id, sp.slug, sp.kind, sp.name, b.code as batch_code,
         sp.member_posting, sp.member_comments, sp.member_reactions,
         c.can_post, c.can_comment, c.can_react, c.can_attach,
         case
           when sp.kind = 'general' then
             (select count(*) from public.profiles p
               where (p.approval_status = 'approved' or p.is_admin)
                 and public.user_is_enrolled(p.id))
           else (select count(*) from public.batch_seat_holders(sp.batch_id, sp.kind))
         end::bigint as member_count,
         (sp.id = (select space_id from my_default)) as is_default
    from caps c
    join public.community_spaces sp on sp.id = c.space_id
    left join public.batches b on b.id = sp.batch_id
   order by (sp.kind = 'general') desc, b.code desc nulls last, sp.name;
$fn$;

revoke all on function public.my_community_spaces() from public, anon;
grant execute on function public.my_community_spaces() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 5) community_write_denial() — a read-only DIAGNOSTIC, never an authorization.
--
--    RLS cannot carry an error code: Postgres raises 42501 from the executor
--    with a fixed message and no hook. Moving authorization out of RLS into
--    triggers just to attach a code would trade a proven boundary for a
--    friendlier string — refused. Instead the client asks this function WHY a
--    write would fail, so it can disable the composer and say something honest
--    instead of surfacing a raw permission error.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.community_write_denial(p_space_id uuid, p_kind text default 'post')
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with sp as (select * from public.community_spaces where id = p_space_id),
  cap as (select * from public.my_community_capabilities() where space_id = p_space_id)
  select case
    when not exists (select 1 from sp) then
      jsonb_build_object('allowed', false, 'code', 'COMMUNITY_ACCESS_DENIED', 'reason', 'no_such_space')
    when not exists (select 1 from cap) then
      jsonb_build_object('allowed', false, 'code', 'COMMUNITY_ACCESS_DENIED', 'reason', 'not_a_member')
    when p_kind = 'comment' and (select can_comment from cap) then jsonb_build_object('allowed', true)
    when p_kind = 'react'   and (select can_react   from cap) then jsonb_build_object('allowed', true)
    when p_kind = 'attach'  and (select can_attach  from cap) then jsonb_build_object('allowed', true)
    when p_kind = 'post'    and (select can_post    from cap) then jsonb_build_object('allowed', true)
    when (select kind from sp) = 'general' then
      jsonb_build_object('allowed', false,
        'code', case when p_kind = 'comment' then 'COMMENT_PERMISSION_DENIED' else 'COMMUNITY_ACCESS_DENIED' end,
        'reason', 'announcement_space')
    when p_kind = 'comment' then
      jsonb_build_object('allowed', false, 'code', 'COMMENT_PERMISSION_DENIED', 'reason', 'plan_or_space')
    else
      jsonb_build_object('allowed', false, 'code', 'COMMUNITY_ACCESS_DENIED', 'reason', 'plan_or_space')
  end;
$fn$;

revoke all on function public.community_write_denial(uuid, text) from public, anon;
grant execute on function public.community_write_denial(uuid, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 6) The write policies, re-pointed at the resolver.
--
--    Shape is unchanged; only the capability SOURCE moves from the raw space
--    flag to the fused plan × space answer. is_approved()/is_enrolled() stay
--    (the #28 write-gate), and the admin-only-tag rule stays.
-- ───────────────────────────────────────────────────────────────────
-- ★ READ must admit an author's OWN withdrawn rows, or withdrawal is impossible.
--
--   Postgres refuses an UPDATE whose resulting row would not be visible to the
--   writer under the table's SELECT policies. `community_posts_read` (from #24)
--   admits only status = 'active', so an author setting status = 'deleted'
--   produces a row they can no longer see, and the statement fails with 42501 —
--   "new row violates row-level security policy".
--
--   Consequence: the member soft-delete that CLAUDE.md and #24/#28 describe
--   ("members edit and soft-delete their own rows") could never actually have
--   succeeded. It was never covered by a test, because until now nothing
--   executed these policies as a real member. Adding the author branch below
--   makes withdrawal work, and is strictly narrower than it looks: it lets an
--   author see only their OWN non-active rows, which they wrote.
--
--   Hiding stays admin-only and stays invisible to the author: the branch is
--   deliberately limited to 'deleted', so an admin-hidden post does not become
--   readable by the person who wrote it.
drop policy if exists community_posts_read on public.community_posts;
create policy community_posts_read on public.community_posts
  for select to authenticated
  using (
    (select public.is_admin())
    or (status = 'active'
        and (select public.is_approved()) and (select public.is_enrolled())
        and space_id in (select public.my_community_space_ids()))
    or (author_id = (select auth.uid()) and status = 'deleted')
  );

drop policy if exists community_comments_read on public.community_comments;
create policy community_comments_read on public.community_comments
  for select to authenticated
  using (
    (select public.is_admin())
    or (status = 'active'
        and (select public.is_approved()) and (select public.is_enrolled())
        and space_id in (select public.my_community_space_ids())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'))
    or (author_id = (select auth.uid()) and status = 'deleted')
  );

drop policy if exists community_posts_own_insert on public.community_posts;
create policy community_posts_own_insert on public.community_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and (select public.is_approved()) and (select public.is_enrolled())
    and space_id in (select c.space_id from public.my_community_capabilities() c where c.can_post)
    and not exists (select 1 from public.community_tags t
                     where t.slug = tag_slug and t.admin_only)
  );

-- ★ The UPDATE split (withdraw vs keep-published).
--
--   Gating the whole policy on can_post would strand every historical General
--   post: its author could neither edit NOR delete it, because #28's own-update
--   policy is also the soft-delete path. Gating on nothing lets a Core member
--   keep re-publishing content D2 forbids. So:
--     • status → 'deleted'  (WITHDRAW): allowed in any space you belong to;
--     • status → 'active'   (EDIT / restore): requires create rights.
--
--   Consequence, deliberate and documented: a soft-delete in General is
--   terminal, because restoring sets status='active'. The client only ever
--   soft-deletes and already treats 'deleted' as terminal, so no UI changes.
drop policy if exists community_posts_own_update on public.community_posts;
create policy community_posts_own_update on public.community_posts
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden')
  with check (
    author_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and (
      (status = 'deleted'
        and space_id in (select public.my_community_space_ids()))
      or
      (status = 'active'
        and space_id in (select c.space_id from public.my_community_capabilities() c where c.can_post)
        and not exists (select 1 from public.community_tags t
                         where t.slug = tag_slug and t.admin_only))
    )
  );

drop policy if exists community_comments_own_insert on public.community_comments;
create policy community_comments_own_insert on public.community_comments
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and (select public.is_approved()) and (select public.is_enrolled())
    and exists (
      select 1 from public.community_posts p
       where p.id = post_id
         and p.status = 'active'
         and not p.comments_locked
         and p.space_id in (select c.space_id from public.my_community_capabilities() c where c.can_comment)
    )
  );

drop policy if exists community_comments_own_update on public.community_comments;
create policy community_comments_own_update on public.community_comments
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden')
  with check (
    author_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and (
      (status = 'deleted' and space_id in (select public.my_community_space_ids()))
      or
      (status = 'active'
        and space_id in (select c.space_id from public.my_community_capabilities() c where c.can_comment))
    )
  );

-- Reactions: the ONE write every plan keeps. Insert AND delete, so a member can
-- react and un-react. Requires read access to the target, which the space
-- membership conjunct provides.
drop policy if exists community_reactions_own_insert on public.community_reactions;
create policy community_reactions_own_insert on public.community_reactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and (
      (post_id is not null and exists (
         select 1 from public.community_posts p
          where p.id = post_id and p.status = 'active'
            and p.space_id in (select c.space_id from public.my_community_capabilities() c where c.can_react)))
      or
      (comment_id is not null and exists (
         select 1 from public.community_comments c2
           join public.community_posts p on p.id = c2.post_id
          where c2.id = comment_id and c2.status = 'active' and p.status = 'active'
            and p.space_id in (select c.space_id from public.my_community_capabilities() c where c.can_react)))
    )
  );

drop policy if exists community_reactions_own_delete on public.community_reactions;
create policy community_reactions_own_delete on public.community_reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Attachments follow the right to create the content they hang off.
drop policy if exists community_attachments_own_insert on public.community_attachments;
create policy community_attachments_own_insert on public.community_attachments
  for insert to authenticated
  with check (
    (select public.is_approved()) and (select public.is_enrolled())
    and exists (
      select 1 from public.community_posts p
       where p.id = post_id
         and p.author_id = (select auth.uid())
         and p.space_id in (select c.space_id from public.my_community_capabilities() c where c.can_attach)
    )
    -- #33's storage-path binding: the object must live under the caller's own
    -- folder, in either the legacy <uid>/… or the space-scoped <space>/<uid>/… shape.
    and (
      (storage.foldername(storage_path))[1] = (select auth.uid())::text
      or ((storage.foldername(storage_path))[2] = (select auth.uid())::text)
    )
  );

-- ───────────────────────────────────────────────────────────────────
-- 7) Storage — community-media INSERT must match the table policy.
--
--    #33 bound the path to the uploader. #36 additionally requires that the
--    uploader can create content SOMEWHERE, so a plan with no write rights can
--    no longer fill a private bucket with orphan objects. READ and DELETE keep
--    the legacy path branch so objects uploaded before the space-scoped naming
--    stay reachable and removable (#34's delete-parity gate).
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'community-media') then
    raise notice '#36: community-media bucket not found — skipping its storage policy.';
    return;
  end if;

  execute 'drop policy if exists community_media_own_insert on storage.objects';
  execute $pol$
    create policy community_media_own_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'community-media'
        and (select public.is_approved()) and (select public.is_enrolled())
        and (
          (storage.foldername(name))[1] = (select auth.uid())::text
          or (storage.foldername(name))[2] = (select auth.uid())::text
        )
        and exists (select 1 from public.my_community_capabilities() c where c.can_attach)
      )
  $pol$;
end $$;

-- Orphan sweep: objects whose attachment row never landed (a failed compose).
-- Admin-only, read-only, paged — a list to act on, not an automatic delete.
create or replace function public.admin_community_media_orphans(p_limit int default 100)
returns table (name text, created_at timestamptz, size bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select o.name, o.created_at, (o.metadata->>'size')::bigint
    from storage.objects o
   where public.is_admin()
     and o.bucket_id = 'community-media'
     and not exists (select 1 from public.community_attachments a where a.storage_path = o.name)
   order by o.created_at
   limit greatest(1, least(500, coalesce(p_limit, 100)));
$fn$;

revoke all on function public.admin_community_media_orphans(int) from public, anon;
grant execute on function public.admin_community_media_orphans(int) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 8) search_community_members() — the mention directory, gated.
--
--    Signature unchanged, so no client call site breaks. Behaviour tightens:
--      · p_space_id is REQUIRED (null → empty, never "default to General");
--      · the caller must be able to post OR comment in that space — you cannot
--        enumerate a roster you have no way to address;
--      · General is refused outright (D2: nobody can mention anyone there);
--      · a query shorter than 2 characters returns nothing, so the directory
--        cannot be walked one letter at a time.
--    Membership comes from L1, so a mention list can only ever contain people
--    who share the space.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.search_community_members(
  p_query    text,
  p_space_id uuid default null
)
returns table (id uuid, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $fn$
  with tgt as (
    select sp.id, sp.kind, sp.batch_id
      from public.community_spaces sp
     where sp.id = p_space_id
       and sp.kind <> 'general'
  ),
  allowed as (
    select 1
      from public.my_community_capabilities() c, tgt
     where c.space_id = tgt.id
       and (c.can_post or c.can_comment)
  ),
  roster as (
    select h as user_id from tgt, lateral public.batch_seat_holders(tgt.batch_id, tgt.kind) h
  )
  select p.id, trim(p.full_name) as display_name, p.avatar_url
    from public.profiles p
   where exists (select 1 from allowed)
     and char_length(btrim(coalesce(p_query, ''))) >= 2
     and (p.id in (select user_id from roster) or coalesce(p.is_admin, false))
     -- Nameless profiles are unmentionable: the markup needs a display name, and
     -- falling back to the email address would leak it.
     and coalesce(btrim(p.full_name), '') <> ''
     and p.full_name ilike '%' || btrim(p_query) || '%'
   order by p.full_name
   limit 20;
$fn$;

revoke all on function public.search_community_members(text, uuid) from public, anon;
grant execute on function public.search_community_members(text, uuid) to authenticated;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   -- D2 is data AND a constraint
--   select slug, member_posting, member_comments, member_reactions
--     from public.community_spaces where kind = 'general';        -- f | f | t
--   select conname from pg_constraint
--    where conname = 'community_spaces_general_announcement_only'; -- 1 row
--
--   -- the plan matrix
--   select key, can_post_in_general, can_comment_in_general, can_react_in_general,
--          can_post_in_private, can_comment_in_private, can_upload_attachments
--     from public.enrollment_plans order by key;
--   -- core/sampler/silver → f f t f f f ;  gold_live/vip → f f t t t t
--
--   -- policies read the resolver, not the raw flags
--   select policyname, with_check like '%my_community_capabilities%' as uses_resolver
--     from pg_policies
--    where tablename in ('community_posts','community_comments','community_reactions')
--      and cmd in ('INSERT','UPDATE');                            -- all true
--
--   -- the resolver is not directly callable with someone else's id
--   select has_function_privilege('authenticated',
--     'public.user_community_capabilities(uuid)', 'execute');     -- f
--
--   -- existing General posts are still READABLE (nothing was deleted)
--   select count(*) from public.community_posts
--    where status = 'active'
--      and space_id = (select id from public.community_spaces where kind='general');
-- ═══════════════════════════════════════════════════════════════════

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-07-31-community-plan-capabilities.sql', null,
  'per-plan community capabilities (#36): 7 enrollment_plans flags + user_community_capabilities(), '
  'D2 General announcement-only (posting + commenting OFF, reactions ON) pinned by a CHECK, '
  'withdraw/keep-published UPDATE split, search_community_members create-rights gate, '
  'community-media insert narrowed to members who can attach')
on conflict (filename) do nothing;


-- ═════════════════════════════════════════════════════════════════════════════
-- §24) FOLDED VERBATIM — 2026-08-01-entitlement-hardening.sql
--      code-review corrections to #35/#36
--
--      Appended at the tail for the same reason as §19-§21: the earlier
--      sections create the pre-#35 shapes, and these files' DROP+CREATE must
--      win on a fresh install. Every file is idempotent and self-guarded, so
--      appending reproduces the live end state exactly.
--      RE-FOLD whenever the dated file changes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- #37 — Corrections to #35/#36 found in code review
--
-- WHY
--   Five defects, one of them a silent regression of #33's hardening applied
--   two days earlier. #35 and #36 are already live, so this lands on top of
--   them rather than editing them (the #33 → #34 precedent: never rewrite an
--   applied file from memory; patch it with a new one that states the diff).
--
--   ① CRITICAL — #36's community_attachments_own_insert dropped THREE conjuncts
--      that #33 had deliberately added:
--        · `uploader_id = auth.uid()` — community_attachments.uploader_id is
--          NOT NULL and CLIENT-SUPPLIED. Unlike community_posts.author_id there
--          is no stamping trigger, so without this a member could file an
--          attachment row attributed to another profile. The own-DELETE policy
--          keys on uploader_id, so both provenance AND deletability were forged.
--        · the `storage_path is null` branch — the table CHECK is
--          `((kind = 'link') = (storage_path is null))`, so a LINK attachment
--          has a NULL path. `storage.foldername(NULL)[1] = uid` evaluates to
--          NULL, so the WITH CHECK could never pass: link attachments have been
--          IMPOSSIBLE TO CREATE since #36 shipped.
--        · the space binding `[1] = p.space_id` on two-level paths — without it
--          an attachment row can be pointed at another space's object.
--      The `can_attach` gate #36 added is correct and is KEPT; this restores the
--      three conjuncts on top of it.
--
--   ② #36's community_media_own_insert likewise lost #33's requirement that a
--      uuid-shaped first path segment be one of the caller's own spaces
--      (including #33's regex guard, which exists so a non-uuid segment yields a
--      clean policy denial instead of "invalid input syntax for type uuid" —
--      a 500 where a 403 belongs).
--
--   ③ A segment-changing upgrade left subscriptions.batch_id NULL.
--      admin_finalize_enrollment sets the cache, then (on gold↔vip) calls
--      revoke_batch_run(...,'superseded'), whose tail cleared the cache because
--      at that instant the member has zero outstanding entitlements — and
--      nothing re-set it afterwards. Access was unaffected (the ledger carries
--      it) but v_batch_entitlement_drift reported 'missing_cache' forever, so
--      the #39 gate could never read clean.
--      FIX: only a genuine REVOKE clears the cache. Superseding is one step of
--      an in-flight upgrade, not a withdrawal. This is safe because the #39
--      bridge is disabled by the presence of ANY ledger row for the user
--      (`not exists (… where e2.user_id = p_user)` — no status filter), so a
--      stale batch_id can never resurrect access once a member has any row.
--      Chosen over re-emitting admin_finalize_enrollment precisely to avoid
--      reconstructing a 150-line function that #34 already had to restore once.
--
--   ④ The FIFO binder had no forward-only floor. Creating a batch for a PAST
--      month — entirely plausible while importing historical students — bound
--      every queued seat in the system to it, out of run order, with
--      activates_at already in the past. A member would gain a cohort they
--      never bought.
--
--   ⑤ admin_grant_batch_run was not idempotent. If the member already held a
--      seat in every open batch, the candidate loop allocated none and the
--      shortfall path minted p_count fresh QUEUED seats — sold, capacity-exempt,
--      and auto-bound to future cohorts. ALREADY_ENTITLED was in the catalogue
--      but never raised anywhere.
--
-- ORDER
--   Run AFTER db/2026-07-31-community-plan-capabilities.sql (#36).
--   Additive, idempotent, non-destructive. No table or column is dropped; no
--   row is deleted.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.batch_entitlements') is null then
    raise exception '#37 requires #35 — run db/2026-07-30-batch-entitlements.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='enrollment_plans'
                    and column_name='can_upload_attachments') then
    raise exception '#37 requires #36 — run db/2026-07-31-community-plan-capabilities.sql first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#37 requires #31 — the tail insert would abort the migration.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) ① Restore #33's attachment binding, keeping #36's can_attach gate.
--
--    Reading order matters here: ownership → gate → post ownership + capability
--    → path binding. The path clause keeps all three shapes #33 allowed:
--      · NULL          — a link attachment (enforced by the table CHECK)
--      · <uid>/…       — legacy, pre-#32
--      · <space>/<uid>/… — #32's space-scoped naming, bound to the POST's space
-- ───────────────────────────────────────────────────────────────────
drop policy if exists community_attachments_own_insert on public.community_attachments;
create policy community_attachments_own_insert on public.community_attachments
  for insert to authenticated
  with check (
    uploader_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and exists (
      select 1 from public.community_posts p
       where p.id = community_attachments.post_id
         and p.author_id = (select auth.uid())
         and p.space_id in (select c.space_id
                              from public.my_community_capabilities() c
                             where c.can_attach)
         and (community_attachments.storage_path is null
              or (storage.foldername(community_attachments.storage_path))[1] = (select auth.uid())::text
              or ((storage.foldername(community_attachments.storage_path))[1] = p.space_id::text
                  and (storage.foldername(community_attachments.storage_path))[2] = (select auth.uid())::text))
    )
  );

-- ───────────────────────────────────────────────────────────────────
-- 2) ② Restore #33's storage-side space check, keeping #36's can_attach gate.
--    The regex guard is #33's and is load-bearing: casting a non-uuid segment
--    would raise 22P02 (a 500) instead of failing the policy cleanly (a 403).
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'community-media') then
    raise notice '#37: community-media bucket not found — skipping its storage policy.';
    return;
  end if;

  execute 'drop policy if exists community_media_own_insert on storage.objects';
  execute $pol$
    create policy community_media_own_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'community-media'
        and (select public.is_approved()) and (select public.is_enrolled())
        and exists (select 1 from public.my_community_capabilities() c where c.can_attach)
        and (
          (storage.foldername(name))[1] = (select auth.uid())::text
          or
          ((storage.foldername(name))[2] = (select auth.uid())::text
           and (case when (storage.foldername(name))[1] ~
                          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                     then ((storage.foldername(name))[1])::uuid
                     else null end) in (select public.my_community_space_ids()))
        )
      )
  $pol$;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 3) ③ Only a REVOKE clears the legacy cache.
--    Byte-identical to #35's body except the final UPDATE's guard.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.revoke_batch_run(
  p_user_id uuid,
  p_run_id  uuid default null,
  p_reason  text default null,
  p_actor   uuid default null,
  p_status  text default 'revoked'
)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if p_status not in ('revoked', 'superseded') then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      'revoke_batch_run can only set revoked or superseded', 409, null);
  end if;

  with touched as (
    update public.batch_entitlements e
       set status        = p_status,
           revoked_at    = case when p_status = 'revoked' then now() else e.revoked_at end,
           revoked_by    = case when p_status = 'revoked' then p_actor else e.revoked_by end,
           revoke_reason = coalesce(p_reason, e.revoke_reason),
           updated_at    = now()
     where e.user_id = p_user_id
       and e.status in ('queued', 'active')
       and (p_run_id is null or e.run_id = p_run_id)
    returning e.batch_id, e.run_id, e.segment
  )
  insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
  select t.batch_id, p_user_id, p_actor,
         case when p_status = 'revoked' then 'entitle_revoke' else 'entitle_supersede' end,
         jsonb_build_object('run_id', t.run_id, 'segment', t.segment, 'reason', p_reason)
    from touched t;

  get diagnostics v_n = row_count;

  -- ★ #37: `p_status = 'revoked'` added. Superseding is one step of an in-flight
  -- upgrade — the caller grants a replacement run immediately afterwards — so
  -- clearing the cache here left every segment-changing upgrade with
  -- subscriptions.batch_id NULL and the drift view stuck on 'missing_cache'.
  -- Safe because the #39 bridge is disabled by the presence of ANY ledger row
  -- for the user, so a stale batch_id cannot resurrect access.
  if p_status = 'revoked' then
    update public.subscriptions s
       set batch_id = null, updated_at = now()
     where s.user_id = p_user_id
       and s.batch_id is not null
       and not exists (select 1 from public.batch_entitlements e
                        where e.user_id = p_user_id and e.status in ('queued', 'active'));
  end if;

  return v_n;
end;
$fn$;

revoke all on function public.revoke_batch_run(uuid, uuid, text, uuid, text) from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 4) ④ The FIFO binder becomes forward-only WITHIN a run.
--    A queued seat may only claim a cohort later than every cohort its run has
--    already been allocated, so a backdated batch cannot absorb owed seats or
--    reorder a member's run.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.allocate_queued_entitlements(p_batch_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_b   record;
  v_e   record;
  v_n   int := 0;
  v_act timestamptz;
begin
  for v_b in
    select b.id, b.code, b.starts_on
      from public.batches b
     where (p_batch_id is null or b.id = p_batch_id)
       and b.status = 'open'
     order by b.code
  loop
    v_act := coalesce(v_b.starts_on::timestamptz, to_date(v_b.code || '-01', 'YYYY-MM-DD')::timestamptz);

    for v_e in
      select e.id, e.user_id, e.segment, e.run_id
        from public.batch_entitlements e
       where e.status = 'queued'
         and (e.valid_until is null or e.valid_until > now())
         and exists (select 1 from public.community_spaces sp
                      where sp.batch_id = v_b.id and sp.kind = e.segment and sp.active)
         and not exists (select 1 from public.batch_entitlements e2
                          where e2.user_id = e.user_id and e2.batch_id = v_b.id
                            and e2.status in ('queued', 'active'))
         -- ★ #37: forward-only within the run. Without this, creating a batch
         -- for a PAST month bound every queued seat to it, out of order and
         -- already active.
         and v_b.code > coalesce((
               select max(b2.code)
                 from public.batch_entitlements e3
                 join public.batches b2 on b2.id = e3.batch_id
                where e3.run_id = e.run_id
                  and e3.batch_id is not null
                  and e3.status in ('queued', 'active')), '')
       order by e.granted_at, e.batch_index
       for update skip locked
    loop
      -- The cursor's guard was evaluated against the open-time snapshot, so it
      -- cannot see seats allocated by EARLIER iterations of this loop. Re-check
      -- where our own uncommitted writes are visible: one member, one seat, per
      -- cohort.
      if exists (select 1 from public.batch_entitlements e2
                  where e2.user_id = v_e.user_id
                    and e2.batch_id = v_b.id
                    and e2.status in ('queued', 'active')) then
        continue;
      end if;

      update public.batch_entitlements
         set batch_id = v_b.id, status = 'active',
             activates_at = v_act, allocated_at = now(), updated_at = now()
       where id = v_e.id;

      insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
      values (v_b.id, v_e.user_id, null, 'entitle_allocate',
              jsonb_build_object('run_id', v_e.run_id, 'segment', v_e.segment, 'source', 'fifo_binder'));
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$fn$;

revoke all on function public.allocate_queued_entitlements(uuid) from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 5) ⑤ admin_grant_batch_run refuses a duplicate run unless forced.
--    p_force already existed to bypass capacity; it now also bypasses this,
--    which is the right pairing — both are "I know, do it anyway".
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_grant_batch_run(
  p_user_id  uuid,
  p_batch_id uuid,
  p_count    int     default null,
  p_force    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sub         public.subscriptions%rowtype;
  v_segment     text;
  v_count       int;
  v_outstanding int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_grant_batch_run: admin only', 403, null);
  end if;

  select * into v_sub from public.subscriptions s
   where s.user_id = p_user_id and s.status = 'active'
     and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
   order by s.created_at desc limit 1;
  if v_sub.id is null then
    perform public.app_error('ENTITLEMENT_EXPIRED',
      'member has no active membership term to attach a cohort seat to', 403,
      jsonb_build_object('user_id', p_user_id));
  end if;

  select coalesce(ep.community_segment, 'general') into v_segment
    from public.enrollment_plans ep where ep.key = v_sub.plan_key;
  if v_segment not in ('gold', 'vip') then
    perform public.app_error('INVALID_PLAN',
      format('plan %s is not a cohort plan', v_sub.plan_key), 422,
      jsonb_build_object('plan_key', v_sub.plan_key, 'segment', v_segment));
  end if;

  v_count := coalesce(p_count, public.plan_eligible_batch_count(v_sub.plan_key), 1);

  -- ★ #37: idempotency. The one-seat-per-cohort unique index only protects
  -- BOUND seats, so a repeat call on a member who already holds every open
  -- cohort fell through to the shortfall path and minted a second full run of
  -- queued seats — sold, capacity-exempt, and auto-bound later by the binder.
  if not p_force then
    select count(*) into v_outstanding
      from public.batch_entitlements e
     where e.user_id = p_user_id and e.status in ('queued', 'active');
    if v_outstanding >= v_count then
      perform public.app_error('ALREADY_ENTITLED',
        format('member already holds %s outstanding cohort seat(s); pass p_force to stack another run',
               v_outstanding), 409,
        jsonb_build_object('outstanding', v_outstanding, 'requested', v_count));
    end if;
  end if;

  return public.grant_batch_run(
    p_user_id, v_segment, p_batch_id, v_count, 'admin_manual',
    v_sub.id, v_sub.plan_key, null, null,
    coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), not p_force);
end;
$fn$;

revoke all on function public.admin_grant_batch_run(uuid, uuid, int, boolean) from public, anon;
grant execute on function public.admin_grant_batch_run(uuid, uuid, int, boolean) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 6) my_community_spaces() — General's member_count was O(N) SECDEF calls.
--    user_is_enrolled(p.id) ran once per profile; at the 500+ user target that
--    is 500 SECURITY DEFINER invocations on every community load. Same answer,
--    computed set-based from the live-subscription join (#32's valid_subs idiom).
-- ───────────────────────────────────────────────────────────────────
drop function if exists public.my_community_spaces();

create function public.my_community_spaces()
returns table (
  id uuid, slug text, kind text, name text, batch_code text,
  member_posting boolean, member_comments boolean, member_reactions boolean,
  can_post boolean, can_comment boolean, can_react boolean, can_attach boolean,
  member_count bigint, is_default boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  with caps as (select * from public.user_community_capabilities(auth.uid())),
  general_members as (
    select count(*)::bigint as n
      from public.profiles p
     where (p.approval_status = 'approved' or p.is_admin)
       and (
         exists (select 1 from public.subscriptions s
                  where s.user_id = p.id and s.status = 'active'
                    and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now()))
         or (p.is_paid and not exists (select 1 from public.subscriptions s2 where s2.user_id = p.id))
       )
  ),
  my_default as (
    select coalesce(
      (select sp.id
         from public.community_spaces sp
         join public.user_entitled_batches(auth.uid()) eb
           on eb.batch_id = sp.batch_id and eb.segment = sp.kind
        where sp.active
        order by sp.created_at desc
        limit 1),
      (select sp.id from public.community_spaces sp where sp.kind = 'general' limit 1)
    ) as space_id
  )
  select sp.id, sp.slug, sp.kind, sp.name, b.code as batch_code,
         sp.member_posting, sp.member_comments, sp.member_reactions,
         c.can_post, c.can_comment, c.can_react, c.can_attach,
         case
           when sp.kind = 'general' then (select n from general_members)
           else (select count(*) from public.batch_seat_holders(sp.batch_id, sp.kind))
         end::bigint as member_count,
         (sp.id = (select space_id from my_default)) as is_default
    from caps c
    join public.community_spaces sp on sp.id = c.space_id
    left join public.batches b on b.id = sp.batch_id
   order by (sp.kind = 'general') desc, b.code desc nulls last, sp.name;
$fn$;

revoke all on function public.my_community_spaces() from public, anon;
grant execute on function public.my_community_spaces() to authenticated;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   -- ① attachment binding restored (all four conjuncts back)
--   -- NOTE: pg_policies.with_check is the PARSED expression, not your source
--   -- text — Postgres uppercases `IS NULL` and parenthesises `(p.space_id)::text`.
--   -- Match case-insensitively or you will get a false negative.
--   select with_check ilike '%uploader_id =%'            as owns_row,
--          with_check ilike '%storage_path IS NULL%'     as link_allowed,
--          with_check ilike '%(p.space_id)::text%'       as space_bound,
--          with_check ilike '%can_attach%'               as plan_gated
--     from pg_policies where policyname = 'community_attachments_own_insert';
--   -- expect: t | t | t | t
--
--   -- ② storage space check restored
--   select with_check like '%my_community_space_ids%' as space_checked,
--          with_check like '%can_attach%'             as plan_gated
--     from pg_policies where policyname = 'community_media_own_insert';   -- t | t
--
--   -- ③ only a revoke clears the cache
--   select prosrc like '%if p_status = ''revoked'' then%' as guarded
--     from pg_proc where proname = 'revoke_batch_run';                    -- t
--
--   -- ④ binder is forward-only within a run
--   select prosrc like '%select max(b2.code)%' as has_floor
--     from pg_proc where proname = 'allocate_queued_entitlements';        -- t
--
--   -- ⑤ duplicate runs refused
--   select prosrc like '%ALREADY_ENTITLED%' as idempotent
--     from pg_proc where proname = 'admin_grant_batch_run';               -- t
--
--   -- drift should read only 'ok'
--   select drift, count(*) from public.v_batch_entitlement_drift group by 1;
-- ═══════════════════════════════════════════════════════════════════

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-01-entitlement-hardening.sql', null,
  'code-review corrections to #35/#36 (#37): restores #33''s attachment uploader/link/space binding that '
  '#36 dropped (link attachments were impossible to create, uploader_id was forgeable); restores the '
  'community-media storage space check; only a REVOKE clears subscriptions.batch_id, so a segment-changing '
  'upgrade no longer strands the cache; the FIFO binder is forward-only within a run so a backdated batch '
  'cannot absorb queued seats; admin_grant_batch_run raises ALREADY_ENTITLED instead of minting a duplicate '
  'run; my_community_spaces General member_count is set-based instead of O(N) SECDEF calls')
on conflict (filename) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING (fresh install)
--   1. If §5 / §14b raised a NOTICE (restricted role), create the buckets in
--      Dashboard → Storage: course-media (Public ON), course-videos (Public OFF,
--      50 MB, video mimes), enrollment-receipts (Public OFF, 5 MB, png/jpeg/webp/pdf),
--      avatars (Public ON, 5 MB, image mimes), community-media (Public OFF, 50 MB,
--      image + video mimes).
--   2. Sign in once with your owner account so a profiles row exists, then promote
--      it to admin (admins bypass the approval + enrollment gates):
--        update public.profiles set is_admin = true where email = 'you@example.com';
--      Sign out/in to re-read the profile.
--   3. Auth config (Confirm email, Site/Redirect URLs, Google provider) is set in
--      the Supabase Dashboard — see AUTH_SETUP.md.
--   4. Feature flags VITE_REQUIRE_ADMIN_APPROVAL / VITE_REQUIRE_ENROLLMENT default
--      ON, so this schema is already the fully-gated final state.
-- ═════════════════════════════════════════════════════════════════════════════
