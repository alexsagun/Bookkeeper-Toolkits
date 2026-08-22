// ─────────────────────────────────────────────────────────────────────────────
// planCatalog.js — PURE, dependency-free membership catalog + entitlement rules.
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the browser (src/BookkeeperPro.jsx: paywall, account center, extend
// modal, sidebar/tab gating, trainer preview), the knowledge generator
// (scripts/generate-voice-agent-knowledge.mjs), and the node:test suite
// (test/planCatalog.test.mjs). NO imports, NO side effects, NO DOM/Node/Supabase.
//
// THREE PLANS, and only three (#39). `core_self_paced` (QBO Mastery Only) and
// `gold_live` (Live Group Track) were permanently removed together with the whole
// Gold community segment — do not reintroduce either key here or in SQL.
//
// The live admin-editable `enrollment_plans` table is the runtime authority for
// prices/copy; this array is the fallback that paints the paywall when the table
// is missing or empty. Keep it in lockstep with the seed in
// db/000_full_database_bootstrap.sql (§9) — test/planCatalog.test.mjs pins it.
// Prices are FIXED ₱ (PHP) bank-transfer amounts — never USD-converted.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE peso formatter. One rule, everywhere a price is shown.
 *
 * There were three: `phpFmt` on the pricing cards, `fmtPhp` inside the Training
 * Agreement, and `php` in the admin alert email — and the first two DISAGREED.
 * `2999.5` rendered as "₱2,999.5" on the card and "₱3,000" on the document the
 * student legally signs, and a null price rendered as "₱0" against "—". Quoting
 * one number and having someone sign another is the exact failure
 * trainingAgreement.js exists to prevent (its predecessor printed ₱15,999 on a
 * ₱16,999 sale), so the formatter cannot be the thing that reintroduces it.
 *
 * Deterministic on purpose — no `toLocaleString`, so a PDF, an email and a
 * node:test assertion agree byte for byte on every platform and ICU build. The
 * output matches `toLocaleString('en-US')` for the values this catalog holds.
 *
 * `fallback` is what a missing/unparseable amount renders as: a document says
 * "—" because printing "₱0" would assert a price nobody agreed to; UI surfaces
 * default to "₱0".
 */
export function phpAmount(n, fallback = '₱0') {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v)) return fallback;
  const abs = Math.abs(v);
  const whole = Math.trunc(abs);
  const cents = Math.round((abs - whole) * 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dec = cents ? `.${String(cents).padStart(2, '0').replace(/0$/, '')}` : '';
  return `${v < 0 ? '-₱' : '₱'}${grouped}${dec}`;
}

export const ENROLLMENT_PLANS_FALLBACK = [
  { key: 'sampler', name: 'Sampler Session', tagline: 'Essentials', price_php: 1499, compare_at_php: null, badge: null, limit_note: 'Limited offer', position: 1, access_days: 60, support_days: 60,
    features: ['1 Live Zoom Session (3 hours)', '60-day course access', '60-day group chat support'] },
  { key: 'silver_self_paced', name: 'QBO + Resume Combo', tagline: 'Silver · Self-Paced', price_php: 2999, compare_at_php: null, badge: null, limit_note: null, position: 2, access_days: 60, support_days: null,
    features: ['Simulated annual bookkeeping project for an NY-based construction company', '60-day QBO Mastery course access', '60-day Resume & Interview course access', 'Weekly Community chat (Thu)'] },
  { key: 'vip', name: 'Personalized Coaching Program', tagline: 'VIP Package', price_php: 16999, compare_at_php: 35000, badge: 'BEST SELLER', limit_note: 'Limited to 10 slots per month', position: 3, access_days: 180, support_days: null, community_segment: 'vip',
    features: ['Simulated annual bookkeeping project for an NY-based construction company', '12 Live Group Zoom Trainings (MWF 9am to 11am PH Time)', '4 Live Group Resume & Interview Coaching Sessions', '1-on-1 Resume & Interview Coaching (1 session)', 'Weekly group consult until hired', 'Community chat support until and after hired'] },
];

export const PLAN_LABELS = ENROLLMENT_PLANS_FALLBACK.reduce((m, p) => { m[p.key] = p.name; return m; }, {});

// Extend-access pricing — pro-rate the plan's OWN price over its OWN duration so a member
// buys time at the same daily rate. days = months × 30 (never below the 2-month / 60-day
// minimum). For a 60-day plan, 2 months == the full plan price (₱1,499 / ₱2,999).
export function extensionPrice(plan, months) {
  const price = Number(plan?.price_php) || 0;
  const planDays = Number(plan?.access_days) || 60;
  const days = Math.max(60, Math.round((Number(months) || 0) * 30));
  const amount = Math.round((price / planDays) * days);
  return { days, amount };
}

// ── Plan entitlements ────────────────────────────────────────────────────────
// Which stages/tabs (and, for `sampler`, which COURSES within a catalog) each plan
// unlocks. EVERY sellable plan has an explicit entry — that is the invariant, not a
// convenience: an unlisted key now falls into the fail-closed branch below, so a plan
// added to the catalog without an entry here would be locked out of its own toolkit.
// test/planCatalog.test.mjs pins catalog ↔ entitlement parity.
//
//   • `sampler` (Sampler Session, ₱1,499 / 60 days) — Home + the QuickBooks catalog
//     (`qbomastery`, but only its `access_tier='essentials'` course, i.e. QuickBooks
//     Online Essentials — NOT Mastery) + the two 1-on-1 booking tabs (`linkedinopt`,
//     `coachalex`). The ₱1,499 buys the coaching session, not more course content, so
//     the cheapest plan is also the most scoped — never assume price ⇒ scope.
//   • `silver_self_paced` (QBO + Resume Combo, ₱2,999 / 60 days) and `vip`
//     (Personalized Coaching Program, ₱16,999 / 180 days) — FULL non-admin toolkit.
//
// This is the CLIENT half of the plan-access model. The SERVER half lives in
// db/2026-07-11-sampler-essentials-access.sql (sampler → qbo-* AND
// access_tier='essentials'), re-stated in db/2026-08-17-three-plan-catalog.sql when the
// Core-only rule was dropped. Keep the client tab-allowlist + `courseTier` and the SQL
// slug/tier predicates in sync when entitlements change.
export const PLAN_ENTITLEMENTS = {
  // Essentials + 1-on-1 coaching: Home, the QuickBooks catalog (Essentials course only),
  // and both Alex booking pages. `courseTier` scopes courses WITHIN an allowed catalog
  // (matches courses.access_tier + the SQL sampler rule). `community`: every paid plan
  // includes the member feed (server gate = is_enrolled() RLS).
  sampler: {
    scopeLabel: 'Essentials + 1-on-1 coaching',
    stageIds: ['home', 'training', 'jobsearch'],
    tabIds: ['dashboard', 'qbomastery', 'linkedinopt', 'coachalex', 'community'],
    courseTier: 'essentials',
  },
  // Premium self-paced: full non-admin toolkit.
  silver_self_paced: { full: true, scopeLabel: 'Full toolkit access' },
  // Coaching program: full non-admin toolkit + the private VIP cohort community.
  vip: { full: true, scopeLabel: 'Full toolkit access' },
};

// A plan key the catalog no longer knows — a deleted plan (Core/Gold), a typo, or stale
// client state. It must NEVER resolve to full access: that default is what let a retired
// plan silently keep the whole toolkit. Home stays open so the member lands on the
// Dashboard membership panel and RestrictedTab's "Upgrade or renew" instead of a dead end.
const UNKNOWN_PLAN_ENTITLEMENT = {
  scopeLabel: 'no toolkit access',
  unknownLabel: 'Plan no longer available',
  stageIds: ['home'],
  tabIds: ['dashboard'],
  // No catalog tab is reachable, so allowsCourse() should be unreachable too — but
  // "unreachable" is an argument, not a guarantee. Say no explicitly instead.
  noCourses: true,
};

// `profiles.plan` is a free-text CACHE, `NOT NULL DEFAULT 'free'` — it is never null, so
// "this user has no paid plan on file" arrives as one of these strings, not as null. The
// authoritative key is `subscriptions.plan_key`, which has an FK to enrollment_plans.
//
// ★ These MUST resolve to full access, not to the fail-closed branch. `is_enrolled()` has a
// grandfather branch (is_paid AND no subscription rows at all) that deliberately keeps
// admin-comped and legacy members in — they reach the shell with `plan = 'free'`. Treating
// that as "unknown plan" would lock out exactly the people that branch exists to protect,
// and would do it silently. The same applies on useEnrollmentGate's documented fail-OPEN
// timeout branch: the gate letting someone in while entitlement shuts them out is the worst
// of both designs.
const NO_PLAN_SENTINELS = new Set(['free', 'none', 'null', 'undefined']);

// planEntitlement(key) → { full, planKey, label, scopeLabel, allowsStage(id), allowsTab(id), allowsCourse(course) }.
//   • no key / a sentinel   → FULL. Admins, the enrollment flag being off, and legacy
//                             grandfathered terms with no plan on file all arrive here.
//   • known key             → that plan's scope (full or limited).
//   • unknown non-null key  → FAIL CLOSED (Home only). See UNKNOWN_PLAN_ENTITLEMENT.
export function planEntitlement(planKey) {
  if (!planKey || NO_PLAN_SENTINELS.has(String(planKey).trim().toLowerCase())) {
    return {
      full: true, planKey: null, label: null, scopeLabel: 'Full toolkit access',
      allowsStage: () => true, allowsTab: () => true, allowsCourse: () => true,
    };
  }
  const cfg = PLAN_ENTITLEMENTS[planKey] || UNKNOWN_PLAN_ENTITLEMENT;
  const label = PLAN_LABELS[planKey] || cfg.unknownLabel || planKey;
  if (cfg.full) {
    return {
      full: true, planKey, label, scopeLabel: cfg.scopeLabel,
      allowsStage: () => true, allowsTab: () => true, allowsCourse: () => true,
    };
  }
  const stageSet = new Set(cfg.stageIds);
  const tabSet = new Set(cfg.tabIds);
  return {
    full: false, planKey, label, scopeLabel: cfg.scopeLabel,
    allowsStage: (id) => stageSet.has(id),
    // Home is unconditionally allowed — RestrictedTab's "Back to Dashboard" fallback (and
    // the stale-lastTab reset) must never dead-end, even if a future plan omits it.
    allowsTab: (id) => id === 'dashboard' || tabSet.has(id),
    // Course-level scope within an allowed catalog. No `courseTier` → all courses the tab
    // allows. `sampler` → only `access_tier='essentials'` courses. RLS is the real boundary;
    // this drives the catalog card list + a deep-link guard.
    allowsCourse: (course) =>
      !cfg.noCourses && (!cfg.courseTier || (course?.access_tier || 'standard') === cfg.courseTier),
  };
}

export const FULL_ENTITLEMENT = planEntitlement(null);

// Drop stages/tabs a plan can't access. Keeps stable stage/tab ids + group keys, so
// per-user collapse state and admin `effLabel` overrides are unaffected. Empty groups
// and empty stages are removed so the sidebar never renders a bare header.
export function filterStagesForEntitlement(stages, ent) {
  if (!ent || ent.full) return stages;
  return stages
    .map((s) => {
      const tabs = s.tabs.filter((t) => ent.allowsTab(t.id));
      if (tabs.length === 0) return null;
      const groups = s.groups
        ? s.groups
            .map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => ent.allowsTab(id)) }))
            .filter((g) => g.tabIds.length > 0)
        : undefined;
      return { ...s, tabs, ...(groups ? { groups } : {}) };
    })
    .filter(Boolean);
}
