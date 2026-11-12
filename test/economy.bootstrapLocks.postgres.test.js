// The Postgres bootstrap must not deadlock against another process that is already writing to the same
// tables. It used to send each file's DDL as one multi-statement query (one implicit transaction): its
// `ALTER TABLE guild_suggestions ... IF NOT EXISTS` kept an ACCESS EXCLUSIVE lock while the next
// `CREATE INDEX ... ON guild_suggestion_votes` waited for the other process's write, and that process
// then waited for the ALTER ("deadlock detected", seen once in CI in the /forget test). This test
// reproduces exactly that: a transaction writes to the votes table, a second process boots against the
// same database (and blocks on its CREATE INDEX), and the transaction then reads guild_suggestions.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
const BOOT = fileURLToPath(new URL('./helpers/bootDb.mjs', import.meta.url));

test(
  'a process that boots while another writes does not deadlock with it',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const postgres = (await import('postgres')).default;
    const admin = postgres(url);
    const name = `sylo_bootlock_${process.pid}_${Date.now()}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const dbUrl = new URL(url);
    dbUrl.pathname = `/${name}`;
    const sqliteFile = join(mkdtempSync(join(tmpdir(), 'sylo-bootlock-')), 'x.db');
    const bootChild = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [BOOT], {
          env: { ...process.env, DATABASE_URL: dbUrl.toString(), DATABASE_PATH: sqliteFile },
        });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stderr }));
      });
    t.after(async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 1 });
    });

    // the first boot makes the tables
    const first = await bootChild();
    assert.equal(first.code, 0, first.stderr.slice(0, 2000));

    // an older database: the column and the index this boot has to add are missing
    const setup = postgres(dbUrl.toString(), { max: 1 });
    await setup.unsafe(
      'ALTER TABLE guild_suggestions DROP COLUMN log_message_id; DROP INDEX idx_guild_suggestion_votes_user;'
    );
    await setup.end({ timeout: 1 });

    const worker = postgres(dbUrl.toString(), { max: 1 });
    try {
      let secondBoot;
      await worker.begin(async (tx) => {
        // an open write on the votes table (a row lock level that blocks CREATE INDEX)
        await tx`DELETE FROM guild_suggestion_votes WHERE user_id = 'nobody'`;
        secondBoot = bootChild();
        // wait until the second process is blocked on a lock
        const deadline = Date.now() + 20_000;
        for (;;) {
          const [{ n }] = await admin`
            SELECT COUNT(*)::int AS n FROM pg_stat_activity
            WHERE datname = ${name} AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
          if (n > 0) break;
          assert.ok(Date.now() < deadline, 'the second boot never reached a lock wait');
          await new Promise((r) => setTimeout(r, 50));
        }
        // the write transaction now reads guild_suggestions, as /forget does: it must not be blocked by a
        // lock the booting process holds while it waits for us
        await tx`
          DELETE FROM guild_suggestion_votes
          WHERE suggestion_id IN (SELECT id FROM guild_suggestions WHERE guild_id = 'g') AND user_id = 'u'`;
      });
      const second = await secondBoot;
      assert.equal(second.code, 0, `the booting process failed:\n${second.stderr.slice(0, 2000)}`);
      assert.doesNotMatch(second.stderr, /deadlock/);
      const check = postgres(dbUrl.toString(), { max: 1 });
      const [{ n }] = await check`
        SELECT (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'guild_suggestions' AND column_name = 'log_message_id')
             + (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_guild_suggestion_votes_user') AS n`;
      await check.end({ timeout: 1 });
      assert.equal(Number(n), 2, 'the boot added the column and the index');
    } finally {
      await worker.end({ timeout: 1 });
    }

    // a database that is complete: a boot changes nothing and so takes no table lock, even while another
    // process holds an open write on the same tables
    const writer = postgres(dbUrl.toString(), { max: 1 });
    try {
      await writer.begin(async (tx) => {
        await tx`DELETE FROM guild_suggestion_votes WHERE user_id = 'nobody'`;
        await tx`DELETE FROM giveaways WHERE guild_id = 'nobody'`;
        const quiet = await bootChild(); // would wait for this transaction if it took a lock
        assert.equal(quiet.code, 0, quiet.stderr.slice(0, 2000));
      });
    } finally {
      await writer.end({ timeout: 1 });
    }
  }
);
