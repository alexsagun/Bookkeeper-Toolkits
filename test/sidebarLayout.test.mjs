// test/sidebarLayout.test.mjs — stored sidebar layouts vs the code defaults (#56).
//
// ★ WHY THIS SUITE EXISTS. Order and collapse state are per-user in window.storage
//   (`sidebar:*`); LABELS are global and admin-controlled in Supabase. When a tool is
//   RETIRED nothing migrates that stored layout — the ONLY thing that stops a dead tab id
//   coming back is the `.filter(t => defaultTabById[t.id])` inside
//   mergeStoredWithDefaults(). That was an unverified claim in a comment until #56
//   retired three tools and needed it to be true.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEBAR_VERSION,
  RENAMED_TAB_LABELS,
  mergeStoredWithDefaults,
  normalizeTabOrder,
  reconcileRenamedLabels,
  stagesToStorable,
} from '../src/lib/sidebarLayout.js';

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
    ],
    tabs: [
      { id: 'workflow', label: 'Monthly Workflow', icon: ICON },
      { id: 'salestax', label: 'Sales Tax', icon: ICON },
    ],
  },
];

/** A layout saved before #56, still naming the three retired tools. */
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
    ],
  },
];

const idsOf = (stages) => stages.flatMap((s) => s.tabs.map((t) => t.id));

/**
 * The shape of the real Job Application stage's Profile Optimization group after the
 * Portfolio Generator was added between its two siblings. Mirrors DEFAULT_STAGES, and
 * exists to prove the claim that shipping a new tab into a GROUPED stage needs no
 * SIDEBAR_VERSION bump.
 */
const JOBSEARCH_GROUPS = [
  { key: 'profile-opt', label: 'Profile Optimization', tabIds: ['resumestrategy', 'portfoliogenerator', 'linkedinopt'] },
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
    ],
  },
];

test('a stored layout drops the three retired tab ids and keeps everything else', () => {
  const merged = mergeStoredWithDefaults(STORED_PRE_56, DEFAULTS, FALLBACK);
  const ids = idsOf(merged);
  for (const dead of ['niche', 'budgeting', 'forecasting']) {
    assert.ok(!ids.includes(dead),
      `${dead} was retired in #56 — a saved layout must not resurrect it`);
  }
  assert.deepEqual(ids.slice().sort(),
    ['chat', 'course', 'qbomastery', 'salestax', 'workflow'],
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

test('group tabIds come from the defaults, so a retired id leaves the group too', () => {
  const merged = mergeStoredWithDefaults(STORED_PRE_56, DEFAULTS, FALLBACK);
  const delivery = merged.find((s) => s.id === 'delivery');
  assert.deepEqual(delivery.groups, DEFAULTS[1].groups,
    'sub-group metadata is never read from storage');
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

test('no stored layout at all falls back to the defaults untouched', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.equal(mergeStoredWithDefaults(bad, DEFAULTS, FALLBACK), DEFAULTS);
  }
});

test('stagesToStorable strips icons — they are components, not JSON', () => {
  const storable = stagesToStorable(DEFAULTS);
  assert.equal(JSON.parse(JSON.stringify(storable)).length, 2);
  for (const s of storable) {
    for (const t of s.tabs) {
      assert.deepEqual(Object.keys(t).sort(), ['id', 'label']);
    }
  }
});

test('normalizeTabOrder re-sorts to the default order and keeps renames', () => {
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

test('a new tab in a GROUPED stage joins the group with no SIDEBAR_VERSION bump', () => {
  // ★ WHY THIS IS THE HONEST TEST. For a grouped stage, render order comes from
  //   `groups[].tabIds`, which mergeStoredWithDefaults ALWAYS takes from the defaults —
  //   so position inside the merged `tabs` array does not decide what the sidebar shows.
  //   What matters is that the tab OBJECT joins `tabs`, because the sidebar renders
  //   `g.tabIds.map(id => tabById[id]).filter(Boolean)` and tabById is built from
  //   stage.tabs. A tab named in the group but absent from tabs is silently dropped,
  //   with no error anywhere. The insertion loop that puts it there runs unconditionally
  //   at every stored version, which is what makes the no-bump claim true.
  const stored = [{
    id: 'jobsearch',
    label: 'Job Application',
    number: '02',
    desc: 'Land US clients',
    tabs: [
      { id: 'resumestrategy', label: 'Resume Winning Strategy' },
      { id: 'linkedinopt', label: 'Book 1-on-1 with Alex' },
    ],
  }];
  const merged = mergeStoredWithDefaults(stored, JOBSEARCH_DEFAULTS, FALLBACK);
  const stage = merged.find((s) => s.id === 'jobsearch');
  assert.ok(stage, 'the stage itself must survive the merge');

  const tab = stage.tabs.find((t) => t.id === 'portfoliogenerator');
  assert.ok(tab, 'without an entry in stage.tabs the grouped render resolves tabById[id] '
    + 'to undefined and .filter(Boolean) drops the tab entirely');
  assert.equal(tab.icon, ICON, 'the icon always comes from the defaults, never from storage');
  assert.equal(tab.label, 'Portfolio Generator');

  assert.deepEqual(stage.tabs.map((t) => t.id),
    ['resumestrategy', 'portfoliogenerator', 'linkedinopt'],
    'it belongs between its two siblings, where DEFAULT_STAGES puts it');
  assert.deepEqual(stage.groups, JOBSEARCH_GROUPS,
    'group tabIds always come from the defaults — which is the other half of why no '
    + 'SIDEBAR_VERSION bump is needed');
});

test('a user rename in a grouped stage still survives the new tab arriving', () => {
  const stored = [{
    id: 'jobsearch',
    label: 'Getting Hired',
    number: '02',
    desc: 'Land US clients',
    tabs: [
      { id: 'resumestrategy', label: 'My Resume Course' },
      { id: 'linkedinopt', label: 'Book 1-on-1 with Alex' },
    ],
  }];
  const stage = mergeStoredWithDefaults(stored, JOBSEARCH_DEFAULTS, FALLBACK)
    .find((s) => s.id === 'jobsearch');
  assert.equal(stage.label, 'Getting Hired', 'a renamed stage must not be reset by an addition');
  assert.equal(stage.tabs.find((t) => t.id === 'resumestrategy').label, 'My Resume Course');
});

test('SIDEBAR_VERSION is an integer the loader can compare', () => {
  assert.equal(typeof SIDEBAR_VERSION, 'number');
  assert.ok(Number.isInteger(SIDEBAR_VERSION) && SIDEBAR_VERSION > 0);
});
