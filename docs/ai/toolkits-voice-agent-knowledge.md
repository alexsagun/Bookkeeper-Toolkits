<!-- GENERATED FILE — do not hand-edit. Regenerate with `npm run ai:knowledge`
     (scripts/generate-voice-agent-knowledge.mjs). Generated: 2026-08-17 -->

# Toolkits by Alex — Voice Assistant Knowledge

This document is the product knowledge for the in-app voice assistant of **Ultimate
Remote Bookkeeper Toolkits ("Get Hired With Alex")** — a web app for aspiring and working
remote bookkeepers serving US clients, built by Coach Alex Sagun. It describes the app as
students and admins experience it. Sidebar labels can be renamed by an admin, so a tool's
visible name may occasionally differ slightly from the label listed here; tab ids and URL
paths never change.

## 1. App overview

- The toolkit bundles **35 tools** across three career stages: **01 Training &
  Skills** (build your foundation), **02 Job Application** (land US clients), and
  **03 Client Management & Delivery** (onboard, operate, close the year), plus a Home
  dashboard.
- Many tools are AI-assisted (proposal writing, bank-feed categorization, statement
  conversion, SOPs); the rest (calculators, checklists, templates, Chart of Accounts)
  work fully offline.
- Users sign in with email/password (Supabase). The whole app sits behind a login; new
  accounts go through enrollment (payment) before reaching the toolkit.
- The app is a single-page app — the sidebar lists the stages and tools, and each tool is
  a "tab". The assistant can navigate to any tool with the `navigate_to_tool` client
  tool and open account panels with `open_account_panel`.

## 2. User roles

- **Student / member**: a paying user. Sees the toolkit scoped to their plan (see
  section 4). Has account panels: Profile & Settings, Membership Plan, Upgrade Plan,
  Extend Access, and Renew.
- **Admin** (Coach Alex's team): full access to every tool plus two admin screens —
  **Access Requests** (approve/reject signups) and **Enrollments** (review payment
  receipts, approve subscriptions, manage renewals). Admins have **no subscription**, so
  billing panels (membership/upgrade/extend/renew) do not exist for them — only Profile &
  Settings. Never offer an admin a billing panel, and never offer a student an admin
  screen.

## 3. Navigation map (tools by stage)

### Home

| Tool | Tab id | URL path | What it does |
|---|---|---|---|
| Dashboard | `dashboard` | `/` | Progress overview with career-stage tiles, membership status, and quick links to every tool. |
| Community | `community` | `/community` | Member forum split into spaces: a General space every active member can read and react to (announcements only — nobody replies there) plus a private per-batch VIP space with the full forum — search, free-form tags, image/video/link attachments, @mentions, reactions, pinned posts, and admin announcements with read-tracking, plus a notification bell. VIP members land in their own batch community; access follows the membership automatically. |

### Training & Skills

| Tool | Tab id | URL path | What it does |
|---|---|---|---|
| Accounting 101 | `course` | `/courses/accounting-101` | Self-paced foundational accounting course (8 modules). |
| QuickBooks Online Mastery | `qbomastery` | `/courses/quickbooks-online-mastery` | QuickBooks Online video-course catalog (Essentials and Mastery programs) with completion certificates. |
| Industry Accounting | `industryacc` | `/industry-accounting` | Accounting playbooks for 12 US industries with QuickBooks workflows. |
| US Tax 101 | `ustax` | `/us-tax-101` | US tax basics for bookkeepers: key forms, deadlines, and IRS links. |
| ProAdvisor Chat | `chat` | `/proadvisor-chat` | AI mentor chat for QuickBooks cleanups and day-to-day bookkeeping questions. |
| Niche Selector Quiz | `niche` | `/niche-selector-quiz` | Eight-question quiz that recommends your best-fit bookkeeping industry niche. |

### Job Application

| Tool | Tab id | URL path | What it does |
|---|---|---|---|
| Authentic Branding | `brand` | `/authentic-branding` | Guided questionnaire that builds your authentic personal brand story for applications. |
| Resume Winning Strategy | `resumestrategy` | `/courses/resume-winning-strategy` | Resume video-course catalog with completion certificates. |
| Book 1-on-1 with Alex | `linkedinopt` | `/profile-optimization/book-with-alex` | Booking page for a 1-on-1 profile-optimization session with Alex. |
| Personalized Coaching With Alex | `coachalex` | `/booking/coach-alex` | Booking page for personalized coaching sessions with Coach Alex. |
| Job Interview Mastery | `interview` | `/job-interview-mastery` | Interview prep hub: winning-strategy courses, mock interview simulator, common and accounting questions, body language, JD question generator, and salary negotiation. |
| Free QB Diagnostic | `qbdiag` | `/quickbooks-diagnostic` | QuickBooks file diagnostic checklist to offer prospects as a free audit. |
| Painpoints & Solutions | `painpoints` | `/painpoints-solutions` | AI generator for client pain points and how a remote bookkeeper solves them. |
| Cover Letter Generator | `proposal` | `/proposal-generator` | Paste a job post to get three cover letters, a timed video-introduction script, and an interview prep pack. |
| Discovery Call Simulator | `discovery` | `/discovery-call-simulator` | AI-simulated discovery-call practice with a prospective US client. |

### Client Management & Delivery

| Tool | Tab id | URL path | What it does |
|---|---|---|---|
| Engagement Letter | `engagement` | `/engagement-letter` | Generates a professional bookkeeping engagement letter. |
| Client Onboarding | `onboarding` | `/client-onboarding` | New-client onboarding checklist and workflow. |
| Chart of Accounts | `coa` | `/chart-of-accounts` | Industry-specific, QuickBooks-import-ready Chart of Accounts generator. |
| Invoice Creator | `invoice` | `/invoice-creator` | Builds professional downloadable invoices. |
| US CPA AI | `cpaai` | `/booking/us-cpa` | Booking page for US CPA-level consultations. |
| Bank Feed AI | `bankfeed` | `/bank-feed-ai` | Paste a bank-feed memo; AI suggests the vendor match and QuickBooks account category. |
| Statement → CSV | `converter` | `/statement-to-csv` | Converts PDF or image bank statements into clean CSV files via AI. |
| Email Templates | `emails` | `/email-templates` | Twelve professional client email templates (delivery, collections, W-9 requests, and more). |
| Accounting Calculators | `calculators` | `/accounting-calculators` | Seven-in-one accounting calculator suite. |
| Monthly Workflow | `workflow` | `/monthly-workflow` | Day-by-day monthly bookkeeping workflow. |
| Month-End Checklist | `monthend` | `/month-end-checklist` | Interactive month-end close checklist. |
| SOP Generator | `sopgen` | `/sop-generator` | AI generator for client-specific standard operating procedures. |
| Sales Tax | `salestax` | `/sales-tax` | US sales-tax reference and calculator. |
| Budgeting Tool | `budgeting` | `/budgeting` | Client budgeting workbook with variance tracking. |
| Forecasting Tool | `forecasting` | `/forecasting` | Cash-flow and revenue forecasting workbook. |
| Year-End Checklist | `yearendcheck` | `/year-end-checklist` | Year-end close checklist. |
| 1099 Prep | `form1099` | `/1099-prep` | 1099 contractor prep tracker for year-end filing. |

### Admin (admin accounts only)

| Tool | Tab id | URL path | What it does |
|---|---|---|---|
| Access Requests | `accessrequests` | `/admin/access-requests` | Admin screen: approve or reject new signups. |
| Enrollments | `enrollments` | `/admin/enrollments` | Admin screen: review payment receipts, approve subscriptions, and manage renewals. |
| Student Imports | `studentimports` | `/admin/student-imports` | Admin screen: migrate legacy Thinkific students — validate, map course-combos to plans, dry-run, and import accounts + memberships. |
| Batches | `batches` | `/admin/batches` | Admin screen: manage the VIP batches — create a monthly batch, edit its name, code, dates, timezone and seat capacities while the batch is current or upcoming, close or archive it, and assign members to their private batch communities. A batch closes automatically once its month ends, and a batch whose period has passed becomes read-only. |

Special sub-sections of Job Interview Mastery (tab `interview`): winning-strategy
courses (`winstrat`), mock interview simulator (`mock`), common questions
(`common`), accounting questions (`accounting`), body language (`body`), JD
question generator (`jdgen`), and salary negotiation (`salary`).

## 4. Subscription plans, pricing, and entitlements

All prices are **fixed Philippine-peso (₱) bank-transfer amounts** — never convert them
to USD.

| Plan | Key | Price (PHP) | Access | Highlights |
|---|---|---|---|---|
| Sampler Session (Essentials) | `sampler` | ₱1,499 | 60 days | 1 Live Zoom Session (3 hours); 60-day course access; 60-day group chat support; Limited offer · 60-day support |
| QBO + Resume Combo (Silver · Self-Paced) | `silver_self_paced` | ₱2,999 | 60 days | Simulated annual bookkeeping project for an NY-based construction company; 60-day QBO Mastery course access; 60-day Resume & Interview course access; Weekly Discord chat (Thu) |
| Personalized Coaching Program (VIP Package) | `vip` | ₱16,999 (was ₱35,000) | 180 days | Simulated annual bookkeeping project for an NY-based construction company; 12 Live Group Zoom Trainings (MWF 9am to 11am PH Time); 1-on-1 Resume & Interview Coaching (1 session); Weekly group consult until hired; Discord chat support until and after hired; BEST SELLER · Limited to 10 slots per month |

**What each plan can open (entitlement scope):**

- **Sampler Session** (`sampler`): Essentials + 1-on-1 coaching. Can open: Dashboard, QuickBooks Online Mastery, Book 1-on-1 with Alex, Personalized Coaching With Alex, Community. Within the QuickBooks catalog it can only open **essentials-tier** courses (QuickBooks Online Essentials — NOT Mastery).
- **QBO + Resume Combo** (`silver_self_paced`): **Full toolkit access** — every student tool in the toolkit.
- **Personalized Coaching Program** (`vip`): **Full toolkit access** — every student tool in the toolkit.
- **Admins, and legacy members with no plan key on file**: full toolkit access.
- **A retired or unrecognized plan key** (e.g. a membership that is no longer sold): Home only. The member keeps their Dashboard and membership panel and is asked to renew or upgrade — it does NOT grant the full toolkit.

Important nuance: the **Sampler Session is the only plan with limited course access** —
its ₱ price buys a live Zoom session and a 1-on-1 coaching booking, not the full course
library. It opens QuickBooks Online **Essentials** only, not Mastery. Both other plans
open every student tool.

A tool outside the user's plan still shows a polite upgrade page if opened — nothing
breaks. The assistant may navigate there and then suggest upgrading.

## 5. Membership lifecycle (expiry, grace, renew / extend / upgrade)

- Approval of a payment grants a **dated term**: plan `access_days` (60 or 180 days)
  from approval. The expiry date is authoritative — server-side rules enforce it.
- Members see their plan, status, expiry date, and days remaining on the **Dashboard
  membership panel** and under **Profile & Settings**. Warnings turn **amber at ≤ 5 days
  left** and **red at ≤ 3 days**.
- After the end date there is a **3-day grace period** — access continues, with a red
  "grace period" warning. After grace, the member lands on a Membership Expired screen
  until they renew.
- **Renew**: reuses the payment flow (pick plan → pay → upload receipt → admin review).
  Renewing early never loses days — the new term stacks on top of the current expiry.
- **Extend Access**: buys more time on the SAME plan at the plan's own daily rate
  (price ÷ access days × days bought). Minimum 2 months (60 days), maximum 12 months.
  For a 60-day plan, a 2-month extension costs the full plan price.
- **Upgrade Plan**: pick a different plan; approval starts a full fresh term of that plan.
- A member with a **pending renewal/extension/upgrade keeps full access** while the
  request is under review.

## 6. Payment & review workflow

1. The student picks a plan and sees the payment instructions (bank transfer / GCash —
   the exact accounts are shown in-app on the payment screen).
2. They upload a payment receipt (screenshot/photo) and submit.
3. The request shows as **"Payment under review"** until an admin reviews it in the
   Enrollments screen — typically the student just waits; the screen updates by itself.
4. On approval, access opens immediately (or the term extends/renews). On rejection, the
   student sees the reason and can resubmit with a corrected receipt.

The assistant can NEVER approve payments, verify receipts, change plans, or promise
approval timing — that is always an admin action. For payment problems, direct the user
to the support email shown on the payment screen or to Coach Alex.

## 7. Courses & certificates

- Course catalogs: **QuickBooks Online Mastery** (`qbomastery` — QuickBooks Online
  Essentials and Mastery programs), **Resume Winning Strategy** (`resumestrategy`), and
  the interview winning-strategy catalog inside Job Interview Mastery.
- Courses are video courses with modules and lessons; per-user progress is saved across
  devices. Completing **every lesson** in a course unlocks a downloadable **PDF
  certificate**.
- The QuickBooks catalog has two tiers: **Essentials** (available to Sampler members) and
  **Mastery** (standard tier). Other plans with QuickBooks access read both.
- **Accounting 101** (`course`) is the free-form foundational course with 8 modules.
- **AI course trainer:** enrolled members can ask the assistant to **teach, explain, quiz,
  practice, or recap** their included courses. Course material is fetched through secure
  training tools that re-check the member's live plan on every request — the assistant
  must ALWAYS use `get_my_training_catalog` / `get_authorized_training_context` for
  course content and never teach paid material from memory or from this document (which
  deliberately contains **no** course content). If a course isn't in the member's plan,
  the tools return a polite denial with upgrade options.

## 8. Common questions (FAQ)

- **"Where is QuickBooks Online Mastery?"** → Training & Skills stage → navigate to
  `qbomastery`.
- **"When does my access expire?"** → use `get_user_membership_summary`; the Dashboard
  membership panel and Profile & Settings also show it.
- **"How do I upgrade / renew / extend?"** → open the `upgrade`, `renew`, or
  `extend` account panel (members only).
- **"What's included in my plan?"** → `get_user_membership_summary` gives the scope;
  section 4 has the details.
- **"How do I use Bank Feed AI?"** → navigate to `bankfeed`: paste the raw bank-feed
  memo, AI suggests the vendor and QuickBooks category; always review before posting.
- **"Where do I practice interviews?"** → `interview` (Job Interview Mastery); the mock
  interview simulator is its second sub-tab (watch the guide video to unlock the launch
  button).
- **"What should I do first as a beginner?"** → start with Accounting 101 and QuickBooks
  Online Mastery in Training & Skills, take the Niche Selector Quiz, then move to the Job
  Application stage (Authentic Branding → Resume → Interview prep).
- **"Show me the resume course."** → navigate to `resumestrategy`.
- **"Book a session with Alex."** → `linkedinopt` (1-on-1 profile optimization) or
  `coachalex` (personalized coaching).

## 9. Bookkeeping tips the coach repeats

- A clean Chart of Accounts is the foundation of clean books. 30-50 accounts is plenty for most small businesses. Don't over-engineer.
- When in doubt, ASK the client. Never guess. Five minutes of asking saves five hours of fixing.
- Reconcile every account every month. Including credit cards. Including loans. No exceptions.
- Owner's Draws ≠ Wages. This is the #1 mistake made on sole prop and SMLLC books.
- Read the Balance Sheet before you say the books are done. A clean P&L can hide a broken Balance Sheet.
- Use Classes or Projects in QBO to track location, property, or job profitability. It's a power move clients pay extra for.
- Document everything in the memo field. Future-you will thank present-you.
- Never delete transactions. Void them or fix them — but keep the audit trail.

## 10. Assistant limitations & support

- The assistant can **navigate the app, explain tools, read the signed-in user's own
  membership facts, and teach the user's own included courses through the secure training
  tools** — nothing else. It cannot submit payments, approve requests, edit subscriptions,
  change account data, or see other users' data.
- The assistant is an **AI trainer built on Coach Alex Sagun's approved course material —
  it is not Alex** and never claims to be him or to say what he personally said unless
  that statement is in the retrieved course material.
- No legal, tax, or financial **guarantees** — bookkeeping guidance is educational; defer
  binding advice to a CPA and program specifics to Coach Alex.
- Payment disputes, refunds, account changes, and anything sensitive → route to the
  support email on the payment screen / Profile & Settings, or to Coach Alex directly.
- When unsure, say: **"I'm not fully sure from the current toolkit data, but I can guide
  you to the closest section."** Never invent tools, prices, or policies that are not in
  this document.
