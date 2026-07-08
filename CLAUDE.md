# CLAUDE.md

Guidance for Claude Code (and any developer) working in this repository. Read this first.

## What this is

**Ultimate Remote Bookkeeper Toolkits** ("Get Hired With Alex") is a single-page web app for
aspiring and working **remote bookkeepers serving US clients**. It bundles ~60 fully-functional
tools across three career stages:

1. **Training & Skills** — Accounting 101 course, Industry Accounting playbooks, US Tax 101, ProAdvisor chat, client-portal demo.
2. **Job Application** — authentic branding, resume/LinkedIn optimizers, interview prep, mock-interview & discovery-call simulators, QuickBooks diagnostic, pain-points & proposal generators.
3. **Client Management & Delivery** — engagement letters, onboarding, Chart of Accounts generator, invoice creator, bank-feed AI, statement→CSV converter, email templates, accounting calculators, monthly/year-end checklists, SOP generator, sales tax, budgeting & forecasting, plus growth tools (pricing, upsell, capacity, payment tracking).

Many tools are **AI-assisted** (call Claude); the rest (calculators, checklists, Chart of Accounts,
templates) run fully offline with no API key.

## Tech stack

- **React 18.3** + **Vite 5.4** (`@vitejs/plugin-react`).
- **JavaScript + JSX only** — there is **no TypeScript, no ESLint/Prettier**. Do not introduce a type system, a linter, or new build config without asking first.
- **Tailwind CSS compiled via PostCSS** — config in [tailwind.config.js](tailwind.config.js) +
  [postcss.config.js](postcss.config.js); the utility layers are imported once from
  [src/index.css](src/index.css) via [src/main.jsx](src/main.jsx). The JIT scans `index.html` +
  `src/**/*.{js,jsx}`. There is **no safelist** because colors/fonts come from inline `style` + the `C`
  design tokens (no dynamically-built class names like `` `bg-${x}` ``) — if you ever add one, safelist
  it or it will be purged. `darkMode: ['selector', '[data-theme="dark"]']` — existing neutral utilities
  (`bg-white`, `text-slate-*`, …) are dark-adapted **centrally** by the compat layer in `index.css`
  (see Styling conventions), so `dark:` variants are only for new code. (The `standalone/` Google Apps
  Script build still uses the Tailwind **CDN**, since it's a single self-contained file.)
- **Fonts load once globally** from `index.html` (`<link>` + preconnects) — never add a Google-Fonts
  `@import` inside a component `<style>` block (eight of those were removed in the theme pass).
- **Lucide React** for icons, **XLSX** (spreadsheet parse/generate) — XLSX is **lazy-loaded** via
  dynamic `import()` so it stays out of the main bundle.
- **Anthropic Claude API** for AI features, via a key-hiding proxy (see below).
- **Supabase** (`@supabase/supabase-js`) for **user authentication** (email/password signup & login).
  See the "Authentication" section below. This is Phase 1; a paid-subscriber gate is the planned Phase 2.

## Commands

Environment is **Windows / PowerShell**.

```powershell
npm install        # install dependencies
npm run dev        # Vite dev server + local Anthropic proxy (vite.config.js)
npm run build      # production build -> dist/
npm run preview    # preview the production build locally
```

There is **no test suite and no linter** — verify changes by running `npm run dev` and exercising
the affected tool in the browser.

## Architecture map

The app is intentionally a **single-file monolith**. Keep it that way unless a refactor is
explicitly requested (see Roadmap, Phase 3).

### [src/main.jsx](src/main.jsx) — entry + two critical shims (do not remove)

Mounts `<BookkeeperProToolkit />` (wrapped in `<AuthProvider>` — see Authentication) and installs
two shims that the tool code depends on:

1. **`window.storage`** → wraps `localStorage` with an async `get`/`set` API. The app was authored
   in Claude artifacts and calls `window.storage` directly for all persistence. **Now per-user
   namespaced:** [AuthProvider](src/auth/AuthProvider.jsx) calls `window.__setStorageUser(uid)` on
   every session change, so each get/set transparently reads/writes `u:<uid>:<key>` — isolating each
   account's data with **zero changes to the ~60 tools** (they still pass plain keys). Supabase's own
   `sb-*` session key is written directly by supabase-js and is **not** namespaced.
2. **fetch shim** → rewrites any request to `https://api.anthropic.com` → `/api/anthropic`. Tool
   code calls the *real* Anthropic URL; this shim redirects it to the proxy so the API key stays
   server-side. (It only matches `api.anthropic.com`, so Supabase calls to `*.supabase.co` pass
   through untouched.) **Removing either shim breaks persistence or AI calls.**

A third do-not-remove piece lives in [index.html](index.html): a tiny inline **theme boot script**
that reads the bare `localStorage['ui:theme']` pref (falling back to `prefers-color-scheme`) and sets
`data-theme` on `<html>` **before first paint** — this is what makes dark mode flicker-free. The
`useTheme` hook in BookkeeperPro.jsx keeps that key in sync (see Styling conventions → Theme).

### [src/lib/supabase.js](src/lib/supabase.js) + [src/auth/AuthProvider.jsx](src/auth/AuthProvider.jsx) — auth infra

The sanctioned exceptions to the single-file rule (same spirit as the `main.jsx` shims):
- `lib/supabase.js` — the single Supabase client, built from `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` (public anon key; safe in the bundle — RLS is the real boundary).
- `auth/AuthProvider.jsx` — the `AuthProvider` + `useAuth()` hook (see Authentication).
- `src/index.css` — the **global theme-token layer** (all CSS custom properties for light + dark,
  the shared `.gh-app-bg`/glass/button/input classes, and the Tailwind dark compat layer). See
  Styling conventions.
- `src/data/*.js` — **pure DATA modules only** (question banks, playbooks, templates), lazy-loaded
  per tab via the `useLazyData` hook in BookkeeperPro.jsx so they stay out of the main bundle.
  Components never move here — data only.

### Course platform (Supabase-backed) — `CourseProgram` engine + `CourseCatalog`

The course platform is the **first in-app tool to read/write Supabase directly**
(`import { supabase } from './lib/supabase'`) instead of `window.storage`. Course content + per-user
progress live in Supabase so they reach **all** students across devices. (The `MockInterviewSimulator`
guided page is the **second** such tool — it reads/writes the admin-curated `feature_guides` row
directly; see the "Feature guides" subsection in [COURSE_SETUP.md](COURSE_SETUP.md).) Two pieces:

- **`CourseProgram`** — the generic **single-course engine** (learner player, admin builder, lesson
  editor, completion + branded PDF certificate). Props: `slug`, **`courseId`** (load by id — catalog
  mode), **`onBack`** (show a "← All courses" bar + compact in-body header instead of the page
  `SectionHead`), `eyebrow`, `courseTitle`, `defaultSubtitle`, `certFileName`, `comingSoonText`,
  `embedded`. `load()` looks up by `courseId` when given, else by `slug`. The header is rendered when
  `showHead = !embedded && !onBack`.
- **`CourseCatalog`** — a Thinkific-style **multi-course catalog**, **prefix-parameterized** so the
  same component powers more than one catalog. Admins manage each course from a per-card **3-dot (⋮)
  action menu** (Edit / **Duplicate** / Set cover / Move up·down / Delete; admin-only, closes on
  outside-click or Escape); students browse published course cards and open one to learn (it hands off
  to `<CourseProgram courseId … onBack … initialNotice? …/>`, keyed so each course gets clean state).
  Props (all default to the QBO catalog, so `<CourseCatalog />` is unchanged): **`prefix`** (the
  `courses.slug` namespace, e.g. `'qbo-'` or `'interview-'`; drives the `ilike '<prefix>%'` filter, the
  auto-slug, and isolation between catalogs), **`embedded`** (drop the page `SectionHead` when nested
  in a subtab), and copy props `eyebrow` / `title` / `adminDesc` / `studentDesc` / `newCourseTitle` /
  `comingSoonDesc`. Each prefix is its own namespace, so catalogs never see each other's courses.
  Catalogs reuse the `courses.slug` prefix + the `cover_path` / `position` / **`course_date`** /
  **`source_course_id`** columns (the last added for duplication — see COURSE_SETUP.md). **`course_date`**
  is a date-only (`YYYY-MM-DD`) editable cohort/run date that **defaults to today** on create/duplicate;
  the card renders an **auto-derived "Month Year" badge** from it via the `cohortLabel()` helper. The
  older `month` text column is retained **only as a display fallback** for legacy rows with no
  `course_date` (no backfill is run).

Wrappers:
- `QBOMastery()` — the `qbomastery` tab (Training & Skills) → **`<CourseCatalog />`** (defaults →
  `qbo-*` QuickBooks course library).
- `InterviewStrategyCatalog({ embedded })` — the `winstrat` **subtab** inside `InterviewPrep` →
  **`<CourseCatalog prefix="interview-" embedded …/>`** (the Interview Winning Strategy course
  library; cards are `interview-*` courses, e.g. the legacy `interview-winning-strategy`).
- `ResumeStrategy()` — the `resumestrategy` tab (Job Application → Profile Optimization) →
  **`<CourseCatalog prefix="resume-" …/>`** (a top-level multi-course catalog, like `QBOMastery`; the
  Resume Winning Strategy course library — cards are `resume-*` courses, e.g. the legacy
  `resume-strategy`, which matches `resume-%` and migrates in automatically).

To add a course to either catalog: an admin clicks **"New course"** (auto-generates a unique
`<prefix>…` slug, no SQL). To add a *new catalog* (a new course category), render another
`<CourseCatalog prefix="…" …/>` with its own prefix + copy and wire the nav sync points. To add a
*single-course* tab, write a `CourseProgram` wrapper with its own `slug` + labels.

- **Tables:** `courses` (incl. `course_date` editable cohort date + legacy `month` label fallback + `source_course_id` lineage for duplicates) →
  `course_modules` → `course_lessons` (`type` video/text, link or uploaded video), `lesson_progress`
  (per-user completion), `course_completions` (stamps the certificate date). All keyed by `course_id`,
  so one schema serves every course.
- **Admin gate:** `profiles.is_admin` + a `public.is_admin()` SQL helper. RLS lets any signed-in user
  read **published** content but only admins write course content (UI also hides the builder/catalog
  controls). Progress rows are row-locked to the owning user.
- **In-app course creation:** `CourseCatalog.createCourse()` (admin) inserts a `<prefix>-*` row and
  drops into its builder — no SQL seed. (The single-course wrappers also keep a
  `CourseProgram.createCourse()` empty-state button for their fixed slug.)
- **In-app duplication:** `CourseCatalog.duplicateCourse()` (⋮ → Duplicate) clones a course's row +
  modules + lessons into a new **draft** "Copy of …" (3 inserts via client-generated module UUIDs;
  rollback-deletes the new course if any child insert fails), **reusing** the original's
  `video_url`/`storage_path`/`cover_path` by reference (copy-on-write — no files copied) and setting
  `source_course_id`. The duplicate's `course_date` **defaults to today** (it is *not* copied from the
  source — so a new monthly re-run never inherits last month's date). Per-user
  `lesson_progress`/`course_completions` are **not** copied. It then opens the copy in the builder with
  a one-time success banner (`CourseProgram`'s `initialNotice` prop).
- **In-app delete = data cleanup (reference-aware):** `CourseCatalog.deleteCourse()` deletes the row
  (FK cascade clears modules/lessons/progress/completions) then calls the module-level
  `removeMediaIfUnreferenced()` to purge the course's storage files **only when no other course still
  references them** (so deleting one monthly edition never breaks a duplicate that reused its videos).
  The same helper guards `uploadCover()` and `CourseProgram`'s `saveLesson()`/`deleteLesson()` (always
  called *after* the row update/delete). This is how dummy/test content is removed — admins delete it
  in-app.
- **Storage (two buckets):** PAID lesson **videos** live in the **private** `course-videos` bucket
  (`lessons/{course.id}/…`), served via short-lived **signed URLs** gated by `is_enrolled()` RLS —
  because a *public* Supabase bucket serves every object publicly and bypasses RLS on read, so a
  public bucket can't protect paid content. Course **covers** (`covers/{course.id}/…`) and
  feature-guide videos stay in the **public** `course-media` bucket (they're meant to be visible
  while browsing). Playback uses the `SignedLessonVideo` component (private signed URL, with a
  legacy `course-media` public-URL fallback for videos uploaded before the split). Write/delete on
  both buckets is admin-only. Videos can also be YouTube/Vimeo/MP4 **links**. Uploads are guarded
  client-side (video ≤ 50 MB; cover image ≤ 5 MB). See `db/2026-07-08-course-videos-private.sql`.
- **Certificate:** rendered from design tokens + `LOGO_DATA_URI`, downloaded as PDF via **lazy-loaded**
  `jspdf` + `html2canvas` (dynamic `import()` only on download — kept out of the main bundle); the PDF
  filename comes from the `certFileName` prop.
- **Setup:** all SQL + bucket steps live in **[COURSE_SETUP.md](COURSE_SETUP.md)**. Progress is in
  Supabase, **not** `window.storage` — do **not** add course keys to `LEGACY_KEYS`.

### [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx) — the entire app (~19.6k lines)

> Note: lines are long; prefer `Grep` over reading the whole file. Line numbers below are anchors,
> approximate as the file evolves.

| Region | Lines (approx) | Contents |
|---|---|---|
| Shared AI helper | 16–62 | `callClaude()` (L27) — the single entry point every AI tool uses (see AI/proxy pattern) |
| Imports + domain data | 1–620 | `COA_BASE` (L68), `COA_INDUSTRY` (L121), `INDUSTRY_NOTES` (L341), `VENDOR_PATTERNS` (L367), `COURSE_MODULES` (L463), checklists, `TIPS` (L603) |
| Design system + helpers | 620–770 | colors `C` (L624), `SHEEN` (L654), `GLASS` (L657), fonts `fontDisplay` (L671) / `fontMono` (L673), `downloadFile()` (L679), `useCurrency()` (L712), `CurrencyToggle()` (L748) |
| Root component | 774–~1700 | `BookkeeperProToolkit` (L774): `tab` state, sidebar `DEFAULT_STAGES` config (~L779–864), drag-drop reorder, rename/persist to `window.storage` (`sidebar:*` keys, ~L940–988), and the **keep-alive render** (`renderTabContent(tabId)` switch + `visitedTabs` map). URL-routing helpers (`TAB_ROUTES`, `readAppRoute`, `writeAppRoute`, `tabHref`, `shouldHandleInAppClick`) sit at the **top of the file** (module scope). |
| Tool components | ~1740–end | ~60 self-contained functional components |

**Notable tools → approximate line:** `Dashboard` 1749, `CoaGenerator` 2017, `Course` 2120,
`CourseProgram` ~2782 (single-course Supabase video engine — builder + PDF certificate),
`CourseCatalog` ~3630 (prefix-parameterized multi-course catalog) + the `QBOMastery` (`qbo-`) /
`InterviewStrategyCatalog` (`interview-`, the `winstrat` subtab) / `ResumeStrategy` (`resume-`) wrappers right after it,
`BankFeed` 2214, `StatementConverter` 2411, `ProChat` 2764,
`AuthenticBranding` 4944, `ProposalGenerator` 5379, `EngagementLetter` 5658, `EmailTemplates` 6304,
`PainPointsGenerator` 6629, `ClientPortalDemo` 6987, `IndustryAccounting` 7661, `USTax101` 7962,
`MonthlyWorkflow` 8135, `MonthEndChecklist` 8336, `InvoiceCreator` 8618, `CoachAlexChat` 9025,
`CPAAIChat` 9178, `AccountingCalculators` 10181, `NicheSelectorQuiz` 10328, `CertificationTracker` 10583,
`LinkedInOptimizer` 10732, `MockInterviewSimulator` (a **guided-video + external-link page** —
admin-uploaded explainer video + a "Open Mock Interview Simulator" button to the external
`https://app.sesame.com/`; Supabase-backed via the `feature_guides` table — **not** the old internal
AI simulator. The CTA is **gated behind watching the guide video** — grey/disabled until the video ends
[native `<video>` / YouTube IFrame API / Vimeo SDK via the `GuideVideoPlayer` child], then blue; per-user
completion persists in `feature_video_completions` and re-locks when the admin replaces the video. It
takes an **`embedded`** prop and now renders as the **2nd sub-tab inside `InterviewPrep`** (Job Interview
Mastery), not a standalone sidebar item; when `embedded` it drops its own `SectionHead`. The legacy
`mockinterview` tab id is kept only as a defensive render-switch redirect → `<InterviewPrep initialSub="mock" />`),
`DiscoveryCallSimulator` 11164,
`SOPGenerator` 11471, `ClientHealthScore` 12136, `CapacityPlanner` 13358, `PaymentTracker` 13542,
`QBDiagnostic` 14293, `BudgetingTool` 15483, `ForecastingTool` 15958.

### Navigation model

A single `tab` string in the root selects which tool renders, and navigation is **URL-routed +
keep-alive** (see below). Four pieces must stay in sync when adding/removing a tool:

1. **Sidebar config** (`DEFAULT_STAGES` array): `{ id, number, label, groups: [{ key, label, tabIds }], tabs: [{ id, label, icon }] }`. Each group carries a stable `key` (label-independent — see below).
2. **`renderToolContent(tabId, handlers)`** — a `switch (tabId)` at **module scope** (just above the root component) that returns each tool's element; `handlers` carries the few props tools need (`goto`, the two admin badge refreshers, `interviewSub`). It is rendered through the memoized **`TabPanel`** (see keep-alive below). This replaced the old in-root `renderTabContent` closure and, before that, the `{tab === 'id' && <Cmp/>}` chain.
3. **`TAB_ROUTES`** (module scope, top of file) — maps each tab id to a stable URL path (e.g. `qbomastery → /courses/quickbooks-online-mastery`). Powers deep-linking, refresh, and "open in new tab"; `VALID_APP_TABS` is derived from it.
4. **Dashboard roadmap tiles**: optional `{ id, label, desc, icon, color }` entries.

**Navigation is URL-routed and state-preserving:**
- `readAppRoute()` / `writeAppRoute()` / `tabHref()` (module scope) sync the active tab — and a few
  inner states (`?sub=` for `InterviewPrep`, `?course=<id>` for a catalog) — to the URL via the
  History API. `vercel.json` rewrites all non-`/api` paths to `/`, so pretty-path deep links never
  404. The root restores the tab from the URL **after** the auth gate, persists the last tab to
  `window.storage` (`nav:lastTab`), and handles Back/Forward via a `popstate` listener.
- **Sidebar items are real `<a href={tabHref(id)}>` links.** Plain left-click navigates in-app
  (`shouldHandleInAppClick(e)` then `preventDefault` + `setTab`); Ctrl/Cmd/middle-click opens the
  section in a new browser tab natively; a hover `ExternalLink` icon opens it in a new tab explicitly.
  In edit/Customize mode the item falls back to a rename `<button>` (so drag-reorder/rename are
  unchanged). Auth still gates a new tab — it shows `AuthScreen`, then restores `?...` after login.
- **Keep-alive mounting (memoized):** the root renders one **`TabPanel`** per *visited* tab
  (`Array.from(visitedTabs).map(tabId => <TabPanel key={tabId} tabId={tabId} active={tabId===tab} …/>)`),
  so a tool mounts on first visit and then **stays mounted** (hidden via the `hidden` attribute) — its
  local state, scroll, and in-flight work survive tab switches, and Supabase-backed tools
  (`CourseProgram`/`CourseCatalog`) don't refetch on return. `TabPanel` is `React.memo`'d and all its
  props are referentially stable (`setTab`/`rememberScroll` are `useCallback([])`, the badge refreshers
  `useCallback([isAdmin])`), so **hidden panels skip every root re-render** — only the active tab
  re-renders, and a tab switch reconciles exactly two panels. Don't pass a TabPanel a prop that changes
  identity per render or you silently re-enable app-wide re-renders. `visitedTabs` is deliberately
  **never pruned** (unmounting a hidden tab would kill in-flight AI work — accepted memory trade-off).
  Per-tab scroll is saved/restored via `sessionStorage` (`nav:scroll:<tab>`).

**Sidebar customization is split by concern:**
- **Labels are global + admin-controlled** via the Supabase `sidebar_settings` table (admin-write,
  authenticated-read RLS — mirrors the `courses` pattern; SQL in COURSE_SETUP.md +
  `db/2026-06-18-sidebar-settings.sql`). The **Customize** button is gated by `profile.is_admin`;
  an admin renames stage headers, tab items, **and** group sub-headers, edits stage locally in
  `draftLabels` (Enter confirms a field), then **Done** upserts the changes and refetches. Every
  user reads these rows, so renames show app-wide and survive refresh / logout-login / redeploy.
  Labels are stored against a **stable `item_key`** (`stage:<id>` / `tab:<id>` /
  `group:<stageId>:<groupKey>`) — never the visible label — so renaming never touches routes,
  module ids, or course filtering. Effective label = `draftLabels[k] ?? labelByKey[k] ??
  defaultLabelByKey[k]`; missing table → falls back to code defaults (never crashes).
- **Order + collapse/expanded-groups stay per-user** in `window.storage` under `sidebar:*` keys
  (unchanged). `expandedGroups` keys off the group `key`, not its label, so collapse-state survives
  a rename. Do **not** add a label key to `LEGACY_KEYS` — labels now live in Supabase.

## Authentication (Supabase — Phase 1)

The whole app sits behind a **Supabase email/password auth gate**. Anonymous visitors see a
full-screen login/signup screen; only signed-in users reach the toolkit.

- **Provider/hook:** [src/auth/AuthProvider.jsx](src/auth/AuthProvider.jsx) wraps the app in
  [main.jsx](src/main.jsx). Any component reads auth via `const { session, user, profile, loading,
  profileReady, configured, signUp, signIn, signOut, resetPassword, refreshProfile } = useAuth()`.
  `profile` is the row from the Supabase `profiles` table and carries `is_paid` / `plan` (used by the
  planned Phase-2 paywall), `is_admin` (course-authoring gate — see the Course platform section), and
  `approval_status` / `rejection_reason` (the temporary admin-approval gate — see below). `profileReady`
  is true once the first profile fetch for the current user has settled (the gate waits on it so a
  pending user never flashes the dashboard); `refreshProfile()` re-reads the row (used by the Pending
  screen's poll). `profile` is fetched with an **explicit column list** (`PROFILE_SELECT` =
  `id,email,full_name,avatar_url,is_paid,plan,is_admin,approval_status,rejection_reason`), with a
  **3-tier fallback** (`fetchProfileRow`) that narrows the columns on a missing-column error — so a
  not-yet-migrated `profiles` table degrades gracefully (and never loses `is_admin` just because the
  approval columns are absent). When you add a `profiles` column the client needs, add it to
  `PROFILE_SELECT` in `AuthProvider.jsx`.
- **The gate** lives in `BookkeeperProToolkit` just before its root `return`: `if (loading) return
  <AuthSplash/>; if (recovery) return <UpdatePasswordScreen/>; if (!user) return <AuthScreen/>;` then
  `if (!profileReady) return <AuthSplash/>;` and a **3-step gate**: ① old-flow ban —
  `approval_status==='rejected'` → `<RejectedScreen/>` (outranks the paywall; a ban can't be paid
  around); ② the **enrollment/payment gate** (see the Enrollment bullet below) — for unpaid
  non-admins it renders `<EnrollmentPaywall/>` / `<EnrollmentPendingScreen/>` and **subsumes** the
  pending-approval screen; ③ the legacy admin-approval gate — `approval_status==='pending'` →
  `<PendingApprovalScreen/>` (active only when enrollment is off or not migrated). `AuthScreen`
  (defined just above the root component) is the login/signup/reset UI, built from the design
  tokens (`C`, `SHEEN`, `GLASS`, `fontDisplay`, `LOGO_DATA_URI`).
- **Admin-approval gate (temporary, Phase-1.5):** new email/Google signups default to
  `approval_status='pending'` and are held on `PendingApprovalScreen` until an admin approves them in
  the **Access Requests** admin tab (`accessrequests` route; admin-only sidebar entry + pending-count
  badge; component `AccessRequests`). Approve/reject writes `profiles` directly (RLS:
  `profiles_admin_select` / `profiles_admin_update` — users can't self-approve) and emails the user via
  the **env-gated** serverless fn `api/notify-access.js` (Resend; non-fatal if `RESEND_API_KEY` /
  `RESEND_FROM` unset). Backend defense-in-depth: `public.is_approved()` gates the course/feature
  `*_read` RLS too. Toggle the whole feature with `REQUIRE_ADMIN_APPROVAL` (module const in
  BookkeeperPro.jsx, default on; off via `VITE_REQUIRE_ADMIN_APPROVAL=false`). SQL +
  walkthrough: [db/2026-06-29-user-approval.sql](db/2026-06-29-user-approval.sql) +
  [ADMIN_APPROVAL_SETUP.md](ADMIN_APPROVAL_SETUP.md). Approval state is server-side — **not** in
  `LEGACY_KEYS`.
- **Enrollment/payment gate (manual verification — the shipped form of the Phase-2 paywall):** a
  signed-in non-admin without a valid membership is held on the full-screen `EnrollmentPaywall`
  (5 pricing cards from the `enrollment_plans` table with an in-code fallback; ₱ prices formatted
  by `phpFmt`, **never** `useCurrency`; admin-editable payment instructions from
  `payment_settings`; receipt upload to the **private** `enrollment-receipts` bucket at
  `<uid>/<uuid>-<name>`), then on `EnrollmentPendingScreen` (realtime + poll, like
  PendingApprovalScreen) until an admin reviews the `enrollment_requests` row in the
  **Enrollments** admin tab (`enrollments` route `/admin/enrollments`; component
  `AdminEnrollments`; own sidebar badge = pending_review HEAD-count). Requests are append-only for
  students (statuses `pending_review/approved/rejected/expired`; unique partial index = one
  pending per user; resubmit inserts a new row; the only student UPDATE is self-expiring an
  overdue row); **Approve** writes request → profile (`is_paid`,`plan`,`approval_status`) →
  a **dated subscription term** via the admin-guarded `approve_subscription()` RPC (falls back to
  the legacy no-expiry update-else-insert when the lifecycle migration is missing); **Reject/
  expire** keeps the student blocked with a resubmit path. Receipt preview uses `createSignedUrl`
  (the app's **first** signed-URL use — everything else is public-bucket `getPublicUrl`). Emails
  via env-gated `api/notify-enrollment.js` (`RESEND_API_KEY`/`RESEND_FROM`, optional
  `NOTIFY_ADMIN_EMAIL` + `APP_URL` for the "Review in Enrollments" button; the submitted alert
  carries a Type: Renewal/New row). Three actions: `submitted` (student→admin, JWT-ownership auth),
  `decision` (admin→student), `test` (admin-only diagnostic → the **"Test email"** button in the
  Enrollments toolbar; verifies the admin JWT server-side and reports sent/not-configured/provider
  error). The admin **recipient** resolves `NOTIFY_ADMIN_EMAIL` → the admin-editable
  `payment_settings.notify_email` ("Proof / support email" field, read with the caller's JWT) →
  address in `RESEND_FROM`; the GET health check reports `{ ok, hasKey, hasFrom, adminRecipient }`
  (env-only, no address). **Supabase Auth's SMTP/Resend settings do NOT power this** — it needs its
  own Vercel env vars (or a Supabase Edge Function + function secrets off-Vercel). Receipts are
  never attached; the client submit fires the alert best-effort (never blocks the student).
  **Notify audit trail:** the `submitted` handler stamps the send outcome onto the request row
  (`enrollment_requests.notify_status`/`notified_at`/`notify_detail`) via the SECURITY DEFINER
  `record_enrollment_notification()` RPC (owner-or-admin guard — mirrors `approve_subscription`, so
  the function's student JWT can write without a broad UPDATE policy or a service-role key); each
  Enrollments card shows a green **"Admin emailed"** or amber/red **"Email not sent — …"** badge
  (`AdminEnrollments`' `NotifyBadge`) so a misconfigured admin email isn't invisible. All best-effort
  (never blocks the response); older rows/installs without the migration just show no badge.
  See [db/2026-07-08-enrollment-notify-status.sql](db/2026-07-08-enrollment-notify-status.sql).
  Toggle with `REQUIRE_ENROLLMENT` (module const, default on;
  off via `VITE_REQUIRE_ENROLLMENT=false`). Enrollment state is server-side — **not** in
  `LEGACY_KEYS` (the one exception: the admin sound-alert pref `enroll:soundAlert`, which IS a
  client pref and IS in `LEGACY_KEYS`; the alert itself is a WebAudio 3-tone chime with a Test
  button, opt-in per autoplay policy).
- **Subscription lifecycle (durations / expiry / renewal —
  [db/2026-07-04-subscription-lifecycle.sql](db/2026-07-04-subscription-lifecycle.sql), runs
  AFTER the enrollment migration):** every plan carries `access_days` (60 Core/Sampler/Silver,
  180 Gold/VIP; `support_days` informational; `entitlement_summary` jsonb chips) and every
  `subscriptions` row is a dated **term** (`ends_at`, `grace_ends_at`, lineage via
  `renewed_from_subscription_id`; `ends_at IS NULL` = legacy no-expiry — grandfathered).
  **The date is the authority:** `public.is_enrolled()` is rewritten to require an active,
  non-expired subscription (or the legacy/no-rows grandfather fallback) — all content `*_read`
  RLS enforces expiry server-side with zero policy changes; `profiles.is_paid` is now only a
  cache. Terms are granted solely by `approve_subscription(p_user_id, p_plan_key, p_request_id)`
  (SECURITY DEFINER, internal `is_admin()` guard; one transaction: supersede active row → insert
  new term; renewal stacking = `greatest(now, current ends_at) + access_days`, so early renewal
  never loses days; grace knob `v_grace_days`, default 0). `expire_overdue_subscriptions()`
  lazily flips overdue rows' `status` (cosmetic — called on Enrollments-tab load). Client side:
  `useEnrollmentGate` fetches the latest request + latest subscription for every non-admin
  (paid users too) and reduces to a named state via `enrollGateState()`/`subAccess()` (pure
  helpers next to the hook; `ends_at === undefined` tolerates the old schema); the root gate
  switches over that state → `EnrollmentPendingScreen` (`renewal`/`finalizing` props),
  **`MembershipExpiredScreen`** (expired member → Renew → paywall in `renewal` mode with
  `currentSub`/`onClose`), or the paywall. The Dashboard renders **`MembershipPanel`**
  (self-contained useAuth/fetch/realtime; fail-silent null on any error): plan, status pill,
  start/expiry dates, days remaining, amount paid, entitlement chips, warnings at 14/7/3 days,
  and a Renew button that opens the paywall as a fixed overlay — a member with a pending
  renewal keeps full access. `AdminEnrollments` adds membership filters (Renewals / Active /
  Expiring soon / Ended), a per-card membership strip, and an "access until {date}" projection
  in the approve modal. Docs: [ENROLLMENT_SETUP.md](ENROLLMENT_SETUP.md) ("Membership lifecycle
  & renewal"). Migration order: user-approval → enrollment → subscription-lifecycle →
  enrollment-notify-status.
- **Sign-out + identity** render in the sidebar header (just below the "built by Alex Sagun" line).
- **Per-user data:** all `window.storage` keys are auto-namespaced per user (see the main.jsx shim
  note). Tools need no changes. A one-time migration in `AuthProvider` adopts any pre-auth global
  keys into the first signed-in account (guarded by `auth:legacyMigratedTo`). The canonical legacy-key
  list lives in `AuthProvider.jsx` (`LEGACY_KEYS`) — **add to it whenever a tool introduces a new
  persisted key.** One special case: `ui:theme` is per-user via `window.storage` *and* mirrored to a
  bare `localStorage` key on every change (the `index.html` boot script + signed-out screens read the
  bare copy; `useTheme` adopts it into a fresh account on first sign-in).
- **Startup is parallelized:** `AuthProvider` applies the cached session optimistically after
  `getSession()`, so the profile fetch and the enrollment-gate queries run **concurrently** with the
  server-side revoke check (`getUser()`); `loading` still holds the splash until the revoke verdict,
  so a revoked account never renders anything. `useEnrollmentGate` fires its two own-row queries as
  soon as a uid exists (its returned `active`/`ready` still key off `profileReady` — gate semantics
  unchanged). Don't re-serialize these when editing the provider.
- **Backend setup:** a `profiles` table + RLS + a signup trigger must exist in Supabase. Email
  confirmation and Site/Redirect URLs are configured in the Supabase dashboard. See README / the
  setup steps for the exact SQL.
- **Phase 2 status:** the paid gate shipped as the **manual enrollment workflow** above (full-app
  gate keyed on `is_paid`, flipped only by an admin — RLS has no user-update policy on `profiles`).
  The old seam comments (`FREE_TABS` allowlist + `// Phase 2 paywall hooks here` at the render
  switch) remain unused — they're the hook for a future *partial* free-preview mode and/or a
  Stripe/Gumroad webhook that flips `is_paid` server-side without manual review.

## AI / proxy pattern

Every AI tool goes through the shared **`callClaude()`** helper at the top of `BookkeeperPro.jsx`
(L27) — **don't** hand-roll `fetch`/`res.json()`. It calls the **real** Anthropic URL; the proxy
injects the key.

```js
// defaults: model 'claude-sonnet-4-6', max_tokens 1024
const text = await callClaude({
  max_tokens: 1500,
  system: sys,                                       // optional system prompt
  messages: [{ role: 'user', content: userText }],
});

// Need the raw response (e.g. stop_reason to detect truncation)? Pass { returnData: true }:
const { text, data } = await callClaude({ system, messages }, { returnData: true });
```

- **Model:** `claude-sonnet-4-6` across all AI tools. `max_tokens` varies 800–4000 by task.
- **Error handling:** `callClaude` reads the body as text first, checks `res.ok`, and **throws a
  descriptive `Error`** (already `console.error('[Claude] …')`-logged) on HTTP or non-JSON failures —
  instead of silently collapsing into a generic fallback. Wrap calls in `try/catch` and set an `err`
  state; never assume success. It returns the joined text content, so no manual `.filter/.map` needed.
- **Never** put the API key, `x-api-key`, or `anthropic-version` in client code. The proxy adds them.
  - Dev: [vite.config.js](vite.config.js) injects `x-api-key` + `anthropic-version: 2023-06-01` (no auth check — local only).
  - Prod: [api/anthropic/v1/messages.js](api/anthropic/v1/messages.js) (Vercel serverless, exact-path) does the same **and authenticates the caller**: it requires a valid Supabase session (`callClaude` attaches the `Authorization: Bearer <access_token>`) and gates token spend on **admin-or-`is_enrolled()`**, plus a model allowlist / `max_tokens` / body-size cap. This closes the previously-open proxy (anyone could spend the key). `callClaude` fetching the session token is why it's `async`-aware of auth; the GET health check stays unauthenticated (zero-token).
- For JSON responses, tools strip ```` ```json ```` fences before `JSON.parse` (see `BankFeed`, ~L2214).
- For vision (PDF/image), tools send base64 `image`/`document` blocks in `messages[].content` (see
  `StatementConverter`, ~L2411).
- Under the hood `callClaude` is still a `fetch('https://api.anthropic.com/v1/messages', …)` with only
  `Content-Type: application/json` — that's what the `main.jsx` fetch shim rewrites to `/api/anthropic`.

## Styling conventions

- **Layout:** Tailwind utility classes (`flex`, `grid`, `gap-*`, `rounded-*`, `px-*`…).
- **Branded surfaces:** the in-file design tokens — color object `C`, `GLASS` (glass surfaces),
  `SHEEN` gradient, and `fontDisplay`/`fontBody`/`fontMono` — applied via inline `style={{…}}` objects
  plus the shared classes (`glass-card`, `gh-input`, `gh-btn-*`, `gh-pill`…) that now live globally in
  [src/index.css](src/index.css). New UI should reuse these tokens so it stays visually consistent
  with the glass-morphism look **in both themes**.

### Theme system (light / dark / system)

- **`C`/`GLASS`/`SHEEN`/`NAVY`/`ICE` are `var()` reference strings**, not hex. The actual values live
  in `src/index.css` under `:root, [data-theme="light"]` and `[data-theme="dark"]`; the active theme
  is the `data-theme` attribute on `<html>`, set pre-paint by the `index.html` boot script and driven
  at runtime by the **`useTheme`** hook + the `ThemeToggle` button (sidebar profile area + AuthScreen).
  Because tokens are vars, every inline `style={{ color: C.text }}` themes automatically.
- **Never string-concat an alpha onto a token** — `` `${C.primary}66` `` is broken CSS against a var.
  Use the alpha tokens instead: `var(--primary-glow)` (was `66`), `--primary-glow-soft` (`55`),
  `--primary-selection` (`33`), `--primary-halo` (`1A`), `--primary-tint` (`14`), `--green-ring`,
  `--green-ring-faint`, `--red-glow`, `--focus-ring`, and the neutral washes `--wash`/`--wash-strong`.
  (`ROYAL`/`CYAN`/`SKY`/`GOLD` stay literal hex on purpose — identical in both themes — so legacy
  `${CYAN}40` suffixes still work.)
- **`INK` is the frozen literal palette for anything that LEAVES the DOM** — Word `.doc` builders,
  the certificate + its print window, html2canvas/PDF capture. `var()` doesn't resolve in an exported
  document, so those paths must use `INK.*` (and `INK.navy` is also the band/gradient background
  under `text-white` headers, kept deep in both themes).
- **Status colors** (admin pills, banners, chips) use the semantic families
  `--status-{warn,warn-strong,ok,danger,info,neutral}-{bg,bd,fg}` — never hand-rolled rgba tints.
- **App-shell surfaces are tokenized too:** `--sidebar-bg` / `--sidebar-border` / `--sidebar-edge`
  (the sidebar `<aside>` — expanded, collapsed rail, and mobile drawer), `--topbar-bg` (mobile sticky
  top bar), `--section-head-bg` (the shared `SectionHead` sticky page header), and `--table-sticky-bg`
  plus its tinted variants `--table-sticky-{soft,deeper,ok,danger}-bg` (sticky first-column table
  cells in Budgeting/Forecasting — plain rows vs blue subtotal / highlight / green / red summary rows). Defined in both theme blocks (light =
  the original glass literals; dark = navy glass from the `#101B30`/`#0B1322` family) — reuse these
  for any new shell chrome instead of hardcoding light rgba values, which the dark compat layer
  cannot fix on inline styles.
- **Tailwind neutrals are dark-adapted centrally**: the documented compat layer at the bottom of
  `index.css` remaps the utilities actually in use (`bg-white`, `text-slate-*`, `border-slate-*`,
  red/emerald/amber families…) onto the tokens under `[data-theme="dark"]`. When adding UI, prefer
  utilities from that list (or tokens); if you introduce a new color utility, either add it to the
  layer or use a `dark:` variant. Intentionally NOT remapped: `text-white`, `text-blue-100/200`
  band subtitles, `bg-black/40` backdrops, `bg-white/10–30` overlays on gradients.
- **Theme persistence:** key `ui:theme` (`'light' | 'dark' | 'system'`, default `system`) — per-user
  via `window.storage` plus a **bare** `localStorage` mirror the boot script reads (signed-out screens
  resolve bare keys). `useTheme` live-follows the OS in system mode and syncs `<meta theme-color>`.
- **Dark-mode QA is part of tool acceptance** — check any new/edited screen in both themes before
  calling it done.

## Environment & secrets

- `ANTHROPIC_API_KEY` lives in `.env` (gitignored). [.env.example](.env.example) is the template.
- Get a key at https://console.anthropic.com/, then `npm run dev`.
- Without a key: AI tools fail gracefully; everything non-AI still works.
- The key is **only** ever read server-side (Vite proxy in dev, Vercel function in prod).
- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (auth) also live in `.env`. Unlike the Anthropic key,
  these are **`VITE_`-prefixed and public** — Vite inlines them into the browser bundle at **build**
  time, so they must be set in Vercel (Prod + Preview) *before* building. The anon key is safe to
  expose; Supabase **Row Level Security** is the real boundary. Without them, the app loads but the
  auth screen shows a "not configured" notice.
- **Feature flags (public, `VITE_`-prefixed, both default ON):** `VITE_REQUIRE_ADMIN_APPROVAL=false`
  disables the admin-approval gate; `VITE_REQUIRE_ENROLLMENT=false` disables the enrollment paywall.
  Rebuild after changing either. RLS remains the real boundary in both cases.
- **Email (server-only, optional):** `RESEND_API_KEY` + `RESEND_FROM` enable the approval + enrollment
  notification emails (`api/notify-access.js` / `api/notify-enrollment.js`); `NOTIFY_ADMIN_EMAIL`
  optionally overrides where "new enrollment submitted" alerts go (else the enrollment fn falls back
  to `payment_settings.notify_email`, then to `RESEND_FROM`); `APP_URL` sets the review-button origin.
  These are **this app's own** secrets — **Supabase Auth's SMTP/Resend settings are unrelated** and
  only send Auth emails. All are non-fatal when unset, and none run under `npm run dev` (serverless
  functions are Vercel-only). Diagnose from **Enrollments → "Test email"** or the GET health check.

## Deployment

- **Vercel:** push to GitHub → import project → set `ANTHROPIC_API_KEY` (Production + Preview) → deploy.
  The serverless function at `api/anthropic/v1/messages.js` replaces the dev proxy automatically.
- **Google Apps Script (alternate):** [standalone/index.html](standalone/index.html) is a self-contained
  build for embedding in Google Sheets.
- `dist/` is build output and is gitignored — don't edit it by hand.

## Conventions & guardrails

- **Match existing in-file patterns** — functional components, local `useState`, design tokens, and
  the `callClaude()` AI pattern above.
- **Adding a tool** = new component in `BookkeeperPro.jsx` + wire it into the sidebar config, the
  `renderTabContent(tabId)` switch, and `TAB_ROUTES` (so it deep-links and opens in a new tab). See
  the **add-bookkeeper-tool** skill in [.claude/skills/](.claude/skills/).
- **Keep the single-file architecture** unless a refactor is explicitly requested.
- **Preserve the two shims** in `main.jsx`.
- **Don't** add TypeScript, a linter, or new build config without asking.
- Coding house-style is captured in the **bookkeeper-conventions** skill.

See also: [README.md](README.md) for the end-user quickstart and deploy walkthrough.

## Keeping docs current

This CLAUDE.md and the two skills in [.claude/skills/](.claude/skills/) are the project's source of
truth — keep them in lockstep with the code. When a change touches any of the following, update the
docs **in the same change**:

- **The AI-call shape** (e.g. `callClaude()`'s signature/behavior, model, error handling) → update the
  "AI / proxy pattern" section here **and** both skills.
- **The navigation model** (sidebar config, render switch, dashboard tiles) → update the "Navigation
  model" section and the **add-bookkeeper-tool** skill.
- **Design tokens / helpers** (`C`, `GLASS`, `SHEEN`, fonts, `downloadFile`, `useCurrency`) → update
  **bookkeeper-conventions**.
- **The tool set** (added/removed/renamed tools, or large line drift) → refresh the architecture-map
  table and notable-tools anchors here.
- **Auth** (the `useAuth()` shape, the gate, the storage-namespacing, the `profiles` schema, or the
  `LEGACY_KEYS` inventory) → update the "Authentication" section here **and** the persistence notes in
  **bookkeeper-conventions**.

Line anchors are approximate and drift as the file grows — confirm with `Grep` before relying on them,
and re-baseline the table when they've moved substantially.

## Development roadmap (phases)

A living plan — each phase is independent and can be approved/started on its own.

- **Phase 0 — Documentation (done):** this CLAUDE.md + the two skills; refreshed for the centralized
  `callClaude()` AI helper and re-baselined line anchors.
- **Phase 1 — Polish & deploy:** verify the Vercel build and `ANTHROPIC_API_KEY`; confirm the AI path
  works in production; reduce bundle size. **Done:** XLSX/jspdf/html2canvas are lazy-loaded via
  dynamic `import()`, and `vite.config.js` splits `react`/`react-dom`, `@supabase/supabase-js`, and
  `lucide-react` into cacheable vendor chunks. **Done (2026-07 theme+perf pass):** brand logo moved to
  `public/logo-alex.png` (was 51 kB inline base64); static content banks extracted to lazy
  `src/data/*.js` chunks (app chunk 783→690 kB raw / 242→174 kB gzip); memoized `TabPanel` keep-alive
  (hidden tabs skip root re-renders); startup Supabase calls parallelized (session → revoke check ∥
  profile ∥ enrollment gate); fonts load once from `index.html`. **Still open:** the app chunk is
  still one file by design — true per-tool code-splitting would require breaking the single-file rule
  (deferred to Phase 3). Audit error/empty states across AI tools.
- **Phase 2 — Add tools/features:** ship new tools with the **add-bookkeeper-tool** skill so they stay
  consistent with the navigation model and design system.
- **Phase 3 — Incremental code quality:** extract shared helpers opportunistically; only when a tool is
  already being edited, optionally split the largest components into their own files — no big-bang
  rewrite; single-file remains the default.

### Authentication track (separate from the phases above)

- **Auth Phase 1 — Signup/login (done):** Supabase email/password gate, `AuthProvider`/`useAuth()`,
  per-user storage namespacing + legacy migration, sidebar identity/sign-out. See the Authentication
  section. Requires the Supabase `profiles` table/RLS/trigger + the two `VITE_SUPABASE_*` env vars.
- **Auth Phase 2 — Restrict to paid students (SHIPPED as the manual enrollment gate + subscription
  lifecycle):** unpaid non-admins are held on the in-app Enrollment Paywall (manual payment +
  receipt upload + admin review); approval now grants a **dated term** (plan `access_days` →
  `subscriptions.ends_at`), expiry locks the member on a Membership Expired screen, and renewal
  reuses the same paywall/review flow (early renewals extend from the current expiry) — see the
  "Enrollment/payment gate" + "Subscription lifecycle" bullets in the Authentication section +
  [ENROLLMENT_SETUP.md](ENROLLMENT_SETUP.md). `is_paid` is admin-flipped only (no user update
  policy on `profiles`) and is now a cache — `public.is_enrolled()` date-checks the subscription.
  Still open for a later iteration: a `FREE_TABS` free-preview mode (seam comments remain at the
  render switch), an automated Stripe/Gumroad webhook to grant terms without manual review, and
  full cloud data sync (move tool data from namespaced localStorage into Supabase for
  cross-device).
