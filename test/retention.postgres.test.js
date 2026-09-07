// Proves retention.js against a real Postgres connection. sweepRetention used
// to run inside a db.transaction() (better-sqlite3 only); this proves the
// plain-sequence-of-awaited-DELETEs redesign still prunes only what's past
// its guild's cutoff when run for real, not just against SQLite.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

test(
  'sweepRetention against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { sweepRetention } = await import('../src/db/retention.js');
    const { setGuildModule } = await import('../src/db/modules.js');
    const { createTicket, closeTicket, addTicketMessage, getTicket } = await import('../src/db/tickets.js');
    const { addCase, getCase } = await import('../src/db/modCases.js');
    const { prepare } = await import('../src/db/driver.js');

    t.after(async () => {
      await closePostgres();
    });

    // sweepRetention derives its cutoff from `now - days`, so backdate rows
    // by writing created_at/closed_at/last_at directly rather than depending
    // on wall-clock time passing during the test.
    const backdateTicket = prepare(
      'UPDATE tickets SET created_at = @at, last_at = @at, closed_at = @at WHERE id = @id'
    );
    const backdateCase = prepare(
      'UPDATE infractions SET created_at = @at WHERE guild_id = @g AND case_number = @n'
    );

    const G = `pgtest-retention-${Date.now()}`;
    const now = Date.now();

    await t.test('prunes only past-cutoff closed tickets and inactive cases', async () => {
      await setGuildModule(G, 'tickets', { enabled: true, config: { transcriptRetentionDays: 30 } });
      await setGuildModule(G, 'moderation', { enabled: true, config: { infractionRetentionDays: 30 } });

      const oldClosed = await createTicket(G, 'u1');
      await addTicketMessage(oldClosed.id, { authorId: 'u1', authorKind: 'user', content: 'hi' });
      await closeTicket(oldClosed.id, 'staff1');
      await backdateTicket.run({ at: now - 60 * DAY, id: oldClosed.id });

      const recentClosed = await createTicket(G, 'u2');
      await closeTicket(recentClosed.id, 'staff1');
      await backdateTicket.run({ at: now - 5 * DAY, id: recentClosed.id });

      const { caseNumber } = await addCase({
        guildId: G,
        userId: 'u1',
        moderatorId: 'mod',
        action: 'warn',
        reason: 'x',
      });
      await backdateCase.run({ at: now - 60 * DAY, g: G, n: caseNumber });
      const setInactiveStmt = prepare(
        'UPDATE infractions SET active = 0 WHERE guild_id = ? AND case_number = ?'
      );
      await setInactiveStmt.run(G, caseNumber);

      const r = await sweepRetention(now);
      assert.ok(r.closedTickets >= 1);
      assert.ok(r.inactiveCases >= 1);

      assert.equal(await getTicket(oldClosed.id), undefined);
      assert.ok(await getTicket(recentClosed.id), 'recent closed ticket kept');
      assert.equal(await getCase(G, caseNumber), null, 'old inactive case pruned');
    });

    await t.test('is a no-op the second time nothing is left to prune', async () => {
      const r = await sweepRetention(now);
      assert.equal(r.closedTickets, 0);
      assert.equal(r.inactiveCases, 0);
    });
  }
);
