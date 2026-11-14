// Who may read the permission health check of a server, what it says, and when it is re-read. It has
// its own file because the other permission tests use nearly all of the dashboard's request budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session, OPERATOR_ID } from './helpers/v2Guarded.js';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { resetHealthCache } from '../src/lib/healthCache.js';

await startOAuthApp();

const CH = '111111111111111121';
const ROLE_OK = '222222222222222231';
const ROLE_HIGH = '222222222222222232';

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
let channelPerms = ['ViewChannel', 'SendMessages']; // no Embed Links
guild.members.me = {
  id: 'bot',
  permissions: new PermissionsBitField(PermissionsBitField.All),
  roles: { highest: { position: 10 } },
};
guild.channels.cache.set(CH, {
  id: CH,
  name: 'welcome',
  isTextBased: () => true,
  isVoiceBased: () => false,
  permissionsFor: () => new PermissionsBitField(channelPerms),
});
guild.roles.cache.set(ROLE_OK, { id: ROLE_OK, name: 'Member', position: 2 });
guild.roles.cache.set(ROLE_HIGH, { id: ROLE_HIGH, name: 'Verified', position: 20 });

await setGuildModule(D_GUILD, 'verification', {
  enabled: true,
  config: { verifiedRoleId: ROLE_HIGH, channelId: CH },
});

const admin = await session({ discordId: '333333333333330001', guilds: [{ id: D_GUILD, owner: true }] });

test('the admin of the server gets the checks and the picker data', async () => {
  resetHealthCache();
  const res = await admin.get(`/guilds/${D_GUILD}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.guildId, D_GUILD);
  assert.equal(body.available, true);
  assert.deepEqual(body.summary, { errors: 2, warnings: 0 });
  const byCode = Object.fromEntries(body.checks.map((c) => [c.code, c]));
  assert.equal(byCode['role-above'].targetId, ROLE_HIGH);
  assert.equal(byCode['missing-channel-permission'].targetId, CH);
  assert.deepEqual(byCode['missing-channel-permission'].permissions, ['EmbedLinks']);
  for (const c of body.checks) {
    assert.equal(c.module, 'verification');
    assert.equal(typeof c.message, 'string');
    assert.equal(typeof c.fix, 'string');
    assert.equal(c.href, `/v2/guilds/${D_GUILD}/m/verification`);
  }
  assert.deepEqual(body.targets.roles.blocked, { [ROLE_HIGH]: 'above' });
  assert.deepEqual(body.targets.channels.blocked, {});
  assert.deepEqual(body.targets.channels.noEmbed, [CH]);
});

test('someone who does not manage the server is refused, and so is a signed-out caller', async () => {
  const nobody = await session({
    guilds: [
      { id: D_GUILD, owner: false, permissions: '0' },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  });
  assert.equal((await nobody.get(`/guilds/${D_GUILD}/health`)).status, 403);
  const { status } = await anonymous().get(`/guilds/${D_GUILD}/health`);
  assert.ok(status === 401 || status === 403, `signed out -> ${status}`);
});

test('the admin of one server is refused the health of another', async () => {
  assert.equal((await admin.get(`/guilds/${OTHER_D_GUILD}/health`)).status, 403);
});

test('an unknown server is not found', async () => {
  const operator = await session({ discordId: OPERATOR_ID });
  const { status } = await operator.get('/guilds/900000000000009998/health');
  assert.ok(status === 403 || status === 404, `unknown server -> ${status}`);
});

test('the report is cached, a dashboard save drops it, and ?refresh=1 re-checks at once', async () => {
  resetHealthCache();
  const read = async (query = '') =>
    (await (await admin.get(`/guilds/${D_GUILD}/health${query}`)).json()).summary;
  assert.equal((await read()).errors, 2);
  // Sylo regains Embed Links, but the cached report is served for a minute.
  channelPerms = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
  assert.equal((await read()).errors, 2);
  // Any write on the server drops it, even one that is refused (nothing was saved, but the check is cheap).
  const write = await admin.post(`/guilds/${D_GUILD}/moderation/unlock-channel`, { channelId: 'nope' });
  assert.equal(write.status, 404);
  assert.equal((await read()).errors, 1);
  // So does a module save, which is where the settings are stored.
  channelPerms = ['ViewChannel', 'SendMessages'];
  assert.equal((await read()).errors, 1, 'cached again');
  const save = await admin.post(`/guilds/${D_GUILD}/modules/afk`, { enabled: true });
  assert.equal(save.status, 200);
  assert.equal((await read()).errors, 2);
  channelPerms = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
  await admin.post(`/guilds/${D_GUILD}/modules/afk`, { enabled: false });
  assert.equal((await read()).errors, 1);
  // An explicit re-check does not wait for a save.
  channelPerms = ['ViewChannel'];
  assert.equal((await read()).errors, 1);
  assert.equal((await read('?refresh=1')).errors, 2);
});

test('the re-check has its own small budget', async () => {
  let refused = 0;
  for (let i = 0; i < 8; i++) {
    const res = await admin.get(`/guilds/${D_GUILD}/health?refresh=1`);
    if (res.status === 429) refused += 1;
  }
  assert.ok(refused >= 1, 'a script cannot walk every channel again and again');
  // A plain read is still served.
  assert.equal((await admin.get(`/guilds/${D_GUILD}/health`)).status, 200);
});

test('the overview carries the health, and waiting-for-the-operator items only for an operator', async () => {
  resetHealthCache();
  channelPerms = ['ViewChannel', 'SendMessages'];
  await setGuildModule(D_GUILD, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'a', channelId: CH }] },
  });
  const adminOverview = await (await admin.get(`/guilds/${D_GUILD}/overview`)).json();
  assert.equal(adminOverview.attention.health.summary.errors >= 1, true);
  assert.ok(adminOverview.attention.health.checks.some((c) => c.module === 'verification'));
  assert.ok(!('targets' in adminOverview.attention.health));
  assert.deepEqual(adminOverview.attention.waitingForOwner, []);
  // The card keeps its amber status for the admin.
  const cards = adminOverview.groups.flatMap((g) => g.cards);
  assert.equal(cards.find((c) => c.id === 'twitch-alerts').waitingForOwner, true);

  const operator = await session({ discordId: OPERATOR_ID });
  const operatorOverview = await (await operator.get(`/guilds/${D_GUILD}/overview`)).json();
  assert.deepEqual(
    operatorOverview.attention.waitingForOwner.map((w) => w.id),
    ['twitch-alerts']
  );
});
