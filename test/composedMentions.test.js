// Sylo posts composed messages with its own right to mention roles, so roles in the text are silent
// unless the person who asked has that right: the Reminders "Test" send follows the server's reminder
// ping choice (owner or Manage Server only), and Message Creator pings roles only for the owner or a
// live Manage Server holder, never for a bot master.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { listScheduled, deleteScheduled } = await import('../src/db/scheduledMessages.js');
const { buildPayload } = await import('../src/modules/messageCreator.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const MASTER = '700000000000000901';
const CHANNEL = '100000000000000901';
const TEXT = 'hello <@&700000000000000999> and @everyone';

const sent = [];
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

test.beforeEach(async () => {
  sent.length = 0;
  await setBotMasterRoles(D_GUILD, [MASTER]);
  for (const r of await listScheduled(D_GUILD)) await deleteScheduled(D_GUILD, r.id);
  await setGuildModule(D_GUILD, 'reminders', { enabled: true, config: { allowPings: false } });
  guild.channels.cache.set(CHANNEL, {
    id: CHANNEL,
    name: 'general',
    guild,
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: '100000000000000950' };
    },
  });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.channels.cache.clear();
});

test('a composed payload mentions roles only when the caller says so', () => {
  const { payload } = buildPayload({ content: TEXT });
  assert.deepEqual(payload.allowedMentions, { parse: ['users'] });
  assert.deepEqual(
    buildPayload({ content: TEXT }, { allowedMentions: { parse: [] } }).payload.allowedMentions,
    {
      parse: [],
    }
  );
});

test('the reminder Test send is silent while the server has not allowed reminder pings', async () => {
  const post = await person([]);
  const res = await post('/modules/reminders/test', { channelId: CHANNEL, content: TEXT });
  assert.equal(res.status, 200);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('the reminder Test send pings when the server has allowed it', async () => {
  await setGuildModule(D_GUILD, 'reminders', { config: { allowPings: true } });
  const post = await person([]);
  assert.equal((await post('/modules/reminders/test', { channelId: CHANNEL, content: TEXT })).status, 200);
  assert.deepEqual(sent[0].allowedMentions, { parse: ['roles', 'everyone'] });
});

const publish = (post) =>
  post('/messages/new', { spec: { content: TEXT }, name: 'x', channelId: CHANNEL, action: 'publish' });

test('Message Creator does not let a bot master ping roles', async () => {
  const post = await person([]);
  const res = await publish(post);
  assert.equal(res.status, 200);
  assert.deepEqual(sent[0].allowedMentions, { parse: ['users'] });
});

test('Message Creator pings roles for someone with Manage Server', async () => {
  const post = await person(['ManageGuild']);
  assert.equal((await publish(post)).status, 200);
  assert.deepEqual(sent[0].allowedMentions, { parse: ['users', 'roles'] });
});
