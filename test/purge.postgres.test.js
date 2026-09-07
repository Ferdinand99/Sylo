// Proves purge.js against a real Postgres connection. purgeGuild/forgetUser
// used to run inside a db.transaction() (better-sqlite3 only); this proves
// the plain-sequence-of-awaited-DELETEs redesign (see the Phase 22 note in
// docs/roadmap.md) still removes everything it should and nothing it
// shouldn't when run for real, not just against SQLite.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'purge (purgeGuild/forgetUser/describeUserData/exportUserData) against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { purgeGuild, forgetUser, describeUserData, exportUserData } = await import('../src/db/purge.js');
    const { setModlogChannel } = await import('../src/db/guildSettings.js');
    const { addCase } = await import('../src/db/modCases.js');
    const { addXp } = await import('../src/db/leveling.js');
    const { createTicket, addTicketMessage } = await import('../src/db/tickets.js');
    const { setAfk } = await import('../src/db/afk.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-purge-${Date.now()}`;
    const OTHER = `${G}-other`;
    const U = `u-${Date.now()}`;

    async function seed(guildId, userId) {
      await setModlogChannel(guildId, '9');
      await addCase({ guildId, userId, moderatorId: 'mod', action: 'warn', reason: 'x' });
      await addXp(guildId, userId, 500, Date.now(), { voice: false });
      const ticket = await createTicket(guildId, userId);
      await addTicketMessage(ticket.id, { authorId: userId, authorKind: 'user', content: 'hi' });
      await setAfk(guildId, userId, { reason: 'brb' });
    }

    await t.test('purgeGuild removes every guild-scoped row and leaves other guilds alone', async () => {
      await seed(G, U);
      await seed(OTHER, U);

      await purgeGuild(G);

      const after = await describeUserData(G, U);
      assert.equal(after.total, 0, 'purged guild has nothing left');

      const otherAfter = await describeUserData(OTHER, U);
      assert.ok(otherAfter.total > 0, 'other guild untouched');
    });

    await t.test('forgetUser deletes only that member, describeUserData/exportUserData agree', async () => {
      const g = `${G}-forget`;
      const KEEP = `${U}-keep`;
      await seed(g, U);
      await seed(g, KEEP);

      const before = await describeUserData(g, U);
      assert.ok(before.total > 0);

      const dump = await exportUserData(g, U);
      assert.equal(dump.data.warnings.length, 1);
      assert.equal(dump.data.warnings[0].reason, 'x');

      const result = await forgetUser(g, U);
      assert.equal(result.warnings, 1);
      // addXp() writes one `leveling` row plus one `leveling_periods` row per
      // period (week + month) — forgetUser's count is the sum of both deletes.
      assert.equal(result.leveling, 3);
      assert.equal(result.tickets, 1);
      assert.equal(result.afk, 1);

      assert.equal((await describeUserData(g, U)).total, 0, 'nothing left after forgetUser');
      assert.ok((await describeUserData(g, KEEP)).total > 0, 'other member kept');
    });
  }
);
