// Pins the Cover Letter Generator's industry detector and dash scrubber.
//
// These rules are invisible in the UI: the detector silently picks the vertical that
// drives every pain point, deliverable and tool name in the AI prompt, so a regression
// here produces confidently wrong copy rather than a visible error. `npm run build`
// cannot catch that, and the app has no DOM test harness, so this suite is the only
// automated check the tool has.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_INDUSTRIES,
  DEFAULT_INDUSTRY_ID,
  MIN_DETECT_CHARS,
  detectIndustry,
  getIndustry,
  scrubDashes,
} from '../src/lib/coverLetterIndustry.js';

const pad = (s) => s.padEnd(MIN_DETECT_CHARS + 10, ' .');

test('table integrity: ids are unique and every entry is prompt-ready', () => {
  const ids = COVER_INDUSTRIES.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate industry id');
  assert.ok(ids.includes(DEFAULT_INDUSTRY_ID), 'fallback id must exist in the table');

  for (const ind of COVER_INDUSTRIES) {
    assert.ok(ind.label, `${ind.id}: missing label`);
    // Each of these is interpolated straight into the prompt; an empty one silently
    // produces a letter with no industry specificity at all.
    assert.ok(ind.pain.length > 0, `${ind.id}: no pain points`);
    assert.ok(ind.deliverables.length > 0, `${ind.id}: no deliverables`);
    assert.ok(ind.tools.length > 0, `${ind.id}: no tools`);
    assert.ok(ind.sample.length > MIN_DETECT_CHARS, `${ind.id}: sample too short to auto-detect`);
  }
});

test('every industry sample JD detects as its own industry', () => {
  // The "Load sample" button fills the JD with ind.sample. If a sample did not detect
  // as its own industry the picker would visibly disagree with the button the user
  // just pressed.
  for (const ind of COVER_INDUSTRIES) {
    if (ind.id === DEFAULT_INDUSTRY_ID) continue;
    assert.equal(detectIndustry(ind.sample), ind.id, `${ind.id}: sample misdetects`);
  }
});

test('a clear strong signal wins', () => {
  const jd = pad('We need help with retainage, WIP schedules and job costing in Buildertrend.');
  assert.equal(detectIndustry(jd), 'construction');
});

test('confidence gate: a single weak hit is not enough', () => {
  // "insurance" alone is 1 point, below MIN_SCORE of 3 — plenty of unrelated posts
  // mention insurance in passing.
  const jd = pad('Small business needs a bookkeeper. We also pay for insurance every month.');
  assert.equal(detectIndustry(jd), DEFAULT_INDUSTRY_ID);
});

test('margin rule: a tie falls back to general', () => {
  // "iolta" is a strong signature for BOTH lawfirm and realestate and nothing else
  // here favours either, so both land on exactly 3. A dead heat must never be
  // resolved by array order.
  const jd = pad('We need bookkeeping help. The IOLTA account has not been reconciled in months and nobody has looked at it.');
  const got = detectIndustry(jd);
  assert.equal(got, DEFAULT_INDUSTRY_ID, `expected fallback on a tie, got ${got}`);
});

test('margin rule: winning by a single weak hit is not enough', () => {
  // Same IOLTA tie, plus one weak "property" hit for realestate: 4 vs 3. A margin of
  // 1 is below MIN_MARGIN, so it still falls back rather than guessing.
  const jd = pad('The IOLTA account is a mess and the property has not been reconciled in months either.');
  const got = detectIndustry(jd);
  assert.equal(got, DEFAULT_INDUSTRY_ID, `expected fallback on a 1-point margin, got ${got}`);
});

test('margin rule: winning by two clears the gate', () => {
  // The boundary on the other side — realestate adds "rental" as well, making it
  // 5 vs 3, which is a real signal rather than noise.
  const jd = pad('The IOLTA account is a mess, the rental property books have not been reconciled in months.');
  assert.equal(detectIndustry(jd), 'realestate');
});

test('below the character floor returns null, not a guess', () => {
  // null is meaningfully different from 'general': the caller keeps whatever the user
  // already selected instead of resetting the picker on every keystroke.
  assert.equal(detectIndustry('IOLTA'), null);
  assert.equal(detectIndustry(''), null);
  assert.equal(detectIndustry('   '), null);
  assert.equal(detectIndustry(undefined), null);
  assert.equal(detectIndustry(null), null);
  assert.equal(detectIndustry(123), null);
});

test('whole-term matching does not fire inside longer words', () => {
  // 'cac' is a strong SaaS signature; it must not match 'cacophony'.
  const jd = pad('The office is a cacophony of noise and we need bookkeeping help urgently.');
  assert.equal(detectIndustry(jd), DEFAULT_INDUSTRY_ID);
});

test('signatures containing punctuation still match', () => {
  // 'a/r' and 'asc 606' would misbehave under a naive \b boundary.
  const arJd = pad('Clinic needs patient a/r aging cleaned up, plus denial rate reporting and HIPAA-safe workflow.');
  assert.equal(detectIndustry(arJd), 'healthcare');

  const ascJd = pad('We need ASC 606 revenue recognition, deferred revenue schedules and Stripe reconciliation.');
  assert.equal(detectIndustry(ascJd), 'saas');
});

test('detectIndustry only ever returns a real id or null', () => {
  const ids = new Set(COVER_INDUSTRIES.map(i => i.id));
  const probes = [
    'random text about nothing in particular that is definitely long enough to score',
    'shopify amazon fba sku landed cost sales tax nexus for our online store',
    'toast pos daily sales tip reporting food cost for our three restaurants',
    '!!!! ??? *** ((( ))) [[[ ]]] \\\\ /// long enough string of pure punctuation ....',
  ];
  for (const p of probes) {
    const got = detectIndustry(p);
    assert.ok(got === null || ids.has(got), `returned unknown id: ${got}`);
  }
});

test('getIndustry falls back rather than returning undefined', () => {
  assert.equal(getIndustry('saas').id, 'saas');
  assert.equal(getIndustry('does-not-exist').id, COVER_INDUSTRIES[0].id);
  assert.equal(getIndustry(undefined).id, COVER_INDUSTRIES[0].id);
});

test('scrubDashes removes em and en dashes', () => {
  // Confirms the literal dash glyphs in the source survived file encoding.
  assert.equal(scrubDashes('books — three months behind'), 'books, three months behind');
  assert.equal(scrubDashes('books – three months behind'), 'books, three months behind');
  assert.equal(scrubDashes('fixable — Then we reconcile'), 'fixable. Then we reconcile');
  assert.equal(scrubDashes('tight—fast'), 'tight, fast');
});

test('scrubDashes never doubles punctuation or eats a line break', () => {
  // The exact damage the old \s*-based version caused. Letter bodies render with
  // whitespace-pre-wrap, so a swallowed newline welds a signature onto the sentence
  // above it, in full view of the reader.
  assert.equal(scrubDashes('Talk soon.\n— Maria Santos'), 'Talk soon.\nMaria Santos');
  assert.equal(scrubDashes('Your books are behind.\n— That is fixable.'), 'Your books are behind.\nThat is fixable.');
  assert.equal(scrubDashes('closed the month, — and then we reconciled'), 'closed the month, and then we reconciled');
  assert.equal(scrubDashes('Here is the catch: — your books are stale'), 'Here is the catch: your books are stale');
  // Dash at the very end of a line, and at the very start of the string.
  assert.equal(scrubDashes('the books —\nare stale'), 'the books\nare stale');
  assert.equal(scrubDashes('— Maria'), 'Maria');
  // No output may ever contain a doubled separator.
  for (const s of ['a.\n— B', 'a, — b', 'a; — b', 'a — b', 'a—b', 'a —\n b']) {
    const out = scrubDashes(s);
    assert.ok(!/[.,;:!?]{2}/.test(out), `doubled punctuation in ${JSON.stringify(out)}`);
  }
});

test('everyday words are not single-word classifiers', () => {
  // Each of these is jargon the vertical shares with every other business. When they
  // sat in a `strong` list, one incidental mention scored 3 with no competitor, which
  // cleared MIN_SCORE and MIN_MARGIN at once and confidently picked the wrong industry
  // — then fed its pain points, deliverables and tool names into the prompt.
  const cases = [
    'We need bookkeeping help and 1099 filing every January for our small team.',
    'Payments come in through Stripe and nobody reconciles them against the bank.',
    'We pay a monthly premium for our business insurance and need the books tidy.',
    'Our COGS is wrong and inventory is a mess, need a bookkeeper to sort it out.',
    'The tenant improvement costs were booked wrong and we need them reclassified.',
    'The owner also runs a dental plan for staff, and the books are behind.',
  ];
  for (const jd of cases) {
    assert.equal(detectIndustry(jd), DEFAULT_INDUSTRY_ID, `misclassified: ${jd}`);
  }
});

test('demoted terms still contribute when the real signal is present', () => {
  // Demoting must not make a genuine post undetectable — these still land, on the
  // strength of the terms that actually are domain-specific.
  assert.equal(
    detectIndustry(pad('Shopify and Amazon FBA store, A2X installed, COGS and landed cost per SKU are wrong.')),
    'ecommerce',
  );
  assert.equal(
    detectIndustry(pad('B2B SaaS with 1.8M ARR. MRR reporting is inconsistent and Stripe payouts are unreconciled.')),
    'saas',
  );
});

test('scrubDashes leaves ordinary punctuation intact', () => {
  // The regressions the old mockup scrubber caused.
  const cases = [
    'We are U.S. based and serve U.S. clients.',
    'Available 9 a.m. to 5 p.m. EST.',
    '$12/hr. quickbooks online certified.',
    'Reconciled; then reviewed; then filed.',
    'e.g. john at example dot com',
    'No dashes here at all.',
  ];
  for (const c of cases) assert.equal(scrubDashes(c), c, `mangled: ${c}`);
});

test('scrubDashes passes through non-strings unchanged', () => {
  assert.equal(scrubDashes(undefined), undefined);
  assert.equal(scrubDashes(null), null);
  assert.equal(scrubDashes(42), 42);
});
