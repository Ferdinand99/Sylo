// Proves the Postgres backup/restore path against a real connection and real
// pg_dump/pg_restore binaries (must be on PATH — see the Dockerfile and
// .github/workflows/test.yml's "Install postgresql-client" step). Skipped
// entirely without DATABASE_URL, same as every other *.postgres.test.js.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rawUrl = process.env.DATABASE_URL;

test(
  'Postgres backup/restore against a real, isolated connection',
  { skip: !rawUrl && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    // pgRestore() is destructive — `--clean` drops and recreates every
    // object the dump knows about. Running that against `sylo_test`, the
    // database every other *.postgres.test.js file shares in a full-suite
    // run, would clobber whatever they've written since the snapshot,
    // depending purely on process scheduling. Create (or reuse) a separate
    // database on the same server instead, so this file's destructive test
    // can only ever affect its own data.
    const postgres = (await import('postgres')).default;
    const dbName = 'sylo_test_backup_restore';
    const admin = postgres(rawUrl);
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    } catch (err) {
      if (err.code !== '42P04') throw err; // 42P04 = database already exists — fine, reuse it
    }
    await admin.end({ timeout: 1 });

    const isolatedUrl = new URL(rawUrl);
    isolatedUrl.pathname = `/${dbName}`;
    process.env.DATABASE_URL = isolatedUrl.toString();

    const { closePostgres } = await import('../src/db/driver.js');
    const {
      backupDir,
      listBackups,
      runBackup,
      resolveBackup,
      deleteBackup,
      dbFileInfo,
      inspectDbFile,
      importBuffer,
    } = await import('../src/db/backup.js');
    const { pgRestore, PG_DUMP_MAGIC } = await import('../src/db/backupPostgres.js');
    const { setModlogChannel, getGuildSettings } = await import('../src/db/guildSettings.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-backup-${Date.now()}`;

    await t.test('runBackup writes a real pg_dump snapshot that listBackups reports', async () => {
      const { name, size } = await runBackup('manual');
      assert.match(name, /^sylo-manual-[\d-]+\.dump$/);
      assert.ok(size > 0);

      const full = resolveBackup(name);
      assert.ok(full && existsSync(full));
      assert.equal(readFileSync(full).subarray(0, PG_DUMP_MAGIC.length).toString('latin1'), PG_DUMP_MAGIC);
      assert.ok(listBackups().some((b) => b.name === name));

      deleteBackup(name);
    });

    await t.test('dbFileInfo reports a real live database size, no local file/WAL', async () => {
      const info = await dbFileInfo();
      assert.equal(info.path, null);
      assert.equal(info.wal, null);
      assert.ok(info.size > 0);
    });

    await t.test(
      'inspectDbFile validates a real dump via pg_restore --list, rejects a corrupt one',
      async () => {
        const { name } = await runBackup('manual');
        const full = resolveBackup(name);

        const good = await inspectDbFile(full);
        assert.equal(good.ok, true);

        // Right magic bytes, but not a real archive after that — pg_restore
        // --list should fail on it, unlike the plain "wrong file type" case.
        const corrupt = join(backupDir(), 'sylo-corrupt-2026-01-01-00-00-00-000.dump');
        writeFileSync(corrupt, Buffer.concat([Buffer.from(PG_DUMP_MAGIC, 'latin1'), Buffer.from('garbage')]));
        const badResult = await inspectDbFile(corrupt);
        assert.equal(badResult.ok, false);
        deleteBackup('sylo-corrupt-2026-01-01-00-00-00-000.dump');

        deleteBackup(name);
      }
    );

    await t.test('a SQLite snapshot is rejected with a clear "wrong mode" error', async () => {
      const sqliteLike = join(backupDir(), 'sylo-wrongmode-2026-01-01-00-00-00-000.db');
      writeFileSync(sqliteLike, 'SQLite format 3\0' + 'padding'.repeat(100));
      const result = await inspectDbFile(sqliteLike);
      assert.equal(result.ok, false);
      assert.match(result.error, /SQLite snapshot/);
      deleteBackup('sylo-wrongmode-2026-01-01-00-00-00-000.db');
    });

    await t.test('importBuffer stores a valid dump upload and rejects bad input', async () => {
      const { name } = await runBackup('manual');
      const bytes = readFileSync(resolveBackup(name));

      const ok = await importBuffer(bytes);
      assert.equal(ok.ok, true);
      assert.match(ok.name, /^sylo-imported-[\d-]+\.dump$/);
      assert.ok(existsSync(resolveBackup(ok.name)));

      assert.equal((await importBuffer(Buffer.from('nope'))).ok, false);
      assert.equal((await importBuffer(Buffer.alloc(2000))).ok, false); // right size, wrong magic

      deleteBackup(name);
      deleteBackup(ok.name);
    });

    await t.test('pgRestore actually replaces the live database with the dump', async () => {
      await setModlogChannel(G, '111');
      const { name } = await runBackup('pretest'); // snapshot with G's row present

      await setModlogChannel(G, '222'); // a change made *after* the snapshot
      const before = await getGuildSettings(G);
      assert.equal(before.modlog_channel_id, '222');

      await pgRestore(resolveBackup(name));

      // pgRestore() closed the shared connection; the next query reconnects
      // (driver.js's getSql() re-initializes lazily) against the
      // now-restored database.
      const after = await getGuildSettings(G);
      assert.equal(after.modlog_channel_id, '111', 'restored back to the snapshot, not the later change');

      deleteBackup(name);
    });
  }
);
