---
name: community-access
description: How community authorization works in this repo (spaces → channels → posts) and how to change it safely. Use this whenever you touch anything that decides who can see or write community content — community_* tables, RLS policies, capability/entitlement SQL functions, batch or plan scoping, the CommunityHub UI's permission gates, the channel admin editor, or the test-db RLS suites. Also use it before writing ANY new dated db/*.sql migration, since the apply-log, PostgREST-reload, grant, and bootstrap-fold conventions here are easy to get wrong and fail silently in production. Trigger on: "community", "channel", "space", "batch access", "cohort", "RLS", "policy", "who can post", "entitlement", "migration #N", "shadow database", "db test".
---

# Community access

Community authorization is a **three-level ladder**. Almost every bug in this area comes
from short-circuiting a level or re-deriving one by hand instead of calling the seam that
owns it.

```
L1  WHICH SPACES?     user_community_space_ids(uuid) / my_community_space_ids()
      ↑ derives from user_entitled_batches() — the batch_entitlements LEDGER
L1.5 WHICH CHANNELS?  user_community_channel_ids(uuid) / my_community_channel_ids()
      ↑ narrows L1 by the channel's audience_mode + plan/batch mappings
L2  WHAT MAY I DO?    user_community_channel_capabilities(uuid) / my_community_channel_capabilities()
      ↑ = plan capability × space flag × channel flag × approved
```

Never re-derive a level. If you find yourself writing `exists (select 1 from
batch_entitlements …)` or `case when plan_key = 'vip'` inside a policy, stop — one of the
functions above already answers that question, and it answers it the same way everywhere.

## The rules that actually bite

**Channels narrow, never widen.** A channel is only reachable if its `space_id` is already
in the caller's L1 set. This is what makes the channel layer safe to iterate on: a mistake
there can hide content, but it can never expose a space the member was not entitled to.

**Authorization is derived, never stored.** There is no membership table. Access is
recomputed from the live subscription + the `batch_entitlements` ledger on every call, so
an expiry, downgrade or revocation takes effect immediately. Do not add a cached
"is_member" column and do not trust `subscriptions.batch_id` — it is a legacy read bridge
that any ledger row disables.

**A batch is never inferred.** Not from its name, code, month, dates, price, a course
title, a signup date, or anything on screen. Batch access comes from
`user_entitled_batches()` and nowhere else. Batch *status* is deliberately not part of
access: closing or archiving a cohort must not revoke a seat someone already paid for.

**Empty mappings must fail closed.** An audience mode that requires a mapping and has zero
rows means "nobody", never "everybody". Prefer structural fail-closure — an `EXISTS` over
an empty set is already `false`, which is safer than a defensive `if` someone can delete.

**The database is the boundary; the UI is a convenience.** Hiding a button is a courtesy to
the member. Every test that matters bypasses the UI and asks Postgres directly.

## Writing an RLS policy here

Two idioms are load-bearing and both are about performance, not style.

Wrap every zero-argument helper so Postgres evaluates it once per statement as an InitPlan
rather than once per row:

```sql
using ((select public.is_admin()) or ((select public.is_approved()) and …))
```

Consume set-returning membership helpers as an **uncorrelated** subquery. This is the
difference between one function call per statement and one per row:

```sql
-- good: InitPlan, runs once
channel_id in (select public.my_community_channel_ids())

-- bad: correlated, runs per row
exists (select 1 from public.my_community_channel_ids() c where c = channel_id)
```

For write policies, scope to the capability set rather than the membership set:

```sql
channel_id in (select c.channel_id from public.my_community_channel_capabilities() c where c.can_post)
```

New tables whose writes go through RPCs need the explicit revoke — Supabase's default
grants survive a missing policy, so RLS alone is not enough:

```sql
revoke insert, update, delete, truncate on public.<table> from authenticated, anon, public;
grant select on public.<table> to authenticated;
```

`SECURITY DEFINER` functions always carry `set search_path = public`, are revoked from
`public, anon`, and expose a `my_*()` wrapper to `authenticated` while the parameterised
`user_*(uuid)` form stays revoked.

## Writing a dated migration

Files are `db/YYYY-MM-DD-kebab-name.sql`. The `#N` lives in the `db/README.md` table, not
in the filename, and that table's number — not lexical sort — is the dependency order.

Every file must be idempotent (`create … if not exists`, `create or replace`,
`drop policy if exists` then create, `on conflict do nothing`) because it will be run again
on the shadow database and folded into the bootstrap. Do **not** write `begin;`/`commit;` —
it breaks the statement splitter in `scripts/apply-db-files.mjs`.

Preflight-guard on the objects you depend on, **including `schema_migrations`** — without
that guard the tail insert aborts the whole file.

The last two statements, in this order:

```sql
notify pgrst, 'reload schema';

insert into public.schema_migrations (filename, checksum, notes) values
 ('2026-08-18-community-channels.sql', null, 'channels (#40): …')
on conflict (filename) do nothing;
```

Then, in the same change:
- add the `| N | file | what | depends on |` row to `db/README.md` and extend its one-line
  order chain;
- add an `OBJECT_CHECKS` entry to `scripts/audit-db.mjs` labelled `'#N    <object>'` — use
  `to_regclass` / `to_regprocedure`, wrap `has_function_privilege()` in a `CASE` (it
  *errors* on a missing function and aborts the audit), and read `pg_policies.with_check`
  with `ilike` since that column is reparsed;
- fold the file verbatim into `db/000_full_database_bootstrap.sql` as the next
  `§N) FOLDED VERBATIM — <filename>` tail section, so a fresh install ends where a migrated
  database ends.

## Dry-running a migration safely

Postgres DDL is transactional, so the whole migration can be checked against the **real**
schema and data without persisting anything:

```sql
begin;
  -- paste the migration
  -- then any verification selects you want
rollback;
```

This catches typos, wrong column names, broken backfills and constraint violations that no
amount of reading finds. It is the fastest correctness win available in this repo. The one
restriction is that `create index concurrently` cannot run inside a transaction — this repo
does not use it, so that is not a limitation in practice.

Never apply a migration to production without explicit authorization. Verifying is free;
applying is not.

## Testing

Pure logic lives in `src/lib/*.js` — dependency-free ESM with no imports, no DOM, no
Supabase — so the same rules run in the browser, in `api/` endpoints, and under
`node --test`. Mirror every authorization rule you write in SQL into one of these modules
and pin it in `test/*.test.mjs`.

Suite conventions worth matching: a header comment explaining *why the suite exists and
what breaks if the halves drift*, flat `test('product sentence', …)` with no `describe`,
`assert` from `node:assert/strict`, fixture constants named after the live rows, a
loop-message third argument on every assertion, and a **counted sweep** that asserts the
size of the truth table so a silently-dropped cell fails:

```js
assert.equal(cells, 24, 'the matrix must cover 3 plans x 2 kinds x 4 actions');
```

Database behaviour is proven in `test-db/*.dbtest.mjs` against a **shadow project**, never
production. `test-db/_harness.mjs` gives you `makePersona`, `seedMember`, `makeBatch`,
`expectDenied`, `expectAppError`, `resetShadow`. Two traps it exists to prevent:

- `expectDenied` accepts *either* a 42501-family error *or* a zero-row success, because an
  UPDATE filtered out by a USING clause returns 200 with an empty array. Asserting "no
  error" is a false pass.
- The anon client is a module singleton and must never be signed in — a persona sign-in on
  it once produced a phantom "anonymous can read member rows" leak.

Add any new table to `resetShadow()`'s truncate list, or the next suite inherits its rows.

Personas to cover for anything access-related: administrator, sampler, silver, VIP in
batch A, VIP in batch B, an expired member, and anonymous. Cross-batch isolation (A must
not see B) and the expired member are the two that catch real bugs.

## Lockstep sets

These pairs drift silently — one half keeps working while the other quietly disagrees.
Change them together or not at all.

| When you change | Move all of these |
|---|---|
| who may post/comment/react/attach | `enrollment_plans` capability columns ↔ `user_community_capabilities()` ↔ channel flags ↔ the community write policies ↔ `capabilitiesFor()`/`effectiveCaps()` in `src/lib/communityCapabilities.js` |
| channel audience rules | `user_community_channel_ids()` ↔ `channelAudienceAllows()` in `src/lib/communityChannels.js` ↔ `test/communityChannels.test.mjs` ↔ `test-db/communityChannels.dbtest.mjs` |
| plan scope over courses | `courses_read` ↔ the #27 trainer mirrors ↔ `PLAN_ENTITLEMENTS` ↔ `planScopeAllows()` |
| how many cohorts a plan grants | `plan_batch_count()` ↔ `enrollment_plans.eligible_batch_count` ↔ `planBatchCount()` |
| an error code | `app_error_catalog()` (re-list every existing code) ↔ `APP_ERROR_CODES` ↔ `APP_ERROR_COPY` |
| a plan is added, removed or repriced | `enrollment_plans` migration ↔ `ENROLLMENT_PLANS_FALLBACK` ↔ `PLAN_ENTITLEMENTS` ↔ bootstrap §9 seed ↔ `ENROLLMENT_PLAN_KEYS` ↔ `PLAN_ALLOWLIST_FALLBACK`, then `npm run ai:knowledge` |

Clients branch on `error.hint` (the stable app-error code), never on HTTP status or
`error.code`.

## Client-side gates

The client must consume **server-computed** effective capabilities and fail closed while
they are loading or malformed. The historical bug worth remembering: `CommunityHub` used
`!currentSpace || member_posting !== false`, which fails *open* when the space has not
resolved yet, so members saw a New-discussion button whose submit then 42501'd. Absent
permission data means "no", not "yes".

Never thread props into `CommunityHub` — it is mounted prop-less under a memoized
keep-alive `TabPanel`, and adding a changing prop silently re-enables app-wide re-renders.
Talk to it through the URL (`writeAppRoute`) or a window event, following the
`COMMUNITY_BELL_POKE` precedent.

## Verify before claiming done

```
npm test                    # pure libs; needs nothing
npm run build               # catches JSX/import breakage
npm run db:audit            # migrations applied + promised objects exist (needs SUPABASE_ACCESS_TOKEN)
npm run test:db             # RLS suites (needs .env.test → a shadow project)
npm run ai:knowledge:check  # product knowledge did not drift
```

If one cannot run, say which, why, what you verified instead, and what remains to be
checked in production. Do not report an unexecuted command as passing.
