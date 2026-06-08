---
name: bookkeeper-conventions
description: House coding conventions for the Ultimate Remote Bookkeeper Toolkits app (src/BookkeeperPro.jsx). Use when editing or extending any tool so changes match the existing design system, AI-call pattern, persistence, and file-handling style. Consult before touching styling, state, API calls, or file import/export.
---

# Bookkeeper-Toolkits coding conventions

The app is one file — [src/BookkeeperPro.jsx](../../../src/BookkeeperPro.jsx) — plus the entry shims
in [src/main.jsx](../../../src/main.jsx). Make edits blend in with what's already there.

## Design system (use the in-file tokens)

Defined near the top of the file:

- `C` (~L624) — color palette: `C.primary` `#0A84FF`, `C.text`, `C.textSoft`, `C.textMute`,
  `C.green`, `C.amber`, `C.red`, `C.bg`, etc.
- `GLASS` (~L657) — glass-card rgba surfaces (`GLASS.card`, `GLASS.cardElev`, `GLASS.border`…).
- `SHEEN` (~L654) — the standard top-light gradient for headers/buttons.
- Fonts (~L671): `fontDisplay` / `fontBody` (Inter), `fontMono` (JetBrains Mono, ~L673).

**Do:** `style={{ color: C.text, fontFamily: fontDisplay }}` and the `glass-card` class for panels.
**Don't:** hardcode hex colors or invent new fonts — reuse the tokens so the glass-morphism look stays
consistent. Use Tailwind utilities for layout (`flex`, `grid`, `gap-*`, `rounded-*`, spacing).

## AI calls (use the shared `callClaude()` helper)

- **Always** route AI calls through `callClaude()` ([src/BookkeeperPro.jsx:27](../../../src/BookkeeperPro.jsx#L27)) —
  do **not** hand-roll `fetch`/`res.json()`. Signature:

  ```js
  const text = await callClaude({ model, max_tokens, system, messages });
  // defaults: model 'claude-sonnet-4-6', max_tokens 1024
  const { text, data } = await callClaude({ system, messages }, { returnData: true }); // need stop_reason etc.
  ```

- Under the hood it calls the **real** URL `https://api.anthropic.com/v1/messages`; the fetch shim in
  `main.jsx` rewrites it to `/api/anthropic`, and the proxy injects the key. **Never** add `x-api-key`
  or `anthropic-version` in client code, and never reference `ANTHROPIC_API_KEY` from a component.
- Model is `claude-sonnet-4-6` everywhere; pick `max_tokens` to fit the task (800–4000).
- `callClaude` reads the body as text first, checks `res.ok`, and **throws a descriptive `Error`**
  (already `console.error`-logged) on HTTP or non-JSON failures — so `try/catch` every call and set an
  `err` state. It returns the joined text content for you (no manual `.filter(...).map(...)` needed).
- If you prompt for JSON, strip ```` ``` ````/```` ```json ```` fences before `JSON.parse`.
- Vision/PDF: pass base64 `image`/`document` content blocks inside `messages[].content`.
- Always track `busy` and `err` state so the UI degrades gracefully without a key.

See the **add-bookkeeper-tool** skill for the full copy-paste snippet, and `BankFeed` (~L2214) /
`CoachAlexChat` (~L9025) / `StatementConverter` (~L2411, vision) as references.

## State & persistence

- Local UI state: `useState` inside each component. There is **no** Redux/Zustand/Context — only the
  root `tab` string is lifted.
- Anything that must survive a reload (preferences, sidebar layout, saved entries) goes through the
  async `window.storage` shim, **not** raw `localStorage`:

  ```js
  await window.storage.set('mykey', JSON.stringify(data));
  const { value } = await window.storage.get('mykey');
  ```

  Guard with `if (typeof window !== 'undefined' && window.storage)` as existing code does (~L940).
  Sidebar layout persists under `sidebar:*` keys (`sidebar:stages` / `sidebar:collapsed` /
  `sidebar:expandedGroups`, ~L940–988).

## File import / export

- **Download/export:** use the `downloadFile(content, filename, mimeType)` helper (~L679) — e.g.
  `downloadFile(csv, 'chart-of-accounts.csv', 'text/csv')`.
- **Spreadsheets:** the `xlsx` library (`XLSX`) parses/builds Excel; see `StatementConverter` /
  `CoaGenerator`.
- **Word docs:** `mammoth` extracts text from `.docx`.
- **Images/PDF for Claude vision:** read the file to base64 and send as an `image`/`document` content
  block in `messages[].content` (see `StatementConverter`, ~L2411).

## Currency

For money-handling tools, reuse `useCurrency()` (~L712) and render `<CurrencyToggle />` (~L748) rather
than rolling your own USD↔PHP conversion.

## Navigation

A tool is reachable only when its `id` appears in all three: the sidebar `DEFAULT_STAGES` config
(~L779–864), the render switch (~L1704–1738), and optionally the Dashboard tiles (~L1756–1829). Keep
the `id` identical across all three.

## Don'ts

- Don't remove the `window.storage` or fetch shims in `main.jsx`.
- Don't introduce TypeScript, ESLint/Prettier, or a Tailwind/PostCSS config.
- Don't split the app into modules unless a refactor is explicitly requested — single file is the default.
- Don't expose the API key client-side in any form.
