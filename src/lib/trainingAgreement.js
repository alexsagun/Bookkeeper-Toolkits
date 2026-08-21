// ─────────────────────────────────────────────────────────────────────────────
// trainingAgreement.js — PURE, dependency-free model of the Training Agreement
// & Student Commitment Form (#42).
// ─────────────────────────────────────────────────────────────────────────────
// Ported from the Google Apps Script enrollment app, where the same document
// existed TWICE — once as a standalone generator (Agreement.html) and once
// inlined into the form (Index.html) — and the two copies had already drifted
// apart. This module is the single copy. The form renders it, the PDF renders
// it, and the signed snapshot records which version of it was accepted.
//
// ★ THE DOCUMENT IS DATA, NOT MARKUP.
//   The source built the agreement by concatenating HTML strings. That is how
//   `section(4, …) +` in agreement.html:451 became a dangling expression whose
//   result was silently discarded, so Section 4 — the one describing the Silver
//   track — never rendered, and every Silver student signed a document missing
//   their own terms. A section here is an object in an array. A dropped one is
//   a failing test (see test/trainingAgreement.test.mjs), not a silent omission.
//
// ★ PRICES AND DURATIONS COME FROM enrollment_plans. ALWAYS.
//   The source hardcoded ₱15,999 and ₱1,999 into the comparison table while the
//   live catalog charged ₱16,999 and ₱2,999. A signed agreement stating a price
//   the buyer did not pay is the worst kind of stale copy, so nothing in this
//   file states an amount — agreementModel() reads the rows it is given.
//
//   One caveat, stated plainly rather than left implied: the CALLER may pass
//   ENROLLMENT_PLANS_FALLBACK — when the catalog fetch fails, or to fill a tier
//   that has been deactivated and so is absent from an `active = true` query —
//   and that constant does state amounts. The guarantee here is "this file names
//   no price", not "no constant anywhere does". Keep the fallback in lockstep
//   with the enrollment_plans seed; test/planCatalog.test.mjs pins the pair.
//
// ★ AGREEMENT_VERSION IS STAMPED ON EVERY SIGNATURE.
//   enrollment_requests.agreement_version records which text a student accepted.
//   Bump it whenever wording changes so an old signature never appears to
//   endorse new terms. Adding a plan or repricing one is NOT a wording change.
//
// NO imports, NO side effects, NO DOM, NO network, NO clock — the signing date
// is supplied by the caller so the same inputs always produce the same document.
// ─────────────────────────────────────────────────────────────────────────────

/** Bump on any wording change. Recorded against every signature. */
export const AGREEMENT_VERSION = '2026-08-20';

/** Comparison columns, cheapest first — the order the pricing page uses. */
export const AGREEMENT_TIERS = Object.freeze(['sampler', 'silver', 'vip']);

/**
 * Agreement tier for a plan key.
 *
 * ★ Fails closed. An unknown key returns null rather than defaulting to a tier,
 * so a retired plan (gold_live, core_self_paced — both deleted by #39) or a typo
 * can never highlight the wrong column on a document someone signs.
 */
const TIER_BY_PLAN_KEY = Object.freeze({
  sampler: 'sampler',
  silver_self_paced: 'silver',
  vip: 'vip',
});

const PLAN_KEY_BY_TIER = Object.freeze({
  sampler: 'sampler',
  silver: 'silver_self_paced',
  vip: 'vip',
});

export function tierForPlanKey(planKey) {
  return TIER_BY_PLAN_KEY[planKey] || null;
}

const TIER_META = Object.freeze({
  sampler: { label: 'SAMPLER', pill: 'p-sampler', format: '1 Live Session' },
  silver: { label: 'SILVER', pill: 'p-silver', format: 'Self-paced' },
  vip: { label: 'VIP', pill: 'p-vip', format: 'LIVE + Group' },
});

/** Deterministic peso formatting — no ICU, so tests and PDFs agree byte for byte. */
function fmtPhp(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '₱' + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Human duration for an access window.
 *
 * Months only once the term is long enough for "months" to read as more precise
 * than days: a 60-day plan is genuinely clearer as "60 days" than "2 months",
 * and 365 stays in days because "12.17 months" helps nobody.
 */
export function accessLabel(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return '—';
  const months = d / 30;
  return Number.isInteger(months) && months >= 3 ? `${months} months` : `${d} days`;
}

/** The eight things the simulated project covers, for every tier. */
const COVERAGE = Object.freeze([
  'Categorize 1,000+ transactions',
  'Jan–Dec bank recs (3 accounts)',
  'AP & AR',
  'Month/year-end close',
  'Financial reports',
  'Payroll journal entries (excl. processing)',
  'Sales tax & 1099 insights',
  'US Tax Forms 101 (W-2, W-3, 940, 941, 1040, 1120S, 1065)',
]);

/** The student's seven promises. Verbatim from the source. */
const PLEDGES = Object.freeze([
  'I will attend all scheduled sessions on time and prepared.',
  'I will complete all assigned lessons and coursework.',
  'I will keep my camera ON during live sessions.',
  'I will treat this training as a real client engagement.',
  'I will respect confidentiality and never share course materials.',
  'I will actively apply for jobs and put my learning into practice.',
  'I understand there is no guarantee of employment.',
]);

const COACH_COMMITMENTS = Object.freeze([
  'Provide structured, step-by-step training throughout the program.',
  'Deliver tier-based support and inclusions as outlined above.',
  'Offer guidance until hired for VIP students.',
  'Honor all inclusions promised for the selected tier.',
]);

/**
 * Comparison rows, built against live plan data.
 *
 * Sampler's cells are derived from what the plan actually unlocks
 * (PLAN_ENTITLEMENTS in planCatalog.js), not from a marketing summary: its
 * courseTier is 'essentials', so its QBO cell says "Essentials only" rather than
 * a bare check that would promise the Mastery course; and `resumestrategy` is
 * absent from its tab allowlist, so the Resume & Interview course is a flat no.
 */
function buildRows(priceOf, daysOf) {
  return [
    { divider: 'Core Inclusions' },
    { feature: 'Learning Format', sampler: TIER_META.sampler.format, silver: TIER_META.silver.format, vip: TIER_META.vip.format },
    { feature: 'Investment (PHP)', sampler: fmtPhp(priceOf('sampler')), silver: fmtPhp(priceOf('silver')), vip: fmtPhp(priceOf('vip')) },
    { feature: '1 Live Zoom Session (3 hours)', sampler: true, silver: false, vip: false },
    { feature: '12 Live Zoom Group Trainings', sampler: false, silver: false, vip: true },
    { feature: '4 Live Group Resume & Interview Coaching Sessions', sampler: false, silver: false, vip: true },
    { feature: '1-on-1 Resume & Interview Coaching (1 session)', sampler: false, silver: false, vip: true },
    { feature: '1-on-1 QBO Coaching (30 min, post-hire)', sampler: false, silver: false, vip: true },
    { feature: 'QBO Mastery Course', sampler: 'Essentials only', silver: true, vip: true },
    { feature: 'Access to Resume & Interview Course', sampler: false, silver: true, vip: true },
    { feature: 'Certificate of Completion', sampler: true, silver: true, vip: true },
    { feature: 'Weekly Zoom Job Consultation (until hired)', sampler: false, silver: false, vip: true },
    { feature: 'Community Chat Support', sampler: true, silver: true, vip: true },

    { divider: 'Post-Training Support' },
    { feature: 'Live Zoom Job Consultation', sampler: false, silver: false, vip: 'Wed 6–7PM' },
    { feature: 'Community Chat Window', sampler: '60 days', silver: '60 days (Thu 9–10AM)', vip: 'Until hired (Mon–Fri 11AM–1PM)' },

    { divider: 'Duration & Access' },
    { feature: 'QBO Mastery Course Access', sampler: accessLabel(daysOf('sampler')), silver: accessLabel(daysOf('silver')), vip: accessLabel(daysOf('vip')) },
    { feature: 'Resume & Interview Course Access', sampler: false, silver: accessLabel(daysOf('silver')), vip: accessLabel(daysOf('vip')) },
  ];
}

const callout = (title, body) => ({ title, body });

// The source shipped a second, condensed "2-page" rendering of this same
// agreement. It is deliberately NOT ported: nothing in the app ever requested it,
// and a parallel set of legal clauses that must be kept in step with the twelve
// sections below on every wording change is a drift hazard with no reader. If a
// short form is ever wanted, derive it from these sections rather than restating
// them.
function buildSections() {
  const acceptance = [
    { type: 'p', text: 'Your selected tier is highlighted below. Draw your signature in the Electronic Signature box beneath this agreement to accept it.' },
    { type: 'tierGrid' },
    { type: 'signatures' },
  ];

  return [
    { n: 1, title: 'Program Tiers & Inclusions', blocks: [{ type: 'table' }] },
    { n: 2, title: 'Course Coverage (All Tiers)', blocks: [
      { type: 'coverage' },
      { type: 'callouts', items: [callout('Please note', 'No exam or skills-test assistance, and no actual US tax filing is provided.')] },
    ] },
    { n: 3, title: 'Live Training & Coaching (VIP)', blocks: [{ type: 'callouts', items: [
      callout('Live Zoom Sessions', 'Camera ON with an approved virtual background for every session.'),
      callout('ProAdvisor Certification', 'Achieve QuickBooks Online ProAdvisor Certification by Week 2.'),
      callout('Group Resume & Interview Coaching', 'VIP only — four live group sessions during Weeks 2–4.'),
      callout('1-on-1 Resume & Interview Coaching', 'VIP only — one private session covering your own resume and interview answers.'),
      callout('Post-Employment QBO Coaching', 'VIP only — one 30-minute session within 6 months of getting hired.'),
    ] }] },
    // ★ Section 4 — the one the source computed and threw away.
    { n: 4, title: 'Self-paced Training (Silver)', blocks: [{ type: 'callouts', items: [
      callout('Learn at Your Own Pace', 'Access the full self-paced curriculum for your plan term and study on your own schedule.'),
      callout('Community Chat Support', 'Every Thursday, 9–10AM PHT, in the in-app Community — questions, resume checks and job consultation.'),
      callout('Extend Access', 'Top up your term from Account → Extend Access. The price is pro-rated from your own plan, so you buy more time at the rate you already pay.'),
    ] }] },
    { n: 5, title: 'Post-Training Support', blocks: [{ type: 'callouts', items: [
      callout('Weekly Zoom Consultation', 'Every Wednesday 6–7PM PHT until hired (VIP).'),
      callout('Community Support', 'VIP: weekdays 11AM–1PM until hired. Silver: Thursdays 9–10AM. Sampler: for the length of your term.'),
    ] }] },
    { n: 6, title: 'Course Access & Validity', blocks: [
      { type: 'p', text: 'Course access is granted per tier as shown in Section 1 and expires automatically at the end of the stated validity period. Each term also carries a 3-day grace period after its end date, during which access continues.' },
    ] },
    { n: 7, title: 'Confidentiality & Non-Sharing', blocks: [
      { type: 'warn', title: 'Confidential & Proprietary', text: 'No sharing, copying, or recording of any course materials, sessions, or resources is permitted. Any violation results in immediate termination of access without refund.' },
    ] },
    { n: 8, title: 'No-Refund Policy', blocks: [
      { type: 'p', text: 'All payments are final and non-refundable once enrollment is confirmed.' },
    ] },
    { n: 9, title: 'Certificate of Completion', blocks: [
      { type: 'p', text: 'A Certificate of Completion requires finishing your course in the Toolkits platform plus active participation in coaching. The certificate confirms training completion only and is not a guarantee or offer of employment.' },
    ] },
    { n: 10, title: 'Student Commitment', blocks: [{ type: 'pledges' }] },
    { n: 11, title: 'Coach Commitment', blocks: [{ type: 'commitments' }] },
    { n: 12, title: 'Agreement & Acceptance', blocks: acceptance },
  ];
}

/**
 * Build the whole document for one plan.
 *
 * @param {string|null} planKey  the chosen enrollment_plans.key
 * @param {Array<object>} plans  enrollment_plans rows (prices + access_days)
 * @param {{ studentName?: string, signedOn?: string, variant?: 'full'|'2page' }} opts
 */
export function agreementModel(planKey, plans = [], opts = {}) {
  const byKey = new Map((plans || []).filter(Boolean).map(p => [p.key, p]));
  const planForTier = tier => byKey.get(PLAN_KEY_BY_TIER[tier]) || null;
  const priceOf = tier => planForTier(tier)?.price_php ?? null;
  const daysOf = tier => planForTier(tier)?.access_days ?? null;

  const tierKey = tierForPlanKey(planKey);
  const variant = opts.variant === '2page' ? '2page' : 'full';

  const columns = AGREEMENT_TIERS.map(tier => ({
    key: tier,
    label: TIER_META[tier].label,
    pill: TIER_META[tier].pill,
    format: TIER_META[tier].format,
    pricePhp: priceOf(tier),
    priceLabel: fmtPhp(priceOf(tier)),
    accessLabel: accessLabel(daysOf(tier)),
    planName: planForTier(tier)?.name || null,
    selected: tier === tierKey,
  }));

  return {
    version: AGREEMENT_VERSION,
    variant,
    tierKey,
    tierLabel: tierKey ? TIER_META[tierKey].label : null,
    planKey: planKey || null,
    planName: tierKey ? planForTier(tierKey)?.name || null : null,
    studentName: typeof opts.studentName === 'string' ? opts.studentName : '',
    signedOn: typeof opts.signedOn === 'string' ? opts.signedOn : '',
    coachName: 'Alexander Jr C Sagun',
    eyebrow: 'GET HIRED WITH ALEX',
    title: 'Training Agreement & Student Commitment Form',
    subtitle: 'QuickBooks Online Mastery Program · Coached by Alexander Jr C Sagun',
    footer: 'GET HIRED WITH ALEX · alexsagun.com · Confidential & Proprietary',
    tableFootnote: 'All times are in Philippine Time (PHT).',
    columns,
    rows: buildRows(priceOf, daysOf),
    sections: buildSections(variant),
    coverage: [...COVERAGE],
    pledges: [...PLEDGES],
    coachCommitments: [...COACH_COMMITMENTS],
  };
}

/**
 * The compact record stored in enrollment_requests.agreement_snapshot.
 *
 * Deliberately NOT the rendered HTML the source shipped to its server: what
 * matters for a dispute is which version was accepted, by whom, for which tier,
 * at which price — and the price especially, because that is the number the two
 * parties disagreed about. The document itself is reproducible from the version.
 */
export function agreementSnapshot(model) {
  return {
    version: model.version,
    tier: model.tierKey,
    plan_key: model.planKey,
    plan_name: model.planName,
    student_name: model.studentName,
    signed_on: model.signedOn,
    prices: Object.fromEntries(model.columns.map(c => [c.key, c.pricePhp])),
    access_labels: Object.fromEntries(model.columns.map(c => [c.key, c.accessLabel])),
  };
}
