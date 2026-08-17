-- ═══════════════════════════════════════════════════════════════════════════
-- #38 — Batch lifecycle: editable records, a past-lock, and automatic closure
--
-- WHY
--   Admin → Batches can create a batch and toggle its status. Nothing else. The
--   period columns #32 shipped (starts_on / ends_on / timezone) have never been
--   written, so three things are broken at once:
--
--   ① A TYPO IS PERMANENT. The live registry holds a batch displayed as
--      "August" whose code is 2026-09, and one displayed as "October" coded
--      2026-10. There is no in-app path to either. But `code` is NOT a label:
--      grant_batch_run() scans `where b.code >= v_start.code and b.status='open'
--      order by b.code … for update`, and allocate_queued_entitlements() applies
--      a forward-only floor `v_b.code > max(code the run already holds)`. A
--      careless re-code silently REORDERS a member's already-purchased run. So
--      the code cannot be a plain client UPDATE, and the fix is not "add an
--      input" — it is a guarded RPC plus a privilege that makes the direct path
--      impossible.
--
--   ② NOTHING EVER CLOSES. ends_on is NULL on every row and no code reads it, so
--      a batch stays `open` after its month ends — still offered in the student
--      checkout picker (enroll_req_own_insert admits only open batches) and
--      still absorbing queued ledger seats. Closure has always been a thing Alex
--      had to remember.
--
--   ③ "PAST" HAD NO DEFINITION. Editing must stop once a batch's period has
--      genuinely elapsed — and `closed`/`archived` is the wrong proxy, because a
--      batch can be closed early or archived while its month is still running.
--      The lock is the CALENDAR, read in the batch's OWN timezone: past means
--      today-local > ends_on, so a batch stays editable through its final local
--      day. Comparing timestamps in UTC would lock an Asia/Manila batch up to
--      16 hours early for the one admin who uses this screen.
--
-- WHAT THIS ADDS
--   • batches.closed_at / close_reason  — so a card can say "Closed
--     automatically on 1 Jan 2027" from one row read instead of an event scan.
--   • A one-time date BACKFILL from `code`, run BEFORE any guard exists.
--   • batch_is_past(ends_on, timezone)  — the ONE definition of past. Mirrored
--     by isPastBatch() in src/lib/batchLifecycle.js.
--   • batches_guard()   — BEFORE INSERT OR UPDATE. Fills the period on insert so
--     SQL-editor inserts are as reliable as the UI's; enforces the past-lock and
--     period validity on update; refuses an id change.
--   • A column-level REVOKE on batches.code — the half a trigger cannot give.
--     After this, a direct PATCH of `code` by `authenticated` is refused on
--     PRIVILEGE, whatever RLS says. The owner (SQL editor, Management API) and
--     `service_role` keep table-level UPDATE, so batches_guard() ALSO re-checks
--     the code's shape and rank on every UPDATE — privilege stops the API,
--     the trigger stops the console, and admin_update_batch() is the one path
--     that does both plus the audit row.
--   • admin_update_batch()      — the transactional editor.
--   • close_due_batches()       — the idempotent sweep, plus an admin wrapper.
--   • A pg_cron job running the sweep hourly.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   • It does not rename community_spaces.slug. The slug is what `?space=` deep
--     links and the stored community:lastSpace preference key on, and
--     pickInitialSpace() falls back SILENTLY on an unknown slug — a renamed slug
--     would send bookmarks to the wrong space with no error anyone could see.
--     The slug is a permalink; only the space NAME follows the batch.
--   • It does not rewrite entitlement, subscription, audit or batch history.
--     The only ledger write is re-stamping activates_at on seats that have NOT
--     yet activated, when the admin corrects a start date.
--   • It never archives. Automatic closure sets `closed`, full stop.
--   • It does not touch expire_overdue_subscriptions(), which has the same
--     cron-hostile is_admin() guard. That is a follow-up, not this file.
--
-- ORDER
--   Run AFTER db/2026-08-01-entitlement-hardening.sql (#37).
--   Additive, idempotent, non-destructive. No table or column is dropped; no row
--   is deleted. admin_batch_overview() is DROPped and recreated (its row type
--   gains columns) and its grant is restored in the same breath.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Guards. #38 patches shapes that #32 and #35 created.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.batches') is null then
    raise exception '#38 requires #32 — run db/2026-07-28-community-spaces-batches.sql first.';
  end if;
  if to_regclass('public.batch_entitlements') is null then
    raise exception '#38 requires #35 — run db/2026-07-30-batch-entitlements.sql first.';
  end if;
  if to_regprocedure('public.app_error(text, text, int, jsonb)') is null then
    raise exception '#38 requires #35''s app_error() — run db/2026-07-30-batch-entitlements.sql first.';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) Closure provenance.
-- ───────────────────────────────────────────────────────────────────
alter table public.batches
  add column if not exists closed_at    timestamptz,
  add column if not exists close_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'batches_close_reason_check') then
    alter table public.batches
      add constraint batches_close_reason_check
      check (close_reason is null or close_reason in ('manual', 'auto', 'archive'));
  end if;
end $$;

comment on column public.batches.closed_at is
  'When the batch stopped accepting new assignments. Set by close_due_batches() (auto) or an admin.';
comment on column public.batches.close_reason is
  'manual | auto | archive. ''auto'' means the month-end sweep closed it — the card says so.';

-- ───────────────────────────────────────────────────────────────────
-- 2) BACKFILL the period from `code`. This MUST run before batches_guard
--    exists, because it writes rows that are already past and the guard is
--    about to make those read-only.
--
--    ★ This is behaviour-neutral, not a guess. `to_date(code || '-01')` is the
--    EXACT fallback grant_batch_run() (§6256) and allocate_queued_entitlements()
--    (§8151) already use to derive activates_at when starts_on is null, and
--    batches_code_check guarantees a real month. So every future allocation
--    computes precisely what it computed before this file ran, and no
--    already-stamped activates_at is touched.
--
--    Idempotent: the WHERE clause matches nothing on a second run.
-- ───────────────────────────────────────────────────────────────────
update public.batches
   set starts_on = coalesce(starts_on, to_date(code || '-01', 'YYYY-MM-DD')),
       ends_on   = coalesce(ends_on,
                     (to_date(code || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date)
 where starts_on is null
    or ends_on is null;

-- ★ And normalise any timezone Postgres does not recognise. #32 declared the
-- column `not null default 'Asia/Manila'` and never validated it, so a row
-- written by hand can hold anything. `now() at time zone 'Gotham/Central'` does
-- not return null — it RAISES 22023 — and batch_is_past() is evaluated once per
-- row by admin_batch_overview() and inside close_due_batches()'s WHERE. So a
-- single bad row would 500 the whole Batches screen and abort the sweep for
-- EVERY batch, hourly, with the failure buried in cron.job_run_details.
-- This runs before the guard exists, so it can also repair a past row.
update public.batches b
   set timezone = 'Asia/Manila'
 where coalesce(b.timezone, '') = ''
    or not exists (select 1 from pg_timezone_names z where z.name = b.timezone);

-- ───────────────────────────────────────────────────────────────────
-- 3) The error catalogue gains this file's codes. Kept in lockstep BY HAND
--    with APP_ERROR_CODES + APP_ERROR_COPY in src/lib/appErrors.js.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.app_error_catalog()
returns table (code text, http int, summary text)
language sql
immutable
parallel safe
set search_path = public
as $$
  select * from (values
    ('BATCH_REQUIRED',               422, 'A Gold/VIP action needs an explicit batch; none was supplied.'),
    ('BATCH_NOT_FOUND',              404, 'The batch id or month code does not exist.'),
    ('BATCH_CLOSED',                 409, 'The batch is closed to new assignments, or archived.'),
    ('BATCH_FULL',                   409, 'A cohort in the run has no seats left.'),
    ('NO_SPACE_FOR_SEGMENT',         409, 'The batch has no active community space for that plan segment.'),
    ('INVALID_BATCH_CODE',           422, 'Not a real YYYY-MM month.'),
    ('ENTITLEMENT_EXPIRED',          403, 'The membership term (or its grace) has ended.'),
    ('INVALID_PLAN',                 422, 'Unknown, inactive, or non-premium plan for this action.'),
    ('ALREADY_ENTITLED',             409, 'The member already holds an outstanding seat in that cohort.'),
    ('RUN_LIMIT_EXCEEDED',           409, 'Outstanding seats would exceed the per-member ceiling.'),
    ('SEGMENT_MISMATCH',             409, 'The grant would mix Gold and VIP seats in one outstanding run.'),
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

-- ───────────────────────────────────────────────────────────────────
-- 4) batch_events.action gains 'edit' and 'auto_close'.
--    Found by DEFINITION, not by name (#35's idiom) — the constraint has been
--    both anonymous and named across the file's history.
-- ───────────────────────────────────────────────────────────────────
do $$
declare
  v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.batch_events'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%action%';
  if v_con is not null then
    execute format('alter table public.batch_events drop constraint %I', v_con);
  end if;
  alter table public.batch_events
    add constraint batch_events_action_check
    check (action in (
      'create', 'open', 'close', 'archive', 'assign', 'reassign', 'unassign',
      'capacity', 'space_create',
      'entitle', 'entitle_allocate', 'entitle_revoke', 'entitle_supersede', 'entitle_extend',
      'edit', 'auto_close'
    ));
exception when undefined_table then
  raise notice '#38: public.batch_events not present — skipping its CHECK widening.';
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 5) THE definition of "past". Everything else calls this.
--
--    STABLE, not IMMUTABLE: it reads now(). An undated batch is never past —
--    failing OPEN here is deliberate, and is the opposite of lmsSchedule's
--    fail-closed anchor rule. There, a missing anchor would leak paid lessons;
--    here, a missing end date would freeze a live batch an admin still needs.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batch_is_past(p_ends_on date, p_timezone text)
returns boolean
language sql
stable
parallel safe
set search_path = public
as $$
  -- The zone is resolved through pg_timezone_names rather than passed straight to
  -- `at time zone`, which RAISES 22023 on an unknown name instead of returning
  -- null. This function is called once per row by admin_batch_overview() and in
  -- close_due_batches()'s WHERE clause, so one unrecognised zone would take out
  -- the admin screen and every future sweep rather than one batch. §2 normalises
  -- existing rows and batches_guard() rejects new ones; this is the third layer,
  -- and it degrades to the column default the same way localDateIn() does in
  -- src/lib/batchLifecycle.js — the two halves must agree even on bad input.
  select p_ends_on is not null
     and (now() at time zone (
            select coalesce(
              (select z.name from pg_timezone_names z where z.name = p_timezone),
              'Asia/Manila')
          ))::date > p_ends_on;
$$;

comment on function public.batch_is_past(date, text) is
  'A batch is past when TODAY, read in its own timezone, is later than ends_on — so it stays '
  'editable through its final local day. Mirrored by isPastBatch() in src/lib/batchLifecycle.js.';

revoke all on function public.batch_is_past(date, text) from public, anon;
grant execute on function public.batch_is_past(date, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 6) batches_guard() — column-level protection RLS cannot give.
--
--    Named `batches_guard` so it sorts BEFORE batches_touch_updated_at: Postgres
--    fires same-timing triggers in name order, and the guard must see the row
--    before updated_at is stamped.
--
--    BREAK-GLASS: a session running as the TABLE OWNER (the SQL editor, the
--    Management API) may `set local app.batch_admin_override = 'on'` to edit a
--    past batch — e.g. to correct the historical "August"/2026-09 name. Gated on
--    ownership rather than a role attribute, because Supabase's `postgres` is not
--    a superuser and a rolsuper gate would make this unreachable on the one
--    database that needs it. PostgREST connects as `authenticator`, which is not a
--    member of the owner, so the API can never reach it — and the owner could
--    disable the trigger outright anyway, so this only makes the intent explicit
--    and auditable.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batches_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
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
      'batches.id is frozen — entitlements, spaces and audit rows reference it', 409, null);
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
        format('batch %s ended on %s (%s) and cannot be reopened — create the next batch instead',
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
       or new.gold_capacity  is distinct from old.gold_capacity
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
  -- purchased run months later: the exact defect in this file's WHY ①. The RPC
  -- validates first, so for that path this is a no-op re-check.
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
$fn$;

revoke all on function public.batches_guard() from public, anon, authenticated;

drop trigger if exists batches_guard on public.batches;
create trigger batches_guard
  before insert or update on public.batches
  for each row execute function public.batches_guard();

-- ───────────────────────────────────────────────────────────────────
-- 7) Column privileges — the half a trigger cannot give.
--
--    batches_admin_all is `for all to authenticated using (is_admin())`, so
--    until now an admin could PATCH `code` straight over PostgREST. RLS has no
--    column granularity; GRANT does. After this, a REST update touching `code`
--    or `id` is refused on PRIVILEGE regardless of policy, and the SECURITY
--    DEFINER RPC below (running as owner) is the only ordinary path.
--
--    Pinned by scripts/audit-db.mjs, because a later blanket
--    `grant all on all tables in schema public` would silently undo it.
-- ───────────────────────────────────────────────────────────────────
-- These two are a pair. Revoking the table-level privilege also drops the
-- column-level grants, so a statement-at-a-time re-run (scripts/apply-db-files.mjs,
-- MCP execute_sql) has a sub-second window with no admin write access. Harmless
-- and self-healing, but do not split them across a review boundary.
revoke update on public.batches from authenticated, anon;
grant update (name, starts_on, ends_on, timezone, status,
              gold_capacity, vip_capacity, total_capacity,
              closed_at, close_reason, updated_at)
  on public.batches to authenticated;

comment on column public.batches.code is
  'The business key AND the allocation ordering key: grant_batch_run() and '
  'allocate_queued_entitlements() walk the registry in `code` order. UPDATE on this column is '
  'revoked from authenticated — change it only through admin_update_batch(), which preserves '
  'the batch''s rank in that order.';

comment on column public.community_spaces.slug is
  'PERMALINK. Derived from batches.code at creation and never rewritten — it is the value in '
  '?space=<slug> deep links and the stored community:lastSpace preference, and pickInitialSpace() '
  'falls back silently on an unknown slug. A code rename updates the space NAME only.';

-- ───────────────────────────────────────────────────────────────────
-- 8) admin_update_batch() — the transactional editor.
--    One statement's worth of validation, then the row, its two space names,
--    the not-yet-started seats, and the audit row, in one transaction.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_update_batch(
  p_batch_id       uuid,
  p_code           text,
  p_name           text,
  p_starts_on      date,
  p_ends_on        date,
  p_timezone       text,
  -- ★ NO DEFAULTS. `null` here means "unlimited", so a defaulted 6-argument call
  -- would silently REMOVE every cap — and the occupancy checks below are all
  -- `p_x is not null and …`, so none of them would fire. Omitted named arguments
  -- take defaults over PostgREST, and this function is granted to `authenticated`,
  -- so a defaulted signature would leave "not supplied" indistinguishable from
  -- "remove the cap" in exactly the surface this file otherwise locks down.
  -- The only caller already sends all nine.
  p_gold_capacity  int,
  p_vip_capacity   int,
  p_total_capacity int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
  select count(*) into v_used from public.batch_seat_holders(p_batch_id, 'gold');
  if p_gold_capacity is not null and p_gold_capacity < v_used then
    perform public.app_error('BATCH_CAPACITY_BELOW_OCCUPANCY',
      format('%s Gold seat(s) are already sold in %s', v_used, v_old.code), 409,
      jsonb_build_object('segment', 'gold', 'used', v_used, 'requested', p_gold_capacity));
  end if;

  select count(*) into v_used from public.batch_seat_holders(p_batch_id, 'vip');
  if p_vip_capacity is not null and p_vip_capacity < v_used then
    perform public.app_error('BATCH_CAPACITY_BELOW_OCCUPANCY',
      format('%s VIP seat(s) are already sold in %s', v_used, v_old.code), 409,
      jsonb_build_object('segment', 'vip', 'used', v_used, 'requested', p_vip_capacity));
  end if;

  select count(*) into v_used from (
    select h from public.batch_seat_holders(p_batch_id, 'gold') h
    union
    select h from public.batch_seat_holders(p_batch_id, 'vip') h) u;
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
         gold_capacity  = p_gold_capacity,
         vip_capacity   = p_vip_capacity,
         total_capacity = p_total_capacity,
         updated_at     = now()
   where id = p_batch_id;

  -- Dependent DISPLAY data, same transaction. The slug is NOT touched: it is a
  -- permalink (see its column comment). Only what a member reads follows.
  if v_name <> v_old.name then
    update public.community_spaces sp
       set name = case sp.kind when 'gold' then 'Gold — ' else 'VIP — ' end || v_name,
           updated_at = now()
     where sp.batch_id = p_batch_id
       and sp.kind in ('gold', 'vip');
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
              'timezone', v_old.timezone, 'gold_capacity', v_old.gold_capacity,
              'vip_capacity', v_old.vip_capacity, 'total_capacity', v_old.total_capacity),
            'after', jsonb_build_object(
              'code', v_code, 'name', v_name,
              'starts_on', p_starts_on, 'ends_on', p_ends_on,
              'timezone', v_tz, 'gold_capacity', p_gold_capacity,
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
$fn$;

comment on function public.admin_update_batch(uuid, text, text, date, date, text, int, int, int) is
  'THE editor for a batch record. Refuses a past batch, a duplicate or rank-changing code, an '
  'already-elapsed period, an unknown timezone, and a capacity below seats already sold. Renames '
  'the two space NAMES (never the slug) and re-stamps only not-yet-started activates_at, in one '
  'transaction, audited as a batch_events ''edit'' row carrying before + after.';

revoke all on function public.admin_update_batch(uuid, text, text, date, date, text, int, int, int)
  from public, anon;
grant execute on function public.admin_update_batch(uuid, text, text, date, date, text, int, int, int)
  to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 9) close_due_batches() — the sweep.
--
--    ★ NO is_admin() GUARD, DELIBERATELY. expire_overdue_subscriptions() has
--    one, and that is exactly why it can only ever run when an admin opens a
--    tab: under pg_cron there is no JWT, so auth.uid() is null and is_admin()
--    is false. This function is instead REVOKED from every client role, so the
--    scheduler (and an admin through the wrapper below) are the only callers.
--
--    Idempotent by construction: `status = 'open'` means a late or repeated run
--    matches nothing and writes no event. It never archives, and it never reads
--    or writes batch_entitlements, community_spaces or subscriptions — existing
--    members keep their seats, their private space and their history. What
--    closing DOES block is already implemented elsewhere: grant_batch_run()
--    refuses a non-open batch for a NEW seat while letting an existing
--    seat-holder's renewal through, admin_assign_batch() refuses outright,
--    enroll_req_own_insert stops students selecting it, and the FIFO binder
--    skips it.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.close_due_batches()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_closed jsonb := '[]'::jsonb;
  v_n      int   := 0;
begin
  with due as (
    update public.batches b
       set status       = 'closed',
           closed_at    = now(),
           close_reason = 'auto',
           updated_at   = now()
     where b.status = 'open'
       and public.batch_is_past(b.ends_on, b.timezone)
    returning b.id, b.code, b.ends_on, b.timezone
  ), logged as (
    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    select d.id, null, null, 'auto_close',
           jsonb_build_object('code', d.code, 'ends_on', d.ends_on,
                              'timezone', d.timezone, 'reason', 'period_ended')
      from due d
    returning batch_id, detail ->> 'code' as code
  )
  select coalesce(jsonb_agg(jsonb_build_object('batch_id', l.batch_id, 'code', l.code)
                            order by l.code), '[]'::jsonb),
         count(*)::int
    into v_closed, v_n
    from logged l;

  return jsonb_build_object('ok', true, 'closed', v_n, 'batches', v_closed, 'ran_at', now());
end;
$fn$;

comment on function public.close_due_batches() is
  'Month-end sweep: closes every OPEN batch whose period has elapsed in its own timezone, stamps '
  'close_reason = ''auto'', and writes one auto_close batch_events row each. Idempotent — a repeat '
  'or late run closes nothing. Never archives, never touches entitlements. Run hourly by the '
  'pg_cron job ''close-due-batches''; revoked from every client role.';

revoke all on function public.close_due_batches() from public, anon, authenticated;

-- The admin-triggered path: the "Run closures now" button, and the recovery
-- route if the scheduler is ever mis-configured.
create or replace function public.admin_close_due_batches()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_close_due_batches: admin only', 403, null);
  end if;
  return public.close_due_batches();
end;
$fn$;

revoke all on function public.admin_close_due_batches() from public, anon;
grant execute on function public.admin_close_due_batches() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 10) admin_batch_overview() gains the lifecycle columns.
--     DROP + CREATE: Postgres refuses to change an OUT-parameter row type in
--     place. A dropped function LOSES ITS GRANTS — the grant below is not
--     housekeeping, it is the difference between a working admin screen and a
--     403 (the same warning #35 left on this function).
-- ───────────────────────────────────────────────────────────────────
drop function if exists public.admin_batch_overview();

create function public.admin_batch_overview()
returns table (
  batch_id uuid, code text, name text, status text,
  starts_on date, ends_on date, timezone text,
  closed_at timestamptz, close_reason text, is_past boolean,
  gold_capacity int, vip_capacity int, total_capacity int,
  gold_active bigint, vip_active bigint, total_active bigint,
  gold_queued bigint, vip_queued bigint
)
language sql stable security definer set search_path = public
as $fn$
  select b.id, b.code, b.name, b.status,
         b.starts_on, b.ends_on, b.timezone,
         b.closed_at, b.close_reason,
         public.batch_is_past(b.ends_on, b.timezone) as is_past,
         b.gold_capacity, b.vip_capacity, b.total_capacity,
         (select count(*) from public.batch_seat_holders(b.id, 'gold')) as gold_active,
         (select count(*) from public.batch_seat_holders(b.id, 'vip'))  as vip_active,
         (select count(*) from (
            select h from public.batch_seat_holders(b.id, 'gold') h
            union
            select h from public.batch_seat_holders(b.id, 'vip') h) u)  as total_active,
         -- Committed demand: seats already sold that no cohort has absorbed yet.
         -- Alex needs this BEFORE setting a capacity, because queued seats are
         -- never retro-refused (they were paid for). Deliberately NOT correlated
         -- to b.id — a queued row has no batch_id, so this is a registry-wide
         -- total repeated on every row.
         (select count(*) from public.batch_entitlements e
           where e.status = 'queued' and e.segment = 'gold'
             and (e.valid_until is null or e.valid_until > now()))       as gold_queued,
         (select count(*) from public.batch_entitlements e
           where e.status = 'queued' and e.segment = 'vip'
             and (e.valid_until is null or e.valid_until > now()))       as vip_queued
    from public.batches b
   where public.is_admin()
   order by b.code desc;
$fn$;

revoke all on function public.admin_batch_overview() from public, anon;
grant execute on function public.admin_batch_overview() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 11) The scheduler. Supabase Cron is pg_cron: the job is a plain SQL call in
--     the same database, so there is no network hop, no secret and no HTTP
--     surface to protect.
--
--     HOURLY, not daily, because pg_cron schedules in UTC while each batch
--     carries its own timezone — an hourly sweep catches every local midnight
--     within the hour, whatever zones the registry holds.
--
--     Guarded: a shadow project or a restricted role that cannot create the
--     extension still applies this file cleanly and prints what to run by hand.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('close-due-batches')
    where exists (select 1 from cron.job j where j.jobname = 'close-due-batches');

  perform cron.schedule('close-due-batches', '0 * * * *',
                        $c$select public.close_due_batches();$c$);

  raise notice '#38: pg_cron job "close-due-batches" scheduled hourly.';
exception when others then
  raise notice '#38: could not schedule pg_cron (%). Enable Dashboard → Integrations → Cron, then run: '
               'select cron.schedule(''close-due-batches'', ''0 * * * *'', '
               '''select public.close_due_batches();'');', sqlerrm;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 12) Refresh PostgREST's schema cache so the new RPCs resolve immediately.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING
--   -- ① every batch now has a period
--   select code, starts_on, ends_on, timezone,
--          public.batch_is_past(ends_on, timezone) as is_past
--     from public.batches order by code;                   -- no NULLs
--
--   -- ② the code is not writable over REST
--   select has_column_privilege('authenticated','public.batches','code','UPDATE') as bad;
--   -- expect: f
--
--   -- ③ the guard is armed
--   select tgname from pg_trigger
--    where tgrelid = 'public.batches'::regclass and not tgisinternal order by tgname;
--   -- expect: batches_guard before batches_touch_updated_at
--
--   -- ④ the sweep is scheduled
--   select jobname, schedule, command from cron.job where jobname = 'close-due-batches';
--   select * from cron.job_run_details where jobname = 'close-due-batches'
--    order by start_time desc limit 5;
--
--   -- ⑤ the sweep is idempotent — run it twice, the second closes nothing
--   select public.close_due_batches();
--   select public.close_due_batches();                     -- "closed": 0
--
--   -- ⑥ what it did
--   select created_at, action, detail from public.batch_events
--    where action in ('auto_close','edit') order by created_at desc limit 20;
--
-- BREAK-GLASS (SQL editor / table-owner session only) — edit a PAST batch, e.g.
-- to correct the historical "August" / 2026-09 display name:
--   begin;
--     set local app.batch_admin_override = 'on';
--     update public.batches set name = 'September 2026' where code = '2026-09';
--   commit;
-- ═══════════════════════════════════════════════════════════════════

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-16-batch-lifecycle.sql', null,
  'batch lifecycle (#38): batches.closed_at/close_reason + a one-time period backfill from `code` '
  '(the same derivation grant_batch_run already used, so allocation behaviour is unchanged); '
  'batch_is_past() defines "past" as today-in-the-batch''s-own-timezone > ends_on; batches_guard() '
  'fills the period on insert and freezes a past batch''s fields; UPDATE on batches.code is REVOKED '
  'from authenticated so admin_update_batch() is the only path, and that RPC preserves the batch''s '
  'rank in `code` order because grant_batch_run/allocate_queued_entitlements allocate by it; '
  'community_spaces.slug is documented as a permalink and never renamed; close_due_batches() is an '
  'idempotent hourly pg_cron sweep that closes (never archives) due open batches')
-- schema_migrations.filename is the PRIMARY KEY, so a bare insert makes this file
-- fail on a second run — the header calls it idempotent, and every other statement
-- above is. That is the same defect the #35 row records ("was not re-runnable"),
-- and it is exactly what a shadow-project rehearsal or a retry after a partial
-- apply would hit. Added 2026-08-17, after the file had already been applied to
-- production; the row it wrote is unaffected.
on conflict (filename) do nothing;
