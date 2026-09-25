// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/_layoutSweep.mjs — a generic detector for the Enrollments failure CLASS.
// ─────────────────────────────────────────────────────────────────────────────
// The Enrollments card failed in a way no overflow check sees: a grid track resolved to
// 0px, its text stacked a few characters per line and painted over the next column, and
// the card still reported scrollWidth === clientWidth. The sidebar is 288px open and
// 76px as a rail at the SAME viewport, so any layout that switches on a viewport
// breakpoint can do the same thing on any tab. This detector looks for the symptoms, not
// the cause, so it needs no knowledge of the tab it is looking at:
//
//   • <main> scrolling sideways;
//   • letter-stacked text — 3+ lines averaging under 4 characters, or 3+ lines in a box
//     narrower than 56px (a phone number per digit, a date per word);
//   • a grid item narrower than 24px holding 4+ characters of text (a collapsed track);
//   • grid siblings that overlap, unless they were deliberately placed in the same cell;
//   • text painting more than 8px outside a narrow grid item (the 0px column's spill).
//
// Every function here goes through page.evaluate(): SELF-CONTAINED, measurements only.
// ─────────────────────────────────────────────────────────────────────────────

export function detectLayoutDefects({ pageOnly = false } = {}) {
  const main = document.querySelector('main');
  if (!main) return { error: 'no <main>' };
  const panel = [...main.querySelectorAll('[aria-hidden="false"]')].find((el) => !el.hidden && el.getClientRects().length);
  if (!panel) return { error: 'no active tab panel' };
  const out = [];
  const say = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32)}"`;
  };
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  if (main.scrollWidth > main.clientWidth + 1) out.push(`<main> scrolls sideways by ${main.scrollWidth - main.clientWidth}px`);
  // Phone widths assert the PAGE only. Financial Management's data tables squeeze their cells
  // on a phone (dates broken at each hyphen) while scrolling correctly inside their own cards;
  // that is recorded debt (docs/audits/2026-09-24-sidebar-workspace-layout-audit.md), not a
  // sidebar regression, and asserting it here would fail on it forever.
  if (pageOnly) return { defects: out };

  // Letter-stacked text.
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    const host = n.parentElement;
    if (t.length < 4 || !host || seen.has(host) || !shown(host)) continue;
    seen.add(host);
    const rg = document.createRange(); rg.selectNodeContents(n);
    const tops = [];
    for (const r of rg.getClientRects()) if (r.width > 0 && !tops.some((x) => Math.abs(x - r.top) < 3)) tops.push(r.top);
    if (tops.length < 3) continue;
    const perLine = t.length / tops.length;
    const w = host.getBoundingClientRect().width;
    if (perLine < 4 || w < 56) out.push(`letter-stacked text (${tops.length} lines, ${perLine.toFixed(1)} chars/line, ${Math.round(w)}px wide): ${say(host)}`);
  }

  // Grids: collapsed tracks, overlapping siblings, spilled text.
  for (const g of panel.querySelectorAll('*')) {
    const cs = getComputedStyle(g);
    if (!/grid/.test(cs.display) || !shown(g)) continue;
    const kids = [...g.children].filter((k) => shown(k) && !/absolute|fixed/.test(getComputedStyle(k).position));
    if (kids.length < 2 || kids.length > 60) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());
    kids.forEach((k, i) => {
      const t = textOf(k);
      if (t.length >= 4 && rects[i].width < 24) out.push(`grid item collapsed to ${Math.round(rects[i].width)}px: ${say(k)}`);
      if (rects[i].width < 80 && t.length >= 4) {
        const rg = document.createRange(); rg.selectNodeContents(k);
        const spill = Math.max(0, ...[...rg.getClientRects()].map((r) => r.right - rects[i].right));
        if (spill > 8) out.push(`text spills ${Math.round(spill)}px out of a ${Math.round(rects[i].width)}px grid item: ${say(k)}`);
      }
    });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = rects[i]; const b = rects[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox <= 4 || oy <= 4) continue;
        // Deliberately stacked in one cell (the course player's overlay rail, a scrim).
        const ca = getComputedStyle(kids[i]); const cb = getComputedStyle(kids[j]);
        const placed = (c) => c.gridRowStart !== 'auto' || c.gridColumnStart !== 'auto' || c.gridArea !== 'auto';
        if (placed(ca) && placed(cb) && ca.gridRowStart === cb.gridRowStart && ca.gridColumnStart === cb.gridColumnStart) continue;
        out.push(`grid items overlap by ${Math.round(ox)}x${Math.round(oy)}px: ${say(kids[i])} / ${say(kids[j])}`);
      }
    }
  }
  return { defects: [...new Set(out)].slice(0, 40) };
}

/**
 * The section switchers of the active tab — a role="tablist", or a row of 3+ aria-pressed
 * buttons (Communications, Meetings) — as labels, in order. Clicking them only changes
 * which section renders; nothing is saved or sent.
 */
export function sectionLabels() {
  const main = document.querySelector('main');
  const panel = main && [...main.querySelectorAll('[aria-hidden="false"]')].find((el) => !el.hidden && el.getClientRects().length);
  if (!panel) return [];
  const rows = [];
  for (const list of panel.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')].filter((b) => b.getClientRects().length);
    if (tabs.length >= 2) rows.push(tabs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
  }
  for (const row of panel.querySelectorAll('div')) {
    const btns = [...row.children].filter((b) => b.tagName === 'BUTTON' && b.hasAttribute('aria-pressed'));
    if (btns.length >= 3 && btns.length === [...row.children].filter((c) => c.tagName === 'BUTTON').length) {
      rows.push(btns.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
    }
  }
  // Only the first switcher row: nested rows (a period picker inside a report) are covered
  // by visiting the section that contains them.
  return rows[0] || [];
}

/** Click the section switcher with this exact label. */
export function clickSection(label) {
  const main = document.querySelector('main');
  const panel = main && [...main.querySelectorAll('[aria-hidden="false"]')].find((el) => !el.hidden && el.getClientRects().length);
  const b = panel && [...panel.querySelectorAll('[role="tab"], button[aria-pressed]')]
    .find((x) => x.getClientRects().length && x.textContent.replace(/\s+/g, ' ').trim() === label);
  if (!b) return false;
  b.click();
  return true;
}
