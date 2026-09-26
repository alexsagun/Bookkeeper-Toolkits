// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/supportAddress.js — where a student's reply goes. Server only.
// ─────────────────────────────────────────────────────────────────────────────
// payment_settings.notify_email (the admin-editable "Proof / support email"), then
// NOTIFY_ADMIN_EMAIL. Moved out of api/_lib/commSend.js by #67 so the migration's
// claim emails and #61's student emails answer "who do I reply to" identically.
//
// `ok: false` means the stored address could not be READ and there is no configured
// fallback. Callers stop rather than mail students with nowhere for a reply to go.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} admin  a service-role supabase client
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, address: string|null }>}
 */
export async function supportAddress(admin, { timeoutMs = 3_000 } = {}) {
  let stored = null;
  let readOk = true;
  try {
    const { data, error } = await admin.from('payment_settings').select('value').eq('key', 'notify_email')
      .abortSignal(AbortSignal.timeout(timeoutMs)).maybeSingle();
    if (error) readOk = false; else stored = data?.value;
  } catch { readOk = false; }
  const valid = (c) => { const a = String(c || '').trim().toLowerCase(); return EMAIL_RE.test(a) ? a : null; };
  const fallback = valid(process.env.NOTIFY_ADMIN_EMAIL);
  if (!readOk) return fallback ? { ok: true, address: fallback } : { ok: false, address: null };
  return { ok: true, address: valid(stored) || fallback };
}
