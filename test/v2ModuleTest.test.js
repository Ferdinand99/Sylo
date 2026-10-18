// The new dashboard's "Send test message": POST /api/v2/guilds/:id/modules/:moduleId/test posts a
// sample message to the module's saved channel and answers { ok, channelName?, reason? }.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');

const CHANNEL = '100000000000000777';

async function signedIn() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (guildId, moduleId) =>
    b.get(`/api/v2/guilds/${guildId}/modules/${moduleId}/test`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: '{}',
    });
}

test('someone who is not an admin of the server is refused', async () => {
  const post = await signedIn();
  assert.equal((await post(OTHER_D_GUILD, 'welcome')).status, 403);
});

test('a module without a test message is a 400', async () => {
  const post = await signedIn();
  const res = await post(D_GUILD, 'afk');
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('the reminders test route is left to its own handler', async () => {
  const post = await signedIn();
  const res = await post(D_GUILD, 'reminders');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Pick a channel.');
});

test('no saved channel answers reason no-channel', async () => {
  await setGuildModule(D_GUILD, 'welcome', { enabled: true, config: {} });
  const post = await signedIn();
  const res = await post(D_GUILD, 'welcome');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, reason: 'no-channel' });
});

test('a channel the bot cannot reach answers reason send-failed', async () => {
  await setGuildModule(D_GUILD, 'logging', { enabled: true, config: { channel: '100000000000000999' } });
  const post = await signedIn();
  const res = await post(D_GUILD, 'logging');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, reason: 'send-failed' });
});

test('a reachable channel gets the sample and answers its name', async () => {
  const sent = [];
  const channels = runtime.clients.discord.guilds.cache.get(D_GUILD).channels.cache;
  channels.set(CHANNEL, {
    id: CHANNEL,
    name: 'free-stuff',
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: '1' };
    },
  });
  try {
    await setGuildModule(D_GUILD, 'free-games', { enabled: true, config: { channelId: CHANNEL } });
    const post = await signedIn();
    const res = await post(D_GUILD, 'free-games');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, channelName: 'free-stuff' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds.length, 1);
  } finally {
    channels.delete(CHANNEL);
  }
});
