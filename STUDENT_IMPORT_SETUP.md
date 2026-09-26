# Student Imports — the legacy Thinkific migration (setup & runbook)

The Student Imports tab moves legacy paid Thinkific students into the Toolkit. It is **Super Admin
only** (`students.legacy_migrate`), and it works in two separate steps:

1. **Stage.** A roster becomes a durable job. Every row is marked *Ready to activate*, *Inactive* or
   *Blocked*. Staging creates **no** account, membership, approval or email.
2. **Activate.** A Super Admin selects ready rows, reads the confirmation counts, and types
   `ACTIVATE <n>`. Each row then gets a real account, a real membership and an invitation email.

Built by migration **#67** (`db/2026-09-25-legacy-student-migration.sql`), on the #26 tables.

---

## 1. What you need

| Setting | Where | Why |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Vercel (server only) | The endpoint creates Auth accounts |
| `RESEND_API_KEY` | Vercel (server only) | Every migration email |
| The sender, **support@alexsagun.com** | Resend → Domains: **alexsagun.com must be verified** | Every migration email comes from, and is answered at, this address. `MIGRATION_EMAIL_FROM` (optional) overrides it |
| `APP_URL` | Vercel (server only) | The activation link points here. **Required on every Vercel deployment.** |
| `NOTIFY_ADMIN_EMAIL` | Vercel (server only) | Where "Student Successfully Onboarded" goes (else Payment settings → "Proof / support email") |

Activation refuses to start until email, `APP_URL` and the sender are all configured. Staging
works without them. The tab shows all three as readiness chips.

**Before activating anyone, press Send test email.** It sends the activation email — sample details,
a link that does nothing — from support@alexsagun.com to your own inbox. If Resend refuses the
sender, the chip says so: verify alexsagun.com in Resend and send the test again. Check the test did
not land in spam.

Migration #67 must be applied (it follows #66). Run `npm run db:audit` afterwards; the `#67` block
checks the permission, the scheduled status, the cron job, the read-only tables and the audit guard.

---

## 2. The roster

One student per row, CSV or XLSX. The template (Download → Template) has these columns:

`thinkific_user_id, first_name, last_name, email, plan_key, membership_started_at,
membership_ends_at, payment_status, amount_paid, currency, legacy_enrollments, batch_code`

- **Dates:** you declare the format — `M/D/YYYY`, `D/M/YYYY` or `YYYY-MM-DD`. Nothing is guessed.
  Two-digit years and impossible dates (2/31/2026) block the row.
- **Plan:** each distinct label (for example `VIP`) is mapped to a plan explicitly. The screen
  suggests an exact match and you confirm it.
- **Batch:** each distinct label (for example `October 2026`) is mapped to a registry batch. The
  label must name the same month as the batch, and each start date must fall in or next to that
  month. Otherwise the row is blocked.
- **Payment:** only `Paid` is paid. The amount is kept as history only. It does not change today's
  price and nothing is posted to Financial Management.
- **Identity:** a real Thinkific id is used when present. Otherwise the normalized email is the
  identity. People are never matched by name.

**Never commit a real roster.** The two real CSVs are gitignored (`/CSV Per students*.csv`); keep
any future roster in `private-imports/`, which is also ignored. Tests use synthetic data only.

---

## 3. Staging

1. **Stage a roster** → choose the file.
2. Match the columns (required fields are marked).
3. Declare the date format.
4. Confirm the plan and batch mappings.
5. Tick the batches that may be activated. Only the newest batch in the file is pre-ticked. Every
   other valid row stages as **Inactive**.
6. Tick the confirmation and press **Stage**.

The same roster staged twice opens the first job; nothing is staged twice. A corrected roster
stages anyone already staged elsewhere as **Duplicate**. To replace a roster, discard the old job
(with a reason) and stage the new one.

**Staging the same file again with different settings is refused**, and the message names what
differs — the date format, the column matching, either label matching, or the cohorts ticked for
activation. Open the staged job to check it (the notice links straight to it), or discard that job
and stage again. This matters because the file's fingerprint is taken from its cells, not from how
you read them: 11/10 read as 10/11 still falls inside the batch's month, so nothing later would
catch it.

---

## 4. Activating

1. Open the job. Filter to **Pending activation**. Tick rows, or use **Select all ready in this
   view**, which only ever selects pending rows. One activation takes at most 200 rows.
2. **Activate** opens the workflow, in two steps.
   - **Step 1 — Membership terms.** The selection grouped by plan, batch and dates, as the roster
     gave them. For a start still ahead, **Open access today** is ticked: the students reach their
     dashboard as soon as they set a password, and their paid end date does not move. Untick it to
     keep the roster's start (they can set a password now and reach the dashboard on that day).
     **Change plan, batch or dates…** assigns different terms to a group. Every change is recorded
     with who made it and what it was before; the roster's own values stay on the row.
   - **Step 2 — Confirm.** New versus existing accounts, activation emails versus sign-in
     notifications, the plan and the final dates, the cohort seats each batch will get (including
     months that have no batch), capacity context and email readiness.
3. Type `ACTIVATE <n>` exactly and confirm.

One row's terms can also be changed from its panel (**Edit terms…**), with a reason, any time before
it is activated.

Progress is shown chunk by chunk. You can **Pause**, refresh the page, and **Resume** later; a row
that already succeeded is never repeated. Leaving the job is held until you pause, because leaving
takes the Pause button with it while the server keeps going.

**Retry failed rows** is offered once no activation is open, and covers failed rows from any run of
the job. It opens the same confirmation, with its own typed phrase, and gives each row a fresh set
of attempts. A row left mid-activation by a dropped connection becomes **Failed** after ten minutes
and is retried the same way — it was granted nothing, because the grant is one transaction.

For each row, the server:

1. creates or finds the Auth account (no email is sent by this step);
2. records it on the row;
3. in **one transaction**: creates the membership from the roster's own dates (00:00 Manila on the
   start date to the last moment of the end date, plus the 3-day grace), grants the cohort run from
   the live batch registry, approves the profile, and writes the audit event;
4. sends the email.

It never creates an enrollment request, a receipt or a payment record.

A row is **blocked for review** instead when the account is rejected, belongs to staff, already has
a current or upcoming membership, or does not match its email. A blocked row changes nothing about
the person's account: someone who signed up on their own, or bought a membership between staging and
activation, keeps their own sign-in and stays in **Access Requests** where you can still decide them.

### Memberships that start later

A start date still in the future creates a **scheduled** membership. The student can claim the
account and set a password, but courses and the batch community stay closed until the start date.
They see a "Your membership starts on …" screen with no price. A 15-minute job opens it on the
day; the student's own screen can open it too.

### Batches that are closed

A roster row whose batch has since closed still gets its seat in that batch. The batch is not
reopened. An archived batch blocks the row.

---

## 5. The email and the claim

- **New account, or one that never confirmed its email:** "Your learning account has moved —
  activate it now", from support@alexsagun.com. It lists their name, email, batch, plan,
  subscription start and expiry, says the membership is already paid, and has a one-time link to
  `/activate-account`. The link works for 24 hours; a resend replaces it.
- **Existing account with a password:** a notification with a plain sign-in link. No password reset.

Activating: the student presses **Activate my account**. The next page shows their name (which
they can correct) and their email (locked — it is how they sign in), and asks for a password
twice. Then a summary shows their name, email, batch, plan, subscription status and expiry, with
**Go To Dashboard**. No price appears anywhere on the way.

When they finish, two emails go out once, from support@alexsagun.com: **"Student Successfully
Onboarded"** to you, and a confirmation to the student with their subscription details, a link to
their dashboard and the support address. The row then shows **Onboarded**, and its panel says whether
those emails were sent. If sending failed (Resend down, say), the app tries again the next time the
student opens it — five tries in all — and the admin email is never sent twice.

If the link expired, they use **Forgot password** with the same email; setting a password that way
also finishes the setup and sends the same two emails.

**Resend** is on the row. Every resend is a new link; the previous one stops working.

---

## 6. Later cohorts (August, September)

Inactive rows stay staged. To activate some later:

1. select them, **Make ready…** (with a reason);
2. activate them as above.

They keep their original dates and batch. They are never moved into October.

---

## 7. Recovery

- **Revert** (row → Revert activation, with a reason) undoes an activation the student has not
  used: a scheduled membership, or a new account that has not been claimed. The membership is
  cancelled and the cohort seats are revoked. The account is kept — and so is its approval, so a
  claim email already sent still signs the student in; they will then see the enrollment page,
  because they no longer hold a membership. Tell them, or re-activate the row.
- After a student has claimed their account, change the membership from Enrollments.
- No Auth account is ever deleted by this feature.

---

## 8. Privacy and retention

- The audit trail stores ids and short codes only, and it cannot be edited or deleted.
- **Remove raw names and emails** (job toolbar) clears names and addresses from activated and
  reverted rows, and from every row of a discarded job. The record key, dates, plan, batch,
  payment history and audit trail remain. Inactive rows keep their data because they may still be
  activated.
- Links and tokens are never logged or stored.

---

## 9. Troubleshooting

- **"Activation is paused until the server has …"** — set the missing `RESEND_*`, `APP_URL` or
  support address, then redeploy. `APP_URL` is needed on preview deployments too, not just
  production: without it, activation refuses there rather than emailing students a preview link.
- **"This roster is already staged with different settings"** — open the staged job from the notice
  and check it, or discard it (with a reason) and stage the file again.
- **A row sits on Activating and nothing moves** — after ten minutes it becomes Failed by itself,
  and the job can be discarded or the row retried. It was granted nothing.
- **"Retry failed rows" is not offered** — an activation is still open. Pause or let it finish
  first; the button then covers failed rows from every run of the job.
- **Every row is Blocked** — check the declared date format and the plan and batch mappings. The
  **Problems CSV** lists each blocked row with its reasons.
- **"No batch exists for …"** in the confirmation — the cohort run skips that month, and a batch
  created for it later cannot join the run. Create the batch **before** activating if it should
  count.
- **An email shows "Invitation failed"** — press Resend on the row.
- **A student says the link expired** — they use Forgot password with the same email, or you resend.
