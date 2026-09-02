import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { accrueDaily, dailySeries, topChannels, pruneInsights, utcDay } from '../src/db/insights.js';
import { _internals } from '../src/modules/insights.js';

const G = '900000000000000001';

test('accrueDaily: adds counters, MAXes active, merges the channel map', () => {
  const day = utcDay();
  accrueDaily(G, day, { joins: 2, leaves: 1, messages: 10, activeCount: 4, channels: { c1: 7, c2: 3 } });
  accrueDaily(G, day, { joins: 1, leaves: 0, messages: 5, activeCount: 3, channels: { c1: 2, c3: 5 } });

  const row = db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?').get(G, day);
  assert.equal(row.joins, 3);
  assert.equal(row.leaves, 1);
  assert.equal(row.messages, 15);
  assert.equal(row.active_members, 4); // MAX(4, 3)
  assert.deepEqual(JSON.parse(row.channels), { c1: 9, c2: 3, c3: 5 });
});

test('dailySeries: continuous oldest-first window, zero-filled', () => {
  const s = dailySeries(G, 7);
  assert.equal(s.length, 7);
  assert.equal(s[6].day, utcDay()); // last entry is today
  assert.ok(s[0].day < s[6].day);
  assert.equal(s[0].messages, 0); // a day with no row
  assert.equal(s[6].messages, 15); // today, from the test above
});

test('topChannels: merges across days, sorted desc, limited', () => {
  const earlier = utcDay(Date.now() - 2 * 86_400_000);
  accrueDaily(G, earlier, { channels: { c2: 100, c4: 1 } });
  const top = topChannels(G, 30, 3);
  assert.deepEqual(
    top.map((t) => t.channelId),
    ['c2', 'c1', 'c3'] // c2: 3+100, c1: 9, c3: 5, c4: 1 (dropped by limit 3)
  );
  assert.equal(top[0].messages, 103);
});

test('pruneInsights: drops rows older than the retention window', () => {
  db.prepare('INSERT INTO guild_daily (guild_id, day, messages) VALUES (?, ?, ?)').run(G, '2020-01-01', 9);
  pruneInsights(180);
  assert.equal(db.prepare("SELECT 1 FROM guild_daily WHERE day = '2020-01-01'").get(), undefined);
  assert.ok(db.prepare('SELECT 1 FROM guild_daily WHERE guild_id = ? AND day = ?').get(G, utcDay()));
});

// --- module counter buffer -------------------------------------------------

test('module: messageCreate accrues into the in-memory slot, flush persists it', () => {
  _internals.buf.clear();
  const G2 = '900000000000000002';
  const s = _internals.slot(G2);
  s.messages = 4;
  s.joins = 1;
  s.channels.set('chanA', 4);
  s.actives.add('u1').add('u2');

  _internals.flushSlot(G2, s);

  const row = db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?').get(G2, utcDay());
  assert.equal(row.messages, 4);
  assert.equal(row.joins, 1);
  assert.equal(row.active_members, 2);
  assert.deepEqual(JSON.parse(row.channels), { chanA: 4 });
  // counters reset after a flush, active set retained for the day
  assert.equal(s.messages, 0);
  assert.equal(s.actives.size, 2);
});

test('module: a stale slot is flushed and replaced when the day rolls', () => {
  _internals.buf.clear();
  const G3 = '900000000000000003';
  _internals.buf.set(G3, {
    day: '2000-01-01',
    messages: 3,
    joins: 0,
    leaves: 0,
    channels: new Map(),
    actives: new Set(),
  });
  const s = _internals.slot(G3); // detects the day change
  assert.equal(s.day, utcDay());
  assert.equal(s.messages, 0);
  assert.equal(
    db.prepare("SELECT messages FROM guild_daily WHERE guild_id = ? AND day = '2000-01-01'").get(G3).messages,
    3
  );
});
