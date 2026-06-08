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
- **JavaScript + JSX only** — there is **no TypeScript, no ESLint/Prettier, no PostCSS or Tailwind config files**. Do not introduce build tooling, a type system, or new config without asking first.
- **Tailwind CSS via CDN** (loaded in [index.html](index.html)) — utility classes work, but there is no `tailwind.config.js` and no JIT/build step for styles.
- **Lucide React** for icons, **XLSX** (spreadsheet parse/generate), **Mammoth** (.docx parse).
- **Anthropic Claude API** for AI features, via a key-hiding proxy (see below).

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

Mounts `<BookkeeperProToolkit />` and installs two shims that the tool code depends on:

1. **`window.storage`** → wraps `localStorage` with an async `get`/`set` API. The app was authored
   in Claude artifacts and calls `window.storage` directly for all persistence.
2. **fetch shim** → rewrites any request to `https://api.anthropic.com` → `/api/anthropic`. Tool
   code calls the *real* Anthropic URL; this shim redirects it to the proxy so the API key stays
   server-side. **Removing either shim breaks persistence or AI calls.**

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
`BankFeed` 2214, `StatementConverter` 2411, `ProChat` 2764, `ResumeOptimizer` 3511,
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

## AI / proxy pattern

Every AI tool goes through the shared **`callClaude()`** helper at the top of `BookkeeperPro.jsx`
(L27) — **don't** hand-roll `fetch`/`res.json()`. It calls the **real** Anthropic URL; the proxy
injects the key.

```js
// defaults: model 'claude-sonnet-4-20250514', max_tokens 1024
const text = await callClaude({
  max_tokens: 1500,
  system: sys,                                       // optional system prompt
  messages: [{ role: 'user', content: userText }],
});

// Need the raw response (e.g. stop_reason to detect truncation)? Pass { returnData: true }:
const { text, data } = await callClaude({ system, messages }, { returnData: true });
```

- **Model:** `claude-sonnet-4-20250514` across all AI tools. `max_tokens` varies 800–4000 by task.
- **Error handling:** `callClaude` reads the body as text first, checks `res.ok`, and **throws a
  descriptive `Error`** (already `console.error('[Claude] …')`-logged) on HTTP or non-JSON failures —
  instead of silently collapsing into a generic fallback. Wrap calls in `try/catch` and set an `err`
  state; never assume success. It returns the joined text content, so no manual `.filter/.map` needed.
- **Never** put the API key, `x-api-key`, or `anthropic-version` in client code. The proxy adds them.
  - Dev: [vite.config.js](vite.config.js) injects `x-api-key` + `anthropic-version: 2023-06-01`.
  - Prod: [api/anthropic/[...path].js](api/anthropic/[...path].js) (Vercel serverless) does the same.
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

## Deployment

- **Vercel:** push to GitHub → import project → set `ANTHROPIC_API_KEY` (Production + Preview) → deploy.
  The serverless function at `api/anthropic/[...path].js` replaces the dev proxy automatically.
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
