// Encryption for off-site backups (BACKUP_ENCRYPTION_KEY): AES-256-GCM with a key derived from
// the passphrase by scrypt, a fresh salt and IV per file. Layout:
//   "SYLOENC1" (8) | salt (16) | iv (12) | auth tag (16) | ciphertext
// scripts/decrypt-backup.js turns a file back into the gzipped database.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('SYLOENC1');
const SALT = 16;
const IV = 12;
const TAG = 16;

const keyFrom = (passphrase, salt) => scryptSync(String(passphrase), salt, 32);

export function isEncryptedBackup(buf) {
  return Buffer.isBuffer(buf) && buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** @returns {Buffer} */
export function encryptBackup(data, passphrase) {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

/** @returns {Buffer} the original bytes; throws on a wrong passphrase or a damaged file */
export function decryptBackup(buf, passphrase) {
  if (!isEncryptedBackup(buf)) throw new Error('Not an encrypted Sylo backup');
  let at = MAGIC.length;
  const salt = buf.subarray(at, (at += SALT));
  const iv = buf.subarray(at, (at += IV));
  const tag = buf.subarray(at, (at += TAG));
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(at)), decipher.final()]);
}
