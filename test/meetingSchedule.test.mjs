// test/meetingSchedule.test.mjs — meeting times, weekly recurrence and calendar grids (#62).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEETING_LIMITS, MEETING_WEEKDAYS, addDaysISO, buildZoomMeetingBody, buildZoomRecurrence,
  expandOccurrences, formatClock, groupByManilaDate, isISODate, manilaToUtcIso, manilaToday,
  mergeCalendarItems, monthGrid, nextWeekdayOnOrAfter, utcToManila, validateMeetingForm, weekDates, weekdayOfISO,
} from '../src/lib/meetingSchedule.js';

const MWF = [1, 3, 5];

test('Manila is UTC+8 in both directions, across a date boundary', () => {
  assert.equal(manilaToUtcIso('2026-10-05', '09:00'), '2026-10-05T01:00:00Z');
  assert.equal(manilaToUtcIso('2026-10-05', '07:30'), '2026-10-04T23:30:00Z');
  assert.deepEqual(utcToManila('2026-10-04T23:30:00Z'), { date: '2026-10-05', time: '07:30', weekday: 1 });
  assert.equal(manilaToday(Date.parse('2026-10-04T16:30:00Z')), '2026-10-05', 'half past midnight in Manila is already tomorrow');
});

test('a series end date is the END of that day in Manila — the legacy UTC-midnight defect', () => {
  const r = buildZoomRecurrence({ recurrence: 'weekly', days: MWF, endMode: 'date', endDate: '2026-10-30' });
  assert.equal(r.end_date_time, '2026-10-30T15:59:00Z');
  assert.notEqual(r.end_date_time, '2026-10-30T00:00:00Z');
});

test('Zoom weekly_days counts from Sunday = 1', () => {
  assert.equal(buildZoomRecurrence({ recurrence: 'weekly', days: [5, 1, 3, 3], count: 12 }).weekly_days, '2,4,6');
  assert.equal(MEETING_WEEKDAYS[0].zoom, 1);
  assert.equal(MEETING_WEEKDAYS[6].zoom, 7);
});

test('twelve MWF sessions from a Monday span four weeks', () => {
  const s = expandOccurrences({ date: '2026-10-05', time: '09:00', recurrence: 'weekly', days: MWF, endMode: 'count', count: 12 });
  assert.equal(s.length, 12);
  assert.equal(s[0].date, '2026-10-05');
  assert.equal(s[11].date, '2026-10-30');
  assert.ok(s.every((x) => MWF.includes(weekdayOfISO(x.date))));
  assert.equal(s[0].startUtc, '2026-10-05T01:00:00Z');
});

test('a series starting on an unselected day begins on the next selected one', () => {
  const s = expandOccurrences({ date: '2026-10-06', time: '09:00', recurrence: 'weekly', days: MWF, endMode: 'count', count: 2 });
  assert.deepEqual(s.map((x) => x.date), ['2026-10-07', '2026-10-09']);
  assert.equal(nextWeekdayOnOrAfter('2026-10-06', MWF), '2026-10-07');
});

test('an end date is inclusive', () => {
  const s = expandOccurrences({ date: '2026-10-05', time: '18:00', recurrence: 'weekly', days: [5], endMode: 'date', endDate: '2026-10-16' });
  assert.deepEqual(s.map((x) => x.date), ['2026-10-09', '2026-10-16']);
});

test('a one-time meeting is one session and has no recurrence', () => {
  const f = { topic: 'Orientation', date: '2026-10-05', time: '14:00', duration: 90, recurrence: 'none' };
  assert.equal(expandOccurrences(f).length, 1);
  const body = buildZoomMeetingBody(f);
  assert.equal(body.type, 2);
  assert.equal(body.recurrence, undefined);
  assert.equal(body.start_time, '2026-10-05T06:00:00Z');
  assert.equal(body.timezone, 'Asia/Manila');
  assert.equal(buildZoomMeetingBody({ ...f, recurrence: 'weekly', days: [2], count: 4 }).type, 8);
});

test('validation names each problem, and never reads the clock itself', () => {
  const bad = validateMeetingForm({ topic: ' ', date: '2026-02-31', time: '25:00', duration: 5, recurrence: 'weekly', days: [], count: 0 });
  assert.equal(bad.ok, false);
  for (const k of ['topic', 'date', 'time', 'duration', 'days', 'count']) assert.ok(bad.errors[k], `${k} should be flagged`);

  const past = validateMeetingForm({ topic: 'x', date: '2026-10-01', time: '09:00', duration: 60 }, { todayISO: '2026-10-02' });
  assert.ok(past.errors.date);

  const good = validateMeetingForm({ topic: 'QBO live', date: '2026-10-05', time: '09:00', duration: 120, recurrence: 'weekly', days: MWF, endMode: 'count', count: 12 }, { todayISO: '2026-10-01' });
  assert.deepEqual(good, { ok: true, errors: {} });
});

test('a series longer than Zoom allows, or with no session in range, is refused', () => {
  const tooMany = validateMeetingForm({ topic: 'x', date: '2026-01-05', time: '09:00', duration: 60, recurrence: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], endMode: 'date', endDate: '2026-12-31' });
  assert.ok(tooMany.errors.endDate);
  const none = validateMeetingForm({ topic: 'x', date: '2026-10-05', time: '09:00', duration: 60, recurrence: 'weekly', days: [6], endMode: 'date', endDate: '2026-10-09' });
  assert.ok(none.errors.days);
  assert.equal(validateMeetingForm({ topic: 'x', date: '2026-10-05', time: '09:00', duration: 60, recurrence: 'weekly', days: [1], endMode: 'count', count: MEETING_LIMITS.occurrencesMax + 1 }).errors.count !== undefined, true);
});

test('calendar helpers', () => {
  assert.equal(isISODate('2026-02-29'), false);
  assert.equal(isISODate('2028-02-29'), true);
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(weekDates('2026-10-07'), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
  const grid = monthGrid(2026, 10);
  assert.equal(grid.length, 42);
  assert.equal(weekdayOfISO(grid[0].date), 0, 'the grid starts on a Sunday');
  assert.equal(grid.filter((c) => c.inMonth).length, 31);
  assert.equal(formatClock('00:05'), '12:05 AM');
  assert.equal(formatClock('13:30'), '1:30 PM');
});

test('the calendar shows a logged meeting once, and a Zoom-only meeting from Zoom', () => {
  const items = mergeCalendarItems(
    [{ id: 'm1', zoom_meeting_id: '11111111', topic: 'Logged', starts_at: '2026-10-05T01:00:00Z', duration_min: 60,
       sessions: ['2026-10-05T01:00:00Z', '2026-10-07T01:00:00Z'], join_url: 'https://zoom.example/j/1', status: 'scheduled' },
     { id: 'm2', zoom_meeting_id: '33333333', topic: 'Cancelled', starts_at: '2026-10-06T01:00:00Z', duration_min: 30, sessions: [], status: 'cancelled' }],
    [{ zoom_meeting_id: '11111111', topic: 'Logged', start_time: '2026-10-05T01:00:00Z', duration: 60 },
     { zoom_meeting_id: '22222222', topic: 'Zoom only', start_time: '2026-10-04T08:00:00Z', duration: 45,
       occurrences: [{ start_time: '2026-10-04T08:00:00Z', duration: 45, status: 'available' }, { start_time: '2026-10-11T08:00:00Z', duration: 45, status: 'deleted' }] }],
  );
  assert.deepEqual(items.map((i) => `${i.source}:${i.topic}`), ['zoom:Zoom only', 'log:Logged', 'log:Cancelled', 'log:Logged']);
  assert.equal(items.filter((i) => i.zoomMeetingId === '11111111').length, 2, 'a logged series is not doubled by Zoom');
  assert.equal(items.find((i) => i.topic === 'Cancelled').cancelled, true);
  assert.ok(!items.some((i) => i.startUtc.startsWith('2026-10-11')), 'a deleted occurrence is dropped');
});

test('grouping by Manila date sorts each day and follows the timezone', () => {
  const map = groupByManilaDate([
    { id: 'b', startUtc: '2026-10-05T08:00:00Z' },
    { id: 'a', startUtc: '2026-10-05T01:00:00Z' },
    { id: 'c', startUtc: '2026-10-04T17:00:00Z' },   // 01:00 on the 5th in Manila
  ]);
  assert.deepEqual(map.get('2026-10-05').map((x) => x.id), ['c', 'a', 'b']);
  assert.equal(map.has('2026-10-04'), false);
});
