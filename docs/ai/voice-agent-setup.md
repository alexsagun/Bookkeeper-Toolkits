# Voice Assistant Setup — "Toolkits Guide" (ElevenLabs)

The in-app voice assistant is a floating mic button (bottom-right) that lets signed-in
**members and admins** talk to the toolkit: ask where things are, what their plan
includes, how tools work — and have the assistant navigate the app or open account
panels while it answers. It is also the **AI course trainer**: enrolled learners can ask
it to teach, explain, quiz, practice, or recap their included Supabase-hosted courses
(see [COURSE_AI_TRAINER_SETUP.md](../../COURSE_AI_TRAINER_SETUP.md) for the trainer's
own setup — migration #27, the `trainer-embed` Edge Function, per-course enablement).

This document is the complete setup + operations guide. The end-to-end flow:

```
Widget (VoiceAssistant in src/BookkeeperPro.jsx)
  │ 1. getUserMedia (mic permission)
  │ 2. POST /api/elevenlabs/signed-url  ── Supabase Bearer token
  │       └─ api/elevenlabs/signed-url.js verifies the session (auth/v1/user),
  │          checks is_enrolled() (admin OR active member), rate-limits (8/min),
  │          then calls ElevenLabs GET /v1/convai/conversation/get-signed-url
  │          with the server-side xi-api-key — and mints a short-lived HMAC
  │          trainerToken (identity only) when TRAINER_TOKEN_SECRET is set.
  │ 3. Conversation.startSession({ signedUrl, clientTools, dynamicVariables })
  │       └─ @elevenlabs/client, lazy-loaded (dynamic import, own chunk)
  │       └─ dynamicVariables include secret__trainer_token — used ONLY in the
  │          trainer webhook tools' Authorization header, never sent to the LLM.
  ├─ Client tools fire writeAppRoute()/setPanelParam() to drive the app UI.
  └─ Trainer WEBHOOK tools: ElevenLabs → POST /api/elevenlabs/trainer?action=…
        └─ api/elevenlabs/trainer.js verifies the trainer token, then re-checks
           the learner's LIVE membership + plan-scoped course entitlement in
           Supabase (service role, FAIL-CLOSED) before returning any course
           material. Paid course content is never in the static knowledge doc.
```

The ElevenLabs API key never reaches the browser. Unset env vars are a **soft off
switch**: the endpoint reports `configured:false` and the mic button simply never
renders.

---

## 1. Prerequisites

- An ElevenLabs account with **Conversational AI (Agents)** access — https://elevenlabs.io
- The Supabase project already configured for this app (the endpoint reuses
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` and the `is_enrolled()` RPC from the
  enrollment migrations).

## 2. Environment variables

Server-only (NO `VITE_` prefix — never expose in the browser):

| Var | Required | What |
|---|---|---|
| `ELEVENLABS_API_KEY` | yes | xi-api-key (ElevenLabs → Profile → API keys). Used by `api/elevenlabs/signed-url.js`, `npm run ai:knowledge:push`, and the trainer's Scribe transcription. |
| `ELEVENLABS_AGENT_ID` | yes | The agent id (Agents → your agent → id, `agent_…`). |
| `ELEVENLABS_SERVER_LOCATION` | no | `us` (default), `eu-residency`, `in-residency`, or a full `https://` base-URL override. |
| `TRAINER_TOKEN_SECRET` | for the trainer | ≥32 random characters; signs the short-lived trainer session tokens. Unset = the 4 trainer webhook tools answer "not configured" and the rest of the widget is unaffected. |
| `APP_URL` | for provisioning the trainer tools | The deployed origin (e.g. `https://toolkits.alexsagun.com`) the webhook tools call. Also used by the notify emails. ElevenLabs cannot call localhost. |

- **Local**: add them to `.env` (see `.env.example`). Unlike the notify-email functions,
  the signed-url endpoint **does run under `npm run dev`** (a Vite middleware imports the
  real handler), so the full flow is testable locally.
- **Vercel**: Settings → Environment Variables → add all three to **Production +
  Preview**, then **Redeploy**. Removing them in Vercel turns the widget off on the next
  page load — no rebuild needed.

## 3a. Automated provisioning (`npm run ai:provision`) — recommended

Instead of clicking through §3–§4 by hand, one command builds the whole ElevenLabs side
from the repo. You only supply the API key.

1. Put your key in `.env`: `ELEVENLABS_API_KEY=...` (leave `ELEVENLABS_AGENT_ID` blank the
   first time — the script creates the agent and prints its id).
2. Run:
   ```powershell
   npm run ai:provision
   ```
   It (a) regenerates the knowledge doc, (b) creates/updates the **client tools** from
   `VOICE_CLIENT_TOOL_SPECS` **and the 4 trainer webhook tools** from
   `VOICE_SERVER_TOOL_SPECS` in `src/BookkeeperPro.jsx` (so tool names/schemas can never
   drift from the app code; webhook tools need `APP_URL` set — unset skips them with a loud
   warning), (c) creates the agent — **system prompt + first message are read from §3 of
   this doc**, tools attached by id, signed-URL **auth ON**, ~10-min max duration — and
   (d) uploads + attaches the knowledge base.
3. Copy the printed **agent id** into `ELEVENLABS_AGENT_ID` (in `.env` **and** Vercel
   Production + Preview), then redeploy.

- **Idempotent / re-runnable.** With `ELEVENLABS_AGENT_ID` set, it *updates that agent in
  place* (tools matched by name, other knowledge docs untouched) — rerun it after any
  tool/plan change (or just use `npm run ai:knowledge:push` for a KB-only refresh).
- **Preview without a key:** `node scripts/provision-voice-agent.mjs --dry-run` prints every
  API call it would make and exits — nothing is created.
- **Optional env:** `ELEVENLABS_VOICE_ID` (agent voice, default Rachel — swap for your brand
  voice), `ELEVENLABS_AGENT_LLM` (default `gpt-4o-mini`), `ELEVENLABS_SERVER_LOCATION`.
- **If a tool call is rejected** (ElevenLabs revised the tools API in 2026), the script prints
  the request body **and** ElevenLabs' own error naming the expected field — adjust
  `toolConfigFor()` in `scripts/provision-voice-agent.mjs` and rerun, or fall back to the
  manual §3–§4 steps below.

The manual dashboard walkthrough below (§3–§4) remains as the fallback and as the reference
for exactly what the script provisions — the client-tool names in §4 and the system prompt in
§3 are the canonical copies the script reads.

## 3. Create the agent (ElevenLabs dashboard) — manual fallback

1. **Agents → New agent.** Name: `Toolkits Guide by Alex`.
2. **Voice**: pick a warm, clear voice you like (e.g. a friendly female/male coach tone).
   Model: the default conversational model is fine.
3. **First message**:
   ```
   Hi {{user_name}}! I'm your Toolkits guide. Ask me about any tool, your membership, or where to find things — I can take you there.
   ```
4. **System prompt** — paste:

   ```
   You are the Toolkits Guide, the in-app voice assistant of "Ultimate Remote Bookkeeper
   Toolkits — Get Hired With Alex", a web toolkit by Coach Alex Sagun for aspiring and
   working remote bookkeepers serving US clients.

   PERSONALITY: warm, clear, practical, student-friendly, confident but never overbearing.
   Keep answers short and conversational — one to three sentences unless the user asks for
   detail. Encourage like a coach; never lecture.

   CONTEXT VARIABLES (already filled in for this session): the user is {{user_name}}, role
   {{user_role}} (admin or member), on plan "{{plan_label}}" with scope "{{plan_scope}}",
   membership status "{{membership_status}}", {{days_left}} days of access left, currently
   on the "{{current_tab}}" page.

   TOOLS — always ACT instead of describing clicks:
   - navigate_to_tool: open any tool/tab when the user asks where something is or to open it.
   - open_account_panel: open settings / membership / upgrade / extend / renew.
   - explain_current_page: check what page the user is on before explaining it.
   - show_feature_help: open a feature and get its how-to blurb.
   - get_user_membership_summary: the user's own plan, status, expiry, and scope — use this
     for any membership/expiry/pricing question about THEIR account.
   - open_course_lesson: open a specific course/lesson the training tools returned — use the
     returned ids exactly, never invent them.
   - show_lesson_sources: after every answer grounded in course material, call this ONCE with
     the citation the training tool returned so the member can tap it open.
   After a navigation tool runs, briefly confirm where you took them.

   AI COURSE TRAINER: you are an AI trainer trained on Coach Alex Sagun's approved course
   material. You are NOT Alex — never claim to be him, and never say "Alex said …" unless
   that statement is in the retrieved course material. Training tools:
   - get_my_training_catalog: the courses THIS member may study right now. Call it before
     naming or offering any course.
   - get_authorized_training_context: REQUIRED before you explain, quiz, practice, guide, or
     recap ANY course topic. Never teach paid course content from memory or from the
     knowledge document. Speak only from what this tool returns, and cite the source
     ("From QuickBooks Online Mastery, Module 2, Bank Feeds") in the same turn, then call
     show_lesson_sources with the citation.
   - get_my_training_checkpoint / save_training_checkpoint: resume where the learner left
     off, and save progress at natural stopping points. Checkpoints NEVER mark real course
     lessons complete — say so if asked.
   If a training tool returns a denial, a not-found, a not-ready, or an error message, relay
   that message warmly and act on its suggestions (e.g. offer the upgrade panel) — do not
   reveal anything about content the member's plan does not include, and remember that
   membership names (like "Live Group Track") are PLANS, not courses. If the tool reports
   low confidence, say the material may not fully cover the question instead of guessing.

   TEACHING STYLE: short, voice-friendly sections — never a monologue. Explain: give one
   compact explanation, then check understanding with one question. Guided lesson: walk the
   returned material in order, pausing after each chunk. Quiz/practice: ask ONE question at
   a time, wait for the answer, adapt difficulty to how they're doing. Recap: summarize the
   key points, then offer to save a checkpoint. Never read an entire lesson verbatim; teach
   at most three sentences before checking in.

   ROLE RULES: {{user_role}}=admin → no billing panels exist (admins have no subscription);
   they may open the Access Requests and Enrollments screens. {{user_role}}=member → never
   offer admin screens. If a tool reply says the user's plan does not include a page,
   explain that kindly and offer the upgrade panel.

   KNOWLEDGE: answer ONLY from the attached "toolkits-voice-agent-knowledge" document and
   the tool results. All prices are Philippine pesos (₱) — never convert to USD. If you are
   not sure, say: "I'm not fully sure from the current toolkit data, but I can guide you to
   the closest section." Never invent tools, prices, or policies.

   HARD LIMITS: you cannot approve payments, verify receipts, modify subscriptions, or see
   other users' data — those are admin actions; route payment or account problems to Coach
   Alex / the support email shown on the payment screen. No legal, tax, or financial
   guarantees — bookkeeping and tax guidance is educational and never promises outcomes.
   ```

5. **Security / Advanced**:
   - **Enable authentication** (require signed URLs) so nobody can connect to the agent
     with just its id — only your server can mint connections.
   - Set a **max conversation duration** (~10 minutes) as a cost cap.
   - Leave "overrides" disabled (the app does not use them).
6. Copy the **agent id** into `ELEVENLABS_AGENT_ID`.

## 4. Client tools (must match these names EXACTLY)

Dashboard → your agent → **Tools** → add seven **Client** tools. Enable **"Wait for
response"** on every one (the app returns a result string the agent should speak from).

**1. `navigate_to_tool`** — Opens a tool/tab in the app.
Description: `Navigate the app to a tool. Use whenever the user asks to open/find/see a tool or section.`
Parameters:

| name | type | required | description |
|---|---|---|---|
| `tool_id` | string | yes | Tab id (e.g. `qbomastery`, `proposal`, `bankfeed`, `converter`, `interview`, `mockinterview`) or the tool's spoken name (e.g. "statement converter"). |
| `reason` | string | no | Short reason to mention to the user. |

**2. `open_account_panel`** — Opens an account panel overlay.
Description: `Open one of the user's account panels. Members only for billing panels; settings works for everyone.`
Parameters:

| name | type | required | description |
|---|---|---|---|
| `panel` | string (enum: `settings`, `membership`, `upgrade`, `extend`, `renew`) | yes | Which panel to open. |

**3. `explain_current_page`** — No parameters.
Description: `Returns which page/panel the user is currently on, what it does, and whether their plan includes it. Call before explaining "this page".`

**4. `show_feature_help`** — Opens a feature and returns a how-to blurb.
Description: `Open a feature and get usage help for it.`
Parameters:

| name | type | required | description |
|---|---|---|---|
| `feature_id` | string | yes | Feature key, e.g. `mock_interview_simulator`, `bank_feed_ai`, `statement_converter`, `proposal_generator`, `chart_of_accounts`, `qbo_mastery`, `invoice_creator`, `discovery_call_simulator`, `niche_selector_quiz`, `sop_generator`. |

**5. `get_user_membership_summary`** — No parameters.
Description: `Returns the signed-in user's own plan, membership status, expiry/days left, scope, and pending-request state. Use for any question about their plan, access, or expiry.`

**6. `open_course_lesson`** — Opens a course (and optionally a lesson) in the app.
Description: `Navigate the app to a specific course (and optionally a lesson) the member is studying. Use ONLY the course_id/course_slug/lesson_id values returned by the training tools — never invent ids.`
Parameters:

| name | type | required | description |
|---|---|---|---|
| `course_id` | string | yes | The course id from a training tool result. |
| `course_slug` | string | yes | The course slug (e.g. `qbo-mastery`) from a training tool result. |
| `lesson_id` | string | no | Optional lesson id to open directly. |
| `reason` | string | no | Short reason to mention to the user. |

**7. `show_lesson_sources`** — Renders a clickable citation chip in the widget transcript.
Description: `Show a clickable source citation in the chat transcript after answering from course material. Call once per grounded answer with the citation the training tool returned.`
Parameters:

| name | type | required | description |
|---|---|---|---|
| `course_id` | string | yes | |
| `course_slug` | string | yes | |
| `lesson_id` | string | no | |
| `label` | string | yes | e.g. `"QuickBooks Online Mastery › Module 2 › Bank Feeds"` |

> The client-side implementations live in `VoiceAssistant.buildClientTools()` in
> `src/BookkeeperPro.jsx`. If you rename a tool in the dashboard, rename it there too —
> names must match exactly or the call surfaces as "unhandled".

## 4b. Server (webhook) tools — the AI course trainer

Four **Webhook** tools give the agent authorized access to course material. They are
provisioned automatically by `npm run ai:provision` from `VOICE_SERVER_TOOL_SPECS` in
`src/BookkeeperPro.jsx` (needs `APP_URL`); the manual recipe for each is:

- **Type**: Webhook · **Method**: POST · **URL**:
  `https://<your-app>/api/elevenlabs/trainer?action=<tool name>`
- **Headers**: `Authorization` = `Bearer {{secret__trainer_token}}` (the secret dynamic
  variable — ElevenLabs substitutes it into headers only, never the LLM context) and
  `Content-Type: application/json`.
- **Body schema**: as declared in `VOICE_SERVER_TOOL_SPECS` (course_ref / mode / query /
  lesson_ref for the context tool; course_id / topic / mode / understanding / next_step
  for the checkpoint save).

| Tool | Purpose |
|---|---|
| `get_my_training_catalog` | Lists ONLY the courses this member may study right now (live plan check). |
| `get_authorized_training_context` | Returns bounded, cited course excerpts for explain/guided/quiz/practice/recap — or a safe denial/not-found/not-ready message. |
| `get_my_training_checkpoint` | Where the learner left off (topic, lesson, next step). |
| `save_training_checkpoint` | Saves AI-training progress. Never touches real `lesson_progress`. |

Every call re-verifies the trainer token AND re-queries the member's live membership +
plan-scoped course entitlement in Supabase (service role) — **fail-closed**: if the
entitlement check is unavailable the tool returns a temporary-error message, never
content. Responses are bounded envelopes (≤6 chunks × ≤1,200 chars); the endpoint never
logs lesson content. Backend setup for all of this (migration #27, `TRAINER_TOKEN_SECRET`,
the `trainer-embed` Edge Function, per-course enablement) lives in
[COURSE_AI_TRAINER_SETUP.md](../../COURSE_AI_TRAINER_SETUP.md).

## 5. Dynamic variables

The app passes these at session start; reference them as `{{var}}` in the prompt/first
message (already used in section 3):

`user_name`, `user_role` (`admin`|`member`), `plan_label`, `plan_scope`,
`membership_status`, `days_left`, `current_tab`.

Plus one **secret** dynamic variable: `secret__trainer_token` — the short-lived HMAC
trainer session token. The `secret__` prefix tells ElevenLabs it may be used **only in
tool headers** (the §4b webhook tools) and is **never sent to the LLM**. It carries
identity only — the server re-checks the member's entitlement on every training call, so
`plan_label`/`plan_scope` etc. are informational and are NEVER trusted for authorization.

## 6. Knowledge base

The agent's product knowledge is the **generated** document
`docs/ai/toolkits-voice-agent-knowledge.md` — built from the app's own data
(routes, tool descriptions, plans, entitlements, tips) plus curated lifecycle prose.

- **Regenerate** after any tool/plan/entitlement change (same change, per CLAUDE.md):
  ```powershell
  npm run ai:knowledge
  ```
- **Upload via API** (recommended — replaces the old copy and re-attaches in one step;
  needs `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` in `.env` or the shell):
  ```powershell
  npm run ai:knowledge:push
  ```
  Idempotent: run it twice and the agent still has exactly one
  `toolkits-voice-agent-knowledge` document; other knowledge documents are untouched.
- **Manual fallback**: dashboard → agent → Knowledge base → add **Text/File** → paste or
  upload the generated markdown, name it `toolkits-voice-agent-knowledge`, usage mode
  **Prompt**, and delete the previous copy.

> There is **no auto-sync**. ElevenLabs does not re-crawl anything: when app features
> change, someone must regenerate and re-upload (the "Keeping docs current" checklist in
> CLAUDE.md includes this).

## 7. Access control model

- **Client**: the mic FAB renders only for signed-in users who pass the enrollment gate
  (`profile.is_admin`, or enrollment disabled, or gate state `pass`) AND only when the
  endpoint health check reports `configured:true`.
- **Server** (the real boundary): `POST /api/elevenlabs/signed-url` requires a valid
  Supabase session (401 otherwise) and `is_enrolled()` → admins or active members
  (403 otherwise). Caveat: if the RPC is missing/erroring the check **fails open** with a
  loud `[elevenlabs] is_enrolled indeterminate` warning in the Vercel logs — a stream of
  those means the membership gate is off (same tradeoff as the Anthropic proxy).
- **Rate limit**: 8 mints/min per user per warm instance (best-effort burst guard).
- **ElevenLabs side**: agent auth ON (signed URLs only) + max call duration cap.

## 8. Testing locally

1. `.env`: set `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` (plus the Supabase vars you
   already have). `npm run dev`.
2. Health check: `curl http://localhost:5173/api/elevenlabs/signed-url` →
   `{"ok":true,"configured":true}` (or `configured:false` when vars are unset — and the
   FAB won't render).
3. Sign in as a **member** → mic button appears bottom-right → Start voice session →
   browser asks for the microphone → status turns "Listening…".
4. Try: "Where is QuickBooks Online Mastery?", "Open the proposal generator", "Open my
   membership", "When does my access expire?", "What's on this page?" — the app should
   navigate/open panels while the agent talks.
5. Negative checks: signed-out `POST` → 401; a paywall-held account sees no FAB and gets
   403 on a direct POST; denying the mic shows a friendly error without minting.
6. Text fallback: during an active session, type in the "Or type instead…" box.
7. **Trainer webhook tools (curl — ElevenLabs cannot call localhost):** the dev server
   runs the real handler, so exercise it directly. Grab a `trainerToken` from a signed-in
   `POST /api/elevenlabs/signed-url` (browser DevTools → Network), then:
   ```powershell
   curl -X POST "http://localhost:5173/api/elevenlabs/trainer?action=get_my_training_catalog" `
     -H "Authorization: Bearer <trainerToken>" -H "Content-Type: application/json" -d "{}"
   ```
   No/garbage token → a spoken-style `session_expired` envelope (HTTP 200 — the agent can
   relay it); a valid token → only the caller's plan-allowed, trainer-enabled, published
   courses. Try `get_authorized_training_context` with
   `{"course_ref":"qbo mastery","mode":"explain","query":"bank feeds"}`.

## 9. Deploying to Vercel

1. Set the three env vars (Production + Preview) → Redeploy.
2. Prod smoke test: `https://<your-domain>/api/elevenlabs/signed-url` (GET) →
   `{"ok":true,"configured":true}`.
3. Sign in as a member on prod and run the section-8 script.
4. Watch the first days' usage in the ElevenLabs dashboard (Agents → analytics) and the
   Vercel function logs for `[elevenlabs]` warnings.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No mic button | Env vars unset (GET returns `configured:false`), user not enrolled/admin, or the health check failed — check `/api/elevenlabs/signed-url`. The result is cached per page load — hard-refresh after changing env. |
| "Voice assistant not configured yet" | POST returned `skipped: elevenlabs_not_configured` — vars missing on the server (redeploy after setting). |
| 401 on POST | No/expired Supabase session — sign in again. |
| 403 on POST | `is_enrolled()` returned false — the account has no active membership. |
| 429 | More than 8 session starts in a minute — wait and retry. |
| "Microphone access was blocked" | Browser permission denied — allow the mic for the site and press Try again. |
| Agent connects but tools do nothing | Tool names in the dashboard don't match section 4 exactly, or "Client tool" type wasn't selected. |
| Agent hallucinating features | Knowledge doc stale or not attached — run `npm run ai:knowledge:push` and confirm it's attached with usage mode Prompt (`npm run ai:knowledge:check` detects drift). |
| Trainer says "session expired" right away | `secret__trainer_token` missing/expired: `TRAINER_TOKEN_SECRET` unset on the server, or the token's 15-min TTL passed — end the call and start a new session. |
| Trainer says "not set up yet" | Migration #27 not run, or `TRAINER_TOKEN_SECRET` / `SUPABASE_SECRET_KEY` missing — see COURSE_AI_TRAINER_SETUP.md. |
| Trainer answers are keyword-matched / low quality | The `trainer-embed` Edge Function isn't deployed/reachable — the trainer falls back to keyword search. The course builder's AI Trainer panel shows an amber "Keyword fallback" pill. |
| Trainer denies a course the member should have | The course isn't **published**, isn't **AI-trainer-enabled**, has no **ready** sources, or the member's plan genuinely excludes it — check the AI Trainer panel + Preview-as-plan. |

## 11. Cost notes

Every voice session consumes ElevenLabs Conversational-AI minutes. Controls in place:
member/admin-only signed URLs, 8/min mint burst limit, dashboard max-call-duration cap.
Review usage in the ElevenLabs dashboard; drop the env vars in Vercel to switch the
feature off instantly.

## 12. Known limitations / future improvements

- Knowledge upload is manual-on-change (`ai:knowledge:push`) — `npm run ai:knowledge:check`
  exits 1 on drift, so a CI step could enforce it on merge.
- The transcript (and its course-citation chips) is not persisted; closing the panel keeps
  the session, ending it clears the transcript.
- The trainer token lives 15 minutes (a session is capped at ~10) — a long-idle session's
  next training call politely asks the user to restart the voice session.
- One language (English) — ElevenLabs agents support multi-language if wanted later.
- `feature_guides` currently has one real guide row (`mock_interview_simulator`); other
  `show_feature_help` entries use curated blurbs in `VOICE_FEATURE_HELP`.
