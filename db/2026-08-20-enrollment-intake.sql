-- #42 — Full enrollment intake + the signed Training Agreement.
--
-- WHY THIS FILE EXISTS
-- Enrollment has been collected by a Google Apps Script web app living outside
-- this codebase: a full intake — 15 required answers plus an optional resume —
-- and a 12-section Training Agreement the student signs on a canvas, written to a
-- spreadsheet and two Drive folders. The in-app paywall form was a 7-field
-- approximation of it, and only five of those seven were ever checked, so phone,
-- city/country and background were optional in both the UI and the schema — a
-- near-blank enrollment was submittable.
--
-- This file gives the real intake somewhere to land, so the Apps Script and its
-- spreadsheet can be retired and Admin → Enrollments becomes the one place a
-- submission is reviewed.
--
-- SHAPE: hybrid, not everything-in-jsonb.
-- Answers an admin filters or sorts by become real columns; free prose that is
-- only ever read whole goes in `intake`. A jsonb-only design would have made
-- "show me every applicant with US experience" a sequential scan over every
-- request, and a column-per-field design would need a migration for each new
-- question. The split is the point.
--
-- ★ NOTHING IS NOT NULL.
--   Every column here is nullable even though the form requires almost all of
--   them, because rows predating this file exist and a NOT NULL would either
--   reject them or demand invented backfill values. The requirement lives in
--   validateIntake() (src/lib/enrollmentIntake.js), which is the only writer.
--   The CHECKs below still apply to anything that IS written.
--
-- ★ THE STORAGE BUCKET IS WIDENED, DELIBERATELY.
--   enrollment-receipts was created for one file kind: a payment screenshot,
--   5 MB, png/jpeg/webp/pdf. It now also carries resumes, signature PNGs and the
--   rendered agreement PDF, all under the same `<uid>/…` prefix its policies
--   already key on — so no new bucket and no new policy. But a resume is
--   routinely a .doc/.docx, which those mime types reject, and 5 MB turns away
--   phone screenshots that are now commonly larger. Both limits move here rather
--   than in the client, because a client-side cap that is looser than the bucket
--   produces an opaque storage error instead of a field message.
--
-- Depends on: #12 (enrollment) for enrollment_requests + the bucket, #39 for the
-- three-plan catalog whose keys the features update targets, #31 for the log.
-- Additive + idempotent. No row is deleted; no policy changes.

-- ═════════════════════════════════════════════════════════════════════════════
-- 0) PREFLIGHT — abort loudly rather than half-apply
-- ═════════════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regclass('public.enrollment_requests') is null then
    raise exception 'enrollment_requests is missing — run db/2026-07-04-enrollment.sql (#12) first.';
  end if;
  if to_regclass('public.enrollment_plans') is null then
    raise exception 'enrollment_plans is missing — run db/2026-07-04-enrollment.sql (#12) first.';
  end if;
  -- Without this the tail insert aborts the whole file after the DDL has run.
  if to_regclass('public.schema_migrations') is null then
    raise exception 'schema_migrations is missing — run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;
  if exists (select 1 from public.enrollment_plans where key in ('core_self_paced', 'gold_live')) then
    raise exception 'Retired plan keys still present — run db/2026-08-17-three-plan-catalog.sql (#39) first.';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1) PROMOTED COLUMNS — the answers an admin filters on
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.enrollment_requests
  add column if not exists college_course     text,
  add column if not exists current_job        text,
  add column if not exists ph_experience      text,
  add column if not exists us_experience      text,
  add column if not exists currently_employed text,
  add column if not exists prior_training     text,
  add column if not exists referred_by        text;

comment on column public.enrollment_requests.college_course is
  'Degree/course the applicant studied. Free text — "BS Accountancy" is typical but never assumed.';
comment on column public.enrollment_requests.ph_experience is
  'Philippine bookkeeping experience band. One of the four EXPERIENCE_OPTIONS in src/lib/enrollmentIntake.js — the strings are compared across cohorts, so rewording one silently splits a bucket.';
comment on column public.enrollment_requests.us_experience is
  'US/AU/UK bookkeeping experience band. Same option list as ph_experience.';
comment on column public.enrollment_requests.currently_employed is
  'YES or NO, upper-case. The casing is part of the stored value, not styling.';
comment on column public.enrollment_requests.referred_by is
  'How the applicant heard about the program. Free text: a person''s name, "Facebook ad", "Google".';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2) FREE-TEXT ANSWERS — read whole, never filtered on
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.enrollment_requests
  add column if not exists intake jsonb not null default '{}'::jsonb;

comment on column public.enrollment_requests.intake is
  'Free-text intake answers that are only ever read whole: struggles, facebook_link, plus a _v schema tag. Anything an admin needs to FILTER by belongs in its own column instead — that is the whole reason this table is not jsonb-only.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3) FILE PATHS — objects in the enrollment-receipts bucket
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.enrollment_requests
  add column if not exists resume_path              text,
  add column if not exists agreement_signature_path text,
  add column if not exists agreement_pdf_path       text;

comment on column public.enrollment_requests.resume_path is
  'Object path in enrollment-receipts, <uid>/resume-<uuid>-<name>. NULL is normal — the resume is the one optional field on the form.';
comment on column public.enrollment_requests.agreement_signature_path is
  'Object path of the drawn signature PNG, <uid>/signature-<uuid>.png. Stored as a file rather than a data URL so the row stays small enough to list cheaply in the admin table.';
comment on column public.enrollment_requests.agreement_pdf_path is
  'Object path of the rendered agreement PDF. Generated client-side from the same model the student read, so the PDF and the on-screen document cannot diverge.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4) THE SIGNATURE RECORD
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.enrollment_requests
  add column if not exists agreement_version   text,
  add column if not exists agreement_tier      text,
  add column if not exists agreement_signed_at timestamptz,
  add column if not exists agreement_snapshot  jsonb;

comment on column public.enrollment_requests.agreement_version is
  'AGREEMENT_VERSION from src/lib/trainingAgreement.js at the moment of signing. This is what makes an old signature legible later: it names the wording that was accepted, so a subsequent edit to the document never appears to have been agreed to retroactively.';
comment on column public.enrollment_requests.agreement_tier is
  'Which column of the comparison table was highlighted: sampler, silver or vip. Derived from the plan, stored because a later plan rename must not rewrite history.';
comment on column public.enrollment_requests.agreement_snapshot is
  'agreementSnapshot() output — version, tier, plan, student name, signing date and THE PRICES SHOWN. The price especially: the predecessor hardcoded PHP 15,999 into a document while the catalog charged PHP 16,999, and the number a student saw when they signed is exactly what a dispute turns on.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5) CHECKS — applied to what is written, tolerant of what already exists
-- ═════════════════════════════════════════════════════════════════════════════
-- Kept in lockstep with EXPERIENCE_OPTIONS / EMPLOYED_OPTIONS / AGREEMENT_TIERS
-- in src/lib/enrollmentIntake.js and src/lib/trainingAgreement.js.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'enrollment_requests_ph_experience_chk') then
    alter table public.enrollment_requests add constraint enrollment_requests_ph_experience_chk
      check (ph_experience is null or ph_experience in
        ('None', 'Less than 2 years', '2-5 years', '5 years and above'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'enrollment_requests_us_experience_chk') then
    alter table public.enrollment_requests add constraint enrollment_requests_us_experience_chk
      check (us_experience is null or us_experience in
        ('None', 'Less than 2 years', '2-5 years', '5 years and above'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'enrollment_requests_currently_employed_chk') then
    alter table public.enrollment_requests add constraint enrollment_requests_currently_employed_chk
      check (currently_employed is null or currently_employed in ('YES', 'NO'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'enrollment_requests_agreement_tier_chk') then
    alter table public.enrollment_requests add constraint enrollment_requests_agreement_tier_chk
      check (agreement_tier is null or agreement_tier in ('sampler', 'silver', 'vip'));
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6) STORAGE — widen the bucket for the three new file kinds
-- ═════════════════════════════════════════════════════════════════════════════
-- Paths stay under <uid>/, so enrollment_receipts_insert / _select / _delete
-- (which key on foldername(name)[1] = auth.uid()::text) already cover them and
-- are deliberately left untouched.
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('enrollment-receipts', 'enrollment-receipts', false, 10485760,
          array['image/png', 'image/jpeg', 'image/webp', 'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  on conflict (id) do update set
    public             = false,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
exception when insufficient_privilege or undefined_table then
  raise notice 'Could not update the enrollment-receipts bucket from SQL. In Dashboard → Storage set: Public OFF, 10 MB, and allow png/jpeg/webp/pdf/doc/docx.';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7) PLAN COPY — say what the agreement says
-- ═════════════════════════════════════════════════════════════════════════════
-- Two corrections, both factual rather than editorial:
--
--   a) VIP's group Resume & Interview coaching was missing. The Apps Script
--      agreement advertised "4 Live Session Zoom Group Resume & Interview
--      Coaching" while enrollment_plans listed only "1-on-1 … (1 session)", and
--      the two read as competing descriptions of one inclusion. They are two
--      separate things (confirmed 2026-08-20), so both are now listed in both
--      places and the agreement carries a row for each.
--
--   b) Discord is retired. The in-app Community replaced it, and a student who
--      reads "Discord chat support" on the pricing card and then signs an
--      agreement promising Community support has been told two different things
--      about the same benefit, minutes apart.
--
-- ★ LOCKSTEP: this seed, ENROLLMENT_PLANS_FALLBACK in src/lib/planCatalog.js and
--   the bootstrap §9 seed must agree — test/planCatalog.test.mjs pins the pair,
--   and `npm run ai:knowledge` must be re-run so the voice assistant follows.
update public.enrollment_plans set features = to_jsonb(array[
  'Simulated annual bookkeeping project for an NY-based construction company',
  '12 Live Group Zoom Trainings (MWF 9am to 11am PH Time)',
  '4 Live Group Resume & Interview Coaching Sessions',
  '1-on-1 Resume & Interview Coaching (1 session)',
  'Weekly group consult until hired',
  'Community chat support until and after hired'
]) where key = 'vip' and features::text not ilike '%4 Live Group Resume%';

update public.enrollment_plans set features = to_jsonb(array[
  'Simulated annual bookkeeping project for an NY-based construction company',
  '60-day QBO Mastery course access',
  '60-day Resume & Interview course access',
  'Weekly Community chat (Thu)'
]) where key = 'silver_self_paced' and features::text ilike '%discord%';

notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-20-enrollment-intake.sql', null,
  'enrollment intake + signed training agreement (#42): the Google Apps Script enrollment '
  'form is ported into the app, so enrollment_requests gains the full intake it never '
  'had. Seven promoted columns (college_course, current_job, ph_experience, us_experience, '
  'currently_employed, prior_training, referred_by) for what admins filter on, plus an '
  'intake jsonb for free prose. Four agreement columns record WHICH VERSION of the Training '
  'Agreement was signed, by which tier, when, and at what prices — the predecessor hardcoded '
  'PHP 15,999 into a document while the catalog charged PHP 16,999, and the price shown at '
  'signing is what a dispute turns on. Three new file paths (resume, signature PNG, rendered '
  'PDF) reuse the enrollment-receipts bucket under the same <uid>/ prefix its policies '
  'already key on, so no bucket and no policy is added — but the bucket is widened to 10 MB '
  'and gains doc/docx, because a resume is routinely a Word file that the old mime list '
  'rejected. Every column is nullable: pre-existing rows must stay valid, and the requirement '
  'lives in validateIntake(). Plan features corrected: VIP gains its 4 group Resume & '
  'Interview sessions (separate from the 1-on-1), and Discord becomes Community everywhere. '
  'Additive + idempotent; no row deleted, no policy changed. '
  'Deploy the matching client build: the new form, src/lib/enrollmentIntake.js and '
  'src/lib/trainingAgreement.js ship together.')
on conflict (filename) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING
-- ═════════════════════════════════════════════════════════════════════════════
-- 1) The columns exist and are nullable:
--      select column_name, is_nullable from information_schema.columns
--       where table_name = 'enrollment_requests'
--         and column_name in ('college_course','ph_experience','intake','agreement_version');
-- 2) The CHECKs reject an off-menu answer:
--      -- expect: violates check constraint "enrollment_requests_ph_experience_chk"
--      update public.enrollment_requests set ph_experience = '3 years-ish' where false;
-- 3) The bucket takes a Word resume and a 10 MB file:
--      select file_size_limit, allowed_mime_types from storage.buckets
--       where id = 'enrollment-receipts';
-- 4) Plan copy agrees with the agreement:
--      select key, features from public.enrollment_plans order by position;
--    Expect no 'Discord' anywhere, and both coaching lines on vip.
