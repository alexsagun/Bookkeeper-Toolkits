// Difficult-client scenario playbooks (DifficultClientPlaybook).
// Extracted from src/BookkeeperPro.jsx as pure data — lazy-loaded on first visit
// of the consuming tab via the useLazyData hook (see BookkeeperPro.jsx).

export const DIFFICULT_SCENARIOS = [
  {
    id: 'late-payer',
    title: 'Chronically Late Payer',
    icon: '💸',
    signs: ['Invoices regularly 30+ days overdue', 'Excuses repeatedly', 'Promises payment then doesn\'t deliver', 'Asks for "just one more week"'],
    decision: 'Salvage IF: total relationship is profitable, communication is otherwise healthy, willing to switch to auto-pay or upfront retainer. Fire IF: 3+ months late, ignoring dunning emails, total receivable > 1 month of fees.',
    salvageSteps: [
      'Send firm but kind dunning email: "Hi [Name], invoice #X is now 30 days past due. Per our engagement letter, work pauses on day 45. Can you process payment this week, or share when I can expect it?"',
      'Propose switch to auto-pay (Stripe ACH, $0.25 fee absorbed by you) or upfront retainer (next 3 months pre-paid)',
      'If salvageable: send updated engagement letter with payment terms enforced (late fee 1.5%/mo, work pause day 45, termination day 60)',
      'Document EVERY late instance in your records',
    ],
    fireSteps: [
      'Send 30-day termination notice via email (not Slack/text)',
      'Reference specific incidents and the engagement letter terms violated',
      'Offer to deliver final work product upon receipt of outstanding balance',
      'Be professional, no anger. "Effective [date+30], I will be transitioning the engagement. I can deliver your QBO file, working papers, and final P&L upon payment of outstanding balance of $X."',
    ],
    emailTemplate: `Subject: Outstanding Invoice + Engagement Update

Hi [First Name],

I wanted to reach out about Invoice #[X] (issued [date], totaling $[amount]). It's now [days] past due, and per our engagement letter, work pauses on day 45 of any past-due invoice.

I'd love to keep our engagement on track. Can we either:
1. Process payment this week, OR
2. Switch to auto-pay (Stripe ACH) going forward so this doesn't happen again

Let me know which works for you by [date]. Happy to jump on a quick call if helpful.

Thanks,
[Your Name]`,
  },
  {
    id: 'scope-creeper',
    title: 'Scope Creeper',
    icon: '📋',
    signs: ['"Quick question" turns into 2 hours of work', 'Sends financial requests outside agreed scope', '"Can you also handle the..."', 'No additional fee discussed'],
    decision: 'Salvage IF: client is responsive, profitable overall, willing to negotiate scope formally. Fire IF: scope creep is constant despite multiple resets, owner doesn\'t respect your time, you\'re losing money.',
    salvageSteps: [
      'Run a scope audit: list every recurring task you do. Compare against engagement letter.',
      'Schedule a 30-min "engagement review" call (not a "we need to talk" call)',
      'Frame as: "I want to make sure we\'re still aligned. Here\'s what I\'m delivering today vs what we agreed to in the original SOW."',
      'Propose: (1) new fee that includes current scope, OR (2) trim back to original scope, OR (3) add-on rates for additional work',
      'Send updated engagement letter within 48 hours of the call',
    ],
    fireSteps: [
      'If they refuse to formalize the new scope: 30-day notice',
      'Use this language: "I\'ve enjoyed working together, but the scope of work has grown beyond what I can sustainably deliver at our current arrangement. Rather than continue to underserve you, I\'m giving 30 days notice."',
    ],
    emailTemplate: `Subject: Engagement Scope Review

Hi [First Name],

I'd love to schedule a 30-minute call this week or next to review our engagement.

When we started together [months] ago, we scoped X, Y, Z. Over time, the work has naturally expanded to include A, B, C as well. I want to make sure we're properly aligned and that I'm able to deliver at the level you deserve.

I have three options to discuss:
1. Update the engagement to reflect current scope (with a fee adjustment)
2. Refocus back to the original SOW
3. Set up a hybrid: monthly fee for core scope + project-based for additional work

When works for a 30-min call?

Best,
[Your Name]`,
  },
  {
    id: 'abusive-comm',
    title: 'Abusive Communication',
    icon: '🚨',
    signs: ['Rude or condescending messages', 'Yells / capitalizes / uses harsh language', 'Demands work outside business hours', 'Disrespects your culture or location', 'Threatens to leave bad reviews'],
    decision: 'FIRE — almost always. Salvage ONLY if it was a single bad day, they apologized, and it\'s a high-value long-term client. Otherwise: this is non-negotiable.',
    salvageSteps: [
      'Schedule a call (not text/Slack — voice is required for this)',
      'Be calm but firm: "I want to address how communication has been recently. I value our work together, but [specific examples] aren\'t how I work with any client. I need us to reset on tone."',
      'Listen to their response. If they apologize and own it: continue with clear terms.',
      'Document the conversation in email summary.',
      'One-strike policy: any future incidents = immediate termination, no notice required.',
    ],
    fireSteps: [
      'Don\'t respond to the abusive message immediately. Wait 24 hours.',
      'Send termination email: "After consideration, I\'ve decided to end our engagement effective [date+30, or immediately if severe]. The communication on [date] doesn\'t align with how I work with clients."',
      'Block them on all personal channels. Keep business email only for transition.',
      'Deliver final work product cleanly. Don\'t respond to anger or guilt-trips.',
      'You don\'t owe an explanation beyond this.',
    ],
    emailTemplate: `Subject: Ending Our Engagement

[First Name],

After careful consideration, I've decided to end our engagement effective [date+30 days, or "immediately" if severe].

The communication on [specific date] is not how I work with clients, and I don't think continuing is the right fit for either of us.

I will deliver:
- Final reconciled QBO file through [date]
- Working papers and reconciliations
- Final P&L and Balance Sheet
- 30-min transition call to your new bookkeeper (if desired)

I wish you the best with your business.

[Your Name]`,
  },
  {
    id: 'ghosting',
    title: 'Client Ghosting You',
    icon: '👻',
    signs: ['No response for 2+ weeks despite multiple follow-ups', 'Reads messages but doesn\'t reply', 'Cancels calls last-minute repeatedly', 'Missing data requests pile up'],
    decision: 'Salvage IF: pays on time, just busy/disorganized, you can do most work without their input. Fire IF: payment also stops, work product can\'t be delivered without them, they\'ve gone fully silent for 30+ days.',
    salvageSteps: [
      'Try a different channel: if email is silent, try a text or Loom video',
      'Make the ask SPECIFIC and easy: instead of "send me your receipts" try "send me a photo of your AmEx December statement — that\'s all I need to close the month"',
      'Send a "I noticed" email: "Hi [Name], I haven\'t heard from you in 3 weeks. I want to make sure everything\'s okay. Is there something blocking our work together?"',
      'Offer to simplify: "Would you prefer I pause monthly close and just keep books rolling forward until you have bandwidth?"',
      'Send a Loom video — easier to consume than long emails',
    ],
    fireSteps: [
      '30-day notice email: "I haven\'t been able to reach you in [X] weeks. I\'m unable to deliver the level of service you\'re paying for without your input."',
      'Set a firm response deadline in the notice email',
      'If still no response: send final invoice + termination summary on day 30',
      'Keep records of every outreach attempt',
    ],
    emailTemplate: `Subject: Checking In + Path Forward

Hi [First Name],

I wanted to reach out — I haven't heard from you in [X] weeks, and I have a few items that need your input to close out [month].

Specifically, I need:
- [One small specific item]
- [One small specific item]
- [One small specific item]

If life is busy, I totally get it — would you prefer I pause monthly close and just keep books rolling forward until you have bandwidth? That way you're not paying for work you can't make use of.

Can you let me know by [Friday]? If I don't hear back, I'll assume we're pausing and follow up next month.

Best,
[Your Name]`,
  },
];
