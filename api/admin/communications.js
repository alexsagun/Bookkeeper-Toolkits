// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — COMMUNICATIONS SENDING (#61)
// ─────────────────────────────────────────────────────────────────────────────
// Everything a Super Admin DECIDES — who receives a message, what it says, which
// automations exist — happens in SECURITY DEFINER RPCs the browser calls directly
// (comm_create_campaign, comm_save_rule, …). This handler exists only because
// sending needs two things the browser must never hold: the Resend key, and the
// service-role key that claims and records deliveries.
//
// Every action:
//   1. verifies the caller's JWT and independently confirms communications.send via
//      my_staff_context() (requireStaff), BEFORE the service-role client is built;
//   2. SENDS ONLY ROWS THAT ALREADY EXIST. It accepts no recipient, subject or body.
//      The legacy Apps Script took all three from the browser, which made it an open
//      relay for the owner's mailbox.
//
// Actions (POST body.action):
//   'status'          — { configured, hasResend, hasCronSecret }, for a signed-in sender only
//   'send'            — send queued deliveries: one campaign (body.campaign_id) or, with
//                       no id, everything waiting. Paced for Resend and bounded by time;
//                       the client calls again while `remaining` > `retry_later`.
//   'run-automations' — enqueue today's automation matches, then send. The same code the
//                       daily cron runs.
//   GET               — { ok } only. Which secrets are configured is not public.
//
// ★ A payment reminder reads what a student owes, so sending one — or flushing the whole
//   queue, which may hold one — also needs finance.manage. comm_create_campaign enforces
//   the same rule when the reminder is created.
//
// Runs on Vercel AND under `npm run dev` (commDevApi in vite.config.js).
// ─────────────────────────────────────────────────────────────────────────────

import { requireStaff, service, serviceConfigured } from '../_lib/staffAuth.js';
import { emailConfigured } from '../_lib/email.js';
import { processQueue, queueRemaining, rpcError } from '../_lib/commSend.js';
import { cronSecretUsable } from '../cron/communications.js';
import { staffCan } from '../../src/lib/staffRoles.js';

const MAX_BODY_BYTES = 16 * 1024;
// vercel.json gives this function 60 s. The clock starts at handler ENTRY, so the gate's
// own round trips count against it.
const BUDGET_MS = 48_000;
const ENQUEUE_TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-warm-instance burst guard. A send loop calls this every ~45 s, so 30 a minute
// never limits a human and still stops a scripted hammer.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 30;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const hits = (rateHits.get(userId) || []).filter((t) => t >= now - RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

/** Read one campaign with the CALLER's JWT, so RLS decides whether they may see it. */
async function campaignForCaller(user, id) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  const r = await fetch(
    `${url}/rest/v1/comm_campaigns?id=eq.${encodeURIComponent(id)}&select=id,kind,cancelled_at`,
    { headers: { apikey: anon, Authorization: `Bearer ${user.token}` } },
  );
  if (r.status === 404) return { missing: true };
  if (!r.ok) return { failed: true };
  const rows = await r.json().catch(() => null);
  return { row: Array.isArray(rows) ? rows[0] || null : null };
}

const NOT_CONFIGURED = {
  error: 'Email sending is not configured on the server. Set RESEND_API_KEY and RESEND_FROM.',
  code: 'email_not_configured',
};

const waitingPayload = (q) => ({ remaining: q.remaining, retry_later: q.retryLater });

export default async function handler(req, res) {
  const started = Date.now();
  if (req.method === 'GET') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  if (!serviceConfigured()) {
    return res.status(500).json({ error: 'Supabase service credentials are not configured.' });
  }

  // Auth: valid JWT + independently-confirmed communications.send, BEFORE service().
  const gate = await requireStaff(req, { permission: 'communications.send' });
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
  const u = gate.user;
  if (rateLimited(u.id)) return res.status(429).json({ error: 'Too many requests — wait a minute.' });

  if (Number(req.headers?.['content-length']) > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request too large.' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};
  const action = body.action;
  const canFinance = staffCan(gate.context, 'finance.manage');

  try {
    if (action === 'status') {
      return res.status(200).json({
        ok: true,
        configured: serviceConfigured(),
        hasResend: emailConfigured(),
        hasCronSecret: cronSecretUsable(process.env.CRON_SECRET),
      });
    }

    if (action === 'send') {
      let campaignId = null;
      if (body.campaign_id != null && body.campaign_id !== '') {
        if (!UUID_RE.test(String(body.campaign_id))) {
          return res.status(400).json({ error: 'campaign_id must be a campaign id.' });
        }
        const found = await campaignForCaller(u, String(body.campaign_id));
        if (found.missing) {
          return res.status(501).json({ error: 'Communications is not set up in this database yet.', code: 'MIGRATION_MISSING' });
        }
        if (found.failed) return res.status(502).json({ error: 'Could not read the campaign. Try again.' });
        if (!found.row) return res.status(404).json({ error: 'That campaign does not exist.', code: 'COMM_NOT_FOUND' });
        if (found.row.cancelled_at) {
          return res.status(409).json({ error: 'That campaign was cancelled, so nothing more is sent.', code: 'COMM_CAMPAIGN_CLOSED' });
        }
        if (found.row.kind === 'payment_reminder' && !canFinance) {
          return res.status(403).json({ error: 'Payment reminders also require the finance.manage permission.', code: 'FORBIDDEN' });
        }
        campaignId = found.row.id;
      } else if (!canFinance) {
        return res.status(403).json({ error: 'Sending everything waiting also requires the finance.manage permission.', code: 'FORBIDDEN' });
      }
      if (!emailConfigured()) return res.status(503).json(NOT_CONFIGURED);

      const admin = service();
      const out = await processQueue(admin, { campaignId, deadlineMs: started + BUDGET_MS });
      const waiting = await queueRemaining(admin, campaignId);
      return res.status(200).json({
        ok: true, sent: out.sent, failed: out.failed, retrying: out.retrying, deferred: out.deferred,
        stopped: out.stopped, halted: out.halted, left: out.left, ...waitingPayload(waiting),
      });
    }

    if (action === 'run-automations') {
      if (!canFinance) {
        return res.status(403).json({ error: 'Running automations also requires the finance.manage permission.', code: 'FORBIDDEN' });
      }
      if (!emailConfigured()) return res.status(503).json(NOT_CONFIGURED);
      const admin = service();
      const { data: summary, error } = await admin.rpc('comm_enqueue_automations', { p_on: null })
        .abortSignal(AbortSignal.timeout(ENQUEUE_TIMEOUT_MS));
      if (error) throw rpcError(error, 'comm_enqueue_automations');
      const out = await processQueue(admin, { campaignId: null, deadlineMs: started + BUDGET_MS });
      const waiting = await queueRemaining(admin, null);
      return res.status(200).json({
        ok: true,
        queued: summary?.queued ?? 0,
        capped: summary?.capped ?? 0,
        rules: Array.isArray(summary?.rules) ? summary.rules.length : 0,
        sent: out.sent, failed: out.failed, retrying: out.retrying, deferred: out.deferred,
        stopped: out.stopped, halted: out.halted, left: out.left, ...waitingPayload(waiting),
      });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err?.migrationMissing) return res.status(501).json({ error: err.message, code: 'MIGRATION_MISSING' });
    console.error(`[comm] ${String(action).slice(0, 24)} failed: ${err?.code || 'error'}`);
    return res.status(500).json({
      error: 'Sending stopped before it finished. Try again — anything already sent will not be sent twice.',
      code: err?.hint || undefined,
    });
  }
}
