# Sidebar-width layout audit: the Enrollments card, every route, and what they led to

**Date:** 2026-09-24 → 2026-09-25
**Trigger:** with the desktop sidebar expanded, the Enrollments → Pending request card was
compressed and unreadable; collapsing the sidebar to the icon rail made it readable again.
**Method:** every number below was measured in Chrome driven over the DevTools Protocol by the
repo's own harness (`test-e2e/_cdp.mjs`), against the **shadow** Supabase project with seeded
`e2e-` personas. Nothing here touched production data. The Chrome DevTools MCP was not used for
signed-in pages, so no session token passed through a transcript.

---

## A. Root cause of the Enrollments collapse

The row was one CSS grid: `lg:grid-cols-[auto,minmax(0,1fr),auto,auto,auto]`, meaning avatar,
identity, plan, status, and **all the action buttons in the last `auto` track**.

- Grid gives every `auto` track its max-content width **before** a flexible `fr` track gets any
  space. The last track held six to eight buttons that wrap, so its single-line width was
  276–458px. Identity was the only `minmax(0,1fr)` track, so it received whatever was left, and
  its floor was 0.
- `lg:` reads the **viewport**, which is identical with the sidebar open (288px) or collapsed
  (76px). The same breakpoint therefore fired whether the workspace was 726px or 938px wide.
- The card never overflowed. `scrollWidth === clientWidth` at every width, so any overflow check
  reported it as fine.

### A/B, same account, data, route and theme; only the sidebar changes

| Viewport | Before, sidebar open | Before, rail | After, sidebar open | After, rail |
|---|---|---|---|---|
| 1024 | identity **0px** (tracks `40 0 166 66 276`) | **0px** | 560px (medium layout) | 432px |
| 1280 | **0px**; city wrapped to 7 lines | **0px** | 476px | 688px |
| 1366 | **0px** | 60px | 562px | 774px |
| 1440 | **0px** | 60px | 636px | 774px |
| 1920 | 60px | 60px | 774px | 774px |

- **Before:** commit `09959b9`. **After:** the fixed working tree.
- During the 300ms sidebar animation, the old identity column swung between 74 and 286px. The
  fixed card's never dropped below 478px.
- Before and after, card overflow was 0 and no errors were logged.

## B. The fix

- **`.enroll-card` is a named inline-size container** (`src/index.css`, "ENROLLMENT REQUEST
  CARD"). Its layout follows the card's own width, not the viewport, like the existing
  `.course-workspace` and `.pf-tool`.
- **The head grid holds identity, plan and status only; the actions are a row of their own.** A
  row of buttons in an `auto` track beside a `minmax(0,1fr)` column is the defect itself, and is
  now a written rule in CLAUDE.md and the `bookkeeper-conventions` skill.
- **Three layouts, by card width:**
  - under 420px, everything stacks, with two actions per row at 40px touch height;
  - 420–759px, identity alone, then plan | status;
  - from 760px, identity | plan | status on one row. Identity keeps ≥ 368px there; the
    derivation is in the CSS.
- **Single facts never split.** The name, email, plan and payment reference wrap instead of being
  cut off. The date and "Nd left" never break across lines. A phone number breaks only if it
  cannot fit a line at all.
- **Accessibility:**
  - the Details toggle is labelled and has `aria-expanded` / `aria-controls`;
  - the card and the list are named `role="group"` focus targets, and focus returns there after
    a decision, never behind an open dialog and never to `<body>`, including after the last card
    in a view is decided;
  - the sidebar's two toggle buttons hand focus to each other (both used to drop it to `<body>`);
  - admin count badges are read as sentences;
  - the notice banner's announcement urgency follows the colour it actually shows.

## C. Every route, both sidebar states

`test-e2e/workspaceSweep.e2etest.mjs` walks all 41 routes in `TAB_ROUTES` (the 42 minus a
redirect alias), including each route's own sections. It visits them at 1024 and 1280 with the
sidebar open and collapsed, plus a 390px phone. Its generic detector looks for:

- `<main>` scrolling sideways;
- letter-stacked text;
- collapsed grid tracks;
- overlapping grid siblings;
- text spilling out of a narrow grid item.

Found and fixed, each using the same container-query idiom:

| Route | Failure (1024, sidebar open) | Fix |
|---|---|---|
| Progress & Rankings, staff report | `lg:grid-cols-4` left each StatCard a 39px text column; "14+ days without progress" stacked on 4 lines | `.stat-strip`: 1 → 2 → 4 columns at 496 / 1004px |
| Dashboard, career roadmap | `md:grid-cols-7` left a 54px label box | `.roadmap-strip`: 3 → 4 → 7 columns at 440 / 776px; the stage arrows appear only in the single-row layout |
| Invoice Creator, line items | a fixed `grid-cols-12` put the amount in a 44px `col-span-1`; "$1,500.00" painted 26px into the remove button | `.inv-lines`: the amount is sized to its content; on narrow widths lines stack, and every input got an `aria-label` because the column headers hide |

Clean in both sidebar states:

- Access Requests, Batches, Team & Roles and Student Imports;
- all eight Financial Management sections;
- Communications and Meetings (every section);
- the course player (890px container) and the Portfolio Generator (984px container);
- every other route.

### Phone width (390px, sidebar drawer closed)

| Route | Failure | Fix |
|---|---|---|
| **Every tab** | the shared `SectionHead` band used a flat `-mx-10`, correct only against `lg:p-10`; on a phone it overhung the 16px padding by 24px on each side (`<main>` held 334px in 310) | the band now mirrors the TabPanel padding at every breakpoint; lg and up are unchanged |
| Dashboard | the hero's `.gh-halo::after` glow used `inset: -40px`, 24px past a phone's padding; a pseudo-element is invisible to an element-by-element scan | the glow's sideways reach mirrors the padding |
| QuickBooks diagnostic | the step tabs did not wrap; the third ran 22px off-screen | `flex-wrap` |
| Financial Management | the From/To/Apply filter was a fixed ~375px row | `flex-wrap` |

**Recorded, not fixed: Financial Management's data tables on a phone.** The tables already sit in
`overflow-x-auto` cards, but as `w-full` tables they shrink every column before scrolling, so on a
phone:

- dates break at each hyphen (`2026-09-24 23:54` over three lines in a 37px cell);
- account-line summaries stack a few characters per line;
- plan names wrap word by word.

Nothing overlaps and nothing is lost, and this is a Super-Admin-only screen used on desktop. The
fix is a `min-width` on each finance table, confirmed one table at a time to sit inside a
scrolling wrapper, plus `whitespace-nowrap` on date and code cells. The sweep's phone pass
therefore asserts only the page-level check (`<main>` does not scroll sideways), with this
paragraph cited in its source.

## D. Found alongside, fixed

1. **A decided enrollment request could be reopened: migration #66.**
   - #48's column grant lets every `enrollments.review` holder PATCH `status`, and both existing
     guards fire only on a move **to** `approved`.
   - Reproduced on the shadow project as a real Operations Admin: approve → PATCH back to
     `pending_review` → approve again produced **2 membership terms for 1 payment**, with 1
     finance collection and no audit row.
   - `enrollment_decision_lock` refuses any status change out of approved / rejected / expired
     unless the caller is a Super Admin or the table owner sets an explicit override. Every
     permitted reopen is logged as `decision_reopened`.
   - `test-db/enrollmentDecisionLock.dbtest.mjs`: 4 of 7 failed before the migration, 7 of 7
     pass after it. **Applied to the shadow project only**; production waits for the owner.
2. **Decision emails could be sent to any address.** `api/notify-enrollment.js` `decision` took
   the recipient, name, package and a free-text reason from the request body. It now takes
   `{ requestId, status }`, reads the package and reason from the request row and the recipient
   from the student's **profile**. That is never the email the student typed on the request, which
   `enroll_req_own_insert` does not check. It refuses to send unless the status matches the
   decision actually recorded.
3. **A stale card could re-decide a request.** `doDecline` now filters on `pending_review` and
   says so when nothing matched.

## E. Found, not fixed (for the owner)

- **`api/notify-access.js` has the same flaw as item D2.** `access_requests.review` holders
  (Operations Admins included) can send the business's branded "your access was
  approved/rejected" email to any address with any text. The right fix reads the recipient with
  the reviewer's JWT, but Operations Admins can reach other profiles only through
  `admin_access_request_queue()`, which is capped at 1,000 rows. It needs a small row-lookup RPC,
  i.e. a migration of its own. The notify handlers deliberately never hold the service-role key
  (see `vite.config.js`), so that shortcut was not taken.
- **Approve renders on rejected and expired requests**, but `admin_finalize_enrollment` refuses
  anything except `pending_review`. The button always fails there.
- **"Grant incomplete — Approve again"** leads to an RPC that returns `already` without granting
  anything, so the badge promises a repair it cannot perform.
- **The shadow project has drifted from the repo on `profiles_admin_select`.** Shadow has
  `is_admin()` only; the repo and production also admit `access_requests.review` and
  `enrollments.review`. `db:shadow:verify` compares policy names, never their conditions, so it
  cannot see this. Rebuild the shadow project or re-apply #45's `alter policy`.

## F. What verifies it

| Suite | What |
|---|---|
| `npm test` | 2,309 tests. They include `uiSafety` §26 (card shape, focus targets, SectionHead + halo, the three sweep fixes), `enrollmentDecisionLockSql` (#66 in the dated file and fold §53) and `notifyEnrollmentDecision` |
| `npm run test:e2e` | `enrollmentLayout`: 9 viewports × both sidebar states × both themes × 125/150/200% zoom × all 14 filters; mid-animation frames; reload in each persisted state; focus on the toggle; Operations Admin, Trainer and student role checks; a **negative control** that re-creates the original defect and requires the probe to report it. `workspaceSweep`: all 41 routes as above |
| `test-db/enrollmentDecisionLock.dbtest.mjs` | #66 as real signed-in personas through PostgREST |

**Mutation checks:**

- Each new static pin was removed in turn, and each removal failed the suite.
- Three CSS mutants re-created the defect in the live page: actions back in an `auto` track,
  a viewport breakpoint in place of the container, and a split date. The rendered probe caught
  all three. The first reproduced the original report: identity text painting outside its region.
