# Product-Engineering Stabilization Audit — 2026-07-12

**Scope:** full-application audit + stabilization pass on branch `feat-plan-entitlements` (on top of the
in-flight plan-entitlements feature, which ships in the same branch). Covered: UI components & states,
auth, roles/permissions, subscription lifecycle, plan entitlements, upgrade/extension workflows, payment
receipts, admin approval workflows, course platform CRUD + access control, navigation/deep links, all
SQL migrations + RLS + storage policies, all API routes, and docs-vs-code drift.

**Method:** three parallel deep-read passes (frontend surface of `src/BookkeeperPro.jsx` ~20.5k lines;
every file in `db/` + `api/`; auth/client infra + all setup docs), findings verified against source
before any fix, then fixes applied in priority order (security → workflows → UI → docs).

**Verification baseline:** there is **no test suite and no linter in this repo — by design** (see
CLAUDE.md). The automated gate is `npm run build` (Vite); everything else is manual smoke testing in
`npm run dev` in **both themes**. Build was run after every phase of this pass — all green (§7).

---

## 1. Verified working (checked, no change needed)

These were explicitly audited and found **sound** — listed so future audits don't re-litigate them.

- **Root gate order** (`BookkeeperProToolkit`): loading → recovery → no-user → profile-not-ready →
  rejected (outranks paywall — a ban can't be paid around) → enrollment gate (pending / expired /
  paywall / pass) → legacy pending-approval → app shell. No state renders the toolkit for an
  unauthenticated or unpaid non-admin user.
- **Entitlement chokepoint**: the `visitedTabs.map` render is the single enforcement point — a
  disallowed tab reached ANY way (deep link, popstate, stale `nav:lastTab`, programmatic goto) renders
  `RestrictedTab`, never the tool. **No bypass found.** Sidebar/tile filtering is cosmetic on top.
- **RLS — no self-escalation:** `profiles` has NO non-admin INSERT/UPDATE policy, so a student cannot
  flip `is_admin`/`is_paid`/`plan`/`approval_status`; the signup trigger ignores user-supplied role
  metadata. `enrollment_requests`/`subscriptions` are own-row-select only (no cross-user reads); the
  only student UPDATE is self-expiring an overdue pending row (`WITH CHECK` forces `status='expired'` —
  no path to `approved`). Subscriptions have no student write path at all (RPC-only).
- **Receipt privacy:** `enrollment-receipts` is private; uploads are constrained to the caller's own
  `<uid>/…` folder; reads are own-folder-or-admin; no UPDATE policy (immutable); delete admin-only.
  User A cannot read user B's receipt. Admin preview uses `createSignedUrl` (600 s).
- **Paid-video privacy:** `course-videos` is private; read = admin OR (`is_enrolled()` AND plan-scope —
  the qbo-only / sampler-essentials rules); write/delete admin-only. Playback via short-lived signed URLs.
- **RPC security:** `approve_subscription`, `approve_extension`, `expire_overdue_subscriptions`,
  `record_enrollment_notification` and all helpers are `SECURITY DEFINER` with **internal admin/owner
  guards** and **pinned `search_path = public`**; `revoke public / grant authenticated`. A student
  calling any grant RPC gets an exception.
- **Lifecycle math:** renewal stacking = `greatest(now, ends_at) + access_days` (early renewal never
  loses days); supersede-then-insert runs in one transaction under `FOR UPDATE` (the one-active partial
  unique index can't be violated mid-flight); expired-member extension starts from approval time;
  legacy no-expiry terms are never converted into shorter dated terms; grace = term end + 3 days.
- **Bootstrap coherence:** `db/000_full_database_bootstrap.sql` is the collapsed final state of the
  dated chain #1–#21 (verified object-by-object: `access_tier`, `request_kind`/`extension_days` +
  range CHECK, plan-scope helpers, grace-3 `approve_subscription`, capped `approve_extension`,
  plan-scoped read policies, private buckets). Run order is documented in `db/README.md`.
- **API auth model:** all three serverless functions authenticate with the **caller's JWT + RLS** —
  no service-role key anywhere in the codebase (small blast radius). Email HTML interpolation is
  escaped everywhere (no injection). The notify `submitted` action builds content from the DB row,
  never the request body, and proves ownership via an RLS-scoped fetch — content spoofing is not possible.
- **Course platform CRUD:** create/duplicate/delete/cover/reorder/tier (catalog) and
  module/lesson/video CRUD (engine) are admin-gated in UI **and** by RLS; `removeMediaIfUnreferenced()`
  keeps files on any query error (never deletes a duplicate's shared media); duplicate rollback-deletes
  on child-insert failure.

## 2. Broken → fixed in this pass

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | **Admins saw "Plan: free / Status: No plan"** in Profile & Settings (the reported screenshot bug) | `ProfileSettingsModal` never received the `showBilling` gate the `AccountMenu` applies, and its "View membership" button routed admins into the (menu-hidden) membership modal | Modal now takes `showBilling` (admins see `Role: Administrator` instead of billing facts, no "View membership"); the root also short-circuits the `membership`/`extend`/`upgrade` account views for admins, so no future menu regression can reopen billing UI for an account with no subscription |
| 2 | Admin-alert email **replayable** — re-POSTing `action:'submitted'` with the same requestId sent duplicate admin emails (inbox spam / Resend quota burn) | No dedup between the pending-status check and the send | `api/notify-enrollment.js` now skips with `{ skipped: 'already_notified' }` once the row's `notify_status` is `'sent'`. Failure states stay retryable; resubmits/upgrades/extensions insert NEW rows so legit flows still alert. Row fetch is column-resilient for pre-#16 installs |
| 3 | Claude proxy: membership check **failed open silently**, and nothing limited token spend per user | `callerEnrolled` returned `null` on any RPC error with no logging; no rate limiting existed | Fail-open kept (availability) but now logged loudly (`[anthropic-proxy] is_enrolled indeterminate — failing open`); added a per-user rate limit (20 req/min, per warm instance, 429 with a friendly message that surfaces through `callClaude`'s existing error path) |
| 4 | `approve_extension` trusted the **student-declared** `extension_days` with no upper bound (only `>= 60`) | #20 shipped minimum-only validation; the request-insert RLS policy validates nothing | **Migration #21** (`db/2026-07-11-hardening.sql`): RPC now rejects outside **60–365 days**, plus a guarded range CHECK on `enrollment_requests.extension_days`; bootstrap + db/README updated in lockstep; client mirrors the cap (Extend modal max 12 months; admin RPC-fallback clamps) |
| 5 | A stalled profile fetch could **pin the whole app on the splash screen** (root gate waits on `profileReady`, fetch had no timeout) | `AuthProvider`'s profile load had no timeout/retry, unlike `useEnrollmentGate`'s 7 s race | Fetch now raced against an 8 s timeout with one retry, then fails open (`profile=null`, ready) — RLS + the enrollment gate remain the boundary |
| 6 | `window.__setStorageUser` was only defined inside `if (!window.storage)` — if `window.storage` ever pre-existed, per-user storage namespacing silently no-opped | Definition scoped inside the guard | A no-op fallback is installed unconditionally in `main.jsx`; the real implementation overwrites it |
| 7 | **Sidebar expiry warning turned amber at ≤ 14 days** while every other student-facing surface (menu pill, Dashboard panel) uses ≤ 5 | Two thresholds evolved independently | Policy adopted and enforced: **student-facing = amber ≤ 5 / red ≤ 3 (+ grace state); admin views keep 14 days as review lead time and now say so** (chip renamed "Expiring ≤ 14d" with an explanatory tooltip) |
| 8 | Admin screens looked prototype-grade: `text-emerald-*`/`text-red-*` banner literals and `bg-white` hand-rolled modals (broken in dark mode), **no dialog roles/focus management on 4 admin modals**, no loading skeletons, a 12-chip single-row toolbar, misaligned flex-wrap rows, literal `#34C759`/`#E04545` button gradients | The two admin screens predate the design-token/theme pass and never adopted the shared modal | **Full unification**: shared `AccountModal` generalized (`tone`/`canClose`/`headerAction`/`bodyClass` + centralized focus trap + focus restore — every modal in the app now has `role="dialog"`, Escape, backdrop-close, Tab trapping); new shared `AdminNotice`/`AdminFilterChip`/`AdminFilterCaption`/`AdminListSkeleton`/`AdminUserCell` + `ADMIN_BTN_OK`/`ADMIN_BTN_DANGER` consts on new `--green-hi`/`--red-hi`/`--green-glow` theme tokens; both screens converted (grid-aligned rows, skeleton first-load, two labeled toolbar rows: Requests / Memberships); all 4 hand-rolled modals now use the shared shell |
| 9 | Dashboard `MembershipPanel` **flashed in** (rendered null while loading) | No loading state by design (fail-silent) | Fixed-height glass skeleton during first load; errors stay fail-silent (no panel, no skeleton) |
| 10 | Dashboard stat claimed **"42 Pro Tools"** — invented number | Hard-coded string | All three stats now derived from real data: `TOOL_COUNT` (from `TAB_ROUTES` minus Home/admin/alias = 32), `Object.keys(COA_INDUSTRY).length` (17), `VENDOR_PATTERNS.length` (62) |
| 11 | Dead code/docs: commented ClientPortalDemo tile; CLAUDE.md/README still listed the removed tool | Removal in `0f5a9db` left remnants | Tile deleted; doc mentions removed (§ doc sync) |
| 12 | Paywall rendered 5 pricing cards in a 3-column grid — orphan row hugged left | Grid, not flex | Centered flex-wrap (same column widths; orphan row centers). Applies to renewal + upgrade modes too |

## 3. Hard-coded values & product decisions surfaced (documented, intentionally not "fixed")

- **Grace = 3 days is duplicated in four places** (`approve_subscription`, `approve_extension`, the
  #18 backfill, and the client fallback in `doApprove`). Accepted duplication — a SQL refactor was out
  of scope; change all four together if the knob ever moves.
- **Renewing while in grace restarts from `now()`** — the remaining grace days are forfeited (the new
  term starts at approval, not at the old grace end). Product decision, not a bug.
- **`one_pending` unique index is kind-agnostic** — one pending request per user of ANY kind
  (new/renewal/upgrade/extension). Intentional (prevents clashing simultaneous requests) and documented
  in #20 + db/README.
- **Warning-threshold policy** (adopted this pass): students see amber ≤ 5 days / red ≤ 3 / a grace
  state; admin membership views use ≤ 14 days as lead time, labeled as such.
- **Plan scope rules live in TWO places by design**: client `PLAN_ENTITLEMENTS` (UX) and the SQL
  helpers `plan_is_qbo_only()`/`plan_is_sampler()` + `qbo-%`/`access_tier` policies (enforcement).
  Keep them in sync when entitlements change (CLAUDE.md documents this).
- **In-code fallbacks** for `enrollment_plans` (5 plans with ₱ prices/durations) and
  `payment_settings` (real bank/GCash numbers + owner email, also present in the SQL seed) exist so
  the paywall renders before/without DB rows. The DB rows are authoritative and admin-editable in-app;
  the fallbacks are last-resort copies that will drift if prices change — update them together.
- **The AI proxy and `feature_guides` are `is_enrolled()`-gated but NOT plan-scoped** — any active
  member of any plan can use AI tools and see feature guides. Documented residual of the entitlements
  design (acceptable: AI spend is membership-gated).
- `standalone/index.html` is a **legacy Google-Apps-Script build** (Tailwind CDN, old nav, key in
  browser) — not production-equivalent; do not ship it as the app.

## 4. Residual risks (known, documented, NOT fixed in this pass)

1. **Legacy paid lesson videos uploaded before the private-bucket split remain world-readable** under
   public `course-media/lessons/*` until manually moved to `course-videos` (ops task — see
   `db/2026-07-08-course-videos-private.sql` "AFTER RUNNING" notes). Until then, protection for those
   files is path obscurity only.
2. **The proxy rate limit is per-warm-instance** (serverless) — it stops runaway loops and scripted
   bursts, not a distributed abuser. Real cost controls remain membership gating + the max_tokens cap.
   A durable limiter would need external state (e.g. a Supabase counter table or Upstash).
3. **`payment_settings` is readable by every authenticated user** — bank/GCash numbers are meant to be
   shown to students; this also exposes `notify_email` (the owner's personal email) to any signed-in
   account. Minor info disclosure; move alerts to `NOTIFY_ADMIN_EMAIL` (env) to keep the address out of
   the DB if desired.
4. **Admin email endpoints send to arbitrary addresses** (`decision` actions take `body.email`) — this
   is admin-gated, so it's an admin-trust issue only; noted for completeness.
5. **Extension/plan amounts are not server-verified against the plan price** — `amount_paid` is
   student-declared and verified by the human admin against the receipt (that IS the manual-review
   design). #21 caps duration; price verification stays manual.
6. **`lesson_progress`/`course_completions` have no admin read policy** — admins can't see student
   progress via RLS. Fine today (nothing in the UI needs it); add an admin-select policy if a progress
   dashboard is ever built.

## 5. Incomplete / future work (roadmap, not defects)

- `FREE_TABS` free-preview mode (seam comments remain at the render switch).
- Stripe/Gumroad webhook to grant subscription terms without manual review.
- Cross-device cloud sync for tool data (namespaced localStorage → Supabase).
- Per-tool code splitting (deferred by the single-file rule — Phase 3 of the roadmap).
- A durable (cross-instance) AI rate limiter (see §4.2).
- Moving the legacy `course-media/lessons/*` videos (ops task, §4.1).

## 6. QA test matrix

Legend for **Verified**: `build` = compiles & type-safe by usage; `dev` = manually exercised in
`npm run dev` this pass; `prod-only` = requires the Vercel deploy (serverless email/proxy) or SQL-editor
date tampering — run after deploy; `—` = not yet run (listed so it's explicit).

### 6.1 Admin persona

| # | Step | Expected | Verified | Notes |
|---|------|----------|----------|-------|
| A1 | Sign in as admin | Dashboard; no MembershipPanel; no "Access until" sidebar line | dev | |
| A2 | Open ⋮ account menu | Profile & Settings + Log out only — no Membership/Upgrade/Extend, no plan/status header row | dev | `showBilling=false` |
| A3 | Open Profile & Settings | Name, Email, **Role: Administrator** — no Plan/Status/"View membership" | dev | Fix §2.1 |
| A4 | Access Requests: first load | Skeleton cards (no bare spinner), then list or dashed empty state | dev | |
| A5 | Approve / reject a signup | Status pill updates from DB value; green notice with email suffix; reject modal = shared shell (Escape/backdrop/focus-trap, blocked while busy) | dev | |
| A6 | Enrollments: toolbar | Two labeled rows — Requests (8 chips) / Memberships (4 chips + Sound/Test/Test email/Refresh); "Expiring ≤ 14d" chip has tooltip | dev | |
| A7 | Enrollments: approve **new/renewal/upgrade** | Approve modal (ok tone) shows package/scope/amounts + projected end + 3-day grace line; approval grants dated term, flips profile cache, marks request | dev (new) / build (upgrade path shares `doApprove`) | Logic untouched this pass |
| A8 | Enrollments: approve **extension** | Kind-aware title; "Adds N days … from current expiry" projection; RPC `approve_extension` stacks days | build | Same `doApprove` branch, presentational-only changes |
| A9 | Receipt preview | Signed URL; image in shared modal (wash body, "Open full size"); PDF opens new tab | dev | |
| A10 | Test email / sound toggle / chime test | Diagnostic result banner; chime plays after opt-in | prod-only (email) / dev (sound) | Email fn is Vercel-only |
| A11 | Dark mode pass on both admin screens | Banners, chips, modals, buttons all legible (token colors) | dev | |
| A12 | Non-admin opens `/admin/*` deep link | "Admins only" card (component guard) + no admin nav items | dev | RLS blocks the data regardless |

### 6.2 Student — new signup → member

| # | Step | Expected | Verified |
|---|------|----------|----------|
| S1 | Sign up (email or Google) | Pending screen (or paywall when enrollment gate on) — never the toolkit | dev |
| S2 | Paywall | 5 plan cards (centered rows), live `enrollment_plans` or fallback, ₱ prices, payment instructions from `payment_settings` | dev |
| S3 | Submit proof (receipt ≤ 5 MB png/jpg/webp/pdf) | Row inserted `pending_review`; pending screen; admin alert fires once | dev (insert) / prod-only (email) |
| S4 | Admin approves | Realtime unlock (no reload); MembershipPanel shows plan, dates, days left, chips | dev |
| S5 | Plan scoping — core_self_paced | Sidebar = Home + Training only; other tabs' deep links → RestrictedTab; only `qbo-*` courses load (RLS) | dev (client) / prod-only (RLS spot-check) |
| S6 | Plan scoping — sampler | Home + QBO catalog (Essentials-tier cards only) + both booking tabs; Mastery card hidden AND row denied server-side | dev (client) / prod-only (RLS) |
| S7 | Plan scoping — silver/gold/vip/unknown | Full toolkit | dev |
| S8 | Student cannot see admin UI | No Access Requests/Enrollments nav; `accessrequests`/`enrollments` routes → admins-only card | dev |

### 6.3 Student — expiring / expired

| # | Step | Expected | Verified |
|---|------|----------|----------|
| E1 | 6 days left | No warning anywhere (calm) | — (needs SQL date tamper) |
| E2 | 5 days left | Amber: menu pill "Expiring soon", panel banner, sidebar date line — all three agree | — (same) |
| E3 | 3 days left | Red on the same three surfaces; Renew promoted | — (same) |
| E4 | Term ended, in grace | Red grace state naming the grace end date; access still works | — (same) |
| E5 | Past grace | MembershipExpiredScreen: Renew / **Extend the same plan** / Check status / Sign out; paid tools unreachable | — (same) |
| E6 | Expired user renews/extends | Request → pending screen (kind-aware copy) → admin approval → term from approval date | build |
| E7 | Member with pending renewal | Keeps full access; panel shows "renewal under review" pill | dev |

### 6.4 Subscription lifecycle (SQL-level)

| # | Step | Expected | Verified |
|---|------|----------|----------|
| L1 | Early renewal | New term stacks from current `ends_at` | code-read (§1) |
| L2 | Extension while active | Same plan, `+extension_days` from current expiry, 3-day grace | code-read |
| L3 | Extension when expired | Starts from approval time | code-read |
| L4 | Extension > 365d or < 60d | RPC raises (after #21 is run) | prod-only (needs #21 in Supabase) |
| L5 | Extension on lifetime term | No-op — never shortens unlimited access | code-read |
| L6 | Re-approve same request | Idempotent (returns existing term) | code-read |
| L7 | Second pending request | Blocked by `one_pending` unique index (23505 → friendly client message) | dev |

### 6.5 Payments & notifications

| # | Step | Expected | Verified |
|---|------|----------|----------|
| P1 | Replay `action:'submitted'` for an already-alerted pending row | `{ ok:false, skipped:'already_notified' }`, no email | prod-only (new fix — test after deploy) |
| P2 | Fresh submission | One admin email; row stamped `notify_status='sent'`; green NotifyBadge on the card | prod-only |
| P3 | Unconfigured email env | Skip stamped + amber badge; student flow never blocked | prod-only |
| P4 | Student A fetches student B's request/receipt | RLS denies (no rows / no signed URL) | code-read (§1) |
| P5 | Student calls `approve_subscription`/`approve_extension` | Exception `admin only` | code-read |
| P6 | 21 rapid AI calls by one user | 21st gets 429; tool shows the error state | prod-only (dev proxy has no auth path) |

### 6.6 Course platform

| # | Step | Expected | Verified |
|---|------|----------|----------|
| C1 | Admin: create/duplicate/delete course, upload video/cover, reorder, set Sampler tier | All work from the catalog ⋮ menu; delete never removes media still referenced by a duplicate | dev (spot) |
| C2 | Student: `?course=<id>` deep link to a disallowed course | RLS returns no row → "coming soon" empty state; client guard shows "not part of your plan" panel | dev (client) |
| C3 | Paid lesson video | Plays via signed URL; direct public URL 400s (private bucket) | prod-only |
| C4 | Progress + certificate | Lesson completion persists per user; certificate PDF downloads | dev (previously verified feature — unchanged this pass) |

## 7. Verification record

- **Baseline build (before any change):** `npm run build` ✓ 32.03 s — main chunk 756.99 kB / 190.00 kB gzip
  (pre-existing >500 kB chunk warning — the documented single-file trade-off, unchanged).
- **Build after Phase 1 (security):** ✓ green → **Commit A `8ff3dea`** (`api/notify-enrollment.js`,
  `api/anthropic/v1/messages.js`, `src/auth/AuthProvider.jsx`, `src/main.jsx`).
- **Build after Phase 2 (workflow fixes):** ✓ green.
- **Build after AccessRequests conversion:** ✓ green.
- **Build after AdminEnrollments conversion:** ✓ green.
- **Build after Phase 3 complete (skeleton + paywall grid):** ✓ green.
- **No test suite / linter exists** (by design) — the QA matrix above is the manual gate; rows marked
  `prod-only` or `—` must be exercised on the Vercel deploy / with SQL-editor date tampering after the
  Supabase migrations are run.
- **Deploy prerequisites for this branch:** run migrations **#17 → #18 → #19 → #20 → #21** in order in
  the Supabase SQL editor (each is guarded and idempotent), then deploy. `#21` is new in this pass.
- **Out-of-scope literal-color hits** remain in OTHER tools (course builder internals, StatementConverter
  result table, etc. — `bg-white rounded-2xl`/`text-emerald-*` matches outside the two admin screens).
  Those utilities are covered by the dark compat layer in `index.css`, so they are not dark-broken;
  they are simply not yet migrated to tokens. Cosmetic-debt only — left for opportunistic cleanup.
