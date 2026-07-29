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
