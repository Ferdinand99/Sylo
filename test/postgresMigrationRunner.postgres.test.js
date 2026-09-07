// Proves the Postgres-only incremental migration runner in src/db/driver.js
// against a real connection: a fresh database gets its baseline stamped at
// the current SCHEMA_VERSION (skipping registered migrations at or below
// it — the bootstrap DDL is assumed to already cover them), and a migration
// registered *above* that baseline actually runs and gets recorded.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'Postgres migration runner against a real connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { prepare, registerPostgresMigration } = await import('../src/db/driver.js');
    const { SCHEMA_VERSION } = await import('../src/db/index.js');

    t.after(async () => {
      await closePostgres();
    });

    // A migration numbered above today's SCHEMA_VERSION — real usage keeps a
    // registered migration's version in lockstep with SCHEMA_VERSION (see
    // registerPostgresMigration's own doc comment), so on a fresh database
    // it would normally be <= the just-stamped baseline and get skipped.
    // Numbering it one higher is what makes this test exercise the
    // "still-pending migration, apply it" branch against a fresh database
    // in one process, without needing a second real Postgres connection to
    // pre-seed an older baseline first.
    const pendingVersion = SCHEMA_VERSION + 1;
    const marker = `migration_marker_${Date.now()}`;
    registerPostgresMigration(pendingVersion, `CREATE TABLE ${marker} (hit INTEGER NOT NULL DEFAULT 1);`);

    // A migration at-or-below SCHEMA_VERSION should be treated as already
    // covered by the bootstrap DDL and never actually run.
    const skippedMarker = `migration_marker_skip_${Date.now()}`;
    registerPostgresMigration(
      SCHEMA_VERSION,
      `CREATE TABLE ${skippedMarker} (hit INTEGER NOT NULL DEFAULT 1);`
    );

    // Trigger the bootstrap — first real query in this process.
    const migrationsTable = prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    const top = await migrationsTable.get();

    await t.test('a fresh database is stamped at SCHEMA_VERSION, then catches up on the pending one', () => {
      assert.equal(Number(top.version), pendingVersion, 'pending migration applied and recorded');
    });

    await t.test('the pending migration actually ran (its DDL took effect)', async () => {
      const exists = prepare(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = '${marker}'`);
      assert.ok(await exists.get(), 'marker table from the pending migration exists');
    });

    await t.test('a migration at or below SCHEMA_VERSION was not (re-)applied', async () => {
      const exists = prepare(
        `SELECT 1 AS x FROM information_schema.tables WHERE table_name = '${skippedMarker}'`
      );
      assert.equal(
        await exists.get(),
        undefined,
        'skipped migration never ran — assumed covered by bootstrap'
      );
    });
  }
);
