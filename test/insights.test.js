import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import {
  accrueDaily,
  accrueHourly,
  dailySeries,
  hourlySeries,
  topChannels,
  topVoiceChannels,
  pruneInsights,
  utcDay,
  utcHour,
} from '../src/db/insights.js';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import { _internals, flushGuild } from '../src/modules/insights.js';

const G = '900000000000000001';

// --- db layer ------------------------------------------------------------

test('accrueDaily: adds counters, MAXes the *_members / peak, merges both maps', () => {
  const day = utcDay();
  accrueDaily(G, day, {
    joins: 2,
    leaves: 1,
    messages: 10,
    activeCount: 4,
    voiceMinutes: 30,
    voiceActiveCount: 3,
    voicePeak: 5,
    channels: { c1: 7, c2: 3 },
    voiceChannels: { v1: 20 },
  });
  accrueDaily(G, day, {
    joins: 1,
    messages: 5,
    activeCount: 3,
    voiceMinutes: 15,
    voiceActiveCount: 6,
    voicePeak: 2,
    channels: { c1: 2, c3: 5 },
    voiceChannels: { v1: 10, v2: 4 },
  });

  const row = db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?').get(G, day);
  assert.equal(row.messages, 15);
  assert.equal(row.joins, 3);
  assert.equal(row.active_members, 4); // MAX(4, 3)
  assert.equal(row.voice_minutes, 45); // 30 + 15
  assert.equal(row.voice_active_members, 6); // MAX(3, 6)
  assert.equal(row.voice_peak, 5); // MAX(5, 2)
  assert.deepEqual(JSON.parse(row.channels), { c1: 9, c2: 3, c3: 5 });
  assert.deepEqual(JSON.parse(row.voice_channels), { v1: 30, v2: 4 });
});

test('dailySeries: continuous oldest-first window, zero-filled, carries voice fields', () => {
  const s = dailySeries(G, 7);
  assert.equal(s.length, 7);
  assert.equal(s[6].label, utcDay());
  assert.ok(s[0].label < s[6].label);
  assert.equal(s[0].messages, 0);
  assert.equal(s[6].messages, 15);
  assert.equal(s[6].voiceMinutes, 45);
  assert.equal(s[6].voicePeak, 5);
});

test('accrueHourly + hourlySeries: per-hour buckets', () => {
  const h = utcHour();
  accrueHourly(G, h, { messages: 8, voiceMinutes: 12, voiceActiveCount: 2 });
  accrueHourly(G, h, { messages: 2 });
  const s = hourlySeries(G, 24);
  assert.equal(s.length, 24);
  assert.equal(s[23].label, h);
  assert.equal(s[23].messages, 10);
  assert.equal(s[23].voiceMinutes, 12);
  assert.equal(s[0].messages, 0);
});

test('topChannels / topVoiceChannels: merged, sorted desc, limited', () => {
  const earlier = utcDay(Date.now() - 2 * 86_400_000);
  accrueDaily(G, earlier, { channels: { c2: 100 }, voiceChannels: { v2: 500 } });
  assert.deepEqual(
    topChannels(G, 30, 2).map((t) => t.channelId),
    ['c2', 'c1'] // c2: 3+100, c1: 9
  );
  const tv = topVoiceChannels(G, 30, 2);
  assert.deepEqual(
    tv.map((t) => t.channelId),
    ['v2', 'v1'] // v2: 4+500, v1: 30
  );
  assert.equal(tv[0].minutes, 504);
});

test('pruneInsights: drops old daily AND hourly rows', () => {
  db.prepare('INSERT INTO guild_daily (guild_id, day, messages) VALUES (?, ?, ?)').run(G, '2020-01-01', 9);
  db.prepare('INSERT INTO guild_hourly (guild_id, hour, messages) VALUES (?, ?, ?)').run(
    G,
    '2020-01-01T05',
    9
  );
  pruneInsights(180, 72);
  assert.equal(db.prepare("SELECT 1 FROM guild_daily WHERE day = '2020-01-01'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM guild_hourly WHERE hour = '2020-01-01T05'").get(), undefined);
});

// --- module counter buffer --------------------------------------------------

test('module: messageCreate accrues, flush persists to daily + hourly, resets deltas', () => {
  _internals.buf.clear();
  const G2 = '900000000000000002';
  const s = _internals.slot(G2);
  s.messages = 4;
  s.joins = 1;
  s.channels.set('chanA', 4);
  s.dayActives.add('u1').add('u2');
  s.hourActives.add('u1');

  _internals.flushSlot(G2, s);

  const day = db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?').get(G2, utcDay());
  assert.equal(day.messages, 4);
  assert.equal(day.active_members, 2);
  assert.deepEqual(JSON.parse(day.channels), { chanA: 4 });
  const hour = db.prepare('SELECT * FROM guild_hourly WHERE guild_id = ? AND hour = ?').get(G2, utcHour());
  assert.equal(hour.messages, 4);
  assert.equal(hour.active_members, 1); // hourActives had just u1

  assert.equal(s.messages, 0);
  assert.equal(s.dayActives.size, 2); // day set kept
  assert.equal(s.hourActives.size, 0); // hour set reset
});

test('module: voiceStateUpdate tracks minutes, settled on flush and on leave', () => {
  _internals.buf.clear();
  const GV = '900000000000000004';
  setGuildModule(GV, 'insights', { enabled: true });
  const now = Date.now();
  const guild = { id: GV, voiceStates: { cache: new Map() } };
  const member = { id: 'v-user', user: { bot: false } };
  const vs = (channelId) => ({ guild, member, channelId });
  const voiceMinsOf = () =>
    db.prepare('SELECT voice_minutes FROM guild_daily WHERE guild_id = ? AND day = ?').get(GV, utcDay())
      .voice_minutes;

  // join #vc
  dispatch('voiceStateUpdate', GV, { old: vs(null), new: vs('vc1') });
  const s = _internals.buf.get(GV);
  assert.ok(s.voiceStart.has('v-user'));
  assert.ok(s.dayVoiceActives.has('v-user'));

  // pretend 10 minutes passed, then flush
  s.voiceStart.get('v-user').at = now - 10 * 60_000;
  _internals.flushSlot(GV, s);
  assert.ok(voiceMinsOf() >= 9 && voiceMinsOf() <= 11, `after 10m: ${voiceMinsOf()}`);
  const row = db.prepare('SELECT * FROM guild_daily WHERE guild_id = ? AND day = ?').get(GV, utcDay());
  assert.equal(row.voice_active_members, 1);
  assert.ok(s.voiceStart.has('v-user')); // still open after flush

  // 5 more minutes, then leave
  s.voiceStart.get('v-user').at = now - 5 * 60_000;
  dispatch('voiceStateUpdate', GV, { old: vs('vc1'), new: vs(null) });
  assert.equal(s.voiceStart.has('v-user'), false);
  _internals.flushSlot(GV, s);
  assert.ok(voiceMinsOf() >= 14 && voiceMinsOf() <= 16, `after +5m leave: ${voiceMinsOf()}`);
});

test('module: a temp voice channel is bucketed by its captured name, not its id', async () => {
  _internals.buf.clear();
  const { addTempChannel } = await import('../src/db/tempVoice.js');
  const GT = '900000000000000006';
  const SPAWN = '910000000000000002';
  setGuildModule(GT, 'insights', { enabled: true });
  addTempChannel({
    channelId: SPAWN,
    guildId: GT,
    hubId: '910000000000000001',
    ownerId: 'u1',
    name: "Ferd's room",
  });

  const now = Date.now();
  const guild = { id: GT, voiceStates: { cache: new Map() } };
  const member = { id: 't-user', user: { bot: false } };
  const vs = (channelId) => ({ guild, member, channelId });

  dispatch('voiceStateUpdate', GT, { old: vs(null), new: vs(SPAWN) });
  const s = _internals.buf.get(GT);
  s.voiceStart.get('t-user').at = now - 6 * 60_000;
  dispatch('voiceStateUpdate', GT, { old: vs(SPAWN), new: vs(null) });

  assert.ok(s.voiceChannels.has("name:Ferd's room"), 'bucketed by name, not the spawn id');
  assert.equal(s.voiceChannels.has(SPAWN), false);
});

test('flushGuild: writes one guild on demand, no-op for an unbuffered guild', () => {
  _internals.buf.clear();
  const GF = '900000000000000005';
  const s = _internals.slot(GF);
  s.messages = 9;
  s.dayActives.add('u1');

  flushGuild(GF);
  const row = db.prepare('SELECT messages FROM guild_daily WHERE guild_id = ? AND day = ?').get(GF, utcDay());
  assert.equal(row.messages, 9);
  assert.equal(s.messages, 0); // flushed

  assert.doesNotThrow(() => flushGuild('900000000000000099')); // never buffered
});

test('module: a day roll flushes the old slot and carries open voice sessions', () => {
  _internals.buf.clear();
  const G3 = '900000000000000003';
  const old = _internals.slot(G3);
  old.day = '2000-01-01';
  old.messages = 3;
  old.voiceStart.set('caller', { at: Date.now() - 60_000, channelId: 'vc9' });

  const s = _internals.slot(G3); // detects the day change
  assert.equal(s.day, utcDay());
  assert.equal(s.messages, 0);
  assert.ok(s.voiceStart.has('caller'), 'ongoing call carried into the new day');
  assert.equal(
    db.prepare("SELECT messages FROM guild_daily WHERE guild_id = ? AND day = '2000-01-01'").get(G3).messages,
    3
  );
});
