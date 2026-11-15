// The birthday role comes off yesterday's celebrants, and after downtime off those of every day the sweep
// missed, even on a server without the Server Members intent, where the role's member list is a stale cache.
process.env.INTENT_GUILD_MEMBERS = 'false';
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { setBirthday } = await import('../src/db/birthdays.js');
const { setAppSetting } = await import('../src/db/appSettings.js');
const { runBirthdaySweep } = await import('../src/modules/birthdays.js');

const GID = '900000000000000921';
const ROLE = '100000000000000931';
const U1 = '800000000000000931';
const U2 = '800000000000000932';

function world() {
  const removed = [];
  const role = { id: ROLE, name: 'Birthday', position: 2, members: new Map() }; // the cache knows nobody
  const member = (id) => ({
    id,
    roles: {
      cache: new Map([[ROLE, role]]),
      add: async () => {},
      remove: async (r) => removed.push([id, r.id]),
    },
  });
  const live = new Map([
    [U1, member(U1)],
    [U2, member(U2)],
  ]);
  const guild = {
    id: GID,
    channels: { cache: new Map(), fetch: async () => null },
    roles: { cache: new Map([[ROLE, role]]) },
    members: {
      cache: new Map(),
      me: {
        id: 'bot',
        permissions: { has: () => true },
        roles: { highest: { comparePositionTo: (r) => 10 - r.position } },
      },
      fetch: async (arg) => live.get(typeof arg === 'object' ? arg.user : arg) ?? null,
    },
  };
  const client = { isReady: () => true, guilds: { cache: new Map([[GID, guild]]) } };
  guild.client = client;
  runtime.clients.discord = client;
  return { removed };
}

test("the sweep takes the role off yesterday's celebrant by id, though the cached role list is empty", async () => {
  const { removed } = world();
  await setGuildModule(GID, 'birthdays', { enabled: true, config: { roleId: ROLE } });
  await setBirthday({ guildId: GID, userId: U1, month: 11, day: 12 });
  await setAppSetting('birthdays:lastRun', '2026-11-12');
  await runBirthdaySweep(new Date(2026, 10, 13, 9));
  assert.deepEqual(removed, [[U1, ROLE]]);
});

test('after downtime it covers every day since the last sweep', async () => {
  const { removed } = world();
  await setGuildModule(GID, 'birthdays', { enabled: true, config: { roleId: ROLE } });
  await setBirthday({ guildId: GID, userId: U1, month: 11, day: 10 });
  await setBirthday({ guildId: GID, userId: U2, month: 11, day: 11 });
  await setAppSetting('birthdays:lastRun', '2026-11-10');
  await runBirthdaySweep(new Date(2026, 10, 14, 9));
  assert.deepEqual(removed.map((r) => r[0]).sort(), [U1, U2]);
});
