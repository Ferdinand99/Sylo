import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements } from '../src/db/splitSql.js';

test('splitStatements: one statement per query, comments and empty pieces dropped', () => {
  const sql = `
    -- a comment; with a semicolon and an apostrophe: doesn't matter
    CREATE TABLE IF NOT EXISTS a (id INTEGER, note TEXT DEFAULT 'x;y''z');
    /* block; comment */
    ALTER TABLE a ADD COLUMN IF NOT EXISTS b INTEGER;;
    CREATE INDEX IF NOT EXISTS idx_a ON a (id) WHERE id > 0;
    -- trailing comment only
  `;
  assert.deepEqual(splitStatements(sql), [
    "-- a comment; with a semicolon and an apostrophe: doesn't matter\n    CREATE TABLE IF NOT EXISTS a (id INTEGER, note TEXT DEFAULT 'x;y''z')",
    '/* block; comment */\n    ALTER TABLE a ADD COLUMN IF NOT EXISTS b INTEGER',
    'CREATE INDEX IF NOT EXISTS idx_a ON a (id) WHERE id > 0',
  ]);
});

test('splitStatements: dollar-quoted bodies and quoted names keep their semicolons', () => {
  const sql = `DO $$ BEGIN PERFORM 1; PERFORM 2; END $$; SELECT "a;b" FROM t; SELECT $tag$x;y$tag$`;
  assert.deepEqual(splitStatements(sql), [
    'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$',
    'SELECT "a;b" FROM t',
    'SELECT $tag$x;y$tag$',
  ]);
  assert.deepEqual(splitStatements('  -- nothing\n  '), []);
  assert.deepEqual(splitStatements('SELECT 1'), ['SELECT 1']);
});
