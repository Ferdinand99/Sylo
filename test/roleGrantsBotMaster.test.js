// A bot-master (dashboard Edit) role carries no platform permission, yet whoever wears it controls the
// whole dashboard. Making the bot hand one out (an autorole, a menu, a temp role) therefore takes what
// choosing the bot masters takes: the server owner or a live Manage Server holder.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const MASTER = '700000000000000601'; // the role the actor wears
const MASTER2 = '700000000000000602'; // another bot-master role, ranked below it
const PLAIN = '700000000000000603';

const role = (id, name, position) => ({
  id,
  name,
  position,
  permissions: { has: () => false },
});

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
    roles: { highest: { position: 10 }, cache },
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
  guild.roles.cache.set(MASTER, role(MASTER, 'Helpers', 10));
  guild.roles.cache.set(MASTER2, role(MASTER2, 'Mods', 2));
  guild.roles.cache.set(PLAIN, role(PLAIN, 'Gamer', 1));
  await setBotMasterRoles(D_GUILD, [MASTER, MASTER2]);
  await setGuildModule(D_GUILD, 'roles', { enabled: true, config: {} });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
});

test('a bot master cannot make a bot-master role an autorole', async () => {
  const post = await person([]);
  const res = await post('/modules/roles/autoroles', { autoroles: [MASTER2] });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Manage Server/);
  assert.deepEqual((await getGuildModule(D_GUILD, 'roles')).config.autoroles ?? [], []);
});

test('a bot master may still hand out an ordinary role below their own', async () => {
  const post = await person([]);
  const res = await post('/modules/roles/autoroles', { autoroles: [PLAIN] });
  assert.equal(res.status, 200);
});

test('someone with Manage Server may hand out a bot-master role', async () => {
  const post = await person(['ManageGuild']);
  const res = await post('/modules/roles/autoroles', { autoroles: [MASTER2] });
  assert.equal(res.status, 200);
  assert.deepEqual((await getGuildModule(D_GUILD, 'roles')).config.autoroles, [MASTER2]);
});
