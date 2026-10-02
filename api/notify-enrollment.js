// Vercel serverless function — emails for the manual enrollment/payment workflow.
// OPTIONAL + env-gated like api/notify-access.js: if RESEND_API_KEY / RESEND_FROM are
// not set, it responds { ok:false, skipped:'…' } and the in-app flow still works
// (the client treats email as best-effort). Secrets stay server-side — never the bundle.
//
// Four actions, selected by body.action:
//   'submitted' — a STUDENT just submitted payment proof → notify the admin, then confirm
//                 to the student. Auth: the caller's own JWT must be able to read the request
//                 row (RLS enroll_req_own_select proves ownership); the email content is
//                 built from the database, never from the request body. #69: the student's
//                 confirmation goes ONLY to the account address (profiles.email) — never the
//                 address typed on the request — and the package, its scope and the cohort
//                 come from the catalog. Every one of those reads is best-effort: none can
//                 block or skip the admin alert.
//   'decision'  — an ADMIN approved / rejected / expired a request → notify the student.
//                 Auth: requireStaff('enrollments.review'). The body names ONLY
//                 { requestId, status }; plan and reason are read from the request row and
//                 the RECIPIENT from the student's profile (never the request's typed
//                 email), both with the caller's JWT, and the send is refused unless
//                 `status` is the decision actually recorded (2026-09-24 — see the handler).
//                 #69: what an approval STATES (the package, the Manila day the term runs
//                 to, the cohort, Getting Started) comes from enrollment_decision_email_facts(),
//                 asked with the reviewer's JWT; if that read fails the generic copy is sent.
//                 Two burst guards: 10 sends a minute of ONE decision (EMAIL-1), and 60 a
//                 minute of one REVIEWER's decision emails, every decision together
//                 (EMAIL1-R1) — well above a bulk run's pace, which goes one row at a time.
//   'test'      — an ADMIN sends a sample admin alert to confirm config end-to-end.
//                 Auth: admin JWT (same gate as 'decision'). Returns { to, source }.
//   'import_onboarded' — a MIGRATED STUDENT (#67) has just set their password → email the
//                 administrator ("Student Successfully Onboarded") and the student (their
//                 account is ready). Auth: the student's own JWT, verified here. The body
//                 carries NOTHING: the service-only legacy_import_onboarding_notice(uid)
//                 reads every fact from that student's own import row, and 'sent' is final,
//                 so the admin inbox rings once per student. A failed try is handed back
//                 only when NEITHER email was delivered (#68, see onboardingFailure).
//                 Both emails use the migration addresses (#68, legacyClaimEmail.js's
//                 migrationAddresses): From MIGRATION_EMAIL_FROM, else support@<RESEND_FROM's
//                 domain>; Reply-To MIGRATION_REPLY_TO, else support@alexsagun.com.
//
// Admin-recipient resolution ('submitted' + 'test'), first valid email wins:
//   NOTIFY_ADMIN_EMAIL → payment_settings.notify_email → address inside RESEND_FROM.
// Student Reply-To ('submitted' confirmation + 'decision'), first valid email wins:
//   payment_settings.notify_email → NOTIFY_ADMIN_EMAIL → no Reply-To. NEVER RESEND_FROM
//   (studentReplyTo in api/_lib/email.js).
//
// Both 'submitted' emails and the 'decision' email go through the shared sendEmail() with a
// text part and a STABLE idempotency key (enrollment-submitted-admin-<id>,
// enrollment-submitted-student-<id>, enrollment-decision-<id>-<status>-<epoch ms of reviewed_at>),
// so a retry or a double click is one email, not two — while a decision made again (#66) is a
// new one. Only a provider 409 named "in progress" reads as another request's email to finish.
// The admin alert's outcome is recorded on the request row: 'sent', 'provider_error' (refused —
// nothing went out) or 'provider_unclear' (no clear answer — it may have gone out). 'test' stays
// on sendResend: it exists to show an admin the provider's own words.
//
// Env (Vercel → Settings → Environment Variables, Production + Preview):
//   RESEND_API_KEY        re_…  (server-only; do NOT VITE_-prefix)
//   RESEND_FROM           e.g. "Toolkits by Alex <noreply@yourdomain.com>"
//   NOTIFY_ADMIN_EMAIL    optional — where admin alerts go; if unset, falls back to the
//                         admin-editable payment_settings.notify_email, then to the
//                         address inside RESEND_FROM.
//   APP_URL               the app's absolute origin (e.g. https://toolkits.alexsagun.com),
//                         for the "Review in Enrollments" button and the sign-in links.
//                         ON VERCEL THERE IS NO FALLBACK: without it the emails carry no
//                         link. The request's own host is used only under `npm run dev`.
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY  reused for auth checks (already set).
//
// NOTE: Supabase Auth's SMTP/Resend settings power ONLY Supabase Auth emails (confirm,
//   reset) — NOT this function. These custom alerts need their own env vars above.
//   This DOES run under `npm run dev` — vite.config.js registers `notifyDevApi` for
//   /api/notify-enrollment. It still needs RESEND_* in .env, and Vite reads .env at
//   startup, so restart the dev server after adding keys.

import { phpAmount } from '../src/lib/planCatalog.js';
import { intakeSelectColumns, ENROLLMENT_PROCESSING_NOTE } from '../src/lib/enrollmentIntake.js';
import { tierLabelFor } from '../src/lib/trainingAgreement.js';
import { formatCalendarDate } from '../src/lib/legacyMigration.js';
import { requireStaff, service, serviceConfigured } from './_lib/staffAuth.js';
import { plainTextEmail, sendEmail, studentReplyTo } from './_lib/email.js';
import {
  firstNameOf, isAddress, manilaDateOf, migrationAddresses, onboardedAdminEmail, onboardedStudentEmail,
} from './_lib/legacyClaimEmail.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const BRAND = 'Toolkits by Alex';
const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ONBOARDING_VIDEO_ID = 'U78IBZwIr7U';
// The SAME formatter the pricing cards and the signed agreement use. It used to
// be a third private copy, and the three had already drifted (see phpAmount).
// planCatalog.js is pure, dependency-free ESM specifically so api/ can import it.
const php = (n) => phpAmount(n);
// A value as ONE line of trimmed text ('' for null/undefined): what a fact must be before it
// is printed. A name typed with a line break in it must not be able to break a Subject, or
// start a row of its own in the text part.
// ★ NEL (U+0085) IS NOT IN JS's \s — yet a renderer that honours Unicode's mandatory breaks
//   starts a line at it, so it is folded here by name (EMAIL-3). \s already covers CR, LF, VT,
//   FF and the LINE and PARAGRAPH SEPARATORs.
const clean = (v) => String(v == null ? '' : v).replace(/[\s\u0085]+/g, ' ').trim();

// ★ EVERY DATE AN EMAIL STATES IS THE MANILA CALENDAR DAY IT FALLS ON (#69). A term's
//   ends_at is an instant; read in UTC, access that runs to the end of November 30 in Manila
//   prints as "November 29". The students and the business share one timezone, and it is not
//   UTC. manilaDateOf()/formatCalendarDate() are the migration emails' pair — no Date locale,
//   so the same instant reads the same on every server.
const manilaDay = (value) => {
  const day = manilaDateOf(value);
  return (day && formatCalendarDate(day)) || null;
};
// The Manila clock time of an instant ("1:30 AM"). Only the alert's "Submitted" row uses it:
// the hour decides which business day a request belongs to. Asia/Manila is a fixed +08:00.
const manilaClock = (value) => {
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms + 8 * 60 * 60 * 1000);
  const hour = local.getUTCHours();
  return `${hour % 12 || 12}:${String(local.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};

// The app's own origin, for the links an email carries.
// ★ ON VERCEL IT IS APP_URL OR NOTHING (#69). This used to fall back to the request's Host
//   header everywhere — but a PREVIEW deployment shares production's database, so a request
//   served by one would email a real student (or the admin) a link to a throwaway preview.
//   The request's own host is trusted only where there is no Vercel at all: `npm run dev`.
function appOrigin(req) {
  const configured = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  return !process.env.VERCEL_ENV && req?.headers?.host ? `http://${req.headers.host}` : '';
}

// Branded HTML mirroring api/notify-access.js / the auth-email template.
// cta: optional { href, label } — a button after the rows table (intro is esc()'d,
// so links can't ride along in the text).
// note: optional trailing block — a string, or an ARRAY rendered one line per
// line. Each line is esc()'d. video: optional { id, label } — a
// YouTube thumbnail that links to the watch page. An <img> is used rather than an
// embed because no mail client plays an iframe, and a bare link gets ignored.
// rows: a row with no value is dropped (as plainTextEmail drops it), never a dangling label.
function emailHtml({ heading, intro, rows, reason, cta, note, video }) {
  const videoBlock = video?.id
    ? `<div style="margin:0 0 20px;padding:14px;border:2px solid #2563eb;border-radius:14px;background:#f0f5ff;text-align:center;">
        <div style="font-size:15px;font-weight:700;color:#1d4ed8;margin-bottom:10px;">▶ ${esc(video.label || 'Watch this first')}</div>
        <a href="https://www.youtube.com/watch?v=${esc(video.id)}" style="display:inline-block;text-decoration:none;"><img src="https://img.youtube.com/vi/${esc(video.id)}/hqdefault.jpg" alt="${esc(video.label || 'Watch the video')}" width="420" style="max-width:100%;border-radius:12px;border:0;display:block;" /></a>
      </div>`
    : '';
  const noteBlock = note
    ? `<p style="font-size:12.5px;line-height:1.6;color:#48505e;margin:0 0 16px;padding:12px 14px;background:#f4f7fb;border-radius:10px;">${(Array.isArray(note) ? note : [note]).map(esc).join("<br>")}</p>`
    : '';
  const shown = (rows || []).filter(([, v]) => v != null && String(v).trim() !== '');
  const rowsBlock = shown.length
    ? `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;color:#1c2430;">
        ${shown.map(([k, v]) =>
          `<tr><td style="padding:6px 10px;background:#f4f7fb;border:1px solid #e6ebf2;font-weight:600;white-space:nowrap;">${esc(k)}</td>
               <td style="padding:6px 10px;border:1px solid #e6ebf2;">${esc(v)}</td></tr>`).join('')}
      </table>`
    : '';
  const reasonBlock = reason
    ? `<div style="margin:0 0 20px;padding:12px 14px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:10px;font-size:13px;color:#7F1D1D;"><strong>Reason:</strong> ${esc(reason)}</div>`
    : '';
  const ctaBlock = cta?.href
    ? `<div style="margin:0 0 20px;text-align:center;">
        <a href="${esc(cta.href)}" style="display:inline-block;background:#0A84FF;color:#ffffff;border-radius:10px;padding:11px 22px;font-size:14px;font-weight:700;text-decoration:none;">${esc(cta.label || 'Open the app')}</a>
      </div>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f7fb;padding:32px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6ebf2;">
    <div style="background:linear-gradient(180deg,#3aa0ff,#0A84FF);padding:26px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">${esc(BRAND)}</h1>
    </div>
    <div style="padding:28px;color:#1c2430;">
      <h2 style="font-size:18px;margin:0 0 8px;">${esc(heading)}</h2>
      <p style="font-size:14px;line-height:1.6;color:#48505e;margin:0 0 20px;">${esc(intro)}</p>
      ${videoBlock}
      ${rowsBlock}
      ${reasonBlock}
      ${ctaBlock}
      ${noteBlock}
      <p style="font-size:12px;color:#8a93a3;margin:8px 0 0;">Thank you,<br/>The ${esc(BRAND)} team</p>
    </div>
  </div>
</div>`;
}

// ★ BOTH PARTS FROM ONE OBJECT (#69). Every email these actions send used to be HTML only —
//   a well-known spam signal, and no use to a client that shows text. The text part is built
//   by plainTextEmail() from the very object emailHtml() renders, so the two cannot state
//   different facts, and every link in the HTML is spelled out in the text.
const bothParts = (parts) => ({ html: emailHtml(parts), text: plainTextEmail(parts) });

// Resolve the caller's auth user (anon key + caller JWT). Null on any failure.
async function callerUser(authHeader) {
  if (!authHeader || !SUPABASE_URL || !SUPABASE_ANON) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return null;
    const u = await userRes.json();
    return u?.id ? { id: u.id, token } : null;
  } catch {
    return null;
  }
}

// The admin check moved to api/_lib/staffAuth.js in #45. It was a local
// callerAdminId() reading profiles.is_admin — one of four byte-identical copies —
// and reviewing payment proofs is now its own capability (enrollments.review), so
// an Operations Admin can work the queue without holding any other admin power.
//
// callerUser() above is KEPT and still used by the 'submitted' action, which is a
// STUDENT action: it proves ownership by re-fetching the request row with the
// caller's own JWT under RLS, and must not require any staff permission at all.

// Best-effort burst guard (per warm instance — the anthropic-proxy idiom): 10 a minute per KEY.
// Legit traffic is ~1 email per human action, so 10/min stops a runaway loop or a scripted
// burst from draining the Resend quota without touching real usage. 'submitted',
// 'import_onboarded' and 'test' key it on the caller; 'decision' keys it on the caller AND the
// decision (EMAIL-1, see that action): a reviewer's run of decisions is not a loop — and caps that
// run with a second, per-reviewer key at REVIEWER_DECISIONS_PER_WINDOW (EMAIL1-R1).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;
// ★ ONE REVIEWER'S DECISION EMAILS, EVERY DECISION TOGETHER (EMAIL1-R1). The per-decision guard cannot
//   bound a loop on its own: a decision's key carries the moment it was recorded, and that moment can be
//   re-minted at will — #48 grants enrollments.review holders UPDATE on reviewed_at, which #66's lock
//   leaves alone on a decided row — so every re-stamp is a "new" decision, a new key the provider has
//   never seen, and another email to the same student. 60 a minute sits well above a bulk run, which
//   goes one row at a time (the decision, then its email: about 1.5–3 s a row, so ≤ ~40 a minute); a
//   run that reaches it anyway is answered 429, which the Enrollments bulk run waits out and asks again.
const REVIEWER_DECISIONS_PER_WINDOW = 60;
const rateHits = new Map(); // a user id, "<user id>:<decision key>" or "decisions:<user id>" -> [timestamps]
function rateLimited(key, max = RATE_MAX_PER_WINDOW) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  if (rateHits.size > 500) {
    for (const [k, hits] of rateHits) {
      if (!hits.length || hits[hits.length - 1] < cutoff) rateHits.delete(k);
    }
  }
  const hits = (rateHits.get(key) || []).filter((t) => t >= cutoff);
  if (hits.length >= max) { rateHits.set(key, hits); return true; }
  hits.push(now);
  rateHits.set(key, hits);
  return false;
}

// Fetch the enrollment request WITH THE CALLER'S OWN JWT — RLS enroll_req_own_select
// returns the row only to its owner (or an admin), which is exactly the proof we need.
// notify_status rides along as the replay-dedup marker (see the 'submitted' handler);
// installs without the notify-status migration get a column error → retry without it,
// so pre-#16 databases keep working (same column-resilience pattern as the client).
// plan_key (#69) is on the base rung: the column is as old as the table, and it is what the
// catalog is looked up by — the row's own plan_name is a snapshot the student's client wrote.
// ★ receipt_path and the other file paths are deliberately NEVER selected: what is not read
//   cannot reach an email.
const OWN_REQUEST_COLS =
  'id,user_id,plan_key,plan_name,full_name,email,phone,city_country,amount_expected,amount_paid,payment_reference,created_at,status';
// #42's intake + agreement columns. Selected on the top rung only, so a database
// without the migration falls through to the shorter list rather than 400-ing —
// which would silence the admin alert entirely, the one email that matters.
// DERIVED from INTAKE_FIELDS, not hand-listed. A hand-written select list is a
// silent failure mode: a newly stored column simply reads as `undefined` here and
// its row vanishes from the admin alert, which looks exactly like a student who
// skipped a required question.
const INTAKE_COLS = [
  ...intakeSelectColumns(),
  'resume_path', 'agreement_version', 'agreement_tier',
].join(',');
// #20's request_kind / extension_days: what kind of request this is, and how many days an
// extension bought. Their OWN rung (#69), in the order the migrations landed — below batch_id
// (#32), above notify_status (#16) — so a database missing a later migration still says
// "Extension: 60 days" instead of guessing the kind from the student's history.
const KIND_COLS = 'request_kind,extension_days';
async function fetchOwnRequest(requestId, token) {
  // Each rung drops the newest migration's columns: the intake (#42), batch_id (#32),
  // the request kind (#20), notify_status (#16).
  for (const cols of [
    `${OWN_REQUEST_COLS},notify_status,${KIND_COLS},batch_id,${INTAKE_COLS}`,
    `${OWN_REQUEST_COLS},notify_status,${KIND_COLS},batch_id`,
    `${OWN_REQUEST_COLS},notify_status,${KIND_COLS}`,
    `${OWN_REQUEST_COLS},notify_status`,
    OWN_REQUEST_COLS,
  ]) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/enrollment_requests?id=eq.${encodeURIComponent(requestId)}` +
        `&select=${cols}`,
        { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) continue; // missing notify_status column → retry with the base list
      const rows = await r.json();
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch {
      return null;
    }
  }
  return null;
}

// The row a DECISION email is about, read with the reviewer's own JWT — so RLS, not this
// file, decides whether they may see it. Null on any failure: no row, no email.
// reviewed_at (#69, EMAIL-2) is the moment the decision was recorded: it is what makes a
// decision made again a new email (see the 'decision' action's key).
async function fetchDecidedRequest(requestId, token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/enrollment_requests?id=eq.${encodeURIComponent(requestId)}` +
      '&select=id,user_id,full_name,plan_name,status,rejection_reason,reviewed_at',
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// The ACCOUNT a decision email goes to — never enrollment_requests.email. The student
// writes that column at insert (enroll_req_own_insert checks only user_id, status and
// batch), so reading the recipient from it would let anyone who signs up file a request
// naming a third party's address and have a reviewer's decision mail the business's own
// branded email there. profiles.email is the address the account signed up with. Read
// with the reviewer's JWT: profiles_admin_select admits enrollments.review since #45.
//
// #69: 'submitted' reads the same row for the same reason — the student's confirmation goes
// to the account, never to the address typed on the request — with the STUDENT's JWT
// (own_profile_select: one's own row). There it is best-effort and passes `timeoutMs`, so a
// slow read costs the student copy, never the admin alert. 'decision' passes none: without
// the address there is no email to send, so there is nothing to hurry towards.
async function fetchAccountContact(userId, token, { timeoutMs = null } = {}) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON || !userId) return null;
  try {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=email,full_name`,
      {
        headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
        ...(limit ? { signal: AbortSignal.timeout(limit) } : {}),
      }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// ── The facts an email may state (#69) ────────────────────────────────────────────────
// ★ THE CATALOG NAMES THE PACKAGE; THE REQUEST ROW ONLY POINTS AT IT. enrollment_requests'
//   plan_name and amount_expected are snapshots the student's own client wrote at insert, so
//   an email built from them prints whatever a hand-made request says. The package's name,
//   tagline, price, length and scope are read from enrollment_plans by plan_key, and the
//   cohort from batches by batch_id — with the CALLER's JWT (enrollment_plans_read and
//   batches_read admit a signed-in student), never a service client.
//
// ★ EVERY ONE OF THESE READS IS BEST-EFFORT AND BOUNDED. Null means "could not be read": the
//   caller then falls back to the row's own value or drops the line. None of them may block,
//   delay past FACTS_TIMEOUT_MS, or skip the admin alert — the one email that decides whether
//   a payment is ever reviewed.
const FACTS_TIMEOUT_MS = 4_000;
async function readFirstRow(pathAndQuery, token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}
const fetchPlanFacts = (planKey, token) => (planKey
  ? readFirstRow(`enrollment_plans?key=eq.${encodeURIComponent(planKey)}`
    + '&select=key,name,tagline,price_php,access_days,entitlement_summary,community_segment', token)
  : Promise.resolve(null));
const fetchBatchFacts = (batchId, token) => (batchId
  ? readFirstRow(`batches?id=eq.${encodeURIComponent(batchId)}&select=name,code`, token)
  : Promise.resolve(null));

// The plan's scope as one line: its entitlement_summary chips ("60-day course access · …").
// There is no per-approval course selection, so THIS is what "the programs" means.
const planScope = (plan) => (Array.isArray(plan?.entitlement_summary)
  ? plan.entitlement_summary.map(clean).filter(Boolean).join(' · ')
  : '');
const packageLabel = (name, tagline) => (clean(tagline) ? `${name} (${clean(tagline)})` : name);

// What the DECISION email may state, from the database: enrollment_decision_email_facts()
// (#69), asked with the REVIEWER's own JWT — it is gated on enrollments.review, and it
// reads the request named on the row this handler has already verified.
//
// ★ ANY FAILURE IS "NO FACTS", NEVER A REFUSAL. A database without #69 (PGRST202), a 5xx, a
//   timeout, a dropped connection or an answer that is not about THIS request and THIS
//   decision all return null, and the email goes out with the generic copy. The decision was
//   recorded; a student is owed the news even when the detail cannot be read.
async function fetchDecisionFacts(requestId, status, token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/enrollment_decision_email_facts`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_request_id: requestId }),
      signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const facts = await r.json();
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
    // The row was read a moment ago; if it has been decided again since, these facts are
    // about another decision than the one this email announces.
    const about = facts.request;
    if (!about || clean(about.id).toLowerCase() !== clean(requestId).toLowerCase() || about.status !== status) return null;
    return facts;
  } catch {
    return null;
  }
}

// Best-effort "is this a renewal?" — any prior subscription row (caller's own JWT;
// RLS subscriptions_own_select). Failure or missing table just means "New enrollment".
//
// ★ BOUNDED, LIKE THE THREE READS IT IS AWAITED BESIDE. It used to wait as long as fetch
//   does — and 'submitted' awaits all four together, so this one read left open could hold
//   the admin alert until the function was killed, however well the others were limited.
//   Out of time is answered exactly as any other failure is: "New enrollment". That is a
//   label on an alert that still goes out — unlike resolveAdminRecipient's payment_settings
//   read, which 'submitted' deliberately does NOT bound, because giving up there changes
//   WHO is told.
async function callerHasSubscription(userId, token) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      {
        headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
      }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

// Best-effort audit stamp of the admin-alert outcome onto the request row, via the
// SECURITY DEFINER RPC record_enrollment_notification (owner-or-admin guard — the caller
// is the row's owner on a 'submitted' action). NEVER throws: recording the outcome must
// not block or fail the email response, exactly like the alert itself is best-effort.
// See db/2026-07-08-enrollment-notify-status.sql.
async function recordNotify(requestId, token, status, detail) {
  if (!requestId || !token || !SUPABASE_URL || !SUPABASE_ANON) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_enrollment_notification`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_request_id: requestId, p_status: status, p_detail: detail ?? null }),
    });
  } catch { /* best-effort — the audit stamp is non-fatal */ }
}

// Did the admin alert's send end WITHOUT a clear answer — so it may have been delivered although
// sendEmail reports a failure (#69, EMAIL-4)? An attempt that ran out of time or lost its
// connection ('resend_timeout', 'resend_failed' — sendEmail also reports a refusal that FOLLOWS
// such an attempt as that unclear code, #68 V4), a provider failure ('resend_5xx'), or a 409 that
// is not "in progress" — which, under this request's own key, means an alert for it already went
// out with other facts in it. Anything else is a refusal: nothing was sent.
const alertMayHaveGone = (out) => {
  const code = String(out?.code || '');
  return code === 'resend_timeout' || code === 'resend_failed' || code === 'resend_409' || /^resend_5\d\d$/.test(code);
};

// Extract the bare address out of a RESEND_FROM value ("Name <a@b.com>" → "a@b.com").
const fromAddress = (from) => (from ? (from.match(/<([^>]+)>/)?.[1] ?? from).trim() : '');

// Where should the 'submitted'/'test' admin alert go? Resolution order, first valid wins:
//   1. NOTIFY_ADMIN_EMAIL env         → source 'env'
//   2. payment_settings.notify_email  → source 'payment_settings'  (admin-editable in-app,
//      read with the CALLER'S JWT — student token for 'submitted', admin token for 'test';
//      both are `authenticated`, so RLS payment_settings_read `to authenticated using(true)`
//      passes. Best-effort: any failure/missing table just falls through.)
//   3. address inside RESEND_FROM      → source 'from'
// Returns { to, source }; { to:null, source:null } if nothing resolves to a valid email.
//
// `timeoutMs` bounds the payment_settings read. ★ ONLY 'import_onboarded' passes one (#68,
// R6): it asks AFTER reserving the student's notice, so a hung read would hold the
// reservation until the function is killed. 'submitted' and 'test' keep their unbounded read:
// on an abort the catch below falls through to RESEND_FROM's (typically no-reply) address,
// and a student's "new enrollment" alert delivered there reads as sent while nobody sees it.
//
// `notifyEmail` (#69) is what step 2's read found: the stored address when it is usable,
// null when the row was read (or could not be) and holds none. It is how 'submitted' gives
// the student copy its Reply-To WITHOUT reading payment_settings a second time — see
// studentReplyTo() in api/_lib/email.js. It is left undefined in step 1, where the row is
// never read; the env address answering for the ADMIN alert says nothing about what is stored.
async function resolveAdminRecipient(token, { timeoutMs = null } = {}) {
  const envTo = process.env.NOTIFY_ADMIN_EMAIL;
  if (isEmail(envTo)) return { to: envTo, source: 'env' };

  if (token && SUPABASE_URL && SUPABASE_ANON) {
    try {
      const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/payment_settings?key=eq.notify_email&select=value`,
        {
          headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
          ...(limit ? { signal: AbortSignal.timeout(limit) } : {}),
        }
      );
      if (r.ok) {
        const rows = await r.json();
        const val = Array.isArray(rows) && rows[0]?.value;
        if (isEmail(val)) return { to: val, source: 'payment_settings', notifyEmail: val };
      }
    } catch { /* best-effort — fall through to RESEND_FROM */ }
  }

  const fromTo = fromAddress(process.env.RESEND_FROM);
  if (isEmail(fromTo)) return { to: fromTo, source: 'from', notifyEmail: null };

  return { to: null, source: null, notifyEmail: null };
}

// 'import_onboarded' only: its payment_settings read happens while a notice is reserved.
const ADMIN_RECIPIENT_TIMEOUT_MS = 3_000;

// An onboarding-notice email that PROVES it was not delivered: the provider refused this
// request outright (any 4xx but 409, which can mean the same key is still being processed),
// or it never left this server. sendEmail reports a refusal that follows an unanswered
// attempt as 'resend_timeout' (#68, V4), so a 4xx here is the only answer there was.
const NOT_DELIVERED_CODES = new Set(['email_not_configured', 'email_from_not_configured', 'email_incomplete', 'recipient_invalid']);
const provenNotDelivered = (code) =>
  NOT_DELIVERED_CODES.has(code) || (/^resend_4\d\d$/.test(String(code || '')) && code !== 'resend_409');

/**
 * What to record when the two onboarding emails did not both go out (#68, V2 + S2).
 *
 * ★ A TRY IS HANDED BACK ONLY WHEN NEITHER EMAIL WAS DELIVERED. legacy_import_onboarding_notice
 *   refunds the reservation for a refusal that says nothing about the student (key, sender,
 *   quota, configuration) — but when one of the two emails WAS delivered, a refund lets every
 *   later session send both again, and once Resend's 24-hour idempotency window has passed the
 *   delivered one rings again: the owner's "Student Successfully Onboarded", or the student's
 *   "account ready", about once a day for as long as the other half keeps failing. So:
 *     • one delivered, one not      → 'failed' with NO code: the try is consumed, as in #67,
 *                                     and the five-try cap bounds the repeats;
 *     • neither delivered, and both
 *       answers prove it            → 'failed' with the admin email's code, which the database
 *                                     may refund;
 *     • neither delivered, but one
 *       may have gone out anyway    → 'failed' with THAT unclear code (a timeout, a 5xx, a
 *                                     409), which the database never refunds.
 */
function onboardingFailure(adminOut, studentOut) {
  if (adminOut.ok || studentOut.ok) return { p_result: 'failed' };
  if (provenNotDelivered(adminOut.code) && provenNotDelivered(studentOut.code)) {
    return { p_result: 'failed', p_code: adminOut.code };
  }
  return { p_result: 'failed', p_code: provenNotDelivered(adminOut.code) ? studentOut.code : adminOut.code };
}

// ── The decision email (#69) ──────────────────────────────────────────────────────────
// What an APPROVAL may say about the term it granted. Null means "state nothing about it".
//
// ★ ONLY A TERM THAT IS LIVE, OR STILL TO COME, IS STATED. enrollment_decision_email_facts()
//   returns the subscription that carries the request, whatever has become of it since: a
//   later approval supersedes it (status 'expired'), a revert cancels it, and a Super Admin
//   can re-announce an old decision after its term has run out. "Active until" a day that
//   has passed, or that a newer term has replaced, is a false statement — so anything other
//   than an active or scheduled term whose end is still ahead says nothing at all.
// ★ NOT OPEN YET IS ITS OWN ANSWER. A scheduled term (#67), or an active row whose start is
//   still ahead of the clock, grants nothing today: the copy may say when access opens, and
//   must not say or imply that it is open.
function grantedTerm(facts, nowMs) {
  const term = facts?.term;
  if (!term || (term.status !== 'active' && term.status !== 'scheduled')) return null;
  const endMs = term.ends_at == null ? null : Date.parse(String(term.ends_at));
  if (endMs !== null && !(endMs > nowMs)) return null;   // lapsed, or not a timestamp at all
  const startMs = Date.parse(String(term.started_at));
  return {
    opensLater: term.status === 'scheduled' || (Number.isFinite(startMs) && startMs > nowMs),
    start: manilaDay(term.started_at),
    end: endMs === null ? null : manilaDay(term.ends_at),   // a term with no end date: no date
  };
}

/**
 * The email a reviewer's decision sends — subject, HTML and text.
 *
 * @param {object} o
 * @param {'approved'|'rejected'|'expired'} o.status  the decision RECORDED on the row
 * @param {string|null} o.fullName
 * @param {string|null} o.planName   the row's own snapshot, used when the facts name no plan
 * @param {string|null} o.reason     the row's rejection_reason (never an approval's)
 * @param {object|null} [o.facts]    enrollment_decision_email_facts()'s answer; null = the generic copy
 * @param {boolean} [o.canReply]     is there a Reply-To on this message?
 * @param {string} [o.appUrl]        the app's origin, or '' for no link
 * @param {number} o.nowMs
 */
function decisionEmail({ status, fullName, planName, reason, facts = null, canReply = false, appUrl = '', nowMs }) {
  // A name that is really an address is never echoed as a greeting. It happens: the paywall
  // stores the account's email as the request's full_name when no name was typed, so an
  // account with a blank profile name arrives here named by its own address. The student's
  // confirmation (firstNameOf) and api/notify-access.js already greet nobody in that case.
  const name = clean(fullName);
  const hi = name && !name.includes('@') ? `Hello ${name},` : 'Hello,';
  // The CATALOG's name for the package when the database told us; else the row's snapshot.
  const plan = clean(facts?.plan?.name) || clean(planName) || 'your selected package';
  const signIn = (label) => (appUrl ? { href: `${appUrl}/`, label } : undefined);

  if (status === 'approved') {
    const term = grantedTerm(facts, nowMs);
    const opensLater = Boolean(term?.opensLater);
    // ★ NEVER "EVERYTHING IS UNLOCKED". That sentence went to every approved student, and it
    //   is false for Essentials, which opens one course. The email now states what the
    //   database says was granted — the package and the day it runs to — and, when the
    //   facts could not be read, only that the enrollment is approved.
    let intro = `${hi} your payment for ${plan} has been verified and your enrollment is approved.`;
    if (opensLater) {
      intro += term.start ? ` Your access opens on ${term.start}.` : ' Your access is not open yet.';
    } else {
      if (term?.end) intro += ` Your ${plan} access is active until ${term.end}.`;
      // Whether Getting Started comes next is the SERVER's answer (#69), and only the
      // boolean `true` counts: a truthy string is not a fact.
      intro += facts?.getting_started_required === true
        ? ' When you next sign in, you will be guided through Getting Started — a welcome video to watch before your dashboard opens.'
        : ` Sign in to ${BRAND} to continue.`;
    }
    // An extension bought DAYS, so it states them; the plan's own scope line ("60-day course
    // access") would read as a second, different length beside the date above.
    const extensionDays = facts?.request?.kind === 'extension' ? Number(facts.request.extension_days) : 0;
    const scope = planScope(facts?.plan);
    const rows = term ? [
      ['Package', packageLabel(plan, facts?.plan?.tagline)],
      ...(extensionDays > 0 ? [['Extension', `${extensionDays} days`]] : [['Program access', scope]]),
      ['Cohort', clean(facts?.batch?.name)],       // a VIP-only fact: null for every other plan
      ...(opensLater
        ? [['Access opens', term.start], ['Access until', term.end]]
        : [['Active until', term.end]]),
    ] : [];
    return {
      subject: `Your ${BRAND} Enrollment Is Approved 🎉`,
      ...bothParts({
        heading: opensLater ? 'Payment verified — your enrollment is approved' : 'Payment verified — you’re in!',
        intro,
        rows,
        // No sign-in button for a membership that is not open: it would be the one thing in
        // the email that says "come in".
        cta: opensLater ? undefined : signIn(`Sign in to ${BRAND}`),
      }),
    };
  }

  // ★ A REJECTED OR EXPIRED DECISION STATES NO TERM AT ALL — whatever the facts carry. A
  //   request a Super Admin reopened and then declined (#66) still has the subscription it
  //   once granted, and the facts function returns it; an email saying "rejected" beside
  //   "active until…" would be read as both. Only the package's name is taken from the facts.
  if (status === 'expired') {
    return {
      subject: `Your ${BRAND} Enrollment Request Expired`,
      ...bothParts({
        heading: 'Enrollment request expired',
        intro: `${hi} your enrollment request for ${plan} was not completed within the review window and has expired. You can log in and resubmit your payment proof anytime.`,
        reason,
        cta: signIn('Sign in to resubmit'),
      }),
    };
  }
  return {
    subject: `Your ${BRAND} Enrollment Needs Another Look`,
    ...bothParts({
      heading: 'Payment proof update',
      // "Just reply to this email" is a promise only a Reply-To can keep: without one the
      // reply lands in RESEND_FROM's (typically no-reply) mailbox, so the sentence is dropped.
      intro: `${hi} we couldn’t verify your payment for ${plan} yet. Please log in and resubmit your payment proof${reason ? ' — the reason is below' : ''}.${canReply ? ' If you believe this was a mistake, just reply to this email.' : ''}`,
      reason,
      cta: signIn('Sign in to resubmit'),
    }),
  };
}

// Sends via Resend and NEVER attaches receipts (financial docs stay private — email only
// links the admin to the dashboard). On failure returns a short, non-secret `detail` slice of
// the provider response for diagnostics; only the admin-gated 'test' action surfaces it.
async function sendResend(apiKey, from, to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const text = await r.text();
  if (!r.ok) {
    // Status only: the body carries the addresses this handler exists to keep private, and a
    // deployment log is not the place for them. Read the detail from the admin 'test' action.
    console.error(`[notify-enrollment] resend ${r.status}`);
    return { ok: false, status: r.status, detail: text.slice(0, 300) };
  }
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON success body — fine */ }
  return { ok: true, id: data?.id };
}

// ── What was submitted (#69) ──────────────────────────────────────────────────────────
// The four kinds a request can be (enrollment_requests.request_kind, #20), and what each
// reads as: the alert's Type row and heading, and the student's subject and opening line.
// The alert used to know two — "New enrollment" and "Renewal" — and called an upgrade or a
// paid extension a renewal.
const SUBMITTED = {
  new: {
    type: 'New enrollment', heading: 'New enrollment payment proof 💸', what: 'payment proof',
    subject: 'Enrollment received',
    intro: 'Your enrollment is in, and Coach Alex is reviewing it now. You will hear back with your next steps and course access — see the processing hours below.',
  },
  renewal: {
    type: 'Renewal', heading: 'Membership renewal payment proof 🔄', what: 'a renewal payment',
    subject: 'Renewal received',
    intro: 'Your renewal payment is in and Coach Alex is reviewing it now. Your access continues once it is verified — see the processing hours below.',
  },
  upgrade: {
    type: 'Upgrade', heading: 'Plan upgrade payment proof ⬆️', what: 'an upgrade payment',
    subject: 'Upgrade request received',
    intro: 'Your upgrade payment is in and Coach Alex is reviewing it now. Your new package applies once it is verified — see the processing hours below.',
  },
  extension: {
    type: 'Extension', heading: 'Access extension payment proof ⏳', what: 'an extension payment',
    subject: 'Extension request received',
    intro: 'Your extension payment is in and Coach Alex is reviewing it now. The extra days are added once it is verified — see the processing hours below.',
  },
};
// A kind the row RECORDS as something other than a first enrollment. 'new' is also the
// column's default — every request filed before #20 reads 'new' — so it is not evidence, and
// the renewal inference below still speaks for it (the Enrollments card's kindOf() rule).
const recordedKind = (row) => (['renewal', 'upgrade', 'extension'].includes(row?.request_kind) ? row.request_kind : null);

export default async function handler(req, res) {
  const hasKey = Boolean(process.env.RESEND_API_KEY);

  // Health check (no email, no auth) — visit /api/notify-enrollment in a browser.
  // `adminRecipient` is ENV-ONLY: the anon GET can't read payment_settings (RLS is
  // `to authenticated`), so a 'none' here can STILL resolve at send time via
  // payment_settings.notify_email. Reports the source string only — never the address.
  if (req.method === 'GET') {
    const adminRecipient = isEmail(process.env.NOTIFY_ADMIN_EMAIL)
      ? 'env'
      : (isEmail(fromAddress(process.env.RESEND_FROM)) ? 'from' : 'none');
    return res.status(200).json({
      ok: true,
      hasKey,
      hasFrom: Boolean(process.env.RESEND_FROM),
      adminRecipient,
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body?.action;

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (action === 'submitted') {
    // Student → admin alert. Ownership proven by fetching the row with the caller's JWT.
    const u = await callerUser(req.headers?.authorization);
    if (!u) return res.status(403).json({ error: 'Authorization required.' });
    if (rateLimited(u.id)) {
      return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute and try again.' });
    }
    const requestId = body?.requestId;
    if (!requestId) return res.status(400).json({ error: 'requestId required.' });
    const row = await fetchOwnRequest(requestId, u.token);
    if (!row) return res.status(403).json({ error: 'Request not found or not yours.' });
    // Only alert for a live submission — refuse to re-fire "new submission" for an already
    // approved/rejected/expired row (limits replay of the admin alert for a decided request).
    if (row.status !== 'pending_review') {
      return res.status(200).json({ ok: false, skipped: 'not_pending_review' });
    }
    // Replay dedup: once the alert for THIS row was delivered, refuse to send it again —
    // otherwise a caller could re-POST the same requestId and spam the admin inbox / burn
    // Resend quota. Only the terminal 'sent' stamp skips; failure states (provider_error,
    // provider_unclear, email_not_configured, admin_email_invalid) stay retryable so a
    // transient outage never permanently silences a request's alert — and a retry under this
    // request's key is de-duplicated by the provider if the alert did go out. Resubmits insert
    // NEW rows (null notify_status), so legitimate flows are unaffected.
    if (row.notify_status === 'sent') {
      return res.status(200).json({ ok: false, skipped: 'already_notified' });
    }

    // Env-gated: not configured → non-fatal skip (submission already succeeded client-side).
    // Each skip is stamped onto the row so the Enrollments tab shows WHY no email went out.
    if (!apiKey) {
      await recordNotify(requestId, u.token, 'email_not_configured');
      return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    }
    if (!from) {
      await recordNotify(requestId, u.token, 'email_from_not_configured');
      return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });
    }
    // Recipient: NOTIFY_ADMIN_EMAIL → payment_settings.notify_email → address in RESEND_FROM.
    // `notifyEmail` is what that one read found: the student copy's Reply-To reuses it.
    const { to: adminTo, notifyEmail } = await resolveAdminRecipient(u.token);
    if (!isEmail(adminTo)) {
      await recordNotify(requestId, u.token, 'admin_email_invalid');
      return res.status(200).json({ ok: false, skipped: 'admin_email_invalid' });
    }

    // Direct review link to THIS request (#69; it used to open the queue): APP_URL, or under
    // `npm run dev` the local origin. On Vercel without APP_URL there is no link at all.
    const appUrl = appOrigin(req);

    // ── What the two emails may state (#69) ──────────────────────────────────────────
    // Four best-effort reads, side by side, all with the caller's own JWT: whether this
    // student has had a term before, the ACCOUNT behind the request, the package from the
    // catalog, and the cohort they picked. Each is cut off at FACTS_TIMEOUT_MS and answers
    // "not known" (false for the first, null for the rest) when it cannot be read; then the
    // row's own value stands in or the line is dropped — the alert goes either way.
    const recorded = recordedKind(row);
    const [hadTerm, account, plan, batch] = await Promise.all([
      recorded ? false : callerHasSubscription(row.user_id, u.token),
      fetchAccountContact(row.user_id, u.token, { timeoutMs: FACTS_TIMEOUT_MS }),
      fetchPlanFacts(row.plan_key, u.token),
      fetchBatchFacts(row.batch_id, u.token),
    ]);
    const kind = recorded || (hadTerm ? 'renewal' : 'new');
    const submitted = SUBMITTED[kind];
    const isExtension = kind === 'extension';
    const extensionDays = isExtension && Number(row.extension_days) > 0 ? Number(row.extension_days) : 0;

    // ★ THE ACCOUNT, NOT THE FORM. enrollment_requests.email and .full_name are whatever the
    //   student's client wrote at insert (enroll_req_own_insert checks user_id, status and
    //   batch — nothing else), so a request can name a stranger. profiles.email is the
    //   address the account signed up with: it is the only one the student copy is ever sent
    //   to, and the one the alert calls "Email". What was typed on the form is shown beside
    //   it, labelled as that, only when it differs — and when the account could not be read
    //   the typed address is STILL labelled as typed, never promoted to "Email".
    const accountEmail = isEmail(clean(account?.email)) ? clean(account.email) : null;
    const accountName = clean(account?.full_name);
    const typedEmail = clean(row.email);
    const typedName = clean(row.full_name);
    const studentName = accountName || typedName || 'A student';
    const differs = (a, b) => a.toLowerCase() !== b.toLowerCase();

    // The package as the CATALOG names it; the row's snapshot only when the catalog could
    // not be read. VIP-ness is the plan's community_segment — never its key (#68).
    const planName = clean(plan?.name) || clean(row.plan_name) || 'Package';
    const scope = planScope(plan);
    // The cohort line. A batch on a request is the student's PICK: approval confirms it or
    // sets another (admin_finalize_enrollment), hence "confirmed at approval". With none, a
    // member renewing or extending keeps the cohort they hold; a new VIP enrollment, or an
    // upgrade into VIP, has none to keep. What cannot be read is not guessed: no line.
    const cohort = !plan ? null
      : plan.community_segment !== 'vip' ? 'No batch cohort'
      : !row.batch_id
        ? (kind === 'renewal' || isExtension ? 'Current cohort continues (set at approval)' : 'Not chosen — assigned at approval')
        : (clean(batch?.name) ? `${clean(batch.name)} — confirmed at approval` : null);
    const submittedDay = manilaDay(row.created_at);
    const submittedAt = submittedDay && manilaClock(row.created_at)
      ? `${submittedDay} · ${manilaClock(row.created_at)} (Manila time)`
      : submittedDay;

    // The tier's HEADING — the package title the student signed under — never its internal
    // key: "Signed as SAMPLER" named the retired product beside the new agreement version
    // (#68, L3). An unknown key prints no tier at all rather than the raw key.
    const agreementTier = row.agreement_tier ? (tierLabelFor(row.agreement_tier) || null) : null;

    const { subject, html, text } = {
      subject: `${submitted.type} submitted — ${studentName} · ${planName}`,
      ...bothParts({
        heading: submitted.heading,
        intro: `A student just submitted ${submitted.what}. Review it in the app: sidebar → Enrollments.`,
        rows: [
          ['Type', extensionDays ? `Extension: ${extensionDays} days` : submitted.type],
          ['Student', studentName],
          ...(accountName && typedName && differs(accountName, typedName) ? [['Name on form', typedName]] : []),
          ['Email', accountEmail],
          ...(typedEmail && (!accountEmail || differs(accountEmail, typedEmail)) ? [['Contact email on form', typedEmail]] : []),
          ['Phone', row.phone || '—'],
          ['Location', row.city_country || '—'],
          ['Package', packageLabel(planName, plan?.tagline)],
          // An extension is priced by its days, not by the package: for one, the catalog's
          // price and length are not this request's, and only "Expected" below is. Nor is the
          // scope line — its chips open with the plan's OWN length ("60-day course access"),
          // which beside "Extension: 90 days" reads as a second, different duration. The
          // decision email drops the same line for the same reason (decisionEmail above).
          ...(plan && !isExtension && plan.price_php != null ? [['Package price', php(plan.price_php)]] : []),
          ...(plan && !isExtension && Number(plan.access_days) > 0 ? [['Access', `${Number(plan.access_days)} days`]] : []),
          ...(!isExtension ? [['Program access', scope]] : []),
          ['Cohort', cohort],
          ['Expected', php(row.amount_expected)],
          ['Paid / sent', php(row.amount_paid)],
          ['Submitted', submittedAt],
          // The paywall no longer asks for a reference (it is legible on the receipt),
          // but Extend Access still collects one — so show it when there is one
          // rather than dropping the field for the path that still uses it.
          ...(row.payment_reference ? [['Reference', row.payment_reference]] : []),
          // #42 intake. Each line is omitted when absent, so a pre-intake row
          // (or a partially migrated database) simply produces the shorter email
          // it always did rather than a column of dashes.
          ...(row.college_course ? [['Course', row.college_course]] : []),
          ...(row.current_job ? [['Current role', row.current_job]] : []),
          ...(row.ph_experience ? [['PH experience', row.ph_experience]] : []),
          ...(row.us_experience ? [['US/AU/UK experience', row.us_experience]] : []),
          ...(row.currently_employed ? [['Employed', row.currently_employed]] : []),
          ...(row.prior_training ? [['Prior QBO/Xero training', row.prior_training]] : []),
          ...(row.referred_by ? [['Referred by', row.referred_by]] : []),
          ...(row.intake?.facebook_link ? [['Facebook', row.intake.facebook_link]] : []),
          ...(row.intake?.struggles ? [['Three struggles', row.intake.struggles]] : []),
          ...(row.agreement_version
            ? [['Agreement', `Signed${agreementTier ? ` as ${agreementTier}` : ''} · v${row.agreement_version}`]]
            : []),
          ...(row.resume_path ? [['Resume', 'Attached — open it from Enrollments']] : []),
        ],
        cta: appUrl ? { href: `${appUrl}/admin/enrollments?request=${row.id}`, label: 'Review in Enrollments' } : undefined,
      }),
    };

    // Student confirmation. Best-effort, and deliberately NOT recorded in
    // notify_status — that column answers "was the admin alerted?", which is what
    // decides whether a payment ever gets reviewed. Conflating the two would let a
    // bounced student copy mark the admin alert failed and trigger a resend loop.
    //
    // ★ Sent AFTER the admin alert, and only once it has succeeded. Resend allows
    //   2 requests/second, so two back-to-back sends from one invocation put the
    //   429 risk on whichever goes second — and that must never be the admin one.
    //   Gating on success also stops a retry after `provider_error` sending the
    //   student a second "Enrollment received" for the same submission.
    //
    // ★ TO THE ACCOUNT ADDRESS OR TO NOBODY (#69). It used to go to row.email — the address
    //   typed on the request — so any signed-in account could have this branded email
    //   delivered to a stranger. With no readable account address there is no student copy:
    //   falling back to the typed one would reopen exactly that.
    // Returns what happened to it ('sent', a provider code, or why it was not attempted).
    const sendStudentCopy = async () => {
      if (!accountEmail) return 'no_account_address';
      try {
        // Where a reply goes: the address the alert's own read found, else NOTIFY_ADMIN_EMAIL,
        // else nowhere — never RESEND_FROM. (Only when NOTIFY_ADMIN_EMAIL answered for the
        // alert was the stored address not read; then it is read here, once, with a limit.)
        const replyTo = await studentReplyTo(u.token, { stored: notifyEmail });
        // A name that is really an email address (the form falls back to one) is not a greeting.
        const first = firstNameOf(accountName || typedName) || 'future QBO pro';
        const copy = bothParts({
          heading: kind === 'new' ? `Welcome, ${first}` : `Thanks, ${first}`,
          intro: submitted.intro,
          // Onboarding instructions are for new students. Someone six months in
          // does not need to be welcomed and told how to start.
          ...(kind === 'new' ? { video: { id: ONBOARDING_VIDEO_ID, label: 'Watch this first: your onboarding instructions' } } : {}),
          rows: [
            ['Package', planName],
            ...(extensionDays ? [['Extension', `${extensionDays} days`]] : []),
            ['Amount sent', php(row.amount_paid)],
            ...(row.agreement_version ? [['Training Agreement', 'Signed and on file']] : []),
          ],
          // The SAME constant the pending screen renders, so what a student
          // reads on screen and what lands in their inbox cannot diverge.
          note: ENROLLMENT_PROCESSING_NOTE,
        });
        const sentCopy = await sendEmail({
          to: accountEmail, subject: `${submitted.subject} — Get Hired with Alex`, html: copy.html, text: copy.text,
          replyTo: replyTo || undefined, idempotencyKey: `enrollment-submitted-student-${row.id}`,
          tag: 'notify-enrollment', timeoutMs: 10_000, maxAttempts: 2,
        });
        if (!sentCopy.ok) console.warn(`[notify-enrollment] student confirmation: ${sentCopy.code}`);
        return sentCopy.ok ? 'sent' : sentCopy.code;
      } catch (studentErr) {
        // The error's name only: nothing here may put an address in a deployment log.
        console.warn(`[notify-enrollment] student confirmation failed: ${studentErr?.name || 'error'}`);
        return 'failed';
      }
    };

    try {
      // ★ ONE KEY PER REQUEST (#69). The alert is keyed on the request's id, so a second
      //   POST for the same submission — a retry after a dropped connection, a double fire —
      //   repeats the SAME provider request and is de-duplicated there, instead of ringing
      //   the admin's inbox twice.
      const out = await sendEmail({
        to: adminTo, subject, html, text, idempotencyKey: `enrollment-submitted-admin-${row.id}`,
        tag: 'notify-enrollment', timeoutMs: 10_000, maxAttempts: 2, classify409: true,
      });
      if (out.ok) {
        await recordNotify(requestId, u.token, 'sent', out.id ? `resend:${out.id}` : null);
        const student = await sendStudentCopy();
        return res.status(200).json({ ok: true, id: out.id, student });
      }
      // ★ A 409 THE PROVIDER NAMES "IN PROGRESS" IS NOT A FAILURE, AND IT IS NOT RECORDED. This
      //   key is still being processed — another invocation is sending this very alert, and will
      //   stamp the row (and send the student copy) itself. Recording anything here could land
      //   AFTER that invocation's 'sent' and replace it: the card would read "not sent" for an
      //   alert that was delivered, and the next POST would send it again.
      //   ★ ONLY THAT 409 (EMAIL-2). Resend also answers 409 when this key was already used with
      //   a DIFFERENT payload (invalid_idempotent_request): an alert for this request went out
      //   earlier, nobody is sending it now, and nobody else will record it — so it is recorded
      //   below, as unclear.
      if (out.code === 'resend_409' && out.conflict === 'in_flight') {
        return res.status(200).json({ ok: false, skipped: 'in_flight' });
      }
      // ★ A CODE, NEVER THE PROVIDER'S SENTENCE. notify_detail is stored on the STUDENT's own
      //   request row, which enroll_req_own_select lets them read — and a Resend rejection body
      //   names the from-address, the admin recipient it could not reach, or the unverified
      //   domain. The column has said "short, non-secret provider detail slice" since #16; this
      //   is the line that made that untrue. The full body still reaches the admin through the
      //   'test' action, which is gated on enrollments.review. sendEmail() answers with a slug
      //   ('resend_422', 'resend_timeout') and nothing else, so that slug is what is stored —
      //   by both records below.
      // ★ AN ALERT WITH NO CLEAR ANSWER IS NOT AN ALERT THAT WAS REFUSED (EMAIL-4). A timeout, a
      //   dropped connection, a provider failure or that other 409 may each have been delivered,
      //   so the row records 'provider_unclear' — the Enrollments badge says "may not have been
      //   sent" — where 'provider_error' says "not sent" and invites a second alert by hand.
      if (alertMayHaveGone(out)) {
        await recordNotify(requestId, u.token, 'provider_unclear', out.code);
        return res.status(502).json({ ok: false, error: 'The email provider gave no clear answer: the alert may have been sent.', code: out.code });
      }
      await recordNotify(requestId, u.token, 'provider_error', out.code);
      return res.status(502).json({ ok: false, error: 'Email provider rejected the request.' });
    } catch (err) {
      console.error(`[notify-enrollment] send failed: ${err?.name || 'error'}`);
      await recordNotify(requestId, u.token, 'provider_error', 'send failed');
      return res.status(502).json({ ok: false, error: 'Email send failed.' });
    }
  }

  if (action === 'decision') {
    // Admin → student. Same gate as notify-access.js.
    const gate = await requireStaff(req, { permission: 'enrollments.review' });
    if (!gate.ok) {
      return res.status(gate.status).json({ error: gate.error, code: gate.code });
    }
    // (Its burst guard runs once the decision is verified — EMAIL-1, below.)
    // ★ THE BROWSER NAMES A REQUEST; THE SERVER DECIDES WHO IS EMAILED AND WHAT IT SAYS.
    //   This action used to take `email`, `fullName`, `planName` and `reason` straight from
    //   the body, so any enrollments.review holder — an Operations Admin included — could send
    //   the business's own "Your enrollment is approved" email to ANY address, with any name
    //   and any "reason" text (a link rides along in plain text). #61 made the same rule for
    //   Communications: the page describes; the server resolves. Now the row is read with the
    //   CALLER's JWT (RLS decides whether they may see it), and the email is refused unless
    //   the decision it announces is the one actually recorded on that row.
    const { requestId, status } = body || {};
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return res.status(400).json({ error: 'requestId (uuid) required.' });
    }
    if (!['approved', 'rejected', 'expired'].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved', 'rejected' or 'expired'." });
    }
    const row = await fetchDecidedRequest(requestId, gate.user.token);
    if (!row) return res.status(404).json({ ok: false, error: 'Request not found.' });
    if (row.status !== status) {
      return res.status(409).json({ ok: false, error: 'That decision is not the one recorded on this request.' });
    }
    // ★ ONE DECISION IS ONE EMAIL — AND A DECISION MADE AGAIN IS ANOTHER (#69; EMAIL-2). The key
    //   names the request, the decision and the MOMENT it was recorded: reviewed_at, which
    //   admin_finalize_enrollment stamps now() and both decline paths stamp as they write the
    //   status. A double click, or the client retrying after a dropped connection, repeats the
    //   SAME provider request and is de-duplicated there. A request a Super Admin reopens (#66)
    //   and decides again — a corrected reason, a re-approval that stacked a new term — is a NEW
    //   email: keyed on the request and status alone, it met a provider 409 for 24 hours and was
    //   reported "already on its way" while nothing was sent. Built from the ROW, so the same
    //   request named in another letter-case is the same key. The moment is epoch MILLIseconds:
    //   sendEmail accepts only [A-Za-z0-9:_-] and silently swaps any other key for a random one,
    //   and an ISO timestamp carries a '.' and a '+'. A row with no readable moment keys on '0'.
    const decidedAt = Date.parse(row.reviewed_at);
    const stamp = Number.isFinite(decidedAt) && decidedAt > 0 ? String(Math.trunc(decidedAt)) : '0';
    const decisionKey = `enrollment-decision-${row.id}-${status}-${stamp}`;
    // ★ THE BURST GUARD COUNTS SENDS OF ONE DECISION, NOT A REVIEWER'S DECISIONS (EMAIL-1). Keyed
    //   on the reviewer alone, a bulk approval or rejection — one request after another, the way a
    //   cohort's intake is cleared — lost every decision email after the tenth in a minute to a
    //   429 nobody saw, while the dialog said "the student is emailed". A decision is announced
    //   once; only a loop asks for the SAME one ten times in a minute.
    // ★ AND THE REVIEWER'S RUN HAS A CEILING OF ITS OWN (EMAIL1-R1): REVIEWER_DECISIONS_PER_WINDOW, every
    //   decision together. The decisions themselves do NOT bound it, nor does the provider's 24-hour
    //   de-duplication: the key's moment is reviewed_at, which an enrollments.review holder can re-stamp
    //   on a decided row (#48's column grant; #66 locks only the status) — and every re-stamp is a new
    //   key, so a scripted loop emailed one student without limit. Checked after the per-decision guard,
    //   so a loop on one decision never spends the reviewer's run.
    if (rateLimited(`${gate.user.id}:${decisionKey}`)) {
      return res.status(429).json({ ok: false, error: "This decision's email was asked for too many times — wait a minute and try again." });
    }
    if (rateLimited(`decisions:${gate.user.id}`, REVIEWER_DECISIONS_PER_WINDOW)) {
      return res.status(429).json({ ok: false, error: 'Too many decision emails in one minute — wait a minute and try again.' });
    }
    const account = await fetchAccountContact(row.user_id, gate.user.token);
    if (!account || !isEmail(account.email)) {
      return res.status(422).json({ ok: false, error: 'This student account has no valid email address on file.' });
    }
    if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

    // Two more reads, side by side, both with the REVIEWER's JWT and both best-effort (#69):
    // what the database says this decision granted, and where a reply should go. Neither
    // can refuse the email — a failed facts read sends the generic copy, and with no reply
    // address the header is simply left out (never RESEND_FROM's no-reply mailbox).
    const [facts, replyTo] = await Promise.all([
      fetchDecisionFacts(row.id, status, gate.user.token),
      studentReplyTo(gate.user.token),
    ]);
    const { subject, html, text } = decisionEmail({
      status,
      fullName: account.full_name || row.full_name,
      planName: row.plan_name,
      reason: status === 'approved' ? null : row.rejection_reason,
      facts,
      canReply: Boolean(replyTo),
      appUrl: appOrigin(req),
      nowMs: Date.now(),
    });
    try {
      const out = await sendEmail({
        to: account.email, subject, html, text, replyTo: replyTo || undefined,
        idempotencyKey: decisionKey,
        tag: 'notify-enrollment', timeoutMs: 10_000, maxAttempts: 2, classify409: true,
      });
      if (out.ok) return res.status(200).json({ ok: true, id: out.id });
      // ★ "ALREADY ON ITS WAY" ONLY WHEN THE PROVIDER SAYS SO (EMAIL-2): a 409 named
      //   concurrent_idempotent_requests — another request is sending this very email, and owns
      //   it. Every other 409 is a REFUSAL of this request: invalid_idempotent_request means this
      //   decision's key was already used with a different payload — its email went out earlier
      //   with other facts in it — so nobody is sending this one and nothing more will arrive. It
      //   answers 502 'resend_409', which the screen reads as "not sent", like any refusal.
      if (out.code === 'resend_409' && out.conflict === 'in_flight') return res.status(200).json({ ok: false, skipped: 'in_flight' });
      return res.status(502).json({ ok: false, error: 'Email provider rejected the request.', code: out.code });
    } catch (err) {
      console.error(`[notify-enrollment] send failed: ${err?.name || 'error'}`);
      return res.status(502).json({ ok: false, error: 'Email send failed.' });
    }
  }

  if (action === 'import_onboarded') {
    const u = await callerUser(req.headers?.authorization);
    if (!u) return res.status(403).json({ error: 'Authorization required.' });
    if (rateLimited(u.id)) {
      return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute and try again.' });
    }
    if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    if (!serviceConfigured()) return res.status(503).json({ ok: false, error: 'The server is not configured for this.' });
    // ★ FROM A VERIFIED DOMAIN, ANSWERED AT THE SUPPORT MAILBOX — the same two addresses the
    //   activation email uses, from one helper. Checked BEFORE the reservation: with no sender
    //   there is nothing to send, and asking would spend one of the student's five tries.
    const addr = migrationAddresses({
      migrationFrom: process.env.MIGRATION_EMAIL_FROM,
      resendFrom: process.env.RESEND_FROM,
      replyTo: process.env.MIGRATION_REPLY_TO,
    });
    if (!addr.from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });
    // ★ WELL-FORMED, TOO (#68, V2) — the same test readiness() applies before a run. A
    //   malformed MIGRATION_EMAIL_FROM or MIGRATION_REPLY_TO is refused by Resend on both
    //   emails, every time; checked here it spends none of the student's tries on a send that
    //   cannot work.
    if (!isAddress(addr.from) || !isAddress(addr.replyTo)) {
      return res.status(200).json({ ok: false, skipped: 'email_address_invalid' });
    }

    // ★ SERVICE-ONLY, AND ONLY EVER WITH THE uid callerUser() VERIFIED. The notice RPC is
    //   revoked from every client role: while it was the student's own call, a student could
    //   record 'sent' themselves (so the admin was never told) or loop reserve → 'failed'
    //   into the append-only event log. The request body still names nothing.
    const svc = service();
    const notice = async (args) => {
      try {
        const { data, error } = await svc.rpc('legacy_import_onboarding_notice', { p_user: u.id, ...args })
          .abortSignal(AbortSignal.timeout(8000));
        return error ? null : data;
      } catch {
        return null;
      }
    };

    // Reserves the send and returns the facts, all read from the student's OWN import row.
    // A student who is not a migrated, onboarded account gets a skip, never an email.
    const claim = await notice({});
    if (!claim) return res.status(503).json({ ok: false, error: 'Could not reach the database. Try again.' });
    if (!claim.ok) return res.status(200).json({ ok: false, skipped: claim.skip || 'not_eligible' });

    // The request's own host only under `npm run dev`: on Vercel a preview shares
    // production's database, so without APP_URL the email carries no dashboard link at all.
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '') ||
      (!process.env.VERCEL_ENV && req.headers?.host ? `http://${req.headers.host}` : '');
    const facts = {
      fullName: claim.full_name, email: claim.email, batchName: claim.batch_name,
      planName: claim.plan_name, startDate: claim.started_at,
      endDate: claim.ends_at, status: claim.status,
    };

    const { to: adminTo } = await resolveAdminRecipient(u.token, { timeoutMs: ADMIN_RECIPIENT_TIMEOUT_MS });
    const adminMsg = onboardedAdminEmail({ ...facts, onboardedAt: claim.onboarded_at,
      dashboardUrl: appUrl ? `${appUrl}/admin/student-imports` : null });
    const studentMsg = onboardedStudentEmail({ ...facts, dashboardUrl: appUrl ? `${appUrl}/` : null,
      supportEmail: addr.replyTo, nowMs: Date.now() });

    const send = (to, msg, who) => (isEmail(to)
      ? sendEmail({ to, subject: msg.subject, html: msg.html, text: msg.text, from: addr.from, replyTo: addr.replyTo,
          idempotencyKey: `legacy-onboarded-${who}-${claim.row_id}`, tag: 'student-onboarded',
          timeoutMs: 10_000, maxAttempts: 2, retry429: false })
      : Promise.resolve({ ok: false, code: 'recipient_invalid' }));
    const [adminOut, studentOut] = await Promise.all([
      send(adminTo, adminMsg, 'admin'),
      send(claim.email, studentMsg, 'student'),
    ]);
    const ok = adminOut.ok && studentOut.ok;
    // 'failed' is retryable (the app asks again the next time the student opens it, at most
    // five reservations in all), and the idempotency keys stop the one that already went out
    // from going twice — for 24 hours, which is all Resend promises.
    await notice(ok ? { p_result: 'sent' } : onboardingFailure(adminOut, studentOut));
    if (!ok) console.error(`[notify-enrollment] onboarded notice: admin ${adminOut.ok ? 'ok' : adminOut.code}, student ${studentOut.ok ? 'ok' : studentOut.code}`);
    return res.status(200).json({ ok, admin: adminOut.ok ? 'sent' : adminOut.code, student: studentOut.ok ? 'sent' : studentOut.code });
  }

  if (action === 'test') {
    // Admin-only diagnostic — sends a sample admin alert to the resolved recipient so an
    // admin can confirm email works end-to-end. Strictly admin-gated: a non-admin can't
    // even discover the recipient address. Returns { to, source } so the UI can show where
    // the alert would land, plus a provider `detail` on failure to aid diagnosis.
    const gate = await requireStaff(req, { permission: 'enrollments.review' });
    if (!gate.ok) {
      return res.status(gate.status).json({ error: gate.error, code: gate.code });
    }
    const adminId = gate.user.id;
    if (rateLimited(adminId)) {
      return res.status(429).json({ ok: false, error: 'Too many emails — wait a minute and try again.' });
    }
    if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

    // requireStaff already verified this token — reuse its user instead of
    // re-fetching /auth/v1/user a second time for the same request.
    const u = gate.user;
    const { to: adminTo, source } = await resolveAdminRecipient(u?.token);
    if (!isEmail(adminTo)) return res.status(200).json({ ok: false, skipped: 'admin_email_invalid' });

    const { subject, html } = {
      subject: `Test alert — ${BRAND} enrollment notifications are working ✅`,
      html: emailHtml({
        heading: 'Enrollment email is configured 🎉',
        intro: `This is a test of the ${BRAND} admin notification email. If you received this, "new enrollment submitted" alerts will reach this inbox. This message was triggered by an admin from the Enrollments tab — no student action occurred.`,
        rows: [
          ['Recipient', adminTo],
          ['Resolved from', source === 'env' ? 'NOTIFY_ADMIN_EMAIL' : source === 'payment_settings' ? 'payment_settings.notify_email' : 'RESEND_FROM'],
        ],
      }),
    };
    try {
      const out = await sendResend(apiKey, from, adminTo, subject, html);
      if (out.ok) return res.status(200).json({ ok: true, id: out.id, to: adminTo, source });
      return res.status(502).json({ ok: false, error: 'Email provider rejected the request.', status: out.status, detail: out.detail });
    } catch (err) {
      console.error('[notify-enrollment] test send failed:', String(err));
      return res.status(502).json({ ok: false, error: 'Email send failed.' });
    }
  }

  return res.status(400).json({ error: "action must be 'submitted', 'decision', 'test' or 'import_onboarded'." });
}

// Exported for test/notifyImportOnboarded.test.mjs.
export { onboardingFailure };
