import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCountingPenalty,
  getCountingPenalty,
  clearCountingPenalty,
  listCountingPenalties,
  dueCountingPenalties,
  clearGuildCountingPenalties,
} from '../src/db/countingPenalties.js';

const G = '900000000000000040';
const G2 = '900000000000000041';
const U1 = '800000000000000401';
const U2 = '800000000000000402';
const ROLE = '700000000000000001';

test('addCountingPenalty stores a row, getCountingPenalty reads it back', async () => {
  const restoreAt = Date.now() + 60_000;
  await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt });
  const row = await getCountingPenalty(G, U1);
  assert.equal(row.guild_id, G);
  assert.equal(row.user_id, U1);
  assert.equal(row.role_id, ROLE);
  assert.equal(row.restore_at, restoreAt);
});

test('getCountingPenalty returns null when there is no row', async () => {
  assert.equal(await getCountingPenalty(G, 'nobody'), null);
});

test('a second penalty for the same member overwrites (pushes restore_at out)', async () => {
  await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 1000 });
  await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 5000 });
  const row = await getCountingPenalty(G, U1);
  assert.equal(row.restore_at, 5000);
  assert.equal((await listCountingPenalties(G)).length, 1);
});

test('dueCountingPenalties returns only rows whose restore_at has passed', async () => {
  await clearGuildCountingPenalties(G);
  await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 1000 });
  await addCountingPenalty({ guildId: G, userId: U2, roleId: ROLE, restoreAt: 9_999_999_999_999 });

  const due = await dueCountingPenalties(2000);
  assert.deepEqual(
    due.map((r) => r.user_id),
    [U1]
  );
});

test('clearCountingPenalty removes one member; listCountingPenalties is guild-scoped', async () => {
  await clearGuildCountingPenalties(G);
  await clearGuildCountingPenalties(G2);
  await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 1000 });
  await addCountingPenalty({ guildId: G, userId: U2, roleId: ROLE, restoreAt: 2000 });
  await addCountingPenalty({ guildId: G2, userId: U1, roleId: ROLE, restoreAt: 3000 });

  await clearCountingPenalty(G, U1);
  assert.equal(await getCountingPenalty(G, U1), null);

  const left = await listCountingPenalties(G);
  assert.deepEqual(
    left.map((r) => r.user_id),
    [U2]
  );
  assert.equal((await listCountingPenalties(G2)).length, 1); // untouched
});

test('clearGuildCountingPenalties drops every row for that guild only', async () => {
  await clearGuildCountingPenalties(G);
  await clearGuildCountingPenalties(G2);
  await addCountingPenalty({ guildId: G, userId: U1, roleId: ROLE, restoreAt: 1000 });
  await addCountingPenalty({ guildId: G2, userId: U1, roleId: ROLE, restoreAt: 1000 });

  await clearGuildCountingPenalties(G);
  assert.equal((await listCountingPenalties(G)).length, 0);
  assert.equal((await listCountingPenalties(G2)).length, 1);
});
