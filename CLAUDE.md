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
  it or it will be purged. (The `standalone/` Google Apps Script build still uses the Tailwind **CDN**,
  since it's a single self-contained file.)
- **Lucide React** for icons, **XLSX** (spreadsheet parse/generate), **Mammoth** (.docx parse).
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

### [src/lib/supabase.js](src/lib/supabase.js) + [src/auth/AuthProvider.jsx](src/auth/AuthProvider.jsx) — auth infra

The **two sanctioned exceptions** to the single-file rule (same spirit as the `main.jsx` shims):
- `lib/supabase.js` — the single Supabase client, built from `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` (public anon key; safe in the bundle — RLS is the real boundary).
- `auth/AuthProvider.jsx` — the `AuthProvider` + `useAuth()` hook (see Authentication).

### Course platform (Supabase-backed) — `CourseProgram` engine + `CourseCatalog`

The course platform is the **first in-app tool to read/write Supabase directly**
(`import { supabase } from './lib/supabase'`) instead of `window.storage`. Course content + per-user
progress live in Supabase so they reach **all** students across devices. Two pieces:

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
- **Storage:** a public `course-media` bucket streams uploaded videos (`lessons/{course.id}/…`) and
  course covers (`covers/{course.id}/…`); write/delete restricted to admins. Videos can also be
  YouTube/Vimeo/MP4 **links**. Uploads are guarded client-side (video ≤ 50 MB; cover image ≤ 5 MB).
  The bucket is shared across all courses.
- **Certificate:** rendered from design tokens + `LOGO_DATA_URI`, downloaded as PDF via **lazy-loaded**
  `jspdf` + `html2canvas` (dynamic `import()` only on download — kept out of the main bundle); the PDF
  filename comes from the `certFileName` prop.
- **Setup:** all SQL + bucket steps live in **[COURSE_SETUP.md](COURSE_SETUP.md)**. Progress is in
  Supabase, **not** `window.storage` — do **not** add course keys to `LEGACY_KEYS`.

### [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx) — the entire app (~15.1k lines)

> Note: lines are long; prefer `Grep` over reading the whole file. Line numbers below are anchors,
> approximate as the file evolves.

| Region | Lines (approx) | Contents |
|---|---|---|
| Shared AI helper | 16–62 | `callClaude()` (L27) — the single entry point every AI tool uses (see AI/proxy pattern) |
| Imports + domain data | 1–620 | `COA_BASE` (L68), `COA_INDUSTRY` (L121), `INDUSTRY_NOTES` (L341), `VENDOR_PATTERNS` (L367), `COURSE_MODULES` (L463), checklists, `TIPS` (L603) |
| Design system + helpers | 620–770 | colors `C` (L624), `SHEEN` (L654), `GLASS` (L657), fonts `fontDisplay` (L671) / `fontMono` (L673), `downloadFile()` (L679), `useCurrency()` (L712), `CurrencyToggle()` (L748) |
| Root component | 774–~1700 | `BookkeeperProToolkit` (L774): `tab` state, sidebar `DEFAULT_STAGES` config (~L779–864), drag-drop reorder, rename/persist to `window.storage` (`sidebar:*` keys, ~L940–988), and the **render switch** (~L1704–1738) |
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
`LinkedInOptimizer` 10732, `MockInterviewSimulator` 10897, `DiscoveryCallSimulator` 11164,
`SOPGenerator` 11471, `ClientHealthScore` 12136, `CapacityPlanner` 13358, `PaymentTracker` 13542,
`QBDiagnostic` 14293, `BudgetingTool` 15483, `ForecastingTool` 15958.

### Navigation model

A single `tab` string in the root selects which tool renders. Three pieces must stay in sync:

1. **Sidebar config** (`DEFAULT_STAGES` array, ~L779–864): `{ id, number, label, groups: [{ label, tabIds }], tabs: [{ id, label, icon }] }`.
2. **Render switch** (~L1704–1738): `{tab === 'someid' && <SomeComponent />}`.
3. **Dashboard roadmap tiles** (~L1756–1829): optional `{ id, label, desc, icon, color }` entries.

Sidebar customizations (rename, reorder, collapse) persist to `window.storage` under `sidebar:*` keys.

## Authentication (Supabase — Phase 1)

The whole app sits behind a **Supabase email/password auth gate**. Anonymous visitors see a
full-screen login/signup screen; only signed-in users reach the toolkit.

- **Provider/hook:** [src/auth/AuthProvider.jsx](src/auth/AuthProvider.jsx) wraps the app in
  [main.jsx](src/main.jsx). Any component reads auth via `const { session, user, profile, loading,
  configured, signUp, signIn, signOut, resetPassword } = useAuth()`. `profile` is the row from the
  Supabase `profiles` table and carries `is_paid` / `plan` (used by the planned Phase-2 paywall) and
  `is_admin` (course-authoring gate — see the Course platform section). `profile` is fetched with
  `.select('*')`, so new `profiles` columns ride along automatically without an AuthProvider change.
- **The gate** lives in `BookkeeperProToolkit` just before its root `return` (~L1121): `if (loading)
  return <AuthSplash/>; if (!user) return <AuthScreen/>;`. `AuthScreen` (defined just above the root
  component) is the login/signup/reset UI, built from the design tokens (`C`, `SHEEN`, `GLASS`,
  `fontDisplay`, `LOGO_DATA_URI`).
- **Sign-out + identity** render in the sidebar header (just below the "built by Alex Sagun" line).
- **Per-user data:** all `window.storage` keys are auto-namespaced per user (see the main.jsx shim
  note). Tools need no changes. A one-time migration in `AuthProvider` adopts any pre-auth global
  keys into the first signed-in account (guarded by `auth:legacyMigratedTo`). The canonical legacy-key
  list lives in `AuthProvider.jsx` (`LEGACY_KEYS`) — **add to it whenever a tool introduces a new
  persisted key.**
- **Backend setup:** a `profiles` table + RLS + a signup trigger must exist in Supabase. Email
  confirmation and Site/Redirect URLs are configured in the Supabase dashboard. See README / the
  setup steps for the exact SQL.
- **Phase 2 (not built):** restrict tools to paid students via a `FREE_TABS` allowlist + a paywall
  overlay at the render switch (`// Phase 2 paywall hooks here` comment), with `is_paid` flipped
  **server-side** by a Stripe/Gumroad webhook (never client-side — tighten the RLS update policy then).

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
  - Dev: [vite.config.js](vite.config.js) injects `x-api-key` + `anthropic-version: 2023-06-01`.
  - Prod: [api/anthropic/v1/messages.js](api/anthropic/v1/messages.js) (Vercel serverless, exact-path) does the same.
- For JSON responses, tools strip ```` ```json ```` fences before `JSON.parse` (see `BankFeed`, ~L2214).
- For vision (PDF/image), tools send base64 `image`/`document` blocks in `messages[].content` (see
  `StatementConverter`, ~L2411).
- Under the hood `callClaude` is still a `fetch('https://api.anthropic.com/v1/messages', …)` with only
  `Content-Type: application/json` — that's what the `main.jsx` fetch shim rewrites to `/api/anthropic`.

## Styling conventions

- **Layout:** Tailwind utility classes (`flex`, `grid`, `gap-*`, `rounded-*`, `px-*`…).
- **Branded surfaces:** the in-file design tokens — color object `C`, `GLASS` (glass-card rgba),
  `SHEEN` gradient, and `fontDisplay`/`fontBody`/`fontMono` — applied via inline `style={{…}}` objects
  and the glass-card CSS in the in-component `<style>` block. New UI should reuse these tokens so it
  stays visually consistent with the glass-morphism look.

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

## Deployment

- **Vercel:** push to GitHub → import project → set `ANTHROPIC_API_KEY` (Production + Preview) → deploy.
  The serverless function at `api/anthropic/v1/messages.js` replaces the dev proxy automatically.
- **Google Apps Script (alternate):** [standalone/index.html](standalone/index.html) is a self-contained
  build for embedding in Google Sheets.
- `dist/` is build output and is gitignored — don't edit it by hand.

## Conventions & guardrails

- **Match existing in-file patterns** — functional components, local `useState`, design tokens, and
  the `callClaude()` AI pattern above.
- **Adding a tool** = new component in `BookkeeperPro.jsx` + wire it into the sidebar config and the
  render switch. See the **add-bookkeeper-tool** skill in [.claude/skills/](.claude/skills/).
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
  works in production; reduce bundle size (the XLSX and app chunks are large — lazy-load XLSX/Mammoth
  and consider code-splitting the heaviest tools); audit error/empty states across AI tools.
- **Phase 2 — Add tools/features:** ship new tools with the **add-bookkeeper-tool** skill so they stay
  consistent with the navigation model and design system.
- **Phase 3 — Incremental code quality:** extract shared helpers opportunistically; only when a tool is
  already being edited, optionally split the largest components into their own files — no big-bang
  rewrite; single-file remains the default.

### Authentication track (separate from the phases above)

- **Auth Phase 1 — Signup/login (done):** Supabase email/password gate, `AuthProvider`/`useAuth()`,
  per-user storage namespacing + legacy migration, sidebar identity/sign-out. See the Authentication
  section. Requires the Supabase `profiles` table/RLS/trigger + the two `VITE_SUPABASE_*` env vars.
- **Auth Phase 2 — Restrict to paid students (planned):** free-preview gating via a `FREE_TABS`
  allowlist + a paywall overlay at the render switch; `is_paid` flipped server-side by a Stripe/Gumroad
  checkout webhook (provider choice TBD); tighten the `profiles` RLS so users can't self-grant. Optional
  later: full cloud data sync (move tool data from namespaced localStorage into Supabase for cross-device).
