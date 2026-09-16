// test/meetingsSql.test.mjs — Meetings & Tasks (#62): the SQL contract (the dated file AND
// the §49 fold), the Zoom handler's gate and invariants, and the permission lockstep.
// Reads files as TEXT, plus the pure error/role mirrors and the handler's own exports; no
// database and no network.
//
// The live behaviour — who is refused, the request key, cancel stopping invitations, the
// finished-meeting and cancelled-meeting refusals — is probed against the production
// catalog in a rolled-back transaction before the migration is applied. This suite pins the
// SHAPE that probe relied on, so a later edit cannot quietly undo it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ERROR_CODES, APP_ERROR_COPY } from '../src/lib/appErrors.js';
import { ADMIN_TAB_PERMISSION, ROLE_PERMISSIONS, STAFF_PERMISSION_KEYS } from '../src/lib/staffRoles.js';
import handler, { safeMeeting, zoomConfigured } from '../api/admin/meetings.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const MIGRATION = 'db/2026-09-17-meetings-tasks.sql';
const BOOTSTRAP = 'db/000_full_database_bootstrap.sql';
const HANDLER = 'api/admin/meetings.js';

/** Executable SQL only — comments explain invariants and must not satisfy or fail a scan. */
const codeOf = (sql) => sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
/** Executable JS only, for the same reason. */
const jsCode = (src) => src.split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*')).join('\n');

/** The §49 fold, bounded at the next banner (never to EOF). */
function foldSection() {
  const boot = read(BOOTSTRAP);
  const at = boot.indexOf('§49) FOLDED VERBATIM');
  assert.ok(at > 0, '§49 is missing from the bootstrap — re-fold db/2026-09-17-meetings-tasks.sql');
  const next = boot.indexOf('FOLDED VERBATIM', at + 30);
  return boot.slice(at, next > 0 ? next : undefined);
}

function bodyOf(sql, name) {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  if (at < 0) return null;
  const end = sql.indexOf('$fn$;', at);
  return sql.slice(at, end < 0 ? undefined : end);
}

const TABLES = ['meeting_templates', 'meetings', 'staff_tasks'];
const NEW_CODES = ['MEETING_INVALID', 'MEETING_NOT_FOUND', 'TASK_INVALID', 'TASK_NOT_FOUND',
  'ZOOM_NOT_CONNECTED', 'ZOOM_REQUEST_FAILED', 'MEETING_LOG_FAILED'];
const CLIENT_RPCS = ['meeting_record', 'meeting_send_invites', 'meeting_cancel', 'meetings_list',
  'meeting_templates_list', 'meeting_template_save', 'meeting_template_set_active',
  'staff_tasks_list', 'staff_task_save', 'staff_task_set_done', 'staff_task_delete'];

for (const [label, sqlOf] of [['dated file', () => read(MIGRATION)], ['bootstrap §49', foldSection]]) {
  test(`${label}: three tables with RLS, no client write grant, and one SELECT policy gated on meetings.manage`, () => {
    const s = codeOf(sqlOf());
    for (const t of TABLES) {
      assert.ok(s.includes(`alter table public.${t} enable row level security;`), `${t} has no RLS`);
      assert.ok(s.includes(`revoke all on table public.${t} from public, anon, authenticated;`), `${t} keeps the default grants`);
    }
    assert.ok(s.includes("foreach t in array array['meeting_templates', 'meetings', 'staff_tasks'] loop"));
    assert.ok(/for select to authenticated '\s+'using \(\(select public\.has_staff_permission\(''meetings\.manage''\)\)\)'/.test(s),
      'the one policy must be SELECT-only and gated on meetings.manage');
    assert.equal((s.match(/create policy/gi) || []).length, 1, 'exactly one policy statement: the loop');
    assert.ok(!/grant (insert|update|delete|all)[^;]*on table public\.(meeting_templates|meetings|staff_tasks)/i.test(s),
      'no client write grant on a meeting table');
  });

  test(`${label}: every client RPC checks meetings.manage FIRST and is granted to authenticated alone`, () => {
    const s = sqlOf();
    for (const name of CLIENT_RPCS) {
      const body = bodyOf(s, name);
      assert.ok(body, `${name} is missing`);
      const afterBegin = codeOf(body.slice(body.indexOf('\nbegin\n') + 7)).trimStart();
      assert.ok(afterBegin.startsWith("if not public.has_staff_permission('meetings.manage') then"),
        `${name} must check meetings.manage before anything else`);
      const grants = new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;\\s+`
        + `grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`);
      assert.ok(grants.test(s), `${name} must be revoked from every role and granted to authenticated only`);
    }
  });

  test(`${label}: meetings.manage is the 22nd permission, listed last, held by super_admin alone`, () => {
    const s = codeOf(sqlOf());
    const perms = /insert into public\.staff_permissions[\s\S]*?on conflict/.exec(s)?.[0] || '';
    const keys = [...perms.matchAll(/^\s+\('([a-z_.]+)',/gm)].map((m) => m[1]);
    assert.equal(keys.length, 22);
    assert.equal(keys.at(-1), 'meetings.manage');
    assert.deepEqual([...s.matchAll(/\('(\w+)', 'meetings\.manage'\)/g)].map((m) => m[1]), ['super_admin']);
  });

  test(`${label}: an invitation needs a request key, is built from the stored meeting, and never relinks another message`, () => {
    const b = bodyOf(sqlOf(), 'meeting_send_invites');
    assert.ok(b.includes("if p_client_key is null or p_client_key !~ '^[A-Za-z0-9-]{8,64}$' then"), 'the request key is required');
    assert.ok(b.includes("public.comm_create_campaign('meeting_invite', 'meeting_invite', v_subject, v_body, p_audience, p_client_key)"),
      'the key reaches the campaign, so a retry returns the first one');
    assert.ok(b.includes("if not public.has_staff_permission('communications.send') then"), 'inviting also needs communications.send');
    assert.ok(b.includes("v_topic := btrim(regexp_replace(v_m.topic, '[{}]', '', 'g'));"), 'braces are stripped from the topic');
    assert.ok(b.includes("regexp_replace(v_m.join_url, '[{}]', '', 'g')"), 'braces are stripped from the join link');
    assert.ok(b.includes("if v_kind is distinct from 'meeting_invite' or (v_linked is not null and v_linked <> v_m.id) then"),
      'a key that belongs to another message is refused');
    assert.ok(b.includes('update public.comm_campaigns set meeting_id = v_m.id where id = v_campaign and meeting_id is null;'),
      'only a just-created campaign is linked, so a replay takes no campaign lock');
    assert.ok(b.includes("if v_m.status = 'cancelled' then") && b.includes('where s > now()) then'),
      'a cancelled or finished meeting is refused');
    assert.ok(!/\bp_subject\b|\bp_body\b|\bp_join_url\b/.test(b), 'the browser supplies no subject, body or link');
  });

  test(`${label}: cancelling a meeting stops its invitations — the meeting, then its campaigns, then their deliveries`, () => {
    const b = bodyOf(sqlOf(), 'meeting_cancel');
    const meeting = b.indexOf('select m.status into v_status from public.meetings m where m.id = p_meeting_id for update;');
    const campaigns = b.indexOf('perform 1 from public.comm_campaigns c where c.meeting_id = p_meeting_id order by c.id for update;');
    const deliveries = b.indexOf('update public.comm_deliveries d');
    assert.ok(meeting > 0 && campaigns > meeting && deliveries > campaigns,
      'the campaign rows must be locked before any delivery row — the #61 lock order');
    assert.ok(b.includes("set status = 'skipped', error_code = 'cancelled'"), 'waiting invitations are dropped');
    assert.ok(b.includes('update public.comm_campaigns set cancelled_at = now()'), 'the campaigns are cancelled, so a clearance refuses');
    assert.ok(b.includes("d.status = 'sending' and d.send_started_at is not null;") && b.includes("'in_flight', v_sending"),
      'invitations already cleared to send are counted');
  });

  test(`${label}: counts add up every invitation, and no recurrence CHECK passes on NULL`, () => {
    const s = sqlOf();
    assert.ok(bodyOf(s, 'meetings_list').includes('where cc.meeting_id = m.id'), 'counts aggregate over every invitation campaign');
    assert.ok(!/campaign_id\s+uuid references public\.comm_campaigns/.test(codeOf(s)), 'a meeting must not store only its last invitation');
    assert.equal((codeOf(s).match(/session_count is not null and session_count between 1 and 50/g) || []).length, 2,
      'both recurrence CHECKs must refuse a NULL count — a CHECK accepts NULL');
    assert.ok(s.includes('constraint meetings_sessions_bounded check (cardinality(sessions) between 1 and 50)'));
    assert.ok(!/start_url/.test(codeOf(s)), 'the host start link is never stored');
  });

  test(`${label}: a stored audience keeps only the reusable shape, so a pasted address list is never kept`, () => {
    const s = sqlOf();
    assert.ok(codeOf(s).includes("and coalesce(audience->>'mode', '') in ('all', 'batch', 'plans'))),"),
      'the meetings table must refuse any stored audience but all, batch or plans');
    const rec = bodyOf(s, 'meeting_record');
    assert.ok(/v_audience jsonb := case/.test(rec) && /else null\s+end;/.test(rec),
      'meeting_record normalises the audience before storing it');
    assert.ok(!/'manual'/.test(codeOf(rec)),
      'a pasted list has no arm: it is dropped, never stored, never returned by meetings_list');
    assert.ok(rec.includes('p_template_key, v_audience, v_actor, v_email)'), 'the INSERT stores the normalised value');
  });

  test(`${label}: an invitation names the NEXT session, not the first one`, () => {
    const b = bodyOf(sqlOf(), 'meeting_send_invites');
    assert.ok(b.includes('select min(s) into v_next from unnest(v_m.sessions) s where s > now();'),
      'the date comes from the next session still to come');
    assert.ok(b.includes("case when v_next is distinct from v_m.starts_at then 'Next session: ' else 'When: ' end"),
      'a series already under way says Next session, not When');
    assert.ok(!/E'\\nWhen: ' \|\| v_when/.test(b), 'the old first-session line must be gone');
  });

  test(`${label}: the catalog carries all 111 codes, the seven #62 codes among them`, () => {
    const s = sqlOf();
    const cat = s.slice(s.indexOf('create or replace function public.app_error_catalog()'));
    const rows = cat.slice(0, cat.indexOf('$cat$;')).match(/^ {4}\('[A-Z0-9_]+',/gm) || [];
    assert.equal(rows.length, 111);
    for (const code of NEW_CODES) assert.ok(cat.includes(`('${code}',`), `${code} is not catalogued`);
  });
}

test('every #62 code is in the client code list and has its own copy', () => {
  const codes = [...APP_ERROR_CODES];
  for (const code of NEW_CODES) {
    assert.ok(codes.includes(code), `${code} is not in APP_ERROR_CODES`);
    assert.ok(typeof APP_ERROR_COPY[code] === 'string' && APP_ERROR_COPY[code].length > 20, `${code} has no copy`);
  }
});

test('the mirror: meetings.manage is the last key and only super_admin holds it', () => {
  assert.equal(STAFF_PERMISSION_KEYS.length, 22);
  assert.equal(STAFF_PERMISSION_KEYS.at(-1), 'meetings.manage');
  assert.ok(ROLE_PERMISSIONS.super_admin.includes('meetings.manage'));
  assert.ok(!ROLE_PERMISSIONS.operations_admin.includes('meetings.manage'));
  assert.ok(!ROLE_PERMISSIONS.trainer.includes('meetings.manage'));
});

test('the Meetings handler gates first, says nothing publicly, and refuses an invitation before Zoom is called', () => {
  const src = jsCode(read(HANDLER));
  const h = src.slice(src.indexOf('export default async function handler'));
  assert.ok(/const started = Date\.now\(\);\s+if \(req\.method === 'GET'\) return res\.status\(200\)\.json\(\{ ok: true \}\);/.test(h),
    'the clock starts at entry, and GET says nothing about configuration');
  const gate = h.indexOf("requireStaff(req, { permission: 'meetings.manage' })");
  assert.ok(gate > 0, 'the handler must gate on meetings.manage');
  for (const call of ['zoomFetch(', 'inviteAndSend(', 'callerRpc(']) {
    assert.ok(h.indexOf(call) > gate, `${call} must come after the gate`);
  }
  const create = h.slice(h.indexOf("if (action === 'create')"), h.indexOf("if (action === 'invite')"));
  const refusal = create.indexOf('inviteRefusal(gate.context, audience, body.client_key)');
  const zoomPost = create.indexOf("zoomFetch('/users/me/meetings', { method: 'POST'");
  // ★ Not just "the check is called first": the refusal must be THROWN. A mutation that left the
  //   call in place and dropped the throw survived an earlier version of this pin.
  const thrown = create.indexOf('if (refusal) throw refusal;');
  assert.ok(refusal > 0 && thrown > refusal && zoomPost > thrown,
    'an invitation that would be refused must be refused — thrown, not merely computed — before a Zoom meeting exists');
  const inviteBranch = h.slice(h.indexOf("if (action === 'invite')"), h.indexOf("if (action === 'cancel')"));
  assert.ok(inviteBranch.includes('if (refusal) throw refusal;'), 'the invite action refuses the same way');
  const busy = create.indexOf('creating.has(u.id)');
  assert.ok(busy > 0 && busy < zoomPost, 'a second concurrent create is refused before Zoom is called');
  const refuse = src.slice(src.indexOf('function inviteRefusal'), src.indexOf('async function inviteAndSend'));
  assert.ok(refuse.includes('CLIENT_KEY_RE.test(') && refuse.includes("staffCan(context, 'communications.send')")
    && refuse.includes('emailConfigured()'), 'the refusal checks the key, the permission and email');
  assert.ok(src.includes('p_client_key: clientKey'), 'the request key reaches meeting_send_invites');
  assert.ok(src.includes('remaining: waiting.remaining, retry_later: waiting.retryLater'), 'remaining and retry_later are reported separately');
  assert.ok(src.includes('Math.min(DETAIL_CONCURRENCY, recurring.length)') && src.includes('Date.now() - started < DETAIL_DEADLINE_MS'),
    'Zoom detail calls are bounded in number and in time');
  assert.ok(!/start_url/.test(src), 'the host start link is never read into anything');
});

test('a failure after the invitations are queued is reported as a send failure, never as "not queued"', () => {
  const src = jsCode(read(HANDLER));
  const fn = src.slice(src.indexOf('async function inviteAndSend'), src.indexOf('const normalizeDays'));
  assert.ok(fn.includes('const base = {') && fn.includes('remaining: created.queued, retry_later: 0,'),
    'what was queued is the starting point, so the browser finishes the send in the same click');
  assert.ok(/catch \(e\) \{[\s\S]*send_error:/.test(fn), 'a send failure comes back as send_error');
  assert.ok(!/catch \(e\) \{[\s\S]*\berror:/.test(fn),
    'and never as error — the screen reads that as "not queued" and would invite everyone a second time');
  const create = src.slice(src.indexOf("if (action === 'create')"), src.indexOf("if (action === 'invite')"));
  assert.ok(create.includes('uncertain: true') && create.includes('client_key: String(body.client_key)'),
    'a lost answer from meeting_send_invites is uncertain, and its request key rides back');
});

test('the log write is retried once, and a Zoom write that timed out is never called safe to repeat', () => {
  const src = jsCode(read(HANDLER));
  assert.equal((src.match(/callerRpc\(u, 'meeting_record', recordArgs\)/g) || []).length, 2,
    'meeting_record is idempotent on the Zoom id, so a momentary failure is retried once before giving up');
  assert.ok(src.includes('first.status === 501') && src.includes('BUDGET_MS - RPC_TIMEOUT_MS'),
    'the retry is skipped for a missing migration, and when the budget has no room for it');
  assert.ok(/error: audience\s+\?/.test(src), 'with an audience the refusal says no invitations were sent');
  // Scoped to zoomFetch: the handler's entry has its own `req.method === 'GET'`, which would
  // otherwise satisfy this pin while the Zoom catch said "Try again" to a write that may have landed.
  const zoomFetchFn = src.slice(src.indexOf('async function zoomFetch'), src.indexOf('export const safeMeeting'));
  assert.ok(zoomFetchFn.includes("throw new HttpError(502, method === 'GET'")
    && zoomFetchFn.includes('would create a second meeting'),
    'a non-GET that timed out must never be advertised as safe to retry — repeating it creates a second Zoom meeting');
});

test('safeMeeting keeps the join link and never the host start link', () => {
  const m = safeMeeting({
    id: 9900000001, topic: 'T', start_time: '2026-10-01T01:00:00Z', duration: 60, type: 2,
    join_url: 'https://zoom.us/j/9900000001', start_url: 'https://zoom.us/s/9900000001?zak=host-secret',
  });
  assert.equal(m.zoom_meeting_id, '9900000001');
  assert.equal(m.join_url, 'https://zoom.us/j/9900000001');
  assert.ok(!JSON.stringify(m).includes('host-secret'), 'start_url must never survive');
  assert.equal(safeMeeting({ id: 1, join_url: 'http://zoom.us/j/1' }).join_url, null, 'only an https link is kept');
});

test('GET answers { ok } alone, even when Zoom is configured', async () => {
  const keys = ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => { process.env[k] = 'configured'; });
  try {
    assert.equal(zoomConfigured(), true);
    let status; let payload;
    const res = { status(c) { status = c; return this; }, json(o) { payload = o; return this; } };
    await handler({ method: 'GET', headers: {} }, res);
    assert.equal(status, 200);
    assert.deepEqual(payload, { ok: true });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('vercel.json and the dev server both know the Meetings handler', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.functions['api/admin/meetings.js'], 'the handler needs a function entry');
  assert.ok(read('vite.config.js').includes("commDevApi(env, '/api/admin/meetings', './api/admin/meetings.js')"),
    'without a dev route the handler 404s under npm run dev');
});

const APP = read('src/BookkeeperPro.jsx');

/** The tab's own region of the monolith: its header comment to the next screen. */
function meetingsRegion() {
  const at = APP.indexOf('// Meetings & Tasks (#62)');
  const end = APP.indexOf('function AccessRequests(');
  assert.ok(at > 0 && end > at, 'the Meetings & Tasks region is missing, or is no longer before AccessRequests');
  return APP.slice(at, end);
}

test('the tab is wired at every site', () => {
  assert.ok(APP.includes("meetings: '/admin/meetings',"), 'TAB_ROUTES');
  assert.ok(APP.includes("'staffroles', 'meetings', 'financialmanagement'"), 'NON_TOOL_TAB_IDS');
  assert.ok(APP.includes("case 'meetings': return <MeetingsTasks />;"), 'renderToolContent');
  assert.ok(/\{ id: 'communications'[^\n]*\n[^\n]*\n\s*\{ id: 'meetings', label: 'Meetings & Tasks'/.test(APP),
    'adminNavItems: Meetings & Tasks sits directly after Communications');
  const voice = /meetings: \{ label: 'Meetings & Tasks'[^\n]*/.exec(APP)?.[0] || '';
  assert.ok(/Super Admin only/.test(voice), 'VOICE_TAB_INFO names the restriction');
  assert.ok(!/@|₱|\d{3}/.test(voice), 'voice metadata must stay navigation-only');
  assert.equal(ADMIN_TAB_PERMISSION.meetings, 'meetings.manage', 'the chokepoint gates the tab');
});

test('every RPC the tab calls is defined and granted, and Zoom-first work goes through the endpoint', () => {
  const region = meetingsRegion();
  const sql = read(MIGRATION) + read('db/2026-09-16-communications.sql');
  const names = [...new Set([...region.matchAll(/(?:call|supabase\.rpc)\('([a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(names.length >= 6, 'the tab should be reading through the RPCs');
  for (const n of names) {
    assert.ok(sql.includes(`create or replace function public.${n}(`), `${n} is not defined by #61 or #62`);
    assert.ok(new RegExp(`grant execute on function public\\.${n}\\([^)]*\\) to authenticated;`).test(sql),
      `${n} is not granted to authenticated`);
  }
  for (const zoomFirst of ['meeting_record', 'meeting_send_invites', 'meeting_cancel']) {
    assert.ok(!names.includes(zoomFirst),
      `${zoomFirst} must go through api/admin/meetings.js, which calls Zoom first and records second`);
  }
  const handlerSrc = read(HANDLER);
  const actions = [...new Set([...region.matchAll(/meetingsApi\(\{\s*action: '([a-z-]+)'/g)].map((m) => m[1]))];
  assert.deepEqual(actions.sort(), ['cancel', 'create', 'invite', 'status', 'upcoming']);
  for (const a of actions) assert.ok(handlerSrc.includes(`action === '${a}'`), `the handler does not handle '${a}'`);
});

test('the tab injects no HTML, links only https join URLs, and cannot create two meetings on a double click', () => {
  const region = jsCode(meetingsRegion());
  assert.ok(!/dangerouslySetInnerHTML/.test(region), 'Meetings & Tasks must never inject HTML into the app');
  assert.ok(!/<iframe/.test(region), 'no frame belongs in this tab');
  assert.ok(region.includes("const meetingSafeLink = (url) => (typeof url === 'string' && /^https:\\/\\//.test(url) ? url : null);"),
    'only an https link may become an href');
  assert.ok(/href=\{link\} target="_blank" rel="noopener noreferrer"/.test(region), 'an outside link opens with no opener');
  assert.ok(region.includes('if (createLockRef.current) return;') && region.includes('createLockRef.current = true;'),
    'a ref lock, not a state flag: Zoom takes no request key, so a double click would create two meetings');
  assert.ok((region.match(/commClientKey\(\)/g) || []).length >= 2,
    'scheduling and inviting each mint a request key, so a retried invitation emails nobody twice');
  assert.ok(/const \{ profile, staff, staffReady, staffDegraded, can \} = useAuth\(\);/.test(region),
    'the admin verdict is fenced behind staffDegraded (uiSafety §12)');
  assert.ok(region.includes("adminTabVisible(staff, {"), 'the screen asks the same chokepoint helper the nav does');
  assert.ok(!region.includes('The invitations were not queued'),
    'a queued-but-unsent state must never be described as not queued');
  assert.ok(region.includes('inv?.send_error') && region.includes('do not invite again'),
    'the banner tells a send failure from a queue failure, and never advises a second invitation');
});
