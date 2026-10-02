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
//   #69 moved the two notify handlers' SENDING here (sendEmail: one idempotency key,
//   a text part, a Reply-To) and gave them plainTextEmail() and studentReplyTo()
//   below. Their HTML is still their own: the look of those emails did not change.
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
 * Which limit a Resend 429 describes: 'rate' (the per-second request rate — a Resume a
 * minute later works) or 'quota' (a daily or monthly sending allowance — it does not).
 *
 * ★ #68 (V5/R3): every 429 used to read as the daily quota, so a per-second hit — easy
 *   when a claimed student's two onboarding emails land in the same second as a run's send —
 *   told the owner to wait until tomorrow. Resend names the cause in the error body:
 *   `rate_limit_exceeded` for the rate, `daily_quota_exceeded` / `monthly_quota_exceeded`
 *   for an allowance.
 * ★ ANYTHING UNRECOGNISED IS 'quota'. Saying "wait for the reset" about a rate limit costs a
 *   day; saying "try again in a minute" about a spent quota costs one more refused email.
 *   Only a body that names the rate, and nothing that names an allowance, reads as 'rate'.
 *   A retry-after of more than a minute is not a per-second limit, whatever the body says.
 *
 * Pure: it sees only the error's `name`, its `message` and the retry-after seconds, and
 * returns one of two words — never the body.
 *
 * @param {{ name?: unknown, message?: unknown, retryAfter?: unknown }} [o]
 * @returns {'rate'|'quota'}
 */
export function resendLimitKind({ name, message, retryAfter } = {}) {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const m = typeof message === 'string' ? message.toLowerCase() : '';
  if (/quota/.test(n) || /quota|daily|monthly|allowance/.test(m)) return 'quota';
  const after = Number(retryAfter);
  if (Number.isFinite(after) && after > 60) return 'quota';
  if (/^rate_limit(_exceeded)?$/.test(n)) return 'rate';
  if (!n && /rate limit|too many requests/.test(m)) return 'rate';
  return 'quota';
}

/** Read a 429's error name and message — only to classify it; the body goes nowhere else. */
async function limitKindOf(r) {
  let name = '';
  let message = '';
  try {
    const body = JSON.parse(String(await r.text()).slice(0, 4000));
    name = body?.name;
    message = body?.message;
  } catch { /* unreadable: classified as the quota below */ }
  return resendLimitKind({ name, message, retryAfter: r.headers?.get?.('retry-after') });
}

/**
 * Which conflict a Resend 409 describes (#69, EMAIL-2) — Resend names it in the error body
 * (docs: idempotency keys, "Possible responses"):
 *   'in_flight' — concurrent_idempotent_requests: a request with this key is still being
 *                 processed. THAT request owns the email; it may well be delivered.
 *   'payload'   — invalid_idempotent_request: this key was already used, within the 24 hours
 *                 the provider keeps it, with a DIFFERENT payload. Nobody is sending this one,
 *                 and nothing more will arrive for it.
 *   'unknown'   — anything else, or a body that cannot be read.
 *
 * ★ ONLY THE PROVIDER'S OWN WORDS EARN 'in_flight'. Every 409 used to read as "the same email is
 *   already on its way", which is false for the second kind: a decision made again under an old
 *   key was refused, and the reviewer was told it was being delivered.
 *
 * Pure: it sees only the error's `name`, and returns one of three words — never the body.
 *
 * @param {{ name?: unknown }} [o]
 * @returns {'in_flight'|'payload'|'unknown'}
 */
export function resendConflictKind({ name } = {}) {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (n === 'concurrent_idempotent_requests') return 'in_flight';
  if (n === 'invalid_idempotent_request') return 'payload';
  return 'unknown';
}

/** Read a 409's error name — only to classify it; the body goes nowhere else. */
async function conflictKindOf(r) {
  let name = '';
  try {
    name = JSON.parse(String(await r.text()).slice(0, 4000))?.name;
  } catch { /* unreadable: 'unknown' */ }
  return resendConflictKind({ name });
}

/**
 * POST one message to Resend, honouring 429/Retry-After with a bounded backoff.
 *
 * `replyTo` (#50): where a human's reply actually lands. Without it, replies go
 * to the (typically unwatched) From address while the message says "contact our
 * team" — a support address the reader has no way to reach.
 *
 * @returns {{ ok: true, id?: string } | { ok: false, code: string, limit?: 'rate'|'quota', conflict?: 'in_flight'|'payload'|'unknown' }}
 *   `code` is always a short slug safe to store and render. Never a message.
 *   `limit` rides only on a 'resend_429', and only when `classify429` asks (resendLimitKind).
 *   `conflict` rides only on a 'resend_409', and only when `classify409` asks (resendConflictKind).
 */
export async function sendEmail({
  to, subject, html, text, replyTo, headers, tag = 'email', idempotencyKey: stableKey,
  // #61: a queued sender runs under a hard time limit. `timeoutMs` bounds each request, and
  // `retry429: false` returns a rate limit at once so the caller can re-queue the row with a
  // backoff instead of sleeping inside a function Vercel may kill mid-batch.
  // `maxAttempts: 1` makes one provider request: a queue that retries later with a backoff
  // must not also retry inside a call whose worst-case time it has to budget for.
  // ★ With no `timeoutMs` a request waits as long as fetch does — what every caller had before
  //   #61, and what api/admin/staff.js (a 30 s function, three attempts) still needs: aborting an
  //   invitation mid-flight and repeating it under the same key draws a 409 while the first is
  //   still being processed, which it reports as "not sent" — and the admin invites again.
  timeoutMs = null, retry429 = true, maxAttempts = 3,
  // #67: a flow may send from its own address (since #68 the migration sends from
  // support@<RESEND_FROM's domain>, or MIGRATION_EMAIL_FROM — see api/_lib/legacyClaimEmail.js).
  // Omitted, it is RESEND_FROM exactly as before. The domain must be verified in Resend, or
  // the provider refuses the message with a 403 — and a verified SUBDOMAIN does not cover
  // its parent. A caller that must never fall back to RESEND_FROM's own address checks for
  // a sender before calling: an empty override falls through to it here.
  from: fromOverride = null,
  // #68: `classify429: true` adds `limit: 'rate' | 'quota'` to a returned 'resend_429' — read
  //   from the error body by resendLimitKind(), the body itself going nowhere. Opt-in, so every
  //   other caller keeps the exact answer shape it had.
  classify429 = false,
  // #69 (EMAIL-2): `classify409: true` adds `conflict: 'in_flight' | 'payload' | 'unknown'` to a
  //   returned 'resend_409' — read from the error body by resendConflictKind(). Opt-in for the
  //   same reason: the queue (commSend.js), the migration and the onboarding notice each decide on
  //   the bare 'resend_409' themselves, and keep exactly the answer they had.
  classify409 = false,
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = (typeof fromOverride === 'string' && fromOverride.trim()) || process.env.RESEND_FROM;
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
  // A caller that can retry the SAME logical email across invocations (the #61 queue,
  // after a released claim) passes a stable key; everyone else gets a fresh one.
  const idempotencyKey = (typeof stableKey === 'string' && /^[A-Za-z0-9:_-]{8,128}$/.test(stableKey))
    ? stableKey : randomUUID();

  const ATTEMPTS = Math.max(1, Math.min(3, Math.floor(Number(maxAttempts)) || 3));
  const limitMs = Number(timeoutMs) > 0 && Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null;
  let timedOut = false;
  // ★ #68 (V4): AN ATTEMPT THAT GOT NO ANSWER MAY HAVE BEEN DELIVERED, AND A LATER REFUSAL
  //   DOES NOT UNDO THAT. A request aborted at the time limit (or dropped in transit) can
  //   already have been accepted; the retry under the same key can then be rate-limited, or
  //   refused, while the first one went out. Callers read a 429 or 4xx as PROOF nothing was
  //   sent — the migration hands such a row back and mints a new link, killing the one in
  //   the inbox — so once any attempt went unanswered, a later 429/4xx is reported as the
  //   unclear answer it is ('resend_timeout', or 'resend_failed' for a dropped connection).
  let unanswered = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS - 1;
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
        ...(limitMs ? { signal: AbortSignal.timeout(limitMs) } : {}),
      });
      timedOut = false;
    } catch (e) {
      r = null;
      timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      unanswered = timedOut || unanswered === 'resend_timeout' ? 'resend_timeout' : 'resend_failed';
    }

    if (r && r.ok) {
      let id;
      try { id = (await r.json())?.id; } catch { /* non-JSON success body is fine */ }
      return { ok: true, id };
    }
    if (r && r.status === 429) {
      if (!retry429 || last) {
        if (unanswered) return { ok: false, code: unanswered };
        return classify429 ? { ok: false, code: 'resend_429', limit: await limitKindOf(r) } : { ok: false, code: 'resend_429' };
      }
      const retryAfter = Number(r.headers.get('retry-after')) || (2 ** attempt);
      await new Promise((res) => setTimeout(res, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (r) {
      // Status only. The body can echo the recipient and is not ours to log.
      console.error(`[${tag}] resend ${r.status}`);
      if (unanswered && r.status >= 400 && r.status < 500) return { ok: false, code: unanswered };
      if (classify409 && r.status === 409) return { ok: false, code: 'resend_409', conflict: await conflictKindOf(r) };
      return { ok: false, code: `resend_${r.status}` };
    }
    // No sleep after the final attempt: it would only spend the caller's time budget.
    if (!last) await new Promise((res) => setTimeout(res, (2 ** attempt) * 500));
  }
  return { ok: false, code: timedOut ? 'resend_timeout' : 'resend_failed' };
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
 * A labelled facts card (#67): "Your membership" with plan, batch and dates. Every
 * label and value is escaped. Rows with an empty value are dropped rather than
 * rendered as a dangling label.
 *
 * @param {{ title: string, rows: Array<[string, string|null|undefined]> }} opts
 */
export function detailsCard({ title, rows }) {
  const body = (rows || [])
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `<tr>
        <td style="padding:4px 12px 4px 0;font-size:13px;color:#7b8798;vertical-align:top;white-space:nowrap;">${esc(k)}</td>
        <td style="padding:4px 0;font-size:14px;font-weight:700;color:#12304f;">${esc(v)}</td>
      </tr>`).join('');
  return `<div style="border:1px solid #dce4ef;background:#f7fafd;border-radius:12px;padding:16px 18px;margin:0 0 20px;">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7b8798;font-weight:700;margin:0 0 8px;">${esc(title)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">${body}</table>
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

// Every MANDATORY line break in Unicode (UAX #14: BK = VT, FF, LINE SEPARATOR, PARAGRAPH SEPARATOR;
// CR; LF; NL = NEL), with the whitespace on either side: one run becomes one space. A renderer
// that honours them starts a new line at each, so folding only CR and LF left five ways for a
// typed value to forge a row of the text part (EMAIL-3). NEL is named in the run's class on purpose:
// it is not in JS's \s, so a run of them would not be swallowed otherwise.
// ★ LINEAR, NOT ONE PATTERN (EMAIL3-PERF). The single regex this replaces —
//   /[\s\u0085]*[\r\n\v\f\u0085\u2028\u2029][\s\u0085]*/g — backtracked quadratically on a long run of
//   whitespace holding no break: its leading class swallowed the run and gave it back one character at
//   a time looking for one, from every starting point (80,000 spaces: 18 s). What is folded here
//   includes columns a student types with no length CHECK (city_country, phone, the intake answers).
//   Finding each whitespace run once and testing it once is the same fold, in linear time — a run that
//   holds a break becomes one space, a run that holds none is left as typed.
const WHITESPACE_RUN = /[\s\u0085]+/g;
const MANDATORY_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
const foldLineBreaks = (v) => String(v).replace(WHITESPACE_RUN, (run) => (MANDATORY_BREAK.test(run) ? ' ' : run));

/**
 * The text/plain twin of the notify handlers' emailHtml() (#69): the SAME object in, the
 * same blocks in the same order out, so a sender builds both parts from one set of facts
 * and the two cannot say different things.
 *
 * ★ EVERY LINK THE HTML PART CARRIES IS SPELLED OUT. The video is a thumbnail inside an
 *   <a> there, and the button is an <a> too; a text part can show neither, so each address
 *   is written in full after its label. A reader whose client shows only this part finds the
 *   same destinations in both.
 *
 * ★ A ROW IS ONE LINE. In the HTML part a value sits inside one table cell whatever it
 *   contains; here a line break inside a value would START A LINE — and a value a student
 *   typed ("Manila⏎  * Paid / sent: ₱99,999") would read as a row of its own. Line breaks in
 *   a label or a value are folded into a space — EVERY mandatory one (foldLineBreaks), not
 *   only CR and LF (EMAIL-3), in linear time (EMAIL3-PERF).
 *
 * @param {object} [o]
 * @param {string} [o.heading]
 * @param {string|string[]} [o.intro]   one paragraph, or several (each its own block)
 * @param {Array<[string, string|number|null|undefined]>} [o.rows]  a row with no value is dropped
 * @param {string|null} [o.reason]
 * @param {{ href?: string, label?: string }|null} [o.cta]
 * @param {string|string[]|null} [o.note]   a string, or an array printed one line per line
 * @param {{ id?: string, label?: string }|null} [o.video]  a YouTube video id
 * @returns {string}
 */
export function plainTextEmail({ heading, intro, rows, reason, cta, note, video } = {}) {
  const filled = (v) => v != null && String(v).trim() !== '';
  const oneLine = (v) => foldLineBreaks(v).trim();
  const facts = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && filled(r[1]));
  const noteLines = (Array.isArray(note) ? note : [note]).filter(filled).map(String);
  return plainText([
    heading,
    ...(Array.isArray(intro) ? intro : [intro]),
    video?.id ? `${video.label || 'Watch this first'}: https://www.youtube.com/watch?v=${video.id}` : null,
    ...(facts.length
      ? [{ rule: true }, ...facts.map(([k, v]) => ({ bullet: `${oneLine(k)}: ${oneLine(v)}` })), { rule: true }]
      : []),
    reason ? `Reason: ${reason}` : null,
    cta?.href ? `${cta.label || 'Open the app'}: ${cta.href}` : null,
    noteLines.length ? noteLines.join('\n') : null,
    `Thank you,\nThe ${BRAND} team`,
  ]);
}

// One bare address. A Reply-To that carries a comma, a bracket or a space is read by a mail
// client as several addresses, or refused by the provider for the whole message.
const REPLY_ADDRESS_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Where a student's reply to one of our emails lands (#69) — the Reply-To of every
 * student-facing notification (the enrollment confirmation, the enrollment decision, the
 * access decision): the admin-editable payment_settings.notify_email ("Proof / support
 * email"), then NOTIFY_ADMIN_EMAIL, else null.
 *
 * ★ NEVER RESEND_FROM. The admin ALERT falls back to that address because an alert with no
 *   recipient is not sent at all. A reply is different: RESEND_FROM is typically a no-reply
 *   mailbox, and "just reply to this email" pointed at one is a promise the email breaks.
 *   On null the caller leaves the header out AND drops the sentence that invites a reply.
 *
 * ★ THE CALLER'S OWN JWT, NEVER THE SERVICE KEY. payment_settings_read admits every
 *   signed-in account, so a student's token and a reviewer's both work, and neither notify
 *   handler has to build a service-role client to address an email. (The service-client
 *   form of the same chain is ./supportAddress.js, for senders that already hold one.)
 *
 * ★ `stored` IS HOW A CALLER AVOIDS A SECOND READ. api/notify-enrollment.js's 'submitted'
 *   already reads this row once to find the admin recipient; it passes what that read found
 *   (the address, or null) and nothing is fetched here. Left undefined, the row is read
 *   once, with a time limit: a reply address is not worth holding a send for.
 *
 * The Supabase settings are read when called, not when this module loads: the builders
 * here are imported by tests and scripts that set no environment at all.
 *
 * @param {string} token  the caller's Supabase access token
 * @param {{ stored?: string|null, timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export async function studentReplyTo(token, { stored, timeoutMs = 3_000 } = {}) {
  const usable = (v) => {
    const address = typeof v === 'string' ? v.trim() : '';
    return REPLY_ADDRESS_RE.test(address) ? address : null;
  };
  let value = stored;
  if (value === undefined) {
    value = null;
    const base = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
    if (token && base && anon) {
      try {
        const r = await fetch(`${base}/rest/v1/payment_settings?key=eq.notify_email&select=value`, {
          headers: { apikey: anon, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : 3_000),
        });
        if (r.ok) {
          const rows = await r.json();
          value = Array.isArray(rows) ? rows[0]?.value : null;
        }
      } catch { /* best-effort: fall through to the configured address */ }
    }
  }
  return usable(value) || usable(process.env.NOTIFY_ADMIN_EMAIL);
}
