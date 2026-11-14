// Import and Duplicate with the login on (the open-mode tests prove nothing about who may do what):
//  - a role the person may not hand out is refused by the role-grant guard, for an import item and for a
//    shop item copy, and nothing is stored;
//  - someone without Manage Server, someone from another server and a request without the CSRF token are
//    refused on every one of the seven routes;
//  - the ids of another server's rows are not found.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';
import { session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');
const { createReminder, listScheduled } = await import('../src/db/scheduledMessages.js');
const { createComposed, listComposed } = await import('../src/db/composedMessages.js');
const { createItem, listItems } = await import('../src/db/economyShop.js');
const { normaliseItem } = await import('../src/modules/economy.js');

const USER = '900000000000004242';
const HIGH = '800000000000000010'; // above the person's highest role
const LOW = '800000000000000011'; // below it
const CH = '800000000000000020';
const MANAGE_SERVER = '32';

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const role = (id, name, position) => ({
  id,
  name,
  position,
  managed: false,
  permissions: { has: () => false },
  comparePositionTo: (o) => position - (o?.position ?? 0),
});
guild.roles.cache.set(HIGH, role(HIGH, 'High', 10));
guild.roles.cache.set(LOW, role(LOW, 'Low', 0));
guild.channels.cache.set(CH, { id: CH, name: 'general', isTextBased: () => true });
// The person: Manage Server but not Administrator, and a highest role of position 1.
guild.members.cache.set(USER, {
  id: USER,
  roles: { highest: { position: 1 }, cache: new Map() },
  permissions: { has: () => false },
});

/** Signed in as the person above, with Manage Server on the main server only (or the given rights). */
const asPerson = (guilds) =>
  session({
    discordId: USER,
    guilds: guilds ?? [
      { id: D_GUILD, owner: false, permissions: MANAGE_SERVER },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  });

const file = (modules) => ({
  sylo: 'guild-config-export',
  version: 1,
  guildId: '1',
  settings: null,
  modules,
  commandOverrides: [],
});

const DUPLICATES = (g) => [
  `/guilds/${g}/modules/reminders/1/duplicate`,
  `/guilds/${g}/messages/1/duplicate`,
  `/guilds/${g}/modules/roles/rr/x1/duplicate`,
  `/guilds/${g}/modules/custom-commands/cmd/c1/duplicate`,
  `/guilds/${g}/modules/economy/shop/items/1/duplicate`,
];
const IMPORTS = (g) => [`/guilds/${g}/import/preview`, `/guilds/${g}/import/apply`];

test('an import item with a role above the person fails with the reason and stores nothing', async () => {
  const p = await asPerson();
  const doc = file([
    { moduleId: 'verification', enabled: false, config: { mode: 'button', verifiedRoleId: HIGH } },
    { moduleId: 'leveling', enabled: true, config: { rewards: [{ level: 5, roleId: HIGH }] } },
    { moduleId: 'afk', enabled: true, config: { setNickname: false } },
  ]);
  const preview = await p.post(`/guilds/${D_GUILD}/import/preview`, { export: doc });
  assert.equal(preview.status, 200);
  const res = await p.post(`/guilds/${D_GUILD}/import/apply`, {
    export: doc,
    items: ['module:verification', 'module:leveling', 'module:afk'],
    confirm: 'IMPORT',
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  for (const key of ['module:verification', 'module:leveling']) {
    assert.equal(by[key].ok, false, key);
    assert.match(by[key].error, /High is above or equal to your highest role/);
  }
  assert.equal(by['module:afk'].ok, true, 'an item that needs no role still imports');
  assert.equal((await getGuildModule(D_GUILD, 'verification')).config.verifiedRoleId, undefined);
  assert.deepEqual((await getGuildModule(D_GUILD, 'leveling')).config.rewards, undefined);
  assert.equal((await getGuildModule(D_GUILD, 'afk')).config.setNickname, false);
});

test('a role below the person imports', async () => {
  const p = await asPerson();
  const doc = file([
    { moduleId: 'verification', enabled: false, config: { mode: 'button', verifiedRoleId: LOW } },
  ]);
  const res = await p.post(`/guilds/${D_GUILD}/import/apply`, {
    export: doc,
    items: ['module:verification'],
    confirm: 'IMPORT',
  });
  assert.equal((await res.json()).results[0].ok, true);
  assert.equal((await getGuildModule(D_GUILD, 'verification')).config.verifiedRoleId, LOW);
});

test('copying a shop item that hands out a role above the person is refused (403) and adds no item', async () => {
  const above = await createItem(
    D_GUILD,
    normaliseItem({ name: 'Admin pass', type: 'role', roleId: HIGH, price: 5 })
  );
  const below = await createItem(
    D_GUILD,
    normaliseItem({ name: 'Member pass', type: 'role', roleId: LOW, price: 5 })
  );
  const before = (await listItems(D_GUILD)).length;
  const p = await asPerson();
  const refused = await p.post(`/guilds/${D_GUILD}/modules/economy/shop/items/${above}/duplicate`);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /above or equal to your highest role/);
  assert.equal((await listItems(D_GUILD)).length, before);

  const allowed = await p.post(`/guilds/${D_GUILD}/modules/economy/shop/items/${below}/duplicate`);
  assert.equal(allowed.status, 200);
  assert.equal((await listItems(D_GUILD)).length, before + 1);
});

test('someone without Manage Server is refused on all seven routes', async () => {
  const nobody = await asPerson([{ id: D_GUILD, owner: false, permissions: '0' }]);
  for (const path of [...DUPLICATES(D_GUILD), ...IMPORTS(D_GUILD)]) {
    const res = await nobody.post(path, { export: file([]), items: ['settings'], confirm: 'IMPORT' });
    assert.equal(res.status, 403, path);
  }
});

test("an admin of one server cannot use the routes of another server, and the other server's ids are not found", async () => {
  const other = OTHER_D_GUILD;
  const reminder = await createReminder(other, {
    name: 'theirs',
    channelId: CH,
    spec: { content: 'x', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 60,
  });
  const message = await createComposed(other, { name: 'theirs', channelId: CH, messageId: null, spec: {} });
  await setGuildModule(other, 'roles', {
    config: { reactionMessages: [{ id: 'x1', channelId: CH, messageId: '', style: 'buttons', pairs: [] }] },
  });
  await setGuildModule(other, 'custom-commands', {
    config: {
      commands: [{ id: 'c1', name: 'theirs', actions: [{ type: 'reply', content: 'x' }] }],
    },
  });
  const item = await createItem(other, normaliseItem({ name: 'theirs', price: 1, type: 'custom' }));

  const p = await asPerson();
  // Refused outright on the other server (no Manage Server there) ...
  for (const path of [...DUPLICATES(other), ...IMPORTS(other)]) {
    assert.equal(
      (await p.post(path, { export: file([]), items: ['settings'], confirm: 'IMPORT' })).status,
      403,
      path
    );
  }
  // ... and their row ids are not found on the server the person does manage.
  const ids = [
    `/guilds/${D_GUILD}/modules/reminders/${reminder}/duplicate`,
    `/guilds/${D_GUILD}/messages/${message.id}/duplicate`,
    `/guilds/${D_GUILD}/modules/roles/rr/x1/duplicate`,
    `/guilds/${D_GUILD}/modules/custom-commands/cmd/c1/duplicate`,
    `/guilds/${D_GUILD}/modules/economy/shop/items/${item}/duplicate`,
  ];
  for (const path of ids) assert.equal((await p.post(path)).status, 404, path);
  assert.equal((await listScheduled(other)).length, 1);
  assert.equal((await listComposed(other, 50)).length, 1);
  assert.equal((await listItems(other)).length, 1);
  assert.equal((await getGuildModule(other, 'custom-commands')).config.commands.length, 1);
});

test('a request without the CSRF token is refused on all seven routes', async () => {
  setProfiles({ discordId: USER });
  profiles.discord.guilds = [{ id: D_GUILD, owner: true }];
  const b = browser();
  await signIn(b, 'discord');
  const before = (await listItems(D_GUILD)).length;
  for (const path of [...DUPLICATES(D_GUILD), ...IMPORTS(D_GUILD)]) {
    const res = await b.get(`/api/v2${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ export: file([]), items: ['settings'], confirm: 'IMPORT' }),
    });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await listItems(D_GUILD)).length, before);
});
