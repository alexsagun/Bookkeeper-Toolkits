-- =============================================================================
-- #54 — Progress & Rankings: one run per course family in the denominator
-- Date: 2026-09-03        Depends on: #52, #53
--
-- A monthly cohort re-run is created by the course DUPLICATION feature: a new
-- courses row carrying the same lessons, with source_course_id pointing at the run
-- it was copied from. Both are published, and #52 counted every published course in
-- a track, so the live QuickBooks denominator was 84 lessons across two copies of
-- one 42-lesson programme. A learner who finished the whole thing scored 50% on the
-- track that carries the heaviest weight (40), and each future re-run would have
-- divided every learner s score again.
--
-- This scopes the denominator to ONE run per learner per family: the run they have
-- progress in, else the newest. It is not a batch fix and could not be one —
-- Sampler and Silver hold no cohort seat, and their denominators doubled too.
--
-- Scores CHANGE when this runs. That is the point: they were wrong before.
-- Idempotent. Transaction-free: apply statement by statement (see db/README.md).
-- =============================================================================

do $pre$
begin
  if not exists (
    select 1 from public.schema_migrations
     where filename = '2026-09-02-progress-rankings-followup.sql'
  ) then
    raise exception '#54 requires #53 (2026-09-02-progress-rankings-followup.sql) first.';
  end if;
end
$pre$;

create or replace function public.student_progress_current(p_user uuid default null)
returns table (
  user_id                 uuid,
  plan_key                text,
  batch_id                uuid,
  batch_code              text,
  enrollment_started_at   timestamptz,
  overall_score           numeric,
  foundation_score        numeric,
  qbo_score               numeric,
  profile_score           numeric,
  interview_score         numeric,
  foundation_completed    integer,
  foundation_total        integer,
  qbo_completed           integer,
  qbo_total               integer,
  profile_completed       integer,
  profile_total           integer,
  interview_completed     integer,
  interview_total         integer,
  completed_milestones    integer,
  total_milestones        integer,
  last_milestone_at       timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  -- #54: `with recursive` for the duplication-lineage walk below. Every other CTE
  -- in this chain is unchanged and non-recursive; the keyword permits both.
  with recursive members as (
    select p.id as user_id,
           coalesce(s.plan_key, nullif(p.plan, 'free'), 'legacy') as plan_key,
           coalesce(s.started_at, p.created_at) as enrollment_started_at
      from public.profiles p
      left join lateral (
        select s1.id, s1.plan_key, s1.started_at
          from public.subscriptions s1
         where s1.user_id = p.id
           and s1.status = 'active'
           and (s1.ends_at is null or coalesce(s1.grace_ends_at, s1.ends_at) > now())
         order by s1.created_at desc
         limit 1
      ) s on true
     where (p_user is null or p.id = p_user)
       and public.user_is_approved(p.id)
       and public.user_is_enrolled(p.id)
       -- ★ STAFF ARE NEVER LEARNERS, AND THIS IS THE ONLY PLACE THAT SAYS SO.
       --   Owner rule: "if you are a staff you are a staff, you can not be a staff
       --   and a student learning." Without this predicate a paying student who is
       --   later promoted keeps their subscriptions row -- no staff migration
       --   cancels one -- so s.id is still not null, and they would be scored,
       --   dense-ranked and displayed on the student-facing board, shifting every
       --   real learner down a rank and inflating total_count and the report's
       --   cohort average. user_is_enrolled() also returns true for is_admin
       --   alone, so a legacy admin carrying is_paid would enter through the
       --   second disjunct below.
       --   'invited' + 'active' only, matching #50's access-request queue:
       --   'suspended' and 'revoked' confer no authority and may be real students.
       --   This is the population for student_leaderboard, student_rank_in_scope
       --   AND student_progress_snapshot, so staff are excluded from history too.
       and not exists (
         select 1 from public.staff_memberships sm
          where sm.user_id = p.id
            and sm.status in ('invited', 'active')
       )
       and (
         s.id is not null
         or (p.is_paid and not exists (
           select 1 from public.subscriptions sx where sx.user_id = p.id
         ))
       )
  ),
  batch_context as (
    select m.user_id, chosen.batch_id, chosen.batch_code
      from members m
      left join lateral (
        select eb.batch_id, b.code as batch_code
          from public.user_entitled_batches(m.user_id) eb
          join public.batches b on b.id = eb.batch_id
         where m.plan_key = 'vip'
           and b.status <> 'archived'
           and (now() at time zone b.timezone)::date between b.starts_on and b.ends_on
         order by b.starts_on desc, b.code desc
         limit 1
      ) chosen on true
  ),
  -- ★ #54: A PROGRAM RE-RUN MUST NOT INFLATE THE DENOMINATOR.
  --   A monthly cohort re-run is a DUPLICATE course row: same 42 lessons, new ids,
  --   published alongside its source. The original eligible_lessons joined every
  --   published course in a track, so on 2026-09-01 the live QuickBooks denominator
  --   was 84 — finishing the entire programme scored 50% on the 40%-weighted track,
  --   and every future re-run would have divided it again.
  --
  --   Note this is NOT a batch problem and a courses.batch_id FK would not fix it:
  --   Sampler and Silver hold no cohort seat at all, yet their denominators doubled
  --   too. The grouping that actually matches the cause is the DUPLICATION LINEAGE.
  lineage as (
    select c.id as course_id, c.id as node_id, c.source_course_id, 0 as depth
      from public.courses c
    union all
    select l.course_id, p.id, p.source_course_id, l.depth + 1
      from lineage l
      join public.courses p on p.id = l.source_course_id
     -- Bounded: source_course_id is not constrained to be acyclic, and an admin
     -- restoring rows by hand could close a loop. 10 is far past any real chain.
     where l.depth < 10
  ),
  course_family as (
    select distinct on (course_id) course_id, node_id as root_id
      from lineage
     order by course_id, depth desc
  ),
  candidate_runs as (
    select m.user_id, c.id as course_id, f.root_id, c.created_at,
           case
             when c.slug like 'qbo-%' then 'qbo'
             when c.slug like 'resume-%' then 'profile'
             when c.slug like 'interview-%' then 'interview'
           end as track_key
      from members m
      join public.courses c
        on c.published
       and (c.slug like 'qbo-%' or c.slug like 'resume-%' or c.slug like 'interview-%')
       and (m.plan_key <> 'sampler'
            or (c.slug like 'qbo-%' and c.access_tier = 'essentials'))
      join course_family f on f.course_id = c.id
  ),
  run_progress as (
    select cr.user_id, cr.course_id, count(lp.lesson_id) as done
      from candidate_runs cr
      left join public.lesson_progress lp
        on lp.user_id = cr.user_id and lp.course_id = cr.course_id
     group by cr.user_id, cr.course_id
  ),
  chosen_run as (
    -- Exactly one run per learner per family. Theirs is the one they have actually
    -- worked in; with no progress anywhere it is the newest, so someone joining the
    -- September cohort is measured against September rather than against August.
    -- Ordered by created_at, NOT course_date: CLAUDE.md holds course_date to a
    -- display label that no function reads, and this does not break that rule.
    select distinct on (cr.user_id, cr.root_id)
           cr.user_id, cr.course_id, cr.track_key
      from candidate_runs cr
      join run_progress rp
        on rp.user_id = cr.user_id and rp.course_id = cr.course_id
     order by cr.user_id, cr.root_id, rp.done desc, cr.created_at desc, cr.course_id
  ),
  eligible_lessons as (
    select ch.user_id, l.id as lesson_id, l.course_id, ch.track_key
      from chosen_run ch
      join public.course_lessons l on l.course_id = ch.course_id
  ),
  course_tracks as (
    select e.user_id, e.track_key,
           count(*)::integer as total,
           count(lp.lesson_id)::integer as completed,
           max(lp.completed_at) as last_completed_at
      from eligible_lessons e
      left join public.lesson_progress lp
        on lp.user_id = e.user_id
       and lp.lesson_id = e.lesson_id
       and lp.course_id = e.course_id
     group by e.user_id, e.track_key
  ),
  foundation as (
    select m.user_id,
           count(cat.key)::integer as total,
           count(fc.milestone_key)::integer as completed,
           max(fc.completed_at) as last_completed_at
      from members m
      left join public.student_progress_milestones cat
        on cat.track_key = 'foundation' and cat.active and m.plan_key <> 'sampler'
      left join public.student_foundation_completions fc
        on fc.user_id = m.user_id and fc.milestone_key = cat.key and fc.completed
     group by m.user_id
  ),
  mock_guide as (
    select m.user_id,
           count(g.feature_key)::integer as total,
           (count(fvc.user_id) filter (
             where fvc.completed
               and fvc.video_version = coalesce(g.video_path, g.video_url)
           ))::integer as completed,
           max(fvc.completed_at) filter (
             where fvc.completed
               and fvc.video_version = coalesce(g.video_path, g.video_url)
           ) as last_completed_at
      from members m
      left join public.feature_guides g
        on g.feature_key = 'mock_interview_simulator'
       and g.is_active
       and nullif(coalesce(g.video_path, g.video_url), '') is not null
       and m.plan_key <> 'sampler'
      left join public.feature_video_completions fvc
        on fvc.user_id = m.user_id and fvc.feature_key = g.feature_key
     group by m.user_id
  ),
  raw as (
    select m.user_id, m.plan_key, bc.batch_id, bc.batch_code, m.enrollment_started_at,
           coalesce(f.completed, 0) as foundation_completed,
           coalesce(f.total, 0) as foundation_total,
           coalesce(q.completed, 0) as qbo_completed,
           coalesce(q.total, 0) as qbo_total,
           coalesce(pr.completed, 0) as profile_completed,
           coalesce(pr.total, 0) as profile_total,
           coalesce(iv.completed, 0) + coalesce(mg.completed, 0) as interview_completed,
           coalesce(iv.total, 0) + coalesce(mg.total, 0) as interview_total,
           greatest(f.last_completed_at, q.last_completed_at, pr.last_completed_at,
                    iv.last_completed_at, mg.last_completed_at) as last_milestone_at
      from members m
      join batch_context bc on bc.user_id = m.user_id
      left join foundation f on f.user_id = m.user_id
      left join course_tracks q on q.user_id = m.user_id and q.track_key = 'qbo'
      left join course_tracks pr on pr.user_id = m.user_id and pr.track_key = 'profile'
      left join course_tracks iv on iv.user_id = m.user_id and iv.track_key = 'interview'
      left join mock_guide mg on mg.user_id = m.user_id
  ),
  scored as (
    select r.*,
           case when r.foundation_total > 0 then round(100.0 * r.foundation_completed / r.foundation_total, 2) else 0 end as foundation_score,
           case when r.qbo_total > 0 then round(100.0 * r.qbo_completed / r.qbo_total, 2) else 0 end as qbo_score,
           case when r.profile_total > 0 then round(100.0 * r.profile_completed / r.profile_total, 2) else 0 end as profile_score,
           case when r.interview_total > 0 then round(100.0 * r.interview_completed / r.interview_total, 2) else 0 end as interview_score
      from raw r
  )
  select s.user_id, s.plan_key, s.batch_id, s.batch_code, s.enrollment_started_at,
         coalesce(round((
           case when s.foundation_total > 0 then s.foundation_score * 20 else 0 end
           + case when s.qbo_total > 0 then s.qbo_score * 40 else 0 end
           + case when s.profile_total > 0 then s.profile_score * 20 else 0 end
           + case when s.interview_total > 0 then s.interview_score * 20 else 0 end
         ) / nullif(
           (case when s.foundation_total > 0 then 20 else 0 end
            + case when s.qbo_total > 0 then 40 else 0 end
            + case when s.profile_total > 0 then 20 else 0 end
            + case when s.interview_total > 0 then 20 else 0 end), 0
         ), 2), 0)::numeric as overall_score,
         s.foundation_score::numeric, s.qbo_score::numeric,
         s.profile_score::numeric, s.interview_score::numeric,
         s.foundation_completed, s.foundation_total,
         s.qbo_completed, s.qbo_total,
         s.profile_completed, s.profile_total,
         s.interview_completed, s.interview_total,
         (s.foundation_completed + s.qbo_completed + s.profile_completed + s.interview_completed)::integer,
         (s.foundation_total + s.qbo_total + s.profile_total + s.interview_total)::integer,
         s.last_milestone_at
    from scored s;
$fn$;

-- The lineage walk and the per-learner run choice both filter on lesson_progress by
-- (user_id, course_id); course_lessons is already indexed on course_id by #52.
create index if not exists courses_source_course_idx
  on public.courses (source_course_id) where source_course_id is not null;

revoke all on function public.student_progress_current(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
  ('2026-09-03-progress-course-family-scoping.sql', null,
   'Progress scoring counts one run per course family per learner (the run they have '
   || 'progress in, else the newest), so a duplicated cohort re-run no longer doubles '
   || 'the denominator of the track it re-runs.')
on conflict (filename) do nothing;
