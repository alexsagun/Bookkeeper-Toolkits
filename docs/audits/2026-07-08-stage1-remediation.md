# Stage-1 Remediation Design — Pre-Deploy Blockers

**Companion to:** [2026-07-08-predeploy-audit.md](2026-07-08-predeploy-audit.md)
**Goal:** clear every deploy blocker (1 Critical + 5 High) plus two quick data-exposure fixes and a proportionate `xlsx` guard, so the app can ship to Vercel. All changes respect the single-file architecture, existing token/`callClaude`/RLS patterns, and add no new build config.

**Scope decided (engineer's call, optimizing for security):** the 8 audit items **+ a cheap `xlsx` input guard** (self-inflicted-only CVE — see item 9). "Stage 1 vs Stage 2" just means *ship-before-deploy* vs *harden-after-launch*.

---

## 1. C1 — Authenticate the AI proxy *(Critical)*

**Problem:** [api/anthropic/v1/messages.js](../../api/anthropic/v1/messages.js) forwards any POST to Anthropic with the server key — no auth, caps, or limits. Public endpoint = open billing abuse.

**Design — three layers:**
1. **Client attaches the session token.** In `callClaude()` ([src/BookkeeperPro.jsx](../../src/BookkeeperPro.jsx) L214), fetch the current Supabase access token (`supabase.auth.getSession()`) and add `Authorization: Bearer <token>` to the request headers. The fetch shim already rewrites the URL to `/api/anthropic/v1/messages`; Anthropic ignores unknown auth headers, so dev still works.
2. **Server verifies + gates.** In `messages.js`, before forwarding: read the bearer, verify via `GET ${SUPABASE_URL}/auth/v1/user` with the `apikey: ANON_KEY` header (the exact pattern `api/notify-access.js` `callerIsAdmin()` already uses). 401 if absent/invalid. Then require the caller be **admin or enrolled** — read `profiles.is_admin` / call the `is_enrolled()` RPC with the caller's JWT (RLS-scoped). This bounds token spend to paying members + admins.
3. **Input caps.** Reject if body > ~5 MB (vision base64 headroom), `model` not in an allowlist (`['claude-sonnet-4-6']`), or `max_tokens` > 8192. 400 with a clear message.

**Rate limiting:** deferred to Stage 2 (serverless is stateless; a real limiter needs Upstash/a Supabase counter). The admin-or-enrolled gate is the Stage-1 cost control.

**Dev parity:** the Vite dev proxy ([vite.config.js](../../vite.config.js)) stays as-is (local-only, no auth check) — note the divergence in a comment.

**Files:** `api/anthropic/v1/messages.js`, `src/BookkeeperPro.jsx` (`callClaude`).
**Verify:** unauthenticated POST → 401; signed-in-but-unenrolled non-admin → 403; over-cap `max_tokens` → 400; in-app AI tools (ProChat, BankFeed, StatementConverter) still work signed-in.

---

## 2. C2 — Protect paid lesson videos *(High)*

**Problem:** `course-media` is a **public** bucket; every lesson video streams via `getPublicUrl` with no gate. **Key correction:** a public Supabase bucket serves *all* its objects publicly and bypasses RLS on read, so path-prefix RLS inside it cannot protect a subset.

**Design — second private bucket for lesson videos only** (honors the "split: covers/guides stay public" choice with the smallest blast radius and best perf):
- **New migration** `db/2026-07-08-course-videos-private.sql`: create a **private** bucket `course-videos` (`public=false`, 50 MB limit, video mime allowlist). RLS on `storage.objects`:
  - insert/update/delete → `to authenticated using bucket_id='course-videos' and public.is_admin()` (admins upload).
  - select → `bucket_id='course-videos' and (public.is_admin() or public.is_enrolled())` (only enrolled/admin can create signed URLs).
- **Covers + feature-guide videos stay in the public `course-media` bucket, unchanged** — zero catalog-render changes, covers keep CDN performance (no per-cover signing).
- **Client (lesson video only):**
  - Upload (CourseProgram lesson upload, ~L6713/L7617 path `lessons/{course.id}/…`) → target `course-videos`.
  - Playback (L6807) → replace `getPublicUrl` with `createSignedUrl('course-videos', path, 3600)` (async; store the signed URL in state as the player already does).
  - Cleanup: `removeMediaIfUnreferenced` (L7330) and lesson delete/list → make bucket-aware (lesson `storage_path` → `course-videos`; `cover_path` → `course-media`). Simplest: a small `bucketFor(path)` helper keyed on the `lessons/` vs `covers/` prefix.
- **Existing lesson videos:** the migration doc includes a one-time note — if there is real content in `course-media/lessons/*`, copy it to `course-videos` (Storage move) or re-upload; a pre-launch app with no content needs nothing. Playback falls back gracefully (if a legacy row still resolves in `course-media`, sign from there) — optional compat shim.

**Files:** new SQL migration; `src/BookkeeperPro.jsx` (lesson upload/playback/cleanup + `bucketFor` helper); update `db/000_full_database_bootstrap.sql` + `COURSE_SETUP.md` to describe the two-bucket model.
**Verify:** signed-out/unenrolled `getPublicUrl` on a lesson path → no longer valid; enrolled user plays lessons via signed URL; covers + Mock-Interview guide video still render for any signed-in user.

---

## 3. C3 — Course-media cleanup deletes shared files on a swallowed error *(High)*

**Problem:** `removeMediaIfUnreferenced` (L7337) destructures only `data`, so a returned PostgREST `{error}` leaves `referenced` empty → deletes everything, incl. duplicated-course videos.
**Fix:** capture `error` on both reference-check queries; on either error, `logDbError` + `return` (keep the files — matches the L7345 comment). One-block change.
**Files:** `src/BookkeeperPro.jsx` L7337–7343.
**Verify:** point the check at a bad table name (simulated error) → no `storage.remove` fires.

---

## 4. C4 — BankFeed misassigns AI suggestions *(High → Broken)*

**Problem:** the merge (L7947–7965) sets `needsAI=false` while re-deriving each target by counting `needsAI` in the same mutated array → wrong-row assignment + dropped rows when ≥2 lines are unmatched.
**Fix:** precompute the unmatched indices before the loop:
```js
const aiIdx = [];
initialResults.forEach((r, i) => { if (r.needsAI) aiIdx.push(i); });
// then: const targetIdx = aiIdx[ai.i - 1] ?? -1;  (guard merged[targetIdx]?.needsAI)
```
**Files:** `src/BookkeeperPro.jsx` L7947–7965.
**Verify:** 3 unmatched memos → 3 correctly-mapped suggestions, none dropped; the existing 1-unmatched and all-matched paths unchanged.

---

## 5. C5 — Enrollment receipt upload keyboard/SR-inaccessible *(High)*

**Problem:** drop-zone `div` (L2322) has `onClick` only; the file input (L2328) is `className="hidden"` (out of tab order). Keyboard/AT users can't attach the mandatory receipt.
**Fix:** add `role="button" tabIndex={0} aria-label="Upload payment screenshot"` and `onKeyDown` (Enter/Space → `fileInputRef.current?.click()`) to the drop-zone div. Apply the identical fix to the StatementConverter drop zone (L2280/T4-F9) since it's the same defect and one edit-pattern.
**Files:** `src/BookkeeperPro.jsx` L2320–2330 (+ L2280 region).
**Verify:** Tab to the zone → visible focus ring → Enter opens the file dialog → receipt attaches → submit succeeds.

---

## 6. C6 — Sidebar customization storage-namespace race *(High)*

**Problem:** the sidebar load effect (L3200–3236, `[]` deps) reads `sidebar:*` before `applyStorageUser(uid)` runs → reads hit the bare namespace, writes go to `u:<uid>:*`, customization lost each reload.
**Fix:** gate the load effect on `[user?.id]` and bail while `!user?.id` (mirrors the `nav:lastTab` effect), so it (re)runs once the per-user namespace is set and re-runs on account switch. Confirm the persist effects already key off `storageReady` (they do) so no double-write.
**Files:** `src/BookkeeperPro.jsx` L3200–3236 (effect deps + guard).
**Verify:** customize sidebar → reload → layout persists; sign in as a second account on the same browser → that account sees its own (default) layout, no bleed.

---

## 7. R6 — Remove receipt self-delete *(Medium, data integrity)*

**Problem:** `enrollment_receipts_delete` (enrollment.sql L272–278) lets the owner delete their own receipt after submitting → payment-evidence loss.
**Fix (new migration** `db/2026-07-08-receipt-integrity.sql`**):** replace the policy so **only admins** delete (`using (bucket_id='enrollment-receipts' and public.is_admin())`). The client's best-effort failed-submit cleanup (L2029) becomes a harmless no-op (already wrapped in try/catch; orphaned files on failed submits are unreferenced and admin-purgeable).
**Files:** new SQL migration + bootstrap/`ENROLLMENT_SETUP.md` update.
**Verify:** owner delete of own receipt → RLS denies; admin delete still works; a normal submit is unaffected.

---

## 8. R5 — payment_settings read exposure *(Medium — recommend NOT changing)*

**Assessment:** `payment_settings_read = using(true)` exposes bank/GCash numbers to any authenticated user. **But** these are payment-*receiving* instructions that the paywall must show to every not-yet-paid user (who are exactly "authenticated, unenrolled"), so tightening risks breaking the pay flow for legitimate users and yields little — this is inherent to a manual-payment paywall, not a secret leak.
**Recommendation:** **leave as-is** for Stage 1. If desired later, exclude only clearly-ineligible users (`is_admin() OR (not rejected and not already enrolled)`) — but verify it doesn't hide instructions from any paywall state first. Documented, not implemented.

---

## 9. `xlsx` CVE — proportionate guard *(security, right-sized)*

**Assessment:** `XLSX.read` (L17695, QB Diagnostic) is fed a **user-selected local file**, so the prototype-pollution/ReDoS CVEs are **self-inflicted only** (harm the uploader's own tab) — not third-party-exploitable. The heavy fix (swap to the maintained SheetJS CDN build) is a dependency-sourcing change that needs its own decision and violates "no new build config without asking."
**Stage-1 fix (cheap, real):** before `XLSX.read`, guard file size (e.g. ≤ 5 MB) and extension/mime (`.xlsx/.xls/.csv`), and keep the parse in its existing `try/catch` with a rendered error. This bounds the ReDoS/parse surface and improves UX. Full library migration → Stage 2 (or accept, given self-inflicted-only risk).
**Files:** `src/BookkeeperPro.jsx` ~L17690 (QB Diagnostic upload handler).
**Verify:** oversized/wrong-type file → clean rendered error, no parse attempt; valid file still imports.

---

## 10. Hygiene — gitignore the build artifact

Add `build_output.txt` to `.gitignore` (or delete it) so the stale build log isn't committed. One line.
**Files:** `.gitignore`.

---

## Sequencing & commits

Suggested order (low-risk → higher): **10 → 3 → 4 → 5 → 6 → 9 → 7 → 1 → 2**. C1 and C2 are the largest; do them last with focused testing. Group as logical commits (e.g. "security: authenticate AI proxy", "security: private lesson-video bucket + signed URLs", "fix: 4 correctness/a11y blockers", "db: receipt-delete integrity", "chore: gitignore build log"). Branch off `main` (per house rule) — do not commit to `main` directly.

## Verification plan (end-to-end)

1. `npm run build` clean after each grouped change.
2. `npm run dev` → exercise ProChat / BankFeed (paste ≥2 unknown vendors → correct mapping) / StatementConverter / the enrollment paywall (keyboard-only receipt upload) / sidebar customize→reload / QB Diagnostic xlsx guard.
3. Apply the three new SQL migrations to the Supabase project; confirm: unauth AI POST → 401, lesson video needs a signed URL, receipt owner-delete denied, covers/guide video still load.
4. Dark-mode spot-check of any touched screen (house acceptance rule).

## Out of scope (Stage 2)
Everything in audit §I Stage 2: dark-mode token sweep, broad a11y pass, persistence gaps, content-staleness, dead-code removal, full `xlsx` migration, native-dialog→glass modals, migration guardrails, and the deferred audit resume (T7–T23 + Med/Low verification).
