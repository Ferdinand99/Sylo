// The new dashboard's reminder calls must reach the reminder routes. POST /modules/<id> is the
// module on/off switch, so creating a reminder there switched the whole Reminders module off;
// and /reminders/test was caught by /reminders/:id, so a test send always said "No such reminder".
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { isModuleEnabled, setGuildModule } = await import('../src/db/modules.js');
const { listScheduled } = await import('../src/db/scheduledMessages.js');

async function admin() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/reminders${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

test('creating a reminder creates it and leaves the module on', async () => {
  await setGuildModule(D_GUILD, 'reminders', { enabled: true });
  const post = await admin();
  const res = await post('/new', { name: 'Daily', channelId: '100000000000000001', content: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(await isModuleEnabled(D_GUILD, 'reminders'), true);
  assert.equal((await listScheduled(D_GUILD)).length, 1);
});

test('a test send reaches the test route', async () => {
  const post = await admin();
  const res = await post('/test', { content: 'hi' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Pick a channel.');
});

test('past the per-server ceiling, creating a reminder is a 400 with the reason', async () => {
  const { LIMITS } = await import('../src/lib/limits.js');
  const post = await admin();
  for (let i = (await listScheduled(D_GUILD)).length; i < LIMITS.reminders; i++) {
    assert.equal(
      (await post('/new', { name: `r${i}`, channelId: '100000000000000001', content: 'hi' })).status,
      200
    );
  }
  const res = await post('/new', { name: 'one too many', channelId: '100000000000000001', content: 'hi' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /maximum of 50 reminders/);
});
