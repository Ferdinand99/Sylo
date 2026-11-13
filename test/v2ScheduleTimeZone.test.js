// The reminders list and the channel cleanup list say which zone the server counts their weekdays and
// times in, so the iOS app can convert them to the phone's clock. Only the process zone exists for
// these two modules; there is no per-server zone setting to report instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

async function getJson(path) {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const res = await b.get(`/api/v2/guilds/${D_GUILD}${path}`);
  assert.equal(res.status, 200);
  return res.json();
}

test('the reminders list names the process zone', async () => {
  const body = await getJson('/modules/reminders/list');
  const expected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(body.timeZone, expected);
  assert.ok(Array.isArray(body.reminders));
});

test('the channel cleanup list names the process zone', async () => {
  const body = await getJson('/modules/channel-cleanup/schedules');
  const expected = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(body.timeZone, expected);
  assert.ok(Array.isArray(body.schedules));
});

test('both lists follow a change of the process zone', async () => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    assert.equal((await getJson('/modules/reminders/list')).timeZone, 'Asia/Tokyo');
    assert.equal((await getJson('/modules/channel-cleanup/schedules')).timeZone, 'Asia/Tokyo');
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
