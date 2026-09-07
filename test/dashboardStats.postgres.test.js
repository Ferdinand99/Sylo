// Proves dashboardStats.js against a real Postgres connection. The file owns
// no table of its own — it only reads tables bootstrapped by their owning
// files (infractions, tickets, stats_cache, composed_messages, guild_modules)
// — so this mainly proves the COUNT(*) bigint-string coercion (Number(...))
// actually works against postgres.js, not just better-sqlite3's plain number.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'dashboardStats/moduleUsage against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { dashboardStats, moduleUsage } = await import('../src/db/dashboardStats.js');
    const { addCase } = await import('../src/db/modCases.js');
    const { createTicket } = await import('../src/db/tickets.js');
    const { setCached } = await import('../src/db/cache.js');
    const { createComposed } = await import('../src/db/composedMessages.js');
    const { setGuildModule } = await import('../src/db/modules.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-dashboardstats-${Date.now()}`;

    await t.test('warningsTotal/warningsWeek count infractions with action = warn', async () => {
      const before = await dashboardStats();
      await addCase({ guildId: G, userId: 'u1', moderatorId: 'm1', action: 'warn', reason: 'r' });
      await addCase({ guildId: G, userId: 'u2', moderatorId: 'm1', action: 'warn', reason: 'r' });
      await addCase({ guildId: G, userId: 'u3', moderatorId: 'm1', action: 'ban', reason: 'r' });
      const after = await dashboardStats();
      assert.equal(after.warningsTotal, before.warningsTotal + 2);
      assert.equal(after.warningsWeek, before.warningsWeek + 2);
      assert.equal(typeof after.warningsTotal, 'number');
    });

    await t.test('openTickets/ticketsTotal count tickets', async () => {
      const before = await dashboardStats();
      await createTicket(G, 'u1');
      await createTicket(G, 'u2');
      const after = await dashboardStats();
      assert.equal(after.ticketsTotal, before.ticketsTotal + 2);
      assert.equal(after.openTickets, before.openTickets + 2);
    });

    await t.test('cachedLookups counts stats_cache rows', async () => {
      const before = await dashboardStats();
      await setCached(`k-${G}`, { game: 'g', title: 't', username: 'u', platform: 'p' }, { hi: 1 });
      const after = await dashboardStats();
      assert.equal(after.cachedLookups, before.cachedLookups + 1);
    });

    await t.test('composedTotal counts composed_messages rows', async () => {
      const before = await dashboardStats();
      await createComposed(G, { name: 'n', channelId: 'c1', messageId: null, spec: { content: 'hi' } });
      const after = await dashboardStats();
      assert.equal(after.composedTotal, before.composedTotal + 1);
    });

    await t.test('moduleUsage maps module id to count of guilds with it enabled', async () => {
      const g1 = `${G}-m1`;
      const g2 = `${G}-m2`;
      await setGuildModule(g1, 'afk', { enabled: true });
      await setGuildModule(g2, 'afk', { enabled: true });
      const usage = await moduleUsage();
      assert.ok(usage instanceof Map);
      assert.ok((usage.get('afk') ?? 0) >= 2);
    });
  }
);
