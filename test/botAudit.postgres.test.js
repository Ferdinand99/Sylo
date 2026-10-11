// Proves the driver shim's Postgres branch for bot_audit — same shape as
// config_audit.postgres.test.js, minus the guild_id column/scoping.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'bot audit log against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { recordBotAudit, listBotAudit } = await import('../src/db/botAudit.js');

    t.after(async () => {
      await closePostgres();
    });

    await t.test('recordBotAudit stores entries, listBotAudit returns them newest-first', async () => {
      await recordBotAudit({ actor: 'Alice', action: 'personalizer:identity', detail: 'username' });
      await recordBotAudit({ actor: 'Bob', action: 'personalizer:announcement', detail: 'Heads up' });

      const rows = await listBotAudit(10);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].actor, 'Bob');
      assert.equal(rows[1].action, 'personalizer:identity');
    });

    await t.test('recordBotAudit prunes to at most 500 rows', async () => {
      for (let i = 0; i < 520; i += 1) {
        await recordBotAudit({ actor: 'x', action: 'personalizer:presence', detail: String(i) });
      }
      const rows = await listBotAudit(1000);
      assert.ok(rows.length <= 500, `expected <=500 rows, got ${rows.length}`);
    });
  }
);
