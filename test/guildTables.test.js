import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { GUILD_TABLES } from '../src/db/purge.js';

test('every guild_id-keyed table is listed in GUILD_TABLES', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  const guildScoped = tables.filter((t) =>
    db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .some((c) => c.name === 'guild_id')
  );

  const missing = guildScoped.filter((t) => !GUILD_TABLES.includes(t));
  assert.deepEqual(
    missing,
    [],
    `these tables have a guild_id column but are not in GUILD_TABLES (src/db/purge.js): ${missing.join(', ')}`
  );

  // And nothing stale in the list.
  const stale = GUILD_TABLES.filter((t) => !tables.includes(t));
  assert.deepEqual(stale, [], `GUILD_TABLES lists tables that no longer exist: ${stale.join(', ')}`);
});
