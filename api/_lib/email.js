// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/email.js — shared server-side email primitives (#49).
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from api/admin/student-imports.js, which was the only sender in the
// repo with 429/Retry-After backoff, and given the one thing NO sender here had:
// a plain-text alternative part.
//
// ★ SCOPE IS DELIBERATELY NARROW. api/notify-enrollment.js and api/notify-access.js
//   keep their own private copies of esc() and their own emailHtml(). Rewriting
//   three working senders to share one abstraction is a broad email refactor with
//   its own risk, and it is not what this change is for. This module exists so
//   the STAFF invitation can be branded and testable; when a fourth sender needs
//   it, that is the moment to migrate the other two.
//
// ★ WHY PLAIN TEXT MATTERS HERE. Every sender in this repo posts { from, to,
//   subject, html } and nothing else. A message with no text/plain part is a
//   well-known spam-filter signal, and the staff invitation is precisely the
//   message that has been landing in spam. It is not a fix on its own — the
//   audit showed SPF, DKIM and DMARC all passing, so placement is driven by
//   content and reputation — but shipping HTML-only while complaining about spam
//   filtering would be choosing not to do the easy half.
//
// ★ NOTHING IN HERE MAY LOG A LINK. Callers pass one-time action links through
//   these builders. On failure this module returns a short SAFE CODE
//   ('resend_422', 'email_not_configured') and never the URL, the recipient, or
//   the provider's response body.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

export const BRAND = 'Toolkits by Alex';

/**
 * HTML-escape a value for interpolation into an email body.
 * Byte-identical to the three private copies in api/ — kept that way on purpose
 * so migrating a sender to this module is a pure deletion.
 */
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * True when Resend can actually send. Callers check this BEFORE doing anything
 * that would be wasted, and surface a precise reason rather than a silent no-op —
 * the enrollment confirmation email was believed not to exist for weeks because
 * an unconfigured sender looked exactly like a missing feature.
 */
export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

/**
 * POST one message to Resend, honouring 429/Retry-After with a bounded backoff.
 *
 * @returns {{ ok: true, id?: string } | { ok: false, code: string }}
 *   `code` is always a short slug safe to store and render. Never a message.
 */
export async function sendEmail({ to, subject, html, text, tag = 'email' }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey) return { ok: false, code: 'email_not_configured' };
  if (!from) return { ok: false, code: 'email_from_not_configured' };
  if (!to || !subject || !html) return { ok: false, code: 'email_incomplete' };

  const payload = { from, to: [to], subject, html };
  // Resend accepts both parts and builds a multipart/alternative message.
  if (text) payload.text = text;

  // ★ ONE key for all three attempts. A fetch() that rejects AFTER Resend has
  //   accepted the request is indistinguishable from one it never received, so a
  //   blind retry can deliver the same invitation twice. Resend de-duplicates on
  //   this header, which turns "retry" back into "retry" rather than "resend".
  //   (CodeRabbit, PR #4.)
  const idempotencyKey = randomUUID();

  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch { r = null; }

    if (r && r.ok) {
      let id;
      try { id = (await r.json())?.id; } catch { /* non-JSON success body is fine */ }
      return { ok: true, id };
    }
    if (r && r.status === 429) {
      const retryAfter = Number(r.headers.get('retry-after')) || (2 ** attempt);
      await new Promise((res) => setTimeout(res, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (r) {
      // Status only. The body can echo the recipient and is not ours to log.
      console.error(`[${tag}] resend ${r.status}`);
      return { ok: false, code: `resend_${r.status}` };
    }
    await new Promise((res) => setTimeout(res, (2 ** attempt) * 500));
  }
  return { ok: false, code: 'resend_failed' };
}

/**
 * The shared shell every message in this module renders into. Mirrors the card
 * used by notify-enrollment.js so a staff email and an enrollment email look
 * like the same product.
 *
 * `bodyHtml` is the ONLY parameter that may contain markup, and callers are
 * responsible for escaping what they put in it — everything else here is esc()'d.
 */
export function emailShell({ heading, bodyHtml, cta, footNote }) {
  const ctaBlock = cta?.href && cta?.label
    ? `<div style="text-align:center;margin:0 0 22px;">
         <a href="${esc(cta.href)}" style="display:inline-block;background:#0A84FF;color:#fff;border-radius:10px;padding:13px 26px;font-size:15px;font-weight:700;text-decoration:none;">${esc(cta.label)}</a>
       </div>`
    : '';
  const footBlock = footNote
    ? `<p style="font-size:12px;line-height:1.6;color:#8a93a3;margin:18px 0 0;">${esc(footNote)}</p>`
    : '';

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f7fb;padding:32px 0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6ebf2;">
    <div style="background:linear-gradient(180deg,#3aa0ff,#0A84FF);padding:26px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800;">${esc(BRAND)}</h1>
    </div>
    <div style="padding:28px;color:#1c2430;">
      <h2 style="font-size:19px;line-height:1.35;margin:0 0 14px;">${esc(heading)}</h2>
      ${bodyHtml}
      ${ctaBlock}
      ${footBlock}
      <p style="font-size:12px;color:#8a93a3;margin:16px 0 0;">— The ${esc(BRAND)} team</p>
    </div>
  </div>
</div>`;
}

/** A paragraph for emailShell's bodyHtml. Escapes its content. */
export function p(textContent) {
  return `<p style="font-size:15px;line-height:1.65;color:#48505e;margin:0 0 16px;">${esc(textContent)}</p>`;
}

/**
 * The role card — the one piece of visual structure that earns its place in an
 * invitation, because "which role" is the single fact the reader needs and it is
 * the fact Supabase's default template could not carry at all.
 */
// ★ Role LABEL and DESCRIPTION only. The per-permission list that Team & Roles
//   shows an admin is deliberately not here: an invitation can be forwarded, or
//   sent to a mistyped address, and an itemised map of who may approve payments
//   is not something to put in front of whoever receives it.
export function roleCard({ label, description }) {
  return `<div style="border:1px solid #dce4ef;background:#f7fafd;border-radius:12px;padding:16px 18px;margin:0 0 20px;">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7b8798;font-weight:700;margin:0 0 6px;">Your role</div>
    <div style="font-size:17px;font-weight:800;color:#12304f;margin:0 0 6px;">${esc(label)}</div>
    <div style="font-size:13px;line-height:1.6;color:#48505e;">${esc(description)}</div>
  </div>`;
}

/**
 * Render a plain-text alternative from ordered blocks.
 * Kept as its own builder rather than stripping tags out of the HTML, because a
 * tag-stripped body reads like a broken page and is itself a spam signal.
 *
 * @param {Array<string|{ bullet: string }|{ rule: true }>} blocks
 */
export function plainText(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b == null || b === '') continue;
    if (typeof b === 'string') { lines.push(b, ''); continue; }
    if (b.rule) { lines.push('-'.repeat(46), ''); continue; }
    if (b.bullet) { lines.push(`  * ${b.bullet}`); continue; }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
