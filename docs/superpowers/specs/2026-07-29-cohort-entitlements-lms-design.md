# Batch Entitlements, Community Permissions & Cohort LMS — Merged Architecture Plan

**Status:** final architecture, ready to execute · **Branch:** `feat/cohort-entitlements-lms` (D4)
**Author:** lead architect merge of 4 domain designs + 8 adversarial reviews
**Baseline:** live DB verified 2026-07-28 (34 migrations applied, #1–#34, no drift)

---

## ⚠ READ THIS FIRST — corrections that supersede parts of this document

This document was produced by a merge step whose input was truncated: it never received the LMS
domain design or its two adversarial critiques (see §0 below, which says so honestly). Those
critiques completed afterwards and found real defects in the LMS half. **Where this document and
the list below disagree, the list below wins.**

| # | Correction | Supersedes |
|---|---|---|
| **L1** | Drip must NOT hide lesson **rows**. `CourseProgram.load()` computes `totalLessons` from an RLS-filtered query, so hiding rows makes the client think the course is shorter, stamp `course_completions`, and issue a PDF certificate for an unfinished course — unrecoverable. Locked lessons stay readable (id/title/position/`locked`) with **content columns withheld** and the media object refused at Storage. | §1.4's `lessons_read … not in (select my_locked_lesson_ids())` |
| **L2** | `course_object_allowed()` **short-circuits to `true` for every full-access plan**, so adding a cohort branch there alone gates nothing for Silver/Gold/VIP. The short-circuit must apply only to non-cohort objects. | §1.4's "same conjunct extends `course_object_allowed`" |
| **L3** | **Gold and VIP share a batch.** Cohort tables scoped only by `batch_id` leak VIP session join URLs and announcements to Gold. Every cohort table carries an `audience` (`both`/`gold`/`vip`) and the L1 seam returns `(batch_id, segment)`, not a bare id set. | §1.4's `batch_id in (select my_entitled_batch_ids())` |
| **L4** | Drip anchored on `batches.starts_on` **fails open when it is NULL** — the state of the only live batch — and setting it later retroactively **re-locks** completed lessons. `starts_on` is required before `cohort_gated`; NULL fails closed; changes never re-lock a lesson with existing progress. | §1.4's `coalesce(pub.starts_on, b.starts_on)` |
| **L5** | `assignments.course_id` must be `on delete restrict`. As designed, `CourseCatalog.deleteCourse()` FK-cascades into `assignment_submissions` and destroys graded student work across every cohort. | §1.4's `on delete cascade` |
| **L6** | `lesson_progress.batch_id` is client-forgeable (own-row ALL policy, no guard). Trigger-stamp from L1 and freeze it. | not covered |
| **L7** | The AI trainer bypasses drip — `trainer_match_chunks` joins only `trainer_visible_courses`. The drip predicate must join it too, and the trainer mirrors join the plan-scope lockstep set. | not covered |
| **L8** | `admin_assign_batch` reassignment must `supersede` the old seat and insert a new one, preserving history — not overwrite. | §2's "routed through grant_batch_run" (correct, but the supersede semantics were unstated) |

Owner decisions taken after this document was written also override it where they conflict:
**D8** capacity counts a seat in **every** cohort of a run (not only the start cohort);
**D9** an extension grants `ceil(extension_days/30)` **more cohorts**;
**D7** the test harness targets a **shadow Supabase project**, not a local Docker stack — §5.1's
Docker analysis is retained for the record but is not the chosen path;
**D10** everything ships in **one deploy**, so §10's phasing is a build order, not a release schedule.

The executable summary of all of this is the approved plan; this document is the SQL-level detail
behind it.

---

## 0. INPUT COMPLETENESS DISCLOSURE (read first)

The merge payload delivered **two** of the four domain designs in full:

| Domain | Design received | Critiques received |
|---|---|---|
| `entitlements` | complete | 2 of 2 (verdicts: `unsound`, `needs_changes`) |
| `community` | truncated mid-`policies[]` (cut at `community_reactions_read`) | 0 of 2 — **not delivered** |
| `lms` (D3) | **not delivered** | **not delivered** |
| 4th domain | **not delivered** | **not delivered** |

Consequences, and how this document compensates:

1. **Community** — the received portion covers the capability model, `user_community_capabilities()`, `my_community_spaces()`, `search_community_members()` and the post/comment policies. The reactions/attachments/tags/storage policies and its migration notes were cut. I reconstruct those from the two entitlements reviewers (who independently attacked the same surfaces — A10, A11, B11), from the verified live policy set, and from #32/#33/#34's own text.
2. **LMS (D3)** — designed here from scratch against D3's explicit scope, D5's scale target, D6's additivity rule, and the verified `courses`/`course_lessons`/`lesson_progress` schema. It is §1.4 + migrations #37/#38.
3. **Un-reviewed surfaces** — anything I authored that no adversarial reviewer saw is marked **`[UNREVIEWED]`**. Those areas carry a mandatory pre-merge review gate (§5.6). Do not treat them as having the same assurance as the entitlements ledger.

Two findings are **mine**, not any reviewer's, and both are blocking:

- **M1 (critical) — `user_is_enrolled(uuid)` already exists.** The entitlements design creates it with the justification "needed because `user_community_space_ids(p_user)` … must apply the SAME live-membership gate", claiming it as new. It was created by **#27** (`db/2026-07-24-course-ai-trainer.sql:249`) as one of the service-role-only trainer mirrors, alongside `user_is_approved(uuid)` (`:265`) and `user_plan_key(uuid)` (`:274`). A `create or replace` in #35 would silently redefine **the AI trainer's authorization predicate**. The proposed body happens to be byte-identical today, so applying it is harmless *right now* — and that is exactly what makes it dangerous: the next person who edits "#35's helper" changes who can talk to the paid course trainer. **Resolution: #35 must not create these three functions. It reuses them, and adds a `pg_proc` assertion that their bodies are unchanged.**
- **M2 (high) — the calendar-arithmetic run model is unimplementable against Alex's real cadence.** Reviewer B7 found the symptom (a skipped month strands a paid seat forever). The cause is deeper: `batch_run_codes()` invents cohort identities from `start + N months`, which is the exact rule `src/lib/communitySpaces.js:11` forbids ("a batch is NEVER inferred from an approval date, signup date, course title, or payment amount"). **Resolution: runs are allocated from the batch REGISTRY in `code` order with a FIFO pending queue — §1.2.** This single change dissolves B7, B2, A8 and A6 outright, and deletes `batch_run_codes()`/`next_batch_code()` from the design (so their DoS surface and their JS-mirror lockstep burden never exist).

---

## 1. FINAL DOMAIN MODEL

### 1.0 The ONE authoritative entitlement source

Three layers. Each layer has exactly one function. Each layer reads only the layer below. **No subsystem may re-derive a lower layer.**

```
L2  CAPABILITY   what may I DO here?
    ├─ public.user_community_capabilities(p_user) → (space_id, kind, can_post, can_comment, can_react, can_attach)
    └─ public.user_batch_course_access(p_user)    → (batch_id, course_id, cohort_gated, released_lesson_ids…)
         reads L1 + enrollment_plans capability columns + community_spaces flags + batch_course_publications
                                        ▲
L1  SCOPE        which cohorts do I hold?          ◀── ★ THE AUTHORITATIVE ENTITLEMENT SOURCE ★
    public.batch_entitlements  (table)
    └─ public.user_entitled_batches(p_user) → (batch_id, segment, batch_index, activates_at, valid_until)
       wrappers: my_entitled_batch_ids(), my_community_space_ids(), user_community_space_ids(p_user)
       seat predicate: public.batch_seat_holders(p_batch_id, p_segment) → setof uuid   (ONE definition, used everywhere)
                                        ▲
L0  MEMBERSHIP   am I a live member?
    public.user_is_enrolled(p_user)   ← #27, DO NOT REDEFINE (M1)
    public.user_is_approved(p_user)   ← #27, DO NOT REDEFINE (M1)
    public.user_plan_key(p_user)      ← #27, DO NOT REDEFINE (M1)
    (auth.uid() forms: is_enrolled(), is_approved(), current_plan_key() — unchanged, hot RLS path)
```

**Rule of the merge:** community space membership, LMS batch scoping, capacity counting, the admin overview, the mention directory and the member-facing "Batches included" panel **all read L1 and only L1**. `subscriptions.batch_id` becomes a write-only start-batch cache, then a deprecated column (§7).

**L1's predicate (the single seat/scope definition — memorise this, it appears in six places):**

```sql
-- A row grants scope IFF all of:
   e.status = 'active'
   and e.batch_id is not null
   and (e.valid_until  is null or e.valid_until  > now())
   and (e.activates_at is null or e.activates_at <= now())
   and e.segment = coalesce(ep_live.community_segment, 'general')   -- ★ LIVE plan reconciliation
   and public.user_is_enrolled(p_user)                              -- L0
   and public.user_is_approved(p_user)                              -- L0
```

The `e.segment = ep_live.community_segment` conjunct is the fix for **A1 / B3** (the critical downgrade leak). It restores by construction the property #32 had for free: the instant a member's *current* plan stops selling a segment, every stamped entitlement for that segment stops resolving — for downgrades, refunds, chargebacks, admin plan corrections and direct SQL edits alike. The ledger's `revoke_batch_run()` on segment change becomes bookkeeping hygiene, not a security control. Defence in depth: both are implemented.

### 1.1 New tables

| Table | Migration | Responsibility (one line) |
|---|---|---|
| `public.batch_entitlements` | #35 | **L1.** Append-only ledger: one row per (member, cohort seat) with provenance, validity and lifecycle. THE entitlement source. |
| `public.batch_course_publications` | #37 | Which global course is offered to which cohort, with cohort ordering and an optional cohort-gate flag. Never duplicates a course. |
| `public.batch_lesson_releases` | #37 | Per-cohort drip: when lesson L unlocks for batch B (absolute `release_at` or `release_offset_days` from `batches.starts_on`). |
| `public.batch_announcements` | #37 | Admin-authored cohort announcements (not community posts — different lifecycle, no threading, no member authorship). |
| `public.batch_sessions` | #37 | Live-session info per cohort: title, start/end, timezone, join URL, recording URL. |
| `public.assignments` | #38 | Assignment definitions, scoped to a course (global) and/or a batch (cohort-specific). |
| `public.assignment_submissions` | #38 | One submission per (assignment, member): draft → submitted → returned → graded, with grade + feedback. |

### 1.2 `batch_entitlements` — the registry-allocated run model (replaces calendar arithmetic; fixes M2/B7/B2/A8/A6)

```sql
create table if not exists public.batch_entitlements (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  -- ALLOCATED cohort. NULL while the seat is queued (no authored batch yet).
  batch_id               uuid references public.batches(id) on delete restrict,
  segment                text not null check (segment in ('gold','vip')),
  -- Position within the member's purchased run (0-based). Ordering key for FIFO allocation.
  batch_index            int  not null check (batch_index >= 0 and batch_index < 24),
  run_id                 uuid not null,
  run_length             int  not null check (run_length between 1 and 24),
  status                 text not null default 'queued'
                         check (status in ('queued','active','revoked','superseded')),
  grant_reason           text not null check (grant_reason in
                           ('approval','renewal','extension','upgrade','import','admin_manual','backfill')),
  source_subscription_id uuid references public.subscriptions(id)       on delete set null,
  source_plan_key        text references public.enrollment_plans(key)   on delete set null on update cascade,
  source_request_id      uuid references public.enrollment_requests(id) on delete set null,
  source_import_row_id   uuid references public.student_import_rows(id) on delete set null,
  granted_by             uuid references public.profiles(id) on delete set null,
  granted_at             timestamptz not null default now(),
  valid_until            timestamptz,          -- stamped from coalesce(grace_ends_at, ends_at); forward-only
  activates_at           timestamptz,          -- stamped at allocation from batches.starts_on (A7)
  allocated_at           timestamptz,
  revoked_at             timestamptz,
  revoked_by             uuid references public.profiles(id) on delete set null,
  revoke_reason          text,
  superseded_by_run_id   uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint batch_entitlements_active_bound   check (status <> 'active' or batch_id is not null),
  constraint batch_entitlements_queued_unbound check (status <> 'queued' or batch_id is null),
  constraint batch_entitlements_revoked_shape  check ((status = 'revoked') = (revoked_at is not null))
);
```

**What changed vs the entitlements design, and why**

- `batch_code` column: **removed.** A seat no longer names a calendar month. It names a *position in the member's run* (`batch_index`) and, once allocated, a real `batches.id`. This is the M2/B7 fix: the ledger can no longer promise a cohort Alex will not run.
- `status='pending'` → **`'queued'`.** Renamed because the semantics changed from "waiting for a specific month to be authored" to "waiting for the next cohort in the registry".
- `batch_run_codes()` / `next_batch_code()`: **not created.** A6's unbounded-`generate_series` DoS surface and the `planBatchCount`/`batchRunCodes` JS-mirror lockstep pair both disappear. Only `plan_batch_count(access_days, override)` survives (pure integer, no date math).
- `source_import_row_id` added so imports (A5/B4) route through the same ledger with the same idempotency anchor the import endpoint already uses.

**Allocation algorithm** (`grant_batch_run`, in one transaction):

1. Resolve the ordered candidate registry:
   ```sql
   select b.id, b.code, b.status, b.starts_on, b.gold_capacity, b.vip_capacity, b.total_capacity
     from public.batches b
    where b.code >= v_start_code           -- start batch's own code, inclusive
      and b.status <> 'archived'
      and exists (select 1 from public.community_spaces sp
                   where sp.batch_id = b.id and sp.kind = p_segment and sp.active)
      and not exists (select 1 from public.batch_entitlements e2      -- never double-seat a cohort
                       where e2.user_id = p_user_id and e2.batch_id = b.id
                         and e2.status in ('queued','active'))
    order by b.code
    limit p_count
    for update;                            -- ★ single ordered lock, ONE statement (fixes B6)
   ```
   `order by b.code` is a **stable global order** for every writer (unlike `batches.id`, which is random uuid — the design's `order by b.id` was a correct deadlock guard but produced an order unrelated to calendar, which reviewer B6 showed still inverted against `admin_finalize_enrollment`'s own start-batch lock).
2. Capacity is checked per candidate against `batch_seat_holders(batch_id, segment)` **inside the same lock** (fixes B6's unlocked-capture window: the lock and the read are one statement's snapshot).
3. `closed` batches are skipped for **new** allocations and accepted when the member already holds a seat there (preserves #33/#34's `v_holds_seat` intent, per-cohort).
4. Rows found → `status='active'`, `batch_id`, `activates_at = coalesce(b.starts_on::timestamptz, date_trunc('month', to_date(b.code||'-01','YYYY-MM-DD')))`.
5. Shortfall (`p_count - found`) → `status='queued'`, `batch_id NULL`, `batch_index` continuing the run.
6. **FIFO binder** — `AFTER INSERT ON batches` trigger `zz_batches_allocate_queued()` and manual `admin_reconcile_queued_entitlements()`:
   ```sql
   -- Allocate the new batch to the OLDEST queued seats whose segment has an active space here,
   -- whose owner does not already hold this batch, and whose term is still live.
   -- Ordered granted_at, batch_index → strict FIFO fairness. Capacity NOT enforced (seats were sold).
   ```
7. Total outstanding (`queued` + `active`) per member is capped at **24** — `grant_batch_run` raises `RUN_LIMIT_EXCEEDED` past it (bounds the runaway A7/B1 scenarios).

**Run length (D1)**

```sql
create or replace function public.plan_batch_count(p_access_days int, p_override int)
returns int language sql immutable parallel safe as $$
  select case when p_override is not null then p_override
              when p_access_days is null then null          -- lifetime premium ⇒ caller must fail closed
              else greatest(1, ceil(p_access_days / 30.0)::int) end;
$$;
```
`enrollment_plans.eligible_batch_count int null check (between 1 and 24)` is the override; left NULL for all five live plans. Effective: **gold_live 180 → 6, vip 180 → 6**, core/sampler/silver 60 → 2 (computed, never materialised).

**Extensions (fixes B1).** `grant_batch_run` takes `p_count` explicitly. `admin_finalize_enrollment` passes:
- `new`/`renewal`/`upgrade` → `plan_batch_count(plan.access_days, plan.eligible_batch_count)`
- `extension` → `greatest(1, least(12, ceil(v_req.extension_days / 30.0)::int))` — derived from **what was actually bought**, not from the plan's own run length. `approve_extension` already clamps `extension_days` to 60–365, so this is 2–12.

**`valid_until` advance (fixes B1's unreachable-code half).** After `approve_subscription`/`approve_extension` returns, `admin_finalize_enrollment` runs an explicit forward-only UPDATE over the member's outstanding rows. Without this the guard trigger's forward-only rule is dead code and an extension leaves already-held seats expiring on the old date.

**D1 — why general-segment plans materialise ZERO rows** (the justification D1 asked for):

1. The invariant is *one row ⇔ one seat in one cohort of Alex's live teaching*. General plans buy no live teaching and no cohort space, so a general row would be a seat in nothing — dead data in an audit table.
2. The General space is granted by a **plan-independent** rule (`sp.kind='general'` for any live member, §1.3). A general row would never be read by any policy.
3. The uniqueness invariant that makes idempotency and FIFO allocation work is *one outstanding seat per (member, cohort)*. General rows would either violate it (a member holding a general row **and** a gold row for the same cohort) or force a composite key into every query in L1/L2.
4. The number stays computable and displayable: `plan_batch_count('core_self_paced')` = 2, exposed by `plan_eligible_batch_count(key)` and mirrored in `src/lib/batchEntitlements.js`, so the paywall can advertise "2 months of group support" today and Alex can flip to materialisation later with one additive migration (D6-compatible).

This is the option that keeps the invariant simplest — the alternative (2 general entitlements granting no space) adds rows that no policy reads, weakens the uniqueness index, and doubles the ledger's row count for the plans that have all the members.

### 1.3 Community — plan × space capability fusion (#36)

Seven fail-closed booleans on `enrollment_plans`: `can_post_in_general`, `can_comment_in_general`, `can_react_in_general`, `can_post_in_private`, `can_comment_in_private`, `can_react_in_private`, `can_upload_attachments`. Defaults: all `false` except the two `can_react_*` (`true` — a reaction creates no content, and D2 mandates reactions for every plan; this is the only permissive default and it is stated in the column comments).

**D2 seed:** every plan gets `can_post_in_general = can_comment_in_general = false`. `gold_live` + `vip` get `can_post_in_private = can_comment_in_private = true`. All five get `can_upload_attachments = true`.

**No `private_community_access` column** — `enrollment_plans.community_segment` already is that flag and L1 already is its enforcement point. A second boolean could disagree with the segment and would add a member to the lockstep set.

**The resolver** (built on L1, never re-deriving it):

```sql
create or replace function public.user_community_capabilities(p_user uuid)
returns table (space_id uuid, kind text, can_post boolean, can_comment boolean,
               can_react boolean, can_attach boolean)
language sql stable security definer set search_path = public rows 5 as $$
  with me as (select coalesce(p.is_admin,false) as is_admin from public.profiles p where p.id = p_user),
  caps as (   -- most-permissive across every currently-valid term (bool_or; today there is exactly one)
    select bool_or(coalesce(ep.can_post_in_general,false))    as post_general,
           bool_or(coalesce(ep.can_comment_in_general,false)) as comment_general,
           bool_or(coalesce(ep.can_react_in_general,true))    as react_general,
           bool_or(coalesce(ep.can_post_in_private,false))    as post_private,
           bool_or(coalesce(ep.can_comment_in_private,false)) as comment_private,
           bool_or(coalesce(ep.can_react_in_private,true))    as react_private,
           bool_or(coalesce(ep.can_upload_attachments,false)) as attach
      from public.subscriptions s join public.enrollment_plans ep on ep.key = s.plan_key
     where s.user_id = p_user and s.status = 'active'
       and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())),
  eff as (select coalesce((select is_admin from me),false) as is_admin,
                 coalesce((select post_general from caps),false)    as post_general,
                 coalesce((select comment_general from caps),false) as comment_general,
                 coalesce((select react_general from caps),true)    as react_general,
                 coalesce((select post_private from caps),false)    as post_private,
                 coalesce((select comment_private from caps),false) as comment_private,
                 coalesce((select react_private from caps),true)    as react_private,
                 coalesce((select attach from caps),false)          as attach)
  select sp.id, sp.kind,
         e.is_admin or (sp.member_posting  and case when sp.kind='general' then e.post_general    else e.post_private    end),
         e.is_admin or (sp.member_comments and case when sp.kind='general' then e.comment_general else e.comment_private end),
         e.is_admin or (sp.member_reactions and case when sp.kind='general' then e.react_general  else e.react_private  end),
         e.is_admin or (sp.member_posting and case when sp.kind='general' then e.post_general else e.post_private end and e.attach)
    from public.community_spaces sp, eff e
   where sp.id in (select public.user_community_space_ids(p_user));   -- L1, single membership seam
$$;
```

Zero-argument wrapper `my_community_capabilities()` is what every policy consumes, as an **uncorrelated** subquery:

```sql
-- ✅ space_id in (select c.space_id from public.my_community_capabilities() c where c.can_post)   -- InitPlan, once/statement
-- ❌ exists (select 1 from public.my_community_capabilities() c where c.space_id = <row>.space_id …)  -- correlated, per row
```

**Space resolution (L1) — the rewritten `user_community_space_ids`:**

```sql
create or replace function public.user_community_space_ids(p_user uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  with me as (select p.is_admin, (p.approval_status='approved' or p.is_admin) as approved, p.is_paid
                from public.profiles p where p.id = p_user),
  cur as (select s.plan_key, s.batch_id from public.subscriptions s
           where s.user_id = p_user and s.status='active'
             and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
           order by s.created_at desc limit 1),
  live_seg as (select coalesce(ep.community_segment,'general') as segment
                 from cur c join public.enrollment_plans ep on ep.key = c.plan_key),
  gate as (select coalesce((select is_admin from me),false) as is_admin,
                  (coalesce((select approved from me),false)
                   and (exists (select 1 from cur)
                        or (coalesce((select is_paid from me),false)
                            and not exists (select 1 from public.subscriptions s2 where s2.user_id=p_user)))) as is_member),
  ent as (                                       -- L1 scope, LIVE-segment reconciled (A1/B3)
    select e.batch_id, e.segment
      from public.batch_entitlements e
     where e.user_id = p_user and e.status='active' and e.batch_id is not null
       and (e.valid_until  is null or e.valid_until  > now())
       and (e.activates_at is null or e.activates_at <= now())
       and e.segment = (select segment from live_seg)),
  legacy as (                                    -- STAGED BRIDGE — per-user, subordinate to the ledger (A2/B4)
    select c.batch_id, coalesce(ep.community_segment,'general') as segment
      from cur c join public.enrollment_plans ep on ep.key = c.plan_key
     where c.batch_id is not null
       and coalesce(ep.community_segment,'general') in ('gold','vip')
       and not exists (select 1 from public.batch_entitlements e2 where e2.user_id = p_user)),
  scope as (select batch_id, segment from ent union select batch_id, segment from legacy)
  select sp.id from public.community_spaces sp, gate g
   where g.is_admin
      or (g.is_member and sp.active
          and (sp.kind='general'
               or exists (select 1 from scope s where s.segment = sp.kind and s.batch_id = sp.batch_id)));
$$;
```

The `not exists (… batch_entitlements e2 …)` guard is the **A2 fix**: the bridge serves only members who have *never* had a ledger row (true pre-#35 grants). The moment a member gets one row, revocation bites immediately. Combined with routing imports + `admin_assign_batch` through `grant_batch_run` (§A5 fix), the bridge's population is provably empty after #35's backfill, and #39 deletes it.

**D2 policy consequences** (INSERT unchanged in shape, capability source swapped; UPDATE **split** — fixes A3):

```sql
-- community_posts_own_update  WITH CHECK (the split; same for community_comments_own_update with can_comment)
and ((select public.is_admin())
  or ((select public.is_approved()) and (select public.is_enrolled())
      and ( (community_posts.status = 'deleted'          -- WITHDRAW: always allowed in a space you belong to
             and community_posts.space_id in (select public.my_community_space_ids()))
         or (community_posts.status = 'active'           -- KEEP PUBLISHED (edit): needs create rights
             and community_posts.space_id in
                 (select c.space_id from public.my_community_capabilities() c where c.can_post)) )))
```

Without the split, gating the whole policy on `can_post` strands every historical General post (its author could neither edit nor delete). Without any split, a Core member keeps republishing content D2 forbids. **Documented consequence:** a soft-delete in General is terminal (restoring sets `status='active'`, which needs `can_post`). The client only ever soft-deletes and treats `deleted` as terminal, so no UI change is needed.

**Attachments/storage (fixes A10).** `community_media_own_insert`'s legacy `<uid>/…` branch is narrowed for INSERT to require a space the uploader may post **and** attach in; the branch is retained for READ and DELETE so existing objects stay reachable (preserving #34's delete-parity gate). An admin orphan sweep RPC `admin_community_media_orphans(p_limit)` lists objects with no `community_attachments.storage_path` match.

**Mention directory (fixes A11).** `search_community_members(p_query, p_space_id)` gains: `p_space_id` is **required** (null → `FORBIDDEN`), the caller must hold `can_post OR can_comment` in that space, `kind='general'` is refused (D2: no mentions there), and `char_length(btrim(p_query)) >= 2`. Signature unchanged → `create or replace`, no client call-site change beyond always passing the space id (which `MentionTextarea` already has).

### 1.4 LMS — cohort delivery on global courses (D3) `[UNREVIEWED]`

Design rule: **courses/modules/lessons stay global and singular.** A cohort never owns content; it owns a *publication* of content plus a *schedule*. No video, no `storage_path`, no `cover_path` is ever copied (copy-on-write by reference, matching `removeMediaIfUnreferenced()`'s existing contract).

```sql
-- #37
create table public.batch_course_publications (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  published boolean not null default false,
  position int not null default 0,
  cohort_gated boolean not null default false,   -- true ⇒ drip applies to this course's lessons for this batch
  starts_on date,                                 -- overrides batches.starts_on for offset arithmetic
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (batch_id, course_id));

create table public.batch_lesson_releases (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  release_at timestamptz,            -- absolute
  release_offset_days int,           -- relative to coalesce(pub.starts_on, batches.starts_on)
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (batch_id, lesson_id),
  constraint batch_lesson_releases_one_rule check (num_nonnulls(release_at, release_offset_days) <= 1));

create table public.batch_announcements (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  title text not null, body text not null,
  pinned boolean not null default false,
  status text not null default 'active' check (status in ('active','hidden')),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table public.batch_sessions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  title text not null, description text,
  starts_at timestamptz not null, ends_at timestamptz,
  timezone text not null default 'Asia/Manila',
  join_url text, recording_url text,
  status text not null default 'scheduled' check (status in ('scheduled','live','done','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

-- #38
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid references public.courses(id) on delete cascade,
  batch_id  uuid references public.batches(id) on delete cascade,
  lesson_id uuid references public.course_lessons(id) on delete set null,
  title text not null, instructions text,
  due_at timestamptz, max_points numeric(6,2),
  submission_kind text not null default 'text' check (submission_kind in ('text','file','link','text_file')),
  published boolean not null default false, position int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint assignments_scope check (course_id is not null or batch_id is not null));

create table public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  batch_id uuid references public.batches(id) on delete set null,   -- stamped by trigger from L1
  status text not null default 'draft' check (status in ('draft','submitted','returned','graded')),
  body_text text, link_url text, storage_path text,
  submitted_at timestamptz, grade numeric(6,2), feedback text,
  graded_by uuid references public.profiles(id) on delete set null, graded_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (assignment_id, user_id));
```

**Drip enforcement without correlated RLS.** A zero-argument SRF returns the (small) set of lesson ids currently withheld from the caller:

```sql
create or replace function public.my_locked_lesson_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select r.lesson_id
    from public.batch_lesson_releases r
    join public.batch_course_publications pub
      on pub.batch_id = r.batch_id and pub.cohort_gated and pub.published
    join public.batches b on b.id = r.batch_id
   where r.batch_id in (select public.my_entitled_batch_ids())
     and coalesce(r.release_at,
                  (coalesce(pub.starts_on, b.starts_on)::timestamptz
                   + make_interval(days => coalesce(r.release_offset_days, 0)))) > now()
     and not (select public.is_admin());
$$;
```

`lessons_read` gains exactly one uncorrelated conjunct: `and course_lessons.id not in (select public.my_locked_lesson_ids())`. Same conjunct extends `course_object_allowed(name)` for the private `course-videos` bucket. **Drip never widens access** — it only withholds; `courses_read`'s plan scope remains the outer boundary, so a cohort publication can never hand a Sampler member a Mastery course.

**LMS read RLS** — every cohort table is scoped `batch_id in (select public.my_entitled_batch_ids())` (the L1 seam) `or (select public.is_admin())`, plus `published`/`status='active'` for member reads. `assignment_submissions` is own-row for members (`user_id = (select auth.uid())`), all-access for admins, with a `BEFORE INSERT` trigger stamping `batch_id` from L1 and freezing it, and a `WITH CHECK` refusing member updates once `status in ('submitted','graded')` (members may edit drafts and resubmit only while `returned`).

**New private bucket `assignment-files`** (25 MB, `<batch_id>/<uid>/<uuid>-<name>`), read = own object or admin, insert bound to a batch in L1, delete = own draft or admin.

### 1.5 Altered tables (all additive, D6)

| Table | Migration | Change |
|---|---|---|
| `enrollment_plans` | #35 | `+ eligible_batch_count int null` (D1 override) |
| `enrollment_plans` | #36 | `+ 7 capability booleans` (§1.3) |
| `batches` | #35 | `+ total_capacity int null` (combined gold+vip cap); `+ batches_touch_updated_at` trigger (#32 gap) |
| `batch_events` | #35 | action CHECK widened: `+ entitle, entitle_allocate, entitle_revoke, entitle_supersede, entitle_extend, unassign` |
| `community_spaces` | #36 | **DATA:** General → `member_posting=false, member_comments=false, member_reactions=true` + CHECK pin (§2b) |
| `courses` | #37 | `+ is_cohort_only boolean not null default false` (never appears in the public prefix catalogs) |
| `subscriptions` | #39 | `batch_id` marked read-deprecated (comment only; column retained, still written) |

---

## 2. MIGRATION SEQUENCE

Chain: `… #31 → #32 → #33 → #34 → **#35 → #36 → #37 → #38 → #39**`. Nothing between #34 and #35.

Every file: guarded preflight → idempotent body → `notify pgrst, 'reload schema'` → verification block → `schema_migrations` insert. Every `add constraint` is preceded by a `pg_constraint` lookup (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`). Every `drop function` is followed by an explicit re-`grant` (a dropped function loses its grants — the classic way a drop+recreate silently breaks an admin screen).

### #35 — `db/2026-07-30-batch-entitlements.sql`

**Contains** (in this section order):
0. Preflight guards · 1. `app_error()` + `app_error_catalog()` · 2. Column adds (`batches.total_capacity`, `enrollment_plans.eligible_batch_count`, `batch_events` vocabulary, `batches_touch_updated_at`) · 3. `batch_entitlements` table + 7 indexes + RLS + **explicit role revokes** · 4. `plan_batch_count()` / `plan_eligible_batch_count()` · 5. `batch_entitlements_guard()` trigger · 6. `batch_seat_holders()` — the ONE seat predicate · 7. `grant_batch_run()` / `revoke_batch_run()` / `admin_revoke_batch_run()` / `admin_revoke_batch_entitlement()` · 8. `zz_batches_allocate_queued()` trigger + `admin_reconcile_queued_entitlements()` · 9. `user_entitled_batches()` / `user_entitled_batch_ids()` / `my_entitled_batch_ids()` / rewritten `user_community_space_ids()` + re-issued `my_community_space_ids()` · 10. `admin_finalize_enrollment()` (#34 base text + entitlement materialisation) · 11. `admin_assign_batch()` (routed through `grant_batch_run`) / `admin_grant_batch_entitlements()` / `admin_batch_overview()` (rewritten over L1) / `admin_batches_needing_assignment()` · 12. `community_write_denial()` / `course_access_denial()` · 13. `v_batch_entitlement_drift` + column comments · 14. **Backfill** · 15. `notify pgrst` · 16. Verification · 17. `schema_migrations`.

**Preflight guards** (abort, do not degrade):

```sql
do $$
begin
  if to_regclass('public.batches') is null or to_regclass('public.community_spaces') is null then
    raise exception '#35 requires #32 (db/2026-07-28-community-spaces-batches.sql).'; end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception '#35 requires #31 — the tail insert would abort the migration.'; end if;
  -- #34 restored what #33 broke. #35's base text is #34's; applying on a #33-only DB re-loses it.
  if not exists (select 1 from pg_proc where proname='admin_finalize_enrollment'
                   and prosrc like '%rejected_at = null%' and prosrc like '%v_holds_seat%') then
    raise exception '#35 requires BOTH #33 and #34 — run db/2026-07-29-batch-hardening-followup.sql first.'; end if;
  -- M1: the three L0 mirrors are #27's. #35 must NOT redefine them.
  if to_regproc('public.user_is_enrolled(uuid)') is null
     or to_regproc('public.user_is_approved(uuid)') is null
     or to_regproc('public.user_plan_key(uuid)') is null then
    raise exception '#35 requires #27 (course-ai-trainer) — it supplies user_is_enrolled/user_is_approved/user_plan_key.'; end if;
  if not exists (select 1 from pg_proc where proname='user_is_enrolled'
                   and prosrc like '%grace_ends_at%' and prosrc like '%not exists%') then
    raise exception '#35: user_is_enrolled(uuid) has drifted from #27''s body — reconcile before proceeding.'; end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='enrollment_plans' and column_name='community_segment') then
    raise exception '#35 requires enrollment_plans.community_segment (#32).'; end if;
end $$;
```

**RLS + grants on `batch_entitlements`** (fixes A9 — Supabase's default privileges leave `authenticated` holding table DML):

```sql
alter table public.batch_entitlements enable row level security;
drop policy if exists batch_entitlements_read on public.batch_entitlements;
create policy batch_entitlements_read on public.batch_entitlements
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
-- NO insert/update/delete policy: writes go only through the SECURITY DEFINER RPCs (community_notifications precedent).
revoke insert, update, delete, truncate on public.batch_entitlements from authenticated, anon, public;  -- ★ A9
grant select on public.batch_entitlements to authenticated;
```

Single permissive SELECT policy (not the house `*_read` + `*_admin_all` pair) so the table adds nothing to the 31 `multiple_permissive_policies` advisor findings; both branches `(select …)`-wrapped per #29.

**Guard trigger** — hardened per A9 and RI-safe per B5:

```sql
-- INSERT: validate the contract, since this is the layer that survives a policy mistake.
--   • segment must match an ACTIVE community_spaces row of that kind for the bound batch
--   • valid_until must not exceed the source term's coalesce(grace_ends_at, ends_at)
--   • granted_by, when non-null, must be an admin
--   • status='active' requires a resolvable batch_id
-- UPDATE: frozen columns = user_id, segment, batch_index, run_id, run_length, grant_reason,
--         granted_at, created_at.  ★ B5 EXEMPTION: the four nullable provenance FKs
--         (source_subscription_id, source_plan_key, source_request_id, source_import_row_id) and
--         granted_by MAY transition to NULL — that is Postgres executing ON DELETE SET NULL /
--         ON UPDATE CASCADE as an UPDATE, and freezing them makes every referenced profile,
--         request, subscription and plan key permanently undeletable.
--         Reject only non-null → different-non-null.
--   batch_id: NULL → real id ONCE (allocation). Never re-pointed, never cleared.
--   status: queued → active → {revoked|superseded} (terminal).
--   valid_until: forward-only; NULL → non-NULL is a revoke, not an edit.
```

**Backfill** (§14) — idempotent, capacity **not** enforced (these members already paid; a cap set later must never retro-refuse them), archived batches skipped with a `raise notice`:

```sql
do $$
declare r record; v_users int := 0; v_skipped int := 0;
begin
  for r in
    select s.id, s.user_id, s.plan_key, s.request_id,
           coalesce(s.grace_ends_at, s.ends_at) as valid_until, b.id as batch_id, b.code as batch_code,
           coalesce(ep.community_segment,'general') as segment,
           public.plan_batch_count(ep.access_days, ep.eligible_batch_count) as run_count
      from public.subscriptions s
      join public.batches b on b.id = s.batch_id
      join public.enrollment_plans ep on ep.key = s.plan_key
     where s.status='active' and (s.ends_at is null or coalesce(s.grace_ends_at, s.ends_at) > now())
       and coalesce(ep.community_segment,'general') in ('gold','vip')
       and not exists (select 1 from public.batch_entitlements e
                        where e.user_id = s.user_id and e.status in ('queued','active'))
     order by s.user_id
  loop
    if r.run_count is null then
      raise notice '#35 backfill: user % on lifetime premium plan % has no eligible_batch_count — skipped', r.user_id, r.plan_key;
      v_skipped := v_skipped + 1; continue;
    end if;
    perform public.grant_batch_run(r.user_id, r.segment, r.batch_code, r.run_count, 'backfill',
                                   r.id, r.plan_key, r.request_id, null, r.valid_until, null, false);
    v_users := v_users + 1;
  end loop;
  raise notice '#35 backfill: % premium subscription(s) materialised, % skipped', v_users, v_skipped;
end $$;
```

On the current live DB this is a **no-op** (0 subscriptions with a non-null `batch_id`, 0 Gold/VIP members) — which is precisely why it must be written and reviewed now rather than when it matters. Historical expired/cancelled premium subscriptions are deliberately not backfilled: inventing `granted_at`/`valid_until` for closed terms puts fictional rows in an audit table; `batch_events` + `subscriptions` remain the pre-#35 record.

**Verification (§16):**

```sql
select count(*) from public.batch_entitlements;                                        -- 0 on the live DB
select indexname from pg_indexes where tablename='batch_entitlements';                 -- 7 + PK
select has_table_privilege('authenticated','public.batch_entitlements','insert'),      -- f  ★ A9
       has_table_privilege('authenticated','public.batch_entitlements','update'),      -- f
       has_table_privilege('authenticated','public.batch_entitlements','delete');      -- f
select prosrc like '%rejected_at = null%' as clears_rejection,
       prosrc like '%v_holds_seat%'       as has_seat_fix,
       prosrc like '%grant_batch_run%'    as materialises_run
  from pg_proc where proname='admin_finalize_enrollment';                              -- t | t | t
select prosrc like '%live_seg%' as segment_reconciled,
       prosrc like '%not exists (select 1 from public.batch_entitlements e2%' as bridge_subordinate
  from pg_proc where proname='user_community_space_ids';                               -- t | t   ★ A1/A2
select public.plan_eligible_batch_count('gold_live'), public.plan_eligible_batch_count('vip'),
       public.plan_eligible_batch_count('core_self_paced');                            -- 6 | 6 | 2
select count(*) from public.user_community_space_ids('00000000-0000-0000-0000-000000000000'::uuid);  -- 0
select has_function_privilege('authenticated','public.grant_batch_run(uuid,text,text,int,text,uuid,text,uuid,uuid,timestamptz,uuid,boolean)','execute'); -- f
select drift, count(*) from public.v_batch_entitlement_drift group by 1;                -- only 'ok'
-- Error convention round trip (run from the APP as an admin, not the SQL editor):
--   rpc('admin_finalize_enrollment',{p_request_id:'<a gold request>'}) with no batch
--   → HTTP 422, { code:'PT422', hint:'BATCH_REQUIRED', details:'{"code":"BATCH_REQUIRED",…}' }
```

**Rollback:** back up the ledger (`create table batch_entitlements_rollback_backup as select * from batch_entitlements`), restore `user_community_space_ids` from #32 §8 and `admin_finalize_enrollment` from #34 §1 verbatim (both are `create or replace`), drop the two new triggers, `delete from schema_migrations where filename='2026-07-30-batch-entitlements.sql'`, `notify pgrst`. Steps 1–3 return the DB to exactly #34 behaviour — the bridge #35 relies on is the same `subscriptions.batch_id` rule #32 used, so **no member loses access on rollback.**

### #36 — `db/2026-07-31-community-plan-capabilities.sql`

**Contains:** the 7 capability columns + one-time D2 seed (guarded by a `v_fresh` first-apply check so it never clobbers a later admin edit) · **the D2 flip on `community_spaces` + the CHECK pin** · `user_community_capabilities()` / `my_community_capabilities()` · rewritten `my_community_spaces()` (DROP+CREATE, return type change, **re-grant**) · rewritten `search_community_members()` (A11 gate) · the 6 post/comment/reaction policies re-pointed at the capability SRF · the **withdraw/keep-published UPDATE split** (A3) · narrowed `community_media_own_insert` (A10) + `admin_community_media_orphans()` · verification · `schema_migrations`.

**Ordering dependency:** hard on #35 (`my_community_capabilities` → `user_community_space_ids` → `batch_entitlements`). Guard aborts if `to_regclass('public.batch_entitlements')` is null.

**Deliberate deviation from the entitlements design:** D2 lives entirely in **#36**, not #35. Rationale — D2 is a product decision about community permissions; bundling the space-flag flip into the entitlement ledger would mean (a) a #35 rollback also reverts a product decision, and (b) #35 could not ship independently of a client release. Keeping #35 **member-invisible** is the single largest deployment-safety win available here.

**Rollback:** drop the CHECK, restore `member_posting=true, member_comments=true` on General, restore the 6 policies + `my_community_spaces()` + `search_community_members()` from #32/#33 verbatim. Capability columns may stay (unread, harmless). **Forward-recovery preferred:** if only the client is broken, flip `community_spaces.member_posting`/`member_comments` back on for General — a data change, no migration — and the policies degrade to pre-D2 behaviour without touching schema.

### 2b. ★ PROD DRIFT AND THE USER-VISIBLE CONSEQUENCE OF #36 ★

**Verified prod state:** `community_spaces` where `kind='general'` currently has **`member_posting = true` and `member_comments = true`**. #32 seeded `member_comments = false`; a documented "temporary softening" UPDATE set it `true` and **was never reverted**. Prod has drifted from the migration's intent.

**#36 sets BOTH to `false` for General, for every plan, and pins it with a CHECK constraint:**

```sql
update public.community_spaces
   set member_posting=false, member_comments=false, member_reactions=true, updated_at=now()
 where kind='general' and (member_posting or member_comments or not member_reactions);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='community_spaces_general_announcement_only') then
    alter table public.community_spaces add constraint community_spaces_general_announcement_only
      check (kind <> 'general' or (member_posting = false and member_comments = false));
  end if;
end $$;
comment on constraint community_spaces_general_announcement_only on public.community_spaces is
  'D2 (#36): General is announcement-only. To reverse the product decision, DROP this constraint explicitly and record it in db/README.md — do not work around it with an UPDATE.';
```

**User-visible consequence, stated plainly:**

> On the day #36 ships, **100% of current members lose the ability to write anything in the community.** There are 4 profiles, 2 subscriptions, **zero Gold/VIP subscribers**, and all 3 existing community posts are in General. Every current member is on a general-segment plan (core / sampler / silver), so after #36 the *entire* member write surface — New Topic, replies, mentions, attachments, and the reply/mention notification fan-out — is gone for all of them. What remains for members in General: **reading everything (including the 3 existing member posts and all historical replies) and reacting.** Only Alex (admin) can post. Gold and VIP members will regain full forum rights, but only inside their own per-batch private space — and there are none of those members today.

**Therefore #36 MUST ship simultaneously with its client build.** The currently deployed client derives `canPost = !spacesFailed && (isAdmin || !currentSpace || currentSpace.member_posting !== false)` (`src/BookkeeperPro.jsx:15563`) — it defaults **open** whenever `currentSpace` is unresolved, so a stale bundle shows a New Topic button whose submit returns a bare 42501 RLS error. §4 makes the client fail closed, adds an announcement-only empty state, and routes denials through `community_write_denial()`.

**The 3 existing member posts in General:** left readable and author-withdrawable (the UPDATE split guarantees this). No migration touches them. If Alex wants them gone he hides them from the admin moderation UI — a manual, reversible act, not a data migration.

### #37 — `db/2026-08-01-lms-batch-delivery.sql` `[UNREVIEWED]`

**Contains:** the 4 cohort tables (§1.4) + indexes + RLS scoped by `my_entitled_batch_ids()` · `courses.is_cohort_only` · `my_locked_lesson_ids()` · **extension of `lessons_read` + `course_object_allowed()` with the drip conjunct** · `user_batch_course_access()` · `batch_curriculum(p_batch_id)` admin RPC · `my_cohort_overview()` member RPC (publications + next session + unread announcements in one round trip) · `admin_publish_course_to_batch()` / `admin_set_lesson_release()` · verification · `schema_migrations`.

**Hard dependencies:** #35 (`my_entitled_batch_ids`), #19 (`courses.access_tier` — `lessons_read`'s current shape), #30 (`course-videos` policy baseline).
**Highest-risk statement:** re-creating `lessons_read`. It is on the hot content path and is the policy #9/#12/#17/#19/#29 have each rewritten. The file must `create or replace` it from the **#19 + #29 text verbatim** plus exactly one added conjunct, and the verification block must assert all five pre-existing clauses survive:
```sql
select prosrc is null from pg_policies where policyname='lessons_read';  -- (policy text via pg_policies.qual)
select qual like '%plan_is_qbo_only%' and qual like '%plan_is_sampler%' and qual like '%access_tier%'
       and qual like '%my_locked_lesson_ids%' from pg_policies where policyname='lessons_read';  -- t
```
This is the #33→#34 failure mode (reconstructing a body from memory) and it is the single most likely place to repeat it.

**Rollback:** restore `lessons_read` + `course_object_allowed()` from #19/#29, drop the 4 tables (no other table references them), delete the `schema_migrations` row.

### #38 — `db/2026-08-02-lms-assignments.sql` `[UNREVIEWED]`

**Contains:** `assignments` + `assignment_submissions` + indexes + RLS + the `batch_id`-stamping trigger + the submitted/graded freeze · the private `assignment-files` bucket + 4 storage policies · `my_assignments()` / `admin_assignment_roster(p_assignment_id)` RPCs · verification · `schema_migrations`.
**Depends on:** #37 (`batch_course_publications` for scoping) + #35.
**Rollback:** drop both tables + the bucket policies; the bucket itself is left (objects preserved) with a note in the ledger.

### #39 — `db/2026-08-03-legacy-batch-id-retire.sql`

**Gated, not scheduled.** Runs only when all three hold:

```sql
select drift, count(*) from public.v_batch_entitlement_drift group by 1;   -- MUST be 'ok' only
select count(*) from public.subscriptions s                                 -- MUST be 0
  join public.enrollment_plans ep on ep.key = s.plan_key
 where s.status='active' and coalesce(ep.community_segment,'general') in ('gold','vip')
   and not exists (select 1 from public.batch_entitlements e where e.user_id = s.user_id);
select count(*) from public.student_import_rows                             -- MUST be 0
 where processing_status='processed' and proposed_batch_id is not null
   and not exists (select 1 from public.batch_entitlements e where e.source_import_row_id = id);
```

**Contains:** `user_community_space_ids()` re-created **without** the `legacy` CTE · `user_entitled_batches()` likewise · comment on `subscriptions.batch_id` → read-deprecated · `schema_migrations`.
**Rollback:** re-apply #35's version of both functions (one `create or replace` each).

### 2c. Bootstrap fold-in (`db/000_full_database_bootstrap.sql`)

The bootstrap is the collapsed fresh-install schema and must stay in lockstep. Current tail: `§18` (2026-07-26 backend pass) → `§19` (#32 verbatim) → `§20` (#33 verbatim) → `§21` (#34 verbatim).

Append **verbatim, in order, at the tail**:

| Section | File |
|---|---|
| `§22` | `2026-07-30-batch-entitlements.sql` (#35) |
| `§23` | `2026-07-31-community-plan-capabilities.sql` (#36) |
| `§24` | `2026-08-01-lms-batch-delivery.sql` (#37) |
| `§25` | `2026-08-02-lms-assignments.sql` (#38) |
| `§26` | `2026-08-03-legacy-batch-id-retire.sql` (#39) — **only after #39 actually runs in prod** |

Rationale for verbatim-tail (not merge-into-§14/§15b): identical to why #32/#33/#34 were folded that way — the earlier sections create the pre-#35 shapes, and the later files' DROP+CREATE must win on a fresh install. The files are idempotent and self-guarded, so appending reproduces the live end state exactly. **Re-fold whenever one of these files changes.** Two adjustments needed at fold time:
- #35's preflight guard on #27's `user_is_enrolled` passes in the bootstrap because §16b (#27) precedes §22.
- #35's backfill matches nothing on a fresh DB (the guarded `not exists` + zero rows) — same class as the #9/#12 grandfather backfills the bootstrap already omits, but here it is harmless to keep, so keep it verbatim.

### 2d. schema_migrations inserts (mandatory, #31 rule)

```sql
insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-07-30-batch-entitlements.sql', null,
  'batch_entitlements ledger (#35): registry-allocated runs + FIFO queue, one seat predicate, live-segment reconciliation, entitlement-backed user_community_space_ids (per-user legacy bridge), PT-errcode stable error codes, imports+assign routed through grant_batch_run'),
 ('2026-07-31-community-plan-capabilities.sql', null,
  'per-plan community capabilities (#36): 7 enrollment_plans flags + user_community_capabilities(), D2 General announcement-only (posting+commenting OFF, reactions ON) + CHECK pin, withdraw/keep-published UPDATE split, search_community_members create-rights gate, community-media insert narrowed'),
 ('2026-08-01-lms-batch-delivery.sql', null,
  'cohort LMS (#37): batch_course_publications / batch_lesson_releases / batch_announcements / batch_sessions, my_locked_lesson_ids() drip conjunct on lessons_read + course_object_allowed'),
 ('2026-08-02-lms-assignments.sql', null,
  'cohort LMS (#38): assignments + assignment_submissions + assignment-files bucket'),
 ('2026-08-03-legacy-batch-id-retire.sql', null,
  'retires the subscriptions.batch_id read bridge (#39) — gated on v_batch_entitlement_drift = 0')
on conflict (filename) do nothing;
```
Each file inserts **only its own row**, at its own tail, in the same SQL-editor session.

---

## 3. ERROR-CODE CONTRACT

### 3.1 Mechanism

```sql
create or replace function public.app_error(p_code text, p_message text,
                                            p_http int default 400, p_context jsonb default null)
returns void language plpgsql as $$
begin
  raise exception using
    errcode = 'PT' || lpad(greatest(400, least(599, coalesce(p_http,400)))::text, 3, '0'),
    message = p_message,                                          -- unchanged human text
    detail  = jsonb_build_object('code', p_code, 'context', coalesce(p_context,'{}'::jsonb))::text,
    hint    = p_code;                                             -- ★ the client's branch key
end; $$;
revoke all on function public.app_error(text, text, int, jsonb) from public, anon, authenticated;
```

**How it crosses PostgREST into supabase-js.** SQLSTATE `PT###` is PostgREST's documented HTTP-status override. The raise becomes `{ "code": <SQLSTATE>, "message": <MESSAGE>, "details": <DETAIL>, "hint": <HINT> }`, surfaced as `PostgrestError { code, message, details, hint }`:

| supabase-js field | value | use |
|---|---|---|
| `error.code` | `'PT409'` | HTTP status echo — **never branch on this** |
| `error.hint` | `'BATCH_FULL'` | **THE branch key** |
| `error.details` | `'{"code":"BATCH_FULL","context":{"batch_code":"2026-08","used":10,"capacity":10}}'` | message interpolation |
| `error.message` | the same human sentence the admin saw pre-#35 | fallback copy |

**Accepted residual risk (reviewer A, medium — incorporated as a constraint, not a fix):** `PT###` is stable in PostgREST 9→12 (what Supabase runs) but is not a Postgres guarantee. If the mapping ever changes, the status degrades (probably to 400) while `hint`/`details` keep working. **Therefore the client branches on `hint` only** and never on HTTP status; no retry logic keys on 409. Verified by one real round trip post-deploy (#35 verification step 6).

**Rejected alternative:** a `jsonb` `{ok:false}` return envelope. `admin_finalize_enrollment` must be all-or-nothing; returning a value commits the transaction and the half-granted subscription would persist. Only a raise rolls back.

**RLS denials cannot carry a code** — Postgres raises 42501 from the executor with a fixed message and there is no hook. Moving authorization out of RLS into BEFORE-INSERT triggers to "code" them is explicitly refused. Instead, RLS stays the boundary and two read-only diagnostic RPCs *explain* denials: `community_write_denial(p_space_id, p_kind)` and `course_access_denial(p_course_id)`. The client uses them to **pre-disable** the composer / show honest copy, never to authorize.

### 3.2 The final code list

| Code | HTTP | Raised by | Meaning |
|---|---|---|---|
| `BATCH_REQUIRED` | 422 | rpc | A gold/VIP action needs an explicit open batch; none supplied. |
| `BATCH_NOT_FOUND` | 404 | rpc | Batch id or month code does not exist. |
| `BATCH_CLOSED` | 409 | rpc | Batch is closed to new assignments, or archived. |
| `BATCH_FULL` | 409 | rpc | A cohort in the run has no seats left (per-segment or total capacity). |
| `NO_SPACE_FOR_SEGMENT` | 409 | rpc | Batch has no active community space for that segment. |
| `INVALID_BATCH_CODE` | 422 | rpc | Not a real `YYYY-MM` month. |
| `ENTITLEMENT_EXPIRED` | 403 | rpc | Membership term (or grace) has ended. |
| `INVALID_PLAN` | 422 | rpc | Unknown, inactive, or non-premium plan for this action. |
| `ALREADY_ENTITLED` | 409 | rpc | Member already holds an outstanding seat in that cohort. |
| `RUN_LIMIT_EXCEEDED` | 409 | rpc | Outstanding seats would exceed 24. |
| `SEGMENT_MISMATCH` | 409 | rpc | Grant would mix segments in one outstanding run (B8). |
| `INVALID_MEMBERSHIP_TRANSITION` | 409 | rpc | State does not allow this transition. |
| `IMMUTABLE_ENTITLEMENT` | 409 | trigger | Attempt to rewrite a frozen ledger column. |
| `FORBIDDEN` | 403 | rpc | Admin-only RPC called by a non-admin. |
| `REQUEST_NOT_FOUND` | 404 | rpc | `enrollment_requests` row does not exist. |
| `COURSE_ACCESS_DENIED` | 403 | diagnostic | RLS hid the course (plan scope / unpublished / not found). |
| `LESSON_NOT_RELEASED` | 403 | diagnostic | Cohort drip has not unlocked this lesson yet (#37). |
| `COMMUNITY_ACCESS_DENIED` | 403 | diagnostic | RLS refused the community write. |
| `COMMENT_PERMISSION_DENIED` | 403 | diagnostic | Replies are off in this space (D2: always in General). |
| `ASSIGNMENT_CLOSED` | 409 | rpc | Past `due_at`, or assignment unpublished (#38). |
| `SUBMISSION_LOCKED` | 409 | rpc | Submission is `submitted`/`graded`; edits refused (#38). |
| `MIGRATION_MISSING` | — | client | Synthesised from `PGRST202` (RPC not in schema cache). |

`public.app_error_catalog()` returns this table from the database (stable, parallel safe, granted to `authenticated`) so the client can render safe fallback copy for a code it does not know yet, and so CI can diff it against the JS mirror.

### 3.3 Client mapping helper

**File:** `src/lib/appErrors.js` (new, pure ESM, zero dependencies, `node --test` covered).
**Exports:** `APP_ERROR_CODES` (array) · `appErrorCode(error) → code|null` · `appErrorContext(error) → object` · `appErrorMessage(error, fallback) → string` · `isMigrationMissing(error) → boolean`.

Resolution order inside `appErrorCode`: `error.hint` (validated against `/^[A-Z][A-Z0-9_]{2,39}$/` **and** membership in `APP_ERROR_CODES`) → `JSON.parse(error.details).code` → `error.code === 'PGRST202'` ⇒ `'MIGRATION_MISSING'` → an ordered `LEGACY_PATTERNS` regex table over `error.message` (for the pre-#35 free-text raises in `approve_subscription`/`approve_extension` and anything #32-era not rewritten) → `null`.

**Wiring:**
- `AdminEnrollments.doApprove` (`:7670`): replace the `PGRST202`-only branch with `setErr(appErrorMessage(rpc.error))`, plus a `BATCH_FULL` / `BATCH_REQUIRED` branch that re-opens the batch picker with `appErrorContext(err).batch_code` preselected.
- `AdminBatches` (`:7047`): same helper for `admin_assign_batch` / `admin_reconcile_queued_entitlements`.
- `CommunityHub` composer: `rpc('community_write_denial', {p_space_id, p_kind})` on space change → disable + honest copy, instead of surfacing 42501.
- `CourseProgram` deep-link guard (`:10994`): `course_access_denial` → distinguishes "not in your plan" from "not released yet" (`LESSON_NOT_RELEASED`) from "not found".
- `AssignmentSubmissionForm` (#38): `ASSIGNMENT_CLOSED` / `SUBMISSION_LOCKED`.

---

## 4. FRONTEND PLAN

### 4.0 Architectural stance

**No components are extracted.** CLAUDE.md's single-file rule stands ("Keep the single-file architecture unless a refactor is explicitly requested") and neither D1–D6 nor any design requests a refactor. What *is* extracted is **pure logic to `src/lib/*.js`** — the established, sanctioned exception, and the only thing `npm test` can reach.

Cost, stated honestly: `src/BookkeeperPro.jsx` goes **~26,730 → ~31,000 lines**. I am **not** proposing an extraction as part of this work; §9 Q9 asks the owner whether a later `src/components/community/` + `src/components/cohort/` split should be scheduled as its own phase.

### 4.1 New pure libs under `src/lib/`

| File | Exports | Mirrors |
|---|---|---|
| `src/lib/appErrors.js` | `APP_ERROR_CODES`, `appErrorCode`, `appErrorContext`, `appErrorMessage`, `isMigrationMissing` | `app_error_catalog()` |
| `src/lib/batchEntitlements.js` | `planBatchCount(accessDays, override)`, `runLengthForExtension(days)`, `seatStatusOf(row, now)`, `groupRunsByRunId(rows)`, `describeSeat(row, batchesById)`, `MAX_OUTSTANDING_SEATS` | `plan_batch_count()`, `grant_batch_run()`'s extension arithmetic, the L1 seat predicate |
| `src/lib/communityCapabilities.js` | `PLAN_CAPABILITY_FALLBACK`, `capabilitiesFor(planRow, spaceRow, isAdmin)`, `effectiveCaps(spaceRow)`, `denialCopy(denialJson)` | `user_community_capabilities()`, `community_write_denial()` |
| `src/lib/lmsSchedule.js` | `effectiveReleaseAt({releaseAt, offsetDays, startsOn})`, `isReleased(rel, now)`, `nextReleaseAfter(list, now)`, `sessionState(session, now)`, `submissionEditable(sub, assignment, now)` | `my_locked_lesson_ids()`, `batch_sessions.status`, #38's submission freeze |

Additions to the existing `src/lib/communitySpaces.js`: **none required** (the calendar helpers the entitlements design wanted are deleted by M2). Its existing `approvalBatchPreselect()` gains one case — `upgrade` across segments now always requires an explicit pick (the RPC will `replace`, so inheriting the old batch is misleading) — pinned by new cases in `test/communitySpaces.test.mjs`.

`src/lib/studentImport.js` gains `importGrantPlan({segment, batchId, planKey, accessDays, override})` → `{ needsEntitlementRun, runLength, blockedReason }`, so the import endpoint's new `grant_batch_run` call is decided by tested pure logic (A5/B4).

### 4.2 `src/BookkeeperPro.jsx` — component by component

**`CommunityHub` (`:14658`) — the `spacesReady` state machine is PRESERVED EXACTLY.**

States stay `null | true | 'legacy' | 'error'`. No new state, no new failure mode. The capability load folds into the **existing** `rpc('my_community_spaces')` call, because #36 adds `can_post/can_comment/can_react/can_attach` to that RPC's return type — so there is no second round trip, no second thing to fail, and no second thing to sequence.

Preserved verbatim:
- `spacesReadyRef` + `setSpacesReady` (`:14698–14702`) — the ref/state pair the realtime and feed effects read.
- The legacy determination is still made by **probing `community_spaces` for a missing-table code** (`:15463–15478`), never by the RPC error alone. This is load-bearing: with `spaceId` null the composer omits `space_id`, `community_posts_guard()` defaults it to General, and a false "pre-#32" verdict would publish a private cohort post to every plan.
- `'error'` still blocks the feed load, the realtime subscription, the detail fetch and every write (`:14890`, `:15336`, `:15508`).

Changed, minimally:

```js
// :15559-15564  — B11 fix: fail CLOSED on an unresolved space, except in genuine legacy mode.
const spacesFailed = spacesReady === 'error';
const legacyMode   = spacesReady === 'legacy';           // pre-#32 DB: no spaces exist at all
const currentSpace = spaceId ? (spaces.find(s => s.id === spaceId) || null) : null;
// #36 returns can_*; a #35-only DB returns only the raw flags → derive (forward/backward compatible).
const caps = effectiveCaps(currentSpace);                 // src/lib/communityCapabilities.js
const canPost    = !spacesFailed && (isAdmin || (legacyMode ? true : (currentSpace ? caps.canPost    : false)));
const canComment = !spacesFailed && (isAdmin || (legacyMode ? true : (currentSpace ? caps.canComment : false)));
const canReact   = !spacesFailed && (isAdmin || (legacyMode ? true : (currentSpace ? caps.canReact   : false)));
const canAttach  = !spacesFailed && (isAdmin || (legacyMode ? true : (currentSpace ? caps.canAttach  : false)));
```

New UI:
- **Announcement-only empty state** beside the existing reactions-only one (`:15609`): "This is an announcements space — only Alex posts here. React to let him know what landed." Rendered when `currentSpace.kind === 'general' && !canPost`.
- **Denial copy on refusal**: on a write error, `rpc('community_write_denial', {p_space_id, p_kind})` → `denialCopy()` → an `AdminNotice`-style banner. Never a raw 42501 toast.
- **Space switcher**: with 6 cohorts a Gold member has ~7 pills. Render **General + the current cohort** inline; older cohorts collapse behind a "Past cohorts (5)" disclosure (B12).
- `MentionTextarea` (`:13412`) always passes `spaceId`; when `!canComment && !canPost` the mention affordance is not mounted at all (matches the RPC's new gate).
- `CommunityComposer` (`:13854`) attachment input gated on `canAttach`.

Zero props are added to `CommunityHub` — it stays self-contained via `useAuth`, so the memoized `TabPanel` keep-alive is untouched.

**`AdminBatches` (`:7047`)**
- Queue source: replace the `subscriptions … limit(400)` + client-side premium filter (which hides the queue once 400 general rows exist) with `rpc('admin_batches_needing_assignment', {p_limit, p_offset})` — server-side premium filter + real paging.
- Per-batch card gains **`gold_active / vip_active / total_active`** (from L1 via `batch_seat_holders`) and **`gold_queued / vip_queued`** (committed demand: sold seats waiting for a cohort). Alex sees committed demand *before* setting a capacity — the mitigation for "queued seats cannot be capacity-checked".
- New **"Allocate queued seats"** button → `admin_reconcile_queued_entitlements()`, with the returned allocation count.
- Batch roster drawer: `batch_seat_holders` → `AdminUserCell` list, paged 50.

**`AdminEnrollments` (`:7670`)**
- `doApprove` result now carries `run_id`, `allocated` (array of `{batch_id, code}`) and `queued` (int). The approve receipt shows: *"Approved — Gold, 6 cohort seats: Aug, Sep, Oct 2026 allocated · 3 queued for future cohorts."*
- Error path via `appErrorMessage` (§3.3).
- **Pagination**: the merged request list currently renders every row. Add `.range()` 50/page + a "Load more" (B12).
- The `subscriptions .in().limit(1000)` lookup sits **exactly at** `max_rows=1000`; chunk the `.in()` to 200 ids per call.

**`EnrollmentPaywall` (`:2763`)** — Gold/VIP cards show "**6 monthly cohorts included**" from `planBatchCount()`; the batch picker labels the choice "starting cohort" and adds "later cohorts are assigned automatically as each one opens" (honest under registry allocation).

**`MembershipPanel` (`:9704`) + `ProfileSettingsBody` (`:3784`)** — the single `BatchFactRow` becomes **`EntitlementRunPanel`** (new, module scope): the member's run as a row of chips — allocated cohorts with dates, queued seats as "assigned when the next cohort opens", plus `valid_until`. Reads `batch_entitlements` under its own RLS (own rows) — no new RPC.

**`CourseCatalog` (`:12176`) / `CourseProgram` (`:10994`)**
- `COURSE_ROW_SELECT` (`:10518`) gains `is_cohort_only`; catalogs filter it out (cohort courses live in `CohortHub`).
- `CourseProgram` lesson list marks drip-locked lessons with a lock chip + "Unlocks {date}" from `lmsSchedule.js`; the deep-link guard distinguishes `LESSON_NOT_RELEASED` from `COURSE_ACCESS_DENIED`.
- `SignedLessonVideo`: add the missing re-sign timer (existing `createSignedUrl(3600)` with no refresh — a long lesson outlives its URL). Refresh at 50 minutes.

**`CohortHub` — NEW tab (`cohort`, route `/cohort`)** `[UNREVIEWED]`
Self-contained (zero props, `useAuth`) so `TabPanel` memoization is untouched. Sections: cohort switcher (from L1) · next live session (`BatchSessionCard`) · announcements (`BatchAnnouncementList`) · curriculum (published courses with drip state) · assignments (`AssignmentPanel` → `AssignmentSubmissionForm`).
**Nav sync points (all four, per CLAUDE.md):** `DEFAULT_STAGES` (Stage 3, its own group) · `renderToolContent` switch · `TAB_ROUTES['cohort'] = '/cohort'` · Dashboard tile. Plus `VOICE_TAB_INFO['cohort']` and `npm run ai:knowledge` (see §8).
**Entitlement gating:** `cohort` is **not** added to `TRAINING_ONLY_TAB_IDS` or the sampler allowlist, so `planEntitlement()`'s FULL fallthrough gives it to gold/vip/silver/unknown, and `RestrictedTab` catches core/sampler at the `visitedTabs.map` chokepoint. Additionally `CohortHub` renders a "no cohorts yet" state when L1 is empty — so a silver member (FULL, but general segment) sees an honest empty screen, not an error.

**New admin components:** `AdminBatchCurriculum` (publish/unpublish courses to a batch, drag order, per-lesson drip editor), `AdminSessionEditor`, `AdminAnnouncementComposer`, `AdminAssignmentGrader` (roster + grade + feedback). All built from the existing shared kit — `AccountModal`, `SidePanel`, `AdminNotice`, `AdminFilterChip`, `AdminListSkeleton`, `AdminUserCell`, `ADMIN_BTN_OK`/`ADMIN_BTN_DANGER`. **No hand-rolled `fixed inset-0` modals** (the `.gh-app-bg > *` stacking trap).

### 4.3 The TabPanel keep-alive contract — how it is preserved

The contract: `TabPanel` is `React.memo`'d and every prop must be referentially stable, or hidden panels stop skipping root re-renders.

1. **No new props on `TabPanel`.** `CohortHub` and `CommunityHub` both take zero props.
2. **No new context above the shell whose value changes.** Capability data is *not* put in a provider. Each self-contained component calls `rpc('my_community_spaces')` / `rpc('my_cohort_overview')` itself, backed by a **module-scope 60-second memo promise** (`let __capsCache = {at:0, p:null}`) — the `window.__voiceCfgPromise` precedent. `EntitlementContext` (`:2545`) keeps its existing memoized value and gains **no** new fields.
3. **Cross-component navigation stays module-scope**: `writeAppRoute('cohort', {batch})` and `setPanelParam(...)` — the established no-prop-threading idiom. Deep links `?batch=<code>` and `?assignment=<id>` are read in `readAppRoute()` and re-synced on `popstate` + `bookkeeper:route-change`, exactly like `?course=`/`?lesson=`/`?space=`.
4. `visitedTabs` is still never pruned; `CohortHub` state survives tab switches like every other tool.
5. Any modal `CohortHub` opens uses `AccountModal`/`SidePanel`, which portal to `document.body` and self-suppress under a `[hidden]` ancestor — so a modal left open in a hidden keep-alive panel stays hidden with its tab.

### 4.4 Server-side app code

**`api/admin/student-imports.js` (`~:551–559`) — MANDATORY, ships with #35.** Today it inserts the `subscriptions` row directly with `batch_id` and never calls any RPC (A5/B4). After the insert it must call, under the service role:

```js
if (row.proposed_batch_id && isPremiumSegment(segment)) {
  const { error } = await admin.rpc('grant_batch_run_for_import', {
    p_user_id: userId, p_segment: segment, p_batch_id: row.proposed_batch_id,
    p_count: runLength, p_source_subscription_id: subId, p_source_plan_key: planKey,
    p_source_import_row_id: row.id, p_valid_until: term.grace_ends_at || term.ends_at,
    p_actor: actorId, p_enforce_capacity: false,     // documented: imports are capacity-exempt (#32 precedent)
  });
}
```
`grant_batch_run_for_import` is a thin service-role-only wrapper (revoked from `anon`/`authenticated`) whose only job is to be callable without an `is_admin()` JWT context — the endpoint has already verified the caller independently. `source_import_row_id`'s partial unique index is the idempotency anchor, matching the existing subscription-grant idempotency. Run lengths come from `importGrantPlan()` in `src/lib/studentImport.js` (tested).

**`api/elevenlabs/trainer.js`** — no change required, but its `trainer_visible_courses` mirror must be re-verified after #37 touches `lessons_read` (§8 lockstep).

---

## 5. TEST PLAN

### 5.1 Harness choice and its Windows cost

Both entitlements reviewers independently named the same thing as the largest risk: *"No DB/RLS integration harness exists — all 106 tests are pure functions over synthetic fixtures. Every claim about what `user_community_space_ids()` returns … is verified by reading."* This plan adds one.

**Chosen: local Supabase stack (`supabase start`) + `node --test` driving `pg` directly.**

Rejected alternatives:
- **pgTAP** — a second assertion language whose output does not integrate with `npm test`, and awkward for the thing we most need (running statements *as different JWT roles*).
- **Testcontainers** — an extra dependency for the same Docker requirement, and it would not give us Supabase's `auth` schema, `storage.objects`, or the `authenticated`/`anon` roles that every policy references.
- **Status quo (pure mirrors only)** — leaves every RLS claim unverified. Rejected outright.

**Windows 11 Pro setup cost, concretely:**

| Step | One-time cost | Notes |
|---|---|---|
| Docker Desktop + WSL2 backend | **30–45 min** incl. one reboot | Skip if already installed. Needs virtualization enabled in BIOS. |
| `supabase start` first run | **10–20 min**, ~2.5 GB image pull | CLI is already installed and linked to `ifxcobxsjdjzlozagmls` (auth via `SUPABASE_ACCESS_TOKEN` in `.env`). Ports 54321/54322/54323 must be free. |
| `npm i -D pg` | seconds | **New devDependency — needs owner sign-off** (CLAUDE.md: "Don't add … without asking"). devDependency only; nothing enters the browser bundle. |
| Per-run schema apply | **20–40 s** | `supabase/` has **no** `migrations/` dir and no seed — so `scripts/apply-db-files.mjs` applies `db/000_full_database_bootstrap.sql` then each dated file after the bootstrap's fold point, in `db/README.md` order. |
| Per-test-file run | 2–6 s | Serialized (`--test-concurrency=1`): all files share one database. |

**`npm test` stays exactly as it is** — pure, fast, Docker-free, green on any machine. DB tests are opt-in.

### 5.2 File layout and npm scripts

DB tests live in **`test-db/`** with a **`.dbtest.mjs`** suffix, deliberately outside Node's default discovery (which matches `*.test.*` and files under a directory literally named `test`), so `npm test` cannot pick them up:

```json
"scripts": {
  "test":        "node --test",
  "test:db":     "node --test-concurrency=1 --test test-db/",
  "test:all":    "npm test && npm run test:db",
  "db:local:up":    "supabase start",
  "db:local:reset": "supabase db reset --local && node scripts/apply-db-files.mjs",
  "db:local:down":  "supabase stop"
}
```

### 5.3 New test files

**Pure (run under `npm test`, no Docker):**

| File | Covers |
|---|---|
| `test/appErrors.test.mjs` | hint path · details-JSON path · legacy-message regex table (ordered, first match wins) · `PGRST202` → `MIGRATION_MISSING` · unknown code → `error.message` fallback · every code in `APP_ERROR_CODES` has copy · no `undefined` in any interpolated message when context keys are missing |
| `test/batchEntitlements.test.mjs` | `planBatchCount` truth table (180→6, 60→2, override wins, null access_days → null, floor 1, ceiling 24) · `runLengthForExtension` (60→2, 90→3, 365→12, clamped) · `seatStatusOf` across allocated/queued/expired/revoked/not-yet-active · `groupRunsByRunId` ordering |
| `test/communityCapabilities.test.mjs` | the 5 live plans × 3 space kinds × 4 actions = **60-cell truth table**, asserted against the #36 seed · admin override · unknown plan → fail closed · `effectiveCaps` derives correctly from raw flags on a #35-only DB · `denialCopy` for every `community_write_denial` reason |
| `test/lmsSchedule.test.mjs` | absolute vs offset release · both-null ⇒ released · offset from `pub.starts_on` overriding `batches.starts_on` · null `starts_on` ⇒ locked (fail closed) · `sessionState` boundaries · `submissionEditable` across draft/submitted/returned/graded × before/after `due_at` |
| `test/communitySpaces.test.mjs` (extend) | `approvalBatchPreselect` cross-segment upgrade now requires an explicit pick |
| `test/studentImport.test.mjs` (extend) | `importGrantPlan` — premium+batch ⇒ run, general ⇒ none, missing expiry ⇒ blocked |

**DB / RLS (run under `npm run test:db`):**

| File | Covers |
|---|---|
| `test-db/_harness.mjs` | `withRole(uid, fn)` (sets `role authenticated` + `request.jwt.claims`), `asAdmin`, `asAnon`, `expectDenied(fn, sqlstate)`, `expectAppError(fn, code)`, `seedMember({plan, batch, status})`, `truncateAll()` |
| `test-db/entitlements.dbtest.mjs` | the L1 truth table (§5.4) |
| `test-db/communityRls.dbtest.mjs` | D2 matrix + the UPDATE split + attachments + mention directory |
| `test-db/lmsRls.dbtest.mjs` | drip, publications, announcements, sessions, assignments, submissions |
| `test-db/concurrency.dbtest.mjs` | §5.5 |
| `test-db/migrationIdempotency.dbtest.mjs` | each of #35–#39 applied **twice** in a row leaves an identical `pg_policies` + `pg_proc` + `information_schema.columns` snapshot; and applying #35 to a #33-only DB **raises** |
| `test-db/grants.dbtest.mjs` | the privilege assertions from each file's verification block, as tests: no `authenticated` DML on `batch_entitlements`, no `authenticated` EXECUTE on any parameterized `user_*`/`grant_batch_run`/`revoke_batch_run`, no `anon` EXECUTE anywhere new |

### 5.4 Adversarial matrix — every critical/high finding gets a named test

| # | Finding | Severity | Disposition | Test |
|---|---|---|---|---|
| A1 / B3 | Stamped segment never reconciled; downgraded member keeps Gold space | critical | **incorporated** — live-segment conjunct in L1 + revoke on segment change | `entitlements: downgrade_revokes_premium_space_immediately` |
| A2 | Legacy bridge un-revokes; `admin_revoke_batch_entitlement` is a no-op | critical | **incorporated** — bridge scoped to zero-ledger users; revoke nulls the cache; `admin_revoke_batch_run` wrapper | `entitlements: revoke_removes_space_even_with_stale_batch_id` |
| B1 | Extension run length from `access_days`; `valid_until` advance unreachable | critical | **incorporated** — explicit `p_count` from `extension_days`; explicit forward UPDATE | `entitlements: extension_60d_grants_2_seats_and_extends_existing` |
| B2 / A8 | `max(batch_code)` stacking ignores validity → lapsed renewal gets nothing; silent relocation | critical | **incorporated** — dissolved by registry allocation (M2) | `entitlements: lapsed_renewal_allocates_from_picked_batch` |
| B4 / A5 | Imports + `admin_assign_batch` bypass the ledger; capacity double-vision | critical | **incorporated** — both routed through `grant_batch_run`; ONE seat predicate | `entitlements: import_grant_consumes_a_seat`, `entitlements: assign_batch_moves_not_adds` |
| A3 | D2 enforced only on INSERT; own-UPDATE has no capability check | high | **incorporated** — withdraw/keep-published split | `communityRls: general_post_edit_denied_delete_allowed` |
| A4 | `user_entitled_batch_ids` ungated; `user_is_enrolled` created-not-called | high | **incorporated** + **M1** (reuse #27's, never redefine) | `entitlements: banned_member_gets_no_batches`, `grants: user_is_enrolled_body_matches_27` |
| B5 | Frozen-column guard fires on FK referential actions → undeletable rows | high | **incorporated** — non-null→NULL exemption for the 5 provenance FKs | `entitlements: deleting_source_request_does_not_abort` |
| B6 | Lock-order inversion + unlocked batch-id capture | high | **incorporated** — one ordered `FOR UPDATE` by `code`, lock+read in one statement, `admin_finalize_enrollment` no longer locks separately | `concurrency: overlapping_runs_no_deadlock` |
| B7 / M2 | Calendar months vs real cadence → permanently queued seat | high | **incorporated** — registry allocation + FIFO binder + admin queue visibility | `entitlements: skipped_month_seat_allocates_to_next_authored_batch` |
| B8 | `ON CONFLICT DO NOTHING` silently drops a mis-routed segment change | high | **incorporated** — segment decides replace-vs-stack inside `grant_batch_run`; `SEGMENT_MISMATCH` raise | `entitlements: gold_to_vip_upgrade_supersedes_and_grants` |
| A6 | `next_batch_code` unbounded `p_months` DoS | medium | **incorporated** — function deleted by M2; no `generate_series` reaches the API | `grants: no_batch_run_codes_function_exists` |
| A7 | No temporal gating; future cohorts readable; 12 concurrent seats | medium | **partially incorporated** — `activates_at` stamped from `batches.starts_on` (default ON); seat inflation dissolved by registry allocation. **Open: owner Q2** | `entitlements: future_cohort_hidden_until_starts_on` |
| A9 | `authenticated` retains table DML on the ledger | medium | **incorporated** — explicit role revoke + hardened INSERT guard | `grants: authenticated_cannot_write_batch_entitlements` |
| A10 | community-media legacy `<uid>/…` INSERT ⇒ unbounded orphan uploads | medium | **incorporated** — INSERT narrowed to a postable space; READ/DELETE keep legacy; orphan sweep RPC | `communityRls: core_member_cannot_upload_to_community_media` |
| A11 | `search_community_members` enumerates the roster | low | **incorporated** — space required, create-rights gate, general refused, min length 2 | `communityRls: mention_search_denied_for_general_segment` |
| B9 | Lockstep broken: `my_community_spaces`/`admin_batch_overview`/queue/panels/JS mirrors | medium | **incorporated** — all rewritten over L1 in #35/#36 | `entitlements: overview_counts_match_seat_predicate` |
| B10 | Drift view fans out on `batch_index=0` | medium | **incorporated** — join on `source_subscription_id`, `distinct on (s.id)`, validity filter | `entitlements: drift_view_reads_zero_after_backfill` |
| B11 | Client `canPost` defaults open; no announcement-only affordance | medium | **incorporated** — fail-closed defaults + banner + `community_write_denial` | `test/communityCapabilities.test.mjs` (`effectiveCaps` null-space ⇒ closed) |
| B12 | Scale: 7 spaces/member, O(all subscriptions) counts, unpaginated, realtime noise | medium | **incorporated** — §6 | `test-db` row-count assertions + `explain` baselines |

**Nothing is rejected.** Two are only *partially* closed and are escalated to owner questions rather than silently dropped: **A7** (whether cohorts should reveal month-by-month — Q2) and the accepted residual on the `PT###` convention (§3.1), which is mitigated by branching on `hint` and verified by one post-deploy round trip.

### 5.5 Concurrency tests (`test-db/concurrency.dbtest.mjs`)

Each uses two independent `pg` clients with explicit `BEGIN`, interleaved by an await barrier.

1. **`one_seat_two_approvals`** — batch with `gold_capacity = 1`; two admins call `admin_finalize_enrollment` for two different pending requests simultaneously. Assert: exactly one commits, the other raises `hint='BATCH_FULL'`, and `batch_seat_holders` returns exactly 1.
2. **`overlapping_runs_no_deadlock`** — member X's run needs batches {Aug, Sep, Oct}, member Y's needs {Oct, Nov, Aug} (chosen so `code` order and `id` order disagree). Interleave. Assert: both commit, **zero** `40P01`. This is the B6 regression test — it fails against the design's `order by b.id`.
3. **`allocate_races_grant`** — one connection inserts a new `batches` row (firing `zz_batches_allocate_queued`) while another calls `grant_batch_run` for the same segment. Assert: no seat is double-allocated; `unique (user_id, batch_id) where status='active'` holds.
4. **`total_capacity_vs_segment_capacity`** — `total_capacity=2`, `gold_capacity=2`, `vip_capacity=2`; three concurrent grants (2 gold, 1 vip). Assert: exactly 2 commit, the third gets `BATCH_FULL` with `context.scope='total'`. (Also the fixture for owner question Q6.)
5. **`idempotent_double_approve`** — the same `p_request_id` approved twice concurrently. Assert: one `{ok:true}`, one `{ok:true, already:true}`, exactly `run_length` ledger rows.
6. **`revoke_races_read`** — `admin_revoke_batch_run` commits while a member's `my_community_space_ids()` is in flight. Assert: after commit, the next call excludes the space (no cached scope).

### 5.6 Review gate for `[UNREVIEWED]` work

#37 and #38 (the whole LMS) and `CohortHub` never faced an adversarial reviewer. Before either is applied to prod:

- run `/security-review` on the branch diff;
- run a dedicated adversarial pass with the same two lenses used on entitlements (security; correctness/migration/scale), specifically probing: can a cohort publication widen `courses_read`? can a member read a drip-locked lesson's *video* through the storage bucket? can a member submit to another cohort's assignment? does the `lessons_read` rewrite preserve all five pre-existing clauses?
- `test-db/lmsRls.dbtest.mjs` must be green, including negative cases for each of the above.

---

## 6. PERFORMANCE PLAN

### 6.1 New indexes, each with the query shape it serves

| Index | Serves |
|---|---|
| `batch_entitlements (user_id) include (batch_id, segment, valid_until, activates_at) where status='active' and batch_id is not null` | **THE RLS hot path.** `user_entitled_batches` / `user_community_space_ids` run once per statement (InitPlan) on every community read *and* write, and on every LMS read. Index-only, ~6 rows/user. |
| `batch_entitlements (batch_id, segment) include (user_id, valid_until) where status='active'` | `batch_seat_holders()` — the capacity count inside `grant_batch_run` (once per candidate, under the lock) and every `admin_batch_overview` count. |
| `batch_entitlements (segment, granted_at, batch_index) where status='queued'` | The FIFO binder (`zz_batches_allocate_queued`) and `admin_reconcile_queued_entitlements()`. |
| `batch_entitlements (user_id, granted_at desc)` | Member "Batches included" panel + admin drill-down; also the FK-covering index for `user_id → profiles` `ON DELETE CASCADE`. |
| `batch_entitlements (batch_id)` | FK-covering for `batch_id → batches` `ON DELETE RESTRICT` (every batch delete scans this) + the batch roster query. |
| `batch_entitlements (source_subscription_id)` | FK cover + the drift view's join + "what did this term grant?". |
| `batch_entitlements (source_request_id)` | FK cover + the approve receipt. |
| `unique (user_id, batch_id) where status='active'` | Correctness: a member can never hold two seats in one cohort. Also the concurrency invariant test 3 asserts. |
| `unique (user_id, source_request_id, batch_index) where status in ('queued','active')` | Exact idempotency per approval — the `ON CONFLICT` inference target. |
| `batch_course_publications (batch_id, position)` / `(course_id)` | `my_cohort_overview()` curriculum list; FK cover. |
| `batch_lesson_releases (batch_id) include (lesson_id, release_at, release_offset_days)` | `my_locked_lesson_ids()` — one InitPlan per statement on `lessons_read`. |
| `batch_announcements (batch_id, published_at desc) where status='active'` | Cohort announcement feed. |
| `batch_sessions (batch_id, starts_at)` | "Next live session". |
| `assignments (batch_id, position) where published` / `(course_id) where published` | Assignment lists. |
| `assignment_submissions (assignment_id, status)` / `(user_id, updated_at desc)` | Grader roster; member's own list. |
| **Backfill of existing gaps** (from the advisor's 9 unindexed FKs, the ones this work touches): `enrollment_requests(plan_key)`, `enrollment_requests(reviewed_by)`, `subscriptions(approved_by)`, `subscriptions(plan_key)` | `admin_finalize_enrollment` now joins these more often; `subscriptions(plan_key)` is also scanned by every `batch_seat_holders` call while the legacy bridge lives. |

**Deliberately not indexed:** `granted_by`, `revoked_by`. Their only query shape is "delete an admin profile", which never happens — consistent with the 9 unindexed FKs the project already accepts. Documented, not forgotten.

### 6.2 Fixes for the existing unbounded-query and pagination problems

`supabase/config.toml` sets **`max_rows = 1000`**, so any unbounded PostgREST select silently truncates.

| Site | Problem | Fix |
|---|---|---|
| `CommunityHub` comments | hard `.limit(500)`, **no pagination** — thread 501+ silently loses replies | keyset pagination on `(created_at, id)`, 50/page + "Load more" |
| `CommunityHub` reactions / post_tags / attachments / announcement_reads | `.in(postIds)` with **no limit** → silent truncation at 1000 | chunk `postIds` to ≤50 per call **and** add an explicit `.limit(1000)`; assert `data.length < limit` in dev or log a `[community] meta truncated` warning |
| `AdminEnrollments` request list | renders **every** merged row, no paging | `.range()` 50/page + "Load more" |
| `AdminEnrollments` subscriptions lookup | `.in().limit(1000)` sitting **exactly at** `max_rows` | chunk `.in()` to 200 ids |
| `AdminBatches` needs-batch queue | `.limit(400)` then filtered to premium **client-side** → >400 general rows hides the queue entirely | `rpc('admin_batches_needing_assignment', {p_limit, p_offset})` — premium filter server-side, real paging |
| `my_community_spaces()` | `eligible` CTE is a `DISTINCT ON` over the **whole** `subscriptions` table + a correlated count per space, run on every community load; returns ~7 rows/member post-#35 instead of 2 | `member_count` from `batch_seat_holders(batch_id, kind)` (indexed) for premium spaces, and a single cached aggregate for General; the `eligible` CTE is deleted |
| `search_community_members` | empty query matched every profile (#33 partly fixed) | min query length 2 + space required + create-rights gate (#36) |
| `batch_entitlements` realtime | the design published the table with **no named consumer**; every grant fans out an RLS-evaluated message (the read policy calls `is_admin()`) to all subscribers | **Not published in #35.** Add it only when `EntitlementRunPanel` actually subscribes, and then with a `user_id=eq.<uid>` filter |
| any new admin list over `batch_entitlements` | would truncate at 1000 (500 members × 6 = 3000/cohort-year) | every admin entitlement query gets an explicit `.range()` below 1000 with paging |

### 6.3 How each is measured

1. **`explain (analyze, buffers)` baselines** checked into `docs/db/perf-baselines.md`, captured on the local stack seeded to D5 scale (`scripts/seed-scale.mjs`: 600 profiles, 600 subscriptions, 36 batches, 3600 entitlements, 5000 posts, 20000 comments). Required rows: `community_posts` feed page; `community_posts` insert; `user_community_space_ids` standalone; `my_community_spaces`; `lessons_read` select; `my_locked_lesson_ids`; `batch_seat_holders`. **Acceptance: no plan may show a `Seq Scan` on `batch_entitlements`, `subscriptions`, or `community_posts`, and the L1 InitPlan must appear exactly once per statement** (grep the plan text for the function name — more than one occurrence means a correlated call slipped in).
2. **Row-count assertions as tests** — `test-db/perf.dbtest.mjs` asserts each fixed query returns the full expected set at scale (e.g. a 1200-comment thread paginates to 1200 total, not 500).
3. **Supabase advisor re-run** after each migration lands in prod: security findings must not increase from the current 28 WARN / 0 ERROR; `unused_index` growth is expected and accepted (tiny DB); any **new** `multiple_permissive_policies` finding is a review failure (the single-policy design on `batch_entitlements` exists to avoid one).
4. **A production canary** — after #36, log `[community] meta truncated` occurrences for one week; zero occurrences confirms the chunking.

---

## 7. DESTRUCTIVE-CHANGE LEDGER

**No table is dropped. No column is dropped. No column is renamed. No data is deleted.** Everything below is a replacement, a data update, or a deprecation.

| # | Change | Kind | Impact | Rollback |
|---|---|---|---|---|
| 1 | **`community_spaces` General: `member_posting true→false`, `member_comments true→false`** | **DATA — the one user-visible destructive change** | Every current member loses all community write ability (§2b). Reads and reactions preserved; the 3 existing General posts stay readable and author-withdrawable. | `update community_spaces set member_posting=true, member_comments=true where kind='general'` — but first `alter table … drop constraint community_spaces_general_announcement_only`, and record the reversal in `db/README.md` |
| 2 | `drop function public.my_community_spaces()` then re-create (return type gains `can_*`) | replace | ~1 s window where a concurrent old-client call 404s; handled by the client's `spacesReady='error'` retry card. **Grants must be re-applied** after the drop. | Re-create #32's version from `db/2026-07-28-…sql` §14 verbatim + re-grant |
| 3 | `drop function public.admin_batch_overview()` then re-create (return type gains queued counts) | replace | Admin → Batches only. **Re-grant required.** | Re-create #32 §19 verbatim + re-grant |
| 4 | `create or replace user_community_space_ids(uuid)` | replace | The core access predicate. Behaviour widens (N cohorts) and tightens (live-segment reconciliation). | `create or replace` from #32 §8 verbatim |
| 5 | `create or replace admin_finalize_enrollment(uuid, uuid)` | replace | Signature and grants unchanged, so the deployed client keeps working with no redeploy. **Base text is #34's** — the #33→#34 incident must not repeat; diff before applying. | `create or replace` from #34 §1 verbatim |
| 6 | `create or replace admin_assign_batch(uuid[], uuid)` | replace | Signature and skip-reason vocabulary preserved; two new reasons (`no_run_length`, `run_conflict`). | from #32 §18 verbatim |
| 7 | `create or replace search_community_members(text, uuid)` | replace | Signature unchanged. Behaviour tightens: general-segment members now get zero rows. Client must always pass `p_space_id`. | from #33 verbatim |
| 8 | Replace 6 community policies (`posts`/`comments`/`reactions` × insert/update) | replace | The D2 chokepoint. | `drop policy` + re-create from #32 §15 / #28 verbatim |
| 9 | `create or replace lessons_read` + `course_object_allowed(text)` (#37) | replace | **Highest-risk statement in the plan** — on the hot content path, rewritten by 5 prior migrations. Must be #19+#29 text verbatim plus one conjunct. | from #19/#29 verbatim; verification asserts all five pre-existing clauses survive |
| 10 | Narrow `community_media_own_insert` (#36) | replace | Members who can no longer post can no longer upload. Existing objects unaffected (READ/DELETE branches preserved). | from #33 §6 verbatim |
| 11 | `batch_events_action_check` dropped and re-added with a wider vocabulary | replace (widening) | None — strictly more permissive. | re-add #32's narrower CHECK |
| 12 | **`subscriptions.batch_id` — READ path removed (#39)** | **deprecation, not deletion** | Column retained and still written as the start-batch cache. Only the `legacy` CTE in two functions is deleted. Gated on drift = 0 + zero unmigrated imports. | `create or replace` both functions from #35 |
| 13 | `batch_run_codes()` / `next_batch_code()` | **never created** (M2) | n/a — they exist only in the rejected design. | n/a |
| 14 | `user_is_enrolled(uuid)` / `user_is_approved(uuid)` / `user_plan_key(uuid)` | **NOT touched** (M1) | The entitlements design would have redefined #27's trainer authorization mirrors. #35 asserts their bodies instead. | n/a |

---

## 8. DOCS TO UPDATE

| File | Section | Change |
|---|---|---|
| **`CLAUDE.md`** | *Community (Supabase-backed member forum)* | Rewrite the "Spaces & batches (#32)" paragraph: access is now **ledger-backed** (`batch_entitlements`), not derived from one `subscriptions.batch_id`. Add D2: **General is announcement-only for every plan** (reactions only). Add the per-plan capability columns and `my_community_capabilities()`. Update the "two facts that surprise people" to three: capacity is enforced only on admin RPC paths *and imports now consume seats*; archiving blocks renewals; **a premium run consumes a seat in every cohort of the run, and queued seats are never retro-refused**. |
| | *Course platform* | New subsection **"Cohort delivery (LMS, #37/#38)"**: global courses + `batch_course_publications` + `batch_lesson_releases` drip + announcements + sessions + assignments; `my_locked_lesson_ids()` is the drip seam; **drip never widens `courses_read`**; `courses.is_cohort_only`. |
| | *Authentication → Plan-based access* | Add the L0/L1/L2 stack and name `batch_entitlements` as THE entitlement source. Note the new `cohort` tab is FULL-plan by fallthrough. |
| | *Architecture map* table + notable-tools anchors | New `CohortHub` (~line TBD) + `EntitlementRunPanel`, `AdminBatchCurriculum`, `AdminAssignmentGrader`; re-baseline the drifted anchors (file grows ~26.7k → ~31k). |
| | *Migration order* one-liner | append `→ #35 → #36 → #37 → #38 → #39` with each file's dependency note. |
| | *Keeping docs current* | **Lockstep sets — all of them this work touches:** ① `enrollment_plans.community_segment` seed ↔ `PLAN_SEGMENT_FALLBACK`/`planSegment()` ↔ `user_community_space_ids()` ↔ `approvalBatchPreselect()` ↔ `batchGapForProcess()` — **now also ↔ `batch_entitlements.segment` reconciliation**. ② Plan-scope rules: `courses_read` ↔ #27 `trainer_visible_courses`/`trainer_courses_for_plan` ↔ `PLAN_ENTITLEMENTS` ↔ `planScopeAllows()` — **now also ↔ `my_locked_lesson_ids()` and `course_access_denial()`**. ③ **NEW:** `enrollment_plans` capability columns ↔ `user_community_capabilities()` ↔ the 6 community policies ↔ `communityCapabilities.js` (`test/communityCapabilities.test.mjs` pins it). ④ **NEW:** `plan_batch_count()` ↔ `enrollment_plans.eligible_batch_count` ↔ `planBatchCount()` in `batchEntitlements.js`. ⑤ **NEW:** `app_error_catalog()` ↔ `APP_ERROR_CODES` in `appErrors.js`. ⑥ `COMMUNITY_REACTIONS` ↔ the SQL CHECK; `COMMUNITY_MENTION_SRC` ↔ the SQL regex (unchanged, restate). |
| | *Voice assistant* | `VOICE_TAB_INFO['cohort']` entry + aliases; **`npm run ai:knowledge` must be re-run in the same change** and `npm run ai:knowledge:check` must pass. |
| **`db/README.md`** | table + one-line order | Five new rows (#35–#39) in the established format with "Creates / changes" + "Depends on". Add the **`#34` → `#35` hard note** ("#35's base text is #34's; #35 aborts on a #33-only DB"). |
| | *How the bootstrap relates* | Add §22–§26 to the verbatim-tail list with the re-fold rule. |
| | **new: *Deprecation ledger*** | `subscriptions.batch_id` — deprecated by #35, read path removed by #39; the three gate queries; who to tell. |
| **`COMMUNITY_SETUP.md`** | new sections | D2 (what members can and cannot do in General, per plan) · the capability columns and how an admin flips them · batch runs, queued seats, capacity, the "Allocate queued seats" button · `community_write_denial()` for troubleshooting · the orphan-media sweep. |
| **`COURSE_SETUP.md`** | new section | Cohort publications, drip scheduling, `is_cohort_only`, and the rule that publications never widen plan scope. |
| **`ENROLLMENT_SETUP.md`** | *Membership lifecycle* | What Approve now grants (a term **and** N cohort seats); the approve receipt's new fields; what `BATCH_FULL` on a *future* cohort means; extension seat arithmetic. |
| **`STUDENT_IMPORT_SETUP.md`** | *Process* | Imports now write `batch_entitlements` (capacity-exempt, documented) and **must** be followed by "Allocate queued seats" for premium rows. |
| **new: `LMS_SETUP.md`** | whole file | Cohort LMS runbook: publish a course to a batch, set drip, post an announcement, schedule a session, create and grade an assignment, the `assignment-files` bucket. |
| **`.claude/skills/bookkeeper-conventions/SKILL.md`** | persistence + error handling | Add: **all Supabase RPC errors go through `appErrorMessage()`** — never render a raw Postgres string. Add the `src/lib/*.js` pure-lib rule and the module-scope memo-promise pattern for shared RPC data (never a context above `TabPanel`). |
| **`.claude/skills/add-bookkeeper-tool/SKILL.md`** | nav sync | Note the **fifth** sync point that now exists: `VOICE_TAB_INFO` + `npm run ai:knowledge`. Reference `cohort` as the current worked example. |
| **`docs/ai/toolkits-voice-agent-knowledge.md`** | regenerated | via `npm run ai:knowledge`; `ai:knowledge:check` gates the branch. |
| **new: `docs/db/perf-baselines.md`** | whole file | The `explain (analyze, buffers)` baselines from §6.3. |

---

## 9. UNRESOLVED RISKS + OWNER QUESTIONS

### 9.1 Risks that remain after every fix

1. **`[UNREVIEWED]` LMS.** #37, #38 and `CohortHub` — roughly 40% of this plan's surface — never faced an adversarial reviewer. §5.6's gate is mandatory, not advisory. `lessons_read` is the specific statement most likely to repeat the #33→#34 "reconstructed from memory" failure.
2. **The community domain's own critiques were never delivered**, and its design was truncated mid-policy-list. The reactions/attachments/tags policies in #36 are reconstructed from the entitlements reviewers' overlapping findings (A10, A11, B11) and from #32/#33/#34's text. They deserve the same §5.6 gate.
3. **The DB harness does not exist yet.** Until `test-db/` is green, every RLS claim in this document is verified by reading. Do not apply #35 to prod before `test-db/entitlements.dbtest.mjs` and `test-db/grants.dbtest.mjs` pass locally.
4. **A 6-cohort run multiplies seat consumption by 6.** With `gold_capacity = 10`, one approval consumes 10% of six different cohorts. Alex will hit `BATCH_FULL` far sooner than intuition expects, naming a cohort he has not thought about. Mitigation: capacities stay **NULL (unlimited)** until Alex has seen the six-cohort grid with committed-demand counts in Admin → Batches. This is correct-by-design but a real operational surprise.
5. **Queued seats are uncapped by construction.** Fifty Gold approvals commit fifty seats to the next cohort. When Alex creates it with `gold_capacity=10`, the FIFO binder allocates all fifty — over capacity, deliberately, because they were sold. `gold_queued`/`vip_queued` in the overview is the only warning, and there cannot be a hard stop without repudiating a paid entitlement.
6. **The legacy bridge is a second source of truth while it lives.** Its blast radius is now bounded to users with zero ledger rows, but until #39 runs, a revocation must also null `subscriptions.batch_id` — which `admin_revoke_batch_run` does, and which the runbook must state. Treat #39 as a **P1 follow-up, not a someday-nice**.
7. **`batch_entitlements` has no DELETE guard.** No policy, no RPC deletes — but a SQL-editor `delete` destroys audit history silently. Consistent with how `batch_events` / `student_import_events` are protected (policy-only); adding a `before delete` raise would block legitimate GDPR erasure. **Accepted, not solved.**
8. **`admin_assign_batch`'s per-user exception handler.** Narrowed to `sqlstate 'PT409'` / `'PT422'` per reviewer A, so a deadlock or serialization failure surfaces instead of becoming an opaque skip — but that means one full cohort can now abort a bulk assign where before it degraded. That is the correct trade and it is a behaviour change Alex will see.
9. **HaveIBeenPwned password check is still DISABLED** in Supabase Auth (advisor WARN, unrelated to this work, still open from the 2026-07-26 audit). Not in scope; keep it on the list.
10. **`expire_overdue_subscriptions()` is callable by any authenticated user** (advisor WARN). Unchanged by this work, but the ledger now depends on `subscriptions.status`, so a member spamming it is marginally more interesting. Worth revoking in a future hardening file.

### 9.2 Questions the owner must answer

| # | Question | Why it blocks | Plan's current default |
|---|---|---|---|
| **Q1** | **Does an extension buy more *cohorts*, or only more *days* on the cohorts already held?** A 60-day Gold top-up currently appends 2 more cohort seats (2 more months of Alex's live teaching). | Changes what an extension costs Alex and what `ExtendAccessModal` must say. Decide **before the first Gold extension**. | Appends `ceil(days/30)` seats, clamped 2–12. |
| **Q2** | **Does cohort N go live immediately, or when that cohort starts?** (Reviewer A7.) | Plan currently stamps `activates_at` from `batches.starts_on`, so cohorts reveal month by month. The alternative (all six visible on day one) is one line. | Reveal month by month. |
| **Q3** | **Does a member keep access to a *past* cohort's space after it ends?** | Today yes, until `valid_until` — so at month 6 a Gold member reads all six spaces, and the "August cohort" chat accumulates everyone-who-ever-started-in-August. Probably right (it's their archive) — confirm. | Keeps access until `valid_until`. |
| **Q4** | **Gold → VIP upgrade: fresh full VIP run, or capped at the remaining term?** | A member 4 months into Gold currently gets a full new 6-cohort VIP run — 2 free cohorts. | Fresh full run (supersede + grant). |
| **Q5** | **What should ARCHIVING a batch do to existing seats?** Plan blocks new allocations but leaves existing seats live until `valid_until`. #32 already made archiving block renewals for existing members, which reads like "gone". | Determines whether archive should also set `community_spaces.active = false`. | Existing seats survive. |
| **Q6** | **`total_capacity` vs per-segment caps:** if `gold_capacity` is NULL, `vip_capacity=5`, `total_capacity=20`, a Gold rush can consume all 20 and lock out VIP buyers — the higher-priced tier loses to the cheaper one. Should `total_capacity` reserve the per-segment caps? | Pricing/fairness decision, not a technical one. | First-come-first-served. |
| **Q7** | **Should `admin_grant_batch_entitlements` enforce capacity?** Today it is an uncapped, audit-logged admin override. If Alex delegates admin to a VA, that VA can comp unlimited ₱9,999 seats. | Add `p_force boolean` + enforce by default? | Uncapped override, audit-logged. |
| **Q8** | **Will General ever become cohort-segmented?** (e.g. an "August starters" space for core/sampler/silver.) | Decides whether D1's "0 rows for general" is permanent or a staging decision. | Permanently one flat announcement space. |
| **Q9** | **Approve `pg` as a devDependency, and Docker Desktop on this machine?** (§5.1) | Without it there is no DB/RLS harness and the plan's single largest risk stays open. | Assumed yes; flagged per CLAUDE.md's "don't add without asking". |
| **Q10** | **Schedule a component-extraction phase?** `src/BookkeeperPro.jsx` reaches ~31k lines. | Not part of this work; needs an explicit decision per the single-file rule. | Not scheduled. |

---

## 10. PHASING

This is far too large for one deployment. Five increments; each is independently valuable, independently revertible, and ends in a deployable state.

### Phase 0 — Checkpoint commit (D4)
Branch `feat/cohort-entitlements-lms` off `main`. **First commit = the existing uncommitted tree** (13 prod-applied migrations, `src/lib/*`, `test/`, `api/admin/`, `api/elevenlabs/`, `docs/ai/`, `scripts/`, `supabase/`, the four new setup docs). Nothing else. This is a pure checkpoint so every later diff is reviewable, and it closes the "Parallel sessions hazard" memory item (re-check `git status` before touching `BookkeeperPro.jsx`).
**Ships:** nothing to prod. **Exit:** `npm test` green (106 tests), `npm run build` succeeds (remember: `cd` to uppercase `C:/Users/HP/Bookkeeper-Toolkits` first — the lowercase-cwd Vite quirk).

### Phase 1 — Test harness (no schema change)
`test-db/` + `_harness.mjs` + `scripts/apply-db-files.mjs` + `scripts/seed-scale.mjs` + the four new pure test files, all written against the **current** schema first (so the harness itself is validated before it validates anything).
**Ships:** dev tooling only. **Exit:** `npm run test:db` green against unmodified `db/*.sql`; `docs/db/perf-baselines.md` has "before" numbers.
**Why first:** everything after this is a schema change to a live database with paying members, and this is the only thing that can catch a mistake before prod.

### Phase 2 — #35, member-invisible
`db/2026-07-30-batch-entitlements.sql` · `src/lib/appErrors.js` + `src/lib/batchEntitlements.js` · the `api/admin/student-imports.js` grant fix · `AdminBatches` + `AdminEnrollments` re-pointed at L1 · `EntitlementRunPanel` · error-mapping wiring · the §6.2 pagination fixes for admin surfaces.
**Ships to prod:** SQL + a client build. **Zero member-visible change** — the community and courses behave identically. `subscriptions.batch_id` keeps working.
**Exit:** `test-db/entitlements`, `grants`, `concurrency`, `migrationIdempotency` green · backfill is a verified no-op on prod · `v_batch_entitlement_drift` reads only `'ok'` · advisor security findings ≤ 28 WARN / 0 ERROR · one real round trip confirms `error.hint === 'BATCH_REQUIRED'`.
**Rollback:** §2 #35's rollback block — no member loses access.

### Phase 3 — #36, the visible one
`db/2026-07-31-community-plan-capabilities.sql` · `src/lib/communityCapabilities.js` · the `CommunityHub` changes (fail-closed caps, announcement-only state, `community_write_denial` wiring, space-switcher disclosure) · the §6.2 community pagination/chunking fixes · `COMMUNITY_SETUP.md`.
**SQL and client MUST deploy together** (§2b). Announce to members *before* the deploy: General becomes announcements-and-reactions.
**Exit:** `test-db/communityRls` green · the 60-cell capability truth table green · manual QA in **both themes** (dark-mode QA is part of tool acceptance) as: admin, core member, and — via a seeded local Gold subscription — a Gold member in a private space · one week of zero `[community] meta truncated` warnings.
**Rollback:** forward-recovery preferred — flip General's two flags back on (data change, no migration).

### Phase 4 — #37, cohort LMS core
`db/2026-08-01-lms-batch-delivery.sql` · `src/lib/lmsSchedule.js` · `CohortHub` + `BatchAnnouncementList` + `BatchSessionCard` + `AdminBatchCurriculum` + `AdminSessionEditor` + `AdminAnnouncementComposer` · the four nav sync points + `VOICE_TAB_INFO` + `npm run ai:knowledge` · `LMS_SETUP.md` + `COURSE_SETUP.md`.
**Gate:** §5.6 adversarial review + `/security-review` **before** applying to prod.
**Exit:** `test-db/lmsRls` green including the four negative cases · the `lessons_read` five-clause assertion passes · `ai:knowledge:check` exits 0 · no member on core/sampler/silver sees any behaviour change.

### Phase 5 — #38, assignments
`db/2026-08-02-lms-assignments.sql` · `AssignmentPanel` + `AssignmentSubmissionForm` + `AdminAssignmentGrader` · the `assignment-files` bucket (SQL + a Dashboard fallback note).
**Gate:** same §5.6 review.
**Exit:** submission lifecycle tested end to end (draft → submit → return → resubmit → grade) as member and admin; storage policies deny cross-cohort reads.

### Phase 6 — #39, retire the bridge (gated, not scheduled)
Runs only when the three gate queries in §2 return zero and one full renewal cycle has passed. Removes the `legacy` CTE and marks `subscriptions.batch_id` read-deprecated.
**Exit:** `test-db/entitlements` green with the bridge gone; drift view still `'ok'`.

**Smallest safe increment if only one thing can ship:** Phase 1 + Phase 2. That closes both critical entitlement leaks (A1/A2/B3), the capacity double-vision (A5/B4), the import bypass, and the error contract — with **no member-visible change and a clean rollback** — and it leaves the D2 product decision, which is the only irreversible-feeling change here, for a separate, announced release.
