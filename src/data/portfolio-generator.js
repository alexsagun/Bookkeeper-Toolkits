// Portfolio Generator presets: themes, industry pain-point libraries, and the
// example draft (Portfolio Generator tab). Extracted from the standalone artifact
// as pure data — lazy-loaded on first visit of the consuming tab alongside
// src/lib/portfolioGenerator.js (see useLazyData in BookkeeperPro.jsx).

// ═══════════════════════════════════════════════════════════════════════════
// NINE VISUAL THEMES
// ═══════════════════════════════════════════════════════════════════════════
// The source artifact labelled this block "THEMES (6)" and then defined nine.
// There are nine. Each is validated by isTheme() in src/lib/portfolioGenerator.js
// before a single value reaches a <style> block, and the whole table is checked
// by test/portfolioGenerator.test.mjs — a malformed hex here would otherwise be
// the one route by which user-influenced text could enter generated CSS.
//
// `mode` drives the text/heading/glass palette the builder derives. `on` is the
// text colour that sits ON the accent (buttons, the transformation arrow), so it
// is the one value that must contrast with `accent` rather than with the page.

export const PORTFOLIO_THEMES = {
  navy: {
    key: 'navy', name: 'Navy & Teal', mode: 'dark',
    d1: '#0a1a2e', d2: '#123a5a', accent: '#19c2b3', accent2: '#12a99b',
    glow: '#5cf0e2', on: '#03231f', pg1: '#0b1f34', pg2: '#0f3340',
  },
  bluewhite: {
    key: 'bluewhite', name: 'Blue & White', mode: 'light',
    d1: '#0b46b8', d2: '#1e73d8', accent: '#1e6fd0', accent2: '#0d51a8',
    glow: '#78b0ff', on: '#ffffff', pg1: '#eff5ff', pg2: '#dbe8ff',
  },
  emerald: {
    key: 'emerald', name: 'Forest & Emerald', mode: 'dark',
    d1: '#0c1f18', d2: '#124030', accent: '#28c274', accent2: '#1c9c59',
    glow: '#63f0a2', on: '#04231a', pg1: '#0d201a', pg2: '#123726',
  },
  royal: {
    key: 'royal', name: 'Royal & Gold', mode: 'dark',
    d1: '#0e1430', d2: '#1c2a5e', accent: '#e2b53a', accent2: '#c9971a',
    glow: '#ffd873', on: '#2a1e00', pg1: '#101838', pg2: '#1a244e',
  },
  plum: {
    key: 'plum', name: 'Plum & Mint', mode: 'dark',
    d1: '#20123a', d2: '#3a1f5e', accent: '#20c2a8', accent2: '#149a86',
    glow: '#6ff0d6', on: '#04231d', pg1: '#241542', pg2: '#341f57',
  },
  charcoal: {
    key: 'charcoal', name: 'Charcoal & Amber', mode: 'dark',
    d1: '#141418', d2: '#26262e', accent: '#f5a623', accent2: '#d68910',
    glow: '#ffc65c', on: '#241a00', pg1: '#17171c', pg2: '#25252c',
  },
  coral: {
    key: 'coral', name: 'Slate & Coral', mode: 'dark',
    d1: '#20262e', d2: '#343d49', accent: '#ff6f61', accent2: '#ec5442',
    glow: '#ff9d8f', on: '#2a0d08', pg1: '#232a33', pg2: '#333b46',
  },
  blackyellow: {
    key: 'blackyellow', name: 'Black · Yellow · Brown', mode: 'dark',
    d1: '#121010', d2: '#2a2016', accent: '#f2c14e', accent2: '#a86b2b',
    glow: '#ffd873', on: '#241a00', pg1: '#161310', pg2: '#2a2015',
  },
  redblack: {
    key: 'redblack', name: 'Red & Black', mode: 'dark',
    // ★ accent darkened #e23b3b -> #d93333 so white CTA text clears WCAG AA. Measured:
    //   #ffffff on #e23b3b is 4.27:1, below the 4.5 floor for normal text, and this
    //   theme's `on` IS #ffffff — so the primary CTA, the nav CTA, the price badge and
    //   the active statement tab all failed, in a page the student publishes. #d93333
    //   measures 4.70:1 and is visually all but identical.
    d1: '#160a0c', d2: '#2c1114', accent: '#d93333', accent2: '#b52121',
    glow: '#ff6b6b', on: '#ffffff', pg1: '#140a0b', pg2: '#241012',
  },
};

/** Render order for the theme swatches — `navy` first because it is the default. */
export const PORTFOLIO_THEME_ORDER = [
  'navy', 'bluewhite', 'emerald', 'royal', 'plum', 'charcoal', 'coral', 'blackyellow', 'redblack',
];

// ═══════════════════════════════════════════════════════════════════════════
// TEN INDUSTRY LIBRARIES
// ═══════════════════════════════════════════════════════════════════════════
// Applying an industry fills the pain-point and before/after sections with copy
// a business owner in that trade recognises. Every line describes a BOOKKEEPING
// problem the student can genuinely solve — no claims about the student's own
// experience, which is what keeps a preset safe to apply unedited.

export const PORTFOLIO_INDUSTRIES = [
  {
    key: 'construction',
    label: 'Construction',
    pains: [
      "Job costing is guesswork — you can't tell which projects actually made money",
      'Change orders, retention, and progress billing pile up uninvoiced',
      'Subcontractor 1099s and compliance docs scramble every year-end',
      'Cash gets tight mid-project when draws and payables fall out of sync',
    ],
    transforms: [
      { before: 'Profit per job unknown until the job is already done', after: 'Real-time job costing so you bid and build profitably' },
      { before: 'Change orders lost between the field and the office', after: 'Every change order captured and billed — nothing left on the table' },
      { before: 'Year-end WIP and 1099 panic', after: 'Clean WIP schedules and 1099s filed early, stress-free' },
    ],
  },
  {
    key: 'retail',
    label: 'Retail & E-commerce',
    pains: [
      "Inventory and COGS never match what's actually on the shelf",
      'Sales tax across channels and states is a constant worry',
      "You can't see which products or SKUs actually make you money",
      'Processor fees and payouts are a black box in your books',
    ],
    transforms: [
      { before: 'Guessing your margin on every product', after: 'Clear per-SKU profitability you can act on' },
      { before: 'Sales-tax anxiety across every channel', after: 'Accurate, on-time sales tax you never think about' },
      { before: 'Stripe/PayPal payouts unreconciled for months', after: 'Every payout reconciled to the penny automatically' },
    ],
  },
  {
    key: 'manufacturing',
    label: 'Manufacturing',
    pains: [
      'Cost of goods and overhead allocation are fuzzy at best',
      "Raw materials, WIP, and finished-goods inventory don't tie out",
      "You don't know your true margin per product line",
      'Month-end close drags on for weeks',
    ],
    transforms: [
      { before: 'Overhead spread by gut feel', after: 'Proper cost allocation and accurate unit costs' },
      { before: 'Inventory values that never match the floor', after: 'Reconciled inventory across every stage' },
      { before: 'Close taking three weeks', after: 'Books closed within five business days' },
    ],
  },
  {
    key: 'restaurants',
    label: 'Food & Beverage / Restaurants',
    pains: [
      'Food and labor cost percentages are always a mystery',
      'Tips, comps, and voids muddy your daily sales numbers',
      'Vendor invoices and prime-cost tracking fall behind',
      'You never really know if a location is profitable',
    ],
    transforms: [
      { before: 'Prime cost unknown until it hurts', after: 'Weekly food & labor cost you can actually manage to' },
      { before: 'POS never reconciled to the bank', after: 'Daily sales tied out to every deposit' },
      { before: 'Guessing which location makes money', after: 'A clean P&L per location, every month' },
    ],
  },
  {
    key: 'realestate',
    label: 'Real Estate & Property Mgmt',
    pains: [
      'Income and expenses per property are jumbled together',
      'Owner draws, escrow, and security deposits get mixed up',
      '1099s for owners and vendors are a year-end nightmare',
      "You can't produce a clean owner statement on demand",
    ],
    transforms: [
      { before: 'One big pile of income and expense', after: 'Clean per-property P&Ls and owner statements' },
      { before: 'Trust and escrow funds commingled', after: 'Properly segregated trust accounting' },
      { before: 'Scrambling for 1099s in January', after: 'Vendor and owner 1099s ready before year-end' },
    ],
  },
  {
    key: 'services',
    label: 'Professional Services & Agencies',
    pains: [
      'Billable vs non-billable time never makes it into the numbers',
      'Project profitability is a guess after the work is done',
      'Receivables age out and cash flow suffers',
      "Retainers and deferred revenue aren't tracked properly",
    ],
    transforms: [
      { before: 'No idea which clients are profitable', after: 'Clear client- and project-level margins' },
      { before: 'AR quietly aging past 60 days', after: 'Tight AR and predictable cash flow' },
      { before: 'Retainers booked as instant revenue', after: 'Proper deferred revenue and clean recognition' },
    ],
  },
  {
    key: 'healthcare',
    label: 'Healthcare & Medical Practices',
    pains: [
      'Insurance reimbursements and patient payments are hard to reconcile',
      'Payroll for providers and staff is complex and error-prone',
      "You can't see profitability by provider or service line",
      'Audit-ready, compliant records keep slipping',
    ],
    transforms: [
      { before: 'Payments and reimbursements never reconciled', after: 'Every deposit matched to the right claim' },
      { before: 'No visibility by provider', after: 'Clear per-provider and per-service P&L' },
      { before: 'Audit-ready? Not even close', after: 'Clean, documented, audit-ready books' },
    ],
  },
  {
    key: 'nonprofit',
    label: 'Nonprofit',
    pains: [
      "Restricted vs unrestricted funds aren't tracked separately",
      'Grant reporting and program budgets are a manual scramble',
      'Board-ready financials take days to pull together',
      'Form 990 prep is stressful every single year',
    ],
    transforms: [
      { before: 'Restricted funds mixed with general funds', after: 'Proper fund accounting with clean restrictions' },
      { before: 'Grant reports built from scratch each time', after: 'Grant-ready reporting on demand' },
      { before: '990 season panic', after: 'Year-round records that make 990 easy' },
    ],
  },
  {
    key: 'trades',
    label: 'Trades & Home Services',
    pains: [
      "Materials and labor per job aren't tracked, so margins are a mystery",
      'Invoices go out late and payments trickle in slowly',
      'Technician payroll and reimbursements are messy',
      'Tax time means digging through a shoebox of receipts',
    ],
    transforms: [
      { before: 'No clue which jobs are profitable', after: 'Job-level costing that protects your margins' },
      { before: 'Slow, late invoicing', after: 'Fast invoicing and healthy cash flow' },
      { before: 'Shoebox receipts at tax time', after: 'Digitized, categorized, tax-ready records' },
    ],
  },
  {
    key: 'saas',
    label: 'Technology & SaaS / Startups',
    pains: [
      "MRR, deferred revenue, and ARR aren't reflected in the books",
      'Burn rate and runway are unclear exactly when you need them',
      'Investor-ready financials take weeks to assemble',
      'R&D, contractor, and 1099 tracking is inconsistent',
    ],
    transforms: [
      { before: 'Revenue recognized all at once, not over time', after: 'Clean, ASC 606-aligned deferred revenue' },
      { before: 'Runway is a guess', after: 'Clear burn rate and runway every month' },
      { before: 'Investor reports cobbled together', after: 'Board- and investor-ready financials on demand' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// THE EXAMPLE DRAFT
// ═══════════════════════════════════════════════════════════════════════════
// ★ EVERY NAME, NUMBER AND QUOTE BELOW IS INVENTED, AND THAT IS THE POINT.
//   "Jordan Reyes" is not a person. The two testimonials were written for this
//   file; nobody said them. The metrics were chosen to look plausible; nobody
//   measured them. The source artifact headed this same content with the real
//   name of the product's owner and loaded it into every new user's editor ON
//   MOUNT — so a student who edited three fields and hit download published
//   invented client testimonials under somebody else's name.
//
//   Two things therefore hold, and both are enforced elsewhere rather than
//   trusted here:
//     1. It is NEVER the initial draft. The editor starts empty; this loads only
//        when a student presses "Load example".
//     2. sampleFieldsStillPresent() in src/lib/portfolioGenerator.js compares a
//        draft against this object field by field, and the download step names
//        every field still holding example text. A banner at the top of a form
//        is not read at download time; a list of the exact unreplaced fields is.
//
//   Keep the contact details unusable-on-purpose (example.com is reserved by
//   RFC 2606; 555-01xx is the reserved fictional US range) so that even a
//   careless download cannot point a real prospect at a real stranger.

export const SAMPLE_DRAFT = {
  theme: 'navy',
  industry: 'Construction',
  fullName: 'Jordan Reyes',
  // ★ DELIBERATELY EMPTY. This was 'CB' — the American Institute of Professional
  //   Bookkeepers' Certified Bookkeeper designation, a real credential a real body
  //   awards. displayName() renders it as "<name>, CB" into the hero, the nav and the
  //   <title>, so a student who replaced the name and cleared the education section
  //   published a specific professional certification they may not hold. A postnominal
  //   is not example COPY the way a testimonial is — there is no version of it that
  //   reads as obviously invented — so the example does not ship one at all. The
  //   education entry below still demonstrates what that section looks like.
  credentials: '',
  title: 'Remote Bookkeeper / Accountant',
  location: 'Remote · Serving US Clients',
  email: 'jordan@example.com',
  // ★ (213) 555-0147, not (555) 010-4477. The header comment above promises "the reserved
  //   fictional US range", and the reserved NANP range is 555-0100..555-0199 in the
  //   CENTRAL-OFFICE position — so the 555 belongs after the area code, not as it. The old
  //   value was undialable too, but for reasons the comment never stated (area code 555 is
  //   unassigned and an office code of 010 is structurally invalid), while still emitting a
  //   tappable ten-digit `tel:5550104477`. This form is the convention a reader recognises
  //   on sight as fictional, which is the actual point.
  phone: '(213) 555-0147',
  website: 'https://www.example.com/in/jordan-reyes',
  photo: '',
  heroHeadline: 'Clean books, clear numbers, zero tax-season panic.',
  heroSub: 'I help US business owners stop drowning in messy transactions and finally trust their financials — reconciled to the penny, on time, every month.',
  ctaText: 'Book a free discovery call',
  ctaLink: '#contact',
  painPoints: [
    "Job costing is guesswork — you can't tell which projects actually made money",
    'Change orders, retention, and progress billing pile up uninvoiced',
    'Subcontractor 1099s and compliance docs scramble every year-end',
    'Cash gets tight mid-project when draws and payables fall out of sync',
  ],
  transformations: [
    { before: 'Profit per job unknown until the job is already done', after: 'Real-time job costing so you bid and build profitably' },
    { before: 'Change orders lost between the field and the office', after: 'Every change order captured and billed — nothing left on the table' },
    { before: 'Year-end WIP and 1099 panic', after: 'Clean WIP schedules and 1099s filed early, stress-free' },
  ],
  summary: 'Detail-oriented Bookkeeper and Certified QuickBooks ProAdvisor with 5 years of hands-on, full-cycle accounting experience for US clients. I take businesses from backlogged and messy to clean, reconciled, and audit-ready — and build the SOPs that keep them that way.',
  services: [
    { name: 'Full-Cycle Monthly Bookkeeping', desc: 'Transaction recording, categorization, and monthly financial reports you can actually read and act on.' },
    { name: 'Catch-Up & Clean-Up', desc: 'Months (or years) of backlog brought current and reconciled, so your books tell the truth again.' },
    { name: 'Bank & Credit Card Reconciliation', desc: 'Every account tied out to a 0% unreconciled balance, discrepancies chased down and cleared.' },
    { name: 'Payroll & 1099 Support', desc: 'Payroll journal entries, W-2/W-3, and 1099-NEC/MISC prep with W-9 tracking — filed on time.' },
  ],
  packages: [
    { name: 'Starter', price: '$300', period: '/mo', features: ['Up to 2 accounts', 'Monthly reconciliation', 'P&L + Balance Sheet', 'Email support'], featured: false },
    { name: 'Growth', price: '$600', period: '/mo', features: ['Up to 5 accounts', 'Everything in Starter', 'Payroll journal entries', '1099 prep', 'Monthly review call'], featured: true },
    { name: 'Clean-Up', price: 'Custom', period: '', features: ['Backlog assessment', 'Full catch-up & recon', 'SOP handoff', 'Fixed scope quote'], featured: false },
  ],
  tools: [
    { name: 'QuickBooks Online', level: 95 },
    { name: 'Xero', level: 80 },
    { name: 'Microsoft Excel', level: 90 },
    { name: 'Google Workspace', level: 85 },
    { name: 'SAP', level: 60 },
    { name: 'Bill.com', level: 70 },
  ],
  industries: ['Construction', 'Manufacturing', 'IT & Software', 'Food & Beverage', 'Retail', 'Real Estate', 'Professional Services'],
  metrics: [
    { value: 1000, suffix: '+', label: 'Transactions managed accurately' },
    { value: 0, suffix: '%', label: 'Unreconciled balance maintained' },
    { value: 10, suffix: '+', label: 'Accounting SOPs built' },
    { value: 5, suffix: 'yrs', label: 'US bookkeeping experience' },
  ],
  testimonials: [
    { quote: 'Jordan took our year of backlog and had us caught up and reconciled in six weeks. For the first time I actually trust our numbers.', name: 'Maria L.', role: 'Owner, Construction Co.' },
    { quote: 'Our tax return was filed on time with zero audit findings. That alone paid for the whole engagement.', name: 'James T.', role: 'Founder, Retail Brand' },
  ],
  education: [
    { credential: 'Certified Bookkeeper (CB)', detail: 'American Institute of Professional Bookkeepers' },
    { credential: 'QuickBooks Online ProAdvisor', detail: 'Certified' },
  ],
  showSamples: true,
  sampleCompany: 'Sample Client, LLC',
  samplePeriod: 'For the Year Ended December 31, 2025',
};
