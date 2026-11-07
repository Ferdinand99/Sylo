// Public event pages, storage on SQLite: every event carries a random public token, the token finds
// the event, migration 62 gives the events that already existed a token, and the token goes away
// with the event (a purge, /forget leaves the event and its token alone).
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/db/index.js';
import {
  clearGuildEvents,
  createEvent,
  getEvent,
  getEventByToken,
  newEventToken,
  setEventParticipant,
} from '../src/db/events.js';
import { describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';

const G = '900000000000000731';
const NOW = 1_800_000_000_000;
const TOKEN = /^[0-9a-f]{32}$/;
const ev = (over = {}) => ({
  guildId: G,
  channelId: '100000000000000001',
  title: 'Game night',
  startAt: NOW + 3_600_000,
  hostId: '222',
  ...over,
});

test('a new event gets a random token of 128 bits, and no two events share one', async () => {
  const a = await createEvent(ev());
  const b = await createEvent(ev({ title: 'Quiz' }));
  const rowA = await getEvent(a.id);
  const rowB = await getEvent(b.id);
  assert.match(rowA.public_token, TOKEN);
  assert.match(rowB.public_token, TOKEN);
  assert.notEqual(rowA.public_token, rowB.public_token);
  const seen = new Set(Array.from({ length: 200 }, () => newEventToken()));
  assert.equal(seen.size, 200, 'tokens do not repeat');
  for (const t of seen) assert.match(t, TOKEN);
});

test('the token is not the event number, and the number cannot find the event', async () => {
  const { id } = await createEvent(ev());
  const row = await getEvent(id);
  assert.notEqual(row.public_token, String(id));
  assert.equal(await getEventByToken(String(id)), null);
  assert.equal((await getEventByToken(row.public_token)).id, id);
});

test('getEventByToken: an exact match only, and unknown or odd input finds nothing', async () => {
  const { id } = await createEvent(ev());
  const token = (await getEvent(id)).public_token;
  assert.equal((await getEventByToken(token)).title, 'Game night');
  assert.equal(await getEventByToken(token.toUpperCase()), null);
  assert.equal(await getEventByToken(`${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`), null);
  assert.equal(await getEventByToken(token.slice(0, 31)), null);
  assert.equal(await getEventByToken(`${token}0`), null);
  assert.equal(await getEventByToken(''), null);
  assert.equal(await getEventByToken(undefined), null);
  assert.equal(await getEventByToken("' OR 1=1 --"), null);
  assert.equal(await getEventByToken('%'), null, 'no wildcard matching');
});

test('migration 62 gives every existing event its own token and keeps the rows', () => {
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  const d = new Database(':memory:');
  const before = MIGRATIONS.slice(0, 61);
  for (const migration of before) migration(d);
  assert.ok(
    !d
      .prepare('PRAGMA table_info(guild_events)')
      .all()
      .some((c) => c.name === 'public_token'),
    'no token column before migration 62'
  );
  const ins = d.prepare(
    `INSERT INTO guild_events (guild_id, channel_id, title, start_at, host_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  ins.run('g1', 'c', 'First', 1000, 'h', 1);
  ins.run('g1', 'c', 'Second', 2000, 'h', 2);
  ins.run('g2', 'c', 'Third', 3000, null, 3);

  MIGRATIONS[61](d);

  const rows = d.prepare('SELECT id, title, public_token FROM guild_events ORDER BY id').all();
  assert.deepEqual(
    rows.map((r) => r.title),
    ['First', 'Second', 'Third']
  );
  for (const r of rows) assert.match(r.public_token, TOKEN);
  assert.equal(new Set(rows.map((r) => r.public_token)).size, 3, 'a token each');
  // the column is unique from now on
  assert.throws(
    () => d.prepare('UPDATE guild_events SET public_token = ? WHERE id = 2').run(rows[0].public_token),
    /UNIQUE/
  );
  // and a migrated database takes new events like any other
  d.prepare(
    `INSERT INTO guild_events (guild_id, channel_id, title, start_at, host_id, created_at, public_token) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('g1', 'c', 'Fourth', 4000, 'h', 4, newEventToken());
  d.close();
});

test('migration 62 on a database with no events just adds the column and the index', () => {
  const d = new Database(':memory:');
  for (const migration of MIGRATIONS) migration(d);
  const cols = d.prepare('PRAGMA table_info(guild_events)').all();
  assert.ok(cols.some((c) => c.name === 'public_token'));
  const idx = d.prepare('PRAGMA index_list(guild_events)').all();
  assert.ok(idx.some((i) => i.name === 'idx_guild_events_token' && i.unique === 1));
  d.close();
});

test('/forget takes the member off the event but leaves the event and its page address', async () => {
  const member = '900000000000000732';
  const { id } = await createEvent(ev({ hostId: member }));
  await setEventParticipant(id, member, 'join');
  const token = (await getEvent(id)).public_token;

  const result = await forgetUser(G, member);
  assert.ok(result.eventsHosted >= 1);
  const row = await getEventByToken(token);
  assert.equal(row.id, id, 'the event is still found by its token');
  assert.equal(row.host_id, null);

  // the token is not personal data of the member: it is not in their export or in the summary
  const exported = JSON.stringify(await exportUserData(G, member));
  assert.ok(!exported.includes(token));
  const described = JSON.stringify(await describeUserData(G, member));
  assert.ok(!described.includes(token));
});

test('the token goes with the event when the server is purged or the event list is cleared', async () => {
  const { id } = await createEvent(ev({ guildId: '900000000000000733' }));
  const token = (await getEvent(id)).public_token;
  assert.ok(await getEventByToken(token));
  await purgeGuild('900000000000000733');
  assert.equal(await getEventByToken(token), null);

  const other = await createEvent(ev({ guildId: '900000000000000734' }));
  const otherToken = (await getEvent(other.id)).public_token;
  await clearGuildEvents('900000000000000734');
  assert.equal(await getEventByToken(otherToken), null);
});
