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

test.beforeEach(async () => {
  await setBotMasterRoles(D_GUILD, [BOT_MASTER]);
});
test.afterEach(() => {
  guild.members.cache.clear();
});

test('a reminder pings nobody by default, even with @everyone and a role in the text', () => {
  const r = { spec: { content: '@everyone @here <@&700000000000000999> hi', embeds: [] } };
  assert.deepEqual(reminderPayload(r).allowedMentions, { parse: [] });
  assert.deepEqual(reminderPayload(r, remindersMayPing({})).allowedMentions, { parse: [] });
  assert.deepEqual(reminderPayload(r, remindersMayPing({ allowPings: 'yes' })).allowedMentions, {
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
