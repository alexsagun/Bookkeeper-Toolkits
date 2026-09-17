# Legacy Google Apps Script finance app — sanitized audit

**Date:** 2026-09-17
**Scope:** the local, untracked reference folder `Google Financial script/` (`Code.gs.txt`,
`DailyIncomeReport.txt`, `index.html.txt`, `QBO Mastery Enrollments.xlsx`), read to build
Financial Management → **Daily Income** (#64) and to confirm nothing else from it is missing.
**Not in this document, by design:** any row of the workbook, any student name, email, phone
number or amount, the script's configuration values (spreadsheet ids, deployment URLs,
administrator addresses) and anything from the workbook's credential sheet, which was not opened.
The folder is ignored by `.gitignore` and must never be staged.

---

## A. What the legacy app was

A Google Sheets workbook with an Apps Script web app on top. Six screens (`dash`, `enroll`, `comm`,
`finance`, `bank`, `meetings`) called ~100 server functions (`api*`), which read and wrote sheet
rows directly. It is **reference for product behaviour only** — the Toolkit's native architecture
(Supabase, RLS, SECURITY DEFINER RPCs, a double-entry ledger) is authoritative.

### Workbook structure (sheet and column NAMES only)

| Sheet | Purpose | Columns (names) |
|---|---|---|
| Enrollments | one row per enrollment form + review state | Date Signed Up, Full Name, Email, Cellphone, City and Country, College Course, Current Job Title, Experience Per Industry, PH/US/AU/UK Bookkeeping Experience, Currently Employed, Prior QBO/Xero Training, Resume/OnlineJobs.ph/LinkedIn/Facebook Link, **Program Enrolled**, **Total Amount Paid**, Payment Screenshot, Referred By, 3 Struggles, Batch (auto), Training Agreement, **Date**, **Status**, PaymentStatus, InternalNotes, PendingReason, FollowUpDate, LastEmailSent, Reviewer, ReviewedAt |
| Finances Summary | formula sheet, incl. the Daily Income Report block | (formulas) |
| BankTransactions | single-entry money log | ID, Date, Description, Payee, Amount, Account, AccountType, Category, Notes, Status, Cleared, ImportBatch, CreatedBy, CreatedAt |
| ExpenseTemplates | recurring expense presets | ID, Name, Vendor, Category, DefaultAmount, Recurring, Active, Notes |
| Automations | scheduled email rules | ID, Name, Type, Mode, Value, Threshold, Subject, Body, Active, LastRun |
| MeetingsLog | Zoom meetings created | CreatedAt, CreatedBy, ZoomID, Topic, When, Duration, Scope, Recipients, Sent, JoinURL |
| EmailLog / AuditLog | send and action logs | Date Sent, Sender, Recipient, CC, Subject, Status / Timestamp, User, Action, Target, Details |
| Balance - June Batch | a one-off balance tracker | (form columns) + Balance, Course |
| Calendars, channel notes, two ad-hoc personal sheets, a credential sheet | not product data | — (not read) |

---

## B. Feature map — legacy → native

| Legacy (`Code.gs` / screen) | Native Toolkit | Status |
|---|---|---|
| `apiDashboard`, `apiFinance` (dashboard) | Financial Management → Overview (`finance_dashboard_summary`, #58) | Present |
| **`apiDailyIncome` + Finances Summary "Daily Income Report"** | **Financial Management → Daily Income (`finance_daily_income_report`, #64)** | **Added by #64** |
| `apiSalesReport` | Sales & Receivables → Sales report (`finance_sales_report`, #59) | Present |
| `apiReceivables`, `apiSendReceivableReminder(s)` | Receivables worklist + Communications payment reminders (#58, #61) | Present |
| `apiLedger*`, `ExpenseTemplates` | Income & Expenses, expense presets, recurring templates (#58, #59) | Present |
| `apiBank*` (import, confirm, exclude, reconcile) | Bank & Reconciliation (#58, #59, #63) | Present |
| `apiProfitLoss*` | Profit & Loss pivot, cash basis (#59) | Present |
| `apiEnrollments`, `apiUpdateEnrollment` | Enrollments admin (#42, #60) | Present |
| `apiSendEmail`, `apiSendAnnouncement`, `apiAuto*`, `runScheduledNotifications` | Communications (#61) | Present |
| `apiZoom*`, `apiCreateMeeting`, `apiListMeetings`, `apiDeleteMeeting` | Meetings & Tasks (#62) | Present |
| `recordDailyIncome_`, `runDailyIncomeRecording`, `setupDailyIncomeTrigger`, `backfillDailyIncome*` | — | **Deliberately not recreated** (see D.2) |
| `enableRegistrationCoreSilver_`, `addCoreSilverRegistrants`, `recordRecurring_*`, `fix*Once_`, `diag*` | — | One-off maintenance for retired plans and a past data repair; nothing to port |

---

## C. How the legacy Daily Income Report worked

`apiDailyIncome({ year, month, includeAll })`:

1. Reads the **Enrollments** sheet and looks up four columns by header: `Date`, `Program Enrolled`,
   `Total Amount Paid`, `Status`.
2. Unless `includeAll`, keeps only rows whose status is `enrolled`.
3. Buckets each row into a day of the selected month in the **script's** timezone, parsing any
   non-date cell with `new Date(v)` and silently skipping what does not parse.
4. Parses the amount by deleting every character except digits, `.` and `-`; anything unreadable
   becomes **0**.
5. Classifies the package by lowercase **substring**, in order `vip`, `gold`, `essential`, `silver`,
   `core`, else `Other`.
6. Returns per-day totals, counts and per-package columns, hiding a package column with no sales.

### Defects, and what #64 does instead

| Legacy behaviour | Consequence | #64 |
|---|---|---|
| Income = the `Total Amount Paid` the form recorded | A typed amount, not money that reached the books; no reversal or refund could ever reduce it | Income = posted journal lines on income accounts |
| Five hard-coded packages, substring-matched | Gold and Core were retired (#39); "Essentials" is the Sampler **tagline**, so the matcher invented a fourth product | Columns come from `enrollment_plans`; a retired key is one Legacy/Other bucket, never a column |
| The Finances Summary formulas and `apiDailyIncome` disagree on the status filter | Two "daily income" figures for the same day | One server definition, shared with the cash-basis P&L; every call checks that each income entry landed in exactly one bucket |
| `Date` column here, `Date Signed Up` in `apiFinance` | The dashboard and the daily report dated the same sale differently | Everything by `entry_date` in the business timezone |
| Unparseable amount → 0, unparseable date → skipped | Errors look like quiet days | The ledger has typed `numeric(14,2)` and `date` columns; there is nothing to guess |
| No partial payments, no corrections | A refund or a reversal is invisible | Reversals are signed corrections on their own date; refunds and other income are separate buckets |
| Row count labelled as sales | A second row for one person looked like a second student | Collections (approved payment events) and distinct enrollments are separate numbers; a later instalment recorded by hand is Other income |

---

## D. Decisions this audit records

1. **Three plans only.** Sampler Session (₱1,499, tagline "Essentials"), QBO + Resume Combo
   (₱2,999) and Personalized Coaching Program (₱16,999). The workbook's VIP ₱15,999, Gold and Core
   are history. No report multiplies a count by today's price.
2. **No daily "Daily Sales" posting.** The legacy nightly job wrote one income row per day computed
   from `apiLedgerGrossSales` — which returns **0 on any error**, after which its duplicate check made
   that day permanently un-recordable. In the Toolkit every approval already posts its own balanced
   collection (#58), so a daily summary row would count every sale twice.
3. **Cash basis only.** The legacy P&L returned `basis: filters.basis || "accrual"`, a label that
   changed no figure. The native P&L and Daily Income have no basis argument at all.
4. **No legacy-data import** (owner decision 2026-09-12, restated). The workbook is not imported,
   not committed, and not used as test data.
5. **Reversals are dated the day they are made** (owner decision 2026-09-17). Financial
   Management → Reverse now defaults to today in the business timezone; "original date" remains
   for voiding a mistake.

## E. Security and privacy notes

- The legacy server functions trusted the browser: privileged mutations (reconcile, import, post,
  mass email) ran for whoever could load the web app. The native equivalents are SECURITY DEFINER
  RPCs gated on `finance.manage` / `communications.send` / `meetings.manage`, with zero client
  write paths on the finance tables.
- The workbook holds student personal data and a credential sheet. It stays local, under
  `.gitignore`; nothing from its rows appears in the repository, tests or logs.
