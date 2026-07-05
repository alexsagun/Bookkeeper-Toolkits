// Authentic-branding deep-dive questionnaire (AuthenticBranding).
// Extracted from src/BookkeeperPro.jsx as pure data — lazy-loaded on first visit
// of the consuming tab via the useLazyData hook (see BookkeeperPro.jsx).

export const BRANDING_QUESTIONS = [
  { section: 'Childhood', icon: '🧒', items: [
    { id: 'c1', q: 'As a child, what activity could you do for hours without getting bored or tired?', hint: 'This often reveals your natural energy source.' },
    { id: 'c2', q: 'What did teachers, parents, or relatives most often praise you for?', hint: 'Patterns of praise reveal innate strengths others have seen in you for years.' },
    { id: 'c3', q: 'When you got in trouble as a kid, what was it usually for?', hint: 'Your "flaws" often hide your strengths in disguise.' },
    { id: 'c4', q: 'Was there a moment in childhood where you felt deeply proud of yourself? What was it?', hint: 'This memory is often a core value still driving you today.' },
    { id: 'c5', q: 'What was your role in your family? (Peacemaker, achiever, caretaker, problem-solver, rebel, etc.)', hint: 'These early family roles often become professional patterns.' },
  ]},
  { section: 'School Life', icon: '🎓', items: [
    { id: 's1', q: 'Which subjects came easily to you that seemed hard for others?', hint: 'Effortless skill is the truest measure of natural strength.' },
    { id: 's2', q: 'Which group projects or moments at school did you enjoy MOST? What was your role?', hint: 'Your favorite role in a team is the role you should look for in your career.' },
    { id: 's3', q: 'When did you feel most confident in school? What were you doing?', hint: 'Confidence patterns reveal your authentic zone of contribution.' },
    { id: 's4', q: 'When did you feel out of place or "not enough" in school? What was the situation?', hint: 'These moments often shape limiting beliefs — knowing them helps you separate truth from old story.' },
    { id: 's5', q: 'Who was the teacher or mentor who saw something in you others did not? What did they see?', hint: 'They often saw a true strength before you could name it yourself.' },
  ]},
  { section: 'Past Work Experience', icon: '💼', items: [
    { id: 'w1', q: 'In your work history, what is the project or accomplishment you are MOST proud of? Why?', hint: 'The "why" matters more than the "what." It reveals your driver.' },
    { id: 'w2', q: 'What kind of tasks energize you at work? You lose track of time doing them.', hint: 'These are your "flow state" activities — your core professional brand.' },
    { id: 'w3', q: 'What kind of tasks drain you? You procrastinate or rush through them.', hint: 'These reveal your authentic weaknesses — avoid roles built around them.' },
    { id: 'w4', q: 'When have colleagues or managers praised you most? What words did they use?', hint: 'External validation patterns are clues to your strongest brand attributes.' },
    { id: 'w5', q: 'What is one piece of feedback you have received more than once across different jobs?', hint: 'Recurring feedback (positive OR negative) reveals consistent traits — your true brand signals.' },
    { id: 'w6', q: 'If a previous client/manager described you in 3 words, what would they say?', hint: 'How others describe you is your CURRENT brand — whether you chose it or not.' },
  ]},
  { section: 'Values & Vision', icon: '✨', items: [
    { id: 'v1', q: 'What injustice or problem in the world bothers you the most?', hint: 'Your strongest values live inside what makes you angry or sad.' },
    { id: 'v2', q: 'If money was not a factor, what kind of work would you still want to do?', hint: 'This uncovers your intrinsic motivation — the brand foundation.' },
    { id: 'v3', q: 'What kind of person do you want clients to think of when they think of you?', hint: 'This is the brand you ASPIRE to. Real branding closes the gap between current and aspired.' },
    { id: 'v4', q: 'What do you believe about your industry that most others do not believe?', hint: 'Your unique perspective IS your brand differentiator.' },
  ]},
];
