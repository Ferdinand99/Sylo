// Boots the whole database layer once, the way the bot does at start-up, then exits. A test runs it as
// a child process (test/upgradeBoot.test.js) against a database that was made by an OLDER version, to
// prove that Sylo still starts on it and ends up with the schema a fresh install has.
// DATABASE_PATH (SQLite) and DATABASE_URL (Postgres) come from the environment of the caller.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dbDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/db');
// Every db file registers its own Postgres bootstrap when it is imported.
for (const file of readdirSync(dbDir).filter((f) => f.endsWith('.js'))) {
  await import(`../../src/db/${file}`);
}
const { prepare, closePostgres } = await import('../../src/db/driver.js');
await prepare('SELECT 1 AS one').get();
await closePostgres();
