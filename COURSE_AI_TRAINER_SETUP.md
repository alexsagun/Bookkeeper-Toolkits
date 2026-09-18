# AI Course Trainer — setup guide

The voice assistant — **Toolkits Siri — AI Voice Guide & Course Trainer** — can **teach,
explain, quiz, practice, and recap** your Supabase-hosted courses with enrolled learners.
This guide is every backend/dashboard step to turn it on. The voice widget itself is set up
in [docs/ai/voice-agent-setup.md](docs/ai/voice-agent-setup.md) — do that first if you
haven't.

> ★ **Provisioning refuses to attach the trainer until the DEPLOYED app is ready.**
> `npm run ai:provision` will not create or attach the four webhook tools unless
> `TRAINER_TOKEN_SECRET` is set locally **and** the deployed
> `GET ${APP_URL}/api/elevenlabs/trainer` reports `configured:true`. A local `.env` value
> alone never satisfies it: attaching the tools to a live agent while the deployment lacks
> the secret would answer "not configured" to a learner mid-lesson. Follow the ship order in
> [Step 4](#step-4--provision-the-elevenlabs-side).

## What you get

- Learners ask the voice assistant to teach any course **their plan includes** — it
  answers ONLY from admin-approved course material, cites the course › module › lesson,
  and can open the exact lesson in the app.
- **Server-side, fail-closed authorization on every request.** Course content is never in
  the ElevenLabs knowledge base; the four webhook tools re-check the learner's live
  membership + plan scope (Sampler → QBO Essentials only, full plans
  → everything) in Supabase before returning a single sentence. If the entitlement check
  is unavailable, the trainer returns a temporary error — never content.
- A compact **AI Trainer** panel in the course builder: per-course enable switch,
  per-lesson index/transcript status, one-click Scribe transcription for uploaded/MP4
  videos (always admin-triggered, lands as a draft for review), manual transcript editing,
  course-level trainer notes, "Sync index", and **Preview as plan** (see exactly what a
  Sampler learner could get).
- Learners' AI progress is saved as **checkpoints** (resume where you left off). It is
  deliberately separate from real lesson progress — a conversation never marks lessons
  complete.
- Unpublishing a course, disabling its trainer, or editing a lesson takes effect on the
  **very next** trainer request (retrieval-time checks, not background cleanup).

## How it works (30 seconds)

```
Learner speaks → ElevenLabs agent → webhook POST /api/elevenlabs/trainer?action=…
  Authorization: Bearer <trainer token>   ← minted by signed-url.js, 15-min HMAC, identity only
  └─ trainer.js verifies the token, bumps a durable daily usage counter, then asks
     Supabase (service role): trainer_visible_courses(user) — the live plan check.
     Allowed → retrieval: pgvector (gte-small via the trainer-embed Edge Function)
     with automatic keyword-search fallback; bounded chunks + citations back to the agent.
     Denied → a polite message naming ONLY the learner's plan + their allowed courses.
```

Admin side: lesson text is chunked + indexed by `api/admin/course-trainer.js` (the Sync
button / auto-kick after a lesson save); video lessons teach from an **admin-reviewed
transcript** (Scribe or manual paste — YouTube/Vimeo are never scraped).

## Setup order at a glance

1. Run migration **#27** (`db/2026-07-24-course-ai-trainer.sql`).
2. Set `TRAINER_TOKEN_SECRET` (+ confirm `SUPABASE_SECRET_KEY`, `ELEVENLABS_API_KEY`,
   `APP_URL`) in `.env` **and** Vercel Production + Preview, then **redeploy**.
3. Deploy the **`trainer-embed`** Edge Function (dashboard editor — recommended, enables
   semantic search; skipping it leaves the trainer on keyword search).
4. Confirm the deployed trainer reports `configured:true`, then `npm run ai:provision`
   (Step 4 — the ship order). ★ Check `configured:true` yourself: the provisioner does not yet
   enforce it, and its read-only `--verify-only` check is not built (the script refuses the flag).
5. In the app: open a course → **Edit course** → **AI Trainer** → Enable → **Sync index**.
6. Transcripts for video lessons (Transcribe button or manual paste) → **Approve & index**.

## Step 1 — Run the SQL (#27)

Paste **[db/2026-07-24-course-ai-trainer.sql](db/2026-07-24-course-ai-trainer.sql)** into
**Supabase → SQL Editor → Run**. Idempotent — safe to re-run. It aborts with a clear
message if the enrollment/plan migrations (#13/#17/#19) haven't run yet.

It creates: the `vector` extension, `courses.ai_trainer_enabled`, the
`course_ai_sources → course_ai_chunks` knowledge tables (chunks have **no learner read
policy at all** — retrieval is server-side after authorization), the index-job queue,
`ai_training_checkpoints` + `ai_training_usage`, the service-role-only entitlement +
retrieval functions, and a trigger that marks sources stale when a lesson is edited.

## Step 2 — Environment variables

In `.env` (local) **and** Vercel → Settings → Environment Variables (Production +
Preview), then redeploy:

| Var | What |
|---|---|
| `TRAINER_TOKEN_SECRET` | **Required to provision the trainer.** ≥32 random characters (e.g. `openssl rand -hex 32` or any password generator). Signs the short-lived trainer session tokens. Set it in Vercel **Production AND Preview with the same value** — the webhook tools always call the production `APP_URL`, so a token minted by a Preview deployment is verified by Production — then **redeploy**. Unset in the deployment = the trainer health check reports `configured:false`, provisioning refuses the webhook tools, and the rest of the voice widget is unaffected. |
| `SUPABASE_SECRET_KEY` | Already set for Student Imports. The service-role key the trainer endpoints use AFTER verifying the caller. The trainer also reports `configured:false` without it. |
| `ELEVENLABS_API_KEY` | Already set for the voice widget. Also powers Scribe transcription. |
| `APP_URL` | Your deployed origin, e.g. `https://toolkits.alexsagun.com`. The ElevenLabs webhook tools call `${APP_URL}/api/elevenlabs/trainer`. Required to provision them; on a dev machine it can be passed inline for one run (Step 4). |

Check the deployment, not your `.env`:

```powershell
curl https://toolkits.alexsagun.com/api/elevenlabs/trainer
# → {"ok":true,"configured":true}
```

## Step 3 — Deploy the `trainer-embed` Edge Function (semantic search)

Without this function the trainer still works using Postgres keyword search; with it,
retrieval understands meaning ("reconcile my bank" finds the bank-feeds lesson). The
builder's AI Trainer panel shows which mode is live (green "Semantic search on" / amber
"Keyword fallback").

1. Supabase Dashboard → **Edge Functions** → **Deploy a new function** (the in-browser
   editor — no CLI needed).
2. Name it exactly **`trainer-embed`**, paste this code, and Deploy:

   ```ts
   // trainer-embed — gte-small (384-dim) embeddings for the AI course trainer.
   // Auth: the caller must present this project's service-role key (the Vercel
   // endpoints do). Rejects everything else — this function is not public.
   const session = new Supabase.ai.Session('gte-small');

   Deno.serve(async (req) => {
     const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
     const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
     if (!serviceKey || auth !== serviceKey) {
       return new Response(JSON.stringify({ error: 'forbidden' }), {
         status: 401, headers: { 'content-type': 'application/json' },
       });
     }
     if (req.method !== 'POST') {
       return new Response(JSON.stringify({ ok: true, model: 'gte-small', dim: 384 }), {
         headers: { 'content-type': 'application/json' },
       });
     }
     let texts;
     try { ({ texts } = await req.json()); } catch { texts = null; }
     if (!Array.isArray(texts) || texts.length === 0 || texts.length > 16
         || texts.some((t) => typeof t !== 'string' || t.length > 4000)) {
       return new Response(JSON.stringify({ error: 'bad_request' }), {
         status: 400, headers: { 'content-type': 'application/json' },
       });
     }
     const embeddings = [];
     for (const t of texts) {
       embeddings.push(await session.run(t, { mean_pool: true, normalize: true }));
     }
     return new Response(JSON.stringify({ model: 'gte-small', dim: 384, embeddings }), {
       headers: { 'content-type': 'application/json' },
     });
   });
   ```

3. If the dashboard asks about **JWT verification**, turn "Enforce JWT verification"
   **ON** (the service key is a valid JWT) — the code above additionally requires it to
   be the *service-role* key, so members/anon keys are rejected either way.
4. Verify: the AI Trainer panel's pill turns green after the next Sync, or
   `curl -H "Authorization: Bearer <service key>" https://<project>.supabase.co/functions/v1/trainer-embed`
   → `{"ok":true,"model":"gte-small","dim":384}`.

> Deployed later? No problem — run **Sync index** again on each trainer-enabled course to
> backfill embeddings (chunks indexed during fallback carry no vectors and are re-embedded
> on the next version bump; a quick edit-save of a lesson or Retry forces one).

## Step 4 — Provision the ElevenLabs side

`npm run ai:provision` creates/updates the **4 webhook tools** (URL =
`${APP_URL}/api/elevenlabs/trainer?action=…`, header
`Authorization: Bearer {{secret__trainer_token}}`), the 7 client tools, the Toolkits Siri
system prompt and the knowledge document — and it refuses to start until every check
passes. It stops at PREFLIGHT, before a single write, on:

- `NO_APP_URL` — **fatal**. `APP_URL` unset no longer "skips" the webhook tools: a run
  without it would **detach** working trainer tools from the agent.
- `NO_TRAINER_SECRET` — `TRAINER_TOKEN_SECRET` is not set locally.
- `TRAINER_NOT_CONFIGURED` — checked against the **deployed** app: the trainer GET does not
  report `configured:true`. Setting the secret in `.env` does not clear this; setting it in
  Vercel and redeploying does.
- `TRAINER_HEALTH_UNREACHABLE` — that GET could not be read at all.

**Ship order (load-bearing):**

1. Deploy the frontend.
2. Set `TRAINER_TOKEN_SECRET` in Vercel **Production AND Preview** (same value).
3. **Redeploy.**
4. Confirm `GET https://toolkits.alexsagun.com/api/elevenlabs/trainer` →
   `{"ok":true,"configured":true}`.
5. Provision, passing `APP_URL` inline from a dev machine:
   ```bash
   APP_URL=https://toolkits.alexsagun.com npm run ai:provision
   ```
   PowerShell:
   ```powershell
   $env:APP_URL = 'https://toolkits.alexsagun.com'; npm run ai:provision
   ```
6. Verify the live agent. ★ There is no automated read-only check yet: `--verify-only` is
   planned but **not implemented**, and the script refuses it rather than run. Until it lands,
   open the agent in the ElevenLabs dashboard and confirm its tools, system prompt and attached
   knowledge document match `docs/ai/voice-agent-setup.md` §3–§4.

Preview first with `npm run ai:provision -- --dry-run`: it runs the same checks, prints the
plan, and never writes. The escape hatch `--client-only` provisions the client tools alone
and is refused while the agent already has webhook tools attached. The full state machine,
every blocker and the rollback behaviour: voice-agent-setup.md §3a. Manual fallback:
voice-agent-setup.md §4b.

★ **`scripts/provision-voice-agent.mjs` has not caught up with this section yet** — it takes
`--dry-run` only, and its prompt sentinel is still the assistant's previous name, so today every
run aborts with a misleading *"the extracted system prompt looks wrong"* before any of the
blockers above can be reached. See the ★ note at the top of voice-agent-setup.md §3a for what
must change and, in particular, what must **not** (do not put the old name back in the prompt).

## Step 5 — Enable + index a course

1. Open the course (e.g. QBO Mastery catalog → the course) → **Edit course**.
2. The **AI Trainer** card sits under Course settings → click **Enable**.
3. Click **Sync index** — text lessons are chunked + embedded automatically.
4. Lesson rows show status pills: **Ready** (teachable) · **Needs sync** · **Stale**
   (lesson edited since last index; saving a lesson auto-kicks a re-sync) · **Failed**
   (hover the retry icon) · **Not indexed**.
5. **Preview as plan**: pick e.g. *Sampler Session* + a test question → see exactly which
   courses/excerpts that plan's learner could receive. Ten-second entitlement check.

## Step 6 — Transcripts for video lessons

A video lesson teaches only from an **approved transcript** (the trainer never watches
video, and YouTube/Vimeo pages are never scraped):

- **Uploaded videos + direct MP4 links** → the row shows a mic button → **Transcribe**
  (ElevenLabs **Scribe v2** — a paid API billed per audio-hour; it always asks first).
  The transcript lands as a **draft** → *Edit transcript* to review → **Approve & index**.
- **YouTube/Vimeo lessons** → *Add transcript* → paste the transcript (YouTube Studio →
  Subtitles, or your own) → **Approve & index**.
- Replacing a lesson's video automatically marks its old transcript stale.

Course-level **Trainer notes** (optional) work the same way — extra approved context
(course summary, key definitions, FAQs) the trainer may draw on alongside lessons.

## Learner experience

- "Teach me bank feeds from QBO Mastery" → grounded explanation + a source chip in the
  transcript (tap → opens that exact lesson).
- "Quiz me on module two" → one question at a time, adapting to answers.
- "Where did we leave off?" → resumes from the saved checkpoint.
- Asking for a course outside their plan → a warm denial naming their plan + what they CAN
  study + an offer to open Upgrade Plan. No lesson titles or content ever leak.
- Daily caps protect cost: 150 teaching retrievals / 60 catalog / 100 checkpoint calls
  per learner per day (durable, in `ai_training_usage`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Builder shows "Finish backend setup" | Migration #27 not run — Step 1. |
| `ai:provision` stops with `TRAINER_NOT_CONFIGURED` | The deployed trainer GET reports `configured:false` — `TRAINER_TOKEN_SECRET` (or `SUPABASE_SECRET_KEY`) missing in Vercel. Set it in Production + Preview, **redeploy**, confirm the GET, re-run. A local `.env` value does not clear this. |
| `ai:provision` stops with `NO_TRAINER_SECRET` | `TRAINER_TOKEN_SECRET` is not in your local `.env` / shell. |
| `ai:provision` stops with `NO_APP_URL` | Pass `APP_URL=https://toolkits.alexsagun.com` inline (or `--app-url`). Fatal on purpose — continuing would detach the trainer tools. |
| Trainer says "not set up yet" | `TRAINER_TOKEN_SECRET` or `SUPABASE_SECRET_KEY` missing on the server (Step 2), or #27 not run. |
| Trainer says "session expired" immediately | The signed-url endpoint isn't minting tokens — `TRAINER_TOKEN_SECRET` unset, a Preview deployment whose secret differs from Production's, or the 15-minute token elapsed (restart the voice session). |
| Amber "Keyword fallback" pill | `trainer-embed` not deployed/unreachable (Step 3). The trainer still works — with keyword search. |
| "The trainer is temporarily unavailable" | The entitlement check failed — this is the **fail-closed** path (Supabase down/misconfigured). Check Vercel logs for `[trainer]` lines (codes only, never content). |
| Transcribe fails / times out | Very long videos can exceed the serverless window (300s). Retry, or paste the transcript manually — the manual path always works. Check `ELEVENLABS_API_KEY`. |
| A course the learner should have is denied | It must be **published** + **AI Trainer enabled** + have ≥1 **Ready** source, and the learner's plan must include it — check the panel + Preview as plan. |
| Learner asks about "Personalized Coaching Program" etc. | Membership names are plans, not courses — the trainer offers the actual courses their plan includes. Working as intended. |

## Cost notes

- **Scribe transcription** is billed per audio-hour and only ever runs from the explicit
  admin button (with a confirm dialog).
- **Embeddings** (gte-small in the Edge Function) are effectively free at this scale;
  re-indexing only touches changed sources (content hashes).
- **Voice minutes** are the same ElevenLabs conversational cost as before; the trainer
  adds webhook calls (free) and the daily per-learner caps above.
