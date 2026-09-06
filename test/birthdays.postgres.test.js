// Proves the driver shim's Postgres branch for the birthdays table — same
// assertions as birthdays.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'birthdays against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { setBirthday, getBirthday, removeBirthday, guildBirthdays, birthdaysOnDay, clearGuildBirthdays } =
      await import('../src/db/birthdays.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-bday-${Date.now()}`;
    const U1 = '800000000000000201';
    const U2 = '800000000000000202';

    await t.test('set (upsert), get, list order, remove', async () => {
      await setBirthday({ guildId: G, userId: U1, month: 12, day: 25 });
      await setBirthday({ guildId: G, userId: U2, month: 3, day: 4, year: 2000 });

      const before = await getBirthday(G, U1);
      assert.equal(before.month, 12);
      assert.equal(before.year, null);

      // upsert — same user, new date, still one row
      await setBirthday({ guildId: G, userId: U1, month: 1, day: 2 });
      const u1 = await getBirthday(G, U1);
      assert.equal(u1.month, 1);
      assert.equal(u1.day, 2);

      assert.deepEqual(
        (await guildBirthdays(G)).map((r) => `${r.month}/${r.day}`),
        ['1/2', '3/4']
      );

      assert.equal(await removeBirthday(G, U1), 1);
      assert.equal(await removeBirthday(G, U1), 0);
      assert.equal(await getBirthday(G, U1), null);
    });

    await t.test('birthdaysOnDay filters by guild + date', async () => {
      await clearGuildBirthdays(G);
      await setBirthday({ guildId: G, userId: U1, month: 7, day: 4 });
      await setBirthday({ guildId: G, userId: U2, month: 7, day: 4, year: 1999 });

      assert.deepEqual((await birthdaysOnDay(G, 7, 4)).map((r) => r.user_id).sort(), [U1, U2].sort());
      assert.equal((await birthdaysOnDay('other-guild', 7, 4)).length, 0);
    });
  }
);
