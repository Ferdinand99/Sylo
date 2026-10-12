// Until accounts can be linked across platforms, an operator (OWNER_IDS) who signs in with
// Discord can also manage every guild on a platform that has no login of its own (Fluxer).
// Everyone else, and every Discord guild, keeps the existing rule: the session's own admin
// guilds, intersected with the guilds the bot is in.
process.env.DISCORD_CLIENT_SECRET = 'test-secret';
process.env.OWNER_IDS = '151630595649175552';

import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { adminGuildIds, manageableGuilds } = await import('../src/web/middleware/auth.js');
const { runtime } = await import('../src/runtime.js');

const D1 = '900000000000000101';
const D2 = '900000000000000102';
const F1 = '900000000000000103';
const OPERATOR = '151630595649175552';

const guild = (id, name) => ({ id, name, iconURL: () => null });
const reqFor = (userId, guilds = []) => ({ session: { user: { id: userId }, guilds } });

test.beforeEach(() => {
  runtime.clients.discord = {
    guilds: {
      cache: new Map([
        [D1, guild(D1, 'D1')],
        [D2, guild(D2, 'D2')],
      ]),
    },
  };
  const fluxer = {};
  fluxer.guilds = { cache: new Map([[F1, { ...guild(F1, 'F1'), client: fluxer }]]) }; // a guild knows its client
  runtime.clients.fluxer = fluxer;
});
test.afterEach(() => {
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

test('an operator gets their own Discord admin guilds plus every Fluxer guild', () => {
  const ids = adminGuildIds(reqFor(OPERATOR, [D1]));
  assert.deepEqual([...ids].sort(), [D1, `fluxer:${F1}`].sort());
});

test('an operator is not handed Discord guilds they do not manage', () => {
  assert.equal(adminGuildIds(reqFor(OPERATOR, [D1])).has(D2), false);
});

test('anyone else sees only their own admin guilds, and never a Fluxer guild', () => {
  const ids = adminGuildIds(reqFor('222222222222222222', [D2]));
  assert.deepEqual([...ids], [D2]);
});

test('the server switcher lists the Fluxer guild for an operator, by key', () => {
  const list = manageableGuilds(reqFor(OPERATOR, [D1]));
  assert.deepEqual(list.map((g) => g.id).sort(), [D1, `fluxer:${F1}`].sort());
});

test('a session that has not loaded yet (no user) gets nothing', () => {
  assert.deepEqual([...adminGuildIds({ session: {} })], []);
});
