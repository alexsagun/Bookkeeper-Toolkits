#!/usr/bin/env node
// Generates docs/ai/toolkits-voice-agent-knowledge.md — the product-knowledge document
// for the ElevenLabs voice assistant ("Toolkits Guide"). Deterministic: no AI calls.
//
//   npm run ai:knowledge          → regenerate the doc
//   npm run ai:knowledge:check    → rebuild in memory + diff against disk; exit 1 on drift
//                                   (writes nothing — the CI-able "did you forget to
//                                   regenerate?" guard; the Generated date is ignored)
//   npm run ai:knowledge:push     → regenerate, then upload to the ElevenLabs KB
//
// HOW IT WORKS
// Routes, tool descriptions and tips are extracted from PURE module-scope literals in
// src/BookkeeperPro.jsx via an anchored balanced-bracket scan + `new Function` evaluation.
// Plan pricing and entitlement scopes are IMPORTED from src/lib/planCatalog.js, which is a
// plain ESM module — no extraction, no purity contract. Prose sections (lifecycle rules,
// workflows, FAQs) are hand-authored in the TEMPLATE below with {{PLACEHOLDER}} slots.
// If a literal moves, is renamed, or stops being a pure literal, this script FAILS LOUDLY
// with an actionable message — fix the literal (or this script) and rerun.
//
// Keep in the same change as any tool/plan edit — see "Keeping docs current" in CLAUDE.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENROLLMENT_PLANS_FALLBACK, PLAN_ENTITLEMENTS } from '../src/lib/planCatalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'BookkeeperPro.jsx');
const OUT = join(ROOT, 'docs', 'ai', 'toolkits-voice-agent-knowledge.md');
const BOOTSTRAP_SQL = join(ROOT, 'db', '000_full_database_bootstrap.sql');

function fail(msg) {
  console.error(`\n[ai:knowledge] FAILED: ${msg}\n`);
  process.exit(1);
}

// ── Literal extraction ─────────────────────────────────────────────────────────
// Anchored on `const <name> = `, then a balanced [ ] / { } scan that honors string
// literals (with escapes), template strings, and // + /* */ comments, so braces inside
// any of those never unbalance the count. The snippet is evaluated with `new Function`,
// optionally with injected identifiers.
function extractLiteral(src, name, inject = {}) {
  const anchor = `const ${name} = `;
  const at = src.indexOf(anchor);
  if (at === -1) {
    fail(`Literal "${name}" not found in src/BookkeeperPro.jsx — it moved or was renamed. Update scripts/generate-voice-agent-knowledge.mjs (or restore the literal).`);
  }
  let i = at + anchor.length;
  while (i < src.length && src[i] !== '[' && src[i] !== '{') i++;
  const open = src[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let end = -1;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      j++;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      continue;
    }
    if (ch === '/' && src[j + 1] === '/') {
      while (j < src.length && src[j] !== '\n') j++;
      continue;
    }
    if (ch === '/' && src[j + 1] === '*') {
      j += 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j++;
      continue;
    }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  if (end === -1) fail(`Literal "${name}" has unbalanced brackets — check src/BookkeeperPro.jsx.`);
  const snippet = src.slice(i, end + 1);
  const argNames = Object.keys(inject);
  const argValues = Object.values(inject);
  try {
    return new Function(...argNames, `return (${snippet});`)(...argValues);
  } catch (err) {
    fail(`Literal "${name}" is no longer a PURE literal (${err.message}). Keep it free of component refs and function calls, or update the generator.`);
  }
}

// Soft assertion: warn (don't fail) when a hand-authored number in the template no
// longer greps in the source — a nudge that the prose may have drifted.
function softAssert(haystack, needle, what) {
  if (!haystack.includes(needle)) {
    console.warn(`[ai:knowledge] WARN: ${what} — "${needle}" no longer found; the hand-authored lifecycle prose may be stale.`);
  }
}

const src = readFileSync(SOURCE, 'utf8');

const TAB_ROUTES = extractLiteral(src, 'TAB_ROUTES');
const VOICE_TAB_INFO = extractLiteral(src, 'VOICE_TAB_INFO');
const TIPS = extractLiteral(src, 'TIPS');
// ENROLLMENT_PLANS_FALLBACK + PLAN_ENTITLEMENTS are imported from src/lib/planCatalog.js
// at the top of this file — they are a real module, so there is nothing to extract.

// Cross-check: every route needs voice info and vice versa (mockinterview is an alias).
const routeIds = Object.keys(TAB_ROUTES).filter((id) => id !== 'mockinterview');
const infoIds = Object.keys(VOICE_TAB_INFO);
for (const id of routeIds) {
  if (!VOICE_TAB_INFO[id]) fail(`Tab "${id}" is in TAB_ROUTES but missing from VOICE_TAB_INFO — add an entry (label/stage/desc).`);
}
for (const id of infoIds) {
  if (!TAB_ROUTES[id]) fail(`Tab "${id}" is in VOICE_TAB_INFO but not in TAB_ROUTES — remove it or add the route.`);
}

softAssert(src, 'daysLeft <= 3', 'red expiry warning threshold (≤3 days)');
softAssert(src, 'daysLeft <= 5', 'amber expiry warning threshold (≤5 days)');
// extensionPrice() lives in src/lib/planCatalog.js, so this one reads that file.
softAssert(readFileSync(join(ROOT, 'src', 'lib', 'planCatalog.js'), 'utf8'),
  'Math.max(60,', 'extension minimum (2 months / 60 days)');
if (existsSync(BOOTSTRAP_SQL)) {
  softAssert(readFileSync(BOOTSTRAP_SQL, 'utf8'), 'v_grace_days constant int := 3', 'grace period (3 days) in db bootstrap');
}

// ── Rendering ──────────────────────────────────────────────────────────────────
const php = (n) => '₱' + Number(n || 0).toLocaleString('en-US');

const STAGE_ORDER = ['Home', 'Training & Skills', 'Job Application', 'Client Management & Delivery', 'Admin'];
const byStage = new Map(STAGE_ORDER.map((s) => [s, []]));
for (const [id, info] of Object.entries(VOICE_TAB_INFO)) {
  if (!byStage.has(info.stage)) byStage.set(info.stage, []);
  byStage.get(info.stage).push({ id, ...info, path: (TAB_ROUTES[id] || '').split('?')[0] });
}

let navSection = '';
for (const [stage, tools] of byStage) {
  if (!tools.length) continue;
  navSection += `\n### ${stage}${stage === 'Admin' ? ' (admin accounts only)' : ''}\n\n`;
  navSection += '| Tool | Tab id | URL path | What it does |\n|---|---|---|---|\n';
  for (const t of tools) {
    navSection += `| ${t.label} | \`${t.id}\` | \`${t.path}\` | ${t.desc} |\n`;
  }
}

let plansTable = '| Plan | Key | Price (PHP) | Access | Highlights |\n|---|---|---|---|---|\n';
for (const p of ENROLLMENT_PLANS_FALLBACK) {
  const price = p.compare_at_php ? `${php(p.price_php)} (was ${php(p.compare_at_php)})` : php(p.price_php);
  const extras = [p.badge, p.limit_note, p.support_days ? `${p.support_days}-day support` : null].filter(Boolean);
  const highlights = p.features.concat(extras.length ? [extras.join(' · ')] : []).join('; ');
  plansTable += `| ${p.name} (${p.tagline}) | \`${p.key}\` | ${price} | ${p.access_days} days | ${highlights} |\n`;
}

const scopedKeys = Object.keys(PLAN_ENTITLEMENTS);
let scopeSection = '';
for (const key of scopedKeys) {
  const cfg = PLAN_ENTITLEMENTS[key];
  const plan = ENROLLMENT_PLANS_FALLBACK.find((p) => p.key === key);
  const name = plan ? plan.name : key;
  if (cfg.full) {
    scopeSection += `- **${name}** (\`${key}\`): **${cfg.scopeLabel}** — every student tool in the toolkit.\n`;
  } else {
    const tabs = (cfg.tabIds || []).map((id) => VOICE_TAB_INFO[id]?.label || id).join(', ');
    scopeSection += `- **${name}** (\`${key}\`): ${cfg.scopeLabel}. Can open: ${tabs}.${cfg.courseTier ? ` Within the QuickBooks catalog it can only open **${cfg.courseTier}-tier** courses (QuickBooks Online Essentials — NOT Mastery).` : ''}\n`;
  }
}
// Every sellable plan must carry an explicit PLAN_ENTITLEMENTS entry — an unlisted key
// now resolves to the fail-closed branch, so a plan missing here would be locked out of
// its own toolkit rather than quietly granted everything.
const unscopedPlans = ENROLLMENT_PLANS_FALLBACK.filter((p) => !scopedKeys.includes(p.key));
if (unscopedPlans.length) {
  fail(`Plan(s) ${unscopedPlans.map((p) => p.key).join(', ')} are in ENROLLMENT_PLANS_FALLBACK but have no PLAN_ENTITLEMENTS entry. Add one in src/lib/planCatalog.js — an unlisted plan now FAILS CLOSED (Home only), it does not get full access.`);
}
scopeSection += '- **Admins, and legacy members with no plan key on file**: full toolkit access.\n';
scopeSection += '- **A retired or unrecognized plan key** (e.g. a membership that is no longer sold): Home only. The member keeps their Dashboard and membership panel and is asked to renew or upgrade — it does NOT grant the full toolkit.\n';

const tipsSection = TIPS.map((t) => `- ${t}`).join('\n');

const TOOL_COUNT = routeIds.filter((id) => !['dashboard', 'accessrequests', 'enrollments'].includes(id)).length;
const generatedOn = new Date().toISOString().slice(0, 10);

const doc = `<!-- GENERATED FILE — do not hand-edit. Regenerate with \`npm run ai:knowledge\`
     (scripts/generate-voice-agent-knowledge.mjs). Generated: ${generatedOn} -->

# Toolkits by Alex — Voice Assistant Knowledge

This document is the product knowledge for the in-app voice assistant of **Ultimate
Remote Bookkeeper Toolkits ("Get Hired With Alex")** — a web app for aspiring and working
remote bookkeepers serving US clients, built by Coach Alex Sagun. It describes the app as
students and admins experience it. Sidebar labels can be renamed by an admin, so a tool's
visible name may occasionally differ slightly from the label listed here; tab ids and URL
paths never change.

## 1. App overview

- The toolkit bundles **${TOOL_COUNT} tools** across three career stages: **01 Training &
  Skills** (build your foundation), **02 Job Application** (land US clients), and
  **03 Client Management & Delivery** (onboard, operate, close the year), plus a Home
  dashboard.
- Many tools are AI-assisted (proposal writing, bank-feed categorization, statement
  conversion, SOPs); the rest (calculators, checklists, templates, Chart of Accounts)
  work fully offline.
- Users sign in with email/password (Supabase). The whole app sits behind a login; new
  accounts go through enrollment (payment) before reaching the toolkit.
- The app is a single-page app — the sidebar lists the stages and tools, and each tool is
  a "tab". The assistant can navigate to any tool with the \`navigate_to_tool\` client
  tool and open account panels with \`open_account_panel\`.

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
${navSection}
Special sub-sections of Job Interview Mastery (tab \`interview\`): winning-strategy
courses (\`winstrat\`), mock interview simulator (\`mock\`), common questions
(\`common\`), accounting questions (\`accounting\`), body language (\`body\`), JD
question generator (\`jdgen\`), and salary negotiation (\`salary\`).

## 4. Subscription plans, pricing, and entitlements

All prices are **fixed Philippine-peso (₱) bank-transfer amounts** — never convert them
to USD.

${plansTable}
**What each plan can open (entitlement scope):**

${scopeSection}
Important nuance: the **Sampler Session is the only plan with limited course access** —
its ₱ price buys a live Zoom session and a 1-on-1 coaching booking, not the full course
library. It opens QuickBooks Online **Essentials** only, not Mastery. Both other plans
open every student tool.

A tool outside the user's plan still shows a polite upgrade page if opened — nothing
breaks. The assistant may navigate there and then suggest upgrading.

## 5. Membership lifecycle (expiry, grace, renew / extend / upgrade)

- Approval of a payment grants a **dated term**: plan \`access_days\` (60 or 180 days)
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

- Course catalogs: **QuickBooks Online Mastery** (\`qbomastery\` — QuickBooks Online
  Essentials and Mastery programs), **Resume Winning Strategy** (\`resumestrategy\`), and
  the interview winning-strategy catalog inside Job Interview Mastery.
- Courses are video courses with modules and lessons; per-user progress is saved across
  devices. Completing **every lesson** in a course unlocks a downloadable **PDF
  certificate**.
- **Zoom Live Replay:** some lessons also carry a link to the recording of that lesson's
  live session. It sits **below the lesson content and above "Mark complete"**, and opens
  in a **new browser tab** — Zoom recording pages cannot play inside the app. It is
  **supplementary**: it never replaces the lesson video, and watching it is **not**
  tracked — only "Mark complete" moves progress or unlocks the certificate. Not every
  lesson has one. The assistant cannot list, open, or read out replay links (it has none
  of them) — direct the member to open the lesson and look for the replay card.
- The QuickBooks catalog has two tiers: **Essentials** (available to Sampler members) and
  **Mastery** (standard tier). Other plans with QuickBooks access read both.
- **Accounting 101** (\`course\`) is the free-form foundational course with 8 modules.
- **AI course trainer:** enrolled members can ask the assistant to **teach, explain, quiz,
  practice, or recap** their included courses. Course material is fetched through secure
  training tools that re-check the member's live plan on every request — the assistant
  must ALWAYS use \`get_my_training_catalog\` / \`get_authorized_training_context\` for
  course content and never teach paid material from memory or from this document (which
  deliberately contains **no** course content). If a course isn't in the member's plan,
  the tools return a polite denial with upgrade options.

## 8. Common questions (FAQ)

- **"Where is QuickBooks Online Mastery?"** → Training & Skills stage → navigate to
  \`qbomastery\`.
- **"When does my access expire?"** → use \`get_user_membership_summary\`; the Dashboard
  membership panel and Profile & Settings also show it.
- **"How do I upgrade / renew / extend?"** → open the \`upgrade\`, \`renew\`, or
  \`extend\` account panel (members only).
- **"What's included in my plan?"** → \`get_user_membership_summary\` gives the scope;
  section 4 has the details.
- **"How do I use Bank Feed AI?"** → navigate to \`bankfeed\`: paste the raw bank-feed
  memo, AI suggests the vendor and QuickBooks category; always review before posting.
- **"Where do I practice interviews?"** → \`interview\` (Job Interview Mastery); the mock
  interview simulator is its second sub-tab (watch the guide video to unlock the launch
  button).
- **"What should I do first as a beginner?"** → start with Accounting 101 and QuickBooks
  Online Mastery in Training & Skills, take the Niche Selector Quiz, then move to the Job
  Application stage (Authentic Branding → Resume → Interview prep).
- **"Show me the resume course."** → navigate to \`resumestrategy\`.
- **"Book a session with Alex."** → \`linkedinopt\` (1-on-1 profile optimization) or
  \`coachalex\` (personalized coaching).

## 9. Bookkeeping tips the coach repeats

${tipsSection}

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
`;

// ── --check: drift guard (writes nothing) ─────────────────────────────────────
// Rebuilds the doc in memory and diffs it against the committed file, ignoring the
// volatile Generated-date stamp. Exit 1 on drift so a tools/plans change can never
// silently leave the static product guide stale (see "Keeping docs current" in CLAUDE.md).
if (process.argv.includes('--check')) {
  const stripStamp = (s) => String(s).replace(/Generated: \d{4}-\d{2}-\d{2}/g, 'Generated: <date>').replace(/\r\n/g, '\n');
  const onDisk = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (stripStamp(onDisk) !== stripStamp(doc)) {
    console.error('[ai:knowledge] DRIFT: docs/ai/toolkits-voice-agent-knowledge.md no longer matches the code.');
    console.error('[ai:knowledge] Run `npm run ai:knowledge` (and `npm run ai:knowledge:push` when deployed) in the same change.');
    process.exit(1);
  }
  console.log('[ai:knowledge] Check passed — the knowledge doc matches the code.');
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, doc, 'utf8');
console.log(`[ai:knowledge] Wrote ${OUT}`);
console.log(`[ai:knowledge] ${routeIds.length} tabs, ${ENROLLMENT_PLANS_FALLBACK.length} plans, ${TIPS.length} tips. Generated ${generatedOn}.`);
