// A database made by the 5.0 release (before the Economy, introductions and suggestion-log changes of
// this branch) must still boot with this code, and end up with the schema of a fresh install. CI
// otherwise only ever starts from an empty database, where every CREATE TABLE already has the new
// columns and a bootstrap statement that uses a column an older table lacks goes unnoticed.
//
// SQLite: the first 63 migrations (what 5.0 ran) are applied to a file, then the code boots on it.
// Postgres: a database is booted fresh, taken back to the 5.0 shape (the tables and columns this
// branch added removed, the migration record set to 63) and booted again.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/index.js';

const BOOT = fileURLToPath(new URL('./helpers/bootDb.mjs', import.meta.url));
const RELEASE_5_0_MIGRATIONS = 63;
// The giveaways columns of the 5.0 release: after BACK_TO_5_0 the table must have exactly these, so a column
// added later and forgotten in the drop list is caught here and not skipped silently.
const GIVEAWAYS_5_0 = [
  'channel_id',
  'created_at',
  'ended',
  'ends_at',
  'guild_id',
  'host_id',
  'id',
  'message_id',
  'prize',
  'required_role_id',
  'winners',
  'won_ids',
];
const url = process.env.DATABASE_URL;

function boot(env) {
  const run = spawnSync(process.execPath, [BOOT], {
    env: { ...process.env, DATABASE_URL: '', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(run.status, 0, `the database did not boot:\n${run.stderr}\n${run.stdout}`.slice(0, 4000));
}

// --- SQLite ---------------------------------------------------------------------------------------------------

function sqliteShape(file) {
  const db = new Database(file, { readonly: true });
  const shape = {};
  const objects = db
    .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  for (const o of objects) {
    shape[`${o.type} ${o.name}`] =
      o.type === 'table'
        ? db
            .prepare(`PRAGMA table_info(${o.name})`)
            .all()
            .map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value} ${c.pk}`)
            .sort()
        : o.tbl_name;
  }
  const version = db.pragma('user_version', { simple: true });
  db.close();
  return { shape, version };
}

test('SQLite: a database from the 5.0 release boots with this code and gets the schema of a fresh install', () => {
  assert.ok(MIGRATIONS.length > RELEASE_5_0_MIGRATIONS, 'there are migrations after 5.0');
  const dir = mkdtempSync(join(tmpdir(), 'sylo-upgrade-'));
  try {
    const old = join(dir, 'old.db');
    const db = new Database(old);
    for (let v = 0; v < RELEASE_5_0_MIGRATIONS; v += 1) {
      db.transaction(() => MIGRATIONS[v](db))();
    }
    db.pragma(`user_version = ${RELEASE_5_0_MIGRATIONS}`);
    db.close();

    boot({ DATABASE_PATH: old });
    const fresh = join(dir, 'fresh.db');
    boot({ DATABASE_PATH: fresh });
    const upgraded = sqliteShape(old);
    const clean = sqliteShape(fresh);
    assert.equal(upgraded.version, MIGRATIONS.length);
    assert.deepEqual(upgraded.shape, clean.shape);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite: a database that already ran the branch up to migration 69 is backfilled by 70', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sylo-upgrade-'));
  try {
    const old = join(dir, 'old.db');
    const db = new Database(old);
    for (let v = 0; v < 69; v += 1) db.transaction(() => MIGRATIONS[v](db))();
    db.pragma('user_version = 69');
    const insert = db.prepare(
      "INSERT INTO giveaways (guild_id, channel_id, prize, winners, host_id, ends_at, ended, won_ids, created_at, prize_amount) VALUES ('g', 'c', 'p', 1, 'h', 1, ?, '[]', 1, 50)"
    );
    db.exec(
      "INSERT INTO economy_inventory (guild_id, user_id, item_id, item_name, item_type, role_id, price_paid, source, status, created_at, updated_at) VALUES ('g', 'u', 1, 'x', 'temp_role', 'r', 10, 'purchase', 'active', 1, 1), ('g', 'u', 2, 'y', 'custom', NULL, 10, 'purchase', 'active', 1, 1)"
    );
    insert.run(1); // already drawn under the earlier code: its prizes were paid without a giveaway_prizes row
    insert.run(0); // still running
    db.close();
    boot({ DATABASE_PATH: old });
    const after = new Database(old, { readonly: true });
    const paid = after.prepare('SELECT ended, prizes_paid FROM giveaways ORDER BY id').all();
    const added = after.prepare('SELECT item_type, added_ms FROM economy_inventory ORDER BY id').all();
    after.close();
    assert.deepEqual(
      paid.map((r) => ({ ...r })),
      [
        { ended: 1, prizes_paid: 1 },
        { ended: 0, prizes_paid: 0 },
      ],
      'a drawn giveaway counts as paid, so the sweep does not pay its winners again'
    );
    assert.deepEqual(
      added.map((r) => ({ ...r })),
      [
        { item_type: 'temp_role', added_ms: -1 },
        { item_type: 'custom', added_ms: 0 },
      ],
      'a temporary-role purchase from before the column has an unknown added time'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Postgres -------------------------------------------------------------------------------------------------

// What this branch added to the 5.0 schema (tables and columns; their indexes go with them).
const BACK_TO_5_0 = `
  DROP TABLE IF EXISTS economy_accounts, economy_transactions, economy_cooldowns, economy_items,
    economy_inventory, introductions, giveaway_prizes, applications_forms, applications_submissions,
    applications_cooldowns;
  -- An earlier shape of one new table (only its first columns), so the upgrade has to add the rest before
  -- the indexes that use them: a bootstrap that indexes a column the old table lacks would not boot.
  CREATE TABLE applications_submissions (
    id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, form_id BIGINT NOT NULL, user_id TEXT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  );
  INSERT INTO applications_submissions (guild_id, form_id, user_id, created_at, updated_at) VALUES ('g', 1, 'u', 1, 1);
  ALTER TABLE giveaways DROP COLUMN IF EXISTS entry_fee, DROP COLUMN IF EXISTS prize_amount,
    DROP COLUMN IF EXISTS cancelled, DROP COLUMN IF EXISTS prizes_paid,
    DROP COLUMN IF EXISTS drawn_at, DROP COLUMN IF EXISTS sweep_at;
  ALTER TABLE giveaway_entries DROP COLUMN IF EXISTS refunded;
  ALTER TABLE guild_suggestions DROP COLUMN IF EXISTS log_channel_id,
    DROP COLUMN IF EXISTS log_message_id;
  DELETE FROM schema_migrations;
  INSERT INTO schema_migrations (version) VALUES (${RELEASE_5_0_MIGRATIONS});
`;

async function pgShape(client) {
  const columns = await client`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`;
  const indexes = await client`
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    ORDER BY tablename, indexname`;
  return { columns: Array.from(columns), indexes: Array.from(indexes) };
}

test(
  'Postgres: a database from the 5.0 release boots with this code and gets the schema of a fresh install',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const postgres = (await import('postgres')).default;
    const admin = postgres(url);
    const name = (suffix) => `sylo_upgrade_${suffix}_${process.pid}_${Date.now()}`;
    const urlFor = (db) => {
      const u = new URL(url);
      u.pathname = `/${db}`;
      return u.toString();
    };
    const made = [];
    const create = async (suffix) => {
      const db = name(suffix);
      await admin.unsafe(`CREATE DATABASE "${db}"`);
      made.push(db);
      return db;
    };
    t.after(async () => {
      for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await admin.end({ timeout: 1 });
    });
    const sqliteFile = join(mkdtempSync(join(tmpdir(), 'sylo-upgrade-pg-')), 'x.db');
    const pgBoot = (db) => boot({ DATABASE_URL: urlFor(db), DATABASE_PATH: sqliteFile });

    const freshDb = await create('fresh');
    pgBoot(freshDb);
    const oldDb = await create('old');
    pgBoot(oldDb);

    // take the second one back to what 5.0 had, then boot it with this code
    const old = postgres(urlFor(oldDb));
    await old.unsafe(BACK_TO_5_0);
    const [{ max }] = await old`SELECT MAX(version) AS max FROM schema_migrations`;
    assert.equal(Number(max), RELEASE_5_0_MIGRATIONS);
    const gone =
      await old`SELECT to_regclass('public.economy_items') AS t, to_regclass('public.introductions') AS i`;
    assert.deepEqual([gone[0].t, gone[0].i], [null, null], 'the 5.0 shape has none of the new tables');
    const giveawayColumns =
      await old`SELECT column_name FROM information_schema.columns WHERE table_name = 'giveaways' ORDER BY column_name`;
    assert.deepEqual(
      Array.from(giveawayColumns, (r) => r.column_name),
      GIVEAWAYS_5_0,
      'the giveaways table is back to its 5.0 columns'
    );
    // two giveaways as 5.0 stored them: one already drawn, one running
    for (const ended of [1, 0]) {
      await old`INSERT INTO giveaways (guild_id, channel_id, prize, winners, host_id, ends_at, ended, won_ids, created_at)
        VALUES ('g', 'c', 'p', 1, 'h', 1, ${ended}, '[]', 1)`;
    }
    await old.end({ timeout: 1 });

    pgBoot(oldDb);

    const a = postgres(urlFor(freshDb));
    const b = postgres(urlFor(oldDb));
    try {
      const fresh = await pgShape(a);
      const upgraded = await pgShape(b);
      assert.deepEqual(upgraded.columns, fresh.columns);
      assert.deepEqual(upgraded.indexes, fresh.indexes);
      const rows = await b`SELECT ended, prizes_paid FROM giveaways ORDER BY id`;
      assert.deepEqual(
        Array.from(rows, (r) => [Number(r.ended), Number(r.prizes_paid)]),
        [
          [1, 1],
          [0, 0],
        ],
        'a drawn giveaway counts as paid, a running one does not'
      );
      // Applications: the tables are new, so the upgrade made them (checked by the shape compare above).
      const made = await b`SELECT to_regclass('public.applications_submissions') AS t`;
      assert.ok(made[0].t, 'the applications tables exist after the upgrade');
      const [{ top }] = await b`SELECT MAX(version) AS top FROM schema_migrations`;
      assert.ok(Number(top) > RELEASE_5_0_MIGRATIONS, 'the registered migrations were recorded');

      // migration 71 (the unknown added time) runs once on a database below it
      await b`INSERT INTO economy_inventory (guild_id, user_id, item_id, item_name, item_type, role_id, price_paid, source, status, created_at, updated_at)
        VALUES ('g', 'u', 1, 'x', 'temp_role', 'r', 0, 'purchase', 'active', 1, 1), ('g', 'u', 2, 'y', 'custom', NULL, 0, 'purchase', 'active', 1, 1)`;
      await b`DELETE FROM schema_migrations WHERE version = 71`;
      pgBoot(oldDb);
      const added = await b`SELECT item_type, added_ms FROM economy_inventory ORDER BY id`;
      assert.deepEqual(
        Array.from(added, (r) => [r.item_type, Number(r.added_ms)]),
        [
          ['temp_role', -1],
          ['custom', 0],
        ]
      );
    } finally {
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  }
);
