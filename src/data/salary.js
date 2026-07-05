// Salary negotiation tactics + scripts (SalaryNegotiation subtab).
// Extracted from src/BookkeeperPro.jsx as pure data — lazy-loaded on first visit
// of the consuming tab via the useLazyData hook (see BookkeeperPro.jsx).

export const SALARY_TACTICS = [
  {
    phase: 'Before the Interview',
    icon: '🎯',
    tips: [
      { tip: 'Research market rates for YOUR specific role', detail: 'US bookkeepers earn $18-$45/hr. Filipino remote bookkeepers serving US clients earn $6-$25/hr. AI-fluent bookkeepers command $15-$30/hr. Know your tier before walking in.' },
      { tip: 'Define your three numbers', detail: 'Walkaway (the lowest you accept), Target (your honest goal), Anchor (your stated ask — 20-30% above target). NEVER reveal your walkaway.' },
      { tip: 'Calculate your value in dollars saved/earned', detail: 'A client who pays you $1,500/month should see at least $5,000/month in value back (tax savings caught, hours freed, cash flow visibility). Quantify yours before negotiating.' },
      { tip: 'Have a competing option ready (even a soft one)', detail: 'Having ANY alternative shifts your psychology from desperate to confident. It doesn\'t need to be a firm offer — could just be an active conversation with another firm.' },
    ]
  },
  {
    phase: 'When They Ask "What Are You Looking For?"',
    icon: '💬',
    tips: [
      { tip: 'NEVER name a number first', detail: 'Whoever names a number first loses negotiation leverage. Deflect: "I\'d love to understand the role better first — what does your budget look like for someone with my experience?"' },
      { tip: 'If forced, give a range — and start HIGH', detail: 'If they insist, give a range where your TARGET is at the BOTTOM. Example: target $15/hr → say "$18-$25/hr depending on scope." Anchoring high reframes the negotiation.' },
      { tip: 'Use the "based on my research" framing', detail: '"Based on what I\'ve seen for similar remote bookkeeping roles serving US clients with QuickBooks expertise, I\'d expect this role to land in the $20-$28/hr range." This sounds researched, not greedy.' },
      { tip: 'Never apologize for your number', detail: 'After stating a number, SHUT UP. Silence is your friend. Don\'t fill space with "but I\'m flexible" or "I know that\'s high." Let the number breathe.' },
    ]
  },
  {
    phase: 'When They Make an Offer',
    icon: '📊',
    tips: [
      { tip: 'Always counter — even if it sounds good', detail: 'Studies show 84% of employers expect a counter. Not countering signals lack of confidence. Even adding 10-15% is normal and expected.' },
      { tip: 'Use the "Hmm... pause" technique', detail: 'When they state a number, just pause and say "Hmm. That\'s a bit below what I was targeting." Watch what happens — most employers will immediately ask "what were you targeting?" That\'s when you anchor higher.' },
      { tip: 'Counter with a specific reason, not just a number', detail: '"I was hoping for $22/hr. Here\'s why: I have 3 active US clients, hold QBO ProAdvisor certification, and can handle the multi-entity work in your JD without ramp-up time."' },
      { tip: 'Negotiate the WHOLE package, not just rate', detail: 'If they can\'t move on rate, ask for: PTO, annual rate increases (5-10%/year guaranteed), training budget, equipment stipend, performance bonuses, faster review cycles.' },
    ]
  },
  {
    phase: 'Handling Pushback',
    icon: '🛡️',
    tips: [
      { tip: '"That\'s the highest we can offer" → push gently', detail: '"I appreciate that. Is there any flexibility on a sign-on bonus, faster first review, or a performance bonus structure?" Always probe the wall before accepting it.' },
      { tip: '"We have other candidates" → calmly affirm your value', detail: '"That makes sense — I\'m sure they\'re strong. What I bring is X, Y, and Z. If those are the gaps you\'re trying to fill, I\'m worth the conversation."' },
      { tip: '"We need an answer today" → buy 24-48 hours', detail: '"This is a big decision and I want to give you a thoughtful yes. Can I confirm by tomorrow EOD?" 99% of employers will say yes. Pressure tactics signal desperation on THEIR side, not yours.' },
      { tip: 'Never threaten or ultimatum', detail: 'Threats burn bridges and rarely work. Replace "I\'ll walk if not..." with "I\'d really love to make this work. Help me understand what flexibility exists."' },
    ]
  },
  {
    phase: 'Annual Raises & Rate Reviews',
    icon: '📈',
    tips: [
      { tip: 'Lock in annual review in the engagement letter', detail: 'Build it in upfront: "Rate reviewed annually on engagement anniversary." This makes raises a default, not a confrontation.' },
      { tip: 'Document wins all year long', detail: 'Keep a running "Wins Doc" — every catch, every cleanup, every late-night save. When raise season comes, you have receipts.' },
      { tip: 'Ask for 8-12% per year minimum', detail: 'Inflation alone runs 3-4%. A "performance" raise must be on TOP of inflation. Aiming for 8-12% nets you 4-8% real growth. Below 5% is going backward.' },
      { tip: 'Tie raises to client-side wins', detail: '"Your revenue grew 22% this year. I caught $14K in misclassified expenses that became deductions. The market rate for this work is now $22-$28/hr. Let\'s land at $24."' },
    ]
  },
];

export const SALARY_SCRIPTS = [
  {
    scenario: 'When asked "What\'s your expected salary?" in the first interview',
    response: `"That's a great question. I want to make sure I'm giving you a thoughtful answer, so let me ask first — what does the budget look like for this role given the scope and experience level you're targeting?"

If they push: "Based on what I've seen for remote bookkeeping roles with multi-entity QBO experience, I'd expect this to land in the $20-$28/hr range — but I'm open to discussing once I understand the full scope better."`
  },
  {
    scenario: 'When you receive a written offer below your target',
    response: `"Thank you for the offer — I'm genuinely excited about the role.

I want to be transparent: I was targeting closer to $24/hr based on three things. First, I currently manage [X] US clients with similar scope. Second, my QBO ProAdvisor certification means zero ramp-up time. Third, the multi-entity work in this role is exactly where my last two cleanups added the most value.

Is there room to move toward $24, or could we structure a 6-month review where we revisit based on early wins?"`
  },
  {
    scenario: 'When they say "We can\'t go higher" but you want to push',
    response: `"I hear you, and I appreciate the transparency on the rate ceiling.

If the base rate is locked, can we explore: a guaranteed annual increase of 8% built into the engagement letter, a $500 sign-on for equipment, or quarterly bonus tied to retention of my book of clients?

I'd love to find a structure that works for both of us."`
  },
  {
    scenario: 'Asking for a raise after 12 months',
    response: `"Hi [Client] — I want to talk through the annual review we built into our engagement.

Quick recap of the year: I closed every month on time, caught $X in misclassified expenses, brought your A/R aging from [X] days down to [Y], and added [project/system] to the workflow.

The market rate for the work I'm doing has moved to $22-$26/hr. I'd like to land at $24/hr going forward — that's an 8% increase from where we started, plus a 5% performance bump on top.

Open to a quick call this week to align?"`
  },
];
