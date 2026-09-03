import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/index.js';

const hasTable = (d, t) =>
  d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) != null;

test('migration 35 folds `warnings` into numbered `infractions` cases per guild', () => {
  const d = new Database(':memory:');
  let seeded = false;

  for (const migration of MIGRATIONS) {
    // Seed the flat warnings table the moment it exists, before `infractions`.
    if (!seeded && hasTable(d, 'warnings') && !hasTable(d, 'infractions')) {
      const ins = d.prepare(
        'INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?,?,?,?,?)'
      );
      ins.run('g1', 'u1', 'm', 'first', 100);
      ins.run('g1', 'u1', 'm', 'second', 200);
      ins.run('g1', 'u2', 'm', 'third', 300);
      ins.run('g2', 'u1', 'm', 'other guild', 150);
      seeded = true;
    }
    migration(d);
  }

  assert.ok(seeded, 'the warnings table existed at some point');
  assert.equal(hasTable(d, 'warnings'), false, 'warnings dropped');
  assert.ok(hasTable(d, 'infractions'));

  const g1 = d
    .prepare(
      "SELECT case_number, user_id, reason FROM infractions WHERE guild_id = 'g1' ORDER BY case_number"
    )
    .all();
  assert.deepEqual(
    g1.map((r) => [r.case_number, r.user_id, r.reason]),
    [
      [1, 'u1', 'first'],
      [2, 'u1', 'second'],
      [3, 'u2', 'third'],
    ]
  );
  const g2 = d.prepare("SELECT case_number, reason FROM infractions WHERE guild_id = 'g2'").all();
  assert.deepEqual(g2, [{ case_number: 1, reason: 'other guild' }]); // its own sequence

  assert.equal(d.prepare('SELECT DISTINCT action FROM infractions').get().action, 'warn');
  d.close();
});
