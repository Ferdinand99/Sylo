// Proves the driver shim's Postgres branch for temp_bans (composite natural
// PK + ON CONFLICT upsert) — same assertions as tempBans.test.js, real
// Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'tempBans against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { scheduleTempBan, getTempBan, clearTempBan, guildTempBans, dueTempBans, clearGuildTempBans } =
      await import('../src/db/tempBans.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const G1 = `pgtest-tb-g1-${stamp}`;
    const G2 = `pgtest-tb-g2-${stamp}`;
    const U1 = '800000000000000001';
    const U2 = '800000000000000002';

    await t.test('scheduleTempBan then getTempBan round-trips', async () => {
      const unbanAt = Date.now() + 3_600_000;
      await scheduleTempBan({ guildId: G1, userId: U1, modId: 'mod1', reason: 'spam', unbanAt });

      const row = await getTempBan(G1, U1);
      assert.equal(row.mod_id, 'mod1');
      assert.equal(row.reason, 'spam');
      assert.equal(Number(row.unban_at), unbanAt);
      assert.equal(await getTempBan(G1, 'nobody'), null);
    });

    await t.test('upserts — one row per (guild, user)', async () => {
      await scheduleTempBan({ guildId: G1, userId: U1, modId: 'mod1', reason: 'first', unbanAt: 1 });
      await scheduleTempBan({ guildId: G1, userId: U1, modId: 'mod2', reason: 'second', unbanAt: 2 });

      const rows = await guildTempBans(G1);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, 'second');
    });

    await t.test('dueTempBans, ordering, clear', async () => {
      await clearGuildTempBans(G1);
      await clearGuildTempBans(G2);
      const now = Date.now();
      await scheduleTempBan({ guildId: G1, userId: U1, modId: 'm', reason: 'past', unbanAt: now - 1000 });
      await scheduleTempBan({ guildId: G1, userId: U2, modId: 'm', reason: 'future', unbanAt: now + 60_000 });
      await scheduleTempBan({ guildId: G2, userId: U1, modId: 'm', reason: 'other guild', unbanAt: 1 });

      const due = await dueTempBans(now);
      assert.ok(due.some((r) => r.guild_id === G1 && r.user_id === U1));
      assert.ok(!due.some((r) => r.guild_id === G1 && r.user_id === U2));

      assert.equal(await clearTempBan(G1, U1), 1);
      assert.equal(await clearTempBan(G1, U1), 0);

      await clearGuildTempBans(G1);
      assert.equal((await guildTempBans(G1)).length, 0);
      assert.equal((await guildTempBans(G2)).length, 1);
    });
  }
);
