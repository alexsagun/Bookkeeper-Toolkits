# The shadow project — how to run `npm run test:db`

`npm test` is the everyday suite: pure functions, no network, no Docker, runs anywhere.

`npm run test:db` is different. It is an **integration suite that drives a real Supabase stack** —
PostgREST, GoTrue, Storage, and the actual `anon` / `authenticated` roles — as real signed-in users.
It is the only thing in this repo that has ever executed the RLS policies the way a browser does, and
it needs a database it is allowed to destroy.

That database is a **shadow project**: a second, disposable Supabase project. There is normally no
shadow project sitting around — it gets created when someone needs to run the suite and deleted
afterwards. This page is how to bring one back.

## Why not the live project

The suite calls `resetShadow()`, which `TRUNCATE`s `subscriptions`, `batch_entitlements`, every
`community_*` table, and `enrollment_requests`. Pointing it at production would delete real members'
data.

`scripts/_shadow.mjs` refuses to start if `.env.test` names the live project ref — that check is the
last line of defence and must not be removed:

```js
if (ref === LIVE_PROJECT_REF || url.includes(LIVE_PROJECT_REF)) {
  throw new Error('REFUSING TO RUN: .env.test points at the LIVE project …');
}
```

## Why not a local Docker stack

`supabase start` needs Docker Desktop and WSL2. Neither is installed on the current development
machine, and a local stack still would not exercise the hosted PostgREST behaviour (`max_rows`,
SQLSTATE→HTTP mapping) that several assertions depend on. A free hosted project does.

**Cost:** the org is on the Supabase **free plan, which includes 2 projects**, so a shadow project is
$0 — it just occupies the second slot. Free projects auto-pause after about a week idle and can be
restored from the dashboard.

## Recreating one (about 5 minutes of work, ~40 minutes of waiting)

### 1. Create the project

Dashboard → New project, in the same org. Any name (`toolkit-shadow-tests` is the convention), any
region, and a strong database password. Or via the Management API, with
`SUPABASE_ACCESS_TOKEN` from `.env`:

```bash
curl -X POST https://api.supabase.com/v1/projects \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"toolkit-shadow-tests","organization_id":"<org id>","region":"ap-southeast-2","db_pass":"<generated>"}'
```

### 2. Write `.env.test` (gitignored — never commit it)

```
SHADOW_PROJECT_REF=<new project ref>
SHADOW_SUPABASE_URL=https://<new project ref>.supabase.co
SHADOW_DB_PASSWORD=<the password you set>
SHADOW_SUPABASE_ANON_KEY=<anon key>
SHADOW_SUPABASE_SECRET_KEY=<service_role key>
```

Keys come from Dashboard → Project Settings → API, or:

```bash
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/<ref>/api-keys?reveal=true"
```

### 3. Build the schema

```bash
npm run db:shadow:apply        # applies db/000_full_database_bootstrap.sql
node scripts/apply-db-files.mjs db/2026-07-30-batch-entitlements.sql
node scripts/apply-db-files.mjs db/2026-07-31-community-plan-capabilities.sql
```

The bootstrap is ~600 statements over the Management API and takes **30–40 minutes**. That is the slow
part; everything after it is fast. Statements are applied one at a time so a failure names the exact
statement, and transient deadlocks on `storage.objects` are retried automatically.

Each dated file after the bootstrap's fold point must be applied in filename order. Check
`db/README.md` for which files the bootstrap already contains.

### 4. Confirm the bootstrap actually reproduces production

```bash
npm run db:shadow:verify
```

This compares tables, RLS flags, policies, functions (with their `security definer` /
`search_path` settings) and columns against the **live** project, read-only. It should print:

```
✔ tables: identical
✔ policies: identical
✔ functions: identical
✔ columns: identical
Bootstrap parity: PASS — a fresh install reaches the live schema.
```

This is the only automated check that `db/000_full_database_bootstrap.sql` is still honest. Run it
whenever a dated migration is folded into the bootstrap.

### 5. Run the suite

```bash
npm run test:db     # 42 tests, ~12 minutes
```

It is slow because every fixture statement is an HTTPS round trip to the Management API. That is the
price of testing the real stack; it is not run on every change.

## Deleting it again

```bash
curl -X DELETE "https://api.supabase.com/v1/projects/<ref>" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
rm .env.test
```

Leave `test-db/`, `scripts/_shadow.mjs`, `scripts/apply-db-files.mjs` and the npm scripts in place.
Without a target the suite simply cannot start; with one it works again immediately.

## What the suite covers (and why it is worth the wait)

42 tests across two files:

- `test-db/entitlements.dbtest.mjs` — cohort runs, registry allocation, the FIFO queue, batch
  isolation between cohorts and between VIP and the general segment, live-plan reconciliation on
  downgrade, expiry and grace, capacity, ledger forgery attempts, and history preservation.
- `test-db/communityRls.dbtest.mjs` — the D2 matrix (no plan posts or comments in General, every plan
  reacts), cohort-space separation, `author_id` / `space_id` / admin-tag forgery, the withdraw vs
  re-publish split, the mention directory gate, and anonymous access.

Three genuine defects were found this way, none of which reading the SQL had caught:

1. **The member soft-delete never worked.** Postgres refuses an `UPDATE` whose resulting row would be
   invisible to the writer under the SELECT policies. `community_posts_read` admitted only
   `status = 'active'`, so an author withdrawing their own post got `42501`. Fixed in `#36` with an
   author-owns-deleted branch.
2. **The FIFO binder over-allocated.** A member holding several queued seats had all of them bound to
   one new cohort, because the guard was evaluated against the cursor's snapshot instead of being
   re-checked inside the loop.
3. **`#35` was not re-runnable** — its own preflight failed once it had replaced
   `admin_finalize_enrollment`.

It also produced one *false* alarm worth remembering: `anonClient()` is a module singleton, and
`makePersona()` used to sign **it** in, so the "anonymous visitor" test was really an authenticated
member and reported a data leak that did not exist. A harness that lies costs more than no harness —
keep sign-in on its own throwaway client.
