// The role-grant rule through the setup wizard: someone who may not hand out a role (it is above their
// highest role) is refused BEFORE the wizard creates anything for that item, so no channel is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { getGuildModule } = await import('../src/db/modules.js');
const { listAudit } = await import('../src/db/audit.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const role = (id, name, position) => ({
  id,
  name,
  position,
  managed: false,
  permissions: { has: () => false },
});
const HIGH = role('700000000000000104', 'Boss', 20);
const LOW = role('700000000000000101', 'Member', 1);

const created = [];
guild.members.me = {
  id: 'bot-id',
  permissions: { has: () => true },
  roles: { highest: { position: 50 } },
};
guild.channels.create = async (opts) => {
  created.push(opts.name);
  return { id: '700000000000000900' };
};

async function signedIn(top, perms) {
  setProfiles();
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { highest: { position: top }, cache: { hasAny: () => false } },
  });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (path, body) =>
    b.get(`/api/v2${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

test.beforeEach(() => {
  for (const r of [HIGH, LOW]) guild.roles.cache.set(r.id, r);
});

test('a role above the person is refused before the item creates anything', async () => {
  const post = await signedIn(10, ['ManageGuild']);
  const res = await post(`/guilds/${D_GUILD}/setup/apply`, {
    items: [{ id: 'verification', fields: { channelId: { create: true }, verifiedRoleId: { id: HIGH.id } } }],
  });
  assert.equal(res.status, 200);
  const r = (await res.json()).results[0];
  assert.equal(r.status, 'failed');
  assert.match(r.message, /above or equal to your highest role/);
  assert.deepEqual(r.created, []);
  assert.deepEqual(created, [], 'no channel was made before the refusal');
  assert.equal((await getGuildModule(D_GUILD, 'verification')).enabled, false);
  assert.deepEqual(await listAudit(D_GUILD, 20), []);
});

test('a role below the person goes through, and the channel is made', async () => {
  const post = await signedIn(10, ['ManageGuild']);
  const res = await post(`/guilds/${D_GUILD}/setup/apply`, {
    items: [{ id: 'verification', fields: { channelId: { create: true }, verifiedRoleId: { id: LOW.id } } }],
  });
  const r = (await res.json()).results[0];
  assert.equal(r.status, 'applied', r.message);
  assert.deepEqual(created, ['verify']);
});
