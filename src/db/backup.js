// Database backups: compacted single-file snapshots (SQLite `VACUUM INTO`) plus
// a periodic WAL checkpoint so the -wal sidecar never grows without bound.
//
// Snapshots are taken:
//   - just before any schema migration (see db/index.js)
//   - shortly after boot, unless a recent one already exists
//   - on a fixed interval (config.backupIntervalHours; 0 disables)
//   - on demand from the Health page
//
// Files land in config.backupDir (default <db dir>/backups) and are pruned to
// the newest config.backupRetention.
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { checkpoint, db, dbPath as DB_PATH, fileStamp, SCHEMA_VERSION, vacuumInto } from './index.js';
import { log } from '../lib/log.js';

const NAME_RE = /^sylo-[A-Za-z0-9._-]+\.db$/;
const SQLITE_MAGIC = 'SQLite format 3\0';

/** Absolute backups directory, created on first use. */
export function backupDir() {
  const dir = config.backupDir
    ? resolve(process.cwd(), config.backupDir)
    : join(dirname(DB_PATH), 'backups');
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

/** Live database file size + WAL size, for the Health page. */
export function dbFileInfo() {
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
export function runBackup(reason = 'manual') {
  const dir = backupDir();
  const slug = String(reason).replace(/[^a-z0-9]+/gi, '').slice(0, 20).toLowerCase() || 'manual';
  const stamp = fileStamp();
  let dest = join(dir, `sylo-${slug}-${stamp}.db`);
  for (let n = 2; existsSync(dest); n += 1) dest = join(dir, `sylo-${slug}-${stamp}-${n}.db`);
  checkpoint();
  vacuumInto(dest);
  const { size } = statSync(dest);
  pruneBackups();
  log.info('db', `Backup written: ${basename(dest)} (${Math.round(size / 1024)} KiB)`);
  return { name: basename(dest), size };
}

/** Delete a named backup. Returns true if a file was removed. */
export function deleteBackup(name) {
  const full = resolveBackup(name);
  if (!full) return false;
  unlinkSync(full);
  return true;
}

/**
 * Open a candidate .db file read-only and sanity-check it before we ever swap it
 * in. Returns `{ ok, error?, userVersion?, integrity? }`.
 */
export function inspectDbFile(filePath) {
  let probe;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma('integrity_check', { simple: true });
    const userVersion = probe.pragma('user_version', { simple: true });
    const tables = probe
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get().n;
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
 * Validate an uploaded database and, if good, store it as a normal snapshot the
 * operator can then restore. Returns `{ ok, name?, error? }`.
 */
export function importBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 512) return { ok: false, error: 'file is empty or truncated' };
  if (buf.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    return { ok: false, error: 'not a SQLite database file' };
  }
  const dir = backupDir();
  const stamp = fileStamp();
  let dest = join(dir, `sylo-imported-${stamp}.db`);
  for (let n = 2; existsSync(dest); n += 1) dest = join(dir, `sylo-imported-${stamp}-${n}.db`);

  writeFileSync(dest, buf);
  const check = inspectDbFile(dest);
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
export function restoreFromBackup(name) {
  if (restoreArmed) return { ok: false, error: 'a restore is already in progress' };
  const full = resolveBackup(name);
  if (!full) return { ok: false, error: 'no such backup' };
  const check = inspectDbFile(full);
  if (!check.ok) return { ok: false, error: check.error };

  restoreArmed = true;
  try {
    runBackup('prerestore');
  } catch (err) {
    log.error('db', 'Pre-restore snapshot failed — aborting restore:', err.message);
    restoreArmed = false;
    return { ok: false, error: `could not snapshot current database: ${err.message}` };
  }

  // Nothing else reads the DB after we close it here — we exit immediately — so
  // a plain overwrite is safe, and the prerestore snapshot covers a failure
  // partway through the copy.
  try {
    checkpoint();
    db.close();
    copyFileSync(full, DB_PATH);
    rmSync(`${DB_PATH}-wal`, { force: true });
    rmSync(`${DB_PATH}-shm`, { force: true });
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
  setInterval(() => checkpoint(), 6 * HOUR).unref();

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
      try {
        runBackup('startup');
      } catch (err) {
        log.error('db', 'Startup backup failed:', err.message);
      }
    }
  }, 30_000).unref();

  setInterval(() => {
    try {
      runBackup('scheduled');
    } catch (err) {
      log.error('db', 'Scheduled backup failed:', err.message);
    }
  }, hours * HOUR).unref();

  log.info('db', `Scheduled backups every ${hours}h, keeping the newest ${config.backupRetention}`);
}
