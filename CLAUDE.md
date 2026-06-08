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

### [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx) — the entire app (~16.7k lines)

> Note: lines are long; prefer `Grep` over reading the whole file. Line numbers below are anchors,
> approximate as the file evolves.

| Region | Lines (approx) | Contents |
|---|---|---|
| Imports + domain data | 1–565 | `COA_BASE` (L20), `COA_INDUSTRY` (L73), `INDUSTRY_NOTES` (L293), `VENDOR_PATTERNS` (L319), `COURSE_MODULES` (L415), checklists, `TIPS` (L555) |
| Design system + helpers | 565–725 | colors `C` (L576), `SHEEN` (L606), `GLASS` (L609), fonts (L623), `downloadFile()` (L631), `useCurrency()` (L664), `CurrencyToggle()` (L700) |
| Root component | 726–~1700 | `BookkeeperProToolkit` (L726): `tab` state, sidebar stages/groups config (~L737–813), drag-drop reorder, rename/persist to `window.storage`, and the **render switch** (~L1656–1690) |
| Tool components | ~1700–end | ~60 self-contained functional components |

**Notable tools → approximate line:** `Dashboard` 1701, `CoaGenerator` 1969, `Course` 2072,
`BankFeed` 2166, `StatementConverter` 2374, `ProChat` 2737, `CoachAlexChat` 9114, `CPAAIChat` 9279,
`ResumeOptimizer` 4496, `AuthenticBranding` 4972, `ProposalGenerator` 5418, `EngagementLetter` 5708,
`EmailTemplates` 6365, `ClientPortalDemo` 7076, `IndustryAccounting` 7750, `USTax101` 8051,
`MonthlyWorkflow` 8224, `MonthEndChecklist` 8425, `InvoiceCreator` 9707, `AccountingCalculators` 10295,
`LinkedInOptimizer` 10846, `MockInterviewSimulator` 11022, `DiscoveryCallSimulator` 11311,
`SOPGenerator` 11640, `QBDiagnostic` 14512, `BudgetingTool` 15719, `ForecastingTool` 16210.

### Navigation model

A single `tab` string in the root selects which tool renders. Three pieces must stay in sync:

1. **Sidebar config** (`stages` array, ~L737–813): `{ id, number, label, groups: [{ label, tabIds }], tabs: [{ id, label, icon }] }`.
2. **Render switch** (~L1656–1690): `{tab === 'someid' && <SomeComponent />}`.
3. **Dashboard roadmap tiles** (~L1710+): optional `{ id, label, desc, icon, color }` entries.

Sidebar customizations (rename, reorder, collapse) persist to `window.storage` under `sidebar:*` keys.

## AI / proxy pattern

AI tools call Claude with a plain `fetch` to the **real** Anthropic URL — the proxy injects the key:

```js
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },   // NO x-api-key here
  body: JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: sys,                                      // optional system prompt
    messages: [{ role: 'user', content: userText }],
  }),
});
const data = await res.json();
const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
```

- **Model:** `claude-sonnet-4-20250514` across all AI tools. `max_tokens` varies 800–4000 by task.
- **Never** put the API key, `x-api-key`, or `anthropic-version` in client code. The proxy adds them.
  - Dev: [vite.config.js](vite.config.js) injects `x-api-key` + `anthropic-version: 2023-06-01`.
  - Prod: [api/anthropic/[...path].js](api/anthropic/[...path].js) (Vercel serverless) does the same.
- For JSON responses, tools strip ```` ```json ```` fences before `JSON.parse` (see `BankFeed`, ~L2245).
- For vision (PDF/image), tools send base64 image blocks in `messages[].content` (see `StatementConverter`).

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

- **Match existing in-file patterns** — functional components, local `useState`, design tokens, the
  AI fetch shape above.
- **Adding a tool** = new component in `BookkeeperPro.jsx` + wire it into the sidebar config and the
  render switch. See the **add-bookkeeper-tool** skill in [.claude/skills/](.claude/skills/).
- **Keep the single-file architecture** unless a refactor is explicitly requested.
- **Preserve the two shims** in `main.jsx`.
- **Don't** add TypeScript, a linter, or new build config without asking.
- Coding house-style is captured in the **bookkeeper-conventions** skill.

See also: [README.md](README.md) for the end-user quickstart and deploy walkthrough.

## Development roadmap (phases)

A living plan — each phase is independent and can be approved/started on its own.

- **Phase 0 — Documentation (done):** this CLAUDE.md + the two skills.
- **Phase 1 — Polish & deploy:** verify the Vercel build and `ANTHROPIC_API_KEY`; confirm the AI path
  works in production; reduce bundle size (the XLSX and app chunks are large — lazy-load XLSX/Mammoth
  and consider code-splitting the heaviest tools); audit error/empty states across AI tools.
- **Phase 2 — Add tools/features:** ship new tools with the **add-bookkeeper-tool** skill so they stay
  consistent with the navigation model and design system.
- **Phase 3 — Incremental code quality:** extract shared helpers opportunistically; only when a tool is
  already being edited, optionally split the largest components into their own files — no big-bang
  rewrite; single-file remains the default.
