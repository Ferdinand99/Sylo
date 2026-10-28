// "Set XP" on the leveling page hands out every reward role up to the new level, so it is a
// role grant like any other: someone who may use the dashboard must not be able to jump a
// member (or themselves) to a level whose reward role they could not hand out themselves.
// Lowering XP (and the roles that drop off with it) stays allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp, uid } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { getMember, setXp } = await import('../src/db/leveling.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const fakeRole = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  editable: true,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = fakeRole('700000000000000201', 'Regular', 1);
const MOD = fakeRole('700000000000000202', 'Mod', 3, ['KickMembers']);
const HIGH = fakeRole('700000000000000203', 'Legend', 20);

const TARGET = '800000000000000201';

/** A member the bot can see: their top role, permissions, held roles, and what was added. */
function fakeMember(id, top, perms = [], held = []) {
  const cache = new Map(held.map((r) => [r, { id: r }]));
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  const added = [];
  return {
    id,
    guild,
    added,
    permissions: { has: (p) => perms.includes(p) },
    roles: {
      highest: { position: top },
      cache,
      add: async (ids) => {
        added.push(...[].concat(ids));
        for (const r of [].concat(ids)) cache.set(r, { id: r });
      },
      remove: async () => {},
    },
  };
}

async function signedIn(top, perms) {
  setProfiles({ discordId: uid('33333333333') }); // a snowflake-length id: the XP form takes it
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  const actor = fakeMember(id, top, perms);
  guild.members.cache.set(id, actor);
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return {
    actor,
    v2: (body) =>
      b.get(`/api/v2/guilds/${D_GUILD}/modules/leveling/xp`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    v1: (body) =>
      b.get(`/guilds/${D_GUILD}/m/leveling/xp`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      }),
  };
}

const rewards = (list, extra = {}) =>
  setGuildModule(D_GUILD, 'leveling', { enabled: true, config: { rewards: list, ...extra } });

test.beforeEach(async () => {
  for (const r of [LOW, MOD, HIGH]) guild.roles.cache.set(r.id, r);
  guild.members.me = { permissions: { has: () => true } };
  await setXp(D_GUILD, TARGET, 0);
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
});

test('V2: setting XP that earns a reward role above your own is refused and changes nothing', async () => {
  await rewards([{ level: 5, roleId: HIGH.id }]);
  const { v2 } = await signedIn(10, ['ManageGuild']);
  const target = fakeMember(TARGET, 0);
  guild.members.cache.set(TARGET, target);
  const res = await v2({ userId: TARGET, xp: 100000 });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Legend is above/);
  assert.equal((await getMember(D_GUILD, TARGET)).xp, 0, 'XP is unchanged');
  assert.deepEqual(target.added, [], 'no role was handed out');
});

test('V2: setting your own XP to reach a moderator reward needs Manage Roles', async () => {
  await rewards([{ level: 5, roleId: MOD.id }]);
  const { v2, actor } = await signedIn(10, ['ManageGuild']);
  const res = await v2({ userId: actor.id, xp: 100000 });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /need Manage Roles/);
  assert.equal((await getMember(D_GUILD, actor.id)).xp, 0);
  assert.deepEqual(actor.added, []);
});

test('V2: a member the bot cannot fetch is checked against the rewards they would newly earn', async () => {
  await rewards([{ level: 5, roleId: HIGH.id }]);
  const { v2 } = await signedIn(10, ['ManageGuild']);
  const res = await v2({ userId: TARGET, xp: 100000 }); // TARGET is not in the cache; fetch fails
  assert.equal(res.status, 403);
  assert.equal((await getMember(D_GUILD, TARGET)).xp, 0);
});

test('V2: a reward role below you is handed out as before', async () => {
  await rewards([{ level: 5, roleId: LOW.id }]);
  const { v2 } = await signedIn(10, ['ManageGuild']);
  const target = fakeMember(TARGET, 0);
  guild.members.cache.set(TARGET, target);
  const res = await v2({ userId: TARGET, xp: 100000 });
  assert.equal(res.status, 200);
  assert.equal((await getMember(D_GUILD, TARGET)).xp, 100000);
  assert.deepEqual(target.added, [LOW.id]);
});

test('V2: a reward role the member already holds is not a new grant', async () => {
  await rewards([{ level: 5, roleId: HIGH.id }]);
  const { v2 } = await signedIn(10, ['ManageGuild']);
  guild.members.cache.set(TARGET, fakeMember(TARGET, 0, [], [HIGH.id]));
  const res = await v2({ userId: TARGET, xp: 100000 });
  assert.equal(res.status, 200);
});

test('V2: lowering XP (and losing reward roles with it) stays allowed', async () => {
  await rewards([{ level: 5, roleId: HIGH.id }], { removeRewardsOnXpLoss: true });
  await setXp(D_GUILD, TARGET, 100000);
  const { v2 } = await signedIn(10, ['ManageGuild']);
  guild.members.cache.set(TARGET, fakeMember(TARGET, 0, [], [HIGH.id]));
  const res = await v2({ userId: TARGET, xp: 0 });
  assert.equal(res.status, 200);
  assert.equal((await getMember(D_GUILD, TARGET)).xp, 0);
});

test('V2: the server owner may set any XP', async () => {
  await rewards([{ level: 5, roleId: HIGH.id }]);
  const { v2, actor } = await signedIn(0, []);
  guild.ownerId = actor.id;
  try {
    assert.equal((await v2({ userId: TARGET, xp: 100000 })).status, 200);
  } finally {
    guild.ownerId = 'x';
  }
});
