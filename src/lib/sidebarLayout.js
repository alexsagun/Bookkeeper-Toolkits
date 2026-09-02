// ─────────────────────────────────────────────────────────────────────────────
// src/lib/sidebarLayout.js — the per-user sidebar layout reconciler (pure).
//
// Extracted from BookkeeperPro.jsx in #56 so it can be unit-tested. The bodies are
// unchanged; the only difference is that DEFAULT_STAGES and the fallback icon arrive
// as ARGUMENTS instead of closure variables, because DEFAULT_STAGES is built inside
// the root component (its icons are React components).
//
// ★ WHY THIS FILE EXISTS. Order and collapse state are per-user in window.storage
//   (`sidebar:*`), while LABELS are global and admin-controlled in Supabase. When a tab
//   is RETIRED, nothing migrates that stored layout — mergeStoredWithDefaults() is what
//   silently drops the dead id, and that behaviour is now pinned by
//   test/sidebarLayout.test.mjs instead of being an unverified claim in a comment.
//   A retired tab therefore needs no storage migration, but it DOES need this filter to
//   keep working: without it a stored layout would resurrect a tab the app can no longer
//   render.
// ─────────────────────────────────────────────────────────────────────────────

// Serialize stages without icons (icons are components, not serializable).
export function stagesToStorable(stgs) {
  return (stgs || []).map(s => ({
    id: s.id,
    label: s.label,
    number: s.number,
    desc: s.desc,
    tabs: (s.tabs || []).map(t => ({ id: t.id, label: t.label })),
  }));
}

// Merge stored labels/order with the code defaults (which carry the icons).
export function mergeStoredWithDefaults(stored, defaultStages, fallbackIcon) {
  const DEFAULT_STAGES = defaultStages || [];
  if (!stored || !Array.isArray(stored)) return DEFAULT_STAGES;
  // Build a lookup of default tabs (with icons) by id
  const defaultTabById = {};
  DEFAULT_STAGES.forEach(s => s.tabs.forEach(t => { defaultTabById[t.id] = t; }));
  const defaultStageById = {};
  DEFAULT_STAGES.forEach(s => { defaultStageById[s.id] = s; });

  // Reconstruct stages from stored, falling back to defaults for missing pieces
  const merged = stored.map(s => {
    const def = defaultStageById[s.id] || {};
    return {
      id: s.id,
      label: s.label || def.label || '',
      number: s.number ?? def.number ?? '',
      desc: s.desc || def.desc || '',
      // Sub-group metadata always comes from defaults (not stored), so it stays in sync with code updates.
      ...(def.groups ? { groups: def.groups } : {}),
      tabs: (s.tabs || []).map(t => {
        const defTab = defaultTabById[t.id] || {};
        return {
          id: t.id,
          label: t.label || defTab.label || t.id,
          icon: defTab.icon || fallbackIcon, // fallback icon
        };
      }).filter(t => defaultTabById[t.id]), // drop unknown tab ids — incl. RETIRED ones
    };
  }).filter(s => defaultStageById[s.id]); // drop unknown stage ids

  // Add any default stages/tabs missing from stored (e.g. new tabs added in updates).
  // Insert a missing tab at its DEFAULT_STAGES-relative position — just after the nearest
  // preceding default sibling the user already has (else at the front) — instead of dumping
  // it at the end. Keeps newly-shipped tabs where they belong in the navigation order.
  DEFAULT_STAGES.forEach(defStage => {
    const existing = merged.find(s => s.id === defStage.id);
    if (!existing) {
      merged.push(defStage);
    } else {
      defStage.tabs.forEach((defTab, defIdx) => {
        if (existing.tabs.some(t => t.id === defTab.id)) return;
        let insertAt = 0;
        for (let k = defIdx - 1; k >= 0; k--) {
          const pos = existing.tabs.findIndex(t => t.id === defStage.tabs[k].id);
          if (pos !== -1) { insertAt = pos + 1; break; }
        }
        existing.tabs.splice(insertAt, 0, defTab);
      });
    }
  });

  return merged;
}

// Bump when a code change should re-reconcile every user's saved sidebar layout (e.g. a new
// default tab that must land in a specific spot). On load, a stored version below this triggers
// a one-time normalizeTabOrder() pass so already-saved layouts adopt the new default ordering.
export const SIDEBAR_VERSION = 4;

// Re-sort each stage's tabs to follow the default order (preserving user renames). Safe:
// grouped stages render by explicit tabIds, so only flat stages (e.g. Training) are affected.
export function normalizeTabOrder(stgs, defaultStages) {
  const DEFAULT_STAGES = defaultStages || [];
  return (stgs || []).map(s => {
    const def = DEFAULT_STAGES.find(d => d.id === s.id);
    if (!def) return s;
    const order = def.tabs.map(t => t.id);
    const rank = (id) => { const i = order.indexOf(id); return i === -1 ? 999 : i; };
    return { ...s, tabs: [...s.tabs].sort((a, b) => rank(a.id) - rank(b.id)) };
  });
}

// Tabs renamed in code after users may have persisted the old label. The sidebar merges
// labels stored-wins (so user renames survive), which would otherwise mask a code rename.
// This one-time, version-gated pass overwrites a saved label ONLY when it still equals the
// tab's PRIOR default — preserving any genuine user rename of the same tab.
export const RENAMED_TAB_LABELS = {
  interview: { from: 'Interview Prep', to: 'Job Interview Mastery' },
  proposal: { from: 'Proposal Generator', to: 'Cover Letter Generator' },
};

export function reconcileRenamedLabels(stgs, renamed = RENAMED_TAB_LABELS) {
  return (stgs || []).map(s => ({
    ...s,
    tabs: (s.tabs || []).map(t => {
      const r = renamed[t.id];
      return r && t.label === r.from ? { ...t, label: r.to } : t;
    }),
  }));
}
