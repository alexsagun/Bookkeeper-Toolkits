# Staff roles — setup, the permission matrix, and recovery

Migrations **#45 → #46 → #47**. This is the operator's guide: how to turn the role model on, what
each role can actually do, how to hire someone, and how to get back in if you are locked out.

The design rationale lives in [CLAUDE.md](CLAUDE.md) → "Staff authorization"; the per-migration
detail lives in [db/README.md](db/README.md). This file is the runbook.

---

## 1. What changes the moment #45 runs

Before, authorization was one boolean: `profiles.is_admin`. After, that column means exactly one
thing — **"has an ACTIVE `super_admin` staff membership"** — and it is a **cache**, written only by a
trigger. `UPDATE` on `profiles` is revoked from every client role.

Two consequences worth internalising before you run anything:

1. **`update public.profiles set is_admin = true` no longer works as a way to make an admin.** It
   appears to succeed from the SQL Editor (which runs as the table owner) and is then silently
   reconciled away the next time any membership changes anywhere. The membership row is the
   authority. Use the SQL in [db/README.md](db/README.md) step 4, or `npm run staff:bootstrap`.
2. **Every legacy `is_admin()` check narrows to Super Admin.** That is deliberate. A capability we
   failed to widen becomes a *broken Operations Admin feature* — loud, reported, fixable — instead of
   a *silently over-granted* one. If something an Ops Admin or Trainer should be able to do refuses,
   the fix is to gate that surface on the right permission key. **It is never to set
   `is_admin = true` on a non-super role.**

---

## 2. Order of operations (this order matters)

> ⚠️ **#45 must not be applied before the matching client build is deployed.** It drops
> `profiles_admin_update` and revokes `UPDATE` on `profiles`, but a pre-#45 Access Requests screen
> still issues a direct `profiles.update()`. PostgREST answers a policy-filtered UPDATE with **zero
> rows and no error**, so approving a signup would silently do nothing while reporting success.
> The replacement RPCs (`admin_review_access_request`, `admin_access_request_queue`) ship in the same
> release.

1. **Deploy the client build** (git push → Vercel). It works against a pre-#45 database: every staff
   check has a documented legacy fallback to `profiles.is_admin`.
2. **Run the migrations, in order**, pasting each into Supabase → SQL Editor → Run:
   - `db/2026-08-25-staff-authorization.sql` (#45)
   - `db/2026-08-26-course-staff-assignments.sql` (#46)
   - `db/2026-08-27-special-extension.sql` (#47)
   Each is idempotent and self-guarded; each records itself in `public.schema_migrations`.
3. **Verify**: `npm run db:audit`. Every `#45` / `#46` / `#47` line should read `OK`.
4. **Sign out and back in** so the browser picks up the new staff context.

#45 backfills every account that currently has `is_admin = true` into an active `super_admin`
membership, and **refuses to complete if that would leave none** — so you cannot lock yourself out by
running it.

---

## 3. The permission matrix

Three fixed roles, 18 permissions, 26 grants. Seeded by #45 and mirrored in
[src/lib/staffRoles.js](src/lib/staffRoles.js); `test/staffRolesSql.test.mjs` fails if the two drift.

| Permission | Super Admin | Operations Admin | Trainer |
|---|:--:|:--:|:--:|
| `staff.manage` — invite and manage staff | ✅ | — | — |
| `staff.audit.read` — read the role audit trail | ✅ | — | — |
| `access_requests.review` — approve/reject signups | ✅ | ✅ | — |
| `enrollments.review` — review payment proofs | ✅ | ✅ | — |
| `students.assign_courses` — choose granted courses | ✅ | ✅ | — |
| `students.extend_access` — discretionary extensions | ✅ | — | — |
| `students.import` — run the Thinkific migration | ✅ | ✅ | — |
| `batches.manage` — cohorts and seat assignment | ✅ | ✅ | — |
| `courses.create` — create and duplicate courses | ✅ | — | ✅ |
| `courses.manage_assigned` — edit assigned courses | ✅ | — | ✅ |
| `courses.manage_all` — edit every course | ✅ | — | — |
| `courses.publish` — publish and withdraw | ✅ | — | — |
| `courses.delete` — delete a course and its media | ✅ | — | — |
| `course_trainer.manage` — AI trainer indexing | ✅ | — | ✅ |
| `community.manage` — channels and audiences | ✅ | — | — |
| `community.moderate` — pin/lock/hide/delete | ✅ | — | — |
| `sidebar.customize` — global navigation labels | ✅ | — | — |
| `payment_settings.manage` — payment instructions | ✅ | — | — |

**Two omissions people ask about, both deliberate:**

- **Operations Admin does not hold `students.extend_access`.** A discretionary extension creates paid
  access with no payment behind it, so it stays with the role that owns the money. Ops Admins extend
  access the normal way — by approving an extension *request*, which carries a receipt.
- **Trainer does not hold `courses.publish` or `courses.delete`.** Authoring and shipping are separate
  acts: publishing exposes content to every paying student, and deleting removes storage objects a
  *duplicated* course may still reference by path (duplication reuses files by reference — no copy is
  made).

Both are additive later: insert a `staff_role_permissions` row. Neither can be worked around from the
client, because RLS reads the table, not the JS mirror.

---

## 4. Hiring someone

**Admin → Team & Roles** (Super Admin only) → **Invite staff**.

- A **new** email gets a Supabase invitation and appears as **Invited** until they accept.
- An email that **already has an account** is *promoted* immediately, with no email sent. Their
  existing membership, course progress and community history are untouched — a staff account and a
  student account are the same account.

Membership is keyed by the Auth user's **UUID**, never by email: an address can be changed or
reassigned, but `auth.uid()` is what every RLS policy sees.

**Assigning a Trainer to a course**: open the course, then use the Trainers control (needs
`courses.manage_all`). A Trainer who creates a course is auto-assigned as its owner — otherwise
`courses.create` would be a dead end: create a course, then be unable to edit it.

**Suspending or revoking** requires a reason, and takes effect on that person's **next request** —
not their next sign-in. Authority is read from the database every time, never decoded from their
token.

---

## 5. The last-Super-Admin rule

There must always be at least one **active** `super_admin`, because `super_admin` is the only role
that can create another one. The rule is enforced in three places:

1. `admin_set_staff_status()` / `admin_upsert_staff_membership()` refuse it.
2. A `staff_memberships` BEFORE trigger refuses it — so a direct SQL `UPDATE` is caught too, and
   because `staff_memberships.user_id` is `ON DELETE CASCADE` from `auth.users`, **deleting the last
   Super Admin's Auth account fails as well**. Promote a replacement first.
3. The Team & Roles UI disables the control and explains why (`lastSuperAdminGuard()`).

Keeping **two** Super Admins is the practical advice: the guard then never gets in your way.

---

## 6. Break-glass recovery

If every Super Admin credential is lost, there is deliberately **no** browser-callable "make me an
admin" function. Recovery runs from a trusted environment:

```bash
npm run staff:bootstrap -- --email you@example.com            # dry run, writes nothing
npm run staff:bootstrap -- --email you@example.com --apply    # grants active super_admin
```

It needs `SUPABASE_ACCESS_TOKEN` in `.env` (Supabase Dashboard → Account → Access Tokens), never
prints it, refuses an email that matches zero or more than one profile, shows the planned change
before applying, and is idempotent.

**Why it writes the tables directly instead of calling the RPC:** the Management API executes as the
`postgres` role with no JWT, so `auth.uid()` is NULL, so `has_staff_permission('staff.manage')` is
false and `admin_upsert_staff_membership()` would refuse — every time, for everyone. A SECURITY
DEFINER function that self-gates on the caller's identity is the wrong tool for a path whose whole
point is that there is no caller yet.

The equivalent SQL, if you would rather paste it, is in [db/README.md](db/README.md) step 4.

---

## 7. Verifying it worked

```bash
npm run db:audit          # every #45/#46/#47 line should read OK
npm test                  # the JS↔SQL mirrors
```

Two audit lines are worth understanding, because they catch the failure modes that are otherwise
invisible:

- **`#45 profiles.is_admin agrees with the membership table`** — the cache invariant. If these ever
  disagree, every legacy `is_admin()` check in the product is answering from stale data.
- **`#46 the storage path parser fails closed`** — actually *executes*
  `course_object_course_id()` against malformed paths. It must return NULL for all of them, because
  NULL is what denies the write. The read-side version of this function was deleted in #44 for
  failing OPEN.

Then check it as a human, in two browser profiles:

| Signed in as | Should see | Should NOT see |
|---|---|---|
| Super Admin | everything, incl. Team & Roles | — |
| Operations Admin | Access Requests, Enrollments, Student Imports, Batches | Team & Roles, course builder controls |
| Trainer | the course catalogs + the builder for **assigned** courses | payments, students, batches, staff, Publish/Delete |
| Student | the toolkit their plan entitles them to | every `/admin/*` route, by direct URL too |

The last row is the one to actually test by typing the URL. Hiding a link is a courtesy; the
chokepoint and RLS are the boundary.
