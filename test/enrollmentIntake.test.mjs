// test/enrollmentIntake.test.mjs — the enrollment intake form's field registry + validation (#42).
//
// This suite exists because of a specific defect in the Google Apps Script this form
// replaces: `resumeFile` was rendered with a label and a drop zone but carried no
// `required` attribute, so it was displayed-but-unvalidated and nobody noticed. The
// structural tests below ("every required field rejects blank", "every field is
// reachable from a section") make that class of bug impossible to reintroduce —
// rendering and validation both read INTAKE_FIELDS, so a field cannot exist in one
// and not the other.
//
// Assertions target stable field KEYS and the `ok`/`firstInvalid` shape, never the
// message prose, so copy can be reworded without touching this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTAKE_FIELDS,
  INTAKE_SECTIONS,
  EXPERIENCE_OPTIONS,
  EMPLOYED_OPTIONS,
  parseAmountPaid,
  normalizePhone,
  normalizeFacebook,
  validateIntake,
  blankIntake,
  fileTypeAllowed,
  intakeField,
  contentTypeFor,
  intakeValuesFromRequest,
} from '../src/lib/enrollmentIntake.js';

// A plan row shaped like public.enrollment_plans.
const VIP = { key: 'vip', name: 'Personalized Coaching Program', price_php: 16999, access_days: 180 };

// Every text answer filled with something a real student might type.
const FILLED = Object.freeze({
  fullName: 'Juan dela Cruz',
  email: 'juan@example.com',
  cellphone: '0917-555-0101',
  cityCountry: 'Manila, Philippines',
  collegeCourse: 'BS Accountancy',
  currentJob: 'Audit Associate',
  phExperience: '2-5 years',
  usExperience: 'None',
  currentlyEmployed: 'YES',
  priorTraining: 'No',
  amountPaid: '16999',
  referredBy: 'Facebook ad',
  facebookLink: 'facebook.com/juandelacruz',
  struggles: '1. No US experience\n2. Resume gets ignored\n3. Interview nerves',
});

// The non-text gates the form also has to satisfy.
const SATISFIED = Object.freeze({
  plan: VIP,
  needsBatch: false,
  batchId: null,
  hasReceipt: true,
  hasSignature: true,
  agreed: true,
});

const ok = (over = {}, ctx = {}) => validateIntake({ ...FILLED, ...over }, { ...SATISFIED, ...ctx });

// ── The registry is the contract ─────────────────────────────────────────────

test('every field belongs to a declared section', () => {
  const sections = new Set(INTAKE_SECTIONS.map(s => s.key));
  for (const f of INTAKE_FIELDS) {
    assert.ok(sections.has(f.section), `${f.key} is in section "${f.section}", which no section declares — it would render nowhere`);
  }
});

test('field keys are unique', () => {
  const keys = INTAKE_FIELDS.map(f => f.key);
  assert.equal(new Set(keys).size, keys.length, 'a duplicate key would make one field silently overwrite the other');
});

test('every field carries a label and a type', () => {
  for (const f of INTAKE_FIELDS) {
    assert.ok(f.label && typeof f.label === 'string', `${f.key} needs a label to render`);
    assert.ok(f.type && typeof f.type === 'string', `${f.key} needs a type to pick an input`);
  }
});

test('choice fields declare their options and text fields do not', () => {
  for (const f of INTAKE_FIELDS) {
    if (f.type === 'choice') {
      assert.ok(Array.isArray(f.options) && f.options.length > 0, `${f.key} is a choice field with no options`);
    } else {
      assert.equal(f.options, undefined, `${f.key} is not a choice field but declares options`);
    }
  }
});

// ── The headline requirement: nothing blank gets through ─────────────────────

test('a completely empty form is rejected and names every required field', () => {
  const r = validateIntake(blankIntake(), { ...SATISFIED, hasReceipt: false, hasSignature: false, agreed: false });
  assert.equal(r.ok, false);
  const required = INTAKE_FIELDS.filter(f => f.required).map(f => f.key);
  assert.equal(required.length, 15, 'every field but the resume is required — a drop here would weaken this sweep silently');
  for (const key of required) {
    assert.ok(r.errors[key], `${key} is required but an empty form produced no error for it`);
  }
});

test('each required text field on its own blocks submission', () => {
  // The Apps Script only ever checked five things; this walks all of them.
  for (const f of INTAKE_FIELDS) {
    if (!f.required || f.type === 'file') continue;
    const r = ok({ [f.key]: '' });
    assert.equal(r.ok, false, `blanking ${f.key} must block the submit`);
    assert.ok(r.errors[f.key], `blanking ${f.key} must flag ${f.key} specifically`);
  }
});

test('whitespace is not an answer', () => {
  for (const raw of ['   ', '\t', '\n\n']) {
    const r = ok({ fullName: raw });
    assert.equal(r.ok, false, `${JSON.stringify(raw)} is blank, not a name`);
    assert.ok(r.errors.fullName);
  }
});

test('a fully completed form passes with no errors', () => {
  const r = ok();
  assert.equal(r.ok, true, `expected a clean pass, got: ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.errors, {});
  assert.equal(r.firstInvalid, null);
});

test('firstInvalid follows registry order so focus lands on the topmost problem', () => {
  const r = ok({ fullName: '', struggles: '' });
  assert.equal(r.firstInvalid, 'fullName', 'fullName is above struggles in the form');

  const later = ok({ struggles: '' });
  assert.equal(later.firstInvalid, 'struggles', 'with only one problem, that is where focus goes');
});

// ── The one optional field ───────────────────────────────────────────────────

test('resume is the only field a student may skip', () => {
  const optional = INTAKE_FIELDS.filter(f => !f.required).map(f => f.key);
  assert.deepEqual(optional, ['resumeFile'],
    'the decision on record is that resume stays optional and everything else is mandatory');
});

test('omitting the resume does not block submission', () => {
  const r = validateIntake({ ...FILLED, resumeFile: null }, SATISFIED);
  assert.equal(r.ok, true, 'resume is optional — its absence is not an error');
  assert.equal(r.errors.resumeFile, undefined);
});

// ── Choice fields reject anything off-menu ───────────────────────────────────

test('experience answers must come from the published option list', () => {
  for (const key of ['phExperience', 'usExperience']) {
    const r = ok({ [key]: '3 years-ish' });
    assert.equal(r.ok, false, `${key} must not accept free text — the values are compared across cohorts`);
    assert.ok(r.errors[key]);
  }
});

test('every published experience option is accepted', () => {
  for (const opt of EXPERIENCE_OPTIONS) {
    assert.equal(ok({ phExperience: opt }).ok, true, `"${opt}" is on the menu and must validate`);
  }
});

test('employment answer must be YES or NO', () => {
  for (const opt of EMPLOYED_OPTIONS) {
    assert.equal(ok({ currentlyEmployed: opt }).ok, true, `"${opt}" is on the menu`);
  }
  assert.equal(ok({ currentlyEmployed: 'Maybe' }).ok, false);
  assert.equal(ok({ currentlyEmployed: 'yes' }).ok, false, 'casing is part of the stored value');
});

// ── Email ────────────────────────────────────────────────────────────────────

test('an unparseable email is rejected', () => {
  for (const bad of ['juan', 'juan@', '@example.com', 'juan @example.com']) {
    const r = ok({ email: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} is not a usable address`);
    assert.ok(r.errors.email);
  }
});

// ── Amount paid ──────────────────────────────────────────────────────────────

test('parseAmountPaid reads the peso formatting students actually type', () => {
  assert.equal(parseAmountPaid('₱16,999'), 16999);
  assert.equal(parseAmountPaid('16999'), 16999);
  assert.equal(parseAmountPaid('16,999.50'), 16999.5);
  assert.equal(parseAmountPaid('  ₱ 2,999  '), 2999);
  assert.equal(parseAmountPaid('PHP 1499'), 1499);
});

test('parseAmountPaid returns null for anything that is not a number', () => {
  for (const raw of ['', '   ', null, undefined, 'paid via gcash', '₱']) {
    assert.equal(parseAmountPaid(raw), null, `${JSON.stringify(raw)} carries no amount`);
  }
});

test('a zero or negative amount is rejected', () => {
  for (const raw of ['0', '₱0', '-500']) {
    const r = ok({ amountPaid: raw });
    assert.equal(r.ok, false, `${raw} is not a payment`);
    assert.ok(r.errors.amountPaid);
  }
});

test('an unreadable amount is flagged on the amount field', () => {
  const r = ok({ amountPaid: 'sent via gcash' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.amountPaid);
});

// ── The gates that are not text inputs ───────────────────────────────────────

test('a missing payment screenshot blocks submission', () => {
  const r = ok({}, { hasReceipt: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.paymentFile);
});

test('an unsigned agreement blocks submission', () => {
  const r = ok({}, { hasSignature: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.agreementSignature);
});

test('an unticked disclaimer blocks submission', () => {
  const r = ok({}, { agreed: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.agreeCheck);
});

// ── Batch, which only some plans need ────────────────────────────────────────

test('batch is required only when the plan enrolls into a cohort', () => {
  const without = ok({}, { needsBatch: false, batchId: null });
  assert.equal(without.ok, true, 'a plan with no cohort must not demand a batch');

  const missing = ok({}, { needsBatch: true, batchId: null });
  assert.equal(missing.ok, false, 'a cohort plan without a batch cannot be granted a seat');
  assert.ok(missing.errors.batchId);

  const picked = ok({}, { needsBatch: true, batchId: 'b1e7c0de-0000-4000-8000-000000000000' });
  assert.equal(picked.ok, true);
});

// ── Length caps ──────────────────────────────────────────────────────────────

test('over-long answers are rejected rather than silently truncated on the way to the database', () => {
  const field = INTAKE_FIELDS.find(f => f.maxLen && f.type === 'text');
  const r = ok({ [field.key]: 'x'.repeat(field.maxLen + 1) });
  assert.equal(r.ok, false, `${field.key} has a ${field.maxLen} cap that must be enforced here, not by Postgres`);
  assert.ok(r.errors[field.key]);
});

test('an answer exactly at the cap is accepted', () => {
  const field = INTAKE_FIELDS.find(f => f.maxLen && f.type === 'text');
  assert.equal(ok({ [field.key]: 'x'.repeat(field.maxLen) }).ok, true, 'the cap is inclusive');
});

// ── Normalizers shape, never reject ──────────────────────────────────────────

test('normalizePhone keeps the digits a student typed and trims the rest', () => {
  assert.equal(normalizePhone('  0917-555-0101 '), '0917-555-0101');
  assert.equal(normalizePhone('+63 917 555 0101'), '+63 917 555 0101');
  assert.equal(normalizePhone(null), '');
});

test('normalizeFacebook accepts a bare name as readily as a link', () => {
  assert.equal(normalizeFacebook('  Juan Dela Cruz  '), 'Juan Dela Cruz');
  assert.equal(normalizeFacebook('facebook.com/juan'), 'facebook.com/juan');
  assert.equal(normalizeFacebook('https://www.facebook.com/juan'), 'https://www.facebook.com/juan');
  assert.equal(normalizeFacebook(undefined), '');
});

test('blankIntake produces an entry for every field so React inputs stay controlled', () => {
  const blank = blankIntake();
  for (const f of INTAKE_FIELDS) {
    assert.ok(f.key in blank, `${f.key} missing from blankIntake — its input would be uncontrolled`);
  }
});

// ── File types are checked here, not by the storage bucket ───────────────────
// The bucket has its own allowed_mime_types list, but a rejection there arrives as
// an opaque storage error after the upload has already started. Catching it at the
// field turns that into a sentence the student can act on.

test('every file field declares which types it takes', () => {
  for (const f of INTAKE_FIELDS) {
    if (f.type !== 'file') continue;
    assert.ok(f.mime instanceof RegExp, `${f.key} has an accept attribute but no mime rule to enforce it`);
  }
});

test('the payment screenshot takes images and PDFs', () => {
  const f = intakeField('paymentFile');
  for (const t of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) {
    assert.equal(fileTypeAllowed(f, { type: t }), true, `${t} is a normal receipt`);
  }
});

test('the payment screenshot refuses a Word file', () => {
  const f = intakeField('paymentFile');
  assert.equal(fileTypeAllowed(f, { type: 'application/msword' }), false,
    'a receipt is a screenshot or a PDF — the bucket would reject this anyway, later and less clearly');
});

test('the resume additionally takes Word documents', () => {
  const f = intakeField('resumeFile');
  for (const t of [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
  ]) {
    assert.equal(fileTypeAllowed(f, { type: t }), true, `${t} is a resume people really send`);
  }
});

test('the resume refuses something that is plainly not a document', () => {
  assert.equal(fileTypeAllowed(intakeField('resumeFile'), { type: 'video/mp4' }), false);
});

test('a missing file or an unknown field is not a type error', () => {
  assert.equal(fileTypeAllowed(intakeField('resumeFile'), null), true, 'absence is handled by required-ness, not by type');
  assert.equal(fileTypeAllowed(undefined, { type: 'video/mp4' }), true, 'nothing to enforce without a field');
});

test('a file with no reported type is allowed through to the bucket', () => {
  assert.equal(fileTypeAllowed(intakeField('paymentFile'), { type: '' }), true,
    'some browsers report an empty type for valid files; the bucket is the backstop, not a blanket refusal');
});

// The client gate must not be LOOSER than the bucket. A naive image/* rule lets a
// .heic or .gif resume through the form, then Storage 415s mid-upload and the whole
// enrollment aborts — over the one field that was supposed to be optional.
test('no file field accepts a type the enrollment-receipts bucket would reject', () => {
  // Exactly db/2026-08-20-enrollment-intake.sql section 6.
  const BUCKET = [
    'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  const PROBE = [...BUCKET, 'image/gif', 'image/heic', 'image/tiff', 'image/svg+xml',
    'image/bmp', 'video/mp4', 'text/plain', 'application/zip'];

  let fileFields = 0;
  for (const f of INTAKE_FIELDS) {
    if (f.type !== 'file') continue;
    fileFields++;
    for (const t of PROBE) {
      if (!fileTypeAllowed(f, { type: t })) continue;
      assert.ok(BUCKET.includes(t),
        `${f.key} accepts ${t}, which the bucket rejects — the upload would fail after it started`);
    }
  }
  assert.equal(fileFields, 2, 'the form has exactly two uploads: the receipt and the optional resume');
});

// ── Prefilling a renewal from the member's previous request ──────────────────
// The same form serves new enrollments, renewals and upgrades. Making a returning
// member retype their course, city, experience and background every term is
// friction aimed squarely at the people who have already paid.

const PRIOR = Object.freeze({
  full_name: 'Juan dela Cruz',
  phone: '0917-555-0101',
  city_country: 'Manila, Philippines',
  college_course: 'BS Accountancy',
  current_job: 'Audit Associate',
  ph_experience: '2-5 years',
  us_experience: 'None',
  currently_employed: 'YES',
  prior_training: 'No',
  referred_by: 'Facebook ad',
  amount_paid: 2999,
  intake: { facebook_link: 'facebook.com/juandelacruz', struggles: '1. a\n2. b\n3. c' },
});

test('a previous request prefills every text answer it carries', () => {
  const v = intakeValuesFromRequest(PRIOR);
  assert.equal(v.fullName, 'Juan dela Cruz');
  assert.equal(v.cellphone, '0917-555-0101');
  assert.equal(v.cityCountry, 'Manila, Philippines');
  assert.equal(v.collegeCourse, 'BS Accountancy');
  assert.equal(v.currentJob, 'Audit Associate');
  assert.equal(v.priorTraining, 'No');
  assert.equal(v.referredBy, 'Facebook ad');
  assert.equal(v.facebookLink, 'facebook.com/juandelacruz');
  assert.equal(v.struggles, '1. a\n2. b\n3. c');
});

test('a prefilled request validates without the member touching anything but payment', () => {
  const v = { ...blankIntake(), ...intakeValuesFromRequest(PRIOR), email: 'juan@example.com', amountPaid: '2999' };
  const r = validateIntake(v, SATISFIED);
  assert.equal(r.ok, true, `prefill should produce a complete form, got: ${JSON.stringify(r.errors)}`);
});

test('the amount is never prefilled — a new term is a new payment', () => {
  const v = intakeValuesFromRequest(PRIOR);
  assert.equal(v.amountPaid, undefined,
    'carrying last term’s amount forward would pre-fill the wrong number when the plan or price changed');
});

test('email is never prefilled from the old row — the account is the authority', () => {
  const v = intakeValuesFromRequest({ ...PRIOR, email: 'old@example.com' });
  assert.equal(v.email, undefined);
});

test('an off-menu stored choice is dropped rather than prefilled into an invalid field', () => {
  const v = intakeValuesFromRequest({ ...PRIOR, ph_experience: '3 years-ish', currently_employed: 'yes' });
  assert.equal(v.phExperience, undefined,
    'prefilling a value validateIntake rejects would show an error on a field the member never touched');
  assert.equal(v.currentlyEmployed, undefined, 'casing matters, so a lower-case yes is off-menu');
  assert.equal(v.usExperience, 'None', 'the valid siblings still carry over');
});

test('a missing or empty prior request prefills nothing', () => {
  for (const row of [null, undefined, {}]) {
    assert.deepEqual(intakeValuesFromRequest(row), {}, 'a first-time enrollment starts blank');
  }
});

test('a prior request with no intake jsonb still prefills its columns', () => {
  const v = intakeValuesFromRequest({ ...PRIOR, intake: null });
  assert.equal(v.collegeCourse, 'BS Accountancy');
  assert.equal(v.struggles, undefined);
});

// ── Content type for upload ──────────────────────────────────────────────────
// The bucket's allowed_mime_types has no 'application/octet-stream', so uploading
// with that fallback is a guaranteed 415 — and that 415 aborts the whole
// enrollment. Browsers report an empty file.type often enough (files dragged from
// some file managers, uncommon extensions) that the extension has to be consulted.

test('a reported content type is used as-is', () => {
  assert.equal(contentTypeFor({ name: 'receipt.png', type: 'image/png' }), 'image/png');
  assert.equal(contentTypeFor({ name: 'cv.docx', type: 'application/msword' }), 'application/msword');
});

test('an empty content type is inferred from the extension', () => {
  assert.equal(contentTypeFor({ name: 'receipt.PNG', type: '' }), 'image/png', 'extensions arrive in any case');
  assert.equal(contentTypeFor({ name: 'proof.jpeg', type: '' }), 'image/jpeg');
  assert.equal(contentTypeFor({ name: 'proof.jpg', type: '' }), 'image/jpeg');
  assert.equal(contentTypeFor({ name: 'shot.webp', type: '' }), 'image/webp');
  assert.equal(contentTypeFor({ name: 'agreement.pdf', type: '' }), 'application/pdf');
  assert.equal(contentTypeFor({ name: 'cv.doc', type: '' }), 'application/msword');
  assert.equal(contentTypeFor({ name: 'cv.docx', type: '' }),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('every inferred type is one the bucket accepts', () => {
  const BUCKET = [
    'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.pdf', 'a.doc', 'a.docx']) {
    const t = contentTypeFor({ name, type: '' });
    assert.ok(BUCKET.includes(t), `${name} inferred ${t}, which the bucket would reject`);
  }
});

test('an unknown extension yields null rather than a type the bucket rejects', () => {
  for (const name of ['mystery', 'thing.xyz', '']) {
    assert.equal(contentTypeFor({ name, type: '' }), null,
      'guessing application/octet-stream here is what causes the 415 this function exists to avoid');
  }
  assert.equal(contentTypeFor(null), null);
});

// ── Field widths mirror the Apps Script form exactly ─────────────────────────
// The source (html.index) pairs exactly two rows — Email|Cellphone and
// City|College Course — and leaves every other field full width. Inferring width
// from a field's TYPE instead produced the wrong layout: Full Name was paired with
// Email, and College Course, Current Job Title and Amount Paid were each stranded
// alone in a half-width slot with dead space beside them.

test('exactly four fields are half width, in source order', () => {
  const half = INTAKE_FIELDS.filter(f => f.span === 'half').map(f => f.key);
  assert.deepEqual(half, ['email', 'cellphone', 'cityCountry', 'collegeCourse'],
    'html.index pairs Email|Cellphone and City|College Course, and nothing else');
});

test('half-width fields sit next to each other so no row is left ragged', () => {
  const half = INTAKE_FIELDS.filter(f => f.span === 'half');
  assert.equal(half.length % 2, 0, 'an odd count strands one field beside dead space');
  for (let i = 0; i < half.length; i += 2) {
    const a = INTAKE_FIELDS.indexOf(half[i]);
    const b = INTAKE_FIELDS.indexOf(half[i + 1]);
    assert.equal(b, a + 1,
      `${half[i].key} and ${half[i + 1].key} must be adjacent in the registry to share a row`);
  }
});

test('half-width fields share a section, or they cannot share a row', () => {
  const half = INTAKE_FIELDS.filter(f => f.span === 'half');
  for (let i = 0; i < half.length; i += 2) {
    assert.equal(half[i].section, half[i + 1].section,
      `${half[i].key} and ${half[i + 1].key} render in different sections and would never pair`);
  }
});

test('only single-line inputs are ever half width', () => {
  for (const f of INTAKE_FIELDS) {
    if (f.span !== 'half') continue;
    assert.ok(!['textarea', 'choice', 'file'].includes(f.type),
      `${f.key} is a ${f.type} — pills, textareas and drop zones need the full width`);
  }
});
