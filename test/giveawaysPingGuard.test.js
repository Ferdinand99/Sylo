// "Who to ping when winners are announced" makes Sylo ping the whole server with its own right, so
// raising it to @here or @everyone takes the server owner or a live Manage Server holder, as the
// reminders ping setting does: a bot master may keep or lower it, not raise it.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const MASTER = '700000000000000801';

async function person(perms) {
  setProfiles();
  profiles.discord.guilds = [{ id: D_GUILD, owner: false, permissions: '0' }];
  const b = browser();
  await signIn(b, 'discord');
  const id = profiles.discord.id;
  const cache = new Map([[MASTER, { id: MASTER }]]);
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  cache.some = (fn) => [...cache.values()].some(fn);
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { highest: { position: 5 }, cache },
  });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

const pingOf = async () => (await getGuildModule(D_GUILD, 'giveaways')).config.ping;

test.beforeEach(async () => {
  await setBotMasterRoles(D_GUILD, [MASTER]);
  await setGuildModule(D_GUILD, 'giveaways', { enabled: true, config: { ping: 'none' } });
});
test.afterEach(() => guild.members.cache.clear());

test('a bot master cannot make giveaways ping @everyone or @here', async () => {
  const post = await person([]);
  for (const ping of ['everyone', 'here']) {
    const res = await post('/modules/giveaways/config', { ping });
    assert.equal(res.status, 403, ping);
    assert.match((await res.json()).error, /Manage Server/);
  }
  assert.equal(await pingOf(), 'none');
});

test('a bot master may keep or lower the setting', async () => {
  await setGuildModule(D_GUILD, 'giveaways', { config: { ping: 'everyone' } });
  const post = await person([]);
  assert.equal((await post('/modules/giveaways/config', { ping: 'everyone' })).status, 200, 'unchanged');
  assert.equal((await post('/modules/giveaways/config', { ping: 'here' })).status, 200, 'lowered');
  assert.equal((await post('/modules/giveaways/config', { ping: 'none' })).status, 200);
  assert.equal(await pingOf(), 'none');
});

test('someone with Manage Server may raise it', async () => {
  const post = await person(['ManageGuild']);
  assert.equal((await post('/modules/giveaways/config', { ping: 'everyone' })).status, 200);
  assert.equal(await pingOf(), 'everyone');
});

test('switching the module on with a raised ping is refused in plain words', async () => {
  await setGuildModule(D_GUILD, 'giveaways', { enabled: false, config: { ping: 'everyone' } });
  const post = await person([]);
  const res = await post('/modules/giveaways', { enabled: true });
  assert.equal(res.status, 403);
  const { error } = await res.json();
  assert.match(error, /Switching .* on is refused\. Only the server owner or someone with Manage Server can make giveaways ping/);
  assert.doesNotMatch(error, /pay for/);
});
