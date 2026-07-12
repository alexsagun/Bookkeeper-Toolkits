# Current-State Product Engineering Audit

Date: 2026-07-09
Repository: Bookkeeper-Toolkits
Auditor: Codex

## 1. Baseline

- Package version: `1.0.0` from `package.json`.
- Git state: clean working tree on `main`, tracking `origin/main`.
- Current commit: `dd58685` (`feat: audit enrollment admin-alert email outcome per request`), committed 2026-07-08 18:22:32 +0100.
- Tracked files: 57.
- Source of truth for the app: `src/BookkeeperPro.jsx`, with infrastructure exceptions in `src/main.jsx`, `src/auth/AuthProvider.jsx`, `src/lib/supabase.js`, `src/index.css`, and pure data chunks under `src/data/`.
- Generated/ignored folders: `node_modules/`, `dist/`, local `.env`, and `build_output.txt` are not source of truth.
- Local `.env`: contains `ANTHROPIC_API_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`; values were not inspected or recorded.

Current product state: **post Stage-1 security/remediation work, pre-live-backend verification**. The app is no longer in the "raw predeploy blocker" state described by the first 2026-07-08 audit; several critical/high items from that report are now implemented in code and migrations. The remaining launch confidence depends on applying/verifying Supabase migrations and testing on a Vercel preview with real environment variables.

## 2. Audit Coverage

Reviewed:

- Project docs: `README.md`, `CLAUDE.md`, auth/course/admin/enrollment setup docs, DB README, existing audits, and Claude skills.
- Runtime/config: `package.json`, `package-lock.json`, Vite, Tailwind, PostCSS, Vercel config, `index.html`.
- App source: `src/main.jsx`, `src/lib/supabase.js`, `src/auth/AuthProvider.jsx`, `src/index.css`, `src/data/*.js`, and the `BookkeeperPro.jsx` component map, navigation, gates, AI calls, storage keys, Supabase calls, and known risky regions.
- Backend/API: `api/anthropic/v1/messages.js`, `api/notify-access.js`, `api/notify-enrollment.js`.
- Database: `db/README.md`, bootstrap schema, dated migrations, policies, storage buckets, functions/RPCs, and run order.
- Deployment artifacts: `dist/` build output, `standalone/index.html`, `.claude/skills/*`, `.env.example`, `.gitignore`.

Verification run:

- `npm.cmd run build`: passed.
- `npm.cmd audit --audit-level=low`: completed after approval.
- `npm.cmd outdated`: completed after approval.
- Vite preview smoke: attempted, but the managed Windows sandbox blocked Vite/esbuild config loading with `Cannot read directory "..": Access is denied.` An escalated preview attempt produced no useful output. Treat local browser smoke as **not completed** in this audit.
- Live Supabase/RLS/storage/realtime/email behavior was **not** tested against a deployed backend.

## 3. Architecture State

The app is a Vite/React 18 single-page app with a deliberate monolithic UI file:

- `src/main.jsx` installs two critical shims:
  - `window.storage` over `localStorage`, namespaced per signed-in user via `window.__setStorageUser(uid)`.
  - a fetch shim rewriting `https://api.anthropic.com/*` to `/api/anthropic/*`.
- `src/auth/AuthProvider.jsx` owns Supabase session state, server-side revoke checks, profile fetch, Google/email auth methods, password recovery, and legacy localStorage migration.
- `src/lib/supabase.js` is the single Supabase client and degrades to placeholders when env vars are missing.
- `src/index.css` is the centralized design-token and dark-mode compatibility layer.
- `src/data/*.js` files are pure static data modules lazy-loaded by `useLazyData`.
- `api/anthropic/v1/messages.js` is the production Anthropic proxy and now requires a Supabase session plus admin/enrolled access before spending tokens.
- `api/notify-access.js` and `api/notify-enrollment.js` are Vercel-only optional Resend email functions.
- Database is Supabase-first: auth/profile approval, course platform, sidebar settings, feature guides, enrollment requests, subscriptions, payment settings, receipt storage, private lesson videos, and notification audit fields.

The project has no test suite, no linter, and no TypeScript. `npm run build` is the only automated local quality gate.

## 4. Product Surface

Current navigation has four user-facing stages:

- Home: Dashboard.
- Training and Skills: Accounting 101, QuickBooks Online Mastery, Industry Accounting, US Tax 101, ProAdvisor Chat, Niche Selector Quiz.
- Job Application: Authentic Branding, Resume Winning Strategy, Book 1-on-1 with Alex, Personalized Coaching With Alex, Job Interview Mastery, Free QB Diagnostic, Painpoints and Solutions, Proposal Generator, Discovery Call Simulator.
- Client Management and Delivery: Engagement Letter, Client Onboarding, Chart of Accounts, Invoice Creator, US CPA AI, Bank Feed AI, Statement to CSV, Email Templates, Accounting Calculators, Monthly Workflow, Month-End Checklist, SOP Generator, Sales Tax, Budgeting Tool, Forecasting Tool, Year-End Checklist, 1099 Prep.

Admin-only surfaces:

- Access Requests.
- Enrollments.
- Sidebar customization and global label overrides.
- Course/catalog authoring controls.
- Feature guide editing for Mock Interview Simulator.

Notable subflows:

- Job Interview Mastery is a subtab hub with Interview Strategy catalog, Mock Interview guide/video gate, common Q&A, accounting Q&A, body language, JD question generator, and salary negotiation.
- Course platform is Supabase-backed, supports multi-course catalogs by slug prefix, course duplication, private lesson videos, covers, module/lesson editing, progress, completions, and PDF certificates.
- Enrollment gate is manual-payment based, with receipt upload, admin review, subscription duration/expiry, renewal, membership dashboard panel, and email/audit notification support.

Unreachable/dead or semi-dead code:

- `ClientHealthScore`, `MonthlyReviewCall`, `PriceRaiseToolkit`, `UpsellPathGenerator`, `DifficultClientPlaybook`, `TimeTrackerByClient`, `CapacityPlanner`, `PaymentTracker`, `PHUSMoneyGuide`, and `PersonalFinanceTracker` exist in `BookkeeperPro.jsx` and some have legacy storage keys, but they are not currently wired into `TAB_ROUTES`, `DEFAULT_STAGES`, or `renderToolContent`.
- Docs still mention a "client-portal demo", but current source only has a commented dashboard tile and no reachable `ClientPortalDemo` implementation. This is documentation drift.

## 5. Workflow and Gate State

Root gate order is:

1. Auth loading splash.
2. Password recovery screen.
3. Auth screen for signed-out users.
4. Profile readiness guard.
5. Rejected-account hard stop.
6. Enrollment/payment/subscription gate.
7. Legacy pending-approval gate when enrollment is off or not configured.
8. App shell.

This means unpaid non-admin users see the enrollment paywall instead of the older pending-approval screen. Rejected users cannot bypass rejection by paying. Admins bypass gates and get admin controls.

Storage state:

- Per-user namespacing is in place.
- Sidebar persistence race from the older audit is fixed: sidebar loading is gated on `user?.id`.
- `LEGACY_KEYS` includes current persistent keys for sidebar, theme, currency, trackers, budgeting, forecasting, enrollment sound alert, and currently-unreachable growth tools.

## 6. Backend and Database State

Fresh install path:

- `db/000_full_database_bootstrap.sql` is the final-state schema for a new Supabase project.

Existing install path:

- `db/README.md` defines a 16-step dated migration order.
- Important dependencies: feature guides before user approval, user approval before enrollment, enrollment before subscription lifecycle, and the July 8 hardening migrations after enrollment.

Current schema capabilities include:

- `profiles` with admin, approval, paid/plan, and profile fields.
- `courses`, `course_modules`, `course_lessons`, `lesson_progress`, `course_completions`.
- `sidebar_settings`.
- `feature_guides` and `feature_video_completions`.
- `enrollment_plans`, `enrollment_requests`, `subscriptions`, `payment_settings`.
- Private `enrollment-receipts` bucket.
- Public `course-media` bucket for covers and feature guide videos.
- Private `course-videos` bucket for paid lesson videos.
- SECURITY DEFINER helpers/RPCs: `is_admin()`, `is_approved()`, date-aware `is_enrolled()`, `approve_subscription()`, `expire_overdue_subscriptions()`, `record_enrollment_notification()`.

Important caveat: the repository contains migrations, but this audit did not prove the live Supabase project has all migrations applied.

## 7. Stage-1 Remediation Status

Items from the 2026-07-08 predeploy audit that are now implemented:

- AI proxy authentication and cost gating: implemented in `api/anthropic/v1/messages.js`.
- Client `callClaude()` attaches Supabase bearer token.
- Private `course-videos` bucket migration exists; playback uses signed URLs with legacy public fallback.
- `removeMediaIfUnreferenced()` now checks Supabase query errors and keeps files on reference-check failure.
- BankFeed AI merge now precomputes unmatched indices before mutation.
- Enrollment receipt upload is keyboard-focusable and supports Enter/Space activation.
- Sidebar per-user persistence race is fixed by loading after `user?.id`.
- Receipt owner self-delete is removed by `db/2026-07-08-receipt-integrity.sql`.
- Enrollment notification outcome is auditable via `notify_status`, `notified_at`, and `notify_detail`.
- QB Diagnostic spreadsheet parsing has a 5 MB guard.
- `build_output.txt` is now ignored.

Remaining caveats:

- Old videos already uploaded to public `course-media/lessons/*` remain public until moved/re-uploaded into `course-videos`.
- `payment_settings_read` remains readable to authenticated users. The Stage-1 design intentionally left it because payment instructions must be visible to not-yet-paid users.
- No rate limit exists on `notify-enrollment` submitted action or Anthropic proxy. The proxy is membership-gated, but not rate-limited.

## 8. UI/UX State

Strengths:

- Product IA is clearer than a generic tool dump: it follows learner journey, job application, then delivery.
- Sidebar supports grouped sections, admin label overrides, drag/reorder, collapse, rail mode, mobile drawer, deep links, and keep-alive tab state.
- Dark/light/system theme exists with pre-paint boot to reduce flicker.
- Most major workflows have meaningful empty/error states and admin setup hints.
- Course, enrollment, and membership flows are much more complete than a static toolkit.

Weak spots:

- Main app remains a very large single component, which slows deep reasoning and makes accidental regressions more likely.
- Several existing components are unreachable, creating bundle/maintenance weight and product ambiguity.
- Native dialogs remain (`alert`, `confirm`, `prompt`) in download/course/sidebar/catalog/guide/budgeting flows.
- A11y is improved on receipt upload, but broader label, dialog semantics, icon-button labels, and keyboard audit remains incomplete.
- Some UI still uses hand-rolled light rgba styles that may not theme cleanly in dark mode.
- Dashboard still shows "42 Pro Tools", while actual reachable top-level nav items are fewer and subtools/unreachable components make the number ambiguous.
- Dashboard roadmap uses `md:grid-cols-7` for three stages, which leaves odd empty space.
- Browser QA across mobile/desktop/light/dark was not completed in this audit.

## 9. Build, Performance, and Dependencies

Build:

- `npm.cmd run build` passed.
- Current app chunk: `assets/index-BhfIMvIV.js` at about 717.95 kB raw / 180.93 kB gzip.
- Vite still warns that the main chunk is over 500 kB.
- Heavy libraries are split/lazy: `xlsx`, `jspdf`, `html2canvas`, Supabase, icons, React vendor, and data chunks.

Dependency audit:

- `xlsx` has high/critical advisories and no npm fix. Current mitigation is file-size guarding; a real fix likely requires replacing/sourcing SheetJS differently.
- `jspdf@2.5.2` pulls vulnerable `dompurify`; `npm audit fix --force` would jump to `jspdf@4.2.1` and is breaking.
- `vite@5.4.21` pulls an `esbuild` dev-server advisory; audit suggests breaking upgrade to Vite 8.

Outdated packages:

- Patch/minor drift: `@supabase/supabase-js` 2.108.1 to 2.110.2, `autoprefixer` 10.5.0 to 10.5.2, `postcss` 8.5.15 to 8.5.16.
- Major drift: React 18 to 19, Vite 5 to 8, Tailwind 3 to 4, Lucide 0.460 to 1.23, React plugin 4 to 6, jspdf 2 to 4.

Recommendation: do not bulk-upgrade. Handle patch updates first, then isolate `xlsx`, `jspdf`, and Vite/esbuild in separate compatibility tasks.

## 10. Deployment State

Vercel readiness:

- `vercel.json` rewrites all non-API routes to `/`, supporting pretty-path SPA routing.
- `/api/*` is excluded from SPA rewrite.
- Production Anthropic proxy lives at exact path `api/anthropic/v1/messages.js`.
- Notification functions are Vercel-only; local Vite dev does not run them.

Required Vercel env:

- `ANTHROPIC_API_KEY`.
- `VITE_SUPABASE_URL`.
- `VITE_SUPABASE_ANON_KEY`.

Optional Vercel env:

- `RESEND_API_KEY`.
- `RESEND_FROM`.
- `NOTIFY_ADMIN_EMAIL`.
- `APP_URL`.

Live deployment still needs:

- Confirm Supabase migrations are applied in the documented order.
- Confirm private storage buckets and policies exist.
- Confirm Vercel env vars are set for Production and Preview before build.
- Run preview deploy smoke for auth, AI, enrollment, admin email test, signed lesson video playback, and deep links.

## 11. Standalone Build State

`standalone/index.html` is a tracked legacy/alternate single-file build for Google Apps Script or local standalone use.

It is not aligned with the current Vercel app:

- Uses Tailwind CDN.
- Stores API key in browser localStorage in standalone mode.
- Directly adds Anthropic browser headers in standalone mode.
- Contains older model IDs and older tool/navigation structure.
- Contains older BankFeed merge logic in the minified bundle.
- Does not include current Supabase auth/enrollment/course-video security architecture.

Recommendation: either clearly label `standalone/` as legacy/alternate and not production-equivalent, or regenerate it from current source before offering it as an official deployment path.

## 12. Documentation State

Strong docs:

- `CLAUDE.md` is unusually comprehensive and should remain the main developer source of truth.
- `.claude/skills/bookkeeper-conventions` and `.claude/skills/add-bookkeeper-tool` encode useful implementation guardrails.
- Setup docs cover Supabase, Google auth, SMTP/Resend, course platform, admin approval, enrollment, subscriptions, and troubleshooting.
- DB README gives a clear fresh vs existing install path.

Drift/issues:

- Existing `docs/audits/2026-07-08-predeploy-audit.md` is now historical, not current. It says blockers remain that current code has fixed.
- README/CLAUDE mention a client-portal demo that is not currently reachable.
- CLAUDE line anchors are approximate and should be refreshed after this remediation wave.
- Standalone docs/status should be clarified.

## 13. Recommended Next Work

Before production launch:

1. Apply/verify Supabase migrations through `2026-07-08-enrollment-notify-status.sql`.
2. Verify private buckets: `enrollment-receipts` private and `course-videos` private.
3. Move any old `course-media/lessons/*` videos into `course-videos`.
4. Deploy a Vercel Preview with all required env vars.
5. Smoke test auth, profile gate, enrollment paywall, admin approval, admin enrollment approve/reject, receipt preview, AI proxy signed-in/enrolled behavior, signed lesson video playback, course admin upload, and deep-link refresh.
6. Run browser QA for mobile/desktop and light/dark.
7. Decide what to do with unreachable growth tools: wire them intentionally, delete them, or mark them as planned hidden backlog.
8. Update README/CLAUDE to remove or explain the client-portal demo drift and refresh architecture anchors.

Next hardening backlog:

- Replace native dialogs with app-native modals.
- Add focused a11y pass for form labels, upload zones, modals, icon buttons, and keyboard flows.
- Add a minimal test strategy, even if only smoke tests around pure helpers and critical gate logic.
- Resolve dependency advisories deliberately: `xlsx`, `jspdf/dompurify`, and Vite/esbuild.
- Reduce monolith risk by extracting only where it pays off: shared helpers first, then the largest admin/course/enrollment regions if a refactor is approved.
- Add rate limiting for token/email spend.
- Reconcile Dashboard stats with actual reachable product surface.

## 14. Future Claude Prompting Protocol

For future implementation prompts, give Claude:

- The current baseline: branch/commit, package version, and this audit file.
- The exact product goal and user role affected.
- Required files to read first: `CLAUDE.md`, `.claude/skills/bookkeeper-conventions/SKILL.md`, `.claude/skills/add-bookkeeper-tool/SKILL.md` if adding a tool, plus any relevant setup doc/migration.
- The architecture constraints: single-file default, no TypeScript/lint/config changes unless approved, use `callClaude()`, use `window.storage` with plain keys, update `LEGACY_KEYS` for new persisted keys, update `TAB_ROUTES`/`DEFAULT_STAGES`/`renderToolContent` together.
- Acceptance criteria: build passes, light/dark QA, mobile/desktop spot check, Supabase/RLS behavior if backend touched, and docs updated when architecture/workflows change.

Example prompt skeleton:

```text
You are working in Bookkeeper-Toolkits at commit dd58685, package version 1.0.0.
Read CLAUDE.md, docs/audits/2026-07-09-current-state-audit.md, and the relevant .claude skill before editing.

Goal:
<describe the user/business outcome>

User workflow:
<who starts where, what they click, what state changes, what success looks like>

Files likely involved:
<list source/docs/db/api files>

Constraints:
- Keep the single-file architecture unless explicitly refactoring.
- Use existing C/GLASS/SHEEN tokens and dark-mode-safe CSS variables.
- Use callClaude() for AI; never expose keys.
- Use window.storage for persisted local data and add new keys to LEGACY_KEYS.
- If adding a top-level tool, update TAB_ROUTES, DEFAULT_STAGES, renderToolContent, and optionally Dashboard tiles.
- If touching Supabase, include idempotent SQL and RLS reasoning.

Acceptance:
- npm run build passes.
- Verify the affected workflow manually.
- Check light and dark themes.
- Update CLAUDE.md/setup docs/skills if the workflow or architecture changes.

Return:
- Implementation summary.
- Files changed.
- Verification performed.
- Any live deployment steps the developer/admin must run.
```
