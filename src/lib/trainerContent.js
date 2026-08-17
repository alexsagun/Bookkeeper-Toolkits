// ─────────────────────────────────────────────────────────────────────────────
// trainerContent.js — PURE, dependency-free AI-course-trainer content logic.
// ─────────────────────────────────────────────────────────────────────────────
// Shared by the trainer webhook (api/elevenlabs/trainer.js), the admin endpoint
// (api/admin/course-trainer.js), the client (src/BookkeeperPro.jsx), and the
// node:test suite (test/trainerContent.test.mjs / test/trainerAccess.test.mjs).
// NO imports, NO side effects, NO DOM/Node/Supabase.
//
// AUTHORIZATION RULE (encoded here): course access is decided against the
// SERVER-authorized course list (trainer_visible_courses in SQL — the caller
// passes its result in). `denied` NEVER leaks protected material: the denial
// message names the learner's plan and their ALLOWED course titles only — no
// lesson/module titles, no outlines, no content. planScopeAllows() is the pure
// mirror of the SQL plan-scope truth table (courses_read / trainer_visible_
// courses) — keep all three in lockstep when entitlements change.
// ─────────────────────────────────────────────────────────────────────────────

export const TRAINER_MODES = ['explain', 'guided', 'quiz', 'practice', 'recap'];
// Seeded enrollment plan keys (mirrors the enrollment_plans seed) — the admin
// preview-as-plan selector validates against this list, so a retired key (#39
// removed core_self_paced + gold_live) is rejected with a 400 rather than
// previewed. Keep in lockstep with src/lib/planCatalog.js.
export const ENROLLMENT_PLAN_KEYS = ['sampler', 'silver_self_paced', 'vip'];
export const TRAINER_CHUNK_MAX_CHARS = 1200;
export const TRAINER_CHUNK_OVERLAP_CHARS = 150;
export const TRAINER_MAX_CHUNKS = 6;
export const TRAINER_MAX_TOTAL_CHARS = 6500;
export const TRAINER_MAX_CITATIONS = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Chunking ─────────────────────────────────────────────────────────────────
// Deterministic: paragraph-first accumulation, sentence fallback for oversized
// paragraphs, hard slice (with overlap) for pathological runs. Blank → [].
export function chunkText(text, { maxChars = TRAINER_CHUNK_MAX_CHARS, overlapChars = TRAINER_CHUNK_OVERLAP_CHARS } = {}) {
  const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const max = Math.max(200, Math.floor(maxChars));
  const overlap = Math.min(Math.max(0, Math.floor(overlapChars)), Math.floor(max / 2));

  const pieces = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= max) {
      pieces.push(p);
      continue;
    }
    // Oversized paragraph → sentences.
    let buf = '';
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length > max) {
        if (buf) { pieces.push(buf); buf = ''; }
        // Pathological sentence → hard slices with overlap.
        let start = 0;
        while (start < s.length) {
          pieces.push(s.slice(start, start + max));
          if (start + max >= s.length) break;
          start += max - overlap;
        }
        continue;
      }
      if (!buf) buf = s;
      else if (buf.length + 1 + s.length <= max) buf += ' ' + s;
      else { pieces.push(buf); buf = s; }
    }
    if (buf) pieces.push(buf);
  }

  // Merge small neighbouring pieces up to max so chunks stay meaty.
  const chunks = [];
  let acc = '';
  for (const piece of pieces) {
    if (!acc) acc = piece;
    else if (acc.length + 2 + piece.length <= max) acc += '\n\n' + piece;
    else { chunks.push(acc); acc = piece; }
  }
  if (acc) chunks.push(acc);
  return chunks.map((content, index) => ({ index, content }));
}

// ── Course reference resolution ──────────────────────────────────────────────
// Spoken aliases → a slug (exact) or a slug prefix (unique-match only). Pure
// literal, tiny on purpose — course titles/slugs themselves are matched live.
export const TRAINER_COURSE_ALIASES = {
  'qbo': { prefix: 'qbo-' },
  'quickbooks': { prefix: 'qbo-' },
  'quickbooks online': { prefix: 'qbo-' },
  'qbo mastery': { slug: 'qbo-mastery' },
  'quickbooks mastery': { slug: 'qbo-mastery' },
  'quickbooks online mastery': { slug: 'qbo-mastery' },
  'resume': { prefix: 'resume-' },
  'resume strategy': { prefix: 'resume-' },
  'resume winning strategy': { slug: 'resume-strategy' },
  'interview': { prefix: 'interview-' },
  'interview strategy': { prefix: 'interview-' },
  'interview winning strategy': { slug: 'interview-winning-strategy' },
};

const FILLER_WORDS = new Set(['the', 'a', 'an', 'my', 'course', 'courses', 'class', 'training', 'please']);
// Token synonyms expanded during normalization — applied identically to spoken
// queries, course titles, AND alias keys, so "QBO Essentials" meets
// "QuickBooks Online Essentials" on equal footing.
const TOKEN_SYNONYMS = { qbo: ['quickbooks', 'online'] };

export function normalizeCourseRef(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w))
    .flatMap((w) => TOKEN_SYNONYMS[w] || [w])
    .join(' ')
    .trim();
}

function titleTokens(s) {
  return normalizeCourseRef(s).split(' ').filter(Boolean);
}

// courses = [{ id, slug, title }]. Returns the matched course object or null.
// Order: exact id → exact slug → alias (slug, or prefix with a UNIQUE match) →
// exact normalized title → subset match (EVERY query token appears in the
// title, and exactly ONE course qualifies — ambiguity/partial overlap resolves
// to null rather than guessing, so a denied course is never silently remapped
// to an allowed sibling).
export function resolveCourseRef(spoken, courses) {
  const list = Array.isArray(courses) ? courses.filter(Boolean) : [];
  if (!list.length) return null;
  const raw = String(spoken == null ? '' : spoken).trim();
  if (!raw) return null;

  if (UUID_RE.test(raw)) {
    const byId = list.find((c) => String(c.id).toLowerCase() === raw.toLowerCase());
    if (byId) return byId;
  }
  const lower = raw.toLowerCase();
  const bySlug = list.find((c) => String(c.slug || '').toLowerCase() === lower);
  if (bySlug) return bySlug;

  const norm = normalizeCourseRef(raw);
  if (!norm) return null;

  // Alias keys are matched under the same normalization rules as the query.
  const aliasKey = Object.keys(TRAINER_COURSE_ALIASES).find((k) => normalizeCourseRef(k) === norm);
  const alias = aliasKey ? TRAINER_COURSE_ALIASES[aliasKey] : null;
  if (alias) {
    if (alias.slug) {
      const hit = list.find((c) => String(c.slug || '').toLowerCase() === alias.slug);
      if (hit) return hit;
    }
    if (alias.prefix) {
      const hits = list.filter((c) => String(c.slug || '').toLowerCase().startsWith(alias.prefix));
      if (hits.length === 1) return hits[0];
    }
  }

  const byTitle = list.find((c) => normalizeCourseRef(c.title) === norm);
  if (byTitle) return byTitle;

  const qTokens = norm.split(' ').filter(Boolean);
  if (!qTokens.length) return null;
  const candidates = list.filter((c) => {
    const t = new Set(titleTokens(c.title));
    return qTokens.every((q) => t.has(q));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// ── Access classification ────────────────────────────────────────────────────
// authorized    = courses this user MAY study (server-computed, trainer_visible_courses)
// allPublished  = ALL published + trainer-enabled courses (used only to tell
//                 "denied by plan" apart from "doesn't exist"; never leaked)
// readyCourseIds = authorized courses that have ≥1 ready source (optional)
export function classifyCourseAccess({ ref, authorized, allPublished, readyCourseIds }) {
  const inPlan = resolveCourseRef(ref, authorized);
  if (inPlan) {
    if (Array.isArray(readyCourseIds) && !readyCourseIds.includes(inPlan.id)) {
      return { status: 'not_ready', course: inPlan };
    }
    return { status: 'allowed', course: inPlan };
  }
  const exists = resolveCourseRef(ref, allPublished);
  if (exists) return { status: 'denied', course: exists };
  return { status: 'not_found', course: null };
}

// Pure mirror of the SQL plan-scope truth table (courses_read §14 /
// trainer_visible_courses #27). Sampler is the only scoped plan; every other plan
// reads the whole published catalog. null/unknown plan = full access HERE because
// this mirrors the SQL exactly — the real guard against a retired key is
// subscriptions.plan_key's FK to enrollment_plans (ON DELETE RESTRICT), which makes
// a deleted plan unreachable, plus ENROLLMENT_PLAN_KEYS on the admin preview path.
export function planScopeAllows(planKey, { slug, access_tier } = {}) {
  const s = String(slug || '');
  if (planKey === 'sampler') return s.startsWith('qbo-') && (access_tier || 'standard') === 'essentials';
  return true;
}

// ── Learner-facing safe messages ─────────────────────────────────────────────
function titlesPhrase(titles) {
  const list = (titles || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// Names the learner's plan + THEIR courses only. Never names the denied
// course's lessons/modules or any protected material.
export function DENIAL_MESSAGE(planLabel, allowedTitles) {
  const plan = planLabel ? `Your ${planLabel} membership` : 'Your current membership';
  const alternatives = titlesPhrase(allowedTitles);
  const cont = alternatives
    ? ` I can continue with ${alternatives}, or open your upgrade options so you can review the available plans.`
    : ' I can open your upgrade options so you can review the available plans.';
  return `${plan} doesn't include that course.${cont}`;
}

export function NOT_READY_MESSAGE(courseTitle) {
  return `${courseTitle || 'That course'} isn't ready for AI training yet — its material hasn't been indexed. I can open the course so you can study it directly.`;
}

export function NOT_FOUND_MESSAGE(allowedTitles) {
  const alternatives = titlesPhrase(allowedTitles);
  return alternatives
    ? `I couldn't find a course by that name. Right now you can study: ${alternatives}.`
    : `I couldn't find a course by that name, and no courses are AI-trainer-ready on your plan yet.`;
}

// ── Citations + response envelope ────────────────────────────────────────────
export function buildSourceLabel({ courseTitle, moduleTitle, lessonTitle } = {}) {
  return [courseTitle, moduleTitle, lessonTitle].map((s) => String(s || '').trim()).filter(Boolean).join(' › ');
}

function clampStr(s, max) {
  const v = String(s == null ? '' : s);
  return v.length > max ? `${v.slice(0, Math.max(0, max - 1))}…` : v;
}

// THE one response-contract builder for every trainer-tool reply. Whitelists
// fields, clamps sizes (≤6 chunks × ≤1200 chars, ≤6500 total), strips anything
// unexpected — the model only ever sees a bounded, well-shaped envelope.
export function buildTrainerEnvelope({ status, code, message, courses, chunks, citations, checkpoint, retrieval, next_actions } = {}) {
  const env = {
    status: ['ok', 'denied', 'error'].includes(status) ? status : 'error',
    code: clampStr(code || 'unknown', 60),
    message: clampStr(message || '', 600),
  };
  if (Array.isArray(courses)) {
    env.courses = courses.slice(0, 12).map((c) => ({
      id: String(c.id || ''),
      slug: clampStr(c.slug, 80),
      title: clampStr(c.title, 160),
      ready: c.ready === true,
    }));
  }
  if (Array.isArray(chunks)) {
    const out = [];
    let total = 0;
    for (const ch of chunks.slice(0, TRAINER_MAX_CHUNKS)) {
      const content = clampStr(ch.content, TRAINER_CHUNK_MAX_CHARS);
      if (total + content.length > TRAINER_MAX_TOTAL_CHARS) break;
      total += content.length;
      out.push({
        content,
        course_id: String(ch.course_id || ''),
        lesson_id: ch.lesson_id ? String(ch.lesson_id) : null,
        label: clampStr(ch.label, 220),
      });
    }
    env.chunks = out;
  }
  if (Array.isArray(citations)) {
    env.citations = citations.slice(0, TRAINER_MAX_CITATIONS).map((c) => ({
      course_id: String(c.course_id || ''),
      course_slug: clampStr(c.course_slug, 80),
      lesson_id: c.lesson_id ? String(c.lesson_id) : null,
      label: clampStr(c.label, 220),
    }));
  }
  if (checkpoint && typeof checkpoint === 'object') {
    env.checkpoint = {
      course_id: String(checkpoint.course_id || ''),
      course_title: clampStr(checkpoint.course_title, 160),
      lesson_id: checkpoint.lesson_id ? String(checkpoint.lesson_id) : null,
      lesson_title: clampStr(checkpoint.lesson_title, 160),
      topic: clampStr(checkpoint.topic, 200),
      mode: TRAINER_MODES.includes(checkpoint.mode) ? checkpoint.mode : null,
      understanding: clampStr(checkpoint.understanding, 400),
      next_step: clampStr(checkpoint.next_step, 400),
      updated_at: clampStr(checkpoint.updated_at, 40),
    };
  }
  if (retrieval && typeof retrieval === 'object') {
    env.retrieval = {
      mode: retrieval.mode === 'vector' ? 'vector' : 'keyword',
      confidence: retrieval.confidence === 'high' ? 'high' : 'low',
    };
  }
  if (Array.isArray(next_actions)) {
    env.next_actions = next_actions.slice(0, 8).map((a) => clampStr(a, 60));
  }
  return env;
}

// Mirrors the SQL CHECK bounds on ai_training_checkpoints.
export function clampCheckpoint({ topic, mode, understanding, next_step } = {}) {
  return {
    topic: clampStr(topic, 200),
    mode: TRAINER_MODES.includes(mode) ? mode : null,
    understanding: clampStr(understanding, 400),
    next_step: clampStr(next_step, 400),
  };
}
