// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — ADMIN-ONLY student import (Thinkific migration).
// ─────────────────────────────────────────────────────────────────────────────
// This is the ONLY place that holds the Supabase SERVICE-ROLE key and the ONLY
// place that creates Auth accounts / grants imported subscription terms. Every
// action:
//   1. verifies the caller's Supabase Bearer JWT (against /auth/v1/user), AND
//   2. independently confirms profiles.is_admin (read with the CALLER's JWT),
//   BEFORE the service-role client is ever constructed.
// The service key is server-only (SUPABASE_SECRET_KEY, legacy fallback
// SUPABASE_SERVICE_ROLE_KEY), never VITE_-prefixed, and is NEVER returned in a
// response or logged. Names/emails/raw rows/invite links are never logged either.
//
// Actions (POST body.action):
//   'dry-run'       — recompute matches + proposed actions for a job's staged rows
//                     (NO account/subscription mutations). Idempotent.
//   'process'       — process the next bounded batch from the job cursor; persist
//                     every row result so a browser close / deploy / timeout resumes.
//   'resend-invite' — re-mint a fresh set-password link for one imported, not-yet-
//                     onboarded user (no new user / subscription).
//   GET             — health: { ok, configured, hasSecretKey, hasResend } (booleans only).
//
// Idempotency (retry-safe): auth email uniqueness (Supabase) + student_external_accounts
// unique(source, external_user_id) + subscriptions.source_import_row_id unique. A retry
// after "auth user created but grant failed" re-matches the existing user and completes
// the grant — never a duplicate account / link / subscription. An existing Auth user is
// NEVER auto-deleted.
//
// Runs on Vercel AND under `npm run dev` (via the studentImportDevApi middleware in
// vite.config.js), so the same auth gate is exercised locally.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import {
  normalizeEmail, isValidEmail,
  resolveMatchDecision, computeImportTerm, decideOnboardingStep,
} from '../../src/lib/studentImport.js';
import { planSegment, resolveBatchForImport, batchGapForProcess } from '../../src/lib/communitySpaces.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const BRAND = 'Toolkits by Alex';
const SOURCE = 'thinkific';
const MAX_BATCH = 25;
const CHUNK = 200;                       // bulk .in() lookup chunk size
const PLAN_ALLOWLIST_FALLBACK = ['core_self_paced', 'sampler', 'silver_self_paced', 'gold_live', 'vip'];

// ── Per-warm-instance burst guard (same best-effort pattern as the other endpoints) ──
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 30;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (rateHits.get(userId) || []).filter((t) => t >= cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

// ── Auth helpers (reuse the notify-*/proxy idiom; never touch the service key here) ──
async function callerUser(authHeader) {
  if (!authHeader || !SUPABASE_URL || !ANON_KEY) return null;
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, token } : null;
  } catch { return null; }
}
async function callerIsAdmin(u) {
  if (!u) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=is_admin`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${u.token}` } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0]?.is_admin === true;
  } catch { return false; }
}

function service() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Redacted audit event (IDs + safe codes only — never PII/links) ───────────────
async function logEvent(admin, { jobId, rowId, actorId, kind, status, detail }) {
  try {
    await admin.from('student_import_events').insert({
      job_id: jobId, row_id: rowId || null, actor: actorId || null,
      kind, status: status || null, detail: detail || {},
    });
  } catch { /* audit is best-effort; never blocks the operation */ }
}

// ── Resend invite email (link generated, emailed, then DISCARDED) ────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inviteHtml(actionLink) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f7fb;padding:32px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e6ebf2;">
    <div style="background:linear-gradient(180deg,#3aa0ff,#0A84FF);padding:26px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800;">${esc(BRAND)}</h1></div>
    <div style="padding:28px;color:#1c2430;">
      <h2 style="font-size:18px;margin:0 0 8px;">Your account is ready — set your password</h2>
      <p style="font-size:14px;line-height:1.6;color:#48505e;margin:0 0 20px;">We've moved your membership into the new ${esc(BRAND)} toolkit. Click below to set your own password and sign in. This link is single-use and expires soon.</p>
      <div style="text-align:center;margin:0 0 20px;">
        <a href="${esc(actionLink)}" style="display:inline-block;background:#0A84FF;color:#fff;border-radius:10px;padding:12px 24px;font-size:14px;font-weight:700;text-decoration:none;">Set my password</a>
      </div>
      <p style="font-size:12px;color:#8a93a3;margin:8px 0 0;">If you didn't expect this, you can ignore it.</p>
    </div></div></div>`;
}
async function sendInviteEmail(email, actionLink) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) return { ok: false, code: 'email_not_configured' };
  // Honor Retry-After / 429 with a small exponential backoff.
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to: [email], subject: `Set your ${BRAND} password`, html: inviteHtml(actionLink) }),
      });
    } catch { r = null; }
    if (r && r.ok) return { ok: true };
    if (r && r.status === 429) {
      const retryAfter = Number(r.headers.get('retry-after')) || (2 ** attempt);
      await new Promise((res) => setTimeout(res, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (r) { console.error(`[student-imports] resend ${r.status}`); return { ok: false, code: `resend_${r.status}` }; }
    await new Promise((res) => setTimeout(res, (2 ** attempt) * 500));
  }
  return { ok: false, code: 'resend_failed' };
}

// ── Bulk match lookups (dry-run) ────────────────────────────────────────────────
async function chunkedIn(admin, table, column, values, select) {
  const out = [];
  const uniq = [...new Set(values.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const { data, error } = await admin.from(table).select(select).in(column, slice);
    if (error) throw error;
    if (data) out.push(...data);
  }
  return out;
}

// Resolve the proposed action for a single already-normalized staged row.
function proposeForRow(row, { bySourceMap, byEmailMap, comboPlanMap, planAccessDays, planRows, batchesByCode, defaultTermMode, now }) {
  const warnings = [];
  const errors = [];
  const emailNorm = row.email_normalized || '';
  const hasEmail = emailNorm.length > 0;
  const emailValid = hasEmail; // email_normalized is '' unless it already validated

  const bySource = row.external_user_id ? (bySourceMap.get(row.external_user_id) || null) : null;
  const emailHit = hasEmail ? byEmailMap.get(emailNorm) : null;
  const byEmail = emailHit && emailHit.length === 1 ? emailHit[0] : null;
  const byEmailAmbiguous = !!(emailHit && emailHit.length > 1);

  const match = resolveMatchDecision({ hasEmail, emailValid }, { bySource, byEmail, byEmailAmbiguous });

  // Plan mapping comes from the admin's explicit decision, never inferred. A per-row
  // `plan_key` (the supplemental-CSV override column, §3.4) wins over the course-combo map,
  // but ONLY when it names a known/allowlisted plan — an unknown or blank override falls
  // through to the combo mapping (and ultimately manual_review) rather than silently
  // granting the wrong plan. Same trust level as the combo map: an admin-typed value, not
  // inferred from a title/date/amount.
  const comboKey = row.mapped?.combo_key || '';
  const rowOverride = (row.mapped?.plan_key && planAccessDays.has(row.mapped.plan_key))
    ? row.mapped.plan_key : null;
  const mapping = rowOverride || comboPlanMap[comboKey] || null;
  const overrideMode = row.mapped?.term_mode || defaultTermMode || 'preserve';

  let intended = match.intended_action;
  let planKey = null;
  let termMode = overrideMode;
  let proposedStart = row.proposed_started_at ? Date.parse(row.proposed_started_at) : null;
  let proposedEnds = row.proposed_ends_at ? Date.parse(row.proposed_ends_at) : null;
  let proposedBatchId = null;
  let blocked = match.blocked;

  if (match.reason && match.blocked) errors.push(match.reason);
  else if (match.reason) warnings.push(match.reason);

  // Explicit "profile only / manual review" mappings override the term entirely.
  const mappedTarget = row.mapped?.plan_choice || mapping || null;
  if (mappedTarget === 'profile_only') {
    intended = 'profile_only'; termMode = 'profile_only'; blocked = false;
  } else if (mappedTarget === 'manual_review' || !mappedTarget) {
    intended = 'manual_review'; blocked = true;
    warnings.push('No confirmed plan mapping for this course combination.');
  } else if (!match.blocked) {
    planKey = mappedTarget;
    const accessDays = planAccessDays.has(planKey) ? planAccessDays.get(planKey) : null;
    const term = computeImportTerm({
      planKey, accessDays, startedAt: proposedStart, endsAt: proposedEnds,
      mode: termMode, now,
    });
    if (term.action === 'block_missing_expiry') {
      blocked = true; intended = 'manual_review';
      errors.push('Preserve mode needs an exact expiry date — supply it or choose another term mode.');
    } else if (term.action === 'block_conflict') {
      blocked = true; intended = 'manual_review';
      errors.push(term.reason || 'Plan conflict — resolve manually.');
    }
    proposedStart = term.started_at;
    proposedEnds = term.ends_at;

    // Batch resolution (#32): gold/vip rows need an explicit, confirmed OPEN
    // batch_code — NEVER inferred from Thinkific history. resolveBatchForImport
    // blocks premium rows without one; general rows ignore a stray code.
    const batchRes = resolveBatchForImport({
      segment: planSegment(planKey, planRows || {}),
      batchCodeRaw: row.mapped?.batch_code,
      batchesByCode: batchesByCode || {},
    });
    if (batchRes.blocked) {
      blocked = true; intended = 'manual_review';
      errors.push(batchRes.reason);
    } else {
      proposedBatchId = batchRes.batchId;
      if (batchRes.warning) warnings.push(batchRes.warning);
    }
  }

  return {
    match_result: match.match_result,
    target_user_id: match.target_user_id,
    intended_action: intended,
    proposed_plan_key: planKey,
    proposed_term_mode: termMode,
    proposed_started_at: proposedStart != null ? new Date(proposedStart).toISOString() : null,
    proposed_ends_at: proposedEnds != null ? new Date(proposedEnds).toISOString() : null,
    proposed_batch_id: proposedBatchId,
    processing_status: blocked ? 'blocked' : (intended === 'skip' ? 'skipped' : 'ready'),
    warnings, errors,
  };
}

// Throws on any failure other than "the #32 column isn't there yet". Degrading to the
// hardcoded PLAN_SEGMENT_FALLBACK would classify every premium plan key that isn't
// literally gold_live/vip as `general` — skipping the batch requirement and granting
// batch-less access with no blocked row to show for it — and would also leave
// access_days empty so every term lands with a null expiry. Segment and term length
// must come from the live table or the run must stop.
async function loadPlanAccessDays(admin) {
  const map = new Map();
  const allow = new Set(PLAN_ALLOWLIST_FALLBACK);
  const planRows = {};    // key → { community_segment } (planSegment falls back pre-#32)
  let segmentAvailable = true;
  // community_segment arrives with #32; a pre-#32 DB 42703s → retry without it.
  let res = await admin.from('enrollment_plans').select('key, access_days, community_segment');
  if (res.error && ['42703', 'PGRST204'].includes(String(res.error.code))) {
    segmentAvailable = false;
    res = await admin.from('enrollment_plans').select('key, access_days');
  }
  if (res.error) {
    const err = new Error('Could not read enrollment_plans — aborting so no row is graded against stale plan data.');
    err.code = String(res.error.code || 'plans_unavailable');
    err.safeMessage = 'Could not read the plan list from the database. Nothing was changed — try again in a moment.';
    throw err;
  }
  const data = res.data;
  // Only replace the fallback allowlist when the table actually returned rows — an empty
  // result would otherwise clear() to an empty set and fail EVERY grant ("not in allowlist").
  if (Array.isArray(data) && data.length) {
    allow.clear();
    for (const p of data) {
      map.set(p.key, p.access_days ?? null);
      allow.add(p.key);
      planRows[p.key] = p;
    }
  }
  return { map, allow, planRows, segmentAvailable };
}

// batches registry for import batch_code resolution (#32). Pre-#32 (no table)
// → {} — resolveBatchForImport then blocks every premium row, which is the
// correct fail-closed behavior.
async function loadBatches(admin) {
  const byCode = {};
  const byId = {};
  const { data, error } = await admin.from('batches').select('id, code, status');
  // Missing table = genuinely pre-#32 → empty registry, every premium row blocks.
  if (error && !['42P01', 'PGRST205'].includes(String(error.code))) {
    // A transient failure must NOT masquerade as "pre-#32": every premium row would be
    // blocked with "batch no longer exists", diagnosing a live batch as deleted.
    const err = new Error('Could not read the batches registry — aborting rather than mis-blocking premium rows.');
    err.code = String(error.code || 'batches_unavailable');
    err.safeMessage = 'Could not read the batch list from the database. Nothing was changed — try again in a moment.';
    throw err;
  }
  for (const b of data || []) { byCode[b.code] = b; byId[b.id] = b; }
  return { byCode, byId };
}

// ── dry-run ──────────────────────────────────────────────────────────────────────
async function doDryRun(admin, { jobId, actorId }) {
  const { data: job, error: jerr } = await admin.from('student_import_jobs').select('*').eq('id', jobId).single();
  if (jerr || !job) return { status: 404, body: { error: 'Import job not found.' } };

  const { data: rows, error: rerr } = await admin.from('student_import_rows')
    .select('*').eq('job_id', jobId).order('source_row_number', { ascending: true });
  if (rerr) return { status: 500, body: { error: 'Could not load staged rows.' } };

  const { map: planAccessDays, planRows } = await loadPlanAccessDays(admin);
  const { byCode: batchesByCode } = await loadBatches(admin);

  // Bulk matches: external ids → existing links; emails → existing profiles.
  const extIds = rows.map((r) => r.external_user_id).filter(Boolean);
  const emails = rows.map((r) => r.email_normalized).filter(Boolean);
  const links = await chunkedIn(admin, 'student_external_accounts', 'external_user_id',
    extIds, 'external_user_id, user_id').catch(() => []);
  const profs = await chunkedIn(admin, 'profiles', 'email', emails, 'id, email').catch(() => []);

  const bySourceMap = new Map();
  for (const l of links) if (l.external_user_id) bySourceMap.set(l.external_user_id, l.user_id);
  const byEmailMap = new Map();
  for (const p of profs) {
    const key = normalizeEmail(p.email);
    if (!key) continue;
    const arr = byEmailMap.get(key) || [];
    if (!arr.includes(p.id)) arr.push(p.id);
    byEmailMap.set(key, arr);
  }

  const settings = job.settings || {};
  const now = Date.now();
  const counts = { total: rows.length, ready: 0, warnings: 0, blocked: 0, new: 0, existing: 0, conflicts: 0, done: 0 };

  // Compute proposals (pure/sync) + tally first, then persist in bounded-concurrency
  // chunks — 358 sequential awaited UPDATEs would risk a serverless timeout.
  const updates = [];
  for (const row of rows) {
    // Never re-open a row that already processed — a re-run of dry-run is safe.
    if (row.processing_status === 'done' || row.processing_status === 'processing') {
      counts.done++;
      continue;
    }
    const p = proposeForRow(row, {
      bySourceMap, byEmailMap,
      comboPlanMap: settings.combo_plan_map || {},
      planAccessDays, planRows, batchesByCode,
      defaultTermMode: settings.default_term_mode || 'preserve',
      now,
    });
    updates.push({ id: row.id, p });

    if (p.processing_status === 'blocked') counts.blocked++;
    else if (p.processing_status === 'ready') counts.ready++;
    if (p.warnings.length) counts.warnings++;
    if (p.match_result === 'new') counts.new++;
    if (p.match_result === 'existing_by_source' || p.match_result === 'existing_by_email') counts.existing++;
    if (p.match_result === 'conflict' || p.match_result === 'ambiguous') counts.conflicts++;
  }

  const stamp = new Date().toISOString();
  // proposed_batch_id is a #32 column — on a pre-#32 DB the first 42703/PGRST204
  // flips the flag and the batch retries without it (rows then stay batch-less,
  // which processRow treats as "no batch to grant").
  let includeBatchCol = true;
  const rowPatch = (p) => ({
    match_result: p.match_result, target_user_id: p.target_user_id, intended_action: p.intended_action,
    proposed_plan_key: p.proposed_plan_key, proposed_term_mode: p.proposed_term_mode,
    proposed_started_at: p.proposed_started_at, proposed_ends_at: p.proposed_ends_at,
    ...(includeBatchCol ? { proposed_batch_id: p.proposed_batch_id ?? null } : {}),
    processing_status: p.processing_status, warnings: p.warnings, errors: p.errors, updated_at: stamp,
  });
  // Rows whose proposal never reached the database. `counts` is computed in memory, so
  // without this the admin would confirm against numbers that don't describe the DB.
  let persistFailures = 0;
  for (let i = 0; i < updates.length; i += 20) {
    const batch = updates.slice(i, i + 20);
    let results = await Promise.all(batch.map(({ id, p }) =>
      admin.from('student_import_rows').update(rowPatch(p)).eq('id', id)));
    if (includeBatchCol && results.some((r) => r.error && ['42703', 'PGRST204'].includes(String(r.error.code)))) {
      includeBatchCol = false;
      results = await Promise.all(batch.map(({ id, p }) =>
        admin.from('student_import_rows').update(rowPatch(p)).eq('id', id)));
    }
    for (const r of results) {
      if (!r.error) continue;
      persistFailures++;
      console.warn('[student-imports] dry-run row persist failed', String(r.error.code || 'error'));
    }
  }

  await admin.from('student_import_jobs').update({
    status: 'dry_run', counts, updated_at: new Date().toISOString(),
  }).eq('id', jobId);
  await logEvent(admin, {
    jobId, actorId, kind: 'dry_run',
    status: persistFailures ? 'partial' : 'ok',
    detail: { counts, ...(persistFailures ? { persist_failures: persistFailures } : {}) },
  });
  return { status: 200, body: { ok: true, counts, persistFailures } };
}

// ── process one row (idempotent, partial-failure recoverable) ────────────────────
async function processRow(admin, row, ctx) {
  const { jobId, actorId, planAllow, planAccessDays, planRows, batchesById, appUrl, conflictPolicy, now } = ctx;
  const patch = { attempts: (row.attempts || 0) + 1, updated_at: new Date().toISOString() };

  // Blocked / non-processing intents never enter processing.
  if (row.processing_status === 'blocked' ||
      ['skip', 'manual_review', 'profile_only'].includes(row.intended_action)) {
    patch.processing_status = row.intended_action === 'profile_only' ? 'done' : 'skipped';
    await admin.from('student_import_rows').update(patch).eq('id', row.id);
    return patch.processing_status;
  }

  // Re-validate the batch at PROCESS time (#32): the dry run may be stale —
  // a since-closed/deleted batch, or a premium row whose proposal predates the
  // batch rules, is (re-)blocked here instead of granted.
  {
    const gap = batchGapForProcess({
      segment: planSegment(row.proposed_plan_key, planRows || {}),
      proposedBatchId: row.proposed_batch_id || null,
      batch: row.proposed_batch_id ? (batchesById || {})[row.proposed_batch_id] || null : null,
    });
    if (gap) {
      patch.processing_status = 'blocked';
      patch.errors = [...(row.errors || []), gap];
      await admin.from('student_import_rows').update(patch).eq('id', row.id);
      await logEvent(admin, { jobId, rowId: row.id, actorId, kind: 'row', status: 'blocked', detail: { reason: 'batch_invalid' } });
      return 'blocked';
    }
  }

  const planKey = row.proposed_plan_key;
  if (!planKey || !planAllow.has(planKey)) {
    patch.processing_status = 'failed';
    patch.errors = [...(row.errors || []), 'Plan is not in the allowlist.'];
    await admin.from('student_import_rows').update(patch).eq('id', row.id);
    await logEvent(admin, { jobId, rowId: row.id, actorId, kind: 'row', status: 'failed', detail: { reason: 'plan_not_allowed' } });
    return 'failed';
  }

  try {
    let userId = row.target_user_id || null;
    let inviteLink = null;
    const email = row.email_normalized;

    // 1) Resolve / create the account (idempotent).
    if (!userId) {
      // Re-check for an existing account at process time (covers a create raced by a merge,
      // and a retry after a prior partial run).
      if (row.external_user_id) {
        const { data: link } = await admin.from('student_external_accounts')
          .select('user_id').eq('source', SOURCE).eq('external_user_id', row.external_user_id).maybeSingle();
        if (link?.user_id) userId = link.user_id;
      }
      if (!userId && email) {
        const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
        if (prof?.id) userId = prof.id;
      }
      if (!userId) {
        if (!email || !isValidEmail(email)) {
          patch.processing_status = 'failed';
          patch.errors = [...(row.errors || []), 'A valid email is required to create an account.'];
          await admin.from('student_import_rows').update(patch).eq('id', row.id);
          return 'failed';
        }
        const { data: gen, error: gerr } = await admin.auth.admin.generateLink({
          type: 'invite', email,
          options: { data: { account_origin: 'import' }, redirectTo: `${appUrl}/welcome/set-password` },
        });
        if (gerr) {
          const msg = String(gerr.message || gerr);
          if (/already|registered|exists/i.test(msg)) {
            // Race / pre-existing account — fall back to a merge lookup.
            const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
            if (prof?.id) userId = prof.id;
            else throw new Error('email_registered_but_profile_missing');
          } else {
            throw gerr;
          }
        } else {
          userId = gen?.user?.id;
          inviteLink = gen?.properties?.action_link || null;
          patch.auth_user_created = true;
        }
      }
    }
    if (!userId) throw new Error('could_not_resolve_user');

    // Persist that the account exists BEFORE granting, so a mid-row failure is recoverable.
    if (patch.auth_user_created) {
      await admin.from('student_import_rows').update({ auth_user_created: true, updated_at: new Date().toISOString() }).eq('id', row.id);
    }

    // 2) Durable source link (idempotent via unique(source, external_user_id)).
    if (row.external_user_id) {
      await admin.from('student_external_accounts').upsert({
        user_id: userId, source: SOURCE, external_user_id: row.external_user_id,
        source_created_at: row.mapped?.source_created_at || null,
        last_sign_in_at: row.mapped?.last_sign_in_at || null,
        sign_in_count: row.mapped?.sign_in_count ?? null,
        legacy_enrollments: row.mapped?.legacy_enrollments || [],
        import_job_id: jobId, import_row_id: row.id,
      }, { onConflict: 'source,external_user_id' });
    }

    // 3) Subscription grant (idempotent via subscriptions.source_import_row_id unique).
    const { data: existingGrant } = await admin.from('subscriptions')
      .select('id, status').eq('source_import_row_id', row.id).maybeSingle();

    let granted = row.subscription_granted;
    let skippedGrant = false;
    if (existingGrant) {
      granted = true;
    } else {
      const { data: active } = await admin.from('subscriptions')
        .select('plan_key, ends_at, grace_ends_at').eq('user_id', userId).eq('status', 'active')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      const existingActiveSub = active ? {
        plan_key: active.plan_key,
        ends_at: active.ends_at ? Date.parse(active.ends_at) : null,
        grace_ends_at: active.grace_ends_at ? Date.parse(active.grace_ends_at) : null,
      } : null;

      const term = computeImportTerm({
        planKey,
        accessDays: planAccessDays.has(planKey) ? planAccessDays.get(planKey) : null,
        startedAt: row.proposed_started_at ? Date.parse(row.proposed_started_at) : null,
        endsAt: row.proposed_ends_at ? Date.parse(row.proposed_ends_at) : null,
        mode: row.proposed_term_mode || 'preserve',
        existingActiveSub, conflictPolicy, now,
      });

      if (term.action === 'grant') {
        if (existingActiveSub && term.status === 'active') {
          await admin.from('subscriptions').update({ status: 'expired', updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('status', 'active');
        }
        const { error: sErr } = await admin.from('subscriptions').insert({
          user_id: userId, plan_key: planKey, status: term.status,
          started_at: term.started_at ? new Date(term.started_at).toISOString() : new Date().toISOString(),
          ends_at: term.ends_at ? new Date(term.ends_at).toISOString() : null,
          grace_ends_at: term.grace_ends_at ? new Date(term.grace_ends_at).toISOString() : null,
          grant_source: 'import', source_import_row_id: row.id, approved_by: actorId,
          // #32: the confirmed batch for gold/vip rows; omitted (not null) when
          // absent so a pre-#32 subscriptions table still accepts the insert.
          ...(row.proposed_batch_id ? { batch_id: row.proposed_batch_id } : {}),
        });
        if (sErr) {
          // Unique(source_import_row_id) → a concurrent grant already landed; treat as success.
          if (String(sErr.code) === '23505') granted = true;
          else throw sErr;
        } else {
          granted = true;
          // is_paid is a "has paid at least once" cache — true for an active OR expired-history
          // import (both represent someone who paid). An expired term + is_paid=true routes the
          // student to the Membership Expired / renewal screen rather than a cold paywall.
          await admin.from('profiles').update({ is_paid: true, plan: planKey }).eq('id', userId);
        }
      } else if (term.action === 'skip_preserve_longer') {
        skippedGrant = true; // keep the existing longer/active term untouched
      } else {
        // block_conflict / block_missing_expiry surfaced at process time → mark blocked.
        patch.processing_status = 'blocked';
        patch.target_user_id = userId;
        patch.errors = [...(row.errors || []), term.reason || 'Membership conflict — resolve manually.'];
        await admin.from('student_import_rows').update(patch).eq('id', row.id);
        await logEvent(admin, { jobId, rowId: row.id, actorId, kind: 'row', status: 'blocked', detail: { action: term.action } });
        return 'blocked';
      }
    }

    // 4) Onboarding + invite (import-created stub only). A confirmed native user is NOT re-invited.
    // Derive from PERSISTED row state (row.auth_user_created), not just this pass's
    // patch flag: if a prior run created the account (line above persisted the flag) but
    // then failed at step 2/3, the retry resolves userId via link/email — so generateLink
    // never runs this pass, patch.auth_user_created stays unset, and the stamp + invite
    // would be skipped forever, stranding the user with an account but no password and a
    // set-password gate that never fires (it keys on account_origin==='import'). Keying on
    // the durable flag makes the stamp + invite retry-safe.
    let inviteStatus = row.invite_status;
    const { isImportStub, shouldInvite } = decideOnboardingStep({
      createdThisPass: patch.auth_user_created === true,
      authUserCreated: row.auth_user_created === true,
      inviteStatus,
    });
    if (isImportStub) {
      // Idempotent: only advances a still-fresh 'none' row (account_origin + onboarding set
      // together, so a row already at 'invited' is fully stamped and safely skipped).
      await admin.from('profiles').update({
        account_origin: 'import', onboarding_status: 'invited', invited_at: new Date().toISOString(),
      }).eq('id', userId).eq('onboarding_status', 'none');
      if (shouldInvite) {
        // On a retry the account already existed, so generateLink didn't run this pass and we
        // hold no link — mint a fresh single-use recovery link for the existing user so the
        // invite email still goes out. Discarded after send (never persisted or logged).
        if (!inviteLink && email && isValidEmail(email)) {
          const { data: reGen } = await admin.auth.admin.generateLink({
            type: 'recovery', email,
            options: { redirectTo: `${appUrl}/welcome/set-password` },
          }).catch(() => ({ data: null }));
          inviteLink = reGen?.properties?.action_link || null;
        }
        if (inviteLink) {
          const sent = await sendInviteEmail(email, inviteLink);
          inviteStatus = sent.ok ? 'sent' : 'failed';
        }
      }
      inviteLink = null; // discard — never persisted or logged
    }

    patch.processing_status = 'done';
    patch.target_user_id = userId;
    patch.subscription_granted = granted;
    patch.invite_status = inviteStatus;
    await admin.from('student_import_rows').update(patch).eq('id', row.id);
    await logEvent(admin, {
      jobId, rowId: row.id, actorId, kind: 'row', status: 'done',
      detail: { match: row.match_result, granted, skippedGrant, invite: inviteStatus },
    });
    return 'done';
  } catch (err) {
    patch.processing_status = 'failed';
    patch.errors = [...(row.errors || []), 'Processing failed — safe to retry.'];
    await admin.from('student_import_rows').update(patch).eq('id', row.id);
    // Audit stores only a safe code — a raw Postgres error message can embed the row's
    // email/values (e.g. a unique-violation), which must never land in the audit trail.
    await logEvent(admin, { jobId, rowId: row.id, actorId, kind: 'row', status: 'failed', detail: { code: err?.code || err?.name || 'error' } });
    return 'failed';
  }
}

// ── process a bounded batch ──────────────────────────────────────────────────────
async function doProcess(admin, { jobId, actorId, batchSize, retryFailed }) {
  const size = Math.min(Math.max(1, Number(batchSize) || 10), MAX_BATCH);
  const { data: job, error: jerr } = await admin.from('student_import_jobs').select('*').eq('id', jobId).single();
  if (jerr || !job) return { status: 404, body: { error: 'Import job not found.' } };

  const { allow: planAllow, map: planAccessDays, planRows } = await loadPlanAccessDays(admin);

  // Forward pass processes only ready/pending so progress is monotonic and the client's
  // auto-continue can never loop on a re-failing row. 'failed' rows are re-tried ONLY on an
  // explicit retryFailed request (the "Retry failed" button), never blocked/done/skipped.
  const statuses = retryFailed ? ['ready', 'pending', 'failed'] : ['ready', 'pending'];
  const { data: rows, error: rerr } = await admin.from('student_import_rows')
    .select('*').eq('job_id', jobId).in('processing_status', statuses)
    .order('source_row_number', { ascending: true }).limit(size);
  if (rerr) return { status: 500, body: { error: 'Could not load rows to process.' } };

  // Load the batch registry BEFORE flipping the job to 'processing'. loadBatches
  // throws on a transient failure, and the 503 it produces says "nothing was
  // changed" — which would be a lie if we had already moved the job's status.
  const batchesById = (await loadBatches(admin)).byId;

  await admin.from('student_import_jobs').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', jobId);

  const ctx = {
    jobId, actorId, planAllow, planAccessDays, planRows,
    batchesById,
    appUrl: (process.env.APP_URL || '').replace(/\/+$/, '') || SUPABASE_URL,
    conflictPolicy: (job.settings && job.settings.conflict_policy) || 'keep_longer',
    now: Date.now(),
  };

  let processed = 0;
  // Sequential for correctness (avoids racing the one-active index for the same user).
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await processRow(admin, row, ctx);
    processed++;
    const cursor = Math.max(job.cursor || 0, row.source_row_number);
    // eslint-disable-next-line no-await-in-loop
    await admin.from('student_import_jobs').update({ cursor, updated_at: new Date().toISOString() }).eq('id', jobId);
  }

  // Recompute live counts + terminal status.
  const { data: agg } = await admin.from('student_import_rows').select('processing_status').eq('job_id', jobId);
  const tally = { total: agg?.length || 0, done: 0, failed: 0, blocked: 0, skipped: 0, remaining: 0 };
  for (const r of (agg || [])) {
    if (r.processing_status === 'done') tally.done++;
    else if (r.processing_status === 'failed') tally.failed++;
    else if (r.processing_status === 'blocked') tally.blocked++;
    else if (r.processing_status === 'skipped') tally.skipped++;
    else tally.remaining++;
  }
  // remaining = ready/pending/processing (see tally). Forward progress is monotonic, so
  // done ⇔ nothing left to process; 'more' tells the client to auto-continue the batch loop.
  const done = tally.remaining === 0;
  await admin.from('student_import_jobs').update({
    status: done ? 'completed' : 'processing', counts: { ...(job.counts || {}), ...tally }, updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  return { status: 200, body: { ok: true, processed, done, tally, more: !done } };
}

// ── resend invite ────────────────────────────────────────────────────────────────
async function doResendInvite(admin, { rowId, actorId }) {
  const { data: row, error } = await admin.from('student_import_rows').select('*').eq('id', rowId).single();
  if (error || !row) return { status: 404, body: { error: 'Row not found.' } };
  const email = row.email_normalized;
  if (!email || !isValidEmail(email)) return { status: 400, body: { error: 'Row has no valid email.' } };

  // Only re-invite an import-origin, not-yet-onboarded account.
  let userId = row.target_user_id;
  if (!userId) {
    const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
    userId = prof?.id || null;
  }
  if (!userId) return { status: 409, body: { error: 'No account to re-invite — run process first.' } };
  const { data: prof } = await admin.from('profiles').select('account_origin, onboarding_status').eq('id', userId).maybeSingle();
  // Only re-invite accounts THIS import created — never email an import-branded set-password
  // link to a merged native member who happens to be linked to an import row.
  if (prof?.account_origin !== 'import') {
    return { status: 409, body: { error: 'This account was not created by an import — nothing to re-invite.' } };
  }
  if (prof?.onboarding_status === 'completed') {
    return { status: 409, body: { error: 'This member already completed onboarding.' } };
  }

  const { data: gen, error: gerr } = await admin.auth.admin.generateLink({
    type: 'recovery', email,
    options: { redirectTo: `${(process.env.APP_URL || '').replace(/\/+$/, '') || SUPABASE_URL}/welcome/set-password` },
  });
  if (gerr) return { status: 502, body: { error: 'Could not generate an invite link.' } };
  const link = gen?.properties?.action_link;
  const sent = link ? await sendInviteEmail(email, link) : { ok: false, code: 'no_link' };
  await admin.from('student_import_rows').update({ invite_status: sent.ok ? 'resent' : 'failed', updated_at: new Date().toISOString() }).eq('id', rowId);
  await logEvent(admin, { jobId: row.job_id, rowId, actorId, kind: 'resend_invite', status: sent.ok ? 'sent' : 'failed', detail: {} });
  return { status: sent.ok ? 200 : 502, body: sent.ok ? { ok: true } : { ok: false, error: 'Invite email could not be sent.' } };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: Boolean(SUPABASE_URL && SERVICE_KEY),
      hasSecretKey: Boolean(SERVICE_KEY),
      hasResend: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server import is not configured (SUPABASE_SECRET_KEY missing).' });
  }

  // Auth: valid JWT + independently-confirmed admin, BEFORE the service client exists.
  const u = await callerUser(req.headers?.authorization);
  if (!u) return res.status(401).json({ error: 'Sign in as an admin.' });
  if (!(await callerIsAdmin(u))) return res.status(403).json({ error: 'Admin authorization required.' });
  if (rateLimited(u.id)) return res.status(429).json({ error: 'Too many requests — wait a minute.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body?.action;
  const admin = service();

  try {
    if (action === 'dry-run') {
      if (!body?.jobId) return res.status(400).json({ error: 'jobId required.' });
      const r = await doDryRun(admin, { jobId: body.jobId, actorId: u.id });
      return res.status(r.status).json(r.body);
    }
    if (action === 'process') {
      if (!body?.jobId) return res.status(400).json({ error: 'jobId required.' });
      const r = await doProcess(admin, { jobId: body.jobId, actorId: u.id, batchSize: body.batchSize, retryFailed: !!body.retryFailed });
      return res.status(r.status).json(r.body);
    }
    if (action === 'resend-invite') {
      if (!body?.rowId) return res.status(400).json({ error: 'rowId required.' });
      const r = await doResendInvite(admin, { rowId: body.rowId, actorId: u.id });
      return res.status(r.status).json(r.body);
    }
    return res.status(400).json({ error: "action must be 'dry-run', 'process' or 'resend-invite'." });
  } catch (err) {
    // Log only a safe code/name — a raw DB error message can carry row PII.
    console.error(`[student-imports] ${action} failed: ${String(err?.code || err?.name || 'error')}`);
    // Deliberate aborts (plans/batches registry unreadable) carry a STATIC message we
    // authored, so it is safe to surface and tells the admin to retry rather than
    // assume the source data is bad. Everything else stays generic.
    if (err?.safeMessage) return res.status(503).json({ error: err.safeMessage });
    return res.status(500).json({ error: 'Import operation failed.' });
  }
}

// Exported for focused testing of the pure row reducer without a database.
export { proposeForRow };
