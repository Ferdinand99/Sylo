// Appeals decided on the dashboard before Sylo stored who decided by id carry only "<label> (dashboard)",
// where the label is the stored name of the deciding person's dashboard account (the global name, else the
// handle). /forget must clear that label from the right person's appeals: found through Sylo's own
// records of them, and only when they hold staff access in the server now. A platform handle that merely
// equals somebody else's label must never clear it.
import './helpers/tmpDb.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { signInIdentity } from '../src/db/accounts.js';
import { dropFakeShop, fakeMember, fakeShopGuild } from './helpers/fakeShop.js';

const G = '8300000000000010';
const STAFF = '8300000000000011';
const OTHER_STAFF = '8300000000000012';
const MEMBER = '8300000000000013';
const PLAIN = '8300000000000014';
const USER = '8300000000000015';

afterEach(() => dropFakeShop());

function appeal(label, { id = null } = {}) {
  db.prepare(
    'INSERT INTO appeals (guild_id, user_id, status, decided_by, decided_by_user_id, created_at) VALUES (?,?,?,?,?,?)'
  ).run(G, USER, 'denied', label, id, Date.now());
}
const deciders = () =>
  db
    .prepare('SELECT decided_by FROM appeals WHERE guild_id = ? ORDER BY id')
    .all(G)
    .map((r) => r.decided_by);

async function forget(user, { staff = false } = {}) {
  const { execute } = await import('../src/bot/commands/forget.js');
  const g = fakeShopGuild(G);
  const m = fakeMember(user.id);
  m.permissions = { has: (p) => staff && p === 'ManageGuild' };
  g.guild.members.cache.set(user.id, m);
  await execute({
    inGuild: () => true,
    guild: { ...g.guild, name: 'Forget Test' },
    guildId: G,
    user: { ...user, send: async () => ({}) },
    options: { getBoolean: () => true },
    reply: async () => {},
  });
}

test('/forget clears the label of a staff member whose global name differs from their handle', async () => {
  db.exec('DELETE FROM appeals');
  // The dashboard account stores the global name; the platform handle is something else.
  await signInIdentity({
    platform: 'discord',
    platformUserId: STAFF,
    username: 'Alex',
    avatar: null,
    guildIds: [G],
  });
  await signInIdentity({
    platform: 'discord',
    platformUserId: OTHER_STAFF,
    username: 'Alexa',
    avatar: null,
    guildIds: [G],
  });
  appeal('Alex (dashboard)');
  appeal('Alexa (dashboard)');
  appeal('Alex (dashboard)', { id: OTHER_STAFF }); // has an id: only that person's own erasure clears it
  appeal('Dashboard');

  await forget({ id: STAFF, username: 'alex_77', globalName: 'Alex' }, { staff: true });

  assert.deepEqual(deciders(), [null, 'Alexa (dashboard)', 'Alex (dashboard)', 'Dashboard']);
});

test('a member whose handle equals a staff label cannot clear that staff member’s name', async () => {
  db.exec('DELETE FROM appeals');
  await signInIdentity({
    platform: 'discord',
    platformUserId: STAFF,
    username: 'alex',
    avatar: null,
    guildIds: [G],
  });
  appeal('alex (dashboard)');

  // Never had a dashboard account: no name match at all.
  await forget({ id: PLAIN, username: 'alex', globalName: null });
  assert.deepEqual(deciders(), ['alex (dashboard)']);

  // Has a dashboard account (label "alex" too), but no staff access in this server.
  await signInIdentity({
    platform: 'discord',
    platformUserId: MEMBER,
    username: 'alex',
    avatar: null,
    guildIds: [],
  });
  await forget({ id: MEMBER, username: 'alex', globalName: null });
  assert.deepEqual(deciders(), ['alex (dashboard)']);
});
