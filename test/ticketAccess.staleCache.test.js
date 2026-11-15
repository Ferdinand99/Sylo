// A ticket staff role is checked on a member the bot looked up before: without the Server Members
// intent that cached member keeps a staff role taken away on the platform. The check refreshes the
// member first, as dashboard access roles do, so a removed staff role stops giving Inbox at once.
process.env.INTENT_GUILD_MEMBERS = 'false';
import './helpers/tmpDb.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { accountTicketAccess, accountMaySeeTickets } = await import('../src/web/middleware/ticketAccess.js');

const GID = '900000000000000911';
const STAFF_ROLE = '100000000000000921';
let seq = 0;

const rolesOf = (ids) => {
  const cache = new Map(ids.map((id) => [id, { id }]));
  cache.some = (fn) => [...cache.values()].some(fn);
  cache.hasAny = (...list) => list.some((id) => cache.has(id));
  return { cache };
};

/** A server where the bot cached `userId` holding the staff role, while on the platform they no longer do. */
function world(userId, { stillStaff = false } = {}) {
  const calls = [];
  const cached = { id: userId, roles: rolesOf([STAFF_ROLE]) };
  const fresh = { id: userId, roles: rolesOf(stillStaff ? [STAFF_ROLE] : []) };
  const members = new Map([[userId, cached]]);
  const guild = {
    id: GID,
    ownerId: '100000000000000998',
    members: {
      cache: members,
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && arg.force) {
          calls.push('forced');
          members.set(userId, fresh);
          return fresh;
        }
        return members.get(arg) ?? null;
      },
    },
    roles: { cache: new Map([[STAFF_ROLE, { id: STAFF_ROLE }]]) },
  };
  const client = { isReady: () => true, guilds: { cache: new Map([[GID, guild]]) } };
  guild.client = client;
  runtime.clients.discord = client;
  return { calls };
}

const accountOf = (userId) => ({
  id: 1,
  identities: [{ platform: 'discord', platformUserId: userId, guildIds: [], guildsFetchedAt: Date.now() }],
});

afterEach(() => {
  runtime.clients.discord = null;
});

test('a removed ticket staff role stops giving Inbox, whatever the cache says', async () => {
  const user = `8100000000000${String(++seq).padStart(5, '0')}`;
  const { calls } = world(user);
  await setGuildModule(GID, 'tickets', { enabled: true, config: { staffRoles: [STAFF_ROLE] } });
  const level = await accountTicketAccess(accountOf(user), GID, { live: false, write: false });
  assert.equal(level, null);
  assert.deepEqual(calls, ['forced'], 'the member was fetched fresh');
  assert.equal(await accountMaySeeTickets(accountOf(user), GID, { live: true }), false);
});

test('a ticket staff role that is still held keeps giving Inbox', async () => {
  const user = `8100000000000${String(++seq).padStart(5, '0')}`;
  world(user, { stillStaff: true });
  await setGuildModule(GID, 'tickets', { enabled: true, config: { staffRoles: [STAFF_ROLE] } });
  assert.equal(await accountTicketAccess(accountOf(user), GID, { live: false, write: true }), 'inbox');
});
