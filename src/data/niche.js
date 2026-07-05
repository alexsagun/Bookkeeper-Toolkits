// Niche selector quiz questions + niche profiles (NicheSelectorQuiz).
// Extracted from src/BookkeeperPro.jsx as pure data — lazy-loaded on first visit
// of the consuming tab via the useLazyData hook (see BookkeeperPro.jsx).

export const NICHE_QUESTIONS = [
  {
    q: 'Which type of work energizes you most?',
    options: [
      { label: 'Pattern-matching and reconciliation — finding mistakes others missed', tags: ['ecommerce', 'restaurant', 'medical'] },
      { label: 'Complex narratives — long-running projects with many moving parts', tags: ['construction', 'lawfirm', 'professional'] },
      { label: 'Strategic, forward-looking advisory work', tags: ['saas', 'startup', 'agency'] },
      { label: 'Tracking inventory and physical goods', tags: ['ecommerce', 'restaurant', 'trucking'] },
    ],
  },
  {
    q: 'How comfortable are you with technology and integrations?',
    options: [
      { label: 'Very — I love connecting apps, building automations, learning new tools', tags: ['saas', 'ecommerce', 'startup', 'agency'] },
      { label: 'Comfortable but prefer stable, well-known tools', tags: ['lawfirm', 'realestate', 'professional', 'medical'] },
      { label: 'Prefer simple, traditional bookkeeping without complex integrations', tags: ['construction', 'restaurant', 'trucking'] },
    ],
  },
  {
    q: 'What kind of client communication style suits you?',
    options: [
      { label: 'Async-first — Slack, Loom, email, minimal calls', tags: ['saas', 'startup', 'agency', 'ecommerce'] },
      { label: 'Hybrid — scheduled monthly calls + async between', tags: ['professional', 'medical', 'realestate', 'agency'] },
      { label: 'Heavy real-time communication — calls, in-person feel, frequent touchpoints', tags: ['construction', 'restaurant', 'lawfirm'] },
    ],
  },
  {
    q: 'What client size are you targeting?',
    options: [
      { label: 'Solopreneurs and very small businesses ($100K–$500K revenue)', tags: ['professional', 'realestate', 'agency', 'startup'] },
      { label: 'Small businesses ($500K–$3M revenue)', tags: ['ecommerce', 'restaurant', 'construction', 'medical', 'lawfirm'] },
      { label: 'Growth-stage / scaling companies ($3M+ revenue)', tags: ['saas', 'accountingfirm', 'trucking'] },
    ],
  },
  {
    q: 'What technical specialization interests you most?',
    options: [
      { label: 'Tax-adjacent work — sales tax, 1099s, quarterly estimates', tags: ['ecommerce', 'professional', 'realestate'] },
      { label: 'Industry-specific compliance (IOLTA, HIPAA, IFTA, trust accounting)', tags: ['lawfirm', 'medical', 'trucking', 'nonprofit'] },
      { label: 'Advanced accounting (ASC 606, deferred revenue, equity, M&A)', tags: ['saas', 'startup', 'accountingfirm'] },
      { label: 'Cost accounting / job costing / unit economics', tags: ['construction', 'restaurant', 'agency', 'professional'] },
    ],
  },
  {
    q: 'How important is recurring monthly revenue vs project-based work to you?',
    options: [
      { label: 'Strong preference for predictable monthly retainers', tags: ['saas', 'agency', 'medical', 'lawfirm', 'realestate'] },
      { label: 'Mix of recurring + occasional cleanup/project work', tags: ['ecommerce', 'professional', 'restaurant', 'construction'] },
      { label: 'Open to project-heavy work (cleanups, audits, special engagements)', tags: ['accountingfirm', 'nonprofit', 'startup'] },
    ],
  },
  {
    q: 'How do you feel about working with regulatory/compliance pressure?',
    options: [
      { label: 'I thrive on it — strict rules, deadlines, audits, regulations', tags: ['lawfirm', 'medical', 'trucking', 'nonprofit'] },
      { label: 'Comfortable but not my main draw', tags: ['ecommerce', 'realestate', 'restaurant', 'professional'] },
      { label: 'Prefer minimal regulatory complexity', tags: ['agency', 'saas', 'startup', 'construction'] },
    ],
  },
  {
    q: 'How important is geographic/state diversity in your client base?',
    options: [
      { label: 'I want clients across many US states (multi-state expertise)', tags: ['ecommerce', 'saas', 'accountingfirm', 'agency'] },
      { label: 'A few states is fine — focused regional expertise', tags: ['realestate', 'construction', 'restaurant', 'medical'] },
      { label: 'No preference — wherever the right clients are', tags: ['professional', 'startup', 'lawfirm', 'nonprofit'] },
    ],
  },
];

export const NICHE_PROFILES = {
  construction: { name: 'Construction', icon: '🏗️', why: 'You like project-based narratives, cost tracking, and working with hands-on owners. Construction bookkeepers are well-paid because job costing and WIP accounting are technically demanding.' },
  ecommerce: { name: 'E-Commerce', icon: '🛒', why: 'You like patterns, reconciliations, and tech tools. E-comm is the most "remote-bookkeeper-native" niche — async-first owners, cloud-based everything.' },
  lawfirm: { name: 'Law Firm', icon: '⚖️', why: 'You can handle high-stakes compliance (IOLTA trust accounting) and like working with detail-oriented professionals. Law firms pay premium rates for trust-account expertise.' },
  realestate: { name: 'Real Estate (Investor / PM)', icon: '🏘️', why: 'You like property-by-property tracking and the steady rhythm of rental income. Real estate investors are a fast-growing remote-bookkeeper niche.' },
  restaurant: { name: 'Restaurant / F&B', icon: '🍽️', why: 'You enjoy hands-on operators and high-touch communication. Restaurants need weekly food-cost analysis — recurring high-frequency work.' },
  medical: { name: 'Medical / Healthcare', icon: '🏥', why: 'You can handle HIPAA-adjacent workflows (with BAA) and complex insurance contractual adjustments. Medical practices are stable, recurring clients.' },
  saas: { name: 'SaaS / Software', icon: '💻', why: 'You love technical accounting (ASC 606, deferred revenue, MRR/ARR) and tech-native founders. SaaS bookkeepers command the highest remote rates.' },
  agency: { name: 'Marketing / Creative Agency', icon: '🎨', why: 'You like project profitability work and async-first founders. Agency owners are remote-team native — easiest "yes" for hiring a remote bookkeeper.' },
  nonprofit: { name: 'Nonprofit', icon: '🤝', why: 'You like mission-driven work and fund accounting nuance. Nonprofits desperately need clean Form 990 prep and can pay $1K-$2K/month remote.' },
  trucking: { name: 'Trucking / Logistics', icon: '🚚', why: 'You like operational rhythm work (IFTA filings, fuel cards, per-mile economics) and owner-operators who need everything done because they\'re on the road.' },
  professional: { name: 'Professional Services', icon: '💼', why: 'You like time-and-billing work and helping solo consultants/engineers/architects. Predictable monthly retainer territory at $1.5K-$3K/month.' },
  startup: { name: 'Tech Startup (Pre-Revenue / Seed)', icon: '🚀', why: 'You love modern tools (Carta, Stripe, Slack) and being part of fast-growth stories. Investor-ready books are your superpower.' },
  accountingfirm: { name: 'Accounting / Tax / CFO Firm', icon: '📊', why: 'You want to scale by working with US firms as their Tier 1 production engine. This is the most strategic niche for an ambitious remote bookkeeper.' },
};
