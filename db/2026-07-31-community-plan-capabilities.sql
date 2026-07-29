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
