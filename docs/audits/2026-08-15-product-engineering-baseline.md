# Product Engineering Baseline Audit — 2026-08-15

## Purpose and audit boundary

This document is the durable product and engineering context for **Ultimate Remote
Bookkeeper Toolkits** ("Get Hired With Alex"). It supports two jobs:

1. helping a product assistant convert a raw idea into an implementation-ready
   Claude Code prompt; and
2. helping an implementer identify the existing contracts that a feature must not
   accidentally bypass.

### Evidence reviewed

- The complete tracked-file inventory (203 files), excluding dependency and build
  output internals.
- Product/developer guidance: `README.md`, `CLAUDE.md`, setup guides, custom
  Claude skills, current and historical audits, and the cohort-entitlements design
  record.
- Application boundaries: `src/BookkeeperPro.jsx`, `src/main.jsx`, auth, all
  `src/lib` and `src/data` modules, all Vercel API handlers, scripts, tests, and
  the Supabase config/migration chain.
- Database architecture: the bootstrap schema, numbered migrations, migration
  audit script, RLS-oriented DB tests, and the migration run-order document.

### What this audit does not assert

This is a static repository audit plus local validation, not a production security
certification. It does not inspect `.env` values, query the live Supabase project,
send email, call Anthropic or ElevenLabs, or exercise a browser persona. Those
activities require the appropriate deployment environment and accounts.

## Product model

The product is a paid learning-and-delivery workspace for remote bookkeepers who
serve US clients. It combines career training, job-search tools, bookkeeping
delivery tools, a course platform, paid-member community, and admin operations.

The primary user states are:

| User state | Product experience | Enforcement source |
| --- | --- | --- |
| Signed out | Authentication and recovery screens | Supabase Auth |
| Pending/rejected | Approval or status screen | `profiles.approval_status` + UI gate |
| Unpaid/pending payment | Enrollment paywall and request status | enrollment tables + UI gate |
| Active member | Entitled tabs, courses, community spaces, AI/voice access | RLS, RPCs, subscription dates, client entitlement UX |
| Administrator | Course/community/enrollment/import/batch operations | `profiles.is_admin`, RLS/RPC guards, server-side re-verification |

The main learner journey is Training & Skills → Job Application → Client Management
& Delivery. The app currently exposes 39 URL-backed tab identifiers, including
admin-only and alias routes; `TOOL_COUNT` derives the dashboard metric from that
route map rather than a hard-coded count.

## Architecture map

```text
React/Vite SPA
  └─ src/main.jsx
       ├─ per-user window.storage adapter over localStorage
       ├─ Anthropic URL rewrite to /api/anthropic
       └─ AuthProvider → BookkeeperProToolkit
            └─ src/BookkeeperPro.jsx (application shell, UI, routing, most tools)
                 ├─ src/data/*.js (lazy-loaded static content)
                 ├─ src/lib/*.js (pure, testable shared rules)
                 └─ Supabase client (Auth, DB, Realtime, Storage)

Vercel API routes
  ├─ Anthropic key-hiding, membership-gated proxy
  ├─ Resend notification endpoints
  ├─ Admin-only student import and course-trainer endpoints
  └─ ElevenLabs signed URL and trainer webhook endpoints

Supabase
  ├─ Auth, Postgres/RLS/RPCs, Realtime, Storage
  └─ optional trainer-embed Edge Function used by course-trainer APIs
```

### Client conventions and ownership

| Area | Source of truth | Feature implications |
| --- | --- | --- |
| Application shell and routes | `src/BookkeeperPro.jsx` | Keep UI additions in the monolith unless a refactor is explicitly requested. New tools require sidebar config, `renderToolContent`, and `TAB_ROUTES` to remain in sync. |
| Theme and reusable UI semantics | `src/index.css` plus `C`, `GLASS`, `SHEEN`, `INK` constants | Light, dark, and system themes are first-class. Use tokens and shared `AccountModal`/`SidePanel`; avoid hand-rolled overlays and raw color literals. |
| Authentication and profile | `src/auth/AuthProvider.jsx` | Use `useAuth()`. Profile loading is defensive and the provider sets the storage namespace before the signed-in shell. |
| Local tool data | `window.storage` installed by `src/main.jsx` | Use plain storage keys only; they become `u:<uid>:<key>`. Add a new persistent key to `LEGACY_KEYS` for first-login migration. |
| Static large data | `src/data/*.js` | Keep these modules data-only and lazy-load them with the existing pattern. |
| Shared business rules | `src/lib/*.js` | Keep them dependency-free and side-effect-free so browser, API, and `node --test` behavior agrees. |
| AI calls | `callClaude()` in `src/BookkeeperPro.jsx` | Client code never receives an Anthropic key or adds auth headers. It handles returned text, errors, and optional raw response metadata. |

## Product subsystems

### Course and learning platform

Courses, modules, lessons, progress, completions, feature guides, and signed video
access are Supabase-backed. Administrators manage catalog content, media, order,
access tiers, and per-course AI trainer enablement. Learners are restricted by
membership and plan scope at both the UI and RLS layers.

Course visibility must stay synchronized across:

- client `PLAN_ENTITLEMENTS` and route filtering;
- SQL plan helpers and course/storage policies; and
- trainer retrieval rules for the AI course trainer.

### Approval, enrollment, subscriptions, and entitlements

The product supports administrator approval, proof-of-payment enrollment, renewal,
upgrade, and extension flows. Active access is date-aware, includes a three-day
grace period, and has plan-specific scope. The current entitlement model includes
batch/cohort assignments and capability-aware community access.

`admin_finalize_enrollment()` is the intended transactional approval path for
batch-aware membership grants. A feature must not reintroduce a client-side grant
fallback or infer a batch from a date, price, or label.

### Community and cohorts

The in-app community is the Discord replacement. It includes spaces, posts,
comments, reactions, attachments, mentions, notifications, avatars, moderation,
and per-plan/per-batch capabilities. SQL policies derive membership from helper
functions and live entitlement state; they are not a conventional client-managed
membership table.

Use the existing pure mirrors in `src/lib/communitySpaces.js` and
`src/lib/communityCapabilities.js` for client behavior. Never duplicate community
space or batch logic in an ad hoc client query or RLS policy.

### Student import

The administrator-only Thinkific migration workflow stages imports, matches users,
creates idempotent grants, records immutable events, and sends a one-time
set-password invitation. The API endpoint verifies the caller as an administrator
with their own JWT before using the server-only Supabase secret key.

### AI and voice

The Anthropic proxy authenticates the caller and uses enrollment as a cost-control
gate. The ElevenLabs voice widget obtains a server-minted signed URL; optional
course-trainer webhook tools use a short-lived HMAC token and server-side course
retrieval. Course-trainer indexing, preview, transcript processing, and embeddings
are admin/server operations.

Any new AI or voice work must preserve this boundary: secrets stay server-side,
browser code uses the established helper/client integration, and authorization is
rechecked on the server or in RLS.

## Backend and data model

The final bootstrap contains 35 application tables, covering profiles, courses,
enrollment/subscriptions, community, student imports, AI trainer data, batches,
entitlements, settings, and migration logging. Storage is used for course media,
private course videos, enrollment receipts, avatars, and private community media.

The database uses imperative, ordered migration files; `supabase/config.toml` has
an empty `schema_paths` list. A schema change therefore needs a new numbered
migration, matching bootstrap update, RLS/RPC/storage review where relevant, and
DB tests when it changes a security or entitlement contract.

Security invariants to retain:

- RLS is the actual data boundary; client flags and hidden navigation are UX only.
- Never expose `SUPABASE_SECRET_KEY`, legacy service-role keys, Anthropic, Resend,
  or ElevenLabs credentials to client code.
- Admin API routes verify the caller before executing privileged work.
- Policies targeting `authenticated` still need an ownership or entitlement
  predicate. `UPDATE` policies need both `USING` and `WITH CHECK`.
- Treat `SECURITY DEFINER` functions as privileged APIs: explicit authorization,
  restricted execute grants, and a pinned search path are mandatory.
- All plan-scope and membership changes require review of courses, storage, AI
  trainer retrieval, community spaces/capabilities, and related pure tests.

## Operations, configuration, and delivery

- Local development uses Vite. `vite.config.js` bridges the Vercel-compatible
  ElevenLabs and admin APIs locally; Resend endpoints remain deploy-only.
- Production is Vercel. `vercel.json` rewrites SPA paths and grants longer runtime
  limits to trainer-related functions.
- Environment values are documented in `.env.example`. This audit deliberately
  records names only, never values.
- `scripts/audit-db.mjs` checks a target project's schema/migration requirements.
  Shadow-project utilities are available for migration application and RLS tests.
- `npm run ai:knowledge`, `ai:knowledge:check`, `ai:knowledge:push`, and
  `ai:provision` maintain the ElevenLabs assistant knowledge and configuration.

## Verification coverage

| Change category | Baseline verification |
| --- | --- |
| UI/client behavior | `npm run build`, then targeted browser checks in light and dark themes |
| Pure shared logic | `npm test` |
| RLS, migrations, entitlements | `npm run test:db`, `npm run db:audit`, and bootstrap/migration consistency review |
| Voice, email, privileged API routes | targeted local handler checks where supported, then Vercel/Supabase/ElevenLabs deployment checks |

Automated unit tests cover the pure app-error, batch entitlement, community
capability/space, LMS schedule, import, trainer access/content/orchestration, and
trainer-token contracts. DB suites explicitly exercise entitlement and community
RLS behavior against a shadow project.

## Risks and decisions to carry forward

1. **Migration-documentation drift — action required before the next DB change.**
   `db/README.md`'s one-line migration sequence currently ends at `#34`, while the
   bootstrap, `scripts/audit-db.mjs`, and tracked SQL include `#35`–`#37`. The
   README's bootstrap section correctly says it represents `#1`–`#37`. Treat the
   SQL files plus `audit-db.mjs` as the current implementation evidence until the
   run-order table is corrected.
2. **Historical cohort spec is not an executable migration plan.**
   `docs/superpowers/specs/2026-07-29-cohort-entitlements-lms-design.md` describes
   proposed later migration numbers and architecture decisions. It is valuable
   design history, but its future numbering conflicts with the current migrated
   chain. Claude prompts must treat current SQL, bootstrap, tests, and `db/README.md`
   as implementation truth.
3. **Monolith trade-off.** `src/BookkeeperPro.jsx` is about 24,900 lines. It makes
   focused changes economical today but raises regression and bundle-size risk.
   Keep changes surgical; do not use a feature request as permission for a broad
   refactor.
4. **Known production residuals.** Existing audit records identify legacy paid
   videos in the former public media path, a per-warm-instance AI limiter, an
   authenticated `payment_settings` read that includes the notification email, and
   manual verification of payment amounts. These are product/security decisions to
   revisit explicitly rather than silently changing while building another feature.
5. **Local data remains device-local.** Most tool persistence is per-user,
   namespaced browser storage rather than cloud-synced product data. Any cross-device
   sync proposal needs a dedicated schema, migration, privacy, and migration plan.

## Prompt-engineering rules derived from this audit

Every future implementation prompt should first classify the request as one or
more of: UI-only, local persistence, shared pure logic, Supabase/RLS, serverless
API, AI/voice, course content, community/cohort, or operational documentation.
The prompt must then name the impacted contracts and verification command(s), not
only the requested screen change.

Use `docs/claude-product-briefing-workflow.md` as the reusable request-to-prompt
template. It is deliberately grounded in this repository rather than a generic
feature-request format.
