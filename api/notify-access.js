// Vercel serverless function — sends approval / rejection emails for the temporary
// admin-approval workflow. OPTIONAL + env-gated: if RESEND_API_KEY / RESEND_FROM are
// not set, it responds { ok:false, skipped:'…' } and the in-app approve/reject still
// works (the client treats email as best-effort). Secrets stay server-side — never the bundle.
//
// Path: lives at api/notify-access.js → answers `/api/notify-access` (Vercel maps the file
// name to the route). vercel.json leaves /api/* un-rewritten, so the SPA fallback won't eat it.
//
// The request (#69): POST { userId, status } with the reviewer's JWT. `status` is 'approved'
// or 'rejected'. NOTHING ELSE IN THE BODY IS READ — see "the browser names…" below. A body
// with a decision and no userId is what a page opened before #69 sends: it is refused as
// 400 { code: 'stale_client' }, by name, so the deployment log says why (TDR-7).
//
// Env (set in Vercel → Settings → Environment Variables, Production + Preview):
//   RESEND_API_KEY        re_…  (server-only; do NOT VITE_-prefix)
//   RESEND_FROM           e.g. "Toolkits by Alex <noreply@yourdomain.com>"
//   NOTIFY_ADMIN_EMAIL    optional — the Reply-To when payment_settings.notify_email is unset
//   VITE_SUPABASE_URL     reused for staff verification and the profile read
//   VITE_SUPABASE_ANON_KEY  reused for staff verification and the profile read
//
// NOTE: this DOES run under `npm run dev` — vite.config.js registers `notifyDevApi` for
//   /api/notify-access. It still needs RESEND_* in .env (read at Vite startup).

import { requireStaff } from './_lib/staffAuth.js';
import { plainTextEmail, sendEmail, studentReplyTo } from './_lib/email.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const BRAND = 'Toolkits by Alex';
const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Branded HTML mirroring the auth-email template (AUTH_SETUP.md §4d).
// intro: a paragraph, or several — the greeting is its own, so the sentence after it can
// stand exactly as written. Every paragraph is esc()'d.
function emailHtml({ heading, intro, reason }) {
  const paragraphs = (Array.isArray(intro) ? intro : [intro]).filter(Boolean);
  const introBlock = paragraphs.map((text, i) =>
    `<p style="font-size:14px;line-height:1.6;color:#48505e;margin:0 0 ${i === paragraphs.length - 1 ? 20 : 10}px;">${esc(text)}</p>`)
    .join('\n      ');
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
      ${introBlock}
      ${reasonBlock}
      <p style="font-size:12px;color:#8a93a3;margin:8px 0 0;">Thank you,<br/>The ${esc(BRAND)} team</p>
    </div>
  </div>
</div>`;
}

// ★ THE APPROVED COPY SAYS WHAT IS TRUE (#69). It used to read "You can now log in and use
//   your dashboard" — but approving an ACCOUNT is the step before enrollment: an approved
//   signup who has not paid lands on the pricing page, not a dashboard.
const APPROVED_COPY = "Your account is approved. Sign in to continue — if you haven't enrolled yet, you'll be asked to choose a plan.";

// Both parts from ONE object, so the HTML and the text cannot state different things.
// `canReply`: is there a Reply-To on this message? Without one a reply reaches RESEND_FROM's
// (typically no-reply) mailbox, so the copy must not invite it.
function buildEmail({ status, fullName, reason, canReply }) {
  // One line of text; and a name that is really an address (some signups carry one) is never
  // echoed as a greeting. NEL (U+0085) is not in JS's \s, yet a renderer that honours Unicode's
  // mandatory breaks starts a line at it — so it is folded by name (EMAIL-3).
  const name = typeof fullName === 'string' ? fullName.replace(/[\s\u0085]+/g, ' ').trim() : '';
  const hi = name && !name.includes('@') ? `Hello ${name},` : 'Hello,';
  if (status === 'approved') {
    const parts = { heading: 'Your account is approved 🎉', intro: [hi, APPROVED_COPY] };
    return { subject: `Your ${BRAND} Account Is Approved`, html: emailHtml(parts), text: plainTextEmail(parts) };
  }
  const parts = {
    heading: 'Access request update',
    intro: [hi, `Thank you for your interest in ${BRAND}. At this time, your access request was not approved. ${canReply
      ? 'If you believe this was a mistake, reply to this email and our team will take another look.'
      : 'If you believe this was a mistake, please contact the admin team.'}`],
    reason,
  };
  return { subject: `Your ${BRAND} Access Request Was Not Approved`, html: emailHtml(parts), text: plainTextEmail(parts) };
}

// The admin check moved to api/_lib/staffAuth.js in #45. It used to be a local
// callerAdminId() that read profiles.is_admin — one of four byte-identical copies.
// Reviewing an access request is now its own capability, so an Operations Admin
// can work this queue without holding any other admin power.

// The account a decision email is about, read with the REVIEWER's own JWT — so RLS, not this
// file, decides whether they may see it (profiles_admin_select admits access_requests.review
// since #45). No service-role client is built here, and none is needed.
//
// Three answers, because two of them must not be confused: the row, no row the caller may
// see, and "the read itself failed". A failed read reported as "no such account" would tell
// a reviewer the account is gone when only the database was slow.
const ACCOUNT_COLS = 'email,full_name,approval_status,approved_at,rejected_at,rejection_reason,account_origin';
const ACCOUNT_READ_TIMEOUT_MS = 8_000;
async function fetchReviewedAccount(userId, token) {
  if (!token || !SUPABASE_URL || !SUPABASE_ANON) return { ok: false, row: null };
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=${ACCOUNT_COLS}`,
      {
        headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(ACCOUNT_READ_TIMEOUT_MS),
      }
    );
    if (!r.ok) return { ok: false, row: null };
    const rows = await r.json();
    return { ok: true, row: Array.isArray(rows) && rows[0] ? rows[0] : null };
  } catch {
    return { ok: false, row: null };
  }
}

// Best-effort burst guard (per warm instance — the anthropic-proxy idiom): 10 sends a minute of
// ONE decision, keyed on the reviewer and the decision (EMAIL-1, see the handler). It stops a
// runaway loop from draining the Resend quota; a reviewer clearing a backlog is not one — and that
// backlog has a ceiling of its own, REVIEWER_DECISIONS_PER_WINDOW (EMAIL1-R1).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;
// ★ ONE REVIEWER'S DECISION EMAILS, EVERY ACCOUNT TOGETHER (EMAIL1-R1). The per-decision guard cannot
//   bound a loop on its own: the key carries the moment the decision was recorded, and
//   admin_review_access_request() stamps approved_at / rejected_at = now() on EVERY call — it has no
//   "already decided" branch — so deciding the same account again mints a new key, a new email, and
//   one the provider has never seen. 60 a minute is far above a reviewer approving signups by hand.
const REVIEWER_DECISIONS_PER_WINDOW = 60;
const rateHits = new Map(); // "<reviewer id>:<decision key>" or "decisions:<reviewer id>" -> [timestamps]
function rateLimited(key, max = RATE_MAX_PER_WINDOW) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  if (rateHits.size > 200) {
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

export default async function handler(req, res) {
  const hasKey = Boolean(process.env.RESEND_API_KEY);

  // Health check (no email, no auth) — visit /api/notify-access in a browser.
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, hasKey, hasFrom: Boolean(process.env.RESEND_FROM) });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Only a reviewer may trigger an email (prevents abuse of the endpoint).
  const gate = await requireStaff(req, { permission: 'access_requests.review' });
  if (!gate.ok) {
    return res.status(gate.status).json({ error: gate.error, code: gate.code });
  }
  // (The burst guard runs once the decision is verified — EMAIL-1, below.)

  // ★ THE BROWSER NAMES AN ACCOUNT AND A DECISION; THE SERVER DECIDES WHO IS EMAILED AND
  //   WHAT IT SAYS (#69). This handler used to take `email`, `fullName` and `reason` straight
  //   from the body, so any access_requests.review holder — an Operations Admin included —
  //   could send the business's own "your access has been approved" email to ANY address,
  //   with any name and any "reason" text (a link rides along in plain text). It is the hole
  //   api/notify-enrollment.js's 'decision' closed on 2026-09-24, and #61's rule: the page
  //   describes; the server resolves. Now the account's row is read with the CALLER's JWT,
  //   the email goes to that account's own address, and it is refused unless the decision it
  //   announces is the one actually recorded on the row.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const userId = body?.userId;
  const status = body?.status;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    // ★ A PAGE OPENED BEFORE #69 IS NOT A MALFORMED REQUEST (TDR-7). Its Access Requests posted
    //   { email, fullName, status, reason } — no userId — and keeps doing so until it is
    //   reloaded. The decision is already recorded by then; only its email is lost, and that
    //   page reads any refusal as "email not sent" with no reason. Refused BY NAME, the
    //   deployment log says why. Recognised by what is MISSING (a userId) beside a decision:
    //   the address in that body is never read, here or anywhere — the server decides who is
    //   emailed.
    if (userId === undefined && (status === 'approved' || status === 'rejected')) {
      console.warn('[notify-access] refused a decision with no userId: the request a page opened before the #69 update sends. Its email was not sent; reload Access Requests.');
      return res.status(400).json({ error: 'This page was opened before an update. Reload it.', code: 'stale_client' });
    }
    return res.status(400).json({ error: 'userId (uuid) required.' });
  }
  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: "status must be 'approved' or 'rejected'." });
  }

  const account = await fetchReviewedAccount(userId, gate.user.token);
  if (!account.ok) {
    return res.status(503).json({ ok: false, error: 'Could not read that account. Try again.' });
  }
  const row = account.row;
  if (!row) return res.status(404).json({ ok: false, error: 'Account not found.' });
  // A migrated account the migration is still setting up: admin_review_access_request()
  // refuses to decide on it (ACCESS_REQUEST_IMPORT_TARGET, #67), so no decision can have been
  // recorded — and announcing one here would happen behind the migration's back. Checked by
  // name, before the comparison below, so the refusal does not depend on which values
  // `status` may take.
  if (row.account_origin === 'import' && row.approval_status === 'pending') {
    return res.status(409).json({
      ok: false, code: 'ACCESS_REQUEST_IMPORT_TARGET',
      error: 'That account is a migrated student still being set up. Manage it from Student Imports.',
    });
  }
  if (row.approval_status !== status) {
    return res.status(409).json({ ok: false, error: 'That decision is not the one recorded on this account.' });
  }
  if (!isEmail(row.email)) {
    return res.status(422).json({ ok: false, error: 'This account has no valid email address on file.' });
  }

  // ★ ONE DECISION IS ONE EMAIL. The key names the account, the decision and the moment it
  //   was recorded, so a double click (or a retry after a dropped connection) repeats the
  //   SAME request and the provider de-duplicates it, while a decision recorded again later —
  //   approved, rejected, approved — is a new email. The timestamp is written as epoch
  //   milliseconds: sendEmail accepts only [A-Za-z0-9:_-] and silently swaps any other key
  //   for a random one, and an ISO timestamp carries a '.' and a '+'.
  const decidedAt = Date.parse(status === 'approved' ? row.approved_at : row.rejected_at);
  const stamp = Number.isFinite(decidedAt) && decidedAt > 0 ? String(Math.trunc(decidedAt)) : '0';
  const decisionKey = `access-decision-${userId.toLowerCase()}-${status}-${stamp}`;
  // ★ THE BURST GUARD COUNTS SENDS OF ONE DECISION, NOT A REVIEWER'S DECISIONS (EMAIL-1). Keyed on
  //   the reviewer alone, the eleventh signup approved in a minute — a backlog cleared one click
  //   after another — was a 429 and an account never told. A decision is announced once; only a
  //   loop asks for the SAME one ten times in a minute.
  // ★ AND THE REVIEWER'S RUN HAS A CEILING OF ITS OWN (EMAIL1-R1): REVIEWER_DECISIONS_PER_WINDOW, every
  //   account together. The decisions themselves do NOT bound it, nor does the provider's 24-hour
  //   de-duplication: admin_review_access_request() re-stamps the decision's moment on every call, so
  //   deciding one account again and again minted a new key each time, and a scripted loop emailed it
  //   without limit. Checked after the per-decision guard, so a loop on one decision never spends it.
  if (rateLimited(`${gate.user.id}:${decisionKey}`)) {
    return res.status(429).json({ ok: false, error: "This decision's email was asked for too many times — wait a minute and try again." });
  }
  if (rateLimited(`decisions:${gate.user.id}`, REVIEWER_DECISIONS_PER_WINDOW)) {
    return res.status(429).json({ ok: false, error: 'Too many decision emails in one minute — wait a minute and try again.' });
  }

  // Env-gated: not configured → non-fatal skip so the approval still succeeds client-side.
  // Checked AFTER the decision is verified, so a forged request is refused the same way
  // whether or not email is set up.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey) return res.status(200).json({ ok: false, skipped: 'email_not_configured' });
  if (!from) return res.status(200).json({ ok: false, skipped: 'email_from_not_configured' });

  // Where a reply goes: payment_settings.notify_email, then NOTIFY_ADMIN_EMAIL — never
  // RESEND_FROM. Read with the reviewer's JWT; null leaves the header out.
  const replyTo = await studentReplyTo(gate.user.token);
  const { subject, html, text } = buildEmail({
    status,
    fullName: row.full_name,
    reason: status === 'rejected' ? row.rejection_reason : null,
    canReply: Boolean(replyTo),
  });

  try {
    const out = await sendEmail({
      to: row.email, subject, html, text, replyTo: replyTo || undefined,
      idempotencyKey: decisionKey,
      tag: 'notify-access', timeoutMs: 10_000, maxAttempts: 2, classify409: true,
    });
    if (out.ok) return res.status(200).json({ ok: true, id: out.id });
    // ★ "ALREADY ON ITS WAY" ONLY WHEN THE PROVIDER SAYS SO (EMAIL-2): a 409 named
    //   concurrent_idempotent_requests — another request is sending this very email, and owns
    //   it. Every other 409 (invalid_idempotent_request: this key was already used with a
    //   different payload) is a refusal of THIS request, answered below as 502 'resend_409'.
    if (out.code === 'resend_409' && out.conflict === 'in_flight') return res.status(200).json({ ok: false, skipped: 'in_flight' });
    // A code, never the provider's sentence: its body names the recipient, and a deployment
    // log is not the place for a student's address.
    console.error(`[notify-access] not sent: ${out.code}`);
    return res.status(502).json({ ok: false, error: 'Email provider rejected the request.', code: out.code });
  } catch (err) {
    console.error(`[notify-access] send failed: ${err?.name || 'error'}`);
    return res.status(502).json({ ok: false, error: 'Email send failed.' });
  }
}
