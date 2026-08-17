# Student Import — Thinkific → Toolkit migration (setup & runbook)

The **Student Imports** admin tab migrates legacy students from Thinkific into the Toolkit's own
Supabase membership system. It creates **real** Supabase Auth accounts (students set their own
password) and grants **real, dated subscription terms** that flow through `public.is_enrolled()`
exactly like a paid enrollment — never fake `enrollment_requests`, receipts, or payments.

> **The single most important fact:** a Thinkific **User** export (the file with `First Name, Last
> Name, ID, … Email, Enrollments - list, …`) has **blank emails** and **no reliable expiry**. It
> **stages** but grants **nothing**. You must supply each student's **email** and **exact current
> access expiry** from a second source before anything goes live. The tool enforces this — it never
> guesses paid access from a course title, an account-created date, a last-sign-in, or amount-spent.

---

## 1. What you need

**Source exports (merge as many as apply):**

1. **Thinkific User export** — user `ID`, name, course history (`Enrollments - list`), activity. This
   is the roster; it supplies the **Thinkific user id** (the durable match key) and course history.
2. **Thinkific Orders / Transactions export** — `email`, purchased product, payment status, amount,
   transaction date. This is where **email** and **payment** truthfully come from.
3. **An admin ledger** — if you track exact current access **expiry** per student anywhere else.
4. **A manually-prepared supplemental CSV** (the template below) — for anything that happened outside
   Thinkific, or to hand-correct a handful of students.

**The import template** (downloadable from the tab, exact columns):

```
thinkific_user_id, first_name, last_name, email, plan_key,
membership_started_at, membership_ends_at, payment_status, amount_paid, currency, legacy_enrollments, batch_code
```

- `thinkific_user_id` — the Thinkific `ID` (kept as a string; leading zeros preserved). The match key.
- `email` — required to create a new account.
- `plan_key` — one of `sampler`, `silver_self_paced`, `vip` (read
  live from `enrollment_plans`; you also map course-combos → plan inside the tool). This is a
  **per-row override**: when present and a recognized plan, it **wins over** the course-combo map
  for that row; a blank or unrecognized value falls back to the combo mapping (never a silent grant).
- `membership_started_at` / `membership_ends_at` — **ISO dates (UTC)**, e.g. `2026-07-20` or
  `2026-07-20T01:52:00Z`. `membership_ends_at` is the **exact** current expiry (required for the
  default *preserve* term mode).
- `batch_code` (#32) — **required for `vip` rows** (VIP is the only cohort plan): the cohort's code
  (e.g. `2026-08`), which must match an existing **open** batch in Admin → Batches. It sets
  `subscriptions.batch_id` and unlocks that batch's private VIP community. A premium row
  without a confirmed open batch is **blocked** (never guessed from course history, dates, or
  amounts). A blocked row is rejected **before** any account is created, so it produces no user,
  no profile and no subscription — it will **not** appear in Admin → Batches → "Needs batch
  assignment" (that queue lists *granted* premium subscriptions that have no batch, e.g. rows
  imported before #32 or granted by direct SQL). To clear a blocked row: create/open the batch in
  Admin → Batches, add its `batch_code` to the source or supplemental CSV, re-run the dry-run,
  then process. General-plan rows ignore the column (warning only).

---

## 2. Environment & Supabase setup

**Supabase (SQL):** run migration **`db/2026-07-23-student-imports.sql`** (or, on a fresh project,
the whole `db/000_full_database_bootstrap.sql`). It requires the enrollment + subscription-lifecycle
migrations first (it aborts with a clear message otherwise).

**Supabase (Dashboard → Auth → URL Configuration → Redirect URLs):** add
`https://YOUR-DOMAIN/welcome/set-password` (and your Vercel preview origin) so the invite/recovery
link lands on the forced set-password screen. Confirm your **Invite** email template is enabled (or
rely on Resend below — this app sends its own invite email).

**Environment variables** (Vercel → Settings → Environment Variables, Production + Preview; and `.env`
for a local pilot). See `.env.example` for the full annotated block:

| Var | Purpose |
|---|---|
| `SUPABASE_SECRET_KEY` | **Service-role secret.** Server-only, used ONLY inside `api/admin/student-imports.js` after an admin check. **Never `VITE_`-prefixed, never in the browser.** (Legacy fallback: `SUPABASE_SERVICE_ROLE_KEY`.) |
| `RESEND_API_KEY` / `RESEND_FROM` | Sends the one-time set-password invite link (link is emailed then **discarded**, never stored/logged). |
| `APP_URL` | Origin for the `/welcome/set-password` redirect (e.g. `https://toolkits.alexsagun.com`). |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Reused for the caller auth check (already set). |

Unlike the `notify-*` functions, this endpoint **also runs under `npm run dev`** (via the
`studentImportDevApi` middleware in `vite.config.js`), so you can run a local pilot with a local
`SUPABASE_SECRET_KEY`.

Health check: `GET /api/admin/student-imports` → `{ ok, configured, hasSecretKey, hasResend }`
(booleans only — no key/address is ever returned).

---

## 3. The workflow (in the tab)

1. **Upload** the Thinkific User CSV/XLSX (BOM, quoted commas, and Excel are handled; size/row/column
   caps enforced; a SHA-256 fingerprint flags a duplicate file).
2. **Map columns** to the canonical fields.
3. **Reconcile** a supplementary file (Orders/ledger/manual template) — joined by `thinkific_user_id`
   or email — to fill in the missing **email** and **exact dates**.
4. **Map course-combos → plan** — each distinct `Enrollments - list` combination is shown with a row
   count; map it to a plan, to **"Profile only (no access)"**, or to **"Manual review."** Suggestions
   are advisory only (QBO+Resume → *maybe* `silver_self_paced`; a **QBO-only** history yields **no
   suggestion at all** now that the QBO-only plan is retired — map it manually or send it to review;
   Sampler and VIP are never inferred). Per-student overrides are allowed.
5. **Validate & match** — the tool pre-checks client-side, then a **server dry-run** authoritatively
   matches each row (by Thinkific source link, then by normalized email — **never by name**).
6. **Preview** — an editable table with search/filters, a row-detail panel, and summary counts
   (Total / Ready / Warnings / Blocked / New / Existing / Conflicts / …).
7. **Dry run** — server writes each row's proposed action back; no accounts change.
8. **Confirm** — a modal states exactly how many accounts will be **created / merged / skipped /
   granted / imported-as-expired / invited**. **Blocked rows can never be processed.**
9. **Process** — bounded, resumable batches. You can pause/resume; a browser close, deploy, or
   timeout resumes from the persisted cursor.
10. **Review** — retry failed rows, resend an invite, and download a **sanitized** (formula-safe)
    error report.

---

## 4. Membership rules (how terms are granted)

- **Default = preserve exact dated expiry.** Active members get `ends_at` from the source (+3-day
  grace, matching the Toolkit policy); status is `active` only while the term is valid.
- **An existing longer/active term is NEVER silently shortened.** A same-plan import that ends sooner
  is skipped (the live term is preserved); a later one extends it.
- **Different active plan → manual review** by default (not silently overwritten).
- **Expired source memberships** import as **expired history** so the student lands on the normal
  renewal screen.
- **"Start a fresh full term today"** and **"Lifetime (no expiry)"** are explicit, non-default modes
  you choose per combo — never a hidden default.
- Imported subscriptions are marked `grant_source='import'` and linked to their import row, so a
  migration grant is always distinguishable from a verified payment.
- **VIP rows need a confirmed open `batch_code`** (#32) — blocked otherwise, and re-validated
  at process time (a batch closed between dry-run and process re-blocks the row). Batch-less
  premium grants (e.g. rows imported before #32) surface in Admin → Batches → "Needs batch
  assignment" and can be bulk-assigned there (idempotent, audited).
- **Batch capacities are NOT enforced on the import path.** Seat limits are checked (under a
  row lock) only when approving an enrollment or assigning a batch from Admin → Batches. A bulk
  import can therefore push a batch past its stated capacity — check the counts in
  Admin → Batches after importing a premium cohort.

---

## 5. Onboarding (how a student gets in)

A new imported account receives **one** email with a single-use link to
`/welcome/set-password`. On first sign-in the app forces a **set-password** screen (driven by
`profiles.account_origin='import'` + `onboarding_status != 'completed'`), the student sets their own
password, `complete_import_onboarding()` marks them done, and they drop into the normal membership
experience with their correct plan and exact remaining term. **Passwords are never emailed, shared,
generated into a CSV, or logged.** An existing confirmed Toolkit user is **merged** (linked + granted)
and receives **no** invite.

---

## 6. Pilot before the full population (do this first)

1. Run migration #26 on staging (or prod off-hours) and set the env vars.
2. Build a **synthetic** 3–5 row supplemental CSV (test emails you control; real-looking dates; one
   expired; one whose email matches an existing native account). **Never use the real student CSV for
   the pilot.**
3. Stage → map → **dry-run**; verify the proposed actions + counts.
4. Confirm → **process one small batch**; watch the results + events.
5. Verify each pilot account end-to-end: new → single invite → set password → correct plan + exact
   remaining term; existing → merged, no duplicate/invite; expired → renewal screen.
6. **Re-run the same job** to prove idempotency (no duplicate users/links/subscriptions/invites).
7. Only then, with the real Orders/ledger data, scale up in bounded batches with pause/resume.

---

## 7. Resume, retry & idempotency

- **Resumable:** the job stores a `cursor` and every row result. Re-invoking `process` continues from
  where it stopped — safe after a browser close, deploy, or serverless timeout.
- **Idempotent:** three keys make retries safe — Supabase auth-email uniqueness,
  `student_external_accounts.unique(source, external_user_id)`, and
  `subscriptions.unique(source_import_row_id)`. A retry after "auth user created but grant failed"
  re-matches the existing user and completes the grant — never a second account.
- **Never destructive:** the importer never auto-deletes an existing Auth user.

---

## 8. Privacy, security & retention

- The **raw uploaded file never leaves the browser** except as normalized, purgeable staged rows.
- Audit events store **IDs + safe status codes only** — never names, emails, raw rows, invite links,
  or secrets.
- Downloaded error reports are **CSV-formula-injection-safe** (cells starting with `= + - @` are
  neutralized).
- **Retention:** after a job completes, purge its staged raw rows (the job's `mapped` payloads) — the
  counts and audit trail remain. (`student_import_jobs.purged_at` marks a purged job.)
- Non-admins cannot reach the route (Admins-only screen), the API (401/403), or any `student_*` table
  (RLS admin-only). The service key never appears in the browser bundle.

---

## 9. Troubleshooting

- **"Server import is not configured"** → `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) is
  unset. Set it and redeploy.
- **Every row is Blocked (missing email)** → expected for a bare User export. Reconcile with an
  Orders/ledger export or the template to supply emails.
- **Invite email not received** → check `RESEND_API_KEY`/`RESEND_FROM` and that the Resend sender
  domain is verified; use **Resend invite** on the row after fixing config.
- **Student stuck on set-password** → confirm `${APP_URL}/welcome/set-password` is in Supabase's
  Redirect URLs and the link hasn't expired (use **Resend invite** to mint a fresh one).
