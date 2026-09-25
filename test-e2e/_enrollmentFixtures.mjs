// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/_enrollmentFixtures.mjs — every state an Enrollments card can be in.
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic data for the rendered layout suite. Each student exists to put ONE
// hard shape on the card: the longest strings a real form allows, every notify
// outcome, every request kind, a hold with a follow-up, an overdue request, every
// membership-strip state, VIP with and without a batch, a row with no receipt, and
// a "grant incomplete" row. Nothing here is a real person, a real payment or a
// real receipt: receipt_path points at objects that do not exist, on purpose — the
// layout needs the Receipt button, not the file.
//
// Written through the Management API as `postgres` (fixture setup is not the thing
// under test). Rows are inserted directly in their final state, so no approval
// trigger fires and no finance entry is posted. Cleanup removes every row these
// users own; the auth users themselves are kept for reuse.
// ─────────────────────────────────────────────────────────────────────────────

import { ensureUsers, lit, runSql } from './_app.mjs';

export const BATCH_CODE = '2031-01';

const LONG = {
  name: 'Maria Concepcion Evangelista-Villanueva de los Santos Bartolome',
  email: 'maria.concepcion.evangelista.villanueva.delossantos@verylongdomain-example.test',
  phone: '+63 (917) 555-0142 ext. 88321',
  city: 'San Jose del Monte City, Bulacan, Central Luzon, Philippines',
  plan: 'Personalized Coaching Program — Extended Cohort Edition (VIP)',
  ref: 'GCASH-REF-2026-09-24-0001234567890-ABCDEFGHIJKLMNOPQRSTUV',
  course: 'BS Business Administration Major in Financial Management and Accounting Information Systems',
  job: 'Social Media Manager and Part-time Virtual Assistant for a US-based e-commerce brand',
  facebook: 'https://www.facebook.com/profile.php?id=100000000000000000&sk=about_contact_and_basic_info',
};

/** label → how that student's request and membership look. */
export const STUDENTS = [
  { label: 'enroll-long', name: LONG.name, req: { plan: 'vip', planName: LONG.plan, email: LONG.email, phone: LONG.phone, city: LONG.city,
      paid: 16999, expected: 16999, ref: LONG.ref, receipt: true, notify: 'sent', kind: 'new', intake: true } },
  { label: 'enroll-mismatch', name: 'Jose Rizal Mercado', req: { plan: 'sampler', paid: 1000, expected: 1499, receipt: true,
      notify: 'provider_error', notifyDetail: 'resend_422', kind: 'renewal', phone: '0917 555 0100', city: 'Quezon City' },
    sub: { plan: 'sampler', endsInDays: 40 } },
  { label: 'enroll-overdue', name: 'Andres Bonifacio', req: { plan: 'silver_self_paced', paid: 2999, expected: 2999, receipt: false,
      notify: 'email_not_configured', kind: 'upgrade', overdue: true, phone: null, city: null },
    sub: { plan: 'sampler', endsInDays: -5 } },
  { label: 'enroll-hold', name: 'Gabriela Silang', req: { plan: 'sampler', paid: 1499, expected: 1499, receipt: true,
      notify: 'admin_email_invalid', kind: 'new', hold: { reason: 'Waiting for the bank to confirm the transfer reference.', followUpToday: true },
      phone: '0918 555 0101', city: 'Vigan, Ilocos Sur' } },
  { label: 'enroll-extension', name: 'Apolinario Mabini', req: { plan: 'silver_self_paced', paid: 4500, expected: 4500, receipt: true,
      notify: 'email_from_not_configured', kind: 'extension', extensionDays: 90, phone: '0919 555 0102', city: 'Tanauan, Batangas' },
    sub: { plan: 'silver_self_paced', endsInDays: 10 } },
  { label: 'enroll-vipnobatch', name: 'Melchora Aquino', req: { plan: 'vip', paid: 16999, expected: 16999, receipt: true,
      notify: 'sent', kind: 'renewal', phone: '0920 555 0103', city: 'Caloocan' },
    sub: { plan: 'vip', endsInDays: 100 } },
  { label: 'enroll-vipgrace', name: 'Emilio Aguinaldo', req: { plan: 'vip', paid: 16999, expected: 16999, receipt: true,
      notify: 'sent', kind: 'renewal', phone: '0921 555 0104', city: 'Kawit, Cavite' },
    sub: { plan: 'vip', endsInDays: -1, graceDays: 2, batch: true } },
  { label: 'enroll-short', name: 'Ana Cruz', req: { plan: 'sampler', paid: 1499, expected: 1499, receipt: true, notify: 'sent',
      kind: 'new', phone: '0922 555 0105', city: 'Cebu' } },
  { label: 'enroll-grant', name: 'Juan Luna', req: { plan: 'sampler', paid: 1499, expected: 1499, receipt: true, notify: 'sent',
      kind: 'new', status: 'approved', phone: '0923 555 0106', city: 'Badoc' }, isPaid: false },
  { label: 'enroll-rejected', name: 'Teresa Magbanua', req: { plan: 'silver_self_paced', paid: 2999, expected: 2999, receipt: true,
      notify: 'sent', kind: 'new', status: 'rejected', reason: 'Receipt unreadable — please upload a clearer screenshot of the GCash confirmation.',
      phone: '0924 555 0107', city: 'Pototan, Iloilo' } },
  { label: 'enroll-expiredreq', name: 'Diego Silang', req: { plan: 'sampler', paid: 1499, expected: 1499, receipt: true, notify: 'sent',
      kind: 'new', status: 'expired', phone: '0925 555 0108', city: 'Aringay' } },
  { label: 'enroll-ended', name: 'Francisco Balagtas', req: { plan: 'sampler', paid: 1499, expected: 1499, receipt: true, notify: 'sent',
      kind: 'new', status: 'approved', ageDays: 80, phone: '0926 555 0109', city: 'Bulakan' },
    sub: { plan: 'sampler', endsInDays: -10, fromRequest: true } },
  { label: 'enroll-active', name: 'Josefa Llanes Escoda', req: { plan: 'silver_self_paced', paid: 2999, expected: 2999, receipt: true,
      notify: 'sent', kind: 'new', status: 'approved', ageDays: 10, phone: '0927 555 0110', city: 'Dingras' },
    sub: { plan: 'silver_self_paced', endsInDays: 50, fromRequest: true } },
];

const PLAN_NAMES = { sampler: 'Sampler Session', silver_self_paced: 'QBO + Resume Combo', vip: 'Personalized Coaching Program' };

/** Create (or reuse) every persona. Returns { staff: {super, ops}, students: {label → user} }. */
export async function ensureEnrollmentPersonas() {
  const users = await ensureUsers([
    { label: 'enroll-super', fullName: 'E2E Super Admin' },
    { label: 'enroll-ops', fullName: 'E2E Operations Admin' },
    { label: 'enroll-trainer', fullName: 'E2E Trainer' },
    ...STUDENTS.map((s) => ({ label: s.label, fullName: s.name })),
  ]);
  const students = Object.fromEntries(STUDENTS.map((s) => [s.label, users[s.label]]));
  return {
    staff: { superAdmin: users['enroll-super'], ops: users['enroll-ops'], trainer: users['enroll-trainer'] },
    students,
  };
}

/** Remove every row the fixture users own. Idempotent. */
export async function cleanupEnrollmentFixtures() {
  await runSql(`
    do $clean$
    declare v_ids uuid[];
    begin
      select coalesce(array_agg(id), '{}') into v_ids from auth.users where email like 'e2e-enroll-%@shadow.test';
      delete from public.batch_entitlements where user_id = any(v_ids);
      delete from public.enrollment_requests where user_id = any(v_ids);
      delete from public.subscriptions where user_id = any(v_ids);
      delete from public.staff_memberships where user_id = any(v_ids);
      -- The #32 trigger gave the batch a VIP space; its FK does not cascade from batches,
      -- so the space goes first (its channels and categories cascade from it).
      delete from public.community_spaces
       where batch_id in (select id from public.batches where code = ${lit(BATCH_CODE)});
      delete from public.batches where code = ${lit(BATCH_CODE)};
    end
    $clean$;`);
}

/** Seed the full fixture set in ONE Management API round trip (each costs ~4s). */
export async function seedEnrollmentFixtures(personas) {
  await cleanupEnrollmentFixtures();
  const { staff, students } = personas;
  const stmts = [];

  // Staff: real memberships, so has_staff_permission() answers exactly as in production.
  // The staff_sync_is_admin trigger sets profiles.is_admin for the Super Admin only.
  for (const [u, role] of [[staff.superAdmin, 'super_admin'], [staff.ops, 'operations_admin'], [staff.trainer, 'trainer']]) {
    stmts.push(`update public.profiles set full_name = ${lit(u.fullName)}, approval_status = 'approved' where id = '${u.id}';`);
    stmts.push(`insert into public.staff_memberships (user_id, role_key, status, activated_at, invited_at)
      values ('${u.id}', ${lit(role)}, 'active', now(), now())
      on conflict (user_id) do update set role_key = excluded.role_key, status = 'active', activated_at = now(), updated_at = now();`);
  }

  stmts.push(`insert into public.batches (code, name, status) values (${lit(BATCH_CODE)}, 'E2E Batch 2031-01', 'open') on conflict (code) do nothing;`);

  for (const s of STUDENTS) {
    const u = students[s.label];
    const r = s.req;
    const status = r.status || 'pending_review';
    const created = `now() - interval '${r.ageDays ?? 1} days'`;
    const expires = r.overdue ? `now() - interval '2 days'` : `now() + interval '3 days'`;
    stmts.push(`update public.profiles set full_name = ${lit(s.name)}, approval_status = 'approved',
      is_paid = ${s.isPaid === false ? 'false' : (s.sub && s.sub.endsInDays > 0) || status === 'approved' ? 'true' : 'false'}
      where id = '${u.id}';`);

    if (s.sub && !s.sub.fromRequest) {
      stmts.push(subInsert(u.id, s.sub, 'null'));
    }

    stmts.push(`insert into public.enrollment_requests
      (user_id, plan_key, plan_name, full_name, email, phone, city_country, amount_expected, amount_paid,
       payment_reference, receipt_path, status, expires_at, rejection_reason, reviewed_at,
       notify_status, notified_at, notify_detail, request_kind, extension_days, created_at, updated_at,
       college_course, current_job, ph_experience, us_experience, currently_employed, prior_training, referred_by, intake)
      values ('${u.id}', ${lit(r.plan)}, ${lit(r.planName || PLAN_NAMES[r.plan])}, ${lit(s.name)}, ${lit(r.email || u.email)},
       ${lit(r.phone)}, ${lit(r.city)}, ${r.expected}, ${r.paid},
       ${lit(r.ref || null)}, ${r.receipt ? lit(`${u.id}/receipt-e2e-fixture.png`) : 'null'}, ${lit(status)}, ${expires},
       ${lit(r.reason || null)}, ${status === 'pending_review' ? 'null' : created},
       ${lit(r.notify)}, ${created}, ${lit(r.notifyDetail || null)}, ${lit(r.kind)}, ${r.extensionDays ?? 'null'}, ${created}, ${created},
       ${r.intake ? lit(LONG.course) : 'null'}, ${r.intake ? lit(LONG.job) : 'null'}, ${r.intake ? `'Less than 2 years'` : 'null'},
       ${r.intake ? `'None'` : 'null'}, ${r.intake ? `'YES'` : 'null'}, ${r.intake ? `'No'` : 'null'}, ${r.intake ? `'Alex Sagun'` : 'null'},
       ${r.intake ? lit(JSON.stringify({ facebook_link: LONG.facebook, struggles: '1. Reconciling a bank feed that has duplicates.\n2. Knowing which account a Shopify payout belongs in.\n3. Explaining the monthly close to a client.' })) + '::jsonb' : `'{}'::jsonb`});`);

    if (s.sub && s.sub.fromRequest) {
      stmts.push(subInsert(u.id, s.sub, `(select id from public.enrollment_requests where user_id = '${u.id}' order by created_at desc limit 1)`));
    }

    if (r.hold) {
      stmts.push(`insert into public.enrollment_request_holds (request_id, reason, follow_up_on, held_by, held_by_email)
        select id, ${lit(r.hold.reason)}, ${r.hold.followUpToday ? `(now() at time zone 'Asia/Manila')::date` : 'null'},
               '${staff.ops.id}', ${lit(staff.ops.email)}
          from public.enrollment_requests where user_id = '${u.id}' and status = 'pending_review';`);
    }
  }

  await runSql(`do $seed$ begin
    ${stmts.join('\n    ')}
  end $seed$;`);
}

function subInsert(userId, sub, requestIdSql) {
  const ends = `now() + interval '${sub.endsInDays} days'`;
  const grace = `now() + interval '${sub.endsInDays + (sub.graceDays ?? 3)} days'`;
  const status = sub.endsInDays + (sub.graceDays ?? 3) > 0 ? 'active' : 'expired';
  const batch = sub.batch ? `(select id from public.batches where code = ${lit(BATCH_CODE)})` : 'null';
  return `insert into public.subscriptions (user_id, plan_key, status, started_at, ends_at, grace_ends_at, request_id, batch_id)
    values ('${userId}', ${lit(sub.plan)}, ${lit(status)}, now() - interval '30 days', ${ends}, ${grace}, ${requestIdSql}, ${batch});`;
}
