// ─────────────────────────────────────────────────────────────────────────────
// staffRoles.js — PURE, dependency-free staff role + permission model (#45).
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the browser (src/auth/AuthProvider.jsx, src/BookkeeperPro.jsx), the
// serverless handlers (api/_lib/staffAuth.js and every api/admin/* route), and
// the node:test suites (test/staffRoles.test.mjs, test/staffRolesSql.test.mjs).
// NO side effects, NO DOM/Node/Supabase — the same rules must run identically in
// all three places. The one import is another pure sibling (the house pattern:
// batchLifecycle.js imports communitySpaces.js, trainingAgreement.js imports
// planCatalog.js), so that "is this error a missing migration?" has exactly one
// definition in the codebase.

import { isMigrationMissing } from './appErrors.js';
//
// ★ THIS FILE IS A MIRROR, NOT THE AUTHORITY. The database is the boundary:
//   staff_roles / staff_permissions / staff_role_permissions are seeded from
//   this exact matrix by db/2026-08-25-staff-authorization.sql, and every write
//   is gated by has_staff_permission() in RLS or inside a SECURITY DEFINER body.
//   What lives here is the client's copy, used to decide what to RENDER and to
//   fail closed while the server's answer is still loading.
//   test/staffRolesSql.test.mjs pins the two against each other, in BOTH the
//   dated migration and the bootstrap fold.
//
// ★ WHY A ROLE MODEL AT ALL, AND WHY IT IS SHAPED LIKE THIS.
//   Before #45 authorization was one boolean, profiles.is_admin, behind
//   public.is_admin() — 295 references in the bootstrap, ~38 dated migrations,
//   145 frontend checks and four hand-rolled copies of the same API gate. Every
//   admin could approve payments, delete courses, manage batches, import
//   students and moderate the community.
//
//   #45 does NOT rewrite those 295 references. Instead profiles.is_admin becomes
//   a trigger-maintained CACHE meaning exactly "has an ACTIVE super_admin
//   membership", so every legacy check silently narrows to Super-Admin-only.
//   Operations Admins and Trainers carry is_admin = false and reach their
//   features ONLY through the explicit capability checks named here. A legacy
//   check we failed to find therefore UNDER-grants (a broken Ops feature) rather
//   than over-granting. That direction is the whole design.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The permission keys, grouped by the surface they gate — the grouping is what a
 * Super Admin reads in the role-capability preview.
 *
 * Adding a key here is HALF a change: the other half is a dated migration that
 * inserts it into public.staff_permissions and into staff_role_permissions for
 * every role that should hold it. test/staffRolesSql.test.mjs fails until both
 * halves land, in the dated file AND the bootstrap fold.
 */
export const STAFF_PERMISSIONS = [
  // ── Staff administration ───────────────────────────────────────────────────
  { key: 'staff.manage', category: 'Staff', label: 'Invite and manage staff',
    description: 'Invite staff, assign and change roles, suspend and revoke access.' },
  { key: 'staff.audit.read', category: 'Staff', label: 'View the staff audit trail',
    description: 'Read the full history of role assignments, suspensions and revocations.' },

  // ── Student operations ─────────────────────────────────────────────────────
  { key: 'access_requests.review', category: 'Students', label: 'Review account access requests',
    description: 'Approve or reject new account signups.' },
  { key: 'enrollments.review', category: 'Students', label: 'Review payment proofs',
    description: 'Approve or reject enrollment, renewal, upgrade and extension requests.' },
  { key: 'students.assign_courses', category: 'Students', label: 'Choose granted courses',
    description: 'Select which plan-eligible course programs an approval grants.' },
  { key: 'students.extend_access', category: 'Students', label: 'Grant special extensions',
    description: 'Extend a membership expiry outside the paid request flow. Always audited.' },
  { key: 'students.import', category: 'Students', label: 'Import students',
    description: 'Run the Thinkific migration wizard and issue invitations.' },
  { key: 'batches.manage', category: 'Students', label: 'Manage cohort batches',
    description: 'Create, edit, close and archive batches, and assign members to them.' },
  { key: 'student_progress.read', category: 'Students', label: 'View student progress reports',
    description: 'Read private operational progress reports, cohort averages, inactivity signals and CSV exports.' },

  // ── Course authoring ───────────────────────────────────────────────────────
  { key: 'courses.create', category: 'Courses', label: 'Create courses',
    description: 'Create a new draft course and duplicate an existing one.' },
  { key: 'courses.manage_assigned', category: 'Courses', label: 'Edit assigned courses',
    description: 'Edit the modules, lessons and videos of courses assigned to you.' },
  { key: 'courses.manage_all', category: 'Courses', label: 'Edit every course',
    description: 'Edit any course, whether or not it is assigned to you.' },
  { key: 'courses.publish', category: 'Courses', label: 'Publish and unpublish courses',
    description: 'Make a course visible to students, or withdraw it.' },
  { key: 'courses.delete', category: 'Courses', label: 'Delete courses',
    description: 'Permanently delete a course and its unreferenced media.' },
  { key: 'course_trainer.manage', category: 'Courses', label: 'Manage AI trainer indexing',
    description: 'Enable, sync, transcribe and preview the AI course trainer.' },

  // ── Community + global settings ────────────────────────────────────────────
  { key: 'community.manage', category: 'Community', label: 'Configure the community',
    description: 'Create and edit channels, categories and audience rules.' },
  { key: 'community.moderate', category: 'Community', label: 'Moderate the community',
    description: 'Pin, lock, hide and hard-delete posts and replies.' },
  { key: 'sidebar.customize', category: 'Settings', label: 'Customize navigation labels',
    description: 'Rename stages, groups and tabs for every user in the app.' },
  { key: 'payment_settings.manage', category: 'Settings', label: 'Edit payment settings',
    description: 'Change the manual-payment instructions and the notification address.' },
];

/** Fast membership test + the canonical ordering. */
export const STAFF_PERMISSION_KEYS = STAFF_PERMISSIONS.map((p) => p.key);

/**
 * The three roles. `rank` orders them in the UI and answers "is this a promotion
 * or a demotion"; it is NOT an authorization input — permissions are, always.
 *
 * `isProtected` marks super_admin as the role the last-Super-Admin guard
 * defends. Do not add a second protected role without teaching
 * lastSuperAdminGuard() and the SQL guard trigger about it.
 */
export const STAFF_ROLES = [
  {
    key: 'super_admin',
    label: 'Super Admin',
    rank: 100,
    isProtected: true,
    description: 'Complete product authority, including staff management and the audit trail.',
  },
  {
    key: 'operations_admin',
    label: 'Operations Admin',
    rank: 50,
    isProtected: false,
    description: 'Reviews access requests and payment proofs, grants courses, runs batches and imports, and configures and moderates the community.',
  },
  {
    key: 'trainer',
    label: 'Trainer',
    rank: 20,
    isProtected: false,
    description: 'Creates courses and edits the ones assigned to them, and configures and moderates the community. No access to payments or students.',
  },
];

export const STAFF_ROLE_KEYS = STAFF_ROLES.map((r) => r.key);

export const SUPER_ADMIN_ROLE = 'super_admin';

/**
 * THE matrix. 19 permissions x 3 roles.
 *
 * Two deliberate omissions, both of which a reader will want to challenge:
 *
 *   - operations_admin does NOT hold `students.extend_access`. A discretionary
 *     expiry extension creates paid access with no payment behind it, so it stays
 *     with the role that owns the money. Ops Admins extend access the normal way,
 *     by approving an extension REQUEST, which carries a receipt.
 *
 *   - trainer does NOT hold `courses.publish` or `courses.delete`. Authoring and
 *     shipping are separate acts: publishing exposes content to every paying
 *     student, and #44's courses_publish_guard is the gate that stops an
 *     unplayable course going live. Deleting removes storage objects that a
 *     DUPLICATED course may still reference by path (duplication reuses the
 *     source course's files by reference — no copy is made).
 *
 * Both are additive later — insert a staff_role_permissions row — and neither can
 * be worked around from the client, because RLS reads the table, not this file.
 *
 * #56 added `community.manage` + `community.moderate` to BOTH non-super roles, taking
 * the matrix from 28 grants to 32. That is a deliberate product decision, and it is what
 * made #56's server work mandatory rather than optional: #45 left every community RPC and
 * policy on `is_admin()` precisely BECAUSE only super_admin held these two keys, so the
 * two predicates were equivalent (db/2026-08-25-staff-authorization.sql:1279). Granting
 * them here without re-gating the server would have produced roles that look able in the
 * UI and are refused at the first server call.
 *
 * Community authority deliberately carries nothing else with it. A Trainer who moderates
 * the forum still cannot review payments, run batches, read progress reports, publish or
 * delete a course, manage staff, or rename the sidebar.
 */
export const ROLE_PERMISSIONS = {
  super_admin: [...STAFF_PERMISSION_KEYS],
  operations_admin: [
    'access_requests.review',
    'enrollments.review',
    'students.assign_courses',
    'students.import',
    'batches.manage',
    'student_progress.read',
    'community.manage',
    'community.moderate',
  ],
  trainer: [
    'courses.create',
    'courses.manage_assigned',
    'course_trainer.manage',
    'community.manage',
    'community.moderate',
  ],
};

/** The permission keys a role holds, as a fresh array. Unknown role -> []. */
export function permissionsForRole(roleKey) {
  const list = ROLE_PERMISSIONS[roleKey];
  return Array.isArray(list) ? [...list] : [];
}

/** Role metadata by key, or null. Never throws on an unknown key. */
export function staffRole(roleKey) {
  return STAFF_ROLES.find((r) => r.key === roleKey) || null;
}

/**
 * The fail-closed context. This is what a signed-in student has, what a staff
 * member has while my_staff_context() is still in flight, and what every error
 * path resolves to.
 *
 * ★ It is frozen. The pre-#40 community bug was a client that re-derived
 *   capabilities from raw flags and failed OPEN while they loaded; the rule that
 *   came out of it is "absent permission data means no, not yes". Same rule here,
 *   and freezing means a caller cannot accidentally grant themselves a permission
 *   by mutating the shared default object.
 */
export const EMPTY_STAFF_CONTEXT = Object.freeze({
  isStaff: false,
  roleKey: null,
  roleLabel: null,
  status: null,
  displayTitle: null,
  isSuperAdmin: false,
  permissions: Object.freeze([]),
  assignedCourseIds: Object.freeze([]),
});

/**
 * "This account has no staff membership." The descriptive counterpart to
 * EMPTY_STAFF_CONTEXT, and what every error path resolves to — a lookup that
 * could not run must not offer someone an invitation screen any more than it
 * would grant them a permission.
 */
export const EMPTY_STAFF_MEMBERSHIP = Object.freeze({
  exists: false,
  status: null,
  roleKey: null,
  roleLabel: null,
  roleDescription: null,
  displayTitle: null,
  invitedAt: null,
  activatedAt: null,
});

/**
 * Normalize whatever my_staff_context() returned into the shape the app uses.
 *
 * ★ ONLY an `active` membership yields authority. 'invited' (has not accepted the
 *   invitation yet), 'suspended' and 'revoked' all resolve to the empty context.
 *   That is what makes a suspension take effect on the very next request rather
 *   than on the next token refresh — the context is re-read from the database,
 *   never decoded from a JWT claim.
 *
 * ★ The permission list is taken from the SERVER's `permissions` array when one
 *   is present, and only falls back to this file's matrix when it is absent.
 *   That ordering matters: if an operator adds a staff_role_permissions row in
 *   SQL, the server's answer is the true one and the client must honour it — the
 *   local matrix is a fallback for an old server, not an override.
 */
export function normalizeStaffContext(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_STAFF_CONTEXT;

  const status = typeof raw.status === 'string' ? raw.status : null;
  const roleKey = typeof raw.role_key === 'string' ? raw.role_key
    : typeof raw.roleKey === 'string' ? raw.roleKey : null;

  if (status !== 'active' || !roleKey) return EMPTY_STAFF_CONTEXT;

  const serverPerms = Array.isArray(raw.permissions)
    ? raw.permissions.filter((p) => typeof p === 'string' && p)
    : null;
  const permissions = serverPerms && serverPerms.length ? serverPerms : permissionsForRole(roleKey);

  const rawCourses = raw.assigned_course_ids ?? raw.assignedCourseIds;
  const assignedCourseIds = Array.isArray(rawCourses)
    ? rawCourses.filter((id) => typeof id === 'string' && id)
    : [];

  const meta = staffRole(roleKey);

  return Object.freeze({
    isStaff: true,
    roleKey,
    roleLabel: (typeof raw.role_label === 'string' && raw.role_label) || meta?.label || roleKey,
    status,
    displayTitle: (typeof raw.display_title === 'string' && raw.display_title) || null,
    // Derived from the ROLE, never trusted from a flag the caller could shape.
    isSuperAdmin: roleKey === SUPER_ADMIN_ROLE,
    permissions: Object.freeze([...permissions]),
    assignedCourseIds: Object.freeze(assignedCourseIds),
  });
}

/**
 * Interpret a `supabase.rpc('my_staff_context')` outcome.
 *
 * Returns `{ context, degraded, missing }`. AuthProvider is React glue with no
 * test infrastructure in this repo, so the DECISION lives here where node:test
 * can reach it and the provider stays a thin shell around it.
 *
 * ★ Three outcomes that must stay distinguishable, because conflating any two of
 *   them produces a bug this codebase has already shipped once:
 *
 *   1. A real answer — staff or not. `degraded: false`. `is_staff: false` is a
 *      real answer, not a failure; reporting it as degraded would show a
 *      "finish backend setup" warning to every ordinary member.
 *
 *   2. The function does not exist — the migration has not run. `missing: true`.
 *      The app must be able to tell this from "not staff", or an administrator on
 *      a pre-#45 database silently loses every admin screen with no explanation.
 *      This is the same degrade CommunityHub does for a pre-#24 database.
 *
 *   3. Anything else — denied, timed out, offline. `degraded: true`.
 *
 * ★ In ALL failure cases the context is EMPTY. Availability may fail open; the
 *   authorization answer never does. An authorization check that could not run is
 *   not a permission granted.
 */
export function staffContextFromRpc(result) {
  const { data, error } = result || {};

  if (error) {
    return {
      context: EMPTY_STAFF_CONTEXT,
      membership: EMPTY_STAFF_MEMBERSHIP,
      degraded: true,
      missing: isMigrationMissing(error),
    };
  }

  // A scalar-returning RPC comes back bare, but a caller using .select() gets an
  // array. Tolerate both — a shape change here is not a security event.
  const row = Array.isArray(data) ? data[0] : data;

  return {
    context: normalizeStaffContext(row),
    membership: staffMembershipFromRpc(row),
    degraded: false,
    missing: false,
  };
}

/**
 * The DESCRIPTIVE half of a staff membership — what it is, never what it may do.
 *
 * ★ THIS OBJECT HAS NO `permissions` FIELD, AND THAT IS THE WHOLE DESIGN.
 *   normalizeStaffContext() collapses 'invited' to the empty context, which is
 *   correct for authority and is exactly why an invited member was previously
 *   indistinguishable from a random student — the app could not tell them "you
 *   were invited as a Trainer" because it had thrown that away. The fix is a
 *   SECOND object rather than a relaxed first one: if the pending role lived on
 *   the authority context behind a status check, then an invited membership would
 *   sit one inverted boolean away from a live one. Here there is no boolean to
 *   invert — there is nothing to grant.
 *
 *   Legitimate uses: pick the invitation screen, show the assigned role, explain
 *   why access ended. It must never gate an API call, an RPC, a route or a
 *   privileged control; staffCan() is the only thing that answers that.
 *
 * Reads the `membership` block #49 added to my_staff_context(). A pre-#49 server
 * has no such block, so this degrades to "no membership" — which keeps the
 * invitation screen from appearing on a database that cannot yet accept one.
 */
export function staffMembershipFromRpc(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_STAFF_MEMBERSHIP;

  const m = raw.membership && typeof raw.membership === 'object' ? raw.membership : null;
  if (!m || m.exists !== true) return EMPTY_STAFF_MEMBERSHIP;

  const status = typeof m.status === 'string' ? m.status : null;
  const roleKey = typeof m.role_key === 'string' ? m.role_key : null;
  if (!status || !roleKey) return EMPTY_STAFF_MEMBERSHIP;

  const meta = staffRole(roleKey);
  return Object.freeze({
    exists: true,
    status,
    roleKey,
    roleLabel: (typeof m.role_label === 'string' && m.role_label) || meta?.label || roleKey,
    roleDescription: meta?.description || null,
    displayTitle: (typeof m.display_title === 'string' && m.display_title) || null,
    invitedAt: typeof m.invited_at === 'string' ? m.invited_at : null,
    activatedAt: typeof m.activated_at === 'string' ? m.activated_at : null,
  });
}

/** True when this membership is waiting on the invitee to accept it. */
export function staffInvitationPending(membership) {
  return Boolean(membership && membership.exists && membership.status === 'invited');
}

/** Does this context hold `key`? Unknown key, empty context, bad input -> false. */
export function staffCan(ctx, key) {
  if (!ctx || !key || typeof key !== 'string') return false;
  if (!ctx.isStaff || ctx.status !== 'active') return false;
  return Array.isArray(ctx.permissions) && ctx.permissions.includes(key);
}

/**
 * The server-side authorization verdict for an api/admin/* request.
 *
 * api/_lib/staffAuth.js is a thin I/O shell around this: it fetches, this
 * decides. Returns `{ allow, status, code, degraded, legacy, context }`.
 *
 * ★ THIS GATE FAILS CLOSED, and that is a deliberate departure from its
 *   neighbours. api/anthropic and api/elevenlabs/signed-url both fail OPEN when
 *   is_enrolled() is indeterminate, because refusing there would take the product
 *   down over a transient blip and the worst case is some spent tokens. What this
 *   gate protects is the SERVICE-ROLE KEY. An authorization check that could not
 *   run is not a permission granted.
 *
 * ★ The legacy fallback exists only for deploy skew. Vercel ships the code the
 *   moment it is pushed; a human runs the migration afterwards. In that window
 *   my_staff_context() does not exist, and a pre-#45 admin must keep working —
 *   they are a Super Admin by definition, since that is exactly what
 *   profiles.is_admin meant. It applies ONLY to a MISSING function: answering a
 *   timeout or a permission error by consulting a weaker check would convert an
 *   outage into a privilege escalation.
 */
export function staffAuthVerdict({ rpc, permission, legacyIsAdmin = null } = {}) {
  const deny = (extra) => ({
    allow: false, status: 403, code: 'FORBIDDEN', degraded: false, legacy: false,
    context: EMPTY_STAFF_CONTEXT, ...extra,
  });

  if (!permission || typeof permission !== 'string' || !STAFF_PERMISSION_KEYS.includes(permission)) {
    // A handler that forgot to name its permission, or named one that does not
    // exist, must not run as though it were unrestricted.
    return deny({ code: 'STAFF_ROLE_INVALID' });
  }

  if (!rpc || typeof rpc !== 'object') return deny();

  if (rpc.missing) {
    if (legacyIsAdmin === true) {
      return {
        allow: true, status: 200, code: null, degraded: true, legacy: true,
        context: EMPTY_STAFF_CONTEXT,
      };
    }
    return deny({ degraded: true });
  }

  if (rpc.degraded) return deny({ degraded: true });

  const context = rpc.context || EMPTY_STAFF_CONTEXT;
  if (!staffCan(context, permission)) return deny({ context });

  return { allow: true, status: 200, code: null, degraded: false, legacy: false, context };
}

/** A course id must be a uuid before it is forwarded to the database. */
const COURSE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * May this caller act on this specific course? (#45)
 *
 * Holding `course_trainer.manage` says "this person indexes courses". It does not
 * say WHICH courses. This is the second half of that question, and it is a pure
 * function so the rule is testable — `api/admin/course-trainer.js` only fetches.
 *
 * `assignment` is TRI-STATE and that is the whole point:
 *   true          — can_manage_course() said yes
 *   false         — can_manage_course() said no
 *   'unavailable' — the RPC could not be reached or does not exist
 *
 * ★ TWO REGRESSIONS THE #45 REVIEW FOUND, both of which locked out a legitimate
 *   administrator. Keep the handling of both:
 *
 *   1. `can_manage_course` is created by #46, NOT #45. Between the two migrations
 *      the RPC 404s. The first draft treated that as `false` and denied, so every
 *      course-scoped trainer action returned 403 for EVERYONE, Super Admin
 *      included. An absent ownership model must fall through to the capability
 *      check for a `courses.manage_all` holder — there is nothing for it to
 *      narrow. For a Trainer it still denies, because without the model there is
 *      nothing that makes the course theirs.
 *
 *   2. On the legacy pre-#45 path the staff context is EMPTY, so a permissions
 *      check denied the very administrator the fallback exists to keep working.
 *      `legacy` short-circuits: requireStaff already accepted them through
 *      profiles.is_admin, which by definition means Super Admin.
 */
export function courseScopeVerdict({ context, courseId, assignment, legacy = false } = {}) {
  const deny = { allow: false, status: 403, code: 'COURSE_NOT_ASSIGNED' };
  const allow = { allow: true, status: 200, code: null };

  // A pre-#45 admin, accepted by requireStaff's legacy fallback.
  if (legacy === true) return allow;

  const full = staffCan(context, 'courses.manage_all');

  if (!courseId) {
    // No course to scope to. Only someone who may manage every course can act.
    return full ? allow : deny;
  }
  if (!COURSE_ID_RE.test(String(courseId))) return deny;

  if (assignment === true) return allow;
  if (full) return allow;              // manage_all bypasses assignment entirely
  return deny;                         // false OR 'unavailable' → fail closed
}

/**
 * The client mirror of SQL can_manage_course(uuid).
 *
 * Used ONLY to decide what to render. The server re-answers the same question in
 * courses_update / courses_delete RLS and in the storage write policies, and that
 * answer is the one that decides anything.
 */
export function canManageCourseClient(ctx, course) {
  if (!ctx || !ctx.isStaff) return false;
  if (staffCan(ctx, 'courses.manage_all')) return true;
  if (!staffCan(ctx, 'courses.manage_assigned')) return false;
  const id = typeof course === 'string' ? course : course?.id;
  if (!id) return false;
  return Array.isArray(ctx.assignedCourseIds) && ctx.assignedCourseIds.includes(id);
}

/**
 * Admin tab id -> the permission required to open it.
 *
 * ★ THIS IS THE CHOKEPOINT MAP, and it exists because the entitlement chokepoint
 *   in BookkeeperPro.jsx had NO role check. It tested only
 *   entitlement.allowsTab(tabId), and admin tabs are not in DEFAULT_STAGES at
 *   all — they were four hard-coded `{isAdmin && …}` sidebar links. So a
 *   silver_self_paced or vip student (both `full: true`, so allowsTab is always
 *   true) who deep-linked /admin/enrollments MOUNTED AdminEnrollments and ran its
 *   queries. RLS denied the rows and the screen's own `if (!isAdmin)` card
 *   eventually rendered, but the component and its network calls had already run.
 *
 *   Every tab id listed here is refused at the chokepoint unless the viewer holds
 *   the permission. A tab id NOT listed here falls through to the plan
 *   entitlement, which is the correct behaviour for ordinary tools.
 */
export const ADMIN_TAB_PERMISSION = {
  accessrequests: 'access_requests.review',
  enrollments: 'enrollments.review',
  studentimports: 'students.import',
  batches: 'batches.manage',
  staffroles: 'staff.manage',
};

/** Tab ids a Trainer needs in order to reach the course builder at all. */
export const COURSE_AUTHORING_TABS = ['course', 'qbomastery', 'resumestrategy', 'interview'];

/**
 * The Community authority a viewer holds, as three NAMED predicates.
 *
 * ★ WHY THIS REPLACES ONE BOOLEAN. Until #56 the whole Community suite branched on a
 *   single `isAdmin = !!profile?.is_admin` — which since #45 means "active Super Admin"
 *   — and that one flag stood for three different questions: may I open the channel
 *   editor, may I moderate someone else's post, and am I staff here at all. Once
 *   Operations Admins and Trainers hold the community permissions those answers can
 *   differ, so they get separate names.
 *
 * ★ FAIL CLOSED WHILE LOADING. `!staffReady` returns false for both, never true.
 *   Absent permission data means "no". The pre-#40 community bug was a client that
 *   re-derived capabilities and failed OPEN while they loaded.
 *
 * ★ DEGRADED FALLS BACK TO is_admin, NOT TO "assume staff". A staff context we could
 *   not read is answered by the legacy column — the same idiom as adminTabAllowed()
 *   and gateScreen.js's passesAsStaff().
 *
 * staffCan() already requires `status === 'active'`, so an invited, suspended or
 * revoked membership confers nothing here.
 *
 * NOTE: this is a MIRROR. The database is the boundary — has_staff_permission() in the
 * community RPCs and RLS policies (#56). Hiding a control is a courtesy, not a gate.
 */
export function communityAuthority({ staff, staffReady, staffDegraded, isAdmin } = {}) {
  if (staffDegraded) {
    const legacy = Boolean(isAdmin);
    return { canConfigure: legacy, canModerate: legacy, hasStaffAccess: legacy };
  }
  if (!staffReady) return { canConfigure: false, canModerate: false, hasStaffAccess: false };
  const canConfigure = staffCan(staff, 'community.manage');
  const canModerate = staffCan(staff, 'community.moderate');
  return { canConfigure, canModerate, hasStaffAccess: canConfigure || canModerate };
}

/** True when this context should bypass the student paywall for staff work. */
export function staffBypassesPaywall(ctx) {
  return Boolean(ctx && ctx.isStaff && ctx.status === 'active');
}

/**
 * Ops queues in the order the work actually arrives, so "first tab this person
 * may open" is a deliberate ordering rather than an accident of object key order.
 */
const STAFF_LANDING_QUEUES = ['enrollments', 'accessrequests', 'studentimports', 'batches'];

/**
 * Where a staff member should land after accepting an invitation.
 *
 * ★ NEVER pricing. That is the entire point: an Operations Admin or Trainer has
 *   is_admin = false and usually no subscription, so every route that reasons
 *   from "unpaid" sends them to the paywall. This answers from PERMISSIONS
 *   instead, and returns a tab the person demonstrably holds — every candidate is
 *   checked with staffCan(), so a role whose permissions were narrowed in SQL
 *   lands somewhere it can actually open rather than on a RestrictedTab.
 *
 * ★ Returns null for anyone who is not active staff, so the caller keeps its own
 *   default. A pending invitation resolves to null here — landing is decided
 *   after acceptance, never from the invitation itself.
 */
export function staffLandingTab(ctx) {
  if (!staffBypassesPaywall(ctx)) return null;

  // A Super Admin's first question is almost always "who else is in here".
  if (ctx.isSuperAdmin) return 'staffroles';

  for (const tab of STAFF_LANDING_QUEUES) {
    const perm = ADMIN_TAB_PERMISSION[tab];
    if (perm && staffCan(ctx, perm)) return tab;
  }

  // A Trainer holds no admin queue at all; their work is the course library.
  if (staffCan(ctx, 'courses.create')
    || staffCan(ctx, 'courses.manage_assigned')
    || staffCan(ctx, 'courses.manage_all')) {
    return 'qbomastery';
  }

  // Staff with a role that grants no landing surface still get the app, not a
  // refusal — staffEntitlement() has already decided what they may open.
  return 'dashboard';
}

/**
 * Merge staff reach into a student entitlement.
 *
 * A staff account is not a paid account, so it must not be held on the paywall —
 * but "not paywalled" must not silently mean "gets the whole toolkit". This
 * returns the UNION of:
 *   - whatever the person's own plan entitles them to (staff can be paying
 *     members too — an Ops Admin who bought VIP keeps their VIP tabs), and
 *   - the tabs their permissions actually require.
 *
 * A Super Admin resolves to the base entitlement unchanged, which for the root's
 * admin branch is FULL — exactly the pre-#45 behaviour for accounts that had
 * is_admin = true.
 */
export function staffEntitlement(ctx, base) {
  if (!staffBypassesPaywall(ctx)) return base;
  if (ctx.isSuperAdmin) return base;
  if (base && base.full) return base;

  const extra = new Set(['dashboard', 'progress']);
  for (const [tabId, perm] of Object.entries(ADMIN_TAB_PERMISSION)) {
    if (staffCan(ctx, perm)) extra.add(tabId);
  }
  const authors = staffCan(ctx, 'courses.create')
    || staffCan(ctx, 'courses.manage_assigned')
    || staffCan(ctx, 'courses.manage_all');
  if (authors) {
    for (const tabId of COURSE_AUTHORING_TABS) extra.add(tabId);
  }
  if (staffCan(ctx, 'community.moderate') || staffCan(ctx, 'community.manage')) {
    extra.add('community');
  }

  const baseAllowsTab = typeof base?.allowsTab === 'function' ? base.allowsTab.bind(base) : () => false;
  const baseAllowsStage = typeof base?.allowsStage === 'function' ? base.allowsStage.bind(base) : () => false;
  const baseAllowsCourse = typeof base?.allowsCourse === 'function' ? base.allowsCourse.bind(base) : () => false;

  // Course authoring implies reaching the catalogs, which live under these stages.
  const extraStages = new Set(['home']);
  if (extra.has('qbomastery') || extra.has('course')) extraStages.add('training');
  if (extra.has('resumestrategy') || extra.has('interview')) extraStages.add('jobsearch');

  const baseScope = base?.scopeLabel && !base.full ? ` + ${base.scopeLabel}` : '';

  return {
    ...(base || {}),
    full: false,
    staffRoleKey: ctx.roleKey,
    scopeLabel: `${ctx.roleLabel} tools${baseScope}`,
    allowsTab: (id) => extra.has(id) || baseAllowsTab(id),
    allowsStage: (id) => extraStages.has(id) || baseAllowsStage(id),
    // Course VISIBILITY for staff is assignment + plan, and courses_read
    // re-decides it server-side either way.
    allowsCourse: (course) => canManageCourseClient(ctx, course) || baseAllowsCourse(course),
  };
}

/**
 * Can this role change be applied without stranding the product?
 *
 * The rule the whole system rests on: there must always be at least one ACTIVE
 * Super Admin, because Super Admin is the only role that can create another one.
 *
 * This is the client mirror, used for confirm-dialog copy and to disable a
 * control before it is clicked. The server enforces the same rule twice — inside
 * admin_set_staff_role / admin_set_staff_status / admin_revoke_staff, AND as a
 * staff_memberships guard trigger so a direct SQL UPDATE is caught too. Never
 * rely on this function as the boundary.
 *
 * @param {object} target             the membership being changed ({roleKey, status})
 * @param {object} change             the proposed new state ({roleKey?, status?})
 * @param {number} activeSuperAdmins  how many ACTIVE super_admins exist right now
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
export function lastSuperAdminGuard(target, change, activeSuperAdmins) {
  const wasActiveSuper = target?.roleKey === SUPER_ADMIN_ROLE && target?.status === 'active';
  if (!wasActiveSuper) return { ok: true };

  const nextRole = change?.roleKey === undefined ? target.roleKey : change.roleKey;
  const nextStatus = change?.status === undefined ? target.status : change.status;
  if (nextRole === SUPER_ADMIN_ROLE && nextStatus === 'active') return { ok: true };

  if (Number(activeSuperAdmins) > 1) return { ok: true };

  return {
    ok: false,
    code: 'STAFF_LAST_SUPER_ADMIN',
    message:
      'This is the last active Super Admin. Promote another Super Admin first — '
      + 'otherwise nobody can manage staff, courses or settings.',
  };
}

/** Human copy for a staff status. Unknown status renders as itself, never blank. */
export const STAFF_STATUS_LABELS = {
  invited: 'Invited',
  active: 'Active',
  suspended: 'Suspended',
  revoked: 'Revoked',
};

export const STAFF_STATUSES = Object.keys(STAFF_STATUS_LABELS);

/** Label for a status, falling back to the raw value so nothing renders blank. */
export function staffStatusLabel(status) {
  return STAFF_STATUS_LABELS[status] || (status ? String(status) : '—');
}
