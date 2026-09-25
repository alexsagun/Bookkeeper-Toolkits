// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/_enrollmentProbe.mjs — what "the Enrollments card is readable" MEANS, as code.
// ─────────────────────────────────────────────────────────────────────────────
// Shared by test-e2e/enrollmentLayout.e2etest.mjs and the mutation proof, so the check
// that passes on the fixed card is exactly the check that fails on a broken one.
//
// Every function here is passed to page.evaluate(), which serialises it with
// toString(): each one must be SELF-CONTAINED (no imports, no closures over module
// scope) and must return measurements only — never storage, never a token.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure every visible `.enroll-card`. Returns [{ name, identityW, contentW, problems[] }].
 *
 * The rules, and the defect each one exists for:
 *   • who / plan / status / actions never intersect           — the plan painted over identity
 *   • no region's text paints outside that region             — the 0px column's text spilled
 *   • identity keeps min(240px, the card's content width)     — the 0px column itself
 *   • no control outside its card; the card never overflows   — hidden-overflow "fixes"
 *   • the actions sit BELOW the head, never beside it         — the auto track that caused it
 *   • a short fact never wraps: a one-word token (a phone number), a date ("Sep 24, 2026"),
 *     a countdown ("3d left") and a status pill each occupy ONE line
 *                                                             — the phone wrapped per digit
 *   • nothing is letter-wrapped: a chip on 2+ lines is never narrower than 64px
 *                                                             — "vertically letter-wrapped"
 *   • expanded intake answers are never truncated             — the old `truncate`
 *
 * ★ An overflow check alone is NOT a layout check. On 2026-09-24 the broken card reported
 *   scrollWidth === clientWidth at every width while its identity column was 0px.
 */
export function measureCards() {
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const inter = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
  const inside = (a, b, tol = 1.5) => a.l >= b.l - tol && a.r <= b.r + tol && a.t >= b.t - tol && a.b <= b.b + tol;
  const textRects = (el) => {
    const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim()) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 0 && r.height > 0) out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
    }
    return out;
  };
  // Distinct line boxes the element's text occupies.
  const lineCount = (el) => {
    const tops = [];
    for (const r of textRects(el)) if (!tops.some((t) => Math.abs(t - r.t) < 3)) tops.push(r.t);
    return tops.length;
  };
  const SHORT_FACT = [
    /^\S+$/,                                   // one token: 09101890556, a GCash ref word
    /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,          // Sep 24, 2026
    /^\d+d (left|overdue)$/,                   // 3d left / 2d overdue
  ];
  const KEYS = ['who', 'plan', 'status', 'actions'];
  return [...document.querySelectorAll('.enroll-card')].filter((c) => c.getClientRects().length).map((card) => {
    const el = Object.fromEntries(KEYS.map((k) => [k, card.querySelector(`[data-enroll-region="${k}"]`)]));
    const reg = Object.fromEntries(KEYS.map((k) => [k, el[k] ? R(el[k]) : null]));
    const cardR = R(card);
    const cs = getComputedStyle(card);
    const contentW = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const problems = [];
    const missing = KEYS.filter((k) => !reg[k]);
    if (missing.length) problems.push(`missing region(s): ${missing.join(',')}`);
    const present = KEYS.filter((k) => reg[k]);
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        if (inter(reg[present[i]], reg[present[j]])) problems.push(`${present[i]} overlaps ${present[j]}`);
      }
    }
    for (const k of present) {
      if (textRects(el[k]).some((t) => !inside(t, reg[k]))) problems.push(`${k} text paints outside its region`);
      if (el[k].scrollWidth > el[k].clientWidth + 1) problems.push(`${k} content overflows by ${el[k].scrollWidth - el[k].clientWidth}px`);
    }
    if (reg.who && reg.who.w < Math.min(240, contentW) - 1) problems.push(`identity ${Math.round(reg.who.w)}px of ${Math.round(contentW)}px`);
    if (card.scrollWidth > card.clientWidth + 1) problems.push(`card overflows by ${card.scrollWidth - card.clientWidth}px`);
    for (const ctl of card.querySelectorAll('button, input, label, select, textarea, a')) {
      if (!ctl.getClientRects().length) continue;
      if (!inside(R(ctl), cardR)) problems.push(`control outside the card: "${ctl.textContent.trim().slice(0, 24)}"`);
    }
    const head = ['who', 'plan', 'status'].filter((k) => reg[k]).map((k) => reg[k].b);
    if (reg.actions && head.length && reg.actions.t < Math.max(...head) - 1) problems.push('actions sit beside the head, not below it');
    // Chips: the identity meta row, the badges beside the name, and the status pill.
    const chips = [
      ...(el.who ? el.who.querySelectorAll('span.inline-flex, span.rounded-full') : []),
      ...(el.status ? el.status.querySelectorAll('span') : []),
    ];
    for (const chip of chips) {
      if (!chip.getClientRects().length) continue;
      const text = chip.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const lines = lineCount(chip);
      const w = chip.getBoundingClientRect().width;
      if (lines > 1 && w < 64) problems.push(`"${text.slice(0, 24)}" is letter-wrapped (${lines} lines in ${Math.round(w)}px)`);
      const isStatus = el.status && el.status.contains(chip);
      if (lines > 1 && (isStatus || SHORT_FACT.some((re) => re.test(text)))) {
        problems.push(`"${text.slice(0, 24)}" splits across ${lines} lines`);
      }
    }
    for (const v of card.querySelectorAll('[data-enroll-intake-value]')) {
      if (v.scrollWidth > v.clientWidth + 1) problems.push(`intake answer truncated: "${v.textContent.slice(0, 24)}"`);
    }
    const name = (el.who?.querySelector('span')?.textContent || '').slice(0, 28);
    return { name, identityW: Math.round(reg.who?.w || 0), contentW: Math.round(contentW), problems };
  });
}

/**
 * Click the sidebar toggle and sample the first card on every animation frame for the
 * whole 300ms width transition (plus margin). The card must be readable DURING the
 * animation, not only after it: a ResizeObserver-driven layout would lag a frame behind,
 * a container query does not. Returns { frames, worst } where worst is the narrowest
 * identity seen and any overlap, per direction.
 */
export async function sampleSidebarTransition(label) {
  const btn = document.querySelector(`[aria-label="${label}"]`);
  if (!btn) return { error: `no "${label}" button` };
  const card = () => document.querySelector('.enroll-card');
  const measure = () => {
    const c = card();
    if (!c) return null;
    const q = (k) => c.querySelector(`[data-enroll-region="${k}"]`)?.getBoundingClientRect();
    const who = q('who'); const plan = q('plan'); const status = q('status'); const actions = q('actions');
    const cs = getComputedStyle(c);
    const contentW = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const hit = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    return {
      asideW: Math.round(document.querySelector('aside')?.getBoundingClientRect().width || 0),
      identityW: Math.round(who?.width || 0), contentW: Math.round(contentW),
      overlap: hit(who, plan) || hit(who, status) || hit(who, actions) || hit(plan, status) || hit(plan, actions) || hit(status, actions),
    };
  };
  const frames = [];
  btn.click();
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const m = measure();
      if (m) frames.push({ ms: Math.round(performance.now() - t0), ...m });
      if (performance.now() - t0 < 450) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  return {
    frames: frames.length,
    asideFrom: frames[0]?.asideW, asideTo: frames[frames.length - 1]?.asideW,
    narrowest: Math.min(...frames.map((f) => f.identityW)),
    bad: frames.filter((f) => f.overlap || f.identityW < Math.min(240, f.contentW) - 1),
  };
}
