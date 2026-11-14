// The role-grant guard compares grant sites, not just role ids: a role the module already hands
// out somewhere (an Administrator's menu in a staff channel) is still a new grant when it is
// published in another channel, added as an autorole, or when the module is switched on again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');
const { moduleGrantSites } = await import('../src/web/middleware/roleGrants.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const fakeRole = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = fakeRole('700000000000000501', 'Gamer', 1);
const HIGH = fakeRole('700000000000000502', 'Council', 20, ['KickMembers']);
const STAFF = '100000000000000501';
const GENERAL = '100000000000000502';

function fakeChannel(id) {
  const message = (mid) => ({
    id: mid,
    reactions: { cache: new Map() },
    react: async () => {},
    edit: async () => {},
    delete: async () => {},
  });
  return {
    id,
    name: id,
    guild,
    isTextBased: () => true,
    send: async () => message('100000000000000600'),
    messages: { fetch: async (mid) => message(mid) },
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
  const post = (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post };
}

// What an Administrator already set up: a Council menu in the staff channel.
const adminSet = (extra = {}) => ({
  id: '11',
  channelId: STAFF,
  messageId: '100000000000000399',
  style: 'buttons',
  pairs: [{ roleId: HIGH.id, label: 'Join' }],
  ...extra,
});
const buttons = (roleId, extra = {}) => ({
  channelId: GENERAL,
  style: 'buttons',
  pairs: [{ roleId, label: 'Join' }],
  ...extra,
});

test.beforeEach(async () => {
  for (const r of [LOW, HIGH]) guild.roles.cache.set(r.id, r);
  guild.channels.cache.set(STAFF, fakeChannel(STAFF));
  guild.channels.cache.set(GENERAL, fakeChannel(GENERAL));
  await setGuildModule(D_GUILD, 'roles', { enabled: true, config: { reactionMessages: [adminSet()] } });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
  guild.channels.cache.clear();
});

test('a role already on a menu cannot be published in another channel by someone below it', async () => {
  const { post } = await signedIn();
  const res = await post('roles/rr', buttons(HIGH.id));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Council is above/);
  assert.equal((await getGuildModule(D_GUILD, 'roles')).config.reactionMessages.length, 1);
});

test('the existing menu cannot be moved to another channel by someone below its role', async () => {
  const { post } = await signedIn();
  const res = await post('roles/rr', buttons(HIGH.id, { id: '11' }));
  assert.equal(res.status, 403);
  assert.equal((await getGuildModule(D_GUILD, 'roles')).config.reactionMessages[0].channelId, STAFF);
});

test('a role already on a menu cannot be added as an autorole by someone below it', async () => {
  const { post } = await signedIn();
  const res = await post('roles/autoroles', { autoroles: [HIGH.id] });
  assert.equal(res.status, 403);
  assert.deepEqual((await getGuildModule(D_GUILD, 'roles')).config.autoroles ?? [], []);
});

test('saving a grant that did not change stays allowed', async () => {
  await setGuildModule(D_GUILD, 'roles', {
    enabled: true,
    config: { autoroles: [HIGH.id], reactionMessages: [adminSet()] },
  });
  const { post } = await signedIn();
  const res = await post('roles/autoroles', { autoroles: [HIGH.id] });
  assert.equal(res.status, 200, 'the same autorole in the same place is not a new grant');
  const again = await post('roles/rr', buttons(HIGH.id, { id: '11', channelId: STAFF, message: 'new text' }));
  assert.equal(again.status, 200, 'the same set in the same channel is not a new grant');
});

test('a low role on a menu in another channel is still fine', async () => {
  const { post } = await signedIn();
  const res = await post('roles/rr', buttons(LOW.id));
  assert.equal(res.status, 200);
});

test('switching a module on checks every grant it holds', async () => {
  await setGuildModule(D_GUILD, 'roles', {
    enabled: false,
    config: { autoroles: [HIGH.id] },
  });
  const { post } = await signedIn();
  const res = await post('roles', { enabled: true });
  assert.equal(res.status, 403);
  assert.equal((await getGuildModule(D_GUILD, 'roles')).enabled, false);
  // Switching it off is not a grant.
  await setGuildModule(D_GUILD, 'roles', { enabled: true });
  const off = await post('roles', { enabled: false });
  assert.equal(off.status, 200);
});

test('moduleGrantSites tells the same role apart by where it is handed out', () => {
  const sites = (cfg) => moduleGrantSites('roles', cfg).map((g) => g.site);
  assert.notDeepEqual(
    sites({ reactionMessages: [adminSet()] }),
    sites({ reactionMessages: [adminSet({ channelId: GENERAL })] })
  );
  assert.deepEqual(
    sites({ reactionMessages: [adminSet()] }),
    sites({ reactionMessages: [adminSet({ messageId: 'x', message: 'other text' })] }),
    'the post and its text are not part of the site'
  );
  assert.notDeepEqual(
    moduleGrantSites('custom-commands', {
      commands: [{ id: '1', actions: [{ type: 'add-role', roleId: '5' }], allowedRoles: ['9'] }],
    }),
    moduleGrantSites('custom-commands', { commands: [{ id: '1', actions: [{ type: 'add-role', roleId: '5' }] }] })
  );
});
