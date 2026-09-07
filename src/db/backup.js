// Database backups.
//
// SQLite (config.databaseUrl unset, every self-hosted deployment): compacted
// single-file snapshots via `VACUUM INTO`, plus a periodic WAL checkpoint so
// the -wal sidecar never grows without bound. Entirely unchanged from before
// Postgres support existed — every function below still branches SQLite's
// path back to exactly this.
//
// Postgres (config.databaseUrl set, hosted-only): snapshots via `pg_dump`'s
// custom format instead, restored with `pg_restore` — see backupPostgres.js.
// No WAL/checkpoint step (pg_dump reads a consistent snapshot without
// blocking writers), and no schema-version check on restore (see
// backupPostgres.js's pgInspectDump for why).
//
// Which branch runs is decided two different ways depending on the
// operation: creating a new backup uses the *live* driver (config.databaseUrl)
// since that's what's actually running; validating/restoring an *existing*
// file uses that file's own magic bytes (inspectDbFile), since a backups
// folder can end up holding snapshots from a driver this deployment isn't
// running anymore (e.g. right after switching one over) — restoring one of
// those should fail with a clear "wrong mode" error, not a cryptic one.
//
// Snapshots are taken:
//   - just before any SQLite schema migration (see db/index.js) — SQLite only
//   - shortly after boot, unless a recent one already exists
//   - on a fixed interval (config.backupIntervalHours; 0 disables)
//   - on demand from the Health page
//
// Files land in config.backupDir (default <db dir>/backups) and are pruned to
// the newest config.backupRetention, regardless of driver.
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { checkpoint, db, dbPath as DB_PATH, fileStamp, SCHEMA_VERSION, vacuumInto } from './index.js';
import { offsiteBackupConfigured, shipOffsiteBackup } from './offsiteBackup.js';
import { PG_DUMP_MAGIC, pgDbSize, pgDump, pgInspectDump, pgRestore } from './backupPostgres.js';
import { log } from '../lib/log.js';

const NAME_RE = /^sylo-[A-Za-z0-9._-]+\.(db|dump)$/;
const SQLITE_MAGIC = 'SQLite format 3\0';

/** Absolute backups directory, created on first use. */
export function backupDir() {
  const dir = config.backupDir ? resolve(process.cwd(), config.backupDir) : join(dirname(DB_PATH), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Newest-first list of backups: `{ name, size, mtime }` (mtime = epoch ms). */
export function listBackups() {
  const dir = backupDir();
  return readdirSync(dir)
    .filter((n) => NAME_RE.test(n))
    .map((n) => {
      const st = statSync(join(dir, n));
      return { name: n, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Resolve a user-supplied backup name to a safe absolute path, or null. */
export function resolveBackup(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const dir = backupDir();
  const full = resolve(dir, name);
  if (full !== join(dir, name) || !full.startsWith(dir + sep)) return null;
  return existsSync(full) ? full : null;
}

/** A readable stream for a named backup, or null if it is missing / unsafe. */
export function openBackup(name) {
  const full = resolveBackup(name);
  return full ? createReadStream(full) : null;
}

/**
 * Live database size, for the Health page. SQLite: the local file + its WAL
 * sidecar (`wal` is 0 with no sidecar present). Postgres: a real
 * `pg_database_size()` query — no local file to stat, so `path`/`wal` are
 * null.
 */
export async function dbFileInfo() {
  if (config.databaseUrl) {
    return { path: null, size: await pgDbSize(), wal: null };
  }
  const size = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
  const walPath = `${DB_PATH}-wal`;
  const wal = existsSync(walPath) ? statSync(walPath).size : 0;
  return { path: DB_PATH, size, wal };
}

/** Delete all but the newest `config.backupRetention` snapshots. Returns count removed. */
export function pruneBackups() {
  const dir = backupDir();
  const extra = listBackups().slice(config.backupRetention);
  for (const b of extra) {
    try {
      unlinkSync(join(dir, b.name));
    } catch {
      // Ignore — a concurrent prune or a manual delete got there first.
    }
  }
  return extra.length;
}

/**
 * Take a snapshot now. `reason` is a short slug baked into the filename
 * (e.g. "manual", "scheduled", "startup"). Returns `{ name, size }`.
 */
export async function runBackup(reason = 'manual') {
  const dir = backupDir();
  const slug =
    String(reason)
      .replace(/[^a-z0-9]+/gi, '')
      .slice(0, 20)
      .toLowerCase() || 'manual';
  const stamp = fileStamp();
  const ext = config.databaseUrl ? 'dump' : 'db';
  let dest = join(dir, `sylo-${slug}-${stamp}.${ext}`);
  for (let n = 2; existsSync(dest); n += 1) dest = join(dir, `sylo-${slug}-${stamp}-${n}.${ext}`);

  if (config.databaseUrl) {
    await pgDump(dest);
  } else {
    checkpoint();
    vacuumInto(dest);
  }
  const { size } = statSync(dest);
  pruneBackups();
  log.info('db', `Backup written: ${basename(dest)} (${Math.round(size / 1024)} KiB)`);
  if (offsiteBackupConfigured()) {
    // Fire-and-forget: the local snapshot is done regardless of the upload.
    shipOffsiteBackup(dest).catch((err) => log.error('db', `Off-site backup failed: ${err.message}`));
  }
  return { name: basename(dest), size };
}

/** Delete a named backup. Returns true if a file was removed. */
export function deleteBackup(name) {
  const full = resolveBackup(name);
  if (!full) return false;
  unlinkSync(full);
  return true;
}

/** First `length` bytes of a file, without reading the whole thing into memory. */
function peekBytes(filePath, length) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/**
 * Open a candidate .db file read-only and sanity-check it before we ever swap
 * it in. Returns `{ ok, error?, userVersion?, integrity? }`. SQLite only —
 * called from inspectDbFile() below once the file's magic bytes say it's one.
 */
function inspectSqliteFile(filePath) {
  let probe;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma('integrity_check', { simple: true });
    const userVersion = probe.pragma('user_version', { simple: true });
    const tables = probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    probe.close();

    if (integrity !== 'ok') return { ok: false, error: `integrity check failed: ${integrity}` };
    if (!tables) return { ok: false, error: 'file has no tables — not a Sylo database' };
    if (userVersion > SCHEMA_VERSION) {
      return {
        ok: false,
        error: `backup is from a newer Sylo (schema v${userVersion}; this build is v${SCHEMA_VERSION})`,
      };
    }
    return { ok: true, integrity, userVersion };
  } catch (err) {
    try {
      probe?.close();
    } catch {
      // already closed / never opened
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Validate a candidate backup file before it's ever applied — dispatches on
 * the file's own magic bytes, not the live driver, so restoring a snapshot
 * from the "wrong" mode fails with a clear error instead of a cryptic one
 * (see the file-level comment). Returns `{ ok, error?, ... }`.
 */
export async function inspectDbFile(filePath) {
  let head;
  try {
    head = peekBytes(filePath, 16);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (head.subarray(0, PG_DUMP_MAGIC.length).toString('latin1') === PG_DUMP_MAGIC) {
    if (!config.databaseUrl) {
      return { ok: false, error: 'this is a Postgres dump; the server is running in SQLite mode' };
    }
    return pgInspectDump(filePath);
  }
  if (head.toString('latin1') === SQLITE_MAGIC) {
    if (config.databaseUrl) {
      return { ok: false, error: 'this is a SQLite snapshot; the server is running in Postgres mode' };
    }
    return inspectSqliteFile(filePath);
  }
  return { ok: false, error: 'not a recognised Sylo backup file (SQLite snapshot or Postgres dump)' };
}

/**
 * Validate an uploaded database and, if good, store it as a normal snapshot the
 * operator can then restore. Returns `{ ok, name?, error? }`.
 */
export async function importBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 512) return { ok: false, error: 'file is empty or truncated' };

  let ext;
  if (buf.subarray(0, 16).toString('latin1') === SQLITE_MAGIC) ext = 'db';
  else if (buf.subarray(0, PG_DUMP_MAGIC.length).toString('latin1') === PG_DUMP_MAGIC) ext = 'dump';
  else return { ok: false, error: 'not a recognised Sylo backup file (SQLite snapshot or Postgres dump)' };

  const dir = backupDir();
  const stamp = fileStamp();
  let dest = join(dir, `sylo-imported-${stamp}.${ext}`);
  for (let n = 2; existsSync(dest); n += 1) dest = join(dir, `sylo-imported-${stamp}-${n}.${ext}`);

  writeFileSync(dest, buf);
  const check = await inspectDbFile(dest);
  if (!check.ok) {
    rmSync(dest, { force: true });
    return { ok: false, error: check.error };
  }
  pruneBackups();
  log.info('db', `Imported backup: ${basename(dest)} (${Math.round(buf.length / 1024)} KiB)`);
  return { ok: true, name: basename(dest) };
}

let restoreArmed = false;

/**
 * Replace the live database with `name` (a file in the backups dir) and exit so
 * the process manager restarts Sylo on the restored data. A "prerestore"
 * snapshot of the current database is taken first so this is reversible.
 *
 * The HTTP response MUST already be sent — this closes the DB and ends the
 * process. Returns `{ ok, error? }`; on success it does not return normally.
 */
export async function restoreFromBackup(name) {
  if (restoreArmed) return { ok: false, error: 'a restore is already in progress' };
  const full = resolveBackup(name);
  if (!full) return { ok: false, error: 'no such backup' };
  const check = await inspectDbFile(full);
  if (!check.ok) return { ok: false, error: check.error };

  restoreArmed = true;
  try {
    await runBackup('prerestore');
  } catch (err) {
    log.error('db', 'Pre-restore snapshot failed — aborting restore:', err.message);
    restoreArmed = false;
    return { ok: false, error: `could not snapshot current database: ${err.message}` };
  }

  // Nothing else reads the DB after this point in this process — either
  // branch below ends with process.exit() — so there's no risk of another
  // request racing the swap.
  try {
    if (config.databaseUrl) {
      await pgRestore(full);
    } else {
      checkpoint();
      db.close();
      copyFileSync(full, DB_PATH);
      rmSync(`${DB_PATH}-wal`, { force: true });
      rmSync(`${DB_PATH}-shm`, { force: true });
    }
    log.info('db', `Restored database from ${name} — exiting for restart`);
  } catch (err) {
    log.error('db', 'Restore failed mid-swap — check the prerestore snapshot:', err.message);
  }
  // The DB handle is unusable now regardless; hand off to the process manager.
  process.exit(0);
}

let started = false;
const HOUR = 60 * 60 * 1000;

/** Start the periodic backup + WAL-checkpoint timers. Idempotent; call once at boot. */
export function startBackupSchedule() {
  if (started) return;
  started = true;

  // Keep the -wal file bounded even between backups / on a quiet bot.
  // Postgres has no WAL sidecar to checkpoint — pg_dump reads a consistent
  // snapshot on its own, no housekeeping timer needed.
  if (!config.databaseUrl) {
    setInterval(() => checkpoint(), 6 * HOUR).unref();
  }

  const hours = config.backupIntervalHours;
  if (hours <= 0) {
    log.info('db', 'Scheduled backups disabled (BACKUP_INTERVAL_HOURS=0)');
    return;
  }

  // A snapshot soon after boot — but skip it if a recent one already exists, so
  // a crash-looping container does not spew near-identical backups.
  setTimeout(() => {
    const newest = listBackups()[0];
    if (!newest || Date.now() - newest.mtime > (hours / 2) * HOUR) {
      runBackup('startup').catch((err) => log.error('db', 'Startup backup failed:', err.message));
    }
  }, 30_000).unref();

  setInterval(() => {
    runBackup('scheduled').catch((err) => log.error('db', 'Scheduled backup failed:', err.message));
  }, hours * HOUR).unref();

  log.info('db', `Scheduled backups every ${hours}h, keeping the newest ${config.backupRetention}`);
}
