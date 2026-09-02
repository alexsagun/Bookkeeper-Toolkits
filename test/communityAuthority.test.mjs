// test/communityAuthority.test.mjs — the client's Community authority predicates (#56).
//
// Until #56 the whole Community suite branched on one `isAdmin = !!profile?.is_admin`,
// which since #45 means "active Super Admin". That single flag stood for three different
// questions, and once Operations Admins and Trainers hold the community permissions the
// three answers can differ. communityAuthority() is the mirror that answers them.
//
// ★ THIS IS A MIRROR, NOT THE BOUNDARY. has_staff_permission() in the community RPCs and
//   RLS policies is the authorization. Hiding a control is a courtesy. What these tests
//   protect is the DIRECTION of failure: absent or unreadable permission data must mean
//   "no", never "yes" — the pre-#40 community bug was a client that re-derived
//   capabilities and failed OPEN while they loaded.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_PERMISSIONS,
  communityAuthority,
  normalizeStaffContext,
  EMPTY_STAFF_CONTEXT,
} from '../src/lib/staffRoles.js';

const ctxFor = (roleKey, status = 'active') => normalizeStaffContext({
  is_staff: true,
  role_key: roleKey,
  role_label: roleKey,
  status,
  permissions: ROLE_PERMISSIONS[roleKey],
});

const READY = { staffReady: true, staffDegraded: false, isAdmin: false };

test('all three staff roles configure and moderate the community', () => {
  for (const role of ['super_admin', 'operations_admin', 'trainer']) {
    const a = communityAuthority({ staff: ctxFor(role), ...READY });
    assert.equal(a.canConfigure, true, `${role} must hold community.manage`);
    assert.equal(a.canModerate, true, `${role} must hold community.moderate`);
    assert.equal(a.hasStaffAccess, true, `${role} must read as Community staff`);
  }
});

test('a status other than active confers nothing, for any role', () => {
  for (const role of ['super_admin', 'operations_admin', 'trainer']) {
    for (const status of ['invited', 'suspended', 'revoked', 'pending', '', null]) {
      const a = communityAuthority({ staff: ctxFor(role, status), ...READY });
      assert.deepEqual(
        a, { canConfigure: false, canModerate: false, hasStaffAccess: false },
        `${role}/${status} must confer no community authority`,
      );
    }
  }
});

test('a student gets nothing, and neither does an empty or malformed context', () => {
  for (const staff of [EMPTY_STAFF_CONTEXT, null, undefined, {}, { isStaff: true }, 'nope']) {
    const a = communityAuthority({ staff, ...READY });
    assert.deepEqual(a, { canConfigure: false, canModerate: false, hasStaffAccess: false });
  }
});

test('while the staff context is LOADING both answers are false, never true', () => {
  // The whole point. A control rendered during the load window is a control the server
  // will refuse, and — worse — the same flag gates the "admins can write anywhere"
  // short-circuit, so failing open here would let the composer claim a write it cannot do.
  for (const role of ['super_admin', 'operations_admin', 'trainer']) {
    const a = communityAuthority({
      staff: ctxFor(role), staffReady: false, staffDegraded: false, isAdmin: false,
    });
    assert.deepEqual(a, { canConfigure: false, canModerate: false, hasStaffAccess: false },
      `${role} must not be granted anything before the context has settled`);
  }
});

test('a DEGRADED context falls back to the legacy column, not to "assume staff"', () => {
  // Availability may fail open; authority never does. Same idiom as adminTabAllowed()
  // and gateScreen.js's passesAsStaff().
  const degradedSuper = communityAuthority({
    staff: EMPTY_STAFF_CONTEXT, staffReady: true, staffDegraded: true, isAdmin: true,
  });
  assert.deepEqual(degradedSuper,
    { canConfigure: true, canModerate: true, hasStaffAccess: true });

  const degradedOther = communityAuthority({
    staff: ctxFor('trainer'), staffReady: true, staffDegraded: true, isAdmin: false,
  });
  assert.deepEqual(degradedOther,
    { canConfigure: false, canModerate: false, hasStaffAccess: false },
    'a Trainer whose context could not be read is answered by is_admin (false), '
    + 'not by the permissions we happen to remember');
});

test('degraded outranks loading — a stalled context is answered, not assumed', () => {
  const a = communityAuthority({
    staff: EMPTY_STAFF_CONTEXT, staffReady: false, staffDegraded: true, isAdmin: true,
  });
  assert.equal(a.hasStaffAccess, true);
});

test('hasStaffAccess is the union, and a lone permission is enough', () => {
  const manageOnly = normalizeStaffContext({
    is_staff: true, role_key: 'trainer', status: 'active', permissions: ['community.manage'],
  });
  const moderateOnly = normalizeStaffContext({
    is_staff: true, role_key: 'trainer', status: 'active', permissions: ['community.moderate'],
  });
  assert.deepEqual(communityAuthority({ staff: manageOnly, ...READY }),
    { canConfigure: true, canModerate: false, hasStaffAccess: true });
  assert.deepEqual(communityAuthority({ staff: moderateOnly, ...READY }),
    { canConfigure: false, canModerate: true, hasStaffAccess: true });
});

test('a non-community permission never leaks into community authority', () => {
  const ops = normalizeStaffContext({
    is_staff: true, role_key: 'operations_admin', status: 'active',
    permissions: ['enrollments.review', 'batches.manage', 'students.import'],
  });
  assert.deepEqual(communityAuthority({ staff: ops, ...READY }),
    { canConfigure: false, canModerate: false, hasStaffAccess: false });
});

test('communityAuthority tolerates being called with no argument at all', () => {
  assert.deepEqual(communityAuthority(),
    { canConfigure: false, canModerate: false, hasStaffAccess: false });
});
