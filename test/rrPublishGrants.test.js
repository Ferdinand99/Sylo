// Saving a reaction-role / role-menu set publishes it to the channel first and saves it after,
// and the role-grant guard sits on the save. A set handing out a role the person could not
// hand out must be refused before anything reaches the channel: no new post, no edit, and no
// deleted old message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const fakeRole = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = fakeRole('700000000000000301', 'Gamer', 1);
const HIGH = fakeRole('700000000000000302', 'Council', 20);

const CHANNEL = '100000000000000301';
const OLD_MESSAGE = '100000000000000399';

/** A text channel that records everything sent to it, edited in it, or deleted from it. */
function fakeChannel() {
  const log = { sent: [], edited: [], deleted: [] };
  const message = (id) => ({
    id,
    reactions: { cache: new Map() },
    react: async () => {},
    edit: async (payload) => log.edited.push(payload),
    delete: async () => log.deleted.push(id),
  });
  return {
    log,
    channel: {
      id: CHANNEL,
      name: 'roles',
      guild,
      isTextBased: () => true,
      send: async (payload) => {
        log.sent.push(payload);
        return message('100000000000000400');
      },
      messages: { fetch: async (id) => message(id) },
    },
  };
}

async function signedIn() {
  setProfiles();
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => p === 'ManageGuild' },
    roles: { highest: { position: 10 }, cache: new Map() },
  });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return {
    v2: (body) =>
      b.get(`/api/v2/guilds/${D_GUILD}/modules/roles/rr`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    v1: (body) =>
      b.get(`/guilds/${D_GUILD}/m/roles/rr`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      }),
  };
}

let log;
test.beforeEach(async () => {
  for (const r of [LOW, HIGH]) guild.roles.cache.set(r.id, r);
  const fake = fakeChannel();
  log = fake.log;
  guild.channels.cache.set(CHANNEL, fake.channel);
  await setGuildModule(D_GUILD, 'roles', { config: {} });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
  guild.channels.cache.clear();
});

const buttons = (roleId, extra = {}) => ({
  channelId: CHANNEL,
  style: 'buttons',
  pairs: [{ roleId, label: 'Pick me' }],
  ...extra,
});

test('V2: a refused role-menu save posts nothing to the channel', async () => {
  const { v2 } = await signedIn();
  const res = await v2(buttons(HIGH.id));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Council is above/);
  assert.deepEqual(log.sent, [], 'nothing was posted');
  assert.deepEqual((await getGuildModule(D_GUILD, 'roles')).config.reactionMessages ?? [], []);
});

test('V2: a refused re-publish neither edits nor deletes the live message', async () => {
  await setGuildModule(D_GUILD, 'roles', {
    config: {
      reactionMessages: [
        {
          id: '1',
          channelId: CHANNEL,
          messageId: OLD_MESSAGE,
          style: 'reaction',
          pairs: [{ key: 'x', display: 'x', react: 'x', roleId: LOW.id }],
        },
      ],
    },
  });
  const { v2 } = await signedIn();
  const res = await v2(buttons(HIGH.id, { id: '1' }));
  assert.equal(res.status, 403);
  assert.deepEqual(log, { sent: [], edited: [], deleted: [] });
});

test('V2: an allowed role-menu save is still published', async () => {
  const { v2 } = await signedIn();
  const res = await v2(buttons(LOW.id));
  assert.equal(res.status, 200);
  assert.equal(log.sent.length, 1);
});
