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
