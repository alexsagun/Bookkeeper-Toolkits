// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — the legacy student migration (#67). SUPER ADMIN ONLY.
// ─────────────────────────────────────────────────────────────────────────────
// The only place that holds the service-role key for student migration, and the only
// place that creates Auth accounts for it. Every action:
//   1. passes requireStaff(req, { permission: 'students.legacy_migrate' }) — a verified
//      JWT plus the caller's LIVE staff context — BEFORE service() is constructed;
//   2. hands the verified caller to the database as p_actor, and every SQL function
//      re-checks that actor's permission (auth.uid() is NULL under the service role).
//
// ★ THE BROWSER DESCRIBES, THE DATABASE DECIDES. The browser sends parsed rows to
//   stage and row ids to activate. It never sends a user id, a plan, a batch, a date,
//   a paid status or an amount for an activation: legacy_import_activate_row() reads
//   all of them from the staged row, which only legacy_import_stage() wrote.
//
// ★ ONE ACTIVATION IS ONE DATABASE TRANSACTION, AND THE AUTH USER COMES FIRST.
//   Supabase Auth and Postgres cannot share a transaction, so the saga is ordered to be
//   retry-safe at every step: claim the row → find or create the Auth user (createUser
//   sends no email) → record it on the row → activate (subscription + cohort run +
//   approval + audit, all or nothing) → mint and send the invitation → record delivery.
//   A timeout anywhere is resumed by the next request; an Auth user is never deleted.
//
// Actions (POST body.action):
//   health            readiness booleans (email, APP_URL, support address, service key)
//   stage             { filename, fileSha256, rows, mapping, dateFormat, planMapping,
//                       batchMapping, eligibleBatchCodes } → a durable job (or the
//                       existing one for the same roster)
//   preflight         { jobId, rowIds } → the counts the confirmation dialog shows
//   start-activation  { jobId, rowIds, phrase, clientKey } → a durable run
//   activate-chunk    { runId, retryFailed } → as many rows as fit in the time budget
//   pause-run         { runId }
//   resend            { rowId } → a fresh link under a new generation
//   send-test         → the activation email, with sample details and no token, to the
//                       CALLING Super Admin's own address: proves the migration sender
//                       (support@alexsagun.com) is verified before any student is emailed
//   GET               { ok, configured } — nothing that describes the deployment
//
// ★ NOTHING HERE LOGS A NAME, AN EMAIL, A LINK OR A PROVIDER BODY. Failures log the
//   action and a safe code only; rows carry codes, never messages.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';

import { requireStaff, service, serviceConfigured } from '../_lib/staffAuth.js';
import { emailConfigured, sendEmail } from '../_lib/email.js';
import { MIGRATION_SENDER_ADDRESS, legacyMembershipEmail } from '../_lib/legacyClaimEmail.js';
import { buildClaimUrl, buildSignInUrl } from '../../src/lib/importClaim.js';
import {
  ACTIVATION_FUNCTION_MAX_SECONDS, DATE_FORMATS, MAX_ACTIVATION_RUN, MAX_STAGE_ROWS,
  normalizeLegacyRows,
} from '../../src/lib/legacyMigration.js';

const PERMISSION = 'students.legacy_migrate';

// ★ Every migration email is sent from, and answered at, support@alexsagun.com (owner
//   requirement). MIGRATION_EMAIL_FROM may override it — e.g. with a display name — but the
//   domain must be verified in Resend either way; "send-test" proves it.
function migrationSender() {
  const env = String(process.env.MIGRATION_EMAIL_FROM || '').trim();
  return env || MIGRATION_SENDER_ADDRESS;
}
/** The bare address inside "Name <addr>" or a bare address, for reply-to and the footer. */
function migrationSupportAddress() {
  const raw = migrationSender();
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

// ── Time budget ──────────────────────────────────────────────────────────────
// vercel.json gives this function ACTIVATION_FUNCTION_MAX_SECONDS (60). A chunk stops
// claiming once a whole row could no longer finish inside it; a row it could not reach
// stays `ready` for the next request, and a row claimed by a request that died is
// reclaimable after STALE_CLAIM_MINUTES (10), which is longer than the function can live.
const RPC_TIMEOUT_MS = 8_000;
const AUTH_TIMEOUT_MS = 8_000;
const SEND_TIMEOUT_MS = 10_000;
const CHUNK_BUDGET_MS = (ACTIVATION_FUNCTION_MAX_SECONDS - 12) * 1000;
// A realistic ceiling for one row (a normal row takes 1–3 s). Every call below still has
// its own limit; a row that outruns the function is resumed by the stale-claim rule, and
// its grant is one transaction, so it is either wholly done or wholly absent.
const PER_ROW_WORST_MS = 20_000;
const PACE_MS = 600;                       // Resend's default limit is 2 requests/second
const MAX_STAGE_BODY_CHARS = 3_500_000;    // under Vercel's 4.5 MB request limit

// ── Per-warm-instance burst guard ────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 60;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const hits = (rateHits.get(userId) || []).filter((t) => t >= now - RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A database call with a time limit. Returns { data, error }; never throws. */
async function rpc(admin, fn, args, timeoutMs = RPC_TIMEOUT_MS) {
  try {
    const { data, error } = await admin.rpc(fn, args).abortSignal(AbortSignal.timeout(timeoutMs));
    return { data, error };
  } catch (e) {
    return { data: null, error: { code: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'rpc_timeout' : 'rpc_failed' } };
  }
}

/** The safe code of a PostgREST / app_error failure — never its message. */
function codeOf(error) {
  if (!error) return 'unexpected';
  const hint = typeof error.hint === 'string' && /^[A-Z_]{3,60}$/.test(error.hint) ? error.hint : null;
  return hint || String(error.code || 'unexpected').replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 60) || 'unexpected';
}

function statusOf(code) {
  if (code === 'FORBIDDEN') return 403;
  if (/NOT_FOUND$/.test(code)) return 404;
  if (/INVALID|MISMATCH$/.test(code) && code !== 'LEGACY_IDENTITY_MISMATCH') return 422;
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42883') return 503;
  if (/^LEGACY_|^MEMBERSHIP_/.test(code)) return 409;
  return 500;
}

function fail(res, action, error, fallback) {
  const code = codeOf(error);
  console.error(`[student-imports] ${action} refused: ${code}`);
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42883') {
    return res.status(503).json({ error: 'The migration needs db/2026-09-25-legacy-student-migration.sql (#67). Run it, then try again.', code: 'MIGRATION_MISSING' });
  }
  return res.status(statusOf(code)).json({ error: fallback, code, context: safeContext(error) });
}

/** Only the structured context app_error() attaches (ids, counts), never a message. */
function safeContext(error) {
  try {
    const d = typeof error?.details === 'string' ? JSON.parse(error.details) : null;
    return d && typeof d.context === 'object' ? d.context : null;
  } catch { return null; }
}

// ── Readiness ────────────────────────────────────────────────────────────────
/**
 * The first-party origin a claim link points at: APP_URL, and only APP_URL, on any Vercel
 * deployment. The old sender fell back to SUPABASE_URL and produced links to the database
 * host; a Host-header fallback on a PREVIEW deployment — which shares production's
 * database — would email real students links to a throwaway preview. The request's own
 * origin is used only by a local dev server (npm run dev), whose links nobody real gets.
 */
function appOrigin(req) {
  const env = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(env)) return env;
  if (process.env.VERCEL_ENV) return null;
  const host = String(req?.headers?.host || '').trim();
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? `http://${host}` : null;
}

async function readiness(admin, req) {
  // The emails name the migration sender as their support contact; the payment-settings
  // support address is kept only as a diagnostic, and no longer decides readiness.
  const origin = appOrigin(req);
  const sender = migrationSupportAddress();
  const out = {
    service: serviceConfigured(),
    // RESEND_FROM is not needed here: migration mail names its own sender.
    email: Boolean(process.env.RESEND_API_KEY),
    appUrl: Boolean(origin),
    support: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender),
    sender,
  };
  out.canActivate = out.service && out.email && out.appUrl && out.support;
  return { flags: out, origin, supportEmail: sender };
}

function notReadyMessage(flags) {
  const missing = [];
  if (!flags.email) missing.push('email sending (RESEND_API_KEY)');
  if (!flags.appUrl) missing.push('the app address (APP_URL)');
  if (!flags.support) missing.push('a valid migration sender (MIGRATION_EMAIL_FROM)');
  return `Activation is paused until the server has ${missing.join(', ')}. Staging still works.`;
}

// ── Staging ──────────────────────────────────────────────────────────────────
/** A fingerprint of the roster's CONTENT, independent of column order and mappings. */
function contentFingerprint(rows) {
  const canonical = rows.map((r) => Object.keys(r).sort().map((k) => [k, String(r[k] ?? '').trim()]));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

async function doStage(admin, actorId, body) {
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || rows.length < 1 || rows.length > MAX_STAGE_ROWS) {
    return { status: 422, body: { error: `A roster must hold between 1 and ${MAX_STAGE_ROWS.toLocaleString('en-US')} rows.`, code: 'LEGACY_STAGE_INVALID' } };
  }
  if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    return { status: 422, body: { error: 'Every row must be a set of named columns.', code: 'LEGACY_STAGE_INVALID' } };
  }
  if (!DATE_FORMATS.includes(body?.dateFormat)) {
    return { status: 422, body: { error: 'Declare the date format before staging.', code: 'LEGACY_STAGE_INVALID' } };
  }

  const [plansRes, batchesRes] = await Promise.all([
    admin.from('enrollment_plans').select('key,name,price_php,active').abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)),
    admin.from('batches').select('id,code,name,status').abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)),
  ]);
  if (plansRes.error || batchesRes.error) {
    return { status: 503, body: { error: 'Could not read the plan catalog or the batch registry. Nothing was staged; try again.', code: 'rpc_failed' } };
  }

  const normalized = normalizeLegacyRows(rows, {
    mapping: body.mapping || {},
    dateFormat: body.dateFormat,
    planMapping: body.planMapping || {},
    batchMapping: body.batchMapping || {},
    plans: plansRes.data || [],
    batches: batchesRes.data || [],
    eligibleBatchCodes: Array.isArray(body.eligibleBatchCodes) ? body.eligibleBatchCodes : [],
    nowMs: Date.now(),
  });

  const job = {
    filename: String(body.filename || '').slice(0, 200) || null,
    file_sha256: /^[0-9a-f]{64}$/i.test(String(body.fileSha256 || '')) ? String(body.fileSha256).toLowerCase() : null,
    content_sha256: contentFingerprint(rows),
    mapping: body.mapping || {},
    date_format: body.dateFormat,
    plan_mapping: body.planMapping || {},
    batch_mapping: body.batchMapping || {},
    eligible_batch_codes: Array.isArray(body.eligibleBatchCodes) ? body.eligibleBatchCodes : [],
  };
  const sqlRows = normalized.map((r) => ({
    source_row_number: r.source_row_number,
    external_user_id: r.external_user_id,
    email_normalized: r.email_normalized,
    email_display: r.email_display,
    first_name: r.first_name,
    last_name: r.last_name,
    plan_key: r.plan_key,
    legacy_plan_label: r.legacy_plan_label,
    batch_code: r.batch_code,
    legacy_batch_label: r.legacy_batch_label,
    start_date: r.start_date,
    end_date: r.end_date,
    payment_status: r.payment_status,
    amount_paid: r.amount_paid,
    currency: r.currency,
    phone: r.phone,
    errors: r.errors,
    warnings: r.warnings,
  }));

  const { data, error } = await rpc(admin, 'legacy_import_stage', { p_actor: actorId, p_job: job, p_rows: sqlRows }, 30_000);
  if (error) return { error };
  return { status: 200, body: data };
}

// ── Activation ───────────────────────────────────────────────────────────────
async function findAuthUser(admin, actorId, email) {
  const { data, error } = await rpc(admin, 'legacy_import_find_auth_user', { p_actor: actorId, p_email: email });
  if (error) throw Object.assign(new Error('find_failed'), { safeCode: codeOf(error) });
  return data || [];
}

async function resolveAuthUser(admin, actorId, row) {
  if (row.target_user_id) return { uid: row.target_user_id, created: false };
  const found = await findAuthUser(admin, actorId, row.email);
  if (found.length > 1) throw Object.assign(new Error('ambiguous'), { safeCode: 'identity_ambiguous' });
  if (found.length === 1) return { uid: found[0].user_id, created: false };

  let created = null;
  try {
    const { data, error } = await Promise.race([
      admin.auth.admin.createUser({
        email: row.email,
        email_confirm: false,          // confirmed by the claim link, never assumed
        user_metadata: row.full_name ? { full_name: row.full_name } : {},
        // ★ Marks the account as THIS row's. If createUser times out but succeeds, the retry
        //   finds it by email and legacy_import_bind_user() still knows the import created
        //   it — rather than recording a stranger's never-confirmed signup.
        app_metadata: { legacy_import_row_id: row.row_id },
      }),
      sleep(AUTH_TIMEOUT_MS).then(() => ({ data: null, error: { code: 'auth_timeout' } })),
    ]);
    if (!error && data?.user?.id) created = data.user.id;
  } catch { /* re-resolved below */ }
  if (created) return { uid: created, created: true };

  // "Already registered", a timeout that succeeded anyway, a race with another window:
  // whatever happened, the address is the identity — look it up again.
  const again = await findAuthUser(admin, actorId, row.email);
  if (again.length === 1) return { uid: again[0].user_id, created: false };
  throw Object.assign(new Error('create_failed'), { safeCode: again.length > 1 ? 'identity_ambiguous' : 'auth_create_failed' });
}

/**
 * Mint (for a claim) and send one invitation under a new generation, then record it.
 * Returns the recorded state. A provider answer that may have been delivered is
 * `uncertain`, never retried under a new token automatically.
 */
async function sendInvite(admin, actorId, rowId, ctx, { resend = false } = {}) {
  const { data: inv, error } = await rpc(admin, 'legacy_import_begin_invite', { p_actor: actorId, p_row_id: rowId, p_resend: resend });
  if (error) return { state: 'error', code: codeOf(error) };
  if (!inv || inv.skip) return { state: 'skipped' };

  const record = async (state, code) => {
    const r = await rpc(admin, 'legacy_import_record_delivery', {
      p_actor: actorId, p_row_id: rowId, p_generation: inv.generation, p_state: state, p_code: code || null,
    });
    if (r.error) console.error(`[student-imports] record delivery failed: ${codeOf(r.error)}`);
    return { state, code };
  };

  let url = null;
  if (inv.kind === 'claim') {
    let tokenHash = null;
    try {
      const { data, error: gErr } = await Promise.race([
        admin.auth.admin.generateLink({ type: 'magiclink', email: inv.email }),
        sleep(AUTH_TIMEOUT_MS).then(() => ({ data: null, error: { code: 'auth_timeout' } })),
      ]);
      // ★ hashed_token ONLY. action_link is Supabase's /auth/v1/verify, which spends
      //   the token on a GET — a mail scanner would claim the account.
      if (!gErr) tokenHash = data?.properties?.hashed_token || null;
    } catch { /* recorded below */ }
    url = tokenHash ? buildClaimUrl({ appUrl: ctx.origin, tokenHash, type: 'magiclink' }) : null;
    if (!url) return record('failed', 'link_failed');
  } else {
    url = buildSignInUrl(ctx.origin);
    if (!url) return record('failed', 'app_url_missing');
  }

  const msg = legacyMembershipEmail({
    kind: inv.kind,
    actionUrl: url,
    fullName: inv.full_name,
    email: inv.email,
    planName: inv.plan_name,
    planKey: inv.plan_key,
    batchName: inv.batch_name,
    startDate: inv.start_date,
    endDate: inv.end_date,
    supportEmail: ctx.supportEmail,
    nowMs: Date.now(),
  });
  url = null;   // the token lives only inside msg until it is sent; nothing else keeps it

  const sent = await sendEmail({
    to: inv.email,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    replyTo: ctx.supportEmail,
    from: migrationSender(),
    idempotencyKey: `legacy-claim-${rowId}-${inv.generation}`,
    tag: 'student-imports',
    timeoutMs: SEND_TIMEOUT_MS,
    // A second attempt reuses THIS key and THIS token, so the provider de-duplicates it.
    // A 429 is not slept on inside the time budget: it is recorded as failed (nothing
    // was delivered) and resent later under a new generation.
    maxAttempts: 2,
    retry429: false,
  });
  if (sent.ok) return record(inv.kind === 'claim' ? 'sent' : 'notified', null);
  const unclear = sent.code === 'resend_timeout' || sent.code === 'resend_failed' || sent.code === 'resend_409'
    || /^resend_5\d\d$/.test(sent.code || '');
  return record(unclear ? 'uncertain' : 'failed', sent.code);
}

async function processRow(admin, actorId, runId, row, ctx) {
  try {
    const { uid, created } = await resolveAuthUser(admin, actorId, row);
    const bind = await rpc(admin, 'legacy_import_bind_user', {
      p_actor: actorId, p_row_id: row.row_id, p_run_id: runId, p_user_id: uid, p_created: created,
    });
    if (bind.error) throw Object.assign(new Error('bind'), { safeCode: codeOf(bind.error) });

    const act = await rpc(admin, 'legacy_import_activate_row', { p_actor: actorId, p_row_id: row.row_id, p_run_id: runId }, 15_000);
    if (act.error) throw Object.assign(new Error('activate'), { safeCode: codeOf(act.error) });
    if (!act.data?.ok) return { row_id: row.row_id, outcome: 'blocked', reason: act.data?.reason || 'blocked' };

    const inv = await sendInvite(admin, actorId, row.row_id, ctx);
    return { row_id: row.row_id, outcome: 'activated', status: act.data.status, invite: inv.state };
  } catch (e) {
    const code = e?.safeCode || 'unexpected';
    const marked = await rpc(admin, 'legacy_import_mark_failed', { p_actor: actorId, p_row_id: row.row_id, p_run_id: runId, p_code: code });
    if (marked.error) console.error(`[student-imports] mark failed refused: ${codeOf(marked.error)}`);
    console.error(`[student-imports] row failed: ${code}`);
    return { row_id: row.row_id, outcome: 'failed', code };
  }
}

async function doActivateChunk(admin, actorId, body, ctx) {
  const runId = body?.runId;
  if (!runId) return { status: 400, body: { error: 'runId required.' } };
  const lease = randomBytes(18).toString('base64url');
  const t0 = Date.now();
  const left = () => CHUNK_BUDGET_MS - (Date.now() - t0);
  const results = [];
  const tried = [];

  // Pass 1: rows not yet activated, one at a time, while a whole row still fits.
  while (left() > PER_ROW_WORST_MS) {
    const claim = await rpc(admin, 'legacy_import_claim_rows', {
      p_actor: actorId, p_run_id: runId, p_lease: lease, p_limit: 1,
      p_retry_failed: Boolean(body.retryFailed), p_exclude: tried,
    });
    if (claim.error) {
      if (!results.length) return { error: claim.error };
      break;
    }
    const rows = Array.isArray(claim.data) ? claim.data : [];
    if (!rows.length) break;
    for (const row of rows) {
      tried.push(row.row_id);
      results.push(await processRow(admin, actorId, runId, row, ctx));
      await sleep(PACE_MS);
    }
  }

  // Pass 2: rows a previous request activated but never emailed.
  while (left() > SEND_TIMEOUT_MS + 2 * RPC_TIMEOUT_MS) {
    const pending = await rpc(admin, 'legacy_import_pending_invites', { p_actor: actorId, p_run_id: runId, p_limit: 1 });
    const ids = Array.isArray(pending.data) ? pending.data : [];
    if (pending.error || !ids.length) break;
    const inv = await sendInvite(admin, actorId, ids[0], ctx);
    results.push({ row_id: ids[0], outcome: 'invited', invite: inv.state });
    if (inv.state === 'skipped' || inv.state === 'error') break;
    await sleep(PACE_MS);
  }

  const rel = await rpc(admin, 'legacy_import_release_run', { p_actor: actorId, p_run_id: runId, p_lease: lease, p_pause: false });
  if (rel.error) console.error(`[student-imports] release refused: ${codeOf(rel.error)}`);
  return { status: 200, body: { ok: true, results, run: rel.data || null } };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Unauthenticated: says only whether the server can do privileged work at all.
    return res.status(200).json({ ok: true, configured: serviceConfigured() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  if (!serviceConfigured()) {
    return res.status(500).json({ error: 'The migration server is not configured (SUPABASE_SECRET_KEY missing).' });
  }

  // ★ The gate, BEFORE the service client exists. students.legacy_migrate is held by
  //   super_admin alone: activating a legacy student creates paid access with no payment
  //   in this system.
  const gate = await requireStaff(req, { permission: PERMISSION });
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
  const actorId = gate.user.id;
  if (rateLimited(actorId)) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });

  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_STAGE_BODY_CHARS) return res.status(413).json({ error: 'That roster is too large to send in one request.', code: 'LEGACY_STAGE_INVALID' });
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const action = body?.action;
  const admin = service();

  try {
    if (action === 'health') {
      const r = await readiness(admin, req);
      return res.status(200).json({ ok: true, ...r.flags });
    }

    if (action === 'stage') {
      const r = await doStage(admin, actorId, body);
      if (r.error) return fail(res, action, r.error, 'The roster could not be staged.');
      return res.status(r.status).json(r.body);
    }

    if (action === 'preflight') {
      if (!body?.jobId || !Array.isArray(body?.rowIds)) return res.status(400).json({ error: 'jobId and rowIds required.' });
      const ids = body.rowIds.slice(0, MAX_ACTIVATION_RUN + 1);
      const [pf, ready] = await Promise.all([
        rpc(admin, 'legacy_import_preflight', { p_actor: actorId, p_job_id: body.jobId, p_row_ids: ids }),
        readiness(admin, req),
      ]);
      if (pf.error) return fail(res, action, pf.error, 'The confirmation counts could not be read.');
      return res.status(200).json({ ok: true, preflight: pf.data, readiness: ready.flags,
        readinessMessage: ready.flags.canActivate ? null : notReadyMessage(ready.flags) });
    }

    if (action === 'start-activation') {
      const ready = await readiness(admin, req);
      if (!ready.flags.canActivate) {
        return res.status(409).json({ error: notReadyMessage(ready.flags), code: 'NOT_READY', readiness: ready.flags });
      }
      const { data, error } = await rpc(admin, 'legacy_import_start_run', {
        p_actor: actorId, p_job_id: body?.jobId, p_row_ids: Array.isArray(body?.rowIds) ? body.rowIds : [],
        p_phrase: String(body?.phrase || ''), p_client_key: String(body?.clientKey || ''),
      });
      if (error) return fail(res, action, error, 'The activation could not be started.');
      return res.status(200).json(data);
    }

    if (action === 'activate-chunk') {
      const ready = await readiness(admin, req);
      if (!ready.flags.canActivate) {
        return res.status(409).json({ error: notReadyMessage(ready.flags), code: 'NOT_READY', readiness: ready.flags });
      }
      const r = await doActivateChunk(admin, actorId, body, { origin: ready.origin, supportEmail: ready.supportEmail });
      if (r.error) return fail(res, action, r.error, 'The activation could not continue.');
      return res.status(r.status).json(r.body);
    }

    if (action === 'pause-run') {
      if (!body?.runId) return res.status(400).json({ error: 'runId required.' });
      const { data, error } = await rpc(admin, 'legacy_import_release_run', { p_actor: actorId, p_run_id: body.runId, p_lease: null, p_pause: true });
      if (error) return fail(res, action, error, 'The activation could not be paused.');
      return res.status(200).json(data);
    }

    if (action === 'send-test') {
      const ready = await readiness(admin, req);
      if (!ready.flags.email) return res.status(409).json({ error: notReadyMessage(ready.flags), code: 'NOT_READY' });
      // The recipient is the CALLER's own Auth address, resolved here — never a body field,
      // so this action cannot be pointed at anyone else.
      let to = '';
      try {
        const { data: au } = await Promise.race([
          admin.auth.admin.getUserById(actorId),
          sleep(AUTH_TIMEOUT_MS).then(() => ({ data: null })),
        ]);
        to = String(au?.user?.email || '').trim();
      } catch { /* answered below */ }
      if (!to) return res.status(422).json({ error: 'Your account has no email address to send the test to.' });
      // Sample details and a link to the app's own sign-in page: no token is minted, and
      // nothing about any student is read or sent.
      const msg = legacyMembershipEmail({
        kind: 'claim', actionUrl: ready.origin ? `${ready.origin}/` : 'https://example.invalid/',
        fullName: 'Sample Student', email: 'sample.student@example.invalid',
        planName: 'Personalized Coaching Program', planKey: 'vip', batchName: 'October 2026',
        startDate: '2026-10-12', endDate: '2027-04-12', supportEmail: ready.supportEmail, nowMs: Date.now(),
      });
      const sent = await sendEmail({
        to, subject: `[Test] ${msg.subject}`, html: msg.html, text: msg.text,
        replyTo: ready.supportEmail, from: migrationSender(), tag: 'student-imports-test',
        timeoutMs: SEND_TIMEOUT_MS, maxAttempts: 1, retry429: false,
      });
      if (!sent.ok) console.error(`[student-imports] test send failed: ${sent.code}`);
      return res.status(200).json({ ok: sent.ok, code: sent.ok ? null : sent.code, sender: ready.flags.sender });
    }

    if (action === 'resend') {
      if (!body?.rowId) return res.status(400).json({ error: 'rowId required.' });
      const ready = await readiness(admin, req);
      if (!ready.flags.canActivate) {
        return res.status(409).json({ error: notReadyMessage(ready.flags), code: 'NOT_READY', readiness: ready.flags });
      }
      const inv = await sendInvite(admin, actorId, body.rowId, { origin: ready.origin, supportEmail: ready.supportEmail }, { resend: true });
      if (inv.state === 'error') return fail(res, action, { hint: inv.code }, 'The invitation could not be resent.');
      return res.status(200).json({ ok: true, state: inv.state, code: inv.code || null });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error(`[student-imports] ${String(action || 'request').slice(0, 30)} failed: ${String(err?.safeCode || err?.code || err?.name || 'error').slice(0, 60)}`);
    return res.status(500).json({ error: 'The migration request failed. Nothing was sent twice; try again.' });
  }
}

// Exported for test/legacyMigrationSql.test.mjs source and behaviour checks.
export { appOrigin, codeOf, contentFingerprint, doStage, notReadyMessage };
