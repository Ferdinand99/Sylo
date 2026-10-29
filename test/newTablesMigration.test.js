// Migrations 58 and 59 on a database that already ran 57: events may lose their host, and each
// server's suggestion counter starts at the highest number in use.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/index.js';

test('migrations 58 and 59 keep existing events and suggestions and add the new shape', () => {
  assert.ok(MIGRATIONS.length >= 59);
  const d = new Database(':memory:');
  for (let i = 0; i < 57; i += 1) MIGRATIONS[i](d);

  const ins = d.prepare(
    `INSERT INTO guild_events (guild_id, channel_id, title, start_at, host_id, created_at) VALUES (?, 'c', ?, 1, ?, 1)`
  );
  ins.run('g1', 'first', 'h1');
  ins.run('g1', 'second', 'h2');
  d.prepare('DELETE FROM guild_events WHERE title = ?').run('second'); // id 2 was used and is gone
  d.prepare(`INSERT INTO guild_event_participants VALUES (1, 'u', 'join', 5)`).run();
  const sug = d.prepare(
    `INSERT INTO guild_suggestions (guild_id, number, channel_id, body, created_at) VALUES (?, ?, 'c', 'x', 1)`
  );
  sug.run('g1', 1);
  sug.run('g1', 2);
  sug.run('g2', 1);

  MIGRATIONS[57](d);
  MIGRATIONS[58](d);

  const host = d.prepare(
    "SELECT \"notnull\" AS nn FROM pragma_table_info('guild_events') WHERE name = 'host_id'"
  );
  assert.equal(host.get().nn, 0, 'host_id accepts NULL');
  const row = d.prepare('SELECT * FROM guild_events').all();
  assert.deepEqual(
    row.map((r) => [r.id, r.title, r.host_id]),
    [[1, 'first', 'h1']]
  );
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM guild_event_participants').get().n, 1);
  d.prepare('UPDATE guild_events SET host_id = NULL WHERE id = 1').run();
  const next = d
    .prepare(
      `INSERT INTO guild_events (guild_id, channel_id, title, start_at, host_id, created_at) VALUES ('g1', 'c', 't', 1, 'h', 1)`
    )
    .run();
  assert.equal(Number(next.lastInsertRowid), 3, 'ids of deleted events are not reused');
  const idx = d.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_guild_events_guild'"
  );
  assert.ok(idx.get(), 'the index is back');

  const counters = d
    .prepare('SELECT guild_id, last_number FROM guild_suggestion_counters ORDER BY guild_id')
    .all();
  assert.deepEqual(counters, [
    { guild_id: 'g1', last_number: 2 },
    { guild_id: 'g2', last_number: 1 },
  ]);
  d.close();
});
