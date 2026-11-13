// The zone the API reports for reminder and channel cleanup schedules is the zone the scheduling
// code counts them in: both follow the process zone (TZ), so a change of TZ moves both together.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { serverTimeZone } from '../src/lib/serverTimeZone.js';
import { isDue } from '../src/modules/channelCleanup.js';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

test('serverTimeZone names the zone the TZ variable sets', () => {
  process.env.TZ = 'Europe/Oslo';
  assert.equal(serverTimeZone(), 'Europe/Oslo');
  process.env.TZ = 'America/New_York';
  assert.equal(serverTimeZone(), 'America/New_York');
  process.env.TZ = 'UTC';
  assert.equal(serverTimeZone(), 'UTC');
});

test('serverTimeZone is always an IANA-shaped name or null, never an offset', () => {
  process.env.TZ = 'Not/A_Zone';
  const zone = serverTimeZone();
  assert.ok(zone === null || /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone), String(zone));
  assert.notEqual(zone, 'Etc/Unknown');
});

test('the cleanup scheduler counts days and time of day in the zone serverTimeZone reports', () => {
  // 2026-11-13 23:30 UTC is Saturday 00:30 in Oslo (UTC+1) and still Friday 18:30 in New York (UTC-5).
  const instant = new Date('2026-11-13T23:30:00Z');
  const schedule = (day, time) => ({ dayList: [day], time_hhmm: time });

  process.env.TZ = 'Europe/Oslo';
  assert.equal(serverTimeZone(), 'Europe/Oslo');
  assert.equal(isDue(schedule(6, '00:25'), instant), true);
  assert.equal(isDue(schedule(5, '18:25'), instant), false);

  process.env.TZ = 'America/New_York';
  assert.equal(serverTimeZone(), 'America/New_York');
  assert.equal(isDue(schedule(5, '18:25'), instant), true);
  assert.equal(isDue(schedule(6, '00:25'), instant), false);
});
