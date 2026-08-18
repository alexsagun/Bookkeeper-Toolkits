---
name: bookkeeper-conventions
description: House coding conventions for the Ultimate Remote Bookkeeper Toolkits app (src/BookkeeperPro.jsx). Use when editing or extending any tool so changes match the existing design system, AI-call pattern, persistence, and file-handling style. Consult before touching styling, state, API calls, or file import/export.
---

# Bookkeeper-Toolkits coding conventions

The app is one file — [src/BookkeeperPro.jsx](../../../src/BookkeeperPro.jsx) — plus the entry shims
in [src/main.jsx](../../../src/main.jsx). Make edits blend in with what's already there.

## Design system (theme-aware tokens)

The app has **light + dark themes** driven by the `data-theme` attribute on `<html>` (`useTheme`
hook + `ThemeToggle`; pre-paint boot script in `index.html`). The tokens near the top of the file
are **CSS custom-property references**, with the actual per-theme values in
[src/index.css](../../../src/index.css):

- `C` — color palette: `C.primary` = `var(--c-primary)`, `C.text`, `C.textSoft`, `C.textMute`,
  `C.green`, `C.amber`, `C.red`, `C.bg`, `C.white` (a *surface*, dark-aware), etc.
- `GLASS` — glass surfaces (`GLASS.card`, `GLASS.cardElev`, `GLASS.border`…), `SHEEN` — the
  top-light gradient. Both var-backed, both theme automatically.
- `INK` — **frozen literal hex palette** for anything that leaves the DOM: Word `.doc` builders,
  the certificate + print window, html2canvas/PDF. `var()` doesn't resolve in an exported document —
  always use `INK.*` there (and `INK.navy` for band gradients under `text-white`).
- Fonts: `fontDisplay` / `fontBody` (Inter), `fontMono` (JetBrains Mono) — loaded once from
  `index.html`; **never** add a Google-Fonts `@import` in a component `<style>`.

**Do:** `style={{ color: C.text, fontFamily: fontDisplay }}` and the `glass-card` class for panels.
**Do:** use the semantic status tokens for pills/banners — `var(--status-warn-bg/-bd/-fg)`,
`--status-ok-*`, `--status-danger-*`, `--status-info-*`, `--status-neutral-*`, `--status-warn-strong-*`.
**Do:** use the shell tokens for app chrome — `--sidebar-bg/-border/-edge` (the sidebar `<aside>`),
`--topbar-bg` (mobile sticky bar), `--section-head-bg` (`SectionHead`), `--table-sticky-bg` +
`--table-sticky-{soft,deeper,ok,danger}-bg` (sticky table columns, plain + tinted summary rows).
Inline styles bypass the dark compat layer, so shell surfaces MUST use these vars.
**Don't:** hardcode hex colors, and **never** concat an alpha suffix onto a token
(`` `${C.primary}66` `` is broken CSS against a var) — use the alpha tokens: `var(--primary-glow)`
(≈66), `--primary-glow-soft` (55), `--primary-selection` (33), `--primary-halo` (1A),
`--primary-tint` (14), `--green-ring(-faint)`, `--red-glow`, `--green-glow`, `--focus-ring`,
`--wash`, `--wash-strong`. Solid green/red action buttons use the gradient-endpoint tokens
`--green-hi`/`--red-hi` — reuse the shared `ADMIN_BTN_OK`/`ADMIN_BTN_DANGER` style consts
(module scope above `AccessRequests`) instead of hand-writing the gradient.
**Modals:** never hand-roll a `fixed inset-0` + `bg-white` overlay — use the shared `AccountModal`
(dialog roles, Escape, backdrop-close, focus trap/restore; props `tone` 'primary'|'ok'|'danger',
`canClose` to block closing mid-request, `headerAction`, `bodyClass`/`bodyStyle`, `maxW`), or the
sibling `SidePanel` for a right-side drawer — `maxW` (default `sm:max-w-md`), plus `canClose` and
`footer`, an action bar pinned under a `flex-1 overflow-y-auto overscroll-contain` body. Header,
body and footer are three rows of one flex column, so a drawer never hand-rolls `sticky top-0` /
`sticky bottom-0`; `SidePanel` is the preferred surface for a **long editing form**. Both shells
already render through `OverlayPortal` (`createPortal` → `document.body`, with a `[hidden]`-ancestor
guard so a modal inside a hidden keep-alive tab stays hidden) — don't re-wrap them in a portal, and
never render a hand-rolled fixed overlay as a *direct child* of a `gh-app-bg` element: the
`.gh-app-bg > *:not(.fixed)` rule in `index.css` exists because a bare `> *` version used to demote
fixed overlays into in-flow flex columns. Never combine `fixed` + `gh-app-bg` on the SAME element
either — `.gh-app-bg` sets `position: relative`, which out-cascades `.fixed` (a
`.gh-app-bg.fixed` carve-out guards it, but layer them: fixed wrapper > mesh-painting child). Admin
lists reuse `AdminNotice`/`AdminFilterChip`/`AdminFilterCaption`/`AdminListSkeleton`/`AdminUserCell`
so both admin screens stay one visual surface.
★ Why the portal is non-negotiable *inside a tool*: `.fade-in` (index.css:471) ends on
`transform: translateY(0)` with `animation-fill-mode: forwards`, so the active `TabPanel` carries a
non-`none` transform permanently and becomes the containing block for every `position:fixed`
descendant. A hand-rolled `fixed inset-0` overlay inside a tool therefore anchors to that tool's tall
canvas rather than the viewport — it opens off-screen the moment the page is scrolled. That was the
course lesson editor's bug (fixed 2026-08-18 by moving it onto `SidePanel`).
★ Errors raised from inside a dialog need a **dialog-local** alert (`role="alert"` +
`--status-danger-*`): a page-level banner renders behind the scrim where nobody can read it.
★ You do **not** need a scroll lock behind a portaled dialog — its DOM ancestors are body/html, which
never scroll (the app root is `h-screen … overflow-hidden`), and scroll chaining follows the DOM
ancestor chain, not visual stacking.
**Avatars:** every member/user avatar renders through the shared `MemberAvatar` primitive
(beside the community block) with `resolveAvatarUrl(profile.avatar_url)` — an `<img>` from the
public `avatars` bucket (or a legacy OAuth URL) with the initials-in-a-gradient-circle fallback.
Never hand-roll an initials circle or a raw avatar `<img>` again. The only sanctioned write to
`profiles.avatar_url` is the `set_my_avatar()` RPC (see `AvatarSection`); `profiles` still has
no user-update RLS policy.
**Tailwind:** layout utilities freely; for *color* utilities prefer ones already covered by the dark
compat layer at the bottom of `index.css` (`bg-white`, `text-slate-*`, `border-slate-*`,
red/emerald/amber families) — a new color utility needs a compat rule or a `dark:` variant.
**QA every change in BOTH themes** (cycle the sidebar Sun/Moon/Monitor toggle) before calling it done.

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

- **Per-user namespacing is automatic.** `window.storage` keys are transparently scoped to the
  signed-in user (`u:<uid>:<key>`) by the shim in `main.jsx`. Keep calling `window.storage` with
  **plain keys** — do **not** add a uid prefix yourself. When you add a **new persisted key**, also add
  it to the `LEGACY_KEYS` list in [src/auth/AuthProvider.jsx](../../../src/auth/AuthProvider.jsx) so a
  pre-auth value gets migrated into the first account. (`ui:theme` additionally mirrors a bare
  `localStorage` copy for the pre-paint boot script — that dual-write is unique to the theme; don't
  copy it for ordinary tool keys.)

- **Bulky static content goes in `src/data/*.js`** (pure data only — no components), lazy-loaded so
  it stays out of the main bundle. Pattern: a module-scope loader + a thin wrapper around the tool:

  ```jsx
  const loadMyToolData = () => import('./data/my-tool.js');   // module scope
  function MyTool(props) {
    const { mod, err } = useLazyData(loadMyToolData);
    if (!mod) return <DataLoadingCard err={err} />;
    return <MyToolInner {...props} data={mod} />;
  }
  function MyToolInner({ data }) {
    const { MY_BIG_CONSTANT } = data;
    // …original component body…
  ```

  See `EmailTemplates` / `IndustryAccounting` as references. Small constants (< a few kB) can stay
  in the main file.

- **Pure shared logic goes in `src/lib/*.js`** (the second sanctioned carve-out, alongside
  `src/data/*.js`): dependency-free ESM — NO imports, NO side effects, NO DOM/Node/Supabase — so
  the same rules run identically in the browser, the `api/` serverless endpoints, and the
  `node --test` suites in `test/*.test.mjs` (`npm test`). Existing examples:
  `src/lib/studentImport.js` (import matching/term math), `src/lib/trainerToken.js` (the
  AI-trainer HMAC token codec — crypto is *injected* by callers, never imported), and
  `src/lib/trainerContent.js` (chunking, course resolution, the trainer response envelope,
  `planScopeAllows()` — the pure mirror of the SQL plan-scope truth table). When server + client
  must agree on a rule, put the rule here and test it; keep the api handler a thin I/O shell.

## Auth context (`useAuth()`)

Auth is available app-wide via `import { useAuth } from './auth/AuthProvider.jsx'`:
`const { user, profile, loading, signOut } = useAuth()`. `user` is the Supabase user (`user.email`),
`profile` is the `profiles` row (`profile.full_name`, and `profile.is_paid`/`plan` reserved for the
Phase-2 paid gate). The app is already gated — every tool renders only for a signed-in user, so you
don't need to add auth checks inside a tool. See the "Authentication" section in CLAUDE.md.

## File import / export

- **Download/export:** use the `downloadFile(content, filename, mimeType)` helper (~L679) — e.g.
  `downloadFile(csv, 'chart-of-accounts.csv', 'text/csv')`.
- **Spreadsheets:** the `xlsx` library (`XLSX`) parses/builds Excel; see `StatementConverter` /
  `CoaGenerator`. Import it lazily — `const XLSX = await import('xlsx')` — so it stays out of the main bundle.
- **Word docs (`.docx`):** not currently wired into the app. If you add `.docx` parsing, lazy-load a
  parser (e.g. `mammoth`) via dynamic `import()` and re-add it to `package.json` — it was removed as an
  unused dependency.
- **Images/PDF for Claude vision:** read the file to base64 and send as an `image`/`document` content
  block in `messages[].content` (see `StatementConverter`, ~L2411).

## Dates (timezone-safe, date-only)

For date-only fields (e.g. the course platform's `course_date` batch-run date), reuse the module-level
helpers near `downloadFile` (~L709): `todayISODate()` → local `YYYY-MM-DD` for a "today" default,
`formatCourseDate(iso, opts)` → human-readable display, and `batchRunLabel(iso)` → an auto-derived
"Month Year" label. They build a **local** `Date` from the parts and never use `new Date('YYYY-MM-DD')`
or `toISOString().slice(0,10)`, both of which shift a day across the UTC boundary. Store as a Postgres
`date` and bind to `<input type="date">`.

## Currency

For money-handling tools, reuse `useCurrency()` (~L712) and render `<CurrencyToggle />` (~L748) rather
than rolling your own USD↔PHP conversion.

## Navigation

A tool is reachable only when its `id` appears in: the sidebar `DEFAULT_STAGES` config, the
**module-scope `renderToolContent(tabId, handlers)` switch** (rendered through the memoized
`TabPanel` keep-alive — hidden tabs skip root re-renders because every TabPanel prop is
referentially stable; don't pass it per-render values), and `TAB_ROUTES` (its stable URL path, for
deep-linking / new-tab), plus optionally the Dashboard tiles. Keep the `id` identical across all of
them. Navigation is URL-routed + keep-alive — see CLAUDE.md → "Navigation model".

## Don'ts

- Don't remove the `window.storage` or fetch shims in `main.jsx`, or the theme boot script in `index.html`.
- Don't introduce TypeScript, ESLint/Prettier, or a Tailwind/PostCSS config.
- Don't split the app into modules unless a refactor is explicitly requested — single file is the
  default (`src/data/*.js` pure-data modules are the one sanctioned carve-out).
- Don't expose the API key client-side in any form.
- Don't ship UI checked in only one theme — dark and light are both first-class.
- Don't inline community space/batch logic in a policy or client query — access always derives
  through `my_community_space_ids()` (SQL) / `planSegment()`+`approvalBatchPreselect()`
  (`src/lib/communitySpaces.js`, the pure mirror pinned by `test/communitySpaces.test.mjs`),
  and a batch is never inferred from dates, titles, or amounts. Never re-add a client-side
  approval fallback — `admin_finalize_enrollment()` is the ONE grant path (it validates
  batch + capacity; a local grant would bypass both).
