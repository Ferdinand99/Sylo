// Postgres side of db/backup.js — dumps/restores via the `pg_dump`/`pg_restore`
// CLI tools (bundled into the runtime image; see the Dockerfile) rather than
// SQLite's file-copy approach, which has no Postgres equivalent. Only called
// when config.databaseUrl is set; backup.js dispatches to these based on the
// live database's own connection, not on a candidate file's extension — see
// its inspectDbFile() for why (a file's actual magic bytes decide its type).
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { closePostgres, prepare } from './driver.js';

const execFile = promisify(execFileCb);

// pg_dump's custom format (-Fc) starts every file with this 5-byte signature.
export const PG_DUMP_MAGIC = 'PGDMP';

/**
 * Live database size in bytes — a real query, there's no local file to stat.
 * `prepare()`'s SQLite branch validates SQL text against the local database
 * immediately, at `prepare()`-call time, not lazily on first use — and
 * `pg_database_size()` isn't valid SQLite syntax. This file is imported
 * unconditionally by backup.js (every deployment, SQLite included), so the
 * statement is built fresh inside this function instead of once at module
 * load — `pgDbSize()` itself is only ever called once `dbFileInfo()` has
 * already confirmed `config.databaseUrl` is set, so `prepare()` always takes
 * the real Postgres branch here and never touches SQLite at all.
 */
export async function pgDbSize() {
  const row = await prepare('SELECT pg_database_size(current_database()) AS size').get();
  return Number(row?.size) || 0;
}

/**
 * Dump the live database to `destPath` in pg_dump's custom format — compressed,
 * and (unlike a plain-text `-Fp` dump) restorable straight at a live database
 * via `pg_restore -d`, no intermediate `createdb`/`psql` step. `pg_dump` reads
 * a consistent MVCC snapshot without blocking concurrent writers, so unlike
 * SQLite's path there's no checkpoint/lock step needed first.
 * `--no-owner --no-privileges`: omit role/grant statements, which only matter
 * if a restore target's roles exactly match the source's — not guaranteed
 * (e.g. a disaster-recovery restore onto a freshly provisioned instance).
 */
export async function pgDump(destPath) {
  await execFile('pg_dump', [config.databaseUrl, '-Fc', '--no-owner', '--no-privileges', '-f', destPath]);
}

/**
 * Validate a candidate dump file without applying it — `pg_restore --list`
 * parses the archive's table of contents and fails on a corrupt/truncated
 * file, without touching the live database. `{ ok, error? }`.
 *
 * Unlike SQLite's inspectDbFile, this can't also check the dump's schema
 * version against SCHEMA_VERSION — pg_dump's table of contents doesn't carry
 * that information, and there's no cheap way to extract it without restoring
 * the dump somewhere first. A version mismatch here would surface as a
 * pg_restore error against the live schema instead of being caught upfront —
 * an accepted gap for now, worth revisiting if it turns out to matter.
 */
export async function pgInspectDump(filePath) {
  try {
    await execFile('pg_restore', ['--list', filePath]);
    return { ok: true };
  } catch (err) {
    const detail = (err.stderr || err.message || 'invalid dump file').toString().trim().split('\n')[0];
    return { ok: false, error: detail };
  }
}

// pg_restore (17+) opens its restore session with `SET transaction_timeout =
// 0;` — a parameter that doesn't exist on an older server. The target logs
// that as a non-fatal error ("errors ignored on restore: 1") and pg_restore
// still exits 1, even though the rest of the restore completed normally.
// The runtime image intentionally bundles the *newest* client (see the
// Dockerfile) so it covers any older-or-equal server — confirmed for real:
// dumped a v16 database with the v18 client, restored it back into a fresh
// v16 database, data intact, this exact warning the only thing on stderr.
// Tolerate *only* this specific pattern; anything else on stderr is real.
const BENIGN_RESTORE_STDERR = /transaction_timeout|errors ignored on restore/i;

function isBenignRestoreFailure(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => BENIGN_RESTORE_STDERR.test(l));
}

/**
 * Replace the live database's contents with `filePath`'s. Closes the shared
 * Postgres connection first (so pg_restore isn't fighting the app's own pool
 * for locks) — the caller is responsible for exiting the process afterward,
 * same shape as SQLite's restoreFromBackup, since nothing here reopens a
 * connection for the rest of this process to keep using.
 * `--clean --if-exists`: drop existing objects (guarded, so a fresh target
 * database restores cleanly too) before recreating them from the dump —
 * mirrors "restore replaces the live database" for SQLite's plain file swap.
 * Note: only drops objects the dump itself knows about; a table removed from
 * the schema since the dump was taken would survive a restore. Acceptable
 * for restoring one of Sylo's own recent backups; worth knowing if reusing
 * this for anything else.
 */
export async function pgRestore(filePath) {
  await closePostgres();
  try {
    await execFile('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-d',
      config.databaseUrl,
      filePath,
    ]);
  } catch (err) {
    if (!isBenignRestoreFailure(err.stderr)) throw err;
  }
}
