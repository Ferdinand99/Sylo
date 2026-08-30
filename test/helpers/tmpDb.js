// Import this FIRST in any test that touches the database. It points
// DATABASE_PATH at a throwaway file before src/config.js / src/db/index.js load,
// so tests never read or write the real data/sylo.db.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'sylo-test-')), 'test.db');
