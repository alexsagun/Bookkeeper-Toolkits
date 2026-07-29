-- ─────────────────────────────────────────────────────────────────────────────
-- Migration apply-log — public.schema_migrations (#31)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY: this project applies db/*.sql by hand (SQL editor / CLI), and until
-- 2026-07-26 nothing recorded WHICH files had run. That is exactly how #20/#21
-- (account-membership-requests + hardening) were silently skipped for two weeks
-- while the deployed client depended on them (the Extend Access over-grant bug).
-- This table is the lightweight fix: one row per applied migration file.
--
-- RULE going forward: whenever you run a db/*.sql file against an environment,
-- insert its row here IN THE SAME SQL editor session (each new migration file
-- should end by inserting its own row — see the tail of this file for the
-- pattern). To audit for drift: compare rows against `ls db/*.sql` — any dated
-- file missing here is unapplied.
--
-- RLS: admins can read it (so a future admin UI can show apply state); nobody
-- can write through the API — inserts happen only via the SQL editor / CLI
-- (postgres role, which owns the table and bypasses RLS).
--
-- ORDER: any time (independent). IDEMPOTENT — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.schema_migrations (
  filename   text primary key,
  checksum   text,          -- sha256 of the repo file at apply/backfill time (informational)
  applied_at timestamptz not null default now(),
  notes      text
);

alter table public.schema_migrations enable row level security;

drop policy if exists schema_migrations_admin_select on public.schema_migrations;
create policy schema_migrations_admin_select on public.schema_migrations
  for select to authenticated
  using ((select is_admin()));

-- ───────────────────────────────────────────────────────────────────
-- Backfill: every dated db/*.sql file confirmed applied to the live project as
-- of 2026-07-26 (via the full live-schema audit), plus the files applied by the
-- same day's backend pass. The 000 bootstrap is deliberately absent — it is the
-- from-scratch equivalent of this series and never ran against this database.
-- ───────────────────────────────────────────────────────────────────
insert into public.schema_migrations (filename, checksum, notes)
values
    ('2026-06-15-auth-profiles-base.sql', '063cf858c9ad4f4ede891cc06743b10d16e132073555fb0453361b608de560d7', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-16-course-platform-base.sql', '2090524fce0c0b654794b572d2f8a466a4a7dab72e72f61d0fc32e2a22bcfb0e', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-16-course-platform-storage.sql', 'c77bc6369f2f4578d954d792335fe9e3b36dcce79d22c87e0fbcdb9d0ed56212', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-17-course-date-source-id.sql', 'b8536bbf6822212b0d9cea4eb641c84bb331aece59ac527277ab20fbc6542017', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-18-sidebar-settings.sql', '2a44049a8487a1d5b308d1e6855decbc08ee3b4c3451a3a09aeff7be212248b0', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-22-feature-guides.sql', '48b62c6dd01f2f0f2ac96ba268df78d5ee2c65180bc67ee54c44086248df7884', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-22-feature-video-completions.sql', '594c4c42c4840729cc2b0c056f035b15cf6aba7d36905a393caf21f4e6e642f0', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-24-navigation-performance-indexes.sql', '965c0e376e34fe28ae3ae01b6b95db351f2f92bac242ffcaebddcf558244a508', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-29-approval-status-index.sql', '8de549a725b3448b338dea184e71106972cba6e6106219f34dda58ad367c7c15', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-06-29-profiles-realtime.sql', '7747dd38deb01de77ba7834a8494e61079f5049ff9c37ac78f8f468802e8fc5b', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-06-29-user-approval.sql', '176947ce1b8b981644746d64fd28caf74789cf83eac41d858659c4527a848295', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-04-enrollment.sql', '3b732e7436197b86516ccf09e70d540982e15c674164b1e6525b42ad244b7b8a', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-04-subscription-lifecycle.sql', '9545e3a17ba400129c6980cca02e73fe868116151c29c7541ce273912ed877b3', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-08-course-videos-private.sql', '98c444a8e7cebc613c61a4cf67ce47f1d9b13d1d766160334f44581dd0b5f177', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-08-enrollment-notify-status.sql', '614000d16a9c512380c7773ecb68652d5b96fa4fcff68e271540db706378eed8', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-08-receipt-integrity.sql', '42ed063015a7c66420b04adfbe3de348cabcf52cce86455955ccc0bdd34ad871', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-09-plan-course-access.sql', '8dfa494b466d4c5f2cc555a1fa764ab0808e530f4a4b6f3cc2e0a87333d4264d', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-10-subscription-grace.sql', 'ef2b42fa69966b0e7a3980eb3ac6d9ba24ebce8a4a93a18a2d195ecd01c51de0', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-11-account-membership-requests.sql', '94f7da53e165ef3fb86a2d8bcc77b80063c499344c9d9c22f1716cee20f8ae69', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-11-hardening.sql', '9e642840f2d4eaa36bc8a30fa4744b93d1f30a795cd3aeecbf88717616d64651', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-11-sampler-essentials-access.sql', 'e66ac9cc4a1e3ad8960ae0975efc8a1b524c55db8658d29fc135b5ab6fa50b31', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-20-community.sql', 'b4a5f67718d3ebde38f3dcc33b8567f0aa52cf18242f1bb3be1c45fed2649e8d', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-20-sampler-support-60-days.sql', 'c6966143bcbdbeb209ceae6b591bab1ae587dc63ba4a370e3e7c2128ef71e53c', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-21-community-forum.sql', '4f761fb33d959618cae38aa4dfb527b3eadf2331b526f81748d2a416ef079a46', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-22-community-hardening.sql', 'f7f7c0cac2ed61086813b25dfd20093238e7dd3f6856cb4fdc004d72cf654094', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-23-student-imports.sql', '249b74ca589f020dfd0b56c762d0ac62e45d2f046f1cc9e46bf786b29e272eff', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-24-course-ai-trainer.sql', 'f7b57a4008548c5ca0a4c40fd125e8f2ce9b05119eef16eb9a8b0570237f98c5', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-26-backend-hardening.sql', '1835fa614c5a9bddb808c48be69ee6e2927317887ca1eb7876747d4f7e1b7164', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-26-community-write-gate.sql', 'd77c723aee8ec4fad4f8db85268dcb07e0e3b74dc1df0e8a24e702a7670cb30b', 'backfilled 2026-07-26 - confirmed applied via live-schema audit'),
    ('2026-07-26-rls-initplan-and-indexes.sql', '2f18757429346c839505bf07c8e34ca19b7be73e19ce34c40ab5353818117a62', 'applied 2026-07-26 by the backend audit pass'),
    ('2026-07-26-schema-migrations-log.sql', null, 'self-recorded at creation - checksum is of the repo file, see git')
on conflict (filename) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- PATTERN for future migration files — end each new db/<date>-<name>.sql with:
--
--   insert into public.schema_migrations (filename, checksum, notes)
--   values ('<date>-<name>.sql', '<sha256 of the file>', null)
--   on conflict (filename) do nothing;
--
-- so applying the file records it in the same run.
-- ─────────────────────────────────────────────────────────────────────────────
