// A Postgres database from before the suggestion log copy is brought up by the real start-up path:
// the bootstrap adds the two log columns to the table that already exists (keeping its rows), and
// the registered migration 64 is recorded. This runs in a database of its own and a child process
// of its own, because the schema is set up once per process, and the shared test database already
// has the new shape.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;

// What the table looked like before the log copy columns, and an old database's migration record.
const OLD_SCHEMA = `
  CREATE TABLE guild_suggestions (
    id          SERIAL PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    number      INTEGER NOT NULL,
    channel_id  TEXT NOT NULL,
    message_id  TEXT,
    author_id   TEXT,
    anonymous   INTEGER NOT NULL DEFAULT 0,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    reason      TEXT NOT NULL DEFAULT '',
    decided_by  TEXT,
    decided_at  BIGINT,
    created_at  BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX idx_guild_suggestions_number ON guild_suggestions (guild_id, number);
  CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO schema_migrations (version) VALUES (63);
  INSERT INTO guild_suggestions (guild_id, number, channel_id, message_id, body, status, created_at) VALUES
    ('g', 1, 'c', 'm1', 'Old one', 'approved', 1), ('g', 2, 'c', 'm2', 'Old two', 'open', 2);
`;

// Runs in the child: start up on the old database, then report what it looks like.
const CHILD = `
  const db = await import('./src/db/suggestions.js');
  const { closePostgres, prepare } = await import('./src/db/driver.js');
  const rows = await prepare('SELECT id, body, message_id, log_channel_id, log_message_id FROM guild_suggestions ORDER BY id').all();
  const versions = await prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  await db.setSuggestionLog(Number(rows[0].id), 'log', 'copy-1');
  const copy = await db.getSuggestion(Number(rows[0].id));
  const made = await db.createSuggestion({ guildId: 'h', channelId: 'c', authorId: 'a', body: 'New' });
  const fresh = await db.getSuggestion(made.id);
  await closePostgres();
  console.log('RESULT' + JSON.stringify({ rows, versions, copy: [copy.log_channel_id, copy.log_message_id], fresh: [fresh.number, fresh.log_message_id] }));
`;

test(
  'a Postgres database from before the suggestion log copy is upgraded at start-up',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { default: postgres } = await import('postgres');
    const name = `sylo_upgrade_sugg_${Date.now()}`;
    const admin = postgres(url);
    t.after(async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 1 });
    });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const target = new URL(url);
    target.pathname = `/${name}`;

    const old = postgres(target.href);
    await old.unsafe(OLD_SCHEMA);
    await old.end({ timeout: 1 });

    const dir = mkdtempSync(join(tmpdir(), 'sylo-upgrade-sugg-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATABASE_URL: target.href, DATABASE_PATH: join(dir, 'sylo.db') },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    assert.ok(line, child.stdout);
    const result = JSON.parse(line.slice('RESULT'.length));

    assert.equal(result.rows.length, 2, 'no suggestion lost');
    assert.deepEqual(
      result.rows.map((r) => [r.body, r.message_id, r.log_channel_id, r.log_message_id]),
      [
        ['Old one', 'm1', null, null],
        ['Old two', 'm2', null, null],
      ],
      'the new columns exist and are empty'
    );
    assert.ok(
      result.versions.some((v) => v.version === 64),
      'migration 64 was recorded'
    );
    assert.deepEqual(result.copy, ['log', 'copy-1'], 'the location can be stored');
    assert.deepEqual(result.fresh, [1, null], 'and a new suggestion works');
  }
);
