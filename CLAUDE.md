# CLAUDE.md

Guidance for Claude Code (and any developer) working in this repository. Read this first.

## What this is

**Ultimate Remote Bookkeeper Toolkits** ("Get Hired With Alex") is a single-page web app for
aspiring and working **remote bookkeepers serving US clients**. It bundles ~60 fully-functional
tools across three career stages:

1. **Training & Skills** — Accounting 101 course, Industry Accounting playbooks, US Tax 101, ProAdvisor chat.
2. **Job Application** — authentic branding, resume/LinkedIn optimizers, interview prep, mock-interview & discovery-call simulators, QuickBooks diagnostic, pain-points & cover-letter generators.
3. **Client Management & Delivery** — engagement letters, onboarding, Chart of Accounts generator, invoice creator, bank-feed AI, statement→CSV converter, email templates, accounting calculators, monthly/year-end checklists, SOP generator, sales tax, budgeting & forecasting, plus growth tools (pricing, upsell, capacity, payment tracking).

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
npm test                   # node --test — the pure-lib suites in test/ (planCatalog, studentImport, trainerToken, trainerContent, trainerAccess, communitySpaces, communityCapabilities, batchEntitlements, batchLifecycle, appErrors, lessonReplay, enrollmentIntake, trainingAgreement, …)
```

There is **no linter** — verify UI changes by running `npm run dev` and exercising the affected
tool in the browser. The only automated tests are the `node --test` suites over the pure
`src/lib/*.js` modules (`npm test`).

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

### Community (Supabase-backed member forum) — `CommunityHub`

The in-app replacement for the Discord group chat, grown into a full forum: tab id
`community`, route `/community` (+ **`?post=<id>` deep links** to a discussion — the
CourseCatalog `?course=` idiom), sidebar Home → Community. **Every active paid plan includes
it** (all plans advertise group chat) — the tab id is in the sampler `tabIds` (silver and VIP are
full-access plans, so they pass by default), and the **server gate is `is_approved()` +
`is_enrolled()` RLS** (term + 3-day grace, mirroring course reads), so access ends with the
membership automatically — **expired members are fully blocked — reads _and writes_** (#28 closed
the own-update gap on posts/comments that #25 had left). The
Sampler Session's **60-day group chat support** == its 60-day `access_days` window.

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
unread; never a query per channel), `community_channel_write_denial()` explains a refusal, and
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
`admin_finalize_enrollment()`'s batch precedence) ↔ `batchGapForProcess()` (the import path's
process-time re-validation) — all pinned by `test/communitySpaces.test.mjs`.
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

### Student Imports (admin — Thinkific → Toolkit migration) — `StudentImports`

The admin-only migration system for moving legacy Thinkific students into the Toolkit's own
membership. Tab id `studentimports`, route `/admin/student-imports`, an `isAdmin`-gated sidebar link
beside Access Requests + Enrollments (**not** in `DEFAULT_STAGES` — the same standalone-link pattern
as the other admin tabs). Migration **#26**
([db/2026-07-23-student-imports.sql](db/2026-07-23-student-imports.sql), folded into the bootstrap
§16). Full runbook: **[STUDENT_IMPORT_SETUP.md](STUDENT_IMPORT_SETUP.md)**.

- **Core principle:** imports create **real** Supabase Auth accounts (students set their OWN password)
  and grant **real dated `subscriptions` rows** that flow through `public.is_enrolled()` exactly like a
  paid enrollment — **never** fake `enrollment_requests`/receipts/payments. Imported terms are marked
  `subscriptions.grant_source='import'` + `source_import_row_id` (a **partial** `unique` index =
  one grant per import row) so they're distinguishable + idempotent, and this is **additive** — the
  existing `approve_subscription()`/`approve_extension()` signatures/bodies are untouched (their
  inserts leave the new columns at defaults, which the partial index never covers).
- **Non-negotiable data rule:** never infer paid access/plan/payment/start/expiry from a course title,
  account-created date, last-sign-in, or amount-spent. Plan comes from the admin's explicit
  course-combo mapping (read live from `enrollment_plans`); term dates come from a trustworthy source
  (Orders/ledger/manual template). A bare Thinkific **User** export (blank emails) **stages** but
  grants nothing — all new-account rows are **blocked** until email + exact expiry are supplied.
- **Tables** (all RLS admin-only; `student_external_accounts` also self-read):
  `student_import_jobs` (staged upload + `settings` combo→plan map + resumable `cursor`) →
  `student_import_rows` (per-row `mapped` raw/normalized payload — purgeable — + `proposed_*` /
  `match_result` / `intended_action` / `processing_status` / idempotency flags), `student_external_
  accounts` (durable `unique(source, external_user_id)` link), `student_import_events` (immutable
  audit — admin select+insert, **no** update/delete; IDs + safe codes only, never PII/links).
  Plus `profiles.account_origin`/`onboarding_status`/`invited_at`/`onboarding_completed_at` +
  the narrow `complete_import_onboarding()` SECURITY DEFINER RPC (the student's own onboarding write).
- **Server** — [api/admin/student-imports.js](api/admin/student-imports.js) (Vercel + `npm run dev`
  via the `studentImportDevApi` middleware in vite.config.js). Holds the **service-role** key
  (`SUPABASE_SECRET_KEY`, legacy fallback `SUPABASE_SERVICE_ROLE_KEY`; never `VITE_`-prefixed / never
  returned/logged). **Every action verifies the caller JWT + independently confirms
  `profiles.is_admin` BEFORE the service client is constructed** (same `verifyCaller`/`callerIsAdmin`
  idiom as the notify/proxy endpoints). Actions: `dry-run` (bulk-match staged rows by source link →
  normalized email via `profiles.email`; **never by name**; write proposals back — no mutations),
  `process` (bounded resumable batch from the cursor; per-row idempotent + partial-failure recoverable
  — three idempotency keys: auth-email uniqueness + external-link unique + `source_import_row_id`
  unique; never auto-deletes an Auth user), `resend-invite`, and a `GET` health check. Invites use
  `admin.generateLink` (invite/recovery) → emailed via Resend → **link discarded**.
- **Pure logic** — [src/lib/studentImport.js](src/lib/studentImport.js): dependency-free ESM shared by
  the wizard, the endpoint, and `node --test` ([test/studentImport.test.mjs](test/studentImport.test.mjs)).
  `normalizeEmail`/`parseExternalId`/`parseStrictDate` (strict UTC; rejects ambiguous),
  `sanitizeCsvCell`/`toCsv` (formula-injection-safe exports), `parseCsv` (BOM/quoted commas),
  `parseEnrollmentsList`/`comboKeyOf`/`suggestPlanForCombo` (advisory only — never auto-confirms;
  never suggests sampler/vip, and since #39 gives QBO-only history no suggestion at all), `resolveMatchDecision`, and `computeImportTerm` (the
  preserve/expired_history/fresh/lifetime + never-shorten-a-longer-active-term decision table).
- **Onboarding gate:** an imported user (`profiles.account_origin='import'` + `onboarding_status !=
  'completed'`) is forced onto `SetPasswordScreen` (reuses `updatePassword` +
  `complete_import_onboarding()` RPC) via a new early-return in the auth gate **after** `profileReady`
  and **before** the enrollment block. `PROFILE_SELECT` (AuthProvider.jsx) carries the two onboarding
  columns; a pre-#26 DB drops them via the column fallback → the gate simply never triggers (safe
  degrade). After completion the imported subscription flows through `useEnrollmentGate → is_enrolled`
  with zero special-casing. Import state is server-side — nothing goes in `LEGACY_KEYS`.

### [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx) — the entire app (~24.2k lines)

> Note: lines are long; prefer `Grep` over reading the whole file. Line numbers below are anchors,
> approximate as the file evolves.

| Region | Lines (approx) | Contents |
|---|---|---|
| Routing + shared AI helper | 20–610 | URL/panel routing helpers (`TAB_ROUTES` L79, `readAppRoute` L219, `setPanelParam` L263), the voice-assistant literals (`VOICE_TAB_INFO`…), `callClaude()` (L563) — the single entry point every AI tool uses (see AI/proxy pattern) |
| Domain data | 610–1175 | `COA_BASE` (L613), `COA_INDUSTRY` (L666), `INDUSTRY_NOTES` (L886), `VENDOR_PATTERNS` (L912), `COURSE_MODULES` (L1008), checklists, `TIPS` (L1148) |
| Design system + helpers | 1175–1510 | colors `C` (L1177), `SHEEN` (L1230), `GLASS` (L1233), fonts `fontDisplay` (L1247) / `fontMono`, `downloadFile()` (L1257), `useCurrency()` (L1309), `CurrencyToggle()` (L1497) |
| Auth / enrollment / account infra | ~1510–4880 | gate screens, `useEnrollmentGate` (L2336), `submitSubscriptionRequest` (L2435), `OverlayPortal` + `AccountModal`/`SidePanel` shells (~L3000), `AccountMenu` + the Account-Center components (`ProfileSettingsBody`/`AccountSettingsPanel`/`MembershipPlanModal`/`ExtendAccessModal`, ~L3174–3760), `VoiceAssistant` (L4367), `renderToolContent` switch (L4834) + `TabPanel` |
| Root component | 4887–~6600 | `BookkeeperProToolkit` (L4887): `tab` + `accountPanel` state, sidebar `DEFAULT_STAGES` config (L5080), drag-drop reorder, rename/persist to `window.storage` (`sidebar:*` keys), and the **keep-alive render** (`visitedTabs` map). |
| Tool components | ~8200–end | ~60 self-contained functional components |

**Notable tools → approximate line:** `Dashboard` 8236, `CoaGenerator` 8521, `Course` 8624,
`CourseProgram` ~8805 (single-course Supabase video engine — builder + PDF certificate),
`CourseCatalog` ~9966 (prefix-parameterized multi-course catalog) + the `QBOMastery` (`qbo-`) /
`InterviewStrategyCatalog` (`interview-`, the `winstrat` subtab) / `ResumeStrategy` (`resume-`) wrappers right after it,
`BankFeed` 10466, `StatementConverter` 10665, `CommunityHub` ~12359 (the community forum — see the
Community section above; the forum suite `MemberAvatar` 11151 → `useCommunityBell` 11848 →
`CommunityPostCard` 12102 sits just above it), `ProChat` 13281,
`AuthenticBranding` 14445, `CoverLetterGenerator` ~17900 (tab id `proposal`, route `/proposal-generator` —
replaced the old 7-document-type `ProposalGenerator`; paste a job post → industry auto-detect → 3 letter
variations + a timecoded video-intro script + an interview-prep pack from ONE `callClaude` call at
`max_tokens: 8000`. Pure logic lives in `src/lib/coverLetterIndustry.js` (industry table + keyword
detector) and `src/lib/partialJson.js` (tolerant JSON + truncated-prefix recovery), both covered by
`npm test`), `EngagementLetter` 15168, `EmailTemplates` 15717,
`PainPointsGenerator` 15970, `IndustryAccounting` 16330, `USTax101` 16466,
`MonthlyWorkflow` 16560, `MonthEndChecklist` 16650, `InvoiceCreator` 16881, `CoachAlexChat` 17369,
`CPAAIChat` 17399, `AccountingCalculators` 18201, `NicheSelectorQuiz` 18267,
`LinkedInOptimizer` 18405, `MockInterviewSimulator` 18561 (a **guided-video + external-link page** —
admin-uploaded explainer video + a "Open Mock Interview Simulator" button to the external
`https://app.sesame.com/`; Supabase-backed via the `feature_guides` table — **not** the old internal
AI simulator. The CTA is **gated behind watching the guide video** — grey/disabled until the video ends
[native `<video>` / YouTube IFrame API / Vimeo SDK via the `GuideVideoPlayer` child], then blue; per-user
completion persists in `feature_video_completions` and re-locks when the admin replaces the video. It
takes an **`embedded`** prop and now renders as the **2nd sub-tab inside `InterviewPrep`** (Job Interview
Mastery), not a standalone sidebar item; when `embedded` it drops its own `SectionHead`. The legacy
`mockinterview` tab id is kept only as a defensive render-switch redirect → `<InterviewPrep initialSub="mock" />`),
`DiscoveryCallSimulator` 18973,
`SOPGenerator` 19280, `ClientHealthScore` 19945, `CapacityPlanner` 21029, `PaymentTracker` 21213,
`QBDiagnostic` 21965, `BudgetingTool` 23162, `ForecastingTool` 23653. (Note: `ClientHealthScore`,
`CapacityPlanner`, and `PaymentTracker` are among ~10 components currently defined but wired to no
route/sidebar entry — see the 2026-07-14 cleanup audit; pending a product call to delete or restore.)

### Navigation model

A single `tab` string in the root selects which tool renders, and navigation is **URL-routed +
keep-alive** (see below). Four pieces must stay in sync when adding/removing a tool:

1. **Sidebar config** (`DEFAULT_STAGES` array): `{ id, number, label, groups: [{ key, label, tabIds }], tabs: [{ id, label, icon }] }`. Each group carries a stable `key` (label-independent — see below).
2. **`renderToolContent(tabId, handlers)`** — a `switch (tabId)` at **module scope** (just above the root component) that returns each tool's element; `handlers` carries the few props tools need (`goto`, the two admin badge refreshers, `interviewSub`). It is rendered through the memoized **`TabPanel`** (see keep-alive below). This replaced the old in-root `renderTabContent` closure and, before that, the `{tab === 'id' && <Cmp/>}` chain.
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
  root restores the tab from the URL **after** the auth gate, persists the last tab to
  `window.storage` (`nav:lastTab`), and handles Back/Forward via a `popstate` listener (which also
  re-syncs `accountPanel`).
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
  Per-tab scroll is saved/restored via `sessionStorage` (`nav:scroll:<tab>`). **Plan gating rides
  here:** this same `visitedTabs.map` is the entitlement chokepoint — a tab the user's plan can't open
  renders `RestrictedTab` instead of its `TabPanel` (see the "Plan-based access" bullet in
  Authentication). The sidebar/tiles are filtered cosmetically; this render is the real boundary.

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
  (SECURITY DEFINER, internal `is_admin()` guard; one transaction: supersede active row → insert
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
  verbatim as §29).
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
  editing form**. Consumers: `AccountSettingsPanel` (`sm:max-w-lg`) and the **course lesson editor**
  (`CourseProgram.renderLessonEditor`, `sm:max-w-xl lg:max-w-2xl`, Cancel/Save in `footer`,
  `canClose={!savingLesson && !uploading}`). ★ That editor was a hand-rolled `fixed inset-0` overlay
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
  `AdminNotice` (status-token banners), `AdminFilterChip`/`AdminFilterCaption` (labeled filter rows),
  `AdminListSkeleton` (first-load skeleton; refresh keeps the list), `AdminUserCell`
  (avatar/name/badges/email/meta identity block), `ADMIN_BTN_OK`/`ADMIN_BTN_DANGER` (token-gradient
  action buttons). New admin surfaces must reuse these. `ProfileSettingsBody` (rendered in the
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
  **exactly three plans** (#39): `sampler` (Sampler Session, ₱1,499 / 60 days) is the ONE scoped
  plan — Home + the QuickBooks catalog (`qbomastery`) but only its **Essentials** course
  (`access_tier='essentials'`, NOT Mastery) + both 1-on-1 booking tabs (`linkedinopt`, `coachalex`)
  + `community`. Its ₱1,499 buys the coaching session, not more course content, so the CHEAPEST
  plan is also the most scoped — **never assume price ⇒ scope.** `silver_self_paced` (QBO + Resume
  Combo, ₱2,999 / 60 days) and `vip` (Personalized Coaching Program, ₱16,999 / 180 days) are both
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
  paywall hooks" seam): a disallowed active tab reached ANY way (deep-link, popstate, stale
  `nav:lastTab`, programmatic `goto`) renders **`RestrictedTab`** (a polished upsell → Dashboard)
  instead of the tool. The sidebar (`visibleStages`, both passes) and Dashboard tiles are filtered
  cosmetically; the aspirational Career Roadmap strip stays full. **Server half** =
  `db/2026-07-11-sampler-essentials-access.sql` (`courses.access_tier` + `plan_is_sampler()` →
  sampler reads only `qbo-*` **AND** `access_tier='essentials'`), wrapped `(select …)` for
  once-per-query InitPlans. (`plan_is_qbo_only()` from `db/2026-07-09-plan-course-access.sql`
  existed only for `core_self_paced` and was **dropped by #39** along with its conjunct in the four
  course-read policies and `course_object_allowed()`.) It scopes course/lesson reads + the private
  `course-videos` bucket via direct Supabase query. Admins set a course's tier in-app via the course
  card **⋮ menu → "Sampler tier (Essentials)"**. **Keep the client tab-allowlist + `courseTier` and the
  SQL `qbo-%` / `access_tier` rules in sync** when entitlements change. An admin's plan change (upgrade
  approval) applies live via `useEnrollmentGate`'s realtime/focus refetch. Residuals (documented, not
  enforced): `feature_guides` + the AI proxy stay `is_enrolled()`-gated.
- **Sign-out + identity** render in the sidebar header (just below the "built by Alex Sagun" line);
  a compact "Access until {date}" line sits below it for non-admin members with a dated term.
- **Per-user data:** all `window.storage` keys are auto-namespaced per user (see the main.jsx shim
  note). Tools need no changes. A one-time migration in `AuthProvider` adopts any pre-auth global
  keys into the first signed-in account (guarded by `auth:legacyMigratedTo`). The canonical legacy-key
  list lives in `AuthProvider.jsx` (`LEGACY_KEYS`) — **add to it whenever a tool introduces a new
  persisted key.** One special case: `ui:theme` is per-user via `window.storage` *and* mirrored to a
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
- **Backend setup:** a `profiles` table + RLS + a signup trigger must exist in Supabase. Email
  confirmation and Site/Redirect URLs are configured in the Supabase dashboard. See README / the
  setup steps for the exact SQL.
- **Phase 2 status:** the paid gate shipped as the **manual enrollment workflow** above (full-app
  gate keyed on `is_paid`, flipped only by an admin — RLS has no user-update policy on `profiles`).
  The old `FREE_TABS`/`// Phase 2 paywall hooks here` seam is now **realized as the plan-entitlement
  chokepoint** (see the "Plan-based access" bullet) — the `visitedTabs.map` render gates each tab by
  `entitlement.allowsTab(tabId)`. A future Stripe/Gumroad webhook could still flip `is_paid` +
  grant a subscription term server-side without manual review.

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

## Voice assistant (ElevenLabs) — "Toolkits Guide"

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
  health check `{ ok, configured }`; POST mints an ElevenLabs signed URL after the same gate as
  the Anthropic proxy (valid Supabase JWT → 401, `is_enrolled()` admin-or-member → 403,
  fail-open on RPC-indeterminate with a `[elevenlabs]` warning, 8 mints/min/user burst limit).
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
  (deterministic — extracts `TAB_ROUTES`/`VOICE_TAB_INFO`/`TIPS` from the JSX, **imports**
  `ENROLLMENT_PLANS_FALLBACK`/`PLAN_ENTITLEMENTS` from `src/lib/planCatalog.js` since #39, and fills
  a hand-authored template; it now FAILS if a catalog plan has no entitlement entry);
  `npm run ai:knowledge:push`
  additionally uploads it to the ElevenLabs knowledge base by name (idempotent, replaces the
  old copy, other KB docs untouched). There is **no auto-sync** — regenerate + push whenever
  tools/plans change (see Keeping docs current), and **`npm run ai:knowledge:check`** rebuilds
  the doc in memory + diffs it against disk (Generated-date ignored; exit 1 on drift) so a
  feature change can't silently leave the static product guide stale.
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
- **Authorization is server-side and FAIL-CLOSED** (unlike the fail-open signed-url/anthropic
  gates, which are deliberately unchanged): every trainer request verifies a short-lived HMAC
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
  cells in Budgeting/Forecasting — plain rows vs blue subtotal / highlight / green / red summary rows). Defined in both theme blocks (light =
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
- **Adding/renaming a tool, or changing plans/entitlements/pricing** → also update `VOICE_TAB_INFO`
  (+ aliases) in BookkeeperPro.jsx and rerun `npm run ai:knowledge` (and `ai:knowledge:push` when
  deployed) **in the same change**, so the voice assistant's knowledge never drifts from the app.
  `npm run ai:knowledge:check` must pass (it exits 1 when the committed doc no longer matches the
  code — run it before calling any tools/plans change done).
- **Changing which channels a member can see** → four places move together:
  `user_community_channel_ids()` ↔ `channelAudienceAllows()` in `src/lib/communityChannels.js`
  ↔ `test/communityChannels.test.mjs` ↔ `test-db/communityChannels.dbtest.mjs`. The audience
  modes fail CLOSED on an empty mapping and on an unknown mode — keep it that way.
- **Changing what a member can DO in a channel** → `user_community_channel_capabilities()` ↔
  the five channel-scoped write policies ↔ `effectiveChannelCaps()` ↔ both suites. The client
  must consume the server-computed `can_*` verbatim and fail closed while they load — the
  pre-#40 bug was a re-derivation from raw space flags that failed OPEN.
- **Changing community write permissions** → four places move together: the `enrollment_plans`
  capability columns (#36) ↔ `user_community_capabilities()` ↔ the five community write policies ↔ the per-channel flags (#40) ↔
  `capabilitiesFor()`/`effectiveCaps()` in `src/lib/communityCapabilities.js`
  (`test/communityCapabilities.test.mjs` pins the truth table — 3 plans x 2 space kinds x 4 actions
  since #39; it was 5 x 3 x 4 under #36).
- **Changing how many cohorts a plan grants** → `plan_batch_count()` ↔
  `enrollment_plans.eligible_batch_count` ↔ `planBatchCount()` in `src/lib/batchEntitlements.js`
  (`test/batchEntitlements.test.mjs` pins it).
- **Adding, removing or renaming an enrollment intake question** → `INTAKE_FIELDS` in
  `src/lib/enrollmentIntake.js` is the ONLY place that needs to change for it to render, be
  required, and be flagged when blank. But if it must be *stored*, three more move with it:
  a dated migration adding the column (or a key inside the `intake` jsonb), the row built in
  `EnrollmentPaywall.submit()`, and `INTAKE_COLS` in `api/notify-enrollment.js` — the admin
  alert selects an explicit column list, so a new column is silently `undefined` in the email
  until it is listed there. `test/enrollmentIntake.test.mjs` pins the registry invariants.
- **Changing the Training Agreement's wording** → bump `AGREEMENT_VERSION` in
  `src/lib/trainingAgreement.js` in the same change. `enrollment_requests.agreement_version`
  records which text each student accepted, so editing the document without bumping makes every
  past signature appear to endorse the new terms. Repricing or renaming a plan is NOT a wording
  change — prices are read from `enrollment_plans` at render time. `test/trainingAgreement.test.mjs`
  pins section contiguity (the source silently dropped Section 4), the three tier columns, and
  that no retired copy — Discord, Thinkific, a hardcoded extension price — creeps back in.
- **Changing what a lesson replay link may be** → three places move together: the
  `course_lessons.zoom_replay_url` **COMMENT** (in both `db/2026-08-05-lesson-zoom-replay.sql` and the
  bootstrap) ↔ `parseReplayUrl()` / `ZOOM_HOST_SUFFIXES` in `src/lib/lessonReplay.js` ↔
  `LessonReplayLink` + the lesson-editor field in BookkeeperPro.jsx (pinned by
  `test/lessonReplay.test.mjs`). The column has **no CHECK by design** — the client module is the only
  enforcement point, so a rule loosened there is loosened everywhere.
- **Adding a column to the lesson model** → it must be added to **all** of: `COURSE_LESSON_SELECT`,
  `lessonComparable()` (or the dirty check silently ignores it), `saveLesson()`'s `payload`, the lesson
  editor UI, and `CourseCatalog.duplicateCourse()`'s lesson `.map()`. Each is an explicit allow-list;
  missing one fails silently rather than loudly.
- **Adding an error code** → `app_error_catalog()` ↔ `APP_ERROR_CODES` **and `APP_ERROR_COPY`** in
  `src/lib/appErrors.js`. Clients branch on `error.hint`, never on the HTTP status.
- **Changing when a batch locks, or what an admin may edit on it** → four places move together:
  `batch_is_past()` ↔ `batches_guard()` ↔ `admin_update_batch()`'s validation chain ↔
  `isPastBatch()`/`validateBatchEdit()` in `src/lib/batchLifecycle.js`
  (`test/batchLifecycle.test.mjs` + `test-db/batchLifecycle.dbtest.mjs` pin both halves). If a new
  editable column is added, it also needs a `grant update (…)` in #38's column-privilege block —
  otherwise the write silently 42501s for every admin.
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
