-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-28-legacy-migration-round2.sql   (#68)
-- Legacy migration, round 2: Silver and Essentials rosters, cohort seats that match the
-- paid term, no missing cohort month, bulk activation that stops and hands back, package
-- titles.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DOES
--   1. A BATCH IS A VIP-ONLY FACT, AT EVERY LAYER. #67 knew it only in
--      legacy_import_activate_row(); staging, readiness, promotion and every read demanded a
--      batch for every plan, so a Silver or Essentials roster could not be staged at all.
--      Now a non-VIP row skips every batch rule, stores no batch (a label in the file is kept
--      as history, with the warning batch_ignored_for_plan), and is made Ready by its PLAN:
--      student_import_jobs.eligible_plan_keys, compared on reopen like every other setting.
--   2. A RECORD KEY IS NEVER NULL FOR A VALID ROW. A non-VIP plan passes the literal 'none'
--      as its cohort (NON_VIP_BATCH_TOKEN in the library), so "one legacy grant per person
--      per plan" holds for Silver and Essentials too; a row that would still have no key is
--      refused (record_key_missing).
--   3. COHORT SEATS COME FROM THE PAID TERM. legacy_import_seat_count() counts the whole
--      months the term covers, at least one and never more than the plan's run length, so a
--      student who paid one month holds one cohort seat, not six.
--   4. NO MISSING COHORT MONTH UNDER A LATER BATCH. The allocator only moves forward, so a
--      run that crosses a month with no batch while a later batch exists skips that month
--      for good. The preflight names such months and legacy_import_start_run() refuses them
--      with the new LEGACY_BATCH_GAP (133 codes), by one shared rule.
--   5. THE SAME PERSON IN TWO ROSTERS: the higher plan wins. A lower-ranked row is held at
--      the claim (higher_plan_pending) while a higher-ranked row for the same identity is
--      still unactivated AND can still become a grant (legacy_import_higher_plan_pending:
--      grace ahead, and a VIP cohort that is not archived); staging warns (other_legacy_row),
--      the preflight counts it and names the rows the claim will hold (held_row_ids).
--      A grandfathered paid member (is_paid, no subscription row) is blocked outright.
--   6. BULK ACTIVATION CAN STOP AND HAND BACK. An invitation the provider refused in a way
--      that proves nothing was delivered goes back to the queue (`not_sent`); a hand-back
--      whose request never reached the provider keeps its generation, so it does not spend
--      the cap of twenty; one that can never go out is recorded as failed instead of raising
--      and stalling the run; pass 2 takes an exclusion list; an account the import created
--      is released when its row is refused. Onboarding notices refused by the provider or
--      the configuration no longer use up their five tries, under a hard ceiling of twenty
--      reservations nothing resets (onboarding_notice_reservations), and a Super Admin can
--      reset the tries.
--   7. PACKAGE TITLES. The three plans are renamed: the package the owner sells is the
--      title (`name`), the old product name the small line above it (`tagline`). Keys never
--      change; every predicate, foreign key and record key reads plan_key.
--
-- ★ EVERY RESTATED BODY IS COPIED, NOT RETYPED. Fifteen #67 function bodies and the catalog were lifted
--   from db/2026-09-25-legacy-student-migration.sql by a script and edited at anchors; the
--   md5 of each source body was compared with live prosrc first, and every edit is marked
--   `#68`. test/legacyMigrationRound2Sql.test.mjs line-diffs each one against #67.
--
-- Needs #67. Ship with the client: the new wizard sends eligible_plan_keys, and the
-- endpoint's circuit breaker writes the `not_sent` hand-back this file accepts.
-- ─────────────────────────────────────────────────────────────────────────────


-- == 0) Preflight =============================================================
do $pre$
begin
  if not exists (select 1 from public.schema_migrations where filename = '2026-09-25-legacy-student-migration.sql') then
    raise exception '#68: run db/2026-09-25-legacy-student-migration.sql (#67) first.';
  end if;
  -- 133 = a re-run of this file.
  if (select count(*) from public.app_error_catalog()) not in (132, 133) then
    raise exception '#68: expected the #67 error catalog (132 codes), or 133 on a re-run.';
  end if;
  if to_regprocedure('public.legacy_import_stage(uuid,jsonb,jsonb)') is null
     or to_regprocedure('public.legacy_import_activate_row(uuid,uuid,uuid)') is null
     or to_regprocedure('public.plan_eligible_batch_count(text)') is null
     or to_regclass('public.student_import_activation_runs') is null then
    raise exception '#68: the #67 migration functions and tables, and plan_eligible_batch_count (#35), are required.';
  end if;
  if (select count(*) from public.enrollment_plans where key in ('vip', 'silver_self_paced', 'sampler')) <> 3 then
    raise exception '#68: expected the three live plans (#39): vip, silver_self_paced, sampler.';
  end if;
  -- Every #68 rule asks the plan's segment; a VIP plan that is not segment vip would make
  -- every VIP row batch-less.
  if (select community_segment from public.enrollment_plans where key = 'vip') is distinct from 'vip' then
    raise exception '#68: enrollment_plans.vip must have community_segment = vip.';
  end if;
end
$pre$;


-- == 1) Schema ================================================================
-- Which non-VIP plans the Super Admin ticked Ready at staging. A VIP row is Ready by its
-- cohort (eligible_batch_codes); a Silver or Essentials row has no cohort, so by its plan.
alter table public.student_import_jobs
  add column if not exists eligible_plan_keys text[] not null default '{}'::text[];

-- ★ A HARD CEILING ON ONBOARDING-NOTICE RESERVATIONS. #67 capped a notice at five
--   reservations "so neither inbox nor the audit trail can be made to grow without bound".
--   #68 hands a reservation back when the provider or the configuration refused it, so
--   onboarding_notice_attempts can go DOWN and no longer bounds anything by itself. This
--   count only ever goes UP — in the reserve branch of legacy_import_onboarding_notice(),
--   and nowhere else — and nothing lowers it: not a refund, not a Super Admin's reset. At 20
--   the notice is exhausted for good. Before #68 nothing was refunded, so an existing row's
--   reservations ARE its attempts; the backfill says so, and is a no-op on a re-run.
alter table public.student_import_rows
  add column if not exists onboarding_notice_reservations smallint not null default 0;
update public.student_import_rows
   set onboarding_notice_reservations = onboarding_notice_attempts
 where onboarding_notice_reservations < onboarding_notice_attempts;
do $resv$
begin
  alter table public.student_import_rows drop constraint if exists student_import_rows_notice_reservations;
  alter table public.student_import_rows add constraint student_import_rows_notice_reservations
    check (onboarding_notice_reservations between 0 and 20);
end
$resv$;


-- == 2) Internal helpers ======================================================

-- ★ THE PLAN RANK, EXPLICIT. When one person is in two rosters the higher plan wins. Never
--   price and never `position`: CLAUDE.md's rule is that price does not imply scope (the
--   cheapest plan is also the most scoped). planRank() in src/lib/legacyMigration.js mirrors
--   it; the SQL suite pins the two together.
create or replace function public.legacy_import_plan_rank(p_key text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case p_key
           when 'vip' then 3
           when 'silver_self_paced' then 2
           when 'sampler' then 1
           else 0
         end
$fn$;

-- ★ COHORT SEATS ARE WHAT THE TERM PAID FOR. The whole months [start, end] covers — the
--   end date is inclusive, so the count runs to end + 1 day — at least one, and never more
--   than the plan's run length (plan_eligible_batch_count). Oct 12 → Apr 12 is 6; Oct 12 →
--   Nov 11 is 1; Oct 12 → Nov 10 is 1 (a short month still bought its cohort); a year is
--   capped at 6. A non-VIP plan takes no cohort seat: 0. legacySeatCount() in
--   src/lib/legacyMigration.js is the mirror, pinned by the SQL suite.
--   age() subtracts field by field and borrows a month when the day goes negative, which
--   is exactly (ey-sy)*12 + (em-sm) - (ed' < sd ? 1 : 0).
create or replace function public.legacy_import_seat_count(p_start date, p_end date, p_plan text)
returns integer
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_seg    text;
  v_cap    int;
  v_age    interval;
  v_months int;
begin
  select ep.community_segment into v_seg from public.enrollment_plans ep where ep.key = p_plan;
  if v_seg is distinct from 'vip' then
    return 0;
  end if;
  v_cap := public.plan_eligible_batch_count(p_plan);
  -- A VIP plan with no run length stays what grant_batch_run() refuses (INVALID_PLAN).
  if v_cap is null or v_cap < 1 then
    return v_cap;
  end if;
  -- No term, no count: activation refuses these dates before it ever asks.
  if p_start is null or p_end is null or p_end < p_start then
    return null;
  end if;
  v_age := age((p_end + 1)::timestamp, p_start::timestamp);
  v_months := (extract(year from v_age) * 12 + extract(month from v_age))::int;
  return greatest(1, least(v_cap, v_months));
end;
$fn$;

-- ★ THE MONTHS A SELECTION'S SEAT RUNS WOULD SKIP FOR GOOD. A gap is a month code M with no
--   batch, inside some selected VIP row's seat run (from its effective batch month, for its
--   seat count), while a batch with a code later than M exists. The queue binder and the
--   allocator only move forward, so every seat run crossing M would take the later batch in
--   its place and never come back for M. With no later batch there is no gap: the seat is
--   queued and bound when the month is created. ONE rule, read by the preflight (which names
--   the months) and by legacy_import_start_run() (which refuses them).
create or replace function public.legacy_import_batch_gaps(p_job_id uuid, p_row_ids uuid[])
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(distinct m.code order by m.code), '{}'::text[])
    from public.student_import_rows sr
    join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)
    join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)
    cross join lateral generate_series(0, coalesce(public.legacy_import_seat_count(
                          coalesce(sr.activation_start_date, sr.legacy_start_date),
                          coalesce(sr.activation_end_date, sr.legacy_end_date), ep.key), 0) - 1) as i
    cross join lateral (select to_char(to_date(b.code || '-01', 'YYYY-MM-DD') + make_interval(months => i),
                                       'YYYY-MM') as code) m
   where sr.job_id = p_job_id
     and sr.id = any (coalesce(p_row_ids, '{}'::uuid[]))
     and ep.community_segment = 'vip'
     and not exists (select 1 from public.batches x where x.code = m.code)
     and exists (select 1 from public.batches y where y.code > m.code)
$fn$;

-- ★ THE HIGHER PLAN WINS — BUT ONLY OVER A ROW THAT CAN STILL BECOME A GRANT. True when the
--   person on import row p_row_id (same email, or same Thinkific id) also has a HIGHER-ranked
--   valid row, not yet activated, in any live legacy roster, AND that row could still be
--   activated: its effective term's grace is still ahead (legacy_import_term, the rule
--   legacy_import_set_eligibility() promotes by) and, for a VIP plan, its effective batch
--   exists and is not archived. A higher row that can never activate — its grace has passed,
--   or its cohort was archived — used to hold the cheaper purchase for good, with no button
--   that could release it. ONE rule, read by the claim (which holds the row as
--   higher_plan_pending) and by the preflight (which names the rows it will hold).
create or replace function public.legacy_import_higher_plan_pending(p_row_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.student_import_rows sr
      join public.student_import_rows o
        on o.id <> sr.id
       and (o.email_normalized = sr.email_normalized
            or (sr.external_user_id is not null and o.external_user_id = sr.external_user_id))
      join public.student_import_jobs oj on oj.id = o.job_id
      left join public.enrollment_plans op on op.key = coalesce(o.activation_plan_key, o.proposed_plan_key)
     where sr.id = p_row_id
       and oj.pipeline = 'legacy_v2' and oj.discarded_at is null
       and o.validation_status = 'valid'
       and o.activation_state in ('inactive', 'ready', 'failed', 'activating')
       and public.legacy_import_plan_rank(coalesce(o.activation_plan_key, o.proposed_plan_key))
           > public.legacy_import_plan_rank(coalesce(sr.activation_plan_key, sr.proposed_plan_key))
       -- …and it can still become a grant: its grace is ahead…
       and (select t.grace_ends_at
              from public.legacy_import_term(coalesce(o.activation_start_date, o.legacy_start_date),
                                             coalesce(o.activation_end_date, o.legacy_end_date)) t) > now()
       -- …and a VIP row has a cohort that exists and is not archived.
       and (op.community_segment is distinct from 'vip'
            or exists (select 1 from public.batches ob
                        where ob.id = coalesce(o.activation_batch_id, o.proposed_batch_id)
                          and ob.status <> 'archived')))
$fn$;


-- == 3) Staging ===============================================================
-- #67's body, copied. #68: a batch is checked for a VIP row only, a non-VIP row is Ready by
-- its plan and keys on 'none', and five new reasons are added (grandfathered_member,
-- term_length_unusual, batch_ignored_for_plan, multiple_plans_in_file, other_legacy_row).
-- A blocked row no longer reserves its record key (E4).
create or replace function public.legacy_import_stage(p_actor uuid, p_job jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_hash      text := lower(coalesce(p_job->>'content_sha256', ''));
  v_file_hash text := lower(coalesce(p_job->>'file_sha256', ''));
  v_fmt       text := p_job->>'date_format';
  v_eligible  text[];
  v_eligible_plans text[];
  v_existing  uuid;
  v_job       uuid;
  v_counts    jsonb;
  r           record;
  v_errs      jsonb;
  v_warn      jsonb;
  v_email     text;
  v_sd        date;
  v_ed        date;
  v_grace     timestamptz;
  v_batch     public.batches%rowtype;
  v_plan_ok   boolean;
  v_seg       text;
  v_days      int;
  v_uid       uuid;
  v_confirmed boolean;
  v_key       text;
  v_valid     text;
  v_differs   jsonb;
begin
  perform public.legacy_import_require(p_actor);

  if v_hash !~ '^[0-9a-f]{64}$' then
    perform public.app_error('LEGACY_STAGE_INVALID', 'The roster fingerprint is missing or malformed.', 422, null);
  end if;
  if v_fmt is null or v_fmt not in ('M/D/YYYY', 'D/M/YYYY', 'YYYY-MM-DD') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Declare the date format before staging.', 422, null);
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'A roster must hold between 1 and 5,000 rows.', 422, null);
  end if;
  select coalesce(array_agg(distinct c order by c), '{}'::text[]) into v_eligible
    from jsonb_array_elements_text(coalesce(p_job->'eligible_batch_codes', '[]'::jsonb)) c;
  if exists (select 1 from unnest(v_eligible) c where c !~ '^\d{4}-\d{2}$') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'An eligible cohort is not a YYYY-MM code.', 422, null);
  end if;
  -- #68: a Silver or Essentials row has no cohort to tick, so it is made Ready by its PLAN.
  -- Only a plan in the catalog may be named (a VIP key is harmless: a VIP row is Ready by
  -- its cohort alone).
  select coalesce(array_agg(distinct c order by c), '{}'::text[]) into v_eligible_plans
    from jsonb_array_elements_text(coalesce(p_job->'eligible_plan_keys', '[]'::jsonb)) c;
  if exists (select 1 from unnest(v_eligible_plans) c
              where not exists (select 1 from public.enrollment_plans p where p.key = c)) then
    perform public.app_error('LEGACY_STAGE_INVALID', 'An eligible plan is not a plan in the catalog.', 422, null);
  end if;

  -- ★ ONE STAGING AT A TIME, ACROSS EVERY ROSTER. Keyed on the content alone, two
  --   DIFFERENT files holding the same student could stage concurrently, each unable to
  --   see the other's rows, and both come out `ready` for one purchase.
  perform pg_advisory_xact_lock(hashtextextended('legacy_import_stage', 0));
  select j.id into v_existing
    from public.student_import_jobs j
   where j.pipeline = 'legacy_v2' and j.content_sha256 = v_hash and j.discarded_at is null;
  if v_existing is not null then
    -- ★ THE SAME ROWS READ DIFFERENTLY ARE NOT THE SAME JOB. The fingerprint covers the
    --   cells, not how they were read, so re-staging to correct a date format would
    --   otherwise hand back the job staged with the WRONG one — and 11/10 read as 10/11
    --   still lands inside the batch window, so nothing downstream would notice.
    select coalesce(jsonb_agg(d.k order by d.k), '[]'::jsonb) into v_differs
      from public.student_import_jobs j,
           lateral (values
             ('date_format',          j.date_format is distinct from v_fmt),
             ('column_mapping',       j.mapping is distinct from coalesce(p_job->'mapping', '{}'::jsonb)),
             ('plan_mapping',         j.plan_mapping is distinct from coalesce(p_job->'plan_mapping', '{}'::jsonb)),
             ('batch_mapping',        j.batch_mapping is distinct from coalesce(p_job->'batch_mapping', '{}'::jsonb)),
             ('eligible_batch_codes', j.eligible_batch_codes is distinct from v_eligible),
             -- #68: which non-VIP plans were ticked Ready is a setting too.
             ('eligible_plan_keys',   j.eligible_plan_keys is distinct from v_eligible_plans)) as d(k, differs)
     where j.id = v_existing and d.differs;
    if jsonb_array_length(v_differs) > 0 then
      perform public.app_error('LEGACY_JOB_SETTINGS_DIFFER',
        'This roster is already staged with different settings. Discard that job first, then stage again.', 409,
        jsonb_build_object('job_id', v_existing, 'differs', v_differs));
    end if;
    return jsonb_build_object('ok', true, 'job_id', v_existing, 'reopened', true);
  end if;

  insert into public.student_import_jobs (
    source, filename, file_sha256, content_sha256, mapping, settings, status, total_rows,
    created_by, pipeline, date_format, plan_mapping, batch_mapping, eligible_batch_codes, eligible_plan_keys)
  values (
    'manual', left(p_job->>'filename', 200),
    case when v_file_hash ~ '^[0-9a-f]{64}$' then v_file_hash end, v_hash,
    coalesce(p_job->'mapping', '{}'::jsonb), '{}'::jsonb, 'staged', jsonb_array_length(p_rows),
    p_actor, 'legacy_v2', v_fmt,
    coalesce(p_job->'plan_mapping', '{}'::jsonb), coalesce(p_job->'batch_mapping', '{}'::jsonb), v_eligible,
    v_eligible_plans)
  returning id into v_job;

  for r in
    select *
      from jsonb_to_recordset(p_rows) as x(
        source_row_number int, external_user_id text, email_normalized text, email_display text,
        first_name text, last_name text, plan_key text, legacy_plan_label text,
        batch_code text, legacy_batch_label text, start_date text, end_date text,
        payment_status text, amount_paid numeric, currency text, errors jsonb, warnings jsonb, phone text)
  loop
    v_errs := case when jsonb_typeof(r.errors) = 'array' then r.errors else '[]'::jsonb end;
    v_warn := case when jsonb_typeof(r.warnings) = 'array' then r.warnings else '[]'::jsonb end;
    v_email := lower(nullif(btrim(r.email_normalized), ''));
    v_sd := public.legacy_import_safe_date(r.start_date);
    v_ed := public.legacy_import_safe_date(r.end_date);
    v_batch := null;
    v_uid := null;
    v_confirmed := false;

    -- ★ SQL re-derives every refusal; the endpoint's list can only ADD reasons.
    if v_email is null then
      v_errs := v_errs || '["email_missing"]'::jsonb;
    elsif v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_errs := v_errs || '["email_invalid"]'::jsonb;
    end if;

    select exists (select 1 from public.enrollment_plans p where p.key = r.plan_key and p.active) into v_plan_ok;
    if not v_plan_ok then
      v_errs := v_errs || '["plan_unknown"]'::jsonb;
    end if;

    -- #68: the mapped plan's segment decides whether a batch means anything, and its
    -- access_days is what an unusual term is measured against. An unknown plan has neither,
    -- and is already blocked.
    v_seg := null;
    v_days := null;
    if v_plan_ok then
      select p.community_segment, p.access_days into v_seg, v_days
        from public.enrollment_plans p where p.key = r.plan_key;
    end if;

    -- ★ #68: A BATCH IS A VIP-ONLY FACT. Only a VIP row is checked against the registry. A
    --   Silver or Essentials row gets no batch; a label in the file is kept as history
    --   (legacy_batch_label) and named, so nobody expects a cohort that will never come.
    if v_seg = 'vip' then
      select * into v_batch from public.batches b where b.code = r.batch_code;
      if v_batch.id is null then
        v_errs := v_errs || '["batch_unknown"]'::jsonb;
      elsif v_batch.status = 'archived' then
        v_errs := v_errs || '["batch_archived"]'::jsonb;
      end if;
    elsif v_plan_ok and nullif(btrim(coalesce(r.legacy_batch_label, r.batch_code, '')), '') is not null then
      v_warn := v_warn || '["batch_ignored_for_plan"]'::jsonb;
    end if;

    if v_sd is null then v_errs := v_errs || '["start_date_invalid"]'::jsonb; end if;
    if v_ed is null then v_errs := v_errs || '["end_date_invalid"]'::jsonb; end if;
    if v_sd is not null and v_ed is not null then
      if v_ed < v_sd then
        v_errs := v_errs || '["date_order"]'::jsonb;
      else
        select t.grace_ends_at into v_grace from public.legacy_import_term(v_sd, v_ed) t;
        if v_grace <= now() then
          v_errs := v_errs || '["term_ended"]'::jsonb;
        end if;
        -- #68: a term more than a month away from what the plan sells may be a misread date
        -- or a mis-mapped plan. A warning only: a real legacy term may differ.
        if v_days is not null and abs((v_ed - v_sd + 1) - v_days) > 31 then
          v_warn := v_warn || '["term_length_unusual"]'::jsonb;
        end if;
      end if;
    end if;

    if nullif(btrim(r.payment_status), '') is null then
      v_errs := v_errs || '["payment_status_missing"]'::jsonb;
    elsif lower(btrim(r.payment_status)) <> 'paid' then
      v_errs := v_errs || '["payment_not_paid"]'::jsonb;
    end if;
    if r.amount_paid is not null and (r.amount_paid < 0 or r.amount_paid > 1000000) then
      v_errs := v_errs || '["amount_invalid"]'::jsonb;
    end if;
    if r.currency is not null and r.currency !~ '^[A-Z]{3}$' then
      v_errs := v_errs || '["currency_invalid"]'::jsonb;
    end if;

    -- An existing account is LINKED at activation, never duplicated. The same checks
    -- run again there; flagging them now keeps the preflight honest.
    if v_email is not null then
      select u.id, u.email_confirmed_at is not null into v_uid, v_confirmed
        from auth.users u where lower(u.email) = v_email order by u.created_at limit 1;
    end if;
    if v_uid is not null then
      v_warn := v_warn || '["existing_account"]'::jsonb;
      if exists (select 1 from public.profiles p where p.id = v_uid and p.approval_status = 'rejected') then
        v_errs := v_errs || '["profile_rejected"]'::jsonb;
      end if;
      if exists (select 1 from public.staff_memberships m where m.user_id = v_uid and m.status in ('invited', 'active')) then
        v_errs := v_errs || '["staff_account"]'::jsonb;
      end if;
      if exists (select 1 from public.subscriptions s
                  where s.user_id = v_uid
                    and (s.status = 'scheduled'
                         or (s.status = 'active' and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())))) then
        v_errs := v_errs || '["membership_conflict"]'::jsonb;
      end if;
      -- ★ #68: A GRANDFATHERED MEMBER — paid, with no subscription row at all — has unlimited
      --   access through is_enrolled()'s no-rows branch. A dated import term would replace it,
      --   possibly with a narrower plan, and a revert could never bring it back (the cancelled
      --   row would still exist). Blocked; handled by hand, never converted automatically.
      if exists (select 1 from public.profiles p where p.id = v_uid and p.is_paid)
         and not exists (select 1 from public.subscriptions s where s.user_id = v_uid) then
        v_errs := v_errs || '["grandfathered_member"]'::jsonb;
      end if;
    end if;

    select coalesce(jsonb_agg(distinct e), '[]'::jsonb) into v_errs from jsonb_array_elements_text(v_errs) e;
    select coalesce(jsonb_agg(distinct w), '[]'::jsonb) into v_warn from jsonb_array_elements_text(v_warn) w;

    -- ★ #68: A NON-VIP PLAN KEYS ON THE LITERAL 'none', so its key is never NULL — the unique
    --   index and both duplicate checks skip a NULL key, which would let a Silver purchase be
    --   activated twice. 'none' cannot collide with a batch code (the CHECK forces YYYY-MM).
    --   legacyRecordKeyInput() passes NON_VIP_BATCH_TOKEN, the same literal.
    v_key := public.legacy_import_record_key(r.external_user_id, v_email,
               case when v_plan_ok then r.plan_key end,
               case when v_seg = 'vip' then v_batch.code else 'none' end);
    -- …and a row that would still have no key is not valid: nothing would stop it being
    -- activated twice.
    if v_key is null and jsonb_array_length(v_errs) = 0 then
      v_errs := v_errs || '["record_key_missing"]'::jsonb;
    end if;
    v_valid := case when jsonb_array_length(v_errs) = 0 then 'valid' else 'blocked' end;

    insert into public.student_import_rows (
      job_id, source_row_number, mapped, external_user_id, email_normalized, email_display,
      proposed_plan_key, proposed_batch_id, proposed_started_at, proposed_ends_at, proposed_term_mode,
      warnings, errors, validation_status, activation_state, invite_state, legacy_record_key,
      identity_basis, matched_existing, existing_confirmed, legacy_start_date, legacy_end_date,
      legacy_plan_label, legacy_batch_label, legacy_payment_status, legacy_amount_paid, legacy_currency,
      legacy_phone)
    values (
      v_job, r.source_row_number,
      jsonb_build_object('first_name', left(r.first_name, 120), 'last_name', left(r.last_name, 120)),
      nullif(btrim(r.external_user_id), ''), v_email, left(r.email_display, 320),
      case when v_plan_ok then r.plan_key end, case when v_seg = 'vip' then v_batch.id end,
      (select t.started_at from public.legacy_import_term(v_sd, v_ed) t where v_sd is not null and v_ed is not null),
      (select t.ends_at from public.legacy_import_term(v_sd, v_ed) t where v_sd is not null and v_ed is not null),
      'preserve', v_warn, v_errs, v_valid,
      case when v_valid <> 'valid' then 'blocked'
           -- #68: a VIP row is Ready by its cohort; a Silver or Essentials row by its plan.
           when v_seg = 'vip' and v_batch.code = any (v_eligible) then 'ready'
           when v_seg is distinct from 'vip' and r.plan_key = any (v_eligible_plans) then 'ready'
           else 'inactive' end,
      null, v_key,
      case when nullif(btrim(r.external_user_id), '') is not null then 'external_id' else 'email' end,
      v_uid is not null, coalesce(v_confirmed, false), v_sd, v_ed,
      left(r.legacy_plan_label, 120), left(r.legacy_batch_label, 120),
      lower(nullif(btrim(r.payment_status), '')),
      case when r.amount_paid between 0 and 1000000 then round(r.amount_paid, 2) end,
      case when r.currency ~ '^[A-Z]{3}$' then r.currency end,
      case when regexp_replace(coalesce(r.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,15}$'
           then regexp_replace(r.phone, '[^0-9]', '', 'g') end);
  end loop;

  -- ★ A PHONE IS A HINT, NEVER AN IDENTITY. Two rows, or a row and an earlier enrollment
  --   request, sharing a phone under DIFFERENT emails may be one person — the Super Admin is
  --   told, and nothing else happens. Linking an account by phone would hand a paid term to
  --   whoever owns the other email's login; Auth identity is the email and stays the email.
  update public.student_import_rows sr
     set warnings = sr.warnings || '["phone_shared"]'::jsonb
   where sr.job_id = v_job
     and sr.legacy_phone is not null
     and not (sr.warnings ? 'phone_shared')
     and (exists (select 1 from public.student_import_rows o
                   where o.job_id = v_job and o.id <> sr.id and o.legacy_phone = sr.legacy_phone
                     and o.email_normalized is distinct from sr.email_normalized)
          or exists (select 1 from public.enrollment_requests er
                      where regexp_replace(coalesce(er.phone, ''), '[^0-9]', '', 'g') = sr.legacy_phone
                        and lower(coalesce(er.email, '')) is distinct from sr.email_normalized));

  -- The same person twice in one roster is never two memberships.
  update public.student_import_rows sr
     set errors = case when sr.errors ? 'duplicate_in_file' then sr.errors
                       else sr.errors || '["duplicate_in_file"]'::jsonb end,
         validation_status = 'duplicate', activation_state = 'blocked'
   where sr.job_id = v_job
     and sr.email_normalized is not null
     and exists (select 1 from public.student_import_rows o
                  where o.job_id = v_job and o.id <> sr.id and o.email_normalized = sr.email_normalized);

  -- #68: …and when the copies name DIFFERENT plans, say so. An Essentials buyer who later
  -- bought Silver reads differently from an export that lists one purchase twice; both stay
  -- blocked (rows are never merged), and each keeps duplicate_in_file.
  -- ★ A copy with NO plan (unmapped, or not a plan in the catalog) is not a DIFFERENT plan —
  --   plan_unmapped / plan_unknown already names it. count(distinct) skips a NULL, exactly as
  --   normalizeLegacyRows() counts only mapped keys, so the preview and the stored row agree.
  update public.student_import_rows sr
     set errors = sr.errors || '["multiple_plans_in_file"]'::jsonb
   where sr.job_id = v_job
     and sr.email_normalized is not null
     and not (sr.errors ? 'multiple_plans_in_file')
     and (select count(distinct o.proposed_plan_key) from public.student_import_rows o
           where o.job_id = v_job and o.email_normalized = sr.email_normalized) > 1;

  -- …nor is a purchase another job already holds. Remediation is to discard that job.
  update public.student_import_rows sr
     set errors = sr.errors || '["duplicate_staged"]'::jsonb,
         validation_status = 'duplicate', activation_state = 'blocked'
   where sr.job_id = v_job
     and sr.legacy_record_key is not null
     and exists (
       select 1 from public.student_import_rows o
         join public.student_import_jobs oj on oj.id = o.job_id
        where o.legacy_record_key = sr.legacy_record_key
          and o.job_id <> v_job
          -- #68 (E4): only a row that can still activate holds its key. A blocked row is
          -- terminal, and a discarded job is gone; neither may keep a corrected roster out.
          and (o.activation_state in ('activating', 'activated')
               or (oj.discarded_at is null and o.validation_status = 'valid'
                   and o.activation_state in ('inactive', 'ready', 'failed'))));

  -- #68: the same person as a valid row of ANOTHER live roster under a DIFFERENT plan (an
  -- Essentials buyer who later bought VIP). A warning, not a block: the claim holds the lower
  -- plan while the higher one is unactivated (higher_plan_pending), and the preflight counts
  -- it. Stage every roster before activating any, and each overlap shows here once.
  update public.student_import_rows sr
     set warnings = sr.warnings || '["other_legacy_row"]'::jsonb
   where sr.job_id = v_job
     and not (sr.warnings ? 'other_legacy_row')
     and exists (
       select 1 from public.student_import_rows o
         join public.student_import_jobs oj on oj.id = o.job_id
        where o.job_id <> v_job
          and oj.pipeline = 'legacy_v2' and oj.discarded_at is null
          and o.validation_status = 'valid'
          and o.activation_state in ('inactive', 'ready', 'failed', 'activating', 'activated')
          and (o.email_normalized = sr.email_normalized
               or (sr.external_user_id is not null and o.external_user_id = sr.external_user_id))
          and coalesce(o.activation_plan_key, o.proposed_plan_key)
              is distinct from coalesce(sr.activation_plan_key, sr.proposed_plan_key));

  select coalesce(jsonb_object_agg(s.activation_state, s.n), '{}'::jsonb) into v_counts
    from (select activation_state, count(*) as n from public.student_import_rows
           where job_id = v_job group by activation_state) s;
  update public.student_import_jobs set counts = v_counts, updated_at = now() where id = v_job;

  perform public.legacy_import_log(v_job, null, p_actor, 'job_staged', 'staged',
    jsonb_build_object('rows', jsonb_array_length(p_rows), 'states', v_counts,
                       'eligible_batch_codes', to_jsonb(v_eligible), 'eligible_plan_keys', to_jsonb(v_eligible_plans),
                       'date_format', v_fmt));

  return jsonb_build_object('ok', true, 'job_id', v_job, 'reopened', false, 'states', v_counts);
end;
$fn$;


-- == 4) The activation saga (service-only) ====================================

-- #67's body, copied. #68: the batch is reported for VIP rows only; each terms group carries
-- its segment and seat count; new keys: overlaps, held_row_ids, grandfathered, batch_gaps,
-- emails.
create or replace function public.legacy_import_preflight(p_actor uuid, p_job_id uuid, p_row_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_out jsonb;
begin
  perform public.legacy_import_require(p_actor);
  with sel as (
    -- ★ EFFECTIVE TERMS: what the Super Admin assigned, else what the roster said. The same
    --   four coalesces appear in legacy_import_activate_row; the SQL suite pins both.
    select sr.*,
           coalesce(sr.activation_plan_key, sr.proposed_plan_key)  as eff_plan_key,
           -- #68: a batch is a VIP-only fact. A Silver or Essentials row reports none, whatever
           -- it carries, exactly as legacy_import_activate_row() grants none.
           case when ep.community_segment = 'vip'
                then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end as eff_batch_id,
           coalesce(sr.activation_start_date, sr.legacy_start_date) as eff_start,
           coalesce(sr.activation_end_date, sr.legacy_end_date)     as eff_end,
           ep.community_segment                                     as eff_segment
      from public.student_import_rows sr
      left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)
     where sr.job_id = p_job_id and sr.id = any (coalesce(p_row_ids, '{}'::uuid[]))
  ), acc as (
    select s.*, u.id as uid, (u.email_confirmed_at is not null) as confirmed
      from sel s
      left join lateral (select au.id, au.email_confirmed_at from auth.users au
                          where lower(au.email) = s.email_normalized order by au.created_at limit 1) u on true
  ), ready as (
    -- A FAILED row is activatable again: legacy_import_start_run() re-queues it.
    -- ★ EXACTLY what legacy_import_start_run() accepts, and no more: a row still held by a
    --   running or paused run would refuse the WHOLE run (LEGACY_RUN_BUSY), so it is left
    --   out here, and the dialog sends back row_ids rather than its own selection. A preview
    --   that promised "left out" while the start refused everything was a dead end.
    select a.* from acc a
     where a.activation_state in ('ready', 'failed')
       and not exists (select 1 from public.student_import_activation_runs ru
                        where ru.job_id = p_job_id and ru.status in ('running', 'paused')
                          and a.id = any (ru.row_ids))
  ), ov as (
    -- #68: a ready row whose person is also a valid row of ANOTHER live roster under a
    -- different plan. The claim holds the lower-ranked one (higher_plan_pending).
    select r.id, o.activation_state as state,
           coalesce(o.activation_plan_key, o.proposed_plan_key) as plan_key
      from ready r
      join public.student_import_rows o
        on o.job_id <> p_job_id
       and (o.email_normalized = r.email_normalized
            or (r.external_user_id is not null and o.external_user_id = r.external_user_id))
      join public.student_import_jobs oj on oj.id = o.job_id and oj.pipeline = 'legacy_v2' and oj.discarded_at is null
     where o.validation_status = 'valid'
       and o.activation_state in ('inactive', 'ready', 'failed', 'activating', 'activated')
       and coalesce(o.activation_plan_key, o.proposed_plan_key) is distinct from r.eff_plan_key
  )
  select jsonb_build_object(
    'requested', cardinality(array(select distinct unnest(coalesce(p_row_ids, '{}'::uuid[])))),
    'found', (select count(*) from sel),
    'to_activate', (select count(*) from ready),
    'row_ids', (select coalesce(jsonb_agg(r.id order by r.source_row_number), '[]'::jsonb) from ready r),
    'retrying', (select count(*) from ready where activation_state = 'failed'),
    'excluded', cardinality(array(select distinct unnest(coalesce(p_row_ids, '{}'::uuid[])))) - (select count(*) from ready),
    'new_accounts', (select count(*) from ready where uid is null),
    'existing_accounts', (select count(*) from ready where uid is not null),
    'claim_emails', (select count(*) from ready where uid is null or not confirmed),
    'notifications', (select count(*) from ready where uid is not null and confirmed),
    'scheduled', (select count(*) from ready r, public.legacy_import_term(r.eff_start, r.eff_end) t
                   where t.started_at > now()),
    'plans', (select coalesce(jsonb_agg(distinct jsonb_build_object('key', p.key, 'name', p.name)), '[]'::jsonb)
                from ready r join public.enrollment_plans p on p.key = r.eff_plan_key),
    'starts', (select coalesce(jsonb_agg(distinct r.eff_start), '[]'::jsonb) from ready r),
    'ends', (select coalesce(jsonb_agg(distinct r.eff_end), '[]'::jsonb) from ready r),
    -- The terms step of the dialog: each distinct combination, with the roster's own values
    -- beside it so the Super Admin sees what they changed.
    'terms', (select coalesce(jsonb_agg(jsonb_build_object(
                'plan_key', t.eff_plan_key, 'plan_name', (select p.name from public.enrollment_plans p where p.key = t.eff_plan_key),
                'batch_id', t.eff_batch_id, 'batch_code', b.code, 'batch_name', b.name,
                'start_date', t.eff_start, 'end_date', t.eff_end, 'rows', t.n, 'assigned', t.assigned,
                'roster_start', t.roster_start, 'roster_end', t.roster_end, 'row_ids', to_jsonb(t.ids),
                -- #68: the cohort seats this group's paid term buys (0 for a non-VIP plan).
                'plan_segment', t.eff_segment,
                'seats', coalesce(public.legacy_import_seat_count(t.eff_start, t.eff_end, t.eff_plan_key), 0))
                order by b.code, t.eff_start, t.eff_plan_key), '[]'::jsonb)
                from (select r.eff_plan_key, r.eff_batch_id, r.eff_start, r.eff_end, r.eff_segment, count(*) as n, array_agg(r.id) as ids,
                             min(r.legacy_start_date) as roster_start, max(r.legacy_end_date) as roster_end,
                             bool_or(r.activation_plan_key is not null or r.activation_batch_id is not null
                                     or r.activation_start_date is not null or r.activation_end_date is not null) as assigned
                        from ready r group by 1, 2, 3, 4, 5) t
                left join public.batches b on b.id = t.eff_batch_id),
    -- One entry per batch AND plan: a run's length is the plan's, so two plans in one
    -- batch are two allocations, never one sized by whichever key sorts first.
    'cohorts', (select coalesce(jsonb_agg(jsonb_build_object(
                  'code', b.code, 'name', b.name, 'status', b.status, 'rows', g.n,
                  'plan_key', g.plan_key, 'plan_name', (select p.name from public.enrollment_plans p where p.key = g.plan_key),
                  'capacity', b.vip_capacity,
                  'paid_holders', (select count(*) from public.batch_seat_holders(b.id, 'vip')),
                  'scheduled_legacy', (select count(*) from public.batch_entitlements e
                                         join public.subscriptions s on s.id = e.source_subscription_id
                                        where e.batch_id = b.id and e.status = 'active' and s.status = 'scheduled'),
                  -- #68: a run is as long as its paid term's seats; the preview takes the
                  -- longest run in the group.
                  'seats', g.seats,
                  'allocation', public.legacy_import_preview_allocation(b.code, g.seats)) order by b.code, g.plan_key), '[]'::jsonb)
                  from (select r.eff_batch_id, r.eff_plan_key as plan_key, count(*) as n,
                               max(public.legacy_import_seat_count(r.eff_start, r.eff_end, r.eff_plan_key)) as seats
                          from ready r
                         where r.eff_segment = 'vip'   -- #68: cohorts are VIP rows only
                         group by r.eff_batch_id, r.eff_plan_key) g
                  join public.batches b on b.id = g.eff_batch_id),
    -- #68: every email this run sends — one per activated row, a claim link or a notice —
    -- against the provider's daily allowance.
    'emails', (select count(*) from ready where uid is null or not confirmed)
              + (select count(*) from ready where uid is not null and confirmed),
    -- #68: paid with no subscription row; activation refuses them (grandfathered_member).
    'grandfathered', (select count(*) from ready r
                       where r.uid is not null
                         and exists (select 1 from public.profiles p where p.id = r.uid and p.is_paid)
                         and not exists (select 1 from public.subscriptions s where s.user_id = r.uid)),
    -- #68: "Also in another roster", by the other row's plan and state.
    'overlaps', jsonb_build_object(
                  'total', (select count(distinct x.id) from ov x),
                  'by_plan', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'plan_key', y.plan_key,
                                  'plan_name', (select p.name from public.enrollment_plans p where p.key = y.plan_key),
                                  'state', y.state, 'rows', y.n) order by y.plan_key, y.state), '[]'::jsonb)
                                from (select x.plan_key, x.state, count(distinct x.id) as n
                                        from ov x group by x.plan_key, x.state) y)),
    -- ★ #68: the selected rows the claim will HOLD (higher_plan_pending), by the claim's own
    --   function, so the dialog can name them before the phrase is typed.
    'held_row_ids', (select coalesce(jsonb_agg(r.id order by r.source_row_number), '[]'::jsonb)
                       from ready r where public.legacy_import_higher_plan_pending(r.id)),
    -- ★ #68: months these seat runs would skip for good; legacy_import_start_run() refuses
    --   the same months by the same function.
    'batch_gaps', to_jsonb(public.legacy_import_batch_gaps(p_job_id, array(select r.id from ready r)))
  ) into v_out;
  return v_out;
end;
$fn$;

-- #67's body, copied. #68: a selection whose seat runs would skip a month is refused.
create or replace function public.legacy_import_start_run(
  p_actor uuid, p_job_id uuid, p_row_ids uuid[], p_phrase text, p_client_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job      public.student_import_jobs%rowtype;
  v_run      public.student_import_activation_runs%rowtype;
  v_ids      uuid[];
  v_bad      uuid[];
  v_row      record;
  v_gaps     text[];
begin
  perform public.legacy_import_require(p_actor);
  if p_client_key is null or p_client_key !~ '^[A-Za-z0-9_-]{8,80}$' then
    perform public.app_error('LEGACY_STAGE_INVALID', 'The activation request key is missing or malformed.', 422, null);
  end if;

  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2' for update;
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404,
      jsonb_build_object('job_id', p_job_id));
  end if;
  if v_job.discarded_at is not null then
    perform public.app_error('LEGACY_JOB_BUSY', 'That migration job was discarded.', 409,
      jsonb_build_object('job_id', p_job_id));
  end if;

  -- A double click, a retry after a dropped connection: the same key is the same run.
  select * into v_run from public.student_import_activation_runs where job_id = p_job_id and client_key = p_client_key;
  if v_run.id is not null then
    return jsonb_build_object('ok', true, 'run_id', v_run.id, 'count', cardinality(v_run.row_ids), 'reused', true);
  end if;

  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids from unnest(coalesce(p_row_ids, '{}'::uuid[])) x;
  if cardinality(v_ids) not between 1 and 200 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Select between 1 and 200 rows to activate.', 422,
      jsonb_build_object('selected', cardinality(v_ids)));
  end if;

  -- ★ EVERY SELECTED ROW MUST BE READY (OR FAILED, TO RETRY), OR NOTHING STARTS. An
  --   inactive August row can never ride along because "select all" was pressed on
  --   another filter.
  select coalesce(array_agg(x), '{}'::uuid[]) into v_bad
    from unnest(v_ids) x
   where not exists (select 1 from public.student_import_rows sr
                      where sr.id = x and sr.job_id = p_job_id and sr.activation_state in ('ready', 'failed'));
  if cardinality(v_bad) > 0 then
    perform public.app_error('LEGACY_ROW_NOT_READY',
      format('%s of the selected rows are not ready to activate.', cardinality(v_bad)), 409,
      jsonb_build_object('not_ready', to_jsonb(v_bad[1:20]), 'count', cardinality(v_bad)));
  end if;

  if coalesce(btrim(p_phrase), '') <> 'ACTIVATE ' || cardinality(v_ids) then
    perform public.app_error('LEGACY_CONFIRMATION_MISMATCH',
      format('Type ACTIVATE %s to confirm.', cardinality(v_ids)), 422,
      jsonb_build_object('expected', 'ACTIVATE ' || cardinality(v_ids)));
  end if;

  -- ★ #68: NO MISSING COHORT MONTH UNDER A LATER BATCH. The allocator only moves forward, so
  --   every seat run that crosses a month with no batch, while a later batch exists, would
  --   skip that month for good. Refused until the month exists (Admin → Batches). The
  --   preflight names the same months by the same function.
  v_gaps := public.legacy_import_batch_gaps(p_job_id, v_ids);
  if cardinality(v_gaps) > 0 then
    perform public.app_error('LEGACY_BATCH_GAP',
      format('%s has no batch yet, while a later batch exists. Create it in Admin → Batches before activating.',
             array_to_string(v_gaps, ', ')), 409,
      jsonb_build_object('missing', to_jsonb(v_gaps)));
  end if;

  if exists (select 1 from public.student_import_activation_runs ru
              where ru.job_id = p_job_id and ru.status in ('running', 'paused') and ru.row_ids && v_ids) then
    perform public.app_error('LEGACY_RUN_BUSY',
      'Some of these rows are already in an unfinished activation. Resume that one instead.', 409, null);
  end if;

  insert into public.student_import_activation_runs (job_id, created_by, client_key, row_ids, phrase)
  values (p_job_id, p_actor, p_client_key, v_ids, btrim(p_phrase))
  returning * into v_run;

  -- ★ A FAILED ROW RETRIED BY A NEW, TYPED CONFIRMATION STARTS AGAIN FROM ZERO ATTEMPTS.
  --   Retrying inside its own run is capped at five; without this a row that failed five
  --   times, or one whose run had finished, could never be activated at all.
  for v_row in
    update public.student_import_rows sr
       set activation_state = 'ready', attempts = 0, updated_at = now()
     where sr.id = any (v_ids) and sr.job_id = p_job_id and sr.activation_state = 'failed'
    returning sr.id, sr.last_error
  loop
    perform public.legacy_import_log(p_job_id, v_row.id, p_actor, 'row_requeued', 'ready',
      jsonb_build_object('run_id', v_run.id, 'previous_error', v_row.last_error));
  end loop;

  perform public.legacy_import_log(p_job_id, null, p_actor, 'run_started', 'running',
    jsonb_build_object('run_id', v_run.id, 'count', cardinality(v_ids)));

  return jsonb_build_object('ok', true, 'run_id', v_run.id, 'count', cardinality(v_ids), 'reused', false);
end;
$fn$;

-- #67's body, copied. #68: a row whose person has a HIGHER plan still unactivated — and still
-- able to become a grant — in any live roster is held (failed, higher_plan_pending) before
-- the claim, next to duplicate_staged (legacy_import_higher_plan_pending).
create or replace function public.legacy_import_claim_rows(
  p_actor uuid, p_run_id uuid, p_lease text, p_limit int, p_retry_failed boolean default false,
  p_exclude uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run  public.student_import_activation_runs%rowtype;
  v_job  public.student_import_jobs%rowtype;
  v_rows jsonb;
  v_dup  record;
  v_hold record;
begin
  perform public.legacy_import_require(p_actor);
  if p_lease is null or p_lease !~ '^[A-Za-z0-9_-]{8,80}$' then
    perform public.app_error('LEGACY_STAGE_INVALID', 'The worker lease is missing or malformed.', 422, null);
  end if;

  select * into v_run from public.student_import_activation_runs where id = p_run_id for update;
  if v_run.id is null then
    perform public.app_error('LEGACY_RUN_NOT_FOUND', 'That activation run does not exist.', 404,
      jsonb_build_object('run_id', p_run_id));
  end if;
  select * into v_job from public.student_import_jobs where id = v_run.job_id;
  if v_run.status = 'cancelled' or v_job.discarded_at is not null then
    return '[]'::jsonb;
  end if;
  -- A finished run stays finished. Failed rows from it are retried by a NEW run
  -- (legacy_import_start_run re-queues them), which carries its own typed confirmation.
  if v_run.status = 'completed' then
    return '[]'::jsonb;
  end if;
  if v_run.lease_until is not null and v_run.lease_until > now() and v_run.lease_owner is distinct from p_lease then
    perform public.app_error('LEGACY_RUN_BUSY', 'Another window is already working this activation.', 409,
      jsonb_build_object('run_id', p_run_id));
  end if;

  update public.student_import_activation_runs
     set lease_owner = p_lease, lease_until = now() + interval '90 seconds',
         status = 'running', completed_at = null, updated_at = now()
   where id = p_run_id;

  -- One legacy purchase is activated once. A row whose record key is already live in
  -- another row is BLOCKED here, before the claim, rather than letting the unique index
  -- abort the whole claim with a bare 23505 on every retry.
  for v_dup in
    update public.student_import_rows sr
       set activation_state = 'blocked', blocked_reason = 'duplicate_staged', activation_claimed_at = null,
           updated_at = now()
     where sr.id = any (v_run.row_ids) and sr.job_id = v_run.job_id
       and sr.activation_state in ('ready', 'failed')
       and sr.legacy_record_key is not null
       and exists (select 1 from public.student_import_rows o
                    where o.legacy_record_key = sr.legacy_record_key and o.id <> sr.id
                      and o.activation_state in ('activating', 'activated'))
    returning sr.id
  loop
    perform public.legacy_import_log(v_run.job_id, v_dup.id, p_actor, 'activation_blocked', 'duplicate_staged',
      jsonb_build_object('run_id', p_run_id));
  end loop;

  -- ★ #68: THE HIGHER PLAN WINS. A row whose person also has a HIGHER-ranked valid row, not
  --   yet activated, in any live roster is held before anything is created for it: activating
  --   the cheaper plan first would give the student a live term that then refuses the
  --   purchase they actually made (membership_conflict). `failed`, not `blocked`, so a new
  --   run retries it once the higher row is activated, its terms are changed, or its roster
  --   is discarded. Only while that higher row can still become a grant — a row whose grace
  --   has passed, or whose VIP cohort was archived, holds nothing: that is
  --   legacy_import_higher_plan_pending(), the rule the preflight's held_row_ids reads too.
  for v_hold in
    update public.student_import_rows sr
       set activation_state = 'failed', last_error = 'higher_plan_pending', activation_claimed_at = null,
           updated_at = now()
     where sr.id = any (v_run.row_ids) and sr.job_id = v_run.job_id
       and sr.activation_state = 'ready'
       and public.legacy_import_higher_plan_pending(sr.id)
    returning sr.id
  loop
    perform public.legacy_import_log(v_run.job_id, v_hold.id, p_actor, 'activation_blocked', 'higher_plan_pending',
      jsonb_build_object('run_id', p_run_id));
  end loop;

  with pick as (
    select sr.id
      from public.student_import_rows sr
     where sr.id = any (v_run.row_ids)
       and sr.job_id = v_run.job_id
       -- A row this request already tried is not re-claimed by it; the next request may.
       and not (sr.id = any (coalesce(p_exclude, '{}'::uuid[])))
       and (sr.activation_state = 'ready'
            or (p_retry_failed and sr.activation_state = 'failed' and sr.attempts < 5
                -- #68: a row held for a higher plan is retried by a NEW run, whose claim
                -- re-checks the hold; this run never takes it back.
                and sr.last_error is distinct from 'higher_plan_pending')
            or (sr.activation_state = 'activating' and sr.activation_claimed_at < now() - interval '10 minutes'))
     order by sr.source_row_number
     limit least(greatest(coalesce(p_limit, 1), 1), 10)
     for update skip locked
  ), upd as (
    update public.student_import_rows sr
       set activation_state = 'activating', activation_claimed_at = now(), attempts = sr.attempts + 1,
           activation_run_id = p_run_id, last_error = null, updated_at = now()
      from pick
     where sr.id = pick.id
    returning sr.id, sr.email_normalized, sr.target_user_id, sr.source_row_number,
              sr.mapped->>'first_name' as first_name, sr.mapped->>'last_name' as last_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_id', upd.id, 'email', upd.email_normalized, 'target_user_id', upd.target_user_id,
           'full_name', nullif(btrim(concat_ws(' ', upd.first_name, upd.last_name)), ''))
           order by upd.source_row_number), '[]'::jsonb)
    into v_rows from upd;

  return v_rows;
end;
$fn$;

-- #67's body, copied. #68: a grandfathered member is refused; the seat count is the paid
-- term's; a refused row releases the account the import created for it (E7).
create or replace function public.legacy_import_activate_row(p_actor uuid, p_row_id uuid, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row    public.student_import_rows%rowtype;
  v_job    public.student_import_jobs%rowtype;
  v_plan   public.enrollment_plans%rowtype;
  v_batch  public.batches%rowtype;
  v_prof   public.profiles%rowtype;
  v_email  text;
  v_start  timestamptz;
  v_end    timestamptz;
  v_grace  timestamptz;
  v_status text;
  v_sub_id uuid;
  v_grant  jsonb;
  v_run    uuid;
  v_block  text;
  v_sd     date;
  v_ed     date;
begin
  perform public.legacy_import_require(p_actor);

  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activating'
     or v_row.activation_run_id is distinct from p_run_id then
    perform public.app_error('LEGACY_ROW_NOT_READY', 'That row is not being activated by this run.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  select * into v_job from public.student_import_jobs where id = v_row.job_id;
  if v_job.discarded_at is not null then
    perform public.app_error('LEGACY_JOB_BUSY', 'That migration job was discarded.', 409, null);
  end if;
  if v_row.target_user_id is null then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH', 'No account is bound to this row yet.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_row.target_user_id;
  if v_email is null or v_email is distinct from v_row.email_normalized then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH',
      'The bound account does not match this row''s email.', 409, jsonb_build_object('row_id', p_row_id));
  end if;

  -- ★ EFFECTIVE TERMS: what the Super Admin assigned at activation, else what the roster
  --   said. The roster columns stay untouched as the record of the legacy purchase.
  v_sd := coalesce(v_row.activation_start_date, v_row.legacy_start_date);
  v_ed := coalesce(v_row.activation_end_date, v_row.legacy_end_date);
  select * into v_plan from public.enrollment_plans where key = coalesce(v_row.activation_plan_key, v_row.proposed_plan_key);
  select * into v_batch from public.batches where id = coalesce(v_row.activation_batch_id, v_row.proposed_batch_id);
  select * into v_prof from public.profiles where id = v_row.target_user_id for update;
  select t.started_at, t.ends_at, t.grace_ends_at into v_start, v_end, v_grace
    from public.legacy_import_term(v_sd, v_ed) t;

  v_block := case
    when v_row.validation_status is distinct from 'valid' then 'not_valid'
    when v_row.legacy_payment_status is distinct from 'paid' then 'payment_not_paid'
    when v_plan.key is null or not v_plan.active then 'plan_inactive'
    when v_sd is null or v_ed is null or v_ed < v_sd then 'date_order'
    when v_grace <= now() then 'term_ended'
    when v_prof.id is null then 'identity_mismatch'
    when v_prof.approval_status = 'rejected' then 'profile_rejected'
    when exists (select 1 from public.staff_memberships m
                  where m.user_id = v_prof.id and m.status in ('invited', 'active')) then 'staff_account'
    when v_plan.community_segment = 'vip' and v_batch.id is null then 'batch_unknown'
    -- Only a plan that takes a cohort seat cares: a non-VIP plan grants no batch at all.
    when v_plan.community_segment = 'vip' and v_batch.id is not null and v_batch.status = 'archived' then 'batch_archived'
    -- #68: a grandfathered member (paid, no subscription row) keeps unlimited access through
    -- is_enrolled()'s no-rows branch; a dated term would end it for good. By hand only.
    when v_prof.is_paid and not exists (select 1 from public.subscriptions s where s.user_id = v_prof.id)
      then 'grandfathered_member'
    when exists (select 1 from public.subscriptions s
                  where s.user_id = v_prof.id
                    and (s.status = 'scheduled'
                         or (s.status = 'active' and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now()))))
      then 'membership_conflict'
    when v_row.external_user_id is not null
         and exists (select 1 from public.student_external_accounts a
                      where a.source = 'thinkific' and a.external_user_id = v_row.external_user_id
                        and a.user_id <> v_prof.id) then 'external_id_conflict'
  end;

  if v_block is not null then
    update public.student_import_rows
       set activation_state = 'blocked', blocked_reason = v_block, activation_claimed_at = null, updated_at = now()
     where id = p_row_id;
    -- ★ #68 (E7): AN ACCOUNT THIS IMPORT CREATED IS RELEASED WHEN ITS ROW IS REFUSED.
    --   legacy_import_bind_user() stamped it import/invited before these refusals ran, which
    --   hides it from Access Requests and forces the set-password screen; with its row now
    --   blocked for good, nothing in Student Imports could release it. Only while it is still
    --   exactly what the bind step made it. The two columns are NOT NULL (#26), so they return
    --   to their defaults, the values every ordinary signup carries.
    if v_row.auth_user_created and v_prof.id is not null
       and v_prof.account_origin = 'import' and v_prof.approval_status = 'pending'
       and v_prof.onboarding_status = 'invited' then
      update public.profiles
         set account_origin = default, onboarding_status = default, invited_at = null, updated_at = now()
       where id = v_prof.id;
      perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'import_marks_cleared', v_block,
        jsonb_build_object('run_id', p_run_id, 'user_id', v_prof.id));
    end if;
    perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'activation_blocked', v_block,
      jsonb_build_object('run_id', p_run_id));
    return jsonb_build_object('ok', false, 'outcome', 'blocked', 'reason', v_block);
  end if;

  -- An 'active' row whose grace ended but whose status was never swept is not a live
  -- membership; expire it (what expire_overdue_subscriptions() does) so it cannot trip
  -- subscriptions_one_active.
  update public.subscriptions s
     set status = 'expired', updated_at = now()
   where s.user_id = v_prof.id and s.status = 'active'
     and s.ends_at is not null and coalesce(s.grace_ends_at, s.ends_at) <= now();

  v_status := case when v_start > now() then 'scheduled' else 'active' end;
  insert into public.subscriptions (
    user_id, plan_key, status, started_at, ends_at, grace_ends_at, approved_by,
    grant_source, source_import_row_id, batch_id)
  values (
    v_prof.id, v_plan.key, v_status, v_start, v_end, v_grace, p_actor,
    'import', p_row_id, case when v_plan.community_segment = 'vip' then v_batch.id end)
  returning id into v_sub_id;

  -- ★ The cohort run comes from the LIVE registry, capacity-exempt as every import is, and
  --   attributed to the Super Admin who activated it. #68: it is sized by the seats the PAID
  --   TERM covers (legacy_import_seat_count: whole months, at least one, never more than the
  --   plan's run length) — a student who paid one month holds one cohort seat, not six.
  if v_plan.community_segment = 'vip' then
    if v_batch.status = 'open' then
      v_grant := public.grant_batch_run(v_prof.id, 'vip', v_batch.id,
        public.legacy_import_seat_count(v_sd, v_ed, v_plan.key), 'import', v_sub_id, v_plan.key, null,
        p_row_id, v_grace, p_actor, false);
    else
      v_grant := public.legacy_import_grant_closed_start_run(v_prof.id, 'vip', v_batch.id,
        public.legacy_import_seat_count(v_sd, v_ed, v_plan.key), 'import', v_sub_id, v_plan.key, null,
        p_row_id, v_grace, p_actor, false);
    end if;
    v_run := nullif(v_grant->>'run_id', '')::uuid;
  end if;

  -- ★ is_paid is set for a SCHEDULED term too, deliberately. It grants nothing on the
  --   server (every access predicate reads subscriptions.status = 'active'); the client
  --   reads it only when its subscription query FAILS, and there `false` would show a
  --   paid student the price list — the #50 rule, never quote a price to an identity you
  --   could not read. With the read working, enrollGateState() checks 'scheduled' first.
  update public.profiles p
     set approval_status = case when p.approval_status = 'pending' then 'approved' else p.approval_status end,
         approved_at = case when p.approval_status = 'pending' then now() else p.approved_at end,
         approved_by = case when p.approval_status = 'pending' then p_actor else p.approved_by end,
         -- An account that has never signed in sets its password through the claim link.
         -- A pre-existing one is stamped HERE, only now that the grant has succeeded.
         account_origin = case when v_row.existing_confirmed then p.account_origin else 'import' end,
         onboarding_status = case when v_row.existing_confirmed or p.onboarding_status = 'completed'
                                  then p.onboarding_status else 'invited' end,
         invited_at = case when v_row.existing_confirmed then p.invited_at else coalesce(p.invited_at, now()) end,
         is_paid = true,
         plan = v_plan.key,
         full_name = coalesce(nullif(btrim(p.full_name), ''),
                              nullif(btrim(concat_ws(' ', v_row.mapped->>'first_name', v_row.mapped->>'last_name')), '')),
         updated_at = now()
   where p.id = v_prof.id;

  if v_row.external_user_id is not null then
    insert into public.student_external_accounts (user_id, source, external_user_id, import_job_id, import_row_id)
    values (v_prof.id, 'thinkific', v_row.external_user_id, v_row.job_id, p_row_id)
    on conflict (source, external_user_id) do nothing;
  end if;

  update public.student_import_rows
     set activation_state = 'activated', subscription_id = v_sub_id, entitlement_run_id = v_run,
         subscription_granted = true, activated_at = now(), activated_by = p_actor,
         activation_claimed_at = null, blocked_reason = null, last_error = null,
         invite_state = 'not_sent', updated_at = now()
   where id = p_row_id;

  perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'activated', v_status,
    jsonb_build_object('run_id', p_run_id, 'subscription_id', v_sub_id, 'entitlement_run_id', v_run,
                       'plan_key', v_plan.key, 'batch_code', v_batch.code,
                       'starts_on', v_sd, 'ends_on', v_ed,
                       'terms_assigned', (v_row.activation_plan_key is not null or v_row.activation_batch_id is not null
                                          or v_row.activation_start_date is not null or v_row.activation_end_date is not null),
                       'approved_now', v_prof.approval_status = 'pending',
                       'allocated', coalesce(v_grant->'allocated', '[]'::jsonb),
                       'queued', coalesce((v_grant->>'queued')::int, 0)));

  return jsonb_build_object('ok', true, 'outcome', 'activated', 'status', v_status,
    'subscription_id', v_sub_id, 'entitlement_run_id', v_run,
    'kind', case when v_row.existing_confirmed then 'notify' else 'claim' end);
end;
$fn$;

-- #67's body, copied. #68: an onboarded account gets the sign-in notice; an invitation that
-- can never go out is recorded as failed on the automatic path instead of raising; a
-- hand-back whose request never reached the provider keeps its generation.
create or replace function public.legacy_import_begin_invite(p_actor uuid, p_row_id uuid, p_resend boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row   public.student_import_rows%rowtype;
  v_prof  public.profiles%rowtype;
  v_sub   public.subscriptions%rowtype;
  v_email text;
  v_kind  text;
  v_gen   int;
  v_code  text;
  v_reuse boolean;
begin
  perform public.legacy_import_require(p_actor);
  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activated' then
    perform public.app_error('LEGACY_ROW_NOT_READY', 'Only an activated row can be sent an invitation.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  if not coalesce(p_resend, false) and v_row.invite_state is distinct from 'not_sent' then
    return jsonb_build_object('ok', true, 'skip', true);
  end if;

  select * into v_prof from public.profiles where id = v_row.target_user_id;
  select u.email into v_email from auth.users u where u.id = v_row.target_user_id;
  -- ★ #68: A HAND-BACK WHOSE REQUEST NEVER REACHED THE PROVIDER KEEPS ITS GENERATION. The link
  --   could not be made (link_failed), there was no app address (app_url_missing), or email
  --   is not configured (email_not_configured, email_from_not_configured): nothing left this
  --   server, so the provider never saw the key legacy-claim-<row>-<generation>, and the next
  --   attempt may use it. Each such hand-back used to spend one of the twenty generations,
  --   and at twenty no button could ever invite the row again — though nobody had been
  --   emailed. NEVER resend_401/403/429: the provider received those requests and may replay
  --   a refused answer to the same key, so they take a new generation and count toward the cap.
  --   coalesce: a NULL here (no code) must read as "not reusable", never as unknown.
  v_reuse := coalesce(v_row.invite_state = 'not_sent' and v_row.invite_generation >= 1
                      and v_row.invite_code in ('link_failed', 'app_url_missing',
                                                'email_not_configured', 'email_from_not_configured'), false);
  -- ★ #68: AN INVITATION THAT CAN NEVER GO OUT IS RECORDED AS FAILED, NOT RAISED, on the
  --   automatic path. Raised, the row stayed `not_sent`: pass 2 picked it on every chunk, the
  --   run counted it as remaining for ever, and the browser loop spun on it. A Resend
  --   (p_resend) is a person's click, and keeps its refusal below. A reused generation adds
  --   nothing, so it never meets the cap.
  if (v_email is null or (v_row.invite_generation >= 20 and not v_reuse)) and not coalesce(p_resend, false) then
    v_code := case when v_email is null then 'account_missing' else 'invite_cap' end;
    update public.student_import_rows
       set invite_state = 'failed', invite_code = v_code, updated_at = now()
     where id = p_row_id;
    perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'invite_failed', v_code,
      jsonb_build_object('generation', v_row.invite_generation, 'resend', false));
    return jsonb_build_object('ok', false, 'skip', true, 'code', v_code);
  end if;
  if v_email is null then
    perform public.app_error('LEGACY_IDENTITY_MISMATCH', 'The account for this row no longer exists.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;

  -- #68: an account that has already set its password gets the sign-in notice (no token),
  -- whether or not it existed before the import. Raising here wedged a retried row whose
  -- student had set a password through a recovery link: the claim had nothing left to claim.
  v_kind := case when v_row.existing_confirmed or v_prof.onboarding_status = 'completed' then 'notify' else 'claim' end;
  if v_row.invite_generation >= 20 and not v_reuse then   -- #68: a reused generation adds nothing
    perform public.app_error('LEGACY_ROW_NOT_READY', 'This invitation has been sent too many times.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;

  v_gen := case when v_reuse then v_row.invite_generation else v_row.invite_generation + 1 end;   -- #68
  update public.student_import_rows
     set invite_generation = v_gen, invite_state = 'sending', invite_code = null, updated_at = now()
   where id = p_row_id;
  perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'invite_started', v_kind,
    jsonb_build_object('generation', v_gen, 'resend', coalesce(p_resend, false), 'reused', v_reuse));   -- #68

  -- ★ THE MEMBERSHIP THIS ROW GRANTED, read from it — not from the import row. A resend after
  --   a Super Admin extended the term must quote the new expiry, and a non-VIP plan holds no
  --   batch even when the roster named one. The row's effective terms are only the fallback
  --   for a subscription that no longer exists.
  select * into v_sub from public.subscriptions where id = v_row.subscription_id;
  return jsonb_build_object(
    'ok', true, 'skip', false, 'generation', v_gen, 'kind', v_kind, 'email', v_email,
    'user_id', v_row.target_user_id, 'full_name', v_prof.full_name,
    'plan_key', coalesce(v_sub.plan_key, v_row.activation_plan_key, v_row.proposed_plan_key),
    'plan_name', (select p.name from public.enrollment_plans p
                   where p.key = coalesce(v_sub.plan_key, v_row.activation_plan_key, v_row.proposed_plan_key)),
    'batch_name', case when v_sub.id is not null
                       then (select b.name from public.batches b where b.id = v_sub.batch_id)
                       else (select b.name from public.batches b
                              where b.id = coalesce(v_row.activation_batch_id, v_row.proposed_batch_id)) end,
    -- An ISO timestamp from the subscription (the email reads it as a Manila date), else
    -- the row's calendar date.
    'start_date', case when v_sub.id is not null then to_jsonb(v_sub.started_at)
                       else to_jsonb(coalesce(v_row.activation_start_date, v_row.legacy_start_date)) end,
    'end_date', case when v_sub.id is not null then to_jsonb(v_sub.ends_at)
                     else to_jsonb(coalesce(v_row.activation_end_date, v_row.legacy_end_date)) end);
end;
$fn$;

-- #67's body, copied. #68: accepts the `not_sent` hand-back for codes that prove nothing
-- was delivered.
create or replace function public.legacy_import_record_delivery(
  p_actor uuid, p_row_id uuid, p_generation int, p_state text, p_code text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job  uuid;
  v_code text := left(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9_:.-]', '', 'g'), 40);
begin
  perform public.legacy_import_require(p_actor);
  if p_state not in ('sent', 'uncertain', 'failed', 'notified', 'not_sent') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Unknown delivery state.', 422, null);
  end if;
  -- ★ #68: A HAND-BACK. `not_sent` returns the row to the queue, so a Resume re-sends it —
  --   under the SAME generation when the request never left this server (link_failed,
  --   app_url_missing, email_*: see legacy_import_begin_invite), under a new one, within the
  --   cap of 20, when the provider refused it. Only a code that PROVES nothing was delivered
  --   may do it: the provider refused the request outright, or it never left this server.
  --   Anything unclear stays `uncertain`, and is never re-sent blind.
  if p_state = 'not_sent' and v_code not in ('resend_401', 'resend_403', 'resend_429', 'link_failed',
                                             'app_url_missing', 'email_not_configured', 'email_from_not_configured') then
    perform public.app_error('LEGACY_STAGE_INVALID',
      'Only a refusal that proves nothing was delivered can hand an invitation back.', 422,
      jsonb_build_object('code', v_code));
  end if;
  -- Only the attempt that holds the current generation may record; a slow answer from a
  -- superseded send cannot overwrite the one that replaced it.
  update public.student_import_rows
     set invite_state = p_state, invite_code = nullif(v_code, ''),
         invite_sent_at = case when p_state in ('sent', 'notified') then now() else invite_sent_at end,
         updated_at = now()
   where id = p_row_id and invite_generation = p_generation and invite_state = 'sending'
  returning job_id into v_job;
  if v_job is null then
    return false;
  end if;
  perform public.legacy_import_log(v_job, p_row_id, p_actor,
    case when p_state = 'not_sent' then 'invite_handed_back' else 'invite_' || p_state end, nullif(v_code, ''),
    jsonb_build_object('generation', p_generation));
  return true;
end;
$fn$;

-- #67's body, copied. #68: an exclusion list, as the claim has, so one row pass 2 cannot
-- send never monopolises it. The three-argument form is dropped, not left beside it.
drop function if exists public.legacy_import_pending_invites(uuid, uuid, integer);
create or replace function public.legacy_import_pending_invites(
  p_actor uuid, p_run_id uuid, p_limit int, p_exclude uuid[] default '{}'::uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.legacy_import_require(p_actor);
  return coalesce((
    select array_agg(x.id)
      from (select sr.id
              from public.student_import_rows sr
              join public.student_import_activation_runs ru on ru.id = p_run_id
             where sr.id = any (ru.row_ids)
               and sr.activation_state = 'activated' and sr.invite_state = 'not_sent'
               -- #68: a row this request already tried is left for the next one.
               and not (sr.id = any (coalesce(p_exclude, '{}'::uuid[])))
             order by sr.source_row_number
             limit least(greatest(coalesce(p_limit, 1), 1), 20)) x), '{}'::uuid[]);
end;
$fn$;


-- == 5) The Super Admin's own RPCs ============================================

-- #67's body, copied. #68: a non-VIP row is grouped under no batch.
create or replace function public.legacy_import_job_summary(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job public.student_import_jobs%rowtype;
begin
  perform public.legacy_import_require(auth.uid());
  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2';
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404,
      jsonb_build_object('job_id', p_job_id));
  end if;
  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'filename', v_job.filename, 'fingerprint', left(v_job.content_sha256, 12),
      'status', v_job.status, 'created_at', v_job.created_at, 'discarded_at', v_job.discarded_at,
      'discard_reason', v_job.discard_reason, 'purged_at', v_job.purged_at, 'total_rows', v_job.total_rows,
      'date_format', v_job.date_format, 'plan_mapping', v_job.plan_mapping, 'batch_mapping', v_job.batch_mapping,
      'eligible_batch_codes', to_jsonb(v_job.eligible_batch_codes),
      'eligible_plan_keys', to_jsonb(v_job.eligible_plan_keys),   -- #68
      'created_by_name', (select p.full_name from public.profiles p where p.id = v_job.created_by)),
    'cohorts', (select coalesce(jsonb_agg(to_jsonb(c) order by c.batch_code nulls last), '[]'::jsonb)
                  from (select b.code as batch_code, b.name as batch_name, b.status as batch_status,
                               count(*) as total,
                               count(*) filter (where sr.activation_state = 'ready') as ready,
                               count(*) filter (where sr.activation_state = 'inactive') as inactive,
                               count(*) filter (where sr.activation_state = 'blocked') as blocked,
                               count(*) filter (where sr.activation_state in ('activating', 'failed')) as in_progress,
                               count(*) filter (where sr.activation_state = 'failed') as failed,
                               count(*) filter (where sr.activation_state = 'activated') as activated,
                               count(*) filter (where sr.activation_state = 'reverted') as reverted
                          from public.student_import_rows sr
                          left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)
                          -- #68: a batch is a VIP-only fact; a non-VIP row is grouped under no batch.
                          left join public.batches b on b.id = case when ep.community_segment = 'vip'
                                                                    then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end
                         where sr.job_id = p_job_id
                         group by b.code, b.name, b.status) c),
    'invites', (select jsonb_build_object(
                  'not_sent', count(*) filter (where sr.invite_state = 'not_sent'),
                  'sending', count(*) filter (where sr.invite_state = 'sending'),
                  'sent', count(*) filter (where sr.invite_state = 'sent'),
                  'notified', count(*) filter (where sr.invite_state = 'notified'),
                  'failed', count(*) filter (where sr.invite_state in ('failed', 'uncertain')),
                  'claimed', count(*) filter (where p.onboarding_status = 'completed' and not sr.existing_confirmed))
                  from public.student_import_rows sr
                  left join public.profiles p on p.id = sr.target_user_id
                 where sr.job_id = p_job_id and sr.activation_state = 'activated'),
    'runs', (select coalesce(jsonb_agg(to_jsonb(ru) order by ru.created_at desc), '[]'::jsonb)
               from (select r.id, r.status, cardinality(r.row_ids) as count, r.counts, r.created_at,
                            r.updated_at, r.completed_at, (r.lease_until > now()) as leased
                       from public.student_import_activation_runs r
                      where r.job_id = p_job_id
                      order by r.created_at desc limit 10) ru));
end;
$fn$;

-- #67's body, copied. #68: a non-VIP row reports no batch; rows carry the plan's name and
-- the onboarding notice's attempts, reservations and time; a p_plan_key filter (the Package
-- filter). The
-- six-argument form is dropped, not left beside it.
drop function if exists public.legacy_import_rows_page(uuid, text, text, text, integer, integer);
create or replace function public.legacy_import_rows_page(
  p_job_id uuid, p_state text default null, p_batch_code text default null,
  p_search text default null, p_limit int default 50, p_offset int default 0,
  p_plan_key text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_like  text;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
  v_out   jsonb;
begin
  perform public.legacy_import_require(auth.uid());
  if nullif(btrim(p_search), '') is not null then
    v_like := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with base as (
    select sr.*, b.code as batch_code, b.name as batch_name, p.onboarding_status, p.email as profile_email,
           p.onboarding_completed_at, s.status as subscription_status, j.created_at as imported_at, j.source as import_source,
           rb.code as roster_batch_code, rb.name as roster_batch_name, ep.name as plan_name
      from public.student_import_rows sr
      join public.student_import_jobs j on j.id = sr.job_id
      left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)
      -- #68: a batch is a VIP-only fact; a Silver or Essentials row reports none.
      left join public.batches b on b.id = case when ep.community_segment = 'vip'
                                                then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end
      left join public.batches rb on rb.id = sr.proposed_batch_id
      left join public.profiles p on p.id = sr.target_user_id
      left join public.subscriptions s on s.id = sr.subscription_id
     where sr.job_id = p_job_id
       and (p_batch_code is null or b.code = p_batch_code)
       and (p_plan_key is null or coalesce(sr.activation_plan_key, sr.proposed_plan_key) = p_plan_key)   -- #68
       and (p_state is null
            or sr.activation_state = p_state
            or (p_state = 'invite_problem' and sr.activation_state = 'activated'
                and sr.invite_state in ('failed', 'uncertain'))
            or (p_state = 'claimed' and sr.activation_state = 'activated'
                and p.onboarding_status = 'completed' and not sr.existing_confirmed))
       and (v_like is null
            or lower(coalesce(sr.email_normalized, p.email, '')) like v_like
            or lower(coalesce(sr.mapped->>'first_name', '') || ' ' || coalesce(sr.mapped->>'last_name', '')) like v_like)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'source_row_number', x.source_row_number,
        'email', coalesce(x.email_display, x.email_normalized, x.profile_email),
        'first_name', x.mapped->>'first_name', 'last_name', x.mapped->>'last_name',
        'external_user_id', x.external_user_id, 'identity_basis', x.identity_basis,
        'plan_key', coalesce(x.activation_plan_key, x.proposed_plan_key), 'plan_name', x.plan_name,   -- #68
        'legacy_plan_label', x.legacy_plan_label,
        'batch_code', x.batch_code, 'batch_name', x.batch_name, 'legacy_batch_label', x.legacy_batch_label,
        'start_date', coalesce(x.activation_start_date, x.legacy_start_date),
        'end_date', coalesce(x.activation_end_date, x.legacy_end_date),
        -- What the roster said, shown beside anything the Super Admin assigned.
        'roster_plan_key', x.proposed_plan_key, 'roster_batch_code', x.roster_batch_code,
        'roster_batch_name', x.roster_batch_name,
        'roster_start_date', x.legacy_start_date, 'roster_end_date', x.legacy_end_date,
        'terms_assigned', (x.activation_plan_key is not null or x.activation_batch_id is not null
                           or x.activation_start_date is not null or x.activation_end_date is not null),
        'phone', x.legacy_phone, 'import_source', x.import_source, 'imported_at', x.imported_at,
        'onboarding_completed_at', case when x.existing_confirmed then null else x.onboarding_completed_at end,
        'onboarding_notice_state', x.onboarding_notice_state,
        -- #68: so the panel can tell an exhausted notice and a stale send from a pending one —
        -- and a notice at its ceiling of twenty reservations, which no reset reopens.
        'onboarding_notice_attempts', x.onboarding_notice_attempts, 'onboarding_notice_at', x.onboarding_notice_at,
        'onboarding_notice_reservations', x.onboarding_notice_reservations,
        'payment_status', x.legacy_payment_status, 'amount_paid', x.legacy_amount_paid, 'currency', x.legacy_currency,
        'validation_status', x.validation_status, 'activation_state', x.activation_state,
        'invite_state', x.invite_state, 'invite_sent_at', x.invite_sent_at, 'invite_code', x.invite_code,
        'invite_generation', x.invite_generation,
        'errors', x.errors, 'warnings', x.warnings, 'blocked_reason', x.blocked_reason, 'last_error', x.last_error,
        'matched_existing', x.matched_existing, 'existing_confirmed', x.existing_confirmed,
        'attempts', x.attempts, 'activated_at', x.activated_at, 'subscription_status', x.subscription_status,
        'claimed', (x.activation_state = 'activated' and x.onboarding_status = 'completed' and not x.existing_confirmed))
        order by x.source_row_number)
      from (select * from base order by source_row_number limit v_limit offset v_off) x), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$fn$;

-- #67's body, copied. #68: p_state also accepts 'inactive' (for "select all inactive in this
-- view", which only ever PROMOTES — legacy_import_start_run() still takes ready or failed
-- rows alone), and p_plan_key narrows to one plan. Dropped and recreated with its grant.
drop function if exists public.legacy_import_ready_ids(uuid, text, text, text);
create or replace function public.legacy_import_ready_ids(
  p_job_id uuid, p_batch_code text default null, p_search text default null, p_state text default 'ready',
  p_plan_key text default null)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_like text;
begin
  perform public.legacy_import_require(auth.uid());
  -- #68: 'inactive' too, for "select all inactive in this view" — which only ever promotes.
  if coalesce(p_state, '') not in ('ready', 'failed', 'inactive') then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Only ready, failed or inactive rows can be selected.', 422, null);
  end if;
  if nullif(btrim(p_search), '') is not null then
    v_like := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return coalesce((
    select array_agg(x.id order by x.source_row_number)
      from (select sr.id, sr.source_row_number
              from public.student_import_rows sr
              left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)
              -- #68: the same batch rule as the rows page, so "in this view" means one thing.
              left join public.batches b on b.id = case when ep.community_segment = 'vip'
                                                        then coalesce(sr.activation_batch_id, sr.proposed_batch_id) end
             where sr.job_id = p_job_id
               and sr.activation_state = p_state
               and (p_batch_code is null or b.code = p_batch_code)
               and (p_plan_key is null or coalesce(sr.activation_plan_key, sr.proposed_plan_key) = p_plan_key)
               and (v_like is null
                    or lower(coalesce(sr.email_normalized, '')) like v_like
                    or lower(coalesce(sr.mapped->>'first_name', '') || ' ' || coalesce(sr.mapped->>'last_name', '')) like v_like)
             order by sr.source_row_number
             limit 200) x), '{}'::uuid[]);
end;
$fn$;

-- #67's body, copied. #68: a missing batch no longer reads as archived for a non-VIP row,
-- and every skipped row is counted under its reason.
create or replace function public.legacy_import_set_eligibility(p_row_ids uuid[], p_eligible boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := left(btrim(coalesce(p_reason, '')), 300);
  v_changed int := 0;
  v_seen    int := 0;
  v_not_valid int := 0;
  v_ended   int := 0;
  v_archived int := 0;
  v_wrong   int := 0;
  r         record;
begin
  perform public.legacy_import_require(v_actor);
  if cardinality(coalesce(p_row_ids, '{}'::uuid[])) not between 1 and 500 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Choose between 1 and 500 rows.', 422, null);
  end if;
  if char_length(v_reason) < 5 then
    perform public.app_error('LEGACY_STAGE_INVALID', 'Give a reason of at least five characters.', 422, null);
  end if;

  for r in
    select sr.id, sr.job_id, sr.activation_state, sr.validation_status,
           coalesce(sr.activation_start_date, sr.legacy_start_date) as eff_start,
           coalesce(sr.activation_end_date, sr.legacy_end_date) as eff_end,
           b.status as batch_status, j.discarded_at, ep.community_segment as plan_segment
      from public.student_import_rows sr
      join public.student_import_jobs j on j.id = sr.job_id and j.pipeline = 'legacy_v2'
      left join public.enrollment_plans ep on ep.key = coalesce(sr.activation_plan_key, sr.proposed_plan_key)
      left join public.batches b on b.id = coalesce(sr.activation_batch_id, sr.proposed_batch_id)
     where sr.id = any (p_row_ids)
     order by sr.id
     for update of sr
  loop
    v_seen := v_seen + 1;
    if r.discarded_at is not null then
      v_wrong := v_wrong + 1;
      continue;
    end if;
    if p_eligible and r.activation_state = 'inactive'
       -- #68: only a VIP row needs a live batch; a missing one is not "archived" for a
       -- Silver or Essentials row, which never has one.
       and (r.plan_segment is distinct from 'vip' or coalesce(r.batch_status, 'archived') <> 'archived')
       and (select t.grace_ends_at from public.legacy_import_term(r.eff_start, r.eff_end) t) > now() then
      update public.student_import_rows set activation_state = 'ready', updated_at = now() where id = r.id;
      perform public.legacy_import_log(r.job_id, r.id, v_actor, 'row_promoted', 'ready',
        jsonb_build_object('reason', v_reason));
      v_changed := v_changed + 1;
    elsif not p_eligible and r.activation_state = 'ready' then
      update public.student_import_rows set activation_state = 'inactive', updated_at = now() where id = r.id;
      perform public.legacy_import_log(r.job_id, r.id, v_actor, 'row_demoted', 'inactive',
        jsonb_build_object('reason', v_reason));
      v_changed := v_changed + 1;
    -- #68: every skipped row is counted under WHY, so the notice stops blaming an ended term.
    elsif r.validation_status is distinct from 'valid' then
      v_not_valid := v_not_valid + 1;
    elsif (p_eligible and r.activation_state is distinct from 'inactive')
          or (not p_eligible and r.activation_state is distinct from 'ready') then
      v_wrong := v_wrong + 1;
    elsif r.plan_segment = 'vip' and coalesce(r.batch_status, 'archived') = 'archived' then
      v_archived := v_archived + 1;
    else
      v_ended := v_ended + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'changed', v_changed,
                            'skipped', cardinality(p_row_ids) - v_changed, 'found', v_seen,
                            'skipped_reasons', jsonb_build_object('not_valid', v_not_valid, 'term_ended', v_ended,
                                                                  'batch_archived', v_archived, 'wrong_state', v_wrong));
end;
$fn$;

-- #67's body, copied. #68: the Thinkific-id link the activation made is removed with it (E6).
create or replace function public.legacy_import_revert(p_row_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
  v_row    public.student_import_rows%rowtype;
  v_sub    public.subscriptions%rowtype;
  v_prof   public.profiles%rowtype;
  v_links  int := 0;
begin
  perform public.legacy_import_require(v_actor);
  if char_length(v_reason) < 5 then
    perform public.app_error('LEGACY_REVERT_REFUSED', 'Give a reason of at least five characters.', 422, null);
  end if;
  select * into v_row from public.student_import_rows where id = p_row_id for update;
  if v_row.id is null or v_row.activation_state is distinct from 'activated' then
    perform public.app_error('LEGACY_REVERT_REFUSED', 'Only an activated row can be reverted.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  select * into v_sub from public.subscriptions where id = v_row.subscription_id for update;
  select * into v_prof from public.profiles where id = v_row.target_user_id for update;
  if v_sub.id is null
     or not (v_sub.status = 'scheduled'
             or (v_sub.status = 'active' and not v_row.existing_confirmed
                 and coalesce(v_prof.onboarding_status, '') <> 'completed')) then
    perform public.app_error('LEGACY_REVERT_REFUSED',
      'The student has already started using this membership, so it cannot be reverted here.', 409,   -- #68
      jsonb_build_object('row_id', p_row_id));
  end if;

  update public.subscriptions set status = 'cancelled', updated_at = now() where id = v_sub.id;
  if v_row.entitlement_run_id is not null then
    perform public.revoke_batch_run(v_row.target_user_id, v_row.entitlement_run_id, 'import_reverted', v_actor, 'revoked');
  end if;
  if not exists (select 1 from public.subscriptions s
                  where s.user_id = v_row.target_user_id and s.status in ('active', 'scheduled')) then
    -- plan is NOT NULL (default 'free'); the column's own default is the unpaid value.
    update public.profiles set is_paid = false, plan = default, updated_at = now() where id = v_row.target_user_id;
  end if;
  -- ★ #68 (E6): THE THINKIFIC-ID LINK THIS ACTIVATION MADE GOES WITH IT. Left behind, the
  --   corrected row (the same Thinkific id, the right email) is refused external_id_conflict
  --   at activation — a terminal state no button reaches.
  delete from public.student_external_accounts a
   where a.import_row_id = p_row_id and a.user_id = v_row.target_user_id;
  get diagnostics v_links = row_count;
  update public.student_import_rows set activation_state = 'reverted', updated_at = now() where id = p_row_id;
  perform public.legacy_import_log(v_row.job_id, p_row_id, v_actor, 'activation_reverted', 'reverted',
    jsonb_build_object('subscription_id', v_sub.id, 'entitlement_run_id', v_row.entitlement_run_id,
                       'reason', v_reason, 'external_links_removed', v_links));
  return jsonb_build_object('ok', true, 'row_id', p_row_id);
end;
$fn$;

-- #67's body, copied. #68: also clears the phone, and the Thinkific id in a discarded job (E9).
create or replace function public.legacy_import_purge_raw(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_job   public.student_import_jobs%rowtype;
  v_n     int;
begin
  perform public.legacy_import_require(v_actor);
  select * into v_job from public.student_import_jobs where id = p_job_id and pipeline = 'legacy_v2' for update;
  if v_job.id is null then
    perform public.app_error('LEGACY_JOB_NOT_FOUND', 'That migration job does not exist.', 404, null);
  end if;
  update public.student_import_rows sr
     set mapped = '{}'::jsonb, email_display = null, email_normalized = null,
         -- #68 (E9): the phone is personal data too. The Thinkific id goes only with a
         -- discarded job; an activated row's id is provenance (student_external_accounts).
         legacy_phone = null,
         external_user_id = case when v_job.discarded_at is not null then null else sr.external_user_id end,
         updated_at = now()
   where sr.job_id = p_job_id
     and (v_job.discarded_at is not null
          or (sr.activation_state in ('activated', 'reverted') and sr.target_user_id is not null))
     and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null
          or sr.legacy_phone is not null
          or (v_job.discarded_at is not null and sr.external_user_id is not null));
  get diagnostics v_n = row_count;
  if not exists (select 1 from public.student_import_rows sr
                  where sr.job_id = p_job_id
                    and (sr.mapped <> '{}'::jsonb or sr.email_display is not null or sr.email_normalized is not null
                         or sr.legacy_phone is not null
                         or (v_job.discarded_at is not null and sr.external_user_id is not null))) then
    update public.student_import_jobs set purged_at = coalesce(purged_at, now()), updated_at = now() where id = p_job_id;
  end if;
  perform public.legacy_import_log(p_job_id, null, v_actor, 'job_purged', 'purged', jsonb_build_object('rows', v_n));
  return jsonb_build_object('ok', true, 'purged_rows', v_n);
end;
$fn$;


-- == 6) The onboarding notice =================================================

-- #67's body, copied. #68: a refusal by the provider or by configuration hands its
-- reservation back, so the five tries are spent only on sends that could have worked —
-- under a ceiling of twenty reservations that nothing hands back.
-- The two-argument form is dropped, not left beside it.
drop function if exists public.legacy_import_onboarding_notice(uuid, text);
create or replace function public.legacy_import_onboarding_notice(
  p_user uuid, p_result text default null, p_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid  uuid := p_user;
  v_row  public.student_import_rows%rowtype;
  v_prof public.profiles%rowtype;
  v_sub  public.subscriptions%rowtype;
  v_code text := left(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9_:.-]', '', 'g'), 40);
  v_refund boolean;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'skip', 'no_session');
  end if;
  select sr.* into v_row
    from public.student_import_rows sr
   where sr.target_user_id = v_uid and sr.activation_state = 'activated' and not sr.existing_confirmed
   order by sr.activated_at desc nulls last
   limit 1
   for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'skip', 'not_migrated');
  end if;

  if p_result is not null then
    if p_result not in ('sent', 'failed') then
      perform public.app_error('LEGACY_STAGE_INVALID', 'Unknown onboarding notice result.', 422, null);
    end if;
    -- ★ #68: A REFUSAL THAT PROVES NOTHING WAS SENT HANDS THE RESERVATION BACK. The provider
    --   refused the key or the sender, or rate-limited the request, or email is not
    --   configured: none of those says anything about this student, so none of them may use
    --   up the five tries while the sender is being fixed. NOT resend_422: a 422 can be about
    --   one recipient (a malformed address), which is exactly the failure that repeats for
    --   ever — it uses up a try, as in #67. And whatever is refunded here still counted
    --   against onboarding_notice_reservations, which nothing hands back (the reserve below).
    v_refund := p_result = 'failed'
                and v_code in ('resend_401', 'resend_403', 'resend_429',
                               'email_not_configured', 'email_from_not_configured');
    update public.student_import_rows
       set onboarding_notice_state = p_result, onboarding_notice_at = now(),
           onboarding_notice_attempts = case when v_refund then greatest(0, onboarding_notice_attempts - 1)
                                             else onboarding_notice_attempts end,
           updated_at = now()
     where id = v_row.id and onboarding_notice_state = 'sending';
    if found then
      perform public.legacy_import_log(v_row.job_id, v_row.id, v_uid, 'onboarding_notice_' || p_result, p_result,
        jsonb_build_object('code', nullif(v_code, ''), 'refunded', v_refund));
    end if;
    return jsonb_build_object('ok', true);
  end if;

  select * into v_prof from public.profiles where id = v_uid;
  if v_prof.onboarding_status is distinct from 'completed' then
    return jsonb_build_object('ok', false, 'skip', 'not_onboarded');
  end if;
  if v_row.onboarding_notice_state = 'sent' then
    return jsonb_build_object('ok', false, 'skip', 'sent');
  end if;
  if v_row.onboarding_notice_state = 'sending' and v_row.onboarding_notice_at > now() - interval '2 minutes' then
    return jsonb_build_object('ok', false, 'skip', 'in_progress');
  end if;
  -- ★ #68: …AND A CEILING NOTHING HANDS BACK. A refund lowers the attempts, so five attempts
  --   no longer bound the reservations; twenty reservations do, for good — neither a refund
  --   nor a Super Admin's reset lowers onboarding_notice_reservations.
  if v_row.onboarding_notice_attempts >= 5 or v_row.onboarding_notice_reservations >= 20 then
    return jsonb_build_object('ok', false, 'skip', 'exhausted');
  end if;

  update public.student_import_rows
     set onboarding_notice_state = 'sending', onboarding_notice_at = now(),
         onboarding_notice_attempts = onboarding_notice_attempts + 1,
         onboarding_notice_reservations = onboarding_notice_reservations + 1,   -- #68: never handed back
         updated_at = now()
   where id = v_row.id;
  select * into v_sub from public.subscriptions where id = v_row.subscription_id;

  return jsonb_build_object(
    'ok', true, 'row_id', v_row.id,
    'full_name', v_prof.full_name,
    'email', (select u.email from auth.users u where u.id = v_uid),
    'plan_key', v_sub.plan_key,
    'plan_name', (select p.name from public.enrollment_plans p where p.key = v_sub.plan_key),
    'batch_name', (select b.name from public.batches b where b.id = v_sub.batch_id),
    'status', v_sub.status, 'started_at', v_sub.started_at, 'ends_at', v_sub.ends_at,
    'onboarded_at', v_prof.onboarding_completed_at);
end;
$fn$;

-- ★ A SUPER ADMIN'S "RESEND ONBOARDING EMAILS". Service-only: the endpoint calls it after
--   requireStaff() with the verified caller as p_actor. It reopens a notice that used up its
--   tries, or one left `sending` by a request that died. A SENT notice is final — the two
--   emails ring once — and a send still in flight is left alone.
-- ★ IT RESETS THE FIVE TRIES, NEVER THE CEILING OF TWENTY RESERVATIONS. The ceiling is the
--   one bound a refund cannot lower; a reset that lowered it would make that bound one click
--   deep, and "at most twenty per row, ever" would stop being true. So a notice that has used
--   all twenty is refused here, before any write — rather than "reset" into a state whose
--   next reservation answers `exhausted` anyway, while the page said the emails would go.
create or replace function public.legacy_import_reset_onboarding_notice(p_actor uuid, p_row_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row  public.student_import_rows%rowtype;
  v_done boolean;
begin
  perform public.legacy_import_require(p_actor);
  select * into v_row from public.student_import_rows where id = p_row_id for update;
  select (p.onboarding_status = 'completed') into v_done from public.profiles p where p.id = v_row.target_user_id;
  if v_row.id is null or v_row.activation_state is distinct from 'activated' or not coalesce(v_done, false) then
    perform public.app_error('LEGACY_ROW_NOT_READY',
      'Only an activated row whose student has finished setting up their account can have its onboarding emails sent again.', 409,
      jsonb_build_object('row_id', p_row_id));
  end if;
  if v_row.onboarding_notice_state = 'sent'
     or (v_row.onboarding_notice_state = 'sending' and v_row.onboarding_notice_at > now() - interval '2 minutes') then
    perform public.app_error('LEGACY_ROW_NOT_READY',
      'The onboarding emails were already sent, or are being sent right now.', 409,
      jsonb_build_object('row_id', p_row_id, 'state', v_row.onboarding_notice_state));
  end if;
  if v_row.onboarding_notice_reservations >= 20 then
    perform public.app_error('LEGACY_ROW_NOT_READY',
      'The onboarding emails have been tried the maximum number of times, and will not be sent again.', 409,
      jsonb_build_object('row_id', p_row_id, 'reservations', v_row.onboarding_notice_reservations));
  end if;
  -- The tries only. onboarding_notice_reservations is left exactly as it is (see above).
  update public.student_import_rows
     set onboarding_notice_state = null, onboarding_notice_attempts = 0, updated_at = now()
   where id = p_row_id;
  perform public.legacy_import_log(v_row.job_id, p_row_id, p_actor, 'onboarding_notice_reset', 'reset',
    jsonb_build_object('previous_state', v_row.onboarding_notice_state,
                       'previous_attempts', v_row.onboarding_notice_attempts,
                       'reservations', v_row.onboarding_notice_reservations));
  return jsonb_build_object('ok', true);
end;
$fn$;


-- == 7) Grants ================================================================
-- Every function this file creates or replaces, re-asserted. A NEW signature (the four
-- helpers, the reset, pending_invites, onboarding_notice, rows_page, ready_ids) starts with
-- Supabase's default EXECUTE for anon and authenticated, so the revoke is load-bearing.
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.legacy_import_plan_rank(text)',
    'public.legacy_import_seat_count(date,date,text)',
    'public.legacy_import_batch_gaps(uuid,uuid[])',
    'public.legacy_import_higher_plan_pending(uuid)',
    'public.legacy_import_stage(uuid,jsonb,jsonb)',
    'public.legacy_import_preflight(uuid,uuid,uuid[])',
    'public.legacy_import_start_run(uuid,uuid,uuid[],text,text)',
    'public.legacy_import_claim_rows(uuid,uuid,text,integer,boolean,uuid[])',
    'public.legacy_import_activate_row(uuid,uuid,uuid)',
    'public.legacy_import_begin_invite(uuid,uuid,boolean)',
    'public.legacy_import_record_delivery(uuid,uuid,integer,text,text)',
    'public.legacy_import_pending_invites(uuid,uuid,integer,uuid[])',
    'public.legacy_import_onboarding_notice(uuid,text,text)',
    'public.legacy_import_reset_onboarding_notice(uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- A Super Admin's own session (each gated inside).
  foreach f in array array[
    'public.legacy_import_job_summary(uuid)',
    'public.legacy_import_rows_page(uuid,text,text,text,integer,integer,text)',
    'public.legacy_import_ready_ids(uuid,text,text,text,text)',
    'public.legacy_import_set_eligibility(uuid[],boolean,text)',
    'public.legacy_import_revert(uuid,text)',
    'public.legacy_import_purge_raw(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$grants$;


-- == 8) Package titles ========================================================
-- ★ KEYS NEVER CHANGE. Only the two display columns move: the package the owner sells is
--   the title, and the old product name becomes the small line above it. Requests and
--   finance entries keep the name they were made under (a snapshot is history), and there
--   were 0 finance entries and 1 request in production when this ran. Keep in lockstep with
--   ENROLLMENT_PLANS_FALLBACK in src/lib/planCatalog.js and the bootstrap §9 seed.
update public.enrollment_plans p
   set name = v.name, tagline = v.tagline, updated_at = now()
  from (values ('vip',               'VIP Package',           'Personalized Coaching Program'),
               ('silver_self_paced', 'Silver · Self-Paced',   'QBO + Resume Combo'),
               ('sampler',           'Essentials',            'Sampler Session')) as v(key, name, tagline)
 where p.key = v.key
   and (p.name is distinct from v.name or p.tagline is distinct from v.tagline);


-- == 9) Error catalog =========================================================
--
-- ★ COPIED FROM #67, NOT RETYPED. The 132 inherited rows are byte-identical; LEGACY_BATCH_GAP
--   is the only addition (133 total).
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
    ('LESSON_ASSET_UNKNOWN_REF',     422, 'The lesson cites an image that does not exist, or that belongs to an unrelated course.'),
    -- ── Legacy student migration (#67) ──
    ('MEMBERSHIP_SCHEDULED_CONFLICT',409, 'The member has a migrated membership that has not started yet; no other term can be added beside it.'),
    ('ACCESS_REQUEST_IMPORT_TARGET', 409, 'The account is a migrated student still being set up; it is managed in Student Imports.'),
    ('LEGACY_JOB_NOT_FOUND',         404, 'The migration job does not exist.'),
    ('LEGACY_JOB_BUSY',              409, 'The migration job was discarded, or an activation is still running on it.'),
    ('LEGACY_JOB_SETTINGS_DIFFER',   409, 'The same roster is already staged with a different date format, mapping or eligible cohorts.'),
    ('LEGACY_TERMS_INVALID',         422, 'The membership terms chosen for activation are incomplete, inconsistent or already ended.'),
    ('LEGACY_STAGE_INVALID',         422, 'The roster, the request or its reason is incomplete or malformed.'),
    ('LEGACY_ROW_NOT_READY',         409, 'The row is not in a state that allows this action.'),
    ('LEGACY_CONFIRMATION_MISMATCH', 422, 'The typed confirmation does not match the number of rows being activated.'),
    ('LEGACY_RUN_NOT_FOUND',         404, 'The activation run does not exist.'),
    ('LEGACY_RUN_BUSY',              409, 'Another window is working this activation, or the rows are in an unfinished one.'),
    ('LEGACY_IDENTITY_MISMATCH',     409, 'The account found does not match the row''s email or Thinkific id.'),
    ('LEGACY_REVERT_REFUSED',        409, 'The activation cannot be reverted here; the student has started using it.'),
    -- ── Legacy migration, round 2 (#68) ──
    ('LEGACY_BATCH_GAP',             409, 'A month inside a cohort run has no batch while a later batch exists, so the run would skip it for good.')
  ) as t(code, http, summary);
$cat$;


-- == 10) Close-out ============================================================
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-28-legacy-migration-round2.sql', null,
  'legacy migration round 2 (#68): a batch is a VIP-only fact at every layer, so Silver and '
  'Essentials rosters stage and are made Ready by plan (student_import_jobs.eligible_plan_keys, '
  'part of the reopen comparison); a non-VIP record key uses the literal ''none'' and a valid row '
  'never has a NULL key. Cohort seats come from the paid term (legacy_import_seat_count, capped by '
  'plan_eligible_batch_count); the preflight names, and legacy_import_start_run refuses with '
  'LEGACY_BATCH_GAP, a month with no batch under a later one (legacy_import_batch_gaps). One person '
  'in two rosters: the higher plan wins (legacy_import_plan_rank; the lower row is held as '
  'higher_plan_pending at the claim, only while the higher row can still become a grant — '
  'legacy_import_higher_plan_pending, also behind the preflight''s held_row_ids); staging warns '
  'other_legacy_row, batch_ignored_for_plan, term_length_unusual and blocks grandfathered_member and '
  'multiple_plans_in_file (copies with no plan are not a different plan); a blocked row no longer '
  'reserves its key. Invitations: an onboarded account gets the sign-in notice, one that can never '
  'go out is recorded failed, a provider refusal hands the row back (not_sent), a hand-back that '
  'never reached the provider keeps its generation, pass 2 takes an exclusion list; a refused row '
  'releases the account the import created. Revert removes the Thinkific-id link; purge clears '
  'phones. Onboarding notices refund tries the provider or configuration refused (not a 422), under '
  'a hard ceiling of 20 reservations (student_import_rows.onboarding_notice_reservations) that '
  'nothing resets; legacy_import_reset_onboarding_notice is new and resets the tries only. The three '
  'plans are renamed to their package titles (keys unchanged). Restates app_error_catalog() (133 codes).')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The package titles:
--      select key, name, tagline from public.enrollment_plans order by position;
--        -> sampler | Essentials | Sampler Session
--           silver_self_paced | Silver · Self-Paced | QBO + Resume Combo
--           vip | VIP Package | Personalized Coaching Program
--
-- 2) The new column and helpers:
--      select column_default from information_schema.columns
--       where table_name = 'student_import_jobs' and column_name = 'eligible_plan_keys';   -> '{}'::text[]
--      select public.legacy_import_seat_count('2026-10-12', '2027-04-12', 'vip');          -> 6
--      select public.legacy_import_seat_count('2026-10-12', '2026-11-10', 'vip');          -> 1
--      select public.legacy_import_seat_count('2026-10-12', '2027-04-12', 'sampler');      -> 0
--      select count(*) from public.student_import_rows
--       where onboarding_notice_reservations < onboarding_notice_attempts;                 -> 0
--
-- 3) Service-only means service-only:
--      select has_function_privilege('authenticated',
--        'public.legacy_import_reset_onboarding_notice(uuid,uuid)', 'execute');            -> f
--      select has_function_privilege('authenticated',
--        'public.legacy_import_ready_ids(uuid,text,text,text,text)', 'execute');           -> t
--
-- 4) select count(*) from public.app_error_catalog();                     -> 133
--
-- 5) Before any VIP activation: every month between the first and last batch exists.
--      select to_char(m, 'YYYY-MM') from generate_series(
--        (select to_date(min(code) || '-01', 'YYYY-MM-DD') from public.batches where status <> 'archived'),
--        (select to_date(max(code) || '-01', 'YYYY-MM-DD') from public.batches), interval '1 month') m
--       where not exists (select 1 from public.batches b where b.code = to_char(m, 'YYYY-MM'));
--      -> no rows (2026-11 was missing when this was written; create it in Admin → Batches).
