// ─────────────────────────────────────────────────────────────────────────────
// communitySpaces.js — PURE, dependency-free batch/segment logic (#32).
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the browser (src/BookkeeperPro.jsx: paywall batch selector, approve
// modal, community space switcher, batch manager), the import endpoint
// (api/admin/student-imports.js), and the node:test suite
// (test/communitySpaces.test.mjs). NO imports, NO side effects, NO
// DOM/Node/Supabase — a pure mirror of the SQL truth in
// db/2026-07-28-community-spaces-batches.sql so client, server, and tests agree.
//
// NON-NEGOTIABLE DATA RULE (encoded here): a batch is NEVER inferred from an
// approval date, signup date, course title, or payment amount. It comes only
// from an explicit choice (checkout selector, approve dialog, import
// batch_code column, batch-manager assignment). resolveBatchForImport() BLOCKS
// premium rows with no confirmed open batch — it never guesses.
// ─────────────────────────────────────────────────────────────────────────────

// Mirror of the enrollment_plans.community_segment seed (#32). Used only when
// a plans row is unavailable (fallback plan list / missing column) — the live
// column is the authority everywhere a row exists.
export const PLAN_SEGMENT_FALLBACK = {
  gold_live: 'gold',
  vip: 'vip',
};

export const COMMUNITY_SEGMENTS = ['general', 'gold', 'vip'];

// planSegment(planKey, plansByKey?) → 'general' | 'gold' | 'vip'.
// plansByKey values may carry community_segment (live rows post-#32);
// unknown/legacy/null plans are ALWAYS 'general' (fail closed — General only).
export function planSegment(planKey, plansByKey) {
  if (!planKey) return 'general';
  const row = plansByKey && plansByKey[planKey];
  const seg = row && row.community_segment;
  if (COMMUNITY_SEGMENTS.includes(seg)) return seg;
  return PLAN_SEGMENT_FALLBACK[planKey] || 'general';
}

export function isPremiumSegment(segment) {
  return segment === 'gold' || segment === 'vip';
}

// ── Batch codes ──────────────────────────────────────────────────────────────
// Business key shape: 'YYYY-MM' with a real month (mirrors the batches.code CHECK,
// tightened in #33 — '2026-13' used to pass on both sides and would have minted a
// gold-2026-13 space).
export const BATCH_CODE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeBatchCode(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

export function isValidBatchCode(raw) {
  return BATCH_CODE_RE.test(normalizeBatchCode(raw));
}

// Space naming — mirrors batches_create_spaces() in SQL.
export function spaceSlugFor(kind, batchCode) {
  if (kind === 'general') return 'general';
  return `${kind}-${normalizeBatchCode(batchCode)}`;
}

export function spaceNameFor(kind, batchName) {
  if (kind === 'general') return 'General';
  const label = kind === 'gold' ? 'Gold' : 'VIP';
  return `${label} — ${batchName}`;
}

// ── Import resolution ────────────────────────────────────────────────────────
// resolveBatchForImport({ segment, batchCodeRaw, batchesByCode })
//   → { batchId, blocked, reason, warning }
// batchesByCode: { [code]: { id, status } } loaded by the endpoint.
// Rules (the brief's, verbatim):
//   • premium + no code            → BLOCKED (manual review / batch manager)
//   • premium + unknown code       → BLOCKED (never guess)
//   • premium + non-open batch     → BLOCKED (closed batches reject new assignments)
//   • premium + open batch         → grant with that batch id
//   • general + any code           → code ignored with a warning (general plans
//                                    carry no batch)
export function resolveBatchForImport({ segment, batchCodeRaw, batchesByCode }) {
  const code = normalizeBatchCode(batchCodeRaw);
  if (!isPremiumSegment(segment)) {
    return {
      batchId: null, blocked: false, reason: null,
      warning: code ? `batch_code "${code}" ignored — ${segment || 'general'} plans have no batch.` : null,
    };
  }
  if (!code) {
    return {
      batchId: null, blocked: true, warning: null,
      reason: 'Needs batch assignment — gold/VIP rows require a confirmed open batch_code.',
    };
  }
  if (!BATCH_CODE_RE.test(code)) {
    return {
      batchId: null, blocked: true, warning: null,
      reason: `Invalid batch_code "${code}" — expected YYYY-MM (e.g. 2026-08).`,
    };
  }
  const batch = batchesByCode && batchesByCode[code];
  if (!batch) {
    return {
      batchId: null, blocked: true, warning: null,
      reason: `Unknown batch_code "${code}" — create the batch in Admin → Batches first.`,
    };
  }
  if (batch.status !== 'open') {
    return {
      batchId: null, blocked: true, warning: null,
      reason: `Batch "${code}" is ${batch.status} — closed batches reject new assignments.`,
    };
  }
  return { batchId: batch.id, blocked: false, reason: null, warning: null };
}

// ── Process-time batch re-validation (the LAST line of defense) ───────────────
// batchGapForProcess({ segment, proposedBatchId, batch }) -> null | reason string
//
// A dry-run proposal can go stale between preview and process (the batch was closed,
// archived, or deleted; or the row was proposed before the batch rules existed). This
// is the only check standing between a stale proposal and a real premium grant, so it
// lives here — beside resolveBatchForImport, under `node --test` — rather than inline
// in the endpoint where it would drift.
//
// `batch` is the row looked up by id (null when it no longer exists).
export function batchGapForProcess({ segment, proposedBatchId, batch }) {
  if (!isPremiumSegment(segment)) return null;
  if (!proposedBatchId) return 'Needs batch assignment — re-run the dry run with a batch_code.';
  if (!batch) return 'Proposed batch no longer exists — re-run the dry run.';
  if (batch.status !== 'open') {
    return `Batch "${batch.code}" is ${batch.status} — closed batches reject new assignments.`;
  }
  return null;
}

// ── Approval preselect ───────────────────────────────────────────────────────
// approvalBatchPreselect({ requestKind, segment, prevBatchId, requestBatchId,
//                          spaceExistsForPrevBatch })
//   → { batchId, required, locked }
// PURE MIRROR of admin_finalize_enrollment()'s batch-resolution precedence —
// drives the approve-modal UI (what to preselect, whether a picker is needed,
// whether the choice is locked). Keep in lockstep with the RPC.
//   • general segment  → no batch, no picker.
//   • extension        → the current batch, LOCKED (extensions never move).
//   • renewal          → current batch, else the checkout choice; changeable.
//   • upgrade          → current batch IF the target segment has a space there
//                        (gold↔vip same-batch switch), else checkout choice;
//                        changeable.
//   • new              → the checkout choice; changeable.
// required=true means approval cannot proceed without a batch id.
export function approvalBatchPreselect({
  requestKind, segment, prevBatchId = null, requestBatchId = null,
  spaceExistsForPrevBatch = true,
}) {
  if (!isPremiumSegment(segment)) {
    return { batchId: null, required: false, locked: false };
  }
  const kind = requestKind || 'new';
  if (kind === 'extension') {
    return { batchId: prevBatchId || requestBatchId || null, required: true, locked: !!prevBatchId };
  }
  if (kind === 'renewal') {
    return { batchId: prevBatchId || requestBatchId || null, required: true, locked: false };
  }
  if (kind === 'upgrade') {
    const inherited = prevBatchId && spaceExistsForPrevBatch ? prevBatchId : null;
    return { batchId: inherited || requestBatchId || null, required: true, locked: false };
  }
  return { batchId: requestBatchId || null, required: true, locked: false };
}

// ── Client space selection ───────────────────────────────────────────────────
// spaces: rows from the my_community_spaces() RPC ({ slug, kind, is_default }).
export function defaultSpaceOf(spaces) {
  if (!Array.isArray(spaces) || spaces.length === 0) return null;
  return spaces.find(s => s && s.is_default)
      || spaces.find(s => s && s.kind !== 'general')
      || spaces.find(s => s && s.kind === 'general')
      || spaces[0];
}

// pickInitialSpace({ urlSlug, storedSlug, spaces }) → a space row or null.
// Precedence: deep-linked ?space= slug (if accessible) → last selection from
// window.storage (if still accessible) → the RPC's default space.
export function pickInitialSpace({ urlSlug, storedSlug, spaces }) {
  if (!Array.isArray(spaces) || spaces.length === 0) return null;
  const bySlug = slug => (slug ? spaces.find(s => s && s.slug === slug) || null : null);
  return bySlug(urlSlug) || bySlug(storedSlug) || defaultSpaceOf(spaces);
}
