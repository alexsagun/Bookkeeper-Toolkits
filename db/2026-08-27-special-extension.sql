-- ─────────────────────────────────────────────────────────────────────────────
-- #47 — The Super Admin special extension, and the ledger that records it.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS
--   A discretionary, audited way to extend a member's expiry when there is no
--   payment behind it: a goodwill week after an outage, a coaching call that had
--   to be rescheduled, a student whose receipt was genuinely lost.
--
--   Today the ONLY way to move an expiry is approve_extension(), which requires an
--   enrollment_requests row — and that table's extension_days column carries
--   `check (extension_days between 60 and 365)`. A 7-day goodwill grant is
--   therefore not merely inconvenient to express, it is refused by a CHECK. The
--   alternative people reach for is editing subscriptions.ends_at by hand in the
--   SQL editor, which leaves no actor, no reason and no record.
--
-- ★ WHY THIS EXTENDS IN PLACE INSTEAD OF SUPERSEDING, WHICH IS THE OPPOSITE OF
--   WHAT approve_subscription() AND approve_extension() DO.
--   Those two insert a NEW subscriptions row and expire the old one, and that is
--   right for a purchase: a new term is a new thing, with its own request and its
--   own money. A goodwill extension is not a new term — it is the SAME term,
--   lasting longer. Two concrete consequences make superseding actively wrong here:
--
--     1. batch_entitlements.source_subscription_id is FROZEN by
--        batch_entitlements_guard against non-null → a DIFFERENT non-null. A
--        superseding row would leave every cohort seat pointing at the dead term,
--        and the guard would refuse to re-point them. The member would keep their
--        expiry and lose their cohort.
--     2. subscriptions_one_active is a partial unique index on (user_id) where
--        status = 'active'. Superseding means expire-then-insert, which is a real
--        window with no active row — for a member who never stopped being active.
--
--   History is preserved by the LEDGER instead: student_access_events records the
--   old and new expiry, the actor, the reason and the amount, and is append-only.
--   "What was this term before?" is answerable; it just is not answered by a
--   second subscriptions row.
--
-- ★ THE IDEMPOTENCY KEY IS NOT DECORATION. Without it, a double-clicked button or
--   a retried request grants the days TWICE, and the second grant is
--   indistinguishable from a deliberate one. The unique index on the ledger is
--   what makes the retry safe, and the RPC returns the ORIGINAL result rather
--   than raising, so the caller cannot tell a retry from a first attempt.
--
-- Depends on: #12/#13 (subscriptions), #31 (schema_migrations), #35 (app_error +
--   batch_entitlements), #45 (students.extend_access).
--
-- HOW TO RUN: paste into the Supabase dashboard → SQL Editor → Run.
-- IDEMPOTENT — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight ============================================================
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if to_regclass('public.subscriptions') is null then
    raise exception 'Run db/2026-07-04-enrollment.sql (#12) first.';
  end if;
  if to_regprocedure('public.app_error(text,text,int,jsonb)') is null then
    raise exception 'Run db/2026-07-30-batch-entitlements.sql (#35) first.';
  end if;
  if to_regprocedure('public.has_staff_permission(text)') is null then
    raise exception 'Run db/2026-08-25-staff-authorization.sql (#45) first.';
  end if;
  if not exists (select 1 from public.staff_permissions where key = 'students.extend_access') then
    raise exception '#45 did not seed students.extend_access — re-run it before this file.';
  end if;
end
$pre$;


-- == 1) The ledger ===========================================================
-- ★ APPEND-ONLY, and the FKs are ON DELETE SET NULL with denormalized email
--   snapshots for the same reason staff_role_events is: deleting an Auth account
--   must never destroy the record of what was granted to them, or by whom.

create table if not exists public.student_access_events (
  id                     bigint generated always as identity primary key,
  actor_user_id          uuid references auth.users(id) on delete set null,
  actor_email            text,
  target_user_id         uuid references auth.users(id) on delete set null,
  target_email           text,
  subscription_id        uuid references public.subscriptions(id) on delete set null,
  action                 text not null default 'special_extension'
                         check (action in ('special_extension')),
  source                 text not null default 'manual_exception'
                         check (source in ('manual_exception')),
  plan_key               text,
  old_ends_at            timestamptz,
  new_ends_at            timestamptz,
  old_grace_ends_at      timestamptz,
  new_grace_ends_at      timestamptz,
  days_granted           integer,
  reason                 text not null,
  idempotency_key        text,
  created_at             timestamptz not null default now()
);

comment on table public.student_access_events is
  '#47: append-only record of every discretionary access change. A paid extension is '
  'NOT recorded here — that already has an enrollment_requests row and a receipt. This '
  'exists for the grants that have no payment behind them, which are exactly the ones '
  'that need an actor and a reason attached. Never add an update or delete policy.';

-- The retry guard. Partial, so rows written without a key (none today, but the
-- column is nullable for future sources) never collide with each other.
create unique index if not exists student_access_events_idem_idx
  on public.student_access_events (idempotency_key)
  where idempotency_key is not null;

create index if not exists student_access_events_target_idx
  on public.student_access_events (target_user_id, created_at desc);

alter table public.student_access_events enable row level security;

drop policy if exists student_access_events_read on public.student_access_events;
create policy student_access_events_read on public.student_access_events
  for select to authenticated
  using (
    -- The member can see what was granted to them; it is their access.
    target_user_id = (select auth.uid())
    or (select public.has_staff_permission('students.extend_access'))
    or (select public.has_staff_permission('enrollments.review'))
  );

revoke insert, update, delete, truncate on public.student_access_events from authenticated, anon, public;
grant select on public.student_access_events to authenticated;


-- == 2) The grant ============================================================
-- ★ Gated on students.extend_access, which by #45's matrix ONLY super_admin holds.
--   That omission is deliberate and documented there: a discretionary extension
--   creates paid access with no payment behind it, so it stays with the role that
--   owns the money. An Operations Admin extends access the normal way — by
--   approving an extension REQUEST, which carries a receipt.

create or replace function public.admin_grant_special_extension(
  p_user_id         uuid,
  p_mode            text default 'days',      -- 'days' | 'until'
  p_days            integer default null,
  p_new_ends_at     timestamptz default null,
  p_reason          text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sub    public.subscriptions%rowtype;
  v_prior  public.student_access_events%rowtype;
  v_grace  int := 3;                          -- the same cushion approve_subscription uses
  v_target timestamptz;
  v_days   int;
  v_new_grace timestamptz;
begin
  if not public.has_staff_permission('students.extend_access') then
    perform public.app_error('FORBIDDEN',
      'admin_grant_special_extension: students.extend_access required', 403, null);
  end if;

  -- A reason is the entire point of routing this through an RPC instead of an
  -- UPDATE, so it is required before anything else is looked at.
  if coalesce(btrim(p_reason), '') = '' then
    perform public.app_error('EXTENSION_INVALID',
      'a reason is required — this grant has no payment behind it, so the reason is the only record of why',
      422, null);
  end if;

  -- ── Idempotency, BEFORE the lock. A retry must return the original answer,
  --    not queue behind it and then grant a second time.
  if p_idempotency_key is not null then
    select * into v_prior from public.student_access_events
     where idempotency_key = p_idempotency_key;
    if v_prior.id is not null then
      return jsonb_build_object(
        'ok', true, 'replayed', true,
        'subscription_id', v_prior.subscription_id,
        'old_ends_at', v_prior.old_ends_at,
        'new_ends_at', v_prior.new_ends_at,
        'days_granted', v_prior.days_granted);
    end if;
  end if;

  -- The member's current term. FOR UPDATE so a concurrent approval or renewal
  -- cannot interleave between the read and the write.
  select * into v_sub from public.subscriptions
   where user_id = p_user_id
   order by created_at desc
   limit 1
   for update;

  if v_sub.id is null then
    perform public.app_error('SUBSCRIPTION_NOT_FOUND',
      'that member has no subscription to extend', 404,
      jsonb_build_object('user_id', p_user_id));
  end if;

  -- ★ A legacy no-expiry term is ALREADY unlimited. Writing a date onto it would
  --   SHORTEN their access to whatever we picked — the one outcome this function
  --   must never produce. approve_extension() guards the same case by returning
  --   the row untouched; here it is a loud refusal, because someone typed a date
  --   on purpose and deserves to know it did nothing.
  if v_sub.ends_at is null then
    perform public.app_error('EXTENSION_NOT_ALLOWED',
      'this membership never expires, so an extension would only ever shorten it', 409,
      jsonb_build_object('subscription_id', v_sub.id));
  end if;

  -- ── Work out the new expiry.
  if p_mode = 'until' then
    if p_new_ends_at is null then
      perform public.app_error('EXTENSION_INVALID', 'mode "until" needs a date', 422, null);
    end if;
    v_target := p_new_ends_at;
  elsif p_mode = 'days' then
    if p_days is null or p_days < 1 or p_days > 365 then
      perform public.app_error('EXTENSION_INVALID',
        'an extension is between 1 and 365 days', 422,
        jsonb_build_object('days', p_days));
    end if;
    -- ★ An EXPIRED term extends from NOW, not from its old end date. Extending
    --   from a date in the past would hand back fewer days than the number typed,
    --   silently — "14 days" on a term that ended 10 days ago would be 4.
    v_target := greatest(v_sub.ends_at, now()) + make_interval(days => p_days);
  else
    perform public.app_error('EXTENSION_INVALID',
      format('unknown mode %s — expected days or until', p_mode), 422, null);
  end if;

  -- Forward-only, always. This is the invariant the whole function exists to keep.
  if v_target <= v_sub.ends_at then
    perform public.app_error('EXTENSION_INVALID',
      'that date is not later than the current expiry — an extension may never shorten access',
      422, jsonb_build_object('current_ends_at', v_sub.ends_at, 'requested', v_target));
  end if;

  v_new_grace := v_target + make_interval(days => v_grace);
  v_days := greatest(1, ceil(extract(epoch from (v_target - greatest(v_sub.ends_at, now()))) / 86400.0)::int);

  -- ★ Reviving a lapsed term has to respect subscriptions_one_active, a PARTIAL
  --   unique index on (user_id) where status = 'active'. The invariant says at
  --   most one row is active, but this function must not be the thing that
  --   discovers the invariant was already broken: flipping to 'active' while
  --   another active row exists would abort with a unique violation and take the
  --   whole grant down with it. So the revival is conditional on there being
  --   nobody else, and if there IS somebody else we simply extend the dates and
  --   leave the status alone — the member keeps working either way, because
  --   is_enrolled() reads the OTHER active row.
  update public.subscriptions
     set ends_at = v_target,
         grace_ends_at = v_new_grace,
         status = case
                    when status = 'expired'
                     and not exists (select 1 from public.subscriptions s2
                                      where s2.user_id = p_user_id
                                        and s2.status = 'active'
                                        and s2.id <> v_sub.id)
                      then 'active'
                    else status
                  end,
         updated_at = now()
   where id = v_sub.id;

  -- ★ Carry the cohort seats forward. batch_entitlements_guard enforces
  --   "valid_until may never outlive its source term" on INSERT and forward-only
  --   on UPDATE, so widening them here is both permitted and required — leaving
  --   them behind would extend the membership while its VIP community access
  --   quietly expired on the old date.
  update public.batch_entitlements e
     set valid_until = v_new_grace, updated_at = now()
   where e.user_id = p_user_id
     and e.status in ('queued', 'active')
     and (e.valid_until is null or e.valid_until < v_new_grace);

  -- Profile cache, so the member's own gate agrees immediately.
  update public.profiles
     set is_paid = true, updated_at = now()
   where id = p_user_id;

  insert into public.student_access_events
    (actor_user_id, actor_email, target_user_id, target_email, subscription_id,
     action, source, plan_key, old_ends_at, new_ends_at,
     old_grace_ends_at, new_grace_ends_at, days_granted, reason, idempotency_key)
  select auth.uid(),
         (select email from public.profiles where id = auth.uid()),
         p_user_id,
         (select email from public.profiles where id = p_user_id),
         v_sub.id, 'special_extension', 'manual_exception', v_sub.plan_key,
         v_sub.ends_at, v_target, v_sub.grace_ends_at, v_new_grace,
         v_days, btrim(p_reason), p_idempotency_key;

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'subscription_id', v_sub.id,
    'old_ends_at', v_sub.ends_at,
    'new_ends_at', v_target,
    'grace_ends_at', v_new_grace,
    'days_granted', v_days);
end;
$fn$;

comment on function public.admin_grant_special_extension(uuid, text, integer, timestamptz, text, text) is
  '#47: the discretionary expiry extension. Super-Admin-only by the #45 matrix. Extends the '
  'CURRENT term in place — superseding would strand the member''s cohort seats, whose '
  'source_subscription_id is frozen by batch_entitlements_guard — and records the before/after '
  'in student_access_events. Forward-only, 1-365 days, reason required, idempotent by key, and '
  'it refuses a legacy no-expiry term outright rather than silently shortening it.';

revoke all on function public.admin_grant_special_extension(uuid, text, integer, timestamptz, text, text) from public, anon;
grant execute on function public.admin_grant_special_extension(uuid, text, integer, timestamptz, text, text) to authenticated;

-- The member-facing / admin-facing history for one student.
create or replace function public.student_access_history(p_user_id uuid, p_limit integer default 50)
returns table (
  id bigint, actor_email text, action text, source text,
  old_ends_at timestamptz, new_ends_at timestamptz, days_granted integer,
  reason text, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select e.id, e.actor_email, e.action, e.source,
         e.old_ends_at, e.new_ends_at, e.days_granted, e.reason, e.created_at
    from public.student_access_events e
   where e.target_user_id = p_user_id
     and (e.target_user_id = (select auth.uid())
          or public.has_staff_permission('students.extend_access')
          or public.has_staff_permission('enrollments.review'))
   order by e.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200))
$fn$;

revoke all on function public.student_access_history(uuid, integer) from public, anon;
grant execute on function public.student_access_history(uuid, integer) to authenticated;


-- == 3) Error codes, re-listed in full =======================================
-- Copied from #46 plus the three #47 codes.
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
    ('EXTENSION_INVALID',            422, 'The requested extension is out of range, backwards, or missing its reason.')
  ) as t(code, http, summary);
$cat$;

revoke all on function public.app_error_catalog() from public, anon;
grant execute on function public.app_error_catalog() to authenticated;


notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-27-special-extension.sql', null,
  'special extension (#47): student_access_events, an append-only ledger of discretionary '
  'access changes, plus admin_grant_special_extension() gated on students.extend_access '
  '(super_admin only by the #45 matrix). Extends the CURRENT term IN PLACE rather than '
  'superseding it — a superseding row would strand the member''s cohort seats, whose '
  'source_subscription_id batch_entitlements_guard freezes against re-pointing, and would open '
  'a window with no active row under subscriptions_one_active. Forward-only, 1-365 days, reason '
  'required, idempotent by key (a retry returns the original result instead of granting twice), '
  'refuses a legacy no-expiry term rather than silently shortening it, extends an EXPIRED term '
  'from now() rather than from its old end date, and carries batch_entitlements.valid_until '
  'forward so community access does not expire on the old date. Adds student_access_history() '
  'and three app_error codes. Deliberately NOT routed through enrollment_requests, whose '
  'extension_days CHECK (60-365) cannot express a goodwill week and would need a fake receipt.')
on conflict (filename) do nothing;


-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--   -- 1) The ledger exists and is append-only over PostgREST:
--   select to_regclass('public.student_access_events') is not null as tbl,
--          not has_table_privilege('authenticated','public.student_access_events','insert') as no_insert;
--
--   -- 2) Only students.extend_access can grant (super_admin holds it; nobody else does):
--   select r.key, bool_or(rp.permission_key = 'students.extend_access') as may_extend
--     from public.staff_roles r
--     left join public.staff_role_permissions rp on rp.role_key = r.key
--    group by r.key order by r.key;
--     -- expect true for super_admin only
--
--   -- 3) The retry guard is real:
--   select indexdef from pg_indexes where indexname = 'student_access_events_idem_idx';
--
--   -- 4) Try it on a test account (as a Super Admin), then read it back:
--   -- select public.admin_grant_special_extension(
--   --   '<uuid>', 'days', 7, null, 'Goodwill: rescheduled coaching call.', 'demo-key-1');
--   -- select * from public.student_access_history('<uuid>');
--   -- Re-running the SAME call with the SAME key must return replayed = true and
--   -- must NOT move the expiry a second time.
-- ─────────────────────────────────────────────────────────────────────────────
