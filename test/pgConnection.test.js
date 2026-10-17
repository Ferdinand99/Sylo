// pg_dump and pg_restore used to get DATABASE_URL, password included, as an argument. When one
// fails, Node puts the whole command line in the error, and that message reached the log, the
// health page, the dev-log channel and a redirect URL. The password now goes in PGPASSWORD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgConnection } from '../src/db/backupPostgres.js';

test('pgConnection takes the password out of the URL', () => {
  const { url, env } = pgConnection('postgres://sylo:s3cr%40t@db.example:5432/sylo?sslmode=require');
  assert.equal(url, 'postgres://sylo@db.example:5432/sylo?sslmode=require');
  assert.equal(env.PGPASSWORD, 's3cr@t');
  assert.doesNotMatch(url, /s3cr/);
});

test('pgConnection leaves a URL without a password alone', () => {
  const { url, env } = pgConnection('postgres://sylo@db.example/sylo');
  assert.equal(url, 'postgres://sylo@db.example/sylo');
  assert.equal(env.PGPASSWORD, undefined);
});
