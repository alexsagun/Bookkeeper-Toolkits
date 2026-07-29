// Run with: node --test
// Covers src/lib/trainerContent.js — chunking, course resolution, access
// classification, the response envelope, and the safe learner-facing messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAINER_CHUNK_MAX_CHARS,
  TRAINER_MAX_CHUNKS,
  TRAINER_MAX_TOTAL_CHARS,
  chunkText,
  normalizeCourseRef,
  resolveCourseRef,
  classifyCourseAccess,
  buildSourceLabel,
  buildTrainerEnvelope,
  clampCheckpoint,
  DENIAL_MESSAGE,
  NOT_READY_MESSAGE,
  NOT_FOUND_MESSAGE,
} from '../src/lib/trainerContent.js';

const COURSES = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'qbo-mastery', title: 'QuickBooks Online Mastery', access_tier: 'standard' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'qbo-essentials', title: 'QuickBooks Online Essentials', access_tier: 'essentials' },
  { id: '33333333-3333-4333-8333-333333333333', slug: 'resume-strategy', title: 'Resume Winning Strategy', access_tier: 'standard' },
];

// ── chunkText ────────────────────────────────────────────────────────────────

test('chunkText is deterministic and bounded', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} about bank feeds and reconciliation. It has a couple of sentences. Here is another one.`).join('\n\n');
  const a = chunkText(text);
  const b = chunkText(text);
  assert.deepEqual(a, b);
  assert.ok(a.length > 1);
  for (const ch of a) {
    assert.ok(ch.content.length <= TRAINER_CHUNK_MAX_CHARS, `chunk ${ch.index} too long (${ch.content.length})`);
    assert.ok(ch.content.trim().length > 0);
  }
  assert.deepEqual(a.map((c) => c.index), a.map((_, i) => i));
});

test('chunkText handles blank + pathological input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  assert.deepEqual(chunkText(null), []);
  // A wall with NO sentence breaks but position-DISTINGUISHABLE characters (period 26),
  // so the overlap assertion below only holds for the exact offset — a dropped or wrong
  // overlap distance (e.g. `start += max` instead of `max - overlap`) would fail it.
  const MAX = TRAINER_CHUNK_MAX_CHARS;   // 1200
  const OVERLAP = 150;
  const wall = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  const chunks = chunkText(wall);
  assert.ok(chunks.length >= 4);
  for (const ch of chunks) assert.ok(ch.content.length <= MAX);
  // First chunk is [0, MAX); the second hard-slice starts at MAX - OVERLAP, so the last
  // OVERLAP chars of chunk 0 equal the first OVERLAP chars of chunk 1 — the real shared window.
  assert.equal(chunks[0].content.slice(0, MAX), wall.slice(0, MAX));
  assert.equal(chunks[1].content.slice(0, OVERLAP), wall.slice(MAX - OVERLAP, MAX));
  assert.equal(chunks[0].content.slice(-OVERLAP), chunks[1].content.slice(0, OVERLAP));
  // Sanity: this only distinguishes because the content is non-uniform.
  assert.notEqual(wall.slice(MAX - OVERLAP, MAX), wall.slice(MAX, MAX + OVERLAP));
});

// ── resolution ───────────────────────────────────────────────────────────────

test('resolveCourseRef: id, slug, alias, title, fuzzy, miss', () => {
  assert.equal(resolveCourseRef(COURSES[0].id, COURSES), COURSES[0]);
  assert.equal(resolveCourseRef('qbo-essentials', COURSES), COURSES[1]);
  assert.equal(resolveCourseRef('QBO Mastery', COURSES), COURSES[0]);        // alias → slug
  assert.equal(resolveCourseRef('the quickbooks online mastery course', COURSES), COURSES[0]); // normalized title
  assert.equal(resolveCourseRef('resume winning strategy', COURSES), COURSES[2]);
  assert.equal(resolveCourseRef('resume strategy', COURSES), COURSES[2]);    // prefix alias, unique match
  assert.equal(resolveCourseRef('quickbooks', COURSES), null);               // prefix alias, TWO qbo-* matches → ambiguous
  assert.equal(resolveCourseRef('quickbooks essentials', COURSES), COURSES[1]); // fuzzy tokens
  assert.equal(resolveCourseRef('Live Group Track', COURSES), null);         // a PLAN name, not a course
  assert.equal(resolveCourseRef('underwater basket weaving', COURSES), null);
  assert.equal(resolveCourseRef('', COURSES), null);
});

test('normalizeCourseRef strips fillers and punctuation', () => {
  assert.equal(normalizeCourseRef('The QuickBooks Online Mastery course!'), 'quickbooks online mastery');
  assert.equal(normalizeCourseRef('  My résumé  '), 'r sum');
});

// ── classification ───────────────────────────────────────────────────────────

test('classifyCourseAccess: allowed / denied / not_found / not_ready', () => {
  const authorized = [COURSES[1]];         // sampler-like: essentials only
  const allPublished = COURSES;

  const allowed = classifyCourseAccess({ ref: 'qbo essentials', authorized, allPublished });
  assert.equal(allowed.status, 'allowed');
  assert.equal(allowed.course, COURSES[1]);

  const denied = classifyCourseAccess({ ref: 'QBO Mastery', authorized, allPublished });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.course, COURSES[0]);

  const notFound = classifyCourseAccess({ ref: 'Live Group Track', authorized, allPublished });
  assert.equal(notFound.status, 'not_found');
  assert.equal(notFound.course, null);

  const notReady = classifyCourseAccess({
    ref: 'qbo essentials', authorized, allPublished, readyCourseIds: [],
  });
  assert.equal(notReady.status, 'not_ready');
  assert.equal(notReady.course, COURSES[1]);
});

// ── messages ─────────────────────────────────────────────────────────────────

test('denial message names plan + allowed titles, never protected material', () => {
  const msg = DENIAL_MESSAGE('QBO Mastery Only', ['QuickBooks Online Mastery', 'QuickBooks Online Essentials']);
  assert.match(msg, /QBO Mastery Only/);
  assert.match(msg, /QuickBooks Online Mastery and QuickBooks Online Essentials/);
  assert.match(msg, /upgrade/i);
  assert.doesNotMatch(msg, /module|lesson|outline/i);
  // No allowed courses → still safe + upsell.
  assert.match(DENIAL_MESSAGE('Sampler Session', []), /upgrade/i);
});

test('not_ready / not_found messages are safe and helpful', () => {
  assert.match(NOT_READY_MESSAGE('Resume Winning Strategy'), /isn't ready for AI training yet/);
  assert.match(NOT_FOUND_MESSAGE(['A', 'B']), /A and B/);
  assert.match(NOT_FOUND_MESSAGE([]), /couldn't find/);
});

// ── envelope ─────────────────────────────────────────────────────────────────

test('buildTrainerEnvelope clamps chunk count, sizes and strips unknown fields', () => {
  const bigChunk = 'y'.repeat(TRAINER_CHUNK_MAX_CHARS + 500);
  const env = buildTrainerEnvelope({
    status: 'ok',
    code: 'ok',
    message: 'm'.repeat(1000),
    chunks: Array.from({ length: TRAINER_MAX_CHUNKS + 3 }, (_, i) => ({
      content: bigChunk, course_id: COURSES[0].id, lesson_id: null, label: `L${i}`, secret_internal: 'leak-me',
    })),
    citations: [{ course_id: COURSES[0].id, course_slug: 'qbo-mastery', lesson_id: null, label: 'QBO › M1 › L1', extra: 'nope' }],
    next_actions: ['open_course_lesson'],
    unexpected_top_level: 'should vanish',
  });
  assert.equal(env.status, 'ok');
  assert.ok(env.message.length <= 600);
  assert.ok(env.chunks.length <= TRAINER_MAX_CHUNKS);
  const total = env.chunks.reduce((n, c) => n + c.content.length, 0);
  assert.ok(total <= TRAINER_MAX_TOTAL_CHARS, `total ${total}`);
  for (const c of env.chunks) {
    assert.ok(c.content.length <= TRAINER_CHUNK_MAX_CHARS);
    assert.equal('secret_internal' in c, false);
  }
  assert.equal('unexpected_top_level' in env, false);
  assert.equal('extra' in env.citations[0], false);
});

test('buildTrainerEnvelope defaults bad status to error', () => {
  const env = buildTrainerEnvelope({ status: 'weird', code: '', message: '' });
  assert.equal(env.status, 'error');
  assert.equal(env.code, 'unknown');
});

// ── checkpoint clamp + labels ────────────────────────────────────────────────

test('clampCheckpoint mirrors the SQL bounds', () => {
  const cp = clampCheckpoint({
    topic: 't'.repeat(500), mode: 'quiz', understanding: 'u'.repeat(500), next_step: 'n'.repeat(500),
  });
  assert.equal(cp.topic.length, 200);
  assert.equal(cp.understanding.length, 400);
  assert.equal(cp.next_step.length, 400);
  assert.equal(cp.mode, 'quiz');
  assert.equal(clampCheckpoint({ mode: 'lecture' }).mode, null);
});

test('buildSourceLabel joins present parts', () => {
  assert.equal(buildSourceLabel({ courseTitle: 'QBO Mastery', moduleTitle: 'Module 2', lessonTitle: 'Bank Feeds' }), 'QBO Mastery › Module 2 › Bank Feeds');
  assert.equal(buildSourceLabel({ courseTitle: 'QBO Mastery' }), 'QBO Mastery');
  assert.equal(buildSourceLabel({}), '');
});
