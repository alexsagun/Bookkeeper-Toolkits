// test/sidebarLayout.test.mjs — stored sidebar layouts vs the code defaults (#56, v5).
//
// ★ WHY THIS SUITE EXISTS. Order and collapse state are per-user in window.storage
//   (`sidebar:*`); LABELS are global and admin-controlled in Supabase. When a tool is
//   RETIRED nothing migrates that stored layout — the ONLY thing that stops a dead tab id
//   coming back is the id filter inside mergeStoredWithDefaults(). That was an unverified
//   claim in a comment until #56 retired three tools and needed it to be true.
//
// ★ WHAT CHANGED IN v5, AND WHY TWO TESTS HERE WERE REWRITTEN.
//   This suite used to assert `deepEqual(stage.groups, DEFAULTS.groups)` — "sub-group
//   metadata is never read from storage" — and a second test repeated the claim. Both
//   were accurate descriptions of the code and both pinned a BUG in place: because group
//   order came only from the defaults, a drag inside Job Application or Client Management
//   mutated stage.tabs, persisted, and changed nothing on screen. The owner reported it
//   as "rearranging only works under Training".
//
//   So the invariant is now narrower and is stated as such: group ORDER and group
//   MEMBERSHIP come from the defaults; the order of tabs WITHIN a group is user data.
//   The tests below assert the narrower rule directly — a stored id is accepted only
//   into its canonical group, duplicates collapse, and nothing can be lost.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SIDEBAR_VERSION,
  RENAMED_TAB_LABELS,
  REORDER_REFUSALS,
  groupKeyOfTab,
  mergeStoredWithDefaults,
  moveTabByStep,
  normalizeTabOrder,
  orderedSiblingIds,
  reconcileRenamedLabels,
  reorderVerdict,
  moveStageByStep,
  stageReorderVerdict,
  STAGE_REORDER_REFUSALS,
  stagesToStorable,
} from '../src/lib/sidebarLayout.js';
import { filterStagesForEntitlement, planEntitlement } from '../src/lib/planCatalog.js';

const ICON = function Icon() {};
const FALLBACK = function Fallback() {};

const DEFAULTS = [
  {
    id: 'training',
    label: 'Training & Skills',
    number: '01',
    desc: 'Build your foundation',
    tabs: [
      { id: 'course', label: 'Accounting 101', icon: ICON },
      { id: 'qbomastery', label: 'QuickBooks Online Mastery', icon: ICON },
      { id: 'chat', label: 'ProAdvisor Chat', icon: ICON },
    ],
  },
  {
    id: 'delivery',
    label: 'Client Management & Delivery',
    number: '03',
    desc: 'Onboard · operate · close the year',
    groups: [
      { key: 'monthly', label: 'Monthly Tasks', tabIds: ['workflow', 'salestax'] },
      { key: 'yearend', label: 'Year-End Tasks', tabIds: ['yearendcheck', 'form1099'] },
    ],
    tabs: [
      { id: 'workflow', label: 'Monthly Workflow', icon: ICON },
      { id: 'salestax', label: 'Sales Tax', icon: ICON },
      { id: 'yearendcheck', label: 'Year-End Checklist', icon: ICON },
      { id: 'form1099', label: '1099 Prep', icon: ICON },
    ],
  },
];

/** A layout saved before #56, still naming the three retired tools — and pre-v5, so no groups. */
const STORED_PRE_56 = [
  {
    id: 'training',
    label: 'My Training',
    number: '01',
    desc: 'Build your foundation',
    tabs: [
      { id: 'course', label: 'Accounting 101' },
      { id: 'niche', label: 'Niche Selector Quiz' },
      { id: 'qbomastery', label: 'QBO' },
      { id: 'chat', label: 'ProAdvisor Chat' },
    ],
  },
  {
    id: 'delivery',
    label: 'Client Management & Delivery',
    number: '03',
    desc: 'Onboard · operate · close the year',
    tabs: [
      { id: 'workflow', label: 'Monthly Workflow' },
      { id: 'budgeting', label: 'Budgeting Tool' },
      { id: 'forecasting', label: 'Forecasting Tool' },
      { id: 'salestax', label: 'Sales Tax' },
      { id: 'yearendcheck', label: 'Year-End Checklist' },
      { id: 'form1099', label: '1099 Prep' },
    ],
  },
];

const idsOf = (stages) => stages.flatMap((s) => s.tabs.map((t) => t.id));
const groupIds = (stage, key) => stage.groups.find((g) => g.key === key).tabIds;
const deliveryOf = (merged) => merged.find((s) => s.id === 'delivery');

/**
 * The shape of the real Job Application stage's Profile Optimization group after the
 * Portfolio Generator was added between its two siblings. Mirrors DEFAULT_STAGES, and
 * exists to prove that shipping a new tab into a GROUPED stage needs no version bump.
 */
const JOBSEARCH_GROUPS = [
  { key: 'profile-opt', label: 'Profile Optimization', tabIds: ['resumestrategy', 'portfoliogenerator', 'linkedinopt'] },
  { key: 'interview', label: 'Interview', tabIds: ['interview', 'coachalex', 'qbdiag'] },
];
const JOBSEARCH_DEFAULTS = [
  {
    id: 'jobsearch',
    label: 'Job Application',
    number: '02',
    desc: 'Land US clients',
    groups: JOBSEARCH_GROUPS,
    tabs: [
      { id: 'resumestrategy', label: 'Resume Winning Strategy', icon: ICON },
      { id: 'portfoliogenerator', label: 'Portfolio Generator', icon: ICON },
      { id: 'linkedinopt', label: 'Book 1-on-1 with Alex', icon: ICON },
      { id: 'interview', label: 'Job Interview Mastery', icon: ICON },
      { id: 'coachalex', label: 'Personalized Coaching With Alex', icon: ICON },
      { id: 'qbdiag', label: 'Free QB Diagnostic', icon: ICON },
    ],
  },
];

// ── Reconciliation ──────────────────────────────────────────────────────────

test('a stored layout drops the three retired tab ids and keeps everything else', () => {
  const merged = mergeStoredWithDefaults(STORED_PRE_56, DEFAULTS, FALLBACK);
  const ids = idsOf(merged);
  for (const dead of ['niche', 'budgeting', 'forecasting']) {
    assert.ok(!ids.includes(dead),
      `${dead} was retired in #56 — a saved layout must not resurrect it`);
  }
  assert.deepEqual(ids.slice().sort(),
    ['chat', 'course', 'form1099', 'qbomastery', 'salestax', 'workflow', 'yearendcheck'],
    'every surviving tab must still be present exactly once');
});

test('a user rename of a surviving tab survives the merge', () => {
  const merged = mergeStoredWithDefaults(STORED_PRE_56, DEFAULTS, FALLBACK);
  const training = merged.find((s) => s.id === 'training');
  assert.equal(training.label, 'My Training', 'the stage rename must survive');
  assert.equal(training.tabs.find((t) => t.id === 'qbomastery').label, 'QBO',
    'the tab rename must survive');
});

test('icons always come from the defaults, never from storage', () => {
  const merged = mergeStoredWithDefaults(STORED_PRE_56, DEFAULTS, FALLBACK);
  for (const s of merged) {
    for (const t of s.tabs) {
      assert.equal(t.icon, ICON, `${t.id} must take its icon from DEFAULT_STAGES`);
    }
  }
});

test('a v4 layout (no stored groups) rebuilds every group from the defaults', () => {
  // ★ THIS REPLACES "sub-group metadata is never read from storage". That assertion was
  //   true and was the bug: it meant a grouped-stage drag could never show up. What is
  //   still true, and is what this now pins, is that a layout which stored NO group
  //   information adopts the code defaults exactly — which is the v4 → v5 migration.
  const merged = mergeStoredWithDefaults(STORED_PRE_56, DEFAULTS, FALLBACK);
  const delivery = deliveryOf(merged);
  assert.deepEqual(delivery.groups.map((g) => g.key), ['monthly', 'yearend'],
    'group ORDER and membership still come from the defaults');
  assert.deepEqual(groupIds(delivery, 'monthly'), ['workflow', 'salestax']);
  assert.deepEqual(groupIds(delivery, 'yearend'), ['yearendcheck', 'form1099']);
  assert.deepEqual(delivery.groups.map((g) => g.label), ['Monthly Tasks', 'Year-End Tasks'],
    'group labels come from the defaults — they are global in sidebar_settings');
});

test('a stored grouped order is PRESERVED, which is the whole point of v5', () => {
  const stored = [{
    id: 'delivery', label: 'Client Management & Delivery', number: '03', desc: '',
    tabs: [{ id: 'salestax', label: 'Sales Tax' }, { id: 'workflow', label: 'Monthly Workflow' }],
    groups: [
      { key: 'monthly', tabIds: ['salestax', 'workflow'] },
      { key: 'yearend', tabIds: ['form1099', 'yearendcheck'] },
    ],
  }];
  const delivery = deliveryOf(mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK));
  assert.deepEqual(groupIds(delivery, 'monthly'), ['salestax', 'workflow'],
    'the user reversed this group; it must survive a reload');
  assert.deepEqual(groupIds(delivery, 'yearend'), ['form1099', 'yearendcheck']);
});

test('a grouped stage derives tabs from its groups, so the icon rail cannot disagree', () => {
  const stored = [{
    id: 'delivery', label: 'Client Management & Delivery', number: '03', desc: '',
    // stage.tabs deliberately disagrees with groups — the rail used to render THIS order
    tabs: [{ id: 'form1099' }, { id: 'workflow' }, { id: 'yearendcheck' }, { id: 'salestax' }],
    groups: [
      { key: 'monthly', tabIds: ['salestax', 'workflow'] },
      { key: 'yearend', tabIds: ['form1099', 'yearendcheck'] },
    ],
  }];
  const delivery = deliveryOf(mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK));
  assert.deepEqual(delivery.tabs.map((t) => t.id),
    ['salestax', 'workflow', 'form1099', 'yearendcheck'],
    'tabs must follow groups[].tabIds, not the stored tabs array');
});

test('a duplicated id in a stored group collapses to one, keeping the first position', () => {
  const stored = [{
    id: 'delivery', label: 'x', number: '03', desc: '', tabs: [],
    groups: [{ key: 'monthly', tabIds: ['salestax', 'workflow', 'salestax'] }],
  }];
  const delivery = deliveryOf(mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK));
  assert.deepEqual(groupIds(delivery, 'monthly'), ['salestax', 'workflow']);
  assert.equal(idsOf([delivery]).length, new Set(idsOf([delivery])).size,
    'a duplicate must never render the same tab twice');
});

test('a tab stored under the WRONG group is returned to its canonical group', () => {
  const stored = [{
    id: 'delivery', label: 'x', number: '03', desc: '', tabs: [],
    groups: [
      { key: 'monthly', tabIds: ['workflow', 'form1099', 'salestax'] }, // form1099 is Year-End
      { key: 'yearend', tabIds: ['yearendcheck'] },
    ],
  }];
  const delivery = deliveryOf(mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK));
  assert.deepEqual(groupIds(delivery, 'monthly'), ['workflow', 'salestax'],
    'the interloper is rejected, and the rest of the stored order survives');
  assert.deepEqual(groupIds(delivery, 'yearend'), ['yearendcheck', 'form1099'],
    'it is re-inserted where the defaults put it, not dropped');
});

test('malformed group data degrades to the defaults instead of throwing', () => {
  for (const groups of [null, 'nope', 42, [null], [{}], [{ key: 'monthly' }],
    [{ key: 'monthly', tabIds: 'salestax' }], [{ key: 'ghost', tabIds: ['workflow'] }]]) {
    const stored = [{ id: 'delivery', label: 'x', number: '03', desc: '', tabs: [], groups }];
    const delivery = deliveryOf(mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK));
    assert.deepEqual(delivery.groups.map((g) => g.key), ['monthly', 'yearend']);
    assert.deepEqual(idsOf([delivery]).sort(),
      ['form1099', 'salestax', 'workflow', 'yearendcheck'],
      `every tab must survive groups=${JSON.stringify(groups)}`);
  }
});

test('a tab named by no stored group is still rendered exactly once', () => {
  const stored = [{
    id: 'delivery', label: 'x', number: '03', desc: '', tabs: [],
    groups: [{ key: 'monthly', tabIds: ['salestax'] }],   // workflow + all of yearend missing
  }];
  const delivery = deliveryOf(mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK));
  const ids = idsOf([delivery]);
  assert.equal(ids.length, new Set(ids).size, 'no duplicates');
  assert.deepEqual(ids.slice().sort(), ['form1099', 'salestax', 'workflow', 'yearendcheck']);
  assert.deepEqual(groupIds(delivery, 'monthly'), ['workflow', 'salestax'],
    'workflow is the first default and has no surviving predecessor, so it returns to the '
    + 'front — default-RELATIVE placement, not appended');
});

test('an unknown STAGE id is dropped as well', () => {
  const stored = [...STORED_PRE_56, { id: 'ghoststage', label: 'Gone', tabs: [{ id: 'course' }] }];
  const merged = mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK);
  assert.ok(!merged.some((s) => s.id === 'ghoststage'));
});

test('a newly-shipped tab is inserted at its default position, not appended', () => {
  const stored = [{
    id: 'training', label: 'Training & Skills', number: '01', desc: '',
    tabs: [{ id: 'course', label: 'Accounting 101' }, { id: 'chat', label: 'ProAdvisor Chat' }],
  }];
  const merged = mergeStoredWithDefaults(stored, DEFAULTS, FALLBACK);
  const ids = merged.find((s) => s.id === 'training').tabs.map((t) => t.id);
  assert.deepEqual(ids, ['course', 'qbomastery', 'chat'],
    'qbomastery belongs after course, where DEFAULT_STAGES puts it');
});

test('a new tab in a GROUPED stage joins its group at the default position', () => {
  // The v5 form of the old "no SIDEBAR_VERSION bump needed" test. The mechanism changed
  // — the tab now arrives through reconcileGroup rather than through the tabs-insertion
  // loop — but the promise is the same and is what matters: shipping a tab into a
  // grouped stage needs no version bump and no storage migration.
  const stored = [{
    id: 'jobsearch', label: 'Job Application', number: '02', desc: 'Land US clients',
    tabs: [
      { id: 'resumestrategy', label: 'Resume Winning Strategy' },
      { id: 'linkedinopt', label: 'Book 1-on-1 with Alex' },
    ],
    groups: [
      { key: 'profile-opt', tabIds: ['resumestrategy', 'linkedinopt'] },
      { key: 'interview', tabIds: ['interview', 'coachalex', 'qbdiag'] },
    ],
  }];
  const stage = mergeStoredWithDefaults(stored, JOBSEARCH_DEFAULTS, FALLBACK)
    .find((s) => s.id === 'jobsearch');
  assert.ok(stage, 'the stage itself must survive the merge');

  const tab = stage.tabs.find((t) => t.id === 'portfoliogenerator');
  assert.ok(tab, 'without an entry in stage.tabs the grouped render resolves tabById[id] '
    + 'to undefined and .filter(Boolean) drops the tab entirely');
  assert.equal(tab.icon, ICON, 'the icon always comes from the defaults, never from storage');
  assert.equal(tab.label, 'Portfolio Generator');
  assert.deepEqual(groupIds(stage, 'profile-opt'),
    ['resumestrategy', 'portfoliogenerator', 'linkedinopt'],
    'it belongs between its two siblings, where DEFAULT_STAGES puts it');
});

test('no stored layout at all falls back to the defaults untouched', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.equal(mergeStoredWithDefaults(bad, DEFAULTS, FALLBACK), DEFAULTS);
  }
});

// ── Serialization ───────────────────────────────────────────────────────────

test('stagesToStorable strips icons — they are components, not JSON', () => {
  const storable = stagesToStorable(DEFAULTS);
  assert.equal(JSON.parse(JSON.stringify(storable)).length, 2);
  for (const s of storable) {
    for (const t of s.tabs) {
      assert.deepEqual(Object.keys(t).sort(), ['id', 'label']);
    }
  }
});

test('stagesToStorable writes group KEYS and tabIds, and never a group label', () => {
  const storable = stagesToStorable(DEFAULTS);
  const training = storable.find((s) => s.id === 'training');
  assert.ok(!('groups' in training), 'a flat stage stores no groups key at all');

  const delivery = storable.find((s) => s.id === 'delivery');
  assert.deepEqual(delivery.groups, [
    { key: 'monthly', tabIds: ['workflow', 'salestax'] },
    { key: 'yearend', tabIds: ['yearendcheck', 'form1099'] },
  ]);
  for (const g of delivery.groups) {
    assert.deepEqual(Object.keys(g).sort(), ['key', 'tabIds'],
      'a group label is global in sidebar_settings; a per-browser copy would shadow an admin rename');
  }
});

test('a serialize → merge round trip is stable', () => {
  const once = mergeStoredWithDefaults(stagesToStorable(DEFAULTS), DEFAULTS, FALLBACK);
  const twice = mergeStoredWithDefaults(stagesToStorable(once), DEFAULTS, FALLBACK);
  assert.deepEqual(idsOf(twice), idsOf(once));
  assert.deepEqual(deliveryOf(twice).groups.map((g) => g.tabIds),
    deliveryOf(once).groups.map((g) => g.tabIds));
});

test('a reordered layout survives a serialize → merge round trip', () => {
  const moved = moveTabByStep(
    mergeStoredWithDefaults(stagesToStorable(DEFAULTS), DEFAULTS, FALLBACK),
    'delivery', 'salestax', -1,
  );
  assert.equal(moved.ok, true);
  const reloaded = mergeStoredWithDefaults(stagesToStorable(moved.stages), DEFAULTS, FALLBACK);
  assert.deepEqual(groupIds(deliveryOf(reloaded), 'monthly'), ['salestax', 'workflow'],
    'this is the end-to-end promise: drag, reload, still there');
});

// ── Version reconciliation ──────────────────────────────────────────────────

test('SIDEBAR_VERSION is an integer the loader can compare, and v5 or later', () => {
  assert.equal(typeof SIDEBAR_VERSION, 'number');
  assert.ok(Number.isInteger(SIDEBAR_VERSION) && SIDEBAR_VERSION > 0);
  assert.ok(SIDEBAR_VERSION >= 5, 'grouped order persistence landed in v5');
});

test('normalizeTabOrder re-sorts a FLAT stage to the default order and keeps renames', () => {
  const scrambled = [{
    id: 'training', label: 'Training & Skills',
    tabs: [
      { id: 'chat', label: 'ProAdvisor Chat', icon: ICON },
      { id: 'qbomastery', label: 'QBO', icon: ICON },
      { id: 'course', label: 'Accounting 101', icon: ICON },
    ],
  }];
  const sorted = normalizeTabOrder(scrambled, DEFAULTS);
  assert.deepEqual(sorted[0].tabs.map((t) => t.id), ['course', 'qbomastery', 'chat']);
  assert.equal(sorted[0].tabs[1].label, 'QBO', 'a user rename must not be reset by a re-sort');
});

test('normalizeTabOrder SKIPS a grouped stage, or a version bump would wipe a saved order', () => {
  const stages = mergeStoredWithDefaults([{
    id: 'delivery', label: 'x', number: '03', desc: '', tabs: [],
    groups: [{ key: 'monthly', tabIds: ['salestax', 'workflow'] }],
  }], DEFAULTS, FALLBACK);
  const after = normalizeTabOrder(stages, DEFAULTS);
  assert.deepEqual(groupIds(deliveryOf(after), 'monthly'), ['salestax', 'workflow'],
    'the reversed group must survive the one-time version pass');
  assert.deepEqual(deliveryOf(after).tabs.map((t) => t.id),
    deliveryOf(stages).tabs.map((t) => t.id),
    'and tabs must stay in step with groups');
});

test('reconcileRenamedLabels only overwrites a label still equal to the OLD default', () => {
  const stages = [{
    id: 'jobsearch',
    tabs: [
      { id: 'interview', label: 'Interview Prep' },       // untouched default -> renamed
      { id: 'proposal', label: 'My Cover Letters' },      // a real user rename -> kept
    ],
  }];
  const out = reconcileRenamedLabels(stages, RENAMED_TAB_LABELS);
  assert.equal(out[0].tabs[0].label, 'Job Interview Mastery');
  assert.equal(out[0].tabs[1].label, 'My Cover Letters');
});

test('a rename never changes ordering — order is keyed on stable ids', () => {
  // The visible labels in this product are admin overrides from sidebar_settings
  // ("HR and Client Positioning" is the tab id `interview`). Any ordering logic that
  // compared labels would reorder itself the moment an admin renamed something.
  const stored = [{
    id: 'jobsearch', label: 'Job Application', number: '02', desc: '',
    tabs: [
      { id: 'interview', label: 'HR and Client Positioning' },
      { id: 'coachalex', label: 'Book A Session With Alex' },
      { id: 'qbdiag', label: 'Free QB Diagnostic' },
    ],
    groups: [
      { key: 'profile-opt', tabIds: ['resumestrategy', 'portfoliogenerator', 'linkedinopt'] },
      { key: 'interview', tabIds: ['qbdiag', 'interview', 'coachalex'] },
    ],
  }];
  const stage = mergeStoredWithDefaults(stored, JOBSEARCH_DEFAULTS, FALLBACK)[0];
  assert.deepEqual(groupIds(stage, 'interview'), ['qbdiag', 'interview', 'coachalex'],
    'the stored id order wins regardless of what the labels say');
  assert.equal(stage.tabs.find((t) => t.id === 'interview').label, 'HR and Client Positioning');
});

// ── Moving ──────────────────────────────────────────────────────────────────

const jobsearch = () => mergeStoredWithDefaults(
  stagesToStorable(JOBSEARCH_DEFAULTS), JOBSEARCH_DEFAULTS, FALLBACK,
);

test('groupKeyOfTab and orderedSiblingIds describe the right neighbourhood', () => {
  const stage = jobsearch()[0];
  assert.equal(groupKeyOfTab(stage, 'coachalex'), 'interview');
  assert.equal(groupKeyOfTab(stage, 'resumestrategy'), 'profile-opt');
  assert.deepEqual(orderedSiblingIds(stage, 'coachalex'), ['interview', 'coachalex', 'qbdiag']);

  const flat = mergeStoredWithDefaults(stagesToStorable(DEFAULTS), DEFAULTS, FALLBACK)
    .find((s) => s.id === 'training');
  assert.equal(groupKeyOfTab(flat, 'course'), null, 'a flat stage has no group');
  assert.deepEqual(orderedSiblingIds(flat, 'course'), ['course', 'qbomastery', 'chat']);
});

test('Job Application: a tab moves within its group', () => {
  const r = moveTabByStep(jobsearch(), 'jobsearch', 'qbdiag', -1);
  assert.equal(r.ok, true);
  assert.deepEqual(groupIds(r.stages[0], 'interview'), ['interview', 'qbdiag', 'coachalex']);
  assert.deepEqual(r, { ...r, from: 2, to: 1, total: 3, groupKey: 'interview' });
  assert.deepEqual(groupIds(r.stages[0], 'profile-opt'),
    ['resumestrategy', 'portfoliogenerator', 'linkedinopt'], 'other groups are untouched');
});

test('Client Management: every group reorders, and tabs stay in step', () => {
  const start = mergeStoredWithDefaults(stagesToStorable(DEFAULTS), DEFAULTS, FALLBACK);
  const a = moveTabByStep(start, 'delivery', 'workflow', 1);
  assert.deepEqual(groupIds(deliveryOf(a.stages), 'monthly'), ['salestax', 'workflow']);
  const b = moveTabByStep(a.stages, 'delivery', 'form1099', -1);
  assert.deepEqual(groupIds(deliveryOf(b.stages), 'yearend'), ['form1099', 'yearendcheck']);
  assert.deepEqual(deliveryOf(b.stages).tabs.map((t) => t.id),
    ['salestax', 'workflow', 'form1099', 'yearendcheck'],
    'the derived tabs array follows both moves');
});

test('Training still reorders — the flat path is not a regression', () => {
  const start = mergeStoredWithDefaults(stagesToStorable(DEFAULTS), DEFAULTS, FALLBACK);
  const r = moveTabByStep(start, 'training', 'chat', -1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stages.find((s) => s.id === 'training').tabs.map((t) => t.id),
    ['course', 'chat', 'qbomastery']);
  assert.equal(r.groupKey, null);
});

test('a move at the boundary is refused, and refuses without mutating', () => {
  const start = jobsearch();
  const up = moveTabByStep(start, 'jobsearch', 'interview', -1);
  assert.equal(up.ok, false);
  assert.equal(up.reason, 'at-edge');
  assert.equal(up.stages, start, 'a refusal returns the SAME array, so no re-render or save');

  const down = moveTabByStep(start, 'jobsearch', 'qbdiag', 1);
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'at-edge');
});

test('a move of an unknown tab or stage, or a bad step, is refused', () => {
  const start = jobsearch();
  assert.equal(moveTabByStep(start, 'jobsearch', 'ghost', -1).reason, 'unknown-tab');
  assert.equal(moveTabByStep(start, 'ghost', 'qbdiag', -1).reason, 'unknown-stage');
  for (const bad of [0, 2, -2, NaN, null, undefined, {}, 'up']) {
    const r = moveTabByStep(start, 'jobsearch', 'coachalex', bad);
    assert.equal(r.ok, false, `step ${JSON.stringify(bad)} must be refused`);
    assert.equal(r.reason, 'bad-step');
    assert.equal(r.stages, start, 'a refused step must not clone the array');
  }
  // A numeric string coerces, deliberately: the handlers pass literals, and refusing
  // '1' would be a trap for no benefit.
  assert.equal(moveTabByStep(start, 'jobsearch', 'coachalex', '1').ok, true);
});

test('no move can lose, duplicate or relocate a tab', () => {
  let stages = jobsearch();
  const before = idsOf(stages).slice().sort();
  const canonical = Object.fromEntries(
    idsOf(stages).map((id) => [id, groupKeyOfTab(stages[0], id)]),
  );
  for (const id of ['qbdiag', 'interview', 'coachalex', 'linkedinopt', 'resumestrategy']) {
    for (const delta of [-1, 1, 1, -1]) {
      const r = moveTabByStep(stages, 'jobsearch', id, delta);
      if (r.ok) stages = r.stages;
    }
  }
  const after = idsOf(stages);
  assert.deepEqual(after.slice().sort(), before, 'the same tabs, no more and no fewer');
  assert.equal(after.length, new Set(after).size, 'no duplicates');
  for (const id of after) {
    assert.equal(groupKeyOfTab(stages[0], id), canonical[id],
      `${id} must still be in its canonical group`);
  }
});

// ── Drops ───────────────────────────────────────────────────────────────────

test('a same-group drop reorders, including across several places', () => {
  const r = reorderVerdict(jobsearch(), 'jobsearch', 'qbdiag', 'jobsearch', 'interview');
  assert.equal(r.ok, true);
  assert.deepEqual(groupIds(r.stages[0], 'interview'), ['qbdiag', 'interview', 'coachalex'],
    'a two-place drag moves the whole distance, not one step');
});

test('a CROSS-GROUP drop is refused and changes nothing', () => {
  const start = jobsearch();
  const r = reorderVerdict(start, 'jobsearch', 'qbdiag', 'jobsearch', 'resumestrategy');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cross-group');
  assert.equal(r.stages, start);
  assert.ok(REORDER_REFUSALS[r.reason], 'every refusal reason needs copy the sidebar can show');
});

test('a CROSS-STAGE drop is refused — this is how a tab used to disappear', () => {
  // Before v5 this spliced the tab out of one stage.tabs and into another. In a grouped
  // stage the tab then belonged to no group's tabIds, and the render is
  // `g.tabIds.map(id => tabById[id]).filter(Boolean)` — so it vanished with no error.
  const start = mergeStoredWithDefaults(stagesToStorable(DEFAULTS), DEFAULTS, FALLBACK);
  const r = reorderVerdict(start, 'training', 'chat', 'delivery', 'workflow');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cross-stage');
  assert.equal(r.stages, start);
  assert.deepEqual(idsOf(start).slice().sort(),
    ['chat', 'course', 'form1099', 'qbomastery', 'salestax', 'workflow', 'yearendcheck'],
    'nothing was lost');
});

test('a drop onto itself, or onto nothing, is a no-op', () => {
  const start = jobsearch();
  for (const [src, tgt] of [['qbdiag', 'qbdiag'], [null, 'qbdiag'], [undefined, 'interview']]) {
    const r = reorderVerdict(start, 'jobsearch', src, 'jobsearch', tgt);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'noop');
    assert.equal(r.stages, start);
  }
});

test('every refusal reason has user-facing copy', () => {
  for (const reason of ['cross-group', 'cross-stage', 'unknown-tab', 'unknown-stage',
    'at-edge', 'bad-step']) {
    assert.equal(typeof REORDER_REFUSALS[reason], 'string');
    assert.ok(REORDER_REFUSALS[reason].length > 10, `${reason} needs a real sentence`);
  }
});

// ── Entitlement filtering ───────────────────────────────────────────────────

test('entitlement filtering preserves the relative order inside a group', () => {
  // A Sampler sees a subset. filterStagesForEntitlement prunes ids but must never
  // reorder what is left, or a plan change would silently rearrange the sidebar.
  const stages = mergeStoredWithDefaults([{
    id: 'jobsearch', label: 'Job Application', number: '02', desc: '', tabs: [],
    groups: [
      { key: 'profile-opt', tabIds: ['linkedinopt', 'portfoliogenerator', 'resumestrategy'] },
      { key: 'interview', tabIds: ['qbdiag', 'coachalex', 'interview'] },
    ],
  }], JOBSEARCH_DEFAULTS, FALLBACK);

  const sampler = planEntitlement('sampler');
  const filtered = filterStagesForEntitlement(stages, sampler);
  const stage = filtered.find((s) => s.id === 'jobsearch');
  if (!stage) return;  // a plan that sees none of this stage is a valid outcome

  for (const g of stage.groups) {
    const before = groupIds(stages[0], g.key).filter((id) => g.tabIds.includes(id));
    assert.deepEqual(g.tabIds, before,
      `${g.key}: filtering may remove ids but must never reorder the survivors`);
  }
});

// ── The shipped defaults ────────────────────────────────────────────────────

test('the real DEFAULT_STAGES puts `interview` before `coachalex`', () => {
  // ★ BY STABLE ID, NEVER BY LABEL. What the owner sees is "HR and Client Positioning"
  //   above "Book A Session With Alex", but both of those strings are admin overrides
  //   living in sidebar_settings — the code labels are different, and either can be
  //   renamed at any time. Asserting on the ids is the only stable form of this claim.
  const src = readFileSync(
    fileURLToPath(new URL('../src/BookkeeperPro.jsx', import.meta.url)), 'utf8',
  );
  const m = /\{\s*key:\s*'interview',\s*label:[^,]+,\s*tabIds:\s*\[([^\]]+)\]/.exec(src);
  assert.ok(m, "the jobsearch 'interview' group was not found in DEFAULT_STAGES");
  const ids = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(ids, ['interview', 'coachalex', 'qbdiag'],
    'the owner asked for HR and Client Positioning (id `interview`) to come first');
});

test('every tab of a grouped stage is named by exactly one group', () => {
  // ★ THE INVARIANT NOTHING ELSE CHECKS, AND IT IS SILENT WHEN IT BREAKS. For a grouped
  //   stage the sidebar renders `groups[].tabIds`, and mergeStoredWithDefaults DERIVES
  //   `tabs` from the same array. So a tab added to a stage's `tabs` registry but
  //   forgotten in a group's `tabIds` appears in neither the expanded nav nor the icon
  //   rail: it is shipped, routable, and invisible, with no error anywhere. The reverse —
  //   an id in a group with no entry in `tabs` — loses the tab's icon and label.
  const src = readFileSync(
    fileURLToPath(new URL('../src/BookkeeperPro.jsx', import.meta.url)), 'utf8',
  );
  const at = src.indexOf('const DEFAULT_STAGES');
  assert.ok(at > 0, 'DEFAULT_STAGES moved');
  const region = src.slice(at, src.indexOf('\n  ];', at) + 5);

  // Each stage opens `id: '…', label: '…', number: '…'`; slice the region between heads.
  const HEAD = /id: '(\w+)',\s*\n\s*label: '[^']*',\s*\n\s*number:/g;
  const heads = [...region.matchAll(HEAD)].map((m2) => ({ id: m2[1], at: m2.index }));
  assert.deepEqual(heads.map((h) => h.id), ['home', 'training', 'jobsearch', 'delivery'],
    'the shipped stages changed — update this test deliberately, do not loosen it');

  let grouped = 0;
  heads.forEach((head, i) => {
    const slice = region.slice(head.at, i + 1 < heads.length ? heads[i + 1].at : region.length);

    const groupBlocks = [...slice.matchAll(/key: '[\w-]+',\s*label:[^,]+,\s*tabIds: \[([^\]]*)\]/g)];
    if (!groupBlocks.length) return; // a flat stage has no groups to disagree with
    grouped += 1;

    const inGroups = groupBlocks
      .flatMap((g) => g[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')))
      .filter(Boolean);
    const registry = [...slice.matchAll(/\{ id: '(\w+)',\s*label: '[^']*',\s*icon:/g)].map((m2) => m2[1]);
    assert.ok(registry.length > 0, `${head.id}: no tab registry found`);

    assert.deepEqual([...inGroups].sort(), [...new Set(inGroups)].sort(),
      `${head.id}: a tab id appears in more than one group`);
    assert.deepEqual([...registry].sort(), [...inGroups].sort(),
      `${head.id}: its groups and its tab registry must name exactly the same ids — `
      + 'a tab in one and not the other is invisible or unlabelled, silently');
  });
  assert.equal(grouped, 2, 'both grouped stages must actually have been checked');
});

// ── Whole stages ────────────────────────────────────────────────────────────

/** Four stages, like the shipped sidebar — two is not enough to move one into the middle. */
const FOUR = [
  { id: 'home', label: 'Home', number: '', desc: '', tabs: [{ id: 'dashboard', label: 'Dashboard', icon: ICON }] },
  ...DEFAULTS,
  { id: 'jobsearch', label: 'Job Application', number: '02', desc: '', groups: JOBSEARCH_GROUPS, tabs: JOBSEARCH_DEFAULTS[0].tabs },
];

test('moveStageByStep moves one section and refuses at the ends', () => {
  const stages = mergeStoredWithDefaults(null, FOUR, ICON);
  const ids = stages.map((s) => s.id);
  assert.equal(ids.length, 4);

  const down = moveStageByStep(stages, ids[0], 1);
  assert.equal(down.ok, true);
  assert.deepEqual(down.stages.map((s) => s.id), [ids[1], ids[0], ...ids.slice(2)]);
  assert.equal(down.total, ids.length);
  assert.equal(down.to, 1);

  const up = moveStageByStep(down.stages, ids[0], -1);
  assert.deepEqual(up.stages.map((s) => s.id), ids, 'up then down returns the original order');

  assert.equal(moveStageByStep(stages, ids[0], -1).reason, 'at-edge');
  assert.equal(moveStageByStep(stages, ids[ids.length - 1], 1).reason, 'at-edge');
  assert.equal(moveStageByStep(stages, 'nope', 1).reason, 'unknown-stage');
  assert.equal(moveStageByStep(stages, ids[0], 2).reason, 'bad-step');
  assert.equal(moveStageByStep(stages, ids[0], 0).reason, 'bad-step');

  // A refusal must return the list unchanged, not a copy that looks changed.
  assert.deepEqual(moveStageByStep(stages, ids[0], -1).stages.map((s) => s.id), ids);
});

test('stageReorderVerdict is the one arbiter for a stage drop', () => {
  const stages = mergeStoredWithDefaults(null, FOUR, ICON);
  const ids = stages.map((s) => s.id);

  const v = stageReorderVerdict(stages, ids[2], ids[0]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.stages.map((s) => s.id), [ids[2], ids[0], ids[1], ...ids.slice(3)]);

  assert.equal(stageReorderVerdict(stages, ids[0], ids[0]).reason, 'noop');
  assert.equal(stageReorderVerdict(stages, null, ids[0]).reason, 'noop');
  assert.equal(stageReorderVerdict(stages, ids[0], 'ghost').reason, 'unknown-stage');
  assert.equal(stageReorderVerdict(stages, 'ghost', ids[0]).reason, 'unknown-stage');

  // ★ NO STAGE MAY BE LOST OR DUPLICATED BY ANY MOVE — the property the hand-rolled
  //   splice it replaces was never checked for.
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      const r = stageReorderVerdict(stages, ids[i], ids[j]);
      const after = (r.ok ? r.stages : stages).map((s) => s.id);
      assert.deepEqual([...after].sort(), [...ids].sort(), `${ids[i]} onto ${ids[j]} lost a stage`);
      assert.equal(new Set(after).size, ids.length);
    }
  }
});

test('every stage refusal reason has wording a person can read', () => {
  const stages = mergeStoredWithDefaults(null, FOUR, ICON);
  const ids = stages.map((s) => s.id);
  const reasons = [
    moveStageByStep(stages, ids[0], -1).reason,
    moveStageByStep(stages, 'nope', 1).reason,
    moveStageByStep(stages, ids[0], 5).reason,
  ];
  for (const r of reasons) {
    assert.ok(STAGE_REORDER_REFUSALS[r], `no copy for the stage refusal "${r}"`);
    assert.match(STAGE_REORDER_REFUSALS[r], /\S/);
  }
  // The tab wording says "section" meaning a sub-heading; the stage wording means the
  // whole sidebar. They must not be the same strings.
  assert.notEqual(STAGE_REORDER_REFUSALS['at-edge'], REORDER_REFUSALS['at-edge']);
});
