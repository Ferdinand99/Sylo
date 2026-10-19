// Bot masters may use the dashboard, but they must not be able to widen (or otherwise change)
// who else is a bot master: only the server owner or someone with Manage Server, checked live,
// may change the bot-master roles. A bot master can still save the rest of the settings page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { getBotMasterRoles, setBotMasterRoles, guildEmbedColor } = await import('../src/db/guildSettings.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const BOT_MASTER = '700000000000000401';
const FRIEND = '700000000000000402';
const REFUSAL = /Only the server owner or someone with Manage Server can change bot master roles\./;

function fakeMember(id, { perms = [], roles = [] } = {}) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  return { id, permissions: { has: (p) => perms.includes(p) }, roles: { highest: { position: 5 }, cache } };
}

/**
 * Sign in. A bot master is not an admin at sign-in (no Manage Server), and gets in through
 * their role; a manager has Manage Server both at sign-in and live.
 */
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
  return {
    id,
    v2: (body) =>
      b.get(`/api/v2/guilds/${D_GUILD}/settings`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ modlogChannelId: '', ...body }),
      }),
    v1: (fields) =>
      b.get(`/guilds/${D_GUILD}/settings`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['modlogChannelId', ''], ...fields]).toString(),
      }),
  };
}

test.beforeEach(async () => {
  await setBotMasterRoles(D_GUILD, [BOT_MASTER]);
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.ownerId = 'x';
});

test('V2: a bot master cannot add a bot-master role', async () => {
  const { v2 } = await signedIn();
  const res = await v2({ botMasterRoleIds: [BOT_MASTER, FRIEND], embedColor: '#112233' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, REFUSAL);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [BOT_MASTER]);
  assert.notEqual(await guildEmbedColor(D_GUILD), 0x112233, 'nothing on the page was saved');
});

test('V2: a bot master cannot remove the bot-master roles either', async () => {
  const { v2 } = await signedIn();
  assert.equal((await v2({ botMasterRoleIds: [] })).status, 403);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [BOT_MASTER]);
});

test('V2: a bot master can save the other settings when the roles are unchanged', async () => {
  const { v2 } = await signedIn();
  const res = await v2({ botMasterRoleIds: [BOT_MASTER], embedColor: '#112233' });
  assert.equal(res.status, 200);
  assert.equal(await guildEmbedColor(D_GUILD), 0x112233);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [BOT_MASTER]);
});

test('V2: someone with Manage Server can change the bot-master roles', async () => {
  const { v2 } = await signedIn({ manager: true });
  const res = await v2({ botMasterRoleIds: [BOT_MASTER, FRIEND] });
  assert.equal(res.status, 200);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [BOT_MASTER, FRIEND]);
});

test('V2: the server owner can change the bot-master roles', async () => {
  const { v2, id } = await signedIn();
  guild.ownerId = id;
  assert.equal((await v2({ botMasterRoleIds: [FRIEND, BOT_MASTER] })).status, 200);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [FRIEND, BOT_MASTER]);
});

test('V1: a bot master cannot add a bot-master role', async () => {
  const { v1 } = await signedIn();
  const res = await v1([
    ['botMasterRoles', BOT_MASTER],
    ['botMasterRoles', FRIEND],
  ]);
  assert.equal(res.status, 403);
  assert.match(await res.text(), REFUSAL);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [BOT_MASTER]);
});

test('V1: a bot master can save the page with the roles unchanged', async () => {
  const { v1 } = await signedIn();
  const res = await v1([
    ['botMasterRoles', BOT_MASTER],
    ['embedColor', '#445566'],
  ]);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=saved$/);
  assert.equal(await guildEmbedColor(D_GUILD), 0x445566);
});

test('V1: someone with Manage Server can change the bot-master roles', async () => {
  const { v1 } = await signedIn({ manager: true });
  const res = await v1([['botMasterRoles', FRIEND]]);
  assert.equal(res.status, 302);
  assert.deepEqual(await getBotMasterRoles(D_GUILD), [FRIEND]);
});
