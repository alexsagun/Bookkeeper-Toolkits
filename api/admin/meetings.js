// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — MEETINGS (Zoom) (#62)
// ─────────────────────────────────────────────────────────────────────────────
// Holds two things the browser must never hold: the Zoom Server-to-Server OAuth credentials
// (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET) and the service-role key that sends
// invitations through the #61 queue. Every action verifies the caller's JWT and
// independently confirms meetings.manage via my_staff_context() (requireStaff) BEFORE
// anything else runs.
//
// Actions (POST body.action):
//   'status'   — { configured, zoomConfigured, hasResend }, for a signed-in manager only
//   'upcoming' — Zoom's upcoming meetings; recurring ones expanded into occurrences
//   'create'   — validate the form with src/lib/meetingSchedule.js (the SAME function the
//                Meetings tab previewed with), create the meeting in Zoom, record it with
//                the CALLER's JWT, and optionally invite an audience and start sending
//   'invite'   — invite an audience to an existing meeting, then start sending
//   'cancel'   — delete the meeting in Zoom, then cancel the log row and its invitations
//   GET        — { ok } only. Which secrets are configured is not public.
//
// ★ ZOOM FIRST, THEN THE LOG. Zoom and Postgres cannot share a transaction. A meeting that
//   exists in Zoom with no log row is still visible in the calendar (the Zoom list is merged
//   in) and the response says so; a log row for a meeting Zoom never created would be a lie.
//
// ★ start_url IS NEVER READ INTO ANYTHING WE KEEP OR RETURN. Whoever holds it starts the
//   meeting as the host. Only join_url leaves this handler.
//
// ★ A create is NOT idempotent at Zoom (Zoom takes no request key), so the client locks its
//   button and this handler refuses a second concurrent create from the same account on the
//   same warm instance. Everything checkable — the form, the audience shape, the invite
//   permission, email being configured — is checked BEFORE Zoom is called, so a refusal never
//   leaves a meeting behind.
//
// ★ The legacy Apps Script sent the recurrence end date as midnight UTC (08:00 Manila) and
//   copied every invitation to a CC list. buildZoomMeetingBody() ends a series at 23:59
//   Manila, and invitations go through the #61 queue with replies to support and no CC.
//
// Runs on Vercel AND under `npm run dev` (meetingsDevApi in vite.config.js).
// ─────────────────────────────────────────────────────────────────────────────

import { requireStaff, service, serviceConfigured } from '../_lib/staffAuth.js';
import { emailConfigured } from '../_lib/email.js';
import { processQueue, queueRemaining } from '../_lib/commSend.js';
import { staffCan } from '../../src/lib/staffRoles.js';
import {
  BUSINESS_TZ, buildZoomMeetingBody, expandOccurrences, manilaToday, validateMeetingForm,
} from '../../src/lib/meetingSchedule.js';

const MAX_BODY_BYTES = 32 * 1024;
// vercel.json gives this function 60 s. The clock starts at handler ENTRY, so the gate's own
// round trips count against it.
const BUDGET_MS = 48_000;
const ZOOM_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;
// Recurring meetings need one detail call each: at most five at a time, and none started past
// this point, so a long list can never outlive the function.
const DETAIL_CONCURRENCY = 5;
const DETAIL_DEADLINE_MS = 25_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const TEMPLATE_KEY_RE = /^[a-z0-9_]{1,40}$/;
const ZOOM_ID_RE = /^[0-9]{6,20}$/;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 20;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const hits = (rateHits.get(userId) || []).filter((t) => t >= now - RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

// Accounts with a create in progress on this warm instance.
const creating = new Set();

export const zoomConfigured = () => Boolean(
  process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const NOT_CONNECTED = 'Zoom is not connected yet. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in Vercel.';

// ── Zoom ─────────────────────────────────────────────────────────────────────
// One token per warm instance, refreshed a minute before Zoom says it expires.
let tokenCache = { token: null, exp: 0 };

async function zoomToken() {
  if (!zoomConfigured()) throw new HttpError(503, NOT_CONNECTED, 'ZOOM_NOT_CONNECTED');
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  let r;
  try {
    r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(ZOOM_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'Zoom did not answer. Try again.', 'ZOOM_REQUEST_FAILED');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // Status only: Zoom's error body names the account and is not ours to log.
    console.error(`[meetings] zoom token ${r.status}`);
    throw new HttpError(r.status === 400 || r.status === 401 ? 503 : 502,
      'Zoom refused the connection. Check the Zoom app credentials in Vercel.', 'ZOOM_NOT_CONNECTED');
  }
  tokenCache = { token: data.access_token, exp: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000 };
  return tokenCache.token;
}

async function zoomFetch(path, { method = 'GET', body } = {}, retried = false) {
  const token = await zoomToken();
  let r;
  try {
    r = await fetch(`https://api.zoom.us/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ZOOM_TIMEOUT_MS),
    });
  } catch {
    // ★ A GET changed nothing, so "try again" is safe advice. A non-GET may have been written in full
    //   before the abort, and Zoom takes no request key, so repeating it creates a SECOND meeting —
    //   for a weekly series, a second set of sessions.
    throw new HttpError(502, method === 'GET'
      ? 'Zoom did not answer. Try again.'
      : 'Zoom did not answer in time, and the request may still have gone through. Check the calendar before trying again — Zoom would create a second meeting.',
    'ZOOM_REQUEST_FAILED');
  }
  if (r.status === 401 && !retried) {
    tokenCache = { token: null, exp: 0 };
    return zoomFetch(path, { method, body }, true);
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: r.status, ok: r.ok, data };
}

/** Only the fields we are willing to keep or show. start_url never passes this point. */
export const safeMeeting = (m) => ({
  zoom_meeting_id: String(m?.id ?? ''),
  topic: typeof m?.topic === 'string' ? m.topic : '',
  start_time: m?.start_time || null,
  duration: Number(m?.duration) || 0,
  type: m?.type,
  join_url: typeof m?.join_url === 'string' && m.join_url.startsWith('https://') ? m.join_url : null,
  occurrences: Array.isArray(m?.occurrences)
    ? m.occurrences.map((o) => ({ start_time: o.start_time, duration: Number(o.duration) || 0, status: o.status }))
    : undefined,
});

// ── Supabase, with the CALLER's JWT (the row records who acted) ──────────────
async function callerRpc(user, fn, args) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  let r;
  try {
    r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'The database did not answer. Try again.', undefined);
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    if (data?.code === 'PGRST202' || (r.status === 404 && !data?.hint)) {
      throw new HttpError(501, `${fn}() does not exist in this database — run db/2026-09-17-meetings-tasks.sql (#62).`, 'MIGRATION_MISSING');
    }
    throw new HttpError(r.status >= 500 ? 502 : r.status, data?.message || `${fn} failed`, data?.hint || undefined);
  }
  return data;
}

/** What a create or invite needs before anything irreversible happens. */
function inviteRefusal(context, audience, clientKey) {
  if (typeof audience !== 'object' || Array.isArray(audience) || typeof audience.mode !== 'string') {
    return new HttpError(400, 'Choose who is invited.', 'MEETING_INVALID');
  }
  if (!CLIENT_KEY_RE.test(String(clientKey || ''))) {
    return new HttpError(400, 'An invitation needs a request key.', 'MEETING_INVALID');
  }
  if (!staffCan(context, 'communications.send')) {
    return new HttpError(403, 'Inviting students also requires the communications.send permission.', 'FORBIDDEN');
  }
  if (!emailConfigured()) {
    return new HttpError(503, 'Email sending is not configured on the server. Set RESEND_API_KEY and RESEND_FROM.', 'email_not_configured');
  }
  return null;
}

async function inviteAndSend(user, meetingId, audience, clientKey, started) {
  const created = await callerRpc(user, 'meeting_send_invites', {
    p_meeting_id: meetingId, p_audience: audience, p_client_key: clientKey,
  });
  // ★ FROM HERE THE INVITATIONS EXIST. meeting_send_invites created the campaign and every delivery
  //   row, so anything that fails below is a failure to SEND, never to queue. It comes back as
  //   send_error — never as `error`, which the screen reads as "not queued" and would answer by
  //   inviting the whole audience a second time. What is left goes out on the next run, and the
  //   browser's own send loop finishes it in the same click (remaining > retry_later).
  const base = {
    campaign_id: created.campaign_id, queued: created.queued, duplicate: Boolean(created.duplicate),
    sent: 0, failed: 0, retrying: 0, deferred: 0, stopped: 'unknown', halted: false, left: 0,
    remaining: created.queued, retry_later: 0,
  };
  try {
    const admin = service();
    const out = await processQueue(admin, { campaignId: created.campaign_id, deadlineMs: started + BUDGET_MS });
    const waiting = await queueRemaining(admin, created.campaign_id);
    return {
      ...base, sent: out.sent, failed: out.failed, retrying: out.retrying, deferred: out.deferred,
      stopped: out.stopped, halted: out.halted, left: out.left,
      remaining: waiting.remaining, retry_later: waiting.retryLater,
    };
  } catch (e) {
    console.error(`[meetings] invitations queued but not sent: ${e?.code || 'error'}`);
    return { ...base, send_error: e instanceof HttpError ? e.message : 'Sending did not finish.' };
  }
}

const normalizeDays = (days) => [...new Set((Array.isArray(days) ? days : []).map(Number)
  .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);

export default async function handler(req, res) {
  const started = Date.now();
  if (req.method === 'GET') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  if (!serviceConfigured()) return res.status(500).json({ error: 'Supabase service credentials are not configured.' });

  // Auth: valid JWT + independently-confirmed meetings.manage, BEFORE anything else.
  const gate = await requireStaff(req, { permission: 'meetings.manage' });
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
  const u = gate.user;
  if (rateLimited(u.id)) return res.status(429).json({ error: 'Too many requests — wait a minute.' });
  if (Number(req.headers?.['content-length']) > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request too large.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const action = body.action;

  try {
    if (action === 'status') {
      return res.status(200).json({ ok: true, configured: serviceConfigured(), zoomConfigured: zoomConfigured(), hasResend: emailConfigured() });
    }

    if (action === 'upcoming') {
      const list = await zoomFetch('/users/me/meetings?type=upcoming&page_size=100');
      if (!list.ok) {
        console.error(`[meetings] zoom list ${list.status}`);
        throw new HttpError(502, 'Zoom could not list meetings.', 'ZOOM_REQUEST_FAILED');
      }
      const meetings = (list.data?.meetings || []).slice(0, 100);
      const out = meetings.map(safeMeeting);
      const recurring = meetings.map((m, i) => (m?.type === 8 ? i : -1)).filter((i) => i >= 0);
      let next = 0;
      const worker = async () => {
        while (next < recurring.length && Date.now() - started < DETAIL_DEADLINE_MS) {
          const i = recurring[next];
          next += 1;
          try {
            const one = await zoomFetch(`/meetings/${encodeURIComponent(meetings[i].id)}`);
            if (one.ok) out[i] = safeMeeting(one.data);
          } catch {
            // Keep the unexpanded meeting: it still shows its next start.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, recurring.length) }, worker));
      return res.status(200).json({ ok: true, meetings: out, expanded_all: next >= recurring.length });
    }

    if (action === 'create') {
      const form = body.form && typeof body.form === 'object' ? body.form : {};
      const check = validateMeetingForm(form, { todayISO: manilaToday() });
      if (!check.ok) {
        return res.status(422).json({ error: Object.values(check.errors)[0], code: 'MEETING_INVALID', errors: check.errors });
      }
      const audience = body.audience == null ? null : body.audience;
      if (audience !== null) {
        const refusal = inviteRefusal(gate.context, audience, body.client_key);
        if (refusal) throw refusal;
      }
      if (!zoomConfigured()) throw new HttpError(503, NOT_CONNECTED, 'ZOOM_NOT_CONNECTED');
      if (creating.has(u.id)) {
        return res.status(409).json({ error: 'A meeting is already being created from this account. Wait for it to finish.', code: 'MEETING_INVALID' });
      }
      creating.add(u.id);
      try {
        const zoomBody = {
          ...buildZoomMeetingBody(form),
          settings: {
            join_before_host: form.joinBeforeHost !== false,       // the legacy default
            waiting_room: form.waitingRoom === true,
            ...(form.requireRegistration ? { approval_type: 0, registration_type: 1 } : {}),
          },
        };
        const created = await zoomFetch('/users/me/meetings', { method: 'POST', body: zoomBody });
        if (created.status !== 201 || !created.data?.id) {
          console.error(`[meetings] zoom create ${created.status}`);
          throw new HttpError(502, 'Zoom could not create the meeting. Nothing was saved.', 'ZOOM_REQUEST_FAILED');
        }
        const z = safeMeeting(created.data);
        const sessions = expandOccurrences(form).map((s) => s.startUtc);
        const weekly = form.recurrence === 'weekly';
        const recordArgs = {
          p_zoom_meeting_id: z.zoom_meeting_id, p_topic: zoomBody.topic,
          p_starts_at: sessions[0] || zoomBody.start_time, p_duration: zoomBody.duration,
          p_weekly_days: weekly ? normalizeDays(form.days) : [],
          p_session_count: weekly && form.endMode !== 'date' ? Number(form.count) : null,
          p_ends_on: weekly && form.endMode === 'date' ? form.endDate : null,
          p_sessions: sessions, p_join_url: z.join_url,
          p_template_key: TEMPLATE_KEY_RE.test(String(form.templateKey || '')) ? form.templateKey : null,
          p_audience: audience,
        };
        let recorded;
        try {
          recorded = await callerRpc(u, 'meeting_record', recordArgs);
        } catch (first) {
          // ★ meeting_record is idempotent on the Zoom id, so asking again is safe, and it turns a
          //   momentary database blip back into an ordinary success — invitations included. A missing
          //   migration (501) is not momentary, and a retry needs room inside the budget.
          const roomLeft = Date.now() - started < BUDGET_MS - RPC_TIMEOUT_MS - 1_000;
          try {
            if (!roomLeft || first.status === 501) throw first;
            recorded = await callerRpc(u, 'meeting_record', recordArgs);
          } catch (e) {
            console.error(`[meetings] created in Zoom but not recorded: ${e.code || e.status || 'error'}`);
            // ★ Say what did NOT happen: with an audience, the invitations the admin asked for were
            //   never queued, and the recovery is to cancel the Zoom meeting and schedule it again —
            //   pressing Schedule on its own would leave two meetings in Zoom.
            return res.status(502).json({
              error: audience
                ? 'The meeting was created in Zoom, but saving it here failed, so no invitations were sent. Cancel it from the calendar and schedule it again — pressing Schedule again would create a second Zoom meeting.'
                : 'The meeting was created in Zoom, but saving it here failed. It still shows in the calendar from Zoom — do not create it again.',
              code: 'MEETING_LOG_FAILED', zoom_meeting_id: z.zoom_meeting_id, invited: false,
            });
          }
        }
        let invite = null;
        if (audience) {
          try {
            invite = await inviteAndSend(u, recorded.id, audience, String(body.client_key), started);
          } catch (e) {
            // Only meeting_send_invites itself can fail here now, and a lost response may still have
            // committed — so this is "not certain", never "not queued", and the request key rides back
            // so the same invitation can be retried without emailing anyone twice.
            invite = {
              error: e instanceof HttpError ? e.message : 'The invitations could not be queued.',
              code: e.code, uncertain: true, client_key: String(body.client_key),
            };
          }
        }
        return res.status(200).json({
          ok: true, meeting_id: recorded.id, zoom_meeting_id: z.zoom_meeting_id, join_url: z.join_url,
          timezone: BUSINESS_TZ, sessions: sessions.length, invite,
        });
      } finally {
        creating.delete(u.id);
      }
    }

    if (action === 'invite') {
      if (!UUID_RE.test(String(body.meeting_id || ''))) return res.status(400).json({ error: 'meeting_id required.' });
      const refusal = inviteRefusal(gate.context, body.audience, body.client_key);
      if (refusal) throw refusal;
      const invite = await inviteAndSend(u, String(body.meeting_id), body.audience, String(body.client_key), started);
      return res.status(200).json({ ok: true, invite });
    }

    if (action === 'cancel') {
      const zoomId = String(body.zoom_meeting_id || '');
      if (!ZOOM_ID_RE.test(zoomId)) return res.status(400).json({ error: 'zoom_meeting_id required.' });
      if (body.meeting_id != null && !UUID_RE.test(String(body.meeting_id))) {
        return res.status(400).json({ error: 'meeting_id must be a meeting id.' });
      }
      const del = await zoomFetch(`/meetings/${encodeURIComponent(zoomId)}`, { method: 'DELETE' });
      // 404: already gone in Zoom — the log row and its invitations are still worth closing.
      if (!(del.status === 204 || del.status === 200 || del.status === 404)) {
        console.error(`[meetings] zoom delete ${del.status}`);
        throw new HttpError(502, 'Zoom could not delete the meeting. Nothing was changed here.', 'ZOOM_REQUEST_FAILED');
      }
      const log = body.meeting_id ? await callerRpc(u, 'meeting_cancel', { p_meeting_id: String(body.meeting_id) }) : null;
      return res.status(200).json({ ok: true, zoom_status: del.status, log });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    const known = err instanceof HttpError;
    if (!known) console.error(`[meetings] ${String(action).slice(0, 16)} failed`);
    return res.status(known ? err.status : 500).json({
      error: known ? err.message : 'The meeting request failed.',
      code: known ? err.code : undefined,
    });
  }
}
