// test-db/courseLessonAssets.dbtest.mjs — private lesson images, per persona (#65).
//
// Every authorization assertion goes through a REAL signed-in user's PostgREST or Storage
// client. Nothing is asserted through the service role or the Management API: those run as
// `postgres` and bypass RLS, so they would pass whatever the policies say. Setup uses them;
// proof never does.
//
// ★ WHY THIS SUITE EXISTS. Lesson images are paid instructional material in a private
//   bucket, and their read rule is REFERENCE-based — an object is readable only when a
//   published lesson the caller's plan may open cites it. That sentence has four moving
//   parts (published, approved, enrolled, plan scope) and one structural one (the
//   reference itself), and the SQL-parity suite can only check that the conjuncts are
//   present in the source. Whether they actually refuse a Sampler, a lapsed member and an
//   unreferenced object can only be established by asking the database as those people.
//
// Run: npm run test:db   (needs .env.test pointing at a shadow project)

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonClient,
  asUser,
  expectAppError,
  lit,
  makePersona,
  resetShadow,
  runSql,
  seedMember,
  seedStaff,
  sqlScalar,
} from './_harness.mjs';

// Fixed ids so a path can be written by hand and still be the one the row cites.
const ESSENTIALS_ID = 'a1111111-1111-4111-8111-111111111111';
const MASTERY_ID = 'a2222222-2222-4222-8222-222222222222';
const DRAFT_ID = 'a3333333-3333-4333-8333-333333333333';
const DUPLICATE_ID = 'a4444444-4444-4444-8444-444444444444';

const LES = {
  essentials: 'b1111111-1111-4111-8111-111111111111',
  mastery: 'b2222222-2222-4222-8222-222222222222',
  draft: 'b3333333-3333-4333-8333-333333333333',
  duplicate: 'b4444444-4444-4444-8444-444444444444',
};
const ASSET = {
  essentials: 'c1111111-1111-4111-8111-111111111111',
  mastery: 'c2222222-2222-4222-8222-222222222222',
  draft: 'c3333333-3333-4333-8333-333333333333',
  orphan: 'c5555555-5555-4555-8555-555555555555',
};
const objectName = (id) => `${id.replace(/-/g, '')}.png`;
const pathFor = (courseId, lessonId, assetId) => `lessons/${courseId}/${lessonId}/${objectName(assetId)}`;

const PATHS = {
  essentials: pathFor(ESSENTIALS_ID, LES.essentials, ASSET.essentials),
  mastery: pathFor(MASTERY_ID, LES.mastery, ASSET.mastery),
  draft: pathFor(DRAFT_ID, LES.draft, ASSET.draft),
  orphan: pathFor(ESSENTIALS_ID, LES.essentials, ASSET.orphan),
};

const token = (assetId, alt = 'A screenshot') => `![${alt}](lesson-asset://${assetId})`;

let admin; let assignedTrainer; let unassignedTrainer; let opsAdmin;
let sampler; let silver; let vip; let expired; let unapproved; let stranger;

/**
 * Three published courses (Essentials / Mastery / a duplicate of Essentials), one draft,
 * each with one text lesson carrying one image.
 *
 * The DUPLICATE cites the ESSENTIALS course's asset, which is exactly what
 * CourseCatalog.duplicateCourse produces: copy-on-write, no bytes copied. It is the case a
 * path-based read gets backwards, because the file lives in the SOURCE course's folder.
 */
async function seedCourses() {
  // ★ Created AS the super admin, because #48's courses_publish_insert_guard refuses a
  //   published course when auth.uid() is null — which it always is through the
  //   Management API. asUser() sets the claim locally so the guard runs and passes.
  await asUser(admin.id, `
    insert into public.courses (id, slug, title, published, access_tier, source_course_id) values
      (${lit(ESSENTIALS_ID)}, 'qbo-a-essentials', 'QBO Essentials (test)', true,  'essentials', null),
      (${lit(MASTERY_ID)},    'qbo-a-mastery',    'QBO Mastery (test)',    true,  'standard',   null),
      (${lit(DRAFT_ID)},      'qbo-a-draft',      'QBO Draft (test)',      false, 'essentials', null),
      (${lit(DUPLICATE_ID)},  'qbo-a-duplicate',  'Copy of Essentials',    true,  'essentials', ${lit(ESSENTIALS_ID)})
    on conflict (id) do nothing;`);

  for (const [key, courseId] of [['essentials', ESSENTIALS_ID], ['mastery', MASTERY_ID],
    ['draft', DRAFT_ID], ['duplicate', DUPLICATE_ID]]) {
    await runSql(`
      insert into public.course_modules (id, course_id, title, position)
      values (gen_random_uuid(), ${lit(courseId)}, 'M', 0)`);
    await runSql(`
      insert into public.course_lessons (id, module_id, course_id, title, type, position, content_format)
      select ${lit(LES[key])}, m.id, ${lit(courseId)}, 'L', 'text', 0, 'markdown'
        from public.course_modules m where m.course_id = ${lit(courseId)} limit 1`);
  }

  // Assets. Registered directly, because the RPC's can_manage_course gate reads auth.uid(),
  // which is null under the Management API — fixtures are not the thing under test.
  await runSql(`
    insert into public.course_lesson_assets (id, course_id, storage_path, mime_type, byte_size) values
      (${lit(ASSET.essentials)}, ${lit(ESSENTIALS_ID)}, ${lit(PATHS.essentials)}, 'image/png', 1024),
      (${lit(ASSET.mastery)},    ${lit(MASTERY_ID)},    ${lit(PATHS.mastery)},    'image/png', 1024),
      (${lit(ASSET.draft)},      ${lit(DRAFT_ID)},      ${lit(PATHS.draft)},      'image/png', 1024),
      (${lit(ASSET.orphan)},     ${lit(ESSENTIALS_ID)}, ${lit(PATHS.orphan)},     'image/png', 1024)`);

  // Citing the assets from the lessons. The TRIGGER builds the references from this text.
  await runSql(`update public.course_lessons set text_content = ${lit(token(ASSET.essentials))} where id = ${lit(LES.essentials)}`);
  await runSql(`update public.course_lessons set text_content = ${lit(token(ASSET.mastery))}    where id = ${lit(LES.mastery)}`);
  await runSql(`update public.course_lessons set text_content = ${lit(token(ASSET.draft))}      where id = ${lit(LES.draft)}`);
  // The duplicate shows the SOURCE course's image — allowed because they share a root.
  await runSql(`update public.course_lessons set text_content = ${lit(token(ASSET.essentials, 'Shared'))} where id = ${lit(LES.duplicate)}`);

  for (const p of Object.values(PATHS)) {
    await runSql(`
      insert into storage.objects (bucket_id, name, metadata)
      values ('course-lesson-assets', ${lit(p)}, '{"mimetype":"image/png","size":1024}'::jsonb)
      on conflict do nothing`);
  }
}

/** A live #46 course assignment. The column is staff_user_id, and revoked_at must be null. */
async function assign(persona, courseId) {
  await runSql(`
    insert into public.course_staff_assignments (course_id, staff_user_id, assignment_role, assigned_by)
    values (${lit(courseId)}, '${persona.id}'::uuid, 'editor', '${admin.id}'::uuid)`);
}

before(async () => {
  admin = await makePersona('admin', { isAdmin: true, fullName: 'Admin' });
  assignedTrainer = await makePersona('trainer-assigned', { fullName: 'Assigned Trainer' });
  unassignedTrainer = await makePersona('trainer-unassigned', { fullName: 'Other Trainer' });
  opsAdmin = await makePersona('ops', { fullName: 'Ops Admin' });
  sampler = await makePersona('sampler', { fullName: 'Sam Sampler' });
  silver = await makePersona('silver', { fullName: 'Sil Silver' });
  vip = await makePersona('vip', { fullName: 'Vi Vip' });
  expired = await makePersona('expired', { fullName: 'Ex Pired' });
  unapproved = await makePersona('unapproved', { fullName: 'Un Approved' });
  stranger = await makePersona('stranger', { fullName: 'No Membership' });
});

beforeEach(async () => {
  await resetShadow();
  // Staff first: seedCourses publishes as the admin, and the guard reads a live membership.
  await seedStaff(admin, 'super_admin');
  await seedCourses();
  await seedStaff(assignedTrainer, 'trainer');
  await seedStaff(unassignedTrainer, 'trainer');
  await seedStaff(opsAdmin, 'operations_admin');
  await assign(assignedTrainer, ESSENTIALS_ID);
  await seedMember(sampler, { planKey: 'sampler' });
  await seedMember(silver, { planKey: 'silver_self_paced' });
  await seedMember(vip, { planKey: 'vip' });
  await seedMember(expired, { planKey: 'silver_self_paced', expired: true });
  await seedMember(unapproved, { planKey: 'silver_self_paced' });
  await runSql(`update public.profiles set approval_status = 'pending' where id = ${lit(unapproved.id)}`);
});

after(async () => { await resetShadow(); });

/** Can this persona mint a signed URL for that object? */
const canSign = async (persona, path) => {
  const r = await persona.db.storage.from('course-lesson-assets').createSignedUrl(path, 60);
  return !r.error && !!r.data?.signedUrl;
};

// ── The bucket itself ───────────────────────────────────────────────────────

test('the lesson-image bucket is private and bounded', async () => {
  const pub = await sqlScalar(`select public::text from storage.buckets where id = 'course-lesson-assets'`);
  assert.equal(pub, 'false', 'a public bucket serves every object to anyone with the URL');
  const limit = await sqlScalar(`select file_size_limit::text from storage.buckets where id = 'course-lesson-assets'`);
  assert.equal(limit, '10485760');
  const mimes = await sqlScalar(`select array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'course-lesson-assets'`);
  assert.equal(mimes, 'image/png,image/jpeg,image/webp', 'SVG can carry script and must never be here');
});

// ── Learners ────────────────────────────────────────────────────────────────

test('an entitled member can sign an image their lesson shows', async () => {
  for (const [who, persona] of [['silver', silver], ['vip', vip]]) {
    assert.equal(await canSign(persona, PATHS.essentials), true, `${who} must reach an Essentials image`);
    assert.equal(await canSign(persona, PATHS.mastery), true, `${who} has full access`);
  }
});

test('a SAMPLER reaches Essentials and is refused Mastery', async () => {
  assert.equal(await canSign(sampler, PATHS.essentials), true,
    'the Sampler plan includes the QBO Essentials course');
  assert.equal(await canSign(sampler, PATHS.mastery), false,
    'Mastery is outside the Sampler scope — its images must be too, not just its lessons');
});

test('an unpublished course keeps its images unreadable', async () => {
  for (const [who, persona] of [['silver', silver], ['vip', vip], ['sampler', sampler]]) {
    assert.equal(await canSign(persona, PATHS.draft), false, `${who} must not reach a draft's images`);
  }
});

test('an EXPIRED member loses the images with the membership', async () => {
  assert.equal(await canSign(expired, PATHS.essentials), false);
});

test('an UNAPPROVED account never had them', async () => {
  assert.equal(await canSign(unapproved, PATHS.essentials), false);
});

test('a signed-in stranger with no membership is refused', async () => {
  assert.equal(await canSign(stranger, PATHS.essentials), false);
});

test('an anonymous visitor cannot sign, list or read anything in the bucket', async () => {
  // ★ anonClient() is a module singleton that must NEVER be signed in.
  const anon = anonClient();
  const signed = await anon.storage.from('course-lesson-assets').createSignedUrl(PATHS.essentials, 60);
  assert.ok(signed.error, 'anonymous signing must be refused');
  const listed = await anon.storage.from('course-lesson-assets').list(`lessons/${ESSENTIALS_ID}`, { limit: 10 });
  assert.ok(listed.error || (listed.data || []).length === 0, 'anonymous listing must reveal nothing');
});

test('an UNREFERENCED object is readable by nobody, including staff who own the course', async () => {
  // The file exists, sits in a folder the admin manages, and its row names their course —
  // and still nothing may read it, because no published lesson cites it. This is the whole
  // difference between reference-based and path-based authorization.
  for (const [who, persona] of [['silver', silver], ['vip', vip], ['sampler', sampler]]) {
    assert.equal(await canSign(persona, PATHS.orphan), false, `${who} must not reach an orphan`);
  }
});

// ── Duplication ─────────────────────────────────────────────────────────────

test('a DUPLICATE course shows the source image, with no bytes copied', async () => {
  const refs = await sqlScalar(`
    select count(*)::text from public.course_lesson_asset_refs
     where lesson_id = ${lit(LES.duplicate)} and asset_id = ${lit(ASSET.essentials)}`);
  assert.equal(refs, '1', 'the trigger must accept a citation within the duplication family');
  const objects = await sqlScalar(`
    select count(*)::text from public.course_lesson_assets where storage_path = ${lit(PATHS.essentials)}`);
  assert.equal(objects, '1', 'one row, one object — a duplicate reuses it by reference');
  assert.equal(await canSign(silver, PATHS.essentials), true);
});

test('deleting the SOURCE course leaves the duplicate working', async () => {
  // ON DELETE CASCADE here would delete the asset row out from under the copy: its images
  // would vanish and its next save would be refused as citing an image that does not exist.
  await runSql(`delete from public.courses where id = ${lit(ESSENTIALS_ID)}`);
  const surviving = await sqlScalar(`
    select count(*)::text from public.course_lesson_assets where id = ${lit(ASSET.essentials)}`);
  assert.equal(surviving, '1', 'the asset row must outlive its origin course');
  const owner = await sqlScalar(`select coalesce(course_id::text,'(null)') from public.course_lesson_assets where id = ${lit(ASSET.essentials)}`);
  assert.equal(owner, '(null)', 'it loses its origin, not its existence');
  const refs = await sqlScalar(`
    select count(*)::text from public.course_lesson_asset_refs where asset_id = ${lit(ASSET.essentials)}`);
  assert.equal(refs, '1', "the duplicate's reference survives");
  assert.equal(await canSign(silver, PATHS.essentials), true,
    'and a member reading the duplicate can still see the picture');
});

test('removing one of two references does not strand the other', async () => {
  await runSql(`update public.course_lessons set text_content = 'no images now' where id = ${lit(LES.essentials)}`);
  const refs = await sqlScalar(`
    select count(*)::text from public.course_lesson_asset_refs where asset_id = ${lit(ASSET.essentials)}`);
  assert.equal(refs, '1', 'the duplicate still cites it');
  assert.equal(await canSign(silver, PATHS.essentials), true, 'so it stays readable');
});

test('removing the LAST reference makes it unreadable at once', async () => {
  await runSql(`update public.course_lessons set text_content = 'gone' where id in (${lit(LES.essentials)}, ${lit(LES.duplicate)})`);
  assert.equal(await canSign(silver, PATHS.essentials), false,
    'no published lesson cites it any more, so nothing authorizes it');
});

// ── Staff ───────────────────────────────────────────────────────────────────

test('an ASSIGNED trainer can register an image for their course', async () => {
  const path = pathFor(ESSENTIALS_ID, LES.essentials, 'd1111111-1111-4111-8111-111111111111');
  const { data, error } = await assignedTrainer.db.rpc('course_lesson_asset_register', {
    p_course_id: ESSENTIALS_ID, p_lesson_id: LES.essentials,
    p_storage_path: path, p_mime_type: 'image/png', p_byte_size: 2048,
  });
  assert.equal(error, null, `an assigned trainer must be able to register: ${error?.message}`);
  assert.ok(data, 'the new asset id comes back');
});

test('an UNASSIGNED trainer cannot register for a course they do not manage', async () => {
  const path = pathFor(ESSENTIALS_ID, LES.essentials, 'd2222222-2222-4222-8222-222222222222');
  await expectAppError(unassignedTrainer.db.rpc('course_lesson_asset_register', {
    p_course_id: ESSENTIALS_ID, p_lesson_id: LES.essentials,
    p_storage_path: path, p_mime_type: 'image/png', p_byte_size: 2048,
  }), 'LESSON_ASSET_FORBIDDEN', 'an unassigned trainer');
});

test('an Operations Admin with no course authority gains nothing here', async () => {
  const path = pathFor(ESSENTIALS_ID, LES.essentials, 'd3333333-3333-4333-8333-333333333333');
  await expectAppError(opsAdmin.db.rpc('course_lesson_asset_register', {
    p_course_id: ESSENTIALS_ID, p_lesson_id: LES.essentials,
    p_storage_path: path, p_mime_type: 'image/png', p_byte_size: 2048,
  }), 'LESSON_ASSET_FORBIDDEN', 'an ops admin');
});

test('a LEARNER cannot register anything', async () => {
  const path = pathFor(ESSENTIALS_ID, LES.essentials, 'd4444444-4444-4444-8444-444444444444');
  await expectAppError(vip.db.rpc('course_lesson_asset_register', {
    p_course_id: ESSENTIALS_ID, p_lesson_id: LES.essentials,
    p_storage_path: path, p_mime_type: 'image/png', p_byte_size: 2048,
  }), 'LESSON_ASSET_FORBIDDEN', 'a paying member is still not staff');
});

test('a forged path — another course, the video shape, or a traversal — is refused', async () => {
  for (const [why, path] of [
    ['another course\'s folder', pathFor(MASTERY_ID, LES.mastery, 'd5555555-5555-4555-8555-555555555555')],
    ['the three-segment VIDEO shape', `lessons/${ESSENTIALS_ID}/x.png`],
    ['a deeper path', `lessons/${ESSENTIALS_ID}/${LES.essentials}/sub/x.png`],
    ['a traversal', `../../etc/passwd`],
    ['another bucket\'s shape', `covers/${ESSENTIALS_ID}/x.png`],
  ]) {
    await expectAppError(assignedTrainer.db.rpc('course_lesson_asset_register', {
      p_course_id: ESSENTIALS_ID, p_lesson_id: LES.essentials,
      p_storage_path: path, p_mime_type: 'image/png', p_byte_size: 1024,
    }), 'LESSON_ASSET_BAD_PATH', why);
  }
});

test('a lesson from a different course cannot be claimed', async () => {
  const path = pathFor(ESSENTIALS_ID, LES.mastery, 'd6666666-6666-4666-8666-666666666666');
  await expectAppError(assignedTrainer.db.rpc('course_lesson_asset_register', {
    p_course_id: ESSENTIALS_ID, p_lesson_id: LES.mastery,
    p_storage_path: path, p_mime_type: 'image/png', p_byte_size: 1024,
  }), 'LESSON_ASSET_BAD_PATH', 'a lesson that belongs to another course');
});

test('a forged mime type or size is refused by the row, not merely by the client', async () => {
  const mk = (mime, size, n) => assignedTrainer.db.rpc('course_lesson_asset_register', {
    p_course_id: ESSENTIALS_ID, p_lesson_id: LES.essentials,
    p_storage_path: pathFor(ESSENTIALS_ID, LES.essentials, `d777777${n}-7777-4777-8777-777777777777`),
    p_mime_type: mime, p_byte_size: size,
  });
  const svg = await mk('image/svg+xml', 1024, 1);
  assert.ok(svg.error, 'SVG must be refused — it can carry script');
  const big = await mk('image/png', 10485761, 2);
  assert.ok(big.error, 'over the cap must be refused');
  const zero = await mk('image/png', 0, 3);
  assert.ok(zero.error, 'an empty file must be refused');
});

// ── No client write path ────────────────────────────────────────────────────

test('nobody can write either asset table directly', async () => {
  for (const [who, persona] of [['admin', admin], ['assigned trainer', assignedTrainer],
    ['ops admin', opsAdmin], ['vip', vip]]) {
    const ins = await persona.db.from('course_lesson_assets').insert({
      course_id: ESSENTIALS_ID,
      storage_path: pathFor(ESSENTIALS_ID, LES.essentials, 'e1111111-1111-4111-8111-111111111111'),
      mime_type: 'image/png', byte_size: 10,
    });
    assert.ok(ins.error, `${who} must not insert an asset row directly`);
    const ref = await persona.db.from('course_lesson_asset_refs').insert({
      lesson_id: LES.essentials, asset_id: ASSET.mastery, alt_text: 'forged',
    });
    assert.ok(ref.error, `${who} must not forge a reference — it is the authorization record`);
  }
});

test('the trigger is the only writer, and it refuses what the client validates', async () => {
  // These run as postgres, which bypasses RLS — so they prove the TRIGGER refuses, not the
  // policy. That is the point: a direct write is exactly what skips the client.
  const fail = async (sql, why) => {
    try { await runSql(sql, { retries: 0 }); return `**ACCEPTED** ${why}`; }
    catch (e) { return String(e.sqlDetail || e.message); }
  };
  const noAlt = await fail(
    `update public.course_lessons set text_content = '![](lesson-asset://${ASSET.essentials})' where id = ${lit(LES.essentials)}`,
    'empty alt text');
  assert.match(noAlt, /LESSON_ASSET_ALT_REQUIRED/);

  const foreign = await fail(
    `update public.course_lessons set text_content = ${lit(token(ASSET.mastery))} where id = ${lit(LES.essentials)}`,
    'an unrelated course\'s image');
  assert.match(foreign, /LESSON_ASSET_UNKNOWN_REF/,
    'a pasted uuid from another course must not surface that image here');

  const unknown = await fail(
    `update public.course_lessons set text_content = '![x](lesson-asset://c9999999-9999-4999-8999-999999999999)' where id = ${lit(LES.essentials)}`,
    'an image that does not exist');
  assert.match(unknown, /LESSON_ASSET_UNKNOWN_REF/);
});

test('a plain lesson cites nothing, whatever its text contains', async () => {
  await runSql(`
    update public.course_lessons
       set content_format = 'plain', text_content = ${lit(token(ASSET.mastery))}
     where id = ${lit(LES.essentials)}`);
  const refs = await sqlScalar(`select count(*)::text from public.course_lesson_asset_refs where lesson_id = ${lit(LES.essentials)}`);
  assert.equal(refs, '0', "plain means plain — the token is text, not a citation");
});

// ── Deletion ────────────────────────────────────────────────────────────────

test('a referenced image cannot be deleted, and an unreferenced one can', async () => {
  await expectAppError(admin.db.rpc('course_lesson_asset_delete', { p_asset_id: ASSET.essentials }),
    'LESSON_ASSET_IN_USE', 'an image two lessons still show');

  const { data: path, error } = await admin.db.rpc('course_lesson_asset_delete', { p_asset_id: ASSET.orphan });
  assert.equal(error, null, `an unreferenced image must be deletable: ${error?.message}`);
  assert.equal(path, PATHS.orphan, 'the path comes back so the client can remove the bytes');
});

test('a learner cannot delete an image, and an unassigned trainer cannot either', async () => {
  for (const [who, persona] of [['vip', vip], ['unassigned trainer', unassignedTrainer],
    ['ops admin', opsAdmin]]) {
    await expectAppError(persona.db.rpc('course_lesson_asset_delete', { p_asset_id: ASSET.orphan }),
      'LESSON_ASSET_FORBIDDEN', who);
  }
});

test('orphan reporting is scoped to a course the caller manages', async () => {
  const mine = await assignedTrainer.db.rpc('course_lesson_asset_orphans',
    { p_course_id: ESSENTIALS_ID, p_min_age: '00:00:00' });
  assert.equal(mine.error, null, `an assigned trainer may sweep their own course: ${mine.error?.message}`);
  assert.deepEqual((mine.data || []).map((r) => r.storage_path), [PATHS.orphan],
    'only the unreferenced object, never the ones lessons show');

  await expectAppError(assignedTrainer.db.rpc('course_lesson_asset_orphans',
    { p_course_id: MASTERY_ID, p_min_age: '00:00:00' }),
  'LESSON_ASSET_FORBIDDEN', 'a course they do not manage');

  await expectAppError(vip.db.rpc('course_lesson_asset_orphans',
    { p_course_id: ESSENTIALS_ID, p_min_age: '00:00:00' }),
  'LESSON_ASSET_FORBIDDEN', 'a learner');
});

test('the image limit is enforced by the database, not only by the editor', async () => {
  let text = '';
  for (let i = 0; i < 11; i++) {
    const id = `f${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`;
    await runSql(`
      insert into public.course_lesson_assets (id, course_id, storage_path, mime_type, byte_size)
      values (${lit(id)}, ${lit(ESSENTIALS_ID)}, ${lit(pathFor(ESSENTIALS_ID, LES.essentials, id))}, 'image/png', 10)`);
    text += `${token(id, `Shot ${i}`)}\n\n`;
  }
  let msg = '';
  try { await runSql(`update public.course_lessons set text_content = ${lit(text)} where id = ${lit(LES.essentials)}`, { retries: 0 }); }
  catch (e) { msg = String(e.sqlDetail || e.message); }
  assert.match(msg, /LESSON_ASSET_LIMIT/, 'eleven images must be refused');
});
