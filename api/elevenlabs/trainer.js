// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — AI COURSE TRAINER webhook tools (ElevenLabs).
// ─────────────────────────────────────────────────────────────────────────────
// The four ElevenLabs "server tools" the voice trainer calls to teach from
// Supabase-hosted course content. ElevenLabs POSTs here with an Authorization
// header carrying the short-lived HMAC TRAINER TOKEN minted by
// api/elevenlabs/signed-url.js (passed as the `secret__trainer_token` dynamic
// variable — headers only, never the LLM). The token is IDENTITY ONLY.
//
// AUTHORIZATION IS FAIL-CLOSED and re-evaluated on EVERY request: course access
// comes from public.trainer_visible_courses(p_user) (mirrors courses_read), run
// under the service role. An unavailable entitlement check returns a temporary
// service error — NEVER course content. Paid course content is never in a global
// ElevenLabs knowledge doc; it is retrieved here, after authorization.
//
// Actions (POST ?action=…), all returning HTTP 200 with a bounded envelope so
// the agent can always speak the result:
//   get_my_training_catalog          — courses the learner may study right now
//   get_authorized_training_context  — grounded lesson chunks for a mode
//   get_my_training_checkpoint       — resume-where-you-left-off
//   save_training_checkpoint         — persist AI progress (NOT lesson_progress)
//   GET                              — health { ok, configured }
//
// Runs on Vercel AND under `npm run dev` (trainerDevApi in vite.config.js).
// Never logs chunk/lesson/transcript content — only {action,userId,courseId,code}.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { verifyTrainerToken } from '../../src/lib/trainerToken.js';
import {
  resolveCourseRef,
  classifyCourseAccess,
  buildSourceLabel,
  buildTrainerEnvelope,
  clampCheckpoint,
  DENIAL_MESSAGE,
  NOT_READY_MESSAGE,
  NOT_FOUND_MESSAGE,
  TRAINER_MODES,
} from '../../src/lib/trainerContent.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TRAINER_TOKEN_SECRET = process.env.TRAINER_TOKEN_SECRET || '';

const MAX_BODY_BYTES = 10 * 1024;          // trainer requests are tiny
const EMBED_TIMEOUT_MS = 3000;
const CONFIDENCE_MIN = 0.45;               // top score ≥ → 'high'
const MATCH_MIN_SCORE = 0.30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIONS = new Set([
  'get_my_training_catalog',
  'get_authorized_training_context',
  'get_my_training_checkpoint',
  'save_training_checkpoint',
]);

// Durable daily caps (enforced via trainer_bump_usage — the in-memory limiter
// below is only a per-instance burst guard).
const DAILY_CAP = {
  get_my_training_catalog: 60,
  get_authorized_training_context: 150,
  get_my_training_checkpoint: 100,
  save_training_checkpoint: 100,
};

// ── Per-warm-instance burst guard (same best-effort pattern as signed-url.js) ──
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 20;
const RATE_MAX_TRACKED_USERS = 500;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  if (rateHits.size > RATE_MAX_TRACKED_USERS) {
    for (const [uid, hits] of rateHits) {
      if (!hits.length || hits[hits.length - 1] < cutoff) rateHits.delete(uid);
    }
  }
  const hits = (rateHits.get(userId) || []).filter((t) => t >= cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

function actionOf(req) {
  if (req.query && typeof req.query.action === 'string') return req.query.action;
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('action') || '';
  } catch { return ''; }
}

function service() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// A missing table/function (pre-#27 DB) reads as one of these Postgres codes.
function isNotMigrated(err) {
  const code = err?.code || '';
  return code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST204';
}

function envelope(res, obj) {
  return res.status(200).json(buildTrainerEnvelope(obj));
}

// gte-small via the trainer-embed Edge Function. Returns a 384-float array, or
// null on any problem (missing function, timeout, bad shape) → the caller falls
// back to keyword search. Never throws.
async function embedQuery(text) {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/trainer-embed`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ texts: [String(text).slice(0, 4000)] }),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    const vec = Array.isArray(data?.embeddings) ? data.embeddings[0] : null;
    if (!Array.isArray(vec) || vec.length !== 384 || vec.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      console.warn('[trainer] embed dim/shape mismatch — falling back to keyword search');
      return null;
    }
    return vec;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function citationsFromChunks(chunks) {
  const seen = new Set();
  const out = [];
  for (const ch of chunks) {
    const key = ch.lesson_id || `${ch.course_id}:${ch.module_title || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      course_id: ch.course_id,
      course_slug: ch.course_slug || '',
      lesson_id: ch.lesson_id || null,
      label: buildSourceLabel({ courseTitle: ch.course_title, moduleTitle: ch.module_title, lessonTitle: ch.lesson_title }),
    });
  }
  return out;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function doCatalog(admin, userId, authorized) {
  if (!authorized.length) {
    return { status: 'ok', code: 'empty_catalog',
      message: 'No courses are AI-trainer-ready on your plan yet. I can still explain how the app works or help you find a tool.',
      courses: [], next_actions: ['explain_current_page'] };
  }
  // ready = has ≥1 ready+included source. One query across the authorized ids.
  const ids = authorized.map((c) => c.id);
  const { data: srcRows, error } = await admin
    .from('course_ai_sources')
    .select('course_id')
    .in('course_id', ids)
    .eq('status', 'ready')
    .eq('included', true);
  if (error && !isNotMigrated(error)) throw error;
  const readySet = new Set((srcRows || []).map((r) => r.course_id));
  const courses = authorized.map((c) => ({ id: c.id, slug: c.slug, title: c.title, ready: readySet.has(c.id) }));
  const readyCount = courses.filter((c) => c.ready).length;
  return {
    status: 'ok', code: 'ok',
    message: readyCount
      ? `You can study ${readyCount} course${readyCount === 1 ? '' : 's'} with me right now.`
      : 'Your courses are still being prepared for AI training. I can open one so you can study it directly.',
    courses,
    next_actions: ['get_authorized_training_context', 'get_my_training_checkpoint'],
  };
}

async function planLabelFor(admin, userId) {
  try {
    const { data: pk } = await admin.rpc('user_plan_key', { p_user: userId });
    if (!pk) return null;
    const { data: plan } = await admin.from('enrollment_plans').select('name').eq('key', pk).maybeSingle();
    return plan?.name || pk;
  } catch { return null; }
}

async function doContext(admin, userId, authorized, body) {
  const mode = TRAINER_MODES.includes(body?.mode) ? body.mode : 'explain';
  const courseRef = String(body?.course_ref || '').trim();
  if (!courseRef) {
    return { status: 'error', code: 'bad_request',
      message: 'Which course would you like to study? Tell me the course name.',
      next_actions: ['get_my_training_catalog'] };
  }

  // All published + trainer-enabled courses — ONLY to tell "denied" from
  // "not_found"; never leaked to the learner.
  let allPublished = [];
  try {
    const { data } = await admin.from('courses')
      .select('id,slug,title,access_tier')
      .eq('published', true).eq('ai_trainer_enabled', true);
    allPublished = data || [];
  } catch { allPublished = authorized; }

  const cls = classifyCourseAccess({ ref: courseRef, authorized, allPublished });
  const allowedTitles = authorized.map((c) => c.title);

  if (cls.status === 'denied') {
    const label = await planLabelFor(admin, userId);
    return { status: 'denied', code: 'denied_plan',
      message: DENIAL_MESSAGE(label, allowedTitles),
      next_actions: ['open_account_panel:upgrade', 'get_my_training_catalog'] };
  }
  if (cls.status === 'not_found') {
    return { status: 'error', code: 'not_found',
      message: NOT_FOUND_MESSAGE(allowedTitles), next_actions: ['get_my_training_catalog'] };
  }

  const course = cls.course;
  const wantsCoverage = mode === 'guided' || mode === 'quiz' || mode === 'recap';
  let rows = [];
  let retrievalMode = 'keyword';

  if (wantsCoverage) {
    const lessonId = await resolveLessonId(admin, userId, course.id, body?.lesson_ref);
    if (lessonId) {
      const { data, error } = await admin.rpc('trainer_lesson_chunks', {
        p_user: userId, p_course_id: course.id, p_lesson_id: lessonId, p_limit: 8,
      });
      if (error) { if (isNotMigrated(error)) throw error; }
      rows = data || [];
    }
  } else {
    const query = String(body?.query || courseRef).slice(0, 500);
    const embedding = await embedQuery(query);
    if (embedding) {
      const { data, error } = await admin.rpc('trainer_match_chunks', {
        p_user: userId, p_course_ids: [course.id], p_query: embedding, p_limit: 6, p_min_score: MATCH_MIN_SCORE,
      });
      if (error) { if (isNotMigrated(error)) throw error; }
      rows = data || [];
      retrievalMode = 'vector';
    }
    if (!rows.length) {
      const { data, error } = await admin.rpc('trainer_match_chunks_fts', {
        p_user: userId, p_course_ids: [course.id], p_query: query, p_limit: 6,
      });
      if (error) { if (isNotMigrated(error)) throw error; }
      rows = data || [];
      retrievalMode = 'keyword';
    }
  }

  if (!rows.length) {
    return { status: 'ok', code: 'no_material',
      message: `${NOT_READY_MESSAGE(course.title)}`,
      course_id: course.id,
      next_actions: ['open_course_lesson', 'get_my_training_catalog'] };
  }

  const withSlug = rows.map((r) => ({ ...r, course_slug: course.slug }));
  const topScore = Math.max(...rows.map((r) => Number(r.score) || 0), 0);
  const confidence = (!wantsCoverage && topScore < CONFIDENCE_MIN) ? 'low' : 'high';
  const chunks = withSlug.map((r) => ({
    content: r.content, course_id: r.course_id, lesson_id: r.lesson_id,
    label: buildSourceLabel({ courseTitle: r.course_title, moduleTitle: r.module_title, lessonTitle: r.lesson_title }),
  }));
  const baseMsg = confidence === 'low'
    ? `Here is the closest material I found in ${course.title}, but it may not fully cover your question — tell the learner if it's a stretch rather than guessing.`
    : `Here is approved material from ${course.title}. Teach ONE step at a time and cite the source.`;
  return {
    status: 'ok', code: 'ok', message: baseMsg,
    chunks, citations: citationsFromChunks(withSlug),
    retrieval: { mode: retrievalMode, confidence },
    next_actions: ['show_lesson_sources', 'open_course_lesson', 'save_training_checkpoint'],
  };
}

// Resolve a spoken lesson reference to a lesson id within an authorized course.
// Falls back to the checkpoint lesson, then the first lesson.
async function resolveLessonId(admin, userId, courseId, lessonRef) {
  if (typeof lessonRef === 'string' && UUID_RE.test(lessonRef)) {
    const { data } = await admin.from('course_lessons').select('id').eq('id', lessonRef).eq('course_id', courseId).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data: lessons } = await admin.from('course_lessons')
    .select('id,title,position').eq('course_id', courseId).order('position', { ascending: true });
  const list = lessons || [];
  if (!list.length) return null;
  const ref = String(lessonRef || '').trim().toLowerCase();
  if (ref) {
    const byTitle = list.find((l) => String(l.title || '').toLowerCase().includes(ref));
    if (byTitle) return byTitle.id;
    const num = ref.match(/\b(\d+)\b/);
    if (num) {
      const idx = Number(num[1]) - 1;
      if (list[idx]) return list[idx].id;
    }
  }
  const { data: cp } = await admin.from('ai_training_checkpoints')
    .select('lesson_id').eq('user_id', userId).eq('course_id', courseId).maybeSingle();
  if (cp?.lesson_id && list.some((l) => l.id === cp.lesson_id)) return cp.lesson_id;
  return list[0].id;
}

async function doGetCheckpoint(admin, userId, authorized, body) {
  const authIds = new Set(authorized.map((c) => c.id));
  let q = admin.from('ai_training_checkpoints')
    .select('course_id,lesson_id,topic,mode,understanding,next_step,updated_at')
    .eq('user_id', userId).order('updated_at', { ascending: false });
  const ref = String(body?.course_ref || '').trim();
  let target = null;
  const { data: rows, error } = await q;
  if (error) { if (isNotMigrated(error)) throw error; }
  const valid = (rows || []).filter((r) => authIds.has(r.course_id)); // expired-plan courses drop out
  if (ref) {
    const course = resolveCourseRef(ref, authorized);
    if (course) target = valid.find((r) => r.course_id === course.id) || null;
  } else {
    target = valid[0] || null;
  }
  if (!target) {
    return { status: 'ok', code: 'no_checkpoint',
      message: "We don't have a saved spot yet. Ask me to teach any course and I'll remember where you finish.",
      next_actions: ['get_my_training_catalog'] };
  }
  const course = authorized.find((c) => c.id === target.course_id);
  let lessonTitle = '';
  if (target.lesson_id) {
    // Scope the title lookup to the (authorized) checkpoint course — a lesson_id that
    // belongs to a different course resolves to no title, so a crafted checkpoint can
    // never surface a lesson title from a course the learner's plan doesn't include.
    const { data: l } = await admin.from('course_lessons').select('title')
      .eq('id', target.lesson_id).eq('course_id', target.course_id).maybeSingle();
    lessonTitle = l?.title || '';
  }
  return {
    status: 'ok', code: 'ok',
    message: `Last time you were working on ${target.topic || 'this course'}. I can pick up from there.`,
    checkpoint: {
      course_id: target.course_id, course_title: course?.title || '',
      lesson_id: target.lesson_id, lesson_title: lessonTitle,
      topic: target.topic, mode: target.mode, understanding: target.understanding,
      next_step: target.next_step, updated_at: target.updated_at,
    },
    next_actions: ['get_authorized_training_context', 'open_course_lesson'],
  };
}

async function doSaveCheckpoint(admin, userId, authorized, body) {
  const courseId = String(body?.course_id || '');
  if (!UUID_RE.test(courseId)) {
    return { status: 'error', code: 'bad_request', message: 'I need a valid course to save your progress.' };
  }
  if (!authorized.some((c) => c.id === courseId)) {
    return { status: 'denied', code: 'denied_plan', message: "I can't save progress for a course that isn't in your plan." };
  }
  let lessonId = typeof body?.lesson_id === 'string' && UUID_RE.test(body.lesson_id) ? body.lesson_id : null;
  // Only persist a lesson_id that actually belongs to this course — never store a
  // cross-course lesson pointer (defense in depth for the checkpoint read above).
  if (lessonId) {
    const { data: l } = await admin.from('course_lessons').select('id').eq('id', lessonId).eq('course_id', courseId).maybeSingle();
    if (!l?.id) lessonId = null;
  }
  const cp = clampCheckpoint(body);
  if (!cp.topic) {
    return { status: 'error', code: 'bad_request', message: 'Tell me the topic to save.' };
  }
  const row = {
    user_id: userId, course_id: courseId, lesson_id: lessonId,
    topic: cp.topic, mode: cp.mode, understanding: cp.understanding, next_step: cp.next_step,
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from('ai_training_checkpoints')
    .upsert(row, { onConflict: 'user_id,course_id' });
  if (error) { if (isNotMigrated(error)) throw error; throw error; }
  return { status: 'ok', code: 'ok', message: 'Saved. We can resume from here next time.',
    next_actions: ['get_authorized_training_context'] };
}

// Exported for focused fail-closed testing without a database: each action takes the
// service client + the precomputed authorized-course list as parameters, so a fake
// `admin` + a controlled `authorized` set can pin "denied/not-authorized ⇒ no retrieval,
// no cross-course leak, no write" independently of the handler's token/RPC gate.
export { doCatalog, doContext, doGetCheckpoint, doSaveCheckpoint };

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const configured = Boolean(TRAINER_TOKEN_SECRET && SUPABASE_URL && SERVICE_KEY);

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, configured });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const action = actionOf(req);
  if (!ACTIONS.has(action)) {
    return envelope(res, { status: 'error', code: 'bad_request', message: 'Unknown training action.' });
  }
  if (!configured) {
    return envelope(res, { status: 'error', code: 'not_configured',
      message: 'The AI trainer is not set up yet. I can still explain the app or open a course for you.' });
  }

  // Verify the trainer token (identity only).
  const authz = req.headers.authorization || req.headers.Authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const hmacB64url = (input) => crypto.createHmac('sha256', TRAINER_TOKEN_SECRET).update(input).digest('base64url');
  const timingSafeEq = (a, b) => {
    const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  const verified = verifyTrainerToken(token, { nowSec: Math.floor(Date.now() / 1000) }, hmacB64url, timingSafeEq);
  if (!verified.ok) {
    return envelope(res, { status: 'error', code: 'session_expired',
      message: 'Your training session has expired. Please end the call and start a new voice session to continue.' });
  }
  const userId = verified.claims.sub;

  // Body size + parse. On Vercel with content-type: application/json the body arrives
  // pre-parsed as an OBJECT, so the string-length guard below never fires in prod — check the
  // declared content-length header too so the cap holds either way.
  if (Number(req.headers?.['content-length']) > MAX_BODY_BYTES) {
    return envelope(res, { status: 'error', code: 'bad_request', message: 'That request was too large.' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return envelope(res, { status: 'error', code: 'bad_request', message: 'That request was too large.' });
    }
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // Per-instance burst guard.
  if (rateLimited(userId)) {
    return envelope(res, { status: 'error', code: 'rate_limited',
      message: 'You are moving quickly — give me a moment and ask again.' });
  }

  const admin = service();

  try {
    // Durable daily cap (fail CLOSED on RPC error — never serve content if the
    // counter can't be written).
    const { data: count, error: usageErr } = await admin.rpc('trainer_bump_usage', { p_user: userId, p_tool: action });
    if (usageErr) {
      if (isNotMigrated(usageErr)) {
        return envelope(res, { status: 'error', code: 'not_migrated',
          message: 'The AI trainer is not set up yet. I can still explain the app or open a course for you.' });
      }
      console.error('[trainer] usage counter unavailable', usageErr?.code || 'error');
      return envelope(res, { status: 'error', code: 'service_unavailable',
        message: 'The trainer is temporarily unavailable — try again in a moment.' });
    }
    if (Number(count) > (DAILY_CAP[action] || 150)) {
      return envelope(res, { status: 'error', code: 'usage_cap',
        message: "You've reached today's training limit. It resets tomorrow — you can still study your courses directly." });
    }

    // Fail-closed entitlement: the authorized course set for THIS user, now.
    const { data: visible, error: entErr } = await admin.rpc('trainer_visible_courses', { p_user: userId });
    if (entErr) {
      if (isNotMigrated(entErr)) {
        return envelope(res, { status: 'error', code: 'not_migrated',
          message: 'The AI trainer is not set up yet. I can still explain the app or open a course for you.' });
      }
      console.error('[trainer] entitlement check indeterminate — failing closed', entErr?.code || 'error');
      return envelope(res, { status: 'error', code: 'service_unavailable',
        message: 'The trainer is temporarily unavailable — try again in a moment.' });
    }
    const authorized = (visible || []).map((c) => ({ id: c.id, slug: c.slug, title: c.title, access_tier: c.access_tier }));

    let result;
    if (action === 'get_my_training_catalog') result = await doCatalog(admin, userId, authorized);
    else if (action === 'get_authorized_training_context') result = await doContext(admin, userId, authorized, body);
    else if (action === 'get_my_training_checkpoint') result = await doGetCheckpoint(admin, userId, authorized, body);
    else if (action === 'save_training_checkpoint') result = await doSaveCheckpoint(admin, userId, authorized, body);

    // Redacted log — codes/ids only, never content.
    console.log(`[trainer] ${action} user=${userId} code=${result?.code || '?'} course=${result?.course_id || result?.chunks?.[0]?.course_id || '-'}`);
    return envelope(res, result);
  } catch (err) {
    if (isNotMigrated(err)) {
      return envelope(res, { status: 'error', code: 'not_migrated',
        message: 'The AI trainer is not set up yet. I can still explain the app or open a course for you.' });
    }
    console.error('[trainer] action failed', err?.code || err?.name || 'error');
    return envelope(res, { status: 'error', code: 'service_unavailable',
      message: 'The trainer hit a snag — try again in a moment.' });
  }
}
