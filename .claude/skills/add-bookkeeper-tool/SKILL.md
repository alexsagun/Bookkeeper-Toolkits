---
name: add-bookkeeper-tool
description: Add a new tool/calculator/AI feature to the Ultimate Remote Bookkeeper Toolkits app. Use when asked to "add a tool", "add a calculator", "add an AI feature", "add a new tab", or otherwise extend the toolkit with a new screen in src/BookkeeperPro.jsx.
---

# Add a new bookkeeper tool

Every tool lives in [src/BookkeeperPro.jsx](../../../src/BookkeeperPro.jsx) and is wired into the
nav in **three** synchronized places. Do all three or the tool won't appear / won't render.

## Step 1 — Write the component

Add a functional component near similar tools (calculators ~L9400–10200, AI chats ~L9025–9400,
generators ~L5379–6700). Use the design tokens (`C` ~L624, `GLASS` ~L657, `SHEEN` ~L654,
`fontDisplay` ~L671) and a [Lucide](https://lucide.dev) icon already imported at the top of the file.

Non-AI tool skeleton:

```jsx
function MyNewTool() {
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h2 style={{ fontFamily: fontDisplay, color: C.text }} className="text-2xl font-semibold mb-4">
        My New Tool
      </h2>
      {/* inputs, then output. Use downloadFile(content, 'name.csv', 'text/csv') to export. */}
    </div>
  );
}
```

If it deals with money, reuse the currency helpers: `const { currency, fxRate, ... } = useCurrency()`
(~L712) and render `<CurrencyToggle ... />` (~L748; see existing calculators).

**Auth & persistence:** the app is already behind a Supabase login gate, so a tool only ever renders
for a signed-in user — no auth checks needed inside it. If the tool saves data, just use
`window.storage` with plain keys (it auto-namespaces per user — see bookkeeper-conventions) and add any
**new** key to `LEGACY_KEYS` in [src/auth/AuthProvider.jsx](../../../src/auth/AuthProvider.jsx).
Read auth state when you need it via `const { user, profile } = useAuth()`. Whether a tool is free vs
paid is a future Phase-2 concern (a `FREE_TABS` allowlist) — don't gate tools yourself now.

## Step 2 — For an AI-powered tool, use the shared `callClaude()` helper

Every AI feature goes through the **`callClaude()`** helper at the top of the file
([src/BookkeeperPro.jsx:27](../../../src/BookkeeperPro.jsx#L27)). It calls the **real** Anthropic URL —
the `main.jsx` fetch shim rewrites it to `/api/anthropic` and the proxy injects the key. Do **not** add
`x-api-key` and do **not** hand-roll `fetch`/`res.json()` for AI calls.

```jsx
const [busy, setBusy] = useState(false);
const [err, setErr] = useState('');

async function run() {
  setBusy(true); setErr('');
  try {
    // Defaults: model 'claude-sonnet-4-6', max_tokens 1024. Override as needed.
    const text = await callClaude({
      max_tokens: 1500,
      system: 'You are a 15-year US QuickBooks ProAdvisor...', // role-specific system prompt
      messages: [{ role: 'user', content: userInput }],
    });
    // If you asked for JSON, strip code fences first:
    // const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    setResult(text);
  } catch (e) {
    console.error(e);                 // callClaude throws a descriptive, already-logged error
    setErr('AI request failed. Check your ANTHROPIC_API_KEY or try again.');
  } finally {
    setBusy(false);
  }
}
```

`callClaude` returns the joined text by default. If you need the raw response (e.g. to check
`stop_reason` for `max_tokens` truncation), pass `{ returnData: true }` as the second arg and read
`{ text, data }`. On any HTTP/non-JSON error it **throws** a descriptive `Error` (already
`console.error`-logged) — so wrap calls in `try/catch` and set `err`; never assume success.

Reference implementations to copy from: `BankFeed` (~L2214, JSON output + fence stripping),
`CoachAlexChat` (~L9025, multi-turn chat), `StatementConverter` (~L2411, vision: base64 `image`/
`document` blocks in `messages[].content`).

Always handle `busy` (disable the button / show a spinner) and `err` (the app must degrade
gracefully when no key is set).

## Step 3 — Wire it into navigation (four edits)

The app is **URL-routed + keep-alive** (see CLAUDE.md → "Navigation model"). A new tool needs:

1. **Sidebar config** (`DEFAULT_STAGES` array): add `{ id: 'mytool', label: 'My New Tool', icon: SomeIcon }`
   to the right stage's `tabs`, and add `'mytool'` to a group's `tabIds`.
2. **`renderToolContent(tabId, handlers)` switch** (module scope, just above the root component): add
   `case 'mytool': return <MyNewTool />;`. (Do **not** add a bare `{tab === 'mytool' && …}` conditional;
   the memoized `TabPanel` keep-alive map calls `renderToolContent`. If the tool needs a callback from
   the root, thread it through `handlers` and make sure the root passes a **stable** — `useCallback` —
   reference to `<TabPanel/>`, or hidden tabs lose their re-render bailout.)
3. **`TAB_ROUTES`** (module scope, top of file): add `mytool: '/my-new-tool',` so the tool has a stable
   URL (deep-link, refresh, and "open in new tab" all key off this; `VALID_APP_TABS` derives from it).
   Use a unique, human-readable path.
4. **(Optional) Dashboard tile**: add `{ id: 'mytool', label, desc, icon, color }` if it should appear
   on the Home roadmap.

The `id` must be identical in the sidebar config, the `renderToolContent` case, and `TAB_ROUTES`.

## Step 4 — Verify

```powershell
npm run dev
```

Open the app, click the new tab in the sidebar, and exercise the tool. For AI tools, confirm a real
request succeeds (requires `ANTHROPIC_API_KEY` in `.env`) and that it shows a friendly error when the
key is missing. **Check the tool in both themes** (Sun/Moon/Monitor toggle in the sidebar profile
area) — dark mode is first-class; use the theme tokens per the bookkeeper-conventions skill and never
concat alpha suffixes onto `C.*`. If the tool ships a large static data constant, put it in
`src/data/*.js` and wire it with `useLazyData` + `DataLoadingCard` (see conventions skill).

## Guardrails

- Keep it in the single file; don't create new modules unless explicitly asked.
- No TypeScript, no new build/lint config.
- Reuse `C`/`GLASS`/`downloadFile`/`useCurrency` rather than re-inventing them.
