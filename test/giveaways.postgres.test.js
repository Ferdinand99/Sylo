// Proves the driver shim's Postgres branch for giveaways + giveaway_entries: a
// SERIAL surrogate PK on giveaways (read back via RETURNING id), a composite
// natural PK on giveaway_entries, and `INSERT ... ON CONFLICT DO NOTHING`
// (rewritten from SQLite's `INSERT OR IGNORE`, same pattern as postedKeys.js).
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'giveaways against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      createGiveaway,
      getGiveaway,
      setGiveawayMessage,
      addGiveawayEntry,
      removeGiveawayEntry,
      hasGiveawayEntry,
      giveawayEntryCount,
      giveawayEntrantIds,
      markGiveawayEnded,
      activeGiveaways,
      endedGiveaways,
      dueGiveaways,
      clearGuildGiveaways,
    } = await import('../src/db/giveaways.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-giveaways-${Date.now()}`;

    await t.test('createGiveaway returns a real id via RETURNING id; lifecycle round-trips', async () => {
      const { id } = await createGiveaway({
        guildId: G,
        channelId: '111',
        prize: 'Nitro',
        winners: 2,
        hostId: '222',
        endsAt: Date.now() + 60_000,
      });
      assert.ok(Number.isInteger(id) && id > 0);
      await setGiveawayMessage(id, '333');
      assert.equal((await getGiveaway(id)).message_id, '333');

      await addGiveawayEntry(id, 'u1');
      await addGiveawayEntry(id, 'u2');
      await addGiveawayEntry(id, 'u2'); // dupe — ON CONFLICT DO NOTHING must not throw
      assert.equal(await giveawayEntryCount(id), 2);
      assert.ok(await hasGiveawayEntry(id, 'u1'));
      await removeGiveawayEntry(id, 'u1');
      assert.equal(await hasGiveawayEntry(id, 'u1'), false);
      assert.deepEqual((await giveawayEntrantIds(id)).sort(), ['u2']);

      assert.equal((await activeGiveaways(G)).length, 1);
      await markGiveawayEnded(id, ['u2']);
      const g = await getGiveaway(id);
      assert.equal(g.ended, true);
      assert.deepEqual(g.wonIds, ['u2']);
      assert.equal((await activeGiveaways(G)).length, 0);
      assert.equal((await endedGiveaways(G)).length, 1);
    });

    await t.test(
      'dueGiveaways filters by ends_at + ended; clearGuildGiveaways wipes both tables',
      async () => {
        const past = await createGiveaway({
          guildId: G,
          channelId: '1',
          prize: 'p',
          winners: 1,
          hostId: 'h',
          endsAt: Date.now() - 1000,
        });
        const future = await createGiveaway({
          guildId: G,
          channelId: '1',
          prize: 'f',
          winners: 1,
          hostId: 'h',
          endsAt: Date.now() + 60_000,
        });
        const due = (await dueGiveaways(Date.now())).map((r) => r.id);
        assert.ok(due.includes(past.id));
        assert.ok(!due.includes(future.id));

        await clearGuildGiveaways(G);
        assert.equal((await activeGiveaways(G)).length, 0);
        assert.equal(await getGiveaway(past.id), null);
      }
    );
  }
);
