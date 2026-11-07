// A Postgres database from before the public event pages is brought up by the real start-up path:
// the bootstrap adds the token column and its unique index to the table that already exists, and
// the registered migration 62 gives every old event a token. This runs in a database of its own
// and a child process of its own, because the schema is set up once per process, and the shared
// test database already has the new shape.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;

// What the table looked like in 5.0 before the token, and an old database's migration record.
const OLD_SCHEMA = `
  CREATE TABLE guild_events (
    id               SERIAL PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    message_id       TEXT,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    location         TEXT NOT NULL DEFAULT '',
    image_url        TEXT NOT NULL DEFAULT '',
    start_at         BIGINT NOT NULL,
    end_at           BIGINT,
    time_zone        TEXT NOT NULL DEFAULT 'UTC',
    capacity         INTEGER,
    role_id          TEXT,
    reminder_minutes INTEGER NOT NULL DEFAULT 0,
    reminder_sent    INTEGER NOT NULL DEFAULT 0,
    host_id          TEXT,
    state            TEXT NOT NULL DEFAULT 'scheduled',
    created_at       BIGINT NOT NULL
  );
  CREATE INDEX idx_guild_events_guild ON guild_events (guild_id, state, start_at);
  CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO schema_migrations (version) VALUES (61);
  INSERT INTO guild_events (guild_id, channel_id, title, start_at, created_at) VALUES
    ('g', 'c', 'Old one', 1000, 1), ('g', 'c', 'Old two', 2000, 2), ('h', 'c', 'Old three', 3000, 3);
`;

// Runs in the child: start up on the old database, then report what it looks like.
const CHILD = `
  const events = await import('./src/db/events.js');
  const { closePostgres, prepare } = await import('./src/db/driver.js');
  const rows = await prepare('SELECT id, title, public_token FROM guild_events ORDER BY id').all();
  const versions = await prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  const index = await prepare(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_guild_events_token'"
  ).get();
  const second = rows.length > 1 ? await events.getEventByToken(rows[1].public_token) : null;
  const made = await events.createEvent({ guildId: 'g', channelId: 'c', title: 'New', startAt: 5000, hostId: 'h' });
  const fresh = await events.getEvent(made.id);
  await closePostgres();
  console.log('RESULT' + JSON.stringify({ rows, versions, index: index?.indexdef ?? null, second: second?.title ?? null, fresh: fresh.public_token }));
`;

test(
  'a Postgres database from before the event page tokens is upgraded at start-up',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { default: postgres } = await import('postgres');
    const name = `sylo_upgrade_${Date.now()}`;
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

    const dir = mkdtempSync(join(tmpdir(), 'sylo-upgrade-'));
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

    assert.equal(result.rows.length, 3, 'no event lost');
    const tokens = result.rows.map((r) => r.public_token);
    for (const token of tokens) assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(new Set(tokens).size, 3, 'a token each');
    assert.equal(result.second, 'Old two', 'a token finds its event');
    assert.deepEqual(
      result.versions.map((v) => v.version),
      [61, 62],
      'migration 62 ran once and was recorded'
    );
    assert.match(result.index, /CREATE UNIQUE INDEX idx_guild_events_token .*\(public_token\)/);
    assert.match(result.fresh, /^[0-9a-f]{32}$/, 'and a new event gets its own');
  }
);
