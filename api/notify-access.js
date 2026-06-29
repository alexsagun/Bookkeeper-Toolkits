// Vercel serverless function — sends approval / rejection emails for the temporary
// admin-approval workflow. OPTIONAL + env-gated: if RESEND_API_KEY / RESEND_FROM are
// not set, it responds { ok:false, skipped:'…' } and the in-app approve/reject still
// works (the client treats email as best-effort). Secrets stay server-side — never the bundle.
//
// Path: lives at api/notify-access.js → answers `/api/notify-access` (Vercel maps the file
// name to the route). vercel.json leaves /api/* un-rewritten, so the SPA fallback won't eat it.
//
// Env (set in Vercel → Settings → Environment Variables, Production + Preview):
//   RESEND_API_KEY        re_…  (server-only; do NOT VITE_-prefix)
//   RESEND_FROM           e.g. "Toolkits by Alex <noreply@yourdomain.com>"
//   VITE_SUPABASE_URL     reused for admin verification (already set for the build)
//   VITE_SUPABASE_ANON_KEY  reused for admin verification (already set for the build)
//
// NOTE: `npm run dev` (Vite) does NOT run this function — email is exercised on Vercel only.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const BRAND = 'Toolkits by Alex';
const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Branded HTML mirroring the auth-email template (AUTH_SETUP.md §4d).
function emailHtml({ heading, intro, reason }) {
  const reasonBlock = reason
    ? `<div style="margin:0 0 20px;padding:12px 14px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:10px;font-size:13px;color:#7F1D1D;"><strong>Reason:</strong> ${esc(reason)}</div>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f7fb;padding:32px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6ebf2;">
    <div style="background:linear-gradient(180deg,#3aa0ff,#0A84FF);padding:26px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">${esc(BRAND)}</h1>
    </div>
    <div style="padding:28px;color:#1c2430;">
      <h2 style="font-size:18px;margin:0 0 8px;">${esc(heading)}</h2>
      <p style="font-size:14px;line-height:1.6;color:#48505e;margin:0 0 20px;">${esc(intro)}</p>
      ${reasonBlock}
      <p style="font-size:12px;color:#8a93a3;margin:8px 0 0;">Thank you,<br/>The ${esc(BRAND)} team</p>
    </div>
  </div>
</div>`;
}

function buildEmail(status, fullName, reason) {
  const hi = fullName ? `Hello ${fullName},` : 'Hello,';
  if (status === 'approved') {
    return {
      subject: `Your ${BRAND} Access Has Been Approved`,
      html: emailHtml({
        heading: 'Your access has been approved 🎉',
        intro: `${hi} your access to ${BRAND} has been approved. You can now log in and use your dashboard.`,
      }),
    };
  }
  return {
    subject: `Your ${BRAND} Access Request Was Not Approved`,
    html: emailHtml({
      heading: 'Access request update',
      intro: `${hi} thank you for your interest in ${BRAND}. At this time, your access request was not approved. If you believe this was a mistake, please contact the admin team.`,
      reason,
    }),
  };
}

// Confirm the bearer token belongs to an admin (anon key + the caller's JWT; RLS own_profile_select
// lets a user read their own is_admin). Returns true/false; false also on any verification failure.
async function callerIsAdmin(authHeader) {
  if (!authHeader || !SUPABASE_URL || !SUPABASE_ANON) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return false;
    const u = await userRes.json();
    if (!u?.id) return false;
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=is_admin`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } }
    );
    if (!profRes.ok) return false;
    const rows = await profRes.json();
    return Array.isArray(rows) && rows[0]?.is_admin === true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const hasKey = Boolean(process.env.RESEND_API_KEY);

  // Health check (no email, no auth) — visit /api/notify-access in a browser.
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, hasKey, hasFrom: Boolean(process.env.RESEND_FROM) });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Only admins may trigger an email (prevents abuse of the endpoint).
  if (!(await callerIsAdmin(req.headers?.authorization))) {
    return res.status(403).json({ error: 'Admin authorization required.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { email, fullName, status, reason } = body || {};

  if (!isEmail(email)) return res.status(400).json({ error: 'Valid recipient email required.' });
  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: "status must be 'approved' or 'rejected'." });
  }

  // Env-gated: not configured → non-fatal skip so the approval still succeeds client-side.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
  if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

  const { subject, html } = buildEmail(status, fullName, status === 'rejected' ? reason : null);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [email], subject, html }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error(`[notify-access] resend ${r.status}: ${text.slice(0, 500)}`);
      return res.status(502).json({ ok: false, error: 'Email provider rejected the request.' });
    }
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-JSON success body — fine */ }
    return res.status(200).json({ ok: true, id: data?.id });
  } catch (err) {
    console.error('[notify-access] send failed:', String(err));
    return res.status(502).json({ ok: false, error: 'Email send failed.' });
  }
}
