// Run with: node --test
// planScopeAllows() is the PURE mirror of the SQL plan-scope truth table used by
// courses_read (bootstrap §14) and trainer_visible_courses / trainer_courses_for_plan
// (migration #27). If entitlements change, this table, the SQL, and
// PLAN_ENTITLEMENTS in src/lib/planCatalog.js must all change together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScopeAllows, ENROLLMENT_PLAN_KEYS } from '../src/lib/trainerContent.js';

const QBO_STANDARD = { slug: 'qbo-mastery', access_tier: 'standard' };
const QBO_ESSENTIALS = { slug: 'qbo-essentials', access_tier: 'essentials' };
const RESUME = { slug: 'resume-strategy', access_tier: 'standard' };
const INTERVIEW = { slug: 'interview-winning-strategy', access_tier: 'standard' };

test('sampler is the ONLY scoped plan — qbo-* essentials and nothing else', () => {
  assert.equal(planScopeAllows('sampler', QBO_ESSENTIALS), true);
  assert.equal(planScopeAllows('sampler', QBO_STANDARD), false);   // Mastery is standard-tier
  assert.equal(planScopeAllows('sampler', RESUME), false);
  assert.equal(planScopeAllows('sampler', INTERVIEW), false);
});

test('full/unknown/legacy plans read everything (null plan = grandfathered full access)', () => {
  for (const plan of ['silver_self_paced', 'vip', 'some_future_plan', null, undefined]) {
    for (const course of [QBO_STANDARD, QBO_ESSENTIALS, RESUME, INTERVIEW]) {
      assert.equal(planScopeAllows(plan, course), true, `${plan} × ${course.slug}`);
    }
  }
});

test('missing access_tier defaults to standard (sampler must NOT read it)', () => {
  assert.equal(planScopeAllows('sampler', { slug: 'qbo-new-course' }), false);
  assert.equal(planScopeAllows('silver_self_paced', { slug: 'qbo-new-course' }), true);
});

// #39 deleted core_self_paced and gold_live. planScopeAllows() mirrors the SQL, which
// is permissive for any plan that is not sampler — so the guard that makes a retired
// key unreachable is NOT this function. It is (a) subscriptions.plan_key's FK to
// enrollment_plans (ON DELETE RESTRICT), so no member can hold one, and (b) this
// allowlist, which the admin trainer-preview endpoint validates against.
test('the retired plan keys are not previewable', () => {
  assert.deepEqual([...ENROLLMENT_PLAN_KEYS].sort(), ['sampler', 'silver_self_paced', 'vip']);
  assert.equal(ENROLLMENT_PLAN_KEYS.includes('core_self_paced'), false);
  assert.equal(ENROLLMENT_PLAN_KEYS.includes('gold_live'), false);
});
