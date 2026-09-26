// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/commSend.js — the ONE sender for Communications (#61). Server-only.
// ─────────────────────────────────────────────────────────────────────────────
// Shared by api/admin/communications.js (a Super Admin pressing Send) and
// api/cron/communications.js (the daily automation run).
//
// ★ IT NEVER DECIDES WHO RECEIVES ANYTHING. A delivery row exists only because a
//   gated RPC (comm_create_campaign) or the service-only automation enqueue made
//   it, and comm_claim_deliveries re-checks every row (cancelled, rule inactive, no
//   longer eligible, nothing due) at the moment it hands it over.
//
// ★ THE MESSAGE IS RENDERED BY src/lib/commTemplates.js — the same function the
//   Communications tab uses for its preview — so what the Super Admin read is what
//   the student receives.
//
// ★ PAYMENT DETAILS ARE READ AT SEND TIME, ONLY FOR A BODY THAT ASKS FOR THEM, AND
//   ARE NEVER LOGGED, RETURNED OR STORED. The legacy template had the account
//   numbers typed into it. A body that asks for them when none are configured is
//   failed, not sent with a blank where the details should be.
//
// ★ NOTHING GOES TO THE PROVIDER UNTIL THE DATABASE CLEARS IT, AND THE CLEARANCE IS THE LAST
//   DATABASE CALL BEFORE THE REQUEST. Everything that can fail on this side — the payment details
//   read, rendering, the address check — happens first. Then comm_begin_send locks the row and
//   confirms, in a fresh snapshot, that it is still this claim's, its campaign is not cancelled and
//   its rule is active at the version the claim recorded, and stamps it as cleared. A refusal hands
//   the row back (the record step says why); an unanswered clearance, or a record the database does
//   not take, stops the run. The stamp is what makes walking away safe: a claim that was never
//   cleared reached nobody, so the next claim releases it with its attempt refunded instead of
//   writing it off as "outcome unknown".
//
// ★ IT MUST FINISH INSIDE THE FUNCTION'S TIME LIMIT. Every database call has its own time limit
//   (rpcWithin), every send is ONE provider request with a 10 s timeout that never sleeps on a 429,
//   a claim is sized to the time left, and a claimed row the budget cannot reach is handed back — or,
//   when even that does not fit, simply left for the next claim to release.
//
// ★ ONE IDEMPOTENCY KEY PER DELIVERY AND RETRY GENERATION (`comm-<id>-<generation>`). A released
//   claim is re-sent under the same key and Resend de-duplicates it; "Retry failed" bumps the
//   generation only for a row whose every attempt was refused outright.
//
// ★ AN UNCLEAR ANSWER IS ASKED AGAIN ONCE, A MOMENT LATER, UNDER THE SAME KEY. A timeout or a
//   provider fault may or may not have delivered the email. Repeating the identical request is
//   safe — the provider answers a repeated key with the original result, or sends it now if the
//   first request never arrived — and it settles some of them inside this call. Only a success or
//   another unclear answer replaces the first: a rate limit, a 409 or a refusal on the repeat says
//   nothing about whether the first request was delivered.
// ─────────────────────────────────────────────────────────────────────────────

import { BRAND, emailConfigured, emailShell, sendEmail } from './email.js';
import { supportAddress as sharedSupportAddress } from './supportAddress.js';
import { renderMessage } from '../../src/lib/commTemplates.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_TAG_RE = /\{\{\s*payment_instructions\s*\}\}/;

// Labels only. The values live in payment_settings and are edited in Enrollments.
const PAYMENT_LINES = [
  ['account_name', 'Account name'],
  ['bpi', 'BPI'],
  ['security_bank', 'Security Bank'],
  ['gcash', 'GCash'],
];

// Worth another attempt later: rate limiting, provider faults, timeouts, a request that
// never got an answer, and our own settings read failing. Everything else (a 422 bad
// address, a 403 unverified domain, missing payment details) fails at once.
const RETRYABLE = /^(resend_429|resend_5\d\d|resend_failed|resend_timeout|payment_settings_unreadable|send_error)$/;
// Answers that do not say whether the provider accepted the message.
const UNCLEAR = /^(resend_timeout|resend_failed|resend_5\d\d)$/;

const PACE_MS = 550;               // Resend's default limit is 2 requests a second
const BATCH = 10;
const SEND_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 3_000;      // each database call around a send: clearance, reads, record, hand-back
const CLAIM_TIMEOUT_MS = 8_000;    // the claim re-judges automations, so it is given longer
const REPEAT_PAUSE_MS = 2_000;     // before asking an unclear answer again
const CHECK_RETRY_PAUSE_MS = 1_000;
// The worst case for one email, every part of it bounded: the payment details read, the clearance,
// ONE provider request (maxAttempts: 1), the record and the pace.
const PER_EMAIL_WORST_MS = 3 * RPC_TIMEOUT_MS + SEND_TIMEOUT_MS + PACE_MS;
// A claim the SERVER rolled back (a deadlock victim, a lock or statement time limit) changed nothing,
// so it ends the run the way a claim that did not answer does, instead of failing it.
const CLAIM_ROLLED_BACK = new Set(['40P01', '55P03', '57014']);
const TYPICAL_EMAIL_MS = 2_000;    // a normal send plus the pace, for sizing a claim

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An RPC under a time limit. `timedOut` is true when the limit, not the database, ended it. */
async function rpcWithin(admin, fn, args, ms) {
  const signal = AbortSignal.timeout(ms);
  try {
    const { data, error } = await admin.rpc(fn, args).abortSignal(signal);
    return { data, error, timedOut: Boolean(error) && signal.aborted };
  } catch (e) {
    return { data: null, error: e, timedOut: signal.aborted };
  }
}

/** A PostgREST error as an Error, classifying a missing function the way staff.js does. */
export function rpcError(error, fn) {
  const err = new Error(error?.message || `rpc ${fn} failed`);
  err.code = error?.code || null;
  err.hint = error?.hint || null;
  if (error?.code === 'PGRST202' || error?.code === 'PGRST205' || error?.code === '42883') {
    err.migrationMissing = true;
    err.hint = 'MIGRATION_MISSING';
    err.message = `${fn}() does not exist in this database — run db/2026-09-16-communications.sql (#61).`;
  }
  return err;
}

/**
 * The support address replies go to: payment_settings.notify_email, then NOTIFY_ADMIN_EMAIL.
 * `ok: false` means the stored address could not be READ and there is no configured fallback —
 * the sender then stops rather than mailing students with nowhere for a reply to go.
 * The implementation lives in ./supportAddress.js (#67), shared with the migration's claim emails.
 */
function supportAddress(admin) {
  return sharedSupportAddress(admin, { timeoutMs: RPC_TIMEOUT_MS });
}

/** The payment block, built from the live settings. Throws 'payment_settings_unreadable'. */
async function paymentInstructions(admin) {
  const { data, error } = await admin.from('payment_settings').select('key,value').abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
  if (error) throw new Error('payment_settings_unreadable');
  const map = Object.fromEntries((data || []).map((r) => [r.key, String(r.value ?? '').trim()]));
  const lines = PAYMENT_LINES.filter(([k]) => map[k]).map(([k, label]) => `${label}: ${map[k]}`);
  if (map.note) lines.push(map.note);
  return lines.join('\n');
}

/** Build one message for one delivery row. Pure apart from the lookups passed in. */
export function buildDeliveryEmail(row, { supportEmail, payment }) {
  const vars = {
    ...(row.vars && typeof row.vars === 'object' ? row.vars : {}),
    payment_instructions: payment || '',
  };
  if (!vars.name && row.recipient_name) vars.name = row.recipient_name;
  const msg = renderMessage({ subject: row.subject, body: row.body, vars });
  const html = emailShell({
    heading: msg.subject,
    bodyHtml: msg.bodyHtml,
    preheader: msg.subject,
    supportEmail: supportEmail || undefined,
  });
  const text = [
    msg.text.trimEnd(),
    '',
    supportEmail ? `Questions? Reply to this email or write to ${supportEmail}.` : '',
    `— The ${BRAND} team`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n') + '\n';
  return {
    subject: msg.subject,
    html,
    text,
    empty: !msg.subject || !msg.bodyHtml,
    missingPayment: PAYMENT_TAG_RE.test(row.body || '') && !String(payment || '').trim(),
  };
}

/**
 * One provider request for one delivery — and, when its answer was unclear and the time left
 * covers a whole email, ONE repeat of the identical request under the same idempotency key, after
 * the row is cleared again.
 */
async function sendDelivery({ row, email, support, deadlineMs, wait, recheck }) {
  const request = {
    to: row.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: support || undefined,
    tag: 'comm',
    idempotencyKey: `comm-${row.id}-${Number(row.retry_generation) || 0}`,
    maxAttempts: 1,
    retry429: false,
  };
  const timeoutMs = () => Math.max(1_000, Math.min(SEND_TIMEOUT_MS, deadlineMs - Date.now() - RPC_TIMEOUT_MS - PACE_MS));
  let out = await sendEmail({ ...request, timeoutMs: timeoutMs() });
  if (!out.ok && UNCLEAR.test(out.code || '') && deadlineMs - Date.now() >= REPEAT_PAUSE_MS + PER_EMAIL_WORST_MS) {
    await wait(REPEAT_PAUSE_MS);
    // ★ Cleared again first: a cancel or a pause that landed during the first request stops the
    //   repeat — and if that request never arrived, the repeat would have been the only copy.
    if ((await recheck()) === 'go') {
      const again = await sendEmail({ ...request, timeoutMs: timeoutMs() });
      // ★ Only a success or another unclear answer replaces the first. Letting a rate limit, a 409
      //   (the first request still being processed) or a refusal such as a 401 stand would clear the
      //   row of its unclear mark, and a later "Retry failed" would send under a new key.
      if (again.ok || UNCLEAR.test(again.code || '')) out = again;
    }
  }
  // ★ A 409 on a FIRST request means the provider already holds a request under this key — an
  //   earlier call still in flight, or one accepted with a different payload. The message may
  //   have been delivered, so it is recorded as 'possibly_sent', which "Retry failed" never re-sends.
  if (!out.ok && out.code === 'resend_409') out = { ok: false, code: 'possibly_sent' };
  return out;
}

/**
 * Send queued deliveries until none are left or the time budget runs out.
 * @param admin       the service-role client (constructed AFTER the caller's gate)
 * @param campaignId  one campaign, or null for everything waiting
 * @param deadlineMs  an absolute Date.now() value the whole call must finish by
 * @param wait        how to pause (tests pass a no-op)
 */
export async function processQueue(admin, { campaignId = null, deadlineMs, wait = sleep }) {
  const totals = { sent: 0, failed: 0, retrying: 0, deferred: 0, stopped: 0, left: 0 };
  if (!emailConfigured()) return { ...totals, configured: false, halted: false };

  let support;
  let payment = null;
  let halted = false;
  const timeLeft = () => deadlineMs - Date.now();
  const record = (row, fields) => rpcWithin(admin, 'comm_record_delivery', {
    p_id: row.id, p_attempt: row.attempts, ...fields,
  }, RPC_TIMEOUT_MS);

  // Give a claimed, UNCLEARED row back without spending an attempt; if its campaign or rule has
  // stopped, the record step skips it instead. A row that is not handed back is not lost — it was
  // never cleared, so the next claim releases it ten minutes later with its attempt refunded — so
  // the hand-back is skipped once the database has stopped answering or the time left is too short.
  const handBack = async (row) => {
    if (halted || timeLeft() < RPC_TIMEOUT_MS) { totals.left += 1; return; }
    const { data: status, error } = await record(row, {
      p_ok: false, p_retry: true, p_provider_id: null, p_error_code: 'deferred', p_subject: null,
    });
    if (error) {
      console.error(`[comm] could not hand back delivery ${row.id}: ${error.code || 'error'}`);
      totals.left += 1;
    } else if (status === 'skipped') totals.stopped += 1;
    else if (status === 'queued') totals.deferred += 1;
  };

  // 'go' | 'stop' | 'unknown' — whether comm_begin_send cleared the row. One slow answer gets one
  // more try, while a whole email still fits after the pause.
  const clear = async (row) => {
    for (let n = 0; n < 2; n += 1) {
      const { data, error } = await rpcWithin(admin, 'comm_begin_send', {
        p_id: row.id, p_attempt: row.attempts,
      }, RPC_TIMEOUT_MS);
      if (!error) return data === true ? 'go' : 'stop';
      if (n > 0 || timeLeft() < CHECK_RETRY_PAUSE_MS + PER_EMAIL_WORST_MS) break;
      await wait(CHECK_RETRY_PAUSE_MS);
    }
    return 'unknown';
  };

  // Claim only while the claim and one worst-case send still fit, and only as many rows as the
  // time left can plausibly send.
  while (!halted && timeLeft() > CLAIM_TIMEOUT_MS + PER_EMAIL_WORST_MS) {
    const fit = Math.floor((timeLeft() - CLAIM_TIMEOUT_MS - PER_EMAIL_WORST_MS) / TYPICAL_EMAIL_MS);
    const claim = await rpcWithin(admin, 'comm_claim_deliveries', {
      p_limit: Math.max(1, Math.min(BATCH, fit)), p_campaign_id: campaignId,
    }, CLAIM_TIMEOUT_MS);
    if (claim.timedOut) {
      // Safe to walk away: whatever the claim committed was never cleared to send.
      console.error('[comm] the claim did not answer in time — stopping this run');
      halted = true;
      break;
    }
    if (claim.error && CLAIM_ROLLED_BACK.has(claim.error.code)) {
      console.error(`[comm] the claim was rolled back (${claim.error.code}) — stopping this run`);
      halted = true;
      break;
    }
    if (claim.error) throw rpcError(claim.error, 'comm_claim_deliveries');
    const rows = claim.data;
    if (!rows?.length) break;
    if (support === undefined) {
      const s = await supportAddress(admin);
      if (s.ok) support = s.address;
      else {
        console.error('[comm] could not read the support address — nothing sent this run');
        halted = true;
      }
    }

    for (const row of rows) {
      // ★ Out of time, or the database stopped answering: hand the row back (or leave it for the
      //   next claim). Vercel may kill the function mid-send, so nothing starts that cannot finish.
      if (halted || timeLeft() < PER_EMAIL_WORST_MS) {
        await handBack(row);
        continue;
      }

      // ★ Everything that can fail on this side happens BEFORE the clearance, so a cleared (stamped)
      //   row is one that really was about to reach the provider. A local failure is recorded against
      //   an uncleared row, which a lost record leaves refundable rather than "possibly delivered".
      let out = null;
      let email = null;
      let subject = null;
      try {
        if (payment === null && PAYMENT_TAG_RE.test(row.body || '')) payment = await paymentInstructions(admin);
        email = buildDeliveryEmail(row, { supportEmail: support, payment });
        subject = email.subject;
        if (email.missingPayment) out = { ok: false, code: 'payment_details_missing' };
        else if (email.empty || !EMAIL_RE.test(row.email || '')) out = { ok: false, code: 'render_empty' };
      } catch (e) {
        out = { ok: false, code: e?.message === 'payment_settings_unreadable' ? 'payment_settings_unreadable' : 'render_failed' };
      }

      if (!out) {
        const cleared = await clear(row);
        if (cleared !== 'go') {
          // Fail CLOSED: a sender that could not get a clearance does not send.
          if (cleared === 'unknown') console.error(`[comm] no clearance answer for delivery ${row.id} — stopping this run`);
          await handBack(row);
          if (cleared === 'unknown') halted = true;
          continue;
        }
        out = await sendDelivery({ row, email, support, deadlineMs, wait, recheck: () => clear(row) });
      }

      const retry = !out.ok && RETRYABLE.test(out.code || '');
      const { data: status, error: recErr } = await record(row, {
        p_ok: Boolean(out.ok),
        p_retry: retry,
        p_provider_id: out.ok ? (out.id || null) : null,
        p_error_code: out.ok ? null : (out.code || 'unknown'),
        p_subject: subject,
      });
      // Counted by what the record step DECIDED: a retryable failure on a stopped row is 'skipped',
      // not failed, and a row the database did not take is still waiting, not failed.
      if (out.ok) totals.sent += 1;
      else if (recErr) totals.left += 1;
      else if (status === 'queued') totals.retrying += 1;
      else if (status === 'skipped') totals.stopped += 1;
      else if (status === 'failed') totals.failed += 1;
      else totals.left += 1;
      if (recErr) {
        // Codes only: a delivery id is ours to log, an address is not. The row stays 'sending'; the
        // next claim releases it (as unclear only if it was cleared). No further row is cleared
        // against a database that has stopped taking writes.
        console.error(`[comm] could not record delivery ${row.id}: ${recErr.code || 'error'}`);
        halted = true;
      }
      await wait(PACE_MS);
    }
  }
  return { ...totals, configured: true, halted };
}

/**
 * What is still waiting: `remaining` (queued or mid-send) and `retryLater` (queued but
 * held back by a retry backoff), so a caller can stop looping on rows it cannot send yet.
 */
export async function queueRemaining(admin, campaignId = null) {
  const scoped = (q) => (campaignId ? q.eq('campaign_id', campaignId) : q);
  const limit = () => AbortSignal.timeout(RPC_TIMEOUT_MS);
  const [all, later] = await Promise.all([
    scoped(admin.from('comm_deliveries').select('id', { count: 'exact', head: true }).in('status', ['queued', 'sending']))
      .abortSignal(limit()),
    scoped(admin.from('comm_deliveries').select('id', { count: 'exact', head: true })
      .eq('status', 'queued').gt('next_attempt_at', new Date().toISOString()))
      .abortSignal(limit()),
  ]);
  if (all.error) return { remaining: null, retryLater: null };
  return { remaining: all.count ?? 0, retryLater: later.error ? 0 : (later.count ?? 0) };
}
