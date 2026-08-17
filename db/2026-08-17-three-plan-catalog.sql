-- ════════════════════════════════════════════════════════════════════════════
-- #39 — THREE-PLAN CATALOG. Removes `core_self_paced` and `gold_live`, and the
--       entire `gold` community segment with them. VIP becomes the ONLY premium
--       / private-batch / private-community segment.
--       2026-08-17
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT CHANGES
--   ① The catalog is exactly three plans: sampler ₱1,499 (1), silver_self_paced
--     ₱2,999 (2), vip ₱16,999 (3). The two removed rows are DELETED, not
--     deactivated — `active = false` would leave them renewable via an extension
--     (admin_finalize_enrollment deliberately lets an extension continue a
--     retired plan) and still readable by every plan-scope helper.
--   ② The `gold` segment is removed at the schema level: batches.gold_capacity is
--     dropped, three CHECKs are narrowed, batches_create_spaces() stops minting a
--     Gold space, and every `in ('gold','vip')` guard becomes `= 'vip'`.
--   ③ plan_is_qbo_only() existed ONLY for core_self_paced. The four course-read
--     policies and course_object_allowed() lose its conjunct, then it is dropped.
--     Sampler's Essentials-only rule is untouched — it is the one surviving
--     plan-scope restriction.
--
-- WHY THE DELETE IS SAFE HERE
--   ★ Step 1 REFUSES to run if any member still holds a LIVE term (active, not past
--   its grace) on a retired plan. That assertion — NOT the foreign key — is what
--   protects a person: Step 2b deletes those subscription rows, so it runs before
--   `subscriptions_plan_key_fkey`'s ON DELETE RESTRICT could ever fire. Expired
--   history deletes freely. The FK still earns its keep AFTERWARDS: once the plan
--   rows are gone a subscription physically cannot name a deleted plan, which is why
--   the client-side fail-closed branch is defence in depth rather than the only
--   thing standing there.
--
-- APPLY AS ONE TRANSACTION. Every statement here is transactional in Postgres,
-- so a single paste into the SQL editor (or one execute_sql body) is all-or-
-- nothing. Do NOT add begin;/commit; — that would break splitSqlStatements() in
-- scripts/apply-db-files.mjs, which is how the shadow rehearsal runs this file
-- statement-at-a-time to catch ordering bugs the single transaction would hide.
--
-- ★ ORDERING HAZARD (the one that bites): batches_guard() (Step 5k) dereferences
--   new.gold_capacity. If Step 7a drops the column while the old guard is still
--   installed, EVERY update on batches raises `record "new" has no field
--   "gold_capacity"` — including the hourly pg_cron close_due_batches() sweep,
--   silently, forever. Step 5k MUST run before Step 7a.
--
-- Idempotent: re-running is a no-op. Every cleanup predicate is scoped to
-- `plan_key in ('core_self_paced','gold_live')` or `kind = 'gold'`, so it is
-- structurally incapable of touching VIP, General, or retained-plan data.
-- ════════════════════════════════════════════════════════════════════════════


-- ── Step 0 — Preflight: refuse to run against the wrong schema ──────────────
do $$
begin
  if to_regclass('public.batch_entitlements') is null then
    raise exception '#39 requires #35 - run db/2026-07-30-batch-entitlements.sql first.';
  end if;
  if to_regprocedure('public.batch_is_past(date, text)') is null then
    raise exception '#39 requires #38 - run db/2026-08-16-batch-lifecycle.sql first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#39 requires #31 - its own apply-log insert would abort the file.';
  end if;
end $$;


-- ── Step 1 — Refuse to destroy real member content ─────────────────────────
-- The difference between "dev cleanup" and "data loss". These assertions read
-- only; they stop the file BEFORE Step 2 deletes anything.
do $$
declare
  v_posts int; v_comments int; v_gold_seats int; v_done_imports int; v_live_terms int;
begin
  select count(*) into v_posts
    from public.community_posts p
    join public.community_spaces s on s.id = p.space_id
   where s.kind = 'gold';
  select count(*) into v_comments
    from public.community_comments c
    join public.community_spaces s on s.id = c.space_id
   where s.kind = 'gold';
  if v_posts > 0 or v_comments > 0 then
    raise exception '#39 refuses: % post(s) and % comment(s) live in gold spaces. '
                    'Migrate or archive them first - this file will not delete member content.',
                    v_posts, v_comments;
  end if;

  -- Every status, including revoked/superseded history: the narrowed CHECK in
  -- Step 7c validates the whole table, not just live rows.
  select count(*) into v_gold_seats from public.batch_entitlements where segment = 'gold';
  if v_gold_seats > 0 then
    raise exception '#39 refuses: % gold cohort seat(s) exist. Revoke or supersede them first.',
                    v_gold_seats;
  end if;

  select count(*) into v_done_imports
    from public.student_import_rows
   where proposed_plan_key in ('core_self_paced', 'gold_live')
     and (processing_status = 'done' or subscription_granted);
  if v_done_imports > 0 then
    raise exception '#39 refuses: % completed import row(s) granted a removed plan.', v_done_imports;
  end if;

  -- ★ THE ONE THAT ACTUALLY PROTECTS A MEMBER. Step 2b deletes retired-plan
  -- subscriptions, which runs BEFORE the ON DELETE RESTRICT FK could ever fire — so
  -- that FK is NOT what stops this file stranding somebody, this assertion is. A term
  -- that is still running (or inside its grace) is a person with paid access; deleting
  -- it silently would remove their access, their receipt row and their is_paid flag
  -- with no error and no audit row. Expired/superseded history deletes freely.
  --
  -- To purge a development database that legitimately has such rows (the case this
  -- file was written for), delete or expire those terms first — deliberately a
  -- separate, visible act, not a side effect of a schema migration.
  select count(*) into v_live_terms
    from public.subscriptions s
   where s.plan_key in ('core_self_paced', 'gold_live')
     and s.status = 'active'
     and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());
  if v_live_terms > 0 then
    raise exception '#39 refuses: % member(s) still hold a LIVE term on a retired plan. '
                    'Migrate or end those memberships first - this file will not silently '
                    'revoke paid access.', v_live_terms;
  end if;
end $$;


-- ── Step 2 — Guarded destructive DEV-DATA cleanup ──────────────────────────
-- FK ordering, all verified against pg_constraint:
--   • subscriptions.plan_key      → ON DELETE RESTRICT  ⇒ terms die before the plan
--   • enrollment_requests.plan_key→ NO ACTION           ⇒ requests die before the plan
--   • subscriptions.request_id    → ON DELETE SET NULL  ⇒ either order is legal
--   • batch_entitlements.source_* → ON DELETE SET NULL, and batch_entitlements_guard()
--                                   explicitly permits non-null → NULL
--   • community_notifications.space_id → ON DELETE CASCADE; posts/comments are
--     RESTRICT but Step 1 proved there are none.
-- Auth users are NOT touched here — that needs the Admin API and a per-user
-- decision, so it lives in scripts/dev-purge-removed-plans.mjs. Keeping UUIDs out
-- of this file is also what lets it fold into the bootstrap verbatim.
do $$
declare
  v_spaces int; v_subs int; v_reqs int; v_rows int; v_profiles int;
begin
  -- 2a) Gold spaces. NOT blocked by batches_guard (that trigger is BEFORE INSERT
  --     OR UPDATE on `batches`), and not blocked by three of the four batches
  --     being archived/past — deleting a SPACE never touches its batch row.
  delete from public.community_spaces where kind = 'gold';
  get diagnostics v_spaces = row_count;

  -- 2b) Terms first (subscriptions_plan_key_fkey is ON DELETE RESTRICT).
  delete from public.subscriptions where plan_key in ('core_self_paced', 'gold_live');
  get diagnostics v_subs = row_count;

  -- 2c) Then the payment-proof rows (enrollment_requests_plan_key_fkey is NO ACTION).
  delete from public.enrollment_requests where plan_key in ('core_self_paced', 'gold_live');
  get diagnostics v_reqs = row_count;

  -- 2d) Profile cache only. approval_status and is_admin are never touched.
  update public.profiles
     set plan = 'free', is_paid = false, updated_at = now()
   where plan in ('core_self_paced', 'gold_live');
  get diagnostics v_profiles = row_count;

  -- 2e) Staged imports proposing a removed plan: NEUTRALIZE, do not delete — the
  --     row is the audit record of what the operator staged. proposed_plan_key
  --     has no FK, so without this the row stays actionable and the import
  --     endpoint would later try to grant a plan that no longer exists.
  update public.student_import_rows
     set proposed_plan_key = null,
         processing_status = 'skipped',
         warnings = coalesce(warnings, '[]'::jsonb) || jsonb_build_array(
           jsonb_build_object('code', 'plan_removed',
             'detail', 'proposed plan retired by #39 (three-plan catalog); restage on sampler/silver/vip')),
         updated_at = now()
   where proposed_plan_key in ('core_self_paced', 'gold_live');
  get diagnostics v_rows = row_count;

  raise notice '#39 cleanup: % gold space(s), % subscription(s), % request(s), % profile(s), % import row(s).',
               v_spaces, v_subs, v_reqs, v_profiles, v_rows;
end $$;


-- ── Step 3 — The catalog ───────────────────────────────────────────────────
-- The guarded-UPDATE shape (`and ... is distinct from ...`) is the #22 idiom: it
-- makes every statement here match NOTHING on a fresh install, where the
-- bootstrap seed already carries the final three plans at their final prices.
do $$
begin
  delete from public.enrollment_plans where key in ('core_self_paced', 'gold_live');

  update public.enrollment_plans
     set price_php = 2999, position = 2, updated_at = now()
   where key = 'silver_self_paced'
     and (price_php is distinct from 2999 or position is distinct from 2);

  update public.enrollment_plans
     set price_php = 16999, position = 3, updated_at = now()
   where key = 'vip'
     and (price_php is distinct from 16999 or position is distinct from 3);

  update public.enrollment_plans
     set position = 1, updated_at = now()
   where key = 'sampler' and position is distinct from 1;

  if (select count(*) from public.enrollment_plans) <> 3 then
    raise exception '#39: expected exactly 3 plans after the delete, found %',
                    (select count(*) from public.enrollment_plans);
  end if;
  -- user_entitled_batches() derives the segment from THIS column and requires the
  -- ledger's stamped segment to equal it. A wrong value here silently strands
  -- every VIP member's private space.
  if (select community_segment from public.enrollment_plans where key = 'vip') <> 'vip' then
    raise exception '#39: vip.community_segment is not ''vip'' - refusing to continue.';
  end if;
end $$;


-- ── Step 4 — Course scope: drop the core-only conjunct ─────────────────────
-- ALTER POLICY, not DROP + CREATE: it is atomic, so there is no window in which a
-- read policy is absent (which DROP+CREATE genuinely has under statement-at-a-time
-- application). Order matters — course_object_allowed() calls plan_is_qbo_only(),
-- so it is replaced first and the function is dropped last.

-- 4a) course_object_allowed(): sampler is now the only scoped plan.
create or replace function public.course_object_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cid  uuid;
  v_slug text;
  v_tier text;
begin
  if public.is_admin() then return true; end if;
  if not public.plan_is_sampler() then
    return true;                                              -- full-access plans: no restriction
  end if;
  begin
    v_cid := split_part(p_name, '/', 2)::uuid;                -- lessons/<course_id>/...
  exception when others then
    return true;                                              -- unparseable path → don't block
  end;
  select slug, access_tier into v_slug, v_tier from public.courses where id = v_cid;
  if v_slug is null then return true; end if;                 -- unknown course → don't block
  return v_slug like 'qbo-%' and v_tier = 'essentials';
end;
$$;

-- 4b) The four content-read policies.
alter policy courses_read on public.courses
  using (
    (select public.is_admin())
    or (published = true
        and (select public.is_approved())
        and (select public.is_enrolled())
        and ((not (select public.plan_is_sampler()))
             or (slug like 'qbo-%' and access_tier = 'essentials')))
  );

alter policy modules_read on public.course_modules
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (
          select 1 from public.courses c
           where c.id = course_modules.course_id
             and c.published = true
             and ((not (select public.plan_is_sampler()))
                  or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))))
  );

alter policy lessons_read on public.course_lessons
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (
          select 1 from public.courses c
           where c.id = course_lessons.course_id
             and c.published = true
             and ((not (select public.plan_is_sampler()))
                  or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))))
  );

alter policy course_videos_read on storage.objects
  using (
    bucket_id = 'course-videos'
    and ((select public.is_admin())
         or ((select public.is_enrolled())
             and ((not (select public.plan_is_sampler())) or public.course_object_allowed(name))))
  );

-- 4c) The trainer mirrors. These carry a "MIRRORS courses_read — drift here is a
--     security bug" contract, so they change in the same breath as 4b.
create or replace function public.trainer_visible_courses(p_user uuid)
returns table(id uuid, slug text, title text, access_tier text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.slug, c.title, c.access_tier
  from public.courses c
  where c.ai_trainer_enabled = true
    and (
      coalesce((select p.is_admin from public.profiles p where p.id = p_user), false)
      or (c.published = true
          and public.user_is_approved(p_user)
          and public.user_is_enrolled(p_user)
          and (not coalesce(public.user_plan_key(p_user) = 'sampler', false)
               or (c.slug like 'qbo-%' and c.access_tier = 'essentials')))
    )
$$;

create or replace function public.trainer_courses_for_plan(p_plan_key text)
returns table(id uuid, slug text, title text, access_tier text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.slug, c.title, c.access_tier
  from public.courses c
  where c.ai_trainer_enabled = true and c.published = true
    and (not coalesce(p_plan_key = 'sampler', false)
         or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
$$;

-- 4d) Now, and only now. NO CASCADE on purpose: if a policy still references it,
--     this errors and stops the file rather than silently dropping a read policy.
drop function if exists public.plan_is_qbo_only();


-- ── Step 5 — Segment functions become VIP-only ─────────────────────────────
-- All `create or replace`, so grants and REVOKEs are preserved.

-- 5a) One space per batch. MUST precede the community_spaces_kind_check
--     narrowing in Step 7c, or the next batch insert fails on the gold row.
create or replace function public.batches_create_spaces()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.community_spaces (kind, batch_id, slug, name)
  values ('vip', new.id, 'vip-' || new.code, 'VIP - ' || new.name)
  on conflict (kind, batch_id) do nothing;
  insert into public.batch_events (batch_id, actor_id, action, detail)
  values (new.id, auth.uid(), 'create',
          jsonb_build_object('code', new.code, 'name', new.name));
  return new;
end;
$$;

revoke all on function public.batches_create_spaces() from public, anon, authenticated;

-- 5b) grant_batch_run: VIP is the only cohort segment, and capacity is read from
--     vip_capacity directly rather than a per-segment case.
create or replace function public.grant_batch_run(
  p_user_id uuid, p_segment text, p_start_batch_id uuid, p_count integer,
  p_grant_reason text, p_source_subscription_id uuid default null,
  p_source_plan_key text default null, p_source_request_id uuid default null,
  p_source_import_row_id uuid default null, p_valid_until timestamptz default null,
  p_actor uuid default null, p_enforce_capacity boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  if p_segment is distinct from 'vip' then
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
  -- this member occupy?" ambiguous for capacity. With one live segment this can
  -- now only fire on stamped history, which is exactly when it should.
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
    select b.id, b.code, b.status, b.starts_on, b.vip_capacity, b.total_capacity
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
      v_cap := v_cand.vip_capacity;
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

      -- total_capacity is retained: it is the cap across every cohort segment,
      -- which is one today but is the knob that stays correct if another is added.
      if v_cand.total_capacity is not null then
        select count(*) into v_used
          from public.batch_seat_holders(v_cand.id, 'vip') h
         where h <> p_user_id;
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
$$;

revoke all on function public.grant_batch_run(uuid, text, uuid, int, text, uuid, text, uuid, uuid, timestamptz, uuid, boolean)
  from public, anon, authenticated;

-- 5c) user_entitled_batches: the pre-#35 bridge is VIP-only.
create or replace function public.user_entitled_batches(p_user uuid)
returns table(batch_id uuid, segment text, batch_index integer,
              activates_at timestamptz, valid_until timestamptz)
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
       and coalesce(ep.community_segment, 'general') = 'vip'
       and not exists (select 1 from public.batch_entitlements e2 where e2.user_id = p_user)
  )
  select b.batch_id, b.segment, b.batch_index, b.activates_at, b.valid_until
    from (select * from ledger union all select * from bridge) b, gate g
   where g.enrolled and g.approved;
$$;

-- 5d) admin_finalize_enrollment: #34's body VERBATIM, with exactly two lines
--     changed (the two segment guards). Everything else — updated_at, the
--     rejected_at/rejected_by clearing, rejection_reason = null, the
--     v_prev_segment supersede — is preserved byte-for-byte. scripts/audit-db.mjs
--     greps this body for 'rejected_at = null'; losing it re-opens the #34
--     regression AND fails the audit.
create or replace function public.admin_finalize_enrollment(p_request_id uuid, p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if v_segment is distinct from 'vip' then
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
  if v_segment = 'vip' then
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

    -- A segment change must not leave seats from two segments coexisting.
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
$$;

revoke all on function public.admin_finalize_enrollment(uuid, uuid) from public, anon;
grant execute on function public.admin_finalize_enrollment(uuid, uuid) to authenticated;

-- 5e) admin_assign_batch — one guard line.
create or replace function public.admin_assign_batch(p_user_ids uuid[], p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
      if v_segment is distinct from 'vip' then
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
$$;

revoke all on function public.admin_assign_batch(uuid[], uuid) from public, anon;
grant execute on function public.admin_assign_batch(uuid[], uuid) to authenticated;

-- 5f) admin_grant_batch_run — one guard line.
create or replace function public.admin_grant_batch_run(
  p_user_id uuid, p_batch_id uuid, p_count integer default null, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  if v_segment is distinct from 'vip' then
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
$$;

revoke all on function public.admin_grant_batch_run(uuid, uuid, integer, boolean) from public, anon;
grant execute on function public.admin_grant_batch_run(uuid, uuid, integer, boolean) to authenticated;

-- 5g) admin_batches_needing_assignment — one predicate.
create or replace function public.admin_batches_needing_assignment(
  p_limit integer default 50, p_offset integer default 0)
returns table(user_id uuid, email text, full_name text, plan_key text, segment text,
              subscription_id uuid, ends_at timestamptz, total_count bigint)
language sql
stable
security definer
set search_path = public
as $$
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
     where l.segment = 'vip'
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
$$;

revoke all on function public.admin_batches_needing_assignment(integer, integer) from public, anon;
grant execute on function public.admin_batches_needing_assignment(integer, integer) to authenticated;

-- 5i) The drift view — column list unchanged, so `or replace` is legal.
create or replace view public.v_batch_entitlement_drift
with (security_invoker = true) as
  select s.user_id,
         s.id as subscription_id,
         s.plan_key,
         coalesce(ep.community_segment, 'general') as segment,
         s.batch_id as cached_batch_id,
         (select count(*) from public.batch_entitlements e
           where e.user_id = s.user_id and e.status in ('queued', 'active')) as outstanding_seats,
         case
           when coalesce(ep.community_segment, 'general') is distinct from 'vip' then
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

-- 5j) app_error_catalog: EVERY code is kept — src/lib/appErrors.js mirrors this
--     list by name and dropping one would break the client copy mapper. Only the
--     two summaries that name Gold are reworded.
create or replace function public.app_error_catalog()
returns table(code text, http integer, summary text)
language sql
immutable
parallel safe
set search_path = public
as $$
  select * from (values
    ('BATCH_REQUIRED',               422, 'A VIP action needs an explicit batch; none was supplied.'),
    ('BATCH_NOT_FOUND',              404, 'The batch id or month code does not exist.'),
    ('BATCH_CLOSED',                 409, 'The batch is closed to new assignments, or archived.'),
    ('BATCH_FULL',                   409, 'A cohort in the run has no seats left.'),
    ('NO_SPACE_FOR_SEGMENT',         409, 'The batch has no active community space for that plan segment.'),
    ('INVALID_BATCH_CODE',           422, 'Not a real YYYY-MM month.'),
    ('ENTITLEMENT_EXPIRED',          403, 'The membership term (or its grace) has ended.'),
    ('INVALID_PLAN',                 422, 'Unknown, inactive, or non-premium plan for this action.'),
    ('ALREADY_ENTITLED',             409, 'The member already holds an outstanding seat in that cohort.'),
    ('RUN_LIMIT_EXCEEDED',           409, 'Outstanding seats would exceed the per-member ceiling.'),
    ('SEGMENT_MISMATCH',             409, 'The grant would mix cohort segments in one outstanding run.'),
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
    ('COURSE_HAS_SUBMISSIONS',       409, 'The course has graded assignment work and cannot be deleted.'),
    -- ── #38, batch lifecycle ──
    ('BATCH_PAST',                   409, 'The batch period has elapsed in its own timezone; it is read-only.'),
    ('BATCH_CODE_TAKEN',             409, 'Another batch already uses that month code.'),
    ('BATCH_CODE_REORDER',           409, 'The new code would move the batch past a sibling and reorder members'' runs.'),
    ('BATCH_PERIOD_PAST',            422, 'The requested period has already ended; a batch cannot be edited into the past.'),
    ('BATCH_PERIOD_INVALID',         422, 'The end date falls before the start date, or a date is missing.'),
    ('BATCH_TIMEZONE_INVALID',       422, 'Not a timezone Postgres recognises (see pg_timezone_names).'),
    ('BATCH_CAPACITY_BELOW_OCCUPANCY',409,'The new capacity is below the seats already sold in that segment.')
  ) as t(code, http, summary);
$$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;

-- 5l) batch_entitlements_guard: comment-only reword (the body is unchanged), so
--     that "no function mentions gold" is a verifiable one-query fact.
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
    -- makes "granted into a cohort with no VIP space" impossible rather than
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
  -- found exactly this. (It is also what lets #39 delete the retired plan rows:
  -- source_plan_key transitions to NULL rather than blocking.) Reject only
  -- non-null → a DIFFERENT non-null.
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
      'an allocated seat cannot be moved - revoke it and grant a new one', 409,
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
      'valid_until only moves forward - revoke the seat to end it early', 409, null);
  end if;

  return new;
end;
$$;

revoke all on function public.batch_entitlements_guard() from public, anon, authenticated;

-- 5k) ★ batches_guard: drop gold_capacity from the past-lock freeze list.
--     MUST run BEFORE Step 7a — see the ORDERING HAZARD note at the top.
create or replace function public.batches_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz       text;
  v_override boolean;
begin
  if tg_op = 'INSERT' then
    v_tz := coalesce(nullif(new.timezone, ''), 'Asia/Manila');
    if not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
      perform public.app_error('BATCH_TIMEZONE_INVALID',
        format('%s is not a timezone Postgres recognises', v_tz), 422,
        jsonb_build_object('timezone', v_tz));
    end if;
    new.timezone := v_tz;

    -- Check the code shape BEFORE deriving dates from it. batches_code_check
    -- would catch a bad code, but CHECK constraints run AFTER before-triggers, so
    -- to_date('abc-01','YYYY-MM-DD') would get there first and report "invalid
    -- value for YYYY" — a parser complaint where a business error belongs.
    if new.code is null or new.code !~ '^\d{4}-(0[1-9]|1[0-2])$' then
      perform public.app_error('INVALID_BATCH_CODE',
        format('%s is not a real YYYY-MM month', coalesce(new.code, 'null')), 422,
        jsonb_build_object('code', new.code));
    end if;

    -- Every batch is born with a reliable period, whoever inserted it. This is
    -- what lets the client keep a plain INSERT and still satisfy "a new batch
    -- always has starts_on, ends_on and a timezone".
    if new.starts_on is null then
      new.starts_on := to_date(new.code || '-01', 'YYYY-MM-DD');
    end if;
    if new.ends_on is null then
      new.ends_on := (to_date(new.code || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;
    end if;
    if new.starts_on > new.ends_on then
      perform public.app_error('BATCH_PERIOD_INVALID',
        'the end date falls before the start date', 422,
        jsonb_build_object('starts_on', new.starts_on, 'ends_on', new.ends_on));
    end if;
    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────
  -- The primary key is the one thing every entitlement, space and audit row
  -- points at. It is never editable, by anyone, through any path.
  if new.id is distinct from old.id then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batches.id is frozen - entitlements, spaces and audit rows reference it', 409, null);
  end if;

  -- The gate is TABLE OWNERSHIP, not a role attribute. Gating on rolsuper alone
  -- would make the break-glass unreachable on the one database that needs it:
  -- Supabase's `postgres` — what the SQL editor and the Management API run as —
  -- is not a superuser. Ownership says exactly what is meant ("only whoever owns
  -- this table may bypass its guard") and needs no guessing about which
  -- attributes a given platform grants. PostgREST connects as `authenticator`,
  -- which is not a member of the owner, so the API can never reach this.
  -- pg_has_role() is already true for a superuser (they are implicitly a member of
  -- every role), so ownership alone covers both cases and needs no second branch.
  v_override := coalesce(current_setting('app.batch_admin_override', true), '') = 'on'
                and pg_has_role(session_user,
                                (select c.relowner from pg_class c
                                   join pg_namespace n on n.oid = c.relnamespace
                                  where n.nspname = 'public' and c.relname = 'batches'),
                                'member');

  if public.batch_is_past(old.ends_on, old.timezone) and not v_override then
    -- A past batch cannot be REOPENED. Without this the sweep and the admin fight:
    -- reopening succeeds (status is not a frozen field), then close_due_batches()
    -- matches `status='open' and is_past` and closes it again within the hour,
    -- and the batch cannot be extended out of the past either — a dead end with no
    -- error to explain it. Un-archiving a past batch restores it to `closed`,
    -- which is the only truthful state for a period that has ended.
    if new.status = 'open' and old.status <> 'open' then
      perform public.app_error('BATCH_PAST',
        format('batch %s ended on %s (%s) and cannot be reopened - create the next batch instead',
               old.code, old.ends_on, old.timezone), 409,
        jsonb_build_object('batch_code', old.code, 'ends_on', old.ends_on,
                           'timezone', old.timezone, 'attempted_status', 'open'));
    end if;

    -- Otherwise a past batch keeps exactly the lifecycle actions: close (the sweep
    -- lands here), archive, un-archive-to-closed. Every descriptive field is frozen.
    if new.code           is distinct from old.code
       or new.name           is distinct from old.name
       or new.starts_on      is distinct from old.starts_on
       or new.ends_on        is distinct from old.ends_on
       or new.timezone       is distinct from old.timezone
       or new.vip_capacity   is distinct from old.vip_capacity
       or new.total_capacity is distinct from old.total_capacity then
      perform public.app_error('BATCH_PAST',
        format('batch %s ended on %s (%s) and is read-only',
               old.code, old.ends_on, old.timezone), 409,
        jsonb_build_object('batch_code', old.code, 'ends_on', old.ends_on,
                           'timezone', old.timezone));
    end if;
    return new;
  end if;

  -- ★ RANK PRESERVATION IS ENFORCED HERE, not only in admin_update_batch().
  -- The column-level revoke stops `authenticated`, but `service_role` keeps
  -- table-level UPDATE and the SQL editor runs as the owner — and db/README.md
  -- documents the SQL editor as a first-class way to reach this database. Without
  -- this branch, `update batches set code = '2026-06' where code = '2026-12';`
  -- succeeds with no error and no audit row, and silently reorders a member's
  -- purchased run months later. The RPC validates first, so for that path this is
  -- a no-op re-check.
  if new.code is distinct from old.code and not v_override then
    if new.code is null or new.code !~ '^\d{4}-(0[1-9]|1[0-2])$' then
      perform public.app_error('INVALID_BATCH_CODE',
        format('%s is not a real YYYY-MM month', coalesce(new.code, 'null')), 422,
        jsonb_build_object('code', new.code));
    end if;
    if exists (select 1 from public.batches b
                where b.id <> new.id
                  and ((b.code < old.code) is distinct from (b.code < new.code))) then
      perform public.app_error('BATCH_CODE_REORDER',
        format('%s would move batch %s past a sibling and reorder members'' cohort runs',
               new.code, old.code), 409,
        jsonb_build_object('code', new.code, 'from_code', old.code));
    end if;
  end if;

  v_tz := coalesce(nullif(new.timezone, ''), 'Asia/Manila');
  if v_tz is distinct from coalesce(nullif(old.timezone, ''), 'Asia/Manila')
     and not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    perform public.app_error('BATCH_TIMEZONE_INVALID',
      format('%s is not a timezone Postgres recognises', v_tz), 422,
      jsonb_build_object('timezone', v_tz));
  end if;
  new.timezone := v_tz;

  if new.starts_on is not null and new.ends_on is not null and new.starts_on > new.ends_on then
    perform public.app_error('BATCH_PERIOD_INVALID',
      'the end date falls before the start date', 422,
      jsonb_build_object('starts_on', new.starts_on, 'ends_on', new.ends_on));
  end if;

  -- A live batch may not be edited INTO the past. Only a period change can do
  -- this, so a plain status flip on a running batch is unaffected.
  if (new.ends_on is distinct from old.ends_on or new.timezone is distinct from old.timezone)
     and public.batch_is_past(new.ends_on, new.timezone) and not v_override then
    perform public.app_error('BATCH_PERIOD_PAST',
      format('that period has already ended in %s', new.timezone), 422,
      jsonb_build_object('ends_on', new.ends_on, 'timezone', new.timezone));
  end if;

  return new;
end;
$$;

revoke all on function public.batches_guard() from public, anon, authenticated;

drop trigger if exists batches_guard on public.batches;
create trigger batches_guard
  before insert or update on public.batches
  for each row execute function public.batches_guard();


-- ── Step 6 — Signature / OUT-type changes (DROP + CREATE + re-GRANT) ───────

-- 6a) admin_update_batch: 9 args → 8. The old overload MUST be dropped, or both
--     resolve over PostgREST and a client that omits p_gold_capacity silently
--     binds a different function than one that sends it.
drop function if exists public.admin_update_batch(uuid, text, text, date, date, text, int, int, int);

-- `create OR REPLACE` for the new arity: the DROP above removes the old overload,
-- but on a re-run the 8-arg form already exists and a bare CREATE would fail with
-- 42723 (caught by re-running this file during development).
create or replace function public.admin_update_batch(
  p_batch_id uuid, p_code text, p_name text,
  p_starts_on date, p_ends_on date, p_timezone text,
  p_vip_capacity int, p_total_capacity int)          -- ★ still NO DEFAULTS (#38's reasoning)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old      public.batches%rowtype;
  v_code     text;
  v_name     text;
  v_tz       text;
  v_clash    text;
  v_old_act  timestamptz;
  v_new_act  timestamptz;
  v_spaces   int := 0;
  v_shifted  int := 0;
  v_used     int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_update_batch: admin only', 403, null);
  end if;

  select * into v_old from public.batches where id = p_batch_id for update;
  if v_old.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'admin_update_batch: batch not found', 404,
      jsonb_build_object('batch_id', p_batch_id));
  end if;

  if public.batch_is_past(v_old.ends_on, v_old.timezone) then
    perform public.app_error('BATCH_PAST',
      format('batch %s ended on %s (%s) and is read-only',
             v_old.code, v_old.ends_on, v_old.timezone), 409,
      jsonb_build_object('batch_code', v_old.code, 'ends_on', v_old.ends_on,
                         'timezone', v_old.timezone));
  end if;

  -- ── Name ──
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    perform public.app_error('BATCH_PERIOD_INVALID', 'a batch needs a display name', 422, null);
  end if;

  -- ── Code: shape, uniqueness, and RANK ──
  v_code := lower(btrim(coalesce(p_code, '')));
  if v_code !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    perform public.app_error('INVALID_BATCH_CODE',
      format('%s is not a real YYYY-MM month', coalesce(p_code, 'null')), 422,
      jsonb_build_object('code', p_code));
  end if;

  if v_code <> v_old.code then
    if exists (select 1 from public.batches b where b.code = v_code and b.id <> p_batch_id) then
      perform public.app_error('BATCH_CODE_TAKEN',
        format('another batch already uses %s', v_code), 409,
        jsonb_build_object('code', v_code));
    end if;

    -- ★ RANK PRESERVATION. grant_batch_run() allocates `order by b.code` from a
    -- start batch, and allocate_queued_entitlements() refuses any cohort not
    -- strictly above the highest code a run already holds. A code that crosses a
    -- sibling therefore reorders somebody's paid run — silently, and only
    -- visibly months later. Refuse it; a same-position correction is allowed.
    select b.code into v_clash
      from public.batches b
     where b.id <> p_batch_id
       and ((b.code < v_old.code) is distinct from (b.code < v_code))
     order by b.code
     limit 1;
    if v_clash is not null then
      perform public.app_error('BATCH_CODE_REORDER',
        format('%s would move this batch past %s and reorder members'' cohort runs',
               v_code, v_clash), 409,
        jsonb_build_object('code', v_code, 'from_code', v_old.code, 'crosses', v_clash));
    end if;
  end if;

  -- ── Timezone + period ──
  v_tz := coalesce(nullif(btrim(coalesce(p_timezone, '')), ''), 'Asia/Manila');
  if not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    perform public.app_error('BATCH_TIMEZONE_INVALID',
      format('%s is not a timezone Postgres recognises', v_tz), 422,
      jsonb_build_object('timezone', v_tz));
  end if;

  if p_starts_on is null or p_ends_on is null then
    perform public.app_error('BATCH_PERIOD_INVALID',
      'a batch needs both a start and an end date', 422, null);
  end if;
  if p_starts_on > p_ends_on then
    perform public.app_error('BATCH_PERIOD_INVALID',
      'the end date falls before the start date', 422,
      jsonb_build_object('starts_on', p_starts_on, 'ends_on', p_ends_on));
  end if;
  if public.batch_is_past(p_ends_on, v_tz) then
    perform public.app_error('BATCH_PERIOD_PAST',
      format('that period has already ended in %s', v_tz), 422,
      jsonb_build_object('ends_on', p_ends_on, 'timezone', v_tz));
  end if;

  -- ── Capacity may not fall below seats already sold ──
  -- batch_seat_holders() is the OCCUPANCY predicate (it ignores activates_at, so
  -- a seat in a future cohort still counts — it was paid for).
  select count(*) into v_used from public.batch_seat_holders(p_batch_id, 'vip');
  if p_vip_capacity is not null and p_vip_capacity < v_used then
    perform public.app_error('BATCH_CAPACITY_BELOW_OCCUPANCY',
      format('%s VIP seat(s) are already sold in %s', v_used, v_old.code), 409,
      jsonb_build_object('segment', 'vip', 'used', v_used, 'requested', p_vip_capacity));
  end if;

  if p_total_capacity is not null and p_total_capacity < v_used then
    perform public.app_error('BATCH_CAPACITY_BELOW_OCCUPANCY',
      format('%s seat(s) are already sold in %s', v_used, v_old.code), 409,
      jsonb_build_object('segment', 'total', 'used', v_used, 'requested', p_total_capacity));
  end if;

  -- ── Write ──
  update public.batches
     set code           = v_code,
         name           = v_name,
         starts_on      = p_starts_on,
         ends_on        = p_ends_on,
         timezone       = v_tz,
         vip_capacity   = p_vip_capacity,
         total_capacity = p_total_capacity,
         updated_at     = now()
   where id = p_batch_id;

  -- Dependent DISPLAY data, same transaction. The slug is NOT touched: it is a
  -- permalink (see its column comment). Only what a member reads follows.
  if v_name <> v_old.name then
    update public.community_spaces sp
       set name = 'VIP - ' || v_name,
           updated_at = now()
     where sp.batch_id = p_batch_id
       and sp.kind = 'vip';
    get diagnostics v_spaces = row_count;
  end if;

  -- A corrected start date moves seats that have NOT started yet. Already-active
  -- seats and revoked/superseded history are never rewritten — this can delay or
  -- advance a future cohort, never retract access somebody already has.
  v_old_act := coalesce(v_old.starts_on::timestamptz,
                        to_date(v_old.code || '-01', 'YYYY-MM-DD')::timestamptz);
  v_new_act := coalesce(p_starts_on::timestamptz,
                        to_date(v_code || '-01', 'YYYY-MM-DD')::timestamptz);
  if v_new_act is distinct from v_old_act then
    update public.batch_entitlements e
       set activates_at = v_new_act, updated_at = now()
     where e.batch_id = p_batch_id
       and e.status in ('queued', 'active')
       and e.activates_at is not null
       and e.activates_at > now();
    get diagnostics v_shifted = row_count;
  end if;

  insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
  values (p_batch_id, null, auth.uid(), 'edit',
          jsonb_build_object(
            'before', jsonb_build_object(
              'code', v_old.code, 'name', v_old.name,
              'starts_on', v_old.starts_on, 'ends_on', v_old.ends_on,
              'timezone', v_old.timezone,
              'vip_capacity', v_old.vip_capacity, 'total_capacity', v_old.total_capacity),
            'after', jsonb_build_object(
              'code', v_code, 'name', v_name,
              'starts_on', p_starts_on, 'ends_on', p_ends_on,
              'timezone', v_tz,
              'vip_capacity', p_vip_capacity, 'total_capacity', p_total_capacity),
            'spaces_renamed', v_spaces,
            'activations_shifted', v_shifted));

  return jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'code', v_code,
    'code_changed', v_code <> v_old.code,
    'name', v_name,
    'spaces_renamed', v_spaces,
    'activations_shifted', v_shifted);
end;
$$;

comment on function public.admin_update_batch(uuid, text, text, date, date, text, int, int) is
  'The ONLY path that may edit a batch record. Preserves the batch''s rank in `code` order '
  '(grant_batch_run/allocate_queued_entitlements allocate by it), renames the VIP space NAME but '
  'never its slug (a permalink), re-stamps activates_at on seats that have not started, and audits '
  'before/after. Refuses a past batch. #39 dropped p_gold_capacity with the Gold segment.';

revoke all on function public.admin_update_batch(uuid, text, text, date, date, text, int, int) from public, anon;
grant execute on function public.admin_update_batch(uuid, text, text, date, date, text, int, int) to authenticated;

-- 6b) admin_batch_overview: the OUT row type loses the three gold_* columns.
--     DROP + CREATE loses grants — the re-grant below is not optional.
-- DROP is required (not CREATE OR REPLACE): the OUT row type changes, and
-- Postgres refuses to replace a function whose return type differs.
drop function if exists public.admin_batch_overview();

create function public.admin_batch_overview()
returns table (
  batch_id uuid, code text, name text, status text,
  starts_on date, ends_on date, timezone text,
  closed_at timestamptz, close_reason text, is_past boolean,
  vip_capacity integer, total_capacity integer,
  vip_active bigint, total_active bigint,
  vip_queued bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.code, b.name, b.status,
         b.starts_on, b.ends_on, b.timezone,
         b.closed_at, b.close_reason,
         public.batch_is_past(b.ends_on, b.timezone) as is_past,
         b.vip_capacity, b.total_capacity,
         (select count(*) from public.batch_seat_holders(b.id, 'vip')) as vip_active,
         -- total_active is retained (equal to vip_active while VIP is the only
         -- cohort segment) so the Batches screen keeps one row shape whether or
         -- not another segment is ever added.
         (select count(*) from public.batch_seat_holders(b.id, 'vip')) as total_active,
         -- Committed demand: seats already sold that no cohort has absorbed yet.
         -- Alex needs this BEFORE setting a capacity, because queued seats are
         -- never retro-refused (they were paid for). Deliberately NOT correlated
         -- to b.id — a queued row has no batch_id, so this is a registry-wide
         -- total repeated on every row.
         (select count(*) from public.batch_entitlements e
           where e.status = 'queued' and e.segment = 'vip'
             and (e.valid_until is null or e.valid_until > now()))       as vip_queued
    from public.batches b
   where public.is_admin()
   order by b.code desc;
$$;

revoke all on function public.admin_batch_overview() from public, anon;
grant execute on function public.admin_batch_overview() to authenticated;


-- ── Step 7 — Schema narrowing (LAST) ───────────────────────────────────────

-- 7a) DDL, not DML. `alter table ... drop column` does NOT fire batches_guard(),
--     so the three archived/past batches are unaffected. NEVER write
--     `update public.batches set gold_capacity = null` — that WOULD fire the
--     guard and raise BATCH_PAST on every past row. Dropping the column also
--     removes batches_gold_capacity_check and the column's privileges.
alter table public.batches drop column if exists gold_capacity;

-- 7b) Re-issue #38's column-grant pair WITHOUT gold_capacity. These two are a
--     PAIR — splitting them leaves admins unable to write to batches at all.
revoke update on public.batches from authenticated, anon;
grant update (name, starts_on, ends_on, timezone, status,
              vip_capacity, total_capacity, closed_at, close_reason, updated_at)
  on public.batches to authenticated;

-- 7c) Narrow the three segment CHECKs.
--     Found by DEFINITION, not by name (#38's idiom) — but note Postgres renders
--     a single-value IN as `= 'vip'::text` rather than `= ANY(...)`, so the
--     finder matches either rendering plus the canonical name, and loops. That is
--     what makes this re-runnable.
--     The `kind = ANY` finder is deliberately narrow: a bare `%kind%` would also
--     match the anonymous `((kind = 'general') = (batch_id is null))` pairing
--     check and community_spaces_general_announcement_only, both of which must
--     survive untouched.
do $$
declare v_con text;
begin
  for v_con in
    select conname from pg_constraint
     where conrelid = 'public.community_spaces'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) ilike '%kind = ANY%'
            or conname = 'community_spaces_kind_check')
  loop
    execute format('alter table public.community_spaces drop constraint %I', v_con);
  end loop;
  alter table public.community_spaces
    add constraint community_spaces_kind_check check (kind in ('general', 'vip'));
end $$;

do $$
declare v_con text;
begin
  for v_con in
    select conname from pg_constraint
     where conrelid = 'public.enrollment_plans'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) ilike '%community_segment = ANY%'
            or pg_get_constraintdef(oid) ilike '%community_segment = ''vip''%'
            or conname = 'enrollment_plans_community_segment_check')
  loop
    execute format('alter table public.enrollment_plans drop constraint %I', v_con);
  end loop;
  alter table public.enrollment_plans
    add constraint enrollment_plans_community_segment_check
    check (community_segment in ('general', 'vip'));
end $$;

do $$
declare v_con text;
begin
  for v_con in
    select conname from pg_constraint
     where conrelid = 'public.batch_entitlements'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) ilike '%segment = ANY%'
            or pg_get_constraintdef(oid) ilike '%segment = ''vip''%'
            or conname = 'batch_entitlements_segment_check')
  loop
    execute format('alter table public.batch_entitlements drop constraint %I', v_con);
  end loop;
  alter table public.batch_entitlements
    add constraint batch_entitlements_segment_check check (segment = 'vip');
end $$;

-- 7c-bis) Space-name convergence. #32/#38 SOURCE writes 'VIP — ' (em dash, U+2014) while
--   every row this database actually holds says 'VIP - ' (ASCII hyphen) — the deployed
--   functions were installed through a channel that mangled the character. #39 writes a
--   plain hyphen at BOTH SQL sites (there is nothing left to mangle), so normalize any row
--   that still carries the em dash. Idempotent, and a no-op wherever the data is already
--   consistent. Slugs are untouched: they are permalinks.
update public.community_spaces
   set name = replace(name, ' ' || chr(8212) || ' ', ' - '), updated_at = now()
 where kind <> 'general'
   and name like '%' || chr(8212) || '%';

-- 7d) Comment hygiene, so "no gold anywhere" is verifiable with one query.
comment on column public.batches.total_capacity is
  'Total seat cap for this cohort across every segment. NULL = unlimited. Checked alongside '
  'vip_capacity by grant_batch_run(). Under D8 a seat is consumed in EVERY cohort of a run.';

comment on column public.community_spaces.kind is
  'general = the announcement space every active plan reads; vip = a batch''s private cohort '
  'forum. #39 removed the third kind (gold) with the Gold plan.';


-- ── Step 8 — Cache refresh + apply log ─────────────────────────────────────
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-17-three-plan-catalog.sql', null,
  'three-plan catalog (#39): removes core_self_paced + gold_live and the whole gold community '
  'segment. VIP is the only premium/private-batch segment. Deletes gold community_spaces, the '
  'terms/requests keyed to the removed plans, and neutralizes staged import rows; silver 2999 / '
  'vip 16999; positions sampler=1 silver=2 vip=3. Drops batches.gold_capacity + the gold_* OUT '
  'columns of admin_batch_overview(); admin_update_batch() loses p_gold_capacity (the 9-arg form '
  'is DROPPED). Narrows community_spaces.kind, enrollment_plans.community_segment and '
  'batch_entitlements.segment. plan_is_qbo_only() is dropped and the 4 course-read policies + '
  'course_object_allowed + the two trainer mirrors lose its conjunct; sampler keeps its '
  'Essentials-only rule. NOTE: the "#39" named in #35/#37 comments as the subscriptions.batch_id '
  'bridge retirement is now #40.')
on conflict (filename) do nothing;
