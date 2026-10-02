// ─────────────────────────────────────────────────────────────────────────────
// test-e2e/_onboarding.mjs — the Getting Started video (#69), for the rendered suites.
// ─────────────────────────────────────────────────────────────────────────────
// ★ A VIDEO LEFT PUBLISHED ON SHADOW CHANGES EVERY OTHER SUITE. A live version gates every
//   approved, enrolled student whose first subscription row is newer than its first publish —
//   which is every student persona a suite seeds — so they would all meet the Getting Started
//   screen instead of the page their suite expects, and fail by timing out on it. A suite that
//   publishes one therefore resets in before() AND after() (resetOnboardingVideos, the test-db
//   harness's helper, re-exported here), and a suite that needs none live says so up front
//   (assertNoLiveOnboardingVideo) with a message that names the cause.
// ★ THE CLIP IS RECORDED IN THE TEST'S OWN CHROME (recordClip). The repo has no video fixture and
//   this machine has no ffmpeg; the installed Chrome records video/mp4;codecs=avc1 headless (the
//   #69 pre-flight spike). The clip must have a real duration: without one the server's
//   completion floor is coalesce(null, 60 s) × 0.4 = 24 s instead of the 5 s minimum. Headless
//   MediaRecorder occasionally hands back 0 bytes, so a clip is recorded again, once, before
//   the suite gives up.
// ★ PUBLISHED THROUGH THE REAL AUTHORIZATION PATH (publishOnboardingVideo): the Super Admin's own
//   JWT calls the admin RPCs and writes the object through the bucket's storage policies. The
//   service role and the Management API only reset and read back.
// ★ A PUBLISH CAN BE STOPPED BETWEEN ITS WRITES, AND NONE OF ITS REQUESTS CAN HANG. node:test
//   does not stop a test body that times out — it goes on running after the suite's after() has
//   reset the shadow — so publishOnboardingVideo() asks the caller's halt() before each of its four
//   writes, and every request it makes has a deadline (clientFor's timeoutMs). A request already
//   sent is let finish rather than aborted early: an abandoned request can still commit on the
//   server, and then it would commit after the reset.
// ★ Nothing here returns a signed URL or a token from a page (the _cdp.mjs rule). The one thing
//   that crosses from Chrome to Node is the recorded clip's bytes and its duration.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runSql, shadowEnv } from '../scripts/_shadow.mjs';
import { resetOnboardingVideos } from '../test-db/_harness.mjs';
import { ONBOARDING_VIDEO_BUCKET, buildOnboardingVideoPath } from '../src/lib/gettingStarted.js';

export { resetOnboardingVideos };

/** What the recorder asks Chrome for — the codec every browser plays without a hardware decoder. */
export const CLIP_MIME = 'video/mp4;codecs=avc1';

/**
 * How many versions are PUBLISHED on the shadow project right now. A database without #69 has
 * no table and therefore nothing live: 0, not an error, so a suite that does not depend on #69
 * still runs against a shadow that predates it.
 */
export async function liveOnboardingVideoCount() {
  const [row] = await runSql(`select to_regclass('public.onboarding_videos') is not null as present`);
  if (!row?.present) return 0;
  const [live] = await runSql(`select count(*)::int as n from public.onboarding_videos where status = 'published'`);
  return Number(live?.n || 0);
}

/**
 * Fail at once, with the cause named, when a Getting Started video is live. Every student this
 * suite seeds would otherwise be held on the Getting Started screen and time out on a page it
 * never reaches — a failure that says nothing about why.
 */
export async function assertNoLiveOnboardingVideo(suite) {
  const n = await liveOnboardingVideoCount();
  if (n > 0) {
    throw new Error(
      `[${suite}] ${n} Getting Started video${n === 1 ? ' is' : 's are'} PUBLISHED on the shadow project. ` +
      'A live version holds every newly approved student on the Getting Started screen before their ' +
      'Dashboard, so this suite\'s student personas would never reach the screens it tests. Another run ' +
      '(test-e2e/gettingStarted.e2etest.mjs, test-db/onboardingVideo.dbtest.mjs) was interrupted before its ' +
      'cleanup. Reset it with resetOnboardingVideos() from test-db/_harness.mjs, then run this suite again.');
  }
}

/**
 * A supabase-js client that is exactly this persona: their JWT on every request, no refresh.
 * `timeoutMs` puts a deadline on every request it makes — the REST calls and the Storage upload
 * alike (supabase-js hands the same fetch to both) — so a caller awaiting it is never left on a
 * connection that went away. Pick it well past any server-side statement: a request abandoned at
 * the deadline has long since committed or rolled back.
 */
export function clientFor(session, { timeoutMs = null } = {}) {
  const e = shadowEnv();
  const global = { headers: { Authorization: `Bearer ${session.access_token}` } };
  if (timeoutMs) {
    global.fetch = (input, init = {}) => {
      const deadline = AbortSignal.timeout(timeoutMs);
      return fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    };
  }
  return createClient(e.SHADOW_SUPABASE_URL, e.SHADOW_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global,
  });
}

/**
 * Record a short MP4 in THIS Chrome — a canvas animation through MediaRecorder — and measure the
 * duration a <video> element reports for it. SELF-CONTAINED: it runs through page.evaluate().
 * The `setTimeout` below is the clip's length, not a wait for a condition.
 */
async function recordInPage(mime, ms) {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mime)) {
    return { bytes: 0, duration: null, error: `this Chrome's MediaRecorder cannot record ${mime}` };
  }
  const canvas = document.getElementById('c');
  const g = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 250000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  let frame = 0;
  const draw = () => {
    g.fillStyle = `hsl(${(frame * 6) % 360} 70% 50%)`;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fff';
    g.font = '32px sans-serif';
    g.fillText(`Getting Started ${frame}`, 24, 100);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 33);
  rec.start(250);
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'video/mp4' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let duration = null;
  if (buf.length) {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.src = url;
    duration = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 8000);
      v.onloadedmetadata = () => { clearTimeout(t); resolve(v.duration); };
      v.onerror = () => { clearTimeout(t); resolve(`error ${v.error && v.error.code}`); };
    });
    URL.revokeObjectURL(url);
  }
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  // Infinity does not survive the JSON crossing; say what it was instead.
  return { bytes: buf.length, duration: Number.isFinite(duration) ? duration : String(duration), b64: btoa(bin) };
}

/**
 * The clip: { buffer, durationSeconds, bytes, mime, attempts }. Recorded again once when Chrome
 * returns nothing or a clip with no finite duration; refused after that, with every attempt named.
 */
export async function recordClip(browser, { ms = 3000, attempts = 2 } = {}) {
  const page = await browser.newPage();
  try {
    await page.goto('data:text/html,<!doctype html><title>clip</title><canvas id=c width=320 height=180></canvas>');
    const tries = [];
    for (let i = 0; i < attempts; i += 1) {
      const r = await page.evaluate(recordInPage, CLIP_MIME, ms);
      tries.push({ bytes: r.bytes, duration: r.duration, error: r.error || null });
      if (r.bytes > 0 && typeof r.duration === 'number' && Number.isFinite(r.duration) && r.duration > 0) {
        const buffer = Buffer.from(r.b64, 'base64');
        return { buffer, bytes: buffer.length, durationSeconds: r.duration, mime: CLIP_MIME, attempts: tries };
      }
    }
    throw new Error(`Chrome recorded no usable ${CLIP_MIME} clip in ${attempts} attempts: ${JSON.stringify(tries)}`);
  } finally {
    await page.close();
  }
}

async function rpcOrThrow(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn} was refused: ${[error.hint, error.code, error.message].filter(Boolean).join(' · ')}`);
  return data;
}

/**
 * Publish `clip` as the live Getting Started video with the Super Admin's OWN session:
 * admin_onboarding_video_create_draft → a Storage upload into versions/<draft id>/<uuid>.mp4 (the
 * INSERT policy admits it only into a draft's folder, for a holder of onboarding.manage) →
 * admin_onboarding_video_attach_media (its byte size, video/mp4 and the duration Chrome measured)
 * → admin_onboarding_video_publish. Returns { videoId, durationSeconds, byteSize, attached,
 * published } — never the object's signed URL.
 *
 *   halt(step)        called before EACH of the four writes; throw from it to stop there. Nothing
 *                     after a throw is sent. (The suite's test 0 throws once it has timed out or
 *                     its after() has begun.)
 *   requestTimeoutMs  the deadline on each request (clientFor's timeoutMs)
 */
export async function publishOnboardingVideo(session, clip, {
  title, description = null, transcript = null, fileName = 'e2e-getting-started.mp4', replaceLive = false,
  halt = () => {}, requestTimeoutMs = 60000,
} = {}) {
  const db = clientFor(session, { timeoutMs: requestTimeoutMs });
  halt('creating the draft');
  const draft = await rpcOrThrow(db, 'admin_onboarding_video_create_draft',
    { p_title: title, p_description: description, p_transcript: transcript });
  const videoId = draft?.video_id;
  if (!videoId) throw new Error('admin_onboarding_video_create_draft returned no video id');
  const path = buildOnboardingVideoPath(videoId, randomUUID());
  // ★ 'video/mp4', not the recorder's 'video/mp4;codecs=avc1': the bucket's allowed_mime_types
  //   and attach_media's CHECK both name the bare type.
  halt('uploading the clip');
  const up = await db.storage.from(ONBOARDING_VIDEO_BUCKET).upload(path, clip.buffer,
    { contentType: 'video/mp4', upsert: false });
  if (up.error) throw new Error(`the Super Admin's upload into the draft's folder was refused: ${up.error.message}`);
  const durationSeconds = Math.round(clip.durationSeconds * 100) / 100;
  halt('attaching the clip');
  const attached = await rpcOrThrow(db, 'admin_onboarding_video_attach_media', {
    p_video_id: videoId,
    p_storage_path: path,
    p_byte_size: clip.buffer.length,
    p_mime_type: 'video/mp4',
    p_duration_seconds: durationSeconds,
    p_original_filename: fileName,
  });
  halt('publishing');
  const published = await rpcOrThrow(db, 'admin_onboarding_video_publish',
    { p_video_id: videoId, p_replace_live: replaceLive });
  return { videoId, durationSeconds, byteSize: clip.buffer.length, attached, published };
}
