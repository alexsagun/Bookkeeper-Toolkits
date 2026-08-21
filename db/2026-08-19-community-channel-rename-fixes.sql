-- #41 — Make a rename-only channel save actually safe.
--
-- WHY THIS FILE EXISTS
-- #40 shipped `admin_save_community_channel()` as the single writer for channels,
-- and the admin rail's new "Rename channels" mode calls it with ONLY p_id + p_name
-- (every other argument null, meaning "leave this alone"). Three defects made that
-- partial call unsafe, and all three are in the UPDATE branch:
--
--   1. topic was WIPED. `topic = nullif(btrim(coalesce(p_topic,'')),'')` turns a null
--      argument into NULL rather than leaving the column alone — so renaming a
--      channel silently deleted its description for every member. Every other column
--      in that SET list is coalesce-preserved; topic was the lone exception.
--
--   2. Renaming a plans/batches channel FAILED OUTRIGHT. The fail-closed
--      "did you pick an audience?" checks count ARGUMENTS, and a rename sends
--      p_plan_keys => null, so array_length is null, so the check fired and aborted
--      with "Choose at least one plan for this channel." — for a one-word label
--      change. #40 already guards the mapping WRITE with
--      `if p_audience_mode is not null or p_id is null`; these checks simply sat
--      outside it, so the guard's stated intent was only half implemented.
--
--   3. The audit row LIED. `channel_permissions` was emitted unconditionally and
--      built from the RAW arguments, so renaming #announcements recorded
--      "member_comments: true" (it is false) and renaming a VIP room recorded
--      "plans: []". An audit ledger that misreports permission changes is worse
--      than none — it would point an incident investigation at the wrong admin.
--
-- ★ NEW CONTRACT FOR p_topic: null now means "leave the topic alone" and '' means
--   "clear it". The full editor must therefore send '' (not null) to erase a topic;
--   the matching client change ships in the same build.
--
-- Additive and idempotent: one CREATE OR REPLACE of one function. No table, policy,
-- grant, index or data change. Nothing is deleted.
--
-- Depends on: #40 (the function it replaces).
--
-- Run: Supabase dashboard -> SQL Editor -> paste this whole file -> Run.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1) Preflight
-- ═════════════════════════════════════════════════════════════════════════════
do $pre$
begin
  if to_regprocedure('public.admin_save_community_channel('
        || 'uuid,uuid,uuid,text,text,text,text,text,text[],uuid[],'
        || 'boolean,boolean,boolean,boolean)') is null then
    raise exception '#41 needs #40 - run 2026-08-18-community-channels.sql first';
  end if;
  -- Without this the tail apply-log insert would abort the whole file.
  if to_regclass('public.schema_migrations') is null then
    raise exception '#41 needs #31 - run 2026-07-26-schema-migrations-log.sql first';
  end if;
end
$pre$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2) The corrected writer
-- ═════════════════════════════════════════════════════════════════════════════
-- Reproduced from #40 verbatim except for the three fixes, each marked "#41".
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
  v_id       uuid;
  v_before   jsonb;
  v_slug     text;
  v_pos      int;
  v_space    uuid;
  v_kind     text;
  v_posting  boolean;
  v_comments boolean;
  v_mode     text;
  v_after    jsonb;   -- #41: audit from the RESOLVED row, never the raw arguments
  v_touched  boolean; -- #41: did this call actually address permissions?
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

  -- #41: one predicate, used for both the audience checks and the audit row.
  -- A call that names no audience and no permission flag is a rename (or a move),
  -- and must not be judged by - or logged as - a permissions change.
  v_touched := p_id is null
               or p_audience_mode   is not null
               or p_member_posting  is not null
               or p_member_comments is not null
               or p_member_reactions is not null
               or p_member_attachments is not null;

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
    -- #41 FIX 2: these count ARGUMENTS, so they may only run when the caller
    -- actually addressed the audience. A rename sends p_plan_keys => null, which
    -- previously tripped them and made plan/batch-scoped channels un-renameable.
    -- The mapping WRITE below is guarded by the same predicate; the ROW-count
    -- checks that follow it are what catch a genuinely empty audience.
    if p_audience_mode is not null then
      if v_mode in ('plans','plans_and_batches') and coalesce(array_length(p_plan_keys, 1), 0) = 0 then
        perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
          'Choose at least one plan for this channel.', 422, null);
      end if;
      if v_mode in ('batches','plans_and_batches') and coalesce(array_length(p_batch_ids, 1), 0) = 0 then
        perform public.app_error('CHANNEL_AUDIENCE_EMPTY',
          'Choose at least one batch for this channel.', 422, null);
      end if;
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
           -- #41 FIX 1: null = leave alone, '' = clear. The old expression
           -- collapsed both to NULL, so every rename erased the description.
           topic              = case when p_topic is null then topic
                                     else nullif(btrim(p_topic), '') end,
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

  -- #41 FIX 3: log what the row NOW SAYS, and only when this call actually
  -- addressed permissions. The previous version emitted this on every save from
  -- the raw arguments, so a rename recorded "member_comments: true" for a channel
  -- whose replies are off, and "plans: []" for a VIP-only room - an audit trail
  -- that would misdirect the investigation it exists to serve.
  if v_touched then
    select to_jsonb(c) into v_after from public.community_channels c where c.id = v_id;
    insert into public.community_channel_events (channel_id, actor_id, action, detail)
    values (v_id, auth.uid(), 'channel_permissions',
            jsonb_build_object(
              'member_posting',     (v_after->>'member_posting')::boolean,
              'member_comments',    (v_after->>'member_comments')::boolean,
              'member_reactions',   (v_after->>'member_reactions')::boolean,
              'member_attachments', (v_after->>'member_attachments')::boolean,
              'audience_mode',      v_after->>'audience_mode',
              'plans',   coalesce((select array_agg(plan_key) from public.community_channel_plans
                                    where channel_id = v_id), '{}'::text[]),
              'batches', coalesce((select array_agg(batch_id) from public.community_channel_batches
                                    where channel_id = v_id), '{}'::uuid[])));
  end if;
  return v_id;
end;
$chan$;

-- The function is DROP-free (CREATE OR REPLACE keeps privileges), but re-assert
-- the #40 grant posture so a future reader does not have to go looking.
revoke all on function public.admin_save_community_channel(
  uuid, uuid, uuid, text, text, text, text, text, text[], uuid[],
  boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_save_community_channel(
  uuid, uuid, uuid, text, text, text, text, text, text[], uuid[],
  boolean, boolean, boolean, boolean) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3) Index corrections found by the #41 performance review
-- ═════════════════════════════════════════════════════════════════════════════
-- Both are drop+create of indexes #40 created. Non-CONCURRENT on purpose: this
-- repo never uses CONCURRENTLY (it cannot run inside a transaction, and every
-- migration here is applied as one transactional batch). community_posts is small
-- today; on a large restore, build the CONCURRENTLY variants by hand instead --
-- the definitions are in the AFTER RUNNING block.

-- 3a) The sidebar's unread count filters `author_id <> auth.uid()`, but author_id
--     was not in the index, so each of the (bounded) 100 index entries per channel
--     required a heap fetch just to evaluate that filter. Carrying author_id in the
--     INCLUDE payload makes it an index-only scan. Measured on this database at
--     50k posts, this converts the plan from Index Scan to Index Only Scan.
--     ★ HONEST CAVEAT: an index-only scan only avoids heap fetches once the
--     VISIBILITY MAP is set, i.e. after autovacuum has processed the table. On a
--     freshly bulk-loaded table it is measurably SLOWER (measured here: 0.20ms ->
--     3.09ms, still 100 heap fetches, because every tuple needs a visibility
--     check). Production is autovacuumed, so this pays off there - but the win was
--     NOT demonstrated on synthetic data, and that is why analyze alone is not
--     enough. If you are restoring a large dump, VACUUM community_posts after.
drop index if exists public.community_posts_channel_unread_idx;
create index community_posts_channel_unread_idx
  on public.community_posts (channel_id, created_at desc)
  include (author_id)
  where status = 'active';

-- 3b) The feed always adds status (RLS pins status='active', and the client also
--     excludes 'deleted') and always tiebreaks on id desc. Neither was in the
--     index, so status was a heap filter and the id tiebreak forced an Incremental
--     Sort. Making it a partial index on the exact sort key removes both, and
--     shrinks the index by excluding hidden/deleted rows.
drop index if exists public.community_posts_channel_feed_idx;
create index community_posts_channel_feed_idx
  on public.community_posts (channel_id, pinned desc, last_activity_at desc, id desc)
  where status = 'active';

analyze public.community_posts;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-19-community-channel-rename-fixes.sql', null,
  'channel rename fixes (#41): a rename-only admin_save_community_channel() call no '
  'longer wipes the topic (null now means leave-alone, empty string means clear), no '
  'longer fails on plan/batch-scoped channels (the argument-count audience checks moved '
  'inside the audience guard), and the channel_permissions audit row is now written from '
  'the resolved row and only when permissions were actually addressed. '
  'Deploy the matching client build: the full editor must send p_topic = '''' to clear.')
on conflict (filename) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING
-- ═════════════════════════════════════════════════════════════════════════════
-- 1) The topic-preserving branch is in place:
--      select prosrc like '%when p_topic is null then topic%' as ok
--        from pg_proc where proname = 'admin_save_community_channel';
-- 2) A rename-only call preserves everything (run as an admin session):
--      select public.admin_save_community_channel(
--        '<channel-id>', null, null, null, 'New name', null, null, null,
--        null, null, null, null, null, null);
--      select name, topic, audience_mode, member_posting, member_comments
--        from public.community_channels where id = '<channel-id>';
-- 3) The audit row now matches reality:
--      select action, detail->>'member_comments', detail->'plans'
--        from public.community_channel_events
--       where channel_id = '<channel-id>' order by created_at desc limit 3;
