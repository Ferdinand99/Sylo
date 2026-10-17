// "Release" ends a counting bench early and hands back the role the member lost. It used to
// give the role currently in the settings to anyone named, benched or not: a way to hand out
// that role, and the wrong role after a settings change.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCountingPenalty } from '../src/modules/counting.js';
import { addCountingPenalty, getCountingPenalty } from '../src/db/countingPenalties.js';

const G = '900000000000000801';

function fakeGuild() {
  const added = [];
  const role = (id) => ({ id, editable: true, position: 1 });
  const roles = new Map([
    ['700000000000000001', role('700000000000000001')],
    ['700000000000000002', role('700000000000000002')],
  ]);
  const guild = {
    id: G,
    roles: { cache: roles },
    members: {
      me: { roles: { highest: { comparePositionTo: () => 5 } } },
      fetch: async (id) => ({
        id,
        roles: { cache: new Map(), add: async (r) => added.push([id, r.id]) },
      }),
    },
  };
  return { guild, added };
}

test('releasing someone who is not benched gives nothing', async () => {
  const { guild, added } = fakeGuild();
  assert.equal(await releaseCountingPenalty(guild, '900000000000000811'), false);
  assert.deepEqual(added, []);
});

test('releasing hands back the role stored with the penalty', async () => {
  const { guild, added } = fakeGuild();
  await addCountingPenalty({
    guildId: G,
    userId: '900000000000000812',
    roleId: '700000000000000002',
    restoreAt: Date.now() + 60_000,
  });
  assert.equal(await releaseCountingPenalty(guild, '900000000000000812'), true);
  assert.deepEqual(added, [['900000000000000812', '700000000000000002']]);
  assert.equal(await getCountingPenalty(G, '900000000000000812'), null);
});
