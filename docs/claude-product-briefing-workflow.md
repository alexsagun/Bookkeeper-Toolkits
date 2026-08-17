# Claude Product Briefing Workflow

## Purpose

Use this workflow when a stakeholder describes a feature, workflow, issue, or
screen in plain language. Convert the raw request into an implementation-ready
prompt for Claude Code/Opus that is specific to this repository.

The finished prompt should enable Claude to make a safe, focused change without
inventing architecture, bypassing entitlements, or leaking a secret.

Read `CLAUDE.md` and
`docs/audits/2026-08-15-product-engineering-baseline.md` before preparing a prompt.
For Supabase changes, current SQL, the bootstrap, DB tests, and `db/README.md` take
priority over historical design documents.

## Intake: convert the raw request into product facts

Extract or infer the following before drafting. Ask only for a decision that would
materially change product behavior.

| Topic | Capture |
| --- | --- |
| Outcome | User problem, desired result, why it matters now |
| Audience | Visitor, pending user, active plan, specific cohort, or administrator |
| Workflow | Starting state, happy path, completion state, and back/refresh behavior |
| Interface | Route/tab, entry point, inputs, actions, states, mobile and theme expectations |
| Data | Fields, source of truth, retention, local versus cloud persistence, imports/exports |
| Access | Plan, enrollment, cohort, community-space, owner, or administrator permissions |
| Integrations | Supabase, Anthropic, ElevenLabs, Resend, files, or external link behavior |
| Edge cases | Empty, loading, invalid input, retries, offline/error, duplicate, expiry, cancellation |
| Success | Observable acceptance criteria and required tests |

## Impact-routing checklist

| If the request changes… | Include these requirements in the Claude prompt |
| --- | --- |
| A new tool or screen | Add the component in `src/BookkeeperPro.jsx`; synchronize `DEFAULT_STAGES`, `renderToolContent`, and `TAB_ROUTES`; add a dashboard tile only if product intent requires one. |
| App appearance or modal | Use `C`/`GLASS`/theme tokens, existing shared components, accessible labels and keyboard interactions, then check light and dark themes. |
| Browser-persisted user state | Use `window.storage` plain keys and add each new key to `LEGACY_KEYS` in `src/auth/AuthProvider.jsx`. |
| Bulky static content | Create a pure `src/data/*.js` module and lazy-load it with the established hook/pattern. |
| Shared calculation or state rules | Put dependency-free logic in `src/lib/*.js` and add/extend `node --test` coverage. |
| Authentication, profile, or role | Use `useAuth()` and the established profile/RLS model; do not use client-only authorization or mutable user metadata. |
| Enrollment, plan, cohort, course, or community access | Review client UX plus SQL/RLS/RPC/storage/trainer contracts; update all applicable truth surfaces and DB tests. |
| Supabase schema/RPC/storage policy | Use a numbered imperative migration, preserve RLS, explicit grants, secure function behavior, migration log, bootstrap consistency, and shadow DB verification. |
| Anthropic capability | Use `callClaude()` only; keep all secrets server-side; include busy/error/maximum-output behavior. |
| ElevenLabs or course trainer | Preserve signed-URL/token/server-side entitlement checks and account for Vercel-only configuration/testing. |
| Admin import, email, or privileged action | Verify the caller on the server before using service credentials; preserve audit/idempotency behavior and deploy-only checks. |

## Claude-ready prompt template

Copy the following structure, replace every bracketed item, and remove sections
that are not relevant. The prompt should be decisive: do not make Claude guess
about product rules that are already known.

```md
# Feature: [short feature name]

## Repository context

You are working in **Ultimate Remote Bookkeeper Toolkits**, a React 18 + Vite
single-page app. The main UI intentionally lives in `src/BookkeeperPro.jsx`.
Supabase owns Auth, Postgres/RLS/RPCs, Realtime, and Storage. Vercel hosts server
routes. Read `CLAUDE.md` and
`docs/audits/2026-08-15-product-engineering-baseline.md` before editing.

Use the current repository state as source of truth. Do not expose `.env` values or
server-only keys. Do not introduce TypeScript, a linter, new build configuration,
or a broad monolith refactor unless this brief explicitly requests it.

## Product outcome

[Describe the user problem and exact successful outcome.]

## Users and access

- Primary user: [persona and membership/role state]
- Allowed users: [plans/cohorts/admins/owners]
- Denied users and expected behavior: [what they see; do not rely on hidden UI]

## Required workflow

1. [Entry point and starting state]
2. [User action and validation]
3. [Processing, loading, and error behavior]
4. [Success state and persisted/resulting state]
5. [Refresh/deep-link/back/cancellation behavior]

## UI and content requirements

- Route/tab/entry point: [exact location]
- Inputs and outputs: [fields, labels, limits, examples]
- States: [empty, loading, success, validation error, server error, restricted]
- Design: reuse existing `C`, `GLASS`, theme tokens, `AccountModal`/`SidePanel`,
  Lucide icons, and project typography. The result must work in light and dark
  themes and remain usable on small screens.
- Accessibility: [keyboard navigation, labels, focus behavior, announcements]

## Data and security requirements

[Choose only what applies.]

- Persistence: [none / `window.storage` key(s) / Supabase tables and fields]
- Authorization: [exact owner/admin/enrollment/plan/cohort rule]
- Supabase: [migration/table/RPC/RLS/storage policy needs]. RLS is the enforcement
  boundary; client gating is UX only. Use explicit ownership/entitlement predicates,
  and preserve UPDATE `USING` plus `WITH CHECK` protections.
- Entitlements: synchronize client plan UX with the relevant SQL helpers, course
  policies, community-space/capability helpers, and trainer access where applicable.
- AI/voice: [existing helper/endpoint]. Keep keys exclusively server-side and handle
  unavailable integration states gracefully.
- Audit/idempotency: [events, duplicate protection, recovery expectations]

## Implementation plan

1. Inspect the existing closest implementation: [file/component/API/RPC/test].
2. Make the minimal focused changes in: [specific files and intended responsibility].
3. Update related data, RLS, API, route, navigation, and documentation contracts
   listed above; do not change unrelated behavior.
4. Add or update targeted tests for the decision logic and permissions.

## Acceptance criteria

- [Observable happy-path result]
- [Permission/restriction result]
- [Empty/error/edge-case result]
- [Persistence or data integrity result]
- [Theme/accessibility result]
- [No regression in named existing workflow]

## Verification

- Run `npm run build` for client changes.
- Run `npm test` when changing `src/lib` or pure logic.
- Run `npm run test:db` and the relevant migration/bootstrap checks for RLS,
  entitlement, storage, or RPC changes.
- State any Vercel/Supabase/ElevenLabs/Resend deployment checks that cannot run
  locally, including the exact persona and expected result.

## Deliverable

Implement the feature. In the final response, summarize changed files, explain any
important access-control or data-model decision, list commands run and results, and
call out only genuine deploy-time follow-ups.
```

## Default answer format for future requests

When given a raw idea, return:

1. a short **Product interpretation** that restates the feature and explicit
   assumptions;
2. an **Impact map** naming only the likely affected subsystems/files; and
3. one complete **Claude-ready implementation prompt** using the template above.

If an essential decision is missing, put a concise `Decision needed` section before
the prompt and explain its product impact. Otherwise make the reasonable,
repo-consistent assumption in the prompt so the stakeholder can execute immediately.

## Non-negotiable guardrails

- Keep new user-facing tools in the existing monolith by default.
- Never send or log secrets from `.env`; `VITE_` prefixes are public and server keys
  must never use them.
- Use `callClaude()` for Anthropic interactions and the established ElevenLabs
  signed-URL/trainer routes for voice work.
- Do not use raw `localStorage` for app data and do not hand-roll a new global state
  layer.
- Treat RLS, storage policies, RPC grants, and server-side caller verification as
  feature requirements whenever user data or access changes.
- Do not use the historical cohort-entitlements design doc as an executable
  migration sequence; resolve the current migration order from SQL files,
  `scripts/audit-db.mjs`, and the maintained DB documentation.
