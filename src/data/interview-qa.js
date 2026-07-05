// Interview question banks + body-language guide (InterviewPrep subtabs).
// Extracted from src/BookkeeperPro.jsx as pure data — lazy-loaded on first visit
// of the consuming tab via the useLazyData hook (see BookkeeperPro.jsx).

export const COMMON_QUESTIONS = [
  {
    q: 'Tell me about yourself.',
    why: 'This is your 90-second elevator pitch. Most candidates fumble this — yours will be tight.',
    approach: 'Use Present–Past–Future. Anchor with specific company names, months, and years. Generic = forgettable. Specific = hireable.',
    weak: `"I'm a bookkeeper based in the Philippines with several years of experience. I've worked with different clients across different industries. I'm hardworking, detail-oriented, and I love numbers. I'm passionate about helping businesses grow through clean books."`,
    weakWhy: 'Generic. Could describe anyone. No company names, no dates, no proof. The interviewer hears the same speech 50 times a week.',
    strong: `"I'm Maria — a remote bookkeeper based in Manila, currently managing month-end close for three US clients: Sunrise E-Commerce (a Shopify brand doing about $2.4M/year), Ramirez Real Estate Group (six rental properties in Texas), and Bright Path Marketing (a 12-person agency).\n\nMy most defining project was at Sunrise from March 2024 through July 2024. They came to me with 18 months of unreconciled books, no opening balances, and a tax extension running out in September. I led the cleanup solo — reconstructed bank feeds, fixed $34,000 in miscategorized expenses (most of it became legitimate tax deductions), and delivered clean books two weeks before the extension deadline. Their CPA called it the cleanest handoff she'd seen in three years.\n\nThat's what excites me about this role. You mentioned in the posting that you need someone who can own multi-entity close and catch the small stuff before the client does. That's exactly the rhythm I've built at Sunrise and Ramirez."`,
    strongWhy: 'Names a real client, exact months (March 2024 – July 2024), specific numbers ($34K, 18 months, three clients), and ties the proof directly to the job description. Uses CAR: Context (cleanup needed, deadline) → Action (led solo, reconstructed, fixed) → Result (clean handoff, deadline beat). This sounds like a person — not a resume.',
  },
  {
    q: 'Why do you want to work for us?',
    why: 'They want to know if you researched them or are mass-applying. Be specific.',
    approach: 'Mention something concrete about THEM (their website, LinkedIn post, client niche, founder). Then tie to your skills with a real example.',
    weak: `"I want to work for you because I love your company culture and I admire what you do. I've heard great things about your team and I think this would be a great opportunity for me to grow and contribute. I'm passionate about bookkeeping and I think we'd be a great fit."`,
    weakWhy: 'Could be sent to any company on Earth. Zero research evidence. "Great culture" and "passionate" are filler words.',
    strong: `"Two reasons. First, I went through your client list on your website and saw that 70% of your portfolio is real estate investors and property managers. From January 2023 through today, I've been doing the books for Ramirez Real Estate Group — six properties, trust accounting, the whole stack. That's the work I want to do more of, not less.\n\nSecond, I read your founder Jenna's post on LinkedIn from October 2025 — the one about how she trained her team to treat each rental property as a profit center using QBO classes. That's exactly how I built Ramirez's reporting in February 2024. So when I saw this role, it felt less like a job listing and more like a conversation I was already in."`,
    strongWhy: 'Names the founder, references a specific LinkedIn post with the month, cites their actual client niche, and connects to a real engagement (Ramirez, January 2023, February 2024). Proves research without bragging.',
  },
  {
    q: 'What is your greatest strength?',
    why: 'Most candidates give boring answers ("hardworking," "detail-oriented"). Stand out with one specific strength + proof.',
    approach: 'Pick ONE strength relevant to the role. Tell a CAR-style mini-story with a real company name, date, and dollar outcome.',
    weak: `"My greatest strength is attention to detail. I'm really careful with numbers and I make sure everything is accurate. I double-check my work and I'm very organized. I think this is important in bookkeeping because even small mistakes can cause big problems."`,
    weakWhy: 'Says "attention to detail" which every bookkeeper claims. No proof, no story, no outcome.',
    strong: `"Catching small numbers before they become big problems.\n\nIn August 2024, while reconciling the credit card for Sunrise E-Commerce, I noticed two charges from the same vendor — $1,247 and $1,247.50 — three days apart. The invoice numbers were one digit off but the amounts and vendor were nearly identical. Turned out the supplier had double-billed and the AP person was about to approve both.\n\nContext: monthly close was already in flight and we had 200+ transactions to process. Action: I flagged it, pulled the original PO, and emailed the supplier with both invoices side-by-side. Result: $1,247 refunded within 48 hours, and the supplier added a duplicate-billing check to their system.\n\nThat's the pattern. The pattern recognition came from my first mentor at BPI Insurance back in 2019 — she made us reconcile every account every month, no shortcuts. That training is what I trust most when something feels off."`,
    strongWhy: 'CAR structure done right. Specific date (August 2024), real company (Sunrise), exact dollar amount, real outcome. Even references an old mentor with year (BPI Insurance, 2019) to add depth. Memorable.',
  },
  {
    q: 'What is your greatest weakness?',
    why: 'Trap question. NEVER say "I work too hard." NEVER lie. Show self-awareness + fix.',
    approach: 'Pick a REAL weakness that is not core to the job. Tell what you did about it with a specific date. End on growth.',
    weak: `"My greatest weakness is that I'm a perfectionist. I sometimes spend too much time on small details. But I'm working on it by trying to balance speed and quality. I also work too hard sometimes and forget to take breaks."`,
    weakWhy: 'Two of the most overused fake-weakness answers. Interviewers literally roll their eyes at "perfectionist" and "work too hard."',
    strong: `"Public speaking on live client review calls.\n\nWhen I started doing monthly review calls for Bright Path Marketing in May 2024, I would over-prepare for two hours, then still read off notes for the first five minutes of the call. The client noticed — Mark, the founder, told me in June 2024 that I sounded more confident in emails than on Zoom.\n\nThat feedback stung but it was fair. So in July 2024, I joined a Toastmasters group online — Manila Online Speakers Club. I committed to one prepared speech a month. By November 2024, I was hosting Bright Path's monthly review without a script. I just bring three talking points and let the data tell the story.\n\nIt's still not my comfort zone. But it's no longer something I avoid — and Mark mentioned in January 2025 that my call presence is now one of the reasons he refers other agency owners to me."`,
    strongWhy: 'A real weakness (public speaking) — not a fake one. Specific timeline (May → June → July → November 2024 → January 2025) shows real growth. Names the client and the founder. Ends with proof that the fix worked.',
  },
  {
    q: 'Why are you leaving your current job? / Why are you looking?',
    why: 'NEVER badmouth past employers. Frame as moving TO something, not away from.',
    approach: 'Be honest but professional. Talk about growth, scope, or fit. Use specific dates and details.',
    weak: `"My current job is okay but I feel like I'm not growing anymore. The boss is sometimes difficult and the pay is too low. I want a better company that values me and gives me more opportunities."`,
    weakWhy: 'Badmouths the current employer ("boss is difficult", "pay is too low"). Red flag for the interviewer — if you talk this way about your current boss, you will talk this way about theirs.',
    strong: `"My current role at TaskCo BPO has been great for two years — I started there in September 2023 doing data entry, and by January 2025 I was managing the books for three small SMB clients independently. I learned QBO, I learned the rhythm of monthly close, I learned how to manage multiple clients without dropping balls.\n\nBut I've hit the ceiling of what I can learn here. All three clients are small, single-entity, cash-basis. I want to stretch into multi-entity work, accrual basis, and a team where there are senior people I can learn from.\n\nWhen I read your job posting last week, the part about 'team-based engagements with mentorship' was the exact line that made me apply. That's what I'm moving toward — not away from anything."`,
    strongWhy: 'Specific employer name (TaskCo BPO), exact dates (September 2023, January 2025), positive framing of past work, clear "moving toward" language tied to the actual JD.',
  },
  {
    q: 'Where do you see yourself in 5 years?',
    why: 'They are testing ambition AND commitment. Do not say "your job." Do not say "running my own firm" if applying to a firm.',
    approach: 'Show you have thought about it. Tie growth to their kind of company, not away from it.',
    weak: `"In 5 years I see myself in a more senior role with more responsibilities. Hopefully earning more and growing in my career. Maybe leading a team or running my own bookkeeping firm someday."`,
    weakWhy: '"Running my own firm" when applying to a firm = "I will leave you the moment I can." Vague otherwise. No depth.',
    strong: `"By 2030 I want to be the lead bookkeeper on your most complex engagements — the cleanups, the multi-entity work, the clients other people would be intimidated by.\n\nSpecifically: I want my QuickBooks Advanced Certification done by end of 2026 — I'm halfway through the modules already. By 2027 I want to add Xero certification because I noticed three of your clients in your portfolio use it. By 2028 I want to have led at least one full cleanup or migration project end-to-end on a team.\n\nI'm not interested in starting my own firm. I want depth, not breadth. I want to be the expert on a team — the person clients ask for by name."`,
    strongWhy: 'Concrete timeline (2026, 2027, 2028, 2030). Specific certifications. Mentions doing research on their client base (Xero). Closes with the "no I am not your future competitor" line that hiring managers love.',
  },
  {
    q: 'Tell me about a time you made a mistake.',
    why: 'They want to see ownership and learning, not excuses.',
    approach: 'Use CAR. Take full responsibility. Show what you learned and the system fix you put in place.',
    weak: `"I once made a mistake at work but I quickly fixed it. I learned from it and now I am more careful. Mistakes happen but the important thing is to learn from them and move forward."`,
    weakWhy: 'No story, no specifics, no accountability. Reads as evasive — interviewer feels the candidate is hiding something.',
    strong: `"April 2024, my second month with Sunrise E-Commerce.\n\nContext: The client received a $4,200 refund from a returned wholesale order. I categorized it as 'Other Income' instead of as a refund against Sales — overstated their revenue for the quarter.\n\nAction: I caught it during the bank rec the following week when the numbers didn't tie. I emailed the founder, Elena, that same evening — told her exactly what happened, walked her through the impact, and showed her the correcting journal entry I was about to post. I also built a personal checklist: any transaction over $1,000 gets flagged for a second review before posting.\n\nResult: We refiled the corrected Q2 numbers with her CPA before the deadline. Elena thanked me for the same-day flag — she said most of her past bookkeepers would have hidden it. And the $1K-review rule I built that day is still part of my workflow today.\n\nWhat I learned: mistakes aren't the problem. Hiding them is. And the best fix is always a system, not just willpower."`,
    strongWhy: 'Real CAR structure. Names the client (Sunrise), founder (Elena), exact month (April 2024), exact dollar amount ($4,200), exact rule built ($1K review). Closes with a one-line lesson. This is a textbook strong answer.',
  },
  {
    q: 'Tell me about a difficult client situation.',
    why: 'They want to see emotional intelligence and problem-solving.',
    approach: 'CAR method. Show empathy, communication, and resolution. Never blame the client.',
    weak: `"I had a difficult client who never sent receipts on time. He was always angry and rude. I tried my best but it was very stressful. Eventually I just had to be patient and keep reminding him."`,
    weakWhy: 'Blames the client ("angry and rude"). Shows no real solution — "patience" is not a system. Sounds passive.',
    strong: `"James, the owner at Ramirez Real Estate, from February 2024 through April 2024.\n\nContext: Six rental properties, receipts arriving 6-8 weeks late, then James would get frustrated when his books weren't current. By the end of March 2024, I'd reconciled what I could but two properties were 90 days behind.\n\nAction: I realized James wasn't being difficult — he was overwhelmed running six properties solo. So I built him a simple workflow. Set up a shared Google Drive folder where he could just photograph receipts on his phone and drop them in. Recorded a 4-minute Loom video walking through it. Scheduled a 15-minute weekly Friday check-in instead of waiting for month-end.\n\nResult: By May 2024, receipts were coming in within 48 hours. Books stayed current. In June 2024, James referred his real estate partner to me. The fix wasn't a stricter policy — it was making it easier for him to win."`,
    strongWhy: 'Names the client (James, Ramirez Real Estate), specific months (Feb-April 2024, May 2024, June 2024). The narrative arc is compelling: empathy → system → result → referral.',
  },
  {
    q: 'How do you handle deadlines and pressure?',
    why: 'Bookkeeping is deadline-driven. They want proof you can deliver under pressure.',
    approach: 'Show a SYSTEM, not just hustle. Reference a specific high-pressure month.',
    weak: `"I work well under pressure. I'm able to prioritize and stay calm. When things are stressful I just focus and get the work done. Deadlines motivate me to perform better."`,
    weakWhy: 'Pure cliché. Every candidate says "I work well under pressure." Zero proof.',
    strong: `"I work backwards from the deadline.\n\nFor month-end close at Sunrise E-Commerce, the deadline is the 10th. So by the 5th, all bank feeds are categorized. By the 7th, reconciliations are done. By the 9th, I've reviewed everything one more time. That gives me one buffer day.\n\nThe real test was January 2025 — year-end close for all three of my clients hit at the same time, and Sunrise added a surprise cleanup of October-December 2024 because their previous bookkeeper had left. Three closes, one cleanup, fifteen days.\n\nWhat I did: I told all three clients on January 2nd which week each of them would get my focus. Sunrise's cleanup got the first week, Bright Path's standard close got week two, Ramirez's multi-entity close got week three. Nobody got bumped. Nobody got late.\n\nWhen pressure spikes, I don't work later — I re-prioritize and communicate early. Communication is what keeps pressure manageable."`,
    strongWhy: 'Specific company (Sunrise), specific month (January 2025), real scenario (year-end + cleanup), and a clear SYSTEM (backwards scheduling, week-by-week assignment, early communication).',
  },
  {
    q: 'How do you handle constructive criticism / feedback?',
    why: 'They want to know you are coachable.',
    approach: 'Show you welcome it. Give a specific example with date + the improvement that followed.',
    weak: `"I welcome feedback. I think it's important to keep learning. I always try to apply feedback to improve myself and become better at my job."`,
    weakWhy: 'Says all the right words but proves nothing. No example = the interviewer assumes you actually can\'t take feedback.',
    strong: `"Honestly? I crave it.\n\nIn September 2024, my supervisor at TaskCo — her name is Karen — told me my client emails were too long. Clients were skimming and missing the key questions.\n\nThat stung at first because I prided myself on being thorough. But she was right. I went back through my last 10 sent emails and counted the response rates — about 60%.\n\nThe next week I rewrote my email format using the BLUF method: Bottom Line Up Front. Subject line states the action needed. First sentence is the ask. Details follow. Three bullet points max.\n\nBy November 2024, response rate on the same type of email had jumped to over 95%. Karen flagged it in my year-end review.\n\nFeedback that specific is rare. So when I get it, I act on it the same week."`,
    strongWhy: 'Names the supervisor (Karen), specific months (September → November 2024), measurable outcome (60% → 95%). Shows the candidate took the feedback as a system change, not a personality change.',
  },
  {
    q: 'Do you have any questions for us?',
    why: 'NEVER say no. This is your chance to look engaged and qualified.',
    approach: 'Ask 2-3 thoughtful questions. Avoid pay/benefits in the first interview.',
    weak: `"No, I think you covered everything. I'm just excited about the opportunity."`,
    weakWhy: '"I have no questions" tells the interviewer you are not actually thinking critically about the role. It signals "I will take any job."',
    strong: `"Three quick ones.\n\nFirst — what does the first 90 days look like for someone in this role? Is there a structured onboarding, or do I dive in with a client right away?\n\nSecond — what does success look like at the 6-month mark? If we were sitting here in May 2026 doing a review, what would I have done or delivered that would make this hire a clear win for you?\n\nThird — what's the biggest challenge the person who held this role before me ran into? I'd rather know now than find out in month two.\n\nAnd if I can squeeze in a fourth — when do you expect to make a decision? I want to be respectful of your timeline."`,
    strongWhy: 'Three smart, specific questions that signal seriousness. The "May 2026 review" line is a power move — it gets the interviewer mentally placing you in the role.',
  },
  {
    q: 'Why should we hire you?',
    why: 'The closer. Sum up your value in 60 seconds.',
    approach: 'Pick 3 specific things from the job description and tie each to a proof point with company name + date.',
    weak: `"You should hire me because I'm hardworking, dedicated, and I have the right skills for this job. I'm a fast learner and I work well in a team. I would bring value to your company and I'd love the opportunity."`,
    weakWhy: 'Generic adjectives ("hardworking, dedicated, fast learner") with no proof. The interviewer hears this 20 times a week.',
    strong: `"Three reasons.\n\nOne — you said in the JD you need someone who can own multi-entity close. From February 2024 through today, I've been doing exactly that for Ramirez Real Estate — six properties, each tracked as its own class in QBO, with consolidated and per-property statements every month. Never missed a close.\n\nTwo — you need someone comfortable with cleanups. March 2024 through July 2024, I led Sunrise E-Commerce's 18-month cleanup solo. Found $34,000 in miscategorized expenses, delivered books two weeks ahead of their tax extension deadline.\n\nThree — you want someone who communicates proactively, not reactively. My clients hear from me before they need to ask. Last month — October 2025 — I caught a $1,247 duplicate vendor payment at Sunrise before the AP person approved it. That's the rhythm I'd bring to your team.\n\nThe rest — software fluency, attention to detail, US tax basics — that's table stakes. Those three things are what would make me valuable specifically to your team."`,
    strongWhy: 'Three JD-matched proof points, each with a real company name, specific dates (Feb 2024 onward, March-July 2024, October 2025), and concrete numbers ($34K, $1,247, 18 months). The "table stakes" line is psychologically powerful — it positions the candidate as already past the basics.',
  },
];

export const ACCOUNTING_QUESTIONS = [
  { q: 'What are the three main financial statements?', a: 'Income Statement (P&L) — shows revenue and expenses over a period. Balance Sheet — shows assets, liabilities, and equity at a point in time. Statement of Cash Flows — shows cash movement across operating, investing, and financing activities.' },
  { q: 'What is the accounting equation?', a: 'Assets = Liabilities + Equity. This is the foundation of double-entry bookkeeping. Every transaction must keep this equation in balance.' },
  { q: 'What is the difference between cash basis and accrual basis accounting?', a: 'Cash basis: revenue recorded when cash is received, expenses when paid. Simple but doesn\'t show true profitability. Accrual basis: revenue recorded when earned, expenses when incurred — required by GAAP and gives a more accurate picture. Most small businesses use cash basis for tax, accrual for management reporting.' },
  { q: 'What is a journal entry? Walk me through one.', a: 'A journal entry is a record of a transaction with at least one debit and one credit. Example: Client pays a $500 utility bill from checking — Debit Utilities Expense $500, Credit Cash $500. Total debits must always equal total credits.' },
  { q: 'How do you reconcile a bank account?', a: 'I start with the ending balance per QBO, then compare every transaction to the bank statement. I check off matching items, add anything on the statement not in QBO (bank fees, interest), and investigate anything in QBO not yet cleared. Final QBO balance + outstanding deposits − outstanding checks should equal bank statement balance. I never force-balance with adjustments.' },
  { q: 'What is Undeposited Funds?', a: 'In QBO, Undeposited Funds is a holding account for customer payments received but not yet deposited to the bank. It lets you group multiple payments into a single deposit that matches what hits the bank. Critical to clear it monthly — when payments pile up there unmatched, it signals broken workflow.' },
  { q: 'What is the difference between Accounts Receivable and Accounts Payable?', a: 'A/R is money customers OWE you for invoices you sent but haven\'t collected. It\'s an asset. A/P is money YOU OWE vendors for bills you received but haven\'t paid. It\'s a liability.' },
  { q: 'How do you handle depreciation?', a: 'Depreciation spreads the cost of a fixed asset over its useful life. Common methods: Straight-Line (equal yearly amount), Double-Declining Balance (accelerated), MACRS (US tax standard). Monthly entry: Debit Depreciation Expense, Credit Accumulated Depreciation. The tax preparer usually handles MACRS; book depreciation often uses Straight-Line.' },
  { q: 'What is a chart of accounts?', a: 'The full list of accounts a business uses to record transactions, organized by type (Assets, Liabilities, Equity, Income, Expenses) and usually numbered. A clean Chart of Accounts is the foundation of clean books — too few accounts and you can\'t see anything, too many and reports become noise.' },
  { q: 'What is the difference between an expense and a cost of goods sold (COGS)?', a: 'COGS is the direct cost of producing or delivering what was sold — materials, direct labor, freight. It reduces Gross Profit. Operating Expenses are indirect costs to run the business — rent, software, admin payroll. They reduce Operating Income. The distinction matters because Gross Margin is a key health metric, and COGS misclassification distorts it.' },
  { q: 'What is deferred revenue?', a: 'Deferred Revenue is cash received before the work is done or product delivered. It\'s a LIABILITY, not income, until earned. Example: a client prepays $12,000 for a 12-month SaaS subscription. Initially: Debit Cash $12K, Credit Deferred Revenue $12K. Each month: Debit Deferred Revenue $1K, Credit Revenue $1K.' },
  { q: 'How would you handle a transaction you\'re not sure how to categorize?', a: 'First, I check if the client has a similar past transaction I can model from. If not, I ask the client directly — usually a quick screenshot and one question. If I still can\'t determine the right account, I post to a clearly-named holding account like "Ask My Accountant" or "Uncategorized — Review" and flag it for review. I never guess on transactions over $100.' },
  { q: 'What\'s the difference between debits and credits?', a: 'They\'re directional entries that keep the accounting equation in balance. Debits INCREASE Assets, Expenses, and Owner Draws. Credits INCREASE Liabilities, Equity, Income, and Capital. Mnemonic: DEAD CLIC. Every transaction has at least one debit and one credit, and they must always equal.' },
  { q: 'What is the matching principle?', a: 'A GAAP rule that says expenses should be recorded in the same period as the revenue they helped generate. Example: if you sell a product in December but pay the supplier in January, you record both in December under accrual accounting. This produces accurate period profitability.' },
  { q: 'How do you handle a credit card reconciliation?', a: 'Same process as a bank rec — match every transaction to the statement, check for missing items, reconcile to the ending balance. Critical extra step: confirm any annual fees, finance charges, or interest are captured. I reconcile credit cards monthly without fail because they\'re a common source of duplicate expense booking when not maintained.' },
  { q: 'Walk me through how you would clean up a messy QBO file.', a: 'Step 1: Diagnostic — review Chart of Accounts, run all-time P&L and Balance Sheet, identify red flags (negative balances on assets, uncategorized expenses, unreconciled accounts). Step 2: Establish a clear "starting point" date with the client. Step 3: Reconcile bank and credit card accounts month by month from oldest. Step 4: Fix mis-categorized transactions in batches. Step 5: Clean up A/R and A/P aging. Step 6: Adjust opening balances if needed. Step 7: Document everything in a cleanup report for the client.' },
];

export const BODY_LANGUAGE_TIPS = [
  {
    category: 'Camera & Setup (the foundation)',
    icon: '📹',
    tips: [
      { tip: 'Camera at eye level', detail: 'Stack books or a laptop stand. If they\'re looking down at you, you look small. If they\'re looking up, you look intimidating. Eye level = peer level.' },
      { tip: 'Light from in front, not behind', detail: 'A window behind you turns you into a silhouette. Face a window or use a ring light. Soft, natural light is best.' },
      { tip: 'Clean, neutral background', detail: 'Plain wall, bookshelf, or a tidy room. NEVER an unmade bed, kitchen mess, or busy clutter. Background is part of your first impression.' },
      { tip: 'Use a wired internet connection', detail: 'WiFi drops mid-sentence kill momentum. Plug in an ethernet cable for interview day. Test your connection 30 minutes before.' },
      { tip: 'Microphone close to your mouth', detail: 'Built-in laptop mics sound thin and distant. A simple lapel mic or headset mic ($20) changes how authoritative you sound.' },
    ]
  },
  {
    category: 'Posture & Energy',
    icon: '🧍',
    tips: [
      { tip: 'Sit up straight, shoulders back', detail: 'Confident posture changes your voice. Try it now: slouch and say "I\'m confident." Then sit up tall and say it. Hear the difference?' },
      { tip: 'Lean slightly forward when listening', detail: 'It signals engagement. Don\'t hunch — just an inch or two forward when they\'re speaking. Lean back slightly when you\'re answering.' },
      { tip: 'Feet flat on the floor', detail: 'Crossing your legs makes you slouch and fidget. Both feet planted = stable, grounded energy that comes through on camera.' },
      { tip: 'Smile genuinely at the start and end', detail: 'You don\'t need to grin through the whole interview, but smile when you greet and when you say goodbye. It anchors you as warm and approachable.' },
      { tip: 'Match their energy level — then add 10%', detail: 'If they\'re calm and analytical, don\'t come in like a sales rep. If they\'re upbeat, match it. Always be slightly MORE energetic than them — never less.' },
    ]
  },
  {
    category: 'Eye Contact (the #1 secret)',
    icon: '👁️',
    tips: [
      { tip: 'Look at the CAMERA when speaking, not at their face', detail: 'When you look at their face on screen, it looks like you\'re looking down to them. Look at the camera lens — to them, that IS eye contact.' },
      { tip: 'Put a sticky note next to your camera', detail: 'Write the interviewer\'s name on a sticky note next to your camera. Glance at it before each answer. It reminds you to look at the lens AND personalizes your speech.' },
      { tip: 'Look at their face when LISTENING', detail: 'Eye contact while they speak shows you\'re engaged. Eye contact at the camera when YOU speak shows you\'re confident.' },
      { tip: 'Don\'t stare at yourself', detail: 'It\'s tempting to look at your own video feed. Hide it. Go into your video settings and hide your own preview. You\'ll instantly appear more present.' },
    ]
  },
  {
    category: 'Hands & Gestures',
    icon: '🙌',
    tips: [
      { tip: 'Keep hands visible, not under the desk', detail: 'Hidden hands subconsciously read as hidden intentions. Keep them in frame when gesturing — but don\'t wave them wildly.' },
      { tip: 'Open palm gestures', detail: 'Open palms = honesty and openness. Pointing fingers, fists, or chopping motions feel aggressive on camera. Use open palms when emphasizing.' },
      { tip: 'Don\'t touch your face', detail: 'Touching your face — especially your mouth or nose — reads as nervousness or deception. Keep hands away from your face.' },
      { tip: 'Pause your gestures when not making a point', detail: 'Constant movement is distracting. Use gestures to emphasize key words, then let your hands rest. Stillness = confidence.' },
    ]
  },
  {
    category: 'Voice & Pace',
    icon: '🎙️',
    tips: [
      { tip: 'Slow down 20% more than feels natural', detail: 'When nervous, we speed up. Your natural pace already feels slow when nervous — so consciously slow down even further. Pauses make you sound confident, not unsure.' },
      { tip: 'Use 1-2 second pauses BEFORE answering', detail: 'It\'s tempting to jump right in. Don\'t. Take a beat. It signals thoughtfulness and gives you time to structure your answer.' },
      { tip: 'Vary your tone — don\'t monotone', detail: 'Upspeak (ending every sentence going UP) makes you sound unsure. Downspeak (ending DOWN) sounds authoritative. Mix it up but lean toward downspeak at the end of statements.' },
      { tip: 'Lower your voice slightly when stating credentials', detail: 'When you say "I\'ve managed three QuickBooks Online clients for two years," drop your tone slightly. It signals certainty.' },
    ]
  },
  {
    category: 'Common Mistakes to Avoid',
    icon: '🚫',
    tips: [
      { tip: 'Don\'t apologize for your accent', detail: 'NEVER say "sorry for my English." It primes them to hear flaws. Own your voice. If they don\'t understand a word, they\'ll ask.' },
      { tip: 'Don\'t over-apologize generally', detail: 'Filipinos especially over-apologize. Replace "I\'m sorry" with "Thank you for clarifying" or "Let me rephrase that."' },
      { tip: 'Don\'t fidget with pens, jewelry, hair, or chairs', detail: 'Swivel chairs are the enemy. Use a stable chair. Move pens off camera before starting.' },
      { tip: 'Don\'t read off notes', detail: 'It\'s obvious on camera. Keep one sticky note with 3-4 keywords if you need them — never a script. They want a conversation, not a recital.' },
      { tip: 'Don\'t end early', detail: 'Always end an answer with intent. Avoid trailing off with "yeah, so..." or "I think that\'s it." End with a clean stop. Confident silence beats nervous filler.' },
    ]
  },
];
