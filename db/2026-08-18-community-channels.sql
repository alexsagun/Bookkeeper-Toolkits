-- #40 — Community channels
-- =============================================================================
-- Turns the one-feed-per-space community into a channel-based one, WITHOUT
-- touching the entitlement seam underneath it.
--
-- The ladder after this file:
--
--   L1    community_spaces      who is a member at all   (UNCHANGED by this file)
--           user_community_space_ids() -> user_entitled_batches() -> the ledger
--   L1.5  community_channels    which rooms inside those spaces
--           user_community_channel_ids()
--   L2    per-channel rights    what you may do in a room
--           user_community_channel_capabilities()
--
-- ★ Channels NARROW, they never WIDEN. A channel is only reachable when its
--   space is already in the caller's L1 set, so a bug in the channel layer can
--   hide content but can never expose a space the member was not entitled to.
--
-- ★ D2 changes shape here, deliberately. #36 made General announcement-only with
--   a named CHECK (community_spaces_general_announcement_only) plus
--   can_post_in_general = false on every plan. That is a SPACE-WIDE prohibition,
--   so no General room could ever host a conversation. This file retires the
--   coarse rule and re-expresses its intent per channel:
--     #announcements  kind='announcement' => member_posting=false, comments off
--     everything else in General is an ordinary text channel
--   The constraint's own COMMENT demanded that reversing it be explicit and
--   recorded. It is: see db/README.md #40 and COMMUNITY_SETUP.md.
--   Attachment rights are NOT relaxed - sampler/silver stay false, VIP stays true.
--
-- Additive + idempotent. No post, comment, reaction, attachment, tag, batch or
-- entitlement row is deleted. community_tags keeps its job as post taxonomy and
-- is NOT repurposed as categories - a post has both a channel and a tag.
--
-- Depends on: #23/#24 (community), #32 (spaces+batches), #35 (ledger + app_error),
--             #36 (plan capabilities), #37 (attachment bindings), #39 (three plans),
--             #31 (schema_migrations) - guard aborts if any is missing.
--
-- Deploy the matching client build with it: the channel rail, the admin editor
-- and the ?channel= deep link ship in src/BookkeeperPro.jsx.
-- =============================================================================

-- == 0) Preflight =============================================================
do $preflight$
begin
  if to_regclass('public.community_spaces') is null then
    raise exception '#40 needs #32 (community spaces) - run 2026-07-28-community-spaces-batches.sql first';
  end if;
  if to_regclass('public.batch_entitlements') is null then
    raise exception '#40 needs #35 (batch entitlements ledger) - run 2026-07-30-batch-entitlements.sql first';
  end if;
  if to_regprocedure('public.app_error(text,text,integer,jsonb)') is null then
    raise exception '#40 needs public.app_error() from #35';
  end if;
  if to_regprocedure('public.user_community_capabilities(uuid)') is null then
    raise exception '#40 needs #36 - run 2026-07-31-community-plan-capabilities.sql first';
  end if;
  if to_regprocedure('public.user_entitled_batches(uuid)') is null then
    raise exception '#40 needs user_entitled_batches() from #35/#39';
  end if;
  -- Without this the tail apply-log insert would abort the whole file.
  if to_regclass('public.schema_migrations') is null then
    raise exception '#40 needs #31 - run 2026-07-26-schema-migrations-log.sql first';
  end if;
  -- #39: this file writes can_post_in_general for exactly the three surviving plan
  -- keys, and would seed channels into gold spaces #39 is about to delete.
  if exists (select 1 from public.enrollment_plans
              where key in ('core_self_paced','gold_live')) then
    raise exception '#40 needs #39 (three-plan catalog) - retired plan keys are still present';
  end if;
  -- #37: this file re-asserts the attachment insert policy and must build on the
  -- CORRECTED uploader/link/space binding, not #36's.
  if not exists (select 1 from pg_policies
                  where schemaname = 'public'
                    and policyname = 'community_attachments_own_insert'
                    and with_check ilike '%uploader_id%') then
    raise exception '#40 needs #37 (entitlement hardening) - attachment binding is missing';
  end if;
end
$preflight$;

-- == 1) Categories - organisation only, NEVER an authorization boundary =======
create table if not exists public.community_channel_categories (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.community_spaces(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  position    int  not null default 0,
  status      text not null default 'active' check (status in ('active','archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null
);

comment on table public.community_channel_categories is
  'Grouping headers for the channel rail. Organisation ONLY - a category never grants '
  'or withholds access. Authorization lives entirely on community_channels.';

-- == 2) Channels - navigation + the audience/rights boundary ==================
create table if not exists public.community_channels (
  id                 uuid primary key default gen_random_uuid(),
  space_id           uuid not null references public.community_spaces(id) on delete cascade,
  category_id        uuid not null references public.community_channel_categories(id) on delete restrict,
  slug               text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name               text not null check (char_length(btrim(name)) between 1 and 60),
  topic              text check (topic is null or char_length(topic) <= 280),
  kind               text not null default 'text' check (kind in ('text','announcement')),
  audience_mode      text not null default 'space'
                       check (audience_mode in ('space','plans','batches','plans_and_batches','admins_only')),
  member_posting     boolean not null default true,
  member_comments    boolean not null default true,
  member_reactions   boolean not null default true,
  member_attachments boolean not null default true,
  position           int  not null default 0,
  status             text not null default 'active' check (status in ('active','archived')),
  is_default         boolean not null default false,
  last_activity_at   timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.profiles(id) on delete set null,
  updated_by         uuid references public.profiles(id) on delete set null,
  -- An announcement channel is admin-post-only BY CONSTRUCTION, so an admin
  -- UPDATE that forgets to change the kind cannot quietly open it up.
  constraint community_channels_announcement_no_member_posting
    check (kind = 'text' or (member_posting = false and member_comments = false)),
  constraint community_channels_space_slug_key unique (space_id, slug)
);

comment on column public.community_channels.slug is
  'Stable permalink used by ?channel=<slug>. Renaming the display name never changes '
  'it - admin_save_community_channel() refuses a slug change on update.';
comment on column public.community_channels.audience_mode is
  'space | plans | batches | plans_and_batches | admins_only. Modes that need a mapping '
  'fail CLOSED when the mapping is empty (an EXISTS over zero rows is false).';

create unique index if not exists community_channels_one_default
  on public.community_channels (space_id) where is_default;

-- == 3) Community-wide settings (singleton) ===================================
create table if not exists public.community_settings (
  id                 boolean primary key default true,
  community_name     text not null default 'Community',
  description        text,
  welcome_message    text,
  default_channel_id uuid references public.community_channels(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles(id) on delete set null,
  constraint community_settings_singleton check (id)
);

-- == 4) Audience mappings - private admin config, never member-readable =======
create table if not exists public.community_channel_plans (
  channel_id uuid not null references public.community_channels(id) on delete cascade,
  plan_key   text not null references public.enrollment_plans(key) on delete cascade,
  primary key (channel_id, plan_key)
);

create table if not exists public.community_channel_batches (
  channel_id uuid not null references public.community_channels(id) on delete cascade,
  batch_id   uuid not null references public.batches(id) on delete cascade,
  primary key (channel_id, batch_id)
);

-- == 5) Per-user read markers =================================================
create table if not exists public.community_channel_reads (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  channel_id        uuid not null references public.community_channels(id) on delete cascade,
  last_read_at      timestamptz not null default now(),
  last_read_post_id uuid references public.community_posts(id) on delete set null,
  updated_at        timestamptz not null default now(),
  primary key (user_id, channel_id)
);

-- == 6) Immutable admin audit ledger (the batch_events precedent) =============
create table if not exists public.community_channel_events (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid references public.community_channels(id) on delete set null,
  category_id uuid references public.community_channel_categories(id) on delete set null,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null check (action in (
                'channel_create','channel_update','channel_privacy','channel_permissions',
                'channel_archive','channel_restore','channel_move',
                'category_create','category_update','category_move',
                'category_archive','category_restore',
                'settings_update','default_channel')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.community_channel_events is
  'Append-only. IDs and safe codes only - never post bodies, emails or names.';

-- == 7) Channel identity on existing content (nullable until backfilled) ======
alter table public.community_posts         add column if not exists channel_id uuid;
alter table public.community_comments      add column if not exists channel_id uuid;
alter table public.community_notifications add column if not exists channel_id uuid;

comment on column public.community_posts.channel_id is
  'The room this post lives in. space_id is DERIVED from it by community_posts_guard() '
  'and is never accepted from the client.';
comment on column public.community_comments.channel_id is
  'Denormalized from the parent post so the realtime channel can filter '
  'channel_id=eq.<id> - postgres_changes filters can only name columns of the '
  'published table. Same reason space_id was denormalized in #32.';

-- updated_at touch triggers (touch_updated_at() ships with #35)
drop trigger if exists community_channels_touch_updated_at on public.community_channels;
create trigger community_channels_touch_updated_at
  before update on public.community_channels
  for each row execute function public.touch_updated_at();

drop trigger if exists community_channel_categories_touch_updated_at on public.community_channel_categories;
create trigger community_channel_categories_touch_updated_at
  before update on public.community_channel_categories
  for each row execute function public.touch_updated_at();

-- == 8) Default channel seeding ===============================================
-- ONE implementation, called by the backfill below AND by batches_create_spaces(),
-- so a cohort can never end up with a space that has no rooms in it.
create or replace function public.seed_default_channels(p_space_id uuid)
returns void
language plpgsql security definer set search_path = public
as $seed$
declare
  v_kind text;
  v_name text;
  v_cat  uuid;
begin
  select kind, name into v_kind, v_name
    from public.community_spaces where id = p_space_id;
  if v_kind is null then return; end if;

  -- Idempotent: a space that already has any channel is left alone, so re-running
  -- the migration never duplicates rooms or resets an admin's edits.
  if exists (select 1 from public.community_channels where space_id = p_space_id) then
    return;
  end if;

  if v_kind = 'general' then
    insert into public.community_channel_categories (space_id, name, position)
    values (p_space_id, 'Start here', 0) returning id into v_cat;

    insert into public.community_channels
      (space_id, category_id, slug, name, topic, kind,
       member_posting, member_comments, member_attachments, position)
    values
      (p_space_id, v_cat, 'announcements', 'announcements',
       'Program news from Alex. Read and react - replies are off.',
       'announcement', false, false, false, 0),
      (p_space_id, v_cat, 'community-guide', 'community-guide',
       'How this community works and what belongs where.',
       'announcement', false, false, false, 1);

    insert into public.community_channel_categories (space_id, name, position)
    values (p_space_id, 'General community', 1) returning id into v_cat;

    insert into public.community_channels
      (space_id, category_id, slug, name, topic, position, is_default)
    values (p_space_id, v_cat, 'general-discussion', 'general-discussion',
            'Introductions, wins, and anything that does not fit another channel.',
            0, true);

    insert into public.community_channels
      (space_id, category_id, slug, name, topic, position)
    values
      (p_space_id, v_cat, 'quickbooks-help', 'quickbooks-help',
       'QuickBooks Online questions - cleanup, reconciliation, reports.', 1),
      (p_space_id, v_cat, 'job-search', 'job-search',
       'Applications, resumes, interviews, and offers.', 2),
      (p_space_id, v_cat, 'client-work', 'client-work',
       'Onboarding, pricing, engagement letters, and month-end delivery.', 3);
  else
    -- A cohort space is ALREADY private at L1, so its rooms use audience_mode
    -- 'space' - no plan or batch mapping is needed or wanted here.
    insert into public.community_channel_categories (space_id, name, position)
    values (p_space_id, v_name, 0) returning id into v_cat;

    insert into public.community_channels
      (space_id, category_id, slug, name, topic, position, is_default)
    values (p_space_id, v_cat, 'lounge', 'lounge',
            'Your cohort room. Introduce yourself and keep in touch.', 0, true);

    insert into public.community_channels
      (space_id, category_id, slug, name, topic, position)
    values (p_space_id, v_cat, 'coaching-questions', 'coaching-questions',
            'Ask Alex and your cohort. Screenshots welcome.', 1);
  end if;
end;
$seed$;

revoke all on function public.seed_default_channels(uuid) from public, anon, authenticated;

-- Seed every space that exists today.
do $seedall$
declare r record;
begin
  for r in select id from public.community_spaces order by created_at loop
    perform public.seed_default_channels(r.id);
  end loop;
end
$seedall$;

insert into public.community_settings (id, community_name, description, welcome_message)
values (true, 'Community',
        'Ask questions, share wins, and keep up with program news.',
        'Welcome. Start in #general-discussion and say hello.')
on conflict (id) do nothing;

update public.community_settings s
   set default_channel_id = (
         select ch.id
           from public.community_channels ch
           join public.community_spaces sp on sp.id = ch.space_id
          where sp.kind = 'general' and ch.is_default
          limit 1)
 where s.default_channel_id is null;

-- == 9) Backfill existing content =============================================
-- General announcements land in #announcements; everything else lands in the
-- space's default room (General -> #general-discussion, cohort -> #lounge).
update public.community_posts p
   set channel_id = coalesce(
         (select ch.id from public.community_channels ch
           where ch.space_id = p.space_id
             and ch.slug = 'announcements'
             and p.tag_slug = 'announcements'
           limit 1),
         (select ch.id from public.community_channels ch
           where ch.space_id = p.space_id and ch.is_default
           limit 1))
 where p.channel_id is null;

update public.community_comments c
   set channel_id = p.channel_id
  from public.community_posts p
 where p.id = c.post_id and c.channel_id is null;

update public.community_notifications n
   set channel_id = p.channel_id
  from public.community_posts p
 where p.id = n.post_id and n.channel_id is null;

-- Keep the rail's activity column honest for pre-existing content.
update public.community_channels ch
   set last_activity_at = greatest(ch.last_activity_at, agg.max_at)
  from (select channel_id, max(last_activity_at) as max_at
          from public.community_posts
         where channel_id is not null and status = 'active'
         group by channel_id) agg
 where agg.channel_id = ch.id;

-- == 10) Triggers ============================================================
-- ★ ORDERING TRAP: these MUST be replaced BEFORE the NOT NULL in section 11.
--   The old guard knows nothing about channel_id, so an insert arriving between
--   the constraint and the new trigger would fail on a null channel.
create or replace function public.community_posts_guard()
returns trigger
language plpgsql security definer set search_path = public
as $guard$
declare
  v_space uuid;
begin
  if tg_op = 'INSERT' then
    -- created_at is server time for members: a client-forged future date would
    -- launder into last_activity_at below and self-pin the post above the whole
    -- activity-sorted feed.
    if not public.is_admin() then
      new.created_at := now();
    end if;

    -- Resolve the channel FIRST. space_id is then DERIVED from it, so a forged
    -- {channel_id: <private>, space_id: <general>} pair cannot mix a cohort room
    -- into General - the row is simply judged by its real channel.
    if new.channel_id is null then
      -- Pre-#40 client: land in the default room of whatever space it named,
      -- falling back to the community-wide default. The seeded default is an
      -- interactive text channel, so these inserts land somewhere writable
      -- rather than bouncing off #announcements.
      select ch.id into new.channel_id
        from public.community_channels ch
       where ch.is_default
         and ch.status = 'active'
         and ch.space_id = coalesce(
               new.space_id,
               (select id from public.community_spaces where kind = 'general'))
       limit 1;
      -- ★ Only cross into the community-wide default when the client named NO
      --   space at all. If it named one and that space has no active default
      --   room (an admin archived it), failing is the ONLY safe answer:
      --   space_id is DERIVED from the channel below, so falling through would
      --   silently re-home a cohort-private post into General and publish it to
      --   every plan - 'channels NARROW, never WIDEN' broken by the guard itself.
      if new.channel_id is null and new.space_id is null then
        select default_channel_id into new.channel_id
          from public.community_settings where id;
      end if;
    end if;

    select ch.space_id into v_space
      from public.community_channels ch where ch.id = new.channel_id;
    if v_space is null then
      -- Deliberately the same code an UNAUTHORIZED channel returns: a distinct
      -- 404 here would confirm which channel ids exist.
      perform public.app_error('COMMUNITY_ACCESS_DENIED',
        'That channel is not available.', 403, null);
    end if;
    new.space_id := v_space;

    new.comment_count    := 0;
    new.last_activity_at := coalesce(new.created_at, now());
    if not public.is_admin() then
      new.pinned := false;
    end if;
    -- Admin-only tags and announcement channels both open locked.
    if exists (select 1 from public.community_tags t
                where t.slug = new.tag_slug and t.admin_only)
       or exists (select 1 from public.community_channels ch
                   where ch.id = new.channel_id and ch.kind = 'announcement') then
      new.comments_locked := true;
    elsif not public.is_admin() then
      new.comments_locked := false;
    end if;
  else
    if pg_trigger_depth() <= 1 and auth.uid() is not null then
      if not public.is_admin() then
        new.pinned          := old.pinned;
        new.comments_locked := old.comments_locked;
      end if;
      new.created_at       := old.created_at;  -- immutable; feeds the unread cutoff
      new.comment_count    := old.comment_count;
      new.last_activity_at := old.last_activity_at;
      new.space_id         := old.space_id;    -- immutable after creation
      new.channel_id       := old.channel_id;  -- immutable after creation
    elsif new.channel_id is distinct from old.channel_id then
      -- No-JWT SQL-editor / service-role move: keep space_id in step with the
      -- new channel so a moved thread cannot stay visible to the old space.
      select ch.space_id into new.space_id
        from public.community_channels ch where ch.id = new.channel_id;
    end if;
  end if;
  return new;
end;
$guard$;

create or replace function public.community_comment_space()
returns trigger
language plpgsql security definer set search_path = public
as $cspace$
begin
  if tg_op = 'INSERT' then
    select p.space_id, p.channel_id into new.space_id, new.channel_id
      from public.community_posts p where p.id = new.post_id;
  elsif auth.uid() is not null and pg_trigger_depth() <= 1 then
    new.space_id   := old.space_id;    -- frozen for every client write
    new.channel_id := old.channel_id;
  else
    -- Same escape hatch as the posts guard: re-derive from the parent so a
    -- moved thread's replies follow it instead of desyncing.
    select p.space_id, p.channel_id into new.space_id, new.channel_id
      from public.community_posts p where p.id = new.post_id;
  end if;
  return new;
end;
$cspace$;

-- Cohort spaces get their rooms at the same moment they get their space.
create or replace function public.batches_create_spaces()
returns trigger
language plpgsql security definer set search_path = public
as $bcs$
declare
  v_space uuid;
begin
  insert into public.community_spaces (kind, batch_id, slug, name)
  values ('vip', new.id, 'vip-' || new.code, 'VIP - ' || new.name)
  on conflict (kind, batch_id) do nothing
  returning id into v_space;

  if v_space is null then
    select id into v_space from public.community_spaces
     where kind = 'vip' and batch_id = new.id;
  end if;
  if v_space is not null then
    perform public.seed_default_channels(v_space);
  end if;

  insert into public.batch_events (batch_id, actor_id, action, detail)
  values (new.id, auth.uid(), 'create',
          jsonb_build_object('code', new.code, 'name', new.name));
  return new;
end;
$bcs$;

revoke all on function public.batches_create_spaces() from public, anon, authenticated;

-- == 11) Constraints, now that every row has a channel ========================
do $notnull$
begin
  if exists (select 1 from public.community_posts where channel_id is null) then
    raise exception '#40 backfill incomplete: community_posts still has null channel_id';
  end if;
  if exists (select 1 from public.community_comments where channel_id is null) then
    raise exception '#40 backfill incomplete: community_comments still has null channel_id';
  end if;
end
$notnull$;

alter table public.community_posts    alter column channel_id set not null;
alter table public.community_comments alter column channel_id set not null;

do $fks$
begin
  if not exists (select 1 from pg_constraint where conname = 'community_posts_channel_id_fkey') then
    alter table public.community_posts
      add constraint community_posts_channel_id_fkey
      foreign key (channel_id) references public.community_channels(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'community_comments_channel_id_fkey') then
    alter table public.community_comments
      add constraint community_comments_channel_id_fkey
      foreign key (channel_id) references public.community_channels(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'community_notifications_channel_id_fkey') then
    alter table public.community_notifications
      add constraint community_notifications_channel_id_fkey
      foreign key (channel_id) references public.community_channels(id) on delete cascade;
  end if;
end
$fks$;

-- == 12) Retire D2 as a SPACE-wide rule ======================================
-- ★ ORDER MATTERS: read whether the CHECK is there, THEN drop it, THEN flip the
--   flags. Flipping first violates the live constraint; reading first is what
--   makes a re-apply safe (below).
--
-- ★ THE RE-APPLY GUARD IS STATE-BASED, NOT APPLY-LOG-BASED. This file is designed
--   to be re-run (shadow project, and it is folded verbatim into the bootstrap),
--   and an unconditional re-apply would be the exact shape of the D2 incident this
--   file's header describes: it would silently undo a later, deliberate lockdown.
--   The signal is the CONSTRAINT, not schema_migrations:
--     · #36 - and its bootstrap fold - always re-adds community_spaces_general_
--       announcement_only whenever it re-locks General, so "constraint present"
--       means "D2 is in force again" and retiring it again is the correct move.
--     · A later deliberate lockdown is a bare UPDATE of the flags; it does not
--       re-add a constraint whose own COMMENT says dropping it is how you reverse
--       D2. So "constraint absent" means "leave whatever the flags say alone".
--   Keying this on the '#40 already applied' log row instead LOOKED equivalent and
--   was not, because #36's space-flag lock is unconditional (only its capability
--   seed is first-apply-guarded). Two supported flows therefore ended with the
--   General space read-only for every member - silently, with no error, while the
--   bootstrap header promises a re-run is safe:
--     1. a SECOND bootstrap run: §24 re-locks General, then §27 saw its own log
--        row and declined to flip it back;
--     2. `npm run db:shadow:apply --all` on a fresh shadow: the bootstrap unlocks,
--        then the dated #36 file re-locks after the fold, then this file declined.
--   user_community_capabilities() multiplies plan x space, so member_posting=false
--   on General zeroes can_post/can_comment for EVERY plan in EVERY General channel.
--   Found in code review before either file was committed. A database that already
--   ran #40 in its intended state sees this block as a no-op.
do $d2$
declare
  v_d2_in_force boolean;
  v_first_apply boolean;
begin
  select exists (
    select 1 from pg_constraint
     where conname = 'community_spaces_general_announcement_only'
  ) into v_d2_in_force;

  select not exists (
    select 1 from public.schema_migrations
     where filename = '2026-08-18-community-channels.sql'
  ) into v_first_apply;

  alter table public.community_spaces
    drop constraint if exists community_spaces_general_announcement_only;

  -- First apply retires D2 even if someone had already dropped the CHECK by hand
  -- (otherwise the headline feature of this file would not activate); after that,
  -- only a re-imposed D2 re-opens General.
  if not (v_d2_in_force or v_first_apply) then
    raise notice '#40: D2 already retired - leaving General space flags and plan capabilities alone';
    return;
  end if;

  update public.community_spaces
     set member_posting = true, member_comments = true, member_reactions = true
   where kind = 'general';

-- General rooms may now host conversation. Which rooms, and who may talk in
-- them, is decided per channel from here on.
  update public.enrollment_plans
     set can_post_in_general = true, can_comment_in_general = true
   where key in ('sampler','silver_self_paced','vip');
end
$d2$;

comment on column public.enrollment_plans.can_post_in_general is
  'Ceiling for posting in a GENERAL-space channel. Since #40 this is true for '
  'every active plan and the real decision is per channel '
  '(community_channels.member_posting + audience_mode). #announcements stays '
  'admin-only because it is kind=announcement, not because of this column.';

-- == 13) L1.5 - which channels can this user see? =============================
-- Set-based on purpose: the member's live plan and entitled batches are each
-- resolved ONCE, then the audience test is a join, not a per-row function call.
create or replace function public.user_community_channel_ids(p_user uuid)
returns setof uuid
language sql stable security definer set search_path = public
as $chids$
  with me as (
    select coalesce(p.is_admin, false) as is_admin
      from public.profiles p where p.id = p_user
  ),
  spaces as (
    -- L1 is the single membership seam. Never re-derive it here.
    select public.user_community_space_ids(p_user) as space_id
  ),
  live as (
    select s.plan_key
      from public.subscriptions s
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  seats as (
    -- The authoritative ledger. Batch STATUS is deliberately not consulted:
    -- closing or archiving a cohort must not revoke a seat already paid for.
    select batch_id from public.user_entitled_batches(p_user)
  )
  select ch.id
    from public.community_channels ch, me m
   where m.is_admin
      or (ch.status = 'active'
          and ch.space_id in (select space_id from spaces)
          and case ch.audience_mode
                when 'space'       then true
                when 'admins_only' then false
                when 'plans' then exists (
                  select 1 from public.community_channel_plans cp
                   where cp.channel_id = ch.id
                     and cp.plan_key = (select plan_key from live))
                when 'batches' then exists (
                  select 1 from public.community_channel_batches cb
                   where cb.channel_id = ch.id
                     and cb.batch_id in (select batch_id from seats))
                when 'plans_and_batches' then
                  exists (select 1 from public.community_channel_plans cp
                           where cp.channel_id = ch.id
                             and cp.plan_key = (select plan_key from live))
                  and exists (select 1 from public.community_channel_batches cb
                               where cb.channel_id = ch.id
                                 and cb.batch_id in (select batch_id from seats))
                else false
              end);
$chids$;

comment on function public.user_community_channel_ids(uuid) is
  'L1.5. Channels NARROW the space set - the space_id test is a conjunct, so this '
  'can never return a channel in a space the member cannot reach. An audience mode '
  'that needs a mapping fails CLOSED on an empty mapping. Admins see every channel '
  'including archived ones, which is what the editor needs.';

create or replace function public.my_community_channel_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $mychids$
  select * from public.user_community_channel_ids(auth.uid());
$mychids$;

-- == 14) L2 - what may this user do in each visible channel? ==================
create or replace function public.user_community_channel_capabilities(p_user uuid)
returns table (
  channel_id uuid,
  space_id   uuid,
  space_kind text,
  can_read    boolean,
  can_post    boolean,
  can_comment boolean,
  can_react   boolean,
  can_attach  boolean
)
language sql stable security definer set search_path = public
as $chcaps$
  with me as (
    select coalesce(p.is_admin, false) as is_admin
      from public.profiles p where p.id = p_user
  ),
  -- The SPACE ceiling: plan capability x space flag x L1 membership x approved.
  spacecaps as (select * from public.user_community_capabilities(p_user)),
  visible   as (select public.user_community_channel_ids(p_user) as id)
  select ch.id,
         ch.space_id,
         sp.kind,
         true,   -- the row's existence IS can_read
         m.is_admin or (sc.can_post    and ch.member_posting     and ch.status = 'active'),
         m.is_admin or (sc.can_comment and ch.member_comments    and ch.status = 'active'),
         m.is_admin or (sc.can_react   and ch.member_reactions   and ch.status = 'active'),
         -- Attaching still requires the right to create the thing it hangs off,
         -- otherwise a plan that cannot post could fill the private bucket.
         m.is_admin or (sc.can_attach  and ch.member_attachments
                        and ch.member_posting and ch.status = 'active')
    from public.community_channels ch
    join public.community_spaces sp on sp.id = ch.space_id
    join spacecaps sc on sc.space_id = ch.space_id
    cross join me m
   where ch.id in (select id from visible);
$chcaps$;

create or replace function public.my_community_channel_capabilities()
returns table (
  channel_id uuid, space_id uuid, space_kind text,
  can_read boolean, can_post boolean, can_comment boolean,
  can_react boolean, can_attach boolean
)
language sql stable security definer set search_path = public
as $mychcaps$
  select * from public.user_community_channel_capabilities(auth.uid());
$mychcaps$;

-- == 15) The one navigation call the client makes =============================
create or replace function public.my_community_sidebar()
returns table (
  space_id          uuid,
  space_slug        text,
  space_name        text,
  space_kind        text,
  batch_code        text,
  category_id       uuid,
  category_name     text,
  category_position int,
  channel_id        uuid,
  channel_slug      text,
  channel_name      text,
  channel_topic     text,
  channel_kind      text,
  channel_position  int,
  is_restricted     boolean,
  is_default        boolean,
  is_space_default  boolean,
  can_post          boolean,
  can_comment       boolean,
  can_react         boolean,
  can_attach        boolean,
  last_activity_at  timestamptz,
  unread_count      int,
  has_unread        boolean
)
language sql stable security definer set search_path = public
as $sidebar$
  with caps as (
    select * from public.user_community_channel_capabilities(auth.uid())
  ),
  reads as (
    select channel_id, last_read_at
      from public.community_channel_reads
     where user_id = auth.uid()
  ),
  landing as (select default_channel_id from public.community_settings where id)
  select sp.id, sp.slug, sp.name, sp.kind, b.code,
         cat.id, cat.name, cat.position,
         ch.id, ch.slug, ch.name, ch.topic, ch.kind, ch.position,
         -- Members are told a room is restricted; they are NEVER told which plan
         -- or batch it is restricted to. That mapping is admin-only config.
         (ch.audience_mode <> 'space') as is_restricted,
         (ch.id = (select default_channel_id from landing)) as is_default,
         ch.is_default,
         c.can_post, c.can_comment, c.can_react, c.can_attach,
         ch.last_activity_at,
         u.n::int,
         (u.n > 0)
    from caps c
    join public.community_channels ch  on ch.id = c.channel_id
    join public.community_spaces  sp   on sp.id = ch.space_id
    join public.community_channel_categories cat on cat.id = ch.category_id
    left join public.batches b on b.id = sp.batch_id
    left join reads r on r.channel_id = ch.id
    cross join lateral (
      -- Bounded on purpose: the rail shows 99+, so counting past 100 buys nothing
      -- and an unbounded count would scan the whole channel on every page load.
      select count(*) as n from (
        select 1 from public.community_posts p
         where p.channel_id = ch.id
           and p.status = 'active'
           and p.author_id <> auth.uid()
           and p.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
         limit 100
      ) capped
    ) u
   where ch.status = 'active'
     and cat.status = 'active'
   order by (sp.kind = 'general') desc, b.code asc nulls first,
            cat.position, cat.name, ch.position, ch.name;
$sidebar$;

-- == 16) Why was my write refused? ===========================================
create or replace function public.community_channel_write_denial(
  p_channel_id uuid, p_kind text default 'post')
returns jsonb
language sql stable security definer set search_path = public
as $denial$
  with ch as (select * from public.community_channels where id = p_channel_id),
  cap as (select * from public.my_community_channel_capabilities()
           where channel_id = p_channel_id)
  select case
    -- A channel the caller cannot see is reported exactly like one that does not
    -- exist. Distinguishing them would confirm a private room exists.
    when not exists (select 1 from cap) then
      jsonb_build_object('allowed', false, 'code', 'COMMUNITY_ACCESS_DENIED',
                         'reason', 'no_such_channel')
    when p_kind = 'comment' and (select can_comment from cap) then jsonb_build_object('allowed', true)
    when p_kind = 'react'   and (select can_react   from cap) then jsonb_build_object('allowed', true)
    when p_kind = 'attach'  and (select can_attach  from cap) then jsonb_build_object('allowed', true)
    when p_kind = 'post'    and (select can_post    from cap) then jsonb_build_object('allowed', true)
    when (select status from ch) <> 'active' then
      jsonb_build_object('allowed', false, 'code', 'CHANNEL_ARCHIVED',
                         'reason', 'archived_channel')
    when (select kind from ch) = 'announcement' and p_kind in ('post','attach') then
      jsonb_build_object('allowed', false, 'code', 'COMMUNITY_ACCESS_DENIED',
                         'reason', 'announcement_channel')
    when p_kind = 'comment' and not (select member_comments from ch) then
      jsonb_build_object('allowed', false, 'code', 'COMMENT_PERMISSION_DENIED',
                         'reason', 'comments_off')
    when p_kind = 'comment' then
      jsonb_build_object('allowed', false, 'code', 'COMMENT_PERMISSION_DENIED',
                         'reason', 'plan_or_channel')
    else
      jsonb_build_object('allowed', false, 'code', 'COMMUNITY_ACCESS_DENIED',
                         'reason', 'plan_or_channel')
  end;
$denial$;

-- == 17) Read markers ========================================================
create or replace function public.mark_community_channel_read(p_channel_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public
as $markread$
declare
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    perform public.app_error('FORBIDDEN', 'Sign in to use the community.', 403, null);
  end if;
  if p_channel_id is null
     or p_channel_id not in (select public.my_community_channel_ids()) then
    perform public.app_error('COMMUNITY_ACCESS_DENIED',
      'That channel is not available.', 403, null);
  end if;

  insert into public.community_channel_reads
    (user_id, channel_id, last_read_at, last_read_post_id, updated_at)
  values (auth.uid(), p_channel_id, v_now,
          (select p.id from public.community_posts p
            where p.channel_id = p_channel_id and p.status = 'active'
            order by p.created_at desc limit 1),
          v_now)
  on conflict (user_id, channel_id) do update
    set last_read_at      = greatest(public.community_channel_reads.last_read_at,
                                     excluded.last_read_at),
        last_read_post_id = excluded.last_read_post_id,
        updated_at        = v_now;
  return v_now;
end;
$markread$;

-- == 18) Notification triggers become channel-scoped ==========================
-- A uuid pasted into a body must not notify someone who cannot reach the room.
create or replace function public.community_notify_on_post()
returns trigger
language plpgsql security definer set search_path = public
as $nop$
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
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       -- CHANNEL access, not space access (#40): a member of the space who
       -- cannot open this room must not learn it exists.
       and new.channel_id in (select public.user_community_channel_ids(v_uid))
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url,
         post_id, post_title, space_id, channel_id)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar,
              new.id, v_title, new.space_id, new.channel_id);
    end if;
  end loop;
  return new;
end;
$nop$;

create or replace function public.community_notify_on_comment()
returns trigger
language plpgsql security definer set search_path = public
as $noc$
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
       and exists (select 1 from public.profiles pr2
                    where pr2.id = v_uid
                      and coalesce(nullif(trim(pr2.full_name), ''), '') <> ''
                      and (pr2.is_admin or pr2.approval_status = 'approved'))
       and new.channel_id in (select public.user_community_channel_ids(v_uid))
       and not exists (select 1 from public.community_notifications n
                        where n.user_id = v_uid and n.actor_id = new.author_id
                          and n.post_id = new.post_id and n.kind = 'mention'
                          and n.read_at is null) then
      v_done := v_done || v_uid;
      insert into public.community_notifications
        (user_id, kind, actor_id, actor_name, actor_avatar_url,
         post_id, comment_id, post_title, space_id, channel_id)
      values (v_uid, 'mention', new.author_id, v_actor_name, v_actor_avatar,
              new.post_id, new.id, v_title, new.space_id, new.channel_id);
    end if;
  end loop;

  -- Reply notification. The post author is by definition in the room, but a
  -- privacy change could have taken it away since - re-check rather than assume.
  if v_post.author_id <> new.author_id
     and not (v_post.author_id = any(v_done))
     and new.channel_id in (select public.user_community_channel_ids(v_post.author_id))
     and not exists (select 1 from public.community_notifications n
                      where n.user_id = v_post.author_id and n.actor_id = new.author_id
                        and n.post_id = new.post_id and n.kind = 'reply'
                        and n.read_at is null) then
    insert into public.community_notifications
      (user_id, kind, actor_id, actor_name, actor_avatar_url,
       post_id, comment_id, post_title, space_id, channel_id)
    values (v_post.author_id, 'reply', new.author_id, v_actor_name, v_actor_avatar,
            new.post_id, new.id, v_title, new.space_id, new.channel_id);
  end if;
  return new;
end;
$noc$;

-- == 19) Mention directory becomes channel-scoped ==============================
-- Set-based (#33 kept it that way): resolve each candidate's rights via the
-- capability function rather than looping.
-- ★ DROP the #33 two-arg form first. `create or replace` with a different arity
--   creates an OVERLOAD, and a defaulted overload makes every existing
--   search_community_members(p_query, p_space_id) call ambiguous (42725).
drop function if exists public.search_community_members(text, uuid);

create or replace function public.search_community_members(
  p_query text, p_space_id uuid default null, p_channel_id uuid default null)
returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public
as $mem$
  with target as (
    select ch.id as channel_id, ch.space_id
      from public.community_channels ch
     where ch.id = p_channel_id
  ),
  -- The caller must themselves be able to write in the room, otherwise the
  -- directory becomes a membership oracle for a room they cannot enter.
  allowed as (
    select 1 from public.my_community_channel_capabilities() c, target t
     where c.channel_id = t.channel_id and (c.can_post or c.can_comment)
  ),
  candidates as (
    select p.id, btrim(p.full_name) as display_name, p.avatar_url
      from public.profiles p
     where exists (select 1 from allowed)
       and char_length(btrim(coalesce(p_query, ''))) >= 2
       -- Nameless profiles are unmentionable: the markup needs a display name,
       -- and falling back to the email address would leak it.
       and coalesce(btrim(p.full_name), '') <> ''
       and p.full_name ilike '%' || btrim(p_query) || '%'
       and (p.is_admin or p.approval_status = 'approved')
     order by p.full_name
     -- ★ BOUND before the per-candidate eligibility test below. #33 removed a
     --   per-row SECURITY DEFINER call from this function precisely because
     --   `limit 20` applies AFTER the predicate and therefore bounds nothing:
     --   a two-character query would fire one full ledger walk per matching
     --   profile, per keystroke. Narrowing by name first caps the work at 60
     --   resolutions regardless of how large `profiles` grows. The trade-off is
     --   explicit: with more than 60 name matches the tail is not searched, so
     --   the answer is "type a bit more", never a wrong or widened one.
     limit 60
  ),
  -- Eligibility still goes through the CANONICAL helper - never a re-derivation
  -- of plan/batch rules here. It is simply asked at most 60 times, not N times.
  eligible as (
    select c.id, c.display_name, c.avatar_url
      from candidates c, target t
     where t.channel_id in (select public.user_community_channel_ids(c.id))
  )
  select e.id, e.display_name, e.avatar_url
    from eligible e
   order by e.display_name
   limit 20;
$mem$;

comment on function public.search_community_members(text, uuid, uuid) is
  'Mention autocomplete, scoped to a CHANNEL since #40. p_space_id is retained for '
  'signature compatibility with pre-#40 clients and is ignored; a call with no '
  'channel returns nothing, which is the fail-closed direction.';

-- == 20) Category counts follow the channel ===================================
-- Same overload hazard as search_community_members above.
drop function if exists public.community_category_counts(uuid);

create or replace function public.community_category_counts(
  p_space_id uuid default null, p_channel_id uuid default null)
returns table (tag_slug text, n bigint)
language sql stable set search_path = public
as $counts$
  -- SECURITY INVOKER on purpose: community_posts_read scopes the counts.
  select p.tag_slug, count(*)::bigint
    from public.community_posts p
   where p.status = 'active'
     and (p_channel_id is null or p.channel_id = p_channel_id)
     and (p_space_id  is null or p.space_id  = p_space_id)
   group by p.tag_slug;
$counts$;

-- == 21) RLS on the new tables ================================================
-- Writes are RPC-only everywhere here, so each table gets a read policy plus the
-- explicit revoke. RLS alone is not enough: Supabase's default grants survive a
-- missing policy (the batch_entitlements precedent, #35).
alter table public.community_channel_categories enable row level security;
alter table public.community_channels           enable row level security;
alter table public.community_settings           enable row level security;
alter table public.community_channel_plans      enable row level security;
alter table public.community_channel_batches    enable row level security;
alter table public.community_channel_reads      enable row level security;
alter table public.community_channel_events     enable row level security;

drop policy if exists community_channels_read on public.community_channels;
create policy community_channels_read on public.community_channels
  for select to authenticated
  using ((select public.is_admin()) or id in (select public.my_community_channel_ids()));

drop policy if exists community_channel_categories_read on public.community_channel_categories;
create policy community_channel_categories_read on public.community_channel_categories
  for select to authenticated
  using (
    (select public.is_admin())
    -- Uncorrelated on purpose: one InitPlan per statement, not one per row.
    or id in (select ch.category_id from public.community_channels ch
               where ch.id in (select public.my_community_channel_ids()))
  );

drop policy if exists community_settings_read on public.community_settings;
create policy community_settings_read on public.community_settings
  for select to authenticated
  using ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())));

-- ★ Audience mappings are ADMIN-ONLY to read. Telling a member which plans or
--   batches a room is limited to would leak the shape of the cohort roster.
drop policy if exists community_channel_plans_admin_select on public.community_channel_plans;
create policy community_channel_plans_admin_select on public.community_channel_plans
  for select to authenticated using ((select public.is_admin()));

drop policy if exists community_channel_batches_admin_select on public.community_channel_batches;
create policy community_channel_batches_admin_select on public.community_channel_batches
  for select to authenticated using ((select public.is_admin()));

drop policy if exists community_channel_reads_own_select on public.community_channel_reads;
create policy community_channel_reads_own_select on public.community_channel_reads
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists community_channel_events_admin_select on public.community_channel_events;
create policy community_channel_events_admin_select on public.community_channel_events
  for select to authenticated using ((select public.is_admin()));

revoke insert, update, delete, truncate on public.community_channels           from authenticated, anon, public;
revoke insert, update, delete, truncate on public.community_channel_categories from authenticated, anon, public;
revoke insert, update, delete, truncate on public.community_settings           from authenticated, anon, public;
revoke insert, update, delete, truncate on public.community_channel_plans      from authenticated, anon, public;
revoke insert, update, delete, truncate on public.community_channel_batches    from authenticated, anon, public;
revoke insert, update, delete, truncate on public.community_channel_reads      from authenticated, anon, public;
revoke insert, update, delete, truncate on public.community_channel_events     from authenticated, anon, public;

grant select on public.community_channels           to authenticated;
grant select on public.community_channel_categories to authenticated;
grant select on public.community_settings           to authenticated;
grant select on public.community_channel_plans      to authenticated;
grant select on public.community_channel_batches    to authenticated;
grant select on public.community_channel_reads      to authenticated;
grant select on public.community_channel_events     to authenticated;

-- == 22) Content policies move from space scope to channel scope ==============
-- Shape is unchanged from #36 - only the scoping predicate moves down a level.
-- The author-owns-`deleted` branch stays: without it Postgres refuses the
-- soft-delete outright, because an UPDATE whose resulting row would be invisible
-- to the writer fails 42501. That is the #36 bug and it must not come back.

drop policy if exists community_posts_read on public.community_posts;
create policy community_posts_read on public.community_posts
  for select to authenticated
  using (
    (select public.is_admin())
    or (status = 'active'
        and (select public.is_approved()) and (select public.is_enrolled())
        and channel_id in (select public.my_community_channel_ids()))
    or (author_id = (select auth.uid()) and status = 'deleted')
  );

drop policy if exists community_posts_own_insert on public.community_posts;
create policy community_posts_own_insert on public.community_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'active'
    and (select public.is_approved()) and (select public.is_enrolled())
    and channel_id in (select c.channel_id
                         from public.my_community_channel_capabilities() c
                        where c.can_post)
    and not exists (select 1 from public.community_tags t
                     where t.slug = tag_slug and t.admin_only)
  );

drop policy if exists community_posts_own_update on public.community_posts;
create policy community_posts_own_update on public.community_posts
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden')
  with check (
    author_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and (
      -- withdraw: only needs to still be able to SEE the room
      (status = 'deleted' and channel_id in (select public.my_community_channel_ids()))
      or
      -- keep published: needs the write right
      (status = 'active'
       and channel_id in (select c.channel_id
                            from public.my_community_channel_capabilities() c
                           where c.can_post)
       and not exists (select 1 from public.community_tags t
                        where t.slug = tag_slug and t.admin_only))
    )
  );

drop policy if exists community_comments_read on public.community_comments;
create policy community_comments_read on public.community_comments
  for select to authenticated
  using (
    (select public.is_admin())
    or (status = 'active'
        and (select public.is_approved()) and (select public.is_enrolled())
        and channel_id in (select public.my_community_channel_ids())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'))
    or (author_id = (select auth.uid()) and status = 'deleted')
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
         and p.channel_id in (select c.channel_id
                                from public.my_community_channel_capabilities() c
                               where c.can_comment))
  );

drop policy if exists community_comments_own_update on public.community_comments;
create policy community_comments_own_update on public.community_comments
  for update to authenticated
  using (author_id = (select auth.uid()) and status <> 'hidden')
  with check (
    author_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and ((status = 'deleted' and channel_id in (select public.my_community_channel_ids()))
         or (status = 'active'
             and channel_id in (select c.channel_id
                                  from public.my_community_channel_capabilities() c
                                 where c.can_comment)))
  );

drop policy if exists community_reactions_read on public.community_reactions;
create policy community_reactions_read on public.community_reactions
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and ((post_id is not null and exists (
                select 1 from public.community_posts p
                 where p.id = post_id and p.status = 'active'
                   and p.channel_id in (select public.my_community_channel_ids())))
          or (comment_id is not null and exists (
                select 1 from public.community_comments c
                  join public.community_posts p on p.id = c.post_id
                 where c.id = comment_id and c.status = 'active' and p.status = 'active'
                   and p.channel_id in (select public.my_community_channel_ids())))))
  );

drop policy if exists community_reactions_own_insert on public.community_reactions;
create policy community_reactions_own_insert on public.community_reactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.is_approved()) and (select public.is_enrolled())
    and ((post_id is not null and exists (
            select 1 from public.community_posts p
             where p.id = post_id and p.status = 'active'
               and p.channel_id in (select c.channel_id
                                      from public.my_community_channel_capabilities() c
                                     where c.can_react)))
      or (comment_id is not null and exists (
            select 1 from public.community_comments c2
              join public.community_posts p on p.id = c2.post_id
             where c2.id = comment_id and c2.status = 'active' and p.status = 'active'
               and p.channel_id in (select c.channel_id
                                      from public.my_community_channel_capabilities() c
                                     where c.can_react))))
  );

drop policy if exists community_attachments_read on public.community_attachments;
create policy community_attachments_read on public.community_attachments
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'
                       and p.channel_id in (select public.my_community_channel_ids())))
  );

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
         and p.channel_id in (select c.channel_id
                                from public.my_community_channel_capabilities() c
                               where c.can_attach)
         -- Storage paths stay SPACE-scoped (<space_id>/<uid>/...) so every
         -- pre-#40 object keeps resolving. #37's legacy <uid>/... branch stays.
         and (community_attachments.storage_path is null
              or (storage.foldername(community_attachments.storage_path))[1] = (select auth.uid())::text
              or ((storage.foldername(community_attachments.storage_path))[1] = p.space_id::text
                  and (storage.foldername(community_attachments.storage_path))[2] = (select auth.uid())::text)))
  );

drop policy if exists community_attachments_own_delete on public.community_attachments;
create policy community_attachments_own_delete on public.community_attachments
  for delete to authenticated
  using (
    uploader_id = (select auth.uid())
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

drop policy if exists community_post_tags_read on public.community_post_tags;
create policy community_post_tags_read on public.community_post_tags
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_approved()) and (select public.is_enrolled())
        and exists (select 1 from public.community_posts p
                     where p.id = post_id and p.status = 'active'
                       and p.channel_id in (select public.my_community_channel_ids())))
  );

drop policy if exists community_post_tags_own_insert on public.community_post_tags;
create policy community_post_tags_own_insert on public.community_post_tags
  for insert to authenticated
  with check (
    (select public.is_approved()) and (select public.is_enrolled())
    and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

drop policy if exists community_post_tags_own_delete on public.community_post_tags;
create policy community_post_tags_own_delete on public.community_post_tags
  for delete to authenticated
  using (
    ((select public.is_admin())
     or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.author_id = (select auth.uid())
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

drop policy if exists community_notifications_own_select on public.community_notifications;
create policy community_notifications_own_select on public.community_notifications
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    -- A privacy change that removes the room also hides the notification about it.
    -- No `channel_id is null` escape: a degenerate row (no post to derive a
    -- channel from) still carries post_title, which is post body text.
    and channel_id in (select public.my_community_channel_ids())
  );

drop policy if exists community_notifications_own_update on public.community_notifications;
create policy community_notifications_own_update on public.community_notifications
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    -- No `channel_id is null` escape: a degenerate row (no post to derive a
    -- channel from) still carries post_title, which is post body text.
    and channel_id in (select public.my_community_channel_ids())
  )
  with check (user_id = (select auth.uid()));

drop policy if exists community_announcement_reads_own_insert on public.community_announcement_reads;
create policy community_announcement_reads_own_insert on public.community_announcement_reads
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())))
    and exists (select 1 from public.community_posts p
                 where p.id = post_id and p.status = 'active'
                   and p.channel_id in (select public.my_community_channel_ids()))
  );

-- == 23) Storage: the private community-media bucket =========================
-- Authorization stays attachment-join based (never path based), so every legacy
-- <uid>/... object keeps resolving. Only the scoping predicate moves to channels.
drop policy if exists community_media_read on storage.objects;
create policy community_media_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'community-media'
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())
             and exists (
               select 1 from public.community_attachments a
                 join public.community_posts p on p.id = a.post_id
                where a.storage_path = name
                  and p.status = 'active'
                  and p.channel_id in (select public.my_community_channel_ids()))))
  );

-- #34's invariant: community_media_delete must match community_attachments_own_delete,
-- so the row and its object stay deletable (or not) TOGETHER. #40 moved the row
-- policy to channel scope, so this moves with it - otherwise a member who loses
-- channel access can still delete the object but not the row, leaving a dangling
-- attachment that renders as a broken image for everyone still in the room.
drop policy if exists community_media_delete on storage.objects;
create policy community_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'community-media'
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())
             and exists (
               select 1 from public.community_attachments a
                 join public.community_posts p on p.id = a.post_id
                where a.storage_path = name
                  and a.uploader_id = (select auth.uid())
                  and p.channel_id in (select public.my_community_channel_ids()))))
  );

drop policy if exists community_media_own_insert on storage.objects;
create policy community_media_own_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-media'
    and (select public.is_approved()) and (select public.is_enrolled())
    and exists (select 1 from public.my_community_channel_capabilities() c where c.can_attach)
    and ((storage.foldername(name))[1] = ((select auth.uid()))::text
         or ((storage.foldername(name))[2] = ((select auth.uid()))::text
             and (case
                    when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                      then ((storage.foldername(name))[1])::uuid
                    else null::uuid
                  end) in (select public.my_community_space_ids())))
  );

-- == 24) Admin editor RPCs ====================================================
-- Every mutation to channels, categories, settings and audience mappings goes
-- through these. The tables carry NO client write policy, so there is no path
-- that changes access without also writing the community_channel_events row.

create or replace function public.admin_community_config()
returns jsonb
language plpgsql stable security definer set search_path = public
as $cfg$
declare v jsonb;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  select jsonb_build_object(
    'settings', coalesce((select to_jsonb(s) from public.community_settings s where s.id), '{}'::jsonb),
    'spaces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sp.id, 'slug', sp.slug, 'name', sp.name, 'kind', sp.kind,
               'batch_code', b.code, 'active', sp.active)
             order by (sp.kind = 'general') desc, b.code)
        from public.community_spaces sp
        left join public.batches b on b.id = sp.batch_id), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', cat.id, 'space_id', cat.space_id, 'name', cat.name,
               'position', cat.position, 'status', cat.status)
             order by cat.space_id, cat.position, cat.name)
        from public.community_channel_categories cat), '[]'::jsonb),
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ch.id, 'space_id', ch.space_id, 'category_id', ch.category_id,
               'slug', ch.slug, 'name', ch.name, 'topic', ch.topic, 'kind', ch.kind,
               'audience_mode', ch.audience_mode,
               'member_posting', ch.member_posting, 'member_comments', ch.member_comments,
               'member_reactions', ch.member_reactions, 'member_attachments', ch.member_attachments,
               'position', ch.position, 'status', ch.status, 'is_default', ch.is_default,
               'plan_keys', coalesce((select jsonb_agg(cp.plan_key order by cp.plan_key)
                                        from public.community_channel_plans cp
                                       where cp.channel_id = ch.id), '[]'::jsonb),
               'batch_ids', coalesce((select jsonb_agg(cb.batch_id order by cb.batch_id)
                                        from public.community_channel_batches cb
                                       where cb.channel_id = ch.id), '[]'::jsonb),
               'post_count', (select count(*) from public.community_posts p
                               where p.channel_id = ch.id and p.status = 'active'))
             order by ch.space_id, ch.position, ch.name)
        from public.community_channels ch), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object('key', ep.key, 'name', ep.name,
                                          'community_segment', ep.community_segment,
                                          'active', ep.active) order by ep.position)
        from public.enrollment_plans ep), '[]'::jsonb),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object('id', bb.id, 'code', bb.code,
                                          'name', bb.name, 'status', bb.status)
             order by bb.code desc)
        from public.batches bb), '[]'::jsonb)
  ) into v;
  return v;
end;
$cfg$;

create or replace function public.admin_save_community_settings(
  p_name text, p_description text, p_welcome text, p_default_channel_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $setg$
declare v_before jsonb;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  select to_jsonb(s) into v_before from public.community_settings s where s.id;

  -- The landing channel id is readable by every enrolled member via
  -- community_settings, so it must not name a restricted room.
  if p_default_channel_id is not null
     and not exists (select 1 from public.community_channels ch
                       join public.community_spaces sp on sp.id = ch.space_id
                      where ch.id = p_default_channel_id
                        and ch.status = 'active'
                        and ch.audience_mode = 'space'
                        and sp.kind = 'general') then
    perform public.app_error('CHANNEL_NOT_FOUND',
      'The landing channel must be an active, space-wide General channel.', 404, null);
  end if;

  insert into public.community_settings
    (id, community_name, description, welcome_message, default_channel_id, updated_at, updated_by)
  values (true, coalesce(nullif(btrim(p_name), ''), 'Community'),
          nullif(btrim(coalesce(p_description, '')), ''),
          nullif(btrim(coalesce(p_welcome, '')), ''),
          p_default_channel_id, now(), auth.uid())
  on conflict (id) do update
    set community_name     = excluded.community_name,
        description        = excluded.description,
        welcome_message    = excluded.welcome_message,
        default_channel_id = excluded.default_channel_id,
        updated_at         = now(),
        updated_by         = auth.uid();

  insert into public.community_channel_events (channel_id, actor_id, action, detail)
  values (p_default_channel_id, auth.uid(),
          case when coalesce(v_before->>'default_channel_id', '')
                    is distinct from coalesce(p_default_channel_id::text, '')
               then 'default_channel' else 'settings_update' end,
          jsonb_build_object('before', v_before,
                             'after', (select to_jsonb(s) from public.community_settings s where s.id)));

  return (select to_jsonb(s) from public.community_settings s where s.id);
end;
$setg$;

create or replace function public.admin_save_channel_category(
  p_id uuid, p_space_id uuid, p_name text, p_status text default 'active')
returns uuid
language plpgsql security definer set search_path = public
as $cat$
declare v_id uuid; v_before jsonb; v_pos int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  if coalesce(btrim(p_name), '') = '' then
    perform public.app_error('CATEGORY_NOT_FOUND', 'Give the category a name.', 422, null);
  end if;

  if p_id is null then
    if not exists (select 1 from public.community_spaces where id = p_space_id) then
      perform public.app_error('CATEGORY_NOT_FOUND', 'That space does not exist.', 404, null);
    end if;
    select coalesce(max(position), -1) + 1 into v_pos
      from public.community_channel_categories where space_id = p_space_id;
    insert into public.community_channel_categories
      (space_id, name, position, created_by, updated_by)
    values (p_space_id, btrim(p_name), v_pos, auth.uid(), auth.uid())
    returning id into v_id;
    insert into public.community_channel_events (category_id, actor_id, action, detail)
    values (v_id, auth.uid(), 'category_create',
            jsonb_build_object('space_id', p_space_id, 'name', btrim(p_name)));
  else
    select to_jsonb(c) into v_before
      from public.community_channel_categories c where c.id = p_id;
    if v_before is null then
      perform public.app_error('CATEGORY_NOT_FOUND', 'That category does not exist.', 404, null);
    end if;
    -- Archiving a category hides its rooms from the rail. Refuse while it still
    -- holds active channels rather than orphaning them out of view.
    if p_status = 'archived'
       and exists (select 1 from public.community_channels
                    where category_id = p_id and status = 'active') then
      perform public.app_error('CATEGORY_NOT_EMPTY',
        'Move or archive this category''s channels first.', 409, null);
    end if;
    update public.community_channel_categories
       set name       = btrim(p_name),
           status     = coalesce(nullif(p_status, ''), status),
           updated_by = auth.uid()
     where id = p_id;
    v_id := p_id;
    insert into public.community_channel_events (category_id, actor_id, action, detail)
    values (v_id, auth.uid(),
            case when coalesce(v_before->>'status', 'active')
                      is distinct from coalesce(nullif(p_status, ''), v_before->>'status')
                 then (case when p_status = 'archived' then 'category_archive'
                            else 'category_restore' end)
                 else 'category_update' end,
            jsonb_build_object('before', v_before, 'name', btrim(p_name), 'status', p_status));
  end if;
  return v_id;
end;
$cat$;

create or replace function public.admin_move_channel_category(p_id uuid, p_delta int)
returns void
language plpgsql security definer set search_path = public
as $mcat$
declare v_space uuid; v_pos int; v_other uuid; v_other_pos int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  select space_id, position into v_space, v_pos
    from public.community_channel_categories where id = p_id;
  if v_space is null then
    perform public.app_error('CATEGORY_NOT_FOUND', 'That category does not exist.', 404, null);
  end if;

  if coalesce(p_delta, 1) < 0 then
    select id, position into v_other, v_other_pos
      from public.community_channel_categories
     where space_id = v_space and position < v_pos
     order by position desc limit 1;
  else
    select id, position into v_other, v_other_pos
      from public.community_channel_categories
     where space_id = v_space and position > v_pos
     order by position asc limit 1;
  end if;
  -- Already at the end: a no-op, not an error. The button is simply spent.
  if v_other is null then return; end if;

  update public.community_channel_categories set position = v_other_pos where id = p_id;
  update public.community_channel_categories set position = v_pos       where id = v_other;
  insert into public.community_channel_events (category_id, actor_id, action, detail)
  values (p_id, auth.uid(), 'category_move',
          jsonb_build_object('from', v_pos, 'to', v_other_pos));
end;
$mcat$;

create or replace function public.admin_save_community_channel(
  p_id                 uuid,
  p_space_id           uuid,
  p_category_id        uuid,
  p_slug               text,
  p_name               text,
  p_topic              text,
  p_kind               text,
  p_audience_mode      text,
  p_plan_keys          text[],
  p_batch_ids          uuid[],
  p_member_posting     boolean,
  p_member_comments    boolean,
  p_member_reactions   boolean,
  p_member_attachments boolean)
returns uuid
language plpgsql security definer set search_path = public
as $chan$
declare
  v_id      uuid;
  v_before  jsonb;
  v_slug    text;
  v_pos     int;
  v_space   uuid;
  v_kind    text;
  v_posting boolean;
  v_comments boolean;
  v_mode    text;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  if p_audience_mode is not null
     and p_audience_mode not in ('space','plans','batches','plans_and_batches','admins_only') then
    perform public.app_error('CHANNEL_AUDIENCE_EMPTY', 'Pick a valid audience.', 422, null);
  end if;
  if p_kind is not null and p_kind not in ('text','announcement') then
    perform public.app_error('CHANNEL_NOT_FOUND',
      'A channel is either a text channel or an announcement channel.', 422, null);
  end if;
  -- ★ v_mode is resolved INSIDE each branch below. It must not default to
  --   'space' on an update: every other column here preserves its existing value
  --   when the argument is null, and making audience_mode the one exception
  --   means a partial update (a script, a curl, a future endpoint that stops
  --   sending the field) silently converts a private room to space-wide AND
  --   wipes its mapping. The create path still defaults to 'space'.

  if p_id is null then
    v_space := p_space_id;
    if not exists (select 1 from public.community_spaces where id = v_space) then
      perform public.app_error('CHANNEL_NOT_FOUND', 'That space does not exist.', 404, null);
    end if;
    if not exists (select 1 from public.community_channel_categories
                    where id = p_category_id and space_id = v_space) then
      perform public.app_error('CATEGORY_NOT_FOUND',
        'Pick a category in the same space.', 404, null);
    end if;

    v_slug := btrim(left(regexp_replace(
                lower(btrim(coalesce(nullif(btrim(p_slug), ''), p_name, ''))),
                '[^a-z0-9]+', '-', 'g'), 48), '-');
    if v_slug !~ '^[a-z0-9][a-z0-9-]{0,47}$' then
      perform public.app_error('CHANNEL_SLUG_TAKEN',
        'Use letters and numbers in the channel name.', 422, null);
    end if;
    if exists (select 1 from public.community_channels
                where space_id = v_space and slug = v_slug) then
      perform public.app_error('CHANNEL_SLUG_TAKEN',
        'A channel with that address already exists here.', 409,
        jsonb_build_object('slug', v_slug));
    end if;

    v_mode    := coalesce(p_audience_mode, 'space');
    -- Fail closed, loudly. A mapping-backed mode with an empty mapping would be
    -- invisible to every member, which is almost never what the admin meant.
    if v_mode in ('plans','plans_and_batches') and coalesce(array_length(p_plan_keys, 1), 0) = 0 then
      perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
        'Choose at least one plan for this channel.', 422, null);
    end if;
    if v_mode in ('batches','plans_and_batches') and coalesce(array_length(p_batch_ids, 1), 0) = 0 then
      perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
        'Choose at least one batch for this channel.', 422, null);
    end if;
    v_kind    := coalesce(p_kind, 'text');
    v_posting := coalesce(p_member_posting, true) and v_kind = 'text';
    -- An announcement channel seals BOTH posting and replies (the CHECK pins
    -- posting; without this an admin unlock would reopen replies in a room the
    -- constraint was meant to close).
    v_comments := coalesce(p_member_comments, true) and v_kind = 'text';

    select coalesce(max(position), -1) + 1 into v_pos
      from public.community_channels where category_id = p_category_id;

    insert into public.community_channels
      (space_id, category_id, slug, name, topic, kind, audience_mode,
       member_posting, member_comments, member_reactions, member_attachments,
       position, created_by, updated_by)
    values (v_space, p_category_id, v_slug,
            coalesce(nullif(btrim(p_name), ''), v_slug),
            nullif(btrim(coalesce(p_topic, '')), ''),
            v_kind, v_mode, v_posting,
            v_comments,
            coalesce(p_member_reactions, true),
            coalesce(p_member_attachments, true),
            v_pos, auth.uid(), auth.uid())
    returning id into v_id;

    insert into public.community_channel_events (channel_id, actor_id, action, detail)
    values (v_id, auth.uid(), 'channel_create',
            jsonb_build_object('space_id', v_space, 'slug', v_slug,
                               'audience_mode', v_mode, 'kind', v_kind));
  else
    select to_jsonb(c) into v_before from public.community_channels c where c.id = p_id;
    if v_before is null then
      perform public.app_error('CHANNEL_NOT_FOUND', 'That channel does not exist.', 404, null);
    end if;
    v_space := (v_before->>'space_id')::uuid;
    if p_category_id is not null
       and not exists (select 1 from public.community_channel_categories
                        where id = p_category_id and space_id = v_space) then
      perform public.app_error('CATEGORY_NOT_FOUND',
        'Pick a category in the same space.', 404, null);
    end if;

    v_mode    := coalesce(p_audience_mode, v_before->>'audience_mode', 'space');
    -- Fail closed, loudly. A mapping-backed mode with an empty mapping would be
    -- invisible to every member, which is almost never what the admin meant.
    if v_mode in ('plans','plans_and_batches') and coalesce(array_length(p_plan_keys, 1), 0) = 0 then
      perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
        'Choose at least one plan for this channel.', 422, null);
    end if;
    if v_mode in ('batches','plans_and_batches') and coalesce(array_length(p_batch_ids, 1), 0) = 0 then
      perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
        'Choose at least one batch for this channel.', 422, null);
    end if;
    v_kind    := coalesce(p_kind, v_before->>'kind');
    v_posting := coalesce(p_member_posting, (v_before->>'member_posting')::boolean)
                 and v_kind = 'text';
    v_comments := coalesce(p_member_comments, (v_before->>'member_comments')::boolean)
                  and v_kind = 'text';

    -- ★ slug is a PERMALINK: ?channel=<slug> deep links and the stored
    --   community:lastChannel preference resolve through it, and
    --   pickInitialChannel() falls back SILENTLY on an unknown slug - so a
    --   rename that moved it would look like data loss. Renaming changes `name`.
    update public.community_channels
       set category_id        = coalesce(p_category_id, category_id),
           name               = coalesce(nullif(btrim(p_name), ''), name),
           topic              = nullif(btrim(coalesce(p_topic, '')), ''),
           kind               = v_kind,
           audience_mode      = v_mode,
           member_posting     = v_posting,
           member_comments    = v_comments,
           member_reactions   = coalesce(p_member_reactions, member_reactions),
           member_attachments = coalesce(p_member_attachments, member_attachments),
           updated_by         = auth.uid()
     where id = p_id;
    v_id := p_id;

    insert into public.community_channel_events (channel_id, actor_id, action, detail)
    values (v_id, auth.uid(),
            case when (v_before->>'audience_mode') is distinct from v_mode
                 then 'channel_privacy' else 'channel_update' end,
            jsonb_build_object('before', v_before - 'created_at' - 'updated_at',
                               'audience_mode', v_mode, 'kind', v_kind));
  end if;

  -- Audience mappings are replaced wholesale, and ONLY here. Skipped entirely
  -- when the caller did not address the audience, so a partial update cannot
  -- destroy a mapping it never mentioned.
  if p_audience_mode is not null or p_id is null then
  delete from public.community_channel_plans   where channel_id = v_id;
  delete from public.community_channel_batches where channel_id = v_id;
  if v_mode in ('plans','plans_and_batches') then
    insert into public.community_channel_plans (channel_id, plan_key)
    select v_id, k from unnest(coalesce(p_plan_keys, '{}'::text[])) k
     where exists (select 1 from public.enrollment_plans ep where ep.key = k)
    on conflict do nothing;
  end if;
  if v_mode in ('batches','plans_and_batches') then
    insert into public.community_channel_batches (channel_id, batch_id)
    select v_id, b from unnest(coalesce(p_batch_ids, '{}'::uuid[])) b
     where exists (select 1 from public.batches bb where bb.id = b)
    on conflict do nothing;
  end if;

  -- The length checks above count ARGUMENTS; these count ROWS. A list of keys
  -- that are all typos or retired plans passes the first and fails the second,
  -- which would otherwise ship a channel nobody can see.
  if v_mode in ('plans','plans_and_batches')
     and not exists (select 1 from public.community_channel_plans where channel_id = v_id) then
    perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
      'None of those plans exist any more. Pick at least one current plan.', 422, null);
  end if;
  if v_mode in ('batches','plans_and_batches')
     and not exists (select 1 from public.community_channel_batches where channel_id = v_id) then
    perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
      'None of those batches exist any more. Pick at least one current batch.', 422, null);
  end if;
  end if;

  insert into public.community_channel_events (channel_id, actor_id, action, detail)
  values (v_id, auth.uid(), 'channel_permissions',
          jsonb_build_object('member_posting', v_posting,
                             'member_comments', coalesce(p_member_comments, true),
                             'member_reactions', coalesce(p_member_reactions, true),
                             'member_attachments', coalesce(p_member_attachments, true),
                             'plans', coalesce(p_plan_keys, '{}'::text[]),
                             'batches', coalesce(p_batch_ids, '{}'::uuid[])));
  return v_id;
end;
$chan$;

create or replace function public.admin_move_community_channel(p_id uuid, p_delta int)
returns void
language plpgsql security definer set search_path = public
as $mchan$
declare v_cat uuid; v_pos int; v_other uuid; v_other_pos int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  select category_id, position into v_cat, v_pos
    from public.community_channels where id = p_id;
  if v_cat is null then
    perform public.app_error('CHANNEL_NOT_FOUND', 'That channel does not exist.', 404, null);
  end if;

  if coalesce(p_delta, 1) < 0 then
    select id, position into v_other, v_other_pos
      from public.community_channels
     where category_id = v_cat and position < v_pos
     order by position desc limit 1;
  else
    select id, position into v_other, v_other_pos
      from public.community_channels
     where category_id = v_cat and position > v_pos
     order by position asc limit 1;
  end if;
  if v_other is null then return; end if;

  update public.community_channels set position = v_other_pos where id = p_id;
  update public.community_channels set position = v_pos       where id = v_other;
  insert into public.community_channel_events (channel_id, actor_id, action, detail)
  values (p_id, auth.uid(), 'channel_move',
          jsonb_build_object('from', v_pos, 'to', v_other_pos));
end;
$mchan$;

create or replace function public.admin_set_community_channel_status(
  p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public
as $stat$
declare
  v_before  text;
  v_space   uuid;
  v_was_def boolean;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  if p_status not in ('active','archived') then
    perform public.app_error('CHANNEL_ARCHIVED', 'Status must be active or archived.', 422, null);
  end if;
  select status, space_id, is_default into v_before, v_space, v_was_def
    from public.community_channels where id = p_id;
  if v_before is null then
    perform public.app_error('CHANNEL_NOT_FOUND', 'That channel does not exist.', 404, null);
  end if;
  -- Archiving the landing channel would drop every new member onto nothing.
  if p_status = 'archived'
     and exists (select 1 from public.community_settings where default_channel_id = p_id) then
    perform public.app_error('CHANNEL_ARCHIVED',
      'Choose a different landing channel before archiving this one.', 409, null);
  end if;

  update public.community_channels ch
     set status     = p_status,
         -- An archived room can no longer be a space default; the guard's
         -- fallback chain then resolves to the community-wide landing channel.
         -- On restore it reclaims the role only if the space has no default,
         -- because the one-default-per-space unique index would refuse a second.
         is_default = case
                        when p_status = 'archived' then false
                        when ch.kind = 'text' and not exists (
                          select 1 from public.community_channels o
                           where o.space_id = ch.space_id and o.is_default and o.id <> ch.id)
                          then true
                        else ch.is_default
                      end,
         updated_by = auth.uid()
   where ch.id = p_id;

  -- ★ Never leave a space without a default room. The pre-#40 insert path
  --   resolves through it, and a space with none sends those posts hunting for
  --   the community-wide default (see community_posts_guard). Promote the next
  --   active text channel instead of stranding the space.
  if p_status = 'archived' and coalesce(v_was_def, false) then
    update public.community_channels
       set is_default = true
     where id = (select x.id from public.community_channels x
                  where x.space_id = v_space and x.status = 'active'
                    and x.kind = 'text' and x.id <> p_id
                  order by x.position, x.name limit 1);
  end if;

  insert into public.community_channel_events (channel_id, actor_id, action, detail)
  values (p_id, auth.uid(),
          case when p_status = 'archived' then 'channel_archive' else 'channel_restore' end,
          jsonb_build_object('from', v_before, 'to', p_status));
end;
$stat$;

-- Who gains and who loses if this audience changes? Powers the confirmation the
-- admin sees BEFORE saving a privacy change.
create or replace function public.admin_channel_privacy_preview(
  p_channel_id uuid, p_audience_mode text, p_plan_keys text[], p_batch_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public
as $prev$
declare
  v_space    uuid;
  v_current  uuid[];
  v_proposed uuid[];
  v_mode     text := coalesce(p_audience_mode, 'space');
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'Admins only.', 403, null);
  end if;
  select space_id into v_space from public.community_channels where id = p_channel_id;
  if v_space is null then
    perform public.app_error('CHANNEL_NOT_FOUND', 'That channel does not exist.', 404, null);
  end if;

  -- Admin-only and bounded by the member roster, so the per-candidate calls here
  -- are acceptable; nothing on a member code path does this.
  select coalesce(array_agg(t.u), '{}') into v_current
    from (select p.id as u from public.profiles p
           where not coalesce(p.is_admin, false)
             and p_channel_id in (select public.user_community_channel_ids(p.id))) t;

  select coalesce(array_agg(t.u), '{}') into v_proposed
    from (
      select p.id as u
        from public.profiles p
        left join lateral (
          select s.plan_key from public.subscriptions s
           where s.user_id = p.id and s.status = 'active'
             and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
           order by s.created_at desc limit 1) live on true
       where not coalesce(p.is_admin, false)
         and v_space in (select public.user_community_space_ids(p.id))
         and case v_mode
               when 'space'       then true
               when 'admins_only' then false
               when 'plans'   then live.plan_key = any(coalesce(p_plan_keys, '{}'::text[]))
               when 'batches' then exists (select 1 from public.user_entitled_batches(p.id) eb
                                            where eb.batch_id = any(coalesce(p_batch_ids, '{}'::uuid[])))
               when 'plans_and_batches' then
                 live.plan_key = any(coalesce(p_plan_keys, '{}'::text[]))
                 and exists (select 1 from public.user_entitled_batches(p.id) eb
                              where eb.batch_id = any(coalesce(p_batch_ids, '{}'::uuid[])))
               else false
             end) t;

  return jsonb_build_object(
    'current',     coalesce(array_length(v_current, 1), 0),
    'proposed',    coalesce(array_length(v_proposed, 1), 0),
    'gaining',     (select count(*) from unnest(v_proposed) x where not (x = any(v_current))),
    'losing',      (select count(*) from unnest(v_current)  x where not (x = any(v_proposed))),
    'has_content', exists (select 1 from public.community_posts
                            where channel_id = p_channel_id and status = 'active'));
end;
$prev$;

-- == 25) Indexed search ======================================================
-- Replaces an unindexed ilike '%...%' OR-scan. That was survivable per-space; it
-- would not be once "search all accessible channels" exists.
alter table public.community_posts
  add column if not exists search_tsv tsvector
  generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) stored;

create index if not exists community_posts_search_idx
  on public.community_posts using gin (search_tsv);

create or replace function public.search_community_posts(
  p_query text,
  p_channel_id uuid default null,
  p_scope text default 'channel',
  p_limit int default 20,
  p_offset int default 0)
returns table (
  id uuid, channel_id uuid, space_id uuid, author_id uuid, author_name text,
  author_avatar_url text, title text, body text, tag_slug text, status text,
  pinned boolean, comments_locked boolean, comment_count int,
  created_at timestamptz, updated_at timestamptz, last_activity_at timestamptz)
language sql stable set search_path = public
as $srch$
  -- SECURITY INVOKER on purpose: community_posts_read is the authorization, so
  -- 'all accessible channels' can never widen into 'all channels'.
  select p.id, p.channel_id, p.space_id, p.author_id, p.author_name,
         p.author_avatar_url, p.title, p.body, p.tag_slug, p.status,
         p.pinned, p.comments_locked, p.comment_count,
         p.created_at, p.updated_at, p.last_activity_at
    from public.community_posts p
   where p.status = 'active'
     and (coalesce(p_scope, 'channel') = 'all' or p.channel_id = p_channel_id)
     and char_length(btrim(coalesce(p_query, ''))) >= 2
     and p.search_tsv @@ websearch_to_tsquery('english', btrim(p_query))
   order by p.pinned desc, p.last_activity_at desc, p.id desc
   limit greatest(1, least(coalesce(p_limit, 20), 50))
  offset greatest(0, coalesce(p_offset, 0));
$srch$;

-- == 26) Indexes =============================================================
create index if not exists community_channels_space_idx
  on public.community_channels (space_id, status, position);
create index if not exists community_channels_category_idx
  on public.community_channels (category_id, position);
create index if not exists community_channel_categories_space_idx
  on public.community_channel_categories (space_id, position);
-- Both directions: channel -> audience (the PK covers it) and audience -> channel.
create index if not exists community_channel_plans_plan_idx
  on public.community_channel_plans (plan_key, channel_id);
create index if not exists community_channel_batches_batch_idx
  on public.community_channel_batches (batch_id, channel_id);
create index if not exists community_posts_channel_feed_idx
  on public.community_posts (channel_id, pinned desc, last_activity_at desc);
create index if not exists community_posts_channel_unread_idx
  on public.community_posts (channel_id, created_at desc) where status = 'active';
create index if not exists community_comments_channel_idx
  on public.community_comments (channel_id);
create index if not exists community_notifications_channel_idx
  on public.community_notifications (channel_id);
create index if not exists community_channel_reads_channel_idx
  on public.community_channel_reads (channel_id);
create index if not exists community_channel_events_channel_idx
  on public.community_channel_events (channel_id, created_at desc);

-- == 27) Error catalog =======================================================
-- Every existing code is kept; src/lib/appErrors.js mirrors this list by name.
create or replace function public.app_error_catalog()
returns table (code text, http int, summary text)
language sql immutable parallel safe set search_path = public
as $cat$
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
    ('COMMENT_PERMISSION_DENIED',    403, 'Replies are off in this channel.'),
    ('ASSIGNMENT_CLOSED',            409, 'Past the due date, or the assignment is unpublished.'),
    ('SUBMISSION_LOCKED',            409, 'The submission is handed in or graded; edits refused.'),
    ('COURSE_HAS_SUBMISSIONS',       409, 'The course has graded assignment work and cannot be deleted.'),
    ('BATCH_PAST',                   409, 'The batch period has elapsed in its own timezone; it is read-only.'),
    ('BATCH_CODE_TAKEN',             409, 'Another batch already uses that month code.'),
    ('BATCH_CODE_REORDER',           409, 'The new code would move the batch past a sibling and reorder members'' runs.'),
    ('BATCH_PERIOD_PAST',            422, 'The requested period has already ended; a batch cannot be edited into the past.'),
    ('BATCH_PERIOD_INVALID',         422, 'The end date falls before the start date, or a date is missing.'),
    ('BATCH_TIMEZONE_INVALID',       422, 'Not a timezone Postgres recognises (see pg_timezone_names).'),
    ('BATCH_CAPACITY_BELOW_OCCUPANCY',409,'The new capacity is below the seats already sold in that segment.'),
    -- #40, community channels
    ('CHANNEL_NOT_FOUND',            404, 'The channel does not exist, or is not available to you.'),
    ('CHANNEL_SLUG_TAKEN',           409, 'Another channel in this space already uses that address.'),
    ('CHANNEL_AUDIENCE_EMPTY',       422, 'The audience needs at least one plan or batch, or nobody could see it.'),
    ('CHANNEL_ARCHIVED',             409, 'The channel is archived and accepts no new content.'),
    ('CATEGORY_NOT_FOUND',           404, 'The channel category does not exist.'),
    ('CATEGORY_NOT_EMPTY',           409, 'The category still holds active channels.')
  ) as t(code, http, summary);
$cat$;

-- == 28) Grants ==============================================================
-- The parameterised user_* forms stay revoked; only the my_* wrappers are callable.
revoke all on function public.user_community_channel_ids(uuid)          from public, anon, authenticated;
revoke all on function public.user_community_channel_capabilities(uuid) from public, anon, authenticated;

grant execute on function public.my_community_channel_ids()                        to authenticated;
grant execute on function public.my_community_channel_capabilities()               to authenticated;
grant execute on function public.my_community_sidebar()                            to authenticated;
grant execute on function public.community_channel_write_denial(uuid, text)        to authenticated;
grant execute on function public.mark_community_channel_read(uuid)                 to authenticated;
grant execute on function public.search_community_posts(text, uuid, text, int, int) to authenticated;
grant execute on function public.search_community_members(text, uuid, uuid)        to authenticated;
grant execute on function public.community_category_counts(uuid, uuid)             to authenticated;
grant execute on function public.app_error_catalog()                               to authenticated;

-- Admin RPCs are granted to `authenticated` and guard is_admin() internally, the
-- same shape as admin_update_batch() / admin_finalize_enrollment().
grant execute on function public.admin_community_config()                              to authenticated;
grant execute on function public.admin_save_community_settings(text, text, text, uuid) to authenticated;
grant execute on function public.admin_save_channel_category(uuid, uuid, text, text)   to authenticated;
grant execute on function public.admin_move_channel_category(uuid, int)                to authenticated;
grant execute on function public.admin_save_community_channel(
  uuid, uuid, uuid, text, text, text, text, text, text[], uuid[],
  boolean, boolean, boolean, boolean)                                                  to authenticated;
grant execute on function public.admin_move_community_channel(uuid, int)               to authenticated;
grant execute on function public.admin_set_community_channel_status(uuid, text)        to authenticated;
grant execute on function public.admin_channel_privacy_preview(uuid, text, text[], uuid[]) to authenticated;

-- #30's convention: Supabase grants EXECUTE to PUBLIC (hence anon) on every new
-- function. None of these leaks today - each fails closed on a null auth.uid() -
-- but leaving them reachable unauthenticated is attack surface, and the two
-- DROP+CREATEd functions below would otherwise silently lose #32/#33's revokes.
revoke all on function public.community_channel_write_denial(uuid, text)         from public, anon;
revoke all on function public.mark_community_channel_read(uuid)                  from public, anon;
revoke all on function public.search_community_posts(text, uuid, text, int, int) from public, anon;
revoke all on function public.search_community_members(text, uuid, uuid)         from public, anon;
revoke all on function public.community_category_counts(uuid, uuid)              from public, anon;
revoke all on function public.admin_community_config()                           from public, anon;
revoke all on function public.admin_save_community_settings(text, text, text, uuid) from public, anon;
revoke all on function public.admin_save_channel_category(uuid, uuid, text, text) from public, anon;
revoke all on function public.admin_move_channel_category(uuid, int)             from public, anon;
revoke all on function public.admin_save_community_channel(
  uuid, uuid, uuid, text, text, text, text, text, text[], uuid[],
  boolean, boolean, boolean, boolean)                                            from public, anon;
revoke all on function public.admin_move_community_channel(uuid, int)            from public, anon;
revoke all on function public.admin_set_community_channel_status(uuid, text)     from public, anon;
revoke all on function public.admin_channel_privacy_preview(uuid, text, text[], uuid[]) from public, anon;
revoke all on function public.my_community_channel_ids()          from public, anon;
revoke all on function public.my_community_channel_capabilities() from public, anon;
revoke all on function public.my_community_sidebar()              from public, anon;

-- The #36 space-level diagnostic reads community_spaces.member_posting, which
-- this file flips to true - it would now report allowed=true for General while
-- the CHANNEL refuses the write. community_channel_write_denial() replaces it.
drop function if exists public.community_write_denial(uuid, text);

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-18-community-channels.sql', null,
  'community channels (#40): community_channel_categories/channels/plans/batches/reads/events '
  '+ community_settings; channel_id on posts/comments/notifications; '
  'user_community_channel_ids + user_community_channel_capabilities + my_community_sidebar '
  '+ community_channel_write_denial + mark_community_channel_read; channel-scoped content RLS, '
  'storage, notify triggers and mention search; indexed FTS via search_community_posts; '
  'admin editor RPCs with a community_channel_events audit trail. '
  'RETIRES D2 as a space-wide rule: drops community_spaces_general_announcement_only and '
  'enables can_post_in_general/can_comment_in_general for all three plans - #announcements '
  'stays admin-only because it is kind=announcement. Attachment rights unchanged.')
on conflict (filename) do nothing;

-- =============================================================================
-- AFTER RUNNING - verify
-- =============================================================================
-- select count(*) from public.community_channels;                 -- 6 General + 2 per cohort
-- select count(*) from public.community_posts where channel_id is null;  -- 0
-- select conname from pg_constraint
--  where conname = 'community_spaces_general_announcement_only';  -- 0 rows (retired)
-- select key, can_post_in_general, can_upload_attachments from public.enrollment_plans order by key;
--   -- all three true; attachments still f / f / t
-- select slug, kind, member_posting, member_comments from public.community_channels
--  where space_id = (select id from public.community_spaces where kind = 'general') order by position;
--   -- announcements: announcement / f / f
-- select * from public.my_community_sidebar();                    -- as a signed-in member
-- =============================================================================
