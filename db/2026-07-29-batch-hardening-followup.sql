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
