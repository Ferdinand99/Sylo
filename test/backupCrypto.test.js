// Off-site backups are whole-database copies (webhook secrets, push tokens, ticket text), sent
// to a WebDAV server or a Discord channel. With BACKUP_ENCRYPTION_KEY set they leave encrypted
// (AES-256-GCM, key from the passphrase with scrypt); scripts/decrypt-backup.js reads them back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptBackup, encryptBackup, isEncryptedBackup } from '../src/lib/backupCrypto.js';
import { webdavTransportOk } from '../src/db/offsiteBackup.js';

test('a backup round-trips through encryption, and a wrong passphrase fails', () => {
  const data = Buffer.from('gzipped database bytes');
  const sealed = encryptBackup(data, 'correct horse');
  assert.equal(isEncryptedBackup(sealed), true);
  assert.equal(sealed.includes(data), false, 'the plain bytes are not in the file');
  assert.deepEqual(decryptBackup(sealed, 'correct horse'), data);
  assert.throws(() => decryptBackup(sealed, 'wrong'));
});

test('each encryption is different (fresh salt and IV)', () => {
  const data = Buffer.from('x');
  assert.notDeepEqual(encryptBackup(data, 'k'), encryptBackup(data, 'k'));
});

// Basic auth over plain http sends the password in clear text across the network.
test('WebDAV with a password needs https, except on this machine or the LAN', () => {
  assert.equal(webdavTransportOk('https://dav.example.com/x', true), true);
  assert.equal(webdavTransportOk('http://dav.example.com/x', true), false);
  assert.equal(webdavTransportOk('http://dav.example.com/x', false), true, 'no password, nothing to leak');
  assert.equal(webdavTransportOk('http://192.168.1.5/remote.php/dav', true), true);
  assert.equal(webdavTransportOk('http://nextcloud:8080/dav', true), true);
  assert.equal(webdavTransportOk('http://tower.local/dav', true), true);
  assert.equal(webdavTransportOk('http://nas.home.arpa/dav', true), true);
});
