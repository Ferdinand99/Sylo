// Turn an encrypted off-site backup (<name>.db.gz.enc, see BACKUP_ENCRYPTION_KEY) back into the
// database file. The passphrase comes from BACKUP_ENCRYPTION_KEY in the environment, so it is
// not left in the shell history.
//
//   BACKUP_ENCRYPTION_KEY=... node scripts/decrypt-backup.js sylo-2026-10-17.db.gz.enc [out.db]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decryptBackup } from '../src/lib/backupCrypto.js';

const [input, output = String(input ?? '').replace(/\.gz\.enc$/, '') || 'restored.db'] =
  process.argv.slice(2);
const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
if (!input || !passphrase) {
  console.error(
    'Usage: BACKUP_ENCRYPTION_KEY=<passphrase> node scripts/decrypt-backup.js <file.db.gz.enc> [out.db]'
  );
  process.exit(1);
}
try {
  writeFileSync(output, gunzipSync(decryptBackup(readFileSync(input), passphrase)), { mode: 0o600 });
  console.log(`Wrote ${output}`);
} catch (err) {
  console.error(`Could not decrypt ${input}: ${err.message} (wrong passphrase, or not a Sylo backup)`);
  process.exit(1);
}
