-- ═════════════════════════════════════════════════════════════════════════════
-- #58 — Financial Management: double-entry ledger, cash-basis reporting,
--       bank reconciliation, and the `finance.manage` capability
-- 2026-09-09
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- The business's finances live in a Google Apps Script web app over one Sheet.
-- That system has 98 server functions and exactly ONE server-side authorization
-- check, so 30 privileged mutations — reconcile, import, post to the ledger, mass
-- email — are unauthenticated endpoints. Its headline revenue number is
-- `gross = collections + outstanding`, which adds cash received to imputed
-- contract value and is then booked into the ledger as realized income by a daily
-- job that is idempotent per DATE rather than per receivable — so an unpaid
-- balance is re-recognized as revenue every day it stays open.
--
-- This file is the server half of the native replacement. The Toolkit already
-- owns the authoritative record of who paid, how much, on what plan and when
-- (enrollment_requests -> admin_finalize_enrollment -> subscriptions); finance
-- now reads from that same source of truth instead of a spreadsheet copy.
--
-- WHAT IT CREATES
--
--   * `finance.manage` — a 20th staff permission, held by super_admin ONLY.
--   * 12 `finance_*` tables: a chart of accounts, balanced double-entry journals,
--     payment events, bank imports + reconciliation, recurring templates, period
--     locks and an append-only audit ledger.
--   * `enrollment_plans.finance_income_account_id` — which income account each
--     plan's collections post to (NULL = the settings default).
--   * Reporting and setup readers plus the writer RPCs. All mutation is SECURITY DEFINER.
--
-- ★ THERE IS NO LEGACY-DATA IMPORT. The Apps Script workbook was supplied to show
--   the SHAPE of the data only; no student was ever onboarded onto it (owner
--   decision, 2026-09-12). Every figure here comes from enrollments approved in the
--   Toolkit and from entries a Super Admin records. An earlier draft staged the
--   spreadsheet into four finance_legacy_* tables; they were removed before this
--   file was ever applied, so nothing to clean up exists on any database.
--   * An AFTER UPDATE trigger on enrollment_requests that posts a balanced
--     collection entry when a payment proof is approved, in the same transaction.
--
-- ★ THE DESIGN DECISION THAT MATTERS MOST: DEFECTS ARE UNREPRESENTABLE, NOT
--   FILTERED.
--
--   `finance_accounts.subtype` has no 'accounts_receivable' in its CHECK, so no
--   receivable account can exist, so no accrual revenue entry can exist. The
--   legacy `gross` conflation is not excluded by a WHERE clause — it has nowhere
--   to live. Likewise a CHECK forbids any income/expense account from being
--   anything but `reporting_class = 'business'`, so personal spending cannot be
--   an expense; and `check ((debit > 0) <> (credit > 0))` makes the legacy
--   single-entry row (all amounts positive, sign carried in an `AccountType`
--   column) impossible to insert.
--
-- ★ ZERO CLIENT WRITE PATHS. Every finance table has exactly ONE policy: a SELECT
--   gated on `finance.manage`. There is no insert/update/delete policy on any of
--   them, and table grants are revoked then only SELECT is granted back. This is
--   deliberately stricter than the community tables, whose blanket FOR ALL
--   policies are a raw PostgREST write path. The legacy system's 30 unguarded
--   mutations become structurally unreachable rather than merely gated.
--
-- ★ AN OPERATIONS ADMIN CAUSES A FINANCE WRITE THEY CANNOT READ. The approval
--   hook is SECURITY DEFINER (so RLS does not apply to it) and is revoked from
--   every role with no grant back, so it is reachable ONLY as a trigger and has
--   no argument surface. It deliberately contains NO has_staff_permission check:
--   auth.uid() is unchanged inside a SECURITY DEFINER chain, so a check there
--   would refuse every Operations Admin approval. Its authorization is structural
--   — the only route to it is a legitimate status -> 'approved' transition, which
--   #48 already gates with `enrollment_self_approval_guard` (you cannot approve
--   your own request) AND `enroll_req_super_write` (a reviewer cannot forge a
--   request and then approve their own forgery). BOTH halves are load-bearing;
--   the preflight asserts both.
--
-- SAFETY / ORDERING (there is no transaction — one statement per round trip)
--
--   * The staff seeds run FIRST, so a mid-file abort under-grants LOUDLY (the
--     capability exists, the RPCs do not, the Super Admin is refused) rather than
--     shipping a live capability with no gate. Same direction as #45 and #56.
--   * Every table is created -> RLS enabled -> grants revoked in three ADJACENT
--     statements. Supabase grants on `public` tables by default, so any gap
--     between them is a real window in which the table is world-readable.
--   * Trigger FUNCTIONS come after every table: plpgsql resolves column
--     references at EXECUTION time, so a function naming finance_settings can be
--     created before that table exists and fail only at the first approval. This
--     is #39's batches_guard() hazard in mirror image.
--   * The approval trigger is created LAST, after the chart and settings rows are
--     in place, so it cannot fire against an unresolvable configuration.
--   * `to_char` is STABLE, not IMMUTABLE, so generated columns use extract-based
--     integer arithmetic. `now()`/`current_date` cannot appear in a CHECK, so the
--     "no future-dated row" rules are triggers.
--   * The two constraint triggers are DEFERRABLE INITIALLY DEFERRED. Non-deferred
--     they fire after line 1, see a one-sided entry, and reject EVERY multi-line
--     entry while reading as correct.
--   * ★ NEVER `alter table ... force row level security` on a finance table. That
--     subjects the table OWNER to policies and breaks the approval trigger. It
--     looks like hardening; it is a breakage.
--
-- NOT CLIENT-NEUTRAL — SHIP WITH THE BUILD. The component calls RPCs that do not
-- exist until this runs, and this file's staff seed is what makes the tab
-- reachable at all.
--
-- LOCKSTEP (CLAUDE.md)
--   this file <-> bootstrap fold §45 <-> STAFF_PERMISSIONS/ROLE_PERMISSIONS/
--   ADMIN_TAB_PERMISSION in src/lib/staffRoles.js <-> APP_ERROR_CODES +
--   APP_ERROR_COPY in src/lib/appErrors.js <-> src/lib/financeModel.js <->
--   test/financeSql.test.mjs <-> test/staffRolesSql.test.mjs (CURRENT_SEED_MIGRATION
--   + the 33 grant count) <-> test/staffRoles.test.mjs (60 cells) <->
--   test-db/financeRls.dbtest.mjs <-> scripts/audit-db.mjs.
--
-- ═════════════════════════════════════════════════════════════════════════════


-- == 0) Preflight =============================================================
-- Ordered so the cheapest, most consequential assertion runs first: a failure at
-- the schema_migrations insert at the END of this file would leave #58 fully
-- applied but UNLOGGED, which is precisely the state #31 exists to prevent.
do $pre$
declare
  v_perm_count int;
  v_fn_count   int;
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception '#58: run db/2026-07-26-schema-migrations-log.sql (#31) first.';
  end if;

  if to_regprocedure('public.app_error(text,text,int,jsonb)') is null
     or to_regprocedure('public.app_error_catalog()') is null then
    raise exception '#58: run db/2026-07-30-batch-entitlements.sql (#35) first.';
  end if;

  if to_regprocedure('public.has_staff_permission(text)') is null
     or to_regprocedure('public.user_has_staff_permission(uuid,text)') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regclass('public.staff_permissions') is null
     or to_regclass('public.staff_role_permissions') is null then
    raise exception '#58: run db/2026-08-25-staff-authorization.sql (#45) first.';
  end if;

  -- The seed restated below is the WHOLE matrix, so it must be replacing the
  -- CURRENT one. A 20th key from another branch would otherwise be clobbered.
  select count(*) into v_perm_count from public.staff_permissions;
  if v_perm_count <> 19 then
    raise exception '#58: expected 19 staff permissions before this file, found %. '
                    'Another migration has changed the matrix — reconcile before running.', v_perm_count;
  end if;
  if not exists (select 1 from public.staff_permissions where key = 'community.moderate') then
    raise exception '#58: run db/2026-09-05-community-staff-authority.sql (#56) first.';
  end if;

  if not exists (select 1 from public.schema_migrations
                  where filename = '2026-09-05-community-staff-authority.sql') then
    raise exception '#58: #56 is not recorded as applied.';
  end if;

  if to_regclass('public.enrollment_requests') is null
     or to_regclass('public.subscriptions') is null
     or to_regclass('public.enrollment_plans') is null
     or to_regclass('public.profiles') is null then
    raise exception '#58: the enrollment tables are missing — run #12/#13 first.';
  end if;

  -- ★ COLUMN-level, not table-level. plpgsql resolves column references at
  --   EXECUTION time, so a missing column here would be discovered by the first
  --   admin to click Approve rather than by this file.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'enrollment_requests'
       and column_name in ('id','amount_paid','amount_expected','plan_key','plan_name',
                           'payment_reference','status','reviewed_at','reviewed_by','user_id',
                           'email','full_name','created_at')
     group by table_name having count(distinct column_name) = 13
  ) then
    raise exception '#58: enrollment_requests is missing a column the approval hook or a report reads.';
  end if;
  -- The hook resolves a plan's income account by enrollment_plans.key (§4b).
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'enrollment_plans' and column_name = 'key'
  ) then
    raise exception '#58: enrollment_plans.key is missing — the per-plan income account cannot resolve.';
  end if;

  -- Exactly one approval path. An overload would make that claim false.
  select count(*) into v_fn_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_finalize_enrollment';
  if v_fn_count <> 1 then
    raise exception '#58: expected exactly 1 admin_finalize_enrollment, found %.', v_fn_count;
  end if;

  -- ★ THE SUBTLEST ASSERTION IN THIS FILE, and the one a reviewer should look
  --   for first. The approval hook's entire authorization argument is that
  --   reaching it requires a legitimately authorized approval. #48 supplies both
  --   halves: the guard stops you approving your OWN request, and the
  --   super-only INSERT policy stops you forging someone else's and approving
  --   that. Either one missing means this file mints revenue for a self-grant.
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'enrollment_requests' and t.tgname = 'enrollment_self_approval_guard'
       and not t.tgisinternal
  ) then
    raise exception '#58: enrollment_self_approval_guard is missing from enrollment_requests — '
                    'run db/2026-08-28-authorization-hardening.sql (#48) first.';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'enrollment_requests'
       and policyname = 'enroll_req_super_write'
  ) then
    raise exception '#58: enroll_req_super_write is missing — run #48 first. Without it a '
                    'reviewer can forge a request and approve their own forgery.';
  end if;

  -- A name collision must fail loudly rather than silently rewrite someone else's key.
  if exists (select 1 from public.staff_permissions
              where key = 'finance.manage' and category is distinct from 'Finance') then
    raise exception '#58: finance.manage already exists in another category.';
  end if;
end
$pre$;


-- == 1) Staff capability ======================================================
-- ★ All three blocks are restated IN FULL, not as deltas. test/staffRolesSql.test.mjs
--   takes the LAST `insert into public.staff_<table>` VALUES block in the current
--   seed migration and diffs it against the whole JS matrix — a four-row delta
--   would report 19 missing permissions and 32 missing pairs. #52 and #56 both
--   restate for exactly this reason.
--
-- ★ `finance.manage` goes to super_admin ONLY. Not to operations_admin, who
--   reviews payment proofs: causing a finance write is not reading the books.
--   Not to trainer. Inserting the grant is never the whole change — the policies
--   and RPCs that READ this key ship in this same file.

insert into public.staff_roles (key, label, rank, is_protected, description) values
  ('super_admin',      'Super Admin',      100, true,  'Complete product authority, including staff management and the audit trail.'),
  ('operations_admin', 'Operations Admin',  50, false, 'Reviews access requests and payment proofs, grants courses, runs batches and imports, and configures and moderates the community.'),
  ('trainer',          'Trainer',           20, false, 'Creates courses and edits the ones assigned to them, and configures and moderates the community. No access to payments or students.')
on conflict (key) do update
  set label = excluded.label,
      rank = excluded.rank,
      is_protected = excluded.is_protected,
      description = excluded.description;

insert into public.staff_permissions (key, category, label, description) values
  ('staff.manage',             'Staff',     'Invite and manage staff',         'Invite staff, assign and change roles, suspend and revoke access.'),
  ('staff.audit.read',         'Staff',     'View the staff audit trail',      'Read the full history of role assignments, suspensions and revocations.'),
  ('access_requests.review',   'Students',  'Review account access requests',  'Approve or reject new account signups.'),
  ('enrollments.review',       'Students',  'Review payment proofs',           'Approve or reject enrollment, renewal, upgrade and extension requests.'),
  ('students.assign_courses',  'Students',  'Choose granted courses',          'Select which plan-eligible course programs an approval grants.'),
  ('students.extend_access',   'Students',  'Grant special extensions',        'Extend a membership expiry outside the paid request flow. Always audited.'),
  ('students.import',          'Students',  'Import students',                 'Run the Thinkific migration wizard and issue invitations.'),
  ('batches.manage',           'Students',  'Manage cohort batches',           'Create, edit, close and archive batches, and assign members to them.'),
  ('student_progress.read',    'Students',  'View student progress reports',   'Read private operational progress reports, cohort averages, inactivity signals and CSV exports.'),
  ('courses.create',           'Courses',   'Create courses',                  'Create a new draft course and duplicate an existing one.'),
  ('courses.manage_assigned',  'Courses',   'Edit assigned courses',           'Edit the modules, lessons and videos of courses assigned to you.'),
  ('courses.manage_all',       'Courses',   'Edit every course',               'Edit any course, whether or not it is assigned to you.'),
  ('courses.publish',          'Courses',   'Publish and unpublish courses',   'Make a course visible to students, or withdraw it.'),
  ('courses.delete',           'Courses',   'Delete courses',                  'Permanently delete a course and its unreferenced media.'),
  ('course_trainer.manage',    'Courses',   'Manage AI trainer indexing',      'Enable, sync, transcribe and preview the AI course trainer.'),
  ('community.manage',         'Community', 'Configure the community',         'Create and edit channels, categories and audience rules.'),
  ('community.moderate',       'Community', 'Moderate the community',          'Pin, lock, hide and hard-delete posts and replies.'),
  ('sidebar.customize',        'Settings',  'Customize navigation labels',     'Rename stages, groups and tabs for every user in the app.'),
  ('payment_settings.manage',  'Settings',  'Edit payment settings',           'Change the manual-payment instructions and the notification address.'),
  ('finance.manage',           'Finance',   'Manage business finances',        'Open the Financial Management dashboard: the ledger, receivables, bank imports, reconciliation, the cash-basis P&L and the finance audit trail.')
on conflict (key) do update
  set category = excluded.category,
      label = excluded.label,
      description = excluded.description;

insert into public.staff_role_permissions (role_key, permission_key) values
  ('super_admin', 'staff.manage'),
  ('super_admin', 'staff.audit.read'),
  ('super_admin', 'access_requests.review'),
  ('super_admin', 'enrollments.review'),
  ('super_admin', 'students.assign_courses'),
  ('super_admin', 'students.extend_access'),
  ('super_admin', 'students.import'),
  ('super_admin', 'batches.manage'),
  ('super_admin', 'student_progress.read'),
  ('super_admin', 'courses.create'),
  ('super_admin', 'courses.manage_assigned'),
  ('super_admin', 'courses.manage_all'),
  ('super_admin', 'courses.publish'),
  ('super_admin', 'courses.delete'),
  ('super_admin', 'course_trainer.manage'),
  ('super_admin', 'community.manage'),
  ('super_admin', 'community.moderate'),
  ('super_admin', 'sidebar.customize'),
  ('super_admin', 'payment_settings.manage'),
  ('super_admin', 'finance.manage'),
  ('operations_admin', 'access_requests.review'),
  ('operations_admin', 'enrollments.review'),
  ('operations_admin', 'students.assign_courses'),
  ('operations_admin', 'students.import'),
  ('operations_admin', 'batches.manage'),
  ('operations_admin', 'student_progress.read'),
  ('operations_admin', 'community.manage'),
  ('operations_admin', 'community.moderate'),
  ('trainer', 'courses.create'),
  ('trainer', 'courses.manage_assigned'),
  ('trainer', 'course_trainer.manage'),
  ('trainer', 'community.manage'),
  ('trainer', 'community.moderate')
on conflict do nothing;


-- == 2) finance_accounts — the chart of accounts ==============================
create table if not exists public.finance_accounts (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  account_type      text not null check (account_type in ('asset','liability','equity','income','expense')),
  -- ★ 'accounts_receivable' IS DELIBERATELY ABSENT. No receivable account can
  --   exist, so no accrual revenue entry can exist, so the legacy
  --   `gross = collections + outstanding` is UNREPRESENTABLE rather than filtered.
  --   Adding it here would silently re-enable accrual revenue everywhere.
  subtype           text not null check (subtype in (
                      'cash','bank','other_current_asset','fixed_asset',
                      'credit_card','accounts_payable','loan','other_liability',
                      'owner_contribution','owner_draw','retained_earnings',
                      'operating_income','other_income',
                      'cost_of_sales','operating_expense','other_expense')),
  -- ★ A SUBTYPE BELONGS TO EXACTLY ONE ACCOUNT TYPE. Without this pairing an
  --   `expense` account of subtype `other_income` was creatable, and
  --   finance_cash_basis_pl maps its sections by SUBTYPE first — so that account's
  --   spending would have been ADDED to profit. In a file whose thesis is that
  --   defects are unrepresentable, that one was representable.
  constraint finance_accounts_subtype_matches_type check (
    (account_type = 'asset'     and subtype in ('cash','bank','other_current_asset','fixed_asset')) or
    (account_type = 'liability' and subtype in ('credit_card','accounts_payable','loan','other_liability')) or
    (account_type = 'equity'    and subtype in ('owner_contribution','owner_draw','retained_earnings')) or
    (account_type = 'income'    and subtype in ('operating_income','other_income')) or
    (account_type = 'expense'   and subtype in ('cost_of_sales','operating_expense','other_expense'))),
  -- A function of the type, so it can never disagree with it.
  normal_balance    text generated always as
                      (case when account_type in ('asset','expense') then 'debit' else 'credit' end) stored,
  reporting_class   text not null default 'business'
                      check (reporting_class in ('business','personal','owner_draw')),
  -- ★ THE P&L EXCLUSION, AS A CONSTRAINT. Personal spending can be equity, an
  --   asset or a liability — never an income or expense account. So it leaves the
  --   P&L while the cash side of its entry still ties. The legacy app did this
  --   with four hardcoded strings in the browser, invisible to the server.
  constraint finance_accounts_personal_never_pl
    check (reporting_class = 'business' or account_type not in ('income','expense')),
  constraint finance_accounts_draw_is_equity
    check ((reporting_class = 'owner_draw') = (subtype = 'owner_draw' and account_type = 'equity')),
  cash_flow_class   text not null default 'none' check (cash_flow_class in ('none','cash','card')),
  constraint finance_accounts_cash_is_bank
    check (cash_flow_class <> 'cash' or (account_type = 'asset' and subtype in ('cash','bank'))),
  constraint finance_accounts_card_is_liability
    check (cash_flow_class <> 'card' or (account_type = 'liability' and subtype = 'credit_card')),
  is_system         boolean not null default false,
  active            boolean not null default true,
  parent_account_id uuid references public.finance_accounts(id) on delete restrict,
  constraint finance_accounts_no_self_parent check (parent_account_id is distinct from id),
  sort_order        integer not null default 0,
  description       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.finance_accounts enable row level security;
revoke all on table public.finance_accounts from public, anon, authenticated;

-- == 3) Chart seed ============================================================
-- Purpose-built for THIS business, from the revenue streams its own summary
-- already tracks. Deliberately NOT COA_BASE, which is the teaching chart the
-- product ships to students' clients.
insert into public.finance_accounts (code, name, account_type, subtype, reporting_class, cash_flow_class, is_system, sort_order, description) values
  ('1000','Cash on hand',                'asset','cash',              'business','cash', true,  10, 'Physical cash.'),
  ('1010','BPI',                         'asset','bank',              'business','cash', true,  20, 'Primary operating bank account.'),
  ('1020','Security Bank',               'asset','bank',              'business','cash', false, 30, 'Secondary bank account.'),
  ('1030','GCash',                       'asset','bank',              'business','cash', false, 40, 'Mobile wallet used for student payments.'),
  ('1090','Undeposited funds',           'asset','other_current_asset','business','none',true,  90, 'Payments verified but not yet deposited.'),
  ('2100','Credit card',                 'liability','credit_card',   'business','card', false,210, 'Business credit card. A PAYMENT to this account is a transfer, not an expense.'),
  ('3000','Owner''s equity',             'equity','owner_contribution','business','none',true, 300, 'Owner capital in the business.'),
  ('3200','Owner''s draw',               'equity','owner_draw',       'owner_draw','none',true, 320, 'Personal spending and withdrawals. Never an expense; leaves the P&L while cash still ties.'),
  ('3900','Retained earnings',           'equity','retained_earnings','business','none', true, 390, 'Accumulated prior-period results.'),
  ('4000','QBO Mastery',                 'income','operating_income', 'business','none', true, 400, 'Course revenue — QuickBooks Mastery.'),
  ('4010','Resume & Interview Coaching', 'income','operating_income', 'business','none', false,410, 'Course revenue — Resume & Interview.'),
  ('4020','1-on-1 QBO Coaching',         'income','operating_income', 'business','none', false,420, 'Coaching session revenue.'),
  ('4030','Profile Optimization',        'income','operating_income', 'business','none', false,430, 'Profile optimization revenue.'),
  ('4040','Collaborations',              'income','other_income',     'business','none', false,440, 'Partner and collaboration income.'),
  ('4900','Refunds and adjustments',     'income','operating_income', 'business','none', true, 490, 'Contra-revenue. A refund debits this account.'),
  ('5000','Advertising',                 'expense','operating_expense','business','none',false,500, 'Paid acquisition.'),
  ('5010','Salaries and wages',          'expense','operating_expense','business','none',false,510, 'Staff and contractor pay.'),
  ('5020','Software subscriptions',      'expense','operating_expense','business','none',false,520, 'SaaS and tooling.'),
  ('5030','Computer and internet',       'expense','operating_expense','business','none',false,530, 'Connectivity and hardware running costs.'),
  ('5040','Office expense',              'expense','operating_expense','business','none',false,540, 'General office costs.'),
  ('5050','Rent',                        'expense','operating_expense','business','none',false,550, 'Business premises rent.'),
  ('5060','Utilities',                   'expense','operating_expense','business','none',false,560, 'Business utilities.'),
  ('5070','Professional fees',           'expense','operating_expense','business','none',false,570, 'Accounting, legal and professional services.'),
  ('5080','Bank and payment fees',       'expense','operating_expense','business','none',false,580, 'Gateway and bank charges.'),
  ('5900','Miscellaneous',               'expense','operating_expense','business','none',true, 590, 'Uncategorized business expense. Review and reclassify.')
on conflict (code) do nothing;


-- == 4) finance_settings — singleton ==========================================
create table if not exists public.finance_settings (
  id                           boolean primary key default true check (id),
  -- Validated against pg_timezone_names in the RPC (#38's idiom), not a CHECK:
  -- the zone list is server state, not a constant.
  reporting_timezone           text not null default 'Asia/Manila',
  currency                     text not null default 'PHP' check (currency = 'PHP'),
  fiscal_year_start_month      integer not null default 1 check (fiscal_year_start_month between 1 and 12),
  default_income_account_id    uuid references public.finance_accounts(id) on delete restrict,
  default_cash_account_id      uuid references public.finance_accounts(id) on delete restrict,
  default_owner_draw_account_id uuid references public.finance_accounts(id) on delete restrict,
  bank_duplicate_day_window    integer not null default 3 check (bank_duplicate_day_window between 0 and 14),
  updated_at                   timestamptz not null default now(),
  updated_by                   uuid references auth.users(id) on delete set null,
  updated_by_email             text
);
alter table public.finance_settings enable row level security;
revoke all on table public.finance_settings from public, anon, authenticated;

-- Resolved by CODE lookup, so this is correct whether the seed above inserted the
-- rows or found them already present. ON DELETE RESTRICT on all three FKs means
-- the account the approval hook posts to cannot be deleted while it is a default.
insert into public.finance_settings (id, default_income_account_id, default_cash_account_id, default_owner_draw_account_id)
select true,
       (select id from public.finance_accounts where code = '4000'),
       (select id from public.finance_accounts where code = '1010'),
       (select id from public.finance_accounts where code = '3200')
on conflict (id) do nothing;

-- == 4b) Which income account each plan's collections post to =================
-- ★ NULL MEANS "THE SETTINGS DEFAULT", and that is the only fallback. Without a
--   per-plan mapping every peso posted to 4000 QBO Mastery, so the by-account P&L
--   would read 100% QBO Mastery forever while three seeded revenue accounts could
--   never receive anything.
-- ★ ADDITIVE AND NULLABLE on a table finance does not own: enrollment_plans has no
--   triggers and the client never writes it. finance_map_plan_income_account() is
--   the only writer, and it accepts only an ACTIVE income account.
-- ★ ON DELETE SET NULL: a deleted account reverts the plan to the default rather
--   than blocking the delete (finance accounts are deactivated, never deleted, by
--   every RPC here).
alter table public.enrollment_plans
  add column if not exists finance_income_account_id uuid
    references public.finance_accounts(id) on delete set null;


-- == 5) finance_journal_entries — append-only except `memo` ===================
create table if not exists public.finance_journal_entries (
  id               uuid primary key default gen_random_uuid(),
  -- Gaps under rollback are expected and are NOT missing entries.
  entry_no         bigint generated always as identity,
  entry_date       date not null check (entry_date >= date '2020-01-01'),
  -- ★ extract-based, NOT to_char: to_char is STABLE, not IMMUTABLE, and a
  --   generated column requires immutability. The natural formulation is
  --   rejected at apply time with "generation expression is not immutable",
  --   which reads like a Postgres bug and is not.
  period_key       text generated always as (
                     lpad(extract(year from entry_date)::int::text, 4, '0') || '-' ||
                     lpad(extract(month from entry_date)::int::text, 2, '0')
                   ) stored,
  entry_kind       text not null check (entry_kind in (
                     'collection','expense','owner_draw','owner_contribution',
                     'transfer','refund','opening_balance','adjustment','reversal')),
  reverses_entry_id uuid references public.finance_journal_entries(id) on delete restrict,
  constraint finance_entry_reversal_shape
    check ((entry_kind = 'reversal') = (reverses_entry_id is not null)),
  reversal_reason  text,
  constraint finance_entry_reversal_reason
    check (entry_kind <> 'reversal' or nullif(btrim(coalesce(reversal_reason,'')),'') is not null),
  memo             text,
  source           text not null check (source in (
                     'approval','backfill','manual','recurring','bank_import','reversal')),
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null,
  created_by_email text
);
alter table public.finance_journal_entries enable row level security;
revoke all on table public.finance_journal_entries from public, anon, authenticated;

-- == 6) finance_journal_lines — append-only, fully ============================
create table if not exists public.finance_journal_lines (
  id         uuid primary key default gen_random_uuid(),
  -- The cascade is unreachable in practice: the entry DELETE guard always raises.
  entry_id   uuid not null references public.finance_journal_entries(id) on delete cascade,
  line_no    integer not null check (line_no >= 1),
  account_id uuid not null references public.finance_accounts(id) on delete restrict,
  debit      numeric(14,2) not null default 0 check (debit >= 0),
  credit     numeric(14,2) not null default 0 check (credit >= 0),
  -- ★ EXACTLY ONE SIDE PER LINE. This forbids both-zero and both-positive, which
  --   is what makes the legacy ledger shape — 228 rows, all amounts positive,
  --   the sign carried in a separate `AccountType` column — impossible to insert.
  constraint finance_line_one_side check ((debit > 0) <> (credit > 0)),
  memo       text,
  constraint finance_line_no_unique unique (entry_id, line_no)
);
alter table public.finance_journal_lines enable row level security;
revoke all on table public.finance_journal_lines from public, anon, authenticated;


-- == 7) finance_payment_events — append-only ==================================
-- does not exist at this point and references back to this table. See §11.
create table if not exists public.finance_payment_events (
  id                   uuid primary key default gen_random_uuid(),
  event_kind           text not null check (event_kind in (
                         'enrollment_collection','other_income',
                         'expense','owner_draw','owner_contribution','transfer','refund','adjustment')),
  direction            text not null check (direction in ('in','out','internal')),
  occurred_on          date not null check (occurred_on >= date '2020-01-01'),
  -- A magnitude; the sign lives in the journal. A trigger asserts this equals
  -- sum(debit) of its entry, so an event can never disagree with its posting.
  amount               numeric(14,2) not null check (amount > 0),
  currency             text not null default 'PHP' check (currency = 'PHP'),
  journal_entry_id     uuid not null unique references public.finance_journal_entries(id) on delete restrict,
  -- ★ THE IDEMPOTENCY ANCHOR. NOT NULL + UNIQUE, so a retry, a double-click and
  --   a re-run backfill all collide on a real constraint rather than on a
  --   read-then-write check — which is exactly the race the legacy daily job lost.
  idempotency_key      text not null unique,
  -- SET NULL + snapshots rather than RESTRICT: enrollment_requests cascades from
  -- profiles, so RESTRICT would block deleting an account. Deleting an account
  -- must never destroy the financial record of what it paid.
  enrollment_request_id uuid references public.enrollment_requests(id) on delete set null,
  student_user_id      uuid references auth.users(id) on delete set null,
  student_email        text,
  plan_key             text,
  plan_name            text,
  method               text check (method in ('bpi','security_bank','gcash','cash','card','other','unknown')),
  reference            text,
  memo                 text,
  source               text not null check (source in ('approval','backfill','manual','bank_import')),
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id) on delete set null,
  created_by_email     text
);
alter table public.finance_payment_events enable row level security;
revoke all on table public.finance_payment_events from public, anon, authenticated;


-- == 8) finance_period_locks + finance_audit_events ===========================
create table if not exists public.finance_period_locks (
  period_key       text primary key check (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  locked           boolean not null default true,
  locked_at        timestamptz not null default now(),
  locked_by        uuid references auth.users(id) on delete set null,
  locked_by_email  text,
  note             text,
  unlocked_at      timestamptz,
  unlocked_by      uuid references auth.users(id) on delete set null,
  unlocked_by_email text,
  unlock_reason    text,
  constraint finance_period_unlock_reason
    check (locked or nullif(btrim(coalesce(unlock_reason,'')),'') is not null)
);
alter table public.finance_period_locks enable row level security;
revoke all on table public.finance_period_locks from public, anon, authenticated;

create table if not exists public.finance_audit_events (
  id             bigint generated always as identity primary key,
  actor_user_id  uuid references auth.users(id) on delete set null,
  actor_email    text,
  action         text not null check (action in (
                   'entry_post','entry_reverse','account_create','account_update','settings_update',
                   'period_lock','period_unlock','bank_import_stage','bank_import_commit',
                   'bank_import_discard','bank_txn_status','reconciliation_open',
                   'reconciliation_match','reconciliation_close','reconciliation_reopen',
                   'recurring_post','recurring_save','reconciliation_unmatch','reconciliation_update',
                   'plan_income_map','backfill_run')),
  target_kind    text not null,
  -- ★ NO FK, deliberately — the community_moderation_events reasoning. CASCADE
  --   would erase the audit OF a deletion, SET NULL would leave an event that no
  --   longer says what it acted on, RESTRICT would make the act impossible. This
  --   is a historical identifier, not a live reference.
  target_id      uuid,
  -- ★ A TYPED COLUMN, not a formatted string. The legacy logger took three
  --   parameters and two callers passed four, so the amount was silently dropped
  --   from every ledger audit row. A typed column cannot be lost to an arity
  --   mismatch.
  amount         numeric(14,2),
  detail         jsonb not null default '{}'::jsonb,
  reason         text,
  created_at     timestamptz not null default now()
);
alter table public.finance_audit_events enable row level security;
revoke all on table public.finance_audit_events from public, anon, authenticated;


-- == 12) Bank, reconciliation, recurring ======================================
create table if not exists public.finance_bank_imports (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.finance_accounts(id) on delete restrict,
  file_name           text,
  file_sha256         text not null,
  file_size_bytes     bigint,
  row_count           integer not null default 0,
  imported_row_count  integer not null default 0,
  duplicate_row_count integer not null default 0,
  excluded_row_count  integer not null default 0,
  status              text not null default 'parsed' check (status in ('parsed','committed','discarded')),
  -- Declared by the operator at upload, so DD/MM vs MM/DD is settled by a human
  -- BEFORE any row is parsed. The legacy importer stored dates as raw strings and
  -- left the ambiguity unresolved.
  date_format         text not null check (date_format in ('ISO','DMY','MDY')),
  opening_balance     numeric(14,2),
  closing_balance     numeric(14,2),
  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id) on delete set null,
  created_by_email    text,
  committed_at        timestamptz,
  -- Re-uploading the same file to the same account is refused before parsing.
  constraint finance_bank_import_file_unique unique (account_id, file_sha256)
);
alter table public.finance_bank_imports enable row level security;
revoke all on table public.finance_bank_imports from public, anon, authenticated;

create table if not exists public.finance_bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  import_id       uuid not null references public.finance_bank_imports(id) on delete cascade,
  -- Denormalized so the fingerprint is account-scoped without a join.
  account_id      uuid not null references public.finance_accounts(id) on delete restrict,
  posted_on       date not null,
  description_raw text not null,
  -- SIGNED. Negative = money out. The legacy parser stripped every non-numeric
  -- character, so "(1,234.00)" imported as POSITIVE 1234 — a credit landing on
  -- the wrong side of the P&L.
  amount          numeric(14,2) not null check (amount <> 0),
  balance_after   numeric(14,2),
  -- ★ Account-scoped, integer-date, scaled-amount, punctuation-normalized.
  --   Digits are KEPT in the description: a reference number is the strongest
  --   natural key in the string, and stripping it would merge two genuinely
  --   different same-day transfers of the same amount into one.
  -- ★ md5(text), NOT sha256(convert_to(...)). A generated column accepts only
  --   IMMUTABLE functions and convert_to is STABLE, so the first production apply of
  --   this file was refused with "generation expression is not immutable" — and
  --   rolled back whole, which is the only reason that was harmless. The normalized
  --   string is pure ASCII, so md5 over the text has no encoding to depend on. This
  --   is a DUPLICATE-DETECTION key, not a security boundary: nobody gains anything
  --   by colliding two lines of their own bank statement.
  --   Do not "upgrade" it to sha256(<expr>::bytea). That cast runs byteain, which
  --   parses backslash escapes, and it is safe only while the regexp below happens
  --   to strip every backslash.
  fingerprint     text generated always as (
                    md5(
                      account_id::text || '|' ||
                      (extract(year from posted_on)::int * 10000
                       + extract(month from posted_on)::int * 100
                       + extract(day from posted_on)::int)::text || '|' ||
                      ((amount * 100)::bigint)::text || '|' ||
                      btrim(regexp_replace(lower(description_raw), '[^a-z0-9]+', ' ', 'g'))
                    )
                  ) stored,
  status          text not null default 'unmatched'
                    check (status in ('unmatched','matched','excluded','duplicate')),
  duplicate_of_id uuid references public.finance_bank_transactions(id) on delete set null,
  duplicate_kind  text check (duplicate_kind in ('exact','likely')),
  excluded_reason text,
  constraint finance_bank_txn_excluded_reason
    check (status <> 'excluded' or nullif(btrim(coalesce(excluded_reason,'')),'') is not null),
  matched_entry_id uuid references public.finance_journal_entries(id) on delete restrict,
  created_at      timestamptz not null default now()
);
alter table public.finance_bank_transactions enable row level security;
revoke all on table public.finance_bank_transactions from public, anon, authenticated;

create table if not exists public.finance_reconciliations (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.finance_accounts(id) on delete restrict,
  period_start       date not null,
  period_end         date not null,
  constraint finance_recon_period check (period_end >= period_start),
  statement_opening  numeric(14,2),
  statement_closing  numeric(14,2),
  difference         numeric(14,2),
  status             text not null default 'open' check (status in ('open','closed')),
  closed_at          timestamptz,
  closed_by          uuid references auth.users(id) on delete set null,
  closed_by_email    text,
  reopened_at        timestamptz,
  reopened_by        uuid references auth.users(id) on delete set null,
  reopened_by_email  text,
  reopen_reason      text,
  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id) on delete set null,
  created_by_email   text
);
alter table public.finance_reconciliations enable row level security;
revoke all on table public.finance_reconciliations from public, anon, authenticated;

-- One open reconciliation per account — the subscriptions_one_active idiom.
create unique index if not exists finance_recon_one_open
  on public.finance_reconciliations (account_id) where status = 'open';

create table if not exists public.finance_reconciliation_items (
  id                  uuid primary key default gen_random_uuid(),
  reconciliation_id   uuid not null references public.finance_reconciliations(id) on delete cascade,
  bank_transaction_id uuid not null references public.finance_bank_transactions(id) on delete restrict,
  journal_line_id     uuid references public.finance_journal_lines(id) on delete restrict,
  matched_amount      numeric(14,2) not null check (matched_amount <> 0),
  created_at          timestamptz not null default now(),
  constraint finance_recon_item_unique unique (reconciliation_id, bank_transaction_id)
);
alter table public.finance_reconciliation_items enable row level security;
revoke all on table public.finance_reconciliation_items from public, anon, authenticated;

-- A ledger line may be reconciled ONCE, ever — across all reconciliations.
create unique index if not exists finance_recon_item_line_once
  on public.finance_reconciliation_items (journal_line_id) where journal_line_id is not null;

create table if not exists public.finance_recurring_templates (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  account_id        uuid not null references public.finance_accounts(id) on delete restrict,
  contra_account_id uuid not null references public.finance_accounts(id) on delete restrict,
  constraint finance_recurring_two_accounts check (account_id <> contra_account_id),
  amount            numeric(14,2) not null check (amount > 0),
  entry_kind        text not null check (entry_kind in (
                      'collection','expense','owner_draw','owner_contribution',
                      'transfer','refund','opening_balance','adjustment')),
  memo              text,
  cadence           text not null check (cadence in ('monthly','weekly','quarterly','yearly')),
  day_of_month      integer check (day_of_month between 1 and 31),
  weekday           integer check (weekday between 0 and 6),
  constraint finance_recurring_schedule_shape check (
    (cadence = 'weekly'  and weekday is not null and day_of_month is null) or
    (cadence <> 'weekly' and day_of_month is not null and weekday is null)),
  next_due_on       date not null,
  active            boolean not null default true,
  last_proposed_on  date,
  last_posted_entry_id uuid references public.finance_journal_entries(id) on delete set null,
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  created_by_email  text,
  updated_at        timestamptz not null default now()
);
alter table public.finance_recurring_templates enable row level security;
revoke all on table public.finance_recurring_templates from public, anon, authenticated;
-- ★ A TEMPLATE PROPOSES; IT NEVER POSTS. No scheduled job inserts from this
--   table. The dashboard reads `active and next_due_on <= today` and a human
--   confirms each one. The legacy app POSTED 22 expenses x 7 months in advance,
--   so its ledger carried three months of the future.


-- == 13) Indexes ==============================================================
create index if not exists finance_accounts_type_idx      on public.finance_accounts (account_type, subtype);
create index if not exists finance_accounts_active_idx    on public.finance_accounts (active) where active;
create index if not exists finance_accounts_cash_idx      on public.finance_accounts (cash_flow_class) where cash_flow_class <> 'none';

create index if not exists finance_entries_date_idx       on public.finance_journal_entries (entry_date desc);
create index if not exists finance_entries_period_idx     on public.finance_journal_entries (period_key);
create index if not exists finance_entries_kind_date_idx  on public.finance_journal_entries (entry_kind, entry_date desc);
create index if not exists finance_entries_source_idx     on public.finance_journal_entries (source, entry_date desc);
create unique index if not exists finance_entries_reversal_once
  on public.finance_journal_entries (reverses_entry_id) where reverses_entry_id is not null;
create unique index if not exists finance_entries_idem_unique
  on public.finance_journal_entries (idempotency_key) where idempotency_key is not null;

create index if not exists finance_lines_entry_idx        on public.finance_journal_lines (entry_id, line_no);
create index if not exists finance_lines_account_idx      on public.finance_journal_lines (account_id, entry_id);

create index if not exists finance_events_date_idx        on public.finance_payment_events (occurred_on desc);
create index if not exists finance_events_kind_date_idx   on public.finance_payment_events (event_kind, occurred_on desc);
create index if not exists finance_events_request_idx     on public.finance_payment_events (enrollment_request_id) where enrollment_request_id is not null;
create index if not exists finance_events_student_idx     on public.finance_payment_events (student_user_id, occurred_on desc) where student_user_id is not null;

create index if not exists finance_audit_created_idx      on public.finance_audit_events (created_at desc);
create index if not exists finance_audit_actor_idx        on public.finance_audit_events (actor_user_id, created_at desc);
create index if not exists finance_audit_target_idx       on public.finance_audit_events (target_kind, target_id, created_at desc);
create index if not exists finance_audit_action_idx       on public.finance_audit_events (action, created_at desc);

create index if not exists finance_bank_txn_acct_date_idx on public.finance_bank_transactions (account_id, posted_on);
create index if not exists finance_bank_txn_fp_idx        on public.finance_bank_transactions (fingerprint);
create index if not exists finance_bank_txn_import_idx    on public.finance_bank_transactions (import_id);
create index if not exists finance_bank_txn_open_idx      on public.finance_bank_transactions (status) where status <> 'matched';
create index if not exists finance_bank_txn_likely_idx    on public.finance_bank_transactions (account_id, abs(amount), posted_on);

create index if not exists finance_bank_imports_acct_idx  on public.finance_bank_imports (account_id, created_at desc);
create index if not exists finance_recon_acct_idx         on public.finance_reconciliations (account_id, period_end desc);
create index if not exists finance_recon_item_recon_idx   on public.finance_reconciliation_items (reconciliation_id);
create index if not exists finance_recon_item_txn_idx     on public.finance_reconciliation_items (bank_transaction_id);
create index if not exists finance_recurring_due_idx      on public.finance_recurring_templates (next_due_on) where active;


-- == 14) Grants + the ONE policy per table ====================================
-- ★ SELECT AND NOTHING ELSE. There is no insert/update/delete policy on any
--   finance table in this file, and none may ever be added: all mutation goes
--   through the SECURITY DEFINER RPCs below, so there is no raw PostgREST write
--   path over finance data at all. That is what makes the legacy system's 30
--   unguarded mutations structurally unreachable rather than merely gated.
--   test/financeSql.test.mjs asserts that no `for all|insert|update|delete`
--   policy exists on any finance_ table.
do $pol$
declare
  t text;
begin
  foreach t in array array[
    'finance_settings','finance_accounts','finance_journal_entries','finance_journal_lines',
    'finance_payment_events','finance_period_locks','finance_audit_events',
    'finance_bank_imports','finance_bank_transactions','finance_reconciliations',
    'finance_reconciliation_items','finance_recurring_templates'
  ] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    -- (select …) so the permission check InitPlans once per statement (#29).
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using ((select public.has_staff_permission(''finance.manage'')))', t || '_read', t);
  end loop;
end
$pol$;


-- == 15) Trigger functions ====================================================
-- Created AFTER every table: plpgsql resolves column references at EXECUTION
-- time, so one of these naming finance_settings would be created successfully
-- before that table existed and fail only at the first approval.

create or replace function public.finance_resolve_period(p_on date)
returns text language sql immutable set search_path = public, pg_temp as $fn$
  select lpad(extract(year from p_on)::int::text, 4, '0') || '-'
      || lpad(extract(month from p_on)::int::text, 2, '0');
$fn$;
revoke all on function public.finance_resolve_period(date) from public, anon, authenticated;

-- Balance, as a DEFERRED constraint trigger.
create or replace function public.finance_assert_entry_balanced()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_entry uuid := coalesce(new.entry_id, old.entry_id);
  v_debit numeric(14,2);
  v_credit numeric(14,2);
  v_lines int;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*)
    into v_debit, v_credit, v_lines
    from public.finance_journal_lines where entry_id = v_entry;

  -- The entry may legitimately be gone (a rolled-back post cleaning up).
  if not exists (select 1 from public.finance_journal_entries where id = v_entry) then
    return null;
  end if;

  if v_lines < 2 or v_debit <> v_credit or v_debit <= 0 then
    perform public.app_error('FINANCE_ENTRY_UNBALANCED',
      'A journal entry must have at least two lines and equal debits and credits.', 409,
      jsonb_build_object('entry_id', v_entry, 'debit', v_debit, 'credit', v_credit, 'lines', v_lines));
  end if;
  return null;
end;
$fn$;
revoke all on function public.finance_assert_entry_balanced() from public, anon, authenticated;

-- An entry with ZERO lines never fires the line trigger, so it needs its own.
create or replace function public.finance_assert_entry_has_lines()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if not exists (select 1 from public.finance_journal_lines where entry_id = new.id) then
    perform public.app_error('FINANCE_ENTRY_UNBALANCED',
      'A journal entry must have at least two lines.', 409,
      jsonb_build_object('entry_id', new.id, 'lines', 0));
  end if;
  return null;
end;
$fn$;
revoke all on function public.finance_assert_entry_has_lines() from public, anon, authenticated;

-- Immutability + period lock + the no-future-date rule, in ONE before trigger.
-- Folding them together also fixes the firing order: BEFORE triggers fire in
-- NAME order, and three separately-named guards would have an order nobody chose.
create or replace function public.finance_entry_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_period text;
  v_tz text;
  v_today date;
begin
  select coalesce(reporting_timezone, 'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz, 'Asia/Manila'))::date;

  if tg_op = 'DELETE' then
    perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
      'A posted journal entry cannot be deleted. Reverse it instead.', 409,
      jsonb_build_object('entry_id', old.id));
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.entry_date is distinct from old.entry_date
       or new.entry_kind is distinct from old.entry_kind
       or new.reverses_entry_id is distinct from old.reverses_entry_id
       or new.source is distinct from old.source
       or new.idempotency_key is distinct from old.idempotency_key
       or new.created_at is distinct from old.created_at
       -- ★ A referential ON DELETE SET NULL is executed as a REAL UPDATE on this
       --   table and FIRES THIS TRIGGER. Refusing it would make deleting any Auth
       --   account impossible — which is the exact opposite of why SET NULL was
       --   chosen (see the note on finance_payment_events). Permit the nulling, and
       --   nothing else: a non-null value may never change.
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
        'A posted journal entry cannot be edited. Reverse it and post a correction.', 409,
        jsonb_build_object('entry_id', old.id));
    end if;
    return new;   -- only `memo`, and a referential nulling of created_by
  end if;

  -- INSERT
  if new.entry_date > v_today + 1 then
    perform public.app_error('FINANCE_ENTRY_FUTURE_DATED',
      'An entry cannot be dated in the future. A recurring cost is a template, not a posting.', 422,
      jsonb_build_object('entry_date', new.entry_date, 'today', v_today));
  end if;

  v_period := public.finance_resolve_period(new.entry_date);
  if exists (select 1 from public.finance_period_locks where period_key = v_period and locked) then
    perform public.app_error('FINANCE_PERIOD_LOCKED',
      'That accounting period is closed. Post the correction in an open period instead.', 409,
      jsonb_build_object('period', v_period));
  end if;
  return new;
end;
$fn$;
revoke all on function public.finance_entry_guard() from public, anon, authenticated;

create or replace function public.finance_line_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op in ('UPDATE','DELETE') then
    perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
      'Journal lines are append-only. Reverse the entry instead.', 409,
      jsonb_build_object('line_id', coalesce(old.id, new.id)));
  end if;
  return new;
end;
$fn$;
revoke all on function public.finance_line_guard() from public, anon, authenticated;

create or replace function public.finance_payment_event_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_debit numeric(14,2);
begin
  if tg_op = 'DELETE' then
    perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
      'Payment events are append-only.', 409, jsonb_build_object('event_id', old.id));
  end if;

  -- ★ APPEND-ONLY, WITH ONE EXEMPTION THAT IS NOT A LOOPHOLE. Four columns here are
  --   `on delete set null` into auth.users / enrollment_requests / legacy rows, and a
  --   referential SET NULL runs as a REAL UPDATE that fires this trigger. Raising on
  --   it made deleting ANY Auth account impossible: auth.users -> profiles ->
  --   enrollment_requests -> SET NULL here -> raise -> the whole deletion aborts.
  --   That defeats the stated reason those FKs are SET NULL with snapshots rather
  --   than RESTRICT — deleting an account must never destroy the financial record,
  --   and must never be blocked by it either. Every other column stays frozen, and a
  --   reference may only ever go non-null -> NULL, never change to another value.
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.event_kind is distinct from old.event_kind
       or new.direction is distinct from old.direction
       or new.occurred_on is distinct from old.occurred_on
       or new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.journal_entry_id is distinct from old.journal_entry_id
       or new.idempotency_key is distinct from old.idempotency_key
       or new.student_email is distinct from old.student_email
       or new.plan_key is distinct from old.plan_key
       or new.plan_name is distinct from old.plan_name
       or new.method is distinct from old.method
       or new.reference is distinct from old.reference
       or new.memo is distinct from old.memo
       or new.source is distinct from old.source
       or new.created_at is distinct from old.created_at
       or new.created_by_email is distinct from old.created_by_email
       or (new.enrollment_request_id is distinct from old.enrollment_request_id and new.enrollment_request_id is not null)
       or (new.student_user_id is distinct from old.student_user_id and new.student_user_id is not null)
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      perform public.app_error('FINANCE_ENTRY_IMMUTABLE',
        'Payment events are append-only.', 409, jsonb_build_object('event_id', old.id));
    end if;
    return new;
  end if;
  select coalesce(sum(debit),0) into v_debit
    from public.finance_journal_lines where entry_id = new.journal_entry_id;
  if v_debit <> new.amount then
    perform public.app_error('FINANCE_EVENT_AMOUNT_MISMATCH',
      'The payment event amount does not equal its journal entry.', 409,
      jsonb_build_object('event_amount', new.amount, 'entry_debit', v_debit));
  end if;
  return new;
end;
$fn$;
revoke all on function public.finance_payment_event_guard() from public, anon, authenticated;

create or replace function public.finance_audit_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  -- ★ Same exemption as finance_payment_event_guard, and for the same reason:
  --   actor_user_id is `on delete set null` into auth.users, and a referential SET
  --   NULL is a real UPDATE that fires this trigger. An unconditional raise here
  --   made deleting any Auth account that had ever touched finance impossible.
  --   The actor's EMAIL is a snapshot and stays frozen, so the trail still says who
  --   did it after the account is gone — which is the whole point of snapshotting it.
  if tg_op = 'UPDATE'
     and new.actor_user_id is null and old.actor_user_id is not null
     and (new.id, new.actor_email, new.action, new.target_kind, new.target_id,
          new.amount, new.detail, new.reason, new.created_at)
       is not distinct from
         (old.id, old.actor_email, old.action, old.target_kind, old.target_id,
          old.amount, old.detail, old.reason, old.created_at) then
    return new;
  end if;

  perform public.app_error('FINANCE_AUDIT_IMMUTABLE',
    'The finance audit trail is append-only.', 409, null);
  return null;
end;
$fn$;
revoke all on function public.finance_audit_guard() from public, anon, authenticated;

create or replace function public.finance_bank_txn_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.account_id is distinct from old.account_id
       or new.posted_on is distinct from old.posted_on
       or new.amount is distinct from old.amount
       or new.description_raw is distinct from old.description_raw
       or new.import_id is distinct from old.import_id then
      perform public.app_error('FINANCE_BANK_TXN_IMMUTABLE',
        'The parsed facts of a bank transaction cannot be edited. Exclude it with a reason instead.', 409,
        jsonb_build_object('txn_id', old.id));
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function public.finance_bank_txn_guard() from public, anon, authenticated;

create or replace function public.finance_reconciliation_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'UPDATE' and old.status = 'closed' then
    if new.account_id is distinct from old.account_id
       or new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end
       or new.statement_opening is distinct from old.statement_opening
       or new.statement_closing is distinct from old.statement_closing then
      perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
        'A closed reconciliation is frozen. Reopen it with a reason first.', 409,
        jsonb_build_object('reconciliation_id', old.id));
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function public.finance_reconciliation_guard() from public, anon, authenticated;

create or replace function public.finance_reconciliation_item_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_recon uuid := coalesce(new.reconciliation_id, old.reconciliation_id);
begin
  if exists (select 1 from public.finance_reconciliations where id = v_recon and status = 'closed') then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
      'That reconciliation is closed. Reopen it with a reason before changing its items.', 409,
      jsonb_build_object('reconciliation_id', v_recon));
  end if;
  return coalesce(new, old);
end;
$fn$;
revoke all on function public.finance_reconciliation_item_guard() from public, anon, authenticated;


-- == 16) Triggers =============================================================
drop trigger if exists finance_entry_balanced_trg on public.finance_journal_lines;
create constraint trigger finance_entry_balanced_trg
  after insert or update or delete on public.finance_journal_lines
  deferrable initially deferred
  for each row execute function public.finance_assert_entry_balanced();

drop trigger if exists finance_entry_has_lines_trg on public.finance_journal_entries;
create constraint trigger finance_entry_has_lines_trg
  after insert on public.finance_journal_entries
  deferrable initially deferred
  for each row execute function public.finance_assert_entry_has_lines();

drop trigger if exists finance_entry_guard_trg on public.finance_journal_entries;
create trigger finance_entry_guard_trg
  before insert or update or delete on public.finance_journal_entries
  for each row execute function public.finance_entry_guard();

drop trigger if exists finance_line_guard_trg on public.finance_journal_lines;
create trigger finance_line_guard_trg
  before update or delete on public.finance_journal_lines
  for each row execute function public.finance_line_guard();

drop trigger if exists finance_payment_event_guard_trg on public.finance_payment_events;
create trigger finance_payment_event_guard_trg
  before insert or update or delete on public.finance_payment_events
  for each row execute function public.finance_payment_event_guard();

drop trigger if exists finance_audit_guard_trg on public.finance_audit_events;
create trigger finance_audit_guard_trg
  before update or delete on public.finance_audit_events
  for each row execute function public.finance_audit_guard();

drop trigger if exists finance_bank_txn_guard_trg on public.finance_bank_transactions;
create trigger finance_bank_txn_guard_trg
  before update on public.finance_bank_transactions
  for each row execute function public.finance_bank_txn_guard();

drop trigger if exists finance_reconciliation_guard_trg on public.finance_reconciliations;
create trigger finance_reconciliation_guard_trg
  before update on public.finance_reconciliations
  for each row execute function public.finance_reconciliation_guard();

drop trigger if exists finance_recon_item_guard_trg on public.finance_reconciliation_items;
create trigger finance_recon_item_guard_trg
  before insert or update or delete on public.finance_reconciliation_items
  for each row execute function public.finance_reconciliation_item_guard();


-- == 17) The approval hook — created LAST of all the triggers =================
create or replace function public.finance_enrollment_collection_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_cfg     public.finance_settings%rowtype;
  v_income  uuid;
  v_cash    uuid;
  v_entry   uuid;
  v_event   uuid;
  v_key     text;
  v_date    date;
  v_email   text;
  v_actor   uuid := auth.uid();
  v_mapped  uuid;
begin
  -- ★ A COMPED APPROVAL IS NOT REVENUE. A zero entry would also violate
  --   sum(debit) > 0. The enrollment still appears in the receivables worklist
  --   as contract value with zero collection, which is the truthful picture.
  if coalesce(new.amount_paid, 0) <= 0 then
    return null;
  end if;

  select * into v_cfg from public.finance_settings where id;
  v_cash := v_cfg.default_cash_account_id;

  -- The plan's own income account (§4b) when one is mapped AND usable, else the default.
  -- ★ AN UNUSABLE MAPPING FALLS BACK; IT DOES NOT REFUSE. Refusing here would stop
  --   every Operations Admin approving that plan. finance_save_account refuses to
  --   deactivate a mapped account, so this arm is reachable only by hand-edited SQL,
  --   and the audit row below records which account was actually used.
  select a.id into v_mapped
    from public.enrollment_plans p
    join public.finance_accounts a on a.id = p.finance_income_account_id
                                  and a.active and a.account_type = 'income'
   where p.key = new.plan_key;
  v_income := coalesce(v_mapped, v_cfg.default_income_account_id);

  if v_income is null or v_cash is null
     or not exists (select 1 from public.finance_accounts where id = v_income and active)
     or not exists (select 1 from public.finance_accounts where id = v_cash and active) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'Finance is not configured: the default income or cash account is missing or inactive. '
      'Set them in Financial Management before approving payments.', 409, null);
  end if;

  -- ★ NO amount, timestamp, actor or plan in the key. An amount would let a
  --   retry after an edit mint a second revenue row; a timestamp would make
  --   every retry unique; an actor would let two admins each mint one; a plan
  --   would break on an upgrade.
  v_key  := 'enrollment:' || new.id::text || ':collection';
  v_date := (coalesce(new.reviewed_at, now()) at time zone coalesce(v_cfg.reporting_timezone,'Asia/Manila'))::date;

  -- ★ CHECK BEFORE CREATING ANYTHING. The obvious shape — insert the entry, then
  --   ON CONFLICT DO NOTHING on the event, then delete the orphan entry — CANNOT
  --   WORK HERE: finance_line_guard is a BEFORE DELETE trigger that always raises
  --   FINANCE_ENTRY_IMMUTABLE, so the "safe cleanup" would abort a legitimate
  --   approval. The unique index on idempotency_key remains the backstop for a
  --   genuine race; in practice admin_finalize_enrollment holds a row lock on
  --   this request, so a second concurrent approval sees status='approved' and
  --   refuses before ever reaching this trigger.
  if exists (select 1 from public.finance_payment_events where idempotency_key = v_key) then
    return null;
  end if;

  select email into v_email from public.profiles where id = v_actor;

  insert into public.finance_journal_entries
    (entry_date, entry_kind, memo, source, created_by, created_by_email)
  values (v_date, 'collection',
          coalesce(new.plan_name, new.plan_key) || ' — ' || coalesce(new.email, new.full_name, 'student'),
          'approval', v_actor, v_email)
  returning id into v_entry;

  insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit) values
    (v_entry, 1, v_cash,   new.amount_paid, 0),
    (v_entry, 2, v_income, 0,               new.amount_paid);

  insert into public.finance_payment_events
    (event_kind, direction, occurred_on, amount, journal_entry_id, idempotency_key,
     enrollment_request_id, student_user_id, student_email, plan_key, plan_name,
     method, reference, source, created_by, created_by_email)
  values ('enrollment_collection', 'in', v_date, new.amount_paid, v_entry, v_key,
          new.id, new.user_id, new.email, new.plan_key, new.plan_name,
          'unknown', new.payment_reference, 'approval', v_actor, v_email)
  on conflict (idempotency_key) do nothing
  returning id into v_event;

  if v_event is null then
    -- Only reachable if another transaction inserted the same key between the
    -- check above and here. Raising aborts the whole approval, which is the
    -- honest outcome: the collection is already recorded, so this approval must
    -- not also claim it. It cannot be "cleaned up" — see the note above.
    perform public.app_error('FINANCE_COLLECTION_RACE',
      'This collection was recorded by another request a moment ago. Refresh and check the '
      'enrollment before approving again — no duplicate was created.', 409,
      jsonb_build_object('request_id', new.id));
  end if;

  -- ★ NO EXCEPTION HANDLER ANYWHERE IN THIS BODY. If the audit write fails, the
  --   approval fails. The legacy logger wrapped every audit write in an empty
  --   catch, so the trail silently stopped being complete.
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'entry_post', 'journal_entry', v_entry, new.amount_paid,
          jsonb_build_object('source','approval','request_id',new.id,'plan_key',new.plan_key,
                             'income_account_id', v_income, 'plan_mapped', v_mapped is not null));

  return null;
end;
$fn$;
-- Reachable ONLY as a trigger: no grant, so it has no argument surface and
-- cannot be pointed at another request, amount or account.
revoke all on function public.finance_enrollment_collection_trg() from public, anon, authenticated;

drop trigger if exists finance_enrollment_collection_trg on public.enrollment_requests;
create trigger finance_enrollment_collection_trg
  after update on public.enrollment_requests
  for each row
  -- Without this WHEN clause the trigger fires on every admin_notes edit.
  when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.finance_enrollment_collection_trg();


-- == 18) Reporting RPCs =======================================================

-- ★ ONE DEFINITION OF "COLLECTED". Three reports read it — the dashboard's
--   outstanding, sales by plan, and the receivables worklist — and a private copy in
--   each is how they came to disagree. Two rules live here and nowhere else:
--   * A REVERSED collection is not collected. A reversal nets out of the ledger, so
--     the event must net out of the receivables too, or the P&L and the worklist
--     disagree for as long as the entry exists.
--   * The event's DIRECTION is the sign. `amount` is a magnitude, so summing it bare
--     counts a refund as a second payment and SHRINKS what the student owes.
-- Internal: invoker rights, revoked from every client role, reached only from the
-- SECURITY DEFINER reports below (where the effective user is the owner).
create or replace function public.finance_request_collected(p_request_id uuid)
returns numeric language sql stable set search_path = public, pg_temp as $fn$
  select coalesce(sum(case pe.direction when 'in'  then pe.amount
                                        when 'out' then -pe.amount
                                        else 0 end), 0)::numeric(14,2)
    from public.finance_payment_events pe
   where pe.enrollment_request_id = p_request_id
     and not exists (select 1 from public.finance_journal_entries rv
                      where rv.reverses_entry_id = pe.journal_entry_id);
$fn$;
revoke all on function public.finance_request_collected(uuid) from public, anon, authenticated;

-- All `stable security definer`, `search_path = public, pg_temp` (pg_temp LAST),
-- permission-checked in the FIRST statement. A SECURITY DEFINER function in
-- `public` is callable by `authenticated` by default, so the in-body check — not
-- the grant — is the boundary.

create or replace function public.finance_dashboard_summary(
  p_from date default null,
  p_to   date default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_tz text;
  v_today date;
  v_from date;
  v_to date;
  v_prev_from date;
  v_prev_to date;
  v_len int;
  r jsonb;
  v_coll numeric(14,2);
  v_exp numeric(14,2);
  v_draw numeric(14,2);
  v_prev_coll numeric(14,2);
  v_prev_exp numeric(14,2);
  v_contract numeric(14,2);
  v_outstanding numeric(14,2);
  v_pending int;
  v_avg numeric(14,2);
  v_denom int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;

  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;
  v_from := coalesce(p_from, date_trunc('month', v_today)::date);
  v_to   := coalesce(p_to, v_today);
  v_len  := greatest(1, (v_to - v_from) + 1);
  v_prev_to   := v_from - 1;
  v_prev_from := v_prev_to - (v_len - 1);

  -- Income accounts only. Reversals and refunds net out naturally (both debit
  -- income), so there is no "where not reversed" filter anywhere in this file.
  select coalesce(sum(l.credit) - sum(l.debit), 0) into v_coll
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
    join public.finance_accounts a on a.id = l.account_id
   where a.account_type = 'income' and e.entry_date between v_from and v_to;

  select coalesce(sum(l.debit) - sum(l.credit), 0) into v_exp
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
    join public.finance_accounts a on a.id = l.account_id
   where a.account_type = 'expense' and e.entry_date between v_from and v_to;

  select coalesce(sum(l.debit) - sum(l.credit), 0) into v_draw
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
    join public.finance_accounts a on a.id = l.account_id
   where a.subtype = 'owner_draw' and e.entry_date between v_from and v_to;

  select coalesce(sum(l.credit) - sum(l.debit), 0) into v_prev_coll
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
    join public.finance_accounts a on a.id = l.account_id
   where a.account_type = 'income' and e.entry_date between v_prev_from and v_prev_to;

  select coalesce(sum(l.debit) - sum(l.credit), 0) into v_prev_exp
    from public.finance_journal_lines l
    join public.finance_journal_entries e on e.id = l.entry_id
    join public.finance_accounts a on a.id = l.account_id
   where a.account_type = 'expense' and e.entry_date between v_prev_from and v_prev_to;

  -- Contract value, windowed by APPROVAL date, from the request's own snapshot.
  -- Never enrollment_plans.price_php: today's price is today's.
  -- ★ ONE APPROVAL DATE, EVERYWHERE: coalesce(reviewed_at, created_at) in the
  --   business timezone — here, in finance_sales_by_plan and in
  --   finance_receivables_worklist, and the same instant the hook dates the
  --   collection by. reviewed_at is nullable; testing it bare here while the
  --   worklist coalesced it let one approved row count in one report and vanish
  --   from the other, and a UTC ::date put a late-evening Manila approval in the
  --   wrong day (and, on the last day of a month, the wrong month).
  select coalesce(sum(r.amount_expected), 0) into v_contract
    from public.enrollment_requests r
   where r.status = 'approved'
     and (coalesce(r.reviewed_at, r.created_at) at time zone coalesce(v_tz,'Asia/Manila'))::date
         between v_from and v_to;

  -- Operational outstanding. `status='approved'` is in the WHERE, so a rejected
  -- or unconverted lead contributes zero ROWS, not zero pesos.
  select coalesce(sum(greatest(r.amount_expected - public.finance_request_collected(r.id), 0)), 0)
    into v_outstanding
    from public.enrollment_requests r
   where r.status = 'approved';

  select count(*) into v_pending
    from public.enrollment_requests where status = 'pending_review';

  -- ★ ONE POPULATION. Numerator: collections in the window. Denominator:
  --   enrollments WITH a collection event in that same window. The legacy `avg`
  --   divided unfiltered collections by a status-filtered enrollment count.
  --   A reversed collection is no longer a collection, so it leaves the
  --   denominator exactly as its reversal left the numerator.
  select count(distinct pe.enrollment_request_id)
    into v_denom
    from public.finance_payment_events pe
   where pe.event_kind = 'enrollment_collection'
     and pe.direction = 'in'
     and pe.occurred_on between v_from and v_to
     and not exists (select 1 from public.finance_journal_entries rv
                      where rv.reverses_entry_id = pe.journal_entry_id);
  v_avg := case when coalesce(v_denom,0) = 0 then null else round(v_coll / v_denom, 2) end;

  r := jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', v_tz, 'basis', 'cash'),
    'previous_range', jsonb_build_object('from', v_prev_from, 'to', v_prev_to),
    'verified_collections', v_coll,
    'approved_contract_value', v_contract,
    'operational_outstanding', v_outstanding,
    'operating_expenses', v_exp,
    'owner_draws', v_draw,
    'cash_basis_net', v_coll - v_exp,
    'pending_payment_proof_count', v_pending,
    'avg_collection_per_enrollment', v_avg,
    -- ★ NULL, NEVER 0, when the prior window holds nothing. A fabricated 0.00
    --   reports "flat" where the truth is "not yet measured" — a bug this
    --   codebase has already shipped once (#52/#53).
    'collections_prior', case when v_prev_coll = 0 and not exists (
        select 1 from public.finance_journal_entries where entry_date between v_prev_from and v_prev_to
      ) then null else v_prev_coll end,
    'expenses_prior', case when v_prev_exp = 0 and not exists (
        select 1 from public.finance_journal_entries where entry_date between v_prev_from and v_prev_to
      ) then null else v_prev_exp end,
    'basis', 'cash'
  );

  r := r || jsonb_build_object('cash_position', coalesce((
    select jsonb_agg(jsonb_build_object(
             'account_id', a.id, 'code', a.code, 'name', a.name,
             'cash_flow_class', a.cash_flow_class,
             -- ★ A CARD BALANCE IS OWED, NOT HELD. Its normal balance is credit, so
             --   the lateral below returns it POSITIVE, and summing this array as
             --   "cash" would add the debt to the money. Negated, the array sums to
             --   net cash and the card reads as the liability it is.
             'balance', case when a.cash_flow_class = 'card' then -coalesce(b.bal, 0)
                             else coalesce(b.bal, 0) end)
             order by a.sort_order)
      from public.finance_accounts a
      left join lateral (
        select case when a.normal_balance = 'debit'
                    then sum(l.debit) - sum(l.credit)
                    else sum(l.credit) - sum(l.debit) end as bal
          from public.finance_journal_lines l
          join public.finance_journal_entries e on e.id = l.entry_id
         where l.account_id = a.id and e.entry_date <= v_to
      ) b on true
     where a.cash_flow_class <> 'none' and a.active
  ), '[]'::jsonb));

  r := r || jsonb_build_object('monthly_trend', coalesce((
    select jsonb_agg(t order by t->>'period')
      from (
        select jsonb_build_object(
                 'period', e.period_key,
                 'collections', coalesce(sum(case when a.account_type = 'income' then l.credit - l.debit else 0 end), 0),
                 'expenses',    coalesce(sum(case when a.account_type = 'expense' then l.debit - l.credit else 0 end), 0),
                 'net',         coalesce(sum(case when a.account_type = 'income' then l.credit - l.debit
                                                  when a.account_type = 'expense' then l.credit - l.debit
                                                  else 0 end), 0)
               ) as t
          from public.finance_journal_entries e
          join public.finance_journal_lines l on l.entry_id = e.id
          join public.finance_accounts a on a.id = l.account_id
         where e.entry_date >= (date_trunc('month', v_to) - interval '11 months')::date
           and e.entry_date <= v_to
         group by e.period_key
      ) q
  ), '[]'::jsonb));

  return r;
end;
$fn$;
revoke all on function public.finance_dashboard_summary(date, date) from public, anon, authenticated;
grant execute on function public.finance_dashboard_summary(date, date) to authenticated;

comment on function public.finance_dashboard_summary(date, date) is
  'Cash basis. A MANAGEMENT report, not a statutory financial statement. '
  'approved_contract_value is NOT revenue and is never added to verified_collections.';


create or replace function public.finance_sales_by_plan(
  p_from date default null,
  p_to   date default null
) returns table (
  plan_key text, plan_name text, enrollment_count integer,
  contract_value numeric, collected numeric, outstanding numeric,
  collection_rate numeric, is_total_row boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_tz text; v_today date; v_from date; v_to date;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;
  v_from := coalesce(p_from, date_trunc('year', v_today)::date);
  v_to   := coalesce(p_to, v_today);

  return query
  with rows_all as (
    -- ★ plan_name is the SNAPSHOT on the row, never a join to enrollment_plans.
    --   #39 deleted the Core, Gold and Essentials rows, so a join would silently
    --   drop 116 rows of real history.
    select r.plan_key, r.plan_name, r.amount_expected as contract,
           public.finance_request_collected(r.id) as collected
      from public.enrollment_requests r
     where r.status = 'approved'
       and (coalesce(r.reviewed_at, r.created_at) at time zone coalesce(v_tz,'Asia/Manila'))::date
           between v_from and v_to
  ), grouped as (
    select ra.plan_key, ra.plan_name,
           count(*)::integer as n,
           sum(ra.contract)::numeric(14,2) as contract_value,
           sum(ra.collected)::numeric(14,2) as collected
      from rows_all ra group by ra.plan_key, ra.plan_name
  )
  select g.plan_key, g.plan_name, g.n, g.contract_value, g.collected,
         greatest(g.contract_value - g.collected, 0)::numeric(14,2),
         case when g.contract_value = 0 then null
              else round(100 * g.collected / g.contract_value, 2) end,
         false
    from grouped g
  union all
  select null, 'TOTAL', coalesce(sum(g.n),0)::integer,
         coalesce(sum(g.contract_value),0)::numeric(14,2),
         coalesce(sum(g.collected),0)::numeric(14,2),
         greatest(coalesce(sum(g.contract_value),0) - coalesce(sum(g.collected),0), 0)::numeric(14,2),
         case when coalesce(sum(g.contract_value),0) = 0 then null
              else round(100 * sum(g.collected) / sum(g.contract_value), 2) end,
         true
    from grouped g
  -- ★ ORDINAL POSITIONS, not output names. Across a UNION ALL the branches are
  --   unaliased, so Postgres cannot resolve `is_total_row` / `contract_value`
  --   here and the function fails at run time with "column does not exist".
  order by 8, 4 desc nulls last, 2;
end;
$fn$;
revoke all on function public.finance_sales_by_plan(date, date) from public, anon, authenticated;
grant execute on function public.finance_sales_by_plan(date, date) to authenticated;


-- ★ DROP FIRST. `create or replace` cannot change an argument list, so without this
--   the retired 5-argument overload (numeric, boolean, text, integer, integer) from an
--   earlier draft would survive beside this one on any database that ever ran that
--   draft — still granted to authenticated, and still selecting from a dropped table.
--   A no-op everywhere else. scripts/audit-db.mjs asserts exactly one overload.
drop function if exists public.finance_receivables_worklist(numeric, boolean, text, integer, integer);
create or replace function public.finance_receivables_worklist(
  p_min_outstanding numeric default 0.01,
  p_bucket          text default null,
  p_limit           integer default 50,
  p_offset          integer default 0
) returns table (
  source text, enrollment_id uuid, student_user_id uuid, student_email text,
  full_name text, plan_key text, plan_name text, approved_on date,
  contract_amount numeric, collected numeric, outstanding numeric,
  last_payment_on date, days_since_approval integer, days_since_last_payment integer,
  aging_bucket text, total_count bigint, total_outstanding numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_tz text; v_today date; v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_bucket is not null and p_bucket not in ('current','1-30','31-60','61-90','90+') then
    raise exception 'finance_receivables_worklist: unknown bucket %', p_bucket using errcode = '22023';
  end if;

  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today  := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;
  v_limit  := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));

  return query
  with base as (
    -- coalesce: reviewed_at is nullable, and a NULL approval date makes every
    -- aging comparison below NULL, which silently buckets the row as '90+'.
    select 'toolkit'::text as src, r.id as eid, r.user_id, r.email, r.full_name,
           r.plan_key, r.plan_name,
           (coalesce(r.reviewed_at, r.created_at) at time zone coalesce(v_tz,'Asia/Manila'))::date as approved,
           r.amount_expected as contract,
           public.finance_request_collected(r.id) as collected,
           -- The last money IN that still stands. A reversed or outgoing event is not
           -- a payment, and must not reset the aging clock.
           (select max(pe.occurred_on) from public.finance_payment_events pe
             where pe.enrollment_request_id = r.id and pe.direction = 'in'
               and not exists (select 1 from public.finance_journal_entries rv
                                where rv.reverses_entry_id = pe.journal_entry_id)) as last_pay
      from public.enrollment_requests r
     where r.status = 'approved'
  ), calc as (
    -- ★ BOTH ages are returned, not one silently chosen. Standard A/R ages from
    --   the invoice; a payment-plan business needs age from the last payment.
    select b.*, greatest(b.contract - b.collected, 0) as outstanding,
           (v_today - b.approved) as d_appr,
           (v_today - coalesce(b.last_pay, b.approved)) as d_pay
      from base b
  ), bucketed as (
    select c.*,
           case when c.d_pay <= 0 then 'current'
                when c.d_pay <= 30 then '1-30'
                when c.d_pay <= 60 then '31-60'
                when c.d_pay <= 90 then '61-90'
                else '90+' end as bucket
      from calc c
     where c.outstanding >= coalesce(p_min_outstanding, 0.01)
  ), filtered as (
    select * from bucketed where p_bucket is null or bucket = p_bucket
  )
  select f.src, f.eid, f.user_id, f.email, f.full_name, f.plan_key, f.plan_name,
         f.approved, f.contract::numeric(14,2), f.collected::numeric(14,2),
         f.outstanding::numeric(14,2), f.last_pay, f.d_appr::integer, f.d_pay::integer,
         f.bucket,
         count(*) over ()::bigint,
         sum(f.outstanding) over ()::numeric(14,2)
    from filtered f
   order by f.outstanding desc, f.approved
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_receivables_worklist(numeric, text, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_receivables_worklist(numeric, text, integer, integer) to authenticated;


create or replace function public.finance_ledger_list(
  p_from date, p_to date,
  p_account_id uuid default null,
  p_entry_kind text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
) returns table (
  entry_id uuid, entry_no bigint, entry_date date, entry_kind text, memo text,
  source text, is_reversal boolean, reversed_by_entry_id uuid,
  total_amount numeric, lines jsonb, created_at timestamptz,
  created_by_email text, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_entry_kind is not null and p_entry_kind not in (
      'collection','expense','owner_draw','owner_contribution','transfer',
      'refund','opening_balance','adjustment','reversal') then
    raise exception 'finance_ledger_list: unknown entry kind %', p_entry_kind using errcode = '22023';
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 100), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));

  return query
  with matched as (
    select e.*
      from public.finance_journal_entries e
     where e.entry_date between p_from and p_to
       and (p_entry_kind is null or e.entry_kind = p_entry_kind)
       -- ★ ESCAPED. `%` and `_` are wildcards to ILIKE, so unescaped a search for
       --   "50%" matched every memo containing "50" and "_" matched every memo at
       --   all. `!` is the escape character rather than a backslash, which keeps a
       --   backslash out of this file's string literals entirely.
       and (p_search is null or length(btrim(p_search)) < 2
            or e.memo ilike '%' || replace(replace(replace(btrim(p_search), '!', '!!'), '%', '!%'), '_', '!_') || '%' escape '!')
       and (p_account_id is null or exists (
             select 1 from public.finance_journal_lines l
              where l.entry_id = e.id and l.account_id = p_account_id))
  )
  -- ★ ONE ROW PER ENTRY, lines as jsonb. The UI therefore cannot render half an
  --   entry and call it a transaction — which is exactly what the legacy
  --   single-entry rows were. No user identity columns are returned.
  select m.id, m.entry_no, m.entry_date, m.entry_kind, m.memo, m.source,
         (m.entry_kind = 'reversal'),
         (select rv.id from public.finance_journal_entries rv where rv.reverses_entry_id = m.id),
         coalesce((select sum(l.debit) from public.finance_journal_lines l where l.entry_id = m.id), 0)::numeric(14,2),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'line_no', l.line_no, 'account_id', l.account_id,
                     'account_code', a.code, 'account_name', a.name,
                     'account_type', a.account_type,
                     'debit', l.debit, 'credit', l.credit, 'memo', l.memo)
                     order by l.line_no)
                    from public.finance_journal_lines l
                    join public.finance_accounts a on a.id = l.account_id
                   where l.entry_id = m.id), '[]'::jsonb),
         m.created_at, m.created_by_email,
         count(*) over ()::bigint
    from matched m
   order by m.entry_date desc, m.entry_no desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_ledger_list(date, date, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_ledger_list(date, date, uuid, text, text, integer, integer) to authenticated;


create or replace function public.finance_cash_basis_pl(
  p_from date, p_to date, p_group text default 'month'
) returns table (
  period_key text, section text, account_id uuid, account_code text,
  account_name text, amount numeric, section_total numeric, period_total numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_group not in ('month','total') then
    raise exception 'finance_cash_basis_pl: unknown grouping %', p_group using errcode = '22023';
  end if;

  return query
  with lines as (
    -- ★ Owner draws, owner contributions and transfers CANNOT appear: no equity,
    --   asset or liability account maps to a section. That is construction, not
    --   an exclusion list a newly created account could slip past.
    select case when p_group = 'total' then 'TOTAL' else e.period_key end as pk,
           case a.subtype
             when 'cost_of_sales' then 'cost_of_sales'
             when 'other_income'  then 'other_income'
             when 'other_expense' then 'other_expense'
             else case a.account_type when 'income' then 'income'
                                      when 'expense' then 'operating_expense' end
           end as sect,
           a.id as aid, a.code as acode, a.name as aname,
           case when a.account_type = 'income' then l.credit - l.debit
                else l.debit - l.credit end as amt
      from public.finance_journal_lines l
      join public.finance_journal_entries e on e.id = l.entry_id
      join public.finance_accounts a on a.id = l.account_id
     where e.entry_date between p_from and p_to
       and a.account_type in ('income','expense')
  ), agg as (
    select pk, sect, aid, acode, aname, sum(amt)::numeric(14,2) as amt
      from lines group by pk, sect, aid, acode, aname
  )
  select g.pk, g.sect, g.aid, g.acode, g.aname, g.amt,
         sum(g.amt) over (partition by g.pk, g.sect)::numeric(14,2),
         sum(case when g.sect in ('income','other_income') then g.amt else -g.amt end)
           over (partition by g.pk)::numeric(14,2)
    from agg g
   order by g.pk, g.sect, g.acode;
end;
$fn$;
revoke all on function public.finance_cash_basis_pl(date, date, text) from public, anon, authenticated;
grant execute on function public.finance_cash_basis_pl(date, date, text) to authenticated;

comment on function public.finance_cash_basis_pl(date, date, text) is
  'Cash basis. A MANAGEMENT report, not a statutory financial statement. There is no accrual '
  'mode and no A/R account in the chart; an accrual P&L is a different product decision, and '
  'it is a migration.';


create or replace function public.finance_audit_feed(
  p_action text default null,
  p_target_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  id bigint, actor_email text, action text, target_kind text, target_id uuid,
  amount numeric, detail jsonb, reason text, created_at timestamptz, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  return query
  select e.id, e.actor_email, e.action, e.target_kind, e.target_id, e.amount,
         e.detail, e.reason, e.created_at, count(*) over ()::bigint
    from public.finance_audit_events e
   where (p_action is null or e.action = p_action)
     and (p_target_id is null or e.target_id = p_target_id)
   order by e.created_at desc, e.id desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_audit_feed(text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_audit_feed(text, uuid, integer, integer) to authenticated;


-- == 18b) Setup readers ========================================================
-- Eight tables had no reader at all, so no form could be built on them. Same shape as
-- every reader above: STABLE SECURITY DEFINER, permission checked in the first
-- statement, revoked then granted.

-- Everything the Setup screen needs to drive go-live, in one call.
create or replace function public.finance_setup_state()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_cfg public.finance_settings%rowtype; v_tz text; v_today date;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_cfg from public.finance_settings where id;
  v_tz := coalesce(v_cfg.reporting_timezone, 'Asia/Manila');
  v_today := (now() at time zone v_tz)::date;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'reporting_timezone', v_tz, 'currency', v_cfg.currency,
      'fiscal_year_start_month', v_cfg.fiscal_year_start_month,
      'default_income_account_id', v_cfg.default_income_account_id,
      'default_cash_account_id', v_cfg.default_cash_account_id,
      'default_owner_draw_account_id', v_cfg.default_owner_draw_account_id,
      'bank_duplicate_day_window', v_cfg.bank_duplicate_day_window,
      'updated_at', v_cfg.updated_at, 'updated_by_email', v_cfg.updated_by_email),
    'today', v_today,
    'current_period', public.finance_resolve_period(v_today),
    -- ★ The same test the approval hook applies. False means approvals are failing
    --   right now, which is what Setup must say first.
    'approvals_can_post',
      exists (select 1 from public.finance_accounts
               where id = v_cfg.default_income_account_id and active and account_type = 'income')
      and exists (select 1 from public.finance_accounts
               where id = v_cfg.default_cash_account_id and active
                 and account_type = 'asset' and subtype in ('cash','bank')),
    'ledger_empty', not exists (select 1 from public.finance_journal_entries),
    'opening_balance_posted', exists (select 1 from public.finance_journal_entries
                                       where entry_kind = 'opening_balance'),
    -- Mirrors the backfill's own candidate query, key shape included.
    'backfill_candidates', (select count(*) from public.enrollment_requests er
                             where er.status = 'approved' and coalesce(er.amount_paid, 0) > 0
                               and not exists (select 1 from public.finance_payment_events pe
                                                where pe.idempotency_key = 'enrollment:' || er.id::text || ':collection')),
    'recurring_due', (select count(*) from public.finance_recurring_templates
                       where active and next_due_on <= v_today),
    'plans', coalesce((select jsonb_agg(jsonb_build_object(
                         'key', p.key, 'name', p.name, 'active', p.active,
                         'income_account_id', p.finance_income_account_id)
                         order by p.position, p.key)
                         from public.enrollment_plans p), '[]'::jsonb)
  );
end;
$fn$;
revoke all on function public.finance_setup_state() from public, anon, authenticated;
grant execute on function public.finance_setup_state() to authenticated;

create or replace function public.finance_accounts_list(p_include_inactive boolean default false)
returns table (
  id uuid, code text, name text, account_type text, subtype text, normal_balance text,
  reporting_class text, cash_flow_class text, is_system boolean, active boolean,
  parent_account_id uuid, sort_order integer, description text, balance numeric, in_use boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  return query
  select a.id, a.code, a.name, a.account_type, a.subtype, a.normal_balance, a.reporting_class,
         a.cash_flow_class, a.is_system, a.active, a.parent_account_id, a.sort_order, a.description,
         coalesce((select case when a.normal_balance = 'debit' then sum(l.debit) - sum(l.credit)
                               else sum(l.credit) - sum(l.debit) end
                     from public.finance_journal_lines l where l.account_id = a.id), 0)::numeric(14,2),
         -- The same "in use" rule finance_save_account enforces, so the UI can disable
         -- Deactivate instead of offering a button that can only refuse.
         (exists (select 1 from public.finance_settings s
                   where s.id and a.id in (s.default_income_account_id, s.default_cash_account_id,
                                           s.default_owner_draw_account_id))
          or exists (select 1 from public.enrollment_plans p where p.finance_income_account_id = a.id))
    from public.finance_accounts a
   where p_include_inactive or a.active
   order by a.sort_order, a.code;
end;
$fn$;
revoke all on function public.finance_accounts_list(boolean) from public, anon, authenticated;
grant execute on function public.finance_accounts_list(boolean) to authenticated;

create or replace function public.finance_period_locks_list()
returns table (
  period_key text, locked boolean, locked_at timestamptz, locked_by_email text, note text,
  unlocked_at timestamptz, unlocked_by_email text, unlock_reason text
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  return query
  select pl.period_key, pl.locked, pl.locked_at, pl.locked_by_email, pl.note,
         pl.unlocked_at, pl.unlocked_by_email, pl.unlock_reason
    from public.finance_period_locks pl
   order by pl.period_key desc;
end;
$fn$;
revoke all on function public.finance_period_locks_list() from public, anon, authenticated;
grant execute on function public.finance_period_locks_list() to authenticated;

create or replace function public.finance_recurring_list(p_include_inactive boolean default false)
returns table (
  id uuid, name text, account_id uuid, account_code text, account_name text,
  contra_account_id uuid, contra_account_code text, contra_account_name text, amount numeric,
  entry_kind text, memo text, cadence text, day_of_month integer, weekday integer,
  next_due_on date, active boolean, last_proposed_on date, last_posted_entry_id uuid, is_due boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_today date;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  -- ★ QUALIFIED: `id` is also an OUT column of this function, and an unqualified
  --   `where id` is "column reference is ambiguous" at the first call, not at create.
  v_today := (now() at time zone coalesce(
               (select s.reporting_timezone from public.finance_settings s where s.id), 'Asia/Manila'))::date;
  return query
  select t.id, t.name, t.account_id, a.code, a.name, t.contra_account_id, c.code, c.name, t.amount,
         t.entry_kind, t.memo, t.cadence, t.day_of_month, t.weekday, t.next_due_on, t.active,
         t.last_proposed_on, t.last_posted_entry_id,
         -- "Due" is a PROPOSAL shown to a human. Nothing posts because of it.
         (t.active and t.next_due_on <= v_today)
    from public.finance_recurring_templates t
    join public.finance_accounts a on a.id = t.account_id
    join public.finance_accounts c on c.id = t.contra_account_id
   where p_include_inactive or t.active
   order by t.active desc, t.next_due_on, t.name;
end;
$fn$;
revoke all on function public.finance_recurring_list(boolean) from public, anon, authenticated;
grant execute on function public.finance_recurring_list(boolean) to authenticated;

create or replace function public.finance_bank_imports_list(
  p_account_id uuid default null, p_limit integer default 50, p_offset integer default 0
) returns table (
  id uuid, account_id uuid, account_code text, account_name text, file_name text,
  row_count integer, imported_row_count integer, duplicate_row_count integer,
  status text, date_format text, opening_balance numeric, closing_balance numeric,
  created_at timestamptz, created_by_email text, committed_at timestamptz,
  unmatched_count bigint, excluded_count bigint, likely_duplicate_count bigint, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  return query
  select i.id, i.account_id, a.code, a.name, i.file_name, i.row_count, i.imported_row_count,
         i.duplicate_row_count, i.status, i.date_format, i.opening_balance, i.closing_balance,
         i.created_at, i.created_by_email, i.committed_at,
         -- Counted live: excluded_row_count on the import row is never maintained.
         (select count(*) from public.finance_bank_transactions t
           where t.import_id = i.id and t.status = 'unmatched'),
         (select count(*) from public.finance_bank_transactions t
           where t.import_id = i.id and t.status = 'excluded'),
         (select count(*) from public.finance_bank_transactions t
           where t.import_id = i.id and t.status = 'unmatched' and t.duplicate_kind = 'likely'),
         count(*) over ()::bigint
    from public.finance_bank_imports i
    join public.finance_accounts a on a.id = i.account_id
   where p_account_id is null or i.account_id = p_account_id
   order by i.created_at desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_bank_imports_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_bank_imports_list(uuid, integer, integer) to authenticated;

create or replace function public.finance_bank_transactions_list(
  p_import_id uuid default null, p_account_id uuid default null, p_status text default null,
  p_from date default null, p_to date default null,
  p_limit integer default 200, p_offset integer default 0
) returns table (
  id uuid, import_id uuid, account_id uuid, posted_on date, description_raw text, amount numeric,
  balance_after numeric, status text, duplicate_kind text, duplicate_of_id uuid,
  excluded_reason text, matched_entry_id uuid, reconciliation_item_id uuid,
  reconciliation_id uuid, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_status is not null and p_status not in ('unmatched','matched','excluded','duplicate') then
    raise exception 'finance_bank_transactions_list: unknown status %', p_status using errcode = '22023';
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  return query
  select t.id, t.import_id, t.account_id, t.posted_on, t.description_raw, t.amount, t.balance_after,
         t.status, t.duplicate_kind, t.duplicate_of_id, t.excluded_reason, t.matched_entry_id,
         ri.item_id, ri.recon_id,
         count(*) over ()::bigint
    from public.finance_bank_transactions t
    -- LATERAL + LIMIT 1: a transaction can appear in more than one reconciliation over
    -- time, and a plain join would repeat the row once per item.
    left join lateral (
      select x.id as item_id, x.reconciliation_id as recon_id
        from public.finance_reconciliation_items x
       where x.bank_transaction_id = t.id
       order by x.created_at desc
       limit 1
    ) ri on true
   where (p_import_id is null or t.import_id = p_import_id)
     and (p_account_id is null or t.account_id = p_account_id)
     and (p_status is null or t.status = p_status)
     and (p_from is null or t.posted_on >= p_from)
     and (p_to is null or t.posted_on <= p_to)
   order by t.posted_on desc, t.created_at desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_bank_transactions_list(uuid, uuid, text, date, date, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_bank_transactions_list(uuid, uuid, text, date, date, integer, integer) to authenticated;

create or replace function public.finance_reconciliations_list(
  p_account_id uuid default null, p_limit integer default 50, p_offset integer default 0
) returns table (
  id uuid, account_id uuid, account_code text, account_name text, period_start date, period_end date,
  statement_opening numeric, statement_closing numeric, difference numeric, status text,
  closed_at timestamptz, closed_by_email text, reopened_at timestamptz, reopen_reason text,
  created_at timestamptz, matched_count bigint, unmatched_count bigint, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_limit int; v_offset int;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  v_limit  := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));
  return query
  select r.id, r.account_id, a.code, a.name, r.period_start, r.period_end,
         r.statement_opening, r.statement_closing, r.difference, r.status,
         r.closed_at, r.closed_by_email, r.reopened_at, r.reopen_reason, r.created_at,
         (select count(*) from public.finance_reconciliation_items x where x.reconciliation_id = r.id),
         -- The same population finance_close_reconciliation refuses to close over.
         (select count(*) from public.finance_bank_transactions t
           where t.account_id = r.account_id and t.status = 'unmatched'
             and t.posted_on between r.period_start and r.period_end),
         count(*) over ()::bigint
    from public.finance_reconciliations r
    join public.finance_accounts a on a.id = r.account_id
   where p_account_id is null or r.account_id = p_account_id
   order by r.period_end desc, r.created_at desc
   limit v_limit offset v_offset;
end;
$fn$;
revoke all on function public.finance_reconciliations_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.finance_reconciliations_list(uuid, integer, integer) to authenticated;

-- One reconciliation, everything its screen needs: its items, the transactions still
-- open in its period, and the ledger lines no reconciliation has claimed yet.
create or replace function public.finance_reconciliation_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_rec public.finance_reconciliations%rowtype;
  v_acct public.finance_accounts%rowtype;
  v_cleared numeric(14,2);
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_rec from public.finance_reconciliations where id = p_id;
  if not found then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED', 'That reconciliation does not exist.', 404, null);
  end if;
  select * into v_acct from public.finance_accounts where id = v_rec.account_id;

  -- Computed exactly as finance_close_reconciliation computes it, so the number on
  -- screen is the number close will test.
  select coalesce(sum(t.amount), 0) into v_cleared
    from public.finance_bank_transactions t
   where t.account_id = v_rec.account_id and t.status = 'matched'
     and t.posted_on between v_rec.period_start and v_rec.period_end;

  return jsonb_build_object(
    'reconciliation', to_jsonb(v_rec),
    'account', jsonb_build_object('id', v_acct.id, 'code', v_acct.code, 'name', v_acct.name,
                                  'cash_flow_class', v_acct.cash_flow_class),
    'cleared', v_cleared,
    -- NULL, never 0, while a statement balance is missing: close refuses that case too.
    'difference', case when v_rec.statement_opening is null or v_rec.statement_closing is null then null
                       else v_rec.statement_closing - v_rec.statement_opening - v_cleared end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'bank_transaction_id', i.bank_transaction_id,
               'journal_line_id', i.journal_line_id, 'matched_amount', i.matched_amount,
               'posted_on', t.posted_on, 'description', t.description_raw, 'amount', t.amount,
               'entry_no', e.entry_no, 'entry_date', e.entry_date, 'entry_memo', e.memo)
               order by t.posted_on, i.created_at)
        from public.finance_reconciliation_items i
        join public.finance_bank_transactions t on t.id = i.bank_transaction_id
        left join public.finance_journal_lines jl on jl.id = i.journal_line_id
        left join public.finance_journal_entries e on e.id = jl.entry_id
       where i.reconciliation_id = p_id), '[]'::jsonb),
    'open_transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'posted_on', t.posted_on, 'description', t.description_raw,
               'amount', t.amount, 'duplicate_kind', t.duplicate_kind)
               order by t.posted_on, t.created_at)
        from public.finance_bank_transactions t
       where t.account_id = v_rec.account_id and t.status = 'unmatched'
         and t.posted_on between v_rec.period_start and v_rec.period_end), '[]'::jsonb),
    -- Signed the way the statement sees the account: a debit to it is money in.
    -- A week either side, because a bank posts a day or three after the ledger does.
    'candidate_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', c.line_id, 'entry_id', c.entry_id, 'entry_no', c.entry_no,
               'entry_date', c.entry_date, 'memo', c.memo, 'amount', c.amount)
               order by c.entry_date, c.entry_no)
        from (
          select jl.id as line_id, e.id as entry_id, e.entry_no, e.entry_date,
                 coalesce(jl.memo, e.memo) as memo, (jl.debit - jl.credit) as amount
            from public.finance_journal_lines jl
            join public.finance_journal_entries e on e.id = jl.entry_id
           where jl.account_id = v_rec.account_id
             and e.entry_date between v_rec.period_start - 7 and v_rec.period_end + 7
             and not exists (select 1 from public.finance_reconciliation_items x
                              where x.journal_line_id = jl.id)
           order by e.entry_date, e.entry_no
           limit 500
        ) c), '[]'::jsonb)
  );
end;
$fn$;
revoke all on function public.finance_reconciliation_detail(uuid) from public, anon, authenticated;
grant execute on function public.finance_reconciliation_detail(uuid) to authenticated;


-- == 19) Writer RPCs ==========================================================
-- The internal entry writer. Every posting path funnels through here so the
-- balance, the period lock and the audit row have exactly one implementation.
create or replace function public.finance_post_entry(
  p_entry_date date, p_entry_kind text, p_memo text, p_source text,
  p_lines jsonb, p_idempotency_key text default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_entry uuid; v_actor uuid := auth.uid(); v_email text; v_line jsonb; v_n int := 0;
  v_existing uuid;
begin
  if p_idempotency_key is not null then
    select id into v_existing from public.finance_journal_entries where idempotency_key = p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    perform public.app_error('FINANCE_ENTRY_UNBALANCED',
      'An entry needs at least two lines.', 422, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;

  insert into public.finance_journal_entries
    (entry_date, entry_kind, memo, source, idempotency_key, created_by, created_by_email)
  values (p_entry_date, p_entry_kind, p_memo, p_source, p_idempotency_key, v_actor, v_email)
  returning id into v_entry;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit, memo)
    values (v_entry, v_n,
            (v_line->>'account_id')::uuid,
            round(coalesce((v_line->>'debit')::numeric, 0), 2),
            round(coalesce((v_line->>'credit')::numeric, 0), 2),
            v_line->>'memo');
  end loop;

  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'entry_post', 'journal_entry', v_entry,
          (select sum(debit) from public.finance_journal_lines where entry_id = v_entry),
          jsonb_build_object('source', p_source, 'kind', p_entry_kind));

  return v_entry;
end;
$fn$;
revoke all on function public.finance_post_entry(date, text, text, text, jsonb, text) from public, anon, authenticated;

create or replace function public.finance_post_manual_entry(
  p_entry_date date, p_entry_kind text, p_memo text, p_lines jsonb, p_idempotency_key text
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then
    perform public.app_error('FINANCE_IDEMPOTENCY_REQUIRED',
      'This action needs an idempotency key so a retry cannot post twice.', 422, null);
  end if;
  if p_entry_kind = 'reversal' then
    perform public.app_error('FINANCE_ENTRY_KIND_INVALID',
      'Use the reverse action to create a reversal.', 422, null);
  end if;
  return public.finance_post_entry(p_entry_date, p_entry_kind, p_memo, 'manual', p_lines,
                                   'manual:' || p_idempotency_key);
end;
$fn$;
revoke all on function public.finance_post_manual_entry(date, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.finance_post_manual_entry(date, text, text, jsonb, text) to authenticated;

create or replace function public.finance_reverse_entry(
  p_entry_id uuid, p_reason text, p_reversal_date date default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_orig public.finance_journal_entries%rowtype;
  v_date date; v_period text; v_tz text; v_today date;
  v_entry uuid; v_actor uuid := auth.uid(); v_email text; v_line record; v_n int := 0;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_REVERSAL_REASON_REQUIRED',
      'A reversal needs a reason — it is the only record of why the correction was made.', 422, null);
  end if;

  select * into v_orig from public.finance_journal_entries where id = p_entry_id;
  if not found then
    perform public.app_error('FINANCE_ENTRY_NOT_FOUND', 'That journal entry does not exist.', 404, null);
  end if;
  if exists (select 1 from public.finance_journal_entries where reverses_entry_id = p_entry_id) then
    perform public.app_error('FINANCE_ENTRY_ALREADY_REVERSED',
      'That entry has already been reversed.', 409, jsonb_build_object('entry_id', p_entry_id));
  end if;

  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;

  -- ★ NEVER silently back-date, NEVER silently refuse — say which month it lands
  --   in. A closed month's reported figure must stay equal to what was reported.
  if p_reversal_date is not null then
    v_date := p_reversal_date;
    v_period := public.finance_resolve_period(v_date);
    if exists (select 1 from public.finance_period_locks where period_key = v_period and locked) then
      perform public.app_error('FINANCE_PERIOD_LOCKED',
        'That accounting period is closed, so the correction cannot be dated into it.', 409,
        jsonb_build_object('period', v_period));
    end if;
  else
    v_date := v_orig.entry_date;
    v_period := public.finance_resolve_period(v_date);
    if exists (select 1 from public.finance_period_locks where period_key = v_period and locked) then
      v_date := greatest(v_today, date_trunc('month', v_today)::date);
      while exists (select 1 from public.finance_period_locks
                     where period_key = public.finance_resolve_period(v_date) and locked) loop
        v_date := (date_trunc('month', v_date) + interval '1 month')::date;
      end loop;
    end if;
  end if;

  select email into v_email from public.profiles where id = v_actor;

  insert into public.finance_journal_entries
    (entry_date, entry_kind, memo, source, reverses_entry_id, reversal_reason,
     idempotency_key, created_by, created_by_email)
  values (v_date, 'reversal', 'Reversal of entry #' || v_orig.entry_no, 'reversal',
          p_entry_id, p_reason, 'reversal:' || p_entry_id::text, v_actor, v_email)
  returning id into v_entry;

  -- Debit and credit SWAPPED, never negated — negation would violate debit >= 0.
  for v_line in select * from public.finance_journal_lines where entry_id = p_entry_id order by line_no loop
    v_n := v_n + 1;
    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit, memo)
    values (v_entry, v_n, v_line.account_id, v_line.credit, v_line.debit, v_line.memo);
  end loop;

  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail, reason)
  values (v_actor, v_email, 'entry_reverse', 'journal_entry', v_entry,
          (select sum(debit) from public.finance_journal_lines where entry_id = v_entry),
          jsonb_build_object('reverses', p_entry_id, 'landed_in', public.finance_resolve_period(v_date)),
          p_reason);

  return jsonb_build_object('entry_id', v_entry, 'entry_date', v_date,
                            'period', public.finance_resolve_period(v_date));
end;
$fn$;
revoke all on function public.finance_reverse_entry(uuid, text, date) from public, anon, authenticated;
grant execute on function public.finance_reverse_entry(uuid, text, date) to authenticated;

create or replace function public.finance_lock_period(p_period_key text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_tz text; v_today date; v_current text; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    perform public.app_error('FINANCE_PERIOD_INVALID', 'Periods look like 2026-09.', 422, null);
  end if;

  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_today := (now() at time zone coalesce(v_tz,'Asia/Manila'))::date;
  v_current := public.finance_resolve_period(v_today);

  -- ★ Only an ELAPSED period may be locked, measured in the BUSINESS's timezone
  --   (batch_is_past()'s reasoning applied to accounting — a UTC comparison
  --   would lock an Asia/Manila month up to 16 hours early). The consequence is
  --   the important part: an approval is dated today, always in the current
  --   period, which can never be locked — so closing the books can never block a
  --   student's approval, and no carve-out is needed anywhere.
  if p_period_key >= v_current then
    perform public.app_error('FINANCE_PERIOD_NOT_ELAPSED',
      'That period has not finished yet. Only a completed month can be closed.', 409,
      jsonb_build_object('period', p_period_key, 'current', v_current));
  end if;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_period_locks (period_key, locked, locked_by, locked_by_email, note)
  values (p_period_key, true, v_actor, v_email, p_note)
  on conflict (period_key) do update
    set locked = true, locked_at = now(), locked_by = excluded.locked_by,
        locked_by_email = excluded.locked_by_email, note = excluded.note,
        unlocked_at = null, unlocked_by = null, unlocked_by_email = null, unlock_reason = null;

  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, detail)
  values (v_actor, v_email, 'period_lock', 'period', jsonb_build_object('period', p_period_key));

  return jsonb_build_object('period', p_period_key, 'locked', true);
end;
$fn$;
revoke all on function public.finance_lock_period(text, text) from public, anon, authenticated;
grant execute on function public.finance_lock_period(text, text) to authenticated;

create or replace function public.finance_unlock_period(p_period_key text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_PERIOD_REASON_REQUIRED',
      'Reopening a closed period needs a reason.', 422, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  update public.finance_period_locks
     set locked = false, unlocked_at = now(), unlocked_by = v_actor,
         unlocked_by_email = v_email, unlock_reason = p_reason
   where period_key = p_period_key;
  if not found then
    perform public.app_error('FINANCE_PERIOD_INVALID', 'That period is not locked.', 404, null);
  end if;
  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, detail, reason)
  values (v_actor, v_email, 'period_unlock', 'period', jsonb_build_object('period', p_period_key), p_reason);
  return jsonb_build_object('period', p_period_key, 'locked', false);
end;
$fn$;
revoke all on function public.finance_unlock_period(text, text) from public, anon, authenticated;
grant execute on function public.finance_unlock_period(text, text) to authenticated;

create or replace function public.finance_save_settings(
  p_reporting_timezone text default null,
  p_fiscal_year_start_month integer default null,
  p_default_income_account_id uuid default null,
  p_default_cash_account_id uuid default null,
  p_default_owner_draw_account_id uuid default null,
  p_bank_duplicate_day_window integer default null
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_reporting_timezone is not null
     and not exists (select 1 from pg_timezone_names where name = p_reporting_timezone) then
    perform public.app_error('FINANCE_TIMEZONE_INVALID',
      'That is not a timezone the server recognises.', 422, null);
  end if;

  -- ★ VALIDATE THE ACCOUNTS. The FK only proves they exist. Without this a careless
  --   save stops EVERY Operations Admin approving ANY student: the approval hook
  --   raises on an inactive or missing account, and admin_finalize_enrollment sets
  --   status='approved' as its LAST statement, so the raise rolls back the
  --   subscription grant, the batch seat and the profile patch with it.
  -- ★ And income = cash is the silent one: it produces a balanced entry that debits
  --   and credits the SAME account, passing every guard while recording a collection
  --   worth nothing in either place.
  if p_default_income_account_id is not null
     and not exists (select 1 from public.finance_accounts
                      where id = p_default_income_account_id and account_type = 'income' and active) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'The default income account must be an active income account.', 422, null);
  end if;
  if p_default_cash_account_id is not null
     and not exists (select 1 from public.finance_accounts
                      where id = p_default_cash_account_id and account_type = 'asset'
                        and subtype in ('cash','bank') and active) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'The default cash account must be an active cash or bank account.', 422, null);
  end if;
  if p_default_owner_draw_account_id is not null
     and not exists (select 1 from public.finance_accounts
                      where id = p_default_owner_draw_account_id and subtype = 'owner_draw' and active) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      "The owner's draw account must be an active equity account of subtype owner_draw.", 422, null);
  end if;
  if coalesce(p_default_income_account_id, (select default_income_account_id from public.finance_settings where id))
     = coalesce(p_default_cash_account_id, (select default_cash_account_id from public.finance_settings where id)) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'The income and cash accounts must be different, or every collection would debit and credit '
      'the same account and record nothing.', 422, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;
  update public.finance_settings
     set reporting_timezone = coalesce(p_reporting_timezone, reporting_timezone),
         fiscal_year_start_month = coalesce(p_fiscal_year_start_month, fiscal_year_start_month),
         default_income_account_id = coalesce(p_default_income_account_id, default_income_account_id),
         default_cash_account_id = coalesce(p_default_cash_account_id, default_cash_account_id),
         default_owner_draw_account_id = coalesce(p_default_owner_draw_account_id, default_owner_draw_account_id),
         bank_duplicate_day_window = coalesce(p_bank_duplicate_day_window, bank_duplicate_day_window),
         updated_at = now(), updated_by = v_actor, updated_by_email = v_email
   where id;
  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, detail)
  values (v_actor, v_email, 'settings_update', 'settings', '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_save_settings(text, integer, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.finance_save_settings(text, integer, uuid, uuid, uuid, integer) to authenticated;

create or replace function public.finance_save_account(
  p_id uuid, p_code text, p_name text, p_account_type text, p_subtype text,
  p_reporting_class text default 'business', p_cash_flow_class text default 'none',
  p_parent_account_id uuid default null, p_sort_order integer default 0,
  p_active boolean default true, p_description text default null
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_actor uuid := auth.uid(); v_email text; v_is_system boolean;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;

  if p_id is null then
    insert into public.finance_accounts
      (code, name, account_type, subtype, reporting_class, cash_flow_class,
       parent_account_id, sort_order, active, description)
    values (p_code, p_name, p_account_type, p_subtype, p_reporting_class, p_cash_flow_class,
            p_parent_account_id, p_sort_order, p_active, p_description)
    returning id into v_id;
    insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, target_id, detail)
    values (v_actor, v_email, 'account_create', 'account', v_id, jsonb_build_object('code', p_code));
  else
    select is_system into v_is_system from public.finance_accounts where id = p_id;
    if v_is_system is null then
      perform public.app_error('FINANCE_ACCOUNT_NOT_FOUND', 'That account does not exist.', 404, null);
    end if;
    if v_is_system and (not p_active) then
      perform public.app_error('FINANCE_SYSTEM_ACCOUNT',
        'A system account cannot be deactivated — the ledger and the approval hook depend on it.', 409, null);
    end if;
    -- ★ AN ACCOUNT SOMETHING POSTS TO CANNOT BE SWITCHED OFF. The is_system flag covers
    --   only the seeded defaults; settings can point at ANY active account, and so can
    --   a plan (§4b). Deactivating the default cash account would stop every approval
    --   — the hook refuses an inactive default — so it is refused here, where the
    --   person doing it can see why.
    if not p_active and (
         exists (select 1 from public.finance_settings s
                  where s.id and p_id in (s.default_income_account_id, s.default_cash_account_id,
                                          s.default_owner_draw_account_id))
         or exists (select 1 from public.enrollment_plans p where p.finance_income_account_id = p_id)) then
      perform public.app_error('FINANCE_ACCOUNT_IN_USE',
        'That account is a default in Settings or the income account for a plan. Point those at '
        'another account before deactivating it.', 409, jsonb_build_object('account_id', p_id));
    end if;
    update public.finance_accounts
       set code = p_code, name = p_name,
           account_type = case when v_is_system then account_type else p_account_type end,
           subtype = case when v_is_system then subtype else p_subtype end,
           reporting_class = p_reporting_class, cash_flow_class = p_cash_flow_class,
           parent_account_id = p_parent_account_id, sort_order = p_sort_order,
           active = p_active, description = p_description, updated_at = now()
     where id = p_id
    returning id into v_id;
    insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, target_id, detail)
    values (v_actor, v_email, 'account_update', 'account', v_id, jsonb_build_object('code', p_code));
  end if;
  return v_id;
end;
$fn$;
revoke all on function public.finance_save_account(uuid, text, text, text, text, text, text, uuid, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.finance_save_account(uuid, text, text, text, text, text, text, uuid, integer, boolean, text) to authenticated;


-- == 19b) Bank import, reconciliation, recurring =============
-- Same shape as every writer above: permission check first, audit row last, no
-- exception handler anywhere.

-- Staging parses NOTHING. The client has already resolved the declared date format
-- into ISO dates, so DD/MM vs MM/DD is settled by a human before a row is stored —
-- the legacy importer kept raw strings and left the ambiguity permanently unresolved.
create or replace function public.finance_stage_bank_import(
  p_account_id uuid, p_file_name text, p_file_sha256 text, p_file_size_bytes bigint,
  p_date_format text, p_opening numeric, p_closing numeric, p_rows jsonb
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_actor uuid := auth.uid(); v_email text; v_row jsonb; v_n int := 0;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if exists (select 1 from public.finance_bank_imports
              where account_id = p_account_id and file_sha256 = p_file_sha256) then
    perform public.app_error('FINANCE_BANK_IMPORT_DUPLICATE',
      'That statement file has already been imported into this account. Importing it again would '
      'double every transaction in it.', 409, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_bank_imports
    (account_id, file_name, file_sha256, file_size_bytes, date_format,
     opening_balance, closing_balance, row_count, created_by, created_by_email)
  values (p_account_id, p_file_name, p_file_sha256, p_file_size_bytes, p_date_format,
          p_opening, p_closing, coalesce(jsonb_array_length(p_rows), 0), v_actor, v_email)
  returning id into v_id;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_n := v_n + 1;
    insert into public.finance_bank_transactions
      (import_id, account_id, posted_on, description_raw, amount, balance_after)
    values (v_id, p_account_id, (v_row->>'posted_on')::date,
            coalesce(v_row->>'description', ''),
            round((v_row->>'amount')::numeric, 2),
            nullif(v_row->>'balance_after','')::numeric);
  end loop;

  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'bank_import_stage', 'bank_import', v_id,
          jsonb_build_object('rows', v_n, 'account_id', p_account_id));
  return v_id;
end;
$fn$;
revoke all on function public.finance_stage_bank_import(uuid, text, text, bigint, text, numeric, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.finance_stage_bank_import(uuid, text, text, bigint, text, numeric, numeric, jsonb) to authenticated;

-- ★ THE EXACT/LIKELY ASYMMETRY IS THE DESIGN. An exact fingerprint match against an
--   EARLIER COMMITTED import defaults to `duplicate` (excluded from every total); a
--   near match on the same amount within the configured day window defaults to
--   `unmatched` and merely flags. Double-counting an expense understates profit
--   permanently and silently; dropping a real transaction surfaces at the next
--   reconciliation. The defaults follow the cost of being wrong. Both are one click
--   to reverse, and reversing writes an audit row.
create or replace function public.finance_commit_bank_import(p_import_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_imp public.finance_bank_imports%rowtype;
  v_window int; v_exact int := 0; v_likely int := 0; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_imp from public.finance_bank_imports where id = p_import_id;
  if not found or v_imp.status <> 'parsed' then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'That import is not open for review.', 409, null);
  end if;
  select coalesce(bank_duplicate_day_window, 3) into v_window from public.finance_settings where id;

  with dup as (
    select t.id, prior.id as of_id
      from public.finance_bank_transactions t
      join public.finance_bank_transactions prior
        on prior.fingerprint = t.fingerprint and prior.import_id <> t.import_id
      join public.finance_bank_imports pi on pi.id = prior.import_id and pi.status = 'committed'
     where t.import_id = p_import_id
  )
  update public.finance_bank_transactions t
     set status = 'duplicate', duplicate_kind = 'exact', duplicate_of_id = dup.of_id
    from dup where t.id = dup.id;
  get diagnostics v_exact = row_count;

  with near as (
    select distinct t.id, other.id as of_id
      from public.finance_bank_transactions t
      join public.finance_bank_transactions other
        on other.account_id = t.account_id and other.id <> t.id
       and abs(other.amount) = abs(t.amount)
       and abs(other.posted_on - t.posted_on) <= v_window
       and other.fingerprint <> t.fingerprint
     where t.import_id = p_import_id and t.status = 'unmatched'
  )
  update public.finance_bank_transactions t
     set duplicate_kind = 'likely', duplicate_of_id = near.of_id
    from near where t.id = near.id;
  get diagnostics v_likely = row_count;

  update public.finance_bank_imports
     set status = 'committed', committed_at = now(),
         duplicate_row_count = v_exact,
         imported_row_count = (select count(*) from public.finance_bank_transactions
                                where import_id = p_import_id and status <> 'duplicate')
   where id = p_import_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'bank_import_commit', 'bank_import', p_import_id,
          jsonb_build_object('exact_duplicates', v_exact, 'likely_flagged', v_likely));
  return jsonb_build_object('exact_duplicates', v_exact, 'likely_flagged', v_likely);
end;
$fn$;
revoke all on function public.finance_commit_bank_import(uuid) from public, anon, authenticated;
grant execute on function public.finance_commit_bank_import(uuid) to authenticated;

create or replace function public.finance_discard_bank_import(p_import_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text; v_status text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select status into v_status from public.finance_bank_imports where id = p_import_id;
  -- A committed run's rows may already be matched to journal entries; discarding it
  -- would cascade them away and silently unpick real reconciliation work.
  if v_status is distinct from 'parsed' then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Only an un-committed import can be discarded.', 409, null);
  end if;
  -- ★ Matching is not gated on import status, so a `parsed` run's rows can already be
  --   reconciled — and finance_reconciliation_items.bank_transaction_id is ON DELETE
  --   RESTRICT. Without this the delete below raises a bare 23503 foreign-key error.
  if exists (
    select 1 from public.finance_reconciliation_items i
     join public.finance_bank_transactions t on t.id = i.bank_transaction_id
    where t.import_id = p_import_id
  ) then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'Some transactions from this import are already matched to a reconciliation. Unmatch them '
      'before discarding the import.', 409, null);
  end if;
  delete from public.finance_bank_transactions where import_id = p_import_id;
  update public.finance_bank_imports set status = 'discarded' where id = p_import_id;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail, reason)
  values (v_actor, v_email, 'bank_import_discard', 'bank_import', p_import_id, '{}'::jsonb, p_reason);
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_discard_bank_import(uuid, text) from public, anon, authenticated;
grant execute on function public.finance_discard_bank_import(uuid, text) to authenticated;

create or replace function public.finance_bank_txn_set_status(
  p_id uuid, p_status text, p_reason text default null
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if p_status not in ('unmatched','excluded','duplicate') then
    raise exception 'finance_bank_txn_set_status: unknown status %', p_status using errcode = '22023';
  end if;
  -- Excluding must say why: an unexplained exclusion is indistinguishable from a
  -- missing transaction when the account fails to reconcile three months later.
  if p_status = 'excluded' and nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_BANK_EXCLUDE_REASON_REQUIRED',
      'Say why this transaction is excluded — otherwise it is indistinguishable from one that '
      'simply went missing.', 422, null);
  end if;
  -- ★ A MATCHED TRANSACTION IS UNMATCHED IN ITS RECONCILIATION, NOT HERE. Flipping the
  --   status alone left its reconciliation item behind: the row read "unmatched" while
  --   still counting as cleared, and its import could then never be discarded.
  if exists (select 1 from public.finance_reconciliation_items where bank_transaction_id = p_id) then
    perform public.app_error('FINANCE_BANK_IMPORT_STATE',
      'That transaction is matched in a reconciliation. Unmatch it there first.', 409,
      jsonb_build_object('txn_id', p_id));
  end if;
  update public.finance_bank_transactions
     set status = p_status, excluded_reason = case when p_status = 'excluded' then p_reason else null end
   where id = p_id;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That transaction does not exist.', 404, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail, reason)
  values (v_actor, v_email, 'bank_txn_status', 'bank_transaction', p_id,
          jsonb_build_object('status', p_status), p_reason);
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_bank_txn_set_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finance_bank_txn_set_status(uuid, text, text) to authenticated;

create or replace function public.finance_open_reconciliation(
  p_account_id uuid, p_period_start date, p_period_end date,
  p_statement_opening numeric, p_statement_closing numeric
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_reconciliations
    (account_id, period_start, period_end, statement_opening, statement_closing,
     created_by, created_by_email)
  values (p_account_id, p_period_start, p_period_end, p_statement_opening, p_statement_closing,
          v_actor, v_email)
  returning id into v_id;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'reconciliation_open', 'reconciliation', v_id,
          jsonb_build_object('account_id', p_account_id));
  return v_id;
end;
$fn$;
revoke all on function public.finance_open_reconciliation(uuid, date, date, numeric, numeric) from public, anon, authenticated;
grant execute on function public.finance_open_reconciliation(uuid, date, date, numeric, numeric) to authenticated;

create or replace function public.finance_match_reconciliation_item(
  p_reconciliation_id uuid, p_bank_transaction_id uuid,
  p_journal_line_id uuid default null, p_matched_amount numeric default null
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_amount numeric(14,2); v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  -- ★ The transaction must belong to THIS reconciliation's account and period.
  --   Without that check, matching a foreign transaction flipped it to 'matched',
  --   removing it from its OWN account's unmatched list — which then let that
  --   account's reconciliation close with an unreviewed transaction hidden inside it.
  select coalesce(p_matched_amount, t.amount) into v_amount
    from public.finance_bank_transactions t
    join public.finance_reconciliations r on r.id = p_reconciliation_id
   where t.id = p_bank_transaction_id
     and t.account_id = r.account_id
     and t.posted_on between r.period_start and r.period_end;
  if v_amount is null then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND',
      'That transaction does not exist, or does not belong to this reconciliation''s account and '
      'period.', 404, null);
  end if;

  insert into public.finance_reconciliation_items
    (reconciliation_id, bank_transaction_id, journal_line_id, matched_amount)
  values (p_reconciliation_id, p_bank_transaction_id, p_journal_line_id, v_amount)
  returning id into v_id;

  update public.finance_bank_transactions set status = 'matched' where id = p_bank_transaction_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'reconciliation_match', 'reconciliation', p_reconciliation_id, v_amount,
          jsonb_build_object('bank_transaction_id', p_bank_transaction_id));
  return v_id;
end;
$fn$;
revoke all on function public.finance_match_reconciliation_item(uuid, uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.finance_match_reconciliation_item(uuid, uuid, uuid, numeric) to authenticated;

-- A reconciliation that does not reconcile cannot close. Every unmatched row must be
-- matched or explicitly excluded WITH A REASON first, so the difference is always
-- explainable rather than merely zero.
create or replace function public.finance_close_reconciliation(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_rec public.finance_reconciliations%rowtype;
  v_cleared numeric(14,2); v_diff numeric(14,2); v_open int;
  v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_rec from public.finance_reconciliations where id = p_id;
  if not found or v_rec.status <> 'open' then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
      'That reconciliation is not open.', 409, null);
  end if;

  select count(*) into v_open
    from public.finance_bank_transactions t
   where t.account_id = v_rec.account_id
     and t.posted_on between v_rec.period_start and v_rec.period_end
     and t.status = 'unmatched';
  if v_open > 0 then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'There are still unreviewed transactions in this period. Match or exclude each one, then '
      'close.', 409, jsonb_build_object('unmatched', v_open));
  end if;

  -- ★ A MISSING STATEMENT BALANCE IS NOT ZERO. Coalescing it made a reconciliation
  --   opened without balances closable only when nothing had cleared, and reported
  --   that as a non-zero difference — a false failure with a misleading message.
  if v_rec.statement_opening is null or v_rec.statement_closing is null then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'This reconciliation has no statement opening or closing balance, so there is nothing to '
      'reconcile against. Reopen it and enter both figures from the statement.', 409, null);
  end if;

  select coalesce(sum(t.amount), 0) into v_cleared
    from public.finance_bank_transactions t
   where t.account_id = v_rec.account_id
     and t.posted_on between v_rec.period_start and v_rec.period_end
     and t.status = 'matched';
  v_diff := v_rec.statement_closing - v_rec.statement_opening - v_cleared;

  if v_diff <> 0 then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'This does not reconcile yet — the difference is not zero.', 409,
      jsonb_build_object('difference', v_diff, 'cleared', v_cleared));
  end if;

  select email into v_email from public.profiles where id = v_actor;
  update public.finance_reconciliations
     set status = 'closed', difference = 0, closed_at = now(),
         closed_by = v_actor, closed_by_email = v_email
   where id = p_id;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'reconciliation_close', 'reconciliation', p_id, v_cleared, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'cleared', v_cleared);
end;
$fn$;
revoke all on function public.finance_close_reconciliation(uuid) from public, anon, authenticated;
grant execute on function public.finance_close_reconciliation(uuid) to authenticated;

create or replace function public.finance_reopen_reconciliation(p_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_rec public.finance_reconciliations%rowtype; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    perform public.app_error('FINANCE_PERIOD_REASON_REQUIRED',
      'Reopening a closed reconciliation needs a reason — six months from now it is the only '
      'record of why the books were reopened.', 422, null);
  end if;
  select * into v_rec from public.finance_reconciliations where id = p_id;
  if not found then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED', 'That reconciliation does not exist.', 404, null);
  end if;
  -- ★ You cannot reopen your way into a closed accounting period.
  if exists (select 1 from public.finance_period_locks
              where locked and period_key between public.finance_resolve_period(v_rec.period_start)
                                              and public.finance_resolve_period(v_rec.period_end)) then
    perform public.app_error('FINANCE_PERIOD_LOCKED',
      'That reconciliation covers a closed accounting period. Unlock the period first, with a '
      'reason.', 409, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;
  update public.finance_reconciliations
     set status = 'open', reopened_at = now(), reopened_by = v_actor,
         reopened_by_email = v_email, reopen_reason = p_reason
   where id = p_id;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail, reason)
  values (v_actor, v_email, 'reconciliation_reopen', 'reconciliation', p_id, '{}'::jsonb, p_reason);
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_reopen_reconciliation(uuid, text) from public, anon, authenticated;
grant execute on function public.finance_reopen_reconciliation(uuid, text) to authenticated;

-- ★ A MISTYPED STATEMENT BALANCE MUST BE CORRECTABLE. Nothing else can change one, and a
--   reconciliation cannot be deleted, so a single typo at open made that account
--   permanently unreconcilable — while the close refusal told the admin to "enter both
--   figures" through a function that did not exist. OPEN reconciliations only: a closed
--   one stays frozen until it is reopened with a reason (finance_reconciliation_guard).
create or replace function public.finance_update_reconciliation_statement(
  p_id uuid, p_statement_opening numeric, p_statement_closing numeric
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_rec public.finance_reconciliations%rowtype; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_rec from public.finance_reconciliations where id = p_id;
  if not found or v_rec.status <> 'open' then
    perform public.app_error('FINANCE_RECONCILIATION_CLOSED',
      'Only an open reconciliation''s statement balances can be changed. Reopen it with a reason first.', 409, null);
  end if;
  if p_statement_opening is null or p_statement_closing is null then
    perform public.app_error('FINANCE_RECONCILIATION_UNBALANCED',
      'Enter both the opening and the closing balance from the statement.', 422, null);
  end if;

  update public.finance_reconciliations
     set statement_opening = round(p_statement_opening, 2), statement_closing = round(p_statement_closing, 2)
   where id = p_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, detail)
  values (v_actor, v_email, 'reconciliation_update', 'reconciliation', p_id,
          jsonb_build_object('before', jsonb_build_object('opening', v_rec.statement_opening, 'closing', v_rec.statement_closing),
                             'after',  jsonb_build_object('opening', round(p_statement_opening, 2), 'closing', round(p_statement_closing, 2))));
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_update_reconciliation_statement(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.finance_update_reconciliation_statement(uuid, numeric, numeric) to authenticated;

-- A template PROPOSES. This is the only thing that turns one into a posting, and a
-- human calls it. The key is per template per OCCURRENCE — per period for a monthly,
-- quarterly or yearly template, per date for a weekly one — so confirming the same
-- occurrence twice is a no-op rather than a duplicate cost.
create or replace function public.finance_post_recurring(
  p_template_id uuid, p_entry_date date default null, p_memo text default null
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_t public.finance_recurring_templates%rowtype;
  v_date date; v_tz text; v_entry uuid; v_actor uuid := auth.uid(); v_email text;
  v_key text; v_existing uuid;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_t from public.finance_recurring_templates where id = p_template_id and active;
  if not found then
    perform public.app_error('FINANCE_ACCOUNT_NOT_FOUND', 'That recurring template is not active.', 404, null);
  end if;
  select coalesce(reporting_timezone,'Asia/Manila') into v_tz from public.finance_settings where id;
  v_date := coalesce(p_entry_date, v_t.next_due_on, (now() at time zone v_tz)::date);

  -- ★ THE KEY'S GRAIN IS THE CADENCE'S GRAIN. A month-scoped key collapsed the 2nd,
  --   3rd and 4th posting of a WEEKLY template into the first, each returning the
  --   first entry's id as though it had posted.
  v_key := 'recurring:' || p_template_id::text || ':' ||
           case when v_t.cadence = 'weekly' then v_date::text
                else public.finance_resolve_period(v_date) end;

  -- ★ AN OCCURRENCE ALREADY POSTED RETURNS BEFORE THE SCHEDULE MOVES. finance_post_entry
  --   would hand back the existing id on its own — but the update below would then
  --   still advance next_due_on, so a double-click silently skipped a whole period.
  select id into v_existing from public.finance_journal_entries where idempotency_key = v_key;
  if v_existing is not null then
    return v_existing;
  end if;

  v_entry := public.finance_post_entry(
    v_date, v_t.entry_kind, coalesce(p_memo, v_t.memo, v_t.name), 'recurring',
    jsonb_build_array(
      jsonb_build_object('account_id', v_t.account_id,        'debit', v_t.amount, 'credit', 0),
      jsonb_build_object('account_id', v_t.contra_account_id, 'debit', 0,          'credit', v_t.amount)),
    v_key);

  update public.finance_recurring_templates
     set last_proposed_on = v_date, last_posted_entry_id = v_entry,
         next_due_on = case v_t.cadence
           when 'weekly'    then v_date + 7
           when 'monthly'   then (v_date + interval '1 month')::date
           when 'quarterly' then (v_date + interval '3 months')::date
           else (v_date + interval '1 year')::date end,
         updated_at = now()
   where id = p_template_id;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'recurring_post', 'recurring_template', p_template_id, v_t.amount,
          jsonb_build_object('entry_id', v_entry));
  return v_entry;
end;
$fn$;
revoke all on function public.finance_post_recurring(uuid, date, text) from public, anon, authenticated;
grant execute on function public.finance_post_recurring(uuid, date, text) to authenticated;


-- == 19c) Setup writers: plan income accounts, recurring templates, unmatching ==

-- The ONLY writer of enrollment_plans.finance_income_account_id (§4b). A null
-- account clears the mapping, returning the plan to the settings default.
create or replace function public.finance_map_plan_income_account(p_plan_key text, p_account_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  if not exists (select 1 from public.enrollment_plans where key = p_plan_key) then
    perform public.app_error('INVALID_PLAN', 'That plan does not exist.', 422, null);
  end if;
  if p_account_id is not null and not exists (
       select 1 from public.finance_accounts
        where id = p_account_id and account_type = 'income' and active) then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'A plan''s collections can only post to an active income account.', 422, null);
  end if;

  update public.enrollment_plans set finance_income_account_id = p_account_id where key = p_plan_key;

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, detail)
  values (v_actor, v_email, 'plan_income_map', 'plan',
          jsonb_build_object('plan_key', p_plan_key, 'account_id', p_account_id));
  return jsonb_build_object('plan_key', p_plan_key, 'account_id', p_account_id);
end;
$fn$;
revoke all on function public.finance_map_plan_income_account(text, uuid) from public, anon, authenticated;
grant execute on function public.finance_map_plan_income_account(text, uuid) to authenticated;

-- Without a writer finance_recurring_templates could never hold a row, so
-- finance_post_recurring — already granted — would have nothing to post.
-- ★ It saves a PROPOSAL. Nothing here posts, and no job reads this table.
create or replace function public.finance_save_recurring_template(
  p_id uuid, p_name text, p_account_id uuid, p_contra_account_id uuid, p_amount numeric,
  p_entry_kind text, p_memo text, p_cadence text, p_day_of_month integer, p_weekday integer,
  p_next_due_on date, p_active boolean default true
) returns uuid language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_id uuid; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  -- Validated here so the admin reads a sentence, not a bare 23514 from a CHECK.
  if nullif(btrim(coalesce(p_name,'')),'') is null
     or coalesce(p_amount, 0) <= 0
     or p_next_due_on is null
     or p_account_id is null or p_contra_account_id is null or p_account_id = p_contra_account_id
     or p_entry_kind is null or p_entry_kind not in ('collection','expense','owner_draw','owner_contribution',
                                                     'transfer','refund','adjustment')
     or p_cadence is null or p_cadence not in ('monthly','weekly','quarterly','yearly')
     or (p_cadence = 'weekly'  and (p_weekday is null or p_weekday not between 0 and 6 or p_day_of_month is not null))
     or (p_cadence <> 'weekly' and (p_day_of_month is null or p_day_of_month not between 1 and 31 or p_weekday is not null))
     or (select count(*) from public.finance_accounts
          where id in (p_account_id, p_contra_account_id) and active) <> 2 then
    perform public.app_error('FINANCE_RECURRING_INVALID',
      'A recurring template needs a name, two different active accounts, an amount above zero, and '
      'a schedule that matches its frequency.', 422, null);
  end if;

  select email into v_email from public.profiles where id = v_actor;
  if p_id is null then
    insert into public.finance_recurring_templates
      (name, account_id, contra_account_id, amount, entry_kind, memo, cadence, day_of_month,
       weekday, next_due_on, active, created_by, created_by_email)
    values (btrim(p_name), p_account_id, p_contra_account_id, round(p_amount, 2), p_entry_kind, p_memo,
            p_cadence, p_day_of_month, p_weekday, p_next_due_on, coalesce(p_active, true), v_actor, v_email)
    returning id into v_id;
  else
    update public.finance_recurring_templates
       set name = btrim(p_name), account_id = p_account_id, contra_account_id = p_contra_account_id,
           amount = round(p_amount, 2), entry_kind = p_entry_kind, memo = p_memo, cadence = p_cadence,
           day_of_month = p_day_of_month, weekday = p_weekday, next_due_on = p_next_due_on,
           active = coalesce(p_active, true), updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then
      perform public.app_error('FINANCE_RECURRING_INVALID', 'That recurring template does not exist.', 404, null);
    end if;
  end if;

  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'recurring_save', 'recurring_template', v_id, round(p_amount, 2),
          jsonb_build_object('cadence', p_cadence, 'active', coalesce(p_active, true)));
  return v_id;
end;
$fn$;
revoke all on function public.finance_save_recurring_template(uuid, text, uuid, uuid, numeric, text, text, text, integer, integer, date, boolean) from public, anon, authenticated;
grant execute on function public.finance_save_recurring_template(uuid, text, uuid, uuid, numeric, text, text, text, integer, integer, date, boolean) to authenticated;

-- ★ A MATCH MUST BE UNDOABLE. finance_discard_bank_import already told the admin to
--   "unmatch them first", and no function could. The reconciliation-item guard still
--   refuses this on a CLOSED reconciliation, so a closed month stays closed.
create or replace function public.finance_unmatch_reconciliation_item(p_item_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare v_item public.finance_reconciliation_items%rowtype; v_actor uuid := auth.uid(); v_email text;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;
  select * into v_item from public.finance_reconciliation_items where id = p_item_id;
  if not found then
    perform public.app_error('FINANCE_BANK_TXN_NOT_FOUND', 'That match no longer exists.', 404, null);
  end if;

  delete from public.finance_reconciliation_items where id = p_item_id;
  update public.finance_bank_transactions
     set status = 'unmatched'
   where id = v_item.bank_transaction_id and status = 'matched'
     and not exists (select 1 from public.finance_reconciliation_items
                      where bank_transaction_id = v_item.bank_transaction_id);

  select email into v_email from public.profiles where id = v_actor;
  insert into public.finance_audit_events
    (actor_user_id, actor_email, action, target_kind, target_id, amount, detail)
  values (v_actor, v_email, 'reconciliation_unmatch', 'reconciliation', v_item.reconciliation_id,
          v_item.matched_amount, jsonb_build_object('bank_transaction_id', v_item.bank_transaction_id));
  return jsonb_build_object('ok', true);
end;
$fn$;
revoke all on function public.finance_unmatch_reconciliation_item(uuid) from public, anon, authenticated;
grant execute on function public.finance_unmatch_reconciliation_item(uuid) to authenticated;


-- == 20) The backfill — created AFTER the trigger =============================
-- ★ Backfilling FIRST would leave a gap: any request approved between the
--   backfill and the trigger's creation would never be posted. Running it after
--   means the overlap is covered by both, and the shared idempotency namespace
--   makes that overlap a no-op.
create or replace function public.finance_backfill_enrollment_collections(
  p_dry_run boolean default true, p_limit integer default 5000
) returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  v_cfg public.finance_settings%rowtype;
  v_income uuid; v_cash uuid; v_actor uuid := auth.uid(); v_email text;
  v_candidate int := 0; v_posted int := 0; v_skipped int := 0;
  r record; v_entry uuid; v_event uuid; v_key text; v_date date; v_row_income uuid;
begin
  if not public.has_staff_permission('finance.manage') then
    perform public.app_error('FORBIDDEN',
      'Financial Management requires the finance.manage permission.', 403, null);
  end if;

  select * into v_cfg from public.finance_settings where id;
  v_income := v_cfg.default_income_account_id;
  v_cash   := v_cfg.default_cash_account_id;
  if v_income is null or v_cash is null then
    perform public.app_error('FINANCE_ACCOUNTS_NOT_CONFIGURED',
      'Set the default income and cash accounts before running the backfill.', 409, null);
  end if;
  select email into v_email from public.profiles where id = v_actor;

  for r in
    select er.* from public.enrollment_requests er
     where er.status = 'approved' and coalesce(er.amount_paid, 0) > 0
       and not exists (select 1 from public.finance_payment_events pe
                        where pe.idempotency_key = 'enrollment:' || er.id::text || ':collection')
     order by er.reviewed_at nulls last
     limit greatest(1, least(coalesce(p_limit, 5000), 20000))
  loop
    v_candidate := v_candidate + 1;
    if p_dry_run then continue; end if;

    v_key  := 'enrollment:' || r.id::text || ':collection';
    v_date := (coalesce(r.reviewed_at, r.created_at) at time zone coalesce(v_cfg.reporting_timezone,'Asia/Manila'))::date;

    -- The same account the hook would have chosen: the plan's mapped income account
    -- when it is an ACTIVE income account, else the default. A backfilled collection
    -- must land exactly where a live approval of the same request would have.
    select a.id into v_row_income
      from public.enrollment_plans p
      join public.finance_accounts a on a.id = p.finance_income_account_id
                                    and a.active and a.account_type = 'income'
     where p.key = r.plan_key;
    v_row_income := coalesce(v_row_income, v_income);

    insert into public.finance_journal_entries
      (entry_date, entry_kind, memo, source, created_by, created_by_email)
    values (v_date, 'collection',
            coalesce(r.plan_name, r.plan_key) || ' — backfill', 'backfill', v_actor, v_email)
    returning id into v_entry;

    insert into public.finance_journal_lines (entry_id, line_no, account_id, debit, credit) values
      (v_entry, 1, v_cash,       r.amount_paid, 0),
      (v_entry, 2, v_row_income, 0,             r.amount_paid);

    insert into public.finance_payment_events
      (event_kind, direction, occurred_on, amount, journal_entry_id, idempotency_key,
       enrollment_request_id, student_user_id, student_email, plan_key, plan_name,
       method, reference, source, created_by, created_by_email)
    values ('enrollment_collection', 'in', v_date, r.amount_paid, v_entry, v_key,
            r.id, r.user_id, r.email, r.plan_key, r.plan_name, 'unknown',
            r.payment_reference, 'backfill', v_actor, v_email)
    on conflict (idempotency_key) do nothing
    returning id into v_event;

    if v_event is null then
      -- The loop already filtered these out, so this means a concurrent writer.
      -- The orphan entry cannot be deleted (finance_line_guard always raises), so
      -- aborting the run is the only honest option — nothing partial is left
      -- behind, because the whole statement rolls back.
      perform public.app_error('FINANCE_COLLECTION_RACE',
        'A collection for this enrollment was recorded while the backfill was running. '
        'Nothing was written; run it again.', 409, jsonb_build_object('request_id', r.id));
    else
      v_posted := v_posted + 1;
    end if;
  end loop;

  -- ★ The counts go into an AUDIT ROW, not a raise notice: the Management API
  --   discards notices entirely, so the block proves its own postcondition.
  insert into public.finance_audit_events (actor_user_id, actor_email, action, target_kind, detail)
  values (v_actor, v_email, 'backfill_run', 'enrollment_collections',
          jsonb_build_object('dry_run', p_dry_run, 'candidates', v_candidate,
                             'posted', v_posted, 'skipped', v_skipped));

  return jsonb_build_object('dry_run', p_dry_run, 'candidates', v_candidate,
                            'posted', v_posted, 'skipped', v_skipped);
end;
$fn$;
revoke all on function public.finance_backfill_enrollment_collections(boolean, integer) from public, anon, authenticated;
grant execute on function public.finance_backfill_enrollment_collections(boolean, integer) to authenticated;


-- == 21) app_error_catalog() — restated IN FULL ===============================
-- ★ One VALUES list, so a delta is not expressible. This must carry every prior
--   code and be the LAST definition of the function in this file.
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
    ('FINANCE_RECURRING_INVALID',    422, 'A recurring template is missing a field, uses an inactive account, or has a schedule that does not match its cadence.')
  ) as t(code, http, summary);
$cat$;


-- The new tables and every RPC are invisible to PostgREST until the cache reloads.
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-09-09-financial-management.sql', null,
  'financial management (#58): the native replacement for the Google Apps Script finance app. '
  'Adds finance.manage (super_admin only, 32 -> 33 grants) and 12 finance_* tables — chart of '
  'accounts, balanced double-entry journals, payment events, bank imports + reconciliation, '
  'recurring templates, period locks and an append-only audit ledger — plus a nullable '
  'enrollment_plans.finance_income_account_id so each plan posts to its own income account. No '
  'legacy-data import: the Apps Script workbook showed the data shape only. ZERO client write paths: every finance table has exactly one SELECT policy gated on '
  'finance.manage and no write policy at all, so all mutation goes through SECURITY DEFINER '
  'RPCs. Legacy defects are made UNREPRESENTABLE rather than filtered — no accounts_receivable '
  'subtype (so accrual revenue cannot exist), a CHECK forbidding personal spending from being an '
  'expense, and (debit > 0) <> (credit > 0) forbidding single-entry rows. An AFTER UPDATE '
  'trigger on enrollment_requests posts a balanced collection in the approver''s transaction, '
  'idempotency-keyed on the request id, so an Operations Admin causes a finance write they '
  'cannot read. SHIP WITH THE CLIENT: the component calls RPCs that do not exist until this runs.')
on conflict (filename) do nothing;

-- ── AFTER RUNNING ────────────────────────────────────────────────────────────
--
-- 1) The capability exists and only Super Admin holds it:
--
--    select count(*) from public.staff_permissions;                        -> 20
--    select role_key from public.staff_role_permissions
--     where permission_key = 'finance.manage';                             -> super_admin only
--
-- 2) Every finance table is RLS-enabled with exactly ONE policy, and it is SELECT:
--
--    select c.relname, c.relrowsecurity, count(p.policyname), min(p.cmd)
--      from pg_class c
--      left join pg_policies p on p.tablename = c.relname and p.schemaname = 'public'
--     where c.relname like 'finance\_%' and c.relkind = 'r'
--     group by 1, 2;
--      -> relrowsecurity = t, count = 1 and cmd = 'SELECT' for all 12 rows.
--
-- 2b) The retired 5-argument receivables worklist did not survive beside the new one:
--
--    select count(*) from pg_proc where proname = 'finance_receivables_worklist';   -> 1
--
-- 3) authenticated has SELECT and nothing else:
--
--    select has_table_privilege('authenticated','public.finance_journal_entries','INSERT');  -> f
--    select has_table_privilege('authenticated','public.finance_journal_entries','SELECT');  -> t
--
-- 4) The approval trigger exists and kept its WHEN clause:
--
--    select tgname, tgqual is not null as has_when from pg_trigger
--     where tgrelid = 'public.enrollment_requests'::regclass and not tgisinternal;
--      -> finance_enrollment_collection_trg with has_when = t
--
-- 5) Both constraint triggers are DEFERRED (if not, every multi-line entry fails):
--
--    select tgname, tgdeferrable, tginitdeferred from pg_trigger
--     where tgname in ('finance_entry_balanced_trg','finance_entry_has_lines_trg');   -> t, t
--
-- 6) Settings resolve to two ACTIVE system accounts (the runtime proof that the
--    approval hook can post at all):
--
--    select (select active from public.finance_accounts a where a.id = s.default_income_account_id)
--         , (select active from public.finance_accounts a where a.id = s.default_cash_account_id)
--      from public.finance_settings s;                                     -> t, t
--
-- 7) No posted entry is unbalanced — the check that would notice if any of the
--    three balance layers were ever removed:
--
--    select count(*) from (
--      select entry_id from public.finance_journal_lines
--       group by entry_id having sum(debit) <> sum(credit)) t;             -> 0
--
-- 8) The backfill does NOT run as part of this migration, and cannot be run from
--    the SQL Editor either: it is gated on finance.manage, and both of those run
--    with no auth.uid(), so the permission check refuses them. A Super Admin starts
--    it from Financial Management -> Setup (dry run first). Each run records its
--    counts — no row here means it has simply not been run yet:
--
--    select detail from public.finance_audit_events
--     where action = 'backfill_run' order by created_at desc limit 1;
--
-- 9) npm run db:audit -> clean, including the new #58 checks.
