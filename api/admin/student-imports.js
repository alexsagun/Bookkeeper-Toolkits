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
//   approval + audit, all or nothing) → replace the password of a pre-existing account
//   that never confirmed (E8, #68 — before EVERY claim link, and no link without it) →
//   mint and send the invitation → record delivery.
//   A timeout anywhere is resumed by the next request; an Auth user is never deleted.
//
// Actions (POST body.action):
//   health            readiness flags (service key, email, APP_URL, sender, reply-to,
//                       senderProven, daily cap)
//   stage             { filename, fileSha256, rows, mapping, dateFormat, planMapping,
//                       batchMapping, eligibleBatchCodes, eligiblePlanKeys } → a durable job
//                       (or the existing one for the same roster)
//   preflight         { jobId, rowIds } → the counts the confirmation dialog shows
//   start-activation  { jobId, rowIds, phrase, clientKey } → a durable run
//   activate-chunk    { runId, retryFailed } → as many rows as fit in the time budget;
//                       stops at the first provider refusal (the circuit breaker, #68)
//   pause-run         { runId }
//   resend            { rowId } → a fresh link under a new generation
//   resend-failed     { jobId, includeUncertain, exclude? } → re-sends the job's failed
//                       invitations (and possibly-delivered ones only when asked), with the
//                       same time budget, pace and breaker as a run (#68); a student who has
//                       already finished setting up is skipped (skipped_onboarded)
//   reset-onboarding-notice { rowId } → lets the two "onboarded" emails be tried again (#68)
//   send-test         → the activation email, with sample details and no token, to the
//                       CALLING Super Admin's own address: proves the migration sender is
//                       accepted by Resend before any student is emailed
//   GET               { ok, configured } — nothing that describes the deployment
//
// ★ NOTHING HERE LOGS A NAME, AN EMAIL, A LINK OR A PROVIDER BODY. Failures log the
//   action and a safe code only; rows carry codes, never messages.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';

import { requireStaff, service, serviceConfigured } from '../_lib/staffAuth.js';
import { sendEmail } from '../_lib/email.js';
import {
  addressDomain, isAddress, legacyMembershipEmail, migrationAddresses,
} from '../_lib/legacyClaimEmail.js';
import { buildClaimUrl, buildSignInUrl } from '../../src/lib/importClaim.js';
import { PLAN_LABELS } from '../../src/lib/planCatalog.js';
import {
  ACTIVATION_FUNCTION_MAX_SECONDS, DATE_FORMATS, MAX_ACTIVATION_RUN, MAX_STAGE_ROWS,
  normalizeLegacyRows,
} from '../../src/lib/legacyMigration.js';

const PERMISSION = 'students.legacy_migrate';

// ★ FROM A VERIFIED DOMAIN, ANSWERED AT support@alexsagun.com (#68, owner decision
//   2026-09-28). The From is MIGRATION_EMAIL_FROM, else support@<RESEND_FROM's domain>;
//   the Reply-To and every printed contact is MIGRATION_REPLY_TO, else
//   support@alexsagun.com. The two never move together — see api/_lib/legacyClaimEmail.js.
function migrationEnvAddresses() {
  return migrationAddresses({
    migrationFrom: process.env.MIGRATION_EMAIL_FROM,
    resendFrom: process.env.RESEND_FROM,
    replyTo: process.env.MIGRATION_REPLY_TO,
  });
}

/** Resend's free plan allows 100 emails a day; MIGRATION_DAILY_EMAIL_CAP describes a paid one. */
function migrationDailyCap() {
  const n = Math.floor(Number(process.env.MIGRATION_DAILY_EMAIL_CAP));
  return Number.isFinite(n) && n > 0 ? n : 100;
}

// ── The circuit breaker (#68) ────────────────────────────────────────────────
// ★ A PROVIDER REFUSAL STOPS THE RUN, NOT JUST THE ROW. In #67 a 403 was recorded as a
//   failed invitation and the loop kept claiming, so a sender Resend refuses would have
//   granted a whole cohort paid access with not one student told. These codes describe the
//   SENDER, the key or the account's quota — the next row would meet exactly the same answer —
//   so the first one ends the request and pauses the run: at most one row is granted without
//   its email. A 422 can be about one recipient, so only two in a row stop it.
//   A 429 is the daily quota unless Resend's body names its per-second rate limit — then it
//   stops as 'email_rate_limited' instead (invitationBreaker; sendEmail's `limit`).
const STOP_CODES = Object.freeze({
  email_not_configured: 'email_unconfigured',
  email_from_not_configured: 'email_unconfigured',
  resend_401: 'sender_refused',
  resend_403: 'sender_refused',
  resend_429: 'email_quota',
});
// ★ Answers that PROVE nothing was delivered. Inside a run such a row is handed back to
//   `not_sent` (legacy_import_record_delivery's hand-back, #68), so a Resume re-sends it by
//   itself once the cause is fixed. The set mirrors the SQL's list exactly; a code the
//   provider might have acted on (a timeout, a 5xx, a 409) is never on it.
const NOTHING_SENT_CODES = new Set([
  'resend_401', 'resend_403', 'resend_429', 'link_failed', 'app_url_missing',
  'email_not_configured', 'email_from_not_configured',
]);
// A failure recorded by begin_invite that no retry can fix: the account is gone, or the
// invitation has been sent the maximum number of times.
const NEVER_SUCCEEDS = new Set(['account_missing', 'invite_cap']);
// legacy_import_begin_invite's generation cap (`invite_generation >= 20`), mirrored so a row
// that reached it — whatever code its last attempt left — is reported as unrecoverable rather
// than tried and refused on every pass. test/studentImportsEndpoint.test.mjs pins it to the SQL.
const MAX_INVITE_GENERATION = 20;
// A database that did not answer: the next call would meet the same silence.
const TRANSPORT_CODES = new Set(['rpc_timeout', 'rpc_failed']);
// ★ #68 (V1): SUPABASE AUTH COULD NOT DO ITS PART — no claim link could be minted
//   (link_failed), or a pre-existing account's old password could not be replaced
//   (rotation_failed, E8). Pass 2 kept granting through an Auth outage while no email went
//   out — "a whole cohort granted, nobody told" — and pass 1 spent one of a row's 20
//   generations on every chunk until the row was capped for good. One failure can be one
//   account's, so only two in a row stop the run ('auth_unavailable'), as with a 422.
const AUTH_FAILURE_CODES = new Set(['link_failed', 'rotation_failed']);

/**
 * A breaker for one request. Feed it every invitation outcome in order; it returns the
 * reason to stop ('sender_refused' | 'email_quota' | 'email_rate_limited' |
 * 'email_unconfigured' | 'invalid_request' | 'auth_unavailable') or null.
 *   • a 401/403, a quota 429 or a missing configuration stops at once (STOP_CODES);
 *   • a 429 whose body names Resend's per-second RATE limit (`limit: 'rate'`, from
 *     sendEmail) stops as 'email_rate_limited' — a Resume a minute later works — never as
 *     the daily quota (#68, V5);
 *   • two 422s in a row stop as 'invalid_request';
 *   • two Auth failures in a row (AUTH_FAILURE_CODES) stop as 'auth_unavailable' (#68, V1).
 * A delivered email — or any other provider answer, which proves the link was minted —
 * ends both streaks. Outcomes that are not a provider answer (a skip, a database refusal,
 * an account that is gone) neither trip it nor break a streak.
 */
function invitationBreaker() {
  let streak422 = 0;
  let streakAuth = 0;
  return ({ state, code, limit } = {}) => {
    if (state === 'sent' || state === 'notified') { streak422 = 0; streakAuth = 0; return null; }
    if (code === 'resend_429' && limit === 'rate') return 'email_rate_limited';
    if (code && STOP_CODES[code]) return STOP_CODES[code];
    if (AUTH_FAILURE_CODES.has(code)) {
      streakAuth += 1;
      return streakAuth >= 2 ? 'auth_unavailable' : null;
    }
    if (code === 'resend_422') {
      streakAuth = 0;
      streak422 += 1;
      return streak422 >= 2 ? 'invalid_request' : null;
    }
    if (/^resend_/.test(String(code || ''))) { streak422 = 0; streakAuth = 0; }
    return null;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidList = (v, max) => (Array.isArray(v) ? v : [])
  .filter((x) => typeof x === 'string' && UUID_RE.test(x)).slice(0, max);

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

function fail(res, action, error, fallback, extra = null) {
  const code = codeOf(error);
  console.error(`[student-imports] ${action} refused: ${code}`);
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42883') {
    return res.status(503).json({ error: 'The migration needs db/2026-09-28-legacy-migration-round2.sql (#68). Run it, then try again.', code: 'MIGRATION_MISSING' });
  }
  return res.status(statusOf(code)).json({ error: fallback, code, context: safeContext(error), ...(extra || {}) });
}

/**
 * When a LEGACY_RUN_BUSY lease runs out. A lease is 90 seconds; a request that died holding
 * one used to be reported as "another window", with no end.
 * ★ claim_rows' refusal carries only the run id in its context, so the time is read from the
 *   run itself — a SELECT with the service client, after requireStaff, of one column of the
 *   run the caller already named. A context that does carry `lease_until` wins. Anything that
 *   does not parse as a time is null: the page says "try again shortly", never a made-up time.
 */
async function busyUntilFor(admin, runId, error) {
  if (codeOf(error) !== 'LEGACY_RUN_BUSY') return null;
  const parsed = (at) => (typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null);
  const fromContext = parsed(safeContext(error)?.lease_until);
  if (fromContext || typeof runId !== 'string' || !UUID_RE.test(runId)) return fromContext;
  try {
    const { data, error: readErr } = await admin.from('student_import_activation_runs')
      .select('lease_until').eq('id', runId)
      .abortSignal(AbortSignal.timeout(3_000)).maybeSingle();
    return readErr ? null : parsed(data?.lease_until);
  } catch {
    return null;
  }
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

/**
 * What the server can do right now. Every flag is a fact about configuration, read on each
 * request; nothing here is stored.
 *
 *   sender        the From header migration mail uses, or null when none can be worked out
 *   replyTo       where replies go, and the contact every migration email prints
 *   senderProven  the sender's domain is RESEND_FROM's — the domain every other flow in the
 *                 app sends from every day. Not proof on its own (a key can be restricted),
 *                 which is why send-test exists and the breaker stops a run at the first 403.
 *   support       both addresses are well-formed. #67's flag of the same name checked the
 *                 sender's format; a malformed MIGRATION_EMAIL_FROM or MIGRATION_REPLY_TO
 *                 would otherwise be discovered by Resend, two granted students later.
 *   dailyCap      MIGRATION_DAILY_EMAIL_CAP, else 100 (Resend's free plan). Advisory: the
 *                 confirmation compares a run's emails with it; a 429 is what stops a run.
 */
async function readiness(admin, req) {
  const origin = appOrigin(req);
  const addr = migrationEnvAddresses();
  const resendDomain = addressDomain(process.env.RESEND_FROM);
  const out = {
    service: serviceConfigured(),
    email: Boolean(process.env.RESEND_API_KEY),
    appUrl: Boolean(origin),
    sender: addr.from,
    replyTo: addr.replyTo,
    senderProven: Boolean(addr.fromDomain && resendDomain && addr.fromDomain === resendDomain),
    support: Boolean(addr.from && isAddress(addr.from)) && isAddress(addr.replyTo),
    dailyCap: migrationDailyCap(),
  };
  // ★ A non-null, well-formed sender is required: with none, sendEmail would fall back to
  //   RESEND_FROM's own (typically no-reply) address rather than refuse.
  out.canActivate = Boolean(out.service && out.email && out.appUrl && out.sender && out.support);
  return { flags: out, origin, from: addr.from, replyTo: addr.replyTo };
}

/** The send context every invitation uses: where links point, who it is from, where replies go. */
const sendContext = (ready) => ({ origin: ready.origin, from: ready.from, replyTo: ready.replyTo });

// ── Send-test diagnostics ────────────────────────────────────────────────────
/** The VIP package's name as the catalog has it now, for the sample email. */
async function samplePlanName(admin) {
  try {
    const { data } = await admin.from('enrollment_plans').select('name').eq('key', 'vip')
      .abortSignal(AbortSignal.timeout(3_000)).maybeSingle();
    if (data?.name && String(data.name).trim()) return String(data.name).trim();
  } catch { /* the fallback below */ }
  return PLAN_LABELS.vip || 'VIP Package';
}

/**
 * Is Resend's click tracking on for the sending domain? 'on' | 'off' | 'unknown'.
 * ★ A TRACKED LINK CARRIES THE CLAIM TOKEN THROUGH RESEND'S REDIRECT HOST. Click tracking
 *   rewrites every link, fragment included, to a Resend redirect, so the one-time token
 *   would pass through a third party's servers before reaching the app. The same domains
 *   lookup api/admin/staff.js's email-diagnostics does; a key without the domains
 *   permission (a sending-only key) answers 'unknown', never a guess.
 */
async function clickTrackingFor(domain) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !domain) return 'unknown';
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    const listRes = await fetch('https://api.resend.com/domains', { headers, signal: AbortSignal.timeout(5_000) });
    if (!listRes.ok) return 'unknown';
    const listing = await listRes.json();
    const match = (Array.isArray(listing?.data) ? listing.data : [])
      .find((d) => String(d?.name || '').toLowerCase() === domain) || null;
    if (!match) return 'unknown';
    let d = match;
    if (match.id) {
      const oneRes = await fetch(`https://api.resend.com/domains/${encodeURIComponent(match.id)}`,
        { headers, signal: AbortSignal.timeout(5_000) });
      if (oneRes.ok) d = await oneRes.json();
    }
    if (d?.click_tracking === true) return 'on';
    if (d?.click_tracking === false) return 'off';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * What a send-test result means, in words, naming the sender actually used — never a
 * hard-coded domain (#67's copy told the owner to verify alexsagun.com whatever the cause,
 * and read a timeout, which may still deliver, as a refusal).
 */
function sendTestMessage({ ok, code, limit, from, fromDomain, replyTo }) {
  const domain = fromDomain || 'the sending domain';
  if (ok) {
    return `Sent from ${from} to your own inbox. Check it arrived (and not in spam), then reply to it once: the reply should reach ${replyTo}.`;
  }
  switch (code) {
    case 'resend_401':
      return 'Resend rejected the API key (401). Check RESEND_API_KEY in Vercel. Nothing was sent.';
    case 'resend_403':
      return `Resend refused to send from ${domain} (403). That domain must be verified in Resend → Domains, and the API key must be allowed to send from it. Nothing was sent.`;
    case 'resend_422':
      return `Resend refused the message as malformed (422) — usually the From (${from || 'none'}) or Reply-To (${replyTo}) address. Nothing was sent.`;
    case 'resend_429':
      if (limit === 'rate') {
        return 'Resend\'s per-second rate limit was hit (429), usually by other app email sent in the same second. Nothing was sent; try again in a minute.';
      }
      return 'Resend\'s sending limit was reached (429): the per-second rate or the daily allowance. Nothing was sent; try again later.';
    case 'resend_timeout':
    case 'resend_failed':
      return 'Resend did not answer in time. The email may still arrive — check your inbox before sending another.';
    case 'email_not_configured':
      return 'Email sending is not configured on the server (RESEND_API_KEY). Nothing was sent.';
    case 'email_from_not_configured':
      return 'No migration sender could be worked out. Set MIGRATION_EMAIL_FROM, or RESEND_FROM on a domain verified in Resend. Nothing was sent.';
    default:
      if (/^resend_5\d\d$/.test(String(code || ''))) {
        return `Resend had a server error (${code}). The email may or may not arrive — check your inbox before sending another.`;
      }
      return `The test email was not sent (${code || 'unknown'}).`;
  }
}

function notReadyMessage(flags) {
  const missing = [];
  if (!flags.service) missing.push('the service key (SUPABASE_SECRET_KEY)');
  if (!flags.email) missing.push('email sending (RESEND_API_KEY)');
  if (!flags.appUrl) missing.push('the app address (APP_URL)');
  if (!flags.sender) missing.push('a sender (MIGRATION_EMAIL_FROM, or RESEND_FROM on a verified domain)');
  else if (!flags.support) missing.push('well-formed sender and reply-to addresses (MIGRATION_EMAIL_FROM, MIGRATION_REPLY_TO)');
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

  // ★ community_segment decides whether a row needs a batch at all (#68): a cohort seat is a
  //   VIP-only fact, so a Silver or Essentials row skips every batch rule. tagline and
  //   access_days feed the label suggestions and the term-length warning.
  const [plansRes, batchesRes] = await Promise.all([
    admin.from('enrollment_plans').select('key,name,tagline,price_php,active,access_days,community_segment')
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)),
    admin.from('batches').select('id,code,name,status').abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)),
  ]);
  if (plansRes.error || batchesRes.error) {
    return { status: 503, body: { error: 'Could not read the plan catalog or the batch registry. Nothing was staged; try again.', code: 'rpc_failed' } };
  }

  const eligibleBatchCodes = Array.isArray(body.eligibleBatchCodes) ? body.eligibleBatchCodes : [];
  // Which self-paced (non-VIP) plans start Ready. A VIP row is Ready by cohort instead.
  const eligiblePlanKeys = (Array.isArray(body.eligiblePlanKeys) ? body.eligiblePlanKeys : [])
    .filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());

  const normalized = normalizeLegacyRows(rows, {
    mapping: body.mapping || {},
    dateFormat: body.dateFormat,
    planMapping: body.planMapping || {},
    batchMapping: body.batchMapping || {},
    plans: plansRes.data || [],
    batches: batchesRes.data || [],
    eligibleBatchCodes,
    eligiblePlanKeys,
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
    eligible_batch_codes: eligibleBatchCodes,
    // Part of the reopen settings comparison: the same roster with different ticks is a
    // different job, and LEGACY_JOB_SETTINGS_DIFFER names it.
    eligible_plan_keys: eligiblePlanKeys,
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
 * Replace an account's password with one nobody knows. Returns whether Auth accepted it.
 * ★ The password exists only inside this call: it is never logged, stored or returned.
 */
async function rotatePassword(admin, uid) {
  if (typeof uid !== 'string' || !UUID_RE.test(uid)) return false;
  try {
    const { error } = await Promise.race([
      admin.auth.admin.updateUserById(uid, { password: randomBytes(32).toString('base64url') }),
      sleep(AUTH_TIMEOUT_MS).then(() => ({ error: { code: 'auth_timeout' } })),
    ]);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Must this row's account lose its old password before a claim link goes to it (E8)?
 * true | false, or null when that could not be established.
 *
 * ★ A PRE-EXISTING, UNCONFIRMED ACCOUNT THE IMPORT DID NOT CREATE: whoever registered it chose
 *   its password and could not sign in only because the address was unconfirmed. The claim
 *   link confirms it, so a student who clicks and then abandons the set-password step would
 *   leave that password working on a paid account.
 * ★ DURABLE, NOT BEST EFFORT (#68, V3). The facts are the row's own —
 *   `matched_existing && !existing_confirmed && !auth_user_created`, written by
 *   legacy_import_bind_user() and never changed after activation — so EVERY claim send asks,
 *   not only the one straight after the grant: a lost activate_row answer, a killed function
 *   or a refused password change used to leave the next chunk's owed invitation, a Resend and
 *   "Resend failed" all sending the link over the old password.
 *   Where the facts come from, first match wins:
 *     1. begin_invite's answer, when it carries all three flags;
 *     2. `hint` — the bind answer of the request that just activated the row (created,
 *        confirmed), which is what legacy_import_bind_user() wrote onto the row;
 *     3. the row itself — a SELECT with the service client, after requireStaff.
 *   Rotating on every claim send is safe: a claim is only ever sent while the student has not
 *   finished setting up (a completed account gets the sign-in notice instead), and the claim
 *   screen always asks for a new password.
 */
async function rotationNeeded(admin, rowId, inv, hint) {
  const flags = ['matched_existing', 'existing_confirmed', 'auth_user_created'];
  if (flags.every((k) => typeof inv?.[k] === 'boolean')) {
    return inv.matched_existing && !inv.existing_confirmed && !inv.auth_user_created;
  }
  if (hint && typeof hint.created === 'boolean' && (hint.created || typeof hint.confirmed === 'boolean')) {
    return !hint.created && !hint.confirmed;
  }
  try {
    const { data, error } = await admin.from('student_import_rows')
      .select('matched_existing,existing_confirmed,auth_user_created').eq('id', rowId)
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)).maybeSingle();
    if (error || !data) return null;
    return Boolean(data.matched_existing && !data.existing_confirmed && !data.auth_user_created);
  } catch {
    return null;
  }
}

/**
 * Mint (for a claim) and send one invitation under a new generation, then record it.
 * Returns `{ state, code }`: the recorded state and the safe code behind it. A provider
 * answer that may have been delivered is `uncertain`, never retried under a new token
 * automatically.
 *
 * `handBack` (a run's own sends only): an answer that PROVES nothing was delivered is
 * recorded as `not_sent`, so the run's next request re-sends it once the cause is fixed.
 * ★ Never for `resend` / `resend-failed`: those rows may belong to a finished run, whose
 *   pending invitations nothing picks up — handed back, the row would leave the failed list
 *   that "Resend failed invitations" works from and be stranded. There they stay `failed`.
 *
 * `account` (processRow only): the bind answer `{ uid, created, confirmed }` of the request
 * that just activated this row — spares rotationNeeded() a read. Everyone else passes none.
 *
 * `limit` rides on the answer for a 429: 'rate' or 'quota' (sendEmail's resendLimitKind).
 */
async function sendInvite(admin, actorId, rowId, ctx, { resend = false, handBack = false, account = null } = {}) {
  const { data: inv, error } = await rpc(admin, 'legacy_import_begin_invite', { p_actor: actorId, p_row_id: rowId, p_resend: resend });
  if (error) return { state: 'error', code: codeOf(error) };
  // ★ #68: an invitation that can never succeed (the account is gone, or the generation cap
  //   is reached) is recorded `failed` BY begin_invite, with its code, instead of raising —
  //   one such row used to stall a run's owed invitations for good. Handled, not a stop.
  if (inv && inv.skip && inv.code) return { state: 'failed', code: String(inv.code) };
  if (!inv || inv.skip) return { state: 'skipped', code: null };

  const record = async (state, code) => {
    const final = handBack && state === 'failed' && NOTHING_SENT_CODES.has(code) ? 'not_sent' : state;
    const r = await rpc(admin, 'legacy_import_record_delivery', {
      p_actor: actorId, p_row_id: rowId, p_generation: inv.generation, p_state: final, p_code: code || null,
    });
    if (r.error) console.error(`[student-imports] record delivery failed: ${codeOf(r.error)}`);
    return { state: final, code: code || null };
  };

  // ★ Never fall back to RESEND_FROM's own address: with no migration sender there is
  //   nothing to send from (readiness refuses to activate, so this is a second line).
  //   sendEmail treats an empty `from` as "use RESEND_FROM", so the refusal must be here.
  //   In a run it is handed back to `not_sent` and trips the breaker (email_unconfigured).
  if (!ctx.from) return record('failed', 'email_from_not_configured');

  let url = null;
  if (inv.kind === 'claim') {
    // ★ E8, BEFORE THE LINK IS MINTED (#68, V3): an account someone else may have registered
    //   loses that password on every claim send, or the claim is not sent. A refusal — or a
    //   row whose facts could not be read — is recorded `failed` / rotation_failed: never a
    //   hand-back (the SQL accepts `not_sent` only for codes that prove nothing reached
    //   anyone), so the row surfaces in the problem list and "Resend failed" retries it.
    //   Two in a row stop a run (AUTH_FAILURE_CODES).
    const rotate = await rotationNeeded(admin, rowId, inv, account);
    if (rotate !== false) {
      const rotated = rotate === true && await rotatePassword(admin, inv.user_id || account?.uid);
      if (!rotated) {
        console.error(`[student-imports] account password not replaced (${rotate === null ? 'facts unread' : 'auth refused'}): rotation_failed`);
        return record('failed', 'rotation_failed');
      }
    }
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
    batchName: inv.batch_name,
    startDate: inv.start_date,
    endDate: inv.end_date,
    supportEmail: ctx.replyTo,
    nowMs: Date.now(),
  });
  url = null;   // the token lives only inside msg until it is sent; nothing else keeps it

  const sent = await sendEmail({
    to: inv.email,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    replyTo: ctx.replyTo,
    from: ctx.from,
    idempotencyKey: `legacy-claim-${rowId}-${inv.generation}`,
    tag: 'student-imports',
    timeoutMs: SEND_TIMEOUT_MS,
    // A second attempt reuses THIS key and THIS token, so the provider de-duplicates it.
    // A 429 is not slept on inside the time budget: nothing was delivered, so in a run it is
    // handed back to not_sent and the run pauses (the breaker); a resend records it failed,
    // for "Resend failed invitations" to pick up once the quota resets.
    maxAttempts: 2,
    retry429: false,
    // A 429 says which limit it is — the per-second rate or the daily quota — so a run can
    // tell the owner whether a Resume in a minute will work (#68, V5).
    classify429: true,
  });
  if (sent.ok) return record(inv.kind === 'claim' ? 'sent' : 'notified', null);
  const unclear = sent.code === 'resend_timeout' || sent.code === 'resend_failed' || sent.code === 'resend_409'
    || /^resend_5\d\d$/.test(sent.code || '');
  const out = await record(unclear ? 'uncertain' : 'failed', sent.code);
  return sent.code === 'resend_429' && sent.limit ? { ...out, limit: sent.limit } : out;
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

    // ★ E8 — the old password of a pre-existing, unconfirmed account the import did not create
    //   is replaced INSIDE sendInvite, before each claim link is minted (#68, V3), so every
    //   path that sends a claim does it and a refusal holds the email back. It used to happen
    //   here, once, best effort: a lost activate_row answer or a killed function skipped it,
    //   and the next chunk's owed invitation went out over the old password.
    //   ★ Still AFTER the grant, never before binding: sendInvite runs only for an activated
    //   row, and activate_row refuses staff — an invited staff member has no password, and
    //   staff_invitation_state()'s has_password reads it, so one set before that refusal
    //   would silently skip that invitee's password step.
    const account = bind.data ? { uid, created: bind.data.created, confirmed: bind.data.confirmed } : null;
    const inv = await sendInvite(admin, actorId, row.row_id, ctx, { handBack: true, account });
    return {
      row_id: row.row_id, outcome: 'activated', status: act.data.status, invite: inv.state, code: inv.code || null,
      ...(inv.limit ? { limit: inv.limit } : {}),
    };
  } catch (e) {
    const code = e?.safeCode || 'unexpected';
    const marked = await rpc(admin, 'legacy_import_mark_failed', { p_actor: actorId, p_row_id: row.row_id, p_run_id: runId, p_code: code });
    if (marked.error) console.error(`[student-imports] mark failed refused: ${codeOf(marked.error)}`);
    console.error(`[student-imports] row failed: ${code}`);
    return { row_id: row.row_id, outcome: 'failed', code };
  }
}

/**
 * One request's share of a run. Returns `{ status, body }`, or `{ error, busyUntil }`
 * when nothing could be done at all.
 *
 * body: { ok, results, run, stopped, code, busyUntil }
 *   stopped  null, or why this request stopped early and paused the run:
 *            'sender_refused' | 'email_quota' | 'email_rate_limited' | 'email_unconfigured' |
 *            'invalid_request' | 'auth_unavailable'
 *   code     the code behind `stopped` (e.g. 'resend_403', 'resend_429', 'link_failed')
 */
async function doActivateChunk(admin, actorId, body, ctx) {
  const runId = body?.runId;
  if (!runId) return { status: 400, body: { error: 'runId required.' } };
  const lease = randomBytes(18).toString('base64url');
  const t0 = Date.now();
  const left = () => CHUNK_BUDGET_MS - (Date.now() - t0);
  const results = [];
  const tried = [];
  const breaker = invitationBreaker();
  let stopped = null;
  let stopCode = null;
  let claimError = null;
  const trips = (outcome) => {
    const why = breaker(outcome);
    if (why) { stopped = why; stopCode = outcome.code || null; }
    return Boolean(why);
  };

  // Owed invitations (#67's "pass 2", now run FIRST): rows a previous request activated but
  // never emailed, including those the breaker handed back.
  // ★ OWED EMAILS GO BEFORE ANY NEW GRANT. Resuming a run the breaker paused re-sends
  //   these first, so if the sender is still refused it stops again having granted NOBODY
  //   new. Claiming first would grant one more student without an email on every Resume
  //   pressed while the sender is being fixed. Safe without the lease: begin_invite locks
  //   the row and skips one that is no longer `not_sent`, so two windows never both send it.
  // ★ p_exclude: a row tried in this request is not picked again by it. Without it a row
  //   begin_invite refused sat at the head of the queue and was the only row this pass saw.
  while (!stopped && left() > SEND_TIMEOUT_MS + 2 * RPC_TIMEOUT_MS) {
    const pending = await rpc(admin, 'legacy_import_pending_invites', {
      p_actor: actorId, p_run_id: runId, p_limit: 1, p_exclude: tried,
    });
    const ids = Array.isArray(pending.data) ? pending.data : [];
    if (pending.error || !ids.length) break;
    const rowId = ids[0];
    tried.push(rowId);
    const inv = await sendInvite(admin, actorId, rowId, ctx, { handBack: true });
    const outcome = {
      row_id: rowId, outcome: 'invited', invite: inv.state, code: inv.code || null,
      ...(inv.limit ? { limit: inv.limit } : {}),
    };
    results.push(outcome);
    if (trips({ state: inv.state, code: inv.code, limit: inv.limit })) break;
    // A database that stopped answering: the next row would meet the same silence.
    if (inv.state === 'error' && TRANSPORT_CODES.has(inv.code)) break;
    await sleep(PACE_MS);
  }

  // Then rows not yet activated, one at a time, while a whole row still fits.
  while (!stopped && left() > PER_ROW_WORST_MS) {
    const claim = await rpc(admin, 'legacy_import_claim_rows', {
      p_actor: actorId, p_run_id: runId, p_lease: lease, p_limit: 1,
      p_retry_failed: Boolean(body.retryFailed), p_exclude: tried,
    });
    if (claim.error) { claimError = claim.error; break; }
    const rows = Array.isArray(claim.data) ? claim.data : [];
    if (!rows.length) break;
    for (const row of rows) {
      tried.push(row.row_id);
      const outcome = await processRow(admin, actorId, runId, row, ctx);
      results.push(outcome);
      if (outcome.outcome === 'activated' && trips({ state: outcome.invite, code: outcome.code, limit: outcome.limit })) break;
      await sleep(PACE_MS);
    }
  }

  // ★ RELEASED ON THE EARLY-ERROR PATH TOO (B5). A claim whose answer timed out here may
  //   still have committed OUR lease; returning before the release left the run refusing
  //   every Resume as "another window" for 90 seconds. The one exception is LEGACY_RUN_BUSY:
  //   claim_rows raises it BEFORE taking any lease, so there is nothing of ours to release —
  //   and release_run also recomputes the run's status, which would flip a run someone just
  //   paused back to 'running' underneath the window that holds it.
  //   A stop pauses the run: rows handed back are still owed, so the run stays open for a
  //   Resume rather than completing around them.
  const busy = Boolean(claimError) && codeOf(claimError) === 'LEGACY_RUN_BUSY';
  let rel = { data: null, error: null };
  if (!busy) {
    rel = await rpc(admin, 'legacy_import_release_run', {
      p_actor: actorId, p_run_id: runId, p_lease: lease, p_pause: Boolean(stopped),
    });
    if (rel.error) console.error(`[student-imports] release refused: ${codeOf(rel.error)}`);
  }
  if (stopped) console.error(`[student-imports] run stopped: ${stopped} ${stopCode || ''}`.trim());

  const busyUntil = busy ? await busyUntilFor(admin, runId, claimError) : null;
  if (claimError && !results.length) return { error: claimError, busyUntil };
  return { status: 200, body: { ok: true, results, run: rel.data || null, stopped, code: stopCode, busyUntil } };
}

/** The profiles, among `userIds`, that have finished setting up (onboarding_status completed). */
const PROFILE_READ_CHUNK = 100;   // ids per `in` filter: a URL, not a body, carries them

async function onboardedUserIds(admin, userIds) {
  const done = new Set();
  for (let i = 0; i < userIds.length; i += PROFILE_READ_CHUNK) {
    const chunk = userIds.slice(i, i + PROFILE_READ_CHUNK);
    let got;
    try {
      got = await admin.from('profiles').select('id,onboarding_status').in('id', chunk)
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    } catch (e) {
      got = { data: null, error: { code: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'rpc_timeout' : 'rpc_failed' } };
    }
    if (got.error) return { error: got.error };
    for (const p of Array.isArray(got.data) ? got.data : []) {
      if (p?.id && p.onboarding_status === 'completed') done.add(p.id);
    }
  }
  return { done };
}

/**
 * Re-send the invitations of a job that failed — and, only when asked, the ones whose
 * outcome is uncertain (they may already be in the student's inbox).
 *
 * Returns `{ status, body }` or `{ error }`.
 * body: { ok, results, remaining, stopped, code, tried, unrecoverable, skipped_onboarded }
 *   remaining      rows still to try in this pass: eligible, not in `exclude`, not reached
 *   tried          the row ids attempted by this request; a caller looping over a job passes
 *                  them back as `exclude`, so each row is tried once per pass even when it
 *                  fails again (a failed resend stays `failed`)
 *   unrecoverable  rows left out because no resend can succeed (account gone, cap reached)
 *   skipped_onboarded  rows left out because their student has already claimed the account
 *                  and finished setting it up (#68, V6) — nothing is owed to them
 *
 * ★ READ WITH THE SERVICE CLIENT, AFTER requireStaff — SELECTs only. Every write still goes
 *   through legacy_import_begin_invite / legacy_import_record_delivery, which re-check the
 *   actor and the row. The browser names a job, never a row to widen the set: `exclude` can
 *   only remove rows from it.
 *
 * ★ A STUDENT WHO HAS ALREADY ONBOARDED IS NOT EMAILED AGAIN (#68, V6). Nothing moves a row's
 *   invite_state when its student claims, so a claim that timed out yet was delivered, or one
 *   recovered through "Forgot password", stays failed/uncertain for ever — and begin_invite
 *   turns such a row into the "your membership has moved, sign in" notice, out of the blue.
 *   The per-row Resend already refuses a claimed row; this matches it: a row whose profile's
 *   onboarding_status is 'completed' is skipped unless the row is existing_confirmed (an
 *   account that already had a password, whose invitation IS that sign-in notice). An
 *   unreadable profile list sends nothing, like an unreadable row list.
 */
async function doResendFailed(admin, actorId, body, ctx) {
  const states = body?.includeUncertain === true ? ['failed', 'uncertain'] : ['failed'];
  const exclude = new Set(uuidList(body?.exclude, MAX_STAGE_ROWS));
  let listed;
  try {
    listed = await admin.from('student_import_rows')
      .select('id,invite_code,invite_generation,target_user_id,existing_confirmed')
      .eq('job_id', body.jobId)
      .eq('activation_state', 'activated')
      .in('invite_state', states)
      // Least recently touched first, so a row that just failed again waits its turn.
      .order('updated_at', { ascending: true })
      .order('source_row_number', { ascending: true })
      .limit(MAX_STAGE_ROWS)
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
  } catch (e) {
    listed = { data: null, error: { code: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'rpc_timeout' : 'rpc_failed' } };
  }
  if (listed.error) return { error: listed.error };

  const listedRows = (Array.isArray(listed.data) ? listed.data : []).filter((r) => r?.id && !exclude.has(r.id));
  // A claim-kind row (not existing_confirmed) whose student has finished onboarding owes nothing.
  const toCheck = [...new Set(listedRows
    .filter((r) => r.existing_confirmed !== true && typeof r.target_user_id === 'string' && UUID_RE.test(r.target_user_id))
    .map((r) => r.target_user_id))];
  const onboarded = toCheck.length ? await onboardedUserIds(admin, toCheck) : { done: new Set() };
  if (onboarded.error) return { error: onboarded.error };
  const rows = listedRows.filter((r) => !(r.existing_confirmed !== true && onboarded.done.has(r.target_user_id)));
  const skippedOnboarded = listedRows.length - rows.length;
  const candidates = rows
    .filter((r) => !NEVER_SUCCEEDS.has(r.invite_code) && !(Number(r.invite_generation) >= MAX_INVITE_GENERATION))
    .map((r) => r.id);
  const unrecoverable = rows.length - candidates.length;

  const t0 = Date.now();
  const left = () => CHUNK_BUDGET_MS - (Date.now() - t0);
  const breaker = invitationBreaker();
  const results = [];
  const tried = [];
  let stopped = null;
  let stopCode = null;
  for (const rowId of candidates) {
    if (left() <= SEND_TIMEOUT_MS + 2 * RPC_TIMEOUT_MS) break;
    tried.push(rowId);
    const inv = await sendInvite(admin, actorId, rowId, ctx, { resend: true });
    results.push({ row_id: rowId, invite: inv.state, code: inv.code || null, ...(inv.limit ? { limit: inv.limit } : {}) });
    const why = breaker({ state: inv.state, code: inv.code, limit: inv.limit });
    if (why) { stopped = why; stopCode = inv.code || null; break; }
    if (inv.state === 'error' && TRANSPORT_CODES.has(inv.code)) break;
    await sleep(PACE_MS);
  }
  if (stopped) console.error(`[student-imports] resend-failed stopped: ${stopped} ${stopCode || ''}`.trim());
  return {
    status: 200,
    body: {
      ok: true, results, remaining: candidates.length - tried.length, stopped, code: stopCode, tried, unrecoverable,
      skipped_onboarded: skippedOnboarded,
    },
  };
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
      const r = await doActivateChunk(admin, actorId, body, sendContext(ready));
      if (r.error) return fail(res, action, r.error, 'The activation could not continue.', { busyUntil: r.busyUntil ?? null });
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
      const fromDomain = addressDomain(ready.from);
      // One answer shape for every outcome, a missing key included: the page shows `message`,
      // which names what to fix, rather than the activation-readiness sentence.
      if (!ready.flags.email) {
        const code = 'email_not_configured';
        return res.status(200).json({
          ok: false, code, from: ready.from, replyTo: ready.replyTo,
          message: sendTestMessage({ ok: false, code, from: ready.from, fromDomain, replyTo: ready.replyTo }),
          clickTracking: 'unknown',
        });
      }
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
      // nothing about any student is read or sent. The package is the catalog's own VIP name,
      // so the test proofs the wording students will actually read.
      const [sent, clickTracking] = await Promise.all([
        (async () => {
          if (!ready.from) return { ok: false, code: 'email_from_not_configured' };
          const msg = legacyMembershipEmail({
            kind: 'claim', actionUrl: ready.origin ? `${ready.origin}/` : 'https://example.invalid/',
            fullName: 'Sample Student', email: 'sample.student@example.invalid',
            planName: await samplePlanName(admin), batchName: 'October 2026',
            startDate: '2026-10-12', endDate: '2027-04-12', supportEmail: ready.replyTo, nowMs: Date.now(),
          });
          return sendEmail({
            to, subject: `[Test] ${msg.subject}`, html: msg.html, text: msg.text,
            replyTo: ready.replyTo, from: ready.from, tag: 'student-imports-test',
            timeoutMs: SEND_TIMEOUT_MS, maxAttempts: 1, retry429: false, classify429: true,
          });
        })(),
        clickTrackingFor(fromDomain),
      ]);
      if (!sent.ok) console.error(`[student-imports] test send failed: ${sent.code}`);
      const code = sent.ok ? null : sent.code;
      return res.status(200).json({
        ok: sent.ok, code, from: ready.from, replyTo: ready.replyTo,
        message: sendTestMessage({ ok: sent.ok, code, limit: sent.limit, from: ready.from, fromDomain, replyTo: ready.replyTo }),
        clickTracking,
      });
    }

    if (action === 'resend') {
      if (!body?.rowId) return res.status(400).json({ error: 'rowId required.' });
      const ready = await readiness(admin, req);
      if (!ready.flags.canActivate) {
        return res.status(409).json({ error: notReadyMessage(ready.flags), code: 'NOT_READY', readiness: ready.flags });
      }
      const inv = await sendInvite(admin, actorId, body.rowId, sendContext(ready), { resend: true });
      if (inv.state === 'error') return fail(res, action, { hint: inv.code }, 'The invitation could not be resent.');
      return res.status(200).json({ ok: true, state: inv.state, code: inv.code || null });
    }

    if (action === 'resend-failed') {
      if (typeof body?.jobId !== 'string' || !UUID_RE.test(body.jobId)) {
        return res.status(400).json({ error: 'jobId required.' });
      }
      const ready = await readiness(admin, req);
      if (!ready.flags.canActivate) {
        return res.status(409).json({ error: notReadyMessage(ready.flags), code: 'NOT_READY', readiness: ready.flags });
      }
      const r = await doResendFailed(admin, actorId, body, sendContext(ready));
      if (r.error) return fail(res, action, r.error, 'The failed invitations could not be read. Nothing was sent.');
      return res.status(r.status).json(r.body);
    }

    if (action === 'reset-onboarding-notice') {
      if (typeof body?.rowId !== 'string' || !UUID_RE.test(body.rowId)) {
        return res.status(400).json({ error: 'rowId required.' });
      }
      // Service-only and audited: it lets the two "onboarded" emails be tried again once an
      // exhausted or stuck notice has a fixed cause. It sends nothing itself — the student's
      // app asks again the next time it opens.
      const { data, error } = await rpc(admin, 'legacy_import_reset_onboarding_notice', { p_actor: actorId, p_row_id: body.rowId });
      if (error) return fail(res, action, error, 'The onboarding emails could not be reset.');
      return res.status(200).json(data || { ok: true });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error(`[student-imports] ${String(action || 'request').slice(0, 30)} failed: ${String(err?.safeCode || err?.code || err?.name || 'error').slice(0, 60)}`);
    return res.status(500).json({ error: 'The migration request failed. Nothing was sent twice; try again.' });
  }
}

// Exported for test/legacyMigrationSql.test.mjs and test/studentImportsEndpoint.test.mjs.
export {
  appOrigin, codeOf, contentFingerprint, doStage, invitationBreaker, notReadyMessage, sendTestMessage,
  AUTH_FAILURE_CODES, MAX_INVITE_GENERATION, NOTHING_SENT_CODES, STOP_CODES,
};
