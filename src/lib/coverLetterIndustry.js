// Industry table + keyword detector for the Cover Letter Generator
// (src/BookkeeperPro.jsx -> CoverLetterGenerator, tab `proposal`).
//
// Lives in src/lib/ because the detector is the only non-obvious algorithm in that tool:
// a keyword scoring pass with a confidence gate that is impossible to verify by clicking
// and trivial to break. Dependency-free ESM (no imports, no side effects, no DOM) so
// `node --test` exercises the same code the browser runs — see
// test/coverLetterIndustry.test.mjs.
//
// One array is the single source of truth for ids, labels, prompt content AND the keyword
// signatures, so a new industry cannot be added to the picker without also teaching the
// detector about it (they used to be two parallel objects that could silently drift).

// Scoring weights. `strong` terms are product names, regulatory terms, or workflow jargon
// that a non-practitioner would not use by accident. `weak` terms are either the plain-English
// name of the vertical or jargon this vertical shares with every other business (1099, Stripe,
// COGS, premium, tenant, dental) — words that show up in unrelated posts often enough that one
// hit alone must never be enough to classify. Promoting one of these to `strong` turns it into a
// single-word classifier, because one strong hit alone clears both MIN_SCORE and MIN_MARGIN.
const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;

// A guess is only made when the leader clears STRONG_WEIGHT (i.e. at least one strong hit,
// or three weak ones) AND beats the runner-up by more than a single weak hit. Anything
// less is a coin flip, and a wrong industry poisons every pain point in the prompt, so we
// fall back to `general` rather than guess.
const MIN_SCORE = 3;
const MIN_MARGIN = 2;

// Below this, the user is still typing and there is nothing to classify.
export const MIN_DETECT_CHARS = 30;

export const COVER_INDUSTRIES = [
  {
    id: 'general',
    label: 'General Business',
    pain: [
      'books are months behind and the owner has lost trust in the numbers',
      'bank reconciliations have not been touched in a while',
      'owner cannot confidently answer are we profitable this month without a panic spreadsheet',
    ],
    deliverables: [
      'clean catch-up and reconciliation within 3 weeks',
      'monthly close package delivered by the 7th every month',
      'clear P&L and balance sheet the owner can actually use to make decisions',
    ],
    tools: ['QuickBooks Online', 'Xero', 'Bill.com'],
    sample: 'Small business looking for a reliable remote bookkeeper. Our books are behind and we are not sure exactly how far. Bank rec has not been done in a while, expenses are mixed up, and we need someone to clean things up. We use QuickBooks Online.',
    // `general` is the fallback, never a match target — it deliberately has no signatures.
    strong: [],
    weak: [],
  },
  {
    id: 'construction',
    label: 'Construction',
    pain: [
      'job cost reports are always late or wrong',
      'WIP schedules are a mess and retainage is never tracked',
      'progress billing disputes eat up PM time',
    ],
    deliverables: [
      'weekly job cost variance reports in 48 hrs',
      'clean WIP schedule updated every draw cycle',
      'progress billing reconciled against contract to the penny',
    ],
    tools: ['QuickBooks Contractor', 'Buildertrend', 'Procore'],
    sample: 'We are a mid-size GC doing 8 to 12M per year. Our current bookkeeper cannot keep up with job costing. We have 14 active projects and retainage is not tracked anywhere. We use QuickBooks Contractor and Buildertrend but they are not linked.',
    strong: ['job costing', 'wip', 'retainage', 'progress billing', 'buildertrend', 'procore', 'quickbooks contractor', 'subcontractor', 'change order', 'draw schedule', 'aia billing', 'cost code'],
    weak: ['general contractor', 'construction', 'contractor', 'job cost', 'building trades'],
  },
  {
    id: 'realestate',
    label: 'Real Estate',
    pain: [
      'trust accounts out of balance and one audit away from disaster',
      'property-level P&L impossible to pull without days of work',
      'rent roll reconciliation done manually in Excel',
    ],
    deliverables: [
      'property-level P&L ready by the 5th of every month',
      'trust account three-way reconciliation monthly',
      'clean rent roll with variance flags auto-highlighted',
    ],
    tools: ['AppFolio', 'Buildium', 'Yardi'],
    sample: 'We manage 120 residential units across 6 properties. Our books are in AppFolio but nobody is reconciling the trust accounts. Each property needs its own P&L for lenders.',
    strong: ['appfolio', 'buildium', 'yardi', 'iolta', 'rent roll', 'trust account', 'property management', 'rental property', 'landlord'],
    weak: ['real estate', 'property', 'rental', 'leasing', 'cap rate', 'tenant'],
  },
  {
    id: 'ecommerce',
    label: 'E-commerce',
    pain: [
      'Shopify and Amazon payouts hit the bank but nobody knows what they mean',
      'sales tax nexus exposure growing every month unchecked',
      'COGS is guesswork with no landed cost tracking',
    ],
    deliverables: [
      'A2X-automated payout reconciliation within 2 days of each settlement',
      'multi-state sales tax nexus map with liability estimate',
      'COGS per SKU tracked monthly with landed cost baked in',
    ],
    tools: ['QuickBooks Online', 'Xero', 'A2X'],
    sample: '7-figure Shopify and Amazon store. We are selling in 18 states and have no idea about sales tax exposure. A2X is installed but not configured. Need someone who lives in e-commerce accounting.',
    strong: ['shopify', 'amazon seller', 'a2x', 'sales tax nexus', 'landed cost', 'sku', 'fulfillment', 'marketplace', 'amazon fba', 'ebay', 'etsy'],
    weak: ['e-commerce', 'ecommerce', 'online store', 'd2c', 'dtc', 'cogs'],
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    pain: [
      'insurance reimbursements sitting in A/R 90+ days with no follow-up',
      'patient A/R aging report has not been run in months',
      'HIPAA-compliant data handling non-negotiable but never verified',
    ],
    deliverables: [
      'insurance A/R aging report weekly, segmented by payer',
      'denial rate tracked monthly with root-cause flag',
      'month-end close done with HIPAA-safe data workflow throughout',
    ],
    tools: ['Kareo', 'Athena', 'DrChrono'],
    sample: 'We are a 3-provider physical therapy practice. Insurance reimbursements are all over the place. We use Kareo for billing but our bookkeeping is in QBO and nothing talks to each other.',
    strong: ['kareo', 'athena', 'drchrono', 'hipaa', 'insurance reimbursement', 'patient a/r', 'denial rate', 'medical billing', 'revenue cycle', 'cpt code', 'clinic', 'medical practice', 'physical therapy', 'chiropractic'],
    weak: ['healthcare', 'medical', 'patients', 'providers', 'dental'],
  },
  {
    id: 'insurance',
    label: 'Insurance',
    pain: [
      'commission statements from carriers never match what is in the AMS',
      'chargeback reconciliation done once a year, not monthly',
      'agency management system and GL are two completely different stories',
    ],
    deliverables: [
      'monthly commission reconciliation to the carrier statement',
      'chargeback log maintained and reconciled every cycle',
      'AMS and GL in sync by the 10th of each month',
    ],
    tools: ['AMS360', 'Applied Epic', 'EZLynx'],
    sample: 'Independent insurance agency, 2.4M GWP. We get commission statements from 11 carriers and our AMS360 never matches what we deposited. Need a bookkeeper who understands insurance.',
    strong: ['ams360', 'applied epic', 'ezlynx', 'commission statement', 'chargeback', 'insurance agency', 'producer', 'gwp', 'captive agent', 'independent agent'],
    weak: ['insurance', 'agency', 'policy', 'policies', 'underwriter', 'premium'],
  },
  {
    id: 'accounting',
    label: 'Accounting Firms',
    pain: [
      'client cleanup jobs pile up and white-label capacity is always short',
      'month-end close gets pushed to the 20th because bandwidth is thin',
      'Karbon workflow is broken and client data sits in limbo',
    ],
    deliverables: [
      'full white-label cleanup delivered within agreed scope and deadline',
      'month-end close package ready by the 7th for every client',
      'Karbon tasks updated daily so you always know status',
    ],
    tools: ['QuickBooks Online', 'Xero', 'Karbon', 'Keeper'],
    sample: 'CPA firm with 40 small business clients. We are drowning in cleanup work. Looking for a white-label bookkeeper who can take on 8-10 clients.',
    strong: ['karbon', 'keeper', 'white-label', 'white label', 'cpa firm', 'accounting firm', 'client cleanup', 'month-end close', 'cas practice', 'advisory services', 'outsourced accounting'],
    weak: ['cpa', 'accountant', 'accounting practice', 'bookkeeping firm'],
  },
  {
    id: 'lawfirm',
    label: 'Law Firms',
    pain: [
      'IOLTA trust account has not been three-way reconciled in 4 months',
      'matter-based billing does not match what is in the GL',
      'state bar audit risk is real and nobody is addressing it',
    ],
    deliverables: [
      'IOLTA three-way reconciliation done monthly',
      'matter-level P&L updated every billing cycle',
      'trust-to-operating transfer log maintained with zero errors',
    ],
    tools: ['Clio', 'PCLaw', 'CosmoLex'],
    sample: 'Boutique litigation firm, 6 attorneys. Our IOLTA account is a mess. We use Clio but the GL in PCLaw never matches.',
    strong: ['iolta', 'clio', 'pclaw', 'cosmolex', 'matter-based billing', 'state bar', 'three-way reconciliation', 'law firm', 'attorneys', 'litigation'],
    weak: ['legal', 'attorney', 'lawyer', 'law practice'],
  },
  {
    id: 'saas',
    label: 'SaaS / Tech',
    pain: [
      'MRR and ARR reported differently every month and nobody trusts the number',
      'deferred revenue not recognized under ASC 606',
      'Stripe payouts hit the bank and nobody reconciles them',
    ],
    deliverables: [
      'MRR/ARR dashboard updated by the 3rd, consistent methodology every month',
      'deferred revenue schedule maintained in compliance with ASC 606',
      'Stripe reconciled to the GL within 48 hrs of each payout',
    ],
    tools: ['Stripe', 'QuickBooks Online', 'Maxio'],
    sample: 'B2B SaaS, 1.8M ARR. Our investors keep asking for MRR and we give them a different number every time. Stripe payouts go into the bank but nobody is reconciling.',
    strong: ['mrr', 'arr', 'asc 606', 'deferred revenue', 'maxio', 'chartmogul', 'saas', 'subscription revenue', 'revenue recognition', 'annual contracts', 'arpu', 'churn', 'ltv', 'cac'],
    weak: ['software company', 'tech startup', 'b2b saas', 'startup', 'recurring revenue', 'stripe'],
  },
  {
    id: 'restaurant',
    label: 'Restaurants',
    pain: [
      'daily sales reconciliation never done and POS and bank never match',
      'tip reporting is a liability waiting to happen',
      'food cost tracked monthly at best, never daily or weekly',
    ],
    deliverables: [
      'daily sales reconciliation from POS to bank',
      'tip reporting log maintained weekly, IRS-compliant',
      'food cost variance report every week, by category',
    ],
    tools: ['Toast', 'Restaurant365', 'Square'],
    sample: 'Fast-casual restaurant group, 3 locations. Our Toast POS reports never match the bank. Food cost is tracked monthly but we have no idea where waste is happening.',
    strong: ['toast', 'restaurant365', 'square pos', 'tip reporting', 'food cost', 'prime cost', 'daily sales', 'pos reconciliation', 'fast-casual', 'menu engineering'],
    weak: ['restaurant', 'cafe', 'coffee shop', 'bar', 'brewery', 'hospitality', 'food service'],
  },
  {
    id: 'agency',
    label: 'Agencies',
    pain: [
      'project profitability unknown until the invoice is sent',
      '1099 season is chaos because contractor payments were never tracked',
      'retainer vs project billing mixed up in QBO',
    ],
    deliverables: [
      'project-level P&L updated bi-weekly',
      '1099 tracker maintained monthly',
      'retainer and project billing separated in QBO from day one',
    ],
    tools: ['QuickBooks Online', 'Harvest', 'Productive'],
    sample: 'Digital marketing agency, 1.2M revenue. We have no idea which clients are actually profitable. Retainer income and project fees are mixed together in QBO.',
    strong: ['harvest', 'productive', 'project profitability', 'retainer', 'contractor payments', 'agency accounting', 'billable hours', 'utilization', 'project-based billing'],
    weak: ['marketing agency', 'creative agency', 'digital agency', 'ad agency', 'consulting firm', '1099'],
  },
];

export const DEFAULT_INDUSTRY_ID = 'general';

export function getIndustry(id) {
  return COVER_INDUSTRIES.find(i => i.id === id) || COVER_INDUSTRIES[0];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
}

// Whole-term match. Guarding both sides on [a-z0-9] rather than using \b matters because
// several signatures contain punctuation ("a/r", "asc 606", "white-label") where \b would
// fire inside a longer word — "cac" must not match "cacophony", but "patient a/r" must
// still match "patient a/r aging".
function hasTerm(haystack, term) {
  try {
    return new RegExp('(^|[^a-z0-9])' + escapeRegExp(term) + '(?![a-z0-9])', 'i').test(haystack);
  } catch {
    return false;
  }
}

/**
 * Guess the client's vertical from a pasted job description.
 * @param {string} text raw job description
 * @returns {string|null} an id from COVER_INDUSTRIES, or null when there is not yet
 *   enough text to judge (callers keep their current selection in that case, rather
 *   than snapping the picker back to the fallback on every keystroke).
 */
export function detectIndustry(text) {
  if (typeof text !== 'string' || text.trim().length < MIN_DETECT_CHARS) return null;
  const lower = text.toLowerCase();

  const scored = COVER_INDUSTRIES
    .filter(ind => ind.strong.length > 0 || ind.weak.length > 0)
    .map(ind => {
      let score = 0;
      for (const term of ind.strong) if (hasTerm(lower, term)) score += STRONG_WEIGHT;
      for (const term of ind.weak) if (hasTerm(lower, term)) score += WEAK_WEIGHT;
      return { id: ind.id, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return DEFAULT_INDUSTRY_ID;

  const top = scored[0];
  const runnerUp = scored[1] ? scored[1].score : 0;
  if (top.score >= MIN_SCORE && top.score - runnerUp >= MIN_MARGIN) return top.id;
  return DEFAULT_INDUSTRY_ID;
}

/**
 * Strip em/en dashes from generated copy.
 *
 * The prompt bans them at length, but they still slip through and they are the single
 * loudest "an AI wrote this" tell in outreach. Deliberately narrow: the original mockup
 * also rewrote every semicolon to a period and then every ". " + lowercase to a comma,
 * which corrupted ordinary text ("U.S. based" -> "U.S, based", "9 a.m. to 5" -> "9 a.m, to 5",
 * "$12/hr. quickbooks" -> "$12/hr, quickbooks"). That second pass only existed to repair
 * damage the first pass caused, so both are gone.
 *
 * A dash before a capital is a sentence boundary; anywhere else it is an aside, which a
 * comma renders correctly.
 */
export function scrubDashes(s) {
  if (typeof s !== 'string') return s;
  // [^\S\n] is horizontal whitespace ONLY. Using \s* here would swallow the newline
  // before a line-initial dash — the single most likely place a banned dash survives
  // the prompt, because it is how signature lines and asides get written:
  //   "Talk soon.\n— Maria"  must not collapse to  "Talk soon.. Maria"
  return s.replace(/[^\S\n]*[—–][^\S\n]*/g, (match, offset, str) => {
    const prev = str.slice(0, offset).replace(/[^\S\n]+$/, '').slice(-1);
    const next = str.charAt(offset + match.length);

    // At a line start there is nothing to join, and the previous line already ends
    // in its own punctuation. Just drop the dash.
    if (!prev || prev === '\n') return '';
    // The clause is already punctuated ("month, — and then"); adding more would
    // double it. Keep the word separation only.
    if ('.,!?:;'.includes(prev)) return (next && next !== '\n') ? ' ' : '';
    if (!next || next === '\n') return '';
    // A capital after the dash reads as a new sentence; anything else is an aside.
    return /[A-Z]/.test(next) ? '. ' : ', ';
  });
}
