import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { SCHEMA_VERSION } from '../src/db/index.js';
import {
  backupDir,
  listBackups,
  runBackup,
  pruneBackups,
  resolveBackup,
  deleteBackup,
  dbFileInfo,
  inspectDbFile,
  importBuffer,
} from '../src/db/backup.js';

test('runBackup writes a valid SQLite snapshot that listBackups reports', () => {
  const { name, size } = runBackup('manual');
  assert.match(name, /^sylo-manual-[\d-]+\.db$/);
  assert.ok(size > 0);

  const full = resolveBackup(name);
  assert.ok(full && existsSync(full));
  // SQLite files start with the "SQLite format 3\0" magic header.
  assert.equal(readFileSync(full).subarray(0, 16).toString('latin1'), 'SQLite format 3\0');

  assert.ok(listBackups().some((b) => b.name === name));
});

test('back-to-back backups do not collide', () => {
  const a = runBackup('manual');
  const b = runBackup('manual');
  assert.notEqual(a.name, b.name);
  assert.ok(existsSync(resolveBackup(a.name)));
  assert.ok(existsSync(resolveBackup(b.name)));
});

test('resolveBackup rejects unsafe or unknown names', () => {
  assert.equal(resolveBackup('../secrets.env'), null);
  assert.equal(resolveBackup('sylo-x.txt'), null);
  assert.equal(resolveBackup('notes.db'), null);
  assert.equal(resolveBackup('sylo-/etc/passwd.db'), null);
  assert.equal(resolveBackup('sylo-missing-9999.db'), null);
});

test('pruneBackups keeps only the newest config.backupRetention', () => {
  const dir = backupDir();
  // Cheap stand-ins (no VACUUM): distinct, sortable names with real mtimes.
  const total = config.backupRetention + 5;
  for (let i = 0; i < total; i += 1) {
    const n = String(i).padStart(3, '0');
    writeFileSync(join(dir, `sylo-seed-2026-01-01-00-00-00-${n}.db`), 'x');
  }
  const before = listBackups().length;
  assert.ok(before >= total);
  const removed = pruneBackups();
  assert.equal(removed, before - config.backupRetention);
  assert.equal(listBackups().length, config.backupRetention);
});

test('deleteBackup removes a named snapshot; bad names are a no-op', () => {
  const { name } = runBackup('manual');
  assert.equal(deleteBackup('../whatever'), false);
  assert.equal(deleteBackup(name), true);
  assert.equal(resolveBackup(name), null);
});

test('dbFileInfo reports the live database path and size', () => {
  const info = dbFileInfo();
  assert.equal(typeof info.path, 'string');
  assert.ok(info.size > 0);
  assert.ok(info.path.endsWith('test.db'));
  assert.ok(backupDir().endsWith('backups'));
});

test('inspectDbFile accepts a real snapshot and rejects junk / newer schema', () => {
  const { name } = runBackup('manual');
  const full = resolveBackup(name);

  const good = inspectDbFile(full);
  assert.equal(good.ok, true);
  assert.equal(good.integrity, 'ok');
  assert.ok(good.userVersion <= SCHEMA_VERSION);

  const junk = join(backupDir(), 'sylo-junk-2026-01-01-00-00-00-000.db');
  writeFileSync(junk, 'definitely not a database');
  assert.equal(inspectDbFile(junk).ok, false);

  // A snapshot from a hypothetical future schema must be refused.
  const future = new Database(full);
  future.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  future.close();
  const ahead = inspectDbFile(full);
  assert.equal(ahead.ok, false);
  assert.match(ahead.error, /newer/i);
});

test('importBuffer stores a valid upload as a snapshot and rejects bad input', () => {
  const { name } = runBackup('manual');
  const bytes = readFileSync(resolveBackup(name));

  const ok = importBuffer(bytes);
  assert.equal(ok.ok, true);
  assert.match(ok.name, /^sylo-imported-[\d-]+\.db$/);
  assert.ok(existsSync(resolveBackup(ok.name)));

  assert.equal(importBuffer(Buffer.from('nope')).ok, false);
  assert.equal(importBuffer(Buffer.alloc(2000)).ok, false); // right size, wrong magic
  assert.equal(importBuffer('not a buffer').ok, false);
});
