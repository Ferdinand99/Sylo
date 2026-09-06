// Import this FIRST in any test that touches the database. It points
// DATABASE_PATH at a throwaway file before src/config.js / src/db/index.js load,
// so tests never read or write the real data/sylo.db. Also clears DATABASE_URL
// so this test always runs the SQLite path, even when the ambient environment
// (e.g. the CI "postgres" matrix leg, or a local manual run) has it set — a
// driver.js-backed db file would otherwise silently route to Postgres and,
// worse, never call closePostgres(), leaving an open connection that keeps
// the test file's process alive indefinitely.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'sylo-test-')), 'test.db');
delete process.env.DATABASE_URL;
