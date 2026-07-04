# Enrollment & manual-payment gate — setup

Students now enroll **inside the app**: a signed-in user who hasn't paid is held on an
**Enrollment Paywall** (pricing cards → manual payment instructions → payment-proof upload)
and then a **"Payment Under Review"** screen, until you approve their submission from the
in-app **Enrollments** admin tab. Approving one request **unlocks everything in one click**
(`is_paid`, `plan`, `approval_status`, plus an active `subscriptions` record). This is a
**manual payment-verification** workflow (BPI / Security Bank / GCash + receipt upload) —
**not** an online checkout.

Since the **subscription lifecycle** upgrade ([`db/2026-07-04-subscription-lifecycle.sql`](db/2026-07-04-subscription-lifecycle.sql)),
approval grants a **dated term**: each plan carries an `access_days` duration (60 for
Core / Sampler / Silver, 180 for Gold / VIP), the subscription gets a real `ends_at`, the
student sees a **membership panel on the Dashboard** (plan, status, days remaining, renew
button, warnings at 14 / 7 / 3 days), and when the term ends they're locked on a
**Membership Expired** screen until an admin approves their **renewal** — same pricing +
receipt-upload + review flow. See "Membership lifecycle & renewal" below.

Builds on the `profiles` table (AUTH_SETUP.md), `public.is_admin()` (COURSE_SETUP.md), and —
recommended — the admin-approval migration
[`db/2026-06-29-user-approval.sql`](db/2026-06-29-user-approval.sql). Do those first.

---

## How it works

Student states (the gate in [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx) renders one full-screen
step per state):

| State | What the student sees |
|---|---|
| Not logged in | Auth screen (unchanged) |
| Logged in, unpaid, no request | **Enrollment Paywall** — pricing cards, payment instructions, proof form |
| Submitted proof (`pending_review`) | **Payment Under Review** — package, amount, dates, live status |
| Rejected | Resubmit notice with your reason → back to the paywall |
| Expired / overdue (3-day window) | "Request expired" notice → resubmit |
| Approved + paid (term running) | Full toolkit + **membership panel** on the Dashboard |
| **Membership expired** (term's `ends_at` passed) | **Membership Expired** screen → Renew → paywall in renewal mode |
| **Renewal under review** (expired member resubmitted) | "Renewal Under Review" screen until you approve |
| Renewing **early** (term still running) | Keeps full access; panel shows "Renewal under review" |
| Admin | Always passes; gets the **Enrollments** tab |

- **Gate precedence:** old-flow rejected accounts stay on the Rejected screen (a ban can't be
  paid around) → then the enrollment gate (it **replaces** the old "Access Pending Approval"
  screen for unpaid users) → then the legacy approval gate (active only when enrollment is off
  or not yet migrated).
- **Grandfathering:** the migration's one-time backfill sets `is_paid = true` for every account
  that is already `approval_status = 'approved'` — **running it never locks out current users.**
  Only new/unpaid accounts see the paywall.
- **Data:** `enrollment_plans` (the 5 seeded pricing cards — admin-editable rows; now with
  `access_days` / `support_days` / `entitlement_summary`), `enrollment_requests` (one row per
  submission, append-only from the student side — renewals are just new rows),
  `subscriptions` (the plan record — now a dated **term** with `ends_at`, `grace_ends_at`,
  `renewed_from_subscription_id` lineage), `payment_settings` (the bank/GCash details shown on
  the paywall — editable in-app). Receipts upload to a **private** `enrollment-receipts` bucket;
  admins preview them via **signed URLs** (first use of `createSignedUrl` in the app).
- **RLS enforces it** (not just the UI): students can only read/insert their **own** requests,
  can never set `status='approved'` (the only student update is expiring their own overdue row
  so they can resubmit), can't touch `profiles.is_paid` **or any `subscriptions` column**, and
  course/lesson/feature-guide reads require `public.is_enrolled()` — which, after the lifecycle
  migration, means an **active subscription whose term hasn't ended** (dates checked server-side
  in SQL), not just the `is_paid` boolean. Terms are granted only through the admin-guarded
  `approve_subscription()` function.

---

## Step 1 — Run the migration (required)

Supabase Dashboard → **SQL Editor → New query** → paste **all** of
[`db/2026-07-04-enrollment.sql`](db/2026-07-04-enrollment.sql) → **Run**. It is idempotent.

It creates the four tables (with the 5 plans + your BPI / Security Bank / GCash details seeded),
the private `enrollment-receipts` bucket + storage policies, the `public.is_enrolled()` helper,
Realtime on `enrollment_requests`, and runs the **one-time grandfather backfill** described above.

> ⚠️ **Migration order matters.** Run [`db/2026-06-29-user-approval.sql`](db/2026-06-29-user-approval.sql)
> (and, if you use it, `db/2026-06-22-feature-guides.sql`) **before** this file. Section 7 of this
> migration tightens the course/feature read policies to `is_approved() AND is_enrolled()`; if
> `is_approved()` doesn't exist yet it **skips that section with a NOTICE** — re-run this file after
> running user-approval. (Re-running is always safe; the plan/payment seeds use
> `on conflict do nothing`, so your in-app edits survive.)

> Make sure the project you run this in is the same one your app's `VITE_SUPABASE_URL` points at.

## Step 1b — Run the subscription-lifecycle migration (required for durations/expiry/renewal)

Same SQL Editor → paste **all** of
[`db/2026-07-04-subscription-lifecycle.sql`](db/2026-07-04-subscription-lifecycle.sql) → **Run**.
Idempotent; safe to re-run. **Order:** `2026-06-29-user-approval.sql` → `2026-07-04-enrollment.sql`
→ **this file** (it stops with a clear exception if the enrollment tables don't exist yet).

It adds `access_days` / `support_days` / `entitlement_summary` to `enrollment_plans` (seeding
60 / 60+30 / 60 / 180 / 180 days for the five plans — only where still unset, so your in-app
edits survive), adds `ends_at` / `grace_ends_at` / `renewed_from_subscription_id` / `updated_at`
to `subscriptions`, rewrites **`public.is_enrolled()` to be date-aware**, creates the
`approve_subscription()` and `expire_overdue_subscriptions()` admin functions, and adds
`subscriptions` to Realtime.

> **Deploy order doesn't matter**: the client tolerates the old schema (no `ends_at` → treated
> as "no expiry"; missing functions → the legacy approve path). And running the SQL before the
> deploy is also fine — old clients simply don't read the new columns.

## Membership lifecycle & renewal

- **Durations:** approval stamps `ends_at = start + access_days` (Core/Sampler/Silver **60
  days**, Gold/VIP **180 days**; Sampler also records `support_days = 30`, shown to the student
  but not RLS-enforced). A plan with `access_days = NULL` never expires. Edit durations in the
  `enrollment_plans` table (no redeploy needed).
- **Renewal stacking:** approving a renewal **extends from the current expiry** when the term is
  still running (`ends_at = greatest(now, current ends_at) + access_days`) — renewing early
  never loses days. After expiry, the new term starts at approval time. The old row is marked
  `expired` with `renewed_from_subscription_id` linking the new term to it (full history kept).
- **Expiry:** the **date is the authority** — `is_enrolled()` compares `ends_at` to `now()` in
  SQL, so content reads are blocked server-side the moment a term lapses (the client shows the
  Membership Expired screen). The `status` column is flipped to `'expired'` lazily by
  `expire_overdue_subscriptions()` (runs whenever an admin opens the Enrollments tab) — purely
  cosmetic for filters.
- **Renewal flow:** expired member → **Renew** → same pricing cards (with duration chips +
  "Current plan" marker) → payment proof → "Renewal Under Review" → admin approves → access
  restored instantly (Realtime) or within ~30s. Students with a **running** term renew early
  from the Dashboard panel's Renew button (a full-screen overlay) and keep access while the
  renewal is pending.
- **Warnings:** the Dashboard membership panel warns at **14 / 7 / 3** days remaining
  (escalating amber → red; the Renew button is promoted at ≤7 days).
- **Grace period:** off by default. To add one, edit `v_grace_days` in `approve_subscription()`
  (e.g. `:= 3`) — the column, RLS check, and client math already honor it. You can also hand-set
  `grace_ends_at` on a single row as a one-off extension.
- **Grandfathering:** rows created before the lifecycle migration keep `ends_at = NULL` = **no
  expiry** (nobody is locked out by running it); paid profiles with no subscription rows at all
  also stay enrolled. Their **next renewal** converts them to a dated term. To put legacy
  members on the clock instead, use the commented backfill in section 7 of the migration.
- **Legacy no-expiry member renews:** their new term is dated (starts at approval) — renewing
  converts unlimited → dated by design.

## Step 2 — Verify the receipts bucket is private

Supabase Dashboard → **Storage** → `enrollment-receipts` should exist and show **Private**.
The migration creates it (and force-corrects it to private on re-run), with a 5 MB size cap and
an image/PDF mime allowlist. Receipts live at `<user-id>/<uuid>-<filename>`; only the owner and
admins can read them.

## Step 3 — Review enrollments (approve / reject / expire)

Sidebar → **Enrollments** (admin-only, with a pending-count badge; also at `/admin/enrollments`):

- Filters — **payment requests**: Pending / Overdue / **Renewals** (pending requests from
  students who already have a subscription) / Approved / Rejected / Expired. Overdue = still
  pending past the 3-day `expires_at` window (shown with "Nd overdue").
  **Memberships** (one card per student, by their latest request): **Active / Expiring soon**
  (≤ 14 days left) / **Ended**. Opening the tab also runs `expire_overdue_subscriptions()` so
  statuses are truthful.
- Each card shows the student, package, **amount sent vs expected** (mismatch highlighted),
  reference number, dates, a **Renewal** chip when the submitter already has a subscription,
  and a **Receipt** preview (signed URL — images open in a modal, PDFs in a new tab). A
  **membership strip** under the card shows their current term: plan, started → ends dates,
  "Nd left" / "ended Nd ago", and an Active / Expiring / Ended pill. Expand a card for the
  student's background and a private **admin note**.
- **Approve & unlock** → the request is approved, the student's profile gets
  `is_paid=true / plan / approval_status='approved'`, and a **dated subscription term** is
  granted via `approve_subscription()` — the confirm dialog previews **"Will grant access until
  {date}"** (including carry-over when they renew early). Their "Under Review" screen advances
  into the toolkit **live** (Realtime) or within ~30s. If a later step fails mid-approve you'll
  see a "grant incomplete — Approve again" chip; clicking Approve again is safe (idempotent).
- **Reject** (with a reason shown to the student) or **Mark expired** → the student stays locked
  out, sees the notice, and can **resubmit** new proof (a fresh request row — history is kept).
- **Payment details** (collapsible section at the top) edits the account name / BPI /
  Security Bank / GCash / support email shown on the student paywall — saved for everyone, no SQL.
- **Sound alert** (🔔 toggle) — opt-in, clearly-audible **3-tone chime (played twice)** when a
  new submission arrives while the tab is open, plus a **Test** button (visible when sound is
  on) to check the volume. Browsers only allow audio after a click, which is why it's a toggle
  (off by default) and why the Test button doubles as the audio unlock. The preference persists
  per admin (`enroll:soundAlert`).

## Step 4 — (Optional) Email notifications

Everything works **without** email. To get notified of new submissions and to email students on a
decision, set these server-side env vars in **Vercel → Settings → Environment Variables**
(Production + Preview), then redeploy:

- `RESEND_API_KEY` — your Resend key (`re_…`)
- `RESEND_FROM` — a verified sender, e.g. `Toolkits by Alex <noreply@yourdomain.com>`
- `NOTIFY_ADMIN_EMAIL` — *(optional)* where "new enrollment submitted" alerts go; defaults to the
  address inside `RESEND_FROM`.
- `APP_URL` — *(optional)* absolute origin (e.g. `https://toolkits.alexsagun.com`) for the
  **"Review in Enrollments"** button in admin alerts; defaults to the request's own host.

The admin alert includes the student's name, email, phone, package, expected vs paid amounts,
payment reference, submitted date, a **Type: Renewal / New enrollment** row, and a direct link
to `/admin/enrollments`.

Emails are sent by [`api/notify-enrollment.js`](api/notify-enrollment.js) (same pattern as
`api/notify-access.js`): the student-triggered "submitted" alert verifies the caller **owns** the
request (via their own JWT + RLS) and builds the email from the database row; decision emails
require an admin caller. Until the vars are set, the panel shows "email not configured"
(harmless). **Note:** `npm run dev` doesn't run serverless functions — email only works on a
Vercel deploy (health check: open `/api/notify-enrollment` in a browser).

---

## Turning the paywall OFF later

1. Set `VITE_REQUIRE_ENROLLMENT=false` in your env (Vercel + `.env`) and **rebuild** — unpaid
   users stop seeing the paywall (the legacy admin-approval gate, if still on, applies again).
2. *(Optional, reopen content reads)* re-run the four `*_read` policies from
   `db/2026-06-29-user-approval.sql` section 5 to drop the `is_enrolled()` requirement:

   ```sql
   drop policy if exists courses_read on public.courses;
   create policy courses_read on public.courses for select to authenticated
     using (public.is_admin() or (published = true and public.is_approved()));

   drop policy if exists modules_read on public.course_modules;
   create policy modules_read on public.course_modules for select to authenticated
     using (public.is_admin() or (public.is_approved() and exists (
       select 1 from public.courses c where c.id = course_id and c.published = true)));

   drop policy if exists lessons_read on public.course_lessons;
   create policy lessons_read on public.course_lessons for select to authenticated
     using (public.is_admin() or (public.is_approved() and exists (
       select 1 from public.courses c where c.id = course_id and c.published = true)));

   drop policy if exists feature_guides_read on public.feature_guides;
   create policy feature_guides_read on public.feature_guides for select to authenticated
     using (public.is_approved());
   ```

   The enrollment tables/bucket can stay (harmless) or be dropped.

## Troubleshooting

- **The Enrollments tab shows "Finish backend setup"** — the migration hasn't run on this
  project. Run Step 1. (Until then the app **fails open**: unpaid users see the old
  pending-approval behavior, nobody is locked out.)
- **Approve fails with "No request row was updated"** — your admin RLS isn't applied or you
  aren't `is_admin` for this session. Re-run Step 1, confirm
  `update public.profiles set is_admin = true where email = 'you@…';`, sign out/in.
- **Approve said the request was approved but the student is still locked out** — the profile
  update step failed (the row shows a red **"grant incomplete — Approve again"** chip). Click
  **Approve** again — the handler is idempotent. If it persists, re-run
  `db/2026-06-29-user-approval.sql` (it creates the `profiles_admin_update` policy).
- **A student reports "You already have a submission under review"** — they double-submitted
  (e.g. two tabs). The first submission is the live one; review it in the panel. This is the
  one-pending-per-user unique index doing its job.
- **Receipt preview fails** — check Step 2 (bucket exists, is private, policies from the
  migration applied). A signed-URL error usually means the storage policies weren't created.
- **"email not configured / not sent" in a notice** — the review action still succeeded; email
  is best-effort (Step 4; remember `npm run dev` never sends email).
- **A grandfathered user got locked out** — they weren't `approved` when Step 1 first ran. Fix:
  `update public.profiles set is_paid = true, plan = 'core_self_paced' where email = '…';`
  (or just approve their next in-app submission).
- **A member reports being expired too early / too late** — check their latest `subscriptions`
  row: `select plan_key, status, started_at, ends_at, grace_ends_at from public.subscriptions
  where user_id = '…' order by created_at desc limit 1;`. The `ends_at` date is the authority.
  Hand-extend with `update public.subscriptions set ends_at = ends_at + interval '7 days' where
  id = '…';` — the change is live immediately (RLS + panel both read the date).
- **Approve notice says "subscription record failed"** — the profile grant still succeeded
  (access is open); click **Approve again** to retry the term. If it persists, confirm Step 1b
  ran (the `approve_subscription` function must exist).
- **Panel/admin dates look right but content is still blocked** — `is_enrolled()` may be the
  old boolean version. Re-run Step 1b (it re-creates the date-aware function).
