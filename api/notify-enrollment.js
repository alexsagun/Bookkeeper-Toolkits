// Vercel serverless function — emails for the manual enrollment/payment workflow.
// OPTIONAL + env-gated like api/notify-access.js: if RESEND_API_KEY / RESEND_FROM are
// not set, it responds { ok:false, skipped:'…' } and the in-app flow still works
// (the client treats email as best-effort). Secrets stay server-side — never the bundle.
//
// Three actions, selected by body.action:
//   'submitted' — a STUDENT just submitted payment proof → notify the admin.
//                 Auth: the caller's own JWT must be able to read the request row
//                 (RLS enroll_req_own_select proves ownership); the email content is
//                 built from the DB row, never from the request body.
//   'decision'  — an ADMIN approved / rejected / expired a request → notify the student.
//                 Auth: requireStaff('enrollments.review'). The body names ONLY
//                 { requestId, status }; plan and reason are read from the request row and
//                 the RECIPIENT from the student's profile (never the request's typed
//                 email), both with the caller's JWT, and the send is refused unless
//                 `status` is the decision actually recorded (2026-09-24 — see the handler).
//   'test'      — an ADMIN sends a sample admin alert to confirm config end-to-end.
//                 Auth: admin JWT (same gate as 'decision'). Returns { to, source }.
//   'import_onboarded' — a MIGRATED STUDENT (#67) has just set their password → email the
//                 administrator ("Student Successfully Onboarded") and the student (their
//                 account is ready). Auth: the student's own JWT, verified here. The body
//                 carries NOTHING: the service-only legacy_import_onboarding_notice(uid)
//                 reads every fact from that student's own import row, and 'sent' is final,
//                 so the admin inbox rings once per student.
//                 Both emails come from support@alexsagun.com (MIGRATION_EMAIL_FROM).
//
// Admin-recipient resolution ('submitted' + 'test'), first valid email wins:
//   NOTIFY_ADMIN_EMAIL → payment_settings.notify_email → address inside RESEND_FROM.
//
// Env (Vercel → Settings → Environment Variables, Production + Preview):
//   RESEND_API_KEY        re_…  (server-only; do NOT VITE_-prefix)
//   RESEND_FROM           e.g. "Toolkits by Alex <noreply@yourdomain.com>"
//   NOTIFY_ADMIN_EMAIL    optional — where admin alerts go; if unset, falls back to the
//                         admin-editable payment_settings.notify_email, then to the
//                         address inside RESEND_FROM.
//   APP_URL               optional — absolute origin for the "Review in Enrollments"
//                         button in admin alerts (e.g. https://toolkits.alexsagun.com);
//                         falls back to the request's own host header.
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY  reused for auth checks (already set).
//
// NOTE: Supabase Auth's SMTP/Resend settings power ONLY Supabase Auth emails (confirm,
//   reset) — NOT this function. These custom alerts need their own env vars above.
//   This DOES run under `npm run dev` — vite.config.js registers `notifyDevApi` for
//   /api/notify-enrollment. It still needs RESEND_* in .env, and Vite reads .env at
//   startup, so restart the dev server after adding keys.

import { phpAmount } from '../src/lib/planCatalog.js';
import { intakeSelectColumns, ENROLLMENT_PROCESSING_NOTE } from '../src/lib/enrollmentIntake.js';
import { requireStaff, service, serviceConfigured } from './_lib/staffAuth.js';
import { sendEmail } from './_lib/email.js';
import { MIGRATION_SENDER_ADDRESS, onboardedAdminEmail, onboardedStudentEmail } from './_lib/legacyClaimEmail.js';

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

// Branded HTML mirroring api/notify-access.js / the auth-email template.
// cta: optional { href, label } — a button after the rows table (intro is esc()'d,
// so links can't ride along in the text).
// note: optional trailing block — a string, or an ARRAY rendered one line per
// line. Each line is esc()'d. video: optional { id, label } — a
// YouTube thumbnail that links to the watch page. An <img> is used rather than an
// embed because no mail client plays an iframe, and a bare link gets ignored.
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
  const rowsBlock = rows && rows.length
    ? `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;color:#1c2430;">
        ${rows.map(([k, v]) =>
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

// Best-effort per-caller burst guard (per warm instance — the anthropic-proxy idiom).
// Legit traffic is ~1 email per human action, so 10/min stops a runaway loop or a
// scripted burst from draining the Resend quota without touching real usage.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;
const rateHits = new Map(); // userId -> [timestamps]
function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  if (rateHits.size > 500) {
    for (const [uid, hits] of rateHits) {
      if (!hits.length || hits[hits.length - 1] < cutoff) rateHits.delete(uid);
    }
  }
  const hits = (rateHits.get(userId) || []).filter((t) => t >= cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now);
  rateHits.set(userId, hits);
  return false;
}

// Fetch the enrollment request WITH THE CALLER'S OWN JWT — RLS enroll_req_own_select
// returns the row only to its owner (or an admin), which is exactly the proof we need.
// notify_status rides along as the replay-dedup marker (see the 'submitted' handler);
// installs without the notify-status migration get a column error → retry without it,
// so pre-#16 databases keep working (same column-resilience pattern as the client).
const OWN_REQUEST_COLS =
  'id,user_id,plan_name,full_name,email,phone,city_country,amount_expected,amount_paid,payment_reference,created_at,status';
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
async function fetchOwnRequest(requestId, token) {
  // batch_id (#32) and the intake columns (#42) ride the same resilience ladder
  // as notify_status (#16).
  for (const cols of [
    `${OWN_REQUEST_COLS},notify_status,batch_id,${INTAKE_COLS}`,
    `${OWN_REQUEST_COLS},notify_status,batch_id`,
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
async function fetchDecidedRequest(requestId, token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/enrollment_requests?id=eq.${encodeURIComponent(requestId)}` +
      '&select=id,user_id,full_name,plan_name,status,rejection_reason',
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
async function fetchAccountContact(userId, token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON || !userId) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=email,full_name`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// Best-effort "is this a renewal?" — any prior subscription row (caller's own JWT;
// RLS subscriptions_own_select). Failure or missing table just means "New enrollment".
async function callerHasSubscription(userId, token) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
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
async function resolveAdminRecipient(token) {
  const envTo = process.env.NOTIFY_ADMIN_EMAIL;
  if (isEmail(envTo)) return { to: envTo, source: 'env' };

  if (token && SUPABASE_URL && SUPABASE_ANON) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/payment_settings?key=eq.notify_email&select=value`,
        { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        const val = Array.isArray(rows) && rows[0]?.value;
        if (isEmail(val)) return { to: val, source: 'payment_settings' };
      }
    } catch { /* best-effort — fall through to RESEND_FROM */ }
  }

  const fromTo = fromAddress(process.env.RESEND_FROM);
  if (isEmail(fromTo)) return { to: fromTo, source: 'from' };

  return { to: null, source: null };
}

function decisionEmail(status, fullName, planName, reason) {
  const hi = fullName ? `Hello ${fullName},` : 'Hello,';
  const plan = planName || 'your selected package';
  if (status === 'approved') {
    return {
      subject: `Your ${BRAND} Enrollment Is Approved 🎉`,
      html: emailHtml({
        heading: 'Payment verified — you’re in!',
        intro: `${hi} your payment for ${plan} has been verified and your enrollment is approved. Log in to ${BRAND} — everything is unlocked and waiting for you.`,
      }),
    };
  }
  if (status === 'expired') {
    return {
      subject: `Your ${BRAND} Enrollment Request Expired`,
      html: emailHtml({
        heading: 'Enrollment request expired',
        intro: `${hi} your enrollment request for ${plan} was not completed within the review window and has expired. You can log in and resubmit your payment proof anytime.`,
        reason,
      }),
    };
  }
  return {
    subject: `Your ${BRAND} Enrollment Needs Another Look`,
    html: emailHtml({
      heading: 'Payment proof update',
      intro: `${hi} we couldn’t verify your payment for ${plan} yet. Please log in and resubmit your payment proof — the reason is below. If you believe this was a mistake, just reply to this email.`,
      reason,
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
    // email_not_configured, admin_email_invalid) stay retryable so a transient outage
    // never permanently silences a request's alert. Resubmits insert NEW rows (null
    // notify_status), so legitimate flows are unaffected.
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
    const { to: adminTo } = await resolveAdminRecipient(u.token);
    if (!isEmail(adminTo)) {
      await recordNotify(requestId, u.token, 'admin_email_invalid');
      return res.status(200).json({ ok: false, skipped: 'admin_email_invalid' });
    }

    // Direct review link: APP_URL env wins; otherwise the host that served this request.
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '') ||
      (req.headers?.host ? `https://${req.headers.host}` : '');
    const isRenewal = await callerHasSubscription(row.user_id, u.token);

    const { subject, html } = {
      subject: `${isRenewal ? 'Renewal' : 'New enrollment'} submitted — ${row.full_name} · ${row.plan_name}`,
      html: emailHtml({
        heading: isRenewal ? 'Membership renewal payment proof 🔄' : 'New enrollment payment proof 💸',
        intro: `A student just submitted ${isRenewal ? 'a renewal payment' : 'payment proof'}. Review it in the app: sidebar → Enrollments.`,
        rows: [
          ['Type', isRenewal ? 'Renewal' : 'New enrollment'],
          ['Student', row.full_name],
          ['Email', row.email],
          ['Phone', row.phone || '—'],
          ['Location', row.city_country || '—'],
          ['Package', row.plan_name],
          ['Expected', php(row.amount_expected)],
          ['Paid / sent', php(row.amount_paid)],
          ['Submitted', new Date(row.created_at).toUTCString()],
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
            ? [['Agreement', `Signed${row.agreement_tier ? ` as ${row.agreement_tier.toUpperCase()}` : ''} · v${row.agreement_version}`]]
            : []),
          ...(row.resume_path ? [['Resume', 'Attached — open it from Enrollments']] : []),
        ],
        cta: appUrl ? { href: `${appUrl}/admin/enrollments`, label: 'Review in Enrollments' } : undefined,
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
    const sendStudentCopy = async () => {
      if (!isEmail(row.email)) return;
      const first = String(row.full_name || '').trim().split(/\s+/)[0] || 'future QBO pro';
      try {
        await sendResend(apiKey, from, row.email,
          isRenewal ? 'Renewal received — Get Hired with Alex' : 'Enrollment received — Get Hired with Alex',
          emailHtml({
            heading: isRenewal ? `Thanks, ${first}` : `Welcome, ${first}`,
            intro: isRenewal
              ? 'Your renewal payment is in and Coach Alex is reviewing it now. Your access continues once it is verified — see the processing hours below.'
              : 'Your enrollment is in, and Coach Alex is reviewing it now. You will hear back with your next steps and course access — see the processing hours below.',
            // Onboarding instructions are for new students. Someone six months in
            // does not need to be welcomed and told how to start.
            ...(isRenewal ? {} : { video: { id: ONBOARDING_VIDEO_ID, label: 'Watch this first: your onboarding instructions' } }),
            rows: [
              ['Package', row.plan_name],
              ['Amount sent', php(row.amount_paid)],
              ...(row.agreement_version ? [['Training Agreement', 'Signed and on file']] : []),
            ],
            // The SAME constant the pending screen renders, so what a student
            // reads on screen and what lands in their inbox cannot diverge.
            note: ENROLLMENT_PROCESSING_NOTE,
          }));
      } catch (studentErr) {
        console.warn('[notify-enrollment] student confirmation failed:', String(studentErr));
      }
    };

    try {
      const out = await sendResend(apiKey, from, adminTo, subject, html);
      if (out.ok) {
        await recordNotify(requestId, u.token, 'sent', out.id ? `resend:${out.id}` : null);
        await sendStudentCopy();
        return res.status(200).json(out);
      }
      // ★ A CODE, NEVER THE PROVIDER'S SENTENCE. notify_detail is stored on the STUDENT's own
      //   request row, which enroll_req_own_select lets them read — and a Resend rejection body
      //   names the from-address, the admin recipient it could not reach, or the unverified
      //   domain. The column has said "short, non-secret provider detail slice" since #16; this
      //   is the line that made that untrue. The full body still reaches the admin through the
      //   'test' action, which is gated on enrollments.review.
      await recordNotify(requestId, u.token, 'provider_error', `resend_${out.status}`);
      return res.status(502).json({ ok: false, error: 'Email provider rejected the request.' });
    } catch (err) {
      console.error('[notify-enrollment] send failed:', String(err));
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
    const adminId = gate.user.id;
    if (rateLimited(adminId)) {
      return res.status(429).json({ ok: false, error: 'Too many emails — wait a minute and try again.' });
    }
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
    const account = await fetchAccountContact(row.user_id, gate.user.token);
    if (!account || !isEmail(account.email)) {
      return res.status(422).json({ ok: false, error: 'This student account has no valid email address on file.' });
    }
    if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

    const { subject, html } = decisionEmail(status, account.full_name || row.full_name, row.plan_name,
      status === 'approved' ? null : row.rejection_reason);
    try {
      const out = await sendResend(apiKey, from, account.email, subject, html);
      return res.status(out.ok ? 200 : 502).json(out.ok ? out : { ok: false, error: 'Email provider rejected the request.' });
    } catch (err) {
      console.error('[notify-enrollment] send failed:', String(err));
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

    const sender = String(process.env.MIGRATION_EMAIL_FROM || '').trim() || MIGRATION_SENDER_ADDRESS;
    const support = fromAddress(sender);
    // The request's own host only under `npm run dev`: on Vercel a preview shares
    // production's database, so without APP_URL the email carries no dashboard link at all.
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '') ||
      (!process.env.VERCEL_ENV && req.headers?.host ? `http://${req.headers.host}` : '');
    const facts = {
      fullName: claim.full_name, email: claim.email, batchName: claim.batch_name,
      planName: claim.plan_name, planKey: claim.plan_key, startDate: claim.started_at,
      endDate: claim.ends_at, status: claim.status,
    };

    const { to: adminTo } = await resolveAdminRecipient(u.token);
    const adminMsg = onboardedAdminEmail({ ...facts, onboardedAt: claim.onboarded_at,
      dashboardUrl: appUrl ? `${appUrl}/admin/student-imports` : null });
    const studentMsg = onboardedStudentEmail({ ...facts, dashboardUrl: appUrl ? `${appUrl}/` : null,
      supportEmail: support, nowMs: Date.now() });

    const send = (to, msg, who) => (isEmail(to)
      ? sendEmail({ to, subject: msg.subject, html: msg.html, text: msg.text, from: sender, replyTo: support,
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
    // from going twice.
    await notice({ p_result: ok ? 'sent' : 'failed' });
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
