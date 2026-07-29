// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless endpoint — ADMIN-ONLY AI course-trainer indexing + transcripts.
// ─────────────────────────────────────────────────────────────────────────────
// Holds the Supabase SERVICE-ROLE key + the ElevenLabs key. Every action:
//   1. verifies the caller's Supabase Bearer JWT (against /auth/v1/user), AND
//   2. independently confirms profiles.is_admin (read with the CALLER's JWT),
//   BEFORE the service-role client is constructed.
//
// Actions (POST body.action):
//   'status'             — { migrated, embeddings, pendingJobs, sourceCounts }
//   'sync'               — bounded resumable (re)index of a course's sources
//   'transcribe'         — Scribe v2 STT for ONE upload/mp4 lesson (→ pending review)
//   'save-transcript'    — manual/edited transcript for a lesson (or course notes)
//   'set-source-included'— include/exclude a source from retrieval
//   'retry-source'       — reset a failed source + its job to re-run
//   'preview'            — dry retrieval as a chosen plan (what a learner would get)
//   GET                  — health { ok, configured, hasElevenLabs }
//
// Chunking/idempotency come from src/lib/trainerContent.js (pure). Never logs
// lesson/transcript content. Runs on Vercel AND under `npm run dev`
// (courseTrainerDevApi in vite.config.js).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { elevenLabsApiBase } from '../elevenlabs/signed-url.js';
import { chunkText, ENROLLMENT_PLAN_KEYS } from '../../src/lib/trainerContent.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';

const MAX_BODY_BYTES = 1 * 1024 * 1024;    // transcript paste headroom
const SYNC_SOURCES_PER_BATCH = 5;
const SYNC_MAX_APPROVE_LOOPS = 40;         // approve-path drains the queue, bounded (≈200 sources)
const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 8000;
const SCRIBE_TIMEOUT_MS = 240_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Per-warm-instance burst guard ──
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;
const rateHits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (rateHits.get(userId) || []).filter((t) => t >= cutoff);
  if (hits.length >= RATE_MAX_PER_WINDOW) { rateHits.set(userId, hits); return true; }
  hits.push(now); rateHits.set(userId, hits);
  return false;
}

// ── Auth (never touches the service key) ──
async function callerUser(authHeader) {
  if (!authHeader || !SUPABASE_URL || !ANON_KEY) return null;
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, token } : null;
  } catch { return null; }
}
async function callerIsAdmin(u) {
  if (!u) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=is_admin`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${u.token}` } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0]?.is_admin === true;
  } catch { return false; }
}

function service() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const sha256hex = (text) => crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
function isNotMigrated(err) {
  const code = err?.code || '';
  return code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST204';
}

// Embed an array of texts via the trainer-embed Edge Function.
// Returns { vectors: number[384][] } or { vectors: null } (→ keyword-only). Never throws.
async function embedTexts(texts) {
  if (!SUPABASE_URL || !SERVICE_KEY || !texts.length) return { vectors: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/trainer-embed`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ texts: texts.map((t) => String(t).slice(0, 4000)) }),
      signal: controller.signal,
    });
    if (!r.ok) return { vectors: null };
    const data = await r.json();
    const vecs = Array.isArray(data?.embeddings) ? data.embeddings : null;
    if (!vecs || vecs.length !== texts.length || vecs.some((v) => !Array.isArray(v) || v.length !== 384)) {
      console.warn('[course-trainer] embed dim/shape mismatch — keyword fallback');
      return { vectors: null };
    }
    return { vectors: vecs };
  } catch {
    return { vectors: null };
  } finally {
    clearTimeout(timer);
  }
}

async function edgeEmbedReachable() {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/trainer-embed`, {
      method: 'GET',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      signal: controller.signal,
    });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

// ── Actions (each returns { status, body }) ──────────────────────────────────

async function doStatus(admin, courseId) {
  if (!UUID_RE.test(courseId || '')) return { status: 400, body: { error: 'course_id required.' } };
  try {
    const { data: sources, error } = await admin.from('course_ai_sources')
      .select('status').eq('course_id', courseId);
    if (error) throw error;
    const counts = {};
    for (const s of sources || []) counts[s.status] = (counts[s.status] || 0) + 1;
    const { count: pendingJobs } = await admin.from('course_ai_index_jobs')
      .select('id', { count: 'exact', head: true }).eq('course_id', courseId).in('status', ['queued', 'processing']);
    const { count: nullEmb } = await admin.from('course_ai_chunks')
      .select('id', { count: 'exact', head: true }).eq('course_id', courseId).is('embedding', null);
    const { count: totalChunks } = await admin.from('course_ai_chunks')
      .select('id', { count: 'exact', head: true }).eq('course_id', courseId);
    const reachable = await edgeEmbedReachable();
    let embeddings = 'unknown';
    if (totalChunks === 0) embeddings = reachable ? 'vector' : 'keyword';
    else embeddings = (nullEmb || 0) === 0 && reachable ? 'vector' : (nullEmb === totalChunks ? 'keyword' : 'partial');
    return { status: 200, body: { ok: true, migrated: true, embeddings, edgeReachable: reachable,
      pendingJobs: pendingJobs || 0, sourceCounts: counts, totalChunks: totalChunks || 0 } };
  } catch (err) {
    if (isNotMigrated(err)) return { status: 200, body: { ok: true, migrated: false } };
    throw err;
  }
}

// Refresh lesson_text sources from the live lesson text, then re-index a bounded
// batch of pending/stale sources. Resumable: returns { done, remaining }.
async function doSync(admin, courseId) {
  if (!UUID_RE.test(courseId || '')) return { status: 400, body: { error: 'course_id required.' } };

  // 1) Sync lesson_text sources from live lesson content (sha256 idempotency). The
  //    LIVE lesson text is the sole authority: emptying a lesson's text DELETES its
  //    lesson_text source (cascade drops its chunks) so removed content can never be
  //    resurrected by a later re-index of a stale snapshot.
  const { data: lessons, error: lerr } = await admin.from('course_lessons')
    .select('id,title,text_content').eq('course_id', courseId);
  if (lerr) { if (isNotMigrated(lerr)) return { status: 200, body: { ok: true, migrated: false } }; throw lerr; }
  const liveText = new Map();
  for (const l of lessons || []) {
    const text = String(l.text_content || '').trim();
    liveText.set(l.id, text);
    const { data: existing } = await admin.from('course_ai_sources')
      .select('id,content_hash,status,source_version').eq('lesson_id', l.id).eq('kind', 'lesson_text').maybeSingle();
    if (!text) {
      if (existing) await admin.from('course_ai_sources').delete().eq('id', existing.id); // purges chunks via FK cascade
      continue;
    }
    const hash = sha256hex(text);
    if (!existing) {
      await admin.from('course_ai_sources').insert({
        course_id: courseId, lesson_id: l.id, kind: 'lesson_text', status: 'pending',
        title: l.title, content: text, content_hash: hash, source_version: 1, updated_at: new Date().toISOString(),
      });
    } else if (existing.content_hash !== hash) {
      await admin.from('course_ai_sources').update({
        title: l.title, content: text, content_hash: hash,
        source_version: (existing.source_version || 1) + 1, status: 'pending', updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    }
  }

  // 2) Take a bounded batch of sources needing work.
  const { data: batch, error: berr } = await admin.from('course_ai_sources')
    .select('id,course_id,lesson_id,kind,content,content_hash,source_version,title')
    .eq('course_id', courseId).in('status', ['pending', 'stale'])
    .order('updated_at', { ascending: true }).limit(SYNC_SOURCES_PER_BATCH);
  if (berr) throw berr;

  // Module/lesson titles for citation labels.
  const { data: modLessons } = await admin.from('course_lessons')
    .select('id,title,module_id').eq('course_id', courseId);
  const { data: modules } = await admin.from('course_modules').select('id,title').eq('course_id', courseId);
  const moduleTitle = new Map((modules || []).map((m) => [m.id, m.title]));
  const lessonInfo = new Map((modLessons || []).map((l) => [l.id, { title: l.title, moduleTitle: moduleTitle.get(l.module_id) || '' }]));

  let embeddingsMode = 'vector';
  let processed = 0;
  for (const src of batch || []) {
    try {
      await admin.from('course_ai_sources').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', src.id);
      const li = src.lesson_id ? lessonInfo.get(src.lesson_id) : null;
      // For a lesson_text source, index the LIVE lesson text (re-read this call), not the
      // stored snapshot — so an edit that landed after step 1, or a concurrent sync's stale
      // 'processing' row, indexes current content. If the lesson text was emptied since,
      // drop the source instead of re-readying old content.
      let content = src.content || '';
      let version = src.source_version;
      if (src.kind === 'lesson_text' && src.lesson_id != null) {
        const live = liveText.get(src.lesson_id);
        if (live == null || live === '') {
          await admin.from('course_ai_sources').delete().eq('id', src.id); // cascade drops chunks
          continue;
        }
        if (sha256hex(live) !== src.content_hash) {
          version = (src.source_version || 1) + 1;
          await admin.from('course_ai_sources').update({
            content: live, content_hash: sha256hex(live), source_version: version, updated_at: new Date().toISOString(),
          }).eq('id', src.id);
        }
        content = live;
      }
      const chunks = chunkText(content);
      // Replace this source's chunks atomically-ish (delete then insert).
      await admin.from('course_ai_chunks').delete().eq('source_id', src.id);
      if (chunks.length) {
        const { vectors } = await embedTexts(chunks.map((c) => c.content));
        if (!vectors) embeddingsMode = 'keyword';
        const rows = chunks.map((c, i) => ({
          source_id: src.id, course_id: courseId, lesson_id: src.lesson_id || null,
          module_title: li?.moduleTitle || null, lesson_title: li?.title || src.title || null,
          chunk_index: c.index, content: c.content, content_hash: sha256hex(c.content),
          source_version: version, embedding: vectors ? vectors[i] : null,
        }));
        // Insert in reasonable pages.
        for (let i = 0; i < rows.length; i += EMBED_BATCH) {
          const { error: ierr } = await admin.from('course_ai_chunks').insert(rows.slice(i, i + EMBED_BATCH));
          if (ierr) throw ierr;
        }
      }
      await admin.from('course_ai_sources').update({
        status: 'ready', indexed_at: new Date().toISOString(), error_detail: null, updated_at: new Date().toISOString(),
      }).eq('id', src.id);
      await admin.from('course_ai_index_jobs').update({ status: 'done', finished_at: new Date().toISOString() })
        .eq('source_id', src.id).eq('kind', 'index').in('status', ['queued', 'processing']);
      processed += 1;
    } catch (err) {
      await admin.from('course_ai_sources').update({
        status: 'failed', error_detail: String(err?.code || err?.name || 'index_error'), updated_at: new Date().toISOString(),
      }).eq('id', src.id);
      await admin.from('course_ai_index_jobs').update({
        status: 'failed', attempts: 1, error_detail: String(err?.code || 'index_error'), finished_at: new Date().toISOString(),
      }).eq('source_id', src.id).eq('kind', 'index').in('status', ['queued', 'processing']);
    }
  }

  const { count: remaining } = await admin.from('course_ai_sources')
    .select('id', { count: 'exact', head: true }).eq('course_id', courseId).in('status', ['pending', 'stale']);
  return { status: 200, body: { ok: true, processed, remaining: remaining || 0, done: (remaining || 0) === 0, embeddings: embeddingsMode } };
}

async function doTranscribe(admin, lessonId) {
  if (!UUID_RE.test(lessonId || '')) return { status: 400, body: { error: 'lesson_id required.' } };
  if (!ELEVENLABS_KEY) return { status: 200, body: { ok: false, error: 'Transcription is not configured (ELEVENLABS_API_KEY missing). You can paste a transcript manually.' } };
  const { data: lesson, error } = await admin.from('course_lessons')
    .select('id,course_id,title,video_provider,storage_path,video_url').eq('id', lessonId).maybeSingle();
  if (error) { if (isNotMigrated(error)) return { status: 200, body: { ok: false, migrated: false } }; throw error; }
  if (!lesson) return { status: 404, body: { error: 'Lesson not found.' } };
  if (!['upload', 'mp4'].includes(lesson.video_provider)) {
    return { status: 400, body: { error: 'Auto-transcription only works for uploaded videos or direct MP4 links. YouTube/Vimeo lessons need a manual transcript (never scraped).' } };
  }
  // No concurrent transcribe job for this lesson.
  const { data: running } = await admin.from('course_ai_sources')
    .select('id,status,source_version').eq('lesson_id', lessonId).eq('kind', 'transcript').maybeSingle();
  if (running?.status === 'processing') return { status: 409, body: { error: 'A transcription is already running for this lesson.' } };

  // Media URL.
  let sourceUrl = '';
  if (lesson.video_provider === 'upload') {
    const { data: signed, error: serr } = await admin.storage.from('course-videos').createSignedUrl(lesson.storage_path, 3600);
    if (serr || !signed?.signedUrl) return { status: 502, body: { error: 'Could not read the video file.' } };
    sourceUrl = signed.signedUrl;
  } else {
    sourceUrl = lesson.video_url;
    if (!/^https:\/\//i.test(sourceUrl || '')) return { status: 400, body: { error: 'The MP4 link must be a public https URL.' } };
  }

  // Mark processing + a job row. NOTE: the (lesson_id, kind) unique index is PARTIAL
  // (where lesson_id is not null), which PostgREST's upsert onConflict cannot target —
  // so this is an explicit update-or-insert instead.
  const nextVersion = (running?.source_version || 0) + 1;
  const srcFields = { course_id: lesson.course_id, lesson_id: lessonId, kind: 'transcript', status: 'processing',
    title: lesson.title, source_version: nextVersion, updated_at: new Date().toISOString() };
  let srcRow = null;
  if (running?.id) {
    const { data } = await admin.from('course_ai_sources').update(srcFields).eq('id', running.id).select('id').maybeSingle();
    srcRow = data;
  } else {
    const { data } = await admin.from('course_ai_sources').insert(srcFields).select('id').maybeSingle();
    srcRow = data;
  }
  if (!srcRow?.id) return { status: 502, body: { error: 'Could not start the transcript record.' } };
  await admin.from('course_ai_index_jobs').insert({ course_id: lesson.course_id, source_id: srcRow?.id || null, kind: 'transcribe', status: 'processing', started_at: new Date().toISOString() });

  // Scribe v2 (sync). source_url = the signed/https media URL.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRIBE_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('model_id', 'scribe_v2');
    form.append('source_url', sourceUrl);
    const r = await fetch(`${elevenLabsApiBase()}/v1/speech-to-text`, {
      method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY }, body: form, signal: controller.signal,
    });
    const raw = await r.text();
    if (!r.ok) {
      console.error(`[course-trainer] scribe ${r.status}`);
      await failTranscript(admin, srcRow?.id, `scribe_${r.status}`);
      return { status: 502, body: { ok: false, error: 'Transcription failed. You can retry or paste a transcript manually.' } };
    }
    let data; try { data = JSON.parse(raw); } catch { data = null; }
    const text = String(data?.text || '').trim();
    if (!text) { await failTranscript(admin, srcRow?.id, 'scribe_empty'); return { status: 502, body: { ok: false, error: 'Transcription returned no text.' } }; }
    await admin.from('course_ai_sources').update({
      content: text, content_hash: sha256hex(text), transcript_origin: 'scribe',
      language_code: data?.language_code || null, status: 'pending', transcribed_at: new Date().toISOString(),
      error_detail: null, updated_at: new Date().toISOString(),
    }).eq('id', srcRow?.id);
    await admin.from('course_ai_index_jobs').update({ status: 'done', finished_at: new Date().toISOString() })
      .eq('source_id', srcRow?.id).eq('kind', 'transcribe').eq('status', 'processing');
    return { status: 200, body: { ok: true, status: 'pending', chars: text.length, language_code: data?.language_code || null } };
  } catch (err) {
    await failTranscript(admin, srcRow?.id, String(err?.name === 'AbortError' ? 'scribe_timeout' : 'scribe_error'));
    return { status: 502, body: { ok: false, error: 'Transcription failed or timed out. Retry, or paste a transcript manually.' } };
  } finally {
    clearTimeout(timer);
  }
}

async function failTranscript(admin, sourceId, code) {
  if (!sourceId) return;
  await admin.from('course_ai_sources').update({ status: 'failed', error_detail: code, updated_at: new Date().toISOString() }).eq('id', sourceId);
  await admin.from('course_ai_index_jobs').update({ status: 'failed', error_detail: code, finished_at: new Date().toISOString() })
    .eq('source_id', sourceId).eq('kind', 'transcribe').eq('status', 'processing');
}

async function doSaveTranscript(admin, body) {
  const { lesson_id: lessonId, course_id: courseNotesCourseId, content, approve, course_notes: courseNotes } = body || {};
  const text = String(content || '').trim();
  if (!text) return { status: 400, body: { error: 'content required.' } };
  let courseId, target;
  if (courseNotes) {
    if (!UUID_RE.test(courseNotesCourseId || '')) return { status: 400, body: { error: 'course_id required for trainer notes.' } };
    courseId = courseNotesCourseId;
    const { data: existing } = await admin.from('course_ai_sources')
      .select('id,source_version,transcript_origin').eq('course_id', courseId).is('lesson_id', null).eq('kind', 'trainer_notes').maybeSingle();
    target = { existing, kind: 'trainer_notes', lesson_id: null };
  } else {
    if (!UUID_RE.test(lessonId || '')) return { status: 400, body: { error: 'lesson_id required.' } };
    const { data: lesson } = await admin.from('course_lessons').select('id,course_id,title').eq('id', lessonId).maybeSingle();
    if (!lesson) return { status: 404, body: { error: 'Lesson not found.' } };
    courseId = lesson.course_id;
    const { data: existing } = await admin.from('course_ai_sources')
      .select('id,source_version,transcript_origin').eq('lesson_id', lessonId).eq('kind', 'transcript').maybeSingle();
    target = { existing, kind: 'transcript', lesson_id: lessonId, title: lesson.title };
  }
  const nextVersion = (target.existing?.source_version || 0) + 1;
  // Keep 'scribe' origin only if editing a scribe transcript AND it's a transcript kind.
  const origin = target.kind === 'transcript'
    ? (target.existing?.transcript_origin === 'scribe' ? 'scribe' : 'manual')
    : null;
  const row = {
    course_id: courseId, lesson_id: target.lesson_id, kind: target.kind, status: 'pending',
    title: target.title || null, content: text, content_hash: sha256hex(text),
    source_version: nextVersion, transcript_origin: origin, updated_at: new Date().toISOString(),
  };
  // Both unique indexes on course_ai_sources are PARTIAL — PostgREST upsert can't
  // target them, so update-or-insert explicitly (target.existing was just selected).
  let srcRow, error;
  if (target.existing?.id) {
    ({ data: srcRow, error } = await admin.from('course_ai_sources').update(row).eq('id', target.existing.id).select('id').maybeSingle());
  } else {
    ({ data: srcRow, error } = await admin.from('course_ai_sources').insert(row).select('id').maybeSingle());
  }
  if (error) { if (isNotMigrated(error)) return { status: 200, body: { ok: false, migrated: false } }; throw error; }

  if (approve) {
    // Index to COMPLETION (bounded), not a single batch. doSync pulls the oldest-updated_at
    // sources first, but the source we just saved has the NEWEST updated_at — so with
    // ≥SYNC_SOURCES_PER_BATCH other pending/stale sources it sorts LAST and a single doSync
    // would skip it while we (previously) reported "indexed". Loop until the queue drains or
    // a safety cap, and report the ACTUAL state (indexed only when the queue is empty).
    let r; let guard = 0;
    do {
      r = await doSync(admin, courseId);
      if (r.body?.migrated === false) return { status: 200, body: { ok: false, migrated: false } };
      guard += 1;
    } while (r.body?.done === false && guard < SYNC_MAX_APPROVE_LOOPS);
    return { status: 200, body: { ok: true, indexed: r.body?.done === true, sync: r.body } };
  }
  return { status: 200, body: { ok: true, source_id: srcRow?.id, status: 'pending' } };
}

async function doSetIncluded(admin, body) {
  const { source_id: sourceId, included } = body || {};
  if (!UUID_RE.test(sourceId || '')) return { status: 400, body: { error: 'source_id required.' } };
  const { error } = await admin.from('course_ai_sources')
    .update({ included: included !== false, updated_at: new Date().toISOString() }).eq('id', sourceId);
  if (error) throw error;
  return { status: 200, body: { ok: true } };
}

async function doRetrySource(admin, body) {
  const { source_id: sourceId } = body || {};
  if (!UUID_RE.test(sourceId || '')) return { status: 400, body: { error: 'source_id required.' } };
  const { data: src } = await admin.from('course_ai_sources').select('id,course_id').eq('id', sourceId).maybeSingle();
  if (!src) return { status: 404, body: { error: 'Source not found.' } };
  await admin.from('course_ai_sources').update({ status: 'pending', error_detail: null, updated_at: new Date().toISOString() }).eq('id', sourceId);
  await admin.from('course_ai_index_jobs').insert({ course_id: src.course_id, source_id: sourceId, kind: 'index', status: 'queued' });
  return { status: 200, body: { ok: true } };
}

async function doPreview(admin, body) {
  const planKey = String(body?.plan_key || '');
  const query = String(body?.query || '').trim();
  if (!ENROLLMENT_PLAN_KEYS.includes(planKey)) return { status: 400, body: { error: 'A known plan_key is required.' } };
  if (!query) return { status: 400, body: { error: 'query required.' } };
  try {
    const { data: courses } = await admin.rpc('trainer_courses_for_plan', { p_plan_key: planKey });
    const { vectors } = await embedTexts([query]);
    const { data: chunks, error } = await admin.rpc('trainer_preview_chunks', {
      p_plan_key: planKey, p_query: query, p_query_embedding: vectors ? vectors[0] : null, p_limit: 6,
    });
    if (error) throw error;
    return { status: 200, body: {
      ok: true,
      courses: (courses || []).map((c) => ({ id: c.id, slug: c.slug, title: c.title, access_tier: c.access_tier })),
      chunks: (chunks || []).map((c) => ({
        course_title: c.course_title, module_title: c.module_title, lesson_title: c.lesson_title,
        excerpt: String(c.content || '').slice(0, 200), score: c.score,
      })),
      embeddings: vectors ? 'vector' : 'keyword',
    } };
  } catch (err) {
    if (isNotMigrated(err)) return { status: 200, body: { ok: true, migrated: false } };
    throw err;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: Boolean(SUPABASE_URL && SERVICE_KEY),
      hasElevenLabs: Boolean(ELEVENLABS_KEY),
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server trainer admin is not configured (SUPABASE_SECRET_KEY missing).' });
  }

  const u = await callerUser(req.headers?.authorization);
  if (!u) return res.status(401).json({ error: 'Sign in as an admin.' });
  if (!(await callerIsAdmin(u))) return res.status(403).json({ error: 'Admin authorization required.' });
  if (rateLimited(u.id)) return res.status(429).json({ error: 'Too many requests — wait a minute.' });

  if (Number(req.headers?.['content-length']) > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request too large.' });
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request too large.' });
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};
  const action = body.action;
  const admin = service();

  try {
    let r;
    if (action === 'status') r = await doStatus(admin, body.course_id);
    else if (action === 'sync') r = await doSync(admin, body.course_id);
    else if (action === 'transcribe') r = await doTranscribe(admin, body.lesson_id);
    else if (action === 'save-transcript') r = await doSaveTranscript(admin, body);
    else if (action === 'set-source-included') r = await doSetIncluded(admin, body);
    else if (action === 'retry-source') r = await doRetrySource(admin, body);
    else if (action === 'preview') r = await doPreview(admin, body);
    else return res.status(400).json({ error: "Unknown action." });
    return res.status(r.status).json(r.body);
  } catch (err) {
    if (isNotMigrated(err)) return res.status(200).json({ ok: false, migrated: false });
    console.error(`[course-trainer] ${action} failed: ${String(err?.code || err?.name || 'error')}`);
    return res.status(500).json({ error: 'Trainer operation failed.' });
  }
}
