// Import this FIRST in any *.postgres.test.js file — those files import
// closePostgres from src/db/driver.js, which transitively imports
// src/db/index.js and triggers its eager migrate() against the DEFAULT
// ./data/sylo.db, purely as an unavoidable side effect of the import graph.
// Without isolating DATABASE_PATH, several such test-file subprocesses race
// to migrate the SAME shared file concurrently (seen as "table X already
// exists" once enough of these files existed for the race to actually land).
// Unlike tmpDb.js, this deliberately does NOT touch DATABASE_URL — these
// files need the real ambient value to decide whether to skip.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'sylo-test-')), 'test.db');
