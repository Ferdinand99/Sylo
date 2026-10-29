// Resolves the secret that signs dashboard session cookies and the verify and
// appeal links (src/lib/signedToken.js). Those links live for up to 60 days, so
// the secret has to survive a restart. Order: the SESSION_SECRET env var, then
// <dataDir>/session-secret, then a fresh secret written to that file. If the
// file cannot be written the secret only lives for this process.
//
// This runs while src/config.js loads, so it is synchronous and does not use
// the logger. The secret itself is never printed.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const SESSION_SECRET_FILE = 'session-secret';
// 32 random bytes as hex (64 chars). A file shorter than 32 chars is treated as damaged and replaced.
const MIN_SECRET_LENGTH = 32;

/**
 * Is `dir` on a mounted volume (inside a mount point other than the root file system), according
 * to the text of /proc/self/mountinfo? In a container the root is the image's layer: a data folder
 * that is not on a mount of its own is lost when the container is replaced. Returns null when it
 * cannot be told (no mountinfo, not Linux), so the caller stays quiet then.
 * @param {string} dir
 * @param {string | null | undefined} mountinfo  contents of /proc/self/mountinfo
 * @returns {boolean | null}
 */
export function isOnMountedVolume(dir, mountinfo) {
  if (!dir || !mountinfo) return null;
  const target = posix.resolve(dir); // mountinfo is Linux's, so its paths are POSIX
  const points = [];
  for (const line of String(mountinfo).split('\n')) {
    // "36 35 98:0 /root /mnt rw,noatime master:1 - ext3 /dev/root rw": the 5th field is the mount point
    const field = line.split(' ')[4];
    if (field) points.push(field.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
  }
  if (!points.length) return null;
  const inside = points.filter(
    (p) => p !== '/' && (target === p || target.startsWith(p.endsWith('/') ? p : `${p}/`))
  );
  return inside.length > 0;
}

/**
 * The warning to log at start-up when the session secret sits in the data folder of a Postgres
 * install whose data folder is not a mounted volume: the file would go with the container, and
 * every login and signed link with it. Null when nothing is wrong or it cannot be told.
 * @param {{ source: string, databaseUrl?: string | null, dataDir: string, mountinfo?: string | null }} o
 * @returns {string | null}
 */
export function dataFolderWarning({ source, databaseUrl, dataDir, mountinfo }) {
  if (source !== 'file' || !databaseUrl) return null;
  if (isOnMountedVolume(dataDir, mountinfo) !== false) return null;
  return `The data folder (${dataDir}) is not a mounted volume, so the session secret in it is lost when the container is replaced: everyone is logged out and signed verify/appeal links stop working. Mount a volume on it, or set SESSION_SECRET.`;
}

/**
 * @param {{ envValue?: string | null, dataDir?: string | null, warn?: (message: string) => void }} options
 *   dataDir null/undefined means "do not persist" (the secret then lives for this process only).
 * @returns {{ secret: string, source: 'env' | 'file' | 'generated-ephemeral' }}
 */
export function resolveSessionSecret({ envValue, dataDir, warn = () => {} } = {}) {
  const fromEnv = typeof envValue === 'string' ? envValue.trim() : '';
  if (fromEnv) return { secret: fromEnv, source: 'env' };

  const generated = randomBytes(32).toString('hex');
  if (!dataDir) return { secret: generated, source: 'generated-ephemeral' };

  const file = join(dataDir, SESSION_SECRET_FILE);
  try {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= MIN_SECRET_LENGTH) {
      return { secret: stored, source: 'file' };
    }
    warn(`${file} is empty or too short to be a session secret; generating a new one.`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      warn(`Could not read ${file} (${err?.code ?? 'error'}); trying to write a new session secret.`);
    }
  }

  // Write to a temp file, then rename, so a crash never leaves a half-written secret.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, `${generated}\n`, { mode: 0o600 });
    // mode is masked by the umask on creation; set it again to be sure.
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return { secret: generated, source: 'file' };
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    warn(`Could not write ${file} (${err?.code ?? 'error'}); the session secret will not survive a restart.`);
    return { secret: generated, source: 'generated-ephemeral' };
  }
}
