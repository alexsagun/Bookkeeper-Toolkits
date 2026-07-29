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
