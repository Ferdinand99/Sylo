import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAudit, listAudit } from '../src/db/audit.js';
import { db } from '../src/db/index.js';
import { listAuditActions, listAuditPage } from '../src/db/audit.js';

const G = '900000000000000001';

test('recordAudit stores entries, listAudit returns them newest-first', async () => {
  await recordAudit(G, { actor: 'Alice', action: 'module:leveling', detail: 'enabled' });
  await recordAudit(G, { actor: 'Bob', action: 'settings:modlog', detail: '#logs' });

  const rows = await listAudit(G, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, 'Bob'); // most recent first
  assert.equal(rows[1].action, 'module:leveling');
});

test('recordAudit prunes to at most 500 rows per guild', async () => {
  const P = '900000000000000002';
  for (let i = 0; i < 520; i += 1) {
    await recordAudit(P, { actor: 'x', action: 'command:/ping', detail: String(i) });
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?').get(P).n;
  assert.ok(n <= 500, `expected <=500 rows, got ${n}`);
});

test('listAuditPage pages newest first by the id of the last row, and is scoped to one server', async () => {
  const A = '900000000000000010';
  const B = '900000000000000011';
  for (let i = 1; i <= 7; i += 1) {
    await recordAudit(A, {
      actor: 'x',
      action: i % 2 ? 'module:polls' : 'economy:adjust',
      detail: String(i),
    });
  }
  await recordAudit(B, { actor: 'y', action: 'module:polls', detail: 'other server' });

  const first = await listAuditPage(A, { limit: 3 });
  assert.deepEqual(
    first.rows.map((r) => r.detail),
    ['7', '6', '5']
  );
  assert.equal(first.hasMore, true);
  const second = await listAuditPage(A, { limit: 3, before: first.rows.at(-1).id });
  assert.deepEqual(
    second.rows.map((r) => r.detail),
    ['4', '3', '2']
  );
  const third = await listAuditPage(A, { limit: 3, before: second.rows.at(-1).id });
  assert.deepEqual(
    third.rows.map((r) => r.detail),
    ['1']
  );
  assert.equal(third.hasMore, false);

  const polls = await listAuditPage(A, { limit: 10, action: 'module:polls' });
  assert.deepEqual(
    polls.rows.map((r) => r.detail),
    ['7', '5', '3', '1']
  );
  assert.ok(
    polls.rows.every((r) => r.guild_id === A),
    'never another server'
  );
  assert.deepEqual(await listAuditActions(A), [
    { action: 'module:polls', count: 4 },
    { action: 'economy:adjust', count: 3 },
  ]);
  assert.deepEqual(await listAuditActions('900000000000000099'), []);
});

test('listAuditPage orders by the id, the same thing its cursor compares, so a skewed clock cannot skip or repeat a row', async () => {
  const S = '900000000000000013';
  // created_at runs against the id (a clock that stepped back, or imported rows)
  const times = [5000, 1000, 4000, 2000, 3000];
  for (let i = 0; i < times.length; i += 1) {
    await db
      .prepare(
        'INSERT INTO config_audit (guild_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(S, 'x', 'module:polls', String(i + 1), times[i]);
  }
  const seen = [];
  let before = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await listAuditPage(S, { limit: 2, before });
    if (!page.rows.length) break;
    seen.push(...page.rows.map((r) => r.detail));
    before = page.rows.at(-1).id;
  }
  assert.deepEqual(seen, ['5', '4', '3', '2', '1'], 'every row once, newest id first');
});

test('listAuditPage caps the page size and survives odd input', async () => {
  const C = '900000000000000012';
  for (let i = 0; i < 130; i += 1)
    await recordAudit(C, { actor: 'x', action: 'module:polls', detail: String(i) });
  assert.equal((await listAuditPage(C, { limit: 100000 })).rows.length, 100, 'at most 100 rows a page');
  assert.equal((await listAuditPage(C, { limit: 0 })).rows.length, 50, 'no size means the default');
  assert.equal((await listAuditPage(C, { limit: -5, before: 'nonsense' })).rows.length, 1);
  assert.equal(
    (await listAuditPage(C, { before: 1e30 })).rows.length,
    50,
    'a huge cursor is clamped, not an error'
  );
});
