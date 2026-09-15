// ─────────────────────────────────────────────────────────────────────────────
// Vercel Cron endpoint — the daily email automation run (#61)
// ─────────────────────────────────────────────────────────────────────────────
// Scheduled by vercel.json at 01:00 UTC (09:00 in Manila). It enqueues today's
// automation matches through the service-only comm_enqueue_automations(), then sends
// everything waiting — which also finishes any campaign a Super Admin closed the tab on.
//
// ★ VERCEL CRON CALLS GET, so the work happens on GET. There is no user and no JWT;
//   the gate is `Authorization: Bearer <CRON_SECRET>`, which Vercel attaches by itself
//   when the CRON_SECRET environment variable is set.
//
// ★ IT FAILS CLOSED. No CRON_SECRET (or one too short to be a secret) → 401 and nothing
//   runs — the SAME answer as a wrong secret, so an anonymous caller cannot learn whether
//   the schedule is configured. The reason goes to the server log. A missing secret must not
//   turn this into an unauthenticated "send the queue" endpoint.
//
// ★ The comparison is constant-time over SHA-256 digests, so neither the secret's
//   content nor its length leaks through timing.
//
// ★ NOTHING IS QUEUED WHILE EMAIL IS UNCONFIGURED. A queued "ends in 5 days" notice
//   that sits until someone sets RESEND_API_KEY would go out days late and wrong, and
//   would eat that day's cap. The catch-up window re-matches the days once email works.
//
// ★ service() is constructed only after that check — the same "gate first" rule
//   api/_lib/staffAuth.js documents, with the cron secret standing in for the JWT.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, timingSafeEqual } from 'node:crypto';
import { service, serviceConfigured } from '../_lib/staffAuth.js';
import { emailConfigured } from '../_lib/email.js';
import { processQueue, queueRemaining, rpcError } from '../_lib/commSend.js';

const BUDGET_MS = 50_000;   // vercel.json gives this function 60 s
const ENQUEUE_TIMEOUT_MS = 15_000;
const MIN_SECRET_LENGTH = 16;

/**
 * Whether a configured CRON_SECRET is one the gate will accept — the ONE rule the gate and the
 * signed-in status check share, so Settings never reports a refused secret as "configured".
 */
export function cronSecretUsable(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

/** Constant-time check of the Authorization header against the configured secret. */
export function cronAuthorized(header, secret) {
  if (!cronSecretUsable(secret)) return false;
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  const got = createHash('sha256').update(String(header || '')).digest();
  return timingSafeEqual(expected, got);
}

export default async function handler(req, res) {
  const started = Date.now();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  const secret = process.env.CRON_SECRET || '';
  if (!cronSecretUsable(secret)) {
    console.error('[comm-cron] CRON_SECRET is not set (or shorter than 16 characters) — refusing to run.');
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  if (!cronAuthorized(req.headers?.authorization, secret)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  if (!serviceConfigured()) {
    return res.status(500).json({ ok: false, error: 'Supabase service credentials are not configured.' });
  }
  if (!emailConfigured()) {
    console.error('[comm-cron] email is not configured (RESEND_API_KEY / RESEND_FROM) — nothing queued or sent.');
    return res.status(200).json({ ok: true, configured: false, queued: 0, sent: 0 });
  }

  try {
    const admin = service();
    const { data: summary, error } = await admin.rpc('comm_enqueue_automations', { p_on: null })
      .abortSignal(AbortSignal.timeout(ENQUEUE_TIMEOUT_MS));
    // ★ A failed enqueue queued nothing (it is one transaction), and the next run catches today up
    //   (last_complete_on did not move). It must not stop this run sending what was ALREADY waiting,
    //   because the schedule runs once a day. A missing migration is still a hard stop.
    const enqueueFailed = Boolean(error);
    if (error) {
      const e = rpcError(error, 'comm_enqueue_automations');
      if (e.migrationMissing) throw e;
      console.error(`[comm-cron] the enqueue failed (${e.code || 'error'}) — sending what was already waiting`);
    }

    const out = await processQueue(admin, { campaignId: null, deadlineMs: started + BUDGET_MS });
    const waiting = await queueRemaining(admin, null);
    // Counts only — never an address.
    console.log(`[comm-cron] ${enqueueFailed ? 'enqueue FAILED, ' : ''}queued ${summary?.queued ?? 0}, capped ${summary?.capped ?? 0}, `
      + `sent ${out.sent}, failed ${out.failed}, retrying ${out.retrying}, stopped ${out.stopped}, `
      + `handed back ${out.deferred}, left claimed ${out.left}${out.halted ? ' (the database stopped answering)' : ''}, `
      + `waiting ${waiting.remaining ?? '?'} (${waiting.retryLater ?? '?'} on backoff)`);
    return res.status(200).json({
      ok: true, enqueue_failed: enqueueFailed, queued: summary?.queued ?? 0, capped: summary?.capped ?? 0,
      sent: out.sent, failed: out.failed, retrying: out.retrying, stopped: out.stopped,
      halted: out.halted, left: out.left,
      deferred: out.deferred, remaining: waiting.remaining, retry_later: waiting.retryLater,
    });
  } catch (err) {
    console.error(`[comm-cron] run failed: ${err?.code || 'error'}`);
    return res.status(err?.migrationMissing ? 501 : 500).json({ ok: false, error: 'The automation run failed.' });
  }
}
