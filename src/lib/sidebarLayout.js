// ─────────────────────────────────────────────────────────────────────────────
// src/lib/sidebarLayout.js — the per-user sidebar layout reconciler (pure).
//
// Extracted from BookkeeperPro.jsx in #56 so it can be unit-tested. DEFAULT_STAGES and
// the fallback icon arrive as ARGUMENTS instead of closure variables, because
// DEFAULT_STAGES is built inside the root component (its icons are React components).
//
// ★ WHY THIS FILE EXISTS. Order and collapse state are per-user in window.storage
//   (`sidebar:*`), while LABELS are global and admin-controlled in Supabase. When a tab
//   is RETIRED, nothing migrates that stored layout — mergeStoredWithDefaults() is what
//   silently drops the dead id, and that behaviour is pinned by
//   test/sidebarLayout.test.mjs instead of being an unverified claim in a comment.
//
// ★ GROUPED STAGES PERSIST THEIR OWN ORDER, AND THAT IS NEW IN v5.
//   Until v5 this module deliberately re-stamped `groups` from the code defaults on
//   every load, and `stagesToStorable` never wrote them at all. The sidebar renders a
//   grouped stage from `groups[].tabIds` (stage.tabs is collapsed to an id→object
//   dictionary first), so a drag inside Job Application or Client Management mutated
//   `stage.tabs`, persisted faithfully, and then changed NOTHING on screen — while the
//   same drag in flat Training worked. The old suite pinned that as intended behaviour.
//
//   So v5 persists `groups: [{ key, tabIds }]` — stable keys and ids ONLY. Never labels
//   (those are global in `sidebar_settings`; storing a copy here would let a stale
//   per-browser value shadow an admin rename) and never icons (React components).
//
// ★ GROUP ORDER AND GROUP MEMBERSHIP STILL COME FROM THE DEFAULTS. Only the order of
//   tabs WITHIN a group is user data. That keeps the reconciliation total: a stored id
//   is accepted only into the group DEFAULT_STAGES assigns it to, so a corrupt or
//   hand-edited layout can reorder a group but can never move a tab between groups,
//   invent a group, or strand a tab in one that no longer exists.
//
// ★ FOR A GROUPED STAGE, `tabs` IS DERIVED FROM `groups`, NOT FROM STORED ORDER.
//   The collapsed icon rail renders `stage.tabs` flat for EVERY stage, so before v5 a
//   grouped-stage drag silently reordered the rail while the expanded nav stayed put —
//   the two sidebars disagreed. Deriving one from the other makes that unrepresentable.
// ─────────────────────────────────────────────────────────────────────────────

// Serialize stages without icons (icons are components, not serializable).
export function stagesToStorable(stgs) {
  return (stgs || []).map(s => ({
    id: s.id,
    label: s.label,
    number: s.number,
    desc: s.desc,
    tabs: (s.tabs || []).map(t => ({ id: t.id, label: t.label })),
    // Keys + ids only. A group's LABEL is global (sidebar_settings) and must not be
    // shadowed by a per-browser copy; its icon is a component.
    ...(Array.isArray(s.groups) && s.groups.length
      ? { groups: s.groups.map(g => ({ key: g.key, tabIds: [...(g.tabIds || [])] })) }
      : {}),
  }));
}

/** id → `${stageId}:${groupKey}` for every tab DEFAULT_STAGES files into a group. */
function canonicalGroupIndex(defaultStages) {
  const index = {};
  (defaultStages || []).forEach(s => (s.groups || []).forEach(g => {
    (g.tabIds || []).forEach(id => { index[id] = `${s.id}:${g.key}`; });
  }));
  return index;
}

/**
 * Reconcile ONE default group's tabIds against what a user stored for it.
 *
 * Accepts a stored id only when it is a known tab AND this is the group the defaults
 * put it in — so a duplicate, a retired id, and a tab recorded somewhere it does not
 * belong are all dropped rather than corrupting the layout. Anything the defaults
 * expect and the stored order omits is re-inserted at its default-RELATIVE position
 * (just after the nearest preceding sibling that survived), which is what lets a
 * newly-shipped tab land where it belongs instead of at the end.
 */
function reconcileGroup(defGroup, storedIds, stageId, defaultTabById, canonical, claimed) {
  const key = `${stageId}:${defGroup.key}`;
  const out = [];
  (Array.isArray(storedIds) ? storedIds : []).forEach(id => {
    if (typeof id !== 'string') return;
    if (!defaultTabById[id]) return;          // unknown or RETIRED
    if (canonical[id] !== key) return;        // not this group's tab
    if (claimed.has(id)) return;              // duplicate
    claimed.add(id);
    out.push(id);
  });
  const defaults = defGroup.tabIds || [];
  defaults.forEach((id, defIdx) => {
    if (claimed.has(id)) return;
    let insertAt = 0;
    for (let k = defIdx - 1; k >= 0; k--) {
      const pos = out.indexOf(defaults[k]);
      if (pos !== -1) { insertAt = pos + 1; break; }
    }
    out.splice(insertAt, 0, id);
    claimed.add(id);
  });
  return { ...defGroup, tabIds: out };
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
  const canonical = canonicalGroupIndex(DEFAULT_STAGES);

  // Reconstruct stages from stored, falling back to defaults for missing pieces
  const merged = stored.map(s => {
    const def = defaultStageById[s.id] || {};
    const storedLabel = {};
    (Array.isArray(s.tabs) ? s.tabs : []).forEach(t => {
      if (t && typeof t.id === 'string') storedLabel[t.id] = t.label;
    });
    const hydrate = (id) => ({
      id,
      label: storedLabel[id] || (defaultTabById[id] || {}).label || id,
      icon: (defaultTabById[id] || {}).icon || fallbackIcon, // fallback icon
    });
    const base = {
      id: s.id,
      label: s.label || def.label || '',
      number: s.number ?? def.number ?? '',
      desc: s.desc || def.desc || '',
    };

    if (!def.groups) {
      // Flat stage (Home, Training): the stored array order IS the order.
      base.tabs = (Array.isArray(s.tabs) ? s.tabs : [])
        .filter(t => t && defaultTabById[t.id])
        .map(t => hydrate(t.id));
      return base;
    }

    // Grouped stage: reconcile each group, then DERIVE tabs from the result so the
    // expanded nav and the collapsed icon rail can never disagree.
    const storedGroupIds = {};
    (Array.isArray(s.groups) ? s.groups : []).forEach(g => {
      if (g && typeof g.key === 'string') storedGroupIds[g.key] = g.tabIds;
    });
    const claimed = new Set();
    base.groups = def.groups.map(g =>
      reconcileGroup(g, storedGroupIds[g.key], s.id, defaultTabById, canonical, claimed));
    base.tabs = base.groups.flatMap(g => g.tabIds).map(hydrate);
    return base;
  }).filter(s => defaultStageById[s.id]); // drop unknown stage ids

  // Add any default stages missing from stored, and — for FLAT stages only — any new
  // tab the stored layout predates. A grouped stage is already complete: reconcileGroup
  // re-inserts every default id it did not find.
  DEFAULT_STAGES.forEach(defStage => {
    const existing = merged.find(s => s.id === defStage.id);
    if (!existing) { merged.push(defStage); return; }
    if (defStage.groups) return;
    defStage.tabs.forEach((defTab, defIdx) => {
      if (existing.tabs.some(t => t.id === defTab.id)) return;
      let insertAt = 0;
      for (let k = defIdx - 1; k >= 0; k--) {
        const pos = existing.tabs.findIndex(t => t.id === defStage.tabs[k].id);
        if (pos !== -1) { insertAt = pos + 1; break; }
      }
      existing.tabs.splice(insertAt, 0, defTab);
    });
  });

  return merged;
}

// Bump when a code change should re-reconcile every user's saved sidebar layout.
// On load, a stored version below this triggers a one-time normalizeTabOrder() pass so
// already-saved layouts adopt the new default ordering.
//   v5 — grouped stages persist `groups[].tabIds`. Every v4 layout stored no groups at
//        all, so the merge rebuilds each group from the defaults, which is exactly the
//        deterministic reconciliation this bump is for: a pre-v5 user adopts the new
//        Interview order, and a v4 `tabs` array scrambled by drags that never rendered
//        is discarded rather than being read as an intentional order.
export const SIDEBAR_VERSION = 5;

// Re-sort each stage's tabs to follow the default order (preserving user renames).
// ★ GROUPED STAGES ARE SKIPPED. Since v5 their `tabs` is derived from `groups[].tabIds`,
//   so sorting it into DEFAULT_STAGES order would silently overwrite a saved group order
//   with the code default on every version bump — and leave `tabs` disagreeing with
//   `groups`, which is the exact split the rail/nav mismatch came from.
export function normalizeTabOrder(stgs, defaultStages) {
  const DEFAULT_STAGES = defaultStages || [];
  return (stgs || []).map(s => {
    const def = DEFAULT_STAGES.find(d => d.id === s.id);
    if (!def) return s;
    if (def.groups || s.groups) return s;
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

// ─────────────────────────────────────────────────────────────────────────────
// Reordering
//
// The UI never splices an array itself. Both affordances — the up/down buttons and the
// drag handles — go through these functions, so "a tab cannot leave its group" and "a
// tab cannot be lost" are properties of ONE tested place rather than of two event
// handlers that have to agree with each other.
// ─────────────────────────────────────────────────────────────────────────────

/** The group key a tab sits in for this stage, or null when the stage is flat. */
export function groupKeyOfTab(stage, tabId) {
  if (!stage || !Array.isArray(stage.groups)) return null;
  const g = stage.groups.find(grp => (grp.tabIds || []).includes(tabId));
  return g ? g.key : null;
}

/** The ordered ids a tab is reordered within: its group, or the whole flat stage. */
export function orderedSiblingIds(stage, tabId) {
  if (!stage) return [];
  const key = groupKeyOfTab(stage, tabId);
  if (key === null) return (stage.tabs || []).map(t => t.id);
  const g = stage.groups.find(grp => grp.key === key);
  return [...(g.tabIds || [])];
}

/** Reorder `stage.tabs` to follow `groups[].tabIds`, reusing the same tab objects. */
function syncTabsToGroups(stage) {
  if (!Array.isArray(stage.groups)) return stage;
  const byId = {};
  (stage.tabs || []).forEach(t => { byId[t.id] = t; });
  const ordered = stage.groups.flatMap(g => g.tabIds || []).map(id => byId[id]).filter(Boolean);
  // Anything no group names would otherwise vanish from the collapsed rail. There should
  // be none — but losing a tab silently is the single outcome this module exists to
  // prevent, so they are kept rather than trusted not to exist.
  const named = new Set(ordered.map(t => t.id));
  const orphans = (stage.tabs || []).filter(t => !named.has(t.id));
  return { ...stage, tabs: [...ordered, ...orphans] };
}

/** Apply a reordering of one tab's sibling list back onto the stage. */
function withReorderedSiblings(list, stageId, groupKey, reordered) {
  return list.map(s => {
    if (s.id !== stageId) return s;
    if (groupKey === null) {
      const byId = {};
      (s.tabs || []).forEach(t => { byId[t.id] = t; });
      return { ...s, tabs: reordered.map(id => byId[id]).filter(Boolean) };
    }
    const groups = s.groups.map(g => (g.key === groupKey ? { ...g, tabIds: [...reordered] } : g));
    return syncTabsToGroups({ ...s, groups });
  });
}

/**
 * Move a tab from one index to another inside its own group (or inside a flat stage).
 * Returns the new stages plus everything an aria-live announcement needs.
 */
function applyMove(list, stageId, tabId, from, to) {
  const stage = list.find(s => s.id === stageId);
  const groupKey = groupKeyOfTab(stage, tabId);
  const siblings = orderedSiblingIds(stage, tabId);
  const reordered = [...siblings];
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  return {
    ok: true,
    stages: withReorderedSiblings(list, stageId, groupKey, reordered),
    from,
    to,
    total: siblings.length,
    groupKey,
  };
}

/**
 * Move a tab one place up (-1) or down (+1) inside its own group.
 *
 * `ok:false` is a refusal, never a silent no-op: at a boundary the button is disabled,
 * so reaching here means something is out of step and the caller should say so.
 */
export function moveTabByStep(stages, stageId, tabId, delta) {
  const list = Array.isArray(stages) ? stages : [];
  const stage = list.find(s => s.id === stageId);
  if (!stage) return { ok: false, reason: 'unknown-stage', stages: list };
  const step = Number(delta);
  if (step !== 1 && step !== -1) return { ok: false, reason: 'bad-step', stages: list };

  const siblings = orderedSiblingIds(stage, tabId);
  const from = siblings.indexOf(tabId);
  if (from === -1) return { ok: false, reason: 'unknown-tab', stages: list };
  const to = from + step;
  if (to < 0 || to >= siblings.length) return { ok: false, reason: 'at-edge', stages: list };

  return applyMove(list, stageId, tabId, from, to);
}

/**
 * Resolve a drag-and-drop: "put src where tgt is". The ONLY place that decides a drop
 * is illegal.
 *
 * A cross-stage or cross-group drop is REFUSED rather than applied. Dropping "Free QB
 * Diagnostic" onto "Authentic Branding" used to splice it out of one stage.tabs and into
 * another; for a grouped stage that left the tab named by no group's tabIds, and
 * `g.tabIds.map(...).filter(Boolean)` simply dropped it — the tab disappeared from the
 * sidebar with no error anywhere, and only a Reset brought it back.
 */
export function reorderVerdict(stages, srcStageId, srcTabId, tgtStageId, tgtTabId) {
  const list = Array.isArray(stages) ? stages : [];
  if (!srcTabId || srcTabId === tgtTabId) return { ok: false, reason: 'noop', stages: list };
  if (srcStageId !== tgtStageId) return { ok: false, reason: 'cross-stage', stages: list };

  const stage = list.find(s => s.id === srcStageId);
  if (!stage) return { ok: false, reason: 'unknown-stage', stages: list };

  const srcGroup = groupKeyOfTab(stage, srcTabId);
  const tgtGroup = groupKeyOfTab(stage, tgtTabId);
  if (srcGroup !== tgtGroup) return { ok: false, reason: 'cross-group', stages: list };

  const siblings = orderedSiblingIds(stage, srcTabId);
  const from = siblings.indexOf(srcTabId);
  const to = siblings.indexOf(tgtTabId);
  if (from === -1 || to === -1) return { ok: false, reason: 'unknown-tab', stages: list };

  return applyMove(list, srcStageId, srcTabId, from, to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reordering WHOLE STAGES
//
// ★ WHY THESE EXIST. Stage order was the last hand-rolled splice in the sidebar: the drop
//   handler spliced the array in place, with no arbiter, no refusal, no announcement and
//   no keyboard or touch affordance — stages could only be dragged with a mouse. Tabs were
//   rescued from exactly that shape; leaving stages in it meant half the Customize surface
//   was unusable from a keyboard and untested besides.
// ─────────────────────────────────────────────────────────────────────────────

/** Move a whole stage one place up (-1) or down (+1). */
export function moveStageByStep(stages, stageId, delta) {
  const list = Array.isArray(stages) ? stages : [];
  const step = Number(delta);
  if (step !== 1 && step !== -1) return { ok: false, reason: 'bad-step', stages: list };
  const from = list.findIndex((s) => s && s.id === stageId);
  if (from === -1) return { ok: false, reason: 'unknown-stage', stages: list };
  const to = from + step;
  if (to < 0 || to >= list.length) return { ok: false, reason: 'at-edge', stages: list };

  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return { ok: true, stages: next, from, to, total: list.length };
}

/** Resolve a stage drag-and-drop: "put src where tgt is". The ONE arbiter for a stage drop. */
export function stageReorderVerdict(stages, srcStageId, tgtStageId) {
  const list = Array.isArray(stages) ? stages : [];
  if (!srcStageId || srcStageId === tgtStageId) return { ok: false, reason: 'noop', stages: list };
  const from = list.findIndex((s) => s && s.id === srcStageId);
  const to = list.findIndex((s) => s && s.id === tgtStageId);
  if (from === -1 || to === -1) return { ok: false, reason: 'unknown-stage', stages: list };

  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return { ok: true, stages: next, from, to, total: list.length };
}

/** Human wording for a refused drop — the sidebar shows this instead of failing quietly. */
export const REORDER_REFUSALS = {
  'cross-group': 'Tabs move within their own section. Drop it between the tabs already under that heading.',
  'cross-stage': 'Tabs stay in their own stage. Drop it between the tabs already in that stage.',
  'unknown-tab': 'That tab could not be placed. Reload the page and try again.',
  'unknown-stage': 'That stage could not be found. Reload the page and try again.',
  'at-edge': 'That tab is already at the end of its section.',
  'bad-step': 'That move could not be applied.',
};

/** The same, for a whole stage: "section" there means the sidebar, not a sub-heading. */
export const STAGE_REORDER_REFUSALS = {
  'at-edge': 'That section is already at the end of the sidebar.',
  'unknown-stage': 'That section could not be found. Reload the page and try again.',
  'bad-step': 'That move could not be applied.',
};
