-- ─────────────────────────────────────────────────────────────────────────────
-- AI Course Trainer — entitlement-aware voice-trainer knowledge base (#27)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: the ElevenLabs voice assistant is becoming an AI course trainer that can
-- teach/quiz/recap the Supabase-hosted courses. Course content is PAID content,
-- so it must NEVER ride in a global ElevenLabs knowledge document — the server
-- re-authorizes every retrieval against the learner's LIVE membership + plan
-- scope. This migration adds the derived-knowledge tables (sources → chunks),
-- the index-job queue, per-user AI checkpoints + durable usage counters, and the
-- SERVICE-ROLE-ONLY entitlement/retrieval functions the trainer endpoint calls.
--
-- WHAT THIS ADDS
--   • extension `vector` (pgvector, extensions schema) — 384-dim gte-small embeddings.
--   • courses.ai_trainer_enabled — per-course admin opt-in for AI training.
--   • course_ai_sources   — reviewed teaching text per lesson (lesson_text /
--     transcript / trainer_notes), with status/versions/hashes. Admin-only RLS.
--   • course_ai_chunks    — bounded retrieval chunks (+ nullable vector(384)
--     embedding + generated tsvector for the keyword fallback). NO learner RLS
--     path at all — retrieval happens server-side AFTER authorization.
--   • course_ai_index_jobs — bounded async (re)index/transcribe queue + retries.
--   • ai_training_checkpoints — per-user "resume where you left off" rows
--     (own-read; written only by the service path). SEPARATE from lesson_progress
--     by design — an AI conversation never marks real lessons complete.
--   • ai_training_usage   — durable per-user/day/tool counters (daily caps).
--   • user_is_enrolled(p_user) / user_plan_key(p_user) / user_is_approved(p_user) /
--     trainer_visible_courses(p_user) / trainer_courses_for_plan(p_plan_key) /
--     trainer_match_chunks(...) / trainer_match_chunks_fts(...) /
--     trainer_lesson_chunks(...) / trainer_preview_chunks(...) /
--     trainer_bump_usage(...) — ALL revoked from anon/authenticated and granted
--     ONLY to service_role. They mirror the §14 courses_read policy EXACTLY;
--     drift between them and courses_read is a security bug.
--   • course_ai_mark_lesson_stale() trigger — pure SQL (no network in a write
--     transaction): editing a lesson marks its sources stale + enqueues a job.
--
-- SERVER MODEL: the webhook endpoint api/elevenlabs/trainer.js verifies a
-- short-lived HMAC trainer token, then calls these functions under the SERVICE
-- ROLE key. Retrieval-time filters (published + ai_trainer_enabled + source
-- status='ready' + included + source_version match + plan scope) are the
-- immediate-unretrievability guarantee: unpublishing/disabling/editing excludes
-- content on the very next call, before any cleanup job runs.
--
-- ORDER: run subscription-lifecycle (#13), plan-course-access (#17) and
-- sampler-essentials-access (#19) BEFORE this file. The guard below aborts
-- cleanly (nothing partial applied) if they're missing.
--
-- HOW TO RUN: paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT (create-if-not-exists, add-column-if-not-exists, create-or-replace,
-- drop/create trigger+policy) — safe to run more than once.
-- See COURSE_AI_TRAINER_SETUP.md for the full walkthrough (env vars, the
-- trainer-embed Edge Function, provisioning the ElevenLabs webhook tools).
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Hard ordering guards.
do $$
begin
  if to_regclass('public.courses') is null then
    raise exception 'Run db/2026-06-16-course-platform-base.sql before this file (public.courses does not exist yet).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'ends_at'
  ) then
    raise exception 'Run db/2026-07-04-subscription-lifecycle.sql before this file (subscriptions.ends_at missing).';
  end if;
  if to_regproc('public.current_plan_key') is null then
    raise exception 'Run db/2026-07-09-plan-course-access.sql before this file (current_plan_key() missing).';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'courses' and column_name = 'access_tier'
  ) then
    raise exception 'Run db/2026-07-11-sampler-essentials-access.sql before this file (courses.access_tier missing).';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) pgvector (Supabase idiom: the extensions schema). 384 dims = gte-small.
-- ───────────────────────────────────────────────────────────────────
create extension if not exists vector with schema extensions;

-- ───────────────────────────────────────────────────────────────────
-- 2) Per-course opt-in. Default OFF — an admin explicitly enables AI training
--    per course in the builder's AI Trainer panel.
-- ───────────────────────────────────────────────────────────────────
alter table public.courses add column if not exists ai_trainer_enabled boolean not null default false;

-- ───────────────────────────────────────────────────────────────────
-- 3) course_ai_sources — the ADMIN-REVIEWED teaching text the trainer may use.
--    One row per (lesson, kind); lesson_id NULL = course-level trainer notes.
--    `content` holds the approved snapshot (lesson text is snapshotted at sync
--    time; transcripts land here from Scribe or manual paste). `status` drives
--    retrievability: only 'ready' + included sources are ever served.
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 4) course_ai_chunks — bounded retrieval units derived from a source.
--    embedding NULL = servable by the keyword (FTS) fallback only.
--    module_title/lesson_title are denormalized citation labels (refreshed on
--    each re-index; course title is always joined live from courses).
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 5) course_ai_index_jobs — the bounded async work queue (index/transcribe),
--    processed in small batches by the admin endpoint. attempts/max_attempts
--    bound retries; error_detail carries safe codes only.
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 6) ai_training_checkpoints — "resume where we left off" per user+course.
--    DELIBERATELY separate from lesson_progress: a voice conversation never
--    marks canonical lessons complete. Written ONLY by the service path.
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 7) ai_training_usage — DURABLE per-user daily counters (the in-memory burst
--    limiter in the endpoint is per warm instance; this is the real cap).
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.ai_training_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  tool    text not null,
  calls   integer not null default 0,
  primary key (user_id, day, tool)
);

-- ───────────────────────────────────────────────────────────────────
-- 8) RLS — learners have NO path to sources/chunks/jobs (retrieval is
--    service-role-only, AFTER server-side authorization). Admin-only otherwise;
--    checkpoints are own-read; usage is admin-read (diagnostics).
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 9) Parameterized entitlement helpers — the auth.uid() helpers (§13/§13b) can't
--    serve the webhook (the service role has auth.uid() = NULL), so these take
--    p_user explicitly. They MIRROR is_enrolled()/is_approved()/current_plan_key()
--    EXACTLY (incl. grace + legacy-is_paid + null-plan = full-access semantics).
--    SERVICE-ROLE-ONLY — revoked from anon/authenticated below.
-- ───────────────────────────────────────────────────────────────────
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
-- courses_read policy (admin OR (published AND approved AND enrolled AND plan
-- scope)) PLUS ai_trainer_enabled. Keep in lockstep with courses_read — drift
-- here is a security bug, not a style issue.
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

-- Admin preview: the same plan-scope truth table with an EXPLICIT plan key and
-- no per-user checks (the calling endpoint is already admin-verified).
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

-- ───────────────────────────────────────────────────────────────────
-- 10) Retrieval functions. The join conditions ARE the immediate-
--     unretrievability guarantee: courses.published + ai_trainer_enabled,
--     sources.status='ready' + included, chunks.source_version = the source's
--     CURRENT version, plus membership in trainer_visible_courses(p_user)
--     (defense in depth on top of the endpoint's own authorized-course filter).
-- ───────────────────────────────────────────────────────────────────
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

-- Ordered coverage of ONE lesson (guided/quiz/recap modes). Same guards.
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

-- Admin preview retrieval — plan-scoped instead of user-scoped. Falls back to
-- keyword search when no query embedding is supplied.
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

-- Atomic durable usage counter — returns the NEW count for today; the caller
-- compares it to the per-tool daily cap.
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

-- ───────────────────────────────────────────────────────────────────
-- 11) Lockdown — function EXECUTE defaults to PUBLIC, so these revokes are
--     load-bearing: no browser session may ever call the parameterized
--     entitlement/retrieval functions directly.
-- ───────────────────────────────────────────────────────────────────
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

-- ───────────────────────────────────────────────────────────────────
-- 12) Stale-marking trigger — PURE SQL, no network inside the write transaction.
--     Editing a lesson's text/title marks its lesson_text source stale; swapping
--     the video invalidates the transcript too. A queued index job is enqueued
--     (if none is already queued) for the admin endpoint to process async.
--     Deletes need no trigger (FK cascade); unpublish needs none (retrieval
--     joins courses.published live).
-- ───────────────────────────────────────────────────────────────────
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
-- 13) Refresh PostgREST's schema cache.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';
