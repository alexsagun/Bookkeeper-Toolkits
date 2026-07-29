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
