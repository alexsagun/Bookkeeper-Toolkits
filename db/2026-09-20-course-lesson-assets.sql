-- ═════════════════════════════════════════════════════════════════════════════
-- #65 — Course lesson instructions: rich text and private images
-- 2026-09-20
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- A lesson's notes were a plain textarea rendered as escaped text. A course creator could
-- not make the word "HERE" a link to a Google Form, and could not paste the screenshot
-- that shows which menu to click — so instructions were written as bare URLs students had
-- to retype, and the screenshots lived somewhere else entirely.
--
-- WHAT
--
--   • course_lessons.content_format ('plain' | 'markdown'). Every existing row stays
--     'plain' and renders byte-identically to before. Nothing is reinterpreted.
--   • course_lesson_assets — one row per uploaded image, in the PRIVATE
--     course-lesson-assets bucket. Paid instructional material: never course-media,
--     which is public and serves its bytes to anyone holding the URL.
--   • course_lesson_asset_refs — which lesson cites which image, with its alt text.
--
-- ★ REFERENCES ARE DERIVED, NEVER SUPPLIED.
--   Staff can write course_lessons directly through PostgREST (lessons_staff_write), so a
--   client-supplied image list would be a client-chosen authorization list. A trigger
--   re-extracts the `lesson-asset://<uuid>` tokens from the saved text instead, in the
--   same transaction. Text and references therefore cannot disagree, an unknown or
--   unrelated asset cannot be cited, alt text cannot be omitted, and the per-lesson image
--   limit cannot be exceeded — by anyone, through any path.
--
-- ★ READS ARE AUTHORIZED BY REFERENCE, NOT BY PATH. #44 deleted course_object_allowed()
--   because it parsed a READ out of an object name and failed OPEN three ways. An image
--   is readable here only when a PUBLISHED lesson the caller's plan may open actually
--   cites it. That is also what makes course duplication work: a duplicate reuses the
--   original's image by reference and copies no bytes, so the file lives in the SOURCE
--   course's folder and a path-based check would get it exactly wrong.
--
-- ★ WRITES ARE PATH-PARSED, AND THAT IS THE INVERSE ON PURPOSE. A write names an object
--   that does not exist yet, so there is no reference to consult. The parser returns NULL
--   for anything that is not precisely lessons/<uuid>/<uuid>/<file>, and
--   user_can_manage_course(uid, NULL) is false — so a malformed path DENIES.
--
-- LOCKSTEP: this file ↔ bootstrap §52 ↔ src/lib/lessonContent.js ↔ the composer and
-- renderer in src/BookkeeperPro.jsx ↔ api/admin/course-trainer.js ↔
-- test/lessonContent.test.mjs + test/lessonContentSql.test.mjs +
-- test-db/courseLessonAssets.dbtest.mjs ↔ the #65 block in scripts/audit-db.mjs ↔
-- src/lib/appErrors.js (7 new codes).
-- ─────────────────────────────────────────────────────────────────────────────

-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-19-finance-daily-income.sql') then
    raise exception '#65: run db/2026-09-19-finance-daily-income.sql (#64) first.';
  end if;
  if to_regprocedure('public.can_manage_course(uuid)') is null
     or to_regprocedure('public.user_can_manage_course(uuid, uuid)') is null then
    raise exception '#65: #46 (course staff assignments) must be applied first.';
  end if;
  if to_regprocedure('public.app_error(text, text, integer, jsonb)') is null then
    raise exception '#65: #35 (app_error) must be applied first.';
  end if;
  if to_regprocedure('public.plan_is_sampler()') is null then
    raise exception '#65: #19 (sampler essentials access) must be applied first.';
  end if;
  if to_regprocedure('public.course_ai_mark_lesson_stale()') is null then
    raise exception '#65: #27 (course AI trainer) must be applied first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'courses' and column_name = 'source_course_id') then
    raise exception '#65: courses.source_course_id is required for the duplication-family rule.';
  end if;
  if (select count(*) from public.staff_permissions) <> 22 then
    raise exception '#65: expected 22 staff permissions (this file changes none).';
  end if;
end
$pre$;

-- == 1) The format marker =====================================================
--
-- ★ DEFAULT 'plain', AND THAT IS THE WHOLE BACKWARD-COMPATIBILITY STORY. Every lesson
--   written before this migration keeps rendering as escaped text with preserved line
--   breaks. A note containing "*" or "[1]" does not silently acquire formatting, and the
--   AI trainer's content hash for it does not change, so nothing is needlessly re-indexed.

alter table public.course_lessons
  add column if not exists content_format text not null default 'plain';

do $blk$
begin
  if not exists (select 1 from pg_constraint where conname = 'course_lessons_content_format_chk') then
    alter table public.course_lessons
      add constraint course_lessons_content_format_chk
      check (content_format in ('plain', 'markdown'));
  end if;
end
$blk$;

comment on column public.course_lessons.content_format is
  'How text_content is read. plain = escaped text with preserved line breaks (every row '
  'that predates #65). markdown = the closed subset in src/lib/lessonContent.js: '
  'paragraphs, bold, lists, https links, and ![alt](lesson-asset://<uuid>) images. '
  'Never HTML. The renderer emits React elements from typed tokens, never innerHTML.';

-- == 2) The asset tables ======================================================

create table if not exists public.course_lesson_assets (
  id           uuid primary key default gen_random_uuid(),
  -- The course the image was uploaded FOR. Not necessarily the only course that shows
  -- it: a duplicated course cites the same row rather than copying the bytes.
  -- ★ ON DELETE SET NULL, NOT CASCADE, AND THAT IS THE WHOLE POINT OF THE COLUMN.
  --   Deleting a course must not break a DUPLICATE of it. The video half already works
  --   this way: a duplicate's storage_path is a plain string that keeps pointing into the
  --   source course's folder, and removeMediaIfUnreferenced refuses to delete an object
  --   another course still cites. Cascading here would delete the asset ROW out from under
  --   a duplicate's lessons — their images would vanish and their next save would be
  --   refused as citing an image that does not exist. The row instead loses its origin
  --   and survives: reads are reference-based and never consult course_id at all, and
  --   course_lesson_asset_manageable already falls back to the courses that cite it.
  course_id    uuid references public.courses(id) on delete set null,
  storage_path text not null unique,
  mime_type    text not null,
  byte_size    bigint not null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint course_lesson_assets_mime_chk
    check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  constraint course_lesson_assets_size_chk
    check (byte_size > 0 and byte_size <= 10485760),
  -- ★ THE PATH IS BOUND TO THE COURSE BY THE ROW ITSELF. Without this a row could claim
  --   course A while naming an object under course B's folder, and the write policy —
  --   which parses the PATH — would authorize it against B while every read predicate
  --   reasoned about A. Skipped once the origin course is gone: the object's folder still
  --   names a course that no longer exists, which is a fact about history, not a fault.
  constraint course_lesson_assets_path_chk check (
    course_id is null
    or storage_path ~ ('^lessons/' || course_id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,120}$')
  )
);

-- Bring an already-created table to the shape above. `create table if not exists` is a
-- no-op on an existing table, so without this an environment that ran an earlier copy of
-- this file would silently keep the cascade. Every file here is safe to re-run; this is
-- what makes that true of this one.
do $blk$
begin
  if exists (select 1 from pg_constraint
              where conname = 'course_lesson_assets_course_id_fkey'
                and conrelid = 'public.course_lesson_assets'::regclass
                and confdeltype = 'c') then                        -- 'c' = CASCADE
    alter table public.course_lesson_assets drop constraint course_lesson_assets_course_id_fkey;
    alter table public.course_lesson_assets alter column course_id drop not null;
    alter table public.course_lesson_assets
      add constraint course_lesson_assets_course_id_fkey
      foreign key (course_id) references public.courses(id) on delete set null;
    alter table public.course_lesson_assets drop constraint if exists course_lesson_assets_path_chk;
    alter table public.course_lesson_assets
      add constraint course_lesson_assets_path_chk check (
        course_id is null
        or storage_path ~ ('^lessons/' || course_id::text
          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,120}$')
      );
  end if;
end
$blk$;

create table if not exists public.course_lesson_asset_refs (
  lesson_id  uuid not null references public.course_lessons(id) on delete cascade,
  asset_id   uuid not null references public.course_lesson_assets(id) on delete cascade,
  alt_text   text not null,
  position   int not null default 0,
  created_at timestamptz not null default now(),
  primary key (lesson_id, asset_id),
  constraint course_lesson_asset_refs_alt_chk
    check (length(btrim(alt_text)) between 1 and 300)
);

create index if not exists course_lesson_assets_course_idx
  on public.course_lesson_assets (course_id);
-- The read predicate joins refs by asset_id, and cleanup counts refs by asset_id.
create index if not exists course_lesson_asset_refs_asset_idx
  on public.course_lesson_asset_refs (asset_id);

alter table public.course_lesson_assets enable row level security;
alter table public.course_lesson_asset_refs enable row level security;

-- ★ NEVER `force row level security` ON THESE TABLES. The sync trigger runs as the table
--   owner; forcing RLS would subject it to policies and break every lesson save.

-- == 3) The bucket ============================================================
do $blk$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('course-lesson-assets', 'course-lesson-assets', false, 10485760,
          array['image/png', 'image/jpeg', 'image/webp'])
  on conflict (id) do update
    set public             = false,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception
  when insufficient_privilege then
    raise notice '#65: could not create course-lesson-assets from SQL. In Dashboard -> Storage -> New bucket, create "course-lesson-assets" with Public = OFF, a 10 MB file size limit, and allowed MIME types image/png, image/jpeg, image/webp.';
end
$blk$;

-- == 4) Path parsing (writes) and reference resolution (reads) ================

-- Exactly lessons/<course uuid>/<lesson uuid>/<file>, or NULL. Deliberately NOT a
-- loosening of course_object_course_id(), which owns the three-segment VIDEO shape and
-- must keep failing closed on everything else.
create or replace function public.course_lesson_asset_course_id(p_name text)
returns uuid
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $fn$
  select case
    when p_name ~* ('^lessons/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                 || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$')
      then split_part(p_name, '/', 2)::uuid
    else null
  end;
$fn$;

comment on function public.course_lesson_asset_course_id(text) is
  'The course id inside a lesson-asset object path, or NULL. Used ONLY to authorize '
  'WRITES: user_can_manage_course(uid, NULL) is false, so a malformed path denies. '
  'Reads are reference-based (course_lesson_asset_object_readable) — see #44.';

-- The oldest course in a duplication lineage. Bounded: source_course_id is not
-- constrained acyclic, and #54 learned the same lesson walking it for progress scoring.
create or replace function public.course_family_root(p_course_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with recursive up(id, src, depth) as (
    select c.id, c.source_course_id, 0
      from public.courses c
     where c.id = p_course_id
    union all
    select c.id, c.source_course_id, up.depth + 1
      from public.courses c
      join up on c.id = up.src
     where up.depth < 20
  )
  select id from up order by depth desc limit 1;
$fn$;

-- ★ MIRRORS courses_read EXACTLY (published + approved + enrolled + the sampler
--   qbo-%/essentials rule). Drift here is a scoring bug in one direction and a
--   disclosure bug in the other, which is why test/lessonContentSql.test.mjs pins the
--   conjuncts and test-db/courseLessonAssets.dbtest.mjs proves them per plan.
create or replace function public.course_lesson_asset_readable(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.course_lesson_asset_refs r
      join public.course_lessons l on l.id = r.lesson_id
      join public.courses c on c.id = l.course_id
     where r.asset_id = p_asset_id
       and c.published
       and (select public.is_approved())
       and (select public.is_enrolled())
       and ((not (select public.plan_is_sampler()))
            or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
  );
$fn$;

-- Staff reach: the asset's own course, or any course whose lesson cites it — so a
-- Trainer assigned only to a DUPLICATE can still see the image their lesson shows.
create or replace function public.course_lesson_asset_manageable(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.course_lesson_assets a
     where a.id = p_asset_id and public.can_manage_course(a.course_id)
  ) or exists (
    select 1
      from public.course_lesson_asset_refs r
      join public.course_lessons l on l.id = r.lesson_id
     where r.asset_id = p_asset_id and public.can_manage_course(l.course_id)
  ) or exists (
    -- ★ A STRANDED ASSET IS STILL SOMEBODY'S TO CLEAN UP. Its origin course was deleted
    --   (SET NULL) and no lesson cites it any more, so neither arm above can ever be
    --   true — and without this one the delete RPC would refuse for everybody, leaving
    --   an object in a paid bucket that literally nobody was permitted to remove.
    select 1 from public.course_lesson_assets a
     where a.id = p_asset_id and a.course_id is null
       and (select public.has_staff_permission('courses.manage_all'))
  );
$fn$;

create or replace function public.course_lesson_asset_object_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.course_lesson_assets a
     where a.storage_path = p_name
       and (public.course_lesson_asset_readable(a.id)
            or public.course_lesson_asset_manageable(a.id))
  );
$fn$;

comment on function public.course_lesson_asset_object_readable(text) is
  'Reference-based read authorization for the private course-lesson-assets bucket: an '
  'object is readable only when a published lesson the caller''s plan may open cites it, '
  'or when the caller can manage a course that cites it. An UNREFERENCED object is '
  'unreachable by everyone — it fails closed, unlike the path parser #44 removed.';

revoke all on function public.course_family_root(uuid) from public, anon;
revoke all on function public.course_lesson_asset_readable(uuid) from public, anon;
revoke all on function public.course_lesson_asset_manageable(uuid) from public, anon;
revoke all on function public.course_lesson_asset_object_readable(text) from public, anon;
revoke all on function public.course_lesson_asset_course_id(text) from public, anon;
-- ★ NOT granted to authenticated. Nothing in src/ or api/ calls it; it is used only inside
--   SECURITY DEFINER bodies, which run as the owner. Granting it would hand any signed-in
--   user the duplication lineage of UNPUBLISHED courses for nothing in return.
grant execute on function public.course_lesson_asset_readable(uuid) to authenticated;
grant execute on function public.course_lesson_asset_manageable(uuid) to authenticated;
grant execute on function public.course_lesson_asset_object_readable(text) to authenticated;
grant execute on function public.course_lesson_asset_course_id(text) to authenticated;

-- == 5) Table policies ========================================================
--
-- SELECT only, and no client write path at all — the finance rule. Every mutation goes
-- through the RPCs and the sync trigger below, so a direct PostgREST write cannot skip
-- the alt-text check, the image limit or the duplication-family rule.

drop policy if exists course_lesson_assets_read on public.course_lesson_assets;
create policy course_lesson_assets_read on public.course_lesson_assets
  for select to authenticated
  using (public.course_lesson_asset_readable(id) or public.course_lesson_asset_manageable(id));

drop policy if exists course_lesson_asset_refs_read on public.course_lesson_asset_refs;
create policy course_lesson_asset_refs_read on public.course_lesson_asset_refs
  for select to authenticated
  using (public.course_lesson_asset_readable(asset_id) or public.course_lesson_asset_manageable(asset_id));

revoke all on public.course_lesson_assets from anon, authenticated;
revoke all on public.course_lesson_asset_refs from anon, authenticated;
grant select on public.course_lesson_assets to authenticated;
grant select on public.course_lesson_asset_refs to authenticated;

-- == 6) Storage policies ======================================================

drop policy if exists course_lesson_assets_object_read on storage.objects;
create policy course_lesson_assets_object_read on storage.objects
  for select to authenticated
  using (bucket_id = 'course-lesson-assets'
         and public.course_lesson_asset_object_readable(name));

drop policy if exists course_lesson_assets_object_write on storage.objects;
create policy course_lesson_assets_object_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'course-lesson-assets'
              and public.can_manage_course(public.course_lesson_asset_course_id(name)));

drop policy if exists course_lesson_assets_object_update on storage.objects;
create policy course_lesson_assets_object_update on storage.objects
  for update to authenticated
  using (bucket_id = 'course-lesson-assets'
         and public.can_manage_course(public.course_lesson_asset_course_id(name)));

drop policy if exists course_lesson_assets_object_delete on storage.objects;
create policy course_lesson_assets_object_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'course-lesson-assets'
         and public.can_manage_course(public.course_lesson_asset_course_id(name)));

-- == 7) The sync trigger ======================================================
--
-- ★ THIS IS THE ONLY WRITER OF course_lesson_asset_refs.
--   It runs in the SAME transaction as the lesson save, so "the text says X" and "the
--   references authorize X" cannot come apart — not through the app, not through a
--   direct PostgREST write, and not through course duplication (which inserts lesson
--   rows carrying the copied text, and so re-derives its own references from them).

create or replace function public.course_lesson_sync_assets()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_alt     text;
  v_id      uuid;
  v_seen    uuid[] := '{}';
  v_pos     int := 0;
  v_root    uuid;
  v_acourse uuid;
  v_arootid uuid;
  v_exists  boolean;
  v_prior   uuid[] := '{}';
  v_match   text[];
begin
  -- ★ CAPTURED BEFORE THE DELETE, AND THAT ORDER IS THE WHOLE FIX FOR A STRANDED IMAGE.
  --   See the family check below: an asset whose origin course was deleted has no family
  --   of its own, and the only remaining evidence of where it belongs is who cites it —
  --   which, for a re-save of the sole citing lesson, is this lesson, whose rows the next
  --   statement is about to remove.
  select coalesce(array_agg(asset_id), '{}') into v_prior
    from public.course_lesson_asset_refs where lesson_id = new.id;

  delete from public.course_lesson_asset_refs where lesson_id = new.id;

  if coalesce(new.content_format, 'plain') <> 'markdown'
     or coalesce(new.text_content, '') = '' then
    return new;
  end if;

  v_root := public.course_family_root(new.course_id);

  for v_match in
    select m from regexp_matches(
      new.text_content,
      '!\[([^\]\n]*)\]\(lesson-asset://([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)',
      'g') as m
  loop
    v_alt := btrim(v_match[1]);
    v_id  := lower(v_match[2])::uuid;

    -- The same screenshot may legitimately appear twice; it is still one reference.
    if v_id = any(v_seen) then
      continue;
    end if;

    if v_alt = '' then
      perform public.app_error('LESSON_ASSET_ALT_REQUIRED',
        'Every lesson image needs a short description for students using a screen reader.',
        422, jsonb_build_object('lesson_id', new.id, 'asset_id', v_id));
    end if;
    if length(v_alt) > 300 then
      v_alt := left(v_alt, 300);
    end if;

    select true, a.course_id into v_exists, v_acourse
      from public.course_lesson_assets a where a.id = v_id;
    if not coalesce(v_exists, false) then
      perform public.app_error('LESSON_ASSET_UNKNOWN_REF',
        'This lesson refers to an image that does not exist.',
        422, jsonb_build_object('lesson_id', new.id, 'asset_id', v_id));
    end if;

    v_arootid := public.course_family_root(v_acourse);

    -- ★ A STRANDED IMAGE INHERITS THE FAMILY OF WHATEVER STILL SHOWS IT.
    --   When a course is deleted its images survive (ON DELETE SET NULL) so a DUPLICATE
    --   of it keeps working — but with no course_id they have no family of their own, and
    --   course_family_root(NULL) is NULL. Comparing that NULL against the lesson's root
    --   refused EVERY later save of the very lessons the SET NULL existed to protect:
    --   a one-character typo fix on a duplicate's lesson came back "refers to an image
    --   that does not exist", with the image still on screen and nothing to act on. It
    --   also broke duplicating such a course at all, because the batched lesson insert
    --   failed and the rollback then deleted the half-built copy.
    --
    --   So an orphaned asset takes its family from its surviving citations: this lesson's
    --   own prior reference (a re-save), or any other lesson that still shows it (a
    --   duplicate being created from one that does). An asset nothing cites any more has
    --   no family and stays refused — a pasted uuid still cannot reach another course's
    --   image, which is the rule this check exists for.
    if v_arootid is null then
      if v_id = any(v_prior) then
        v_arootid := v_root;
      else
        select public.course_family_root(l.course_id) into v_arootid
          from public.course_lesson_asset_refs r
          join public.course_lessons l on l.id = r.lesson_id
         where r.asset_id = v_id
         limit 1;
      end if;
    end if;

    if v_arootid is distinct from v_root then
      perform public.app_error('LESSON_ASSET_UNKNOWN_REF',
        'This lesson refers to an image that does not exist, or that belongs to an unrelated course.',
        422, jsonb_build_object('lesson_id', new.id, 'asset_id', v_id));
    end if;

    v_seen := v_seen || v_id;
    if array_length(v_seen, 1) > 10 then
      perform public.app_error('LESSON_ASSET_LIMIT',
        'A lesson may show at most 10 images.',
        422, jsonb_build_object('lesson_id', new.id));
    end if;

    insert into public.course_lesson_asset_refs (lesson_id, asset_id, alt_text, position)
    values (new.id, v_id, v_alt, v_pos)
    on conflict (lesson_id, asset_id) do update set alt_text = excluded.alt_text;
    v_pos := v_pos + 1;
  end loop;

  return new;
end;
$fn$;

revoke all on function public.course_lesson_sync_assets() from public, anon, authenticated;

drop trigger if exists course_lesson_assets_sync on public.course_lessons;
-- course_id is in the column list because moving a lesson between courses changes which
-- family its citations must belong to, and lessons_staff_write permits that write. Without
-- it a lesson could carry its references across a family boundary unchecked.
create trigger course_lesson_assets_sync
  after insert or update of text_content, content_format, course_id on public.course_lessons
  for each row execute function public.course_lesson_sync_assets();

-- == 8) Registration, deletion and orphan reporting ===========================

create or replace function public.course_lesson_asset_register(
  p_course_id    uuid,
  p_lesson_id    uuid,
  p_storage_path text,
  p_mime_type    text,
  p_byte_size    bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id       uuid;
  v_path_cid uuid;
begin
  if auth.uid() is null then
    perform public.app_error('LESSON_ASSET_FORBIDDEN', 'Sign in to upload lesson images.', 403);
  end if;
  if not public.can_manage_course(p_course_id) then
    perform public.app_error('LESSON_ASSET_FORBIDDEN', 'You cannot manage images for that course.', 403);
  end if;

  -- The path decides the course for the STORAGE policy, so it must name the same course
  -- this row claims, or the two halves would authorize different things.
  v_path_cid := public.course_lesson_asset_course_id(p_storage_path);
  if v_path_cid is null or v_path_cid <> p_course_id then
    perform public.app_error('LESSON_ASSET_BAD_PATH',
      'That image path is not the shape a lesson asset uses.', 422);
  end if;
  if p_lesson_id is not null and not exists (
      select 1 from public.course_lessons l
       where l.id = p_lesson_id and l.course_id = p_course_id) then
    perform public.app_error('LESSON_ASSET_BAD_PATH',
      'That lesson does not belong to that course.', 422);
  end if;

  -- Idempotent: a retried upload of the same object must not create a second row.
  insert into public.course_lesson_assets (course_id, storage_path, mime_type, byte_size, created_by)
  values (p_course_id, p_storage_path, p_mime_type, p_byte_size, auth.uid())
  on conflict (storage_path) do nothing
  returning id into v_id;

  if v_id is null then
    select a.id into v_id from public.course_lesson_assets a where a.storage_path = p_storage_path;
  end if;
  return v_id;
end;
$fn$;

create or replace function public.course_lesson_asset_delete(p_asset_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_path text;
begin
  if auth.uid() is null or not public.course_lesson_asset_manageable(p_asset_id) then
    perform public.app_error('LESSON_ASSET_FORBIDDEN', 'You cannot manage that image.', 403);
  end if;
  select a.storage_path into v_path from public.course_lesson_assets a where a.id = p_asset_id;
  if v_path is null then
    perform public.app_error('LESSON_ASSET_NOT_FOUND', 'That image no longer exists.', 404);
  end if;
  -- ★ A REFERENCED IMAGE IS NEVER DELETED. Deleting a row whose lesson still shows it
  --   would leave that lesson pointing at an object nothing authorizes any more — the
  --   removeMediaIfUnreferenced lesson, enforced here rather than trusted to a client.
  if exists (select 1 from public.course_lesson_asset_refs r where r.asset_id = p_asset_id) then
    perform public.app_error('LESSON_ASSET_IN_USE',
      'That image is still used by a lesson. Remove it from the lesson text first.', 409);
  end if;
  delete from public.course_lesson_assets where id = p_asset_id;
  return v_path;
end;
$fn$;

-- Unreferenced objects for one course, oldest first. The CLIENT deletes the bytes: SQL
-- cannot, because Supabase's storage.protect_delete() trigger refuses a direct DELETE
-- from storage.objects.
create or replace function public.course_lesson_asset_orphans(
  p_course_id uuid,
  p_min_age   interval default interval '0'
)
returns table (asset_id uuid, storage_path text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.can_manage_course(p_course_id) then
    perform public.app_error('LESSON_ASSET_FORBIDDEN', 'You cannot manage that course.', 403);
  end if;
  return query
    select a.id, a.storage_path
      from public.course_lesson_assets a
     where a.created_at < now() - p_min_age
       and not exists (select 1 from public.course_lesson_asset_refs r where r.asset_id = a.id)
       and (a.course_id = p_course_id
            -- ★ STRANDED ROWS, OR NOTHING WOULD EVER COLLECT THEM. When a course is
            --   deleted its assets keep living (SET NULL) so a duplicate can still show
            --   them. Once the LAST citing lesson is gone too, such a row belongs to no
            --   course, so no per-course sweep could ever name it and its bytes would sit
            --   in the bucket for good. Only someone who can manage every course may
            --   collect them, because they are by definition not this course's business.
            or (a.course_id is null
                and (select public.has_staff_permission('courses.manage_all'))))
     order by a.created_at
     limit 200;
end;
$fn$;

revoke all on function public.course_lesson_asset_register(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.course_lesson_asset_delete(uuid) from public, anon, authenticated;
revoke all on function public.course_lesson_asset_orphans(uuid, interval) from public, anon, authenticated;
grant execute on function public.course_lesson_asset_register(uuid, uuid, text, text, bigint) to authenticated;
grant execute on function public.course_lesson_asset_delete(uuid) to authenticated;
grant execute on function public.course_lesson_asset_orphans(uuid, interval) to authenticated;

-- == 9) The AI trainer must notice a format change ============================
--
-- ★ PATCHED IN PLACE, NOT RESTATED. course_ai_mark_lesson_stale() watches four columns;
--   content_format is not one of them, and doSync's idempotency key is a hash of
--   text_content alone. So converting a lesson to markdown WITHOUT editing its words
--   would leave the source 'ready' for ever, serving chunks full of markdown syntax that
--   the agent would read aloud as punctuation.
--
--   The #56 instrument is used deliberately: pg_get_functiondef() reads whatever body is
--   live, asserts the anchor appears exactly once, and replaces that one string. Retyping
--   the body would silently revert any later fix to it — the #33/#34 failure mode. It is
--   ONE statement, so it cannot half-apply, and it is idempotent.
do $regate$
declare
  v_def text;
  v_old text := 'if new.text_content is distinct from old.text_content';
  v_new text := 'if new.text_content is distinct from old.text_content
     or new.content_format is distinct from old.content_format';
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'course_ai_mark_lesson_stale';
  if v_def is null then
    raise exception '#65: course_ai_mark_lesson_stale() is missing — run #27 first.';
  end if;
  if position('new.content_format' in v_def) > 0 then
    return;                                   -- already patched; nothing to do
  end if;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_hits <> 1 then
    raise exception '#65: expected exactly one text_content guard in course_ai_mark_lesson_stale(), found %.', v_hits;
  end if;
  execute replace(v_def, v_old, v_new);
end
$regate$;

-- == 10) Error catalog ========================================================
--
-- ★ COPIED FROM #63, NOT RETYPED. The 112 inherited rows are byte-identical; the 7
--   LESSON_ASSET_* rows are the only addition (119 total).
create or replace function public.app_error_catalog()
returns table (code text, http int, summary text)
language sql
immutable
parallel safe
set search_path = public
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
    ('CHANNEL_NOT_FOUND',            404, 'The channel does not exist, or is not available to you.'),
    ('CHANNEL_SLUG_TAKEN',           409, 'Another channel in this space already uses that address.'),
    ('CHANNEL_AUDIENCE_EMPTY',       422, 'The audience needs at least one plan or batch, or nobody could see it.'),
    ('CHANNEL_ARCHIVED',             409, 'The channel is archived and accepts no new content.'),
    ('CATEGORY_NOT_FOUND',           404, 'The channel category does not exist.'),
    ('CATEGORY_NOT_EMPTY',           409, 'The category still holds active channels.'),
    ('LESSON_VIDEO_UPLOAD_ONLY',     409, 'A lesson video must be an uploaded file in the private bucket; external links are no longer accepted.'),
    ('LESSON_VIDEO_PATH_INVALID',    422, 'An uploaded lesson video must live at lessons/<course-uuid>/<file>.'),
    ('COURSE_PUBLISH_BLOCKED',       409, 'The course still has video lessons with no uploaded file.'),
    ('STAFF_LAST_SUPER_ADMIN',       409, 'That change would leave no active Super Admin. Promote a replacement first.'),
    ('STAFF_NOT_FOUND',              404, 'That account is not staff, or has no profile.'),
    ('STAFF_ROLE_INVALID',           422, 'Unknown staff role or status, or a required reason was missing.'),
    ('COURSE_NOT_ASSIGNED',          403, 'You can edit courses, but not this one — nobody has assigned it to you.'),
    ('COURSE_PUBLISH_FORBIDDEN',     403, 'Publishing or withdrawing a course needs its own permission.'),
    ('COURSE_ASSIGNMENT_INVALID',    422, 'Unknown assignment role, or the target account cannot edit courses at all.'),
    ('SUBSCRIPTION_NOT_FOUND',       404, 'That member has no subscription to act on.'),
    ('EXTENSION_NOT_ALLOWED',        409, 'This membership never expires, so an extension could only shorten it.'),
    ('EXTENSION_INVALID',            422, 'The requested extension is out of range, backwards, or missing its reason.'),
    ('STAFF_NO_INVITATION',          404, 'There is no staff membership on this account to accept.'),
    ('STAFF_INVITATION_NOT_PENDING', 409, 'The membership is suspended, revoked or already active; an old link cannot restore it.'),
    ('STAFF_EMAIL_NOT_VERIFIED',     403, 'The Auth identity has not confirmed the mailbox the invitation was sent to.'),
    ('STAFF_ACCOUNT_REJECTED',       403, 'The account is blocked from the platform, so a staff invitation cannot be accepted on it.'),
    ('ACCESS_REQUEST_SELF_REVIEW',   403, 'A reviewer cannot decide on their own access request.'),
    ('ACCESS_REQUEST_STAFF_TARGET',  409, 'The target holds an invited or active staff membership; withdraw staff access through Team & Roles instead.'),
    ('MODERATION_TARGET_NOT_FOUND',  404, 'The post or reply does not exist, or is not in a channel the moderator can reach.'),
    ('MODERATION_ACTION_INVALID',    422, 'Unknown moderation action.'),
    ('MODERATION_STATE_INVALID',     409, 'The target''s current state does not allow that action (e.g. restoring an author-withdrawn post).'),
    -- ── Financial management (#58) ──
    ('FINANCE_ENTRY_UNBALANCED',     409, 'A journal entry must have at least two lines and equal debits and credits.'),
    ('FINANCE_ENTRY_IMMUTABLE',      409, 'A posted entry, line, payment event or audit row cannot be edited or deleted.'),
    ('FINANCE_ENTRY_ALREADY_REVERSED',409,'That entry has already been reversed; one reversal per entry, ever.'),
    ('FINANCE_ENTRY_NOT_FOUND',      404, 'That journal entry does not exist.'),
    ('FINANCE_ENTRY_FUTURE_DATED',   422, 'An entry cannot be dated in the future; a recurring cost is a template, not a posting.'),
    ('FINANCE_ENTRY_KIND_INVALID',   422, 'Unknown entry kind for this action.'),
    ('FINANCE_PERIOD_LOCKED',        409, 'That accounting period is closed; post the correction in an open period.'),
    ('FINANCE_PERIOD_NOT_ELAPSED',   409, 'Only a period that has fully ended in the business timezone can be closed.'),
    ('FINANCE_PERIOD_INVALID',       422, 'Not a real YYYY-MM period, or the period is not locked.'),
    ('FINANCE_PERIOD_REASON_REQUIRED',422,'Reopening a closed accounting period needs a reason.'),
    ('FINANCE_REVERSAL_REASON_REQUIRED',422,'A reversal needs a reason.'),
    ('FINANCE_ACCOUNTS_NOT_CONFIGURED',409,'The default income or cash account is missing or inactive.'),
    ('FINANCE_ACCOUNT_NOT_FOUND',    404, 'That finance account does not exist.'),
    ('FINANCE_SYSTEM_ACCOUNT',       409, 'A system account cannot be deactivated or retyped.'),
    ('FINANCE_EVENT_AMOUNT_MISMATCH',409, 'The payment event amount does not equal its journal entry.'),
    ('FINANCE_AUDIT_IMMUTABLE',      409, 'The finance audit trail is append-only.'),
    ('FINANCE_IDEMPOTENCY_REQUIRED', 422, 'This action needs an idempotency key so a retry cannot post twice.'),
    ('FINANCE_TIMEZONE_INVALID',     422, 'Not a timezone Postgres recognises (see pg_timezone_names).'),
    ('FINANCE_BANK_TXN_IMMUTABLE',   409, 'The parsed facts of a bank transaction cannot be edited; exclude it with a reason.'),
    ('FINANCE_BANK_IMPORT_DUPLICATE',409, 'That statement file has already been imported into this account.'),
    ('FINANCE_RECONCILIATION_CLOSED',409, 'A closed reconciliation is frozen; reopen it with a reason first.'),
    ('FINANCE_RECONCILIATION_UNBALANCED',409,'A reconciliation whose difference is not zero cannot be closed.'),
    ('FINANCE_COLLECTION_RACE',      409, 'Another transaction recorded this collection first; nothing was duplicated.'),
    ('FINANCE_BANK_IMPORT_STATE',    409, 'That import is not in a state this action allows.'),
    ('FINANCE_BANK_TXN_NOT_FOUND',   404, 'That bank transaction does not exist.'),
    ('FINANCE_BANK_EXCLUDE_REASON_REQUIRED',422,'Excluding a bank transaction needs a reason.'),
    ('FINANCE_ACCOUNT_IN_USE',       409, 'The account is a settings default or a plan''s income account, so it cannot be deactivated.'),
    ('FINANCE_RECURRING_INVALID',    422, 'A recurring template is missing a field, uses an inactive account, or has a schedule that does not match its cadence.'),
    -- ── Finance parity (#59) ──
    ('FINANCE_RECLASSIFY_INVALID',   422, 'Only income to income, expense to expense, or expense to owner''s draw, on an unreversed entry, with a reason.'),
    ('FINANCE_PRESET_INVALID',       422, 'An expense preset needs a unique name and an active expense or owner''s draw account.'),
    ('FINANCE_BANK_TXN_LINKED',      409, 'The statement line, or the entry, is already added, matched, excluded or reconciled.'),
    ('FINANCE_BANK_TXN_NOT_LINKED',  409, 'The statement line is not added or matched in the bank feed, so there is nothing to undo.'),
    ('FINANCE_BANK_MATCH_MISMATCH',  422, 'The entry does not move the statement''s account by the same signed amount.'),
    ('FINANCE_BANK_CATEGORY_INVALID',422, 'A statement line must be added to an active account other than its own.'),
    ('FINANCE_ENTRY_HAS_ADJUSTMENTS',409, 'The entry has a reclassification that still stands; reverse that first.'),
    ('FINANCE_BANK_ENROLLMENT_INCOME',409, 'A deposit cannot be added to an account approvals post to; match it to the approval instead.'),
    -- ── Enrollment management (#60) ──
    ('ENROLLMENT_NOT_PENDING',       409, 'Only a request still awaiting review can be held or corrected.'),
    ('ENROLLMENT_HOLD_INVALID',      422, 'A hold needs a reason and a follow-up date that is not in the past, or the request is not on hold.'),
    ('ENROLLMENT_AMOUNT_INVALID',    422, 'An amount correction needs a reason and an amount between 0 and 1,000,000.'),
    ('ENROLLMENT_APPROVE_VIA_RPC',   409, 'A request can only be approved together with its membership grant.'),
    -- ── Communications (#61) ──
    ('COMM_AUDIENCE_INVALID',        422, 'The audience is not valid for this kind of message.'),
    ('COMM_AUDIENCE_EMPTY',          422, 'No one matches this audience.'),
    ('COMM_MESSAGE_INVALID',         422, 'A message needs a subject of up to 200 characters and a body of up to 20,000.'),
    ('COMM_DAILY_CAP',               429, 'Sending this would pass today''s email limit.'),
    ('COMM_RULE_INVALID',            422, 'The automation rule is incomplete or inconsistent.'),
    ('COMM_NOT_FOUND',               404, 'The campaign or automation rule does not exist.'),
    ('COMM_CAMPAIGN_CLOSED',         409, 'The campaign was cancelled.'),
    ('COMM_CAP_INVALID',             422, 'The daily limit must be between 1 and 50,000.'),
    ('MEETING_INVALID',              422, 'The meeting, invitation or template details are incomplete or inconsistent.'),
    ('MEETING_NOT_FOUND',            404, 'The meeting or meeting template does not exist.'),
    ('TASK_INVALID',                 422, 'A task needs a title of up to 300 characters and a day, week or month.'),
    ('TASK_NOT_FOUND',               404, 'The task does not exist.'),
    ('ZOOM_NOT_CONNECTED',           503, 'Zoom is not connected: the server Zoom credentials are missing or were refused.'),
    ('ZOOM_REQUEST_FAILED',          502, 'Zoom did not complete the request.'),
    ('MEETING_LOG_FAILED',           502, 'The meeting was created in Zoom but could not be recorded here, so no invitations were sent.'),
    ('FINANCE_COLLECTION_AMOUNT_INVALID',422, 'The enrollment records an amount outside the range a collection may post.'),
    ('LESSON_ASSET_FORBIDDEN',       403, 'You cannot manage images for that course.'),
    ('LESSON_ASSET_NOT_FOUND',       404, 'The lesson image does not exist.'),
    ('LESSON_ASSET_IN_USE',          409, 'The image is still used by a lesson, so it was not deleted.'),
    ('LESSON_ASSET_LIMIT',           422, 'A lesson may show at most 10 images.'),
    ('LESSON_ASSET_ALT_REQUIRED',    422, 'Every lesson image needs a short description for screen readers.'),
    ('LESSON_ASSET_BAD_PATH',        422, 'The image object path is not the shape a lesson asset uses.'),
    ('LESSON_ASSET_UNKNOWN_REF',     422, 'The lesson cites an image that does not exist, or that belongs to an unrelated course.')
  ) as t(code, http, summary);
$cat$;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-20-course-lesson-assets.sql', null,
  'course lesson instructions (#65): course_lessons.content_format (plain|markdown, default '
  'plain so nothing existing is reinterpreted), plus course_lesson_assets and '
  'course_lesson_asset_refs over a new PRIVATE course-lesson-assets bucket (10 MiB, '
  'png/jpeg/webp). References are DERIVED by course_lesson_sync_assets() from the saved '
  'text in the same transaction, so a direct PostgREST write cannot desync them, cite an '
  'unrelated course''s image, omit alt text or exceed 10 images. Reads are reference-based '
  '(course_lesson_asset_object_readable mirrors courses_read incl. the sampler rule), which '
  'is also what makes a duplicated course work; writes are path-parsed by a NEW parser that '
  'fails closed and does not loosen course_object_course_id. An asset outlives its origin '
  'course (course_id ON DELETE SET NULL), because cascading would delete the row out from '
  'under a duplicate that legitimately shows the same image. Three RPCs, no client write '
  'path on either table. Patches course_ai_mark_lesson_stale() in place to watch '
  'content_format. No permission changes (22 permissions / 35 grants); 119 error codes.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The bucket is private and bounded:
--      select public, file_size_limit, allowed_mime_types
--        from storage.buckets where id = 'course-lesson-assets';
--      -> f | 10485760 | {image/png,image/jpeg,image/webp}
--    If §3 raised a NOTICE, create it by hand in Dashboard -> Storage with those settings.
--    ★ The PROJECT-WIDE upload limit caps every bucket (min(bucket, project-wide)) and is
--      not in any SQL. It is already 2 GiB for lesson video, so 10 MiB images are fine —
--      confirm with `npm run storage:config` if uploads 413.
--
-- 2) No client write path on either table:
--      select has_table_privilege('authenticated','public.course_lesson_assets','insert');      -> f
--      select has_table_privilege('authenticated','public.course_lesson_asset_refs','insert');  -> f
--
-- 3) Nothing moved:
--      select count(*) from public.staff_permissions;       -> 22
--      select count(*) from public.staff_role_permissions;  -> 35
--      select count(*) from public.app_error_catalog();      -> 119
--
-- 4) The trainer notices a conversion:
--      select prosrc like '%new.content_format%' from pg_proc
--       where proname = 'course_ai_mark_lesson_stale';       -> t
--
-- 5) In the app, open a course lesson as an admin, add a link and paste a screenshot,
--    save, then view it as a student: the instructions appear below the video.
