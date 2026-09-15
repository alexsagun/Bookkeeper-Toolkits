// src/lib/commTemplates.js — message templates and the ONE renderer for Communications (#61).
//
// Pure: no imports, no DOM, no Node APIs. The browser uses it to PREVIEW a message and
// api/_lib/commSend.js uses it to BUILD the message that is sent, so what the Super Admin
// sees and what a student receives cannot drift apart.
//
// ★ EVERY TAG VALUE IS ESCAPED, AND ONLY https: IS EVER LINKED. The legacy Apps Script
//   rendered form answers straight into HTML. Here a student's name containing
//   `<img src=x onerror=…>` is text, and a `javascript:` "link" in a message body is text.
//
// ★ NO PAYMENT DETAILS LIVE HERE. {{payment_instructions}} is filled at send time from
//   payment_settings by the server. The preview shows a placeholder, never the values.

export const COMM_TAGS = Object.freeze([
  'name', 'first_name', 'plan', 'batch', 'days', 'expiry', 'week', 'amount_due', 'payment_instructions',
]);

export const COMM_TAG_HELP = Object.freeze({
  name: "The student's full name",
  first_name: "The student's first name",
  plan: 'Their package',
  batch: 'Their batch (VIP), if any',
  days: 'Days of access left',
  expiry: 'The date their access ends',
  week: 'Which program week they are in',
  amount_due: 'The balance still owed (payment reminders)',
  payment_instructions: 'Your payment details from Enrollments → Payment details',
});

/** Templates by the kind of message they start. `custom` is a blank page for any kind. */
export const COMM_TEMPLATES = Object.freeze([
  Object.freeze({ key: 'welcome', kind: 'announcement', label: 'Welcome',
    subject: 'Welcome to {{plan}}',
    body: 'Hi {{first_name}},\n\nWelcome aboard! Your enrollment is confirmed and your access is active.\n\n'
      + 'Start with the first lesson today, and reply to this email if you have any questions — we read every one.' }),
  Object.freeze({ key: 'study_reminder', kind: 'announcement', label: 'Study reminder',
    subject: 'A quick reminder to keep going',
    body: 'Hi {{first_name}},\n\nThis is a friendly reminder to keep up with your lessons. A little every day is the '
      + 'fastest way through the program.\n\nYou have {{days}} days of access left.' }),
  Object.freeze({ key: 'program_update', kind: 'announcement', label: 'Program update',
    subject: 'An update about your program',
    body: 'Hi {{first_name}},\n\nWe have an update about {{plan}}:\n\n[Write your update here]\n\n'
      + 'Thank you for being part of the community.' }),
  Object.freeze({ key: 'expiry_notice', kind: 'automation', label: 'Access expiring',
    subject: 'Your access ends in {{days}} days',
    body: 'Hi {{first_name}},\n\nA heads-up: your access to {{plan}} ends on {{expiry}}. Please finish any remaining '
      + 'lessons before then.\n\nIf you would like more time, you can extend your access from your account menu.' }),
  Object.freeze({ key: 'program_week', kind: 'automation', label: 'Program week',
    subject: 'Week {{week}} of your program',
    body: 'Hi {{first_name}},\n\nYou are now in week {{week}} of {{plan}}. Keep going — consistency is what gets '
      + 'people hired.\n\nReply to this email if you are stuck on anything.' }),
  Object.freeze({ key: 'payment_reminder', kind: 'payment_reminder', label: 'Payment reminder',
    subject: 'A friendly reminder about your remaining balance',
    body: 'Hi {{first_name}},\n\nThis is a friendly reminder about the remaining balance of {{amount_due}} for '
      + '{{plan}}.\n\nYou can pay using the details below, then reply to this email with your receipt:\n\n'
      + '{{payment_instructions}}\n\nThank you!' }),
  Object.freeze({ key: 'follow_up', kind: 'student_email', label: 'Follow up',
    subject: 'Following up on your enrollment',
    body: 'Hi {{first_name}},\n\nJust following up on your enrollment for {{plan}}. Let us know if you have any '
      + 'questions or need help completing the process.' }),
  Object.freeze({ key: 'missing_proof', kind: 'student_email', label: 'Payment proof missing',
    subject: 'Action needed: your payment proof',
    body: 'Hi {{first_name}},\n\nThank you for signing up for {{plan}}. We could not find your payment proof. Please '
      + 'reply with a clear screenshot of your payment so we can finish your enrollment.' }),
  Object.freeze({ key: 'incomplete_requirements', kind: 'student_email', label: 'Requirements incomplete',
    subject: 'Action needed: complete your enrollment',
    body: 'Hi {{first_name}},\n\nWe are reviewing your enrollment for {{plan}}, but some requirements are still '
      + 'incomplete. Please complete them so we can continue.' }),
  Object.freeze({ key: 'on_hold', kind: 'student_email', label: 'On hold — package unavailable',
    subject: 'Your enrollment is on hold',
    body: 'Hi {{first_name}},\n\nThank you for signing up for {{plan}}. Your enrollment is on hold because the '
      + 'package is not available right now. Reply to this email and we will go through your options.' }),
  Object.freeze({ key: 'custom', kind: '*', label: 'Blank message', subject: '', body: '' }),
]);

export function templatesFor(kind) {
  return COMM_TEMPLATES.filter((t) => t.kind === kind || t.kind === '*'
    || (kind === 'announcement' && t.kind === 'automation'));
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Case-insensitive on purpose: `{{First_Name}}` is not a tag the renderer fills, and it must
// be FLAGGED as unknown rather than silently left out of both the fill and the warning.
const TAG_RE = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

/** Tag values with safe fallbacks. A missing name reads "there", never "undefined". */
export function normalizeVars(vars = {}) {
  const v = vars || {};
  const name = String(v.name || '').trim();
  const first = String(v.first_name || name.split(/\s+/)[0] || '').trim();
  return {
    name: name || 'there',
    first_name: first || 'there',
    plan: String(v.plan || 'your program'),
    batch: String(v.batch || ''),
    days: v.days === null || v.days === undefined || v.days === '' ? '' : String(v.days),
    expiry: String(v.expiry || ''),
    week: v.week === null || v.week === undefined || v.week === '' ? '' : String(v.week),
    amount_due: String(v.amount_due || ''),
    payment_instructions: String(v.payment_instructions || ''),
  };
}

/** Plain-text fill. Unknown tags stay visible, so a typo shows up in the preview. */
export function fillTags(text, vars) {
  const v = normalizeVars(vars);
  return String(text || '').replace(TAG_RE, (whole, tag) => (COMM_TAGS.includes(tag) ? v[tag] : whole));
}

/** True when a subject asks for payment details, which may only go in the body. */
export function subjectHasPaymentTag(subject) {
  return /\{\{\s*payment_instructions\s*\}\}/.test(String(subject || ''));
}

/** Tags used in a text that the renderer does not know — surfaced before sending. */
export function unknownTags(text) {
  return [...new Set([...String(text || '').matchAll(TAG_RE)].map((m) => m[1]).filter((t) => !COMM_TAGS.includes(t)))];
}

const FONT = "-apple-system,'Segoe UI',Roboto,Arial,sans-serif";

/** Escape a line and link only real https URLs. */
function linkify(line) {
  const out = [];
  let last = 0;
  for (const m of line.matchAll(/https:\/\/[^\s<>"']+/g)) {
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    let ok = false;
    try { ok = new URL(url).protocol === 'https:'; } catch { ok = false; }
    out.push(escHtml(line.slice(last, m.index)));
    out.push(ok
      ? `<a href="${escHtml(url)}" style="color:#0A84FF;">${escHtml(url)}</a>`
      : escHtml(url));
    last = m.index + url.length;
  }
  out.push(escHtml(line.slice(last)));
  return out.join('');
}

/**
 * Render a message for ONE recipient.
 * @returns {{ subject: string, text: string, bodyHtml: string }}
 *   `bodyHtml` is the inner body for the server's branded email shell (or the preview).
 */
export function renderMessage({ subject, body, vars }) {
  const v = normalizeVars(vars);
  // ★ Payment details are never put in a subject (inbox lists, lock screens); the server
  //   refuses such a subject too. Defence in depth: the tag fills with nothing here.
  const filledSubject = fillTags(subject, { ...v, payment_instructions: '' }).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  // The payment block is rendered as its own box, so it is split out before filling.
  const paragraphs = String(body || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const htmlParts = [];
  const textParts = [];
  for (const para of paragraphs) {
    if (/^\s*\{\{\s*payment_instructions\s*\}\}\s*$/.test(para)) {
      const lines = v.payment_instructions.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) {
        htmlParts.push(`<div style="border:1px solid #dce4ef;background:#f7fafd;border-radius:12px;padding:14px 16px;margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:1.7;color:#1c2430;">${lines.map(linkify).join('<br>')}</div>`);
        textParts.push(lines.join('\n'));
      }
      continue;
    }
    const filled = fillTags(para, v).trim();
    if (!filled) continue;
    htmlParts.push(`<p style="font-family:${FONT};font-size:15px;line-height:1.65;color:#48505e;margin:0 0 16px;">${filled.split('\n').map(linkify).join('<br>')}</p>`);
    textParts.push(filled);
  }
  return { subject: filledSubject, text: `${textParts.join('\n\n')}\n`, bodyHtml: htmlParts.join('\n') };
}

/**
 * A whole preview document for `<iframe sandbox="" srcDoc>`. A plain stand-in for the
 * server's email shell (api/_lib/email.js imports Node's crypto, so the browser cannot
 * load it); the BODY is the same renderMessage() output the server sends.
 */
export function renderPreviewDocument({ subject, body, vars, brand = 'Toolkits by Alex' }) {
  const msg = renderMessage({ subject, body, vars });
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="color-scheme" content="light"><title>Preview</title></head>'
    + `<body style="margin:0;padding:18px 10px;background:#f4f7fb;font-family:${FONT};">`
    + '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6ebf2;border-radius:14px;overflow:hidden;">'
    + `<div style="background:#0A84FF;color:#ffffff;padding:16px 22px;font-weight:800;font-size:16px;">${escHtml(brand)}</div>`
    + '<div style="padding:22px;">'
    + `<h2 style="font-size:18px;line-height:1.35;margin:0 0 14px;color:#1c2430;">${escHtml(msg.subject || '(no subject)')}</h2>`
    + (msg.bodyHtml || '<p style="color:#8a93a3;">(empty message)</p>')
    + '</div></div></body></html>';
}

/** A sample recipient for previews. Payment details are a placeholder, never the real values. */
export const COMM_PREVIEW_VARS = Object.freeze({
  name: 'Maria Santos', plan: 'QBO + Resume Combo', batch: '2026-10', days: 5,
  expiry: 'Oct 20, 2026', week: 3, amount_due: '₱2,000.00',
  payment_instructions: '[Your payment details from Enrollments → Payment details appear here]',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const COMM_MANUAL_EMAIL_LIMIT = 50;

/** A pasted list of addresses: deduplicated, lower-cased, capped. */
export function parseManualEmails(text) {
  const seen = new Set(); const emails = []; const invalid = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) { invalid.push(raw.trim()); continue; }
    if (seen.has(e)) continue;
    seen.add(e); emails.push(e);
  }
  return { emails: emails.slice(0, COMM_MANUAL_EMAIL_LIMIT), invalid, overLimit: emails.length > COMM_MANUAL_EMAIL_LIMIT };
}
