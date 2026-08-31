// test/studentProgressSql.test.mjs — the #52 progress domain, pinned as TEXT.
//
// ★ EVERY ASSERTION RUNS AGAINST BOTH FILES, and that is the whole point. The dated
//   migration is what an EXISTING database runs; the §39 fold in the bootstrap is what
//   a FRESH install gets, and it is spliced by hand. Nine of the ten tests here used to
//   read only FILES[0], so grants, search_path, the privacy row shape and the permission
//   gate were unverified in the file that actually stands up a new project.
//
// ★ bootstrapFolds.test.mjs does NOT close that gap. It is a line-SET CONTAINMENT check,
//   so a fold may carry EXTRA lines — an older, weaker copy of a function, or a stray
//   `grant … to anon` — and still pass, with the last definition winning on a fresh
//   install. Containment proves nothing was dropped; only these assertions prove nothing
//   wrong was added.
//
// Reads SQL as TEXT. No database, no credentials, runs anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUDENT_PROGRESS_TRACKS, LEADERBOARD_SCOPES } from '../src/lib/studentProgress.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'db/2026-09-01-student-progress-rankings.sql',
  'db/000_full_database_bootstrap.sql',
];
// #53 and #54 replace functions #52 created, so their rules cannot be asserted against
// #52's file — only against the migration that introduced them and the bootstrap, whose
// last definition is what a fresh install actually runs.
const FOLLOWUP_FILES = [
  'db/2026-09-02-progress-rankings-followup.sql',
  'db/000_full_database_bootstrap.sql',
];
const FAMILY_FILES = [
  'db/2026-09-03-progress-course-family-scoping.sql',
  'db/000_full_database_bootstrap.sql',
];
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const sqlByFile = Object.fromEntries(
  [...new Set([...FILES, ...FOLLOWUP_FILES, ...FAMILY_FILES])].map((file) => [file, read(file)]),
);
const compact = (value) => value.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

/**
 * The LAST definition of a function in a file. That matters more than it looks: the
 * bootstrap now carries §39, §40 and §41, which redefine five of these functions, and
 * on a fresh install the last definition is the one that survives. Reading the first
 * would test superseded bodies and pass while the shipped ones drifted.
 */
function functionBody(sql, name) {
  const start = sql.toLowerCase().lastIndexOf(`create or replace function public.${name.toLowerCase()}`);
  assert.notEqual(start, -1, `${name} is missing`);
  const rest = sql.slice(start);
  const end = rest.search(/\n(?:create|drop|comment|revoke|grant|notify|insert)\s/i);
  return end > 0 ? rest.slice(0, end) : rest;
}

/** Run one assertion block against every file, naming the file in the test title. */
const forEachOf = (files) => (title, fn) => {
  for (const file of files) test(`${title} — ${file.replace('db/', '')}`, () => fn(file));
};
const forEachFile = forEachOf(FILES);
const forEachFollowup = forEachOf(FOLLOWUP_FILES);
const forEachFamily = forEachOf(FAMILY_FILES);

// ── The domain exists, in both files ─────────────────────────────────────────

forEachFile('migration and bootstrap expose the complete progress domain', (file) => {
  const sql = compact(sqlByFile[file]);
  for (const table of [
    'student_progress_milestones', 'student_foundation_completions',
    'student_ranking_preferences', 'student_progress_daily',
  ]) assert.match(sql, new RegExp(`create table if not exists public\\.${table}`), `${file}: ${table}`);
  for (const fn of [
    'complete_course_lesson', 'complete_progress_feature_guide', 'set_leaderboard_visibility', 'set_foundation_milestone',
    'student_progress_current', 'my_student_progress', 'student_leaderboard',
    'student_progress_snapshot', 'admin_student_progress_report',
  ]) assert.match(sql, new RegExp(`function public\\.${fn}\\(`), `${file}: ${fn}`);
});

// ── Write paths ──────────────────────────────────────────────────────────────

forEachFile('every client progress writer is self-scoped and explicitly granted', (file) => {
  const sql = compact(sqlByFile[file]);
  for (const signature of [
    'complete_course_lesson(uuid)',
    'complete_progress_feature_guide(text)',
    'set_leaderboard_visibility(boolean)',
    'set_foundation_milestone(text, boolean)',
  ]) {
    assert.ok(sql.includes(`revoke all on function public.${signature} from public, anon, authenticated`), signature);
    assert.ok(sql.includes(`grant execute on function public.${signature} to authenticated`), signature);
  }
  assert.match(sql, /revoke insert, update, delete on table public\.lesson_progress from public, anon, authenticated/);
  assert.match(sql, /revoke insert, update, delete on table public\.course_completions from public, anon, authenticated/);
  assert.match(sql, /revoke insert, update, delete on table public\.feature_video_completions from public, anon, authenticated/);
});

forEachFile('lesson completion derives course identity and validates real access', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'complete_course_lesson'));
  assert.match(body, /join public\.courses c on c\.id = l\.course_id/);
  assert.match(body, /not v_lesson\.published/);
  assert.match(body, /public\.user_is_approved\(v_uid\)/);
  assert.match(body, /public\.user_is_enrolled\(v_uid\)/);
  assert.match(body, /v_lesson\.slug like 'qbo-%' and v_lesson\.access_tier = 'essentials'/);
  assert.match(body, /values \(v_uid, v_lesson\.id, v_lesson\.course_id, now\(\)\)/);
  assert.doesNotMatch(body, /p_course_id/,
    'the caller must never name the course — it is derived from the lesson');
});

forEachFile('the scored mock guide derives its current version server-side', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'complete_progress_feature_guide'));
  assert.match(body, /p_feature_key is distinct from 'mock_interview_simulator'/);
  assert.match(body, /coalesce\(g\.video_path, g\.video_url\)/);
  assert.match(body, /g\.is_active/);
  assert.match(body, /v_plan = 'sampler'/);
  assert.match(body, /values \(v_uid, p_feature_key, v_version, true, now\(\), now\(\)\)/);
  assert.doesNotMatch(body, /p_video_version/);
});

forEachFile('canonical lesson/course integrity is enforced at rest', (file) => {
  const sql = compact(sqlByFile[file]);
  assert.match(sql, /set course_id = l\.course_id from public\.course_lessons l where l\.id = lp\.lesson_id/);
  assert.match(sql, /foreign key \(lesson_id, course_id\) references public\.course_lessons\(id, course_id\)/);
  assert.match(sql, /join public\.course_lessons l on l\.id = lp\.lesson_id and l\.course_id = lp\.course_id/);
});

// ── Un-completing must never rewrite history ─────────────────────────────────
//
// Deleting the row on un-complete and re-inserting on re-complete let any client
// reset its own recency: drive the score down, drive it back up, land a brand new
// completed_at, and so forge a "recent milestone", game Most Improved and clear the
// staff report's 14-day inactivity flag. `completed` is a flag; the row is durable.

forEachFile('un-completing a foundation milestone keeps the row and its first completed_at', (file) => {
  const sql = compact(sqlByFile[file]);
  const body = compact(functionBody(sqlByFile[file], 'set_foundation_milestone'));
  // Scoped to the table under test: feature_video_completions declares the same
  // column and pre-dates #52 in the bootstrap, so an unscoped match passed there
  // whether or not student_foundation_completions had the flag at all.
  const table = sql.slice(sql.indexOf('create table if not exists public.student_foundation_completions'));
  assert.ok(table.startsWith('create table'), 'the foundation completions table must exist');
  assert.match(table.slice(0, table.indexOf(');') + 2), /completed boolean not null default true/,
    'the table needs a completed flag, or un-completing has to delete');
  assert.doesNotMatch(body, /delete from public\.student_foundation_completions/,
    'un-completing must not delete the row — completed_at would be re-minted on re-complete');
  assert.match(body, /set completed = false/, 'un-completing flips the flag');
  const at = body.indexOf('on conflict (user_id, milestone_key) do update');
  assert.ok(at >= 0, 'the re-complete path must be an upsert, or completed_at is rewritten');
  // To the end of the statement, not a magic character count: one more column in the
  // set-list used to push the real completed_at outside the window and pass.
  const reComplete = body.slice(at, body.indexOf(';', at) + 1);
  assert.doesNotMatch(reComplete, /completed_at/,
    're-completing must not touch completed_at: it records the FIRST completion');
});

// ── The live scorer ──────────────────────────────────────────────────────────

forEachFile('the live scorer uses canonical entitlements and normalized available weights', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_progress_current'));
  assert.match(body, /public\.user_entitled_batches\(m\.user_id\)/);
  assert.match(body, /m\.plan_key = 'vip'/);
  assert.match(body, /c\.published/);
  assert.match(body, /m\.plan_key <> 'sampler' or \(c\.slug like 'qbo-%' and c\.access_tier = 'essentials'\)/);
  // Not a bare /nullif\(/ — the body has two unrelated nullif() calls, so deleting the
  // renormalising denominator entirely and dividing by a constant still matched.
  assert.match(body, /nullif\(\s*\(case when s\.foundation_total > 0 then 20 else 0 end \+ case when s\.qbo_total > 0 then 40 else 0 end/,
    'the divisor must be the sum of AVAILABLE weights, guarded against an all-zero plan');
});

forEachFile('the scorer weights match STUDENT_PROGRESS_TRACKS exactly', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_progress_current'));
  for (const track of STUDENT_PROGRESS_TRACKS) {
    // The DENOMINATOR (available-weight sum)...
    assert.match(
      body,
      new RegExp(`case when s\\.${track.key}_total > 0 then ${track.weight} else 0 end`),
      `${track.key} is weighted ${track.weight} in src/lib/studentProgress.js — the SQL must agree, `
      + 'or the number a learner reads is not the number the module documents',
    );
    // ...and the NUMERATOR. Pinning only the denominator let the two disagree: a
    // numerator changed to `s.qbo_score * 25` against a denominator still weighting
    // 40 passed cleanly while every QBO learner was scored on the wrong scale.
    assert.match(
      body,
      new RegExp(`case when s\\.${track.key}_total > 0 then s\\.${track.key}_score \\* ${track.weight} else 0 end`),
      `the ${track.key} numerator weight must match its denominator weight`,
    );
  }
});

forEachFile('staff are excluded from the ranking population', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_progress_current'));
  assert.match(body, /from public\.staff_memberships sm/,
    'the population must consult staff_memberships: a promoted student keeps their subscription '
    + 'row, so nothing else removes them from the student-facing board');
  assert.match(body, /sm\.status in \('invited', 'active'\)/,
    "matching #50: 'suspended' and 'revoked' confer no authority and may be real students");
});

// ── The public board ─────────────────────────────────────────────────────────

forEachFile('public leaderboard has an allowlisted privacy-safe row shape', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_leaderboard'));
  const returns = body.match(/returns table \((.*?)\) language plpgsql/s)?.[1] || '';
  for (const allowed of [
    'rank', 'learner_label', 'initials', 'overall_score', 'completed_milestones',
    'total_milestones', 'weekly_gain', 'foundation_score', 'qbo_score',
    'profile_score', 'interview_score', 'is_current_user', 'total_count',
  ]) assert.match(returns, new RegExp(`\\b${allowed}\\b`), allowed);
  for (const forbidden of ['user_id', 'email', 'full_name', 'avatar', 'receipt', 'payment', 'batch_id', 'plan_key', 'plan']) {
    assert.doesNotMatch(returns, new RegExp(`\\b${forbidden}\\b`), forbidden);
  }
  // A hidden learner must be filtered BEFORE the ranking window, or the surviving
  // ranks carry gaps that disclose how many hidden learners outrank you.
  const hidden = body.indexOf('coalesce(pref.public_visible, true)');
  const ranked = body.indexOf('dense_rank()');
  assert.ok(hidden >= 0, 'the opt-out predicate must be present');
  assert.ok(ranked >= 0, 'the board must be dense-ranked');
  assert.ok(hidden < ranked,
    'public_visible must be filtered before dense_rank(), not after: ranking first and '
    + 'hiding second leaves gaps that count the hidden learners above you');
  assert.match(body, /p_batch_id is not null and p_batch_id <> v_caller\.batch_id/);
  assert.match(body, /limit v_limit offset v_offset/);
});

forEachFile('current scores are live and never read the snapshot history', (file) => {
  // student_progress_daily is history. If a current score read it, a learner would see
  // a completion on the next cron run rather than the next request — and a cron outage
  // would freeze every score on the board.
  for (const fn of ['student_progress_current', 'student_rank_in_scope']) {
    assert.doesNotMatch(compact(functionBody(sqlByFile[file], fn)), /student_progress_daily/,
      `${fn} must compute from live progress, never from the daily snapshot table`);
  }
});

forEachFile('the board accepts exactly the LEADERBOARD_SCOPES keys', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_leaderboard'));
  const allowList = body.match(/v_scope not in \(([^)]*)\)/)?.[1] || '';
  const inSql = [...allowList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const inJs = LEADERBOARD_SCOPES.map((scope) => scope.key).sort();
  assert.deepEqual(inSql, inJs,
    'a scope the UI offers but the RPC refuses is a control that always errors; a scope the RPC '
    + 'accepts but the UI never offers is an unreviewed audience');
});

// ── "No baseline" is not zero ────────────────────────────────────────────────
//
// The product decision was explicit: a learner with no snapshot from 7+ days ago shows
// "—"/New and is EXCLUDED from Most Improved This Week, never a fabricated 0.00. For the
// first seven days after this migration NOBODY has a qualifying snapshot, so a
// coalesce-to-self here turns the whole week board into a mislabelled copy of the
// overall board with every row claiming zero improvement.

forEachFile('weekly gain is null when there is no baseline, never zero', (file) => {
  const board = compact(functionBody(sqlByFile[file], 'student_leaderboard'));
  const mine = compact(functionBody(sqlByFile[file], 'my_student_progress'));
  assert.doesNotMatch(board, /coalesce\(prior\.overall_score, c\.overall_score\)/,
    'coalescing the missing baseline to the current score yields exactly 0.00');
  assert.doesNotMatch(mine, /coalesce\(v_prior_score, v_progress\.overall_score\)/,
    'coalescing the missing baseline to the current score yields exactly 0.00');
  assert.match(board, /case when prior\.overall_score is null then null/);
  assert.match(mine, /case when v_prior_score is null then null/);
  assert.match(board, /v_window <> 'week' or prior\.overall_score is not null/,
    'the week window must exclude learners who have never been measured over a week');
});

forEachFile('the baseline window is bounded at both ends', (file) => {
  for (const name of ['student_leaderboard', 'my_student_progress']) {
    const body = compact(functionBody(sqlByFile[file], name));
    assert.match(body, /snapshot_date <= current_date - 7/, `${name}: baseline is at least 7 days old`);
    assert.match(body, /snapshot_date >= current_date - 14/,
      `${name}: without a floor, a months-old snapshot after a cron outage is still presented `
      + 'and ranked as a 7-day gain');
  }
});

// ── Permissions, history, hygiene ────────────────────────────────────────────

forEachFile('private and staff APIs are separated by server permissions', (file) => {
  const sql = compact(sqlByFile[file]);
  const report = compact(functionBody(sqlByFile[file], 'admin_student_progress_report'));
  assert.match(report, /public\.has_staff_permission\('student_progress\.read'\)/);
  assert.match(report, /needs_attention/);
  assert.match(report, /interval '14 days'/);
  assert.match(report, /interval '7 days'/);
  assert.match(sql, /\('operations_admin', 'student_progress\.read'\)/);
  assert.doesNotMatch(sql, /\('trainer', 'student_progress\.read'\)/);
});

forEachFile('daily history is idempotent, bounded and not client-readable', (file) => {
  const sql = compact(sqlByFile[file]);
  const snapshot = compact(functionBody(sqlByFile[file], 'student_progress_snapshot'));
  assert.match(snapshot, /on conflict \(user_id, snapshot_date\) do update/);
  assert.match(snapshot, /snapshot_date < p_date - 400/);
  assert.match(sql, /'15 0 \* \* \*'/);
  assert.match(sql, /revoke all on table public\.student_progress_daily from public, anon, authenticated/);
  assert.doesNotMatch(sql, /grant select on table public\.student_progress_daily to authenticated/);
});

forEachFile('privileged functions use a pinned search path and closed execution grants', (file) => {
  const sql = compact(sqlByFile[file]);
  for (const name of [
    'complete_course_lesson', 'complete_progress_feature_guide', 'set_leaderboard_visibility', 'set_foundation_milestone',
    'student_progress_current', 'student_rank_in_scope', 'my_student_progress',
    'student_leaderboard', 'student_progress_snapshot', 'admin_student_progress_report',
  ]) {
    const body = compact(functionBody(sqlByFile[file], name));
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = public, pg_temp/);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(`), `${name} revoke`);
  }
});

// ── The eight Accounting 101 milestones ──────────────────────────────────────

forEachFile('the foundation catalog seeds eight stable, position-ordered keys', (file) => {
  const sql = sqlByFile[file];
  const keys = [...sql.matchAll(/\('(accounting-101-module-\d{2})', 'foundation'/g)].map((m) => m[1]);
  assert.equal(keys.length, 8, 'Accounting 101 has eight modules');
  assert.deepEqual(keys, [...new Set(keys)], 'milestone keys must be unique');
  assert.deepEqual(
    keys,
    Array.from({ length: 8 }, (_, i) => `accounting-101-module-${String(i + 1).padStart(2, '0')}`),
    'keys are stable identifiers, not array indexes — the pre-#52 UI keyed completion by '
    + 'position, so reordering a module silently moved a student’s progress',
  );
});

// ── The migration records itself (dated file only, by definition) ────────────

test('the migration records itself in the apply log and reloads PostgREST', () => {
  const sql = sqlByFile[FILES[0]];
  assert.match(sql, /insert into public\.schema_migrations \(filename, checksum, notes\) values/,
    'without this row npm run db:audit reports the file unapplied forever');
  assert.ok(sql.includes("'2026-09-01-student-progress-rankings.sql'"), 'the row must name this exact filename');
  assert.match(sql, /notify pgrst, 'reload schema';/,
    'new tables and functions are invisible to PostgREST until the schema cache reloads');
});

test('the migration is transaction-free, or the statement splitter breaks', () => {
  const sql = sqlByFile[FILES[0]].split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(sql, /^\s*(begin|commit|rollback)\s*;/im,
    'scripts/apply-db-files.mjs sends one statement per HTTP round trip — an explicit '
    + 'transaction block cannot span them and breaks the splitter');
});

test('the bootstrap folds this migration as §39', () => {
  assert.match(sqlByFile[FILES[1]],
    /§39\) FOLDED VERBATIM — 2026-09-01-student-progress-rankings\.sql/,
    'a fresh install only gets #52 if the fold banner is there for bootstrapFolds.test.mjs to find');
});

// ── #53: a scope you do not belong to is a plan oracle ───────────────────────

forEachFollowup('a learner reads only their own segment board', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_leaderboard'));
  // Both directions: the VIP board is the set of VIP members, and general is its
  // complement, so either one alone still discloses the plan.
  assert.match(body, /v_scope = 'vip' and v_caller\.plan_key <> 'vip'/,
    'a non-VIP must not be able to enumerate the VIP roster');
  assert.match(body, /v_scope = 'general' and v_caller\.plan_key = 'vip'/,
    'a VIP must not be able to enumerate the complement either');
  assert.match(body, /not v_is_staff/,
    'staff legitimately read every board — the restriction is on learners');
  // The refusal must be indistinguishable from my_batch's, or the error text itself
  // becomes the oracle the check exists to close.
  const refusals = (body.match(/that leaderboard is unavailable\./g) || []).length
    + (body.match(/that batch leaderboard is unavailable\./g) || []).length;
  assert.ok(refusals >= 2, 'scope refusals must reuse the existing wording');
});

forEachFollowup('guide completion cannot re-mint its own recency', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'complete_progress_feature_guide'));
  assert.doesNotMatch(body, /completed = true, completed_at = now\(\), updated_at/,
    'an unconditional completed_at refresh lets a learner clear their own inactivity flag');
  assert.match(body, /is distinct from excluded\.video_version/,
    'only a genuinely new video version may re-stamp completed_at');
});

forEachFollowup('the staff report excludes staff from BOTH arms', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'admin_student_progress_report'));
  // current_rows inherits the exclusion from student_progress_current; the historical
  // arm reads student_progress_daily directly and needs its own.
  assert.match(body, /historical_rows as \([\s\S]*?staff_memberships sm[\s\S]*?sm\.status in \('invited', 'active'\)/,
    'a promoted student must not reappear as an inactive learner with name and email');
});

// ── #54: one run per course family ──────────────────────────────────────────

forEachFamily('a duplicated cohort re-run does not inflate the denominator', (file) => {
  const body = compact(functionBody(sqlByFile[file], 'student_progress_current'));
  assert.match(body, /with recursive/,
    'the duplication lineage is walked recursively so a copy-of-a-copy still groups');
  assert.match(body, /join public\.courses p on p\.id = l\.source_course_id/,
    'families are grouped by source_course_id, the duplication lineage');
  assert.match(body, /where l\.depth < 10/,
    'the walk must be bounded — source_course_id is not constrained acyclic');
  assert.match(body, /distinct on \(cr\.user_id, cr\.root_id\)/,
    'exactly one run per learner per family may reach the denominator');
  assert.match(body, /order by cr\.user_id, cr\.root_id, rp\.done desc, cr\.created_at desc/,
    'their run wins; with no progress the newest run does');
  // course_date is a display label. CLAUDE.md holds that no function reads it, and
  // picking the newest run is exactly the temptation that would break the rule.
  assert.doesNotMatch(body, /course_date/,
    'the scorer must not read course_date — it is a display label, not a batch link');
});

