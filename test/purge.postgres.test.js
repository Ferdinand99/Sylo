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

    await t.test(
      'forgetUser takes the member off polls, giveaways, voice channels and staff columns',
      async () => {
        const { createPoll } = await import('../src/db/polls.js');
        const { createGiveaway } = await import('../src/db/giveaways.js');
        const { addTempChannel } = await import('../src/db/tempVoice.js');
        const { scheduleVerificationKick } = await import('../src/db/verificationKicks.js');
        const { createAppeal, decideAppeal } = await import('../src/db/appeals.js');
        const { closeTicket } = await import('../src/db/tickets.js');
        const g = `${G}-owned`;
        const other = `o-${Date.now()}`;

        await createPoll({
          messageId: `m-${g}`,
          guildId: g,
          channelId: '9',
          question: 'q?',
          options: ['a', 'b'],
          createdBy: U,
        });
        await createGiveaway({
          guildId: g,
          channelId: '9',
          prize: 'p',
          hostId: U,
          endsAt: Date.now() + 1000,
        });
        await addTempChannel({ channelId: `vc-${g}`, guildId: g, hubId: 'hub', ownerId: U });
        await scheduleVerificationKick({ guildId: g, userId: U, dueAt: Date.now() + 1000 });
        const ticket = await createTicket(g, other);
        await closeTicket(ticket.id, U);
        const appealId = await createAppeal(g, { userId: other, answers: [] });
        await decideAppeal(g, appealId, { status: 'denied', decidedBy: U, reason: 'no' });

        const before = Object.fromEntries((await describeUserData(g, U)).items.map((i) => [i.key, i.count]));
        for (const key of [
          'pollsCreated',
          'giveawaysHosted',
          'tempVoiceOwned',
          'verificationKicks',
          'ticketsClosed',
          'appealsDecided',
        ]) {
          assert.equal(before[key], 1, key);
        }

        const result = await forgetUser(g, U);
        assert.equal(result.pollsCreated, 1);
        assert.equal(result.giveawaysHosted, 1);
        assert.equal(result.tempVoiceOwned, 1);
        assert.equal(result.verificationKicks, 1);
        assert.equal(result.ticketsClosed, 1);
        assert.equal(result.appealsDecided, 1);
        assert.equal((await describeUserData(g, U)).erasable, 0);
        await purgeGuild(g);
      }
    );

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
      // Moderation cases are safety records: kept, and reported as kept.
      assert.equal(result.keptCases, 1);
      // addXp() writes one `leveling` row plus one `leveling_periods` row per
      // period (week + month) — forgetUser's count is the sum of both deletes.
      assert.equal(result.leveling, 3);
      assert.equal(result.tickets, 1);
      assert.equal(result.afk, 1);

      const after = await describeUserData(g, U);
      assert.equal(after.erasable, 0, 'nothing erasable left after forgetUser');
      assert.equal(after.items.find((i) => i.key === 'warnings').count, 1, 'the case is kept');
      assert.ok((await describeUserData(g, KEEP)).total > 0, 'other member kept');
    });
  }
);
