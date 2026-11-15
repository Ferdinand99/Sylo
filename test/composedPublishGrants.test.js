// Role buttons and menus of a Message Creator message hand out their roles to whoever presses them, in
// the channel the message is posted to. Every new post (a first publish, a re-publish after unpublish, a
// move to another channel) is therefore a new grant: the person publishing must be able to hand out every
// role in it, even when the same message with the same roles already sat in a staff channel.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { createComposed, getComposed } = await import('../src/db/composedMessages.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const role = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  mentionable: false,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = role('700000000000001001', 'Gamer', 1);
const HIGH = role('700000000000001002', 'Council', 20, ['KickMembers']);
const STAFF = '100000000000001001';
const GENERAL = '100000000000001002';
const sent = [];

const spec = (roleId) => ({
  content: 'Pick one',
  embeds: [],
  rows: [{ type: 'buttons', buttons: [{ label: 'Join', roleId, style: 'primary' }] }],
});

const channel = (id) => ({
  id,
  name: id,
  guild,
  isTextBased: () => true,
  send: async (payload) => {
    sent.push({ id, payload });
    return { id: '100000000000001050' };
  },
  messages: { delete: async () => {} },
});

async function bot() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const id = profiles.discord.id;
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => p === 'ManageGuild' },
    roles: { highest: { position: 10 }, cache: new Map() },
  });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

test.beforeEach(() => {
  sent.length = 0;
  for (const r of [LOW, HIGH]) guild.roles.cache.set(r.id, r);
  guild.channels.cache.set(STAFF, channel(STAFF));
  guild.channels.cache.set(GENERAL, channel(GENERAL));
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
  guild.channels.cache.clear();
});

test('a message an Administrator published in #staff cannot be unpublished and re-published to #general', async () => {
  const rec = await createComposed(D_GUILD, {
    name: 'Council menu',
    channelId: STAFF,
    messageId: '100000000000001060',
    spec: spec(HIGH.id),
  });
  const post = await bot();
  const un = await post(`/messages/${rec.id}/unpublish`, {});
  assert.equal(un.status, 200, JSON.stringify(await un.json()));
  const res = await post(`/messages/${rec.id}`, {
    name: 'Council menu',
    channelId: GENERAL,
    spec: spec(HIGH.id),
    action: 'publish',
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Council is above/);
  assert.deepEqual(sent, [], 'nothing was posted');
});

test('a draft with a role above the actor cannot be published', async () => {
  const rec = await createComposed(D_GUILD, { name: 'Draft', channelId: '', messageId: null, spec: spec(HIGH.id) });
  const post = await bot();
  const res = await post(`/messages/${rec.id}`, {
    name: 'Draft',
    channelId: GENERAL,
    spec: spec(HIGH.id),
    action: 'publish',
  });
  assert.equal(res.status, 403);
  assert.deepEqual(sent, []);
  assert.equal((await getComposed(D_GUILD, rec.id)).message_id, null);
});

test('publishing role buttons the actor could hand out still works', async () => {
  const post = await bot();
  const res = await post('/messages/new', {
    name: 'Fine',
    channelId: GENERAL,
    spec: spec(LOW.id),
    action: 'publish',
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(sent.length, 1);
});
