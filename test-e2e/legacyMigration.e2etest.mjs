// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/legacyMigration.e2etest.mjs — the legacy migration, driven in a real browser (#67).
// ─────────────────────────────────────────────────────────────────────────────
// The real app, served by Vite against the SHADOW project, with every mail/AI/Zoom key
// pinned dead by _app.mjs — so an "invitation" here is refused by the provider with a 401.
// ★ #68: A 401 PROVES NOTHING WAS SENT, so the endpoint's circuit breaker hands that email
//   back to the queue and PAUSES the run: at most one student is ever granted without an
//   invitation. #67 carried on through all three rows; this suite now checks the brake.
//
//   1. A Super Admin uploads a SYNTHETIC roster (6 rows, two cohorts), declares the date
//      format, confirms the mappings and stages it. Only the newest cohort is ready.
//   2. A refresh reopens the same job from the URL.
//   3. "Select all ready" selects the ready rows only. Step 1 of the dialog assigns the
//      terms — a start still ahead is opened TODAY, the paid end kept — and step 2 needs
//      the typed phrase.
//   4. The refused sender stops the run after ONE grant: the page says why, the run is
//      paused, the email is back in the queue, and that membership is ACTIVE, not
//      scheduled. Resume sends the owed email first — refused again — and grants nobody new.
//   5. A student activates their account through a link minted here: their name is
//      prefilled, their email locked, a mismatched confirmation refused. The summary shows
//      their membership, and Go To Dashboard reaches the dashboard — never a price.
//   6. An Operations Admin and a student get "Super Admin only" and fire no migration RPC.
//   7. The workspace never scrolls sideways at a phone width or with the sidebar open.
//   8. (#68) An ESSENTIALS roster with NO batch column stages: nothing asks for a batch, its
//      rows are Ready through the self-paced package tick, and activation grants a sampler
//      term with no cohort seat (and, the sender being refused, stops after that one).
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './_cdp.mjs';
import { ensureUsers, injectSession, lit, runSql, scalar, shadowEnv, signIn, skipReason, startApp } from './_app.mjs';
import { assertNoLiveOnboardingVideo } from './_onboarding.mjs';
import { REPO_ROOT } from '../scripts/_shadow.mjs';

const SKIP = skipReason();
const NONCE = randomBytes(3).toString('hex');
const ART = join(REPO_ROOT, 'test-e2e', '.artifacts', 'legacy-migration');
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const email = (n) => `e2e-lm-${NONCE}-r${n}@shadow.test`;

let app; let browser; let people; let csvPath; let jobUrl; let essPath;
const essEmail = (n) => `e2e-lm-${NONCE}-ess${n}@shadow.test`;

// #68: the shape a Silver/Essentials export may take — no batch column at all. A 60-day term,
// so the plan's own length raises no term_length_unusual warning.
function essentialsRoster() {
  const head = 'thinkific_user_id,first_name,last_name,email,plan_key,membership_started_at,membership_ends_at,payment_status,amount_paid,currency';
  const rows = [];
  for (let n = 1; n <= 2; n += 1) rows.push(`,Ess${n},Synthetic,${essEmail(n)},Essentials,5/10/2035,7/8/2035,Paid,1499,PHP`);
  return [head, ...rows].join('\n');
}

function roster() {
  const head = 'thinkific_user_id,first_name,last_name,email,plan_key,membership_started_at,membership_ends_at,payment_status,amount_paid,currency,legacy_enrollments,batch_code';
  const rows = [];
  for (let n = 1; n <= 3; n += 1) rows.push(`,May${n},Synthetic,${email(n)},VIP,5/10/2035,11/10/2035,Paid,15999,PHP,${NONCE},May 2035`);
  for (let n = 4; n <= 6; n += 1) rows.push(`,Apr${n},Synthetic,${email(n)},VIP,4/2/2035,10/2/2035,Paid,15999,PHP,${NONCE},April 2035`);
  return [head, ...rows].join('\n');
}

before(async () => {
  if (SKIP) return;
  // ★ #69: a Getting Started video left PUBLISHED on shadow (a gettingStarted or onboardingVideo
  //   run that never reached its cleanup) would hold the student below on the Getting Started
  //   screen after "Go To Dashboard", and this suite would time out on a dashboard it never
  //   reaches. Refuse up front, and say why.
  await assertNoLiveOnboardingVideo('legacyMigration.e2etest.mjs');
  people = await ensureUsers([
    { label: 'lm-super', fullName: 'LM Super' }, { label: 'lm-ops', fullName: 'LM Ops' }, { label: 'lm-student', fullName: 'LM Student' },
  ]);
  await runSql(`
    update public.profiles set approval_status = 'approved' where id in (${Object.values(people).map((p) => lit(p.id) + '::uuid').join(',')});
    insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at) values
      (${lit(people['lm-super'].id)}::uuid, 'super_admin', 'active', now(), now()),
      (${lit(people['lm-ops'].id)}::uuid, 'operations_admin', 'active', now(), now())
    on conflict (user_id) do update set role_key = excluded.role_key, status = 'active', activated_at = now();
    insert into public.batches (code, name, status) values ('2035-04', 'April 2035', 'open'), ('2035-05', 'May 2035', 'open'),
      ('2035-06', 'June 2035', 'open'), ('2035-07', 'July 2035', 'open'), ('2035-08', 'August 2035', 'open'),
      ('2035-09', 'September 2035', 'open'), ('2035-10', 'October 2035', 'open')
    on conflict (code) do nothing;`);
  // ★ #68: every month of the May cohort's six-seat run (2035-05 … 2035-10) exists. Were one
  //   missing while any later batch existed — another suite's, say — the preflight would
  //   name it as a batch gap and Activate would stay disabled, which is correct behaviour
  //   and not what this test is about.
  mkdirSync(ART, { recursive: true });
  csvPath = join(ART, `synthetic-roster-${NONCE}.csv`);
  writeFileSync(csvPath, roster());
  essPath = join(ART, `essentials-roster-${NONCE}.csv`);
  writeFileSync(essPath, essentialsRoster());
  app = await startApp();
  browser = await launchChrome();
});

after(async () => {
  if (SKIP) return;
  await browser?.close();
  app?.stop();
});

async function openAs(person, path, { width = 1440, height = 900, railCollapsed = false } = {}) {
  const page = await browser.newPage();
  if (person) await injectSession(page, await signIn(person.email), { railCollapsed });
  await page.setViewport({ width, height });
  await page.goto(app.url + path, { timeoutMs: 180000 });
  return page;
}

/** Click the first enabled button/label whose text starts with `text`. */
const clickText = (page, text, sel = 'button, label') => page.evaluate((t, s) => {
  const el = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().startsWith(t) && !x.disabled);
  if (!el) return false;
  el.click();
  return true;
}, text, sel);

async function typeInto(page, selector, text) {
  const ok = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.focus(); if (el.select) el.select(); return true; }, selector);
  assert.ok(ok, `no ${selector}`);
  await page.send('Input.insertText', { text });
  await tick(150);
}

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const bodyHas = (page, text) => page.evaluate((t) => document.body.textContent.includes(t), text);
const pageErrors = (page) => page.problems.filter((p) => p.kind === 'exception'
  || (p.kind === 'console.error' && !/favicon|Failed to load resource/i.test(p.text)));

test('a Super Admin stages, assigns terms and activates; the student sets up, sees a summary, reaches the dashboard',
  { skip: SKIP || false, timeout: 15 * 60 * 1000 }, async () => {
    const page = await openAs(people['lm-super'], '/admin/student-imports');
    await page.waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Stage a roster')), [],
      { timeoutMs: 180000, what: 'the workspace' });
    assert.ok(await noHorizontalScroll(page), 'the jobs list scrolls sideways');

    // ── 1. Stage ──
    assert.ok(await clickText(page, 'Stage a roster'));
    await page.waitFor(() => !!document.querySelector('input[type=file]'), [], { what: 'the file picker' });
    const { root } = await page.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [csvPath] });
    await page.waitFor(() => document.body.textContent.includes('Declare the date format'), [], { timeoutMs: 30000, what: 'the date-format step' });
    assert.equal(await page.evaluate(() => !!document.querySelector('input[name="migration-date-format"]:checked')), false,
      'no date format may be pre-selected');
    await page.evaluate(() => document.querySelector('input[name="migration-date-format"][value="M/D/YYYY"]').click());
    await page.waitFor(() => document.body.textContent.includes('Confirm packages and batches'), [], { what: 'the mapping step' });
    // The suggestions are visible and pre-filled: VIP → vip, and each month label → its batch.
    // They fill as soon as the plan catalog and the batch registry have loaded, which on a
    // cold dev server can land after the file does — so wait for them rather than read once.
    await page.waitFor(() => {
      const s = [...document.querySelectorAll('select[aria-label^="Plan for"], select[aria-label^="Batch for"]')];
      return s.length === 3 && s.every((x) => x.value);
    }, [], { timeoutMs: 30000, what: 'the pre-filled mapping suggestions' });
    const mapped = await page.evaluate(() => [...document.querySelectorAll('select[aria-label^="Plan for"], select[aria-label^="Batch for"]')]
      .map((s) => [s.getAttribute('aria-label'), s.value]));
    assert.deepEqual(Object.fromEntries(mapped), { 'Plan for VIP': 'vip', 'Batch for May 2035': '2035-05', 'Batch for April 2035': '2035-04' });
    await page.waitFor(() => document.body.textContent.includes('Choose what can be activated'), [], { what: 'the cohort step' });
    const ticked = await page.evaluate(() => [...document.querySelectorAll('label')].filter((l) => /2035/.test(l.textContent) && l.querySelector('input[type=checkbox]'))
      .map((l) => [l.textContent.trim(), l.querySelector('input').checked]));
    assert.deepEqual(Object.fromEntries(ticked), { 'May 2035': true, 'April 2035': false }, 'only the newest cohort is pre-selected');
    await page.evaluate(() => [...document.querySelectorAll('label')].find((l) => l.textContent.includes('I have checked the date format')).querySelector('input').click());
    assert.ok(await clickText(page, 'Stage 6 rows'));
    await page.waitFor(() => document.body.textContent.includes('Select all ready in this view'), [], { timeoutMs: 60000, what: 'the staged job' });
    jobUrl = await page.evaluate(() => location.pathname + location.search);
    assert.match(jobUrl, /\?job=[0-9a-f-]{36}/);

    // ── 2. A refresh reopens the same job ──
    await page.goto(app.url + jobUrl, { timeoutMs: 120000 });
    await page.waitFor(() => document.body.textContent.includes('Select all ready in this view'), [], { timeoutMs: 120000, what: 'the reopened job' });
    // The rows and the job summary load in parallel, and the summary (cohorts, runs, invites)
    // is the slower of the two — so wait for its header rather than read the page once.
    await page.waitFor((f) => document.body.textContent.includes(f), [`synthetic-roster-${NONCE}.csv`],
      { timeoutMs: 60000, what: 'the reopened job header' });

    // ── 3. Select all ready → exactly the three May rows ──
    assert.ok(await clickText(page, 'Select all ready in this view'));
    await page.waitFor(() => /3 selected/.test(document.body.textContent), [], { what: 'three selected' });
    assert.ok(await clickText(page, 'Activate 3'));
    // Step 1: the terms. The May 2035 start is ahead, so "open access today" is offered ticked.
    await page.waitFor(() => document.body.textContent.includes('Activate students · 1 of 2')
      && document.body.textContent.includes('Open access today'), [], { timeoutMs: 60000, what: 'the terms step' });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] label')]
      .find((l) => l.textContent.includes('Open access today')).querySelector('input').checked), true,
      'opening access today is the default for a start still ahead');
    assert.equal(await page.evaluate(() => !!document.getElementById('migration-phrase')), false,
      'no typed phrase on the terms step — nothing can be created from it');
    // #68: seats follow the PAID term — May 10 → Nov 10 is six months, so six cohort seats.
    assert.ok(await bodyHas(page, '6 cohort seats, from May 2035 onwards'), 'the seat count is shown for a VIP group');
    assert.ok(await clickText(page, 'Continue'));
    await page.waitFor(() => !!document.getElementById('migration-phrase'), [], { timeoutMs: 60000, what: 'the confirmation' });
    await page.waitFor(() => document.body.textContent.includes('Will be activated'), [], { timeoutMs: 60000, what: 'the preflight counts' });
    assert.ok(await bodyHas(page, 'No enrollment request, receipt or payment record is created'));
    const disabledBefore = await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Activate 3' && b.closest('[role="dialog"]')).disabled);
    assert.equal(disabledBefore, true, 'confirm stays disabled until the phrase is typed');
    await typeInto(page, '#migration-phrase', 'ACTIVATE 3');
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Activate 3').click());

    // ── 4. The refused sender stops the run after ONE grant (#68's circuit breaker) ──
    // ★ Wait on the DATABASE, then look at the page. "Invitation failed" is also the label of
    //   a filter chip, so counting page text is not evidence of anything.
    const FILE = `synthetic-roster-${NONCE}.csv`;
    const countIn = (state) => scalar(`select count(*) from public.student_import_rows r
      join public.student_import_jobs j on j.id = r.job_id
      where j.filename = ${lit(FILE)} and r.activation_state = ${lit(state)}`).then(Number);
    const runStatus = () => scalar(`select r.status from public.student_import_activation_runs r
      join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(FILE)}
      order by r.created_at desc limit 1`);
    const until = Date.now() + 240000;
    for (let done = await countIn('activated'); done < 1; done = await countIn('activated')) {
      assert.ok(Date.now() < until, 'no row was activated within 240s');
      await tick(3000);
    }
    await page.waitFor(() => document.body.textContent.includes('Resend refused the sender')
      && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Resume activation'), [],
    { timeoutMs: 120000, what: 'the stopped run, and why, on screen' });
    await tick(3000);
    assert.equal(await countIn('activated'), 1, 'the breaker grants at most one student without an email');
    assert.equal(await countIn('ready'), 2, 'the other May rows were never claimed');
    assert.equal(await countIn('inactive'), 3, 'the April rows were never touched');
    assert.equal(await runStatus(), 'paused', 'the server paused the run');
    const owed = (await runSql(`select r.invite_state, r.invite_code, r.invite_generation from public.student_import_rows r
      join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(FILE)} and r.activation_state = 'activated'`))[0];
    assert.equal(owed.invite_state, 'not_sent', 'a 401 proves nothing went out, so the email goes back in the queue');
    assert.equal(owed.invite_code, 'resend_401');
    const statuses = await runSql(`select s.status, to_char(s.ends_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as ends
      from public.subscriptions s join public.student_import_rows r on r.id = s.source_import_row_id
      join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(FILE)}`);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, 'active', 'access opens on the activation day');
    assert.equal(statuses[0].ends, '2035-11-10', 'the paid end date never moves');

    // Resume: the OWED email goes first. Still refused, so the run stops again having
    // granted nobody new — pressing Resume while the sender is being fixed costs nothing.
    assert.ok(await clickText(page, 'Resume activation'));
    const untilResend = Date.now() + 120000;
    while (Number(await scalar(`select r.invite_generation from public.student_import_rows r
      join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(FILE)} and r.activation_state = 'activated'`)) <= Number(owed.invite_generation)) {
      assert.ok(Date.now() < untilResend, 'Resume did not try the owed email');
      await tick(2000);
    }
    await page.waitFor(() => document.body.textContent.includes('Resend refused the sender')
      && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Resume activation'), [],
    { timeoutMs: 120000, what: 'the run stopped again' });
    await tick(2000);
    assert.equal(await countIn('activated'), 1, 'Resume granted nobody new while the sender is refused');
    assert.equal(await countIn('ready'), 2);
    assert.equal(await runStatus(), 'paused');
    await page.screenshot(join(ART, `job-${NONCE}.png`));
    assert.deepEqual(pageErrors(page), [], 'the workspace raised errors');
    await page.close();

    // ── 5. The claim ──
    const env = shadowEnv();
    const svc = createClient(env.SHADOW_SUPABASE_URL, env.SHADOW_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: link, error: linkErr } = await svc.auth.admin.generateLink({ type: 'magiclink', email: email(1) });
    assert.equal(linkErr, null, linkErr && linkErr.message);
    const claim = await openAs(null, `/activate-account#claim=${encodeURIComponent(link.properties.hashed_token)}&t=magiclink`, { width: 390, height: 844 });
    await claim.waitFor(() => document.body.textContent.includes('Activate your account'), [], { timeoutMs: 120000, what: 'the activation screen' });
    assert.equal(await claim.evaluate(() => location.hash), '', 'the token is stripped from the address bar at once');
    assert.ok(await bodyHas(claim, 'already paid'));
    assert.ok(await clickText(claim, 'Activate my account'));
    await claim.waitFor(() => !!document.getElementById('setup-email'), [], { timeoutMs: 60000, what: 'the account page' });
    const form = await claim.evaluate(() => ({
      name: document.getElementById('setup-name').value,
      email: document.getElementById('setup-email').value,
      locked: document.getElementById('setup-email').readOnly,
    }));
    assert.equal(form.name, 'May1 Synthetic', 'the name is prefilled');
    assert.equal(form.email, email(1), "the email is the account's own");
    assert.equal(form.locked, true, 'and it is locked');
    await typeInto(claim, '#setup-password', `Claim-${NONCE}-Passw0rd!`);
    await typeInto(claim, '#setup-confirm', 'something-else-entirely');
    assert.ok(await clickText(claim, 'Create my account'));
    await claim.waitFor(() => document.body.textContent.includes('The two passwords do not match.'), [], { what: 'the mismatch refusal' });
    await typeInto(claim, '#setup-confirm', `Claim-${NONCE}-Passw0rd!`);
    assert.ok(await clickText(claim, 'Create my account'));
    await claim.waitFor(() => document.body.textContent.includes('Go To Dashboard'), [], { timeoutMs: 60000, what: 'the onboarding summary' });
    await claim.waitFor(() => document.body.textContent.includes('May 2035') && document.body.textContent.includes('Active'),
      [], { timeoutMs: 30000, what: 'the summary facts' });
    for (const label of ['Package', 'Subscription status', 'Subscription expiry']) assert.ok(await bodyHas(claim, label), label);
    assert.ok(await bodyHas(claim, 'November 10, 2035'), 'the expiry is the paid end date');
    assert.ok(!(await bodyHas(claim, '₱')), 'no price on the summary');
    assert.ok(await noHorizontalScroll(claim), 'the summary scrolls sideways on a phone');
    await claim.screenshot(join(ART, `summary-${NONCE}.png`));
    assert.ok(await clickText(claim, 'Go To Dashboard'));
    await claim.waitFor(() => !!document.querySelector('nav[aria-label="Main navigation"]'), [], { timeoutMs: 60000, what: 'the dashboard' });
    assert.equal(await claim.evaluate(() => location.pathname), '/', 'Go To Dashboard leaves the activation path');
    assert.ok(!(await bodyHas(claim, 'Choose a package')), 'no payment prompt for a migrated student');
    const prof = (await runSql(`select onboarding_status, full_name from public.profiles where lower(email) = lower(${lit(email(1))})`))[0];
    assert.equal(prof.onboarding_status, 'completed');
    assert.equal(prof.full_name, 'May1 Synthetic');
    await claim.screenshot(join(ART, `dashboard-${NONCE}.png`));
    assert.deepEqual(pageErrors(claim), [], 'the activation flow raised errors');
    await claim.close();
  });

// #68: a Silver or Essentials export has no cohort, and #67 demanded a batch at every layer —
// the wizard stopped at step 2, and a row that got past it had a NULL purchase key.
test('(#68) an Essentials roster with no batch column stages Ready by its package and activates with no cohort seat',
  { skip: SKIP || false, timeout: 12 * 60 * 1000 }, async () => {
    const FILE = `essentials-roster-${NONCE}.csv`;
    const page = await openAs(people['lm-super'], '/admin/student-imports');
    await page.waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Stage a roster')), [],
      { timeoutMs: 180000, what: 'the workspace' });

    // ── Stage: nothing asks for a batch ──
    assert.ok(await clickText(page, 'Stage a roster'));
    await page.waitFor(() => !!document.querySelector('input[type=file]'), [], { what: 'the file picker' });
    const { root } = await page.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [essPath] });
    // Step 3 renders only once step 2 has nothing missing: with no batch column, that is
    // the proof the batch is not a required column any more.
    await page.waitFor(() => document.body.textContent.includes('Declare the date format'), [], { timeoutMs: 30000, what: 'the date-format step' });
    await page.evaluate(() => document.querySelector('input[name="migration-date-format"][value="M/D/YYYY"]').click());
    await page.waitFor(() => document.body.textContent.includes('Confirm packages and batches'), [], { what: 'the mapping step' });
    await page.waitFor(() => document.querySelector('select[aria-label="Plan for Essentials"]')?.value === 'sampler', [],
      { timeoutMs: 30000, what: 'the Essentials label suggested as the sampler package' });
    assert.equal(await page.evaluate(() => document.querySelectorAll('select[aria-label^="Batch for"]').length), 0,
      'no batch mapping is asked for');
    assert.ok(!(await bodyHas(page, 'which needs a batch')), 'no VIP batch warning for a self-paced roster');

    // ── Step 5: Ready by the package tick, pre-ticked ──
    await page.waitFor(() => document.body.textContent.includes('Choose what can be activated'), [], { what: 'the activation step' });
    assert.ok(await bodyHas(page, 'Self-paced packages'));
    assert.ok(!(await bodyHas(page, 'VIP cohorts')), 'no cohort table for a roster with no VIP rows');
    assert.equal(await page.evaluate(() => document.querySelector('input[aria-label="Rows of Essentials can be activated"]')?.checked), true,
      'every self-paced package in the file is pre-ticked');
    assert.ok(!(await bodyHas(page, 'Why rows are blocked')), 'nothing is blocked');
    await page.evaluate(() => [...document.querySelectorAll('label')].find((l) => l.textContent.includes('I have checked the date format')).querySelector('input').click());
    assert.ok(await clickText(page, 'Stage 2 rows'));
    await page.waitFor(() => document.body.textContent.includes('Select all ready in this view'), [], { timeoutMs: 60000, what: 'the staged job' });

    const staged = await runSql(`select r.validation_status, r.activation_state, r.proposed_plan_key, r.proposed_batch_id,
        r.legacy_record_key is not null as keyed, array_to_string(j.eligible_plan_keys, ',') as plan_ticks
      from public.student_import_rows r join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(FILE)}`);
    assert.equal(staged.length, 2);
    for (const r of staged) {
      assert.equal(r.validation_status, 'valid');
      assert.equal(r.activation_state, 'ready', 'Ready through the package tick, not a cohort');
      assert.equal(r.proposed_plan_key, 'sampler');
      assert.equal(r.proposed_batch_id, null, 'a self-paced row holds no batch');
      assert.equal(r.keyed, true, 'a valid row always carries its purchase key');
    }
    assert.equal(staged[0].plan_ticks, 'sampler', 'the tick is stored on the job');
    await page.waitFor(() => document.body.textContent.includes('Self-paced (no cohort)'), [], { timeoutMs: 60000, what: 'the job summary' });

    // ── Activate: one grant, no cohort seat, and the refused sender stops the run ──
    assert.ok(await clickText(page, 'Select all ready in this view'));
    await page.waitFor(() => /2 selected/.test(document.body.textContent), [], { what: 'two selected' });
    assert.ok(await clickText(page, 'Activate 2'));
    await page.waitFor(() => document.body.textContent.includes('Activate students · 1 of 2')
      && document.body.textContent.includes('Self-paced, no cohort'), [], { timeoutMs: 60000, what: 'the terms step' });
    assert.equal(await page.evaluate(() => /\d+ cohort seats?, from/.test(document.body.textContent)), false,
      'no cohort seats are promised to a self-paced package');
    assert.ok(await clickText(page, 'Continue'));
    await page.waitFor(() => !!document.getElementById('migration-phrase'), [], { timeoutMs: 60000, what: 'the confirmation' });
    await page.waitFor(() => document.body.textContent.includes('Will be activated'), [], { timeoutMs: 60000, what: 'the preflight counts' });
    assert.ok(!(await bodyHas(page, 'No batch exists yet for')), 'a self-paced run can never have a batch gap');
    await typeInto(page, '#migration-phrase', 'ACTIVATE 2');
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Activate 2').click());

    const activated = () => scalar(`select count(*) from public.student_import_rows r join public.student_import_jobs j on j.id = r.job_id
      where j.filename = ${lit(FILE)} and r.activation_state = 'activated'`).then(Number);
    const until = Date.now() + 240000;
    while (await activated() < 1) {
      assert.ok(Date.now() < until, 'no Essentials row was activated within 240s');
      await tick(3000);
    }
    await page.waitFor(() => document.body.textContent.includes('Resend refused the sender'), [],
      { timeoutMs: 120000, what: 'the stopped run on screen' });
    await tick(2000);
    assert.equal(await activated(), 1, 'the breaker stops a self-paced run after one grant too');
    const subs = await runSql(`select s.plan_key, s.batch_id, s.status, s.grant_source,
        to_char(s.ends_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as ends,
        (select count(*) from public.batch_entitlements be where be.user_id = s.user_id) as seats
      from public.subscriptions s join public.student_import_rows r on r.id = s.source_import_row_id
      join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(FILE)}`);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].plan_key, 'sampler');
    assert.equal(subs[0].batch_id, null, 'no batch on a self-paced term');
    assert.equal(Number(subs[0].seats), 0, 'no cohort seat is granted');
    assert.equal(subs[0].status, 'active', 'access opens on the activation day');
    assert.equal(subs[0].grant_source, 'import');
    assert.equal(subs[0].ends, '2035-07-08', 'the paid end date never moves');
    await page.screenshot(join(ART, `essentials-${NONCE}.png`));
    assert.deepEqual(pageErrors(page), [], 'the workspace raised errors');
    await page.close();
  });

test('an Operations Admin and a student are refused, and fire no migration RPC', { skip: SKIP || false, timeout: 5 * 60 * 1000 }, async () => {
  for (const who of ['lm-ops', 'lm-student']) {
    const page = await openAs(people[who], '/admin/student-imports');
    await tick(4000);
    const rpc = page.requests.filter((r) => /\/rest\/v1\/rpc\/legacy_import_/.test(r.url || '') || /\/api\/admin\/student-imports/.test(r.url || ''));
    assert.deepEqual(rpc, [], `${who} triggered migration requests`);
    assert.ok(!(await bodyHas(page, 'Stage a roster')), `${who} must not see the workspace`);
    await page.close();
  }
});

test('the workspace fits every width, with the sidebar open or collapsed', { skip: SKIP || false, timeout: 6 * 60 * 1000 }, async () => {
  for (const [w, h, collapsed] of [[390, 844, false], [1024, 768, false], [1280, 720, false], [1280, 720, true], [1920, 1080, false]]) {
    const page = await openAs(people['lm-super'], jobUrl || '/admin/student-imports', { width: w, height: h, railCollapsed: collapsed });
    await page.waitFor(() => document.body.textContent.includes('Student Imports'), [], { timeoutMs: 120000, what: 'the tab' });
    await tick(1500);
    assert.ok(await noHorizontalScroll(page), `${w}x${h} ${collapsed ? 'rail' : 'open'} scrolls sideways`);
    await page.screenshot(join(ART, `fit-${w}x${h}-${collapsed ? 'rail' : 'open'}.png`));
    await page.close();
  }
});
