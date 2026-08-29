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
 * Compose the From header. RESEND_FROM is usually a bare address, and a bare
 * address renders in an inbox as its raw local-part — "noreply" — which is both
 * unbranded and a mild spam signal. If the env var already carries a display
 * name (`Name <addr>`), it is passed through untouched.
 */
export function displayFrom(from) {
  const raw = String(from || '').trim();
  if (!raw || raw.includes('<')) return raw;
  return `${BRAND} <${raw}>`;
}

/**
 * POST one message to Resend, honouring 429/Retry-After with a bounded backoff.
 *
 * `replyTo` (#50): where a human's reply actually lands. Without it, replies go
 * to the (typically unwatched) From address while the message says "contact our
 * team" — a support address the reader has no way to reach.
 *
 * @returns {{ ok: true, id?: string } | { ok: false, code: string }}
 *   `code` is always a short slug safe to store and render. Never a message.
 */
export async function sendEmail({ to, subject, html, text, replyTo, headers, tag = 'email' }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey) return { ok: false, code: 'email_not_configured' };
  if (!from) return { ok: false, code: 'email_from_not_configured' };
  if (!to || !subject || !html) return { ok: false, code: 'email_incomplete' };

  const payload = { from: displayFrom(from), to: [to], subject, html };
  // Resend accepts both parts and builds a multipart/alternative message.
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  if (headers && typeof headers === 'object' && Object.keys(headers).length) {
    payload.headers = headers;
  }

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

/** The one font stack every email block uses. */
const FONT = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";

/**
 * The shared shell every message in this module renders into (#49, rebuilt #50).
 *
 * The #49 shell was a plain `<div>` card: no doctype (so Outlook and older
 * clients rendered in quirks mode), no table layout (Outlook ignores div widths),
 * no preheader (the inbox preview showed the first body sentence), no `lang`, no
 * responsive rules, and nowhere for a support address to live. This is the
 * boring-on-purpose replacement: a full HTML document, `role="presentation"`
 * tables, a hidden preheader, a media query for narrow screens, `color-scheme`
 * meta so dark-mode clients don't invert the card, and a bulletproof table CTA.
 *
 * `bodyHtml` is the ONLY parameter that may contain markup, and callers are
 * responsible for escaping what they put in it — everything else here is esc()'d.
 *
 * @param {object} opts
 * @param {string} opts.heading
 * @param {string} opts.bodyHtml
 * @param {{ href: string, label: string }|null} [opts.cta]
 * @param {string} [opts.footNote]
 * @param {string} [opts.preheader]     inbox-preview line; hidden in the body
 * @param {string} [opts.supportEmail]  rendered as a mailto: in the footer
 */
export function emailShell({ heading, bodyHtml, cta, footNote, preheader, supportEmail }) {
  const preheaderBlock = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : '';
  // A table-for-layout button survives Outlook; a padded <a> alone does not.
  const ctaBlock = cta?.href && cta?.label
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px;">
        <tr><td align="center" style="background:#0A84FF;border-radius:10px;">
          <a href="${esc(cta.href)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(cta.label)}</a>
        </td></tr>
      </table>`
    : '';
  const footBlock = footNote
    ? `<p style="font-family:${FONT};font-size:12px;line-height:1.6;color:#8a93a3;margin:18px 0 0;">${esc(footNote)}</p>`
    : '';
  const supportBlock = supportEmail
    ? `<p style="font-family:${FONT};font-size:12px;line-height:1.6;color:#8a93a3;margin:10px 0 0;">Questions? Contact our team at <a href="mailto:${esc(supportEmail)}" style="color:#0A84FF;text-decoration:none;">${esc(supportEmail)}</a>.</p>`
    : '';

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(heading)}</title>
<style>
  @media only screen and (max-width: 600px) {
    .gh-card { width: 100% !important; border-radius: 0 !important; }
    .gh-inner { padding: 24px 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f7fb;-webkit-text-size-adjust:100%;">
${preheaderBlock}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7fb;">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" class="gh-card" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;background:#ffffff;border-radius:16px;border:1px solid #e6ebf2;">
      <tr><td align="center" style="background:#0A84FF;background:linear-gradient(180deg,#3aa0ff,#0A84FF);padding:26px;border-radius:16px 16px 0 0;">
        <h1 style="margin:0;color:#ffffff;font-family:${FONT};font-size:18px;font-weight:800;">${esc(BRAND)}</h1>
      </td></tr>
      <tr><td class="gh-inner" style="padding:28px;font-family:${FONT};color:#1c2430;">
        <h2 style="font-family:${FONT};font-size:19px;line-height:1.35;margin:0 0 14px;color:#1c2430;">${esc(heading)}</h2>
        ${bodyHtml}
        ${ctaBlock}
        ${footBlock}
        ${supportBlock}
        <p style="font-family:${FONT};font-size:12px;color:#8a93a3;margin:16px 0 0;">— The ${esc(BRAND)} team</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** A paragraph for emailShell's bodyHtml. Escapes its content. */
export function p(textContent) {
  return `<p style="font-family:${FONT};font-size:15px;line-height:1.65;color:#48505e;margin:0 0 16px;">${esc(textContent)}</p>`;
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
