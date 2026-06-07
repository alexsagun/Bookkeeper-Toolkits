# Ultimate Remote Bookkeeper Toolkits

**Get Hired With Alex** — an all-in-one web app for aspiring and working **remote bookkeepers / accountants serving US clients**. It bundles 40+ tools across three career stages:

- **Training & Skills** — Accounting 101 course, Industry Accounting playbooks, US Tax 101, ProAdvisor chat, client-portal demo.
- **Job Application** — authentic branding, resume & LinkedIn optimizers, interview prep, mock-interview simulator, free QuickBooks diagnostic, pain-points & proposal generators.
- **Client Management & Delivery** — engagement letters, onboarding, Chart of Accounts generator, invoice creator, bank-feed AI, statement → CSV converter, email templates, accounting calculators, monthly/year-end checklists, SOP generator, sales tax, budgeting & forecasting.

The UI is a single large React component (`src/BookkeeperPro.jsx`) styled with Tailwind.

---

## Quickstart

```bash
# 1. Install dependencies
npm install

# 2. (Optional) enable AI features — add your Anthropic API key
cp .env.example .env
#   then edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Start the dev server
npm run dev
```

Open the printed local URL (usually http://localhost:5173).

- **No API key?** The app still runs — calculators, checklists, the Chart of Accounts generator, email templates, and all static tooling work offline. Only the AI-powered features need a key.
- **With an API key?** Every AI feature (chat assistants, generators, the QuickBooks diagnostic, bank-feed categorization, statement parsing, etc.) works.

---

## How the API key stays safe

The component calls the Anthropic API directly. To avoid shipping a key to the browser:

- `src/main.jsx` rewrites every `https://api.anthropic.com/...` request to a local proxy path (`/api/anthropic/...`).
- `vite.config.js` proxies that path to the real API **and injects** `x-api-key` + `anthropic-version` **server-side** from `ANTHROPIC_API_KEY`.

So the key lives only in your `.env` and the dev proxy — never in the bundle.

`src/main.jsx` also shims `window.storage` (the Claude-artifact persistence API the component was built against) onto `localStorage`, so sidebar customizations, currency preferences, trackers, and saved state all persist across reloads.

---

## Production note

`npm run build` produces a **static** bundle in `dist/`. The dev proxy only exists during `npm run dev`, so a production deployment needs its **own backend/serverless endpoint** at `/api/anthropic` that injects the API key. Without it, the non-AI tools work but AI calls will 401.

---

## Project layout

```
index.html            Vite entry (loads Tailwind CDN + src/main.jsx)
vite.config.js        React plugin + Anthropic dev proxy
src/
  main.jsx            Mounts the app; window.storage + Anthropic fetch shims
  BookkeeperPro.jsx   The full application component (unmodified source)
standalone/
  index.html          Standalone single-file build, set up for Google Apps Script deployment
.env.example          Template for your Anthropic API key
```

The model IDs referenced in the source (e.g. `claude-sonnet-4-20250514`) are kept as authored.

---

## Scripts

| Command           | What it does                          |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Start the Vite dev server (with proxy)|
| `npm run build`   | Build the static production bundle     |
| `npm run preview` | Preview the production build locally   |
