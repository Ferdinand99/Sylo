// Proves tempVoice.js against a real Postgres connection.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'tempVoice against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      addTempChannel,
      removeTempChannel,
      getTempChannel,
      isTempChannel,
      listGuildTempChannels,
      findUserHubChannel,
      countHubChannels,
      listAllTempChannels,
      clearGuildTempVoice,
      setTempOwner,
      setTempName,
      setTempLocked,
      setTempHidden,
      setTempBans,
      setTempEmptySince,
    } = await import('../src/db/tempVoice.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-tempvoice-${Date.now()}`;
    // countHubChannels() has no guild scope (a hub id is unique on its own in
    // real usage), so this must be namespaced too — a fixed 'hub-1' across
    // reruns against the same un-wiped database would accumulate rows from
    // earlier runs and make the count assertions below flaky.
    const HUB = `${G}-hub-1`;
    const U = 'owner-1';
    const CH1 = `${G}-ch1`;
    const CH2 = `${G}-ch2`;

    await t.test('track, find by owner+hub, count, and remove', async () => {
      await clearGuildTempVoice(G);
      assert.equal(await isTempChannel(CH1), false);

      await addTempChannel({ channelId: CH1, guildId: G, hubId: HUB, ownerId: U });
      await addTempChannel({ channelId: CH2, guildId: G, hubId: HUB, ownerId: 'owner-2' });

      assert.equal(await isTempChannel(CH1), true);
      assert.equal(await countHubChannels(HUB), 2);
      assert.equal((await findUserHubChannel(G, HUB, U)).channel_id, CH1);
      assert.equal((await listGuildTempChannels(G)).length, 2);
      assert.equal((await listAllTempChannels()).filter((r) => r.guild_id === G).length, 2);

      await removeTempChannel(CH1);
      assert.equal(await isTempChannel(CH1), false);
      assert.equal(await findUserHubChannel(G, HUB, U), null);
      assert.equal(await countHubChannels(HUB), 1);

      await clearGuildTempVoice(G);
      assert.equal(await countHubChannels(HUB), 0);
    });

    await t.test('setters round-trip through getTempChannel, bans dedupe/cap', async () => {
      await addTempChannel({ channelId: CH1, guildId: G, hubId: HUB, ownerId: U, name: 'orig' });

      await setTempOwner(CH1, 'new-owner');
      await setTempName(CH1, 'renamed');
      await setTempLocked(CH1, true);
      await setTempHidden(CH1, true);
      await setTempBans(CH1, ['a', 'b', 'a']);
      const emptyAt = Date.now();
      await setTempEmptySince(CH1, emptyAt);

      const row = await getTempChannel(CH1);
      assert.equal(row.owner_id, 'new-owner');
      assert.equal(row.name, 'renamed');
      assert.equal(row.locked, 1);
      assert.equal(row.hidden, 1);
      assert.deepEqual(row.banList, ['a', 'b']);
      assert.equal(Number(row.empty_since), emptyAt);

      await setTempEmptySince(CH1, null);
      assert.equal((await getTempChannel(CH1)).empty_since, null);
    });
  }
);
