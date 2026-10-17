// For the Sylo app, server access is checked live through the bot on every request
// (internal/mobile-api-plan.md, task 4): the server's owner, a member with Manage Server or
// Administrator, or a member with one of the server's bot-master roles. The web dashboard's
// guild list is a snapshot from sign-in that the app cannot refresh, so a lost right must
// count at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const BOT_MASTER = '700000000000000001';

/** Put a member in the fake server with these permissions and roles. */
function member(id, { perms = [], roles = [] } = {}) {
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { cache: { hasAny: (...ids) => ids.some((r) => roles.includes(r)) } },
  });
}

/** A new person whose sign-in snapshot says they administer D_GUILD; returns their id, token and browser. */
async function person() {
  setProfiles();
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  return { id, token, b };
}

const app = browser();
const get = (path, token) => app.get(path, { headers: { authorization: `Bearer ${token}` } });
const overview = (token) => get(`/api/v2/guilds/${D_GUILD}/overview`, token);
const listed = async (token) =>
  (await (await get('/api/v2/guilds', token)).json()).guilds.map((g) => g.id).includes(D_GUILD);

test.afterEach(() => {
  guild.members.cache.clear();
  guild.ownerId = 'x';
});

test('the sign-in snapshot alone is not enough: no longer a member means no access', async () => {
  const { token, b } = await person();
  assert.equal((await overview(token)).status, 403);
  assert.equal(await listed(token), false, 'and the server is not in the list');
  // The web dashboard keeps working from its snapshot, as before.
  assert.equal((await b.get(`/api/v2/guilds/${D_GUILD}/overview`)).status, 200);
});

test('Manage Server or Administrator gives access, and losing it takes effect at once', async () => {
  const { id, token } = await person();
  member(id, { perms: ['ManageGuild'] });
  assert.equal((await overview(token)).status, 200);
  assert.equal(await listed(token), true);

  member(id, { perms: [] });
  assert.equal((await overview(token)).status, 403, 'no re-sign-in needed to lose access');
  assert.equal(await listed(token), false);

  member(id, { perms: ['Administrator'] });
  assert.equal((await overview(token)).status, 200);
});

test("the server's owner gets in without any role", async () => {
  const { id, token } = await person();
  member(id);
  guild.ownerId = id;
  assert.equal((await overview(token)).status, 200);
});

test('a bot-master role gives access', async () => {
  const { id, token } = await person();
  member(id, { roles: [BOT_MASTER] });
  assert.equal((await overview(token)).status, 403, 'not a bot master yet');
  await setBotMasterRoles(D_GUILD, [BOT_MASTER]);
  try {
    assert.equal((await overview(token)).status, 200);
  } finally {
    await setBotMasterRoles(D_GUILD, []);
  }
});
