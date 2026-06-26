-- Navigation/course performance indexes
--
-- These match the app's current Supabase query patterns:
-- - courses by slug / ordered catalog listing
-- - modules and lessons by course_id ordered by position
-- - lesson progress and completion by user/course
-- - feature guide completion by user/feature
--
-- Safe to run more than once. Each block checks whether the table exists first,
-- so partially configured projects can run it before every optional feature table
-- has been migrated.

do $$
begin
  if to_regclass('public.courses') is not null then
    create index if not exists courses_slug_idx
      on public.courses (slug);

    create index if not exists courses_position_created_idx
      on public.courses (position, created_at);
  end if;

  if to_regclass('public.course_modules') is not null then
    create index if not exists course_modules_course_position_idx
      on public.course_modules (course_id, position);
  end if;

  if to_regclass('public.course_lessons') is not null then
    create index if not exists course_lessons_course_position_idx
      on public.course_lessons (course_id, position);

    create index if not exists course_lessons_module_position_idx
      on public.course_lessons (module_id, position);
  end if;

  if to_regclass('public.lesson_progress') is not null then
    create index if not exists lesson_progress_user_course_idx
      on public.lesson_progress (user_id, course_id);

    create index if not exists lesson_progress_course_user_idx
      on public.lesson_progress (course_id, user_id);
  end if;

  if to_regclass('public.course_completions') is not null then
    create index if not exists course_completions_user_course_idx
      on public.course_completions (user_id, course_id);
  end if;

  if to_regclass('public.feature_video_completions') is not null then
    create index if not exists feature_video_completions_user_feature_idx
      on public.feature_video_completions (user_id, feature_key);
  end if;
end $$;
