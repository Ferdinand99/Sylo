import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAudit, listAudit } from '../src/db/audit.js';
import { db } from '../src/db/index.js';

const G = '900000000000000001';

test('recordAudit stores entries, listAudit returns them newest-first', () => {
  recordAudit(G, { actor: 'Alice', action: 'module:leveling', detail: 'enabled' });
  recordAudit(G, { actor: 'Bob', action: 'settings:modlog', detail: '#logs' });

  const rows = listAudit(G, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, 'Bob'); // most recent first
  assert.equal(rows[1].action, 'module:leveling');
});

test('recordAudit prunes to at most 500 rows per guild', () => {
  const P = '900000000000000002';
  for (let i = 0; i < 520; i += 1) recordAudit(P, { actor: 'x', action: 'command:/ping', detail: String(i) });
  const n = db.prepare('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?').get(P).n;
  assert.ok(n <= 500, `expected <=500 rows, got ${n}`);
});
