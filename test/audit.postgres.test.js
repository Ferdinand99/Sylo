// Proves the driver shim's Postgres branch for config_audit — a SERIAL
// surrogate PK (never read back, so no returningId needed), a BIGINT
// created_at, and the non-correlated "keep newest N" prune subquery (same
// table queried a second time in its own scope, not a self-join — see the
// comment in src/db/audit.js for why this one was never actually ambiguous
// the way inviteTracker.js's rank query was).
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'audit log against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { recordAudit, listAudit } = await import('../src/db/audit.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-audit-${Date.now()}`;

    await t.test('recordAudit stores entries, listAudit returns them newest-first', async () => {
      await recordAudit(G, { actor: 'Alice', action: 'module:leveling', detail: 'enabled' });
      await recordAudit(G, { actor: 'Bob', action: 'settings:modlog', detail: '#logs' });

      const rows = await listAudit(G, 10);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].actor, 'Bob');
      assert.equal(rows[1].action, 'module:leveling');
    });

    await t.test('recordAudit prunes to at most 500 rows per guild', async () => {
      const P = `pgtest-audit-prune-${Date.now()}`;
      for (let i = 0; i < 520; i += 1) {
        await recordAudit(P, { actor: 'x', action: 'command:/ping', detail: String(i) });
      }
      const rows = await listAudit(P, 1000);
      assert.ok(rows.length <= 500, `expected <=500 rows, got ${rows.length}`);
    });
  }
);
