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
//                 Auth: same admin check as notify-access.js.
//   'test'      — an ADMIN sends a sample admin alert to confirm config end-to-end.
//                 Auth: admin JWT (same gate as 'decision'). Returns { to, source }.
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
//   `npm run dev` (Vite) does NOT run this function — email is exercised on Vercel only.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const BRAND = 'Toolkits by Alex';
const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const php = (n) => '₱' + Number(n || 0).toLocaleString('en-US');

// Branded HTML mirroring api/notify-access.js / the auth-email template.
// cta: optional { href, label } — a button after the rows table (intro is esc()'d,
// so links can't ride along in the text).
function emailHtml({ heading, intro, rows, reason, cta }) {
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
      ${rowsBlock}
      ${reasonBlock}
      ${ctaBlock}
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

// Same admin check as api/notify-access.js (RLS own_profile_select reads own is_admin).
async function callerIsAdmin(authHeader) {
  const u = await callerUser(authHeader);
  if (!u) return false;
  try {
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=is_admin`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${u.token}` } }
    );
    if (!profRes.ok) return false;
    const rows = await profRes.json();
    return Array.isArray(rows) && rows[0]?.is_admin === true;
  } catch {
    return false;
  }
}

// Fetch the enrollment request WITH THE CALLER'S OWN JWT — RLS enroll_req_own_select
// returns the row only to its owner (or an admin), which is exactly the proof we need.
// notify_status rides along as the replay-dedup marker (see the 'submitted' handler);
// installs without the notify-status migration get a column error → retry without it,
// so pre-#16 databases keep working (same column-resilience pattern as the client).
const OWN_REQUEST_COLS =
  'id,user_id,plan_name,full_name,email,phone,city_country,amount_expected,amount_paid,payment_reference,created_at,status';
async function fetchOwnRequest(requestId, token) {
  for (const cols of [`${OWN_REQUEST_COLS},notify_status`, OWN_REQUEST_COLS]) {
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
    console.error(`[notify-enrollment] resend ${r.status}: ${text.slice(0, 500)}`);
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
          ['Reference', row.payment_reference || '—'],
          ['Submitted', new Date(row.created_at).toUTCString()],
        ],
        cta: appUrl ? { href: `${appUrl}/admin/enrollments`, label: 'Review in Enrollments' } : undefined,
      }),
    };
    try {
      const out = await sendResend(apiKey, from, adminTo, subject, html);
      if (out.ok) {
        await recordNotify(requestId, u.token, 'sent', out.id ? `resend:${out.id}` : null);
        return res.status(200).json(out);
      }
      await recordNotify(requestId, u.token, 'provider_error', out.detail || `status ${out.status}`);
      return res.status(502).json({ ok: false, error: 'Email provider rejected the request.' });
    } catch (err) {
      console.error('[notify-enrollment] send failed:', String(err));
      await recordNotify(requestId, u.token, 'provider_error', 'send failed');
      return res.status(502).json({ ok: false, error: 'Email send failed.' });
    }
  }

  if (action === 'decision') {
    // Admin → student. Same gate as notify-access.js.
    if (!(await callerIsAdmin(req.headers?.authorization))) {
      return res.status(403).json({ error: 'Admin authorization required.' });
    }
    const { email, fullName, status, reason, planName } = body || {};
    if (!isEmail(email)) return res.status(400).json({ error: 'Valid recipient email required.' });
    if (!['approved', 'rejected', 'expired'].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved', 'rejected' or 'expired'." });
    }
    if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

    const { subject, html } = decisionEmail(status, fullName, planName, status === 'approved' ? null : reason);
    try {
      const out = await sendResend(apiKey, from, email, subject, html);
      return res.status(out.ok ? 200 : 502).json(out.ok ? out : { ok: false, error: 'Email provider rejected the request.' });
    } catch (err) {
      console.error('[notify-enrollment] send failed:', String(err));
      return res.status(502).json({ ok: false, error: 'Email send failed.' });
    }
  }

  if (action === 'test') {
    // Admin-only diagnostic — sends a sample admin alert to the resolved recipient so an
    // admin can confirm email works end-to-end. Strictly admin-gated: a non-admin can't
    // even discover the recipient address. Returns { to, source } so the UI can show where
    // the alert would land, plus a provider `detail` on failure to aid diagnosis.
    if (!(await callerIsAdmin(req.headers?.authorization))) {
      return res.status(403).json({ error: 'Admin authorization required.' });
    }
    if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
    if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

    const u = await callerUser(req.headers?.authorization);
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

  return res.status(400).json({ error: "action must be 'submitted', 'decision' or 'test'." });
}
