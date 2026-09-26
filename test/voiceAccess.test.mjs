// test/voiceAccess.test.mjs — Toolkits Siri's identity, eligibility and speech rules.
//
// Three of these groups pin bugs that were live in production when this suite was
// written, so they are worth naming up front:
//
//   1. An active Operations Admin or Trainer saw NO voice assistant at all. The old
//      render gate was `profile?.is_admin || !REQUIRE_ENROLLMENT || enroll.state === 'pass'`,
//      and useEnrollmentGate resolves `enroll.state` to 'paywall' for every staff
//      account by construction (it sets active = false when staffBypassesPaywall is
//      true), so neither arm could ever fire for them.
//   2. Any account with a blank full_name had its EMAIL ADDRESS sent to ElevenLabs
//      as the `user_name` dynamic variable, and spoken back by the agent.
//   3. api/elevenlabs/signed-url.js minted a paid session for any signed-in caller
//      whenever is_enrolled() was indeterminate — a lapsed member included.
//
// voiceSessionVerdict is the one function here that gates anything real. Its full
// 3x3 grid is pinned below, and inverting any cell must turn this suite red.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_ASSISTANT_NAME,
  VOICE_ASSISTANT_SHORT_NAME,
  VOICE_PRIVACY_NOTICE,
  VOICE_ROLES,
  VOICE_SESSION,
  adminScreensForRole,
  appendVoiceTranscript,
  voiceDisplayName,
  voiceEligibility,
  voiceMembershipSummary,
  voiceNavigationVerdict,
  voiceRole,
  voiceRoleLabel,
  voiceSessionVerdict,
} from '../src/lib/voiceAccess.js';
import {
  ADMIN_TAB_PERMISSION,
  EMPTY_STAFF_CONTEXT,
  ROLE_PERMISSIONS,
  STAFF_ROLE_KEYS,
  normalizeStaffContext,
} from '../src/lib/staffRoles.js';

// A live context, the way my_staff_context() delivers it.
const ctxFor = (roleKey, status = 'active') => normalizeStaffContext({ role_key: roleKey, status });
const SUPER = ctxFor('super_admin');
const OPS = ctxFor('operations_admin');
const TRAINER = ctxFor('trainer');

// ── Identity ────────────────────────────────────────────────────────────────

test('the short name is a substring of the canonical name', () => {
  // The provisioner greps the system prompt for the SHORT name before it will
  // publish one. If the two drift apart the sentinel stops guarding the name.
  assert.ok(VOICE_ASSISTANT_NAME.includes(VOICE_ASSISTANT_SHORT_NAME));
  assert.ok(VOICE_ASSISTANT_SHORT_NAME.length >= 4);
});

test('the assistant never claims an Apple affiliation', () => {
  const blob = [VOICE_ASSISTANT_NAME, ...VOICE_PRIVACY_NOTICE].join(' ');
  assert.ok(!/apple|iphone|ios\b/i.test(blob));
});

test('voiceRole resolves every role, and fails to member rather than guessing', () => {
  assert.equal(voiceRole({ staff: SUPER, staffReady: true }), 'super_admin');
  assert.equal(voiceRole({ staff: OPS, staffReady: true }), 'operations_admin');
  assert.equal(voiceRole({ staff: TRAINER, staffReady: true }), 'trainer');
  assert.equal(voiceRole({ staff: EMPTY_STAFF_CONTEXT, staffReady: true }), 'member');
  assert.equal(voiceRole({}), 'member');
  assert.equal(voiceRole(), 'member');
});

test('voiceRole: absent permission data means member, not a guess', () => {
  // staffReady false = my_staff_context() has not answered. Reporting a role we
  // have not read would be the pre-#40 community bug (re-derive and fail open).
  assert.equal(voiceRole({ staff: OPS, staffReady: false }), 'member');
  assert.equal(voiceRole({ staff: TRAINER, staffReady: false }), 'member');
});

test('voiceRole: degraded falls back to the legacy is_admin cache, which means super_admin', () => {
  assert.equal(voiceRole({ staffDegraded: true, profileIsAdmin: true }), 'super_admin');
  assert.equal(voiceRole({ staffDegraded: true, profileIsAdmin: false }), 'member');
  // Even with a live Ops context, degraded means we do not trust it.
  assert.equal(voiceRole({ staff: OPS, staffReady: true, staffDegraded: true, profileIsAdmin: false }), 'member');
});

test('voiceRole: a non-active membership confers no role', () => {
  for (const status of ['invited', 'suspended', 'revoked']) {
    assert.equal(voiceRole({ staff: ctxFor('operations_admin', status), staffReady: true }), 'member', status);
  }
});

test('voiceRole only ever returns a value the agent prompt knows', () => {
  const inputs = [
    { staff: normalizeStaffContext({ role_key: 'future_role', status: 'active' }), staffReady: true },
    { staff: SUPER, staffReady: true }, { staff: OPS, staffReady: true },
    { staff: TRAINER, staffReady: true }, {}, { profileIsAdmin: true },
  ];
  for (const i of inputs) assert.ok(VOICE_ROLES.includes(voiceRole(i)), JSON.stringify(i));
});

test('voiceRoleLabel names every role', () => {
  assert.equal(voiceRoleLabel('member'), 'Member');
  assert.equal(voiceRoleLabel('super_admin'), 'Super Admin');
  assert.equal(voiceRoleLabel('operations_admin'), 'Operations Admin');
  assert.equal(voiceRoleLabel('trainer'), 'Trainer');
  assert.equal(voiceRoleLabel(null), 'Member');
});

// ── Display name: the email leak ────────────────────────────────────────────

test('voiceDisplayName returns a first name', () => {
  assert.equal(voiceDisplayName({ fullName: 'Emmanuel Aquino' }), 'Emmanuel');
  assert.equal(voiceDisplayName({ fullName: '  Grace  ' }), 'Grace');
  assert.equal(voiceDisplayName({ fullName: "Mary-Anne O'Brien" }), 'Mary-Anne');
});

test('voiceDisplayName drops honorifics', () => {
  assert.equal(voiceDisplayName({ fullName: 'Dr. María José Cruz' }), 'María');
  assert.equal(voiceDisplayName({ fullName: 'Engr. Paolo Reyes' }), 'Paolo');
  assert.equal(voiceDisplayName({ fullName: 'Atty Liza Santos' }), 'Liza');
});

test('voiceDisplayName falls back to a neutral word, never an address', () => {
  assert.equal(voiceDisplayName({ fullName: '' }), 'there');
  assert.equal(voiceDisplayName({ fullName: '   ' }), 'there');
  assert.equal(voiceDisplayName({}), 'there');
  assert.equal(voiceDisplayName(), 'there');
  // The email parameter is accepted and deliberately ignored — this is the bug.
  assert.equal(voiceDisplayName({ fullName: null, email: 'alex@example.com' }), 'there');
  assert.equal(voiceDisplayName({ fullName: 'alex@example.com' }), 'there');
});

test('voiceDisplayName: NO input produces an address (property)', () => {
  const samples = [
    'alex@example.com', 'Dr. alex@example.com', '  @  ', 'a@b', 'Mr. @', '@@@',
    'Dr.', 'Mr. Mrs. Ms.', '...', '###', 'x'.repeat(500), 'María@José',
    null, undefined, 0, false, {}, [], 'Ana Maria', 'ålöf',
  ];
  for (const fullName of samples) {
    const out = voiceDisplayName({ fullName, email: 'leak@example.com' });
    assert.equal(typeof out, 'string', String(fullName));
    assert.ok(!out.includes('@'), `leaked for input ${JSON.stringify(fullName)}: ${out}`);
    assert.ok(out.length > 0 && out.length <= 40, `bad length for ${JSON.stringify(fullName)}`);
  }
});

// ── Which screens a role may open ───────────────────────────────────────────

test('adminScreensForRole is derived from the real permission matrix', () => {
  const all = Object.keys(ADMIN_TAB_PERMISSION);
  assert.deepEqual(adminScreensForRole('super_admin'), all);
  assert.deepEqual(adminScreensForRole('operations_admin'),
    ['accessrequests', 'enrollments', 'batches']);   // #67: Student Imports is Super Admin only
  // A Trainer holds courses.* and community.* — no admin-tab permission at all.
  assert.deepEqual(adminScreensForRole('trainer'), []);
  assert.deepEqual(adminScreensForRole('member'), []);
  assert.deepEqual(adminScreensForRole(null), []);
  assert.deepEqual(adminScreensForRole('nope'), []);
});

test('adminScreensForRole agrees with ROLE_PERMISSIONS for every non-super role', () => {
  for (const role of STAFF_ROLE_KEYS) {
    if (role === 'super_admin') continue;
    const held = ROLE_PERMISSIONS[role];
    const expected = Object.keys(ADMIN_TAB_PERMISSION).filter((t) => held.includes(ADMIN_TAB_PERMISSION[t]));
    assert.deepEqual(adminScreensForRole(role), expected, role);
  }
});

test('adminScreensForRole accepts a live context and honours the SERVER permission list', () => {
  assert.deepEqual(adminScreensForRole(OPS), ['accessrequests', 'enrollments', 'batches']);
  assert.deepEqual(adminScreensForRole(EMPTY_STAFF_CONTEXT), []);
  // A Super Admin gets every key even for a permission no migration has created
  // yet — the adminTabVisible() isSuperAdmin arm, which is why Financial
  // Management hid itself from its own owner on 2026-09-14.
  const partialSuper = normalizeStaffContext({ role_key: 'super_admin', status: 'active', permissions: ['staff.manage'] });
  assert.deepEqual(adminScreensForRole(partialSuper), Object.keys(ADMIN_TAB_PERMISSION));
  // An operator-added SQL grant is honoured over this file's matrix.
  const widened = normalizeStaffContext({
    role_key: 'trainer', status: 'active', permissions: [...ROLE_PERMISSIONS.trainer, 'batches.manage'],
  });
  assert.deepEqual(adminScreensForRole(widened), ['batches']);
});

test('adminScreensForRole gives a non-active membership nothing', () => {
  for (const status of ['invited', 'suspended', 'revoked']) {
    assert.deepEqual(adminScreensForRole(ctxFor('super_admin', status)), [], status);
  }
});

// ── Eligibility: the render gate ────────────────────────────────────────────

const base = {
  hasSession: true, requireEnrollment: true, enrollConfigured: true,
  enrollReady: true, enrollState: 'paywall', profileIsAdmin: false,
  staff: EMPTY_STAFF_CONTEXT, staffReady: true, staffDegraded: false,
};

test('an anonymous visitor gets nothing', () => {
  assert.equal(voiceEligibility({ ...base, hasSession: false }).allow, false);
  assert.equal(voiceEligibility({}).code, 'signed_out');
});

test('a paying member with an active term gets the assistant', () => {
  const v = voiceEligibility({ ...base, enrollState: 'pass' });
  assert.equal(v.allow, true);
  assert.equal(v.code, 'member');
  assert.equal(v.role, 'member');
});

test('ACTIVE STAFF GET THE ASSISTANT EVEN THOUGH enrollState IS paywall', () => {
  // The shipped bug. useEnrollmentGate sets active=false for staff, so enrollState
  // is 'paywall' for every Ops Admin and Trainer — the staff arm must not read it.
  for (const [ctx, role] of [[SUPER, 'super_admin'], [OPS, 'operations_admin'], [TRAINER, 'trainer']]) {
    const v = voiceEligibility({ ...base, staff: ctx, enrollState: 'paywall' });
    assert.equal(v.allow, true, role);
    assert.equal(v.code, 'staff', role);
    assert.equal(v.role, role);
  }
});

test('an unpaid ordinary account is refused in every non-passing state', () => {
  for (const state of ['paywall', 'paywall_notice', 'pending', 'expired', 'renew_pending', 'finalizing', null]) {
    const v = voiceEligibility({ ...base, enrollState: state });
    assert.equal(v.allow, false, `state=${state}`);
    assert.equal(v.code, 'no_active_membership', `state=${state}`);
  }
});

test('a pending staff INVITEE is refused — an invitation is not authority', () => {
  const v = voiceEligibility({ ...base, staff: ctxFor('operations_admin', 'invited') });
  assert.equal(v.allow, false);
  assert.equal(v.role, 'member');
});

test('suspended and revoked staff are refused', () => {
  for (const status of ['suspended', 'revoked']) {
    for (const role of STAFF_ROLE_KEYS) {
      const v = voiceEligibility({ ...base, staff: ctxFor(role, status) });
      assert.equal(v.allow, false, `${role}/${status}`);
    }
  }
});

test('a NON-NORMALIZED context with a dead status is still refused', () => {
  // Defence in depth, and it needs its own test: every fixture above goes through
  // normalizeStaffContext(), which already collapses a non-active membership to
  // the empty context — so those tests prove normalizeStaffContext works, not that
  // this gate re-checks the status. Mutation-testing caught exactly that gap.
  // AuthProvider does normalize, but this gate must not DEPEND on it.
  for (const status of ['invited', 'suspended', 'revoked', null]) {
    const raw = { isStaff: true, roleKey: 'operations_admin', roleLabel: 'Operations Admin', status, permissions: ['enrollments.review'] };
    const v = voiceEligibility({ ...base, staff: raw });
    assert.equal(v.allow, false, `status=${status}`);
    assert.equal(v.role, 'member', `status=${status}`);
  }
  // …and the live one still passes, so the guard is a status check, not a blanket no.
  const live = { isStaff: true, roleKey: 'operations_admin', status: 'active', permissions: ['enrollments.review'] };
  assert.equal(voiceEligibility({ ...base, staff: live }).allow, true);
});

test('voiceSessionVerdict re-checks the status of a non-normalized context too', () => {
  for (const status of ['invited', 'suspended', 'revoked']) {
    const staff = { context: { isStaff: true, roleKey: 'super_admin', status }, degraded: false, missing: false };
    assert.equal(voiceSessionVerdict({ enrolled: false, staff }).status, 403, status);
  }
});

test('a rejected account is refused ahead of everything, staff included', () => {
  // A ban cannot be paid around, and accept_staff_invitation() refuses a rejected
  // profile server-side for exactly the same reason.
  assert.equal(voiceEligibility({ ...base, approvalStatus: 'rejected', enrollState: 'pass' }).allow, false);
  assert.equal(voiceEligibility({ ...base, approvalStatus: 'rejected', staff: SUPER }).code, 'account_rejected');
  assert.equal(voiceEligibility({ ...base, approvalStatus: 'rejected', profileIsAdmin: true }).allow, false);
});

test('the staff arm fails closed while my_staff_context() is in flight', () => {
  const v = voiceEligibility({ ...base, staff: OPS, staffReady: false });
  assert.equal(v.allow, false);
  assert.equal(v.role, 'member');
});

test('a degraded staff context falls back to is_admin, never to "assume staff"', () => {
  assert.equal(voiceEligibility({ ...base, staffDegraded: true, profileIsAdmin: true }).allow, true);
  assert.equal(voiceEligibility({ ...base, staff: OPS, staffDegraded: true, profileIsAdmin: false }).allow, false);
});

test('the legacy is_admin cache still opens the assistant', () => {
  // profiles.is_admin means "active super_admin" since #45 and lands before the RPC.
  const v = voiceEligibility({ ...base, profileIsAdmin: true, staffReady: false });
  assert.equal(v.allow, true);
  assert.equal(v.role, 'super_admin');
});

test('flag-off and pre-migration installs keep the assistant', () => {
  assert.equal(voiceEligibility({ ...base, requireEnrollment: false }).code, 'enrollment_disabled');
  assert.equal(voiceEligibility({ ...base, enrollConfigured: false }).code, 'enrollment_not_configured');
});

test('voiceEligibility always reports a role from the known set', () => {
  for (const staff of [EMPTY_STAFF_CONTEXT, SUPER, OPS, TRAINER, null]) {
    for (const ready of [true, false]) {
      const v = voiceEligibility({ ...base, staff, staffReady: ready });
      assert.ok(VOICE_ROLES.includes(v.role));
      assert.equal(typeof v.allow, 'boolean');
      assert.equal(typeof v.code, 'string');
    }
  }
});

// ── The server boundary ─────────────────────────────────────────────────────

const rpc = {
  staff: { context: OPS, degraded: false, missing: false },
  notStaff: { context: EMPTY_STAFF_CONTEXT, degraded: false, missing: false },
  degraded: { context: EMPTY_STAFF_CONTEXT, degraded: true, missing: false },
  missing: { context: EMPTY_STAFF_CONTEXT, degraded: true, missing: true },
};

test('voiceSessionVerdict: the full 3x3 grid', () => {
  const grid = [
    // enrolled,   staff rpc,      decision,      status, grant
    [true, rpc.staff, 'allow', 200, 'staff'],
    [true, rpc.notStaff, 'allow', 200, 'member'],
    [true, rpc.degraded, 'allow', 200, 'member'],
    [false, rpc.staff, 'allow', 200, 'staff'],
    [false, rpc.notStaff, 'deny', 403, null],
    [false, rpc.degraded, 'unavailable', 503, null],
    [null, rpc.staff, 'allow', 200, 'staff'],
    [null, rpc.notStaff, 'unavailable', 503, null],
    [null, rpc.degraded, 'unavailable', 503, null],
  ];
  for (const [enrolled, staff, decision, status, grant] of grid) {
    const v = voiceSessionVerdict({ enrolled, staff });
    const label = `enrolled=${enrolled} staff=${staff === rpc.staff ? 'staff' : staff === rpc.notStaff ? 'not_staff' : 'degraded'}`;
    assert.equal(v.decision, decision, label);
    assert.equal(v.status, status, label);
    assert.equal(v.grant, grant, label);
  }
});

test('voiceSessionVerdict NEVER mints on an indeterminate check', () => {
  // The reversal of the original fail-open design. A signed-in non-member must
  // not get a metered session because Supabase was slow.
  for (const staff of [rpc.notStaff, rpc.degraded, null, undefined, {}]) {
    for (const enrolled of [null, undefined, 'maybe', 0, 1]) {
      const v = voiceSessionVerdict({ enrolled, staff });
      if (v.decision === VOICE_SESSION.ALLOW) {
        assert.fail(`minted on enrolled=${String(enrolled)} staff=${JSON.stringify(staff)}`);
      }
      assert.equal(v.grant, null);
    }
  }
});

test('voiceSessionVerdict: a MISSING function is a definite negative, not indeterminate', () => {
  // A pre-#45 database has no staff model, and is_enrolled() already returns true
  // for admins there — so 503-ing this class forever would be wrong. Mirrors
  // staffAuthVerdict()'s "only a MISSING function earns a second look".
  const v = voiceSessionVerdict({ enrolled: false, staff: rpc.missing });
  assert.equal(v.decision, VOICE_SESSION.DENY);
  assert.equal(v.status, 403);
  assert.deepEqual([...v.indeterminate], []);
  assert.equal(voiceSessionVerdict({ enrolled: true, staff: rpc.missing }).decision, VOICE_SESSION.ALLOW);
});

test('voiceSessionVerdict names which checks were indeterminate', () => {
  assert.deepEqual([...voiceSessionVerdict({ enrolled: null, staff: rpc.notStaff }).indeterminate], ['is_enrolled']);
  assert.deepEqual([...voiceSessionVerdict({ enrolled: false, staff: rpc.degraded }).indeterminate], ['my_staff_context']);
  assert.deepEqual([...voiceSessionVerdict({}).indeterminate], ['is_enrolled', 'my_staff_context']);
});

test('voiceSessionVerdict: staff pass without a subscription, and carry their role', () => {
  for (const [role, ctx] of [['super_admin', SUPER], ['operations_admin', OPS], ['trainer', TRAINER]]) {
    const v = voiceSessionVerdict({ enrolled: false, staff: { context: ctx, degraded: false, missing: false } });
    assert.equal(v.decision, VOICE_SESSION.ALLOW, role);
    assert.equal(v.role, role);
  }
});

test('voiceSessionVerdict: a non-active membership is not staff', () => {
  for (const status of ['invited', 'suspended', 'revoked']) {
    const staff = { context: ctxFor('super_admin', status), degraded: false, missing: false };
    assert.equal(voiceSessionVerdict({ enrolled: false, staff }).status, 403, status);
  }
});

test('voiceSessionVerdict: 503 carries a retry hint, 403 does not', () => {
  assert.equal(voiceSessionVerdict({}).retryAfterSecs, 15);
  assert.equal(voiceSessionVerdict({ enrolled: false, staff: rpc.notStaff }).retryAfterSecs, null);
  assert.equal(voiceSessionVerdict({ enrolled: true, staff: rpc.notStaff }).retryAfterSecs, null);
});

// ── Navigation ──────────────────────────────────────────────────────────────

test('a staff screen is refused BEFORE navigating', () => {
  const v = voiceNavigationVerdict({
    tabId: 'financialmanagement', label: 'Financial Management', isAdminScreen: true, adminAllowed: false,
  });
  assert.equal(v.allow, false);
  assert.match(v.message, /staff screen/i);
  assert.equal(v.lockNote, null);
});

test('an Operations Admin reaches Enrollments but not Financial Management', () => {
  const ops = adminScreensForRole('operations_admin');
  const allow = (tab) => voiceNavigationVerdict({
    tabId: tab, label: tab, isAdminScreen: true, adminAllowed: ops.includes(tab),
  }).allow;
  assert.equal(allow('enrollments'), true);
  assert.equal(allow('accessrequests'), true);
  assert.equal(allow('financialmanagement'), false);
  assert.equal(allow('communications'), false);
  assert.equal(allow('staffroles'), false);
});

test('a Trainer reaches no admin screen at all', () => {
  const trainer = adminScreensForRole('trainer');
  for (const tab of Object.keys(ADMIN_TAB_PERMISSION)) {
    const v = voiceNavigationVerdict({ tabId: tab, label: tab, isAdminScreen: true, adminAllowed: trainer.includes(tab) });
    assert.equal(v.allow, false, tab);
  }
});

test('a PLAN-LOCKED tool still navigates, so RestrictedTab can offer the upgrade', () => {
  // Deliberate, and recorded in CLAUDE.md: "navigates even into a plan-restricted
  // tab — RestrictedTab's upsell is the chokepoint". Refusing here would leave a
  // Sampler who asked for Bank Feed AI with a "no" and nowhere to buy it.
  const v = voiceNavigationVerdict({
    tabId: 'bankfeed', label: 'Bank Feed AI', isAdminScreen: false,
    planAllowsTab: false, planLabel: 'Sampler Session', planScope: 'Essentials + coaching',
  });
  assert.equal(v.allow, true);
  assert.match(v.lockNote, /Sampler Session/);
  assert.match(v.lockNote, /upgrade panel/);
  assert.equal(v.message, null);
});

test('an allowed tool navigates with no note', () => {
  const v = voiceNavigationVerdict({ tabId: 'coa', label: 'Chart of Accounts' });
  assert.deepEqual(v, { allow: true, lockNote: null, message: null });
});

test('an unknown tab is refused rather than navigated', () => {
  assert.equal(voiceNavigationVerdict({}).allow, false);
  assert.equal(voiceNavigationVerdict({ tabId: null }).allow, false);
});

// ── The spoken membership summary ───────────────────────────────────────────

test('the summary has no parameter that could carry a name or an address', () => {
  // The fix for `Role: admin (${p.full_name || p.email})` is the ABSENCE of the
  // parameter, not a filter on it. Nothing here accepts one.
  const out = voiceMembershipSummary({ role: 'super_admin', adminScreenLabels: ['Enrollments'] });
  assert.ok(!out.includes('@'));
  assert.match(out, /Super Admin/);
});

test('a staff summary names the role and the real screens', () => {
  const out = voiceMembershipSummary({
    role: 'operations_admin', hasBillingPanels: false,
    adminScreenLabels: ['Access Requests', 'Enrollments', 'Batches'],
  });
  assert.match(out, /Operations Admin/);
  assert.match(out, /Enrollments/);
  assert.ok(!/Financial Management/.test(out));
  assert.match(out, /no subscription and no billing panels/);
});

test('a Trainer with no admin queues reads naturally', () => {
  const out = voiceMembershipSummary({ role: 'trainer', adminScreenLabels: [], hasBillingPanels: false });
  assert.match(out, /Trainer/);
  assert.ok(!/screens they can open: \./i.test(out), 'must not emit an empty list');
  assert.match(out, /course library/);
});

test('staff who also bought a plan get both halves', () => {
  const out = voiceMembershipSummary({
    role: 'operations_admin', adminScreenLabels: ['Enrollments'], hasBillingPanels: false,
    hasPlan: true, planLabel: 'Personalized Coaching Program', planScope: 'Full toolkit access',
    statusLabel: 'Active', valid: true, endDate: '12 March 2027', daysLeft: 140,
  });
  assert.match(out, /Operations Admin/);
  assert.match(out, /Personalized Coaching Program/);
  assert.match(out, /140 day/);
});

test('a member summary covers grace, expiry, legacy and a pending request', () => {
  const grace = voiceMembershipSummary({
    planLabel: 'QBO + Resume Combo', statusLabel: 'Grace period', inGrace: true,
    endDate: '4 April 2027', graceDaysLeft: 2,
  });
  assert.match(grace, /grace window until 4 April 2027/);
  assert.match(grace, /2 day/);

  assert.match(voiceMembershipSummary({ legacy: true, valid: true }), /no expiry date/);
  assert.match(voiceMembershipSummary({ expired: true }), /expired/);
  assert.match(voiceMembershipSummary({ pendingKind: 'review' }), /pending admin review/);
  assert.match(voiceMembershipSummary({ pendingKind: 'overdue' }), /resubmitted/);
  assert.match(voiceMembershipSummary({ planPrice: '₱2,999', planAccessDays: 60 }), /₱2,999 for 60 days/);
});

test('a member summary never mentions staff screens', () => {
  const out = voiceMembershipSummary({ role: 'member', planLabel: 'Sampler Session', statusLabel: 'Active' });
  assert.match(out, /Role: Member/);
  assert.ok(!/staff/i.test(out));
});

// ── Transcript de-duplication ───────────────────────────────────────────────

const localEcho = (list, text) => appendVoiceTranscript(list, { role: 'user', text });
const serverSays = (list, role, text, eventId) => appendVoiceTranscript(list, { role, text, eventId });

test('a typed message and its server echo collapse into one row', () => {
  // sendUserMessage only puts the text on the socket; the server replies with a
  // user_transcription_event, which the SDK surfaces as onMessage({source:'user'}).
  let t = [];
  t = localEcho(t, 'open bank feed');
  assert.equal(t.length, 1);
  t = serverSays(t, 'user', 'open bank feed', 'evt-1');
  assert.equal(t.length, 1, 'the echo must replace, not append');
  assert.equal(t[0].eventId, 'evt-1');
  assert.equal(t[0].pending, false);
});

test('the server text wins on a match — it is the canonical transcript', () => {
  let t = localEcho([], 'open  bank   feed ');
  t = serverSays(t, 'user', 'Open bank feed.', 'evt-1');
  assert.equal(t.length, 1);
  assert.equal(t[0].text, 'Open bank feed.');
});

test('two genuinely identical user turns both survive', () => {
  let t = [];
  t = localEcho(t, 'yes');
  t = serverSays(t, 'user', 'yes', 'evt-1');
  t = serverSays(t, 'agent', 'Great — which one?', 'evt-2');
  t = localEcho(t, 'yes');
  t = serverSays(t, 'user', 'yes', 'evt-3');
  // Three rows: the first "yes" collapsed with its echo, the agent, the second
  // "yes" collapsed with its own echo. Both user turns survive as distinct rows.
  assert.deepEqual(t.map((m) => m.role), ['user', 'agent', 'user']);
  assert.deepEqual(t.map((m) => m.eventId), ['evt-1', 'evt-2', 'evt-3']);
});

test('two rapid identical typed messages match their echoes FIFO', () => {
  let t = [];
  t = localEcho(t, 'yes');
  t = localEcho(t, 'yes');
  assert.equal(t.length, 2);
  t = serverSays(t, 'user', 'yes', 'evt-1');
  t = serverSays(t, 'user', 'yes', 'evt-2');
  assert.equal(t.length, 2, 'both echoes must land on their own pending row');
  assert.deepEqual(t.map((m) => m.eventId), ['evt-1', 'evt-2']);
});

test('a spoken turn with no local copy simply appends', () => {
  const t = serverSays([], 'user', 'what does this page do', 'evt-9');
  assert.equal(t.length, 1);
  assert.equal(t[0].pending, false);
});

test('a replayed event id is dropped — the reducer is idempotent', () => {
  let t = serverSays([], 'agent', 'Hello', 'evt-1');
  t = serverSays(t, 'agent', 'Hello', 'evt-1');
  t = serverSays(t, 'agent', 'Hello', 'evt-1');
  assert.equal(t.length, 1);
});

test('an agent message never consumes a pending user row', () => {
  let t = localEcho([], 'recap');
  t = serverSays(t, 'agent', 'recap', 'evt-1');
  assert.equal(t.length, 2);
});

test('the echo window is bounded, so an ancient pending row cannot swallow a later message', () => {
  let t = localEcho([], 'yes');
  for (let i = 0; i < 20; i += 1) t = serverSays(t, 'agent', `filler ${i}`, `f-${i}`);
  const before = t.length;
  t = serverSays(t, 'user', 'yes', 'evt-late');
  assert.equal(t.length, before + 1, 'must append, not reach back past the window');
});

test('empty text is ignored and the input array is never mutated', () => {
  const start = Object.freeze([]);
  assert.equal(appendVoiceTranscript(start, { role: 'user', text: '' }).length, 0);
  assert.equal(appendVoiceTranscript(start, {}).length, 0);
  const one = localEcho([], 'hi');
  const two = serverSays(one, 'agent', 'hello', 'e1');
  assert.equal(one.length, 1, 'the original array must be untouched');
  assert.equal(two.length, 2);
});
