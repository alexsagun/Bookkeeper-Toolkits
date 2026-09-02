// test/staffRoles.test.mjs — the staff role + permission model (#45).
//
// This suite is the acceptance test for the authorization split that replaced the
// binary profiles.is_admin. It pins WHICH permissions exist, WHICH role holds each
// one, and — the part that actually protects the product — what a context the
// server has not answered for yet is allowed to do.
//
// The matrix here is the client MIRROR of staff_role_permissions.
// test/staffRolesSql.test.mjs pins it against the SQL seed in both the dated
// migration and the bootstrap fold; this file pins its internal invariants and the
// fail-closed behaviour, neither of which SQL can express.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_TAB_PERMISSION,
  COURSE_AUTHORING_TABS,
  EMPTY_STAFF_CONTEXT,
  staffContextFromRpc,
  ROLE_PERMISSIONS,
  STAFF_PERMISSIONS,
  STAFF_PERMISSION_KEYS,
  STAFF_ROLES,
  STAFF_ROLE_KEYS,
  STAFF_STATUSES,
  SUPER_ADMIN_ROLE,
  canManageCourseClient,
  lastSuperAdminGuard,
  normalizeStaffContext,
  permissionsForRole,
  staffBypassesPaywall,
  courseScopeVerdict,
  staffAuthVerdict,
  staffCan,
  staffEntitlement,
  staffRole,
  staffStatusLabel,
} from '../src/lib/staffRoles.js';

const ctxFor = (roleKey, extra = {}) =>
  normalizeStaffContext({ role_key: roleKey, status: 'active', ...extra });

const SUPER = ctxFor('super_admin');
const OPS = ctxFor('operations_admin');
const TRAINER = ctxFor('trainer');

// ── The catalog ──────────────────────────────────────────────────────────────

test('there are exactly three roles, and super_admin is the only protected one', () => {
  assert.deepEqual(STAFF_ROLE_KEYS, ['super_admin', 'operations_admin', 'trainer'],
    'roles are ordered most- to least-privileged, and that order is what the UI renders');
  const protectedRoles = STAFF_ROLES.filter((r) => r.isProtected).map((r) => r.key);
  assert.deepEqual(protectedRoles, [SUPER_ADMIN_ROLE],
    'lastSuperAdminGuard and the SQL guard trigger both assume exactly one protected role');
});

test('every permission has a key, label, category and description', () => {
  for (const p of STAFF_PERMISSIONS) {
    assert.match(p.key, /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, `${p.key} is not a dotted lowercase key`);
    assert.ok(p.label && p.label.length > 3, `${p.key} needs a label`);
    assert.ok(p.category && p.category.length > 2, `${p.key} needs a category`);
    assert.ok(p.description && p.description.length > 20,
      `${p.key} needs a description — it is rendered verbatim in the role-capability preview`);
  }
});

test('permission keys are unique', () => {
  assert.equal(new Set(STAFF_PERMISSION_KEYS).size, STAFF_PERMISSION_KEYS.length,
    'a duplicate key would seed staff_permissions twice and silently win in one direction');
});

test('role ranks are unique and strictly descending', () => {
  const ranks = STAFF_ROLES.map((r) => r.rank);
  assert.equal(new Set(ranks).size, ranks.length, 'two roles cannot share a rank');
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] < ranks[i - 1], `rank must descend: ${ranks[i - 1]} then ${ranks[i]}`);
  }
});

// ── The matrix ───────────────────────────────────────────────────────────────

test('the matrix covers 3 roles x 19 permissions with no unknown keys', () => {
  let cells = 0;
  for (const roleKey of STAFF_ROLE_KEYS) {
    const held = ROLE_PERMISSIONS[roleKey];
    assert.ok(Array.isArray(held), `${roleKey} has no permission list`);
    assert.equal(new Set(held).size, held.length, `${roleKey} lists a permission twice`);
    for (const key of held) {
      assert.ok(STAFF_PERMISSION_KEYS.includes(key),
        `${roleKey} holds "${key}", which is not a declared permission`);
    }
    for (const key of STAFF_PERMISSION_KEYS) cells += 1;
  }
  assert.equal(cells, STAFF_ROLE_KEYS.length * STAFF_PERMISSION_KEYS.length,
    'the matrix must cover 3 roles x 19 permissions');
  assert.equal(cells, 57, 'a changed cell count means a permission or role was added without updating this sweep');
});

test('super_admin holds every permission', () => {
  for (const key of STAFF_PERMISSION_KEYS) {
    assert.ok(staffCan(SUPER, key), `super_admin must hold ${key} — it is the only unrestricted role`);
  }
});

test('every permission is held by at least one role', () => {
  const covered = new Set(STAFF_ROLE_KEYS.flatMap((r) => permissionsForRole(r)));
  for (const key of STAFF_PERMISSION_KEYS) {
    assert.ok(covered.has(key), `${key} is declared but unreachable — no role can ever exercise it`);
  }
});

test('operations_admin runs student operations and the community, and nothing else', () => {
  const allowed = ['access_requests.review', 'enrollments.review', 'students.assign_courses',
    'students.import', 'batches.manage', 'student_progress.read',
    // #56. Granting these is what made the server-side re-gate mandatory: #45 left every
    // community RPC on is_admin() precisely BECAUSE only super_admin held them.
    'community.manage', 'community.moderate'];
  for (const key of allowed) assert.ok(staffCan(OPS, key), `Operations Admin must hold ${key}`);

  // The four that matter most, named individually so a regression says which one.
  assert.equal(staffCan(OPS, 'staff.manage'), false,
    'an Operations Admin who can manage staff can promote themselves to Super Admin');
  assert.equal(staffCan(OPS, 'students.extend_access'), false,
    'a discretionary extension creates paid access with no payment — Super Admin only');
  assert.equal(staffCan(OPS, 'courses.delete'), false, 'Operations Admin has no course authority');
  assert.equal(staffCan(OPS, 'payment_settings.manage'), false, 'global settings are Super Admin only');
});

test('trainer authors courses, runs the community, and reaches nothing else', () => {
  assert.ok(staffCan(TRAINER, 'courses.create'), 'a Trainer must be able to start a course');
  assert.ok(staffCan(TRAINER, 'courses.manage_assigned'), 'a Trainer edits their assigned courses');
  assert.ok(staffCan(TRAINER, 'course_trainer.manage'), 'a Trainer indexes their own course for the AI trainer');
  // #56, an explicit product decision: a Trainer configures AND moderates the community.
  assert.ok(staffCan(TRAINER, 'community.manage'), 'a Trainer configures community channels');
  assert.ok(staffCan(TRAINER, 'community.moderate'), 'a Trainer moderates community content');

  assert.equal(staffCan(TRAINER, 'courses.manage_all'), false,
    'manage_all would let a Trainer edit another Trainer’s course');
  assert.equal(staffCan(TRAINER, 'courses.publish'), false,
    'publishing exposes content to every paying student — a separate act from authoring');
  assert.equal(staffCan(TRAINER, 'courses.delete'), false,
    'deleting removes storage objects a duplicated course may still reference by path');
  assert.equal(staffCan(TRAINER, 'enrollments.review'), false, 'a Trainer must never see payment proofs');
  assert.equal(staffCan(TRAINER, 'staff.manage'), false, 'a Trainer must never manage staff');
  assert.equal(staffCan(TRAINER, 'batches.manage'), false, 'a Trainer must never move cohorts');
  assert.equal(staffCan(TRAINER, 'student_progress.read'), false,
    'community moderation exposes community identities, not the private progress report');
  assert.equal(staffCan(TRAINER, 'access_requests.review'), false, 'a Trainer approves no signups');
  assert.equal(staffCan(TRAINER, 'students.import'), false, 'a Trainer runs no migrations');
  assert.equal(staffCan(TRAINER, 'sidebar.customize'), false, 'a Trainer renames nothing app-wide');
  assert.equal(staffCan(TRAINER, 'payment_settings.manage'), false, 'a Trainer touches no money');
});

test('community authority carries nothing else with it', () => {
  // The exposure #56 accepts is community identities and private cohort rooms. It must not
  // become a back door to payment, enrolment, ranking-report or profile administration.
  for (const ctx of [OPS, TRAINER]) {
    assert.ok(staffCan(ctx, 'community.manage') && staffCan(ctx, 'community.moderate'));
    assert.equal(staffCan(ctx, 'staff.manage'), false);
    assert.equal(staffCan(ctx, 'staff.audit.read'), false);
    assert.equal(staffCan(ctx, 'students.extend_access'), false);
    assert.equal(staffCan(ctx, 'courses.manage_all'), false);
    assert.equal(staffCan(ctx, 'courses.delete'), false);
    assert.equal(staffCan(ctx, 'courses.publish'), false);
    assert.equal(staffCan(ctx, 'sidebar.customize'), false);
    assert.equal(staffCan(ctx, 'payment_settings.manage'), false);
  }
});

test('a non-active membership holds no community permission either', () => {
  for (const status of ['invited', 'suspended', 'revoked']) {
    for (const role of ['operations_admin', 'trainer', 'super_admin']) {
      const ctx = normalizeStaffContext({
        is_staff: true, role_key: role, status, permissions: permissionsForRole(role),
      });
      assert.equal(staffCan(ctx, 'community.manage'), false, `${role}/${status}`);
      assert.equal(staffCan(ctx, 'community.moderate'), false, `${role}/${status}`);
    }
  }
});

test('only super_admin holds the escalation-critical permissions', () => {
  for (const key of ['staff.manage', 'staff.audit.read', 'courses.manage_all', 'students.extend_access']) {
    const holders = STAFF_ROLE_KEYS.filter((r) => permissionsForRole(r).includes(key));
    assert.deepEqual(holders, [SUPER_ADMIN_ROLE],
      `${key} must be Super-Admin-only; found ${holders.join(', ')}`);
  }
});

// ── Fail-closed behaviour ────────────────────────────────────────────────────

test('the empty context can do nothing at all', () => {
  assert.equal(EMPTY_STAFF_CONTEXT.isStaff, false);
  assert.equal(EMPTY_STAFF_CONTEXT.isSuperAdmin, false);
  for (const key of STAFF_PERMISSION_KEYS) {
    assert.equal(staffCan(EMPTY_STAFF_CONTEXT, key), false, `the empty context must not hold ${key}`);
  }
});

test('the empty context is frozen, so nobody can grant themselves a permission through it', () => {
  assert.ok(Object.isFrozen(EMPTY_STAFF_CONTEXT), 'EMPTY_STAFF_CONTEXT must be frozen');
  assert.ok(Object.isFrozen(EMPTY_STAFF_CONTEXT.permissions), 'its permission array must be frozen too');
});

test('garbage in resolves to the empty context, never to authority', () => {
  for (const bad of [null, undefined, 0, '', 'super_admin', [], {}, { role_key: 'super_admin' }]) {
    assert.equal(normalizeStaffContext(bad).isStaff, false,
      `normalizeStaffContext(${JSON.stringify(bad)}) must fail closed`);
  }
});

test('a non-active membership carries no authority — this is what makes suspension immediate', () => {
  for (const status of ['invited', 'suspended', 'revoked', 'ACTIVE', 'active ']) {
    const ctx = normalizeStaffContext({ role_key: 'super_admin', status });
    assert.equal(ctx.isStaff, false, `status "${status}" must not resolve to an active staff context`);
    assert.equal(staffCan(ctx, 'staff.manage'), false, `status "${status}" must not hold staff.manage`);
  }
});

test('an unknown role resolves to a staff context with zero permissions, not to full access', () => {
  const ctx = normalizeStaffContext({ role_key: 'wizard', status: 'active' });
  assert.equal(ctx.isStaff, true, 'the server said this account is active staff, so it is');
  assert.equal(ctx.isSuperAdmin, false, 'an unrecognised role is never Super Admin');
  assert.deepEqual([...ctx.permissions], [], 'an unrecognised role holds nothing');
  for (const key of STAFF_PERMISSION_KEYS) assert.equal(staffCan(ctx, key), false);
});

test('staffCan rejects a non-string or unknown key without throwing', () => {
  for (const bad of [null, undefined, 0, {}, [], 'nope.at.all']) {
    assert.equal(staffCan(SUPER, bad), false, `staffCan(super, ${JSON.stringify(bad)}) must be false`);
  }
});

test('isSuperAdmin is derived from the role, never trusted from the payload', () => {
  const spoof = normalizeStaffContext({
    role_key: 'trainer', status: 'active', is_super_admin: true, isSuperAdmin: true,
  });
  assert.equal(spoof.isSuperAdmin, false,
    'a forged is_super_admin flag must not survive normalization');
  assert.equal(staffCan(spoof, 'staff.manage'), false);
});

test('the server permission list wins over the local matrix when present', () => {
  const ctx = normalizeStaffContext({
    role_key: 'trainer', status: 'active', permissions: ['courses.create', 'courses.publish'],
  });
  assert.ok(staffCan(ctx, 'courses.publish'),
    'an operator who granted publish in SQL must see it honoured — the local matrix is a fallback');
  assert.equal(staffCan(ctx, 'course_trainer.manage'), false,
    'and the local matrix must not be unioned back in');
});

test('an empty server permission list falls back to the matrix rather than to nothing', () => {
  const ctx = normalizeStaffContext({ role_key: 'operations_admin', status: 'active', permissions: [] });
  assert.ok(staffCan(ctx, 'enrollments.review'),
    'an old server that returns no permissions array must not lock a real Ops Admin out');
});

// ── Reading the my_staff_context() RPC result ────────────────────────────────
// AuthProvider is React glue with no test infrastructure in this repo (no jsdom,
// no testing-library, and CLAUDE.md forbids adding one unasked), so the decision
// it makes — what a given RPC outcome MEANS — lives here where it can be tested.

test('a real staff row resolves to that role', () => {
  const r = staffContextFromRpc({
    data: { is_staff: true, role_key: 'trainer', status: 'active', permissions: ['courses.create'] },
    error: null,
  });
  assert.equal(r.context.roleKey, 'trainer');
  assert.equal(r.degraded, false, 'a successful call is not a degraded one');
  assert.ok(staffCan(r.context, 'courses.create'));
});

test('a student resolves to the empty context, not to a degraded one', () => {
  const r = staffContextFromRpc({ data: { is_staff: false }, error: null });
  assert.equal(r.context.isStaff, false);
  assert.equal(r.degraded, false,
    'is_staff:false is a real answer — reporting it as degraded would show a setup warning '
    + 'to every ordinary member');
});

test('a pre-#45 database degrades quietly instead of erroring', () => {
  for (const error of [
    { code: 'PGRST202', message: 'Could not find the function public.my_staff_context' },
    { code: '42883', message: 'function public.my_staff_context() does not exist' },
    { message: 'Could not find the function in the schema cache' },
  ]) {
    const r = staffContextFromRpc({ data: null, error });
    assert.equal(r.context.isStaff, false, 'no authority without the table that grants it');
    assert.equal(r.degraded, true,
      'the app must be able to tell "not staff" from "the migration has not run", so the '
      + 'admin sees setup guidance instead of silently losing every admin screen');
  }
});

test('any other failure fails CLOSED and is reported as degraded', () => {
  for (const error of [
    { code: '42501', message: 'permission denied for function my_staff_context' },
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { message: 'NetworkError when attempting to fetch resource' },
    { message: 'timeout' },
  ]) {
    const r = staffContextFromRpc({ data: null, error });
    assert.equal(r.context.isStaff, false,
      'an unavailable authorization check must never be read as authority');
    assert.equal(r.degraded, true);
  }
});

test('an error wins over any payload that arrived with it', () => {
  // Found by mutation-checking: every other error test passes data:null, so
  // "returns EMPTY on error" and "normalizes whatever data is there" were
  // indistinguishable. They are not the same rule, and only one of them is safe.
  const r = staffContextFromRpc({
    data: { is_staff: true, role_key: 'super_admin', status: 'active' },
    error: { code: '42501', message: 'permission denied' },
  });
  assert.equal(r.context.isStaff, false,
    'a failed authorization check must confer nothing, whatever came back alongside the error');
  assert.equal(r.context.isSuperAdmin, false);
  assert.equal(r.degraded, true);
});

test('a malformed payload fails closed rather than throwing', () => {
  for (const data of [null, undefined, 'super_admin', 42, [], { role_key: 'super_admin' }]) {
    const r = staffContextFromRpc({ data, error: null });
    assert.equal(r.context.isStaff, false, `payload ${JSON.stringify(data)} must not confer authority`);
  }
});

test('a single-row array payload is unwrapped', () => {
  // PostgREST returns a bare value for a scalar-returning RPC, but a caller that
  // switches to .select() gets an array. Tolerate both rather than fail closed on
  // a shape change that is not a security event.
  const r = staffContextFromRpc({
    data: [{ is_staff: true, role_key: 'operations_admin', status: 'active' }],
    error: null,
  });
  assert.equal(r.context.roleKey, 'operations_admin');
});

// ── The server-side authorization verdict ────────────────────────────────────
// api/_lib/staffAuth.js is a thin I/O shell around this. It decides, for every
// api/admin/* request, whether the service-role client may be constructed at all.

const rpcFor = (roleKey) => staffContextFromRpc({
  data: { is_staff: true, role_key: roleKey, status: 'active' }, error: null,
});
const rpcMissing = () => staffContextFromRpc({
  data: null, error: { code: 'PGRST202', message: 'Could not find the function' },
});
const rpcBroken = () => staffContextFromRpc({
  data: null, error: { code: '57014', message: 'statement timeout' },
});

test('a holder of the permission is allowed', () => {
  const v = staffAuthVerdict({ rpc: rpcFor('operations_admin'), permission: 'enrollments.review' });
  assert.equal(v.allow, true);
  assert.equal(v.status, 200);
});

test('a staff member without the permission gets 403, not 401', () => {
  const v = staffAuthVerdict({ rpc: rpcFor('trainer'), permission: 'enrollments.review' });
  assert.equal(v.allow, false);
  assert.equal(v.status, 403, 'they are authenticated and known — just not allowed');
});

test('a student gets 403', () => {
  const v = staffAuthVerdict({
    rpc: staffContextFromRpc({ data: { is_staff: false }, error: null }),
    permission: 'enrollments.review',
  });
  assert.equal(v.allow, false);
  assert.equal(v.status, 403);
});

test('an unavailable check denies — it never fails open', () => {
  const v = staffAuthVerdict({ rpc: rpcBroken(), permission: 'students.import' });
  assert.equal(v.allow, false,
    'the anthropic/elevenlabs gates fail OPEN on an indeterminate is_enrolled(); a STAFF '
    + 'check must not, because what it guards is the service-role key');
  assert.equal(v.status, 403);
  assert.equal(v.degraded, true);
});

test('a pre-#45 database falls back to the legacy is_admin check', () => {
  // Deploy skew is real: Vercel ships the code, a human runs the migration. Until
  // then my_staff_context() does not exist, and a legacy admin must keep working.
  const allowed = staffAuthVerdict({ rpc: rpcMissing(), permission: 'staff.manage', legacyIsAdmin: true });
  assert.equal(allowed.allow, true, 'the pre-#45 admin is a Super Admin by definition');
  assert.equal(allowed.legacy, true, 'and the handler should be able to log that it took this path');

  const denied = staffAuthVerdict({ rpc: rpcMissing(), permission: 'staff.manage', legacyIsAdmin: false });
  assert.equal(denied.allow, false, 'a non-admin on a pre-#45 database is still a non-admin');
  assert.equal(denied.status, 403);
});

test('the legacy fallback applies ONLY when the function is missing', () => {
  // A timeout or a permission error must never be answered by consulting a
  // weaker check — that would turn an outage into a privilege escalation.
  const v = staffAuthVerdict({ rpc: rpcBroken(), permission: 'staff.manage', legacyIsAdmin: true });
  assert.equal(v.allow, false,
    'is_admin=true must not rescue a request whose real authorization check errored');
});

test('no fallback attempted means no fallback granted', () => {
  const v = staffAuthVerdict({ rpc: rpcMissing(), permission: 'staff.manage' });
  assert.equal(v.allow, false, 'legacyIsAdmin defaults to null, which is not true');
});

test('a missing or unknown permission argument denies', () => {
  for (const permission of [undefined, null, '', 'not.a.permission']) {
    const v = staffAuthVerdict({ rpc: rpcFor('super_admin'), permission });
    assert.equal(v.allow, false,
      `a handler that forgets to name its permission must fail closed, not run as Super Admin`);
  }
});

test('every verdict carries a stable code the client can branch on', () => {
  const v = staffAuthVerdict({ rpc: rpcFor('trainer'), permission: 'staff.manage' });
  assert.equal(v.code, 'FORBIDDEN', 'clients read error.hint, never the HTTP status');
});

// ── Per-course scoping for the trainer endpoint ──────────────────────────────
// Regression tests for two defects the #45 code review found in
// api/admin/course-trainer.js. Both made a LEGITIMATE administrator lose access.

const COURSE_A = '11111111-1111-4111-8111-111111111111';
const COURSE_B = '22222222-2222-4222-8222-222222222222';

const superCtx = rpcFor('super_admin').context;
const trainerCtx = staffContextFromRpc({
  data: { is_staff: true, role_key: 'trainer', status: 'active', assigned_course_ids: [COURSE_A] },
  error: null,
}).context;

test('a caller with courses.manage_all needs no assignment', () => {
  const v = courseScopeVerdict({ context: superCtx, courseId: COURSE_B, assignment: false });
  assert.equal(v.allow, true, 'manage_all is exactly the permission that bypasses assignment');
});

test('the legacy pre-#45 admin is allowed — they ARE a Super Admin', () => {
  // The bug: on the legacy path the context is EMPTY, so a permissions check
  // denied a real administrator during the deploy window the fallback exists for.
  const v = courseScopeVerdict({ context: EMPTY_STAFF_CONTEXT, legacy: true, courseId: COURSE_B, assignment: false });
  assert.equal(v.allow, true,
    'requireStaff already accepted them via profiles.is_admin; this block must not re-deny them');
});

test('an unavailable can_manage_course does not deny a manage_all holder', () => {
  // The bug: can_manage_course is created by #46, not #45. Between the two
  // migrations the RPC 404s, callerCanManageCourse returned false, and EVERY
  // course-scoped trainer action 403d — including for a Super Admin.
  const v = courseScopeVerdict({ context: superCtx, courseId: COURSE_A, assignment: 'unavailable' });
  assert.equal(v.allow, true,
    'a missing ownership model must fall through to the capability check, not deny');
});

test('an unavailable can_manage_course DOES deny a Trainer', () => {
  const v = courseScopeVerdict({ context: trainerCtx, courseId: COURSE_A, assignment: 'unavailable' });
  assert.equal(v.allow, false,
    'without the ownership model there is nothing that makes this course theirs — fail closed');
  assert.equal(v.code, 'COURSE_NOT_ASSIGNED');
});

test('a Trainer with the assignment is allowed; without it, denied', () => {
  assert.equal(courseScopeVerdict({ context: trainerCtx, courseId: COURSE_A, assignment: true }).allow, true);
  assert.equal(courseScopeVerdict({ context: trainerCtx, courseId: COURSE_B, assignment: false }).allow, false);
});

test('an action with no course id is allowed only for manage_all or legacy', () => {
  assert.equal(courseScopeVerdict({ context: superCtx, courseId: null }).allow, true);
  assert.equal(courseScopeVerdict({ context: EMPTY_STAFF_CONTEXT, legacy: true, courseId: null }).allow, true);
  const t = courseScopeVerdict({ context: trainerCtx, courseId: null });
  assert.equal(t.allow, false, 'a Trainer must scope the action to a course they own');
  assert.equal(t.code, 'COURSE_NOT_ASSIGNED');
});

test('a course id that is not a uuid is refused before it reaches the database', () => {
  // '' is deliberately NOT in this list: the handler does `body.course_id || null`,
  // so an empty string is indistinguishable from "no course id supplied" and is
  // covered by the no-course-id case above.
  for (const bad of ['../../etc', "' or 1=1--", 'abc', '11111111-1111-4111-8111']) {
    const v = courseScopeVerdict({ context: superCtx, courseId: bad, assignment: true });
    assert.equal(v.allow, false, `"${bad}" must not be forwarded as a course id`);
  }
});

// ── Course assignment ────────────────────────────────────────────────────────


test('a Trainer manages only assigned courses', () => {
  const assigned = ctxFor('trainer', { assigned_course_ids: [COURSE_A] });
  assert.ok(canManageCourseClient(assigned, COURSE_A), 'the assigned course is manageable');
  assert.ok(canManageCourseClient(assigned, { id: COURSE_A }), 'a course row works as well as an id');
  assert.equal(canManageCourseClient(assigned, COURSE_B), false,
    'another Trainer’s course must not be manageable');
  assert.equal(canManageCourseClient(assigned, null), false, 'a missing course fails closed');
  assert.equal(canManageCourseClient(assigned, {}), false, 'a course row with no id fails closed');
});

test('courses.manage_all bypasses assignment; a student never can', () => {
  assert.ok(canManageCourseClient(SUPER, COURSE_B), 'a Super Admin manages every course');
  assert.equal(canManageCourseClient(EMPTY_STAFF_CONTEXT, COURSE_A), false, 'a student manages none');
  assert.equal(canManageCourseClient(OPS, COURSE_A), false,
    'an Operations Admin has no course authority even with an assignment');
});

// ── The chokepoint map ───────────────────────────────────────────────────────

test('every admin tab maps to a permission some role can hold', () => {
  for (const [tabId, key] of Object.entries(ADMIN_TAB_PERMISSION)) {
    assert.ok(STAFF_PERMISSION_KEYS.includes(key),
      `tab "${tabId}" requires "${key}", which is not a declared permission`);
    const holders = STAFF_ROLE_KEYS.filter((r) => permissionsForRole(r).includes(key));
    assert.ok(holders.length > 0, `tab "${tabId}" requires "${key}", which no role holds — it is unreachable`);
  }
});

test('no student and no Trainer can open an admin tab', () => {
  for (const [tabId, key] of Object.entries(ADMIN_TAB_PERMISSION)) {
    assert.equal(staffCan(EMPTY_STAFF_CONTEXT, key), false, `a student must not open ${tabId}`);
    assert.equal(staffCan(TRAINER, key), false, `a Trainer must not open ${tabId}`);
  }
});

test('an Operations Admin opens exactly the four student-operations tabs', () => {
  const open = Object.keys(ADMIN_TAB_PERMISSION).filter((t) => staffCan(OPS, ADMIN_TAB_PERMISSION[t]));
  assert.deepEqual(open.sort(), ['accessrequests', 'batches', 'enrollments', 'studentimports'],
    'and never staffroles — that is the self-promotion path');
});

// ── Entitlement merging ──────────────────────────────────────────────────────

const scopedBase = {
  full: false,
  scopeLabel: 'Essentials + 1-on-1 coaching',
  allowsTab: (id) => id === 'dashboard' || id === 'qbomastery' || id === 'community',
  allowsStage: (id) => id === 'home' || id === 'training',
  allowsCourse: () => false,
};
const fullBase = {
  full: true,
  scopeLabel: 'Full toolkit access',
  allowsTab: () => true,
  allowsStage: () => true,
  allowsCourse: () => true,
};

test('a student entitlement passes through untouched', () => {
  assert.equal(staffEntitlement(EMPTY_STAFF_CONTEXT, scopedBase), scopedBase,
    'a non-staff context must not be widened at all');
});

test('a Super Admin keeps the base entitlement — the pre-#45 behaviour', () => {
  assert.equal(staffEntitlement(SUPER, fullBase), fullBase);
});

test('an Operations Admin gains their admin tabs on top of their own plan', () => {
  const ent = staffEntitlement(OPS, scopedBase);
  assert.ok(ent.allowsTab('enrollments'), 'the Ops tabs are added');
  assert.ok(ent.allowsTab('batches'));
  assert.ok(ent.allowsTab('qbomastery'), 'and the plan they actually paid for is preserved');
  assert.equal(ent.allowsTab('staffroles'), false, 'staff management is not theirs');
  assert.equal(ent.allowsTab('bankfeed'), false, 'and staff status is not a free toolkit');
  assert.equal(ent.full, false, 'staff reach is a union of tabs, never a blanket full:true');
});

test('a Trainer gains the course catalogs and nothing operational', () => {
  const ent = staffEntitlement(TRAINER, scopedBase);
  for (const tabId of COURSE_AUTHORING_TABS) {
    assert.ok(ent.allowsTab(tabId), `a Trainer needs ${tabId} to reach the builder`);
  }
  assert.ok(ent.allowsStage('training'), 'and the stage that contains them');
  assert.equal(ent.allowsTab('enrollments'), false, 'a Trainer must not reach payment proofs');
  assert.equal(ent.allowsTab('studentimports'), false);
  assert.equal(ent.allowsTab('invoice'), false, 'and gains no student tools');
});

test('every community-authorised role reaches the Community tab without a subscription', () => {
  // #56. The tab is deliberately absent from ADMIN_TAB_PERMISSION - adding it there would
  // make adminTabAllowed() refuse it for students, who are exactly who it is for. The
  // entitlement union is what lets an unpaid Ops Admin or Trainer open the forum.
  for (const ctx of [OPS, TRAINER]) {
    assert.ok(staffEntitlement(ctx, null).allowsTab('community'),
      'a staff member with NO plan at all still reaches the community they moderate');
    assert.ok(staffEntitlement(ctx, scopedBase).allowsTab('community'));
  }
  const noCommunity = normalizeStaffContext({
    is_staff: true, role_key: 'trainer', status: 'active',
    permissions: ['courses.create'],
  });
  assert.equal(staffEntitlement(noCommunity, null).allowsTab('community'), false,
    'and a staff member holding NEITHER community permission does not');
});

test('a Trainer sees an assigned draft course that their plan would hide', () => {
  const ent = staffEntitlement(ctxFor('trainer', { assigned_course_ids: [COURSE_A] }), scopedBase);
  assert.ok(ent.allowsCourse({ id: COURSE_A }), 'their own course is visible for authoring');
  assert.equal(ent.allowsCourse({ id: COURSE_B }), false, 'another Trainer’s is not');
});

test('a suspended staff member is entitled exactly as the student they are', () => {
  const suspended = normalizeStaffContext({ role_key: 'operations_admin', status: 'suspended' });
  assert.equal(staffEntitlement(suspended, scopedBase), scopedBase);
  assert.equal(staffBypassesPaywall(suspended), false,
    'and is held on the paywall like any other member');
});

test('staffBypassesPaywall is true only for active staff', () => {
  assert.ok(staffBypassesPaywall(SUPER));
  assert.ok(staffBypassesPaywall(TRAINER));
  assert.equal(staffBypassesPaywall(EMPTY_STAFF_CONTEXT), false);
  assert.equal(staffBypassesPaywall(null), false);
});

// ── The last-Super-Admin guard ───────────────────────────────────────────────

const lastSuper = { roleKey: 'super_admin', status: 'active' };

test('the last active Super Admin cannot be demoted, suspended or revoked', () => {
  for (const change of [
    { roleKey: 'operations_admin' },
    { roleKey: 'trainer' },
    { status: 'suspended' },
    { status: 'revoked' },
  ]) {
    const r = lastSuperAdminGuard(lastSuper, change, 1);
    assert.equal(r.ok, false, `${JSON.stringify(change)} must be refused`);
    assert.equal(r.code, 'STAFF_LAST_SUPER_ADMIN');
    assert.ok(r.message.length > 40, 'the refusal must explain what to do first');
  }
});

test('the same changes are allowed once a second Super Admin exists', () => {
  assert.ok(lastSuperAdminGuard(lastSuper, { status: 'suspended' }, 2).ok);
  assert.ok(lastSuperAdminGuard(lastSuper, { roleKey: 'trainer' }, 2).ok);
});

test('a no-op change to the last Super Admin is allowed', () => {
  assert.ok(lastSuperAdminGuard(lastSuper, {}, 1).ok, 'editing a display title is not a demotion');
  assert.ok(lastSuperAdminGuard(lastSuper, { roleKey: 'super_admin', status: 'active' }, 1).ok);
});

test('the guard only defends an ACTIVE Super Admin', () => {
  assert.ok(lastSuperAdminGuard({ roleKey: 'super_admin', status: 'suspended' }, { status: 'revoked' }, 0).ok,
    'an already-suspended Super Admin is not the one holding the product up');
  assert.ok(lastSuperAdminGuard({ roleKey: 'operations_admin', status: 'active' }, { status: 'revoked' }, 1).ok,
    'and revoking an Ops Admin is never blocked by it');
});

// ── Small surfaces ───────────────────────────────────────────────────────────

test('staffRole returns metadata or null, never throws', () => {
  assert.equal(staffRole('trainer').label, 'Trainer');
  assert.equal(staffRole('nope'), null);
  assert.equal(staffRole(null), null);
});

test('permissionsForRole returns a copy, so a caller cannot mutate the matrix', () => {
  const list = permissionsForRole('trainer');
  list.push('staff.manage');
  assert.equal(permissionsForRole('trainer').includes('staff.manage'), false,
    'ROLE_PERMISSIONS must not be reachable through the returned array');
  assert.deepEqual(permissionsForRole('nope'), []);
});

test('every status has copy, and an unknown one renders as itself', () => {
  for (const s of STAFF_STATUSES) {
    assert.ok(staffStatusLabel(s).length > 2, `${s} needs a label`);
  }
  assert.equal(staffStatusLabel('weird'), 'weird');
  assert.equal(staffStatusLabel(null), '—');
});
