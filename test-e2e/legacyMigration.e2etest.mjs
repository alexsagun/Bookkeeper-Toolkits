// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/legacyMigration.e2etest.mjs — the legacy migration, driven in a real browser (#67).
// ─────────────────────────────────────────────────────────────────────────────
// The real app, served by Vite against the SHADOW project, with every mail/AI/Zoom key
// pinned dead by _app.mjs — so an "invitation" here is refused by the provider and the
// row ends as "Invitation failed", which is itself one of the states this suite checks.
//
//   1. A Super Admin uploads a SYNTHETIC roster (6 rows, two cohorts), declares the date
//      format, confirms the mappings and stages it. Only the newest cohort is ready.
//   2. A refresh reopens the same job from the URL.
//   3. "Select all ready" selects the ready rows only. Step 1 of the dialog assigns the
//      terms — a start still ahead is opened TODAY, the paid end kept — and step 2 needs
//      the typed phrase.
//   4. The run completes; every activated row shows its (failed) invitation, and every
//      membership is ACTIVE, not scheduled.
//   5. A student activates their account through a link minted here: their name is
//      prefilled, their email locked, a mismatched confirmation refused. The summary shows
//      their membership, and Go To Dashboard reaches the dashboard — never a price.
//   6. An Operations Admin and a student get "Super Admin only" and fire no migration RPC.
//   7. The workspace never scrolls sideways at a phone width or with the sidebar open.
// ─────────────────────────────────────────────────────────────────────────────

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { launchChrome } from './_cdp.mjs';
import { ensureUsers, injectSession, lit, runSql, scalar, shadowEnv, signIn, skipReason, startApp } from './_app.mjs';
import { REPO_ROOT } from '../scripts/_shadow.mjs';

const SKIP = skipReason();
const NONCE = randomBytes(3).toString('hex');
const ART = join(REPO_ROOT, 'test-e2e', '.artifacts', 'legacy-migration');
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const email = (n) => `e2e-lm-${NONCE}-r${n}@shadow.test`;

let app; let browser; let people; let csvPath; let jobUrl;

function roster() {
  const head = 'thinkific_user_id,first_name,last_name,email,plan_key,membership_started_at,membership_ends_at,payment_status,amount_paid,currency,legacy_enrollments,batch_code';
  const rows = [];
  for (let n = 1; n <= 3; n += 1) rows.push(`,May${n},Synthetic,${email(n)},VIP,5/10/2035,11/10/2035,Paid,15999,PHP,${NONCE},May 2035`);
  for (let n = 4; n <= 6; n += 1) rows.push(`,Apr${n},Synthetic,${email(n)},VIP,4/2/2035,10/2/2035,Paid,15999,PHP,${NONCE},April 2035`);
  return [head, ...rows].join('\n');
}

before(async () => {
  if (SKIP) return;
  people = await ensureUsers([
    { label: 'lm-super', fullName: 'LM Super' }, { label: 'lm-ops', fullName: 'LM Ops' }, { label: 'lm-student', fullName: 'LM Student' },
  ]);
  await runSql(`
    update public.profiles set approval_status = 'approved' where id in (${Object.values(people).map((p) => lit(p.id) + '::uuid').join(',')});
    insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at) values
      (${lit(people['lm-super'].id)}::uuid, 'super_admin', 'active', now(), now()),
      (${lit(people['lm-ops'].id)}::uuid, 'operations_admin', 'active', now(), now())
    on conflict (user_id) do update set role_key = excluded.role_key, status = 'active', activated_at = now();
    insert into public.batches (code, name, status) values ('2035-04', 'April 2035', 'open'), ('2035-05', 'May 2035', 'open')
    on conflict (code) do nothing;`);
  mkdirSync(ART, { recursive: true });
  csvPath = join(ART, `synthetic-roster-${NONCE}.csv`);
  writeFileSync(csvPath, roster());
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
    await page.waitFor(() => document.body.textContent.includes('Confirm plans and batches'), [], { what: 'the mapping step' });
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
    assert.ok(await clickText(page, 'Continue'));
    await page.waitFor(() => !!document.getElementById('migration-phrase'), [], { timeoutMs: 60000, what: 'the confirmation' });
    await page.waitFor(() => document.body.textContent.includes('Will be activated'), [], { timeoutMs: 60000, what: 'the preflight counts' });
    assert.ok(await bodyHas(page, 'No enrollment request, receipt or payment record is created'));
    const disabledBefore = await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Activate 3' && b.closest('[role="dialog"]')).disabled);
    assert.equal(disabledBefore, true, 'confirm stays disabled until the phrase is typed');
    await typeInto(page, '#migration-phrase', 'ACTIVATE 3');
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Activate 3').click());

    // ── 4. The run completes; the dead mail key makes every invitation fail, visibly ──
    // ★ Wait on the DATABASE, then look at the page. "Invitation failed" is also the label of
    //   a filter chip, so counting that text finished one row early and read the
    //   subscriptions while the third was still being granted.
    const activatedCount = () => scalar(`select count(*) from public.student_import_rows r
      join public.student_import_jobs j on j.id = r.job_id
      where j.filename = ${lit(`synthetic-roster-${NONCE}.csv`)} and r.activation_state = 'activated'`).then(Number);
    const until = Date.now() + 240000;
    for (let done = await activatedCount(); done < 3; done = await activatedCount()) {
      assert.ok(Date.now() < until, `only ${done} of 3 rows were activated within 240s`);
      await tick(3000);
    }
    await page.waitFor(() => !/Activating/.test(document.body.textContent)
      && (document.body.textContent.match(/Invitation failed/g) || []).length >= 3, [],
    { timeoutMs: 120000, what: 'the finished run on screen' });
    const inactiveStill = Number(await scalar(`select count(*) from public.student_import_rows r join public.student_import_jobs j on j.id = r.job_id
      where j.filename = ${lit(`synthetic-roster-${NONCE}.csv`)} and r.activation_state = 'inactive'`));
    assert.equal(inactiveStill, 3, 'the April rows were never touched');
    const statuses = await runSql(`select s.status, to_char(s.ends_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as ends
      from public.subscriptions s join public.student_import_rows r on r.id = s.source_import_row_id
      join public.student_import_jobs j on j.id = r.job_id where j.filename = ${lit(`synthetic-roster-${NONCE}.csv`)}`);
    assert.equal(statuses.length, 3);
    for (const s of statuses) {
      assert.equal(s.status, 'active', 'access opens on the activation day');
      assert.equal(s.ends, '2035-11-10', 'the paid end date never moves');
    }
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
    for (const label of ['Membership plan', 'Subscription status', 'Subscription expiry']) assert.ok(await bodyHas(claim, label), label);
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
