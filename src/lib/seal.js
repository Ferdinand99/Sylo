// Seal a stored credential with AES-256-GCM, keyed from the instance's session secret (HKDF-SHA256, the
// `purpose` as the key's context, so one purpose's key never opens another's value). A sealed value reads
// `v1.<iv>.<tag>.<data>`. A value that cannot be opened (the secret changed, the text was damaged) reads as
// null, and the caller makes a new credential instead of failing.
//
// Used by the Postal Pigeon credential (lib/pigeon.js) and the bridge's webhook tokens (db/bridge.js).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const keyFor = (secret, purpose) => Buffer.from(hkdfSync('sha256', String(secret), 'sylo', purpose, 32));

/** Is this text a value this module sealed? */
export const isSealed = (value) => typeof value === 'string' && value.startsWith('v1.');

/**
 * @param {string} secret   the session secret
 * @param {string} purpose  what the value is for ('pigeon-credential', 'bridge-webhook')
 * @param {string} plain
 */
export function seal(secret, purpose, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
}

/** The text a sealed value holds, or null when it cannot be opened (another secret or purpose, damage). */
export function open(secret, purpose, sealed) {
  try {
    const [version, iv, tag, data] = String(sealed).split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return null;
  }
}
