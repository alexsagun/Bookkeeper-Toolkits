# Authentication setup (Supabase)

> **Fresh Supabase project?** Run **[`db/000_full_database_bootstrap.sql`](db/000_full_database_bootstrap.sql)**
> once to stand up the whole schema in a single step, then follow the Dashboard steps below (env vars,
> email confirmation, redirect URLs, Google). Run order + per-file index: **[`db/README.md`](db/README.md)**.
> The `profiles` + signup-trigger SQL in §3 below now also lives as the dated migration
> **[`db/2026-06-15-auth-profiles-base.sql`](db/2026-06-15-auth-profiles-base.sql)** for existing installs.

The toolkit is gated behind Supabase auth — email/password **and** Google one-click sign-in. Until
you create a Supabase project and add the two env vars, the app loads but the login screen shows a
"not configured" notice. Follow these one-time steps.

## 1. Create a Supabase project

1. Go to https://supabase.com/ → **New project** (the free tier is fine).
2. After it provisions, open **Project Settings → API** and copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **anon public** key → `VITE_SUPABASE_ANON_KEY`

## 2. Add the env vars

**Local dev** — in `.env` (already gitignored; the keys were appended empty for you):

```
VITE_SUPABASE_URL=https://YOUR-REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
```

**Production (Vercel)** — Project → **Settings → Environment Variables** → add both for
**Production + Preview**. Vite inlines `VITE_*` vars at **build** time, so they must exist before the
build runs. Redeploy after adding them.

> The anon key is **public by design** — it is safe in the browser bundle. Real security is enforced
> by the Row Level Security policies below, not by hiding the key.

## 3. Create the `profiles` table + RLS + signup trigger

In Supabase → **SQL Editor**, run:

This block is **safe to re-run** (idempotent) — it uses `if not exists` / `drop … if exists`, so
you can paste it again on a partially-configured project. It also stores `avatar_url` and accepts
Google's `name`/`full_name` metadata.

```sql
-- Profile row per user. is_paid / plan are reserved for the Phase-2 paid gate.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  is_paid boolean not null default false,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists avatar_url text;

alter table public.profiles enable row level security;

-- A user can read only their own profile.
drop policy if exists "own_profile_select" on public.profiles;
create policy "own_profile_select" on public.profiles
  for select using (auth.uid() = id);

-- Phase 1 keeps profiles read-only from the client. Do NOT add a client UPDATE policy
-- that lets a user change is_paid — in Phase 2 that flag is flipped server-side by the
-- payment webhook using the service-role key.

-- Auto-create a profile row whenever a new auth user signs up (email OR Google).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

## 4. Email confirmation + redirect URLs

In Supabase → **Authentication**:

- **Providers → Email → "Confirm email"** — this app ships configured for **ON (confirmed signups)**:
  after signup the user must click an emailed link before first sign-in. The app makes this seamless —
  it shows a **"Check your email"** screen with a **Resend** button, the confirmation link returns
  straight back to the app and signs the user in, and an unconfirmed sign-in attempt is routed to the
  same resend screen (no dead-end error). To switch to instant access instead, just toggle this **OFF**
  — no code change needed.
- **URL Configuration → Site URL + Redirect URLs**: set **Site URL** to your production URL, and add
  to **Redirect URLs** both `http://localhost:5173` (dev) and your production URL. These are required
  so the **confirmation link**, the **password-reset link**, and the **Google OAuth** return trip all
  land back on the app.

## 4b. Enable Google one-click sign-in (detailed)

The login screen has a **"Continue with Google"** button. It errors until both halves below are done.
Note: the Google Client ID/Secret are **not** env vars — they live in the Supabase dashboard.

**In Google Cloud Console (https://console.cloud.google.com):**

1. Top bar → project dropdown → **New Project** (e.g. "Bookkeeper Toolkits") → **Create** → select it.
2. Left menu → **APIs & Services → OAuth consent screen**:
   - User type **External** → **Create**.
   - App name **Get Hired With Alex**; user support email = your email; developer contact = your email
     → **Save and continue**.
   - Scopes: leave defaults (email, profile, openid) → **Save and continue**.
   - Test users → **Add** your own Gmail (so you can test before publishing) → **Save**.
   - (Until you click **Publish app**, only listed test users can sign in. A "Google hasn't verified
     this app" warning is normal for test users — publish/verify when ready for public signups.)
3. Left menu → **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - Application type **Web application**; name "Bookkeeper Web".
   - **Authorized JavaScript origins**: add `http://localhost:5173` and your production URL
     (e.g. `https://yourapp.vercel.app`).
   - **Authorized redirect URIs**: add `https://YOUR-REF.supabase.co/auth/v1/callback`
     (copy the exact value shown in Supabase → Authentication → Providers → Google).
   - **Create** → copy the **Client ID** and **Client Secret**.

**In Supabase:**

4. **Authentication → Providers → Google** → toggle **Enabled** → paste **Client ID** + **Client
   Secret** → **Save**.

New Google users get a `profiles` row automatically (the trigger reads Google's `name` / `avatar_url`
metadata).

## 4c. Brand the auth emails — custom SMTP (Resend)

By default emails come from **"Supabase Auth"** and the built-in mailer is rate-limited (not for
production). Connect your own SMTP so emails come from **your brand** and send reliably. (Requires a
domain you control DNS for — a `*.vercel.app` subdomain will **not** work.)

1. Create a free account at **https://resend.com**.
2. **Domains → Add Domain** → enter `yourdomain.com`. Resend shows DNS records (SPF `TXT`, DKIM, and a
   return-path). Add each at your **domain registrar / DNS host**, then click **Verify** (propagation
   can take minutes–hours).
3. **API Keys → Create API Key** → copy it (starts `re_…`).
4. In **Supabase → Project Settings → Authentication → SMTP Settings** → enable **Custom SMTP**:
   - **Host** `smtp.resend.com` · **Port** `465` · **Username** `resend` · **Password** = the `re_…` key
   - **Sender email** `noreply@yourdomain.com` (warmer alternative: `alex@yourdomain.com` or
     `hello@yourdomain.com` — pairs well with the "from Alex" sender name)
   - **Sender name** `Sign in to toolkits from Alex`
   - **Save.** This also lifts the built-in rate limit.

## 4d. Brand the email templates

In **Supabase → Authentication → Email Templates**, edit **Confirm signup** and **Reset password**.
Keep the `{{ .ConfirmationURL }}` variable. Suggested subject: *"Confirm your email — Get Hired With
Alex"*. Paste this body (swap the heading/copy for the reset template — "Reset your password" /
"Click below to choose a new password"):

```html
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f7fb;padding:32px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6ebf2;">
    <div style="background:linear-gradient(180deg,#3aa0ff,#0A84FF);padding:26px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">Get Hired With Alex</h1>
    </div>
    <div style="padding:28px;color:#1c2430;">
      <h2 style="font-size:18px;margin:0 0 8px;">Confirm your email</h2>
      <p style="font-size:14px;line-height:1.6;color:#48505e;margin:0 0 22px;">
        Welcome aboard! Click below to confirm your email and unlock your remote bookkeeping toolkit.
      </p>
      <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#0A84FF;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px;">Confirm my email</a>
      <p style="font-size:12px;color:#8a93a3;margin:24px 0 0;">If you didn't create this account, you can safely ignore this email.</p>
    </div>
  </div>
</div>
```

## 5. Run it

```powershell
npm install
npm run dev
```

You should see the login screen. Create an account → the **"Check your email"** screen appears →
the branded confirmation email arrives **from your brand** → click the link → you land back in the
app, signed in, and a first-login welcome overlay shows once. **Continue with Google** signs in in one
click. A row appears in **Table Editor → profiles** with `is_paid = false`.

## What's wired in the code

| Piece | Location |
|---|---|
| Supabase client | `src/lib/supabase.js` |
| Auth context + `useAuth()` (incl. `signInWithGoogle`, `resendConfirmation`, `updatePassword`, `recovery`; server-validates the session on load + tab focus so deleted/disabled accounts are signed out) | `src/auth/AuthProvider.jsx` |
| Provider mount + per-user `window.storage` namespacing | `src/main.jsx` |
| Auth gate + `AuthScreen` (login/signup/reset + Google + "check your email" resend screen) | `src/BookkeeperPro.jsx` (just above the root return) |
| `UpdatePasswordScreen` (completes the reset-link flow) | `src/BookkeeperPro.jsx` (after `AuthScreen`) |
| `WelcomeOverlay` (first-login, once per user) | `src/BookkeeperPro.jsx` (before the root component) |
| Sidebar identity + sign-out | `src/BookkeeperPro.jsx` (sidebar header) |

Each signed-in user's saved data (trackers, invoices, budgets, sidebar layout) is automatically
isolated under `u:<uid>:*` localStorage keys. On the very first sign-in, any pre-auth data is migrated
into that account once.

## Next (Phase 2 — not built yet)

Restrict the toolkit to **paid students**: a `FREE_TABS` allowlist + a paywall overlay at the render
switch (`// Phase 2 paywall hooks here`), with `is_paid` flipped by a Stripe/Gumroad checkout webhook.
The `profiles.is_paid` / `plan` columns already exist for this.
