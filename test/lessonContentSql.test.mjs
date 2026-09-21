// test/lessonContentSql.test.mjs — #65's SQL against the pure module it mirrors.
//
// ★ WHY THIS SUITE EXISTS. Two parsers read the same image token: src/lib/lessonContent.js
//   decides what a student SEES, and course_lesson_sync_assets() decides which images are
//   AUTHORIZED. If they ever disagree about where a token ends, the text on the page and
//   the references protecting it describe different documents — and the disagreement is
//   silent in both directions (an image that renders but is unreadable, or one that is
//   readable and invisible). The bounds are asserted the same way: built FROM the exported
//   constants, never retyped, so raising a limit in one place fails here instead of passing
//   against a stale literal.
//
// Every assertion runs against the dated file AND the bootstrap fold, because
// bootstrapFolds.test.mjs is a line-set CONTAINMENT check: it proves nothing was dropped
// from a fold, never that nothing wrong was added — and on a fresh install the fold is
// what runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LESSON_ASSET_BUCKET,
  LESSON_ASSET_TOKEN_SRC,
  LESSON_CAPTION_MARKER,
  LESSON_CONTENT_FORMATS,
  LESSON_IMAGE_ALT_MAX,
  LESSON_IMAGE_MAX_BYTES,
  LESSON_IMAGE_MAX_PER_LESSON,
  LESSON_IMAGE_MIMES,
  lessonAssetRefs,
} from '../src/lib/lessonContent.js';
import { APP_ERROR_CODES } from '../src/lib/appErrors.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const DATED = 'db/2026-09-20-course-lesson-assets.sql';
const dated = read(DATED);
const bootstrap = read('db/000_full_database_bootstrap.sql');

/** The §52 fold's own slice — never the whole bootstrap, or an assertion could pass
 *  because some OTHER section happens to contain the string. */
const fold = (() => {
  const at = bootstrap.indexOf('§52) FOLDED VERBATIM');
  assert.ok(at > 0, '§52 (#65) is not folded into the bootstrap');
  const next = bootstrap.indexOf('FOLDED VERBATIM', at + 10);
  return bootstrap.slice(at, next === -1 ? bootstrap.length : next);
})();

const SOURCES = [['dated file', dated], ['bootstrap §52', fold]];

/** SQL with comments stripped, so an assertion never passes on prose that explains it. */
const code = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/**
 * JS with comments stripped, for the same reason — and this one is not hypothetical.
 * LessonRichText's own docblock says "there is no dangerouslySetInnerHTML here", which is
 * the invariant; a scan for the bare string found that sentence and failed. CLAUDE.md
 * names this shape directly: assert against extracted vocabularies, never "this string
 * appears nowhere in the file", because the comment explaining a rule defeats it.
 */
const jsCode = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const [label, sql] of SOURCES) {
  const exec = code(sql);

  // ── The two parsers ───────────────────────────────────────────────────────

  test(`${label}: the SQL token pattern matches the module's, character for character`, () => {
    // The JS source is a JS string literal, so its escaping differs; compare the pattern's
    // MEANING by reducing both to the pieces that decide where a token starts and ends.
    const jsAlt = /!\\\[\(\[\^\\\]\\n\]\*\)\\\]/.test(LESSON_ASSET_TOKEN_SRC);
    assert.ok(jsAlt, 'the module pattern no longer uses the [^\\]\\n]* alt class');
    assert.match(exec, /!\\\[\(\[\^\\\]\\n\]\*\)\\\]\\\(lesson-asset:\/\//,
      'the SQL must use the SAME alt class: anything else and the two parsers can '
      + 'disagree about where a token ends');
    assert.ok(LESSON_ASSET_TOKEN_SRC.includes('lesson-asset://'));
    assert.match(exec, /lesson-asset:\/\//, 'the SQL must read the same scheme');
  });

  test(`${label}: a caption is invisible to the database, so it needs no migration`, () => {
    // ★ THE DESIGN RESTS ON THIS. A caption is a separate LINE ("^ text") and never part
    //   of the token, so the trigger that derives an image's authorization rows cannot
    //   see it. If a caption ever had to live INSIDE the token, this SQL — already
    //   applied to production — would have to change with it, and the two parsers would
    //   be one wording change away from disagreeing about where a token ends.
    //   So run the DATABASE'S OWN pattern over a captioned document and prove it reads
    //   exactly the same single token the module does.
    const literal = /'(!\\\[\(\[\^\\\]\\n\]\*\)\\\]\\\(lesson-asset:\/\/[^']+)'/.exec(exec);
    assert.ok(literal, 'the trigger no longer carries a recognisable token pattern');
    const pgAsJs = new RegExp(literal[1], 'g');

    const uuid = '11111111-2222-4333-8444-555555555555';
    const token = `![Google Form menu](lesson-asset://${uuid})`;
    const doc = `${token}\n${LESSON_CAPTION_MARKER}Figure 1 — the three-dot button`;

    const found = [...doc.matchAll(pgAsJs)];
    assert.equal(found.length, 1, 'the caption line must not read as a second token');
    assert.equal(found[0][0], token, 'the token ends at its own closing paren');
    assert.equal(found[0][1], 'Google Form menu', 'alt is captured, the caption is not');
    assert.equal(found[0][2], uuid);
    assert.ok(!found[0][0].includes('Figure 1'));

    // And the module agrees, on the same string.
    assert.deepEqual(lessonAssetRefs(doc, 'markdown').map((r) => r.assetId), [uuid.toLowerCase()]);

    // The trigger must stay caption-blind: nothing in it may mention the marker.
    assert.ok(!/course_lesson_sync_assets[\s\S]{0,4000}?\^ /.test(exec),
      'the sync trigger must not learn about captions — that is the whole point');
  });

  test(`${label}: both parsers require a full uuid, not a loose 36 characters`, () => {
    assert.match(exec, /\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}/,
      'a [0-9a-f-]{36} class would accept 36 dashes and then fail the ::uuid cast');
  });

  // ── Bounds, built from the constants ──────────────────────────────────────

  test(`${label}: the bucket is private, capped and image-only, matching the module`, () => {
    assert.match(exec, new RegExp(`'${LESSON_ASSET_BUCKET}'`), 'bucket name drift');
    assert.match(exec, new RegExp(`values \\('${LESSON_ASSET_BUCKET}', '${LESSON_ASSET_BUCKET}', false, ${LESSON_IMAGE_MAX_BYTES}`),
      'the bucket must be created private and at exactly LESSON_IMAGE_MAX_BYTES — a client '
      + 'cap above the bucket makes the browser promise a size Storage will 413');
    // ★ EXACT, NOT "CONTAINS EACH OF". The first version of this checked that every
    //   LESSON_IMAGE_MIMES entry appeared and then tried to forbid SVG with an `||` that
    //   the presence of the word itself satisfied — so adding 'image/svg+xml' to the
    //   bucket passed. A mutation run caught it. SVG can carry script, and an allow-list
    //   is only a boundary if nothing may be added to it.
    const listed = /allowed_mime_types\)\s*\n?\s*values \('course-lesson-assets'[^)]*array\[([^\]]+)\]/s.exec(exec)
      || /array\[((?:'image\/[a-z+]+'(?:, )?)+)\]/.exec(exec);
    assert.ok(listed, "the bucket's allowed_mime_types array was not found");
    const mimes = listed[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(mimes, [...LESSON_IMAGE_MIMES],
      'the bucket must allow exactly the module\'s three image types — no more');
    assert.ok(!mimes.includes('image/svg+xml'),
      'SVG can carry script and is the one image format that is really a document');
  });

  test(`${label}: the row CHECKs mirror the module's size and type limits`, () => {
    assert.match(exec, new RegExp(`byte_size > 0 and byte_size <= ${LESSON_IMAGE_MAX_BYTES}`),
      'the row bound must equal LESSON_IMAGE_MAX_BYTES');
    assert.match(exec, new RegExp(`mime_type in \\('${LESSON_IMAGE_MIMES.join("', '")}'\\)`),
      'the mime CHECK must list exactly the module\'s mimes, in order');
  });

  test(`${label}: alt text is required and bounded at the module's limit`, () => {
    assert.match(exec, new RegExp(`length\\(btrim\\(alt_text\\)\\) between 1 and ${LESSON_IMAGE_ALT_MAX}`),
      'the alt CHECK must equal LESSON_IMAGE_ALT_MAX; "between 1" is what makes it required');
    assert.match(exec, /LESSON_ASSET_ALT_REQUIRED/,
      'the trigger must refuse an empty description rather than storing a blank one');
  });

  test(`${label}: the per-lesson image limit equals the module's`, () => {
    assert.match(exec, new RegExp(`array_length\\(v_seen, 1\\) > ${LESSON_IMAGE_MAX_PER_LESSON}`),
      'the trigger bound must equal LESSON_IMAGE_MAX_PER_LESSON');
  });

  test(`${label}: content_format accepts exactly the module's two formats`, () => {
    assert.match(exec, new RegExp(`content_format in \\('${LESSON_CONTENT_FORMATS.join("', '")}'\\)`));
    assert.match(exec, /add column if not exists content_format text not null default 'plain'/,
      "the default must be 'plain', or every existing lesson is reinterpreted as markdown");
  });

  // ── Authorization ─────────────────────────────────────────────────────────

  test(`${label}: reads mirror courses_read, including the sampler rule`, () => {
    const fn = exec.slice(exec.indexOf('function public.course_lesson_asset_readable'),
      exec.indexOf('course_lesson_asset_manageable'));
    assert.ok(fn.length > 100, 'course_lesson_asset_readable moved');
    for (const conjunct of ['c.published', 'public.is_approved()', 'public.is_enrolled()',
      'public.plan_is_sampler()', "c.slug like 'qbo-%'", "c.access_tier = 'essentials'"]) {
      assert.ok(fn.includes(conjunct),
        `${conjunct} is missing — drift from courses_read is a scoring bug in one direction `
        + 'and a disclosure bug in the other');
    }
    assert.match(fn, /(from|join) public\.course_lesson_asset_refs/,
      'the read must be REFERENCE-based; #44 deleted the path-parsing read that failed open');
    assert.ok(!/course_lesson_asset_course_id/.test(fn),
      'the read predicate must not parse the object path at all');
  });

  test(`${label}: the READ policy consults references and the WRITE policy parses the path`, () => {
    assert.match(exec, /course_lesson_assets_object_read[\s\S]{0,300}course_lesson_asset_object_readable\(name\)/,
      'reads must go through the reference predicate');
    assert.match(exec, /course_lesson_assets_object_write[\s\S]{0,300}can_manage_course\(public\.course_lesson_asset_course_id\(name\)\)/,
      'writes name an object that does not exist yet, so there is no reference to consult');
    assert.ok(!/course_lesson_assets_object_read[\s\S]{0,300}course_lesson_asset_course_id/.test(exec),
      'a path-parsed READ is exactly the #44 failure this feature is built to avoid');
  });

  test(`${label}: the new path parser is its OWN function and does not loosen #46's`, () => {
    assert.match(exec, /function public\.course_lesson_asset_course_id\(p_name text\)/);
    assert.ok(!/create or replace function public\.course_object_course_id/.test(exec),
      'course_object_course_id owns the three-segment VIDEO shape and must keep failing closed');
    // Four segments: lessons / course / lesson / file. The pattern is written across a ||
    // concatenation, so whitespace and the quoting between the halves are collapsed first.
    const flat = exec.replace(/\s+/g, ' ').replace(/'\s*\|\|\s*'/g, '');
    assert.match(flat, /\^lessons\/\[0-9a-f\]\{8\}[^']*?\/\[0-9a-f\]\{8\}[^']*?\/\[\^\/\]\+\$/,
      'the parser must require lessons/<uuid>/<uuid>/<file> exactly');
    const uuidRuns = (flat.match(/\[0-9a-f\]\{12\}/g) || []).length;
    assert.ok(uuidRuns >= 2, 'both the course and the lesson segment must be full uuids');
  });

  test(`${label}: an asset outlives its origin course, or duplicates break`, () => {
    assert.match(exec, /course_id\s+uuid references public\.courses\(id\) on delete set null/,
      'ON DELETE CASCADE would delete the row out from under a DUPLICATE that shows the '
      + 'same image — the very case the reference model exists to support');
    assert.ok(!/course_id\s+uuid not null references public\.courses\(id\) on delete cascade/.test(exec));
  });

  test(`${label}: an image may only be cited inside its own duplication family`, () => {
    assert.match(exec, /course_family_root/, 'the family rule must be enforced, not assumed');
    assert.match(exec, /LESSON_ASSET_UNKNOWN_REF/);
    assert.match(exec, /where up\.depth < 20/,
      'source_course_id is not constrained acyclic — the walk must be bounded');
  });

  // ── No client write path ──────────────────────────────────────────────────

  test(`${label}: neither table has any insert/update/delete policy`, () => {
    const policies = exec.match(/create policy [a-z_]+ on public\.course_lesson_asset[a-z_]*[\s\S]{0,80}?for (\w+)/g) || [];
    assert.ok(policies.length >= 2, 'the two SELECT policies are missing');
    for (const p of policies) {
      assert.match(p, /for select/,
        'a write policy here would let a direct PostgREST call skip the alt-text check, the '
        + 'image limit and the duplication-family rule — the finance zero-write-path rule');
    }
    assert.match(exec, /revoke all on public\.course_lesson_assets from anon, authenticated/);
    assert.match(exec, /revoke all on public\.course_lesson_asset_refs from anon, authenticated/);
    assert.match(exec, /grant select on public\.course_lesson_assets to authenticated/);
  });

  test(`${label}: the sync trigger is reachable ONLY as a trigger`, () => {
    assert.match(exec, /revoke all on function public\.course_lesson_sync_assets\(\) from public, anon, authenticated/,
      'a SECURITY DEFINER function with no argument surface must still not be callable');
    assert.match(exec, /after insert or update of text_content, content_format, course_id on public\.course_lessons/,
      'INSERT matters for course duplication; the column list keeps unrelated writes cheap; and '
      + 'course_id is in it because moving a lesson between courses changes which family its '
      + 'citations must belong to, and lessons_staff_write permits that write');
  });

  test(`${label}: a stranded image inherits the family of whatever still shows it`, () => {
    // Deleting a course leaves its images with course_id NULL so a DUPLICATE keeps working
    // (ON DELETE SET NULL). course_family_root(NULL) is NULL, so comparing it against the
    // lesson's root refused EVERY later save of exactly those lessons — a one-character
    // typo fix came back "refers to an image that does not exist", with the image still on
    // screen. Verified against the live schema before it was fixed.
    assert.match(exec, /select coalesce\(array_agg\(asset_id\), '\{\}'\) into v_prior/,
      'the prior citations must be captured BEFORE the refs are deleted');
    const capture = exec.indexOf('into v_prior');
    const wipe = exec.indexOf('delete from public.course_lesson_asset_refs where lesson_id = new.id');
    assert.ok(capture > 0 && capture < wipe,
      'capturing after the delete would lose the only evidence a re-save has');
    assert.match(exec, /if v_id = any\(v_prior\) then/, 'a re-save of the sole citing lesson must pass');
    assert.match(exec, /from public\.course_lesson_asset_refs r[\s\S]{0,200}join public\.course_lessons l[\s\S]{0,120}where r\.asset_id = v_id/,
      'and a duplicate being created from a lesson that still shows it must pass too');
    // The rule must still be closed: an asset nothing cites any more has no family.
    assert.match(exec, /if v_arootid is distinct from v_root then/);
    assert.ok(!/if v_arootid is null or v_arootid is distinct from v_root then/.test(exec),
      'the old conflation of "missing" with "stranded" is what caused the refusal');
  });

  test(`${label}: every function pins search_path and is revoked from anon`, () => {
    const fns = [...exec.matchAll(/create or replace function public\.(course_lesson_asset_\w+|course_family_root|course_lesson_sync_assets)\(/g)]
      .map((m) => m[1]);
    assert.ok(fns.length >= 8, `expected the #65 functions, found ${fns.length}`);
    for (const fn of new Set(fns)) {
      const at = exec.indexOf(`create or replace function public.${fn}(`);
      const body = exec.slice(at, at + 600);
      assert.match(body, /set search_path = public, pg_temp/, `${fn} does not pin search_path`);
      assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`).test(exec),
        `${fn} is not revoked from anon`);
    }
  });

  test(`${label}: RLS is enabled and never FORCED`, () => {
    assert.match(exec, /alter table public\.course_lesson_assets enable row level security/);
    assert.match(exec, /alter table public\.course_lesson_asset_refs enable row level security/);
    assert.ok(!/force row level security/.test(exec),
      'forcing RLS subjects the table OWNER to policies and breaks the sync trigger');
  });

  // ── The AI trainer ────────────────────────────────────────────────────────

  test(`${label}: the staleness trigger is PATCHED in place, never restated`, () => {
    assert.ok(!/create or replace function public\.course_ai_mark_lesson_stale/.test(exec),
      'retyping #27\'s body would silently revert any later fix to it — the #33/#34 failure mode');
    assert.match(exec, /pg_get_functiondef/, 'the #56 instrument reads whatever body is live');
    assert.match(exec, /new\.content_format is distinct from old\.content_format/,
      'without this a lesson converted to markdown never re-indexes and serves markdown '
      + 'syntax to the voice agent for ever');
    assert.match(exec, /if v_hits <> 1 then/,
      'the patch must assert its anchor appears exactly once before replacing it');
  });

  // ── Error codes ───────────────────────────────────────────────────────────

  test(`${label}: the catalog is restated whole and gains exactly the seven new codes`, () => {
    const at = exec.indexOf('create or replace function public.app_error_catalog()');
    assert.ok(at > 0, 'app_error_catalog() is not restated');
    const catalog = exec.slice(at, exec.indexOf('$cat$;', at));
    const codes = (catalog.match(/^ {4}\('([A-Z0-9_]+)',/gm) || [])
      .map((l) => l.replace(/^ {4}\('/, '').replace(/',$/, ''));
    assert.equal(codes.length, 119, 'the catalog is not 119 codes');
    const mine = codes.filter((c) => c.startsWith('LESSON_ASSET_'));
    assert.equal(mine.length, 7, 'expected exactly seven LESSON_ASSET_* codes');
    for (const c of codes) {
      assert.ok(APP_ERROR_CODES.includes(c),
        `${c} is raised by SQL but is not in APP_ERROR_CODES — clients branch on hint`);
    }
  });
}

// ── Client-side lockstep (asserted once, not per source) ────────────────────

test('every LESSON_ASSET_* code the SQL raises has client copy', () => {
  const raised = [...new Set((dated.match(/'(LESSON_ASSET_[A-Z_]+)'/g) || []).map((s) => s.slice(1, -1)))];
  assert.ok(raised.length >= 5, 'expected the RPCs and trigger to raise several codes');
  const copy = read('src/lib/appErrors.js');
  for (const c of raised) {
    assert.ok(APP_ERROR_CODES.includes(c), `${c} missing from APP_ERROR_CODES`);
    assert.match(copy, new RegExp(`\\n  ${c}:`), `${c} has no entry in APP_ERROR_COPY`);
  }
});

test('the frozen pre-#37b select never gained the new column', () => {
  const app = read('src/BookkeeperPro.jsx');
  const legacy = /const COURSE_LESSON_SELECT_LEGACY = '([^']+)'/.exec(app);
  assert.ok(legacy, 'COURSE_LESSON_SELECT_LEGACY moved');
  assert.ok(!legacy[1].includes('content_format'),
    'adding to the frozen list makes both selects identical, the retry re-fails, and the '
    + 'whole fallback silently stops working — its own comment says so');
  assert.ok(!legacy[1].includes('zoom_replay_url'), 'it is the PRE-#37b shape');

  const mid = /const COURSE_LESSON_SELECT_PRE_RICH = '([^']+)'/.exec(app);
  assert.ok(mid, 'the #65 fallback tier is missing');
  assert.ok(mid[1].includes('zoom_replay_url') && !mid[1].includes('content_format'),
    'the middle tier keeps replay links and drops only the new column');
  const full = /const COURSE_LESSON_SELECT = '([^']+)'/.exec(app);
  assert.ok(full[1].includes('content_format'), 'the full select must ask for it');
});

test('the AI trainer flattens lesson text instead of indexing markup', () => {
  const api = read('api/admin/course-trainer.js');
  assert.match(api, /import \{ lessonContentToPlainText \} from '\.\.\/\.\.\/src\/lib\/lessonContent\.js'/);
  assert.match(api, /lessonContentToPlainText\(l\.text_content, l\.content_format\)/,
    'the single ingest point must flatten; everything downstream copies the string verbatim');
  assert.ok(!/String\(l\.text_content \|\| ''\)\.trim\(\)/.test(api),
    'the raw-text read must be gone, not merely bypassed');
  assert.match(api, /select\('id,title,text_content,content_format'\)/);
  assert.match(api, /code === '42703'/,
    'a database missing the column must read as not-migrated, not as a 500');
});

test('the learner renderer never injects HTML', () => {
  const app = read('src/BookkeeperPro.jsx');
  const at = app.indexOf('function LessonRichText(');
  assert.ok(at > 0, 'LessonRichText moved');
  const body = jsCode(app.slice(at, app.indexOf('\nfunction ', at + 10)));
  assert.ok(!/dangerouslySetInnerHTML/.test(body),
    'the whole point of the closed token set is that markup cannot be structure');
  assert.match(body, /target: '_blank'|target="_blank"/,
    'an external link must open in a new tab');
  assert.match(body, /rel="noopener noreferrer"|rel: 'noopener noreferrer'/);

  // The <img> lives in LessonImage, which LessonRichText delegates every image to.
  const imgAt = app.indexOf('function LessonImage(');
  assert.ok(imgAt > 0, 'LessonImage moved');
  const img = jsCode(app.slice(imgAt, app.indexOf('\nfunction ', imgAt + 10)));
  assert.ok(!/dangerouslySetInnerHTML/.test(img));
  assert.match(img, /loading="lazy"/, 'a lesson may carry ten images');
  assert.match(img, /onError=\{\(\) => setFailed\(true\)\}/,
    'a student who cannot load a screenshot must be told in words, not shown a broken icon');
  // ★ THE ALT TEXT, NOT THE CAPTION. These are two different strings on the same figure:
  //   `label` is the required description a screen reader announces and the fallback
  //   shows; `caption` is optional visible prose. The unavailable state must carry the
  //   DESCRIPTION, so it reads the same variable the <img alt> does — pinned together
  //   here, because wiring the caption into either one makes a screen reader say the same
  //   sentence twice and loses the description entirely when there is no caption.
  const altVar = /alt=\{(\w+)\}/.exec(img);
  assert.ok(altVar, 'LessonImage no longer sets alt from a single variable');
  assert.notEqual(altVar[1], 'caption', 'the caption must never be used as the alt text');
  assert.match(img, new RegExp(`role="img" aria-label=\\{\`Image unavailable: \\$\\{${altVar[1]}\\}\`\\}`),
    'and the unavailable state must still carry the description');
  assert.match(img, new RegExp(`const ${altVar[1]} = alt \\|\\| 'Image'`),
    'the description is the alt prop, with a fallback — never the caption');
  assert.match(img, /\{caption && \(?\s*<figcaption/,
    'a caption renders as a figcaption, and only when there is one');
});
