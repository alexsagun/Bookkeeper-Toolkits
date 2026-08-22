-- ─────────────────────────────────────────────────────────────────────────────
-- #43 — Code-review corrections to #40/#41, plus the enrollment-orphan cleanup.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS A DATED MIGRATION AND NOT AN EDIT TO #40/#41
--   `npm run db:audit` confirms both #40 and #41 are APPLIED in production
--   (project ifxcobxsjdjzlozagmls) and #42 is not. Editing an applied file
--   changes nothing in a database that already ran it, so every correction below
--   ships here. #42's own corrections are folded into #42 itself, because it has
--   not run anywhere yet.
--
-- WHAT THIS FIXES, in the order the sections appear.
--
--   1) SECURITY — community_reactions_own_delete lost every gate.
--      #33 scoped it (`is_approved() and is_enrolled()` + space), #36 replaced it
--      with a bare `user_id = auth.uid()`, and #40 re-scoped its two named
--      siblings (community_post_tags_own_delete, community_attachments_own_delete)
--      to the channel model but did not touch this one. So a member whose term
--      expired past grace, whose approval was revoked, or who was moved out of a
--      cohort could still DELETE their reactions inside a room they can no longer
--      read — decrementing a counter on a post in a private VIP space. That is
--      the same expired-member write gap #28 was written to close.
--
--   2) CORRECTNESS — community_media_delete made orphan cleanup impossible.
--      #40 rewrote it from #34's path test to an attachment-JOIN test, so an
--      object with no community_attachments row is undeletable by the member who
--      uploaded it. Both of CommunityComposer's cleanup paths delete exactly such
--      objects (the upload succeeded, then the post or attachment insert failed);
--      both call `.catch(() => {})`, so the refusal was silent and the private
--      community-media bucket accumulated unreachable files that admin
--      hard-delete cannot reach either, because it derives paths FROM attachment
--      rows. The uploader may now delete an object of their own that NO
--      attachment row references. Once a row points at it, #40's rule applies
--      unchanged.
--
--   3) CORRECTNESS — enrollment_receipts_delete blocked the client's own cleanup.
--      Same shape, different bucket. #14 made this admin-only for a good reason
--      (payment-evidence integrity: a student must not be able to delete proof
--      after submitting) and its header notes the client cleanup "becomes a
--      harmless no-op". #42 then made that no-op expensive: a failed submit now
--      strands FOUR files — receipt, resume, signature PNG, agreement PDF — and
--      three retries leave twelve, including three copies of a handwritten
--      signature, in a private bucket with nothing referencing them.
--      The narrowing preserves #14 exactly: an owner may delete their own object
--      only while NO enrollment_requests row references it. The moment a request
--      row points at a file it is permanently undeletable by the student.
--
--   4) CORRECTNESS — admin_save_channel_category silently un-archives.
--      `p_status text default 'active'` is the opposite of the null-means-leave-
--      alone contract #41 established for its sibling one function above. A
--      caller that OMITS the argument gets PostgREST's SQL default, and
--      `coalesce(nullif(p_status,''), status)` then writes 'active' over
--      'archived' plus a misleading `category_restore` audit row. The shipped
--      client is safe only because it explicitly passes null.
--
--   5) AUDIT — admin_save_community_channel's v_touched omits p_kind.
--      #41 gated the channel_permissions audit row on "did this call address
--      permissions", but left p_kind out of the predicate even though kind DRIVES
--      both flags (`v_posting := coalesce(...) and v_kind = 'text'`). So
--      converting a channel to or from an announcement room flipped posting and
--      replies while logging only a generic 'channel_update'. Since #40 dropped
--      the D2 CHECK, this ledger is the ONLY record of reopening a locked room.
--
--   6) PERFORMANCE — the community feed had no usable index.
--      #41 added `where status = 'active'` to community_posts_channel_feed_idx on
--      the premise that "RLS pins status='active', and the client also excludes
--      'deleted'". Neither implies the predicate. community_posts_read is a
--      three-branch OR whose FIRST branch is `is_admin()`, unrestricted on
--      status; a disjunction implies a predicate only if EVERY disjunct does. And
--      the client sends `status <> 'deleted'`, which admits 'hidden'. So
--      predicate_implied_by() fails and the planner cannot use the index for the
--      primary feed query — every page load, every "Load more" and every channel
--      switch became a sequential scan plus a full sort. #40's non-partial
--      version worked; #41 removed the only usable plan while adding the `id
--      desc` tiebreak that would have made it exact.
--      Dropping the predicate also restores a complete index on channel_id, which
--      the ON DELETE RESTRICT foreign key check needs — with both channel_id
--      indexes partial, deleting a channel sequentially scanned community_posts.
--
--   7) PERFORMANCE — `($1 is null or col = $1)` is not sargable.
--      community_category_counts runs on EVERY channel switch and
--      search_community_posts on every search. A parameter inside an OR cannot
--      become an index qual under a generic plan, so both degraded to scanning
--      every active post the caller may read and filtering afterwards. Branching
--      into static queries gives each one a real equality predicate — and makes
--      `status = 'active'` a plain AND qual, so the partial index genuinely is
--      implied there.
--      search_community_posts also gains p_tag_slug + p_unanswered so the client
--      can route IN-CHANNEL search through it. Until now the default scope still
--      ran `title.ilike.%q%,body.ilike.%q%`, meaning the GIN index #40 built for
--      exactly this was only ever reached by the opt-in "All channels" toggle.
--      The clamp rises 50 -> 100 to match the client's page size honestly.
--
--   8) PERFORMANCE — unbounded per-channel COUNT in admin_community_config.
--      Three correlated subqueries per channel, one of them an uncapped
--      `count(*)` feeding a cosmetic "· N discussions" badge — while
--      my_community_sidebar() 600 lines away caps the same shape at 100 and
--      explains why. Replaced with grouped joins computed once.
--
--   9) PERFORMANCE — the mention directory seq-scanned profiles per keystroke.
--      `full_name ilike '%q%'` is a leading-wildcard match and there is no
--      trigram index on that column, so every debounced keystroke scanned all of
--      profiles BEFORE the 60-row cap could bound anything. #25 added this exact
--      index for this exact reason and it did not survive.
--      ★ The per-candidate user_community_channel_ids() call is KEPT. Resolving
--        the channel's audience once and joining candidates straight to
--        subscriptions/batch_entitlements would be faster and would also put a
--        SECOND copy of the audience CASE and the space-membership rule in the
--        tree. An authorization rule is the last place to accept that kind of
--        drift, and the cap already bounds the call. Index the scan; keep the
--        seam.
--
--  10) PERFORMANCE — community_channel_reads(last_read_post_id) was unindexed,
--      so every admin hard-delete of a post sequentially scanned a table that
--      grows as members x channels to satisfy ON DELETE SET NULL.
--
-- ★ NOTHING HERE WIDENS ACCESS. Sections 1-3 tighten or hold; 4-5 correct an
--   admin writer and its audit trail; 6-10 are planner-visible only. No policy
--   gains a branch, no helper changes what it returns, and channels still NARROW
--   space membership rather than widening it.
--
-- Depends on: #40 + #41 (channels), #42 (the enrollment_requests file-path
-- columns section 3 tests), #35 (app_error), #31 (schema_migrations).
-- HOW TO RUN: Supabase → SQL Editor → Run. IDEMPOTENT. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- == 0) Preflight ============================================================
-- Guard on schema_migrations too: without it the tail insert aborts the file.
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-08-13-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.community_channels') is null then
    raise exception 'Run db/2026-08-18-community-channels.sql (#40) first.';
  end if;
  if to_regprocedure('public.admin_save_community_channel(uuid,uuid,uuid,text,text,text,text,text,text[],uuid[],boolean,boolean,boolean,boolean)') is null then
    raise exception 'Run db/2026-08-18-community-channels.sql (#40) first.';
  end if;
  if to_regprocedure('public.app_error(text,text,int,jsonb)') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) first.';
  end if;
  -- Section 3 references the #42 file-path columns by name.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'enrollment_requests'
       and column_name = 'agreement_pdf_path'
  ) then
    raise exception 'Run db/2026-08-20-enrollment-intake.sql (#42) first.';
  end if;
end
$pre$;

-- == 1) Reactions: restore the gate and the channel scope =====================
-- Mirrors community_post_tags_own_delete / community_attachments_own_delete,
-- which #40 already moved to this shape. Own-row only, as before — this ADDS the
-- approved+enrolled gate and the channel scope, and takes nothing away.
drop policy if exists community_reactions_own_delete on public.community_reactions;
create policy community_reactions_own_delete on public.community_reactions
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())
             and (
               (post_id is not null and exists (
                  select 1 from public.community_posts p
                   where p.id = post_id
                     and p.channel_id in (select public.my_community_channel_ids())))
               or (comment_id is not null and exists (
                  select 1 from public.community_comments cm
                   where cm.id = comment_id
                     and cm.channel_id in (select public.my_community_channel_ids())))
             )))
  );

comment on policy community_reactions_own_delete on public.community_reactions is
  '#43: own-row DELETE, but only while the member is still approved, still '
  'enrolled and can still open the room. #36 had reduced this to a bare '
  'user_id = auth.uid(), reopening the expired-member write gap #28 closed.';

-- == 2) community-media: let an uploader clear their own ORPHAN ===============
-- #40's rule is preserved for every object an attachment row references. The new
-- branch covers only the window between a successful upload and a failed insert,
-- which is precisely what CommunityComposer's cleanup targets.
drop policy if exists community_media_delete on storage.objects;
create policy community_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'community-media'
    and ((select public.is_admin())
         or ((select public.is_approved()) and (select public.is_enrolled())
             and (
               -- #40, unchanged: the row exists and is mine, in a room I can open.
               exists (
                 select 1 from public.community_attachments a
                   join public.community_posts p on p.id = a.post_id
                  where a.storage_path = name
                    and a.uploader_id = (select auth.uid())
                    and p.channel_id in (select public.my_community_channel_ids()))
               -- #43: an ORPHAN in my own folder. Both path shapes the bucket has
               -- ever used put the uploader's uuid in a known position:
               --   <uid>/<uuid>-<name>            (pre-#32)
               --   <space_id>/<uid>/<uuid>-<name> (#32 onwards)
               or (not exists (select 1 from public.community_attachments a2
                                where a2.storage_path = name)
                   and ((storage.foldername(name))[1] = ((select auth.uid()))::text
                        or (storage.foldername(name))[2] = ((select auth.uid()))::text))
             )))
  );

comment on policy community_media_delete on storage.objects is
  '#43: #40''s attachment-join rule, plus an ORPHAN branch. Without it the '
  'composer''s own failed-upload cleanup was refused (the row it joins to does '
  'not exist yet, by definition), silently stranding private files that admin '
  'hard-delete — which derives paths FROM attachment rows — could not reach.';

-- == 3) enrollment-receipts: same fix, same reasoning =========================
-- SECURITY DEFINER so the reference test cannot be defeated by RLS visibility on
-- enrollment_requests: "no row references this" must mean no row anywhere, not
-- "no row I am allowed to see".
create or replace function public.enrollment_file_is_referenced(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $ref$
  select exists (
    select 1 from public.enrollment_requests r
     where r.receipt_path              = p_path
        or r.resume_path               = p_path
        or r.agreement_signature_path  = p_path
        or r.agreement_pdf_path        = p_path
  );
$ref$;

revoke all on function public.enrollment_file_is_referenced(text) from public, anon;
grant execute on function public.enrollment_file_is_referenced(text) to authenticated;

comment on function public.enrollment_file_is_referenced(text) is
  'Is this storage object cited by any enrollment request? SECURITY DEFINER so '
  'the answer is about the TABLE, not about what the caller may read.';

-- Index the four path columns so that test is not four sequential scans.
create index if not exists enrollment_requests_receipt_path_idx
  on public.enrollment_requests (receipt_path) where receipt_path is not null;
create index if not exists enrollment_requests_resume_path_idx
  on public.enrollment_requests (resume_path) where resume_path is not null;
create index if not exists enrollment_requests_signature_path_idx
  on public.enrollment_requests (agreement_signature_path) where agreement_signature_path is not null;
create index if not exists enrollment_requests_agreement_pdf_path_idx
  on public.enrollment_requests (agreement_pdf_path) where agreement_pdf_path is not null;

drop policy if exists enrollment_receipts_delete on storage.objects;
create policy enrollment_receipts_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'enrollment-receipts'
    and ((select public.is_admin())
         -- #14's rule is intact: the instant a request row cites this file, the
         -- student can no longer remove it. Only the pre-submit window opens.
         or ((storage.foldername(name))[1] = ((select auth.uid()))::text
             and not public.enrollment_file_is_referenced(name)))
  );

comment on policy enrollment_receipts_delete on storage.objects is
  '#43: admins always; an owner only while NO enrollment_requests row cites the '
  'object. Preserves #14''s payment-evidence integrity (a submitted receipt is '
  'permanently undeletable by the student) while letting a FAILED submit clean '
  'up after itself — #42 raised the cost of not doing so from one stranded file '
  'to four, including the handwritten signature.';

-- == 4) Category writer: null means LEAVE ALONE ===============================
-- The default must go, so an omitted argument cannot be read as "set active".
-- DROP first: changing a default in place still leaves callers binding the old
-- signature, and a defaulted overload makes every existing call ambiguous
-- (42725) — the lesson #40 recorded for search_community_members.
drop function if exists public.admin_save_channel_category(uuid, uuid, text, text);

create or replace function public.admin_save_channel_category(
  p_id uuid, p_space_id uuid, p_name text, p_status text default null)
returns uuid
language plpgsql security definer set search_path = public
as $cat$
declare v_id uuid; v_before jsonb; v_pos int; v_status text;
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
    -- Resolve ONCE, then use it everywhere below — the archive guard used to test
    -- the raw argument while the UPDATE tested the coalesced one, so they could
    -- disagree about what this call was even doing.
    v_status := coalesce(nullif(btrim(coalesce(p_status, '')), ''), v_before->>'status');
    if v_status = 'archived'
       and exists (select 1 from public.community_channels
                    where category_id = p_id and status = 'active') then
      perform public.app_error('CATEGORY_NOT_EMPTY',
        'Move or archive this category''s channels first.', 409, null);
    end if;
    update public.community_channel_categories
       set name       = btrim(p_name),
           status     = v_status,
           updated_by = auth.uid()
     where id = p_id;
    v_id := p_id;
    insert into public.community_channel_events (category_id, actor_id, action, detail)
    values (v_id, auth.uid(),
            case when coalesce(v_before->>'status', 'active') is distinct from v_status
                 then (case when v_status = 'archived' then 'category_archive'
                            else 'category_restore' end)
                 else 'category_update' end,
            jsonb_build_object('name', btrim(p_name), 'status', v_status));
  end if;

  return v_id;
end;
$cat$;

revoke all on function public.admin_save_channel_category(uuid, uuid, text, text) from public, anon;
grant execute on function public.admin_save_channel_category(uuid, uuid, text, text) to authenticated;

comment on function public.admin_save_channel_category(uuid, uuid, text, text) is
  '#43: p_status null now means LEAVE ALONE, matching the contract #41 gave '
  'admin_save_community_channel''s p_topic. The old `default ''active''` meant a '
  'caller who merely renamed a category silently RESTORED it from archived and '
  'logged a category_restore event for a change nobody requested.';

-- == 5) Channel writer: kind is a permissions change ==========================
-- Surgical: only the v_touched predicate moves. The rest of #41's body is
-- correct and is deliberately not restated here — a second full copy of a
-- 250-line SECURITY DEFINER function is how #33/#34 went wrong.
do $touch$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_save_community_channel';

  if v_src is null then
    raise exception 'admin_save_community_channel is missing — run #40 then #41.';
  end if;

  if position('or p_kind is not null' in v_src) > 0 then
    raise notice '#43: v_touched already accounts for p_kind — nothing to do.';
    return;
  end if;

  if position('v_touched := p_id is null' in v_src) = 0 then
    raise exception '#43: admin_save_community_channel does not carry #41''s '
                    'v_touched gate. Run db/2026-08-19-community-channel-rename-fixes.sql (#41) first.';
  end if;

  v_new := replace(
    v_src,
    'v_touched := p_id is null' || chr(10) || '               or p_audience_mode   is not null',
    'v_touched := p_id is null' || chr(10) || '               or p_kind           is not null' || chr(10)
      || '               or p_audience_mode   is not null');

  if v_new = v_src then
    raise exception '#43: could not locate the v_touched predicate to patch. '
                    'Apply the p_kind conjunct by hand and re-run.';
  end if;

  execute v_new;
end
$touch$;

comment on function public.admin_save_community_channel(uuid,uuid,uuid,text,text,text,text,text,text[],uuid[],boolean,boolean,boolean,boolean) is
  '#43: p_kind now counts as addressing permissions. kind DRIVES both member '
  'flags (v_posting := coalesce(...) and v_kind = ''text''), so converting a room '
  'to or from an announcement channel sealed or reopened posting and replies '
  'while logging only a generic channel_update. Since #40 dropped the D2 CHECK, '
  'community_channel_events is the ONLY record that a locked room was reopened.';

-- == 6) The feed index the feed can actually use ==============================
-- Non-partial, so predicate_implied_by() is not consulted at all. Hidden and
-- deleted rows are a rounding error of this table; the sort key still matches
-- the query exactly (pinned is NOT NULL DEFAULT false, so DESC ordering aligns).
-- This index also restores a complete channel_id prefix for the ON DELETE
-- RESTRICT foreign key check, which no partial index can serve.
drop index if exists public.community_posts_channel_feed_idx;
create index community_posts_channel_feed_idx
  on public.community_posts (channel_id, pinned desc, last_activity_at desc, id desc);

comment on index public.community_posts_channel_feed_idx is
  '#43: deliberately NOT partial. #41 added `where status = ''active''` believing '
  'RLS pinned it, but community_posts_read is an OR whose first branch is '
  'is_admin() (unrestricted on status) and the client sends status <> ''deleted'' '
  '(which admits hidden) — so the implication fails and the planner ignored it, '
  'turning every feed page into a seq scan + sort. Also the only complete '
  'channel_id index, which the FK RESTRICT check needs.';

-- community_posts_channel_unread_idx stays partial: my_community_sidebar()'s
-- unread lateral filters `p.status = 'active'` as a plain AND qual, so the
-- implication genuinely holds there. Its include(author_id) from #41 is kept.

-- == 7) Sargable counts and indexed in-channel search =========================
create or replace function public.community_category_counts(
  p_space_id uuid default null, p_channel_id uuid default null)
returns table (tag_slug text, n bigint)
language plpgsql stable set search_path = public
as $counts$
begin
  -- SECURITY INVOKER on purpose: community_posts_read scopes the counts.
  -- Branching rather than `(p_x is null or col = p_x)`: a parameter inside an OR
  -- cannot become an index qual once the planner caches a generic plan, so the
  -- channel-switch path was counting every active post the caller may read and
  -- filtering afterwards.
  if p_channel_id is not null then
    return query
      select p.tag_slug, count(*)::bigint
        from public.community_posts p
       where p.status = 'active' and p.channel_id = p_channel_id
       group by p.tag_slug;
  elsif p_space_id is not null then
    return query
      select p.tag_slug, count(*)::bigint
        from public.community_posts p
       where p.status = 'active' and p.space_id = p_space_id
       group by p.tag_slug;
  else
    return query
      select p.tag_slug, count(*)::bigint
        from public.community_posts p
       where p.status = 'active'
       group by p.tag_slug;
  end if;
end;
$counts$;

revoke all on function public.community_category_counts(uuid, uuid) from public, anon;
grant execute on function public.community_category_counts(uuid, uuid) to authenticated;

-- Gains p_tag_slug + p_unanswered so IN-CHANNEL search can use the GIN index
-- too. DROP first — a new arity alongside the old makes every call ambiguous.
drop function if exists public.search_community_posts(text, uuid, text, int, int);

create or replace function public.search_community_posts(
  p_query text,
  p_channel_id uuid default null,
  p_scope text default 'channel',
  p_limit int default 20,
  p_offset int default 0,
  p_tag_slug text default null,
  p_unanswered boolean default false)
returns table (
  id uuid, channel_id uuid, space_id uuid, author_id uuid, author_name text,
  author_avatar_url text, title text, body text, tag_slug text, status text,
  pinned boolean, comments_locked boolean, comment_count int,
  created_at timestamptz, updated_at timestamptz, last_activity_at timestamptz)
language plpgsql stable set search_path = public
as $srch$
declare
  v_q     tsquery;
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 100));
  v_off   int := greatest(0, coalesce(p_offset, 0));
  v_tag   text := nullif(btrim(coalesce(p_tag_slug, '')), '');
  v_unans boolean := coalesce(p_unanswered, false);
begin
  -- SECURITY INVOKER on purpose: community_posts_read is the authorization, so
  -- 'all accessible channels' can never widen into 'all channels'.
  if char_length(btrim(coalesce(p_query, ''))) < 2 then
    return;
  end if;
  v_q := websearch_to_tsquery('english', btrim(p_query));

  if coalesce(p_scope, 'channel') = 'all' then
    return query
      select p.id, p.channel_id, p.space_id, p.author_id, p.author_name,
             p.author_avatar_url, p.title, p.body, p.tag_slug, p.status,
             p.pinned, p.comments_locked, p.comment_count,
             p.created_at, p.updated_at, p.last_activity_at
        from public.community_posts p
       where p.status = 'active'
         and p.search_tsv @@ v_q
         and (v_tag is null or p.tag_slug = v_tag)
         and (not v_unans or p.comment_count = 0)
       order by p.pinned desc, p.last_activity_at desc, p.id desc
       limit v_limit offset v_off;
  else
    -- The scope branch is what had to stop being an OR: this is the common path
    -- (searching the room you are in) and it is the one that must seek on
    -- channel_id rather than filter after the fact.
    return query
      select p.id, p.channel_id, p.space_id, p.author_id, p.author_name,
             p.author_avatar_url, p.title, p.body, p.tag_slug, p.status,
             p.pinned, p.comments_locked, p.comment_count,
             p.created_at, p.updated_at, p.last_activity_at
        from public.community_posts p
       where p.status = 'active'
         and p.channel_id = p_channel_id
         and p.search_tsv @@ v_q
         and (v_tag is null or p.tag_slug = v_tag)
         and (not v_unans or p.comment_count = 0)
       order by p.pinned desc, p.last_activity_at desc, p.id desc
       limit v_limit offset v_off;
  end if;
end;
$srch$;

revoke all on function public.search_community_posts(text, uuid, text, int, int, text, boolean) from public, anon;
grant execute on function public.search_community_posts(text, uuid, text, int, int, text, boolean) to authenticated;

comment on function public.search_community_posts(text, uuid, text, int, int, text, boolean) is
  '#43: branches on scope instead of `(p_scope = ''all'' or channel_id = $1)`, so '
  'the in-channel path can seek. Gains p_tag_slug/p_unanswered so the DEFAULT '
  'search scope can stop running an unindexed ilike OR-scan and use the GIN '
  'index #40 built for it. Clamp raised 50 -> 100 to match the client page size.';

-- == 8) Admin config: one grouped pass, not three per channel =================
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
    'settings', coalesce((select to_jsonb(s) from public.community_settings s limit 1), '{}'::jsonb),
    'spaces', coalesce((
      select jsonb_agg(jsonb_build_object('id', sp.id, 'slug', sp.slug, 'name', sp.name,
                                          'kind', sp.kind, 'batch_id', sp.batch_id)
             order by (sp.kind = 'general') desc, sp.name)
        from public.community_spaces sp), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'space_id', c.space_id, 'name', c.name,
                                          'position', c.position, 'status', c.status)
             order by c.space_id, c.position, c.name)
        from public.community_channel_categories c), '[]'::jsonb),
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ch.id, 'space_id', ch.space_id, 'category_id', ch.category_id,
               'slug', ch.slug, 'name', ch.name, 'topic', ch.topic, 'kind', ch.kind,
               'audience_mode', ch.audience_mode,
               'member_posting', ch.member_posting, 'member_comments', ch.member_comments,
               'member_reactions', ch.member_reactions, 'member_attachments', ch.member_attachments,
               'position', ch.position, 'status', ch.status, 'is_default', ch.is_default,
               'plan_keys', coalesce(pk.keys, '[]'::jsonb),
               'batch_ids', coalesce(bk.ids, '[]'::jsonb),
               'post_count', coalesce(pc.n, 0))
             order by ch.space_id, ch.position, ch.name)
        from public.community_channels ch
        -- ★ Grouped ONCE, not correlated per channel. This was
        --   `(select count(*) ... where p.channel_id = ch.id)` inline in the
        --   jsonb_build_object, i.e. one scan PER CHANNEL: at 24 cohorts that is
        --   ~54 independent scans every time the admin opens the drawer, for a
        --   cosmetic "· N discussions" badge. One grouped pass over the partial
        --   index answers all of them together.
        left join (
          select p.channel_id, count(*)::bigint as n
            from public.community_posts p
           where p.status = 'active'
           group by p.channel_id
        ) pc on pc.channel_id = ch.id
        left join (
          select cp.channel_id, jsonb_agg(cp.plan_key order by cp.plan_key) as keys
            from public.community_channel_plans cp group by cp.channel_id
        ) pk on pk.channel_id = ch.id
        left join (
          select cb.channel_id, jsonb_agg(cb.batch_id order by cb.batch_id) as ids
            from public.community_channel_batches cb group by cb.channel_id
        ) bk on bk.channel_id = ch.id), '[]'::jsonb),
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

revoke all on function public.admin_community_config() from public, anon;
grant execute on function public.admin_community_config() to authenticated;

-- == 9) Mention directory: index the scan it was always doing ================
-- The per-candidate call to user_community_channel_ids() is KEPT, deliberately.
-- It is the canonical L1.5 seam, and the obvious "optimisation" — resolving the
-- channel's audience once and joining candidates to subscriptions and
-- batch_entitlements directly — would put a SECOND copy of the audience CASE and
-- of the space-membership rule in the codebase. That is precisely the drift this
-- repo keeps getting bitten by, and an authorization rule is the worst place to
-- accept it. The 60-candidate cap already bounds the work per call.
--
-- What was genuinely missing is the index. `p.full_name ilike '%q%'` is a
-- leading-wildcard match with no trigram index, so every keystroke pause paid a
-- full sequential scan of profiles BEFORE the cap could bound anything. #25 added
-- exactly this index for exactly this reason and it did not survive; here it is
-- again, with a comment saying why it must.
create extension if not exists pg_trgm;

create index if not exists profiles_full_name_trgm_idx
  on public.profiles using gin (full_name gin_trgm_ops);

comment on index public.profiles_full_name_trgm_idx is
  '#43: search_community_members() matches full_name with a LEADING wildcard, '
  'which no btree can serve. Without this the mention autocomplete seq-scans '
  'profiles on every debounced keystroke, before its 60-row cap applies.';

-- == 10) The last unindexed FK on a table that grows members x channels =======
create index if not exists community_channel_reads_post_idx
  on public.community_channel_reads (last_read_post_id)
  where last_read_post_id is not null;

comment on index public.community_channel_reads_post_idx is
  '#43: community_channel_reads.last_read_post_id references community_posts ON '
  'DELETE SET NULL, so without this every admin hard-delete of a post seq-scans '
  'a table sized members x channels.';

analyze public.community_posts;
analyze public.community_channel_reads;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-22-community-channel-followup.sql', null,
  'channel follow-up (#43): restores the approved+enrolled+channel gate on '
  'community_reactions_own_delete (#36 had reduced it to a bare own-row test); '
  'lets an uploader delete their own ORPHAN in community-media and '
  'enrollment-receipts so the clients failed-submit cleanup is no longer a '
  'silent 403; p_status null means leave-alone in admin_save_channel_category; '
  'p_kind counts as a permissions change for #41s audit gate; drops the '
  'unusable partial predicate from community_posts_channel_feed_idx (RLS never '
  'implied it, so the feed was seq-scanning); makes community_category_counts '
  'and search_community_posts sargable and gives the latter tag/unanswered '
  'params so IN-CHANNEL search uses the GIN index; de-correlates '
  'admin_community_config; adds the profiles full_name trigram index the mention '
  'directory needs; indexes community_channel_reads.last_read_post_id.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--   select indexdef from pg_indexes
--    where indexname = 'community_posts_channel_feed_idx';        -- no WHERE clause
--
--   explain (analyze, buffers)
--   select id from public.community_posts
--    where channel_id = '<a real channel id>' and status <> 'deleted'
--    order by pinned desc, last_activity_at desc, id desc limit 20;
--     -- expect Index Scan, NOT Seq Scan + Sort
--
--   select prosrc like '%or p_kind           is not null%' as kind_gated
--     from pg_proc where proname = 'admin_save_community_channel';
--
--   select pg_get_function_identity_arguments(oid)
--     from pg_proc where proname = 'admin_save_channel_category';  -- p_status has no default value shown
-- ─────────────────────────────────────────────────────────────────────────────
