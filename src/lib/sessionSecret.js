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
import { join } from 'node:path';

export const SESSION_SECRET_FILE = 'session-secret';
// 32 random bytes as hex (64 chars). A file shorter than 32 chars is treated as damaged and replaced.
const MIN_SECRET_LENGTH = 32;

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
