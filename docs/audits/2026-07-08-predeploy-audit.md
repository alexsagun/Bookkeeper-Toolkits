# Pre-Deployment Product Audit — Bookkeeper Toolkits

**Date:** 2026-07-08 · **Branch:** `main` (11 commits unpushed) · **Auditor:** automated multi-agent + live build/smoke + manual verification
**Method:** `npm run build` + dev/preview HTTP smoke + static analysis of 10 monolith slices (all gate/screen components + 13 core tools) + 3 deep recon reports (build/backend/database) + manual code verification of all release blockers. **No** browser automation, **no** writes to live Supabase — role flows verified by tracing gate logic in source.

> ⚠️ **Coverage caveat (read first).** The exhaustive fan-out was interrupted by an account session limit. **10 of 37** analysis agents completed: all gate/screen components (S1–S4) and 13 core tools (T1–T6). The remaining **17 tool slices (T7–T23)** — proposals, engagement letter, email templates, invoices, most calculators, QB Diagnostic, Budgeting/Forecasting, SOP, etc. — were **inventoried by recon but not deep-audited**. The 7 infra agents and 3 role-flow agents also did not run, **but their scope was substantially covered by the 3 prior recon reports**, which read the API layer, RLS, and migrations in depth. **All release blockers below were manually verified.** The 77 Medium/Low findings from the fan-out are **evidence-cited but not adversarially re-verified**. A resume pass (see §J) will close these gaps.

---

## A. Executive Summary

**Overall readiness: 58 / 100** — *Not deployable as-is; a focused blocker-fix pass clears it.*

| Question | Verdict |
|---|---|
| **Ready to commit?** | **Yes, with one 10-second fix** — add `build_output.txt` to `.gitignore` (or delete it) first so the stale build log isn't committed. The working tree is otherwise coherent (dark-mode tokens + enrollment "Test email" feature; nothing half-finished). |
| **Ready to deploy to Vercel?** | **No.** One **Critical** and five **High** issues are release-blocking. None are deep architectural problems; all are bounded and fixable in ~1–2 focused days. |
| **Build status** | ✅ Passes (exit 0, 34 s). Main chunk **694.6 kB raw / 174.6 kB gzip** (over Vite's 500 kB warning, but improved from the stale 783/242). |

**Biggest release blockers**
1. 🔴 **CRITICAL — Unauthenticated AI proxy.** `/api/anthropic/v1/messages` accepts any POST and spends your `ANTHROPIC_API_KEY` with no auth, rate limit, or model/token cap. Publicly reachable once deployed → open-ended billing abuse.
2. 🟠 **HIGH — Paywalled course videos are world-public.** The `course-media` bucket is `public read`; every lesson video/cover is fetchable by anyone with the URL. The paywall is path-obscurity, not access control.
3. 🟠 **HIGH — Course-media deletion can destroy shared files.** `removeMediaIfUnreferenced` treats a *failed* reference-check query as "zero references" and deletes every candidate — including videos reused by duplicated courses.
4. 🟠 **HIGH — BankFeed miscodes transactions.** With ≥2 AI-unmatched lines, the merge attaches suggestions to the wrong rows and silently drops others — a bookkeeper acts on wrong account codes.
5. 🟠 **HIGH — Enrollment receipt upload is keyboard/screen-reader inaccessible.** The mandatory payment-proof control can't be operated without a mouse → keyboard/AT users can't complete (or pay for) enrollment.
6. 🟠 **HIGH — Per-user sidebar customization silently reverts** every reload (storage-namespace race), and can leak one user's layout to another on a shared browser.

**Security-adjacent Mediums worth fixing before or right after launch:** `payment_settings` (bank/GCash numbers) readable by *any* authenticated user incl. rejected accounts; students can delete their own receipt after submitting; `xlsx@0.18.5` prototype-pollution/ReDoS on the statement-upload path; enrollment-notification email has no rate limit.

---

## B. Feature Inventory

Status legend: **Complete** (reachable, no findings) · **Partial** (works, has Medium+ gaps) · **Broken** (statically-proven defect on the main path) · **Risky** (main path depends on a High-flagged contract) · **Untested** (couldn't establish statically; no live browser/DB) · *not deep-audited* (recon-inventoried only — see coverage caveat).

### Auth / gates / screens — deep-audited ✅
| Feature | Status | Note |
|---|---|---|
| AuthProvider (session/revoke/profile ladder/legacy-migration) | Complete | One Low edge: revoked cached account can claim the one-time legacy-migration marker (S1-F3). |
| AuthScreen (login/signup/reset + Google + unconfirmed-email) | Partial | Hand-rolled status rgba tints (dark-mode), placeholder-only inputs (a11y). |
| UpdatePasswordScreen · PendingConfirm | Partial | Recovery/resend flows correct; same tint + label gaps. |
| PendingApprovalScreen | Partial | Realtime+poll wired; manual "Check status" shows no error state (reads as "still pending" on failure). |
| RejectedScreen | Partial | Correct + outranks paywall; hand-rolled tints. |
| EnrollmentPaywall | **Partial (High)** | Receipt upload keyboard-inaccessible (**S2-F1**); overdue self-expire ignores its error → silent resubmit loop; silent stale fallback pricing; tints; labels not associated. |
| EnrollmentPendingScreen · MembershipExpiredScreen | Partial | Realtime+poll correct; `h-screen` card has no scroll container (top clipped on short viewports); expired-pill tints; support mailto hard-codes a personal Gmail. |
| AccessRequests (admin) | Complete | Full async coverage; only Low polish (tints, unlabeled X buttons). |
| AdminEnrollments (admin) | Partial | Approve/reject/expire robust; "Save note" has no busy state; receipt-view no spinner + PDF popup-block risk; tints. |
| MembershipPanel | Partial | Fail-silent by design; support mailto ignores admin-editable `payment_settings.notify_email`. |
| BookkeeperProToolkit root (routing/keep-alive/gate order) | **Partial (High)** | Gate order matches spec; **sidebar persistence race (S3-F1)**; Customize drag-drop can drop a tab into a group where it renders nowhere (S3-F2) and grouped-stage reorder is a silent no-op (S3-F3); `resetSidebarLabels` uses `window.confirm`. |
| TabPanel keep-alive · renderToolContent switch | Complete | Memo invariant holds (all props referentially stable); all 33 cases resolve; TAB_ROUTES parity confirmed. |

### Tools — deep-audited ✅ (T1–T6)
| Feature | Status | Note |
|---|---|---|
| Dashboard | Partial | White inset shadows break dark theme on the landing screen; "42 Pro Tools" stat is stale/invented; roadmap uses `md:grid-cols-7` for 3 tiles. |
| Chart of Accounts generator | Partial | 4 of 17 industries emit **duplicate account numbers** into the "QBO-ready" CSV; **Entity Type select has zero effect** on output. |
| Accounting 101 (Course) | Partial | Progress is in-memory only → **resets on refresh**; nested `<button>` in `<button>`. |
| CourseProgram (video engine + certificate) | Partial | Dark-mode white player card; silently-ignored progress/completion query errors → false "0% / certificate locked"; close-during-upload resurrects an id-less draft; `window.confirm` dialogs; orphaned-upload storage leak; print certificate loads no web fonts. |
| CourseCatalog (+ QBOMastery/ResumeStrategy/InterviewStrategy) | **Risky** | Browse/open solid; **delete/cover depend on the data-loss helper (T3-F1)**; reorder/count queries ignore `{error}`; interview-catalog deep links defeated by `nav:interviewSub` restore; browser-Back leaves stale grid. |
| BankFeed AI categorizer | **Broken** | **AI-suggestion misassignment with ≥2 unmatched lines (T4-F1)**; unused amount-regex captures the date. |
| Statement→CSV converter | Partial | Two native `alert()`s; dark-mode white drop zone; no file-size guard before base64-POST (serverless body ceiling); no truncation check on `max_tokens:4000` extraction; same-file re-upload no-ops; balance `0.00` renders "—". |
| ProChat (ProAdvisor) | Complete | AI path sound (try/catch + in-chat error bubble + loading); verified request shape against live API (HTTP 200). Low a11y only. |
| 1099 Prep | Partial | TY2025/2026 $600↔$2,000 toggle correct; **checklist progress resets on refresh** (a multi-day workflow); dead emerald done-row CSS; stale penalty figure. |
| Sales Tax guide | Complete | Static content; one Low data-staleness note (200-transaction nexus rule). |
| Client Onboarding | Partial | Accurate content; **2-week checklist progress resets on refresh**. |
| Depreciation calculator | Partial | *Not orphaned* (sub-rendered in AccountingCalculators, default tab). Formulas correct; **"Placed in Service" date has zero effect** (no first-year convention); no input guard (negative/NaN schedules); mobile table clips. |
| Loan Amortization calculator | Partial | *Not orphaned* (sub-rendered). Formula correct; **empty Term → "$NaN" cards**; **schedule month labels drift** (UTC date parse + `setMonth` overflow) and the wrong dates export to CSV. |

### Tools — inventoried by recon, *not deep-audited* (T7–T23)
Recon confirmed these exist, are wired into the nav, and contain **no half-finished markers** (no TODO/FIXME/`not implemented`). Treat status as **Untested** pending the resume pass:

InterviewPrep hub · JD Question Generator · Authentic Branding · Proposal Generator · Engagement Letter · Email Templates · Salary Negotiation · Pain Points Generator · Industry Accounting · US Tax 101 · Monthly Workflow · Month-End Checklist · Year-End Checklist · Invoice Creator · Booking Page ("link coming soon" copy) · Coach Alex Chat · CPA AI Chat · the 5 calculators (Prepaid/SalesTax/Markup/BreakEven/Mileage) · Niche Selector Quiz · LinkedIn Optimizer · Mock Interview Simulator (guide-video gated) · Discovery Call Simulator · SOP Generator · Client Health Score · Monthly Review Call · Price Raise Toolkit · Upsell Path · Difficult-Client Playbook · Time Tracker · Capacity Planner · Payment Tracker · PH/US Money Guide · Personal Finance Tracker · QB Diagnostic · Budgeting Tool · Forecasting Tool · Form Sales Tax.

### Confirmed dead code
- **ClientPortalDemo + 6 Portal\* children** (~450 lines, `BookkeeperPro.jsx` 11472–11917) — unreachable; nav mounts commented out; still shipped in the bundle. (recon R8)

---

## C. Critical & High Blockers

### 🔴 C1 — Unauthenticated Anthropic proxy *(Critical · Backend · verified)*
- **Files:** [api/anthropic/v1/messages.js](../../api/anthropic/v1/messages.js) L14–43
- **Repro:** After deploy, `POST https://<domain>/api/anthropic/v1/messages` with any valid Messages API body and no credentials.
- **Actual:** Handler checks only `req.method` and `apiKey` presence, then forwards to Anthropic with the server-side key. No JWT/session check, no origin/referer check, no rate limit, no model allowlist, no `max_tokens`/body-size cap.
- **Expected:** Only authenticated app users can invoke it, with sane caps.
- **Root cause:** Proxy was built purely to hide the key, not to gate access.
- **Fix:** Require a Supabase JWT (verify via `${SUPABASE_URL}/auth/v1/user` with the caller's bearer, as `api/notify-access.js` already does) → 401 if absent/invalid; add a model allowlist + `max_tokens` ceiling + body-size limit; add a lightweight per-user/IP rate limit. Optionally gate on `is_enrolled()` so only paying members consume tokens.
- **Verify fix:** unauthenticated POST → 401; authenticated POST with an over-cap `max_tokens` → 400; normal in-app AI tools still work.

### 🟠 C2 — `course-media` bucket is world-public read *(High · Storage · recon-verified)*
- **Files:** [db/2026-06-16-course-platform-storage.sql](../../db/2026-06-16-course-platform-storage.sql) L35–36 (`for select to public using (bucket_id='course-media')`); bootstrap L264–265.
- **Repro:** Copy any lesson video URL (`getPublicUrl`) and open it signed-out.
- **Actual:** Every paid-course video and cover is world-readable; RLS on `course_lessons` only hides the *path*, not the *bytes*.
- **Expected:** Only enrolled users can stream paid content.
- **Fix:** Make the bucket **private**; serve videos via `createSignedUrl` behind an `is_enrolled()` check (the app already uses signed URLs for `enrollment-receipts`, so the pattern exists). Note this is a **business-model** breach (content leakage), not a PII breach.
- **Verify fix:** signed-out GET of an object URL → 403; enrolled user still plays lessons.

### 🟠 C3 — `removeMediaIfUnreferenced` deletes shared files on a swallowed query error *(High · Data-loss · verified)*
- **Files:** [src/BookkeeperPro.jsx](../../src/BookkeeperPro.jsx) L7330–7353
- **Repro:** Admin deletes course A whose videos are reused by duplicated course B; during the delete the reference-check SELECT returns a PostgREST error (expired JWT, 5xx, schema-cache miss).
- **Actual:** The code destructures only `data`, never `error`. supabase-js v2 returns query errors as `{data:null,error}` *without throwing*, so the `try/catch` "keep the files" guard (L7345) never fires. `referenced` stays empty → **all** candidate paths (incl. B's shared videos) are deleted from the public bucket. No soft-delete, no recovery.
- **Expected:** On a failed check, keep the files (as the code's own comment states).
- **Fix:** `const [{data:lh,error:le},{data:ch,error:ce}] = await Promise.all(...); if (le||ce){ console.error(...); return; }`
- **Verify fix:** simulate a reference-check error (bad table name) → no `storage.remove` call fires.

### 🟠 C4 — BankFeed AI-suggestion misassignment *(High · Correctness · verified)*
- **Files:** [src/BookkeeperPro.jsx](../../src/BookkeeperPro.jsx) L7947–7965
- **Repro:** Paste ≥2 bank memos that miss `VENDOR_PATTERNS` (common with local vendors); run Analyze.
- **Actual:** The merge sets `merged[targetIdx].needsAI=false` as it iterates, while the *next* iteration re-derives its target by counting `needsAI` rows in the same mutated array. With unmatched rows a<b<c, suggestion #2 lands on row **c**, suggestion #3 is dropped, and row **b** stays "Pending AI…" forever. The misassigned account/vendor is rendered with full confidence.
- **Expected:** Each AI suggestion attaches to its own transaction.
- **Root cause:** Index derived from a live-mutated array.
- **Fix:** Precompute target indices before mutating: `const aiIdx=[]; initialResults.forEach((r,i)=>{ if(r.needsAI) aiIdx.push(i); }); ... const targetIdx = aiIdx[ai.i-1] ?? -1;`
- **Verify fix:** 3 unmatched memos → 3 correctly-mapped suggestions, none dropped.

### 🟠 C5 — Enrollment receipt upload is keyboard/screen-reader inaccessible *(High · A11y on revenue path · verified)*
- **Files:** [src/BookkeeperPro.jsx](../../src/BookkeeperPro.jsx) L2320–2330 (drop-zone `div` with `onClick` only; backing `<input type="file" className="hidden">`), block at L1989 (`if (!file) …`).
- **Repro:** Tab through the paywall form with a keyboard / use a screen reader.
- **Actual:** The upload zone is a non-focusable `div` (no `role`/`tabIndex`/`onKeyDown`); the file input is `display:none` (out of tab order). Keyboard/AT users cannot open the file dialog → `submit()` hard-blocks → **cannot pay for / complete enrollment**. Mouse/touch users unaffected.
- **Fix:** Add `role="button" tabIndex={0} aria-label="Upload payment screenshot"` + `onKeyDown` (Enter/Space → `fileInputRef.current?.click()`) to the drop-zone, or swap `className="hidden"` for the visually-hidden `sr-only` pattern so the native input stays focusable.
- **Verify fix:** keyboard-only user can attach a receipt and submit.

### 🟠 C6 — Per-user sidebar customization silently reverts *(High · State persistence · verified)*
- **Files:** [src/BookkeeperPro.jsx](../../src/BookkeeperPro.jsx) L3200–3236 (load effect, `[]` deps); [src/main.jsx](../../src/main.jsx) L27; [src/auth/AuthProvider.jsx](../../src/auth/AuthProvider.jsx) L167.
- **Repro:** Sign in (cached session), customize the sidebar (drag/collapse/rail), reload.
- **Actual:** The load effect runs on first mount and reads all `sidebar:*` keys **before** `applyStorageUser(uid)` runs (that fires only after `await getSession()`, in a parent effect that runs *after* the child mount effect). So reads hit the **bare** namespace while later user-interaction writes go to `u:<uid>:*`. Every reload reads bare → **customization is lost**; on a shared browser the bare layout can bleed across accounts.
- **Fix:** Gate the load on `[user?.id]` and bail when `!user?.id` (like the `nav:lastTab` effect), or have AuthProvider apply the cached uid synchronously before children mount.
- **Verify fix:** customize → reload → layout persists; second account on the same browser sees its own layout.

---

## D. Frontend / UI Issues (Medium & Low, unverified)

Grouped; all cite `src/BookkeeperPro.jsx` unless noted. Full evidence in the raw dataset.

**Dark-mode token violations** (hand-rolled light rgba tints that don't re-theme; CLAUDE.md: status colors "never hand-rolled rgba tints"): auth-family status callouts (S1-F2); MembershipExpired pill/chip (S2-F4); paywall error banner + drop-zone green (S2-F5); pending-screen icon chip (S2-F6); sidebar admin buttons/rail badges (S3-F5); admin screens red/amber status UI (S4-4); **Dashboard white inset shadows on the landing screen** (T1-F1); **CourseProgram white player card breaks dark mode** (T2-F1); StatementConverter white drop zone (T4-F4). *Impact: dim/low-contrast chrome in dark theme; needs the in-browser dual-theme QA the house rules require.*

**Accessibility** (pervasive, low individual severity, high cumulative): placeholder-only inputs without labels across auth, CoA, BankFeed, StatementConverter, ProChat, both calculators (S1-F5, T1-F9, T4-F12, T5-F5, T6-6); icon-only buttons without `aria-label` (banner dismissers, checklist toggles, course builder controls, catalog cover buttons — S4-5, T1-F6, T2-F6, T3-F6/F7, T5-F4); WelcomeOverlay lacks dialog semantics/Escape (S1-F6); nested interactive elements (Course, Customize rename — T1-F6, S3-F7); **two file-upload drop zones keyboard-inaccessible** (paywall C5 + StatementConverter T4-F9).

**Missing async/empty/error states:** PendingApproval manual-check has no error state (S1-F1); paywall stale fallback pricing shown silently (S2-F9); CourseProgram progress-load errors swallowed → false "0%/locked" (T2-F3); mark-complete/reorder have no busy state (T2-F7/F8); AdminEnrollments Save-note no busy state (S4-2); receipt-view no spinner (S4-3); BankFeed Analyze enabled on empty input, silent no-op (T4-F13); StatementConverter same-file re-upload no-ops (T4-F14); catalog reorder/count errors swallowed (T3-F3/F4); browser-Back leaves stale catalog grid (T3-F8).

**Native dialogs vs house glass-UI style** (comment at L9394-9395): `alert()` ×2 in StatementConverter (T4-F2/F3); Budgeting `alert()` ×2 (recon R10, not re-audited); `window.confirm` ×~8 (CourseProgram delete/leave, catalog delete, `resetSidebarLabels`); `window.prompt` ×1 (catalog "New course" — the only prompt in the app).

**Responsive:** EnrollmentPending & MembershipExpired `h-screen` cards have no scroll container → top clipped on short/landscape viewports (S2-F2); Dashboard roadmap `md:grid-cols-7` for 3 tiles leaves 4 empty columns (T1-F7); Depreciation table `overflow-hidden` clips columns on mobile (T6-5).

**Persistence gaps** (in-memory progress that resets on refresh — inconsistent with the rest of the app): Accounting 101 modules (T1-F4), 1099 checklist (T5-F1), Onboarding checklist (T5-F2). Each needs a `window.storage` key + a `LEGACY_KEYS` entry.

**Data correctness (content):** CoA duplicate account numbers + Entity-Type no-op (T1-F2/F3); Depreciation "Placed in Service" ignored (T6-3); Loan NaN + date drift (T6-1/T6-2); dead emerald done-row CSS (T5-F3); stale 1099 penalty (T5-F7), sales-tax nexus (T5-F8), 2026 mileage placeholder (recon R11, not re-audited); BankFeed 2024 sample dates (T4-F8); "42 Pro Tools" stale stat (T1-F5); Dashboard tiles ignore admin label renames (T1-F8).

---

## E. Backend / API Issues

| # | Sev | Issue | File |
|---|---|---|---|
| C1 | 🔴 Critical | Unauthenticated AI proxy (see §C1) | api/anthropic/v1/messages.js |
| R17 | Low | `notify-enrollment` `action:'submitted'` has no rate-limit/dedup → student can flood admin email | api/notify-enrollment.js L262 |
| — | ✅ | `notify-access` / `notify-enrollment` `decision`/`test` are correctly admin/owner-gated (JWT→`auth/v1/user`), all fields `esc()`-escaped, env-gated skips are non-fatal | api/notify-*.js |
| — | ✅ | `vercel.json` SPA rewrite `/((?!api/).*)` correctly excludes `/api/*`; proxy path matches the client fetch-shim target exactly (dev GET → 405 upstream, confirmed live) | vercel.json |

**Untested-local (serverless functions don't run under `vite dev`):** the notify functions' send/skip/error contract, the `test`-action admin-JWT verification, and the prod proxy's behavior vs the dev proxy. Verify on a Preview deploy.

---

## F. Supabase / Database Issues

| # | Sev | Issue | File |
|---|---|---|---|
| C2 | 🟠 High | `course-media` world-public read (see §C2) | db/2026-06-16-course-platform-storage.sql |
| R5 | Medium | `payment_settings_read` = `using(true)` → any authenticated user (incl. pending/rejected/unpaid) reads bank acct #, GCash #, account name, admin email | db/2026-07-04-enrollment.sql L229 |
| R6 | Medium | Students can **DELETE their own receipt** from `enrollment-receipts` after submitting (evidence loss); no UPDATE policy | db/2026-07-04-enrollment.sql L273 |
| R7 | Medium | `approve_subscription`: first-ever-approval race backstopped only by the unique index (2nd admin gets raw 23505); the client non-RPC fallback is non-transactional (expire→insert) and a mid-flight failure strands the user with no active sub | db/2026-07-04-subscription-lifecycle.sql + BookkeeperPro.jsx ~4817 |
| R15 | Medium | Migration-order fragility: `user-approval.sql` errors (42P01) if `feature-guides.sql` hasn't run (unguarded `drop policy`); COURSE_SETUP.md inlines **pre-gate permissive** policies that silently revert security if re-run after go-live | db/README.md, COURSE_SETUP.md |
| R16 | Low | Bootstrap creates `enrollment_requests_user_created` index that no dated migration creates → dated-chain installs lack it | db/000_full_database_bootstrap.sql L448 |
| — | ✅ | Docs↔SQL cross-check passed: every client table/column/RPC/bucket exists in SQL; realtime publication covers all subscribed tables; `enrollment-receipts` private with own-folder+admin policies; SECURITY DEFINER state-changers have internal admin guards | (recon) |

**Untested-local:** actual RLS enforcement, storage ACLs, realtime delivery, FK cascade, and RPC existence depend on the live project — verify against the deployed database.

---

## G. Performance Issues

- **Main bundle 694.6 kB raw / 174.6 kB gzip** — over Vite's 500 kB warning. Heavy libs (xlsx 429 kB, jspdf 358 kB, html2canvas 201 kB, supabase 211 kB) are correctly split into lazy/dynamic chunks. True per-tool splitting needs the single-file refactor (deferred, Phase 3). *Improved from the stale 783/242 via the data-bank extraction.*
- **`xlsx@0.18.5`** (recon R2) — prototype-pollution (CVE-2023-30533) + ReDoS (CVE-2024-22363), **no npm fix**. User-controlled spreadsheets reach `XLSX.read` in the statement/import path → real, not just advisory. Mitigate: vendor the fixed SheetJS CDN build, or validate/limit uploads.
- **`jspdf ≤4.2.0` → `dompurify` moderate** (from `npm audit`) — fixable only via breaking `jspdf@4`. jspdf is lazy-loaded (certificate PDF), so exposure is limited to admins/cert downloads.
- **Keep-alive memory:** `visitedTabs` is never pruned (deliberate — preserves in-flight AI work); worst case ≈ all tab trees mounted. Accepted trade-off; TabPanel memoization confirmed correct so hidden tabs don't re-render.
- **Main-thread freeze risks (static):** `XLSX.read` on large statements, `html2canvas` certificate capture, large `JSON.parse` of AI output — all synchronous. No file-size guard before base64-POSTing PDFs (T4-F5).

---

## H. Deployment / GitHub / Vercel Readiness

| Check | Result |
|---|---|
| Production build | ✅ exit 0, 34 s, `dist/` assets emitted + referenced |
| Dev smoke (`/`, SPA deep-link, proxy GET) | ✅ 200 / 200 / 405 (proxy routes without token spend) |
| Preview smoke (`/`, hashed JS+CSS) | ✅ 200 / 200 / 200 |
| `.gitignore` | ⚠️ `dist` ignored; **`build_output.txt` NOT ignored** — fix before `git add` |
| Unpushed commits | ⚠️ 11 ahead of `origin/main`; 7 files uncommitted (coherent WIP, nothing half-finished) |
| Secrets | ✅ none tracked; `.env` gitignored; anon key is public-by-design (RLS is the boundary) |
| Env vars documented | ✅ `.env.example` complete (`ANTHROPIC_API_KEY`, `VITE_SUPABASE_*`, `RESEND_*`, `NOTIFY_ADMIN_EMAIL`, `APP_URL`, feature flags) — server-only vs `VITE_`-public clearly labeled |
| No lint/test scripts | ⚠️ zero automated quality gate (documented as intentional) |
| Vercel routing | ✅ SPA rewrite excludes `/api`; no `functions` block → proxy runs at default timeout (long completions could truncate — consider `maxDuration`) |

**Env vars that MUST be set in Vercel before deploy:** `ANTHROPIC_API_KEY` (server), `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (public, needed at **build** time). Optional email: `RESEND_API_KEY`/`RESEND_FROM`/`NOTIFY_ADMIN_EMAIL`/`APP_URL`.

---

## I. Recommended Fix Plan (two-stage — matches chosen "blockers now, harden after")

### Stage 1 — Release blockers (do before deploy; ~1–2 days)
1. **Authenticate the AI proxy** (C1) — JWT check + model/`max_tokens`/body caps + basic rate limit.
2. **Lock down `course-media`** (C2) — private bucket + signed URLs gated on `is_enrolled()`.
3. **Fix the data-loss delete** (C3) — check `{error}` in `removeMediaIfUnreferenced`, keep files on failure.
4. **Fix BankFeed misassignment** (C4) — precompute AI target indices.
5. **Make receipt upload accessible** (C5) — `role`/`tabIndex`/`onKeyDown` or `sr-only` input.
6. **Fix sidebar persistence race** (C6) — gate the load effect on `user?.id`.
7. **`.gitignore build_output.txt`** (or delete) before committing.
8. **Tighten `payment_settings` read** (R5) and **remove the receipt self-delete policy** (R6) — small SQL, real exposure.

### Stage 2 — Harden after launch (prioritized)
- Payment/enrollment robustness: overdue self-expire error handling (S2-F3), approve-subscription race + non-transactional fallback (R7), enrollment-email rate limit (R17).
- Course/cert: swallowed progress-load errors (T2-F3), close-during-upload draft race (T2-F2), orphaned-upload cleanup (T2-F5), certificate print fonts (T2-F9).
- Data correctness: CoA duplicate numbers + entity no-op (T1-F2/F3), Loan NaN/date drift (T6-1/T6-2), Depreciation date convention (T6-3), stale tax figures (T5-F7/F8, mileage R11).
- Persistence: Accounting 101 / 1099 / Onboarding progress (T1-F4, T5-F1/F2) + `LEGACY_KEYS` sync (S3-F6/R9).
- Dark-mode token sweep (all D-section tint findings) + a11y label/keyboard pass.
- `xlsx` CVE mitigation (R2); dead-code removal (ClientPortalDemo, R8); native-dialog → glass-modal migration.
- Migration guardrails (R15/R16); COURSE_SETUP.md superseded-policy warning.

### Stage 3 — Complete the audit
Resume the interrupted fan-out (§J) to deep-audit T7–T23 and adversarially verify the 77 Medium/Low.

---

## J. Final Go / No-Go

- **Commit now?** **Yes** — after adding `build_output.txt` to `.gitignore` (or deleting it). The working tree is coherent; commit and push the WIP deliberately.
- **Deploy now?** **No.** Ship **Stage 1** first (1 Critical + 5 High + 2 quick SQL exposures). None are architectural; all are bounded.
- **Must fix first:** C1 (proxy auth) and C2 (course-media privacy) are non-negotiable — they're live financial/business-model exposures the moment the URL is public. C3–C6 are user-facing correctness/accessibility breaks on core paths.
- **Can wait until after launch:** the dark-mode token sweep, the a11y polish, content-staleness fixes, persistence gaps, dead-code removal, and the `xlsx` swap — real, but not release-blocking.

### Audit completeness ledger
- ✅ **Verified:** build/dev/preview live; all 6 blockers (4 fan-out Highs + C1 proxy + C2 course-media) read and confirmed in source.
- ⚠️ **Cited but not adversarially re-verified:** the 77 Medium/Low fan-out findings.
- ⛔ **Not yet audited:** 17 tool slices (T7–T23) — recon says no half-finished markers, but they had no dedicated defect pass; treat as **Untested**.
- **Untested-local (needs a running backend/deploy):** all serverless-function runtime behavior, live RLS/storage/realtime/email, AI response rendering, and in-browser dual-theme + responsive QA.

**Resume mechanism:** `Workflow({ scriptPath: "…/predeploy-audit-wf_8f802221-717.js", resumeFromRunId: "wf_8f802221-717" })` after the session-limit reset — the 10 completed agents replay from cache; only the 27 that failed (T7–T23, I1–I7, C1–C3) + verification + coverage re-run.
