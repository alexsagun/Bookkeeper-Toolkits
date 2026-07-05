# Admin approval gate (temporary) — setup

> **Fresh Supabase project?** Run **[`db/000_full_database_bootstrap.sql`](db/000_full_database_bootstrap.sql)**
> once — the approval-gate schema is already included — then see **[`db/README.md`](db/README.md)**. On an
> **existing** install, run the dated migrations referenced below in the order documented in
> [`db/README.md`](db/README.md).

While the app is invite-only (pre public launch), **new signups can't reach the dashboard until an
admin approves them**. Anyone can still sign up (email or Google); they just land on an **"Access
Pending Approval"** screen until you approve (or reject) them from the in-app **Access Requests**
panel. This is a **temporary** feature, designed to switch off cleanly later.

Builds on [AUTH_SETUP.md](AUTH_SETUP.md) (the `profiles` table + signup trigger) and the
`public.is_admin()` helper from [COURSE_SETUP.md](COURSE_SETUP.md). Do those first.

---

## How it works

- `profiles` gains an `approval_status` (`pending` | `approved` | `rejected`) plus audit columns.
- The signup trigger (`handle_new_user`) already creates the `profiles` row; the column **default
  `'pending'`** flows to every new email/Google signup automatically — **no trigger change**.
- The client gate (in [src/BookkeeperPro.jsx](src/BookkeeperPro.jsx)) holds pending users on the
  Pending screen and rejected users on the Rejected screen. **Admins always pass.**
- **Backend (RLS) enforces it too** (not just the UI): non-approved users can't read course /
  lesson / feature-guide rows, and **no one can change their own `approval_status`** (only admins
  can update profiles). Most tools store data in the browser, so the client gate already covers them.

---

## Step 1 — Run the migration (required)

Supabase Dashboard → **SQL Editor → New query** → paste **all** of
[`db/2026-06-29-user-approval.sql`](db/2026-06-29-user-approval.sql) → **Run**. It is idempotent.

It safely **back-fills every existing account to `approved`** and force-approves admins, so
**running it never locks out you or your current users** — only signups *after* it run as `pending`.

> Make sure the project you run this in is the same one your app's `VITE_SUPABASE_URL` points at.

> ⚠️ **Migration order matters.** This migration **tightens** the `feature_guides` read policy to require
> `public.is_approved()`. If you use the Mock Interview guide feature, run
> [`db/2026-06-22-feature-guides.sql`](db/2026-06-22-feature-guides.sql) **before** this one. Running
> feature-guides *after* user-approval reverts `feature_guides_read` back to permissive (`using (true)`),
> which would let pending/rejected users read guides. Re-run this approval migration if you ever apply
> feature-guides later. (For a fresh setup, the documented order — feature-guides, then user-approval — is
> already correct.)

## Step 1b — (Recommended) Enable instant auto-approve

So a waiting user is signed straight into the dashboard **the moment you click Approve** (instead of
within a few seconds), also run [`db/2026-06-29-profiles-realtime.sql`](db/2026-06-29-profiles-realtime.sql)
in the SQL Editor. It adds the `profiles` table to Supabase **Realtime** so the user's Pending screen
reacts live. It's idempotent and RLS-safe (a user only ever receives changes to their **own** row).

Skipping this is fine — without it the Pending screen still advances automatically within ~30 seconds
(or instantly when its browser window/tab regains focus), and the **Check approval status** button
always works on demand.

## Step 1c — (Optional) Add the approval-status index

Once you have more than a handful of users, run
[`db/2026-06-29-approval-status-index.sql`](db/2026-06-29-approval-status-index.sql) in the SQL Editor.
It adds an index behind the sidebar pending-count badge and the Access Requests list. It's idempotent and
no-ops on a project that hasn't run Step 1 yet.

## Step 2 — Make sure you have an admin

Admins are auto-approved and manage requests. If you aren't one yet (see COURSE_SETUP.md Step 4):

```sql
update public.profiles set is_admin = true where email = 'you@example.com';
```

Then **sign out and back in**. You'll see an **"Access Requests"** button in the sidebar.

## Step 3 — Approve / reject

Sidebar → **Access Requests** → filter **Pending** → **Approve** or **Reject** (reject lets you add
an optional reason shown to the user). A pending user is let into the app automatically — instantly
if you ran Step 1b (Realtime), otherwise within ~30s / on window focus (or via the **Check status**
button on their screen).

## Step 4 — (Optional) Email notifications

Approve/reject works **without** email. To also email users on a decision, set two server-side env
vars in **Vercel → Settings → Environment Variables** (Production + Preview), then redeploy:

- `RESEND_API_KEY` — your Resend key (`re_…`; you can reuse the one from the Supabase SMTP setup in
  AUTH_SETUP.md §4c)
- `RESEND_FROM` — a verified sender, e.g. `Toolkits by Alex <noreply@yourdomain.com>`

The email is sent by the serverless function [`api/notify-access.js`](api/notify-access.js); the key
never reaches the browser. The function refuses non-admin callers. Until both vars are set, the admin
panel shows "email not configured" (harmless). **Note:** `npm run dev` doesn't run serverless
functions — email only works on a Vercel deploy.

---

## Turning the feature OFF later (public launch)

1. Set `VITE_REQUIRE_ADMIN_APPROVAL=false` in your env (Vercel + `.env`) and **rebuild** — the gate
   stops blocking; new users go straight in.
2. *(Optional, fully open the data)* re-run the original course/feature **read** policies from
   COURSE_SETUP.md (the four `*_read` policies) to drop the `is_approved()` requirement, and
   `drop function if exists public.is_approved();`. The `approval_status` columns can stay
   (harmless) or be dropped.

## Troubleshooting

- **You approved a user but they're still stuck on "Access Pending Approval" (even after a refresh),
  while the panel shows them "Approved."** A full browser refresh re-reads the row from Supabase, so
  if they still see Pending, the row *they* read is not the row you approved. Run this one query
  (SQL Editor) to see exactly what's going on — replace the email:

  ```sql
  -- Shows the user's EXACT auth id, their approval_status, and whether more than one
  -- auth user exists for this email (the duplicate-identity case).
  select u.id as auth_user_id, u.email, u.created_at as signed_up,
         p.approval_status, p.is_admin,
         count(*) over (partition by lower(u.email)) as rows_with_this_email
  from auth.users u
  left join public.profiles p on p.id = u.id
  where lower(u.email) = lower('THE_TEST_USER_EMAIL')
  order by u.created_at;
  ```

  - **`rows_with_this_email` > 1** → the same person has **two auth accounts** (e.g. they signed up
    once with email/password and once with **Continue with Google** — Supabase makes those separate
    users with different ids). You approved one; they're logging into the other. Fix: delete the
    stale duplicate in **Authentication → Users** (or approve the id they actually use), and going
    forward sign in with **one** method per email.
  - **one row, `approval_status = 'pending'`** → your approval didn't persist. Make sure Step 1 ran
    fully (the `profiles_admin_update` policy exists) and that you're truly `is_admin` (Step 2, then
    re-sign-in). The app now surfaces this as a clear error instead of a false "Approved." You can also
    force it: `update public.profiles set approval_status='approved' where id = '<auth_user_id>';`.
  - **one row, `approval_status = 'approved'`** → the database is correct; just have them fully reload
    the page (the gate reads the row on load). With Realtime enabled (Step 1b) it advances on its own.
- **Access Requests shows "Finish backend setup"** — the migration hasn't run on this project. Run
  Step 1.
- **An existing user is stuck on "pending"** — they were created *after* the migration, or the
  backfill didn't run. Approve them in the panel, or
  `update public.profiles set approval_status='approved' where email='…';`.
- **Approve/reject fails with a permissions error (42501)** — you're not flagged `is_admin` for this
  session. Re-check Step 2 and re-sign-in.
- **The panel says "Approved … · email not sent" (or "email not configured").** Approval still
  succeeded — email is best-effort. `email not sent` means the `/api/notify-access` function wasn't
  reachable (you're on `npm run dev`, which doesn't run serverless functions — email only works on a
  Vercel deploy). `email not configured` means it ran on Vercel but `RESEND_API_KEY` / `RESEND_FROM`
  aren't set (Step 4). Neither blocks access.
