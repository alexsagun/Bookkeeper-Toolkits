# Enrollment & manual-payment gate — setup

> **Fresh Supabase project?** Run **[`db/000_full_database_bootstrap.sql`](db/000_full_database_bootstrap.sql)**
> once — the enrollment + subscription-lifecycle schema is already included — then see
> **[`db/README.md`](db/README.md)**. On an **existing** install, run the dated migrations referenced below
> in order (`db/2026-07-04-enrollment.sql` → `db/2026-07-04-subscription-lifecycle.sql` →
> `db/2026-07-09-plan-course-access.sql` → `db/2026-07-10-subscription-grace.sql` →
> `db/2026-07-11-sampler-essentials-access.sql`).

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
button, warnings at 5 / 3 days + a **3-day grace period**), and when the term (plus grace)
ends they're locked on a **Membership Expired** screen until an admin approves their
**renewal** — same pricing + receipt-upload + review flow. See "Membership lifecycle &
renewal" below.

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

## Step 1c — Run the plan-course-access migration (required for per-plan scope)

Same SQL Editor → paste **all** of
[`db/2026-07-09-plan-course-access.sql`](db/2026-07-09-plan-course-access.sql) → **Run**. Idempotent;
safe to re-run. **Order:** run it **after** enrollment + subscription-lifecycle **and** the private
`course-videos` bucket ([`db/2026-07-08-course-videos-private.sql`](db/2026-07-08-course-videos-private.sql)).
It **requires the `subscriptions.ends_at` column** from the subscription-lifecycle migration (#13) — if
#13 hasn't run it stops with a clear exception naming that file (rather than a raw `column does not exist`).

It adds the `current_plan_key()` / `plan_is_qbo_only()` / `course_object_allowed()` helpers and
re-applies `courses_read` / `modules_read` / `lessons_read` + the private `course_videos_read` policy
with a plan predicate — so a `core_self_paced` member reads only `qbo-*` courses. For performance the
no-arg helpers are wrapped in `(select …)` so each is evaluated **once per query** (an InitPlan), and
the plan check short-circuits so full-access members do zero per-row plan work. It only **adds** a
conjunct; it never loosens the existing `is_approved()` / `is_enrolled()` / `published` checks, so
full-access members, admins, grandfathered users, and expired members are unaffected. See
"Plan access scope (per-plan entitlements)" below.

> **Deploy order doesn't matter** here either: the client's plan gating is independent of the SQL, and
> the migration only tightens reads for `core_self_paced` members. Verify as a core member that a direct
> `select` on a `resume-%` course (and a `course-videos` signed URL) is denied, while `qbo-%` still reads.

## Step 1d — Run the grace-period migration (turns the 3-day grace ON)

Same SQL Editor → paste **all** of
[`db/2026-07-10-subscription-grace.sql`](db/2026-07-10-subscription-grace.sql) → **Run**. Idempotent;
safe to re-run. **Order:** run it **after** subscription-lifecycle (#13) — it stops with a clear
exception if `subscriptions.grace_ends_at` is missing. It flips `approve_subscription()`'s grace knob
`v_grace_days` to **3** (new/renewed terms stamp `grace_ends_at = ends_at + 3 days`) and backfills the
`grace_ends_at` of currently-running dated terms, so existing members get the grace window too. Nothing
else changes — `is_enrolled()` / `current_plan_key()` / `expire_overdue_subscriptions()` and the client
already honor `grace_ends_at`. See "Membership lifecycle & renewal" → "Grace period" below.

## Step 1e — Run the Sampler course-scope migration (Essentials vs Mastery)

Same SQL Editor → paste **all** of
[`db/2026-07-11-sampler-essentials-access.sql`](db/2026-07-11-sampler-essentials-access.sql) → **Run**.
Idempotent; safe to re-run. **Order:** run it **after** plan-course-access (#17) — it stops with a clear
exception if `public.current_plan_key()` is missing. It adds the `courses.access_tier` column
(`'standard'`/`'essentials'`) + the `plan_is_sampler()` helper, rewrites `course_object_allowed()`, and
re-applies `courses_read`/`modules_read`/`lessons_read` + `course_videos_read` so a **`sampler`** member
reads only `qbo-*` courses tagged `access_tier='essentials'` (QuickBooks **Essentials**, not Mastery).
Every other plan/admin is unaffected. **Then set up the Essentials course in-app:** as an admin, open
**QuickBooks US Bookkeeping Program → New course** ("QuickBooks Online Essentials"), add its 2–4
modules, open the card **⋮ menu → "Sampler tier (Essentials)"**, and **Publish**. Until an Essentials
course is marked + published, a Sampler member sees an empty QuickBooks catalog (fails **closed**). See
"Plan access scope (per-plan entitlements)" below.

## Step 1f — Run the account-membership-requests migration (Extend Access + Upgrade Plan)

Same SQL Editor → paste **all** of
[`db/2026-07-11-account-membership-requests.sql`](db/2026-07-11-account-membership-requests.sql) → **Run**.
Idempotent; safe to re-run. **Order:** run it **after** subscription-lifecycle (#13) and grace (#18) — it
stops with a clear exception if `enrollment_requests` / `subscriptions` / `approve_subscription` are
missing. It adds `enrollment_requests.request_kind` (`new`/`renewal`/`upgrade`/`extension`) +
`extension_days`, and the `approve_extension(user, request_id, days)` RPC. This powers the sidebar **⋮
account menu** (Profile & Settings · Membership Plan · Upgrade Plan · Extend Access · Log out) and the
self-serve **Extend Access** / **Upgrade Plan** flows. Until it's run the client degrades gracefully —
new/renewal enrollment still works, and an extension submitted meanwhile is approved as a normal plan
grant. See "Extend access & upgrade" below.

## Step 1g — Run the hardening migration (extension-length cap)

Same SQL Editor → paste **all** of [`db/2026-07-11-hardening.sql`](db/2026-07-11-hardening.sql) →
**Run**. Idempotent; safe to re-run. **Order:** after account-membership-requests (#20) — it stops with
a clear exception if `approve_extension` is missing. It replaces `approve_extension()` with a strict
superset that rejects any extension outside **60–365 days** (the request's `extension_days` is
student-declared — #20 only enforced the minimum) and adds a matching range CHECK constraint on
`enrollment_requests.extension_days`. The client already offers only 2–12 months, so legitimate
requests are unaffected.

## Membership lifecycle & renewal

- **Durations:** approval stamps `ends_at = start + access_days` (Core/Sampler/Silver **60
  days**, Gold/VIP **180 days**; Sampler also records `support_days = 30`, shown to the student
  but not RLS-enforced). A plan with `access_days = NULL` never expires. Edit durations in the
  `enrollment_plans` table (no redeploy needed).
- **Plan access scope:** a term's plan also decides *which* tools it unlocks (client
  `PLAN_ENTITLEMENTS` + `db/2026-07-09-plan-course-access.sql` + `db/2026-07-11-sampler-essentials-access.sql`):
  **`core_self_paced`** (QBO Mastery Only) unlocks Home + Training & Skills (both `qbo-*` courses);
  **`sampler`** (Sampler Session) unlocks Home + the QuickBooks catalog's **Essentials** course only +
  both 1-on-1 booking pages (₱1,499 buys coaching, not more courses — *more* restricted than core);
  **`silver_self_paced`** (QBO + Resume Combo) and every other plan grant **full non-admin toolkit
  access**. Silver is premium/full — not to be confused with the limited QBO-only plan.
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
- **Warnings:** the Dashboard membership panel is **calm above 5 days** (shows the expiry date +
  days remaining, no banner), turns to an **amber warning at ≤ 5 days** ("Your membership expires
  soon. Renew or upgrade now to keep access."), a **red urgent warning at ≤ 3 days**, and a **red
  grace-period warning** once the term has ended but access continues ("Grace period: renew now to
  avoid losing access." + the exact grace-end date). The Renew button is promoted at ≤ 5 days and
  during grace.
- **Grace period (ON — 3 days):** since [`db/2026-07-10-subscription-grace.sql`](db/2026-07-10-subscription-grace.sql)
  (#18) `approve_subscription()` uses `v_grace_days = 3`, so every granted/renewed term stamps
  `grace_ends_at = ends_at + 3 days` and existing still-running terms were backfilled. During grace
  the member keeps full access (with the urgent warning above); after grace they're locked on the
  Membership Expired screen. `is_enrolled()` / `current_plan_key()` / `expire_overdue_subscriptions()`
  and the client `subAccess()` already honor `grace_ends_at`, so no other change was needed. Change
  the window by editing `v_grace_days` and re-running #18; hand-set `grace_ends_at` on a single row
  for a one-off extension.
- **Grandfathering:** rows created before the lifecycle migration keep `ends_at = NULL` = **no
  expiry** (nobody is locked out by running it); paid profiles with no subscription rows at all
  also stay enrolled. Their **next renewal** converts them to a dated term. To put legacy
  members on the clock instead, use the commented backfill in section 7 of the migration.
- **Legacy no-expiry member renews:** their new term is dated (starts at approval) — renewing
  converts unlimited → dated by design.

### Extend access & upgrade (self-serve, from the account menu)

Members manage their own membership from the **⋮ account menu** on the sidebar (Profile & Settings ·
Membership Plan · Upgrade Plan · Extend Access · Log out). Both billing actions require payment proof +
admin approval, exactly like a renewal — they're just tagged `request_kind` on the `enrollment_requests`
row so they show up in the **Enrollments** tab with **Upgrade** / **Extension** badges (and their own
filter chips).

- **Extend Access** — buy more time on the **same** plan without changing it. Minimum **2 months (60
  days)**, maximum **12 months (365 days — enforced by `approve_extension()` after Step 1g; for longer
  access, renew or upgrade instead)**; options 2 / 3 / 6 months + a custom stepper (clamped 2–12). Price is pro-rated from the plan's
  own `price_php` / `access_days` (`dailyRate × months×30`), so a 60-day plan's 2-month top-up equals its
  full price (₱999 / ₱1,499 / ₱1,999). On **Approve**, `approve_extension()` adds `extension_days` **from
  the current expiry** while the term is still running, or **from the approval date** if it had already
  expired (a 3-day grace follows). The member keeps full access while an extension is pending. An
  **expired** member (no sidebar) can still extend via **"Extend the same plan"** on the Membership
  Expired screen.
- **Upgrade Plan** — move to a higher/different plan. Opens the same pricing cards (current plan marked)
  in **upgrade mode**; on **Approve** it reuses `approve_subscription()` with the new `plan_key` → the new
  plan's **full term**, stacked from the current expiry (early upgrades never lose remaining days), and
  the toolkit widens instantly via Realtime.

The **one-pending-per-user** rule still applies across all kinds, so a member can't stack duplicate
requests — the Extend/Upgrade modals show a "request under review" notice instead of the form when one is
already pending.

## Plan access scope (per-plan entitlements)

Membership is **not all-or-nothing**. Each plan unlocks a scope of the app:

- **`core_self_paced` (QBO Mastery Only, ₱999 / 60 days)** → **Home + Training & Skills only**
  (Accounting 101, QuickBooks Online Mastery, Industry Accounting, US Tax 101, ProAdvisor Chat,
  Niche Selector Quiz) — and reads **both** `qbo-*` courses (Essentials + Mastery). Job Application and
  Client Management & Delivery tools are **not** accessible.
- **`sampler` (Sampler Session, ₱1,499 / 60 days)** → **Home + the QuickBooks catalog (Essentials
  course only) + both 1-on-1 booking pages** (Book 1-on-1 with Alex, Personalized Coaching With Alex).
  Inside the QuickBooks catalog the Sampler sees **only** the **QuickBooks Online Essentials** course
  (`access_tier='essentials'`) — the premium **Mastery** course is hidden. ⚠️ The ₱1,499 buys the
  coaching session, **not** more course content, so Sampler is *more* restricted than the ₱999 core
  plan — don't assume higher price ⇒ wider scope.
- **All other plans** (`silver_self_paced`, `gold_live`, `vip`), unknown/legacy plans, and **admins**
  → the **full toolkit** (no restrictions — we don't gate plans Alex hasn't defined finer entitlements
  for yet).

How it's enforced (two halves that must stay in sync):

- **Client (UI + deep links):** `PLAN_ENTITLEMENTS` in `src/BookkeeperPro.jsx` lists the tabs each
  scoped plan may open (and, via `courseTier`, which course tier inside a catalog). The sidebar and
  Dashboard tiles are filtered to that scope, and the render chokepoint shows a polished **"This tool
  isn't part of your plan"** screen (with an Upgrade → Dashboard CTA) for any restricted tab reached by
  deep-link, back/forward, or a stale last-tab — so a core member can't reach `/proposal-generator`,
  `/invoice-creator`, `/budgeting`, `/courses/resume-winning-strategy`, etc. The **CourseCatalog** hides
  course cards the plan can't open, and **CourseProgram** shows an upgrade panel on a restricted
  deep-link. The student sees their **access scope** on the Dashboard membership panel and in the
  sidebar ("Access until {date}"); admins see it on each Enrollments card + the approve modal.
- **Server (RLS):** [`db/2026-07-09-plan-course-access.sql`](db/2026-07-09-plan-course-access.sql)
  scopes a `core_self_paced` member to **`qbo-*` courses**, and
  [`db/2026-07-11-sampler-essentials-access.sql`](db/2026-07-11-sampler-essentials-access.sql) adds
  `courses.access_tier` + `plan_is_sampler()` to scope a `sampler` member to **`qbo-*` courses that are
  `access_tier='essentials'`** (Essentials only). Both cover course/lesson reads + the private
  `course-videos` bucket, so the Mastery course, the Resume (`resume-*`)/Interview (`interview-*`)
  courses, and their private lesson videos are denied even via direct Supabase query.
- **Admin sets a course's tier in-app:** open the course card **⋮ menu → "Sampler tier (Essentials)"**.
  New courses default to `'standard'` (premium); mark the Essentials course `'essentials'` and publish.

**Changing entitlements:** edit both `PLAN_ENTITLEMENTS`/`courseTier` (client) *and* the
`plan_is_qbo_only()` / `plan_is_sampler()` / `course_object_allowed()` rules + the policy slug/tier
predicates in the migrations (server) together — they encode the same policy at two layers.

**Upgrading:** a member picks a higher plan from the same renewal paywall — via the Dashboard Renew
button **or the sidebar ⋮ account menu → Upgrade Plan** — uploads proof, and the admin approves it;
`approve_subscription()` switches their `plan_key`, and the new scope applies live (the gate refetches on
the subscription change / window focus). See "Extend access & upgrade" above.

**Not scoped (documented residuals):** the MockInterviewSimulator `feature_guides` explainer video and
the AI proxy stay `is_enrolled()`-gated (a core/sampler member could spend AI tokens via a hand-crafted
proxy call, but that reveals no stored higher-tier content). Tighten later if needed.

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

The in-app dashboard alert + sound already notify the admin of a new submission. **Email** is the
*outside-the-app* layer (so you're notified when the tab isn't open). Everything works **without**
it. To enable it, set these server-side env vars in **Vercel → Settings → Environment Variables**
(Production + Preview), then redeploy:

- `RESEND_API_KEY` — your Resend key (`re_…`) — **server-only; do NOT `VITE_`-prefix it.**
- `RESEND_FROM` — a verified sender, e.g. `Toolkits by Alex <noreply@yourdomain.com>`
- `NOTIFY_ADMIN_EMAIL` — *(optional)* where "new enrollment submitted" alerts go.
- `APP_URL` — *(optional)* absolute origin (e.g. `https://toolkits.alexsagun.com`) for the
  **"Review in Enrollments"** button in admin alerts; defaults to the request's own host.

> ⚠️ **Supabase Auth's email/SMTP/Resend settings do NOT power this.** Those only send Supabase
> *Auth* emails (signup confirmation, password reset). This custom admin alert is a separate Vercel
> serverless function with its **own** secrets — set the vars above in Vercel, not in Supabase.

> ⚠️ **Resend only delivers from an allowed sender** (this is the #1 reason "the key is set but no
> email arrives"). Either **verify a domain** in Resend and use an address on it in `RESEND_FROM`
> (e.g. `noreply@yourdomain.com`) — this reaches **admins *and* students** — **or** use Resend's test
> sender `Toolkits by Alex <onboarding@resend.dev>`, which delivers **only to your own Resend-account
> email** (fine to test the admin alert, but student decision-emails to other addresses will bounce
> until a domain is verified). The `RESEND_API_KEY` must belong to the **same** Resend account/team
> that owns the verified domain.

**Who gets the admin alert** — resolved at send time, first valid email wins:
1. `NOTIFY_ADMIN_EMAIL` env var, else
2. **`payment_settings.notify_email`** — the **"Proof / support email"** field in the *Payment
   details* editor (Enrollments tab). This is admin-editable in-app, so you can change the alert
   recipient **without a redeploy**, else
3. the address inside `RESEND_FROM`.

**Test it end-to-end:** on a Vercel deploy, open **Enrollments → "Test email"** (admin-only button
next to Refresh). It verifies your admin login server-side, sends a sample alert to the resolved
recipient, and reports **"Test email sent to …"**, **"not configured"**, or the exact provider
failure. **Health check:** open `/api/notify-enrollment` in a browser → `{ ok, hasKey, hasFrom,
adminRecipient }` (`adminRecipient` is env-only — `'none'` there can still resolve at send time via
`payment_settings.notify_email`, which the unauthenticated health check can't read). No secret
values are ever returned.

**Prove it works (≈2 minutes, after the vars are set + a redeploy):**
1. Open `https://<your-deploy>/api/notify-enrollment` in a browser → expect
   `{ ok:true, hasKey:true, hasFrom:true, adminRecipient:"env" }` (or `"from"`).
2. Sign in as an **admin** → **Enrollments** tab → click **Test email** (next to Refresh) → expect
   **"Test email sent to …"**; confirm it lands in that inbox.
3. Open the **Resend dashboard → Emails/Logs** and confirm the event shows **Delivered**.
4. *(Full end-to-end)* submit a test enrollment as a student → the admin gets a **"New enrollment
   submitted"** email and the in-app sound/dashboard alert still fires.

If step 2 says *"not configured"* → a var is missing/misnamed in Vercel (or you didn't redeploy). If
Resend shows the send but it's not **Delivered** → the sender isn't verified (see the Resend-sender
callout above) or the recipient's mail provider filtered it.

The admin alert includes the student's name, email, phone, location, package, expected vs paid
amounts, payment reference, submitted date/time, a **Type: Renewal / New enrollment** row, and a
direct link to `/admin/enrollments`. Receipts are **never** attached (they're private financial
docs) — the email links the admin to the dashboard to review them.

Emails are sent by [`api/notify-enrollment.js`](api/notify-enrollment.js) (same pattern as
`api/notify-access.js`): the student-triggered `submitted` alert verifies the caller **owns** the
request (via their own JWT + RLS) and builds the email from the database row; `decision` and `test`
require an admin caller. Enrollment submission is never blocked by email — the client fires it
best-effort and logs any skip/error to the browser console (`[enroll] admin email: …`). Until the
vars are set, the panel shows "email not configured" (harmless). **Note:** `npm run dev` doesn't
run serverless functions — email only works on a Vercel deploy.

**Audit trail (visible in the Enrollments tab).** The `submitted` handler stamps the send outcome
onto the request row via the `record_enrollment_notification()` RPC (added by
[`db/2026-07-08-enrollment-notify-status.sql`](db/2026-07-08-enrollment-notify-status.sql) — run it
on existing installs; the fresh-install bootstrap already includes it). Each request card then shows
a small badge: a green **"Admin emailed"** when the alert sent, or an amber/red **"Email not
sent — …"** (no key / no sender / no recipient / provider error) when it didn't — so a
silently-misconfigured admin email is no longer invisible (it doesn't rely on the student's browser
console). The badge only appears once an alert has been attempted; older rows and installs without
the migration simply show no badge (the RPC call is best-effort and never blocks the email).

The `sent` stamp doubles as a **replay guard**: once a request row is marked `notify_status='sent'`,
re-POSTing `action:'submitted'` for the same `requestId` returns `{ ok:false, skipped:
'already_notified' }` instead of sending again — so the alert can't be replayed into the admin inbox
or burn Resend quota. Failure states (`provider_error`, `email_not_configured`, `admin_email_invalid`)
stay retryable, and every **new** row (resubmit / renewal / upgrade / extension) starts with a null
`notify_status`, so legitimate flows always alert.

**Not on Vercel?** Reimplement the same `submitted` / `decision` / `test` workflow as a **Supabase
Edge Function** and store `RESEND_API_KEY` / `RESEND_FROM` / `NOTIFY_ADMIN_EMAIL` / `APP_URL` as
**Supabase function secrets** (`supabase secrets set …`). The auth checks and recipient resolution
already use the Supabase REST API, so they port directly.

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
- **Approve showed an error partway through** — the grant runs subscription → profile →
  request in that order, and any step failing stops the rest, so the request stays
  **pending** with the **Approve** button still shown. Just click **Approve again** (it is
  retry-safe: `approve_subscription()` is idempotent per request, so a re-approve of the same
  request never double-extends). If it persists, confirm Step 1b ran (the `approve_subscription`
  function must exist) and that you're flagged `is_admin`.
- **An approved member shows "grant incomplete — Approve again"** — their approved request
  didn't leave them with a valid active term (e.g. a renewal whose subscription grant failed).
  Click **Approve** on that row to re-run the grant. (A membership that simply expired over
  time is **not** flagged — that needs a fresh renewal request from the student, not a
  re-approve.)
- **Panel/admin dates look right but content is still blocked** — `is_enrolled()` may be the
  old boolean version. Re-run Step 1b (it re-creates the date-aware function).
- **An expired member briefly saw the dashboard shell** — the client gate fails **open** if the
  subscription lookup errors or times out (so a network blip never traps a paying member on a
  spinner). Course/feature content stays blocked server-side by RLS regardless, and the shell
  corrects itself on the next load. No action needed.
- **The admin sound alert didn't chime on a new submission** — browsers block audio until you
  interact with the page. Click anywhere in the tab once (or press the **Test** button beside
  the Sound toggle) to unlock it for the session; the pref itself persists across sessions.
