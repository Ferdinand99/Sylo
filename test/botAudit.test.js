import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordBotAudit, listBotAudit } from '../src/db/botAudit.js';
import { db } from '../src/db/index.js';

test('recordBotAudit stores entries, listBotAudit returns them newest-first', async () => {
  await recordBotAudit({ actor: 'Alice', action: 'personalizer:identity', detail: 'username' });
  await recordBotAudit({ actor: 'Bob', action: 'personalizer:announcement', detail: 'Heads up' });

  const rows = await listBotAudit(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, 'Bob'); // most recent first
  assert.equal(rows[1].action, 'personalizer:identity');
});

test('recordBotAudit prunes to at most 500 rows', async () => {
  for (let i = 0; i < 520; i += 1) {
    await recordBotAudit({ actor: 'x', action: 'personalizer:presence', detail: String(i) });
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM bot_audit').get().n;
  assert.ok(n <= 500, `expected <=500 rows, got ${n}`);
});
