import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listCleanupSchedules,
  getCleanupSchedule,
  dueCandidates,
  createCleanupSchedule,
  updateCleanupSchedule,
  deleteCleanupSchedule,
  setCleanupScheduleEnabled,
  markCleanupRan,
} from '../src/db/channelCleanup.js';

const G = 'a00000000000000001';

test('createCleanupSchedule + hydrate: defaults days to every day, stores settings', () => {
  const id = Number(
    createCleanupSchedule(G, {
      channelId: '111111111111111111',
      days: [],
      timeHhmm: '03:00',
      maxAgeHours: 24,
      skipPinned: true,
    })
  );
  const s = getCleanupSchedule(G, id);
  assert.equal(s.channel_id, '111111111111111111');
  assert.equal(s.time_hhmm, '03:00');
  assert.equal(s.max_age_hours, 24);
  assert.equal(s.skip_pinned, 1);
  assert.equal(s.enabled, 1);
  assert.deepEqual(s.dayList, [0, 1, 2, 3, 4, 5, 6]);
});

test('createCleanupSchedule stores an explicit day list', () => {
  const id = Number(
    createCleanupSchedule(G, {
      channelId: '1'.repeat(18),
      days: [1, 3, 5],
      timeHhmm: '12:30',
      maxAgeHours: 168,
      skipPinned: false,
    })
  );
  const s = getCleanupSchedule(G, id);
  assert.deepEqual(s.dayList, [1, 3, 5]);
  assert.equal(s.skip_pinned, 0);
});

test('listCleanupSchedules scopes to guild and orders by creation', () => {
  const other = 'b00000000000000002';
  createCleanupSchedule(other, {
    channelId: '1'.repeat(18),
    days: [0],
    timeHhmm: '01:00',
    maxAgeHours: 1,
    skipPinned: true,
  });
  const before = listCleanupSchedules(G).length;
  createCleanupSchedule(G, {
    channelId: '1'.repeat(18),
    days: [0],
    timeHhmm: '02:00',
    maxAgeHours: 1,
    skipPinned: true,
  });
  assert.equal(listCleanupSchedules(G).length, before + 1);
  assert.equal(listCleanupSchedules(other).length, 1);
});

test('dueCandidates: only enabled schedules not yet run today', () => {
  const id = Number(
    createCleanupSchedule(G, {
      channelId: '1'.repeat(18),
      days: [0, 1, 2, 3, 4, 5, 6],
      timeHhmm: '00:00',
      maxAgeHours: 1,
      skipPinned: true,
    })
  );
  assert.ok(dueCandidates('2099-01-01').some((s) => s.id === id));

  markCleanupRan(id, '2099-01-01', 3);
  assert.ok(!dueCandidates('2099-01-01').some((s) => s.id === id));
  assert.ok(dueCandidates('2099-01-02').some((s) => s.id === id));

  setCleanupScheduleEnabled(G, id, false);
  assert.ok(!dueCandidates('2099-01-02').some((s) => s.id === id));
});

test('updateCleanupSchedule rewrites the row; deleteCleanupSchedule removes it', () => {
  const id = Number(
    createCleanupSchedule(G, {
      channelId: '1'.repeat(18),
      days: [0],
      timeHhmm: '05:00',
      maxAgeHours: 12,
      skipPinned: true,
    })
  );
  updateCleanupSchedule(G, id, {
    channelId: '2'.repeat(18),
    days: [6],
    timeHhmm: '06:15',
    maxAgeHours: 48,
    skipPinned: false,
  });
  const s = getCleanupSchedule(G, id);
  assert.equal(s.channel_id, '2'.repeat(18));
  assert.deepEqual(s.dayList, [6]);
  assert.equal(s.time_hhmm, '06:15');
  assert.equal(s.max_age_hours, 48);
  assert.equal(s.skip_pinned, 0);

  deleteCleanupSchedule(G, id);
  assert.equal(getCleanupSchedule(G, id), null);
});
