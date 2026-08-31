-- =============================================================================
-- #53 — Progress & Rankings follow-up: privacy and recency corrections
-- Date: 2026-09-02        Depends on: #52 (2026-09-01-student-progress-rankings)
--
-- Full code review of #52 found four defects that #52 itself cannot fix, because it
-- is already applied and logged. All four are `create or replace` on existing
-- functions — no new objects, no data migration, no downtime.
--
--   1) student_leaderboard accepted the `vip` and `general` scopes from ANY signed-in
--      learner. The rows carry no plan column, but the VIP board IS the set of VIP
--      members and `general` is its complement, so a Sampler could enumerate both.
--      `my_batch` was guarded from the start; these two were not.
--   2) complete_progress_feature_guide re-stamped completed_at on EVERY call, so a
--      learner could clear their own "needs attention" flag and move last_milestone_at
--      forward without learning anything. #52 fixed exactly this for foundation
--      milestones and missed the feature-guide path.
--   3) admin_student_progress_report excluded staff from its live arm but not from its
--      historical arm, so a promoted student reappeared as an "inactive" learner with
--      name and email for the 400-day life of their snapshots.
--   4) my_student_progress could name a lesson from an unpublished or out-of-plan
--      course in the recent-milestone feed.
--
-- Idempotent. Transaction-free: apply statement by statement (see db/README.md).
-- =============================================================================

do $pre$
begin
  if not exists (
    select 1 from public.schema_migrations
     where filename = '2026-09-01-student-progress-rankings.sql'
  ) then
    raise exception '#53 requires #52 (2026-09-01-student-progress-rankings.sql) to be applied first.';
  end if;
end
$pre$;

-- == 1) A leaderboard scope you do not belong to is a plan oracle =============

create or replace function public.student_leaderboard(
  p_scope text default 'my_plan',
  p_batch_id uuid default null,
  p_window text default 'overall',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  rank                   bigint,
  learner_label          text,
  initials               text,
  overall_score          numeric,
  completed_milestones   integer,
  total_milestones       integer,
  weekly_gain            numeric,
  foundation_score       numeric,
  qbo_score              numeric,
  profile_score          numeric,
  interview_score        numeric,
  is_current_user        boolean,
  total_count            bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_scope     text := lower(coalesce(p_scope, 'my_plan'));
  v_window    text := lower(coalesce(p_window, 'overall'));
  v_limit     integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_offset    integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  v_caller    record;
  v_is_staff  boolean;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to view rankings.';
  end if;
  if v_scope not in ('my_plan', 'general', 'vip', 'my_batch', 'all') then
    raise exception using errcode = '22023', message = 'Unknown leaderboard scope.';
  end if;
  if v_window not in ('overall', 'week') then
    raise exception using errcode = '22023', message = 'Unknown leaderboard window.';
  end if;

  select * into v_caller from public.student_progress_current(v_uid);
  select exists (
    select 1 from public.staff_memberships m
     where m.user_id = v_uid and m.status = 'active'
  ) into v_is_staff;
  if v_caller.user_id is null and not v_is_staff then
    raise exception using errcode = '42501', message = 'An active student or staff account is required.';
  end if;
  if v_scope = 'my_plan' and v_caller.user_id is null then
    v_scope := 'all';
  end if;

  -- #53: the VIP board IS the list of VIP members and general is its complement, so
  -- either one hands a caller the plan that the row shape deliberately omits. my_batch
  -- was guarded from the start; these two were not, so any signed-in Sampler could
  -- enumerate the VIP roster by label. Staff still read both — they hold
  -- student_progress.read or are simply not learners. Refused with the SAME wording
  -- my_batch uses, so probing cannot separate "not allowed" from "does not exist".
  if not v_is_staff and v_caller.user_id is not null then
    if (v_scope = 'vip'     and v_caller.plan_key <> 'vip')
    or (v_scope = 'general' and v_caller.plan_key =  'vip') then
      raise exception using errcode = '42501', message = 'That leaderboard is unavailable.';
    end if;
  end if;
  if v_scope = 'my_batch' then
    if v_caller.user_id is null or v_caller.plan_key <> 'vip' or v_caller.batch_id is null
       or (p_batch_id is not null and p_batch_id <> v_caller.batch_id) then
      raise exception using errcode = '42501', message = 'That batch leaderboard is unavailable.';
    end if;
  elsif p_batch_id is not null then
    raise exception using errcode = '22023', message = 'A batch id is valid only with my_batch.';
  end if;

  return query
  with candidates as (
    select c.*,
           -- ★ NULL means "no baseline yet", never zero. See my_student_progress().
           case when prior.overall_score is null then null
                else round(c.overall_score - prior.overall_score, 2) end as weekly_gain,
           p.full_name,
           md5(c.user_id::text) as stable_key
      from public.student_progress_current(null) c
      join public.profiles p on p.id = c.user_id
      left join public.student_ranking_preferences pref on pref.user_id = c.user_id
      left join lateral (
        select d.overall_score
          from public.student_progress_daily d
         where d.user_id = c.user_id
           and d.snapshot_date <= current_date - 7
           and d.snapshot_date >= current_date - 14
         order by d.snapshot_date desc limit 1
      ) prior on true
     where coalesce(pref.public_visible, true)
       -- ★ Most Improved ranks MEASURED movement. A learner with no baseline is
       --   excluded rather than entered at a fabricated 0.00, which would make the
       --   week board a mislabelled copy of the overall board for the first seven
       --   days after this migration, when nobody has a qualifying snapshot.
       and (v_window <> 'week' or prior.overall_score is not null)
       and case v_scope
         when 'my_plan' then c.plan_key = v_caller.plan_key
         when 'general' then c.plan_key <> 'vip'
         when 'vip' then c.plan_key = 'vip'
         when 'my_batch' then c.batch_id = v_caller.batch_id
         else true
       end
  ),
  identities as (
    select c.*,
           case
             when nullif(btrim(c.full_name), '') is null or c.full_name like '%@%'
               then 'Learner ' || lpad(abs(hashtextextended(c.user_id::text, 0) % 10000)::text, 4, '0')
             when array_length(regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'), 1) = 1
               then (regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'))[1]
             else (regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'))[1] || ' ' ||
                  upper(left((regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'))[
                    array_length(regexp_split_to_array(btrim(c.full_name), '[[:space:]]+'), 1)
                  ], 1)) || '.'
           end as public_label
      from candidates c
  ),
  ranked as (
    select i.*,
           dense_rank() over (order by
             case when v_window = 'week' then i.weekly_gain else i.overall_score end desc,
             case when v_window = 'week' then i.overall_score else null end desc nulls last,
             i.completed_milestones desc
           ) as public_rank,
           count(*) over () as public_total
      from identities i
  )
  select r.public_rank,
         r.public_label,
         upper(left(r.public_label, 1) || coalesce(substring(r.public_label from ' ([[:alnum:]])[.]$'), '')),
         r.overall_score,
         r.completed_milestones,
         r.total_milestones,
         r.weekly_gain,
         r.foundation_score,
         r.qbo_score,
         r.profile_score,
         r.interview_score,
         r.user_id = v_uid,
         r.public_total
    from ranked r
   order by r.public_rank, r.stable_key
   limit v_limit offset v_offset;
end
$fn$;

-- == 2) Guide completion records the FIRST completion ========================

create or replace function public.complete_progress_feature_guide(p_feature_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_version text;
  v_plan    text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to save guide progress.';
  end if;
  if not public.user_is_approved(v_uid) or not public.user_is_enrolled(v_uid) then
    raise exception using errcode = '42501', message = 'An active approved enrollment is required.';
  end if;
  if p_feature_key is distinct from 'mock_interview_simulator' then
    raise exception using errcode = '22023', message = 'Unknown progress guide.';
  end if;

  select nullif(coalesce(g.video_path, g.video_url), '')
    into v_version
    from public.feature_guides g
   where g.feature_key = p_feature_key and g.is_active;
  if v_version is null then
    raise exception using errcode = '42501', message = 'That guide is unavailable.';
  end if;

  select coalesce(public.user_plan_key(v_uid), nullif(p.plan, 'free'), 'legacy')
    into v_plan from public.profiles p where p.id = v_uid;
  if v_plan = 'sampler' then
    raise exception using errcode = '42501', message = 'That guide is outside your plan.';
  end if;

  insert into public.feature_video_completions
    (user_id, feature_key, video_version, completed, completed_at, updated_at)
  values (v_uid, p_feature_key, v_version, true, now(), now())
  on conflict (user_id, feature_key) do update
    set video_version = excluded.video_version,
        completed = true,
        -- #53: only a genuinely NEW video re-stamps completed_at. Refreshing it on
        -- every call let a learner clear their own "needs attention" flag by pressing
        -- the button again, and moved last_milestone_at forward with no new learning —
        -- the same recency forgery set_foundation_milestone was fixed for in #52.
        completed_at = case
          when feature_video_completions.completed is not true
            or feature_video_completions.video_version
                 is distinct from excluded.video_version
          then now()
          else feature_video_completions.completed_at
        end,
        updated_at = now();

  return jsonb_build_object('ok', true, 'feature_key', p_feature_key, 'completed', true);
end
$fn$;

-- == 3) Staff are never lapsed learners, in either arm of the report =========

create or replace function public.admin_student_progress_report(
  p_plan_key text default null,
  p_batch_id uuid default null,
  p_track text default null,
  p_completion_min numeric default null,
  p_completion_max numeric default null,
  p_inactive_days integer default null,
  p_include_inactive boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  user_id                 uuid,
  email                   text,
  full_name               text,
  plan_key                text,
  batch_id                uuid,
  batch_code              text,
  access_status           text,
  overall_score           numeric,
  track_scores            jsonb,
  track_counts            jsonb,
  completed_milestones    integer,
  total_milestones        integer,
  last_milestone_at       timestamptz,
  enrollment_started_at   timestamptz,
  public_visible          boolean,
  needs_attention         boolean,
  cohort_average          numeric,
  completion_distribution jsonb,
  needs_attention_count   bigint,
  total_count             bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 200));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 100000));
begin
  if not public.has_staff_permission('student_progress.read') then
    raise exception using errcode = '42501', message = 'student_progress.read permission required.';
  end if;
  if p_track is not null and p_track not in ('foundation', 'qbo', 'profile', 'interview') then
    raise exception using errcode = '22023', message = 'Unknown progress track.';
  end if;

  return query
  with current_rows as (
    select c.user_id, p.email, p.full_name, c.plan_key, c.batch_id, c.batch_code,
           'active'::text as access_status, c.overall_score,
           jsonb_build_object(
             'foundation', c.foundation_score, 'qbo', c.qbo_score,
             'profile', c.profile_score, 'interview', c.interview_score
           ) as track_scores,
           jsonb_build_object(
             'foundation', jsonb_build_object('completed', c.foundation_completed, 'total', c.foundation_total),
             'qbo', jsonb_build_object('completed', c.qbo_completed, 'total', c.qbo_total),
             'profile', jsonb_build_object('completed', c.profile_completed, 'total', c.profile_total),
             'interview', jsonb_build_object('completed', c.interview_completed, 'total', c.interview_total)
           ) as track_counts,
           c.completed_milestones, c.total_milestones, c.last_milestone_at,
           c.enrollment_started_at,
           coalesce(pref.public_visible, true) as public_visible
      from public.student_progress_current(null) c
      join public.profiles p on p.id = c.user_id
      left join public.student_ranking_preferences pref on pref.user_id = c.user_id
  ),
  historical_rows as (
    select distinct on (d.user_id)
           d.user_id, p.email, p.full_name, d.plan_scope as plan_key,
           d.batch_id, d.batch_code, 'inactive'::text as access_status,
           d.overall_score, d.track_scores, d.track_counts,
           d.completed_milestones, d.total_milestones, d.last_milestone_at,
           s.started_at as enrollment_started_at,
           coalesce(pref.public_visible, true) as public_visible
      from public.student_progress_daily d
      join public.profiles p on p.id = d.user_id
      left join lateral (
        select sx.started_at from public.subscriptions sx
         where sx.user_id = d.user_id order by sx.created_at desc limit 1
      ) s on true
      left join public.student_ranking_preferences pref on pref.user_id = d.user_id
     where p_include_inactive
       and not exists (select 1 from current_rows cr where cr.user_id = d.user_id)
       -- #53: current_rows already excludes staff, so without this the historical arm
       -- re-admitted every promoted student as an "inactive" learner — name, email and
       -- last scores — for the 400-day life of their snapshots. Same predicate as the
       -- population, and the same #50 rule: suspended/revoked may be real students.
       and not exists (
         select 1 from public.staff_memberships sm
          where sm.user_id = d.user_id
            and sm.status in ('invited', 'active')
       )
     order by d.user_id, d.snapshot_date desc
  ),
  combined as (
    select * from current_rows
    union all
    select * from historical_rows
  ),
  filtered as (
    select c.*,
           (c.access_status = 'active'
            and c.overall_score < 100
            and coalesce(c.last_milestone_at, c.enrollment_started_at) <= now() - interval '14 days'
            and c.enrollment_started_at <= now() - interval '7 days') as needs_attention
      from combined c
     where (p_plan_key is null or c.plan_key = p_plan_key)
       and (p_batch_id is null or c.batch_id = p_batch_id)
       and (p_completion_min is null or c.overall_score >= p_completion_min)
       and (p_completion_max is null or c.overall_score <= p_completion_max)
       and (p_inactive_days is null
            or coalesce(c.last_milestone_at, c.enrollment_started_at) <= now() - make_interval(days => greatest(0, p_inactive_days)))
       and (p_track is null
            or coalesce((c.track_counts -> p_track ->> 'total')::integer, 0) > 0
               and coalesce((c.track_counts -> p_track ->> 'completed')::integer, 0)
                   < coalesce((c.track_counts -> p_track ->> 'total')::integer, 0))
  )
  select f.user_id, f.email, f.full_name, f.plan_key, f.batch_id, f.batch_code,
         f.access_status, f.overall_score, f.track_scores, f.track_counts,
         f.completed_milestones, f.total_milestones, f.last_milestone_at,
         f.enrollment_started_at, f.public_visible, f.needs_attention,
         round(avg(f.overall_score) over (), 2),
         jsonb_build_object(
           'starting', count(*) filter (where f.overall_score < 25) over (),
           'building', count(*) filter (where f.overall_score >= 25 and f.overall_score < 50) over (),
           'progressing', count(*) filter (where f.overall_score >= 50 and f.overall_score < 75) over (),
           'nearly_complete', count(*) filter (where f.overall_score >= 75 and f.overall_score < 100) over (),
           'complete', count(*) filter (where f.overall_score = 100) over ()
         ),
         count(*) filter (where f.needs_attention) over (),
         count(*) over ()
    from filtered f
   order by f.needs_attention desc, f.overall_score asc, f.full_name nulls last, f.user_id
   limit v_limit offset v_offset;
end
$fn$;

-- == 4) The milestone feed mirrors the scorer scope ==========================

create or replace function public.my_student_progress()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_progress       record;
  v_visible        boolean;
  v_default_scope  text;
  v_prior_score    numeric;
  v_recent         jsonb;
  v_trend          jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to view progress.';
  end if;
  select * into v_progress from public.student_progress_current(v_uid);
  if v_progress.user_id is null then
    raise exception using errcode = '42501', message = 'An active approved student enrollment is required.';
  end if;

  select coalesce(pref.public_visible, true) into v_visible
    from (select 1) seed
    left join public.student_ranking_preferences pref on pref.user_id = v_uid;
  v_default_scope := case
    when v_progress.plan_key = 'vip' and v_progress.batch_id is not null then 'my_batch'
    when v_progress.plan_key = 'vip' then 'vip'
    else 'my_plan'
  end;

  -- ★ NULL means "no baseline yet", NEVER zero. A learner with no snapshot from
  --   7+ days ago has not been measured over a week, and reporting that as a 0.0
  --   gain is a fabricated number: for the first seven days after this migration
  --   NOBODY has a qualifying snapshot, so every learner would read "0.0 pts".
  --   The floor keeps a stale snapshot from masquerading as a week: if the daily
  --   job has been down, the newest qualifying row could be months old and its
  --   delta is not a 7-day gain. Outside [7, 14] days we say so instead.
  select d.overall_score into v_prior_score
    from public.student_progress_daily d
   where d.user_id = v_uid
     and d.snapshot_date <= current_date - 7
     and d.snapshot_date >= current_date - 14
   order by d.snapshot_date desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'track', recent.track_key,
           'title', recent.title,
           'completed_at', recent.completed_at
         ) order by recent.completed_at desc), '[]'::jsonb)
    into v_recent
    from (
      select 'foundation'::text as track_key, m.title, fc.completed_at
        from public.student_foundation_completions fc
        join public.student_progress_milestones m on m.key = fc.milestone_key
       where fc.user_id = v_uid and fc.completed and m.active
      union all
      select case
               when c.slug like 'qbo-%' then 'qbo'
               when c.slug like 'resume-%' then 'profile'
               when c.slug like 'interview-%' then 'interview'
             end,
             l.title, lp.completed_at
        from public.lesson_progress lp
        join public.course_lessons l
          on l.id = lp.lesson_id and l.course_id = lp.course_id
        join public.courses c on c.id = l.course_id
       where lp.user_id = v_uid
         -- #53: mirror the scorer. Without these two conjuncts the feed could name a
         -- lesson from an unpublished course, or one outside the sampler scope — a
         -- title the learner cannot open, sourced from their own row.
         and c.published
         and (v_progress.plan_key <> 'sampler'
              or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
         and (c.slug like 'qbo-%' or c.slug like 'resume-%' or c.slug like 'interview-%')
      union all
      select 'interview', coalesce(g.title, 'Mock Interview Guide'), fvc.completed_at
        from public.feature_video_completions fvc
        join public.feature_guides g on g.feature_key = fvc.feature_key
       where fvc.user_id = v_uid
         and fvc.feature_key = 'mock_interview_simulator'
         and fvc.completed
         and fvc.video_version = coalesce(g.video_path, g.video_url)
      order by completed_at desc
      limit 5
    ) recent;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', trend.snapshot_date,
           'score', trend.overall_score
         ) order by trend.snapshot_date), '[]'::jsonb)
    into v_trend
    from (
      select d.snapshot_date, d.overall_score
        from public.student_progress_daily d
       where d.user_id = v_uid
         and d.snapshot_date between current_date - 7 and current_date - 1
      union all
      select current_date, v_progress.overall_score
    ) trend;

  return jsonb_build_object(
    'overall_score', v_progress.overall_score,
    'completed_milestones', v_progress.completed_milestones,
    'total_milestones', v_progress.total_milestones,
    'last_milestone_at', v_progress.last_milestone_at,
    'weekly_gain', case when v_prior_score is null then null
                        else round(v_progress.overall_score - v_prior_score, 2) end,
    'plan_key', v_progress.plan_key,
    'batch_id', v_progress.batch_id,
    'batch_code', v_progress.batch_code,
    'default_scope', v_default_scope,
    'private_rank', case when v_visible then public.student_rank_in_scope(v_uid, v_default_scope) else null end,
    'public_visible', v_visible,
    -- ★ in_plan is a PLAN statement; total is a CONTENT statement. The client used
    --   to derive "not in your plan" from total = 0, so a full-access member was told
    --   a track they paid for was outside their plan whenever nothing was published in
    --   it yet. Only Accounting Foundations is genuinely plan-scoped (sampler cannot
    --   open that tab); the three course tracks are in every plan, and a sampler simply
    --   sees the Essentials subset of QuickBooks.
    'tracks', jsonb_build_object(
      'foundation', jsonb_build_object('score', v_progress.foundation_score, 'completed', v_progress.foundation_completed, 'total', v_progress.foundation_total, 'in_plan', v_progress.plan_key <> 'sampler'),
      'qbo', jsonb_build_object('score', v_progress.qbo_score, 'completed', v_progress.qbo_completed, 'total', v_progress.qbo_total, 'in_plan', true),
      'profile', jsonb_build_object('score', v_progress.profile_score, 'completed', v_progress.profile_completed, 'total', v_progress.profile_total, 'in_plan', v_progress.plan_key <> 'sampler'),
      'interview', jsonb_build_object('score', v_progress.interview_score, 'completed', v_progress.interview_completed, 'total', v_progress.interview_total, 'in_plan', v_progress.plan_key <> 'sampler')
    ),
    'recent_milestones', v_recent,
    'daily_trend', v_trend
  );
end
$fn$;

-- == Grants (create or replace preserves ACLs; re-asserted per house style) ==

revoke all on function public.complete_progress_feature_guide(text) from public, anon, authenticated;
grant execute on function public.complete_progress_feature_guide(text) to authenticated;
revoke all on function public.my_student_progress() from public, anon, authenticated;
grant execute on function public.my_student_progress() to authenticated;
revoke all on function public.student_leaderboard(text, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.student_leaderboard(text, uuid, text, integer, integer) to authenticated;
revoke all on function public.admin_student_progress_report(text, uuid, text, numeric, numeric, integer, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_student_progress_report(text, uuid, text, numeric, numeric, integer, boolean, integer, integer) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
  ('2026-09-02-progress-rankings-followup.sql', null,
   'Progress & Rankings follow-up: segment-scoped leaderboards, non-re-mintable guide '
   || 'completion, staff excluded from the historical report arm, scoped milestone feed.')
on conflict (filename) do nothing;
