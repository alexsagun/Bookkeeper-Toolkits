# CLAUDE.md

Guidance for Claude Code (and any developer) working in this repository. Read this first.

## What this is

**Ultimate Remote Bookkeeper Toolkits** ("Get Hired With Alex") is a single-page web app for
aspiring and working **remote bookkeepers serving US clients**. It bundles ~60 fully-functional
tools across three career stages:

1. **Training & Skills** — Accounting 101 course, Industry Accounting playbooks, US Tax 101, ProAdvisor chat.
2. **Job Application** — authentic branding, resume/LinkedIn optimizers, a portfolio-website generator, interview prep, mock-interview & discovery-call simulators, QuickBooks diagnostic, pain-points & cover-letter generators.
3. **Client Management & Delivery** — engagement letters, onboarding, Chart of Accounts generator, invoice creator, bank-feed AI, statement→CSV converter, email templates, accounting calculators, monthly/year-end checklists, SOP generator, sales tax, plus growth tools (pricing, upsell, capacity, payment tracking).

Many tools are **AI-assisted** (call Claude); the rest (calculators, checklists, Chart of Accounts,
templates) run fully offline with no API key. Alongside the tools sits the in-app **Community**
(member feed — the Discord replacement; see the Community section below), included with every
active paid plan.

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
- **Tiptap 3 / ProseMirror** (`@tiptap/core`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/extensions`
  and six individual extension packages, all pinned at `3.31.3`) — ONLY for the course-lesson
  instructions canvas, and **lazy-loaded into its own chunk** (120 KB gzip; zero ProseMirror in
  either app chunk). Individual packages rather than `starter-kit` on purpose: what is not
  installed cannot be enabled. See `src/editor/LessonDocumentEditor.jsx`.
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
npm run ai:knowledge       # regenerate docs/ai/toolkits-voice-agent-knowledge.md (voice assistant)
npm run ai:knowledge:check # rebuild the knowledge doc in memory + diff vs disk; exit 1 on drift (writes nothing)
npm run ai:knowledge:push  # regenerate + upload it to the ElevenLabs knowledge base
npm run ai:provision       # regenerate + create/update the ElevenLabs agent, its client tools, the AI-trainer webhook tools (needs APP_URL), and the KB (needs ELEVENLABS_API_KEY; --dry-run to preview)
npm test                   # node --test — the pure-lib suites in test/ (planCatalog, studentImport, trainerToken, trainerContent, trainerAccess, communitySpaces, communityCapabilities, batchEntitlements, batchLifecycle, appErrors, lessonReplay, enrollmentIntake, enrollmentIntakeSql, communityChannels, trainingAgreement, bootstrapFolds, courseVideo, courseVideoSql, courseVideoContent, mp4Faststart, studentProgress, studentProgressSql, uiSafety, coaIntegrity, portfolioGenerator,
                           approveGrantSql, financeDailyIncome, financeDailyIncomeSql, lessonContent, lessonContentSql, lessonDocument, sidebarLayout,
                           legacyMigration, legacyMigrationSql, legacyClaimEmail, importClaim, enrollGate,
                           gettingStarted, gettingStartedSql, notifyAccessDecision, …)
npm run test:e2e           # RENDERED suites (test-e2e/*.e2etest.mjs): the real app served by Vite against
                           # the SHADOW project, driven through Chrome by a zero-dependency CDP client.
                           # Measures geometry a source scan cannot see (enrollmentLayout, workspaceSweep),
                           # and drives whole flows (gettingStarted: the gate's personas, on a clip recorded in Chrome).
                           # Needs .env.test + Chrome; skips loudly without them. Never targets production.
npm run storage:config     # read the PROJECT-WIDE Supabase Storage upload limit and the effective
                           # limit of every bucket; --apply raises it to LESSON_VIDEO_MAX_BYTES.
                           # The bucket limit alone is a ceiling, not a grant — Supabase enforces
                           # min(bucket, project-wide), and the project-wide one is NOT in any SQL.
```

There is **no linter** — verify UI changes by running `npm run dev` and exercising the affected
tool in the browser. The only automated tests are the `node --test` suites over the pure
`src/lib/*.js` modules — **plus** source/artifact scans over the monolith
(`uiSafety` also scans `dist/`, `coaIntegrity` evaluates `COA_BASE`/`COA_INDUSTRY` out of it) and
SQL-parity suites that read `db/*.sql` (`approveGrantSql`, `studentProgressSql`, `staffRolesSql`,
`bootstrapFolds`) — all under `npm test`.

## Architecture map

The app is intentionally a **single-file monolith**. Keep it that way unless a refactor is
explicitly requested (see Roadmap, Phase 3).

### [src/main.jsx](src/main.jsx) — entry + three critical pieces (do not remove)

Mounts `<BookkeeperProToolkit />` (wrapped in `<AuthProvider>` — see Authentication, and that pair
wrapped in **`<AppErrorBoundary>`** — see below) and installs two shims that the tool code depends on:

1. **`window.storage`** → wraps `localStorage` with an async `get`/`set` API. The app was authored
   in Claude artifacts and calls `window.storage` directly for all persistence. **Now per-user
   namespaced:** [AuthProvider](src/auth/AuthProvider.jsx) calls `window.__setStorageUser(uid)` on
   every session change, so each get/set transparently reads/writes `u:<uid>:<key>` — isolating each
   account's data with **zero changes to every tool** (they still pass plain keys). Supabase's own
   `sb-*` session key is written directly by supabase-js and is **not** namespaced.
2. **fetch shim** → rewrites any request to `https://api.anthropic.com` → `/api/anthropic`. Tool
   code calls the *real* Anthropic URL; this shim redirects it to the proxy so the API key stays
   server-side. (It only matches `api.anthropic.com`, so Supabase calls to `*.supabase.co` pass
   through untouched.) **Removing either shim breaks persistence or AI calls.**

3. **[src/AppErrorBoundary.jsx](src/AppErrorBoundary.jsx)** → the app's ONLY React error boundary,
   mounted **outside** `AuthProvider` so a crash in the provider is caught too. Before it existed,
   any uncaught render error unmounted the whole tree and left `#root` empty: a blank white page
   with no message and no way back — which is exactly how the 2026-09-03 null-entitlement crash
   presented to the account that owns the product (found only by opening DevTools). It renders the
   logo, "Something went wrong", **Reload**, **Sign out**, and a collapsed `<details>` with the
   error + component stack.
   ★ It **imports nothing from BookkeeperPro.jsx** — a safety net that pulls in the 35k-line
   monolith shares every module-scope hazard of the thing it is catching. It uses only React, the
   `src/index.css` tokens, `/logo-alex.png`, and the Supabase client (so Sign out can clear a
   wedged session).
   ★ **One boundary, at the root — do NOT add per-`TabPanel` boundaries.** `TabPanel` and
   `RestrictedTab` each apply `hidden={!active}` to their OWN root div, so a boundary wrapping one
   *replaces* that div when it catches: the fallback loses `hidden` and a crashed **background** tab
   paints its error card over the tab you are actually looking at.
   Pinned by `test/uiSafety.test.mjs` §16.

A fourth do-not-remove piece lives in [index.html](index.html): a tiny inline **theme boot script**
that reads the bare `localStorage['ui:theme']` pref (falling back to `prefers-color-scheme`) and sets
`data-theme` on `<html>` **before first paint** — this is what makes dark mode flicker-free. The
`useTheme` hook in BookkeeperPro.jsx keeps that key in sync (see Styling conventions → Theme).

### [src/lib/supabase.js](src/lib/supabase.js) + [src/auth/AuthProvider.jsx](src/auth/AuthProvider.jsx) — auth infra

### [src/editor/LessonDocumentEditor.jsx](src/editor/LessonDocumentEditor.jsx) — the one component outside the monolith

The lesson instructions canvas: the Tiptap **schema**, the React wrapper and the node views, and
nothing else. Every piece of product behaviour — uploading, the Supabase RPCs, the save gate, the
orphan sweep, the error copy — stays in `BookkeeperPro.jsx` and arrives as a prop.

- ★ **IT IMPORTS NOTHING FROM `BookkeeperPro.jsx`, AND NO SUPABASE CLIENT.** The point of the module
  is that it is lazy-loaded (`loadLessonEditorModule`, the `tus-js-client` idiom): ~120 KB gzip of
  ProseMirror for the handful of people who can edit a course, not for every student reading one.
  A single import of the design-token object `C` would pull the 37k-line monolith into this chunk
  and undo that completely, so everything here is styled with CSS classes over the `var(--…)`
  tokens in `src/index.css`. **Do not add it to `manualChunks`.** `uiSafety` §24 pins all of it,
  including a scan of `dist/` that the app chunks carry no ProseMirror.
- ★ **A CONTENTEDITABLE EDITOR IS SAFE HERE, AND THE OLD OBJECTION IS ANSWERED, NOT IGNORED.** The
  composer was a `<textarea>` because a WYSIWYG was read as "accept HTML from the DOM and sanitize
  it back into a safe subset" — a losing position, and still is. ProseMirror is not that: its
  SCHEMA is an allowlist, so markup it does not declare cannot exist in the document; the document
  is serialized back to the same closed markdown by `lessonDocument.js`; and that text is checked
  by the same `validateLessonContent` and rendered to students by the same `LessonRichText`. Three
  independent layers, and the stored bytes are byte-compatible with what shipped before.
- The schema is exactly `LESSON_DOC_NODES` / `LESSON_DOC_MARKS`. Not `@tiptap/starter-kit` (it
  brings headings, italic, strike, code, code blocks, blockquote, rules), and **not
  `@tiptap/extension-link`** — that package depends on `linkifyjs`, whose idea of a URL is not this
  app's, and a second opinion about what counts as a safe address is how one door stays unlocked.
  The `link` mark is written here so `safeLessonHref()` stays the only scheme authority, on paste
  as well as on save.
- `lessonImage` has **no `parseHTML` rule**, so nothing in a pasted document — least of all an
  `<img>` — can become one. An image gets in by being uploaded, and only then.

The sanctioned exceptions to the single-file rule (same spirit as the `main.jsx` shims):
- `lib/supabase.js` — the single Supabase client, built from `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` (public anon key; safe in the bundle — RLS is the real boundary).
- `auth/AuthProvider.jsx` — the `AuthProvider` + `useAuth()` hook (see Authentication).
- `src/lib/enrollmentIntake.js` — the enrollment form's field registry + validation (pure).
  ONE array (`INTAKE_FIELDS`) drives rendering *and* `validateIntake()`, so a field cannot be
  shown without being checked — which is exactly how the Apps Script it replaces shipped a
  resume field with a label, a drop zone and no `required` attribute. See Authentication →
  "Enrollment intake form".
- `src/lib/trainingAgreement.js` — the Training Agreement as data, not markup (pure).
  `agreementModel(planKey, plans)` reads prices and durations from `enrollment_plans`, so a
  signed document can never state a price the catalog does not charge.
- `src/lib/planCatalog.js` — the membership catalog + entitlement rules (pure; shared by the app,
  the voice-knowledge generator, and `node --test`). See Plan-based access.
- `src/lib/sidebarLayout.js` — the per-user sidebar layout reconciler (pure; extracted from the
  monolith by #56 so it could be tested). `mergeStoredWithDefaults()` is what DROPS a retired
  tab id out of a saved layout, which is why retiring a tool needs no storage migration —
  pinned by `test/sidebarLayout.test.mjs` instead of being an unverified comment. Since v5 it
  also owns GROUPED order (`groups[].tabIds`) and the two move functions — `moveTabByStep()` and
  `reorderVerdict()`, the single place that decides a drop is illegal. The UI never splices an
  array itself, so "a tab cannot leave its group" and "a tab cannot be lost" are properties of one
  tested module rather than of two event handlers that have to agree.
- `src/lib/lessonContent.js` — what a course lesson's instructions may contain (pure). Owns the
  closed markdown subset (paragraphs, bold, lists, https links, `![alt](lesson-asset://<uuid>)`
  images), `safeLessonHref()` (the `lessonReplay.js` rule: parsed `protocol` is the only scheme
  authority, no base argument, `hostname` not `host`, an invalid result carries no href), the
  asset-token parser the SQL trigger mirrors, the editor's caret-preserving insert helpers, and
  `lessonContentToPlainText()` — the projection that keeps markup and asset ids out of the AI
  trainer. **No markdown library**: it emits a closed token set and the renderer builds React
  elements from it, so unsafe markup is unrepresentable rather than filtered. See "Changing what a
  lesson's INSTRUCTIONS may contain".
- `src/lib/lessonDocument.js` — the bridge between that stored markdown and the WYSIWYG canvas
  (pure; the SECOND sanctioned lib→lib import, after `mp4Faststart.js` → `courseVideo.js`).
  `markdownToDoc()` / `docToMarkdown()` convert both ways against plain ProseMirror-shaped JSON,
  which is data, not a dependency — so `node --test` covers every rule directly. The editor's
  document model lives only while a drawer is open; `text_content` keeps storing the same closed
  subset, so there is **no migration behind the canvas**.
  ★ **EVERY NORMALIZATION THE SERIALIZER PERFORMS, `normalizeInline` MUST PERFORM TOO.**
  `blockMarkdown()` serializes a block, re-parses it and checks it still says the same thing, then
  falls back to a more conservative rendering. That check cannot tell a CORRECT normalization from
  corruption, so one the model does not know about sends the block to the literal tier — which
  **drops the link or the bold it was trying to protect**. **FIVE** live there for that reason: a
  refused href loses its mark, `]` cannot survive inside a label, an unbalanced parenthesis is
  percent-encoded, a trailing `*` is peeled out of a bold run, and — added after code review found
  it missing — **a newline inside a text node collapses to a space**, which `escapeText()` was doing
  unilaterally. Measured: a bold run containing `"a\nb"` beside a link serialized to `"a b and link"`,
  losing **both** marks, where the same content without the newline kept both. `bare` is excluded
  from the comparison key — it is a rendering hint, not content.
  ★ **`docToMarkdown` NORMALIZES FIRST, so several guards are a deliberate second line** and a
  mutation of them survives by design: the write-time href check (canonMarks already applied it),
  `boldWrap`'s peel, and the three `uploadingImage` exclusions. The last is unbreakable by removal
  at all — an atom with no content has nothing to emit — so the test that guards it scans the
  serializer for `uploadKey` instead. See "Changing what a lesson's INSTRUCTIONS may contain".
- `src/lib/coursePlayerLayout.js` — the lesson-page track arithmetic (pure): rail bounds,
  the derived two-pane threshold, the drag clamp, and the persisted layout shape. See
  "Course lesson workspace" below.
- `src/lib/mp4Faststart.js` — the in-browser faststart remux (pure; the ONE module that imports
  another lib module, `readBoxes` from `courseVideo.js`). `planFaststartRemux()` moves an MP4's
  `moov` index in front of its `mdat` and corrects every chunk offset, so the admin never has to
  run `ffmpeg -movflags +faststart` by hand — which, before 2026-09-07, they had done on all nine
  lesson videos in production. A byte move, never a transcode; it never throws and refuses with a
  stable code rather than guessing. **No SQL half**, which is why it is not part of the
  SQL-mirrored `courseVideo.js`. See "Changing what a course lesson video may be".
- `src/lib/portfolioGenerator.js` — the Portfolio Generator engine (pure). Owns the draft shape,
  link/photo validation, the ordered section table, the builder that emits the downloadable
  one-file portfolio **and its static `mode: 'pdf'` capture document**, the **export gate**
  (`PORTFOLIO_EXPORT_REQUIREMENTS` → `validateDraft` / `portfolioExportReadiness` /
  `planPortfolioExport`) and the PDF paginator (`planPdfPages`). It exists because the standalone artifact it was ported from escaped
  `& < > "` and **not `:`**, so a CTA of `javascript:alert(1)` reached FOUR hrefs in a page the
  student then hosts — stored XSS against their own prospects. `safeLinkHref()` follows the
  `lessonReplay.js` rule (the parsed `protocol` is the only scheme authority; no base argument;
  `hostname` not `host`; an invalid result carries no href) and adds one explicit `https://` retry
  for the scheme-less input everybody actually types. **No `Date`, no `toLocaleString`** — the year
  and the filename date are parameters, so the same draft is byte-identical everywhere. See
  "Changing what the Portfolio Generator may emit".
- `src/lib/legacyMigration.js` — the legacy Thinkific migration's rules (#67, pure; imports only
  `studentImport.js`, the third sanctioned lib→lib import). Declared-format date parsing with
  component checks, the Manila term mirror of `legacy_import_term()`, explicit plan/batch mapping
  suggestions (a batch label must also name the batch's month), the record-key input the SQL hashes,
  `normalizeLegacyRows()` (the preview AND the endpoint's staging), cohort defaults (only the newest
  cohort is pre-selected), the activation state machine and the typed phrase. SQL is the authority.
- `src/lib/importClaim.js` — the migrated-student claim link (#67): the `src/lib/staffInvite.js`
  design with its own path and fragment key, so neither link can be read as the other.
- `src/lib/enrollGate.js` — `subAccess()` + `enrollGateState()`, extracted by #67 so the `scheduled`
  state is tested (`test/enrollGate.test.mjs`) rather than trusted to a comment.
- `src/lib/financeDailyIncome.js` — the client half of Financial Management → Daily Income (#64)
  (pure, no imports, five exports). The SERVER computes every figure; this decides only which columns
  exist (from the response's `plans`, in its order — nothing here names a plan key), how a month is
  stepped and clamped, which days count as empty (net zero is NOT empty: a correction that cancels a
  collection stays visible), and what "today" is in the **business** timezone — `todayISODate()` is
  the browser's. One column list drives the table, the CSV and the print view, so they cannot disagree.
- `src/lib/gettingStarted.js` — the pure client half of the Getting Started video (#69; no imports).
  The object-name shape and its builder/parser (`ONBOARDING_VIDEO_PATH_RE` IS the SQL `storage_path`
  CHECK and `onboarding_video_path_version_id()`'s pattern — lowercase, no flags), the watch rule
  (`mergeRanges`, `playedFraction`, `watchVerdict`, `holdWatchVerdict`, `watchRecordFor`, `resumeAt`),
  the three elapsed constants `complete_onboarding_video()` mirrors, the root hook's status
  (`gettingStartedStatus`) and when it asks again (`gettingStartedNeedsReask`, the same rule), the
  enrollment phase the root hook is handed (`gettingStartedEnrollPhase`, whose `'pass'` is
  `gettingStartedEnrollPass`) and what a failed first answer means by the phase it lands in
  (`gettingStartedFailedBeforePass`), the gate's input (`gettingStartedGateInput`), the three client time
  bounds (`ONBOARDING_STATE_TIMEOUT_MS`, `ONBOARDING_LOAD_TIMEOUT_MS`, `ONBOARDING_COMPLETE_TIMEOUT_MS`),
  what a student is told (`gettingStartedGiveUpCopy`, `gettingStartedStanding`), the problem-code coercion
  `report_onboarding_video_problem()` mirrors, and the ONE interpreter of the Super Admin overview's facts
  (`onboardingHealth`, `publishImpact`). SQL is the authority on who must watch and on what a completion
  needs. See "Getting Started onboarding video (#69)".
- `src/lib/voiceAccess.js` — who may open a voice session (pure). `voiceSessionVerdict()` is the
  ONE decision table behind `api/elevenlabs/signed-url.js`, which imports it: it fails CLOSED
  (`unavailable` → 503) and admits active staff without a subscription. Also the single source of
  the assistant's name (`VOICE_ASSISTANT_NAME` / `_SHORT_NAME`). ★ `voiceEligibility()` — the
  client-side mic-FAB rule — is defined and tested here but **not yet called by the app**.
- `src/lib/voiceKnowledge.js` / `src/lib/voiceProvisioning.js` — the knowledge-doc fingerprint and
  invariants, and the provisioning PREFLIGHT/plan (`--verify-only`, `--client-only`, the
  `TRAINER_NOT_CONFIGURED` / `NO_APP_URL` blockers). ★ **Built and tested, but NOT wired in yet:**
  imported only by their tests — neither `ai:knowledge` nor `scripts/provision-voice-agent.mjs` uses
  them. The provision script refuses the unbuilt flags by name; see docs/ai/voice-agent-setup.md §3a.
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
  is a date-only (`YYYY-MM-DD`) editable **batch-run date** that **defaults to today** on
  create/duplicate; the card renders an **auto-derived "Month Year" badge** from it via the
  `batchRunLabel()` helper (named `cohortLabel()` before #38). ★ It is a **display label only** —
  `courses` has no FK to `batches`, no function or policy reads `course_date`, and the UI copy says so
  explicitly. Do not build a course→batch relationship on it. The older `month` text column is retained
  **only as a display fallback** for legacy rows with no `course_date` (no backfill is run).

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

- **Tables:** `courses` (incl. `course_date` editable batch-run date — a label, never a batch link + legacy `month` label fallback + `source_course_id` lineage for duplicates + `access_tier` `'standard'`/`'essentials'` — the per-plan tier the Sampler gate reads; admin-set via the card ⋮ menu) →
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
  `lesson_progress`/`course_completions` are **not** copied. `zoom_replay_url` **is** copied (by value,
  like every other content column — the copy is a draft the admin reviews, and a replay is often
  evergreen). It then opens the copy in the builder with a one-time success banner (`CourseProgram`'s
  `initialNotice` prop).
- **Course lesson workspace (the learner player).** `renderLearner()` is a **container-query**
  grid — media stage | splitter | curriculum rail, the panel on the **RIGHT** — not the old
  `lg:grid-cols-3`. Numbers live in `src/lib/coursePlayerLayout.js`; the layout itself is CSS
  (`.course-workspace` in `src/index.css`), driven by one `--course-rail` custom property.
  ★ **THE THRESHOLD IS 890px OF WORKSPACE, AND THAT NUMBER IS LOAD-BEARING.** It was 970,
  which sits just above the **912px** a 1280px screen has with the toolkit sidebar expanded —
  and 1280 CSS px is what a 1920 monitor reports at the 150% Windows scaling most people
  run. So one ordinary desktop docked cleanly with the sidebar collapsed and flipped to a
  panel COVERING THE VIDEO the moment the sidebar was opened. `COURSE_STAGE_MIN` is not
  advisory: whenever the CSS backstop binds, the rail is capped so the stage lands EXACTLY
  on it, so at 912px it *is* the video width — 600px beside a 262px rail.
  ★ **BELOW THE THRESHOLD THE PANEL OVERLAYS THE PLAYER; IT NEVER STACKS.** The rail shares
  ONE grid cell with the stage (`grid-area: 1 / 1`) and floats over it, capped to a screenful
  with its own scroll. The first version put it in a second grid ROW, which appended ~2,000px
  of lesson list to a 42-lesson course and made the page unscrollable — and "Hide lessons"
  could not help, because at that width there was no side rail to hide. Pinned by `uiSafety`
  §18. Three behaviours belong to the overlay state only, and all read the workspace width
  the existing `ResizeObserver` already measures, through `supportsTwoPane()`: it **starts
  closed** (a panel covering the video on arrival is wrong), it **auto-closes when a lesson
  is picked**, and **Escape dismisses it** — the Escape condition is deliberately INVERTED
  from the old theater mode, which you escaped *out of*. None of the three persists; the
  stored preference describes the two-pane layout, so closing there **does** persist.
  ★ **The edge tab is the only control that reopens it** (`.course-rail-tab`). Its
  `aria-label` is static and complete — the visible "Course content" label is a width-based
  hover/focus reveal and must never BE the accessible name. It floats in the player's
  top-right corner when narrow and takes its own track when wide: giving it a track on a
  390px screen cost ~55px and made the CLOSED video *smaller* than the open one (301 vs 347,
  measured).
  ★ **The old `maxHeight: 460` on the `<video>` was a red herring** — it needed an 818px-wide
  box to bind and the 1/3-2/3 grid never gave it one, so it had never fired. The TRACKS were
  the constraint. Measured at 1440x900 with the sidebar open: **651px → 691px** with the
  panel open, **1005px** with it closed; at 1920x1080, **743px → 1171px**; at 1280x800 with
  the sidebar open, **599px docked** where the panel used to cover the picture entirely.
  ★ **The rail is a two-row flex column — header, then `.course-rail-body` as the ONLY
  scroller.** The header was `position: sticky; top: 0` with a transparent background inside
  the rail's own scroller, so the lesson list scrolled visibly THROUGH it and "COURSE
  CONTENT" painted on top of "Lesson 1.1…". It was the only sticky header in `index.css`
  without an opaque backdrop, and it sat in a `space-y-4` stack so even an opaque one would
  have left a 16px gap. This is the shape CLAUDE.md already prescribed for `SidePanel` —
  "a drawer never needs `sticky top-0` … those only ever worked by accident inside a single
  scroller" — and the rail is now that shape. `.course-rail-body` needs `min-height: 0` or
  a flex item refuses to shrink below its content and overflows instead of scrolling.
  Pinned by `uiSafety` §18.
  ★ **Lesson rows are two lines**: title on its own, duration + type icon beneath. On one row
  the title was a flex sibling of an unshrinkable duration label and got ~133px in a 240px
  rail — sixteen characters before `truncate` bit, which is why every entry read
  "Lesson 1.1: How T…".
  ★ **Open/closed and the drag are CSS-only, and that is load-bearing.** The player is never
  re-parented, re-keyed or moved into a second JSX branch, so neither can remount `<video>` —
  which would lose `currentTime` and force `SignedLessonVideo` to mint a fresh signed URL.
  Verified in-browser: a full drag plus six open/close toggles during playback produced **zero**
  `/object/sign/` requests, while a lesson change correctly produced two. The drag writes
  `--course-rail` through a ref on a rAF, never `setState`; `endRailDrag` writes the property
  itself because React bails out of a `setState` to an equal value.
  ★ **All three `SignedLessonVideo` states share one `.course-stage` frame**, so a signing
  failure no longer reflows the page. The stage caps its **WIDTH** at `min(78vh,900px)*16/9` —
  capping `max-height` on a `aspect-ratio: 16/9` box leaves it full-width and pillarboxes the
  video, which is exactly the bug the old clamp would have caused.
  ★ **That frame is also where focus goes after the player's OWN "Try again".** The press flips
  the state to `signing`, which unmounts the button under the student's finger, and the browser
  used to drop focus to `<body>` (WCAG 2.4.3) — on every lesson page, and on the Getting Started
  gate, whose player is this component. React keeps the root `<div>` across the three returns, so it
  is the one element that outlives the press: every return carries `ref={stageRef} tabIndex={-1}`
  (a return without the ref detaches it; one without the tabIndex leaves a focused frame
  unfocusable) and NOTHING else — no role, no name, no handler, so a lesson renders as it did — and
  the button calls `refocusIfLost(stageRef)`. Pinned by `uiSafety` (the residue block after §28c),
  mutation-tested, and proven in Chrome with real key presses on a lesson and on the gate.
  ★ **Its focus ring is drawn INSIDE the frame and ABOVE the video** (the last block of
  `src/index.css`). Every caller clips the frame — the learner card is `overflow-hidden`,
  `.gs-stage` rounds and clips — so the scoped rings, 2px OUTSIDE the element, showed one edge of
  four on a lesson and none on the gate. An outline pulled inside with a negative offset is not
  enough: the `<video>` is positioned, so it paints AFTER the frame's own outline and hid the whole
  ring whenever a video was showing (measured). So `.course-stage:focus-visible` drops its outline
  and an `::after` paints the 2px ring last. Its `pointer-events: none` is load-bearing: the
  overlay covers the whole video, and without it a click lands on the frame and never starts
  playback (measured too). It overrides the scoped rings at the same specificity, so it must stay
  AFTER every one of them. Pinned by `uiSafety` (the same block); measured in Chrome — all four
  edges, message and video, lesson and gate, light and dark. ★ **And the same ring when the
  `<video>` ITSELF has focus (S1)** — it is the first keyboard stop on a lesson and on the Getting
  Started gate, page and card, and its own outline sat outside it and was clipped away (not one ring
  pixel, measured). `.course-stage > video:focus-visible` draws no outline, and a SEPARATE rule,
  `.course-stage:has(> video:focus-visible)::after`, paints the frame's ring: never a second selector
  on the rule above, because a browser without `:has()` drops a whole selector list.
  ★ **Text lessons never get the black frame** (`lessonUsesMediaStage`, derived INSIDE `LessonCard`
  so the learner page and the student preview cannot answer it differently), and `LessonStage`'s
  other caller — the admin `max-w-md` lesson-editor preview, which keeps `adminView` — stays
  width-bounded.
  ★ **The rail's sticky offset is MEASURED, not assumed.** `showHead` is false on a lesson page,
  but `InterviewPrep` renders its OWN sticky `SectionHead` (~200px) above the embedded catalog,
  and `container-type`'s containment means no z-index can lift the rail out from under it. The
  `embedded` prop is forwarded from `CourseCatalog` for exactly this, and the lookup is scoped
  to the owning TabPanel because every visited tab stays mounted in `<main>`.
  Pinned by `test/coursePlayerLayout.test.mjs` (incl. CSS↔JS drift) and `uiSafety` §18.
- **Zoom Live Replay (#37b):** `course_lessons.zoom_replay_url` is an **optional supplementary** link
  to the recording of a lesson's live session — one per lesson, nullable, **not** a fifth
  `video_provider`. Admins set it in the lesson editor; learners get the `LessonReplayLink` card
  rendered **below the lesson body and above the completion controls** (the placement is the column's
  own `COMMENT`). It **never** replaces `video_url`/`video_provider`/`storage_path`, never satisfies the
  empty-lesson save gate, never triggers storage cleanup, and never touches
  `lesson_progress`/`course_completions`/certificates — clicking it does not mark anything complete.
  Validation + host classification live in the pure **[src/lib/lessonReplay.js](src/lib/lessonReplay.js)**
  (`parseReplayUrl()` → `kind: none|zoom|external|invalid`; absolute **https only**; boundary-safe Zoom
  host match so `zoom.us.attacker.example` is never labelled Zoom; credentials/relative/`javascript:`
  rejected; query tokens like `?pwd=` preserved). Zoom hosts are **linked, never embedded** — Zoom
  recording pages send `X-Frame-Options`. A value that is invalid *in the database* (hand-edited row)
  never becomes a clickable `href`: learners see nothing, admins see a warning strip. The column has
  **no CHECK and no index** by design, so that module is the **only** enforcement point.
- **Student preview (pre-save).** The lesson editor's footer carries **"Preview as student"**, which
  shows the WHOLE student lesson page for the **unsaved draft** — media stage, title, duration,
  formatted instructions with images, the Zoom replay card and the completion controls — so a
  creator can judge the finished thing before saving. It is **not** the retired instructions-only
  Edit/Preview toggle.
  ★ **ONE RENDERER, TWO CALLERS.** The learner page and the preview both render the module-scope
  **`LessonCard`** (→ `LessonStage`), placed after `LessonReplayLink`. A preview that drifts from
  the real student view is worse than none, because the creator has started trusting it — so there
  is no second copy to drift from. `uiSafety` pins `<LessonCard` at exactly **2** render sites.
  ★ **`adminView`, NOT `isAdmin`, and the rename IS the safety.** It means "render the admin-only
  diagnostics", never "the viewer has admin rights" — in the preview those are OPPOSITE. It
  defaults to `false`, so a forgotten prop fails closed to the student render, and the preview
  passes a **literal** `adminView={false}`.
  ★ **Both components are MODULE SCOPE, and that is not a style choice.** Declared inside
  `CourseProgram` they would be a new type every render, so React would unmount the subtree —
  `SignedLessonVideo` re-signs and `<video>` returns to 0:00. `CourseProgram` re-renders on every
  progress tick, rail resize and notice, so a student's lesson would restart at random moments.
  ★ **ONE DRAWER, TWO FACES — never a second overlay.** `SidePanel` registers a **window-level**
  keydown handler. Measured in Chrome with a full-screen preview portalled above the still-mounted
  drawer: **Escape dismissed the lesson editor outright** (popping its discard confirm) and one Tab
  landed on the drawer's hidden "Close lesson editor" button *behind* the preview. So preview mode
  switches the SAME `SidePanel`'s title/icon/footer and remaps `onClose`, making Escape, the X and
  the backdrop all mean **"back to editing"**. Never portal a preview above the z-[70] drawer.
  ★ **The editor body is `hidden`, NEVER unmounted** (`<div hidden={lessonPreview}>`). ProseMirror's
  undo history lives in the editor INSTANCE, so an earlier version that returned a different
  `SidePanel` silently threw it away — preview, go back, Ctrl+Z, nothing happened — while a comment
  claimed the opposite. Caught in the browser, not by reading. Hiding also keeps an in-flight video
  upload alive. (`SidePanel`'s Tab query still *matches* hidden nodes — `querySelectorAll` does not
  care — but the browser skips them, and the footer and header always supply the trap's endpoints.)
  ★ **THE ONE EXCEPTION IS THE DRAWER'S OWN `max-w-md` PLAYER, which is UNMOUNTED** while previewing.
  Hiding is right for the canvas and wrong for a player: a hidden `<video>` is still a mounted
  `SignedLessonVideo`, so preview mode would hold **two** signed URLs and two `preload="metadata"`
  players for one lesson — and `display:none` does not pause media, so a video the admin had started
  there would keep talking underneath the student preview. It is a leaf with no state worth carrying,
  and it re-signs on return. Found in code review, which noticed this was the exact cost option B was
  chosen over A and C to avoid.
  ★ **A REFUSED SAVE IS NEVER SILENT — `refuseSave()` LEAVES PREVIEW MODE FIRST.** Save sits in the
  preview's own footer, but the `lessonErr` alert renders only in the EDITING footer and the replay
  error lives inside the body preview hides. So five reachable refusals (an empty lesson, a refused
  file pick, an image still uploading, any `validateLessonContent` fault, an invalid replay link)
  produced **no visible change at all** — press Save, nothing happens. The likeliest of them is a
  missing image description, which the canvas lets you incur by placing a picture and moving on; and
  `focusImage()` returns true against the HIDDEN canvas, so even the scroll fallback was suppressed.
  Every refusal now routes through one helper that exits preview, so the message, the field it names
  and the canvas the caret lands in are all on screen. Found in code review; pinned by `uiSafety` §25
  and verified in the browser (message shown, returned to editing, zero lesson writes).
  ★ **`liveLessonDraft()` is the ONE derivation the save and the preview share.** The canvas reports
  upward on a 180 ms debounce, so `editingLesson.text_content` lags; if the preview re-derived its
  own live copy the two could disagree about what the lesson SAYS — the same failure as two
  renderers, one level down in the data. Its `typeof … && liveMarkdown !== …` guard is load-bearing,
  not an optimization: with no canvas (a pre-#65 database, or legacy prose on the plain field) the
  ref is null, and without it merely OPENING such a lesson would stamp `content_format:'markdown'`
  on it. The Preview button `flush()`es the canvas first.
  ★ **The preview subtree is `inert=""`** (never `inert={true}` — React 18.3 warns). A draft carries
  a **real lesson id**, so one stray "Mark complete" would write `lesson_progress` through
  `complete_course_lesson` and fan a progress event out to the dashboards. `INERT_LESSON_ACTIONS` is
  **nulls, not no-ops** — a no-op is a live call site someone later "fixes" by wiring the real
  handler in. `inert` also removes the subtree from the a11y tree, which matters concretely: the
  media stage renders `role="status"` while signing and `role="alert"` on failure, and a preview
  must not announce an alert into someone's editing session. `uiSafety` counts `markComplete(` at
  exactly **3** file-wide (the declaration, its one binding, and the unrelated feature-guide one).
  ★ **`LESSON_PREVIEW_MAX_W = 598` IS MEASURED, AND ITS DIRECTION IS THE POINT.** On the live
  learner page the same lesson is **356px** wide on a phone, **598px** at 1280, **700px** at 1440,
  **718px** at 768 and **1180px** at 1920 — there is no single "student width", so the preview can
  only choose which way to be wrong, and the two directions are not symmetric. Too WIDE lets a
  creator approve a line that wraps badly for the student; too NARROW only shows wrapping the
  student will not hit. Capping at the narrowest common desktop width makes it exact at 1280 and
  at-or-under everywhere else (verified: 596px desktop, 339px at 390). Uncapped in the drawer it
  measured **845px — 41% wider than a 1280 student**.
  ★ **Preview is deliberately NOT disabled while the lesson cannot be saved** (mid-upload, missing
  alt text, a refused pick). It is a preview, not a save, and that state is part of what the creator
  wants to look at. Only Save is gated.
- **In-app delete = data cleanup (reference-aware):** `CourseCatalog.deleteCourse()` deletes the row
  (FK cascade clears modules/lessons/progress/completions) then calls the module-level
  `removeMediaIfUnreferenced()` to purge the course's storage files **only when no other course still
  references them** (so deleting one monthly edition never breaks a duplicate that reused its videos).
  The same helper guards `uploadCover()` and `CourseProgram`'s `saveLesson()`/`deleteLesson()` (always
  called *after* the row update/delete). This is how dummy/test content is removed — admins delete it
  in-app.
  ★ **An ABANDONED upload is a fifth case, and `saveLesson` structurally cannot reach it.** The
  transfer completes, the object is written, and the drawer is closed before Save. `saveLesson`
  compares the row's OLD `storage_path` against the new one — but for an abandoned upload the row
  never had one, so `if (oldPath && …)` short-circuits on its first term. The only thing that knew
  the path was a ref inside `LessonVideoUploader`, which closing the drawer unmounts. Three such
  objects were sitting in production on 2026-09-07 — **1.60 GiB, 29% of the bucket**, each a
  byte-identical duplicate of a live lesson. `closeLessonEditor` now sweeps
  `pendingVideoPathRef` (fed by the uploader's `onPendingPath`) through the same reference-aware
  helper. ★ Deliberately **not** a `useEffect` unmount cleanup: that fires on a SUCCESSFUL save
  too, where the pending path is the one just written to the row — `removeMediaIfUnreferenced`
  would refuse to delete it, but relying on that is a safety net standing in for a design.
  `LessonVideoOrphans` remains the backstop for the cases no client code can reach (a crashed
  tab, a closed laptop). Pinned by `test/uiSafety.test.mjs` §19.
  ★ **A DISCARDED upload stops being the lesson draft's video (RES-1 — high, and pre-existing in
  production).** When the uploader drops the path the draft names (a replacement it ACCEPTED, a
  Cancel, a Remove — `discardPending` is its only null), `notePendingVideoPath(null)` puts the draft
  back on what the SAVED row holds — `savedLessonVideoRef`: its `storage_path`, `video_provider` and
  `video_url`, for the same lesson id. It is the Getting Started drawer's T9V-L4 idiom. It runs only
  when an upload WAS pending (`if (path || !dropped) return;`): Remove's own null with nothing pending
  is no discard, so a removal the admin made stands (V-RES1-GUARD). The duration label that upload
  PRE-FILLED goes back with it, to what the label said before (`prefilledLabelRef`
  `{ id, path, label, before }`, recorded by `applyVideoPatch` when it pre-fills), and only while it
  still reads what that upload put there — a label the admin wrote since stands (V-RES1-LABEL). Before
  it: a saved video S, an upload A that verified, a Replace with B (which discards A, by design),
  Cancel B, Save — the row named the deleted A, `saveLesson`'s old-path cleanup then deleted S as
  "replaced", and Learn read "could not be authorized". Kept, the label also put the dropped upload's
  length beside the row's own video, and a replacement that then finished could not pre-fill its own.
  ★ **`saveLesson` proves a NEW video exists before writing it.** When `storage_path` changes,
  `lessonVideoInStorage()` signs it once (Storage refuses to sign a missing object). A missing object
  or a failed sign refuses the save — "The new video for this lesson isn’t in storage any more, so
  nothing was saved…" — and writes nothing. It is the only guard for a draft restored from
  `window.storage` (`course:<id>:lessonDraft`) that names an upload swept since.
  ★ **An upload whose verification FAILED is swept at the next SAVE, in both editors (AUI-1) — a sixth
  orphan case, beside the abandoned upload.** A refused pick discards nothing (see "Changing what a
  course lesson video may be"), and a draft never names an upload that failed its check, so Dismiss
  then Save dropped the only reference to it and the object stayed in the bucket for good. `saveLesson`
  (through `removeMediaIfUnreferenced`) and the Getting Started `saveDraft` (through
  `sweepOnboardingFile`) now remove a leftover pending path that is not the path being saved. Pinned by
  `uiSafety` §19 (RES-1 twice, V-RES1-GUARD, V-RES1-LABEL) and §19/§28c (AUI-1), mutation-tested.
- **Storage (three buckets):** PAID lesson **videos** live in the **private** `course-videos` bucket
  (`lessons/{course.id}/…`), served via short-lived **signed URLs** gated by `is_enrolled()` RLS —
  because a *public* Supabase bucket serves every object publicly and bypasses RLS on read, so a
  public bucket can't protect paid content. Lesson **instruction images** (#65) live in their own
  **private** `course-lesson-assets` bucket (`lessons/{course.id}/{lesson.id}/…`, 10 MiB,
  png/jpeg/webp), batch-signed once per lesson and authorized **by REFERENCE** rather than by path.
  Course **covers** (`covers/{course.id}/…`) and feature-guide videos stay in the **public**
  `course-media` bucket (they're meant to be visible while browsing). Write/delete on all three is
  course-staff-only. Cover images are guarded at ≤ 5 MB.
- **Lesson video is UPLOAD-ONLY (#44, `db/2026-08-24-course-video-upload-only.sql`).** A lesson's
  primary content can no longer be a pasted YouTube/Vimeo/MP4 URL — not in the editor, and not
  through a direct PostgREST call (`course_lessons_video_guard` refuses the transition INTO
  link-backed, and is **monotonic on `video_url`, never on `video_provider`**, because
  `saveLesson` used to re-derive the provider from the URL on every write). Every rule — MP4-only,
  2 GiB, the 6 MiB TUS chunk size, the state machine, path shape, publish readiness, the save
  payload, playback re-sign decisions — lives in the pure
  [src/lib/courseVideo.js](src/lib/courseVideo.js), pinned by `test/courseVideo.test.mjs` and
  `test/courseVideoSql.test.mjs` (which diffs the constants against the SQL in **both** the dated
  file and the bootstrap fold). Uploads are **resumable (`tus-js-client`, lazy-`import()`ed into
  its own chunk)** straight from the browser to `<ref>.storage.supabase.co` — never through Vercel.
  `LessonVideoUploader` is **module scope**, not declared inside `CourseProgram`, or it would
  remount and lose an upload on every keystroke elsewhere in the drawer.
  ★ **Since #69 the uploader and the player have a second owner, and the lesson is the DEFAULT of
  both.** `LessonVideoUploader` takes a `target` record (`LESSON_UPLOAD_TARGET` unless given one:
  bucket, path builder, own-path test, tus resume-key scope, signer, discard, wording — whose
  optional `messages` replace each shared refusal that names a lesson, read FIRST; a lesson passes
  none and keeps `courseVideo.js`'s wording) plus an optional `onMediaFacts`; `SignedLessonVideo`
  takes `signUrl` (default `signLessonVideo`) plus
  optional observers (`mediaRef`, `onEnded`/`onTimeUpdate`/`onSeeking`, `onProblem` from EVERY
  path into its error state, `onReady`). Every URL the BROWSER mints for an uploaded lesson video or
  the Getting Started video comes from ONE function, `signPrivateVideo(bucket, path)` — not every
  video URL in the app: an uploaded feature-guide video is a public `course-media` URL, a community
  video attachment is batch-signed by `CommunityHub`, and the AI trainer's Scribe transcription signs a
  lesson video on the server (`api/admin/course-trainer.js`). A lesson caller passes none of those
  props, and `uiSafety` §28a pins that the transfer, the verification and the state machine stayed
  shared and owner-blind. See "Getting Started onboarding video (#69)".
  ★ **`SignedLessonVideo` names the bucket its signer signs in (TDR-8).** `PRIVATE_VIDEO_SIGNERS` is
  keyed on the signer FUNCTION: `signLessonVideo` → the log tag `[course-videos]` and the lesson's
  admin sentence, word for word as before; `signOnboardingVideo` → `[onboarding-videos]` and "This
  Getting Started video’s file could not be authorized for playback…". Any other signer logs
  `[private-video]` with a neutral sentence. It used to log every failure as `[course-videos]` and send
  a Super Admin to look for a lesson in the wrong bucket. Pinned by `uiSafety` §28a.
  ★ **"Storage accepted the bytes" is not "ready".** `READY_TO_SAVE` has exactly one inbound edge,
  from `VERIFYING_PRIVATE_OBJECT`, where the app signs the object and loads its metadata from that
  signed URL. Save is disabled until then.
  ★ **`SignedLessonVideo` has NO public fallback, and removing it was the root-cause fix.** It used
  to fall back to `getPublicUrl('course-media', path)` whenever `createSignedUrl` returned
  anything falsy — an RLS denial and an expired session included — and `getPublicUrl` is a pure
  string builder that never round-trips, so it always returned a truthy URL. The `failed` branch
  was therefore dead code, the real signing error was never logged, and the learner got a
  `<video>` pointed at a 400 with no `onError`. Every distinct failure looked identical. It now
  has named states, re-signs **once** on a recoverable error (never on a DECODE error — re-signing
  cannot fix a codec), preserves `currentTime`, and refreshes proactively before the TTL expires.
  ★ **Storage authorization is REFERENCE-based, not path-based.** `course_video_object_readable()`
  asks whether a *published lesson the caller's plan may read* cites that exact `storage_path`.
  Its predecessor `course_object_allowed()` parsed `split_part(name,'/',2)::uuid` and failed
  **open** three ways, ignored `courses.published`, and mis-authorized duplicated courses (which
  share a `storage_path` by reference, so a duplicate's video lives in the SOURCE course's
  folder). It is dropped by #44.
  ★ **TEMPORARY:** `LessonStage` (the module-scope component `renderVideo` became) still plays
  pre-#44 link lessons from one clearly-marked block,
  because on 2026-08-24 **101 of 102 live video lessons were YouTube links across three published
  courses**. Authoring and playback were split deliberately so nothing went dark. **Removal
  criterion: `npm run media:audit` reports 0 external links** — then delete the block.
  `npm run media:audit` / `media:migrate` (`scripts/migrate-lesson-videos.mjs`) inventory the
  four legacy categories and move pre-#15 objects out of the public bucket with a **server-side**
  `copy({ destinationBucket })`, verifying the destination before deleting the source.
  See `db/2026-07-08-course-videos-private.sql` and `db/2026-08-24-course-video-upload-only.sql`.
- **Publishing is gated (#44).** `courses_publish_guard` refuses a false→true `published`
  transition while any video lesson is link-backed or has no uploaded file, and
  `course_publish_blockers(uuid)` feeds the client preflight that names them. ★ The trigger is
  **delta-scoped by a `when (new.published and not old.published)` clause**. Scoping it on state
  instead would refuse every unrelated write to an already-published course — `reorderCourse`
  fires N updates in one `Promise.all`, plus cover upload, tier toggle, AI-trainer toggle and
  metadata save all write to `courses` without touching `published`.
- **Duplication refuses a legacy source (#44)**, naming the lessons — and that check runs **before
  anything is inserted**, because `duplicateCourse`'s catch block deletes the half-built copy, so
  a failure partway through would destroy the new course rather than explain itself.
- **Certificate:** rendered from design tokens + `LOGO_DATA_URI`, downloaded as PDF via **lazy-loaded**
  `jspdf` + `html2canvas` (dynamic `import()` only on download — kept out of the main bundle); the PDF
  filename comes from the `certFileName` prop.
- **Setup:** all SQL + bucket steps live in **[COURSE_SETUP.md](COURSE_SETUP.md)**. Progress is in
  Supabase, **not** `window.storage` — do **not** add course keys to `LEGACY_KEYS`.

### Community (Supabase-backed member forum) — `CommunityHub`

The in-app replacement for the Discord group chat, grown into a full forum: tab id
`community`, route `/community` (+ **`?post=<id>` deep links** to a discussion — the
CourseCatalog `?course=` idiom), sidebar Home → Community. **Every active paid plan includes
it** (all plans advertise group chat) — the tab id is in the sampler `tabIds` (silver and VIP are
full-access plans, so they pass by default), and the **server gate is `is_approved()` +
`is_enrolled()` RLS** (term + 3-day grace, mirroring course reads), so access ends with the
membership automatically — **expired members are fully blocked — reads _and writes_** (#28 closed
the own-update gap on posts/comments that #25 had left). The
Essentials (`sampler`) plan's **60-day group chat support** == its 60-day `access_days` window.

**Spaces & batches (#32, [db/2026-07-28-community-spaces-batches.sql](db/2026-07-28-community-spaces-batches.sql)):**
the forum is segmented into **community_spaces** — one **General** space (every active plan) plus
one PRIVATE full-forum **VIP** space per **batch** (cohort registry, code `YYYY-MM`;
`batches_create_spaces()` trigger auto-creates the space + a `batch_events` audit row). #32 also
minted a Gold space per batch; **#39 removed the Gold plan and the `gold` space kind entirely**, so
VIP is the only private segment and `community_spaces.kind` is now `('general','vip')`.

**Channels (#40, [db/2026-08-18-community-channels.sql](db/2026-08-18-community-channels.sql)):**
the forum is grouped into **community_channel_categories** (organisation ONLY — never an
authorization boundary) containing **community_channels**, which are the navigation surface AND the
per-room audience/rights boundary. `community_tags` is untouched and still labels posts; a post has
both a channel and a tag. `channel_id` rides on `community_posts`, `community_comments` (denormalized
so a realtime filter can name it — the #32 `space_id` reason) and `community_notifications`.
★ **Channels NARROW, never WIDEN**: `user_community_channel_ids()`/`my_community_channel_ids()` AND
the audience test with `user_community_space_ids()`, so **L1 is untouched** and a channel-layer bug
can hide content but can never expose a space. `audience_mode` ∈ `space` | `plans` | `batches` |
`plans_and_batches` (an **intersection**) | `admins_only`; a mode that needs a mapping fails CLOSED
on an empty one (an `EXISTS` over zero rows — not a defensive `if`), and batch **status is
deliberately not consulted**, because closing or archiving a cohort must not revoke a paid seat.
`user_community_channel_capabilities()` fuses **plan × space × channel** (a channel flag can only
subtract), `my_community_sidebar()` is the ONE navigation call the client makes (bounded 100-cap
unread — ONE statement, but its unread count is a `cross join lateral` correlated on the channel,
so the accurate claim is **bounded work per channel**, not "never a query per channel"; the bound is
the `limit 100` plus `community_posts_channel_unread_idx`), `community_channel_write_denial()`
explains a refusal, and
`mark_community_channel_read()` writes `community_channel_reads`. An invisible channel reports
**identically** to a nonexistent one. Every content policy and the community-media storage read are
scoped `channel_id in (select my_community_channel_ids())`, keeping #29's uncorrelated InitPlan
idiom; the notify triggers and `search_community_members(p_query, p_space_id, p_channel_id)` are
channel-scoped so a mention can never reach someone who cannot open the room. Search is indexed
(`community_posts.search_tsv` + GIN + `search_community_posts()` with **invoker rights**, so RLS is
the authorization). Admin editor RPCs (`admin_community_config`, `admin_save_community_channel`,
`admin_save_channel_category`, `admin_move_*`, `admin_set_community_channel_status`,
`admin_channel_privacy_preview`) are the **only** writers — the tables carry no client write policy,
so the `community_channel_events` audit row cannot be bypassed. `batches_create_spaces()` seeds a new
cohort's `#lounge`/`#coaching-questions` in the same transaction as its space. Client: the channel
rail + `SidePanel` admin editor in `CommunityHub`, `?channel=<slug>` beside `?space=`/`?post=`, last
selection in `window.storage` (`community:lastChannel`, `community:railGroups` — both in
`LEGACY_KEYS`), pure mirror in [src/lib/communityChannels.js](src/lib/communityChannels.js).

**★ D2 CHANGED SHAPE IN #40 — read this before touching General.** #36 made General
announcement-only for EVERY plan (`member_posting = false` AND `member_comments = false`), pinned by
the `community_spaces_general_announcement_only` CHECK. That was a **space-wide** prohibition, so no
General room could host a conversation at all. **#40 retires it deliberately and on the record**: the
CHECK is dropped, the General space flags are flipped, and `can_post_in_general` /
`can_comment_in_general` are enabled for all three plans. The intent survives **one level down**, per
channel — `#announcements` is `kind='announcement'`, which makes `member_posting = false` true **by
CHECK** rather than by policy prose, with `member_comments = false`. Reactions stay ON for every plan,
historical content stays readable, and an author can still WITHDRAW their own post (the read policies
carry an author-owns-`deleted` branch, without which Postgres refuses the soft-delete outright — an
UPDATE whose resulting row would be invisible to the writer fails 42501, which is why member
soft-delete never actually worked before #36). **`can_upload_attachments` was NOT relaxed** —
sampler/silver stay false, VIP stays true. The standing rule is unchanged and is what the old CHECK
was really protecting: **never hand-edit `member_posting`/`member_comments` to work around a
permission question** — change the channel, or the plan capability columns, and record it. That
instruction once lived in COMMUNITY_SETUP.md, it was followed, it was never reverted, and prod ran for
a week with every plan able to reply in General.

Per-plan rights come from **seven fail-closed capability columns on `enrollment_plans`** fused with
the space flags by `user_community_capabilities()` (#36) — the ONE resolver every write policy
reads, consumed as an uncorrelated subquery so it InitPlans once per statement. Access is
**DERIVED, never stored**:
`user_community_space_ids(p_user)` / `my_community_space_ids()` (SECDEF) map the current valid
subscription → `enrollment_plans.community_segment` (`vip`→vip, else general)
+ `subscriptions.batch_id` → spaces; unknown plans and batch-less premium subs fail closed to
General (they surface in Admin → Batches → "Needs batch assignment"). Every community policy +
the community-media storage read is scoped `space_id in (select my_community_space_ids())`;
posts/comments carry a trigger-stamped frozen `space_id` (comments denormalized so the realtime
channel can filter `space_id=eq.<id>`); notify triggers drop cross-space mention uuids;
`search_community_members(p_query, p_space_id)` + `community_category_counts(p_space_id)`
replaced their old signatures (default params keep old clients resolving). New media paths are
`<space_id>/<uid>/<uuid>-<name>` (legacy `<uid>/…` reads keep working — authorization is
attachment-join based). Client: `CommunityHub` gains a space engine (`my_community_spaces()`
RPC → switcher pills + member counts, `?space=<slug>` beside `?post=`, VIP lands in its
private space by default, last selection in `window.storage` `community:lastSpace` — in
`LEGACY_KEYS`); a pre-#32 DB degrades to legacy single-space mode + an admin notice — but that
degrade is confirmed by **probing `community_spaces` for a missing-table code**, never by the RPC
error alone: legacy mode leaves `spaceId` null, the composer then omits `space_id`, and
`community_posts_guard()` defaults it to **General**, so a false "pre-#32" verdict would publish a
private cohort post to every plan. Any other failure sets `spacesReady='error'`, which blocks the
feed load, the realtime subscription, the detail fetch, and every write.
**Lockstep set when segment/batch rules change:** the `community_segment` seed ↔
`PLAN_SEGMENT_FALLBACK`/`planSegment()` in [src/lib/communitySpaces.js](src/lib/communitySpaces.js)
↔ `user_community_space_ids()` ↔ `approvalBatchPreselect()` (the pure mirror of
`admin_finalize_enrollment()`'s batch precedence) ↔ `batchGapForProcess()` (the v1 import path's
process-time re-validation; nothing calls it since #67 replaced that path) — all pinned by `test/communitySpaces.test.mjs`.
Batch UI: paywall open-batch selector (VIP only), approve-modal picker, `AdminBatches` tab
(`batches` route `/admin/batches`), import `batch_code` column. **Two batch facts that surprise
people:** per-segment **capacity is enforced only on the two admin RPC paths** (approval +
`admin_assign_batch`) — imports and direct SQL grants do not consume seats; and **archiving a batch
blocks its existing members' renewals and extensions** (the RPC refuses `archived` before the
existing-member carve-out), whereas **closing** it only stops new assignments.

**Batch records are EDITABLE, but not by a client UPDATE (#38,
[db/2026-08-16-batch-lifecycle.sql](db/2026-08-16-batch-lifecycle.sql)).** `batches.code` is the
allocation ordering key — `grant_batch_run()` scans `where b.code >= start and status='open' order by
b.code … for update` and `allocate_queued_entitlements()` refuses any cohort not strictly above the
highest code a run already holds — so re-coding a batch silently **reorders a member's purchased run**.
Therefore: **`update (code)` is REVOKED from `authenticated`** (RLS has no column granularity; GRANT
does), and every field change goes through **`admin_update_batch()`**, which enforces
**rank preservation** (the new code may not cross a sibling → `BATCH_CODE_REORDER`), uniqueness,
period validity, `pg_timezone_names`, and capacity ≥ occupancy; it renames the two space **NAMES**
but **never their slugs** — `community_spaces.slug` is a **permalink** (`?space=<slug>` links +
`community:lastSpace`, and `pickInitialSpace()` falls back *silently* on an unknown slug), and it
re-stamps `activates_at` only on seats that have **not yet started**. Audited as a `batch_events`
`'edit'` row with before + after.
**"Past" is a calendar question:** `batch_is_past(ends_on, timezone)` = today **in the batch's own
timezone** > `ends_on`, so a batch stays editable through its final local day (a UTC comparison would
lock an Asia/Manila batch up to 16 hours early). `batches_guard()` (BEFORE INSERT OR UPDATE) freezes
every descriptive field once past — leaving only status/close/archive — and fills the period from
`code` on INSERT so an SQL-editor insert is as reliable as the UI's. Break-glass for a past row:
`set local app.batch_admin_override = 'on'` in a session running as the **`batches` table owner** (the
Supabase SQL Editor / Management API). It is gated on ownership, **not `rolsuper`** — Supabase's
`postgres` is not a superuser, so a superuser gate would be unreachable on the one database that needs
it; PostgREST's `authenticator` is not a member of the owner, so the API can never reach it. Status is
deliberately NOT the lock: a batch can be closed early or archived mid-month.
**Closure is automatic:** `close_due_batches()` closes (never archives) every open batch whose local
period has ended, one `auto_close` event each, idempotent via its `status='open'` predicate, scheduled
**hourly by pg_cron** (`cron.schedule('close-due-batches', '0 * * * *', …)`; hourly because pg_cron is
UTC and batches carry their own zones). It has **no `is_admin()` guard on purpose** — that guard is
precisely why `expire_overdue_subscriptions()` can never run under a scheduler — and is instead
revoked from every client role; `admin_close_due_batches()` is the admin/"Run closures now" path.
Closing blocks *new* assignments only: `grant_batch_run`'s carve-out still lets an existing
seat-holder renew, and no entitlement, space or history is touched. Client mirror:
[src/lib/batchLifecycle.js](src/lib/batchLifecycle.js), pinned by `test/batchLifecycle.test.mjs`.

- **Tables** ([db/2026-07-20-community.sql](db/2026-07-20-community.sql) #23 + the forum
  upgrade [db/2026-07-21-community-forum.sql](db/2026-07-21-community-forum.sql) #24, both
  folded into the bootstrap §15b): `community_tags` (10 seeded categories; `admin_only` =
  Announcements, enforced **in the insert/update policies**, and the tags read policy
  deliberately does NOT filter on `active` — the policy subquery depends on members seeing
  admin-only rows; the client filters `active` for pickers) → `community_posts` /
  `community_comments` (status `active|hidden|deleted`; **`author_name` +
  `author_avatar_url` denormalized** because non-admins can't read other profiles rows —
  the `enrollment_requests` precedent — but **stamped server-side by the SECURITY DEFINER
  `community_stamp_author()` trigger**, never trusted from the client) +
  `community_reactions` (`like|celebrate|helpful`; targets a post **or** a comment — XOR
  check + partial unique index; toggle = insert/delete own row). Forum columns on posts:
  `pinned` / `comments_locked` / `comment_count` / `last_activity_at` — **server-controlled**
  via `community_posts_guard()` (zeroes counters, blocks member pin/lock; admin-only tags
  are born locked) + `community_comment_rollup()` (recomputes active reply count, advances
  activity — powers the Unanswered filter + activity sort with no PostgREST embeds). New
  tables: `community_attachments` (image|video|link; files in the **private
  community-media** bucket, `<uid>/…` paths, batch-signed URLs), `community_post_tags`
  (free-form normalized slugs, ≤5/post), `community_notifications` (**no insert policy** —
  written only by the SECURITY DEFINER notify triggers that parse `@[Name](uuid)` mention
  markup out of stored bodies + fan out reply notifications; unforgeable; targets must be
  *mentionable* — named + approved — and repeats collapse into one unread row per
  actor/post/kind, which also caps bell spam),
  `community_announcement_reads` (per-member read markers; announcements are **react +
  mark-as-read only**, born `comments_locked`).
- **Avatars / mentions RPCs:** `set_my_avatar(p_path)` — the ONE sanctioned user-facing
  `profiles` write (SECURITY DEFINER; own `avatars/<uid>/…` path only; also back-fills the
  caller's denormalized `author_avatar_url`); `search_community_members(p_query)` — the
  mention-autocomplete directory (name + avatar, **never email**; nameless profiles are
  unmentionable). Avatars live in the **public `avatars` bucket** (getPublicUrl; legacy
  Google-OAuth full URLs still render via `resolveAvatarUrl`'s prefix branch).
- **Moderation:** members edit (through the composer modal) + **soft-delete** their own rows
  (no member DELETE policy; an author can never un-hide an admin-hidden post); admins
  pin/unpin, lock/unlock replies, hide/restore, **hard-delete** inline (hard-deleting a post
  also removes its community-media files — attachment files are never shared across posts,
  so no `removeMediaIfUnreferenced`-style refcheck). Member comment reads/inserts also
  require the **parent post to be active**, so hiding a post hides its whole thread and
  freezes replies; inserts on `comments_locked` posts are refused (reactions stay allowed).
  Keep `COMMUNITY_REACTIONS` (client) in sync with the SQL CHECK when the reaction set
  changes, and the client mention regex (`COMMUNITY_MENTION_SRC`) in sync with the SQL one.
- **Client:** `CommunityHub` (module scope, above `ProChat`) with the forum suite beside it:
  `MemberAvatar` + `resolveAvatarUrl` (THE shared avatar primitive — sidebar/rail/
  AccountMenu/settings/community all render through it), `renderCommunityBody` (mention
  chips + safe `https?://` auto-links — **no dangerouslySetInnerHTML anywhere**),
  `MentionTextarea`, `AttachmentGallery`, `CommunityTopicRow`, `CommunityCategoryRail`,
  `CommunityFilterTabs`, `CommunityRightRail`, `CommunityComposer` (AccountModal shell),
  `CommunityPostCard` (the detail view), and `useCommunityBell` + `NotificationBell`.
  `CommunityHub` keeps **zero props** (self-contained via `useAuth`) so the memoized
  `TabPanel` keep-alive is untouched; loads once on mount, then realtime INSERTs (new posts
  → a "new discussions" pill, not auto-prepend) + throttled focus refetch. Meta counts use
  the CourseCatalog client-reduce idiom. Missing tables → the "Finish backend setup" /
  "coming soon" card, with a **separate "#24 not applied" variant** on a missing-column
  error (42703/PGRST204) — a #23-only DB degrades to guidance, never a red error.
- **Notification bell:** `useCommunityBell(uid, enabled)` runs in the **root** component
  (same render gate as the voice assistant: admins + enrolled members) — bell state never
  threads through TabPanel; `NotificationBell` mounts in the sidebar identity card, the
  collapsed rail, and the mobile topbar, portals its dropdown through `OverlayPortal`
  (z-[65]) with the AccountMenu outside-click/Escape idiom, and navigates via module-scope
  `writeAppRoute('community', { postId })` (the `setPanelParam` no-prop-threading
  precedent). CommunityHub pokes it after read/mark actions via the `COMMUNITY_BELL_POKE`
  window event. Unread = own `community_notifications` + announcements minus own read rows
  (no per-member fan-out). Pre-#24 DB → the bell silently self-disables.
- **Profile pictures:** `AvatarSection` (self-contained, top of `ProfileSettingsBody`) —
  upload to `avatars/<uid>/<uuid>.<ext>` → `set_my_avatar()` RPC → best-effort cleanup of
  older files → `refreshProfile()`. `PROFILE_SELECT` already carries `avatar_url`.
  Delete confirms use `AccountModal`; the ⋮ menus use the house document-level
  `pointerdown` outside-click idiom. Setup + troubleshooting:
  **[COMMUNITY_SETUP.md](COMMUNITY_SETUP.md)**. Community data is in Supabase — nothing
  goes in `LEGACY_KEYS`.

### Student Imports (Super Admin — the legacy Thinkific migration) — `StudentImports`

The migration workspace for moving legacy paid Thinkific students into the Toolkit. Tab id
`studentimports`, route `/admin/student-imports` (+ `?job=<id>` to reopen a job), an admin-nav row
gated on **`students.legacy_migrate`**. Built by **#67**
([db/2026-09-25-legacy-student-migration.sql](db/2026-09-25-legacy-student-migration.sql), fold
**§54**) on the #26 tables. Runbook: **[STUDENT_IMPORT_SETUP.md](STUDENT_IMPORT_SETUP.md)**.

- ★ **SUPER ADMIN ONLY, AND THAT IS THE POINT.** `students.legacy_migrate` replaced `students.import`,
  which Operations Admin held. Activating a legacy student creates a real subscription and cohort
  seats with no payment recorded in this system — the `students.extend_access` reasoning (#47). The
  old key is DELETED, not left dead. 22 permissions / **34 grants** after #67 (23 / **35** since #69
  added `onboarding.manage`, Super Admin alone).
- ★ **STAGED IS NOT ACTIVATED.** A roster is staged once into a durable job; every row is then
  `inactive`, `ready` or `blocked` (`validation_status` and `activation_state` are separate columns,
  so a valid row can be deliberately inactive). Staging creates no Auth user, no subscription, no
  approval and no email. Only cohorts the Super Admin ticks at staging are `ready` (the UI pre-ticks
  the newest one); every other valid row is `inactive` until someone promotes it WITH A REASON.
- ★ **NOTHING IS GUESSED.** The date format is declared (`M/D/YYYY` / `D/M/YYYY` / `YYYY-MM-DD`,
  no default, four-digit years only, components range-checked). A plan comes from an explicit
  label→plan mapping; a batch from an explicit label→code mapping that must ALSO name the batch's
  month and fit the row's start date. The historical amount (₱15,999) is kept as history —
  `legacy_amount_paid` — and never touches today's price or Financial Management.
- ★ **THE BROWSER NEVER WRITES AN IMPORT TABLE.** Client INSERT/UPDATE/DELETE are revoked on all five
  tables; each keeps ONE SELECT policy on the new permission (`student_external_accounts` also keeps
  the member's own-row read). The browser sends parsed rows to `api/admin/student-imports.js`, which
  re-normalizes them with the shared [src/lib/legacyMigration.js](src/lib/legacyMigration.js) and
  calls `legacy_import_stage()`; SQL re-validates every row, recomputes the record key, and is the
  authority. `student_import_events` is append-only by trigger (with the FK SET NULL exemption).
- ★ **ONE LEGACY PURCHASE IS ACTIVATED ONCE.** `legacy_record_key` = sha256(`thinkific|` + external id
  or `email:` + normalized email + `|plan|batch_code`), with a partial unique index over
  `activating`/`activated` rows across EVERY job. The same roster staged twice reopens the first job
  (unique content fingerprint); a corrected roster stages its already-staged people as `duplicate`,
  and the remediation is discarding the old job — never a silent re-grant. A row whose purchase is
  already live in another row is blocked at the CLAIM (`duplicate_staged`), because letting the
  unique index abort the claim would wedge the whole run behind a bare `23505` on every retry.
  ★ **THE SAME ROWS READ DIFFERENTLY ARE NOT THE SAME JOB.** The fingerprint covers the cells, not
  how they were read, so re-staging to correct a date format or a mapping used to hand back the job
  staged with the WRONG one — and 11/10 misread as 10/11 still lands inside the batch window, so
  nothing downstream would notice. Staging compares the five settings and refuses with
  `LEGACY_JOB_SETTINGS_DIFFER`, naming which differ and the job to open or discard. Its advisory
  lock is keyed on the FUNCTION, not the content: two different files holding the same student could
  otherwise stage at once, neither seeing the other's rows.
- **Activation is a saga whose grant is one transaction.** `start-activation` takes selected READY
  ids — or FAILED ones, to retry — (any other id refuses the whole run, `LEGACY_ROW_NOT_READY`), a
  typed `ACTIVATE <n>` and a client
  key (a double click returns the same run); runs cap at 200 rows. Each `activate-chunk` request:
  claims a row (`for update skip locked`, a run lease, stale after 10 minutes > the 60 s
  `maxDuration`) → finds or `admin.createUser`s the Auth user (no email sent) →
  `legacy_import_bind_user` records it FIRST → `legacy_import_activate_row` does, in one transaction:
  the refusals (rejected profile, staff, live/scheduled membership, identity mismatch, term ended,
  archived batch), the subscription from the SOURCE dates in Asia/Manila (start 00:00, end the last
  millisecond of the end date, +3-day grace), the cohort run from the live registry via
  `grant_batch_run` (open start) or `legacy_import_grant_closed_start_run` (closed start — a two-edit
  copy, line-diffed by the tests), profile approval + paid cache, and the audit event → then the
  email. No enrollment request, no receipt, no finance posting. An Auth user is never deleted.
- ★ **A FUTURE START IS A `scheduled` SUBSCRIPTION.** See "Scheduled memberships" below.
- ★ **EVERY FAILURE HAS A WAY BACK, AND THAT TOOK THREE RULES.** A row is `activating` from its claim
  until the grant commits or the endpoint marks it failed, and the grant is ONE transaction — so a
  row still claimed after longer than any request can live was granted nothing.
  `legacy_import_fail_stale_claims()` (called by `release_run` and by `discard_job`, before its
  still-running check) turns it into a `failed` row; otherwise a killed function left a row that
  blocked Discard for ever, with Resume — i.e. activating it — the only exit. Retrying is a **NEW
  run with its own typed confirmation**, which re-queues the row at zero attempts (the 5-attempt cap
  is per run) and logs `row_requeued`, so neither an older run nor the cap can strand a row. And a
  run with nothing left to do is `completed` **even when Pause was asked for**: a run holds its rows
  against another run while running or paused, and a failed row is not "remaining", so a paused run
  whose only leftovers are failures would hold them beyond the reach of every button.
- ★ **ONLY AN ACCOUNT THIS IMPORT CREATED IS MARKED BEFORE THE GRANT.** `legacy_import_bind_user`
  stamps `account_origin='import'` + `onboarding_status='invited'` only when the import created the
  account — recognised by the `app_metadata.legacy_import_row_id` the endpoint sets, so a
  `createUser` that timed out yet succeeded is still known as ours on the retry. A PRE-EXISTING
  unconfirmed account (a real student's own signup, an unaccepted staff invitee) is stamped only by
  a SUCCESSFUL activation, in the grant's transaction. Marking it at bind time, ahead of
  `activate_row`'s refusals, left a refused account hidden from Access Requests, undecidable there,
  forced onto the set-password screen, and with nothing in Student Imports able to release it.
- **The claim link** is the staff-invitation design with its own module
  ([src/lib/importClaim.js](src/lib/importClaim.js)): `generateLink({ type: 'magiclink' })` →
  `hashed_token` only → `/activate-account#claim=<token>&t=magiclink`, read once at module load and
  stripped, redeemed by `verifyOtp` on a CLICK (single-flight ref lock) in `ImportClaimScreen`
  ("Activate your account"), then `IMPORT_ONBOARDING` → `AccountSetupScreen` → `IMPORT_WELCOME` →
  `ImportWelcomeScreen`. The token stays in the FRAGMENT, not the path the owner's brief sketched
  (`/activate-account/{token}`): a path token lands in Vercel's logs and `Referer` headers, and a
  mail scanner's prefetch would spend it. A confirmed existing account instead gets a
  sign-in notification with no token. Every mint is a new `invite_generation` and a new Resend
  idempotency key (`legacy-claim-<row>-<gen>`), because a fresh link can invalidate the old one.
  `UpdatePasswordScreen` also completes import onboarding, so a student recovering an expired link
  sets one password, not two. The email ([api/_lib/legacyClaimEmail.js](api/_lib/legacyClaimEmail.js))
  follows the owner's wording — name, email, batch, plan, start, expiry, the link — and says
  "already paid — nothing to buy".
- ★ **MIGRATION EMAIL IS SENT FROM THE VERIFIED DOMAIN AND ANSWERED AT support@alexsagun.com** (#68,
  owner decision 2026-09-28). The owner's Resend account verifies only the SUBDOMAIN
  `toolkits.alexsagun.com`, and Resend authorizes a From address against its exact domain, so #67's
  `support@alexsagun.com` sender was refused (403) for every email. `migrationAddresses()` in
  [api/_lib/legacyClaimEmail.js](api/_lib/legacyClaimEmail.js) now resolves two SEPARATE addresses:
  - **From:** `MIGRATION_EMAIL_FROM`, else `support@<the domain of RESEND_FROM>`, which today is
    `support@toolkits.alexsagun.com`.
  - **Reply-To and the printed support line:** `MIGRATION_REPLY_TO`, else `MIGRATION_SUPPORT_ADDRESS`
    (`support@alexsagun.com`, a monitored mailbox).

  ★ **They were one value in #67**, which meant the "obvious" env-only fix of pointing the sender at
  the subdomain would have moved every student reply onto a mailbox that does not exist. Every other
  flow still sends from `RESEND_FROM`.

  **Send test email** (`send-test`) mails the activation template (sample details, no token) to the
  calling Super Admin's OWN address, resolved server-side. It reports both addresses, a message per
  provider code, and whether Resend click tracking is on. Click tracking must be OFF: a tracked link
  carries the fragment token through Resend's redirect host. Readiness reports `senderProven`, which
  is true when the From domain equals `RESEND_FROM`'s domain, the one the other flows prove every day.
- ★ **SILVER AND ESSENTIALS ROSTERS (#68): A BATCH IS A VIP-ONLY FACT, AT EVERY LAYER.** #67 demanded a
  batch for every row in the browser, in `legacy_import_stage` and in the record key. Only activation
  knew better, so a Silver or Essentials roster could not be staged at all, and a batch-less row would
  have had a NULL record key, which the double-grant unique index and both duplicate checks skip.
  - Every rule now asks the mapped plan's `community_segment` first. A non-VIP row stores no batch;
    a batch label in its file is kept as history, with the warning `batch_ignored_for_plan`.
  - Its record key uses the literal `'none'` as the batch part (`NON_VIP_BATCH_TOKEN`). That cannot
    collide with a `YYYY-MM` code, and it keeps "one legacy grant per person per plan".
  - Ready is chosen per COHORT for VIP rows (`eligible_batch_codes`) and per PLAN for the rest
    (`student_import_jobs.eligible_plan_keys`). Both are staging settings the reopen comparison checks.
- ★ **COHORT SEATS ARE WHAT THE STUDENT PAID FOR, AND NO MONTH MAY BE MISSING (#68).** The owner runs
  this as a SaaS: some students pay months ahead, some renew monthly.
  - `legacy_import_seat_count(start, end, plan)` gives a VIP row one seat per whole month of its term,
    at least 1 and at most the plan's count. So a one-month payer no longer receives six cohorts.
    `legacySeatCount()` is the JS mirror.
  - The allocator only moves forward. So a month with no batch, sitting under a later batch that
    exists, would be skipped for good by every run that crosses it. The preflight names such months
    (`batch_gaps`), and `start_run` refuses with `LEGACY_BATCH_GAP` until the batch exists.
- ★ **BULK ACTIVATION STOPS ON THE FIRST SIGN THE EMAIL CANNOT GO (#68).** In #67 a refused sender,
  a bad key or a quota error was recorded as a failed invitation, and the run kept granting access.
  A whole cohort could be activated with no email delivered, and recovery was one click per row.
  - **The breaker.** `doActivateChunk` stops claiming on `email_not_configured`,
    `email_from_not_configured`, `resend_401`, `resend_403` or `resend_429`, or on two consecutive
    `resend_422`. It pauses the run and reports `stopped` and `code`.
  - **Hand-back.** Codes that prove nothing was sent return the row to `not_sent` through
    `legacy_import_record_delivery`, so Resume re-sends it.
  - **Bulk resend.** `resend-failed` re-sends a job's failed invitations; possibly-delivered rows go
    only when explicitly asked for.
  - **Daily allowance.** The preflight compares its email count with `MIGRATION_DAILY_EMAIL_CAP`
    (default 100, Resend's free plan).
  - **Permanent refusals.** An invitation `begin_invite` can never send (the account is gone, or the
    cap is reached) is recorded as failed instead of stalling the run. An account that already
    finished onboarding gets a sign-in notice.
- ★ **ACROSS ROSTERS THE HIGHER PLAN WINS, AND A GRANDFATHERED MEMBER IS NEVER TOUCHED (#68).**
  - `legacy_import_plan_rank()` (vip 3 > silver_self_paced 2 > sampler 1; mirror `planRank()`) holds
    back a lower-ranked row, as failed `higher_plan_pending`, while the same person has a higher one
    unactivated in a live job. Staging warns `other_legacy_row`, and the preflight lists overlaps.
  - A profile with `is_paid` and no subscription row (the pre-lifecycle grandfather) is blocked as
    `grandfathered_member`. Activating it would narrow unlimited access to a dated term, and Revert
    would then lock the member out, because the grandfather rule needs zero rows.
  - Revert deletes the row's Thinkific-id link. Purge also clears phones.
  - An account the import created whose activation is refused has its import marks cleared, so it
    becomes an ordinary pending signup rather than a hidden one.
  - An onboarded migrated account with no live term sees `IMPORT_MEMBERSHIP_PENDING`, a price-free
    hold, instead of the paywall.
- ★ **WHAT THE #68 ADVERSARIAL REVIEW CHANGED BEFORE PRODUCTION** (2026-09-29; 27 findings confirmed,
  none critical, two must-fix):
  - **Auth failures trip the breaker too.** Two consecutive `link_failed` (or `rotation_failed`)
    results stop the run as `auth_unavailable`. Without it, a broken `generateLink` granted terms with
    no email and spent an invite generation on the same rows every chunk until the cap of 20 made
    them uninvitable. A hand-back whose code proves NO provider request was made (`link_failed`,
    `app_url_missing`, the two not-configured codes) REUSES its generation; 401/403/429 never do,
    because a provider may replay a refused response under the same idempotency key.
  - **The onboarding notice keeps #67's bound.** A refund happens only when NEITHER email was
    delivered, `resend_422` is never refunded (it can be about one recipient), and
    `onboarding_notice_reservations` (0..20) is a ceiling a refund cannot touch and the Super Admin
    reset does not clear. Otherwise a malformed admin address re-sent the delivered half to the
    student every day after the 24 h idempotency window.
  - **A higher-ranked row holds a lower one only while it can still become a grant**
    (`legacy_import_higher_plan_pending()`: grace still ahead, and for VIP a live batch); the
    preflight returns `held_row_ids` so the confirm step says how many will be held.
  - **E8 is durable:** the password of a matched pre-existing unconfirmed account is rotated INSIDE
    `sendInvite` before the claim email; a failed rotation records `rotation_failed` and sends nothing.
  - **A 429 is classified** (`sendEmail`'s `classify429`: `limit: 'rate' | 'quota'` from the error's
    name/retry-after, never the body) so a per-second limit reads "Resume in a minute", not "wait for
    tomorrow"; and a 4xx on a RETRY after a timed-out attempt reports `resend_timeout` (ambiguous),
    never "nothing was sent".
  - `resend-failed` skips students who already onboarded (`skipped_onboarded`); the row panel and the
    bulk dialog never promise a row at the generation cap; keep-open buttons are `aria-disabled`.
  - **Bulk terms** (`MigrationBulkTermsModal`): a selection's inactive/ready/failed rows get a batch,
    package or dates in ONE audited `legacy_import_set_terms` call, sending only the fields set. This
    is how the 65 September 2026 rows move to October after that batch was archived.
  - `tierLabelFor(tierKey)` (`trainingAgreement.js`) is the only way a tier is printed; `parseCsv`'s
    duplicate-heading error carries `code: 'DUPLICATE_HEADER'` (`CSV_DUPLICATE_HEADER`) so the bank
    importer keeps its own "upload it as Excel" advice.
  - ★ **A matched PRE-EXISTING unconfirmed account the import did NOT create** (E8) gets a random
    password, but only AFTER a successful `activate_row`, which refuses staff. Doing it before binding
    would silently skip an unaccepted staff invitee's own password step, because
    `staff_invitation_state()` reads `has_password` from the stored password. The claim link then
    sets the student's real password.
- ★ **THE SUPER ADMIN ASSIGNS THE TERMS AT ACTIVATION.** The dialog is two steps: (1) the selection's
  terms grouped by plan, batch and dates, each changeable, then (2) the preflight and the typed phrase.
  Changes go through `legacy_import_set_terms()` (audited `terms_set` with before/after, validated,
  all-or-nothing) into `activation_plan_key`/`_batch_id`/`_start_date`/`_end_date`; the roster's own
  `legacy_*`/`proposed_*` values are never overwritten, and an override equal to the roster is stored
  as null. `legacy_import_activate_row`, the preflight and the rows page read
  `coalesce(activation_*, roster)`; the invitation reads the SUBSCRIPTION the row granted (so a resend
  after an extension quotes the new expiry, and a non-VIP plan names no batch). Continue saves the
  terms to the rows — the step says so — and a row already inside a running or paused run is refused
  (`LEGACY_RUN_BUSY`), because its typed confirmation showed the old terms; an unchanged row writes
  no audit entry. ★ **The confirm step sends the preflight's `row_ids`, never the raw selection**:
  the preflight excludes rows that stopped being ready or are held by an unfinished run, and a
  dialog that promised "left out" while sending them hit a whole-run refusal after the terms were
  saved. ★ **Open access on the activation day** (owner decision,
  2026-09-26): a group whose start is still ahead is offered "Open access today" PRE-TICKED, which
  moves only the start; the paid end date stays. The `scheduled` status remains for a start the
  Super Admin explicitly sets in the future.
- ★ **THE ACCOUNT PAGE AND THE SUMMARY.** `AccountSetupScreen`: name prefilled and editable, the email
  prefilled and `readOnly` (the sign-in identity; changed through support), password ≥ 8 and a
  matching confirmation. It calls `complete_import_onboarding(p_full_name)` — #26's no-argument form
  is DROPPED and replaced, never overloaded, so the old call still resolves — then
  `notifyImportOnboarded()`, then opens the one-time summary (`IMPORT_WELCOME`, root session state,
  price-free): name, email, batch, plan, status and expiry from `my_migration_summary()` (own row),
  and **Go To Dashboard**.
- ★ **THE TWO "YOU'RE IN" EMAILS RING ONCE, AND ONLY THE SERVER SAYS SO.** `api/notify-enrollment.js`
  action `import_onboarded` verifies the student's own JWT (the body carries nothing), then calls the
  **service-only** `legacy_import_onboarding_notice(p_user)` with THAT uid, which reserves the send
  (`sending`) and returns every fact; the endpoint emails the admin ("Student Successfully
  Onboarded", to the `NOTIFY_ADMIN_EMAIL` chain) and the student (account ready, dashboard link,
  subscription, support), both from the migration sender with keys
  `legacy-onboarded-{admin,student}-<row>`, then records `sent` (final) or `failed`. ★ It was first
  written as an own-row RPC granted to `authenticated` — which let a student call the RECORD half
  directly: mark `sent` so the admin is never told, or loop reserve → `failed` into the append-only
  event log. Revoked from every client role now; this is the one non-admin handler that builds
  `service()`, and only after `callerUser()`. A failed notice is retried by the root, once per
  session, for a migrated account whose setup is complete; at most five reservations per row. No new
  function file: the count stays at 11.
- **A phone is a hint, never an identity.** An optional roster column is stored (`legacy_phone`, digits)
  and shown; a phone shared with another row or an earlier enrollment request under a DIFFERENT email
  adds the non-blocking warning `phone_shared`. Accounts are matched by email only — linking by phone
  would hand a paid term to whoever owns the other address's login.
- **Activation refuses to start** unless email (`RESEND_API_KEY`), the app address (`APP_URL`) and a
  valid migration sender are all configured. ★ `APP_URL` is required on **every** Vercel deployment, not just
  production: the old sender fell back to `SUPABASE_URL` (links to the database host), and a
  Host-header fallback on a PREVIEW deployment — which shares production's database — would email
  real students links to a throwaway preview. The request's own origin is used only by `npm run dev`.
- **Access Requests** excludes, and `admin_review_access_request()` refuses
  (`ACCESS_REQUEST_IMPORT_TARGET`, no Super Admin exemption — the #51 rule), a profile that is
  `account_origin='import'` and still `pending`: the window between the Auth user and the grant.
- **Recovery:** `legacy_import_revert` (a scheduled term, or an unclaimed new account) cancels the
  term and revokes the run through `revoke_batch_run`; after a claim, change it from Enrollments.
  ★ It keeps the account, its approval and its import onboarding, so a claim link already sent still
  signs the student in. Since #68 an onboarded migrated account with no live or scheduled term is held on
  the price-free `IMPORT_MEMBERSHIP_PENDING` card ("your migrated membership is being set up"), never the
  paywall. The card re-checks on focus, because nothing pushes `profiles.is_paid`. The revert dialog says so.
  `legacy_import_purge_raw` removes names and emails from activated/reverted rows and from discarded
  jobs; provenance stays. #67 discarded and purged the four v1 jobs that never granted anything.
- The v1 grant path (`process`/`dry-run`, `computeImportTerm`'s fresh/lifetime modes, the private
  HTML-only Resend sender) is GONE. `communitySpaces.js`'s `resolveBatchForImport`/`batchGapForProcess`
  are no longer called by the importer.
- Suites: `test/legacyMigration.test.mjs`, `test/legacyMigrationSql.test.mjs` (dated file + §54, incl.
  the copied-body line-diffs and the "every live predicate requires `status='active'`" scan),
  `test/legacyClaimEmail.test.mjs`, `test/importClaim.test.mjs`, `test/enrollGate.test.mjs`,
  `test/gateMatrix.test.mjs`, `test/tokenLeakage.test.mjs`, `uiSafety` §27,
  `test-db/legacyMigration.dbtest.mjs`, and the `#67` block of `scripts/audit-db.mjs`.

### Scheduled memberships (#67)

`subscriptions.status` gains **`scheduled`**: a paid term whose start is still ahead. It is
import-only by CHECK (`grant_source='import'`, a `source_import_row_id`, a real `ends_at`), one per
member together with any active term (`subscriptions_one_live_or_scheduled`), and
`subscriptions_scheduled_guard` turns an approval beside it into the named
`MEMBERSHIP_SCHEDULED_CONFLICT` instead of a raw 23505.

- ★ **IT GRANTS NOTHING BECAUSE EVERY PREDICATE ALREADY REQUIRES `status = 'active'`** — and the
  grandfather branch needs zero subscription rows. No access function was restated.
  `test/legacyMigrationSql.test.mjs` scans the latest definition of every function that checks a
  term's dates and FAILS if one does so without the status — that edit would let a scheduled term
  through. **Never add a liveness check on dates alone.**
- It becomes `active` through `activate_due_scheduled_subscriptions()`: pg_cron every 15 minutes
  (no JWT guard, on purpose — #38's reasoning), `activate_my_due_membership()` (the student's own
  screen, own rows only), and `admin_activate_due_memberships()`. A due row beside a live active term
  is not flipped; it is logged once as a conflict.
- Client: `subAccess()`/`enrollGateState()` now live in [src/lib/enrollGate.js](src/lib/enrollGate.js).
  A scheduled term is neither valid nor expired, and `enrollGateState` returns `'scheduled'` BEFORE the
  `is_paid` branch (otherwise a paid scheduled student resolved to `expired` and saw Renew prices).
  `resolveGateScreen` maps it to `MEMBERSHIP_SCHEDULED` — not a pricing screen, so it never waits on
  the staff context and never becomes `PROFILE_UNAVAILABLE`. `MembershipScheduledScreen` shows the
  plan, batch and Manila dates, calls the self-heal on mount/focus/at the start, and shows no price.
- Capacity: `batch_seat_holders` counts live `active` terms only, so a scheduled student is not in a
  batch's occupancy until they start (imports are capacity-exempt anyway; the preflight shows both).

### [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx) — the entire app (~51.7k lines)

> Note: lines are long; prefer `Grep` over reading the whole file. Line numbers below are anchors,
> approximate as the file evolves.

| Region | Lines (approx) | Contents |
|---|---|---|
| Routing + shared AI helper | 20–~900 | URL/panel routing helpers (`TAB_ROUTES` L190, `readAppRoute` L347, `setPanelParam` L432), the voice-assistant literals (`VOICE_TAB_INFO`…), `callClaude()` (L873) — the single entry point every AI tool uses (see AI/proxy pattern) |
| Domain data | ~900–1490 | `COA_BASE` (L923), `COA_INDUSTRY` (L976), `INDUSTRY_NOTES` (L1196), `VENDOR_PATTERNS` (L1222), `COURSE_MODULES` (L1318), checklists, `TIPS` (L1466) |
| Design system + helpers | ~1490–1900 | colors `C` (L1495), `SHEEN` (L1549), `GLASS` (L1552), fonts `fontDisplay` (L1566) / `fontMono`, `downloadFile()` (L1578), `useCurrency()` (L1633), `CurrencyToggle()` (L1820) |
| Auth / enrollment / account infra | ~1900–11239 | gate screens (`AuthScreen` L1924 …), `isEnrollmentTableMissingErr` (L3882), `useEnrollmentGate` (L3945), **the Getting Started block (#69, ~L4091–6875)** — `GettingStartedContext` (L4124) → `useGettingStarted` (L4184) → `recordOnboardingCompletion` (L4332) → `usePauseWhenHidden` (L4367) → `useRecheckOnReturn` (L4407) → `GettingStartedPlayer` (L4528) → `GettingStartedBody` (L4746) → `GettingStartedScreen` (L4913, the gate) → `useReplayRecorder` (L5132) → `GettingStartedPage` (L5223) → `GettingStartedCard` (L5416), then the Super Admin half: `onboardingUploadTarget` (L5681), `sweepOnboardingFile` (L5710), `GS_EDITOR_SUBTITLE` (L5930), `GettingStartedVideoAdmin` (L5994); `submitSubscriptionRequest` (L6955), `OverlayPortal` + `AccountModal`/`SidePanel` shells (~L9023–9226), `AccountMenu` + the Account-Center components (`ProfileSettingsBody`/`AccountSettingsPanel`/`MembershipPlanModal`/`ExtendAccessModal`, ~L9227–10231), `VoiceAssistant` (L10638), the `renderToolContent` (L11156) switch + `TabPanel` (L11228) |
| Root component | 11239–~13619 | `BookkeeperProToolkit` (L11239): `tab` + `accountPanel` state, sidebar `DEFAULT_STAGES` (L11687) config, drag-drop reorder, rename/persist to `window.storage` (`sidebar:*` keys), the auth gate switch (with #69's `gsShellUid` / `gsGateUid` latches beside it), and the **keep-alive render** (`visitedTabs` map — the chokepoint, ~L13529). |
| Admin screens | ~13621–26663 | the shared admin kit (`AdminNotice` L13685 …), `AdminStaffRoles` (L14475), `AdminBatches` (L14823), Financial Management + its parts (`FINANCE_SUBTABS` L15513 … `FinancialManagement` L20136), `Communications` (L19536), `MeetingsTasks` (L21242), `BULK_EMAIL_RETRY_DELAYS_MS` (L21925) + `emailOutcomeUnclear` (L21937, the one email-outcome rule), `AccessRequests` (L21943), `AdminEnrollments` (L22322), `StudentImports` (L26563) |
| Tool components | ~26664–end | `RestrictedTab` (L26672) + the chokepoint's `tabAccessView` (L26792) / `TabAccessCheck` (L26800), `MembershipPanel` (L26821), `Dashboard` and ~60 self-contained functional components |

**Notable tools → approximate line:** `Dashboard` 27138 (`GettingStartedCard` sits under its hero), `ProgressRankings` ~27835 (the `progress`
tab — learner report + leaderboard + staff report), `CoaGenerator` 28179, `Course` 28282,
`CourseProgram` ~31061 (single-course Supabase video engine — builder + PDF certificate; the shared
private-video plumbing sits above it: `signPrivateVideo` 28874 → `lessonVideoInStorage` 28903 →
`PRIVATE_VIDEO_SIGNERS` 28919 → `SignedLessonVideo` 28974 → `LessonVideoUploader` 29441),
`CourseCatalog` ~33763 (prefix-parameterized multi-course catalog) + the `QBOMastery` (`qbo-`) /
`InterviewStrategyCatalog` (`interview-`, the `winstrat` subtab) / `ResumeStrategy` (`resume-`) wrappers right after it,
`BankFeed` 36340, `StatementConverter` 36539, `CommunityHub` ~39249 (the community forum — see the
Community section above; the forum suite `MemberAvatar` 37049 → `useCommunityBell` 38583 →
`CommunityPostCard` 38877 sits above it), `ProChat` 41124,
`AuthenticBranding` 42288, `CoverLetterGenerator` ~43138 (tab id `proposal`, route `/proposal-generator` —
replaced the old 7-document-type `ProposalGenerator`; paste a job post → industry auto-detect → 3 letter
variations + a timecoded video-intro script + an interview-prep pack from ONE `callClaude` call at
`max_tokens: 8000`. Pure logic lives in `src/lib/coverLetterIndustry.js` (industry table + keyword
detector) and `src/lib/partialJson.js` (tolerant JSON + truncated-prefix recovery), both covered by
`npm test`), `BookkeeperPortfolioGenerator` ~34698 (tab id `portfoliogenerator`, route
`/profile-optimization/portfolio-generator`, sidebar Job Application → Profile Optimization between
Resume Winning Strategy and Book 1-on-1 — a **two-pane authoring workspace**: 13 editor sections on
the left, a live sandboxed preview on the right, and a download in **two formats** — one
self-contained HTML website or a static A4 PDF — behind **one export gate** that refuses an empty or
incomplete portfolio. 9 themes, 10 industry presets, optional PDF résumé import, optional photo.
**Fully offline — no Supabase, no `callClaude`, no `api/` route, nothing uploaded**, which is
deliberate: the inputs are a CV and a headshot. Presets live in `src/data/portfolio-generator.js` and
the whole engine in `src/lib/portfolioGenerator.js`; **both are lazy-loaded together** by
`loadPortfolioGeneratorModules`, `pdfjs-dist` is a third dynamic import that only fetches when
somebody picks a résumé, and `jspdf` + `html2canvas` load only when somebody chooses PDF. Layout is
the `.pf-tool` **container query** in `src/index.css`, not a media query. Pinned by
`test/portfolioGenerator.test.mjs` (197 tests, incl. source scans of all seven wiring sites, both
iframe sandboxes and the export flow)), `EngagementLetter` 43804, `EmailTemplates` 44353,
`PainPointsGenerator` 44606, `IndustryAccounting` 44966, `USTax101` 45102,
`MonthlyWorkflow` 45196, `MonthEndChecklist` 45286, `InvoiceCreator` 45517, `CoachAlexChat` 46009,
`CPAAIChat` 46039, `AccountingCalculators` 46841,
`LinkedInOptimizer` 46903, `MockInterviewSimulator` 47064 (a **guided-video + external-link page** —
admin-uploaded explainer video + a "Open Mock Interview Simulator" button to the external
`https://app.sesame.com/`; Supabase-backed via the `feature_guides` table — **not** the old internal
AI simulator. The CTA is **gated behind watching the guide video** — grey/disabled until the video ends
[native `<video>` / YouTube IFrame API / Vimeo SDK via the `GuideVideoPlayer` child], then blue; per-user
completion persists in `feature_video_completions` and re-locks when the admin replaces the video. It
takes an **`embedded`** prop and now renders as the **2nd sub-tab inside `InterviewPrep`** (Job Interview
Mastery), not a standalone sidebar item; when `embedded` it drops its own `SectionHead`. The legacy
`mockinterview` tab id is kept only as a defensive render-switch redirect → `<InterviewPrep initialSub="mock" />`),
`DiscoveryCallSimulator` 47472,
`SOPGenerator` 47779, `ClientHealthScore` 48444, `CapacityPlanner` 49528, `PaymentTracker` 49712,
`QBDiagnostic` 50464. (Note: `ClientHealthScore`,
`CapacityPlanner`, and `PaymentTracker` are among ~10 components currently defined but wired to no
route/sidebar entry — see the 2026-07-14 cleanup audit; pending a product call to delete or restore.)

### Navigation model

A single `tab` string in the root selects which tool renders, and navigation is **URL-routed +
keep-alive** (see below). Four pieces must stay in sync when adding/removing a tool:

1. **Sidebar config** (`DEFAULT_STAGES` array): `{ id, number, label, groups: [{ key, label, tabIds }], tabs: [{ id, label, icon }] }`. Each group carries a stable `key` (label-independent — see below).
2. **`renderToolContent(tabId, handlers)`** — a `switch (tabId)` at **module scope** (just above the root component) that returns each tool's element; `handlers` carries the few props tools need (`goto`, the admin badge refreshers `onAccessCount` / `onEnrollCount` / `onImportCount`, #69's `onOnboardingHealth`, and `interviewSub`). It is rendered through the memoized **`TabPanel`** (see keep-alive below). This replaced the old in-root `renderTabContent` closure and, before that, the `{tab === 'id' && <Cmp/>}` chain.
3. **`TAB_ROUTES`** (module scope, top of file) — maps each tab id to a stable URL path (e.g. `qbomastery → /courses/quickbooks-online-mastery`). Powers deep-linking, refresh, and "open in new tab"; `VALID_APP_TABS` is derived from it.
4. **Dashboard roadmap tiles**: optional `{ id, label, desc, icon, color }` entries.

**Navigation is URL-routed and state-preserving:**
- `readAppRoute()` / `writeAppRoute()` / `tabHref()` (module scope) sync the active tab — and a few
  inner states (`?sub=` for `InterviewPrep`, `?course=<id>` + `?lesson=<id>` for a catalog (the
  lesson deep-link the voice trainer's `open_course_lesson`/citation chips use), `?panel=` for the account
  surfaces) — to the URL via the History API. `?panel=` has **five canonical values**
  (`settings | membership | upgrade | extend | renew`), normalized from aliases by
  `ACCOUNT_PANEL_ALIASES`/`normalizeAccountPanel()` (`profile`→settings, `plan`/`billing`→membership,
  `renewal`→renew, …). It is orthogonal to tab routing, so it has its **own** writer
  `setPanelParam()` (mutates only the `panel` key on the live URL, preserving path + all other
  params; open = pushState so Back closes, close/switch = replaceState; fires the
  `bookkeeper:route-change` event so the root re-syncs) rather than the tab-centric
  `tabHref`/`writeAppRoute` (which rebuild the query from the tab base and would drop it).
  A root strip-effect clears a deep-linked **billing** panel the account can never render
  (admin, or enrollment flag off) so the param never strands in the URL — deliberately not keyed
  on gate state, so a pending student's `?panel=settings` still opens after approval.
  `vercel.json` rewrites all non-`/api` paths to `/`, so pretty-path deep links never 404. The
  root seeds `tab` from the URL at mount (`initialRouteRef`) and handles Back/Forward via a
  `popstate` listener (which also re-syncs `accountPanel`).
  ★ **The bare root URL ALWAYS renders the Dashboard, and there is no "resume last tab".**
  A `nav:lastTab` restore effect used to redirect `/` to whatever the user last opened and rewrite
  the address bar with `replaceState` while doing it. It was removed on 2026-09-03 because both
  halves were broken: its deps were `[user?.id]`, so the `entitlement` it closed over came from the
  render in which the uid first appeared — before `enroll.ready`, before `staffReady`, usually
  before the profile — where `planEntitlement(null)` is **FULL**, making the "skip a tab their plan
  can't open" guard permanently inert; and its sibling writer persisted `tab` on the **first
  commit**, seeded from the URL, while the gate was still showing a splash, so one deep-link visit
  to `/courses/quickbooks-online-mastery` permanently made `/` open the course catalog. The key is
  gone from `LEGACY_KEYS` too. `test/uiSafety.test.mjs` §17 pins its absence.
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
  props are referentially stable (`setTab`/`rememberScroll` are `useCallback([])`, each badge refresher
  a `useCallback` on its own capability boolean), so **hidden panels skip every root re-render** — only the active tab
  re-renders, and a tab switch reconciles exactly two panels. Don't pass a TabPanel a prop that changes
  identity per render or you silently re-enable app-wide re-renders. `visitedTabs` is deliberately
  **never pruned** (unmounting a hidden tab would kill in-flight AI work — accepted memory trade-off).
  Per-tab scroll is saved/restored via `sessionStorage` (`nav:scroll:<tab>`). **Plan gating rides
  here:** this same `visitedTabs.map` is the entitlement chokepoint — a tab the user's plan can't open
  renders `RestrictedTab` instead of its `TabPanel` (see the "Plan-based access" bullet in
  Authentication). The sidebar/tiles are filtered cosmetically; this render is the real boundary.
  ★ **The chokepoint asks the pure `tabAccessView(tabId, { settled, adminAllowed, planAllows })`**
  (T12B-D1), which answers one of four views. `'checking'`: an ADMIN tab (one listed in
  `ADMIN_TAB_PERMISSION`) before `my_staff_context()` has answered (`settled = staffReady ||
  staffDegraded`; AuthProvider gives up at 8 s) renders the neutral `TabAccessCheck` ("Checking your
  access…", `role="status"`), never a refusal. `'panel'`: the tool. `'role'`: a refused admin tab
  renders `RestrictedTab reason="role"` — "Your account can’t open this screen", naming the viewer's
  active staff role or saying no membership plan includes it, with Back to Dashboard only and nothing
  for sale. `'plan'`: any other refused tab gets the plan upsell, unchanged. Who sees a panel is
  unchanged; before it, a deep-linked admin tab flashed the plan upsell at a Super Admin until the
  staff context landed, and a staff member refused by ROLE was told to "Upgrade or renew".

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
  ★ **A new default tab in a FLAT stage needs no layout-version bump.** `mergeStoredWithDefaults`
  re-inserts a default the saved layout predates at its default-RELATIVE position — at index 0 when it
  has no earlier neighbour, ahead of a student's own order, which it leaves intact. That is how #69's
  **Getting Started** became the FIRST Home item in every saved layout. Pinned by
  `test/sidebarLayout.test.mjs`.
- ★ **GROUPED STAGES PERSIST THEIR OWN ORDER SINCE v5, AND UNTIL THEN THEY SILENTLY COULD NOT.**
  A grouped stage renders from `groups[].tabIds` — `stage.tabs` is collapsed to an id→object
  dictionary first, so its array order is discarded — and `mergeStoredWithDefaults` re-stamped
  `groups` from the code defaults on every load. So a drag inside Job Application or Client
  Management mutated `stage.tabs`, persisted faithfully, and changed **nothing on screen**, while
  the same drag in flat Training worked. The owner reported it as "rearranging only works under
  Training". The old suite pinned the behaviour as intended, in two tests.
  `stagesToStorable` now writes `groups: [{ key, tabIds }]` — **stable keys and ids only**, never
  labels (global in `sidebar_settings`; a per-browser copy would shadow an admin rename) and never
  icons. **Group ORDER and MEMBERSHIP still come from the defaults**; only the order of tabs WITHIN
  a group is user data, which keeps the reconciliation total — a stored id is accepted only into the
  group `DEFAULT_STAGES` assigns it to, so a corrupt layout can reorder a group but can never move a
  tab between groups or strand one. For a grouped stage `tabs` is then **derived** from `groups`,
  which also fixes the collapsed icon rail (it renders `stage.tabs` flat for every stage) silently
  disagreeing with the expanded nav.
- ★ **REORDERING IS NOT MOUSE-ONLY, AND CANCEL NOW CANCELS.** HTML5 drag-and-drop cannot be operated
  from a keyboard and is unusable on touch, so the ⋮⋮ grip is a convenience and the per-row
  **Move up / Move down** buttons are the real control; every move is announced through an
  `aria-live` region, and so is every refusal. A cross-group or cross-stage drop is REFUSED by
  `reorderVerdict()` rather than applied — the old handler spliced the tab into another stage's
  `tabs`, where no group's `tabIds` named it and `.filter(Boolean)` dropped it, so the tab vanished
  with no error and only a Reset brought it back. And the layout is no longer persisted while
  Customize is open: the write used to fire on every drag, so Cancel was a lie. Snapshot on entry,
  commit on Done, restore on Cancel.
  ★ **THE EDGE BUTTONS ARE `aria-disabled`, NEVER `disabled`, AND THEY ARE 24×24.** A browser blurs
  a focused element the instant it becomes disabled, so pressing Move up until a tab reached
  position 1 threw a keyboard user out to `<body>` mid-reorder. Left focusable, the press falls
  through to `moveTabByStep()`, which already refuses with `at-edge` and already announces it — the
  refusal wording is direction-aware ("… is already first in Interview"), built by
  `announceTabEdge()`, which is its own function **beside** `announceMove()` so `moveTab` stays free
  of `effLabel` and uiSafety can keep asserting that ordering logic never reads a visible label.
  The targets were `p-0.5` around a 13px icon — about 17×17, under WCAG 2.2 SC 2.5.8's 24×24 floor,
  on the one device that cannot drag at all: below `lg` the sidebar IS the off-canvas drawer.
  ★ **A CROSS-GROUP DRAG IS NOW REFUSED WHILE IT IS STILL A DRAG.** `onTabDragOver` set
  `dropEffect = 'move'` over every row, so an illegal drag showed a legal-looking cursor the whole
  way and explained itself only after the drop had failed. It asks the same grouping the drop does
  and sets `'none'` plus a dashed invalid outline.
  ★ **WHOLE STAGES REORDER THE SAME WAY (`moveStageByStep` / `stageReorderVerdict`).** `onStageDrop`
  was the last hand-rolled splice in the sidebar — no arbiter, no refusal, no announcement and
  drag-only, i.e. exactly the shape the tab path was rescued from.
  ★ **RESET IS STAGED LIKE EVERY OTHER EDIT, SO CANCEL STILL CANCELS.** Reset used to null the
  snapshot, which made `cancelSidebarEdit`'s `if (layoutSnapshotRef.current)` false — so Cancel left
  `DEFAULT_STAGES` in place and the persist effect wrote it. A button labelled Cancel committed the
  change it appears to undo. (The LABEL half of Reset is a Supabase delete and is genuinely
  immediate; the confirm text says which half is which.) And the `beforeunload` guard now counts a
  pure reorder as an unsaved edit — it keyed on `draftLabels` alone, written when only labels were
  staged, so reordering ten tabs and closing the tab lost all of it with no prompt.
  ★ **FOOTER COPY: TWO REACHES, NOT THREE.** It said tab order "saves for you on this account" beside
  collapse state that "stays on this device", drawing a distinction the app does not implement —
  `window.storage` is localStorage namespaced per user (`src/main.jsx`), so both are per-user AND
  per-browser and only labels are global. "On this account" reads as a sync promise that was never
  built; the copy and the success toast now both say "in this browser". Pinned by `uiSafety` §22.
- ★ **The admin links scroll; only brand + identity are fixed.** (Shipped alongside #64, but it is a
  UI-only change with no SQL — it is *not* a member of the numbered migration chain, where `#64` means
  `finance-daily-income` and nothing else.) The expanded `<aside>` is three
  flex rows: a `flex-shrink-0` header (logo, collapse, identity card with bell/theme/account menu, the
  "Access until" line), the `<nav aria-label="Main navigation">` scroller (`flex-1 min-h-0
  overflow-y-auto`), and a `flex-shrink-0` footer (tagline + **Customize**, which becomes
  Done/Cancel/Reset in edit mode). The capability-filtered `adminNavItems` render as a collapsible
  **Administration** group at the top of the scroller — `aria-expanded`/`aria-controls` toggle, rows
  still `<a href={tabHref(id)}>`, open/closed persisted per user as `sidebar:adminExpanded` (in
  `LEGACY_KEYS`), auto-opened when the active tab is an admin tab. They used to sit in the fixed header,
  and every admin screen added (#58, #61, #62) shortened the scrolling nav until a 1280×720 laptop showed
  a sliver of the courses. The collapsed rail and the mobile drawer are the same `<aside>`, and
  `adminNavItems.map(` appears exactly twice **inside the `<aside>`** (group + rail) — file-wide there
  is a third, non-rendering use that builds the auto-open key. Both `<nav>`s carry
  `aria-label="Main navigation"` and both sets of rows carry `aria-current`: only one is ever
  rendered-and-visible per breakpoint, so neither is left unnamed. Pinned by `test/uiSafety.test.mjs` §20;
  do not edit the `adminNavItems` literal's row spacing — two SQL-suite regexes read its order.

## Authentication (Supabase — Phase 1)

The whole app sits behind a **Supabase email/password auth gate**. Anonymous visitors see a
full-screen login/signup screen; only signed-in users reach the toolkit.

- **Provider/hook:** [src/auth/AuthProvider.jsx](src/auth/AuthProvider.jsx) wraps the app in
  [main.jsx](src/main.jsx) (inside `<AppErrorBoundary>` — see the Deployment section). Any component
  reads auth via `const { session, user, profile, loading, profileReady, profileFailed, configured,
  signUp, signIn, signOut, resetPassword, refreshProfile } = useAuth()`.
  **`profileFailed`** is "the first profile read for this user ERRORED", which is deliberately NOT
  the same fact as "this account has no profile row" — the fetch fails open, so only this flag can
  tell the gate that an unknown identity must not be quoted a price. See the auth-gate bullet in
  "Keeping docs current".
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
  `<PendingApprovalScreen/>` (active only when enrollment is off or not migrated). (The ordering now
  lives in the pure `resolveGateScreen()` in `src/lib/gateScreen.js`, #49 — see "Changing WHO the auth
  gate holds".) After every hold, #69 adds a last arm that decides NO access: a newly approved student
  who must watch the **Getting Started** video sees `GettingStartedScreen` once before the dashboard,
  and that arm fails OPEN — see "Getting Started onboarding video (#69)". `AuthScreen`
  (defined just above the root component) is the login/signup/reset UI, built from the design
  tokens (`C`, `SHEEN`, `GLASS`, `fontDisplay`, `LOGO_DATA_URI`).
- **Admin-approval gate (temporary, Phase-1.5):** new email/Google signups default to
  `approval_status='pending'` and are held on `PendingApprovalScreen` until an admin approves them in
  the **Access Requests** admin tab (`accessrequests` route; admin-only sidebar entry + pending-count
  badge; component `AccessRequests`). Approve/reject goes through the SECURITY DEFINER
  `admin_review_access_request()` (gated on `access_requests.review` since #45, which revoked the
  direct `profiles` UPDATE — users still can't self-approve), then emails the user via the
  **env-gated** serverless fn `api/notify-access.js` (Resend; non-fatal if `RESEND_API_KEY` /
  `RESEND_FROM` unset). ★ **Since #69 the browser sends ONLY `{ userId, status }`, after the decision
  has committed.** The function reads that account's own row with the REVIEWER's JWT
  (`profiles_admin_select` admits `access_requests.review` holders — no service client, no new SQL),
  mails the row's `email`, refuses (409) unless the row's `approval_status` IS the decision being
  announced, refuses a migrated account still being set up (`ACCESS_REQUEST_IMPORT_TARGET`), answers
  503 — never "not found" — when the read itself failed, and logs status codes, never the provider's
  body. It used to take the address, name and reason from the body: the hole `decision` closed on
  2026-09-24. Its approved copy no longer promises a dashboard (an approved signup who has not paid
  is asked to choose a plan). Pinned by `test/notifyAccessDecision.test.mjs`. ★ **A body that names
  a decision but carries no `userId` is a STALE CLIENT (TDR-7):** a page opened before #69 posts
  `{ email, fullName, status, reason }`, and it is refused as 400 `{ code: 'stale_client' }` —
  recognised by the missing `userId`, the body's email never read — and logged as `[notify-access]
  refused a decision with no userId …`, with no address. The decision itself is already recorded;
  only its email is lost, and the stale tab reads ` · email not sent` (see Deployment). The panel's
  notice ends with what became of the email: ` · email sent`; ` · email already on its way` (a 200
  `{ ok: false, skipped: 'in_flight' }`, answered ONLY when the provider's 409 is named
  `concurrent_idempotent_requests` — another request is still sending that same decision's email; not
  an error); ` · email not configured`; ` · email may not have been sent` (NO clear answer: a 502
  whose code is `resend_timeout`, `resend_failed`, a provider 5xx or none, a 504, or a request that
  never answered — `emailOutcomeUnclear()`, the ONE rule Access Requests and Enrollments share
  (T9V-L2, EMAIL-4, TDR-5) — so it may have been delivered); or ` · email not sent` (a clear no). Any
  OTHER provider 409 is a refusal, 502 `{ code: 'resend_409' }`, and so reads ` · email not sent`:
  `invalid_idempotent_request` (this decision's key was already used with a different payload, so an
  email for it went out earlier), or a 409 whose body cannot be read. The Enrollments decision notice
  uses the same endings (sent / already on its way / may not have been sent / not sent / not
  configured): a 502 is read for its code; a 504, or a request that never answered, is unclear. Backend
  defense-in-depth: `public.is_approved()` gates the course/feature
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
  overdue row); **Approve** (since #32) is ONE transactional admin-guarded RPC —
  `admin_finalize_enrollment(p_request_id, p_batch_id)` — that validates request status + plan +
  batch (VIP needs an open batch; capacity checked under a batch lock) and atomically grants
  the **dated subscription term** (wrapping `approve_subscription()`/`approve_extension()`),
  stamps `subscriptions.batch_id`, patches the profile cache, and marks the request approved.
  **The old client-side 3-step approve + its local-grant fallback are GONE** — a missing #32
  surfaces setup guidance and grants nothing (never re-add a client fallback: it would bypass
  batch/capacity validation); **Reject/
  expire** keeps the student blocked with a resubmit path. Receipt preview uses `createSignedUrl`
  (the app's **first** signed-URL use — everything else is public-bucket `getPublicUrl`). Emails
  via env-gated `api/notify-enrollment.js` (`RESEND_API_KEY`/`RESEND_FROM`, optional
  `NOTIFY_ADMIN_EMAIL` + `APP_URL`). Four actions: `submitted` (**TWO emails** — the
  admin alert, then, only once the alert has succeeded, a student confirmation carrying the
  processing-hours SLA and, for a NEW enrollment only, the onboarding video `ONBOARDING_VIDEO_ID` — a
  hardcoded YouTube id in `api/notify-enrollment.js`, unrelated to #69's in-app Getting Started video.
  The SLA is **not** hardcoded — since 2026-08-23 it is `ENROLLMENT_PROCESSING_NOTE`, **imported**
  from `src/lib/enrollmentIntake.js` so the pending screen and the email physically cannot state
  different turnarounds (see "Changing the enrollment processing-hours copy" below). Neither is
  admin-editable like the `payment_settings` copy on the same screen — move them there if they must
  change without a deploy. JWT-ownership auth: the row is re-read with the student's own JWT.
  ★ **#69: THE STUDENT COPY GOES ONLY TO THE ACCOUNT'S `profiles.email`** — never to the
  `enrollment_requests.email` the student types, which let any signed-in account have the business's
  branded email delivered to a stranger — and with no readable account address there is no student
  copy at all; the admin alert still goes. ★ **The facts are read server-side, best-effort, each
  bounded at 4 s** and all with the student's JWT: the ACCOUNT (the alert's "Email" is the account
  address; a different name or address typed on the form shows beside it, labelled as such), the
  PACKAGE — name, tagline, price, length and `entitlement_summary` scope — from `enrollment_plans` by
  `plan_key` (the row's own `plan_name` snapshot stands in for the NAME only when that read fails, and
  the price, length, scope and cohort lines are then left out), the KIND from `request_kind` (new /
  renewal / upgrade / extension; an extension states its days, and a row recorded `new` still reads as
  a renewal when the student has held a term before), and the COHORT, a VIP fact read from the plan's
  `community_segment`, never its key. None of them can block or skip the admin alert),
  `decision` (admin→student — ★ since 2026-09-24 the body names ONLY `{ requestId, status }`; the
  row is read with the reviewer's own JWT, the RECIPIENT is the student's `profiles` row (never the
  student-typed `enrollment_requests.email`), and the send is refused (409) unless `status` is the
  decision actually recorded. It used to take `email`/`fullName`/`planName`/`reason` from the body,
  so any `enrollments.review` holder could send the business's own "your enrollment is approved" email
  to any address with any text — the #61 rule, "the page describes, the server resolves", now holds
  here too. ★ **#69: what an approval STATES comes from `enrollment_decision_email_facts()`**, asked
  with the reviewer's JWT — the catalog's package name, the **Manila** day the granted term runs to,
  the cohort, and the Getting Started sentence only when the server says `getting_started_required ===
  true` — and never "everything is unlocked", which was false for Essentials. Only a term that is
  active or scheduled with its end still ahead is ever stated; a term not yet open says when it opens,
  carries no sign-in button and no Getting Started sentence; a rejected or expired decision states no
  term at all. ANY facts failure — a pre-#69 database, a 5xx, a timeout, an answer about another
  decision — sends the generic copy rather than refusing a decision that was recorded. Pinned by
  `test/notifyEnrollmentDecision.test.mjs`), plus `test` (admin-only diagnostic → the **"Test email"**
  button in the Enrollments toolbar; verifies the admin JWT server-side and reports
  sent/not-configured/provider error — it stays on the raw `sendResend` so the provider's own detail
  reaches the admin) and `import_onboarded` (#67, the migration's own addresses). The admin
  **recipient** resolves `NOTIFY_ADMIN_EMAIL` → the admin-editable `payment_settings.notify_email`
  ("Proof / support email" field, read with the caller's JWT) → address in `RESEND_FROM`; the GET
  health check reports `{ ok, hasKey, hasFrom, adminRecipient }` (env-only, no address).
  ★ **#69's sending rules, for the alert, both student-facing enrollment emails and the access
  decision:** every one goes through `sendEmail()` (`api/_lib/email.js`) with a **text part**
  (`plainTextEmail()`, built from the same object as the HTML, every link spelled out, every row
  folded to one line so a typed value cannot forge a row of its own) and a **STABLE idempotency
  key** — `enrollment-submitted-admin-<id>`, `enrollment-submitted-student-<id>`,
  `enrollment-decision-<id>-<status>-<epoch ms of the request's reviewed_at>`,
  `access-decision-<userId>-<status>-<epoch ms of the recorded decision>` — so a double click or a
  retry is one email. ★ **A decision made AGAIN is a new email (EMAIL-2, TDR-4).** A request a Super
  Admin reopens (#66) and decides again — a corrected reason, a re-approval that stacked a new term —
  used to meet a provider 409 for 24 h under the old key, and was reported "already on its way" while
  nothing was sent. `reviewed_at` is stamped by `admin_finalize_enrollment` (`now()`) and by both
  decline paths; a row with no readable moment keys on `'0'`. A key must match `[A-Za-z0-9:_-]{8,128}`:
  `sendEmail()` SILENTLY swaps any other for a random UUID, which is why timestamps are epoch ms,
  never ISO. ★ **Only a provider 409 NAMED `concurrent_idempotent_requests` answers
  `{ ok:false, skipped:'in_flight' }`,** and it is NOT recorded, so it can never overwrite an earlier
  `sent`. Resend also answers 409 `invalid_idempotent_request` when a key was already used with a
  DIFFERENT payload. Both decision handlers answer that, and a 409 whose name cannot be read, as a
  refusal: 502 `{ code: 'resend_409' }`. `submitted` records it as `provider_unclear`, because under the
  request's own key it means an alert for that request already went out. `sendEmail({ classify409:
  true })` adds `conflict: 'in_flight' | 'payload' | 'unknown'`, from the pure `resendConflictKind()` in
  `api/_lib/email.js`; without the flag the answer stays the bare `{ ok:false, code:'resend_409' }` that
  `commSend.js`, the migration and the onboarding notice rely on. ★ **The text part's fold covers
  EVERY Unicode mandatory line break** — CR, LF, VT, FF, NEL (U+0085), LINE SEPARATOR (U+2028) and
  PARAGRAPH SEPARATOR (U+2029) — through `foldLineBreaks()` in `api/_lib/email.js` (EMAIL-3). It finds
  each whitespace run once (`WHITESPACE_RUN`, NEL included) and folds it to one space only when it holds
  a mandatory break (`MANDATORY_BREAK`), in LINEAR time (EMAIL3-PERF): the single regex it replaced
  backtracked quadratically on a long run of spaces with no break (80,000 spaces: 18 s), and the folded
  values include student-typed columns with no length CHECK. `test/notifyEnrollmentSubmitted.test.mjs`
  pins 100k spaces under 1 s, and the same output as the old pattern on all 16,104 strings of up to four
  characters over the relevant alphabet. `notify-enrollment`'s `clean()` and `notify-access`'s greeting
  fold NEL by name, because JS's `\s` does not include it. ★ **Both decision emails have TWO burst
  guards** (`notify-enrollment`'s `decision` and `notify-access`), each per warm instance and run after
  the decision is verified. The first counts sends of ONE decision, never a reviewer's run of decisions:
  10 a minute, keyed `<reviewer id>:<decision key>` (EMAIL-1). Keyed on the reviewer alone, it answered
  429 to every email after the tenth of a bulk approve or reject in a minute, while the dialog said "the
  student is emailed". The second caps ONE reviewer's decision emails at 60 a minute, every decision
  together (key `decisions:<reviewer id>`, `REVIEWER_DECISIONS_PER_WINDOW`; EMAIL1-R1), checked AFTER the
  per-decision guard, so a loop on one decision never spends it. It exists because neither the decisions
  themselves nor the provider's 24-hour de-duplication bound the volume: an `enrollments.review` holder
  can re-stamp `reviewed_at` on a decided request (#48's column grant; #66 locks only the status), and
  `admin_review_access_request()` re-stamps `approved_at`/`rejected_at` on every call — each re-stamp is a
  new key. A bulk run goes one row at a time (about 1.5–3 s a row) and stays far below 60; one that
  reaches it gets 429, which the Enrollments bulk run waits out. `submitted`, `import_onboarded` and
  `test` keep the per-caller guard. A student-facing email's
  **Reply-To** is `studentReplyTo()`:
  `payment_settings.notify_email` → `NOTIFY_ADMIN_EMAIL` → omitted — **never `RESEND_FROM`**, typically a
  no-reply mailbox — and with no Reply-To the copy drops its "just reply to this email". **Links** use
  `APP_URL`; on Vercel there is NO fallback (a preview deployment shares production's database), and
  the request's own host is trusted only by `npm run dev`. The alert's button opens
  `/admin/enrollments?request=<id>`: `AdminEnrollments` resolves it only after a load has SUCCEEDED —
  into the filter its status lives under, search and package filter cleared, the card marked
  `data-enroll-focus` and focused — then drops the param with `replaceState`, and says "not found" only
  after a load that worked. **Supabase Auth's SMTP/Resend settings do NOT power this** — it needs its
  own Vercel env vars (or a Supabase Edge Function + function secrets off-Vercel). Receipts are
  never attached; the client submit fires the alert best-effort (never blocks the student).
  **Notify audit trail:** the `submitted` handler stamps the send outcome onto the request row
  (`enrollment_requests.notify_status`/`notified_at`/`notify_detail`) via the SECURITY DEFINER
  `record_enrollment_notification()` RPC (owner-or-admin guard — mirrors `approve_subscription`, so
  the function's student JWT can write without a broad UPDATE policy or a service-role key); each
  Enrollments card shows `AdminEnrollments`' `NotifyBadge` — **"Review alert sent"**, **"Review alert
  not sent — no key | no sender | no recipient | provider"**, and since EMAIL-4 **"Review alert may not
  have been sent"** (amber, `notify_status = 'provider_unclear'`, tip "The email provider gave no clear
  answer, so the enrollment review alert may or may not have reached the configured administrator.") —
  so a misconfigured admin email isn't invisible. ★ **`notify_status` gained `provider_unclear`
  (EMAIL-4)**, with no SQL change: the column has no CHECK and `record_enrollment_notification()` stores
  any status up to 40 characters. An alert send with no clear answer may have been delivered, so it is
  recorded as `provider_unclear`, its slug in `notify_detail`: `resend_timeout`, `resend_failed`, a
  provider 5xx, or a 409 not named "in progress". `provider_error` now means a refusal (a provider 4xx,
  or a 429 after retries). Both stay retryable, since only `sent` stops a re-POST, and the student
  confirmation still goes only after an alert that SUCCEEDED. All best-effort
  (never blocks the response); older rows/installs without the migration just show no badge.
  See [db/2026-07-08-enrollment-notify-status.sql](db/2026-07-08-enrollment-notify-status.sql).
  **Enrollment intake form (#42):** the paywall's `form` step is the Google Apps Script
  enrollment form, ported. **15 required answers across 5 sections** (Personal · Professional ·
  Program & Payment · Training Agreement · Final Questions) plus one optional resume upload —
  the *only* field a student may skip. Everything is driven by `INTAKE_FIELDS` in
  [src/lib/enrollmentIntake.js](src/lib/enrollmentIntake.js): the form renders from it and
  `validateIntake()` checks it, so **rendered and validated can never diverge** (the source's
  resume field was rendered with no `required` attribute for its whole life). Validation shows
  *every* outstanding answer at once in a summary banner, each entry jumping to its field;
  per-field errors appear on blur, never on first paint. The `programEnrolled` dropdown is gone —
  the plan was already chosen on the pricing cards, so name and price render read-only and
  `amountPaid` pre-fills from `price_php` (free text like `"₱16,999"` is read by
  `parseAmountPaid()` because `amount_paid` is `numeric`). The **Training Agreement** is a
  12-section document built by [src/lib/trainingAgreement.js](src/lib/trainingAgreement.js) with
  **three tier columns** (sampler/silver/vip) whose prices and durations come from
  `enrollment_plans` — never hardcoded, which is how the source came to print ₱15,999 on a
  ₱16,999 sale. Students sign it on a `<canvas>`; `AGREEMENT_VERSION` is stamped on every
  signature so an old one never appears to endorse new terms. A **second, offscreen copy** of the
  document at a fixed 794px width is what html2canvas captures for the PDF, so the PDF is
  identical on every device and works whether or not the panel was ever expanded — and because
  that capture leaves the DOM, the document is styled with the frozen `INK`/`DOC` literals, not
  `var()` tokens. Receipt, resume, signature PNG and agreement PDF all live in the existing
  private `enrollment-receipts` bucket under `<uid>/{receipt,resume,signature,agreement}-…`, so
  no new bucket and no new policy — #42 only widens it to 10 MB + doc/docx. `getCurrentBatch_()`
  from the source is **deliberately not ported**: a derived `"August 2026 Batch"` string cannot
  grant a cohort seat, so the real `batches` picker stays. ★ The source's separate **payment
  reference** field is gone (the Apps Script never had one — the reference is legible on the
  receipt screenshot), so `payment_reference` is now written empty by the paywall; Extend Access
  still sets it — the admin alert therefore renders that row **conditionally**.
  ★ **This form also serves renewals and upgrades**, not just new enrollments. A returning member's
  answers **prefill** from their latest request via `intakeValuesFromRequest()` — registry-driven,
  and never carrying `amountPaid` (a new term is a new payment), `email` (the account is the
  authority) or files. The prefill source is the **`prefillFrom`** prop, deliberately separate from
  `priorRequest`: the latter drives the rejected/expired notice step and is narrowed to those
  statuses by callers, so wiring prefill to it fired only for members whose previous request had
  been REJECTED. The agreement **is re-signed every term** (decision 2026-08-20) — prices and
  clauses change between terms, so a signature has to match the document actually on screen.
  ★ The signature can be **drawn or typed** (`agreement_snapshot.signature_method`); the typed name
  is rendered into the same canvas, so both paths produce one PNG and one PDF layout. Draw-only
  would make a mandatory gate impassable for keyboard-only users.
  Toggle with `REQUIRE_ENROLLMENT` (module const, default on;
  off via `VITE_REQUIRE_ENROLLMENT=false`). Enrollment state is server-side — **not** in
  `LEGACY_KEYS` (the one exception: the admin sound-alert pref `enroll:soundAlert`, which IS a
  client pref and IS in `LEGACY_KEYS`; the alert itself is a WebAudio 3-tone chime with a Test
  button, opt-in per autoplay policy).
- **Subscription lifecycle (durations / expiry / renewal —
  [db/2026-07-04-subscription-lifecycle.sql](db/2026-07-04-subscription-lifecycle.sql), runs
  AFTER the enrollment migration):** every plan carries `access_days` (60 Sampler/Silver,
  180 VIP; `support_days` informational; `entitlement_summary` jsonb chips) and every
  `subscriptions` row is a dated **term** (`ends_at`, `grace_ends_at`, lineage via
  `renewed_from_subscription_id`; `ends_at IS NULL` = legacy no-expiry — grandfathered).
  **The date is the authority:** `public.is_enrolled()` is rewritten to require an active,
  non-expired subscription (or the legacy/no-rows grandfather fallback) — all content `*_read`
  RLS enforces expiry server-side with zero policy changes; `profiles.is_paid` is now only a
  cache. Terms are granted solely by `approve_subscription(p_user_id, p_plan_key, p_request_id)`
  (SECURITY DEFINER, gated on `has_staff_permission('enrollments.review')`; **since #55 NOT granted
  to `authenticated` — the only caller is `admin_finalize_enrollment()`, nested, so the effective user
  is the owner**; one transaction: supersede active row → insert
  new term; renewal stacking = `greatest(now, current ends_at) + access_days`, so early renewal
  never loses days; grace knob `v_grace_days` = **3** — every term gets a 3-day `grace_ends_at`
  cushion, turned on by `db/2026-07-10-subscription-grace.sql` (#18), which also backfilled existing
  running terms; during grace `is_enrolled()` still passes via `coalesce(grace_ends_at, ends_at)`).
  `expire_overdue_subscriptions()`
  lazily flips overdue rows' `status` (cosmetic — called on Enrollments-tab load). Client side:
  `useEnrollmentGate` fetches the latest request + latest subscription for every non-admin
  (paid users too) and reduces to a named state via `enrollGateState()`/`subAccess()` (pure
  helpers next to the hook; `ends_at === undefined` tolerates the old schema); the root gate
  switches over that state → `EnrollmentPendingScreen` (`renewal`/`finalizing` props),
  **`MembershipExpiredScreen`** (expired member → Renew → paywall in `renewal` mode with
  `currentSub`/`onClose`), or the paywall. The Dashboard renders **`MembershipPanel`**
  (self-contained useAuth/fetch/realtime; admins/flag-off/no-data render null, a query **error
  shows a compact retry card** — never a silently missing panel): plan, status pill,
  start/expiry dates, days remaining, amount paid, entitlement chips, **calm > 5 days / amber
  warning ≤ 5 / red urgent ≤ 3 / red grace-period state** (grace end date + days) once the term has
  ended but access continues, and a Renew button that opens the **URL-driven `?panel=renew`**
  renewal paywall (module-scope `setPanelParam('renew')` — no prop threading; the card reloads
  itself when a billing panel closes, via the route-change event) — a member with a pending
  renewal keeps full access. `AdminEnrollments` adds membership filters
  (Renewals / Active / Expiring soon / In grace / Ended), a per-card membership strip (with an
  "In grace" pill + grace-end date and the plan's access-scope chip), and an "access until {date}
  (+ 3-day grace)" projection in the approve modal. Docs:
  [ENROLLMENT_SETUP.md](ENROLLMENT_SETUP.md) ("Membership lifecycle & renewal"). Migration order:
  user-approval → enrollment → subscription-lifecycle → enrollment-notify-status →
  plan-course-access → subscription-grace (#18) → sampler-essentials-access (#19) →
  account-membership-requests (#20) → hardening (#21, caps `approve_extension` at 60–365 days +
  a range CHECK on `extension_days` — the request column is student-declared, so the RPC is the
  bound that matters; the client mirrors it with a 2–12 month selector) →
  sampler-support-60-days (#22, data fix: the live sampler row's `support_days`/chips 30 → 60) →
  community (#23, the base `community_*` tables) →
  community-forum (#24, the forum upgrade: pin/lock/counter columns + guard/rollup/notify
  triggers, attachments/tags/notifications/announcement-reads tables, comment reactions,
  `set_my_avatar()` + `search_community_members()` RPCs, the avatars + community-media
  buckets — see the Community section) → community-hardening (#25) → student-imports (#26) →
  course-ai-trainer (#27, the AI voice trainer's knowledge/checkpoint tables + service-role
  entitlement mirrors — see the AI course trainer section) → community-write-gate (#28, adds the
  `is_approved()`+`is_enrolled()` gate to the two community own-update policies, closing the
  expired-member edit/soft-delete gap #25 left on posts/comments) → rls-initplan-and-indexes (#29,
  wraps every zero-arg auth/gate call in RLS policies `(select …)` for once-per-statement InitPlans +
  the FK/hot-path index pass) → backend-hardening (#30, `subscriptions.plan_key` FK + CHECK
  constraints + anon-EXECUTE revokes + avatars/course-media read-policy scoping + course-media bucket
  limits) → schema-migrations-log (#31, the `public.schema_migrations` apply-log — **after running any
  dated db/*.sql file, insert its row in the same session**; this table exists because #20/#21 sat
  silently unapplied in prod for two weeks while the deployed Extend Access UI depended on them) →
  community-spaces-batches (#32, batches + community_spaces + space-aware community RLS + the
  `admin_finalize_enrollment()` single-RPC approve — see the Community section; needs #12 + #13 +
  #20 + #23/#24 + #30, run after #29/#31; folded into the bootstrap **verbatim as §19 at the tail**,
  after §18, so its space-aware policies win on a fresh install — re-fold on change) →
  community-batch-hardening (#33, patches #32 after review: capacity/closed-batch checks now key on
  whether the member currently **occupies a seat** rather than on the batch id changing — an expired
  member renewing used to skip both while being excluded from the seat count; plus attachment
  `storage_path` binding, a set-based `search_community_members()`, `grant update (read_at)` on
  notifications, space-scoped own-DELETE policies, and a real-month `batches.code` CHECK; folded
  **verbatim as §20**, after §19) → batch-hardening-followup (#34, corrects #33's
  `admin_finalize_enrollment`: that rewrite reconstructed the tail instead of copying #32's and
  dropped `updated_at`, the `rejected_at`/`rejected_by` clearing and `rejection_reason = null`, and
  changed `approved_at` to first-approval — #34 restores #32's body verbatim keeping only the
  `v_holds_seat` change, and gates `community_media_delete` to match
  `community_attachments_own_delete`; folded **verbatim as §21**. **Always run #34 with #33.**) →
  batch-entitlements (**#35**, the cohort-entitlement LEDGER — `batch_entitlements` replaces the single
  mutable `subscriptions.batch_id`; one row = one seat in one cohort; the 180-day VIP plan grants SIX
  cohorts; runs are allocated from the batches REGISTRY in `code` order, never by calendar arithmetic;
  both predicates require the stamped `segment` to equal the member's LIVE plan segment, so a downgrade
  cuts access instantly; `grant_batch_run()` is the ONLY function that locks `batches`; adds
  `app_error()` stable codes carried in `hint`) → community-plan-capabilities (**#36**, seven fail-closed
  capability booleans on `enrollment_plans` fused with the space flags by `user_community_capabilities()`;
  **D2: General is announcement-only for EVERY plan** *(retired by #40 - see the D2 paragraph in the Community section)* — posting and commenting off, reactions on — pinned
  by a CHECK; own-UPDATE split into withdraw vs keep-published; **fixes a latent bug where member
  soft-delete could never work**, because Postgres refuses an UPDATE whose resulting row would be
  invisible to the writer and `community_posts_read` admitted only `status='active'`) →
  entitlement-hardening (**#37**, code-review corrections to #35/#36 — restores the attachment
  uploader/link/space binding, makes the FIFO binder forward-only within a run, and stops a
  segment-changing upgrade stranding the `subscriptions.batch_id` cache) → batch-lifecycle
  (**#38**, editable batch records + the past-lock + automatic month-end closure — see the batch
  paragraphs in the Community section: `update (code)` revoked from `authenticated`,
  `admin_update_batch()` with rank preservation, `batch_is_past()` in the batch's own timezone,
  `batches_guard()`, and the hourly pg_cron `close_due_batches()` sweep. **Enabling pg_cron is a
  manual deploy step** — the migration prints the `cron.schedule` call if it could not run it) →
  three-plan-catalog (**#39**, [db/2026-08-17-three-plan-catalog.sql](db/2026-08-17-three-plan-catalog.sql)
  — DELETES `core_self_paced` + `gold_live` and the whole `gold` community segment: one VIP space
  per batch, `batches.gold_capacity` dropped, `admin_update_batch()` down to 8 args and
  `admin_batch_overview()` minus its `gold_*` columns (both DROP+CREATE, **re-granted**), the three
  segment CHECKs narrowed to VIP, and `plan_is_qbo_only()` dropped after the four course-read
  policies + `course_object_allowed()` + the two trainer mirrors lose its conjunct. ★ ORDERING:
  `batches_guard()` must be replaced BEFORE the column drop or every `update batches` — including
  the hourly cron sweep — raises `record "new" has no field "gold_capacity"`. Folded verbatim as
  §26; the §9 plan seed is corrected IN PLACE so a fresh install never creates the retired plans) →
  community-channels (**#40**,
  [db/2026-08-18-community-channels.sql](db/2026-08-18-community-channels.sql) — categories +
  channels + per-channel plan/batch audiences + read markers + an audit ledger; every content
  policy, the community-media read/delete, the notify triggers and the mention directory move
  from space scope to CHANNEL scope; indexed FTS; admin editor RPCs. ★ RETIRES D2 as a
  space-wide rule — see the D2 paragraph in the Community section. ★ ORDERING: the guard
  triggers must be replaced BEFORE channel_id goes NOT NULL, and the D2 CHECK dropped BEFORE
  the flags flip. ★ Runs AFTER #39 — it writes `can_post_in_general` for exactly the three
  surviving plan keys, and its preflight refuses to run while the retired keys still exist.
  Folded verbatim as §27) → community-channel-rename-fixes (**#41**,
  [db/2026-08-19-community-channel-rename-fixes.sql](db/2026-08-19-community-channel-rename-fixes.sql)
  — a rename-only `admin_save_community_channel()` call no longer wipes the topic, no longer
  aborts on plan/batch-scoped channels, and no longer writes a permissions audit row built
  from raw arguments; ★ `p_topic` null now means *leave alone* and `''` means *clear*.
  Folded verbatim as §28) → **enrollment-intake** (**#42**,
  [db/2026-08-20-enrollment-intake.sql](db/2026-08-20-enrollment-intake.sql) — the full
  full enrollment intake + the signed Training Agreement; see the "Enrollment intake
  form" bullet in Authentication. Seven promoted columns + an `intake` jsonb + four
  agreement columns + three file paths on `enrollment_requests`, the `enrollment-receipts`
  bucket widened to 10 MB/doc/docx, and the plan `features` copy corrected. Folded
  verbatim as §29) →
  **community-channel-followup** (**#43**,
  [db/2026-08-22-community-channel-followup.sql](db/2026-08-22-community-channel-followup.sql)
  — full-code-review corrections to #40/#41. ★ Restores the
  `is_approved()`+`is_enrolled()`+channel gate on `community_reactions_own_delete`, which #36 had
  reduced to a bare `user_id = auth.uid()` and #40 skipped while re-scoping its two siblings —
  reopening the expired-member write gap #28 closed. ★ Lets an uploader delete their OWN ORPHAN in
  `community-media` and `enrollment-receipts`, so the clients' failed-submit cleanup stops being a
  silent 403 (#14's payment-evidence rule is preserved exactly, via the SECDEF
  `enrollment_file_is_referenced()`: once a request row cites a file it is permanently
  student-undeletable). ★ `admin_save_channel_category`'s `p_status` default drops, so an omitted
  argument can no longer un-archive. ★ `p_kind` joins #41's `v_touched` audit gate. ★ **The
  performance one that mattered:** `community_posts_channel_feed_idx` loses #41's
  `where status='active'` — RLS never implied it (its first disjunct is `is_admin()`) and the client
  sends `status <> 'deleted'`, so the planner could not use the index AT ALL and every feed page was
  a seq scan + sort. ★ `community_category_counts`/`search_community_posts` stop using
  `($1 is null or col = $1)`; the latter gains `p_tag_slug`/`p_unanswered` so **in-channel** search
  finally reaches the GIN index #40 built. ★ Plus the `profiles.full_name` trigram index and
  `community_channel_reads(last_read_post_id)`. Needs #40+#41+#42. Folded verbatim as §30) →
  **course-video-upload-only** (**#44**,
  [db/2026-08-24-course-video-upload-only.sql](db/2026-08-24-course-video-upload-only.sql) — a
  lesson video must be an UPLOADED file in the private bucket, and that bucket stops authorizing by
  PATH. Replaces `course_object_allowed()` — which returned **true** on an unparseable path, on an
  unknown course and for every non-sampler plan, never checked `courses.published`, and
  mis-authorized duplicated courses that legitimately share a `storage_path` — with
  reference-based `course_video_object_readable(text, boolean)`; adds the `is_approved()`
  conjunct `course_videos_read` was the only content-read policy to lack; indexes
  `course_lessons.storage_path`; adds `course_lessons_video_guard` and
  `courses_publish_guard` + `course_publish_blockers()`; re-asserts the bucket at 2 GiB /
  `video/mp4`, which #15's `do update set public = false` never could. ★ ORDERING: the new
  function must exist BEFORE the `alter policy` names it, and `course_object_allowed` is
  dropped AFTER — with NO CASCADE, so a policy that still depends on it errors the file instead
  of being silently stripped. ★ The publish trigger is delta-scoped by a `WHEN` clause; the
  lesson trigger is monotonic on `video_url` and published-gated on INSERT. Three new
  `app_error` codes. Needs #39+#35+#31+#19+#15. Folded verbatim as §31) →
  **staff-authorization (#45) → course-staff-assignments (#46) → special-extension (#47) →
  authorization-hardening (#48) → staff-invitation-acceptance (#49) →
  staff-activation-consistency (#50) → access-request-staff-target (#51) →
  student-progress-rankings (#52) → progress-rankings-followup (#53) →
  progress-course-family-scoping (#54) → approve-rpc-grant-revoke (#55) →
  community-staff-authority (#56) → lesson-video-quicktime (#57) → financial-management (#58) → finance-parity (#59) → enrollment-management (#60) → communications (#61) → meetings-tasks (#62) → management-hardening (#63) → finance-daily-income (#64) → course-lesson-assets (#65) → enrollment-decision-lock (#66) → legacy-student-migration (#67) → legacy-migration-round2 (#68) → getting-started-video (#69)** — see the Staff-authorization
  and Progress & Rankings sections for what each does. **#67**
  ([db/2026-09-25-legacy-student-migration.sql](db/2026-09-25-legacy-student-migration.sql), fold **§54**)
  is the legacy Thinkific migration and the `scheduled` subscription status — see the Student Imports
  and Scheduled memberships sections. Restates the staff seed (`students.legacy_migrate` replaces
  `students.import`; 22 permissions / 34 grants) and `app_error_catalog()` (132 codes). **#68**
  ([db/2026-09-28-legacy-migration-round2.sql](db/2026-09-28-legacy-migration-round2.sql), fold **§55**)
  is its second round: Silver and Essentials rosters, seats from the paid term, the batch-gap refusal,
  the higher-plan-wins rule, the grandfathered block, the sender/reply-to split, and the plan RENAME
  (`vip` → VIP Package, `silver_self_paced` → Silver · Self-Paced, `sampler` → Essentials; the old product
  names move to `tagline`). It restates `app_error_catalog()` (133 codes, + `LEGACY_BATCH_GAP`). **#69**
  ([db/2026-09-30-getting-started-video.sql](db/2026-09-30-getting-started-video.sql), fold **§56**)
  is the Getting Started onboarding video — see its section. It restates the staff seed
  (+ `onboarding.manage`, Super Admin alone: 23 permissions / 35 grants) and `app_error_catalog()`
  (141 codes, + eight `ONBOARDING_VIDEO_*`), both **copied by a script** from #67 §1 and #68 after
  comparing each with production. Additive: nobody is gated until a Super Admin publishes a version.
  Its CURRENT file (md5 `3b62d98d…`, with the publish re-signed to take `p_expected_live_id` and the
  attach no-op) was **applied to production on 2026-10-02** as one transaction, right after a
  forced-rollback rehearsal on the live catalog — and, before that, twice on the shadow project, where all
  13 `#69` audit entries pass. **#66**
  ([db/2026-09-24-enrollment-decision-lock.sql](db/2026-09-24-enrollment-decision-lock.sql), fold
  **§53**) makes a DECIDED enrollment request final: #48's column grant let every
  `enrollments.review` holder PATCH `status`, and both existing guards fire only on a move TO
  `approved`, so approve → PATCH back to `pending_review` → approve again stacked a **second paid
  term on one payment** with no finance entry and no audit row (reproduced on the shadow project:
  2 terms, 1 collection). `enrollment_decision_lock` is a BEFORE UPDATE trigger whose WHEN clause is
  exactly "status changes out of approved | rejected | expired"; it refuses with the existing
  `INVALID_MEMBERSHIP_TRANSITION` (no catalog restatement), exempts a Super Admin and the table
  owner's explicit `app.enrollment_admin_override` (the #38 idiom — never "no JWT means trusted"),
  and logs every permitted reopen to `enrollment_request_events` as `decision_reopened`. ★ A reopen moves
  ONLY the request row — re-approving stacks another term, and rejecting leaves the term, seats and
  collection in place; the file's break-glass runbook says what to change first. Same-status
  writes (notes, notify stamps) are untouched. Client-neutral; `doDecline` also filters
  `.eq('status','pending_review')`. Pinned by `test/enrollmentDecisionLockSql.test.mjs`,
  `test-db/enrollmentDecisionLock.dbtest.mjs` and the `#66` block in `npm run db:audit`. **#57**
  ([db/2026-09-08-lesson-video-quicktime.sql](db/2026-09-08-lesson-video-quicktime.sql), fold
  **§44**) widens `course-videos.allowed_mime_types` to
  `video/mp4 + video/quicktime` so an iPhone/Mac `.mov` uploads instead of being refused.
  Additive, upload-path only, no policy/function/column change — but **run it before or with the
  deploy**: the new client sends the file's real content type, so a `.mov` against an unwidened
  bucket 400s. An old client against the widened bucket is unaffected.
  **#35/#36 applied to production 2026-07-29; both verified against a disposable shadow project first — see
  [docs/db/shadow-project.md](docs/db/shadow-project.md) and `npm run test:db`.**
  **Expiry-warning policy:** student-facing surfaces (menu pill, Dashboard `MembershipPanel`, the
  sidebar "Access until" line) turn amber ≤ 5 days / red ≤ 3 (+ the grace state); admin views
  (Enrollments membership strip + the "Expiring ≤ 14d" filter) intentionally use a 14-day lead
  time, labeled as such — don't "unify" them.
- **Account menu + self-serve Extend / Upgrade (`db/2026-07-11-account-membership-requests.sql`, #20):**
  a SaaS-style **⋮ account menu** on the sidebar identity card (`AccountMenu`, both the expanded card and
  the collapsed rail; house dropdown a11y — Escape + a document-level `pointerdown` outside-click
  listener (NOT a `fixed inset-0` catcher — the sidebar's CSS transform would trap it) +
  `role=menu`/`menuitem` + focus restore; the trigger is a **vertical** `MoreVertical` kebab with
  `aria-label="Open account menu"`) opens **Profile & Settings**, **Membership Plan**
  (`MembershipPlanModal`), **Upgrade Plan**, **Extend Access** (`ExtendAccessModal`), and **Log out**;
  billing items gated by `showBillingControls` (`!is_admin && REQUIRE_ENROLLMENT`). **Every account
  surface is an overlay group, not a layout column, and ALL of them are URL-driven** from the root
  `accountPanel` state (`?panel=settings|membership|upgrade|extend|renew`, read in `readAppRoute()`,
  written by the module-scope `setPanelParam()` — see the Navigation section for push/replace,
  aliases, and the strip-effect that clears disallowed billing panels). Profile & Settings is the
  **Account Center**: a widened (`sm:max-w-lg`) **right-side drawer** (`AccountSettingsPanel` → the
  reusable `SidePanel` shell) whose `ProfileSettingsBody` is sectioned — Account overview (name /
  email / role / copyable account id), Membership facts (shimmer rows while the gate is fetching,
  via the `enrollReady` prop — never blank), Subscription actions (Upgrade / Extend / conditional
  Renew), **Payments & requests** (`RequestHistorySection`: lazy last-5 `enrollment_requests`
  fetch on drawer open with skeleton → error+retry → empty states; `select('*')` so pre-#20
  schemas degrade), Course access (entitlement scope + plan chips), and a Support note
  (`profiles` has no user-update RLS — name/email changes go through support). The admin variant
  drops all billing sections for a role/capabilities card. Membership/extend are centered modals;
  upgrade/renew are full-screen paywall overlays. All render from one block after
  `</main>` off the already-loaded `enroll.sub`/`enroll.latestReq`/`entitlement` (no refetch
  beyond the drawer's own plan-row + history lookups); billing sites are guarded by
  `showBillingControls`. `MembershipPanel`'s Renew and
  `RestrictedTab`'s "Upgrade or renew" open `?panel=renew`/`?panel=upgrade` via `setPanelParam`
  directly (module scope + the route-change event — no prop threading through the memoized
  TabPanel tree). Gate screens (`MembershipExpiredScreen` etc.) keep their **local** extend/renew
  overlays — they render before the shell, where the `?panel=` block is unreachable. Both new
  actions are just new **kinds** of
  the enrollment flow, reusing receipt upload + admin review: **Extend Access** buys more time on the
  SAME plan (min 2 months / 60 days; priced by `extensionPrice()` = `price_php/access_days × months*30`,
  so a 60-day plan's 2-month top-up == its full price), submitting an `enrollment_requests` row with
  `request_kind='extension'` + `extension_days`; **Upgrade Plan** reuses `EnrollmentPaywall` in a new
  `mode="upgrade"` overlay (renewal-mode variant that marks the current plan) and is tagged
  `request_kind='upgrade'` when a different plan is chosen. The shared `submitSubscriptionRequest()`
  helper (extracted from the paywall submit; column-resilient so it degrades before #20) does the
  upload + insert for all paths. **Admin approval no longer branches in the client** — since #32,
  `AdminEnrollments.doApprove` is ONE call to `admin_finalize_enrollment(p_request_id, p_batch_id)`,
  which wraps `approve_extension()` for an `extension` row (same plan, days stacked from the current
  expiry / from now if expired, 3-day grace) and `approve_subscription()` for everything else
  (upgrade = a different `p_plan_key` = full fresh term). The old 3-step client sequence **and its
  local-grant fallback were deleted on purpose — never re-add them** (they bypass batch/capacity
  validation); a missing #32 must surface setup guidance and grant nothing. The client also sends
  `p_batch_id` **only when an admin explicitly picks a batch**, so the RPC's own precedence chain
  stays the authority. New **Upgrade/Extension**
  card badges + filter chips + an extension-aware approve-modal projection. Expired (past-grace) members
  have no sidebar, so **`MembershipExpiredScreen`** also surfaces **Extend the same plan** (opens
  `ExtendAccessModal`) alongside Renew/Upgrade/Sign out; the pending screen copy is `request_kind`-aware.
  Add `request_kind`/`extension_days` to the docs when the request shape changes; **keep the two columns
  + `approve_extension` in sync with `submitSubscriptionRequest` and `admin_finalize_enrollment()`**.
- **Shared dialog + admin UI kit (2026-07 stabilization pass):** `AccountModal` is the ONE modal shell
  for the whole app — the account-menu modals AND the admin approve/reject/receipt modals all use it.
  It centralizes dialog a11y (role/aria-modal, Escape, backdrop-close, a Tab focus-trap + focus
  restore) and takes `tone` ('primary'|'ok'|'danger' icon tile), `canClose` (gate closing while a
  request is in flight — replaces hand-rolled `busyId` guards), `headerAction`, `bodyClass`/`bodyStyle`,
  `maxW`. **Both shells render through the module-scope `OverlayPortal`** (`createPortal` →
  `document.body`), so no ancestor CSS — the `.gh-app-bg > *` stacking rule, the sidebar's
  transform/backdrop-filter containing block, the app-shell flex row — can demote or squeeze a
  dialog; an in-tree anchor + dep-less layout effect suppresses the portal while a `[hidden]`
  ancestor exists, so a modal left open inside a hidden keep-alive `TabPanel` stays hidden with
  its tab (state intact, reappears on return). `WelcomeOverlay` and the upgrade/renew paywall
  wrappers portal the same way. Never hand-roll a `fixed inset-0` + `bg-white` modal again — and
  for a **right-side drawer** use the sibling `SidePanel` shell (same a11y idiom + portal:
  focus move-in/restore, Escape, Tab focus-trap, role/aria-modal, backdrop-close;
  `absolute inset-y-0 right-0 w-full` + a `maxW` prop, default `sm:max-w-md`, full-width sheet on
  mobile). It also takes **`canClose`** (the same in-flight gate as `AccountModal` — blocks Escape,
  backdrop and the X, which is additionally `disabled` so it leaves the focus trap) and **`footer`**
  (an action bar pinned *below* the scrolling body). Header, body and footer are three rows of one
  flex column, so **a drawer never needs `sticky top-0`/`sticky bottom-0`** — the body alone is
  `flex-1 overflow-y-auto overscroll-contain`. `SidePanel` is the preferred surface for a **long
  editing form**. Consumers include `AccountSettingsPanel` (`sm:max-w-lg`), the **course lesson
  editor** (`CourseProgram.renderLessonEditor`, `sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl`, Cancel/Save
  in `footer`) and #69's Getting Started draft editor (`sm:max-w-xl lg:max-w-2xl`).
  ★ **Both editors gate closing on the SAVE alone — never on an upload.** The lesson drawer passes
  `canClose={lessonPreview || !savingLesson}` (while previewing, the X, Escape and the backdrop mean
  "back to editing") and the draft editor `canClose={!savingDraft}`. Gating on the transfer would
  strand the admin behind an un-closable drawer whose only exit is a reload; instead
  `closeLessonEditor` / the draft editor's `closeEditor` return early only while saving, ask
  `window.confirm` when `needsCloseConfirmation(uploadState)` says a transfer is in flight (a
  resumable upload picks up again when the same file is re-picked), confirm discarding unsaved edits,
  and then sweep an upload that finished but was never saved — never the SAVED path. (From 2026-08-18
  until #69 this sentence said `canClose={!savingLesson && !uploading}`; no version of the code ever
  did.) ★ The lesson editor was a hand-rolled `fixed inset-0` overlay
  until 2026-08-18 and it anchored to the **course canvas, not the viewport**: `.fade-in`
  (index.css:471) animates `transform` with `forwards`, so the active `TabPanel` keeps a non-`none`
  transform permanently and is therefore the containing block for every `position:fixed` descendant.
  **Any fixed overlay rendered inside a tab MUST go through `OverlayPortal`** — i.e. through
  `AccountModal` or `SidePanel`. ★ A dialog also needs a **dialog-local** error surface: a page-level
  banner renders in the canvas *behind* the scrim (`CourseProgram` keeps `lessonErr` + `replayErr`
  for the drawer and `err` for the course page). ★ **No JS scroll lock is needed** behind a portaled
  dialog — its DOM ancestors are body/html, which never scroll (the app root is
  `h-screen … overflow-hidden`), and scroll chaining follows the DOM ancestor chain, not visual
  stacking; `overscroll-contain` on the body is belt-and-braces. Both admin screens
  (`AccessRequests` + `AdminEnrollments`) are built from the shared module-scope kit right above them:
  `AdminNotice` (status-token banners: `ok` / `warn` / `danger` and, since #69, `info` for a neutral
  fact that breaks nothing; any other kind renders as danger and is announced as an alert),
  `AdminFilterChip`/`AdminFilterCaption` (labeled filter rows),
  `AdminListSkeleton` (first-load skeleton; refresh keeps the list), `AdminUserCell`
  (avatar/name/badges/email/meta identity block; `wrap` = name and email wrap instead of truncating,
  used by the Enrollments card only), `ADMIN_BTN_OK`/`ADMIN_BTN_DANGER` (token-gradient
  action buttons). New admin surfaces must reuse these. ★ **An admin row's ACTIONS are never a grid
  track beside the identity** — see "Layout by the workspace, not the viewport" in Styling
  conventions; the Enrollments card is the scar. `ProfileSettingsBody` (rendered in the
  `AccountSettingsPanel` drawer) takes `showBilling` (false → billing sections drop out; admins get
  a role/capabilities card) — see the Account-Center section list in the account-menu bullet — and
  the root gates the billing panel render sites with
  `showBillingControls` + strips a disallowed deep-linked billing `?panel=` (see Navigation).
  `ProfileSettingsBody` now opens with the **`AvatarSection`** profile-picture uploader
  (self-contained via `useAuth`): upload to the public `avatars` bucket
  (`<uid>/<uuid>.<ext>`, ≤5 MB image) → the **`set_my_avatar()` SECURITY DEFINER RPC** (the
  ONE sanctioned user-facing `profiles` write — there is still NO user-update RLS policy on
  `profiles`; the RPC touches only `avatar_url` + the community denorms) →
  `refreshProfile()`. Every identity surface (sidebar card + rail, AccountMenu, community
  posts/replies/mentions) renders through the shared **`MemberAvatar`** primitive
  (`<img>` with initials fallback; `resolveAvatarUrl` maps storage paths vs legacy OAuth
  URLs) — never hand-roll the initials circle again.
- **Plan-based access (per-plan entitlements):** membership is no longer all-or-nothing. There are
  **exactly three plans** (#39; renamed by #68 — keys unchanged): `sampler` (**Essentials**, product line
  "Sampler Session", ₱1,499 / 60 days) is the ONE scoped
  plan — Home + the QuickBooks catalog (`qbomastery`) but only its **Essentials** course
  (`access_tier='essentials'`, NOT Mastery) + both 1-on-1 booking tabs (`linkedinopt`, `coachalex`)
  + `community` + #69's Getting Started replay page (`gettingstarted`, listed EXPLICITLY: the
  fail-closed unknown-plan entitlement stays Dashboard-only, and `staffEntitlement()` adds it for
  neither an Operations Admin nor a Trainer; a Super Admin resolves FULL). Its ₱1,499 buys the
  coaching session, not more course content, so the CHEAPEST
  plan is also the most scoped — **never assume price ⇒ scope.** `silver_self_paced` (**Silver · Self-Paced**,
  "QBO + Resume Combo", ₱2,999 / 60 days) and `vip` (**VIP Package**, "Personalized Coaching Program",
  ₱16,999 / 180 days) are both
  listed **explicitly as full access** (`{ full: true }`). VIP is additionally the only plan with a
  cohort batch + private community. **The `community` tab is in EVERY plan's allowlist** — all plans
  include group chat, and its real gate is the `is_enrolled()` RLS on the `community_*` tables (see
  the Community section). **Client model** — all of it now lives in the pure, unit-tested
  [src/lib/planCatalog.js](src/lib/planCatalog.js) (moved out of BookkeeperPro.jsx by #39 so the
  fail-closed branch is testable and the knowledge generator can import it instead of regex-scraping
  the JSX): `ENROLLMENT_PLANS_FALLBACK` + `PLAN_LABELS` + `extensionPrice()` +
  `PLAN_ENTITLEMENTS` (sampler = Training-QBO + coaching + community + `courseTier:'essentials'`;
  silver + vip = explicit `full:true`) → `planEntitlement(key)` → `{ full, label, scopeLabel,
  allowsStage(id), allowsTab(id), allowsCourse(course) }` (`allowsCourse` gates individual courses
  **within** a catalog by `course.access_tier` — the QBO Essentials/Mastery split).
  ★ **AN ENTITLEMENT IS NEVER NULLISH, and on 2026-09-03 one was.** `staffEntitlement(ctx, base)`
  returned its `base` verbatim for a Super Admin, and the root calls it as
  `staffEntitlement(staff, enrollPass ? planEntitlement(planKey) : null)` — where `enrollPass` is
  **permanently false for a Super Admin**, because `useEnrollmentGate` fires its queries for any uid
  and a Super Admin holds no `subscriptions` row, so `enrollGateState()` returns `'paywall'`. The
  null became `entitlement` and was dereferenced by `entitlement.allowsTab('community')` in the
  root's **component body** — ~800 lines above the gate that would have rendered a splash — so
  React unmounted the tree and production served a **blank white page**. It only appeared when
  `my_staff_context()` beat the `profiles` SELECT (two independent parallel effects on the same
  `[uid]` in AuthProvider), which is why it looked intermittent; after a *failed* profile fetch it
  was durable for the whole session. Fixed in three places, all of which must stay:
  `staffEntitlement` returns `base && base.full ? base : FULL_ENTITLEMENT` for a Super Admin (they
  ARE the `profiles.is_admin` branch — #45 makes that column mean exactly "active super_admin", so
  the two must never disagree, and a truthy-but-**scoped** base must not narrow them either); the
  root memo has a loud fail-CLOSED `if (!resolved)` fallback; and `src/AppErrorBoundary.jsx` now
  catches any render error instead of blanking the page. ★ That fallback may **never** be
  `|| FULL_ENTITLEMENT` or `|| planEntitlement(planKey)` — for a non-super staff member `planKey`
  is null and `planEntitlement(null)` **is** FULL, so either one hands a Trainer the whole paid
  toolkit. Use `NO_ACCESS_ENTITLEMENT`. Pinned by `test/staffRoles.test.mjs`,
  `test/planCatalog.test.mjs` and `test/uiSafety.test.mjs` §15–16.
  ★ **`planEntitlement` is three-way and FAILS CLOSED.** A null/empty key → FULL (admins, flag off,
  grandfathered terms with no plan string). A known key → its config. An **unknown non-null key**
  (a deleted plan, a typo, stale local state) → **Home/Dashboard only**, labelled "Plan no longer
  available", so RestrictedTab's "Upgrade or renew" is what they get — it no longer inherits the
  whole toolkit. That means **every sellable plan MUST have an explicit `PLAN_ENTITLEMENTS` entry**;
  `test/planCatalog.test.mjs` pins catalog↔entitlement parity precisely because an unlisted VIP
  would now be locked out of what it paid for. `FULL_ENTITLEMENT` is the context default;
  `filterStagesForEntitlement()` drops disallowed stages/tabs; `EntitlementContext` shares it with
  Dashboard/RestrictedTab **and CourseCatalog/CourseProgram** (the catalog hides cards the plan can't
  open; CourseProgram has a deep-link guard). The root resolves `entitlement` once (memoized on
  `enroll.sub?.plan_key || profile.plan`; admins/flag-off → FULL) and wraps the app shell in the
  provider. **Enforcement is a single chokepoint** — the `visitedTabs.map` render (the old "Phase 2
  paywall hooks" seam): a disallowed active tab reached ANY way (deep-link, popstate,
  programmatic `goto`) renders **`RestrictedTab`** (a polished upsell → Dashboard)
  instead of the tool. The sidebar (`visibleStages`, both passes) and Dashboard tiles are filtered
  cosmetically; the aspirational Career Roadmap strip stays full. **Server half** =
  `db/2026-07-11-sampler-essentials-access.sql` (`courses.access_tier` + `plan_is_sampler()` →
  sampler reads only `qbo-*` **AND** `access_tier='essentials'`), wrapped `(select …)` for
  once-per-query InitPlans. (`plan_is_qbo_only()` from `db/2026-07-09-plan-course-access.sql`
  existed only for `core_self_paced` and was **dropped by #39** along with its conjunct in the four
  course-read policies and `course_object_allowed()`.) It scopes course/lesson reads + the private
  `course-videos` bucket via direct Supabase query. Admins set a course's tier in-app via the course
  card **⋮ menu → "Included in the Essentials package"** (#68 renamed the label). **Keep the client tab-allowlist + `courseTier` and the
  SQL `qbo-%` / `access_tier` rules in sync** when entitlements change. An admin's plan change (upgrade
  approval) applies live via `useEnrollmentGate`'s realtime/focus refetch. Residuals (documented, not
  enforced): `feature_guides` + the AI proxy stay `is_enrolled()`-gated.
- **Sign-out + identity** render in the sidebar header (just below the "built by Alex Sagun" line);
  a compact "Access until {date}" line sits below it for non-admin members with a dated term.
- **Per-user data:** all `window.storage` keys are auto-namespaced per user (see the main.jsx shim
  note). Tools need no changes. A one-time migration in `AuthProvider` adopts any pre-auth global
  keys into the first signed-in account (guarded by `auth:legacyMigratedTo`). The canonical legacy-key
  list lives in `AuthProvider.jsx` (`LEGACY_KEYS`) — **add to it whenever a tool introduces a new
  persisted key**, and remove one when its last reader goes (`nav:lastTab` was dropped on
  2026-09-03 with the resume-last-tab effect; migrating a key nothing reads just adopts dead data).
  One special case: `ui:theme` is per-user via `window.storage` *and* mirrored to a
  bare `localStorage` key on every change (the `index.html` boot script + signed-out screens read the
  bare copy; `useTheme` adopts it into a fresh account on first sign-in).
- **Startup is parallelized (and can't hang):** `AuthProvider` applies the cached session
  optimistically after `getSession()`, so the profile fetch and the enrollment-gate queries run
  **concurrently** with the server-side revoke check (`getUser()`); `loading` still holds the
  splash until the revoke verdict, so a revoked account never renders anything. Both `getSession()`
  and the revoke check are raced against an **8s fail-open timeout** (`withTimeout`, same idiom as
  the profile fetch's 8s and the enrollment gate's 7s) — a *stalled* auth endpoint lands on
  AuthScreen / keeps the session instead of stranding the app on AuthSplash forever; a
  normal-speed 401/403 still signs out. `useEnrollmentGate` fires its two own-row queries as
  soon as a uid exists (its returned `active`/`ready` still key off `profileReady` — gate semantics
  unchanged). Don't re-serialize these when editing the provider.
  ★ **What it reports from those reads is the SIGNED-IN account's only (#69, K3R-GATE-DIRECT-SWITCH).**
  `loadedFor` is the uid the landed reads were made for, set in the same commit as their data, and
  until it is the current uid the hook reports what a fresh mount reports: not ready, no request, no
  term, `configured` and `migrated` at their defaults. ★ **`configured` is kept WITH the uid it was read
  for** (`configuredRead`, `{ uid, ok }`, forgotten at sign-out; K3RV-CONFIGURED-CARRYOVER): the 7-s
  timeout leaves it as it was and still marks the reads landed, so before this the NEXT account whose
  reads stalled — after a direct switch or a sign-out — was handed the previous account's failed read,
  and an unpaid student landed in the app (the legacy approval gate) instead of the paywall a fresh
  mount's timeout shows (measured in Chrome). The same account's timeout still leaves its own last
  answer standing. `migrated` is deliberately NOT kept per uid: it describes the database, not an
  account. Its effect re-runs on a new uid without clearing
  what it holds — and must not clear on a refetch, or every focus would flash the splash — so on a
  DIRECT account switch (a sign-in to another account with no signed-out render between, e.g. two auth
  events batched into one render on a resumed tab) it used to report the previous account's term,
  ready, until the new reads landed: measured in Chrome, a lapsed B was shown A's dashboard for the
  2.5 s B's own reads took. A refetch for the SAME account keeps `loadedFor`, so it never shows a
  splash (measured too). Pinned by `uiSafety` §28b (K3R-GATE-DIRECT-SWITCH), which runs the real hook.
- **Backend setup:** a `profiles` table + RLS + a signup trigger must exist in Supabase. Email
  confirmation and Site/Redirect URLs are configured in the Supabase dashboard. See README / the
  setup steps for the exact SQL.
- **Phase 2 status:** the paid gate shipped as the **manual enrollment workflow** above (full-app
  gate keyed on `is_paid`, flipped only by an admin — RLS has no user-update policy on `profiles`).
  The old `FREE_TABS`/`// Phase 2 paywall hooks here` seam is now **realized as the plan-entitlement
  chokepoint** (see the "Plan-based access" bullet) — the `visitedTabs.map` render gates each tab by
  `entitlement.allowsTab(tabId)`. A future Stripe/Gumroad webhook could still flip `is_paid` +
  grant a subscription term server-side without manual review.

## Staff authorization — Super Admin / Operations Admin / Trainer (#45–#51)

Authorization used to be one boolean. `profiles.is_admin` drove `public.is_admin()` — ~74 RLS
policies, 21 self-gating RPCs, 13 storage policies and 145 frontend checks — so every admin could
approve payments, author and delete courses, manage cohorts, import students, moderate the community
and edit global settings, and there was no way to hire a Trainer.

**★ The design decision that makes the cutover safe, and the one thing to understand first.**
#45 does **not** rewrite those references. It changes the MEANING of the column they read:

> `profiles.is_admin` == "has an ACTIVE `super_admin` staff membership"

and that column stops being an input. It is a **cache**, written only by the `staff_sync_is_admin`
trigger, with `UPDATE` on `profiles` revoked from every client role. Every legacy `is_admin()` check
therefore keeps working and silently narrows to Super-Admin-only — including the ~20 SECURITY
DEFINER bodies that read the column directly. Operations Admins and Trainers carry
`is_admin = false` and reach their features ONLY through `has_staff_permission()`. So a check we
failed to find **under**-grants (a broken Ops feature, loud and reported) instead of over-granting.
That direction is the whole safety argument. **Never repair a missed check by handing a non-super
role `is_admin = true`.**

- **Tables** (`db/2026-08-25-staff-authorization.sql`, #45): `staff_roles` / `staff_permissions` /
  `staff_role_permissions` (the 23 × 3 matrix, **35 grants** — #69 added `onboarding.manage` to super_admin alone; #67 replaced `students.import` (super_admin + operations_admin) with `students.legacy_migrate` (super_admin alone); #61 added `communications.send` and #62 `meetings.manage`, each to super_admin alone; #52 added `student_progress.read`, #56 the
  two community keys to both non-super roles, #58 `finance.manage` to super_admin alone) → `staff_memberships` (ONE row per
  user, mutated in place; only `status='active'` confers authority, which is what makes a suspension
  take effect on the next *request* rather than the next token refresh) → `staff_role_events`
  (append-only; FKs `on delete set null` + denormalized email snapshots, so deleting an Auth account
  never destroys the record of what it was granted).
- **Helpers**, in the two-form split this repo uses everywhere: `user_has_staff_permission(uuid,text)`
  and `user_can_manage_course(uuid,uuid)` answer about ANY user and are **revoked from every client
  role**; `has_staff_permission(text)`, `is_super_admin()`, `can_manage_course(uuid)` and
  `my_staff_context()` are pinned to `auth.uid()` and **granted to `authenticated`** — that grant is
  not optional, because an RLS qual is evaluated AS THE QUERYING ROLE and without it every gated
  read fails with "permission denied for function" instead of a clean denial.
- **`my_staff_context()` is the ONE call** the client and the `api/` handlers make to learn who they
  are: membership + effective permissions + assigned course ids, read LIVE on every request. Never
  decoded from a JWT claim — that is why suspending someone is immediate.
- **Section 15 of #45 is what makes the Operations Admin role real**, and the first draft of that file
  missed it entirely: `admin_finalize_enrollment`, `approve_subscription`, `approve_extension`,
  `expire_overdue_subscriptions` and the eight `admin_*` batch RPCs each opened with
  `if not public.is_admin()`, and `auth.uid()` is unchanged inside a SECURITY DEFINER chain — so an
  Ops Admin was refused at the FIRST line. The lesson: **when you widen who may do something, trace
  the whole call path, not the first refusal you find.**
- **Trainer ownership** (#46): `course_staff_assignments` + `can_manage_course()`. `courses.manage_all`
  bypasses assignment; `courses.manage_assigned` needs a live row. Publishing and deleting are
  **separate capabilities** — a Trainer authors, someone with `courses.publish` ships.
  ★ **Storage WRITES are authorized by the course id parsed from the object path, and that is the
  exact inverse of what #44 removed.** `course_object_course_id()` returns NULL for anything that is
  not precisely `lessons/<uuid>/<file>` or `covers/<uuid>/<file>`, and
  `user_can_manage_course(uid, NULL)` is false — so a malformed path **denies**. #44 deleted
  `course_object_allowed()` because it path-parsed a **READ** and failed OPEN. Reads stay
  reference-based via `course_video_object_readable()`. Do not blur those two.
- **Discretionary extensions** (#47): `admin_grant_special_extension()` + the append-only
  `student_access_events` ledger, gated on `students.extend_access` — a key **only `super_admin`
  holds**, because a goodwill extension creates paid access with no payment behind it. It extends the
  current term **in place** rather than superseding it: `batch_entitlements.source_subscription_id` is
  frozen against re-pointing, so a superseding row would strand the member's cohort seats.
- **Client**: [src/lib/staffRoles.js](src/lib/staffRoles.js) is the pure MIRROR (never the authority) —
  `staffCan()`, `canManageCourseClient()`, `staffEntitlement()`, `ADMIN_TAB_PERMISSION`,
  `lastSuperAdminGuard()`, and the fail-closed `EMPTY_STAFF_CONTEXT`. `AuthProvider` exposes
  `staff / staffReady / staffDegraded / isSuperAdmin / can / refreshStaff`. **Absent permission data
  means "no", not "yes"** — the pre-#40 community bug was a client that re-derived capabilities and
  failed OPEN while they loaded.
- **The chokepoint gained a role half.** `visitedTabs.map` used to test `entitlement.allowsTab(tabId)`
  alone — but admin tabs are not in `DEFAULT_STAGES`, so `allowsTab` never had an opinion about them,
  and a `full: true` student who typed `/admin/enrollments` **mounted the component and ran its
  queries**. `adminTabAllowed()` now refuses first, gated on `staffReady`. Since T12B-D1 its refusal
  is a ROLE answer (`RestrictedTab reason="role"`, no Upgrade), and an admin tab waits for the staff
  context ("Checking your access…") instead of flashing the plan upsell at a Super Admin who
  deep-linked one — see `tabAccessView()` in the Navigation model's keep-alive bullet.
- **Server**: [api/_lib/staffAuth.js](api/_lib/staffAuth.js) is the ONE gate for `api/admin/*` —
  verify JWT → ask the database with the CALLER's JWT → only then may `service()` be constructed.
  It **fails CLOSED**, deliberately unlike the fail-open `is_enrolled()` gate in `api/anthropic`
  (`api/elevenlabs` now fails closed too — see the Voice assistant section), because what it
  protects is the service-role key. Its one legacy fallback applies
  to a **missing** function only — answering a timeout by consulting a weaker check would convert an
  outage into a privilege escalation.
- **Break-glass**: `npm run staff:bootstrap -- --email you@… [--apply]`. It writes
  `staff_memberships` + `staff_role_events` **directly** rather than calling
  `admin_upsert_staff_membership()`, because the Management API runs as `postgres` with no JWT, so
  `auth.uid()` is null and the RPC would 403 every time. It never sets `profiles.is_admin`.
- **The invitation lifecycle (#49).** #45 shipped an invitation **nothing could accept**:
  `staff_memberships` allowed `status='invited'`, the API wrote it and the directory rendered it,
  but no function, trigger or policy moved a row out of it. A real Operations Admin sat there with
  a confirmed email and a password, being shown the ₱1,499 student pricing page — because
  `is_admin` is false for every non-super role by design and the gate had no other reason to pass
  them. `accept_staff_invitation()` is the ONLY `invited → active` path and **takes no arguments**:
  the subject is `auth.uid()`, the role is the one already on the row, so there is no surface on
  which to name someone else or pick a role. It locks `for update`, requires
  `auth.users.email_confirmed_at`, refuses suspended/revoked rather than reactivating them, and is
  idempotent. ★ `my_staff_context()` now emits authority **only** for `status='active'`, plus a
  separate `membership` object that carries **no permission list by construction** — that split is
  what lets the client render "you were invited as a Trainer" without a pending row sitting one
  inverted boolean away from a live one. ★ **No `is_admin` trigger work**: `staff_sync_is_admin`
  already recomputes on UPDATE, so acceptance flips the cache for a Super Admin and leaves Ops
  Admin/Trainer false.
- **The invitation EMAIL is this repo's, not Supabase's (#49).** `inviteUserByEmail()` is gone —
  it used Supabase's mailer and the hosted "Invite user" template, which was verbatim the stock
  default (one `<h2>`, one bare link, subject "You've been invited"). Now: `generateLink()` mints
  without sending, `api/_lib/staffInviteEmail.js` builds HTML **and plain text** with the role in
  the subject, and `api/_lib/email.js` sends it through Resend. **Do not edit the dashboard
  template — nothing reads it.** The link is **first-party with the token in the fragment**
  (`/staff/invitation#invite=…`), which needs no Redirect-URL allow-list entry, keeps the token out
  of server logs and `Referer`, and cannot be redeemed by a mail-scanner prefetch (Supabase's
  `/auth/v1/verify` redeems on GET). Format lives in `src/lib/staffInvite.js` and is shared by both
  sides. `INVITE_LINK_TTL_HOURS` **mirrors** the Supabase `mailer_otp_exp` setting by hand — change
  both together.
- **The invite path branches on CONFIRMED, not on EXISTS (#49)** — and that was a real bug. The old
  code asked only whether an Auth user existed, so re-inviting an unaccepted invitee took the
  "promote" branch and flipped them to `active` with no acceptance and no email. Now: absent →
  `invite`; exists-unconfirmed → `magiclink`, stays `invited`; exists-confirmed → promote + a
  notification carrying no token. Ordering is a safety property — **membership row before email,
  always** — so a failed send leaves a recoverable `invited` row, never an active one.
- **The gate ordering is a pure function now (#49).** `resolveGateScreen()` in
  [src/lib/gateScreen.js](src/lib/gateScreen.js) decides; `BookkeeperProToolkit` switches on the
  answer. Every rule that ordering encodes used to be only a comment. `staffBypassesPaywall()` —
  written in #45 and imported by **nothing** — is now wired into `useEnrollmentGate`, so active
  staff are not treated as unpaid students. The `staffReady` wait is deliberately narrow: it
  applies only immediately before a **price-bearing** screen, so no student pays the RPC's latency
  and no invited Trainer sees a flash of the paywall. A degraded staff context falls back to
  `profile.is_admin`, never to "assume staff".
- **The invitation is a STATE MACHINE now (#50, `db/2026-08-30-staff-activation-consistency.sql`).**
  #49's screen derived its step from ONE component-local boolean, and the gate's
  `!profileReady → SPLASH` arm **unmounted it at the exact moment `verifyOtp()` succeeded** — a
  new session uid makes `profileReady` false — so a fresh instance forgot the token was spent,
  offered Accept again, and the duplicate exchange told a brand-new Operations Admin their
  invitation had "expired". A refresh likewise reset `needsPassword = exchanged` and made the
  password OPTIONAL for the one person who does not have one. Now:
  ★ **Every screen is a projection of `resolveInviteState()`** in
  [src/lib/inviteMachine.js](src/lib/inviteMachine.js) (pure; pinned by
  `test/inviteMachine.test.mjs`), and every deciding fact is DURABLE — served by the new
  `auth.uid()`-scoped **`staff_invitation_state()`** RPC (`exists/status/role/email_confirmed/`
  **`has_password`** — the fact no client could previously ask for). Unmount, remount and refresh
  all rebuild the same state. **The recovery rule:** while the signed-in user's own membership is
  `invited`, the machine can never return `expired` — a dead token becomes the credentials step.
  ★ **The gate keeps a token-holding invitation mounted through the profile load**
  (`gateScreen.js`'s `!profileReady` arm), and the ban is enforced twice: the `REJECTED` arm fires
  the moment the profile lands, and `accept_staff_invitation()` refuses a rejected profile
  server-side (`STAFF_ACCOUNT_REJECTED`).
  ★ **Token redemption is single-flight**: a `useRef` lock checked before any await (a `useState`
  busy flag is not a lock — setState is async and StrictMode double-invokes), the secret lives in
  a ref and is nulled on spend, and the root keeps only `{token: null, redeemed: true}` so
  `hasInviteToken` still pins the gate. `test/tokenLeakage.test.mjs` scans that the token reaches
  no console, no storage, no query param, no response body and no DB column.
  ★ **An active staff member is not a pending STUDENT.** `staff_sync_is_admin()` now also flips a
  `pending` profile to `approved` in the same transaction as the acceptance — scoped to `pending`
  so a `rejected` ban is never laundered and a revoke never un-approves — plus an idempotent
  backfill. `admin_access_request_queue()` excludes `invited`+`active` staff (`suspended`/`revoked`
  deliberately kept — they may be real students), the sidebar badge now asks
  **`admin_access_request_pending_count()`** (same predicate, same `has_staff_permission` gate —
  it used to count through `profiles_admin_select` RLS, a different authorization path), and
  `admin_review_access_request()` refuses self-review (`ACCESS_REQUEST_SELF_REVIEW`, Super Admin
  exempt like #48).
  ★ **"Not now" routes by identity** (`resolveDeclineTarget()`): a paying student falls back to
  the product they bought, a signed-out holder to sign-in, and a STAFF-ONLY invitee is *deferred*
  — kept on a "finish later" card — because for them the old answer was the ₱1,499 pricing page.
  ★ **A deferral holds only against the COLD PAYWALL, and only while it would still show.** The
  pending/renew_pending/finalizing screens show no price, and MembershipExpiredScreen shows one
  only to someone who already bought — it carries their Renew/Extend/Upgrade actions. Deferring
  any of them replaced an accurate screen with "nothing else is needed from you" and then re-pinned
  it every render, so a lapsed member offered a job could reach Renew only by accepting the job.
  `declineWouldShowAPrice()` and the gate's `staffOnlyWouldSeeAPrice()` are the two halves of that
  rule and must move together. Every card a signed-in viewer can be pinned on carries an escape.
  ★ **Success lands on the Dashboard**, with the role named and the ops queue as a labelled
  secondary action — never dropped straight into a list of other people's payments.
- **The approve RPCs were client-callable, and that was an Ops-Admin escalation (#55,
  `db/2026-09-04-approve-rpc-grant-revoke.sql`, folded as §42).** `approve_subscription()` and
  `approve_extension()` are SECURITY DEFINER and were granted `EXECUTE` to `authenticated`, gated only
  on `has_staff_permission('enrollments.review')` — a permission **Operations Admins hold**. Neither
  function reads or writes `enrollment_requests`, so #48's `enrollment_self_approval_guard` (a BEFORE
  UPDATE trigger on *that* table) can never fire on this path, and `p_request_id` is nullable and never
  checked for existence, status or payment.
  ★ **Verified live on 2026-08-31**, signed in through PostgREST as a real active `operations_admin`:
  `approve_subscription(<own uid>, 'vip', null)` inserted an active VIP term with `request_id` null and
  `grant_source` `'payment'` where no payment existed, flipping `is_enrolled()` false → true and taking
  visible published courses from 0 to 3; `approve_extension(<own uid>, null, 365)` then stacked a year
  on. That is strictly more power than `admin_grant_special_extension()`, which #47 restricted to Super
  Admin *precisely because* a goodwill grant creates paid access with no payment behind it — and which
  writes an append-only `student_access_events` row. This path wrote none.
  ★ **The revoke is the whole fix, and it breaks nothing.** Nothing calls these from a client (`grep`
  finds zero call sites in `src/` and `api/`); the sanctioned caller `admin_finalize_enrollment()`
  invokes both **nested** and is itself SECURITY DEFINER, so inside it the effective user is the owner
  (`postgres`), which holds its own EXECUTE. The grant was legacy from
  `2026-07-04-subscription-lifecycle.sql`, when the client *did* call it directly; #32 replaced that
  path and never revoked what it left behind. **Client-neutral**, so it applies in either order
  relative to a deploy. Pinned by `test/approveGrantSql.test.mjs` (both the dated file and the fold)
  and by a `#55` check in `npm run db:audit`.
- **Community authority is no longer Super-Admin-only (#56,
  `db/2026-09-05-community-staff-authority.sql`).** `community.manage` and
  `community.moderate` existed from #45 but were held only by `super_admin`, which is
  exactly why #45 left every community RPC and policy on `is_admin()` and said so at
  `db/2026-08-25-staff-authorization.sql:1279`: the two predicates were **equivalent for
  the only role that held them**. #56 grants both keys to **Operations Admin AND Trainer**
  (28 → **32** grants), which removes that precondition — so the grant is not the change,
  it is the trigger for it. Granting alone would have shipped two roles that look able in
  the UI and 403 at the first server call.
  ★ **The nine config RPCs are re-gated IN PLACE, not restated.** One idempotent,
  self-verifying `do $regate$` block reads `pg_get_functiondef()`, asserts the legacy guard
  appears exactly once, replaces that one string and executes the result. Two reasons:
  `admin_save_community_channel()` has **no current body in this repo** (#41 is its last
  `create or replace`; #43 then TEXT-PATCHES it at runtime), so retyping it would drop
  #43's fix — the #33/#34 failure mode; and a DO block is ONE statement, whereas nine
  separate CREATEs sent by `apply-db-files.mjs` (one per HTTP round trip, no transaction)
  could fail at the fifth and leave a **mixed authorization state with no rollback**.
  ★ **`community_posts_guard()`'s `created_at` bypass stays `is_super_admin()`** — the one
  deliberate departure from #45's single-predicate rule. Backdating is forgery, not
  moderation: a forged `created_at` launders into `last_activity_at` and self-pins a post
  above the whole activity-sorted feed. The other three guards (pin, lock, and the UPDATE
  freeze) move to `community.moderate`; **without the fourth the moderation RPCs would
  silently no-op** and still return success.
  ★ **Moderation is now a bounded server action.** `community_moderate_post` /
  `community_moderate_comment` take an id and a strict action enum, so they cannot express
  `author_id`, `body`, `title`, `channel_id`, `created_at` or a counter; the client used to
  PATCH the tables directly, which worked only because `community_*_admin_all` is a blanket
  FOR ALL policy — i.e. the CLIENT chose the columns. Every state change writes one
  append-only `community_moderation_events` row; a no-op writes none, because the ledger
  answers *when did this become pinned* and a double-click must not corrupt that.
  `restore` and `hide` both refuse a `status='deleted'` row: that is the author's own
  withdrawal, and allowing `hide` would launder it back into the feed in two calls while
  stranding the author behind `status <> 'hidden'`.
  ★ **The five `community_*_admin_all` FOR ALL policies stay `is_super_admin()`, and that
  is the load-bearing half of the above.** None of those tables carries a table-level DML
  revoke, so `authenticated` keeps Supabase's default INSERT/UPDATE/DELETE grants and a
  FOR ALL policy is a raw PostgREST write path over every row. Re-gating them onto
  `community.moderate` — the obvious edit — would have let a Trainer rewrite another
  member's `body`, set `author_id`, or `DELETE` a post with no ledger row and no captured
  storage paths, leaving its private objects permanently unreachable; the bounded RPCs
  would have been one optional route of two. Ops Admins and Trainers instead get an
  OWN-ROW write path (§8d): the `*_own_insert`/`*_own_update` policies' enrolment-standing
  conjunct is widened to admit `is_community_staff()`, because `is_enrolled()` is false for
  a staff account with no subscription and without it an Operations Admin could moderate
  the forum and never post in it.
  ★ **`user_is_community_staff(uuid)` vs `is_community_staff()`** is the #45 two-form split,
  and using the caller-pinned form inside a `user_community_*(p_user)` body is the single
  most dangerous mistake available here — it answers about the CALLER, not the subject, and
  it fails **OPEN**. `test/communityStaffSql.test.mjs` pins against it.
  ★ **Storage deletes are bounded.** `community_media_delete` keeps today's blanket bucket
  reach as `is_super_admin()` and adds two narrower moderator arms: an attachment→post join
  (so a nameable object always belongs to a live post — an ORPHAN is unreachable), and a
  15-minute **receipt** arm limited to the paths this actor's own audited hard-delete just
  produced. The receipt arm is what lets the client sweep **after** the RPC; the FK cascade
  removes the rows the join arm needs the instant the post is gone.
  ★ **What did NOT widen:** `community_spaces_admin_all` stays on `batches.manage` (a space
  is created and destroyed by the batch lifecycle, and `admin_finalize_enrollment` refuses
  with `NO_SPACE_FOR_SEGMENT` when a batch has none — write access there could break
  enrolment approval for a whole cohort); `is_enrolled()`; `is_approved()`;
  `community_stamp_author()`; and the *eligibility* reads in `search_community_members()`
  and both notify triggers, which ask whether an account is in good standing, not whether
  it has authority.
  ★ **`admins_only` is a compatibility identifier.** The stored value is unchanged; its
  meaning is now "authorized Community staff only", and ordinary staff holding neither
  community permission do not reach it.
  ★ **Client:** `communityAuthority()` in `src/lib/staffRoles.js` replaces the single
  overloaded `isAdmin` in `CommunityHub` with `canConfigure` / `canModerate` /
  `hasStaffAccess`. It fails CLOSED while `staffReady` is false and falls back to the
  legacy `profile.is_admin` only when the context is degraded — never to "assume staff".
  ★ **Ship the SQL and the client together.** A pre-#56 bundle PATCHes `community_posts`
  directly, which still works for a Super Admin and 42501s for everyone else.
- Setup + the full permission matrix: **[STAFF_ROLES_SETUP.md](STAFF_ROLES_SETUP.md)**.

## Financial Management — the business ledger, Super Admin only (#58)

Tab id `financialmanagement`, route `/admin/financial-management`, an admin-nav row directly after
Enrollments (Getting Started Video · Access Requests · Enrollments · Financial Management · Communications ·
Meetings & Tasks · Student Imports · Batches · Team & Roles — #69 put Getting Started Video first).
**Applied to production 2026-09-14** as one transaction, after a full rehearsal on the live catalog that
was forced to abort — the first attempt was refused whole on a STABLE function in a generated column (see
the fingerprint comment in the migration). Verified there by rolled-back impersonation: Ops Admin, Trainer,
student, a revoked Super Admin and anon read 0 rows from all 12 populated tables and get FORBIDDEN from all
34 RPCs; an Ops Admin approval posts exactly one balanced collection they cannot read back.
Migration [db/2026-09-09-financial-management.sql](db/2026-09-09-financial-management.sql), folded
verbatim as bootstrap **§45**. The native replacement for the Google Apps Script finance app in
`Google Financial script/` — which had **98 server functions and exactly ONE server-side authorization
check**, so 30 privileged mutations (reconcile, import, post to the ledger, mass email) were
unauthenticated endpoints.

**No `api/` route and no new dependency.** Like every other admin screen it calls `supabase.rpc(...)`
directly; the three screens that use `api/admin/*` do so only because they need the service-role key.
Charts are hand-rolled inline `<svg role="img">` modelled on `ProgressTrendChart` — never a CDN.

- **`finance.manage`** — the 20th staff permission, held by **super_admin only**. Not by Operations
  Admin, who reviews payment proofs: *causing* a finance write is not *reading the books*.
- **12 tables**, 48 functions (counting the restated `app_error_catalog()`), **34 client-callable
  RPCs** (14 readers + 20 writers), plus the internal `finance_request_collected()` helper.
- **Eight sub-tabs**, all one component tree: Overview · **Daily Income** (#64, below) · Sales & Receivables · Income & Expenses (record
  income/expense, reverse, recurring proposals) · Profit & Loss · Audit trail · **Bank & Reconciliation**
  (client-side CSV/XLSX parse with a human-declared date format, stage → commit, exclude-with-reason,
  match/unmatch, correct statement balances, close/reopen) · **Setup** (whether approvals can post,
  default accounts, per-plan income accounts, backfill, month close/reopen, chart of accounts, go-live
  opening balances). ★ `financeSql.test.mjs` asserts every `call('finance_…')` in the monolith names a
  function #58 defines AND grants — with no linter or jsdom, that scan is the only guard on an RPC typo.
- ★ **ZERO CLIENT WRITE PATHS.** Every finance table has **exactly one policy** — a SELECT gated on
  `finance.manage` — and **no** insert/update/delete policy anywhere; grants are revoked and only
  SELECT is given back. All mutation goes through SECURITY DEFINER RPCs, so the legacy system's 30
  unguarded mutations are structurally unreachable rather than merely gated. This is deliberately
  stricter than the community tables, whose blanket `FOR ALL` policies are a raw PostgREST write path.
- ★ **DEFECTS ARE UNREPRESENTABLE, NOT FILTERED.** `subtype` has no `accounts_receivable`, so no
  receivable account can exist, so no accrual revenue entry can exist — the legacy
  `gross = collections + outstanding` has nowhere to live. A CHECK forbids any income/expense account
  from being anything but `reporting_class = 'business'`, so personal spending cannot be an expense
  (it is an **owner's draw**, leaving the P&L while cash still ties). `check ((debit > 0) <> (credit > 0))`
  makes the legacy single-entry row — 228 rows, all positive, sign carried in an `AccountType` column —
  impossible to insert.
- ★ **THE APPROVAL HOOK.** `after update on enrollment_requests` with
  `when (new.status = 'approved' and old.status is distinct from 'approved')` — without the WHEN it
  fires on every `admin_notes` edit. It posts a balanced collection **in the approver's transaction**,
  keyed `'enrollment:' || request_id || ':collection'`. It is SECURITY DEFINER (RLS does not apply)
  and revoked from every role, so it is reachable **only as a trigger** and has no argument surface.
  It deliberately contains **no `has_staff_permission` check** — `auth.uid()` is unchanged inside a
  SECURITY DEFINER chain, so one there would refuse every Operations Admin approval. Its authorization
  is structural, and rests on **both** halves of #48: `enrollment_self_approval_guard` (you cannot
  approve your own request) **and** `enroll_req_super_write` (a reviewer cannot forge one and approve
  their own forgery). The preflight asserts both. `admin_finalize_enrollment` is **not retyped** —
  the trigger is additive, avoiding the #33/#34 failure mode.
- ★ **NEVER `alter table … force row level security`** on a finance table: it subjects the table
  OWNER to policies and breaks that trigger. It looks like hardening; it is a breakage.
- ★ **ONE IDEMPOTENCY NAMESPACE.** `finance_payment_events.idempotency_key` is `not null unique`, and
  the hook, the backfill, manual entries, recurring posting and reversals all mint into
  it — so the approval/backfill overlap is a no-op instead of the legacy daily job's re-recognition of
  the same receivable as revenue *every day it stayed open*.
- ★ **A LOCKED PERIOD CAN NEVER BLOCK AN APPROVAL.** `finance_lock_period` refuses unless the period
  has fully elapsed **in the reporting timezone** (`batch_is_past()`'s reasoning applied to
  accounting). An approval is dated today, always in the current period — so "accounting closed the
  month and now nobody can approve a student" cannot happen, and no carve-out exists. A reversal into
  a locked period never silently back-dates and never silently refuses: it **returns the period it
  landed in** so the UI can say *"this will be corrected in October, not September."*
- **Cash basis by construction** — no `p_basis` argument exists, so the basis cannot be misreported.
  The legacy selector was echoed back and branched on nothing.
- **Money keeps centavos** (`phpFmt`); the legacy app rounded them away everywhere, so ₱20,750.50
  displayed as ₱20,751 in the ledger, the P&L and every export.
- ★ **THERE IS NO LEGACY-DATA IMPORT, BY OWNER DECISION (2026-09-12).** The Apps Script workbook
  showed the *shape* of the data only; no student was ever onboarded onto it. An earlier draft staged
  it into four `finance_legacy_*` tables; they were removed before #58 was applied anywhere. Every
  figure comes from Toolkit approvals and entries a Super Admin records. Do not reintroduce an
  importer — `financeSql.test.mjs` fails on any `finance_legacy_` object in executable SQL.
- ★ **ONE DEFINITION OF "COLLECTED".** `finance_request_collected(uuid)` is the only place the three
  reports (dashboard outstanding, sales by plan, receivables worklist) learn what a request has paid:
  a **reversed** collection does not count, and an outgoing event (a refund) **subtracts**. The
  approval date is `coalesce(reviewed_at, created_at)` in the business timezone in all three.
- **Per-plan income accounts:** `enrollment_plans.finance_income_account_id` (nullable → the settings
  default). The hook uses it only when it is an ACTIVE income account and otherwise **falls back**
  rather than refusing — a refusal there blocks every approval of that plan.
- **Out of scope for #58, deliberately:** Zoom, the to-do board, announcements, and receivable reminder
  *sending* (the legacy path is an unauthenticated relay whose reminder counter resets whenever anyone
  edits the subject line). Announcements and reminder sending arrived in **#61 Communications**, with
  counts keyed on the request; Zoom and the to-do board are the planned #62.
- Client mirror: [src/lib/financeModel.js](src/lib/financeModel.js) — **four exports, and it stays
  four** (the `studentProgress.js` lesson). Suites: `test/financeSql.test.mjs`,
  `test-db/financeRls.dbtest.mjs`.

**Finance parity (#59, [db/2026-09-14-finance-parity.sql](db/2026-09-14-finance-parity.sql), fold §46)** —
the legacy app's day-to-day surface on top of #58. **Applied to production 2026-09-15**, after a
stage review by two independent reviewers, fixes, and behaviour probes on the live catalog in aborted
transactions. **13 finance tables** now (`finance_expense_presets`:
payee + account quick-picks, never an amount, seeded by category only).
- **Screens:** Overview gains the pipeline strip, Sales by package & batch (Today/MTD/YTD, CSV, print),
  enrollments-by-package bars and recent activity; Sales & Receivables gains the sales report (presets,
  package/batch/payment filters, totals, daily chart, CSV, print); Income & Expenses gains payee, presets,
  ledger filters with totals, and **Reclassify**; Profit & Loss is a pivot (month/quarter/week/total,
  filters, hide ₱0, % of income, drill-down side panel, CSV, print, owner's draw as a memo); Bank &
  Reconciliation gains the **bank feed** (tiles, Match / Add / Undo) and statement-layout presets.
- ★ **MATCH BEFORE ADD.** A student's deposit was already posted by the approval hook. The feed matches the
  statement line to that entry; adding it again would count the money twice, so `finance_categorize_bank_transaction`
  REFUSES a deposit into any account approvals post to (`FINANCE_BANK_ENROLLMENT_INCOME`) and Add offers
  "Match instead" whenever an entry already records the amount. A unique index on
  `(matched_entry_id, account_id)` lets one entry clear one line **per statement account** — per ACCOUNT,
  because a bank→card transfer is one entry that must clear on both statements.
- ★ **A LINE IS CLEARED ONCE — BY THE FEED OR BY A RECONCILIATION ITEM, NEVER BOTH.** #58's close counts
  every `status='matched'` transaction. #59 restates `finance_bank_txn_set_status`,
  `finance_match_reconciliation_item`, `finance_unmatch_reconciliation_item` and
  `finance_reconciliation_detail` to refuse or exclude feed-linked lines, and `finance_reverse_entry`
  refuses an entry a statement line points at (undo it in the feed).
- ★ **Add is keyed per ATTEMPT** (`'bank:'||txn||':'||n`). Keyed on the transaction alone, Add → Undo → Add
  found the reversed entry by its key and silently re-linked it.
- ★ **The statement sign is the ACCOUNT's**: positive = money into the account's favour, so a card payment
  is positive and a charge negative. [src/lib/bankStatement.js](src/lib/bankStatement.js) is the one reader
  (declared date format, DR/CR, parentheses, card sign flip, legacy bank layouts); the monolith's copies are
  gone and `test/bankStatement.test.mjs` fails if they return.
- ★ **Reclassify never edits history** and moves only what is LEFT: the amount is net of earlier live
  reclassifications of the same entry, so a second move of the same cost is refused. Allowed pairs:
  income→income, expense→expense, expense→owner's draw. Reversing an entry with a live reclassification is
  refused (`FINANCE_ENTRY_HAS_ADJUSTMENTS`).
- **Printing builds the page with DOM calls and `textContent`** (`financePrintTable`) — never an HTML
  string, because the legacy app rendered statement descriptions and form answers unescaped.
- ★ **A card reconciliation compares amounts OWED.** A card statement's balance rises with charges, which
  are stored negative, so close and detail negate the statement movement for `cash_flow_class='card'`.
- ★ **Only an ORIGINAL entry is reclassified**, and reverse / reclassify / match / the reconciliation matcher
  all lock their row before checking. Add, Match and status changes refuse inside a closed reconciliation.
- Re-signs five #58 functions (each dropped first) and restates the catalog; #60 restates it again, so
  the catalog has been restated again since, so `CURRENT_CATALOG_MIGRATION` (communityStaffSql) and
  `CATALOG_OWNER` (financeSql) both point at **#69** (141 codes) — repoint them with every restatement. No permission changes.
  Suite: `test/financeParitySql.test.mjs` (it pins every stage-review fix above).

**Daily Income (#64, [db/2026-09-19-finance-daily-income.sql](db/2026-09-19-finance-daily-income.sql), fold §51)** —
cash actually posted, day by day, for one month. ONE reader, `finance_daily_income_report(p_month)`,
Super Admin only; no table, policy, permission or error code (the catalog stays with #63). The legacy
Apps Script's version is audited in [docs/audits/2026-09-17-legacy-finance-script-audit.md](docs/audits/2026-09-17-legacy-finance-script-audit.md).
- ★ **IT READS THE LEDGER AND NOTHING ELSE.** Income is `sum(credit − debit)` over income-account lines
  by `entry_date` — the same definition as `finance_cash_basis_pl` and `verified_collections` — so a month
  equals the P&L's income + other income BY THAT SHARED DEFINITION (only `test-db` compares the two).
  Every response also carries an **independent** `reconciliation.ledger_income_total`, which proves
  something narrower: every income entry landed in exactly one bucket (difference must be 0). Never a catalog price, never the
  student-typed `amount_paid`, never `finance_request_collected` (which is lifetime, not by day).
  `test/financeDailyIncomeSql.test.mjs` fails if the body names any of them.
- ★ **EVERY ENTRY IS BUCKETED BY THE ROOT OF ITS REVERSAL CHAIN** (`reverses_entry_id`, depth-bounded,
  falling back to itself so no row is ever lost): an enrollment collection (the root carries an
  `enrollment_collection` payment event — the package is that event's **plan snapshot**, never the
  student's plan today), refunds (root kind `refund`; the ledger has no refund→enrollment link, so a
  refund is **not** attributed to a package. ★ Reversing the collection is NOT a substitute for a
  refund: `finance_request_collected` ignores a reversed collection, so the student's full price shows
  as owed again in Receivables and can be targeted by payment reminders), other
  income (a collection with no enrollment event: manual, bank feed, recurring) and adjustments (income
  lines on any other kind of entry). An income→income reclassification nets to zero and drops out.
- ★ **A CORRECTION NEVER REMOVES THE ORIGINAL FROM ITS DAY.** A reversal is a signed amount on the
  reversal's OWN `entry_date`, attributed to the original's package. The old `not exists (… rv.reverses_entry_id …)`
  idiom used by the sales reports would delete a September collection from September because it was
  reversed in October — never use it here. And since #64, **Reverse defaults to today** in the business
  timezone (owner decision 2026-09-17), with "original date" kept for voiding a mistake; before that, a
  reversal in an open month silently took the original date.
- **Package columns are `enrollment_plans`** (active plans, plus an inactive one only in a month it has
  money), in `position` order. A snapshot key with **no** catalog row — Gold, Core, a null key — is one
  Legacy/Other bucket with a per-name detail list, and never a column. There are no plan-key literals in
  the SQL or the component; "Essentials" is the Sampler **tagline**, not a plan.
- **Counts:** `collections` = payment events; `distinct_enrollments` = distinct requests. They coincide
  today — no writer creates a second collection event for a request, so a later instalment recorded by
  hand is Other income — but the schema allows one, the report handles it, and no label says "students".
- Dates: `entry_date` is already a business-timezone date stamped at posting; the only `at time zone` in
  the function computes "today". The calendar is `generate_series(0, v_to - v_from)` over integers (a
  date/interval series resolves to timestamptz and follows the session TimeZone). A month outside
  `2020-01 … greatest(month-of(today+1), month-of(max(entry_date)))` raises `22023`, **after** the
  permission check. Those two bounds coincide today — the entry guard caps `entry_date` at `today+1` —
  but the `greatest()` is deliberate: it fails SAFE, so a far-future or imported entry stays viewable
  instead of being refused by a picker that cannot reach the month its own data sits in.
- **Client:** `FinanceDailyIncomeReport` loads itself with `supabase.rpc(...)` directly — the parent's
  `call()` would replace the whole finance screen with the #58/#59 setup card for a missing #64 — and a
  failed load clears the report, so a failure never reads as an empty month. Figures are never summed
  in React. `FINANCE_LEDGER_CHANGE_EVENT` is dispatched after a single approval and once after a bulk
  approval run; `FinancialManagement` listens (coalesced) and invalidates its caches plus bumps
  `dailyVersion`/`ledgerTick`. ★ `invalidateReports` must never dispatch that event — the listener
  calls it, and `dispatchEvent` is synchronous.
- **Deliberately not recreated:** the legacy nightly "Daily Sales" posting. Approvals already post each
  collection; a daily summary row would count every sale twice.
- Suites: `test/financeDailyIncomeSql.test.mjs` (dated file + §51), `test/financeDailyIncome.test.mjs`
  (the lib), `test/uiSafety.test.mjs` §21 (wiring), `test-db/financeDailyIncome.dbtest.mjs` (a month of
  books built through the real writers, reconciled against the P&L and the dashboard), and the `#64`
  block in `scripts/audit-db.mjs`. The RPC wiring test in `financeSql.test.mjs` now reads #58 + #59 +
  #64 and also checks the `run(key, 'finance_…')` / `act(key, 'finance_…')` call sites it used to miss.

**Enrollment management (#60, [db/2026-09-15-enrollment-management.sql](db/2026-09-15-enrollment-management.sql), fold §47)** —
Enrollments gains search, package filter, sort, CSV, bulk approve/reject/hold, holds and amount
correction; still gated on `enrollments.review`, so Operations Admins keep it. **Applied to production
2026-09-15**, directly after #59.
- ★ **A hold is a staff-only SIDE TABLE** (`enrollment_request_holds`), never a column: students SELECT their
  own request rows. `expires_at` is never touched; "overdue" stays derived (pending, past `expires_at`,
  not held). A decided request releases its hold by trigger, and `enrollment_request_events` is the
  append-only timeline.
- ★ **AN APPROVAL WITHOUT ITS GRANT IS REFUSED** (`enrollment_approval_requires_grant`). #48's column
  grant on `status` let any reviewer set another student's request to `approved` with a direct UPDATE —
  skipping `admin_finalize_enrollment`, granting nothing, and (since #58) still booking the payment. The
  guard requires a subscription carrying the request's id, or the grandfathered no-expiry term
  `approve_extension` returns unchanged; Super Admin keeps break-glass. `admin_finalize_enrollment` is
  NOT retyped.
- `admin_correct_enrollment_amount` works on PENDING requests only (a posted collection is corrected in
  Financial Management) and never on your own request. `admin_staff_display_names` returns names of
  STAFF only. Suite: `test/enrollmentManagementSql.test.mjs`.
- ★ **A BULK DECISION SAYS WHAT BECAME OF EVERY EMAIL (#69, EMAIL-1 — pre-existing since #60).**
  `runBulk` used to discard `notifyDecision`'s answer, so a cohort's bulk approval showed every row
  green while the server refused the eleventh email onward. A bulk approve or reject now records each
  row's email outcome and lists it under the row, followed by a fixed-order "Emails: …" tally (sent,
  already on its way, may not have been sent, not sent, not configured). A 429 is waited out
  (`BULK_EMAIL_RETRY_DELAYS_MS`: 20 s, then 40 s; at most three asks per row), announced in the
  dialog's `role="status"` header — "Pausing for this app’s own limit on decision emails — the email
  for Maria Santos’s request is asked for again in a moment." (K3R-AE-1: the request by the NAME on it, never
  the address typed on it, because the email goes to the account's `profiles.email`; and this app's
  limit, never "the email service") — and reported as the row's outcome if it never lets up. Only the
  SERVER's own 429 counts: `rateLimited` is `res.status === 429` exactly, pinned (V-EMAIL1-RATELIMIT).
  Every other answer — a provider 429 (502 `resend_429`) and an unclear 502/504 included — is recorded
  exactly as it came. The dialog says "the list says what became of every email", and no longer
  promises "the student is emailed". The endings are `emailOutcomeUnclear()`'s, shared with Access
  Requests (see the Access Requests bullet in Authentication).

## Communications — announcements, student emails, payment reminders, automations (#61)

Tab id `communications`, route `/admin/communications`, an admin-nav row directly after Financial
Management. Migration [db/2026-09-16-communications.sql](db/2026-09-16-communications.sql), folded
verbatim as bootstrap **§48**. **Applied to production 2026-09-16 (Manila time)** as one transaction, right
after a fresh forced-abort rehearsal on the live catalog. Verified there by the post-apply catalog checks
(21 permissions / 34 grants; four tables with exactly one SELECT policy each; the four sending functions
executable by `service_role` alone; no anon-executable function; no client write grant; the 104-code
catalog), by the full behaviour probe re-run against the applied schema in a rolled-back transaction —
identical to the pre-apply run — and by an advisors comparison with the pre-#61 baseline, whose only
security change is the 15 new client RPCs on the authenticated SECURITY DEFINER list.

- **`communications.send`** — the 21st staff permission, **super_admin only** (34 grants). A payment
  reminder reads what a student owes, so it ALSO needs `finance.manage`, checked in
  `comm_create_campaign` / `comm_preview_audience` / `comm_retry_failed` / `comm_cancel_campaign`, the
  audience resolver's receivables branch, and again in `api/admin/communications.js`. ★ **Reading** one
  needs it too: the SELECT policy on `comm_campaigns` / `comm_deliveries` hides `payment_reminder` rows
  from a sender without `finance.manage`, and every reader RPC filters them. Latent while only
  super_admin holds `communications.send`; load-bearing the day another role is given it.
- **Four tables** (`comm_settings`, `comm_automation_rules`, `comm_campaigns`, `comm_deliveries`), each
  with exactly one SELECT policy and **no client write path** — the finance rule.
- ★ **THE BROWSER DESCRIBES AN AUDIENCE; THE SERVER DECIDES WHO IT IS.** The legacy Apps Script took
  recipients, subject and body from the page and mailed them from the owner's Gmail — an open relay.
  `comm_resolve_audience()` resolves all current members / a batch / packages / an approval date range /
  one request / selected receivables / ≤50 pasted addresses. **Membership audiences** (all, batch,
  packages, approval range) never include staff (`invited` + `active`, the #50/#52 rule) or a banned
  profile; a pasted list with "active members only" off, or one enrollment request, is sent as named.
  ★ Every address comes from `profiles`, never from `enrollment_requests.email`, which the student
  types. A payment reminder is one row per BALANCE, so a student owing on two requests gets two, each
  with its own amount. ★ A batch audience or batch rule counts a seat only on the member's **LIVE plan
  segment** (the `user_entitled_batches` rule): a VIP who moved to a cheaper plan keeps `active` seats
  until they lapse, and must not keep receiving cohort email. The send endpoint accepts no recipient or
  content at all; it sends rows that already exist.
- ★ **SENDING IS SERVER-ONLY AND IDEMPOTENT.** `comm_claim_deliveries` / `comm_begin_send` /
  `comm_record_delivery` / `comm_enqueue_automations` are revoked from every client role and called by
  [api/admin/communications.js](api/admin/communications.js) (after `requireStaff`) and
  [api/cron/communications.js](api/cron/communications.js) (after the cron secret), through the shared
  [api/_lib/commSend.js](api/_lib/commSend.js). Claims use `FOR UPDATE SKIP LOCKED`, and **only the
  claiming attempt may record** (`comm_record_delivery(p_id, p_attempt, …)`), so a slow result from a
  released claim cannot overwrite the attempt that replaced it. Three attempts is the limit, with a 1-
  then 5-minute backoff (`next_attempt_at`). The Resend idempotency key is
  `comm-<delivery id>-<retry_generation>`, and it lasts 24 hours at the provider.
  ★ **AN AMBIGUOUS OUTCOME IS NEVER SENT TWICE.** A timeout, a 5xx, a CLEARED claim nobody recorded
  (released after ten minutes as `released`) and a provider 409 (recorded as `possibly_sent`) may all have been
  delivered. `ambiguous_since` records when the current key FIRST went out with an unclear answer, and it
  is **sticky**: a later rate limit or local failure neither moves nor clears it. That is the fix for a
  real double send — a timeout followed by two 429s ended as `failed:resend_429`, and judging by that
  last code alone "Retry failed" re-sent the email under a brand-new key. A row whose first unclear
  attempt is 20 hours old — or whose unrecorded claim was its third — becomes `failed:unknown_outcome`,
  whether it is still `sending` or back in the queue, whatever its latest code. "Retry failed" never
  re-sends `unknown_outcome` or `possibly_sent`; a row that was ever unclear goes again under the SAME key
  (the provider de-duplicates it), and only a row refused outright on every attempt (a bad address,
  missing payment details, a rate limit) under a new generation. The sender also asks an unclear answer
  again ONCE, a moment later, under the same key, when a whole email still fits — after clearing the row
  again, and keeping the first answer unless the repeat succeeds or is itself unclear (a 409, 429 or 401
  on the repeat says nothing about the first request). The tracker's `may_have_sent` marks any unsent
  row that carries the flag, and the CSV export carries it too.
  ★ **THE SENDER FITS INSIDE THE FUNCTION'S TIME LIMIT.** Each email is ONE provider request
  (`sendEmail({ maxAttempts: 1, timeoutMs, retry429: false })`); EVERY database call has a time limit
  (`rpcWithin`: 3 s, 8 s for the claim, 15 s for the enqueue) and is counted, with the pace, in the
  per-email worst case; each claim is sized to the time left; and a row the budget cannot reach is handed
  back (`deferred`) without spending an attempt — or simply left, because an uncleared claim is safe to
  walk away from (see below).
  ★ `sendEmail`'s `timeoutMs` has **no default** — `api/admin/staff.js` must keep waiting on an invitation,
  because aborting one and repeating it under the same key draws a 409 that it reports as "not sent".
  ★ **NOTHING GOES TO THE PROVIDER UNTIL THE DATABASE CLEARS IT.** Everything that can fail on the
  sender's side — the payment details read, rendering, the address check — happens first; then, as the
  LAST database call before EVERY send (and before repeating an unclear answer), the service-only
  `comm_begin_send(p_id, p_attempt)` holds the row's rule or campaign row in share mode, then locks the row, and in a
  later statement with a fresh snapshot
  confirms it is still this claim's, its campaign is not cancelled, and its rule is active **at the
  version the claim recorded on the row** (`claimed_rule_version`) — so a pause, an edit, and an edit
  followed by turning the rule back on all refuse — and stamps `send_started_at`. A refusal hands the row
  back: `skipped:stopped` for a campaign, `skipped:rule_paused` or `skipped:rule_edited` for an
  automation, so the next run queues the member with fresh attempts if the rule as it now reads still
  produces that notice (claim step 3 records a row it rejects after an edit as `rule_edited` too, never as
  `no_longer_eligible`, which would hold the key for good). An unanswered clearance gets one more try,
  then ends the run, and so does a record the database does not take — it does not send what it could not
  check. Counts follow what the record step decided: a stopped retry is "stopped", not "failed".
  ★ **The stamp is what makes walking away safe.** A stale claim WITHOUT it reached nobody, so the next
  claim releases it with its attempt refunded and nothing marked unclear; only a cleared claim is released
  as `released` / `unknown_outcome`. Before the stamp, a slow database or a killed function turned unsent
  emails into "outcome unknown". Cancel, pause, edit and delete count `in_flight` (rows already cleared).
  Because the clearance holds the rule or campaign row in share mode and they write it, a clearance racing them is
  either refused or counted, never neither, and the screen says those may still arrive. ★ Every one of them
  takes the rule or campaign row BEFORE any delivery row of it, and so does the enqueue, which keeps
  `FOR UPDATE` on the rule for that reason: locking the delivery row first deadlocked the clearance against
  a delete, whose `ON DELETE SET NULL` cascade locks every delivery of the rule. (Counting under
  delivery-row locks instead deadlocks with the claim, which locks those rows in the opposite order.)
  ★ One deadlock class remains, and is accepted: a claim can meet a rule delete (whose cascade reaches that
  rule's rows in every status) or another claim holding rows in the opposite order. Postgres rolls one back
  within a second, so nothing is sent twice or lost; a rolled-back claim (`40P01`, `55P03`, `57014`) ends
  the send run the way a claim that did not answer does, the Communications screen asks a rolled-back
  action once more, and a failed daily enqueue still sends what was already waiting. Every call also meets
  the database's own 8-second statement and lock limits, which bind before the sender's 15-second enqueue
  limit. A support address that cannot be read, with no
  `NOTIFY_ADMIN_EMAIL` fallback, also stops the run rather than mailing students with nowhere to reply.
  ★ **EVERY ROW IS RE-CHECKED AT THE CLAIM.** A cancelled campaign or an inactive rule sends nothing
  (the pick repeats both conditions); an automation goes out only if its RULE, run again with a week's
  catch-up window, still produces the row's dedupe key — so a member who renewed, left, became staff,
  was banned, left the rule's batch or packages, or ran past its timing is skipped — and its address,
  name and tag values are refreshed to the day of sending (the re-check re-tests `status = 'queued'` on
  the row it updates, or a claim that waited on another could skip a row that one is sending, and it runs
  only for a claim that can pick automations); a payment reminder recomputes the balance and is skipped
  when it has been paid. A queued row is a plan, not a promise. The rule preview counts a member as
  already handled by the enqueue's own test, so it never promises an email the run will not queue.
- ★ **NO PAYMENT DETAILS ARE STORED.** `{{payment_instructions}}` is filled from `payment_settings` by
  `commSend.js` at the moment of sending, only for a body that contains the tag — never a subject, which
  shows in inbox lists and on lock screens (`comm_create_campaign` / `comm_save_rule` refuse it, the
  composer and rule editor block it, and the renderer blanks it). Delivery `vars` hold
  name/plan/batch/days/expiry/week/amount_due; `db:audit` checks no row carries a payment key.
- ★ **A RULE IS BORN PAUSED, AND AN EDIT PAUSES IT AGAIN** — and editing or pausing a rule drops the
  emails it already queued, because the sender reads the rule's CURRENT text. A BEFORE INSERT trigger
  forces the first half. Triggers: `expiry_exact`, `expiry_within` (once per term), `program_week` (7-day
  anniversaries of the **first term of an unbroken run on the same plan**, `comm_program_root()`, so a
  renewal does not restart week 1 — but a lapse or a plan change does, because `approve_subscription`
  links every approval to the previous row whatever its age or plan; the legacy "weekly" rule fired
  daily); all skip a term with no end date. Dedupe is a **unique key** (`rule:<rule>:<term>:ends:<date>`
  / `rule:<rule>:<first term>:week:<n>`), not a scan of the last 600 log rows, so an extended term earns
  a fresh notice at its new date and a second run the same day is a no-op. ★ A row a pause, an edit or
  an inactive rule DROPPED was never sent, so it does not hold its key: the next run queues that member
  again anywhere in the claim's week-long window — so turning a rule back on after midnight does not
  strand it — unless an earlier try of it may have been delivered 20 or more hours ago, which the claim
  would only write off (the rule preview uses the same test). Each run re-reads every rule under a row lock, so it never queues matches from a definition an
  edit has just replaced. ★ A missed or capped day is **caught up** on the next run, up to seven days
  back (`last_complete_on`); a rule that has never completed a run catches up from the day it was
  turned on.
- ★ **THE DAILY CAP IS CHECKED UNDER A LOCK** on the `comm_settings` row: "used today" = sent since Manila
  midnight + everything still waiting. A message that would pass it is refused whole (`COMM_DAILY_CAP`);
  over-cap automation matches are left unqueued so the next run picks them up. Default 100 (Resend's free
  plan); set it in Communications → Settings. A double submit reuses the composer's `client_key` (minted
  on Review, kept until the message or the audience changes — Back alone keeps it), so the server returns
  the campaign it already made; after a dropped connection the composer says the outcome is uncertain
  rather than "not queued".
- ★ **VERCEL CRON CALLS GET.** `vercel.json` schedules `/api/cron/communications` at `0 1 * * *` (09:00
  Manila). The handler requires `Authorization: Bearer $CRON_SECRET`, compares SHA-256 digests with
  `timingSafeEqual`, and **fails closed when the secret is unset or shorter than 16 characters** — with the same 401 as a wrong secret,
  so the response does not reveal whether the schedule is configured (the reason goes to the log). It
  must never become an unauthenticated "send the queue" URL. It queues nothing while email is unconfigured (a notice would go
  out days late and eat the cap). `GET /api/admin/communications` returns `{ ok }` only — which secrets
  are set is read through the signed-in `status` action. Both handlers have a `commDevApi` route in
  `vite.config.js`.
- **Reminder counts key on the enrollment request**, not a subject prefix: `finance_receivables_worklist`
  is dropped and re-signed with `p_plan_keys` / `p_batch_ids` and `reminder_count` / `last_reminder_at`.
  Finance → Receivables gains package/batch filters, row selection and "Send reminder"; Enrollments gains
  an **Email** button and an "Emailed …" line, both rendered only for `communications.send`.
- ★ **Every preview is `<iframe sandbox="" srcDoc>`** built by `renderPreviewDocument()`; tag values are
  escaped and only `https:` is linked by [src/lib/commTemplates.js](src/lib/commTemplates.js) — the ONE
  renderer the preview and the sender share, so what the Super Admin reads is what the student receives.
- Suites: `test/commTemplates.test.mjs`, `test/communicationsSql.test.mjs` (SQL contract in both files,
  service-only grants, finance.manage read and write paths, the claim/record/backoff contract, the RPC
  names the app calls, the empty sandbox, the cron gate, the send loop's stop conditions and the
  composer's key and lock — every guard mutation-tested). Owner steps: set `CRON_SECRET` (at least 16 characters — the signed-in status check uses the same rule), confirm
  `RESEND_API_KEY` / `RESEND_FROM`, set the daily cap.

## Meetings & Tasks — Zoom meetings, invitations and the shared to-do board (#62)

Tab id `meetings`, route `/admin/meetings`, an admin-nav row directly after Communications. Migration
[db/2026-09-17-meetings-tasks.sql](db/2026-09-17-meetings-tasks.sql), folded verbatim as bootstrap
**§49**. **Applied to production 2026-09-16 (Manila time)** as one transaction, right after a fresh
forced-abort rehearsal. Verified there by the post-apply catalog checks (22 permissions / 35 grants;
three tables with exactly one SELECT policy each; 11 client RPCs and no anon-executable function; no
client write grant; the audience CHECK; no stored audience holding an address; the 111-code catalog),
by the behaviour probe re-run against the applied schema in a rolled-back transaction — identical to
the pre-apply run — and by an advisors comparison whose only security change is the 11 new client RPCs
on the authenticated SECURITY DEFINER list. The native replacement for the legacy
Apps Script "Meetings" module, which created Zoom meetings from an endpoint that checked nothing,
emailed the join link to whatever recipients the browser named (with a CC list), sent a series' end
date as midnight UTC — 08:00 in Manila, so an evening session on the last day was dropped — and kept
its to-do board in ONE browser's localStorage.

- **`meetings.manage`** — the 22nd staff permission, **super_admin only** (35 grants). Inviting
  students ALSO needs `communications.send`, checked in `meeting_send_invites` and again in
  `api/admin/meetings.js`, so a future role could schedule meetings without gaining a mailing list.
- **Three tables** (`meeting_templates`, `meetings`, `staff_tasks`), each with exactly one SELECT
  policy and **no client write path** — the finance rule — plus `comm_campaigns.meeting_id`.
- ★ **ZOOM FIRST, THEN THE LOG.** Zoom and Postgres cannot share a transaction.
  [api/admin/meetings.js](api/admin/meetings.js) holds the Zoom Server-to-Server credentials, creates
  the meeting in Zoom, then records it with the CALLER's JWT through `meeting_record`, which is
  idempotent on the Zoom id. A meeting in Zoom with no log row still appears in the calendar (the
  Zoom list is merged in by `mergeCalendarItems`); a log row for a meeting Zoom never created would
  be a lie. A failed log write returns `MEETING_LOG_FAILED` and says not to create it again.
- ★ **`start_url` IS NEVER READ INTO ANYTHING.** Whoever holds Zoom's start link is the host, so
  `safeMeeting()` keeps `join_url` only, the column takes `https://` only, and both the suite and the
  migration scan assert the string appears in no executable line.
- ★ **CREATING IS NOT IDEMPOTENT AT ZOOM**, which takes no request key: the Schedule button is held
  by a **ref lock** (a state flag re-renders too late), the handler refuses a second concurrent create
  from the same account, and a dropped connection says to check the calendar before trying again.
- ★ **AN INVITATION IS A #61 CAMPAIGN, BUILT IN SQL.** `meeting_send_invites(meeting, audience, key)`
  composes the subject and body from the stored meeting — topic, Manila date and time, repeat pattern,
  duration, join link — so the browser chooses WHO and never what the email says. Braces are stripped
  from the topic and the link, so a topic cannot smuggle in `{{payment_instructions}}`. **The request
  key is required**: a replay returns the campaign the first request made, and a key that belongs to
  another message is refused rather than relinked. Invitations then ride #61's audience resolver,
  daily cap, queue, clearance and idempotency, with replies to support and no CC.
- ★ **CANCELLING A MEETING STOPS ITS INVITATIONS**, in #61's lock order: the meeting row, then every
  campaign row of that meeting (in id order), then their delivery rows. It drops what is still
  waiting and RETURNS `in_flight` for anything already cleared to send, which the screen reports as
  "may still arrive". Anyone already invited is not told automatically, and the dialog says so.
- **Templates** are starting points only (the five legacy ones, remapped to today's plans); editing
  one never changes a meeting already scheduled. **The to-do board** is one shared table, three
  scopes, with finished tasks listed for 30 days.
- Pure mirror: [src/lib/meetingSchedule.js](src/lib/meetingSchedule.js) — the SAME functions the tab
  previews with and the handler validates with, so the sessions a Super Admin sees are the sessions
  Zoom creates. Asia/Manila is a fixed +08:00 (no DST since 1978), and a series ends at 23:59 on its
  last Manila day. Suites: `test/meetingSchedule.test.mjs`, `test/meetingsSql.test.mjs` (both SQL
  files, the handler's gate and bounds, the tab's wiring and RPC names — every guard mutation-tested).
- Owner steps: create a Zoom **Server-to-Server OAuth** app with meeting read and write scopes and set
  `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` in Vercel. Until then the tab says Zoom
  is not connected, and templates and the to-do board still work. **Zoom itself is stub-tested only**
  — nothing in this feature has talked to the real Zoom API yet.

## Management hardening — what the final #58–#62 security review found (#63)

Migration [db/2026-09-18-management-hardening.sql](db/2026-09-18-management-hardening.sql), folded verbatim
as bootstrap **§50**. **Applied to production 2026-09-16 (Manila time)** as one transaction after a
forced-abort rehearsal. It adds no table, no permission and **no RPC** — the advisors comparison shows no
security change at all — and it changes nine function bodies plus one constraint.

★ **EVERY BODY HERE WAS COPIED, NOT RETYPED, AND EACH WAS CHECKED AGAINST PRODUCTION FIRST.** The file is
assembled by a script that lifts the current body out of #58/#59/#60/#62 and applies anchored edits, and the
md5 of every source body was compared with the live `prosrc` before copying. That is the #33/#34 rule made
mechanical: #59 added the feed-link refusals, and a #63 that retyped those bodies from #58's text would have
deleted them silently.

- ★ **AN APPROVAL EXEMPTION BELONGED TO A MEMBER; NOW IT BELONGS TO A PATH.** #60's
  `enrollment_approval_requires_grant` exempted anyone holding a legacy no-expiry term, on every request
  kind and for ever — so an Operations Admin could PATCH such a member's *renewal* straight to `approved`
  through PostgREST, granting nothing while #58's hook still booked the payment. **Verified live** on the
  pre-#63 schema in a rolled-back transaction: it worked. The exemption now also requires
  `request_kind = 'extension'`, which is the only case that needs it (`approve_extension` returns a
  grandfathered term unchanged, so no subscription carries the request's id). A reviewer cannot relabel a
  request to reach it: #48 grants UPDATE on `status` and five other columns, never on `request_kind`.
- ★ **A STAGED BANK FILE IS NOT A STATEMENT.** #59 made "committed" load-bearing for the feed, but
  reconciliation still read every row, so a file still under review counted as real — close was refused over
  rows the feed says do not exist. `finance_reconciliation_detail`, `finance_close_reconciliation` and
  `finance_reconciliations_list` now join the committed imports, and `finance_match_reconciliation_item`
  refuses an uncommitted line outright. Because "committed" became the ONLY way in, three follow-on defects
  had to close with it: commit and discard now **lock the import row** (two tabs both passed the status check,
  and the second zeroed `duplicate_row_count`); commit **refuses to drop unreviewed lines into a CLOSED
  reconciliation**; and the likely-duplicate pass compares only against committed files or the same file, so
  a flag can no longer point at a line that a discard deleted.
- ★ **THE STUDENT TYPES THE AMOUNT, AND IT REACHES THE LEDGER.** `amount_paid` had no ceiling, and
  `parseAmountPaid` keeps digits — so a pasted phone number books as ₱9,171,234,567 (**verified live**: the
  approval succeeded and granted a term), and past 1e12 it overflows `numeric(14,2)` and aborts the approval
  with a bare 22003. Bounded at 1,000,000, the ceiling `admin_correct_enrollment_amount` has enforced since
  #60. ★ The constraint is added **NOT VALID and then validated**, never skipped: #30's idiom dropped the whole
  constraint when a legacy row failed it and said so only in a NOTICE, which the Management API discards — the
  bound would have vanished for every future write while the log claimed it existed. `db:audit` checks
  `convalidated`. The hook names `FINANCE_COLLECTION_AMOUNT_INVALID` instead of overflowing, and the
  comped-approval test and the backfill filter read the amount **rounded to centavos**, which is what the
  ledger lines hold (₱0.004 used to pass `> 0` and then abort on `finance_line_one_side`).
- **Two client fixes ride with it.** `api/notify-enrollment.js` stored the provider's rejection body in
  `notify_detail` — a column on the student's OWN request row, which `enroll_req_own_select` lets them read,
  and which names the from-address and the admin recipient. It stores `resend_<status>` now and logs the
  status only, the rule `api/_lib/email.js` has followed since #49 (since #69 the slug is `sendEmail()`'s own
  code — `resend_422`, `resend_timeout` — the same shape); the full detail still reaches an admin
  through the gated `test` action. And a **refused** Zoom invitation was reported as "the outcome is
  uncertain": `api/admin/meetings.js` now marks uncertain only for callerRpc's 502 (timeout, network fault,
  5xx), the schedule banner takes its colour from `meetingInviteNeedsAttention()` (the Invite panel's own
  `commDoneHeading` classification, so the two surfaces cannot disagree), and an unclear answer in the Invite
  panel **freezes the audience** — the request key is replaced whenever the audience changes, so an edit after
  an unclear answer would have queued a second campaign to the same people.
- **Lockstep:** `MAX_INTAKE_AMOUNT` in [src/lib/enrollmentIntake.js](src/lib/enrollmentIntake.js) ↔ the
  `enrollment_requests_amounts_bounded` CHECK ↔ `finance_enrollment_collection_trg` ↔
  `finance_backfill_enrollment_collections` ↔ `admin_correct_enrollment_amount` (#60) ↔
  `ExtendAccessModal.submit`. `test/managementHardeningSql.test.mjs` builds its patterns FROM the constant, so
  a drift fails rather than passing on a stale literal.
- ★ **`CATALOG_OWNER` in `test/financeSql.test.mjs` had been stale since #60.** The finance-code check read
  #59's catalog, which is a superseded definition — it kept passing only because no migration since added a
  `FINANCE_` code. Repoint it, and `CURRENT_CATALOG_MIGRATION` in `test/communityStaffSql.test.mjs`, whenever
  a migration restates `app_error_catalog()`. Both now name #69 (141 codes), as does
  `CURRENT_SEED_MIGRATION` in `test/staffRolesSql.test.mjs`, because #69 restated the staff seed too.
- Suite: `test/managementHardeningSql.test.mjs` — every assertion runs against the dated file AND the §50
  fold, and all 40 guards are mutation-tested. ★ The mutation runner counts a run that did not finish as an
  ERROR, never as a passing guard: it once read a timeout as "SURVIVED".

## Progress & Rankings — learning analytics and privacy-safe leaderboards (#52)

Tab id `progress`, route `/progress-rankings`, Home stage between Dashboard and Community, plus a
compact preview widget in the Community tab. Migration
[db/2026-09-01-student-progress-rankings.sql](db/2026-09-01-student-progress-rankings.sql), folded
verbatim as bootstrap **§39**.

**Completion-first scoring, and nothing else.** Four tracks — Accounting Foundations 20, QuickBooks
Mastery 40, Profile Optimization 20, Interview Readiness 20 — each scored as completed eligible
milestones over total eligible milestones. Overall is the weighted average of the tracks the
learner's plan can actually open, with the weights **renormalised** so nobody is penalised for
content they cannot reach (a Sampler's overall score is simply their QBO Essentials percentage).
Logins, page views, time online, community posts, reactions, AI chats and booking clicks are
deliberately not inputs. The labels are Overall Progress / Completion Rate / Track Progress /
Cohort Average — **never** an employment "success rate", which is reserved for a future verified
employment-outcome system. Completion is a learning-progress indicator, not proof of mastery.

- **`student_progress_current(p_user)` is the ONE population and the ONE scorer.** Everything else —
  `student_leaderboard()`, `student_rank_in_scope()`, `my_student_progress()`,
  `student_progress_snapshot()` — reads it, so there is a single place where "who counts" is decided.
  It MIRRORS the `courses_read` policy (published + approved + enrolled + the sampler
  `qbo-%`/`essentials` rule); drift there is a scoring bug in one direction and a disclosure bug in
  the other. It is revoked from every client role and reached only through the granted wrappers.
- **★ STAFF ARE NEVER LEARNERS, and the population is the only place that says so.** A paying student
  promoted to staff keeps their `subscriptions` row — no staff migration cancels one — so without an
  explicit `staff_memberships` exclusion they stay scored, dense-ranked and displayed on the
  student-facing board, shifting every real learner down a rank and inflating the report's cohort
  average. `user_is_enrolled()` also returns true for `is_admin` alone. Excluded statuses are
  `invited` + `active` only, matching #50's access-request queue: `suspended`/`revoked` confer no
  authority and may be real students.
- **★ Current values are LIVE; snapshots are history only.** `student_progress_daily` (UTC, unique on
  `(user_id, snapshot_date)`, 400-day retention, written by a cron-only SECDEF function at 00:15 UTC)
  powers trends and weekly movement. No current score or rank ever reads it, so a completion appears
  on the next request rather than the next cron run. The table has RLS on with **no select policy and
  no grant** — it is reachable only through SECURITY DEFINER functions.
- **★ "No baseline" is NULL, never 0.00.** A learner with no snapshot from 7–14 days ago has not been
  measured over a week; the `week` window EXCLUDES them and the UI renders "—"/New. Coalescing a
  missing baseline to the current score yields exactly zero, which for the first seven days after the
  migration would turn Most Improved into a mislabelled copy of the overall board with every row
  claiming no improvement. The lookback is bounded at BOTH ends, so a stale snapshot left by a cron
  outage cannot be presented and ranked as a 7-day gain.
- **Privacy.** Public rows carry rank, a first-name + last-initial label ("Emmanuel A."), initials,
  scores, milestone counts and `is_current_user` — never a uuid, email, full name, avatar, plan or
  payment field. Hidden learners (`student_ranking_preferences.public_visible`, default true) are
  filtered **before** `dense_rank()`, so the surviving ranks carry no gaps disclosing how many hidden
  learners outrank you; they keep their private dashboard and still appear in the staff report, which
  is an operational record, not a board. ★ The anonymous "Learner NNNN" number is built in SQL with
  `hashtextextended()`, which the dependency-free JS mirror cannot reproduce — so **the server owns
  that label** and every rendered row uses `learner_label`. `test/studentProgress.test.mjs` scans that
  no client code relabels a row.
- **Scopes** `my_plan | general | vip | my_batch | all` × windows `overall | week`, dense-ranked (ties
  share a rank), bounded pagination, with a non-public deterministic key breaking ties only for stable
  paging. `my_batch` derives the cohort from `user_entitled_batches()` (the #35 ledger), never from
  `subscriptions.batch_id` and never from the argument; a foreign `p_batch_id` is refused with the
  same message as "you are not VIP", so it is not a membership oracle.
- **Lesson completion is no longer client-writable.** `insert/update/delete` on `lesson_progress`,
  `course_completions` and `feature_video_completions` is revoked from `authenticated`;
  `complete_course_lesson(uuid)` derives `course_id` from the lesson and re-checks publication,
  approval, enrolment and plan scope. ★ **Ship the client and the SQL together** — a pre-#52 course
  player upserts those tables directly and would silently stop recording completions.
  `set_foundation_milestone()` keeps the row and flips a `completed` flag rather than deleting, so
  `completed_at` records the FIRST completion and cannot be re-minted to forge recency and game the
  Most Improved window or the report's inactivity signal.
- **Staff report** `admin_student_progress_report()` is gated on the new `student_progress.read`
  permission (Super Admin + Operations Admin; **not** Trainer, who sees only the same public boards a
  learner does). "Needs attention" = an active incomplete student with no trusted milestone for 14+
  days, excluding anyone enrolled fewer than 7 days.
- **Accounting 101 milestones are durable and STABLE-keyed.** The eight modules seed
  `student_progress_milestones` as `accounting-101-module-01…08`. Before #52 completion lived in React
  state keyed by array index, so it reset on every refresh and reordering a module would have moved a
  student's progress. There is deliberately **no backfill** — that state was never stored.
**Follow-up #53 ([db/2026-09-02-progress-rankings-followup.sql](db/2026-09-02-progress-rankings-followup.sql),
folded as §40).** A full code review of #52 found four defects that #52 could no longer fix itself,
being already applied and logged. All four are `create or replace` on existing functions.
★ **A leaderboard scope you do not belong to is a plan oracle.** `student_leaderboard` guarded
`my_batch` from the start but accepted `vip` and `general` from anyone, so a Sampler could request the
VIP board, receive the roster by label, then request `general` for the complement. The rows carry no
plan column — but **set membership IS the plan**. A learner now sees their own segment only; staff
still see both; the refusal reuses `my_batch`'s wording so probing cannot separate "not allowed" from
"does not exist". `progressScopeOptions()` mirrors it so the UI never renders a tab that can only
error. ★ **`complete_progress_feature_guide` re-stamped `completed_at` on every call**, letting a
learner clear their own "needs attention" flag and advance `last_milestone_at` without learning
anything — the same recency forgery #52 fixed for foundation milestones and missed on this path. It
now re-stamps only for a genuinely new `video_version`, which is what makes the `completed_at` claim
above true of BOTH paths rather than one. ★ **The staff report excluded staff from its live arm but
not its historical one**, so a promoted student reappeared as an "inactive" learner, with name and
email, for the 400-day life of their snapshots. ★ **The recent-milestone feed** could name a lesson
from an unpublished or out-of-plan course; it now mirrors the scorer.

**Follow-up #54 ([db/2026-09-03-progress-course-family-scoping.sql](db/2026-09-03-progress-course-family-scoping.sql),
folded as §41) — a programme RE-RUN must not inflate the denominator.** A monthly cohort re-run is
created by the course duplication feature: a new `courses` row with the same lessons and
`source_course_id` pointing at the run it was copied from. Both are published, and #52 counted every
published course in a track — so the live QuickBooks denominator was **84 lessons across two copies of
one 42-lesson programme**. Finishing the entire programme scored 50% on the 40%-weighted track, and
every future re-run would have divided every score again. The scorer now walks the duplication lineage
(recursive, depth-bounded — `source_course_id` is not constrained acyclic) and counts **one run per
learner per family**: the run they have progress in, else the newest. ★ **This is not a batch problem
and a `courses.batch_id` FK could not have fixed it** — Sampler and Silver hold no cohort seat at all,
yet their denominators doubled too; the grouping that matches the cause is the duplication lineage, not
the cohort. ★ The "newest" tie-break reads **`created_at`, never `course_date`** — picking the newest
run is exactly the temptation that would break the standing rule that `course_date` is a display label
no function reads, and `test/studentProgressSql.test.mjs` asserts the scorer never names it.

- Pure mirror: [src/lib/studentProgress.js](src/lib/studentProgress.js) (tracks, weights, scopes,
  label formatting, scope selection). Suites: `test/studentProgress.test.mjs`,
  `test/studentProgressSql.test.mjs` (asserts against the dated file **and** the bootstrap fold),
  `test-db/studentProgress.dbtest.mjs`.

## Getting Started onboarding video (#69)

A newly approved student watches ONE Super-Admin-managed welcome video once, before their first
dashboard, and can replay it later. Tab ids **`gettingstarted`** (the student replay page, route
`/getting-started`, alias `/welcome`, FIRST in Home) and **`gettingstartedadmin`** (the Super Admin
screen, route `/admin/getting-started-video`, the FIRST admin-nav row). Migration
[db/2026-09-30-getting-started-video.sql](db/2026-09-30-getting-started-video.sql), folded verbatim as
bootstrap **§56**; pure client half [src/lib/gettingStarted.js](src/lib/gettingStarted.js).
**Database status (2026-10-02):** the CURRENT file — dated md5 `3b62d98d7897676c29adaaa1aad6d387`, with
`p_expected_live_id` and the attach no-op — was applied to the SHADOW project twice (idempotent). Shadow
holds exactly one publish signature, `(uuid,boolean,uuid)`, and all 20 function bodies equal the file. The
13 `#69` audit entries pass there, including the whole-deparse policy literals and the two `prosrc` checks
that had been verified only offline before; both `prosrc` checks were also shown to FAIL on live mutants.
**Applied to production 2026-10-02 (13:11 UTC)** as one transaction (`set local lock_timeout = '5s'`, 4.8 s),
right after a forced-rollback rehearsal on the live catalog. The restated catalog and staff seed were
re-checked against production first (catalog md5 `bf3a27bd…`, 22 permissions / 34 grants). Verified
there by the file's AFTER RUNNING checks; by impersonated probes in a rolled-back block (a Super Admin
gets the manager view, a student nothing required and the overview refused, anon 42501); and by an
advisors comparison. Its only changes are the 15 functions `authenticated` must reach (the 12 client
RPCs and the 3 storage-policy helpers, each checking its own permission) and seven INFO notes on the
new, still-empty tables.

- ★ **WHO MUST WATCH IS DECIDED IN ONE PLACE: `user_onboarding_video_state(p_user)`.** A student is
  asked when ALL of these hold: a version is published; its object really exists in `storage.objects`;
  they are approved AND enrolled (`user_is_approved()` + `user_is_enrolled()` — the 3-day grace
  counts); they are not staff (an `invited`/`active` `staff_memberships` row, or `profiles.is_admin` —
  staff are never learners, #52); they have finished NO version; and their FIRST `subscriptions` row
  (`min(created_at)`, whatever its status) was created on or after the FIRST publish of ANY version
  (`min(onboarding_videos.published_at)`). `required` is `coalesce(…, false)` — always a boolean, never
  null — and the client trusts only the literal `true`. Three edges are deliberate, and all three are
  pinned by `test-db/onboardingVideo.dbtest.mjs`, whose `migrated` persona is a real import grant
  (`grant_source 'import'`, `account_origin 'import'`) activated before the first publish. The rendered
  suite does NOT pin edge (a) (TDR-6): its test 10 seeds a plain, payment-sourced member whose first term
  predates the first publish — the same cutoff, but not a migrated student — and its test 6 walks a
  migrated student whose import term is NEWER than the publish, who is asked:
  (a) a migrated student activated BEFORE the first publish is an existing member and is not asked;
  (b) a grandfathered member (paid before dated terms, so no subscription row) is not asked — until an
  upgrade creates their first row after the first publish; then once;
  (c) the cutoff is the first publish of any version, even one later retired or deleted
  (`published_at` is set once; the guard refuses a rewrite) — so a Super Admin checks a draft with
  **Preview**, never with a trial publish, and the first-publish confirmation names the day.
  The function answers about ANY user, so it is INTERNAL: revoked from every client role — right after
  its CREATE as well as in section 10, because the file is transaction-free and
  `scripts/apply-db-files.mjs` sends one statement per call. `my_onboarding_video()` asks it about the
  caller and `enrollment_decision_email_facts()` about a request's student; the overview's set-based
  counts restate the same rule.
- ★ **THE GATE GRANTS NOTHING, SO THE CLIENT FAILS OPEN; EVERY FUNCTION FAILS CLOSED.** The arm is the
  LAST in `resolveGateScreen()` — below even the legacy approval gate, because that rule orders the
  holds that decide access and this one decides none. `loading` holds the splash (an approval that
  lands on the pending screen must not flash the dashboard the video comes before); `ready` + `required
  === true` shows `GATE_SCREENS.GETTING_STARTED`; every other answer — an RPC error, a pre-#69
  database, the 7 s `ONBOARDING_STATE_TIMEOUT_MS`, a malformed answer — renders the app. Failing open
  costs one orientation video, never access: membership RLS still guards every paid read. Never a price
  on this screen. The arm's scope and precedence are in "Changing WHO the auth gate holds".
  ★ **A first answer that FAILED or TIMED OUT on a HOLD screen is asked again when the approval lands
  (GF-1)**, exactly as a cached `eligible:false` is. A hold is the pending screen, a lapsed term, a
  scheduled start or the paywall (`failedBeforePass` true): nothing waited on the answer there, and
  failing open on it hours later sent a newly approved student past the video for the whole session. A
  pre-#69 database (`missing`) is never re-asked. ★ **A failure is decided by the enrollment PHASE it
  lands in** (`gettingStartedFailedBeforePass()`). On a hold it is re-asked at the pass. On the pass it
  IS the gate's answer, and fails open at once. While the profile or the enrollment reads are still out
  (`'unknown'`) it is undecided (`null`) until they land, and is then decided by that first settled
  phase. So the client gate fails open on a 7 s timeout counted from the uid's arrival, never 7 s twice
  (V-GF1-DOUBLE-BOUND: handed a boolean pass, the sign-in splash waited 14.4 s, measured in Chrome, when
  the reads were slower than the failure).
- ★ **VOCABULARY, AND WHY THE IDS ARE SPELLED THIS WAY.** The database and the API say "onboarding
  video" (`onboarding_videos`, `onboarding.manage`, `ONBOARDING_VIDEO_*`); the UI says **Getting
  Started** to a student and **Getting Started Video** to a Super Admin. Neither tab id may be
  `onboarding` — that is the Client Onboarding tool (`/client-onboarding`) — and there is no bare
  `onboarding` voice alias, because `resolveVoiceTool()` tries an exact tab id before any alias. For
  the same reason the admin id is not the spoken phrase: the resolver collapses "getting started video"
  to `gettingstartedvideo` and tests `VALID_APP_TABS` FIRST, so an admin tab spelled that way would
  answer a student asking for the welcome video with the Super Admin screen. Hence
  `gettingstartedadmin`, and the alias `'getting started video'` → `gettingstarted`. Both ids are in
  `NON_TOOL_TAB_IDS` (a welcome video, not a tool) and in `VOICE_TAB_INFO`, the admin one `adminOnly`
  and navigation-only.
- **STORAGE: a private `onboarding-videos` bucket at the lesson-video limits** (`2147483648` bytes =
  `LESSON_VIDEO_MAX_BYTES`; `video/mp4` + `video/quicktime` = `LESSON_VIDEO_UPLOAD_MIMES` — pinned to
  the JS constants by `test/gettingStartedSql.test.mjs` and by the `#69` audit block, which imports
  them). An object is named `versions/<video uuid>/<upload uuid>.mp4` and nothing else — **opaque by
  design**: a Supabase signed URL necessarily contains the object name, so the name carries no filename
  (`original_filename` is an admin-only column). `ONBOARDING_VIDEO_PATH_RE` is the `storage_path`
  CHECK's own pattern, lowercase and flag-free (the SQL `~` is case-sensitive; `LESSON_VIDEO_PATH_RE` is
  `/i` — never copy that flag here), and `onboarding_videos_path_in_own_folder` makes a file outside its
  version's folder unrepresentable.
  ★ **READS BY REFERENCE, WRITES BY PATH — #65's inversion, on purpose.** A student reads exactly one
  object, the one the PUBLISHED row cites, while approved and enrolled
  (`onboarding_video_object_readable()`); a Super Admin reads the whole bucket (Preview plays drafts). A
  write names an object that does not exist yet, so INSERT and UPDATE are authorized by the path:
  `onboarding.manage` AND a DRAFT whose id the path parses to (`onboarding_video_upload_allowed()`;
  `onboarding_video_path_version_id()` returns NULL for any other shape, and NULL authorizes nothing).
  DELETE refuses the live object (`onboarding_video_object_is_live()`). So the live file can be neither
  overwritten — only a draft's folder takes writes — nor deleted, not even by a Super Admin.
  ★ **"NO RAW PATHS" IS FOUR THINGS TOGETHER, NOT A HIDDEN NAME:** the private bucket; the
  reference-based read of the ONE live object; a name that, of #69's functions, only
  `start_onboarding_video()` discloses to a STUDENT, and only to an eligible one (`my_onboarding_video()`
  never returns one — a Super Admin, by contrast, sees every version's path, in the overview and through
  the table's own SELECT policy); and a 1 h signed URL (`LESSON_VIDEO_SIGN_TTL_SECONDS`) that
  `SignedLessonVideo` refreshes before it expires. Every URL the browser mints for an uploaded lesson
  video or the Getting Started video comes from ONE function, `signPrivateVideo(bucket, path)` — the
  app's other video URLs come from elsewhere: a feature-guide upload is a public `course-media` URL, a
  community video attachment is batch-signed by `CommunityHub`, and the AI trainer's transcription
  signs a lesson video on the server. No #69 server code signs an onboarding object. `signLessonVideo`
  and `signOnboardingVideo` are hoisted `function` declarations that only choose the bucket, and no
  `getPublicUrl` ever names this bucket. `uiSafety` §28a pins exactly that — one definition, the two
  delegations, `SignedLessonVideo` minting only through its `signUrl`, no public URL for this bucket —
  and does not scan the rest of the app for other signing calls. A failed signature here is logged as
  `[onboarding-videos]` and told to a Super Admin as "This Getting Started video’s file could not be
  authorized for playback…" (`PRIVATE_VIDEO_SIGNERS`, keyed on the signer; TDR-8 — see the Course
  platform section).
- **TABLES.** `onboarding_videos` holds every VERSION (`draft → published | deleted`, `published →
  retired`, `retired → published | deleted`; at most ONE published, by the partial unique index
  `onboarding_videos_one_live`); `student_onboarding_progress` holds one row per student per version
  (`first_started_at` kept for good, `completed_at` the FIRST completion, the last playback problem);
  `onboarding_video_events` is the append-only trail. Each has RLS, exactly ONE SELECT policy
  (`onboarding.manage`, plus a student's own progress rows) and NO client write path — the finance rule;
  **never `force row level security`**, the guards and the RPCs run as the owner.
  ★ `onboarding_videos_guard()` holds the state machine for EVERY writer, the table owner included: the
  media columns change only while a row is and stays a draft; `published_at` is set once; each actor
  column moves only on its own transition — but may ALWAYS become NULL (the FK's `ON DELETE SET NULL`;
  refusing it would make an Auth user who ever published undeletable); a deleted row stays deleted; and a
  row DELETE is refused: history is permanent, and TRUNCATE (test-only) is the only reset.
- **THE RPCS, IN THREE ACL CLASSES** — listed separately in section 10, because they fail in opposite
  directions and a new function starts with Supabase's default EXECUTE for anon and authenticated:
  - **Client RPCs (12) → `authenticated` only.** Student: `my_onboarding_video()` (`configured,
    eligible, required, completed, completed_at, completed_current, media_available, can_manage,
    video` — metadata only, to an eligible viewer or a manager; never a path, never a draft),
    `start_onboarding_video()` (the only #69 function that discloses the live object's name to a
    STUDENT — a Super Admin also sees every version's path in the overview; records the first open, for
    eligible non-staff only), `complete_onboarding_video()`, and
    `report_onboarding_video_problem(p_code)` (UPDATE-only on the caller's live-version row — never an
    insert — at most once a minute, coerced to `ONBOARDING_PROBLEM_CODES`, silent for staff and the
    ineligible). ★ **No student RPC takes a user, path or video id**: the subject is `auth.uid()`, the
    video is the live one, and `p_code` is the only student parameter. Super Admin: the seven
    `admin_onboarding_video_*` (overview, create_draft, update_details, attach_media, publish — with
    the optional `p_expected_live_id` a Replace binds itself to — unpublish, delete), each opening with
    the `onboarding.manage` check and writing ONE event per state change — none for a no-op (#56's rule).
    ★ **`attach_media` follows the rule too (DBSEC-4):** re-attaching the file a draft already cites,
    with the same facts, answers `changed: false` with `previous_storage_path` null and writes no event.
    The facts are compared as the write would STORE them — path, original file name, type, size, length
    — and the answer comes only after every check, so a file that has since vanished from storage is
    still `ONBOARDING_VIDEO_MEDIA_INVALID`. A real attach answers `changed: true`. Pinned on shadow by
    `test-db/onboardingVideo.dbtest.mjs`. Plus `enrollment_decision_email_facts()` on `enrollments.review`.
  - **Storage-policy helpers (3) → `authenticated`**: `onboarding_video_object_readable`,
    `onboarding_video_upload_allowed`, `onboarding_video_object_is_live`. ★ A policy qual runs AS THE
    CALLER, so without the grant EVERY `storage.objects` statement, in every bucket, fails with
    "permission denied for function". The two write-side helpers check `onboarding.manage` themselves,
    so the grant is no oracle.
  - **Internal (4) → revoked from every client role**: the path parser, `user_onboarding_video_state()`
    and both guard trigger functions.
- ★ **WHAT COUNTS AS FINISHED — two rules, and only the second is security.** *Presentation:* "Go to
  dashboard" unlocks when ≥ 90% of the timeline has ACTUALLY played (`ONBOARDING_WATCH_MIN_FRACTION`)
  and `ended` fires — or, for a browser that never fires it, a stop within 1.5 s of the end while not
  seeking (`ONBOARDING_NEAR_END_SECONDS`). `watchVerdict()` checks the played share FIRST, so dragging
  the scrubber to the end stays locked, and an unknown duration (NaN, Infinity) finishes only on
  `ended`. "Played" is the union of every `<video>` element's `played` ranges (`mergeRanges()`), because
  a re-sign or "Try again" mounts a NEW element and the old one's ranges go with it; the union is
  bounded at 64 ranges by dropping the SHORTEST, never the latest long stretch. *Security:*
  `complete_onboarding_video()` refuses with `ONBOARDING_VIDEO_NOT_FINISHED` until
  `greatest(coalesce(duration_seconds, 60) × 0.4, 5)` seconds after `first_started_at` — a 2× viewer of
  any video of 10 s or more is never refused, and an unverified (NULL) length still waits 24 s. A
  student can call the RPC without loading the client at all; this guard is what refuses a forged
  completion, and `test/gettingStartedSql.test.mjs` builds its pattern FROM the three JS constants.
  ★ **A completion is earned once and never re-stamped:** `completed_at = coalesce(completed_at, now())`
  (#52's recency-forgery rule; the suite fails on a bare `completed_at = now()`). The live row is locked
  `FOR SHARE` — and read a second time before the function answers "nothing is live", because a publish
  racing it retires the old row first — and the progress row `FOR UPDATE`, so a completion belongs to
  the version the student actually watched. A replacement published mid-watch answers `NOT_FINISHED`
  with `current_video_id` = the new version, and the screen starts that one over.
- ★ **REPLAYS RECORD ONCE PER VERSION; STAFF RECORD NOTHING.** The page and the card share
  `useReplayRecorder`: an eligible viewer who has not finished the CURRENT version records it once,
  triggered from the verdict EVENT (so playback that goes on cannot cancel it), asks once more when the
  server's floor has passed, and re-arms after a transient failure. `start` records progress only for
  eligible non-staff; `complete` answers staff `{ ok: true, recorded: false }`, and a replay marks the
  root's answer completed only when `recorded !== false`.
- **CLIENT ARCHITECTURE** (the Getting Started block of BookkeeperPro.jsx; pinned by `uiSafety` §28b):
  - `useGettingStarted(uid, enrollPhase)` runs in the root ABOVE every early return and asks
    `my_onboarding_video()` the moment a uid exists — in parallel with the profile and enrollment
    reads, never after them — once per account (StrictMode included), each request bounded by
    `ONBOARDING_STATE_TIMEOUT_MS`. Its value is `{ status, data, missing, uid, markCompleted, refresh }`:
    `missing` says the database has no #69 (GF-8), and `uid` names the account the answer is for.
    ★ **Its status is DERIVED DURING RENDER** by `gettingStartedStatus()`
    from one `fetched` state, never set by an effect: an effect-set status leaves one frame in which the
    gate has no answer and renders the dashboard, and an answer fetched for another uid is `loading`,
    never rendered. ★ **The approval edge:** a student approved on the pending screen holds an
    `eligible:false` answer when the pass arrives, so the status is `loading` until ONE re-ask lands. The
    re-ask is decided by `gettingStartedNeedsReask()`, the twin of `gettingStartedStatus()`'s hold. It
    fires for a cached `eligible:false` requested before the pass, or for a failure that landed on a hold
    (or landed while the profile or the reads were still out, which then landed on a hold). A failure that
    landed on the pass, or while they were out and they then landed on the pass, is never re-asked; nor is
    an answer requested after the pass, or a missing function. `test/gettingStarted.test.mjs` checks the two agree on every settled
    answer. It fires on that
    STATE, never on an edge, because the two first reads race and an edge can fire before the answer
    exists. A cached `eligible:true` costs no extra round trip. Late answers (past their timeout, behind a
    newer request, for another account) are discarded. ★ **`markCompleted(result, uid)`** takes the uid
    the caller captured BEFORE awaiting (`gs.uid`), applies only while that account is signed in and its
    answer is there, and returns whether it did; otherwise it changes nothing and makes nothing stale
    (GF-7: `signOut()` does not reload, so a completion can outlive a sign-out). The root's `onDone`
    dismisses the welcome and opens the Dashboard only when it applied.
    `refresh()` asks again, and its failure fails open like any answer, while `refresh({ keep: true })`
    — the cosmetic re-read after a video was replaced — leaves the current answer standing if it fails
    or times out, because it must never be what opens the gate. A keep answer that LANDS supersedes
    every question asked before it (RV8-K1). The Super Admin screen asks one after every change to
    what is LIVE — a publish, a replace, an unpublish, deleting the live version, a save of the live
    version's words (AUI-5) — so their own Dashboard card and Getting Started tab follow without a
    reload (T9V-M1); a draft's edit asks nothing.
    ★ **It is handed the enrollment PHASE:** `gsEnrollPhase = gettingStartedEnrollPhase({ profileReady,
    ready: enroll.ready, pass: enrollPass })`, never `enrollPass` itself. That is `'pass'` only for a
    SETTLED pass — this account's profile AND both enrollment reads have landed and say pass (exactly
    `gettingStartedEnrollPass()`, T12-D1, K3R-GATE-DIRECT-SWITCH); `'hold'` once the profile AND both
    enrollment reads have landed and do not pass; else `'unknown'` (V-GF1-DOUBLE-BOUND). Both need
    `profileReady` because `useEnrollmentGate` reports `ready: true` while it is inactive, i.e. before the
    profile loads — and on a direct account switch the profile in hand until the new one lands is the
    PREVIOUS account's: a pass read off it stamped the new account's first question `reaskedAfterPass`,
    and an enrollment approved later in that session skipped the video. (The hook reporting only the
    signed-in account's reads closed the other door; Chrome showed each fix alone leaves one of the two
    switch cases open.) While the two enrollment reads are in flight, `enrollGateState()` answers from the
    profile alone — `pass` for any paid profile with no term loaded yet (the grandfather rule) — and a
    LAPSED member spent the hook's one re-ask on it, so a renewal approved later in the same session
    found nothing left to ask with and skipped the video. Only the hook's input is settled: `enrollPass`
    and the entitlement memo that reads it are unchanged, and the gate holds its splash until
    `enroll.ready` anyway. The root's latch (see "Changing WHO the auth gate holds") reads the same phase.
    Pinned by `test/gettingStarted.test.mjs` and by the `uiSafety` T12-D1 test, which RUNS the root's own
    phase expression on the real hook.
  - `GettingStartedContext` carries that memoized value to the page and the card. The provider wraps
    only the app shell, so the gate screen is handed it as a prop; its default fails safe
    (`unavailable` — render the app, show nothing).
  - `GettingStartedPlayer` (modes `gate | page | card | preview`) is `SignedLessonVideo` with
    `signUrl={signOnboardingVideo}` and `isAdmin={false}`, plus the watch rule. `source="live"` calls
    `start_onboarding_video()` once per mount — its only call site; a given `{ video_id, storage_path,
    duration_seconds }` (the Super Admin's Preview) makes no RPC, records nothing and reports nothing. A
    player problem is reported as `onboardingProblemCode(reason)`, never the raw reason. ★ **Retry is a
    REMOUNT** (the caller bumps a key), so `start` runs again and returns the CURRENT live object — the
    one answer a re-sign of the old name can never give. ★ **The watch record outlives the `<video>` AND
    the player:** it lives in the caller's `watchRef` (`watchRecordFor()` keeps it for the same video and
    starts afresh for another), and a new element is put back where the student was (`resumeAt()` —
    never inside the last 1.5 s). A start-over (a newer version, or a start the server never saw) clears
    it. ★ **Nothing between the student and the video waits for ever (GF-3):** one bound,
    `ONBOARDING_LOAD_TIMEOUT_MS` (15 s), from mount to the first frame covers `start_onboarding_video()`
    and the first signature (neither postgrest-js nor storage-js times out a POST or a sign). A stalled
    one gives up as `'slow'` into the give-up panel; an answer that lands later still shows the video and
    clears the panel; a slow load is never reported to the Super Admin.
  - `holdWatchVerdict()` — once unlocked, the SAME video stays unlocked, so a rewind or the native
    replay control cannot re-lock Go under a full progress bar — is applied at the gate and in Preview
    only; the replay recorder sees the raw verdicts.
  - `usePauseWhenHidden(frameRef, mediaRef)` pauses a replay whose keep-alive tab is HIDDEN. It observes
    the always-mounted `.gs-stage` frame, never the `<video>` (replaced on every re-sign), with an
    IntersectionObserver AND a ResizeObserver (a frame already scrolled out of view gets no intersection
    entry when its panel hides), and pauses only when `offsetParent === null` — scrolling down to read
    the transcript keeps it playing.
  - Go is `aria-disabled`, never `disabled`, and its unlock is announced once, politely; every Retry
    that removes itself hands focus back (`refocusIfLost` → the player frame, `tabIndex=-1 role=group`,
    or Go) — never to `<body>` — and so does the shared player's OWN "Try again", to its
    `.course-stage` frame (see the Course platform section). ★ **The first keyboard stop on the gate,
    the page, the card and a lesson is the `<video>` itself (S1).** Its own outline would be clipped by
    the frames, so `.course-stage > video:focus-visible { outline: none; }` and a separate rule,
    `.course-stage:has(> video:focus-visible)::after`, paints the frame's inset ring for it (D2's, see the
    Course platform section) — a rule of its own because a browser without `:has()` drops a whole
    selector list, and the frame's own ring would go with it. ★ **A status shown after a press is SAID
    through a region that was already mounted (S5)**:
    the gate's messages and give-up panel through the Body's polite region (its `announcement` prop); the
    page and the card each through one `sr-only` polite region mounted with the surface. An error keeps
    `role="alert"`. A `role="status"` mounted together with its text is often never read by NVDA or
    JAWS. Nothing autoplays: `SignedLessonVideo`
    renders `preload="metadata"`, `playsInline` and `controlsList="nodownload"`, and `uiSafety` §28b
    refuses these spellings of starting playback in these components, each named on its own:
    `autoplay` in any case (the prop, the property, `setAttribute`), `muted`/`defaultMuted`, any
    `.play` member access, a `'play'` looked up by name (`video['play']()`) and a destructured `play`
    (`const { play } = video`). ★ It is a source scan, not a proof: a name built at run time
    (`video['pl' + 'ay']()`, `String.fromCharCode(…)`) still passes it, so it lists spellings and
    never claims to know every one.
  - **The gate** (`GettingStartedScreen`) records through `recordOnboardingCompletion()` — the ONE call
    site of `complete_onboarding_video` — and answers every refusal without navigating: a newer version,
    or a start the server never saw → start over; too soon → "Almost there — try again in a few
    seconds." (no number: a static message cannot count down); ineligible or unavailable → ask the root
    again (the gate may no longer apply); anything else → an inline error and Retry. A completion that
    never answers ends at `ONBOARDING_COMPLETE_TIMEOUT_MS` (15 s) as `{ ok: false, code: 'timeout' }` →
    the inline error and Retry (S4); retrying is safe, because the server keeps the first `completed_at`.
    Done → `markCompleted(r, uid)` and, only if it applied, `dismissWelcome()` (the first-login
    `WelcomeOverlay` never stacks on the dashboard this opens) and the Dashboard. Once the video will not
    play it offers Retry, support and **"Continue to dashboard for now"**: a deferral held in root state
    for THIS uid only, recording nothing and calling no server, so a reload, a new tab, an account switch
    or a sign-out asks again — and it lands on the Dashboard too (GF-6). The give-up panel names its
    reason through `gettingStartedGiveUpCopy()` ("on this device" only for a decode failure) and is
    scrolled to the nearest edge when it appears, focus unmoved (S3). Ended under 90%, the line says to
    play it again (`watchVerdict()`'s `'skipped'`, S2), and the intro says "When you’ve watched it to the
    end". ★ **The gate asks again when the student comes back to the tab (GF-4):** `useRecheckOnReturn`
    calls `refresh({ keep: true })` on a focus or a `visibilitychange` — at most every 10 s, never in the
    first 10 s — so a video finished in another tab lets it go, and a failed check never does. If it lets
    go because the answer reports a completion (`gs.data.completed`) for the account the gate showed the
    video to in this session (the root's `gsGateUid`, cleared at sign-out), the first-login
    `WelcomeOverlay` is held by derivation — `gsWelcomeHeld`, so it is never mounted even for a frame,
    since it moves focus on mount — and remembered as dismissed (`dismissWelcome()`), as a finish in this
    tab does through `onDone` (V-GF4-WELCOME). Any version's completion counts — `completed`, never
    `completed_current`: one finished elsewhere before a newer version was published is still a finished
    video (K3R-X04-TESTGAP pins it). A gate that lets go WITHOUT a completion (an unpublished
    video) leaves the first-login welcome as it was. The gate frame's width also answers to the window's
    HEIGHT (`.gs-stage[data-gs-mode="gate"]`), and the unlock scrolls Go into view without moving focus.
    An imported student's one-time summary says "Continue" when Getting Started is next.
    ★ **When the gate hands over to the app, focus goes to `<main>` (K3R-FOCUS-HANDOVER).** Go to
    dashboard, "Continue to dashboard for now" and a re-check that lets go each unmount the control that
    had focus, and the browser dropped it to `<body>`: the next Tab started again at the top of the
    sidebar, and a screen reader heard nothing about the new screen (WCAG 2.4.3). A root effect on
    `gate.screen` (above the first early return; a splash between the two is skipped, deciding nothing)
    calls `refocusIfLost(transientFocusTarget(mainRef), { preventScroll: true })` on GETTING_STARTED →
    APP only. ★ **`<main>` is NOT focusable at rest (K3RV-MAIN-CLICK-FOCUS).** `transientFocusTarget()`
    gives it `tabindex="-1"` for that one focus and takes it away on the first blur or the first pointer
    press anywhere (before the press moves focus), and at once if the focus did not land. A static
    `tabIndex={-1}` made it CLICK-focusable for its whole life: a mouse click on plain text focused
    `<main>`, and the next Tab went to the first control at the top of the page and scrolled there —
    measured with real events, the Dashboard scrolled to 700 jumped to 0 and Invoice Creator to 1; now
    focus stays where the browser puts it and Tab reaches the control beside the click, scroll unmoved.
    Blur alone was not enough, measured too: a click on plain text right after the hand-over kept the
    still-focusable `<main>` focused and jumped the same way. `focus:outline-none` is for the container
    alone; every control inside keeps its own `:focus-visible` ring. `refocusIfLost` acts only when focus
    really was lost, so an ordinary load leaves focus where the browser put it, and the first-login
    `WelcomeOverlay` (which takes focus when it mounts) keeps it. Measured in Chrome with real key
    presses: before, focus on `BODY` and the next Tab on "Collapse sidebar"; after, `MAIN` (no visible
    outline in either theme, nothing scrolled) and the next Tab on the card's "Open video" — after which
    `<main>` carries no `tabindex` again.
  - **The replay page** (`GettingStartedPage`, the `gettingstarted` tab) is never a gate: Go to
    dashboard is always there, beside a status line and plain states for not-eligible, no video and a
    missing file. **The Dashboard card** (`GettingStartedCard`, under the hero) signs nothing until
    "Open video" expands it (a paused player), links the page only where
    `entitlement.allowsTab('gettingstarted')`, and renders nothing when nothing could play — except to a
    manager, who is told why. ★ **Where a viewer stands is ONE derivation, `gettingStartedStanding()`**
    (completed · earlier · owed · optional; S6). The card's chip is "Completed", "Finished an earlier
    version" or "Not finished", and there is none for a never-asked member or for staff; the page's line
    matches ("Completed on …", "You finished an earlier version on …", "Not finished yet", "Optional —
    watch it whenever you like"; staff read "Staff views aren’t recorded."). A start the server refuses
    (`ONBOARDING_VIDEO_UNAVAILABLE` / `_NOT_ELIGIBLE`) asks the root again, and the panel says what
    happened (GF-5). On a pre-#69 database the page says "Getting Started isn’t set up yet…", with no
    Try again (GF-8). The page frame has its own height budget, `.gs-stage[data-gs-mode="page"]`: the
    window less the 151px sticky `SectionHead` and 24px to spare, at least 160px, binding only below a
    625px-tall window (S7). The small text S8 measured below AA — the help line, the journey heading, the
    sign-out row — reads in `C.textSoft`, and the support address in the deep-blue `NAVY` token (the mute
    grey measured 2.97:1 and the accent blue 3.6:1 as text). The card lays out
    by its own `.gs-card` container; the page has no container query of its own (its rows simply
    wrap); the journey strip in `GettingStartedBody` — the gate's and Preview's — lays out by
    `.gs-journey`, and the Super Admin screen by `.gs-admin`. What stacks and what sits side by side
    follows those containers, never a viewport breakpoint — `sm:` here only adds padding or widens the
    draft drawer, and the player frame's `vh` caps (the gate's and the page's height budgets among them)
    size the video without switching any layout.
- **PLANS AND STAFF.** `gettingstarted` is in the Essentials allowlist; Silver and VIP reach it through
  full access; the unknown-plan / `NO_ACCESS_ENTITLEMENT` stays Dashboard-only, and `staffEntitlement()`
  adds neither tab for an Operations Admin or a Trainer. `ADMIN_TAB_PERMISSION` maps only
  `gettingstartedadmin` → `onboarding.manage`: mapping the student tab would refuse it to the students
  it is for (the Community reasoning, #56). **`onboarding.manage`** is the 23rd staff permission, Super
  Admin only (35 grants): publishing or replacing the video changes the first screen every newly
  approved student sees, and the live file is served to every paying member.
- **THE SUPER ADMIN SCREEN** (`GettingStartedVideoAdmin`; pinned by `uiSafety` §28c):
  - ★ **It calls `admin_onboarding_video_*` and nothing else**, and reaches Storage only through its
    upload target. Preview renders the student's own `GettingStartedBody` + `GettingStartedPlayer` on a
    GIVEN version in an `AccountModal` — inert, on a watch record of its own — and the draft drawer's own
    player is UNMOUNTED while it is open (a hidden `<video>` still holds a second signed URL, and
    `display:none` does not pause it).
  - ★ **A draft comes first.** "New video" (and Replace) asks for the title, calls `create_draft`, and
    only then opens the editor `SidePanel` — the storage INSERT policy and the object's name both need
    the draft's id. The uploader is `LessonVideoUploader` with `target = onboardingUploadTarget(draftId)`:
    one frozen record per draft — the private bucket, `buildOnboardingVideoPath`, an own-path test
    scoped to THIS draft's folder, a tus resume key of its own, the onboarding signer, a plain-remove
    discard, and its own wording (`ONBOARDING_UPLOAD_COPY`, whose `messages` replace every shared
    refusal that names a lesson, course videos or their bucket — `bucket-missing` names
    `onboarding-videos` and the #69 migration; T9V-L1). That discard has no reference check because
    no two versions share a file, so what protects a SAVED file is the uploader's `path === savedPath`
    guard and the close sweep that skips it. It THROWS the `{ error }` that supabase-js `remove()`
    resolves (it never rejects), so the uploader logs it (AUI-4); every other removal on the screen goes
    through `sweepOnboardingFile(target, path, what)`, which logs what could not be removed, with its
    status — never the path. A `null` from the uploader means it discarded an upload —
    an accepted replacement, a Cancel or a Remove, never a refused pick — and puts the draft back on
    its SAVED file (T9V-L4). ★ **A version whose saved file is missing (`media_present === false`) opens
    as missing (AUI-2):** an empty uploader, no drawer player, and "This draft’s saved video file is
    missing from storage, so it can’t be previewed or published. Upload the video again." Save
    draft sends all three text fields whenever one changed (the RPC has NO defaults: an omitted field is
    a PostgREST error, never a silent clear — the #41 lesson), then `attach_media` with the facts
    `onMediaFacts` reported for THAT path (null where unknown; the server reads size and type from the
    object), then removes the `previous_storage_path` it returns, and sweeps a leftover upload the saved
    draft does not cite (AUI-1; see the Course platform section). A save whose attach is refused AFTER
    the details landed says what was saved, and re-reads the list (AUI-3). Closing follows the lesson
    drawer's rule (see the `SidePanel` bullet in Authentication).
  - ★ **The LIVE version and a RETIRED version can have their WORDS corrected (AUI-5).** "Edit details"
    opens the same drawer with no uploader ("A version’s file can’t change once it has been live…"), a
    status subtitle from `GS_EDITOR_SUBTITLE` and a "Save details" footer; only `update_details` is
    called. Editing the live version's words asks for the root's own answer again (`afterChange`'s
    fourth argument), so the Super Admin's card and tab follow.
  - ★ **Replacing the live video is asked for, never assumed — and bound to the version its dialog
    NAMED (DBSEC-1).** The literal `p_replace_live:` appears exactly twice: `true` in `confirmReplace`,
    `false` in `confirmPublish`. A publish that meets a version made live from another window comes back
    as `ONBOARDING_VIDEO_REPLACE_CONFIRM` and reopens as the Replace dialog. ★ **The server contract,
    proven on shadow:** `admin_onboarding_video_publish(p_video_id, p_replace_live boolean default false,
    p_expected_live_id uuid default null)` is the ONLY signature. The two-argument form is DROPPED first,
    because a new parameter otherwise adds an overload and every call that omits it becomes ambiguous
    (PGRST203, or "is not unique" in SQL). A replace whose named version is no longer the live one is
    refused with `ONBOARDING_VIDEO_REPLACE_CONFIRM` `{ live_id, live_title, expected_live_id }` and changes
    nothing — that covers another version published from a second window, and nothing live at all
    because someone unpublished it (then `live_id` and `live_title` are null). A NULL expected id keeps
    the original contract (retire whatever is live); a plain publish ignores the id. Pinned on the
    shadow project by `test-db/onboardingVideo.dbtest.mjs`. ★ **The client half:** `confirmReplace` sends
    `p_expected_live_id`, the live id frozen into the dialog when it opened (`confirm.live`), and the
    replace dialog's text is built from `confirm.live` alone. A stale one comes back as `REPLACE_CONFIRM`
    and reopens as Replace naming what is live NOW (`ctx.live_id`) — or, when nothing is live, as a plain
    publish warning "The video this was going to replace is no longer live, so publishing now replaces
    nothing." — with the list re-read, and never retried automatically. A publish refused with
    `ONBOARDING_VIDEO_MEDIA_INVALID`, `_NOT_FOUND` or `_STATE_INVALID` re-reads the list too (AUI-6), and
    `MEDIA_INVALID`'s copy now fits both the attach and the publish that raise it. A retired version whose
    file is missing says "File missing from storage, so it can’t be published again. To use this video,
    upload it as a new video." where its Publish again used to vanish silently (AUI-7). Every change
    confirms in an `AccountModal` that says who it affects (`publishImpact()` for a publish — the first one names the
    cutoff day — and the overview's counts for the rest), on a SOLID button that clears AA behind white
    text in both themes (`GS_OK_BTN` on `--ok-solid`, `GS_DANGER_BTN` on `--danger-solid`, else
    `--primary-solid` — never the `ADMIN_BTN_*` gradients; T9UI-4), and deleting the live version is
    unpublish-then-delete under one confirmation: a failed second call leaves it safely unpublished.
  - ★ **ONE health verdict, two surfaces.** `admin_onboarding_video_overview()` returns facts only;
    `onboardingHealth()` is their one interpreter (`unknown` · `none_live` · `file_missing` ·
    `playback_problems` · `unverified` · `ok`). The banner shows it through `AdminNotice` (whose `info`
    kind is new in #69 — an unknown kind would render as danger), and the admin-nav row's 0-or-1 badge
    ("the Getting Started video needs attention") is raised by the SAME verdict and never by `unknown`:
    a failed read is not a fact. Every overview read on the screen is paired with the root's badge read
    (`onHealthChange` → `refreshOnboardingHealth`, the fourth stable `TabPanel` callback), so the two
    cannot disagree.
  - A pre-#69 database shows the "finish database setup" card (`isMigrationMissing`), never a raw error.
- **`enrollment_decision_email_facts(p_request_id)`** (`enrollments.review`) is what the decision email
  may state: the request (status, kind, extension days); the plan of the GRANTED term (an extension is
  granted on the member's current plan, which need not be the request's); the subscription carrying the
  request — or, for an APPROVED extension no row carries (`approve_extension()` returns a no-end-date term
  unchanged), the live one, and for a rejected or pending request nothing beyond what carries it; the
  cohort, for a VIP segment only (#68); and `getting_started_required`. ★ It reports FACTS; the email
  decides what to say — a request reopened and then declined (#66) can still carry the term it once
  granted, which is why a rejection email states no term whatever the facts hold. There is deliberately
  NO access-request facts function: `api/notify-access.js` reads the profile with the reviewer's JWT.
  The email rules are in the Enrollment bullet of Authentication.
- **TESTS.** `test/gettingStarted.test.mjs` (the lib — since the final pass also
  `gettingStartedEnrollPhase` / `gettingStartedFailedBeforePass` and the sign-in-bound sequence,
  `gettingStartedNeedsReask`, `gettingStartedGiveUpCopy`, `gettingStartedStanding`);
  `test/gettingStartedSql.test.mjs` (every assertion against the dated file AND §56; the copied seed and
  catalog line-diffed against #67 §1 and #68; ACLs per function, the one publish signature included; all
  seven policies and the `required` rule's statements pinned WHOLE, operators included (TDR-2); a wiring
  scan of every RPC the app calls, its argument NAMES included (TDR-3) — a call shape it cannot read
  fails the suite); `test/gateMatrix.test.mjs` (the arm's precedence; its GF-2 cases, "a transient
  enrollment read error does not switch Getting Started off" and "once a member's app is running for
  this account, Getting Started never takes the session over"); `uiSafety` §28a (the shared media
  plumbing, incl. TDR-8/AUI-2), §28b (the student surfaces — since the final pass also the ROOT-LEVEL
  latch/welcome SEQUENCE test, which RUNS the root's own deferral block, phase line and latch effect
  through `resolveGateScreen()` and replaced the old latch test; the V-GF1-DOUBLE-BOUND hook test; the
  V-MIGRATED-PREDICATE test; a direct-switch case in the GF-7 test; the two K3R-GATE-DIRECT-SWITCH tests,
  which RUN the real `useEnrollmentGate` across a direct account switch (and, K3RV-CONFIGURED-CARRYOVER,
  a next account whose reads time out) and then the root's phase line with the real `useGettingStarted`;
  the K3RV-HOOK-SETTLE-UNPINNED test (`ready` while the hook is inactive; a first load that throws or
  stalls ends ready); the gate's focus hand-over and the earlier-version welcome case inside the sequence
  test, and `transientFocusTarget()` RUN on a stand-in element (K3RV-MAIN-CLICK-FOCUS); and GF-1/3/4/5/8,
  S1–S8), §28c (the
  admin screen — AUI-2…AUI-7, DBSEC-1, EMAIL-1, EMAIL-4, and the T9V-L2 test, which pins `rateLimited`
  as exactly a 429, V-EMAIL1-RATELIMIT), §19 (RES-1 twice, V-RES1-GUARD, V-RES1-LABEL; AUI-1 with §28c)
  and §T12B (the chokepoint's `tabAccessView`); the notify suites
  (`notifyEnrollmentDecision` and `notifyAccessDecision` gain EMAIL-1, EMAIL-2, EMAIL-3 and EMAIL1-R1,
  and `notifyAccessDecision` TDR-7's `stale_client`; `notifyEnrollmentSubmitted` gains EMAIL-2, EMAIL-3,
  EMAIL-4 and EMAIL3-PERF); `test-db/onboardingVideo.dbtest.mjs` on the shadow
  project — run it ALONE with `node --test --test-concurrency=1`, never `npm run test:db`. It also pins
  DBSEC-1 (a Replace bound to the version it named) and DBSEC-4 (the attach no-op, the no-op against
  the current row, a vanished file still refused): 47 tests (17 top-level), about 16 minutes on this
  link — 954.7 s on 2026-10-01, up from 37 tests in about 12 minutes. And
  `test-e2e/gettingStarted.e2etest.mjs`, which records its clip with the test Chrome's `MediaRecorder`;
  its test 8 must read the ROLE refusal ("Your account can’t open this screen"). ★ **A version left
  PUBLISHED on the shadow project gates every later student persona.** `resetOnboardingVideos()`
  (`test-db/_harness.mjs`) truncates — the only reset — and the rendered suite calls it in `before()`
  AND `after()`; `legacyMigration.e2etest.mjs` refuses to start while a version is live. ★ **A known
  transport flake, not a defect:** one TLS reset (`ECONNRESET`, "fetch failed") in an e2e `before()`
  fails the whole run, and a Storage "fetch failed" can fail one dbtest case; re-run once. It is
  deliberately not retried inside `scripts/_shadow.mjs`' `runSql`: retrying a THROWN fetch could
  execute a write twice when the reset came after the request reached the server. The `#69` block of
  `scripts/audit-db.mjs` checks the bucket, the storage policy QUALS (each policy's deciding expression
  compared WHOLE against its deparsed text), the three ACL classes with one signature per function, the
  141-code catalog and the gate rule's own source.

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
  - Prod: [api/anthropic/v1/messages.js](api/anthropic/v1/messages.js) (Vercel serverless, exact-path) does the same **and authenticates the caller**: it requires a valid Supabase session (`callClaude` attaches the `Authorization: Bearer <access_token>`) and gates token spend on **admin-or-`is_enrolled()`**, plus a model allowlist / `max_tokens` / body-size cap **and a per-user burst limit (20 req/min per warm instance — best-effort, not a billing boundary; 429 surfaces through `callClaude`'s normal error path)**. The membership check fails OPEN on RPC errors (availability) but logs a `[anthropic-proxy] is_enrolled indeterminate` warning — a stream of those in the Vercel logs means the gate is off. This closes the previously-open proxy (anyone could spend the key). `callClaude` fetching the session token is why it's `async`-aware of auth; the GET health check stays unauthenticated (zero-token).
- For JSON responses, tools strip ```` ```json ```` fences before `JSON.parse` (see `BankFeed`, ~L2214).
- For vision (PDF/image), tools send base64 `image`/`document` blocks in `messages[].content` (see
  `StatementConverter`, ~L2411).
- Under the hood `callClaude` is still a `fetch('https://api.anthropic.com/v1/messages', …)` with only
  `Content-Type: application/json` — that's what the `main.jsx` fetch shim rewrites to `/api/anthropic`.

## Voice assistant (ElevenLabs) — "Toolkits Siri"

The assistant's name has ONE source: `VOICE_ASSISTANT_NAME` / `VOICE_ASSISTANT_SHORT_NAME` in
[src/lib/voiceAccess.js](src/lib/voiceAccess.js) ("Toolkits Siri"). ★ Its previous name was
"Toolkits Guide", and the ElevenLabs agent **record** is still called `Toolkits Guide by Alex`
(`AGENT_NAME` in `scripts/provision-voice-agent.mjs`). That is deliberate, not stale: provisioning
finds the agent BY NAME, so renaming the record without `ELEVENLABS_AGENT_ID` set would create a
second agent instead of updating the live one.

A floating mic FAB (bottom-right) that lets **enrolled members + admins** talk to the app: ask
about tools/plans/membership and have the agent navigate tabs or open account panels. Full
setup/ops guide: [docs/ai/voice-agent-setup.md](docs/ai/voice-agent-setup.md).

- **Client** — the `VoiceAssistant` component in BookkeeperPro.jsx (just above the keep-alive
  section), mounted ONCE in the root shell after the `?panel=` overlay block, gated by
  `is_admin || !REQUIRE_ENROLLMENT || enroll.state==='pass'`. It renders through `OverlayPortal`
  at `z-[60]` (above sidebar z-50, below the z-[70] account modals) and never passes props
  through `TabPanel` (keep-alive memoization untouched). The FAB only appears when the GET
  health check reports `configured:true` (cached on `window.__voiceCfgPromise`) — unset env
  vars are a soft off switch. The **`@elevenlabs/client` SDK is lazy-loaded via dynamic
  `import()`** (own chunk, XLSX idiom — do not add it to `manualChunks`).
- **Server** — [api/elevenlabs/signed-url.js](api/elevenlabs/signed-url.js): GET = unauthenticated
  health check `{ ok, configured }`; POST mints an ElevenLabs signed URL after: a valid Supabase
  JWT (else 401) → an 8-mints/min/user rate limit (429, checked BEFORE any RPC) → `is_enrolled()`
  and `my_staff_context()` asked **in parallel**, each attempt bounded and retried once → the
  verdict from `voiceSessionVerdict()` in [src/lib/voiceAccess.js](src/lib/voiceAccess.js):
  `allow` mints, `deny` → 403, `unavailable` → **503 + Retry-After**.
  ★ **It FAILS CLOSED.** It used to fail OPEN on an indeterminate RPC (log a warning, mint anyway),
  which converted a Supabase outage into free metered voice sessions. The stated trade, written in
  the handler: an outage now takes the widget down instead. An **active** staff member (Super
  Admin, Operations Admin, Trainer) is admitted without a subscription — previously the gate
  hid the assistant from staff. Suspended, revoked and invited-but-unaccepted staff are refused.
  This gate is now STRICTER than `api/anthropic`, which still fails open by design.
  Env: `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` (server-only), optional
  `ELEVENLABS_SERVER_LOCATION`. **Unlike the notify fns, this DOES run under `npm run dev`** —
  the `elevenlabsDevApi` plugin in vite.config.js imports the real handler, so dev exercises
  the real auth gate.
- **Client tools** (built in `VoiceAssistant.buildClientTools()`; names must match the agent's
  dashboard config exactly): `navigate_to_tool` (fuzzy `resolveVoiceTool` → `writeAppRoute`;
  navigates even into a plan-restricted tab — RestrictedTab's upsell is the chokepoint — and
  tells the agent so; refuses admin tabs for members), `open_account_panel` (`setPanelParam`,
  billing panels blocked when `!showBillingControls`), `explain_current_page` (`readAppRoute` +
  `VOICE_TAB_INFO`), `show_feature_help` (`VOICE_FEATURE_HELP`), `get_user_membership_summary`
  (composes `subAccess`/`planEntitlement`/`membershipStatus` from root-loaded gate state — no
  refetch, only the user's own data), **`open_course_lesson`** (deep-links an authorized course +
  lesson via `openCourseLessonRoute()`/`trainerCourseTab()` — the catalog/CourseProgram plan
  guard stays the chokepoint), and **`show_lesson_sources`** (pushes a course-citation chip into
  the transcript UI — needed because webhook tool results never reach the browser; the agent
  relays citations through it). Tool closures are created once at `startSession`, so they
  read live state via `liveRef` — never render-scope captures. `buildClientTools()` **assembles
  its returned tool set from the `VOICE_CLIENT_TOOL_SPECS` names** (a spec/handler mismatch logs
  a loud `[voice] client tool spec/handler drift` console error) — so the browser-registered
  tools and the ElevenLabs-declared tools share one source of truth.
- **`VOICE_TAB_INFO` / `VOICE_CLIENT_TOOL_SPECS` / `VOICE_SERVER_TOOL_SPECS` purity contract:**
  the module-scope literals `VOICE_TAB_INFO`, `VOICE_TOOL_ALIASES`, `VOICE_FEATURE_HELP`,
  `VOICE_CLIENT_TOOL_SPECS`, and `VOICE_SERVER_TOOL_SPECS`
  (next to the route helpers) drive the runtime tools AND are parsed out of this file —
  `VOICE_TAB_INFO` by `scripts/generate-voice-agent-knowledge.mjs`, and both TOOL_SPECS arrays
  (names/descriptions/JSON-Schema params, mirroring
  [docs/ai/voice-agent-setup.md](docs/ai/voice-agent-setup.md) §4/§4b) by
  `scripts/provision-voice-agent.mjs`. All must stay **pure literals** (strings/booleans/plain
  objects, no refs or calls); `VOICE_TAB_INFO` needs one entry per `TAB_ROUTES` id — the
  generator/provisioner exit 1 with an actionable message otherwise.
- **Knowledge pipeline:** `npm run ai:knowledge` regenerates
  [docs/ai/toolkits-voice-agent-knowledge.md](docs/ai/toolkits-voice-agent-knowledge.md)
  (deterministic — extracts `TAB_ROUTES`/`VOICE_TAB_INFO`/`TIPS`/`NON_TOOL_TAB_IDS` from the JSX, **imports**
  `ENROLLMENT_PLANS_FALLBACK`/`PLAN_ENTITLEMENTS` from `src/lib/planCatalog.js` since #39, and fills
  a hand-authored template; it now FAILS if a catalog plan has no entitlement entry);
  `npm run ai:knowledge:push`
  additionally uploads it to the ElevenLabs knowledge base by name (idempotent, replaces the
  old copy, other KB docs untouched). There is **no auto-sync** — regenerate + push whenever
  tools/plans change (see Keeping docs current), and **`npm run ai:knowledge:check`** rebuilds
  the doc in memory + diffs it against disk (Generated-date ignored; exit 1 on drift) so a
  feature change can't silently leave the static product guide stale.
  ★ **The tool count it states is the APP'S OWN** — `TAB_ROUTES` minus `NON_TOOL_TAB_IDS`, the
  expression behind the Dashboard's "Pro Tools" figure (`mockinterview` is in the set). It used to
  subtract only `dashboard`/`accessrequests`/`enrollments`, so the document called every other Home
  and admin screen a tool: 38 at #68, 40 after #69, while the app said 30. `--check` could not see
  it, because it compares the generator with itself; `test/voiceKnowledge.test.mjs` runs the
  generator in a throwaway copy and fails when its number and the app's expression disagree.
- **Provisioning pipeline:** `npm run ai:provision` builds the whole ElevenLabs side from the
  repo so the only manual step is the API key — it regenerates the KB, then
  `scripts/provision-voice-agent.mjs` creates/updates the client tools from
  `VOICE_CLIENT_TOOL_SPECS` **and the four AI-trainer webhook tools from
  `VOICE_SERVER_TOOL_SPECS`** (`webhookToolConfigFor()` — URL =
  `${APP_URL}/api/elevenlabs/trainer?action=…`, header `Authorization: Bearer
  {{secret__trainer_token}}`; `APP_URL` unset → webhook tools skipped with a loud WARN), the
  agent (system prompt + first message read from voice-agent-setup.md §3, signed-URL auth ON,
  max-duration cap), and attaches the KB. Idempotent
  by name; set `ELEVENLABS_AGENT_ID` to update an existing agent in place, else it creates one and
  prints the id. `--dry-run` previews every call with no key. The KB-reconcile + REST helpers are
  shared between push and provision in `scripts/_elevenlabs.mjs` (the generator keeps its own copy
  of the literal extractor to stay side-effect-free).

### AI course trainer (entitlement-aware course teaching) — migration #27

The voice assistant doubles as an **AI course trainer**: enrolled learners ask it to teach/
explain/quiz/practice/recap the Supabase-hosted courses. Full setup:
[COURSE_AI_TRAINER_SETUP.md](COURSE_AI_TRAINER_SETUP.md). Architecture rules:

- **Two knowledge systems, kept separate:** the static ElevenLabs KB doc carries ONLY public
  product/nav/plan info (regenerated via `ai:knowledge`); **paid course content lives in
  Supabase** (`course_ai_sources` → `course_ai_chunks`, pgvector 384 + generated-tsvector FTS
  fallback) and is retrieved per-request through four **webhook tools** served by
  [api/elevenlabs/trainer.js](api/elevenlabs/trainer.js) (`get_my_training_catalog`,
  `get_authorized_training_context`, `get_my_training_checkpoint`, `save_training_checkpoint`).
  Never attach course content to the KB doc.
- **Authorization is server-side and FAIL-CLOSED** (like the signed-url gate, which now fails
  closed too; unlike the `api/anthropic` proxy, which still fails open by design): every trainer
  request verifies a short-lived HMAC
  **trainer token** (minted by signed-url.js when `TRAINER_TOKEN_SECRET` is set; identity-only
  claims; codec in [src/lib/trainerToken.js](src/lib/trainerToken.js)), then re-queries
  `trainer_visible_courses(p_user)` under the service role — a SECURITY DEFINER function that
  **mirrors the `courses_read` RLS policy exactly** (published + approved + enrolled + plan
  scope + `courses.ai_trainer_enabled`), revoked from anon/authenticated. An unavailable check
  returns a temporary-error envelope, never content. Retrieval-time joins (published +
  enabled + source `ready`/`included` + version match) make unpublished/stale content
  unretrievable on the very next call. When plan-scope rules change, `courses_read`, the
  parameterized mirrors in #27, `PLAN_ENTITLEMENTS` (src/lib/planCatalog.js), AND `planScopeAllows()` in
  [src/lib/trainerContent.js](src/lib/trainerContent.js) must all change together (the
  `test/trainerAccess.test.mjs` truth table pins it).
- **The token rides the `secret__trainer_token` dynamic variable** (headers-only — ElevenLabs
  never shows `secret__` vars to the LLM). The ordinary dynamic variables
  (`plan_label`/`plan_scope`/…) are informational ONLY — never authorization inputs.
- **Response contract:** every trainer reply is a bounded envelope built by
  `buildTrainerEnvelope()` (≤6 chunks × ≤1,200 chars, ≤6,500 total; statuses
  `ok/denied/error` + safe speakable `message`); denials name the learner's plan + allowed
  course titles only. Chunk/lesson content is never logged. Durable per-user daily caps live
  in `ai_training_usage` (`trainer_bump_usage` RPC — fail closed if it errors).
- **Checkpoints ≠ progress:** `ai_training_checkpoints` (own-read RLS, service-written) is
  deliberately separate from `lesson_progress` — a conversation never marks lessons complete.
- **Indexing (admin):** [api/admin/course-trainer.js](api/admin/course-trainer.js)
  (student-imports auth skeleton; actions `status/sync/transcribe/save-transcript/
  set-source-included/retry-source/preview`) chunks lesson `text_content`
  (`chunkText()` in trainerContent.js, sha256 idempotency, `source_version` bumps) and embeds
  via the **`trainer-embed` Supabase Edge Function** (gte-small; auth = service-role key;
  unreachable → automatic keyword fallback + amber pill). **Scribe v2 transcription is
  admin-triggered only** (upload/mp4 lessons; YouTube/Vimeo = manual transcript, never
  scraped) and lands as a **pending draft** an admin must "Approve & index". Editing a lesson
  fires the pure-SQL stale trigger + a fire-and-forget `kickTrainerSync()` from `saveLesson`.
  Admin UI = the **`CourseAiTrainerPanel`** glass-card in `renderBuilder()` (enable toggle,
  status pills, transcript editor, Sync, **Preview as plan**; pre-#27 → a "finish backend
  setup" card). `vercel.json` now has a `functions` block (trainer 60s, course-trainer 300s
  for Scribe). Trainer state is server-side — nothing goes in `LEGACY_KEYS`.
- **Voice deep-links:** `?lesson=<id>` joins `?course=` in `tabHref`/`readAppRoute`;
  `CourseCatalog` syncs it on popstate + the route-change event and hands `initialLessonId`
  to `CourseProgram`. Citation chips in the widget transcript navigate through the same path.

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
- **A FLAT fill behind white text uses `C.primarySolid`** (`--primary-solid`, #0070E0, 4.78:1), never
  `C.primary` (#0A84FF, 3.65:1 — below the WCAG AA 4.5:1 floor, and it fails in BOTH themes because
  the brand blues are theme-independent). `C.primary` stays correct for borders, icons, rings, bars and
  accent text, where the 3:1 non-text floor applies. ★ Known-outstanding: the house GRADIENT button
  (`linear-gradient(180deg, C.primaryHi, C.primary)`, ~73 inline uses plus `.sheen-btn`) still puts
  white text on `--c-primary-hi` #3D8BFF = 3.31:1. `test/uiSafety.test.mjs` ratchets the flat pattern
  and cannot see the gradient one; restyling those ~109 controls is a visual change, not an audit fix.
  ★ **Its two siblings (#69, T9UI-4): `--ok-solid` #1B7A35 (5.41:1) and `--danger-solid` #D02323
  (5.32:1)**, theme-independent like it (the dark block does not override them) — the flat green and
  red behind white text, used by #69's dialogs through `GS_OK_BTN` / `GS_DANGER_BTN`. The shared
  `ADMIN_BTN_OK` / `ADMIN_BTN_DANGER` gradients still put white text on their bright stops (1.87–4.11:1)
  and are left alone for the same reason as the blue gradient.
- **Never string-concat an alpha onto a token** — `` `${C.primary}66` `` is broken CSS against a var.
  Use the alpha tokens instead: `var(--primary-glow)` (was `66`), `--primary-glow-soft` (`55`),
  `--primary-selection` (`33`), `--primary-halo` (`1A`), `--primary-tint` (`14`), `--green-ring`,
  `--green-ring-faint`, `--red-glow`, `--green-glow`, `--focus-ring`, the solid-button gradient
  endpoints `--green-hi`/`--red-hi` (used by the shared `ADMIN_BTN_OK`/`ADMIN_BTN_DANGER` styles —
  `linear-gradient(180deg, var(--green-hi), var(--c-green))`), and the neutral washes
  `--wash`/`--wash-strong`.
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
  cells in the wide financial tables). ★ #56 removed the four tinted variants
  (`--table-sticky-{soft,deeper,ok,danger}-bg`) along with the Budgeting and Forecasting
  tools that were their only consumers; only `--table-sticky-bg` remains. Defined in both theme blocks (light =
  the original glass literals; dark = navy glass from the `#101B30`/`#0B1322` family) — reuse these
  for any new shell chrome instead of hardcoding light rgba values, which the dark compat layer
  cannot fix on inline styles.
- **`.gh-app-bg` children vs overlays:** the app-bg mesh has a `position: fixed` `::before` noise
  layer, and `index.css` lifts content above it with `.gh-app-bg > *:not(.fixed) { position:
  relative; z-index: 1; }`. The `:not(.fixed)` guard is load-bearing — a bare `> *` out-cascades
  Tailwind's `.fixed` (this file is emitted after `@tailwind utilities` at equal specificity) and
  demotes any fixed overlay that is a *direct child* of a `gh-app-bg` element into an in-flow flex
  column (this was the root cause of the 2026-07 account-panel "squeezed side card / invisible
  drawer" bugs). Don't widen the rule back, and don't render hand-rolled fixed overlays as direct
  `gh-app-bg` children — use `AccountModal`/`SidePanel`, which portal to `document.body` anyway
  (see the shared-dialog bullet in Authentication). **Same-element hazard:** `.gh-app-bg` itself
  sets `position: relative`, which equally out-cascades `.fixed` when both classes sit on ONE
  element — this dropped the portaled upgrade/renew paywall overlays into body flow (rendered
  *below* the app, pushing the page down). A `.gh-app-bg.fixed { position: fixed }` carve-out now
  guards the combo, but prefer layering: fixed wrapper > `gh-app-bg` (or self-painting) child —
  the upgrade/renew wrappers no longer carry the class (`EnrollmentPaywall` paints its own mesh).
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
- ★ **Layout by the workspace, not the viewport.** The sidebar is 288px open, 76px as the rail and 0
  below `lg`, so at ONE viewport width a tab has three different amounts of room — 726px, 938px or the
  whole screen at 1024. A `md:`/`lg:`/`xl:` breakpoint cannot see which. Anything inside a TabPanel
  whose arrangement depends on available width uses a **named container query on the narrowest
  wrapper that needs it** (never on TabPanel itself — `container-type` makes that element a stacking
  context and the containing block for `position:fixed` descendants), with the narrow layout as the
  base and thresholds derived from measured content, the derivation written in the CSS.
  Precedents: `.course-workspace`, `.pf-tool`, `.enroll-card`.
  ★ **And never put a row of buttons in an `auto` grid track beside a `minmax(0,1fr)` column.** Grid
  grows `auto` tracks to their max-content BEFORE any `fr` track gets space, so the buttons sized the
  grid and the Enrollments card's identity column resolved to **0px** at 1024/1280/1366/1440 with the
  sidebar open — measured, with the phone number wrapping a digit per line — while the card reported
  `scrollWidth === clientWidth`. An overflow check is not a layout check. Actions go in their own row.
  `npm run test:e2e` (`test-e2e/enrollmentLayout.e2etest.mjs` + `workspaceSweep.e2etest.mjs`) measures
  this in a real browser with the sidebar open and collapsed.

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
  to `payment_settings.notify_email`, then to `RESEND_FROM`), and since #69 it is also the SECOND choice
  for a student email's Reply-To (after `payment_settings.notify_email`; never `RESEND_FROM`).
  `APP_URL` is the origin of every link those emails carry — on Vercel there is no fallback (without it
  an email has no link), and the request's own host is used only under `npm run dev`.
  These are **this app's own** secrets — **Supabase Auth's SMTP/Resend settings are unrelated** and
  only send Auth emails. All are non-fatal when unset. ★ **Both notify fns DO run under
  `npm run dev`** since 2026-08-22 — `vite.config.js` registers `notifyDevApi` for
  `/api/notify-enrollment` and `/api/notify-access`, mirroring the ElevenLabs/trainer middleware.
  Before that they were the only `api/` handlers with no dev route, so localhost 404'd and no send
  was ever attempted — which is why the enrollment confirmation email was repeatedly believed not
  to exist. It did; it just could not run outside Vercel. Restart the dev server after adding keys
  (Vite reads `.env` at startup). Diagnose from **Enrollments → "Test email"** or the GET health check.
- **Migration email (server-only, optional, #67/#68):** `MIGRATION_EMAIL_FROM` overrides the From of the
  legacy-migration emails, which otherwise come from `support@<RESEND_FROM's domain>`
  (`support@toolkits.alexsagun.com`, the domain verified in Resend). `MIGRATION_REPLY_TO` overrides the
  Reply-To and printed support address, otherwise `support@alexsagun.com`; the From never moves it.
  `MIGRATION_DAILY_EMAIL_CAP` (default 100, Resend's free plan) is the allowance the activation preflight
  warns against. Whatever the From, its domain must be verified in Resend: prove it with
  **Student Imports → Send test email** before activating anyone.
- **Voice assistant (server-only, optional):** `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` enable
  the in-app voice widget (`api/elevenlabs/signed-url.js` + the `ai:knowledge:push` / `ai:provision`
  scripts); optional `ELEVENLABS_SERVER_LOCATION` picks the ElevenLabs region, and `ELEVENLABS_VOICE_ID`
  / `ELEVENLABS_AGENT_LLM` let `ai:provision` set the agent's voice + LLM. Never `VITE_`-prefixed.
  Unset = the mic FAB simply never renders. These DO work under `npm run dev` (Vite middleware).
  Fastest path to live: put `ELEVENLABS_API_KEY` in `.env`, run `npm run ai:provision` (creates the
  agent + tools + KB and prints the agent id), then set both vars in Vercel.
  See [docs/ai/voice-agent-setup.md](docs/ai/voice-agent-setup.md).

## Deployment

- **Vercel:** push to GitHub → import project → set `ANTHROPIC_API_KEY` (Production + Preview) → deploy.
  The serverless function at `api/anthropic/v1/messages.js` replaces the dev proxy automatically.
- ★ **After deploying #69, reload every open admin tab (TDR-7).** A tab loaded before the deploy keeps
  the old bundle, whose Access Requests posts `{ email, fullName, status, reason }` with no `userId`.
  The new `api/notify-access.js` refuses that with 400 `{ code: 'stale_client' }` (an earlier #69 build
  answered a bare 400 "userId (uuid) required.") and logs `[notify-access] refused a decision with no userId …`,
  with no address. The DECISION is still recorded; only its email is not sent, and the stale tab shows
  ` · email not sent`. A reload fixes it. A decision made from a stale tab is not re-emailed
  automatically, so tell that person another way if it matters.
- **Google Apps Script (alternate) — LEGACY, NOT MAINTAINED:**
  [standalone/index.html](standalone/index.html) is a self-contained build for embedding in
  Google Sheets. ★ It has not been regenerated since the initial Vite scaffold (2026-06-07):
  it contains **no** Supabase auth, no community, no plans and no staff roles, it holds the
  Anthropic key in browser localStorage, and it still ships tools the app has retired
  (Budgeting and Forecasting). There is **no script that generates it**, so it cannot be
  re-cut from source; treat it as an archived artifact, not a shipping distribution, and do
  not hand-patch its minified bundle to keep it in step.
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
- **Adding/renaming a tool, or changing plans/entitlements/pricing** → also update `VOICE_TAB_INFO`
  (+ aliases) in BookkeeperPro.jsx and rerun `npm run ai:knowledge` (and `ai:knowledge:push` when
  deployed) **in the same change**, so the voice assistant's knowledge never drifts from the app.
  `npm run ai:knowledge:check` must pass (it exits 1 when the committed doc no longer matches the
  code — run it before calling any tools/plans change done). The document's tool count is the app's
  own (`TAB_ROUTES` minus `NON_TOOL_TAB_IDS`): a screen that is not a tool goes in that set, and
  `test/voiceKnowledge.test.mjs` fails if the generator ever counts differently.
- **Deciding whether a post is an ANNOUNCEMENT** → the `community_channels.kind` of the channel it
  is in, and nothing else (#43). The tag `community_tags.slug = 'announcements'` is post TAXONOMY
  only. These were two disagreeing switches: the rail, header and composer read `kind` while the
  bell, unread badge, read-markers, Announcements filter tab and right rail read `tag_slug`, so a
  post made in `#announcements` with the composer's default tag notified nobody and never appeared
  under the tab, while a post merely TAGGED Announcements in an ordinary room rang every bell.
  Client-side the switch is `isAnnouncementPost()` in `CommunityHub` (plus `annChannelIds`, and
  `useCommunityBell`'s own `community_channels` lookup); `COMMUNITY_ANNOUNCEMENTS_SLUG` survives
  ONLY as the pre-#40 fallback for a database with no channels. Do not reintroduce a tag test.
- **Changing which channels a member can see** → four places move together:
  `user_community_channel_ids()` ↔ `channelAudienceAllows()` in `src/lib/communityChannels.js`
  ↔ `test/communityChannels.test.mjs` ↔ `test-db/communityChannels.dbtest.mjs`. The audience
  modes fail CLOSED on an empty mapping and on an unknown mode — keep it that way.
- **Changing what a member can DO in a channel** → `user_community_channel_capabilities()` ↔
  the five channel-scoped write policies ↔ `effectiveChannelCaps()` ↔ both suites. The client
  must consume the server-computed `can_*` verbatim and fail closed while they load — the
  pre-#40 bug was a re-derivation from raw space flags that failed OPEN.
- **Changing community write permissions** → five places move together: the `enrollment_plans`
  capability columns (#36) ↔ `user_community_capabilities()` ↔ the five community write policies ↔ the per-channel flags (#40) ↔
  `capabilitiesFor()`/`effectiveCaps()` in `src/lib/communityCapabilities.js`
  (`test/communityCapabilities.test.mjs` pins the truth table — 3 plans x 2 space kinds x 4 actions
  since #39; it was 5 x 3 x 4 under #36) ↔ **the STAFF write bypass** in
  `user_community_capabilities()` / `user_community_channel_capabilities()`, which since #56
  is `user_is_community_staff(p_user)` rather than `is_admin`. That bypass is a confirmed
  product decision: Community staff post, comment, react and attach in ANY channel,
  `#announcements` included — a moderator who can hide a reply can also write one.
- **Changing how many cohorts a plan grants** → `plan_batch_count()` ↔
  `enrollment_plans.eligible_batch_count` ↔ `planBatchCount()` in `src/lib/batchEntitlements.js`
  (`test/batchEntitlements.test.mjs` pins it).
- **Adding, removing or renaming an enrollment intake question** → `INTAKE_FIELDS` in
  `src/lib/enrollmentIntake.js` is the ONLY place that needs to change for it to render, be
  required, be flagged when blank, prefill on renewal, **and be saved**. If it must be *stored*,
  exactly ONE other thing moves with it: a dated migration adding the column (or nothing at all,
  for a key inside the `intake` jsonb). ★ Since #43 the write side is registry-DERIVED — the row
  comes from `intakePayload(values)` and the admin alert's select list from
  `intakeSelectColumns()`. It used to be a hand-typed literal in `EnrollmentPaywall.submit()` plus
  a hand-typed `INTAKE_COLS` string, which reproduced this module's founding bug on the write path:
  a field could render with a red asterisk, block submit, prefill and pass every test while never
  being saved — indistinguishable in review from a student who skipped a mandatory question.
  Mark a field `base: true` if `submitSubscriptionRequest`'s own base row already writes it
  (`full_name`/`email`/`phone`/`city_country`), or it will spread over that row — and `email` must
  come from the ACCOUNT, not the form. `test/enrollmentIntake.test.mjs` pins the registry
  invariants and the render↔validate↔persist parity;
  `test/enrollmentIntakeSql.test.mjs` pins the option lists against the four SQL CHECK constraints
  in **both** the dated migration and the bootstrap fold — a reworded option otherwise produces a
  bare `23514` *after* all four files have uploaded, so no retry can ever succeed.
- **Adding or re-folding a section of `db/000_full_database_bootstrap.sql`** → splice to the END
  of the section you are replacing, **never to EOF**. On 2026-08-23 a re-fold of §29 (#42) ran to
  end-of-file and silently deleted all 535 lines of §30 (#43) — a security policy, two storage
  cleanup paths, an admin RPC contract and the feed index #43 exists to fix. `npm test` stayed
  green, `npm run build` stayed green, and the truncated file ended on a tidy `AFTER RUNNING`
  comment, so it read as a clean EOF. **`test/bootstrapFolds.test.mjs` now pins this**: § numbers
  must be contiguous, each fold must contain the whole SQL body of the dated file it names (the
  `do $pre$` preflight is the one documented omission), and every dated migration that records
  itself in `schema_migrations` must be named somewhere in the bootstrap. That last check is the
  one that catches an outright deletion. `npm run db:audit` would also have noticed — but it needs
  credentials, and `db:shadow:verify --all` re-applies every dated file on top of the bootstrap,
  which would re-apply the missing migration and **mask the gap entirely**.
- **Changing the Training Agreement's wording** → bump `AGREEMENT_VERSION` in
  `src/lib/trainingAgreement.js` in the same change. `enrollment_requests.agreement_version`
  records which text each student accepted, so editing the document without bumping makes every
  past signature appear to endorse the new terms. Repricing or renaming a plan is NOT a wording
  change — prices are read from `enrollment_plans` at render time. `test/trainingAgreement.test.mjs`
  pins section contiguity (the source silently dropped Section 4), the three tier columns, and
  that no retired copy — Discord, Thinkific, a hardcoded extension price — creeps back in.
- **Changing the enrollment processing-hours copy** → `ENROLLMENT_PROCESSING_NOTE` in
  `src/lib/enrollmentIntake.js` is the ONE source. It is rendered on the pending screen
  (`EnrollmentPendingScreen`, directly under the intro paragraph) AND passed as the `note` of the
  student confirmation in `api/notify-enrollment.js` — which imports it, so the two physically
  cannot drift. A student who reads one turnaround promise on screen and a different one in their
  inbox has been told two things about when they get access, and the second arrives while they are
  already waiting. `test/enrollmentIntake.test.mjs` pins each of the four promises separately (the
  24-hour turnaround, the 9–5 window, the after-5PM rule, and weekends/holidays) so a reword cannot
  silently drop one. `emailHtml`'s `note` accepts a string or an array of lines.
- **Changing what an enrollment or access EMAIL may state, or to whom** (#69) → every STUDENT-facing
  email's recipient is always the account's `profiles.email`, read server-side (the student's JWT for
  `submitted`, the reviewer's for `decision` and `api/notify-access.js`) — never an address a request
  body or a student-typed column names (the `submitted` admin alert goes to the admin recipient chain
  instead: `NOTIFY_ADMIN_EMAIL` → `payment_settings.notify_email` → `RESEND_FROM`'s address); and the
  facts come from the database (`enrollment_plans` / `batches` for `submitted`,
  `enrollment_decision_email_facts()` for `decision`, the reviewed `profiles` row for access). Moving
  together: `api/notify-enrollment.js` / `api/notify-access.js` ↔ `plainTextEmail()` + `studentReplyTo()`
  in `api/_lib/email.js` ↔ `enrollment_decision_email_facts()` (#69 + §56) ↔
  `test/notifyEnrollmentSubmitted.test.mjs` + `test/notifyEnrollmentDecision.test.mjs` +
  `test/notifyAccessDecision.test.mjs` (exact idempotency headers, text-part link parity, Manila day
  boundaries) ↔ the `AccessRequests` payload and the Enrollments `?request=` deep link (`uiSafety`
  §28c). ★ A key stays inside `[A-Za-z0-9:_-]{8,128}`: `sendEmail()` silently swaps any other for a
  random UUID, which quietly turns "one email per decision" back into one per click. ★ Reply-To never
  falls back to `RESEND_FROM`. ★ Every date is the Manila calendar day (`manilaDateOf` +
  `formatCalendarDate`). ★ A facts failure sends the generic copy — it never refuses a decision that was
  recorded. ★ A decision's key carries the moment it was recorded (`reviewed_at`, or `approved_at` /
  `rejected_at`), so a decision made again is a new email; only a 409 named
  `concurrent_idempotent_requests` is "in flight" (`resendConflictKind()`, opted into with
  `classify409`); the text-part fold is `foldLineBreaks()`, linear, over every mandatory line break; and
  a decision email has two burst guards — 10 a minute of ONE decision, 60 a minute of one reviewer's
  decisions — never one keyed on the reviewer alone.
- **Changing how an email outcome is reported** → `emailOutcomeUnclear()` (the ONE rule) ↔
  `AccessRequests`' `notifyAccess` / `emailSuffix` ↔ `AdminEnrollments`' `notifyDecision` / `emailSuffix`
  / `emailTally` / `decisionEmail` (`rateLimited` is exactly a 429) ↔ `NOTIFY_META` ↔ the codes
  `api/notify-enrollment.js` and `api/notify-access.js` return ↔ `uiSafety` (T9V-L2, EMAIL-1, EMAIL-4,
  TDR-5, V-EMAIL1-RATELIMIT). ★ "May not have been sent" is for an answer that proves nothing either
  way (a timeout, a dropped connection, a provider 5xx, a 504, no answer); never let it read "not sent",
  which invites a second email by hand.
- **Changing what a course lesson video may be** → the rules live in ONE pure module and are
  mirrored in SQL. Move together: `src/lib/courseVideo.js` ↔ `course_lessons_video_guard()` /
  `courses_publish_guard()` / `course_video_object_readable()` in
  `db/2026-08-24-course-video-upload-only.sql` **and its verbatim bootstrap fold §31** ↔ the
  `course-videos` bucket's `file_size_limit` / `allowed_mime_types` ↔
  `test/courseVideo.test.mjs` + `test/courseVideoSql.test.mjs` + `test-db/courseVideos.dbtest.mjs`
  ↔ the `#44` `OBJECT_CHECKS` in `scripts/audit-db.mjs`. The SQL-parity suite exists because a
  client cap above the bucket's makes the browser promise a size Storage will 413 — after the file
  has already spent ten minutes transferring.
  ★ **The CODEC and the index position are checked before the upload, not after it, and they
  are checked in the FILE — never by asking a browser.** `validateVideoFile()` reads the name,
  the MIME type and the size, and an H.265/HEVC file satisfies all three, so for the whole life
  of #44 the only thing keeping HEVC out of a paid course was `probeVideoMetadata` on the local
  blob — which asks **the admin's own browser** whether it can decode the file. That is the one
  machine guaranteed not to be a student's, and it answers for its own GPU: HEVC needs a
  **hardware** decoder, so "probably" on a 2023 laptop says nothing about a budget Android phone.
  On 2026-09-03 an 859 MB `hvc1` lesson passed that gate. `inspectLessonVideo()` /
  `describeVideoContent()` now read `moov → trak → mdia → stbl → stsd` out of the container
  itself — and REPORT rather than refuse (see below). Moving together:
  `LESSON_VIDEO_CODECS` ↔ `describeVideoContent()` ↔
  `handlePick` in BookkeeperPro.jsx ↔ `test/courseVideoContent.test.mjs` ↔ the uploader's
  helper copy. **Walk the boxes; never scan for the literal bytes `avc1`** — a scan matches the
  string inside a `free` box, a filename in `udta`, or by luck in compressed payload, and
  reporting H.264 for an HEVC file is the exact bug the module exists to prevent (pinned).
  ★ It **fails OPEN on unknown**: an unparseable container reports `codec: null` and is allowed
  through to the decode probe, i.e. exactly the old behaviour. Blocking on "we could not parse
  it" would refuse good lessons whenever the walker meets a shape it does not know; the cost of
  a wrong refusal is the admin's work, the cost of a miss is a probe that already runs.
  ★ **NEITHER container finding is a hard refusal, AND NEITHER MAY INTERRUPT** (2026-09-08).
  `severity` is `'warn'` on both, and `'warn'` means *say this while the upload runs* — never
  *ask a question*. `handlePick` always reaches `runTransfer`. The only hard blocks left are
  `validateVideoFile`'s: not an `.mp4`/`.mov`, empty, or over the cap.
  ★ **This took two attempts, and the second failure is the instructive one.** #44 blocked HEVC
  outright. 2026-09-07 downgraded it to a warning — but kept it as an amber `role="alert"` card
  with an "Upload anyway" button that halted the flow. Every transition behind that button was
  correct and the button worked; the admin it was written for read it as a refusal, pressed
  **neither** option, and reported that the toolkit would not let them upload an H.265 video.
  **A finding that interrupts is a block in practice, whatever its severity field says.** The
  notes now render in the neutral `role="status"` strip beside a live progress bar. There is
  nothing to accept and nothing to dismiss. Pinned by `uiSafety` §19, mutation-tested.
  ★ **And say true things.** The blocking message claimed *"Firefox has no decoder for it at
  all"* — false since **Firefox 134** (Windows, Jan 2025); 136 added macOS, 137 Linux. Chrome
  and Edge have decoded HEVC since 107, Safari for years. What is true in 2026 is narrower and
  checkable: every major browser decodes it, but only with a **hardware** decoder, so roughly
  **one viewer in eight** cannot — older/budget Android, laptops from before ~2015, and **Edge
  on Windows without Microsoft's HEVC Video Extensions** (**Chrome on Windows needs no such
  extension**). `test/courseVideoContent.test.mjs` pins the message against the old claim.
  ★ **`.mov` is accepted (#57, `db/2026-09-08-lesson-video-quicktime.sql`, fold §44).** A `.mov`
  is the same ISO base media container an `.mp4` is — `mp4Faststart.js` already handles
  QuickTime's non-FullBox `meta`, and `sanitizeVideoFileName` still stores it as `.mp4`. It was
  refused with *"must be MP4 (H.264 video, AAC audio)"*, which is a codec instruction from a
  gate that cannot see a codec, and iPhone/Mac recordings are exactly `.mov` + HEVC. Moving
  together: `LESSON_VIDEO_UPLOAD_MIMES` / `LESSON_VIDEO_ACCEPT` / `validateVideoFile()` ↔ the tus
  `contentType` ↔ the bucket's `allowed_mime_types` — in BOTH video buckets since #69, which gave
  `onboarding-videos` the same list — ↔ `test/courseVideoSql.test.mjs` + `test/gettingStartedSql.test.mjs`.
  ★ **The client now sends the file's REAL content type.** It used to send a hardcoded
  `video/mp4` for everything, so a `.mov` would have passed the bucket check *by being
  mislabelled*. Passing by mislabelling is not a grant; it is a bug nobody has noticed yet.
  ★ **A REFUSED PICK MUST NOT SAVE SILENTLY.** `UNSUPPORTED_FILE` is deliberately **not** in the
  `UNFINISHED` set — that set also drives `hasUnfinishedUpload`, and adding it would relabel Save
  "Video not ready" on a lesson whose *existing* video is fine. But that left `blocksLessonSave`
  false beside the refusal, so an enabled blue **Save lesson** succeeded while changing nothing:
  drawer closed, lesson unchanged, still link-backed, still un-publishable, no error anywhere —
  which is indistinguishable from "the upload is broken". `saveLesson` now refuses with an
  explanation, and the refusal card carries a **Dismiss** (`RESET` → `EMPTY`) so the guard can
  never trap anyone. Pinned by `uiSafety` §19, mutation-tested. Dismiss and Remove each hand focus to
  the picker that replaces them (`refocusIfLost(inputRef)`), never to `<body>` (T9UI-9).
  ★ **A REFUSED PICK DISCARDS NOTHING.** `handlePick` used to open with `await discardPending()`,
  before `validateVideoFile` had looked at the new file: a refused "Replace video" deleted the
  verified upload the draft still named, and — because the guard above fires only when the draft
  names NO file — Save then wrote a lesson whose video was gone (reproduced in Chrome: the Learn view
  then read "could not be authorized"). The discard now runs once every check has passed — the
  replacement is ACCEPTED — still in `LOCAL_VALIDATING` (Save blocked, the picker disabled), and is
  followed by a mounted check, so an uploader closed meanwhile starts no transfer. A refusal leaves
  the previous upload, the draft's `storage_path` and the pending-path ref exactly as they were.
  Pinned by `uiSafety` (handlePick RUN against the real `validateVideoFile`), mutation-tested. …And
  an upload whose CHECK failed is swept at the next SAVE (AUI-1), never at the pick: it stays pending
  so "Check again" can still use it, and a draft never names it, so the save is the last moment
  anything knows the path. Pinned by `uiSafety` §19 (RES-1 twice) and §19/§28c (AUI-1),
  mutation-tested. See the RES-1 and AUI-1 bullets in the Course platform section.
  ★ **The legacy-link banner hides once `d.storage_path` is set.** During a replacement upload it
  kept insisting *"the course cannot be published until it is replaced"* directly above the
  uploader replacing it — two contradictory amber cards, and a large part of why the screen read
  as a wall.
  ★ **An ACKNOWLEDGED file must not be re-blocked after its upload finishes.** Relaxing the
  pick-time gate alone would be worse than useless: `verifyPrivateObject` runs
  `probeVideoMetadata` against the signed URL **in the same browser that just said it cannot
  decode this codec**, so an HEVC lesson would upload for twenty minutes and then be refused by
  `describeVerifyFailure`'s code-4 arm. `acknowledgedRef` therefore makes MediaError **3** and
  **4** — and only those two — non-fatal at that step. Presence, authorization, byte-completeness
  and a real `ftyp` box are still proven for every file by `confirmSignedObject`, which runs
  first and is never skipped; timeouts and network faults still fail as before. `READY_TO_SAVE`
  keeps its single inbound edge — what that edge proves is now conditional on a choice the admin
  made explicitly. Pinned by `uiSafety` §19, mutation-tested.
  ★ **Faststart is REPAIRED, not demanded** ([src/lib/mp4Faststart.js](src/lib/mp4Faststart.js),
  2026-09-07). With `moov` at the end of the file a player must reach the tail before it knows
  anything. Measured against this project's Storage on the 859 MB lesson: a cold 2 MiB tail range
  **49.4 s**, the same range warm 1.9 s, a range at the head 1.7 s cold. That is paid by the
  verification probe — by construction the first-ever read of a just-uploaded object, so always
  the cold case — and again by the first student to press play. `planFaststartRemux()` now moves
  the index to the front **in the browser, before the upload**, and the admin never sees it:
  measured on the real 5.8 MB reproduction file, **2.0 ms**, reading 5% of it.
  ★ **It is a BYTE MOVE, not a transcode, and that is what makes it safe.** Region A (`[ftyp,
  moov)`) shifts by `+moovSize`, region B does not move, every `stco`/`co64` is patched
  `o' = o < M ? o + S : o`, and the output size is **identical**. Proven end to end: ffmpeg
  decoded both the source and the output of the real file and the video and audio streams hash
  **byte-identical** (`d71890bd…` / `06f8377a…`). It **refuses rather than guesses** — 15 stable
  codes (`fragmented`, `encrypted`, `aux-offsets`, `external-media`, `item-offsets`,
  `chunk-table-missing`, `offset-out-of-range`, …), each falling back to the manual remedy.
  ★ **Three properties of the remux are load-bearing and each has a ratchet.**
  (1) `buildFaststartFile` is **synchronous** — `File.slice()` is a lazy by-reference view, and
  one `await part.arrayBuffer()` would turn a 1.45 GiB by-reference Blob into a heap allocation
  and kill the tab; a function with no `await` in it physically cannot do that. (2) It carries
  **`lastModified` from the source**, because the tus fingerprint is `…-${size}-${lastModified}`
  and `new File()` defaults it to `Date.now()` — letting it default silently disables
  resume-by-re-picking, which the close-confirm dialog explicitly promises works. (3)
  `tablesPatched === stblCount` is a **structural interlock**: a track we skipped keeps offsets
  into the old layout, which for the audio trak plays as noise while the video looks perfect,
  and **no probe anywhere would catch it**.
  ★ **`probeVideoFrame` is the only check that can see a bad remux, and it fails CLOSED on a
  MediaError but OPEN on a timeout.** `confirmSignedObject` compares sizes and a remux cannot
  change the size; the `ftyp` sniff still passes; `probeVideoMetadata` resolves on
  `loadedmetadata`, which parses `moov` and decodes **zero** samples — so a file whose every
  offset is wrong still reports the right duration, codec and dimensions. Seeking past the first
  chunk forces a real read at a patched offset. A decoder refusing the bytes is evidence; running
  out of patience seeking inside a 1.5 GB file on a slow external drive is not, and treating it
  as one would break the feature for exactly the files that need it most.
  Lockstep: `src/lib/mp4Faststart.js` ↔ `handlePick`'s remux branch ↔
  `test/mp4Faststart.test.mjs` ↔ `test/uiSafety.test.mjs` §19. **There is no SQL half** — a
  faststart remux has no server mirror, which is why it is its own module rather than more of
  the SQL-mirrored `courseVideo.js`.
  ★ **`describeVideoWeight()` is advisory and must stay that way.** Screen recordings here have
  come in at 30 Mbps (a 124 MB file holding 35 seconds) and one live lesson is 1.45 GiB, 72% of
  the whole ceiling. Above 8 Mbps the uploader says so, with the number — and uploads anyway.
  ★ **Verification proves three things separately, and a TIMEOUT MUST NEVER ADVISE
  RE-ENCODING.** `verifyPrivateObject` now does `signedUrlFor` → `confirmSignedObject` (a ranged
  read of the first 64 KiB: status, `content-range` total vs the bytes sent, and a real `ftyp`
  box, so a JSON error body can never pass as a video) → `probeVideoMetadata` at
  `LESSON_VIDEO_VERIFY_TIMEOUT_MS`. `READY_TO_SAVE` still has exactly ONE inbound edge; only
  what that edge proves has changed, and it is strictly more. The old code was
  `e.message === 'timeout' || e.code === 3 ? 'Re-export it as MP4 (H.264 + AAC)…'`, which
  collapsed a storage delay into a codec accusation — and tested code 3 (DECODE) but never
  code 4 (`SRC_NOT_SUPPORTED`), the code a real format rejection actually produces, so it could
  not detect the one case it named. `describeVerifyFailure()` is now the ONE place that copy
  lives; `test/uiSafety.test.mjs` §13 ratchets it and is mutation-tested.
  ★ **"Check again" reuses its signed URL** (`signedRef` + `signedUrlFor`). Storage sits behind
  a CDN keyed on the full URL, so re-signing per attempt is a fresh cache MISS every time —
  49.4 s cold, 1.9 s on the same URL, **52.1 s on a newly signed one**. That is why the retry
  button could never succeed however many times it was pressed. Pinned by `uiSafety` §14.
  ★ **And the one limit that is in NO SQL file.** Supabase enforces
  `min(bucket file_size_limit, PROJECT-WIDE fileSizeLimit)`. The project-wide value is
  storage-api configuration: it is not in any `db/*.sql`, not in `storage.buckets`, and
  **unreachable from SQL** — so no migration, no `test-db` suite and not `db:shadow:verify`
  could ever observe it. #44 set the bucket to 2 GiB and documented the project-wide step as
  MANUAL in three places; it was never performed, and on 2026-09-02 the project was still at
  the 50 MiB default **on Pro** (upgrading does not raise it), so every lesson video over
  50 MiB died at ~6 MiB — one TUS chunk — while the app blamed the admin's file. Moving
  together now: `LESSON_VIDEO_MAX_BYTES` ↔ the bucket literal — `course-videos` AND #69's
  `onboarding-videos`, which takes the same cap — ↔ **the project-wide limit**
  ↔ `scripts/storage-config.mjs` ↔ the storage section and the `#69` block of `scripts/audit-db.mjs`
  (both import the cap rather than retyping it) ↔ `test/courseVideoSql.test.mjs` +
  `test/gettingStartedSql.test.mjs`.

  ★ **The upload bearer is attached PER REQUEST via tus's `onBeforeRequest`, and nowhere
  else.** Raising the ceiling to 2 GiB made hour-long transfers possible, so a 1-hour access
  token can now expire mid-upload. It must NOT also be declared in `options.headers`:
  `XMLHttpRequest.setRequestHeader()` **combines** repeated header names, and `headers` is
  applied before `onBeforeRequest` runs, so declaring both sends
  `Bearer <stale>, Bearer <fresh>` and Storage 401s every request. `test/uiSafety.test.mjs`
  pins its absence, because no unit test can reach it.

  ★ **A 413 mid-transfer is `storage-limit`, is NOT retryable, and is never the admin's
  file.** `validateVideoFile()` already refused an oversize file before a byte was sent, so
  a transfer-time 413 can only mean the server ceiling is lower than the one we enforce. The
  message must never quote a limit the client cannot know — Supabase's 413 body carries no
  number — and the UI must not offer Resume, which re-sends the identical request.
- **Changing which lesson video a draft names** → `notePendingVideoPath`'s revert ↔
  `savedLessonVideoRef` ↔ `prefilledLabelRef` / `applyVideoPatch`'s pre-fill ↔ `saveLesson`'s existence
  check (`lessonVideoInStorage()`) and its leftover sweep ↔ `uiSafety` §19 (RES-1, V-RES1-GUARD,
  V-RES1-LABEL, AUI-1). ★ A null from the uploader with nothing pending is not a discard
  (`if (path || !dropped) return;`), and the revert puts back what the SAVED row holds — never a guess.
  The Getting Started drawer's `notePendingPath` is the same idiom (T9V-L4); keep the two in step.
- **Changing what the Portfolio Generator may emit** → the rules live in ONE pure module and are
  mirrored in the stylesheet. Move together: `src/lib/portfolioGenerator.js` ↔
  `src/data/portfolio-generator.js` (the 9 themes, whose hexes the contrast floors are computed
  from, and the example draft the honesty guard is measured against) ↔ the `.pf-tool` block in
  `src/index.css` (the `@container` threshold, the editor track, `align-items:start`) ↔ the
  `PortfolioGeneratorInner` component and its 7 wiring sites in `src/BookkeeperPro.jsx` ↔
  `test/portfolioGenerator.test.mjs`. There is **no SQL half** — nothing about this tool touches
  Supabase, which is why it is not on the migration list.
  ★ **CONTRAST IS DERIVED, NOT HAND-TUNED, AND THE PAIR YOU MEASURE IS THE WHOLE ANSWER.**
  `themeCssVars` emits three computed tokens — `--glow-on-panel`, `--focus-ring`, `--tlab-before`
  / `--tlab-after` — each chosen by `pickReadable()` as the first candidate clearing its WCAG
  floor against the surface a reader actually sees. `mixHex()` exists because several surfaces are
  a tint over a tint over the page (`.tside.after` is `rgba(accent,.14)` over `--glass` over
  `--pg2`), so a ratio taken against `--accent` or `--pg2` alone is not the ratio anyone gets:
  measuring the wrong pair is how eleven of eighteen Before/After label pairs sat below 4.5:1
  while looking checked, and how the one light theme shipped a 1.80:1 focus ring. Adding a theme
  requires no colour tuning, but `redblack`'s accent is pinned at `#d93333` (not `#e23b3b`)
  because its `on` is white and 4.27:1 fails AA on the CTA. The 12-pair × 9-theme audit in
  `test/portfolioGenerator.test.mjs` is the guard; it reads the tokens the sheet actually emits.
  ★ **`safeLinkHref()` IS THE ONLY AUTHORITY FOR ANY href THE GENERATED FILE CONTAINS**, and the
  file is one the student HOSTS. The artifact's `esc()` escaped `& < > "` and not `:`, so a CTA of
  `javascript:alert(1)` landed verbatim in four hrefs — the nav button, the hero button, every
  package card and the contact panel. Never validate a scheme with a regex on the raw string:
  WHATWG strips tab/LF/CR *before* parsing, so `"java\nscript:alert(1)"` parses as `javascript:`
  and sails through `/^javascript:/`. Never pass a base to `new URL()`. `mailtoHref`/`telHref`
  **synthesise** and never accept a raw value — the mailto threat is mail-header injection
  (`?bcc=`), which escaping cannot see.
  ★ **ONE EXPORT GATE, TWO FORMATS, AND IT REFUSES BEFORE IT BUILDS.** `validateDraft` used to
  block on `fullName` alone — and `fullName` is PREFILLED from the profile, so an untouched draft
  downloaded an empty portfolio with no dialog at all. The five requirements (name, professional
  title, headline, ≥1 service with a NAME, ≥1 WORKING contact method — a valid email, a dialable
  phone, an https website or an https booking link) live in ONE registry,
  `PORTFOLIO_EXPORT_REQUIREMENTS`, which `validateDraft`, `portfolioExportReadiness` and
  `draftCompletion`'s contact row all read, so the editor, the dialog and the meter cannot disagree.
  `portfolioExportReadiness` returns `empty | blocked | warning | ready`: `empty` means nothing
  authored beyond defaults and the prefilled name (NOT `draftHasContent`, which still answers "was
  the form touched?" for the résumé prompt and the autosave); `warning` is stale example content or a
  filled-in link that will be dropped and needs an explicit acknowledgement; optional gaps are
  `notes` and never block. Both formats call `planPortfolioExport`, which returns no `html`,
  `fileName` or `mimeType` at all when refused — so "a blocked draft cannot produce a file" is a
  fact about a pure function. The component re-plans at the moment a format is chosen, and the
  blocked dialog has **no download action**. Never reintroduce "Download anyway".
  ★ **THE PDF IS A SEPARATE `mode: 'pdf'` DOCUMENT CAPTURED IN ITS OWN FRAME — NEVER THE PREVIEW.**
  `renderPortfolioPdf` (module scope, above `PfField`, so `componentBody` cannot swallow it) builds
  an off-screen iframe with `sandbox="allow-same-origin"` and **never** `allow-scripts`:
  html2canvas must read its DOM, and the document is escaped, carries `script-src 'none'` and emits
  no `<script>`. The preview is the inverse (`allow-scripts`, never `allow-same-origin`). **The
  dangerous combination is both flags on one frame; neither frame may ever have it.** The PDF
  document forces every `.reveal` visible, prints metrics at their final value
  (`formatMetricValue`), prints all three sample statements instead of tabs, prints link
  destinations, and marks `data-pdf-block` / `data-pdf-keep` / `data-pdf-link` — all PDF-only, so
  preview and download bytes are unchanged. `PDF_CSS` answers html2canvas 1.4.1 limits that were
  MEASURED in a browser spike, not assumed: no `backdrop-filter`/`filter`, blurred `box-shadow`
  painted as a solid notch-cornered frame, flex text-centering and flex `gap` unreliable; and it
  zeroes `min-height`, without which `body{min-height:100vh}` reports the capture frame's own height
  as the content height. Every html2canvas call, the frame load and the jspdf/html2canvas download
  race `withPdfTimeout`, because html2canvas waits on a child iframe's onload with no timeout of its
  own and the dialog cannot be closed while an export runs. ★ **html2canvas measures font baselines
  in the GLOBAL `document`, not the one it captures** (`new FontMetrics(document)`), and this app's
  Tailwind preflight makes that probe `<img>` `display:block` — so every glyph was drawn low (25px
  instead of 18px at 16px, 76 instead of 57 at 52px), clipping pain-card text and tool labels.
  `PF_H2C_METRICS_FIX_CSS` restores the probe to `inline` for one export and is removed in
  `finally`. The Training Agreement and certificate PDFs capture in this document too and have the
  same offset; their "flex text-centering" comments are most likely this bug. `planPdfPages` cuts on
  forbidden intervals (blocks, heading groups kept with the next block, every text line box), sees
  the REAL height, and a portfolio over `PF_PDF_MAX_PAGES` is refused — never silently cut off. Page
  geometry is derived (`PF_PDF_PAGE_PX` = the A4 content band after 2 × 28pt, i.e. 1048px, not
  1123). One canvas per page, released before the next.
  ★ **THE PREVIEW IFRAME IS `sandbox="allow-scripts"` AND NOTHING ELSE.** A `srcdoc` document
  normally INHERITS its embedder's origin, which is exactly how the artifact's preview could read
  the app's `localStorage` — where the Supabase session lives. `allow-same-origin` is the only
  thing that clears the sandboxed-origin flag, so it is never present; nor is
  `allow-top-navigation`. A source scan asserts the flag list is EXACTLY `['allow-scripts']`.
  Note a srcdoc document also inherits its embedder's **CSP**: the app ships none today, so if one
  is ever added to `vercel.json` the preview inherits it and that is the first place to look.
  ★ **The CSP in the generated file DIFFERS BY MODE, on purpose.** `default-src 'none'` is right
  for a preview of content we just escaped and actively hostile in a file the bookkeeper owns and
  will edit — the moment they add a Google Font, host their headshot, or paste a Calendly embed,
  everything fails silently with no error a non-developer can read. The download policy allows
  `https:` images, fonts and styles and keeps `connect-src 'none'`.
  ★ **A photo is RE-ENCODED through a canvas, never stored as picked.** That strips the EXIF block
  — which carries GPS coordinates on almost every phone photo, i.e. a home address, on a page the
  student publishes — caps the bytes so the draft fits the storage quota, and forces JPEG output.
  SVG is refused explicitly: it carries script and the preview frame runs scripts.
  ★ **`window.storage.set` RESOLVES `false` on a quota error and never rejects** (`src/main.jsx`),
  so the autosave checks the resolved value, retries without the photo, and says so. A bare
  `.catch()` would report a silent success and the student would lose the draft on reload having
  been told it saved.
  ★ **The example draft is never the initial draft.** The artifact loaded its sample on mount, so
  every new user's first view was somebody else's name over invented testimonials. The editor
  starts empty and the autosave is gated on a `seedRef` comparison — the draft must differ from
  what the tool itself put on screen, and the seed is **re-stamped on every successful write**, so
  the gate means "differs from storage". Two earlier gates were both wrong and both were caught in
  the browser: `draftCompletion(d).pct > 0` never blocked anything (an untouched draft scores 8%,
  because `showSamples` defaults on), and `draftHasContent(d)` fired on a bare VISIT, because the
  prefilled `profile.full_name` is content — so merely opening the tab left a storage row in every
  user's browser. Re-stamping is the third fix: without it the seed stayed the MOUNT-time value,
  so reverting an edit was gated out while the last dirty value stayed on disk under a "Saved"
  indicator. `sampleFieldsStillPresent()` **names every field still holding example text** in the
  download dialog — a banner at the top of a form is not read at download time. It derives the
  checked set from the sample by EXCLUDING known shared defaults, rather than from a hand-typed
  include list that omitted `email`, `phone`, `website` and `credentials`; and it compares a list
  **per item**, because editing one of two testimonials used to drop the whole field off the
  warning while the other invented quote still shipped.
  ★ **`financialSampleRows()` returns ROWS, NOT MARKUP**, and that is what caught the artifact's
  cash-flow statement not tying out: its operating components summed to 96,200 against a printed
  96,800, under a footnote calling the figures "internally consistent", for an audience of
  accountants. Depreciation is 13,200 here — the fix had to be a COMPONENT because ending cash
  86,300 correctly ties to balance-sheet cash. Every subtotal and both cross-statement links are
  asserted.
- **Changing who may READ a lesson video object** → `course_video_object_readable()` ↔ the
  `course_videos_read` policy ↔ `courses_read` (it MIRRORS it — drift is a security bug) ↔ the
  two #27 trainer mirrors ↔ `PLAN_ENTITLEMENTS` ↔ `planScopeAllows()`. Note `db:shadow:verify`
  **cannot see this**: it snapshots `pg_policies` filtered to `schemaname='public'`, so storage
  policies are never captured, and even for public ones it compares only tablename/policyname/cmd,
  never `qual`. `db:audit`'s `pg_policies … qual ilike` checks are the only automated guard.
- **Changing what a lesson replay link may be** → three places move together: the
  `course_lessons.zoom_replay_url` **COMMENT** (in both `db/2026-08-05-lesson-zoom-replay.sql` and the
  bootstrap) ↔ `parseReplayUrl()` / `ZOOM_HOST_SUFFIXES` in `src/lib/lessonReplay.js` ↔
  `LessonReplayLink` + the lesson-editor field in BookkeeperPro.jsx (pinned by
  `test/lessonReplay.test.mjs`). The column has **no CHECK by design** — the client module is the only
  enforcement point, so a rule loosened there is loosened everywhere.
- **Adding a column to the lesson model** → it must be added to **all** of: `COURSE_LESSON_SELECT`,
  `lessonComparable()` (or the dirty check silently ignores it), `saveLesson()`'s `payload`, the lesson
  editor UI, and `CourseCatalog.duplicateCourse()`'s lesson `.map()`. Each is an explicit allow-list;
  missing one fails silently rather than loudly. ★ And it needs **its own select tier**, never a line
  added to `COURSE_LESSON_SELECT_LEGACY` — that constant is a frozen pre-#37b snapshot, and making
  the two lists identical means the narrow-and-retry re-fails and the whole fallback silently stops
  working. The chain is now three deep: full → `COURSE_LESSON_SELECT_PRE_RICH` (#65) → legacy.
  ★ And it will appear in the **student preview** for free, because the preview renders the same
  `LessonCard` the learner page does — but only if it reaches `liveLessonDraft()`'s output. A column
  the editor holds in some other state is invisible there.
- **Changing what a STUDENT sees on a lesson page** → there is exactly ONE renderer, and the whole
  point is that it stays one: `LessonCard` / `LessonStage` (module scope, after `LessonReplayLink`)
  ↔ the learner page's render ↔ `renderLessonPreviewBody()` ↔ `test/uiSafety.test.mjs` §25. A
  preview that drifts from the real student view is worse than no preview, because the creator has
  started trusting it — so never add a second render site, and never let the preview pass anything
  but a literal `adminView={false}`, `done={false}` and `INERT_LESSON_ACTIONS`. **There is no SQL
  half**: the preview renders a draft the creator already holds, through signing paths that already
  work for them, so nothing about storage, RLS or entitlements changes.
  ★ **The width cap (`LESSON_PREVIEW_MAX_W`) is a MEASUREMENT, not a taste call** — re-measure the
  live learner page before changing it, and keep it at or below the narrowest common desktop
  student width. See the "Student preview" bullet in the Course platform section for the numbers
  and for why erring narrow is the safe direction.
  ★ **Never make the preview a second overlay**, and never unmount the editor body to show it —
  both were tried, both failed in the browser (Escape dismissed the lesson editor; Ctrl+Z stopped
  undoing). Same bullet has the detail.
- **Changing what a lesson's INSTRUCTIONS may contain** → the rules live in ONE pure module and are
  mirrored in SQL. Move together: [src/lib/lessonContent.js](src/lib/lessonContent.js) ↔
  `course_lesson_sync_assets()` / `course_lesson_asset_readable()` / `course_lesson_asset_course_id()`
  in `db/2026-09-20-course-lesson-assets.sql` **and its bootstrap fold §52** ↔ the
  `course-lesson-assets` bucket's `file_size_limit` / `allowed_mime_types` ↔ `LessonRichText` +
  `renderLessonComposer` in BookkeeperPro.jsx ↔ `test/lessonContent.test.mjs` +
  `test/lessonContentSql.test.mjs` + `test-db/courseLessonAssets.dbtest.mjs` ↔ the `#65` block in
  `scripts/audit-db.mjs`.
  ★ **AND SINCE THE CANVAS, THREE MORE MOVE WITH THEM:**
  [src/lib/lessonDocument.js](src/lib/lessonDocument.js) (both directions, plus the matching
  normalization — see its entry above) ↔ the schema in
  [src/editor/LessonDocumentEditor.jsx](src/editor/LessonDocumentEditor.jsx)
  (`LESSON_DOC_NODES` / `LESSON_DOC_MARKS` are the allowlist the schema is built from) ↔
  `test/lessonDocument.test.mjs` + `test/uiSafety.test.mjs` §23–§24.
  ★ **A TOOLBAR CONTROL THAT CANNOT SURVIVE A SAVE MUST NOT EXIST.** Adding italic — or any other
  mark — means changing SIX things together: the closed parser, `lessonDocument.js`'s converter,
  the student renderer, `lessonContentToPlainText`, `validateLessonContent`, and the tests. Until
  all six know about it, the button would write something the next save silently deletes.
  ★ **UNDO/REDO ARE `aria-disabled`, NEVER `disabled`** (`softDisabled` on `ToolButton`). A browser
  blurs a focused element the instant it becomes disabled, so pressing Redo until the stack emptied
  dropped focus to `<body>` — inside an `aria-modal` dialog, where `SidePanel`'s Tab trap cannot
  recover it (it only acts when the active element is first, last or the panel), so Tab then walked
  the page behind the scrim. Verbatim the sidebar Move up/Move down defect. Real `disabled` stays
  correct for the whole-toolbar case, which is driven by a save rather than by the button under the
  user's finger. `aria-disabled` needs its own CSS — `:disabled` no longer matches these two.
  ★ **A HARD BREAK INSIDE A LIST ITEM BECOMES A SPACE, NEVER NOTHING** (`flattenBreaksToSpaces`, at
  both the parse and serialize sites). An item is ONE line in the stored grammar, so the break cannot
  survive — but dropping it GLUED TWO WORDS TOGETHER: Shift+Enter is an ordinary gesture (HardBreak
  binds it, ListItem does not override it), the canvas kept showing two lines because normalization
  happens at serialize time, and the student read *"open the formthen bold word"*. The round-trip net
  is structurally blind to it — it compares against the already-normalized model, so both sides
  agreed on the corrupted text. Found in code review and reproduced on the live converter.
  ★ **THE EDITOR SCHEMA IS NOT DERIVED FROM `LESSON_DOC_NODES`/`LESSON_DOC_MARKS`** — the docblock
  used to say it was, and nothing performed it. They are two independent allowlists (ProseMirror's
  schema, and this converter ignoring what it does not recognise), which is safe only while they
  agree, so `uiSafety` §24 now checks each name against the extension that declares it in BOTH
  directions. A comment that claims an enforcement nobody performs is the failure this file keeps
  recording; this is the third instance in one change.
  ★ **THE PLAIN FIELD STAYS FOR TWO CASES, AND BOTH ARE LOAD-BEARING.** A database without #65
  (`preRich`) and legacy prose that has not been converted (`needsFormatOptIn`, which reads the
  SAVED row) never open in the canvas — the canvas serializes to markdown, so touching a key in one
  would escape its metacharacters and flip `content_format`, converting a lesson by looking at it.
  `usesCanvas = !preRich && !needsFormatOptIn` is where that is decided.
  ★ **NO FUNCTION IN THAT MODULE MAY DEFAULT ITS `format` PARAMETER, and the scar is recent.**
  Five exports were written `format = 'markdown'`. A JS default fires on `undefined`, which is
  exactly what a row carries when the column is absent — on a database without #65, and on a lesson
  `addLesson` just seeded from the frozen `COURSE_LESSON_SELECT_LEGACY`. So the two places that
  decide whether a lesson may be SAVED and what the AI trainer INDEXES read a plain note as
  markdown: a legacy `[see here](http://old-site.com)` became an `UNSAFE_LINK` that **blocked the
  save** on a database where the feature does not exist, and every lesson on a pre-#65 database
  re-hashed and re-embedded for nothing. Passing no format now means `plain` — the format that
  predates the feature and can refuse nothing — because all five already route through
  `normalizeFormat()`. `api/admin/course-trainer.js` additionally **stamps** `content_format:
  'plain'` onto the rows its narrowed select returns, so the assumption is written where it is true
  rather than inherited from a default. Pinned by `test/lessonContent.test.mjs`.
  ★ **AN ASSET SCHEME THAT IS NOT A READABLE TOKEN MUST BLOCK THE SAVE.** Everything
  `validateLessonContent` knows about images comes from the token pattern, so a
  `lesson-asset://<uuid>` that pattern cannot read was invisible to it — and one `]` in the alt
  text is enough (`![Screenshot [1]](lesson-asset://…)`), as is half a hand-deleted token. The
  document then saved clean and **three** things happened at once, none of them visible: the raw
  markdown was published verbatim to every student; the post-save sweep saw the asset as uncited
  and deleted its row **and its bytes**, because `course_lesson_asset_delete` cannot answer
  `LESSON_ASSET_IN_USE` when the trigger derived no reference from an unreadable token; and
  `lessonContentToPlainText` passed the string through untouched, putting the scheme and the uuid
  into the AI trainer's index — the one thing this module promises never to do. The guard is a
  count: every readable token carries the scheme exactly once, so more scheme occurrences than
  `lessonAssetRefs()` entries means at least one is stranded (`BROKEN_IMAGE_REFERENCE`).
  ★ **THE ORPHAN SWEEP MEASURES "CITED" AGAINST THE TEXT THAT SURVIVES.** `closeLessonEditor`
  passes the **saved** row's text, not the draft it is discarding. Reading the draft meant an
  image the creator had placed counted as cited and was skipped — while the draft citing it was
  thrown away and the lesson was never saved, so no reference row existed either, leaving the
  bytes in the private bucket until some later save in that course ran the 1-day pass.
  ★ **A CAPTION IS A SEPARATE LINE, AND THAT IS WHY IT NEEDED NO MIGRATION.** `^ text` directly
  under an image token renders as the figure's `<figcaption>`; the Postgres trigger only matches
  `![alt](lesson-asset://<uuid>)`, so it never sees the caption and the token keeps exactly one
  possible reading. Putting the caption INSIDE the token would mean editing a regex in SQL that is
  already applied to production, and would leave the two parsers one wording change away from
  disagreeing about where a token ends. Alt text stays REQUIRED and separate — it is what a screen
  reader announces and what shows when the image will not load; a caption is visible prose, and
  using one as the other makes a screen reader read the same sentence twice. A caption attaches only
  to an image, only one per image, and may not contain an image token; anything else stays the
  literal text the creator typed. `test/lessonContentSql.test.mjs` runs the DATABASE'S OWN pattern
  over a captioned document and asserts it still finds exactly one token.
  ★ **A caption belongs to the image ABOVE it, and one line of prose breaks that pairing.**
  A paragraph that mixes ordinary sentences with image rows renders the images inline and the
  `^` lines as the literal text the creator typed, rather than as figures. That is the direct
  cost of the line-based design, and it is the right trade: the alternative — a caption inside
  the token — buys tidier mixed paragraphs by putting the SQL regex and the JS parser one
  wording change away from disagreeing about where a token ends, which is silent in both
  directions. The fallback is visible on the page and undone by moving the prose to its own
  paragraph, so nobody loses work; a wrong token boundary is an image that renders but cannot
  load, or one that is readable and invisible.
  ★ **A LESSON LINK NAMES ITS DESTINATION OUT LOUD, NOT ON SCREEN** (owner decision,
  2026-09-24). `LessonRichText` used to append the host in grey parentheses to any external
  link whose visible words did not already contain it, plus an `ExternalLink` arrow —
  `here (us06web.zoom.us) ↗` — so an opaque label could not quietly point at a lookalike
  domain. The guard was right and its PRICE was wrong: the shape it stops needs someone who
  can WRITE `course_lessons`, which is course staff and never a student or a community
  member, while the clutter was paid by every honest link in every lesson, which is what the
  owner reported. The **same condition** now chooses the `aria-label` instead, so exactly the
  links that showed a chip announce one and no others gain verbosity; the hover `title` is
  unchanged. Nothing was lost — the host was only ever spoken because that grey span happened
  to sit inside the `<a>`. ★ **The visible words come FIRST in that label**: an `aria-label`
  REPLACES the link text as the accessible name, so one not leading with what is on screen
  breaks WCAG 2.5.3 Label in Name — a speech-input user saying "click here" would stop
  matching the link reading "here". ★ **A link with NO visible words needs the label most, not
  least**, and a first attempt here got that backwards. `[](url)` and `[   ](url)` both parse to
  a real link, and the grey chip was incidentally the only thing NAMING them — so skipping the
  label when there were no words left an unlabelled link, a WCAG 4.1.2 failure the chip version
  did not have. The empty case takes a host-only label (`Opens <host> in a new tab`) instead, so
  the condition is byte-for-byte the one the chip used. It skipped them to stop a label
  overriding an image-only link's alt text, and **that case cannot occur**: `linkAt` scans for
  the first `]`, so `[![alt](lesson-asset://…)](https://…)` parses as a link whose href is a
  refused scheme and comes back a **badlink** — a lesson link cannot contain an image, pinned by
  `test/lessonContent.test.mjs` so the day that changes this branch is revisited rather than
  silently eating an alt. ★ **`LessonReplayLink` deliberately KEEPS its visible host**: it is a labelled card,
  not inline prose, and its subtitle is the one place a student learns where a replay lives.
  Do not reinstate the inline chip "for safety"; `uiSafety` §25 pins its absence and every
  guard there is mutation-tested.
  ★ **A BARE URL PROJECTS AS ITS HOST IN THE TRAINER INDEX, AND THAT IS DELIBERATE.**
  `lessonContentToPlainText` emits a labelled link's LABEL and a bare link's HOST, because the
  agent is speaking, not clicking, and reading ninety characters of query string aloud is noise.
  Turning formatting on therefore does shorten a bare URL in what the trainer indexes — the URL
  itself is untouched in `text_content`, still rendered and still clickable for the student. Do
  not "fix" this by projecting the full URL; if a specific address must be speakable, write it as
  a labelled link whose label says it.
  ★ **CLOSING A COMPOSER CONTROL WITHOUT EDITING MUST HAND FOCUS BACK** (`returnFocusToLessonBody`).
  Escape, the link bar's Cancel, and an image card's Remove each unmount the element that HAS
  focus, and a browser then moves focus to `<body>` — a keyboard user is dropped at the top of
  the document with the drawer still open (WCAG 2.4.3). The EDIT paths never needed this: Update
  and Unlink end in `applyLessonEdit`, which already focuses the textarea. The restore is on a
  `requestAnimationFrame` because the unmount happens in the same commit, so focusing before it
  lands is undone by React. Pinned by `uiSafety`, mutation-tested.
  ★ **A REMOTE IMAGE IS REFUSED; THE PROSE AROUND IT IS NOT.** Copying a paragraph out of a web
  page brings any inline image with it, and `preventDefault()` alone discarded the WHOLE paste —
  which reads as "pasting is broken", and was reported that way. `onLessonPaste` now inserts the
  `text/plain` flavour at the caret and says which of the two things happened. This introduces
  nothing new to validate: it is what the browser would have done for a text-only paste, and the
  save-time check still runs over the finished document.
  ★ **THERE IS NO MARKDOWN LIBRARY, AND THAT IS THE SECURITY ARGUMENT, NOT A PREFERENCE.** A general
  parser is safe only while it stays correctly configured — raw HTML off, a URL transform installed,
  a component map that never falls through to `innerHTML`. This module has no HTML to enable: it
  emits a CLOSED set of typed tokens and the renderer turns those into React elements, so unsafe
  markup is unrepresentable rather than filtered. Adding a library would move the guarantee from
  "cannot" to "is configured not to".
  ★ **TWO PARSERS READ THE SAME TOKEN AND MUST AGREE.** `LESSON_ASSET_TOKEN_SRC` decides what a
  student SEES; the Postgres regex in `course_lesson_sync_assets()` decides which images are
  AUTHORIZED. A disagreement about where a token ends is silent in both directions — an image that
  renders but cannot load, or one that is readable and invisible. `sanitizeAltText` strips `]` for
  exactly this reason, and `test/lessonContentSql.test.mjs` pins the two patterns against each other.
  ★ **REFERENCES ARE DERIVED BY A TRIGGER, NEVER SENT BY THE CLIENT.** Staff can write
  `course_lessons` directly through PostgREST (`lessons_staff_write`), so a client-supplied image
  list would be a client-chosen authorization list. The trigger re-extracts the tokens from the
  SAVED text in the same transaction — which is also why course duplication needs no special case:
  it inserts lesson rows carrying the copied text and the trigger re-derives the copy's references
  from them. `courses.source_course_id` must therefore be written BEFORE the lessons are inserted,
  which `duplicateCourse` step 3 already does, two inserts ahead.
  ★ **READS ARE REFERENCE-BASED; WRITES ARE PATH-PARSED. That inversion is deliberate.** #44 deleted
  `course_object_allowed()` because it parsed a READ out of an object name and failed OPEN three
  ways. A WRITE names an object that does not exist yet, so there is no reference to consult —
  `course_lesson_asset_course_id()` is a NEW parser that returns NULL for anything but
  `lessons/<uuid>/<uuid>/<file>`, and `can_manage_course(NULL)` is false, so a malformed path
  DENIES. Do not loosen `course_object_course_id()`, which owns the three-segment video shape.
  ★ **AN ASSET OUTLIVES ITS ORIGIN COURSE** (`course_id ON DELETE SET NULL`). Cascading would delete
  the row out from under a DUPLICATE that legitimately shows the same image: its pictures would
  vanish and its next save would be refused as citing an image that does not exist. This is the
  same promise `removeMediaIfUnreferenced` makes for video, kept by a different mechanism.
  ★ **A REMOTE IMAGE IS REFUSED, NEVER HOT-LINKED.** Pasting from a web page puts both a file and an
  HTML fragment on the clipboard; taking the HTML would load a third party's server from every
  student's lesson page, handing it each student's IP and reading time.
  ★ **`lessonContentToPlainText()` IS THE ONLY THING KEEPING MARKUP OUT OF THE VOICE AGENT.**
  `api/admin/course-trainer.js` used to index `text_content` with nothing but a `trim()`, and the
  retrieval path copies chunk content byte-for-byte into the agent's envelope. Flatten at that one
  ingest point or the agent narrates punctuation. A `plain` lesson is returned unchanged, so its
  hash does not move and it is not needlessly re-indexed — and `course_ai_mark_lesson_stale()` was
  patched in place (the #56 instrument) to watch `content_format`, because otherwise a lesson
  converted to markdown without editing its words would sit `ready` for ever.
- **Changing the Enrollments request card's layout** → four places move together: the "ENROLLMENT
  REQUEST CARD" block in `src/index.css` (the `.enroll-card` container and its 420/760px thresholds)
  ↔ the card JSX in `AdminEnrollments` (its `data-enroll-region` hooks) ↔ `test/uiSafety.test.mjs` §26
  (shape) ↔ `test-e2e/enrollmentLayout.e2etest.mjs` + `test-e2e/_enrollmentProbe.mjs` (measured
  geometry). Run `npm run test:e2e` before calling a layout change done — §26 alone cannot see a 0px
  column, which is how this shipped.
- **Deciding a request, or reopening one** → a decided request is final for everyone but a Super
  Admin (#66). Moving together: `enrollment_decision_lock()` ↔ `admin_finalize_enrollment()`'s
  pending-only rule ↔ `doDecline`'s `.eq('status','pending_review')` ↔ the `decision_reopened` timeline
  label ↔ `test/enrollmentDecisionLockSql.test.mjs` + `test-db/enrollmentDecisionLock.dbtest.mjs`.
  ★ Never "fix" a stuck request by adding a client path that PATCHes a decided row back to pending —
  that path IS the hole #66 closed.
- **Changing how a legacy student is staged or activated** → the rules live in ONE pure module and
  are mirrored in SQL (#67). Moving together: `src/lib/legacyMigration.js` (date formats, the Manila
  term, the record-key input, the state vocabularies, `MAX_ACTIVATION_RUN`, `STALE_CLAIM_MINUTES`) ↔
  `legacy_import_stage()` / `legacy_import_term()` / `legacy_import_record_key()` /
  `legacy_import_activate_row()` and the row CHECKs in `db/2026-09-25-legacy-student-migration.sql`
  **and its fold §54** ↔ `api/admin/student-imports.js` ↔ the `StudentImports` workspace ↔
  `test/legacyMigration.test.mjs` + `test/legacyMigrationSql.test.mjs` +
  `test-db/legacyMigration.dbtest.mjs` ↔ the `#67` block in `scripts/audit-db.mjs`. The migration is
  ASSEMBLED by a script that lifts `grant_batch_run` (#39), the access-request trio (#50/#51), the
  staff seed (#62) and the catalog (#65) verbatim and edits them at anchors; the suite line-diffs
  every one. ★ A future restatement of any of those copies #67's body, not the older one.
  ★ `STALE_CLAIM_MINUTES` must stay longer than the endpoint's `maxDuration` in `vercel.json` (pinned).
  ★ Since #68 there are two more SQL↔JS pairs that must move together: `legacy_import_plan_rank()` ↔
  `planRank()` (which of two rosters wins), and `legacy_import_seat_count()` ↔ `legacySeatCount()`
  (cohort seats from the paid term). A plan is VIP when its `community_segment = 'vip'` — never
  test the key, and never let a batch rule run for a non-VIP row.
  ★ Never let the browser write an import table again, and never give `students.legacy_migrate` to a
  non-super role: activating a legacy student creates paid access with no payment behind it here.
- **Adding a subscription status, or a new check on whether a term is live** → every access
  predicate must require `status = 'active'` (#67). That single fact is what makes a `scheduled`
  term grant nothing without restating a function; `test/legacyMigrationSql.test.mjs` scans the
  latest definition of every function and fails on a liveness check by dates alone. The client
  mirror is `subAccess()` / `enrollGateState()` in `src/lib/enrollGate.js` (`scheduled` is checked
  BEFORE `is_paid`) ↔ `resolveGateScreen()`'s `MEMBERSHIP_SCHEDULED` arm (NOT a pricing screen) ↔
  `test/enrollGate.test.mjs` + `test/gateMatrix.test.mjs`.
- **Changing the migrated-student claim link** → `buildClaimUrl()`/`parseClaimHash()` in
  `src/lib/importClaim.js` ↔ `api/admin/student-imports.js` (mints `magiclink`, `hashed_token` only)
  ↔ `readImportClaimFromUrl()` + `ImportClaimScreen` in the monolith ↔ `test/importClaim.test.mjs` +
  `test/tokenLeakage.test.mjs`. `CLAIM_LINK_TTL_HOURS` mirrors the same Supabase `mailer_otp_exp`
  setting as `INVITE_LINK_TTL_HOURS`; the test pins them equal.
- **Adding an error code** → `app_error_catalog()` ↔ `APP_ERROR_CODES` **and `APP_ERROR_COPY`** in
  `src/lib/appErrors.js`. Clients branch on `error.hint`, never on the HTTP status.
- **Changing when a batch locks, or what an admin may edit on it** → four places move together:
  `batch_is_past()` ↔ `batches_guard()` ↔ `admin_update_batch()`'s validation chain ↔
  `isPastBatch()`/`validateBatchEdit()` in `src/lib/batchLifecycle.js`
  (`test/batchLifecycle.test.mjs` + `test-db/batchLifecycle.dbtest.mjs` pin both halves). If a new
  editable column is added, it also needs a `grant update (…)` in #38's column-privilege block —
  otherwise the write silently 42501s for every admin.
- **Changing the staff INVITATION flow** → the link format is one module and both sides import it:
  `buildInviteUrl()`/`parseInviteHash()` in [src/lib/staffInvite.js](src/lib/staffInvite.js) ↔
  `api/_lib/staffInviteEmail.js` (server) ↔ the `StaffInvitationSetup` callback in
  BookkeeperPro.jsx (browser) ↔ `test/staffInvite.test.mjs`, which round-trips build → parse. A
  format change that breaks the callback fails there rather than in someone's inbox. ★ Never edit
  the Supabase dashboard's "Invite user" template — nothing has read it since #49. ★
  `INVITE_LINK_TTL_HOURS` is a hand-kept mirror of `mailer_otp_exp`; the test pins it so drift
  cannot be silent.
- **Computing the root `entitlement`** → it may NOT key off `enroll.active`. That was correct only
  while the sole accounts with `active:false` were admins; #49 makes it false for **every active
  staff member**, and the old `enroll.active ? planEntitlement(…) : FULL_ENTITLEMENT` therefore
  handed a Trainer FULL — which `staffEntitlement()` returns unchanged, silently turning the union
  into a replacement. The rule the union exists to enforce is that bypassing the paywall is NOT the
  same as buying the toolkit: staff who also hold a valid term keep their plan's tabs, staff who do
  not get their role's tools and nothing else (a `null` base means "grants nothing" — for every
  role EXCEPT super_admin, who resolves FULL because `profiles.is_admin` already means exactly
  that). ★ And whatever it computes must be **non-nullish**: it is dereferenced unguarded at two
  sites and handed to `EntitlementContext.Provider` as an EXPLICIT value, which **overrides**
  `createContext(FULL_ENTITLEMENT)` for all four consumers rather than falling back to it — so a
  null there is a blank white page, not a degraded render. See the entitlement bullet in
  "Plan-based access". `test/staffInvite.test.mjs` + `test/staffRoles.test.mjs` +
  `test/uiSafety.test.mjs` §15 pin it.
- **Changing what the chokepoint renders for a refused or undecided tab** → `tabAccessView()` ↔
  `TabAccessCheck` / `RestrictedTab`'s `reason` ↔ `adminTabVisible()` + `staffEntitlement()` (both answer
  an admin tab from `staffCan`, so an admin tab a role lacks is refused by both, and reads as `'role'`,
  never `'plan'`) ↔ `uiSafety` §T12B ↔ `typedAddressOutcome()` in `test-e2e/gettingStarted.e2etest.mjs`
  (test 8). ★ An admin tab must be listed in `ADMIN_TAB_PERMISSION`: that is what makes the chokepoint
  wait for the staff context ("Checking your access…") and refuse by ROLE — a tab missing from it is
  treated as a plan tab. ★ A role refusal sells nothing: no plan includes an admin screen.
- **Changing WHO the auth gate holds, or in what order** → `resolveGateScreen()` in
  [src/lib/gateScreen.js](src/lib/gateScreen.js) ↔ the switch in `BookkeeperProToolkit` ↔
  `test/gateMatrix.test.mjs`.
  ★ **NEVER QUOTE A PRICE FOR AN IDENTITY YOU COULD NOT READ.** The profile fetch fails OPEN by
  design (`profile = null`, `profileReady = true`) so the gate can never hang — but with a null
  profile `is_admin` is falsy, `is_paid` is falsy, and `enrollGateState()` bottoms out at
  `'paywall'`, which is indistinguishable from a brand-new unpaid signup. That is how the account
  that OWNS this product was shown its own ₱1,499 pricing cards, and how a paying student could be
  asked to buy what they already have. `AuthProvider` therefore exposes **`profileFailed`** ("the
  read errored", NOT "there is no row"), and the gate answers it with
  `GATE_SCREENS.PROFILE_UNAVAILABLE` — a hold with Retry + Sign out, which AuthProvider clears by
  itself by retrying on focus/visibility and on `PROFILE_RETRY_MS`. Three constraints, all pinned
  by `test/gateMatrix.test.mjs`: it is checked **inside** the `enroll.configured` block and
  **after** `decided` (checking earlier replaces `SPLASH` and `ENROLL_PENDING`, which are already
  correct and already price-free — the #50 mistake); it fires on **`PAYWALL` only**, not the whole
  `PRICING_SCREENS` set, following `staffOnlyWouldSeeAPrice()`'s precedent, because
  `MEMBERSHIP_EXPIRED`/`RENEWAL_PAYWALL` carry the only Renew/Extend/Upgrade actions and belong to
  someone who already bought; and it grants nothing — authority still fails closed, a ban and the
  staff bypass both still outrank it. The ordering is load-bearing (a ban outranks the paywall, imported
  onboarding outranks the membership gate, the legacy approval gate comes last among the holds that
  decide access) and for years none of it was a test. Add the case to the matrix in the same change.
  ★ **#69's Getting Started arm sits after even the legacy approval gate, and decides NO access.**
  It runs only where the paywall is enforced and MIGRATED (`requireEnrollment && enroll.migrated !==
  false`). `useEnrollmentGate`'s `migrated` turns false only when `isEnrollmentTableMissingErr()` says
  so, by the error CODE alone (PGRST205/42P01 a missing table, PGRST204/42703 a missing column).
  `isEnrollmentNotConfiguredErr()` stays the broad LOGGING classifier: its message regex also matches a
  PGRST002 schema-cache reload and a 42501 permission error that names `enrollment_requests`, and
  neither may switch the arm off (V-MIGRATED-PREDICATE). `configured` follows the LAST read and flips
  on any transient error; keying the arm on it made the gate flap GETTING_STARTED → APP →
  GETTING_STARTED mid-video (GF-2), so only the enrollment arm keeps reading `configured`.
  ★ **The arm never takes over a MEMBER's running app** (`appShellShown`, the root's `gsShellUid`
  latch). An effect sets it only when the gate's verdict is APP AND the enrollment phase is a settled
  pass (`gsEnrollPhase === 'pass'`). Any other screen except SPLASH ends it — a hold screen has already
  unmounted the shell, so the next pass is the next load's answer (a member whose term ends
  mid-session and who renews is asked then) — and so does a sign-out. The enrollment arm's own
  fail-open app (one `enrollment_requests` read error, for a student who is not a member yet) is never
  latched: latching it skipped the video for an enrollment approved later in that session
  (V-GF2-LATCH). A required answer that arrives while the latch stands is shown on the page and the
  card, and the gate asks again at the next load. The arm also never runs for `is_admin` or a
  staff-bypass viewer (no `staffReady` wait: the server's `required` already excludes staff), never
  after a session's deferral; `loading` holds the SPLASH and only a
  `ready` answer whose `required` is the literal `true` shows the video. Everything else — an RPC
  error, a pre-#69 database, the 7 s timeout, junk input — renders the APP: it fails OPEN because it
  grants nothing and membership RLS still guards every paid read. `test/gateMatrix.test.mjs` pins that
  every earlier screen still wins over a required video, unchanged. ★ There is no jsdom or RTL in
  this repo, so the suite pins the DECISION, not the render — a new `GATE_SCREENS` value still
  needs its switch arm added by hand, or it falls through `default` and renders the app.
  ★ **The `!profileReady` arm is NOT allowed to swallow a live invitation token** (#50): a
  successful `verifyOtp()` creates a session whose uid makes `profileReady` false, so a bare
  `→ SPLASH` there unmounts the invitation screen at the moment it has just spent the one-time
  token — which is the whole "your invitation has expired" incident. The pinned rule: token +
  `!profileReady` → `STAFF_INVITATION`, and the ban still wins the moment the profile lands.
- **Changing WHO must watch the Getting Started video** → `user_onboarding_video_state()` in
  `db/2026-09-30-getting-started-video.sql` **and its fold §56** is the ONE decision (the overview's
  set-based counts restate it and move with it) ↔ the client mirrors in
  [src/lib/gettingStarted.js](src/lib/gettingStarted.js) (`gettingStartedStatus()`,
  `gettingStartedEnrollPhase()` — whose `'pass'` is `gettingStartedEnrollPass()`, so the root hands the
  hook only a SETTLED pass, this account's profile and reads, T12-D1 and K3R-GATE-DIRECT-SWITCH; its
  `'hold'` vs `'unknown'` decides what a failed first answer
  means, V-GF1-DOUBLE-BOUND — and `gettingStartedFailedBeforePass()`,
  `gettingStartedGateInput()`, `publishImpact()`'s three cases) ↔ the last arm of `resolveGateScreen()`
  ↔ `test/gettingStartedSql.test.mjs` + `test/gettingStarted.test.mjs` + `test/gateMatrix.test.mjs` +
  `test-db/onboardingVideo.dbtest.mjs` (edges a–c) ↔ the `#69` block of `scripts/audit-db.mjs`, whose
  source probe names the cutoff clause itself. ★ `required` stays a boolean (`coalesce(…, false)`),
  staff stay excluded by the #50/#52 rule (`invited` + `active`, plus `is_admin`), and the cutoff stays
  the FIRST publish of ANY version. ★ The gate keeps failing OPEN and the functions CLOSED: never turn a
  failed, timed-out or malformed answer into a hold — the video grants nothing.
- **Changing what counts as FINISHED** → presentation: `watchVerdict()` / `playedFraction()` /
  `mergeRanges()` / `holdWatchVerdict()` / `watchRecordFor()` / `resumeAt()` with
  `ONBOARDING_WATCH_MIN_FRACTION` / `ONBOARDING_NEAR_END_SECONDS` ↔ `test/gettingStarted.test.mjs` ↔
  `uiSafety` §28b. Security: `ONBOARDING_MIN_ELAPSED_FRACTION` / `ONBOARDING_UNKNOWN_DURATION_SECONDS`
  / `ONBOARDING_MIN_ELAPSED_FLOOR_SECONDS` ↔ `complete_onboarding_video()`'s
  `greatest(coalesce(duration_seconds, 60) * 0.4, 5)` in BOTH SQL files ↔ `test/gettingStartedSql.test.mjs`
  (which builds its pattern from the constants) ↔ `test-db/onboardingVideo.dbtest.mjs` ↔
  `test-e2e/gettingStarted.e2etest.mjs`, whose 3-second clip must wait out the 5-second floor.
  ★ Keep the fraction under one half or a 2× viewer is refused; keep a floor and a stand-in or an
  unverified duration means no wait at all. ★ Never re-stamp `completed_at`.
- **Changing the `onboarding-videos` bucket** → it takes the LESSON limits:
  `LESSON_VIDEO_MAX_BYTES` / `LESSON_VIDEO_UPLOAD_MIMES` in `src/lib/courseVideo.js` ↔ the bucket literal
  in #69 + §56 ↔ `test/gettingStartedSql.test.mjs` ↔ the `#69` audit entry (which imports both) ↔
  `db/README.md` step 3 (exact bytes, never "2 GB") — and the project-wide limit stays the real
  ceiling for both video buckets (`npm run storage:config`). Its object name: `ONBOARDING_VIDEO_PATH_RE`
  ↔ the `storage_path` CHECK ↔ `onboarding_video_path_version_id()` (the suite runs hostile paths
  through all of them). Its four storage policies ↔ the three helpers ↔ their `authenticated` grant: a
  helper a policy calls without that grant breaks EVERY bucket, not just this one.
- **Changing what the Getting Started arm treats as set up, or when it may take a session over** →
  `resolveGateScreen()` (`enroll.migrated`, `appShellShown`) ↔ `useEnrollmentGate`'s `migrated` ↔
  `isEnrollmentTableMissingErr()` (codes only — never the logging classifier
  `isEnrollmentNotConfiguredErr()`) ↔ the root's `gsShellUid` latch effect and its two rules (set on APP
  with `gsEnrollPhase === 'pass'`; ended by any screen but APP or SPLASH, and at sign-out) ↔
  `test/gateMatrix.test.mjs` + `uiSafety` §28b, whose root-level sequence test RUNS the root's own lines
  through `resolveGateScreen()`. ★ Never key the arm on `enroll.configured` again: it follows the last
  read, and one transient error took a student out of the video mid-watch (GF-2).
- **Changing when the root hook asks again** → `gettingStartedNeedsReask()` ↔ `gettingStartedStatus()`'s
  hold (ONE rule: a hold with no re-ask behind it is a splash that never ends, and a re-ask with no hold
  in front of it is a round trip nobody waits for) ↔ the hook's `failedBeforePass` ↔
  `gettingStartedEnrollPhase()` / `gettingStartedFailedBeforePass()` ↔ the hook's settling effect (a
  failure that landed while the phase was `'unknown'` takes the first settled phase) ↔
  `test/gettingStarted.test.mjs` + `uiSafety` §28b.
- **Changing where a viewer stands, or why the video gave up** → `gettingStartedStanding()` (the card's
  chip AND the page's line: one derivation, S6) / `gettingStartedGiveUpCopy()` (every give-up panel; "on
  this device" only for a decode failure, S3) ↔ `test/gettingStarted.test.mjs` + `uiSafety` §28b ↔ the
  rendered suite's card-chip finder (`gsCard()` in `test-e2e/gettingStarted.e2etest.mjs`).
- **Changing what a Replace confirmation binds to** → `admin_onboarding_video_publish(p_video_id,
  p_replace_live, p_expected_live_id)`'s expected-live guard and its `REPLACE_CONFIRM` context (dated
  file + §56) ↔ `confirmReplace` in `GettingStartedVideoAdmin` (it sends the live id frozen when the
  dialog opened; the dialog's text is built from that same `confirm.live`) ↔ `uiSafety` §28c (DBSEC-1) ↔
  `test/gettingStartedSql.test.mjs` ↔ `test-db/onboardingVideo.dbtest.mjs` (DBSEC-1) ↔ the `#69` audit's
  one-signature check. ★ Re-signing a function needs the old signature DROPPED first: CREATE OR REPLACE
  with a new parameter adds an overload, and every call that omits the new parameter becomes ambiguous.
- **Changing what the INVITATION SCREEN shows, or when** → the decision is
  `resolveInviteState()` in [src/lib/inviteMachine.js](src/lib/inviteMachine.js) ↔ the switch in
  `StaffInvitationSetup` ↔ `staff_invitation_state()` in
  `db/2026-08-30-staff-activation-consistency.sql` (+ its bootstrap fold §37) ↔
  `test/inviteMachine.test.mjs`. Facts must stay DURABLE (server-derived, refetchable) — deriving
  a step or a password requirement from component state is exactly the #49 bug. The recovery rule
  ("while my own membership is `invited`, never report `expired`") and the decline table
  (`resolveDeclineTarget()` — a staff-only decline never renders pricing) are both pinned there;
  a new state also needs its switch arm in the component, by hand.
- **Changing who appears in student ACCESS REQUESTS** → `admin_access_request_queue()` ↔
  `admin_access_request_pending_count()` (the badge — same predicate, same permission gate,
  by design; they diverged before #50 and the badge counted staff the list never showed) ↔
  `staff_sync_is_admin()`'s approval half ↔ **`admin_review_access_request()`'s staff-target
  refusal (#51)** ↔ `test/accessRequestsSql.test.mjs`. The exclusion is `invited`+`active` only —
  hiding `suspended`/`revoked` would lose a real student. ★ **The DECIDER must refuse whatever the
  QUEUE hides.** #50 hid staff from the list but left `admin_review_access_request()` accepting any
  uuid, and it is granted to `authenticated` and gated only on `access_requests.review` — a
  permission Ops Admins hold — so a direct PostgREST call could ban a peer Trainer or veto a Super
  Admin's unaccepted invitee, producing a banned-but-authorized account the approval trigger
  cannot repair (its half is scoped to `pending`, so a ban is never laundered). #51 closes it with
  `ACCESS_REQUEST_STAFF_TARGET` and **no Super Admin exemption** — withdrawing staff access is
  `admin_set_staff_status()`, which writes an audit row.
- **Changing how learning PROGRESS is scored, or who appears on a leaderboard** → five places move
  together: `student_progress_current()` (the ONE population and scorer) ↔ the `courses_read` policy
  it mirrors ↔ `STUDENT_PROGRESS_TRACKS` / `LEADERBOARD_SCOPES` in
  [src/lib/studentProgress.js](src/lib/studentProgress.js) ↔ `test/studentProgressSql.test.mjs` ↔
  `test-db/studentProgress.dbtest.mjs`. The parity suite runs every assertion against **both** the
  dated migration and the bootstrap fold, because `bootstrapFolds.test.mjs` is a line-set
  **containment** check: it proves nothing was dropped from a fold, never that nothing wrong was
  added, and on a fresh install the last definition wins. ★ Two invariants are load-bearing and are
  pinned by name: **staff are excluded from the population** (`invited` + `active`, the #50 rule —
  a promoted student keeps their subscription row, so nothing else removes them), and **a missing
  7-day baseline is NULL, never 0.00** (both `student_leaderboard` and `my_student_progress`, plus
  the `week` window's exclusion — a fabricated zero makes Most Improved a mislabelled copy of the
  overall board). ★ Current scores must never read `student_progress_daily`: it is history, and a
  learner has to see a completion on the next request, not the next cron run.
- **Changing who may CONFIGURE or MODERATE the community** → five places move together:
  `user_is_community_staff()` / `is_community_staff()` (the #45 two-form split) ↔ the nine
  community config RPCs' `has_staff_permission('community.manage')` guard ↔ the 33 RLS
  policies + the three `community-media` storage policies ↔ `communityAuthority()` in
  [src/lib/staffRoles.js](src/lib/staffRoles.js) ↔ `test/communityStaffSql.test.mjs` +
  `test/communityAuthority.test.mjs` + `test-db/communityStaffRls.dbtest.mjs`.
  ★ **Never repair a missed check by handing a non-super role `is_admin = true`.** That
  column is a trigger-maintained cache meaning "active super_admin" and it is what ~74
  legacy `is_admin()` references read; the whole safety argument of #45 is that a check we
  failed to find UNDER-grants rather than over-grants.
  ★ **Never restate one of the nine RPC bodies.** `admin_save_community_channel()` has no
  current body in the repo — #41 defines it and #43 text-patches it at runtime — so the
  `do $regate$` block in #56 is the only correct instrument. `test/communityStaffSql.test.mjs`
  fails if the migration contains `create or replace function public.admin_…` for any of
  the nine.
  ★ A future migration that re-creates one of those nine from the #40/#41/#43 text and is
  folded AFTER §43 silently reverts the guard. The `#56` entries in
  `scripts/audit-db.mjs` are the only live tripwire — `db:shadow:verify` compares
  `proname/args/prosecdef/proconfig` and never `prosrc`, and filters `pg_policies` to
  `schemaname='public'`, so it cannot see either storage policy.
- **Changing what a MODERATOR may do** → `community_moderate_post` /
  `community_moderate_comment` ↔ `community_posts_guard()`'s three `community.moderate`
  gates ↔ the `community_*_admin_all` policies ↔ `community_moderation_events` ↔ the client
  handlers in `CommunityHub`. The RPCs are safe because their ARGUMENTS cannot name a
  content column — keep it that way; the moment one takes a patch object, the bound is gone.
  ★ The `created_at` bypass stays `is_super_admin()`. Backdating is forgery, not moderation.
  ★ The UPDATE-branch freeze in `community_posts_guard()` must stay gated on
  `community.moderate`: without it the RPCs silently no-op and still return success.
- **Changing what the Financial Management dashboard may report, or who may open it** → the finance
  half moves as one: `db/2026-09-09-financial-management.sql` ↔ **bootstrap fold §45** ↔
  `FINANCE_ACCOUNT_TYPES` / `FINANCE_REPORTING_CLASSES` / `FINANCE_AGING_BUCKETS` in
  [src/lib/financeModel.js](src/lib/financeModel.js) ↔ `test/financeSql.test.mjs` ↔
  `test-db/financeRls.dbtest.mjs` ↔ the `#58` block in `scripts/audit-db.mjs` — and, since #59,
  `db/2026-09-14-finance-parity.sql` ↔ fold §46 ↔ `src/lib/bankStatement.js` ↔
  `test/financeParitySql.test.mjs` ↔ the `#59` block. A migration that restates a #59 function must copy
  #59's body, not #58's: #59 added the feed-link refusals, and restating the #58 text silently removes them.
  Since #64, **Daily Income** moves as its own set: `db/2026-09-19-finance-daily-income.sql` ↔ fold §51 ↔
  `src/lib/financeDailyIncome.js` ↔ `FinanceDailyIncomeReport` ↔ `test/financeDailyIncomeSql.test.mjs` +
  `test/financeDailyIncome.test.mjs` + `test-db/financeDailyIncome.dbtest.mjs` ↔ the `#64` audit block.
  ★ **Its definition of income must stay the P&L's.** The `reconciliation` block does NOT check this — it
  only proves the classification is complete against the report's own income-account total — so if
  `finance_cash_basis_pl` changes what counts as income, `reconciled` stays true while the two reports
  quietly disagree. Change both in the same migration and run `test-db/financeDailyIncome.dbtest.mjs`
  ("June reconciles to the cash-basis P&L"), the only check that compares them. ★ A new finance RPC called from the app
  must be added to `FINANCE_RPC_OWNERS` in `financeSql.test.mjs`, or the wiring test reports it as undefined.
  ★ **Never add an insert/update/delete policy to a `finance_` table.** The zero-client-write-path
  rule is what makes the legacy system's 30 unguarded mutations unreachable; all mutation goes through
  the SECURITY DEFINER RPCs, and `financeSql.test.mjs` fails if any write policy appears.
  ★ **Never add `accounts_receivable` to the `subtype` CHECK** — a receivable account makes accrual
  revenue representable, and every cash-basis claim in the feature stops being true by construction.
  ★ **Assert against extracted vocabularies, never "this string appears nowhere in the file."** That
  shape is defeated by the comments that explain an invariant *and* by the migration's own
  `schema_migrations` notes; it produced a false failure while #58 was being written, whose tempting
  "fix" was deleting the comment that documented the rule.
  ★ A new error code is a **three-place** change: `app_error_catalog()` ↔ `APP_ERROR_CODES` ↔
  `APP_ERROR_COPY`. This caught two real omissions during #58's own development.
- **Adding, removing or re-granting a STAFF PERMISSION** → four places move together:
  the `staff_permissions` + `staff_role_permissions` seed in a dated migration ↔ the **bootstrap
  fold** ↔ `STAFF_PERMISSIONS` / `ROLE_PERMISSIONS` in [src/lib/staffRoles.js](src/lib/staffRoles.js)
  ↔ the policy or RPC that actually READS the key. `test/staffRolesSql.test.mjs` pins the first three
  against each other in BOTH SQL files and counts the grants, so a silently-dropped cell fails — but
  **nothing pins the fourth**. A key that exists and is granted and is read by nothing is a role that
  looks real in the UI and refuses at the first server call; that is precisely what #45 shipped for
  the Trainer and #46 had to repair. When you add a key, name the policy it gates in the same change.
- **Changing who may edit a course** → `user_can_manage_course()` ↔ `canManageCourseClient()` ↔ the
  `courses_staff_*` / `modules_staff_write` / `lessons_staff_write` policies ↔ the course storage
  policies ↔ `test/courseStaffSql.test.mjs`. ★ And keep the read/write asymmetry: writes may parse the
  object path (it fails CLOSED); **reads must stay reference-based** through
  `course_video_object_readable()`, which is why #44 exists.
- **Changing plan-scope rules** (which plan reads which courses) → four places move together:
  the `courses_read` RLS policy, the #27 parameterized mirrors (`trainer_visible_courses` /
  `trainer_courses_for_plan`), `PLAN_ENTITLEMENTS` in `src/lib/planCatalog.js`, and
  `planScopeAllows()` in `src/lib/trainerContent.js` (pinned by `test/trainerAccess.test.mjs`).
- **Adding, removing, or repricing a PLAN** → `enrollment_plans` (a dated migration) ↔
  `ENROLLMENT_PLANS_FALLBACK` ↔ `PLAN_ENTITLEMENTS` in `src/lib/planCatalog.js` ↔ the bootstrap §9
  seed ↔ `ENROLLMENT_PLAN_KEYS` in `src/lib/trainerContent.js` (the admin trainer-preview allowlist)
  ↔ `PLAN_ALLOWLIST_FALLBACK` in `api/admin/student-imports.js` ↔ **`TIER_BY_PLAN_KEY` in
  `src/lib/trainingAgreement.js`** (#42), then re-run `npm run ai:knowledge`.
  `test/planCatalog.test.mjs` pins the catalog and, critically, that **every** catalog key has an
  explicit entitlement entry — an unlisted plan now fails CLOSED rather than getting full access.
  `test/trainingAgreement.test.mjs` pins the agreement half the same way, and reads the REAL catalog
  rather than a fixture: a plan with no agreement tier makes its buyer sign a document naming
  neither their plan nor its price.
- **The trainer tool set or teaching-prompt behavior** → update `VOICE_SERVER_TOOL_SPECS`, the
  §3 system-prompt block + §4b in docs/ai/voice-agent-setup.md, and re-run `npm run ai:provision`.

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
