// src/lib/meetingSchedule.js — meeting times, weekly recurrence and calendar grids (#62).
//
// Pure: no imports, no DOM, no locale-dependent Date formatting. The Meetings tab uses it
// to validate a form, preview the sessions a recurrence produces and draw the calendar;
// api/admin/meetings.js uses the SAME functions to build the Zoom request, so the
// sessions the Super Admin previewed are the sessions Zoom creates.
//
// ★ THE BUSINESS TIMEZONE IS A FIXED +08:00. The Philippines has observed no daylight
//   saving time since 1978, so Asia/Manila is exactly UTC+8 all year and a fixed offset is
//   exact, not an approximation. If the business timezone ever changes, this constant is
//   the one place to change — and a DST zone would need a real tz library instead.
//
// ★ A RECURRENCE END DATE IS THE END OF THAT DAY IN MANILA. The legacy Apps Script sent
//   the chosen date to Zoom as midnight UTC, i.e. 08:00 Manila on that day, so a series
//   meant to include an evening session on its last date silently dropped it.

export const BUSINESS_TZ = 'Asia/Manila';
export const BUSINESS_UTC_OFFSET_MINUTES = 8 * 60;

export const MEETING_LIMITS = Object.freeze({
  topicMax: 200,
  durationMin: 15,
  durationMax: 480,
  occurrencesMax: 50,     // Zoom's own ceiling for a recurring meeting
  horizonDays: 366,
});

/** Sunday-first, matching Date#getUTCDay(). `zoom` is Zoom's weekly_days value (1 = Sunday). */
export const MEETING_WEEKDAYS = Object.freeze([
  { day: 0, zoom: 1, short: 'Sun', label: 'Sunday' },
  { day: 1, zoom: 2, short: 'Mon', label: 'Monday' },
  { day: 2, zoom: 3, short: 'Tue', label: 'Tuesday' },
  { day: 3, zoom: 4, short: 'Wed', label: 'Wednesday' },
  { day: 4, zoom: 5, short: 'Thu', label: 'Thursday' },
  { day: 5, zoom: 6, short: 'Fri', label: 'Friday' },
  { day: 6, zoom: 7, short: 'Sat', label: 'Saturday' },
]);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n) => String(n).padStart(2, '0');

/** A real calendar date? Rejects 2026-02-31, which Date would roll into March. */
export function isISODate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export const isHHMM = (s) => TIME_RE.test(String(s || ''));

/** Date-only arithmetic, done in UTC so no local timezone can shift it. */
export function addDaysISO(date, n) {
  const m = DATE_RE.exec(date);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export function weekdayOfISO(date) {
  const m = DATE_RE.exec(date);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

export function daysBetweenISO(a, b) {
  const pa = DATE_RE.exec(a); const pb = DATE_RE.exec(b);
  return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
}

/** A Manila wall-clock date + time → the UTC instant, as `YYYY-MM-DDTHH:MM:SSZ`. */
export function manilaToUtcIso(date, time) {
  const m = DATE_RE.exec(date); const t = TIME_RE.exec(time);
  if (!m || !t) throw new Error('manilaToUtcIso: expected YYYY-MM-DD and HH:MM');
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]) - BUSINESS_UTC_OFFSET_MINUTES * 60000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A UTC instant → its Manila wall-clock parts. */
export function utcToManila(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + BUSINESS_UTC_OFFSET_MINUTES * 60000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    weekday: d.getUTCDay(),
  };
}

/** Today's date in Manila, for a given instant (default now). */
export const manilaToday = (nowMs = Date.now()) => utcToManila(new Date(nowMs).toISOString()).date;

/** '09:00' → '9:00 AM'. */
export function formatClock(time) {
  const t = TIME_RE.exec(String(time || ''));
  if (!t) return '';
  const h = +t[1];
  return `${((h + 11) % 12) + 1}:${t[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The first date on or after `date` whose weekday is in `days` (0–6). */
export function nextWeekdayOnOrAfter(date, days) {
  const set = new Set(days);
  if (!set.size) return null;
  for (let i = 0; i < 7; i += 1) {
    const d = addDaysISO(date, i);
    if (set.has(weekdayOfISO(d))) return d;
  }
  return null;
}

const normalizeDays = (days) => [...new Set((days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);

/**
 * Validate the create-meeting form. Returns `{ ok, errors }` where `errors` maps a field
 * to one sentence. `todayISO` is a parameter so the result never depends on the clock.
 *
 * form: { topic, date, time, duration, recurrence: 'none'|'weekly', days: number[],
 *         endMode: 'count'|'date', count, endDate }
 */
export function validateMeetingForm(form, { todayISO } = {}) {
  const f = form || {};
  const errors = {};
  const topic = String(f.topic || '').trim();
  if (!topic) errors.topic = 'Give the meeting a topic.';
  else if (topic.length > MEETING_LIMITS.topicMax) errors.topic = `Keep the topic under ${MEETING_LIMITS.topicMax} characters.`;

  if (!isISODate(f.date)) errors.date = 'Choose a start date.';
  else if (todayISO && f.date < todayISO) errors.date = 'The start date is in the past.';
  if (!isHHMM(f.time)) errors.time = 'Choose a start time.';

  const duration = Number(f.duration);
  if (!Number.isInteger(duration) || duration < MEETING_LIMITS.durationMin || duration > MEETING_LIMITS.durationMax) {
    errors.duration = `Duration must be ${MEETING_LIMITS.durationMin}–${MEETING_LIMITS.durationMax} minutes.`;
  }

  if (f.recurrence === 'weekly') {
    const days = normalizeDays(f.days);
    if (!days.length) errors.days = 'Pick at least one day of the week.';
    if (f.endMode === 'date') {
      if (!isISODate(f.endDate)) errors.endDate = 'Choose the date the series ends.';
      else if (isISODate(f.date) && f.endDate < f.date) errors.endDate = 'The series cannot end before it starts.';
      else if (isISODate(f.date) && daysBetweenISO(f.date, f.endDate) > MEETING_LIMITS.horizonDays) errors.endDate = 'A series can run for at most a year.';
    } else {
      const count = Number(f.count);
      if (!Number.isInteger(count) || count < 1 || count > MEETING_LIMITS.occurrencesMax) {
        errors.count = `A series has 1–${MEETING_LIMITS.occurrencesMax} sessions.`;
      }
    }
    if (!Object.keys(errors).length) {
      const n = expandOccurrences(f, { limit: MEETING_LIMITS.occurrencesMax + 1 }).length;
      if (n === 0) errors.days = 'No session falls between the start and end dates on those days.';
      else if (n > MEETING_LIMITS.occurrencesMax) errors.endDate = `That produces more than ${MEETING_LIMITS.occurrencesMax} sessions — Zoom's limit. End the series sooner.`;
    }
  } else if (f.recurrence && f.recurrence !== 'none') {
    errors.recurrence = 'Choose one-time or weekly.';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Every session the form produces, in order: `{ date, time, startUtc }` (Manila date/time).
 * A one-time meeting is one session. A weekly series starts on the first selected weekday
 * on or after the start date — which is what Zoom does when the start day is not selected.
 */
export function expandOccurrences(form, { limit = MEETING_LIMITS.occurrencesMax } = {}) {
  const f = form || {};
  if (!isISODate(f.date) || !isHHMM(f.time)) return [];
  if (f.recurrence !== 'weekly') return [{ date: f.date, time: f.time, startUtc: manilaToUtcIso(f.date, f.time) }];
  const days = new Set(normalizeDays(f.days));
  if (!days.size) return [];
  const byDate = f.endMode === 'date';
  if (byDate && !isISODate(f.endDate)) return [];
  const count = byDate ? Infinity : Math.max(0, Math.min(Number(f.count) || 0, limit));
  const out = [];
  for (let i = 0; i <= MEETING_LIMITS.horizonDays && out.length < Math.min(count, limit); i += 1) {
    const d = addDaysISO(f.date, i);
    if (byDate && d > f.endDate) break;
    if (days.has(weekdayOfISO(d))) out.push({ date: d, time: f.time, startUtc: manilaToUtcIso(d, f.time) });
  }
  return out;
}

/**
 * Zoom's `recurrence` object for a weekly form (type 2), or null for a one-time meeting.
 * ★ end_date_time is 23:59 on the END DATE IN MANILA, expressed in UTC.
 */
export function buildZoomRecurrence(form) {
  const f = form || {};
  if (f.recurrence !== 'weekly') return null;
  const days = normalizeDays(f.days);
  const base = {
    type: 2,
    repeat_interval: 1,
    weekly_days: days.map((d) => MEETING_WEEKDAYS[d].zoom).join(','),
  };
  if (f.endMode === 'date') return { ...base, end_date_time: manilaToUtcIso(f.endDate, '23:59') };
  return { ...base, end_times: Math.max(1, Math.min(Number(f.count) || 1, MEETING_LIMITS.occurrencesMax)) };
}

/** The Zoom create-meeting body the form describes (settings added by the caller). */
export function buildZoomMeetingBody(form) {
  const f = form || {};
  const recurrence = buildZoomRecurrence(f);
  return {
    topic: String(f.topic || '').trim().slice(0, MEETING_LIMITS.topicMax),
    type: recurrence ? 8 : 2,               // 8 = recurring with a fixed time, 2 = scheduled
    start_time: manilaToUtcIso(f.date, f.time),
    duration: Number(f.duration),
    timezone: BUSINESS_TZ,
    ...(recurrence ? { recurrence } : {}),
  };
}

/** The seven Manila dates (Sunday first) of the week containing `date`. */
export function weekDates(date) {
  const start = addDaysISO(date, -weekdayOfISO(date));
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
}

/** A 6 × 7 month grid (Sunday first): `[{ date, inMonth }]`, always 42 cells. */
export function monthGrid(year, month) {
  const first = `${year}-${pad(month)}-01`;
  const start = addDaysISO(first, -weekdayOfISO(first));
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDaysISO(start, i);
    return { date, inMonth: date.slice(0, 7) === first.slice(0, 7) };
  });
}

/**
 * One calendar list from the app's meeting log and Zoom's upcoming list.
 * ★ A meeting created directly in Zoom (or whose log write failed) still appears, from
 *   Zoom; a logged meeting is shown once, from the log, even though Zoom lists it too.
 * A cancelled log row is kept but flagged, so "we cancelled it" stays visible.
 *
 * logRows:  meetings_list() rows `{ id, zoom_meeting_id, topic, starts_at, duration_min, sessions, join_url, status }`
 * zoomRows: api `upcoming` rows  `{ zoom_meeting_id, topic, start_time, duration, join_url, occurrences? }`
 */
export function mergeCalendarItems(logRows, zoomRows) {
  const items = [];
  const logged = new Set();
  const iso = (v) => { const ms = Date.parse(v); return Number.isNaN(ms) ? null : new Date(ms).toISOString(); };
  for (const m of logRows || []) {
    if (m.zoom_meeting_id) logged.add(String(m.zoom_meeting_id));
    const starts = Array.isArray(m.sessions) && m.sessions.length ? m.sessions : [m.starts_at];
    starts.forEach((s, i) => {
      const startUtc = iso(s);
      if (startUtc) items.push({ key: `log:${m.id}:${i}`, startUtc, topic: m.topic, duration: m.duration_min, joinUrl: m.join_url || null, source: 'log', meetingId: m.id, zoomMeetingId: m.zoom_meeting_id, cancelled: m.status === 'cancelled' });
    });
  }
  for (const z of zoomRows || []) {
    const zid = String(z.zoom_meeting_id || '');
    if (!zid || logged.has(zid)) continue;
    const occ = Array.isArray(z.occurrences) && z.occurrences.length
      ? z.occurrences.filter((o) => o.status !== 'deleted')
      : [{ start_time: z.start_time, duration: z.duration }];
    occ.forEach((o, i) => {
      const startUtc = iso(o.start_time);
      if (startUtc) items.push({ key: `zoom:${zid}:${i}`, startUtc, topic: z.topic, duration: o.duration || z.duration, joinUrl: z.join_url || null, source: 'zoom', meetingId: null, zoomMeetingId: zid, cancelled: false });
    });
  }
  return items.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
}

/** Group session-like items (`{ startUtc }`) by Manila date, each day sorted by time. */
export function groupByManilaDate(items) {
  const map = new Map();
  for (const it of items || []) {
    const parts = utcToManila(it.startUtc);
    if (!parts) continue;
    if (!map.has(parts.date)) map.set(parts.date, []);
    map.get(parts.date).push({ ...it, date: parts.date, time: parts.time });
  }
  for (const list of map.values()) list.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
  return map;
}
