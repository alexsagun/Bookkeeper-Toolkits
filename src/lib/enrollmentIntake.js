// ─────────────────────────────────────────────────────────────────────────────
// enrollmentIntake.js — PURE, dependency-free field registry + validation for
// the enrollment intake form (#42).
// ─────────────────────────────────────────────────────────────────────────────
// The client half of the intake columns on public.enrollment_requests
// (db/2026-08-20-enrollment-intake.sql). Ported from the Google Apps Script
// enrollment web app it replaces.
//
// ★ ONE REGISTRY DRIVES BOTH RENDERING AND VALIDATION.
//   INTAKE_FIELDS is read by the form component to lay the inputs out AND by
//   validateIntake() to check them. That is not tidiness — it is the fix for the
//   specific bug this port inherits. In the Apps Script, the resume field was
//   rendered with a label and a drop zone but shipped without a `required`
//   attribute, so it was displayed-but-unvalidated and stayed that way. When a
//   single array is the source of both, a field cannot exist in one and not the
//   other. Adding a field here is all it takes to have it rendered, required,
//   flagged when blank, and counted in the error summary.
//
// ★ THIS FUNCTION IS THE GATE, NOT THE BROWSER.
//   The `required` attribute is belt-and-braces. It is trivially bypassed, it
//   cannot express "this radio group needs one of four exact strings", and the
//   Apps Script's own submit handler called preventDefault() before checking
//   anything but five fields. validateIntake() is what actually decides.
//
// ★ CHOICE VALUES ARE STORED VERBATIM AND COMPARED ACROSS COHORTS.
//   EXPERIENCE_OPTIONS and EMPLOYED_OPTIONS are copied character-for-character
//   from the Apps Script form so answers collected before and after this port
//   remain comparable. Rewording an option silently splits a bucket in two —
//   change them only alongside a data migration.
//
// ★ `column` AND `json` DRIVE READS *AND* WRITES.
//   intakeValuesFromRequest() prefills a renewal FROM a stored row;
//   intakePayload() builds the row TO store; intakeSelectColumns() names what the
//   admin alert must select. Adding a storable field is therefore two places —
//   this registry and a dated migration adding the column — not four.
//   It used to be four, and the write side was a hand-typed literal, which
//   reintroduced this module's founding bug on the write path: a field could
//   render, block submit, prefill and pass tests while never being saved.
//
// NO imports, NO side effects, NO DOM, NO network. Pinned by
// test/enrollmentIntake.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

/** Radio options for both bookkeeping-experience questions. Verbatim from the source form. */
export const EXPERIENCE_OPTIONS = Object.freeze([
  'None',
  'Less than 2 years',
  '2-5 years',
  '5 years and above',
]);

/** Employment answer. Upper-case is part of the stored value, not styling. */
export const EMPLOYED_OPTIONS = Object.freeze(['YES', 'NO']);

/**
 * Form sections, in render order. `key` is what INTAKE_FIELDS points at; the
 * numbering in `eyebrow` mirrors the source form's "01 · Personal Information".
 */
export const INTAKE_SECTIONS = Object.freeze([
  { key: 'personal', eyebrow: '01', label: 'Personal Information' },
  { key: 'professional', eyebrow: '02', label: 'Professional Background' },
  { key: 'payment', eyebrow: '03', label: 'Program & Payment' },
  { key: 'agreement', eyebrow: '04', label: 'View and Sign Training Agreement' },
  { key: 'final', eyebrow: '05', label: 'Final Questions' },
]);

/**
 * Every input the student fills in, in render and focus order.
 *
 * `email` is marked required but arrives pre-filled and read-only from the
 * signed-in account: the enrollment must stay attached to the Supabase user who
 * paid, so letting someone type a different address here would orphan the
 * subscription it grants. It is still validated, because a field the form shows
 * is a field the form checks.
 *
 * The `agreement` section carries no entry here — the signature, the disclaimer
 * tick and the cohort pick are not text inputs and are validated from context
 * (see validateIntake). They still receive errors and still take focus.
 *
 * ★ `span: 'half'` is the ONLY thing that makes a field share a row; everything
 * else is full width. It mirrors the source form, which pairs exactly two rows
 * (Email|Cellphone and City|College Course) and leaves the rest alone. Layout
 * therefore lives in the registry beside validation rather than being inferred
 * from a field's type — that inference is what paired Full Name with Email and
 * stranded three fields in half-width slots with dead space beside them. Halves
 * must be declared in adjacent pairs within one section, which
 * test/enrollmentIntake.test.mjs enforces.
 */
export const INTAKE_FIELDS = Object.freeze([
  // ── 01 · Personal Information ──
  { key: 'fullName', section: 'personal', label: 'Full name', type: 'text', required: true,
    placeholder: 'Juan dela Cruz', maxLen: 120, column: 'full_name', base: true },
  { key: 'email', section: 'personal', label: 'Email', type: 'email', required: true,
    span: 'half', readOnly: true, hint: 'Taken from your account so your enrolment stays linked to it.',
    maxLen: 254, column: 'email', base: true },
  { key: 'cellphone', section: 'personal', label: 'Cellphone number', type: 'tel', required: true,
    span: 'half', placeholder: '09XX-XXX-XXXX', maxLen: 40, column: 'phone', base: true, normalize: normalizePhone },
  { key: 'cityCountry', section: 'personal', label: 'City and country', type: 'text', required: true,
    span: 'half', placeholder: 'Manila, Philippines', maxLen: 120, column: 'city_country', base: true },
  { key: 'collegeCourse', section: 'personal', label: 'College course', type: 'text', required: true,
    span: 'half', placeholder: 'BS Accountancy', maxLen: 160, column: 'college_course' },

  // ── 02 · Professional Background ──
  { key: 'currentJob', section: 'professional', label: 'Current job title / position', type: 'text',
    required: true, placeholder: 'e.g. Audit Associate, Bookkeeper', maxLen: 160, column: 'current_job' },
  { key: 'phExperience', section: 'professional', label: 'PH bookkeeping / accounting experience',
    type: 'choice', required: true, options: EXPERIENCE_OPTIONS, column: 'ph_experience' },
  { key: 'usExperience', section: 'professional', label: 'US / AU / UK bookkeeping experience',
    type: 'choice', required: true, options: EXPERIENCE_OPTIONS, column: 'us_experience' },
  { key: 'currentlyEmployed', section: 'professional', label: 'Are you currently employed?',
    type: 'choice', required: true, options: EMPLOYED_OPTIONS, column: 'currently_employed' },
  { key: 'priorTraining', section: 'professional',
    label: 'Have you taken QuickBooks / Xero ProAdvisor training before?', type: 'text', required: true,
    hint: 'If yes, say where.', placeholder: 'e.g. No / Yes — via [trainer name]', maxLen: 300,
    column: 'prior_training' },
  { key: 'resumeFile', section: 'professional', label: 'Resume', type: 'file', required: false,
    hint: 'Optional. PDF, Word or image (PNG, JPG, WEBP), up to 10 MB.',
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp',
    // ★ Deliberately NOT `image/*`. The enrollment-receipts bucket allows only
    // png/jpeg/webp among images, so a .heic straight off a phone or a .gif would
    // clear a naive image/* gate and then 415 mid-upload — aborting the entire
    // enrollment over the one field that is supposed to be optional.
    mime: /^image\/(png|jpe?g|webp)$|^application\/pdf$|^application\/msword$|^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i },

  // ── 03 · Program & Payment ──
  { key: 'amountPaid', section: 'payment', label: 'Total amount paid / sent', type: 'text',
    required: true, placeholder: 'e.g. 16,999', maxLen: 40 },
  { key: 'paymentFile', section: 'payment', label: 'Screenshot of payment', type: 'file',
    required: true, hint: 'Your GCash / BPI / Security Bank receipt. PDF, PNG, JPG or WEBP, up to 10 MB.',
    accept: '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp',
    mime: /^image\/(png|jpe?g|webp)$|^application\/pdf$/i },

  // ── 05 · Final Questions ──
  { key: 'referredBy', section: 'final', label: 'Who referred you to this program?', type: 'text',
    required: true, placeholder: 'Name of referrer, or Facebook ad, Google…', maxLen: 200,
    column: 'referred_by' },
  { key: 'facebookLink', section: 'final', label: 'Facebook name or link', type: 'text', required: true,
    hint: 'Paste your profile link, or the name on your Facebook account.',
    placeholder: 'e.g. facebook.com/yourname or Juan dela Cruz', maxLen: 300, json: 'facebook_link', normalize: normalizeFacebook },
  { key: 'struggles', section: 'final',
    label: '3 struggles you are facing right now in landing your dream job', type: 'textarea',
    required: true, hint: 'Be specific — this is what Coach Alex tailors his guidance from.',
    placeholder: '1. …\n2. …\n3. …', rows: 4, maxLen: 4000, json: 'struggles' },
]);

const PAYMENT_FILE_AT = INTAKE_FIELDS.findIndex(f => f.key === 'paymentFile');

/**
 * Focus order for validateIntake().firstInvalid — the registry plus the three
 * non-text gates, slotted where they actually appear on screen so focus never
 * jumps backwards past a problem the student can already see.
 */
const VALIDATION_ORDER = Object.freeze([
  ...INTAKE_FIELDS.slice(0, PAYMENT_FILE_AT + 1).map(f => f.key),
  'batchId',
  'agreementSignature',
  ...INTAKE_FIELDS.slice(PAYMENT_FILE_AT + 1).map(f => f.key),
  'agreeCheck',
]);

const FIELD_BY_KEY = Object.freeze(Object.fromEntries(INTAKE_FIELDS.map(f => [f.key, f])));

// Deliberately permissive: one @, no whitespace, a dot in the domain. Anything
// stricter starts rejecting addresses that genuinely deliver, and the account's
// own address has already survived Supabase signup by the time it reaches here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = v => (v == null ? '' : String(v));
const trimmed = v => str(v).trim();

/** Trim only — a phone number's internal shape is the student's business. */
export function normalizePhone(raw) {
  return trimmed(raw);
}

/** Trim only — the field accepts a bare name as readily as a URL. */
export function normalizeFacebook(raw) {
  return trimmed(raw);
}

/**
 * Read the amount a student typed into a number.
 *
 * The source form's amount input is free text with a peso placeholder, so real
 * submissions carry currency signs, thousands separators and "PHP" prefixes.
 * enrollment_requests.amount_paid is `numeric`, so something has to bridge that.
 *
 * ★ The empty-string guard is load-bearing: Number('') is 0, not NaN, so without
 * it a bare peso sign and "paid via gcash" would both parse as a zero payment
 * and survive a `> 0` check only by accident of ordering.
 *
 * @returns {number|null} null when there is no number in the string at all.
 */
export function parseAmountPaid(raw) {
  const cleaned = str(raw).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Bump when the shape of the `intake` jsonb changes. Stored as `_v`. */
export const INTAKE_JSON_VERSION = 1;

/**
 * The `enrollment_requests` payload for one submission, DERIVED from the registry.
 *
 * ★ THIS IS WHY `column` AND `json` NOW PERSIST. They used to be read-only
 *   mappings (prefill), while the write side was a hand-typed object literal in
 *   EnrollmentPaywall.submit(). That reintroduced, on the write side, the exact
 *   class of bug this module exists to prevent: a field declaring `column: 'x'`
 *   would render with a red asterisk, block submit until answered, prefill on
 *   renewal and pass every test — and never be saved. The admin would review an
 *   enrollment where a mandatory answer was blank, and nothing anywhere errored.
 *
 * Fields marked `base: true` are deliberately excluded: full_name / email /
 * phone / city_country are written by submitSubscriptionRequest's own base row,
 * where `email` comes from the ACCOUNT rather than the form. Emitting them here
 * would spread over that row and let a typed address win.
 *
 * `type: 'file'` fields are excluded too — a path is known only after upload, so
 * the caller supplies resume_path itself.
 */
export function intakePayload(values) {
  const v = values || {};
  const row = {};
  const json = { _v: INTAKE_JSON_VERSION };
  for (const f of INTAKE_FIELDS) {
    if (f.type === 'file' || f.base) continue;
    if (!f.column && !f.json) continue;
    const raw = v[f.key];
    const out = f.normalize ? f.normalize(raw) : (typeof raw === 'string' ? raw.trim() : (raw ?? null));
    if (f.column) row[f.column] = out;
    else json[f.json] = out;
  }
  row.intake = json;
  return row;
}

/**
 * The stored column names an admin-facing reader must SELECT, derived from the
 * same registry — so api/notify-enrollment.js can never omit a new column and
 * silently render its row as blank in the admin alert.
 */
export function intakeSelectColumns() {
  const cols = INTAKE_FIELDS
    .filter(f => f.column && !f.base && f.type !== 'file')
    .map(f => f.column);
  return [...cols, 'intake'];
}

/** An empty value for every field, so every React input starts controlled. */
export function blankIntake() {
  const out = {};
  for (const f of INTAKE_FIELDS) out[f.key] = f.type === 'file' ? null : '';
  return out;
}

/**
 * Seed the form from a member's previous enrollment_requests row.
 *
 * The same form serves new enrollments, renewals and upgrades. A returning member
 * has already told us their course, city, experience and background — making them
 * retype all of it to buy another term is friction aimed at the people who have
 * already paid once.
 *
 * Registry-driven, so a new question prefills automatically once it declares
 * where it lives (`column` for a real column, `json` for a key inside the intake
 * jsonb). Three things are deliberately never carried forward:
 *
 *   • `amountPaid` — a new term is a new payment, and the plan or its price may
 *     have changed since. It is filled from the chosen plan instead.
 *   • `email` (and anything `readOnly`) — the signed-in account is the authority;
 *     a stale address here would orphan the subscription this grants.
 *   • files — a receipt proves THIS payment, and a signature must be made now.
 *
 * ★ A stored value that would fail validateIntake() is dropped rather than
 * prefilled. Otherwise a legacy row holding an off-menu experience string would
 * render an error against a field the member never touched.
 */
export function intakeValuesFromRequest(row) {
  if (!row) return {};
  const out = {};
  for (const f of INTAKE_FIELDS) {
    if (f.type === 'file' || f.readOnly) continue;
    const raw = f.column ? row[f.column] : (f.json ? row.intake?.[f.json] : undefined);
    const value = trimmed(raw);
    if (!value) continue;
    if (f.maxLen && value.length > f.maxLen) continue;
    if (f.type === 'choice' && !f.options.includes(value)) continue;
    out[f.key] = value;
  }
  return out;
}

/**
 * Validate a whole submission.
 *
 * Returns EVERY problem at once rather than the first — the form shows a summary
 * banner listing all of them, which is the difference between "fix one, submit,
 * discover the next" and knowing up front what is missing.
 *
 * @param {Record<string, unknown>} values  keyed by INTAKE_FIELDS[].key
 * @param {{
 *   plan?: object|null,        // the chosen enrollment_plans row
 *   needsBatch?: boolean,      // cohort plan AND open batches are listable
 *   batchId?: string|null,     // the picked cohort
 *   hasReceipt?: boolean,      // a payment file is attached
 *   hasSignature?: boolean,    // the agreement has been signed
 *   agreed?: boolean,          // the disclaimer tick
 * }} ctx
 * @returns {{ ok: boolean, errors: Record<string,string>, firstInvalid: string|null }}
 */
export function validateIntake(values = {}, ctx = {}) {
  const errors = {};

  for (const f of INTAKE_FIELDS) {
    // Files carry no text value — they are checked from context below.
    if (f.type === 'file') continue;

    const value = trimmed(values[f.key]);

    if (!value) {
      if (f.required) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    if (f.maxLen && value.length > f.maxLen) {
      errors[f.key] = `${f.label} is too long — keep it under ${f.maxLen} characters.`;
      continue;
    }
    if (f.type === 'choice' && !f.options.includes(value)) {
      errors[f.key] = `Choose one of the listed options for ${f.label.toLowerCase()}`;
      continue;
    }
    if (f.type === 'email' && !EMAIL_RE.test(value)) {
      errors[f.key] = 'Enter a complete email address, like you@example.com.';
    }
  }

  // Amount has to be a positive number on top of being present.
  if (!errors.amountPaid && trimmed(values.amountPaid)) {
    const amount = parseAmountPaid(values.amountPaid);
    if (amount === null) {
      errors.amountPaid = 'Enter the amount as a number, for example 16,999.';
    } else if (amount <= 0) {
      errors.amountPaid = 'Enter the amount you actually sent.';
    }
  }

  if (!ctx.hasReceipt) {
    errors.paymentFile = 'Attach a screenshot or PDF of your payment.';
  }
  if (ctx.needsBatch && !ctx.batchId) {
    errors.batchId = 'Choose the batch (training month) you are joining.';
  }
  if (!ctx.hasSignature) {
    errors.agreementSignature = 'Open the Training Agreement, read it, and draw your signature.';
  }
  if (!ctx.agreed) {
    errors.agreeCheck = 'Tick the box to confirm you have read the Important Note & Disclaimer.';
  }

  const firstInvalid = VALIDATION_ORDER.find(key => errors[key]) || null;
  return { ok: Object.keys(errors).length === 0, errors, firstInvalid };
}

/** Look up a field definition by key. Undefined for the context-only gates. */
export function intakeField(key) {
  return FIELD_BY_KEY[key];
}

/**
 * Whether a picked file's type is one this field accepts.
 *
 * The storage bucket keeps its own `allowed_mime_types` list and is the real
 * boundary, but a rejection there arrives as an opaque error *after* the upload
 * has begun. Checking here turns that into a sentence under the field.
 *
 * ★ An empty `file.type` passes. Browsers report one for files dragged from some
 * file managers and for uncommon extensions, and refusing those would block valid
 * resumes to catch a case the bucket already handles.
 */
export function fileTypeAllowed(field, file) {
  if (!field?.mime || !file) return true;
  const type = str(file.type);
  if (!type) return true;
  return field.mime.test(type);
}

/**
 * Extension → mime, for the files this form uploads. Exactly the bucket's
 * `allowed_mime_types` list from db/2026-08-20-enrollment-intake.sql section 6.
 */
const EXTENSION_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

/**
 * The content type to upload a picked file with.
 *
 * ★ Never falls back to 'application/octet-stream'. That type is absent from the
 * bucket's allowed list, so using it as a default guarantees a 415 — and because
 * an upload failure aborts the whole submission, that 415 costs the student their
 * enrollment. Browsers report an empty `file.type` often enough (files dragged
 * from some file managers, uncommon extensions) that this is a live path, not a
 * theoretical one.
 *
 * @returns {string|null} null when nothing can be inferred — the caller should
 *   then let Supabase infer it rather than assert a type the bucket refuses.
 */
export function contentTypeFor(file) {
  if (!file) return null;
  const reported = str(file.type);
  if (reported) return reported;
  const ext = str(file.name).toLowerCase().split('.').pop();
  return EXTENSION_TYPES[ext] || null;
}
