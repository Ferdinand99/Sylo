// Without the Server Members intent the bot's member cache keeps the roles a member had when it was
// first seen: Sylo's own roles.add does not update it, and nothing else tells the bot. The expiry
// sweep, an early removal and the shop's take-back must therefore ask the platform, not the cache,
// whether the member still holds the role.
process.env.INTENT_GUILD_MEMBERS = 'false';
import './helpers/tmpDb.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { runtime } = await import('../src/runtime.js');
const { putTempRole, getTempRole } = await import('../src/db/tempRoles.js');
const { stopSchedules } = await import('../src/modules/schedule.js');
const { removeTempRole, sweep, takeRoleOnPlatform } = await import('../src/modules/tempRoles.js');
const { liveMember } = await import('../src/modules/lib/liveMember.js');
const { config } = await import('../src/config.js');

await stopSchedules();

const GID = '900000000000000901';
const ROLE = '100000000000000901';
const USER = '100000000000000911';

function world({ platform = 'discord' } = {}) {
  const calls = [];
  const state = { fetchError: null };
  const role = {
    id: ROLE,
    name: 'Perk',
    position: 2,
    managed: false,
    editable: true,
    permissions: { has: () => false },
    comparePositionTo: (o) => 2 - o.position,
  };
  // The cached member predates the grant; the platform's copy has the role.
  const cached = {
    id: USER,
    user: { id: USER },
    roles: { cache: new Map(), add: async () => {}, remove: async () => {} },
  };
  const live = {
    id: USER,
    user: { id: USER },
    roles: {
      cache: new Map([[ROLE, role]]),
      add: async () => {},
      remove: async (r) => calls.push(['remove', USER, r.id]),
    },
  };
  const members = new Map([[USER, cached]]);
  const guild = {
    id: GID,
    name: 'Test Guild',
    ownerId: '100000000000000998',
    channels: { cache: new Map(), fetch: async () => null },
    roles: { cache: new Map([[ROLE, role]]) },
    members: {
      cache: members,
      me: {
        id: 'bot',
        permissions: { has: () => true },
        roles: { highest: { position: 10, comparePositionTo: (r) => 10 - r.position } },
      },
      // discord.js: a plain fetch answers from the cache, a forced one asks the platform.
      fetch: async (arg) => {
        if (state.fetchError) throw state.fetchError;
        return arg && typeof arg === 'object' && arg.force ? live : (members.get(arg) ?? live);
      },
    },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[GID, guild]]) },
    users: { fetch: async () => null },
  };
  guild.client = client;
  runtime.clients.discord = platform === 'discord' ? client : null;
  runtime.clients.fluxer = platform === 'fluxer' ? client : null;
  return { guild, calls, state };
}

afterEach(async () => {
  await stopSchedules();
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

const due = () =>
  putTempRole({
    guildId: GID,
    userId: USER,
    roleId: ROLE,
    expiresAt: Date.now() - 1000,
    createdAt: Date.now() - 60_000,
  });

test('the intent is off in this run', () => {
  assert.equal(config.intentGuildMembers, false);
});

test('liveMember asks the platform, not the cache', async () => {
  const { guild } = world();
  const m = await liveMember(guild, USER);
  assert.ok(m.roles.cache.has(ROLE));
});

test('the expiry sweep takes the role off a member whose cached copy predates the grant', async () => {
  const { calls } = world();
  await due();
  await sweep();
  assert.deepEqual(calls, [['remove', USER, ROLE]]);
  assert.equal(await getTempRole(GID, USER, ROLE), null, 'the record ends after the role is off');
});

test('an early removal takes the role off too, and says so', async () => {
  const { guild, calls } = world();
  await due();
  const out = await removeTempRole({ guild, userId: USER, roleId: ROLE });
  assert.equal(out.ok, true);
  assert.equal(out.roleRemoved, true);
  assert.deepEqual(calls, [['remove', USER, ROLE]]);
});

test('the shop take-back removes the role', async () => {
  const { guild, calls } = world();
  const out = await takeRoleOnPlatform(guild, USER, ROLE, 'Purchase refunded');
  assert.equal(out.roleRemoved, true);
  assert.deepEqual(calls, [['remove', USER, ROLE]]);
});

test('Fluxer asks the platform too, as the event page does', async () => {
  const { guild } = world({ platform: 'fluxer' });
  const m = await liveMember(guild, USER);
  assert.ok(m.roles.cache.has(ROLE), 'the fresh member, not the cached one');
});

test('a failed lookup is not read as "the member left": the early removal keeps the record and says so', async () => {
  const { guild, calls, state } = world();
  await due();
  state.fetchError = Object.assign(new Error('Service Unavailable'), { status: 503 });
  const out = await removeTempRole({ guild, userId: USER, roleId: ROLE });
  assert.equal(out.ok, false);
  assert.match(out.error, /could not check the member/);
  assert.ok(await getTempRole(GID, USER, ROLE), 'the record is still there');
  assert.deepEqual(calls, []);
  // A member who is really gone still ends the record.
  state.fetchError = Object.assign(new Error('Unknown Member'), { status: 404, code: 10007 });
  const gone = await removeTempRole({ guild, userId: USER, roleId: ROLE });
  assert.equal(gone.ok, true);
  assert.equal(await getTempRole(GID, USER, ROLE), null);
});

test('the shop take-back warns instead of reporting nothing to do when the lookup fails', async () => {
  const { guild, state } = world();
  state.fetchError = Object.assign(new Error('Too Many Requests'), { status: 429 });
  const out = await takeRoleOnPlatform(guild, USER, ROLE, 'Purchase refunded');
  assert.equal(out.roleRemoved, false);
  assert.match(out.warning, /could not check the member/);
});
