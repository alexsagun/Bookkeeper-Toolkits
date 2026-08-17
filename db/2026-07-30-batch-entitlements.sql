-- ═══════════════════════════════════════════════════════════════════════════
-- #35 — batch_entitlements: the durable cohort-seat ledger
--
-- WHY
--   Until now a member's cohort membership was ONE nullable, mutable column:
--   subscriptions.batch_id. That column cannot express the product:
--     • a 180-day Gold plan buys SIX monthly cohorts (D1), not one;
--     • reassigning a member OVERWRITES the record of why they had access, so
--       "which batches has this student been in, and why?" is unanswerable;
--     • user_community_space_ids() read exactly one subscription (limit 1) and
--       its single batch_id, so multi-cohort access was impossible by construction.
--
--   #35 introduces public.batch_entitlements — an append-only ledger where one
--   row is ONE SEAT IN ONE COHORT, stamped with WHY it exists (grant_reason +
--   the source subscription/request/import row), WHERE it sits in the purchased
--   run (batch_index), and HOW LONG it lasts (valid_until). History is never
--   rewritten; a seat is withdrawn by revoking it, not by editing it.
--
-- THE ONE AUTHORITATIVE ENTITLEMENT SOURCE
--   Three layers. Each reads only the layer below. Nothing re-derives a lower one.
--
--     L2  CAPABILITY  user_community_capabilities()  (#36)
--                     user_batch_course_access()     (#37)
--     L1  SCOPE       ★ public.batch_entitlements ★
--                     user_entitled_batches(p_user) · batch_seat_holders()
--                     user_community_space_ids(p_user) · my_* wrappers
--     L0  MEMBERSHIP  user_is_enrolled() · user_is_approved() · user_plan_key()
--                     ↑ these ALREADY EXIST (#27). #35 must NOT redefine them —
--                       they are the AI trainer's authorization mirrors, and a
--                       create-or-replace here would silently change who can
--                       talk to the paid course trainer. The preflight asserts
--                       their bodies are intact instead.
--
-- TWO PREDICATES, ONE CORE (read this before editing either)
--   OCCUPANCY (capacity) — batch_seat_holders(batch, segment):
--       status='active' AND batch_id=B AND segment=S
--       AND (valid_until is null or valid_until > now())
--       AND segment = the member's LIVE plan segment
--   ACCESS (RLS) — user_entitled_batches(p_user): the same, PLUS
--       AND (activates_at is null or activates_at <= now())
--   The single difference is activates_at. A seat in next month's cohort is
--   OCCUPIED (it was sold, it consumes capacity — D8) but does not yet GRANT
--   access. Collapsing these two would either let capacity be oversold or reveal
--   a cohort before it starts.
--
-- LIVE PLAN RECONCILIATION (the security conjunct — do not remove)
--   Both predicates require e.segment = the member's CURRENT plan segment.
--   #32 had this property for free because it joined the live subscription to
--   enrollment_plans. Stamping entitlements loses it, and without the conjunct a
--   member who downgrades, refunds, or charges back keeps the ₱9,999 Gold space
--   forever. With it, the instant their live plan stops selling that segment,
--   every stamped row for it stops resolving. revoke_batch_run() is ALSO
--   implemented — as bookkeeping, not as the control.
--
-- REGISTRY ALLOCATION, NEVER CALENDAR ARITHMETIC
--   A seat does not compute a month. grant_batch_run() walks the batches
--   REGISTRY in `code` order and takes the next N cohorts that actually exist.
--   A shortfall is recorded as status='queued' (batch_id null) and bound by a
--   FIFO trigger when the next batch is created. Computing `start + N months`
--   would violate the project's non-negotiable rule (src/lib/communitySpaces.js:11
--   — a batch is NEVER inferred from a date) and would promise cohorts that
--   Alex, who skips months, may never run.
--
-- LOCK ORDER
--   grant_batch_run() is the ONLY function that locks `batches`, and it always
--   locks in ascending `code` order in a single statement. admin_finalize_enrollment
--   and admin_assign_batch therefore no longer take their own batch lock —
--   doing so inverted the order against the run and could deadlock two
--   concurrent approvals into overlapping runs.
--
-- ORDER
--   Run AFTER db/2026-07-29-batch-hardening-followup.sql (#34).
--   Idempotent, additive, non-destructive. Nothing is dropped; no data is deleted.
--   subscriptions.batch_id keeps being written as the start-batch cache and keeps
--   working as a read bridge for members who predate the ledger (#39 retires it).
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and run once, then confirm the
--   verification block at the tail. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 0) Preflight — abort with an actionable message, never degrade silently.
-- ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.batches') is null or to_regclass('public.community_spaces') is null then
    raise exception '#35 requires #32 — run db/2026-07-28-community-spaces-batches.sql first.';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#35 requires #31 — run db/2026-07-26-schema-migrations-log.sql first (the tail insert would abort).';
  end if;
  if to_regproc('public.admin_finalize_enrollment') is null then
    raise exception '#35 requires #32 (admin_finalize_enrollment).';
  end if;

  -- #34 restored four things #33's rewrite dropped (updated_at, the rejected_*
  -- clearing, rejection_reason = null, most-recent-approval semantics). #35's
  -- base text is #34's, so applying on a #33-only database would re-lose them.
  --
  -- The check must stay true AFTER #35 has run, or this file stops being
  -- re-runnable (#35 replaces admin_finalize_enrollment, and its replacement no
  -- longer contains v_holds_seat — that concept moved into grant_batch_run).
  -- So: the housekeeping marker must be present, and the body must be either
  -- #34's (v_holds_seat) or #35's own (grant_batch_run). #31's apply-log is
  -- accepted as independent evidence for installs that logged the run.
  if not exists (select 1 from public.schema_migrations
                  where filename = '2026-07-29-batch-hardening-followup.sql')
     and not exists (
       select 1 from pg_proc
        where proname = 'admin_finalize_enrollment'
          and prosrc like '%rejected_at = null%'
          and (prosrc like '%v_holds_seat%' or prosrc like '%grant_batch_run%')
     ) then
    raise exception '#35 requires BOTH #33 and #34 — run db/2026-07-29-batch-hardening-followup.sql first.';
  end if;

  -- L0 mirrors belong to #27. Assert, never replace.
  -- to_regPROCEDURE, not to_regproc: only the former parses an argument list —
  -- to_regproc('f(uuid)') silently returns NULL, which would make this guard
  -- fire on a perfectly good database.
  if to_regprocedure('public.user_is_enrolled(uuid)') is null
     or to_regprocedure('public.user_is_approved(uuid)') is null
     or to_regprocedure('public.user_plan_key(uuid)') is null then
    raise exception '#35 requires #27 — db/2026-07-24-course-ai-trainer.sql supplies user_is_enrolled/user_is_approved/user_plan_key.';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'user_is_enrolled'
       and prosrc like '%grace_ends_at%' and prosrc like '%not exists%'
  ) then
    raise exception '#35: user_is_enrolled(uuid) has drifted from #27''s body — reconcile before proceeding.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='enrollment_plans' and column_name='community_segment'
  ) then
    raise exception '#35 requires enrollment_plans.community_segment (#32).';
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 1) app_error() — stable, machine-readable error codes across PostgREST.
--
--    SQLSTATE 'PT###' is PostgREST's HTTP-status override. The code itself
--    rides in HINT (the client's branch key) and, redundantly, inside a JSON
--    envelope in DETAIL — so a proxy that strips one still leaves the other.
--    The MESSAGE stays a human sentence, which is what an admin reads when the
--    client does not know the code yet.
--
--    Clients branch on `hint`. They must NOT branch on the HTTP status: PT###
--    is a PostgREST convention, not a Postgres guarantee, so if that mapping
--    ever changes the status degrades while hint/details keep working.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.app_error(
  p_code    text,
  p_message text,
  p_http    int default 400,
  p_context jsonb default null
)
returns void
language plpgsql
-- VOLATILE (the default) on purpose: this function's entire job is to raise.
-- Marking it IMMUTABLE would invite the planner to constant-fold a call with
-- literal arguments, moving the raise from execution time to plan time.
volatile
set search_path = public
as $$
begin
  raise exception using
    errcode = 'PT' || lpad(greatest(400, least(599, coalesce(p_http, 400)))::text, 3, '0'),
    message = p_message,
    detail  = jsonb_build_object('code', p_code, 'context', coalesce(p_context, '{}'::jsonb))::text,
    hint    = p_code;
end;
$$;

revoke all on function public.app_error(text, text, int, jsonb) from public, anon, authenticated;

-- The catalog, readable by the client so it can render safe fallback copy for a
-- code it does not know yet — and so a test can diff it against APP_ERROR_CODES
-- in src/lib/appErrors.js. Adding a code in SQL before the client ships is safe.
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
    ('COURSE_HAS_SUBMISSIONS',       409, 'The course has graded assignment work and cannot be deleted.')
  ) as t(code, http, summary);
$$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 2) Column additions + the updated_at trigger #32 forgot.
-- ───────────────────────────────────────────────────────────────────

-- D1's override. NULL = derive from access_days. Pinning Gold back to 2 cohorts
-- is then a one-row UPDATE with no migration.
alter table public.enrollment_plans
  add column if not exists eligible_batch_count int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'enrollment_plans_eligible_batch_count_check') then
    alter table public.enrollment_plans
      add constraint enrollment_plans_eligible_batch_count_check
      check (eligible_batch_count is null or (eligible_batch_count between 1 and 24));
  end if;
end $$;

comment on column public.enrollment_plans.eligible_batch_count is
  'D1 override for how many monthly cohorts this plan grants. NULL = derive ceil(access_days/30). '
  'Mirrored by planBatchCount() in src/lib/batchEntitlements.js — keep in lockstep.';

-- A combined cap alongside the per-segment ones. NULL = unlimited, as before.
alter table public.batches
  add column if not exists total_capacity int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'batches_total_capacity_check') then
    alter table public.batches
      add constraint batches_total_capacity_check
      check (total_capacity is null or total_capacity > 0);
  end if;
end $$;

comment on column public.batches.total_capacity is
  'Combined gold+vip seat cap for this cohort. NULL = unlimited. Checked alongside '
  'gold_capacity/vip_capacity by grant_batch_run(). Under D8 a seat is consumed in EVERY '
  'cohort of a member''s run, so one 6-cohort Gold approval consumes one seat in six batches.';

-- #32 created batches/community_spaces with updated_at defaults but no trigger,
-- so the column has silently never advanced. Admin screens sort by it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists batches_touch_updated_at on public.batches;
create trigger batches_touch_updated_at
  before update on public.batches
  for each row execute function public.touch_updated_at();

drop trigger if exists community_spaces_touch_updated_at on public.community_spaces;
create trigger community_spaces_touch_updated_at
  before update on public.community_spaces
  for each row execute function public.touch_updated_at();

-- batch_events is the immutable admin audit trail; widen its vocabulary for the
-- ledger's actions. Strictly more permissive, so no existing row can fail.
do $$
declare v_con text;
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
      'entitle', 'entitle_allocate', 'entitle_revoke', 'entitle_supersede', 'entitle_extend'
    ));
exception when undefined_table then
  raise notice '#35: public.batch_events not present — skipping its CHECK widening.';
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 3) batch_entitlements — L1, the ledger.
-- ───────────────────────────────────────────────────────────────────
create table if not exists public.batch_entitlements (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,

  -- The ALLOCATED cohort. NULL while the seat is queued: it was paid for, but
  -- the cohort it will occupy does not exist in the registry yet.
  batch_id               uuid references public.batches(id) on delete restrict,
  segment                text not null check (segment in ('gold', 'vip')),

  -- Position in the member's purchased run (0-based) and the run it belongs to.
  -- batch_index is the FIFO ordering key, not a month number.
  batch_index            int  not null check (batch_index >= 0 and batch_index < 24),
  run_id                 uuid not null,
  run_length             int  not null check (run_length between 1 and 24),

  status                 text not null default 'queued'
                         check (status in ('queued', 'active', 'revoked', 'superseded')),

  -- WHY this seat exists. Never inferred.
  grant_reason           text not null check (grant_reason in
                           ('approval', 'renewal', 'extension', 'upgrade', 'import', 'admin_manual', 'backfill')),
  source_subscription_id uuid references public.subscriptions(id)       on delete set null,
  source_plan_key        text references public.enrollment_plans(key)   on delete set null on update cascade,
  source_request_id      uuid references public.enrollment_requests(id) on delete set null,
  source_import_row_id   uuid,
  granted_by             uuid references public.profiles(id) on delete set null,
  granted_at             timestamptz not null default now(),

  -- HOW LONG. Stamped from the source term's coalesce(grace_ends_at, ends_at).
  -- Forward-only: an extension advances it, nothing moves it back.
  valid_until            timestamptz,
  -- WHEN it starts granting access. Stamped at allocation from batches.starts_on.
  activates_at           timestamptz,
  allocated_at           timestamptz,

  revoked_at             timestamptz,
  revoked_by             uuid references public.profiles(id) on delete set null,
  revoke_reason          text,
  superseded_by_run_id   uuid,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint batch_entitlements_active_bound   check (status <> 'active' or batch_id is not null),
  constraint batch_entitlements_queued_unbound check (status <> 'queued' or batch_id is null),
  constraint batch_entitlements_revoked_shape  check ((status = 'revoked') = (revoked_at is not null))
);

-- student_import_rows may not exist on an install that skipped #26; add the FK
-- conditionally so the ledger still works there.
do $$
begin
  if to_regclass('public.student_import_rows') is not null
     and not exists (select 1 from pg_constraint where conname = 'batch_entitlements_source_import_row_fk') then
    alter table public.batch_entitlements
      add constraint batch_entitlements_source_import_row_fk
      foreign key (source_import_row_id) references public.student_import_rows(id) on delete set null;
  end if;
end $$;

comment on table public.batch_entitlements is
  'L1 — THE authoritative cohort-entitlement source (#35). One row = one seat in one cohort. '
  'Append-only: history is never rewritten, only revoked/superseded. Writes go exclusively through '
  'the SECURITY DEFINER RPCs; authenticated holds SELECT on own rows and nothing else.';

-- Indexes. Each serves a named query shape; see db/README.md.
-- THE RLS hot path: user_entitled_batches runs once per statement (InitPlan) on
-- every community read and write and every LMS read. Index-only, ~6 rows/user.
create index if not exists batch_entitlements_user_active_idx
  on public.batch_entitlements (user_id)
  include (batch_id, segment, valid_until, activates_at)
  where status = 'active' and batch_id is not null;

-- batch_seat_holders(): the capacity count inside grant_batch_run (once per
-- candidate, under the lock) and every admin_batch_overview count.
create index if not exists batch_entitlements_batch_segment_idx
  on public.batch_entitlements (batch_id, segment)
  include (user_id, valid_until)
  where status = 'active';

-- The FIFO binder and admin_reconcile_queued_entitlements().
create index if not exists batch_entitlements_queued_fifo_idx
  on public.batch_entitlements (segment, granted_at, batch_index)
  where status = 'queued';

-- Member panel + admin drill-down; also covers the user_id FK (ON DELETE CASCADE).
create index if not exists batch_entitlements_user_granted_idx
  on public.batch_entitlements (user_id, granted_at desc);

-- Covers the batch_id FK (ON DELETE RESTRICT scans this on every batch delete)
-- and the batch roster query.
create index if not exists batch_entitlements_batch_idx
  on public.batch_entitlements (batch_id);

-- FK cover + the drift view's join + "what did this term grant?".
create index if not exists batch_entitlements_source_sub_idx
  on public.batch_entitlements (source_subscription_id);

-- FK cover + the approve receipt.
create index if not exists batch_entitlements_source_request_idx
  on public.batch_entitlements (source_request_id);

-- CORRECTNESS: a member can never hold two outstanding seats in one cohort.
-- NOTE: this index protects BOUND seats only — a queued seat has batch_id NULL
-- and is therefore outside it, which is why admin_grant_batch_run needs its own
-- ALREADY_ENTITLED check (#37) to stay idempotent.
create unique index if not exists batch_entitlements_one_seat_per_cohort
  on public.batch_entitlements (user_id, batch_id)
  where status in ('queued', 'active') and batch_id is not null;

-- Exact per-approval idempotency: re-running a grant for the same request
-- cannot duplicate the run. The ON CONFLICT inference target.
create unique index if not exists batch_entitlements_request_seat_uniq
  on public.batch_entitlements (user_id, source_request_id, batch_index)
  where status in ('queued', 'active') and source_request_id is not null;

-- Import idempotency (mirrors subscriptions.source_import_row_id's partial unique).
create unique index if not exists batch_entitlements_import_seat_uniq
  on public.batch_entitlements (source_import_row_id, batch_index)
  where status in ('queued', 'active') and source_import_row_id is not null;

alter table public.batch_entitlements enable row level security;

-- ONE permissive SELECT policy rather than the house *_read + *_admin_all pair,
-- so this table adds nothing to the 31 multiple_permissive_policies advisor
-- findings. Both branches are (select …)-wrapped per #29 (InitPlan once).
drop policy if exists batch_entitlements_read on public.batch_entitlements;
create policy batch_entitlements_read on public.batch_entitlements
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- NO insert/update/delete policy — writes go only through the SECURITY DEFINER
-- RPCs (the community_notifications precedent).
--
-- ★ The revoke is load-bearing and is NOT implied by the missing policy:
-- Supabase's default grants leave `authenticated` holding table-level DML, and
-- RLS without a policy denies... but only while RLS stays enabled. Belt and
-- braces on the table that decides who is in a ₱9,999 cohort.
revoke insert, update, delete, truncate on public.batch_entitlements from authenticated, anon, public;
grant select on public.batch_entitlements to authenticated;

drop trigger if exists batch_entitlements_touch_updated_at on public.batch_entitlements;
create trigger batch_entitlements_touch_updated_at
  before update on public.batch_entitlements
  for each row execute function public.touch_updated_at();

-- ───────────────────────────────────────────────────────────────────
-- 4) Run length (D1). Pure integer arithmetic — no date maths anywhere.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.plan_batch_count(p_access_days int, p_override int)
returns int
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
           when p_override is not null then least(24, greatest(1, p_override))
           when p_access_days is null or p_access_days <= 0 then null   -- caller MUST fail closed
           else least(24, greatest(1, ceil(p_access_days / 30.0)::int))
         end;
$$;

-- Pure arithmetic, but there is no reason for anon to hold it. authenticated
-- keeps EXECUTE because plan_eligible_batch_count() runs with invoker rights
-- and calls straight through to it.
revoke all on function public.plan_batch_count(int, int) from public, anon;
grant execute on function public.plan_batch_count(int, int) to authenticated;

comment on function public.plan_batch_count(int, int) is
  'D1: coalesce(override, ceil(access_days/30)), clamped 1..24. NULL for a lifetime plan so the '
  'caller fails closed rather than granting unlimited cohorts. Mirrored by planBatchCount() in '
  'src/lib/batchEntitlements.js (test/batchEntitlements.test.mjs pins the truth table).';

create or replace function public.plan_eligible_batch_count(p_plan_key text)
returns int
language sql
stable
parallel safe
set search_path = public
as $$
  select public.plan_batch_count(ep.access_days, ep.eligible_batch_count)
    from public.enrollment_plans ep
   where ep.key = p_plan_key;
$$;

revoke all on function public.plan_eligible_batch_count(text) from public, anon;
grant execute on function public.plan_eligible_batch_count(text) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 5) Guard trigger — the layer that survives a policy mistake.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batch_entitlements_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seg_ok boolean;
begin
  if tg_op = 'INSERT' then
    -- A bound seat must have a real, active space for its segment. This is what
    -- makes "granted into a cohort with no Gold space" impossible rather than
    -- merely unlikely.
    if new.batch_id is not null then
      select exists (
        select 1 from public.community_spaces sp
         where sp.batch_id = new.batch_id and sp.kind = new.segment and sp.active
      ) into v_seg_ok;
      if not v_seg_ok then
        perform public.app_error('NO_SPACE_FOR_SEGMENT',
          format('batch has no active %s space', new.segment), 409,
          jsonb_build_object('batch_id', new.batch_id, 'segment', new.segment));
      end if;
    end if;

    -- valid_until may never outlive the source term.
    if new.valid_until is not null and new.source_subscription_id is not null then
      if exists (
        select 1 from public.subscriptions s
         where s.id = new.source_subscription_id
           and s.ends_at is not null
           and new.valid_until > coalesce(s.grace_ends_at, s.ends_at) + interval '1 minute'
      ) then
        perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
          'entitlement would outlive its source subscription term', 409,
          jsonb_build_object('source_subscription_id', new.source_subscription_id));
      end if;
    end if;

    -- granted_by, when set, must be an admin.
    if new.granted_by is not null
       and not coalesce((select p.is_admin from public.profiles p where p.id = new.granted_by), false) then
      perform public.app_error('FORBIDDEN', 'granted_by must reference an admin', 403, null);
    end if;

    if new.batch_index >= new.run_length then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'batch_index must be inside the run', 409,
        jsonb_build_object('batch_index', new.batch_index, 'run_length', new.run_length));
    end if;

    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────
  -- Frozen identity/provenance columns. Rewriting any of these would destroy
  -- the audit answer to "why did this member have access?".
  if new.user_id     is distinct from old.user_id
     or new.segment      is distinct from old.segment
     or new.batch_index  is distinct from old.batch_index
     or new.run_id       is distinct from old.run_id
     or new.run_length   is distinct from old.run_length
     or new.grant_reason is distinct from old.grant_reason
     or new.granted_at   is distinct from old.granted_at
     or new.created_at   is distinct from old.created_at then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batch entitlement identity columns are frozen', 409, null);
  end if;

  -- ★ Provenance FKs and granted_by may transition to NULL. That is Postgres
  -- executing ON DELETE SET NULL / ON UPDATE CASCADE, which arrives here as an
  -- UPDATE. Freezing them outright would make every referenced profile,
  -- request, subscription and plan key permanently undeletable — a reviewer
  -- found exactly this. Reject only non-null → a DIFFERENT non-null.
  if (old.source_subscription_id is not null and new.source_subscription_id is not null
      and new.source_subscription_id is distinct from old.source_subscription_id)
     or (old.source_plan_key is not null and new.source_plan_key is not null
         and new.source_plan_key is distinct from old.source_plan_key)
     or (old.source_request_id is not null and new.source_request_id is not null
         and new.source_request_id is distinct from old.source_request_id)
     or (old.source_import_row_id is not null and new.source_import_row_id is not null
         and new.source_import_row_id is distinct from old.source_import_row_id)
     or (old.granted_by is not null and new.granted_by is not null
         and new.granted_by is distinct from old.granted_by) then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'batch entitlement provenance cannot be re-pointed', 409, null);
  end if;

  -- batch_id: NULL → a real id exactly once (allocation). Never re-pointed,
  -- never cleared. Moving a member between cohorts revokes and re-grants, so
  -- the old seat stays in the record.
  if old.batch_id is not null and new.batch_id is distinct from old.batch_id then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'an allocated seat cannot be moved — revoke it and grant a new one', 409,
      jsonb_build_object('batch_id', old.batch_id));
  end if;

  -- status: queued → active → {revoked|superseded}, both terminal.
  if old.status <> new.status then
    if old.status in ('revoked', 'superseded') then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        format('%s is a terminal entitlement status', old.status), 409, null);
    end if;
    if old.status = 'active' and new.status = 'queued' then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'an allocated seat cannot return to the queue', 409, null);
    end if;
  end if;

  -- valid_until is forward-only. Clearing it (→ NULL) would silently grant
  -- perpetual access; shortening it is a revoke, which has its own path.
  if old.valid_until is not null
     and (new.valid_until is null or new.valid_until < old.valid_until)
     and new.status not in ('revoked', 'superseded') then
    perform public.app_error('IMMUTABLE_ENTITLEMENT',
      'valid_until only moves forward — revoke the seat to end it early', 409, null);
  end if;

  return new;
end;
$$;

-- A trigger function needs no EXECUTE grant to fire from its trigger, and
-- Postgres refuses a direct call anyway ("trigger functions can only be called
-- as triggers"). But it is SECURITY DEFINER, so leaving the default PUBLIC
-- EXECUTE in place raises a Supabase advisor finding — and a definer function
-- reachable by anon is the wrong shape to normalise, exploitable or not.
revoke all on function public.batch_entitlements_guard() from public, anon, authenticated;

drop trigger if exists batch_entitlements_guard_trg on public.batch_entitlements;
create trigger batch_entitlements_guard_trg
  before insert or update on public.batch_entitlements
  for each row execute function public.batch_entitlements_guard();

-- ───────────────────────────────────────────────────────────────────
-- 6) batch_seat_holders() — THE occupancy predicate (capacity).
--
--    Counts members who OCCUPY a seat in (batch, segment): sold and unexpired,
--    whether or not the cohort has started (D8). Used by grant_batch_run's
--    capacity check, admin_batch_overview, and the batch roster.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.batch_seat_holders(p_batch_id uuid, p_segment text)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.user_id
    from public.batch_entitlements e
    join public.profiles pr on pr.id = e.user_id
    -- LIVE plan reconciliation: a downgraded/refunded member stops occupying a
    -- seat the moment their current plan stops selling this segment.
    join lateral (
      select coalesce(ep.community_segment, 'general') as segment
        from public.subscriptions s
        left join public.enrollment_plans ep on ep.key = s.plan_key
       where s.user_id = e.user_id
         and s.status = 'active'
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       order by s.created_at desc
       limit 1
    ) live on true
   where e.batch_id = p_batch_id
     and e.segment = p_segment
     and e.status = 'active'
     and (e.valid_until is null or e.valid_until > now())
     and live.segment = e.segment
     and (pr.approval_status = 'approved' or pr.is_admin)
   group by e.user_id;
$$;

revoke all on function public.batch_seat_holders(uuid, text) from public, anon, authenticated;

comment on function public.batch_seat_holders(uuid, text) is
  'Occupancy predicate: who consumes a seat in (batch, segment). Differs from the ACCESS predicate '
  '(user_entitled_batches) by ONE conjunct — it ignores activates_at, because a seat in a future '
  'cohort is sold and therefore consumes capacity (D8) without yet granting access.';

-- ───────────────────────────────────────────────────────────────────
-- 7) user_entitled_batches() — THE access predicate (L1), and its wrappers.
--
--    The `legacy` CTE is a STAGED BRIDGE for members granted before #35, and it
--    is subordinate to the ledger: it applies only to users with ZERO ledger
--    rows. The moment a member has one row, revocation bites immediately and
--    the stale subscriptions.batch_id cache can no longer resurrect access.
--    #39 deletes the CTE once the drift view reads clean.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.user_entitled_batches(p_user uuid)
returns table (batch_id uuid, segment text, batch_index int, activates_at timestamptz, valid_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with gate as (
    select public.user_is_enrolled(p_user) as enrolled,
           public.user_is_approved(p_user) as approved
  ),
  live as (
    select coalesce(ep.community_segment, 'general') as segment
      from public.subscriptions s
      left join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.created_at desc
     limit 1
  ),
  ledger as (
    select e.batch_id, e.segment, e.batch_index, e.activates_at, e.valid_until
      from public.batch_entitlements e
     where e.user_id = p_user
       and e.status = 'active'
       and e.batch_id is not null
       and (e.valid_until  is null or e.valid_until  > now())
       and (e.activates_at is null or e.activates_at <= now())
       and e.segment = (select segment from live)
  ),
  bridge as (
    -- Pre-#35 grants only. Scoped to members with NO ledger rows at all.
    select s.batch_id,
           coalesce(ep.community_segment, 'general') as segment,
           0 as batch_index,
           null::timestamptz as activates_at,
           coalesce(s.grace_ends_at, s.ends_at) as valid_until
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user
       and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       and s.batch_id is not null
       and coalesce(ep.community_segment, 'general') in ('gold', 'vip')
       and not exists (select 1 from public.batch_entitlements e2 where e2.user_id = p_user)
  )
  select b.batch_id, b.segment, b.batch_index, b.activates_at, b.valid_until
    from (select * from ledger union all select * from bridge) b, gate g
   where g.enrolled and g.approved;
$$;

revoke all on function public.user_entitled_batches(uuid) from public, anon, authenticated;

create or replace function public.my_entitled_batches()
returns table (batch_id uuid, segment text, batch_index int, activates_at timestamptz, valid_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.user_entitled_batches(auth.uid());
$$;

revoke all on function public.my_entitled_batches() from public, anon;
grant execute on function public.my_entitled_batches() to authenticated;

-- Bare id set, for policies that do not need the segment.
-- ★ Cohort tables that carry per-segment content (sessions, announcements) must
-- use my_entitled_batches() and match the SEGMENT too — Gold and VIP share a
-- batch, so a batch-id-only check leaks VIP call links to Gold.
create or replace function public.my_entitled_batch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select batch_id from public.user_entitled_batches(auth.uid());
$$;

revoke all on function public.my_entitled_batch_ids() from public, anon;
grant execute on function public.my_entitled_batch_ids() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 8) user_community_space_ids() — rewritten over L1 (#32 §8 replaced).
--    Same signature, same fail-closed shape; the premium branch now reads the
--    ledger instead of one mutable subscriptions.batch_id.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.user_community_space_ids(p_user uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
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
  ),
  scope as (select batch_id, segment from public.user_entitled_batches(p_user))
  select sp.id
    from public.community_spaces sp, gate g
   where g.is_admin
      or (g.is_member and sp.active
          and (sp.kind = 'general'
               or exists (select 1 from scope s
                           where s.segment = sp.kind and s.batch_id = sp.batch_id)));
$$;

revoke all on function public.user_community_space_ids(uuid) from public, anon, authenticated;

-- my_community_space_ids() is unchanged in shape but re-issued so its grants are
-- unambiguous after the rewrite above.
create or replace function public.my_community_space_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select * from public.user_community_space_ids(auth.uid());
$$;

revoke all on function public.my_community_space_ids() from public, anon;
grant execute on function public.my_community_space_ids() to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 9) grant_batch_run() — the ONE allocator.
--
--    Every path that grants cohort access routes through this function:
--    admin_finalize_enrollment (approval/renewal/extension/upgrade),
--    admin_assign_batch (manual), and the import endpoint. That is what makes
--    "one writer, one reader" true, and it is why capacity, closed-batch and
--    ordering rules cannot be bypassed by picking a different entry point.
--
--    ★ THIS IS THE ONLY FUNCTION THAT LOCKS `batches`, and it always locks in
--    ascending `code` order in ONE statement. Callers must NOT take their own
--    batch lock: doing so inverts the order against a run and deadlocks two
--    concurrent approvals whose runs overlap in different orders.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.grant_batch_run(
  p_user_id                uuid,
  p_segment                text,
  p_start_batch_id         uuid,
  p_count                  int,
  p_grant_reason           text,
  p_source_subscription_id uuid        default null,
  p_source_plan_key        text        default null,
  p_source_request_id      uuid        default null,
  p_source_import_row_id   uuid        default null,
  p_valid_until            timestamptz default null,
  p_actor                  uuid        default null,
  p_enforce_capacity       boolean     default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_run_id      uuid := gen_random_uuid();
  v_start       public.batches%rowtype;
  v_outstanding int;
  v_other_seg   text;
  v_cand        record;
  v_idx         int := 0;
  v_cap         int;
  v_used        int;
  v_allocated   jsonb := '[]'::jsonb;
  v_queued      int := 0;
  v_activates   timestamptz;
begin
  if p_segment not in ('gold', 'vip') then
    perform public.app_error('INVALID_PLAN',
      format('%s is not a cohort segment', coalesce(p_segment, 'null')), 422,
      jsonb_build_object('segment', p_segment));
  end if;
  if p_count is null or p_count < 1 then
    perform public.app_error('INVALID_PLAN',
      'this plan has no cohort run length - set enrollment_plans.eligible_batch_count', 422,
      jsonb_build_object('plan_key', p_source_plan_key));
  end if;
  if p_count > 24 then
    perform public.app_error('RUN_LIMIT_EXCEEDED', 'a run cannot exceed 24 cohorts', 409,
      jsonb_build_object('requested', p_count));
  end if;

  select * into v_start from public.batches where id = p_start_batch_id;
  if v_start.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'batch not found', 404,
      jsonb_build_object('batch_id', p_start_batch_id));
  end if;

  -- Mixing segments inside one member's outstanding run makes "which seat does
  -- this member occupy?" ambiguous for capacity. An upgrade must supersede the
  -- old run first (admin_finalize_enrollment does).
  select e.segment into v_other_seg
    from public.batch_entitlements e
   where e.user_id = p_user_id
     and e.status in ('queued', 'active')
     and e.segment <> p_segment
   limit 1;
  if v_other_seg is not null then
    perform public.app_error('SEGMENT_MISMATCH',
      format('member already holds outstanding %s seats', v_other_seg), 409,
      jsonb_build_object('held_segment', v_other_seg, 'requested_segment', p_segment));
  end if;

  select count(*) into v_outstanding
    from public.batch_entitlements e
   where e.user_id = p_user_id and e.status in ('queued', 'active');
  if v_outstanding + p_count > 24 then
    perform public.app_error('RUN_LIMIT_EXCEEDED',
      'this member already holds the maximum number of upcoming cohort seats', 409,
      jsonb_build_object('outstanding', v_outstanding, 'requested', p_count));
  end if;

  -- The explicitly chosen starting cohort must itself be usable - a precise
  -- error here beats silently starting the run a month later.
  if v_start.status = 'archived' then
    perform public.app_error('BATCH_CLOSED', format('batch %s is archived', v_start.code), 409,
      jsonb_build_object('batch_code', v_start.code, 'status', v_start.status));
  end if;
  if not exists (select 1 from public.community_spaces sp
                  where sp.batch_id = v_start.id and sp.kind = p_segment and sp.active) then
    perform public.app_error('NO_SPACE_FOR_SEGMENT',
      format('batch %s has no active %s space', v_start.code, p_segment), 409,
      jsonb_build_object('batch_code', v_start.code, 'segment', p_segment));
  end if;
  -- A closed start batch blocks only when this is a NEW seat there. A member who
  -- already holds a seat in it (renewal, extension) continues unimpeded - the
  -- #33/#34 v_holds_seat intent, now expressed per cohort.
  if v_start.status <> 'open'
     and not exists (select 1 from public.batch_entitlements e
                      where e.user_id = p_user_id and e.batch_id = v_start.id
                        and e.status in ('queued', 'active')) then
    perform public.app_error('BATCH_CLOSED',
      format('batch %s is closed to new assignments', v_start.code), 409,
      jsonb_build_object('batch_code', v_start.code, 'status', v_start.status));
  end if;

  -- Allocate from the REGISTRY, in code order, under one ordered lock.
  for v_cand in
    select b.id, b.code, b.status, b.starts_on, b.gold_capacity, b.vip_capacity, b.total_capacity
      from public.batches b
     where b.code >= v_start.code
       and b.status = 'open'
       and exists (select 1 from public.community_spaces sp
                    where sp.batch_id = b.id and sp.kind = p_segment and sp.active)
       and not exists (select 1 from public.batch_entitlements e2
                        where e2.user_id = p_user_id and e2.batch_id = b.id
                          and e2.status in ('queued', 'active'))
     order by b.code
     limit p_count
     for update
  loop
    if p_enforce_capacity then
      v_cap := case p_segment when 'gold' then v_cand.gold_capacity else v_cand.vip_capacity end;
      if v_cap is not null then
        select count(*) into v_used
          from public.batch_seat_holders(v_cand.id, p_segment) h
         where h <> p_user_id;
        if v_used >= v_cap then
          perform public.app_error('BATCH_FULL',
            format('batch %s is full for %s (%s of %s seats)', v_cand.code, p_segment, v_used, v_cap), 409,
            jsonb_build_object('batch_code', v_cand.code, 'segment', p_segment,
                               'used', v_used, 'capacity', v_cap, 'scope', 'segment'));
        end if;
      end if;

      if v_cand.total_capacity is not null then
        select count(*) into v_used from (
          select h from public.batch_seat_holders(v_cand.id, 'gold') h
          union
          select h from public.batch_seat_holders(v_cand.id, 'vip')  h
        ) all_holders where h <> p_user_id;
        if v_used >= v_cand.total_capacity then
          perform public.app_error('BATCH_FULL',
            format('batch %s is full (%s of %s total seats)', v_cand.code, v_used, v_cand.total_capacity), 409,
            jsonb_build_object('batch_code', v_cand.code, 'used', v_used,
                               'capacity', v_cand.total_capacity, 'scope', 'total'));
        end if;
      end if;
    end if;

    -- A cohort reveals itself when it starts. Falling back to the month encoded
    -- in `code` keeps this deterministic when starts_on has not been set.
    v_activates := coalesce(v_cand.starts_on::timestamptz,
                            to_date(v_cand.code || '-01', 'YYYY-MM-DD')::timestamptz);

    insert into public.batch_entitlements (
      user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason,
      source_subscription_id, source_plan_key, source_request_id, source_import_row_id,
      granted_by, valid_until, activates_at, allocated_at
    ) values (
      p_user_id, v_cand.id, p_segment, v_idx, v_run_id, p_count, 'active', p_grant_reason,
      p_source_subscription_id, p_source_plan_key, p_source_request_id, p_source_import_row_id,
      p_actor, p_valid_until, v_activates, now()
    );

    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (v_cand.id, p_user_id, p_actor, 'entitle_allocate',
            jsonb_build_object('run_id', v_run_id, 'segment', p_segment,
                               'batch_index', v_idx, 'reason', p_grant_reason));

    v_allocated := v_allocated || jsonb_build_object('batch_id', v_cand.id, 'code', v_cand.code,
                                                     'batch_index', v_idx);
    v_idx := v_idx + 1;
  end loop;

  -- Shortfall: cohorts that do not exist yet. The seat is still owed, so it is
  -- recorded and bound by the FIFO trigger when Alex creates the next batch.
  while v_idx < p_count loop
    insert into public.batch_entitlements (
      user_id, batch_id, segment, batch_index, run_id, run_length, status, grant_reason,
      source_subscription_id, source_plan_key, source_request_id, source_import_row_id,
      granted_by, valid_until
    ) values (
      p_user_id, null, p_segment, v_idx, v_run_id, p_count, 'queued', p_grant_reason,
      p_source_subscription_id, p_source_plan_key, p_source_request_id, p_source_import_row_id,
      p_actor, p_valid_until
    );
    v_queued := v_queued + 1;
    v_idx := v_idx + 1;
  end loop;

  if v_queued > 0 then
    insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
    values (null, p_user_id, p_actor, 'entitle',
            jsonb_build_object('run_id', v_run_id, 'segment', p_segment,
                               'queued', v_queued, 'reason', p_grant_reason));
  end if;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run_id, 'segment', p_segment,
    'run_length', p_count, 'allocated', v_allocated, 'queued', v_queued
  );
end;
$fn$;

revoke all on function public.grant_batch_run(uuid, text, uuid, int, text, uuid, text, uuid, uuid, timestamptz, uuid, boolean)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 10) revoke_batch_run() and the admin wrappers.
--     Revocation is bookkeeping hygiene, NOT the security control - the live
--     segment conjunct in L1 already cuts access the moment a plan changes.
--     It exists so the ledger tells the truth and so the seat is released.
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

  -- Keep the legacy cache honest: leaving a stale subscriptions.batch_id behind
  -- would let the #39 bridge resurrect access for a member with no ledger rows.
  update public.subscriptions s
     set batch_id = null, updated_at = now()
   where s.user_id = p_user_id
     and s.batch_id is not null
     and not exists (select 1 from public.batch_entitlements e
                      where e.user_id = p_user_id and e.status in ('queued', 'active'));

  return v_n;
end;
$fn$;

revoke all on function public.revoke_batch_run(uuid, uuid, text, uuid, text) from public, anon, authenticated;

create or replace function public.admin_revoke_batch_run(
  p_user_id uuid,
  p_run_id  uuid default null,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_revoke_batch_run: admin only', 403, null);
  end if;
  v_n := public.revoke_batch_run(p_user_id, p_run_id, p_reason, auth.uid(), 'revoked');
  return jsonb_build_object('ok', true, 'revoked', v_n);
end;
$fn$;

revoke all on function public.admin_revoke_batch_run(uuid, uuid, text) from public, anon;
grant execute on function public.admin_revoke_batch_run(uuid, uuid, text) to authenticated;

-- Admin manual grant: the audited override. Capacity is enforced by DEFAULT -
-- an admin who wants to overfill must pass p_force, because the whole point of
-- capacity is that Alex can only teach so many people at once.
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
  v_sub     public.subscriptions%rowtype;
  v_segment text;
  v_count   int;
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

  return public.grant_batch_run(
    p_user_id, v_segment, p_batch_id, v_count, 'admin_manual',
    v_sub.id, v_sub.plan_key, null, null,
    coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), not p_force);
end;
$fn$;

revoke all on function public.admin_grant_batch_run(uuid, uuid, int, boolean) from public, anon;
grant execute on function public.admin_grant_batch_run(uuid, uuid, int, boolean) to authenticated;

-- Import path: the endpoint has already verified the caller is an admin and
-- holds the service role, but it has no is_admin() JWT context. This wrapper
-- exists only to bridge that, and is revoked from every browser-reachable role.
create or replace function public.grant_batch_run_for_import(
  p_user_id                uuid,
  p_segment                text,
  p_batch_id               uuid,
  p_count                  int,
  p_source_subscription_id uuid,
  p_source_plan_key        text,
  p_source_import_row_id   uuid,
  p_valid_until            timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Imports are capacity-EXEMPT by design (the #32 precedent: a CSV migration of
  -- existing paying students must not be refused by a cap set afterwards), but
  -- they now WRITE the ledger, so those seats are visible in Admin - Batches and
  -- count against every subsequent capacity check.
  return public.grant_batch_run(
    p_user_id, p_segment, p_batch_id, p_count, 'import',
    p_source_subscription_id, p_source_plan_key, null, p_source_import_row_id,
    p_valid_until, null, false);
end;
$fn$;

revoke all on function public.grant_batch_run_for_import(uuid, text, uuid, int, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 11) FIFO binder - when a cohort is created, the oldest owed seats claim it.
--     Capacity is deliberately NOT enforced here: these seats were already sold.
--     Refusing them would repudiate a paid entitlement; the admin sees committed
--     demand per cohort in Admin - Batches and sets capacity from that evidence.
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
       order by e.granted_at, e.batch_index
       for update skip locked
    loop
      -- ★ The cursor's `not exists` guard was evaluated against the snapshot
      -- taken when the cursor opened, so it cannot see seats allocated by
      -- EARLIER ITERATIONS OF THIS LOOP. A member holding three queued seats
      -- would therefore have all three bound to this one cohort, violating
      -- batch_entitlements_one_seat_per_cohort. Re-check inside the loop, where
      -- our own uncommitted writes are visible: one member, one seat, per cohort.
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

-- zz_ prefix so it fires AFTER batches_create_spaces - the binder needs the new
-- cohort's Gold/VIP spaces to exist before it can bind a seat to them.
create or replace function public.zz_batches_allocate_queued()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.allocate_queued_entitlements(new.id);
  return null;
end;
$fn$;

revoke all on function public.zz_batches_allocate_queued() from public, anon, authenticated;

drop trigger if exists zz_batches_allocate_queued on public.batches;
create trigger zz_batches_allocate_queued
  after insert on public.batches
  for each row execute function public.zz_batches_allocate_queued();

create or replace function public.admin_reconcile_queued_entitlements(p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_reconcile_queued_entitlements: admin only', 403, null);
  end if;
  v_n := public.allocate_queued_entitlements(p_batch_id);
  return jsonb_build_object('ok', true, 'allocated', v_n);
end;
$fn$;

revoke all on function public.admin_reconcile_queued_entitlements(uuid) from public, anon;
grant execute on function public.admin_reconcile_queued_entitlements(uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 12) admin_finalize_enrollment() — #34's body, extended to materialise the run.
--
--     WHAT IS PRESERVED FROM #34 (do not "tidy" any of it away):
--       · the FOR UPDATE on the request row and the already-approved no-op;
--       · v_eff_plan (an extension stays on the member's CURRENT plan);
--       · the batch precedence chain per request kind;
--       · the profile patch INCLUDING updated_at, rejected_at/rejected_by = null
--         and rejection_reason = null - #33 dropped these and #34 restored them,
--         which is exactly the mistake this file must not repeat;
--       · most-recent-approval semantics for approved_at/approved_by.
--
--     WHAT CHANGED, AND WHY:
--       · The start batch is no longer locked here, and capacity is no longer
--         counted here. grant_batch_run() owns every `batches` lock and takes
--         them in ascending code order; a second lock taken here would invert
--         that order against the run and deadlock concurrent approvals.
--       · v_holds_seat / v_new_assignment are gone as separate concepts: the
--         per-cohort equivalent lives in grant_batch_run (a closed batch blocks
--         only a NEW seat there), which is the same intent expressed per seat.
--       · An upgrade that CHANGES segment supersedes the outstanding run first,
--         so gold and vip seats never coexist for one member.
--       · An extension advances valid_until on seats already held (forward-only)
--         and grants ceil(extension_days/30) MORE cohorts (D9).
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_finalize_enrollment(
  p_request_id uuid,
  p_batch_id   uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_req          public.enrollment_requests%rowtype;
  v_prev         public.subscriptions%rowtype;
  v_new          public.subscriptions%rowtype;
  v_plan         public.enrollment_plans%rowtype;
  v_kind         text;
  v_eff_plan     text;
  v_segment      text;
  v_prev_segment text;
  v_batch        uuid;
  v_batch_row    public.batches%rowtype;
  v_count        int;
  v_valid_until  timestamptz;
  v_run          jsonb := null;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_finalize_enrollment: admin only', 403, null);
  end if;

  select * into v_req from public.enrollment_requests
   where id = p_request_id for update;
  if v_req.id is null then
    perform public.app_error('REQUEST_NOT_FOUND', 'admin_finalize_enrollment: request not found', 404,
      jsonb_build_object('request_id', p_request_id));
  end if;

  -- Idempotency: re-approving an approved request is a no-op.
  if v_req.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_req.status <> 'pending_review' then
    perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
      format('admin_finalize_enrollment: request is %s - only pending_review can be approved', v_req.status),
      409, jsonb_build_object('status', v_req.status));
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
    perform public.app_error('INVALID_PLAN', format('admin_finalize_enrollment: unknown plan %s', v_eff_plan),
      422, jsonb_build_object('plan_key', v_eff_plan));
  end if;
  -- New sales require a sellable plan; extensions may continue a retired one.
  if v_kind <> 'extension' and not v_plan.active then
    perform public.app_error('INVALID_PLAN', format('admin_finalize_enrollment: plan %s is inactive', v_eff_plan),
      422, jsonb_build_object('plan_key', v_eff_plan));
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
        perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
          'admin_finalize_enrollment: an extension keeps the current batch - use the batch manager to move members',
          409, jsonb_build_object('current_batch_id', v_prev.batch_id));
      end if;
      -- A renewal may arrive after every held seat lapsed; fall back to the
      -- member's most recent cohort so the run continues from the right place.
      if v_batch is null then
        select e.batch_id into v_batch
          from public.batch_entitlements e
         where e.user_id = v_req.user_id and e.batch_id is not null
         order by e.granted_at desc, e.batch_index desc
         limit 1;
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
      perform public.app_error('BATCH_REQUIRED',
        format('admin_finalize_enrollment: %s needs a batch - pick an open batch in the approve dialog', v_eff_plan),
        422, jsonb_build_object('plan_key', v_eff_plan, 'segment', v_segment));
    end if;

    -- Read-only validation for a precise error. The LOCK belongs to
    -- grant_batch_run, which takes every batch lock in code order.
    select * into v_batch_row from public.batches where id = v_batch;
    if v_batch_row.id is null then
      perform public.app_error('BATCH_NOT_FOUND', 'admin_finalize_enrollment: batch not found', 404,
        jsonb_build_object('batch_id', v_batch));
    end if;
  end if;

  -- Grant the term through the EXISTING functions (stacking / supersede / grace /
  -- the 60-365 clamp / the legacy-lifetime guard all live there).
  if v_kind = 'extension' then
    if v_req.extension_days is null or v_req.extension_days <= 0 then
      perform public.app_error('INVALID_MEMBERSHIP_TRANSITION',
        'admin_finalize_enrollment: extension request has no extension_days', 409, null);
    end if;
    v_new := public.approve_extension(v_req.user_id, v_req.id, v_req.extension_days);
  else
    v_new := public.approve_subscription(v_req.user_id, v_req.plan_key, v_req.id);
  end if;

  update public.subscriptions
     set batch_id = v_batch, updated_at = now()
   where id = v_new.id;

  -- ── Materialise the cohort run (L1) ───────────────────────────────
  if v_segment in ('gold', 'vip') then
    v_valid_until := coalesce(v_new.grace_ends_at, v_new.ends_at);

    -- Every outstanding seat rides the new expiry. Forward-only, enforced by the
    -- guard trigger. Without this an extension would leave already-held seats
    -- expiring on the old date.
    update public.batch_entitlements e
       set valid_until = v_valid_until, updated_at = now()
     where e.user_id = v_req.user_id
       and e.status in ('queued', 'active')
       and v_valid_until is not null
       and (e.valid_until is null or e.valid_until < v_valid_until);

    -- A segment change must not leave gold and vip seats coexisting.
    if v_prev_segment is not null and v_prev_segment <> v_segment then
      perform public.revoke_batch_run(v_req.user_id, null,
        format('upgrade %s -> %s', v_prev_segment, v_segment), auth.uid(), 'superseded');
    end if;

    v_count := case
                 when v_kind = 'extension'
                   then greatest(1, least(12, ceil(v_req.extension_days / 30.0)::int))   -- D9
                 else public.plan_batch_count(v_plan.access_days, v_plan.eligible_batch_count)
               end;

    if v_count is null then
      perform public.app_error('INVALID_PLAN',
        format('plan %s has no access_days and no eligible_batch_count - cannot size the cohort run', v_eff_plan),
        422, jsonb_build_object('plan_key', v_eff_plan));
    end if;

    v_run := public.grant_batch_run(
      v_req.user_id, v_segment, v_batch, v_count,
      case when v_kind = 'new' then 'approval' else v_kind end,
      v_new.id, v_eff_plan, v_req.id, null, v_valid_until, auth.uid(), true);
  end if;

  -- Profile cache (mirrors the old client step 2).
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

  -- Request row (mirrors the old client step 3) + the resolved batch.
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
    'batch_code', (select code from public.batches where id = v_batch),
    'run', v_run
  );
end;
$fn$;

revoke all on function public.admin_finalize_enrollment(uuid, uuid) from public, anon;
grant execute on function public.admin_finalize_enrollment(uuid, uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 13) admin_assign_batch() - routed through the ledger.
--
--     #32's version overwrote subscriptions.batch_id, which destroyed the record
--     of the previous cohort: the member instantly lost that cohort's courses,
--     recordings and discussion with nothing left to say why they ever had them.
--     Reassignment now SUPERSEDES the outstanding run and grants a new one, so
--     both the old and the new seats stay in the ledger.
--
--     The skip-reason vocabulary is preserved so the existing client message
--     ("N assigned - M skipped (reason, reason)") keeps working, with two
--     additions: no_run_length and run_conflict.
-- ───────────────────────────────────────────────────────────────────
create or replace function public.admin_assign_batch(p_user_ids uuid[], p_batch_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_uid       uuid;
  v_sub       public.subscriptions%rowtype;
  v_segment   text;
  v_count     int;
  v_assigned  int := 0;
  v_skipped   jsonb := '[]'::jsonb;
  v_batch     public.batches%rowtype;
  v_held      boolean;
  v_hint      text;
begin
  if not public.is_admin() then
    perform public.app_error('FORBIDDEN', 'admin_assign_batch: admin only', 403, null);
  end if;

  select * into v_batch from public.batches where id = p_batch_id;
  if v_batch.id is null then
    perform public.app_error('BATCH_NOT_FOUND', 'admin_assign_batch: batch not found', 404,
      jsonb_build_object('batch_id', p_batch_id));
  end if;
  if v_batch.status <> 'open' then
    perform public.app_error('BATCH_CLOSED',
      format('admin_assign_batch: batch %s is %s', v_batch.code, v_batch.status), 409,
      jsonb_build_object('batch_code', v_batch.code, 'status', v_batch.status));
  end if;

  foreach v_uid in array coalesce(p_user_ids, array[]::uuid[]) loop
    begin
      select * into v_sub from public.subscriptions s
       where s.user_id = v_uid and s.status = 'active'
         and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       order by s.created_at desc limit 1;

      if v_sub.id is null then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_active_subscription');
        continue;
      end if;

      select coalesce(ep.community_segment, 'general') into v_segment
        from public.enrollment_plans ep where ep.key = v_sub.plan_key;
      if v_segment not in ('gold', 'vip') then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'not_a_premium_plan');
        continue;
      end if;

      select exists (select 1 from public.batch_entitlements e
                      where e.user_id = v_uid and e.batch_id = p_batch_id
                        and e.status in ('queued', 'active')) into v_held;
      if v_held then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'already_assigned');
        continue;
      end if;

      if not exists (select 1 from public.community_spaces sp
                      where sp.batch_id = p_batch_id and sp.kind = v_segment and sp.active) then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_space_for_segment');
        continue;
      end if;

      v_count := public.plan_eligible_batch_count(v_sub.plan_key);
      if v_count is null then
        v_skipped := v_skipped || jsonb_build_object('user_id', v_uid, 'reason', 'no_run_length');
        continue;
      end if;

      -- Move, do not destroy: supersede the outstanding run, then grant a new
      -- one from the chosen cohort. Both remain in the ledger.
      perform public.revoke_batch_run(v_uid, null,
        format('reassigned to %s', v_batch.code), auth.uid(), 'superseded');

      perform public.grant_batch_run(
        v_uid, v_segment, p_batch_id, v_count, 'admin_manual',
        v_sub.id, v_sub.plan_key, null, null,
        coalesce(v_sub.grace_ends_at, v_sub.ends_at), auth.uid(), true);

      update public.subscriptions set batch_id = p_batch_id, updated_at = now() where id = v_sub.id;

      insert into public.batch_events (batch_id, user_id, actor_id, action, detail)
      values (p_batch_id, v_uid, auth.uid(),
              case when v_sub.batch_id is null then 'assign' else 'reassign' end,
              jsonb_build_object('subscription_id', v_sub.id, 'segment', v_segment,
                                 'from_batch_id', v_sub.batch_id, 'to_batch_id', p_batch_id));
      v_assigned := v_assigned + 1;

    exception
      -- Only OUR refusals become a per-user skip. A deadlock or serialization
      -- failure must surface, not masquerade as "this member was skipped" —
      -- that would silently under-assign a bulk operation.
      when sqlstate 'PT409' or sqlstate 'PT422' or sqlstate 'PT403' or sqlstate 'PT404' then
        get stacked diagnostics v_hint = pg_exception_hint;
        v_skipped := v_skipped || jsonb_build_object(
          'user_id', v_uid,
          'reason', lower(coalesce(nullif(v_hint, ''), 'run_conflict')));
    end;
  end loop;

  return jsonb_build_object('ok', true, 'assigned', v_assigned,
                            'skipped', v_skipped, 'batch_code', v_batch.code);
end;
$fn$;

revoke all on function public.admin_assign_batch(uuid[], uuid) from public, anon;
grant execute on function public.admin_assign_batch(uuid[], uuid) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 14) Admin read RPCs, all counting from L1 so the numbers agree everywhere.
-- ───────────────────────────────────────────────────────────────────
-- DROP + CREATE: the return type gains total_capacity and the queued counters,
-- and Postgres refuses to change an OUT-parameter row type in place. A dropped
-- function LOSES ITS GRANTS, so the grant below is not optional housekeeping —
-- omitting it is the classic way a drop+recreate silently breaks an admin screen.
drop function if exists public.admin_batch_overview();

create function public.admin_batch_overview()
returns table (
  batch_id uuid, code text, name text, status text,
  starts_on date, ends_on date,
  gold_capacity int, vip_capacity int, total_capacity int,
  gold_active bigint, vip_active bigint, total_active bigint,
  gold_queued bigint, vip_queued bigint
)
language sql stable security definer set search_path = public
as $fn$
  select b.id, b.code, b.name, b.status, b.starts_on, b.ends_on,
         b.gold_capacity, b.vip_capacity, b.total_capacity,
         (select count(*) from public.batch_seat_holders(b.id, 'gold')) as gold_active,
         (select count(*) from public.batch_seat_holders(b.id, 'vip'))  as vip_active,
         (select count(*) from (
            select h from public.batch_seat_holders(b.id, 'gold') h
            union
            select h from public.batch_seat_holders(b.id, 'vip') h) u)  as total_active,
         -- Committed demand: seats already sold that no cohort has absorbed yet.
         -- Alex needs this BEFORE setting a capacity, because queued seats are
         -- never retro-refused (they were paid for).
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

-- Server-side, paged replacement for the client's "needs batch assignment"
-- queue. The old client query fetched 400 subscriptions and THEN filtered to
-- premium in JS, so 400+ general rows hid the queue entirely.
create or replace function public.admin_batches_needing_assignment(
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  user_id uuid, email text, full_name text,
  plan_key text, segment text, subscription_id uuid, ends_at timestamptz, total_count bigint
)
language sql stable security definer set search_path = public
as $fn$
  with live as (
    select distinct on (s.user_id) s.user_id, s.id as subscription_id, s.plan_key,
           coalesce(ep.community_segment, 'general') as segment,
           coalesce(s.grace_ends_at, s.ends_at) as ends_at
      from public.subscriptions s
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
     order by s.user_id, s.created_at desc
  ),
  needy as (
    select l.*
      from live l
     where l.segment in ('gold', 'vip')
       and not exists (select 1 from public.batch_entitlements e
                        where e.user_id = l.user_id and e.status in ('queued', 'active'))
  )
  select n.user_id, p.email, p.full_name, n.plan_key, n.segment,
         n.subscription_id, n.ends_at,
         (select count(*) from needy) as total_count
    from needy n
    join public.profiles p on p.id = n.user_id
   where public.is_admin()
   order by n.ends_at nulls last, n.user_id
   limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$fn$;

revoke all on function public.admin_batches_needing_assignment(int, int) from public, anon;
grant execute on function public.admin_batches_needing_assignment(int, int) to authenticated;

-- Roster for one cohort+segment, paged.
create or replace function public.admin_batch_roster(
  p_batch_id uuid, p_segment text, p_limit int default 50, p_offset int default 0
)
returns table (user_id uuid, email text, full_name text, avatar_url text, total_count bigint)
language sql stable security definer set search_path = public
as $fn$
  with holders as (select h from public.batch_seat_holders(p_batch_id, p_segment) h)
  select p.id, p.email, p.full_name, p.avatar_url, (select count(*) from holders)
    from holders
    join public.profiles p on p.id = holders.h
   where public.is_admin()
   order by p.full_name nulls last, p.id
   limit greatest(1, least(200, coalesce(p_limit, 50)))
  offset greatest(0, coalesce(p_offset, 0));
$fn$;

revoke all on function public.admin_batch_roster(uuid, text, int, int) from public, anon;
grant execute on function public.admin_batch_roster(uuid, text, int, int) to authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 15) Drift view - the #39 gate. Every premium member should have a ledger row
--     that agrees with their subscription cache. Anything else is named here.
-- ───────────────────────────────────────────────────────────────────
create or replace view public.v_batch_entitlement_drift
with (security_invoker = true)
as
select s.user_id,
       s.id as subscription_id,
       s.plan_key,
       coalesce(ep.community_segment, 'general') as segment,
       s.batch_id as cached_batch_id,
       (select count(*) from public.batch_entitlements e
         where e.user_id = s.user_id and e.status in ('queued', 'active')) as outstanding_seats,
       case
         when coalesce(ep.community_segment, 'general') not in ('gold', 'vip') then
           case when s.batch_id is null then 'ok' else 'general_plan_has_batch' end
         when not exists (select 1 from public.batch_entitlements e
                           where e.user_id = s.user_id and e.status in ('queued', 'active'))
           then 'premium_without_ledger'
         when s.batch_id is null then 'missing_cache'
         when not exists (select 1 from public.batch_entitlements e
                           where e.user_id = s.user_id and e.batch_id = s.batch_id
                             and e.status in ('queued', 'active'))
           then 'cache_not_in_ledger'
         else 'ok'
       end as drift
  from public.subscriptions s
  left join public.enrollment_plans ep on ep.key = s.plan_key
 where s.status = 'active'
   and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now());

comment on view public.v_batch_entitlement_drift is
  'Gate for #39 (retiring the subscriptions.batch_id read bridge). security_invoker = the caller''s '
  'RLS applies, so a member sees only their own row and an admin sees all. #39 may run only when '
  'this reads ''ok'' for every row.';

-- ───────────────────────────────────────────────────────────────────
-- 16) Backfill - idempotent, capacity-EXEMPT, archived batches skipped.
--
--     Members granted before #35 already paid; a capacity set afterwards must
--     never retro-refuse them. On the live database this matches nothing today
--     (zero subscriptions carry a batch_id), which is precisely why it has to be
--     written and reviewed now rather than the first time it matters.
--
--     Historical expired/cancelled premium terms are deliberately NOT
--     backfilled: inventing granted_at/valid_until for closed terms would put
--     fiction in an audit table. subscriptions + batch_events remain the
--     pre-#35 record.
-- ───────────────────────────────────────────────────────────────────
do $$
declare
  r        record;
  v_users  int := 0;
  v_skip   int := 0;
begin
  for r in
    select s.id, s.user_id, s.plan_key, s.request_id,
           coalesce(s.grace_ends_at, s.ends_at) as valid_until,
           b.id as batch_id, b.status as batch_status,
           coalesce(ep.community_segment, 'general') as segment,
           public.plan_batch_count(ep.access_days, ep.eligible_batch_count) as run_count
      from public.subscriptions s
      join public.batches b on b.id = s.batch_id
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       and coalesce(ep.community_segment, 'general') in ('gold', 'vip')
       and not exists (select 1 from public.batch_entitlements e
                        where e.user_id = s.user_id and e.status in ('queued', 'active'))
     order by s.user_id
  loop
    if r.run_count is null then
      raise notice '#35 backfill: user % on lifetime premium plan % has no eligible_batch_count - skipped',
        r.user_id, r.plan_key;
      v_skip := v_skip + 1;
      continue;
    end if;
    if r.batch_status = 'archived' then
      raise notice '#35 backfill: user % cached into ARCHIVED batch - skipped, assign manually', r.user_id;
      v_skip := v_skip + 1;
      continue;
    end if;

    perform public.grant_batch_run(
      r.user_id, r.segment, r.batch_id, r.run_count, 'backfill',
      r.id, r.plan_key, r.request_id, null, r.valid_until, null, false);
    v_users := v_users + 1;
  end loop;

  raise notice '#35 backfill: % premium subscription(s) materialised, % skipped', v_users, v_skip;
end $$;

-- ───────────────────────────────────────────────────────────────────
-- 17) Reload PostgREST's schema cache so the new RPCs resolve immediately.
-- ───────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- AFTER RUNNING - paste these and confirm the expected values.
--
--   -- the ledger exists and is empty on a database with no premium members
--   select count(*) from public.batch_entitlements;                          -- 0
--
--   -- authenticated cannot write it, policy or no policy
--   select has_table_privilege('authenticated','public.batch_entitlements','insert'),   -- f
--          has_table_privilege('authenticated','public.batch_entitlements','update'),   -- f
--          has_table_privilege('authenticated','public.batch_entitlements','delete');   -- f
--
--   -- the allocator is not callable from a browser
--   select has_function_privilege('authenticated',
--     'public.grant_batch_run(uuid,text,uuid,int,text,uuid,text,uuid,uuid,timestamptz,uuid,boolean)',
--     'execute');                                                            -- f
--
--   -- #34's housekeeping survived, and the run is materialised
--   select prosrc like '%rejected_at = null%'  as clears_rejection,
--          prosrc like '%grant_batch_run%'     as materialises_run
--     from pg_proc where proname = 'admin_finalize_enrollment';              -- t | t
--
--   -- L1 is the space source, with the bridge subordinate to the ledger
--   select prosrc like '%user_entitled_batches%' as reads_ledger
--     from pg_proc where proname = 'user_community_space_ids';               -- t
--   select prosrc like '%not exists (select 1 from public.batch_entitlements e2%' as bridge_subordinate
--     from pg_proc where proname = 'user_entitled_batches';                  -- t
--
--   -- D1 run lengths
--   select public.plan_eligible_batch_count('gold_live'),                    -- 6
--          public.plan_eligible_batch_count('vip'),                          -- 6
--          public.plan_eligible_batch_count('core_self_paced');              -- 2
--
--   -- a nobody gets nothing
--   select count(*) from public.user_community_space_ids
--     ('00000000-0000-0000-0000-000000000000'::uuid);                        -- 0
--
--   -- no drift
--   select drift, count(*) from public.v_batch_entitlement_drift group by 1; -- only 'ok'
--
--   -- error contract, from the APP as an admin (not the SQL editor):
--   --   rpc('admin_finalize_enrollment', { p_request_id: '<a gold request>' })
--   --   -> HTTP 422, { hint: 'BATCH_REQUIRED', details: '{"code":"BATCH_REQUIRED",...}' }
-- ═══════════════════════════════════════════════════════════════════

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-07-30-batch-entitlements.sql', null,
  'batch_entitlements ledger (#35): registry-allocated cohort runs + FIFO queue, one seat predicate, '
  'live-segment reconciliation, entitlement-backed user_community_space_ids (per-user legacy bridge), '
  'PT-errcode stable error codes, admin_assign_batch + imports routed through grant_batch_run')
on conflict (filename) do nothing;
