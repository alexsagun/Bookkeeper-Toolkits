// Run with: node --test
// planScopeAllows() is the PURE mirror of the SQL plan-scope truth table used by
// courses_read (bootstrap §14) and trainer_visible_courses / trainer_courses_for_plan
// (migration #27). If entitlements change, this table, the SQL, and
// PLAN_ENTITLEMENTS in src/BookkeeperPro.jsx must all change together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScopeAllows } from '../src/lib/trainerContent.js';

const QBO_STANDARD = { slug: 'qbo-mastery', access_tier: 'standard' };
const QBO_ESSENTIALS = { slug: 'qbo-essentials', access_tier: 'essentials' };
const RESUME = { slug: 'resume-strategy', access_tier: 'standard' };
const INTERVIEW = { slug: 'interview-winning-strategy', access_tier: 'standard' };

test('core_self_paced reads qbo-* only (any tier)', () => {
  assert.equal(planScopeAllows('core_self_paced', QBO_STANDARD), true);
  assert.equal(planScopeAllows('core_self_paced', QBO_ESSENTIALS), true);
  assert.equal(planScopeAllows('core_self_paced', RESUME), false);
  assert.equal(planScopeAllows('core_self_paced', INTERVIEW), false);
});

test('sampler reads only qbo-* essentials — MORE restricted than core despite higher price', () => {
  assert.equal(planScopeAllows('sampler', QBO_ESSENTIALS), true);
  assert.equal(planScopeAllows('sampler', QBO_STANDARD), false);   // Mastery is standard-tier
  assert.equal(planScopeAllows('sampler', RESUME), false);
  assert.equal(planScopeAllows('sampler', INTERVIEW), false);
});

test('full/unknown/legacy plans read everything (null plan = grandfathered full access)', () => {
  for (const plan of ['silver_self_paced', 'gold_live', 'vip', 'some_future_plan', null, undefined]) {
    for (const course of [QBO_STANDARD, QBO_ESSENTIALS, RESUME, INTERVIEW]) {
      assert.equal(planScopeAllows(plan, course), true, `${plan} × ${course.slug}`);
    }
  }
});

test('missing access_tier defaults to standard (sampler must NOT read it)', () => {
  assert.equal(planScopeAllows('sampler', { slug: 'qbo-new-course' }), false);
  assert.equal(planScopeAllows('core_self_paced', { slug: 'qbo-new-course' }), true);
});
