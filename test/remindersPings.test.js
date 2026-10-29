// A reminder is posted with Sylo's own rights, so mentions in its text must not ping unless the
// server owner or someone with Manage Server turned that on. A bot master may not turn it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');
const { getGuildModule } = await import('../src/db/modules.js');
const { reminderPayload, remindersMayPing } = await import('../src/modules/scheduledMessages.js');
const { createReminder, listScheduled, deleteScheduled } = await import('../src/db/scheduledMessages.js');
const { setGuildModule } = await import('../src/db/modules.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const BOT_MASTER = '700000000000000501';

function fakeMember(id, { perms = [], roles = [] } = {}) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  return { id, permissions: { has: (p) => perms.includes(p) }, roles: { highest: { position: 5 }, cache } };
}

async function signedIn({ manager = false } = {}) {
  setProfiles();
  if (!manager) profiles.discord.guilds[0] = { id: D_GUILD, owner: false, permissions: '0' };
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  guild.members.cache.set(
    id,
    manager ? fakeMember(id, { perms: ['ManageGuild'] }) : fakeMember(id, { roles: [BOT_MASTER] })
  );
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (allowPings) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/reminders/settings`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ allowPings }),
    });
}

async function signedInManager() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return {
    get: (path) => b.get(path),
    post: (path, body) =>
      b.get(`/api/v2/guilds/${D_GUILD}/modules/reminders${path}`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

test.beforeEach(async () => {
  await setBotMasterRoles(D_GUILD, [BOT_MASTER]);
});
test.afterEach(() => {
  guild.members.cache.clear();
});

test('a reminder pings nobody by default, even with @everyone and a role in the text', () => {
  const r = { spec: { content: '@everyone @here <@&700000000000000999> hi', embeds: [] } };
  assert.deepEqual(reminderPayload(r).allowedMentions, { parse: [] });
  assert.deepEqual(reminderPayload(r, remindersMayPing({}, 0)).allowedMentions, { parse: [] });
  assert.deepEqual(reminderPayload(r, remindersMayPing({ allowPings: 'yes' }, 0)).allowedMentions, {
    parse: [],
  });
});

test('with pings switched on, roles and everyone are allowed again', () => {
  const r = { spec: { content: '@everyone', embeds: [] } };
  assert.deepEqual(reminderPayload(r, remindersMayPing({ allowPings: true })).allowedMentions, {
    parse: ['roles', 'everyone'],
  });
});

test('a bot master cannot switch pings on', async () => {
  const post = await signedIn();
  const res = await post(true);
  assert.equal(res.status, 403);
  assert.equal(remindersMayPing((await getGuildModule(D_GUILD, 'reminders')).config), false);
});

test('someone with Manage Server can switch pings on and off', async () => {
  const post = await signedIn({ manager: true });
  assert.equal((await post(true)).status, 200);
  assert.equal(remindersMayPing((await getGuildModule(D_GUILD, 'reminders')).config), true);
  assert.equal((await post(false)).status, 200);
  assert.equal(remindersMayPing((await getGuildModule(D_GUILD, 'reminders')).config), false);
});

const fresh = () => ({
  name: 'r',
  channelId: '100000000000000001',
  spec: { content: '@everyone hi', embeds: [] },
  mode: 'multiple',
  intervalMinutes: 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  startAt: null,
  endAt: null,
  runAt: null,
});

test('a config from before the setting keeps pinging when the server already has reminders', () => {
  assert.equal(remindersMayPing({}, 3), true);
  assert.equal(remindersMayPing(undefined, 1), true);
  assert.equal(remindersMayPing({ allowPings: false }, 3), false, 'a recorded choice always stands');
  assert.equal(remindersMayPing({}, 0), false, 'a server without reminders starts with pings off');
  assert.equal(remindersMayPing(undefined, 0), false);
  // What the scheduler does for a due reminder of such a server.
  const r = { spec: { content: '@everyone', embeds: [] } };
  assert.deepEqual(reminderPayload(r, remindersMayPing({}, 1)).allowedMentions, {
    parse: ['roles', 'everyone'],
  });
});

test('upgrade: a server with reminders and no recorded choice shows pings on; a new server shows them off', async () => {
  for (const r of await listScheduled(D_GUILD)) await deleteScheduled(D_GUILD, r.id);
  await setGuildModule(D_GUILD, 'reminders', { enabled: true, config: {} });
  const b = await signedInManager();
  // Brand new server: nothing recorded, no reminders.
  let list = await (await b.get(`/api/v2/guilds/${D_GUILD}/modules/reminders/list`)).json();
  assert.equal(list.allowPings, false);
  // A server from before the setting: reminders exist, no choice recorded.
  await createReminder(D_GUILD, fresh());
  list = await (await b.get(`/api/v2/guilds/${D_GUILD}/modules/reminders/list`)).json();
  assert.equal(list.allowPings, true);
  assert.equal(remindersMayPing((await getGuildModule(D_GUILD, 'reminders')).config, 1), true);
});

test('a server creating its first reminder is recorded as pings off', async () => {
  for (const r of await listScheduled(D_GUILD)) await deleteScheduled(D_GUILD, r.id);
  await setGuildModule(D_GUILD, 'reminders', { enabled: true, config: {} });
  const b = await signedInManager();
  const res = await b.post('/new', { name: 'First', channelId: '100000000000000001', content: 'hi' });
  assert.equal(res.status, 200);
  const { config } = await getGuildModule(D_GUILD, 'reminders');
  assert.equal(config.allowPings, false);
  const list = await (await b.get(`/api/v2/guilds/${D_GUILD}/modules/reminders/list`)).json();
  assert.equal(list.allowPings, false);
  // A second reminder does not change the recorded choice.
  assert.equal(
    (await b.post('/new', { name: 'Second', channelId: '100000000000000001', content: 'hi' })).status,
    200
  );
  assert.equal((await getGuildModule(D_GUILD, 'reminders')).config.allowPings, false);
});
